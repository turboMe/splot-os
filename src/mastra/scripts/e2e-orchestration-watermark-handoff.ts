#!/usr/bin/env tsx
/**
 * e2e:orchestration-watermark-handoff — PR-33 bounded inbox spine.
 *
 * Proves against a real replica set that A allocates ordered inbox sequences,
 * B advances diagnostic/contiguous watermarks, a finite stale prefix cannot
 * strand a valid result, and ingress consumed while an activation is RUNNING is
 * recovered by the deterministic successor written in the same B transaction.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  advanceJobFromTasks,
  backfillActivationAuthoritySchema,
  cancelJob,
  claimAttempt,
  claimNextWake,
  claimResultDrainActivation,
  COLLECTIONS,
  commitResultDrainActivation,
  dispatchAttempt,
  drainLane,
  ensureOrchestrationIndexes,
  markAttemptPayloadReady,
  materializeResultDrainActivation,
  pauseJob,
  planJob,
  reapExpiredActivations,
  reWakeStuckJobs,
  resumeJob,
  runResultDrainActivation,
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

const RESOURCE_ID = 'res_watermark_handoff';
const CONVERSATION_ID = 'conv_watermark_handoff';

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

interface RunningDrain {
  activation: LaneActivationDoc;
  owner: string;
  activationFence: number;
}

type RawStringIdDoc = Record<string, unknown> & { _id: string };

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
  console.log('e2e:orchestration-watermark-handoff');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_watermark_handoff_e2e_${Date.now()}`,
    section: 'e2e:orchestration-watermark-handoff',
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
      goal: `watermark:${name}`,
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
    const producer = { status: 'ok' as const, data: { attemptId: fixture.attemptId } };
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
    const item = await inbox.findOne({ jobId: fixture.jobId, resultId: result._id });
    assert.ok(item);
    return { ...fixture, result, inbox: item };
  }

  async function appendSyntheticStale(
    fixture: Pick<RunningFixture, 'jobId' | 'taskId'>,
    label: string,
  ): Promise<JobInboxDoc> {
    const { value } = await runTxn(client, async (session) => {
      const before = await jobs.findOne(
        { _id: fixture.jobId, terminalOutcome: null },
        { session },
      );
      assert.ok(before);
      const after = await jobs.findOneAndUpdate(
        {
          _id: before._id,
          terminalOutcome: null,
          stateVersion: before.stateVersion,
          inboxHighWatermark: before.inboxHighWatermark,
        },
        {
          $inc: {
            stateVersion: 1,
            inboxHighWatermark: 1,
          },
          $set: { updatedAt: new Date() },
        },
        { session, returnDocument: 'after' },
      );
      assert.ok(after);
      const now = new Date();
      const sequence = after.inboxHighWatermark;
      const item: JobInboxDoc = {
        _id: `${after._id}:synthetic-stale:${label}`,
        jobId: after._id,
        taskId: fixture.taskId,
        attemptId: `att_stale_${label}`,
        resultId: `res_stale_${label}`,
        inboxSequence: sequence,
        kind: 'ATTEMPT_RESULT_V1',
        consumerVersion: 1,
        state: 'RECEIVED',
        planVersion: Math.max(0, after.planVersion - 1),
        attemptFence: 1,
        payloadHash: `stale-hash:${label}`,
        finishCurrentPauseGenerationAtA: null,
        appliedByActivationId: null,
        resolvedByActivationId: null,
        resolutionCode: null,
        redriveAttempt: 0,
        lastRedriveRequestId: null,
        operatorAlertId: null,
        retryTimerGeneration: 0,
        retryAttempt: 0,
        retryTimerId: null,
        nextEligibleAt: null,
        retryReasonCode: null,
        resolvedAt: null,
        createdAt: now,
      };
      await inbox.insertOne(item, { session });
      await outbox.insertOne({
        _id: `obx_synthetic_stale:${after._id}:${sequence}`,
        aggregate: after._id,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: {
          jobId: after._id,
          reason: 'synthetic_stale_ingress',
          inboxItemId: item._id,
          inboxSequence: sequence,
          activationDispatchGeneration: after.activationDispatchGeneration,
        },
        createdAt: now,
      }, { session });
      return item;
    });
    return value;
  }

  async function runningDrain(
    jobId: string,
    maxBatchItems: number,
    owner: string,
  ): Promise<RunningDrain> {
    const activation = await materializeResultDrainActivation(client, db, jobId, {
      maxBatchItems,
    });
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

  async function commitDrain(run: RunningDrain) {
    return commitResultDrainActivation(client, db, {
      activationId: run.activation._id,
      leaseOwner: run.owner,
      activationFence: run.activationFence,
    });
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('A allocates sequence/high atomically; terminal B closes all watermarks', async () => {
      const item = await ingress(await runningOptIn('watermark_single'));
      const afterA = await jobs.findOne({ _id: item.jobId });
      assert.equal(item.inbox.inboxSequence, 1);
      assert.equal(afterA?.inboxHighWatermark, 1);
      assert.equal(afterA?.appliedInboxWatermark, 0);
      assert.equal(afterA?.resolvedInboxWatermark, 0);

      const applied = await runResultDrainActivation(client, db, item.jobId);
      assert.equal(applied?.outcome, 'COMPLETED');
      assert.equal(applied?.appliedInboxWatermark, 1);
      assert.equal(applied?.resolvedInboxWatermark, 1);
      const terminal = await jobs.findOne({ _id: item.jobId });
      assert.equal(terminal?.inboxHighWatermark, 1);
      assert.equal(terminal?.appliedInboxWatermark, 1);
      assert.equal(terminal?.resolvedInboxWatermark, 1);
    });

    await check('bounded stale prefix hands off once, then valid result terminalizes', async () => {
      const running = await runningOptIn('watermark_stale_prefix');
      const stale = await appendSyntheticStale(running, 'prefix');
      const valid = await ingress(running);
      assert.equal(stale.inboxSequence, 1);
      assert.equal(valid.inbox.inboxSequence, 2);

      const firstRun = await runningDrain(valid.jobId, 1, 'lane:stale-prefix');
      assert.deepEqual(firstRun.activation.batchInboxItemIds, [stale._id]);
      assert.equal(firstRun.activation.batchThroughWatermark, 1);
      const first = await commitDrain(firstRun);
      assert.ok(first);
      assert.equal(first.outcome, null);
      assert.equal(first.appliedInboxWatermark, 0);
      assert.equal(first.resolvedInboxWatermark, 1);
      assert.ok(first.successorWakeId);
      assert.equal((await inbox.findOne({ _id: stale._id }))?.state, 'REJECTED_STALE');
      assert.equal((await inbox.findOne({ _id: valid.inbox._id }))?.state, 'RECEIVED');
      assert.equal((await jobs.findOne({ _id: valid.jobId }))?.terminalOutcome, null);
      assert.equal(await outbox.countDocuments({ _id: first.successorWakeId! }), 1);

      const beforeReplay = await jobs.findOne({ _id: valid.jobId });
      const replay = await commitDrain(firstRun);
      assert.equal(replay?.deduped, true);
      assert.equal(replay?.successorWakeId, first.successorWakeId);
      const afterReplay = await jobs.findOne({ _id: valid.jobId });
      assert.equal(afterReplay?.stateVersion, beforeReplay?.stateVersion);
      assert.equal(afterReplay?.inboxHighWatermark, beforeReplay?.inboxHighWatermark);
      assert.equal(afterReplay?.appliedInboxWatermark, beforeReplay?.appliedInboxWatermark);
      assert.equal(afterReplay?.resolvedInboxWatermark, beforeReplay?.resolvedInboxWatermark);
      assert.equal(await outbox.countDocuments({ _id: first.successorWakeId! }), 1);

      const second = await runResultDrainActivation(client, db, valid.jobId, {
        maxBatchItems: 1,
      });
      assert.equal(second?.outcome, 'COMPLETED');
      assert.equal(second?.appliedInboxWatermark, 2);
      assert.equal(second?.resolvedInboxWatermark, 2);
      assert.equal(await events.countDocuments({
        jobId: valid.jobId,
        type: 'JobTerminalized',
      }), 1);
    });

    await check('ingress consumed during RUNNING batch is recovered by one successor', async () => {
      const running = await runningOptIn('watermark_snapshot_race');
      const stale1 = await appendSyntheticStale(running, 'race-1');
      const valid = await ingress(running);
      const firstRun = await runningDrain(valid.jobId, 1, 'lane:snapshot-race');
      assert.deepEqual(firstRun.activation.batchInboxItemIds, [stale1._id]);
      assert.equal(firstRun.activation.inboxHighWatermarkAtClaim, 2);

      const stale3 = await appendSyntheticStale(running, 'race-3');
      assert.equal(stale3.inboxSequence, 3);
      const stale3Wake = await outbox.findOne({
        aggregate: valid.jobId,
        'payload.inboxItemId': stale3._id,
      });
      assert.ok(stale3Wake);
      await outbox.insertOne({
        ...stale3Wake,
        _id: `obx_duplicate_transport:${valid.jobId}`,
        createdAt: new Date(stale3Wake.createdAt.getTime() + 1),
      });
      await outbox.updateMany(
        {
          aggregate: { $ne: valid.jobId },
          type: 'LaneWakeRequested',
          state: 'PENDING',
        },
        { $set: { state: 'PUBLISHED' } },
      );

      let consumed = 0;
      for (;;) {
        const handle = await claimNextWake(client, db);
        if (!handle) break;
        assert.equal(handle.jobId, valid.jobId);
        assert.equal(handle.resultDrainActivationId, firstRun.activation._id);
        consumed++;
      }
      assert.equal(
        consumed,
        4,
        'stale1, valid, stale3 and duplicate transport wakes were all consumed',
      );

      const first = await commitDrain(firstRun);
      assert.ok(first?.successorWakeId);
      assert.equal(first?.resolvedInboxWatermark, 1);
      assert.equal((await jobs.findOne({ _id: valid.jobId }))?.inboxHighWatermark, 3);
      assert.equal(await outbox.countDocuments({ _id: first!.successorWakeId! }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: valid.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 1, 'only the deterministic B handoff remains pending');

      assert.equal(await drainLane(client, db), 1);
      const terminal = await jobs.findOne({ _id: valid.jobId });
      assert.equal(terminal?.terminalOutcome, 'COMPLETED');
      assert.equal(terminal?.inboxHighWatermark, 3);
      assert.equal(terminal?.appliedInboxWatermark, 2);
      assert.equal(terminal?.resolvedInboxWatermark, 3);
      assert.equal((await inbox.findOne({ _id: stale3._id }))?.state, 'REJECTED_STALE');
      assert.equal(await events.countDocuments({
        jobId: valid.jobId,
        type: 'JobTerminalized',
      }), 1);
      const beforeReplay = await jobs.findOne({ _id: valid.jobId });
      const terminalEventsBefore = await events.countDocuments({
        jobId: valid.jobId,
        type: 'JobTerminalized',
      });
      const replay = await commitDrain(firstRun);
      assert.equal(replay?.deduped, true);
      const afterReplay = await jobs.findOne({ _id: valid.jobId });
      assert.equal(afterReplay?.stateVersion, beforeReplay?.stateVersion);
      assert.equal(afterReplay?.inboxHighWatermark, beforeReplay?.inboxHighWatermark);
      assert.equal(afterReplay?.appliedInboxWatermark, beforeReplay?.appliedInboxWatermark);
      assert.equal(afterReplay?.resolvedInboxWatermark, beforeReplay?.resolvedInboxWatermark);
      assert.equal(await events.countDocuments({
        jobId: valid.jobId,
        type: 'JobTerminalized',
      }), terminalEventsBefore);
      assert.equal(await outbox.countDocuments({ _id: first!.successorWakeId! }), 1);
    });

    await check('valid-first commit defers job terminalization until its late tail drains', async () => {
      const valid = await ingress(await runningOptIn('watermark_valid_first'));
      const firstRun = await runningDrain(valid.jobId, 1, 'lane:valid-first');
      assert.deepEqual(firstRun.activation.batchInboxItemIds, [valid.inbox._id]);
      const lateStale = await appendSyntheticStale(valid, 'valid-first-tail');
      assert.equal(lateStale.inboxSequence, 2);
      const pendingBeforeCommit = await outbox.find({
        aggregate: valid.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }, { projection: { _id: 1 } }).toArray();
      assert.equal(pendingBeforeCommit.length, 2);

      const first = await commitDrain(firstRun);
      assert.equal(first?.outcome, null);
      assert.equal(first?.appliedInboxWatermark, 1);
      assert.equal(first?.resolvedInboxWatermark, 1);
      assert.ok(first?.successorWakeId);
      assert.ok(
        pendingBeforeCommit.some((wake) => wake._id === first?.successorWakeId),
        'B adopts one existing ingress wake instead of adding another demand',
      );
      assert.equal(await outbox.countDocuments({
        aggregate: valid.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 1);
      assert.equal((await tasks.findOne({ _id: valid.taskId }))?.phase, 'SUCCEEDED');
      assert.equal((await jobs.findOne({ _id: valid.jobId }))?.terminalOutcome, null);

      await outbox.updateMany(
        {
          aggregate: valid.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          _id: { $ne: first!.successorWakeId! },
        },
        { $set: { state: 'PUBLISHED' } },
      );
      assert.equal(await drainLane(client, db), 1);
      const terminal = await jobs.findOne({ _id: valid.jobId });
      assert.equal(terminal?.terminalOutcome, 'COMPLETED');
      assert.equal(terminal?.inboxHighWatermark, 2);
      assert.equal(terminal?.appliedInboxWatermark, 1);
      assert.equal(terminal?.resolvedInboxWatermark, 2);
      assert.equal((await inbox.findOne({ _id: lateStale._id }))?.state, 'REJECTED_STALE');
      assert.equal(await events.countDocuments({
        jobId: valid.jobId,
        type: 'JobTerminalized',
      }), 1);
      const terminalEvent = await events.findOne({
        jobId: valid.jobId,
        type: 'JobTerminalized',
      });
      assert.equal(terminalEvent?.payload.attemptId, valid.attemptId);
      assert.equal(terminalEvent?.payload.resultId, valid.result._id);
    });

    await check('pause drains only captured finish-current and preserves a lower gap', async () => {
      const running = await runningOptIn('watermark_pause_intersection');
      const deferredGap = await appendSyntheticStale(running, 'pause-gap');
      const producer = { status: 'ok' as const, data: { captured: true } };
      const marker = await markAttemptPayloadReady(client, db, {
        attemptId: running.attemptId,
        leaseOwner: running.worker,
        attemptFence: running.attemptFence,
        producer,
      });
      assert.equal(marker.ready, true);
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'watermark_pause_intersection_cmd',
        jobId: running.jobId,
      });
      const paused = await jobs.findOne({ _id: running.jobId });
      assert.equal(paused?.controlState, 'PAUSE_REQUESTED');
      const submitted = await submitAttemptResult(client, db, {
        attemptId: running.attemptId,
        leaseOwner: running.worker,
        attemptFence: running.attemptFence,
        producer,
        businessPayloadReadyGeneration: marker.generation,
      });
      assert.equal(submitted.committed, true);
      const capturedItem = await inbox.findOne({
        jobId: running.jobId,
        attemptId: running.attemptId,
      });
      assert.ok(capturedItem);
      assert.equal(capturedItem.inboxSequence, 2);
      assert.equal(
        capturedItem.finishCurrentPauseGenerationAtA,
        paused?.pauseGeneration,
      );

      const captured = await runResultDrainActivation(client, db, running.jobId);
      assert.equal(captured?.outcome, null);
      assert.equal(captured?.appliedInboxWatermark, 2);
      assert.equal(captured?.resolvedInboxWatermark, 0);
      assert.equal(captured?.successorWakeId, null);
      assert.equal((await inbox.findOne({ _id: deferredGap._id }))?.state, 'RECEIVED');
      assert.equal((await inbox.findOne({ _id: capturedItem._id }))?.state, 'APPLIED');
      assert.equal((await tasks.findOne({ _id: running.taskId }))?.phase, 'SUCCEEDED');
      assert.equal((await jobs.findOne({ _id: running.jobId }))?.terminalOutcome, null);

      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'watermark_pause_intersection_resume',
        jobId: running.jobId,
      });
      await drainLane(client, db);
      const terminal = await jobs.findOne({ _id: running.jobId });
      assert.equal(terminal?.terminalOutcome, 'COMPLETED');
      assert.equal(terminal?.inboxHighWatermark, 2);
      assert.equal(terminal?.appliedInboxWatermark, 2);
      assert.equal(terminal?.resolvedInboxWatermark, 2);
      assert.equal((await inbox.findOne({
        _id: deferredGap._id,
      }))?.state, 'REJECTED_STALE');
    });

    await check('unsupported quarantines while retryable blocks terminal without hot-loop', async () => {
      const running = await runningOptIn('watermark_deferred_gaps');
      const unsupported = await appendSyntheticStale(running, 'unsupported');
      await inbox.updateOne(
        { _id: unsupported._id },
        {
          $set: {
            planVersion: 1,
            consumerVersion: 2,
          },
        },
      );
      const retryable = await appendSyntheticStale(running, 'retryable');
      await inbox.updateOne(
        { _id: retryable._id },
        {
          $set: {
            planVersion: 1,
            state: 'FAILED_RETRYABLE',
          },
        },
      );
      const valid = await ingress(running);
      assert.equal(valid.inbox.inboxSequence, 3);
      await outbox.updateMany(
        {
          aggregate: valid.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
        },
        { $set: { state: 'PUBLISHED' } },
      );

      const applied = await runResultDrainActivation(client, db, valid.jobId);
      assert.equal(applied?.outcome, null);
      assert.equal(applied?.appliedInboxWatermark, 3);
      assert.equal(applied?.resolvedInboxWatermark, 1);
      assert.equal(applied?.successorWakeId, null);
      assert.equal(
        (await inbox.findOne({ _id: unsupported._id }))?.state,
        'QUARANTINED_UNSUPPORTED',
      );
      assert.equal((await inbox.findOne({ _id: retryable._id }))?.state, 'FAILED_RETRYABLE');
      const reconciling = await jobs.findOne({ _id: valid.jobId });
      assert.equal(reconciling?.terminalOutcome, null);
      assert.equal(reconciling?.phase, 'RECONCILING');
      assert.equal(await outbox.countDocuments({
        aggregate: valid.jobId,
        type: 'OperatorAlertRequested',
      }), 1);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: valid.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'watermark_deferred_gaps_cleanup',
        jobId: valid.jobId,
      });
      const cancelled = await jobs.findOne({ _id: valid.jobId });
      assert.equal(
        cancelled?.terminalOutcome,
        null,
        'cancel cannot bypass a durable poison/quarantine obligation',
      );
      assert.equal(cancelled?.pendingTerminalOutcome, 'CANCELLED');
      assert.equal(cancelled?.phase, 'RECONCILING');
      assert.equal(cancelled?.terminalBarrierMode, 'BLOCKED_UNSUPPORTED');
      assert.equal(
        cancelled?.terminalBarrierBlocker,
        'unresolved_inbox_obligation',
      );
      assert.equal(cancelled?.resolvedInboxWatermark, 3);
      assert.equal(await outbox.countDocuments({
        aggregate: valid.jobId,
        type: 'JobTerminal',
      }), 0);
    });

    await check('reconciler restores one eligible demand and never hot-loops a pause gap', async () => {
      const eligible = await ingress(await runningOptIn('watermark_reconcile'));
      await outbox.updateMany(
        {
          aggregate: eligible.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
        },
        { $set: { state: 'PUBLISHED' } },
      );
      assert.equal(await reWakeStuckJobs(client, db), 1);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      const eligibleJob = await jobs.findOne({ _id: eligible.jobId });
      assert.ok(eligibleJob);
      assert.equal(await outbox.countDocuments({
        aggregate: eligible.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.activationDispatchGeneration':
          eligibleJob.activationDispatchGeneration,
      }), 1);
      assert.equal(await drainLane(client, db), 1);
      assert.equal((await jobs.findOne({
        _id: eligible.jobId,
      }))?.terminalOutcome, 'COMPLETED');

      const deferred = await ingress(await runningOptIn('watermark_pause_gap'));
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'watermark_pause_gap_cmd',
        jobId: deferred.jobId,
      });
      await outbox.updateMany(
        {
          aggregate: deferred.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
        },
        { $set: { state: 'PUBLISHED' } },
      );
      const paused = await jobs.findOne({ _id: deferred.jobId });
      assert.equal(paused?.controlState, 'PAUSE_REQUESTED');
      assert.equal(paused?.inboxHighWatermark, 1);
      assert.equal(paused?.appliedInboxWatermark, 0);
      assert.equal(paused?.resolvedInboxWatermark, 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: deferred.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
      assert.equal(await activations.countDocuments({
        jobId: deferred.jobId,
        activeSlot: true,
      }), 0);

      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'watermark_pause_gap_resume',
        jobId: deferred.jobId,
      });
      assert.equal(await drainLane(client, db), 1);
      const resumed = await jobs.findOne({ _id: deferred.jobId });
      assert.equal(resumed?.terminalOutcome, 'COMPLETED');
      assert.equal(resumed?.inboxHighWatermark, 1);
      assert.equal(resumed?.appliedInboxWatermark, 1);
      assert.equal(resumed?.resolvedInboxWatermark, 1);
    });

    await check('reaper preserves a multi-item inbox and restores one current-generation handoff', async () => {
      const running = await runningOptIn('watermark_reaper_batch');
      const stalePrefix = await appendSyntheticStale(running, 'reaper-prefix');
      const valid = await ingress(running);
      const active = await runningDrain(valid.jobId, 1, 'lane:reaper-batch');
      assert.deepEqual(active.activation.batchInboxItemIds, [stalePrefix._id]);

      const lateTail = await appendSyntheticStale(running, 'reaper-tail');
      const beforeReap = await jobs.findOne({ _id: valid.jobId });
      assert.equal(beforeReap?.inboxHighWatermark, 3);
      assert.equal(beforeReap?.appliedInboxWatermark, 0);
      assert.equal(beforeReap?.resolvedInboxWatermark, 0);
      await activations.updateOne(
        { _id: active.activation._id },
        {
          $set: {
            leaseExpiresAt: new Date(Date.now() - 50),
            workDeadlineAt: new Date(Date.now() - 50),
            hardDeadlineAt: new Date(Date.now() + 5_000),
          },
        },
      );

      assert.equal(await reapExpiredActivations(client, db), 1);
      assert.equal((await activations.findOne({
        _id: active.activation._id,
      }))?.lifecycle, 'ABANDONED');
      assert.equal(await commitDrain(active), null);
      const recovered = await jobs.findOne({ _id: valid.jobId });
      assert.ok(recovered);
      assert.equal(recovered.inboxHighWatermark, 3);
      assert.equal(recovered.appliedInboxWatermark, 0);
      assert.equal(recovered.resolvedInboxWatermark, 0);
      assert.equal(await outbox.countDocuments({
        _id: `obx_result_drain_recovery:${active.activation._id}`,
        aggregate: valid.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.activationDispatchGeneration':
          recovered.activationDispatchGeneration,
      }), 1);

      await drainLane(client, db);
      const terminal = await jobs.findOne({ _id: valid.jobId });
      assert.equal(terminal?.terminalOutcome, 'COMPLETED');
      assert.equal(terminal?.inboxHighWatermark, 3);
      assert.equal(terminal?.appliedInboxWatermark, 2);
      assert.equal(terminal?.resolvedInboxWatermark, 3);
      assert.equal((await inbox.findOne({ _id: stalePrefix._id }))?.state, 'REJECTED_STALE');
      assert.equal((await inbox.findOne({ _id: valid.inbox._id }))?.state, 'APPLIED');
      assert.equal((await inbox.findOne({ _id: lateTail._id }))?.state, 'REJECTED_STALE');
      assert.equal(await outbox.countDocuments({
        _id: `obx_result_drain_recovery:${active.activation._id}`,
      }), 1);
    });

    await check('legacy terminal reducer is fenced from typed AWAITING_RESULTS in its transaction', async () => {
      const valid = await ingress(await runningOptIn('watermark_terminal_barrier'));
      const active = await runningDrain(valid.jobId, 1, 'lane:terminal-barrier');
      const tail = await appendSyntheticStale(valid, 'terminal-barrier-tail');
      const first = await commitDrain(active);
      assert.equal(first?.outcome, null);
      assert.equal((await tasks.findOne({ _id: valid.taskId }))?.phase, 'SUCCEEDED');

      // Model the exact post-precheck race boundary: the typed inbox is fully
      // resolved, but B has not performed its terminal transition. The legacy
      // reducer must remain a no-op even though every task is terminal.
      const resolvedAt = new Date();
      await inbox.updateOne(
        { _id: tail._id, state: 'RECEIVED' },
        {
          $set: {
            state: 'REJECTED_STALE',
            resolvedByActivationId: 'test:terminal-barrier',
            resolutionCode: 'stale_task_result',
            resolvedAt,
          },
        },
      );
      await jobs.updateOne(
        { _id: valid.jobId, terminalOutcome: null },
        {
          $set: {
            resolvedInboxWatermark: 2,
            updatedAt: resolvedAt,
          },
          $inc: { stateVersion: 1 },
        },
      );
      await outbox.updateMany(
        {
          aggregate: valid.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
        },
        { $set: { state: 'PUBLISHED' } },
      );

      assert.equal(await advanceJobFromTasks(client, db, valid.jobId), null);
      assert.equal((await jobs.findOne({ _id: valid.jobId }))?.terminalOutcome, null);
      assert.equal(await events.countDocuments({
        jobId: valid.jobId,
        type: 'JobTerminalized',
      }), 0);
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'watermark_terminal_barrier_cleanup',
        jobId: valid.jobId,
      });
    });

    await check('cancel resolves the supported inbox through high and fences the batch', async () => {
      const running = await runningOptIn('watermark_cancel');
      await appendSyntheticStale(running, 'cancel-1');
      const valid = await ingress(running);
      const active = await runningDrain(valid.jobId, 1, 'lane:cancel-watermark');

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'watermark_cancel_cmd',
        jobId: valid.jobId,
      });
      const cancelled = await jobs.findOne({ _id: valid.jobId });
      assert.equal(cancelled?.terminalOutcome, 'CANCELLED');
      assert.equal(cancelled?.inboxHighWatermark, 2);
      assert.equal(cancelled?.appliedInboxWatermark, 0);
      assert.equal(cancelled?.resolvedInboxWatermark, 2);
      assert.equal(await inbox.countDocuments({
        jobId: valid.jobId,
        state: 'REJECTED_STALE',
      }), 2);
      assert.equal((await activations.findOne({
        _id: active.activation._id,
      }))?.lifecycle, 'ABANDONED');
      assert.equal(await commitDrain(active), null);
      assert.equal(await outbox.countDocuments({
        aggregate: valid.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
    });

    await check('PR-32 bootstrap resumes active rows and preserves committed replay idempotently', async () => {
      const now = new Date();
      const future = new Date(now.getTime() + 60_000);
      const activeJobId = 'job_legacy_watermark_active';
      const activeTaskId = 'task_legacy_watermark_active';
      const activeAttemptId = 'attempt_legacy_watermark_active';
      const activeResultId = 'result_legacy_watermark_active';
      const activeInboxId = `${activeJobId}:${activeResultId}`;
      const activeActivationId = 'activation_legacy_watermark_active';
      const committedJobId = 'job_legacy_watermark_committed';
      const committedTaskId = 'task_legacy_watermark_committed';
      const committedAttemptId = 'attempt_legacy_watermark_committed';
      const committedResultId = 'result_legacy_watermark_committed';
      const committedInboxId = `${committedJobId}:${committedResultId}`;
      const committedActivationId = 'activation_legacy_watermark_committed';
      const rawJobs = db.collection<RawStringIdDoc>(COLLECTIONS.jobs);
      const rawInbox = db.collection<RawStringIdDoc>(COLLECTIONS.inbox);
      const rawActivations =
        db.collection<RawStringIdDoc>(COLLECTIONS.activations);

      const resumable = await ingress(
        await runningOptIn('watermark_migration_resume'),
      );
      const resumableRun = await runningDrain(
        resumable.jobId,
        1,
        'lane:migration-resume',
      );
      await rawJobs.updateOne(
        { _id: resumable.jobId },
        {
          $unset: {
            inboxHighWatermark: '',
            appliedInboxWatermark: '',
            resolvedInboxWatermark: '',
            inboxSchemaVersion: '',
          },
        },
      );
      await rawInbox.updateOne(
        { _id: resumable.inbox._id },
        {
          $unset: {
            inboxSequence: '',
            consumerVersion: '',
            resolvedByActivationId: '',
            resolutionCode: '',
            redriveAttempt: '',
            lastRedriveRequestId: '',
            operatorAlertId: '',
            retryTimerGeneration: '',
            retryAttempt: '',
            retryTimerId: '',
            nextEligibleAt: '',
            retryReasonCode: '',
          },
        },
      );
      await rawActivations.updateOne(
        { _id: resumableRun.activation._id },
        {
          $set: {
            reducerPayload: {
              kind: 'APPLY_ATTEMPT_RESULT_V1',
              jobId: resumable.jobId,
              taskId: resumable.taskId,
              attemptId: resumable.attemptId,
              resultId: resumable.result._id,
              inboxItemId: resumable.inbox._id,
              planVersion: resumable.inbox.planVersion,
              attemptFence: resumable.inbox.attemptFence,
              payloadHash: resumable.inbox.payloadHash,
              resultStatus: 'ok',
              finishCurrentPauseGenerationAtA: null,
            },
          },
          $unset: {
            batchThroughWatermark: '',
            inboxHighWatermarkAtClaim: '',
            appliedInboxWatermarkAtClaim: '',
            resolvedInboxWatermarkAtClaim: '',
            committedAppliedInboxWatermark: '',
            committedResolvedInboxWatermark: '',
            successorWakeId: '',
          },
        },
      );

      await rawJobs.insertMany([
        {
          _id: activeJobId,
          resourceId: RESOURCE_ID,
          conversationId: CONVERSATION_ID,
          phase: 'AWAITING_RESULTS',
          controlState: 'NONE',
          terminalOutcome: null,
          stateVersion: 7,
          planVersion: 1,
          pauseGeneration: 0,
          activationDispatchGeneration: 0,
          jobStopGeneration: 0,
          activationFence: 1,
          activeActivationId,
          instructions: [],
          parentJobId: null,
          jobRelationMode: null,
          goal: 'legacy active result drain',
          createdAt: now,
          updatedAt: now,
        },
        {
          _id: committedJobId,
          resourceId: RESOURCE_ID,
          conversationId: CONVERSATION_ID,
          phase: 'TERMINAL',
          controlState: 'NONE',
          terminalOutcome: 'COMPLETED',
          stateVersion: 8,
          planVersion: 1,
          pauseGeneration: 0,
          activationDispatchGeneration: 1,
          jobStopGeneration: 1,
          activationFence: 1,
          activeActivationId: null,
          instructions: [],
          parentJobId: null,
          jobRelationMode: null,
          goal: 'legacy committed result drain',
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await rawInbox.insertMany([
        {
          _id: activeInboxId,
          jobId: activeJobId,
          taskId: activeTaskId,
          attemptId: activeAttemptId,
          resultId: activeResultId,
          kind: 'ATTEMPT_RESULT_V1',
          state: 'RECEIVED',
          planVersion: 1,
          attemptFence: 1,
          payloadHash: 'legacy-active-payload',
          finishCurrentPauseGenerationAtA: null,
          appliedByActivationId: null,
          resolvedAt: null,
          createdAt: now,
        },
        {
          _id: committedInboxId,
          jobId: committedJobId,
          taskId: committedTaskId,
          attemptId: committedAttemptId,
          resultId: committedResultId,
          kind: 'ATTEMPT_RESULT_V1',
          state: 'APPLIED',
          planVersion: 1,
          attemptFence: 1,
          payloadHash: 'legacy-committed-payload',
          finishCurrentPauseGenerationAtA: null,
          appliedByActivationId: committedActivationId,
          resolvedAt: now,
          createdAt: now,
        },
      ]);
      await rawActivations.insertMany([
        {
          _id: activeActivationId,
          sourceWakeId: null,
          jobId: activeJobId,
          kind: 'RESULT_DRAIN',
          lifecycle: 'RUNNING',
          activeSlot: true,
          activationDispatchGenerationAtClaim: 0,
          planVersionAtClaim: 1,
          jobStopGenerationAtClaim: 0,
          leaseOwner: 'legacy-lane',
          leaseExpiresAt: future,
          activationFence: 1,
          operationStartedAt: now,
          businessOperationCutoffAt: future,
          workDeadlineAt: future,
          hardDeadlineAt: future,
          purposeAttemptIds: [activeAttemptId],
          businessPayloadReadyGeneration: 1,
          businessPayloadReadyHash: 'legacy-active-ready',
          businessPayloadReadyAt: now,
          reducerPayload: {
            kind: 'APPLY_ATTEMPT_RESULT_V1',
            jobId: activeJobId,
            taskId: activeTaskId,
            attemptId: activeAttemptId,
            resultId: activeResultId,
            inboxItemId: activeInboxId,
            planVersion: 1,
            attemptFence: 1,
            payloadHash: 'legacy-active-payload',
            resultStatus: 'ok',
            finishCurrentPauseGenerationAtA: null,
          },
          committedPayloadHash: null,
          committedAt: null,
          outcome: null,
          reasonCode: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          _id: committedActivationId,
          sourceWakeId: null,
          jobId: committedJobId,
          kind: 'RESULT_DRAIN',
          lifecycle: 'COMMITTED',
          activeSlot: false,
          activationDispatchGenerationAtClaim: 0,
          planVersionAtClaim: 1,
          jobStopGenerationAtClaim: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          activationFence: 1,
          operationStartedAt: now,
          businessOperationCutoffAt: future,
          workDeadlineAt: future,
          hardDeadlineAt: future,
          purposeAttemptIds: [committedAttemptId],
          batchInboxItemIds: [committedInboxId],
          businessPayloadReadyGeneration: 1,
          businessPayloadReadyHash: 'legacy-committed-ready',
          businessPayloadReadyAt: now,
          reducerPayload: {
            kind: 'APPLY_ATTEMPT_RESULT_V1',
            jobId: committedJobId,
            taskId: committedTaskId,
            attemptId: committedAttemptId,
            resultId: committedResultId,
            inboxItemId: committedInboxId,
            planVersion: 1,
            attemptFence: 1,
            payloadHash: 'legacy-committed-payload',
            resultStatus: 'ok',
            finishCurrentPauseGenerationAtA: null,
          },
          committedPayloadHash: 'legacy-pr32-hash',
          committedAt: now,
          outcome: 'COMPLETED',
          reasonCode: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      await backfillActivationAuthoritySchema(db);
      const resumableJob = await jobs.findOne({ _id: resumable.jobId });
      const resumableItem = await inbox.findOne({ _id: resumable.inbox._id });
      const resumableActivation = await activations.findOne({
        _id: resumableRun.activation._id,
      });
      assert.equal(resumableJob?.inboxSchemaVersion, 3);
      assert.equal(resumableJob?.inboxHighWatermark, 1);
      assert.equal(resumableJob?.appliedInboxWatermark, 0);
      assert.equal(resumableJob?.resolvedInboxWatermark, 0);
      assert.equal(resumableItem?.inboxSequence, 1);
      assert.equal(resumableItem?.consumerVersion, 1);
      assert.equal(resumableItem?.retryTimerGeneration, 0);
      assert.equal(resumableItem?.retryAttempt, 0);
      assert.equal(resumableItem?.retryTimerId, null);
      assert.equal(resumableItem?.nextEligibleAt, null);
      assert.equal(resumableItem?.retryReasonCode, null);
      assert.deepEqual(
        resumableActivation?.batchInboxItemIds,
        [resumable.inbox._id],
      );
      assert.equal(resumableActivation?.batchThroughWatermark, 1);
      assert.equal(
        resumableActivation?.reducerPayload?.kind,
        'DRAIN_RESULT_INBOX_BATCH_V1',
      );
      const activeJob = await jobs.findOne({ _id: activeJobId });
      const activeItem = await inbox.findOne({ _id: activeInboxId });
      const activeActivation = await activations.findOne({
        _id: activeActivationId,
      });
      assert.equal(activeJob?.inboxSchemaVersion, 3);
      assert.equal(activeJob?.inboxHighWatermark, 1);
      assert.equal(activeJob?.appliedInboxWatermark, 0);
      assert.equal(activeJob?.resolvedInboxWatermark, 0);
      assert.equal(activeItem?.inboxSequence, 1);
      assert.equal(activeItem?.consumerVersion, 1);
      assert.equal(activeItem?.resolvedByActivationId, null);
      assert.equal(activeItem?.retryTimerGeneration, 0);
      assert.equal(activeItem?.retryAttempt, 0);
      assert.equal(activeItem?.retryTimerId, null);
      assert.equal(activeItem?.nextEligibleAt, null);
      assert.equal(activeItem?.retryReasonCode, null);
      assert.deepEqual(activeActivation?.batchInboxItemIds, [activeInboxId]);
      assert.equal(activeActivation?.batchThroughWatermark, 1);
      assert.equal(activeActivation?.inboxHighWatermarkAtClaim, 1);
      assert.equal(activeActivation?.committedAppliedInboxWatermark, null);
      assert.equal(
        activeActivation?.reducerPayload?.kind,
        'DRAIN_RESULT_INBOX_BATCH_V1',
      );

      const committedJob = await jobs.findOne({ _id: committedJobId });
      const committedItem = await inbox.findOne({ _id: committedInboxId });
      const committedActivation = await activations.findOne({
        _id: committedActivationId,
      });
      assert.equal(committedJob?.inboxSchemaVersion, 3);
      assert.equal(committedJob?.inboxHighWatermark, 1);
      assert.equal(committedJob?.appliedInboxWatermark, 1);
      assert.equal(committedJob?.resolvedInboxWatermark, 1);
      assert.equal(committedItem?.inboxSequence, 1);
      assert.equal(committedItem?.consumerVersion, 1);
      assert.equal(committedItem?.retryTimerGeneration, 0);
      assert.equal(committedItem?.retryAttempt, 0);
      assert.equal(committedItem?.retryTimerId, null);
      assert.equal(committedItem?.nextEligibleAt, null);
      assert.equal(committedItem?.retryReasonCode, null);
      assert.equal(
        committedItem?.resolvedByActivationId,
        committedActivationId,
      );
      assert.equal(committedItem?.resolutionCode, 'applied_result');
      assert.equal(committedActivation?.batchThroughWatermark, 1);
      assert.equal(committedActivation?.committedAppliedInboxWatermark, 1);
      assert.equal(committedActivation?.committedResolvedInboxWatermark, 1);
      assert.equal(
        committedActivation?.reducerPayload?.kind,
        'DRAIN_RESULT_INBOX_BATCH_V1',
      );

      const beforeSecondPass = await Promise.all([
        jobs.findOne({ _id: resumable.jobId }),
        inbox.findOne({ _id: resumable.inbox._id }),
        activations.findOne({ _id: resumableRun.activation._id }),
        jobs.findOne({ _id: activeJobId }),
        inbox.findOne({ _id: activeInboxId }),
        activations.findOne({ _id: activeActivationId }),
        jobs.findOne({ _id: committedJobId }),
        inbox.findOne({ _id: committedInboxId }),
        activations.findOne({ _id: committedActivationId }),
      ]);
      await backfillActivationAuthoritySchema(db);
      const afterSecondPass = await Promise.all([
        jobs.findOne({ _id: resumable.jobId }),
        inbox.findOne({ _id: resumable.inbox._id }),
        activations.findOne({ _id: resumableRun.activation._id }),
        jobs.findOne({ _id: activeJobId }),
        inbox.findOne({ _id: activeInboxId }),
        activations.findOne({ _id: activeActivationId }),
        jobs.findOne({ _id: committedJobId }),
        inbox.findOne({ _id: committedInboxId }),
        activations.findOne({ _id: committedActivationId }),
      ]);
      assert.deepEqual(afterSecondPass, beforeSecondPass);

      const resumed = await commitDrain(resumableRun);
      assert.equal(resumed?.deduped, false);
      assert.equal(resumed?.outcome, 'COMPLETED');
      assert.equal(resumed?.appliedInboxWatermark, 1);
      assert.equal(resumed?.resolvedInboxWatermark, 1);
      assert.equal((await jobs.findOne({
        _id: resumable.jobId,
      }))?.terminalOutcome, 'COMPLETED');

      const replay = await commitResultDrainActivation(client, db, {
        activationId: committedActivationId,
        leaseOwner: 'legacy-replay',
        activationFence: 1,
      });
      assert.equal(replay?.deduped, true);
      assert.equal(replay?.outcome, 'COMPLETED');
      assert.equal(replay?.appliedInboxWatermark, 1);
      assert.equal(replay?.resolvedInboxWatermark, 1);
      assert.deepEqual(replay?.batchInboxItemIds, [committedInboxId]);
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-watermark-handoff — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-watermark-handoff — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
