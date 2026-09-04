#!/usr/bin/env tsx
/**
 * e2e:orchestration-control-recovery — lost activation control plane.
 *
 * Proves that expiry never recreates ordinary business authority directly.
 * The reaper atomically fences the lost activation and hands ownership to one
 * CONTROL_RECOVERY activation; only its fenced commit may emit a typed
 * successor. The control reducer itself never applies a result or mutates
 * tasks, inbox rows, results, or terminal outcome.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  cancelJob,
  claimAttempt,
  claimControlRecoveryActivation,
  claimNextControlRecoveryWake,
  claimPlanningActivation,
  claimResultDrainActivation,
  COLLECTIONS,
  commitControlRecoveryActivation,
  commitPlanningActivation,
  dispatchAttempt,
  drainControlRecovery,
  drainLane,
  ensureOrchestrationIndexes,
  markAttemptPayloadReady,
  markPlanningActivationPayloadReady,
  materializePlanningActivation,
  materializeResultDrainActivation,
  pauseJob,
  planJob,
  reapExpiredActivationsToControlRecovery,
  reWakeStuckJobs,
  resumeJob,
  runControlRecoveryActivation,
  startAttemptOperation,
  startControlRecoveryActivation,
  startPlanningActivation,
  startResultDrainActivation,
  submitAttemptResult,
  type AttemptDoc,
  type JobDoc,
  type JobEventDoc,
  type JobInboxDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type PlanningProposalV1,
  type ResultDoc,
  type TaskDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_control_recovery';
const CONVERSATION_ID = 'conv_control_recovery';

type Producer =
  | { status: 'ok'; data: Record<string, unknown> }
  | { status: 'partial'; data: Record<string, unknown> }
  | { status: 'failed'; error: { code: string; message: string } };

interface PlanningFixture {
  jobId: string;
  activation: LaneActivationDoc;
  owner: string;
  fence: number;
  proposal: PlanningProposalV1;
  markerGeneration: number;
}

interface ResultFixture {
  jobId: string;
  taskId: string;
  attemptId: string;
  result: ResultDoc;
  inbox: JobInboxDoc;
  activation: LaneActivationDoc;
  owner: string;
  fence: number;
}

interface RecoveryWakeHandle {
  jobId: string;
  activationId: string;
  leaseOwner: string;
  activationFence: number;
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
  console.log('e2e:orchestration-control-recovery');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_control_recovery_e2e_${Date.now()}`,
    section: 'e2e:orchestration-control-recovery',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  const inbox = db.collection<JobInboxDoc>(COLLECTIONS.inbox);
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);

  async function newJob(name: string): Promise<string> {
    return (await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      commandId: name,
      goal: `control-recovery:${name}`,
      payload: { op: name },
    })).jobId;
  }

  async function settleOrdinaryWakes(jobId: string): Promise<void> {
    await outbox.updateMany(
      {
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      },
      { $set: { state: 'PUBLISHED' } },
    );
  }

  async function leasedPlanning(name: string): Promise<PlanningFixture> {
    const jobId = await newJob(name);
    await settleOrdinaryWakes(jobId);
    const activation = await materializePlanningActivation(client, db, jobId);
    assert.ok(activation);
    const owner = `lane-control-test:${name}`;
    const lease = await claimPlanningActivation(client, db, {
      activationId: activation._id,
      leaseOwner: owner,
      leaseTtlMs: 30_000,
    });
    assert.ok(lease);
    const proposal: PlanningProposalV1 = {
      kind: 'PLAN_SINGLE_SERIAL_TASK_V1',
      jobId,
      taskId: `task_control_${globalThis.crypto.randomUUID()}`,
      planVersion: activation.planVersionAtClaim,
      attemptMode: 'SERIAL',
    };
    return {
      jobId,
      activation,
      owner,
      fence: lease.activationFence,
      proposal,
      markerGeneration: 0,
    };
  }

  async function runningPlanningWithPayload(
    name: string,
  ): Promise<PlanningFixture> {
    const fixture = await leasedPlanning(name);
    assert.equal(await startPlanningActivation(client, db, {
      activationId: fixture.activation._id,
      leaseOwner: fixture.owner,
      activationFence: fixture.fence,
    }), true);
    const marker = await markPlanningActivationPayloadReady(client, db, {
      activationId: fixture.activation._id,
      leaseOwner: fixture.owner,
      activationFence: fixture.fence,
      proposal: fixture.proposal,
    });
    assert.equal(marker.ready, true);
    return { ...fixture, markerGeneration: marker.generation };
  }

  async function runningResultDrain(
    name: string,
    producer: Producer = { status: 'ok', data: { recovered: true } },
  ): Promise<ResultFixture> {
    const jobId = await newJob(name);
    const planned = await planJob(client, db, jobId);
    assert.ok(planned);
    await settleOrdinaryWakes(jobId);
    const taskId = planned.taskId;
    const task = await tasks.findOne({ _id: taskId });
    assert.equal(task?.resultApplyMode, 'RESULT_DRAIN_V1');

    const dispatched = await dispatchAttempt(client, db, { jobId, taskId });
    const worker = `worker-control-test:${name}`;
    const attemptLease = await claimAttempt(client, db, {
      attemptId: dispatched.attemptId,
      workerInstanceId: worker,
      leaseTtlMs: 30_000,
    });
    assert.ok(attemptLease);
    assert.equal(await startAttemptOperation(client, db, {
      attemptId: dispatched.attemptId,
      leaseOwner: worker,
      attemptFence: attemptLease.attemptFence,
    }), true);
    const marker = await markAttemptPayloadReady(client, db, {
      attemptId: dispatched.attemptId,
      leaseOwner: worker,
      attemptFence: attemptLease.attemptFence,
      producer,
    });
    assert.equal(marker.ready, true);
    const submitted = await submitAttemptResult(client, db, {
      attemptId: dispatched.attemptId,
      leaseOwner: worker,
      attemptFence: attemptLease.attemptFence,
      producer,
      businessPayloadReadyGeneration: marker.generation,
    });
    assert.equal(submitted.committed, true);

    const result = await results.findOne({ attemptId: dispatched.attemptId });
    assert.ok(result);
    const item = await inbox.findOne({
      jobId,
      attemptId: dispatched.attemptId,
      resultId: result._id,
    });
    assert.ok(item);
    const resultWake = await outbox.findOne({
      aggregate: jobId,
      type: 'LaneWakeRequested',
      state: 'PENDING',
      'payload.inboxItemId': item._id,
    });
    assert.ok(resultWake);

    // Primitive tests materialize the exact job directly, so a deliberately
    // stranded wake from another case cannot steal this fixture's claim.
    const activation = await materializeResultDrainActivation(client, db, jobId, {
      sourceWakeId: resultWake._id,
    });
    assert.ok(activation);
    await outbox.updateOne(
      { _id: resultWake._id },
      { $set: { state: 'PUBLISHED' } },
    );
    const owner = `lane-result-control-test:${name}`;
    const lease = await claimResultDrainActivation(client, db, {
      activationId: activation._id,
      leaseOwner: owner,
      leaseTtlMs: 30_000,
    });
    assert.ok(lease);
    assert.equal(await startResultDrainActivation(client, db, {
      activationId: activation._id,
      leaseOwner: owner,
      activationFence: lease.activationFence,
    }), true);
    return {
      jobId,
      taskId,
      attemptId: dispatched.attemptId,
      result,
      inbox: item,
      activation,
      owner,
      fence: lease.activationFence,
    };
  }

  async function forceExpired(activationId: string): Promise<void> {
    const before = new Date(Date.now() - 100);
    await activations.updateOne(
      { _id: activationId },
      {
        $set: {
          leaseExpiresAt: before,
          businessOperationCutoffAt: before,
          workDeadlineAt: before,
          hardDeadlineAt: before,
        },
      },
    );
  }

  async function recoveryHandle(jobId: string): Promise<RecoveryWakeHandle> {
    const wake = await claimNextControlRecoveryWake(client, db);
    assert.ok(wake);
    assert.equal(wake.jobId, jobId);
    const leaseOwner = `lane-control-recovery:${jobId}`;
    const raw = await claimControlRecoveryActivation(client, db, {
      activationId: wake.activationId,
      leaseOwner,
      leaseTtlMs: 30_000,
    });
    if (!raw) {
      const [job, activation] = await Promise.all([
        jobs.findOne({ _id: jobId }),
        activations.findOne({ _id: wake.activationId }),
      ]);
      assert.fail(
        `control claim failed: ${JSON.stringify({
          job: job && {
            activeActivationId: job.activeActivationId,
            activationDispatchGeneration: job.activationDispatchGeneration,
            activationFence: job.activationFence,
            planVersion: job.planVersion,
            jobStopGeneration: job.jobStopGeneration,
          },
          activation,
        })}`,
      );
    }
    const handle = raw as RecoveryWakeHandle;
    assert.equal(handle.jobId, jobId);
    assert.ok(handle.activationId);
    return handle;
  }

  async function commitRecovery(
    handle: RecoveryWakeHandle,
  ): Promise<Awaited<ReturnType<typeof commitControlRecoveryActivation>>> {
    assert.equal(await startControlRecoveryActivation(client, db, {
      activationId: handle.activationId,
      leaseOwner: handle.leaseOwner,
      activationFence: handle.activationFence,
    }), true);
    return commitControlRecoveryActivation(client, db, {
      activationId: handle.activationId,
      leaseOwner: handle.leaseOwner,
      activationFence: handle.activationFence,
    });
  }

  async function businessSnapshot(jobId: string): Promise<{
    tasks: TaskDoc[];
    inbox: JobInboxDoc[];
    results: ResultDoc[];
    terminalOutcome: JobDoc['terminalOutcome'];
  }> {
    return {
      tasks: await tasks.find({ jobId }).sort({ _id: 1 }).toArray(),
      inbox: await inbox.find({ jobId }).sort({ _id: 1 }).toArray(),
      results: await results.find({ jobId }).sort({ _id: 1 }).toArray(),
      terminalOutcome: (await jobs.findOne({ _id: jobId }))?.terminalOutcome ?? null,
    };
  }

  async function assertSingleControlOwner(jobId: string): Promise<LaneActivationDoc> {
    const active = await activations.find({
      jobId,
      activeSlot: true,
      lifecycle: { $in: ['PENDING', 'LEASED', 'RUNNING', 'FAILED'] },
    }).toArray();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.kind, 'CONTROL_RECOVERY');
    assert.equal((await jobs.findOne({ _id: jobId }))?.activeActivationId, active[0]?._id);
    return active[0]!;
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('expired BUSINESS transfers to one control owner, then one planning successor', async () => {
      const old = await leasedPlanning('control_business');
      const oldJob = await jobs.findOne({ _id: old.jobId });
      assert.ok(oldJob);
      await forceExpired(old.activation._id);

      const concurrentReaps = await Promise.all(
        Array.from(
          { length: 8 },
          () => reapExpiredActivationsToControlRecovery(client, db),
        ),
      );
      assert.deepEqual(
        concurrentReaps.sort((left, right) => left - right),
        [0, 0, 0, 0, 0, 0, 0, 1],
      );
      const abandoned = await activations.findOne({ _id: old.activation._id });
      assert.equal(abandoned?.lifecycle, 'ABANDONED');
      assert.equal(abandoned?.activeSlot, false);
      assert.equal(abandoned?.reasonCode, 'activation_lost');
      assert.ok((abandoned?.activationFence ?? 0) > old.fence);
      const current = await jobs.findOne({ _id: old.jobId });
      assert.equal(
        current?.activationDispatchGeneration,
        oldJob.activationDispatchGeneration + 1,
      );
      assert.equal(current?.activationRecoveryAttempt, 1);
      assert.equal(current?.activationRecoveryRootId, old.activation._id);
      assert.equal(current?.activationRecoveryRootKind, 'BUSINESS');
      const control = await assertSingleControlOwner(old.jobId);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'ControlRecoveryRequested',
        state: 'PENDING',
        'payload.lostActivationId': old.activation._id,
        'payload.rootActivationKind': 'BUSINESS',
      }), 1);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 0);
      assert.equal(await activations.countDocuments({
        jobId: old.jobId,
        kind: 'CONTROL_RECOVERY',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'LaneControlRecoveryStarted',
      }), 1);

      // A fenced old reducer can never regain authority after the handoff.
      assert.equal(await commitPlanningActivation(client, db, {
        activationId: old.activation._id,
        leaseOwner: old.owner,
        activationFence: old.fence,
        businessPayloadReadyGeneration: old.markerGeneration,
        proposal: old.proposal,
      }), null);

      const beforeControl = await businessSnapshot(old.jobId);
      const handle = await recoveryHandle(old.jobId);
      assert.equal(handle.activationId, control._id);
      assert.ok(await commitRecovery(handle));
      assert.deepEqual(await businessSnapshot(old.jobId), beforeControl);
      assert.equal((await activations.findOne({ _id: control._id }))?.lifecycle, 'COMMITTED');
      assert.equal((await jobs.findOne({ _id: old.jobId }))?.activeActivationId, null);
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        1,
      );
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'LaneControlRecoveryCommitted',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.activationDispatchGeneration':
          current?.activationDispatchGeneration,
      }), 1);
      const replay = await commitControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      });
      assert.equal(replay?.deduped, true);

      await drainLane(client, db);
      assert.equal(await tasks.countDocuments({ jobId: old.jobId }), 1);
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'JobPlanned',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        'payload.reason': 'activation_recovery',
      }), 1);
      const completedJob = await jobs.findOne({ _id: old.jobId });
      assert.equal(completedJob?.activationRecoveryAttempt, 0);
      assert.equal(completedJob?.activationRecoveryRootId, null);
      assert.equal(completedJob?.activationRecoveryRootKind, null);
    });

    await check('parallel control runners admit one random lease owner', async () => {
      const old = await leasedPlanning('control_parallel_runners');
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const control = await assertSingleControlOwner(old.jobId);
      assert.equal((await outbox.updateOne(
        { _id: control.sourceWakeId! },
        { $set: { state: 'PUBLISHED' } },
      )).modifiedCount, 1);
      const contenders = await Promise.all(
        Array.from(
          { length: 8 },
          () => runControlRecoveryActivation(client, db, control._id),
        ),
      );
      assert.equal(contenders.filter((value) => value !== null).length, 1);
      assert.equal((await activations.findOne({
        _id: control._id,
      }))?.lifecycle, 'COMMITTED');
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'LaneControlRecoveryCommitted',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'activation_recovery',
      }), 1);
      await settleOrdinaryWakes(old.jobId);
    });

    await check('lease renewal and R0 expiry CAS have one coherent winner', async () => {
      const old = await leasedPlanning('control_reaper_renewal_race');
      await forceExpired(old.activation._id);
      const future = new Date(Date.now() + 30_000);
      const [reaped, renewed] = await Promise.all([
        reapExpiredActivationsToControlRecovery(client, db),
        activations.updateOne(
          {
            _id: old.activation._id,
            lifecycle: 'LEASED',
            activeSlot: true,
            leaseOwner: old.owner,
            activationFence: old.fence,
          },
          {
            $set: {
              leaseExpiresAt: future,
              businessOperationCutoffAt: future,
              workDeadlineAt: new Date(future.getTime() + 1_000),
              hardDeadlineAt: new Date(future.getTime() + 2_000),
            },
          },
        ),
      ]);
      assert.equal(reaped + renewed.modifiedCount, 1);
      if (renewed.modifiedCount === 1) {
        assert.equal((await activations.findOne({
          _id: old.activation._id,
        }))?.lifecycle, 'LEASED');
        await forceExpired(old.activation._id);
        assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      } else {
        assert.equal((await activations.findOne({
          _id: old.activation._id,
        }))?.lifecycle, 'ABANDONED');
      }
      await assertSingleControlOwner(old.jobId);
      await drainControlRecovery(client, db);
      await settleOrdinaryWakes(old.jobId);
    });

    await check('legacy job without recovery fields starts a bounded lineage at one', async () => {
      const old = await leasedPlanning('control_legacy_missing_fields');
      await jobs.updateOne(
        { _id: old.jobId },
        {
          $unset: {
            activationRecoveryAttempt: '',
            activationRecoveryRootId: '',
            activationRecoveryRootKind: '',
          },
        },
      );
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const control = await assertSingleControlOwner(old.jobId);
      assert.equal(
        (control.reducerPayload as Record<string, unknown>).recoveryAttempt,
        1,
      );
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        1,
      );
      await drainControlRecovery(client, db);
      await settleOrdinaryWakes(old.jobId);
    });

    await check('expired RESULT_DRAIN recovers eligible demand and B applies once', async () => {
      const old = await runningResultDrain('control_result');
      const before = await businessSnapshot(old.jobId);
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      assert.equal((await activations.findOne({
        _id: old.activation._id,
      }))?.lifecycle, 'ABANDONED');
      const control = await assertSingleControlOwner(old.jobId);
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        1,
      );
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'ControlRecoveryRequested',
        state: 'PENDING',
        'payload.lostActivationId': old.activation._id,
        'payload.rootActivationKind': 'RESULT_DRAIN',
      }), 1);

      const handle = await recoveryHandle(old.jobId);
      assert.equal(handle.activationId, control._id);
      assert.ok(await commitRecovery(handle));
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        1,
      );
      assert.deepEqual(await businessSnapshot(old.jobId), before);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.inboxItemId': old.inbox._id,
      }), 1);

      await drainLane(client, db);
      assert.equal((await inbox.findOne({ _id: old.inbox._id }))?.state, 'APPLIED');
      assert.equal((await tasks.findOne({ _id: old.taskId }))?.phase, 'SUCCEEDED');
      assert.equal((await jobs.findOne({ _id: old.jobId }))?.terminalOutcome, 'COMPLETED');
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        0,
      );
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'JobTerminalized',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'JobTerminal',
      }), 1);
      const replay = await commitControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      });
      assert.equal(replay?.deduped, true);
    });

    await check('R1 adopts existing current-generation RESULT_DRAIN demand', async () => {
      const old = await runningResultDrain('control_result_adopt');
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const control = await assertSingleControlOwner(old.jobId);
      const generation = (await jobs.findOne({
        _id: old.jobId,
      }))?.activationDispatchGeneration;
      assert.equal(typeof generation, 'number');
      const existingWakeId =
        `obx_control_existing_demand:${globalThis.crypto.randomUUID()}`;
      await outbox.insertOne({
        _id: existingWakeId,
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: {
          jobId: old.jobId,
          reason: 'result_drain_recovery',
          attemptId: old.attemptId,
          inboxItemId: old.inbox._id,
          activationDispatchGeneration: generation,
        },
        createdAt: new Date(0),
      });

      const handle = await recoveryHandle(old.jobId);
      assert.equal(handle.activationId, control._id);
      const committed = await commitRecovery(handle);
      assert.equal(committed?.successorWakeId, existingWakeId);
      const replay = await commitControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      });
      assert.equal(replay?.deduped, true);
      assert.equal(replay?.successorWakeId, existingWakeId);
      await outbox.updateOne(
        { _id: existingWakeId },
        {
          $set: {
            'payload.reason': 'inbox_redrive',
            'payload.redriveRequestId': 'later_current_generation_adopter',
          },
        },
      );
      const replayAfterAdoption = await commitControlRecoveryActivation(
        client,
        db,
        {
          activationId: handle.activationId,
          leaseOwner: handle.leaseOwner,
          activationFence: handle.activationFence,
        },
      );
      assert.equal(replayAfterAdoption?.deduped, true);
      assert.equal(replayAfterAdoption?.successorWakeId, existingWakeId);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.activationDispatchGeneration': generation,
      }), 1);
      const adopted = await outbox.findOne({ _id: existingWakeId });
      assert.equal(
        (adopted?.payload as Record<string, unknown>).reason,
        'inbox_redrive',
      );
      await drainLane(client, db);
      assert.equal((await inbox.findOne({ _id: old.inbox._id }))?.state, 'APPLIED');
    });

    await check('started BUSINESS with ambiguous effects fails to an operator owner', async () => {
      const old = await runningPlanningWithPayload('control_business_ambiguous');
      // Even malformed/mixed BSON that lost its operation evidence remains
      // ambiguous solely because RUNNING business authority existed.
      await activations.updateOne(
        { _id: old.activation._id },
        {
          $set: {
            operationStartedAt: null,
            businessPayloadReadyGeneration: 0,
            businessPayloadReadyHash: null,
            businessPayloadReadyAt: null,
            reducerPayload: null,
          },
        },
      );
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const failed = await activations.findOne({ _id: old.activation._id });
      assert.equal(failed?.lifecycle, 'FAILED');
      assert.equal(failed?.activeSlot, true);
      assert.equal(
        failed?.reasonCode,
        'activation_recovery_ambiguous_business_effect',
      );
      assert.equal(await activations.countDocuments({
        jobId: old.jobId,
        kind: 'CONTROL_RECOVERY',
      }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'OperatorAlertRequested',
        'payload.alertType':
          'activation_recovery_ambiguous_business_effect',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 0);
    });

    await check('corrupt control lineage cannot claim or commit', async () => {
      const old = await leasedPlanning('control_corrupt_lineage');
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const control = await assertSingleControlOwner(old.jobId);
      const originalPayload = control.reducerPayload as Record<string, unknown>;
      const beforeFence = (await jobs.findOne({ _id: old.jobId }))?.activationFence;

      await activations.updateOne(
        { _id: control._id },
        {
          $set: {
            reducerPayload: {
              ...originalPayload,
              recoveryAttempt: 2,
            },
          },
        },
      );
      assert.equal(await claimControlRecoveryActivation(client, db, {
        activationId: control._id,
        leaseOwner: 'corrupt-lineage',
      }), null);
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationFence,
        beforeFence,
      );

      await activations.updateOne(
        { _id: control._id },
        { $set: { reducerPayload: originalPayload } },
      );
      const handle = await recoveryHandle(old.jobId);
      assert.equal(await startControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      }), true);
      await activations.updateOne(
        { _id: control._id },
        {
          $set: {
            reducerPayload: {
              ...originalPayload,
              rootActivationId: 'missing_root_activation',
            },
          },
        },
      );
      assert.equal(await commitControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      }), null);
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'LaneControlRecoveryCommitted',
      }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);

      await activations.updateOne(
        { _id: control._id },
        { $set: { reducerPayload: originalPayload } },
      );
      assert.ok(await commitControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      }));
      await settleOrdinaryWakes(old.jobId);
    });

    await check('corrupt published fallback cannot starve a later valid control owner', async () => {
      const first = await leasedPlanning('control_fallback_corrupt');
      const second = await leasedPlanning('control_fallback_valid');
      await Promise.all([
        forceExpired(first.activation._id),
        forceExpired(second.activation._id),
      ]);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 2);
      const firstControl = await assertSingleControlOwner(first.jobId);
      const secondControl = await assertSingleControlOwner(second.jobId);
      const firstPayload = firstControl.reducerPayload as Record<string, unknown>;
      await activations.updateOne(
        { _id: firstControl._id },
        {
          $set: {
            createdAt: new Date(0),
            updatedAt: new Date(0),
            reducerPayload: {
              ...firstPayload,
              rootActivationId: 'missing_fallback_root',
            },
          },
        },
      );
      await activations.updateOne(
        { _id: secondControl._id },
        { $set: { createdAt: new Date(1), updatedAt: new Date(1) } },
      );
      const published = [
        await claimNextControlRecoveryWake(client, db),
        await claimNextControlRecoveryWake(client, db),
      ];
      assert.deepEqual(
        new Set(published.map((wake) => wake?.activationId)),
        new Set([firstControl._id, secondControl._id]),
      );

      assert.deepEqual(
        await drainControlRecovery(client, db),
        { claimed: 0, committed: 1 },
      );
      assert.equal(
        (await activations.findOne({ _id: firstControl._id }))?.lifecycle,
        'PENDING',
      );
      assert.equal(
        (await activations.findOne({ _id: secondControl._id }))?.lifecycle,
        'COMMITTED',
      );

      await activations.updateOne(
        { _id: firstControl._id },
        { $set: { reducerPayload: firstPayload } },
      );
      assert.deepEqual(
        await drainControlRecovery(client, db),
        { claimed: 0, committed: 1 },
      );
      await Promise.all([
        settleOrdinaryWakes(first.jobId),
        settleOrdinaryWakes(second.jobId),
      ]);
    });

    await check('STOP_REQUESTED never restores RESULT_DRAIN demand', async () => {
      const old = await runningResultDrain('control_result_stop');
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const control = await assertSingleControlOwner(old.jobId);
      const handle = await recoveryHandle(old.jobId);
      assert.equal(handle.activationId, control._id);
      assert.equal(await startControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      }), true);
      const job = await jobs.findOne({ _id: old.jobId });
      assert.ok(job);
      assert.equal((await jobs.updateOne(
        {
          _id: old.jobId,
          stateVersion: job.stateVersion,
          activeActivationId: control._id,
        },
        {
          $set: { controlState: 'STOP_REQUESTED', updatedAt: new Date() },
          $inc: { stateVersion: 1 },
        },
      )).modifiedCount, 1);
      const settled = await commitControlRecoveryActivation(client, db, {
        activationId: handle.activationId,
        leaseOwner: handle.leaseOwner,
        activationFence: handle.activationFence,
      });
      assert.ok(settled);
      assert.equal(settled.successorWakeId, null);
      assert.equal((await inbox.findOne({ _id: old.inbox._id }))?.state, 'RECEIVED');
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'result_drain_recovery',
      }), 0);
    });

    await check('recovery-of-recovery expiry keeps one owner and one successor', async () => {
      const old = await leasedPlanning('control_chain');
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const firstControl = await assertSingleControlOwner(old.jobId);
      const firstHandle = await recoveryHandle(old.jobId);
      assert.equal(firstHandle.activationId, firstControl._id);
      assert.equal(await startControlRecoveryActivation(client, db, {
        activationId: firstHandle.activationId,
        leaseOwner: firstHandle.leaseOwner,
        activationFence: firstHandle.activationFence,
      }), true);
      await forceExpired(firstControl._id);

      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      assert.equal((await activations.findOne({
        _id: firstControl._id,
      }))?.lifecycle, 'ABANDONED');
      const secondControl = await assertSingleControlOwner(old.jobId);
      assert.notEqual(secondControl._id, firstControl._id);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'ControlRecoveryRequested',
      }), 2);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 0);

      // Simulate a crash after the distinct control request was published but
      // before the PENDING activation was claimed. The next control drain must
      // resume from the durable active slot without waiting for another expiry.
      const published = await claimNextControlRecoveryWake(client, db);
      assert.equal(published?.activationId, secondControl._id);
      assert.deepEqual(
        await drainControlRecovery(client, db),
        { claimed: 0, committed: 1 },
      );
      assert.equal(await activations.countDocuments({
        jobId: old.jobId,
        activeSlot: true,
      }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 1);
      await drainLane(client, db);
      assert.equal(await tasks.countDocuments({ jobId: old.jobId }), 1);
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'JobPlanned',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'LaneControlRecoveryCommitted',
      }), 1);
    });

    await check('recovery lineage persists until ordinary commit, then restarts at one', async () => {
      const old = await leasedPlanning('control_counter_reset');
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      assert.deepEqual(
        await drainControlRecovery(client, db),
        { claimed: 1, committed: 1 },
      );
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        1,
      );

      const firstWake = await outbox.findOne({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'activation_recovery',
      });
      assert.ok(firstWake);
      const alternateWakeId =
        `obx_alternate_recovery_source:${globalThis.crypto.randomUUID()}`;
      const recoveryGeneration = (await jobs.findOne({
        _id: old.jobId,
      }))?.activationDispatchGeneration;
      assert.equal(typeof recoveryGeneration, 'number');
      await outbox.insertOne({
        _id: alternateWakeId,
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: {
          jobId: old.jobId,
          reason: 'concurrent_current_generation_demand',
          activationDispatchGeneration: recoveryGeneration,
        },
        createdAt: new Date(),
      });
      const firstRetry = await materializePlanningActivation(
        client,
        db,
        old.jobId,
        { sourceWakeId: alternateWakeId },
      );
      assert.ok(firstRetry);
      await outbox.updateMany(
        { _id: { $in: [firstWake._id, alternateWakeId] } },
        { $set: { state: 'PUBLISHED' } },
      );
      await forceExpired(firstRetry._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const secondControl = await assertSingleControlOwner(old.jobId);
      const secondPayload = secondControl.reducerPayload as Record<string, unknown>;
      assert.equal(secondPayload.recoveryAttempt, 2);
      assert.equal(secondPayload.rootActivationId, old.activation._id);
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        2,
      );
      assert.deepEqual(
        await drainControlRecovery(client, db),
        { claimed: 1, committed: 1 },
      );

      const secondWake = await outbox.findOne({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'activation_recovery',
      });
      assert.ok(secondWake);
      const secondRetry = await materializePlanningActivation(
        client,
        db,
        old.jobId,
        { sourceWakeId: secondWake._id },
      );
      assert.ok(secondRetry);
      await outbox.updateOne(
        { _id: secondWake._id },
        { $set: { state: 'PUBLISHED' } },
      );
      const owner = `lane-counter-reset:${old.jobId}`;
      const lease = await claimPlanningActivation(client, db, {
        activationId: secondRetry._id,
        leaseOwner: owner,
        leaseTtlMs: 30_000,
      });
      assert.ok(lease);
      assert.equal(await startPlanningActivation(client, db, {
        activationId: secondRetry._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
      }), true);
      const proposal: PlanningProposalV1 = {
        kind: 'PLAN_SINGLE_SERIAL_TASK_V1',
        jobId: old.jobId,
        taskId: `task_control_${globalThis.crypto.randomUUID()}`,
        planVersion: secondRetry.planVersionAtClaim,
        attemptMode: 'SERIAL',
      };
      const marker = await markPlanningActivationPayloadReady(client, db, {
        activationId: secondRetry._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        proposal,
      });
      assert.equal(marker.ready, true);
      assert.ok(await commitPlanningActivation(client, db, {
        activationId: secondRetry._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
        businessPayloadReadyGeneration: marker.generation,
        proposal,
      }));
      const reset = await jobs.findOne({ _id: old.jobId });
      assert.equal(reset?.activationRecoveryAttempt, 0);
      assert.equal(reset?.activationRecoveryRootId, null);
      assert.equal(reset?.activationRecoveryRootKind, null);

      const dispatched = await dispatchAttempt(client, db, {
        jobId: old.jobId,
        taskId: proposal.taskId,
      });
      const worker = `worker-counter-reset:${old.jobId}`;
      const attemptLease = await claimAttempt(client, db, {
        attemptId: dispatched.attemptId,
        workerInstanceId: worker,
        leaseTtlMs: 30_000,
      });
      assert.ok(attemptLease);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId: dispatched.attemptId,
        leaseOwner: worker,
        attemptFence: attemptLease.attemptFence,
      }), true);
      const producer: Producer = { status: 'ok', data: { reset: true } };
      const attemptMarker = await markAttemptPayloadReady(client, db, {
        attemptId: dispatched.attemptId,
        leaseOwner: worker,
        attemptFence: attemptLease.attemptFence,
        producer,
      });
      assert.equal(attemptMarker.ready, true);
      assert.equal((await submitAttemptResult(client, db, {
        attemptId: dispatched.attemptId,
        leaseOwner: worker,
        attemptFence: attemptLease.attemptFence,
        producer,
        businessPayloadReadyGeneration: attemptMarker.generation,
      })).committed, true);
      const nextInbox = await inbox.findOne({
        jobId: old.jobId,
        attemptId: dispatched.attemptId,
      });
      assert.ok(nextInbox);
      const nextWake = await outbox.findOne({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.inboxItemId': nextInbox._id,
      });
      assert.ok(nextWake);
      const nextOrdinary = await materializeResultDrainActivation(
        client,
        db,
        old.jobId,
        { sourceWakeId: nextWake._id },
      );
      assert.ok(nextOrdinary);
      await outbox.updateOne(
        { _id: nextWake._id },
        { $set: { state: 'PUBLISHED' } },
      );
      await forceExpired(nextOrdinary._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const restarted = await assertSingleControlOwner(old.jobId);
      const restartedPayload = restarted.reducerPayload as Record<string, unknown>;
      assert.equal(restartedPayload.recoveryAttempt, 1);
      assert.equal(restartedPayload.rootActivationId, nextOrdinary._id);
      assert.equal(
        (await jobs.findOne({ _id: old.jobId }))?.activationRecoveryAttempt,
        1,
      );
      await drainControlRecovery(client, db);
      await drainLane(client, db);
    });

    await check('ordinary recovery-successor loss exhausts after three attempts', async () => {
      const root = await leasedPlanning('control_ordinary_exhaustion');
      let ordinary = root.activation;
      for (let recoveryAttempt = 1; recoveryAttempt <= 3; recoveryAttempt++) {
        await forceExpired(ordinary._id);
        assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
        const control = await assertSingleControlOwner(root.jobId);
        const payload = control.reducerPayload as Record<string, unknown>;
        assert.equal(payload.recoveryAttempt, recoveryAttempt);
        assert.equal(payload.rootActivationId, root.activation._id);
        assert.deepEqual(
          await drainControlRecovery(client, db),
          { claimed: 1, committed: 1 },
        );
        const wake = await outbox.findOne({
          aggregate: root.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          'payload.reason': 'activation_recovery',
        });
        assert.ok(wake);
        const next = await materializePlanningActivation(
          client,
          db,
          root.jobId,
          { sourceWakeId: wake._id },
        );
        assert.ok(next);
        await outbox.updateOne(
          { _id: wake._id },
          { $set: { state: 'PUBLISHED' } },
        );
        ordinary = next;
      }

      await forceExpired(ordinary._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const exhausted = await activations.findOne({ _id: ordinary._id });
      assert.equal(exhausted?.lifecycle, 'FAILED');
      assert.equal(exhausted?.activeSlot, true);
      assert.equal(exhausted?.reasonCode, 'activation_recovery_exhausted');
      assert.equal(await outbox.countDocuments({
        aggregate: root.jobId,
        type: 'OperatorAlertRequested',
        'payload.alertType': 'activation_recovery_exhausted',
      }), 1);
      assert.equal(await activations.countDocuments({
        jobId: root.jobId,
        kind: 'CONTROL_RECOVERY',
        activeSlot: true,
      }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: root.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
    });

    await check('repeated control loss is bounded and leaves one visible operator owner', async () => {
      const old = await leasedPlanning('control_exhaustion');
      await forceExpired(old.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);

      for (let recoveryAttempt = 1; recoveryAttempt <= 2; recoveryAttempt++) {
        const active = await assertSingleControlOwner(old.jobId);
        const payload = active.reducerPayload as Record<string, unknown>;
        assert.equal(payload.recoveryAttempt, recoveryAttempt);
        const handle = await recoveryHandle(old.jobId);
        assert.equal(handle.activationId, active._id);
        assert.equal(await startControlRecoveryActivation(client, db, {
          activationId: handle.activationId,
          leaseOwner: handle.leaseOwner,
          activationFence: handle.activationFence,
        }), true);
        await forceExpired(active._id);
        assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      }

      const finalControl = await assertSingleControlOwner(old.jobId);
      assert.equal(
        (finalControl.reducerPayload as Record<string, unknown>).recoveryAttempt,
        3,
      );
      const finalHandle = await recoveryHandle(old.jobId);
      assert.equal(await startControlRecoveryActivation(client, db, {
        activationId: finalHandle.activationId,
        leaseOwner: finalHandle.leaseOwner,
        activationFence: finalHandle.activationFence,
      }), true);
      await forceExpired(finalControl._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const exhausted = await activations.findOne({ _id: finalControl._id });
      assert.equal(exhausted?.lifecycle, 'FAILED');
      assert.equal(exhausted?.activeSlot, true);
      assert.equal(exhausted?.reasonCode, 'control_recovery_exhausted');
      assert.equal((await jobs.findOne({
        _id: old.jobId,
      }))?.activeActivationId, exhausted?._id);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'OperatorAlertRequested',
        'payload.alertType': 'control_recovery_exhausted',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: old.jobId,
        type: 'LaneControlRecoveryFailed',
      }), 1);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 0);
      await reWakeStuckJobs(client, db);
      assert.equal(await outbox.countDocuments({
        aggregate: old.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
    });

    await check('pause, terminal cancel and ineligible result settle fail closed', async () => {
      const paused = await leasedPlanning('control_pause');
      await forceExpired(paused.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const pausedControl = await assertSingleControlOwner(paused.jobId);
      const pausedHandle = await recoveryHandle(paused.jobId);
      assert.equal(pausedHandle.activationId, pausedControl._id);
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'control_pause_cmd',
        jobId: paused.jobId,
      });
      const pausedBefore = await businessSnapshot(paused.jobId);
      assert.equal(await startControlRecoveryActivation(client, db, {
        activationId: pausedHandle.activationId,
        leaseOwner: pausedHandle.leaseOwner,
        activationFence: pausedHandle.activationFence,
      }), false);
      assert.equal(await commitControlRecoveryActivation(client, db, {
        activationId: pausedHandle.activationId,
        leaseOwner: pausedHandle.leaseOwner,
        activationFence: pausedHandle.activationFence,
      }), null);
      assert.deepEqual(await businessSnapshot(paused.jobId), pausedBefore);
      assert.equal(await tasks.countDocuments({ jobId: paused.jobId }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: paused.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'activation_recovery',
      }), 0);
      const pausedState = await jobs.findOne({ _id: paused.jobId });
      assert.equal(pausedState?.activationRecoveryAttempt, 0);
      assert.equal(pausedState?.activationRecoveryRootId, null);
      assert.equal(pausedState?.activationRecoveryRootKind, null);
      // PAUSE may legitimately own its own current-generation control wake;
      // settle it so this multi-case harness cannot feed it to a later fixture.
      await settleOrdinaryWakes(paused.jobId);
      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'control_pause_resume_cmd',
        jobId: paused.jobId,
      });
      const resumeWake = await outbox.findOne({
        aggregate: paused.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      });
      assert.ok(resumeWake);
      const resumedOrdinary = await materializePlanningActivation(
        client,
        db,
        paused.jobId,
        { sourceWakeId: resumeWake._id },
      );
      assert.ok(resumedOrdinary);
      await outbox.updateOne(
        { _id: resumeWake._id },
        { $set: { state: 'PUBLISHED' } },
      );
      await forceExpired(resumedOrdinary._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const restartedControl = await assertSingleControlOwner(paused.jobId);
      assert.equal(
        (restartedControl.reducerPayload as Record<string, unknown>)
          .recoveryAttempt,
        1,
      );
      await drainControlRecovery(client, db);
      await settleOrdinaryWakes(paused.jobId);

      const cancelled = await leasedPlanning('control_cancel');
      await forceExpired(cancelled.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const cancelledControl = await assertSingleControlOwner(cancelled.jobId);
      const cancelledHandle = await recoveryHandle(cancelled.jobId);
      assert.equal(cancelledHandle.activationId, cancelledControl._id);
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'control_cancel_cmd',
        jobId: cancelled.jobId,
      });
      const cancelledBefore = await businessSnapshot(cancelled.jobId);
      assert.equal(await startControlRecoveryActivation(client, db, {
        activationId: cancelledHandle.activationId,
        leaseOwner: cancelledHandle.leaseOwner,
        activationFence: cancelledHandle.activationFence,
      }), false);
      assert.equal(await commitControlRecoveryActivation(client, db, {
        activationId: cancelledHandle.activationId,
        leaseOwner: cancelledHandle.leaseOwner,
        activationFence: cancelledHandle.activationFence,
      }), null);
      assert.deepEqual(await businessSnapshot(cancelled.jobId), cancelledBefore);
      assert.equal(cancelledBefore.terminalOutcome, 'CANCELLED');
      assert.equal(await outbox.countDocuments({
        aggregate: cancelled.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);

      const ineligible = await runningResultDrain('control_no_demand');
      await forceExpired(ineligible.activation._id);
      assert.equal(await reapExpiredActivationsToControlRecovery(client, db), 1);
      const ineligibleControl = await assertSingleControlOwner(ineligible.jobId);
      await inbox.updateOne(
        { _id: ineligible.inbox._id },
        {
          $set: {
            state: 'QUARANTINED_UNSUPPORTED',
            resolutionCode: 'unsupported_consumer_version',
            resolvedAt: new Date(),
          },
        },
      );
      const ineligibleBefore = await businessSnapshot(ineligible.jobId);
      const handle = await recoveryHandle(ineligible.jobId);
      assert.equal(handle.activationId, ineligibleControl._id);
      assert.ok(await commitRecovery(handle));
      assert.deepEqual(await businessSnapshot(ineligible.jobId), ineligibleBefore);
      assert.equal(await outbox.countDocuments({
        aggregate: ineligible.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
      assert.equal((await jobs.findOne({
        _id: ineligible.jobId,
      }))?.terminalOutcome, null);
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-control-recovery — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-control-recovery — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
