/**
 * Subtask Executor (Etap 8.2 + 8.3a + Phase 3.2)
 *
 * Executes individual coding subtasks via scoped prompts with model-specific
 * routing. Includes quality validation and intelligent retry/escalation:
 *
 *   Attempt 1 → quality check → fail → RETRY (same model, enriched prompt)
 *   Attempt 2 → quality check → fail → ESCALATE (stronger model)
 *   Attempt 3 → quality check → fail → mark 'needs_human'
 *
 * Phase 3.2: Role-based routing — each subtask is resolved to a SubAgentRole
 * (file-editor, terminal, qa) which constrains the prompt, tool whitelist,
 * and model tier. Skills from the SkillRegistry are loaded and injected
 * into the scoped prompt when a matching skill is found.
 */

import { randomUUID } from 'crypto';

import type { Mastra } from '@mastra/core/mastra';
import {
  type ModelCapability,
  type TaskComplexity,
  modelRegistry,
  complexityMeetsRequirement,
} from '../config/model-capabilities.js';
import type { RoutableSubtask, RoutingResult } from './smart-router.js';
import { subtaskWritesCode, roleExcludedFromLocal } from './smart-router.js';
import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';
import { resolveSubAgentRole, type SubAgentRole } from '../config/subagent-roles.js';
import { getSkillRegistry } from './skill-registry.js';
import { getGpuGuard } from './gpu-guard.js';
import type { Skill } from './skill-registry.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { getBudgetTracker } from './budget-tracker.js';
import { appendToCheckpoint } from './context-checkpoint.js';
import { assembleContext, formatAssembledContext } from './context-assembler.js';
import { generateCoding } from './coding-harness.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { AGENTIC_AGENTS_REPO, getWorkspacePath } from '../workspaces/code-workspace.js';
import type { SubtaskArtifactLeaseIdentity } from './harness-execution-context.js';
import {
  claimSubtaskArtifactLease,
  startSubtaskArtifactHeartbeat,
  yieldSubtaskArtifactLease,
} from './subtask-artifact-fence.js';
import {
  type PendingMessage,
  formatPendingMessagesForPrompt,
  takePendingMessages,
  ackPendingMessages,
} from './pending-message-queue.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubtaskResult {
  subtaskId: string;
  status: 'success' | 'partial' | 'failed' | 'skipped' | 'needs_human';
  assignedModel: string;
  actualModel?: string;
  filesChanged: Array<{ path: string; summary: string }>;
  commandsRun: Array<{ command: string; exitCode: number; summary: string }>;
  diagnostics: string;
  errors: string[];
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number };
  qualityCheck?: {
    passed: boolean;
    reason: string;
    attempt: number;
    escalationHistory: Array<{ model: string; reason: string }>;
  };
}

export interface SubtaskContext {
  taskId: string;
  previousResults: SubtaskResult[];
  retryContext?: SubtaskResult;
  pendingMessages?: PendingMessage[];
}

// ── Quality Signals ──────────────────────────────────────────────────────────

export type QualitySignal =
  | 'no_files_changed'
  | 'tsc_errors'
  | 'target_files_missed'
  | 'agent_reported_failure'
  | 'empty_diagnostics';
// `partial_completion` used to be declared here and was never emitted by
// anything, in legacy or since. A union member with no producer reads like a
// check that exists — the migration inventory listed six quality signals on the
// strength of it, and there have only ever been five.

export interface QualityValidation {
  passed: boolean;
  reason: string;
  signals: QualitySignal[];
}

// ── Escalation Path ──────────────────────────────────────────────────────────

const ESCALATION_PATH: Record<string, string[]> = {
  'local-micro':  ['local-light', 'local-heavy', 'cloud-free', 'cloud-fast', 'cloud-pro'],
  'local-light':  ['local-heavy', 'cloud-free', 'cloud-fast', 'cloud-pro'],
  'local-heavy':  ['cloud-free', 'cloud-fast', 'cloud-pro'],
  'cloud-free':   ['cloud-fast', 'cloud-pro'],
  'cloud-fast':   ['cloud-pro'],
  'cloud-pro':    [],
};

const MAX_RETRY_ATTEMPTS = 3;

// ── Timeouts by Complexity ───────────────────────────────────────────────────

const COMPLEXITY_TIMEOUTS: Record<string, number> = {
  trivial: 30_000,
  simple: 60_000,
  moderate: 120_000,
  complex: 300_000,
};

/**
 * Execute a single subtask with scoped prompt and model routing.
 * Includes offline fallback: cloud error → local, local error → cloud.
 *
 * Phase 3.2: Now resolves SubAgentRole and loads matching Skill to build
 * a role-constrained prompt before execution.
 */
export async function executeSubtask(
  subtask: RoutableSubtask,
  taskId: string,
  context: SubtaskContext,
  mastra: Mastra,
  _fallbackAttempt = 0,
  _artifactLease?: SubtaskArtifactLeaseIdentity,
): Promise<SubtaskResult> {
  const startTime = Date.now();
  const modelId = subtask.assignedModel!;

  // ── Phase 3.2: Resolve sub-agent role and load matching skill ──
  const role = resolveSubAgentRole(subtask.type);
  const loadedSkill = await findBestSkill(subtask, role);

  if (loadedSkill) {
    console.log(
      `[SubtaskExecutor] ${subtask.id}: role=${role.roleId}, skill=${loadedSkill.metadata.name}`,
    );
  } else {
    console.log(`[SubtaskExecutor] ${subtask.id}: role=${role.roleId}, no skill matched`);
  }

  const repoPath = await resolveRepoPath(taskId);
  const pendingMessages = context.pendingMessages ?? await takePendingMessages({
    taskId,
    agentId: 'codingAgent',
    subtaskId: subtask.id,
    limit: 5,
  });
  const interruptPrompt = formatPendingMessagesForPrompt(pendingMessages);
  // SEC-001 — acknowledge once the content reached the prompt; a crash before
  // this point leaves the interrupt reclaimable instead of silently consumed.
  void ackPendingMessages({ messages: pendingMessages, agentId: 'codingAgent', subtaskId: subtask.id });

  // Build scope-constrained prompt with role + skill context + assembled context
  const basePrompt = context.retryContext
    ? buildRetryPrompt(subtask, context.retryContext, taskId, context, role, loadedSkill)
    : await buildScopedPrompt(subtask, taskId, context, role, loadedSkill, repoPath);
  const prompt = interruptPrompt ? `${interruptPrompt}\n\n${basePrompt}` : basePrompt;

  const agent = mastra.getAgent('codingAgent');
  const timeoutMs = COMPLEXITY_TIMEOUTS[subtask.estimatedComplexity ?? 'simple'] ?? 60_000;

  let artifactLease = _artifactLease;
  const ownsArtifactLeaseLifecycle = !artifactLease;
  let stopArtifactHeartbeat: (() => Promise<void>) | undefined;

  try {
    if (!artifactLease) {
      const db = await getDb();
      artifactLease = await claimSubtaskArtifactLease(db, {
        taskId,
        subtaskId: subtask.id,
      }) ?? undefined;
      if (!artifactLease) {
        throw new Error(
          `Artifact lease busy for ${taskId}/${subtask.id}; another attempt still owns this subtask.`,
        );
      }
      stopArtifactHeartbeat = startSubtaskArtifactHeartbeat(db, artifactLease);
    }

    const harnessResult = await generateCoding({
      agent,
      agentId: 'codingAgent',
      prompt,
      taskId,
      subtaskId: subtask.id,
      threadId: `${taskId}::${subtask.id}`,
      artifactLease,
      model: modelId,
      phase: context.retryContext ? 'retry' : 'subtask',
      timeoutMs,
      repoPath,
      targetFiles: subtask.targetFiles,
      cachePolicy: 'static-only',
      contextPolicy: {
        includeMemory: true,
        includeSkills: true,
        includeRepoMap: true,
        includeCheckpoint: true,
        maxTokens: 2048,
      },
      // J7 (2026-08-23) — allowedTools stops being prompt-only text. This was
      // printed as a bulleted "### Allowed Tools" section and nothing else;
      // a terminal subagent could still call coding_write_file_tracked, the
      // exact boundary its own role description promises it won't cross.
      //
      // `generateOptions` is spread BEFORE the harness's own computed keys
      // (model/memory/prepareStep/stopWhen/...), so this is the starting
      // `activeTools` ceiling for the whole call. codingAgent's transient
      // tool shelf can still search_tools/load_tool ANY of codingAgent's real
      // tools (its descriptors come from the full static tool map, not from
      // this restriction) — but the shelf's own per-step
      // `mergeActiveTools(current, selected, universe)` ANDs `selected`
      // (core + whatever got loaded) against `current`, which starts as this
      // ceiling and can only ever be narrowed by later layers, never widened.
      // So a load_tool('coding_write_file_tracked') call from a terminal
      // subtask can still report success, but the tool never actually becomes
      // callable — same shape as the shelf's own "later layer must not
      // reactivate a shelved tool" guarantee, just applied at the outer
      // boundary instead of a later one.
      generateOptions: { activeTools: role.allowedTools },
    });
    const response = harnessResult.response;

    // Collect results from artifact in Mongo
    const collectedResult = await collectSubtaskResult(taskId, subtask.id);

    // ── Phase 3.4: Skill feedback loop ──
    if (loadedSkill) {
      const passed = !collectedResult.hasErrors;
      try {
        await getSkillRegistry().reportResult(
          loadedSkill.metadata.name,
          passed,
          passed ? 'Subtask completed successfully' : collectedResult.errors.join('; '),
        );
      } catch (err) {
        console.warn('[SubtaskExecutor] Skill report failed:', (err as Error).message);
      }
    }

    // ── Phase 4.2: Circuit breaker — record success ──
    getCircuitBreaker().recordSuccess(modelId);

    // ── Phase 4.3: Budget tracking — record request for cloud-free ──
    if (modelId.startsWith('openrouter/')) {
      getBudgetTracker().recordRequest('openrouter', modelId);
    }

    // ── Phase 5: Auto-checkpoint after subtask completion ──
    const subtaskStatus = collectedResult.hasErrors ? 'failed' as const : 'success' as const;
    appendToCheckpoint(taskId, {
      subtaskStatus: { id: subtask.id, status: subtaskStatus === 'success' ? 'done' : 'failed' },
      ...(collectedResult.filesChanged.length > 0
        ? { fileModified: collectedResult.filesChanged.map((f: any) => f.path).join(', ') }
        : {}),
      ...(collectedResult.errors.length > 0
        ? { error: collectedResult.errors[0] }
        : {}),
    }).catch(() => { /* non-critical */ });

    return {
      subtaskId: subtask.id,
      status: collectedResult.hasErrors ? 'partial' : 'success',
      assignedModel: modelId,
      filesChanged: collectedResult.filesChanged,
      commandsRun: collectedResult.commandsRun,
      diagnostics: extractDiagnostics(response),
      errors: collectedResult.errors,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errMsg = (error as Error).message ?? '';

    // Report skill failure if skill was loaded
    if (loadedSkill) {
      try {
        await getSkillRegistry().reportResult(loadedSkill.metadata.name, false, errMsg);
      } catch { /* non-critical */ }
    }

    // ── Phase 4.2: Circuit breaker — record failure ──
    getCircuitBreaker().recordFailure(modelId);

    // ── Offline Fallback (8.4): re-route on infrastructure errors ──
    if (_fallbackAttempt === 0) {
      const fallbackModel = findOfflineFallback(modelId, errMsg, subtask);
      if (fallbackModel) {
        console.warn(
          `[OfflineFallback] ${subtask.id}: ${modelId} failed (${errMsg.substring(0, 80)}), ` +
          `re-routing → ${fallbackModel.modelId}`,
        );
        subtask.assignedModel = fallbackModel.modelId;
        const fallbackResult = await executeSubtask(
          subtask,
          taskId,
          context,
          mastra,
          1,
          artifactLease,
        );
        fallbackResult.actualModel = fallbackModel.modelId;
        return fallbackResult;
      }
    }

    return {
      subtaskId: subtask.id,
      status: 'failed',
      assignedModel: modelId,
      filesChanged: [],
      commandsRun: [],
      diagnostics: '',
      errors: [errMsg],
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (ownsArtifactLeaseLifecycle && artifactLease) {
      await stopArtifactHeartbeat?.();
      try {
        await yieldSubtaskArtifactLease(await getDb(), artifactLease);
      } catch (error) {
        console.warn(
          `[SubtaskArtifactFence] failed to yield ${taskId}/${subtask.id}: ${(error as Error).message}`,
        );
      }
    }
  }
}

// ── Offline Fallback Model Selection (8.4) ───────────────────────────────────

/**
 * Find a fallback model when the assigned model is unreachable.
 * Cloud error → cheapest local model (free) — EXCEPT for code edits, see below.
 * Local error → cheapest cloud model.
 *
 * WHY A SUBTASK IS PASSED IN
 * --------------------------
 * The router pins a code-editing subtask to the coding domain's model
 * (`REPAIR_MODEL_KEY`), because a repair written by a small model produces an
 * empty worktree — measured twice on live autoheal cycles. This function is a
 * SECOND, independent way to choose a model, and it did the opposite: a cloud
 * infrastructure error re-routed the work to "cheapest local with GPU
 * available". One 429 from the provider was enough to hand a repair to a 4B
 * model, silently, with a console.warn as the only trace.
 *
 * Fixing the router alone would have left that hole wide open, which is the
 * general lesson: when a decision has two producers, pinning one is not pinning.
 */
export function findOfflineFallback(
  failedModelId: string,
  errorMessage: string,
  subtask?: Pick<RoutableSubtask, 'type'>,
): ModelCapability | null {
  const isLocal = failedModelId.startsWith('ollama/');
  const errLower = errorMessage.toLowerCase();

  // Heuristics to detect infrastructure errors (not logic errors)
  const isInfraError =
    errLower.includes('timeout') ||
    errLower.includes('econnrefused') ||
    errLower.includes('econnreset') ||
    errLower.includes('fetch failed') ||
    errLower.includes('network') ||
    errLower.includes('503') ||
    errLower.includes('502') ||
    errLower.includes('429') ||
    errLower.includes('rate limit') ||
    errLower.includes('oom') ||
    errLower.includes('out of memory') ||
    errLower.includes('gpu') ||
    errLower.includes('ollama');

  if (!isInfraError) return null; // Logic error — don't fallback, let retry handle it

  if (isLocal) {
    // Local model failed → find cheapest cloud
    return modelRegistry.find((m) => m.vramMb === 0 && m.available) ?? null;
  } else {
    // A cloud model failed. Work that EDITS CODE does not go local, whatever is
    // free — it moves to another cloud model, or it fails honestly.
    if (subtask && subtaskWritesCode(subtask)) {
      const nextCloud = modelRegistry.find((m) =>
        m.vramMb === 0 && m.available && m.modelId !== failedModelId,
      ) ?? null;
      console.warn(
        `[OfflineFallback] code-editing subtask: ${failedModelId} failed, `
        + `${nextCloud ? `re-routing to ${nextCloud.modelId}` : 'and no other cloud model is available'}`
        + ' — local models are not eligible for repairs.',
      );
      return nextCloud;
    }
    // A role the owner moved off local (terminal/qa, J7 2026-08-23) does not
    // reopen it just because its cloud model had a bad day — same rule as the
    // primary router (`smart-router.ts`), applied by the SAME shared function
    // so this second producer of a model decision cannot silently disagree.
    if (subtask && roleExcludedFromLocal(subtask)) {
      return modelRegistry.find((m) =>
        m.vramMb === 0 && m.available && m.modelId !== failedModelId,
      ) ?? null;
    }

    // Everything else may use a local worker.
    try {
      const guard = getGpuGuard();
      const snapshot = guard.getSnapshot();
      if (!snapshot.gpuAvailable) return null;

      return modelRegistry.find((m) =>
        m.vramMb > 0 &&
        m.available &&
        m.vramMb <= snapshot.availableForModelsMb,
      ) ?? null;
    } catch {
      return null; // No GPU info — can't fallback to local
    }
  }
}

// ── Quality Validation ───────────────────────────────────────────────────────

/** The latest compiler result supersedes earlier attempts by the same scope. */
function latestTscCommand<T extends { command: string }>(commands: readonly T[]): T | undefined {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]!;
    if (command.command.includes('tsc')) return command;
  }
  return undefined;
}

/**
 * Validate whether a subtask result actually solved the problem.
 * 5 quality signals are checked.
 */
export async function validateSubtaskQuality(
  subtask: RoutableSubtask,
  result: SubtaskResult,
): Promise<QualityValidation> {
  const signals: QualitySignal[] = [];

  // 1. No files changed (but task requires editing)
  if (result.filesChanged.length === 0 && subtask.type !== 'test') {
    signals.push('no_files_changed');
  }

  // 2. Target files missed — didn't touch required files
  if (subtask.targetFiles.length > 0) {
    const editedPaths = new Set(result.filesChanged.map((f) => f.path));
    const missedTargets = subtask.targetFiles.filter((t) => !editedPaths.has(t));
    if (missedTargets.length > 0) {
      signals.push('target_files_missed');
    }
  }

  // 3. TSC errors after changes
  const tscCmd = latestTscCommand(result.commandsRun);
  if (tscCmd && tscCmd.exitCode !== 0) {
    signals.push('tsc_errors');
  }

  // 4. Agent self-reported failure
  const failureKeywords = ['nie udało', 'nie mogę', 'nie dał rady', 'error:', 'failed to', 'cannot'];
  if (failureKeywords.some((kw) => result.diagnostics.toLowerCase().includes(kw))) {
    signals.push('agent_reported_failure');
  }

  // 5. Empty diagnostics — agent didn't describe what it did
  if (!result.diagnostics || result.diagnostics.trim().length < 10) {
    signals.push('empty_diagnostics');
  }

  const passed = signals.length === 0;
  return {
    passed,
    reason: passed
      ? 'All quality checks passed'
      : `Quality issues: ${signals.join(', ')}`,
    signals,
  };
}

// ── Intelligent Retry & Escalation Loop ──────────────────────────────────────

/**
 * Process subtask results from a parallel group:
 * - Successful results pass through unchanged.
 * - Failed/partial results get retried with enriched prompt, then escalated.
 */
export async function retryFailedSubtasks(
  results: SubtaskResult[],
  group: RoutingResult['groups'][0],
  taskId: string,
  context: SubtaskContext,
  mastra: Mastra,
): Promise<SubtaskResult[]> {
  const finalResults: SubtaskResult[] = [];

  for (const result of results) {
    // Successes and skips pass through
    if (result.status === 'success' || result.status === 'skipped') {
      result.qualityCheck = { passed: true, reason: 'Status OK', attempt: 1, escalationHistory: [] };
      finalResults.push(result);
      continue;
    }

    const match = group.subtasks.find((s) => s.subtask.id === result.subtaskId);
    if (!match) {
      finalResults.push(result);
      continue;
    }
    const subtask = { ...match.subtask };

    // ── Quality check on initial result ──
    const quality = await validateSubtaskQuality(subtask, result);

    if (quality.passed) {
      result.qualityCheck = { passed: true, reason: quality.reason, attempt: 1, escalationHistory: [] };
      // Even if status was 'partial' or 'failed' from executor, quality says OK
      result.status = 'success';
      logAgentEvent({ type: 'task_completed', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: result.assignedModel, status: 'success' });
      finalResults.push(result);
      continue;
    }

    // ── ATTEMPT 2: Retry with same model, enriched prompt ──
    console.warn(`[SubtaskExecutor] Retry ${result.subtaskId}: ${quality.reason}`);

    const retryPendingMessages = await takePendingMessages({
      taskId,
      agentId: 'codingAgent',
      subtaskId: result.subtaskId,
      limit: 5,
    });
    // SEC-001 — acknowledge the whole claimed batch, not only the urgent ones
    // used below, so the remainder is not redelivered pointlessly.
    void ackPendingMessages({ messages: retryPendingMessages, agentId: 'codingAgent', subtaskId: result.subtaskId });
    if (retryPendingMessages.some((message) => message.urgent)) {
      finalResults.push(buildInterruptedSubtaskResult(
        subtask,
        result.assignedModel,
        formatPendingMessagesForPrompt(retryPendingMessages),
        2,
      ));
      continue;
    }

    const retryResult = await executeSubtask(
      subtask,
      taskId,
      { ...context, retryContext: result, pendingMessages: retryPendingMessages },
      mastra,
    );
    const retryQuality = await validateSubtaskQuality(subtask, retryResult);

    if (retryQuality.passed) {
      retryResult.qualityCheck = {
        passed: true,
        reason: 'Passed on retry',
        attempt: 2,
        escalationHistory: [{ model: result.assignedModel, reason: quality.reason }],
      };
      retryResult.status = 'success';

      // ── Phase 0 — Bug #2.1: Auto-save lesson after successful retry ──
      try {
        const db = await getDb();
        await db.collection('signals').insertOne({
          id: randomUUID(),
          type: 'lesson_learned',
          sourceAgent: 'subtask-executor',
          data: {
            task_pattern: `${subtask.type} on ${subtask.targetFiles.join(', ')}`,
            lesson: `Retry succeeded: ${retryQuality.reason}. Original failure: ${quality.reason}`,
            preset: retryResult.assignedModel,
          },
          expiresAt: new Date(Date.now() + 720 * 3600 * 1000), // 30 days
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn('[SubtaskExecutor] Failed to save lesson:', (err as Error).message);
      }

      logAgentEvent({ type: 'retry_success', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: retryResult.assignedModel, status: 'success', metadata: { attempt: 2 } });

      finalResults.push(retryResult);
      continue;
    }

    // ── ATTEMPT 3: Escalate to stronger model ──
    const escalationModel = getEscalationModel(
      retryResult.assignedModel,
      subtask,
      new Set([retryResult.assignedModel]),
    );

    if (escalationModel) {
      console.warn(
        `[SubtaskExecutor] Escalate ${result.subtaskId}: ${retryResult.assignedModel} → ${escalationModel.modelId}`,
      );

      const escalationPendingMessages = await takePendingMessages({
        taskId,
        agentId: 'codingAgent',
        subtaskId: result.subtaskId,
        limit: 5,
      });
      // SEC-001 — acknowledge the whole claimed batch (see retry path above).
      void ackPendingMessages({ messages: escalationPendingMessages, agentId: 'codingAgent', subtaskId: result.subtaskId });
      if (escalationPendingMessages.some((message) => message.urgent)) {
        finalResults.push(buildInterruptedSubtaskResult(
          subtask,
          escalationModel.modelId,
          formatPendingMessagesForPrompt(escalationPendingMessages),
          3,
        ));
        continue;
      }

      subtask.assignedModel = escalationModel.modelId;
      const escalatedResult = await executeSubtask(
        subtask,
        taskId,
        { ...context, pendingMessages: escalationPendingMessages },
        mastra,
      );
      const escalatedQuality = await validateSubtaskQuality(subtask, escalatedResult);

      escalatedResult.actualModel = escalationModel.modelId;
      escalatedResult.qualityCheck = {
        passed: escalatedQuality.passed,
        reason: escalatedQuality.passed ? 'Passed after escalation' : escalatedQuality.reason,
        attempt: 3,
        escalationHistory: [
          { model: result.assignedModel, reason: quality.reason },
          { model: retryResult.assignedModel, reason: retryQuality.reason },
        ],
      };

      escalatedResult.status = escalatedQuality.passed ? 'success' : 'needs_human';

      // ── Phase 0 — Bug #2.1: Auto-save lesson after successful escalation ──
      if (escalatedQuality.passed) {
        try {
          const db = await getDb();
          await db.collection('signals').insertOne({
            id: randomUUID(),
            type: 'lesson_learned',
            sourceAgent: 'subtask-executor',
            data: {
              task_pattern: `${subtask.type} on ${subtask.targetFiles.join(', ')}`,
              lesson: `Escalation from ${retryResult.assignedModel} to ${escalationModel.modelId} succeeded. Original failures: ${quality.reason}; ${retryQuality.reason}`,
              preset: escalationModel.modelId,
            },
            expiresAt: new Date(Date.now() + 720 * 3600 * 1000), // 30 days
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn('[SubtaskExecutor] Failed to save escalation lesson:', (err as Error).message);
        }
      }

      logAgentEvent({ type: escalatedQuality.passed ? 'task_completed' : 'task_failed', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: escalationModel.modelId, status: escalatedQuality.passed ? 'success' : 'error', metadata: { attempt: 3, escalation: true } });

      finalResults.push(escalatedResult);
    } else {
      // No escalation model available → mark needs_human
      retryResult.status = 'needs_human';
      retryResult.qualityCheck = {
        passed: false,
        reason: `No escalation path available: ${retryQuality.reason}`,
        attempt: 2,
        escalationHistory: [{ model: result.assignedModel, reason: quality.reason }],
      };
      logAgentEvent({ type: 'task_failed', agentId: 'codingAgent', taskId, subtaskId: result.subtaskId, model: retryResult.assignedModel, status: 'error', errorMessage: retryQuality.reason, metadata: { noEscalationPath: true } });
      finalResults.push(retryResult);
    }
  }

  return finalResults;
}

// ── Escalation Model Selection ───────────────────────────────────────────────

function getEscalationModel(
  currentModelId: string,
  subtask: RoutableSubtask,
  excludedModels: Set<string>,
): ModelCapability | null {
  const currentModel = modelRegistry.find((m) => m.modelId === currentModelId);
  if (!currentModel) return null;

  const path = ESCALATION_PATH[currentModel.tier] ?? [];

  for (const tierName of path) {
    const candidate = modelRegistry.find((m) =>
      m.tier === tierName &&
      m.available &&
      !excludedModels.has(m.modelId) &&
      complexityMeetsRequirement(m.maxComplexity, subtask.estimatedComplexity ?? 'simple'),
    );
    if (candidate) return candidate;
  }

  return null;
}

function buildInterruptedSubtaskResult(
  subtask: RoutableSubtask,
  assignedModel: string,
  interruptSummary: string,
  attempt: number,
): SubtaskResult {
  return {
    subtaskId: subtask.id,
    status: 'needs_human',
    assignedModel,
    filesChanged: [],
    commandsRun: [],
    diagnostics: interruptSummary,
    errors: ['Urgent soft interrupt consumed before retry/escalation; remaining plan needs re-evaluation.'],
    durationMs: 0,
    qualityCheck: {
      passed: false,
      reason: 'Urgent soft interrupt consumed before retry/escalation',
      attempt,
      escalationHistory: [],
    },
  };
}

// ── Skill Loader ─────────────────────────────────────────────────────────────

/**
 * Find the best matching skill for a subtask + role combination.
 * Uses semantic search on the subtask description, filtered by role category.
 * Returns null if no skill matches above the threshold.
 */
async function findBestSkill(
  subtask: RoutableSubtask,
  role: SubAgentRole,
): Promise<Skill | null> {
  try {
    const registry = getSkillRegistry();
    const description = (subtask as any).description ?? subtask.type;
    const results = await registry.search(description, {
      category: role.roleId === 'file-editor' ? 'coding' : undefined,
      topK: 1,
      minScore: 0.35,
    });

    if (results.length > 0) {
      // Load full procedure
      return await registry.load(results[0].metadata.name);
    }
  } catch (err) {
    console.warn('[SubtaskExecutor] Skill search failed:', (err as Error).message);
  }
  return null;
}

async function resolveRepoPath(taskId: string): Promise<string> {
  try {
    return await getWorkspacePath(taskId);
  } catch (err) {
    console.warn('[SubtaskExecutor] Workspace path lookup failed:', (err as Error).message);
    return AGENTIC_AGENTS_REPO;
  }
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

/**
 * Build a scoped prompt with SubAgentRole context and optional loaded skill.
 * Phase 3.2: Replaces the old buildSubtaskPrompt with role-aware version.
 */
export async function buildScopedPrompt(
  subtask: RoutableSubtask,
  taskId: string,
  context: SubtaskContext,
  role: SubAgentRole,
  skill: Skill | null,
  repoPath: string,
): Promise<string> {
  // J7 (2026-08-23) — `role.promptTemplate` stops being an unread field
  // (`git log -S promptTemplate` was zero commits, Z5). The real
  // `subagent-*.md` files carry a "What You Do NOT Do" boundary, a numbered
  // workflow, a JSON response contract, and security boundaries that the
  // ad-hoc `role.name`/`role.description` pair below never had — this is a
  // content upgrade, not just wiring for its own sake. Fails soft: a missing
  // template degrades to the old inline header rather than losing the whole
  // subtask, since that header alone is what shipped until now.
  let roleHeader: string;
  try {
    roleHeader = await loadPrompt(role.promptTemplate);
  } catch (err) {
    console.warn(
      `[SubtaskExecutor] Failed to load prompt template '${role.promptTemplate}' for role ${role.roleId}: `
      + `${(err as Error).message} — falling back to the inline role header.`,
    );
    roleHeader = `## Role: ${role.name}\n\n${role.description}`;
  }
  const sections: string[] = [roleHeader, ''];

  // ── Phase 5 fallback: when harness pre-context is off, keep legacy assembly ──
  if (!isHarnessFeatureEnabled('FEATURE_CODING_PRECONTEXT', false)) {
    try {
      const assembled = await assembleContext({
        description: (subtask as any).description ?? subtask.id,
        repoPath,
        targetFiles: subtask.targetFiles,
        taskId,
        tokenBudget: 3072,
        mentionedIdents: subtask.targetFiles.map((f) => f.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''),
      });
      const assembledText = formatAssembledContext(assembled);
      if (assembledText.length > 0) {
        sections.push(assembledText);
      }
    } catch (err) {
      // Non-critical — continue without assembled context
      console.warn('[SubtaskExecutor] Context assembly failed:', (err as Error).message);
    }
  }

  // Inject skill procedure if available
  if (skill) {
    sections.push(
      `## Procedure (Skill: ${skill.metadata.name})`,
      `> ${skill.metadata.description}`,
      '',
      skill.procedure,
      '',
    );
  }

  sections.push(
    `## Subtask: ${subtask.id}`,
    `Type: ${subtask.type} | Complexity: ${subtask.estimatedComplexity ?? 'simple'}`,
    '',
    `### Task Description`,
    (subtask as any).description ?? 'No description provided',
    '',
    `### Target Files`,
    subtask.targetFiles.length > 0
      ? subtask.targetFiles.map((f) => `- ${f}`).join('\n')
      : '(none specified — determine yourself)',
    '',
    `### Context from Previous Subtasks`,
    context.previousResults.length > 0
      ? context.previousResults
          .map((r) => `[${r.subtaskId}] ${r.status}: ${r.diagnostics.substring(0, 200)}`)
          .join('\n')
      : '(first subtask — no context)',
    '',
    `### Allowed Tools`,
    role.allowedTools.map((t) => `- ${t}`).join('\n'),
    '',
    `### Instructions`,
    `- Work ONLY on files from the list above (unless this is a 'create' task)`,
    `- Do not edit files outside your scope`,
    // Only told to the roles that actually have the tool — allowedTools is
    // enforced now (J7), so telling every role to use a tool it cannot call
    // would waste a step on a rejection instead of informing it.
    ...(role.allowedTools.includes('coding_write_file_tracked')
      ? [`- Use coding_write_file_tracked with taskId="${taskId}"`]
      : []),
    `- When a coding tool accepts subtaskId/agentId, pass subtaskId="${subtask.id}" and agentId="codingAgent"`,
    ...(role.allowedTools.includes('coding_update_artifact')
      ? [`- After completion, describe what you did in coding_update_artifact`]
      : []),
    `- Your subtaskId: ${subtask.id}`,
  );

  // Role-specific instructions
  if (role.roleId === 'file-editor') {
    sections.push(`- Run npx tsc --noEmit after changes to verify correctness`);
  } else if (role.roleId === 'terminal') {
    sections.push(`- Do NOT edit files — only run verification commands`);
  } else if (role.roleId === 'qa') {
    sections.push(`- Do NOT fix bugs — only report them with precise locations`);
  }

  return sections.join('\n');
}

function buildRetryPrompt(
  subtask: RoutableSubtask,
  previousResult: SubtaskResult,
  taskId: string,
  context: SubtaskContext,
  role?: SubAgentRole,
  skill?: Skill | null,
): string {
  const sections: string[] = [
    `## RETRY subtask: ${subtask.id} (attempt ${(previousResult.qualityCheck?.attempt ?? 1) + 1})`,
  ];

  // Include role context on retry too
  if (role) {
    sections.push('', `### Role: ${role.name}`, role.description);
  }

  // Include skill procedure on retry (it may help the fix)
  if (skill) {
    sections.push(
      '',
      `### Procedure (Skill: ${skill.metadata.name})`,
      skill.procedure,
    );
  }

  sections.push(
    '',
    `### What went wrong in the previous attempt:`,
    previousResult.qualityCheck?.reason ?? 'Unknown reason',
    '',
    `### Previous agent diagnostics:`,
    previousResult.diagnostics || '(none)',
    '',
    `### Errors from previous attempt:`,
    previousResult.errors.length > 0
      ? previousResult.errors.join('\n')
      : '(no explicit errors — but the result did not meet criteria)',
    '',
    `### Files changed (may need correction):`,
    previousResult.filesChanged.map((f) => `- ${f.path}: ${f.summary}`).join('\n') || '(none)',
    '',
    `### Original task:`,
    (subtask as any).description ?? 'No description provided',
    '',
    `### Target files:`,
    subtask.targetFiles.map((f) => `- ${f}`).join('\n'),
    '',
    `### Retry instructions:`,
    `- Analyze WHY the previous attempt failed`,
    `- Re-read target files — they may have changed`,
    `- Fix the specific problems listed above`,
    // Same guard as buildScopedPrompt: allowedTools is enforced now (J7), so
    // a role without the write tool must not be told to use it.
    ...(!role || role.allowedTools.includes('coding_write_file_tracked')
      ? [`- Use coding_write_file_tracked with taskId="${taskId}"`]
      : []),
    `- When a coding tool accepts subtaskId/agentId, pass subtaskId="${subtask.id}" and agentId="codingAgent"`,
    `- Run npx tsc --noEmit after changes`,
    `- Your subtaskId: ${subtask.id}`,
  );

  return sections.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract diagnostics summary from agent response.
 */
function extractDiagnostics(response: any): string {
  try {
    if (typeof response === 'string') return response.substring(0, 1000);
    if (response?.text) return response.text.substring(0, 1000);
    if (response?.output) return response.output.substring(0, 1000);
    return JSON.stringify(response).substring(0, 500);
  } catch {
    return '';
  }
}

/**
 * Collect subtask results from the artifact in MongoDB.
 * After the agent runs, it should have updated the artifact via tools.
 */
export async function collectSubtaskResult(
  taskId: string,
  subtaskId: string,
): Promise<{
  filesChanged: Array<{ path: string; summary: string }>;
  commandsRun: Array<{ command: string; exitCode: number; summary: string }>;
  errors: string[];
  hasErrors: boolean;
}> {
  try {
    const db = await getDb();
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });

    if (!artifact) {
      return { filesChanged: [], commandsRun: [], errors: ['Artifact not found'], hasErrors: true };
    }

    const allFileChanges = Array.isArray(artifact.filesChanged) ? artifact.filesChanged : [];
    const hasAttributedChanges = allFileChanges.some(
      (entry: any) => typeof entry?.subtaskId === 'string' && entry.subtaskId.trim().length > 0,
    );

    // J2 step 2b — once attribution exists, a subtask sees only its own work.
    // Unattributed entries in a mixed artifact belong to nobody: assigning them
    // to every reader would recreate the false conflicts this filter removes.
    //
    // The all-legacy case is deliberately asymmetric. Old artifacts (or a
    // broken write path) can contain real completed work with no attribution at
    // all. Returning zero would trigger no_files_changed, retry the same edit and
    // escalate it to the pinned repair model. Today's task-wide result is a
    // survivable false positive, so preserve it and say loudly which task lost
    // attribution. There is no backfill because the missing fact was never saved.
    const selectedFileChanges = allFileChanges.length > 0 && !hasAttributedChanges
      ? allFileChanges
      : allFileChanges.filter((entry: any) => entry?.subtaskId === subtaskId);
    if (allFileChanges.length > 0 && !hasAttributedChanges) {
      console.warn(
        `[SubtaskExecutor] File attribution unavailable for task ${taskId}; `
        + 'returning the full legacy filesChanged list to avoid retrying completed work.',
      );
    }

    const filesChanged = selectedFileChanges.map((f: any) => ({
      path: f.path,
      summary: f.summary ?? '',
    }));

    const allCommandRuns = Array.isArray(artifact.commandsRun) ? artifact.commandsRun : [];
    const hasAttributedCommands = allCommandRuns.some(
      (entry: any) => typeof entry?.subtaskId === 'string' && entry.subtaskId.trim().length > 0,
    );
    const selectedCommandRuns = allCommandRuns.length > 0 && !hasAttributedCommands
      ? allCommandRuns
      : allCommandRuns.filter((entry: any) => entry?.subtaskId === subtaskId);
    if (allCommandRuns.length > 0 && !hasAttributedCommands) {
      console.warn(
        `[SubtaskExecutor] Command attribution unavailable for task ${taskId}; `
        + 'returning the full legacy commandsRun list to avoid losing historical verification.',
      );
    }

    const commandsRun = selectedCommandRuns.map((c: any) => ({
      command: c.command,
      exitCode: c.exitCode ?? 0,
      summary: c.summary ?? '',
    }));

    const latestTsc = latestTscCommand(commandsRun);
    const tscErrors = latestTsc && latestTsc.exitCode !== 0 ? [latestTsc] : [];

    return {
      filesChanged,
      commandsRun,
      errors: tscErrors.map((e: any) => `TSC error: ${e.summary}`),
      hasErrors: tscErrors.length > 0,
    };
  } catch (err) {
    return {
      filesChanged: [],
      commandsRun: [],
      errors: [(err as Error).message],
      hasErrors: true,
    };
  }
}
