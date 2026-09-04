#!/usr/bin/env tsx
/**
 * e2e:orchestration-command-boundary — durable command boundary (plan §8.1/§15.5).
 *
 * Proves invariant #1 "Durable before ACK" and command idempotency
 * (`ORC-TXN-COMMAND-01`) against a real replica set. Requires the ephemeral RS:
 *   npm run spike:mongo-rs:up && npm run e2e:orchestration-command-boundary
 * If no replica set is reachable, the test SKIPS (exit 0) rather than failing —
 * it is not part of `check:all`, which does not provision a replica set.
 *
 * Uses a throwaway DB dropped on exit; never touches production.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  CommandConflictError, runTxn, COLLECTIONS,
  CONTROL_BUDGET_POLICY_V1,
  getJobStatus, listJobs,
  cancelJob, JobNotFoundError,
  type BudgetReservationDoc, type CommandDoc, type JobDoc, type JobEventDoc,
  type LaneActivationDoc, type OutboxDoc,
} from '../orchestration/store/index.js';
import { claimAndReduceNextWake } from '../orchestration/store/lane.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-command-boundary');

  const store = await connectReplicaSetOrSkip({
    dbName: `orch_cmd_e2e_${Date.now()}`,
    section: 'e2e:orchestration-command-boundary',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const commands = db.collection<CommandDoc>(COLLECTIONS.commands);
  try {
    await ensureOrchestrationIndexes(db);
    const base = { resourceId: 'res_1', conversationId: 'conv_1', goal: 'build a thing' };

    await check('durable accept writes job(ACCEPTED)+event0+wake outbox atomically', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_a', payload: { op: 'x' } });
      assert.ok(r.jobId.startsWith('job_'));
      assert.equal(r.deduped, false);
      const job = await jobs.findOne({ _id: r.jobId });
      assert.equal(job?.phase, 'ACCEPTED');
      assert.equal(job?.stateVersion, 0);
      const ev = await events.findOne({ _id: `${r.jobId}:0` });
      assert.equal(ev?.type, 'JobAccepted');
      const obx = await outbox.findOne({ aggregate: r.jobId });
      assert.equal(obx?.type, 'LaneWakeRequested');
      assert.equal(obx?.state, 'PENDING');
    });

    await check('replay same commandId+payload → same jobId, no duplicate job/event/outbox', async () => {
      const first = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_b', payload: { op: 'y' } });
      const replay = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_b', payload: { op: 'y' } });
      assert.equal(replay.jobId, first.jobId);
      assert.equal(replay.deduped, true);
      assert.equal(await jobs.countDocuments({ resourceId: base.resourceId, goal: base.goal, _id: first.jobId }), 1);
      assert.equal(await events.countDocuments({ jobId: first.jobId }), 1);
      assert.equal(await outbox.countDocuments({ aggregate: first.jobId }), 1);
    });

    await check('same commandId, different payload → CommandConflictError', async () => {
      await acceptStartCommand(client, db, { ...base, commandId: 'cmd_c', payload: { op: 'first' } });
      await assert.rejects(
        () => acceptStartCommand(client, db, { ...base, commandId: 'cmd_c', payload: { op: 'DIFFERENT' } }),
        (e: unknown) => e instanceof CommandConflictError,
      );
    });

    await check('20 concurrent identical commands → exactly one job', async () => {
      const runs = await Promise.all(
        Array.from({ length: 20 }, () => acceptStartCommand(client, db, { ...base, commandId: 'cmd_race', payload: { op: 'race' } })),
      );
      const jobIds = new Set(runs.map((r) => r.jobId));
      assert.equal(jobIds.size, 1, `expected 1 distinct jobId, got ${jobIds.size}`);
      const jobId = [...jobIds][0]!;
      assert.equal(await commands.countDocuments({ commandId: 'cmd_race' }), 1);
      assert.equal(await jobs.countDocuments({ _id: jobId }), 1);
      assert.equal(await events.countDocuments({ jobId }), 1);
      assert.equal(runs.filter((r) => !r.deduped).length, 1, 'exactly one non-deduped accept');
    });

    await check('autonomous wake reduces ACCEPTED→READY, appends event1, publishes wake', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_wake', payload: { op: 'w' } });
      // Drain all pending wakes (earlier tests left some); default reducer moves ACCEPTED→READY.
      for (;;) { const out = await claimAndReduceNextWake(client, db); if (!out.claimed) break; }
      const job = await jobs.findOne({ _id: r.jobId });
      assert.equal(job?.phase, 'READY');
      assert.equal(job?.stateVersion, 1);
      assert.equal(await events.countDocuments({ jobId: r.jobId }), 2);
      const ev1 = await events.findOne({ _id: `${r.jobId}:1` });
      assert.equal(ev1?.type, 'JobReady');
      assert.equal(await outbox.countDocuments({ aggregate: r.jobId, state: 'PENDING' }), 0);
    });

    await check('re-delivered wake does not double-apply (idempotent)', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_wake', payload: { op: 'w' } }); // replay → same READY job
      assert.equal(r.deduped, true);
      // simulate a duplicate wake delivery for an already-READY job
      await outbox.insertOne({ _id: 'dup-wake-1', aggregate: r.jobId, type: 'LaneWakeRequested', state: 'PENDING', payload: {}, createdAt: new Date() });
      const out = await claimAndReduceNextWake(client, db);
      assert.equal(out.claimed, true);
      assert.equal(out.applied, false, 'readyReducer no-ops on a non-ACCEPTED job');
      const job = await jobs.findOne({ _id: r.jobId });
      assert.equal(job?.phase, 'READY');
      assert.equal(job?.stateVersion, 1, 'stateVersion did not advance twice');
      assert.equal(await events.countDocuments({ jobId: r.jobId }), 2, 'no extra event');
    });

    await check('getJobStatus / listJobs are read-only and owner-scoped', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_status', payload: { op: 's' } });
      const st = await getJobStatus(db, base.resourceId, r.jobId);
      assert.equal(st?.phase, 'ACCEPTED');
      assert.equal(st?.lastEvent?.type, 'JobAccepted');
      // wrong owner → null (no cross-resource disclosure)
      assert.equal(await getJobStatus(db, 'res_OTHER', r.jobId), null);
      const list = await listJobs(db, base.resourceId, { limit: 100 });
      assert.ok(list.some((j) => j.jobId === r.jobId));
      assert.ok(list.every((j) => j.resourceId === base.resourceId));
      // status query did not mutate
      const stAfter = await getJobStatus(db, base.resourceId, r.jobId);
      assert.equal(stAfter?.stateVersion, st?.stateVersion);
    });

    await check('cancel_job crosses the unified stop barrier and emits one terminal outbox', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_cx', payload: { op: 'c' } });
      const res = await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cancel_1', jobId: r.jobId });
      assert.equal(res.terminalOutcome, 'CANCELLED');
      assert.equal(res.alreadyTerminal, false);
      const st = await getJobStatus(db, base.resourceId, r.jobId);
      assert.equal(st?.phase, 'TERMINAL');
      assert.equal(st?.controlState, 'STOP_REQUESTED');
      assert.equal(st?.terminalOutcome, 'CANCELLED');
      assert.equal(st?.lastEvent?.type, 'JobTerminalized');
      assert.equal(await events.countDocuments({
        jobId: r.jobId,
        type: 'JobStopRequested',
      }), 1);
      assert.equal(await outbox.countDocuments({ aggregate: r.jobId, type: 'JobTerminal' }), 1);
      const activation = await db.collection<LaneActivationDoc>(
        COLLECTIONS.activations,
      ).findOne({
        jobId: r.jobId,
        controlSubtype: 'STOP_TERMINAL',
      });
      assert.equal(activation?.lifecycle, 'COMMITTED');
      assert.equal(activation?.activeSlot, false);
      assert.equal(
        activation?.activationActiveAllotmentMs,
        CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
      );
      const reservation = activation?.budgetReservationId
        ? await db.collection<BudgetReservationDoc>(
            COLLECTIONS.budgetReservations,
          ).findOne({ _id: activation.budgetReservationId })
        : null;
      assert.equal(reservation?.state, 'SETTLED');
      assert.equal(reservation?.settlementReason, 'COMMITTED');
      assert.equal(
        (reservation?.chargedActiveMs ?? -1)
          + (reservation?.refundedMs ?? -1),
        reservation?.allotmentMs,
      );
    });

    await check('cancel is idempotent — replay + different commandId are no-op success', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_cx2', payload: { op: 'c2' } });
      const first = await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cancel_2', jobId: r.jobId });
      assert.equal(first.terminalOutcome, 'CANCELLED');
      const firstStateVersion = (await getJobStatus(
        db,
        base.resourceId,
        r.jobId,
      ))?.stateVersion;
      const replay = await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cancel_2', jobId: r.jobId });
      assert.equal(replay.deduped, true);
      const otherCmd = await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cancel_2b', jobId: r.jobId });
      assert.equal(otherCmd.terminalOutcome, 'CANCELLED');
      assert.equal(otherCmd.alreadyTerminal, true);
      const st = await getJobStatus(db, base.resourceId, r.jobId);
      assert.equal(
        st?.stateVersion,
        firstStateVersion,
        'replays do not repeat either stop or terminal CAS',
      );
      assert.equal(await events.countDocuments({
        jobId: r.jobId,
        type: 'JobStopRequested',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: r.jobId,
        type: 'JobTerminalized',
      }), 1);
    });

    await check('cancel is owner-scoped and rejects unknown job', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_cx3', payload: { op: 'c3' } });
      await assert.rejects(
        () => cancelJob(client, db, { resourceId: 'res_OTHER', commandId: 'cancel_x', jobId: r.jobId }),
        (e: unknown) => e instanceof JobNotFoundError,
      );
      await assert.rejects(
        () => cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cancel_y', jobId: 'job_does_not_exist' }),
        (e: unknown) => e instanceof JobNotFoundError,
      );
    });

    await check('wake after cancel does not resurrect a terminal job', async () => {
      const r = await acceptStartCommand(client, db, { ...base, commandId: 'cmd_cx4', payload: { op: 'c4' } });
      await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cancel_4', jobId: r.jobId });
      const terminalVersion = (await getJobStatus(
        db,
        base.resourceId,
        r.jobId,
      ))?.stateVersion;
      await outbox.insertOne({ _id: 'wake-after-cancel', aggregate: r.jobId, type: 'LaneWakeRequested', state: 'PENDING', payload: {}, createdAt: new Date() });
      const out = await claimAndReduceNextWake(client, db);
      // whichever wake it claims, the cancelled job must stay TERMINAL/CANCELLED
      assert.ok(out.claimed === true || out.claimed === false);
      const st = await getJobStatus(db, base.resourceId, r.jobId);
      assert.equal(st?.phase, 'TERMINAL');
      assert.equal(st?.terminalOutcome, 'CANCELLED');
      assert.equal(st?.stateVersion, terminalVersion);
    });

    await check('aborted boundary txn persists nothing (all-or-nothing)', async () => {
      const before = await jobs.countDocuments();
      await assert.rejects(() => runTxn(client, async (session) => {
        await jobs.insertOne({ _id: 'job_should_not_exist', resourceId: 'x', conversationId: 'x', phase: 'ACCEPTED', controlState: 'NONE', terminalOutcome: null, stateVersion: 0, planVersion: 1, pauseGeneration: 0, activationDispatchGeneration: 0, jobStopGeneration: 0, activationFence: 0, activeActivationId: null, controlBudgetPolicyVersion: CONTROL_BUDGET_POLICY_V1.version, jobControlRecoveryReserveMs: CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs, jobControlRecoveryReservedMs: 0, jobControlRecoveryConsumedMs: 0, stopControlRecoveryAttempt: 0, stopControlRecoveryState: 'IDLE', inboxHighWatermark: 0, appliedInboxWatermark: 0, resolvedInboxWatermark: 0, inboxSchemaVersion: 3, instructions: [], parentJobId: null, jobRelationMode: null, goal: 'x', createdAt: new Date(), updatedAt: new Date() }, { session });
        throw new Error('simulated crash before outbox');
      }));
      assert.equal(await jobs.countDocuments({ _id: 'job_should_not_exist' }), 0);
      assert.equal(await jobs.countDocuments(), before);
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-command-boundary — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-command-boundary — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
