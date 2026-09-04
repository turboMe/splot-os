/**
 * Strategy Reflector (Phase 2 — Cognitive Loop)
 *
 * Runtime hook that monitors agent step-by-step execution and detects
 * anomalous patterns that indicate the agent is struggling, looping,
 * or drifting from its goal. When triggered, the harness can use the
 * recorded reflection to run a controlled no-tool repair pass.
 *
 * Integrates with the harness `onStepFinish` hook.
 *
 * Signals monitored:
 *   - error_rate: ratio of failed tool calls
 *   - direction_changes: how many times the target agent changed
 *   - tool_repetition: same tool called repeatedly with similar args
 *   - step_count: total steps without progress signal
 *   - delegation_failures: delegations returning success:false
 *   - low_confidence: keywords like "nie jestem pewien", "spróbuję"
 *
 * Each signal can trigger a reflection decision. The current harness
 * implementation applies those decisions after the first pass because
 * Mastra's step callback does not mutate the in-flight message stream.
 */

import { logHarnessEvent } from './harness-events.js';
import { getRunDepth, upgradeRunDepth } from './depth-controller.js';
import { getAutomationDeliverableStatus, hasAutomationDeliverable } from './mcp-handoff-state.js';
import { AUTOMATION_ARCHITECT_AGENT_ID } from '../config/agent-ids.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ReflectorSignalKind =
  | 'high_error_rate'
  | 'direction_instability'
  | 'tool_loop'
  | 'low_progress'
  | 'delegation_failures'
  | 'low_confidence'
  | 'scope_creep'
  // ── Part 2 §2.1/2.2 — GoalContract-aware triggers (FEATURE_REFLECTOR_GOAL_TRIGGERS) ──
  | 'progress_stall'
  | 'wrong_tool'
  // ── §A — graceful convergence (FEATURE_REFLECTOR_CONVERGENCE) ──
  // The run already has a usable deliverable (a successful delegation/worker
  // result) but keeps churning (scope_creep / progress_stall / low_confidence on
  // a loop) instead of finalizing. Force a no-tool synthesis step.
  | 'converge';

/**
 * In-flight intervention levers (Part 1 — prepareStep actuator).
 * Describes HOW the harness should mutate the next step's action space.
 * Part 1 keeps these conservative/reversible: inject context, drop a looping
 * tool, or force a no-tool re-plan. Harder levers (escalateModel/forceTool/
 * restrictTools) are reserved for Part 2.
 */
export interface ReflectorIntervention {
  /** Append this text as a system message to the next step's context */
  injectSystem?: string;
  /** Remove these tools from the next step (activeTools = universe - dropTools) */
  dropTools?: string[];
  /** Force toolChoice 'none' for the next step (re-plan in reasoning, no action) */
  forceNoTool?: boolean;
  // ── Part 2 §2.5 — hard levers (FEATURE_REFLECTOR_HARD_LEVERS, high confidence only) ──
  /** Escalate to a stronger model for one repair step (harness resolves the model). */
  escalateModel?: boolean;
  /** Force a specific tool via toolChoice for the next step (e.g. request approval). */
  forceTool?: string;
  /** Restrict the next step to a curated allowlist (activeTools = restrictTools ∩ universe). */
  restrictTools?: string[];
}

export interface ReflectorDecision {
  action: 'continue' | 'inject_reflection';
  signal?: ReflectorSignalKind;
  reason?: string;
  /** Reflection message to use for repair/soft-stop if action is 'inject_reflection' */
  message?: string;
  /** In-flight levers to apply via prepareStep (Part 1). Present when action is 'inject_reflection'. */
  intervention?: ReflectorIntervention;
  /** Current signal snapshot at time of decision */
  snapshot?: ReflectorSnapshot;
}

/**
 * One step of execution history, as consumed by the stateless `evaluateHistory`.
 * The harness builds these from Mastra `StepResult[]` via `normalizeSteps`.
 */
export interface StepHistoryInput {
  toolCalls?: Array<{ toolName: string; args?: unknown }>;
  toolResults?: Array<{ toolName: string; result?: unknown; isError?: boolean }>;
  stepText?: string;
}

/**
 * Optional out-of-band context for `evaluateHistory` (Part 2). Carries
 * GoalContract progress so the reflector can fire surprise-triggered signals
 * (`progress_stall` / `wrong_tool`) instead of relying solely on step counters.
 */
export interface EvaluateContext {
  /**
   * Disable argument-volume scope-creep detection for agents whose legitimate
   * work transports large structured payloads, such as n8n workflow JSON.
   */
  suppressScopeCreep?: boolean;
  /**
   * Enable GoalContract-aware triggers (`progress_stall`, `wrong_tool`).
   * Mirrors `FEATURE_REFLECTOR_GOAL_TRIGGERS`; when false these signals never
   * fire and `evaluateHistory` behaves exactly as in Part 1.
   */
  goalTriggersEnabled?: boolean;
  /**
   * GoalContract `currentProgress` samples observed so far, most recent last —
   * one sample per prepareStep observation. Used to detect a flat progress
   * delta over `progressStallSteps`.
   */
  progressSamples?: number[];
  /**
   * §2.5 — Enable hard levers (`escalateModel` / `forceTool` / `restrictTools`)
   * on high-confidence/severe signals. Mirrors `FEATURE_REFLECTOR_HARD_LEVERS`;
   * when false, only soft levers (inject/drop/forceNoTool) are produced.
   */
  hardLeversEnabled?: boolean;
  /**
   * §A — Enable graceful convergence (`converge` signal + `shouldConvergeStop`).
   * Mirrors `FEATURE_REFLECTOR_CONVERGENCE`. When a delegating run already holds a
   * usable deliverable but keeps churning, the reflector forces a no-tool
   * synthesis and (via the harness stopWhen) ends the run cleanly instead of
   * burning the wall-clock to a timeout. Off → behaves exactly as before.
   */
  convergenceEnabled?: boolean;
  // ── Part 3 §3.3B — pipeline mode (chef / content / hunt) ──
  /**
   * Pipeline mode for deterministic, long state-machine agents. Drastically
   * narrows the active signal set so reflection NEVER fights the state machine:
   *   - DISABLED: `low_progress` (150 steps is normal), `direction_instability`
   *     (direction is dictated by the state machine), `scope_creep`,
   *     `low_confidence`, `progress_stall` (no GoalContract here).
   *   - ENABLED: `tool_loop`, `high_error_rate` and `wrong_tool` — all counted
   *     PER PHASE (reset on each `*_set_*_status` transition), not globally.
   * Only SOFT levers are produced (`injectSystem` + `dropTools`); hard levers and
   * `forceNoTool` are stripped so a long deterministic run is never derailed.
   */
  pipelineMode?: boolean;
  /**
   * The agent's phase-transition tool id (e.g. `chef_set_project_status`). Used
   * to find the current-phase window in `steps` — error rate / loops / wrong_tool
   * are computed only over steps since the last transition. Required for
   * per-phase counting; without it, pipeline signals fall back to whole-history.
   */
  statusToolName?: string;
  /**
   * Allowed tool ids for the CURRENT phase (from the per-phase map, §3.4). When
   * present, the reflection message names them as the phase-appropriate
   * candidates. Optional — the reflector stays decoupled from the map.
   */
  phaseTools?: string[];
}

export interface TriggeredReflection {
  signal: ReflectorSignalKind;
  reason: string;
  message: string;
  stepNumber: number;
  snapshot: ReflectorSnapshot;
}

export interface ReflectorSnapshot {
  stepNumber: number;
  totalToolCalls: number;
  failedToolCalls: number;
  errorRate: number;
  directionChanges: number;
  toolRepetitions: Record<string, number>;
  delegationFailures: number;
  lowConfidenceDetected: boolean;
  reflectionsTriggered: number;
}

export interface StepAnalysisInput {
  /** Tool calls from this step */
  toolCalls: Array<{ toolName: string; args?: unknown }>;
  /** Tool results from this step */
  toolResults: Array<{ toolName: string; result?: unknown; isError?: boolean }>;
  /** Text output from this step (if any) */
  stepText?: string;
  /** Agent ID executing this step */
  agentId: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

interface ReflectorConfig {
  /** Error rate threshold to trigger reflection (0.0-1.0) */
  errorRateThreshold: number;
  /** Max direction changes before triggering */
  maxDirectionChanges: number;
  /** Max times same tool can be called before loop detection */
  maxToolRepetitions: number;
  /** Max times same tool with IDENTICAL arguments can be called before strict loop detection */
  maxIdenticalToolRepetitions: number;
  /** Max times a read-only inspection tool (read_file, search, etc.) can be called before loop detection */
  maxReadToolRepetitions: number;
  /** Step count threshold for low-progress signal */
  maxStepsWithoutProgress: number;
  /** Max delegation failures before triggering */
  maxDelegationFailures: number;
  /** Minimum steps before any reflection can trigger (warmup) */
  warmupSteps: number;
  /** Max reflections per run (prevent reflection loops) */
  maxReflectionsPerRun: number;
  /** Tool argument growth multiplier over original prompt before scope-creep reflection */
  scopeCreepMultiplier: number;
  /** Minimum cumulative tool-arg chars before scope-creep can trigger */
  minScopeCreepChars: number;
  /**
   * Per-signal cooldown (hysteresis): minimum number of steps that must elapse
   * before the SAME signal can intervene again. Different signals are NOT
   * blocked by each other's cooldown — only the global `maxReflectionsPerRun`
   * caps total interventions. Gives the model 2–3 steps to regenerate after a
   * reflection before re-triggering the same signal.
   */
  interventionCooldownSteps: number;
  /**
   * §2.1 — Number of consecutive progress samples with ~zero upward movement
   * required before `progress_stall` fires (goal triggers only).
   */
  progressStallSteps: number;
  /**
   * §2.2 — Minimum successful (non-error) calls of the same tool, all returning
   * trivial/empty results, before `wrong_tool` fires (goal triggers only).
   */
  wrongToolMinTrivialCalls: number;
  /**
   * §2.6 — `isUnrecoverable` thresholds. A run is "unrecoverable" (give up +
   * escalate) only when struggling FAR past the normal reflection thresholds,
   * so a single repair pass would not realistically help. Deliberately
   * conservative — this ends the run early instead of feigning success.
   */
  unrecoverableErrorRate: number;
  /** Minimum tool calls before the sustained-error-rate path can declare unrecoverable. */
  unrecoverableMinToolCalls: number;
  /** Multiplier on `maxToolRepetitions` for the unrecoverable tool-loop path. */
  unrecoverableLoopMultiplier: number;
  /** Multiplier on `maxDelegationFailures` for the unrecoverable delegation path. */
  unrecoverableDelegationMultiplier: number;
  /**
   * §loop_fix.P2c — how many times the SAME tool may return a trivial/empty
   * (non-error) result before the run is declared unrecoverable. A tool that
   * keeps yielding nothing useful is an unproductive loop the model does not
   * recover from by retrying — a STRONGER "not working" signal than raw
   * repetition, so this threshold sits below the raw loop ceiling.
   */
  maxUnproductiveLoopRepetitions: number;
  /**
   * §loop_fix.P2e — how many times the in-flight prepareStep path may fire the
   * SAME "stuck" signal (`tool_loop`, `low_progress`, `high_error_rate`,
   * `delegation_failures`) before the run is declared unrecoverable. This is a
   * STATEFUL backstop independent of the steps-based cuts above: when the forced
   * model keeps failing in a way that does NOT normalize into countable tool
   * RESULTS — malformed tool-call JSON (AI SDK "Error converting tool call input
   * to JSON" → args coerced to `{}` → validation fails) OR flat-progress churn —
   * the steps-based loop/validation/error cuts never trip and the run burns to
   * the wall-clock timeout. The reflector, however, reliably DETECTS the problem
   * and records each intervention, so once it has nudged the SAME stuck signal
   * this many times without recovery, give up.
   */
  maxRepeatedStuckInterventions: number;
}

const DEFAULT_CONFIG: ReflectorConfig = {
  errorRateThreshold: 0.5,
  maxDirectionChanges: 3,
  maxToolRepetitions: 4,
  maxIdenticalToolRepetitions: 3,
  maxReadToolRepetitions: 25,
  maxStepsWithoutProgress: 20,
  maxDelegationFailures: 2,
  warmupSteps: 3,
  maxReflectionsPerRun: 5,
  scopeCreepMultiplier: 3,
  minScopeCreepChars: 2000,
  interventionCooldownSteps: 2,
  progressStallSteps: 3,
  wrongToolMinTrivialCalls: 2,
  unrecoverableErrorRate: 0.8,
  unrecoverableMinToolCalls: 6,
  // §loop_fix.P2c — lowered 3→2 (raw loop ceiling 12→8) because the 300s
  // wall-clock was beating the old ceiling of 12 raw repetitions.
  //
  // NOTE (liveness-budget-plan.md L4): that premise is gone — under
  // FEATURE_LIVENESS_BUDGET a run is bounded by silence, not duration, so the
  // clock no longer pre-empts this ceiling. The value is deliberately NOT
  // restored to 3 yet: cutting a stuck loop early is the safe direction, and
  // raising it costs real tokens, so it should be calibrated on observed runs
  // (plan L5) rather than reverted on principle.
  unrecoverableLoopMultiplier: 2,
  unrecoverableDelegationMultiplier: 3,
  // §loop_fix.P2c — an all-trivial-result loop is unrecoverable at 6 (below the
  // raw ceiling of 8), giving the in-flight tool_loop reflection (fires at 4,
  // re-fires after cooldown) one full nudge cycle before the hard stop.
  maxUnproductiveLoopRepetitions: 6,
  // §loop_fix.P2e — after the prepareStep path has fired the SAME stuck signal 3×
  // (≈ step 8 at the default 2-step cooldown, or ~step 20 for a signal that only
  // warms up later like low_progress) without the run recovering, stop instead of
  // letting the model churn to the 300s timeout. Catches both the malformed-
  // tool-call-JSON loop AND the flat-progress churn the steps-based cuts miss.
  //
  // NOTE (liveness-budget-plan.md L4): under liveness there is no 300s timeout to
  // churn toward, which makes this the *primary* backstop for a model that keeps
  // producing events while getting nowhere — an idle watchdog cannot see that,
  // because churn is not silence. Keep it strict.
  maxRepeatedStuckInterventions: 3,
};

// ── Low-confidence keywords ──────────────────────────────────────────────────

const LOW_CONFIDENCE_PATTERNS = [
  /nie jestem pewien/i,
  /nie wiem/i,
  /spróbuję/i,
  /może to zadziała/i,
  /not sure/i,
  /i('ll)? try/i,
  /might work/i,
  /let me guess/i,
  /uncertain/i,
];

// ── Delegation tool names ────────────────────────────────────────────────────

// §loop_fix.P2d — the reflector sees the tool NAME the LLM uses, which is the
// agent's tool-registration KEY (`delegateTaskTool` / `runWorkerTool`), NOT the
// tool's internal `.id` (`system_delegate_task` / `system_run_worker`). Both
// forms are included so delegation-failure accounting + convergence deliverable
// detection actually match at runtime (previously the id-only set never did).
const DELEGATION_TOOLS = new Set([
  'system_delegate_task',
  'system_run_worker',
  'delegateTaskTool',
  'runWorkerTool',
]);

/**
 * Read-only inspection / exploration tools that an agent legitimately calls
 * many times when navigating multi-file codebases or large specifications.
 * These use `maxReadToolRepetitions` rather than the strict mutating tool limit.
 */
const READ_ONLY_INSPECTION_TOOLS = new Set<string>([
  'read_file',
  'mastra_workspace_read_file',
  'view',
  'find_files',
  'search_content',
  'workspace_search',
  'lsp_inspect',
  'system_memory_recall',
  'memoryRecallTool',
  'currentTimeTool',
  'get_scheduled_task',
  'designFetchBrandAssetsTool',
  'designFetchImagesTool',
  // Web research, search & extraction tools
  'tavily_extract',
  'tavilyExtractTool',
  'search_web',
  'searchWebTool',
  'search_find_company_links',
  'findCompanyLinksTool',
  'firecrawl_scrape',
  'firecrawl_crawl',
  'firecrawl_map',
  // Playwright browser exploration tools
  'browser_navigate',
  'browser_evaluate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_fill',
]);

export function isReadOnlyInspectionTool(toolName?: string | null): boolean {
  if (!toolName) return false;
  return READ_ONLY_INSPECTION_TOOLS.has(toolName);
}

/**
 * Canonical signature for tool call arguments to distinguish identical call loops
 * from progression across distinct targets (e.g. distinct URLs/files).
 */
export function getToolCallArgKey(toolName: string, args?: unknown): string {
  if (args === undefined || args === null) return `${toolName}::null`;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    return `${toolName}::str:${trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed}`;
  }
  if (typeof args === 'object') {
    try {
      const obj = args as Record<string, unknown>;
      // Primary target properties commonly used in tools
      const target = obj.url ?? obj.path ?? obj.file ?? obj.filePath ?? obj.command ?? obj.query ?? obj.leadId ?? obj.taskId;
      if (typeof target === 'string' && target.trim()) {
        const t = target.trim();
        return `${toolName}::target:${t.length > 150 ? t.slice(0, 150) : t}`;
      }
      if (Array.isArray(obj.urls)) {
        return `${toolName}::urls:${(obj.urls as unknown[]).map(String).sort().join(',')}`;
      }
      const sortedKeys = Object.keys(obj).sort();
      const serialized = sortedKeys
        .map((k) => `${k}:${typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : String(obj[k])}`)
        .join('&');
      return `${toolName}::${serialized.length > 200 ? serialized.slice(0, 200) : serialized}`;
    } catch {
      return `${toolName}::unserializable`;
    }
  }
  return `${toolName}::${String(args)}`;
}

/**
 * §loop_fix.P2e — signals that indicate the run is STUCK / not recovering (as
 * opposed to steering signals like `wrong_tool` / `scope_creep` / `low_confidence`
 * that can legitimately fire a few times on a healthy trajectory). When the SAME
 * stuck signal fires `maxRepeatedStuckInterventions` times, `isUnrecoverable`
 * hard-stops the run instead of letting it churn to the wall-clock timeout.
 */
const STUCK_SIGNALS = new Set<ReflectorSignalKind>([
  'tool_loop',
  'progress_stall',
  'low_progress',
  'high_error_rate',
  'delegation_failures',
]);

/** Minimum upward delta in GoalContract progress that counts as "moving". */
const PROGRESS_STALL_EPSILON = 0.01;

/** Tool the reflector forces when a run should escalate to human approval. */
const APPROVAL_TOOL = 'system_request_approval';

/** Max char length for a string result to be considered "trivial/empty". */
const TRIVIAL_RESULT_MAX_CHARS = 8;

const TRIVIAL_RESULT_PATTERNS = [
  /^no results?\b/i,
  /^not found\b/i,
  /^none\b/i,
  /^empty\b/i,
  /^0 results?\b/i,
];

/**
 * §2.2 — Heuristic: did a (non-error) tool result carry no useful payload?
 * Empty arrays, null/undefined, `{ results: [] }` / `count: 0` / `total: 0`
 * envelopes, or trivially short / "no results" strings. Used to detect a tool
 * that "succeeds" without advancing the goal (wrong_tool).
 */
function isTrivialResult(result: unknown): boolean {
  if (result === null || result === undefined) return true;

  if (Array.isArray(result)) return result.length === 0;

  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (trimmed.length === 0 || trimmed.length <= TRIVIAL_RESULT_MAX_CHARS) return true;
    return TRIVIAL_RESULT_PATTERNS.some((p) => p.test(trimmed));
  }

  if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    // Common "empty payload" envelopes.
    for (const key of ['results', 'items', 'data', 'matches', 'rows', 'hits']) {
      const value = record[key];
      if (Array.isArray(value)) return value.length === 0;
    }
    if (typeof record.count === 'number' && record.count === 0) return true;
    if (typeof record.total === 'number' && record.total === 0) return true;
    // An object with literally no own keys is trivial.
    if (Object.keys(record).length === 0) return true;
    return false;
  }

  return false;
}

/**
 * WS-C-hard — a successful Golden Path terminal (`architect_execute_automation_request`
 * or `architect_deploy_automation` returning status tested/draft_created/active) is a
 * usable DELIVERABLE: a real, deployed workflow exists. Recognizing it (alongside
 * delegation/worker deliverables) lets graceful convergence finalize the run instead
 * of churning on repeated execute_automation_request calls after `tested` (the live
 * failure mode: 25× execute after a clean tested). Tolerant of envelope wrapping /
 * partial normalization (direct field access + bounded string fallback) so it fires
 * in both the evaluate and stopWhen windows.
 */
function isAutomationTerminalDeliverable(toolName: string | undefined, result: unknown): boolean {
  if (toolName !== 'architect_execute_automation_request' && toolName !== 'architect_deploy_automation') {
    return false;
  }
  const terminal = (status: unknown): boolean =>
    status === 'tested' || status === 'draft_created' || status === 'active';
  if (result && typeof result === 'object') {
    const r = result as Record<string, any>;
    if (terminal(r.status) || terminal(r.result?.status) || terminal(r.data?.status)) return true;
  }
  try {
    return /"status"\s*:\s*"(tested|draft_created|active)"/.test(JSON.stringify(result).slice(0, 4000));
  } catch {
    return false;
  }
}

/**
 * WS-C-hard refinement — a RESOLVABLE Golden Path gate-block is not a real failure.
 * `node_validation_required`, `pattern_coverage_gap` and `mcp_handoff_failed` are
 * intentional gates the architect resolves in-run (delegate to n8nMcpEngineer →
 * validate → redeploy). Counting them in the error rate wrongly suppressed graceful
 * convergence (the live failure mode: after a successful validated `tested`, the run
 * hung because the earlier node-validation blocks kept errorRate above threshold).
 * Treat them as NEUTRAL so convergence can finalize once a real deliverable exists.
 */
const RESOLVABLE_GATE_FAILURES = new Set([
  'node_validation_required', 'pattern_coverage_gap', 'mcp_handoff_failed',
]);
function isResolvableGateBlock(toolName: string | undefined, result: unknown): boolean {
  if (toolName !== 'architect_execute_automation_request' && toolName !== 'architect_deploy_automation') {
    return false;
  }
  const r = result as any;
  const fc = r?.failureClass ?? r?.result?.failureClass ?? r?.data?.failureClass;
  if (typeof fc === 'string' && RESOLVABLE_GATE_FAILURES.has(fc)) return true;
  try {
    return new RegExp(`"failureClass"\\s*:\\s*"(${[...RESOLVABLE_GATE_FAILURES].join('|')})"`)
      .test(JSON.stringify(result).slice(0, 4000));
  } catch {
    return false;
  }
}

/**
 * Part 3 §3.3B — find the current-phase window for a pipeline run.
 * Scans `steps` backwards for the most recent phase-transition tool call
 * (`statusToolName`, e.g. `chef_set_project_status`) and returns the index of
 * the step that performed it (inclusive) + the phase name from its `status`
 * arg. Fail-open: no transition found → whole history, phase `null`.
 */
function pipelinePhaseBoundary(
  steps: StepHistoryInput[],
  statusToolName: string,
): { startIndex: number; currentPhase: string | null } {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const statusCall = (step?.toolCalls ?? []).find((c) => c.toolName === statusToolName);
    if (!statusCall) continue;
    // Prefer the call's `status` arg; fall back to the tool's returned
    // `{ status }`. Robust to arg-extraction gaps across AI SDK message shapes.
    const args = statusCall.args as Record<string, unknown> | undefined;
    if (typeof args?.status === 'string') return { startIndex: i, currentPhase: args.status as string };
    const statusResult = (step?.toolResults ?? []).find((r) => r.toolName === statusToolName);
    const rv = statusResult?.result as Record<string, unknown> | undefined;
    if (typeof rv?.status === 'string') return { startIndex: i, currentPhase: rv.status as string };
    // Status call present but phase indeterminate here — this IS the boundary
    // step, but we can't name the phase; keep scanning older steps for a named
    // transition (better a slightly wider window than a wrong null-phase one).
  }
  return { startIndex: 0, currentPhase: null };
}

/**
 * §3.3B — strip a built intervention down to the soft levers allowed in pipeline
 * mode (`injectSystem` + `dropTools`). Drops `forceNoTool`/hard levers so a long
 * deterministic state-machine run is never derailed mid-phase.
 */
function toPipelineIntervention(iv: ReflectorIntervention): ReflectorIntervention {
  const soft: ReflectorIntervention = {};
  if (iv.injectSystem) soft.injectSystem = iv.injectSystem;
  if (iv.dropTools?.length) soft.dropTools = iv.dropTools;
  return soft;
}

// ── Shared reflection message builders ───────────────────────────────────────
// Single source of truth for reason/message strings, used by BOTH the
// incremental `analyzeStep` (flag-off telemetry path) and the stateless
// `evaluateHistory` (flag-on prepareStep path) so the two never drift.

interface ReflectionContext {
  loopTool?: string;
  loopCount?: number;
  identicalArgLoop?: boolean;
  loopReasonArg?: string | null;
  errorRate?: number;
  failedToolCalls?: number;
  totalToolCalls?: number;
  directionChanges?: number;
  delegationFailures?: number;
  totalToolArgChars?: number;
  originalPromptChars?: number;
  stepNumber?: number;
}

function buildReflection(
  signal: ReflectorSignalKind,
  ctx: ReflectionContext,
): { reason: string; message: string } {
  switch (signal) {
    case 'tool_loop': {
      const detail = ctx.loopReasonArg
        ? ` with identical target (${ctx.loopReasonArg})`
        : ctx.identicalArgLoop
          ? ' with identical arguments'
          : '';
      return {
        reason: `Tool "${ctx.loopTool}" called ${ctx.loopCount}x${detail} — possible infinite loop detected.`,
        message: [
          `⚠️ STRATEGY REFLECTION: You have called "${ctx.loopTool}" ${ctx.loopCount} times${detail}.`,
          `This pattern suggests you may be in a loop. STOP and consider:`,
          `1. Are you retrying the same call expecting different results?`,
          `2. Is the tool returning the same error each time?`,
          `3. Should you try a completely different approach?`,
          `If the tool keeps failing, change strategy or escalate.`,
        ].join('\n'),
      };
    }
    case 'high_error_rate': {
      const pct = ((ctx.errorRate ?? 0) * 100).toFixed(0);
      return {
        reason: `${pct}% of tool calls returned errors (${ctx.failedToolCalls}/${ctx.totalToolCalls}).`,
        message: [
          `⚠️ STRATEGY REFLECTION: ${ctx.failedToolCalls} of ${ctx.totalToolCalls} tool calls have failed.`,
          `Error rate: ${pct}%. This is too high.`,
          `STOP. Re-evaluate your approach:`,
          `1. Are you using the right tools for this task?`,
          `2. Are your arguments correct?`,
          `3. Is there a prerequisite step you're missing?`,
          `Consider re-planning before making more tool calls.`,
        ].join('\n'),
      };
    }
    case 'direction_instability':
      return {
        reason: `Direction changed ${ctx.directionChanges} times — agent is oscillating between approaches.`,
        message: [
          `⚠️ STRATEGY REFLECTION: You have changed delegation targets ${ctx.directionChanges} times.`,
          `This suggests uncertainty about which agent or approach to use.`,
          `Consider delegating to deliberationAgent for structured analysis,`,
          `or commit to ONE approach and see it through before switching.`,
        ].join('\n'),
      };
    case 'delegation_failures':
      return {
        reason: `${ctx.delegationFailures} delegations returned failure — sub-agents are struggling.`,
        message: [
          `⚠️ STRATEGY REFLECTION: ${ctx.delegationFailures} delegations returned failure.`,
          `The sub-agents may need better context, a different approach, or a simpler task.`,
          `Consider: decompose the task further, provide more context, or try a different agent.`,
        ].join('\n'),
      };
    case 'low_confidence':
      return {
        reason: `Low-confidence language detected after ${ctx.totalToolCalls} tool call(s).`,
        message: [
          `⚠️ STRATEGY REFLECTION: Your response contains low-confidence language after using tools.`,
          `STOP and separate verified evidence from assumptions:`,
          `1. What facts did the tools actually confirm?`,
          `2. What remains unverified?`,
          `3. Should you gather more evidence, re-plan, or be explicit about uncertainty?`,
        ].join('\n'),
      };
    case 'scope_creep':
      return {
        reason: `Tool/delegation argument volume grew to ${ctx.totalToolArgChars} chars from an original prompt of ${ctx.originalPromptChars} chars.`,
        message: [
          `⚠️ STRATEGY REFLECTION: The working scope appears to have expanded significantly.`,
          `Compare the current work against the original user goal before continuing:`,
          `1. Are you solving the requested problem or a larger adjacent problem?`,
          `2. Which current steps are necessary for the original success criteria?`,
          `3. Should you narrow scope, ask for approval, or re-plan?`,
        ].join('\n'),
      };
    case 'wrong_tool':
      return {
        reason: `Tool "${ctx.loopTool}" keeps succeeding with trivial/empty results — likely the wrong tool for this goal.`,
        message: [
          `⚠️ STRATEGY REFLECTION: "${ctx.loopTool}" returned without useful results repeatedly, yet did not error.`,
          `A successful-but-empty result usually means the tool is the wrong fit. STOP and reconsider:`,
          `1. Which tool actually produces the evidence the goal needs?`,
          `2. Are the arguments wrong (filters too narrow, wrong target), or is the tool itself inadequate?`,
          `3. Switch to a better-suited tool or change the approach instead of re-calling this one.`,
        ].join('\n'),
      };
    case 'progress_stall':
      return {
        reason: `Goal progress has not advanced over the last several steps despite successful tool calls.`,
        message: [
          `⚠️ STRATEGY REFLECTION: Your tool calls are succeeding, but the goal is not moving forward.`,
          `This is "productive-looking but fruitless" activity. STOP and re-plan:`,
          `1. What concrete evidence does the success criteria still require?`,
          `2. Which current actions are NOT contributing to that evidence?`,
          `3. Choose a different approach or tool that directly advances the goal.`,
        ].join('\n'),
      };
    case 'converge':
      return {
        reason: `A usable deliverable is already available, but the run keeps working without finalizing — forcing synthesis.`,
        message: [
          `✅ STRATEGY REFLECTION: You already have the results you need from your delegations/workers.`,
          `STOP gathering. Do NOT call any more tools. Produce the FINAL answer to the user's ORIGINAL request now:`,
          `1. Synthesize the deliverable(s) you already received into the requested output.`,
          `2. Any remaining pure-reasoning / text-only subtask can be completed INLINE here — it needs no tools.`,
          `3. Be explicit about anything you could not verify; do not start a new line of investigation.`,
        ].join('\n'),
      };
    case 'low_progress':
    default:
      return {
        reason: `Step ${ctx.stepNumber} reached without clear progress signal.`,
        message: [
          `⚠️ STRATEGY REFLECTION: You are at step ${ctx.stepNumber}.`,
          `This is a high number of steps. Evaluate whether you are making meaningful progress.`,
          `If not, consider: simplifying the approach, asking the user for clarification,`,
          `or presenting what you have so far with a clear statement of what's blocking you.`,
        ].join('\n'),
      };
  }
}

/**
 * Map a signal to its conservative Part 1 intervention levers.
 * - tool_loop  → drop the looping tool (forces a different choice) + inject context
 * - high_error_rate → inject context + force a no-tool re-plan step
 * - everything else → inject context only (soft)
 */
function interventionForSignal(
  signal: ReflectorSignalKind,
  message: string,
  loopTool?: string,
): ReflectorIntervention {
  switch (signal) {
    case 'tool_loop':
      return { injectSystem: message, dropTools: loopTool ? [loopTool] : undefined };
    case 'high_error_rate':
      // `forceNoTool` is a HARD lever and pipeline mode strips it, so for a
      // pipeline agent this signal used to reduce to a text nudge — nothing that
      // could stop a tool from being called again. When the caller identified
      // the tool doing the rejecting, drop it too: a SOFT lever survives
      // pipeline mode and takes the failing option off the table for one step.
      return {
        injectSystem: message,
        forceNoTool: true,
        ...(loopTool ? { dropTools: [loopTool] } : {}),
      };
    case 'wrong_tool':
      // Drop the inadequate tool so the model must pick a better-suited one.
      return { injectSystem: message, dropTools: loopTool ? [loopTool] : undefined };
    case 'progress_stall':
      // Force a no-tool re-plan step so the model reasons about a new approach.
      return { injectSystem: message, forceNoTool: true };
    case 'converge':
      // Force a no-tool synthesis step: the deliverable exists, finalize now.
      return { injectSystem: message, forceNoTool: true };
    default:
      return { injectSystem: message };
  }
}

// ── Strategy Reflector ───────────────────────────────────────────────────────

export class StrategyReflector {
  private stepNumber = 0;
  private totalToolCalls = 0;
  private failedToolCalls = 0;
  private directionChanges = 0;
  private lastTargetAgent: string | null = null;
  private toolCallCounts = new Map<string, number>();
  private identicalCallCounts = new Map<string, { count: number; tool: string; argKey: string }>();
  private delegationFailures = 0;
  private lowConfidenceDetected = false;
  private lowConfidenceTriggered = false;
  private scopeCreepTriggered = false;
  private totalToolArgChars = 0;
  private reflectionsTriggered = 0;
  private triggeredReflections: TriggeredReflection[] = [];
  /** Per-signal step of the last applied intervention (for cooldown/hysteresis). */
  private lastInterventionStepBySignal = new Map<ReflectorSignalKind, number>();

  private readonly config: ReflectorConfig;
  private readonly runId: string;
  private readonly agentId: string;
  private readonly originalPromptChars: number;
  private readonly suppressScopeCreep: boolean;

  constructor(opts: {
    runId: string;
    agentId: string;
    config?: Partial<ReflectorConfig>;
    originalPrompt?: string;
    suppressScopeCreep?: boolean;
  }) {
    this.runId = opts.runId;
    this.agentId = opts.agentId;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.originalPromptChars = opts.originalPrompt?.length ?? 0;
    this.suppressScopeCreep =
      opts.suppressScopeCreep ?? opts.agentId === AUTOMATION_ARCHITECT_AGENT_ID;
  }

  /**
   * Analyze a completed step and decide whether to trigger a reflection.
   * Called from the harness `onStepFinish` hook.
   */
  analyzeStep(input: StepAnalysisInput): ReflectorDecision {
    this.stepNumber++;

    // ── Accumulate signals ──
    this.processToolCalls(input);
    this.processToolResults(input);
    this.processStepText(input);

    // ── Warmup: don't trigger during first N steps ──
    if (this.stepNumber < this.config.warmupSteps) {
      return { action: 'continue', snapshot: this.getSnapshot() };
    }

    // ── Max reflections guard (prevent reflection loops) ──
    if (this.reflectionsTriggered >= this.config.maxReflectionsPerRun) {
      return { action: 'continue', snapshot: this.getSnapshot() };
    }

    // ── Check signals in priority order ──

    // 1. Tool loop detection (most specific, highest priority)
    const loopInfo = this.findToolLoop();
    if (loopInfo) {
      const { reason, message } = buildReflection('tool_loop', {
        loopTool: loopInfo.tool,
        loopCount: loopInfo.count,
        identicalArgLoop: loopInfo.identicalArg,
        loopReasonArg: loopInfo.target,
      });
      return this.trigger('tool_loop', reason, message, loopInfo.tool);
    }

    // 2. High error rate
    if (this.totalToolCalls >= 3 && this.errorRate > this.config.errorRateThreshold) {
      const { reason, message } = buildReflection('high_error_rate', {
        errorRate: this.errorRate,
        failedToolCalls: this.failedToolCalls,
        totalToolCalls: this.totalToolCalls,
      });
      return this.trigger('high_error_rate', reason, message);
    }

    // 3. Direction instability
    if (this.directionChanges > this.config.maxDirectionChanges) {
      const { reason, message } = buildReflection('direction_instability', {
        directionChanges: this.directionChanges,
      });
      return this.trigger('direction_instability', reason, message);
    }

    // 4. Delegation failures
    if (this.delegationFailures > this.config.maxDelegationFailures) {
      const { reason, message } = buildReflection('delegation_failures', {
        delegationFailures: this.delegationFailures,
      });
      return this.trigger('delegation_failures', reason, message);
    }

    // 5. Low-confidence language after tool use
    if (this.lowConfidenceDetected && !this.lowConfidenceTriggered && this.totalToolCalls > 0) {
      this.lowConfidenceTriggered = true;
      const { reason, message } = buildReflection('low_confidence', {
        totalToolCalls: this.totalToolCalls,
      });
      return this.trigger('low_confidence', reason, message);
    }

    // 6. Scope creep via rapidly growing tool/delegation arguments
    if (this.isScopeCreepDetected()) {
      this.scopeCreepTriggered = true;
      const { reason, message } = buildReflection('scope_creep', {
        totalToolArgChars: this.totalToolArgChars,
        originalPromptChars: this.originalPromptChars,
      });
      return this.trigger('scope_creep', reason, message);
    }

    // 7. Low progress (high step count)
    if (this.stepNumber > this.config.maxStepsWithoutProgress) {
      const { reason, message } = buildReflection('low_progress', {
        stepNumber: this.stepNumber,
      });
      return this.trigger('low_progress', reason, message);
    }

    return { action: 'continue', snapshot: this.getSnapshot() };
  }

  /**
   * Stateless evaluation of the FULL step history (Part 1 — prepareStep path).
   *
   * Unlike `analyzeStep` (which mutates instance counters incrementally from
   * `onStepFinish`), this recomputes every signal from the complete `steps`
   * array each call — idempotent and safe to invoke before every step.
   * Returns the highest-priority signal with its in-flight intervention.
   *
   * Per-signal cooldown, the per-run intervention cap, and "trigger once"
   * semantics are handled by the harness (via prepareStep `state` +
   * `recordIntervention`), NOT here — keeping this function pure.
   */
  evaluateHistory(steps: StepHistoryInput[], evalContext?: EvaluateContext): ReflectorDecision {
    // ── Part 3 §3.3B — pipeline mode: count signals PER PHASE (reset on each
    // transition) over the current-phase window, not the whole 150-step run. ──
    const pipelineMode = evalContext?.pipelineMode === true;
    let currentPhase: string | null = null;
    let evalSteps = steps;
    if (pipelineMode && evalContext?.statusToolName) {
      const boundary = pipelinePhaseBoundary(steps, evalContext.statusToolName);
      currentPhase = boundary.currentPhase;
      evalSteps = steps.slice(boundary.startIndex);
    }

    let totalToolCalls = 0;
    let failedToolCalls = 0;
    let directionChanges = 0;
    let delegationFailures = 0;
    let totalToolArgChars = 0;
    let lastTargetAgent: string | null = null;
    let lowConfidenceDetected = false;
    // §A — has any delegation/worker returned a usable (non-error, non-trivial)
    // result yet? Drives the `converge` signal (finalize instead of churn).
    let deliverableSeen = false;
    const toolCallCounts = new Map<string, number>();
    const identicalCallCounts = new Map<string, { count: number; tool: string; argKey: string }>();
    const uniqueArgsByTool = new Map<string, Set<string>>();
    // §2.2 — per-tool successful-call vs trivial-result tracking for wrong_tool.
    const successCountByTool = new Map<string, number>();
    const trivialSuccessByTool = new Map<string, number>();
    // Per-tool input-validation rejections. When EVERY call fails, the
    // high_error_rate signal fires first and used to carry no tool to drop, so
    // the only lever left was a text nudge. Tracking the offender lets that
    // signal name it. Measured 2026-08-19: 145 consecutive `chef_draft_recipe`
    // calls with empty arguments, each rejected identically, none prevented.
    const validationFailuresByTool = new Map<string, number>();

    for (const step of evalSteps) {
      for (const tc of step.toolCalls ?? []) {
        const name = tc.toolName;
        if (!name) continue;
        totalToolCalls++;
        toolCallCounts.set(name, (toolCallCounts.get(name) ?? 0) + 1);
        totalToolArgChars += safeJsonLength(tc.args);

        const argKey = getToolCallArgKey(name, tc.args);
        const existingIdentical = identicalCallCounts.get(argKey);
        if (existingIdentical) {
          existingIdentical.count++;
        } else {
          identicalCallCounts.set(argKey, { count: 1, tool: name, argKey });
        }
        if (!uniqueArgsByTool.has(name)) {
          uniqueArgsByTool.set(name, new Set());
        }
        uniqueArgsByTool.get(name)!.add(argKey);

        if (DELEGATION_TOOLS.has(name)) {
          const args = tc.args as Record<string, unknown> | undefined;
          const targetAgent = (args?.targetAgentId as string | undefined)
            ?? (args?.agentId as string | undefined)
            ?? (args?.targetAgent as string | undefined);
          if (targetAgent && lastTargetAgent && targetAgent !== lastTargetAgent) {
            directionChanges++;
          }
          if (targetAgent) lastTargetAgent = targetAgent;
        }
      }
      for (const tr of step.toolResults ?? []) {
        const failed = tr.isError || isFailureResult(tr.result);
        if (failed) {
          // WS-C-hard refinement — don't let resolvable Golden Path gate-blocks
          // (node validation / coverage gap / mcp handoff) inflate the error rate
          // and suppress convergence; the architect resolves them in-run.
          if (isResolvableGateBlock(tr.toolName, tr.result)) continue;
          failedToolCalls++;
          if (tr.toolName && isValidationFailureResult(tr.result)) {
            validationFailuresByTool.set(
              tr.toolName,
              (validationFailuresByTool.get(tr.toolName) ?? 0) + 1,
            );
          }
          if (DELEGATION_TOOLS.has(tr.toolName)) delegationFailures++;
        } else if (tr.toolName) {
          successCountByTool.set(tr.toolName, (successCountByTool.get(tr.toolName) ?? 0) + 1);
          if (isTrivialResult(tr.result)) {
            trivialSuccessByTool.set(tr.toolName, (trivialSuccessByTool.get(tr.toolName) ?? 0) + 1);
          } else if (DELEGATION_TOOLS.has(tr.toolName) || isAutomationTerminalDeliverable(tr.toolName, tr.result)) {
            // §A — a successful, non-trivial delegation/worker result OR a Golden
            // Path terminal (tested/draft_created/active) is a usable deliverable
            // the agent can synthesize from. WS-C-hard recognizes the Golden Path
            // terminal so convergence finalizes instead of churning on execute.
            deliverableSeen = true;
          }
        }
      }
      if (step.stepText && LOW_CONFIDENCE_PATTERNS.some((p) => p.test(step.stepText!))) {
        lowConfidenceDetected = true;
      }
    }

    // WS-C-hard — the run-scoped deliverable latch (set deterministically by the
    // Golden Path on a tested/draft_created/active workflow) is authoritative; it
    // does not depend on parsing a possibly-compacted/normalized step result.
    const automationDeliverableStatus = getAutomationDeliverableStatus();
    const terminalAutomationDeliverableSeen =
      automationDeliverableStatus === 'tested' || automationDeliverableStatus === 'active';
    deliverableSeen = deliverableSeen || automationDeliverableStatus !== null || hasAutomationDeliverable();

    const stepNumber = steps.length;
    const errorRate = totalToolCalls === 0 ? 0 : failedToolCalls / totalToolCalls;
    const repetitions: Record<string, number> = {};
    for (const [tool, count] of toolCallCounts) {
      if (count > 1) repetitions[tool] = count;
    }
    const snapshot: ReflectorSnapshot = {
      stepNumber,
      totalToolCalls,
      failedToolCalls,
      errorRate,
      directionChanges,
      toolRepetitions: repetitions,
      delegationFailures,
      lowConfidenceDetected,
      reflectionsTriggered: this.reflectionsTriggered,
    };

    const cont = (): ReflectorDecision => ({ action: 'continue', snapshot });

    // ── Warmup ── In pipeline mode the window resets each phase, so warm up
    // against the per-phase window length (give each phase room before firing).
    const warmupBasis = pipelineMode ? evalSteps.length : stepNumber;
    if (warmupBasis < this.config.warmupSteps) return cont();

    // §3.3B — name the phase-appropriate tools (if supplied) in the reflection,
    // so the model is told WHICH tools to reach for in THIS phase.
    const phaseToolsHint = pipelineMode && evalContext?.phaseTools?.length
      ? `\nTools appropriate for the current phase${currentPhase ? ` (${currentPhase})` : ''}: ${evalContext.phaseTools.join(', ')}.`
      : '';

    const hardLeversEnabled = !pipelineMode && evalContext?.hardLeversEnabled === true;
    const build = (
      signal: ReflectorSignalKind,
      ctx: ReflectionContext,
      dropTool?: string,
      hardLevers?: Partial<ReflectorIntervention>,
    ): ReflectorDecision => {
      const { reason, message: baseMessage } = buildReflection(signal, ctx);
      const message = baseMessage + phaseToolsHint;
      let intervention = interventionForSignal(signal, message, dropTool);
      // §2.5 — only layer hard levers when explicitly enabled (high confidence).
      if (hardLeversEnabled && hardLevers) Object.assign(intervention, hardLevers);
      // §3.3B — pipeline mode: soft levers ONLY (injectSystem + dropTools).
      if (pipelineMode) intervention = toPipelineIntervention(intervention);
      return { action: 'inject_reflection', signal, reason, message, intervention, snapshot };
    };

    // ── Ordered checks (same priority/thresholds as analyzeStep) ──
    // A terminal automation deliverable (`tested`/`active`) is higher-confidence
    // than loop signals. Once it exists, the correct next step is a no-tool final
    // report, not more repair/search/deploy churn.
    if (
      evalContext?.convergenceEnabled
      && !pipelineMode
      && terminalAutomationDeliverableSeen
      && totalToolCalls >= 3
      && errorRate <= this.config.errorRateThreshold
    ) {
      return build('converge', { totalToolCalls });
    }

    let loopTool: string | null = null;
    let loopCount = 0;
    let identicalArgLoop = false;
    let loopReasonArg: string | null = null;

    // Check 1: Identical Argument Loop (High confidence stagnation, e.g. 3x same URL or same exact command)
    for (const [argKey, entry] of identicalCallCounts.entries()) {
      if (entry.count >= this.config.maxIdenticalToolRepetitions) {
        loopTool = entry.tool;
        loopCount = entry.count;
        identicalArgLoop = true;
        loopReasonArg = argKey.includes('::target:') ? argKey.split('::target:')[1] : null;
        break;
      }
    }

    // Check 2: Raw tool repetition ceiling (when arguments are distinct or general limit exceeded)
    if (!loopTool) {
      for (const [tool, count] of toolCallCounts) {
        const threshold = isReadOnlyInspectionTool(tool)
          ? (this.config.maxReadToolRepetitions ?? 25)
          : this.config.maxToolRepetitions;
        if (count >= threshold) {
          loopTool = tool;
          loopCount = count;
          break;
        }
      }
    }

    if (loopTool) {
      const threshold = isReadOnlyInspectionTool(loopTool)
        ? (this.config.maxReadToolRepetitions ?? 25)
        : (identicalArgLoop ? this.config.maxIdenticalToolRepetitions : this.config.maxToolRepetitions);
      const severe = loopCount >= threshold * 2;
      return build(
        'tool_loop',
        { loopTool, loopCount, identicalArgLoop, loopReasonArg },
        loopTool,
        severe ? { escalateModel: true } : undefined,
      );
    }

    if (totalToolCalls >= 3 && errorRate > this.config.errorRateThreshold) {
      // If one tool is responsible for the rejections, name it so the caller can
      // stop offering it for a step. Without this the signal says only "your
      // error rate is high" and hands back nothing actionable — which is how a
      // tool rejecting empty arguments kept being called until the wall clock.
      //
      // The threshold is DELIBERATELY well above the generic loop threshold.
      // Measured 2026-08-19: a model that could not serialize a large nested
      // tool schema emitted ten rejected calls and then produced five perfect
      // ones — the failure is transient and it retries out of it. Cutting inside
      // that band would destroy work that was about to land. The costs are
      // asymmetric: firing late only delays detection of a stuck run, firing
      // early kills a healthy one.
      const rejectionCut = this.config.maxToolRepetitions * 2;
      let rejectedTool: string | null = null;
      for (const [tool, count] of validationFailuresByTool) {
        if (count >= rejectionCut) { rejectedTool = tool; break; }
      }
      return build(
        'high_error_rate',
        { errorRate, failedToolCalls, totalToolCalls, ...(rejectedTool ? { loopTool: rejectedTool } : {}) },
        rejectedTool ?? undefined,
      );
    }

    // ── Part 2 §2.1/2.2 + Part 3 §3.3B — wrong_tool fires under GoalContract
    // triggers OR pipeline mode (where it is the MAIN signal: "źle dobrać
    // narzędzie"). progress_stall stays GoalContract-only (no contract in
    // pipelines). ──
    if (evalContext?.goalTriggersEnabled || pipelineMode) {
      // wrong_tool: a tool keeps "succeeding" (no error) but returns trivial/empty
      // results — the model is pushing an inadequate tool instead of changing
      // approach. Distinct from tool_loop (which counts errors + raw repetition).
      let wrongTool: string | null = null;
      for (const [tool, successCount] of successCountByTool) {
        const trivial = trivialSuccessByTool.get(tool) ?? 0;
        if (successCount >= this.config.wrongToolMinTrivialCalls && trivial === successCount) {
          wrongTool = tool;
          break;
        }
      }
      if (wrongTool && errorRate <= this.config.errorRateThreshold) {
        return build('wrong_tool', { loopTool: wrongTool, totalToolCalls }, wrongTool);
      }
    }

    // ── §A — graceful convergence ──
    // A usable deliverable already exists (a successful, non-trivial
    // delegation/worker result) but the run keeps churning instead of finalizing.
    // Preempt the soft "re-plan / narrow scope" signals (progress_stall /
    // scope_creep / low_confidence / low_progress) with a "finalize now" no-tool
    // synthesis. Guards against premature cut-off: only after the reflector has
    // ALREADY nagged at least twice (so a healthy short run is never truncated),
    // only for low-error trajectories, and only when delegation work succeeded.
    if (
      evalContext?.convergenceEnabled
      && !pipelineMode
      && deliverableSeen
      && this.reflectionsTriggered >= 2
      && totalToolCalls >= 3
      && errorRate <= this.config.errorRateThreshold
    ) {
      return build('converge', { totalToolCalls });
    }

    // progress_stall: GoalContract progress has not moved upward over the last
    // K samples despite productive (low-error) tool activity. GoalContract-only
    // (skipped in pipeline mode — pipelines have no GoalContract).
    if (evalContext?.goalTriggersEnabled && !pipelineMode) {
      const samples = evalContext.progressSamples ?? [];
      const window = this.config.progressStallSteps;
      if (
        samples.length >= window + 1
        && totalToolCalls >= 3
        && errorRate <= this.config.errorRateThreshold
      ) {
        const recent = samples.slice(-(window + 1));
        let movedUp = false;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i]! - recent[i - 1]! > PROGRESS_STALL_EPSILON) { movedUp = true; break; }
        }
        if (!movedUp) {
          // Persistent stall (flat well beyond the minimum window) → escalate the
          // model for the forced re-plan step.
          const persistent = samples.length >= window * 2;
          return build('progress_stall', { stepNumber, totalToolCalls }, undefined, persistent ? { escalateModel: true } : undefined);
        }
      }
    }

    // ── §3.3B — the remaining signals are DISABLED in pipeline mode: a long
    // deterministic state machine legitimately changes direction (driven by the
    // state machine), runs 150 steps, and accumulates large arg volume — none of
    // those are anomalies for a pipeline. Only tool_loop / high_error_rate /
    // wrong_tool (above, per-phase) apply. ──
    if (!pipelineMode) {
      if (directionChanges > this.config.maxDirectionChanges) {
        return build('direction_instability', { directionChanges });
      }

      if (delegationFailures > this.config.maxDelegationFailures) {
        // High confidence the agent cannot self-recover delegation → force a human
        // approval/escalation tool instead of letting it keep failing.
        const severe = delegationFailures >= this.config.maxDelegationFailures * 2;
        return build('delegation_failures', { delegationFailures }, undefined, severe ? { forceTool: APPROVAL_TOOL } : undefined);
      }

      if (lowConfidenceDetected && totalToolCalls > 0) {
        return build('low_confidence', { totalToolCalls });
      }

      if (
        evalContext?.suppressScopeCreep !== true
        && !this.suppressScopeCreep
        && this.originalPromptChars > 0
        && totalToolCalls >= 3
        && totalToolArgChars >= this.config.minScopeCreepChars
        && totalToolArgChars > this.originalPromptChars * this.config.scopeCreepMultiplier
      ) {
        return build('scope_creep', { totalToolArgChars, originalPromptChars: this.originalPromptChars });
      }

      if (stepNumber > this.config.maxStepsWithoutProgress) {
        return build('low_progress', { stepNumber });
      }
    }

    return cont();
  }

  /**
   * §2.6 — Stateless "give up and escalate" predicate for `stopWhen`.
   *
   * Recomputed from the FULL history every call (consistent with
   * `evaluateHistory`). Returns true ONLY when the run is struggling far past
   * the normal reflection thresholds, so a soft in-flight repair has already
   * had its chance and would not realistically recover. The harness uses this
   * to end the run early with an explicit blocker (and escalate for delegated
   * work) instead of burning the rest of `maxSteps` to feign success.
   *
   * `maxSteps` from the depth profile remains the hard step-count backstop —
   * this predicate is purely about unrecoverable *quality* of the trajectory.
   */
  isUnrecoverable(steps: StepHistoryInput[]): boolean {
    let totalToolCalls = 0;
    let failedToolCalls = 0;
    let delegationFailures = 0;
    const toolCallCounts = new Map<string, number>();
    // §P2b.2 — per-tool count of tool-input validation failures (e.g. a strict
    // MCP schema repeatedly rejecting a guessed param name). An unrepairable
    // schema wall stops the run quickly instead of burning the step budget.
    const validationFailuresByTool = new Map<string, number>();
    // §loop_fix.P2d — total validation failures across ALL tools. A model that
    // cannot form valid tool arguments (e.g. emitting `delegateTaskTool({})` then
    // `runWorkerTool({})` in turn) splits the per-tool counter, so the run is also
    // unrecoverable when the GLOBAL count is high regardless of which tool failed.
    let totalValidationFailures = 0;
    // §loop_fix.P2c — per-tool count of TRIVIAL (empty/no-op) non-error results.
    // A tool that keeps returning nothing useful (e.g. MCP `notebook_query`
    // querying notebook after notebook with empty hits) is an unproductive loop
    // distinct from an error loop — `isFailureResult` / `isError` do not flag it.
    const trivialResultsByTool = new Map<string, number>();

    for (const step of steps) {
      for (const tc of step.toolCalls ?? []) {
        if (!tc.toolName) continue;
        totalToolCalls++;
        toolCallCounts.set(tc.toolName, (toolCallCounts.get(tc.toolName) ?? 0) + 1);
      }
      for (const tr of step.toolResults ?? []) {
        const isErr = tr.isError || isFailureResult(tr.result);
        if (isErr) {
          failedToolCalls++;
          if (DELEGATION_TOOLS.has(tr.toolName)) delegationFailures++;
        }
        if (tr.toolName && isValidationFailureResult(tr.result)) {
          validationFailuresByTool.set(tr.toolName, (validationFailuresByTool.get(tr.toolName) ?? 0) + 1);
          totalValidationFailures++;
        }
        // A trivial result only counts as unproductive when it is NOT already an
        // error (errors are handled by the error-rate path) and not a delegation
        // tool (delegations have their own failure accounting).
        if (tr.toolName && !isErr && !DELEGATION_TOOLS.has(tr.toolName) && isTrivialResult(tr.result)) {
          trivialResultsByTool.set(tr.toolName, (trivialResultsByTool.get(tr.toolName) ?? 0) + 1);
        }
      }
    }

    // §loop_fix.P2e — STATEFUL backstop, evaluated FIRST so it fires even when
    // the steps below don't faithfully represent the failures. When the forced
    // model emits malformed tool-call JSON, AI SDK coerces the args to `{}` and
    // the resulting validation failures do not always normalize into countable
    // tool RESULTS — and a flat-progress churn produces "successful" steps that
    // advance nothing — so `totalToolCalls` can even be 0 (or all-benign) here
    // while the run is in fact stuck. The in-flight prepareStep path DOES detect
    // these and records each intervention on this (per-run singleton) instance,
    // so once it has nudged the SAME stuck signal past the threshold, the
    // trajectory is unrecoverable regardless of what the normalized steps show.
    const stuckInterventionCounts = new Map<ReflectorSignalKind, number>();
    for (const r of this.triggeredReflections) {
      if (!STUCK_SIGNALS.has(r.signal)) continue;
      stuckInterventionCounts.set(r.signal, (stuckInterventionCounts.get(r.signal) ?? 0) + 1);
    }
    for (const count of stuckInterventionCounts.values()) {
      if (count >= this.config.maxRepeatedStuckInterventions) return true;
    }

    if (totalToolCalls === 0) return false;

    // 0) §P2b.2 — the SAME tool keeps failing input validation (>= maxToolRepetitions
    // times). This is below the raw loop ceiling (maxToolRepetitions *
    // unrecoverableLoopMultiplier) but a repeated, identical schema rejection is
    // not something the model recovers from by retrying — cut fast. The in-flight
    // reflection (which now sees these as errors) still gets its earlier chances
    // before this threshold is reached.
    for (const count of validationFailuresByTool.values()) {
      if (count >= this.config.maxToolRepetitions) return true;
    }

    // 0a) §loop_fix.P2d — validation failures spread ACROSS tools (the model
    // cannot form valid arguments for anything). Same threshold as the per-tool
    // cut so an alternating delegateTaskTool({})/runWorkerTool({}) loop is caught.
    if (totalValidationFailures >= this.config.maxToolRepetitions) return true;

    // 0b) §loop_fix.P2c — the SAME tool keeps returning trivial/empty results.
    // This is an unproductive loop (the model isn't getting anywhere) and is a
    // stronger signal than raw repetition, so it cuts below the raw ceiling.
    for (const count of trivialResultsByTool.values()) {
      if (count >= this.config.maxUnproductiveLoopRepetitions) return true;
    }

    // 1) A tool looped catastrophically (far past the loop-detection threshold).
    for (const [tool, count] of toolCallCounts.entries()) {
      const threshold = isReadOnlyInspectionTool(tool)
        ? (this.config.maxReadToolRepetitions ?? 25)
        : this.config.maxToolRepetitions;
      const loopCeiling = threshold * this.config.unrecoverableLoopMultiplier;
      if (count >= loopCeiling) return true;
    }

    // 2) Sustained very-high error rate over a meaningful number of calls.
    const errorRate = failedToolCalls / totalToolCalls;
    if (
      totalToolCalls >= this.config.unrecoverableMinToolCalls
      && errorRate >= this.config.unrecoverableErrorRate
    ) {
      return true;
    }

    // 3) Delegations keep failing far past the self-recovery threshold.
    if (delegationFailures >= this.config.maxDelegationFailures * this.config.unrecoverableDelegationMultiplier) {
      return true;
    }

    return false;
  }

  /**
   * §A — graceful convergence stop for `stopWhen`.
   *
   * Returns true when the run has ALREADY produced a usable deliverable (a
   * successful, non-trivial delegation/worker result) AND the reflector has
   * exhausted its nag budget without the agent self-terminating — the
   * post-deliverable churn pattern (scope_creep / progress_stall / low_confidence
   * on a loop) that otherwise runs to the wall-clock timeout because the
   * never-passing completion scorer keeps re-iterating.
   *
   * Unlike `isUnrecoverable` (hard failure → error blocker), this is a SUCCESSFUL
   * stop: the harness must NOT stamp an error blocker, so the best answer so far
   * is returned verbatim. High-error trajectories are excluded here — those are
   * `isUnrecoverable`'s job.
   */
  shouldConvergeStop(steps: StepHistoryInput[]): boolean {
    // Only give up churning after the reflector has fully spent its nag budget.
    if (!this.isReflectionBudgetExhausted()) return false;

    // Stateful convergence backstop: a recorded `converge` intervention is only
    // produced after `evaluateHistory` has already seen a non-trivial delegation
    // or worker deliverable. Trust that earlier observation even if Mastra's later
    // stopWhen step window no longer normalizes the tool result faithfully.
    const convergeAlreadyTriggered = this.triggeredReflections.some((r) => r.signal === 'converge');

    let totalToolCalls = 0;
    let failedToolCalls = 0;
    let deliverableSeen = false;
    for (const step of steps) {
      for (const tc of step.toolCalls ?? []) {
        if (tc.toolName) totalToolCalls++;
      }
      for (const tr of step.toolResults ?? []) {
        if (tr.isError || isFailureResult(tr.result)) {
          // WS-C-hard refinement — resolvable gate-blocks are neutral, not failures.
          if (isResolvableGateBlock(tr.toolName, tr.result)) continue;
          failedToolCalls++;
        } else if (
          (DELEGATION_TOOLS.has(tr.toolName) && !isTrivialResult(tr.result))
          || isAutomationTerminalDeliverable(tr.toolName, tr.result)
        ) {
          deliverableSeen = true;
        }
      }
    }

    // WS-C-hard — authoritative run-scoped deliverable latch (compaction-independent).
    deliverableSeen = deliverableSeen || hasAutomationDeliverable();

    if (convergeAlreadyTriggered) {
      if (totalToolCalls > 0 && failedToolCalls / totalToolCalls > this.config.errorRateThreshold) return false;
      return true;
    }

    if (totalToolCalls === 0 || !deliverableSeen) return false;
    // A high-error run is "unrecoverable", not "converged" — leave it to (2)/(3).
    if (failedToolCalls / totalToolCalls > this.config.errorRateThreshold) return false;
    return true;
  }

  /**
   * Register an intervention that was applied in-flight via prepareStep, so
   * `getTriggeredReflections()` stays populated for post-run passes and
   * telemetry. Also fires depth escalation + the reflector_triggered event
   * (mirrors `trigger`, but for the stateless path).
   */
  recordIntervention(decision: ReflectorDecision, stepNumber: number): void {
    if (decision.action !== 'inject_reflection' || !decision.signal) return;
    this.reflectionsTriggered++;
    this.lastInterventionStepBySignal.set(decision.signal, stepNumber);
    const snapshot = decision.snapshot ?? this.getSnapshot();
    const reason = decision.reason ?? '';
    const message = decision.message ?? decision.intervention?.injectSystem ?? '';

    this.applySignalSideEffects(decision.signal, reason, { ...snapshot, stepNumber });

    this.triggeredReflections.push({
      signal: decision.signal,
      reason,
      message,
      stepNumber,
      snapshot,
    });
  }

  /** Number of reflections/interventions triggered so far this run. */
  get interventionCount(): number {
    return this.reflectionsTriggered;
  }

  /** Whether the per-run reflection budget is exhausted. */
  isReflectionBudgetExhausted(): boolean {
    return this.reflectionsTriggered >= this.config.maxReflectionsPerRun;
  }

  /**
   * Per-signal cooldown (hysteresis) gate. Returns true while the SAME signal
   * is still within `interventionCooldownSteps` of its last intervention, so
   * the harness should skip re-injecting it. Different signals are unaffected —
   * a `tool_loop` intervention does NOT block a later `high_error_rate`.
   */
  isSignalInCooldown(signal: ReflectorSignalKind, stepNumber: number): boolean {
    const last = this.lastInterventionStepBySignal.get(signal);
    if (last === undefined) return false;
    return stepNumber - last < this.config.interventionCooldownSteps;
  }

  /**
   * Get current signal snapshot for diagnostics.
   */
  getSnapshot(): ReflectorSnapshot {
    const repetitions: Record<string, number> = {};
    for (const [tool, count] of this.toolCallCounts) {
      if (count > 1) repetitions[tool] = count;
    }

    return {
      stepNumber: this.stepNumber,
      totalToolCalls: this.totalToolCalls,
      failedToolCalls: this.failedToolCalls,
      errorRate: this.errorRate,
      directionChanges: this.directionChanges,
      toolRepetitions: repetitions,
      delegationFailures: this.delegationFailures,
      lowConfidenceDetected: this.lowConfidenceDetected,
      reflectionsTriggered: this.reflectionsTriggered,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private get errorRate(): number {
    return this.totalToolCalls === 0 ? 0 : this.failedToolCalls / this.totalToolCalls;
  }

  private processToolCalls(input: StepAnalysisInput): void {
    for (const tc of input.toolCalls) {
      const name = tc.toolName;
      if (!name) continue;

      this.totalToolCalls++;
      this.toolCallCounts.set(name, (this.toolCallCounts.get(name) ?? 0) + 1);
      this.totalToolArgChars += safeJsonLength(tc.args);

      const argKey = getToolCallArgKey(name, tc.args);
      const existing = this.identicalCallCounts.get(argKey);
      if (existing) {
        existing.count++;
      } else {
        this.identicalCallCounts.set(argKey, { count: 1, tool: name, argKey });
      }

      // Track direction changes via delegation tools
      if (DELEGATION_TOOLS.has(name)) {
        const args = tc.args as Record<string, unknown> | undefined;
        const targetAgent = args?.targetAgentId as string | undefined
          ?? args?.agentId as string | undefined
          ?? args?.targetAgent as string | undefined;
        if (targetAgent && this.lastTargetAgent && targetAgent !== this.lastTargetAgent) {
          this.directionChanges++;
        }
        if (targetAgent) {
          this.lastTargetAgent = targetAgent;
        }
      }
    }
  }

  private processToolResults(input: StepAnalysisInput): void {
    for (const tr of input.toolResults) {
      const failed = tr.isError || isFailureResult(tr.result);
      if (failed) {
        this.failedToolCalls++;
      }

      // Check delegation results for success: false
      if (DELEGATION_TOOLS.has(tr.toolName)) {
        if (failed) {
          this.delegationFailures++;
        }
      }
    }
  }

  private processStepText(input: StepAnalysisInput): void {
    if (!input.stepText) return;
    if (LOW_CONFIDENCE_PATTERNS.some((p) => p.test(input.stepText!))) {
      this.lowConfidenceDetected = true;
    }
  }

  private findToolLoop(): { tool: string; count: number; identicalArg: boolean; target?: string } | null {
    // 1) Identical call loop (High confidence stagnation, e.g. 3x same URL or same command)
    for (const [argKey, entry] of this.identicalCallCounts.entries()) {
      if (entry.count >= this.config.maxIdenticalToolRepetitions) {
        const target = argKey.includes('::target:') ? argKey.split('::target:')[1] : undefined;
        return { tool: entry.tool, count: entry.count, identicalArg: true, target };
      }
    }
    // 2) Raw tool repetition ceiling (when not an identical argument loop)
    for (const [tool, count] of this.toolCallCounts) {
      const threshold = isReadOnlyInspectionTool(tool)
        ? (this.config.maxReadToolRepetitions ?? 25)
        : this.config.maxToolRepetitions;
      if (count >= threshold) {
        return { tool, count, identicalArg: false };
      }
    }
    return null;
  }

  private isScopeCreepDetected(): boolean {
    if (this.suppressScopeCreep) return false;
    if (this.scopeCreepTriggered) return false;
    if (this.originalPromptChars <= 0) return false;
    if (this.totalToolCalls < 3) return false;
    if (this.totalToolArgChars < this.config.minScopeCreepChars) return false;
    return this.totalToolArgChars > this.originalPromptChars * this.config.scopeCreepMultiplier;
  }

  private trigger(
    signal: ReflectorSignalKind,
    reason: string,
    message: string,
    dropTool?: string,
  ): ReflectorDecision {
    this.reflectionsTriggered++;
    const snapshot = this.getSnapshot();

    this.applySignalSideEffects(signal, reason, snapshot);

    const decision = {
      action: 'inject_reflection',
      signal,
      reason,
      message,
      intervention: interventionForSignal(signal, message, dropTool),
      snapshot,
    } satisfies ReflectorDecision;

    this.triggeredReflections.push({
      signal,
      reason,
      message,
      stepNumber: snapshot.stepNumber,
      snapshot,
    });

    return decision;
  }

  /**
   * Shared side-effects for a triggered signal: depth escalation, telemetry,
   * console warning. Used by both `trigger` (incremental) and
   * `recordIntervention` (stateless prepareStep path).
   */
  private applySignalSideEffects(
    signal: ReflectorSignalKind,
    reason: string,
    snapshot: ReflectorSnapshot,
  ): void {
    // ── Phase 4: Auto-escalate depth on anomaly ──
    const currentDepth = getRunDepth(this.runId);
    if (currentDepth === 'fast') {
      upgradeRunDepth(this.runId, 'standard', `Reflector triggered: ${signal}`, this.agentId);
    } else if (currentDepth === 'standard' && (signal === 'direction_instability' || signal === 'delegation_failures')) {
      upgradeRunDepth(this.runId, 'deep', `Reflector escalation: ${signal}`, this.agentId);
    }

    // Fire-and-forget telemetry. Tests can disable this to avoid opening Mongo handles.
    if (process.env.DISABLE_REFLECTOR_TELEMETRY !== '1') {
      logHarnessEvent({
        type: 'reflector_triggered' as any,
        agentId: this.agentId,
        runId: this.runId,
        status: 'pending',
        data: {
          signal,
          reason,
          stepNumber: snapshot.stepNumber,
          snapshot,
        },
      }).catch(() => { /* non-critical */ });
    }

    console.warn(
      `[StrategyReflector] 🪞 TRIGGERED (${signal}) at step ${snapshot.stepNumber}: ${reason}`,
    );
  }

  getTriggeredReflections(): TriggeredReflection[] {
    return [...this.triggeredReflections];
  }
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return 0;
  }
}

/**
 * Maximum length of a string tool result we are willing to inspect for
 * failure substrings. Anything larger is treated as free-text output (prose,
 * file dumps, etc.) where a bare "failed"/"error" mention is NOT evidence of an
 * actual tool failure.
 */
const MAX_INSPECTABLE_RESULT_CHARS = 2000;

/**
 * §P2b — tool-input validation failure signatures. Shared by Mastra's own
 * schema guard and strict (MCP) JSON-schema rejections — e.g. a NotebookLM tool
 * that requires snake_case `notebook_id` rejecting a camelCase `notebookId` with
 * `must NOT have additional properties`. Such a failure may arrive as a plain
 * string/object result WITHOUT an error envelope, so it is detected separately
 * from `isFailureResult` and used to (a) count the result as an error and (b)
 * trip the fast unrecoverable cut when the same tool keeps failing validation.
 */
const TOOL_VALIDATION_FAILURE_PATTERNS = [
  /tool input validation failed/i,
  /invalid arguments for tool/i,
  /invalidtoolinput/i,
  /must not have additional properties/i,
  /must have required propert/i, // "property" / "properties"
];

/** True when a tool RESULT carries a tool-input validation failure message. */
export function isValidationFailureResult(result: unknown): boolean {
  let text: string | null = null;
  if (typeof result === 'string') {
    text = result;
  } else if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    // §loop_fix.P2d — Mastra's tool-input validation envelope is returned (not
    // thrown) AS the tool result: `{ error: true, message, validationErrors }`
    // (see @mastra/core validateToolInput + isValidationError). The `error` field
    // is a BOOLEAN `true`, so it must NOT be treated as the message string —
    // detect the structural marker directly.
    if (record.error === true && 'validationErrors' in record) return true;
    // Otherwise pick the first STRING-typed message-like field. A boolean
    // `error: true` previously short-circuited the `??` chain and hid the real
    // message in `record.message`, so this run-stopper never fired.
    const candidate =
      (typeof record.message === 'string' && record.message)
      || (typeof record.error === 'string' && record.error)
      || (typeof record.text === 'string' && record.text)
      || null;
    if (candidate) text = candidate;
  }
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INSPECTABLE_RESULT_CHARS) return false;
  return TOOL_VALIDATION_FAILURE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Single definition of truth for "did this tool result represent a failure?".
 *
 * §2.3 — Structural signals first; string matching only for small, JSON-like
 * payloads. We deliberately do NOT do bare `.includes('failed')` / `'error:'`
 * on free text, because that produces false positives for benign output such as
 * `"failedSteps: 0"`, `"no errors"`, or `"error handling works"`.
 *
 * Shared with the harness (imported by generate-with-harness.ts) so the
 * reflector and the goal-completion repair pass agree on what counts as a
 * failure.
 */
export function isFailureResult(result: unknown): boolean {
  // ── Structural signals (most reliable) ──
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (record.isError === true) return true;
    if (record.success === false) return true;
    if (record.status === 'error' || record.status === 'failed') return true;
    if (record.error != null) return true;
    // AI SDK tool-result envelopes: { type: 'error-text' | 'error-json', value }
    if (typeof record.type === 'string' && record.type.startsWith('error')) return true;
    return false;
  }

  if (typeof result !== 'string') return false;

  // ── String results: only inspect small, JSON-like payloads ──
  const trimmed = result.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INSPECTABLE_RESULT_CHARS) return false;
  const looksJsonLike = (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksJsonLike) return false;

  // Prefer parsing so we reuse the structural path; fall back to a conservative
  // substring check only for the structured failure keys.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return isFailureResult(parsed);
    }
  } catch {
    // not valid JSON — fall through
  }
  const compact = trimmed.replace(/\s+/g, '').toLowerCase();
  return compact.includes('"success":false')
    || compact.includes('"status":"error"')
    || compact.includes('"status":"failed"');
}

// ── Run-scoped instance management ───────────────────────────────────────────

const _instances = new Map<string, StrategyReflector>();

/**
 * Get or create a StrategyReflector for a specific run.
 * Each agent run gets its own reflector instance to track signals independently.
 */
export function getReflector(opts: {
  runId: string;
  agentId: string;
  config?: Partial<ReflectorConfig>;
  originalPrompt?: string;
  suppressScopeCreep?: boolean;
}): StrategyReflector {
  const existing = _instances.get(opts.runId);
  if (existing) return existing;

  const reflector = new StrategyReflector(opts);
  _instances.set(opts.runId, reflector);
  return reflector;
}

/**
 * Clean up reflector after run completes.
 */
export function disposeReflector(runId: string): void {
  _instances.delete(runId);
}

/**
 * Get all active reflectors (for diagnostics).
 */
export function getActiveReflectors(): Array<{ runId: string; snapshot: ReflectorSnapshot }> {
  return Array.from(_instances.entries()).map(([runId, reflector]) => ({
    runId,
    snapshot: reflector.getSnapshot(),
  }));
}
