/**
 * Durable PROCESS_STOP_V1 boundary.
 *
 * A stop request revokes ordinary result authority by moving the attempt out of
 * RUNNING, but deliberately preserves the lease/fence and supervised process
 * identity required to acknowledge that exact stop epoch. Only a trusted,
 * exactly matching process owner may record a confirmed empty-process-tree
 * receipt. An unconfirmed grace expiry fails closed to UNKNOWN_OUTCOME and
 * reconciliation; neither path retries business work. PR-39's separate flat
 * terminal barrier may consume the settled fact, but owns all job semantics.
 */
import type { ClientSession, Db, Filter, MongoClient } from 'mongodb';
import type {
  AttemptOutcome,
  PrimaryAttemptStopCause,
} from '../contracts/index.js';
import { canonicalHash, runTxn } from './txn.js';
import {
  COLLECTIONS,
  type AttemptDoc,
  type AttemptProcessOwnerDoc,
  type AttemptStopReceiptDoc,
  type JobDoc,
  type OutboxDoc,
  type TaskDoc,
  type TimerDoc,
} from './collections.js';
import {
  attemptProcessOwnerFilter as processOwnerFilter,
  sameAttemptProcessOwner as sameProcessOwner,
} from './process-supervision.js';
import {
  ensureStopControlRecoveryInSession,
  runStopControlRecoveryActivation,
} from './stop-control-recovery.js';

const TERMINAL_TASK_PHASES = new Set<TaskDoc['phase']>([
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'BLOCKED',
  'TIMED_OUT',
  'CANCELLED',
  'SUPERSEDED',
  'UNKNOWN_OUTCOME',
]);
const DEFAULT_STOP_TIMER_LIMIT = 128;

export class AttemptStopReceiptConflictError extends Error {
  constructor(readonly attemptId: string) {
    super(`attempt ${attemptId} already has a different immutable stop receipt`);
    this.name = 'AttemptStopReceiptConflictError';
  }
}

export class InvalidAttemptStopReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAttemptStopReceiptError';
  }
}

class AttemptStopAggregateAuthorityLostError extends Error {
  constructor(readonly attemptId: string) {
    super(`attempt ${attemptId} lost task/job reconciliation authority`);
    this.name = 'AttemptStopAggregateAuthorityLostError';
  }
}

export interface AttemptStopRequestResult {
  attemptId: string;
  jobId: string;
  taskId: string;
  attemptFence: number;
  leaseOwner: string | null;
  stopGeneration: number;
  attemptStopTimerGeneration: number;
  primaryAttemptStopCause: PrimaryAttemptStopCause;
  secondaryAttemptStopCauses: PrimaryAttemptStopCause[];
  attemptStopGraceDueAt: Date;
  jobStopGenerationAtStop: number;
  processOwner: AttemptProcessOwnerDoc | null;
  newlyRequested: boolean;
  secondaryCauseAdded: boolean;
}

export interface RequestAttemptStopInput {
  attemptId: string;
  cause: PrimaryAttemptStopCause;
  graceMs: number;
  jobStopGenerationAtStop: number;
}

export interface ObserveAttemptStopInput {
  attemptId: string;
  /** Identity returned by the durable process-registration boundary. */
  processOwner: AttemptProcessOwnerDoc;
}

export interface ObservedAttemptStopRequest {
  attemptId: string;
  jobId: string;
  taskId: string;
  attemptFence: number;
  stopGeneration: number;
  attemptStopTimerGeneration: number;
  primaryAttemptStopCause: PrimaryAttemptStopCause;
  secondaryAttemptStopCauses: PrimaryAttemptStopCause[];
  attemptStopGraceDueAt: Date;
  jobStopGenerationAtStop: number | null;
}

export interface RecordAttemptStopReceiptInput {
  attemptId: string;
  stopGeneration: number;
  attemptFence: number;
  processOwner: AttemptProcessOwnerDoc;
  receiptId: string;
  terminationConfirmed: true;
  processTreeEmpty: true;
  exitCode: number | null;
  signal: string | null;
  observedAt: Date;
  treeEmptyAt: Date;
}

export interface RecordAttemptStopReceiptResult {
  attemptId: string;
  stopGeneration: number;
  outcome: AttemptOutcome;
  receiptId: string;
  recorded: boolean;
  deduped: boolean;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function validateStopRequestInput(
  graceMs: number,
  jobStopGenerationAtStop: number,
): void {
  assertNonNegativeInteger(graceMs, 'stop grace');
  assertNonNegativeInteger(
    jobStopGenerationAtStop,
    'job stop generation at stop',
  );
}

function stopRequestResult(
  attempt: AttemptDoc,
  newlyRequested: boolean,
  secondaryCauseAdded: boolean,
): AttemptStopRequestResult | null {
  const stopGeneration = attempt.stopGeneration ?? 0;
  const timerGeneration = attempt.attemptStopTimerGeneration ?? 0;
  if (
    stopGeneration <= 0
    || timerGeneration <= 0
    || !attempt.primaryAttemptStopCause
    || !attempt.attemptStopGraceDueAt
    || attempt.jobStopGenerationAtStop === null
    || attempt.jobStopGenerationAtStop === undefined
  ) return null;
  return {
    attemptId: attempt._id,
    jobId: attempt.jobId,
    taskId: attempt.taskId,
    attemptFence: attempt.attemptFence,
    leaseOwner: attempt.leaseOwner,
    stopGeneration,
    attemptStopTimerGeneration: timerGeneration,
    primaryAttemptStopCause: attempt.primaryAttemptStopCause,
    secondaryAttemptStopCauses: attempt.secondaryAttemptStopCauses ?? [],
    attemptStopGraceDueAt: attempt.attemptStopGraceDueAt,
    jobStopGenerationAtStop: attempt.jobStopGenerationAtStop,
    processOwner: attempt.processOwner ?? null,
    newlyRequested,
    secondaryCauseAdded,
  };
}

/**
 * First-stop CAS for callers that already own a wider control transaction.
 * Replays on STOP_REQUESTED never move the grace deadline or generation; a
 * distinct later cause is appended once as secondary audit evidence.
 */
export async function requestAttemptStopInSession(
  db: Db,
  session: ClientSession,
  attempt: AttemptDoc,
  cause: PrimaryAttemptStopCause,
  graceMs: number,
  jobStopGenerationAtStop: number,
): Promise<AttemptStopRequestResult | null> {
  validateStopRequestInput(graceMs, jobStopGenerationAtStop);
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);

  if (attempt.lifecycle === 'STOP_REQUESTED') {
    const currentPrimary = attempt.primaryAttemptStopCause;
    if (!currentPrimary) return null;
    const existingSecondary = attempt.secondaryAttemptStopCauses ?? [];
    if (
      cause === currentPrimary
      || existingSecondary.includes(cause)
    ) return stopRequestResult(attempt, false, false);

    const updated = await attempts.findOneAndUpdate(
      {
        _id: attempt._id,
        lifecycle: 'STOP_REQUESTED',
        attemptFence: attempt.attemptFence,
        primaryAttemptStopCause: currentPrimary,
        $expr: {
          $eq: [
            { $ifNull: ['$stopGeneration', 0] },
            attempt.stopGeneration ?? 0,
          ],
        },
      } as unknown as Filter<AttemptDoc>,
      [{
        $set: {
          secondaryAttemptStopCauses: {
            $setUnion: [
              { $ifNull: ['$secondaryAttemptStopCauses', []] },
              [cause],
            ],
          },
          updatedAt: '$$NOW',
        },
      }],
      { session, returnDocument: 'after' },
    );
    return updated ? stopRequestResult(updated, false, true) : null;
  }

  if (attempt.lifecycle !== 'RUNNING') return null;
  const previousStopGeneration = attempt.stopGeneration ?? 0;
  const stopGeneration = previousStopGeneration + 1;
  const timerGeneration = (attempt.attemptStopTimerGeneration ?? 0) + 1;
  const stopped = await attempts.findOneAndUpdate(
    {
      _id: attempt._id,
      lifecycle: 'RUNNING',
      attemptFence: attempt.attemptFence,
      leaseOwner: attempt.leaseOwner,
      $expr: {
        $and: [
          {
            $eq: [
              { $ifNull: ['$stopGeneration', 0] },
              previousStopGeneration,
            ],
          },
          { $eq: [{ $ifNull: ['$primaryAttemptStopCause', null] }, null] },
          { $eq: [{ $ifNull: ['$stopReceipt', null] }, null] },
        ],
      },
    } as unknown as Filter<AttemptDoc>,
    [{
      $set: {
        lifecycle: 'STOP_REQUESTED',
        stopGeneration,
        primaryAttemptStopCause: cause,
        secondaryAttemptStopCauses: {
          $ifNull: ['$secondaryAttemptStopCauses', []],
        },
        attemptStopGraceDueAt: {
          $min: [
            {
              $dateAdd: {
                startDate: '$$NOW',
                unit: 'millisecond',
                amount: graceMs,
              },
            },
            '$hardDeadlineAt',
          ],
        },
        attemptStopTimerGeneration: timerGeneration,
        jobStopGenerationAtStop,
        processState: 'STOP_REQUESTED',
        terminationConfirmed: null,
        reasonCode: cause,
        updatedAt: '$$NOW',
      },
    }],
    { session, returnDocument: 'after' },
  );
  if (!stopped || !stopped.attemptStopGraceDueAt) return null;

  const timerId = `tmr_attempt_stop:${stopped._id}:${timerGeneration}`;
  await db.collection<TimerDoc>(COLLECTIONS.timers).insertOne({
    _id: timerId,
    kind: 'attempt_stop_grace',
    jobId: stopped.jobId,
    entityId: stopped._id,
    generation: timerGeneration,
    sourceRedriveAttempt: null,
    fireAt: stopped.attemptStopGraceDueAt,
    state: 'PENDING',
    firedAt: null,
    wakeId: null,
    createdAt: stopped.updatedAt,
  }, { session });

  await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
    _id: `obx_attempt_stop:${stopped._id}:${stopGeneration}`,
    aggregate: stopped.jobId,
    type: 'AttemptStopRequested',
    state: 'PENDING',
    payload: {
      attemptId: stopped._id,
      jobId: stopped.jobId,
      taskId: stopped.taskId,
      attemptFence: stopped.attemptFence,
      leaseOwner: stopped.leaseOwner,
      stopGeneration,
      attemptStopTimerGeneration: timerGeneration,
      attemptStopGraceDueAt: stopped.attemptStopGraceDueAt,
      primaryAttemptStopCause: cause,
      jobStopGenerationAtStop,
      processOwner: stopped.processOwner ?? null,
    },
    createdAt: stopped.updatedAt,
  }, { session });

  return stopRequestResult(stopped, true, false);
}

/** Standalone transactional first-stop request. */
export async function requestAttemptStop(
  client: MongoClient,
  db: Db,
  input: RequestAttemptStopInput,
): Promise<AttemptStopRequestResult | null> {
  validateStopRequestInput(input.graceMs, input.jobStopGenerationAtStop);
  const { value } = await runTxn(client, async (session) => {
    const attempt = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
      .findOne({ _id: input.attemptId }, { session });
    if (!attempt) return null;
    return requestAttemptStopInSession(
      db,
      session,
      attempt,
      input.cause,
      input.graceMs,
      input.jobStopGenerationAtStop,
    );
  });
  return value;
}

/**
 * Targeted control-plane observation. A worker may only observe the request
 * addressed to the complete supervised process identity it registered.
 */
export async function observeAttemptStopRequest(
  db: Db,
  input: ObserveAttemptStopInput,
): Promise<ObservedAttemptStopRequest | null> {
  if (input.processOwner.attemptFence < 0) return null;
  const attempt = await db.collection<AttemptDoc>(COLLECTIONS.attempts).findOne({
    _id: input.attemptId,
    lifecycle: 'STOP_REQUESTED',
    attemptFence: input.processOwner.attemptFence,
    stopReceipt: null,
    ...processOwnerFilter(input.processOwner),
  } as unknown as Filter<AttemptDoc>);
  if (!attempt || !sameProcessOwner(attempt.processOwner, input.processOwner)) {
    return null;
  }
  const request = stopRequestResult(attempt, false, false);
  if (!request) return null;
  return {
    attemptId: request.attemptId,
    jobId: request.jobId,
    taskId: request.taskId,
    attemptFence: request.attemptFence,
    stopGeneration: request.stopGeneration,
    attemptStopTimerGeneration: request.attemptStopTimerGeneration,
    primaryAttemptStopCause: request.primaryAttemptStopCause,
    secondaryAttemptStopCauses: request.secondaryAttemptStopCauses,
    attemptStopGraceDueAt: request.attemptStopGraceDueAt,
    jobStopGenerationAtStop: attempt.jobStopGenerationAtStop ?? null,
  };
}

function confirmedOutcome(cause: PrimaryAttemptStopCause): AttemptOutcome {
  if (
    cause === 'attempt_deadline'
    || cause === 'task_deadline'
    || cause === 'job_deadline'
    || cause === 'active_budget_exhausted'
  ) return 'TIMED_OUT';
  if (cause === 'provider_error') return 'FAILED';
  if (cause === 'lease_lost') return 'WORKER_LOST';
  return 'CANCELLED';
}

function buildStopReceipt(
  input: RecordAttemptStopReceiptInput,
): AttemptStopReceiptDoc {
  const owner = input.processOwner;
  const hashPayload = {
    receiptId: input.receiptId,
    stopGeneration: input.stopGeneration,
    processExecutionId: owner.processExecutionId,
    runtimeRunId: owner.runtimeRunId,
    workerInstanceId: owner.workerInstanceId,
    processOwnerGeneration: owner.ownerGeneration,
    attemptFence: input.attemptFence,
    hostId: owner.hostId,
    hostBootId: owner.hostBootId,
    pidNamespaceId: owner.pidNamespaceId ?? null,
    pid: owner.pid,
    pgid: owner.pgid,
    sid: owner.sid ?? null,
    processStartToken: owner.processStartToken,
    confirmationKind: 'PROCESS_TREE_EMPTY',
    terminationConfirmed: true,
    processTreeEmpty: true,
    exitCode: input.exitCode,
    signal: input.signal,
    observedAt: input.observedAt.toISOString(),
    treeEmptyAt: input.treeEmptyAt.toISOString(),
  };
  return {
    ...hashPayload,
    pidNamespaceId: owner.pidNamespaceId,
    sid: owner.sid,
    receiptHash: canonicalHash(hashPayload),
    confirmationKind: 'PROCESS_TREE_EMPTY',
    terminationConfirmed: true,
    processTreeEmpty: true,
    observedAt: input.observedAt,
    treeEmptyAt: input.treeEmptyAt,
  };
}

function validateReceiptInput(input: RecordAttemptStopReceiptInput): void {
  assertNonNegativeInteger(input.stopGeneration, 'stop generation');
  assertNonNegativeInteger(input.attemptFence, 'attempt fence');
  if (
    input.terminationConfirmed !== true
    || input.processTreeEmpty !== true
  ) {
    throw new InvalidAttemptStopReceiptError(
      'a stop receipt requires terminationConfirmed=true and processTreeEmpty=true',
    );
  }
  if (!input.receiptId) {
    throw new InvalidAttemptStopReceiptError('receiptId must be non-empty');
  }
  if (
    !(input.observedAt instanceof Date)
    || Number.isNaN(input.observedAt.getTime())
    || !(input.treeEmptyAt instanceof Date)
    || Number.isNaN(input.treeEmptyAt.getTime())
  ) {
    throw new InvalidAttemptStopReceiptError(
      'receipt observation times must be valid Dates',
    );
  }
  if (input.treeEmptyAt.getTime() < input.observedAt.getTime()) {
    throw new InvalidAttemptStopReceiptError(
      'receipt treeEmptyAt must not precede observedAt',
    );
  }
  if (
    input.exitCode !== null
    && (!Number.isInteger(input.exitCode) || input.exitCode < 0)
  ) {
    throw new InvalidAttemptStopReceiptError(
      'receipt exitCode must be a non-negative integer or null',
    );
  }
  if (
    input.signal !== null
    && (typeof input.signal !== 'string' || input.signal.length === 0)
  ) {
    throw new InvalidAttemptStopReceiptError(
      'receipt signal must be a non-empty string or null',
    );
  }
  if (input.processOwner.attemptFence !== input.attemptFence) {
    throw new InvalidAttemptStopReceiptError(
      'process owner fence does not match receipt fence',
    );
  }
}

function sameReceiptAuthority(
  left: AttemptStopReceiptDoc,
  right: AttemptStopReceiptDoc,
): boolean {
  return left.stopGeneration === right.stopGeneration
    && left.attemptFence === right.attemptFence
    && left.processExecutionId === right.processExecutionId
    && left.runtimeRunId === right.runtimeRunId
    && left.workerInstanceId === right.workerInstanceId
    && left.processOwnerGeneration === right.processOwnerGeneration
    && left.hostId === right.hostId
    && left.hostBootId === right.hostBootId
    && (left.pidNamespaceId ?? null) === (right.pidNamespaceId ?? null)
    && left.pid === right.pid
    && left.pgid === right.pgid
    && (left.sid ?? null) === (right.sid ?? null)
    && left.processStartToken === right.processStartToken;
}

async function moveTaskAndJobToReconciling(
  db: Db,
  session: ClientSession,
  attempt: AttemptDoc,
  settledOutcome: AttemptOutcome,
  at: Date,
): Promise<JobDoc | null> {
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const task = await tasks.findOne(
    { _id: attempt.taskId, jobId: attempt.jobId },
    { session },
  );
  const job = await jobs.findOne({ _id: attempt.jobId }, { session });
  if (!task || !job) return job;
  // Process truth remains recordable even after a different aggregate owner
  // settled/superseded the business projection. In that case this boundary
  // must not reopen the task/job; it still stores the exact receipt or UNKNOWN.
  const dispatchedTaskStopGeneration =
    attempt.taskStopGenerationAtDispatch ?? 0;
  const taskStopGeneration = task.stopGeneration ?? 0;
  const exactAggregateAuthority = Boolean(
    job.terminalOutcome === null
    && job.planVersion === attempt.planVersion
    && job.jobStopGeneration === attempt.jobStopGenerationAtStop
    && task.planVersion === attempt.planVersion
    && task.activeAttemptId === attempt._id
    && !TERMINAL_TASK_PHASES.has(task.phase)
    && (
      (
        job.controlState === 'STOP_REQUESTED'
        && task.controlState === 'STOP_REQUESTED'
        && taskStopGeneration === dispatchedTaskStopGeneration + 1
      )
      || (
        job.controlState !== 'STOP_REQUESTED'
        && task.controlState === 'NONE'
        && taskStopGeneration === dispatchedTaskStopGeneration
      )
    ),
  );
  if (!exactAggregateAuthority) return job;

  const taskCas = await tasks.updateOne(
    {
      _id: task._id,
      jobId: attempt.jobId,
      planVersion: attempt.planVersion,
      phase: task.phase,
      controlState: task.controlState,
      stopGeneration: taskStopGeneration,
      activeAttemptId: attempt._id,
    },
    {
      $set: {
        phase: 'RECONCILING',
        activeAttemptId: null,
        businessPayloadReadyAttemptId: null,
        businessPayloadReadyGeneration: 0,
        pendingResultId: null,
        retryNotBefore: null,
        updatedAt: at,
      },
    },
    { session },
  );
  const jobCas = await jobs.updateOne(
    {
      _id: job._id,
      terminalOutcome: null,
      stateVersion: job.stateVersion,
      planVersion: attempt.planVersion,
      controlState: job.controlState,
      jobStopGeneration: attempt.jobStopGenerationAtStop!,
    },
    {
      $set: {
        phase: 'RECONCILING',
        ...(job.controlState === 'STOP_REQUESTED'
          && settledOutcome === 'UNKNOWN_OUTCOME'
          ? { pendingTerminalOutcome: 'UNKNOWN_OUTCOME' as const }
          : {}),
        updatedAt: at,
      },
      $inc: { stateVersion: 1 },
    },
    { session },
  );
  if (taskCas.modifiedCount !== 1 || jobCas.modifiedCount !== 1) {
    throw new AttemptStopAggregateAuthorityLostError(attempt._id);
  }
  return job;
}

/**
 * Record a trusted supervisor receipt. The complete registered process owner,
 * current attempt fence and current stop generation must all match. Receipt
 * replay is idempotent; any different receipt for the attempt is a conflict.
 */
export async function recordAttemptStopReceipt(
  client: MongoClient,
  db: Db,
  input: RecordAttemptStopReceiptInput,
): Promise<RecordAttemptStopReceiptResult | null> {
  validateReceiptInput(input);
  const candidate = buildStopReceipt(input);
  try {
    const { value } = await runTxn(client, async (session) => {
      const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
      const current = await attempts.findOne(
        { _id: input.attemptId },
        { session },
      );
      if (!current) return null;
      if (current.stopReceipt) {
        if (
          current.stopReceipt.stopGeneration !== input.stopGeneration
          || current.stopReceipt.attemptFence !== input.attemptFence
          || !sameProcessOwner(current.processOwner, input.processOwner)
          || !sameReceiptAuthority(current.stopReceipt, candidate)
        ) {
          return null;
        }
        if (
          current.stopReceipt.receiptId === candidate.receiptId
          && current.stopReceipt.receiptHash === candidate.receiptHash
        ) {
          const stopOwner = await ensureStopControlRecoveryInSession(
            db,
            session,
            current.jobId,
          );
          return {
            result: {
              attemptId: current._id,
              stopGeneration: current.stopReceipt.stopGeneration,
              outcome: current.outcome ?? 'UNKNOWN_OUTCOME',
              receiptId: current.stopReceipt.receiptId,
              recorded: false,
              deduped: true,
            } satisfies RecordAttemptStopReceiptResult,
            activationId: stopOwner?.activationId ?? null,
          };
        }
        throw new AttemptStopReceiptConflictError(current._id);
      }
      if (
        current.lifecycle !== 'STOP_REQUESTED'
        || (current.stopGeneration ?? 0) !== input.stopGeneration
        || current.attemptFence !== input.attemptFence
        || !sameProcessOwner(current.processOwner, input.processOwner)
        || !current.primaryAttemptStopCause
      ) return null;

      const outcome = confirmedOutcome(current.primaryAttemptStopCause);
      const finished = await attempts.findOneAndUpdate(
        {
          _id: current._id,
          lifecycle: 'STOP_REQUESTED',
          attemptFence: input.attemptFence,
          stopGeneration: input.stopGeneration,
          stopReceipt: null,
          ...processOwnerFilter(input.processOwner),
          $expr: {
            $gt: ['$attemptStopGraceDueAt', '$$NOW'],
          },
        } as unknown as Filter<AttemptDoc>,
        [{
          $set: {
            lifecycle: 'FINISHED',
            outcome,
            reasonCode: current.primaryAttemptStopCause,
            leaseOwner: null,
            leaseExpiresAt: null,
            attemptFence: { $add: ['$attemptFence', 1] },
            processState: 'EXITED',
            terminationConfirmed: true,
            stopReceipt: { $literal: candidate },
            processSignalStage: 'TREE_EMPTY',
            processTreeEmptyAt: { $literal: input.treeEmptyAt },
            processReconcileNextAt: null,
            processReconcileProbeAttempt: 0,
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!finished) return null;

      const job = await moveTaskAndJobToReconciling(
        db,
        session,
        current,
        outcome,
        finished.updatedAt,
      );
      await db.collection<TimerDoc>(COLLECTIONS.timers).updateOne(
        {
          _id: `tmr_attempt_stop:${current._id}:${current.attemptStopTimerGeneration ?? 0}`,
          kind: 'attempt_stop_grace',
          entityId: current._id,
          generation: current.attemptStopTimerGeneration ?? 0,
          state: 'PENDING',
        },
        { $set: { state: 'CANCELLED' } },
        { session },
      );
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: `obx_attempt_stopped:${current._id}:${input.stopGeneration}`,
        aggregate: current.jobId,
        type: 'AttemptStopped',
        state: 'PENDING',
        payload: {
          resourceId: job?.resourceId ?? null,
          conversationId: job?.conversationId ?? null,
          jobId: current.jobId,
          taskId: current.taskId,
          attemptId: current._id,
          attemptFence: input.attemptFence,
          stopGeneration: input.stopGeneration,
          primaryAttemptStopCause: current.primaryAttemptStopCause,
          secondaryAttemptStopCauses:
            current.secondaryAttemptStopCauses ?? [],
          outcome,
          terminationConfirmed: true,
          processTreeEmpty: true,
          receiptId: candidate.receiptId,
          receiptHash: candidate.receiptHash,
        },
        createdAt: finished.updatedAt,
      }, { session });
      const stopOwner = await ensureStopControlRecoveryInSession(
        db,
        session,
        current.jobId,
        { makeEligibleNow: true },
      );
      return {
        result: {
          attemptId: current._id,
          stopGeneration: input.stopGeneration,
          outcome,
          receiptId: candidate.receiptId,
          recorded: true,
          deduped: false,
        } satisfies RecordAttemptStopReceiptResult,
        activationId: stopOwner?.activationId ?? null,
      };
    });
    if (!value) return null;
    if (value.activationId) {
      await runStopControlRecoveryActivation(
        client,
        db,
        value.activationId,
      );
    }
    return value.result;
  } catch (error) {
    if (error instanceof AttemptStopAggregateAuthorityLostError) return null;
    throw error;
  }
}

/**
 * Fire bounded due PROCESS_STOP_V1 grace timers. A missing receipt is never
 * interpreted as success: the attempt is fenced to UNKNOWN_OUTCOME, its
 * aggregate stays nonterminal in RECONCILING, and an operator alert is emitted.
 */
export async function fireDueAttemptStopTimers(
  client: MongoClient,
  db: Db,
  opts: { limit?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? DEFAULT_STOP_TIMER_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('attempt stop timer limit must be a positive integer');
  }
  let finalized = 0;
  for (let scanned = 0; scanned < limit; scanned++) {
    try {
      const { value } = await runTxn(client, async (session) => {
        const timer = await db.collection<TimerDoc>(COLLECTIONS.timers)
          .findOneAndUpdate(
            {
              kind: 'attempt_stop_grace',
              state: 'PENDING',
              $expr: { $lte: ['$fireAt', '$$NOW'] },
            } as unknown as Filter<TimerDoc>,
            [{ $set: { state: 'FIRED', firedAt: '$$NOW' } }],
            {
              session,
              sort: { fireAt: 1, _id: 1 },
              returnDocument: 'after',
            },
          );
        if (!timer) return { scanned: false, finalized: false };

        const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
        const current = await attempts.findOne(
          { _id: timer.entityId, jobId: timer.jobId },
          { session },
        );
        if (
          !current
          || current.lifecycle !== 'STOP_REQUESTED'
          || (current.stopGeneration ?? 0) <= 0
          || (current.attemptStopTimerGeneration ?? 0) !== timer.generation
          || timer._id
            !== `tmr_attempt_stop:${current._id}:${timer.generation}`
          || current.stopReceipt !== null
        ) return { scanned: true, finalized: false };

        const authorityFence = current.attemptFence;
        const stopGeneration = current.stopGeneration!;
        const finished = await attempts.findOneAndUpdate(
          {
            _id: current._id,
            lifecycle: 'STOP_REQUESTED',
            attemptFence: authorityFence,
            stopGeneration,
            attemptStopTimerGeneration: timer.generation,
            stopReceipt: null,
            $expr: {
              $lte: ['$attemptStopGraceDueAt', '$$NOW'],
            },
          } as unknown as Filter<AttemptDoc>,
          [{
            $set: {
              lifecycle: 'FINISHED',
              outcome: 'UNKNOWN_OUTCOME',
              reasonCode: 'attempt_stop_unconfirmed',
              leaseOwner: null,
              leaseExpiresAt: null,
              attemptFence: { $add: ['$attemptFence', 1] },
              processState: 'UNKNOWN',
              terminationConfirmed: false,
              processReconcileNextAt: '$$NOW',
              processReconcileProbeAttempt: 0,
              updatedAt: '$$NOW',
            },
          }],
          { session, returnDocument: 'after' },
        );
        if (!finished) return { scanned: true, finalized: false };

        const job = await moveTaskAndJobToReconciling(
          db,
          session,
          current,
          'UNKNOWN_OUTCOME',
          finished.updatedAt,
        );
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
          _id: `obx_attempt_stop_alert:${current._id}:${stopGeneration}`,
          aggregate: current.jobId,
          type: 'OperatorAlertRequested',
          state: 'PENDING',
          payload: {
            alertType: 'attempt_stop_unconfirmed',
            resourceId: job?.resourceId ?? null,
            conversationId: job?.conversationId ?? null,
            jobId: current.jobId,
            taskId: current.taskId,
            attemptId: current._id,
            attemptFence: authorityFence,
            stopGeneration,
            primaryAttemptStopCause: current.primaryAttemptStopCause ?? null,
            secondaryAttemptStopCauses:
              current.secondaryAttemptStopCauses ?? [],
            attemptStopGraceDueAt: current.attemptStopGraceDueAt ?? null,
            processOwner: current.processOwner ?? null,
            terminationConfirmed: false,
            processTreeEmpty: false,
            outcome: 'UNKNOWN_OUTCOME',
          },
          createdAt: finished.updatedAt,
        }, { session });
        // Do not synchronously drain from the timer API: the durable typed owner
        // is enough to close the crash window, while the reconciler/compatibility
        // façade performs the bounded control reduction.
        await ensureStopControlRecoveryInSession(
          db,
          session,
          current.jobId,
          { makeEligibleNow: true },
        );
        return { scanned: true, finalized: true };
      });
      if (!value.scanned) break;
      if (value.finalized) finalized++;
    } catch (error) {
      if (error instanceof AttemptStopAggregateAuthorityLostError) continue;
      throw error;
    }
  }
  return finalized;
}
