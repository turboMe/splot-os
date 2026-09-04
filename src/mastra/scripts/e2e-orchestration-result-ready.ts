#!/usr/bin/env tsx
/**
 * e2e:orchestration-result-ready — flat SERIAL attempt-side slice of
 * ORC-RESULT-READY-01.
 *
 * Proves against a real replica set that an ordinary business result is frozen
 * under current authority before the business cutoff, and that A commits only
 * that exact generation/hash before the work deadline. The full contract stays
 * deferred: activation reducer authority, ancestor-chain touch, task due
 * eligibility, effects/artifacts, and A_evidence are intentionally not claimed.
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  appendInstruction,
  cancelJob,
  claimAttempt,
  COLLECTIONS,
  createTask,
  dispatchAttempt,
  ensureOrchestrationIndexes,
  expireQueuedAttempts,
  laneStep,
  markAttemptPayloadReady,
  pauseJob,
  PauseInProgressError,
  producerCandidateHash,
  reapExpiredLeases,
  resumeJob,
  runWorkerOnce,
  startAttemptOperation,
  submitAttemptResult,
  type AttemptDoc,
  type JobDoc,
  type JobEventDoc,
  type OutboxDoc,
  type ResultDoc,
  type TaskDoc,
} from '../orchestration/store/index.js';
import { createOrchestrationApi } from '../orchestration/http/handlers.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_result_ready';
const CONVERSATION_ID = 'conv_result_ready';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).stack ?? (err as Error).message}`); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-result-ready');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_result_ready_e2e_${Date.now()}`,
    section: 'e2e:orchestration-result-ready',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const api = createOrchestrationApi(client, db);

  async function newJob(cmd: string): Promise<string> {
    const accepted = await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      goal: `work:${cmd}`,
      commandId: cmd,
      payload: { op: cmd },
    });
    return accepted.jobId;
  }

  async function claimed(
    cmd: string,
    worker = `worker:${cmd}`,
  ): Promise<{ jobId: string; taskId: string; attemptId: string; worker: string; fence: number }> {
    const jobId = await newJob(cmd);
    const taskId = await createTask(client, db, jobId);
    const { attemptId } = await dispatchAttempt(client, db, { jobId, taskId });
    const lease = await claimAttempt(client, db, {
      attemptId,
      workerInstanceId: worker,
      leaseTtlMs: 30_000,
    });
    assert.ok(lease, 'claim must succeed');
    assert.equal(await startAttemptOperation(client, db, {
      attemptId,
      leaseOwner: worker,
      attemptFence: lease.attemptFence,
    }), true);
    return { jobId, taskId, attemptId, worker, fence: lease.attemptFence };
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('ordinary A requires an explicit payload-ready generation', async () => {
      const c = await claimed('rr_missing_marker');
      const attempt = await attempts.findOne({ _id: c.attemptId });
      assert.ok(attempt);
      assert.ok(attempt.businessOperationCutoffAt < attempt.workDeadlineAt);
      assert.ok(attempt.workDeadlineAt < attempt.hardDeadlineAt);
      assert.ok(attempt.leaseExpiresAt! <= attempt.hardDeadlineAt);

      const submitted = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer: { status: 'ok', data: { value: 1 } },
      });
      assert.deepEqual(submitted, { committed: false, reason: 'payload_not_ready' });
      assert.equal(await results.countDocuments({ attemptId: c.attemptId }), 0);
      assert.equal((await tasks.findOne({ _id: c.taskId }))?.phase, 'DISPATCHED');
    });

    await check('marker at/after business cutoff mutates no authority', async () => {
      const c = await claimed('rr_late_marker');
      const beforeJob = await jobs.findOne({ _id: c.jobId });
      await attempts.updateOne(
        { _id: c.attemptId },
        { $set: { businessOperationCutoffAt: new Date(Date.now() - 50) } },
      );
      const marked = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer: { status: 'ok', data: { value: 2 } },
      });
      assert.equal(marked.ready, false);
      assert.equal(marked.reason, 'stale_fence_or_lease_or_cutoff');
      assert.equal(marked.generation, 0);
      assert.equal((await attempts.findOne({ _id: c.attemptId }))?.businessPayloadReadyGeneration, 0);
      const task = await tasks.findOne({ _id: c.taskId });
      assert.equal(task?.businessPayloadReadyAttemptId, null);
      assert.equal((await jobs.findOne({ _id: c.jobId }))?.stateVersion, beforeJob?.stateVersion);
      assert.equal(await results.countDocuments({ attemptId: c.attemptId }), 0);
    });

    await check('marker before cutoff lets A use only the protected result-commit reserve', async () => {
      const c = await claimed('rr_result_reserve');
      const now = Date.now();
      const cutoff = new Date(now + 450);
      const work = new Date(now + 2_000);
      const hard = new Date(now + 4_000);
      await attempts.updateOne(
        { _id: c.attemptId },
        {
          $set: {
            businessOperationCutoffAt: cutoff,
            workDeadlineAt: work,
            hardDeadlineAt: hard,
            leaseExpiresAt: new Date(now + 3_000),
          },
        },
      );
      const producer = { status: 'ok', data: { window: 'result-reserve' } };
      const marked = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
      });
      assert.equal(marked.ready, true);
      await sleep(Math.max(0, cutoff.getTime() + 40 - Date.now()));
      const submitted = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: marked.generation,
      });
      assert.equal(submitted.committed, true);
      const attempt = await attempts.findOne({ _id: c.attemptId });
      assert.ok(attempt?.businessPayloadReadyAt);
      assert.ok(attempt.ACommittedAt);
      assert.ok(attempt.businessPayloadReadyAt < cutoff);
      assert.ok(attempt.ACommittedAt > cutoff);
      assert.ok(attempt.ACommittedAt < work);
    });

    await check('ordinary A at/after work deadline commits nothing', async () => {
      const c = await claimed('rr_late_a');
      const now = Date.now();
      const cutoff = new Date(now + 180);
      const work = new Date(now + 380);
      await attempts.updateOne(
        { _id: c.attemptId },
        {
          $set: {
            businessOperationCutoffAt: cutoff,
            workDeadlineAt: work,
            hardDeadlineAt: new Date(now + 2_000),
            leaseExpiresAt: new Date(now + 1_500),
          },
        },
      );
      const producer = { status: 'ok', data: { tooLate: true } };
      const marked = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
      });
      assert.equal(marked.ready, true);
      await sleep(Math.max(0, work.getTime() + 40 - Date.now()));
      const submitted = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: marked.generation,
      });
      assert.equal(submitted.committed, false);
      assert.equal(submitted.reason, 'work_deadline_or_authority');
      assert.equal((await attempts.findOne({ _id: c.attemptId }))?.lifecycle, 'RUNNING');
      assert.equal((await tasks.findOne({ _id: c.taskId }))?.phase, 'DISPATCHED');
      assert.equal(await results.countDocuments({ attemptId: c.attemptId }), 0);
      assert.equal(await events.countDocuments({ jobId: c.jobId, type: 'AttemptResultAvailable' }), 0);
    });

    await check('marker/hash and A replay are immutable, owner-scoped, and exactly-once', async () => {
      const c = await claimed('rr_hash_replay');
      const producer = { status: 'ok', data: { alpha: 1, nested: { x: true, y: 'z' } } };
      const reordered = { data: { nested: { y: 'z', x: true }, alpha: 1 }, status: 'ok' };
      const changed = { status: 'ok', data: { alpha: 2, nested: { x: true, y: 'z' } } };
      assert.equal(producerCandidateHash(producer), producerCandidateHash(reordered));
      const stateBefore = (await jobs.findOne({ _id: c.jobId }))!.stateVersion;

      const markers = await Promise.all([
        markAttemptPayloadReady(client, db, {
          attemptId: c.attemptId, leaseOwner: c.worker, attemptFence: c.fence, producer,
        }),
        markAttemptPayloadReady(client, db, {
          attemptId: c.attemptId, leaseOwner: c.worker, attemptFence: c.fence, producer: reordered,
        }),
      ]);
      assert.equal(markers.filter((m) => m.marked).length, 1);
      assert.equal(markers.filter((m) => m.deduped).length, 1);
      assert.ok(markers.every((m) => m.ready && m.generation === 1));
      assert.equal((await jobs.findOne({ _id: c.jobId }))!.stateVersion, stateBefore + 1);

      const wrongOwnerMarker = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: 'worker:intruder',
        attemptFence: c.fence,
        producer,
      });
      assert.equal(wrongOwnerMarker.ready, false);
      assert.equal(wrongOwnerMarker.reason, 'stale_fence_or_lease_or_cutoff');

      const conflict = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId, leaseOwner: c.worker, attemptFence: c.fence, producer: changed,
      });
      assert.equal(conflict.reason, 'payload_hash_conflict');
      const mismatch = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer: changed,
        businessPayloadReadyGeneration: 1,
      });
      assert.equal(mismatch.reason, 'payload_hash_mismatch');

      const first = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: 1,
      });
      const replay = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer: reordered,
        businessPayloadReadyGeneration: 1,
      });
      assert.equal(first.committed, true);
      assert.equal(first.deduped, false);
      assert.equal(replay.committed, true);
      assert.equal(replay.deduped, true);
      const missingGenerationReplay = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
      });
      const wrongGenerationReplay = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: 2,
      });
      assert.deepEqual(missingGenerationReplay, { committed: false, reason: 'payload_not_ready' });
      assert.deepEqual(wrongGenerationReplay, { committed: false, reason: 'payload_not_ready' });
      const wrongOwnerReplay = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: 'worker:intruder',
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: 1,
      });
      assert.equal(wrongOwnerReplay.reason, 'stale_fence_or_lease');

      assert.equal(await results.countDocuments({ attemptId: c.attemptId }), 1);
      assert.equal(await events.countDocuments({ jobId: c.jobId, type: 'AttemptResultAvailable' }), 1);
      assert.equal(await outbox.countDocuments({
        aggregate: c.jobId,
        type: 'LaneWakeRequested',
        'payload.reason': 'result',
      }), 1);
      const result = await results.findOne({ attemptId: c.attemptId });
      const attempt = await attempts.findOne({ _id: c.attemptId });
      assert.equal(result?.planVersion, attempt?.planVersion);
      assert.equal(result?.leaseOwnerAtCommit, c.worker);
      assert.equal(result?.payloadHash, attempt?.businessPayloadReadyHash);
      assert.equal(result?.businessPayloadReadyGeneration, 1);
      assert.equal(result?.businessPayloadReadyHash, result?.payloadHash);
      assert.equal(result?.ACommittedAt.getTime(), attempt?.ACommittedAt?.getTime());
      assert.ok(result!.ACommittedAt < attempt!.workDeadlineAt);
    });

    await check('non-JSON candidates are typed failures and invalid A replay is idempotent', async () => {
      const c = await claimed('rr_json_only');
      const dated = { status: 'ok', data: { value: new Date('2026-01-01T00:00:00.000Z') } };
      const cyclic: Record<string, unknown> = { status: 'ok', data: {} };
      (cyclic.data as Record<string, unknown>).self = cyclic;
      assert.doesNotThrow(() => producerCandidateHash(dated));
      assert.doesNotThrow(() => producerCandidateHash({ status: 'ok', data: { value: 1n } }));
      assert.doesNotThrow(() => producerCandidateHash(cyclic));

      const marker = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer: dated,
      });
      assert.equal(marker.required, false, 'invalid JSON never receives a business marker');
      const first = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer: dated,
      });
      const replay = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer: dated,
      });
      assert.equal(first.committed, true);
      assert.equal(first.reason, 'invalid_result');
      assert.equal(first.deduped, false);
      assert.equal(replay.committed, true);
      assert.equal(replay.reason, 'invalid_result');
      assert.equal(replay.deduped, true);
      assert.equal(await results.countDocuments({ attemptId: c.attemptId }), 0);
      assert.equal(await events.countDocuments({ jobId: c.jobId, type: 'AttemptFailed' }), 1);
    });

    await check('stale fence and wrong owner cannot mark or commit', async () => {
      const c = await claimed('rr_owner_fence');
      const producer = { status: 'ok', data: { secure: true } };
      for (const identity of [
        { leaseOwner: c.worker, attemptFence: c.fence - 1 },
        { leaseOwner: 'worker:wrong', attemptFence: c.fence },
      ]) {
        const marker = await markAttemptPayloadReady(client, db, {
          attemptId: c.attemptId,
          producer,
          ...identity,
        });
        assert.equal(marker.ready, false);
        assert.equal(marker.reason, 'stale_fence_or_lease_or_cutoff');
      }
      const marked = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
      });
      assert.equal(marked.ready, true);
      const wrong = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: 'worker:wrong',
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: marked.generation,
      });
      assert.equal(wrong.reason, 'stale_fence_or_lease');
      assert.equal(await results.countDocuments({ attemptId: c.attemptId }), 0);
    });

    await check('append_instruction does not invalidate a frozen current-plan result', async () => {
      const c = await claimed('rr_append');
      const producer = { status: 'ok', data: { snapshot: 'before-append' } };
      const marked = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
      });
      assert.equal(marked.ready, true);
      await appendInstruction(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'rr_append_instruction',
        jobId: c.jobId,
        instruction: 'Use this only on a subsequent attempt.',
      });
      const submitted = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: marked.generation,
      });
      assert.equal(submitted.committed, true);
      assert.equal((await tasks.findOne({ _id: c.taskId }))?.phase, 'SUCCEEDED');
    });

    await check('sibling task markers do not invalidate each other', async () => {
      const jobId = await newJob('rr_siblings');
      const taskA = await createTask(client, db, jobId);
      const taskB = await createTask(client, db, jobId);
      const attemptA = (await dispatchAttempt(client, db, { jobId, taskId: taskA })).attemptId;
      const attemptB = (await dispatchAttempt(client, db, { jobId, taskId: taskB })).attemptId;
      const leaseA = await claimAttempt(client, db, { attemptId: attemptA, workerInstanceId: 'worker:sibling-a' });
      const leaseB = await claimAttempt(client, db, { attemptId: attemptB, workerInstanceId: 'worker:sibling-b' });
      assert.ok(leaseA);
      assert.ok(leaseB);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId: attemptA,
        leaseOwner: 'worker:sibling-a',
        attemptFence: leaseA.attemptFence,
      }), true);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId: attemptB,
        leaseOwner: 'worker:sibling-b',
        attemptFence: leaseB.attemptFence,
      }), true);
      const producerA = { status: 'ok', data: { sibling: 'a' } };
      const producerB = { status: 'ok', data: { sibling: 'b' } };
      const [markerA, markerB] = await Promise.all([
        markAttemptPayloadReady(client, db, {
          attemptId: attemptA,
          leaseOwner: 'worker:sibling-a',
          attemptFence: leaseA.attemptFence,
          producer: producerA,
        }),
        markAttemptPayloadReady(client, db, {
          attemptId: attemptB,
          leaseOwner: 'worker:sibling-b',
          attemptFence: leaseB.attemptFence,
          producer: producerB,
        }),
      ]);
      assert.equal(markerA.ready, true);
      assert.equal(markerB.ready, true);
      const [resultA, resultB] = await Promise.all([
        submitAttemptResult(client, db, {
          attemptId: attemptA,
          leaseOwner: 'worker:sibling-a',
          attemptFence: leaseA.attemptFence,
          producer: producerA,
          businessPayloadReadyGeneration: markerA.generation,
        }),
        submitAttemptResult(client, db, {
          attemptId: attemptB,
          leaseOwner: 'worker:sibling-b',
          attemptFence: leaseB.attemptFence,
          producer: producerB,
          businessPayloadReadyGeneration: markerB.generation,
        }),
      ]);
      assert.equal(resultA.committed, true);
      assert.equal(resultB.committed, true);
      assert.equal(await results.countDocuments({ jobId }), 2);
      assert.equal(await events.countDocuments({ jobId, type: 'AttemptResultAvailable' }), 2);
      assert.equal(await tasks.countDocuments({
        _id: { $in: [taskA, taskB] },
        phase: 'SUCCEEDED',
        activeAttemptId: null,
      }), 2);
    });

    await check('pause barrier preserves a captured result and rolls back early resume', async () => {
      const c = await claimed('rr_pause_resume');
      const producer = { status: 'ok', data: { staleAfterPause: true } };
      const marked = await markAttemptPayloadReady(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
      });
      const beforePauseGeneration = (await jobs.findOne({ _id: c.jobId }))!.pauseGeneration;
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID, commandId: 'rr_pause', jobId: c.jobId,
      });
      await assert.rejects(
        resumeJob(client, db, {
          resourceId: RESOURCE_ID, commandId: 'rr_resume', jobId: c.jobId,
        }),
        (err: unknown) => err instanceof PauseInProgressError,
      );
      assert.equal((await jobs.findOne({ _id: c.jobId }))?.controlState, 'PAUSE_REQUESTED');
      assert.equal((await jobs.findOne({ _id: c.jobId }))!.pauseGeneration, beforePauseGeneration + 1);
      const submitted = await submitAttemptResult(client, db, {
        attemptId: c.attemptId,
        leaseOwner: c.worker,
        attemptFence: c.fence,
        producer,
        businessPayloadReadyGeneration: marked.generation,
      });
      assert.equal(submitted.committed, true);
      assert.equal(await results.countDocuments({ attemptId: c.attemptId }), 1);
      const resumed = await resumeJob(client, db, {
        resourceId: RESOURCE_ID, commandId: 'rr_resume', jobId: c.jobId,
      });
      assert.equal(resumed.changed, true, 'the rolled-back commandId is reusable after settlement');
      assert.equal(resumed.controlState, 'NONE');
    });

    await check('marker races with pause/cancel under finish-current authority', async () => {
      const pauseCase = await claimed('rr_pause_race');
      const pauseProducer = { status: 'ok', data: { race: 'pause' } };
      const [pauseMarker] = await Promise.all([
        markAttemptPayloadReady(client, db, {
          attemptId: pauseCase.attemptId,
          leaseOwner: pauseCase.worker,
          attemptFence: pauseCase.fence,
          producer: pauseProducer,
        }),
        pauseJob(client, db, {
          resourceId: RESOURCE_ID, commandId: 'rr_pause_race_cmd', jobId: pauseCase.jobId,
        }),
      ]);
      const afterPause = await submitAttemptResult(client, db, {
        attemptId: pauseCase.attemptId,
        leaseOwner: pauseCase.worker,
        attemptFence: pauseCase.fence,
        producer: pauseProducer,
        ...(pauseMarker.ready
          ? { businessPayloadReadyGeneration: pauseMarker.generation }
          : {}),
      });
      if (pauseMarker.ready) {
        assert.equal(afterPause.committed, true);
        assert.equal(await results.countDocuments({ attemptId: pauseCase.attemptId }), 1);
      } else {
        assert.equal(pauseMarker.reason, 'stale_plan_or_control');
        assert.deepEqual(afterPause, { committed: false, reason: 'payload_not_ready' });
        assert.equal(await results.countDocuments({ attemptId: pauseCase.attemptId }), 0);
      }

      const cancelCase = await claimed('rr_cancel_race');
      const cancelProducer = { status: 'ok', data: { race: 'cancel' } };
      const [cancelMarker] = await Promise.all([
        markAttemptPayloadReady(client, db, {
          attemptId: cancelCase.attemptId,
          leaseOwner: cancelCase.worker,
          attemptFence: cancelCase.fence,
          producer: cancelProducer,
        }),
        cancelJob(client, db, {
          resourceId: RESOURCE_ID, commandId: 'rr_cancel_race_cmd', jobId: cancelCase.jobId,
        }),
      ]);
      const afterCancel = await submitAttemptResult(client, db, {
        attemptId: cancelCase.attemptId,
        leaseOwner: cancelCase.worker,
        attemptFence: cancelCase.fence,
        producer: cancelProducer,
        ...(cancelMarker.ready
          ? { businessPayloadReadyGeneration: cancelMarker.generation }
          : {}),
      });
      assert.equal(afterCancel.committed, false);
      assert.ok([
        'payload_not_ready',
        'stale_fence_or_lease',
        'stale_plan_or_control',
      ].includes(afterCancel.reason!));
      const cancelPending = await jobs.findOne({ _id: cancelCase.jobId });
      assert.equal(cancelPending?.phase, 'RECONCILING');
      assert.equal(cancelPending?.controlState, 'STOP_REQUESTED');
      assert.equal(cancelPending?.terminalOutcome, null);
      assert.equal(cancelPending?.pendingTerminalOutcome, 'CANCELLED');
      assert.equal((await attempts.findOne({ _id: cancelCase.attemptId }))?.lifecycle, 'STOP_REQUESTED');
      assert.equal(await outbox.countDocuments({
        aggregate: cancelCase.jobId,
        type: 'JobTerminal',
      }), 0);
      assert.equal(await results.countDocuments({ attemptId: cancelCase.attemptId }), 0);
    });

    await check('A races with pause/cancel and respects the transaction winner', async () => {
      const pauseCase = await claimed('rr_a_pause_race');
      const pauseProducer = { status: 'ok', data: { race: 'a-vs-pause' } };
      const pauseMarker = await markAttemptPayloadReady(client, db, {
        attemptId: pauseCase.attemptId,
        leaseOwner: pauseCase.worker,
        attemptFence: pauseCase.fence,
        producer: pauseProducer,
      });
      assert.equal(pauseMarker.ready, true);
      const [pauseA] = await Promise.all([
        submitAttemptResult(client, db, {
          attemptId: pauseCase.attemptId,
          leaseOwner: pauseCase.worker,
          attemptFence: pauseCase.fence,
          producer: pauseProducer,
          businessPayloadReadyGeneration: pauseMarker.generation,
        }),
        pauseJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_a_pause_race_cmd',
          jobId: pauseCase.jobId,
        }),
      ]);
      assert.equal(pauseA.committed, true, 'pause captures RUNNING as finish-current');
      assert.equal(await results.countDocuments({ attemptId: pauseCase.attemptId }), 1);
      assert.equal(await events.countDocuments({
        jobId: pauseCase.jobId,
        type: 'AttemptResultAvailable',
      }), 1);
      assert.equal(await events.countDocuments({ jobId: pauseCase.jobId, type: 'JobPaused' }), 1);
      const pausedJob = await jobs.findOne({ _id: pauseCase.jobId });
      assert.equal(pausedJob?.controlState, 'PAUSE_REQUESTED');
      assert.equal(await outbox.countDocuments({
        aggregate: pauseCase.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        'payload.activationDispatchGeneration': pausedJob?.activationDispatchGeneration,
      }), 1, 'A-before-pause and pause-before-A both leave current result-drain authority');
      assert.equal((await laneStep(client, db, pauseCase.jobId)).outcome, 'COMPLETED');
      assert.equal((await jobs.findOne({ _id: pauseCase.jobId }))?.terminalOutcome, 'COMPLETED');

      const cancelCase = await claimed('rr_a_cancel_race');
      const cancelProducer = { status: 'ok', data: { race: 'a-vs-cancel' } };
      const cancelMarker = await markAttemptPayloadReady(client, db, {
        attemptId: cancelCase.attemptId,
        leaseOwner: cancelCase.worker,
        attemptFence: cancelCase.fence,
        producer: cancelProducer,
      });
      assert.equal(cancelMarker.ready, true);
      const [cancelA] = await Promise.all([
        submitAttemptResult(client, db, {
          attemptId: cancelCase.attemptId,
          leaseOwner: cancelCase.worker,
          attemptFence: cancelCase.fence,
          producer: cancelProducer,
          businessPayloadReadyGeneration: cancelMarker.generation,
        }),
        cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_a_cancel_race_cmd',
          jobId: cancelCase.jobId,
        }),
      ]);
      const cancelledJob = await jobs.findOne({ _id: cancelCase.jobId });
      if (cancelA.committed) {
        assert.equal(cancelledJob?.terminalOutcome, 'CANCELLED');
        const ordered = await events.find({ jobId: cancelCase.jobId })
          .sort({ sequence: 1 }).toArray();
        const resultIndex = ordered.findIndex((event) => event.type === 'AttemptResultAvailable');
        const stopIndex = ordered.findIndex((event) => event.type === 'JobStopRequested');
        const terminalIndex = ordered.findIndex((event) => event.type === 'JobTerminalized');
        assert.ok(
          resultIndex >= 0
          && stopIndex > resultIndex
          && terminalIndex > stopIndex,
        );
        assert.equal(
          ordered.some((event) => event.type === 'JobCancelled'),
          false,
          'the unified stop barrier emits one terminal decision instead of the legacy shortcut',
        );
        assert.equal(await results.countDocuments({ attemptId: cancelCase.attemptId }), 1);
      } else {
        assert.equal(cancelledJob?.phase, 'RECONCILING');
        assert.equal(cancelledJob?.controlState, 'STOP_REQUESTED');
        assert.equal(cancelledJob?.terminalOutcome, null);
        assert.equal(cancelledJob?.pendingTerminalOutcome, 'CANCELLED');
        assert.ok([
          'stale_fence_or_lease',
          'stale_plan_or_control',
        ].includes(cancelA.reason!));
        assert.equal(await results.countDocuments({ attemptId: cancelCase.attemptId }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: cancelCase.jobId,
          type: 'JobTerminal',
        }), 0);
      }
    });

    await check('claim is authority-aware and cannot start queued work after pause/cancel', async () => {
      for (const control of ['pause', 'cancel'] as const) {
        const jobId = await newJob(`rr_claim_after_${control}`);
        const taskId = await createTask(client, db, jobId);
        const attemptId = (await dispatchAttempt(client, db, {
          jobId,
          taskId,
          ...(control === 'pause'
            ? {
                attemptCapMs: 180,
                reserveForFinalizeMs: 40,
                resultCommitReserveMs: 40,
              }
            : {}),
        })).attemptId;
        const oldAttempt = await attempts.findOne({ _id: attemptId });
        assert.ok(oldAttempt);
        if (control === 'pause') {
          await pauseJob(client, db, {
            resourceId: RESOURCE_ID,
            commandId: 'rr_claim_pause_cmd',
            jobId,
          });
        } else {
          await cancelJob(client, db, {
            resourceId: RESOURCE_ID,
            commandId: 'rr_claim_cancel_cmd',
            jobId,
          });
        }
        const lease = await claimAttempt(client, db, {
          attemptId,
          workerInstanceId: `worker:after-${control}`,
        });
        assert.equal(lease, null);
        if (control === 'pause') {
          const pausedAttempt = await attempts.findOne({ _id: attemptId });
          assert.equal(pausedAttempt?.lifecycle, 'FINISHED');
          assert.equal(pausedAttempt?.outcome, 'CANCELLED');
          assert.equal(pausedAttempt?.reasonCode, 'pause_interrupt');
          assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'READY');
          await sleep(Math.max(0, oldAttempt.businessOperationCutoffAt.getTime() + 20 - Date.now()));
          await resumeJob(client, db, {
            resourceId: RESOURCE_ID,
            commandId: 'rr_claim_resume_cmd',
            jobId,
          });
          const dispatch = await laneStep(client, db, jobId);
          assert.equal(dispatch.action, 'dispatched');
          assert.notEqual(dispatch.attemptId, attemptId);
          const fresh = await attempts.findOne({ _id: dispatch.attemptId });
          const resumedJob = await jobs.findOne({ _id: jobId });
          assert.equal(fresh?.attemptNumber, 2);
          assert.equal(fresh?.pauseGenerationAtDispatch, resumedJob?.pauseGeneration);
          assert.ok(fresh!.businessOperationCutoffAt > oldAttempt.businessOperationCutoffAt);
          const afterResume = await claimAttempt(client, db, {
            attemptId: fresh!._id,
            workerInstanceId: 'worker:after-resume',
          });
          assert.ok(afterResume, 'resume dispatches a fresh current-generation attempt');
          assert.equal(await startAttemptOperation(client, db, {
            attemptId: fresh!._id,
            leaseOwner: 'worker:after-resume',
            attemptFence: afterResume.attemptFence,
          }), true);
          const producer = { status: 'ok', data: { resumedFresh: true } };
          const marker = await markAttemptPayloadReady(client, db, {
            attemptId: fresh!._id,
            leaseOwner: 'worker:after-resume',
            attemptFence: afterResume.attemptFence,
            producer,
          });
          assert.equal(marker.ready, true);
          assert.equal((await submitAttemptResult(client, db, {
            attemptId: fresh!._id,
            leaseOwner: 'worker:after-resume',
            attemptFence: afterResume.attemptFence,
            producer,
            businessPayloadReadyGeneration: marker.generation,
          })).committed, true);
        } else {
          const cancelledAttempt = await attempts.findOne({ _id: attemptId });
          assert.equal(cancelledAttempt?.lifecycle, 'FINISHED');
          assert.equal(cancelledAttempt?.outcome, 'CANCELLED');
          assert.equal(cancelledAttempt?.reasonCode, 'user_cancel');
          assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'CANCELLED');
        }
      }
    });

    await check('claim at cutoff is inert, then queue-expiry reducer terminalizes exactly once', async () => {
      const jobId = await newJob('rr_claim_cutoff');
      const taskId = await createTask(client, db, jobId);
      const attemptId = (await dispatchAttempt(client, db, { jobId, taskId })).attemptId;
      const beforeStateVersion = (await jobs.findOne({ _id: jobId }))!.stateVersion;
      await attempts.updateOne(
        { _id: attemptId },
        { $set: { businessOperationCutoffAt: new Date(Date.now() - 25) } },
      );
      const lease = await claimAttempt(client, db, {
        attemptId,
        workerInstanceId: 'worker:late-claim',
      });
      assert.equal(lease, null);
      assert.equal((await attempts.findOne({ _id: attemptId }))?.lifecycle, 'QUEUED');
      assert.equal((await tasks.findOne({ _id: taskId }))?.activeAttemptId, null);
      assert.equal((await jobs.findOne({ _id: jobId }))?.stateVersion, beforeStateVersion);
      assert.equal(await expireQueuedAttempts(client, db), 1);
      const expired = await attempts.findOne({ _id: attemptId });
      assert.equal(expired?.lifecycle, 'FINISHED');
      assert.equal(expired?.outcome, 'FAILED');
      assert.equal(expired?.reasonCode, 'queue_expired');
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'FAILED');
      assert.equal(await outbox.countDocuments({
        aggregate: jobId,
        type: 'LaneWakeRequested',
        'payload.reason': 'queue_expired',
      }), 1);
      assert.equal((await laneStep(client, db, jobId)).outcome, 'FAILED');
      assert.equal(await expireQueuedAttempts(client, db), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: jobId,
        type: 'LaneWakeRequested',
        'payload.reason': 'queue_expired',
      }), 1);
    });

    await check('pause at/after a queued cutoff cannot resurrect authority on resume', async () => {
      const jobId = await newJob('rr_pause_after_cutoff');
      const taskId = await createTask(client, db, jobId);
      const attemptId = (await dispatchAttempt(client, db, { jobId, taskId })).attemptId;
      await attempts.updateOne(
        { _id: attemptId },
        { $set: { businessOperationCutoffAt: new Date(Date.now() - 25) } },
      );

      const [, expiredByReducer] = await Promise.all([
        pauseJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_pause_after_cutoff_cmd',
          jobId,
        }),
        expireQueuedAttempts(client, db),
      ]);
      assert.ok(expiredByReducer === 0 || expiredByReducer === 1);
      const expired = await attempts.findOne({ _id: attemptId });
      assert.equal(expired?.lifecycle, 'FINISHED');
      assert.equal(expired?.outcome, 'FAILED');
      assert.equal(expired?.reasonCode, 'queue_expired');
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'FAILED');

      const resumed = await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'rr_resume_after_cutoff_cmd',
        jobId,
      });
      assert.equal(resumed.controlState, 'NONE');
      const terminal = await laneStep(client, db, jobId);
      assert.equal(terminal.action, 'terminalized');
      assert.equal(terminal.outcome, 'FAILED');
      assert.equal(await attempts.countDocuments({ taskId }), 1);
    });

    await check('SERIAL authority admits one claim for one attempt and one active attempt per task', async () => {
      const sameJob = await newJob('rr_same_attempt_claim');
      const sameTask = await createTask(client, db, sameJob);
      const sameAttempt = (await dispatchAttempt(client, db, {
        jobId: sameJob,
        taskId: sameTask,
      })).attemptId;
      const sameClaims = await Promise.all([
        claimAttempt(client, db, {
          attemptId: sameAttempt,
          workerInstanceId: 'worker:same',
        }),
        claimAttempt(client, db, {
          attemptId: sameAttempt,
          workerInstanceId: 'worker:same',
        }),
      ]);
      assert.equal(sameClaims.filter(Boolean).length, 1);
      assert.equal((await attempts.findOne({ _id: sameAttempt }))?.attemptFence, 1);
      assert.equal((await tasks.findOne({ _id: sameTask }))?.activeAttemptId, sameAttempt);

      const taskJob = await newJob('rr_same_task_claim');
      const taskId = await createTask(client, db, taskJob);
      const firstAttemptId = (await dispatchAttempt(client, db, {
        jobId: taskJob,
        taskId,
      })).attemptId;
      const firstAttempt = await attempts.findOne({ _id: firstAttemptId });
      assert.ok(firstAttempt);
      const secondAttemptId = `${firstAttemptId}_duplicate`;
      await attempts.insertOne({
        ...firstAttempt,
        _id: secondAttemptId,
        attemptNumber: firstAttempt.attemptNumber + 1,
        createdAt: new Date(firstAttempt.createdAt.getTime() + 1),
        updatedAt: new Date(firstAttempt.updatedAt.getTime() + 1),
      });
      const taskClaims = await Promise.all([
        claimAttempt(client, db, {
          attemptId: firstAttemptId,
          workerInstanceId: 'worker:serial-a',
        }),
        claimAttempt(client, db, {
          attemptId: secondAttemptId,
          workerInstanceId: 'worker:serial-b',
        }),
      ]);
      assert.equal(taskClaims.filter(Boolean).length, 1);
      assert.equal(await attempts.countDocuments({
        _id: { $in: [firstAttemptId, secondAttemptId] },
        lifecycle: 'LEASED',
      }), 1);
      const activeAttemptId = (await tasks.findOne({ _id: taskId }))?.activeAttemptId;
      assert.ok(activeAttemptId === firstAttemptId || activeAttemptId === secondAttemptId);
    });

    await check('concurrent lane dispatch treats a lost SERIAL CAS as an idempotent wait', async () => {
      const jobId = await newJob('rr_concurrent_lane_dispatch');
      const taskId = await createTask(client, db, jobId);
      const steps = await Promise.all([
        laneStep(client, db, jobId),
        laneStep(client, db, jobId),
      ]);
      assert.equal(steps.filter((step) => step.action === 'dispatched').length, 1);
      assert.equal(steps.filter((step) => step.action === 'wait').length, 1);
      assert.equal(await attempts.countDocuments({
        taskId,
        lifecycle: { $in: ['QUEUED', 'LEASED', 'RUNNING'] },
      }), 1);
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'DISPATCHED');
    });

    await check('planning/dispatch races with pause never create post-pause work', async () => {
      for (let index = 0; index < 8; index++) {
        const jobId = await newJob(`rr_dispatch_pause_race_${index}`);
        const taskId = await createTask(client, db, jobId);
        const [dispatch, paused] = await Promise.allSettled([
          dispatchAttempt(client, db, { jobId, taskId }),
          pauseJob(client, db, {
            resourceId: RESOURCE_ID,
            commandId: `rr_dispatch_pause_race_cmd_${index}`,
            jobId,
          }),
        ]);
        assert.equal(paused.status, 'fulfilled');
        assert.equal((await jobs.findOne({ _id: jobId }))?.controlState, 'PAUSE_REQUESTED');
        assert.equal(await attempts.countDocuments({
          taskId,
          lifecycle: { $in: ['QUEUED', 'LEASED', 'RUNNING'] },
        }), 0);
        assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'READY');
        if (dispatch.status === 'fulfilled') {
          const cancelled = await attempts.findOne({ _id: dispatch.value.attemptId });
          assert.equal(cancelled?.reasonCode, 'pause_interrupt');
        }
      }

      const planJobId = await newJob('rr_plan_pause_race');
      const [step] = await Promise.all([
        laneStep(client, db, planJobId),
        pauseJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_plan_pause_race_cmd',
          jobId: planJobId,
        }),
      ]);
      const planEvents = await events.find({
        jobId: planJobId,
        type: { $in: ['JobPlanned', 'JobPaused'] },
      }).sort({ sequence: 1 }).toArray();
      if (step.action === 'planned') {
        assert.deepEqual(planEvents.map((event) => event.type), ['JobPlanned', 'JobPaused']);
        assert.equal(await tasks.countDocuments({ jobId: planJobId }), 1);
      } else {
        assert.equal(step.action, 'wait');
        assert.deepEqual(planEvents.map((event) => event.type), ['JobPaused']);
        assert.equal(await tasks.countDocuments({ jobId: planJobId }), 0);
      }
    });

    await check('claim races with pause/cancel and linearizes on job authority', async () => {
      const pauseJobId = await newJob('rr_claim_pause_race');
      const pauseTaskId = await createTask(client, db, pauseJobId);
      const pauseAttemptId = (await dispatchAttempt(client, db, {
        jobId: pauseJobId,
        taskId: pauseTaskId,
      })).attemptId;
      const [pauseLease] = await Promise.all([
        claimAttempt(client, db, {
          attemptId: pauseAttemptId,
          workerInstanceId: 'worker:claim-pause-race',
        }),
        pauseJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_claim_pause_race_cmd',
          jobId: pauseJobId,
        }),
      ]);
      const pausedJob = await jobs.findOne({ _id: pauseJobId });
      const pausedAttempt = await attempts.findOne({ _id: pauseAttemptId });
      assert.equal(pausedJob?.controlState, 'PAUSE_REQUESTED');
      assert.equal(pausedAttempt?.lifecycle, 'FINISHED');
      assert.equal(pausedAttempt?.outcome, 'CANCELLED');
      assert.equal(pausedAttempt?.reasonCode, 'pause_interrupt');
      assert.equal((await tasks.findOne({ _id: pauseTaskId }))?.phase, 'READY');
      assert.equal((await tasks.findOne({ _id: pauseTaskId }))?.activeAttemptId, null);
      if (pauseLease) assert.ok(pausedAttempt!.attemptFence > pauseLease.attemptFence);

      const cancelJobId = await newJob('rr_claim_cancel_race');
      const cancelTaskId = await createTask(client, db, cancelJobId);
      const cancelAttemptId = (await dispatchAttempt(client, db, {
        jobId: cancelJobId,
        taskId: cancelTaskId,
      })).attemptId;
      const [cancelLease] = await Promise.all([
        claimAttempt(client, db, {
          attemptId: cancelAttemptId,
          workerInstanceId: 'worker:claim-cancel-race',
        }),
        cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_claim_cancel_race_cmd',
          jobId: cancelJobId,
        }),
      ]);
      assert.equal((await jobs.findOne({ _id: cancelJobId }))?.terminalOutcome, 'CANCELLED');
      const cancelAttempt = await attempts.findOne({ _id: cancelAttemptId });
      assert.equal(cancelAttempt?.lifecycle, 'FINISHED');
      assert.equal(cancelAttempt?.outcome, 'CANCELLED');
      assert.equal(cancelAttempt?.reasonCode, 'user_cancel');
      assert.equal((await tasks.findOne({ _id: cancelTaskId }))?.phase, 'CANCELLED');
      if (cancelLease) {
        assert.equal(await startAttemptOperation(client, db, {
          attemptId: cancelAttemptId,
          leaseOwner: 'worker:claim-cancel-race',
          attemptFence: cancelLease.attemptFence,
        }), false);
        const marker = await markAttemptPayloadReady(client, db, {
          attemptId: cancelAttemptId,
          leaseOwner: 'worker:claim-cancel-race',
          attemptFence: cancelLease.attemptFence,
          producer: { status: 'ok', data: { shouldCommit: false } },
        });
        assert.equal(marker.ready, false);
        assert.equal(marker.reason, 'stale_fence_or_lease_or_cutoff');
      }
    });

    await check('operation-start CAS, not claim, decides finish-current vs pause cancellation', async () => {
      const jobId = await newJob('rr_start_pause_race');
      const taskId = await createTask(client, db, jobId);
      const attemptId = (await dispatchAttempt(client, db, { jobId, taskId })).attemptId;
      const lease = await claimAttempt(client, db, {
        attemptId,
        workerInstanceId: 'worker:start-pause-race',
      });
      assert.ok(lease);
      assert.equal((await attempts.findOne({ _id: attemptId }))?.lifecycle, 'LEASED');

      const [started] = await Promise.all([
        startAttemptOperation(client, db, {
          attemptId,
          leaseOwner: 'worker:start-pause-race',
          attemptFence: lease.attemptFence,
        }),
        pauseJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_start_pause_race_cmd',
          jobId,
        }),
      ]);
      const job = await jobs.findOne({ _id: jobId });
      const attempt = await attempts.findOne({ _id: attemptId });
      assert.equal(job?.controlState, 'PAUSE_REQUESTED');
      if (started) {
        assert.equal(attempt?.lifecycle, 'RUNNING');
        assert.equal(attempt?.finishCurrentPauseGeneration, job?.pauseGeneration);
        assert.ok(attempt?.operationStartedAt);
      } else {
        assert.equal(attempt?.lifecycle, 'FINISHED');
        assert.equal(attempt?.outcome, 'CANCELLED');
        assert.equal(attempt?.reasonCode, 'pause_interrupt');
        assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'READY');
      }
    });

    await check('captured lease loss settles under pause before the same resume command can apply', async () => {
      const c = await claimed('rr_pause_reap_resume');
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'rr_pause_reap_resume_pause',
        jobId: c.jobId,
      });
      const blockedResume = await api.jobCommand(
        { resourceId: RESOURCE_ID, principalId: 'rr-principal' },
        c.jobId,
        { commandId: 'rr_pause_reap_resume_resume', type: 'resume_job' },
      );
      assert.equal(blockedResume.status, 409);
      assert.equal(blockedResume.body.error, 'pause_in_progress');
      await attempts.updateOne(
        { _id: c.attemptId },
        { $set: { leaseExpiresAt: new Date(Date.now() - 25) } },
      );
      assert.ok(await reapExpiredLeases(client, db, { maxAttempts: 3 }) > 0);
      const lost = await attempts.findOne({ _id: c.attemptId });
      assert.equal(lost?.outcome, 'WORKER_LOST');
      assert.equal((await tasks.findOne({ _id: c.taskId }))?.phase, 'RETRY_PENDING');
      const resumed = await api.jobCommand(
        { resourceId: RESOURCE_ID, principalId: 'rr-principal' },
        c.jobId,
        { commandId: 'rr_pause_reap_resume_resume', type: 'resume_job' },
      );
      assert.equal(resumed.status, 202, 'the same commandId applies after barrier settlement');
      assert.equal(resumed.body.controlState, 'NONE');
      const redispatch = await laneStep(client, db, c.jobId);
      assert.equal(redispatch.action, 'dispatched');
      assert.notEqual(redispatch.attemptId, c.attemptId);
      const fresh = await attempts.findOne({ _id: redispatch.attemptId });
      assert.equal(fresh?.attemptNumber, 2);
      assert.equal(fresh?.pauseGenerationAtDispatch, (await jobs.findOne({ _id: c.jobId }))?.pauseGeneration);
    });

    await check('pause never captures an already-expired RUNNING lease', async () => {
      const c = await claimed('rr_expired_running_before_pause');
      await attempts.updateOne(
        { _id: c.attemptId },
        { $set: { leaseExpiresAt: new Date(Date.now() - 25) } },
      );
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'rr_expired_running_pause',
        jobId: c.jobId,
      });
      assert.equal(
        (await attempts.findOne({ _id: c.attemptId }))?.finishCurrentPauseGeneration,
        null,
      );
      await assert.rejects(
        resumeJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_expired_running_resume',
          jobId: c.jobId,
        }),
        (err: unknown) => err instanceof PauseInProgressError,
      );
      assert.ok(await reapExpiredLeases(client, db, { maxAttempts: 3 }) > 0);
      assert.equal((await attempts.findOne({ _id: c.attemptId }))?.outcome, 'WORKER_LOST');
      assert.equal((await tasks.findOne({ _id: c.taskId }))?.phase, 'RETRY_PENDING');
      const resumed = await resumeJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'rr_expired_running_resume',
        jobId: c.jobId,
      });
      assert.equal(resumed.controlState, 'NONE');
    });

    await check('pause pre-start cancellations do not consume worker-loss retry budget', async () => {
      const jobId = await newJob('rr_pause_retry_budget');
      const taskId = await createTask(client, db, jobId);
      let attemptId = (await dispatchAttempt(client, db, { jobId, taskId })).attemptId;

      for (let generation = 1; generation <= 2; generation++) {
        await pauseJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: `rr_pause_retry_budget_pause_${generation}`,
          jobId,
        });
        assert.equal((await attempts.findOne({ _id: attemptId }))?.reasonCode, 'pause_interrupt');
        await resumeJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: `rr_pause_retry_budget_resume_${generation}`,
          jobId,
        });
        const next = await laneStep(client, db, jobId);
        assert.equal(next.action, 'dispatched');
        attemptId = next.attemptId!;
      }

      const lease = await claimAttempt(client, db, {
        attemptId,
        workerInstanceId: 'worker:pause-retry-budget',
      });
      assert.ok(lease);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId,
        leaseOwner: 'worker:pause-retry-budget',
        attemptFence: lease.attemptFence,
      }), true);
      await attempts.updateOne(
        { _id: attemptId },
        { $set: { leaseExpiresAt: new Date(Date.now() - 25) } },
      );
      assert.ok(await reapExpiredLeases(client, db, { maxAttempts: 2 }) > 0);
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'RETRY_PENDING');
      assert.equal(await attempts.countDocuments({ taskId, outcome: 'WORKER_LOST' }), 1);
      assert.equal(await attempts.countDocuments({ taskId, reasonCode: 'pause_interrupt' }), 2);
    });

    await check('cancel and lease recovery converge without retry work or false RUNNING settlement', async () => {
      const c = await claimed('rr_cancel_reaper_race');
      await attempts.updateOne(
        { _id: c.attemptId },
        { $set: { leaseExpiresAt: new Date(Date.now() - 25) } },
      );
      await Promise.all([
        reapExpiredLeases(client, db, { maxAttempts: 3, retryBackoffMs: 5_000 }),
        cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'rr_cancel_reaper_race_cmd',
          jobId: c.jobId,
        }),
      ]);
      const convergedJob = await jobs.findOne({ _id: c.jobId });
      const convergedTask = await tasks.findOne({ _id: c.taskId });
      if (convergedJob?.terminalOutcome === 'CANCELLED') {
        assert.equal(convergedTask?.phase, 'CANCELLED');
      } else {
        assert.equal(convergedJob?.phase, 'RECONCILING');
        assert.equal(convergedJob?.controlState, 'STOP_REQUESTED');
        assert.equal(convergedJob?.terminalOutcome, null);
        assert.equal(convergedJob?.pendingTerminalOutcome, 'CANCELLED');
        assert.equal(convergedTask?.phase, 'RECONCILING');
        assert.equal(await outbox.countDocuments({
          aggregate: c.jobId,
          type: 'JobTerminal',
        }), 0);
      }
      assert.equal(await attempts.countDocuments({
        jobId: c.jobId,
        lifecycle: { $in: ['QUEUED', 'LEASED', 'RUNNING', 'STOP_REQUESTED'] },
      }), 0);
      assert.equal(await db.collection(COLLECTIONS.timers).countDocuments({
        jobId: c.jobId,
        state: 'PENDING',
      }), 0);
      assert.equal(await outbox.countDocuments({
        aggregate: c.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
      }), 0);
    });

    await check('stale plan and a post-marker reaper fence both block A', async () => {
      const stalePlan = await claimed('rr_stale_plan');
      const staleProducer = { status: 'ok', data: { plan: 'old' } };
      const staleMarker = await markAttemptPayloadReady(client, db, {
        attemptId: stalePlan.attemptId,
        leaseOwner: stalePlan.worker,
        attemptFence: stalePlan.fence,
        producer: staleProducer,
      });
      assert.equal(staleMarker.ready, true);
      await jobs.updateOne(
        { _id: stalePlan.jobId },
        { $inc: { planVersion: 1, stateVersion: 1 }, $set: { updatedAt: new Date() } },
      );
      const staleA = await submitAttemptResult(client, db, {
        attemptId: stalePlan.attemptId,
        leaseOwner: stalePlan.worker,
        attemptFence: stalePlan.fence,
        producer: staleProducer,
        businessPayloadReadyGeneration: staleMarker.generation,
      });
      assert.deepEqual(staleA, { committed: false, reason: 'stale_plan_or_control' });
      assert.equal(await results.countDocuments({ attemptId: stalePlan.attemptId }), 0);

      const reaped = await claimed('rr_reaped_after_marker');
      const reapedProducer = { status: 'ok', data: { lease: 'expired' } };
      const reapedMarker = await markAttemptPayloadReady(client, db, {
        attemptId: reaped.attemptId,
        leaseOwner: reaped.worker,
        attemptFence: reaped.fence,
        producer: reapedProducer,
      });
      assert.equal(reapedMarker.ready, true);
      await attempts.updateOne(
        { _id: reaped.attemptId },
        { $set: { leaseExpiresAt: new Date(Date.now() - 25) } },
      );
      assert.ok(await reapExpiredLeases(client, db) > 0);
      const fenced = await attempts.findOne({ _id: reaped.attemptId });
      assert.equal(fenced?.outcome, 'WORKER_LOST');
      assert.ok(fenced!.attemptFence > reaped.fence);
      assert.equal((await tasks.findOne({ _id: reaped.taskId }))?.activeAttemptId, null);
      const afterReap = await submitAttemptResult(client, db, {
        attemptId: reaped.attemptId,
        leaseOwner: reaped.worker,
        attemptFence: reaped.fence,
        producer: reapedProducer,
        businessPayloadReadyGeneration: reapedMarker.generation,
      });
      assert.deepEqual(afterReap, { committed: false, reason: 'stale_fence_or_lease' });
      assert.equal(await results.countDocuments({ attemptId: reaped.attemptId }), 0);
    });

    await check('worker selection skips a poison prefix of unclaimable QUEUED rows', async () => {
      // Isolate this worker-selection assertion from QUEUED rows intentionally
      // left by earlier authority tests in the same throwaway database.
      await attempts.updateMany(
        { lifecycle: 'QUEUED' },
        { $set: { businessOperationCutoffAt: new Date(Date.now() - 1_000) } },
      );
      const poisonJobId = await newJob('rr_poison_queue');
      const poisonTaskId = await createTask(client, db, poisonJobId);
      const poisonAttemptId = (await dispatchAttempt(client, db, {
        jobId: poisonJobId,
        taskId: poisonTaskId,
      })).attemptId;
      const poison = await attempts.findOne({ _id: poisonAttemptId });
      assert.ok(poison);
      await attempts.insertMany(Array.from({ length: 105 }, (_, index) => ({
        ...poison,
        _id: `${poisonAttemptId}_poison_${index}`,
        attemptNumber: poison.attemptNumber + index + 1,
        createdAt: new Date(poison.createdAt.getTime() - index - 1),
        updatedAt: new Date(poison.updatedAt.getTime() - index - 1),
      })));
      // Deliberately make this synthetic prefix stale without invoking the
      // control reducer, whose job is to clean real pre-start admissions.
      await jobs.updateOne(
        { _id: poisonJobId },
        {
          $set: { controlState: 'PAUSE_REQUESTED', updatedAt: new Date() },
          $inc: { pauseGeneration: 1, stateVersion: 1 },
        },
      );

      const validJobId = await newJob('rr_after_poison');
      const validTaskId = await createTask(client, db, validJobId);
      const validAttemptId = (await dispatchAttempt(client, db, {
        jobId: validJobId,
        taskId: validTaskId,
      })).attemptId;
      assert.equal(await runWorkerOnce(client, db, () => ({
        status: 'ok',
        data: { selected: 'after-poison-prefix' },
      }), { workerInstanceId: 'worker:after-poison' }), true);
      assert.equal((await attempts.findOne({ _id: validAttemptId }))?.outcome, 'OK');
      assert.equal((await tasks.findOne({ _id: validTaskId }))?.phase, 'SUCCEEDED');
      assert.equal(await attempts.countDocuments({
        jobId: poisonJobId,
        lifecycle: 'QUEUED',
      }), 106);
    });

    await check('heartbeat covers slow context reads and operation-start CAS blocks post-pause work', async () => {
      function delayedContextReads(): {
        delayedDb: typeof db;
        readsStarted: Promise<void>;
        releaseReads: () => void;
      } {
        let releaseReads!: () => void;
        let signalReadsStarted!: () => void;
        const holdReads = new Promise<void>((resolve) => { releaseReads = resolve; });
        const readsStarted = new Promise<void>((resolve) => { signalReadsStarted = resolve; });
        const counts = new Map<string, number>();
        let blocked = 0;
        const delayedDb = new Proxy(db, {
          get(target, property) {
            if (property === 'collection') {
              return (name: string) => {
                const collection = target.collection(name);
                if (name !== COLLECTIONS.jobs && name !== COLLECTIONS.tasks) return collection;
                const originalFindOne = collection.findOne.bind(collection);
                return new Proxy(collection, {
                  get(collectionTarget, member) {
                    if (member === 'findOne') {
                      return async (...args: Parameters<typeof originalFindOne>) => {
                        const count = (counts.get(name) ?? 0) + 1;
                        counts.set(name, count);
                        if (count === 2) {
                          blocked++;
                          if (blocked === 2) signalReadsStarted();
                          await holdReads;
                        }
                        return originalFindOne(...args);
                      };
                    }
                    const value = Reflect.get(collectionTarget, member, collectionTarget);
                    return typeof value === 'function' ? value.bind(collectionTarget) : value;
                  },
                });
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as typeof db;
        return { delayedDb, readsStarted, releaseReads };
      }

      const slowJobId = await newJob('rr_slow_context_heartbeat');
      const slowTaskId = await createTask(client, db, slowJobId);
      const slowAttemptId = (await dispatchAttempt(client, db, {
        jobId: slowJobId,
        taskId: slowTaskId,
      })).attemptId;
      const slow = delayedContextReads();
      let slowFixtureCalled = false;
      const slowWorker = runWorkerOnce(client, slow.delayedDb, () => {
        slowFixtureCalled = true;
        return { status: 'ok', data: { slowContext: true } };
      }, {
        workerInstanceId: 'worker:slow-context',
        leaseTtlMs: 80,
        heartbeatEveryMs: 20,
      });
      await slow.readsStarted;
      await sleep(180);
      slow.releaseReads();
      assert.equal(await slowWorker, true);
      assert.equal(slowFixtureCalled, true);
      assert.equal((await attempts.findOne({ _id: slowAttemptId }))?.outcome, 'OK');

      const pausedJobId = await newJob('rr_pause_before_operation_start');
      const pausedTaskId = await createTask(client, db, pausedJobId);
      const pausedAttemptId = (await dispatchAttempt(client, db, {
        jobId: pausedJobId,
        taskId: pausedTaskId,
      })).attemptId;
      const paused = delayedContextReads();
      let pausedFixtureCalled = false;
      const pausedWorker = runWorkerOnce(client, paused.delayedDb, () => {
        pausedFixtureCalled = true;
        return { status: 'ok', data: { forbidden: true } };
      }, {
        workerInstanceId: 'worker:pause-before-start',
        leaseTtlMs: 80,
        heartbeatEveryMs: 20,
      });
      await paused.readsStarted;
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'rr_pause_before_start_cmd',
        jobId: pausedJobId,
      });
      paused.releaseReads();
      assert.equal(await pausedWorker, true);
      assert.equal(pausedFixtureCalled, false);
      const pausedAttempt = await attempts.findOne({ _id: pausedAttemptId });
      assert.equal(pausedAttempt?.lifecycle, 'FINISHED');
      assert.equal(pausedAttempt?.outcome, 'CANCELLED');
      assert.equal(pausedAttempt?.reasonCode, 'pause_interrupt');
      assert.equal(pausedAttempt?.operationStartedAt, null);
      assert.equal(await results.countDocuments({ attemptId: pausedAttemptId }), 0);
    });

    await check('pause during an in-flight fixture blocks a new marker after pause wins', async () => {
      const jobId = await newJob('rr_pause_during_fixture');
      const taskId = await createTask(client, db, jobId);
      const attemptId = (await dispatchAttempt(client, db, { jobId, taskId })).attemptId;
      let signalFixtureStarted!: () => void;
      const fixtureStarted = new Promise<void>((resolve) => {
        signalFixtureStarted = resolve;
      });
      const worker = runWorkerOnce(
        client,
        db,
        async () => {
          signalFixtureStarted();
          await sleep(180);
          return { status: 'ok', data: { finishedAfterPause: true } };
        },
        {
          workerInstanceId: 'worker:pause-during-fixture',
          leaseTtlMs: 90,
          heartbeatEveryMs: 20,
        },
      );
      await fixtureStarted;
      await pauseJob(client, db, {
        resourceId: RESOURCE_ID,
        commandId: 'rr_pause_during_fixture_cmd',
        jobId,
      });
      assert.equal(await worker, true);
      const attempt = await attempts.findOne({ _id: attemptId });
      const job = await jobs.findOne({ _id: jobId });
      assert.equal(job?.controlState, 'PAUSE_REQUESTED');
      assert.equal(attempt?.finishCurrentPauseGeneration, job?.pauseGeneration);
      assert.equal(attempt?.businessPayloadReadyGeneration, 0);
      assert.equal(attempt?.businessPayloadReadyPauseGeneration, null);
      assert.equal(attempt?.outcome, null);
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'DISPATCHED');
      assert.equal(await results.countDocuments({ attemptId }), 0);
    });

    await check('worker heartbeat preserves a short lease during model work', async () => {
      const jobId = await newJob('rr_heartbeat');
      const taskId = await createTask(client, db, jobId);
      const attemptId = (await dispatchAttempt(client, db, { jobId, taskId })).attemptId;
      const worked = await runWorkerOnce(
        client,
        db,
        async () => {
          await sleep(260);
          return { status: 'ok', data: { heartbeat: true } };
        },
        {
          workerInstanceId: 'worker:heartbeat',
          leaseTtlMs: 120,
          heartbeatEveryMs: 30,
        },
      );
      assert.equal(worked, true);
      assert.equal((await attempts.findOne({ _id: attemptId }))?.outcome, 'OK');
      assert.equal((await tasks.findOne({ _id: taskId }))?.phase, 'SUCCEEDED');
      assert.equal(await results.countDocuments({ attemptId }), 1);
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-result-ready — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-result-ready — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
