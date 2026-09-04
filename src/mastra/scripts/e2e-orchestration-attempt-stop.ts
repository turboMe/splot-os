#!/usr/bin/env tsx
/**
 * e2e:orchestration-attempt-stop — durable PROCESS_STOP_V1 (§7.1/§7.3/§8.6).
 *
 * Proves against a real replica set that cancel does not falsely terminalize a
 * job while a supervised process may still be alive. The focused slice covers
 * exact process-owner observation, immutable stop epochs, trusted receipts,
 * fail-closed grace expiry, and lease-loss retry suppression.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 *   npm run spike:mongo-rs:up && npm run e2e:orchestration-attempt-stop
 */
import assert from 'node:assert/strict';
import {
  acceptStartCommand,
  AttemptStopReceiptConflictError,
  cancelJob,
  claimAttempt,
  COLLECTIONS,
  CONTROL_BUDGET_POLICY_V1,
  createTask,
  dispatchAttempt,
  ensureOrchestrationIndexes,
  fireDueAttemptStopTimers,
  InvalidAttemptStopReceiptError,
  markAttemptPayloadReady,
  observeAttemptStopRequest,
  reapExpiredLeases,
  recordAttemptStopReceipt,
  startAttemptOperation,
  submitAttemptResult,
  type AttemptDoc,
  type AttemptProcessOwnerDoc,
  type AttemptProcessOwnerRegistration,
  type BudgetReservationDoc,
  type JobDoc,
  type JobEventDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type RecordAttemptStopReceiptInput,
  type ResultDoc,
  type TaskDoc,
  type TimerDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_attempt_stop';
const CONVERSATION_ID = 'conv_attempt_stop';

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
  jobId: string;
  taskId: string;
  attemptId: string;
  worker: string;
  attemptFence: number;
  leaseExpiresAt: Date;
  processOwner: AttemptProcessOwnerDoc;
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-attempt-stop');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_attempt_stop_e2e_${Date.now()}`,
    section: 'e2e:orchestration-attempt-stop',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const timers = db.collection<TimerDoc>(COLLECTIONS.timers);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  const activations =
    db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const reservations =
    db.collection<BudgetReservationDoc>(COLLECTIONS.budgetReservations);

  async function running(name: string): Promise<RunningFixture> {
    const accepted = await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      commandId: `start:${name}`,
      goal: `process-stop:${name}`,
      payload: { op: name },
    });
    const taskId = await createTask(client, db, accepted.jobId);
    const { attemptId } = await dispatchAttempt(client, db, {
      jobId: accepted.jobId,
      taskId,
    });
    const worker = `worker:${name}`;
    const lease = await claimAttempt(client, db, {
      attemptId,
      workerInstanceId: worker,
      leaseTtlMs: 30_000,
    });
    assert.ok(lease, 'claim must succeed');

    const registration: AttemptProcessOwnerRegistration = {
      processExecutionId: `process:${name}`,
      runtimeRunId: `runtime:${name}`,
      workerInstanceId: worker,
      ownerGeneration: 1,
      mode: 'FAKE_SUPERVISOR',
      hostId: 'host:test',
      hostBootId: 'boot:test',
      pid: 20_000 + name.length,
      pgid: 30_000 + name.length,
      processStartToken: `start-token:${name}`,
    };
    assert.equal(await startAttemptOperation(client, db, {
      attemptId,
      leaseOwner: worker,
      attemptFence: lease.attemptFence,
      processOwner: registration,
    }), true);

    const persisted = await attempts.findOne({ _id: attemptId });
    assert.ok(persisted?.processOwner, 'operation start persisted process owner');
    assert.equal(persisted.lifecycle, 'RUNNING');
    assert.equal(persisted.processState, 'OWNED');
    assert.ok(persisted.leaseExpiresAt);
    return {
      jobId: accepted.jobId,
      taskId,
      attemptId,
      worker,
      attemptFence: lease.attemptFence,
      leaseExpiresAt: persisted.leaseExpiresAt,
      processOwner: persisted.processOwner,
    };
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check(
      'RUNNING cancel is pending, observable only by the exact owner, and receipt is immutable',
      async () => {
        const fixture = await running('receipt');
        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:receipt',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 10_000 });
        assert.deepEqual(cancelled, {
          jobId: fixture.jobId,
          controlState: 'STOP_REQUESTED',
          terminalOutcome: null,
          pendingTerminalOutcome: 'CANCELLED',
          alreadyTerminal: false,
          deduped: false,
        });

        const [job, task, stopped] = await Promise.all([
          jobs.findOne({ _id: fixture.jobId }),
          tasks.findOne({ _id: fixture.taskId }),
          attempts.findOne({ _id: fixture.attemptId }),
        ]);
        assert.equal(job?.phase, 'RECONCILING');
        assert.equal(job?.controlState, 'STOP_REQUESTED');
        assert.equal(job?.terminalOutcome, null);
        assert.equal(job?.pendingTerminalOutcome, 'CANCELLED');
        assert.equal(job?.primaryJobStopCause, 'user_cancel');
        assert.equal(job?.jobStopGeneration, 1);
        assert.equal(task?.phase, 'RECONCILING');
        assert.equal(task?.controlState, 'STOP_REQUESTED');
        assert.equal(task?.stopGeneration, 1);
        assert.equal(task?.activeAttemptId, fixture.attemptId);
        assert.equal(stopped?.lifecycle, 'STOP_REQUESTED');
        assert.equal(stopped?.outcome, null);
        assert.equal(stopped?.processState, 'STOP_REQUESTED');
        assert.equal(stopped?.terminationConfirmed, null);
        assert.equal(stopped?.leaseOwner, fixture.worker);
        assert.equal(
          stopped?.leaseExpiresAt?.getTime(),
          fixture.leaseExpiresAt.getTime(),
        );
        assert.equal(stopped?.attemptFence, fixture.attemptFence);
        assert.equal(stopped?.stopGeneration, 1);
        assert.equal(stopped?.attemptStopTimerGeneration, 1);
        assert.equal(stopped?.primaryAttemptStopCause, 'user_cancel');
        assert.deepEqual(stopped?.secondaryAttemptStopCauses, []);
        assert.deepEqual(stopped?.processOwner, fixture.processOwner);
        assert.ok(stopped?.attemptStopGraceDueAt);

        const observation = await observeAttemptStopRequest(db, {
          attemptId: fixture.attemptId,
          processOwner: fixture.processOwner,
        });
        assert.ok(observation, 'the exact registered owner observes the stop');
        assert.equal(observation.stopGeneration, 1);
        assert.equal(observation.attemptFence, fixture.attemptFence);
        assert.equal(observation.primaryAttemptStopCause, 'user_cancel');
        const mismatchedOwners: Array<{
          field: string;
          owner: AttemptProcessOwnerDoc;
        }> = [
          {
            field: 'processExecutionId',
            owner: {
              ...fixture.processOwner,
              processExecutionId: 'wrong-process-execution',
            },
          },
          {
            field: 'runtimeRunId',
            owner: {
              ...fixture.processOwner,
              runtimeRunId: 'wrong-runtime-run',
            },
          },
          {
            field: 'workerInstanceId',
            owner: {
              ...fixture.processOwner,
              workerInstanceId: 'wrong-worker',
            },
          },
          {
            field: 'ownerGeneration',
            owner: {
              ...fixture.processOwner,
              ownerGeneration: fixture.processOwner.ownerGeneration + 1,
            },
          },
          {
            field: 'mode',
            owner: {
              ...fixture.processOwner,
              mode: 'PROCESS_GROUP',
            },
          },
          {
            field: 'hostId',
            owner: {
              ...fixture.processOwner,
              hostId: 'wrong-host',
            },
          },
          {
            field: 'hostBootId',
            owner: {
              ...fixture.processOwner,
              hostBootId: 'wrong-boot',
            },
          },
          {
            field: 'pid',
            owner: {
              ...fixture.processOwner,
              pid: fixture.processOwner.pid + 1,
            },
          },
          {
            field: 'pgid',
            owner: {
              ...fixture.processOwner,
              pgid: fixture.processOwner.pgid + 1,
            },
          },
          {
            field: 'processStartToken',
            owner: {
              ...fixture.processOwner,
              processStartToken: 'wrong-process-start-token',
            },
          },
          {
            field: 'registeredAt',
            owner: {
              ...fixture.processOwner,
              registeredAt: new Date(
                fixture.processOwner.registeredAt.getTime() + 1,
              ),
            },
          },
          {
            field: 'startedAt',
            owner: {
              ...fixture.processOwner,
              startedAt: new Date(
                fixture.processOwner.startedAt.getTime() + 1,
              ),
            },
          },
        ];
        for (const mismatch of mismatchedOwners) {
          assert.equal(await observeAttemptStopRequest(db, {
            attemptId: fixture.attemptId,
            processOwner: mismatch.owner,
          }), null, `${mismatch.field} mismatch cannot observe the stop`);
        }

        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
          state: 'PENDING',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopRequested',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobStopRequested',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 0);

        const graceMs = stopped.attemptStopGraceDueAt!.getTime();
        const jobStateVersion = job!.stateVersion;
        const jobControlVersion = job!.controlVersion;
        const activationDispatchGeneration =
          job!.activationDispatchGeneration;
        const jobGeneration = job!.jobStopGeneration;
        const jobGraceMs = job!.stopGraceDueAt!.getTime();
        const taskGeneration = task!.stopGeneration;
        const stopGeneration = stopped.stopGeneration;
        const timerGeneration = stopped.attemptStopTimerGeneration;

        const sameCommand = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:receipt',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 1 });
        assert.equal(sameCommand.deduped, true);
        assert.equal(sameCommand.alreadyTerminal, false);
        assert.equal(sameCommand.terminalOutcome, null);
        assert.equal(sameCommand.pendingTerminalOutcome, 'CANCELLED');

        const differentCommand = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:receipt:other',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 1 });
        assert.equal(differentCommand.deduped, false);
        assert.equal(differentCommand.alreadyTerminal, false);
        assert.equal(differentCommand.terminalOutcome, null);
        assert.equal(differentCommand.pendingTerminalOutcome, 'CANCELLED');

        const [dedupedJob, dedupedTask, dedupedAttempt] = await Promise.all([
          jobs.findOne({ _id: fixture.jobId }),
          tasks.findOne({ _id: fixture.taskId }),
          attempts.findOne({ _id: fixture.attemptId }),
        ]);
        assert.equal(dedupedJob?.stateVersion, jobStateVersion);
        assert.equal(dedupedJob?.controlVersion, jobControlVersion);
        assert.equal(
          dedupedJob?.activationDispatchGeneration,
          activationDispatchGeneration,
        );
        assert.equal(dedupedJob?.jobStopGeneration, jobGeneration);
        assert.equal(dedupedJob?.stopGraceDueAt?.getTime(), jobGraceMs);
        assert.equal(dedupedTask?.stopGeneration, taskGeneration);
        assert.equal(dedupedAttempt?.stopGeneration, stopGeneration);
        assert.equal(
          dedupedAttempt?.attemptStopTimerGeneration,
          timerGeneration,
        );
        assert.equal(
          dedupedAttempt?.attemptStopGraceDueAt?.getTime(),
          graceMs,
        );
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobStopRequested',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopRequested',
        }), 1);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
        }), 1);

        const producer = { status: 'ok', data: { late: true } };
        const marker = await markAttemptPayloadReady(client, db, {
          attemptId: fixture.attemptId,
          leaseOwner: fixture.worker,
          attemptFence: fixture.attemptFence,
          producer,
        });
        assert.equal(marker.ready, false);
        assert.equal(marker.reason, 'stale_fence_or_lease_or_cutoff');
        const late = await submitAttemptResult(client, db, {
          attemptId: fixture.attemptId,
          leaseOwner: fixture.worker,
          attemptFence: fixture.attemptFence,
          producer,
        });
        assert.deepEqual(late, {
          committed: false,
          reason: 'stale_fence_or_lease',
        });
        assert.equal(await db.collection(COLLECTIONS.results).countDocuments({
          attemptId: fixture.attemptId,
        }), 0);

        const receipt: RecordAttemptStopReceiptInput = {
          attemptId: fixture.attemptId,
          stopGeneration: stopped.stopGeneration!,
          attemptFence: fixture.attemptFence,
          processOwner: fixture.processOwner,
          receiptId: 'receipt:exact',
          terminationConfirmed: true,
          processTreeEmpty: true,
          exitCode: null,
          signal: 'SIGTERM',
          observedAt: new Date(),
          treeEmptyAt: new Date(),
        };
        for (const mismatch of mismatchedOwners) {
          assert.equal(await recordAttemptStopReceipt(client, db, {
            ...receipt,
            receiptId: `receipt:wrong-${mismatch.field}`,
            processOwner: mismatch.owner,
          }), null, `${mismatch.field} mismatch cannot acknowledge the stop`);
        }
        assert.equal(await recordAttemptStopReceipt(client, db, {
          ...receipt,
          receiptId: 'receipt:stale-generation',
          stopGeneration: receipt.stopGeneration + 1,
        }), null);
        const staleFenceOwner: AttemptProcessOwnerDoc = {
          ...fixture.processOwner,
          attemptFence: fixture.attemptFence + 1,
        };
        assert.equal(await recordAttemptStopReceipt(client, db, {
          ...receipt,
          receiptId: 'receipt:stale-fence',
          attemptFence: fixture.attemptFence + 1,
          processOwner: staleFenceOwner,
        }), null);
        await assert.rejects(
          () => recordAttemptStopReceipt(client, db, {
            ...receipt,
            receiptId: 'receipt:unconfirmed',
            terminationConfirmed: false,
          } as unknown as RecordAttemptStopReceiptInput),
          (error: unknown) => error instanceof InvalidAttemptStopReceiptError,
        );
        assert.equal(
          (await attempts.findOne({ _id: fixture.attemptId }))?.stopReceipt,
          null,
        );

        const recorded = await recordAttemptStopReceipt(client, db, receipt);
        assert.deepEqual(recorded, {
          attemptId: fixture.attemptId,
          stopGeneration: 1,
          outcome: 'CANCELLED',
          receiptId: 'receipt:exact',
          recorded: true,
          deduped: false,
        });
        const stopOwnersAfterRecord = await activations.countDocuments({
          jobId: fixture.jobId,
          controlSubtype: 'STOP_TERMINAL',
        });
        const replay = await recordAttemptStopReceipt(client, db, receipt);
        assert.deepEqual(replay, {
          attemptId: fixture.attemptId,
          stopGeneration: 1,
          outcome: 'CANCELLED',
          receiptId: 'receipt:exact',
          recorded: false,
          deduped: true,
        });
        assert.equal(await activations.countDocuments({
          jobId: fixture.jobId,
          controlSubtype: 'STOP_TERMINAL',
        }), stopOwnersAfterRecord, 'receipt replay cannot mint another owner');
        assert.equal(await recordAttemptStopReceipt(client, db, {
          ...receipt,
          receiptId: 'receipt:late-stale-generation',
          stopGeneration: receipt.stopGeneration + 1,
        }), null, 'a stale receipt replay is a no-op, not a current-epoch conflict');
        await assert.rejects(
          () => recordAttemptStopReceipt(client, db, {
            ...receipt,
            receiptId: 'receipt:conflict',
          }),
          (error: unknown) => error instanceof AttemptStopReceiptConflictError,
        );

        const [finished, reconciledTask, reconciledJob] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(finished?.lifecycle, 'FINISHED');
        assert.equal(finished?.outcome, 'CANCELLED');
        assert.equal(finished?.reasonCode, 'user_cancel');
        assert.equal(finished?.processState, 'EXITED');
        assert.equal(finished?.terminationConfirmed, true);
        assert.equal(finished?.attemptFence, fixture.attemptFence + 1);
        assert.equal(finished?.leaseOwner, null);
        assert.equal(finished?.leaseExpiresAt, null);
        assert.equal(finished?.stopReceipt?.receiptId, 'receipt:exact');
        assert.equal(finished?.stopReceipt?.processTreeEmpty, true);
        assert.equal(reconciledTask?.phase, 'CANCELLED');
        assert.equal(reconciledTask?.controlState, 'STOP_REQUESTED');
        assert.equal(reconciledTask?.activeAttemptId, null);
        assert.equal(reconciledJob?.phase, 'TERMINAL');
        assert.equal(reconciledJob?.controlState, 'STOP_REQUESTED');
        assert.equal(reconciledJob?.terminalOutcome, 'CANCELLED');
        assert.equal(reconciledJob?.pendingTerminalOutcome, null);
        assert.equal(reconciledJob?.jobStopGeneration, 1);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
          state: 'CANCELLED',
        }), 1);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopped',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
        }), 0);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobCancelled',
        }), 0);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
        const receiptOwner = await activations.find({
          jobId: fixture.jobId,
          controlSubtype: 'STOP_TERMINAL',
        }).sort({ createdAt: -1, _id: -1 }).limit(1).next();
        assert.equal(receiptOwner?.lifecycle, 'COMMITTED');
        assert.ok(receiptOwner?.budgetReservationId);
        const receiptReservation = await reservations.findOne({
          _id: receiptOwner!.budgetReservationId!,
        });
        assert.equal(receiptReservation?.state, 'SETTLED');
        assert.equal(receiptReservation?.settlementReason, 'COMMITTED');
        const receiptReservations = await reservations.find({
          jobId: fixture.jobId,
        }).toArray();
        assert.ok(receiptReservations.length >= 1);
        assert.ok(receiptReservations.every((reservation) =>
          reservation.state === 'SETTLED'
          && reservation.chargedActiveMs + reservation.refundedMs
            === reservation.allotmentMs));
        assert.equal(reconciledJob?.jobControlRecoveryReservedMs, 0);
        assert.equal(
          reconciledJob?.jobControlRecoveryConsumedMs,
          receiptReservations.reduce(
            (sum, reservation) => sum + reservation.chargedActiveMs,
            0,
          ),
        );
      },
    );

    await check(
      'result-first cancel terminalizes UNKNOWN without rewriting accepted A',
      async () => {
        const fixture = await running('result-first');
        const producer = { status: 'ok', data: { committedBeforeCancel: true } };
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
        const [resultFirstAttempt, resultFirstTask] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
        ]);
        assert.equal(resultFirstAttempt?.lifecycle, 'FINISHED');
        assert.equal(resultFirstAttempt?.outcome, 'OK');
        assert.equal(resultFirstAttempt?.processState, 'OWNED');
        assert.equal(resultFirstAttempt?.terminationConfirmed, null);
        assert.equal(resultFirstAttempt?.attemptFence, fixture.attemptFence);
        assert.equal(resultFirstAttempt?.leaseOwnerAtCommit, fixture.worker);
        assert.ok(resultFirstAttempt?.resultId);
        assert.ok(resultFirstAttempt?.committedPayloadHash);
        assert.ok(resultFirstAttempt?.ACommittedAt);
        assert.equal(resultFirstTask?.phase, 'SUCCEEDED');
        assert.equal(resultFirstTask?.controlState, 'NONE');
        const resultBeforeCancel = await results.findOne({
          _id: resultFirstAttempt.resultId,
        });
        assert.ok(resultBeforeCancel, 'A result exists before cancel');
        assert.equal(await results.countDocuments({
          attemptId: fixture.attemptId,
        }), 1);

        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:result-first',
          jobId: fixture.jobId,
        });
        assert.equal(cancelled.controlState, 'STOP_REQUESTED');
        assert.equal(cancelled.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(cancelled.pendingTerminalOutcome, null);
        const [job, attemptAfterCancel, taskAfterCancel, resultAfterCancel] =
          await Promise.all([
            jobs.findOne({ _id: fixture.jobId }),
            attempts.findOne({ _id: fixture.attemptId }),
            tasks.findOne({ _id: fixture.taskId }),
            results.findOne({ _id: resultFirstAttempt.resultId }),
          ]);
        assert.equal(job?.phase, 'TERMINAL');
        assert.equal(job?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(job?.pendingTerminalOutcome, null);
        assert.equal(attemptAfterCancel?.lifecycle, 'FINISHED');
        assert.equal(attemptAfterCancel?.outcome, 'OK');
        assert.equal(
          attemptAfterCancel?.attemptFence,
          resultFirstAttempt.attemptFence,
        );
        assert.equal(
          attemptAfterCancel?.resultId,
          resultFirstAttempt.resultId,
        );
        assert.equal(
          attemptAfterCancel?.leaseOwnerAtCommit,
          resultFirstAttempt.leaseOwnerAtCommit,
        );
        assert.equal(
          attemptAfterCancel?.committedPayloadHash,
          resultFirstAttempt.committedPayloadHash,
        );
        assert.equal(
          attemptAfterCancel?.ACommittedAt?.getTime(),
          resultFirstAttempt.ACommittedAt?.getTime(),
        );
        assert.deepEqual(
          attemptAfterCancel?.processOwner,
          resultFirstAttempt.processOwner,
        );
        assert.equal(taskAfterCancel?.phase, resultFirstTask.phase);
        assert.equal(
          taskAfterCancel?.controlState,
          resultFirstTask.controlState,
        );
        assert.deepEqual(resultAfterCancel, resultBeforeCancel);
        assert.equal(await results.countDocuments({
          attemptId: fixture.attemptId,
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobStopRequested',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobCancelled',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'process_termination_unconfirmed',
          'payload.attemptOutcome': 'OK',
          'payload.retrySuppressed': true,
        }), 1);
      },
    );

    await check(
      'stop grace expires to UNKNOWN_OUTCOME + alert without retry or terminalization',
      async () => {
        const fixture = await running('grace');
        await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:grace',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 80 });
        const requested = await attempts.findOne({ _id: fixture.attemptId });
        assert.ok(requested?.attemptStopGraceDueAt);
        await sleep(Math.max(
          0,
          requested.attemptStopGraceDueAt.getTime() - Date.now() + 60,
        ));

        assert.equal(await fireDueAttemptStopTimers(client, db), 1);
        assert.equal(await fireDueAttemptStopTimers(client, db), 0);
        const [expired, task, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(expired?.lifecycle, 'FINISHED');
        assert.equal(expired?.outcome, 'UNKNOWN_OUTCOME');
        assert.equal(expired?.reasonCode, 'attempt_stop_unconfirmed');
        assert.equal(expired?.processState, 'UNKNOWN');
        assert.equal(expired?.terminationConfirmed, false);
        assert.equal(expired?.stopReceipt, null);
        assert.equal(expired?.attemptFence, fixture.attemptFence + 1);
        assert.equal(expired?.leaseOwner, null);
        assert.equal(task?.phase, 'RECONCILING');
        assert.equal(task?.activeAttemptId, null);
        assert.equal(job?.phase, 'RECONCILING');
        assert.equal(job?.controlState, 'STOP_REQUESTED');
        assert.equal(job?.terminalOutcome, null);
        assert.equal(job?.pendingTerminalOutcome, 'UNKNOWN_OUTCOME');
        assert.ok(job?.activeActivationId);
        assert.equal(job?.stopControlRecoveryState, 'PENDING');
        assert.equal(
          job?.jobControlRecoveryReservedMs,
          CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
        );
        assert.equal(await activations.countDocuments({
          jobId: fixture.jobId,
          controlSubtype: 'STOP_TERMINAL',
          activeSlot: true,
        }), 1);
        const timerOwner = await activations.findOne({
          _id: job!.activeActivationId!,
          jobId: fixture.jobId,
          controlSubtype: 'STOP_TERMINAL',
          lifecycle: 'PENDING',
          activeSlot: true,
        });
        assert.ok(timerOwner?.budgetReservationId);
        assert.equal((await reservations.findOne({
          _id: timerOwner!.budgetReservationId!,
        }))?.state, 'RESERVED');
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
          state: 'FIRED',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'attempt_stop_unconfirmed',
          'payload.terminationConfirmed': false,
          'payload.outcome': 'UNKNOWN_OUTCOME',
        }), 1);
        assert.equal(await attempts.countDocuments({ jobId: fixture.jobId }), 1);
        assert.equal(await tasks.countDocuments({
          jobId: fixture.jobId,
          phase: 'RETRY_PENDING',
        }), 0);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          kind: 'retry',
          state: 'PENDING',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 0);
        const lateReceipt: RecordAttemptStopReceiptInput = {
          attemptId: fixture.attemptId,
          stopGeneration: requested.stopGeneration!,
          attemptFence: fixture.attemptFence,
          processOwner: fixture.processOwner,
          receiptId: 'receipt:after-grace',
          terminationConfirmed: true,
          processTreeEmpty: true,
          exitCode: null,
          signal: 'SIGTERM',
          observedAt: new Date(),
          treeEmptyAt: new Date(),
        };
        assert.equal(
          await recordAttemptStopReceipt(client, db, lateReceipt),
          null,
          'a receipt after fail-closed grace has no authority',
        );
        assert.equal(
          (await attempts.findOne({ _id: fixture.attemptId }))?.stopReceipt,
          null,
        );
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopped',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
        }), 1);
      },
    );

    await check(
      'process-owned lease recovery suppresses retry and cancel accepts UNKNOWN',
      async () => {
        const fixture = await running('reaper');
        await attempts.updateOne(
          { _id: fixture.attemptId },
          { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
        );
        assert.equal(await reapExpiredLeases(client, db), 1);

        const [reaped, taskBeforeCancel, jobBeforeCancel] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.equal(reaped?.lifecycle, 'FINISHED');
        assert.equal(reaped?.outcome, 'UNKNOWN_OUTCOME');
        assert.equal(reaped?.reasonCode, 'process_termination_unconfirmed');
        assert.equal(reaped?.processState, 'UNKNOWN');
        assert.equal(reaped?.terminationConfirmed, false);
        assert.equal(reaped?.attemptFence, fixture.attemptFence + 1);
        assert.equal(reaped?.leaseOwner, null);
        assert.equal(reaped?.stopGeneration, 1);
        assert.equal(reaped?.primaryAttemptStopCause, 'lease_lost');
        assert.deepEqual(reaped?.secondaryAttemptStopCauses, []);
        assert.equal(taskBeforeCancel?.phase, 'RECONCILING');
        assert.equal(taskBeforeCancel?.activeAttemptId, null);
        assert.equal(jobBeforeCancel?.phase, 'RECONCILING');
        assert.equal(jobBeforeCancel?.terminalOutcome, null);
        assert.equal(await attempts.countDocuments({ jobId: fixture.jobId }), 1);
        assert.equal(await tasks.countDocuments({
          jobId: fixture.jobId,
          phase: 'RETRY_PENDING',
        }), 0);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          kind: 'retry',
          state: 'PENDING',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          'payload.reason': { $in: ['worker_lost', 'retry_exhausted'] },
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'process_termination_unconfirmed',
          'payload.retrySuppressed': true,
        }), 1);

        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:after-reaper',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 10 });
        assert.equal(cancelled.controlState, 'STOP_REQUESTED');
        assert.equal(cancelled.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(cancelled.pendingTerminalOutcome, null);
        assert.equal(cancelled.alreadyTerminal, false);
        const [afterCancel, attemptAfterCancel, taskAfterCancel] = await Promise.all([
          jobs.findOne({ _id: fixture.jobId }),
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
        ]);
        assert.equal(afterCancel?.phase, 'TERMINAL');
        assert.equal(afterCancel?.controlState, 'STOP_REQUESTED');
        assert.equal(afterCancel?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(afterCancel?.pendingTerminalOutcome, null);
        assert.equal(taskAfterCancel?.phase, 'UNKNOWN_OUTCOME');
        assert.equal(attemptAfterCancel?.lifecycle, reaped.lifecycle);
        assert.equal(attemptAfterCancel?.outcome, reaped.outcome);
        assert.equal(attemptAfterCancel?.reasonCode, reaped.reasonCode);
        assert.equal(attemptAfterCancel?.attemptFence, reaped.attemptFence);
        assert.equal(attemptAfterCancel?.stopGeneration, reaped.stopGeneration);
        assert.equal(
          attemptAfterCancel?.primaryAttemptStopCause,
          reaped.primaryAttemptStopCause,
        );
        assert.deepEqual(
          attemptAfterCancel?.secondaryAttemptStopCauses,
          reaped.secondaryAttemptStopCauses,
        );
        assert.equal(attemptAfterCancel?.processState, reaped.processState);
        assert.equal(
          attemptAfterCancel?.terminationConfirmed,
          reaped.terminationConfirmed,
        );
        assert.equal(await attempts.countDocuments({ jobId: fixture.jobId }), 1);
        assert.equal(await tasks.countDocuments({
          jobId: fixture.jobId,
          phase: 'RETRY_PENDING',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'process_termination_unconfirmed',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobStopRequested',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobCancelled',
        }), 0);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
      },
    );

    await check(
      'cancel-first lease expiry resolves exactly once to UNKNOWN and cancels grace',
      async () => {
        const fixture = await running('cancel-then-reaper');
        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:cancel-then-reaper',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 10_000 });
        assert.equal(cancelled.controlState, 'STOP_REQUESTED');
        assert.equal(cancelled.terminalOutcome, null);
        assert.equal(cancelled.pendingTerminalOutcome, 'CANCELLED');

        const requested = await attempts.findOne({ _id: fixture.attemptId });
        assert.ok(requested);
        assert.equal(requested.lifecycle, 'STOP_REQUESTED');
        assert.equal(requested.stopGeneration, 1);
        assert.equal(requested.attemptFence, fixture.attemptFence);
        assert.equal(requested.primaryAttemptStopCause, 'user_cancel');
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
          state: 'PENDING',
        }), 1);

        await attempts.updateOne(
          {
            _id: fixture.attemptId,
            lifecycle: 'STOP_REQUESTED',
            attemptFence: fixture.attemptFence,
          },
          { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
        );
        assert.equal(await reapExpiredLeases(client, db), 1);
        assert.equal(await reapExpiredLeases(client, db), 0);

        const [expired, task, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          tasks.findOne({ _id: fixture.taskId }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.ok(expired);
        assert.equal(expired.lifecycle, 'FINISHED');
        assert.equal(expired.outcome, 'UNKNOWN_OUTCOME');
        assert.equal(expired.reasonCode, 'process_termination_unconfirmed');
        assert.equal(expired.processState, 'UNKNOWN');
        assert.equal(expired.terminationConfirmed, false);
        assert.equal(expired.attemptFence, fixture.attemptFence + 1);
        assert.equal(expired.stopGeneration, requested.stopGeneration);
        assert.equal(expired.primaryAttemptStopCause, 'user_cancel');
        assert.deepEqual(expired.secondaryAttemptStopCauses, ['lease_lost']);
        assert.equal(expired.stopReceipt, null);
        assert.equal(task?.phase, 'RECONCILING');
        assert.equal(task?.controlState, 'STOP_REQUESTED');
        assert.equal(task?.activeAttemptId, null);
        assert.equal(job?.phase, 'RECONCILING');
        assert.equal(job?.controlState, 'STOP_REQUESTED');
        assert.equal(job?.terminalOutcome, null);
        assert.equal(job?.pendingTerminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
          state: 'CANCELLED',
        }), 1);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
          state: { $in: ['PENDING', 'FIRED'] },
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'process_termination_unconfirmed',
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'attempt_stop_unconfirmed',
        }), 0);
        assert.equal(await attempts.countDocuments({ jobId: fixture.jobId }), 1);
        assert.equal(await tasks.countDocuments({
          jobId: fixture.jobId,
          phase: 'RETRY_PENDING',
        }), 0);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          kind: 'retry',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'LaneWakeRequested',
          'payload.reason': { $in: ['worker_lost', 'retry_exhausted'] },
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopped',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 0);
      },
    );

    await check(
      'cancel finds and stops a RUNNING process owned by an old plan',
      async () => {
        const fixture = await running('old-plan');
        const [jobBefore, attemptBefore] = await Promise.all([
          jobs.findOne({ _id: fixture.jobId }),
          attempts.findOne({ _id: fixture.attemptId }),
        ]);
        assert.ok(jobBefore);
        assert.ok(attemptBefore);
        const oldPlanVersion = attemptBefore.planVersion;
        assert.equal(jobBefore.planVersion, oldPlanVersion);
        const moved = await jobs.updateOne(
          {
            _id: fixture.jobId,
            stateVersion: jobBefore.stateVersion,
            planVersion: oldPlanVersion,
          },
          {
            $set: {
              planVersion: oldPlanVersion + 1,
              updatedAt: new Date(),
            },
            $inc: { stateVersion: 1 },
          },
        );
        assert.equal(moved.modifiedCount, 1);

        const cancelled = await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:old-plan',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 10_000 });
        assert.equal(cancelled.controlState, 'STOP_REQUESTED');
        assert.equal(cancelled.terminalOutcome, null);
        assert.equal(cancelled.pendingTerminalOutcome, 'CANCELLED');

        const [currentJob, currentTask, stopped, stopEvent] =
          await Promise.all([
            jobs.findOne({ _id: fixture.jobId }),
            tasks.findOne({ _id: fixture.taskId }),
            attempts.findOne({ _id: fixture.attemptId }),
            events.findOne({
              jobId: fixture.jobId,
              type: 'JobStopRequested',
            }),
          ]);
        assert.ok(stopped);
        assert.equal(currentJob?.planVersion, oldPlanVersion + 1);
        assert.equal(stopped.planVersion, oldPlanVersion);
        assert.equal(stopped.lifecycle, 'STOP_REQUESTED');
        assert.equal(stopped.processState, 'STOP_REQUESTED');
        assert.equal(stopped.attemptFence, fixture.attemptFence);
        assert.deepEqual(stopped.processOwner, fixture.processOwner);
        assert.equal(stopped.primaryAttemptStopCause, 'user_cancel');
        assert.equal(stopped.stopGeneration, 1);
        assert.equal(currentTask?.phase, 'RECONCILING');
        assert.equal(currentTask?.controlState, 'STOP_REQUESTED');
        assert.deepEqual(stopEvent?.payload.activeAttemptIds, [
          fixture.attemptId,
        ]);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopRequested',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobStopRequested',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobCancelled',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 0);

        const cleanupReceipt: RecordAttemptStopReceiptInput = {
          attemptId: fixture.attemptId,
          stopGeneration: stopped.stopGeneration!,
          attemptFence: fixture.attemptFence,
          processOwner: fixture.processOwner,
          receiptId: 'receipt:old-plan',
          terminationConfirmed: true,
          processTreeEmpty: true,
          exitCode: null,
          signal: 'SIGTERM',
          observedAt: new Date(),
          treeEmptyAt: new Date(),
        };
        assert.equal(
          (await recordAttemptStopReceipt(client, db, cleanupReceipt))
            ?.recorded,
          true,
        );
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          entityId: fixture.attemptId,
          kind: 'attempt_stop_grace',
          state: 'CANCELLED',
        }), 1);
        const [terminalOldPlanJob, terminalOldPlanTask] = await Promise.all([
          jobs.findOne({ _id: fixture.jobId }),
          tasks.findOne({ _id: fixture.taskId }),
        ]);
        assert.equal(terminalOldPlanJob?.planVersion, oldPlanVersion + 1);
        assert.equal(terminalOldPlanJob?.phase, 'TERMINAL');
        assert.equal(terminalOldPlanJob?.terminalOutcome, 'CANCELLED');
        assert.equal(terminalOldPlanJob?.pendingTerminalOutcome, null);
        assert.equal(terminalOldPlanTask?.phase, 'CANCELLED');
        assert.equal(terminalOldPlanTask?.activeAttemptId, null);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 1);
        assert.equal(await events.countDocuments({
          jobId: fixture.jobId,
          type: 'JobTerminalized',
        }), 1);
      },
    );

    await check(
      'concurrent stop-grace timer and lease reaper choose one UNKNOWN resolution',
      async () => {
        const fixture = await running('timer-vs-reaper');
        await cancelJob(client, db, {
          resourceId: RESOURCE_ID,
          commandId: 'cancel:timer-vs-reaper',
          jobId: fixture.jobId,
        }, { attemptStopGraceMs: 80 });
        const requested = await attempts.findOne({ _id: fixture.attemptId });
        assert.ok(requested?.attemptStopGraceDueAt);
        await attempts.updateOne(
          {
            _id: fixture.attemptId,
            lifecycle: 'STOP_REQUESTED',
            attemptFence: fixture.attemptFence,
          },
          {
            $set: {
              leaseExpiresAt: requested.attemptStopGraceDueAt,
            },
          },
        );
        await sleep(Math.max(
          0,
          requested.attemptStopGraceDueAt.getTime() - Date.now() + 60,
        ));

        const [timerFired, reaped] = await Promise.all([
          fireDueAttemptStopTimers(client, db),
          reapExpiredLeases(client, db),
        ]);
        assert.equal(
          timerFired + reaped,
          1,
          'exactly one resolver owns the terminal attempt transition',
        );

        const [resolved, timer, job] = await Promise.all([
          attempts.findOne({ _id: fixture.attemptId }),
          timers.findOne({
            jobId: fixture.jobId,
            entityId: fixture.attemptId,
            kind: 'attempt_stop_grace',
          }),
          jobs.findOne({ _id: fixture.jobId }),
        ]);
        assert.ok(resolved);
        assert.ok(timer);
        assert.equal(resolved.lifecycle, 'FINISHED');
        assert.equal(resolved.outcome, 'UNKNOWN_OUTCOME');
        assert.equal(resolved.processState, 'UNKNOWN');
        assert.equal(resolved.terminationConfirmed, false);
        assert.equal(resolved.attemptFence, fixture.attemptFence + 1);
        assert.equal(resolved.stopGeneration, 1);
        assert.equal(resolved.primaryAttemptStopCause, 'user_cancel');
        assert.equal(resolved.stopReceipt, null);
        assert.equal(job?.phase, 'RECONCILING');
        assert.equal(job?.controlState, 'STOP_REQUESTED');
        assert.equal(job?.terminalOutcome, null);
        assert.equal(job?.pendingTerminalOutcome, 'UNKNOWN_OUTCOME');

        const graceAlerts = await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'attempt_stop_unconfirmed',
        });
        const reaperAlerts = await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'OperatorAlertRequested',
          'payload.alertType': 'process_termination_unconfirmed',
        });
        assert.equal(graceAlerts + reaperAlerts, 1);
        if (timerFired === 1) {
          assert.equal(reaped, 0);
          assert.equal(resolved.reasonCode, 'attempt_stop_unconfirmed');
          assert.deepEqual(resolved.secondaryAttemptStopCauses, []);
          assert.equal(timer.state, 'FIRED');
          assert.equal(graceAlerts, 1);
          assert.equal(reaperAlerts, 0);
        } else {
          assert.equal(timerFired, 0);
          assert.equal(reaped, 1);
          assert.equal(
            resolved.reasonCode,
            'process_termination_unconfirmed',
          );
          assert.deepEqual(
            resolved.secondaryAttemptStopCauses,
            ['lease_lost'],
          );
          assert.equal(timer.state, 'CANCELLED');
          assert.equal(graceAlerts, 0);
          assert.equal(reaperAlerts, 1);
        }
        assert.equal(await tasks.countDocuments({
          jobId: fixture.jobId,
          phase: 'RETRY_PENDING',
        }), 0);
        assert.equal(await timers.countDocuments({
          jobId: fixture.jobId,
          kind: 'retry',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'LaneWakeRequested',
          'payload.reason': { $in: ['worker_lost', 'retry_exhausted'] },
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'AttemptStopped',
        }), 0);
        assert.equal(await outbox.countDocuments({
          aggregate: fixture.jobId,
          type: 'JobTerminal',
        }), 0);
      },
    );
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) {
    console.error(
      `\n❌ e2e:orchestration-attempt-stop — ${failures} failure(s)`,
    );
    process.exit(1);
  }
  console.log('\n✅ e2e:orchestration-attempt-stop — all assertions passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(`e2e failed: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(1);
});
