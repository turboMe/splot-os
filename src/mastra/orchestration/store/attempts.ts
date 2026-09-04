/**
 * Task + attempt lifecycle with lease / fence / heartbeat (plan §7.2, §7.3) and
 * the walking-skeleton A boundary (attempt finalization + immutable result).
 * Legacy/test tasks retain the fused task transition; planner-created flat
 * SERIAL tasks opt into the first durable inbox→RESULT_DRAIN reducer slice.
 * General activation/ancestor/evidence settlement remains deferred.
 *
 * Invariants exercised here:
 *  - server-minted `attemptId` + monotonic `attemptNumber` (IDN-001 / N1);
 *  - `attemptFence` rises on every claim; renew/result require the current fence
 *    and owner, so a stale worker has no authority (inv. #8, DUR-001);
 *  - result submission validates the producer envelope — empty/prose/malformed
 *    become `FAILED(invalid_result)`, never a false `OK` (RES-001 / inv. #6);
 *  - store-time (`$$NOW`) is compared inside the conditional write (GAP-CLOCK-01),
 *    so claim/submit/reap race on the deadline atomically.
 */
import type { Db, MongoClient, Filter } from 'mongodb';
import {
  newAttemptId, newResultId, newOutboxId, newTaskId,
  validateProducerResult, deriveAttemptDeadlines, isProgressiveAttemptPolicy,
  type ProducerResult, type ProducerStatus, type ProgressiveAttemptPolicy,
  type AttemptProgressDecision, type AttemptProgressMilestone,
  type AttemptOutcome, type TaskPhase, type JobPhase,
} from '../contracts/index.js';
import type { JobDoc, ControlRequestDoc, RequestKind } from './collections.js';

/** Normative producer-status → (attempt outcome, task phase) mapping (§9.1). */
const STATUS_TO_OUTCOME: Record<ProducerStatus, { attemptOutcome: AttemptOutcome; taskPhase: TaskPhase }> = {
  ok: { attemptOutcome: 'OK', taskPhase: 'SUCCEEDED' },
  partial: { attemptOutcome: 'PARTIAL', taskPhase: 'PARTIAL' },
  failed: { attemptOutcome: 'FAILED', taskPhase: 'FAILED' },
  timed_out: { attemptOutcome: 'TIMED_OUT', taskPhase: 'TIMED_OUT' },
  cancelled: { attemptOutcome: 'CANCELLED', taskPhase: 'CANCELLED' },
  blocked: { attemptOutcome: 'BLOCKED', taskPhase: 'BLOCKED' },
  unknown_outcome: { attemptOutcome: 'UNKNOWN_OUTCOME', taskPhase: 'UNKNOWN_OUTCOME' },
};

/** blocked.kind → wait phases (§8.8). */
const BLOCKED_WAIT: Record<RequestKind, { taskPhase: TaskPhase; jobPhase: JobPhase }> = {
  user: { taskPhase: 'WAITING_INPUT', jobPhase: 'AWAITING_USER' },
  approval: { taskPhase: 'WAITING_INPUT', jobPhase: 'AWAITING_APPROVAL' },
  external: { taskPhase: 'WAITING_DEPENDENCY', jobPhase: 'AWAITING_EXTERNAL' },
  dependency: { taskPhase: 'WAITING_DEPENDENCY', jobPhase: 'AWAITING_EXTERNAL' },
};
import { runTxn, canonicalHash } from './txn.js';
import {
  COLLECTIONS,
  type TaskDoc,
  type AttemptDoc,
  type ResultDoc,
  type JobInboxDoc,
  type JobEventDoc,
  type OutboxDoc,
  type TimerDoc,
  type DispatchEdgeDoc,
  type AttemptProcessExitReceiptDoc,
  type AttemptProcessOwnerDoc,
} from './collections.js';
import {
  AttemptProcessExitReceiptConflictError,
  buildAttemptProcessExitReceipt,
  sameAttemptProcessOwner,
  sameExitReceiptAuthority,
  type AttemptProcessExitProofInput,
} from './process-supervision.js';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_ATTEMPT_CAP_MS = 300_000;
const DEFAULT_FINALIZE_RESERVE_MS = 2_000;
const DEFAULT_RESULT_COMMIT_RESERVE_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const TERMINAL_TASK_PHASES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'TIMED_OUT', 'CANCELLED', 'SUPERSEDED', 'UNKNOWN_OUTCOME']);
const PAYLOAD_READY_STATUSES = new Set<ProducerStatus>(['ok', 'partial', 'blocked', 'failed']);

class AttemptClaimAuthorityLostError extends Error {
  constructor() {
    super('attempt claim authority changed during the claim transaction');
    this.name = 'AttemptClaimAuthorityLostError';
  }
}

class AttemptOperationAuthorityLostError extends Error {
  constructor() {
    super('attempt operation-start authority changed during the transaction');
    this.name = 'AttemptOperationAuthorityLostError';
  }
}

class AttemptProcessReleaseAuthorityLostError extends Error {
  constructor() {
    super('attempt process-release authority changed during the transaction');
    this.name = 'AttemptProcessReleaseAuthorityLostError';
  }
}

export class AttemptDispatchAuthorityLostError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} is not dispatchable under current SERIAL authority`);
    this.name = 'AttemptDispatchAuthorityLostError';
  }
}

export class TaskCreateAuthorityLostError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} cannot admit a task under current authority`);
    this.name = 'TaskCreateAuthorityLostError';
  }
}

interface PreparedCandidate {
  validation: ReturnType<typeof validateProducerResult>;
  payloadHash: string;
  requiresPayloadReady: boolean;
}

/** Hash the normalized producer candidate, never raw model-controlled identity. */
function prepareCandidate(producer: unknown): PreparedCandidate {
  const validation = validateProducerResult(producer);
  if (!validation.ok) {
    return {
      validation,
      payloadHash: canonicalHash({
        kind: 'invalid_result',
        reason: validation.reason,
        detail: validation.detail ?? null,
      }),
      requiresPayloadReady: false,
    };
  }
  return {
    validation,
    payloadHash: canonicalHash({ kind: 'producer_result', producer: validation.value }),
    requiresPayloadReady: PAYLOAD_READY_STATUSES.has(validation.value.status),
  };
}

/** Pure helper for tests and result-ingress adapters. */
export function producerCandidateHash(producer: unknown): string {
  return prepareCandidate(producer).payloadHash;
}

export interface LeaseHandle {
  attemptId: string;
  attemptFence: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

/**
 * Trusted supervisor registration persisted by the operation-start CAS before
 * workload execution. PID/PGID alone are never authority; the whole tuple is.
 */
export type AttemptProcessOwnerRegistration = Omit<
  AttemptProcessOwnerDoc,
  'attemptFence' | 'registeredAt' | 'startedAt'
>;

function validateProcessOwnerRegistration(
  registration: AttemptProcessOwnerRegistration,
  leaseOwner: string,
): void {
  const requiredStrings = [
    registration.processExecutionId,
    registration.runtimeRunId,
    registration.workerInstanceId,
    registration.hostId,
    registration.hostBootId,
    registration.processStartToken,
  ];
  if (requiredStrings.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('process owner identity fields must be non-empty');
  }
  if (registration.workerInstanceId !== leaseOwner) {
    throw new Error('process owner workerInstanceId must match the lease owner');
  }
  if (
    !Number.isInteger(registration.ownerGeneration)
    || registration.ownerGeneration < 1
    || !Number.isInteger(registration.pid)
    || registration.pid < 1
    || !Number.isInteger(registration.pgid)
    || registration.pgid < 1
  ) {
    throw new Error('process owner generation/PID/PGID must be positive integers');
  }
  if (
    registration.mode === 'PROCESS_GROUP'
    && (
      !registration.pidNamespaceId
      || !Number.isInteger(registration.sid)
      || registration.sid! < 1
      || registration.pid !== registration.pgid
      || registration.pid !== registration.sid
    )
  ) {
    throw new Error(
      'PROCESS_GROUP ownership requires pid=pgid=sid and a PID namespace identity',
    );
  }
}

function exactProcessOwnerFilter(
  owner: AttemptProcessOwnerDoc,
): Record<string, unknown> {
  return {
    'processOwner.processExecutionId': owner.processExecutionId,
    'processOwner.runtimeRunId': owner.runtimeRunId,
    'processOwner.workerInstanceId': owner.workerInstanceId,
    'processOwner.ownerGeneration': owner.ownerGeneration,
    'processOwner.attemptFence': owner.attemptFence,
    'processOwner.mode': owner.mode,
    'processOwner.hostId': owner.hostId,
    'processOwner.hostBootId': owner.hostBootId,
    ...(owner.pidNamespaceId === undefined
      ? {}
      : { 'processOwner.pidNamespaceId': owner.pidNamespaceId }),
    'processOwner.pid': owner.pid,
    'processOwner.pgid': owner.pgid,
    ...(owner.sid === undefined ? {} : { 'processOwner.sid': owner.sid }),
    'processOwner.processStartToken': owner.processStartToken,
    'processOwner.registeredAt': owner.registeredAt,
    'processOwner.startedAt': owner.startedAt,
  };
}

/**
 * Legacy/test planner helper, now fenced through the job document. Touching the
 * job stateVersion in the same transaction makes task admission serialize with
 * stop/terminal reducers; a READY phantom cannot appear after TERMINAL.
 */
export async function createTask(
  client: MongoClient,
  db: Db,
  jobId: string,
  planVersion = 1,
  /**
   * Routing frozen onto the new task. A replan that omits this silently loses
   * the specialist: the retry has no capability, so the worker routes it to the
   * DEFAULT agent — a chef job quietly finished by the researcher. Observed on
   * the capability-routing canary, where the second task carried no capability
   * at all.
   */
  plan: {
    /** Optional task focus; the worker always receives the full job goal too. */
    goal?: string | null;
    capability?: string | null;
    attemptCapMs?: number | null;
    progressiveAttempt?: ProgressiveAttemptPolicy | null;
    durableProgressFingerprints?: string[];
    /** Set by a replan: the failed task this one retries. See `TaskDoc`. */
    supersedesTaskId?: string | null;
  } = {},
): Promise<string> {
  if (
    plan.progressiveAttempt != null
    && (
      !isProgressiveAttemptPolicy(plan.progressiveAttempt)
      || plan.attemptCapMs !== plan.progressiveAttempt.maxCapMs
    )
  ) {
    throw new Error('invalid progressive attempt policy');
  }
  const taskId = newTaskId();
  await runTxn(client, async (session) => {
    const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
    const job = await jobs.findOne(
      {
        _id: jobId,
        terminalOutcome: null,
        controlState: 'NONE',
        planVersion,
      },
      { session },
    );
    if (!job) throw new TaskCreateAuthorityLostError(jobId);
    const now = new Date();
    const authority = await jobs.updateOne(
      {
        _id: jobId,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: 'NONE',
        planVersion,
      },
      {
        $set: { updatedAt: now },
        $inc: { stateVersion: 1 },
      },
      { session },
    );
    if (authority.modifiedCount !== 1) {
      throw new TaskCreateAuthorityLostError(jobId);
    }
    await db.collection<TaskDoc>(COLLECTIONS.tasks).insertOne({
      _id: taskId, jobId, phase: 'READY', controlState: 'NONE', attemptMode: 'SERIAL',
      planVersion, stopGeneration: 0, activeAttemptId: null, createdAt: now, updatedAt: now,
      capability: plan.capability ?? null,
      goal: plan.goal ?? null,
      attemptCapMs: plan.attemptCapMs ?? null,
      progressiveAttempt: plan.progressiveAttempt ?? null,
      durableProgressFingerprints: [...new Set(plan.durableProgressFingerprints ?? [])].slice(-64),
      supersedesTaskId: plan.supersedesTaskId ?? null,
    }, { session });
  });
  return taskId;
}

/** Create a QUEUED attempt for a claimable task. Server-minted id + number. */
export async function dispatchAttempt(
  client: MongoClient, db: Db,
  input: {
    jobId: string;
    taskId: string;
    /** Pins dispatch to the wake authority that selected this lane step. */
    expectedActivationDispatchGeneration?: number;
    attemptCapMs?: number;
    reserveForFinalizeMs?: number;
    resultCommitReserveMs?: number;
  },
): Promise<{ attemptId: string; attemptNumber: number }> {
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const { value } = await runTxn(client, async (session) => {
    const task = await tasks.findOne({
      _id: input.taskId,
      jobId: input.jobId,
      phase: { $in: ['READY', 'RETRY_PENDING'] },
      controlState: 'NONE',
      activeAttemptId: null,
    }, { session });
    if (!task) throw new AttemptDispatchAuthorityLostError(input.taskId);
    const job = await jobs.findOne({
      _id: input.jobId,
      terminalOutcome: null,
      controlState: 'NONE',
      planVersion: task.planVersion,
      ...(input.expectedActivationDispatchGeneration === undefined
        ? {}
        : { activationDispatchGeneration: input.expectedActivationDispatchGeneration }),
    }, { session });
    if (!job) throw new AttemptDispatchAuthorityLostError(input.taskId);
    const last = await attempts.find({ taskId: input.taskId }, { session }).sort({ attemptNumber: -1 }).limit(1).next();
    const attemptNumber = (last?.attemptNumber ?? 0) + 1;
    const attemptId = newAttemptId();
    const now = new Date();
    const attemptCapMs = input.attemptCapMs ?? task.attemptCapMs ?? DEFAULT_ATTEMPT_CAP_MS;
    const progressiveAttempt = task.progressiveAttempt ?? null;
    const reserveForFinalizeMs = input.reserveForFinalizeMs ?? DEFAULT_FINALIZE_RESERVE_MS;
    const resultCommitReserveMs = input.resultCommitReserveMs ?? DEFAULT_RESULT_COMMIT_RESERVE_MS;
    if (
      attemptCapMs <= 0
      || reserveForFinalizeMs < 0
      || resultCommitReserveMs < 0
      || reserveForFinalizeMs + resultCommitReserveMs >= attemptCapMs
    ) {
      throw new Error('invalid attempt deadline reserves');
    }
    if (
      progressiveAttempt
      && (
        !isProgressiveAttemptPolicy(progressiveAttempt)
        || progressiveAttempt.maxCapMs !== attemptCapMs
        || reserveForFinalizeMs + resultCommitReserveMs >= progressiveAttempt.initialWindowMs
      )
    ) {
      throw new Error('invalid frozen progressive attempt policy');
    }
    const absoluteHardDeadlineAt = new Date(now.getTime() + attemptCapMs);
    const absoluteDeadlines = deriveAttemptDeadlines({
      hardDeadlineAt: absoluteHardDeadlineAt.getTime(),
      reserveForFinalizeMs,
      resultCommitReserveMs,
    });
    const earnedCapMs = progressiveAttempt?.initialWindowMs ?? attemptCapMs;
    const hardDeadlineAt = new Date(now.getTime() + earnedCapMs);
    const deadlines = deriveAttemptDeadlines({
      hardDeadlineAt: hardDeadlineAt.getTime(),
      reserveForFinalizeMs,
      resultCommitReserveMs,
    });
    if (deadlines.businessOperationCutoffAt <= now.getTime()) {
      throw new Error('attempt deadline reserves leave no business execution window');
    }
    await attempts.insertOne({
      _id: attemptId, jobId: input.jobId, taskId: input.taskId,
      planVersion: task.planVersion,
      jobStopGenerationAtDispatch: job.jobStopGeneration,
      taskStopGenerationAtDispatch: task.stopGeneration ?? 0,
      pauseGenerationAtDispatch: job.pauseGeneration,
      finishCurrentPauseGeneration: null,
      attemptNumber,
      lifecycle: 'QUEUED', leaseOwner: null, leaseExpiresAt: null, attemptFence: 0,
      stopGeneration: 0,
      primaryAttemptStopCause: null,
      secondaryAttemptStopCauses: [],
      attemptStopGraceDueAt: null,
      attemptStopTimerGeneration: 0,
      jobStopGenerationAtStop: null,
      processOwner: null,
      processState: 'NONE',
      terminationConfirmed: null,
      stopReceipt: null,
      processExitReceipt: null,
      processWorkloadReleasedAt: null,
      processSignalStage: 'NONE',
      processStopObservedAt: null,
      processAbortSentAt: null,
      processTermSentAt: null,
      processKillSentAt: null,
      processTreeEmptyAt: null,
      processReconcileNextAt: null,
      processReconcileProbeAttempt: 0,
      operationStartedAt: null,
      businessOperationCutoffAt: new Date(deadlines.businessOperationCutoffAt),
      workDeadlineAt: new Date(deadlines.workDeadlineAt),
      hardDeadlineAt,
      absoluteBusinessOperationCutoffAt: new Date(absoluteDeadlines.businessOperationCutoffAt),
      absoluteWorkDeadlineAt: new Date(absoluteDeadlines.workDeadlineAt),
      absoluteHardDeadlineAt,
      progressiveAttempt,
      progressExtensionCount: 0,
      progressFingerprints: [],
      lastDurableProgressAt: null,
      lastDurableProgressKind: null,
      businessPayloadReadyGeneration: 0,
      businessPayloadReadyHash: null,
      businessPayloadReadyAt: null,
      businessPayloadReadyPauseGeneration: null,
      leaseOwnerAtCommit: null,
      committedPayloadHash: null,
      ACommittedAt: null,
      outcome: null, resultId: null, reasonCode: null, createdAt: now, updatedAt: now,
    }, { session });
    const taskCas = await tasks.updateOne(
      {
        _id: input.taskId,
        jobId: input.jobId,
        phase: { $in: ['READY', 'RETRY_PENDING'] },
        controlState: 'NONE',
        activeAttemptId: null,
        planVersion: task.planVersion,
        stopGeneration: task.stopGeneration ?? 0,
      },
      {
        $set: {
          phase: 'DISPATCHED',
          businessPayloadReadyAttemptId: null,
          businessPayloadReadyGeneration: 0,
          updatedAt: now,
        },
      },
      { session },
    );
    const jobTouch = await jobs.updateOne(
      {
        _id: job._id,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: 'NONE',
        planVersion: task.planVersion,
        pauseGeneration: job.pauseGeneration,
        jobStopGeneration: job.jobStopGeneration,
        ...(input.expectedActivationDispatchGeneration === undefined
          ? {}
          : { activationDispatchGeneration: input.expectedActivationDispatchGeneration }),
      },
      {
        $set: { updatedAt: now },
        $inc: { stateVersion: 1 },
      },
      { session },
    );
    if (taskCas.modifiedCount !== 1 || jobTouch.modifiedCount !== 1) {
      throw new AttemptDispatchAuthorityLostError(input.taskId);
    }
    return { attemptId, attemptNumber };
  });
  return value;
}

/** Claim a QUEUED attempt: raise the fence and take a LEASED admission. */
export async function claimAttempt(
  client: MongoClient,
  db: Db,
  input: { attemptId: string; workerInstanceId: string; leaseTtlMs?: number },
): Promise<LeaseHandle | null> {
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const ttl = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (ttl <= 0) throw new Error('lease TTL must be positive');

  try {
    const { value } = await runTxn(client, async (session) => {
      const current = await attempts.findOne(
        { _id: input.attemptId },
        { session },
      );
      if (!current) return null;
      if (current.lifecycle !== 'QUEUED') return null;

      const jobFilter: Filter<JobDoc> = {
        _id: current.jobId,
        terminalOutcome: null,
        controlState: 'NONE',
        planVersion: current.planVersion,
        pauseGeneration: current.pauseGenerationAtDispatch,
        jobStopGeneration: current.jobStopGenerationAtDispatch ?? 0,
      };
      const job = await jobs.findOne(jobFilter, { session });
      const task = await tasks.findOne({
        _id: current.taskId,
        jobId: current.jobId,
        phase: 'DISPATCHED',
        controlState: 'NONE',
        planVersion: current.planVersion,
        stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
        activeAttemptId: null,
      }, { session });
      if (!job || !task) return null;

      // No new business work may be claimed at/after its store-time cutoff.
      const claimed = await attempts.findOneAndUpdate(
        {
          _id: current._id,
          lifecycle: 'QUEUED',
          planVersion: current.planVersion,
          pauseGenerationAtDispatch: current.pauseGenerationAtDispatch,
          $expr: { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
        } as unknown as Filter<AttemptDoc>,
        [
          {
            $set: {
              lifecycle: 'LEASED',
              leaseOwner: input.workerInstanceId,
              attemptFence: { $add: ['$attemptFence', 1] },
              // The lease survives through the stop/cleanup reserve; business
              // marker and ordinary A have their own earlier cutoff guards.
              leaseExpiresAt: {
                $min: [
                  { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: ttl } },
                  '$hardDeadlineAt',
                ],
              },
              updatedAt: '$$NOW',
            },
          },
        ],
        { session, returnDocument: 'after' },
      );
      if (!claimed) return null;

      // These writes make claim linearize against pause/cancel/replan and task
      // control instead of merely trusting read-only snapshots.
      const jobTouch = await jobs.updateOne(
        { ...jobFilter, stateVersion: job.stateVersion },
        { $set: { updatedAt: claimed.updatedAt }, $inc: { stateVersion: 1 } },
        { session },
      );
      const taskTouch = await tasks.updateOne(
        {
          _id: task._id,
          jobId: current.jobId,
          phase: 'DISPATCHED',
          controlState: 'NONE',
          planVersion: current.planVersion,
          stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
          activeAttemptId: null,
        },
        { $set: { activeAttemptId: claimed._id, updatedAt: claimed.updatedAt } },
        { session },
      );
      if (jobTouch.modifiedCount !== 1 || taskTouch.modifiedCount !== 1) {
        throw new AttemptClaimAuthorityLostError();
      }

      return {
        attemptId: claimed._id,
        attemptFence: claimed.attemptFence,
        leaseOwner: claimed.leaseOwner!,
        leaseExpiresAt: claimed.leaseExpiresAt!,
      } satisfies LeaseHandle;
    });
    return value;
  } catch (err) {
    if (err instanceof AttemptClaimAuthorityLostError) return null;
    throw err;
  }
}

/**
 * Start business work: LEASED→RUNNING under the same job/task/cutoff CAS used
 * by pause/cancel/replan. If pause wins first, no provider work may begin.
 */
export async function startAttemptOperation(
  client: MongoClient,
  db: Db,
  input: {
    attemptId: string;
    leaseOwner: string;
    attemptFence: number;
    processOwner?: AttemptProcessOwnerRegistration;
  },
): Promise<boolean> {
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  if (input.processOwner) {
    validateProcessOwnerRegistration(input.processOwner, input.leaseOwner);
  }

  try {
    const { value } = await runTxn(client, async (session) => {
      const current = await attempts.findOne({
        _id: input.attemptId,
        lifecycle: 'LEASED',
        leaseOwner: input.leaseOwner,
        attemptFence: input.attemptFence,
      }, { session });
      if (!current) return false;

      const jobFilter: Filter<JobDoc> = {
        _id: current.jobId,
        terminalOutcome: null,
        controlState: 'NONE',
        planVersion: current.planVersion,
        pauseGeneration: current.pauseGenerationAtDispatch,
        jobStopGeneration: current.jobStopGenerationAtDispatch ?? 0,
      };
      const job = await jobs.findOne(jobFilter, { session });
      const task = await tasks.findOne({
        _id: current.taskId,
        jobId: current.jobId,
        phase: 'DISPATCHED',
        controlState: 'NONE',
        planVersion: current.planVersion,
        stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
        activeAttemptId: current._id,
      }, { session });
      if (!job || !task) return false;

      const started = await attempts.findOneAndUpdate(
        {
          _id: current._id,
          lifecycle: 'LEASED',
          leaseOwner: input.leaseOwner,
          attemptFence: input.attemptFence,
          planVersion: current.planVersion,
          pauseGenerationAtDispatch: current.pauseGenerationAtDispatch,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<AttemptDoc>,
        [{
          $set: {
            lifecycle: 'RUNNING',
            operationStartedAt: '$$NOW',
            processOwner: input.processOwner
              ? {
                  ...input.processOwner,
                  attemptFence: input.attemptFence,
                  registeredAt: '$$NOW',
                  startedAt: '$$NOW',
                }
              : null,
            processState: input.processOwner ? 'OWNED' : 'UNKNOWN',
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!started) return false;

      const jobTouch = await jobs.updateOne(
        { ...jobFilter, stateVersion: job.stateVersion },
        {
          $set: { updatedAt: started.operationStartedAt! },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      const taskTouch = await tasks.updateOne(
        {
          _id: task._id,
          jobId: current.jobId,
          phase: 'DISPATCHED',
          controlState: 'NONE',
          planVersion: current.planVersion,
          stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
          activeAttemptId: current._id,
        },
        { $set: { updatedAt: started.operationStartedAt! } },
        { session },
      );
      if (jobTouch.modifiedCount !== 1 || taskTouch.matchedCount !== 1) {
        throw new AttemptOperationAuthorityLostError();
      }
      return true;
    });
    return value;
  } catch (err) {
    if (err instanceof AttemptOperationAuthorityLostError) return false;
    throw err;
  }
}

export interface AttemptProcessReleaseResult {
  attemptId: string;
  releasedAt: Date;
  released: boolean;
  deduped: boolean;
}

/**
 * Second half of the PROCESS_GROUP launch handshake. The OS wrapper is inert
 * until this CAS wins against pause/cancel/replan on the same job/task/attempt
 * authority. Only then may the supervisor send its START message.
 */
export async function authorizeAttemptProcessRelease(
  client: MongoClient,
  db: Db,
  input: {
    attemptId: string;
    leaseOwner: string;
    attemptFence: number;
    processOwner: AttemptProcessOwnerDoc;
  },
): Promise<AttemptProcessReleaseResult | null> {
  if (
    input.processOwner.mode !== 'PROCESS_GROUP'
    || input.processOwner.workerInstanceId !== input.leaseOwner
    || input.processOwner.attemptFence !== input.attemptFence
  ) return null;

  try {
    const { value } = await runTxn(client, async (session) => {
      const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
      const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
      const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
      const current = await attempts.findOne(
        {
          _id: input.attemptId,
          lifecycle: 'RUNNING',
          leaseOwner: input.leaseOwner,
          attemptFence: input.attemptFence,
          stopGeneration: 0,
          ...exactProcessOwnerFilter(input.processOwner),
        } as unknown as Filter<AttemptDoc>,
        { session },
      );
      if (!current) return null;
      if (current.processWorkloadReleasedAt) {
        return {
          attemptId: current._id,
          releasedAt: current.processWorkloadReleasedAt,
          released: false,
          deduped: true,
        } satisfies AttemptProcessReleaseResult;
      }

      const jobFilter: Filter<JobDoc> = {
        _id: current.jobId,
        terminalOutcome: null,
        controlState: 'NONE',
        planVersion: current.planVersion,
        pauseGeneration: current.pauseGenerationAtDispatch,
        jobStopGeneration: current.jobStopGenerationAtDispatch ?? 0,
      };
      const job = await jobs.findOne(jobFilter, { session });
      const task = await tasks.findOne(
        {
          _id: current.taskId,
          jobId: current.jobId,
          phase: 'DISPATCHED',
          controlState: 'NONE',
          planVersion: current.planVersion,
          stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
          activeAttemptId: current._id,
        },
        { session },
      );
      if (!job || !task) return null;

      const released = await attempts.findOneAndUpdate(
        {
          _id: current._id,
          lifecycle: 'RUNNING',
          leaseOwner: input.leaseOwner,
          attemptFence: input.attemptFence,
          stopGeneration: 0,
          processWorkloadReleasedAt: null,
          ...exactProcessOwnerFilter(input.processOwner),
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<AttemptDoc>,
        [{
          $set: {
            processWorkloadReleasedAt: '$$NOW',
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!released?.processWorkloadReleasedAt) return null;

      const jobTouch = await jobs.updateOne(
        { ...jobFilter, stateVersion: job.stateVersion },
        {
          $set: { updatedAt: released.processWorkloadReleasedAt },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      const taskTouch = await tasks.updateOne(
        {
          _id: task._id,
          jobId: current.jobId,
          phase: 'DISPATCHED',
          controlState: 'NONE',
          planVersion: current.planVersion,
          stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
          activeAttemptId: current._id,
        },
        { $set: { updatedAt: released.processWorkloadReleasedAt } },
        { session },
      );
      if (jobTouch.modifiedCount !== 1 || taskTouch.matchedCount !== 1) {
        throw new AttemptProcessReleaseAuthorityLostError();
      }
      return {
        attemptId: current._id,
        releasedAt: released.processWorkloadReleasedAt,
        released: true,
        deduped: false,
      } satisfies AttemptProcessReleaseResult;
    });
    return value;
  } catch (error) {
    if (error instanceof AttemptProcessReleaseAuthorityLostError) return null;
    throw error;
  }
}

/** Heartbeat: extend a LEASED/RUNNING lease iff owner+fence still match. */
export async function renewLease(
  db: Db,
  input: { attemptId: string; leaseOwner: string; attemptFence: number; leaseTtlMs?: number },
): Promise<boolean> {
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const ttl = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (ttl <= 0) throw new Error('lease TTL must be positive');
  const filter = {
    _id: input.attemptId,
    lifecycle: { $in: ['LEASED', 'RUNNING'] },
    leaseOwner: input.leaseOwner,
    attemptFence: input.attemptFence,
    $expr: { $and: [{ $gt: ['$leaseExpiresAt', '$$NOW'] }, { $gt: ['$hardDeadlineAt', '$$NOW'] }] },
  } as unknown as Filter<AttemptDoc>;
  const res = await attempts.updateOne(filter, [
    {
      $set: {
        leaseExpiresAt: {
          $min: [
            { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: ttl } },
            '$hardDeadlineAt',
          ],
        },
        updatedAt: '$$NOW',
      },
    },
  ]);
  return res.modifiedCount === 1;
}

class AttemptProgressAuthorityLostError extends Error {
  constructor() {
    super('attempt progress authority changed during the transaction');
    this.name = 'AttemptProgressAuthorityLostError';
  }
}

function progressDecision(
  attempt: AttemptDoc | null,
  accepted: boolean,
  reason?: AttemptProgressDecision['reason'],
): AttemptProgressDecision {
  const hardDeadlineAt = attempt?.hardDeadlineAt?.getTime() ?? 0;
  return {
    accepted,
    businessOperationCutoffAt: attempt?.businessOperationCutoffAt?.getTime() ?? 0,
    workDeadlineAt: attempt?.workDeadlineAt?.getTime() ?? 0,
    hardDeadlineAt,
    absoluteHardDeadlineAt: attempt?.absoluteHardDeadlineAt?.getTime() ?? hardDeadlineAt,
    extensionCount: attempt?.progressExtensionCount ?? 0,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Persist one earned Writer extension under the same owner/fence and job/task
 * authority as result ingress.
 *
 * The deadline is never resurrected: eligibility and the date movement happen
 * in one store-time conditional write. Fingerprints live on the attempt and
 * task, so a process restart, attempt retry or replan replay cannot earn time
 * twice for the same document state.
 */
export async function recordAttemptProgressAndExtend(
  client: MongoClient,
  db: Db,
  input: {
    attemptId: string;
    leaseOwner: string;
    attemptFence: number;
    leaseTtlMs?: number;
    milestone: AttemptProgressMilestone;
  },
): Promise<AttemptProgressDecision> {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new TypeError('progress lease TTL must be a positive integer');
  }
  const fingerprint = input.milestone.fingerprint.trim();
  const kind = input.milestone.kind.trim();
  if (
    fingerprint.length === 0
    || fingerprint.length > 256
    || kind.length === 0
    || kind.length > 128
  ) {
    throw new TypeError('progress milestone identity is invalid');
  }

  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

  try {
    const { value } = await runTxn(client, async (session) => {
      const current = await attempts.findOne({
        _id: input.attemptId,
        lifecycle: 'RUNNING',
        leaseOwner: input.leaseOwner,
        attemptFence: input.attemptFence,
        stopGeneration: 0,
        businessPayloadReadyGeneration: 0,
        $expr: {
          $and: [
            { $gt: ['$leaseExpiresAt', '$$NOW'] },
            { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
            { $gt: ['$hardDeadlineAt', '$$NOW'] },
          ],
        },
      } as unknown as Filter<AttemptDoc>, { session });
      if (!current) return progressDecision(null, false, 'stale_authority_or_cutoff');

      const policy = current.progressiveAttempt;
      const absoluteHardDeadlineAt = current.absoluteHardDeadlineAt;
      if (!policy || !absoluteHardDeadlineAt || !isProgressiveAttemptPolicy(policy)) {
        return progressDecision(current, false, 'disabled');
      }

      const jobAuthorityFilter: Filter<JobDoc> = {
        _id: current.jobId,
        terminalOutcome: null,
        planVersion: current.planVersion,
        jobStopGeneration: current.jobStopGenerationAtDispatch ?? 0,
      };
      const job = await jobs.findOne(jobAuthorityFilter, { session });
      const task = await tasks.findOne({
        _id: current.taskId,
        jobId: current.jobId,
        phase: 'DISPATCHED',
        planVersion: current.planVersion,
        stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
        activeAttemptId: current._id,
      }, { session });
      if (!job || !task) {
        return progressDecision(current, false, 'stale_authority_or_cutoff');
      }
      // A finish-current pause keeps the already-running attempt valid, but it
      // deliberately freezes further earned time. Treating this as lost
      // authority would make an otherwise harmless snapshot abort the worker.
      if (
        job.controlState === 'PAUSE_REQUESTED'
        && current.finishCurrentPauseGeneration === job.pauseGeneration
      ) {
        return progressDecision(current, false, 'control_frozen');
      }
      if (
        job.controlState !== 'NONE'
        || task.controlState !== 'NONE'
        || job.pauseGeneration !== current.pauseGenerationAtDispatch
      ) {
        return progressDecision(current, false, 'stale_authority_or_cutoff');
      }
      const jobFilter: Filter<JobDoc> = {
        ...jobAuthorityFilter,
        controlState: 'NONE',
        pauseGeneration: current.pauseGenerationAtDispatch,
      };

      // Dedupe happens only after live owner/fence/control/cutoff authority was
      // proven with store time. The duplicate response is then an idempotent
      // receipt carrying the already-earned deadlines, not a soft response from
      // an expired or stolen worker.
      const fingerprints = current.progressFingerprints ?? [];
      if (
        fingerprints.includes(fingerprint)
        || (task.durableProgressFingerprints ?? []).includes(fingerprint)
      ) {
        return progressDecision(current, false, 'duplicate');
      }
      const extensionCount = current.progressExtensionCount ?? 0;
      if (extensionCount >= policy.maxExtensions) {
        return progressDecision(current, false, 'extension_limit');
      }
      if (current.hardDeadlineAt.getTime() >= absoluteHardDeadlineAt.getTime()) {
        return progressDecision(current, false, 'absolute_cap');
      }

      const nextHard = {
        $min: [
          '$absoluteHardDeadlineAt',
          {
            $dateAdd: {
              startDate: '$hardDeadlineAt',
              unit: 'millisecond',
              amount: policy.extensionMs,
            },
          },
        ],
      };
      const deltaMs = { $subtract: [nextHard, '$hardDeadlineAt'] };
      const extended = await attempts.findOneAndUpdate(
        {
          _id: current._id,
          lifecycle: 'RUNNING',
          leaseOwner: input.leaseOwner,
          attemptFence: input.attemptFence,
          stopGeneration: 0,
          businessPayloadReadyGeneration: 0,
          progressExtensionCount: extensionCount,
          progressFingerprints: { $ne: fingerprint },
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
              { $lt: ['$hardDeadlineAt', '$absoluteHardDeadlineAt'] },
              {
                $lte: [
                  { $subtract: ['$businessOperationCutoffAt', '$$NOW'] },
                  policy.extensionLeadMs,
                ],
              },
            ],
          },
        } as unknown as Filter<AttemptDoc>,
        [{
          $set: {
            businessOperationCutoffAt: {
              $dateAdd: {
                startDate: '$businessOperationCutoffAt',
                unit: 'millisecond',
                amount: deltaMs,
              },
            },
            workDeadlineAt: {
              $dateAdd: {
                startDate: '$workDeadlineAt',
                unit: 'millisecond',
                amount: deltaMs,
              },
            },
            hardDeadlineAt: nextHard,
            // If the former hard cap had clipped the heartbeat lease, extend
            // it just far enough for the ordinary heartbeat loop to take over.
            // Never replace leasing with a multi-minute progress grant.
            leaseExpiresAt: {
              $max: [
                '$leaseExpiresAt',
                {
                  $min: [
                    nextHard,
                    {
                      $dateAdd: {
                        startDate: '$$NOW',
                        unit: 'millisecond',
                        amount: leaseTtlMs,
                      },
                    },
                  ],
                },
              ],
            },
            progressExtensionCount: { $add: ['$progressExtensionCount', 1] },
            progressFingerprints: { $concatArrays: ['$progressFingerprints', [fingerprint]] },
            lastDurableProgressAt: '$$NOW',
            lastDurableProgressKind: kind,
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!extended) {
        // The common non-authority miss is an early milestone. We deliberately
        // do not bank its fingerprint or time. Because the Writer snapshot tool
        // compares with its previous DB version, earning later requires another
        // substantive content change rather than replaying this early snapshot.
        const stillCurrent = await attempts.findOne({
          _id: current._id,
          lifecycle: 'RUNNING',
          leaseOwner: input.leaseOwner,
          attemptFence: input.attemptFence,
          stopGeneration: 0,
          businessPayloadReadyGeneration: 0,
          progressExtensionCount: extensionCount,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
              {
                $gt: [
                  { $subtract: ['$businessOperationCutoffAt', '$$NOW'] },
                  policy.extensionLeadMs,
                ],
              },
            ],
          },
        } as unknown as Filter<AttemptDoc>, { session });
        return progressDecision(
          stillCurrent ?? current,
          false,
          stillCurrent ? 'too_early' : 'stale_authority_or_cutoff',
        );
      }

      const jobTouch = await jobs.updateOne(
        { ...jobFilter, stateVersion: job.stateVersion },
        { $set: { updatedAt: extended.lastDurableProgressAt! }, $inc: { stateVersion: 1 } },
        { session },
      );
      const taskTouch = await tasks.updateOne(
        {
          _id: task._id,
          jobId: current.jobId,
          phase: 'DISPATCHED',
          controlState: 'NONE',
          planVersion: current.planVersion,
          stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
          activeAttemptId: current._id,
        },
        {
          $set: { updatedAt: extended.lastDurableProgressAt! },
          $addToSet: { durableProgressFingerprints: fingerprint },
        },
        { session },
      );
      if (jobTouch.modifiedCount !== 1 || taskTouch.modifiedCount !== 1) {
        throw new AttemptProgressAuthorityLostError();
      }
      return progressDecision(extended, true);
    });
    return value;
  } catch (error) {
    if (error instanceof AttemptProgressAuthorityLostError) {
      return progressDecision(null, false, 'stale_authority_or_cutoff');
    }
    throw error;
  }
}

export type PayloadReadyRejectReason =
  | 'stale_fence_or_lease_or_cutoff'
  | 'stale_plan_or_control'
  | 'payload_hash_conflict';

export interface MarkPayloadReadyResult {
  /** Stop/control outcomes and invalid envelopes do not use the business marker. */
  required: boolean;
  ready: boolean;
  marked: boolean;
  deduped: boolean;
  payloadHash: string;
  generation: number;
  reason?: PayloadReadyRejectReason;
}

class PayloadReadyAuthorityLostError extends Error {
  constructor() {
    super('payload-ready authority changed during the marker transaction');
    this.name = 'PayloadReadyAuthorityLostError';
  }
}

class ResultCommitAuthorityLostError extends Error {
  constructor() {
    super('result-commit authority changed during A');
    this.name = 'ResultCommitAuthorityLostError';
  }
}

/**
 * Flat-SERIAL slice of ORC-RESULT-READY-01.
 *
 * Before ordinary A may publish an OK/PARTIAL/BLOCKED/FAILED candidate, the
 * worker must freeze its normalized payload hash under the current lease/fence,
 * plan and job control state. The marker's time guard is part of the conditional
 * write (`businessOperationCutoffAt > $$NOW`), not a process-clock pre-check.
 *
 * The transaction also touches the current task and job stateVersion. Therefore
 * pause/cancel/control and this marker cannot both commit from stale snapshots:
 * one retries and re-validates authority. Full activation/ancestor/task-due
 * authority remains a later contract slice.
 */
export async function markAttemptPayloadReady(
  client: MongoClient,
  db: Db,
  input: { attemptId: string; leaseOwner: string; attemptFence: number; producer: unknown },
): Promise<MarkPayloadReadyResult> {
  const prepared = prepareCandidate(input.producer);
  if (!prepared.requiresPayloadReady) {
    return {
      required: false,
      ready: true,
      marked: false,
      deduped: false,
      payloadHash: prepared.payloadHash,
      generation: 0,
    };
  }

  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

  try {
    const { value } = await runTxn(client, async (session) => {
      const current = await attempts.findOne(
        { _id: input.attemptId, attemptFence: input.attemptFence },
        { session },
      );
      if (!current) {
        return {
          required: true,
          ready: false,
          marked: false,
          deduped: false,
          payloadHash: prepared.payloadHash,
          generation: 0,
          reason: 'stale_fence_or_lease_or_cutoff',
        } satisfies MarkPayloadReadyResult;
      }

      // A replay may resolve an ambiguous marker commit, but never for a caller
      // that did not own this exact running lease/fence.
      if (
        current.lifecycle !== 'RUNNING'
        || current.leaseOwner !== input.leaseOwner
      ) {
        return {
          required: true,
          ready: false,
          marked: false,
          deduped: false,
          payloadHash: prepared.payloadHash,
          generation: current.businessPayloadReadyGeneration,
          reason: 'stale_fence_or_lease_or_cutoff',
        } satisfies MarkPayloadReadyResult;
      }

      if (current.businessPayloadReadyGeneration > 0) {
        if (current.businessPayloadReadyHash !== prepared.payloadHash) {
          return {
            required: true,
            ready: false,
            marked: false,
            deduped: false,
            payloadHash: prepared.payloadHash,
            generation: current.businessPayloadReadyGeneration,
            reason: 'payload_hash_conflict',
          } satisfies MarkPayloadReadyResult;
        }
        return {
          required: true,
          ready: true,
          marked: false,
          deduped: true,
          payloadHash: prepared.payloadHash,
          generation: current.businessPayloadReadyGeneration,
        } satisfies MarkPayloadReadyResult;
      }

      const jobFilter: Filter<JobDoc> = {
        _id: current.jobId,
        terminalOutcome: null,
        controlState: 'NONE',
        planVersion: current.planVersion,
        pauseGeneration: current.pauseGenerationAtDispatch,
        jobStopGeneration: current.jobStopGenerationAtDispatch ?? 0,
      };
      const job = await jobs.findOne(jobFilter, { session });
      const task = await tasks.findOne({
        _id: current.taskId,
        jobId: current.jobId,
        planVersion: current.planVersion,
        phase: 'DISPATCHED',
        controlState: 'NONE',
        stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
        activeAttemptId: current._id,
      }, { session });
      if (!job || !task) {
        return {
          required: true,
          ready: false,
          marked: false,
          deduped: false,
          payloadHash: prepared.payloadHash,
          generation: 0,
          reason: 'stale_plan_or_control',
        } satisfies MarkPayloadReadyResult;
      }

      const marked = await attempts.findOneAndUpdate(
        {
          _id: current._id,
          lifecycle: 'RUNNING',
          leaseOwner: input.leaseOwner,
          attemptFence: input.attemptFence,
          businessPayloadReadyGeneration: 0,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<AttemptDoc>,
        [
          {
            $set: {
              businessPayloadReadyGeneration: 1,
              businessPayloadReadyHash: prepared.payloadHash,
              businessPayloadReadyAt: '$$NOW',
              businessPayloadReadyPauseGeneration: job.pauseGeneration,
              updatedAt: '$$NOW',
            },
          },
        ],
        { session, returnDocument: 'after' },
      );
      if (!marked) {
        return {
          required: true,
          ready: false,
          marked: false,
          deduped: false,
          payloadHash: prepared.payloadHash,
          generation: 0,
          reason: 'stale_fence_or_lease_or_cutoff',
        } satisfies MarkPayloadReadyResult;
      }

      const taskTouch = await tasks.updateOne(
        {
          _id: task._id, jobId: current.jobId, planVersion: current.planVersion,
          phase: 'DISPATCHED', controlState: 'NONE',
          stopGeneration: current.taskStopGenerationAtDispatch ?? 0,
          activeAttemptId: current._id,
        },
        {
          $set: {
            businessPayloadReadyAttemptId: current._id,
            businessPayloadReadyGeneration: 1,
            updatedAt: marked.businessPayloadReadyAt!,
          },
        },
        { session },
      );
      const jobTouch = await jobs.updateOne(
        { ...jobFilter, stateVersion: job.stateVersion },
        {
          $set: { updatedAt: marked.businessPayloadReadyAt! },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      if (taskTouch.modifiedCount !== 1 || jobTouch.modifiedCount !== 1) {
        throw new PayloadReadyAuthorityLostError();
      }

      return {
        required: true,
        ready: true,
        marked: true,
        deduped: false,
        payloadHash: prepared.payloadHash,
        generation: 1,
      } satisfies MarkPayloadReadyResult;
    });
    return value;
  } catch (err) {
    if (err instanceof PayloadReadyAuthorityLostError) {
      return {
        required: true,
        ready: false,
        marked: false,
        deduped: false,
        payloadHash: prepared.payloadHash,
        generation: 0,
        reason: 'stale_plan_or_control',
      };
    }
    throw err;
  }
}

export interface SubmitResult {
  committed: boolean;
  outcome?: string;
  deduped?: boolean;
  reason?:
    | 'stale_fence_or_lease'
    | 'invalid_result'
    | 'payload_not_ready'
    | 'payload_hash_mismatch'
    | 'stale_plan_or_control'
    | 'work_deadline_or_authority';
}

function matchesCommittedProcessExitProof(
  attempt: AttemptDoc,
  proof: AttemptProcessExitProofInput,
  receiptId: string,
): boolean {
  const receipt = attempt.processExitReceipt;
  if (
    !receipt
    || !sameAttemptProcessOwner(attempt.processOwner, proof.processOwner)
    || !sameExitReceiptAuthority(
      receipt,
      proof.processOwner,
      proof.processOwner.attemptFence,
    )
    || attempt.processState !== 'EXITED'
    || attempt.terminationConfirmed !== true
    || attempt.processSignalStage !== 'TREE_EMPTY'
    || !(attempt.processTreeEmptyAt instanceof Date)
  ) return false;
  if (receipt.receiptId !== receiptId) {
    throw new AttemptProcessExitReceiptConflictError(attempt._id);
  }
  return true;
}

/**
 * A boundary: finalize the attempt and publish its result under the current
 * fence, current plan and work deadline. Business candidates additionally need
 * the exact immutable payload-ready hash frozen before the business cutoff.
 *
 * A valid `ok`/`partial` finishes the attempt. Legacy-fused tasks advance in A;
 * RESULT_DRAIN_V1 instead moves to AWAITING_RESULT and atomically publishes the
 * immutable inbox/high-watermark handoff for B. An invalid producer envelope
 * finishes FAILED(invalid_result) — never a false OK. A stale fence/plan/control
 * version, changed payload or late A commits nothing. When an exact normal-exit
 * proof is supplied, its receipt and process-exited outbox fact join A; otherwise
 * process exit remains independently recordable after the business result.
 */
export async function submitAttemptResult(
  client: MongoClient, db: Db,
  input: {
    attemptId: string;
    leaseOwner: string;
    attemptFence: number;
    producer: unknown;
    businessPayloadReadyGeneration?: number;
    processExitProof?: AttemptProcessExitProofInput;
  },
): Promise<SubmitResult> {
  const prepared = prepareCandidate(input.producer);
  const processExitReceipt = input.processExitProof
    ? buildAttemptProcessExitReceipt(input.processExitProof, input.attemptFence)
    : null;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

  try {
    const { value } = await runTxn(client, async (session) => {
      // Resolve an ambiguous/replayed A by its one-result-per-attempt identity.
      const existing = await results.findOne({ attemptId: input.attemptId }, { session });
      if (existing) {
        if (
          existing.attemptFence !== input.attemptFence
          || existing.leaseOwnerAtCommit !== input.leaseOwner
        ) {
          return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
        }
        if (existing.payloadHash !== prepared.payloadHash) {
          return { committed: false, reason: 'payload_hash_mismatch' } satisfies SubmitResult;
        }
        const existingUsesPayloadReady = existing.businessPayloadReadyGeneration > 0;
        if (
          existingUsesPayloadReady
          && input.businessPayloadReadyGeneration !== existing.businessPayloadReadyGeneration
        ) {
          return { committed: false, reason: 'payload_not_ready' } satisfies SubmitResult;
        }
        if (
          existingUsesPayloadReady
          && (
            existing.businessPayloadReadyHash === null
            || existing.businessPayloadReadyHash !== existing.payloadHash
          )
        ) {
          return { committed: false, reason: 'payload_hash_mismatch' } satisfies SubmitResult;
        }
        if (prepared.requiresPayloadReady && !existingUsesPayloadReady) {
          return { committed: false, reason: 'payload_not_ready' } satisfies SubmitResult;
        }
        if (input.processExitProof && processExitReceipt) {
          const committedAttempt = await attempts.findOne(
            { _id: input.attemptId, attemptFence: input.attemptFence },
            { session },
          );
          if (
            !committedAttempt
            || !matchesCommittedProcessExitProof(
              committedAttempt,
              input.processExitProof,
              processExitReceipt.receiptId,
            )
          ) {
            return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
          }
        }
        const status = existing.status as ProducerStatus;
        return {
          committed: true,
          outcome: STATUS_TO_OUTCOME[status]?.attemptOutcome ?? 'UNKNOWN_OUTCOME',
          deduped: true,
        } satisfies SubmitResult;
      }

      const attempt = await attempts.findOne({ _id: input.attemptId }, { session });
      if (!attempt || attempt.attemptFence !== input.attemptFence) {
        return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
      }
      if (attempt.lifecycle === 'FINISHED') {
        if (attempt.leaseOwnerAtCommit !== input.leaseOwner) {
          return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
        }
        if (attempt.committedPayloadHash !== prepared.payloadHash) {
          return { committed: false, reason: 'payload_hash_mismatch' } satisfies SubmitResult;
        }
        if (
          input.processExitProof
          && processExitReceipt
          && !matchesCommittedProcessExitProof(
            attempt,
            input.processExitProof,
            processExitReceipt.receiptId,
          )
        ) {
          return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
        }
        if (attempt.reasonCode === 'invalid_result' && attempt.outcome === 'FAILED') {
          return {
            committed: true,
            outcome: 'FAILED',
            reason: 'invalid_result',
            deduped: true,
          } satisfies SubmitResult;
        }
        return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
      }
      if (attempt.lifecycle !== 'RUNNING' || attempt.leaseOwner !== input.leaseOwner) {
        return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
      }
      let preRecordedProcessExitReceipt: AttemptProcessExitReceiptDoc | null = null;
      if (input.processExitProof && processExitReceipt) {
        if (
          !sameAttemptProcessOwner(attempt.processOwner, input.processExitProof.processOwner)
          || attempt.stopReceipt != null
        ) {
          return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
        }
        const existingReceipt = attempt.processExitReceipt;
        if (existingReceipt) {
          if (
            !sameExitReceiptAuthority(
              existingReceipt,
              input.processExitProof.processOwner,
              input.attemptFence,
            )
          ) {
            return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
          }
          if (existingReceipt.receiptId !== processExitReceipt.receiptId) {
            throw new AttemptProcessExitReceiptConflictError(attempt._id);
          }
          if (
            existingReceipt.receiptHash !== processExitReceipt.receiptHash
            || attempt.processState !== 'EXITED'
            || attempt.terminationConfirmed !== true
            || attempt.processSignalStage !== 'TREE_EMPTY'
            || !(attempt.processTreeEmptyAt instanceof Date)
            || !(existingReceipt.treeEmptyAt instanceof Date)
            || attempt.processTreeEmptyAt.getTime() !== existingReceipt.treeEmptyAt.getTime()
          ) {
            return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
          }
          preRecordedProcessExitReceipt = existingReceipt;
        } else if (
          attempt.processState !== 'OWNED'
          || attempt.terminationConfirmed === true
        ) {
          return { committed: false, reason: 'stale_fence_or_lease' } satisfies SubmitResult;
        }
      }

      const usesPayloadReady = attempt.businessPayloadReadyGeneration > 0;
      if (prepared.requiresPayloadReady) {
        if (
          !usesPayloadReady
          || attempt.businessPayloadReadyHash === null
          || attempt.businessPayloadReadyPauseGeneration === null
          || input.businessPayloadReadyGeneration !== attempt.businessPayloadReadyGeneration
        ) {
          return { committed: false, reason: 'payload_not_ready' } satisfies SubmitResult;
        }
      }
      if (
        usesPayloadReady
        && (
          attempt.businessPayloadReadyHash === null
          || attempt.businessPayloadReadyPauseGeneration === null
          || input.businessPayloadReadyGeneration !== attempt.businessPayloadReadyGeneration
        )
      ) {
        return { committed: false, reason: 'payload_not_ready' } satisfies SubmitResult;
      }
      if (usesPayloadReady) {
        if (attempt.businessPayloadReadyHash !== prepared.payloadHash) {
          return { committed: false, reason: 'payload_hash_mismatch' } satisfies SubmitResult;
        }
      }

      const baseJobFilter: Filter<JobDoc> = {
        _id: attempt.jobId,
        terminalOutcome: null,
        planVersion: attempt.planVersion,
        jobStopGeneration: attempt.jobStopGenerationAtDispatch ?? 0,
      };
      let jobFilter: Filter<JobDoc>;
      if (usesPayloadReady) {
        const jobAuthority: Filter<JobDoc>[] = [{
          controlState: 'NONE',
          pauseGeneration: attempt.businessPayloadReadyPauseGeneration!,
        }];
        if (attempt.finishCurrentPauseGeneration !== null) {
          jobAuthority.push({
            controlState: 'PAUSE_REQUESTED',
            pauseGeneration: attempt.finishCurrentPauseGeneration,
          });
        }
        jobFilter = { ...baseJobFilter, $or: jobAuthority };
      } else {
        const jobAuthority: Filter<JobDoc>[] = [{
          controlState: 'NONE',
          pauseGeneration: attempt.pauseGenerationAtDispatch,
        }];
        if (attempt.finishCurrentPauseGeneration !== null) {
          jobAuthority.push({
            controlState: 'PAUSE_REQUESTED',
            pauseGeneration: attempt.finishCurrentPauseGeneration,
          });
        }
        jobFilter = { ...baseJobFilter, $or: jobAuthority };
      }
      const job = await jobs.findOne(jobFilter, { session });
      const task = await tasks.findOne({
        _id: attempt.taskId,
        jobId: attempt.jobId,
        planVersion: attempt.planVersion,
        phase: 'DISPATCHED',
        controlState: 'NONE',
        stopGeneration: attempt.taskStopGenerationAtDispatch ?? 0,
        activeAttemptId: attempt._id,
        ...(usesPayloadReady
          ? {
              businessPayloadReadyAttemptId: attempt._id,
              businessPayloadReadyGeneration: attempt.businessPayloadReadyGeneration,
            }
          : {}),
      }, { session });
      if (!job || !task) {
        return { committed: false, reason: 'stale_plan_or_control' } satisfies SubmitResult;
      }

      const producer = prepared.validation.ok
        ? prepared.validation.value as ProducerResult
        : null;
      const attemptOutcome: AttemptOutcome = producer
        ? STATUS_TO_OUTCOME[producer.status].attemptOutcome
        : 'FAILED';
      const taskPhase: TaskPhase = producer
        ? (producer.status === 'blocked'
            ? BLOCKED_WAIT[producer.blocked.kind].taskPhase
            : STATUS_TO_OUTCOME[producer.status].taskPhase)
        : 'FAILED';
      const resultId = producer ? newResultId() : null;
      const resultDrainStatus =
        producer?.status === 'ok'
        || producer?.status === 'partial'
        || producer?.status === 'failed';
      const useResultDrainV1 =
        task.resultApplyMode === 'RESULT_DRAIN_V1'
        && resultDrainStatus
        && await tasks.findOne(
          { jobId: attempt.jobId, _id: { $ne: task._id } },
          { session, projection: { _id: 1 } },
        ) === null
        && await db.collection<DispatchEdgeDoc>(COLLECTIONS.edges).findOne(
          { jobId: attempt.jobId },
          { session, projection: { _id: 1 } },
        ) === null;

      // Store-time work deadline + lease are part of the finishing write.
      const finished = await attempts.findOneAndUpdate(
        {
          _id: attempt._id,
          lifecycle: 'RUNNING',
          leaseOwner: input.leaseOwner,
          attemptFence: input.attemptFence,
          ...(usesPayloadReady
            ? {
                businessPayloadReadyGeneration: attempt.businessPayloadReadyGeneration,
                businessPayloadReadyHash: prepared.payloadHash,
              }
            : {}),
          ...(input.processExitProof
            ? preRecordedProcessExitReceipt
              ? {
                  stopGeneration: 0,
                  processState: 'EXITED',
                  terminationConfirmed: true,
                  stopReceipt: null,
                  processSignalStage: 'TREE_EMPTY',
                  processTreeEmptyAt: preRecordedProcessExitReceipt.treeEmptyAt,
                  processExitReceipt: preRecordedProcessExitReceipt,
                  ...exactProcessOwnerFilter(input.processExitProof.processOwner),
                }
              : {
                stopGeneration: 0,
                processState: 'OWNED',
                stopReceipt: null,
                processExitReceipt: null,
                terminationConfirmed: { $ne: true },
                ...exactProcessOwnerFilter(input.processExitProof.processOwner),
              }
            : {}),
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$workDeadlineAt', '$$NOW'] },
              ...(usesPayloadReady
                ? [{ $lt: ['$businessPayloadReadyAt', '$businessOperationCutoffAt'] }]
                : []),
            ],
          },
        } as unknown as Filter<AttemptDoc>,
        [
          {
            $set: {
              lifecycle: 'FINISHED',
              outcome: attemptOutcome,
              resultId,
              reasonCode: producer ? null : 'invalid_result',
              leaseOwnerAtCommit: input.leaseOwner,
              committedPayloadHash: prepared.payloadHash,
              ACommittedAt: '$$NOW',
              leaseOwner: null,
              leaseExpiresAt: null,
              ...(input.processExitProof
                && processExitReceipt
                && !preRecordedProcessExitReceipt
                ? {
                    processState: 'EXITED',
                    terminationConfirmed: true,
                    processExitReceipt: { $literal: processExitReceipt },
                    processSignalStage: 'TREE_EMPTY',
                    processTreeEmptyAt: { $literal: input.processExitProof.treeEmptyAt },
                  }
                : {}),
              updatedAt: '$$NOW',
            },
          },
        ],
        { session, returnDocument: 'after' },
      );
      if (!finished) {
        return { committed: false, reason: 'work_deadline_or_authority' } satisfies SubmitResult;
      }
      const committedAt = finished.updatedAt;

      const blockedWait = producer?.status === 'blocked'
        ? BLOCKED_WAIT[producer.blocked.kind]
        : null;
      const jobAfterA = await jobs.findOneAndUpdate(
        {
          ...jobFilter,
          stateVersion: job.stateVersion,
        },
        {
          $set: {
            ...(useResultDrainV1
              ? { phase: 'AWAITING_RESULTS' as JobPhase }
              : blockedWait
                ? { phase: blockedWait.jobPhase }
                : {}),
            updatedAt: committedAt,
          },
          $inc: {
            stateVersion: 1,
            ...(useResultDrainV1 ? { inboxHighWatermark: 1 } : {}),
          },
        },
        { session, returnDocument: 'after' },
      );
      const taskCas = await tasks.updateOne(
        {
          _id: task._id,
          jobId: attempt.jobId,
          planVersion: attempt.planVersion,
          phase: 'DISPATCHED',
          controlState: 'NONE',
          stopGeneration: attempt.taskStopGenerationAtDispatch ?? 0,
          activeAttemptId: attempt._id,
          ...(usesPayloadReady
            ? {
                businessPayloadReadyAttemptId: attempt._id,
                businessPayloadReadyGeneration: attempt.businessPayloadReadyGeneration,
              }
            : {}),
        },
        {
          $set: {
            phase: useResultDrainV1 ? 'AWAITING_RESULT' : taskPhase,
            activeAttemptId: null,
            ...(useResultDrainV1
              ? {
                  pendingResultId: resultId,
                  appliedResultId: null,
                }
              : {}),
            updatedAt: committedAt,
          },
        },
        { session },
      );
      if (!jobAfterA || taskCas.modifiedCount !== 1) {
        throw new ResultCommitAuthorityLostError();
      }

      const events = db.collection<JobEventDoc>(COLLECTIONS.events);
      const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
      if (
        input.processExitProof
        && processExitReceipt
        && !preRecordedProcessExitReceipt
      ) {
        const processOwner = input.processExitProof.processOwner;
        const processExitedOutboxId = [
          'obx_attempt_process_exited',
          attempt._id,
          processOwner.processExecutionId,
          processOwner.ownerGeneration,
        ].join(':');
        await outbox.insertOne(
          {
            _id: processExitedOutboxId,
            aggregate: attempt.jobId,
            type: 'AttemptProcessExited',
            state: 'PENDING',
            payload: {
              resourceId: job.resourceId ?? null,
              conversationId: job.conversationId ?? null,
              jobId: attempt.jobId,
              taskId: attempt.taskId,
              attemptId: attempt._id,
              attemptFence: input.attemptFence,
              processExecutionId: processOwner.processExecutionId,
              processOwnerGeneration: processOwner.ownerGeneration,
              receiptId: processExitReceipt.receiptId,
              receiptHash: processExitReceipt.receiptHash,
              lifecycle: finished.lifecycle,
              outcome: finished.outcome,
              terminationConfirmed: true,
              processTreeEmpty: true,
            },
            createdAt: committedAt,
          },
          { session },
        );
      }
      const nextSeq = async () => {
        const last = await events.find({ jobId: attempt.jobId }, { session })
          .sort({ sequence: -1 }).limit(1).next();
        return (last?.sequence ?? -1) + 1;
      };
      const emitLaneWake = async (
        reason: string,
        extraPayload: Record<string, unknown> = {},
      ): Promise<void> => {
        const payload = {
          jobId: attempt.jobId,
          reason,
          ...extraPayload,
          activationDispatchGeneration: job.activationDispatchGeneration,
        };
        // If pause won first, its current-generation wake already owns the
        // finish-current handoff. Upgrade that durable demand with the exact
        // result identity instead of creating a second current owner.
        if (
          job.controlState === 'PAUSE_REQUESTED'
          && attempt.finishCurrentPauseGeneration === job.pauseGeneration
        ) {
          const coalesced = await outbox.findOneAndUpdate(
            {
              aggregate: attempt.jobId,
              type: 'LaneWakeRequested',
              state: 'PENDING',
              'payload.activationDispatchGeneration': job.activationDispatchGeneration,
            },
            { $set: { payload } },
            { session, sort: { createdAt: 1 }, returnDocument: 'after' },
          );
          if (coalesced) return;
        }
        await outbox.insertOne({
          _id: newOutboxId(),
          aggregate: attempt.jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          payload,
          createdAt: committedAt,
        }, { session });
      };

      if (!producer) {
        const seq = await nextSeq();
        await events.insertOne({
          _id: `${attempt.jobId}:${seq}`,
          jobId: attempt.jobId,
          sequence: seq,
          type: 'AttemptFailed',
          payload: {
            attemptId: attempt._id,
            planVersion: attempt.planVersion,
            reasonCode: 'invalid_result',
            validation: prepared.validation.ok ? 'unknown' : prepared.validation.reason,
          },
          createdAt: committedAt,
        }, { session });
        await emitLaneWake('attempt_failed', { attemptId: attempt._id });
        return {
          committed: true,
          outcome: 'FAILED',
          reason: 'invalid_result',
          deduped: false,
        } satisfies SubmitResult;
      }

      await results.insertOne({
        _id: resultId!,
        resourceId: job.resourceId,
        attemptId: attempt._id,
        jobId: attempt.jobId,
        taskId: attempt.taskId,
        planVersion: attempt.planVersion,
        leaseOwnerAtCommit: input.leaseOwner,
        attemptFence: input.attemptFence,
        payloadHash: prepared.payloadHash,
        businessPayloadReadyGeneration: usesPayloadReady
          ? attempt.businessPayloadReadyGeneration
          : 0,
        businessPayloadReadyHash: usesPayloadReady
          ? attempt.businessPayloadReadyHash
          : null,
        status: producer.status,
        producer: producer as unknown as Record<string, unknown>,
        ACommittedAt: committedAt,
        createdAt: committedAt,
      }, { session });

      const inboxItemId = useResultDrainV1
        ? `${attempt.jobId}:${resultId!}`
        : null;
      if (useResultDrainV1) {
        await db.collection<JobInboxDoc>(COLLECTIONS.inbox).insertOne({
          _id: inboxItemId!,
          jobId: attempt.jobId,
          taskId: attempt.taskId,
          attemptId: attempt._id,
          resultId: resultId!,
          inboxSequence: jobAfterA.inboxHighWatermark,
          kind: 'ATTEMPT_RESULT_V1',
          consumerVersion: 1,
          state: 'RECEIVED',
          planVersion: attempt.planVersion,
          attemptFence: input.attemptFence,
          payloadHash: prepared.payloadHash,
          finishCurrentPauseGenerationAtA: attempt.finishCurrentPauseGeneration,
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
          createdAt: committedAt,
        }, { session });
      }

      // A `blocked` producer opens a control request and puts the job in an
      // AWAITING_* wait state. It emits a projectable question, not a lane wake.
      if (producer.status === 'blocked') {
        const blk = producer.blocked;
        const requestId = `req_${globalThis.crypto.randomUUID()}`;
        const expiresAt = blk.expiresAt
          ? new Date(blk.expiresAt)
          : new Date(committedAt.getTime() + 3_600_000);
        await db.collection<ControlRequestDoc>(COLLECTIONS.requests).insertOne({
          _id: requestId,
          jobId: attempt.jobId,
          taskId: attempt.taskId,
          attemptId: attempt._id,
          kind: blk.kind,
          action: blk.action,
          state: 'OPEN',
          expiresAt,
          answer: null,
          createdAt: committedAt,
        }, { session });
        const awaitingPayload = {
          jobId: attempt.jobId,
          requestId,
          kind: blk.kind,
          action: blk.action,
          expiresAt: expiresAt.toISOString(),
        };
        const seq = await nextSeq();
        await events.insertOne({
          _id: `${attempt.jobId}:${seq}`,
          jobId: attempt.jobId,
          sequence: seq,
          type: 'JobAwaitingInput',
          payload: awaitingPayload,
          createdAt: committedAt,
        }, { session });
        await outbox.insertOne({
          _id: newOutboxId(),
          aggregate: attempt.jobId,
          type: 'JobAwaitingInput',
          state: 'PENDING',
          payload: awaitingPayload,
          createdAt: committedAt,
        }, { session });
        return {
          committed: true,
          outcome: 'BLOCKED',
          deduped: false,
        } satisfies SubmitResult;
      }

      const seq = await nextSeq();
      await events.insertOne({
        _id: `${attempt.jobId}:${seq}`,
        jobId: attempt.jobId,
        sequence: seq,
        type: 'AttemptResultAvailable',
        payload: {
          attemptId: attempt._id,
          resultId,
          ...(inboxItemId ? { inboxItemId } : {}),
          planVersion: attempt.planVersion,
          payloadHash: prepared.payloadHash,
          outcome: attemptOutcome,
        },
        createdAt: committedAt,
      }, { session });
      await emitLaneWake('result', {
        attemptId: attempt._id,
        ...(inboxItemId
          ? {
              inboxItemId,
              inboxSequence: jobAfterA.inboxHighWatermark,
            }
          : {}),
      });

      return {
        committed: true,
        outcome: attemptOutcome,
        deduped: false,
      } satisfies SubmitResult;
    });
    return value;
  } catch (err) {
    if (err instanceof ResultCommitAuthorityLostError) {
      return { committed: false, reason: 'stale_plan_or_control' };
    }
    throw err;
  }
}

class QueuedExpiryAuthorityLostError extends Error {
  constructor() {
    super('queued-attempt expiry authority changed during the transaction');
    this.name = 'QueuedExpiryAuthorityLostError';
  }
}

class LeaseReapAuthorityLostError extends Error {
  constructor() {
    super('lease-reap authority changed during the transaction');
    this.name = 'LeaseReapAuthorityLostError';
  }
}

/**
 * Recovery reducer for an attempt that waited past its business cutoff without
 * being claimed. Queue expiry is a typed terminal failure in this flat slice:
 * no hidden retry may mint a fresh execution window without persisted policy.
 */
export async function expireQueuedAttempts(client: MongoClient, db: Db): Promise<number> {
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  let expiredCount = 0;

  for (;;) {
    try {
      const { value } = await runTxn(client, async (session) => {
        const expired = await attempts.findOneAndUpdate(
          {
            lifecycle: 'QUEUED',
            $expr: { $lte: ['$businessOperationCutoffAt', '$$NOW'] },
          } as unknown as Filter<AttemptDoc>,
          [{
            $set: {
              lifecycle: 'FINISHED',
              outcome: 'FAILED',
              reasonCode: 'queue_expired',
              leaseOwner: null,
              leaseExpiresAt: null,
              businessPayloadReadyGeneration: 0,
              businessPayloadReadyHash: null,
              businessPayloadReadyAt: null,
              businessPayloadReadyPauseGeneration: null,
              updatedAt: '$$NOW',
              attemptFence: { $add: ['$attemptFence', 1] },
            },
          }],
          { session, sort: { businessOperationCutoffAt: 1 }, returnDocument: 'after' },
        );
        if (!expired) return 0;

        const job = await jobs.findOne({ _id: expired.jobId }, { session });
        const task = await tasks.findOne({ _id: expired.taskId }, { session });
        if (!task || TERMINAL_TASK_PHASES.has(task.phase)) return 1;

        if (
          job
          && job.terminalOutcome === null
          && job.controlState === 'NONE'
          && job.planVersion === expired.planVersion
          && job.pauseGeneration === expired.pauseGenerationAtDispatch
        ) {
          const taskCas = await tasks.updateOne(
            {
              _id: task._id,
              jobId: expired.jobId,
              phase: 'DISPATCHED',
              controlState: 'NONE',
              planVersion: expired.planVersion,
              activeAttemptId: null,
            },
            {
              $set: {
                phase: 'FAILED',
                businessPayloadReadyAttemptId: null,
                businessPayloadReadyGeneration: 0,
                retryNotBefore: null,
                updatedAt: expired.updatedAt,
              },
            },
            { session },
          );
          const jobTouch = await jobs.updateOne(
            {
              _id: job._id,
              stateVersion: job.stateVersion,
              terminalOutcome: null,
              controlState: 'NONE',
              planVersion: expired.planVersion,
              pauseGeneration: expired.pauseGenerationAtDispatch,
            },
            {
              $set: { updatedAt: expired.updatedAt },
              $inc: { stateVersion: 1 },
            },
            { session },
          );
          if (taskCas.modifiedCount !== 1 || jobTouch.modifiedCount !== 1) {
            throw new QueuedExpiryAuthorityLostError();
          }
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
            _id: newOutboxId(),
            aggregate: expired.jobId,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            payload: {
              jobId: expired.jobId,
              reason: 'queue_expired',
              activationDispatchGeneration: job.activationDispatchGeneration,
            },
            createdAt: expired.updatedAt,
          }, { session });
          return 1;
        }

        // A terminal/stale plan owns no more business retry authority. Settle
        // the task projection without emitting a new business wake.
        await tasks.updateOne(
          {
            _id: task._id,
            jobId: expired.jobId,
            phase: 'DISPATCHED',
            activeAttemptId: null,
          },
          {
            $set: {
              phase: job && job.terminalOutcome !== null ? 'CANCELLED' : 'SUPERSEDED',
              businessPayloadReadyAttemptId: null,
              businessPayloadReadyGeneration: 0,
              retryNotBefore: null,
              updatedAt: expired.updatedAt,
            },
          },
          { session },
        );
        return 1;
      });
      if (value === 0) break;
      expiredCount += value;
    } catch (err) {
      if (err instanceof QueuedExpiryAuthorityLostError) continue;
      throw err;
    }
  }
  return expiredCount;
}

/**
 * Recovery reaper: fence off expired attempt owners. Legacy/unowned work becomes
 * WORKER_LOST and follows the bounded retry path. A registered process, or any
 * attempt already in first-stop, whose empty tree has not been confirmed
 * instead fails closed to UNKNOWN_OUTCOME: retry is suppressed, the aggregate
 * enters RECONCILING and an operator alert is durable. This prevents a second
 * attempt from overlapping a process that may still be alive.
 */
export async function reapExpiredLeases(
  client: MongoClient, db: Db, opts: { maxAttempts?: number; retryBackoffMs?: number } = {},
): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = opts.retryBackoffMs ?? 0;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  let reaped = 0;
  for (;;) {
    try {
      const { value } = await runTxn(client, async (session) => {
        const unconfirmedProcessExpr = {
          $or: [
            // Once first-stop committed, ordinary lease recovery must never
            // reinterpret missing acknowledgement as safe retry — even a
            // legacy/unowned worker has no trusted termination proof.
            { $eq: ['$lifecycle', 'STOP_REQUESTED'] },
            {
              $and: [
                { $eq: [{ $type: '$processOwner' }, 'object'] },
                {
                  $in: [
                    { $ifNull: ['$processState', 'NONE'] },
                    ['OWNED', 'STOP_REQUESTED'],
                  ],
                },
                { $ne: [{ $ifNull: ['$terminationConfirmed', false] }, true] },
              ],
            },
          ],
        };
        const expired = await attempts.findOneAndUpdate(
          {
            lifecycle: { $in: ['LEASED', 'RUNNING', 'STOP_REQUESTED'] },
            leaseExpiresAt: { $type: 'date' },
            // A real PROCESS_GROUP keeps its original fence until the process
            // supervisor either records tree-empty or its durable stop-grace
            // timer fails closed. Generic lease recovery must not fence away
            // the only authority that can safely signal an orphaned group.
            $nor: [{
              'processOwner.mode': 'PROCESS_GROUP',
              terminationConfirmed: { $ne: true },
            }],
            $expr: { $lte: ['$leaseExpiresAt', '$$NOW'] },
          } as unknown as Filter<AttemptDoc>,
          [{
            $set: {
              lifecycle: 'FINISHED',
              outcome: {
                $cond: [
                  unconfirmedProcessExpr,
                  'UNKNOWN_OUTCOME',
                  'WORKER_LOST',
                ],
              },
              reasonCode: {
                $cond: [
                  unconfirmedProcessExpr,
                  'process_termination_unconfirmed',
                  { $ifNull: ['$reasonCode', 'lease_lost'] },
                ],
              },
              attemptFence: { $add: ['$attemptFence', 1] },
              leaseOwner: null,
              leaseExpiresAt: null,
              processState: {
                $cond: [
                  unconfirmedProcessExpr,
                  'UNKNOWN',
                  { $ifNull: ['$processState', 'UNKNOWN'] },
                ],
              },
              terminationConfirmed: {
                $cond: [
                  unconfirmedProcessExpr,
                  false,
                  { $ifNull: ['$terminationConfirmed', null] },
                ],
              },
              processReconcileNextAt: {
                $cond: [
                  unconfirmedProcessExpr,
                  '$$NOW',
                  { $ifNull: ['$processReconcileNextAt', null] },
                ],
              },
              processReconcileProbeAttempt: {
                $cond: [
                  unconfirmedProcessExpr,
                  0,
                  { $ifNull: ['$processReconcileProbeAttempt', 0] },
                ],
              },
              stopGeneration: {
                $cond: [
                  unconfirmedProcessExpr,
                  { $max: [{ $ifNull: ['$stopGeneration', 0] }, 1] },
                  { $ifNull: ['$stopGeneration', 0] },
                ],
              },
              primaryAttemptStopCause: {
                $cond: [
                  unconfirmedProcessExpr,
                  { $ifNull: ['$primaryAttemptStopCause', 'lease_lost'] },
                  { $ifNull: ['$primaryAttemptStopCause', null] },
                ],
              },
              secondaryAttemptStopCauses: {
                $cond: [
                  {
                    $and: [
                      unconfirmedProcessExpr,
                      { $ne: [{ $ifNull: ['$primaryAttemptStopCause', null] }, null] },
                      { $ne: ['$primaryAttemptStopCause', 'lease_lost'] },
                    ],
                  },
                  {
                    $setUnion: [
                      { $ifNull: ['$secondaryAttemptStopCauses', []] },
                      ['lease_lost'],
                    ],
                  },
                  { $ifNull: ['$secondaryAttemptStopCauses', []] },
                ],
              },
              updatedAt: '$$NOW',
            },
          }],
          { session, returnDocument: 'after' },
        );
        if (!expired) return 0;

        const task = await tasks.findOne({ _id: expired.taskId }, { session });
        const job = await jobs.findOne({ _id: expired.jobId }, { session });
        const unresolvedProcess = Boolean(
          expired.outcome === 'UNKNOWN_OUTCOME'
          && expired.processState === 'UNKNOWN'
          && expired.terminationConfirmed === false,
        );
        if (unresolvedProcess) {
          if (
            task
            && !TERMINAL_TASK_PHASES.has(task.phase)
            && task.activeAttemptId === expired._id
            && task.planVersion === expired.planVersion
          ) {
            const reconciledTask = await tasks.updateOne(
              {
                _id: task._id,
                jobId: expired.jobId,
                planVersion: expired.planVersion,
                activeAttemptId: expired._id,
                phase: task.phase,
              },
              {
                $set: {
                  phase: 'RECONCILING',
                  activeAttemptId: null,
                  businessPayloadReadyAttemptId: null,
                  businessPayloadReadyGeneration: 0,
                  pendingResultId: null,
                  retryNotBefore: null,
                  updatedAt: expired.updatedAt,
                },
              },
              { session },
            );
            if (reconciledTask.modifiedCount !== 1) {
              throw new LeaseReapAuthorityLostError();
            }
          }
          if (
            job
            && job.terminalOutcome === null
            && job.planVersion === expired.planVersion
          ) {
            const reconciledJob = await jobs.updateOne(
              {
                _id: job._id,
                stateVersion: job.stateVersion,
                terminalOutcome: null,
                planVersion: expired.planVersion,
                jobStopGeneration: job.jobStopGeneration,
                controlState: job.controlState,
              },
              {
                $set: {
                  phase: 'RECONCILING',
                  ...(job.controlState === 'STOP_REQUESTED'
                    ? { pendingTerminalOutcome: 'UNKNOWN_OUTCOME' as const }
                    : {}),
                  updatedAt: expired.updatedAt,
                },
                $inc: { stateVersion: 1 },
              },
              { session },
            );
            if (reconciledJob.modifiedCount !== 1) {
              throw new LeaseReapAuthorityLostError();
            }
          }
          await db.collection<TimerDoc>(COLLECTIONS.timers).updateMany(
            {
              jobId: expired.jobId,
              state: 'PENDING',
              $or: [
                { kind: 'retry', entityId: expired.taskId },
                { kind: 'attempt_stop_grace', entityId: expired._id },
              ],
            },
            { $set: { state: 'CANCELLED' } },
            { session },
          );
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
            {
              _id: [
                'obx_process_unknown',
                expired._id,
                expired.processOwner?.processExecutionId ?? 'unowned',
                expired.processOwner?.ownerGeneration ?? 0,
              ].join(':'),
            },
            {
              $setOnInsert: {
                _id: [
                  'obx_process_unknown',
                  expired._id,
                  expired.processOwner?.processExecutionId ?? 'unowned',
                  expired.processOwner?.ownerGeneration ?? 0,
                ].join(':'),
                aggregate: expired.jobId,
                type: 'OperatorAlertRequested',
                state: 'PENDING',
                payload: {
                  alertType: 'process_termination_unconfirmed',
                  resourceId: job?.resourceId ?? null,
                  conversationId: job?.conversationId ?? null,
                  jobId: expired.jobId,
                  taskId: expired.taskId,
                  attemptId: expired._id,
                  processExecutionId: expired.processOwner?.processExecutionId ?? null,
                  processOwnerGeneration: expired.processOwner?.ownerGeneration ?? null,
                  stopGeneration: expired.stopGeneration ?? 0,
                  terminationConfirmed: false,
                  retrySuppressed: true,
                },
                createdAt: expired.updatedAt,
              },
            },
            { session, upsert: true },
          );
          return 1;
        }
        if (
          !task
          || TERMINAL_TASK_PHASES.has(task.phase)
          || task.activeAttemptId !== expired._id
        ) {
          return 1;
        }

        const normalRetryAuthority = Boolean(
          job
          && job.terminalOutcome === null
          && job.controlState === 'NONE'
          && job.planVersion === expired.planVersion
          && job.pauseGeneration === expired.pauseGenerationAtDispatch,
        );
        const finishCurrentRetryAuthority = Boolean(
          job
          && job.terminalOutcome === null
          && job.controlState === 'PAUSE_REQUESTED'
          && job.planVersion === expired.planVersion
          && expired.finishCurrentPauseGeneration === job.pauseGeneration,
        );
        const pauseRecoveryRetryAuthority = Boolean(
          job
          && job.terminalOutcome === null
          && job.controlState === 'PAUSE_REQUESTED'
          && job.planVersion === expired.planVersion
          && expired.finishCurrentPauseGeneration === null
          && job.pauseGeneration === expired.pauseGenerationAtDispatch + 1,
        );
        const currentRetryAuthority =
          normalRetryAuthority || finishCurrentRetryAuthority || pauseRecoveryRetryAuthority;
        if (!currentRetryAuthority || !job) {
          const settled = await tasks.updateOne(
            { _id: task._id, activeAttemptId: expired._id },
            {
              $set: {
                phase: job && job.terminalOutcome !== null ? 'CANCELLED' : 'SUPERSEDED',
                activeAttemptId: null,
                businessPayloadReadyAttemptId: null,
                businessPayloadReadyGeneration: 0,
                retryNotBefore: null,
                updatedAt: expired.updatedAt,
              },
            },
            { session },
          );
          if (settled.modifiedCount !== 1) throw new LeaseReapAuthorityLostError();
          return 1;
        }

        const jobAuthority: Filter<JobDoc> = {
          _id: job._id,
          stateVersion: job.stateVersion,
          terminalOutcome: null,
          planVersion: expired.planVersion,
          ...(normalRetryAuthority
            ? {
                controlState: 'NONE',
                pauseGeneration: expired.pauseGenerationAtDispatch,
              }
            : {
                controlState: 'PAUSE_REQUESTED',
                pauseGeneration: job.pauseGeneration,
              }),
        };
        const jobTouch = await jobs.updateOne(
          jobAuthority,
          {
            $set: { updatedAt: expired.updatedAt },
            $inc: { stateVersion: 1 },
          },
          { session },
        );
        if (jobTouch.modifiedCount !== 1) throw new LeaseReapAuthorityLostError();

        // Pre-start pause cancellations do not consume worker-loss retry budget.
        const workerLossCount = await attempts.countDocuments({
          taskId: expired.taskId,
          outcome: 'WORKER_LOST',
        }, { session });
        const taskFilter = { _id: task._id, activeAttemptId: expired._id };
        if (workerLossCount >= maxAttempts) {
          const failed = await tasks.updateOne(
            taskFilter,
            {
              $set: {
                phase: 'FAILED',
                activeAttemptId: null,
                businessPayloadReadyAttemptId: null,
                businessPayloadReadyGeneration: 0,
                retryNotBefore: null,
                updatedAt: expired.updatedAt,
              },
            },
            { session },
          );
          if (failed.modifiedCount !== 1) throw new LeaseReapAuthorityLostError();
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
            _id: newOutboxId(),
            aggregate: expired.jobId,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            payload: {
              jobId: expired.jobId,
              reason: 'retry_exhausted',
              activationDispatchGeneration: job.activationDispatchGeneration,
            },
            createdAt: expired.updatedAt,
          }, { session });
        } else if (backoffMs > 0) {
          const fireAt = new Date(expired.updatedAt.getTime() + backoffMs);
          const retry = await tasks.updateOne(
            taskFilter,
            {
              $set: {
                phase: 'RETRY_PENDING',
                activeAttemptId: null,
                businessPayloadReadyAttemptId: null,
                businessPayloadReadyGeneration: 0,
                retryNotBefore: fireAt,
                updatedAt: expired.updatedAt,
              },
            },
            { session },
          );
          if (retry.modifiedCount !== 1) throw new LeaseReapAuthorityLostError();
          await db.collection<TimerDoc>(COLLECTIONS.timers).insertOne({
            _id: `tmr_${globalThis.crypto.randomUUID()}`,
            kind: 'retry',
            jobId: expired.jobId,
            entityId: task._id,
            generation: 0,
            sourceRedriveAttempt: null,
            fireAt,
            state: 'PENDING',
            firedAt: null,
            wakeId: null,
            createdAt: expired.updatedAt,
          }, { session });
        } else {
          const retry = await tasks.updateOne(
            taskFilter,
            {
              $set: {
                phase: 'RETRY_PENDING',
                activeAttemptId: null,
                businessPayloadReadyAttemptId: null,
                businessPayloadReadyGeneration: 0,
                retryNotBefore: null,
                updatedAt: expired.updatedAt,
              },
            },
            { session },
          );
          if (retry.modifiedCount !== 1) throw new LeaseReapAuthorityLostError();
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
            _id: newOutboxId(),
            aggregate: expired.jobId,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            payload: {
              jobId: expired.jobId,
              reason: 'worker_lost',
              activationDispatchGeneration: job.activationDispatchGeneration,
            },
            createdAt: expired.updatedAt,
          }, { session });
        }
        return 1;
      });
      if (value === 0) break;
      reaped += value;
    } catch (err) {
      if (err instanceof LeaseReapAuthorityLostError) continue;
      throw err;
    }
  }
  return reaped;
}
