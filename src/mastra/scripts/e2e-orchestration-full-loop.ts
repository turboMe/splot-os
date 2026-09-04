#!/usr/bin/env tsx
/**
 * e2e:orchestration-full-loop — the vertical slice end to end (§30, §7.1).
 *
 * accept → plan → dispatch → worker claim → submit result → job terminalizes
 * from its task outcome. Proves the whole durable spine cooperates: command
 * boundary, task/attempt lease/fence + A boundary, and job reduction (B side).
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  planJob, dispatchAttempt, claimAttempt, markAttemptPayloadReady,
  startAttemptOperation, submitAttemptResult, advanceJobFromTasks,
  getJobStatus,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-full-loop');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_loop_e2e_${Date.now()}`,
    section: 'e2e:orchestration-full-loop',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1', goal: 'do the work' };

  try {
    await ensureOrchestrationIndexes(db);

    await check('accept→plan→dispatch→claim→submit(ok)→job COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'loop_ok', payload: { op: 'ok' } });
      const plan = await planJob(client, db, acc.jobId);
      assert.ok(plan, 'planned');
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.phase, 'DISPATCHING');

      const { attemptId } = await dispatchAttempt(client, db, { jobId: acc.jobId, taskId: plan!.taskId });
      const lease = await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' });
      assert.ok(lease);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease.attemptFence,
      }), true);
      const producer = { status: 'ok', data: { done: true } };
      const ready = await markAttemptPayloadReady(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease!.attemptFence, producer,
      });
      const sub = await submitAttemptResult(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease!.attemptFence, producer,
        businessPayloadReadyGeneration: ready.generation,
      });
      assert.equal(sub.outcome, 'OK');

      // the wake/result drives job reduction (here invoked directly)
      const outcome = await advanceJobFromTasks(client, db, acc.jobId);
      assert.equal(outcome, 'COMPLETED');
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.phase, 'TERMINAL');
      assert.equal(st?.terminalOutcome, 'COMPLETED');
      assert.equal(st?.lastEvent?.type, 'JobTerminalized');
    });

    await check('failed result → job FAILED (no false success)', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'loop_fail', payload: { op: 'fail' } });
      const plan = await planJob(client, db, acc.jobId);
      const { attemptId } = await dispatchAttempt(client, db, { jobId: acc.jobId, taskId: plan!.taskId });
      const lease = await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' });
      assert.ok(lease);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease.attemptFence,
      }), true);
      // prose → invalid → attempt FAILED → task FAILED
      const sub = await submitAttemptResult(client, db, { attemptId, leaseOwner: 'worker-A', attemptFence: lease!.attemptFence, producer: 'totally fine, trust me' });
      assert.equal(sub.outcome, 'FAILED');
      const outcome = await advanceJobFromTasks(client, db, acc.jobId);
      assert.equal(outcome, 'FAILED');
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'FAILED');
    });

    await check('advance is idempotent and does not re-terminalize', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'loop_idem', payload: { op: 'i' } });
      const plan = await planJob(client, db, acc.jobId);
      const { attemptId } = await dispatchAttempt(client, db, { jobId: acc.jobId, taskId: plan!.taskId });
      const lease = await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-A' });
      assert.ok(lease);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease.attemptFence,
      }), true);
      const producer = { status: 'ok', data: {} };
      const ready = await markAttemptPayloadReady(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease!.attemptFence, producer,
      });
      await submitAttemptResult(client, db, {
        attemptId, leaseOwner: 'worker-A', attemptFence: lease!.attemptFence, producer,
        businessPayloadReadyGeneration: ready.generation,
      });
      assert.equal(await advanceJobFromTasks(client, db, acc.jobId), 'COMPLETED');
      const stateV = (await getJobStatus(db, base.resourceId, acc.jobId))?.stateVersion;
      assert.equal(await advanceJobFromTasks(client, db, acc.jobId), null, 'second advance is a no-op');
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.stateVersion, stateV, 'stateVersion unchanged');
    });

    await check('advance is a no-op while the task is still running', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'loop_wip', payload: { op: 'w' } });
      const plan = await planJob(client, db, acc.jobId);
      await dispatchAttempt(client, db, { jobId: acc.jobId, taskId: plan!.taskId });
      assert.equal(await advanceJobFromTasks(client, db, acc.jobId), null);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.phase, 'DISPATCHING');
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-full-loop — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-full-loop — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
