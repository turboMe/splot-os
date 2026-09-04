#!/usr/bin/env tsx
/**
 * f8:delayed-retry-after-terminal — a worker resurrected minutes later, after the
 * JOB it was working on has already reached a terminal state, cannot disturb it.
 *
 * WHY THIS IS A DIFFERENT SCALE FROM `f8:no-duplicate-effect`
 * -------------------------------------------------------------
 * That scenario's worker A is gone for seconds, and what replaces it is another
 * ATTEMPT, still in flight. This scenario's stale worker is gone for MINUTES —
 * longer than its own lease, and longer than `jobControlRecoveryReserveMs`
 * (90 000ms, `collections.ts:65`), the longest recovery buffer this system's
 * own control plane reserves for anything. By the time it returns, there is no
 * "in flight" left to collide with: the replacement attempt has not just been
 * claimed, it has COMMITTED, and the lane orchestrator has already reduced the
 * whole JOB to a terminal outcome. The question this asks is stronger than
 * "does the fence still work" — it is "does staleness this old still get
 * caught once there is nothing left in progress to catch it against."
 *
 * NO CHAOS VERB — THIS IS A CLOCK PROPERTY, NOT A TOPOLOGY ONE
 * ---------------------------------------------------------------
 * Every other file in this suite injects a network or process fault. This one
 * does not, on purpose: from the store's point of view it does not matter WHY
 * a worker went silent for two minutes — a suspended container, a GC pause, a
 * black-holed network, or `partition` all look identical once enough real time
 * has passed. So the fault here is TIME itself, and the assertions below print
 * the actual elapsed milliseconds rather than assuming the sleep was long
 * enough — the plan names an exact threshold (90 000ms) and this measures
 * against it, not around it. It still runs against the three-node set, for the
 * same reason every other F8 scenario does: isolation from production, not
 * because this property needs more than one node.
 *
 * WHAT IT PROVES
 * --------------
 *   1. the abandoned attempt is reaped, a replacement claims and COMMITS, and
 *      the lane orchestrator drives the JOB itself to a terminal outcome —
 *      not just the task, the whole job;
 *   2. more than 90 000ms after the original claim (measured, printed), the
 *      stale worker's belated submit is refused;
 *   3. the ALREADY-TERMINAL job's outcome is undisturbed by the refusal, and
 *      exactly one result exists for the task.
 *
 * THE REFUSAL IS FOUR LAYERS DEEP — MEASURED IN `f8-partition-claim-heartbeat`
 * --------------------------------------------------------------------------
 * That file's header records the full trace: falsifying "a superseded worker
 * cannot commit" by disabling ONE guard at a time in `submitAttemptResult`
 * stayed GREEN through three separate attempts, because a FINISHED attempt is
 * refused by FOUR independent layers stacked on top of each other — the top
 * fence comparison (`attempts.ts:1558`), `leaseOwnerAtCommit` (`:1562`), the
 * payload hash (`:1565`), and an unconditional fall-through (`:1587`) that
 * refuses a FINISHED attempt by default unless a narrow idempotent-resubmit
 * shape matches. Only disabling all four TOGETHER produces the true unguarded
 * commit. That trace is not repeated here; check 2 below rests on the same
 * four layers, for the same call shape, and the same conclusion applies: this
 * file proves the OVERALL property, not any one of the four lines in isolation.
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 * - Not `stop-control-recovery.ts`'s own machinery. `jobControlRecoveryReserveMs`
 *   is used here only as the PLAN's own definition of "long enough" — a scale
 *   borrowed from this codebase's control plane, not a code path this file
 *   exercises. Nothing here calls into stop-control-recovery.
 * - Not that any SINGLE one of the four layers above is what refuses THIS
 *   scenario's stale worker — see above. What is specific to THIS file, and not
 *   already covered by `f8-partition-claim-heartbeat`, is the TIME SCALE (past
 *   `jobControlRecoveryReserveMs`, measured) and the JOB reaching a genuinely
 *   terminal outcome (via `drainLane`) before the stale submit arrives, rather
 *   than merely a superseded attempt.
 *
 * FALSIFIED BY (RUN, verified to turn ✗ — same four-layer trace as
 * `f8-partition-claim-heartbeat`, re-run against THIS file's call shape):
 * - disabling any ONE of the four layers (`attempts.ts:1558`, `:1562`, `:1565`,
 *   or `:1587`) alone — check 2 stays GREEN each time.
 * - disabling all four TOGETHER — check 2 fails: `submitAttemptResult` reports
 *   `committed:true` for the stale, minutes-late worker.
 *
 * ONE MORE THING THIS RUN SHOWED: the fourth layer's fall-through (`:1587`) is
 * a pure DECISION with no write behind it — every early return inside the
 * `lifecycle === 'FINISHED'` branch is read-only. So disabling only that
 * branch's guard corrupts the SIGNAL a stale worker receives (`committed:true`
 * when it must be false) without necessarily creating a second document in
 * `results` — check 3 below ("exactly ONE result") stayed GREEN even under
 * this falsification, because nothing on that path ever writes one. The two
 * checks are deliberately worded around this: check 2 is about the ANSWER the
 * caller gets, check 3 is about what actually landed on disk. Conflating them
 * would have made check 3 claim more than it measured.
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:delayed-retry-after-terminal
 */
import 'dotenv/config';

import assert from 'node:assert/strict';

import { connectV2Store } from '../orchestration/store/connect.js';
import { acceptStartCommand } from '../orchestration/store/command-boundary.js';
import { drainLane } from '../orchestration/store/lane-orchestrator.js';
import { getJobStatus } from '../orchestration/store/queries.js';
import { CONTROL_BUDGET_POLICY_V1 } from '../orchestration/store/collections.js';
import {
  createTask,
  dispatchAttempt,
  claimAttempt,
  startAttemptOperation,
  markAttemptPayloadReady,
  submitAttemptResult,
  reapExpiredLeases,
} from '../orchestration/store/attempts.js';
import {
  COLLECTIONS,
  ensureOrchestrationIndexes,
  type AttemptDoc,
  type TaskDoc,
} from '../orchestration/store/collections.js';

const URI = process.env.F8_RS3_URI
  ?? 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const DB = `f8_delayed_${Date.now()}`;
// Comfortably past BOTH the attempt's own lease and jobControlRecoveryReserveMs
// (90_000ms) — the plan's own definition of "long enough" for this scenario.
const TOTAL_DELAY_MS = CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs + 10_000;

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('f8:delayed-retry-after-terminal');
console.log(`  threshold: jobControlRecoveryReserveMs=${CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs}ms, `
  + `waiting past ${TOTAL_DELAY_MS}ms total`);

const store = await connectV2Store({ uri: URI, dbName: DB });
const { client, db } = store;
const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

try {
  await ensureOrchestrationIndexes(db);

  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_f8d', conversationId: 'conv_f8d', goal: 'work resurrected long after it was replaced',
    commandId: `cmd_f8d_${Date.now()}`, payload: { op: 'f8d' },
  });
  const taskId = await createTask(client, db, accepted.jobId);
  const { attemptId: staleAttemptId } = await dispatchAttempt(client, db, {
    jobId: accepted.jobId, taskId,
  });

  const claimedAt = Date.now();
  const staleLease = await claimAttempt(client, db, {
    attemptId: staleAttemptId, workerInstanceId: 'worker-stale', leaseTtlMs: 5_000,
  });
  assert.ok(staleLease, 'the stale worker must get the lease before going silent');
  const staleFence = staleLease!.attemptFence;
  assert.equal(await startAttemptOperation(client, db, {
    attemptId: staleAttemptId, leaseOwner: 'worker-stale', attemptFence: staleFence,
  }), true, 'the stale worker must have been genuinely mid-operation when it went silent');
  console.log(`  worker-stale claimed and started, fence=${staleFence} — now goes silent`);

  // ── the world moves on without it ──────────────────────────────────────────
  await check('the abandoned attempt is reaped, a replacement commits, and the JOB reaches terminal', async () => {
    await sleep(6_000); // past the 5s lease, promptly — the LONG wait comes later
    const reaped = await reapExpiredLeases(client, db);
    assert.ok(reaped >= 1, `the expired lease must be reaped, got ${reaped}`);
    const lost = await attempts.findOne({ _id: staleAttemptId });
    assert.equal(lost?.outcome, 'WORKER_LOST');
    assert.ok((lost?.attemptFence ?? 0) > staleFence, 'the fence must have advanced past the stale worker');

    const next = await dispatchAttempt(client, db, { jobId: accepted.jobId, taskId });
    const lease = await claimAttempt(client, db, {
      attemptId: next.attemptId, workerInstanceId: 'worker-fresh', leaseTtlMs: 60_000,
    });
    assert.ok(lease, 'worker-fresh must claim the replacement');
    const fence = lease!.attemptFence;
    const producer = { status: 'ok', data: { text: 'worker-fresh finished long before the stale worker returned' } };
    assert.equal(await startAttemptOperation(client, db, { attemptId: next.attemptId, leaseOwner: 'worker-fresh', attemptFence: fence }), true);
    const ready = await markAttemptPayloadReady(client, db, { attemptId: next.attemptId, leaseOwner: 'worker-fresh', attemptFence: fence, producer });
    assert.equal(ready.ready, true);
    const committed = await submitAttemptResult(client, db, {
      attemptId: next.attemptId, leaseOwner: 'worker-fresh', attemptFence: fence, producer,
      businessPayloadReadyGeneration: ready.generation,
    });
    assert.equal(committed.committed, true, `the replacement must commit, got: ${JSON.stringify(committed.reason)}`);

    // Not just the TASK — drive the lane orchestrator until the JOB itself
    // reaches a terminal outcome. Every other scenario in this suite stops at
    // "task SUCCEEDED"; this one goes further because the property under test
    // is specifically about a job that is ALREADY DONE, not merely superseded.
    for (let round = 0; round < 20; round++) {
      const processed = await drainLane(client, db);
      if (processed === 0) break;
    }
    const status = await getJobStatus(db, 'res_f8d', accepted.jobId);
    assert.equal(status?.terminalOutcome, 'COMPLETED',
      `the job must reach a terminal outcome before the stale worker returns, got: ${JSON.stringify(status)}`);
    console.log('  job reached terminalOutcome=COMPLETED — nothing is "in flight" anymore');
  });

  // ── the stale worker returns, long after there was anything to collide with ─
  await check(`worker-stale's belated submit is refused, measured >${CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs}ms later`, async () => {
    const elapsedSoFar = Date.now() - claimedAt;
    const remaining = TOTAL_DELAY_MS - elapsedSoFar;
    if (remaining > 0) await sleep(remaining);
    const elapsed = Date.now() - claimedAt;
    console.log(`    elapsed since original claim: ${elapsed}ms `
      + `(threshold ${CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs}ms)`);
    assert.ok(elapsed > CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs,
      'the test itself must wait past the named threshold — measured, not assumed');

    const stale = await submitAttemptResult(client, db, {
      attemptId: staleAttemptId, leaseOwner: 'worker-stale', attemptFence: staleFence,
      producer: { status: 'ok', data: { text: 'worker-stale should never land — the job is already done' } },
    });
    assert.equal(stale.committed, false,
      'the stale worker\'s submit was told it COMMITTED — a worker that was cut off and replaced must '
      + 'be told the truth about a job that already finished, whether or not a second result document '
      + 'ends up on disk (see the header: some refusal paths are decisions with no write behind them)');
    assert.match(String(stale.reason ?? ''), /stale|fence|lease|cutoff/i,
      `the refusal must name the reason, got: ${JSON.stringify(stale.reason)}`);
    console.log(`    worker-stale refused: ${stale.reason}`);
  });

  await check('the terminal job is undisturbed, and exactly ONE result exists for the task', async () => {
    const status = await getJobStatus(db, 'res_f8d', accepted.jobId);
    assert.equal(status?.terminalOutcome, 'COMPLETED', 'the belated refusal must not have changed the job\'s outcome');
    const results = await db.collection(COLLECTIONS.results).find({ taskId } as never).toArray();
    assert.equal(results.length, 1, `exactly one result for the task, found ${results.length}`);
    assert.match(JSON.stringify(results[0]), /worker-fresh finished/);
    const task = await tasks.findOne({ _id: taskId });
    assert.equal(task?.phase, 'SUCCEEDED');
  });
} catch (err) {
  const cause = (err as { cause?: unknown }).cause;
  console.error(`\n  UNCAUGHT: ${(err as Error).message}`);
  if (cause) console.error(`  cause: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause)).slice(0, 400)}`);
  failures += 1;
} finally {
  await db.dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
}

if (failures > 0) {
  console.error(`\n❌ f8:delayed-retry-after-terminal — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:delayed-retry-after-terminal — a worker resurrected minutes after the job finished cannot touch it');
process.exit(0);
