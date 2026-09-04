#!/usr/bin/env tsx
/**
 * e2e:orchestration-inbox-retry — PR-35 bounded FAILED_RETRYABLE timers.
 *
 * Proves against a real replica set that:
 *  - a transiently missing immutable result is scheduled from store time,
 *    remains quiet before eligibility, and is promoted exactly once;
 *  - three automatic promotions are bounded and the fourth failed observation
 *    becomes a durable operator-visible quarantine;
 *  - manual redrive atomically cancels its exact scoped timer and cannot beat a
 *    later/earlier job cancellation;
 *  - the legacy generic timer reducer never consumes a typed inbox timer.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  armTimer,
  cancelJob,
  claimAttempt,
  claimResultDrainActivation,
  COLLECTIONS,
  commitResultDrainActivation,
  dispatchAttempt,
  drainLane,
  ensureOrchestrationIndexes,
  fireDueTimers,
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
  type RetryTransientInboxDecisionV1,
  type TaskDoc,
  type TimerDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_inbox_retry';
const CONVERSATION_ID = 'conv_inbox_retry';

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

interface RetryObservation {
  run: RunningDrain;
  committedActivation: LaneActivationDoc;
  decision: RetryTransientInboxDecisionV1;
  item: JobInboxDoc;
  timer: TimerDoc;
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
  console.log('e2e:orchestration-inbox-retry');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_inbox_retry_e2e_${Date.now()}`,
    section: 'e2e:orchestration-inbox-retry',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  const inbox = db.collection<JobInboxDoc>(COLLECTIONS.inbox);
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const timers = db.collection<TimerDoc>(COLLECTIONS.timers);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);

  async function runningOptIn(name: string): Promise<RunningFixture> {
    const jobId = (await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      commandId: name,
      goal: `inbox-retry:${name}`,
      payload: { op: name },
    })).jobId;
    const planned = await planJob(client, db, jobId);
    assert.ok(planned);
    assert.equal(
      (await tasks.findOne({ _id: planned.taskId }))?.resultApplyMode,
      'RESULT_DRAIN_V1',
    );
    await publishLaneWakes(jobId);

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
    return { ...fixture, result, inbox: item };
  }

  async function removeResult(fixture: IngressFixture): Promise<ResultDoc> {
    const removed = await results.findOneAndDelete({ _id: fixture.result._id });
    assert.ok(removed);
    assert.equal(
      (await attempts.findOne({ _id: fixture.attemptId }))?.lifecycle,
      'FINISHED',
      'only the immutable result is hidden; the committed attempt remains',
    );
    return removed;
  }

  async function publishLaneWakes(jobId: string): Promise<void> {
    await outbox.updateMany(
      {
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      },
      { $set: { state: 'PUBLISHED' } },
    );
  }

  async function runningDrain(jobId: string, owner: string): Promise<RunningDrain> {
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

  async function commitDrain(run: RunningDrain) {
    return commitResultDrainActivation(client, db, {
      activationId: run.activation._id,
      leaseOwner: run.owner,
      activationFence: run.activationFence,
    });
  }

  function retryDecisionFrom(
    activation: LaneActivationDoc,
  ): RetryTransientInboxDecisionV1 {
    const payload = activation.reducerPayload as {
      decisions?: Array<Record<string, unknown>>;
    } | null;
    assert.ok(payload);
    assert.ok(Array.isArray(payload.decisions));
    assert.equal(payload.decisions.length, 1);
    const decision = payload.decisions[0];
    assert.equal(decision?.kind, 'RETRY_TRANSIENT_INBOX_V1');
    return decision as RetryTransientInboxDecisionV1;
  }

  async function observeMissingResult(
    fixture: IngressFixture,
    label: string,
    expectedRetryAttempt: number,
  ): Promise<RetryObservation> {
    await publishLaneWakes(fixture.jobId);
    const run = await runningDrain(
      fixture.jobId,
      `lane:inbox-retry:${label}`,
    );
    const committed = await commitDrain(run);
    assert.ok(committed);
    assert.equal(committed.deduped, false);
    assert.equal(committed.outcome, null);
    assert.equal(committed.successorWakeId, null);
    assert.equal(committed.appliedInboxWatermark, 0);

    const committedActivation = await activations.findOne({
      _id: run.activation._id,
    });
    assert.ok(committedActivation);
    assert.ok(committedActivation.committedAt);
    const decision = retryDecisionFrom(committedActivation);
    assert.equal(decision.retryReasonCode, 'result_missing');
    assert.equal(decision.retryAttempt, expectedRetryAttempt);
    assert.equal(decision.redriveAttempt, expectedRetryAttempt);
    assert.equal(decision.retryTimerGeneration, expectedRetryAttempt);

    const item = await inbox.findOne({ _id: fixture.inbox._id });
    assert.ok(item);
    assert.equal(item.state, 'FAILED_RETRYABLE');
    assert.equal(item.retryAttempt, expectedRetryAttempt);
    assert.equal(
      item.retryTimerGeneration,
      decision.retryTimerGeneration + 1,
    );
    assert.ok(item.retryTimerId);
    assert.ok(item.nextEligibleAt);
    assert.equal(item.retryReasonCode, 'result_missing');
    assert.equal(item.resolvedAt, null);

    const timer = await timers.findOne({ _id: item.retryTimerId });
    assert.ok(timer);
    assert.equal(timer.kind, 'inbox_result_retry');
    assert.equal(timer.jobId, fixture.jobId);
    assert.equal(timer.entityId, fixture.inbox._id);
    assert.equal(timer.generation, item.retryTimerGeneration);
    assert.equal(timer.sourceRedriveAttempt, item.redriveAttempt);
    assert.equal(timer.state, 'PENDING');
    assert.equal(timer.firedAt, null);
    assert.equal(timer.wakeId, null);
    assert.equal(timer.fireAt.getTime(), item.nextEligibleAt.getTime());
    assert.equal(
      timer.fireAt.getTime(),
      committedActivation.committedAt.getTime() + decision.retryDelayMs,
      'nextEligibleAt derives from the store-stamped B commit',
    );
    assert.equal(
      timer.createdAt.getTime(),
      committedActivation.committedAt.getTime(),
    );
    assert.equal(await outbox.countDocuments({
      aggregate: fixture.jobId,
      type: 'LaneWakeRequested',
      state: 'PENDING',
    }), 0, 'a delayed retry owns demand without an immediate wake');
    return { run, committedActivation, decision, item, timer };
  }

  async function forceRetryTimerDue(itemId: string): Promise<{
    timerId: string;
    generation: number;
    dueAt: Date;
  }> {
    const { value } = await runTxn(client, async (session) => {
      const item = await inbox.findOne(
        {
          _id: itemId,
          state: 'FAILED_RETRYABLE',
          retryTimerId: { $type: 'string' },
          nextEligibleAt: { $type: 'date' },
        },
        { session },
      );
      assert.ok(item?.retryTimerId);
      const timer = await timers.findOne(
        {
          _id: item.retryTimerId,
          kind: 'inbox_result_retry',
          state: 'PENDING',
          generation: item.retryTimerGeneration,
          sourceRedriveAttempt: item.redriveAttempt,
        },
        { session },
      );
      assert.ok(timer);
      const dueAt = new Date(Date.now() - 5_000);
      const timerCas = await timers.updateOne(
        {
          _id: timer._id,
          kind: 'inbox_result_retry',
          state: 'PENDING',
          generation: timer.generation,
          fireAt: timer.fireAt,
        },
        { $set: { fireAt: dueAt } },
        { session },
      );
      assert.equal(timerCas.modifiedCount, 1);
      const itemCas = await inbox.updateOne(
        {
          _id: item._id,
          state: 'FAILED_RETRYABLE',
          retryTimerId: timer._id,
          retryTimerGeneration: timer.generation,
          nextEligibleAt: timer.fireAt,
        },
        { $set: { nextEligibleAt: dueAt } },
        { session },
      );
      assert.equal(itemCas.modifiedCount, 1);
      return {
        timerId: timer._id,
        generation: timer.generation,
        dueAt,
      };
    });
    return value;
  }

  async function moveRetryTimerToFuture(
    itemId: string,
  ): Promise<{ timerId: string; futureAt: Date }> {
    const { value } = await runTxn(client, async (session) => {
      const item = await inbox.findOne(
        {
          _id: itemId,
          state: 'FAILED_RETRYABLE',
          retryTimerId: { $type: 'string' },
        },
        { session },
      );
      assert.ok(item?.retryTimerId);
      const timer = await timers.findOne(
        {
          _id: item.retryTimerId,
          kind: 'inbox_result_retry',
          state: 'PENDING',
          generation: item.retryTimerGeneration,
        },
        { session },
      );
      assert.ok(timer);
      const futureAt = new Date(Date.now() + 60_000);
      assert.equal((await timers.updateOne(
        {
          _id: timer._id,
          state: 'PENDING',
          fireAt: timer.fireAt,
        },
        { $set: { fireAt: futureAt } },
        { session },
      )).modifiedCount, 1);
      assert.equal((await inbox.updateOne(
        {
          _id: item._id,
          state: 'FAILED_RETRYABLE',
          retryTimerId: timer._id,
          nextEligibleAt: timer.fireAt,
        },
        { $set: { nextEligibleAt: futureAt } },
        { session },
      )).modifiedCount, 1);
      return { timerId: timer._id, futureAt };
    });
    return value;
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('missing Result schedules quietly, fires once, then repaired authority applies', async () => {
      const fixture = await ingress(await runningOptIn('missing_then_repair'));
      const savedResult = await removeResult(fixture);
      const observed = await observeMissingResult(fixture, 'missing-first', 0);
      assert.equal(observed.item.retryTimerGeneration, 1);
      assert.equal(observed.item.retryAttempt, 0);
      assert.equal(observed.item.redriveAttempt, 0);
      assert.equal((await jobs.findOne({ _id: fixture.jobId }))?.phase, 'RECONCILING');
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);
      assert.equal(await reWakeStuckJobs(client, db), 0);

      const due = await forceRetryTimerDue(fixture.inbox._id);
      assert.equal(due.timerId, observed.timer._id);
      assert.equal(await fireDueTimers(client, db), 1);
      assert.equal(await fireDueTimers(client, db), 0);

      const [promoted, firedTimer, promotedJob] = await Promise.all([
        inbox.findOne({ _id: fixture.inbox._id }),
        timers.findOne({ _id: due.timerId }),
        jobs.findOne({ _id: fixture.jobId }),
      ]);
      assert.equal(promoted?.state, 'PENDING_REDRIVE');
      assert.equal(promoted?.redriveAttempt, 1);
      assert.equal(promoted?.retryAttempt, 1);
      assert.equal(promoted?.retryTimerGeneration, 1);
      assert.equal(promoted?.retryTimerId, null);
      assert.equal(promoted?.nextEligibleAt, null);
      assert.equal(promoted?.retryReasonCode, null);
      assert.equal(firedTimer?.state, 'FIRED');
      assert.ok(firedTimer?.firedAt);
      assert.ok(firedTimer?.wakeId);
      assert.equal(promotedJob?.inboxHighWatermark, 1);
      assert.equal(promotedJob?.appliedInboxWatermark, 0);
      assert.equal(promotedJob?.resolvedInboxWatermark, 0);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxRetryPromoted',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'inbox_retry_timer',
      }), 1);

      await results.insertOne(savedResult);
      assert.equal(await drainLane(client, db), 1);
      const [terminal, applied, task] = await Promise.all([
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
      assert.equal(applied?.retryAttempt, 1);
      assert.equal(task?.phase, 'SUCCEEDED');
      assert.equal(task?.appliedResultId, savedResult._id);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobTerminalized',
      }), 1);
    });

    await check('three automatic promotions exhaust on the fourth B observation', async () => {
      const fixture = await ingress(await runningOptIn('bounded_exhaustion'));
      await removeResult(fixture);

      for (let automatic = 0; automatic < 3; automatic++) {
        const observed = await observeMissingResult(
          fixture,
          `bounded-${automatic + 1}`,
          automatic,
        );
        assert.equal(observed.item.retryTimerGeneration, automatic + 1);
        assert.equal(
          observed.decision.retryDelayMs,
          500 * 2 ** automatic,
        );
        await forceRetryTimerDue(fixture.inbox._id);
        assert.equal(await fireDueTimers(client, db), 1);
        assert.equal(await fireDueTimers(client, db), 0);
        const promoted = await inbox.findOne({ _id: fixture.inbox._id });
        assert.equal(promoted?.state, 'PENDING_REDRIVE');
        assert.equal(promoted?.retryAttempt, automatic + 1);
        assert.equal(promoted?.redriveAttempt, automatic + 1);
        assert.equal(promoted?.retryTimerGeneration, automatic + 1);
        await publishLaneWakes(fixture.jobId);
      }

      const exhaustedRun = await runningDrain(
        fixture.jobId,
        'lane:inbox-retry:exhausted',
      );
      const exhausted = await commitDrain(exhaustedRun);
      assert.ok(exhausted);
      assert.equal(exhausted.deduped, false);
      assert.equal(exhausted.outcome, null);
      assert.equal(exhausted.resolvedInboxWatermark, 1);
      assert.equal(exhausted.successorWakeId, null);

      const exhaustedActivation = await activations.findOne({
        _id: exhaustedRun.activation._id,
      });
      assert.ok(exhaustedActivation);
      const exhaustedPayload = exhaustedActivation.reducerPayload as {
        decisions?: Array<Record<string, unknown>>;
      } | null;
      assert.equal(
        exhaustedPayload?.decisions?.[0]?.kind,
        'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1',
      );
      const [job, item] = await Promise.all([
        jobs.findOne({ _id: fixture.jobId }),
        inbox.findOne({ _id: fixture.inbox._id }),
      ]);
      assert.equal(job?.phase, 'RECONCILING');
      assert.equal(job?.terminalOutcome, null);
      assert.equal(job?.resolvedInboxWatermark, job?.inboxHighWatermark);
      assert.equal(item?.state, 'QUARANTINED_UNSUPPORTED');
      assert.equal(item?.resolutionCode, 'transient_retry_exhausted');
      assert.equal(item?.retryReasonCode, 'result_missing');
      assert.equal(item?.retryAttempt, 3);
      assert.equal(item?.redriveAttempt, 3);
      assert.equal(item?.retryTimerGeneration, 3);
      assert.equal(item?.retryTimerId, null);
      assert.equal(item?.nextEligibleAt, null);
      assert.ok(item?.operatorAlertId);
      assert.ok(item?.resolvedAt);
      assert.equal(await timers.countDocuments({
        jobId: fixture.jobId,
        kind: 'inbox_result_retry',
        state: 'PENDING',
      }), 0);
      assert.equal(await timers.countDocuments({
        jobId: fixture.jobId,
        kind: 'inbox_result_retry',
        state: 'FIRED',
      }), 3);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxRetryScheduled',
      }), 3);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxRetryPromoted',
      }), 3);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxQuarantined',
        'payload.resolutionCode': 'transient_retry_exhausted',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'OperatorAlertRequested',
        'payload.alertType': 'inbox_transient_retry_exhausted',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);

      const versionBeforeReplay = job?.stateVersion;
      const replay = await commitDrain(exhaustedRun);
      assert.equal(replay?.deduped, true);
      assert.equal(replay?.resolvedInboxWatermark, 1);
      assert.equal(
        (await jobs.findOne({ _id: fixture.jobId }))?.stateVersion,
        versionBeforeReplay,
      );
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'OperatorAlertRequested',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxQuarantined',
      }), 1);
      assert.equal(await reWakeStuckJobs(client, db), 0);
    });

    await check('manual FAILED redrive cancels its timer and cancellation remains authoritative', async () => {
      const fixture = await ingress(await runningOptIn('manual_then_cancel'));
      await removeResult(fixture);
      const observed = await observeMissingResult(fixture, 'manual', 0);
      const redriveInput = {
        resourceId: RESOURCE_ID,
        jobId: fixture.jobId,
        inboxItemId: fixture.inbox._id,
        redriveRequestId: 'manual-failed-redrive',
        expectedConsumerVersion: 1,
      };
      const redrive = await requestInboxRedrive(client, db, redriveInput);
      assert.ok(redrive);
      assert.equal(redrive.deduped, false);
      assert.equal(redrive.redriveAttempt, 1);
      const [pending, cancelledTimer] = await Promise.all([
        inbox.findOne({ _id: fixture.inbox._id }),
        timers.findOne({ _id: observed.timer._id }),
      ]);
      assert.equal(pending?.state, 'PENDING_REDRIVE');
      assert.equal(pending?.redriveAttempt, 1);
      assert.equal(pending?.retryAttempt, 0);
      assert.equal(pending?.retryTimerId, null);
      assert.equal(pending?.nextEligibleAt, null);
      assert.equal(cancelledTimer?.state, 'CANCELLED');
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 1);

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'cancel-after-manual-redrive',
        jobId: fixture.jobId,
      });
      const [cancelledJob, cancelledItem] = await Promise.all([
        jobs.findOne({ _id: fixture.jobId }),
        inbox.findOne({ _id: fixture.inbox._id }),
      ]);
      assert.equal(cancelledJob?.terminalOutcome, 'CANCELLED');
      assert.equal(cancelledItem?.state, 'REJECTED_STALE');
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
      const cancelledVersion = cancelledJob?.stateVersion;
      const historical = await requestInboxRedrive(client, db, redriveInput);
      assert.equal(
        historical,
        null,
        'STOP_REQUESTED blocks even historical redrive replay',
      );
      assert.equal(
        (await jobs.findOne({ _id: fixture.jobId }))?.stateVersion,
        cancelledVersion,
      );
      assert.equal(await requestInboxRedrive(client, db, {
        ...redriveInput,
        redriveRequestId: 'manual-after-terminal',
      }), null);

      const cancelFirst = await ingress(await runningOptIn('cancel_before_manual'));
      await removeResult(cancelFirst);
      const cancelFirstObserved = await observeMissingResult(
        cancelFirst,
        'cancel-first',
        0,
      );
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'cancel-before-manual-redrive',
        jobId: cancelFirst.jobId,
      });
      assert.equal(await requestInboxRedrive(client, db, {
        resourceId: RESOURCE_ID,
        jobId: cancelFirst.jobId,
        inboxItemId: cancelFirst.inbox._id,
        redriveRequestId: 'manual-lost-to-cancel',
        expectedConsumerVersion: 1,
      }), null);
      assert.equal(
        (await timers.findOne({ _id: cancelFirstObserved.timer._id }))?.state,
        'CANCELLED',
      );
      assert.equal(
        (await inbox.findOne({ _id: cancelFirst.inbox._id }))?.state,
        'REJECTED_STALE',
      );
    });

    await check('an active-job retry cannot starve a later eligible typed timer', async () => {
      const blocked = await ingress(await runningOptIn('typed_fairness_blocked'));
      await removeResult(blocked);
      const blockedObservation = await observeMissingResult(
        blocked,
        'fairness-blocked',
        0,
      );
      await forceRetryTimerDue(blocked.inbox._id);
      assert.equal((await jobs.updateOne(
        {
          _id: blocked.jobId,
          activeActivationId: null,
          terminalOutcome: null,
        },
        { $set: { activeActivationId: 'activation_test_timer_fairness' } },
      )).modifiedCount, 1);

      const eligible = await ingress(await runningOptIn('typed_fairness_eligible'));
      await removeResult(eligible);
      const eligibleObservation = await observeMissingResult(
        eligible,
        'fairness-eligible',
        0,
      );
      await forceRetryTimerDue(eligible.inbox._id);

      assert.equal(await fireDueTimers(client, db), 1);
      assert.equal(
        (await timers.findOne({ _id: blockedObservation.timer._id }))?.state,
        'PENDING',
      );
      assert.equal(
        (await inbox.findOne({ _id: blocked.inbox._id }))?.state,
        'FAILED_RETRYABLE',
      );
      assert.equal(
        (await timers.findOne({ _id: eligibleObservation.timer._id }))?.state,
        'FIRED',
      );
      assert.equal(
        (await inbox.findOne({ _id: eligible.inbox._id }))?.state,
        'PENDING_REDRIVE',
      );

      assert.equal((await jobs.updateOne(
        {
          _id: blocked.jobId,
          activeActivationId: 'activation_test_timer_fairness',
          terminalOutcome: null,
        },
        { $set: { activeActivationId: null } },
      )).modifiedCount, 1);
      assert.equal(await fireDueTimers(client, db), 1);
      assert.equal(
        (await timers.findOne({ _id: blockedObservation.timer._id }))?.state,
        'FIRED',
      );

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'cancel-typed-fairness-blocked',
        jobId: blocked.jobId,
      });
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'cancel-typed-fairness-eligible',
        jobId: eligible.jobId,
      });
    });

    await check('generic timer firing excludes a future typed inbox timer', async () => {
      const fixture = await ingress(await runningOptIn('generic_isolation'));
      await removeResult(fixture);
      const observed = await observeMissingResult(fixture, 'generic', 0);
      const future = await moveRetryTimerToFuture(fixture.inbox._id);
      const genericTimerId = await armTimer(db, {
        kind: 'job_deadline',
        jobId: fixture.jobId,
        entityId: fixture.jobId,
        fireAt: new Date(Date.now() - 5_000),
      });

      assert.equal(await fireDueTimers(client, db), 1);
      const [typedTimer, genericTimer, item] = await Promise.all([
        timers.findOne({ _id: future.timerId }),
        timers.findOne({ _id: genericTimerId }),
        inbox.findOne({ _id: fixture.inbox._id }),
      ]);
      assert.equal(typedTimer?.state, 'PENDING');
      assert.equal(typedTimer?.fireAt.getTime(), future.futureAt.getTime());
      assert.equal(genericTimer?.state, 'FIRED');
      assert.ok(genericTimer?.firedAt);
      assert.equal(item?.state, 'FAILED_RETRYABLE');
      assert.equal(item?.retryAttempt, 0);
      assert.equal(item?.redriveAttempt, 0);
      assert.equal(item?.retryTimerId, observed.timer._id);
      assert.equal(await events.countDocuments({
        jobId: fixture.jobId,
        type: 'JobInboxRetryPromoted',
      }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'timer:job_deadline',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: fixture.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.reason': 'inbox_retry_timer',
      }), 0);

      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'cancel-generic-isolation',
        jobId: fixture.jobId,
      });
      assert.equal(
        (await timers.findOne({ _id: future.timerId }))?.state,
        'CANCELLED',
      );
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-inbox-retry — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-inbox-retry — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
