#!/usr/bin/env tsx
/**
 * check:autoheal-cycle — the self-healing loop's SAFETY properties, the ones a
 * live cycle is too expensive and too dangerous to prove repeatedly.
 *
 * WHAT THIS COVERS AND WHY IT IS SEPARATE FROM test-error-collector.ts
 * -------------------------------------------------------------------
 * `test-error-collector.ts` already covers signature determinism, deduplication,
 * cooldown, TTL cleanup and the active-ticket listing — and it was registered
 * NOWHERE: not in package.json, not in check-all.sh. It has been passing 14/14
 * into a void. It is now wired up (`npm run check:error-collector`), and this
 * file covers what it does not:
 *
 *   G1 the global handlers are actually INSTALLED, not merely written
 *   G2 the limits that stop a repair loop eating the machine: max attempts per
 *      signature, backoff after a failure, max concurrent tickets
 *   G2 transient errors do NOT open a coding cycle — the healer runs on the same
 *      harness that just timed out, so escalating a timeout is how one stall
 *      becomes a cascade
 *   G3 one signature is one cycle; later occurrences append an observation
 *      rather than opening a second repair
 *   G5 the heal ticket resolves on MERGE, not on swap
 *
 * Nothing here triggers a workflow. `_triggerWorkflow` is the boundary, and
 * every test that reaches `reportError` replaces it — a repair cycle started by
 * a gate would be a gate that costs money and edits the repository.
 *
 * Run: npx tsx src/mastra/scripts/check-autoheal-cycle.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ErrorCollector } from '../services/error-collector.js';
import { getDb, closeDb } from '../lib/mongo.js';
import { getOrCreateCycle, getCycle, linkTicketToCycle } from '../lib/autoheal-cycles.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:autoheal-cycle');

const db = await getDb();
const tickets = db.collection('auto_healing_tickets');
const MARK = `checkgate-${Date.now()}`;

/** A collector that can never start a workflow, whatever the logic decides. */
function inertCollector(): ErrorCollector {
  const collector = new ErrorCollector();
  let started = 0;
  (collector as unknown as { _triggerWorkflow: () => Promise<void> })._triggerWorkflow =
    async () => { started += 1; };
  (collector as unknown as { __started: () => number }).__started = () => started;
  return collector;
}

/**
 * Every signature this run produced, so cleanup keys on identity rather than on
 * text.
 *
 * Text is not a safe key: the transient test overrides the message to something
 * the classifier recognises, which ERASES the marker the sweep looks for. Found
 * the hard way — a ticket from a falsification run was sitting in the live
 * operator view (`/deploy/auto-heal-status`) reading `Harness LLM call timed out
 * after 900s`, indistinguishable from a real incident.
 */
const producedSignatures = new Set<string>();

/** An error whose signature is unique to this run, so gates never collide. */
function uniqueError(tag: string, message?: string): Error {
  const err = new Error(message ? `${MARK} ${tag} — ${message}` : `${MARK} ${tag}`);
  err.stack = `Error: ${err.message}\n    at gate (${MARK}:${tag}:1)`;
  producedSignatures.add(new ErrorCollector().hashError(err));
  return err;
}

// ── G1: installed, not merely written ────────────────────────────────────────
await check('G1: the global handlers are actually registered on the process', async () => {
  // The recurring defect in this project is machinery that is correct and that
  // nothing reaches. A handler that exists in a module nobody calls catches
  // nothing, and the failure is invisible: no crash, no log, just a process that
  // dies quietly on the first unhandled rejection.
  const before = {
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  };
  const { initGlobalErrorHandlers } = await import('../services/global-error-handler.js');
  initGlobalErrorHandlers();
  assert.ok(process.listenerCount('uncaughtException') > before.uncaught
    || before.uncaught > 0, 'uncaughtException must have a listener after init');
  assert.ok(process.listenerCount('unhandledRejection') > before.rejection
    || before.rejection > 0, 'unhandledRejection must have a listener after init');

  // And the boot path must call it — the function being correct is not the point.
  const index = readFileSync('src/mastra/index.ts', 'utf-8');
  assert.match(index, /^initGlobalErrorHandlers\(\);/m,
    'index.ts must CALL it at top level, not merely import it');
});

// ── G2: a timeout must not open a repair cycle ───────────────────────────────
await check('G2: a transient timeout is recorded, not escalated into a coding cycle', async () => {
  // The healer runs on the same harness that just timed out. Escalating a
  // timeout means diagnosing it with the thing that is saturated, which times
  // out too — one stall becomes a cascade of worktrees.
  const collector = inertCollector();
  // The marker stays IN the message: the classifier matches a substring, so a
  // recognisable message and a traceable one are not in conflict.
  const timeout = uniqueError('transient', 'Harness LLM call timed out after 900s');
  const result = await collector.reportError(timeout, { source: 'test' });
  assert.equal(result.triggered, false, 'a timeout must not open a repair cycle');
  assert.match(result.reason, /[Tt]ransient/, 'and the reason must name why');
  assert.equal((collector as unknown as { __started: () => number }).__started(), 0,
    'no workflow may have been started');

  // The observation is still recorded — skipping the repair must not lose the
  // diagnostic trail.
  const signature = collector.hashError(timeout);
  const cycle = await db.collection('autoheal_cycles').findOne({ signature });
  assert.ok(cycle, 'the cycle observation must survive the decision not to escalate');
});

// ── G2: the limits that keep a repair loop bounded ───────────────────────────
await check('G2: a signature that has already been tried N times needs a human', async () => {
  const collector = inertCollector();
  const err = uniqueError('maxattempts');
  const signature = collector.hashError(err);
  const limit = Number(process.env.ERROR_COLLECTOR_MAX_ATTEMPTS_PER_SIGNATURE ?? 3);

  // Pre-seed the history the limit counts, in a terminal state so neither the
  // dedup nor the backoff answers first.
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await tickets.insertMany(Array.from({ length: limit }, (_, i) => ({
    ticketId: `${MARK}-attempt-${i}`,
    errorSignature: signature,
    errorMessage: err.message,
    status: 'completed',
    createdAt: old,
    updatedAt: old,
    expiresAt: new Date(Date.now() + 60_000),
  })));

  const result = await collector.reportError(err, { source: 'test' });
  assert.equal(result.triggered, false, 'the limit must stop a repair loop from retrying forever');
  assert.match(result.reason, /[Mm]ax attempts/, 'and must say that a human is needed');
});

await check('G2: a recent FAILURE on the same signature backs off', async () => {
  const collector = inertCollector();
  const err = uniqueError('backoff');
  const signature = collector.hashError(err);
  const justNow = new Date().toISOString();
  await tickets.insertOne({
    ticketId: `${MARK}-failed`,
    errorSignature: signature,
    errorMessage: err.message,
    status: 'failed',
    createdAt: justNow,
    updatedAt: justNow,
    expiresAt: new Date(Date.now() + 60_000),
  });

  const result = await collector.reportError(err, { source: 'test' });
  assert.equal(result.triggered, false, 'retrying a fresh failure immediately is a loop, not a repair');
  assert.match(result.reason, /[Bb]ackoff/, 'and the reason must be the backoff, not a coincidence');
});

// ── G3: one signature, one cycle ─────────────────────────────────────────────
await check('G3: the same signature appends an observation instead of opening a second cycle', async () => {
  const signature = `${MARK}-cycle`;
  const first = await getOrCreateCycle(signature, {
    source: 'test', errorMessage: 'first sighting',
  });
  const second = await getOrCreateCycle(signature, {
    source: 'test', errorMessage: 'second sighting',
  });
  assert.equal(second.cycle.cycleId, first.cycle.cycleId,
    'a second occurrence must join the open cycle — a new one would mean a second worktree');

  const stored = await getCycle(first.cycle.cycleId);
  assert.ok(stored, 'the cycle must be readable back');
  const events = await db.collection('autoheal_runtime_events')
    .countDocuments({ cycleId: first.cycle.cycleId });
  const observations = Number(
    (stored as unknown as { observationCount?: number }).observationCount ?? 0,
  );
  assert.ok(events >= 2 || observations >= 2,
    'both sightings must be recorded — grouping must not silently drop the later ones');

  // A ticket links to the cycle, which is the bridge the operator view reads.
  await linkTicketToCycle(first.cycle.cycleId, `${MARK}-linked`);
  const linked = await getCycle(first.cycle.cycleId);
  assert.ok(JSON.stringify(linked).includes(`${MARK}-linked`),
    'the ticket must be reachable from the cycle');
});

// ── G5: healing is done when the fix is in the source ────────────────────────
await check('G5: the heal ticket resolves on MERGE, not on swap', () => {
  // A ticket resolved on swap would stay open through a detached FULL SWAP that
  // returns before the swap finishes, and then expire by TTL — the repair
  // succeeded and the record says it never completed.
  const src = readFileSync('src/mastra/workflows/repo-maintenance.ts', 'utf-8');
  const calls = [...src.matchAll(/await resolveHealTicket\(/g)].map((m) => m.index ?? 0);
  assert.ok(calls.length >= 2, 'both merge paths must resolve the ticket');
  for (const at of calls) {
    const before = src.slice(Math.max(0, at - 1200), at);
    assert.match(before, /mergeWorktreeToLive|merged\.ok|merged =/,
      'each resolve must follow a merge that landed');
    const after = src.slice(at, at + 600);
    assert.ok(!/deployAndVerify|deploy-blue-green|promote-candidate/.test(after.split('\n')[0] ?? ''),
      'resolving must not be gated behind the swap');
  }
});

// ── G4: a cycle that ends must release the healer ────────────────────────────
await check('G4: a finished run maps to a TERMINAL status, whatever it returned', async () => {
  // Behavioural, against the real decision. The first version of this check
  // stubbed `_triggerWorkflow` with its own closing logic — so it tested the
  // stub, and passed unchanged with the production path broken. Same trap as
  // the empty-merge assertion; the fix is the same: extract the decision.
  const { describeRunOutcome } = await import('../services/error-collector.js');

  for (const [label, result] of [
    ['a halt with no changes', { status: 'success', result: { action: 'blocked', message: 'worktree pusty' } }],
    ['a failed run', { status: 'failed' }],
    ['a suspended run', { status: 'suspended' }],
    ['a run that returned nothing', undefined],
    ['a run that returned junk', 'not an object'],
  ] as const) {
    const outcome = describeRunOutcome(result);
    assert.ok(!['pending', 'in_progress'].includes(outcome.status),
      `${label}: must not leave the ticket looking alive — that is what blocks the healer`);
    assert.ok(outcome.statusReason.length > 0,
      `${label}: an operator must be able to see WHY it ended`);
  }
  assert.match(describeRunOutcome({ status: 'success', result: { action: 'blocked' } }).statusReason,
    /blocked/, 'the workflow\'s own verdict must survive into the ticket');

  // The cause must survive from wherever it actually lives. Measured live: the
  // workflow explained itself by THROWING, and the ticket recorded a bare
  // "workflow failed" — an operator view with nothing in it.
  const thrownAtRun = describeRunOutcome({
    status: 'failed', error: new Error('implementacja nie wyprodukowała żadnych zmian'),
  });
  assert.match(thrownAtRun.statusReason, /nie wyprodukowała/,
    'an error thrown by the run must reach the ticket');
  const thrownInStep = describeRunOutcome({
    status: 'failed',
    steps: { 'decision-gate': { status: 'failed', error: { message: 'worktree pusty' } } },
  });
  assert.match(thrownInStep.statusReason, /worktree pusty/,
    'and so must one thrown inside a step');
});

await check('G4: closing the ticket is wired into the trigger path', () => {
  const src = readFileSync('src/mastra/services/error-collector.ts', 'utf-8');
  const startAt = src.indexOf('await run.start(');
  const closeAt = src.indexOf('describeRunOutcome(result)', startAt);
  assert.ok(closeAt > startAt,
    'the decision must be APPLIED after the run — an extracted function nobody calls is the defect this project keeps paying for');
  assert.ok(src.slice(startAt, closeAt).includes("status: { $in: ['pending', 'in_progress'] }"),
    'and scoped to still-open tickets, so a merge that already closed one is not overwritten');
});

await check('G4: the source sets in_progress BEFORE the run, not after it', () => {
  // Written afterwards, the status was a lie in both directions: `pending` for
  // the whole repair, and `pending` forever if the process died mid-run.
  const src = readFileSync('src/mastra/services/error-collector.ts', 'utf-8');
  const inProgressAt = src.indexOf("status: 'in_progress'");
  const startAt = src.indexOf('await run.start(');
  assert.ok(inProgressAt > 0 && startAt > 0, 'both must be present');
  assert.ok(inProgressAt < startAt,
    'the ticket must say it is running while it is running');
  const closeAt = src.indexOf("status: { $in: ['pending', 'in_progress'] } },", startAt);
  assert.ok(closeAt > startAt,
    'and a terminal status must be written after the run, scoped to still-open tickets');
});

// ── Cleanup: a gate must not leave state behind ──────────────────────────────
await check('the gate cleans up after itself', async () => {
  // By ticketId AND by message: a ticket the COLLECTOR minted is called
  // `heal-<sig>-<ts>`, so a prefix sweep misses it. Found by falsifying the
  // max-attempts assertion — with the limit disabled a real ticket was created
  // and survived into the operator view.
  const signatures = [...producedSignatures];
  const removedTickets = await tickets.deleteMany({
    $or: [
      { ticketId: { $regex: `^${MARK}` } },
      { errorMessage: { $regex: MARK } },
      // Identity, not text — see `producedSignatures`.
      { errorSignature: { $in: signatures } },
    ],
  });
  await db.collection('autoheal_cycles').deleteMany({ signature: { $in: signatures } });
  await db.collection('autoheal_runtime_events').deleteMany({ signature: { $in: signatures } });
  await db.collection('autoheal_cycles').deleteMany({ signature: { $regex: MARK } });
  await db.collection('autoheal_runtime_events').deleteMany({ cycleId: { $regex: MARK } });
  assert.ok(removedTickets.deletedCount >= 0);
  const leftover = await tickets.countDocuments({
    $or: [{ errorMessage: { $regex: MARK } }, { errorSignature: { $in: signatures } }],
  });
  assert.equal(leftover, 0, 'no gate ticket may survive into the operator view');
});

await closeDb();

if (failures > 0) {
  console.error(`\n❌ check:autoheal-cycle — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:autoheal-cycle — the repair loop is installed, bounded, and resolves on merge');
process.exit(0);
