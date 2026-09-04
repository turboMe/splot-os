/**
 * Durable PROCESS_SUPERVISOR_V1 facts.
 *
 * Receipt transactions record OS-process truth only. After that fact commits,
 * PR-39 opportunistically invokes the separate flat terminal barrier; a crash
 * between the two is repaired by the bounded reconciler. A normal process exit
 * remains a distinct immutable fact from a stop-generation receipt.
 */
import type { Db, Filter, MongoClient } from 'mongodb';
import { canonicalHash, runTxn } from './txn.js';
import {
  COLLECTIONS,
  PROCESS_SIGNAL_STAGES,
  type AttemptDoc,
  type AttemptProcessExitReceiptDoc,
  type AttemptProcessOwnerDoc,
  type JobDoc,
  type OutboxDoc,
  type ProcessSignalStage,
} from './collections.js';
import {
  reducePendingFlatTerminalThroughControl,
} from './stop-control-recovery.js';

export class AttemptProcessExitReceiptConflictError extends Error {
  constructor(readonly attemptId: string) {
    super(`attempt ${attemptId} already has a different immutable process-exit receipt`);
    this.name = 'AttemptProcessExitReceiptConflictError';
  }
}

export class InvalidAttemptProcessExitReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAttemptProcessExitReceiptError';
  }
}

export interface AttemptProcessExitProofInput {
  processOwner: AttemptProcessOwnerDoc;
  receiptId: string;
  terminationConfirmed: true;
  processTreeEmpty: true;
  exitCode: number | null;
  signal: string | null;
  observedAt: Date;
  treeEmptyAt: Date;
}

export interface RecordAttemptProcessExitReceiptInput
  extends AttemptProcessExitProofInput {
  attemptId: string;
  attemptFence: number;
}

export interface RecordPostStopUnknownProcessExitReceiptInput
  extends AttemptProcessExitProofInput {
  attemptId: string;
  /** Original process-owner fence, one below the fail-closed current fence. */
  attemptFence: number;
  stopGeneration: number;
}

export interface RecordAttemptProcessExitReceiptResult {
  attemptId: string;
  receiptId: string;
  lifecycle: AttemptDoc['lifecycle'];
  outcome: AttemptDoc['outcome'];
  recorded: boolean;
  deduped: boolean;
}

export interface RecordAttemptProcessSignalInput {
  attemptId: string;
  attemptFence: number;
  stopGeneration: number;
  processOwner: AttemptProcessOwnerDoc;
  stage: Exclude<ProcessSignalStage, 'NONE' | 'TREE_EMPTY'>;
}

const SIGNAL_STAGE_RANK = new Map<ProcessSignalStage, number>(
  PROCESS_SIGNAL_STAGES.map((stage, index) => [stage, index]),
);

function sameDate(left: Date, right: Date): boolean {
  return left instanceof Date
    && right instanceof Date
    && left.getTime() === right.getTime();
}

export function sameAttemptProcessOwner(
  left: AttemptProcessOwnerDoc | null | undefined,
  right: AttemptProcessOwnerDoc,
): boolean {
  return Boolean(
    left
      && left.processExecutionId === right.processExecutionId
      && left.runtimeRunId === right.runtimeRunId
      && left.workerInstanceId === right.workerInstanceId
      && left.ownerGeneration === right.ownerGeneration
      && left.attemptFence === right.attemptFence
      && left.mode === right.mode
      && left.hostId === right.hostId
      && left.hostBootId === right.hostBootId
      && (left.pidNamespaceId ?? null) === (right.pidNamespaceId ?? null)
      && left.pid === right.pid
      && left.pgid === right.pgid
      && (left.sid ?? null) === (right.sid ?? null)
      && left.processStartToken === right.processStartToken
      && sameDate(left.registeredAt, right.registeredAt)
      && sameDate(left.startedAt, right.startedAt),
  );
}

export function attemptProcessOwnerFilter(
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

function validateProcessExitProof(
  input: AttemptProcessExitProofInput,
  attemptFence: number,
): void {
  const owner = input.processOwner;
  if (
    owner.mode !== 'PROCESS_GROUP'
    || !owner.processExecutionId
    || !owner.runtimeRunId
    || !owner.workerInstanceId
    || !owner.hostId
    || !owner.hostBootId
    || !owner.pidNamespaceId
    || !/^[0-9]+$/.test(owner.processStartToken)
    || !Number.isInteger(owner.ownerGeneration)
    || owner.ownerGeneration < 1
    || !Number.isInteger(owner.pid)
    || owner.pid < 2
    || owner.pid !== owner.pgid
    || owner.pid !== owner.sid
  ) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit proof requires a complete PROCESS_GROUP owner',
    );
  }
  if (
    input.terminationConfirmed !== true
    || input.processTreeEmpty !== true
  ) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit proof requires terminationConfirmed=true and processTreeEmpty=true',
    );
  }
  if (!input.receiptId) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit receiptId must be non-empty',
    );
  }
  if (
    !Number.isInteger(attemptFence)
    || attemptFence < 0
    || input.processOwner.attemptFence !== attemptFence
  ) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit proof fence does not match its process owner',
    );
  }
  if (
    !(input.observedAt instanceof Date)
    || Number.isNaN(input.observedAt.getTime())
    || !(input.treeEmptyAt instanceof Date)
    || Number.isNaN(input.treeEmptyAt.getTime())
  ) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit observation times must be valid Dates',
    );
  }
  if (input.treeEmptyAt.getTime() < input.observedAt.getTime()) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit treeEmptyAt must not precede observedAt',
    );
  }
  if (
    input.exitCode !== null
    && (!Number.isInteger(input.exitCode) || input.exitCode < 0)
  ) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit exitCode must be a non-negative integer or null',
    );
  }
  if (
    input.signal !== null
    && (typeof input.signal !== 'string' || input.signal.length === 0)
  ) {
    throw new InvalidAttemptProcessExitReceiptError(
      'normal exit signal must be a non-empty string or null',
    );
  }
}

export function buildAttemptProcessExitReceipt(
  input: AttemptProcessExitProofInput,
  attemptFence: number,
): AttemptProcessExitReceiptDoc {
  return buildProcessExitReceipt(
    input,
    attemptFence,
    'NORMAL_PROCESS_TREE_EMPTY',
  );
}

export function buildPostStopUnknownProcessExitReceipt(
  input: AttemptProcessExitProofInput,
  attemptFence: number,
  stopGeneration: number,
): AttemptProcessExitReceiptDoc {
  return buildProcessExitReceipt(
    input,
    attemptFence,
    'POST_STOP_UNKNOWN_TREE_EMPTY',
    stopGeneration,
  );
}

function buildProcessExitReceipt(
  input: AttemptProcessExitProofInput,
  attemptFence: number,
  confirmationKind: AttemptProcessExitReceiptDoc['confirmationKind'],
  stopGeneration?: number,
): AttemptProcessExitReceiptDoc {
  validateProcessExitProof(input, attemptFence);
  const owner = input.processOwner;
  const hashPayload = {
    receiptId: input.receiptId,
    processExecutionId: owner.processExecutionId,
    runtimeRunId: owner.runtimeRunId,
    workerInstanceId: owner.workerInstanceId,
    processOwnerGeneration: owner.ownerGeneration,
    attemptFence,
    ...(stopGeneration === undefined ? {} : { stopGeneration }),
    hostId: owner.hostId,
    hostBootId: owner.hostBootId,
    pidNamespaceId: owner.pidNamespaceId ?? null,
    pid: owner.pid,
    pgid: owner.pgid,
    sid: owner.sid ?? null,
    processStartToken: owner.processStartToken,
    confirmationKind,
    terminationConfirmed: true as const,
    processTreeEmpty: true as const,
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
    observedAt: input.observedAt,
    treeEmptyAt: input.treeEmptyAt,
  };
}

export function sameExitReceiptAuthority(
  receipt: AttemptProcessExitReceiptDoc,
  owner: AttemptProcessOwnerDoc,
  attemptFence: number,
): boolean {
  return receipt.attemptFence === attemptFence
    && receipt.processExecutionId === owner.processExecutionId
    && receipt.runtimeRunId === owner.runtimeRunId
    && receipt.workerInstanceId === owner.workerInstanceId
    && receipt.processOwnerGeneration === owner.ownerGeneration
    && receipt.hostId === owner.hostId
    && receipt.hostBootId === owner.hostBootId
    && (receipt.pidNamespaceId ?? null) === (owner.pidNamespaceId ?? null)
    && receipt.pid === owner.pid
    && receipt.pgid === owner.pgid
    && (receipt.sid ?? null) === (owner.sid ?? null)
    && receipt.processStartToken === owner.processStartToken;
}

/**
 * Store a late or standalone normal-exit proof. This is legal for RUNNING and
 * business-FINISHED attempts, but never for STOP_REQUESTED: current stop
 * authority must use recordAttemptStopReceipt instead.
 */
export async function recordAttemptProcessExitReceipt(
  client: MongoClient,
  db: Db,
  input: RecordAttemptProcessExitReceiptInput,
): Promise<RecordAttemptProcessExitReceiptResult | null> {
  const candidate = buildAttemptProcessExitReceipt(input, input.attemptFence);
  const { value } = await runTxn(client, async (session) => {
    const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
    const current = await attempts.findOne(
      { _id: input.attemptId },
      { session },
    );
    if (!current) return null;
    if (current.processExitReceipt) {
      if (
        current.processExitReceipt.confirmationKind
          !== 'NORMAL_PROCESS_TREE_EMPTY'
        || !sameAttemptProcessOwner(current.processOwner, input.processOwner)
        || !sameExitReceiptAuthority(
          current.processExitReceipt,
          input.processOwner,
          input.attemptFence,
        )
      ) return null;
      if (
        current.processExitReceipt.receiptId === candidate.receiptId
        && current.processExitReceipt.receiptHash === candidate.receiptHash
      ) {
        return {
          attemptId: current._id,
          receiptId: current.processExitReceipt.receiptId,
          lifecycle: current.lifecycle,
          outcome: current.outcome,
          recorded: false,
          deduped: true,
        } satisfies RecordAttemptProcessExitReceiptResult;
      }
      throw new AttemptProcessExitReceiptConflictError(current._id);
    }
    if (
      !['RUNNING', 'FINISHED'].includes(current.lifecycle)
      || current.lifecycle === 'STOP_REQUESTED'
      || current.attemptFence !== input.attemptFence
      || !sameAttemptProcessOwner(current.processOwner, input.processOwner)
      || current.stopReceipt !== null
      || current.terminationConfirmed === true
    ) return null;

    const recorded = await attempts.findOneAndUpdate(
      {
        _id: current._id,
        lifecycle: current.lifecycle,
        attemptFence: input.attemptFence,
        processExitReceipt: null,
        stopReceipt: null,
        terminationConfirmed: { $ne: true },
        ...attemptProcessOwnerFilter(input.processOwner),
      } as unknown as Filter<AttemptDoc>,
      [{
        $set: {
          processState: 'EXITED',
          terminationConfirmed: true,
          processExitReceipt: { $literal: candidate },
          processSignalStage: 'TREE_EMPTY',
          processTreeEmptyAt: { $literal: input.treeEmptyAt },
          processReconcileNextAt: null,
          processReconcileProbeAttempt: 0,
          updatedAt: '$$NOW',
        },
      }],
      { session, returnDocument: 'after' },
    );
    if (!recorded) return null;

    const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
      { _id: current.jobId },
      { session },
    );
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
      {
        _id: [
          'obx_attempt_process_exited',
          current._id,
          input.processOwner.processExecutionId,
          input.processOwner.ownerGeneration,
        ].join(':'),
      },
      {
        $setOnInsert: {
          _id: [
            'obx_attempt_process_exited',
            current._id,
            input.processOwner.processExecutionId,
            input.processOwner.ownerGeneration,
          ].join(':'),
          aggregate: current.jobId,
          type: 'AttemptProcessExited',
          state: 'PENDING',
          payload: {
            resourceId: job?.resourceId ?? null,
            conversationId: job?.conversationId ?? null,
            jobId: current.jobId,
            taskId: current.taskId,
            attemptId: current._id,
            attemptFence: input.attemptFence,
            processExecutionId: input.processOwner.processExecutionId,
            processOwnerGeneration: input.processOwner.ownerGeneration,
            receiptId: candidate.receiptId,
            receiptHash: candidate.receiptHash,
            lifecycle: recorded.lifecycle,
            outcome: recorded.outcome,
            terminationConfirmed: true,
            processTreeEmpty: true,
          },
          createdAt: recorded.updatedAt,
        },
      },
      { session, upsert: true },
    );
    return {
      attemptId: current._id,
      receiptId: candidate.receiptId,
      lifecycle: recorded.lifecycle,
      outcome: recorded.outcome,
      recorded: true,
      deduped: false,
    } satisfies RecordAttemptProcessExitReceiptResult;
  });
  if (value) {
    const attempt = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
      .findOne({ _id: input.attemptId }, { projection: { jobId: 1 } });
    if (attempt) {
      await reducePendingFlatTerminalThroughControl(
        client,
        db,
        attempt.jobId,
        { makeEligibleNow: value.deduped === false },
      );
    }
  }
  return value;
}

/**
 * Record liveness after a stop-grace/reaper already fenced business authority
 * to UNKNOWN_OUTCOME. The old process owner is still the only identity allowed
 * to prove tree-empty, but this fact never rewrites outcome, result, reason or
 * the incremented attempt fence.
 */
export async function recordPostStopUnknownProcessExitReceipt(
  client: MongoClient,
  db: Db,
  input: RecordPostStopUnknownProcessExitReceiptInput,
): Promise<RecordAttemptProcessExitReceiptResult | null> {
  if (!Number.isInteger(input.stopGeneration) || input.stopGeneration <= 0) {
    throw new InvalidAttemptProcessExitReceiptError(
      'post-stop UNKNOWN receipt requires a positive stop generation',
    );
  }
  const candidate = buildPostStopUnknownProcessExitReceipt(
    input,
    input.attemptFence,
    input.stopGeneration,
  );
  const { value } = await runTxn(client, async (session) => {
    const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
    const current = await attempts.findOne(
      { _id: input.attemptId },
      { session },
    );
    if (!current) return null;
    if (current.processExitReceipt) {
      if (
        current.processExitReceipt.confirmationKind
          !== 'POST_STOP_UNKNOWN_TREE_EMPTY'
        || !sameAttemptProcessOwner(current.processOwner, input.processOwner)
        || !sameExitReceiptAuthority(
          current.processExitReceipt,
          input.processOwner,
          input.attemptFence,
        )
      ) return null;
      if (
        current.processExitReceipt.receiptId === candidate.receiptId
        && current.processExitReceipt.receiptHash === candidate.receiptHash
      ) {
        return {
          attemptId: current._id,
          receiptId: current.processExitReceipt.receiptId,
          lifecycle: current.lifecycle,
          outcome: current.outcome,
          recorded: false,
          deduped: true,
        } satisfies RecordAttemptProcessExitReceiptResult;
      }
      throw new AttemptProcessExitReceiptConflictError(current._id);
    }
    if (
      current.lifecycle !== 'FINISHED'
      || current.outcome !== 'UNKNOWN_OUTCOME'
      || ![
        'attempt_stop_unconfirmed',
        'process_termination_unconfirmed',
      ].includes(current.reasonCode ?? '')
      || current.processState !== 'UNKNOWN'
      || current.terminationConfirmed !== false
      || current.attemptFence !== input.attemptFence + 1
      || (current.stopGeneration ?? 0) !== input.stopGeneration
      || !sameAttemptProcessOwner(current.processOwner, input.processOwner)
      || current.stopReceipt !== null
      || current.leaseOwner !== null
    ) return null;

    const recorded = await attempts.findOneAndUpdate(
      {
        _id: current._id,
        lifecycle: 'FINISHED',
        outcome: 'UNKNOWN_OUTCOME',
        reasonCode: current.reasonCode,
        attemptFence: input.attemptFence + 1,
        stopGeneration: input.stopGeneration,
        processState: 'UNKNOWN',
        terminationConfirmed: false,
        processExitReceipt: null,
        stopReceipt: null,
        leaseOwner: null,
        ...attemptProcessOwnerFilter(input.processOwner),
      } as unknown as Filter<AttemptDoc>,
      [{
        $set: {
          processState: 'EXITED',
          terminationConfirmed: true,
          processExitReceipt: { $literal: candidate },
          processSignalStage: 'TREE_EMPTY',
          processTreeEmptyAt: { $literal: input.treeEmptyAt },
          processReconcileNextAt: null,
          processReconcileProbeAttempt: 0,
          updatedAt: '$$NOW',
        },
      }],
      { session, returnDocument: 'after' },
    );
    if (!recorded) return null;

    const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
      { _id: current.jobId },
      { session },
    );
    const outboxId = [
      'obx_attempt_process_exited',
      current._id,
      input.processOwner.processExecutionId,
      input.processOwner.ownerGeneration,
    ].join(':');
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
      { _id: outboxId },
      {
        $setOnInsert: {
          _id: outboxId,
          aggregate: current.jobId,
          type: 'AttemptProcessExited',
          state: 'PENDING',
          payload: {
            resourceId: job?.resourceId ?? null,
            conversationId: job?.conversationId ?? null,
            jobId: current.jobId,
            taskId: current.taskId,
            attemptId: current._id,
            attemptFence: input.attemptFence,
            stopGeneration: input.stopGeneration,
            processExecutionId: input.processOwner.processExecutionId,
            processOwnerGeneration: input.processOwner.ownerGeneration,
            receiptId: candidate.receiptId,
            receiptHash: candidate.receiptHash,
            confirmationKind: candidate.confirmationKind,
            lifecycle: recorded.lifecycle,
            outcome: recorded.outcome,
            terminationConfirmed: true,
            processTreeEmpty: true,
          },
          createdAt: recorded.updatedAt,
        },
      },
      { session, upsert: true },
    );
    return {
      attemptId: current._id,
      receiptId: candidate.receiptId,
      lifecycle: recorded.lifecycle,
      outcome: recorded.outcome,
      recorded: true,
      deduped: false,
    } satisfies RecordAttemptProcessExitReceiptResult;
  });
  if (value) {
    const attempt = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
      .findOne({ _id: input.attemptId }, { projection: { jobId: 1 } });
    if (attempt) {
      await reducePendingFlatTerminalThroughControl(
        client,
        db,
        attempt.jobId,
        { makeEligibleNow: value.deduped === false },
      );
    }
  }
  return value;
}

/** Persist monotonic signal evidence under the exact current stop authority. */
export async function recordAttemptProcessSignalStage(
  client: MongoClient,
  db: Db,
  input: RecordAttemptProcessSignalInput,
): Promise<boolean> {
  const requestedRank = SIGNAL_STAGE_RANK.get(input.stage) ?? -1;
  if (
    requestedRank <= 0
    || input.processOwner.attemptFence !== input.attemptFence
    || !Number.isInteger(input.stopGeneration)
    || input.stopGeneration <= 0
  ) return false;

  const { value } = await runTxn(client, async (session) => {
    const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
    const current = await attempts.findOne(
      { _id: input.attemptId },
      { session },
    );
    if (
      !current
      || current.lifecycle !== 'STOP_REQUESTED'
      || current.attemptFence !== input.attemptFence
      || (current.stopGeneration ?? 0) !== input.stopGeneration
      || !sameAttemptProcessOwner(current.processOwner, input.processOwner)
      || current.stopReceipt !== null
    ) return false;

    const currentRank = SIGNAL_STAGE_RANK.get(
      current.processSignalStage ?? 'NONE',
    ) ?? 0;
    if (currentRank >= requestedRank) return true;
    const timestampField = {
      OBSERVED: 'processStopObservedAt',
      ABORT_SENT: 'processAbortSentAt',
      TERM_SENT: 'processTermSentAt',
      KILL_SENT: 'processKillSentAt',
    }[input.stage];
    const updated = await attempts.updateOne(
      {
        _id: current._id,
        lifecycle: 'STOP_REQUESTED',
        attemptFence: input.attemptFence,
        stopGeneration: input.stopGeneration,
        processSignalStage: current.processSignalStage ?? 'NONE',
        stopReceipt: null,
        ...attemptProcessOwnerFilter(input.processOwner),
      } as unknown as Filter<AttemptDoc>,
      [{
        $set: {
          processSignalStage: input.stage,
          ...(timestampField ? { [timestampField]: '$$NOW' } : {}),
          updatedAt: '$$NOW',
        },
      }],
      { session },
    );
    if (updated.modifiedCount !== 1) return false;
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
      {
        _id: `obx_attempt_stop:${current._id}:${input.stopGeneration}`,
        type: 'AttemptStopRequested',
        state: 'PENDING',
      },
      { $set: { state: 'PUBLISHED' } },
      { session },
    );
    return true;
  });
  return value;
}
