#!/usr/bin/env tsx
/**
 * e2e:orchestration-poison-redrive — PR-34 poison quarantine/operator redrive.
 *
 * Proves against a real replica set that unsupported inbox envelopes are
 * durably quarantined without a hot loop, an upgraded binary can redrive one
 * immutable historical envelope exactly once, and ownership/cancellation keep
 * the operator boundary fail-closed.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  cancelJob,
  canonicalHash,
  claimAttempt,
  claimResultDrainActivation,
  COLLECTIONS,
  commitResultDrainActivation,
  dispatchAttempt,
  drainLane,
  ensureOrchestrationIndexes,
  InboxRedriveUnavailableError,
  markAttemptPayloadReady,
  materializeResultDrainActivation,
  planJob,
  requestInboxRedrive,
  reWakeStuckJobs,
  runTxn,
  startAttemptOperation,
  startResultDrainActivation,
  submitAttemptResult,
  type AttemptDoc,
  type JobDoc,
  type JobEventDoc,
  type JobInboxDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type ResultDoc,
  type TaskDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_poison_redrive';
const CONVERSATION_ID = 'conv_poison_redrive';

interface RunningFixture {
  jobId: string;
  taskId: string;
  attemptId: string;
  worker: string;
  attemptFence: number;
}

interface IngressFixture extends RunningFixture {
  inbox: JobInboxDoc;
  result: ResultDoc;
}

interface DrainFixture {
  activation: LaneActivationDoc;
  owner: string;
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
  console.log('e2e:orchestration-poison-redrive');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_poison_redrive_e2e_${Date.now()}`,
    section: 'e2e:orchestration-poison-redrive',
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

  async function runningOptIn(name: string): Promise<RunningFixture> {
    const jobId = (await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      commandId: name,
      goal: `poison-redrive:${name}`,
      payload: { op: name },
    })).jobId;
    const planned = await planJob(client, db, jobId);
    assert.ok(planned);
    assert.equal(
      (await tasks.findOne({ _id: planned.taskId }))?.resultApplyMode,
      'RESULT_DRAIN_V1',
    );
    await outbox.updateMany(
      { aggregate: jobId, type: 'LaneWakeRequested', state: 'PENDING' },
      { $set: { state: 'PUBLISHED' } },
    );

    const { attemptId } = await dispatchAttempt(client, db, {
      jobId,
      taskId: planned.taskId,
    });
    const worker = `worker:${name}`;
    const lease = await claimAttempt(client, db, {
      attemptId,
      workerInstanceId: worker,
      leaseTtlMs: 30_000,
    });
    assert.ok(lease);
    assert.equal(await startAttemptOperation(client, db, {
      attemptId,
      leaseOwner: worker,
      attemptFence: lease.attemptFence,
    }), true);
    return {
      jobId,
      taskId: planned.taskId,
      attemptId,
      worker,
      attemptFence: lease.attemptFence,
    };
  }

  async function ingress(fixture: RunningFixture): Promise<IngressFixture> {
    const producer = {
      status: 'ok' as const,
      data: { attemptId: fixture.attemptId },
    };
    const marker = await markAttemptPayloadReady(client, db, {
      attemptId: fixture.attemptId,
      leaseOwner: fixture.worker,
      attemptFence: fixture.attemptFence,
      producer,
    });
    assert.equal(marker.ready, true);
    const submitted = await submitAttemptResult(client, db, {
      attemptId: fixture.attemptId,
      leaseOwner: fixture.worker,
      attemptFence: fixture.attemptFence,
      producer,
      businessPayloadReadyGeneration: marker.generation,
    });
    assert.equal(submitted.committed, true);
    assert.equal(submitted.deduped, false);

    const result = await results.findOne({ attemptId: fixture.attemptId });
    assert.ok(result);
    const item = await inbox.findOne({
      jobId: fixture.jobId,
      resultId: result._id,
    });
    assert.ok(item);
    assert.equal(result.status, 'ok', 'the redriven result is terminal for the task');
    return { ...fixture, result, inbox: item };
  }

  async function publishLaneWakes(jobId: string): Promise<void> {
    await outbox.updateMany(
      { aggregate: jobId, type: 'LaneWakeRequested', state: 'PENDING' },
      { $set: { state: 'PUBLISHED' } },
    );
  }

  async function runningDrain(jobId: string, owner: string): Promise<DrainFixture> {
    const activation = await materializeResultDrainActivation(client, db, jobId);
    assert.ok(activation);
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
      activation,
      owner,
      activationFence: lease.activationFence,
    };
  }

  async function commitDrain(run: DrainFixture) {
    return commitResultDrainActivation(client, db, {
      activationId: run.activation._id,
      leaseOwner: run.owner,
      activationFence: run.activationFence,
    });
  }

  /**
   * Model an envelope quarantined by an older binary. The current binary
   * supports its immutable ATTEMPT_RESULT_V1/v1 envelope, so it may be promoted
   * only through requestInboxRedrive. Evidence mirrors the B-boundary record.
   */
  async function installHistoricalQuarantine(
    fixture: IngressFixture,
    label: string,
  ): Promise<{
    activationId: string;
    activationFence: number;
    operatorAlertId: string;
  }> {
    const activationId = `act_historical_quarantine:${fixture.inbox._id}:${label}`;
    const operatorAlertId = `obx_inbox_quarantine:${fixture.inbox._id}:0`;
    const { value } = await runTxn(client, async (session) => {
      const job = await jobs.findOne(
        {
          _id: fixture.jobId,
          terminalOutcome: null,
          phase: 'AWAITING_RESULTS',
          activeActivationId: null,
        },
        { session },
      );
      const item = await inbox.findOne(
        {
          _id: fixture.inbox._id,
          jobId: fixture.jobId,
          kind: 'ATTEMPT_RESULT_V1',
          consumerVersion: 1,
          state: 'RECEIVED',
          redriveAttempt: 0,
        },
        { session },
      );
      assert.ok(job);
      assert.ok(item);
      assert.equal(item.inboxSequence, job.inboxHighWatermark);

      const now = new Date();
      const reducerPayload = {
        kind: 'DRAIN_RESULT_INBOX_BATCH_V1',
        jobId: job._id,
        planVersion: job.planVersion,
        batchThroughWatermark: item.inboxSequence,
        decisions: [{
          kind: 'QUARANTINE_UNSUPPORTED_INBOX_V1',
          jobId: job._id,
          inboxItemId: item._id,
          inboxSequence: item.inboxSequence,
          taskId: item.taskId,
          attemptId: item.attemptId,
          resultId: item.resultId,
          planVersion: item.planVersion,
          attemptFence: item.attemptFence,
          payloadHash: item.payloadHash,
          inboxKind: item.kind,
          consumerVersion: item.consumerVersion,
          redriveAttempt: 0,
          sourceState: 'RECEIVED',
          resolutionCode: 'unsupported_consumer_version',
        }],
      };
      const itemCas = await inbox.updateOne(
        {
          _id: item._id,
          jobId: job._id,
          kind: item.kind,
          consumerVersion: item.consumerVersion,
          state: 'RECEIVED',
          redriveAttempt: 0,
          appliedByActivationId: null,
          resolvedByActivationId: null,
          resolvedAt: null,
        },
        {
          $set: {
            state: 'QUARANTINED_UNSUPPORTED',
            resolvedByActivationId: activationId,
            resolutionCode: 'unsupported_consumer_version',
            operatorAlertId,
            resolvedAt: now,
          },
        },
        { session },
      );
      assert.equal(itemCas.modifiedCount, 1);

      const jobCas = await jobs.updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          terminalOutcome: null,
          phase: 'AWAITING_RESULTS',
          activeActivationId: null,
          inboxHighWatermark: job.inboxHighWatermark,
          resolvedInboxWatermark: job.resolvedInboxWatermark,
        },
        {
          $set: {
            phase: 'RECONCILING',
            resolvedInboxWatermark: job.inboxHighWatermark,
            updatedAt: now,
          },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      assert.equal(jobCas.modifiedCount, 1);

      await activations.insertOne({
        _id: activationId,
        sourceWakeId: null,
        jobId: job._id,
        kind: 'RESULT_DRAIN',
        lifecycle: 'COMMITTED',
        activeSlot: false,
        activationDispatchGenerationAtClaim: job.activationDispatchGeneration,
        planVersionAtClaim: job.planVersion,
        jobStopGenerationAtClaim: job.jobStopGeneration,
        leaseOwner: null,
        leaseExpiresAt: null,
        activationFence: job.activationFence,
        operationStartedAt: now,
        businessOperationCutoffAt: now,
        workDeadlineAt: now,
        hardDeadlineAt: now,
        purposeAttemptIds: [item.attemptId],
        batchInboxItemIds: [item._id],
        batchThroughWatermark: item.inboxSequence,
        inboxHighWatermarkAtClaim: job.inboxHighWatermark,
        appliedInboxWatermarkAtClaim: job.appliedInboxWatermark,
        resolvedInboxWatermarkAtClaim: job.resolvedInboxWatermark,
        businessPayloadReadyGeneration: 0,
        businessPayloadReadyHash: null,
        businessPayloadReadyAt: null,
        reducerPayload,
        committedPayloadHash: canonicalHash(reducerPayload),
        committedAppliedInboxWatermark: job.appliedInboxWatermark,
        committedResolvedInboxWatermark: job.inboxHighWatermark,
        successorWakeId: null,
        committedAt: now,
        outcome: 'BATCH_DRAINED',
        reasonCode: null,
        createdAt: now,
        updatedAt: now,
      }, { session });

      await outbox.updateMany(
        {
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
        },
        { $set: { state: 'PUBLISHED' } },
        { session },
      );
      await outbox.insertOne({
        _id: operatorAlertId,
        aggregate: job._id,
        type: 'OperatorAlertRequested',
        state: 'PENDING',
        payload: {
          alertType: 'inbox_quarantined_unsupported',
          resourceId: job.resourceId,
          conversationId: job.conversationId,
          jobId: job._id,
          inboxItemId: item._id,
          inboxSequence: item.inboxSequence,
          taskId: item.taskId,
          attemptId: item.attemptId,
          resultId: item.resultId,
          inboxKind: item.kind,
          consumerVersion: item.consumerVersion,
          payloadHash: item.payloadHash,
          redriveAttempt: 0,
          resolutionCode: 'unsupported_consumer_version',
          activationId,
        },
        createdAt: now,
      }, { session });

      const last = await events.find({ jobId: job._id }, { session })
        .sort({ sequence: -1 })
        .limit(1)
        .next();
      const sequence = (last?.sequence ?? -1) + 1;
      await events.insertOne({
        _id: `${job._id}:${sequence}`,
        jobId: job._id,
        sequence,
        type: 'JobInboxQuarantined',
        payload: {
          inboxItemId: item._id,
          inboxSequence: item.inboxSequence,
          taskId: item.taskId,
          attemptId: item.attemptId,
          resultId: item.resultId,
          inboxKind: item.kind,
          consumerVersion: item.consumerVersion,
          redriveAttempt: 0,
          resolutionCode: 'unsupported_consumer_version',
          operatorAlertId,
          activationId,
        },
        createdAt: now,
      }, { session });
      return {
        activationId,
        activationFence: job.activationFence,
        operatorAlertId,
      };
    });
    return value;
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('unsupported current envelope quarantines atomically and never hot-loops', async () => {
      const fixture = await ingress(await runningOptIn('quarantine_atomic'));
      assert.equal(await inbox.updateOne(
        {
          _id: fixture.inbox._id,
          state: 'RECEIVED',
          consumerVersion: 1,
        },
        { $set: { consumerVersion: 2 } },
      ).then((result) => result.modifiedCount), 1);
      await publishLaneWakes(fixture.jobId);

      const run = await runningDrain(fixture.jobId, 'lane:quarantine-atomic');
      const committed = await commitDrain(run);
      assert.ok(committed);
      assert.equal(committed.deduped, false);
      assert.equal(committed.outcome, null);
      assert.equal(committed.appliedInboxWatermark, 0);
      assert.equal(committed.resolvedInboxWatermark, 1);
      assert.equal(committed.successorWakeId, null);

      const [job, item, task] = await Promise.all([
        jobs.findOne({ _id: fixture.jobId }),
        inbox.findOne({ _id: fixture.inbox._id }),
        tasks.findOne({ _id: fixture.taskId }),
      ]);
      assert.equal(job?.phase, 'RECONCILING');
      assert.equal(job?.terminalOutcome, null);
      assert.equal(job?.inboxHighWatermark, 1);
      assert.equal(job?.resolvedInboxWatermark, job?.inboxHighWatermark);
      assert.equal(job?.appliedInboxWatermark, 0);
      assert.equal(task?.phase, 'AWAITING_RESULT');
      assert.equal(item?.state, 'QUARANTINED_UNSUPPORTED');
      assert.equal(item?.consumerVersion, 2);
      assert.equal(item?.resolutionCode, 'unsupported_consumer_version');
      assert.ok(item?.resolvedByActivationId);
      assert.ok(item?.operatorAlertId);
      assert.ok(item?.resolvedAt);

      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'OperatorAlertRequested',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxQuarantined',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);

      const beforeReplay = await jobs.findOne({ _id: fixture.jobId });
      const replay = await commitDrain(run);
      assert.equal(replay?.deduped, true);
      assert.equal(replay?.resolvedInboxWatermark, 1);
      const afterReplay = await jobs.findOne({ _id: fixture.jobId });
      assert.equal(afterReplay?.stateVersion, beforeReplay?.stateVersion);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'OperatorAlertRequested',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxQuarantined',
      }), 1);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
    });

    await check('parallel operator redrive preserves identity/watermarks and terminalizes once', async () => {
      const fixture = await ingress(await runningOptIn('upgrade_redrive'));
      const evidence = await installHistoricalQuarantine(fixture, 'upgrade');
      const beforeJob = await jobs.findOne({ _id: fixture.jobId });
      const beforeItem = await inbox.findOne({ _id: fixture.inbox._id });
      assert.ok(beforeJob);
      assert.ok(beforeItem);
      assert.equal(beforeJob.phase, 'RECONCILING');
      assert.equal(beforeJob.inboxHighWatermark, 1);
      assert.equal(beforeJob.resolvedInboxWatermark, 1);
      assert.equal(beforeItem.kind, 'ATTEMPT_RESULT_V1');
      assert.equal(beforeItem.consumerVersion, 1);
      assert.equal(beforeItem.state, 'QUARANTINED_UNSUPPORTED');
      assert.equal(beforeItem.operatorAlertId, evidence.operatorAlertId);
      assert.equal(beforeItem.resolvedByActivationId, evidence.activationId);

      const redriveInput = {
        resourceId: RESOURCE_ID,
        jobId: fixture.jobId,
        inboxItemId: fixture.inbox._id,
        redriveRequestId: 'redrive-upgrade-1',
        expectedConsumerVersion: 1,
      };
      const redrives = await Promise.all([
        requestInboxRedrive(client, db, redriveInput),
        requestInboxRedrive(client, db, redriveInput),
      ]);
      assert.ok(redrives[0]);
      assert.ok(redrives[1]);
      assert.deepEqual(
        redrives.map((result) => result!.deduped).sort(),
        [false, true],
      );
      assert.equal(redrives[0]!.wakeId, redrives[1]!.wakeId);
      assert.equal(redrives[0]!.redriveAttempt, 1);
      assert.equal(redrives[1]!.redriveAttempt, 1);

      const [afterRedriveJob, afterRedriveItem] = await Promise.all([
        jobs.findOne({ _id: fixture.jobId }),
        inbox.findOne({ _id: fixture.inbox._id }),
      ]);
      assert.ok(afterRedriveJob);
      assert.ok(afterRedriveItem);
      assert.equal(afterRedriveItem._id, beforeItem._id);
      assert.equal(afterRedriveItem.inboxSequence, beforeItem.inboxSequence);
      assert.equal(afterRedriveItem.kind, beforeItem.kind);
      assert.equal(afterRedriveItem.consumerVersion, beforeItem.consumerVersion);
      assert.equal(afterRedriveItem.resultId, beforeItem.resultId);
      assert.equal(afterRedriveItem.payloadHash, beforeItem.payloadHash);
      assert.equal(afterRedriveItem.state, 'PENDING_REDRIVE');
      assert.equal(afterRedriveItem.redriveAttempt, 1);
      assert.equal(afterRedriveItem.lastRedriveRequestId, 'redrive-upgrade-1');
      assert.equal(afterRedriveItem.resolvedByActivationId, null);
      assert.equal(afterRedriveItem.operatorAlertId, null);
      assert.equal(afterRedriveItem.resolvedAt, null);
      assert.equal(
        afterRedriveJob.inboxHighWatermark,
        beforeJob.inboxHighWatermark,
      );
      assert.equal(
        afterRedriveJob.resolvedInboxWatermark,
        beforeJob.resolvedInboxWatermark,
      );
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxRedriveRequested',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.redriveAttempt': 1,
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'OperatorAlertRequested',
      }), 1, 'historical alert remains durable');

      assert.equal(await drainLane(client, db), 1);
      const [terminal, applied, terminalTask] = await Promise.all([
        jobs.findOne({ _id: fixture.jobId }),
        inbox.findOne({ _id: fixture.inbox._id }),
        tasks.findOne({ _id: fixture.taskId }),
      ]);
      assert.equal(terminal?.phase, 'TERMINAL');
      assert.equal(terminal?.terminalOutcome, 'COMPLETED');
      assert.equal(terminal?.inboxHighWatermark, 1);
      assert.equal(terminal?.appliedInboxWatermark, 1);
      assert.equal(terminal?.resolvedInboxWatermark, 1);
      assert.equal(applied?.state, 'APPLIED');
      assert.equal(applied?.redriveAttempt, 1);
      assert.equal(applied?.inboxSequence, beforeItem.inboxSequence);
      assert.equal(terminalTask?.phase, 'SUCCEEDED');
      assert.equal(terminalTask?.appliedResultId, fixture.result._id);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobTerminalized',
      }), 1);

      const historicalQuarantineReplay = await commitResultDrainActivation(
        client,
        db,
        {
          activationId: evidence.activationId,
          leaseOwner: 'retired-binary-owner',
          activationFence: evidence.activationFence,
        },
      );
      assert.equal(historicalQuarantineReplay?.deduped, true);
      assert.equal(historicalQuarantineReplay?.resolvedInboxWatermark, 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'OperatorAlertRequested',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxQuarantined',
      }), 1);

      const terminalVersion = terminal?.stateVersion;
      const replay = await requestInboxRedrive(client, db, redriveInput);
      assert.equal(replay?.deduped, true);
      assert.equal(replay?.wakeId, redrives[0]!.wakeId);
      assert.equal((await jobs.findOne({ _id: fixture.jobId }))?.stateVersion, terminalVersion);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxRedriveRequested',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobTerminalized',
      }), 1);
      assert.equal(await drainLane(client, db), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
    });

    await check('redrive is owner-scoped, binary-gated and cannot resurrect cancellation', async () => {
      const owned = await ingress(await runningOptIn('owner_cancel'));
      await installHistoricalQuarantine(owned, 'owner-cancel');
      const snapshot = await inbox.findOne({ _id: owned.inbox._id });
      assert.ok(snapshot);

      const wrongOwner = await requestInboxRedrive(client, db, {
        resourceId: 'res_not_owner',
        jobId: owned.jobId,
        inboxItemId: owned.inbox._id,
        redriveRequestId: 'wrong-owner-redrive',
        expectedConsumerVersion: 1,
      });
      assert.equal(wrongOwner, null);
      assert.deepEqual(await inbox.findOne({ _id: owned.inbox._id }), snapshot);
      assert.equal(await events.countDocuments({
        jobId: owned.jobId,
        type: 'JobInboxRedriveRequested',
      }), 0);

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'owner-cancel-before-redrive',
        jobId: owned.jobId,
      });
      const afterCancel = await requestInboxRedrive(client, db, {
        resourceId: RESOURCE_ID,
        jobId: owned.jobId,
        inboxItemId: owned.inbox._id,
        redriveRequestId: 'after-cancel-redrive',
        expectedConsumerVersion: 1,
      });
      assert.equal(afterCancel, null);
      const blockedCancel = await jobs.findOne({ _id: owned.jobId });
      assert.equal(blockedCancel?.terminalOutcome, null);
      assert.equal(blockedCancel?.pendingTerminalOutcome, 'CANCELLED');
      assert.equal(blockedCancel?.terminalBarrierMode, 'BLOCKED_UNSUPPORTED');
      assert.equal(
        blockedCancel?.terminalBarrierBlocker,
        'unresolved_inbox_obligation',
      );
      assert.equal(
        (await inbox.findOne({ _id: owned.inbox._id }))?.state,
        'QUARANTINED_UNSUPPORTED',
      );
      assert.equal(await events.countDocuments({
        jobId: owned.jobId,
        type: 'JobInboxRedriveRequested',
      }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: owned.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);

      const raced = await ingress(await runningOptIn('redrive_cancel_race'));
      await installHistoricalQuarantine(raced, 'redrive-cancel-race');
      const raceInput = {
        resourceId: RESOURCE_ID,
        jobId: raced.jobId,
        inboxItemId: raced.inbox._id,
        redriveRequestId: 'redrive-cancel-race-request',
        expectedConsumerVersion: 1,
      };
      const [raceRedrive] = await Promise.all([
        requestInboxRedrive(client, db, raceInput),
        cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'redrive-cancel-race-command',
          jobId: raced.jobId,
        }),
      ]);
      const [raceJob, raceItem] = await Promise.all([
        jobs.findOne({ _id: raced.jobId }),
        inbox.findOne({ _id: raced.inbox._id }),
      ]);
      assert.ok(
        raceItem?.state === 'QUARANTINED_UNSUPPORTED'
        || raceItem?.state === 'REJECTED_STALE',
      );
      if (raceItem?.state === 'REJECTED_STALE') {
        assert.equal(raceJob?.terminalOutcome, 'CANCELLED');
      } else {
        assert.equal(raceJob?.terminalOutcome, null);
        assert.equal(raceJob?.pendingTerminalOutcome, 'CANCELLED');
        assert.equal(
          raceJob?.terminalBarrierBlocker,
          'unresolved_inbox_obligation',
        );
      }
      assert.notEqual(raceItem?.state, 'PENDING_REDRIVE');
      assert.notEqual(raceItem?.state, 'APPLIED');
      assert.equal(await outbox.countDocuments({
        aggregate: raced.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
      assert.equal(await drainLane(client, db), 0);
      const raceReplay = await requestInboxRedrive(client, db, raceInput);
      if (raceRedrive) {
        assert.equal(raceReplay?.deduped, true);
      } else {
        assert.equal(raceReplay, null);
      }
      assert.equal(
        (await jobs.findOne({ _id: raced.jobId }))?.terminalOutcome,
        raceItem?.state === 'REJECTED_STALE' ? 'CANCELLED' : null,
      );

      const unsupported = await ingress(await runningOptIn('binary_gate'));
      await inbox.updateOne(
        { _id: unsupported.inbox._id, state: 'RECEIVED' },
        { $set: { consumerVersion: 2 } },
      );
      await publishLaneWakes(unsupported.jobId);
      const run = await runningDrain(unsupported.jobId, 'lane:binary-gate');
      assert.ok(await commitDrain(run));
      await assert.rejects(
        requestInboxRedrive(client, db, {
          resourceId: RESOURCE_ID,
          jobId: unsupported.jobId,
          inboxItemId: unsupported.inbox._id,
          redriveRequestId: 'unsupported-binary-redrive',
          expectedConsumerVersion: 2,
        }),
        (err: unknown) => err instanceof InboxRedriveUnavailableError,
      );
      assert.equal(
        (await inbox.findOne({ _id: unsupported.inbox._id }))?.state,
        'QUARANTINED_UNSUPPORTED',
      );
      assert.equal(await events.countDocuments({
        jobId: unsupported.jobId,
        type: 'JobInboxRedriveRequested',
      }), 0);
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-poison-redrive — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-poison-redrive — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
