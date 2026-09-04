/**
 * Liveness budget checks (ideas/liveness-budget-plan.md L2).
 *
 * Proves the property the whole redesign exists for: an agent that keeps
 * emitting events is NEVER cut for taking long, while silence and the absolute
 * backstop still stop it. Mongo-free and clock-injected — no sleeps, no flake.
 *
 * Run: npx tsx src/mastra/scripts/check-liveness-budget.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  clearRunDeadline,
  getRemainingRunBudgetMs,
  getRunBudgetMode,
  getRunLivenessState,
  setRunDeadline,
  setRunLivenessHardCapAt,
  startRunLiveness,
  touchRunLiveness,
  _resetRunDeadlines,
} from '../services/run-budget.js';
import { classifyComplexity } from '../services/depth-controller.js';
import { HARNESS_FEATURE_FLAG_NAMES, isHarnessFeatureEnabled } from '../config/harness-flags.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

console.log('check:liveness-budget');

check('the flag is registered and defaults OFF until L3/L4 land', () => {
  assert.ok(
    (HARNESS_FEATURE_FLAG_NAMES as readonly string[]).includes('FEATURE_LIVENESS_BUDGET'),
    'FEATURE_LIVENESS_BUDGET must be a registered harness flag',
  );
  delete process.env.FEATURE_LIVENESS_BUDGET;
  assert.equal(
    isHarnessFeatureEnabled('FEATURE_LIVENESS_BUDGET', false),
    false,
    'liveness must stay opt-in while detectors are still tuned for the old clock',
  );
});

check('every depth profile carries a coherent liveness envelope', () => {
  const seen = new Map<string, { idle: number; cap: number; wall: number }>();
  for (const prompt of [
    'pokaż status',                                  // fast
    'zbadaj rynek producentów sera',                 // standard
    'zbuduj automatyzację n8n do obsługi leadów',    // deep
    'wdroż to na produkcję i usuń stare credentials', // critical
  ]) {
    const { profile } = classifyComplexity({ prompt, agentId: 'metaAgent', phase: 'chat' });
    seen.set(profile.level, {
      idle: profile.idleTimeoutMs,
      cap: profile.hardCapMs,
      wall: profile.timeoutMs,
    });
  }
  assert.ok(seen.size >= 3, `expected several depth levels, saw ${[...seen.keys()].join(',')}`);
  for (const [level, v] of seen) {
    assert.ok(v.idle >= 1_000, `${level}: idle window must be real`);
    // The backstop must sit far above the idle window, otherwise it — not
    // silence — would end normal runs, recreating the wall-clock problem.
    assert.ok(v.cap >= v.idle * 3, `${level}: hard cap ${v.cap} too close to idle ${v.idle}`);
    // The whole point: a working agent gets more room than the old fixed clock.
    assert.ok(v.cap > v.wall, `${level}: hard cap ${v.cap} must exceed legacy wall-clock ${v.wall}`);
  }
});

check('a continuously working run outlives an equivalent wall-clock', () => {
  _resetRunDeadlines();
  const T0 = 1_000_000;
  // Same size as the legacy `standard` clock, so the comparison is honest.
  startRunLiveness('run-work', { idleTimeoutMs: 180_000, hardCapMs: 3_600_000, now: T0 });

  // Emit a step every 60s for 30 minutes — 10× the old 180s wall-clock.
  for (let t = 60_000; t <= 1_800_000; t += 60_000) {
    touchRunLiveness('run-work', T0 + t);
    const state = getRunLivenessState('run-work', T0 + t);
    assert.ok(state?.alive, `still working at t+${t / 1000}s must stay alive`);
  }
  const final = getRunLivenessState('run-work', T0 + 1_800_000);
  assert.equal(final?.elapsedMs, 1_800_000, 'run genuinely ran 30 minutes');
  assert.equal(final?.touchCount, 30);
  clearRunDeadline('run-work');
});

check('silence ends the run, and the reason distinguishes it from the backstop', () => {
  _resetRunDeadlines();
  const T0 = 2_000_000;
  startRunLiveness('run-silent', { idleTimeoutMs: 45_000, hardCapMs: 600_000, now: T0 });
  touchRunLiveness('run-silent', T0 + 10_000);

  assert.ok(getRunLivenessState('run-silent', T0 + 54_000)?.alive, 'within the window → alive');
  const dead = getRunLivenessState('run-silent', T0 + 56_000);
  assert.equal(dead?.alive, false, 'past the idle window → not alive');
  assert.equal(dead?.reason, 'IDLE_TIMEOUT');
  // Far below the backstop — silence, not duration, is what ended it.
  assert.ok((dead?.hardCapRemainingMs ?? 0) > 500_000, 'the hard cap was nowhere near');
  clearRunDeadline('run-silent');
});

check('the hard cap is a true backstop that activity cannot extend', () => {
  _resetRunDeadlines();
  const T0 = 3_000_000;
  startRunLiveness('run-cap', { idleTimeoutMs: 60_000, hardCapMs: 300_000, now: T0 });
  // Busy the whole time: only the backstop can stop this run.
  for (let t = 10_000; t <= 300_000; t += 10_000) touchRunLiveness('run-cap', T0 + t);
  const state = getRunLivenessState('run-cap', T0 + 300_001);
  assert.equal(state?.alive, false);
  assert.equal(state?.reason, 'HARD_CAP', 'a busy run can only be stopped by the backstop');
  clearRunDeadline('run-cap');
});

check('a progressive watchdog moves only to an authoritative absolute deadline', () => {
  _resetRunDeadlines();
  const T0 = 3_500_000;
  startRunLiveness('run-earned', {
    idleTimeoutMs: 60_000,
    hardCapMs: 300_000,
    maxHardCapMs: 900_000,
    now: T0,
  });
  const extended = setRunLivenessHardCapAt('run-earned', T0 + 600_000, T0 + 10_000);
  assert.equal(extended.extended, true);
  assert.equal(extended.hardCapMs, 600_000);
  touchRunLiveness('run-earned', T0 + 470_000);
  assert.ok(getRunLivenessState('run-earned', T0 + 500_000)?.alive);
  const backwards = setRunLivenessHardCapAt('run-earned', T0 + 450_000, T0 + 20_000);
  assert.equal(backwards.extended, false, 'an out-of-order response cannot move the cap backwards');
  const capped = setRunLivenessHardCapAt('run-earned', T0 + 2_000_000, T0 + 30_000);
  assert.equal(capped.hardCapMs, 900_000, 'the immutable maximum still wins');
  assert.equal(getRunLivenessState('run-earned', T0 + 900_001)?.reason, 'HARD_CAP');
  clearRunDeadline('run-earned');
});

check('delegation never promises a child more than the parent can survive', () => {
  _resetRunDeadlines();
  const T0 = 4_000_000;
  startRunLiveness('run-parent', { idleTimeoutMs: 60_000, hardCapMs: 900_000, now: T0 });
  const fresh = getRemainingRunBudgetMs('run-parent', T0);
  assert.ok(fresh !== undefined && fresh > 55_000, 'fresh parent advertises its idle window');

  // Deep into the run the backstop becomes the binding constraint.
  startRunLiveness('run-old', { idleTimeoutMs: 60_000, hardCapMs: 70_000, now: T0 - 65_000 });
  const old = getRemainingRunBudgetMs('run-old', T0);
  assert.ok(old !== undefined && old <= 5_000, `near the cap the smaller bound wins, got ${old}`);
  clearRunDeadline('run-parent');
  clearRunDeadline('run-old');
});

check('DEADLINE runs are untouched by the liveness path', () => {
  _resetRunDeadlines();
  setRunDeadline('run-legacy', Date.now() + 120_000);
  assert.equal(getRunBudgetMode('run-legacy'), 'DEADLINE');
  assert.equal(touchRunLiveness('run-legacy'), false, 'touch must not convert a DEADLINE run');
  assert.equal(getRunLivenessState('run-legacy'), undefined, 'no liveness verdict for DEADLINE');
  const remaining = getRemainingRunBudgetMs('run-legacy');
  assert.ok(remaining !== undefined && remaining > 115_000, 'legacy semantics preserved');
  clearRunDeadline('run-legacy');
});

check('the harness wires liveness at run start, on steps, and around the LLM call', () => {
  const source = readFileSync(
    new URL('../services/generate-with-harness.ts', import.meta.url),
    'utf8',
  );
  // Mode is chosen once, at run start, and an explicit caller budget still means
  // the legacy fixed deadline.
  assert.match(source, /isHarnessFeatureEnabled\('FEATURE_LIVENESS_BUDGET', false\)/);
  assert.match(source, /input\.timeoutMs === undefined/);
  assert.match(source, /startRunLiveness\(runId, \{/);
  assert.match(source, /setRunDeadline\(runId, Date\.now\(\) \+ effectiveTimeoutMs\)/);
  // Both event hooks feed the idle window.
  const touches = source.match(/touchRunLiveness\(harnessContext\.runId\)/g) ?? [];
  assert.ok(touches.length >= 2, `expected step + prepareStep touches, found ${touches.length}`);
  // The guard replaces the wall-clock only for liveness runs, and aborts the
  // underlying work rather than orphaning it (WS-A).
  assert.match(source, /withLivenessGuard\(/);
  assert.match(source, /harness_liveness_cut/);
  assert.match(source, /getRunLivenessState\(livenessRunId\)/);
  // The legacy path must survive intact for DEADLINE runs.
  assert.match(source, /await withTimeout\(/);
});

check('no depth profile ships a dead progress lever (K8)', () => {
  // `low_progress` fires on `stepNumber > maxStepsWithoutProgress`, so a
  // threshold at (or above) maxSteps can never trigger — the lever looks
  // configured but is unreachable. This is exactly the bug K8 recorded for
  // `standard` (25 === maxSteps). Under liveness the detectors are the primary
  // brake, so a silently dead one matters far more than it did before.
  for (const prompt of [
    'pokaż status',
    'zbadaj rynek producentów sera',
    'zbuduj automatyzację n8n do obsługi leadów',
    'wdroż to na produkcję i usuń stare credentials',
  ]) {
    const { profile } = classifyComplexity({ prompt, agentId: 'metaAgent', phase: 'chat' });
    const threshold = profile.reflector.config?.maxStepsWithoutProgress;
    if (threshold === undefined) continue;
    assert.ok(
      threshold < profile.maxSteps,
      `${profile.level}: maxStepsWithoutProgress ${threshold} ≥ maxSteps ${profile.maxSteps} → lever can never fire`,
    );
    // It must also leave room to matter: firing on the very last step is a
    // notification, not an intervention.
    assert.ok(
      profile.maxSteps - threshold >= 2,
      `${profile.level}: only ${profile.maxSteps - threshold} step(s) left after the nudge`,
    );
  }
});

check('unbounded I/O is closed off, so silence cannot mean a hung socket (L3)', () => {
  // Liveness treats "no events" as death. That is only safe if work cannot hang
  // invisibly: a stalled fetch emits no step, so without a request deadline the
  // watchdog would be the only thing left — and the socket would never be freed.
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  for (const rel of [
    '../tools/film/film-generate.ts',
    '../tools/music/music-generate.ts',
    '../lib/ollama-gateway.ts',
    '../tools/weather-tool.ts',
    '../workflows/weather-workflow.ts',
    '../tools/research/reviews-google-place.ts',
  ]) {
    const source = read(rel);
    assert.ok(source.includes('fetchWithDeadline'), `${rel} must route through fetchWithDeadline`);
    // No bare `await fetch(` may survive in these files.
    assert.doesNotMatch(
      source,
      /await fetch\(/,
      `${rel} still contains an unbounded fetch (audit K11/K17)`,
    );
  }

  // The poll loops must bound each tick by what is LEFT of the poll budget,
  // otherwise a single stalled tick outlives the deadline the loop enforces.
  for (const rel of ['../tools/film/film-generate.ts', '../tools/music/music-generate.ts']) {
    const source = read(rel);
    assert.match(source, /remainingRequestBudgetMs\(deadline\)/, `${rel} must bound each poll tick`);
  }

  // K18 — git calls default to a bound at the wrapper, so no call site can omit it.
  const worktree = read('../tools/dev/code-worktree.ts');
  assert.match(worktree, /DEFAULT_GIT_TIMEOUT_MS/, 'git exec must carry a default timeout');
  assert.match(worktree, /timeout: DEFAULT_GIT_TIMEOUT_MS/);
});

check('LIVE REGRESSION: V2 reaches liveness at all, and on its own switch', () => {
  // Passing `timeoutMs` disables liveness, and the V2 caller always did — so no
  // V2 job ever ran under it, whatever the flag said. It now passes a hard cap
  // instead, and opts in WITHOUT the global flag: that one would also move
  // review/coding/knowledge/automation (none of which pass a timeout) onto
  // liveness in the same instant, on windows nobody has measured.
  const caller = readFileSync(
    new URL('../orchestration/execution/harness-agent-caller.ts', import.meta.url), 'utf8');
  assert.match(caller, /hardCapMs,/, 'V2 must pass a hard cap');
  assert.ok(!/^\s*timeoutMs,$/m.test(caller), 'and must NOT pass a wall clock — that disables liveness');
  assert.match(caller, /preferLiveness: process\.env\.FEATURE_ORCHESTRATION_V2_LIVENESS === 'true'/,
    'V2 opts in on its own switch, not the global one');

  const harness = readFileSync(new URL('../services/generate-with-harness.ts', import.meta.url), 'utf8');
  assert.match(harness, /input\.preferLiveness === true/, 'the harness must honour the caller opt-in');
  assert.match(harness, /input\.timeoutMs === undefined/, 'an explicit wall clock still wins');
});

check('the idle window can be RAISED by the caller, never lowered', () => {
  // Measured live: a working design run went 99.7s between events, which is
  // above EVERY profile window (fast 45s, standard 60s, deep 90s). Enabling
  // liveness without a floor would have killed it mid-generation.
  const harness = readFileSync(new URL('../services/generate-with-harness.ts', import.meta.url), 'utf8');
  assert.match(
    harness,
    /livenessIdleTimeoutMs = Math\.max\([\s\S]*?input\.idleTimeoutMs \?\? 0,\s*\)/,
    'the caller floor must be applied with max(), so it can only raise',
  );
  assert.match(
    harness,
    /livenessHardCapMs = Math\.max\([\s\S]*?input\.hardCapMs \?\? 0,[\s\S]*?livenessIdleTimeoutMs,\s*\)/,
    'an environment override must never lower a frozen caller hard cap',
  );

  const routing = readFileSync(new URL('../config/capability-routing.ts', import.meta.url), 'utf8');
  const floors = /IDLE_FLOOR_BY_LATENCY: Record<string, number> = \{([\s\S]*?)\}/.exec(routing)?.[1] ?? '';
  const long = /long:\s*([0-9_]+)/.exec(floors)?.[1]?.replaceAll('_', '');
  assert.ok(long !== undefined, 'the long class must declare a floor');
  // chefAgent was measured at 230.0s of silence while working — the worst case
  // across every enabled capability. A floor near that is not a margin: the
  // first draft sat at 240s, within 4% of it. Doubling is the rule this encodes.
  assert.ok(
    Number(long) >= 460_000,
    `the long floor must be at least twice the worst gap observed (230s), got ${long}ms`,
  );
});

_resetRunDeadlines();
if (failures > 0) {
  console.error(`\n❌ check:liveness-budget — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:liveness-budget — all assertions passed');
process.exit(0);
