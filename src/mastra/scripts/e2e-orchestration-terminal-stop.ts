#!/usr/bin/env tsx
/**
 * e2e:orchestration-terminal-stop — PR-39 flat terminal-stop barrier.
 *
 * Proves against a real replica set that:
 *  - the exact stop receipt closes a flat job to CANCELLED exactly once and the
 *    C boundary projects that decision exactly once under transport replay;
 *  - grace exhaustion commits UNKNOWN_OUTCOME, while a later exact tree-empty
 *    liveness fact cannot upgrade or otherwise rewrite the business outcome;
 *  - a result-first A commit survives cancel + a late normal process receipt;
 *  - any dispatch edge is outside FLAT_STOP_V1 and fails closed durably.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 *   npm run spike:mongo-rs:up
 *   node --import tsx src/mastra/scripts/e2e-orchestration-terminal-stop.ts
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  AttemptProcessExitReceiptConflictError,
  AttemptStopReceiptConflictError,
  cancelJob,
  claimAttempt,
  COLLECTIONS,
  createTask,
  dispatchAttempt,
  drainConversation,
  ensureOrchestrationIndexes,
  fireDueAttemptStopTimers,
  markAttemptPayloadReady,
  reconcilePendingFlatTerminals,
  recordAttemptProcessExitReceipt,
  recordAttemptStopReceipt,
  recordPostStopUnknownProcessExitReceipt,
  reducePendingFlatTerminal,
  requestAttemptStop,
  startAttemptOperation,
  submitAttemptResult,
  TaskCreateAuthorityLostError,
  type AttemptDoc,
  type AttemptProcessOwnerDoc,
  type AttemptProcessOwnerRegistration,
  type DeliveryDoc,
  type DispatchEdgeDoc,
  type JobDoc,
  type JobEventDoc,
  type OutboxDoc,
  type ProjectionDoc,
  type ResultDoc,
  type TaskDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_terminal_stop';

let failures = 0;

async function check(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(
      `  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunningFixture {
  name: string;
  conversationId: string;
  jobId: string;
  taskId: string;
  attemptId: string;
  worker: string;
  attemptFence: number;
  processOwner: AttemptProcessOwnerDoc;
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-terminal-stop');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_terminal_stop_e2e_${Date.now()}`,
    section: 'e2e:orchestration-terminal-stop',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const edges = db.collection<DispatchEdgeDoc>(COLLECTIONS.edges);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  const projections =
    db.collection<ProjectionDoc>(COLLECTIONS.projections);
  const deliveries =
    db.collection<DeliveryDoc>(COLLECTIONS.deliveries);

  async function running(
    name: string,
    mode: 'FAKE_SUPERVISOR' | 'PROCESS_GROUP',
  ): Promise<RunningFixture> {
    const conversationId = `conv_terminal_stop:${name}`;
    const accepted = await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId,
      commandId: `start:${name}`,
      goal: `terminal-stop:${name}`,
      payload: { operation: name },
    });
    const taskId = await createTask(client, db, accepted.jobId);
    const { attemptId } = await dispatchAttempt(client, db, {
      jobId: accepted.jobId,
      taskId,
    });
    const worker = `worker:terminal-stop:${name}`;
    const lease = await claimAttempt(client, db, {
      attemptId,
      workerInstanceId: worker,
      leaseTtlMs: 30_000,
    });
    assert.ok(lease, 'claim must succeed');

    const syntheticPid = 40_000 + name.length;
    const processOwner: AttemptProcessOwnerRegistration = mode === 'PROCESS_GROUP'
      ? {
          processExecutionId: `process:${name}`,
          runtimeRunId: `runtime:${name}`,
          workerInstanceId: worker,
          ownerGeneration: 1,
          mode,
          hostId: 'host:terminal-stop',
          hostBootId: 'boot:terminal-stop',
          pidNamespaceId: 'pidns:terminal-stop',
          pid: syntheticPid,
          pgid: syntheticPid,
          sid: syntheticPid,
          processStartToken: `${1_000_000 + syntheticPid}`,
        }
      : {
          processExecutionId: `process:${name}`,
          runtimeRunId: `runtime:${name}`,
          workerInstanceId: worker,
          ownerGeneration: 1,
          mode,
          hostId: 'host:terminal-stop',
          hostBootId: 'boot:terminal-stop',
          pid: syntheticPid,
          pgid: syntheticPid,
          processStartToken: `fake-token:${name}`,
        };
    assert.equal(await startAttemptOperation(client, db, {
      attemptId,
      leaseOwner: worker,
      attemptFence: lease.attemptFence,
      processOwner,
    }), true);
    const persisted = await attempts.findOne({ _id: attemptId });
    assert.ok(persisted?.processOwner, 'process owner must be durable');

    return {
      name,
      conversationId,
      jobId: accepted.jobId,
      taskId,
      attemptId,
      worker,
      attemptFence: lease.attemptFence,
      processOwner: persisted.processOwner,
    };
  }

  function stopReceipt(
    fixture: RunningFixture,
    receiptId: string,
  ) {
    const observedAt = new Date();
    return {
      attemptId: fixture.attemptId,
      stopGeneration: 1,
      attemptFence: fixture.attemptFence,
      processOwner: fixture.processOwner,
      receiptId,
      terminationConfirmed: true as const,
      processTreeEmpty: true as const,
      exitCode: null,
      signal: 'SIGTERM',
      observedAt,
      treeEmptyAt: new Date(observedAt.getTime() + 1),
    };
  }

  function processExitReceipt(
    fixture: RunningFixture,
    receiptId: string,
  ) {
    const observedAt = new Date();
    return {
      attemptId: fixture.attemptId,
      attemptFence: fixture.attemptFence,
      processOwner: fixture.processOwner,
      receiptId,
      terminationConfirmed: true as const,
      processTreeEmpty: true as const,
      exitCode: 0,
      signal: null,
      observedAt,
      treeEmptyAt: new Date(observedAt.getTime() + 1),
    };
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check(
      'exact receipt terminalizes CANCELLED once and C projection dedups replay',
      async () => {
        const fixture = await running('exact', 'FAKE_SUPERVISOR');
        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:exact',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 30_000 });
        assert.equal(cancelled.terminalOutcome, null);
        assert.equal(cancelled.pendingTerminalOutcome, 'CANCELLED');

        const receipt = stopReceipt(fixture, 'receipt:terminal-stop:exact');
        const concurrentReceipts = await Promise.all([
          recordAttemptStopReceipt(client, db, receipt),
          recordAttemptStopReceipt(client, db, receipt),
        ]);
        assert.equal(
          concurrentReceipts.filter((entry) => entry?.recorded).length,
          1,
        );
        assert.equal(
          concurrentReceipts.filter((entry) => entry?.deduped).length,
          1,
        );
        assert.ok(concurrentReceipts.every(
          (entry) => entry?.outcome === 'CANCELLED',
        ));

        const [job, task] = await Promise.all([
          jobs.findOne({ _id: fixture.jobId }),
          tasks.findOne({ _id: fixture.taskId }),
        ]);
        assert.equal(job?.phase, 'TERMINAL');
        assert.equal(job?.terminalOutcome, 'CANCELLED');
        assert.equal(job?.pendingTerminalOutcome, null);
        assert.equal(job?.terminalBarrierMode, 'FLAT_STOP_V1');
        assert.equal(task?.phase, 'CANCELLED');
        assert.equal(task?.activeAttemptId, null);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);

        const replay = await recordAttemptStopReceipt(client, db, receipt);
        assert.equal(replay?.recorded, false);
        assert.equal(replay?.deduped, true);
        await assert.rejects(
          () => recordAttemptStopReceipt(client, db, {
            ...receipt,
            treeEmptyAt: new Date(receipt.treeEmptyAt.getTime() + 1),
          }),
          (error: unknown) => error instanceof AttemptStopReceiptConflictError,
          'a reused receipt id cannot hide a changed immutable payload',
        );
        const reductionReplay = await reducePendingFlatTerminal(
          client,
          db,
          fixture.jobId,
        );
        assert.equal(reductionReplay.status, 'already_terminal');
        await assert.rejects(
          () => createTask(client, db, fixture.jobId),
          (error: unknown) => error instanceof TaskCreateAuthorityLostError,
          'terminal job cannot admit a phantom READY task',
        );
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);

        assert.equal(await drainConversation(client, db), 1);
        assert.equal(
          await drainConversation(client, db),
          0,
          'replaying the C drain produces no second projection',
        );
        const projection = await projections.findOne({
          jobId: fixture.jobId,
        });
        assert.equal(projection?.conversationId, fixture.conversationId);
        assert.equal(
          (projection?.payload as { terminalOutcome?: string })
            .terminalOutcome,
          'CANCELLED',
        );
        assert.equal(await projections.countDocuments({
          jobId: fixture.jobId,
        }), 1);
        assert.equal(await deliveries.countDocuments({
          projectionId: projection?._id,
        }), 1);
      },
    );

    await check(
      'grace UNKNOWN terminal remains UNKNOWN after late exact liveness proof',
      async () => {
        const fixture = await running('grace', 'PROCESS_GROUP');
        await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:grace',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 40 });
        const requested = await attempts.findOne({ _id: fixture.attemptId });
        const dueAt = requested?.attemptStopGraceDueAt;
        assert.ok(dueAt);
        await sleep(Math.max(0, dueAt.getTime() - Date.now() + 80));

        assert.equal(await fireDueAttemptStopTimers(client, db), 1);
        const reduced = await reducePendingFlatTerminal(
          client,
          db,
          fixture.jobId,
        );
        assert.equal(reduced.status, 'terminalized');
        assert.equal(reduced.outcome, 'UNKNOWN_OUTCOME');
        const beforeLateFact = await jobs.findOne({ _id: fixture.jobId });
        assert.equal(beforeLateFact?.phase, 'TERMINAL');
        assert.equal(beforeLateFact?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal((await tasks.findOne({
          _id: fixture.taskId,
        }))?.phase, 'UNKNOWN_OUTCOME');

        const lateReceipt = {
          ...processExitReceipt(
            fixture,
            'receipt:terminal-stop:post-grace',
          ),
          stopGeneration: requested?.stopGeneration ?? 1,
        };
        const late = await recordPostStopUnknownProcessExitReceipt(
          client,
          db,
          lateReceipt,
        );
        assert.equal(late?.recorded, true);
        assert.equal(late?.outcome, 'UNKNOWN_OUTCOME');
        const replay = await recordPostStopUnknownProcessExitReceipt(
          client,
          db,
          lateReceipt,
        );
        assert.equal(replay?.recorded, false);
        assert.equal(replay?.deduped, true);
        await assert.rejects(
          () => recordPostStopUnknownProcessExitReceipt(client, db, {
            ...lateReceipt,
            treeEmptyAt: new Date(lateReceipt.treeEmptyAt.getTime() + 1),
          }),
          (error: unknown) =>
            error instanceof AttemptProcessExitReceiptConflictError,
          'post-stop receipt replay is immutable by hash, not id alone',
        );

        const [attempt, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(attempt?.outcome, 'UNKNOWN_OUTCOME');
        assert.equal(attempt?.reasonCode, 'attempt_stop_unconfirmed');
        assert.equal(attempt?.processState, 'EXITED');
        assert.equal(attempt?.terminationConfirmed, true);
        assert.equal(
          attempt?.processExitReceipt?.confirmationKind,
          'POST_STOP_UNKNOWN_TREE_EMPTY',
        );
        assert.equal(
          attempt?.processExitReceipt?.stopGeneration,
          requested?.stopGeneration,
        );
        assert.equal(job?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
      },
    );

    await check(
      'result-first cancel + normal late receipt preserves A and terminalizes UNKNOWN',
      async () => {
        const fixture = await running('result-first', 'PROCESS_GROUP');
        const producer = {
          status: 'ok',
          data: { committedBeforeCancel: true },
        };
        const marker = await markAttemptPayloadReady(client, db, {
          attemptId: fixture.attemptId,
          leaseOwner: fixture.worker,
          attemptFence: fixture.attemptFence,
          producer,
        });
        assert.equal(marker.ready, true);
        const committed = await submitAttemptResult(client, db, {
          attemptId: fixture.attemptId,
          leaseOwner: fixture.worker,
          attemptFence: fixture.attemptFence,
          producer,
          businessPayloadReadyGeneration: marker.generation,
        });
        assert.equal(committed.committed, true);
        const before = await attempts.findOne({ _id: fixture.attemptId });
        assert.ok(before?.resultId);
        const resultBefore = await results.findOne({ _id: before.resultId });
        assert.ok(resultBefore);

        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:result-first',
          jobId: fixture.jobId,
        });
        assert.equal(cancelled.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(cancelled.pendingTerminalOutcome, null);

        const receiptInput = processExitReceipt(
          fixture,
          'receipt:terminal-stop:result-first',
        );
        const receipt = await recordAttemptProcessExitReceipt(
          client,
          db,
          receiptInput,
        );
        assert.equal(receipt?.recorded, true);
        assert.equal(receipt?.outcome, 'OK');
        const replay = await recordAttemptProcessExitReceipt(
          client,
          db,
          receiptInput,
        );
        assert.equal(replay?.recorded, false);
        assert.equal(replay?.deduped, true);
        await assert.rejects(
          () => recordAttemptProcessExitReceipt(client, db, {
            ...receiptInput,
            treeEmptyAt: new Date(receiptInput.treeEmptyAt.getTime() + 1),
          }),
          (error: unknown) =>
            error instanceof AttemptProcessExitReceiptConflictError,
          'normal receipt replay is immutable by hash, not id alone',
        );

        const [after, resultAfter, task, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          results.findOne({ _id: before.resultId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(after?.outcome, 'OK');
        assert.equal(after?.resultId, before.resultId);
        assert.equal(
          after?.ACommittedAt?.getTime(),
          before.ACommittedAt?.getTime(),
        );
        assert.equal(after?.committedPayloadHash, before.committedPayloadHash);
        assert.deepEqual(resultAfter, resultBefore);
        assert.equal(after?.terminationConfirmed, true);
        assert.equal(
          after?.processExitReceipt?.confirmationKind,
          'NORMAL_PROCESS_TREE_EMPTY',
        );
        assert.equal(task?.phase, 'SUCCEEDED');
        assert.equal(job?.phase, 'TERMINAL');
        assert.equal(job?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(job?.pendingTerminalOutcome, null);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
      },
    );

    await check(
      'normal tree-empty before cancel settles without a second stop receipt',
      async () => {
        const fixture = await running('normal-exit-before-cancel', 'PROCESS_GROUP');
        const exit = await recordAttemptProcessExitReceipt(
          client,
          db,
          processExitReceipt(
            fixture,
            'receipt:terminal-stop:normal-before-cancel',
          ),
        );
        assert.equal(exit?.recorded, true);
        assert.equal((await attempts.findOne({
          _id: fixture.attemptId,
        }))?.lifecycle, 'RUNNING');

        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:normal-exit-before-cancel',
          jobId: fixture.jobId,
        });
        assert.equal(cancelled.terminalOutcome, 'CANCELLED');
        const [attempt, task, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(attempt?.lifecycle, 'FINISHED');
        assert.equal(attempt?.outcome, 'CANCELLED');
        assert.equal(attempt?.reasonCode, 'user_cancel');
        assert.equal(attempt?.attemptFence, fixture.attemptFence + 1);
        assert.equal(attempt?.stopGeneration, 0);
        assert.equal(attempt?.stopReceipt, null);
        assert.equal(
          attempt?.processExitReceipt?.confirmationKind,
          'NORMAL_PROCESS_TREE_EMPTY',
        );
        assert.equal(task?.phase, 'CANCELLED');
        assert.equal(job?.phase, 'TERMINAL');
        assert.equal(job?.terminalOutcome, 'CANCELLED');
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopRequested',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
      },
    );

    await check(
      'confirmed UNKNOWN before cancel remains the universal job override',
      async () => {
        const fixture = await running('unknown-before-cancel', 'PROCESS_GROUP');
        const stop = await requestAttemptStop(client, db, {
          attemptId: fixture.attemptId,
          cause: 'lease_lost',
          graceMs: 20,
          jobStopGenerationAtStop: 0,
        });
        assert.ok(stop?.attemptStopGraceDueAt);
        await sleep(Math.max(
          0,
          stop.attemptStopGraceDueAt.getTime() - Date.now() + 60,
        ));
        assert.equal(await fireDueAttemptStopTimers(client, db), 1);
        const late = await recordPostStopUnknownProcessExitReceipt(
          client,
          db,
          {
            ...processExitReceipt(
              fixture,
              'receipt:terminal-stop:unknown-before-cancel',
            ),
            stopGeneration: stop.stopGeneration,
          },
        );
        assert.equal(late?.recorded, true);
        assert.equal((await jobs.findOne({
          _id: fixture.jobId,
        }))?.terminalOutcome, null);

        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:unknown-before-cancel',
          jobId: fixture.jobId,
        });
        assert.equal(cancelled.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(cancelled.pendingTerminalOutcome, null);
        const [attempt, task, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(attempt?.outcome, 'UNKNOWN_OUTCOME');
        assert.equal(attempt?.terminationConfirmed, true);
        assert.equal(task?.phase, 'UNKNOWN_OUTCOME');
        assert.equal(job?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(job?.primaryJobStopCause, 'user_cancel');
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
      },
    );

    await check(
      'EVIDENCE_ONLY fails closed as a durable unsupported obligation',
      async () => {
        const fixture = await running('evidence-only', 'FAKE_SUPERVISOR');
        await attempts.updateOne(
          {
            _id: fixture.attemptId,
            lifecycle: 'RUNNING',
          },
          {
            $set: {
              lifecycle: 'EVIDENCE_ONLY',
              updatedAt: new Date(),
            },
          },
        );

        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:evidence-only',
          jobId: fixture.jobId,
        });
        assert.equal(cancelled.terminalOutcome, null);
        const [attempt, task, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(attempt?.lifecycle, 'EVIDENCE_ONLY');
        assert.equal(task?.phase, 'RECONCILING');
        assert.equal(task?.controlState, 'STOP_REQUESTED');
        assert.equal(job?.phase, 'RECONCILING');
        assert.equal(job?.pendingTerminalOutcome, 'CANCELLED');
        assert.equal(job?.terminalBarrierMode, 'BLOCKED_UNSUPPORTED');
        assert.equal(job?.terminalBarrierBlocker, 'evidence_only_attempt');
        assert.equal(await reconcilePendingFlatTerminals(client, db), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'terminal_barrier_unsupported',
          'payload.blocker': 'evidence_only_attempt',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopRequested',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 0);
      },
    );

    await check(
      'any dispatch edge durably blocks the flat terminal reducer',
      async () => {
        const fixture = await running('edge', 'FAKE_SUPERVISOR');
        await edges.insertOne({
          _id: `edge:terminal-stop:${fixture.jobId}`,
          jobId: fixture.jobId,
          parentTaskId: fixture.taskId,
          childTaskId: `unsupported-child:${fixture.jobId}`,
          completionMode: 'REQUIRED',
          lifecycle: 'ACTIVE',
          createdAt: new Date(),
        });
        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:edge',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 30_000 });
        assert.equal(cancelled.terminalOutcome, null);

        const receipt = await recordAttemptStopReceipt(
          client,
          db,
          stopReceipt(fixture, 'receipt:terminal-stop:edge'),
        );
        assert.equal(receipt?.recorded, true);
        const reduction = await reducePendingFlatTerminal(
          client,
          db,
          fixture.jobId,
        );
        assert.equal(reduction.status, 'blocked');
        assert.equal(reduction.blocker, 'dispatch_edge_present');
        const job = await jobs.findOne({ _id: fixture.jobId });
        assert.equal(job?.phase, 'RECONCILING');
        assert.equal(job?.terminalOutcome, null);
        assert.equal(job?.pendingTerminalOutcome, 'CANCELLED');
        assert.equal(job?.terminalBarrierMode, 'BLOCKED_UNSUPPORTED');
        assert.equal(job?.terminalBarrierBlocker, 'dispatch_edge_present');
        assert.equal(await reconcilePendingFlatTerminals(client, db), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'terminal_barrier_unsupported',
          'payload.blocker': 'dispatch_edge_present',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 0);
      },
    );
  } finally {
    await db.dropDatabase().catch(() => {});
    await store.close();
  }

  if (failures > 0) {
    console.error(
      `\n❌ e2e:orchestration-terminal-stop — ${failures} failure(s)`,
    );
    process.exit(1);
  }
  console.log(
    '\n✅ e2e:orchestration-terminal-stop — all assertions passed',
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(
    `e2e failed: ${(error as Error).stack ?? (error as Error).message}`,
  );
  process.exit(1);
});
