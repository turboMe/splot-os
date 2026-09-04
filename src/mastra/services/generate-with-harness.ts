/**
 * Generic Mastra harness generate gateway.
 *
 * Keeps the operational wrapper shared across agents while allowing each agent
 * to provide its own dynamic pre-context builder.
 */

import { createHash, randomUUID } from 'crypto';
import { extractDeliverableText } from './harness-output-text.js';
import { recordRunStepText, bestRunStepText } from './run-deliverables.js';

import { stepCountIs } from 'ai';
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { isHarnessFeatureEnabled, type HarnessFeatureFlagName } from '../config/harness-flags.js';
import { logHarnessEvent, tokenEstimate } from './harness-events.js';
import { scheduleSemanticMemoryCheck } from './semantic-memory-worker.js';
import { beginHarnessTurn, completeHarnessTurn, failHarnessTurn } from './harness-run-state.js';
import { isWorkspaceTool, logPostHocToolExecution } from './harness-tool-envelope.js';
import {
  runWithHarnessExecutionContext,
  type SubtaskArtifactLeaseIdentity,
} from './harness-execution-context.js';
import { createHarnessAbortToolFenceProcessor } from './harness-abort-tool-fence.js';
import { intersectTransientActiveTools } from '../processors/transient-tool-shelf.js';
import { compactHarnessOutput } from './harness-output-compactor.js';
import { getReflector, disposeReflector, isFailureResult, isValidationFailureResult } from './strategy-reflector.js';
import type { TriggeredReflection } from './strategy-reflector.js';
import {
  automationFinalizeEnabled,
  formatAutomationDeliverableReport,
  getAutomationDeliverableDetails,
  getAutomationDeliverableStatus,
  looksLikeAutomationReport,
  shouldForceAutomationReport,
} from './mcp-handoff-state.js';
import {
  buildToolIdToKeyMap,
  detectPipelinePhase,
  getStatusToolName,
  isPipelineAgent,
  resolvePhaseTools,
  translateToolIdsToKeys,
  type PhaseDetectionStep,
} from '../config/pipeline-phase-tools.js';
import { createGoalCompletionScorer } from '../scorers/goal-completion-scorer.js';
import {
  classifyComplexity,
  setRunDepth,
  getEffectiveProfile,
  getRunDepth,
  disposeRunDepth,
  getThreadDepth,
  recordThreadDepth,
  type ClassificationResult,
  type DepthLevel,
  type DepthProfile,
} from './depth-controller.js';
import { getThinkingProviderOptions } from '../config/thinking-budget.js';
import {
  setRunDeadline,
  clearRunDeadline,
  startRunLiveness,
  touchRunLiveness,
  getRunLivenessState,
  getRunActivityObservation,
  getRemainingRunBudgetMs,
} from './run-budget.js';

/**
 * Report the longest gap between a run's events.
 *
 * This is the measurement that has to precede switching liveness on for V2: the
 * idle window must exceed the longest gap a LEGITIMATE run produces, and since
 * activity is recorded per step rather than per token, a single long generation
 * (design emits a whole 16 KB page as one tool argument) shows up as one big gap.
 */
function logRunActivityGaps(runId: string, agentId: string, liveness: boolean): void {
  const observed = getRunActivityObservation(runId);
  if (!observed || observed.events < 2) return;
  console.log(
    `[Harness] activity gaps: agent=${agentId} maxGap=${(observed.maxGapMs / 1000).toFixed(1)}s `
    + `events=${observed.events} mode=${liveness ? 'LIVENESS' : 'DEADLINE'}`,
  );
}

// P1 — local level ordering for the fast-turn-inside-heavy-task header check.
const DEPTH_ORDER_FOR_HEADER: Record<DepthLevel, number> = {
  fast: 0,
  standard: 1,
  deep: 2,
  critical: 3,
};
import {
  createGoalContract,
  evaluateCompletion,
  getActiveContractForTask,
  getGoalContract,
  recordEvidence,
  recordPlanRevision,
  type GoalCompletionEvaluation,
  type GoalContract,
} from './goal-tracker.js';
import { appendToCheckpoint } from './context-checkpoint.js';
import { selectHealthyModelId } from './model-health-gate.js';
import { resolveTestForcedModelId, fallbackChainForAgent } from '../config/model-manifest.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { AUTOMATION_ARCHITECT_AGENT_ID } from '../config/agent-ids.js';
import { APPROVAL_SUSPENDING_WORKSPACE_TOOLS } from '../workspaces/code-workspace.js';
import { generatePlan } from '../tools/system/plan-task.js';
import { loadPrompt } from '../lib/prompt-loader.js';

export type HarnessPhase =
  // Coding phases
  | 'diagnose'
  | 'plan'
  | 'subtask'
  | 'retry'
  | 'review'
  | 'merge'
  | 'cleanup'
  // Automation phases
  | 'discover'
  | 'compose'
  | 'validate'
  | 'deploy'
  | 'test'
  | 'repair'
  | 'activate'
  // Knowledge/NotebookLM phases
  | 'list'
  | 'source'
  | 'query'
  | 'research'
  | 'studio'
  // Shared
  | 'chat';

export type HarnessContextBuilderInput = {
  taskId?: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  goalContractId?: string;
  userPrompt: string;
  repoPath?: string;
  targetFiles?: string[];
  maxTokens?: number;
  includeMemory?: boolean;
  includeSkills?: boolean;
  includeRepoMap?: boolean;
  includeCheckpoint?: boolean;
  automationId?: string;
  workflowId?: string;
  patternId?: string;
};

export type HarnessPrecontextResult = {
  markdown: string;
  tokenEstimate?: number;
  [key: string]: unknown;
};

export type HarnessStepObservation = {
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError: boolean }>;
  stepText?: string;
};

export type HarnessGenerateInput = {
  agent: Agent;
  agentId: string;
  prompt: string;
  /**
   * Semantic task text used for depth classification and goal extraction. The
   * agent still receives `prompt`; this seam keeps operational wrappers (for
   * example the V2 headless contract) from inventing complexity signals.
   */
  classificationPrompt?: string;
  taskId?: string;
  subtaskId?: string;
  goalContractId?: string;
  threadId?: string;
  runId?: string;
  /** Internal store-owned fence for parallel-subtask artifact writes. */
  artifactLease?: SubtaskArtifactLeaseIdentity;
  repoPath?: string;
  targetFiles?: string[];
  model?: string;
  phase: HarnessPhase;
  /**
   * Nobody can answer this run.
   *
   * Set by callers that execute an agent as a background job. Its one effect is
   * to WITHHOLD the tools that suspend for human approval — Mastra answers
   * `requireApproval` by suspending the agent, which in a supervised session is
   * the feature and in a durable job is a hang with no resumer. Measured on the
   * autoheal loop: a `git` call through `execute_command` suspended the run and
   * the merge never landed, with nothing in the logs to say why.
   *
   * Deliberately NOT a permission change. The agent keeps every other route to a
   * shell (`coding_run_test`, `bg_task`), and those REFUSE rather than suspend,
   * so a headless run is told "no" instead of stopping forever.
   */
  headless?: boolean;
  /**
   * A fixed wall clock for this run. Means "this exact budget", so it keeps
   * DEADLINE semantics and **disables liveness** even when the flag is on.
   */
  timeoutMs?: number;
  /**
   * An absolute backstop, for a caller that wants the run bounded by SILENCE
   * rather than by duration.
   *
   * Under `FEATURE_LIVENESS_BUDGET` this becomes the liveness hard cap and the
   * idle window does the cutting; with the flag off it is used as the wall clock,
   * so passing it instead of `timeoutMs` changes nothing until the flag flips.
   * Pass one or the other, never both.
   */
  hardCapMs?: number;
  /**
   * Initially earned portion of `hardCapMs`. Meaningful progress may extend it
   * through the caller's progress reporter, never beyond `hardCapMs`.
   */
  initialHardCapMs?: number;
  /**
   * A FLOOR under the liveness idle window, for a caller that knows its work
   * goes quiet longer than the depth profile assumes. Raises, never lowers —
   * a design run was measured going 48.3s between events while the `fast`
   * profile allows 45s. Ignored under DEADLINE.
   */
  idleTimeoutMs?: number;
  /**
   * Opt this caller into liveness without the global flag.
   *
   * For a caller that has measured its own gaps and supplies an `idleTimeoutMs`
   * floor to match. Still requires `timeoutMs` to be absent — an explicit wall
   * clock always means DEADLINE.
   */
  preferLiveness?: boolean;
  /**
   * WS-A — optional external cancellation. When the caller (e.g. a delegation
   * timeout) aborts this signal, the underlying `agent.generate` is aborted too,
   * so no orphaned ("zombie") generation keeps running after the caller gave up.
   * The harness also installs its OWN timeout-driven abort on top of this.
   */
  abortSignal?: AbortSignal;
  /** Best-effort observation hook after a step's tool calls/results are normalized. */
  onStepObservation?: (observation: HarnessStepObservation) => void | Promise<void>;
  cachePolicy?: 'static-only' | 'disabled';
  memoryResource?: string;
  precontextFeatureFlag?: HarnessFeatureFlagName;
  precontextFeature?: string;
  precontextDefaultEnabled?: boolean;
  contextBuilder?: (input: HarnessContextBuilderInput) => Promise<HarnessPrecontextResult | null>;
  automationId?: string;
  workflowId?: string;
  patternId?: string;
  contextPolicy?: {
    includeMemory?: boolean;
    includeSkills?: boolean;
    includeRepoMap?: boolean;
    includeCheckpoint?: boolean;
    maxTokens?: number;
  };
  generateOptions?: Record<string, unknown>;
};

export type HarnessGenerateResult<TResponse = unknown> = {
  runId: string;
  turnId: string;
  response: TResponse;
  promptHash: string;
  contextHash?: string;
  outputPreview: string;
  /**
   * The run's deliverable in FULL, taken from whichever pass actually produced
   * one — not truncated like `outputPreview`, and not lost when a follow-up pass
   * returns only a framework report. Empty when the run produced nothing.
   */
  deliverableText: string;
  outputArtifactId?: string;
  durationMs: number;
  model?: string;
  eventsWritten: number;
};

/**
 * Run-scoped escalation blockers stamped by the reflector's `stopWhen`.
 *
 * The blocker used to be written onto the response inside `callAgentGenerate`
 * and nowhere else — but that response is only the FIRST of up to six passes
 * (reflection repair, depth upgrade, auto-deliberation, auto-review, approval
 * gate), and each of them may return a fresh object. At `critical` depth, where
 * the loop-prone runs live, `autoReview` always runs, so the escalation was
 * always discarded: the run really did stop as unrecoverable, `reflector_stop_when`
 * really was logged, and the caller got back a short, ordinary-looking answer
 * with no hint that anything had been cut. Verified 2026-08-24 — the stamped
 * text existed (389 chars in the harness log) and none of `response.text`,
 * `outputPreview` or `deliverableText` carried it by the time the caller saw it.
 *
 * Keyed by runId so the outer pipeline can re-apply it to whichever response
 * actually survives.
 */
const runStopBlockers = new Map<string, string>();

/** Re-apply a run's escalation blocker to the response that survived the passes. */
function applyStopBlocker(runId: string, response: unknown): void {
  const blocker = runStopBlockers.get(runId);
  if (!blocker || !response || typeof response !== 'object') return;
  const record = response as Record<string, unknown>;
  if (typeof record.text !== 'string') return;
  if (record.text.includes(blocker)) return; // already carried through
  const prefix = record.text.trim().length > 0 ? `${record.text}\n\n` : '';
  record.text = `${prefix}⚠️ ${blocker}`;
}

// finalize-on-deliverable — instruction injected by the prepareStep force-report
// lever (Lever 2) once the Golden Path latched a terminal-for-brief deliverable.
// Mirrors base.md "Response To The Caller" so the resulting report carries the tokens
// the completion scorer (Lever 1) + delegation text-contract require.
const AUTOMATION_REPORT_NOW_INSTRUCTION = [
  '✅ The workflow has already been built, deployed, and tested this run (a real n8n workflow exists).',
  'You are DONE. Do NOT call any tools. Write your FINAL report to the caller now, including:',
  '- workflow name',
  '- automationId and workflowId',
  '- status (e.g. tested / inactive, or active)',
  '- validation result and risk score',
  '- any missing credentials or configuration',
  'Do not re-run execute/deploy/test to "polish" an already-tested workflow — that wastes the budget.',
].join('\n');

export async function generateWithHarness<TResponse = unknown>(
  input: HarnessGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  const runId = input.runId ?? input.taskId ?? randomUUID();
  const turnId = randomUUID();
  const threadId = input.threadId ?? input.taskId;
  const harnessEnabled = isHarnessFeatureEnabled('FEATURE_MASTRA_HARNESS', true);
  const precontextEnabled = input.precontextFeatureFlag
    ? isHarnessFeatureEnabled(input.precontextFeatureFlag, input.precontextDefaultEnabled ?? false)
    : false;
  const start = Date.now();
  let eventsWritten = 0;
  const semanticPrompt = input.classificationPrompt ?? input.prompt;

  // ── Phase 4: Adaptive Depth Classification ──
  const depthResult = classifyComplexity({
    prompt: semanticPrompt,
    agentId: input.agentId,
    phase: input.phase,
    // P1 — lets continuation imperatives inherit the thread's heavy depth.
    threadId,
  });
  const depthProfile = depthResult.profile;
  let activeDepthProfile = depthProfile;
  // The caller's absolute bound, however it was expressed.
  //
  // `timeoutMs` means "this exact wall clock", which is why it DISABLES liveness
  // below. `hardCapMs` means "bound me by silence, with this as the backstop" —
  // the form V2 uses, so its attempt window can survive a run that is working.
  // Under DEADLINE the two behave identically, which is what keeps switching the
  // flag off a true no-op.
  const effectiveTimeoutMs = input.timeoutMs ?? input.hardCapMs ?? depthProfile.timeoutMs;
  const effectiveContextMaxTokens = input.contextPolicy?.maxTokens ?? depthProfile.contextBudgetTokens;
  setRunDepth(runId, depthResult.level);
  // P1 — read the thread's remembered depth BEFORE recording this turn, so a
  // light status turn inside a heavy task can be told to not resume the work.
  const priorThreadDepth = threadId ? getThreadDepth(threadId) : undefined;
  if (threadId) recordThreadDepth(threadId, depthResult.level);
  // P2 — publish this run's budget so delegation timeouts can be capped to the
  // parent's remaining budget (read via harness execution context).
  //
  // LIVENESS (ideas/liveness-budget-plan.md): when enabled the run is bounded by
  // silence and an absolute backstop instead of a fixed wall-clock, so an agent
  // that keeps emitting steps is never cut merely for taking long. An explicit
  // caller-supplied `input.timeoutMs` still means "this exact budget", so it
  // keeps the legacy DEADLINE semantics.
  // Either the global flag, or a caller that has done its own homework.
  //
  // `FEATURE_LIVENESS_BUDGET` is all-or-nothing, and four of the five other
  // harness callers (review, coding, knowledge, automation) pass NO `timeoutMs`
  // — so flipping it would move them onto liveness at the same moment, under
  // depth-profile idle windows nobody has measured. Design alone was observed
  // going 99.7s silent while working, which is above every one of those windows.
  // `preferLiveness` lets a caller that supplies its OWN measured idle floor opt
  // in without dragging the untested paths along.
  const livenessEnabled =
    (isHarnessFeatureEnabled('FEATURE_LIVENESS_BUDGET', false) || input.preferLiveness === true)
    && input.timeoutMs === undefined;
  // Env overrides exist so the envelope can be calibrated on real traffic
  // without a rebuild (plan L5); an invalid value is ignored rather than
  // silently shrinking the budget to something unusable.
  // The caller may RAISE the idle window, never lower it — the same rule the
  // step ceiling follows, and for the same reason.
  //
  // Measured on a live design run: `maxGap=48.3s` between events. The `fast`
  // profile's window is 45s, and the depth classifier does hand design `fast`
  // (observed: "Depth: fast (score=0.10)"). Left to the profile alone, liveness
  // would cut a run that was working — the precise failure it exists to prevent.
  const livenessIdleTimeoutMs = Math.max(
    positiveEnvMs('LIVENESS_IDLE_TIMEOUT_MS') ?? depthProfile.idleTimeoutMs,
    input.idleTimeoutMs ?? 0,
  );
  const livenessHardCapMs = Math.max(
    // The caller's own backstop wins over the profile: a V2 attempt window is
    // chosen per capability and frozen onto the task, so the profile must not
    // quietly shorten it — the same rule the step ceiling already follows.
    positiveEnvMs('LIVENESS_HARD_CAP_MS') ?? depthProfile.hardCapMs,
    input.hardCapMs ?? 0,
    livenessIdleTimeoutMs,
  );
  const livenessInitialHardCapMs = Math.min(
    livenessHardCapMs,
    Math.max(input.initialHardCapMs ?? livenessHardCapMs, livenessIdleTimeoutMs),
  );
  if (livenessEnabled) {
    startRunLiveness(runId, {
      idleTimeoutMs: livenessIdleTimeoutMs,
      hardCapMs: livenessInitialHardCapMs,
      maxHardCapMs: livenessHardCapMs,
    });
  } else {
    setRunDeadline(runId, Date.now() + effectiveTimeoutMs);
  }

  const goalTaskId = input.taskId ?? runId;
  let harnessGoalContract = depthProfile.goalContract
    ? await ensureHarnessGoalContract({
        goalContractId: input.goalContractId,
        taskId: goalTaskId,
        agentId: input.agentId,
        prompt: semanticPrompt,
        phase: input.phase,
        depthProfile,
      })
    : null;
  let effectiveGoalContractId = harnessGoalContract?.contractId ?? input.goalContractId;

  if (harnessEnabled) {
    void logHarnessEvent({
      type: 'depth_classified' as any,
      agentId: input.agentId,
      runId,
      threadId,
      status: 'success',
      data: {
        level: depthResult.level,
        score: depthResult.score,
        maxSteps: depthProfile.maxSteps,
        timeoutMs: effectiveTimeoutMs,
        profileTimeoutMs: depthProfile.timeoutMs,
        contextBudgetTokens: effectiveContextMaxTokens,
        profileContextBudgetTokens: depthProfile.contextBudgetTokens,
        reflectorEnabled: depthProfile.reflector.enabled,
        goalContract: depthProfile.goalContract,
        goalContractId: effectiveGoalContractId,
        goalContractAutoEnsured: !!harnessGoalContract && harnessGoalContract.contractId !== input.goalContractId,
        signals: depthResult.signals,
        classificationPromptSource: input.classificationPrompt ? 'semantic_override' : 'prompt',
        classificationPromptHash: hashText(semanticPrompt),
      },
    });
  }

  console.log(
    `[Harness] Depth: ${depthResult.level} (score=${depthResult.score.toFixed(2)}, ` +
    `maxSteps=${depthProfile.maxSteps}, reflector=${depthProfile.reflector.enabled})`,
  );
  // Whether `effectiveContextMaxTokens` governs anything on this run.
  //
  // It has exactly one consumer — the precontext builder below — and only six
  // agents supply one (`orchestration/execution/capability-precontext.ts`).
  // chefAgent, writerAgent and contentAgent do not, so for them the budget is
  // inert. That would be harmless if it stayed inside the code, but the depth
  // header PRINTS it, and the agent has no way to know the number is decorative:
  // a chefAgent run was told "Context budget: 4000 tokens" while its real bound
  // was its own 120k token limiter. Same defect as `Max steps: 10` beside it —
  // a figure the runtime does not enforce, which the model reads as a budget and
  // rations itself against.
  const contextBudgetApplies = precontextEnabled && Boolean(input.contextBuilder);
  const precontext = contextBudgetApplies
    ? await input.contextBuilder!({
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        agentId: input.agentId,
        threadId: input.threadId,
        goalContractId: effectiveGoalContractId,
        userPrompt: input.prompt,
        repoPath: input.repoPath,
        targetFiles: input.targetFiles,
        maxTokens: effectiveContextMaxTokens,
        includeMemory: input.contextPolicy?.includeMemory,
        includeSkills: input.contextPolicy?.includeSkills,
        includeRepoMap: input.contextPolicy?.includeRepoMap,
        includeCheckpoint: input.contextPolicy?.includeCheckpoint,
        automationId: input.automationId,
        workflowId: input.workflowId,
        patternId: input.patternId,
      })
    : null;
  const depthHeader = formatDepthHeader(depthResult, depthProfile, {
    effectiveTimeoutMs,
    // Omitted when nothing enforces it — see `contextBudgetApplies`.
    ...(contextBudgetApplies ? { effectiveContextMaxTokens } : {}),
    // The same resolution `callAgentGenerate` applies, so the number the agent
    // reads is the number the loop enforces.
    effectiveMaxSteps: await stepCeilingFor(input, depthProfile.maxSteps),
    goalContractId: effectiveGoalContractId,
    contract: harnessGoalContract,
    // P1 — when a light turn runs inside a thread with heavier recent work,
    // instruct the model to report status instead of resuming the heavy task.
    threadHeavyLevel:
      priorThreadDepth &&
      DEPTH_ORDER_FOR_HEADER[priorThreadDepth] >= DEPTH_ORDER_FOR_HEADER.deep &&
      DEPTH_ORDER_FOR_HEADER[depthResult.level] < DEPTH_ORDER_FOR_HEADER[priorThreadDepth]
        ? priorThreadDepth
        : undefined,
  });
  let orchestrationSection = '';
  if (
    input.agentId === 'meta-agent'
    && isHarnessFeatureEnabled('FEATURE_META_TIERED_PROMPT', true)
    && depthProfile.level !== 'fast'
  ) {
    try {
      orchestrationSection = await loadPrompt('meta/base-orchestration');
    } catch (err) {
      console.warn('[Harness] Failed to load meta/base-orchestration prompt:', (err as Error).message);
    }
  }

  const contextMarkdown = [depthHeader, orchestrationSection, precontext?.markdown]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
  const finalPrompt = contextMarkdown
    ? `${contextMarkdown}\n\n---\n\n${input.prompt}`
    : input.prompt;
  const contextHash = contextMarkdown ? hashText(contextMarkdown) : undefined;
  const originalPromptHash = hashText(input.prompt);
  const promptHash = hashText(finalPrompt);
  const promptTokensEstimate = tokenEstimate(finalPrompt);

  if (harnessEnabled) {
    await beginHarnessTurn({
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      agentId: input.agentId,
      phase: input.phase,
      repoPath: input.repoPath,
      model: input.model,
      promptHash,
      contextHash,
    });
  }

  if (input.taskId && effectiveGoalContractId) {
    appendToCheckpoint(input.taskId, { goalContractId: effectiveGoalContractId })
      .catch(() => { /* checkpoint link is best-effort */ });
  }

  if (harnessEnabled && contextMarkdown) {
    await logHarnessEvent({
      type: 'precontext_injected',
      agentId: input.agentId,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: input.precontextFeature ?? 'depth_context',
      model: input.model,
      status: 'success',
      output: contextMarkdown,
      data: {
        injected: contextMarkdown.length > 0,
        depthContextInjected: true,
        agentPrecontextInjected: !!precontext?.markdown,
        tokenEstimate: tokenEstimate(contextMarkdown),
        agentPrecontextTokenEstimate: precontext?.tokenEstimate ?? (precontext?.markdown ? tokenEstimate(precontext.markdown) : 0),
        contextBudgetTokens: effectiveContextMaxTokens,
        contextHash,
        depthLevel: depthResult.level,
        planning: depthProfile.planning,
        reflectorEnabled: depthProfile.reflector.enabled,
        goalContractProfileEnabled: depthProfile.goalContract,
        goalContractId: effectiveGoalContractId,
        goalContractAutoEnsured: !!harnessGoalContract && harnessGoalContract.contractId !== input.goalContractId,
        ...(precontext ? precontextTelemetry(precontext) : {}),
      },
    });
    eventsWritten += 1;
  }

  if (harnessEnabled) {
    await logHarnessEvent({
      type: 'llm_call_started',
      agentId: input.agentId,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'mastra_harness',
      model: input.model,
      status: 'pending',
      data: {
        phase: input.phase,
        repoPath: input.repoPath,
        targetFiles: input.targetFiles,
        promptHash,
        originalPromptHash,
        contextHash,
        promptTokensEstimate,
        depthLevel: depthResult.level,
        maxSteps: depthProfile.maxSteps,
        timeoutMs: effectiveTimeoutMs,
        contextBudgetTokens: effectiveContextMaxTokens,
        planning: depthProfile.planning,
        reflectorEnabled: depthProfile.reflector.enabled,
        cachePolicy: input.cachePolicy ?? 'static-only',
        contextPolicy: input.contextPolicy,
        goalContractId: effectiveGoalContractId,
        precontextApplied: !!contextMarkdown,
        agentPrecontextApplied: !!precontext?.markdown,
        precontextFeature: input.precontextFeature,
      },
    });
    eventsWritten += 1;
  }

  // THE LAST PASS IS NOT ALWAYS THE ONE THAT PRODUCED THE ANSWER.
  //
  // `response` is reassigned by up to three follow-up passes below (reflection
  // repair, depth upgrade, auto-deliberation), and each is a fresh `generate`
  // whose response replaces the previous one wholesale. Measured live: a chef run
  // emitted 45 events and then returned `steps=1, toolCalls=0` whose only text
  // was the framework's completion report, so every candidate was framework
  // output and the attempt failed with nothing — while the real menu sat in a
  // response that had already been overwritten. A design run committed "Depth
  // re-examination complete…" for the same reason.
  //
  // So the best deliverable seen across the whole run is remembered. Full text,
  // not `outputPreview` — that one is truncated to 1000 chars.
  let bestDeliverable = '';
  const rememberDeliverable = (candidate: unknown): void => {
    const text = extractDeliverableText(candidate);
    if (text.trim().length > 0) bestDeliverable = text;
  };

  try {
    let response = await callAgentGenerate<TResponse>(
      { ...input, goalContractId: effectiveGoalContractId, prompt: finalPrompt, timeoutMs: effectiveTimeoutMs },
      { runId, turnId, threadId, originalPrompt: semanticPrompt },
    );
    rememberDeliverable(response);
    response = await maybeRunReflectionRepairPass({
      input,
      response,
      originalPrompt: semanticPrompt,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      model: input.model,
      memoryResource: input.memoryResource,
    });
    rememberDeliverable(response);

    activeDepthProfile = getEffectiveProfile(runId, input.agentId);
    if (activeDepthProfile.goalContract && !effectiveGoalContractId) {
      harnessGoalContract = await ensureHarnessGoalContract({
        goalContractId: effectiveGoalContractId,
        taskId: goalTaskId,
        agentId: input.agentId,
        prompt: semanticPrompt,
        phase: input.phase,
        depthProfile: activeDepthProfile,
      });
      effectiveGoalContractId = harnessGoalContract?.contractId ?? effectiveGoalContractId;
    }

    response = await maybeRunDepthUpgradeSecondPass({
      input: { ...input, goalContractId: effectiveGoalContractId },
      response,
      originalPrompt: semanticPrompt,
      initialDepthLevel: depthResult.level,
      activeDepthProfile,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      model: input.model,
      memoryResource: input.memoryResource,
    });
    rememberDeliverable(response);

    response = await maybeRunAutoDeliberationPass({
      input: { ...input, goalContractId: effectiveGoalContractId },
      response,
      originalPrompt: semanticPrompt,
      depthProfile: activeDepthProfile,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      model: input.model,
      memoryResource: input.memoryResource,
    });
    rememberDeliverable(response);

    const resp = response as Record<string, unknown>;
    const steps = Array.isArray(resp.steps) ? resp.steps as Array<Record<string, unknown>> : [];
    const allToolCalls = steps.flatMap((s) => Array.isArray(s.toolCalls) ? s.toolCalls as Array<Record<string, unknown>> : []);
    const allToolResults = steps.flatMap((s) => Array.isArray(s.toolResults) ? s.toolResults as Array<Record<string, unknown>> : []);
    console.log(`[Harness] Response: text=${(resp.text as string || '').length} chars, finishReason=${resp.finishReason}, steps=${steps.length}, toolCalls=${allToolCalls.length}, toolResults=${allToolResults.length}`);
    if (allToolCalls.length > 0) {
      allToolCalls.forEach((tc) => {
        const payload = tc.payload as Record<string, unknown> | undefined;
        const name = payload?.toolName || tc.toolName || 'unknown';
        const args = payload?.args || tc.args || {};
        console.log(`[Harness]   toolCall: ${name} args=${JSON.stringify(args).slice(0, 300)}`);
      });
    }
    if (allToolResults.length > 0) {
      allToolResults.forEach((tr) => {
        console.log(`[Harness]   toolResult: ${tr.toolName} result=${JSON.stringify(tr.result || '').slice(0, 200)}`);
      });
    }
    if (resp.finishReason === 'suspended') {
      console.warn('[Harness] Agent suspended by approval-gated tool. suspendPayload:', JSON.stringify((resp as any).suspendPayload || {}).slice(0, 300));
    }
    console.log(`[Harness] Response keys: ${Object.keys(resp).join(', ')}`);
    console.log(`[Harness] Full response (truncated): ${JSON.stringify(resp).slice(0, 800)}`);

    response = await maybeRunAutoReviewPass({
      input: { ...input, goalContractId: effectiveGoalContractId },
      response,
      originalPrompt: semanticPrompt,
      goalContractId: effectiveGoalContractId,
      depthProfile: activeDepthProfile,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      model: input.model,
      memoryResource: input.memoryResource,
    });

    response = await maybeRunApprovalGatePass({
      input: { ...input, goalContractId: effectiveGoalContractId },
      response,
      originalPrompt: semanticPrompt,
      goalContractId: effectiveGoalContractId,
      depthProfile: activeDepthProfile,
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      model: input.model,
      memoryResource: input.memoryResource,
    });

    if (effectiveGoalContractId) {
      await recordHarnessFinalGoalEvidence({
        goalContractId: effectiveGoalContractId,
        outputPreview: extractOutputPreview(response),
      });
      const completionEvaluation = await safeEvaluateGoalCompletion(effectiveGoalContractId);
      const gatedResponse = await maybeRunGoalCompletionRepairPass({
        input: { ...input, goalContractId: effectiveGoalContractId },
        response,
        originalPrompt: semanticPrompt,
        evaluation: completionEvaluation,
        goalContractId: effectiveGoalContractId,
        depthProfile: activeDepthProfile,
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        model: input.model,
        memoryResource: input.memoryResource,
      });
      if (gatedResponse !== response) {
        response = gatedResponse;
        await recordHarnessFinalGoalEvidence({
          goalContractId: effectiveGoalContractId,
          outputPreview: extractOutputPreview(response),
        });
        await safeEvaluateGoalCompletion(effectiveGoalContractId);
      }
    }

    const durationMs = Date.now() - start;

    // The reflector may have ended this run as unrecoverable several passes ago;
    // re-stamp its escalation onto whatever response survived, so the caller is
    // told to escalate instead of receiving a truncated, ordinary-looking answer.
    applyStopBlocker(runId, response);

    const outputPreview = extractOutputPreview(response);
    const fullOutputText = extractFullOutputText(response);

    // Etap 7 (CGP): when the agent says it lacks a tool/capability, emit a
    // capability_gap so capabilitySmith can fill it later. Fire-and-forget.
    detectCapabilityGap(input.agentId, outputPreview, input.taskId);
    const outputCompaction = await compactHarnessOutput({
      text: fullOutputText,
      kind: 'llm_output',
      runId,
      turnId,
      threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      agentId: input.agentId,
      previewBytes: 1000,
      forcePersist: true,
      metadata: {
        scope: 'harness_generate_output',
        phase: input.phase,
      },
    });
    const outputArtifactId = outputCompaction.fullTextArtifactId;

    if (harnessEnabled) {
      await logHarnessEvent({
        type: 'llm_call_completed',
        agentId: input.agentId,
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        feature: 'mastra_harness',
        model: input.model,
        status: 'success',
        durationMs,
        output: outputPreview,
        data: {
          phase: input.phase,
          promptHash,
          originalPromptHash,
          contextHash,
          goalContractId: effectiveGoalContractId,
          depthLevel: activeDepthProfile.level,
          initialDepthLevel: depthResult.level,
          maxSteps: activeDepthProfile.maxSteps,
          timeoutMs: effectiveTimeoutMs,
          contextBudgetTokens: effectiveContextMaxTokens,
          outputTokensEstimate: tokenEstimate(outputPreview),
          outputArtifactId,
          precontextApplied: !!contextMarkdown,
          agentPrecontextApplied: !!precontext?.markdown,
          precontextFeature: input.precontextFeature,
        },
      });
      eventsWritten += 1;
    }

    if (harnessEnabled) {
      await completeHarnessTurn({
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        agentId: input.agentId,
        phase: input.phase,
        repoPath: input.repoPath,
        model: input.model,
        promptHash,
        contextHash,
        durationMs,
        outputPreview,
        outputArtifactId,
      });
    }

    schedulePostTurnMemory(input, runId, turnId, outputPreview, undefined);

    // ── Phase 2: Log reflector snapshot and cleanup ──
    try {
      const reflectorSnapshot = getReflector({ runId, agentId: input.agentId }).getSnapshot();
      if (reflectorSnapshot.stepNumber > 0) {
        void logHarnessEvent({
          type: 'reflector_snapshot',
          agentId: input.agentId,
          runId,
          turnId,
          threadId,
          taskId: input.taskId,
          subtaskId: input.subtaskId,
          status: 'success',
          data: reflectorSnapshot as unknown as Record<string, unknown>,
        });
      }
    } catch { /* non-critical */ }
    // Sizing evidence for the idle window, logged BEFORE the observation is
    // cleared. `touchRunLiveness` fires on step boundaries and tool returns, not
    // per token, so this is the number that decides whether liveness would cut a
    // working run: the longest a legitimate run went without emitting anything.
    logRunActivityGaps(runId, input.agentId, livenessEnabled);
    disposeReflector(runId);
    disposeRunDepth(runId);
    clearRunDeadline(runId);
    runStopBlockers.delete(runId);

    return {
      runId,
      turnId,
      response,
      promptHash,
      contextHash,
      outputPreview,
      // Third source, and the only one that survives the harness keeping just
      // the LAST `generate`: what the steps actually said while they ran.
      deliverableText: extractDeliverableText(response)
        || bestDeliverable
        || bestRunStepText(runId),
      outputArtifactId,
      durationMs,
      model: input.model,
      eventsWritten,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    const err = error as Error;

    if (harnessEnabled) {
      await logHarnessEvent({
        type: 'llm_call_failed',
        agentId: input.agentId,
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        feature: 'mastra_harness',
        model: input.model,
        status: 'error',
        durationMs,
        errorMessage: err.message,
        data: {
          phase: input.phase,
          promptHash,
          originalPromptHash,
          contextHash,
          goalContractId: effectiveGoalContractId,
          errorClass: err.name || 'Error',
          depthLevel: activeDepthProfile.level,
          initialDepthLevel: depthResult.level,
          maxSteps: activeDepthProfile.maxSteps,
          timeoutMs: effectiveTimeoutMs,
          contextBudgetTokens: effectiveContextMaxTokens,
          precontextApplied: !!contextMarkdown,
          agentPrecontextApplied: !!precontext?.markdown,
          precontextFeature: input.precontextFeature,
        },
      });
      eventsWritten += 1;
    }

    if (harnessEnabled) {
      await failHarnessTurn({
        runId,
        turnId,
        threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        agentId: input.agentId,
        phase: input.phase,
        repoPath: input.repoPath,
        model: input.model,
        promptHash,
        contextHash,
        durationMs,
        errorClass: err.name || 'Error',
        errorMessage: err.message,
      });
    }

    schedulePostTurnMemory(input, runId, turnId, undefined, err.message);

    if (effectiveGoalContractId) {
      await recordHarnessFailureGoalEvidence({
        goalContractId: effectiveGoalContractId,
        errorMessage: err.message,
      });
      await safeEvaluateGoalCompletion(effectiveGoalContractId);
    }

    // ── Phase 2: Cleanup reflector on failure ──
    // A run that was CUT is the most informative sample for sizing the window,
    // so the gaps are logged on this path too.
    logRunActivityGaps(runId, input.agentId, livenessEnabled);
    disposeReflector(runId);
    disposeRunDepth(runId);
    clearRunDeadline(runId);
    runStopBlockers.delete(runId);

    throw error;
  }
}

/**
 * What the AGENT itself says it needs to finish, if it says anything.
 *
 * `maxSteps` on an agent is not a preference, it is a structural fact about its
 * pipeline: `chefAgent` declares 150 because recon → profile → menu → recipes →
 * book does not fit in fewer. Read defensively — an agent that declares nothing,
 * or a framework that stops exposing this, simply leaves the profile in charge.
 */
async function declaredMaxSteps(agent: unknown): Promise<number | undefined> {
  try {
    const getter = (agent as { getDefaultOptions?: (ctx: unknown) => unknown })?.getDefaultOptions;
    if (typeof getter !== 'function') return undefined;
    const options = await getter.call(agent, {}) as { maxSteps?: unknown } | undefined;
    const declared = options?.maxSteps;
    return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
      ? declared
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The step ceiling for this run: the depth profile, but NEVER below what the
 * agent declares it needs.
 *
 * The profile exists to spend less on shallow work, and for that a ceiling is
 * the right lever — but only in one direction. Raising a ceiling cannot make a
 * short turn longer (the model stops when it is done), while lowering it below a
 * pipeline's structural need does not save anything: the run burns its whole
 * window and returns NOTHING, and the job then retries it.
 *
 * That is not hypothetical. `chefAgent` (declares 150) was given `deep`'s 40, ran
 * the full 894s of its V2 attempt, produced no text at all, and the job ended
 * FAILED — while the same agent works on legacy, whose delegation path passes no
 * `maxSteps` and therefore leaves the agent's own 150 in place. The harness was
 * quietly overriding a limit it did not own.
 */
async function stepCeilingFor(
  input: HarnessGenerateInput,
  profileMaxSteps: number,
): Promise<number> {
  const declared = await declaredMaxSteps(input.agent);
  if (declared === undefined || declared <= profileMaxSteps) return profileMaxSteps;
  console.log(
    `[Harness] step ceiling raised to the agent's own ${declared} (profile: ${profileMaxSteps})`
    + ` — ${input.agentId} declares it needs them`,
  );
  return declared;
}

async function callAgentGenerate<TResponse>(
  input: HarnessGenerateInput,
  harnessContext?: { runId: string; turnId: string; threadId?: string; originalPrompt?: string },
): Promise<TResponse> {
  const effectiveProfile = getEffectiveProfile(harnessContext?.runId ?? '');
  const generateOptions: Record<string, unknown> = {
    maxSteps: await stepCeilingFor(
      input,
      effectiveProfile.maxSteps,
    ),
    ...(input.generateOptions ?? {}),
  };

  if (
    !generateOptions.providerOptions
    && isHarnessFeatureEnabled('FEATURE_DYNAMIC_THINKING_BUDGET', true)
  ) {
    const thinkingOptions = getThinkingProviderOptions(effectiveProfile.thinkingTier);
    if (Object.keys(thinkingOptions).length > 0) {
      generateOptions.providerOptions = thinkingOptions;
    }
  }

  // §2.6 — set when `stopWhen` decides the trajectory is unrecoverable, so the
  // post-run path can surface an explicit blocker instead of a feigned success.
  let stopWhenBlocker: string | null = null;

  if (input.model) {
    generateOptions.model = input.model;
  }

  // ── loop_fix.md P1 — generate-time model selection ──
  // (a) TEST_FORCE_MODEL: pin every harness-driven generation to one cheap cloud
  //     model for E2E (immune to cross-provider outages). Highest precedence.
  // (b) Health gate (FEATURE_MODEL_HEALTH_GATE): if the model the agent would
  //     use is unavailable / circuit-open, swap to a healthy fallback BEFORE
  //     burning the 300s wall-clock. Default OFF → behaviour-preserving.
  // `effectiveModelId` is the model the run will actually use (when known), used
  // below to record circuit-breaker outcomes.
  let effectiveModelId: string | null =
    typeof generateOptions.model === 'string' ? generateOptions.model : null;

  const forcedModelId = resolveTestForcedModelId();
  if (forcedModelId) {
    generateOptions.model = forcedModelId;
    effectiveModelId = forcedModelId;
    console.log(`[Harness] TEST_FORCE_MODEL active → ${forcedModelId} (agent=${input.agentId})`);
  } else if (isHarnessFeatureEnabled('FEATURE_MODEL_HEALTH_GATE', false)) {
    try {
      const gate = selectHealthyModelId({
        agentId: input.agentId,
        requestedModelId: typeof generateOptions.model === 'string' ? generateOptions.model : null,
      });
      if (gate.modelId) effectiveModelId = gate.modelId;
      if (gate.swapped && gate.modelId) {
        generateOptions.model = gate.modelId;
        console.warn(
          `[Harness] Model health gate: ${gate.intendedModelId} unhealthy (${gate.reason}) → ` +
          `falling back to ${gate.modelId} (agent=${input.agentId})`,
        );
        void logHarnessEvent({
          type: 'model_health_fallback' as any,
          agentId: input.agentId,
          runId: harnessContext?.runId,
          turnId: harnessContext?.turnId,
          threadId: harnessContext?.threadId,
          taskId: input.taskId,
          subtaskId: input.subtaskId,
          feature: 'strategy_reflector',
          status: 'success',
          data: {
            intendedModel: gate.intendedModelId,
            fallbackModel: gate.modelId,
            reason: gate.reason,
          },
        });
      }
    } catch (gateErr) {
      // Never let the gate break a run — fall through to the agent's model.
      console.warn('[Harness] model health gate error (non-fatal):', (gateErr as Error).message);
    }
  }

  // Use the RESOLVED threadId (input.threadId ?? input.taskId), the same value
  // used for telemetry/precontext everywhere else. Gating on the raw
  // `input.threadId` meant callers that pass only `taskId` (e.g. the self-heal
  // repo-maintenance workflow) got NO memory thread — and agents with a
  // thread-scoped ObservationalMemory processor then throw "requires a threadId".
  const resolvedThreadId = harnessContext?.threadId ?? input.threadId ?? input.taskId;
  if (resolvedThreadId) {
    generateOptions.memory = {
      thread: resolvedThreadId,
      resource: input.memoryResource ?? input.agentId ?? 'harness',
    };
  }

  const toolEnvelopeEnabled = isHarnessFeatureEnabled('FEATURE_TOOL_ENVELOPE', true);
  const stepObserver = input.onStepObservation;
  // Earned attempt time is an orchestration contract, not a side effect of tool
  // telemetry. Keep the trusted step observer alive even when the independent
  // envelope feature is disabled.
  if (stepObserver && (!harnessContext || !toolEnvelopeEnabled)) {
    generateOptions.onStepFinish = async (stepResult: Record<string, unknown>) => {
      const observationRunId = harnessContext?.runId ?? input.runId ?? input.taskId;
      if (observationRunId) touchRunLiveness(observationRunId);
      const rawToolCalls = Array.isArray(stepResult.toolCalls)
        ? stepResult.toolCalls as Array<Record<string, unknown>>
        : [];
      const rawToolResults = Array.isArray(stepResult.toolResults)
        ? stepResult.toolResults as Array<Record<string, unknown>>
        : [];
      const toolCalls = rawToolCalls.map(normalizeToolCall);
      const toolResults = rawToolResults.map((result) => normalizeToolResult(result, toolCalls));
      try {
        await stepObserver({
          toolCalls,
          toolResults,
          ...(typeof stepResult.text === 'string' ? { stepText: stepResult.text } : {}),
        });
      } catch (error) {
        console.warn('[Harness] step observation failed (non-fatal):', (error as Error).message);
      }
    };
  }

  if (harnessContext && toolEnvelopeEnabled) {
    const ctx = harnessContext;

    // ── Phase 2+4: Strategy Reflector — per-run instance with depth-aware config ──
    const currentProfile = getEffectiveProfile(ctx.runId);
    const reflectorEnabled = currentProfile.reflector.enabled;
    const reflector = getReflector({
      runId: ctx.runId,
      agentId: input.agentId,
      config: currentProfile.reflector.config,
      originalPrompt: ctx.originalPrompt,
      suppressScopeCreep: input.agentId === AUTOMATION_ARCHITECT_AGENT_ID,
    });

    // ── Part 1: in-flight prepareStep actuator (gated by flag) ──
    // When ON, reflection reaches the model BEFORE the next step via prepareStep,
    // and the incremental analyzeStep below is suppressed to avoid double counting.
    const prepareStepEnabled =
      reflectorEnabled && isHarnessFeatureEnabled('FEATURE_REFLECTOR_PREPARE_STEP', true);

    generateOptions.onStepFinish = async (stepResult: Record<string, unknown>) => {
      // LIVENESS — a completed step (and any tool result it carries) is proof of
      // life: reset the idle window so a working agent keeps earning time. No-op
      // for DEADLINE runs, so this is safe regardless of the flag.
      if (harnessContext?.runId) touchRunLiveness(harnessContext.runId);
      // And remember the step's text: the final response may not contain it —
      // see `run-deliverables.ts`.
      recordRunStepText(harnessContext?.runId, stepResult.text);
      const rawToolCalls = Array.isArray(stepResult.toolCalls) ? stepResult.toolCalls as Array<Record<string, unknown>> : [];
      const rawToolResults = Array.isArray(stepResult.toolResults) ? stepResult.toolResults as Array<Record<string, unknown>> : [];
      const toolCalls = rawToolCalls.map(normalizeToolCall);
      const toolResults = rawToolResults.map((tr) => normalizeToolResult(tr, toolCalls));

      if (input.onStepObservation) {
        try {
          await input.onStepObservation({
            toolCalls,
            toolResults,
            ...(typeof stepResult.text === 'string' ? { stepText: stepResult.text } : {}),
          });
        } catch (error) {
          // An observation hook may decline to extend a budget, but it must never
          // break the underlying domain work.
          console.warn('[Harness] step observation failed (non-fatal):', (error as Error).message);
        }
      }

      // ── Existing: post-hoc tool envelope logging ──
      for (const tc of toolCalls) {
        const toolName = tc.toolName;
        if (!toolName || !isWorkspaceTool(toolName)) continue;

        const matchingResult = toolResults.find((tr) => tr.toolCallId === tc.toolCallId);
        await logPostHocToolExecution({
          toolCallId: tc.toolCallId,
          toolId: toolName,
          args: tc.args,
          result: matchingResult?.result,
          isError: matchingResult?.isError === true,
          agentId: input.agentId,
          runId: ctx.runId,
          turnId: ctx.turnId,
          threadId: ctx.threadId,
          taskId: input.taskId,
          subtaskId: input.subtaskId,
        });
      }

      await recordHarnessToolGoalEvidence({
        goalContractId: input.goalContractId,
        toolResults,
      });

      // ── Phase 2+4: Strategy Reflector analysis (gated by depth profile) ──
      // When prepareStep is ON, the in-flight path owns signal evaluation +
      // counting (via evaluateHistory/recordIntervention); skip analyzeStep here
      // so signals are not counted twice.
      if (reflectorEnabled && !prepareStepEnabled) {
        try {
          const decision = reflector.analyzeStep({
            toolCalls: toolCalls.map((tc) => ({ toolName: tc.toolName, args: tc.args })),
            toolResults: toolResults.map((tr) => ({ toolName: tr.toolName, result: tr.result, isError: tr.isError })),
            stepText: typeof stepResult.text === 'string' ? stepResult.text : undefined,
            agentId: input.agentId,
          });

          if (decision.action === 'inject_reflection' && decision.message) {
            // Log the reflection event for observability
            console.warn(`[Harness] Strategy Reflector: ${decision.signal} — ${decision.reason}`);
          }
          // This branch only runs when FEATURE_REFLECTOR_PREPARE_STEP is OFF
          // (legacy post-hoc mode): the reflection is logged + drives the
          // post-hoc repair pass, while the prompt-level reflector (Phase 1)
          // handles in-context behavior. When the flag is ON, the in-flight
          // prepareStep actuator below injects the reflection BEFORE the next
          // step instead, so this branch is gated off (see prepareStepEnabled).
        } catch (reflectorErr) {
          // Non-critical — reflector must never break agent execution
          console.warn('[Harness] Strategy Reflector error (non-fatal):', (reflectorErr as Error).message);
        }
      }
    };

    // ── Part 1: in-flight prepareStep actuator ──
    // Runs BEFORE every step. Recomputes signals from the full history
    // (stateless evaluateHistory), and on anomaly injects a reflection as a
    // system message + narrows activeTools / forces no-tool for the NEXT step,
    // so the correction reaches the model in-flight (not post-hoc).
    if (prepareStepEnabled) {
      // Enumerate the tool universe once for activeTools allowlist construction.
      // Also build an id → registryKey map: the per-phase map is authored in tool
      // `id`s, but step history / activeTools key on the tool OBJECT KEY, so the
      // phase allowlist must be translated to keys before it can match.
      let toolUniverse: string[] = [];
      let idToKey: Record<string, string> = {};
      try {
        const registry = await input.agent.listTools();
        toolUniverse = Object.keys(registry);
        idToKey = buildToolIdToKeyMap(registry);
      } catch (toolErr) {
        console.warn('[Harness] prepareStep: listTools failed (non-fatal):', (toolErr as Error).message);
      }

      // Workspace tools are merged separately at request time, so `listTools()`
      // does not report them. They have to be enumerated too, because the
      // headless allowlist below is an ALLOWLIST: naming only the assigned tools
      // would silently take `view`, `find_files` and `lsp_inspect` away from an
      // agent that needs them — a capability loss dressed as a safety measure.
      let workspaceToolNames: string[] = [];
      try {
        const workspaceTools = await (input.agent as unknown as {
          listWorkspaceTools?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
        }).listWorkspaceTools?.({ runId: ctx.runId });
        workspaceToolNames = Object.keys(workspaceTools ?? {});
      } catch (wsErr) {
        console.warn('[Harness] prepareStep: listWorkspaceTools failed (non-fatal):', (wsErr as Error).message);
      }

      // A run nobody can answer must not be offered a tool that stops to ask.
      // Fail-OPEN, and loudly: if either enumeration came back empty we cannot
      // build a complete allowlist, and an incomplete one removes tools instead
      // of removing the hazard. Better to log the gap than to quietly shrink the
      // agent — the whole point of this migration is "same or better".
      let headlessAllow: string[] | null = null;
      if (input.headless) {
        const universe = [...toolUniverse, ...workspaceToolNames];
        const suspending = universe.filter((name) => APPROVAL_SUSPENDING_WORKSPACE_TOOLS.includes(name));
        if (universe.length === 0) {
          console.warn(
            '[Harness] headless run could not enumerate its tools — approval-suspending tools '
            + 'stay reachable this run (fail-open). A suspension here will hang the job.',
          );
        } else if (suspending.length > 0) {
          headlessAllow = universe.filter((name) => !suspending.includes(name));
          console.log(
            `[Harness] headless: withholding ${suspending.join(', ')} `
            + `(${headlessAllow.length} of ${universe.length} tools remain)`,
          );
        }
      }

      // §2.1/2.2 — GoalContract-aware triggers (progress_stall / wrong_tool).
      // Default ON; only active when this run actually has a goal contract.
      const goalTriggersEnabled =
        isHarnessFeatureEnabled('FEATURE_REFLECTOR_GOAL_TRIGGERS', true) && !!input.goalContractId;
      // §2.5 — hard levers (escalateModel / forceTool / restrictTools).
      const hardLeversEnabled = isHarnessFeatureEnabled('FEATURE_REFLECTOR_HARD_LEVERS', true);
      // §A — graceful convergence (converge signal + convergence stopWhen).
      const convergenceEnabled = isHarnessFeatureEnabled('FEATURE_REFLECTOR_CONVERGENCE', true);
      // Optional stronger model for the escalateModel lever (no-op if unset).
      const escalationModel = process.env.REFLECTOR_ESCALATION_MODEL?.trim() || undefined;
      // Per-request series of GoalContract progress observed before each step,
      // so the reflector can detect a flat progress delta (progress_stall).
      const progressSamples: number[] = [];

      // §3.5 — Automation Golden Path per-phase tool channeling. The harness
      // already knows the static `input.phase`; when FEATURE_PIPELINE_PHASE_TOOLS
      // is on, surface only that phase's tools (fail-open → null = no restriction
      // for non-pipeline agents/phases). Applied on EVERY step, not just anomalies.
      const phaseToolsEnabled = isHarnessFeatureEnabled('FEATURE_PIPELINE_PHASE_TOOLS', true);
      let phaseToolsLogged = false;

      // ── W1: a pipeline agent's phase is a fact about the RUN, not the call ──
      //
      // A pipeline agent (chef/content/hunt/writer/…) walks a state machine and
      // announces each transition through its own status tool. `input.phase` is a
      // single value fixed before the run starts, which is right for the coding /
      // automation sub-phases it was built for and WRONG here: V2 passes
      // `phase: 'chat'`, `resolvePhaseTools` has no such phase, and the run is
      // left unrestricted for its whole length.
      //
      // Measured, not theorised: chefAgent on V2 did `intake` and jumped straight
      // to `chef_generate_menu` — no recon (so no research delegation), no critic
      // gate, no `chef_save_menu`. The project row ended `status: done` with
      // `menu: BRAK`. Legacy drives the same agent correctly because its pipeline
      // wrapper re-derives the phase before every step; this brings that one
      // missing piece into the harness so a pipeline capability on V2 is not
      // weaker than the same agent on legacy.
      const pipelineAgent = isPipelineAgent(input.agentId);
      const statusToolName = pipelineAgent ? getStatusToolName(input.agentId) : undefined;
      // Step history reports the tool OBJECT KEY, the phase map is authored in
      // ids — match on the key, exactly as the legacy wrapper does.
      const statusToolKey = statusToolName ? (idToKey[statusToolName] ?? statusToolName) : undefined;
      // Sticky, because ObservationalMemory compacts the message window mid-run:
      // a later `prepareStep` can receive a `steps` array whose status call has
      // scrolled out, detection returns null, and channeling would silently
      // fail-open for the rest of the run. A real transition always appears in the
      // just-finished step, so genuine changes still win over the retained value.
      let stickyPhase: string | null = null;
      let lastLoggedPhase: string | null = null;

      /** The phase this step should be channeled to, or `null` for no restriction. */
      const resolvePhaseAllow = (steps: PhaseDetectionStep[]): string[] | null => {
        if (!phaseToolsEnabled) return null;
        if (!pipelineAgent || !statusToolKey) {
          // Unchanged for everyone else — same call, same static phase.
          return translateToolIdsToKeys(resolvePhaseTools(input.agentId, input.phase), idToKey);
        }
        const detected = detectPipelinePhase(steps, statusToolKey) ?? stickyPhase;
        if (detected) stickyPhase = detected;
        return translateToolIdsToKeys(resolvePhaseTools(input.agentId, detected), idToKey);
      };

      // Mastra ProcessInputStepArgs → ProcessInputStepResult (loop-based generate()).
      generateOptions.prepareStep = async (args: Record<string, unknown>) => {
        // LIVENESS — the model is about to take another step, so the run is
        // alive. Touching here (not only on step completion) means a long single
        // step is bounded by the idle window from its START, while an agent that
        // keeps stepping is never cut for duration.
        if (harnessContext?.runId) touchRunLiveness(harnessContext.runId);
        try {
          const stepNumber = typeof args.stepNumber === 'number' ? args.stepNumber : 0;
          const rawSteps = Array.isArray(args.steps) ? args.steps as Array<Record<string, unknown>> : [];
          const systemMessages = Array.isArray(args.systemMessages)
            ? args.systemMessages as Array<Record<string, unknown>>
            : [];
          const suppliedTools = args.tools && typeof args.tools === 'object'
            ? args.tools as Record<string, unknown>
            : {};
          // Deterministic harness fixtures and older Mastra paths may omit
          // args.tools. Preserve the pre-shelf phase behavior with the registry
          // captured above; real 1.32 loop calls provide the dynamic map here.
          const currentTools = Object.keys(suppliedTools).length > 0
            ? suppliedTools
            : Object.fromEntries(
              [...new Set([...toolUniverse, ...workspaceToolNames])].map((name) => [name, {}]),
            );
          const currentToolUniverse = Object.keys(currentTools);
          const incomingActiveTools = Array.isArray(args.activeTools)
            ? args.activeTools.filter((name): name is string => typeof name === 'string')
            : undefined;
          const currentIdToKey = {
            ...idToKey,
            ...buildToolIdToKeyMap(currentTools as never),
          };

          // W1 — recomputed EVERY step, because a pipeline agent's phase changes
          // mid-run and a value fixed before the run cannot follow it. Identical
          // to the previous behaviour for every non-pipeline agent (same static
          // `input.phase`, same call), which is asserted rather than assumed.
          const phaseAllow = resolvePhaseAllow(normalizeStepsForReflector(rawSteps));

          // Sample current goal progress (cheap findOne) so progress_stall can
          // observe the delta over the recent window. Best-effort: failures here
          // never block the reflector.
          if (goalTriggersEnabled && input.goalContractId) {
            try {
              const contract = await getGoalContract(input.goalContractId);
              if (contract && typeof contract.currentProgress === 'number') {
                progressSamples.push(contract.currentProgress);
              }
            } catch {
              /* non-fatal — skip this sample */
            }
          }

          // Apply the per-phase Golden Path allowlist regardless of anomaly, so a
          // healthy run is still channeled to its phase tools. Emit telemetry once.
          const phaseResult: Record<string, unknown> = {};
          // The headless withholding composes with the phase channel rather than
          // replacing it: a phase allowlist is already a subset, so the only job
          // left is to make sure a suspending tool cannot re-enter through it.
          let composedActiveTools = incomingActiveTools;
          if (phaseAllow && phaseAllow.length > 0) {
            composedActiveTools = intersectTransientActiveTools(
              currentTools,
              composedActiveTools,
              phaseAllow,
            );
          }
          if (headlessAllow) {
            composedActiveTools = intersectTransientActiveTools(
              currentTools,
              composedActiveTools,
              headlessAllow,
            );
          }
          if (composedActiveTools && composedActiveTools.length > 0) {
            phaseResult.activeTools = composedActiveTools;
          }
          if (phaseAllow && phaseAllow.length > 0) {
            // A pipeline run changes phase as it goes, so "log once" would report
            // the first phase and hide every transition after it — the run would
            // look stuck in `recon` while it was actually working. Log on CHANGE
            // for pipeline agents; keep the once-per-run shape for everyone else,
            // whose phase genuinely cannot change.
            const phaseNow = pipelineAgent ? stickyPhase : input.phase;
            const shouldLog = pipelineAgent
              ? phaseNow !== lastLoggedPhase
              : !phaseToolsLogged;
            if (shouldLog) {
              phaseToolsLogged = true;
              lastLoggedPhase = phaseNow ?? null;
              void logHarnessEvent({
                type: 'pipeline_phase_tools_applied',
                agentId: input.agentId,
                runId: ctx.runId,
                turnId: ctx.turnId,
                threadId: ctx.threadId,
                taskId: input.taskId,
                subtaskId: input.subtaskId,
                feature: 'pipeline_phase_tools',
                status: 'success',
                data: { phase: phaseNow, toolCount: phaseAllow.length, stepNumber },
              });
            }
          }

          // ── finalize-on-deliverable (Lever 2): force the final report ──
          // Once the Golden Path latched a terminal-for-brief deliverable
          // (tested without an activation brief, or active), stop tool work and
          // make the model write its final report on THIS step. Independent of the
          // reflector's nag budget — this is exactly the clean-run failure mode the
          // budget-gated convergence misses (deliverable exists, 0 interventions,
          // run hangs to the timeout). The deliverable-aware completion scorer
          // (Lever 1) then finalizes on the resulting report. Fires before the
          // reflector logic so a successful terminal is never re-nagged into churn.
          const automationDeliverable = getAutomationDeliverableDetails();
          if (automationFinalizeEnabled()
            && shouldForceAutomationReport(
              automationDeliverable?.status ?? null,
              ctx.originalPrompt,
              automationDeliverable?.testMode,
            )) {
            void logHarnessEvent({
              type: 'automation_finalize_forced' as any,
              agentId: input.agentId,
              runId: ctx.runId,
              turnId: ctx.turnId,
              threadId: ctx.threadId,
              taskId: input.taskId,
              subtaskId: input.subtaskId,
              feature: 'automation_finalize',
              status: 'success',
              data: {
                deliverableStatus: automationDeliverable?.status ?? null,
                testMode: automationDeliverable?.testMode ?? null,
                stepNumber,
              },
            });
            return {
              ...phaseResult,
              toolChoice: 'none',
              systemMessages: [
                ...systemMessages,
                { role: 'system', content: AUTOMATION_REPORT_NOW_INSTRUCTION },
              ],
            };
          }

          const decision = reflector.evaluateHistory(normalizeSteps(rawSteps), {
            goalTriggersEnabled,
            progressSamples,
            // W2 — a pipeline agent gets SOFT levers only, the same profile the
            // legacy wrapper gives it. Hard levers (forced no-tool steps, forced
            // convergence) assume a short goal-directed turn; applied to a
            // 150-step state machine they cut it off mid-phase, which is the
            // failure the legacy wrapper's header warns about in prose. The
            // reflector already implements this distinction — it was simply never
            // told, because until now no pipeline agent reached the harness.
            pipelineMode: pipelineAgent,
            ...(pipelineAgent && statusToolKey ? { statusToolName: statusToolKey } : {}),
            ...(pipelineAgent && phaseAllow ? { phaseTools: phaseAllow } : {}),
            hardLeversEnabled,
            convergenceEnabled,
            suppressScopeCreep: input.agentId === AUTOMATION_ARCHITECT_AGENT_ID,
          });
          if (decision.action !== 'inject_reflection' || !decision.intervention || !decision.signal) {
            // No anomaly → still apply the phase allowlist if we have one.
            return Object.keys(phaseResult).length > 0 ? phaseResult : undefined;
          }

          // The allowlist that removes `dropTools` from whatever base applies —
          // the phase allowlist when there is one, otherwise the full universe.
          // Returns null when it could not build one that actually removes the
          // tool AND leaves something callable.
          const allowlistWithout = (dropTools: string[] | undefined): string[] | null => {
            if (!dropTools?.length) return null;
            const base = Array.isArray(phaseResult.activeTools)
              ? phaseResult.activeTools as string[]
              : incomingActiveTools ?? currentToolUniverse;
            // ⚠️ Naming boundary: the reflector reports the tool's runtime id,
            // `activeTools` is keyed on the registry KEY. Translate or the filter
            // matches nothing and the lever silently no-ops.
            const dropKeys = new Set(dropTools.map((t) => currentIdToKey[t] ?? t));
            const allow = base.filter((t) => !dropKeys.has(t));
            return base.length > 0 && allow.length < base.length && allow.length > 0 ? allow : null;
          };

          // Per-run intervention budget (reuse depth profile's maxReflectionsPerRun).
          if (reflector.isReflectionBudgetExhausted()) {
            // Convergence keeps priority: when a usable deliverable already
            // exists, finalizing beats any tool surgery.
            if (convergenceEnabled && reflector.shouldConvergeStop(normalizeSteps(rawSteps))) {
              return {
                ...phaseResult,
                toolChoice: 'none',
                systemMessages: [
                  ...systemMessages,
                  {
                    role: 'system',
                    content:
                      'The strategy reflector has already seen enough evidence to finalize this task. '
                      + 'Do not call tools. Produce the final answer from existing results now.',
                  },
                ],
              };
            }
            // Otherwise: the budget limits NAGGING, not the withdrawal of a tool
            // that is provably failing. A pipeline run has 150 steps and a budget
            // of three, so it is spent long before the late phases — past that
            // point nothing could stop a loop at all. Measured 2026-08-19: chef
            // called `chef_draft_recipe` 145 times with empty arguments, every
            // call rejected identically, from a run whose budget was already
            // gone. Dropping the offending tool for one step costs nothing and
            // adds no text, so it stays available when the nag budget does not.
            const forced = allowlistWithout(decision.intervention.dropTools);
            if (forced) {
              return { ...phaseResult, activeTools: forced };
            }
            return Object.keys(phaseResult).length > 0 ? phaseResult : undefined;
          }

          // §2.4 per-signal cooldown/hysteresis: the SAME signal must wait
          // `interventionCooldownSteps` before re-firing (gives the model room to
          // regenerate), but a DIFFERENT, higher-priority signal can intervene on
          // the next step. Replaces the prior single global step-gap lock.
          if (reflector.isSignalInCooldown(decision.signal, stepNumber)) {
            // Cooldown silences the NAG, not the withdrawal — the same rule the
            // budget-exhausted branch above already follows. Returning the bare
            // `phaseResult` here handed the looping tool straight BACK on every
            // step the cooldown covered, so the lever oscillated instead of
            // latching and the model simply waited one step before calling it
            // again. Measured 2026-08-24 on automationArchitect (run
            // delegation-cd136dd3): `tool_loop` fired at steps 12/14/16/18/20/22/24
            // — the even steps are exactly the cooldown gaps — while
            // `mastra_workspace_execute_command` climbed from 3 to 12 calls.
            // Holding the drop costs no tokens and adds no text, and it is
            // bounded by `interventionCooldownSteps`: once the cooldown expires
            // the signal is re-evaluated from scratch, so a tool that is no
            // longer looping comes back on its own.
            const held = allowlistWithout(decision.intervention.dropTools);
            if (held) {
              return { ...phaseResult, activeTools: held };
            }
            return Object.keys(phaseResult).length > 0 ? phaseResult : undefined;
          }

          // Record the intervention so post-run passes + telemetry see it
          // (also stamps the per-signal cooldown clock).
          reflector.recordIntervention(decision, stepNumber);

          const iv = decision.intervention;
          // Seed with the per-phase allowlist so the reflector's levers compose
          // ON TOP of the Golden Path channeling (dropTools filters from it below).
          const result: Record<string, unknown> = { ...phaseResult };
          const appliedLevers: string[] = [];

          // Inject reflection by READ existing systemMessages + APPEND ours.
          // ProcessInputStepResult.systemMessages REPLACES all system messages,
          // so we must rewrite the existing set + add the reflection, otherwise
          // the agent loses its base instructions.
          if (iv.injectSystem) {
            result.systemMessages = [...systemMessages, { role: 'system', content: iv.injectSystem }];
            appliedLevers.push('injectSystem');
          }

          if (iv.dropTools?.length) {
            // Only trust the allowlist when it ACTUALLY removed the looping tool
            // and left something callable (see `allowlistWithout`).
            const allow = allowlistWithout(iv.dropTools);
            if (allow) {
              result.activeTools = allow; // never leave an empty allowlist (deadlock guard)
              appliedLevers.push('dropTools');
            } else if (result.activeTools === undefined && !iv.forceNoTool) {
              // Could not build an allowlist that excludes the looping tool: either
              // there is no tool universe (listTools unavailable), or the looping
              // tool is not in the registry-controllable set (e.g. a workspace tool
              // like `view` surfaced outside listTools, so dropping it from
              // `activeTools` would not stop the call). Rather than silently no-op —
              // which lets the tool_loop run to the wall-clock timeout — force a
              // no-tool step so the model is forced to break the loop.
              result.toolChoice = 'none';
              appliedLevers.push('dropTools→forceNoTool(fallback)');
            }
          }

          if (iv.forceNoTool) {
            result.toolChoice = 'none';
            appliedLevers.push('forceNoTool');
          }

          // ── §2.5 hard levers (only present when FEATURE_REFLECTOR_HARD_LEVERS on) ──
          // restrictTools: curated allowlist (intersected with the real universe).
          if (iv.restrictTools?.length && currentToolUniverse.length > 0) {
            const restrictKeys = iv.restrictTools.map((name) => currentIdToKey[name] ?? name);
            const restrictionBase = Array.isArray(result.activeTools)
              ? result.activeTools as string[]
              : incomingActiveTools;
            const allow = intersectTransientActiveTools(
              currentTools,
              restrictionBase,
              restrictKeys,
            ) ?? [];
            if (allow.length > 0) {
              result.activeTools = allow;
              appliedLevers.push('restrictTools');
            }
          }

          // forceTool: pin toolChoice to a specific tool (e.g. human approval).
          // Only if it exists and we are not already forcing no-tool.
          const forcedToolKey = iv.forceTool ? (currentIdToKey[iv.forceTool] ?? iv.forceTool) : undefined;
          const activeForForce = Array.isArray(result.activeTools)
            ? result.activeTools as string[]
            : incomingActiveTools ?? currentToolUniverse;
          if (forcedToolKey && result.toolChoice === undefined && activeForForce.includes(forcedToolKey)) {
            result.toolChoice = { type: 'tool', toolName: forcedToolKey };
            appliedLevers.push('forceTool');
          }

          // escalateModel: override the model for this one repair step. No-op
          // unless an escalation model is configured.
          if (iv.escalateModel && escalationModel) {
            result.model = escalationModel;
            appliedLevers.push('escalateModel');
          }

          void logHarnessEvent({
            type: 'reflector_intervention',
            agentId: input.agentId,
            runId: ctx.runId,
            turnId: ctx.turnId,
            threadId: ctx.threadId,
            taskId: input.taskId,
            subtaskId: input.subtaskId,
            feature: 'strategy_reflector',
            status: 'success',
            data: {
              signal: decision.signal,
              reason: decision.reason,
              stepNumber,
              appliedLevers,
              droppedTools: iv.dropTools,
              forcedTool: appliedLevers.includes('forceTool') ? iv.forceTool : undefined,
              escalatedModel: appliedLevers.includes('escalateModel') ? escalationModel : undefined,
            },
          });

          return result;
        } catch (err) {
          // The reflector must NEVER break agent execution → no-op on any error.
          console.warn('[Harness] prepareStep reflector error (non-fatal):', (err as Error).message);
          return undefined;
        }
      };
    }

    // ── Part 2 §2.6: stopWhen — know when to give up and escalate ──
    // A custom StopCondition (`({ steps }) => boolean | Promise<boolean>`) that
    // ends the run early when the trajectory is unrecoverable, instead of
    // burning the rest of maxSteps to feign success.
    //
    // IMPORTANT (Mastra 1.32 quirk): when `maxSteps` is a number, Mastra REPLACES
    // any user `stopWhen` with `stepCountIs(maxSteps)` — they are mutually
    // exclusive. To keep BOTH the step-count backstop AND our predicate we pass
    // `stopWhen` as an ARRAY (OR semantics: any true stops) and DROP the
    // `maxSteps` key so Mastra honors the array. `stepCountIs` is from the `ai`
    // package (not exported by @mastra/core).
    const stopWhenEnabled =
      reflectorEnabled && isHarnessFeatureEnabled('FEATURE_REFLECTOR_STOP_WHEN', true);
    if (stopWhenEnabled) {
      const stepCeiling = typeof generateOptions.maxSteps === 'number'
        ? generateOptions.maxSteps as number
        : getEffectiveProfile(ctx.runId).maxSteps;
      delete generateOptions.maxSteps; // otherwise Mastra ignores the custom stopWhen
      const unrecoverableStop = async (args: Record<string, unknown>) => {
        try {
          const rawSteps = Array.isArray(args.steps) ? args.steps as Array<Record<string, unknown>> : [];
          if (!reflector.isUnrecoverable(normalizeSteps(rawSteps))) return false;

          const blocker =
            'Run stopped early by the strategy reflector: the trajectory is unrecoverable '
            + '(repeated failures / catastrophic loop / failed delegations past the recovery threshold). '
            + 'Escalate to a human or re-scope the task instead of retrying the same approach.';
          stopWhenBlocker = blocker;
          // Also record it run-scoped: the response stamped below is the first
          // of several passes, and a later one replaces it (see runStopBlockers).
          runStopBlockers.set(ctx.runId, blocker);

          void logHarnessEvent({
            type: 'reflector_stop_when',
            agentId: input.agentId,
            runId: ctx.runId,
            turnId: ctx.turnId,
            threadId: ctx.threadId,
            taskId: input.taskId,
            subtaskId: input.subtaskId,
            feature: 'strategy_reflector',
            status: 'error',
            data: {
              reason: blocker,
              stepCount: rawSteps.length,
            },
          });
          return true;
        } catch (err) {
          // Never let the stop predicate break execution → keep running on error.
          console.warn('[Harness] stopWhen reflector error (non-fatal):', (err as Error).message);
          return false;
        }
      };
      // §A — graceful convergence stop. Distinct from `unrecoverableStop`: this
      // ends a SUCCESSFUL-but-churning run (a usable deliverable already exists,
      // the reflector spent its nag budget, low error rate) so the best answer is
      // returned verbatim — NO error blocker is stamped. This overrides the
      // never-passing completion scorer that would otherwise re-iterate to the
      // wall-clock timeout. Gated by FEATURE_REFLECTOR_CONVERGENCE.
      const convergenceStopEnabled = isHarnessFeatureEnabled('FEATURE_REFLECTOR_CONVERGENCE', true);
      const convergenceStop = async (args: Record<string, unknown>) => {
        try {
          if (!convergenceStopEnabled) return false;
          const rawSteps = Array.isArray(args.steps) ? args.steps as Array<Record<string, unknown>> : [];
          if (!reflector.shouldConvergeStop(normalizeSteps(rawSteps))) return false;
          void logHarnessEvent({
            type: 'reflector_convergence_stop',
            agentId: input.agentId,
            runId: ctx.runId,
            turnId: ctx.turnId,
            threadId: ctx.threadId,
            taskId: input.taskId,
            subtaskId: input.subtaskId,
            feature: 'strategy_reflector',
            status: 'success',
            data: {
              reason: 'Deliverable already available + reflection budget exhausted — finalizing instead of churning to timeout.',
              stepCount: rawSteps.length,
            },
          });
          return true;
        } catch (err) {
          console.warn('[Harness] convergence stop error (non-fatal):', (err as Error).message);
          return false;
        }
      };
      // ── finalize-on-deliverable (Lever 3): stopWhen backstop. ──
      // Ends the loop when a Golden Path deliverable (tested/active) exists AND a
      // terminal report is already on the last step — independent of the reflector
      // budget AND of whether isTaskComplete actually drives the loop (Mastra 1.32
      // quirk). Because it only stops once a report is present, there is no
      // empty-final-text risk (the handoff's stopWhen caveat). Redundant with Lever
      // 1 by design: if the completion scorer finalizes first, this never fires.
      const automationFinalizeStop = async (args: Record<string, unknown>) => {
        try {
          if (!automationFinalizeEnabled()) return false;
          const status = getAutomationDeliverableStatus();
          if (status !== 'tested' && status !== 'active') return false;
          const rawSteps = Array.isArray(args.steps) ? args.steps as Array<Record<string, unknown>> : [];
          if (!looksLikeAutomationReport(lastReflectorStepText(normalizeSteps(rawSteps)))) return false;
          void logHarnessEvent({
            type: 'automation_finalize_stop' as any,
            agentId: input.agentId,
            runId: ctx.runId,
            turnId: ctx.turnId,
            threadId: ctx.threadId,
            taskId: input.taskId,
            subtaskId: input.subtaskId,
            feature: 'automation_finalize',
            status: 'success',
            data: { deliverableStatus: status, stepCount: rawSteps.length },
          });
          return true;
        } catch (err) {
          console.warn('[Harness] automation finalize stop error (non-fatal):', (err as Error).message);
          return false;
        }
      };
      // OR-array: step-count backstop (replaces the dropped maxSteps) + predicates.
      generateOptions.stopWhen = [stepCountIs(stepCeiling), unrecoverableStop, convergenceStop, automationFinalizeStop];
    }

    // ── Part 2 §2.7: native output scoring (isTaskComplete) ──
    // After each iteration Mastra runs the completion scorer; when it returns 0
    // (incomplete) Mastra auto-injects feedback into the message list (the model
    // sees WHY it is not done) and re-iterates until the scorer passes or the
    // step budget is hit. We only supply the pass/fail definition (the GoalContract
    // scorer); the iteration + feedback plumbing is the framework's. There is no
    // `maxIterations` field on CompletionConfig in Mastra 1.32 — the existing
    // `maxSteps` / stopWhen step ceiling already bounds the loop.
    const outputScoringEnabled =
      isHarnessFeatureEnabled('FEATURE_OUTPUT_SCORING', true) && !!input.goalContractId;
    if (outputScoringEnabled && input.goalContractId) {
      const goalContractId = input.goalContractId;
      generateOptions.isTaskComplete = {
        scorers: [createGoalCompletionScorer(goalContractId, {
          autoFinalizeOnOutput: true,
          autoFinalizeOnAutomationDeliverable: input.agentId === AUTOMATION_ARCHITECT_AGENT_ID,
        })],
        strategy: 'all' as const,
        onComplete: (r: { complete?: boolean; completionReason?: string; scorers?: unknown[] }) => {
          void logHarnessEvent({
            type: 'output_score',
            agentId: input.agentId,
            runId: ctx.runId,
            turnId: ctx.turnId,
            threadId: ctx.threadId,
            taskId: input.taskId,
            subtaskId: input.subtaskId,
            feature: 'strategy_reflector',
            status: r.complete ? 'success' : 'pending',
            data: {
              goalContractId,
              complete: r.complete,
              completionReason: r.completionReason,
              scorerCount: Array.isArray(r.scorers) ? r.scorers.length : 0,
            },
          });
        },
      };
    }
  }

  if (
    generateOptions.requestContext &&
    typeof (generateOptions.requestContext as any).get !== 'function' &&
    typeof generateOptions.requestContext === 'object'
  ) {
    const normalizedRc = new RequestContext();
    for (const [key, value] of Object.entries(generateOptions.requestContext as Record<string, unknown>)) {
      normalizedRc.set(key, value);
    }
    generateOptions.requestContext = normalizedRc;
  }

  console.log(`[Harness] callAgentGenerate: maxSteps=${generateOptions.maxSteps ?? 'via-stopWhen'}, thinkingTier=${effectiveProfile.thinkingTier}, model=${generateOptions.model ?? 'agent-default'}, memory=${!!generateOptions.memory}, keys=${Object.keys(generateOptions).join(',')}`);

  // WS-A — make the harness LLM call abortable. A bare Promise.race timeout
  // cancels the WAIT but not the WORK: the losing agent.generate keeps running
  // as an orphaned ("zombie") run that burns compute and can still mutate
  // n8n/Mongo after the caller already failed. We install an AbortController,
  // feed its signal into generateOptions (combined with any external caller
  // signal), and trip it when the timeout fires.
  //
  // F3 — the controller is created BEFORE the execution context so the composed
  // signal can be published on it. Tools running inside the model loop (notably
  // `delegate-task`) never receive harness arguments, so the context is the only
  // way for a child to learn that its parent was aborted.
  const harnessAbort = new AbortController();
  const composedAbortSignal = input.abortSignal
    ? AbortSignal.any([harnessAbort.signal, input.abortSignal])
    : harnessAbort.signal;
  generateOptions.abortSignal = composedAbortSignal;

  // Mastra 1.32 does not forward AI SDK's experimental_onToolCallStart option.
  // Install a request-scoped input-step processor instead: it receives Mastra's
  // fully converted tool map (including ambient workspace/skill tools) and
  // fences the real `execute` boundary against this run's composed signal.
  const explicitInputProcessors = Array.isArray(generateOptions.inputProcessors)
    ? generateOptions.inputProcessors
    : undefined;
  const configuredInputProcessors = explicitInputProcessors
    ?? (typeof input.agent.listConfiguredInputProcessors === 'function'
      ? await input.agent.listConfiguredInputProcessors(generateOptions.requestContext as any)
      : []);
  generateOptions.inputProcessors = [
    ...configuredInputProcessors,
    createHarnessAbortToolFenceProcessor(composedAbortSignal),
  ];

  return runWithHarnessExecutionContext(
    {
      agentId: input.agentId,
      runId: harnessContext?.runId,
      turnId: harnessContext?.turnId,
      threadId: harnessContext?.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      artifactLease: input.artifactLease,
      abortSignal: composedAbortSignal,
    },
    async () => {

      let response: TResponse | undefined;
      const modelCandidates = [
        effectiveModelId,
        ...fallbackChainForAgent(input.agentId).filter((m) => m !== effectiveModelId),
      ].filter(Boolean) as string[];

      let lastError: unknown;

      for (let i = 0; i < modelCandidates.length; i++) {
        const currentModel = modelCandidates[i];
        const isFallbackAttempt = i > 0;
        const currentOptions = isFallbackAttempt
          ? { ...generateOptions, model: currentModel }
          : generateOptions;

        if (isFallbackAttempt) {
          console.warn(
            `[Harness] Model fallback activated: switching to ${currentModel} for agent=${input.agentId} (attempt ${i + 1}/${modelCandidates.length})`,
          );
        }

        const call = input.agent.generate(input.prompt, currentOptions as any); // @harness-exempt - this file is the harness gateway
        try {
          // LIVENESS runs are bounded by silence + hard cap instead of a fixed
          // wall-clock; `getRunLivenessState` returning undefined (DEADLINE run)
          // makes the guard a pass-through, so the branch is decided by the
          // registry rather than by a second copy of the flag.
          const activeRunId = harnessContext?.runId;
          const livenessState = activeRunId ? getRunLivenessState(activeRunId) : undefined;
          response = activeRunId && livenessState
            ? await withLivenessGuard(
                call as Promise<TResponse>,
                activeRunId,
                () => harnessAbort.abort(new Error('harness_liveness_cut')),
              )
            : await withDeadlineGuard(
                call as Promise<TResponse>,
                activeRunId,
                input.timeoutMs,
                `Harness LLM call timed out after ${(input.timeoutMs ?? 0) / 1000}s`,
                () => harnessAbort.abort(new Error('harness_timeout')),
              );

          if (
            response
            && typeof response === 'object'
            && (response as Record<string, unknown>).finishReason === 'error'
            && !(response as Record<string, unknown>).text
          ) {
            throw new Error(`Model ${currentModel} stream failed with finishReason "error" and empty content`);
          }

          effectiveModelId = currentModel;
          break;
        } catch (err) {
          lastError = err;
          // loop_fix.md P1 — feed the circuit breaker so a model that repeatedly
          // times out (e.g. an unavailable/slow provider) opens its circuit and
          // future runs route around it via the health gate.
          if (currentModel && isHarnessFeatureEnabled('FEATURE_MODEL_HEALTH_GATE', false)) {
            getCircuitBreaker().recordFailure(currentModel);
          }
          if (composedAbortSignal.aborted) {
            throw err;
          }
          console.warn(`[Harness] Model ${currentModel} call failed for agent=${input.agentId}: ${(err as Error).message}`);
        }
      }

      if (!response) {
        throw lastError ?? new Error(`All model candidates in fallback chain failed for agent=${input.agentId}`);
      }

      // F3 live-verify finding — Mastra's `agent.generate` does NOT reject when
      // its abortSignal fires: it RESOLVES with `finishReason: 'tripwire'` and
      // empty content (confirmed against a real Ollama call: the real HTTP call
      // genuinely stops in ~80ms, well short of full generation, so the abort
      // worked — it just never surfaces as a rejection). Both `withTimeout` and
      // `withLivenessGuard` race their OWN explicit reject against this call, so
      // the harness's OWN timeout/idle/hard-cap cuts are unaffected — but an
      // EXTERNAL abort (a cancelled/timed-out PARENT run, composed in via
      // `input.abortSignal`/`composedAbortSignal`) has no such competing reject:
      // if it fires before the harness's own deadline, `response` above is
      // exactly this hollow tripwire result, and every sync delegation
      // (coding/knowledge/automation, and pipeline before its own fix) would
      // silently report SUCCESS with nothing to say instead of a cancellation.
      // Detecting both together (never one alone) means a genuine content-
      // safety tripwire with no abort involved is still reported honestly.
      if (
        response
        && typeof response === 'object'
        && (response as Record<string, unknown>).finishReason === 'tripwire'
        && composedAbortSignal.aborted
      ) {
        const reason = composedAbortSignal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason ?? 'harness_call_aborted'));
      }

      if (effectiveModelId && isHarnessFeatureEnabled('FEATURE_MODEL_HEALTH_GATE', false)) {
        getCircuitBreaker().recordSuccess(effectiveModelId);
      }

      // §2.6 — if stopWhen halted the run as unrecoverable, surface the blocker
      // on the response text (best-effort, guarded) so callers see an explicit
      // escalation note rather than a truncated, falsely-successful answer.
      if (stopWhenBlocker && response && typeof response === 'object') {
        const record = response as Record<string, unknown>;
        if (typeof record.text === 'string') {
          const prefix = record.text.trim().length > 0 ? `${record.text}\n\n` : '';
          record.text = `${prefix}⚠️ ${stopWhenBlocker}`;
        }
      }
      if (automationFinalizeEnabled() && input.agentId === AUTOMATION_ARCHITECT_AGENT_ID && response && typeof response === 'object') {
        const details = getAutomationDeliverableDetails();
        if (details && (details.status === 'tested' || details.status === 'active')) {
          const record = response as Record<string, unknown>;
          const deterministicReport = formatAutomationDeliverableReport(details);
          if (typeof record.text === 'string') {
            const existing = record.text;
            if (
              !looksLikeAutomationReport(existing)
              || /\bpending approval|ready for deployment|has not yet been deployed|not yet been deployed\b/i.test(existing)
            ) {
              record.text = deterministicReport;
            }
          } else {
            record.text = deterministicReport;
          }
        }
      }
      return response;
    },
  );
}

type NormalizedToolCall = {
  toolCallId: string;
  toolName: string;
  args: unknown;
};

type NormalizedToolResult = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

type ReflectorHistoryStep = {
  toolCalls?: Array<{ toolName: string; args?: unknown }>;
  toolResults?: Array<{ toolName: string; result?: unknown; isError?: boolean }>;
  stepText?: string;
};

/**
 * Adapt Mastra `StepResult[]` (as received by `prepareStep`) into the
 * reflector's `StepHistoryInput[]`.
 *
 * IMPORTANT: inside the `prepareStep` processor, each `StepResult`'s convenience
 * getters (`step.toolCalls` / `step.toolResults` / `step.content`) are EMPTY —
 * the authoritative tool record lives in `step.response.messages[]` as
 * `tool-call` (assistant) and `tool-result` (tool) content parts. We therefore
 * read from `response.messages`, dedupe by `toolCallId` (later steps re-include
 * earlier messages), and rebuild one history entry per unique tool call so the
 * reflector's loop/error/repetition signals fire correctly. Top-level
 * `toolCalls`/`toolResults` are still honored as a fallback (e.g. onStepFinish
 * shape, or future Mastra versions that populate them).
 */
function normalizeSteps(steps: Array<Record<string, unknown>>): ReflectorHistoryStep[] {
  // Fallback path: if any step exposes populated top-level toolCalls, use the
  // per-step shape directly (keeps step granularity).
  const hasTopLevelToolCalls = steps.some(
    (step) => Array.isArray(step.toolCalls) && (step.toolCalls as unknown[]).length > 0,
  );
  if (hasTopLevelToolCalls) {
    return steps.map((step) => {
      const rawToolCalls = Array.isArray(step.toolCalls) ? step.toolCalls as Array<Record<string, unknown>> : [];
      const rawToolResults = Array.isArray(step.toolResults) ? step.toolResults as Array<Record<string, unknown>> : [];
      const toolCalls = rawToolCalls.map(normalizeToolCall);
      const toolResults = rawToolResults.map((tr) => normalizeToolResult(tr, toolCalls));
      return {
        toolCalls: toolCalls.map((tc) => ({ toolName: tc.toolName, args: tc.args })),
        toolResults: toolResults.map((tr) => ({ toolName: tr.toolName, result: tr.result, isError: tr.isError })),
        stepText: typeof step.text === 'string' ? step.text : undefined,
      };
    });
  }

  // Primary path: rebuild from response.messages, deduped by toolCallId.
  const callOrder: string[] = [];
  const calls = new Map<string, { toolName: string; args: unknown }>();
  const results = new Map<string, { toolName: string; result: unknown; isError: boolean }>();
  const texts: string[] = [];

  for (const step of steps) {
    const response = asRecord(step.response);
    const messages = Array.isArray(response?.messages) ? response!.messages as Array<Record<string, unknown>> : [];
    for (const message of messages) {
      const content = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
      for (const part of content) {
        if (part.type === 'tool-call') {
          const id = String(part.toolCallId ?? '');
          if (!id) continue;
          if (!calls.has(id)) callOrder.push(id);
          calls.set(id, {
            toolName: String(part.toolName ?? ''),
            args: part.input ?? part.args ?? {},
          });
        } else if (part.type === 'tool-result') {
          const id = String(part.toolCallId ?? '');
          if (!id) continue;
          const output = asRecord(part.output);
          const isError = output?.type === 'error-text' || output?.type === 'error-json' || part.isError === true;
          results.set(id, {
            toolName: String(part.toolName ?? ''),
            result: output?.value ?? part.output ?? part.result,
            isError,
          });
        } else if (part.type === 'text' && typeof part.text === 'string') {
          texts.push(part.text);
        }
      }
    }
  }

  // One history step per unique tool call (preserves repetition/error counts),
  // with any trailing assistant text attached to the last step for low-confidence scans.
  const history: ReflectorHistoryStep[] = callOrder.map((id, idx) => {
    const call = calls.get(id)!;
    const result = results.get(id);
    return {
      toolCalls: [{ toolName: call.toolName, args: call.args }],
      toolResults: result ? [{ toolName: result.toolName, result: result.result, isError: result.isError }] : [],
      stepText: idx === callOrder.length - 1 && texts.length > 0 ? texts[texts.length - 1] : undefined,
    };
  });

  if (history.length === 0 && texts.length > 0) {
    return [{ toolCalls: [], toolResults: [], stepText: texts[texts.length - 1] }];
  }
  return history;
}

/** Exported for the deterministic prepareStep E2E (e2e-reflector-prepare-step.ts). */
export const normalizeStepsForReflector = normalizeSteps;

/**
 * finalize-on-deliverable (Lever 3) — the most recent non-empty assistant text from
 * normalized step history. `normalizeSteps` attaches trailing assistant text to the
 * last history entry, so scan backwards for the first populated `stepText`.
 */
function lastReflectorStepText(history: ReflectorHistoryStep[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const text = history[i]?.stepText;
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  return '';
}

function normalizeToolCall(toolCall: Record<string, unknown>): NormalizedToolCall {
  const payload = asRecord(toolCall.payload);
  return {
    toolCallId: String(toolCall.toolCallId ?? payload?.toolCallId ?? ''),
    toolName: String(payload?.toolName ?? toolCall.toolName ?? toolCall.name ?? ''),
    // ⚠️ AI SDK v5 carries tool-call arguments under `input`; older / message
    // shapes use `args`. The fallback `normalizeSteps` path (top-level
    // `step.toolCalls`) MUST read `input` first, otherwise args come back `{}`
    // and downstream consumers (phase detection via `args.status`, arg-based
    // reflector loop signals) go blind. This silently broke pipeline phase
    // telemetry after the first window compaction.
    args: payload?.input ?? payload?.args ?? toolCall.input ?? toolCall.args ?? {},
  };
}

function normalizeToolResult(
  toolResult: Record<string, unknown>,
  toolCalls: NormalizedToolCall[],
): NormalizedToolResult {
  const payload = asRecord(toolResult.payload);
  const toolCallId = String(toolResult.toolCallId ?? payload?.toolCallId ?? '');
  const matchingCall = toolCalls.find((tc) => tc.toolCallId === toolCallId);
  // AI SDK v5 nests the result under `output` (sometimes `output.value`); older
  // shapes use `result`. Unwrap so result-based detection (e.g. a status tool's
  // returned `{ status }`) and error scans work in both shapes.
  const rawOutput = payload?.output ?? toolResult.output ?? payload?.result ?? toolResult.result;
  const unwrapped = asRecord(rawOutput);
  const result = unwrapped && 'value' in unwrapped ? unwrapped.value : rawOutput;
  const outType = unwrapped?.type;
  return {
    toolCallId,
    toolName: String(payload?.toolName ?? toolResult.toolName ?? toolResult.name ?? matchingCall?.toolName ?? ''),
    result,
    isError:
      toolResult.isError === true ||
      payload?.isError === true ||
      outType === 'error-text' ||
      outType === 'error-json' ||
      // §P2b.1 — a tool-input validation failure (Mastra schema guard or strict
      // MCP schema rejection, e.g. snake_case vs camelCase param names) may land
      // as an ordinary string/object result WITHOUT an error envelope. Count it
      // as an error so the reflector's error-rate + loop machinery sees it early
      // instead of waiting for the raw repetition ceiling.
      isValidationFailureResult(result),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

async function withTimeoutLocal<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

async function ensureHarnessGoalContract(input: {
  goalContractId?: string;
  taskId: string;
  agentId: string;
  prompt: string;
  phase: HarnessPhase;
  depthProfile: DepthProfile;
}): Promise<GoalContract | null> {
  try {
    let contract = input.goalContractId
      ? await getGoalContract(input.goalContractId)
      : await getActiveContractForTask(input.taskId);

    let plannedSteps = buildHarnessPlannedSteps(input);
    if (
      input.depthProfile.planning === 'persisted'
      && isHarnessFeatureEnabled('FEATURE_HARNESS_DETERMINISTIC_PLAN', true)
    ) {
      try {
        const plan = await withTimeoutLocal(
          generatePlan({
            goal: input.prompt.slice(0, 1000),
            context: `Agent: ${input.agentId}, Phase: ${input.phase}, Depth: ${input.depthProfile.level}`,
          }),
          20_000,
          'GoalContract deterministic DAG plan generation timed out (20s cap)',
        );
        if (plan && Array.isArray(plan.steps) && plan.steps.length > 0) {
          plannedSteps = plan.steps.map((s) => ({
            description: `[${s.id}] ${s.intent} (via ${s.toolOrAgent ?? input.agentId})${s.dependsOn && s.dependsOn.length > 0 ? ` [dependsOn: ${s.dependsOn.join(', ')}]` : ' [concurrent/independent]'}${s.executionType && s.executionType !== 'single_agent' ? ` [type: ${s.executionType}]` : ''} -> Success: ${s.successCheck}`,
            targetAgent: s.toolOrAgent ?? input.agentId,
          }));
        }
      } catch (planErr) {
        console.warn('[Harness] Deterministic DAG plan generation failed/timed out, using baseline template:', (planErr as Error).message);
      }
    }

    if (contract) {
      if (input.depthProfile.planning === 'persisted' && contract.plannedSteps.length === 0) {
        await recordPlanRevision(
          contract.contractId,
          plannedSteps,
          `Depth profile ${input.depthProfile.level} requires persisted planning.`,
        );
        contract = await getGoalContract(contract.contractId) ?? contract;
      }
      return contract;
    }

    return await createGoalContract({
      taskId: input.taskId,
      agentId: input.agentId,
      originalGoal: truncateForEvidence(input.prompt, 1000),
      plannedSteps,
      successCriteria: buildHarnessSuccessCriteria(input),
    });
  } catch (error) {
    console.warn('[Harness] GoalContract auto-ensure failed:', (error as Error).message);
    return null;
  }
}

function buildHarnessPlannedSteps(input: {
  agentId: string;
  phase: HarnessPhase;
  depthProfile: DepthProfile;
}): Array<{ description: string; targetAgent: string }> {
  const steps: Array<{ description: string; targetAgent: string }> = [
    {
      description: `Clarify the objective, constraints, and success criteria for phase "${input.phase}".`,
      targetAgent: input.agentId,
    },
    {
      description: 'Execute the task using available context, tools, and recorded evidence.',
      targetAgent: input.agentId,
    },
    {
      description: 'Verify completion against the objective and report any blockers or missing evidence.',
      targetAgent: input.agentId,
    },
  ];

  if (input.depthProfile.autoReview) {
    steps.push({
      description: 'Run the critical-depth review gate before finalizing.',
      targetAgent: input.agentId,
    });
  }
  if (input.depthProfile.requireApproval) {
    steps.push({
      description: 'Require approval before any externally visible or destructive action.',
      targetAgent: input.agentId,
    });
  }

  return steps;
}

function buildHarnessSuccessCriteria(input: {
  depthProfile: DepthProfile;
}): string[] {
  const criteria = [
    'The final response addresses the original user request directly.',
    'Claims that depend on tools or runtime state are grounded in available evidence.',
    'Known blockers, missing evidence, or incomplete work are stated explicitly.',
  ];

  if (input.depthProfile.autoReview) {
    criteria.push('Critical-depth review has approved the output or identified required changes.');
  }
  if (input.depthProfile.requireApproval) {
    criteria.push('No externally visible or destructive action is performed without explicit approval.');
  }

  return criteria;
}

function formatDepthHeader(
  depthResult: ClassificationResult,
  depthProfile: DepthProfile,
  runtime: {
    effectiveTimeoutMs: number;
    /**
     * Present only when a precontext builder actually consumed it. Absent means
     * this run has no enforced context budget, and the header says nothing
     * rather than quoting a number the model would ration itself against.
     */
    effectiveContextMaxTokens?: number;
    /**
     * The ceiling the run ACTUALLY has, after `stepCeilingFor` raises it to the
     * agent's own declaration.
     *
     * This line used to print `depthProfile.maxSteps` while the two beside it
     * printed effective values, so a `fast` chefAgent run was told "Max steps:
     * 10" and given 150. The agent believed the header — it is the only budget
     * statement it can see — and rationed itself accordingly: 4 recipe cards for
     * 18 dishes, five sections left empty, finished in a third of its window.
     * A budget the runtime does not enforce is not a limit, it is a lie the
     * agent obeys.
     */
    effectiveMaxSteps: number;
    goalContractId?: string;
    contract?: GoalContract | null;
    /** P1 — set when this light turn runs inside a thread with heavier recent work. */
    threadHeavyLevel?: DepthLevel;
  },
): string {
  const signalSummary = depthResult.signals
    .slice(0, 6)
    .map((signal) => signal.matched ? `${signal.name}:${signal.matched}` : signal.name)
    .join(', ') || 'none';
  const instructions: string[] = [];

  if (runtime.threadHeavyLevel) {
    // P1 — the live failure mode: a 60s status turn resumed a critical task's
    // scraping and died mid-work with nothing persisted. Forbid that here.
    instructions.push(
      `This is a lightweight turn inside a heavier ongoing task (thread recently ran at ${runtime.threadHeavyLevel}). ` +
      'Report status only. Do NOT resume the multi-step work in this turn — ' +
      'either ask the user to say "kontynuuj"/"deleguj" (which restores the full budget), or use async delegation.',
    );
  }

  if (depthProfile.planning === 'skip') {
    instructions.push('Keep the answer direct. Do not produce an explicit plan unless the task becomes non-trivial or risky.');
  } else if (depthProfile.planning === 'inline') {
    instructions.push('Use a concise inline plan before execution when the task has multiple steps.');
  } else {
    instructions.push('Use persisted planning signals: keep success criteria visible and verify completion before the final response.');
  }

  if (depthProfile.goalContract) {
    instructions.push(runtime.goalContractId
      ? `Use GoalContract ${runtime.goalContractId} as the source of completion criteria and evidence.`
      : 'If a GoalContract is available in context, use it as the source of completion criteria and evidence.');
  }

  if (runtime.contract?.plannedSteps && runtime.contract.plannedSteps.length > 0) {
    instructions.push(
      'Active Execution Roadmap (DAG / Milestone Steps):\n' +
        runtime.contract.plannedSteps
          .map((step, idx) => `    ${idx + 1}. ${step.description}`)
          .join('\n'),
    );
  }

  if (depthProfile.autoDeliberation) {
    instructions.push('If evidence conflicts, direction changes repeatedly, or confidence becomes low, stop and request a deliberation/re-plan path instead of guessing.');
  }

  if (depthProfile.autoReview) {
    instructions.push('Before final response, run a strict self-review for completeness, tool-result grounding, and unresolved risks.');
  }

  if (depthProfile.requireApproval) {
    instructions.push('Do not perform externally visible or destructive actions without an explicit approval path.');
  }

  return [
    '## Execution Depth',
    `Level: ${depthProfile.level}`,
    `Score: ${depthResult.score.toFixed(2)}`,
    `Signals: ${signalSummary}`,
    `Max steps: ${runtime.effectiveMaxSteps}`,
    `Timeout: ${Math.round(runtime.effectiveTimeoutMs / 1000)}s`,
    ...(runtime.effectiveContextMaxTokens !== undefined
      ? [`Context budget: ${runtime.effectiveContextMaxTokens} tokens`]
      : []),
    `Planning: ${depthProfile.planning}`,
    `Reflector: ${depthProfile.reflector.enabled ? 'enabled' : 'disabled'}`,
    `Goal contract: ${depthProfile.goalContract ? 'enabled' : 'disabled'}${runtime.goalContractId ? ` (${runtime.goalContractId})` : ''}`,
    `Deliberation gate: ${depthProfile.autoDeliberation ? 'enabled' : 'disabled'}`,
    `Review gate: ${depthProfile.autoReview ? 'enabled' : 'disabled'}`,
    `Approval gate: ${depthProfile.requireApproval ? 'enabled' : 'disabled'}`,
    '',
    'Depth instructions:',
    ...instructions.map((instruction) => `- ${instruction}`),
  ].join('\n');
}

async function recordHarnessToolGoalEvidence(input: {
  goalContractId?: string;
  toolResults: NormalizedToolResult[];
}): Promise<void> {
  if (!input.goalContractId || input.toolResults.length === 0) return;

  const failed = input.toolResults.filter((result) => result.isError || isFailureResult(result.result));
  const toolNames = [...new Set(input.toolResults.map((result) => result.toolName).filter(Boolean))];

  try {
    // §2.1 — Do NOT fabricate a step status against a hardcoded `step-2`.
    // Tool evidence is recorded as plain for/against; `recalculateProgress`
    // derives granular sub-step progress from the net evidence balance, while
    // formal step completion is driven by the final-evidence pass. This avoids
    // pinning all in-run evidence to one synthetic step (which left
    // `currentProgress` flat and made progress-stall detection noisy).
    if (failed.length > 0) {
      await recordEvidence(input.goalContractId, {
        type: 'against',
        description: `Tool evidence included ${failed.length} failure(s): ${summarizeToolResults(failed)}.`,
      });
      return;
    }

    await recordEvidence(input.goalContractId, {
      type: 'for',
      description: `Tool evidence collected from ${toolNames.length > 0 ? toolNames.join(', ') : `${input.toolResults.length} tool result(s)`}.`,
    });
  } catch (error) {
    console.warn('[Harness] GoalContract tool evidence update failed:', (error as Error).message);
  }
}

async function recordHarnessFinalGoalEvidence(input: {
  goalContractId: string;
  outputPreview: string;
}): Promise<void> {
  try {
    const hasOutput = input.outputPreview.trim().length > 0;
    if (hasOutput) {
      await recordEvidence(input.goalContractId, {
        stepId: 'step-1',
        type: 'for',
        description: 'Objective, constraints, and success criteria were considered before final response.',
        stepStatus: 'done',
      });
      await recordEvidence(input.goalContractId, {
        stepId: 'step-2',
        type: 'for',
        description: 'Task execution produced a final response with available evidence.',
        stepStatus: 'done',
      });
    }
    await recordEvidence(input.goalContractId, {
      stepId: 'step-3',
      type: hasOutput ? 'for' : 'against',
      description: hasOutput
        ? `Harness produced final response: ${truncateForEvidence(input.outputPreview)}`
        : 'Harness returned an empty final response.',
      stepStatus: hasOutput ? 'done' : 'failed',
    });
  } catch (error) {
    console.warn('[Harness] GoalContract final evidence update failed:', (error as Error).message);
  }
}

async function recordHarnessFailureGoalEvidence(input: {
  goalContractId: string;
  errorMessage: string;
}): Promise<void> {
  try {
    await recordEvidence(input.goalContractId, {
      stepId: 'step-3',
      type: 'against',
      description: `Harness failed before final response: ${truncateForEvidence(input.errorMessage)}`,
      stepStatus: 'failed',
    });
  } catch (error) {
    console.warn('[Harness] GoalContract failure evidence update failed:', (error as Error).message);
  }
}

async function safeEvaluateGoalCompletion(goalContractId: string): Promise<GoalCompletionEvaluation | null> {
  try {
    return await evaluateCompletion(goalContractId);
  } catch (error) {
    console.warn('[Harness] GoalContract completion evaluation failed:', (error as Error).message);
    return null;
  }
}

function summarizeToolResults(results: NormalizedToolResult[]): string {
  return truncateForEvidence(results.map((result) => {
    const serialized = safeJsonPreview(result.result, 160);
    return `${result.toolName || 'unknown'}${result.isError ? ' isError=true' : ''}${serialized ? ` result=${serialized}` : ''}`;
  }).join('; '));
}

function safeJsonPreview(value: unknown, maxLen: number): string {
  try {
    return truncateForEvidence(JSON.stringify(value ?? ''), maxLen);
  } catch {
    return '';
  }
}

function truncateForEvidence(text: string, maxLen = 500): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

async function maybeRunGoalCompletionRepairPass<TResponse>(input: {
  input: HarnessGenerateInput;
  response: TResponse;
  originalPrompt: string;
  evaluation: GoalCompletionEvaluation | null;
  goalContractId: string;
  depthProfile: DepthProfile;
  runId: string;
  turnId: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  memoryResource?: string;
}): Promise<TResponse> {
  if (!shouldRunGoalCompletionGate(input.depthProfile, input.evaluation)) return input.response;

  const responseRecord = input.response as Record<string, unknown>;
  if (responseRecord?.finishReason === 'suspended') return input.response;

  const initialOutput = extractFullOutputText(input.response);
  if (!initialOutput.trim()) return input.response;

  await logHarnessEvent({
    type: 'goal_completion_gate_started',
    agentId: input.input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'goal_completion_gate',
    model: input.model,
    status: 'pending',
    data: {
      goalContractId: input.goalContractId,
      depthLevel: input.depthProfile.level,
      score: input.evaluation?.score,
      recommendation: input.evaluation?.recommendation,
      missingCriteria: input.evaluation?.missingCriteria.slice(0, 10),
    },
  });

  const repairPrompt = buildGoalCompletionRepairPrompt({
    originalPrompt: input.originalPrompt,
    initialOutput,
    evaluation: input.evaluation,
    depthProfile: input.depthProfile,
    goalContractId: input.goalContractId,
  });

  const repairOptions: Record<string, unknown> = {
    maxSteps: 1,
    toolChoice: 'none',
  };
  if (input.model) repairOptions.model = input.model;
  if (input.input.threadId) {
    repairOptions.memory = {
      // Same fallback as the main call (threadId ?? taskId). Passing the raw
      // value crashed these passes with "ObservationalMemory requires a threadId"
      // whenever a caller relied on the taskId default — which is how the autoheal
      // repair loop wedged: the main generate succeeded, then a repair/gate pass
      // blew up and the whole step reported "Exhausted all fallback models".
      thread: input.input.threadId ?? input.input.taskId,
      resource: input.memoryResource ?? input.input.agentId ?? 'harness',
    };
  }

  try {
    const repaired = await runWithHarnessExecutionContext(
      {
        agentId: input.input.agentId,
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
      },
      () => input.input.agent.generate(repairPrompt, repairOptions as any) as Promise<TResponse>, // @harness-exempt - no-tool GoalContract completion repair pass inside harness gateway
    );
    const repairedText = extractFullOutputText(repaired);
    if (!repairedText.trim()) return input.response;

    await logHarnessEvent({
      type: 'goal_completion_gate_completed',
      agentId: input.input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'goal_completion_gate',
      model: input.model,
      status: 'success',
      output: truncate(repairedText, 500),
      data: {
        goalContractId: input.goalContractId,
        depthLevel: input.depthProfile.level,
        score: input.evaluation?.score,
        recommendation: input.evaluation?.recommendation,
        outputTokensEstimate: tokenEstimate(repairedText),
      },
    });
    return repaired;
  } catch (error) {
    await logHarnessEvent({
      type: 'goal_completion_gate_failed',
      agentId: input.input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'goal_completion_gate',
      model: input.model,
      status: 'error',
      errorMessage: (error as Error).message,
      data: {
        goalContractId: input.goalContractId,
        depthLevel: input.depthProfile.level,
        score: input.evaluation?.score,
        recommendation: input.evaluation?.recommendation,
      },
    });
    return input.response;
  }
}

function shouldRunGoalCompletionGate(
  depthProfile: DepthProfile,
  evaluation: GoalCompletionEvaluation | null,
): boolean {
  if (!isHarnessFeatureEnabled('FEATURE_HARNESS_GOAL_REPAIR', false)) return false;
  if (!evaluation || evaluation.passed) return false;
  if (!depthProfile.goalContract) return false;
  return depthProfile.level === 'deep' || depthProfile.level === 'critical';
}

function buildGoalCompletionRepairPrompt(input: {
  originalPrompt: string;
  initialOutput: string;
  evaluation: GoalCompletionEvaluation | null;
  depthProfile: DepthProfile;
  goalContractId: string;
}): string {
  const missing = input.evaluation?.missingCriteria.length
    ? input.evaluation.missingCriteria.slice(0, 10).map((item) => `- ${item}`).join('\n')
    : '- Completion evaluation did not provide specific missing criteria.';

  return [
    '## Goal Completion Gate Repair',
    '',
    `Depth level: ${input.depthProfile.level}`,
    `GoalContract: ${input.goalContractId}`,
    `Completion score: ${input.evaluation?.score ?? 'unknown'}`,
    `Recommendation: ${input.evaluation?.recommendation ?? 'unknown'}`,
    '',
    'The previous answer did not satisfy the persisted GoalContract completion gate.',
    '',
    'Hard constraints:',
    '- Do not call tools. You are in a no-tool completion repair pass.',
    '- Do not claim new verification, test results, deployments, approvals, or tool output.',
    '- Use only the original request, previous answer, and missing criteria below.',
    '- If the work is actually incomplete or blocked, say that directly and list what remains.',
    '- If the answer can be made complete with better wording, revise it directly and concisely.',
    '',
    '## Original User Request',
    input.originalPrompt,
    '',
    '## Previous Answer',
    input.initialOutput,
    '',
    '## Missing Criteria / Gate Reasons',
    missing,
  ].join('\n');
}

async function maybeRunDepthUpgradeSecondPass<TResponse>(input: {
  input: HarnessGenerateInput;
  response: TResponse;
  originalPrompt: string;
  initialDepthLevel: DepthLevel;
  activeDepthProfile: DepthProfile;
  runId: string;
  turnId: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  memoryResource?: string;
}): Promise<TResponse> {
  if (!isHarnessFeatureEnabled('FEATURE_HARNESS_AUTO_DELIBERATION', false)) return input.response;
  const currentDepth = getRunDepth(input.runId);
  if (!currentDepth || depthRank(currentDepth) <= depthRank(input.initialDepthLevel)) return input.response;

  const initialOutput = extractFullOutputText(input.response);
  if (!initialOutput.trim()) return input.response;

  const prompt = [
    '## Depth Upgrade Second Pass',
    '',
    `Depth was upgraded from ${input.initialDepthLevel} to ${currentDepth} during runtime reflection.`,
    `New max steps: ${input.activeDepthProfile.maxSteps}`,
    `New planning mode: ${input.activeDepthProfile.planning}`,
    `GoalContract: ${input.input.goalContractId ?? 'none'}`,
    '',
    'Hard constraints:',
    '- Do not call tools. You are in a no-tool second pass after depth upgrade.',
    '- Do not claim new verification or new tool results.',
    '- Re-check the previous answer against the deeper profile.',
    '- If the previous answer is too shallow, revise it with the missing reasoning, caveats, or next steps.',
    '',
    '## Original User Request',
    input.originalPrompt,
    '',
    '## Previous Answer',
    initialOutput,
  ].join('\n');

  const repaired = await runNoToolGatePass<TResponse>({
    input: input.input,
    prompt,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    model: input.model,
    memoryResource: input.memoryResource,
    feature: 'depth_upgrade_second_pass',
    startedType: 'depth_upgrade_second_pass_started',
    completedType: 'depth_upgrade_second_pass_completed',
    failedType: 'depth_upgrade_second_pass_failed',
    data: {
      previousLevel: input.initialDepthLevel,
      newLevel: currentDepth,
      maxSteps: input.activeDepthProfile.maxSteps,
      planning: input.activeDepthProfile.planning,
      goalContractId: input.input.goalContractId,
    },
  });

  return repaired ?? input.response;
}

async function maybeRunAutoDeliberationPass<TResponse>(input: {
  input: HarnessGenerateInput;
  response: TResponse;
  originalPrompt: string;
  depthProfile: DepthProfile;
  runId: string;
  turnId: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  memoryResource?: string;
}): Promise<TResponse> {
  if (!input.depthProfile.autoDeliberation) return input.response;
  if (!isHarnessFeatureEnabled('FEATURE_HARNESS_AUTO_DELIBERATION', false)) return input.response;

  const reflections = getReflector({
    runId: input.runId,
    agentId: input.input.agentId,
  }).getTriggeredReflections();
  const deliberationSignals = reflections.filter((reflection) =>
    ['direction_instability', 'delegation_failures', 'high_error_rate', 'low_confidence'].includes(reflection.signal),
  );
  if (deliberationSignals.length === 0) return input.response;

  const initialOutput = extractFullOutputText(input.response);
  if (!initialOutput.trim()) return input.response;

  const signalSummary = deliberationSignals
    .map((reflection, index) => `${index + 1}. ${reflection.signal}: ${reflection.reason}`)
    .join('\n');
  const prompt = [
    '## Auto Deliberation Gate',
    '',
    'Runtime reflection found signals that require a short deliberation/re-plan pass.',
    '',
    'Hard constraints:',
    '- Do not call tools. This is a no-tool deliberation pass.',
    '- Do not invent new evidence.',
    '- Resolve the uncertainty by choosing a safer final direction or clearly stating the blocker.',
    '',
    '## Original User Request',
    input.originalPrompt,
    '',
    '## Previous Answer',
    initialOutput,
    '',
    '## Deliberation Signals',
    signalSummary,
  ].join('\n');

  const deliberated = await runNoToolGatePass<TResponse>({
    input: input.input,
    prompt,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    model: input.model,
    memoryResource: input.memoryResource,
    feature: 'auto_deliberation',
    startedType: 'auto_deliberation_started',
    completedType: 'auto_deliberation_completed',
    failedType: 'auto_deliberation_failed',
    data: {
      depthLevel: input.depthProfile.level,
      goalContractId: input.input.goalContractId,
      signals: deliberationSignals.map((reflection) => reflection.signal),
    },
  });

  return deliberated ?? input.response;
}

async function maybeRunAutoReviewPass<TResponse>(input: {
  input: HarnessGenerateInput;
  response: TResponse;
  originalPrompt: string;
  goalContractId?: string;
  depthProfile: DepthProfile;
  runId: string;
  turnId: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  memoryResource?: string;
}): Promise<TResponse> {
  if (!input.depthProfile.autoReview) return input.response;
  if (!isHarnessFeatureEnabled('FEATURE_HARNESS_AUTO_REVIEW', false)) return input.response;

  const initialOutput = extractFullOutputText(input.response);
  if (!initialOutput.trim()) return input.response;

  const prompt = [
    '## Auto Review Gate',
    '',
    'Review the previous answer before finalization.',
    '',
    'Verdict policy:',
    '- approve: keep the answer unless only minor clarity edits are needed.',
    '- needs_changes: revise the answer directly.',
    '- block: state why finalization is unsafe or incomplete.',
    '',
    'Hard constraints:',
    '- Do not call tools.',
    '- Do not claim new verification, test results, deployments, approvals, or external actions.',
    '- Ground the final answer in the existing evidence only.',
    '',
    '## Original User Request',
    input.originalPrompt,
    '',
    '## Previous Answer',
    initialOutput,
  ].join('\n');

  const reviewed = await runNoToolGatePass<TResponse>({
    input: input.input,
    prompt,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    model: input.model,
    memoryResource: input.memoryResource,
    feature: 'auto_review',
    startedType: 'auto_review_started',
    completedType: 'auto_review_completed',
    failedType: 'auto_review_failed',
    data: {
      depthLevel: input.depthProfile.level,
      goalContractId: input.goalContractId,
    },
  });

  if (reviewed && input.goalContractId) {
    await recordEvidence(input.goalContractId, {
      stepId: 'step-4',
      type: 'for',
      description: 'Critical-depth auto review gate completed before finalization.',
      stepStatus: 'done',
    }).catch(() => { /* non-critical */ });
  }

  return reviewed ?? input.response;
}

async function maybeRunApprovalGatePass<TResponse>(input: {
  input: HarnessGenerateInput;
  response: TResponse;
  originalPrompt: string;
  goalContractId?: string;
  depthProfile: DepthProfile;
  runId: string;
  turnId: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  memoryResource?: string;
}): Promise<TResponse> {
  if (!input.depthProfile.requireApproval) return input.response;

  const initialOutput = extractFullOutputText(input.response);
  if (!initialOutput.trim()) return input.response;
  if (!requiresApprovalGate(input.originalPrompt, initialOutput)) {
    if (input.goalContractId) {
      await recordEvidence(input.goalContractId, {
        stepId: 'step-5',
        type: 'for',
        description: 'Approval gate checked; no externally visible or destructive action was detected.',
        stepStatus: 'skipped',
      }).catch(() => { /* non-critical */ });
    }
    return input.response;
  }

  const prompt = [
    '## Approval Gate',
    '',
    'The request or previous answer involves a high-risk externally visible or destructive action.',
    '',
    'Hard constraints:',
    '- Do not call tools.',
    '- Do not perform, imply, or claim deployment, deletion, migration, activation, email send, credential change, payment action, or production data mutation.',
    '- Rewrite the final answer so it clearly asks for explicit approval before any high-risk action.',
    '- Keep safe analysis, status, and preparation steps if they are already grounded.',
    '',
    '## Original User Request',
    input.originalPrompt,
    '',
    '## Previous Answer',
    initialOutput,
  ].join('\n');

  const gated = await runNoToolGatePass<TResponse>({
    input: input.input,
    prompt,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    model: input.model,
    memoryResource: input.memoryResource,
    feature: 'approval_gate',
    startedType: 'approval_gate_started',
    completedType: 'approval_gate_completed',
    failedType: 'approval_gate_failed',
    data: {
      depthLevel: input.depthProfile.level,
      goalContractId: input.goalContractId,
      approvalRequired: true,
    },
  });

  if (gated && input.goalContractId) {
    await recordEvidence(input.goalContractId, {
      stepId: 'step-5',
      type: 'for',
      description: 'Approval gate completed; final output requires explicit approval before high-risk action.',
      stepStatus: 'done',
    }).catch(() => { /* non-critical */ });
  }

  return gated ?? input.response;
}

async function runNoToolGatePass<TResponse>(input: {
  input: HarnessGenerateInput;
  prompt: string;
  runId: string;
  turnId: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  memoryResource?: string;
  feature: string;
  startedType: string;
  completedType: string;
  failedType: string;
  data?: Record<string, unknown>;
}): Promise<TResponse | null> {
  await logHarnessEvent({
    type: input.startedType as any,
    agentId: input.input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: input.feature,
    model: input.model,
    status: 'pending',
    data: input.data,
  });

  const options: Record<string, unknown> = {
    maxSteps: 1,
    toolChoice: 'none',
  };
  if (input.model) options.model = input.model;
  if (input.input.threadId) {
    options.memory = {
      // Same fallback as the main call (threadId ?? taskId). Passing the raw
      // value crashed these passes with "ObservationalMemory requires a threadId"
      // whenever a caller relied on the taskId default — which is how the autoheal
      // repair loop wedged: the main generate succeeded, then a repair/gate pass
      // blew up and the whole step reported "Exhausted all fallback models".
      thread: input.input.threadId ?? input.input.taskId,
      resource: input.memoryResource ?? input.input.agentId ?? 'harness',
    };
  }

  try {
    const response = await runWithHarnessExecutionContext(
      {
        agentId: input.input.agentId,
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
      },
      () => input.input.agent.generate(input.prompt, options as any) as Promise<TResponse>, // @harness-exempt - controlled no-tool gate pass inside harness gateway
    );
    const output = extractFullOutputText(response);
    if (!output.trim()) return null;

    await logHarnessEvent({
      type: input.completedType as any,
      agentId: input.input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: input.feature,
      model: input.model,
      status: 'success',
      output: truncate(output, 500),
      data: {
        ...(input.data ?? {}),
        outputTokensEstimate: tokenEstimate(output),
      },
    });

    return response;
  } catch (error) {
    await logHarnessEvent({
      type: input.failedType as any,
      agentId: input.input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: input.feature,
      model: input.model,
      status: 'error',
      errorMessage: (error as Error).message,
      data: input.data,
    });
    return null;
  }
}

const APPROVAL_GATE_KEYWORDS =
  /deploy|activate|aktyw|delete|usuń|usun|migrac|migration|credential|secret|sekret|production|produkc|payment|płatno|platno|send email|wyślij|wyslij|workflow activation|database|baza danych/gi;

/**
 * A risk word that is DENIED nearby ("zero secrets", "no database writes",
 * "bez sekretów") is not evidence of a risky action, it is the opposite —
 * but the bare keyword test could not tell the two apart. This mattered
 * concretely: the Capability Gap Protocol's own spec template requires every
 * build spec to declare its secret/side-effect posture explicitly (`capability/base.md`
 * Move 1: "Include safety constraints … secret ENV VAR names if relevant"),
 * so a spec that says "zero secrets, read-only" tripped this gate on the word
 * "secret" alone — measured live 2026-08-22, capabilitySmith's build delegation
 * for a read-only regex checker got rewritten into a bogus "needs approval"
 * refusal. A short lookback for a negation cue immediately before the match
 * is not real NLP, but it is strictly conservative: it only SUPPRESSES a
 * trigger, never adds one, so a genuinely risky, un-negated mention still
 * fires exactly as before.
 */
const NEGATION_CUES = /\b(no|not|nie|zero|without|bez|never|nigdy|brak|żadn\w*|zadn\w*)\b/i;
const NEGATION_LOOKBACK_CHARS = 30;

export function requiresApprovalGate(originalPrompt: string, output: string): boolean {
  const text = `${originalPrompt}\n${output}`;
  APPROVAL_GATE_KEYWORDS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = APPROVAL_GATE_KEYWORDS.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - NEGATION_LOOKBACK_CHARS), match.index);
    if (!NEGATION_CUES.test(before)) return true;
  }
  return false;
}

function depthRank(level: DepthLevel): number {
  switch (level) {
    case 'fast': return 0;
    case 'standard': return 1;
    case 'deep': return 2;
    case 'critical': return 3;
  }
}

async function maybeRunReflectionRepairPass<TResponse>(input: {
  input: HarnessGenerateInput;
  response: TResponse;
  originalPrompt: string;
  runId: string;
  turnId: string;
  threadId?: string;
  taskId?: string;
  subtaskId?: string;
  model?: string;
  memoryResource?: string;
}): Promise<TResponse> {
  const reflector = getReflector({ runId: input.runId, agentId: input.input.agentId });
  const reflections = reflector.getTriggeredReflections();
  if (reflections.length === 0) return input.response;
  if (!isHarnessFeatureEnabled('FEATURE_REFLECTION_REPAIR_PASS' as HarnessFeatureFlagName, true)) return input.response;
  // Part 1 §1.5.1: when prepareStep is ON, every reflection already corrected the
  // run in-flight, so the post-hoc prose-rewrite repair pass is redundant — skip it.
  if (isHarnessFeatureEnabled('FEATURE_REFLECTOR_PREPARE_STEP', true)) return input.response;

  const responseRecord = input.response as Record<string, unknown>;
  if (responseRecord?.finishReason === 'suspended') return input.response;

  const initialOutput = extractFullOutputText(input.response);
  if (!initialOutput.trim()) return input.response;

  await logHarnessEvent({
    type: 'reflection_repair_started' as any,
    agentId: input.input.agentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: input.threadId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    feature: 'strategy_reflector',
    model: input.model,
    status: 'pending',
    data: {
      reflectionCount: reflections.length,
      signals: reflections.map((r) => r.signal),
    },
  });

  const repairPrompt = buildReflectionRepairPrompt({
    originalPrompt: input.originalPrompt,
    initialOutput,
    reflections,
  });

  const repairOptions: Record<string, unknown> = {
    maxSteps: 1,
    toolChoice: 'none',
  };
  if (input.model) repairOptions.model = input.model;
  if (input.input.threadId) {
    repairOptions.memory = {
      // Same fallback as the main call (threadId ?? taskId). Passing the raw
      // value crashed these passes with "ObservationalMemory requires a threadId"
      // whenever a caller relied on the taskId default — which is how the autoheal
      // repair loop wedged: the main generate succeeded, then a repair/gate pass
      // blew up and the whole step reported "Exhausted all fallback models".
      thread: input.input.threadId ?? input.input.taskId,
      resource: input.memoryResource ?? input.input.agentId ?? 'harness',
    };
  }

  try {
    const repaired = await runWithHarnessExecutionContext(
      {
        agentId: input.input.agentId,
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
      },
      () => input.input.agent.generate(repairPrompt, repairOptions as any) as Promise<TResponse>, // @harness-exempt - no-tool reflection repair pass inside harness gateway
    );
    const repairedText = extractFullOutputText(repaired);
    if (!repairedText.trim()) return input.response;

    await logHarnessEvent({
      type: 'reflection_repair_completed' as any,
      agentId: input.input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'strategy_reflector',
      model: input.model,
      status: 'success',
      output: truncate(repairedText, 500),
      data: {
        reflectionCount: reflections.length,
        outputTokensEstimate: tokenEstimate(repairedText),
      },
    });
    return repaired;
  } catch (error) {
    await logHarnessEvent({
      type: 'reflection_repair_failed' as any,
      agentId: input.input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'strategy_reflector',
      model: input.model,
      status: 'error',
      errorMessage: (error as Error).message,
      data: {
        reflectionCount: reflections.length,
      },
    });
    return input.response;
  }
}

function buildReflectionRepairPrompt(input: {
  originalPrompt: string;
  initialOutput: string;
  reflections: TriggeredReflection[];
}): string {
  const reflectionSummary = input.reflections
    .map((r, i) => [
      `${i + 1}. signal=${r.signal}; step=${r.stepNumber}; reason=${r.reason}`,
      r.message,
    ].join('\n'))
    .join('\n\n');

  return [
    `## Runtime Strategy Reflection Repair`,
    ``,
    `The previous run triggered the Strategy Reflector. Produce the final answer again after addressing the reflection signals.`,
    ``,
    `Hard constraints:`,
    `- Do not call tools. You are in a no-tool repair pass.`,
    `- Do not claim new verification or new tool results.`,
    `- Use only the original user request, the previous answer, and the reflection signals below.`,
    `- If the previous answer is acceptable, keep it but add any missing caveat or correction required by the signals.`,
    `- If the previous answer is not acceptable, revise it directly and concisely.`,
    ``,
    `## Original User Request`,
    input.originalPrompt,
    ``,
    `## Previous Answer`,
    input.initialOutput,
    ``,
    `## Reflection Signals`,
    reflectionSummary,
  ].join('\n');
}

/**
 * Dynamic DEADLINE guard that checks remaining budget via `getRemainingRunBudgetMs(runId)`.
 * When a run depth is upgraded mid-run (e.g. fast -> standard), the deadline is extended
 * in `run-budget`, allowing this guard to dynamically adjust rather than hard-killing the agent.
 */
async function withDeadlineGuard<T>(
  promise: Promise<T>,
  runId?: string,
  fallbackTimeoutMs?: number,
  message?: string,
  onTimeout?: () => void,
): Promise<T> {
  const initialRemaining = runId ? getRemainingRunBudgetMs(runId) : undefined;
  const effectiveTimeout = initialRemaining !== undefined ? initialRemaining : fallbackTimeoutMs;
  if (!effectiveTimeout || effectiveTimeout <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const POLL_FLOOR_MS = 250;
  const MAX_POLL_INTERVAL_MS = 1_000;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const arm = () => {
          const curRemaining = runId ? getRemainingRunBudgetMs(runId) : undefined;
          if (curRemaining !== undefined) {
            if (curRemaining <= 0) {
              try {
                onTimeout?.();
              } catch {
                // best-effort abort; never mask the timeout rejection
              }
              reject(new Error(message ?? 'Harness LLM call timed out'));
              return;
            }
            const nextCheckMs = Math.max(
              POLL_FLOOR_MS,
              Math.min(curRemaining, MAX_POLL_INTERVAL_MS),
            );
            timer = setTimeout(arm, nextCheckMs);
            return;
          }

          if (fallbackTimeoutMs && fallbackTimeoutMs > 0) {
            timer = setTimeout(() => {
              try {
                onTimeout?.();
              } catch {
                // best-effort abort; never mask the timeout rejection
              }
              reject(new Error(message ?? `Harness LLM call timed out after ${fallbackTimeoutMs / 1000}s`));
            }, fallbackTimeoutMs);
          }
        };
        arm();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read a positive millisecond env override, ignoring absent/invalid values. */
function positiveEnvMs(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * LIVENESS guard (ideas/liveness-budget-plan.md L2) — the wall-clock's replacement.
 *
 * `withTimeout` asks "has this taken too long?" and kills a healthy agent mid-work.
 * This asks two better questions instead:
 *   - has the run gone SILENT for `idleTimeoutMs`? (no step, no tool result)
 *   - has it exceeded the absolute `hardCapMs` backstop?
 *
 * The idle timer is re-armed from the registry's `lastActivityAt`, which
 * `touchRunLiveness` moves on every step. A run that keeps working therefore
 * keeps re-earning its window and is never cut for duration alone. Both cuts
 * reuse the caller's `onTimeout` (WS-A abort), so the losing work is aborted
 * rather than orphaned — identical to the legacy path.
 *
 * The rejection reason distinguishes the two cases, because "went silent" and
 * "hit the absolute ceiling" call for very different follow-ups.
 */
async function withLivenessGuard<T>(
  promise: Promise<T>,
  runId: string,
  onTimeout?: () => void,
): Promise<T> {
  const initial = getRunLivenessState(runId);
  // No liveness entry ⇒ nothing to guard (non-liveness run); never silently
  // fall back to an invented budget.
  if (!initial) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const POLL_FLOOR_MS = 250;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const arm = () => {
          const state = getRunLivenessState(runId);
          if (!state) return; // entry cleared mid-run: stop guarding, let the work finish
          if (!state.alive) {
            try {
              onTimeout?.();
            } catch {
              // best-effort abort; never mask the rejection
            }
            const error = new Error(
              state.reason === 'HARD_CAP'
                ? `Harness run exceeded its hard cap after ${Math.round(state.elapsedMs / 1000)}s`
                : `Harness run went idle for ${Math.round(state.idleForMs / 1000)}s`,
            ) as Error & { code?: string };
            error.code = state.reason === 'HARD_CAP'
              ? 'HARNESS_LIVENESS_HARD_CAP'
              : 'HARNESS_LIVENESS_IDLE_TIMEOUT';
            reject(error);
            return;
          }
          // Re-check exactly when the nearest bound would elapse. Every touch
          // pushes `idleRemainingMs` forward, so a working run re-arms further out.
          const nextCheckMs = Math.max(
            POLL_FLOOR_MS,
            Math.min(state.idleRemainingMs, state.hardCapRemainingMs),
          );
          timer = setTimeout(arm, nextCheckMs);
        };
        arm();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ── Etap 7 (CGP): capability-gap detection ───────────────────────────────────
// Tight pattern list on purpose — a false positive spams the smith's backlog.
const CAPABILITY_GAP_PATTERNS: RegExp[] = [
  /\bnie mam (?:narzędzia|dostępu do narzędzia|takiej możliwości|zdolności)\b/i,
  /\bbrak (?:narzędzia|integracji|zdolności)\b/i,
  /\bi (?:don't|do not) have (?:a|the|any) tool\b/i,
  /\bno (?:such )?tool (?:is )?available\b/i,
  /\bi lack (?:a|the) (?:tool|capability|integration)\b/i,
  /\bmissing (?:tool|capability|integration) (?:for|to)\b/i,
];

/** Fire-and-forget: record a capability gap when the reply admits a missing tool. */
export function detectCapabilityGap(agentId: string, outputText: string, taskId?: string): void {
  try {
    if (!outputText) return;
    const matched = CAPABILITY_GAP_PATTERNS.find((re) => re.test(outputText));
    if (!matched) return;
    const idx = outputText.search(matched);
    const excerpt = outputText.slice(Math.max(0, idx - 80), idx + 220);
    void logHarnessEvent({
      type: 'capability_gap',
      agentId,
      taskId,
      feature: 'capability_gap',
      status: 'success',
      output: excerpt.slice(0, 400),
    }).catch(() => undefined);
    void import('./capability-registry.js')
      .then(({ recordCapabilityGap }) => recordCapabilityGap({ agentId, description: excerpt, taskId }))
      .catch(() => undefined);
  } catch { /* detection must never break generation */ }
}

function extractOutputPreview(response: unknown): string {
  return truncate(extractFullOutputText(response), 1000);
}

/**
 * The run's DELIVERABLE, not merely its last text.
 *
 * Delegated to `harness-output-text.ts`: the framework appends its own
 * `isTaskComplete` report after the final iteration, and reading `response.text`
 * blindly committed that report as a job's result on live traffic. See that
 * module for why the matcher is deliberately narrow.
 */
function extractFullOutputText(response: unknown): string {
  return extractDeliverableText(response);
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function schedulePostTurnMemory(
  input: HarnessGenerateInput,
  runId: string,
  turnId: string,
  outputPreview?: string,
  errorMessage?: string,
): void {
  const contextText = [
    `phase: ${input.phase}`,
    input.prompt,
    input.targetFiles?.length ? `target files: ${input.targetFiles.join(', ')}` : '',
    input.automationId ? `automationId: ${input.automationId}` : '',
    input.workflowId ? `workflowId: ${input.workflowId}` : '',
    input.patternId ? `patternId: ${input.patternId}` : '',
    outputPreview ? `output: ${outputPreview}` : '',
    errorMessage ? `error: ${errorMessage}` : '',
  ].filter(Boolean).join('\n\n');

  void scheduleSemanticMemoryCheck({
    threadId: input.threadId ?? input.taskId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    agentId: input.agentId,
    runId,
    turnId,
    model: input.model,
    contextText,
  });
}

function precontextTelemetry(precontext: HarnessPrecontextResult): Record<string, unknown> {
  const { markdown: _markdown, ...rest } = precontext;
  return rest;
}
