/**
 * P2 (delegation-depth-hardening) — checks for parent↔child budget coordination.
 *
 * Covers:
 *  - run-budget registry (set/get/clear + current-run resolution via ALS)
 *  - resolveDelegationBudget: static default, parent cap, viability gate,
 *    flag kill switch, graceful degradation outside a harness run
 *
 * Run: npx tsx src/mastra/scripts/check-delegation-budget.ts
 */
import assert from 'node:assert/strict';

import {
  setRunDeadline,
  clearRunDeadline,
  getRemainingRunBudgetMs,
  getCurrentRunRemainingBudgetMs,
  getRunBudgetMode,
  getRunLivenessState,
  startRunLiveness,
  touchRunLiveness,
  _resetRunDeadlines,
} from '../services/run-budget.js';
import { runWithHarnessExecutionContext } from '../services/harness-execution-context.js';
import { resolveDelegationBudget } from '../tools/system/delegate-task.js';

delete process.env.FEATURE_DELEGATION_BUDGET_COORDINATION;
delete process.env.DELEGATION_SYNC_SAFETY_MARGIN_MS;
delete process.env.DELEGATION_MIN_VIABLE_SYNC_MS;
delete process.env.DELEGATION_DIRECT_TIMEOUT_MS;

// ── Registry basics ──────────────────────────────────────────────────────────
_resetRunDeadlines();
assert.equal(getRemainingRunBudgetMs('run-x'), undefined, 'unknown run → undefined');
setRunDeadline('run-x', Date.now() + 100_000);
const remaining = getRemainingRunBudgetMs('run-x');
assert.ok(remaining !== undefined && remaining > 95_000 && remaining <= 100_000, `remaining ≈100s, got ${remaining}`);
clearRunDeadline('run-x');
assert.equal(getRemainingRunBudgetMs('run-x'), undefined, 'cleared run → undefined');

// ── Current-run resolution via harness execution context (ALS) ───────────────
assert.equal(getCurrentRunRemainingBudgetMs(), undefined, 'outside a run → undefined');
setRunDeadline('run-als', Date.now() + 90_000);
await runWithHarnessExecutionContext({ runId: 'run-als', agentId: 'check' }, async () => {
  const inside = getCurrentRunRemainingBudgetMs();
  assert.ok(inside !== undefined && inside > 85_000, `inside ALS context ≈90s, got ${inside}`);
});
clearRunDeadline('run-als');

// ── resolveDelegationBudget ──────────────────────────────────────────────────

// Outside a harness run: static default, viable, uncapped (zero behavior change).
{
  const budget = resolveDelegationBudget('researcherAgent');
  assert.equal(budget.timeoutMs, 900_000, 'static default 900s outside a run');
  assert.equal(budget.cappedByParent, false);
  assert.equal(budget.viable, true);
}

// Live failure fixture: parent `critical` (300s) delegates at ~t+70s → 230s
// left. Child must get 230−120=110s, NOT the static 900s that outlived the parent.
setRunDeadline('run-critical', Date.now() + 230_000);
await runWithHarnessExecutionContext({ runId: 'run-critical', agentId: 'check' }, async () => {
  const budget = resolveDelegationBudget('researcherAgent');
  assert.ok(budget.cappedByParent, 'child must be capped by parent budget');
  assert.ok(
    budget.timeoutMs > 100_000 && budget.timeoutMs <= 110_000,
    `child timeout ≈110s (230s − 120s reserve), got ${Math.round(budget.timeoutMs / 1000)}s`,
  );
  assert.equal(budget.viable, true, '110s window is viable');
});
clearRunDeadline('run-critical');

// ── Regression: the parent must survive its own child (2026-08-24 incident) ──
// meta had a 1200s budget and re-delegated with 341s left. Under the old 20s
// margin the child got 320.867s, timed out at the 341s mark and left meta 18s —
// not enough for one closing model call — so meta died on the wall clock and the
// caller received HTTP 504 with an empty body, even though the child's n8n
// workflow had been built correctly 8 minutes earlier.
//
// The invariant that was missing: whatever the child is granted, the parent must
// keep a usable window afterwards. Assert the LEFTOVER, not just the grant.
setRunDeadline('run-tail', Date.now() + 341_000);
await runWithHarnessExecutionContext({ runId: 'run-tail', agentId: 'check' }, async () => {
  const budget = resolveDelegationBudget('automationArchitect');
  const leftoverMs = 341_000 - budget.timeoutMs;
  assert.ok(
    leftoverMs >= 110_000,
    `parent must retain ≳120s to synthesise after the child returns, got ${Math.round(leftoverMs / 1000)}s`,
  );
  assert.ok(
    budget.timeoutMs <= 221_000,
    `child must not consume the parent's closing window, got ${Math.round(budget.timeoutMs / 1000)}s`,
  );
  assert.equal(budget.viable, true, '221s is still a viable sync window');
});
clearRunDeadline('run-tail');

// Live failure fixture: parent `fast` (60s) — window 60−120 → 0 < 60s min-viable
// → NOT viable → the tool auto-routes to async instead of a doomed sync call.
setRunDeadline('run-fast', Date.now() + 60_000);
await runWithHarnessExecutionContext({ runId: 'run-fast', agentId: 'check' }, async () => {
  const budget = resolveDelegationBudget('designAgent');
  assert.equal(budget.viable, false, 'fast parent (60s) cannot host a sync delegation');
  assert.ok(budget.cappedByParent, 'fast parent must cap the child');
});
clearRunDeadline('run-fast');

// Filmmaker keeps its dedicated (larger) static budget when uncapped.
{
  const budget = resolveDelegationBudget('filmmakerAgent');
  assert.equal(budget.timeoutMs, 900_000, 'filmmaker static default 900s outside a run');
}

// Kill switch: static defaults even inside a run.
process.env.FEATURE_DELEGATION_BUDGET_COORDINATION = 'off';
setRunDeadline('run-off', Date.now() + 30_000);
await runWithHarnessExecutionContext({ runId: 'run-off', agentId: 'check' }, async () => {
  const budget = resolveDelegationBudget('researcherAgent');
  assert.equal(budget.timeoutMs, 900_000, 'flag off → static default');
  assert.equal(budget.viable, true, 'flag off → always viable');
});
clearRunDeadline('run-off');
delete process.env.FEATURE_DELEGATION_BUDGET_COORDINATION;

// Env overrides for margin/min-viable are honored.
process.env.DELEGATION_SYNC_SAFETY_MARGIN_MS = '5000';
process.env.DELEGATION_MIN_VIABLE_SYNC_MS = '30000';
setRunDeadline('run-env', Date.now() + 40_000);
await runWithHarnessExecutionContext({ runId: 'run-env', agentId: 'check' }, async () => {
  const budget = resolveDelegationBudget('researcherAgent');
  assert.ok(
    budget.timeoutMs > 30_000 && budget.timeoutMs <= 35_000,
    `40s − 5s margin ≈35s, got ${Math.round(budget.timeoutMs / 1000)}s`,
  );
  assert.equal(budget.viable, true, '35s ≥ 30s min-viable (env override)');
});
clearRunDeadline('run-env');
delete process.env.DELEGATION_SYNC_SAFETY_MARGIN_MS;
delete process.env.DELEGATION_MIN_VIABLE_SYNC_MS;

// ── LIVENESS mode (liveness-budget-plan.md L1) ───────────────────────────────
_resetRunDeadlines();

// Unknown run stays undefined in every accessor.
assert.equal(getRunLivenessState('run-live'), undefined, 'unknown run → no liveness state');
assert.equal(getRunBudgetMode('run-live'), undefined, 'unknown run → no mode');

// Misconfiguration fails closed rather than silently picking a "safe" number.
assert.throws(() => startRunLiveness('bad', { idleTimeoutMs: 0, hardCapMs: 60_000 }), /idleTimeoutMs/);
assert.throws(() => startRunLiveness('bad', { idleTimeoutMs: 10_000, hardCapMs: 0 }), /hardCapMs/);
assert.throws(
  () => startRunLiveness('bad', { idleTimeoutMs: 60_000, hardCapMs: 30_000 }),
  /hardCapMs must be ≥ idleTimeoutMs/,
  'a hard cap below the idle window would make the idle watchdog unreachable',
);

// A fresh run is alive with the full idle window ahead of it.
const T0 = Date.now();
startRunLiveness('run-live', { idleTimeoutMs: 60_000, hardCapMs: 900_000, now: T0 });
assert.equal(getRunBudgetMode('run-live'), 'LIVENESS');
{
  const state = getRunLivenessState('run-live', T0);
  assert.ok(state && state.alive, 'fresh run is alive');
  assert.equal(state.idleRemainingMs, 60_000);
  assert.equal(state.touchCount, 0);
}

// THE CORE PROPERTY: an event resets the idle window. A run that keeps working
// stays alive indefinitely — it is never cut merely for taking long.
{
  // 50s of silence — still alive, 10s from the edge.
  const s1 = getRunLivenessState('run-live', T0 + 50_000);
  assert.ok(s1 && s1.alive, 'silent-but-not-yet-idle run is alive');
  assert.equal(s1.idleRemainingMs, 10_000);

  // A step lands at t+50s → the window is fully restored.
  assert.equal(touchRunLiveness('run-live', T0 + 50_000), true, 'touch on a live run returns true');
  const s2 = getRunLivenessState('run-live', T0 + 50_000);
  assert.equal(s2?.idleRemainingMs, 60_000, 'event restores the full idle window');
  assert.equal(s2?.touchCount, 1);

  // t+100s: 50s past the last event — a fixed 60s wall-clock would ALREADY have
  // killed this run, liveness keeps it because it is demonstrably working.
  const s3 = getRunLivenessState('run-live', T0 + 100_000);
  assert.ok(s3 && s3.alive, 'a working run outlives a fixed wall-clock of the same size');
  assert.equal(s3.elapsedMs, 100_000);
}

// Silence past the idle window ends the run — with an exact reason.
{
  const state = getRunLivenessState('run-live', T0 + 50_000 + 60_001);
  assert.ok(state && !state.alive, 'idle beyond the window is not alive');
  assert.equal(state.reason, 'IDLE_TIMEOUT');
}

// The hard cap is absolute: touching cannot extend it.
{
  const T1 = Date.now();
  startRunLiveness('run-cap', { idleTimeoutMs: 30_000, hardCapMs: 100_000, now: T1 });
  for (let at = 10_000; at <= 100_000; at += 10_000) touchRunLiveness('run-cap', T1 + at);
  const state = getRunLivenessState('run-cap', T1 + 100_001);
  assert.ok(state && !state.alive, 'hard cap fires despite continuous activity');
  assert.equal(state.reason, 'HARD_CAP', 'hard cap outranks idle when both are breached');
  clearRunDeadline('run-cap');
}

// Delegation reads the *guaranteed* window: min(idle remaining, hard cap remaining).
{
  const T2 = Date.now();
  startRunLiveness('run-deleg', { idleTimeoutMs: 60_000, hardCapMs: 900_000, now: T2 });
  const remainingLive = getRemainingRunBudgetMs('run-deleg');
  assert.ok(
    remainingLive !== undefined && remainingLive > 55_000 && remainingLive <= 60_000,
    `liveness run exposes the idle window as budget, got ${remainingLive}`,
  );

  // Near the hard cap the smaller bound wins, so a child is never promised more
  // time than the parent can certainly survive.
  startRunLiveness('run-near-cap', { idleTimeoutMs: 60_000, hardCapMs: 61_000, now: T2 - 50_000 });
  const nearCap = getRemainingRunBudgetMs('run-near-cap');
  assert.ok(
    nearCap !== undefined && nearCap <= 11_000,
    `hard cap bounds the advertised budget, got ${nearCap}`,
  );
  clearRunDeadline('run-near-cap');

  // And it flows through the ALS context exactly like DEADLINE mode does, so
  // delegate-task needs no knowledge of which mode is active.
  await runWithHarnessExecutionContext({ runId: 'run-deleg', agentId: 'check' }, async () => {
    const inside = getCurrentRunRemainingBudgetMs();
    assert.ok(inside !== undefined && inside > 55_000, `ALS resolves liveness budget, got ${inside}`);
    const budget = resolveDelegationBudget('researcherAgent');
    assert.ok(budget.cappedByParent, 'a liveness parent still caps its child');
    assert.ok(budget.timeoutMs <= 60_000, 'child cannot outlive the parent guaranteed window');
  });
  clearRunDeadline('run-deleg');
}

// Cross-mode hygiene: touching a DEADLINE run is a no-op, not a corruption.
{
  setRunDeadline('run-mixed', Date.now() + 100_000);
  assert.equal(touchRunLiveness('run-mixed'), false, 'touch is a no-op in DEADLINE mode');
  assert.equal(getRunLivenessState('run-mixed'), undefined, 'DEADLINE run has no liveness state');
  assert.equal(getRunBudgetMode('run-mixed'), 'DEADLINE');
  const remaining = getRemainingRunBudgetMs('run-mixed');
  assert.ok(remaining !== undefined && remaining > 95_000, 'DEADLINE semantics unchanged');
  clearRunDeadline('run-mixed');
  assert.equal(getRunBudgetMode('run-mixed'), undefined, 'cleared run → no mode');
}

_resetRunDeadlines();
console.log('DelegationBudget checks passed.');
process.exit(0);
