#!/usr/bin/env tsx
/**
 * Real Linux subprocess proof for PROCESS_SUPERVISOR_V1.
 *
 * Requires the ephemeral Mongo replica set. Every spawned target has a fixture
 * hard TTL; cleanup still uses only the exact persisted owner/group.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  acceptStartCommand,
  cancelJob,
  claimAttempt,
  COLLECTIONS,
  createTask,
  dispatchAttempt,
  drainLane,
  ensureOrchestrationIndexes,
  markAttemptPayloadReady,
  observeAttemptStopRequest,
  recordAttemptProcessExitReceipt,
  requestAttemptStop,
  submitAttemptResult,
  type AttemptDoc,
  type AttemptProcessOwnerDoc,
  type JobDoc,
  type OutboxDoc,
  type ResultDoc,
  type TaskDoc,
} from '../orchestration/store/index.js';
import {
  inspectOwnedProcessTree,
  prepareSupervisedProcess,
  reconcileSupervisedProcesses,
  runSupervisedProcessWorkerOnce,
  stopSupervisedAttempt,
  waitForOwnedProcessTreeEmpty,
  type SupervisedProcessHandle,
} from '../orchestration/execution/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const RESOURCE_ID = 'res_process_supervisor';
const CONVERSATION_ID = 'conv_process_supervisor';
const TARGET_FIXTURE = fileURLToPath(new URL(
  './fixtures/orchestration-process-target.mjs',
  import.meta.url,
));

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
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

async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

interface ClaimedFixture {
  name: string;
  jobId: string;
  taskId: string;
  attemptId: string;
  worker: string;
  attemptFence: number;
  attempt: AttemptDoc;
}

interface TrackedProcess {
  fixture: ClaimedFixture;
  handle: SupervisedProcessHandle;
  owner: AttemptProcessOwnerDoc | null;
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-process-supervisor');
  if (process.platform !== 'linux') {
    console.log('  ⚠ SKIP — PROCESS_GROUP proof currently requires Linux');
    process.exit(0);
  }

  const store = await connectReplicaSetOrSkip({
    dbName: `orch_process_supervisor_e2e_${Date.now()}`,
    section: 'e2e:orchestration-process-supervisor',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const tracked = new Set<TrackedProcess>();

  async function claimed(name: string): Promise<ClaimedFixture> {
    const accepted = await acceptStartCommand(client, db, {
      resourceId: RESOURCE_ID,
      conversationId: CONVERSATION_ID,
      commandId: `start:${name}`,
      goal: `process-supervisor:${name}`,
      payload: { name },
    });
    const taskId = await createTask(client, db, accepted.jobId);
    const { attemptId } = await dispatchAttempt(client, db, {
      jobId: accepted.jobId,
      taskId,
      attemptCapMs: 20_000,
      reserveForFinalizeMs: 2_000,
      resultCommitReserveMs: 2_000,
    });
    const worker = `process-worker:${name}`;
    const lease = await claimAttempt(client, db, {
      attemptId,
      workerInstanceId: worker,
      leaseTtlMs: 10_000,
    });
    assert.ok(lease);
    const attempt = await attempts.findOne({ _id: attemptId });
    assert.ok(attempt);
    return {
      name,
      jobId: accepted.jobId,
      taskId,
      attemptId,
      worker,
      attemptFence: lease.attemptFence,
      attempt,
    };
  }

  async function startOwned(
    name: string,
    mode: string,
    minimumMembers = 2,
    supervisorTiming: {
      startupTimeoutMs?: number;
      wrapperHardTtlMs?: number;
    } = {},
  ): Promise<TrackedProcess> {
    const fixture = await claimed(name);
    const handle = await prepareSupervisedProcess({
      workerInstanceId: fixture.worker,
      startupTimeoutMs: supervisorTiming.startupTimeoutMs ?? 2_000,
      wrapperHardTtlMs: supervisorTiming.wrapperHardTtlMs ?? 12_000,
    });
    const entry: TrackedProcess = { fixture, handle, owner: null };
    tracked.add(entry);
    const started = await handle.start({
      client,
      db,
      attemptId: fixture.attemptId,
      leaseOwner: fixture.worker,
      attemptFence: fixture.attemptFence,
      spec: {
        command: process.execPath,
        args: [TARGET_FIXTURE, mode],
        env: { ORCH_FIXTURE_HARD_TTL_MS: '10000' },
      },
    });
    assert.equal(started.released, true);
    assert.equal(started.workloadStarted, true);
    assert.ok(started.processOwner);
    entry.owner = started.processOwner;
    if (minimumMembers > 0) {
      await waitUntil(async () => (
        await inspectOwnedProcessTree(started.processOwner!)
      ).members.length >= minimumMembers, `${mode} target did not join the owned group`);
    }
    return entry;
  }

  async function requestCancel(
    fixture: ClaimedFixture,
    graceMs = 5_000,
    expectedOutcome: null | 'UNKNOWN_OUTCOME' = null,
  ): Promise<void> {
    const cancelled = await cancelJob(client, db, {
      resourceId: RESOURCE_ID,
      commandId: `cancel:${fixture.name}`,
      jobId: fixture.jobId,
    }, { attemptStopGraceMs: graceMs });
    assert.equal(cancelled.terminalOutcome, expectedOutcome);
  }

  async function cleanupEntry(entry: TrackedProcess): Promise<void> {
    try {
      const current = await attempts.findOne({ _id: entry.fixture.attemptId });
      const owner = current?.processOwner ?? entry.owner;
      if (current && owner) {
        let stop = await observeAttemptStopRequest(db, {
          attemptId: current._id,
          processOwner: owner,
        });
        if (!stop && current.lifecycle === 'RUNNING') {
          const job = await jobs.findOne({ _id: current.jobId });
          await requestAttemptStop(client, db, {
            attemptId: current._id,
            cause: 'worker_shutdown',
            graceMs: 1_000,
            jobStopGenerationAtStop:
              job?.jobStopGeneration ?? current.jobStopGenerationAtDispatch ?? 0,
          });
          stop = await observeAttemptStopRequest(db, {
            attemptId: current._id,
            processOwner: owner,
          });
        }
        if (stop) {
          await stopSupervisedAttempt(client, db, {
            attemptId: current._id,
            processOwner: owner,
            handle: entry.handle,
            abortGraceMs: 50,
            termGraceMs: 100,
            killConfirmMs: 500,
            pollMs: 20,
          });
        }
      }
    } finally {
      await entry.handle.cleanup().catch(() => {});
      tracked.delete(entry);
    }
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check(
      'cancel before workload release runs zero target code and records exact empty-tree stop',
      async () => {
        const fixture = await claimed('cancel-before-release');
        const sentinel = `/tmp/orch-process-sentinel-${randomUUID()}`;
        const handle = await prepareSupervisedProcess({
          workerInstanceId: fixture.worker,
          startupTimeoutMs: 2_000,
          wrapperHardTtlMs: 8_000,
        });
        const entry: TrackedProcess = { fixture, handle, owner: null };
        tracked.add(entry);
        const started = await handle.start({
          client,
          db,
          attemptId: fixture.attemptId,
          leaseOwner: fixture.worker,
          attemptFence: fixture.attemptFence,
          spec: {
            command: process.execPath,
            args: [TARGET_FIXTURE, 'sentinel', sentinel],
            env: { ORCH_FIXTURE_HARD_TTL_MS: '5000' },
          },
          beforeWorkloadRelease: async (owner) => {
            entry.owner = owner;
            await requestCancel(fixture);
          },
        });
        assert.equal(started.released, false);
        assert.equal(started.workloadStarted, false);
        assert.ok(started.processOwner);
        const stopped = await stopSupervisedAttempt(client, db, {
          attemptId: fixture.attemptId,
          processOwner: started.processOwner,
          termGraceMs: 100,
          killConfirmMs: 500,
          pollMs: 20,
        });
        assert.equal(stopped.processTreeEmpty, true);
        assert.equal(stopped.receiptRecorded, true);
        await assert.rejects(() => access(sentinel));
        const finalAttempt = await attempts.findOne({ _id: fixture.attemptId });
        assert.equal(finalAttempt?.processWorkloadReleasedAt, null);
        assert.equal(finalAttempt?.stopReceipt?.processTreeEmpty, true);
        await cleanupEntry(entry);
      },
    );

    await check(
      'leader exit does not block exact KILL of surviving owned group descendants',
      async () => {
        const entry = await startOwned(
          'leader-exit-child-survives',
          'term-root-child-survives',
          3,
        );
        await requestCancel(entry.fixture);
        const stopped = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: entry.owner!,
          handle: entry.handle,
          abortGraceMs: 50,
          termGraceMs: 150,
          killConfirmMs: 1_500,
          pollMs: 20,
        });
        assert.equal(stopped.receiptRecorded, true);
        assert.equal(stopped.signal, 'SIGKILL');
        const attempt = await attempts.findOne({
          _id: entry.fixture.attemptId,
        });
        assert.ok(attempt?.processTermSentAt);
        assert.ok(attempt?.processKillSentAt);
        assert.equal((await inspectOwnedProcessTree(entry.owner!)).empty, true);
        await cleanupEntry(entry);
      },
    );

    await check(
      'escaped token descendant blocks receipt until the full execution scope is empty',
      async () => {
        const entry = await startOwned('escaped-descendant', 'escaped-root', 0);
        await entry.handle.completion;
        await entry.handle.finalize();
        await waitUntil(async () => (
          await inspectOwnedProcessTree(entry.owner!)
        ).escapedExecutionPids.length > 0, 'escaped descendant was not detected');
        await requestCancel(entry.fixture, 3_000);
        const first = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: entry.owner!,
          handle: entry.handle,
          abortGraceMs: 50,
          termGraceMs: 100,
          killConfirmMs: 100,
          pollMs: 20,
        });
        assert.equal(first.receiptRecorded, false);
        assert.equal(first.processTreeEmpty, false);
        const pending = await attempts.findOne({
          _id: entry.fixture.attemptId,
        });
        assert.equal(pending?.stopReceipt, null);

        await waitUntil(async () => (
          await inspectOwnedProcessTree(entry.owner!)
        ).empty, 'escaped descendant did not reach its fixture TTL', 5_000);
        const recovered = await reconcileSupervisedProcesses(client, db, {
          termGraceMs: 100,
          killConfirmMs: 500,
          pollMs: 20,
        });
        assert.equal(recovered.stopped, 1);
        const settled = await attempts.findOne({
          _id: entry.fixture.attemptId,
        });
        assert.equal(settled?.stopReceipt?.processTreeEmpty, true);
        await cleanupEntry(entry);
      },
    );

    await check(
      'cooperative IPC abort stops without TERM/KILL',
      async () => {
        const entry = await startOwned('cooperative', 'cooperative');
        await requestCancel(entry.fixture);
        const stopped = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: entry.owner!,
          handle: entry.handle,
          abortGraceMs: 800,
          termGraceMs: 200,
          killConfirmMs: 500,
          pollMs: 20,
        });
        assert.equal(stopped.receiptRecorded, true);
        assert.equal(stopped.signal, null);
        const attempt = await attempts.findOne({ _id: entry.fixture.attemptId });
        assert.ok(attempt?.processAbortSentAt);
        assert.equal(attempt?.processTermSentAt, null);
        assert.equal(attempt?.processKillSentAt, null);
        assert.equal(attempt?.processSignalStage, 'TREE_EMPTY');
        await cleanupEntry(entry);
      },
    );

    await check(
      'wrapper hard TTL reports failure but cannot signal before durable stop',
      async () => {
        const entry = await startOwned(
          'wrapper-ttl-no-signal',
          'term',
          2,
          { startupTimeoutMs: 250, wrapperHardTtlMs: 700 },
        );
        await assert.rejects(
          entry.handle.completion,
          /wrapper hard TTL elapsed; durable supervisor stop required/,
        );
        assert.ok((await inspectOwnedProcessTree(entry.owner!)).members.length >= 2);
        const beforeStop = await attempts.findOne({
          _id: entry.fixture.attemptId,
        });
        assert.equal(beforeStop?.lifecycle, 'RUNNING');
        assert.equal(beforeStop?.processTermSentAt, null);
        assert.equal(beforeStop?.processKillSentAt, null);

        await requestCancel(entry.fixture);
        const stopped = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: entry.owner!,
          handle: entry.handle,
          abortGraceMs: 50,
          termGraceMs: 800,
          killConfirmMs: 500,
          pollMs: 20,
        });
        assert.equal(stopped.receiptRecorded, true);
        assert.equal(stopped.signal, 'SIGTERM');
        await cleanupEntry(entry);
      },
    );

    await check(
      'non-cooperative target exits on exact group TERM without KILL',
      async () => {
        const entry = await startOwned('term', 'term');
        await requestCancel(entry.fixture);
        const stopped = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: entry.owner!,
          handle: entry.handle,
          abortGraceMs: 80,
          termGraceMs: 800,
          killConfirmMs: 500,
          pollMs: 20,
        });
        assert.equal(stopped.receiptRecorded, true);
        assert.equal(stopped.signal, 'SIGTERM');
        const attempt = await attempts.findOne({ _id: entry.fixture.attemptId });
        assert.ok(attempt?.processTermSentAt);
        assert.equal(attempt?.processKillSentAt, null);
        assert.equal(attempt?.stopReceipt?.signal, 'SIGTERM');
        await cleanupEntry(entry);
      },
    );

    await check(
      'SIGKILL removes wrapper + root + child + grandchild before receipt',
      async () => {
        const entry = await startOwned('kill-tree', 'kill-tree');
        await waitUntil(async () => (
          await inspectOwnedProcessTree(entry.owner!)
        ).members.length >= 4, 'full process tree did not materialize');
        const before = await inspectOwnedProcessTree(entry.owner!);
        const ownedPids = before.members.map((member) => member.pid);
        assert.ok(ownedPids.length >= 4);

        await requestCancel(entry.fixture);
        const stopped = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: entry.owner!,
          handle: entry.handle,
          abortGraceMs: 50,
          termGraceMs: 100,
          killConfirmMs: 1_500,
          pollMs: 20,
        });
        assert.equal(stopped.receiptRecorded, true);
        assert.equal(stopped.signal, 'SIGKILL');
        const after = await inspectOwnedProcessTree(entry.owner!);
        assert.equal(after.empty, true);
        assert.equal(after.members.length, 0);
        const attempt = await attempts.findOne({ _id: entry.fixture.attemptId });
        assert.ok(attempt?.processKillSentAt);
        assert.equal(attempt?.stopReceipt?.signal, 'SIGKILL');
        await cleanupEntry(entry);
      },
    );

    await check(
      'owner/start-token mismatch sends zero signals to the live exact group',
      async () => {
        const entry = await startOwned('owner-mismatch', 'term');
        await requestCancel(entry.fixture);
        const wrongOwner: AttemptProcessOwnerDoc = {
          ...entry.owner!,
          processStartToken: `${entry.owner!.processStartToken}:wrong`,
        };
        const rejected = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: wrongOwner,
          handle: entry.handle,
          abortGraceMs: 50,
          termGraceMs: 50,
          killConfirmMs: 100,
          pollMs: 20,
        });
        assert.equal(rejected.authorityObserved, false);
        await sleep(100);
        assert.ok((await inspectOwnedProcessTree(entry.owner!)).members.length >= 2);

        const stopped = await stopSupervisedAttempt(client, db, {
          attemptId: entry.fixture.attemptId,
          processOwner: entry.owner!,
          handle: entry.handle,
          abortGraceMs: 50,
          termGraceMs: 500,
          killConfirmMs: 500,
          pollMs: 20,
        });
        assert.equal(stopped.receiptRecorded, true);
        await cleanupEntry(entry);
      },
    );

    await check(
      'restart scanner resumes durable stop and replay emits one receipt/outbox',
      async () => {
        const entry = await startOwned('recovery', 'term');
        await requestCancel(entry.fixture);
        const first = await reconcileSupervisedProcesses(client, db, {
          termGraceMs: 800,
          killConfirmMs: 500,
          pollMs: 20,
        });
        assert.equal(first.stopped, 1);
        const afterFirst = await attempts.findOne({
          _id: entry.fixture.attemptId,
        });
        assert.ok(afterFirst?.stopReceipt);
        const receiptHash = afterFirst.stopReceipt.receiptHash;
        const second = await reconcileSupervisedProcesses(client, db);
        assert.equal(second.stopped, 0);
        const afterSecond = await attempts.findOne({
          _id: entry.fixture.attemptId,
        });
        assert.equal(afterSecond?.stopReceipt?.receiptHash, receiptHash);
        assert.equal(await outbox.countDocuments({
          aggregate: entry.fixture.jobId,
          type: 'AttemptStopped',
        }), 1);
        await cleanupEntry(entry);
      },
    );

    await check(
      'real queue consumer commits A + normal tree-empty receipt atomically',
      async () => {
        const accepted = await acceptStartCommand(client, db, {
          resourceId: RESOURCE_ID,
          conversationId: CONVERSATION_ID,
          commandId: 'start:real-process-worker',
          goal: 'real process worker',
          payload: {},
        });
        for (let i = 0; i < 4; i++) await drainLane(client, db);
        assert.equal(await runSupervisedProcessWorkerOnce(
          client,
          db,
          () => ({
            spec: {
              command: '/bin/echo',
              args: [JSON.stringify({
                status: 'ok',
                data: { via: 'PROCESS_GROUP' },
              })],
            },
          }),
          {
            workerInstanceId: 'process-worker:e2e',
            leaseTtlMs: 8_000,
            heartbeatEveryMs: 500,
            normalExitConfirmMs: 1_500,
          },
        ), true);
        const attempt = await attempts.findOne({ jobId: accepted.jobId });
        assert.equal(attempt?.lifecycle, 'FINISHED');
        assert.equal(attempt?.outcome, 'OK');
        assert.equal(attempt?.terminationConfirmed, true);
        assert.equal(
          attempt?.processExitReceipt?.confirmationKind,
          'NORMAL_PROCESS_TREE_EMPTY',
        );
        assert.equal(await results.countDocuments({
          attemptId: attempt!._id,
        }), 1);
        assert.equal(await outbox.countDocuments({
          aggregate: accepted.jobId,
          type: 'AttemptProcessExited',
        }), 1);
        for (let i = 0; i < 8; i++) await drainLane(client, db);
        const job = await jobs.findOne({ _id: accepted.jobId });
        assert.equal(job?.terminalOutcome, 'COMPLETED');
      },
    );

    await check(
      'result-first late normal receipt preserves business result across cancel',
      async () => {
        const entry = await startOwned('result-first-late-exit', 'success', 0);
        const completion = await entry.handle.completion;
        const producer = {
          status: 'ok',
          data: { resultFirst: true },
        };
        const marker = await markAttemptPayloadReady(client, db, {
          attemptId: entry.fixture.attemptId,
          leaseOwner: entry.fixture.worker,
          attemptFence: entry.fixture.attemptFence,
          producer,
        });
        assert.equal(marker.ready, true);
        const committed = await submitAttemptResult(client, db, {
          attemptId: entry.fixture.attemptId,
          leaseOwner: entry.fixture.worker,
          attemptFence: entry.fixture.attemptFence,
          producer,
          businessPayloadReadyGeneration: marker.generation,
        });
        assert.equal(committed.committed, true);
        const before = await attempts.findOne({
          _id: entry.fixture.attemptId,
        });
        const resultBefore = await results.findOne({ _id: before!.resultId! });
        assert.equal(before?.processState, 'OWNED');
        assert.equal(before?.terminationConfirmed, null);

        await requestCancel(entry.fixture, 5_000, 'UNKNOWN_OUTCOME');
        await entry.handle.finalize();
        const tree = await waitForOwnedProcessTreeEmpty(entry.owner!, {
          timeoutMs: 1_500,
          pollMs: 20,
        });
        assert.equal(tree.empty, true);
        assert.ok(tree.treeEmptyAt);
        const receipt = await recordAttemptProcessExitReceipt(client, db, {
          attemptId: entry.fixture.attemptId,
          attemptFence: entry.fixture.attemptFence,
          processOwner: entry.owner!,
          receiptId: [
            'process-exit',
            entry.owner!.processExecutionId,
            entry.owner!.ownerGeneration,
          ].join(':'),
          terminationConfirmed: true,
          processTreeEmpty: true,
          exitCode: completion.exitCode,
          signal: completion.signal,
          observedAt: completion.observedAt,
          treeEmptyAt: tree.treeEmptyAt!,
        });
        assert.equal(receipt?.recorded, true);
        const [after, resultAfter, job] = await Promise.all([
          attempts.findOne({ _id: entry.fixture.attemptId }),
          results.findOne({ _id: before!.resultId! }),
          jobs.findOne({ _id: entry.fixture.jobId }),
        ]);
        assert.equal(after?.outcome, 'OK');
        assert.equal(after?.resultId, before?.resultId);
        assert.equal(after?.ACommittedAt?.getTime(), before?.ACommittedAt?.getTime());
        assert.deepEqual(resultAfter, resultBefore);
        assert.equal(after?.terminationConfirmed, true);
        assert.ok(after?.processExitReceipt);
        // PR-39 preserves A and may consume the monotonic UNKNOWN before the
        // late normal tree-empty liveness fact; that fact cannot rewrite it.
        assert.equal(job?.phase, 'TERMINAL');
        assert.equal(job?.terminalOutcome, 'UNKNOWN_OUTCOME');
        assert.equal(job?.pendingTerminalOutcome, null);
        assert.equal(job?.primaryJobStopCause, 'user_cancel');
        assert.equal(await outbox.countDocuments({
          aggregate: entry.fixture.jobId,
          type: 'JobTerminal',
        }), 1);
        await cleanupEntry(entry);
      },
    );
  } finally {
    for (const entry of [...tracked]) await cleanupEntry(entry);
    await db.dropDatabase().catch(() => {});
    await store.close();
  }

  if (failures > 0) {
    console.error(
      `\n❌ e2e:orchestration-process-supervisor — ${failures} failure(s)`,
    );
    process.exit(1);
  }
  console.log(
    '\n✅ e2e:orchestration-process-supervisor — all assertions passed',
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(`e2e failed: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(1);
});
