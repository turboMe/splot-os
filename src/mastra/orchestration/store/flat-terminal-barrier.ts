/**
 * PR-39 — flat terminal-stop barrier.
 *
 * This is deliberately separate from ordinary task aggregation and
 * RESULT_DRAIN. It consumes only a durable pending stop decision and only for
 * the currently provable flat slice: zero or one SERIAL root task, no dispatch
 * edges and no attached child job. Anything structurally outside that slice is
 * persisted as BLOCKED_UNSUPPORTED instead of being guessed settled.
 */
import type { ClientSession, Db, Filter, MongoClient } from 'mongodb';
import {
  JOB_TERMINAL_OUTCOMES,
  PRIMARY_JOB_STOP_CAUSES,
  type JobTerminalOutcome,
  type PrimaryJobStopCause,
  type TaskPhase,
} from '../contracts/index.js';
import { canonicalHash } from './txn.js';
import {
  COLLECTIONS,
  CONTROL_BUDGET_POLICY_V1,
  STOP_CONTROL_RECOVERY_STATES,
  type AttemptDoc,
  type AttemptProcessExitReceiptDoc,
  type AttemptProcessOwnerDoc,
  type AttemptStopReceiptDoc,
  type ControlRequestDoc,
  type DispatchEdgeDoc,
  type BudgetReservationDoc,
  type JobDoc,
  type JobEventDoc,
  type JobInboxDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type TaskDoc,
  type TimerDoc,
} from './collections.js';

const TERMINAL_TASK_PHASES = new Set<TaskPhase>([
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'BLOCKED',
  'TIMED_OUT',
  'CANCELLED',
  'SUPERSEDED',
  'UNKNOWN_OUTCOME',
]);
const ACTIVE_ACTIVATION_LIFECYCLES =
  ['PENDING', 'LEASED', 'RUNNING', 'FAILED'] as const;
const DEFAULT_SCAN_LIMIT = 128;
const TERMINAL_PROBE_BASE_MS = 250;
const TERMINAL_PROBE_CAP_MS = 30_000;

export interface FlatStopScope {
  supported: boolean;
  empty: boolean;
  task: TaskDoc | null;
  blocker: string | null;
  /**
   * Every task the reduction covers (F6B).
   *
   * `[]` or `[task]` for the flat shapes, so nothing changes there. For a
   * multi-step plan whose tasks have ALL settled it is the full set, and `task`
   * stays null because there is no single root left to transition. Used to prove
   * every attempt belongs to this job's plan — what `attempt_outside_flat_root`
   * has always been guarding.
   */
  tasks: TaskDoc[];
  /** Edges to settle with the terminal commit; empty for the flat shapes. */
  edgeIds: string[];
  /**
   * The shape is one this reducer understands, but its work has not settled yet.
   *
   * Distinct from `!supported`, and the distinction is the entire fix. Marking a
   * job unsupported is a LATCH with four teeth: `cancelJob` decides it at cancel
   * time, the reducer returns early on it, and the candidate scan filters on
   * `terminalBarrierMode: 'FLAT_STOP_V1'` so a latched job is never looked at
   * again. That is correct for a shape nobody taught this code. It is wrong for a
   * cancelled multi-step plan, which is milliseconds away from qualifying and
   * whose steps are necessarily still live at the moment cancel classifies it.
   * `pending` routes to the ordinary waiting path instead: FLAT_STOP_V1 is kept,
   * a backoff probe is scheduled, and the existing machinery re-examines it.
   */
  pending: boolean;
}

export type FlatTerminalReductionStatus =
  | 'terminalized'
  | 'waiting'
  | 'blocked'
  | 'already_terminal'
  | 'not_applicable';

export interface FlatTerminalReductionResult {
  jobId: string;
  status: FlatTerminalReductionStatus;
  outcome: JobTerminalOutcome | null;
  blocker: string | null;
}

/**
 * Exact current STOP_CONTROL_RECOVERY_V1 owner. The raw reducer has no
 * unowned mutation path: production façades must first reserve, claim and start
 * this activation, then settle it in the same transaction as the reduction.
 */
export interface FlatTerminalControlAuthority {
  activationId: string;
  leaseOwner: string;
  activationFence: number;
  budgetReservationId: string;
  reducerPayloadHash: string;
}

export interface FlatTerminalOwnedCommitResult {
  reduction: FlatTerminalReductionResult;
  chargedActiveMs: number;
  refundedMs: number;
}

export class FlatTerminalAuthorityLostError extends Error {
  constructor(readonly jobId: string) {
    super(`flat terminal authority changed for ${jobId}`);
    this.name = 'FlatTerminalAuthorityLostError';
  }
}

export class FlatTerminalTransactionRequiredError extends Error {
  constructor() {
    super('flat terminal owned commit requires an active transaction');
    this.name = 'FlatTerminalTransactionRequiredError';
  }
}

function result(
  jobId: string,
  status: FlatTerminalReductionStatus,
  outcome: JobTerminalOutcome | null = null,
  blocker: string | null = null,
): FlatTerminalReductionResult {
  return { jobId, status, outcome, blocker };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pendingOutcomeSnapshotIsCompatible(
  snapshot: unknown,
  current: JobTerminalOutcome | null | undefined,
): boolean {
  return snapshot === current || current === 'UNKNOWN_OUTCOME';
}

function hasValidFlatControlBudget(job: JobDoc): boolean {
  return job.controlBudgetPolicyVersion
      === CONTROL_BUDGET_POLICY_V1.version
    && job.jobControlRecoveryReserveMs
      === CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs
    && Number.isInteger(job.jobControlRecoveryReservedMs)
    && job.jobControlRecoveryReservedMs >= 0
    && Number.isInteger(job.jobControlRecoveryConsumedMs)
    && job.jobControlRecoveryConsumedMs >= 0
    && job.jobControlRecoveryReservedMs
      + job.jobControlRecoveryConsumedMs
      <= job.jobControlRecoveryReserveMs
    && Number.isInteger(job.stopControlRecoveryAttempt)
    && job.stopControlRecoveryAttempt >= 1
    && job.stopControlRecoveryAttempt
      <= CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    && STOP_CONTROL_RECOVERY_STATES.includes(job.stopControlRecoveryState);
}

function hasExactFlatTerminalLiveReservation(
  activation: LaneActivationDoc,
  reservation: BudgetReservationDoc,
): boolean {
  return activation.businessOperationCutoffAt instanceof Date
    && activation.workDeadlineAt instanceof Date
    && activation.hardDeadlineAt instanceof Date
    && activation.businessOperationCutoffAt.getTime()
      === activation.workDeadlineAt.getTime()
    && activation.hardDeadlineAt.getTime()
      - activation.workDeadlineAt.getTime()
      === CONTROL_BUDGET_POLICY_V1.activationCommitReserveMs
    && reservation.reservedAt instanceof Date
    && reservation.activatedAt instanceof Date
    && reservation.expiresAt instanceof Date
    && reservation.settledAt === null
    && reservation.settlementReason === null
    && reservation.chargedActiveMs === 0
    && reservation.refundedMs === 0
    && reservation.reservedAt.getTime()
      <= reservation.activatedAt.getTime()
    && reservation.activatedAt.getTime()
      < reservation.expiresAt.getTime()
    && reservation.expiresAt.getTime()
      === activation.hardDeadlineAt.getTime()
    && reservation.expiresAt.getTime()
      - reservation.reservedAt.getTime()
      === CONTROL_BUDGET_POLICY_V1.activationAllotmentMs;
}

async function hasFlatTerminalControlAuthority(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  authority: FlatTerminalControlAuthority,
): Promise<boolean> {
  if (
    job.activeActivationId !== authority.activationId
    || job.activationFence !== authority.activationFence
    || job.stopControlRecoveryState !== 'ACTIVE'
    || !hasValidFlatControlBudget(job)
  ) return false;
  const activation =
    await db.collection<LaneActivationDoc>(COLLECTIONS.activations).findOne(
      {
        _id: authority.activationId,
        jobId: job._id,
        kind: 'CONTROL_RECOVERY',
        controlSubtype: 'STOP_TERMINAL',
        lifecycle: 'RUNNING',
        activeSlot: true,
        leaseOwner: authority.leaseOwner,
        activationFence: authority.activationFence,
        planVersionAtClaim: job.planVersion,
        jobStopGenerationAtClaim: job.jobStopGeneration,
        activationDispatchGenerationAtClaim:
          job.activationDispatchGeneration,
        budgetReservationId: authority.budgetReservationId,
        budgetPool: 'JOB_CONTROL_RECOVERY',
        activationActiveAllotmentMs:
          CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
        reducerPayloadHash: authority.reducerPayloadHash,
        leaseExpiresAt: { $type: 'date' },
        businessOperationCutoffAt: { $type: 'date' },
        workDeadlineAt: { $type: 'date' },
        hardDeadlineAt: { $type: 'date' },
        $expr: {
          $and: [
            { $gt: ['$leaseExpiresAt', '$$NOW'] },
            { $gt: ['$workDeadlineAt', '$$NOW'] },
            { $gt: ['$hardDeadlineAt', '$$NOW'] },
          ],
        },
      } as unknown as Filter<LaneActivationDoc>,
      { session },
    );
  if (
    !activation
    || !isRecord(activation.reducerPayload)
    || activation.reducerPayload.kind !== 'STOP_CONTROL_RECOVERY_V1'
    || activation.reducerPayload.jobId !== job._id
    || activation.reducerPayload.planVersion !== job.planVersion
    || activation.reducerPayload.jobStopGeneration !== job.jobStopGeneration
    || activation.reducerPayload.activationDispatchGeneration
      !== job.activationDispatchGeneration
    || !JOB_TERMINAL_OUTCOMES.includes(
      activation.reducerPayload
        .pendingTerminalOutcome as JobTerminalOutcome,
    )
    || !pendingOutcomeSnapshotIsCompatible(
      activation.reducerPayload.pendingTerminalOutcome,
      job.pendingTerminalOutcome,
    )
    || !PRIMARY_JOB_STOP_CAUSES.includes(
      activation.reducerPayload
        .primaryJobStopCause as PrimaryJobStopCause,
    )
    || activation.reducerPayload.primaryJobStopCause
      !== job.primaryJobStopCause
    || activation.reducerPayload.terminalBarrierMode !== 'FLAT_STOP_V1'
    || !Number.isInteger(
      activation.reducerPayload.barrierProbeAttempt,
    )
    || (activation.reducerPayload.barrierProbeAttempt as number) < 0
    || activation.reducerPayload.recoveryAttempt
      !== job.stopControlRecoveryAttempt
    || !Number.isInteger(activation.reducerPayload.recoveryAttempt)
    || (activation.reducerPayload.recoveryAttempt as number) < 1
    || (activation.reducerPayload.recoveryAttempt as number)
      > CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    || activation.reducerPayload.recoveryMaxAttempts
      !== CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    || activation.reducerPayload.budgetReservationId
      !== authority.budgetReservationId
    || !(activation.businessOperationCutoffAt instanceof Date)
    || !(activation.workDeadlineAt instanceof Date)
    || !(activation.hardDeadlineAt instanceof Date)
    || activation.businessOperationCutoffAt.getTime()
      !== activation.workDeadlineAt.getTime()
    || activation.hardDeadlineAt.getTime()
      - activation.workDeadlineAt.getTime()
      !== CONTROL_BUDGET_POLICY_V1.activationCommitReserveMs
    || canonicalHash(activation.reducerPayload) !== authority.reducerPayloadHash
  ) return false;
  const reservation =
    await db.collection<BudgetReservationDoc>(
      COLLECTIONS.budgetReservations,
    ).findOne(
      {
        _id: authority.budgetReservationId,
        jobId: job._id,
        jobStopGeneration: job.jobStopGeneration,
        activationDispatchGeneration: job.activationDispatchGeneration,
        pool: 'JOB_CONTROL_RECOVERY',
        ownerKind: 'ACTIVATION',
        ownerId: authority.activationId,
        state: 'ACTIVE',
        policyVersion: job.controlBudgetPolicyVersion,
        allotmentMs: activation.activationActiveAllotmentMs,
        reservedAt: { $type: 'date' },
        expiresAt: { $type: 'date' },
        activatedAt: { $type: 'date' },
        settledAt: null,
        chargedActiveMs: 0,
        refundedMs: 0,
        settlementReason: null,
        $expr: {
          $and: [
            { $gt: ['$expiresAt', '$$NOW'] },
            { $lte: ['$reservedAt', '$activatedAt'] },
            { $lt: ['$activatedAt', '$expiresAt'] },
            { $lte: ['$activatedAt', '$$NOW'] },
          ],
        },
      } as unknown as Filter<BudgetReservationDoc>,
      { session },
    );
  return reservation !== null
    && hasExactFlatTerminalLiveReservation(activation, reservation);
}

/**
 * Structural gate shared with the first-stop boundary. `allowEmpty` is legal
 * for the pre-plan flat slice; the reducer still proves that no orphan attempt
 * or other durable obligation exists.
 */
export async function classifyFlatStopScopeInSession(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  opts: { allowEmpty?: boolean } = {},
): Promise<FlatStopScope> {
  if (job.jobRelationMode === 'ATTACHED') {
    return {
      supported: false, empty: false, task: null,
      blocker: 'attached_job_relation', tasks: [], edgeIds: [], pending: false,
    };
  }
  const edges = await db.collection<DispatchEdgeDoc>(COLLECTIONS.edges)
    .find({ jobId: job._id }, { session })
    .toArray();
  if (edges.length > 0) {
    // F6B — a cancelled multi-step plan used to stay open forever.
    //
    // Measured before changing anything: cancel DID reach every task (parent and
    // both steps landed CANCELLED, no orphan work), but the job then sat in
    // RECONCILING with BLOCKED_UNSUPPORTED / dispatch_edge_present and an
    // operator alert, because this reducer would not pretend to settle edges it
    // did not understand. Failing closed was right; never reconsidering was not.
    //
    // Exactly ONE new shape is admitted, and only when there is nothing left to
    // decide: every task of the plan is already terminal. Anything still live
    // stays out — that is the case where this reducer genuinely cannot say how
    // the work stops.
    const planTasks = await db.collection<TaskDoc>(COLLECTIONS.tasks)
      .find({ jobId: job._id }, { session })
      .toArray();
    const planTaskIds = new Set(planTasks.map((t) => t._id));
    // EVERY edge must connect two tasks of this job. A dangling edge — one
    // naming a child that does not exist — is not a plan waiting to finish, it
    // is a topology this reducer cannot reason about at all, and its child can
    // never settle. Treating that as "not yet" would replace a loud block with
    // an infinite wait. Two existing e2e cases construct exactly that shape and
    // caught this the first time the check was missing.
    const coherent = edges.every((e) =>
      planTaskIds.has(e.parentTaskId) && planTaskIds.has(e.childTaskId));
    if (!coherent || !planTasks.every((t) => t.attemptMode === 'SERIAL')) {
      return {
        supported: false, empty: false, task: null,
        blocker: 'dispatch_edge_present', tasks: [], edgeIds: [], pending: false,
      };
    }
    if (!planTasks.every((t) => TERMINAL_TASK_PHASES.has(t.phase))) {
      // Steps are still settling: waiting, not unsupported. See `pending`.
      return {
        supported: false, empty: false, task: null,
        blocker: null, tasks: [], edgeIds: [], pending: true,
      };
    }
    return {
      supported: true, empty: false,
      // Nothing to transition — they are all terminal already.
      task: null, blocker: null,
      tasks: planTasks, edgeIds: edges.map((e) => e._id), pending: false,
    };
  }
  const attachedChild = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
    {
      parentJobId: job._id,
      jobRelationMode: 'ATTACHED',
    },
    { session, projection: { _id: 1 } },
  );
  if (attachedChild) {
    return {
      supported: false, empty: false, task: null,
      blocker: 'attached_child_present', tasks: [], edgeIds: [], pending: false,
    };
  }
  const tasks = await db.collection<TaskDoc>(COLLECTIONS.tasks)
    .find({ jobId: job._id }, { session })
    .sort({ createdAt: 1, _id: 1 })
    .limit(2)
    .toArray();
  if (tasks.length === 0 && opts.allowEmpty) {
    return {
      supported: true, empty: true, task: null, blocker: null,
      tasks: [], edgeIds: [], pending: false,
    };
  }
  if (tasks.length !== 1) {
    return {
      supported: false, empty: tasks.length === 0, task: null,
      blocker: tasks.length === 0 ? 'missing_root_task' : 'multiple_tasks',
      tasks: [], edgeIds: [], pending: false,
    };
  }
  const task = tasks[0]!;
  if (task.attemptMode !== 'SERIAL') {
    return {
      supported: false, empty: false, task,
      blocker: 'non_serial_task', tasks: [], edgeIds: [], pending: false,
    };
  }
  return {
    supported: true, empty: false, task, blocker: null,
    tasks: [task], edgeIds: [], pending: false,
  };
}

function sameReceiptOwner(
  receipt: AttemptStopReceiptDoc | AttemptProcessExitReceiptDoc,
  owner: AttemptProcessOwnerDoc,
): boolean {
  return receipt.processExecutionId === owner.processExecutionId
    && receipt.runtimeRunId === owner.runtimeRunId
    && receipt.workerInstanceId === owner.workerInstanceId
    && receipt.processOwnerGeneration === owner.ownerGeneration
    && receipt.attemptFence === owner.attemptFence
    && receipt.hostId === owner.hostId
    && receipt.hostBootId === owner.hostBootId
    && (receipt.pidNamespaceId ?? null) === (owner.pidNamespaceId ?? null)
    && receipt.pid === owner.pid
    && receipt.pgid === owner.pgid
    && (receipt.sid ?? null) === (owner.sid ?? null)
    && receipt.processStartToken === owner.processStartToken;
}

function validStopReceipt(
  attempt: AttemptDoc,
  owner: AttemptProcessOwnerDoc,
  receipt: AttemptStopReceiptDoc,
): boolean {
  return sameReceiptOwner(receipt, owner)
    && receipt.stopGeneration === (attempt.stopGeneration ?? 0)
    && attempt.attemptFence === receipt.attemptFence + 1
    && receipt.terminationConfirmed === true
    && receipt.processTreeEmpty === true
    && receipt.confirmationKind === 'PROCESS_TREE_EMPTY'
    && attempt.processState === 'EXITED'
    && attempt.processTreeEmptyAt instanceof Date
    && attempt.processTreeEmptyAt.getTime() === receipt.treeEmptyAt.getTime();
}

function validExitReceipt(
  attempt: AttemptDoc,
  owner: AttemptProcessOwnerDoc,
  receipt: AttemptProcessExitReceiptDoc,
): boolean {
  if (
    !sameReceiptOwner(receipt, owner)
    || receipt.terminationConfirmed !== true
    || receipt.processTreeEmpty !== true
    || attempt.processState !== 'EXITED'
    || !(attempt.processTreeEmptyAt instanceof Date)
    || attempt.processTreeEmptyAt.getTime() !== receipt.treeEmptyAt.getTime()
  ) return false;
  if (receipt.confirmationKind === 'NORMAL_PROCESS_TREE_EMPTY') {
    return attempt.attemptFence === receipt.attemptFence
      || (
        attempt.attemptFence === receipt.attemptFence + 1
        && attempt.outcome === 'CANCELLED'
        && attempt.reasonCode === 'user_cancel'
        && (attempt.stopGeneration ?? 0) === 0
      );
  }
  return receipt.confirmationKind === 'POST_STOP_UNKNOWN_TREE_EMPTY'
    && attempt.outcome === 'UNKNOWN_OUTCOME'
    && (attempt.stopGeneration ?? 0) > 0
    && receipt.stopGeneration === attempt.stopGeneration
    && attempt.attemptFence === receipt.attemptFence + 1;
}

type AttemptSettlement =
  | { kind: 'settled'; uncertain: boolean }
  | { kind: 'waiting'; uncertain: boolean }
  | { kind: 'invalid'; blocker: string; uncertain: boolean };

function inspectAttemptSettlement(attempt: AttemptDoc): AttemptSettlement {
  if (attempt.lifecycle !== 'FINISHED' || attempt.outcome === null) {
    return { kind: 'waiting', uncertain: false };
  }
  const owner = attempt.processOwner ?? null;
  const stopReceipt = attempt.stopReceipt ?? null;
  const exitReceipt = attempt.processExitReceipt ?? null;
  if (!owner) {
    if (stopReceipt || exitReceipt) {
      return {
        kind: 'invalid',
        blocker: 'receipt_without_process_owner',
        uncertain: true,
      };
    }
    if (attempt.outcome === 'UNKNOWN_OUTCOME') {
      const explicitUnknown =
        attempt.terminationConfirmed === false
        && attempt.leaseOwner === null
        && (attempt.stopGeneration ?? 0) > 0
        && [
          'attempt_stop_unconfirmed',
          'process_termination_unconfirmed',
        ].includes(attempt.reasonCode ?? '');
      const confirmedUnknown = attempt.terminationConfirmed === true;
      return explicitUnknown || confirmedUnknown
        ? { kind: 'settled', uncertain: true }
        : {
            kind: 'invalid',
            blocker: 'unowned_unknown_process_shape',
            uncertain: true,
          };
    }
    // No durable process lineage exists for an ordinary in-process/pre-start
    // attempt. Legacy ownerless attempts intentionally retain processState
    // UNKNOWN, so their non-UNKNOWN business result is the complete flat
    // obligation rather than evidence of an unresolved external process.
    return {
      kind: 'settled',
      uncertain: false,
    };
  }
  if (stopReceipt && exitReceipt) {
    return {
      kind: 'invalid',
      blocker: 'multiple_process_receipts',
      uncertain: true,
    };
  }
  if (attempt.terminationConfirmed === true) {
    const valid = stopReceipt
      ? validStopReceipt(attempt, owner, stopReceipt)
      : exitReceipt
        ? validExitReceipt(attempt, owner, exitReceipt)
        : false;
    return valid
      ? {
          kind: 'settled',
          uncertain: attempt.outcome === 'UNKNOWN_OUTCOME',
        }
      : {
          kind: 'invalid',
          blocker: 'invalid_process_receipt',
          uncertain: true,
        };
  }
  if (
    stopReceipt === null
    && exitReceipt === null
    && attempt.leaseOwner === null
  ) {
    // A stop-grace/reaper UNKNOWN is the encoded reconciliation-exhaustion
    // policy. Result-first A may also be FINISHED with an unconfirmed process;
    // cancel pins pending UNKNOWN and an immediate stopGraceDueAt for that case.
    return { kind: 'settled', uncertain: true };
  }
  return { kind: 'waiting', uncertain: true };
}

function mappedTaskPhase(
  cause: PrimaryJobStopCause,
  effectiveOutcome: JobTerminalOutcome,
): TaskPhase {
  if (effectiveOutcome === 'UNKNOWN_OUTCOME') return 'UNKNOWN_OUTCOME';
  if (cause === 'goal_satisfied' || cause === 'partial_accepted') {
    return 'SUPERSEDED';
  }
  if (cause === 'user_cancel' || cause === 'operator_stop') return 'CANCELLED';
  if (cause === 'job_deadline' || cause === 'active_budget_exhausted') {
    return 'TIMED_OUT';
  }
  if (cause === 'terminal_blocked') return 'BLOCKED';
  if (
    cause === 'reconciliation_exhausted'
    || cause === 'unknown_outcome_accepted'
  ) return 'UNKNOWN_OUTCOME';
  return 'FAILED';
}

async function unknownPolicyIsDue(
  db: Db,
  session: ClientSession,
  job: JobDoc,
): Promise<boolean> {
  return Boolean(await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
    {
      _id: job._id,
      stateVersion: job.stateVersion,
      stopGraceDueAt: { $type: 'date' },
      $expr: { $lte: ['$stopGraceDueAt', '$$NOW'] },
    } as unknown as Filter<JobDoc>,
    { session, projection: { _id: 1 } },
  ));
}

async function persistUnsupportedBarrier(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  blocker: string,
  authority: FlatTerminalControlAuthority,
): Promise<FlatTerminalReductionResult> {
  const blockedAt = new Date();
  const update = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
    {
      _id: job._id,
      stateVersion: job.stateVersion,
      terminalOutcome: null,
      controlState: 'STOP_REQUESTED',
      jobStopGeneration: job.jobStopGeneration,
      activeActivationId: authority.activationId,
      activationFence: authority.activationFence,
    },
    {
      $set: {
        terminalBarrierMode: 'BLOCKED_UNSUPPORTED',
        terminalBarrierBlocker: blocker,
        terminalBarrierNextCheckAt: null,
        updatedAt: blockedAt,
      },
      $inc: { stateVersion: 1 },
    },
    { session },
  );
  if (update.modifiedCount !== 1) {
    throw new FlatTerminalAuthorityLostError(job._id);
  }
  const alertId =
    `obx_terminal_barrier_blocked:${job._id}:${job.jobStopGeneration}`;
  await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
    { _id: alertId },
    {
      $setOnInsert: {
        _id: alertId,
        aggregate: job._id,
        type: 'OperatorAlertRequested',
        state: 'PENDING',
        payload: {
          alertType: 'terminal_barrier_unsupported',
          resourceId: job.resourceId,
          conversationId: job.conversationId,
          jobId: job._id,
          jobStopGeneration: job.jobStopGeneration,
          blocker,
        },
        createdAt: blockedAt,
      },
    },
    { session, upsert: true },
  );
  return result(job._id, 'blocked', null, blocker);
}

async function scheduleWaitingProbe(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  authority: FlatTerminalControlAuthority,
): Promise<void> {
  const probeAttempt = Math.max(0, job.terminalBarrierProbeAttempt ?? 0);
  const delayMs = Math.min(
    TERMINAL_PROBE_CAP_MS,
    TERMINAL_PROBE_BASE_MS * 2 ** Math.min(probeAttempt, 7),
  );
  const update = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
    {
      _id: job._id,
      stateVersion: job.stateVersion,
      terminalOutcome: null,
      controlState: 'STOP_REQUESTED',
      jobStopGeneration: job.jobStopGeneration,
      activeActivationId: authority.activationId,
      activationFence: authority.activationFence,
    },
    [{
      $set: {
        terminalBarrierMode: 'FLAT_STOP_V1',
        terminalBarrierNextCheckAt: {
          $max: [
            {
              $dateAdd: {
                startDate: '$$NOW',
                unit: 'millisecond',
                amount: delayMs,
              },
            },
            {
              $cond: [
                { $eq: [{ $type: '$stopGraceDueAt' }, 'date'] },
                '$stopGraceDueAt',
                '$$NOW',
              ],
            },
          ],
        },
        terminalBarrierProbeAttempt: { $add: [probeAttempt, 1] },
      },
    }],
    { session },
  );
  if (update.matchedCount !== 1) {
    throw new FlatTerminalAuthorityLostError(job._id);
  }
}

async function waiting(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  scheduleProbe: boolean,
  authority: FlatTerminalControlAuthority,
): Promise<FlatTerminalReductionResult> {
  if (scheduleProbe) {
    await scheduleWaitingProbe(db, session, job, authority);
  }
  return result(job._id, 'waiting');
}

/**
 * Re-check and apply one flat pending terminal barrier in an existing
 * transaction under the exact RUNNING STOP_CONTROL_RECOVERY_V1 authority.
 * The caller must settle that activation and its reservation before the same
 * transaction commits.
 */
async function reducePendingFlatTerminalOwnedInSession(
  db: Db,
  session: ClientSession,
  jobId: string,
  opts: {
    scheduleProbe?: boolean;
    controlAuthority?: FlatTerminalControlAuthority;
  } = {},
): Promise<FlatTerminalReductionResult> {
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const job = await jobs.findOne({ _id: jobId }, { session });
  if (!job) return result(jobId, 'not_applicable');
  if (job.terminalOutcome !== null) {
    return result(jobId, 'already_terminal', job.terminalOutcome);
  }
  if (
    job.controlState !== 'STOP_REQUESTED'
    || job.phase !== 'RECONCILING'
    || !job.pendingTerminalOutcome
    || !job.primaryJobStopCause
    || job.jobStopGeneration <= 0
  ) return result(jobId, 'not_applicable');
  const authority = opts.controlAuthority;
  if (
    !authority
    || !await hasFlatTerminalControlAuthority(db, session, job, authority)
  ) {
    return result(jobId, 'not_applicable');
  }
  if (job.terminalBarrierMode === 'BLOCKED_UNSUPPORTED') {
    return result(
      jobId,
      'blocked',
      null,
      job.terminalBarrierBlocker ?? 'unsupported_flat_terminal_shape',
    );
  }

  const scope = await classifyFlatStopScopeInSession(
    db,
    session,
    job,
    { allowEmpty: true },
  );
  if (scope.pending) {
    // Known shape, work still settling — the ordinary waiting path, with the
    // existing backoff probe. Latching here is what stranded cancelled plans.
    return waiting(db, session, job, opts.scheduleProbe === true, authority);
  }
  if (!scope.supported) {
    return persistUnsupportedBarrier(
      db,
      session,
      job,
      scope.blocker ?? 'unsupported_flat_terminal_shape',
      authority,
    );
  }
  const task = scope.task;
  const liveActivation =
    await db.collection<LaneActivationDoc>(COLLECTIONS.activations).findOne(
      {
        jobId,
        _id: { $ne: authority.activationId },
        $or: [
          { activeSlot: true },
          { lifecycle: { $in: [...ACTIVE_ACTIVATION_LIFECYCLES] } },
        ],
      },
      { session, projection: { _id: 1 } },
    );
  if (liveActivation) {
    return waiting(
      db,
      session,
      job,
      opts.scheduleProbe === true,
      authority,
    );
  }
  const openRequest =
    await db.collection<ControlRequestDoc>(COLLECTIONS.requests).findOne(
      { jobId, state: 'OPEN' },
      { session, projection: { _id: 1 } },
    );
  if (openRequest) {
    return waiting(
      db,
      session,
      job,
      opts.scheduleProbe === true,
      authority,
    );
  }
  const pendingTimer = await db.collection<TimerDoc>(COLLECTIONS.timers).findOne(
    { jobId, state: 'PENDING' },
    { session, projection: { _id: 1 } },
  );
  if (pendingTimer) {
    return waiting(
      db,
      session,
      job,
      opts.scheduleProbe === true,
      authority,
    );
  }
  const pendingWake = await db.collection<OutboxDoc>(COLLECTIONS.outbox).findOne(
    {
      aggregate: jobId,
      type: 'LaneWakeRequested',
      state: 'PENDING',
    },
    { session, projection: { _id: 1 } },
  );
  if (pendingWake) {
    return waiting(
      db,
      session,
      job,
      opts.scheduleProbe === true,
      authority,
    );
  }

  const inbox = await db.collection<JobInboxDoc>(COLLECTIONS.inbox)
    .find({ jobId }, { session })
    .sort({ inboxSequence: 1 })
    .toArray();
  const inboxDense =
    Number.isInteger(job.inboxHighWatermark)
    && job.inboxHighWatermark >= 0
    && job.resolvedInboxWatermark === job.inboxHighWatermark
    && inbox.length === job.inboxHighWatermark
    && inbox.every((item, index) => item.inboxSequence === index + 1);
  const inboxResolved = inbox.every((item) =>
    item.state === 'APPLIED'
    || item.state === 'DEDUPED'
    || (
      item.state === 'REJECTED_STALE'
      && item.resolutionCode === 'job_cancelled'
      && item.resolvedAt instanceof Date
      && item.retryTimerId === null
      && item.nextEligibleAt === null
    ));
  if (!inboxDense) {
    return persistUnsupportedBarrier(
      db,
      session,
      job,
      'inbox_watermark_mismatch',
      authority,
    );
  }
  if (!inboxResolved) {
    return persistUnsupportedBarrier(
      db,
      session,
      job,
      'unresolved_inbox_obligation',
      authority,
    );
  }

  const attempts = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
    .find({ jobId }, { session })
    .sort({ attemptNumber: 1, _id: 1 })
    .toArray();
  // Every attempt must belong to a task this reduction covers: the single root
  // for the flat shape, any step for a settled plan. An attempt outside it is
  // work this reducer cannot account for, which is what the guard is about.
  const coveredTaskIds = new Set(scope.tasks.map((t) => t._id));
  if (attempts.some((attempt) => !coveredTaskIds.has(attempt.taskId))) {
    return persistUnsupportedBarrier(
      db,
      session,
      job,
      'attempt_outside_flat_root',
      authority,
    );
  }
  let uncertain = job.pendingTerminalOutcome === 'UNKNOWN_OUTCOME'
    || task?.phase === 'UNKNOWN_OUTCOME';
  for (const attempt of attempts) {
    const settlement = inspectAttemptSettlement(attempt);
    uncertain ||= settlement.uncertain
      || attempt.outcome === 'UNKNOWN_OUTCOME';
    if (settlement.kind === 'invalid') {
      return persistUnsupportedBarrier(
        db,
        session,
        job,
        settlement.blocker,
        authority,
      );
    }
    if (settlement.kind === 'waiting') {
      return waiting(
        db,
        session,
        job,
        opts.scheduleProbe === true,
        authority,
      );
    }
  }
  if (
    uncertain
    && !await unknownPolicyIsDue(db, session, job)
  ) {
    return waiting(
      db,
      session,
      job,
      opts.scheduleProbe === true,
      authority,
    );
  }

  const effectiveOutcome: JobTerminalOutcome = uncertain
    ? 'UNKNOWN_OUTCOME'
    : job.pendingTerminalOutcome;
  const nextTaskPhase = task
    ? TERMINAL_TASK_PHASES.has(task.phase)
      ? task.phase
      : mappedTaskPhase(job.primaryJobStopCause, effectiveOutcome)
    : null;
  const committedAt = new Date();
  if (task && nextTaskPhase) {
    const taskUpdate = await db.collection<TaskDoc>(COLLECTIONS.tasks).updateOne(
      {
        _id: task._id,
        jobId,
        phase: task.phase,
        controlState: task.controlState,
        activeAttemptId: task.activeAttemptId ?? null,
      },
      {
        $set: {
          phase: nextTaskPhase,
          ...(TERMINAL_TASK_PHASES.has(task.phase)
            ? {}
            : { controlState: 'STOP_REQUESTED' as const }),
          activeAttemptId: null,
          businessPayloadReadyAttemptId: null,
          businessPayloadReadyGeneration: 0,
          pendingResultId: null,
          retryNotBefore: null,
          updatedAt: committedAt,
        },
        ...(
          !TERMINAL_TASK_PHASES.has(task.phase)
          && task.controlState !== 'STOP_REQUESTED'
            ? { $inc: { stopGeneration: 1 } }
            : {}
        ),
      },
      { session },
    );
    if (taskUpdate.matchedCount !== 1) {
      throw new FlatTerminalAuthorityLostError(jobId);
    }
  }

  // F6B: settle the plan's edges in the SAME transaction as the terminal. An
  // ACTIVE edge next to a terminal job is an obligation nobody will discharge —
  // `resolveParentTask` looks for exactly those.
  if (scope.edgeIds.length > 0) {
    await db.collection<DispatchEdgeDoc>(COLLECTIONS.edges).updateMany(
      { _id: { $in: scope.edgeIds }, jobId, lifecycle: 'ACTIVE' },
      { $set: { lifecycle: 'SETTLED' } },
      { session },
    );
  }

  const terminal = await jobs.updateOne(
    {
      _id: jobId,
      stateVersion: job.stateVersion,
      phase: 'RECONCILING',
      controlState: 'STOP_REQUESTED',
      terminalOutcome: null,
      pendingTerminalOutcome: job.pendingTerminalOutcome,
      primaryJobStopCause: job.primaryJobStopCause,
      jobStopGeneration: job.jobStopGeneration,
      activeActivationId: authority.activationId,
      activationFence: authority.activationFence,
    },
    {
      $set: {
        phase: 'TERMINAL',
        terminalOutcome: effectiveOutcome,
        pendingTerminalOutcome: null,
        stopGraceDueAt: null,
        terminalBarrierMode: 'FLAT_STOP_V1',
        terminalBarrierBlocker: null,
        terminalBarrierNextCheckAt: null,
        terminalBarrierProbeAttempt: 0,
        updatedAt: committedAt,
      },
      $inc: { stateVersion: 1 },
    },
    { session },
  );
  if (terminal.modifiedCount !== 1) {
    throw new FlatTerminalAuthorityLostError(jobId);
  }

  const last = await db.collection<JobEventDoc>(COLLECTIONS.events)
    .find({ jobId }, { session })
    .sort({ sequence: -1 })
    .limit(1)
    .next();
  const sequence = (last?.sequence ?? -1) + 1;
  await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
    _id: `${jobId}:${sequence}`,
    jobId,
    sequence,
    type: 'JobTerminalized',
    payload: {
      terminalOutcome: effectiveOutcome,
      pendingTerminalOutcome: job.pendingTerminalOutcome,
      primaryJobStopCause: job.primaryJobStopCause,
      jobStopGeneration: job.jobStopGeneration,
      terminalBarrierMode: 'FLAT_STOP_V1',
    },
    createdAt: committedAt,
  }, { session });
  const terminalOutboxId =
    `obx_job_terminal:${jobId}:${job.jobStopGeneration}`;
  const terminalOutbox = await db.collection<OutboxDoc>(COLLECTIONS.outbox)
    .updateOne(
      { _id: terminalOutboxId },
      {
        $setOnInsert: {
          _id: terminalOutboxId,
          aggregate: jobId,
          type: 'JobTerminal',
          state: 'PENDING',
          payload: {
            resourceId: job.resourceId,
            conversationId: job.conversationId,
            jobId,
            terminalOutcome: effectiveOutcome,
            primaryJobStopCause: job.primaryJobStopCause,
            jobStopGeneration: job.jobStopGeneration,
          },
          createdAt: committedAt,
        },
      },
      { session, upsert: true },
    );
  if (terminalOutbox.upsertedCount !== 1) {
    throw new FlatTerminalAuthorityLostError(jobId);
  }
  return result(jobId, 'terminalized', effectiveOutcome);
}

function activationOutcomeForReduction(
  reduction: FlatTerminalReductionResult,
): string {
  if (reduction.status === 'terminalized') {
    return `TERMINALIZED:${reduction.outcome}`;
  }
  if (reduction.status === 'blocked') return 'BLOCKED_UNSUPPORTED';
  return 'WAITING';
}

/**
 * The sole in-session mutation boundary for a pending flat terminal decision.
 *
 * Reduction and control-owner accounting are deliberately inseparable here:
 * every task/job/event/outbox write either commits together with activation
 * COMMITTED, reservation SETTLED and the released job slot, or the caller's
 * transaction aborts in full.
 */
export async function commitPendingFlatTerminalWithControlInSession(
  db: Db,
  session: ClientSession,
  jobId: string,
  authority: FlatTerminalControlAuthority,
): Promise<FlatTerminalOwnedCommitResult | null> {
  if (!session.inTransaction()) {
    throw new FlatTerminalTransactionRequiredError();
  }
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const before = await jobs.findOne({ _id: jobId }, { session });
  if (
    !before
    || before.terminalOutcome !== null
    || before.controlState !== 'STOP_REQUESTED'
    || before.phase !== 'RECONCILING'
    || !before.pendingTerminalOutcome
    || !before.primaryJobStopCause
    || before.jobStopGeneration <= 0
    || before.activeActivationId !== authority.activationId
    || before.activationFence !== authority.activationFence
    || before.stopControlRecoveryState !== 'ACTIVE'
    || before.jobControlRecoveryReservedMs
      !== CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
  ) return null;

  const reduction = await reducePendingFlatTerminalOwnedInSession(
    db,
    session,
    jobId,
    { scheduleProbe: true, controlAuthority: authority },
  );
  if (
    reduction.status === 'not_applicable'
    || reduction.status === 'already_terminal'
  ) return null;

  const afterReduction = await jobs.findOne(
    {
      _id: jobId,
      activeActivationId: authority.activationId,
      activationFence: authority.activationFence,
      planVersion: before.planVersion,
      jobStopGeneration: before.jobStopGeneration,
      activationDispatchGeneration: before.activationDispatchGeneration,
      stopControlRecoveryAttempt: before.stopControlRecoveryAttempt,
      stopControlRecoveryState: 'ACTIVE',
      jobControlRecoveryReservedMs:
        CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
    },
    { session },
  );
  if (!afterReduction) {
    throw new FlatTerminalAuthorityLostError(jobId);
  }

  const settled = await db.collection<BudgetReservationDoc>(
    COLLECTIONS.budgetReservations,
  ).findOneAndUpdate(
    {
      _id: authority.budgetReservationId,
      jobId,
      jobStopGeneration: before.jobStopGeneration,
      activationDispatchGeneration: before.activationDispatchGeneration,
      pool: 'JOB_CONTROL_RECOVERY',
      ownerKind: 'ACTIVATION',
      ownerId: authority.activationId,
      policyVersion: CONTROL_BUDGET_POLICY_V1.version,
      state: 'ACTIVE',
      allotmentMs: CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
      reservedAt: { $type: 'date' },
      expiresAt: { $type: 'date' },
      activatedAt: { $type: 'date' },
      settledAt: null,
      chargedActiveMs: 0,
      refundedMs: 0,
      settlementReason: null,
      $expr: {
        $and: [
          { $gt: ['$expiresAt', '$$NOW'] },
          { $lte: ['$reservedAt', '$activatedAt'] },
          { $lte: ['$activatedAt', '$$NOW'] },
        ],
      },
    } as unknown as Filter<BudgetReservationDoc>,
    [
      {
        $set: {
          chargedActiveMs: {
            $min: [
              '$allotmentMs',
              {
                $max: [
                  0,
                  { $subtract: ['$$NOW', '$activatedAt'] },
                ],
              },
            ],
          },
          state: 'SETTLED',
          settledAt: '$$NOW',
          settlementReason: 'COMMITTED',
        },
      },
      {
        $set: {
          refundedMs: {
            $subtract: ['$allotmentMs', '$chargedActiveMs'],
          },
        },
      },
    ],
    { session, returnDocument: 'after' },
  );
  if (!settled?.settledAt) {
    throw new FlatTerminalAuthorityLostError(jobId);
  }

  const committed = await db.collection<LaneActivationDoc>(
    COLLECTIONS.activations,
  ).findOneAndUpdate(
    {
      _id: authority.activationId,
      jobId,
      kind: 'CONTROL_RECOVERY',
      controlSubtype: 'STOP_TERMINAL',
      lifecycle: 'RUNNING',
      activeSlot: true,
      leaseOwner: authority.leaseOwner,
      activationFence: authority.activationFence,
      planVersionAtClaim: before.planVersion,
      jobStopGenerationAtClaim: before.jobStopGeneration,
      activationDispatchGenerationAtClaim:
        before.activationDispatchGeneration,
      reducerPayloadHash: authority.reducerPayloadHash,
      budgetReservationId: authority.budgetReservationId,
      budgetPool: 'JOB_CONTROL_RECOVERY',
      activationActiveAllotmentMs:
        CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
      $expr: {
        $and: [
          { $gt: ['$leaseExpiresAt', '$$NOW'] },
          { $gt: ['$workDeadlineAt', '$$NOW'] },
          { $gt: ['$hardDeadlineAt', '$$NOW'] },
        ],
      },
    } as unknown as Filter<LaneActivationDoc>,
    [{
      $set: {
        lifecycle: 'COMMITTED',
        activeSlot: false,
        leaseOwner: null,
        leaseExpiresAt: null,
        committedPayloadHash: authority.reducerPayloadHash,
        committedAt: { $literal: settled.settledAt },
        outcome: activationOutcomeForReduction(reduction),
        reasonCode: reduction.blocker,
        updatedAt: { $literal: settled.settledAt },
      },
    }],
    { session, returnDocument: 'after' },
  );
  if (!committed?.committedAt) {
    throw new FlatTerminalAuthorityLostError(jobId);
  }

  const jobSettlement = await jobs.updateOne(
    {
      _id: jobId,
      stateVersion: afterReduction.stateVersion,
      activeActivationId: authority.activationId,
      activationFence: authority.activationFence,
      planVersion: before.planVersion,
      jobStopGeneration: before.jobStopGeneration,
      activationDispatchGeneration: before.activationDispatchGeneration,
      stopControlRecoveryAttempt: before.stopControlRecoveryAttempt,
      stopControlRecoveryState: 'ACTIVE',
      jobControlRecoveryReservedMs: settled.allotmentMs,
    },
    [{
      $set: {
        activeActivationId: null,
        stopControlRecoveryAttempt: 0,
        stopControlRecoveryState: reduction.status === 'waiting'
          ? 'WAITING'
          : 'IDLE',
        jobControlRecoveryReservedMs: 0,
        jobControlRecoveryConsumedMs: {
          $add: ['$jobControlRecoveryConsumedMs', settled.chargedActiveMs],
        },
        stateVersion: { $add: ['$stateVersion', 1] },
        updatedAt: { $literal: settled.settledAt },
      },
    }],
    { session },
  );
  if (jobSettlement.modifiedCount !== 1) {
    throw new FlatTerminalAuthorityLostError(jobId);
  }

  // Ordered readers historically expect JobTerminalized to remain the final
  // domain event. Terminal settlement is already explicit on owner+reservation.
  if (reduction.status !== 'terminalized') {
    const last = await db.collection<JobEventDoc>(COLLECTIONS.events)
      .find({ jobId }, { session })
      .sort({ sequence: -1 })
      .limit(1)
      .next();
    const sequence = (last?.sequence ?? -1) + 1;
    await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
      _id: `${jobId}:${sequence}`,
      jobId,
      sequence,
      type: 'StopControlRecoverySettled',
      payload: {
        activationId: authority.activationId,
        budgetReservationId: authority.budgetReservationId,
        reductionStatus: reduction.status,
        terminalOutcome: reduction.outcome,
        blocker: reduction.blocker,
        chargedActiveMs: settled.chargedActiveMs,
        refundedMs: settled.refundedMs,
      },
      createdAt: settled.settledAt,
    }, { session });
  }

  return {
    reduction,
    chargedActiveMs: settled.chargedActiveMs,
    refundedMs: settled.refundedMs,
  };
}

/** Standalone one-job boundary. */
export async function reducePendingFlatTerminal(
  client: MongoClient,
  db: Db,
  jobId: string,
): Promise<FlatTerminalReductionResult> {
  const { reducePendingFlatTerminalThroughControl } =
    await import('./stop-control-recovery.js');
  return reducePendingFlatTerminalThroughControl(client, db, jobId);
}

/**
 * Bounded crash-recovery scan. Unsupported jobs are classified once and then
 * excluded; waiting flat jobs receive a durable exponential next-probe time.
 */
export async function reconcilePendingFlatTerminals(
  client: MongoClient,
  db: Db,
  opts: { limit?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? DEFAULT_SCAN_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('flat terminal scan limit must be a positive integer');
  }
  const {
    materializeDueStopControlRecoveries,
    drainStopControlRecovery,
  } = await import('./stop-control-recovery.js');
  await materializeDueStopControlRecoveries(client, db, { limit });
  const drained = await drainStopControlRecovery(client, db, { limit });
  return drained.terminalized;
}
