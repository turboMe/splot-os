/**
 * PR-40 — typed STOP_CONTROL_RECOVERY_V1 terminal owner.
 *
 * A pending flat stop is never reduced by an unowned store call. One
 * CONTROL_RECOVERY activation reserves the job-local control pool, claims a
 * fenced lease and runs FLAT_STOP_V1 without business work. Terminal/task/event
 * writes, activation COMMITTED, slot release and reservation settlement share
 * one Mongo transaction. Lost owners are replaced at most three times; corrupt
 * authority, retry exhaustion or reserve exhaustion stays visibly nonterminal
 * with one durable operator alert.
 */
import { randomUUID } from 'node:crypto';
import type {
  ClientSession,
  Db,
  Filter,
  MongoClient,
} from 'mongodb';
import type {
  JobTerminalOutcome,
  PrimaryJobStopCause,
} from '../contracts/index.js';
import { canonicalHash, runTxn } from './txn.js';
import {
  BUDGET_RESERVATION_STATES,
  COLLECTIONS,
  CONTROL_BUDGET_POLICY_V1,
  hasExactBudgetReservationSettlement,
  STOP_CONTROL_RECOVERY_STATES,
  type BudgetReservationDoc,
  type BudgetSettlementReason,
  type JobDoc,
  type JobEventDoc,
  type LaneActivationDoc,
  type OutboxDoc,
} from './collections.js';
import {
  commitPendingFlatTerminalWithControlInSession,
  FlatTerminalAuthorityLostError,
  type FlatTerminalControlAuthority,
  type FlatTerminalReductionResult,
  type FlatTerminalReductionStatus,
} from './flat-terminal-barrier.js';

const STOP_CONTROL_FALLBACK_SCAN_LIMIT = 32;
const DEFAULT_STOP_CONTROL_SCAN_LIMIT = 128;
const DEFAULT_STOP_CONTROL_DRAIN_LIMIT = 128;
const DEFAULT_STOP_CONTROL_REAP_LIMIT = 128;
const MAX_AUTHORITY_RETRIES_PER_TICK = 32;
const ACTIVE_STOP_CONTROL_LIFECYCLES:
  LaneActivationDoc['lifecycle'][] = [
    'PENDING',
    'LEASED',
    'RUNNING',
    'FAILED',
  ];

export interface StopControlRecoveryPayloadV1
  extends Record<string, unknown> {
  kind: 'STOP_CONTROL_RECOVERY_V1';
  jobId: string;
  planVersion: number;
  jobStopGeneration: number;
  activationDispatchGeneration: number;
  pendingTerminalOutcome: JobTerminalOutcome;
  primaryJobStopCause: PrimaryJobStopCause;
  terminalBarrierMode: 'FLAT_STOP_V1';
  barrierProbeAttempt: number;
  recoveryAttempt: number;
  recoveryMaxAttempts: number;
  budgetReservationId: string;
}

export interface StopControlMaterializationResult {
  jobId: string;
  activationId: string;
  budgetReservationId: string;
  created: boolean;
}

export interface StopControlRecoveryLeaseHandle {
  activationId: string;
  jobId: string;
  leaseOwner: string;
  activationFence: number;
  leaseExpiresAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
  budgetReservationId: string;
}

export interface StopControlRecoveryCommitResult {
  activationId: string;
  jobId: string;
  budgetReservationId: string;
  reduction: FlatTerminalReductionResult;
  chargedActiveMs: number;
  refundedMs: number;
  deduped: boolean;
}

export interface StopControlRecoveryDrainResult {
  claimed: number;
  committed: number;
  terminalized: number;
  waiting: number;
  blocked: number;
}

class StopControlRecoveryAuthorityLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StopControlRecoveryAuthorityLostError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TERMINAL_OUTCOMES = new Set<JobTerminalOutcome>([
  'COMPLETED',
  'PARTIAL',
  'BLOCKED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'UNKNOWN_OUTCOME',
]);
const STOP_CAUSES = new Set<PrimaryJobStopCause>([
  'user_cancel',
  'job_deadline',
  'active_budget_exhausted',
  'operator_stop',
  'goal_satisfied',
  'partial_accepted',
  'terminal_failure',
  'terminal_blocked',
  'reconciliation_exhausted',
  'unknown_outcome_accepted',
]);

export function parseStopControlRecoveryPayload(
  value: unknown,
): StopControlRecoveryPayloadV1 | null {
  if (!isRecord(value) || value.kind !== 'STOP_CONTROL_RECOVERY_V1') {
    return null;
  }
  if (
    typeof value.jobId !== 'string'
    || value.jobId.length === 0
    || !Number.isInteger(value.planVersion)
    || (value.planVersion as number) < 0
    || !Number.isInteger(value.jobStopGeneration)
    || (value.jobStopGeneration as number) <= 0
    || !Number.isInteger(value.activationDispatchGeneration)
    || (value.activationDispatchGeneration as number) < 0
    || !TERMINAL_OUTCOMES.has(
      value.pendingTerminalOutcome as JobTerminalOutcome,
    )
    || !STOP_CAUSES.has(value.primaryJobStopCause as PrimaryJobStopCause)
    || value.terminalBarrierMode !== 'FLAT_STOP_V1'
    || !Number.isInteger(value.barrierProbeAttempt)
    || (value.barrierProbeAttempt as number) < 0
    || !Number.isInteger(value.recoveryAttempt)
    || (value.recoveryAttempt as number) < 1
    || (value.recoveryAttempt as number)
      > CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    || value.recoveryMaxAttempts
      !== CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    || typeof value.budgetReservationId !== 'string'
    || value.budgetReservationId.length === 0
  ) return null;
  return value as StopControlRecoveryPayloadV1;
}

function controlWindow(at: Date): {
  businessOperationCutoffAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
} {
  const hardDeadlineAt = new Date(
    at.getTime() + CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
  );
  const workDeadlineAt = new Date(
    hardDeadlineAt.getTime()
      - CONTROL_BUDGET_POLICY_V1.activationCommitReserveMs,
  );
  return {
    // STOP control has no business phase. The common field is pinned to the
    // reducer deadline so generic readers cannot infer business permission.
    businessOperationCutoffAt: workDeadlineAt,
    workDeadlineAt,
    hardDeadlineAt,
  };
}

function stopOwnerPrefix(
  jobId: string,
  jobStopGeneration: number,
  barrierProbeAttempt: number,
  recoveryAttempt: number,
  activationDispatchGeneration: number,
): string {
  return [
    jobId,
    jobStopGeneration,
    barrierProbeAttempt,
    recoveryAttempt,
    activationDispatchGeneration,
  ].join(':');
}

function stopActivationId(
  jobId: string,
  jobStopGeneration: number,
  barrierProbeAttempt: number,
  recoveryAttempt: number,
  activationDispatchGeneration: number,
): string {
  return `act_stop_control:${stopOwnerPrefix(
    jobId,
    jobStopGeneration,
    barrierProbeAttempt,
    recoveryAttempt,
    activationDispatchGeneration,
  )}`;
}

function stopReservationId(
  jobId: string,
  jobStopGeneration: number,
  barrierProbeAttempt: number,
  recoveryAttempt: number,
  activationDispatchGeneration: number,
): string {
  return `bres_stop_control:${stopOwnerPrefix(
    jobId,
    jobStopGeneration,
    barrierProbeAttempt,
    recoveryAttempt,
    activationDispatchGeneration,
  )}`;
}

function stopWakeId(activationId: string): string {
  return `obx_stop_control:${activationId}`;
}

async function nextEventSeq(
  db: Db,
  jobId: string,
  session: ClientSession,
): Promise<number> {
  const last = await db.collection<JobEventDoc>(COLLECTIONS.events)
    .find({ jobId }, { session })
    .sort({ sequence: -1 })
    .limit(1)
    .next();
  return (last?.sequence ?? -1) + 1;
}

function validControlBudget(job: JobDoc): boolean {
  return job.controlBudgetPolicyVersion
      === CONTROL_BUDGET_POLICY_V1.version
    && Number.isInteger(job.jobControlRecoveryReserveMs)
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
    && job.stopControlRecoveryAttempt >= 0
    && job.stopControlRecoveryAttempt
      <= CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    && STOP_CONTROL_RECOVERY_STATES.includes(job.stopControlRecoveryState);
}

function availableControlBudget(job: JobDoc): number {
  return job.jobControlRecoveryReserveMs
    - job.jobControlRecoveryReservedMs
    - job.jobControlRecoveryConsumedMs;
}

function pendingOutcomeSnapshotIsCompatible(
  snapshot: JobTerminalOutcome,
  current: JobTerminalOutcome | null | undefined,
): boolean {
  return current === snapshot || current === 'UNKNOWN_OUTCOME';
}

function stopActivationMatchesJob(
  activation: LaneActivationDoc,
  payload: StopControlRecoveryPayloadV1,
  job: JobDoc,
): boolean {
  return validControlBudget(job)
    && activation.kind === 'CONTROL_RECOVERY'
    && activation.controlSubtype === 'STOP_TERMINAL'
    && activation.activeSlot
    && ACTIVE_STOP_CONTROL_LIFECYCLES.includes(activation.lifecycle)
    && activation.jobId === job._id
    && activation.planVersionAtClaim === job.planVersion
    && activation.jobStopGenerationAtClaim === job.jobStopGeneration
    && activation.activationDispatchGenerationAtClaim
      === job.activationDispatchGeneration
    && payload.jobId === job._id
    && payload.planVersion === job.planVersion
    && payload.jobStopGeneration === job.jobStopGeneration
    && payload.activationDispatchGeneration
      === job.activationDispatchGeneration
    // UNKNOWN is the universal monotonic override. A timer/process fact may
    // conservatively widen CANCELLED→UNKNOWN after this owner was materialized;
    // the same owner remains valid and the reducer reads the current job truth.
    && pendingOutcomeSnapshotIsCompatible(
      payload.pendingTerminalOutcome,
      job.pendingTerminalOutcome,
    )
    && payload.primaryJobStopCause === job.primaryJobStopCause
    && payload.terminalBarrierMode === 'FLAT_STOP_V1'
    && payload.recoveryAttempt === job.stopControlRecoveryAttempt
    && activation.budgetReservationId === payload.budgetReservationId
    && activation.budgetPool === 'JOB_CONTROL_RECOVERY'
    && activation.activationActiveAllotmentMs
      === CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
    && activation.reducerPayloadHash === canonicalHash(payload);
}

type StopControlAdmissionFailure =
  | 'control_recovery_reserve_exhausted'
  | 'control_recovery_policy_invalid';

async function persistAdmissionFailureInSession(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  reasonCode: StopControlAdmissionFailure,
): Promise<void> {
  const exhausted = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .findOneAndUpdate(
      {
        _id: job._id,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: 'STOP_REQUESTED',
        phase: 'RECONCILING',
        pendingTerminalOutcome: job.pendingTerminalOutcome,
        jobStopGeneration: job.jobStopGeneration,
        activeActivationId: null,
        stopControlRecoveryState: { $ne: 'EXHAUSTED' },
      },
      [{
        $set: {
          stopControlRecoveryState: 'EXHAUSTED',
          terminalBarrierBlocker: reasonCode,
          terminalBarrierNextCheckAt: null,
          stateVersion: { $add: ['$stateVersion', 1] },
          updatedAt: '$$NOW',
        },
      }],
      { session, returnDocument: 'after' },
    );
  if (!exhausted) return;
  const alertId =
    `obx_stop_control_alert:${job._id}:${job.jobStopGeneration}`;
  await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
    { _id: alertId },
    {
      $setOnInsert: {
        _id: alertId,
        aggregate: job._id,
        type: 'OperatorAlertRequested',
        state: 'PENDING',
        payload: {
          alertType: reasonCode,
          resourceId: job.resourceId,
          conversationId: job.conversationId,
          jobId: job._id,
          jobStopGeneration: job.jobStopGeneration,
          controlBudgetPolicyVersion: job.controlBudgetPolicyVersion,
          reserveMs: job.jobControlRecoveryReserveMs,
          reservedMs: job.jobControlRecoveryReservedMs,
          consumedMs: job.jobControlRecoveryConsumedMs,
        },
        createdAt: exhausted.updatedAt,
      },
    },
    { session, upsert: true },
  );
  const sequence = await nextEventSeq(db, job._id, session);
  await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
    _id: `${job._id}:${sequence}`,
    jobId: job._id,
    sequence,
    type: 'StopControlRecoveryExhausted',
    payload: {
      reasonCode,
      jobStopGeneration: job.jobStopGeneration,
    },
    createdAt: exhausted.updatedAt,
  }, { session });
}

/**
 * Materialize (or return) the exact current stop owner inside a caller's
 * transaction. `makeEligibleNow` is used when a new receipt/process fact can
 * make an otherwise delayed barrier actionable.
 */
export async function ensureStopControlRecoveryInSession(
  db: Db,
  session: ClientSession,
  jobId: string,
  opts: { makeEligibleNow?: boolean } = {},
): Promise<StopControlMaterializationResult | null> {
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const job = await jobs.findOne({ _id: jobId }, { session });
  if (
    !job
    || job.terminalOutcome !== null
    || job.controlState !== 'STOP_REQUESTED'
    || job.phase !== 'RECONCILING'
    || job.pendingTerminalOutcome === null
    || !job.primaryJobStopCause
    || job.jobStopGeneration <= 0
    || job.terminalBarrierMode !== 'FLAT_STOP_V1'
    || job.stopControlRecoveryState === 'EXHAUSTED'
  ) return null;
  if (!validControlBudget(job)) {
    await persistAdmissionFailureInSession(
      db,
      session,
      job,
      'control_recovery_policy_invalid',
    );
    return null;
  }

  if (job.activeActivationId !== null) {
    const active = await db.collection<LaneActivationDoc>(
      COLLECTIONS.activations,
    ).findOne(
      {
        ...stopControlRoutingMarker(),
        _id: job.activeActivationId,
        jobId,
        activeSlot: true,
      },
      { session },
    );
    const payload = parseStopControlRecoveryPayload(active?.reducerPayload);
    if (!active) return null;
    if (!payload || !stopActivationMatchesJob(active, payload, job)) {
      await quarantineCurrentStopOwnerInSession(
        db,
        session,
        job,
        active,
        payload,
        payload
          ? 'stop_control_recovery_authority_mismatch'
          : 'stop_control_recovery_payload_invalid',
      );
      return null;
    }
    return {
      jobId,
      activationId: active._id,
      budgetReservationId: payload.budgetReservationId,
      created: false,
    };
  }

  if (!opts.makeEligibleNow) {
    const due = await jobs.findOne(
      {
        _id: job._id,
        stateVersion: job.stateVersion,
        $expr: {
          $lte: [
            { $ifNull: ['$terminalBarrierNextCheckAt', new Date(0)] },
            '$$NOW',
          ],
        },
      } as unknown as Filter<JobDoc>,
      { session, projection: { _id: 1 } },
    );
    if (!due) return null;
  }

  const allotmentMs = CONTROL_BUDGET_POLICY_V1.activationAllotmentMs;
  if (availableControlBudget(job) < allotmentMs) {
    await persistAdmissionFailureInSession(
      db,
      session,
      job,
      'control_recovery_reserve_exhausted',
    );
    return null;
  }

  const barrierProbeAttempt = Math.max(
    0,
    job.terminalBarrierProbeAttempt ?? 0,
  );
  const recoveryAttempt = 1;
  const activationId = stopActivationId(
    job._id,
    job.jobStopGeneration,
    barrierProbeAttempt,
    recoveryAttempt,
    job.activationDispatchGeneration,
  );
  const reservationId = stopReservationId(
    job._id,
    job.jobStopGeneration,
    barrierProbeAttempt,
    recoveryAttempt,
    job.activationDispatchGeneration,
  );
  const wakeId = stopWakeId(activationId);
  const owned = await jobs.findOneAndUpdate(
    {
      _id: job._id,
      stateVersion: job.stateVersion,
      terminalOutcome: null,
      controlState: 'STOP_REQUESTED',
      phase: 'RECONCILING',
      pendingTerminalOutcome: job.pendingTerminalOutcome,
      primaryJobStopCause: job.primaryJobStopCause,
      jobStopGeneration: job.jobStopGeneration,
      planVersion: job.planVersion,
      activationDispatchGeneration: job.activationDispatchGeneration,
      activeActivationId: null,
      stopControlRecoveryState: { $ne: 'EXHAUSTED' },
      controlBudgetPolicyVersion: CONTROL_BUDGET_POLICY_V1.version,
      ...(opts.makeEligibleNow
        ? {}
        : {
            $expr: {
              $and: [
                {
                  $lte: [
                    {
                      $ifNull: [
                        '$terminalBarrierNextCheckAt',
                        new Date(0),
                      ],
                    },
                    '$$NOW',
                  ],
                },
                {
                  $gte: [
                    {
                      $subtract: [
                        '$jobControlRecoveryReserveMs',
                        {
                          $add: [
                            '$jobControlRecoveryReservedMs',
                            '$jobControlRecoveryConsumedMs',
                          ],
                        },
                      ],
                    },
                    allotmentMs,
                  ],
                },
              ],
            },
          }),
      ...(opts.makeEligibleNow
        ? {
            $expr: {
              $gte: [
                {
                  $subtract: [
                    '$jobControlRecoveryReserveMs',
                    {
                      $add: [
                        '$jobControlRecoveryReservedMs',
                        '$jobControlRecoveryConsumedMs',
                      ],
                    },
                  ],
                },
                allotmentMs,
              ],
            },
          }
        : {}),
    } as unknown as Filter<JobDoc>,
    [{
      $set: {
        activeActivationId: activationId,
        stopControlRecoveryAttempt: recoveryAttempt,
        stopControlRecoveryState: 'PENDING',
        terminalBarrierNextCheckAt: null,
        jobControlRecoveryReservedMs: {
          $add: ['$jobControlRecoveryReservedMs', allotmentMs],
        },
        stateVersion: { $add: ['$stateVersion', 1] },
        updatedAt: '$$NOW',
      },
    }],
    { session, returnDocument: 'after' },
  );
  if (!owned) {
    const winner = await jobs.findOne({ _id: jobId }, { session });
    if (!winner?.activeActivationId) return null;
    const active = await db.collection<LaneActivationDoc>(
      COLLECTIONS.activations,
    ).findOne(
      {
        ...stopControlRoutingMarker(),
        _id: winner.activeActivationId,
        jobId,
        activeSlot: true,
      },
      { session },
    );
    const payload = parseStopControlRecoveryPayload(active?.reducerPayload);
    if (!active) return null;
    if (!payload || !stopActivationMatchesJob(active, payload, winner)) {
      await quarantineCurrentStopOwnerInSession(
        db,
        session,
        winner,
        active,
        payload,
        payload
          ? 'stop_control_recovery_authority_mismatch'
          : 'stop_control_recovery_payload_invalid',
      );
      return null;
    }
    return {
      jobId,
      activationId: active._id,
      budgetReservationId: payload.budgetReservationId,
      created: false,
    };
  }

  const window = controlWindow(owned.updatedAt);
  const payload: StopControlRecoveryPayloadV1 = {
    kind: 'STOP_CONTROL_RECOVERY_V1',
    jobId: owned._id,
    planVersion: owned.planVersion,
    jobStopGeneration: owned.jobStopGeneration,
    activationDispatchGeneration: owned.activationDispatchGeneration,
    pendingTerminalOutcome: owned.pendingTerminalOutcome!,
    primaryJobStopCause: owned.primaryJobStopCause!,
    terminalBarrierMode: 'FLAT_STOP_V1',
    barrierProbeAttempt,
    recoveryAttempt,
    recoveryMaxAttempts: CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts,
    budgetReservationId: reservationId,
  };
  const payloadHash = canonicalHash(payload);
  const reservation: BudgetReservationDoc = {
    _id: reservationId,
    jobId: owned._id,
    jobStopGeneration: owned.jobStopGeneration,
    activationDispatchGeneration: owned.activationDispatchGeneration,
    pool: 'JOB_CONTROL_RECOVERY',
    ownerKind: 'ACTIVATION',
    ownerId: activationId,
    policyVersion: owned.controlBudgetPolicyVersion,
    state: 'RESERVED',
    allotmentMs,
    reservedAt: owned.updatedAt,
    expiresAt: window.hardDeadlineAt,
    activatedAt: null,
    settledAt: null,
    chargedActiveMs: 0,
    refundedMs: 0,
    settlementReason: null,
  };
  const activation: LaneActivationDoc = {
    _id: activationId,
    sourceWakeId: wakeId,
    jobId: owned._id,
    kind: 'CONTROL_RECOVERY',
    lifecycle: 'PENDING',
    activeSlot: true,
    activationDispatchGenerationAtClaim:
      owned.activationDispatchGeneration,
    planVersionAtClaim: owned.planVersion,
    jobStopGenerationAtClaim: owned.jobStopGeneration,
    leaseOwner: null,
    leaseExpiresAt: null,
    activationFence: 0,
    operationStartedAt: null,
    businessOperationCutoffAt: window.businessOperationCutoffAt,
    workDeadlineAt: window.workDeadlineAt,
    hardDeadlineAt: window.hardDeadlineAt,
    purposeAttemptIds: [],
    batchInboxItemIds: [],
    batchThroughWatermark: owned.resolvedInboxWatermark,
    inboxHighWatermarkAtClaim: owned.inboxHighWatermark,
    appliedInboxWatermarkAtClaim: owned.appliedInboxWatermark,
    resolvedInboxWatermarkAtClaim: owned.resolvedInboxWatermark,
    businessPayloadReadyGeneration: 0,
    businessPayloadReadyHash: null,
    businessPayloadReadyAt: null,
    reducerPayload: payload,
    controlSubtype: 'STOP_TERMINAL',
    reducerPayloadHash: payloadHash,
    budgetReservationId: reservationId,
    budgetPool: 'JOB_CONTROL_RECOVERY',
    activationActiveAllotmentMs: allotmentMs,
    committedPayloadHash: null,
    committedAppliedInboxWatermark: null,
    committedResolvedInboxWatermark: null,
    successorWakeId: null,
    committedAt: null,
    outcome: null,
    reasonCode: null,
    createdAt: owned.updatedAt,
    updatedAt: owned.updatedAt,
  };
  await db.collection<BudgetReservationDoc>(
    COLLECTIONS.budgetReservations,
  ).insertOne(reservation, { session });
  await db.collection<LaneActivationDoc>(
    COLLECTIONS.activations,
  ).insertOne(activation, { session });
  await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
    _id: wakeId,
    aggregate: owned._id,
    type: 'StopControlRecoveryRequested',
    state: 'PENDING',
    payload: {
      jobId: owned._id,
      activationId,
      budgetReservationId: reservationId,
      jobStopGeneration: owned.jobStopGeneration,
      activationDispatchGeneration: owned.activationDispatchGeneration,
      barrierProbeAttempt,
      recoveryAttempt,
    },
    createdAt: owned.updatedAt,
  }, { session });
  const sequence = await nextEventSeq(db, owned._id, session);
  await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
    _id: `${owned._id}:${sequence}`,
    jobId: owned._id,
    sequence,
    type: 'StopControlRecoveryReserved',
    payload: {
      activationId,
      budgetReservationId: reservationId,
      jobStopGeneration: owned.jobStopGeneration,
      activationDispatchGeneration: owned.activationDispatchGeneration,
      barrierProbeAttempt,
      recoveryAttempt,
      allotmentMs,
    },
    createdAt: owned.updatedAt,
  }, { session });
  return {
    jobId,
    activationId,
    budgetReservationId: reservationId,
    created: true,
  };
}

export async function ensureStopControlRecovery(
  client: MongoClient,
  db: Db,
  jobId: string,
  opts: { makeEligibleNow?: boolean } = {},
): Promise<StopControlMaterializationResult | null> {
  const { value } = await runTxn(client, (session) =>
    ensureStopControlRecoveryInSession(db, session, jobId, opts));
  return value;
}

export async function materializeDueStopControlRecoveries(
  client: MongoClient,
  db: Db,
  opts: { limit?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? DEFAULT_STOP_CONTROL_SCAN_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('stop-control scan limit must be a positive integer');
  }
  const candidates = await db.collection<JobDoc>(COLLECTIONS.jobs).find(
    {
      terminalOutcome: null,
      controlState: 'STOP_REQUESTED',
      phase: 'RECONCILING',
      pendingTerminalOutcome: { $ne: null },
      terminalBarrierMode: 'FLAT_STOP_V1',
      activeActivationId: null,
      stopControlRecoveryState: { $ne: 'EXHAUSTED' },
      $expr: {
        $lte: [
          { $ifNull: ['$terminalBarrierNextCheckAt', new Date(0)] },
          '$$NOW',
        ],
      },
    } as unknown as Filter<JobDoc>,
  )
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .project<{ _id: string }>({ _id: 1 })
    .toArray();
  let created = 0;
  for (const candidate of candidates) {
    const owner = await ensureStopControlRecovery(
      client,
      db,
      candidate._id,
    );
    if (owner?.created) created++;
  }
  return created;
}

function exactReservationFilter(
  activation: LaneActivationDoc,
  payload: StopControlRecoveryPayloadV1,
  state: BudgetReservationDoc['state'],
): Filter<BudgetReservationDoc> {
  const base: Filter<BudgetReservationDoc> = {
    _id: payload.budgetReservationId,
    jobId: activation.jobId,
    jobStopGeneration: payload.jobStopGeneration,
    activationDispatchGeneration: payload.activationDispatchGeneration,
    pool: 'JOB_CONTROL_RECOVERY',
    ownerKind: 'ACTIVATION',
    ownerId: activation._id,
    policyVersion: CONTROL_BUDGET_POLICY_V1.version,
    state,
    allotmentMs: CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
    reservedAt: { $type: 'date' },
    expiresAt: { $type: 'date' },
  };
  if (state === 'RESERVED') {
    return {
      ...base,
      activatedAt: null,
      settledAt: null,
      chargedActiveMs: 0,
      refundedMs: 0,
      settlementReason: null,
    };
  }
  if (state === 'ACTIVE') {
    return {
      ...base,
      activatedAt: { $type: 'date' },
      settledAt: null,
      chargedActiveMs: 0,
      refundedMs: 0,
      settlementReason: null,
    };
  }
  return {
    ...base,
    settledAt: { $type: 'date' },
  };
}

function stopControlRoutingMarker(): Filter<LaneActivationDoc> {
  return {
    $or: [
      { controlSubtype: 'STOP_TERMINAL' },
      { budgetPool: 'JOB_CONTROL_RECOVERY' },
      { budgetReservationId: { $type: 'string' } },
      { 'reducerPayload.kind': 'STOP_CONTROL_RECOVERY_V1' },
    ],
  } as unknown as Filter<LaneActivationDoc>;
}

function expectedLiveReservationState(
  activation: LaneActivationDoc,
): 'RESERVED' | 'ACTIVE' | null {
  if (activation.lifecycle === 'PENDING') return 'RESERVED';
  if (
    activation.lifecycle === 'LEASED'
    || activation.lifecycle === 'RUNNING'
  ) return 'ACTIVE';
  return null;
}

function liveReservationMatchesActivation(
  reservation: BudgetReservationDoc | null,
  activation: LaneActivationDoc,
  expectedState: 'RESERVED' | 'ACTIVE',
): reservation is BudgetReservationDoc {
  if (
    !reservation
    || typeof activation.budgetReservationId !== 'string'
    || activation.budgetReservationId.length === 0
    || reservation._id !== activation.budgetReservationId
    || reservation.jobId !== activation.jobId
    || reservation.jobStopGeneration
      !== activation.jobStopGenerationAtClaim
    || reservation.activationDispatchGeneration
      !== activation.activationDispatchGenerationAtClaim
    || reservation.pool !== 'JOB_CONTROL_RECOVERY'
    || reservation.ownerKind !== 'ACTIVATION'
    || reservation.ownerId !== activation._id
    || reservation.policyVersion !== CONTROL_BUDGET_POLICY_V1.version
    || reservation.state !== expectedState
    || reservation.allotmentMs
      !== CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
    || !(activation.workDeadlineAt instanceof Date)
    || !(activation.hardDeadlineAt instanceof Date)
    || !(reservation.reservedAt instanceof Date)
    || !(reservation.expiresAt instanceof Date)
    || reservation.expiresAt.getTime()
      !== activation.hardDeadlineAt.getTime()
    || activation.hardDeadlineAt.getTime()
      - activation.workDeadlineAt.getTime()
      !== CONTROL_BUDGET_POLICY_V1.activationCommitReserveMs
    || reservation.expiresAt.getTime()
      - reservation.reservedAt.getTime()
      !== CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
    || reservation.reservedAt.getTime() >= reservation.expiresAt.getTime()
    || reservation.settledAt !== null
    || reservation.settlementReason !== null
    || reservation.chargedActiveMs !== 0
    || reservation.refundedMs !== 0
  ) return false;
  if (expectedState === 'RESERVED') {
    return reservation.activatedAt === null;
  }
  return reservation.activatedAt instanceof Date
    && reservation.activatedAt.getTime() >= reservation.reservedAt.getTime()
    && reservation.activatedAt.getTime() < reservation.expiresAt.getTime();
}

function committedReservationMatchesActivation(
  reservation: BudgetReservationDoc | null,
  activation: LaneActivationDoc,
  payload: StopControlRecoveryPayloadV1,
): reservation is BudgetReservationDoc {
  return reservation !== null
    && reservation._id === payload.budgetReservationId
    && reservation._id === activation.budgetReservationId
    && reservation.jobId === activation.jobId
    && reservation.jobStopGeneration === payload.jobStopGeneration
    && reservation.jobStopGeneration
      === activation.jobStopGenerationAtClaim
    && reservation.activationDispatchGeneration
      === payload.activationDispatchGeneration
    && reservation.activationDispatchGeneration
      === activation.activationDispatchGenerationAtClaim
    && reservation.pool === 'JOB_CONTROL_RECOVERY'
    && reservation.ownerKind === 'ACTIVATION'
    && reservation.ownerId === activation._id
    && reservation.policyVersion === CONTROL_BUDGET_POLICY_V1.version
    && reservation.state === 'SETTLED'
    && reservation.allotmentMs
      === CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
    && reservation.settlementReason === 'COMMITTED'
    && reservation.reservedAt instanceof Date
    && reservation.activatedAt instanceof Date
    && reservation.settledAt instanceof Date
    && reservation.expiresAt instanceof Date
    && activation.workDeadlineAt instanceof Date
    && activation.hardDeadlineAt instanceof Date
    && activation.committedAt instanceof Date
    && reservation.reservedAt.getTime()
      <= reservation.activatedAt.getTime()
    && reservation.activatedAt.getTime()
      <= reservation.settledAt.getTime()
    && reservation.activatedAt.getTime()
      < reservation.expiresAt.getTime()
    && reservation.settledAt.getTime()
      < reservation.expiresAt.getTime()
    && reservation.expiresAt.getTime()
      === activation.hardDeadlineAt.getTime()
    && activation.hardDeadlineAt.getTime()
      - activation.workDeadlineAt.getTime()
      === CONTROL_BUDGET_POLICY_V1.activationCommitReserveMs
    && reservation.expiresAt.getTime()
      - reservation.reservedAt.getTime()
      === CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
    && activation.committedAt.getTime()
      === reservation.settledAt.getTime()
    && hasExactBudgetReservationSettlement(reservation);
}

async function loadStructurallyValidLiveReservationInSession(
  db: Db,
  session: ClientSession,
  activation: LaneActivationDoc,
  expectedState: 'RESERVED' | 'ACTIVE',
): Promise<BudgetReservationDoc | null> {
  if (
    typeof activation.budgetReservationId !== 'string'
    || activation.budgetReservationId.length === 0
  ) return null;
  const reservation = await db.collection<BudgetReservationDoc>(
    COLLECTIONS.budgetReservations,
  ).findOne({ _id: activation.budgetReservationId }, { session });
  return liveReservationMatchesActivation(
    reservation,
    activation,
    expectedState,
  )
    ? reservation
    : null;
}

interface CurrentStopOwnerPreflight {
  job: JobDoc;
  payload: StopControlRecoveryPayloadV1;
  reservation: BudgetReservationDoc;
}

async function preflightCurrentStopOwnerInSession(
  db: Db,
  session: ClientSession,
  activation: LaneActivationDoc,
  payload: StopControlRecoveryPayloadV1 | null,
  expectedJobState: 'PENDING' | 'ACTIVE',
  expectedReservationState: 'RESERVED' | 'ACTIVE',
): Promise<CurrentStopOwnerPreflight | null> {
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
    { _id: activation.jobId },
    { session },
  );
  if (!job || job.activeActivationId !== activation._id) return null;
  if (!validControlBudget(job)) {
    await quarantineCurrentStopOwnerInSession(
      db,
      session,
      job,
      activation,
      payload,
      'control_recovery_policy_invalid',
    );
    return null;
  }
  if (!payload) {
    await quarantineCurrentStopOwnerInSession(
      db,
      session,
      job,
      activation,
      null,
      'stop_control_recovery_payload_invalid',
    );
    return null;
  }
  if (
    job.terminalOutcome !== null
    || job.controlState !== 'STOP_REQUESTED'
    || job.phase !== 'RECONCILING'
    || job.stopControlRecoveryState !== expectedJobState
    || job.jobControlRecoveryReservedMs
      !== CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
    || (
      expectedJobState === 'ACTIVE'
      && job.activationFence !== activation.activationFence
    )
    || !stopActivationMatchesJob(activation, payload, job)
  ) {
    await quarantineCurrentStopOwnerInSession(
      db,
      session,
      job,
      activation,
      payload,
      'stop_control_recovery_authority_mismatch',
    );
    return null;
  }
  const reservation = await loadStructurallyValidLiveReservationInSession(
    db,
    session,
    activation,
    expectedReservationState,
  );
  if (!reservation) {
    await quarantineCurrentStopOwnerInSession(
      db,
      session,
      job,
      activation,
      payload,
      'stop_control_recovery_reservation_invalid',
      { settleReservation: false },
    );
    return null;
  }
  return { job, payload, reservation };
}

export async function claimStopControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  input: {
    activationId: string;
    leaseOwner: string;
    leaseTtlMs?: number;
  },
): Promise<StopControlRecoveryLeaseHandle | null> {
  const leaseTtlMs =
    input.leaseTtlMs ?? CONTROL_BUDGET_POLICY_V1.activationLeaseTtlMs;
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error('stop-control lease TTL must be a positive integer');
  }
  try {
    const { value } = await runTxn(client, async (session) => {
      const activations =
        db.collection<LaneActivationDoc>(COLLECTIONS.activations);
      const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
      const activation = await activations.findOne(
        {
          ...stopControlRoutingMarker(),
          _id: input.activationId,
          lifecycle: { $in: ['PENDING', 'LEASED', 'RUNNING'] },
          activeSlot: true,
        },
        { session },
      );
      const payload = parseStopControlRecoveryPayload(
        activation?.reducerPayload,
      );
      if (!activation) return null;
      const expectedJobState = activation.lifecycle === 'PENDING'
        ? 'PENDING'
        : 'ACTIVE';
      const expectedReservationState = activation.lifecycle === 'PENDING'
        ? 'RESERVED'
        : 'ACTIVE';
      const preflight = await preflightCurrentStopOwnerInSession(
        db,
        session,
        activation,
        payload,
        expectedJobState,
        expectedReservationState,
      );
      if (!preflight) return null;
      const { job, payload: validPayload } = preflight;

      if (
        (activation.lifecycle === 'LEASED'
          || activation.lifecycle === 'RUNNING')
        && activation.leaseOwner === input.leaseOwner
      ) {
        const reservation = await db.collection<BudgetReservationDoc>(
          COLLECTIONS.budgetReservations,
        ).findOne(
          {
            ...exactReservationFilter(activation, validPayload, 'ACTIVE'),
            $expr: {
              $and: [
                { $gt: ['$expiresAt', '$$NOW'] },
                { $lte: ['$reservedAt', '$activatedAt'] },
                { $lte: ['$activatedAt', '$$NOW'] },
              ],
            },
          } as unknown as Filter<BudgetReservationDoc>,
          { session },
        );
        const replay = reservation
          ? await activations.findOne(
              {
                _id: activation._id,
                lifecycle: { $in: ['LEASED', 'RUNNING'] },
                activeSlot: true,
                leaseOwner: input.leaseOwner,
                activationFence: activation.activationFence,
                $expr: {
                  $and: [
                    { $gt: ['$leaseExpiresAt', '$$NOW'] },
                    { $gt: ['$workDeadlineAt', '$$NOW'] },
                    { $gt: ['$hardDeadlineAt', '$$NOW'] },
                  ],
                },
              } as unknown as Filter<LaneActivationDoc>,
              { session },
            )
          : null;
        if (!replay?.leaseExpiresAt) return null;
        return {
          activationId: replay._id,
          jobId: replay.jobId,
          leaseOwner: input.leaseOwner,
          activationFence: replay.activationFence,
          leaseExpiresAt: replay.leaseExpiresAt,
          workDeadlineAt: replay.workDeadlineAt,
          hardDeadlineAt: replay.hardDeadlineAt,
          budgetReservationId: validPayload.budgetReservationId,
        } satisfies StopControlRecoveryLeaseHandle;
      }
      if (
        activation.lifecycle !== 'PENDING'
        || job.stopControlRecoveryState !== 'PENDING'
      ) return null;
      const reservation = await db.collection<BudgetReservationDoc>(
        COLLECTIONS.budgetReservations,
      ).findOne(
        {
          ...exactReservationFilter(activation, validPayload, 'RESERVED'),
          $expr: {
            $and: [
              { $gt: ['$expiresAt', '$$NOW'] },
              { $lte: ['$reservedAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<BudgetReservationDoc>,
        { session },
      );
      if (!reservation) return null;

      const fencedJob = await jobs.findOneAndUpdate(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          terminalOutcome: null,
          controlState: 'STOP_REQUESTED',
          activeActivationId: activation._id,
          planVersion: validPayload.planVersion,
          jobStopGeneration: validPayload.jobStopGeneration,
          activationDispatchGeneration:
            validPayload.activationDispatchGeneration,
          stopControlRecoveryAttempt: validPayload.recoveryAttempt,
          stopControlRecoveryState: 'PENDING',
        },
        [{
          $set: {
            activationFence: { $add: ['$activationFence', 1] },
            stopControlRecoveryState: 'ACTIVE',
            stateVersion: { $add: ['$stateVersion', 1] },
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!fencedJob) {
        throw new StopControlRecoveryAuthorityLostError(
          'stop-control claim job CAS lost',
        );
      }
      const claimed = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'CONTROL_RECOVERY',
          lifecycle: 'PENDING',
          activeSlot: true,
          activationFence: 0,
          reducerPayloadHash: canonicalHash(validPayload),
          $expr: {
            $and: [
              { $gt: ['$workDeadlineAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<LaneActivationDoc>,
        [{
          $set: {
            lifecycle: 'LEASED',
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: {
              $min: [
                {
                  $dateAdd: {
                    startDate: '$$NOW',
                    unit: 'millisecond',
                    amount: leaseTtlMs,
                  },
                },
                '$hardDeadlineAt',
              ],
            },
            activationFence: fencedJob.activationFence,
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!claimed?.leaseExpiresAt) {
        throw new StopControlRecoveryAuthorityLostError(
          'stop-control activation claim CAS lost',
        );
      }
      const activatedReservation =
        await db.collection<BudgetReservationDoc>(
          COLLECTIONS.budgetReservations,
        ).findOneAndUpdate(
          {
            ...exactReservationFilter(activation, validPayload, 'RESERVED'),
            $expr: {
              $and: [
                { $gt: ['$expiresAt', '$$NOW'] },
                { $lte: ['$reservedAt', '$$NOW'] },
              ],
            },
          } as unknown as Filter<BudgetReservationDoc>,
          [{
            $set: {
              state: 'ACTIVE',
              activatedAt: '$$NOW',
            },
          }],
          { session, returnDocument: 'after' },
        );
      if (!activatedReservation?.activatedAt) {
        throw new StopControlRecoveryAuthorityLostError(
          'stop-control reservation activation CAS lost',
        );
      }
      const sequence = await nextEventSeq(db, job._id, session);
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${sequence}`,
        jobId: job._id,
        sequence,
        type: 'StopControlRecoveryClaimed',
        payload: {
          activationId: activation._id,
          budgetReservationId: validPayload.budgetReservationId,
          activationFence: claimed.activationFence,
          recoveryAttempt: validPayload.recoveryAttempt,
        },
        createdAt: claimed.updatedAt,
      }, { session });
      return {
        activationId: claimed._id,
        jobId: claimed.jobId,
        leaseOwner: input.leaseOwner,
        activationFence: claimed.activationFence,
        leaseExpiresAt: claimed.leaseExpiresAt,
        workDeadlineAt: claimed.workDeadlineAt,
        hardDeadlineAt: claimed.hardDeadlineAt,
        budgetReservationId: validPayload.budgetReservationId,
      } satisfies StopControlRecoveryLeaseHandle;
    });
    return value;
  } catch (error) {
    if (error instanceof StopControlRecoveryAuthorityLostError) return null;
    throw error;
  }
}

export async function startStopControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  input: {
    activationId: string;
    leaseOwner: string;
    activationFence: number;
  },
): Promise<boolean> {
  try {
    const { value } = await runTxn(client, async (session) => {
      const activations =
        db.collection<LaneActivationDoc>(COLLECTIONS.activations);
      const activation = await activations.findOne(
        {
          ...stopControlRoutingMarker(),
          _id: input.activationId,
          lifecycle: { $in: ['LEASED', 'RUNNING'] },
          activeSlot: true,
          activationFence: input.activationFence,
        },
        { session },
      );
      const payload = parseStopControlRecoveryPayload(
        activation?.reducerPayload,
      );
      if (!activation) return false;
      const replay = activation.lifecycle === 'RUNNING'
        && activation.leaseOwner === input.leaseOwner
        && activation.operationStartedAt instanceof Date;
      if (
        !replay
        && (
          activation.lifecycle !== 'LEASED'
          || activation.leaseOwner !== input.leaseOwner
        )
      ) return false;
      const preflight = await preflightCurrentStopOwnerInSession(
        db,
        session,
        activation,
        payload,
        'ACTIVE',
        'ACTIVE',
      );
      if (!preflight) return false;
      const { job, payload: validPayload } = preflight;
      if (job.activationFence !== input.activationFence) return false;
      const reservation = await db.collection<BudgetReservationDoc>(
        COLLECTIONS.budgetReservations,
      ).findOne(
        {
          ...exactReservationFilter(activation, validPayload, 'ACTIVE'),
          $expr: {
            $and: [
              { $gt: ['$expiresAt', '$$NOW'] },
              { $lte: ['$reservedAt', '$activatedAt'] },
              { $lte: ['$activatedAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<BudgetReservationDoc>,
        { session, projection: { _id: 1 } },
      );
      if (!reservation) return false;
      const started = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'CONTROL_RECOVERY',
          lifecycle: replay ? 'RUNNING' : 'LEASED',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
          reducerPayloadHash: canonicalHash(validPayload),
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
            lifecycle: 'RUNNING',
            operationStartedAt: {
              $ifNull: ['$operationStartedAt', '$$NOW'],
            },
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!started) return false;
      if (!replay) {
        const touched = await db.collection<JobDoc>(COLLECTIONS.jobs)
          .updateOne(
            {
              _id: job._id,
              stateVersion: job.stateVersion,
              activeActivationId: activation._id,
              activationFence: input.activationFence,
              stopControlRecoveryState: 'ACTIVE',
            },
            {
              $set: { updatedAt: started.updatedAt },
              $inc: { stateVersion: 1 },
            },
            { session },
          );
        if (touched.modifiedCount !== 1) {
          throw new StopControlRecoveryAuthorityLostError(
            'stop-control start job CAS lost',
          );
        }
        const sequence = await nextEventSeq(db, job._id, session);
        await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
          _id: `${job._id}:${sequence}`,
          jobId: job._id,
          sequence,
          type: 'StopControlRecoveryStarted',
          payload: {
            activationId: activation._id,
            budgetReservationId: validPayload.budgetReservationId,
            activationFence: input.activationFence,
            recoveryAttempt: validPayload.recoveryAttempt,
          },
          createdAt: started.updatedAt,
        }, { session });
      }
      return true;
    });
    return value;
  } catch (error) {
    if (error instanceof StopControlRecoveryAuthorityLostError) return false;
    throw error;
  }
}

interface SettledReservation {
  doc: BudgetReservationDoc;
  newlySettled: boolean;
}

async function settleReservationInSession(
  db: Db,
  session: ClientSession,
  activation: LaneActivationDoc,
  reason: BudgetSettlementReason,
): Promise<SettledReservation | null> {
  if (
    typeof activation.budgetReservationId !== 'string'
    || activation.budgetReservationId.length === 0
    || activation.budgetPool !== 'JOB_CONTROL_RECOVERY'
    || activation.activationActiveAllotmentMs
      !== CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
  ) return null;
  const terminalState: BudgetReservationDoc['state'] =
    reason === 'EXPIRED' ? 'EXPIRED' : 'SETTLED';
  const expectsActivatedAt = activation.lifecycle !== 'PENDING';
  const reservations = db.collection<BudgetReservationDoc>(
    COLLECTIONS.budgetReservations,
  );
  const settled = await reservations.findOneAndUpdate(
    {
      _id: activation.budgetReservationId,
      jobId: activation.jobId,
      jobStopGeneration: activation.jobStopGenerationAtClaim,
      activationDispatchGeneration:
        activation.activationDispatchGenerationAtClaim,
      pool: 'JOB_CONTROL_RECOVERY',
      ownerKind: 'ACTIVATION',
      ownerId: activation._id,
      policyVersion: CONTROL_BUDGET_POLICY_V1.version,
      allotmentMs: CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
      reservedAt: { $type: 'date' },
      expiresAt: { $type: 'date' },
      $or: [
        {
          state: 'RESERVED',
          activatedAt: null,
          settledAt: null,
          chargedActiveMs: 0,
          refundedMs: 0,
          settlementReason: null,
          $expr: { $lte: ['$reservedAt', '$$NOW'] },
        },
        {
          state: 'ACTIVE',
          activatedAt: { $type: 'date' },
          settledAt: null,
          chargedActiveMs: 0,
          refundedMs: 0,
          settlementReason: null,
          $expr: {
            $and: [
              { $lte: ['$reservedAt', '$activatedAt'] },
              { $lte: ['$activatedAt', '$$NOW'] },
            ],
          },
        },
      ],
    } as unknown as Filter<BudgetReservationDoc>,
    [
      {
        $set: {
          chargedActiveMs: {
            $cond: [
              {
                $and: [
                  { $eq: ['$state', 'ACTIVE'] },
                  { $eq: [{ $type: '$activatedAt' }, 'date'] },
                ],
              },
              {
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
              0,
            ],
          },
          state: terminalState,
          settledAt: '$$NOW',
          settlementReason: reason,
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
  if (settled) return { doc: settled, newlySettled: true };
  const replay = await reservations.findOne(
    {
      _id: activation.budgetReservationId,
      jobId: activation.jobId,
      jobStopGeneration: activation.jobStopGenerationAtClaim,
      activationDispatchGeneration:
        activation.activationDispatchGenerationAtClaim,
      pool: 'JOB_CONTROL_RECOVERY',
      ownerKind: 'ACTIVATION',
      ownerId: activation._id,
      policyVersion: CONTROL_BUDGET_POLICY_V1.version,
      state: terminalState,
      allotmentMs: CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
      reservedAt: { $type: 'date' },
      expiresAt: { $type: 'date' },
      ...(expectsActivatedAt
        ? { activatedAt: { $type: 'date' } }
        : { activatedAt: null }),
      settlementReason: reason,
      settledAt: { $type: 'date' },
      chargedActiveMs: { $type: 'number' },
      refundedMs: { $type: 'number' },
      $expr: {
        $and: [
          { $lte: ['$reservedAt', '$settledAt'] },
          { $lte: ['$settledAt', '$$NOW'] },
          ...(expectsActivatedAt
            ? [
                { $lte: ['$reservedAt', '$activatedAt'] },
                { $lte: ['$activatedAt', '$settledAt'] },
              ]
            : []),
        ],
      },
    } as unknown as Filter<BudgetReservationDoc>,
    { session },
  );
  return replay && hasExactBudgetReservationSettlement(replay)
    ? { doc: replay, newlySettled: false }
    : null;
}

function replayReduction(
  activation: LaneActivationDoc,
): FlatTerminalReductionResult | null {
  if (activation.outcome === 'WAITING') {
    return {
      jobId: activation.jobId,
      status: 'waiting',
      outcome: null,
      blocker: null,
    };
  }
  if (activation.outcome === 'BLOCKED_UNSUPPORTED') {
    return {
      jobId: activation.jobId,
      status: 'blocked',
      outcome: null,
      blocker: activation.reasonCode,
    };
  }
  const prefix = 'TERMINALIZED:';
  if (activation.outcome?.startsWith(prefix)) {
    const outcome = activation.outcome.slice(prefix.length);
    if (TERMINAL_OUTCOMES.has(outcome as JobTerminalOutcome)) {
      return {
        jobId: activation.jobId,
        status: 'terminalized',
        outcome: outcome as JobTerminalOutcome,
        blocker: null,
      };
    }
  }
  return null;
}

export async function commitStopControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  input: {
    activationId: string;
    leaseOwner: string;
    activationFence: number;
  },
): Promise<StopControlRecoveryCommitResult | null> {
  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await db.collection<LaneActivationDoc>(
        COLLECTIONS.activations,
      ).findOne(
        {
          ...stopControlRoutingMarker(),
          _id: input.activationId,
          lifecycle: { $in: ['RUNNING', 'COMMITTED'] },
          activationFence: input.activationFence,
        },
        { session },
      );
      const payload = parseStopControlRecoveryPayload(
        activation?.reducerPayload,
      );
      if (!activation) return null;
      if (activation.lifecycle === 'COMMITTED') {
        if (
          !payload
          || activation.kind !== 'CONTROL_RECOVERY'
          || activation.controlSubtype !== 'STOP_TERMINAL'
          || activation.budgetPool !== 'JOB_CONTROL_RECOVERY'
          || activation.activationActiveAllotmentMs
            !== CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
          || activation.jobId !== payload.jobId
          || activation.planVersionAtClaim !== payload.planVersion
          || activation.jobStopGenerationAtClaim
            !== payload.jobStopGeneration
          || activation.activationDispatchGenerationAtClaim
            !== payload.activationDispatchGeneration
          || activation.budgetReservationId !== payload.budgetReservationId
          || activation.reducerPayloadHash !== canonicalHash(payload)
        ) return null;
        const payloadHash = canonicalHash(payload);
        const reduction = replayReduction(activation);
        const reservationCandidate = await db.collection<BudgetReservationDoc>(
          COLLECTIONS.budgetReservations,
        ).findOne(
          { _id: payload.budgetReservationId },
          { session },
        );
        const reservation = committedReservationMatchesActivation(
          reservationCandidate,
          activation,
          payload,
        )
          ? await db.collection<BudgetReservationDoc>(
              COLLECTIONS.budgetReservations,
            ).findOne(
              {
                _id: payload.budgetReservationId,
                $expr: { $lte: ['$settledAt', '$$NOW'] },
              } as unknown as Filter<BudgetReservationDoc>,
              { session },
            )
          : null;
        const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
          { _id: activation.jobId },
          { session },
        );
        const replayValid =
          reduction !== null
          && reservation !== null
          && job !== null
          && validControlBudget(job)
          && activation.activeSlot === false
          && activation.leaseOwner === null
          && activation.leaseExpiresAt === null
          && activation.committedAt instanceof Date
          && activation.committedPayloadHash === payloadHash
          && job?.activeActivationId !== activation._id
          && (
            reduction.status !== 'terminalized'
            || (
              job?.phase === 'TERMINAL'
              && job.terminalOutcome === reduction.outcome
            )
          );
        if (!replayValid || !reduction || !reservation) return null;
        return {
          activationId: activation._id,
          jobId: activation.jobId,
          budgetReservationId: payload.budgetReservationId,
          reduction,
          chargedActiveMs: reservation.chargedActiveMs,
          refundedMs: reservation.refundedMs,
          deduped: true,
        } satisfies StopControlRecoveryCommitResult;
      }
      if (
        activation.lifecycle !== 'RUNNING'
        || !activation.activeSlot
        || activation.leaseOwner !== input.leaseOwner
      ) return null;
      const preflight = await preflightCurrentStopOwnerInSession(
        db,
        session,
        activation,
        payload,
        'ACTIVE',
        'ACTIVE',
      );
      if (!preflight) return null;
      const { job, payload: validPayload } = preflight;
      if (job.activationFence !== input.activationFence) return null;
      const payloadHash = canonicalHash(validPayload);
      const authority: FlatTerminalControlAuthority = {
        activationId: activation._id,
        leaseOwner: input.leaseOwner,
        activationFence: input.activationFence,
        budgetReservationId: validPayload.budgetReservationId,
        reducerPayloadHash: payloadHash,
      };
      const ownedCommit =
        await commitPendingFlatTerminalWithControlInSession(
        db,
        session,
        job._id,
        authority,
      );
      if (!ownedCommit) return null;
      return {
        activationId: activation._id,
        jobId: job._id,
        budgetReservationId: validPayload.budgetReservationId,
        reduction: ownedCommit.reduction,
        chargedActiveMs: ownedCommit.chargedActiveMs,
        refundedMs: ownedCommit.refundedMs,
        deduped: false,
      } satisfies StopControlRecoveryCommitResult;
    });
    return value;
  } catch (error) {
    if (
      error instanceof StopControlRecoveryAuthorityLostError
      || error instanceof FlatTerminalAuthorityLostError
    ) return null;
    throw error;
  }
}

export async function runStopControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  activationId: string,
  opts: { leaseOwner?: string; leaseTtlMs?: number } = {},
): Promise<StopControlRecoveryCommitResult | null> {
  const leaseOwner =
    opts.leaseOwner ?? `stop-control:${randomUUID()}`;
  const lease = await claimStopControlRecoveryActivation(client, db, {
    activationId,
    leaseOwner,
    leaseTtlMs: opts.leaseTtlMs,
  });
  if (!lease) return null;
  if (!await startStopControlRecoveryActivation(client, db, {
    activationId,
    leaseOwner,
    activationFence: lease.activationFence,
  })) return null;
  return commitStopControlRecoveryActivation(client, db, {
    activationId,
    leaseOwner,
    activationFence: lease.activationFence,
  });
}

export async function claimNextStopControlRecoveryWake(
  client: MongoClient,
  db: Db,
): Promise<{ wakeId: string; activationId: string; jobId: string } | null> {
  for (let scanned = 0; scanned < DEFAULT_STOP_CONTROL_SCAN_LIMIT; scanned++) {
    const { value } = await runTxn(client, async (session) => {
      const wake = await db.collection<OutboxDoc>(COLLECTIONS.outbox)
        .findOneAndUpdate(
          { type: 'StopControlRecoveryRequested', state: 'PENDING' },
          { $set: { state: 'PUBLISHED' } },
          {
            session,
            sort: { createdAt: 1, _id: 1 },
            returnDocument: 'after',
          },
        );
      if (!wake) return { status: 'empty' as const };
      const raw = wake.payload as unknown;
      const activationId = isRecord(raw) ? raw.activationId : null;
      const generation = isRecord(raw)
        ? raw.activationDispatchGeneration
        : null;
      const stopGeneration = isRecord(raw)
        ? raw.jobStopGeneration
        : null;
      if (
        typeof activationId !== 'string'
        || typeof generation !== 'number'
        || !Number.isInteger(generation)
        || typeof stopGeneration !== 'number'
        || !Number.isInteger(stopGeneration)
      ) return { status: 'skipped' as const };
      const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
        {
          _id: wake.aggregate,
          activeActivationId: activationId,
          activationDispatchGeneration: generation,
          jobStopGeneration: stopGeneration,
          stopControlRecoveryState: { $in: ['PENDING', 'ACTIVE'] },
        },
        { session, projection: { _id: 1 } },
      );
      const activation = job
        ? await db.collection<LaneActivationDoc>(
            COLLECTIONS.activations,
          ).findOne(
            {
              ...stopControlRoutingMarker(),
              _id: activationId,
              jobId: job._id,
              lifecycle: { $in: ACTIVE_STOP_CONTROL_LIFECYCLES },
              activeSlot: true,
              sourceWakeId: wake._id,
            },
            { session, projection: { _id: 1 } },
          )
        : null;
      if (!job || !activation) return { status: 'skipped' as const };
      return {
        status: 'claimed' as const,
        wakeId: wake._id,
        activationId: activation._id,
        jobId: job._id,
      };
    });
    if (value.status === 'empty') return null;
    if (value.status === 'claimed') {
      return {
        wakeId: value.wakeId,
        activationId: value.activationId,
        jobId: value.jobId,
      };
    }
  }
  return null;
}

function countDrainResult(
  aggregate: StopControlRecoveryDrainResult,
  result: StopControlRecoveryCommitResult | null,
): void {
  if (!result) return;
  aggregate.committed++;
  if (result.reduction.status === 'terminalized') aggregate.terminalized++;
  if (result.reduction.status === 'waiting') aggregate.waiting++;
  if (result.reduction.status === 'blocked') aggregate.blocked++;
}

export async function drainStopControlRecovery(
  client: MongoClient,
  db: Db,
  opts: { limit?: number } = {},
): Promise<StopControlRecoveryDrainResult> {
  const limit = opts.limit ?? DEFAULT_STOP_CONTROL_DRAIN_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('stop-control drain limit must be a positive integer');
  }
  const aggregate: StopControlRecoveryDrainResult = {
    claimed: 0,
    committed: 0,
    terminalized: 0,
    waiting: 0,
    blocked: 0,
  };
  for (let drained = 0; drained < limit; drained++) {
    const wake = await claimNextStopControlRecoveryWake(client, db);
    if (wake) {
      aggregate.claimed++;
      countDrainResult(
        aggregate,
        await runStopControlRecoveryActivation(
          client,
          db,
          wake.activationId,
        ),
      );
      continue;
    }
    const fallbacks = await db.collection<LaneActivationDoc>(
      COLLECTIONS.activations,
    ).find(
      {
        ...stopControlRoutingMarker(),
        lifecycle: 'PENDING',
        activeSlot: true,
      },
      { projection: { _id: 1 } },
    )
      .sort({ updatedAt: 1, createdAt: 1, _id: 1 })
      .limit(STOP_CONTROL_FALLBACK_SCAN_LIMIT)
      .toArray();
    if (fallbacks.length === 0) break;
    let progressed = false;
    for (const fallback of fallbacks) {
      const result = await runStopControlRecoveryActivation(
        client,
        db,
        fallback._id,
      );
      if (!result) {
        continue;
      }
      countDrainResult(aggregate, result);
      progressed = true;
      break;
    }
    if (!progressed) break;
  }
  return aggregate;
}

function expiredStopControlFilter(): Filter<LaneActivationDoc> {
  return {
    activeSlot: true,
    $nor: [{
      lifecycle: 'FAILED',
      reasonCode: {
        $in: [
          'stop_control_recovery_exhausted',
          'stop_control_recovery_payload_invalid',
          'stop_control_recovery_authority_mismatch',
          'control_recovery_reserve_exhausted',
          'control_recovery_policy_invalid',
          'stop_control_recovery_reservation_invalid',
        ],
      },
    }],
    $and: [
      {
        $or: [
          { controlSubtype: 'STOP_TERMINAL' },
          { budgetPool: 'JOB_CONTROL_RECOVERY' },
          { budgetReservationId: { $type: 'string' } },
          { 'reducerPayload.kind': 'STOP_CONTROL_RECOVERY_V1' },
        ],
      },
      {
        $or: [
          {
            lifecycle: 'PENDING',
            $expr: {
              $or: [
                { $lte: ['$workDeadlineAt', '$$NOW'] },
                { $lte: ['$hardDeadlineAt', '$$NOW'] },
              ],
            },
          },
          {
            lifecycle: { $in: ['LEASED', 'RUNNING'] },
            $expr: {
              $or: [
                { $lte: ['$leaseExpiresAt', '$$NOW'] },
                { $lte: ['$workDeadlineAt', '$$NOW'] },
                { $lte: ['$hardDeadlineAt', '$$NOW'] },
              ],
            },
          },
        ],
      },
    ],
  } as unknown as Filter<LaneActivationDoc>;
}

type StopControlOwnerFailureReason =
  | 'stop_control_recovery_exhausted'
  | 'stop_control_recovery_payload_invalid'
  | 'stop_control_recovery_authority_mismatch'
  | 'control_recovery_reserve_exhausted'
  | 'control_recovery_policy_invalid'
  | 'stop_control_recovery_reservation_invalid';

async function persistExpiredOwnerFailureInSession(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  activation: LaneActivationDoc,
  payload: StopControlRecoveryPayloadV1 | null,
  reasonCode: StopControlOwnerFailureReason,
  settledReservation?: BudgetReservationDoc | null,
  opts: { requireExpired?: boolean } = {},
): Promise<void> {
  const failed = await db.collection<LaneActivationDoc>(
    COLLECTIONS.activations,
  ).findOneAndUpdate(
    {
      ...(opts.requireExpired === false
        ? {
            ...stopControlRoutingMarker(),
            activeSlot: true,
          }
        : expiredStopControlFilter()),
      _id: activation._id,
      lifecycle: activation.lifecycle,
      activationFence: activation.activationFence,
    },
    [{
      $set: {
        lifecycle: 'FAILED',
        leaseOwner: null,
        leaseExpiresAt: null,
        activationFence: { $add: ['$activationFence', 1] },
        reasonCode,
        updatedAt: '$$NOW',
      },
    }],
    { session, returnDocument: 'after' },
  );
  if (!failed) {
    throw new StopControlRecoveryAuthorityLostError(
      'stop-control failure activation CAS lost',
    );
  }
  const allotment = settledReservation?.allotmentMs ?? 0;
  const charged = settledReservation?.chargedActiveMs ?? 0;
  const failedJob = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .findOneAndUpdate(
      {
        _id: job._id,
        activeActivationId: activation._id,
        jobStopGeneration: job.jobStopGeneration,
        activationDispatchGeneration: job.activationDispatchGeneration,
        ...(allotment > 0
          ? { jobControlRecoveryReservedMs: { $gte: allotment } }
          : {}),
      },
      [{
        $set: {
          stopControlRecoveryState: 'EXHAUSTED',
          terminalBarrierBlocker: reasonCode,
          terminalBarrierNextCheckAt: null,
          ...(allotment > 0
            ? {
                jobControlRecoveryReservedMs: {
                  $subtract: ['$jobControlRecoveryReservedMs', allotment],
                },
                jobControlRecoveryConsumedMs: {
                  $add: ['$jobControlRecoveryConsumedMs', charged],
                },
              }
            : {}),
          stateVersion: { $add: ['$stateVersion', 1] },
          updatedAt: { $literal: failed.updatedAt },
        },
      }],
      { session, returnDocument: 'after' },
    );
  if (!failedJob) {
    throw new StopControlRecoveryAuthorityLostError(
      'stop-control failure job CAS lost',
    );
  }
  const alertId =
    `obx_stop_control_alert:${job._id}:${job.jobStopGeneration}`;
  await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
    { _id: alertId },
    {
      $setOnInsert: {
        _id: alertId,
        aggregate: job._id,
        type: 'OperatorAlertRequested',
        state: 'PENDING',
        payload: {
          alertType: reasonCode,
          resourceId: job.resourceId,
          conversationId: job.conversationId,
          jobId: job._id,
          activationId: activation._id,
          budgetReservationId:
            payload?.budgetReservationId
            ?? activation.budgetReservationId
            ?? null,
          jobStopGeneration: job.jobStopGeneration,
          recoveryAttempt:
            payload?.recoveryAttempt
            ?? job.stopControlRecoveryAttempt,
          chargedActiveMs: charged,
          retrySuppressed: true,
        },
        createdAt: failed.updatedAt,
      },
    },
    { session, upsert: true },
  );
  const sequence = await nextEventSeq(db, job._id, session);
  await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
    _id: `${job._id}:${sequence}`,
    jobId: job._id,
    sequence,
    type: 'StopControlRecoveryFailed',
    payload: {
      activationId: activation._id,
      reasonCode,
      recoveryAttempt:
        payload?.recoveryAttempt ?? job.stopControlRecoveryAttempt,
    },
    createdAt: failed.updatedAt,
  }, { session });
}

async function quarantineCurrentStopOwnerInSession(
  db: Db,
  session: ClientSession,
  job: JobDoc,
  activation: LaneActivationDoc,
  payload: StopControlRecoveryPayloadV1 | null,
  reasonCode: StopControlOwnerFailureReason,
  opts: { settleReservation?: boolean } = {},
): Promise<void> {
  const expectedReservationState = expectedLiveReservationState(activation);
  const structurallyValidReservation = expectedReservationState
    ? await loadStructurallyValidLiveReservationInSession(
        db,
        session,
        activation,
        expectedReservationState,
      )
    : null;
  const settlement =
    opts.settleReservation !== false && structurallyValidReservation
      ? await settleReservationInSession(
          db,
          session,
          activation,
          'FAILED',
        )
      : null;
  const settled = settlement?.doc ?? null;
  const canAccount =
    settled !== null
    && Number.isInteger(job.jobControlRecoveryReservedMs)
    && job.jobControlRecoveryReservedMs >= settled.allotmentMs
    && Number.isInteger(job.jobControlRecoveryConsumedMs)
    && job.jobControlRecoveryConsumedMs >= 0;
  await persistExpiredOwnerFailureInSession(
    db,
    session,
    job,
    activation,
    payload,
    reasonCode,
    canAccount ? settled : null,
    { requireExpired: false },
  );
}

/**
 * Replace an expired stop owner with the same stop-generation lineage. The
 * old reservation is charged/refunded exactly once before a successor gets a
 * fresh reservation; after three owners, one FAILED owner remains visible.
 */
export async function reapExpiredStopControlRecoveries(
  client: MongoClient,
  db: Db,
  opts: { limit?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? DEFAULT_STOP_CONTROL_REAP_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('stop-control reap limit must be a positive integer');
  }
  let reaped = 0;
  let authorityRetries = 0;
  while (
    reaped < limit
    && authorityRetries < MAX_AUTHORITY_RETRIES_PER_TICK
  ) {
    try {
      const { value } = await runTxn(client, async (session) => {
        const activations =
          db.collection<LaneActivationDoc>(COLLECTIONS.activations);
        const expired = await activations.findOne(
          expiredStopControlFilter(),
          { session, sort: { updatedAt: 1, _id: 1 } },
        );
        if (!expired) return 0;
        const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
          .findOne({ _id: expired.jobId }, { session });
        const payload = parseStopControlRecoveryPayload(
          expired.reducerPayload,
        );
        if (!job || job.activeActivationId !== expired._id) {
          const expectedReservationState =
            expectedLiveReservationState(expired);
          const structuralReservation = expectedReservationState
            ? await loadStructurallyValidLiveReservationInSession(
                db,
                session,
                expired,
                expectedReservationState,
              )
            : null;
          const orphanSettlement = structuralReservation
            ? await settleReservationInSession(
                db,
                session,
                expired,
                expired.lifecycle === 'PENDING' ? 'EXPIRED' : 'ABANDONED',
              )
            : null;
          const orphan = await activations.updateOne(
            {
              ...expiredStopControlFilter(),
              _id: expired._id,
              lifecycle: expired.lifecycle,
              activationFence: expired.activationFence,
            },
            [{
              $set: {
                lifecycle: 'ABANDONED',
                activeSlot: false,
                leaseOwner: null,
                leaseExpiresAt: null,
                activationFence: { $add: ['$activationFence', 1] },
                reasonCode: 'stop_control_recovery_orphan',
                updatedAt: '$$NOW',
              },
            }],
            { session },
          );
          if (orphan.modifiedCount !== 1) {
            throw new StopControlRecoveryAuthorityLostError(
              'stop-control orphan reap CAS lost',
            );
          }
          const competingLiveReservation = job
            ? await db.collection<BudgetReservationDoc>(
                COLLECTIONS.budgetReservations,
              ).findOne(
                {
                  jobId: job._id,
                  ownerId: { $ne: expired._id },
                  state: { $in: ['RESERVED', 'ACTIVE'] },
                },
                { session, projection: { _id: 1 } },
              )
            : null;
          const canAccountOrphan =
            job !== null
            && validControlBudget(job)
            && job.activeActivationId === null
            && orphanSettlement?.newlySettled === true
            && job.jobControlRecoveryReservedMs
              === orphanSettlement.doc.allotmentMs
            && competingLiveReservation === null;
          if (job && orphanSettlement?.newlySettled && canAccountOrphan) {
            const settled = orphanSettlement.doc;
            const accounting = await db.collection<JobDoc>(COLLECTIONS.jobs)
              .updateOne(
                {
                  _id: job._id,
                  stateVersion: job.stateVersion,
                  activeActivationId: null,
                  jobControlRecoveryReservedMs: settled.allotmentMs,
                },
                [{
                  $set: {
                    jobControlRecoveryReservedMs: {
                      $subtract: [
                        '$jobControlRecoveryReservedMs',
                        settled.allotmentMs,
                      ],
                    },
                    jobControlRecoveryConsumedMs: {
                      $add: [
                        '$jobControlRecoveryConsumedMs',
                        settled.chargedActiveMs,
                      ],
                    },
                    stateVersion: { $add: ['$stateVersion', 1] },
                    updatedAt: { $literal: settled.settledAt },
                  },
                }],
                { session },
              );
            if (accounting.modifiedCount !== 1) {
              throw new StopControlRecoveryAuthorityLostError(
                'stop-control orphan accounting CAS lost',
              );
            }
          } else if (job) {
            const alertId = [
              'obx_stop_control_orphan_quarantined',
              job._id,
              expired._id,
            ].join(':');
            const alertType = validControlBudget(job)
              ? 'stop_control_recovery_reservation_invalid'
              : 'control_recovery_policy_invalid';
            await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
              { _id: alertId },
              {
                $setOnInsert: {
                  _id: alertId,
                  aggregate: job._id,
                  type: 'OperatorAlertRequested',
                  state: 'PENDING',
                  payload: {
                    alertType,
                    resourceId: job.resourceId,
                    conversationId: job.conversationId,
                    jobId: job._id,
                    activationId: expired._id,
                    budgetReservationId:
                      expired.budgetReservationId,
                    retrySuppressed: true,
                  },
                  createdAt: new Date(),
                },
              },
              { session, upsert: true },
            );
          }
          return 1;
        }
        const expectedJobState = expired.lifecycle === 'PENDING'
          ? 'PENDING'
          : 'ACTIVE';
        const expectedReservationState = expired.lifecycle === 'PENDING'
          ? 'RESERVED'
          : 'ACTIVE';
        const preflight = await preflightCurrentStopOwnerInSession(
          db,
          session,
          expired,
          payload,
          expectedJobState,
          expectedReservationState,
        );
        if (!preflight) return 1;
        const {
          job: currentJob,
          payload: validPayload,
        } = preflight;
        const settlement = await settleReservationInSession(
          db,
          session,
          expired,
          expired.lifecycle === 'PENDING' ? 'EXPIRED' : 'ABANDONED',
        );
        if (!settlement?.newlySettled) {
          await persistExpiredOwnerFailureInSession(
            db,
            session,
            currentJob,
            expired,
            validPayload,
            'stop_control_recovery_reservation_invalid',
          );
          return 1;
        }
        const settled = settlement.doc;
        const nextAttempt = validPayload.recoveryAttempt + 1;
        const reservedAfter =
          currentJob.jobControlRecoveryReservedMs - settled.allotmentMs;
        const consumedAfter =
          currentJob.jobControlRecoveryConsumedMs + settled.chargedActiveMs;
        const availableAfter =
          currentJob.jobControlRecoveryReserveMs
          - reservedAfter
          - consumedAfter;
        if (
          validPayload.recoveryAttempt
            >= CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
          || nextAttempt > CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
          || availableAfter
            < CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
        ) {
          await persistExpiredOwnerFailureInSession(
            db,
            session,
            currentJob,
            expired,
            validPayload,
            validPayload.recoveryAttempt
                >= CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
              ? 'stop_control_recovery_exhausted'
              : 'control_recovery_reserve_exhausted',
            settled,
          );
          return 1;
        }

        const abandoned = await activations.findOneAndUpdate(
          {
            ...expiredStopControlFilter(),
            _id: expired._id,
            lifecycle: expired.lifecycle,
            activationFence: expired.activationFence,
          },
          [{
            $set: {
              lifecycle: 'ABANDONED',
              activeSlot: false,
              leaseOwner: null,
              leaseExpiresAt: null,
              activationFence: { $add: ['$activationFence', 1] },
              reasonCode: 'stop_control_recovery_lost',
              updatedAt: { $literal: settled.settledAt },
            },
          }],
          { session, returnDocument: 'after' },
        );
        if (!abandoned) {
          throw new StopControlRecoveryAuthorityLostError(
            'stop-control lost owner CAS lost',
          );
        }
        const nextGeneration =
          currentJob.activationDispatchGeneration + 1;
        const nextActivationId = stopActivationId(
          currentJob._id,
          currentJob.jobStopGeneration,
          validPayload.barrierProbeAttempt,
          nextAttempt,
          nextGeneration,
        );
        const nextReservationId = stopReservationId(
          currentJob._id,
          currentJob.jobStopGeneration,
          validPayload.barrierProbeAttempt,
          nextAttempt,
          nextGeneration,
        );
        const wakeId = stopWakeId(nextActivationId);
        const window = controlWindow(settled.settledAt!);
        const nextPayload: StopControlRecoveryPayloadV1 = {
          ...validPayload,
          activationDispatchGeneration: nextGeneration,
          recoveryAttempt: nextAttempt,
          budgetReservationId: nextReservationId,
        };
        const nextPayloadHash = canonicalHash(nextPayload);
        const jobHandoff = await db.collection<JobDoc>(COLLECTIONS.jobs)
          .findOneAndUpdate(
            {
              _id: currentJob._id,
              stateVersion: currentJob.stateVersion,
              activeActivationId: expired._id,
              jobStopGeneration: validPayload.jobStopGeneration,
              activationDispatchGeneration:
                validPayload.activationDispatchGeneration,
              stopControlRecoveryAttempt: validPayload.recoveryAttempt,
              stopControlRecoveryState: {
                $in: ['PENDING', 'ACTIVE'],
              },
              jobControlRecoveryReservedMs: settled.allotmentMs,
            },
            [{
              $set: {
                activeActivationId: nextActivationId,
                activationDispatchGeneration: nextGeneration,
                stopControlRecoveryAttempt: nextAttempt,
                stopControlRecoveryState: 'PENDING',
                jobControlRecoveryReservedMs: {
                  $add: [
                    {
                      $subtract: [
                        '$jobControlRecoveryReservedMs',
                        settled.allotmentMs,
                      ],
                    },
                    CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
                  ],
                },
                jobControlRecoveryConsumedMs: {
                  $add: [
                    '$jobControlRecoveryConsumedMs',
                    settled.chargedActiveMs,
                  ],
                },
                stateVersion: { $add: ['$stateVersion', 1] },
                updatedAt: { $literal: settled.settledAt },
              },
            }],
            { session, returnDocument: 'after' },
          );
        if (!jobHandoff) {
          throw new StopControlRecoveryAuthorityLostError(
            'stop-control successor job CAS lost',
          );
        }
        await db.collection<BudgetReservationDoc>(
          COLLECTIONS.budgetReservations,
        ).insertOne({
          _id: nextReservationId,
          jobId: currentJob._id,
          jobStopGeneration: currentJob.jobStopGeneration,
          activationDispatchGeneration: nextGeneration,
          pool: 'JOB_CONTROL_RECOVERY',
          ownerKind: 'ACTIVATION',
          ownerId: nextActivationId,
          policyVersion: currentJob.controlBudgetPolicyVersion,
          state: 'RESERVED',
          allotmentMs: CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
          reservedAt: settled.settledAt!,
          expiresAt: window.hardDeadlineAt,
          activatedAt: null,
          settledAt: null,
          chargedActiveMs: 0,
          refundedMs: 0,
          settlementReason: null,
        }, { session });
        await activations.insertOne({
          _id: nextActivationId,
          sourceWakeId: wakeId,
          jobId: currentJob._id,
          kind: 'CONTROL_RECOVERY',
          lifecycle: 'PENDING',
          activeSlot: true,
          activationDispatchGenerationAtClaim: nextGeneration,
          planVersionAtClaim: currentJob.planVersion,
          jobStopGenerationAtClaim: currentJob.jobStopGeneration,
          leaseOwner: null,
          leaseExpiresAt: null,
          activationFence: 0,
          operationStartedAt: null,
          businessOperationCutoffAt: window.businessOperationCutoffAt,
          workDeadlineAt: window.workDeadlineAt,
          hardDeadlineAt: window.hardDeadlineAt,
          purposeAttemptIds: [],
          batchInboxItemIds: [],
          batchThroughWatermark: currentJob.resolvedInboxWatermark,
          inboxHighWatermarkAtClaim: currentJob.inboxHighWatermark,
          appliedInboxWatermarkAtClaim: currentJob.appliedInboxWatermark,
          resolvedInboxWatermarkAtClaim: currentJob.resolvedInboxWatermark,
          businessPayloadReadyGeneration: 0,
          businessPayloadReadyHash: null,
          businessPayloadReadyAt: null,
          reducerPayload: nextPayload,
          controlSubtype: 'STOP_TERMINAL',
          reducerPayloadHash: nextPayloadHash,
          budgetReservationId: nextReservationId,
          budgetPool: 'JOB_CONTROL_RECOVERY',
          activationActiveAllotmentMs:
            CONTROL_BUDGET_POLICY_V1.activationAllotmentMs,
          committedPayloadHash: null,
          committedAppliedInboxWatermark: null,
          committedResolvedInboxWatermark: null,
          successorWakeId: null,
          committedAt: null,
          outcome: null,
          reasonCode: null,
          createdAt: settled.settledAt!,
          updatedAt: settled.settledAt!,
        }, { session });
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
          _id: wakeId,
          aggregate: currentJob._id,
          type: 'StopControlRecoveryRequested',
          state: 'PENDING',
          payload: {
            jobId: currentJob._id,
            activationId: nextActivationId,
            budgetReservationId: nextReservationId,
            jobStopGeneration: currentJob.jobStopGeneration,
            activationDispatchGeneration: nextGeneration,
            barrierProbeAttempt: validPayload.barrierProbeAttempt,
            recoveryAttempt: nextAttempt,
            recoveredFromActivationId: expired._id,
          },
          createdAt: settled.settledAt!,
        }, { session });
        const sequence = await nextEventSeq(db, currentJob._id, session);
        await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
          _id: `${currentJob._id}:${sequence}`,
          jobId: currentJob._id,
          sequence,
          type: 'StopControlRecoveryRecovered',
          payload: {
            lostActivationId: expired._id,
            activationId: nextActivationId,
            oldBudgetReservationId: validPayload.budgetReservationId,
            budgetReservationId: nextReservationId,
            recoveryAttempt: nextAttempt,
            chargedActiveMs: settled.chargedActiveMs,
            refundedMs: settled.refundedMs,
          },
          createdAt: settled.settledAt!,
        }, { session });
        return 1;
      });
      if (value === 0) break;
      reaped += value;
      authorityRetries = 0;
    } catch (error) {
      if (error instanceof StopControlRecoveryAuthorityLostError) {
        authorityRetries++;
        continue;
      }
      throw error;
    }
  }
  return reaped;
}

/**
 * Compatibility façade for callers/tests that historically invoked the flat
 * reducer directly. It still traverses reserve → claim → start → owned commit.
 */
export async function reducePendingFlatTerminalThroughControl(
  client: MongoClient,
  db: Db,
  jobId: string,
  opts: { makeEligibleNow?: boolean } = {},
): Promise<FlatTerminalReductionResult> {
  const before = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .findOne({ _id: jobId });
  if (!before) {
    return {
      jobId,
      status: 'not_applicable',
      outcome: null,
      blocker: null,
    };
  }
  if (before.terminalOutcome !== null) {
    return {
      jobId,
      status: 'already_terminal',
      outcome: before.terminalOutcome,
      blocker: null,
    };
  }
  if (before.terminalBarrierMode === 'BLOCKED_UNSUPPORTED') {
    return {
      jobId,
      status: 'blocked',
      outcome: null,
      blocker:
        before.terminalBarrierBlocker ?? 'unsupported_flat_terminal_shape',
    };
  }
  if (
    before.controlState !== 'STOP_REQUESTED'
    || before.phase !== 'RECONCILING'
    || !before.pendingTerminalOutcome
    || !before.primaryJobStopCause
    || before.jobStopGeneration <= 0
    || before.terminalBarrierMode !== 'FLAT_STOP_V1'
  ) {
    return {
      jobId,
      status: 'not_applicable',
      outcome: null,
      blocker: null,
    };
  }
  const owner = await ensureStopControlRecovery(
    client,
    db,
    jobId,
    { makeEligibleNow: opts.makeEligibleNow === true },
  );
  if (owner) {
    const committed = await runStopControlRecoveryActivation(
      client,
      db,
      owner.activationId,
    );
    if (committed) return committed.reduction;
  }
  const after = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .findOne({ _id: jobId });
  if (after?.terminalOutcome !== null && after?.terminalOutcome !== undefined) {
    return {
      jobId,
      status: 'already_terminal',
      outcome: after.terminalOutcome,
      blocker: null,
    };
  }
  if (after?.terminalBarrierMode === 'BLOCKED_UNSUPPORTED') {
    return {
      jobId,
      status: 'blocked',
      outcome: null,
      blocker:
        after.terminalBarrierBlocker ?? 'unsupported_flat_terminal_shape',
    };
  }
  return {
    jobId,
    status: after?.stopControlRecoveryState === 'EXHAUSTED'
      ? 'blocked'
      : 'waiting',
    outcome: null,
    blocker: after?.stopControlRecoveryState === 'EXHAUSTED'
      ? after.terminalBarrierBlocker
        ?? 'control_recovery_exhausted'
      : null,
  };
}

export function isStopControlReductionStatus(
  value: string,
): value is FlatTerminalReductionStatus {
  return [
    'terminalized',
    'waiting',
    'blocked',
    'already_terminal',
    'not_applicable',
  ].includes(value);
}
