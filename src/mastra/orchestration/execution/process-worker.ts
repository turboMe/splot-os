/**
 * Queue consumer for serializable PROCESS_GROUP work.
 *
 * Routing may choose an executable and arguments, but it must not perform the
 * business operation itself. The target runs only after the same claim,
 * operation-start and release authority used by the durable worker path.
 */
import type { Db, Filter, MongoClient } from 'mongodb';
import {
  claimAttempt,
  markAttemptPayloadReady,
  renewLease,
  submitAttemptResult,
} from '../store/attempts.js';
import {
  observeAttemptStopRequest,
  requestAttemptStop,
} from '../store/attempt-stop.js';
import {
  COLLECTIONS,
  type AttemptDoc,
  type JobDoc,
  type TaskDoc,
} from '../store/collections.js';
import {
  findClaimableQueuedAttempt,
  type WorkerContext,
  type WorkerRunOptions,
} from '../store/worker.js';
import {
  prepareSupervisedProcess,
  stopSupervisedAttempt,
  type SupervisedProcessCompletion,
  type SupervisedProcessHandle,
  type SupervisedProcessSpec,
} from './process-supervisor.js';
import { waitForOwnedProcessTreeEmpty } from './linux-process-tree.js';

export interface SupervisedProcessWork {
  spec: SupervisedProcessSpec;
  /** Parent-side decoding only; no model/tool/effect work is legal here. */
  toProducer?: (completion: SupervisedProcessCompletion) => unknown;
}

export type SupervisedProcessRouter = (
  context: WorkerContext,
) => SupervisedProcessWork | Promise<SupervisedProcessWork>;

export interface SupervisedProcessWorkerOptions extends WorkerRunOptions {
  signal?: AbortSignal;
  stopPollMs?: number;
  stopGraceMs?: number;
  abortGraceMs?: number;
  termGraceMs?: number;
  killConfirmMs?: number;
  normalExitConfirmMs?: number;
  wrapperStartupTimeoutMs?: number;
  wrapperHardTtlMs?: number;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function processCompletionToProducer(
  completion: SupervisedProcessCompletion,
): unknown {
  if (completion.exitCode !== 0) {
    return {
      status: 'failed',
      error: {
        code: completion.signal
          ? 'subprocess_signalled'
          : 'subprocess_exit_nonzero',
        message: (
          completion.stderr.trim()
          || `subprocess exited with code ${completion.exitCode ?? 'unknown'}`
        ).slice(0, 4_096),
      },
    };
  }
  const output = completion.stdout.trim();
  if (!output) {
    return {
      status: 'failed',
      error: {
        code: 'subprocess_empty_result',
        message: 'supervised subprocess produced no result envelope',
      },
    };
  }
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return {
      status: 'failed',
      error: {
        code: 'subprocess_invalid_json',
        message: 'supervised subprocess output was not a JSON result envelope',
      },
    };
  }
}

async function storeCutoffReached(
  db: Db,
  attemptId: string,
  attemptFence: number,
): Promise<boolean> {
  return Boolean(await db.collection<AttemptDoc>(COLLECTIONS.attempts).findOne({
    _id: attemptId,
    lifecycle: 'RUNNING',
    attemptFence,
    $expr: { $lte: ['$businessOperationCutoffAt', '$$NOW'] },
  } as unknown as Filter<AttemptDoc>, { projection: { _id: 1 } }));
}

async function ensureAttemptStop(
  client: MongoClient,
  db: Db,
  input: {
    attempt: AttemptDoc;
    processOwner: NonNullable<AttemptDoc['processOwner']>;
    cause: 'attempt_deadline' | 'lease_lost' | 'provider_error' | 'worker_shutdown';
    graceMs: number;
  },
): Promise<boolean> {
  const existing = await observeAttemptStopRequest(db, {
    attemptId: input.attempt._id,
    processOwner: input.processOwner,
  });
  if (existing) return true;
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
    { _id: input.attempt.jobId },
    { projection: { jobStopGeneration: 1 } },
  );
  const requested = await requestAttemptStop(client, db, {
    attemptId: input.attempt._id,
    cause: input.cause,
    graceMs: input.graceMs,
    jobStopGenerationAtStop:
      job?.jobStopGeneration ?? input.attempt.jobStopGenerationAtDispatch ?? 0,
  });
  return Boolean(requested);
}

async function stopOwnedWork(
  client: MongoClient,
  db: Db,
  attempt: AttemptDoc,
  processOwner: NonNullable<AttemptDoc['processOwner']>,
  handle: SupervisedProcessHandle,
  opts: SupervisedProcessWorkerOptions,
): Promise<void> {
  await stopSupervisedAttempt(client, db, {
    attemptId: attempt._id,
    processOwner,
    handle,
    abortGraceMs: opts.abortGraceMs,
    termGraceMs: opts.termGraceMs,
    killConfirmMs: opts.killConfirmMs,
    pollMs: opts.stopPollMs,
  });
}

function proofFromStoredReceipt(
  attempt: AttemptDoc,
): Parameters<typeof submitAttemptResult>[2]['processExitProof'] | null {
  const owner = attempt.processOwner;
  const receipt = attempt.processExitReceipt;
  if (!owner || !receipt) return null;
  return {
    processOwner: owner,
    receiptId: receipt.receiptId,
    terminationConfirmed: true,
    processTreeEmpty: true,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    observedAt: receipt.observedAt,
    treeEmptyAt: receipt.treeEmptyAt,
  };
}

/** Claim and execute at most one queued attempt in a real process group. */
export async function runSupervisedProcessWorkerOnce(
  client: MongoClient,
  db: Db,
  route: SupervisedProcessRouter,
  opts: SupervisedProcessWorkerOptions = {},
): Promise<boolean> {
  if (opts.signal?.aborted) return false;
  const workerInstanceId = opts.workerInstanceId ?? 'process-worker-1';
  const leaseTtlMs = positiveInteger(opts.leaseTtlMs, 30_000, 'lease TTL');
  const heartbeatEveryMs = positiveInteger(
    opts.heartbeatEveryMs,
    Math.max(50, Math.min(10_000, Math.floor(leaseTtlMs / 3))),
    'heartbeat interval',
  );
  if (heartbeatEveryMs >= leaseTtlMs) {
    throw new Error('heartbeat interval must be shorter than the lease TTL');
  }
  const stopPollMs = positiveInteger(opts.stopPollMs, 25, 'stop poll');
  const stopGraceMs = positiveInteger(opts.stopGraceMs, 3_000, 'stop grace');
  const normalExitConfirmMs = positiveInteger(
    opts.normalExitConfirmMs,
    1_000,
    'normal exit confirmation',
  );

  let candidate: AttemptDoc | null = null;
  let lease: NonNullable<Awaited<ReturnType<typeof claimAttempt>>> | null = null;
  for (;;) {
    if (opts.signal?.aborted) return false;
    candidate = await findClaimableQueuedAttempt(db);
    if (!candidate) return false;
    lease = await claimAttempt(client, db, {
      attemptId: candidate._id,
      workerInstanceId,
      leaseTtlMs,
    });
    if (lease) break;
  }
  const attempt = candidate;

  let heartbeatLost = false;
  let heartbeatInFlight: Promise<void> | null = null;
  const renewHeartbeat = async (): Promise<void> => {
    if (heartbeatLost || heartbeatInFlight) return;
    const current = (async () => {
      try {
        if (!await renewLease(db, {
          attemptId: attempt._id,
          leaseOwner: workerInstanceId,
          attemptFence: lease!.attemptFence,
          leaseTtlMs,
        })) heartbeatLost = true;
      } catch {
        heartbeatLost = true;
      }
    })();
    heartbeatInFlight = current;
    try {
      await current;
    } finally {
      if (heartbeatInFlight === current) heartbeatInFlight = null;
    }
  };
  const heartbeat = setInterval(() => {
    void renewHeartbeat();
  }, heartbeatEveryMs);

  let handle: SupervisedProcessHandle | null = null;
  try {
    // Shutdown may win immediately after the claim. Leave the still-inert
    // LEASED attempt to ordinary fenced recovery; never start new business work.
    if (opts.signal?.aborted) return true;
    const [job, task] = await Promise.all([
      db.collection<JobDoc>(COLLECTIONS.jobs)
        .findOne({ _id: attempt.jobId }),
      db.collection<TaskDoc>(COLLECTIONS.tasks)
        .findOne({ _id: attempt.taskId }),
    ]);
    const context: WorkerContext = {
      attemptId: attempt._id,
      taskId: attempt.taskId,
      jobId: attempt.jobId,
      attemptNumber: attempt.attemptNumber,
      businessOperationCutoffAt: attempt.businessOperationCutoffAt,
      workDeadlineAt: attempt.workDeadlineAt,
      hardDeadlineAt: attempt.hardDeadlineAt,
      goal: task?.goal ?? job?.goal ?? '',
      jobGoal: job?.goal ?? '',
      taskGoal: task?.goal ?? null,
      instructions: job?.instructions ?? [],
    };
    const work = await route(context);
    handle = await prepareSupervisedProcess({
      workerInstanceId,
      startupTimeoutMs: opts.wrapperStartupTimeoutMs,
      wrapperHardTtlMs: opts.wrapperHardTtlMs,
    });
    const started = await handle.start({
      client,
      db,
      attemptId: attempt._id,
      leaseOwner: workerInstanceId,
      attemptFence: lease.attemptFence,
      spec: work.spec,
    });
    const processOwner = started.processOwner;
    if (!processOwner) return true;
    if (!started.workloadStarted) {
      let requested = await observeAttemptStopRequest(db, {
        attemptId: attempt._id,
        processOwner,
      });
      // IPC delivery failure is ambiguous after the durable release CAS: START
      // may have reached the wrapper even when its callback failed. Establish
      // durable stop authority before cleanup is allowed to signal that group.
      if (!requested) {
        await ensureAttemptStop(client, db, {
          attempt,
          processOwner,
          cause: 'provider_error',
          graceMs: stopGraceMs,
        });
        requested = await observeAttemptStopRequest(db, {
          attemptId: attempt._id,
          processOwner,
        });
      }
      if (requested) {
        await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
      }
      return true;
    }

    let completion: SupervisedProcessCompletion | null = null;
    for (;;) {
      const winner = await Promise.race([
        handle.completion.then((value) => ({ type: 'completion' as const, value })),
        delay(stopPollMs).then(() => ({ type: 'poll' as const })),
      ]);
      if (winner.type === 'completion') {
        completion = winner.value;
        break;
      }
      const requested = await observeAttemptStopRequest(db, {
        attemptId: attempt._id,
        processOwner,
      });
      if (requested) {
        await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
        return true;
      }
      if (opts.signal?.aborted) {
        if (await ensureAttemptStop(client, db, {
          attempt,
          processOwner,
          cause: 'worker_shutdown',
          graceMs: stopGraceMs,
        })) {
          await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
        }
        return true;
      }
      if (heartbeatLost) {
        if (await ensureAttemptStop(client, db, {
          attempt,
          processOwner,
          cause: 'lease_lost',
          graceMs: stopGraceMs,
        })) {
          await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
        }
        return true;
      }
      if (
        Date.now() >= attempt.businessOperationCutoffAt.getTime()
        && await storeCutoffReached(db, attempt._id, lease.attemptFence)
      ) {
        if (await ensureAttemptStop(client, db, {
          attempt,
          processOwner,
          cause: 'attempt_deadline',
          graceMs: stopGraceMs,
        })) {
          await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
        }
        return true;
      }
    }

    let producer: unknown;
    try {
      producer = (work.toProducer ?? processCompletionToProducer)(completion);
    } catch (error) {
      producer = {
        status: 'failed',
        error: {
          code: 'subprocess_result_decode_failed',
          message: (error as Error).message.slice(0, 4_096),
        },
      };
    }
    const ready = await markAttemptPayloadReady(client, db, {
      attemptId: attempt._id,
      leaseOwner: workerInstanceId,
      attemptFence: lease.attemptFence,
      producer,
    });
    if (!ready.ready || heartbeatLost) {
      const requested = await observeAttemptStopRequest(db, {
        attemptId: attempt._id,
        processOwner,
      });
      if (!requested) {
        await ensureAttemptStop(client, db, {
          attempt,
          processOwner,
          cause: heartbeatLost ? 'lease_lost' : 'provider_error',
          graceMs: stopGraceMs,
        });
      }
      await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
      return true;
    }

    await handle.finalize();
    const tree = await waitForOwnedProcessTreeEmpty(processOwner, {
      deadlineAt: new Date(Math.min(
        attempt.workDeadlineAt.getTime(),
        Date.now() + normalExitConfirmMs,
      )),
      pollMs: stopPollMs,
    });
    if (!tree.empty || !tree.treeEmptyAt) {
      if (await ensureAttemptStop(client, db, {
        attempt,
        processOwner,
        cause: 'provider_error',
        graceMs: stopGraceMs,
      })) {
        await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
      }
      return true;
    }

    const receiptId = [
      'process-exit',
      processOwner.processExecutionId,
      processOwner.ownerGeneration,
    ].join(':');
    const submit = async (
      processExitProof:
        Parameters<typeof submitAttemptResult>[2]['processExitProof'],
    ) => submitAttemptResult(client, db, {
      attemptId: attempt._id,
      leaseOwner: workerInstanceId,
      attemptFence: lease!.attemptFence,
      producer,
      ...(ready.required
        ? { businessPayloadReadyGeneration: ready.generation }
        : {}),
      ...(processExitProof ? { processExitProof } : {}),
    });
    let committed = await submit({
      processOwner,
      receiptId,
      terminationConfirmed: true,
      processTreeEmpty: true,
      exitCode: completion.exitCode,
      signal: completion.signal,
      observedAt: completion.observedAt,
      treeEmptyAt: tree.treeEmptyAt,
    });
    if (!committed.committed) {
      const current = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
        .findOne({ _id: attempt._id });
      const storedProof = current ? proofFromStoredReceipt(current) : null;
      if (storedProof) committed = await submit(storedProof);
    }
    if (!committed.committed) {
      const requested = await observeAttemptStopRequest(db, {
        attemptId: attempt._id,
        processOwner,
      });
      if (requested) {
        await stopOwnedWork(client, db, attempt, processOwner, handle, opts);
      }
    }
    return true;
  } catch (error) {
    const processOwner = handle?.processOwner;
    if (handle && processOwner) {
      if (await ensureAttemptStop(client, db, {
        attempt,
        processOwner,
        cause: 'provider_error',
        graceMs: stopGraceMs,
      }).catch(() => false)) {
        await stopOwnedWork(
          client,
          db,
          attempt,
          processOwner,
          handle,
          opts,
        ).catch(() => {});
      }
      return true;
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    await heartbeatInFlight;
    await handle?.cleanup();
  }
}

export async function drainSupervisedProcessWorkers(
  client: MongoClient,
  db: Db,
  route: SupervisedProcessRouter,
  opts: SupervisedProcessWorkerOptions = {},
): Promise<number> {
  let processed = 0;
  for (;;) {
    if (opts.signal?.aborted) break;
    if (!await runSupervisedProcessWorkerOnce(client, db, route, opts)) break;
    processed++;
  }
  return processed;
}
