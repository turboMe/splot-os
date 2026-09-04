/**
 * Typed CONTROL_RECOVERY activation for lost BUSINESS / RESULT_DRAIN owners.
 *
 * This is deliberately a control-only slice. R0 atomically fences the lost
 * activation and hands the unique job slot to a fresh CONTROL_RECOVERY
 * activation plus a distinct ControlRecoveryRequested outbox record. R1
 * re-checks durable demand, settles only the control activation/job slot and
 * emits at most one ordinary lane wake. It never applies a result, mutates a
 * task, or decides a terminal outcome.
 */
import { randomUUID } from 'node:crypto';
import type { ClientSession, Db, Filter, MongoClient } from 'mongodb';
import { newActivationId } from '../contracts/index.js';
import { canonicalHash, runTxn } from './txn.js';
import {
  COLLECTIONS,
  type JobDoc,
  type JobEventDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type TaskDoc,
} from './collections.js';
import { findNextEligibleResultDrainInboxItem } from './result-drain.js';

const DEFAULT_CONTROL_LEASE_TTL_MS = 10_000;
const DEFAULT_CONTROL_CAP_MS = 30_000;
const DEFAULT_CONTROL_COMMIT_RESERVE_MS = 2_000;
const MAX_CONTROL_RECOVERY_ATTEMPTS = 3;
const CONTROL_FALLBACK_SCAN_LIMIT = 32;
const MAX_CONTROL_WAKE_SCANS_PER_TICK = 128;
const MAX_CONTROL_DRAINS_PER_TICK = 128;
const MAX_CONTROL_REAPS_PER_TICK = 128;
const MAX_CONTROL_AUTHORITY_RETRIES_PER_TICK = 32;
const ACTIVE_CONTROL_LIFECYCLES: LaneActivationDoc['lifecycle'][] = [
  'PENDING',
  'LEASED',
  'RUNNING',
  'FAILED',
];
const RECOVERABLE_ROOT_KINDS = ['BUSINESS', 'RESULT_DRAIN'] as const;
type RecoverableRootKind = (typeof RECOVERABLE_ROOT_KINDS)[number];

export interface ControlRecoveryReducerPayloadV1 extends Record<string, unknown> {
  kind: 'RECOVER_LOST_ACTIVATION_V1';
  lostActivationId: string;
  lostActivationKind: LaneActivationDoc['kind'];
  lostActivationFence: number;
  rootActivationId: string;
  rootActivationKind: RecoverableRootKind;
  recoveryAttempt: number;
  recoveryMaxAttempts: number;
}

export interface ControlRecoveryLeaseHandle {
  activationId: string;
  jobId: string;
  kind: 'CONTROL_RECOVERY';
  leaseOwner: string;
  activationFence: number;
  leaseExpiresAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
}

export interface ControlRecoveryCommitResult {
  activationId: string;
  jobId: string;
  rootActivationId: string;
  rootActivationKind: RecoverableRootKind;
  recoveryAttempt: number;
  successorWakeId: string | null;
  deduped: boolean;
}

export interface ControlRecoveryDrainResult {
  claimed: number;
  committed: number;
}

class ControlRecoveryAuthorityLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlRecoveryAuthorityLostError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOrdinaryControlRecoveryEnvelope(
  activation: LaneActivationDoc,
): boolean {
  return (activation.controlSubtype ?? null) === null
    && (activation.budgetReservationId ?? null) === null
    && (activation.budgetPool ?? null) === null
    && (activation.activationActiveAllotmentMs ?? null) === null;
}

export function parseControlRecoveryPayload(
  value: unknown,
): ControlRecoveryReducerPayloadV1 | null {
  if (!isRecord(value) || value.kind !== 'RECOVER_LOST_ACTIVATION_V1') return null;
  if (
    typeof value.lostActivationId !== 'string'
    || value.lostActivationId.length === 0
    || typeof value.lostActivationKind !== 'string'
    || !['BUSINESS', 'RESULT_DRAIN', 'CONTROL_RECOVERY'].includes(
      value.lostActivationKind,
    )
    || typeof value.lostActivationFence !== 'number'
    || !Number.isInteger(value.lostActivationFence)
    || value.lostActivationFence < 0
    || typeof value.rootActivationId !== 'string'
    || value.rootActivationId.length === 0
    || !RECOVERABLE_ROOT_KINDS.includes(
      value.rootActivationKind as RecoverableRootKind,
    )
    || typeof value.recoveryAttempt !== 'number'
    || !Number.isInteger(value.recoveryAttempt)
    || value.recoveryAttempt < 1
    || value.recoveryAttempt > MAX_CONTROL_RECOVERY_ATTEMPTS
    || typeof value.recoveryMaxAttempts !== 'number'
    || !Number.isInteger(value.recoveryMaxAttempts)
    || value.recoveryMaxAttempts !== MAX_CONTROL_RECOVERY_ATTEMPTS
  ) return null;
  return value as ControlRecoveryReducerPayloadV1;
}

function nextControlWindow(at: Date): {
  businessOperationCutoffAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
} {
  const hardDeadlineAt = new Date(at.getTime() + DEFAULT_CONTROL_CAP_MS);
  const workDeadlineAt = new Date(
    hardDeadlineAt.getTime() - DEFAULT_CONTROL_COMMIT_RESERVE_MS,
  );
  // CONTROL_RECOVERY performs no business work. The common activation field is
  // pinned to the reducer deadline so generic schema/readers remain compatible.
  return {
    businessOperationCutoffAt: workDeadlineAt,
    workDeadlineAt,
    hardDeadlineAt,
  };
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

function expiredActivationFilter(): Filter<LaneActivationDoc> {
  return {
    activeSlot: true,
    kind: { $in: ['BUSINESS', 'RESULT_DRAIN', 'CONTROL_RECOVERY'] },
    $nor: [
      // STOP_CONTROL_RECOVERY_V1 has its own reservation-aware reaper. Treating
      // it as RECOVER_LOST_ACTIVATION_V1 would corrupt lineage and leak budget.
      { 'reducerPayload.kind': 'STOP_CONTROL_RECOVERY_V1' },
      { controlSubtype: 'STOP_TERMINAL' },
      { budgetPool: 'JOB_CONTROL_RECOVERY' },
      { budgetReservationId: { $type: 'string' } },
      {
        lifecycle: 'FAILED',
        reasonCode: {
          $in: [
            'control_recovery_exhausted',
            'control_recovery_payload_invalid',
            'control_recovery_lineage_invalid',
            'activation_recovery_exhausted',
            'activation_recovery_authority_mismatch',
            'activation_recovery_ambiguous_business_effect',
          ],
        },
      },
    ],
    $or: [
      {
        lifecycle: 'PENDING',
        $expr: {
          $or: [
            { $lte: ['$businessOperationCutoffAt', '$$NOW'] },
            { $lte: ['$hardDeadlineAt', '$$NOW'] },
          ],
        },
      },
      {
        lifecycle: 'LEASED',
        $expr: {
          $or: [
            { $lte: ['$leaseExpiresAt', '$$NOW'] },
            { $lte: ['$businessOperationCutoffAt', '$$NOW'] },
            { $lte: ['$hardDeadlineAt', '$$NOW'] },
          ],
        },
      },
      {
        lifecycle: 'RUNNING',
        $expr: {
          $or: [
            { $lte: ['$leaseExpiresAt', '$$NOW'] },
            { $lte: ['$hardDeadlineAt', '$$NOW'] },
            {
              $and: [
                { $eq: ['$businessPayloadReadyGeneration', 0] },
                { $lte: ['$businessOperationCutoffAt', '$$NOW'] },
              ],
            },
            {
              $and: [
                { $gt: ['$businessPayloadReadyGeneration', 0] },
                { $lte: ['$workDeadlineAt', '$$NOW'] },
              ],
            },
          ],
        },
      },
      { lifecycle: 'FAILED' },
    ],
  } as unknown as Filter<LaneActivationDoc>;
}

interface RecoveryLineage {
  rootActivationId: string;
  rootActivationKind: RecoverableRootKind;
  recoveryAttempt: number;
  recoveryMaxAttempts: number;
}

type RecoveryOperatorReason =
  | 'control_recovery_exhausted'
  | 'control_recovery_payload_invalid'
  | 'control_recovery_lineage_invalid'
  | 'activation_recovery_exhausted'
  | 'activation_recovery_authority_mismatch'
  | 'activation_recovery_ambiguous_business_effect';

function jobRecoveryRoot(
  job: JobDoc,
): { id: string; kind: RecoverableRootKind } | null {
  if (
    typeof job.activationRecoveryRootId !== 'string'
    || job.activationRecoveryRootId.length === 0
    || !RECOVERABLE_ROOT_KINDS.includes(
      job.activationRecoveryRootKind as RecoverableRootKind,
    )
  ) return null;
  return {
    id: job.activationRecoveryRootId,
    kind: job.activationRecoveryRootKind as RecoverableRootKind,
  };
}

function hasCommittedControlEvidence(
  activation: LaneActivationDoc,
  payload: ControlRecoveryReducerPayloadV1,
): boolean {
  return activation.kind === 'CONTROL_RECOVERY'
    && activation.lifecycle === 'COMMITTED'
    && activation.activeSlot === false
    && activation.leaseOwner === null
    && activation.leaseExpiresAt === null
    && activation.committedAt instanceof Date
    && activation.committedPayloadHash === canonicalHash(payload);
}

function recoverySuccessorWakeId(
  payload: ControlRecoveryReducerPayloadV1,
): string {
  const prefix = payload.rootActivationKind === 'BUSINESS'
    ? 'obx_activation_recovery'
    : 'obx_result_drain_recovery';
  return `${prefix}:${payload.rootActivationId}${
    payload.recoveryAttempt === 1 ? '' : `:${payload.recoveryAttempt}`
  }`;
}

async function findCommittedRecoveryPredecessor(
  db: Db,
  jobId: string,
  recoveryAttempt: number,
  rootActivationId: string,
  rootActivationKind: RecoverableRootKind,
  session: ClientSession,
): Promise<{
  activation: LaneActivationDoc;
  payload: ControlRecoveryReducerPayloadV1;
} | null> {
  const candidates = await db.collection<LaneActivationDoc>(COLLECTIONS.activations)
    .find({
      jobId,
      kind: 'CONTROL_RECOVERY',
      lifecycle: 'COMMITTED',
      activeSlot: false,
      'reducerPayload.kind': 'RECOVER_LOST_ACTIVATION_V1',
      'reducerPayload.recoveryAttempt': recoveryAttempt,
      'reducerPayload.rootActivationId': rootActivationId,
      'reducerPayload.rootActivationKind': rootActivationKind,
    }, { session })
    .limit(2)
    .toArray();
  const valid = candidates.flatMap((activation) => {
    const payload = parseControlRecoveryPayload(activation.reducerPayload);
    return payload
      && hasOrdinaryControlRecoveryEnvelope(activation)
      && hasCommittedControlEvidence(activation, payload)
      ? [{ activation, payload }]
      : [];
  });
  return candidates.length === 1 && valid.length === 1 ? valid[0]! : null;
}

/**
 * Prove the bounded chain all the way back to its exact abandoned ordinary
 * root. A retry can follow either an expired CONTROL_RECOVERY owner or an
 * ordinary recovery successor; the latter is linked through the unique
 * committed predecessor for the job/root/recovery-attempt tuple.
 */
async function validateControlRecoveryLineage(
  db: Db,
  control: LaneActivationDoc,
  payload: ControlRecoveryReducerPayloadV1,
  session: ClientSession,
): Promise<boolean> {
  if (
    control.kind !== 'CONTROL_RECOVERY'
    || !hasOrdinaryControlRecoveryEnvelope(control)
    || control.jobId.length === 0
    || payload.recoveryAttempt < 1
    || payload.recoveryAttempt > MAX_CONTROL_RECOVERY_ATTEMPTS
  ) return false;

  const lost = await db.collection<LaneActivationDoc>(COLLECTIONS.activations)
    .findOne({
      _id: payload.lostActivationId,
      jobId: control.jobId,
      kind: payload.lostActivationKind,
      lifecycle: 'ABANDONED',
      activeSlot: false,
      activationFence: payload.lostActivationFence,
      reasonCode: 'activation_lost',
    }, { session });
  if (!lost) return false;

  if (payload.recoveryAttempt === 1) {
    return lost._id === payload.rootActivationId
      && lost.kind === payload.rootActivationKind;
  }

  let predecessor: LaneActivationDoc | null = null;
  if (lost.kind === 'CONTROL_RECOVERY') {
    predecessor = lost;
  } else if (lost.kind === payload.rootActivationKind) {
    predecessor = (
      await findCommittedRecoveryPredecessor(
        db,
        control.jobId,
        payload.recoveryAttempt - 1,
        payload.rootActivationId,
        payload.rootActivationKind,
        session,
      )
    )?.activation ?? null;
  }
  if (!predecessor) return false;

  const predecessorPayload = parseControlRecoveryPayload(
    predecessor.reducerPayload,
  );
  if (
    !predecessorPayload
    || predecessorPayload.recoveryAttempt !== payload.recoveryAttempt - 1
    || predecessorPayload.recoveryMaxAttempts !== payload.recoveryMaxAttempts
    || predecessorPayload.rootActivationId !== payload.rootActivationId
    || predecessorPayload.rootActivationKind !== payload.rootActivationKind
    || (
      predecessor.lifecycle === 'COMMITTED'
      && !hasCommittedControlEvidence(predecessor, predecessorPayload)
    )
  ) return false;

  return validateControlRecoveryLineage(
    db,
    predecessor,
    predecessorPayload,
    session,
  );
}

async function deriveRecoveryLineage(
  db: Db,
  lost: LaneActivationDoc,
  job: JobDoc,
  previousRecoveryAttempt: number,
  session: ClientSession,
): Promise<RecoveryLineage | null> {
  const recoveryAttempt = previousRecoveryAttempt + 1;
  if (lost.kind === 'CONTROL_RECOVERY') {
    const previous = parseControlRecoveryPayload(lost.reducerPayload);
    const root = jobRecoveryRoot(job);
    if (
      !previous
      || previous.recoveryAttempt !== previousRecoveryAttempt
      || !root
      || previous.rootActivationId !== root.id
      || previous.rootActivationKind !== root.kind
      || !await validateControlRecoveryLineage(db, lost, previous, session)
    ) return null;
    return {
      rootActivationId: previous.rootActivationId,
      rootActivationKind: previous.rootActivationKind,
      recoveryAttempt,
      recoveryMaxAttempts: MAX_CONTROL_RECOVERY_ATTEMPTS,
    };
  }

  if (lost.kind !== 'BUSINESS' && lost.kind !== 'RESULT_DRAIN') return null;
  if (previousRecoveryAttempt === 0) {
    if (
      job.activationRecoveryRootId != null
      || job.activationRecoveryRootKind != null
    ) return null;
    return {
      rootActivationId: lost._id,
      rootActivationKind: lost.kind,
      recoveryAttempt,
      recoveryMaxAttempts: MAX_CONTROL_RECOVERY_ATTEMPTS,
    };
  }

  const root = jobRecoveryRoot(job);
  if (
    !root
    || root.kind !== lost.kind
  ) return null;
  const predecessorEvidence = await findCommittedRecoveryPredecessor(
    db,
    job._id,
    previousRecoveryAttempt,
    root.id,
    root.kind,
    session,
  );
  const predecessor = predecessorEvidence?.activation ?? null;
  const predecessorPayload = predecessorEvidence?.payload ?? null;
  if (
    !predecessor
    || !predecessorPayload
    || predecessorPayload.recoveryAttempt !== previousRecoveryAttempt
    || predecessorPayload.rootActivationId !== root.id
    || predecessorPayload.rootActivationKind !== root.kind
    || !await validateControlRecoveryLineage(
      db,
      predecessor,
      predecessorPayload,
      session,
    )
  ) return null;
  return {
    rootActivationId: root.id,
    rootActivationKind: root.kind,
    recoveryAttempt,
    recoveryMaxAttempts: MAX_CONTROL_RECOVERY_ATTEMPTS,
  };
}

async function failActivationRecoveryForOperator(
  db: Db,
  lost: LaneActivationDoc,
  job: JobDoc,
  session: ClientSession,
  reasonCode: RecoveryOperatorReason,
): Promise<void> {
  const failed = await db.collection<LaneActivationDoc>(COLLECTIONS.activations)
    .findOneAndUpdate(
      {
        ...expiredActivationFilter(),
        _id: lost._id,
        jobId: lost.jobId,
        kind: lost.kind,
        activeSlot: true,
        activationFence: lost.activationFence,
        lifecycle: lost.lifecycle,
      },
      [{
        $set: {
          lifecycle: 'FAILED',
          activeSlot: true,
          leaseOwner: null,
          leaseExpiresAt: null,
          reasonCode,
          activationFence: { $add: ['$activationFence', 1] },
          updatedAt: '$$NOW',
        },
      }],
      { session, returnDocument: 'after' },
    );
  if (!failed) throw new ControlRecoveryAuthorityLostError('control failure CAS lost');
  const jobTouch = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
    {
      _id: job._id,
      stateVersion: job.stateVersion,
      activeActivationId: lost._id,
      activationDispatchGeneration: job.activationDispatchGeneration,
    },
    {
      $set: { updatedAt: failed.updatedAt },
      $inc: { stateVersion: 1 },
    },
    { session },
  );
  if (jobTouch.modifiedCount !== 1) {
    throw new ControlRecoveryAuthorityLostError('control failure job CAS lost');
  }
  const sequence = await nextEventSeq(db, job._id, session);
  await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
    _id: `${job._id}:${sequence}`,
    jobId: job._id,
    sequence,
    type: 'LaneControlRecoveryFailed',
    payload: {
      activationId: lost._id,
      reasonCode,
      recoveryAttempt:
        parseControlRecoveryPayload(lost.reducerPayload)?.recoveryAttempt ?? null,
    },
    createdAt: failed.updatedAt,
  }, { session });
  await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
    _id: `obx_control_recovery_alert:${lost._id}`,
    aggregate: job._id,
    type: 'OperatorAlertRequested',
    state: 'PENDING',
    payload: {
      alertType: reasonCode,
      resourceId: job.resourceId,
      conversationId: job.conversationId,
      jobId: job._id,
      activationId: lost._id,
      recoveryAttempt:
        parseControlRecoveryPayload(lost.reducerPayload)?.recoveryAttempt
        ?? job.activationRecoveryAttempt
        ?? 0,
    },
    createdAt: failed.updatedAt,
  }, { session });
}

/**
 * R0: atomically replace one expired active activation with a typed control
 * owner. The distinct outbox type cannot be consumed as ordinary business work.
 */
export async function reapExpiredActivationsToControlRecovery(
  client: MongoClient,
  db: Db,
): Promise<number> {
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  let reaped = 0;
  let authorityRetries = 0;

  while (
    reaped < MAX_CONTROL_REAPS_PER_TICK
    && authorityRetries < MAX_CONTROL_AUTHORITY_RETRIES_PER_TICK
  ) {
    try {
      const { value } = await runTxn(client, async (session) => {
        const lost = await activations.findOne(
          expiredActivationFilter(),
          { session, sort: { createdAt: 1 } },
        );
        if (!lost) return 0;
        const job = await jobs.findOne({ _id: lost.jobId }, { session });
        if (!job || job.activeActivationId !== lost._id) {
          const orphan = await activations.updateOne(
            {
              ...expiredActivationFilter(),
              _id: lost._id,
              activeSlot: true,
              activationFence: lost.activationFence,
              lifecycle: lost.lifecycle,
            },
            [{
              $set: {
                lifecycle: 'ABANDONED',
                activeSlot: false,
                leaseOwner: null,
                leaseExpiresAt: null,
                reasonCode: 'activation_lost_orphan',
                activationFence: { $add: ['$activationFence', 1] },
                updatedAt: '$$NOW',
              },
            }],
            { session },
          );
          if (orphan.modifiedCount !== 1) {
            throw new ControlRecoveryAuthorityLostError('orphan reap CAS lost');
          }
          return 1;
        }

        const generationMatches =
          lost.planVersionAtClaim === job.planVersion
          && lost.jobStopGenerationAtClaim === job.jobStopGeneration
          && lost.activationDispatchGenerationAtClaim
            === job.activationDispatchGeneration
          && (
            lost.activationFence === 0
            || lost.activationFence === job.activationFence
          );
        if (!generationMatches) {
          await failActivationRecoveryForOperator(
            db,
            lost,
            job,
            session,
            'activation_recovery_authority_mismatch',
          );
          return 1;
        }
        if (
          lost.kind === 'BUSINESS'
          && (
            lost.lifecycle === 'RUNNING'
            || lost.lifecycle === 'FAILED'
            || lost.operationStartedAt !== null
            || lost.businessPayloadReadyGeneration > 0
          )
        ) {
          await failActivationRecoveryForOperator(
            db,
            lost,
            job,
            session,
            'activation_recovery_ambiguous_business_effect',
          );
          return 1;
        }

        const persistedRecoveryAttempt = job.activationRecoveryAttempt ?? 0;
        const previousRecoveryAttempt =
          Number.isInteger(persistedRecoveryAttempt)
          && persistedRecoveryAttempt >= 0
            && persistedRecoveryAttempt <= MAX_CONTROL_RECOVERY_ATTEMPTS
            ? persistedRecoveryAttempt
            : -1;
        if (previousRecoveryAttempt >= MAX_CONTROL_RECOVERY_ATTEMPTS) {
          await failActivationRecoveryForOperator(
            db,
            lost,
            job,
            session,
            lost.kind === 'CONTROL_RECOVERY'
              ? 'control_recovery_exhausted'
              : 'activation_recovery_exhausted',
          );
          return 1;
        }
        const lineage = previousRecoveryAttempt >= 0
          ? await deriveRecoveryLineage(
              db,
              lost,
              job,
              previousRecoveryAttempt,
              session,
            )
          : null;
        if (!lineage) {
          await failActivationRecoveryForOperator(
            db,
            lost,
            job,
            session,
            lost.kind === 'CONTROL_RECOVERY'
              ? 'control_recovery_payload_invalid'
              : 'activation_recovery_authority_mismatch',
          );
          return 1;
        }

        const abandoned = await activations.findOneAndUpdate(
          {
            ...expiredActivationFilter(),
            _id: lost._id,
            jobId: lost.jobId,
            activeSlot: true,
            activationFence: lost.activationFence,
            lifecycle: lost.lifecycle,
          },
          [{
            $set: {
              lifecycle: 'ABANDONED',
              activeSlot: false,
              leaseOwner: null,
              leaseExpiresAt: null,
              reasonCode: 'activation_lost',
              activationFence: { $add: ['$activationFence', 1] },
              updatedAt: '$$NOW',
            },
          }],
          { session, returnDocument: 'after' },
        );
        if (!abandoned) {
          throw new ControlRecoveryAuthorityLostError('lost activation fence CAS lost');
        }

        const recoveryId = newActivationId();
        const wakeId = `obx_control_recovery:${abandoned._id}:${lineage.recoveryAttempt}`;
        const nextGeneration = job.activationDispatchGeneration + 1;
        const payload: ControlRecoveryReducerPayloadV1 = {
          kind: 'RECOVER_LOST_ACTIVATION_V1',
          lostActivationId: abandoned._id,
          lostActivationKind: abandoned.kind,
          lostActivationFence: abandoned.activationFence,
          rootActivationId: lineage.rootActivationId,
          rootActivationKind: lineage.rootActivationKind,
          recoveryAttempt: lineage.recoveryAttempt,
          recoveryMaxAttempts: lineage.recoveryMaxAttempts,
        };
        const window = nextControlWindow(abandoned.updatedAt);
        const recovery: LaneActivationDoc = {
          _id: recoveryId,
          sourceWakeId: wakeId,
          jobId: job._id,
          kind: 'CONTROL_RECOVERY',
          lifecycle: 'PENDING',
          activeSlot: true,
          activationDispatchGenerationAtClaim: nextGeneration,
          planVersionAtClaim: job.planVersion,
          jobStopGenerationAtClaim: job.jobStopGeneration,
          leaseOwner: null,
          leaseExpiresAt: null,
          activationFence: 0,
          operationStartedAt: null,
          businessOperationCutoffAt: window.businessOperationCutoffAt,
          workDeadlineAt: window.workDeadlineAt,
          hardDeadlineAt: window.hardDeadlineAt,
          purposeAttemptIds: [],
          batchInboxItemIds: [],
          batchThroughWatermark: job.resolvedInboxWatermark,
          inboxHighWatermarkAtClaim: job.inboxHighWatermark,
          appliedInboxWatermarkAtClaim: job.appliedInboxWatermark,
          resolvedInboxWatermarkAtClaim: job.resolvedInboxWatermark,
          businessPayloadReadyGeneration: 0,
          businessPayloadReadyHash: null,
          businessPayloadReadyAt: null,
          reducerPayload: payload,
          committedPayloadHash: null,
          committedAppliedInboxWatermark: null,
          committedResolvedInboxWatermark: null,
          successorWakeId: null,
          committedAt: null,
          outcome: null,
          reasonCode: null,
          createdAt: abandoned.updatedAt,
          updatedAt: abandoned.updatedAt,
        };

        const jobCas = await jobs.updateOne(
          {
            _id: job._id,
            stateVersion: job.stateVersion,
            activeActivationId: abandoned._id,
            activationDispatchGeneration: job.activationDispatchGeneration,
            planVersion: abandoned.planVersionAtClaim,
            jobStopGeneration: abandoned.jobStopGenerationAtClaim,
            ...(lost.activationFence > 0
              ? { activationFence: lost.activationFence }
              : {}),
          },
          {
            $set: {
              activeActivationId: recoveryId,
              activationRecoveryAttempt: lineage.recoveryAttempt,
              activationRecoveryRootId: lineage.rootActivationId,
              activationRecoveryRootKind: lineage.rootActivationKind,
              updatedAt: abandoned.updatedAt,
            },
            $inc: {
              stateVersion: 1,
              activationDispatchGeneration: 1,
            },
          },
          { session },
        );
        if (jobCas.modifiedCount !== 1) {
          throw new ControlRecoveryAuthorityLostError('control handoff job CAS lost');
        }
        await activations.insertOne(recovery, { session });
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
          _id: wakeId,
          aggregate: job._id,
          type: 'ControlRecoveryRequested',
          state: 'PENDING',
          payload: {
            jobId: job._id,
            activationId: recoveryId,
            lostActivationId: abandoned._id,
            lostKind: abandoned.kind,
            rootActivationId: lineage.rootActivationId,
            rootActivationKind: lineage.rootActivationKind,
            recoveryAttempt: lineage.recoveryAttempt,
            activationDispatchGeneration: nextGeneration,
          },
          createdAt: abandoned.updatedAt,
        }, { session });
        const sequence = await nextEventSeq(db, job._id, session);
        await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
          _id: `${job._id}:${sequence}`,
          jobId: job._id,
          sequence,
          type: 'LaneControlRecoveryStarted',
          payload: {
            lostActivationId: abandoned._id,
            lostActivationKind: abandoned.kind,
            activationId: recoveryId,
            rootActivationId: lineage.rootActivationId,
            rootActivationKind: lineage.rootActivationKind,
            recoveryAttempt: lineage.recoveryAttempt,
          },
          createdAt: abandoned.updatedAt,
        }, { session });
        return 1;
      });
      if (value === 0) break;
      reaped += value;
      authorityRetries = 0;
    } catch (err) {
      if (err instanceof ControlRecoveryAuthorityLostError) {
        authorityRetries++;
        continue;
      }
      throw err;
    }
  }
  return reaped;
}

/** Claim a specific PENDING control activation and mint the job-scoped fence. */
export async function claimControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  input: { activationId: string; leaseOwner: string; leaseTtlMs?: number },
): Promise<ControlRecoveryLeaseHandle | null> {
  const ttl = input.leaseTtlMs ?? DEFAULT_CONTROL_LEASE_TTL_MS;
  if (ttl <= 0) throw new Error('control recovery lease TTL must be positive');
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne({
        _id: input.activationId,
        kind: 'CONTROL_RECOVERY',
        activeSlot: true,
      }, { session });
      if (!activation) return null;
      const payload = parseControlRecoveryPayload(activation.reducerPayload);
      if (
        !payload
        || !await validateControlRecoveryLineage(
          db,
          activation,
          payload,
          session,
        )
      ) return null;
      if (
        (activation.lifecycle === 'LEASED' || activation.lifecycle === 'RUNNING')
        && activation.leaseOwner === input.leaseOwner
      ) {
        const replay = await activations.findOneAndUpdate(
          {
            _id: activation._id,
            kind: 'CONTROL_RECOVERY',
            activeSlot: true,
            lifecycle: { $in: ['LEASED', 'RUNNING'] },
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
          [{ $set: { updatedAt: '$$NOW' } }],
          { session, returnDocument: 'after' },
        );
        const replayJob = replay
          ? await jobs.findOne({
              _id: replay.jobId,
              activeActivationId: replay._id,
              planVersion: replay.planVersionAtClaim,
              jobStopGeneration: replay.jobStopGenerationAtClaim,
              activationDispatchGeneration:
                replay.activationDispatchGenerationAtClaim,
              activationFence: replay.activationFence,
              activationRecoveryAttempt: payload.recoveryAttempt,
              activationRecoveryRootId: payload.rootActivationId,
              activationRecoveryRootKind: payload.rootActivationKind,
            }, { session, projection: { _id: 1 } })
          : null;
        if (!replay?.leaseExpiresAt || !replayJob) return null;
        return {
          activationId: replay._id,
          jobId: replay.jobId,
          kind: 'CONTROL_RECOVERY',
          leaseOwner: input.leaseOwner,
          activationFence: replay.activationFence,
          leaseExpiresAt: replay.leaseExpiresAt,
          workDeadlineAt: replay.workDeadlineAt,
          hardDeadlineAt: replay.hardDeadlineAt,
        } satisfies ControlRecoveryLeaseHandle;
      }
      if (activation.lifecycle !== 'PENDING') return null;
      const job = await jobs.findOne({
        _id: activation.jobId,
        activeActivationId: activation._id,
        planVersion: activation.planVersionAtClaim,
        jobStopGeneration: activation.jobStopGenerationAtClaim,
        activationDispatchGeneration:
          activation.activationDispatchGenerationAtClaim,
        activationRecoveryAttempt: payload.recoveryAttempt,
        activationRecoveryRootId: payload.rootActivationId,
        activationRecoveryRootKind: payload.rootActivationKind,
      }, { session });
      if (!job) return null;
      const fencedJob = await jobs.findOneAndUpdate(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          activeActivationId: activation._id,
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration:
            activation.activationDispatchGenerationAtClaim,
          activationRecoveryAttempt: payload.recoveryAttempt,
          activationRecoveryRootId: payload.rootActivationId,
          activationRecoveryRootKind: payload.rootActivationKind,
        },
        {
          $set: { updatedAt: new Date() },
          $inc: { stateVersion: 1, activationFence: 1 },
        },
        { session, returnDocument: 'after' },
      );
      if (!fencedJob) {
        throw new ControlRecoveryAuthorityLostError('control claim job CAS lost');
      }
      const claimed = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'CONTROL_RECOVERY',
          lifecycle: 'PENDING',
          activeSlot: true,
          activationFence: 0,
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
                    amount: ttl,
                  },
                },
                '$hardDeadlineAt',
              ],
            },
            activationFence: fencedJob.activationFence,
            planVersionAtClaim: fencedJob.planVersion,
            jobStopGenerationAtClaim: fencedJob.jobStopGeneration,
            activationDispatchGenerationAtClaim:
              fencedJob.activationDispatchGeneration,
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!claimed?.leaseExpiresAt) {
        throw new ControlRecoveryAuthorityLostError('control claim deadline CAS lost');
      }
      return {
        activationId: claimed._id,
        jobId: claimed.jobId,
        kind: 'CONTROL_RECOVERY',
        leaseOwner: input.leaseOwner,
        activationFence: claimed.activationFence,
        leaseExpiresAt: claimed.leaseExpiresAt,
        workDeadlineAt: claimed.workDeadlineAt,
        hardDeadlineAt: claimed.hardDeadlineAt,
      } satisfies ControlRecoveryLeaseHandle;
    });
    return value;
  } catch (err) {
    if (err instanceof ControlRecoveryAuthorityLostError) return null;
    throw err;
  }
}

/** LEASED → RUNNING under exact control owner/fence/generation authority. */
export async function startControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  input: { activationId: string; leaseOwner: string; activationFence: number },
): Promise<boolean> {
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne({
        _id: input.activationId,
        kind: 'CONTROL_RECOVERY',
        activationFence: input.activationFence,
        activeSlot: true,
      }, { session });
      if (!activation) return false;
      const payload = parseControlRecoveryPayload(activation.reducerPayload);
      if (
        !payload
        || !await validateControlRecoveryLineage(
          db,
          activation,
          payload,
          session,
        )
      ) return false;
      const replay = activation.lifecycle === 'RUNNING'
        && activation.leaseOwner === input.leaseOwner
        && activation.operationStartedAt !== null;
      if (
        !replay
        && (
          activation.lifecycle !== 'LEASED'
          || activation.leaseOwner !== input.leaseOwner
        )
      ) return false;
      const job = await jobs.findOne({
        _id: activation.jobId,
        activeActivationId: activation._id,
        planVersion: activation.planVersionAtClaim,
        jobStopGeneration: activation.jobStopGenerationAtClaim,
        activationDispatchGeneration:
          activation.activationDispatchGenerationAtClaim,
        activationFence: input.activationFence,
        activationRecoveryAttempt: payload.recoveryAttempt,
        activationRecoveryRootId: payload.rootActivationId,
        activationRecoveryRootKind: payload.rootActivationKind,
      }, { session });
      if (!job) return false;
      const started = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'CONTROL_RECOVERY',
          lifecycle: replay ? 'RUNNING' : 'LEASED',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
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
            operationStartedAt: { $ifNull: ['$operationStartedAt', '$$NOW'] },
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!started) return false;
      if (!replay) {
        const touched = await jobs.updateOne(
          {
            _id: job._id,
            stateVersion: job.stateVersion,
            activeActivationId: activation._id,
            planVersion: activation.planVersionAtClaim,
            jobStopGeneration: activation.jobStopGenerationAtClaim,
            activationDispatchGeneration:
              activation.activationDispatchGenerationAtClaim,
            activationFence: input.activationFence,
            activationRecoveryAttempt: payload.recoveryAttempt,
            activationRecoveryRootId: payload.rootActivationId,
            activationRecoveryRootKind: payload.rootActivationKind,
          },
          {
            $set: { updatedAt: started.updatedAt },
            $inc: { stateVersion: 1 },
          },
          { session },
        );
        if (touched.modifiedCount !== 1) {
          throw new ControlRecoveryAuthorityLostError('control start job CAS lost');
        }
      }
      return true;
    });
    return value;
  } catch (err) {
    if (err instanceof ControlRecoveryAuthorityLostError) return false;
    throw err;
  }
}

function planningRecoveryEligible(job: JobDoc): boolean {
  return job.terminalOutcome === null
    && job.controlState === 'NONE'
    && (job.phase === 'ACCEPTED' || job.phase === 'READY');
}

/** R1: settle only control authority and recreate at most one durable demand. */
export async function commitControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  input: { activationId: string; leaseOwner: string; activationFence: number },
): Promise<ControlRecoveryCommitResult | null> {
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne({
        _id: input.activationId,
        kind: 'CONTROL_RECOVERY',
        activationFence: input.activationFence,
      }, { session });
      if (!activation) return null;
      const payload = parseControlRecoveryPayload(activation.reducerPayload);
      if (!payload) return null;
      const payloadHash = canonicalHash(payload);
      if (!await validateControlRecoveryLineage(
        db,
        activation,
        payload,
        session,
      )) return null;
      if (activation.lifecycle === 'COMMITTED') {
        if (
          !hasCommittedControlEvidence(activation, payload)
          || activation.committedPayloadHash !== payloadHash
        ) return null;
        if (activation.successorWakeId !== null) {
          const successor = await db.collection<OutboxDoc>(COLLECTIONS.outbox)
            .findOne({
              _id: activation.successorWakeId,
              aggregate: activation.jobId,
              type: 'LaneWakeRequested',
            }, { session });
          const successorPayload = successor?.payload as unknown;
          if (
            !successor
            || !isRecord(successorPayload)
            || successorPayload.jobId !== activation.jobId
            || successorPayload.activationDispatchGeneration
              !== activation.activationDispatchGenerationAtClaim
          ) return null;
        }
        return {
          activationId: activation._id,
          jobId: activation.jobId,
          rootActivationId: payload.rootActivationId,
          rootActivationKind: payload.rootActivationKind,
          recoveryAttempt: payload.recoveryAttempt,
          successorWakeId: activation.successorWakeId,
          deduped: true,
        } satisfies ControlRecoveryCommitResult;
      }
      if (
        activation.lifecycle !== 'RUNNING'
        || !activation.activeSlot
        || activation.leaseOwner !== input.leaseOwner
      ) return null;
      const job = await jobs.findOne({
        _id: activation.jobId,
        activeActivationId: activation._id,
        planVersion: activation.planVersionAtClaim,
        jobStopGeneration: activation.jobStopGenerationAtClaim,
        activationDispatchGeneration:
          activation.activationDispatchGenerationAtClaim,
        activationFence: input.activationFence,
        activationRecoveryAttempt: payload.recoveryAttempt,
        activationRecoveryRootId: payload.rootActivationId,
        activationRecoveryRootKind: payload.rootActivationKind,
      }, { session });
      if (!job) return null;

      let successorWakeId: string | null = null;
      let successorPayload: Record<string, unknown> | null = null;
      let adoptedSuccessorWakeId: string | null = null;
      if (payload.rootActivationKind === 'BUSINESS' && planningRecoveryEligible(job)) {
        const existingTask = await db.collection<TaskDoc>(COLLECTIONS.tasks)
          .findOne({ jobId: job._id }, { session, projection: { _id: 1 } });
        if (!existingTask) {
          successorPayload = {
            jobId: job._id,
            reason: 'activation_recovery',
            activationDispatchGeneration: job.activationDispatchGeneration,
          };
        }
      } else if (
        payload.rootActivationKind === 'RESULT_DRAIN'
        && job.terminalOutcome === null
        && job.controlState !== 'STOP_REQUESTED'
        && (job.phase === 'AWAITING_RESULTS' || job.phase === 'RECONCILING')
      ) {
        const eligible = await findNextEligibleResultDrainInboxItem(
          db,
          job,
          session,
        );
        if (eligible) {
          successorPayload = {
            jobId: job._id,
            reason: 'result_drain_recovery',
            attemptId: eligible.attemptId,
            inboxItemId: eligible._id,
            activationDispatchGeneration: job.activationDispatchGeneration,
          };
        }
      }
      if (successorPayload) {
        const pendingSuccessor = await db.collection<OutboxDoc>(COLLECTIONS.outbox)
          .findOne({
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            'payload.activationDispatchGeneration':
              job.activationDispatchGeneration,
          }, { session, sort: { createdAt: 1, _id: 1 } });
        successorWakeId = pendingSuccessor?._id
          ?? recoverySuccessorWakeId(payload);
        adoptedSuccessorWakeId = pendingSuccessor?._id ?? null;
      }

      const committed = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'CONTROL_RECOVERY',
          lifecycle: 'RUNNING',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
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
            committedPayloadHash: payloadHash,
            committedAt: '$$NOW',
            successorWakeId,
            outcome: successorWakeId === null ? 'NO_DEMAND' : 'DEMAND_RESTORED',
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!committed?.committedAt) return null;
      const jobCas = await jobs.updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          activeActivationId: activation._id,
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration:
            activation.activationDispatchGenerationAtClaim,
          activationFence: input.activationFence,
          activationRecoveryAttempt: payload.recoveryAttempt,
          activationRecoveryRootId: payload.rootActivationId,
          activationRecoveryRootKind: payload.rootActivationKind,
        },
        {
          $set: {
            activeActivationId: null,
            updatedAt: committed.committedAt,
          },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      if (jobCas.modifiedCount !== 1) {
        throw new ControlRecoveryAuthorityLostError('control commit job CAS lost');
      }
      if (successorWakeId && successorPayload) {
        if (adoptedSuccessorWakeId) {
          const adopted = await db.collection<OutboxDoc>(COLLECTIONS.outbox)
            .updateOne(
              {
                _id: adoptedSuccessorWakeId,
                aggregate: job._id,
                type: 'LaneWakeRequested',
                state: 'PENDING',
                'payload.activationDispatchGeneration':
                  job.activationDispatchGeneration,
              },
              { $set: { payload: successorPayload } },
              { session },
            );
          if (adopted.matchedCount !== 1) {
            throw new ControlRecoveryAuthorityLostError(
              'control successor wake adoption CAS lost',
            );
          }
        } else {
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
            _id: successorWakeId,
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            payload: successorPayload,
            createdAt: committed.committedAt,
          }, { session });
        }
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateMany(
          {
            _id: { $ne: successorWakeId },
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            'payload.activationDispatchGeneration':
              job.activationDispatchGeneration,
          },
          { $set: { state: 'PUBLISHED' } },
          { session },
        );
      }
      const sequence = await nextEventSeq(db, job._id, session);
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${sequence}`,
        jobId: job._id,
        sequence,
        type: 'LaneControlRecoveryCommitted',
        payload: {
          activationId: activation._id,
          lostActivationId: payload.lostActivationId,
          rootActivationId: payload.rootActivationId,
          rootActivationKind: payload.rootActivationKind,
          recoveryAttempt: payload.recoveryAttempt,
          successorWakeId,
        },
        createdAt: committed.committedAt,
      }, { session });
      return {
        activationId: activation._id,
        jobId: job._id,
        rootActivationId: payload.rootActivationId,
        rootActivationKind: payload.rootActivationKind,
        recoveryAttempt: payload.recoveryAttempt,
        successorWakeId,
        deduped: false,
      } satisfies ControlRecoveryCommitResult;
    });
    return value;
  } catch (err) {
    if (err instanceof ControlRecoveryAuthorityLostError) return null;
    throw err;
  }
}

/** Publish one typed control request and return its exact activation identity. */
export async function claimNextControlRecoveryWake(
  client: MongoClient,
  db: Db,
): Promise<{ wakeId: string; activationId: string; jobId: string } | null> {
  for (let scanned = 0; scanned < MAX_CONTROL_WAKE_SCANS_PER_TICK; scanned++) {
    const { value } = await runTxn(client, async (session) => {
      const wake = await db.collection<OutboxDoc>(COLLECTIONS.outbox)
        .findOneAndUpdate(
          { type: 'ControlRecoveryRequested', state: 'PENDING' },
          { $set: { state: 'PUBLISHED' } },
          { session, sort: { createdAt: 1 }, returnDocument: 'after' },
        );
      if (!wake) return { status: 'empty' as const };
      const raw = wake.payload as unknown;
      const activationId = isRecord(raw) ? raw.activationId : null;
      const generation = isRecord(raw)
        ? raw.activationDispatchGeneration
        : null;
      if (
        typeof activationId !== 'string'
        || typeof generation !== 'number'
        || !Number.isInteger(generation)
      ) {
        return { status: 'skipped' as const };
      }
      const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({
        _id: wake.aggregate,
        activeActivationId: activationId,
        activationDispatchGeneration: generation,
      }, { session });
      const activation = job
        ? await db.collection<LaneActivationDoc>(COLLECTIONS.activations).findOne({
            _id: activationId,
            jobId: job._id,
            kind: 'CONTROL_RECOVERY',
            activeSlot: true,
            sourceWakeId: wake._id,
            lifecycle: { $in: ACTIVE_CONTROL_LIFECYCLES },
          }, { session, projection: { _id: 1 } })
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

export async function runControlRecoveryActivation(
  client: MongoClient,
  db: Db,
  activationId: string,
  opts: { leaseOwner?: string; leaseTtlMs?: number } = {},
): Promise<ControlRecoveryCommitResult | null> {
  const leaseOwner = opts.leaseOwner ?? `control-recovery:${randomUUID()}`;
  const lease = await claimControlRecoveryActivation(client, db, {
    activationId,
    leaseOwner,
    leaseTtlMs: opts.leaseTtlMs,
  });
  if (!lease) return null;
  if (!await startControlRecoveryActivation(client, db, {
    activationId,
    leaseOwner,
    activationFence: lease.activationFence,
  })) return null;
  return commitControlRecoveryActivation(client, db, {
    activationId,
    leaseOwner,
    activationFence: lease.activationFence,
  });
}

/** Drain all currently requested control recoveries. */
export async function drainControlRecovery(
  client: MongoClient,
  db: Db,
): Promise<ControlRecoveryDrainResult> {
  let claimed = 0;
  let committed = 0;
  for (let drained = 0; drained < MAX_CONTROL_DRAINS_PER_TICK; drained++) {
    const wake = await claimNextControlRecoveryWake(client, db);
    if (wake) {
      claimed++;
      const result = await runControlRecoveryActivation(
        client,
        db,
        wake.activationId,
      );
      if (result) committed++;
      continue;
    }

    // Crash window: the control outbox may already be PUBLISHED while its
    // activation is still PENDING. Scan a bounded set and skip corrupt/stale
    // candidates so one bad oldest row cannot head-of-line block a valid owner.
    const fallbacks = await db.collection<LaneActivationDoc>(COLLECTIONS.activations)
      .find({
        kind: 'CONTROL_RECOVERY',
        lifecycle: 'PENDING',
        activeSlot: true,
        'reducerPayload.kind': 'RECOVER_LOST_ACTIVATION_V1',
        $nor: [
          { controlSubtype: 'STOP_TERMINAL' },
          { budgetPool: 'JOB_CONTROL_RECOVERY' },
          { budgetReservationId: { $type: 'string' } },
        ],
      }, { projection: { _id: 1 } })
      .sort({ updatedAt: 1, createdAt: 1, _id: 1 })
      .limit(CONTROL_FALLBACK_SCAN_LIMIT)
      .toArray();
    if (fallbacks.length === 0) break;
    let progressed = false;
    for (const fallback of fallbacks) {
      const result = await runControlRecoveryActivation(
        client,
        db,
        fallback._id,
      );
      if (!result) {
        // Rotate an unclaimable crash-window candidate behind its peers. This
        // keeps work bounded while avoiding the same corrupt prefix on every
        // reconciler tick.
        await db.collection<LaneActivationDoc>(COLLECTIONS.activations)
          .updateOne(
            {
              _id: fallback._id,
              kind: 'CONTROL_RECOVERY',
              lifecycle: 'PENDING',
              activeSlot: true,
              'reducerPayload.kind': 'RECOVER_LOST_ACTIVATION_V1',
              $nor: [
                { controlSubtype: 'STOP_TERMINAL' },
                { budgetPool: 'JOB_CONTROL_RECOVERY' },
                { budgetReservationId: { $type: 'string' } },
              ],
            },
            { $set: { updatedAt: new Date() } },
          );
        continue;
      }
      committed++;
      progressed = true;
      break;
    }
    if (!progressed) break;
  }
  return { claimed, committed };
}
