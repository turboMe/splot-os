#!/usr/bin/env tsx
/**
 * e2e:orchestration-activation — partial flat BUSINESS planning activation.
 *
 * Proves the first consumer of ORC-AUTH-ACTIVATION-01 and the activation half
 * of ORC-RESULT-READY-01: wake/slot materialization, typed lifecycle/fence,
 * immutable pre-cutoff proposal marker, exact-hash reducer commit, control races
 * and crash recovery. Full activation kinds, budgets, inbox/watermarks and
 * general planning remain deferred.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  cancelJob,
  claimNextWake,
  claimPlanningActivation,
  COLLECTIONS,
  commitPlanningActivation,
  drainLane,
  ensureOrchestrationIndexes,
  markPlanningActivationPayloadReady,
  materializePlanningActivation,
  pauseJob,
  planJob,
  reapExpiredActivations,
  reconcile,
  reWakeStuckJobs,
  resumeJob,
  runLaneForJob,
  startPlanningActivation,
  steerJob,
  type JobDoc,
  type JobEventDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type PlanningActivationOptions,
  type PlanningProposalV1,
  type TaskDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_activation';
const CONVERSATION_ID = 'conv_activation';

interface MalformedOutboxFixture {
  _id: string;
  aggregate: string;
  type: string;
  state: string;
  payload: unknown;
  createdAt: Date;
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}: ${(err as Error).stack ?? (err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-activation');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_activation_e2e_${Date.now()}`,
    section: 'e2e:orchestration-activation',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);

  async function newJob(name: string): Promise<string> {
    return (await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      commandId: name,
      goal: `activation:${name}`,
      payload: { op: name },
    })).jobId;
  }

  async function pendingActivation(
    name: string,
    opts?: PlanningActivationOptions,
  ): Promise<{ jobId: string; activation: LaneActivationDoc }> {
    const jobId = await newJob(name);
    // Direct primitive tests own their job's wake explicitly so they remain
    // isolated from successor wakes intentionally left by earlier cases.
    await outbox.updateMany(
      { aggregate: jobId, type: 'LaneWakeRequested', state: 'PENDING' },
      { $set: { state: 'PUBLISHED' } },
    );
    const activation = await materializePlanningActivation(client, db, jobId, opts);
    assert.ok(activation);
    return { jobId, activation };
  }

  async function runningActivation(
    name: string,
    opts?: PlanningActivationOptions,
  ): Promise<{
    jobId: string;
    activation: LaneActivationDoc;
    owner: string;
    fence: number;
    proposal: PlanningProposalV1;
  }> {
    const pending = await pendingActivation(name, opts);
    const owner = `lane:${name}`;
    const lease = await claimPlanningActivation(client, db, {
      activationId: pending.activation._id,
      leaseOwner: owner,
      leaseTtlMs: 30_000,
    });
    assert.ok(lease);
    assert.equal(await startPlanningActivation(client, db, {
      activationId: pending.activation._id,
      leaseOwner: owner,
      activationFence: lease.activationFence,
    }), true);
    const proposal: PlanningProposalV1 = {
      kind: 'PLAN_SINGLE_SERIAL_TASK_V1',
      jobId: pending.jobId,
      taskId: `task_activation_${globalThis.crypto.randomUUID()}`,
      planVersion: pending.activation.planVersionAtClaim,
      attemptMode: 'SERIAL',
    };
    return {
      ...pending,
      owner,
      fence: lease.activationFence,
      proposal,
    };
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('wake claim atomically materializes one PENDING BUSINESS activation + job slot', async () => {
      const jobId = await newJob('act_wake_slot');
      const wake = await outbox.findOne({
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      });
      assert.ok(wake);
      const handle = await claimNextWake(client, db);
      assert.equal(handle?.jobId, jobId);
      assert.equal(handle?.wakeId, wake._id);
      assert.equal(handle?.activationDispatchGeneration, 0);
      const job = await jobs.findOne({ _id: jobId });
      assert.ok(job?.activeActivationId);
      assert.equal(job.activationDispatchGeneration, 0);
      const activation = await activations.findOne({ _id: job.activeActivationId });
      assert.equal(activation?.sourceWakeId, wake._id);
      assert.equal(activation?.kind, 'BUSINESS');
      assert.equal(activation?.lifecycle, 'PENDING');
      assert.equal(activation?.activeSlot, true);
      assert.equal(handle?.planningActivationId, activation?._id);
      assert.equal((await outbox.findOne({ _id: wake._id }))?.state, 'PUBLISHED');
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_wake_slot_cleanup',
        jobId,
      });
    });

    await check('stale wake generation is settled but cannot materialize current authority', async () => {
      const jobId = await newJob('act_stale_wake_generation');
      const staleWake = await outbox.findOne({
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'accepted',
      });
      assert.ok(staleWake);
      const poisonWakeId = `obx_poison_${globalThis.crypto.randomUUID()}`;
      await db.collection<MalformedOutboxFixture>(COLLECTIONS.outbox).insertOne({
        _id: poisonWakeId,
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: null,
        createdAt: new Date(Date.now() - 10_000),
      });
      await outbox.updateOne(
        { _id: staleWake._id },
        { $set: { createdAt: new Date(Date.now() - 5_000) } },
      );

      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_stale_wake_pause',
        jobId,
      });
      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_stale_wake_resume',
        jobId,
      });
      const currentJob = await jobs.findOne({ _id: jobId });
      assert.equal(currentJob?.activationDispatchGeneration, 2);
      const currentWake = await outbox.findOne({
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'resume_job',
        'payload.activationDispatchGeneration': 2,
      });
      assert.ok(currentWake);

      const handle = await claimNextWake(client, db);
      assert.equal(handle?.jobId, jobId);
      assert.equal(handle?.activationDispatchGeneration, 2);
      const activation = await activations.findOne({ jobId, activeSlot: true });
      assert.equal(handle?.planningActivationId, activation?._id);
      assert.equal(activation?.sourceWakeId, currentWake._id);
      assert.notEqual(activation?.sourceWakeId, staleWake._id);
      assert.equal((await outbox.findOne({ _id: poisonWakeId }))?.state, 'PUBLISHED');
      assert.equal((await outbox.findOne({ _id: staleWake._id }))?.state, 'PUBLISHED');
      assert.equal((await outbox.findOne({ _id: currentWake._id }))?.state, 'PUBLISHED');
      const wakes = await outbox.find({
        aggregate: jobId,
        type: 'LaneWakeRequested',
      }).toArray();
      assert.ok(wakes
        .filter((wake) => wake._id !== poisonWakeId)
        .every((wake) =>
          Number.isInteger(wake.payload.activationDispatchGeneration)));

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_stale_wake_cleanup',
        jobId,
      });
    });

    await check('claimed wake handle cannot launder authority across pause/resume', async () => {
      const jobId = await newJob('act_post_claim_generation_race');
      const oldHandle = await claimNextWake(client, db);
      assert.equal(oldHandle?.jobId, jobId);
      assert.equal(oldHandle?.activationDispatchGeneration, 0);
      assert.ok(oldHandle?.planningActivationId);

      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_post_claim_pause',
        jobId,
      });
      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_post_claim_resume',
        jobId,
      });
      assert.equal((await jobs.findOne({ _id: jobId }))?.activationDispatchGeneration, 2);

      const staleRun = await runLaneForJob(client, db, jobId, 50, {
        activationDispatchGeneration: oldHandle!.activationDispatchGeneration,
        planningActivationId: oldHandle!.planningActivationId,
      });
      assert.equal(staleRun.action, 'none');
      assert.equal(await tasks.countDocuments({ jobId }), 0);
      assert.equal(
        (await activations.findOne({ _id: oldHandle!.planningActivationId! }))?.lifecycle,
        'ABANDONED',
      );
      assert.equal(await outbox.countDocuments({
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.activationDispatchGeneration': 2,
      }), 1);

      const currentHandle = await claimNextWake(client, db);
      assert.equal(currentHandle?.jobId, jobId);
      assert.equal(currentHandle?.activationDispatchGeneration, 2);
      assert.notEqual(currentHandle?.planningActivationId, oldHandle?.planningActivationId);
      const currentRun = await runLaneForJob(client, db, jobId, 50, {
        activationDispatchGeneration: currentHandle!.activationDispatchGeneration,
        planningActivationId: currentHandle!.planningActivationId,
      });
      assert.equal(currentRun.action, 'planned');
      assert.equal(await tasks.countDocuments({ jobId }), 1);

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_post_claim_cleanup',
        jobId,
      });
    });

    await check('bootstrap backfills durable pre-activation jobs and pending wakes', async () => {
      const jobId = await newJob('act_legacy_backfill');
      const wake = await outbox.findOne({
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      });
      assert.ok(wake);
      await jobs.updateOne(
        { _id: jobId },
        {
          $unset: {
            activationDispatchGeneration: '',
            jobStopGeneration: '',
            activationFence: '',
            activeActivationId: '',
          },
        },
      );
      await outbox.updateOne(
        { _id: wake._id },
        { $unset: { 'payload.activationDispatchGeneration': '' } },
      );

      await ensureOrchestrationIndexes(db);
      const repairedJob = await jobs.findOne({ _id: jobId });
      assert.equal(repairedJob?.activationDispatchGeneration, 0);
      assert.equal(repairedJob?.jobStopGeneration, 0);
      assert.equal(repairedJob?.activationFence, 0);
      assert.equal(repairedJob?.activeActivationId, null);
      assert.equal(
        (await outbox.findOne({ _id: wake._id }))?.payload.activationDispatchGeneration,
        0,
      );

      const handle = await claimNextWake(client, db);
      assert.equal(handle?.jobId, jobId);
      assert.equal(handle?.activationDispatchGeneration, 0);
      assert.ok(handle?.planningActivationId);
      await db.collection<{ _id: string; batchInboxItemIds?: string[] }>(
        COLLECTIONS.activations,
      ).updateOne(
        { _id: handle!.planningActivationId! },
        {
          $unset: {
            batchInboxItemIds: '',
            controlSubtype: '',
            reducerPayloadHash: '',
            budgetReservationId: '',
            budgetPool: '',
            activationActiveAllotmentMs: '',
          },
        },
      );
      await ensureOrchestrationIndexes(db);
      const backfilledActivation = await activations.findOne({
        _id: handle!.planningActivationId!,
      });
      assert.deepEqual(
        backfilledActivation?.batchInboxItemIds,
        [],
        'PR-31 activation records receive the additive empty inbox batch',
      );
      assert.equal(backfilledActivation?.controlSubtype, null);
      assert.equal(backfilledActivation?.reducerPayloadHash, null);
      assert.equal(backfilledActivation?.budgetReservationId, null);
      assert.equal(backfilledActivation?.budgetPool, null);
      assert.equal(backfilledActivation?.activationActiveAllotmentMs, null);
      const planned = await runLaneForJob(client, db, jobId, 50, {
        activationDispatchGeneration: handle!.activationDispatchGeneration,
        planningActivationId: handle!.planningActivationId,
      });
      assert.equal(planned.action, 'planned');
      assert.equal(await tasks.countDocuments({ jobId }), 1);

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_legacy_backfill_cleanup',
        jobId,
      });
    });

    await check('bootstrap stamps unknown legacy wake as zero, never as current authority', async () => {
      const jobId = await newJob('act_legacy_stale_backfill');
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_legacy_stale_pause',
        jobId,
      });
      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_legacy_stale_resume',
        jobId,
      });
      assert.equal((await jobs.findOne({ _id: jobId }))?.activationDispatchGeneration, 2);

      const legacyWakeId = `obx_legacy_${globalThis.crypto.randomUUID()}`;
      await outbox.insertOne({
        _id: legacyWakeId,
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: { jobId, reason: 'legacy_unknown_generation' },
        createdAt: new Date(Date.now() - 10_000),
      });
      await ensureOrchestrationIndexes(db);
      assert.equal(
        (await outbox.findOne({ _id: legacyWakeId }))?.payload.activationDispatchGeneration,
        0,
      );

      const handle = await claimNextWake(client, db);
      assert.equal(handle?.jobId, jobId);
      assert.equal(handle?.activationDispatchGeneration, 2);
      assert.equal((await outbox.findOne({ _id: legacyWakeId }))?.state, 'PUBLISHED');
      assert.ok(handle?.planningActivationId);

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_legacy_stale_cleanup',
        jobId,
      });
    });

    await check('PENDING→LEASED→RUNNING→marker→COMMITTED is exact-hash and replay-safe', async () => {
      const p = await pendingActivation('act_lifecycle');
      const owner = 'lane:lifecycle';
      const lease = await claimPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
      });
      assert.ok(lease);
      assert.equal((await activations.findOne({ _id: p.activation._id }))?.lifecycle, 'LEASED');
      assert.equal((await jobs.findOne({ _id: p.jobId }))?.activationFence, lease.activationFence);
      assert.equal(await startPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
      }), true);
      const started = await activations.findOne({ _id: p.activation._id });
      assert.equal(started?.lifecycle, 'RUNNING');
      assert.ok(started?.operationStartedAt);
      assert.ok(started!.businessOperationCutoffAt < started!.workDeadlineAt);
      assert.ok(started!.workDeadlineAt < started!.hardDeadlineAt);

      const proposal: PlanningProposalV1 = {
        kind: 'PLAN_SINGLE_SERIAL_TASK_V1',
        jobId: p.jobId,
        taskId: `task_activation_${globalThis.crypto.randomUUID()}`,
        planVersion: 1,
        attemptMode: 'SERIAL',
      };
      const marked = await markPlanningActivationPayloadReady(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        proposal,
      });
      assert.equal(marked.ready, true);
      assert.equal(marked.marked, true);
      assert.equal(marked.generation, 1);
      const replayMarker = await markPlanningActivationPayloadReady(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        proposal,
      });
      assert.equal(replayMarker.deduped, true);
      const conflictingProposal = {
        ...proposal,
        taskId: `task_conflict_${globalThis.crypto.randomUUID()}`,
      };
      const conflict = await markPlanningActivationPayloadReady(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        proposal: conflictingProposal,
      });
      assert.equal(conflict.ready, false);
      assert.equal(conflict.reason, 'payload_hash_conflict');
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        businessPayloadReadyGeneration: 1,
        proposal: conflictingProposal,
      }), null);

      const committed = await commitPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        businessPayloadReadyGeneration: 1,
        proposal,
      });
      assert.equal(committed?.taskId, proposal.taskId);
      assert.equal(committed?.deduped, false);
      const settled = await activations.findOne({ _id: p.activation._id });
      assert.equal(settled?.lifecycle, 'COMMITTED');
      assert.equal(settled?.activeSlot, false);
      assert.equal(settled?.leaseOwner, null);
      assert.equal(settled?.businessPayloadReadyHash, settled?.committedPayloadHash);
      assert.ok(settled?.businessPayloadReadyAt);
      assert.ok(settled?.committedAt);
      assert.ok(settled!.businessPayloadReadyAt! < settled!.businessOperationCutoffAt);
      assert.ok(settled!.committedAt! < settled!.workDeadlineAt);
      assert.equal((await jobs.findOne({ _id: p.jobId }))?.activeActivationId, null);

      const replayCommit = await commitPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        businessPayloadReadyGeneration: 1,
        proposal,
      });
      assert.equal(replayCommit?.deduped, true);
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        businessPayloadReadyGeneration: 999,
        proposal,
      }), null);
      assert.equal(await tasks.countDocuments({ jobId: p.jobId }), 1);
      assert.equal(await events.countDocuments({ jobId: p.jobId, type: 'JobPlanned' }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: p.jobId,
        type: 'LaneWakeRequested',
        'payload.reason': 'planning_committed',
      }), 1);
    });

    await check('stale owner/fence cannot start or mark an activation', async () => {
      const p = await pendingActivation('act_stale_fence');
      const lease = await claimPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: 'lane:owner',
      });
      assert.ok(lease);
      assert.equal(await startPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: 'lane:other',
        activationFence: lease.activationFence,
      }), false);
      assert.equal(await startPlanningActivation(client, db, {
        activationId: p.activation._id,
        leaseOwner: 'lane:owner',
        activationFence: lease.activationFence,
      }), true);
      const proposal: PlanningProposalV1 = {
        kind: 'PLAN_SINGLE_SERIAL_TASK_V1',
        jobId: p.jobId,
        taskId: `task_activation_${globalThis.crypto.randomUUID()}`,
        planVersion: 1,
        attemptMode: 'SERIAL',
      };
      const stale = await markPlanningActivationPayloadReady(client, db, {
        activationId: p.activation._id,
        leaseOwner: 'lane:owner',
        activationFence: lease.activationFence + 1,
        proposal,
      });
      assert.equal(stale.ready, false);
      assert.equal(stale.reason, 'stale_fence_or_lease_or_cutoff');
      assert.equal(await tasks.countDocuments({ jobId: p.jobId }), 0);
    });

    await check('started BUSINESS past cutoff fails closed to operator reconciliation', async () => {
      const r = await runningActivation('act_late_marker');
      await activations.updateOne(
        { _id: r.activation._id },
        { $set: { businessOperationCutoffAt: new Date(Date.now() - 25) } },
      );
      const marked = await markPlanningActivationPayloadReady(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        proposal: r.proposal,
      });
      assert.equal(marked.ready, false);
      assert.equal(marked.reason, 'stale_fence_or_lease_or_cutoff');
      assert.equal(await tasks.countDocuments({ jobId: r.jobId }), 0);
      assert.equal(await reapExpiredActivations(client, db), 1);
      const failed = await activations.findOne({ _id: r.activation._id });
      assert.equal(failed?.lifecycle, 'FAILED');
      assert.equal(
        failed?.reasonCode,
        'activation_recovery_ambiguous_business_effect',
      );
      assert.equal((await jobs.findOne({ _id: r.jobId }))?.activeActivationId, r.activation._id);
      assert.equal(await outbox.countDocuments({
        aggregate: r.jobId,
        type: 'OperatorAlertRequested',
        'payload.alertType': 'activation_recovery_ambiguous_business_effect',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: r.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
    });

    await check('reducer at/after work deadline commits no task and is recoverable', async () => {
      const r = await runningActivation('act_late_commit');
      const marker = await markPlanningActivationPayloadReady(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        proposal: r.proposal,
      });
      assert.equal(marker.ready, true);
      await activations.updateOne(
        { _id: r.activation._id },
        {
          $set: {
            workDeadlineAt: new Date(Date.now() - 25),
            hardDeadlineAt: new Date(Date.now() + 5_000),
            leaseExpiresAt: new Date(Date.now() + 4_000),
          },
        },
      );
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        businessPayloadReadyGeneration: marker.generation,
        proposal: r.proposal,
      }), null);
      assert.equal(await tasks.countDocuments({ jobId: r.jobId }), 0);
      assert.equal(await reapExpiredActivations(client, db), 1);
    });

    await check('concurrent planners create exactly one task and one COMMITTED activation', async () => {
      const jobId = await newJob('act_concurrent_planners');
      const results = await Promise.all(
        Array.from({ length: 12 }, () => planJob(client, db, jobId)),
      );
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await tasks.countDocuments({ jobId }), 1);
      assert.equal(await activations.countDocuments({ jobId, lifecycle: 'COMMITTED' }), 1);
      assert.equal(await activations.countDocuments({ jobId, activeSlot: true }), 0);
      assert.equal(await events.countDocuments({ jobId, type: 'JobPlanned' }), 1);
    });

    await check('pause after marker abandons old generation; resume plans fresh exactly once', async () => {
      const r = await runningActivation('act_pause_after_marker');
      const marker = await markPlanningActivationPayloadReady(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        proposal: r.proposal,
      });
      assert.equal(marker.ready, true);
      const beforeGeneration = (await jobs.findOne({ _id: r.jobId }))!.activationDispatchGeneration;
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_pause_after_marker_cmd',
        jobId: r.jobId,
      });
      const abandoned = await activations.findOne({ _id: r.activation._id });
      assert.equal(abandoned?.lifecycle, 'ABANDONED');
      assert.equal(abandoned?.reasonCode, 'pause_job');
      assert.equal((await jobs.findOne({ _id: r.jobId }))?.activationDispatchGeneration, beforeGeneration + 1);
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        businessPayloadReadyGeneration: marker.generation,
        proposal: r.proposal,
      }), null);
      assert.equal(await tasks.countDocuments({ jobId: r.jobId }), 0);

      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_resume_after_marker_cmd',
        jobId: r.jobId,
      });
      const fresh = await planJob(client, db, r.jobId);
      assert.ok(fresh);
      assert.equal(await tasks.countDocuments({ jobId: r.jobId }), 1);
      assert.equal((await tasks.findOne({ jobId: r.jobId }))?.planVersion, 1);
    });

    await check('cancel after marker wins terminal CAS and late activation cannot create a task', async () => {
      const r = await runningActivation('act_cancel_after_marker');
      const marker = await markPlanningActivationPayloadReady(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        proposal: r.proposal,
      });
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_cancel_after_marker_cmd',
        jobId: r.jobId,
      });
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        businessPayloadReadyGeneration: marker.generation,
        proposal: r.proposal,
      }), null);
      const job = await jobs.findOne({ _id: r.jobId });
      assert.equal(job?.terminalOutcome, 'CANCELLED');
      assert.equal(job?.activeActivationId, null);
      assert.equal((await activations.findOne({ _id: r.activation._id }))?.lifecycle, 'ABANDONED');
      assert.equal(await tasks.countDocuments({ jobId: r.jobId }), 0);
      assert.equal(await outbox.countDocuments({ aggregate: r.jobId, type: 'JobTerminal' }), 1);
    });

    await check('pre-plan steer invalidates marked activation; fresh planner uses planVersion N+1', async () => {
      const r = await runningActivation('act_steer_after_marker');
      const marker = await markPlanningActivationPayloadReady(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        proposal: r.proposal,
      });
      await steerJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'act_steer_after_marker_cmd',
        jobId: r.jobId,
        instruction: 'change the goal before planning',
        activeAttemptPolicy: 'interrupt',
      });
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        businessPayloadReadyGeneration: marker.generation,
        proposal: r.proposal,
      }), null);
      assert.equal((await activations.findOne({ _id: r.activation._id }))?.reasonCode, 'plan_superseded');
      assert.equal((await jobs.findOne({ _id: r.jobId }))?.planVersion, 2);
      assert.equal(await tasks.countDocuments({ jobId: r.jobId }), 0);
      assert.ok(await planJob(client, db, r.jobId));
      assert.equal((await tasks.findOne({ jobId: r.jobId }))?.planVersion, 2);
    });

    await check('planning vs pause has one linearization order and never a post-pause task', async () => {
      for (let index = 0; index < 8; index++) {
        const jobId = await newJob(`act_plan_pause_race_${index}`);
        const [planned, paused] = await Promise.allSettled([
          planJob(client, db, jobId),
          pauseJob(client, db, {
            resourceId: RESOURCE_ID,
            commandId: `act_plan_pause_race_cmd_${index}`,
            jobId,
          }),
        ]);
        assert.equal(paused.status, 'fulfilled');
        const taskCount = await tasks.countDocuments({ jobId });
        assert.ok(taskCount === 0 || taskCount === 1);
        const ordered = await events.find({
          jobId,
          type: { $in: ['JobPlanned', 'JobPaused'] },
        }).sort({ sequence: 1 }).toArray();
        if (taskCount === 1) {
          assert.equal(planned.status, 'fulfilled');
          assert.ok(planned.value);
          assert.deepEqual(ordered.map((event) => event.type), ['JobPlanned', 'JobPaused']);
        } else {
          assert.deepEqual(ordered.map((event) => event.type), ['JobPaused']);
        }
        assert.equal((await jobs.findOne({ _id: jobId }))?.controlState, 'PAUSE_REQUESTED');
        assert.equal(await activations.countDocuments({ jobId, activeSlot: true }), 0);
      }
    });

    await check('live PENDING activation suppresses heuristic re-wake; reaper restores exactly one owner', async () => {
      const p = await pendingActivation('act_pending_crash');
      assert.equal(await outbox.countDocuments({
        aggregate: p.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      await activations.updateOne(
        { _id: p.activation._id },
        { $set: { businessOperationCutoffAt: new Date(Date.now() - 25) } },
      );
      const tick = await reconcile(client, db);
      assert.equal(tick.reapedActivations, 1);
      assert.equal((await activations.findOne({ _id: p.activation._id }))?.lifecycle, 'ABANDONED');
      assert.equal(await outbox.countDocuments({
        aggregate: p.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 1);
      await drainLane(client, db);
      assert.equal(await tasks.countDocuments({ jobId: p.jobId }), 1);
      assert.equal(await activations.countDocuments({
        jobId: p.jobId, kind: 'BUSINESS', lifecycle: 'COMMITTED',
      }), 1);
      assert.equal(await activations.countDocuments({
        jobId: p.jobId, kind: 'CONTROL_RECOVERY', lifecycle: 'COMMITTED',
      }), 1);
      assert.equal(await activations.countDocuments({ jobId: p.jobId, lifecycle: 'ABANDONED' }), 1);
    });

    await check('RUNNING crash after marker is fenced without repeating BUSINESS', async () => {
      const r = await runningActivation('act_running_crash');
      const marker = await markPlanningActivationPayloadReady(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        proposal: r.proposal,
      });
      await activations.updateOne(
        { _id: r.activation._id },
        {
          $set: {
            workDeadlineAt: new Date(Date.now() - 25),
            leaseExpiresAt: new Date(Date.now() + 4_000),
            hardDeadlineAt: new Date(Date.now() + 5_000),
          },
        },
      );
      const tick = await reconcile(client, db);
      assert.equal(tick.reapedActivations, 1);
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: r.activation._id,
        leaseOwner: r.owner,
        activationFence: r.fence,
        businessPayloadReadyGeneration: marker.generation,
        proposal: r.proposal,
      }), null);
      await drainLane(client, db);
      assert.equal(await tasks.countDocuments({ jobId: r.jobId }), 0);
      assert.equal(await events.countDocuments({ jobId: r.jobId, type: 'JobPlanned' }), 0);
      assert.equal(await activations.countDocuments({
        jobId: r.jobId, kind: 'BUSINESS', lifecycle: 'COMMITTED',
      }), 0);
      assert.equal(await activations.countDocuments({
        jobId: r.jobId, kind: 'CONTROL_RECOVERY', lifecycle: 'COMMITTED',
      }), 0);
      assert.equal(await activations.countDocuments({
        jobId: r.jobId,
        lifecycle: 'FAILED',
        reasonCode: 'activation_recovery_ambiguous_business_effect',
        activeSlot: true,
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: r.jobId,
        type: 'OperatorAlertRequested',
        'payload.alertType': 'activation_recovery_ambiguous_business_effect',
      }), 1);
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-activation — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-activation — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
