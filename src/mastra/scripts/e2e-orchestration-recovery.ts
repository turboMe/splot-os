#!/usr/bin/env tsx
/**
 * e2e:orchestration-recovery — worker-loss recovery + bounded retry (§7.3, G4).
 *
 *  - a worker claims an attempt then dies (lease expires); the reaper fences it
 *    WORKER_LOST, re-opens the task (RETRY_PENDING) and wakes the lane, which
 *    dispatches a fresh attempt; a healthy worker then completes the job.
 *  - repeated loss past maxAttempts terminalizes the task (and job) FAILED — no
 *    infinite retry.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  drainLane, runToQuiescence, okWorker, claimAttempt, reapExpiredLeases, getJobStatus,
  COLLECTIONS, type AttemptDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-recovery');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_recovery_e2e_${Date.now()}`,
    section: 'e2e:orchestration-recovery',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const base = { resourceId: 'res_1', conversationId: 'conv_1', goal: 'resilient work' };

  /** Dispatch (or re-dispatch) the job's attempt, then simulate a worker crash:
   *  claim it, expire its lease, and run the reaper. */
  async function crashCurrentAttempt(jobId: string, worker: string, maxAttempts: number): Promise<string | null> {
    await drainLane(client, db); // plan+dispatch on first call; re-dispatch after RETRY_PENDING
    const att = await attempts.findOne({ jobId, lifecycle: 'QUEUED' });
    if (!att) return null;
    await claimAttempt(client, db, { attemptId: att._id, workerInstanceId: worker });
    await attempts.updateOne({ _id: att._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await reapExpiredLeases(client, db, { maxAttempts });
    return att._id;
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('worker dies → reaper retries → healthy worker completes', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'rec_ok', payload: { op: 'ok' } });
      const lost = await crashCurrentAttempt(acc.jobId, 'worker-dead', 3);
      assert.ok(lost, 'dispatched then lost attempt #1');
      assert.equal((await attempts.findOne({ _id: lost! }))?.outcome, 'WORKER_LOST');

      // now a healthy worker + lane run to quiescence
      await runToQuiescence(client, db, drainLane, okWorker);
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.terminalOutcome, 'COMPLETED');
      const all = await attempts.find({ jobId: acc.jobId }).sort({ attemptNumber: 1 }).toArray();
      assert.equal(all.length, 2, 'a fresh attempt was dispatched after loss');
      assert.equal(all[0]?.outcome, 'WORKER_LOST');
      assert.equal(all[0]?.attemptNumber, 1);
      assert.equal(all[1]?.outcome, 'OK');
      assert.equal(all[1]?.attemptNumber, 2);
    });

    await check('repeated loss past maxAttempts → job FAILED (no infinite retry)', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'rec_fail', payload: { op: 'fail' } });
      await crashCurrentAttempt(acc.jobId, 'w1', 2); // attempt #1 lost → RETRY_PENDING (1 < 2)
      await crashCurrentAttempt(acc.jobId, 'w2', 2); // attempt #2 lost → FAILED (2 >= 2)
      await drainLane(client, db); // advance job from the failed task
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.terminalOutcome, 'FAILED');
      const all = await attempts.find({ jobId: acc.jobId }).toArray();
      assert.equal(all.length, 2);
      assert.ok(all.every((a) => a.outcome === 'WORKER_LOST'));
    });

    await check('a still-live lease is not reaped', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'rec_live', payload: { op: 'live' } });
      await drainLane(client, db); // dispatch
      const att = await attempts.findOne({ jobId: acc.jobId, lifecycle: 'QUEUED' });
      await claimAttempt(client, db, { attemptId: att!._id, workerInstanceId: 'worker-live' }); // fresh lease, not expired
      const reaped = await reapExpiredLeases(client, db);
      assert.equal(reaped, 0, 'live lease survives the reaper');
      assert.equal((await attempts.findOne({ _id: att!._id }))?.lifecycle, 'LEASED');
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-recovery — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-recovery — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
