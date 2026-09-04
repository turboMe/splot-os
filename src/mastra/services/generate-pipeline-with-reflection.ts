/**
 * Pipeline wrapper with in-flight reflection (Reflektor Part 3 §3.2/3.6).
 *
 * Deterministic, long-running state-machine agents (chef / content / hunt) run
 * via a bare `agent.generate` with `maxSteps: 150` baked into their own
 * `defaultOptions`. They MUST NOT go through the full coding/automation harness:
 * the depth controller there caps `maxSteps` to ≤40 and layers on GoalContract
 * gates / stopWhen that would derail a 150-step pipeline.
 *
 * This wrapper is intentionally minimal. It adds ONLY:
 *   1. `prepareStep` — pipeline-mode Strategy Reflector (soft levers only) +
 *      per-phase `activeTools` allowlist (§3.4), recomputed before every step.
 *   2. `onStepFinish` — light telemetry (phase-transition detection).
 *
 * It deliberately does NOT add: depth controller, maxSteps override, stopWhen,
 * GoalContract triggers, hard levers, or output scoring. The agent's own
 * `defaultOptions.maxSteps` stays the single source of truth for the step cap.
 *
 * Everything is best-effort: any reflector / telemetry error is swallowed so a
 * deterministic pipeline run is never broken by the harness.
 */

import type { Agent } from '@mastra/core/agent';
import { randomUUID } from 'crypto';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import {
  buildToolIdToKeyMap,
  detectPipelinePhase,
  getStatusToolName,
  isPipelineAgent,
  resolvePhaseTools,
  translateToolIdsToKeys,
} from '../config/pipeline-phase-tools.js';
import { logHarnessEvent } from './harness-events.js';
import { disposeReflector, getReflector, type StepHistoryInput } from './strategy-reflector.js';
import { normalizeStepsForReflector } from './generate-with-harness.js';
import { clearRunBudget, startRunLiveness, touchRunLiveness } from './run-budget.js';
import { intersectTransientActiveTools } from '../processors/transient-tool-shelf.js';

export interface PipelineReflectionInput {
  /** Resolved Mastra agent instance to run. */
  agent: Agent;
  /** Registry key (e.g. `chefAgent`) — used to resolve the phase/tool map. */
  agentKey: string;
  /** Canonical agent id for telemetry. */
  agentId: string;
  /** Task prompt forwarded to `agent.generate`. */
  prompt: string;
  /** Memory thread id (delegation thread). */
  threadId: string;
  /** Memory resource id. */
  resourceId: string;
  /** Optional task id for telemetry correlation. */
  taskId?: string;
  /** Optional goal contract id for telemetry correlation (NOT used for triggers). */
  goalContractId?: string;
  /**
   * CAN-002 — cancellation for the pipeline profile.
   *
   * Pipeline agents run with `maxSteps: 150` and no wall-clock of their own, so
   * before this the only bound was the delegation timeout — and that timeout was
   * a bare `Promise.race`: it rejected the caller's wait while the pipeline kept
   * running, kept calling tools and kept mutating state. Feeding a real signal
   * into `agent.generate` is what turns that abandonment into an actual stop.
   */
  abortSignal?: AbortSignal;
}

export interface PipelineReflectionResult {
  text: string;
  runId: string;
}

/**
 * Phase detection moved to `config/pipeline-phase-tools` when the V2 harness
 * became its second consumer — one rule, one implementation. Aliased here so the
 * call sites below keep reading the way they always did.
 */
const detectCurrentPhase = detectPipelinePhase;

/**
 * Run a pipeline agent with in-flight reflection + per-phase tool channeling.
 *
 * FAIL-SAFE: if `agentKey` is not a registered pipeline agent or the feature
 * flag is off, this still runs — it simply adds no levers (equivalent to a bare
 * `agent.generate`). The caller is expected to gate on `FEATURE_PIPELINE_REFLECTOR`
 * before choosing this path, but we re-check here so the wrapper is safe to call.
 */
export async function generatePipelineWithReflection(
  input: PipelineReflectionInput,
): Promise<PipelineReflectionResult> {
  const runId = `pipeline-${randomUUID()}`;
  const statusToolName = getStatusToolName(input.agentKey);
  const phaseToolsEnabled = isHarnessFeatureEnabled('FEATURE_PIPELINE_PHASE_TOOLS', true);

  const generateOptions: Record<string, unknown> = {
    memory: {
      thread: input.threadId,
      resource: input.resourceId,
    },
  };

  // CAN-002 / K2 — the pipeline profile.
  //
  // Pipeline agents declare `maxSteps: 150` and, until now, had NO clock of any
  // kind: the only bound was the delegation timeout, so 150 steps in a ≤240s
  // window was physically unreachable and these agents always ended on a
  // delegation timeout rather than their own step cap. The declared limit was
  // fiction.
  //
  // Liveness is the right bound here rather than a wall-clock: a render or a
  // long recon legitimately takes minutes, so cutting on duration would repeat
  // the mistake. The run is instead cut for SILENCE, with a hard cap far above
  // normal work as a backstop. Envelope is wider than the harness profiles
  // because media/tool phases have genuine quiet stretches.
  // Started below, together with `prepareStep` — liveness without anything to
  // touch would read a healthy run as silent and cut it.
  const livenessEnabled = isHarnessFeatureEnabled('FEATURE_LIVENESS_BUDGET', false);

  // Only wire the reflector for actual pipeline agents with a known status tool.
  if (isPipelineAgent(input.agentKey) && statusToolName) {
    const reflector = getReflector({
      runId,
      agentId: input.agentId,
      originalPrompt: input.prompt,
    });

    // ⚠️ Naming boundary: the phase map is authored in tool `id`s, but step
    // history / `activeTools` / the model's tool registry all key on the tool
    // OBJECT KEY. Build an id → key map from the live registry so we can match
    // and channel by key. Best-effort: on failure we keep the (id) names and
    // simply fail-open (no match → no restriction).
    let idToKey: Record<string, string> = {};
    try {
      idToKey = buildToolIdToKeyMap(await input.agent.listTools());
    } catch (toolErr) {
      console.warn('[PipelineReflection] listTools failed (non-fatal):', (toolErr as Error).message);
    }
    // The status tool, expressed as the registry key step history will report.
    const statusToolKey = idToKey[statusToolName] ?? statusToolName;

    // Closure state for phase-transition telemetry (emit once per change).
    let lastPhase: string | null = null;
    // Sticky last-known phase. ObservationalMemory compacts the in-context
    // message window mid-run, so a given `prepareStep` may receive a `steps`
    // array whose status call has scrolled out → detection returns null. We
    // retain the last detected phase so tool channeling + telemetry don't go
    // blind (and silently fail-open) for the rest of the run.
    let stickyPhase: string | null = null;

    if (livenessEnabled) {
      startRunLiveness(runId, {
        idleTimeoutMs: positiveEnvMs('PIPELINE_LIVENESS_IDLE_TIMEOUT_MS') ?? 180_000,
        hardCapMs: positiveEnvMs('PIPELINE_LIVENESS_HARD_CAP_MS') ?? 3_600_000,
      });
    }

    generateOptions.prepareStep = async (args: Record<string, unknown>) => {
      // CAN-002 — proof of life for the pipeline profile: the agent is about to
      // take another step, so the idle window is re-earned.
      touchRunLiveness(runId);
      try {
        const stepNumber = typeof args.stepNumber === 'number' ? args.stepNumber : 0;
        const rawSteps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
        const systemMessages = Array.isArray(args.systemMessages)
          ? (args.systemMessages as Array<Record<string, unknown>>)
          : [];
        const suppliedTools = args.tools && typeof args.tools === 'object'
          ? args.tools as Record<string, unknown>
          : {};
        const currentTools = Object.keys(suppliedTools).length > 0
          ? suppliedTools
          : Object.fromEntries(Object.values(idToKey).map((name) => [name, {}]));
        const currentToolUniverse = Object.keys(currentTools);
        const incomingActiveTools = Array.isArray(args.activeTools)
          ? args.activeTools.filter((name): name is string => typeof name === 'string')
          : undefined;
        const currentIdToKey = {
          ...idToKey,
          ...buildToolIdToKeyMap(currentTools as never),
        };

        const steps = normalizeStepsForReflector(rawSteps);
        // Retain the last known phase when this window's status call was
        // compacted out (detection → null). A real new transition always
        // appears in the just-finished step, so genuine changes still win.
        const detectedPhase = detectCurrentPhase(steps, statusToolKey);
        const currentPhase = detectedPhase ?? stickyPhase;
        if (currentPhase) stickyPhase = currentPhase;

        // Per-phase tool allowlist (§3.4), translated id → key for activeTools.
        // Fail-open: null → no restriction.
        const phaseAllow = phaseToolsEnabled
          ? translateToolIdsToKeys(resolvePhaseTools(input.agentKey, currentPhase), idToKey)
          : null;

        const result: Record<string, unknown> = {};
        let activeTools: string[] | undefined = incomingActiveTools;
        if (phaseAllow && phaseAllow.length > 0) {
          activeTools = intersectTransientActiveTools(currentTools, activeTools, phaseAllow);
        }

        // Emit phase telemetry once per transition (cheap, fire-and-forget).
        if (currentPhase !== lastPhase) {
          lastPhase = currentPhase;
          if (currentPhase) {
            void logHarnessEvent({
              type: 'pipeline_phase_transition',
              agentId: input.agentId,
              runId,
              threadId: input.threadId,
              taskId: input.taskId,
              feature: 'pipeline_reflector',
              status: 'success',
              data: { phase: currentPhase, stepNumber },
            });
            if (phaseAllow) {
              void logHarnessEvent({
                type: 'pipeline_phase_tools_applied',
                agentId: input.agentId,
                runId,
                threadId: input.threadId,
                taskId: input.taskId,
                feature: 'pipeline_reflector',
                status: 'success',
                data: { phase: currentPhase, toolCount: phaseAllow.length },
              });
            }
          }
        }

        // Pipeline-mode reflector: soft levers only, signals counted per phase.
        const decision = reflector.evaluateHistory(steps, {
          pipelineMode: true,
          statusToolName: statusToolKey,
          phaseTools: phaseAllow ?? undefined,
        });

        const intervene =
          decision.action === 'inject_reflection' &&
          !!decision.intervention &&
          !!decision.signal &&
          !reflector.isReflectionBudgetExhausted() &&
          !reflector.isSignalInCooldown(decision.signal, stepNumber);

        if (intervene) {
          reflector.recordIntervention(decision, stepNumber);
          const iv = decision.intervention!;
          const appliedLevers: string[] = [];

          // injectSystem: READ existing system messages + APPEND ours
          // (ProcessInputStepResult.systemMessages REPLACES the whole set).
          if (iv.injectSystem) {
            result.systemMessages = [...systemMessages, { role: 'system', content: iv.injectSystem }];
            appliedLevers.push('injectSystem');
          }

          // dropTools: remove looping tools from the current allowlist base —
          // the phase allowlist when there is one, otherwise the full registry.
          //
          // This used to skip entirely when `activeTools` was null, which is
          // exactly the case it was needed in: with no phase detected there is
          // no restriction to subtract from, so the lever was silently dropped
          // and `injectSystem` (a text nudge) became the only thing left. In
          // pipeline mode the hard levers are already stripped, so that left
          // nothing able to stop a loop. Measured 2026-08-19: chef called
          // `chef_draft_recipe` 145 times with empty arguments, failing input
          // validation identically every time, until the job hit its wall clock.
          if (iv.dropTools?.length) {
            const base = activeTools ?? currentToolUniverse;
            const dropKeys = new Set(iv.dropTools.map((name) => currentIdToKey[name] ?? name));
            const filtered = base.filter((name) => !dropKeys.has(name));
            // Never leave an empty allowlist, and never invent one from an empty
            // registry (listTools failed → stay unrestricted, as before).
            if (filtered.length > 0 && filtered.length < base.length) {
              activeTools = filtered;
              appliedLevers.push('dropTools');
            }
          }

          void logHarnessEvent({
            type: 'pipeline_reflector_intervention',
            agentId: input.agentId,
            runId,
            threadId: input.threadId,
            taskId: input.taskId,
            feature: 'pipeline_reflector',
            status: 'success',
            data: {
              signal: decision.signal,
              reason: decision.reason,
              phase: currentPhase,
              stepNumber,
              appliedLevers,
              droppedTools: iv.dropTools,
            },
          });
        }

        // Apply the (possibly narrowed) phase allowlist for the next step.
        if (activeTools && activeTools.length > 0) {
          result.activeTools = activeTools;
        }

        return Object.keys(result).length > 0 ? result : undefined;
      } catch (err) {
        // The reflector must NEVER break a deterministic pipeline run.
        console.warn('[PipelineReflection] prepareStep error (non-fatal):', (err as Error).message);
        return undefined;
      }
    };
  }

  try {
    if (input.abortSignal) {
      (generateOptions as Record<string, unknown>).abortSignal = input.abortSignal;
    }
    const response = await input.agent.generate(input.prompt, generateOptions as never); // @harness-exempt — this file IS the pipeline gateway (harness equivalent for the pipeline profile)
    // CAN-002 — live-verified finding: Mastra's `agent.generate` does NOT reject
    // when its abortSignal fires. It resolves with `finishReason: 'tripwire'` and
    // empty text (confirmed against a real Ollama call: the real generation stops
    // in ~60ms, well before the ~200-item response would finish, so the abort
    // genuinely worked) — but a caller reading only `.text` would see that as a
    // silent SUCCESS with nothing to say, not a cancellation. `withDelegationTimeout`
    // (delegate-task.ts) needs a real rejection to know the work was stopped, so a
    // cancelled run is surfaced explicitly instead of masquerading as an empty
    // completion.
    const finishReason = (response as { finishReason?: string }).finishReason;
    if (finishReason === 'tripwire' && input.abortSignal?.aborted) {
      throw new Error(
        (input.abortSignal.reason as Error | undefined)?.message ?? 'pipeline_cancelled',
      );
    }
    return { text: (response as { text?: string }).text ?? '', runId };
  } finally {
    disposeReflector(runId);
    clearRunBudget(runId);
  }
}

/** Read a positive millisecond env override, ignoring absent/invalid values. */
function positiveEnvMs(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
