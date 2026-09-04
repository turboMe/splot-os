#!/usr/bin/env tsx
/**
 * F6 work item 4 — the Task Ledger is a PROJECTION, not a second scheduler.
 *
 * Cutting delegation and automation onto durable jobs created two authorities
 * answering the same questions, and both answers are silent when wrong:
 *
 *  1. **Who decides whether work is alive?** `reconcileStaleLanes` judges a lane
 *     by its heartbeat and marks it `failed`. A durable job survives restarts,
 *     is retried after `WORKER_LOST` and can wait on a human — all of which look
 *     exactly like silence. Worse, terminal lane states are ABSORBING and
 *     `ledgerTransitionBySource` returns early on a terminal lane, so the real
 *     `done` that arrives later is dropped without a word. The read model would
 *     report a permanent failure that never happened.
 *  2. **Who decides whether new work starts?** The kill switch means "background
 *     lanes are paused" and every legacy loop honours it. The durable lane
 *     orchestrator dispatches from the store and had never heard of it — so the
 *     operator's stop stopped LESS the more work was migrated, while still
 *     reading as "stopped".
 *
 * These run against the REAL ledger collection and the REAL mount loop. A fake
 * lane would only re-test the idea; the bug lives in the interaction between the
 * reconciler, absorbing terminal states and a job that outlives its heartbeat.
 *
 * Run: npx tsx src/mastra/scripts/check-ledger-projection.ts
 */
import assert from 'node:assert/strict';

import {
  openLane,
  transitionLane,
  findLaneBySource,
  reconcileStaleLanes,
  ledgerMarkDurable,
  ledgerProjectDurableState,
  ledgerTransitionBySource,
  isLedgerEnabled,
} from '../services/task-ledger.js';
import { getDb } from '../lib/mongo.js';
import { replicaSetUriOrSkip, skipSectionOrFail } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const TAG = `chk-ledgerproj-${Date.now()}`;
const LANES = 'task_lanes';

console.log('check:ledger-projection');

if (!isLedgerEnabled()) {
  console.log('  ⚠ SKIP — FEATURE_TASK_LEDGER is off, so there are no lanes to project onto');
  process.exit(0);
}

const db = await getDb();

/** A lane that is already past its staleness window — the pre-F6 situation. */
async function staleLane(sourceId: string, opts: { durable?: string } = {}): Promise<void> {
  await openLane({
    source: 'async_delegation',
    sourceId,
    goal: `${TAG} projection probe`,
    agentId: 'researcherAgent',
    state: 'running',
    staleAfterMs: 50,
  });
  if (opts.durable) await ledgerMarkDurable('async_delegation', sourceId, opts.durable);
  await new Promise((r) => setTimeout(r, 120));
}

// ── 1. Liveness has ONE authority ──────────────────────────────────────────
await check('LIVE REGRESSION: a heartbeat-owned lane is still judged stale (unchanged)', async () => {
  // The old behaviour must survive for work the Ledger really does own —
  // otherwise this change would trade a false failure for a lane that never
  // closes.
  const sourceId = `${TAG}-legacy`;
  await staleLane(sourceId);
  await reconcileStaleLanes();
  const lane = await findLaneBySource('async_delegation', sourceId);
  assert.equal(lane?.state, 'failed');
  assert.match(String(lane?.error), /stale/);
});

await check('LIVE REGRESSION: a DURABLE lane is not judged by a heartbeat nobody sends', async () => {
  // This is the defect the cutover introduced: the work moved to a substrate
  // with leases and retries, and the Ledger kept timing it with a stopwatch.
  const sourceId = `${TAG}-durable`;
  await staleLane(sourceId, { durable: 'job_probe_1' });
  await reconcileStaleLanes();
  const lane = await findLaneBySource('async_delegation', sourceId);
  assert.equal(lane?.state, 'running', 'the substrate decides whether its job is alive');
  assert.equal(lane?.owner, 'durable');
  assert.equal(lane?.durableJobId, 'job_probe_1');
});

await check('LIVE REGRESSION: the false failure was PERMANENT — that is why it mattered', async () => {
  // Terminal lane states are absorbing and `ledgerTransitionBySource` returns
  // early on a terminal lane, so before this change a job that completed after
  // being wrongly marked stale could never correct the record. Proven on the
  // legacy path, which still behaves that way by design.
  const sourceId = `${TAG}-absorbing`;
  await staleLane(sourceId);
  await reconcileStaleLanes();
  await ledgerTransitionBySource('async_delegation', sourceId, 'done', { milestone: 'really finished' });
  const lane = await findLaneBySource('async_delegation', sourceId);
  assert.equal(lane?.state, 'failed', 'a terminal lane absorbs the truth arriving late — silently');
});

await check('a durable lane that later completes reaches done, because nothing closed it early', async () => {
  const sourceId = `${TAG}-durable-done`;
  await staleLane(sourceId, { durable: 'job_probe_2' });
  await reconcileStaleLanes();
  await ledgerTransitionBySource('async_delegation', sourceId, 'done', { milestone: 'durable finished' });
  const lane = await findLaneBySource('async_delegation', sourceId);
  assert.equal(lane?.state, 'done', 'the outcome the substrate reported is the one the read model shows');
});

// ── 2. A projection may mirror, never overrule ─────────────────────────────
await check('projection mirrors AWAITING_USER onto the lane', async () => {
  const sourceId = `${TAG}-await`;
  await openLane({
    source: 'async_delegation', sourceId, goal: `${TAG} awaiting`,
    state: 'running', staleAfterMs: 60_000,
  });
  await ledgerMarkDurable('async_delegation', sourceId, 'job_probe_3');
  await ledgerProjectDurableState('async_delegation', sourceId, 'awaiting_approval', 'waiting for an answer');
  const lane = await findLaneBySource('async_delegation', sourceId);
  assert.equal(lane?.state, 'awaiting_approval',
    'the digest must say "waiting for you", not "running", for a job that will not move on its own');
});

await check('projection is idempotent and can return the lane to running', async () => {
  const sourceId = `${TAG}-await`;
  await ledgerProjectDurableState('async_delegation', sourceId, 'awaiting_approval');
  await ledgerProjectDurableState('async_delegation', sourceId, 'running', 'answer applied');
  await ledgerProjectDurableState('async_delegation', sourceId, 'running');
  const lane = await findLaneBySource('async_delegation', sourceId);
  assert.equal(lane?.state, 'running');
});

await check('SECURITY: a projection refuses to move a lane the substrate does not own', async () => {
  // A projection that could write anywhere is not a projection, it is a second
  // writer with a nicer name.
  const sourceId = `${TAG}-notdurable`;
  await openLane({
    source: 'async_delegation', sourceId, goal: `${TAG} not durable`,
    state: 'running', staleAfterMs: 60_000,
  });
  await ledgerProjectDurableState('async_delegation', sourceId, 'awaiting_approval');
  const lane = await findLaneBySource('async_delegation', sourceId);
  assert.equal(lane?.state, 'running', 'only a durable-owned lane is projectable');
});

await check('a projection cannot resurrect a closed lane', async () => {
  const sourceId = `${TAG}-closed`;
  const lane = await openLane({
    source: 'async_delegation', sourceId, goal: `${TAG} closed`,
    state: 'running', staleAfterMs: 60_000,
  });
  await ledgerMarkDurable('async_delegation', sourceId, 'job_probe_4');
  await transitionLane(lane.laneId, 'done');
  await ledgerProjectDurableState('async_delegation', sourceId, 'running');
  assert.equal((await findLaneBySource('async_delegation', sourceId))?.state, 'done');
});

// ── 3. The operator stop reaches the durable lane ──────────────────────────
//
// Driven through the REAL mount, with its real timers and a real store, because
// the claim is about what the loop does — not about what the code says. Needs a
// replica set; skipped without one rather than asserted on source text.
const RS_URI = await replicaSetUriOrSkip('check:ledger-projection kill-switch section');
const MOUNT_DB = `ledgerproj_${Date.now()}`;

const { configureV2Mount, startV2Mount, getV2Store, __closeV2Store } =
  await import('../orchestration/http/mastra-routes.js');
const { acceptStartCommand, COLLECTIONS } = await import('../orchestration/store/index.js');

let mounted = false;
let paused = true;
try {
  if (!RS_URI) throw new Error('no replica set');
  configureV2Mount({
    uri: RS_URI,
    dbName: MOUNT_DB,
    startBackground: true,
    laneTickMs: 50,
    reconcileTickMs: 10_000,
    pauseDispatch: async () => paused,
  });
  await startV2Mount();
  await getV2Store();
  mounted = true;
} catch (error) {
  // `replicaSetUriOrSkip` has already reported (or failed on) a missing replica
  // set; anything else here is the mount itself refusing to start.
  if (RS_URI) {
    skipSectionOrFail(
      'check:ledger-projection kill-switch section',
      `the V2 mount could not start (${(error as Error).message})`,
      'verify the replica set with `npm run check:replica-set`',
    );
  }
}

if (mounted) {
  const { client, db } = await getV2Store();
  const plannedTaskCount = async (jobId: string): Promise<number> =>
    db.collection(COLLECTIONS.tasks).countDocuments({ jobId });

  await check('LIVE REGRESSION: with the stop on, an accepted job is NOT dispatched', async () => {
    // Before this, migrating a mechanism onto durable jobs silently removed it
    // from the kill switch's reach — a safety control that stops less the more
    // you migrate, while still reading as "stopped".
    paused = true;
    const { jobId } = await acceptStartCommand(client, db, {
      resourceId: `res_${TAG}`, conversationId: `conv_${TAG}`, goal: 'paused work',
      commandId: `cmd_${TAG}_paused`, payload: { n: 1 },
    });
    await new Promise((r) => setTimeout(r, 600)); // ~12 lane ticks
    assert.equal(await plannedTaskCount(jobId), 0, 'a stopped lane must plan nothing');
    const job = await db.collection(COLLECTIONS.jobs).findOne({ _id: jobId } as never);
    assert.equal((job as unknown as { phase: string }).phase, 'ACCEPTED',
      'and the job must still be waiting, not failed — pause is not cancel');
  });

  await check('releasing the stop lets the same job proceed', async () => {
    // The other half: a pause that never resumes is an outage, not a control.
    const { jobId } = await acceptStartCommand(client, db, {
      resourceId: `res_${TAG}`, conversationId: `conv_${TAG}`, goal: 'resumed work',
      commandId: `cmd_${TAG}_resumed`, payload: { n: 2 },
    });
    paused = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await plannedTaskCount(jobId) === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(await plannedTaskCount(jobId) > 0, 'work must resume once the operator lifts the stop');
  });

  await check('a switch that THROWS fails open — a stuck read is not a stop', async () => {
    configureV2Mount({ pauseDispatch: async () => { throw new Error('mongo down'); } });
    const { jobId } = await acceptStartCommand(client, db, {
      resourceId: `res_${TAG}`, conversationId: `conv_${TAG}`, goal: 'failing switch',
      commandId: `cmd_${TAG}_throws`, payload: { n: 3 },
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await plannedTaskCount(jobId) === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(await plannedTaskCount(jobId) > 0,
      'an unreadable switch must not silently halt every background job in the system');
  });

  await client.db(MOUNT_DB).dropDatabase();
  await __closeV2Store();
  configureV2Mount({ pauseDispatch: undefined });
}

// ── cleanup ────────────────────────────────────────────────────────────────
await db.collection(LANES).deleteMany({ sourceId: { $regex: `^${TAG}` } });

console.log(failures === 0 ? '\n✅ check:ledger-projection passed' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
