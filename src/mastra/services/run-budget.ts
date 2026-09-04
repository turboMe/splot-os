/**
 * Run budget registry — DEADLINE (P2) and LIVENESS (liveness-budget-plan.md L1).
 *
 * ── DEADLINE (original, P2 delegation hardening) ─────────────────────────────
 * The harness knows each run's wall-clock budget (depth profile timeout), but
 * that knowledge never reached the delegation tool: a `fast` (60s) parent
 * could start a 240s sync child that mathematically cannot return in time
 * (observed live: meta died at 300s, the researcher delegation timed out 47s
 * AFTER the parent was already gone — the result had nobody to return to).
 *
 * ── LIVENESS (new) ───────────────────────────────────────────────────────────
 * A wall-clock deadline answers "did it finish in time?", which is the wrong
 * question: an agent can work correctly for ten minutes (video render) or flail
 * in thirty seconds (same tool five times). Duration does not distinguish those;
 * events do. Worse, the fixed clock actively degraded the loop detectors — their
 * thresholds were lowered because "the 300s wall-clock was beating the ceiling"
 * (see strategy-reflector.ts §loop_fix.P2c).
 *
 * LIVENESS therefore asks "is it still alive and progressing?": the run is cut
 * when it emits NO event for `idleTimeoutMs`, or exceeds an absolute `hardCapMs`
 * backstop — never merely for taking long. Detecting *flailing* is the
 * reflector's job (event-based), not the clock's.
 *
 * Both modes share one registry so `getCurrentRunRemainingBudgetMs` — read by
 * `delegate-task` to cap a child — keeps answering honestly in either mode
 * without the delegation code knowing which mode is active.
 *
 * Registry is in-memory and keyed by runId — same lifetime model as the
 * run-depth registry in depth-controller.ts. A missing entry degrades to the
 * static default timeouts (zero behavior change for non-harness callers).
 */

import { getHarnessExecutionContext } from './harness-execution-context.js';

export type RunBudgetMode = 'DEADLINE' | 'LIVENESS';

interface DeadlineEntry {
  mode: 'DEADLINE';
  startedAt: number;
  deadlineTs: number;
}

interface LivenessEntry {
  mode: 'LIVENESS';
  startedAt: number;
  /** Moved forward by every `touchRunLiveness` call. */
  lastActivityAt: number;
  /** No event for this long ⇒ the run is considered dead. */
  idleTimeoutMs: number;
  /** Currently earned absolute backstop measured from `startedAt`. */
  hardCapMs: number;
  /** Immutable absolute ceiling. Equal to `hardCapMs` for ordinary runs. */
  maxHardCapMs: number;
  /** Monotonic count of observed events — evidence that liveness is real. */
  touchCount: number;
}

type RunBudgetEntry = DeadlineEntry | LivenessEntry;

const _runBudgets = new Map<string, RunBudgetEntry>();

// Defensive cap so a leaked entry (missed clear) cannot grow the map forever.
const MAX_ENTRIES = 1_000;

const MIN_IDLE_TIMEOUT_MS = 1_000;
const MIN_HARD_CAP_MS = 1_000;

function store(runId: string, entry: RunBudgetEntry): void {
  _runBudgets.delete(runId);
  _runBudgets.set(runId, entry);
  if (_runBudgets.size > MAX_ENTRIES) {
    const oldest = _runBudgets.keys().next().value;
    if (oldest !== undefined) _runBudgets.delete(oldest);
  }
}

/**
 * Publish the wall-clock deadline for a run (DEADLINE mode). Called by
 * generateWithHarness right after depth classification resolves the effective
 * timeout.
 */
export function setRunDeadline(runId: string, deadlineTs: number, startedAt: number = Date.now()): void {
  store(runId, { mode: 'DEADLINE', startedAt, deadlineTs });
}

export interface UpgradeRunDeadlineOptions {
  idleTimeoutMs?: number;
  hardCapMs?: number;
}

/**
 * Dynamically upgrade the budget (DEADLINE or LIVENESS) of an active run.
 * Called when depth is escalated (e.g. fast -> standard) to prevent premature aborts.
 */
export function upgradeRunDeadline(
  runId: string,
  newTimeoutMs: number,
  options?: UpgradeRunDeadlineOptions,
  now: number = Date.now(),
): boolean {
  const entry = _runBudgets.get(runId);
  if (!entry) return false;

  if (entry.mode === 'DEADLINE') {
    const startedAt = entry.startedAt ?? now;
    const newDeadlineTs = Math.max(entry.deadlineTs, startedAt + newTimeoutMs, now + 15_000);
    if (newDeadlineTs > entry.deadlineTs) {
      entry.deadlineTs = newDeadlineTs;
      return true;
    }
    return false;
  }

  if (entry.mode === 'LIVENESS') {
    let updated = false;
    if (options?.hardCapMs && options.hardCapMs > entry.hardCapMs) {
      entry.hardCapMs = options.hardCapMs;
      entry.maxHardCapMs = Math.max(entry.maxHardCapMs, options.hardCapMs);
      updated = true;
    }
    if (options?.idleTimeoutMs && options.idleTimeoutMs > entry.idleTimeoutMs) {
      entry.idleTimeoutMs = options.idleTimeoutMs;
      updated = true;
    }
    return updated;
  }

  return false;
}

/**
 * Begin LIVENESS tracking for a run. The run stays alive as long as it keeps
 * emitting events (see `touchRunLiveness`), bounded only by `hardCapMs`.
 */
export function startRunLiveness(
  runId: string,
  input: { idleTimeoutMs: number; hardCapMs: number; maxHardCapMs?: number; now?: number },
): void {
  const { idleTimeoutMs, hardCapMs } = input;
  const maxHardCapMs = input.maxHardCapMs ?? hardCapMs;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < MIN_IDLE_TIMEOUT_MS) {
    throw new TypeError(`idleTimeoutMs must be ≥ ${MIN_IDLE_TIMEOUT_MS}ms`);
  }
  if (!Number.isFinite(hardCapMs) || hardCapMs < MIN_HARD_CAP_MS) {
    throw new TypeError(`hardCapMs must be ≥ ${MIN_HARD_CAP_MS}ms`);
  }
  if (!Number.isFinite(maxHardCapMs) || maxHardCapMs < hardCapMs) {
    throw new TypeError('maxHardCapMs must be finite and ≥ hardCapMs');
  }
  // A hard cap below the idle window would make the backstop fire first and the
  // idle watchdog unreachable — that is a misconfiguration, not a policy.
  if (hardCapMs < idleTimeoutMs) {
    throw new TypeError('hardCapMs must be ≥ idleTimeoutMs');
  }
  const now = input.now ?? Date.now();
  store(runId, {
    mode: 'LIVENESS',
    startedAt: now,
    lastActivityAt: now,
    idleTimeoutMs,
    hardCapMs,
    maxHardCapMs,
    touchCount: 0,
  });
}

export interface RunHardCapUpdateResult {
  extended: boolean;
  hardCapMs: number;
  maxHardCapMs: number;
  reason?: 'unknown_run' | 'wrong_mode' | 'expired' | 'absolute_cap';
}

/**
 * Move the in-memory watchdog to an authoritative absolute instant returned by
 * the durable attempt CAS. This is the progressive-attempt path; it deliberately
 * does not add a process-local duration that could diverge after a slow write or
 * restart.
 */
export function setRunLivenessHardCapAt(
  runId: string,
  deadlineAt: number,
  now: number = Date.now(),
): RunHardCapUpdateResult {
  if (!Number.isFinite(deadlineAt)) {
    throw new TypeError('deadlineAt must be finite');
  }
  const entry = _runBudgets.get(runId);
  if (!entry) {
    return { extended: false, hardCapMs: 0, maxHardCapMs: 0, reason: 'unknown_run' };
  }
  if (entry.mode !== 'LIVENESS') {
    return { extended: false, hardCapMs: 0, maxHardCapMs: 0, reason: 'wrong_mode' };
  }
  if (now - entry.startedAt >= entry.hardCapMs) {
    return {
      extended: false,
      hardCapMs: entry.hardCapMs,
      maxHardCapMs: entry.maxHardCapMs,
      reason: 'expired',
    };
  }
  const target = Math.min(entry.maxHardCapMs, deadlineAt - entry.startedAt);
  if (target <= entry.hardCapMs) {
    return {
      extended: false,
      hardCapMs: entry.hardCapMs,
      maxHardCapMs: entry.maxHardCapMs,
      reason: 'absolute_cap',
    };
  }
  entry.hardCapMs = target;
  return { extended: true, hardCapMs: target, maxHardCapMs: entry.maxHardCapMs };
}

/**
 * Record an event for a run: the agent finished a step, started planning the
 * next one, or a tool returned. Resets the idle window; never extends the hard
 * cap. No-op for unknown runs and for DEADLINE-mode runs.
 *
 * Returns true when a live LIVENESS run was actually touched.
 */
export function touchRunLiveness(runId: string, now: number = Date.now()): boolean {
  // Observed in EVERY mode, including DEADLINE and for runs with no budget
  // entry — see `getRunActivityObservation`. Sizing an idle window requires
  // knowing the real gaps BEFORE liveness is switched on, and the only honest
  // source is the same call site that will later enforce it.
  observeActivity(runId, now);
  const entry = _runBudgets.get(runId);
  if (!entry || entry.mode !== 'LIVENESS') return false;
  entry.lastActivityAt = now;
  entry.touchCount += 1;
  return true;
}

/**
 * Gaps between a run's events, measured whatever mode it is in.
 *
 * WHY THIS EXISTS SEPARATELY FROM `LivenessEntry`
 * ----------------------------------------------
 * `touchRunLiveness` is a no-op for DEADLINE runs, and every V2 job is a
 * DEADLINE run today — the caller always supplies an explicit `timeoutMs`. So
 * the quantity that decides a safe `idleTimeoutMs` (the longest gap a LEGITIMATE
 * run goes without emitting anything) was unmeasurable from inside the mode that
 * needs it.
 *
 * It matters because `touchRunLiveness` fires on step boundaries and tool
 * returns, NOT per token: an agent emitting a 16 KB HTML file as one tool
 * argument looks idle for the whole generation. Choosing the window by intuition
 * would cut working runs — the precise failure liveness exists to prevent.
 */
interface ActivityObservation {
  lastAt: number;
  /** Longest observed gap between two events, ms. */
  maxGapMs: number;
  count: number;
}

const _activity = new Map<string, ActivityObservation>();

function observeActivity(runId: string, now: number): void {
  const seen = _activity.get(runId);
  if (!seen) {
    _activity.set(runId, { lastAt: now, maxGapMs: 0, count: 1 });
    if (_activity.size > MAX_ENTRIES) {
      const oldest = _activity.keys().next().value;
      if (oldest !== undefined) _activity.delete(oldest);
    }
    return;
  }
  const gap = now - seen.lastAt;
  if (gap > seen.maxGapMs) seen.maxGapMs = gap;
  seen.lastAt = now;
  seen.count += 1;
}

/** Longest gap and event count for a run, or `undefined` if nothing was seen. */
export function getRunActivityObservation(
  runId: string,
): { maxGapMs: number; events: number } | undefined {
  const seen = _activity.get(runId);
  return seen ? { maxGapMs: seen.maxGapMs, events: seen.count } : undefined;
}

export interface RunLivenessState {
  mode: 'LIVENESS';
  alive: boolean;
  /** Set only when `alive` is false. */
  reason?: 'IDLE_TIMEOUT' | 'HARD_CAP';
  idleForMs: number;
  elapsedMs: number;
  idleRemainingMs: number;
  hardCapRemainingMs: number;
  touchCount: number;
}

/**
 * Current liveness verdict for a run. `undefined` when the run is unknown or
 * running in DEADLINE mode.
 */
export function getRunLivenessState(
  runId: string,
  now: number = Date.now(),
): RunLivenessState | undefined {
  const entry = _runBudgets.get(runId);
  if (!entry || entry.mode !== 'LIVENESS') return undefined;
  const idleForMs = now - entry.lastActivityAt;
  const elapsedMs = now - entry.startedAt;
  const idleRemainingMs = entry.idleTimeoutMs - idleForMs;
  const hardCapRemainingMs = entry.hardCapMs - elapsedMs;
  // Hard cap is reported first: when both are breached the absolute backstop is
  // the more severe, less recoverable fact.
  const reason = hardCapRemainingMs <= 0
    ? 'HARD_CAP' as const
    : idleRemainingMs <= 0
      ? 'IDLE_TIMEOUT' as const
      : undefined;
  return {
    mode: 'LIVENESS',
    alive: reason === undefined,
    ...(reason ? { reason } : {}),
    idleForMs,
    elapsedMs,
    idleRemainingMs,
    hardCapRemainingMs,
    touchCount: entry.touchCount,
  };
}

/** Which mode a run is tracked under, or `undefined` when unknown. */
export function getRunBudgetMode(runId: string): RunBudgetMode | undefined {
  return _runBudgets.get(runId)?.mode;
}

/**
 * Remove a run's budget entry (run completed/failed). Safe to call twice.
 */
export function clearRunDeadline(runId: string): void {
  _runBudgets.delete(runId);
  _activity.delete(runId);
}

/** Descriptive alias — clears either mode. */
export const clearRunBudget = clearRunDeadline;

/**
 * Remaining budget for a specific run, in ms. Negative when exhausted.
 * `undefined` when the run is unknown (non-harness caller).
 *
 * DEADLINE: time left until the fixed deadline.
 * LIVENESS: the *guaranteed* window — how long this run is certain to stay
 * alive without further events. That is `min(idle remaining, hard cap
 * remaining)`: a child delegation may safely be given at most that much,
 * because beyond it the parent could legitimately be cut. Events push the idle
 * part forward, so a working parent keeps re-earning its window.
 */
export function getRemainingRunBudgetMs(
  runId: string,
  now: number = Date.now(),
): number | undefined {
  const entry = _runBudgets.get(runId);
  if (!entry) return undefined;
  if (entry.mode === 'DEADLINE') return entry.deadlineTs - now;
  const state = getRunLivenessState(runId, now);
  if (!state) return undefined;
  return Math.min(state.idleRemainingMs, state.hardCapRemainingMs);
}

/**
 * Remaining budget of the run this code is executing inside of, resolved via
 * the harness execution context (AsyncLocalStorage). This is what tools should
 * call — it does not depend on the model passing caller ids correctly.
 */
export function getCurrentRunRemainingBudgetMs(): number | undefined {
  const runId = getHarnessExecutionContext()?.runId;
  if (!runId) return undefined;
  return getRemainingRunBudgetMs(runId);
}

/** Record an event for the run this code is executing inside of. */
export function touchCurrentRunLiveness(): boolean {
  const runId = getHarnessExecutionContext()?.runId;
  if (!runId) return false;
  return touchRunLiveness(runId);
}

/**
 * Test helper — clear the registry.
 */
export function _resetRunDeadlines(): void {
  _runBudgets.clear();
}
