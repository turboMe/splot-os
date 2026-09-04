#!/usr/bin/env tsx
/**
 * e2e:orchestration-result-drain — opt-in flat SERIAL A→inbox→typed B slice.
 *
 * Proves against a real replica set that RESULT_DRAIN_V1 separates immutable
 * result ingress (A) from task/job application (B), and that B is owned by one
 * fenced RESULT_DRAIN activation. The slice is deliberately narrow: one root
 * SERIAL task and one inbox item; multi-item watermarks, children/speculation,
 * budgets, effects/artifacts and the general B classifier remain deferred.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  cancelJob,
  claimAttempt,
  claimNextWake,
  claimResultDrainActivation,
  COLLECTIONS,
  commitResultDrainActivation,
  createTask,
  dispatchAttempt,
  drainLane,
  ensureOrchestrationIndexes,
  markAttemptPayloadReady,
  materializeResultDrainActivation,
  pauseJob,
  planJob,
  reapExpiredActivations,
  resumeJob,
  runResultDrainActivation,
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

const RESOURCE_ID = 'res_result_drain';
const CONVERSATION_ID = 'conv_result_drain';

type Producer =
  | { status: 'ok'; data: Record<string, unknown> }
  | { status: 'partial'; data: Record<string, unknown> }
  | { status: 'failed'; error: { code: string; message: string } };

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
  console.log('e2e:orchestration-result-drain');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_result_drain_e2e_${Date.now()}`,
    section: 'e2e:orchestration-result-drain',
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
      goal: `result-drain:${name}`,
      payload: { op: name },
    })).jobId;
  }

  /**
   * Planning is the opt-in boundary: its task carries RESULT_DRAIN_V1. Consume
   * its historical accepted/planning wakes before ingress so primitive tests
   * own only the result wake they are exercising.
   */
  async function runningOptIn(name: string): Promise<RunningFixture> {
    const jobId = await newJob(name);
    const planned = await planJob(client, db, jobId);
    assert.ok(planned);
    const task = await tasks.findOne({ _id: planned.taskId });
    assert.equal(task?.resultApplyMode, 'RESULT_DRAIN_V1');
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

  async function ingress(
    fixture: RunningFixture,
    producer: Producer,
    preparedGeneration?: number,
  ): Promise<IngressFixture> {
    const generation = preparedGeneration ?? (await (async () => {
      const marker = await markAttemptPayloadReady(client, db, {
        attemptId: fixture.attemptId,
        leaseOwner: fixture.worker,
        attemptFence: fixture.attemptFence,
        producer,
      });
      assert.equal(marker.ready, true);
      return marker.generation;
    })());
    const submitted = await submitAttemptResult(client, db, {
      attemptId: fixture.attemptId,
      leaseOwner: fixture.worker,
      attemptFence: fixture.attemptFence,
      producer,
      businessPayloadReadyGeneration: generation,
    });
    assert.equal(submitted.committed, true);
    assert.equal(submitted.deduped, false);

    const result = await results.findOne({ attemptId: fixture.attemptId });
    assert.ok(result);
    const item = await inbox.findOne({
      jobId: fixture.jobId,
      attemptId: fixture.attemptId,
      resultId: result._id,
    });
    assert.ok(item);
    return { ...fixture, result, inbox: item };
  }

  async function materialized(
    fixture: IngressFixture,
    opts: {
      activationCapMs?: number;
      reserveForFinalizeMs?: number;
      reducerCommitReserveMs?: number;
    } = {},
  ): Promise<LaneActivationDoc> {
    const activation = await materializeResultDrainActivation(client, db, fixture.jobId, {
      ...opts,
    });
    assert.ok(activation);
    assert.equal(activation.kind, 'RESULT_DRAIN');
    assert.deepEqual(activation.purposeAttemptIds, [fixture.attemptId]);
    assert.deepEqual(activation.batchInboxItemIds, [fixture.inbox._id]);
    return activation;
  }

  async function runningDrain(
    fixture: IngressFixture,
    name: string,
    opts?: {
      activationCapMs?: number;
      reserveForFinalizeMs?: number;
      reducerCommitReserveMs?: number;
    },
  ): Promise<{ activation: LaneActivationDoc; owner: string; activationFence: number }> {
    const activation = await materialized(fixture, opts);
    const owner = `lane-result:${name}`;
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
    return { activation, owner, activationFence: lease.activationFence };
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('A persists immutable ingress; only typed B terminalizes task and job', async () => {
      const a = await ingress(
        await runningOptIn('drain_separation'),
        { status: 'ok', data: { value: 1 } },
      );
      assert.equal((await attempts.findOne({ _id: a.attemptId }))?.lifecycle, 'FINISHED');
      assert.equal((await tasks.findOne({ _id: a.taskId }))?.phase, 'AWAITING_RESULT');
      assert.equal((await tasks.findOne({ _id: a.taskId }))?.pendingResultId, a.result._id);
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.phase, 'AWAITING_RESULTS');
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.terminalOutcome, null);
      assert.equal((await inbox.findOne({ _id: a.inbox._id }))?.state, 'RECEIVED');
      assert.equal(await events.countDocuments({
        jobId: a.jobId,
        type: 'JobTerminalized',
      }), 0);

      const applied = await runResultDrainActivation(client, db, a.jobId);
      assert.ok(applied);
      assert.equal(applied.outcome, 'COMPLETED');
      assert.equal((await tasks.findOne({ _id: a.taskId }))?.phase, 'SUCCEEDED');
      assert.equal((await tasks.findOne({ _id: a.taskId }))?.pendingResultId, null);
      assert.equal((await tasks.findOne({ _id: a.taskId }))?.appliedResultId, a.result._id);
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.terminalOutcome, 'COMPLETED');
      const resolved = await inbox.findOne({ _id: a.inbox._id });
      assert.equal(resolved?.state, 'APPLIED');
      assert.ok(resolved?.appliedByActivationId);
      assert.ok(resolved?.resolvedAt);
    });

    await check('B maps partial→PARTIAL and failed→FAILED without false success', async () => {
      const cases: Array<{
        name: string;
        producer: Producer;
        taskPhase: TaskDoc['phase'];
        outcome: JobDoc['terminalOutcome'];
      }> = [
        {
          name: 'drain_partial',
          producer: { status: 'partial', data: { useful: true } },
          taskPhase: 'PARTIAL',
          outcome: 'PARTIAL',
        },
        {
          name: 'drain_failed',
          producer: {
            status: 'failed',
            error: { code: 'producer_failed', message: 'expected failure' },
          },
          taskPhase: 'FAILED',
          outcome: 'FAILED',
        },
      ];
      for (const c of cases) {
        const a = await ingress(await runningOptIn(c.name), c.producer);
        assert.equal((await tasks.findOne({ _id: a.taskId }))?.phase, 'AWAITING_RESULT');
        const applied = await runResultDrainActivation(client, db, a.jobId);
        assert.equal(applied?.outcome, c.outcome);
        assert.equal((await tasks.findOne({ _id: a.taskId }))?.phase, c.taskPhase);
        assert.equal((await jobs.findOne({ _id: a.jobId }))?.terminalOutcome, c.outcome);
      }
    });

    await check('duplicate result wakes and commit replay apply exactly once', async () => {
      const a = await ingress(
        await runningOptIn('drain_duplicate_wake'),
        { status: 'ok', data: { duplicate: 'safe' } },
      );
      const resultWake = await outbox.findOne({
        aggregate: a.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.inboxItemId': a.inbox._id,
      });
      assert.ok(resultWake);
      await outbox.insertOne({
        ...resultWake,
        _id: `obx_duplicate_${globalThis.crypto.randomUUID()}`,
        createdAt: new Date(resultWake.createdAt.getTime() + 1),
      });

      const firstHandle = await claimNextWake(client, db);
      assert.equal(firstHandle?.jobId, a.jobId);
      assert.ok(firstHandle?.resultDrainActivationId);
      const secondHandle = await claimNextWake(client, db);
      assert.equal(secondHandle?.jobId, a.jobId);
      assert.equal(
        secondHandle?.resultDrainActivationId,
        firstHandle?.resultDrainActivationId,
      );

      const [left, right] = await Promise.all([
        runResultDrainActivation(client, db, a.jobId, {
          requiredActivationId: firstHandle!.resultDrainActivationId,
        }),
        runResultDrainActivation(client, db, a.jobId, {
          requiredActivationId: secondHandle!.resultDrainActivationId,
        }),
      ]);
      assert.equal([left, right].filter(Boolean).length, 1);
      assert.equal(await inbox.countDocuments({
        _id: a.inbox._id,
        state: 'APPLIED',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: a.jobId,
        type: 'JobTerminalized',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: a.jobId,
        type: 'JobTerminal',
      }), 1);
      assert.equal(await activations.countDocuments({
        jobId: a.jobId,
        kind: 'RESULT_DRAIN',
        lifecycle: 'COMMITTED',
      }), 1);
      assert.equal(await runResultDrainActivation(client, db, a.jobId), null);

      const replayFixture = await ingress(
        await runningOptIn('drain_explicit_commit_replay'),
        { status: 'ok', data: { replay: 'same-boundary' } },
      );
      const replayRun = await runningDrain(replayFixture, 'explicit-replay');
      const firstCommit = await commitResultDrainActivation(client, db, {
        activationId: replayRun.activation._id,
        leaseOwner: replayRun.owner,
        activationFence: replayRun.activationFence,
      });
      assert.equal(firstCommit?.deduped, false);
      const replayedCommit = await commitResultDrainActivation(client, db, {
        activationId: replayRun.activation._id,
        leaseOwner: replayRun.owner,
        activationFence: replayRun.activationFence,
      });
      assert.equal(replayedCommit?.deduped, true);
      assert.equal(replayedCommit?.resultId, replayFixture.result._id);
      assert.equal(await events.countDocuments({
        jobId: replayFixture.jobId,
        type: 'JobTerminalized',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: replayFixture.jobId,
        type: 'JobTerminal',
      }), 1);
    });

    await check('pause-before-A captures finish-current and permits B while paused', async () => {
      const running = await runningOptIn('drain_pause_before_a');
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
        commandId: 'drain_pause_before_a_cmd',
        jobId: running.jobId,
      });
      const paused = await jobs.findOne({ _id: running.jobId });
      assert.equal(paused?.controlState, 'PAUSE_REQUESTED');
      assert.equal(
        (await attempts.findOne({ _id: running.attemptId }))?.finishCurrentPauseGeneration,
        paused?.pauseGeneration,
      );

      const a = await ingress(running, producer, marker.generation);
      assert.equal(a.inbox.finishCurrentPauseGenerationAtA, paused?.pauseGeneration);
      const applied = await runResultDrainActivation(client, db, a.jobId);
      assert.equal(applied?.outcome, 'COMPLETED');
      assert.equal((await inbox.findOne({ _id: a.inbox._id }))?.state, 'APPLIED');
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.terminalOutcome, 'COMPLETED');
    });

    await check('A-before-pause stays RECEIVED until resume, then drains once', async () => {
      const a = await ingress(
        await runningOptIn('drain_a_before_pause'),
        { status: 'ok', data: { deferUntilResume: true } },
      );
      assert.equal(a.inbox.finishCurrentPauseGenerationAtA, null);
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'drain_a_before_pause_cmd',
        jobId: a.jobId,
      });
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.controlState, 'PAUSE_REQUESTED');
      assert.equal(await runResultDrainActivation(client, db, a.jobId), null);
      assert.equal((await inbox.findOne({ _id: a.inbox._id }))?.state, 'RECEIVED');
      assert.equal((await tasks.findOne({ _id: a.taskId }))?.phase, 'AWAITING_RESULT');
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.terminalOutcome, null);
      assert.equal(await activations.countDocuments({
        jobId: a.jobId,
        activeSlot: true,
      }), 0, 'deferred pause result must not create a hot-loop activation');

      await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'drain_a_before_pause_resume',
        jobId: a.jobId,
      });
      const applied = await runResultDrainActivation(client, db, a.jobId);
      assert.equal(applied?.outcome, 'COMPLETED');
      assert.equal(await events.countDocuments({
        jobId: a.jobId,
        type: 'JobTerminalized',
      }), 1);
    });

    await check('cancel-before-B rejects ingress and fences a stale running activation', async () => {
      const a = await ingress(
        await runningOptIn('drain_cancel_before_b'),
        { status: 'ok', data: { cancelWins: true } },
      );
      const running = await runningDrain(a, 'cancel-before-b');
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'drain_cancel_before_b_cmd',
        jobId: a.jobId,
      });
      assert.equal((await inbox.findOne({ _id: a.inbox._id }))?.state, 'REJECTED_STALE');
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.terminalOutcome, 'CANCELLED');
      assert.equal((await activations.findOne({
        _id: running.activation._id,
      }))?.lifecycle, 'ABANDONED');
      assert.equal(await commitResultDrainActivation(client, db, {
        activationId: running.activation._id,
        leaseOwner: running.owner,
        activationFence: running.activationFence,
      }), null);
      assert.equal(await events.countDocuments({
        jobId: a.jobId,
        type: 'JobTerminalized',
      }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: a.jobId,
        type: 'JobTerminal',
      }), 1);
    });

    await check('owner, fence, purpose and result hash mismatches fail closed', async () => {
      const wrongIdentity = await ingress(
        await runningOptIn('drain_wrong_identity'),
        { status: 'ok', data: { protected: 'identity' } },
      );
      const activation = await materialized(wrongIdentity);
      const owner = 'lane-result:right-owner';
      const lease = await claimResultDrainActivation(client, db, {
        activationId: activation._id,
        leaseOwner: owner,
        leaseTtlMs: 30_000,
      });
      assert.ok(lease);
      assert.equal(await startResultDrainActivation(client, db, {
        activationId: activation._id,
        leaseOwner: 'lane-result:intruder',
        activationFence: lease.activationFence,
      }), false);
      assert.equal(await startResultDrainActivation(client, db, {
        activationId: activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence - 1,
      }), false);
      assert.equal(await startResultDrainActivation(client, db, {
        activationId: activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
      }), true);
      assert.equal(await commitResultDrainActivation(client, db, {
        activationId: activation._id,
        leaseOwner: 'lane-result:intruder',
        activationFence: lease.activationFence,
      }), null);
      assert.equal(await commitResultDrainActivation(client, db, {
        activationId: activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence - 1,
      }), null);

      await activations.updateOne(
        { _id: activation._id },
        { $set: { purposeAttemptIds: ['attempt_not_in_batch'] } },
      );
      assert.equal(await commitResultDrainActivation(client, db, {
        activationId: activation._id,
        leaseOwner: owner,
        activationFence: lease.activationFence,
      }), null);
      assert.equal((await inbox.findOne({ _id: wrongIdentity.inbox._id }))?.state, 'RECEIVED');
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'drain_wrong_identity_cleanup',
        jobId: wrongIdentity.jobId,
      });

      const wrongHash = await ingress(
        await runningOptIn('drain_wrong_hash'),
        { status: 'ok', data: { protected: 'hash' } },
      );
      const hashRun = await runningDrain(wrongHash, 'wrong-hash');
      await results.updateOne(
        { _id: wrongHash.result._id },
        { $set: { payloadHash: 'tampered-result-hash' } },
      );
      assert.equal(await commitResultDrainActivation(client, db, {
        activationId: hashRun.activation._id,
        leaseOwner: hashRun.owner,
        activationFence: hashRun.activationFence,
      }), null);
      assert.equal((await inbox.findOne({ _id: wrongHash.inbox._id }))?.state, 'RECEIVED');
      assert.equal((await jobs.findOne({ _id: wrongHash.jobId }))?.terminalOutcome, null);
      await cancelJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'drain_wrong_hash_cleanup',
        jobId: wrongHash.jobId,
      });
    });

    await check('expired RESULT_DRAIN is reaped and recovered under pause exactly once', async () => {
      const running = await runningOptIn('drain_reaper_pause');
      const producer = { status: 'ok' as const, data: { recover: true } };
      const marker = await markAttemptPayloadReady(client, db, {
        attemptId: running.attemptId,
        leaseOwner: running.worker,
        attemptFence: running.attemptFence,
        producer,
      });
      assert.equal(marker.ready, true);
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'drain_reaper_pause_cmd',
        jobId: running.jobId,
      });
      const a = await ingress(running, producer, marker.generation);
      const active = await runningDrain(a, 'reaper-pause');
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
      assert.equal(await commitResultDrainActivation(client, db, {
        activationId: active.activation._id,
        leaseOwner: active.owner,
        activationFence: active.activationFence,
      }), null);
      assert.equal((await inbox.findOne({ _id: a.inbox._id }))?.state, 'RECEIVED');
      const recoveredJob = await jobs.findOne({ _id: a.jobId });
      assert.ok(recoveredJob);
      assert.equal(await outbox.countDocuments({
        aggregate: a.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.inboxItemId': a.inbox._id,
        'payload.activationDispatchGeneration':
          recoveredJob.activationDispatchGeneration,
      }), 1);

      await drainLane(client, db);
      assert.equal((await inbox.findOne({ _id: a.inbox._id }))?.state, 'APPLIED');
      assert.equal((await jobs.findOne({ _id: a.jobId }))?.terminalOutcome, 'COMPLETED');
      assert.equal(await activations.countDocuments({
        jobId: a.jobId,
        kind: 'RESULT_DRAIN',
        lifecycle: 'ABANDONED',
      }), 1);
      assert.equal(await activations.countDocuments({
        jobId: a.jobId,
        kind: 'RESULT_DRAIN',
        lifecycle: 'COMMITTED',
      }), 1);
      assert.equal(await events.countDocuments({
        jobId: a.jobId,
        type: 'JobTerminalized',
      }), 1);
    });

    await check('createTask remains legacy-fused and never creates an inbox item', async () => {
      const jobId = await newJob('drain_legacy_create_task');
      await outbox.updateMany(
        { aggregate: jobId, type: 'LaneWakeRequested', state: 'PENDING' },
        { $set: { state: 'PUBLISHED' } },
      );
      const taskId = await createTask(client, db, jobId);
      assert.equal((await tasks.findOne({ _id: taskId }))?.resultApplyMode, undefined);
      const { attemptId } = await dispatchAttempt(client, db, { jobId, taskId });
      const worker = 'worker:drain-legacy';
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
      const producer = { status: 'ok' as const, data: { legacy: true } };
      const marker = await markAttemptPayloadReady(client, db, {
        attemptId,
        leaseOwner: worker,
        attemptFence: lease.attemptFence,
        producer,
      });
      assert.equal(marker.ready, true);
      assert.equal((await submitAttemptResult(client, db, {
        attemptId,
        leaseOwner: worker,
        attemptFence: lease.attemptFence,
        producer,
        businessPayloadReadyGeneration: marker.generation,
      })).committed, true);
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'SUCCEEDED');
      assert.equal(await inbox.countDocuments({ jobId }), 0);
      assert.equal(await runResultDrainActivation(client, db, jobId), null);
    });

    await check('invalid opt-in result stays on the fused failure path', async () => {
      const running = await runningOptIn('drain_invalid_fused');
      const submitted = await submitAttemptResult(client, db, {
        attemptId: running.attemptId,
        leaseOwner: running.worker,
        attemptFence: running.attemptFence,
        producer: 'plain prose is not a result envelope',
      });
      assert.equal(submitted.committed, true);
      assert.equal(submitted.outcome, 'FAILED');
      assert.equal(submitted.reason, 'invalid_result');
      assert.equal((await tasks.findOne({ _id: running.taskId }))?.phase, 'FAILED');
      assert.equal(await inbox.countDocuments({ jobId: running.jobId }), 0);
      assert.equal(await activations.countDocuments({
        jobId: running.jobId,
        kind: 'RESULT_DRAIN',
      }), 0);
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-result-drain — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-result-drain — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
