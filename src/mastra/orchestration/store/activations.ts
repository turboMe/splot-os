/**
 * Typed lane activations (plan §7.6, §15.5) — first flat BUSINESS slice.
 *
 * PR-31 moves exactly one reducer behind activation authority:
 *   ACCEPTED/READY + no task → one SERIAL planning proposal → task + JobPlanned.
 *
 * The proposal is frozen centrally before the activation business cutoff and
 * the reducer commits exactly that hash before the work deadline. The task,
 * job/event/successor wake and activation COMMITTED transition share one
 * transaction. The separate `result-drain.ts` module owns the first bounded
 * RESULT_DRAIN consumer, while `control-recovery.ts` owns only the narrow
 * lost-activation recovery subtype. FINAL_DECISION, STOP_REQUESTED recovery,
 * protected control reserve, budget settlement and the general planning model
 * remain intentionally deferred.
 */
import type { ClientSession, Db, Filter, MongoClient } from 'mongodb';
import {
  deriveAttemptDeadlines,
  isProgressiveAttemptPolicy,
  newActivationId,
  newOutboxId,
  newTaskId,
  type ProgressiveAttemptPolicy,
} from '../contracts/index.js';
import { canonicalHash, runTxn } from './txn.js';
import { openLaneUserRequest } from './request-boundary.js';
import {
  assertLaneDecision,
  deterministicSerialDecider,
  type LaneDecider,
  type LaneDecisionV1,
} from '../contracts/lane-decision.js';
import {
  COLLECTIONS,
  type JobDoc,
  type JobEventDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type TaskDoc,
} from './collections.js';
import {
  drainControlRecovery,
  reapExpiredActivationsToControlRecovery,
} from './control-recovery.js';

const DEFAULT_ACTIVATION_LEASE_TTL_MS = 10_000;
const DEFAULT_ACTIVATION_CAP_MS = 30_000;
const DEFAULT_FINALIZE_RESERVE_MS = 2_000;
const DEFAULT_REDUCER_COMMIT_RESERVE_MS = 2_000;
const ACTIVE_ACTIVATION_LIFECYCLES: LaneActivationDoc['lifecycle'][] = [
  'PENDING',
  'LEASED',
  'RUNNING',
  'FAILED',
];

class ActivationBoundaryAuthorityLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivationBoundaryAuthorityLostError';
  }
}

export interface PlanningProposalV1 {
  kind: 'PLAN_SINGLE_SERIAL_TASK_V1';
  jobId: string;
  taskId: string;
  planVersion: number;
  attemptMode: 'SERIAL';
  /**
   * Which specialist the lane chose, frozen with the rest of the plan.
   *
   * It belongs in the PROPOSAL, not in a later lookup, because that is what makes
   * the routing decision durable: the choice is hashed and committed under the
   * same fence as the task itself, so a retry, a crash between freeze and commit,
   * or a restarted process all reach the same specialist. Resolving a capability
   * to an agent at dispatch time from a *different* decision would make the route
   * a property of whoever happened to run the worker.
   *
   * An opaque string here on purpose: the substrate stores the name and never
   * interprets it (see `config/capability-routing.ts` for who owns the meaning).
   * Absent = no preference; the worker uses its default.
   */
  capability?: string;
  /** The lane's refinement of what this task should achieve. Absent = the job goal. */
  goal?: string;
  /**
   * How long each attempt at this task may run, frozen with the rest of the plan
   * for the same reason `capability` is: it is derived from WHO was chosen, and a
   * retry or a restarted process must not silently get a different window than
   * the first attempt had.
   */
  attemptCapMs?: number;
  /** Optional earned-time policy, code-owned and frozen with this proposal. */
  progressiveAttempt?: ProgressiveAttemptPolicy;
  /**
   * An ordered plan frozen with this proposal (F6B).
   *
   * Present = the committed task is a PARENT that aggregates a sequence rather
   * than work in its own right: it is written as `WAITING_DEPENDENCY` and a
   * separate, idempotent lane move materializes the steps through
   * `spawnChildTasks`.
   *
   * WHY THE STEPS ARE FROZEN HERE BUT MATERIALIZED LATER. Writing parent + N
   * children + N edges inside `commitPlanningActivation` would mean extending the
   * one path that carries lease, fence, payload-ready marker and CAS all at once
   * — the most guarded code in planning — for a payload shape it does not need to
   * know about. Freezing the LIST is enough: the plan is hashed and committed
   * under the same fence as everything else, so it cannot change afterwards, and
   * a crash before materialization leaves a parent that the next wake completes.
   * A parent in `WAITING_DEPENDENCY` is not dispatchable, so there is no window
   * where a multi-step plan runs as ordinary single-agent work.
   */
  plannedSteps?: Array<{
    goal: string;
    capability?: string;
    attemptCapMs?: number;
    progressiveAttempt?: ProgressiveAttemptPolicy;
  }>;
}

export interface PlanningActivationOptions {
  activationId?: string;
  sourceWakeId?: string | null;
  activationCapMs?: number;
  reserveForFinalizeMs?: number;
  reducerCommitReserveMs?: number;
}

export interface ActivationLeaseHandle {
  activationId: string;
  jobId: string;
  kind: 'BUSINESS';
  leaseOwner: string;
  activationFence: number;
  leaseExpiresAt: Date;
  businessOperationCutoffAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
}

export type PlanningMarkerRejectReason =
  | 'stale_fence_or_lease_or_cutoff'
  | 'stale_plan_or_control'
  | 'payload_hash_conflict';

export interface PlanningMarkerResult {
  ready: boolean;
  marked: boolean;
  deduped: boolean;
  payloadHash: string;
  generation: number;
  reason?: PlanningMarkerRejectReason;
}

function isPlanningCandidate(job: JobDoc): boolean {
  return job.terminalOutcome === null
    && job.controlState === 'NONE'
    && (job.phase === 'ACCEPTED' || job.phase === 'READY');
}

function assertPlanningProposal(value: PlanningProposalV1): void {
  if (
    value.kind !== 'PLAN_SINGLE_SERIAL_TASK_V1'
    || typeof value.jobId !== 'string'
    || value.jobId.length === 0
    || typeof value.taskId !== 'string'
    || value.taskId.length === 0
    || !Number.isInteger(value.planVersion)
    || value.planVersion < 0
    || value.attemptMode !== 'SERIAL'
    // Optional, but never junk: these ride the same hash as the plan, so a
    // malformed one would freeze permanently into a committed proposal.
    || (value.capability !== undefined
      && (typeof value.capability !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.capability)))
    || (value.goal !== undefined
      && (typeof value.goal !== 'string' || value.goal.length === 0 || value.goal.length > 2_000))
    || (value.attemptCapMs !== undefined
      && (!Number.isInteger(value.attemptCapMs) || value.attemptCapMs <= 0 || value.attemptCapMs > 3_600_000))
    || (value.progressiveAttempt !== undefined
      && (
        !isProgressiveAttemptPolicy(value.progressiveAttempt)
        || value.attemptCapMs !== value.progressiveAttempt.maxCapMs
      ))
    || (value.plannedSteps !== undefined && !isFrozenPlan(value.plannedSteps))
  ) {
    throw new Error('invalid bounded planning proposal');
  }
}

/**
 * The frozen plan rides the same hash as everything else, so a malformed one
 * would be permanent. Bounds mirror the decision contract deliberately: if the
 * two ever disagree, the looser one is the real limit and the tighter one is
 * decoration.
 */
function isFrozenPlan(steps: unknown): boolean {
  return Array.isArray(steps)
    && steps.length >= 2
    && steps.length <= 8
    && steps.every((raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
      const step = raw as Record<string, unknown>;
      return typeof step.goal === 'string'
        && step.goal.length > 0
        && step.goal.length <= 2_000
        && (step.capability === undefined
          || (typeof step.capability === 'string'
            && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.capability)))
        && (step.attemptCapMs === undefined
          || (Number.isInteger(step.attemptCapMs)
            && (step.attemptCapMs as number) > 0
            && (step.attemptCapMs as number) <= 3_600_000))
        && (step.progressiveAttempt === undefined
          || isProgressiveAttemptPolicy(step.progressiveAttempt));
    });
}

function deriveActivationWindow(opts: PlanningActivationOptions): {
  businessOperationCutoffAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
  now: Date;
} {
  const now = new Date();
  const activationCapMs = opts.activationCapMs ?? DEFAULT_ACTIVATION_CAP_MS;
  const reserveForFinalizeMs = opts.reserveForFinalizeMs ?? DEFAULT_FINALIZE_RESERVE_MS;
  const reducerCommitReserveMs = opts.reducerCommitReserveMs ?? DEFAULT_REDUCER_COMMIT_RESERVE_MS;
  if (
    activationCapMs <= 0
    || reserveForFinalizeMs < 0
    || reducerCommitReserveMs < 0
    || reserveForFinalizeMs + reducerCommitReserveMs >= activationCapMs
  ) {
    throw new Error('invalid activation deadline reserves');
  }
  const hardDeadlineAt = new Date(now.getTime() + activationCapMs);
  const deadlines = deriveAttemptDeadlines({
    hardDeadlineAt: hardDeadlineAt.getTime(),
    reserveForFinalizeMs,
    resultCommitReserveMs: reducerCommitReserveMs,
  });
  if (deadlines.businessOperationCutoffAt <= now.getTime()) {
    throw new Error('activation deadline reserves leave no business window');
  }
  return {
    now,
    businessOperationCutoffAt: new Date(deadlines.businessOperationCutoffAt),
    workDeadlineAt: new Date(deadlines.workDeadlineAt),
    hardDeadlineAt,
  };
}

/**
 * Materialize a PENDING planning activation and acquire the job's unique active
 * slot. Callers that claim a wake pass the same session so wake publication,
 * activation creation and slot acquisition are one durable boundary.
 */
export async function materializePlanningActivationInSession(
  db: Db,
  job: JobDoc,
  session: ClientSession,
  opts: PlanningActivationOptions = {},
): Promise<LaneActivationDoc | null> {
  if (!isPlanningCandidate(job)) return null;

  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  if (job.activeActivationId !== null) {
    return activations.findOne(
      {
        _id: job.activeActivationId,
        jobId: job._id,
        kind: 'BUSINESS',
        lifecycle: { $in: ACTIVE_ACTIVATION_LIFECYCLES },
        activeSlot: true,
      },
      { session },
    );
  }

  const existingTask = await db.collection<TaskDoc>(COLLECTIONS.tasks)
    .findOne({ jobId: job._id }, { session, projection: { _id: 1 } });
  if (existingTask) return null;

  const activationId = opts.activationId ?? newActivationId();
  const window = deriveActivationWindow(opts);
  const activation: LaneActivationDoc = {
    _id: activationId,
    sourceWakeId: opts.sourceWakeId ?? null,
    jobId: job._id,
    kind: 'BUSINESS',
    lifecycle: 'PENDING',
    activeSlot: true,
    activationDispatchGenerationAtClaim: job.activationDispatchGeneration,
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
    reducerPayload: null,
    committedPayloadHash: null,
    committedAppliedInboxWatermark: null,
    committedResolvedInboxWatermark: null,
    successorWakeId: null,
    committedAt: null,
    outcome: null,
    reasonCode: null,
    createdAt: window.now,
    updatedAt: window.now,
  };

  // Serialize contenders on the job document before touching the unique
  // activation slot. If two lane workers race, Mongo retries the loser from a
  // fresh snapshot; it then observes the winner instead of surfacing E11000.
  const jobCas = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
    {
      _id: job._id,
      stateVersion: job.stateVersion,
      terminalOutcome: null,
      controlState: 'NONE',
      phase: { $in: ['ACCEPTED', 'READY'] },
      planVersion: job.planVersion,
      jobStopGeneration: job.jobStopGeneration,
      activationDispatchGeneration: job.activationDispatchGeneration,
      activeActivationId: null,
    },
    {
      $set: {
        activeActivationId: activationId,
        updatedAt: window.now,
      },
      $inc: { stateVersion: 1 },
    },
    { session },
  );
  if (jobCas.modifiedCount !== 1) {
    throw new ActivationBoundaryAuthorityLostError('planning activation slot CAS lost');
  }
  await activations.insertOne(activation, { session });
  return activation;
}

/** Direct/test entrypoint; production wake claim uses the in-session variant. */
export async function materializePlanningActivation(
  client: MongoClient,
  db: Db,
  jobId: string,
  opts: PlanningActivationOptions = {},
): Promise<LaneActivationDoc | null> {
  try {
    const { value } = await runTxn(client, async (session) => {
      const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
        .findOne({ _id: jobId }, { session });
      if (!job) return null;
      return materializePlanningActivationInSession(db, job, session, opts);
    });
    return value;
  } catch (err) {
    if (err instanceof ActivationBoundaryAuthorityLostError) return null;
    throw err;
  }
}

/** PENDING → LEASED; mint the job-scoped activation fence atomically. */
export async function claimPlanningActivation(
  client: MongoClient,
  db: Db,
  input: { activationId: string; leaseOwner: string; leaseTtlMs?: number },
): Promise<ActivationLeaseHandle | null> {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_ACTIVATION_LEASE_TTL_MS;
  if (leaseTtlMs <= 0) throw new Error('activation lease TTL must be positive');
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne(
        { _id: input.activationId, kind: 'BUSINESS', activeSlot: true },
        { session },
      );
      if (!activation) return null;

      if (
        (activation.lifecycle === 'LEASED' || activation.lifecycle === 'RUNNING')
        && activation.leaseOwner === input.leaseOwner
      ) {
        const replay = await activations.findOneAndUpdate(
          {
            _id: activation._id,
            lifecycle: { $in: ['LEASED', 'RUNNING'] },
            activeSlot: true,
            leaseOwner: input.leaseOwner,
            activationFence: activation.activationFence,
            $expr: {
              $and: [
                { $gt: ['$leaseExpiresAt', '$$NOW'] },
                { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
                { $gt: ['$hardDeadlineAt', '$$NOW'] },
              ],
            },
          } as unknown as Filter<LaneActivationDoc>,
          [{ $set: { updatedAt: '$$NOW' } }],
          { session, returnDocument: 'after' },
        );
        const replayJob = replay
          ? await jobs.findOne(
              {
                _id: replay.jobId,
                activeActivationId: replay._id,
                terminalOutcome: null,
                controlState: 'NONE',
                phase: { $in: ['ACCEPTED', 'READY'] },
                planVersion: replay.planVersionAtClaim,
                jobStopGeneration: replay.jobStopGenerationAtClaim,
                activationDispatchGeneration: replay.activationDispatchGenerationAtClaim,
              },
              { session, projection: { _id: 1 } },
            )
          : null;
        if (!replay?.leaseExpiresAt || !replayJob) return null;
        return {
          activationId: replay._id,
          jobId: replay.jobId,
          kind: 'BUSINESS',
          leaseOwner: input.leaseOwner,
          activationFence: replay.activationFence,
          leaseExpiresAt: replay.leaseExpiresAt,
          businessOperationCutoffAt: replay.businessOperationCutoffAt,
          workDeadlineAt: replay.workDeadlineAt,
          hardDeadlineAt: replay.hardDeadlineAt,
        } satisfies ActivationLeaseHandle;
      }
      if (activation.lifecycle !== 'PENDING') return null;

      const job = await jobs.findOne(
        {
          _id: activation.jobId,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          phase: { $in: ['ACCEPTED', 'READY'] },
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        { session },
      );
      if (!job) return null;
      const existingTask = await db.collection<TaskDoc>(COLLECTIONS.tasks)
        .findOne({ jobId: job._id }, { session, projection: { _id: 1 } });
      if (existingTask) return null;

      const fencedJob = await jobs.findOneAndUpdate(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        {
          $set: { updatedAt: new Date() },
          $inc: { stateVersion: 1, activationFence: 1 },
        },
        { session, returnDocument: 'after' },
      );
      if (!fencedJob) {
        throw new ActivationBoundaryAuthorityLostError('activation fence CAS lost');
      }

      const claimed = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          lifecycle: 'PENDING',
          activeSlot: true,
          activationFence: 0,
          $expr: {
            $and: [
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
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
                { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: leaseTtlMs } },
                '$hardDeadlineAt',
              ],
            },
            activationFence: fencedJob.activationFence,
            planVersionAtClaim: fencedJob.planVersion,
            jobStopGenerationAtClaim: fencedJob.jobStopGeneration,
            activationDispatchGenerationAtClaim: fencedJob.activationDispatchGeneration,
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!claimed?.leaseExpiresAt) {
        throw new ActivationBoundaryAuthorityLostError('activation claim deadline CAS lost');
      }
      return {
        activationId: claimed._id,
        jobId: claimed.jobId,
        kind: 'BUSINESS',
        leaseOwner: input.leaseOwner,
        activationFence: claimed.activationFence,
        leaseExpiresAt: claimed.leaseExpiresAt,
        businessOperationCutoffAt: claimed.businessOperationCutoffAt,
        workDeadlineAt: claimed.workDeadlineAt,
        hardDeadlineAt: claimed.hardDeadlineAt,
      } satisfies ActivationLeaseHandle;
    });
    return value;
  } catch (err) {
    if (err instanceof ActivationBoundaryAuthorityLostError) return null;
    throw err;
  }
}

/** LEASED → RUNNING; planning work starts only after this store-time CAS. */
export async function startPlanningActivation(
  client: MongoClient,
  db: Db,
  input: { activationId: string; leaseOwner: string; activationFence: number },
): Promise<boolean> {
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne(
        { _id: input.activationId, activationFence: input.activationFence },
        { session },
      );
      if (!activation) return false;
      const alreadyRunning = activation.lifecycle === 'RUNNING'
        && activation.leaseOwner === input.leaseOwner
        && activation.operationStartedAt !== null;
      if (
        !alreadyRunning
        && (activation.lifecycle !== 'LEASED' || activation.leaseOwner !== input.leaseOwner)
      ) {
        return false;
      }
      const job = await jobs.findOne(
        {
          _id: activation.jobId,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          phase: { $in: ['ACCEPTED', 'READY'] },
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        { session },
      );
      if (!job) return false;
      const existingTask = await db.collection<TaskDoc>(COLLECTIONS.tasks)
        .findOne({ jobId: job._id }, { session, projection: { _id: 1 } });
      if (existingTask) return false;

      if (alreadyRunning) {
        const replay = await activations.findOneAndUpdate(
          {
            _id: activation._id,
            lifecycle: 'RUNNING',
            activeSlot: true,
            leaseOwner: input.leaseOwner,
            activationFence: input.activationFence,
            $expr: {
              $and: [
                { $gt: ['$leaseExpiresAt', '$$NOW'] },
                { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
                { $gt: ['$hardDeadlineAt', '$$NOW'] },
              ],
            },
          } as unknown as Filter<LaneActivationDoc>,
          [{ $set: { updatedAt: '$$NOW' } }],
          { session, returnDocument: 'after' },
        );
        return replay !== null;
      }

      const started = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          lifecycle: 'LEASED',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<LaneActivationDoc>,
        [{
          $set: {
            lifecycle: 'RUNNING',
            operationStartedAt: '$$NOW',
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!started) return false;
      const jobTouch = await jobs.updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        { $set: { updatedAt: started.updatedAt }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (jobTouch.modifiedCount !== 1) {
        throw new ActivationBoundaryAuthorityLostError('activation start job touch lost');
      }
      return true;
    });
    return value;
  } catch (err) {
    if (err instanceof ActivationBoundaryAuthorityLostError) return false;
    throw err;
  }
}

/**
 * Freeze the bounded planner proposal before the BUSINESS cutoff. A replay of
 * the same hash is idempotent; a second proposal is a hard conflict.
 */
export async function markPlanningActivationPayloadReady(
  client: MongoClient,
  db: Db,
  input: {
    activationId: string;
    leaseOwner: string;
    activationFence: number;
    proposal: PlanningProposalV1;
  },
): Promise<PlanningMarkerResult> {
  assertPlanningProposal(input.proposal);
  const payloadHash = canonicalHash(input.proposal);
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne(
        { _id: input.activationId, activationFence: input.activationFence },
        { session },
      );
      if (
        !activation
        || activation.lifecycle !== 'RUNNING'
        || activation.leaseOwner !== input.leaseOwner
      ) {
        return {
          ready: false,
          marked: false,
          deduped: false,
          payloadHash,
          generation: activation?.businessPayloadReadyGeneration ?? 0,
          reason: 'stale_fence_or_lease_or_cutoff',
        } satisfies PlanningMarkerResult;
      }

      const job = await jobs.findOne(
        {
          _id: activation.jobId,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          phase: { $in: ['ACCEPTED', 'READY'] },
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        { session },
      );
      if (!job || input.proposal.jobId !== job._id || input.proposal.planVersion !== job.planVersion) {
        return {
          ready: false,
          marked: false,
          deduped: false,
          payloadHash,
          generation: activation.businessPayloadReadyGeneration,
          reason: 'stale_plan_or_control',
        } satisfies PlanningMarkerResult;
      }
      const existingTask = await db.collection<TaskDoc>(COLLECTIONS.tasks)
        .findOne({ jobId: job._id }, { session, projection: { _id: 1 } });
      if (existingTask) {
        return {
          ready: false,
          marked: false,
          deduped: false,
          payloadHash,
          generation: activation.businessPayloadReadyGeneration,
          reason: 'stale_plan_or_control',
        } satisfies PlanningMarkerResult;
      }

      if (activation.businessPayloadReadyGeneration > 0) {
        if (activation.businessPayloadReadyHash !== payloadHash) {
          return {
            ready: false,
            marked: false,
            deduped: false,
            payloadHash,
            generation: activation.businessPayloadReadyGeneration,
            reason: 'payload_hash_conflict',
          } satisfies PlanningMarkerResult;
        }
        return {
          ready: true,
          marked: false,
          deduped: true,
          payloadHash,
          generation: activation.businessPayloadReadyGeneration,
        } satisfies PlanningMarkerResult;
      }

      const marked = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          lifecycle: 'RUNNING',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
          businessPayloadReadyGeneration: 0,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<LaneActivationDoc>,
        [{
          $set: {
            businessPayloadReadyGeneration: 1,
            businessPayloadReadyHash: payloadHash,
            businessPayloadReadyAt: '$$NOW',
            reducerPayload: { $literal: input.proposal },
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!marked) {
        return {
          ready: false,
          marked: false,
          deduped: false,
          payloadHash,
          generation: 0,
          reason: 'stale_fence_or_lease_or_cutoff',
        } satisfies PlanningMarkerResult;
      }
      const jobTouch = await jobs.updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        { $set: { updatedAt: marked.updatedAt }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (jobTouch.modifiedCount !== 1) {
        throw new ActivationBoundaryAuthorityLostError('activation marker job touch lost');
      }
      return {
        ready: true,
        marked: true,
        deduped: false,
        payloadHash,
        generation: 1,
      } satisfies PlanningMarkerResult;
    });
    return value;
  } catch (err) {
    if (err instanceof ActivationBoundaryAuthorityLostError) {
      return {
        ready: false,
        marked: false,
        deduped: false,
        payloadHash,
        generation: 0,
        reason: 'stale_plan_or_control',
      };
    }
    throw err;
  }
}

async function nextEventSeq(db: Db, jobId: string, session: ClientSession): Promise<number> {
  const last = await db.collection<JobEventDoc>(COLLECTIONS.events)
    .find({ jobId }, { session }).sort({ sequence: -1 }).limit(1).next();
  return (last?.sequence ?? -1) + 1;
}

/**
 * Exact-hash planning reducer. Task creation, job transition, event, successor
 * wake and activation COMMITTED/lease release are one atomic boundary.
 */
export async function commitPlanningActivation(
  client: MongoClient,
  db: Db,
  input: {
    activationId: string;
    leaseOwner: string;
    activationFence: number;
    businessPayloadReadyGeneration: number;
    proposal: PlanningProposalV1;
  },
): Promise<{ taskId: string; activationId: string; deduped: boolean } | null> {
  assertPlanningProposal(input.proposal);
  const payloadHash = canonicalHash(input.proposal);
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne(
        { _id: input.activationId, activationFence: input.activationFence },
        { session },
      );
      if (!activation) return null;
      if (
        activation.lifecycle === 'COMMITTED'
        && activation.businessPayloadReadyGeneration === input.businessPayloadReadyGeneration
        && activation.committedPayloadHash === payloadHash
        && activation.reducerPayload
        && activation.reducerPayload.taskId === input.proposal.taskId
      ) {
        return {
          taskId: input.proposal.taskId,
          activationId: activation._id,
          deduped: true,
        };
      }
      if (
        activation.lifecycle !== 'RUNNING'
        || activation.leaseOwner !== input.leaseOwner
        || activation.businessPayloadReadyGeneration !== input.businessPayloadReadyGeneration
        || activation.businessPayloadReadyHash !== payloadHash
      ) {
        return null;
      }

      const job = await jobs.findOne(
        {
          _id: activation.jobId,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          phase: { $in: ['ACCEPTED', 'READY'] },
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        { session },
      );
      if (
        !job
        || input.proposal.jobId !== activation.jobId
        || input.proposal.planVersion !== activation.planVersionAtClaim
      ) {
        return null;
      }
      if (await tasks.findOne({ jobId: job._id }, { session, projection: { _id: 1 } })) {
        return null;
      }

      const committed = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          lifecycle: 'RUNNING',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
          businessPayloadReadyGeneration: input.businessPayloadReadyGeneration,
          businessPayloadReadyHash: payloadHash,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$workDeadlineAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
              { $lt: ['$businessPayloadReadyAt', '$businessOperationCutoffAt'] },
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
            outcome: 'planned',
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!committed?.committedAt) return null;

      await tasks.insertOne({
        _id: input.proposal.taskId,
        jobId: job._id,
        // A parent that aggregates a sequence must not be dispatchable: the lane
        // picks any READY task, so committing it READY would run the whole plan
        // as one ordinary single-agent task before its steps ever exist.
        phase: input.proposal.plannedSteps ? 'WAITING_DEPENDENCY' : 'READY',
        controlState: 'NONE',
        attemptMode: 'SERIAL',
        planVersion: job.planVersion,
        stopGeneration: 0,
        retryNotBefore: null,
        goal: input.proposal.goal ?? null,
        capability: input.proposal.capability ?? null,
        attemptCapMs: input.proposal.attemptCapMs ?? null,
        progressiveAttempt: input.proposal.progressiveAttempt ?? null,
        ...(input.proposal.plannedSteps
          ? { plannedSteps: input.proposal.plannedSteps }
          : {}),
        durableProgressFingerprints: [],
        activeAttemptId: null,
        businessPayloadReadyAttemptId: null,
        businessPayloadReadyGeneration: 0,
        resultApplyMode: 'RESULT_DRAIN_V1',
        pendingResultId: null,
        appliedResultId: null,
        createdAt: committed.committedAt,
        updatedAt: committed.committedAt,
      }, { session });

      const jobCas = await jobs.updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          activeActivationId: activation._id,
          terminalOutcome: null,
          controlState: 'NONE',
          phase: { $in: ['ACCEPTED', 'READY'] },
          planVersion: activation.planVersionAtClaim,
          jobStopGeneration: activation.jobStopGenerationAtClaim,
          activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
        },
        {
          $set: {
            phase: 'DISPATCHING',
            activeActivationId: null,
            activationRecoveryAttempt: 0,
            activationRecoveryRootId: null,
            activationRecoveryRootKind: null,
            updatedAt: committed.committedAt,
          },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      if (jobCas.modifiedCount !== 1) {
        throw new ActivationBoundaryAuthorityLostError('planning reducer job CAS lost');
      }

      const sequence = await nextEventSeq(db, job._id, session);
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${sequence}`,
        jobId: job._id,
        sequence,
        type: 'JobPlanned',
        payload: {
          taskId: input.proposal.taskId,
          planVersion: job.planVersion,
          activationId: activation._id,
        },
        createdAt: committed.committedAt,
      }, { session });
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(),
        aggregate: job._id,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: {
          jobId: job._id,
          reason: 'planning_committed',
          activationDispatchGeneration: job.activationDispatchGeneration,
        },
        createdAt: committed.committedAt,
      }, { session });

      return {
        taskId: input.proposal.taskId,
        activationId: activation._id,
        deduped: false,
      };
    });
    return value;
  } catch (err) {
    if (err instanceof ActivationBoundaryAuthorityLostError) return null;
    throw err;
  }
}

/**
 * Control-plane helper. The caller updates/bumps the job authority in the same
 * transaction; this function only fences and settles the current activation.
 */
/**
 * Release a planning activation that ended by asking the user (F5B increment 4).
 *
 * Separate from `commitPlanningActivation` because nothing is planned: no task,
 * no proposal hash. The activation still has to settle and hand back the job's
 * active slot, and the job pointer has to be cleared with it — the two together
 * are what let the next activation run once the answer arrives.
 */
async function settleActivationAsAsked(
  client: MongoClient,
  db: Db,
  jobId: string,
  activationId: string,
): Promise<boolean> {
  const { value } = await runTxn(client, async (session) => {
    const now = new Date();
    const settled = await db.collection<LaneActivationDoc>(COLLECTIONS.activations).updateOne(
      {
        _id: activationId,
        jobId,
        activeSlot: true,
        lifecycle: { $in: ACTIVE_ACTIVATION_LIFECYCLES },
      },
      {
        $set: {
          lifecycle: 'COMMITTED',
          activeSlot: false,
          leaseOwner: null,
          leaseExpiresAt: null,
          committedAt: now,
          outcome: 'asked_user',
          updatedAt: now,
        },
        $inc: { activationFence: 1 },
      },
      { session },
    );
    if (settled.modifiedCount !== 1) return false;
    await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
      { _id: jobId, activeActivationId: activationId },
      { $set: { activeActivationId: null, updatedAt: now } },
      { session },
    );
    return true;
  });
  return value;
}

export async function abandonActiveActivationInSession(
  db: Db,
  job: JobDoc,
  session: ClientSession,
  reasonCode: string,
  at: Date,
): Promise<boolean> {
  if (job.activeActivationId === null) return false;
  const abandoned = await db.collection<LaneActivationDoc>(COLLECTIONS.activations).updateOne(
    {
      _id: job.activeActivationId,
      jobId: job._id,
      activeSlot: true,
      lifecycle: { $in: ACTIVE_ACTIVATION_LIFECYCLES },
    },
    {
      $set: {
        lifecycle: 'ABANDONED',
        activeSlot: false,
        leaseOwner: null,
        leaseExpiresAt: null,
        reasonCode,
        updatedAt: at,
      },
      $inc: { activationFence: 1 },
    },
    { session },
  );
  return abandoned.modifiedCount === 1;
}

/**
 * Compatibility façade for callers that historically expected one reaper call
 * to leave ordinary demand ready. R0 now hands the slot to CONTROL_RECOVERY;
 * R1 is then drained through its distinct control outbox. A crash between these
 * awaits is safe: the activation + request already committed and the next call
 * drains it before considering the job stuck.
 */
export async function reapExpiredActivations(client: MongoClient, db: Db): Promise<number> {
  const reaped = await reapExpiredActivationsToControlRecovery(client, db);
  await drainControlRecovery(client, db);
  return reaped;
}

/** Convenience path used by planJob/laneStep; every mutation still uses primitives above. */
export async function runPlanningActivation(
  client: MongoClient,
  db: Db,
  jobId: string,
  opts: PlanningActivationOptions & {
    leaseOwner?: string;
    leaseTtlMs?: number;
    /**
     * When supplied by a claimed wake, continue exactly that activation.
     * `null` means the wake had no planning activation and may not create one.
     */
    requiredActivationId?: string | null;
    /**
     * F5B: how this activation decides what to do. Defaults to the deterministic
     * single-SERIAL-task behaviour this slice has always had; a model-backed
     * decider is injected here from increment 2, exactly the way `ModelCaller` is
     * injected into the execution gateway.
     */
    decide?: LaneDecider;
    /**
     * The attempt window for a chosen capability. Injected like `decide`, so the
     * substrate keeps no knowledge of the agent roster.
     */
    attemptCapFor?: (capability: string | null) => number | undefined;
    /** Earned-time policy for a chosen capability; code-owned, never model input. */
    progressiveAttemptFor?: (
      capability: string | null,
    ) => ProgressiveAttemptPolicy | undefined;
  } = {},
): Promise<{ taskId: string; activationId: string } | null> {
  const activation = opts.requiredActivationId === undefined
    ? await materializePlanningActivation(client, db, jobId, opts)
    : opts.requiredActivationId === null
      ? null
      : await db.collection<LaneActivationDoc>(COLLECTIONS.activations).findOne({
        _id: opts.requiredActivationId,
        jobId,
        kind: 'BUSINESS',
        activeSlot: true,
        lifecycle: { $in: ACTIVE_ACTIVATION_LIFECYCLES },
      });
  if (!activation) return null;
  const leaseOwner = opts.leaseOwner ?? `lane-planner:${globalThis.crypto.randomUUID()}`;
  const lease = await claimPlanningActivation(client, db, {
    activationId: activation._id,
    leaseOwner,
    leaseTtlMs: opts.leaseTtlMs,
  });
  if (!lease) return null;
  if (!await startPlanningActivation(client, db, {
    activationId: activation._id,
    leaseOwner,
    activationFence: lease.activationFence,
  })) {
    return null;
  }
  // ── F5B seam: the activation's decision ──────────────────────────────────
  // Everything above (claim, lease, fence, RUNNING CAS) and everything below
  // (freeze generation+hash before the business cutoff, commit exactly that hash
  // before the work deadline) is authority owned by the Service and is unchanged.
  // ONLY the choice of what to do is delegated here — deterministically today,
  // by a model from increment 2.
  //
  // The decision carries intent only. `jobId`, `taskId` and `planVersion` are
  // inserted below by this code, never by the decider: §4.2 forbids trusting a
  // model-supplied taskId/status/fence, and the cheapest way to honour that is to
  // give the decision nowhere to put one (see assertLaneDecision).
  const decide = opts.decide ?? deterministicSerialDecider;
  let decision: LaneDecisionV1;
  // The activation doc carries `planVersionAtClaim` but not the goal, so read
  // it from the job. A decider needs to know what it is deciding about, and an
  // indexed `_id` lookup is cheap next to the writes this path already makes.
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .findOne({ _id: jobId }, { projection: { goal: 1, requestedCapability: 1 } });
  // F6 cutover: the PRODUCER already named the specialist (`requestedCapability`,
  // frozen at the command boundary). Asking a model who should do work whose
  // owner is already known would be a wasted call that can also disagree — a
  // legacy `delegate_task(targetAgent: 'chefAgent')` must reach chefAgent, not
  // "whoever the router liked". The pin only chooses WHO; the budget, the cap
  // and the freeze below are unchanged and still code-owned.
  const pinned = typeof job?.requestedCapability === 'string' && job.requestedCapability.length > 0
    ? job.requestedCapability
    : null;
  try {
    decision = pinned
      ? { kind: 'dispatch', attemptMode: 'SERIAL', capability: pinned }
      : await decide({
        jobId,
        goal: job?.goal ?? '',
        planVersion: activation.planVersionAtClaim,
        hasTasks: false,
        businessOperationCutoffAt: activation.businessOperationCutoffAt,
      });
    assertLaneDecision(decision);
  } catch (error) {
    // Fail closed: an unusable decision must not stall or corrupt the lane, so it
    // falls back to the deterministic behaviour this slice already had.
    decision = { kind: 'dispatch', attemptMode: 'SERIAL' };
    // …but it must not be SILENT either. A decider that keeps failing means the
    // lane is quietly running without the coordinator it was given, which looks
    // identical to working correctly. Deterministic `_id` keeps repeated
    // fallbacks on one activation to a single alert.
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
      _id: `obx_lane_decision_fallback:${activation._id}`,
      aggregate: jobId,
      type: 'OperatorAlertRequested',
      state: 'PENDING',
      payload: {
        alertType: 'lane_decision_fallback',
        jobId,
        activationId: activation._id,
        detail: (error as Error).message,
      },
      createdAt: new Date(),
    } as unknown as OutboxDoc).catch(() => undefined);
  }

  // F5B increment 4: a lane that needs a human answer opens a durable question
  // instead of planning. The job goes to AWAITING_USER, the Meta Front surfaces
  // it as `awaitingAnswer`, and `orchestration_answer_job_request` resumes it —
  // the human-in-the-loop path closes end to end without a new surface.
  if (decision.kind === 'request_user') {
    const asked = await openLaneUserRequest(client, db, { jobId, question: decision.question })
      .catch(() => null);
    if (asked) {
      // Settle the activation. Asking IS this activation's completed work, so it
      // must release the job's unique active slot — otherwise the slot stays held
      // and the job cannot plan even after the user answers, which is exactly how
      // "ask the user" turns into "hang the job".
      await settleActivationAsAsked(client, db, jobId, activation._id).catch(() => undefined);
    }
    return null;
  }

  // F6B — an ordered plan. The steps' budgets are computed by CODE from the
  // capability each step named, exactly as for a single task: the model chooses
  // WHO, this decides HOW LONG. A step naming nothing gets the default window,
  // the same as an unopinionated dispatch.
  if (decision.kind === 'plan_steps') {
    const plannedSteps = decision.steps.map((step) => ({
      goal: step.goal,
      ...(step.capability !== undefined ? { capability: step.capability } : {}),
      ...(() => {
        const cap = opts.attemptCapFor?.(step.capability ?? null);
        return cap !== undefined ? { attemptCapMs: cap } : {};
      })(),
      ...(() => {
        const policy = opts.progressiveAttemptFor?.(step.capability ?? null);
        return policy !== undefined ? { progressiveAttempt: policy } : {};
      })(),
    }));
    const planProposal: PlanningProposalV1 = {
      kind: 'PLAN_SINGLE_SERIAL_TASK_V1',
      jobId,
      taskId: newTaskId(),
      planVersion: activation.planVersionAtClaim,
      attemptMode: 'SERIAL',
      plannedSteps,
    };
    const planMarker = await markPlanningActivationPayloadReady(client, db, {
      activationId: activation._id,
      leaseOwner,
      activationFence: lease.activationFence,
      proposal: planProposal,
    });
    if (!planMarker.ready) return null;
    const planCommitted = await commitPlanningActivation(client, db, {
      activationId: activation._id,
      leaseOwner,
      activationFence: lease.activationFence,
      businessPayloadReadyGeneration: planMarker.generation,
      proposal: planProposal,
    });
    return planCommitted
      ? { taskId: planCommitted.taskId, activationId: planCommitted.activationId }
      : null;
  }

  // `wait`, `synthesize` and `terminalize` are validated but not executable
  // here: evaluating finished work belongs to a FINAL_DECISION activation
  // (RESULT_DRAIN terminalizes in its own transaction and may not run a model),
  // which is still deferred. A decider returning one gets no plan committed
  // rather than a pretended one.
  if (decision.kind !== 'dispatch') return null;

  // The decision's intent enters the frozen plan here — and ONLY here. Keys are
  // omitted rather than set to undefined so an unopinionated plan hashes exactly
  // as it did before capability routing existed.
  const attemptCapMs = decision.kind === 'dispatch'
    ? opts.attemptCapFor?.(decision.capability ?? null)
    : undefined;
  const progressiveAttempt = decision.kind === 'dispatch'
    ? opts.progressiveAttemptFor?.(decision.capability ?? null)
    : undefined;
  const proposal: PlanningProposalV1 = {
    kind: 'PLAN_SINGLE_SERIAL_TASK_V1',
    jobId,
    taskId: newTaskId(),
    planVersion: activation.planVersionAtClaim,
    attemptMode: 'SERIAL',
    ...(decision.capability !== undefined ? { capability: decision.capability } : {}),
    ...(decision.taskGoal !== undefined ? { goal: decision.taskGoal } : {}),
    // The budget follows the CHOSEN specialist and is computed by code, never by
    // the decider: a model allowed to set its own window would be a model
    // allowed to spend an hour.
    ...(attemptCapMs !== undefined ? { attemptCapMs } : {}),
    ...(progressiveAttempt !== undefined ? { progressiveAttempt } : {}),
  };
  const marker = await markPlanningActivationPayloadReady(client, db, {
    activationId: activation._id,
    leaseOwner,
    activationFence: lease.activationFence,
    proposal,
  });
  if (!marker.ready) return null;
  const committed = await commitPlanningActivation(client, db, {
    activationId: activation._id,
    leaseOwner,
    activationFence: lease.activationFence,
    businessPayloadReadyGeneration: marker.generation,
    proposal,
  });
  return committed
    ? { taskId: committed.taskId, activationId: committed.activationId }
    : null;
}
