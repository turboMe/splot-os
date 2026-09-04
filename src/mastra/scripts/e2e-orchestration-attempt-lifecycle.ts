#!/usr/bin/env tsx
/**
 * e2e:orchestration-attempt-lifecycle — task/attempt with lease/fence (§7.2/7.3).
 *
 * Proves the hard execution correctness against a real replica set:
 *  - dispatch → claim (lease + fence) → renew → submit → FINISHED/OK, task SUCCEEDED
 *  - a valid `ok` result advances the task; prose/empty → FAILED(invalid_result),
 *    never a false OK (RES-001 wired into the A boundary)
 *  - fencing: an expired lease reaped (fence++) → the old worker cannot submit
 *  - a stale-fence renew is rejected
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 *   npm run spike:mongo-rs:up && npm run e2e:orchestration-attempt-lifecycle
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  createTask, dispatchAttempt, claimAttempt, renewLease, markAttemptPayloadReady,
  startAttemptOperation, submitAttemptResult, reapExpiredLeases,
  COLLECTIONS, type AttemptDoc, type TaskDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-attempt-lifecycle');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_attempt_e2e_${Date.now()}`,
    section: 'e2e:orchestration-attempt-lifecycle',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

  async function newJobTask(cmd: string): Promise<{ jobId: string; taskId: string }> {
    const r = await acceptStartCommand(client, db, { resourceId: 'res_1', conversationId: 'conv_1', goal: 'work', commandId: cmd, payload: { op: cmd } });
    const taskId = await createTask(client, db, r.jobId);
    return { jobId: r.jobId, taskId };
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('happy path: dispatch→claim→renew→submit(ok) → FINISHED/OK, task SUCCEEDED', async () => {
      const { jobId, taskId } = await newJobTask('cmd_happy');
      const { attemptId, attemptNumber } = await dispatchAttempt(client, db, { jobId, taskId });
      assert.equal(attemptNumber, 1);
      const lease = await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' });
      assert.ok(lease, 'claim succeeded');
      assert.equal(lease!.attemptFence, 1, 'fence raised on claim');
      assert.equal(await renewLease(db, { attemptId, leaseOwner: 'worker-A', attemptFence: 1 }), true);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: 1,
      }), true);
      const producer = { status: 'ok', data: { answer: 42 } };
      const ready = await markAttemptPayloadReady(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: 1, producer,
      });
      assert.equal(ready.ready, true);
      const sub = await submitAttemptResult(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: 1, producer,
        businessPayloadReadyGeneration: ready.generation,
      });
      assert.equal(sub.committed, true);
      assert.equal(sub.outcome, 'OK');
      const att = await attempts.findOne({ _id: attemptId });
      assert.equal(att?.lifecycle, 'FINISHED');
      assert.equal(att?.outcome, 'OK');
      assert.ok(att?.resultId);
      assert.equal(att?.leaseOwner, null, 'lease released on finish');
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'SUCCEEDED');
      assert.equal(await db.collection(COLLECTIONS.results).countDocuments({ attemptId }), 1);
    });

    await check('invalid result (prose) → FAILED(invalid_result), never OK (RES-001)', async () => {
      const { jobId, taskId } = await newJobTask('cmd_prose');
      const { attemptId } = await dispatchAttempt(client, db, { jobId, taskId });
      const lease = await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' });
      assert.ok(lease);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease.attemptFence,
      }), true);
      const sub = await submitAttemptResult(client, db, { attemptId, leaseOwner: 'worker-A', attemptFence: 1, producer: 'here is my long prose answer, all good' });
      assert.equal(sub.committed, true);
      assert.equal(sub.outcome, 'FAILED');
      assert.equal(sub.reason, 'invalid_result');
      const att = await attempts.findOne({ _id: attemptId });
      assert.equal(att?.outcome, 'FAILED');
      assert.equal(att?.reasonCode, 'invalid_result');
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'FAILED');
      assert.equal(await db.collection(COLLECTIONS.results).countDocuments({ attemptId }), 0, 'no result doc for invalid');
    });

    await check('fencing: expired lease reaped → stale worker cannot submit', async () => {
      const { jobId, taskId } = await newJobTask('cmd_fence');
      const { attemptId } = await dispatchAttempt(client, db, { jobId, taskId });
      const lease = await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' });
      assert.equal(lease!.attemptFence, 1);
      // force the lease to be expired, then reap
      await attempts.updateOne({ _id: attemptId }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      const reaped = await reapExpiredLeases(client, db);
      assert.ok(reaped >= 1, 'reaper fenced the expired attempt');
      const afterReap = await attempts.findOne({ _id: attemptId });
      assert.equal(afterReap?.outcome, 'WORKER_LOST');
      assert.equal(afterReap?.attemptFence, 2, 'fence advanced by recovery');
      // the old worker (fence 1) submits late → rejected, nothing committed
      const late = await submitAttemptResult(client, db, { attemptId, leaseOwner: 'worker-A', attemptFence: 1, producer: { status: 'ok', data: {} } });
      assert.equal(late.committed, false);
      assert.equal(late.reason, 'stale_fence_or_lease');
      assert.equal((await attempts.findOne({ _id: attemptId }))?.outcome, 'WORKER_LOST', 'late submit did not overwrite');
      // the reaper re-opens the task for a bounded retry (not falsely succeeded)
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'RETRY_PENDING', 'task re-opened for retry, not succeeded');
    });

    await check('stale-fence renew is rejected', async () => {
      const { jobId, taskId } = await newJobTask('cmd_renew');
      const { attemptId } = await dispatchAttempt(client, db, { jobId, taskId });
      await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' }); // fence 1
      assert.equal(await renewLease(db, { attemptId, leaseOwner: 'worker-A', attemptFence: 0 }), false, 'old fence rejected');
      assert.equal(await renewLease(db, { attemptId, leaseOwner: 'worker-B', attemptFence: 1 }), false, 'wrong owner rejected');
      assert.equal(await renewLease(db, { attemptId, leaseOwner: 'worker-A', attemptFence: 1 }), true, 'current owner+fence ok');
    });

    await check('a QUEUED attempt can only be claimed once', async () => {
      const { jobId, taskId } = await newJobTask('cmd_double');
      const { attemptId } = await dispatchAttempt(client, db, { jobId, taskId });
      const [a, b] = await Promise.all([
        claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' }),
        claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-B' }),
      ]);
      const winners = [a, b].filter((x) => x !== null);
      assert.equal(winners.length, 1, 'exactly one claim wins');
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-attempt-lifecycle — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-attempt-lifecycle — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
