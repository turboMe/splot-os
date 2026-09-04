#!/usr/bin/env tsx
/**
 * e2e:orchestration-timers — durable timers + retry backoff (plan §10, §7.3).
 *
 *  - a durable timer fires only once due, and its firing wakes the lane;
 *  - a lost worker with backoff re-opens the task with retryNotBefore + a timer;
 *    the lane does NOT re-dispatch before backoff, and does after the timer fires;
 *  - a timer for an already-terminal job fires but resurrects nothing;
 *  - cancelled timers do not fire.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand, cancelJob,
  armTimer, fireDueTimers, cancelTimers,
  drainLane, runToQuiescence, okWorker, claimAttempt, reapExpiredLeases,
  getJobStatus, COLLECTIONS, type AttemptDoc, type TaskDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-timers');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_timers_e2e_${Date.now()}`,
    section: 'e2e:orchestration-timers',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const base = { resourceId: 'res_1', conversationId: 'conv_1', goal: 'timed work' };

  try {
    await ensureOrchestrationIndexes(db);

    await check('a durable timer fires only once due, and wakes the lane', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'tmr_fire', payload: { op: 'f' } });
      await drainLane(client, db); // consume accept wake so it does not confound the count
      await armTimer(db, { kind: 'job_deadline', jobId: acc.jobId, entityId: acc.jobId, fireAt: new Date(Date.now() + 300) });
      assert.equal(await fireDueTimers(client, db), 0, 'not due yet');
      await sleep(350);
      assert.equal(await fireDueTimers(client, db), 1, 'fires once due');
      assert.equal(await fireDueTimers(client, db), 0, 'does not re-fire');
      assert.equal(await db.collection(COLLECTIONS.outbox).countDocuments({ aggregate: acc.jobId, state: 'PENDING' }), 1, 'firing emitted a lane wake');
    });

    await check('retry backoff: lane does not re-dispatch before backoff, does after timer fires', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'tmr_backoff', payload: { op: 'b' } });
      await drainLane(client, db); // plan + dispatch attempt #1
      const att = await attempts.findOne({ jobId: acc.jobId, lifecycle: 'QUEUED' });
      await claimAttempt(client, db, { attemptId: att!._id, workerInstanceId: 'w-dead' });
      await attempts.updateOne({ _id: att!._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      await reapExpiredLeases(client, db, { retryBackoffMs: 400 }); // WORKER_LOST + RETRY_PENDING + timer, NO immediate wake

      const t = await tasks.findOne({ jobId: acc.jobId });
      assert.equal(t?.phase, 'RETRY_PENDING');
      assert.ok(t?.retryNotBefore, 'retryNotBefore set');

      // before backoff: draining lane must NOT create a second attempt
      await drainLane(client, db);
      await fireDueTimers(client, db); // not due yet
      assert.equal(await attempts.countDocuments({ jobId: acc.jobId }), 1, 'no premature retry');

      // after backoff: the timer fires → lane re-dispatches → completes
      await sleep(450);
      await fireDueTimers(client, db);
      await runToQuiescence(client, db, drainLane, okWorker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED');
      assert.equal(await attempts.countDocuments({ jobId: acc.jobId }), 2, 'exactly one retry attempt');
    });

    await check('a timer for an already-terminal job resurrects nothing', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'tmr_terminal', payload: { op: 't' } });
      await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cx', jobId: acc.jobId });
      await armTimer(db, { kind: 'job_deadline', jobId: acc.jobId, entityId: acc.jobId, fireAt: new Date(Date.now() - 10) });
      const fired = await fireDueTimers(client, db);
      assert.ok(fired >= 1, 'the timer fired');
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.terminalOutcome, 'CANCELLED', 'still cancelled');
      assert.equal(st?.phase, 'TERMINAL');
    });

    await check('cancelled timers do not fire', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'tmr_cancel', payload: { op: 'c' } });
      await armTimer(db, { kind: 'job_deadline', jobId: acc.jobId, entityId: acc.jobId, fireAt: new Date(Date.now() - 10) });
      assert.equal(await cancelTimers(db, acc.jobId), 1);
      assert.equal(await fireDueTimers(client, db), 0, 'cancelled timer does not fire');
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-timers — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-timers — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
