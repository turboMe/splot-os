/**
 * Control-command boundaries (plan §8.4/§8.6, §7.4).
 *
 * The flat-SERIAL slice is idempotent, owner-scoped and durable. Pause competes
 * with dispatch/operation-start, captures only valid RUNNING work as
 * finish-current, and rejects resume while a RUNNING attempt remains unsettled.
 * Cancel fences admitted work; safe pre-start attempts settle immediately while
 * an active supervised attempt enters the narrow PROCESS_STOP_V1 receipt
 * boundary. The full suspension/effect/child stop and terminal barrier remains
 * deferred, so an active cancel is durably pending rather than falsely terminal.
 */
import type { Db, Filter, MongoClient } from 'mongodb';
import type { JobTerminalOutcome, JobControlState } from '../contracts/index.js';
import { newOutboxId, newJobId } from '../contracts/index.js';
import { runTxn, canonicalHash, isDuplicateKeyError } from './txn.js';
import {
  COLLECTIONS,
  CONTROL_BUDGET_POLICY_V1,
  type AttemptDoc,
  type CommandDoc,
  type JobDoc,
  type JobEventDoc,
  type OutboxDoc,
  type TaskDoc,
  type TimerDoc,
  type JobInboxDoc,
  type ControlRequestDoc,
} from './collections.js';
import { CommandConflictError } from './command-boundary.js';
import { abandonActiveActivationInSession } from './activations.js';
import { requestAttemptStopInSession } from './attempt-stop.js';
import {
  classifyFlatStopScopeInSession,
} from './flat-terminal-barrier.js';
import {
  ensureStopControlRecoveryInSession,
  runStopControlRecoveryActivation,
} from './stop-control-recovery.js';

async function nextEventSeq(db: Db, jobId: string, session: import('mongodb').ClientSession): Promise<number> {
  const last = await db.collection<JobEventDoc>(COLLECTIONS.events).find({ jobId }, { session }).sort({ sequence: -1 }).limit(1).next();
  return (last?.sequence ?? -1) + 1;
}

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} not found for this resource`);
    this.name = 'JobNotFoundError';
  }
}

export class PauseInProgressError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} still has unsettled work in its pause barrier`);
    this.name = 'PauseInProgressError';
  }
}

export interface ControlCommandInput {
  resourceId: string;
  commandId: string;
  jobId: string;
}
export type CancelJobInput = ControlCommandInput;

export interface PauseResumeResult {
  jobId: string;
  controlState: JobControlState;
  changed: boolean;
  deduped: boolean;
}

/**
 * Pause a job: stop new dispatch (`controlState=PAUSE_REQUESTED`), cancel
 * pre-start admissions, and capture valid RUNNING attempts as finish-current.
 * Idempotent and owner-scoped. A terminal or stopping job is left unchanged.
 */
export async function pauseJob(client: MongoClient, db: Db, input: ControlCommandInput): Promise<PauseResumeResult> {
  return applyControl(client, db, input, 'pause_job', (job) => {
    if (job.terminalOutcome !== null || job.controlState === 'STOP_REQUESTED') return null; // no change
    if (job.controlState === 'PAUSE_REQUESTED') return null; // already paused
    return {
      setControl: 'PAUSE_REQUESTED',
      eventType: 'JobPaused',
      // The current-generation wake is also the finish-current/result-drain
      // handoff. laneStep permits terminal reduction before its pause guard,
      // but never dispatches new work while PAUSE_REQUESTED.
      wake: true,
      bumpPauseGeneration: true,
      captureRunningAttempts: true,
      cancelPreStartAttempts: true,
    };
  });
}

/**
 * Resume a paused job: clear the pause and wake the lane (§8.4). A RUNNING
 * attempt keeps the flat pause barrier in progress and yields a typed conflict;
 * otherwise a non-paused job is a no-op success.
 */
export async function resumeJob(client: MongoClient, db: Db, input: ControlCommandInput): Promise<PauseResumeResult> {
  return applyControl(client, db, input, 'resume_job', (job) => {
    if (job.terminalOutcome !== null) return null;
    if (job.controlState !== 'PAUSE_REQUESTED') return null; // not paused → no-op
    return {
      setControl: 'NONE',
      eventType: 'JobResumed',
      wake: true,
      bumpPauseGeneration: false,
      captureRunningAttempts: false,
      cancelPreStartAttempts: false,
    };
  });
}

interface ControlDecision {
  setControl: JobControlState;
  eventType: string;
  wake: boolean;
  bumpPauseGeneration: boolean;
  captureRunningAttempts: boolean;
  cancelPreStartAttempts: boolean;
}

async function applyControl(
  client: MongoClient, db: Db, input: ControlCommandInput, type: string,
  decide: (job: JobDoc) => ControlDecision | null,
): Promise<PauseResumeResult> {
  const key = `${input.resourceId}:${input.commandId}`;
  const payloadHash = canonicalHash({ type, jobId: input.jobId });
  const commands = db.collection<CommandDoc>(COLLECTIONS.commands);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  const existing = await commands.findOne({ _id: key });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new CommandConflictError(input.resourceId, input.commandId);
    const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId });
    return { jobId: input.jobId, controlState: job?.controlState ?? 'NONE', changed: false, deduped: true };
  }

  try {
    const { value } = await runTxn(client, async (session) => {
      const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId }, { session });
      if (!job) throw new JobNotFoundError(input.jobId);
      const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);

      // A resume command must not undo PAUSE_REQUESTED while an attempt is
      // still inside the flat slice's pause barrier. Throw before persisting
      // the command so the same idempotency key can be retried after recovery.
      if (
        type === 'resume_job'
        && job.controlState === 'PAUSE_REQUESTED'
        && await attempts.findOne(
          {
            jobId: job._id,
            planVersion: job.planVersion,
            lifecycle: 'RUNNING',
          },
          { session, projection: { _id: 1 } },
        )
      ) {
        throw new PauseInProgressError(job._id);
      }
      await commands.insertOne({
        _id: key, resourceId: input.resourceId, conversationId: job.conversationId, commandId: input.commandId,
        type, payloadHash, jobId: input.jobId, state: 'APPLIED', createdAt: new Date(),
      }, { session });

      const decision = decide(job);
      if (!decision) return { jobId: job._id, controlState: job.controlState, changed: false, deduped: false } as PauseResumeResult;

      const now = new Date();
      await abandonActiveActivationInSession(db, job, session, type, now);
      const cas = await jobs.updateOne(
        { _id: job._id, stateVersion: job.stateVersion, terminalOutcome: null },
        {
          $set: {
            controlState: decision.setControl,
            activeActivationId: null,
            activationRecoveryAttempt: 0,
            activationRecoveryRootId: null,
            activationRecoveryRootKind: null,
            updatedAt: now,
          },
          $inc: {
            stateVersion: 1,
            activationDispatchGeneration: 1,
            ...(decision.bumpPauseGeneration ? { pauseGeneration: 1 } : {}),
          },
        },
        { session },
      );
      if (cas.modifiedCount !== 1) throw new Error(`${type} CAS lost`);

      const effectivePauseGeneration = job.pauseGeneration + (decision.bumpPauseGeneration ? 1 : 0);
      if (decision.captureRunningAttempts) {
        await attempts.updateMany(
          {
            jobId: job._id,
            planVersion: job.planVersion,
            pauseGenerationAtDispatch: job.pauseGeneration,
            lifecycle: 'RUNNING',
            $expr: {
              $and: [
                { $gt: ['$leaseExpiresAt', '$$NOW'] },
                { $gt: ['$hardDeadlineAt', '$$NOW'] },
                {
                  $or: [
                    { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
                    {
                      $and: [
                        { $gt: ['$businessPayloadReadyGeneration', 0] },
                        { $lt: ['$businessPayloadReadyAt', '$businessOperationCutoffAt'] },
                      ],
                    },
                  ],
                },
              ],
            },
          } as unknown as Filter<AttemptDoc>,
          [{
            $set: {
              finishCurrentPauseGeneration: effectivePauseGeneration,
              updatedAt: '$$NOW',
            },
          }],
          { session },
        );
      }
      if (decision.cancelPreStartAttempts) {
        // Pause wins over QUEUED/LEASED admissions that have not crossed the
        // operation-start CAS. Only already-RUNNING attempts enter finish-current.
        // An admission whose business cutoff already elapsed instead wins as a
        // typed queue expiry; pause/resume must never mint it a fresh deadline.
        const preStart = await attempts.find({
          jobId: job._id,
          planVersion: job.planVersion,
          pauseGenerationAtDispatch: job.pauseGeneration,
          lifecycle: { $in: ['QUEUED', 'LEASED'] },
        }, { session }).toArray();
        if (preStart.length > 0) {
          const pausedAttemptIds: string[] = [];
          const expiredAttemptIds: string[] = [];
          const pausedTaskIds: string[] = [];
          const expiredTaskIds: string[] = [];

          for (const preStartAttempt of preStart) {
            const baseFilter = {
              _id: preStartAttempt._id,
              lifecycle: { $in: ['QUEUED', 'LEASED'] },
              planVersion: job.planVersion,
              pauseGenerationAtDispatch: job.pauseGeneration,
            } satisfies Filter<AttemptDoc>;

            // Evaluate time in the conditional store write. Trying the
            // pre-cutoff branch first gives the pause a precise linearization
            // point; if it loses at the boundary, the expiry branch must win.
            const pausedAttempt = await attempts.findOneAndUpdate(
              {
                ...baseFilter,
                $expr: { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
              } as unknown as Filter<AttemptDoc>,
              [{
                $set: {
                  lifecycle: 'FINISHED',
                  outcome: 'CANCELLED',
                  reasonCode: 'pause_interrupt',
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  updatedAt: '$$NOW',
                  attemptFence: { $add: ['$attemptFence', 1] },
                },
              }],
              { session, returnDocument: 'after' },
            );
            if (pausedAttempt) {
              pausedAttemptIds.push(pausedAttempt._id);
              pausedTaskIds.push(pausedAttempt.taskId);
              continue;
            }

            const expiredAttempt = await attempts.findOneAndUpdate(
              {
                ...baseFilter,
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
              { session, returnDocument: 'after' },
            );
            if (!expiredAttempt) {
              throw new Error(`pause pre-start cutoff CAS lost for ${preStartAttempt._id}`);
            }
            expiredAttemptIds.push(expiredAttempt._id);
            expiredTaskIds.push(expiredAttempt.taskId);
          }

          if (pausedAttemptIds.length > 0) {
            const pausedTaskIdsUnique = [...new Set(pausedTaskIds)];
            const pausedTasks = await db.collection<TaskDoc>(COLLECTIONS.tasks).updateMany(
              {
                _id: { $in: pausedTaskIdsUnique },
                jobId: job._id,
                planVersion: job.planVersion,
                phase: 'DISPATCHED',
                controlState: 'NONE',
                $or: [
                  { activeAttemptId: null },
                  { activeAttemptId: { $in: pausedAttemptIds } },
                ],
              },
              {
                $set: {
                  phase: 'READY',
                  activeAttemptId: null,
                  businessPayloadReadyAttemptId: null,
                  businessPayloadReadyGeneration: 0,
                  retryNotBefore: null,
                  updatedAt: now,
                },
              },
              { session },
            );
            if (pausedTasks.modifiedCount !== pausedTaskIdsUnique.length) {
              throw new Error('pause lost pre-start task authority');
            }
          }

          if (expiredAttemptIds.length > 0) {
            const expiredTaskIdsUnique = [...new Set(expiredTaskIds)];
            const expiredTasks = await db.collection<TaskDoc>(COLLECTIONS.tasks).updateMany(
              {
                _id: { $in: expiredTaskIdsUnique },
                jobId: job._id,
                planVersion: job.planVersion,
                phase: 'DISPATCHED',
                controlState: 'NONE',
                $or: [
                  { activeAttemptId: null },
                  { activeAttemptId: { $in: expiredAttemptIds } },
                ],
              },
              {
                $set: {
                  phase: 'FAILED',
                  activeAttemptId: null,
                  businessPayloadReadyAttemptId: null,
                  businessPayloadReadyGeneration: 0,
                  retryNotBefore: null,
                  updatedAt: now,
                },
              },
              { session },
            );
            if (expiredTasks.modifiedCount !== expiredTaskIdsUnique.length) {
              throw new Error('pause lost expired pre-start task authority');
            }
            await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
              _id: newOutboxId(),
              aggregate: job._id,
              type: 'LaneWakeRequested',
              state: 'PENDING',
              payload: {
                jobId: job._id,
                reason: 'queue_expired',
                activationDispatchGeneration: job.activationDispatchGeneration + 1,
              },
              createdAt: now,
            }, { session });
          }
        }
      }

      const seq = await nextEventSeq(db, job._id, session);
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${seq}`, jobId: job._id, sequence: seq, type: decision.eventType,
        payload: { commandId: input.commandId }, createdAt: now,
      }, { session });

      if (decision.wake) {
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
          _id: newOutboxId(), aggregate: job._id, type: 'LaneWakeRequested', state: 'PENDING',
          payload: {
            jobId: job._id,
            reason: type,
            activationDispatchGeneration: job.activationDispatchGeneration + 1,
          },
          createdAt: now,
        }, { session });
      }
      return { jobId: job._id, controlState: decision.setControl, changed: true, deduped: false } as PauseResumeResult;
    });
    return value;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const winner = await commands.findOne({ _id: key });
      if (winner && winner.payloadHash === payloadHash) {
        const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId });
        return { jobId: input.jobId, controlState: job?.controlState ?? 'NONE', changed: false, deduped: true };
      }
      throw new CommandConflictError(input.resourceId, input.commandId);
    }
    throw err;
  }
}

export interface CancelJobResult {
  jobId: string;
  controlState: JobControlState;
  terminalOutcome: JobTerminalOutcome | null;
  pendingTerminalOutcome: JobTerminalOutcome | null;
  /** True only when the job was already terminal. */
  alreadyTerminal: boolean;
  deduped: boolean;
}

const DEFAULT_ATTEMPT_STOP_GRACE_MS = 5_000;

function cancelResult(job: JobDoc, deduped: boolean): CancelJobResult {
  return {
    jobId: job._id,
    controlState: job.controlState,
    terminalOutcome: job.terminalOutcome,
    pendingTerminalOutcome: job.pendingTerminalOutcome ?? null,
    alreadyTerminal: job.terminalOutcome !== null,
    deduped,
  };
}

export async function cancelJob(
  client: MongoClient,
  db: Db,
  input: CancelJobInput,
  opts: { attemptStopGraceMs?: number } = {},
): Promise<CancelJobResult> {
  const attemptStopGraceMs = opts.attemptStopGraceMs ?? DEFAULT_ATTEMPT_STOP_GRACE_MS;
  if (!Number.isInteger(attemptStopGraceMs) || attemptStopGraceMs < 0) {
    throw new Error('attempt stop grace must be a non-negative integer');
  }
  const key = `${input.resourceId}:${input.commandId}`;
  const payloadHash = canonicalHash({ type: 'cancel_job', jobId: input.jobId });
  const commands = db.collection<CommandDoc>(COLLECTIONS.commands);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  const existing = await commands.findOne({ _id: key });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new CommandConflictError(input.resourceId, input.commandId);
    const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId });
    if (!job) throw new JobNotFoundError(input.jobId);
    return cancelResult(job, true);
  }

  try {
    const { value } = await runTxn(client, async (session) => {
      const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId }, { session });
      if (!job) throw new JobNotFoundError(input.jobId);

      await commands.insertOne({
        _id: key,
        resourceId: input.resourceId,
        conversationId: job.conversationId,
        commandId: input.commandId,
        type: 'cancel_job',
        payloadHash,
        jobId: input.jobId,
        state: 'APPLIED',
        createdAt: new Date(),
      }, { session });

      // Idempotent: an already-terminal job keeps its outcome, no re-terminalize.
      if (job.terminalOutcome !== null) {
        return {
          result: cancelResult(job, false),
          activationId: null,
        };
      }

      // A different idempotency key may observe the already durable first stop.
      // It is applied as a no-op and must not move generations or the grace edge.
      if (job.controlState === 'STOP_REQUESTED') {
        return {
          result: cancelResult(job, false),
          activationId: null,
        };
      }

      const cancelNow = new Date();
      const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
      // Every process lineage is in scope, including an old-plan owner and an
      // owner already fenced UNKNOWN by lease recovery. Neither can be ignored
      // merely because its business attempt is no longer current.
      const allAttempts = await attempts.find(
        { jobId: job._id },
        { session },
      ).toArray();
      const openProcessLineage = allAttempts.filter((attempt) =>
        (
          (
            attempt.lifecycle === 'RUNNING'
            || attempt.lifecycle === 'STOP_REQUESTED'
          )
          && attempt.terminationConfirmed !== true
        )
        || (
          attempt.lifecycle === 'FINISHED'
          && attempt.processOwner
          && attempt.terminationConfirmed !== true
          && attempt.stopReceipt === null
        ));
      const activeAttempts = openProcessLineage.filter(
        (attempt) => attempt.lifecycle === 'RUNNING' || attempt.lifecycle === 'STOP_REQUESTED',
      );
      const activeAttemptIds = activeAttempts.map((attempt) => attempt._id);
      const activeTaskIds = [...new Set(activeAttempts.map((attempt) => attempt.taskId))];
      const openLineageTaskIds = [
        ...new Set(openProcessLineage.map((attempt) => attempt.taskId)),
      ];
      const unresolvedAttempts = openProcessLineage.filter(
        (attempt) => attempt.lifecycle === 'FINISHED',
      );
      const unknownAttempts = allAttempts.filter(
        (attempt) => attempt.outcome === 'UNKNOWN_OUTCOME',
      );
      const unknownTaskIds = [
        ...new Set(unknownAttempts.map((attempt) => attempt.taskId)),
      ];
      // A_evidence is still deferred. A forward-version/corrupt
      // EVIDENCE_ONLY row therefore cannot be silently treated as an ordinary
      // result or as safely stopped; preserve it as a visible unsupported
      // terminal obligation until the dedicated authority exists.
      const evidenceOnlyAttempts = allAttempts.filter(
        (attempt) => attempt.lifecycle === 'EVIDENCE_ONLY',
      );
      const evidenceOnlyTaskIds = [
        ...new Set(evidenceOnlyAttempts.map((attempt) => attempt.taskId)),
      ];
      const uncertainTaskIds = [
        ...new Set([...unknownTaskIds, ...evidenceOnlyTaskIds]),
      ];
      const protectedBarrierTaskIds = [
        ...new Set([...openLineageTaskIds, ...uncertainTaskIds]),
      ];
      const flatScope = await classifyFlatStopScopeInSession(
        db,
        session,
        job,
        { allowEmpty: true },
      );
      // F6B — the decisive latch is HERE, not in the reducer.
      //
      // The barrier mode is derived from this blocker, and cancel classifies the
      // shape at the one moment a multi-step plan is guaranteed NOT to qualify:
      // its steps are still live. Marking it BLOCKED_UNSUPPORTED then is
      // permanent — the recovery scan only ever looks at FLAT_STOP_V1 jobs — so
      // every cancelled sequence stayed open forever waiting for a human.
      // `pending` says "known shape, not settled yet": no blocker, so the job
      // keeps FLAT_STOP_V1 and gets re-examined once its steps land.
      const shapeBlocker = flatScope.pending
        ? null
        : !flatScope.supported
          ? flatScope.blocker ?? 'unsupported_flat_terminal_shape'
          : flatScope.empty && allAttempts.length > 0
            ? 'attempt_without_root_task'
            : null;
      // Evidence-only attempts still block regardless of shape: that is about
      // what the attempts proved, not about how many tasks there are.
      const terminalBarrierBlocker = shapeBlocker
        ?? (evidenceOnlyAttempts.length > 0 ? 'evidence_only_attempt' : null);
      // Every terminal request first becomes pending. The same reducer is used
      // for the immediate empty/pre-start case and the receipt-driven case, so
      // no lifecycle/activation/UNKNOWN obligation can bypass the full preflight.
      const pendingTerminalOutcome: JobTerminalOutcome =
        unresolvedAttempts.length > 0 || unknownAttempts.length > 0
          ? 'UNKNOWN_OUTCOME'
          : 'CANCELLED';

      await abandonActiveActivationInSession(db, job, session, 'user_cancel', cancelNow);
      const nextJobStopGeneration = job.jobStopGeneration + 1;
      const stopGraceDueAt =
        openProcessLineage.length > 0 || unknownAttempts.length > 0
        ? new Date(
            Math.min(
              cancelNow.getTime() + attemptStopGraceMs,
              ...activeAttempts.map((attempt) =>
                attempt.lifecycle === 'STOP_REQUESTED' && attempt.attemptStopGraceDueAt
                  ? attempt.attemptStopGraceDueAt.getTime()
                  : attempt.hardDeadlineAt.getTime()),
              ...unresolvedAttempts.map(() => cancelNow.getTime()),
              ...unknownAttempts.map(() => cancelNow.getTime()),
            ),
          )
        : null;
      const cas = await jobs.updateOne(
        { _id: job._id, stateVersion: job.stateVersion, terminalOutcome: null },
        {
          $set: {
            phase: 'RECONCILING',
            controlState: 'STOP_REQUESTED',
            terminalOutcome: null,
            pendingTerminalOutcome,
            primaryJobStopCause: 'user_cancel',
            secondaryJobStopCauses: [],
            stopGraceDueAt,
            terminalBarrierMode: terminalBarrierBlocker
              ? 'BLOCKED_UNSUPPORTED'
              : 'FLAT_STOP_V1',
            terminalBarrierBlocker,
            terminalBarrierNextCheckAt:
              terminalBarrierBlocker === null
                ? cancelNow
                : null,
            terminalBarrierProbeAttempt: 0,
            activeActivationId: null,
            activationRecoveryAttempt: 0,
            activationRecoveryRootId: null,
            activationRecoveryRootKind: null,
            resolvedInboxWatermark: job.inboxHighWatermark,
            updatedAt: cancelNow,
          },
          $inc: {
            stateVersion: 1,
            activationDispatchGeneration: 1,
            jobStopGeneration: 1,
            controlVersion: 1,
          },
        },
        { session },
      );
      if (cas.modifiedCount !== 1) throw new Error('cancel CAS lost — concurrent terminalizer');

      // Pre-start admissions and a RUNNING record whose normal tree-empty proof
      // already committed have no live process authority left. They settle
      // immediately. Other active work retains its exact fence/owner.
      await attempts.updateMany(
        {
          jobId: job._id,
          lifecycle: { $in: ['CREATED', 'QUEUED', 'LEASED'] },
        },
        {
          $set: {
            lifecycle: 'FINISHED',
            outcome: 'CANCELLED',
            reasonCode: 'user_cancel',
            leaseOwner: null,
            leaseExpiresAt: null,
            processState: 'NONE',
            terminationConfirmed: true,
            updatedAt: cancelNow,
          },
          $inc: { attemptFence: 1 },
        },
        { session },
      );
      await attempts.updateMany(
        {
          jobId: job._id,
          lifecycle: { $in: ['RUNNING', 'STOP_REQUESTED'] },
          processState: 'EXITED',
          terminationConfirmed: true,
          processExitReceipt: { $type: 'object' },
        },
        {
          $set: {
            lifecycle: 'FINISHED',
            outcome: 'CANCELLED',
            reasonCode: 'user_cancel',
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: cancelNow,
          },
          $inc: { attemptFence: 1 },
        },
        { session },
      );

      await db.collection<TaskDoc>(COLLECTIONS.tasks).updateMany(
        {
          jobId: job._id,
          ...(protectedBarrierTaskIds.length > 0
            ? { _id: { $nin: protectedBarrierTaskIds } }
            : {}),
          phase: {
            $in: [
              'PLANNED', 'READY', 'DISPATCHED', 'AWAITING_RESULT',
              'DRAINING_SPECULATION', 'WAITING_INPUT', 'WAITING_DEPENDENCY',
              'RECONCILING', 'RETRY_PENDING',
            ],
          },
        },
        {
          $set: {
            phase: 'CANCELLED',
            activeAttemptId: null,
            businessPayloadReadyAttemptId: null,
            businessPayloadReadyGeneration: 0,
            pendingResultId: null,
            retryNotBefore: null,
            updatedAt: cancelNow,
          },
        },
        { session },
      );
      if (uncertainTaskIds.length > 0) {
        await db.collection<TaskDoc>(COLLECTIONS.tasks).updateMany(
          {
            _id: { $in: uncertainTaskIds },
            jobId: job._id,
            phase: {
              $in: [
                'PLANNED', 'READY', 'DISPATCHED', 'AWAITING_RESULT',
                'DRAINING_SPECULATION', 'WAITING_INPUT', 'WAITING_DEPENDENCY',
                'RECONCILING', 'RETRY_PENDING',
              ],
            },
          },
          {
            $set: {
              phase: 'RECONCILING',
              controlState: 'STOP_REQUESTED',
              activeAttemptId: null,
              businessPayloadReadyAttemptId: null,
              businessPayloadReadyGeneration: 0,
              pendingResultId: null,
              retryNotBefore: null,
              updatedAt: cancelNow,
            },
            $inc: { stopGeneration: 1 },
          },
          { session },
        );
      }
      if (activeTaskIds.length > 0) {
        await db.collection<TaskDoc>(COLLECTIONS.tasks).updateMany(
          {
            _id: { $in: activeTaskIds },
            jobId: job._id,
            activeAttemptId: { $in: activeAttemptIds },
            controlState: { $ne: 'STOP_REQUESTED' },
            phase: { $nin: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'TIMED_OUT', 'CANCELLED', 'SUPERSEDED', 'UNKNOWN_OUTCOME'] },
          },
          {
            $set: {
              phase: 'RECONCILING',
              controlState: 'STOP_REQUESTED',
              businessPayloadReadyAttemptId: null,
              businessPayloadReadyGeneration: 0,
              pendingResultId: null,
              retryNotBefore: null,
              updatedAt: cancelNow,
            },
            $inc: { stopGeneration: 1 },
          },
          { session },
        );
        // A stale-plan process can legitimately outlive a task already marked
        // terminal/superseded. Its process stop remains mandatory even though
        // there is no current task projection left to move.
      }

      await db.collection<TimerDoc>(COLLECTIONS.timers).updateMany(
        { jobId: job._id, state: 'PENDING', kind: { $ne: 'attempt_stop_grace' } },
        { $set: { state: 'CANCELLED' } },
        { session },
      );
      await db.collection<JobInboxDoc>(COLLECTIONS.inbox).updateMany(
        {
          jobId: job._id,
          state: { $in: ['RECEIVED', 'FAILED_RETRYABLE', 'PENDING_REDRIVE'] },
        },
        {
          $set: {
            state: 'REJECTED_STALE',
            resolvedByActivationId: null,
            resolutionCode: 'job_cancelled',
            retryTimerId: null,
            nextEligibleAt: null,
            retryReasonCode: null,
            resolvedAt: cancelNow,
          },
        },
        { session },
      );
      await db.collection<ControlRequestDoc>(COLLECTIONS.requests).updateMany(
        { jobId: job._id, state: 'OPEN' },
        { $set: { state: 'CANCELLED', answer: null } },
        { session },
      );
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateMany(
        { aggregate: job._id, type: 'LaneWakeRequested', state: 'PENDING' },
        { $set: { state: 'PUBLISHED' } },
        { session },
      );

      const last = await db.collection<JobEventDoc>(COLLECTIONS.events).find({ jobId: job._id }, { session }).sort({ sequence: -1 }).limit(1).next();
      const sequence = (last?.sequence ?? -1) + 1;
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${sequence}`,
        jobId: job._id,
        sequence,
        type: 'JobStopRequested',
        payload: {
          cause: 'user_cancel',
          commandId: input.commandId,
          jobStopGeneration: nextJobStopGeneration,
          pendingTerminalOutcome,
          activeAttemptIds: [
            ...new Set([
              ...openProcessLineage.map((attempt) => attempt._id),
              ...evidenceOnlyAttempts.map((attempt) => attempt._id),
            ]),
          ],
          terminalBarrierMode: terminalBarrierBlocker
            ? 'BLOCKED_UNSUPPORTED'
            : 'FLAT_STOP_V1',
          terminalBarrierBlocker,
        },
        createdAt: cancelNow,
      }, { session });

      if (openProcessLineage.length > 0) {
        const exactAttemptGraceDueAt: Date[] = [];
        for (const activeAttempt of activeAttempts) {
          const stop = await requestAttemptStopInSession(
            db,
            session,
            activeAttempt,
            'user_cancel',
            attemptStopGraceMs,
            nextJobStopGeneration,
          );
          if (!stop) {
            throw new Error(`cancel lost attempt stop authority for ${activeAttempt._id}`);
          }
          exactAttemptGraceDueAt.push(stop.attemptStopGraceDueAt);
        }
        const exactStopGraceDueAt = new Date(Math.min(
          ...exactAttemptGraceDueAt.map((dueAt) => dueAt.getTime()),
          ...unresolvedAttempts.map(() => cancelNow.getTime()),
        ));
        const graceProjection = await jobs.updateOne(
          {
            _id: job._id,
            stateVersion: job.stateVersion + 1,
            jobStopGeneration: nextJobStopGeneration,
            controlState: 'STOP_REQUESTED',
            terminalOutcome: null,
          },
          { $set: { stopGraceDueAt: exactStopGraceDueAt } },
          { session },
        );
        if (graceProjection.matchedCount !== 1) {
          throw new Error('cancel lost stop-grace projection authority');
        }
        for (const unresolvedAttempt of unresolvedAttempts) {
          const owner = unresolvedAttempt.processOwner!;
          const alertId = [
            'obx_process_unknown',
            unresolvedAttempt._id,
            owner.processExecutionId,
            owner.ownerGeneration,
          ].join(':');
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
            { _id: alertId },
            {
              $setOnInsert: {
                _id: alertId,
                aggregate: job._id,
                type: 'OperatorAlertRequested',
                state: 'PENDING',
                payload: {
                  alertType: 'process_termination_unconfirmed',
                  resourceId: job.resourceId,
                  conversationId: job.conversationId,
                  jobId: job._id,
                  taskId: unresolvedAttempt.taskId,
                  attemptId: unresolvedAttempt._id,
                  processExecutionId: owner.processExecutionId,
                  processOwnerGeneration: owner.ownerGeneration,
                  attemptOutcome: unresolvedAttempt.outcome,
                  jobStopGeneration: nextJobStopGeneration,
                  stopGeneration: unresolvedAttempt.stopGeneration ?? 0,
                  terminationConfirmed: false,
                  retrySuppressed: true,
                },
                createdAt: cancelNow,
              },
            },
            { session, upsert: true },
          );
        }
      }
      if (terminalBarrierBlocker) {
        const alertId =
          `obx_terminal_barrier_blocked:${job._id}:${nextJobStopGeneration}`;
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
                jobStopGeneration: nextJobStopGeneration,
                blocker: terminalBarrierBlocker,
              },
              createdAt: cancelNow,
            },
          },
          { session, upsert: true },
        );
      }

      const stopOwner = terminalBarrierBlocker
        ? null
        : await ensureStopControlRecoveryInSession(
            db,
            session,
            job._id,
            { makeEligibleNow: true },
          );
      return {
        result: {
          jobId: job._id,
          controlState: 'STOP_REQUESTED',
          terminalOutcome: null,
          pendingTerminalOutcome,
          alreadyTerminal: false,
          deduped: false,
        } satisfies CancelJobResult,
        activationId: stopOwner?.activationId ?? null,
      };
    });
    if (value.activationId) {
      await runStopControlRecoveryActivation(
        client,
        db,
        value.activationId,
      );
      const current = await jobs.findOne({
        _id: input.jobId,
        resourceId: input.resourceId,
      });
      if (current) {
        return {
          ...value.result,
          controlState: current.controlState,
          terminalOutcome: current.terminalOutcome,
          pendingTerminalOutcome: current.pendingTerminalOutcome ?? null,
        };
      }
    }
    return value.result;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const winner = await commands.findOne({ _id: key });
      if (winner && winner.payloadHash === payloadHash) {
        const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId });
        if (!job) throw new JobNotFoundError(input.jobId);
        return cancelResult(job, true);
      }
      throw new CommandConflictError(input.resourceId, input.commandId);
    }
    throw err;
  }
}

export interface InstructionInput extends ControlCommandInput {
  instruction: string;
}
export interface SteerInput extends InstructionInput {
  /**
   * `interrupt` is the only accepted policy, and is currently safe only before
   * the first plan is materialized.
   * `finish_as_evidence` is reserved by §8.3 but rejected fail-closed until the
   * separate ORC-TXN-A-EVIDENCE-01 boundary exists.
   */
  activeAttemptPolicy?: 'interrupt' | 'finish_as_evidence';
}
export interface InstructionResult {
  jobId: string;
  planVersion: number;
  instructionCount: number;
  changed: boolean;
  deduped: boolean;
}

/** The request is valid, but this safety policy is not implemented yet. */
export class UnsupportedActiveAttemptPolicyError extends Error {
  constructor(readonly policy: string) {
    super(`active attempt policy ${policy} is unavailable until ORC-TXN-A-EVIDENCE-01 is implemented`);
    this.name = 'UnsupportedActiveAttemptPolicyError';
  }
}

/**
 * Changing an already materialized plan requires plan-aware task/attempt/result
 * authority. Until that Tier-1 boundary exists, reject instead of allowing an
 * old-plan result to terminalize the new plan.
 */
export class SteerPlanAuthorityUnavailableError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} already has materialized work; steer requires plan-aware authority`);
    this.name = 'SteerPlanAuthorityUnavailableError';
  }
}

/**
 * `append_instruction` (§8.3): add context to a job without changing the plan or
 * interrupting the current attempt. Idempotent, owner-scoped. Later attempts see
 * the instruction via the worker prompt.
 */
export async function appendInstruction(client: MongoClient, db: Db, input: InstructionInput): Promise<InstructionResult> {
  return applyInstruction(client, db, input, 'append_instruction', {
    bumpPlan: false,
    requireUnmaterializedPlan: false,
  });
}

/**
 * `steer_job` (§8.3), contained subset: before planning, record the instruction
 * and bump planVersion so the first task runs under the new plan. Once a task is
 * materialized, steer is rejected until task/attempt/result authority is
 * plan-aware; otherwise an A-before-steer-before-B race can terminalize plan N+1
 * with a result from plan N.
 *
 * `finish_as_evidence` must never degrade to ordinary result authority: until its
 * separate A_evidence boundary is implemented, it is rejected before command
 * persistence or any job/attempt mutation.
 */
export async function steerJob(client: MongoClient, db: Db, input: SteerInput): Promise<InstructionResult> {
  const activeAttemptPolicy = input.activeAttemptPolicy ?? 'interrupt';
  if (activeAttemptPolicy !== 'interrupt') {
    throw new UnsupportedActiveAttemptPolicyError(activeAttemptPolicy);
  }
  return applyInstruction(client, db, input, 'steer_job', {
    bumpPlan: true,
    requireUnmaterializedPlan: true,
  });
}

async function applyInstruction(
  client: MongoClient, db: Db, input: InstructionInput, type: string,
  opts: { bumpPlan: boolean; requireUnmaterializedPlan: boolean },
): Promise<InstructionResult> {
  const key = `${input.resourceId}:${input.commandId}`;
  const payloadHash = canonicalHash({ type, jobId: input.jobId, instruction: input.instruction });
  const commands = db.collection<CommandDoc>(COLLECTIONS.commands);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  const existing = await commands.findOne({ _id: key });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new CommandConflictError(input.resourceId, input.commandId);
    const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId });
    return { jobId: input.jobId, planVersion: job?.planVersion ?? 1, instructionCount: job?.instructions.length ?? 0, changed: false, deduped: true };
  }

  try {
    const { value } = await runTxn(client, async (session) => {
      const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId }, { session });
      if (!job) throw new JobNotFoundError(input.jobId);

      // This read and the job CAS below share the transaction with planJob's
      // task insert + job CAS. Whichever commits first forces the other to retry:
      // steer either wins before planning, or observes materialized work and
      // fails without a durable command ACK.
      if (
        opts.requireUnmaterializedPlan
        && job.terminalOutcome === null
        && job.controlState !== 'STOP_REQUESTED'
      ) {
        const hasTask = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne(
          { jobId: job._id },
          { session, projection: { _id: 1 } },
        );
        if (
          hasTask
          || (job.phase !== 'ACCEPTED' && job.phase !== 'READY')
        ) {
          throw new SteerPlanAuthorityUnavailableError(job._id);
        }
      }

      await commands.insertOne({
        _id: key, resourceId: input.resourceId, conversationId: job.conversationId, commandId: input.commandId,
        type, payloadHash, jobId: input.jobId, state: 'APPLIED', createdAt: new Date(),
      }, { session });

      // Terminal or stopping jobs are not steerable — use fork_job to continue.
      if (job.terminalOutcome !== null || job.controlState === 'STOP_REQUESTED') {
        return { jobId: job._id, planVersion: job.planVersion, instructionCount: job.instructions.length, changed: false, deduped: false } as InstructionResult;
      }

      const now = new Date();
      const inc: Record<string, number> = { stateVersion: 1 };
      if (opts.bumpPlan) {
        inc.planVersion = 1;
        inc.activationDispatchGeneration = 1;
        await abandonActiveActivationInSession(db, job, session, 'plan_superseded', now);
      }
      const instructionCas = await jobs.updateOne(
        { _id: job._id, stateVersion: job.stateVersion, terminalOutcome: null },
        {
          $push: { instructions: input.instruction },
          $set: {
            ...(opts.bumpPlan
              ? {
                  activeActivationId: null,
                  activationRecoveryAttempt: 0,
                  activationRecoveryRootId: null,
                  activationRecoveryRootKind: null,
                }
              : {}),
            updatedAt: now,
          },
          $inc: inc,
        },
        { session },
      );
      if (instructionCas.modifiedCount !== 1) throw new Error(`${type} CAS lost`);

      const seq = await nextEventSeq(db, job._id, session);
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${seq}`, jobId: job._id, sequence: seq, type: type === 'steer_job' ? 'JobSteered' : 'JobInstructionAppended',
        payload: {
          commandId: input.commandId,
          instruction: input.instruction,
          ...(type === 'steer_job' ? { activeAttemptPolicy: 'interrupt', scope: 'pre_plan' } : {}),
        },
        createdAt: now,
      }, { session });
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(), aggregate: job._id, type: 'LaneWakeRequested', state: 'PENDING',
        payload: {
          jobId: job._id,
          reason: type,
          activationDispatchGeneration:
            job.activationDispatchGeneration + (opts.bumpPlan ? 1 : 0),
        },
        createdAt: now,
      }, { session });

      return { jobId: job._id, planVersion: job.planVersion + (opts.bumpPlan ? 1 : 0), instructionCount: job.instructions.length + 1, changed: true, deduped: false } as InstructionResult;
    });
    return value;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const winner = await commands.findOne({ _id: key });
      if (winner && winner.payloadHash === payloadHash) {
        const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId });
        return { jobId: input.jobId, planVersion: job?.planVersion ?? 1, instructionCount: job?.instructions.length ?? 0, changed: false, deduped: true };
      }
      throw new CommandConflictError(input.resourceId, input.commandId);
    }
    throw err;
  }
}

export interface ForkJobInput {
  resourceId: string;
  commandId: string;
  parentJobId: string;
  goal?: string;
}
export interface ForkJobResult {
  jobId: string;
  parentJobId: string;
  deduped: boolean;
}

/**
 * `fork_job` (§8.7): create a new, independent `DETACHED` job from a source job
 * (typically a terminal one — the way to continue after cancel). It snapshots the
 * source goal + instructions, does NOT share attempts/lease/mutable state, and
 * does NOT change the source job. Idempotent, owner-scoped.
 */
export async function forkJob(client: MongoClient, db: Db, input: ForkJobInput): Promise<ForkJobResult> {
  const key = `${input.resourceId}:${input.commandId}`;
  const payloadHash = canonicalHash({ type: 'fork_job', parentJobId: input.parentJobId, goal: input.goal ?? null });
  const commands = db.collection<CommandDoc>(COLLECTIONS.commands);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  const existing = await commands.findOne({ _id: key });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new CommandConflictError(input.resourceId, input.commandId);
    return { jobId: existing.jobId, parentJobId: input.parentJobId, deduped: true };
  }

  const newId = newJobId();
  try {
    await runTxn(client, async (session) => {
      const parent = await jobs.findOne({ _id: input.parentJobId, resourceId: input.resourceId }, { session });
      if (!parent) throw new JobNotFoundError(input.parentJobId);
      const now = new Date();
      await commands.insertOne({
        _id: key, resourceId: input.resourceId, conversationId: parent.conversationId, commandId: input.commandId,
        type: 'fork_job', payloadHash, jobId: newId, state: 'APPLIED', createdAt: now,
      }, { session });
      await jobs.insertOne({
        _id: newId, resourceId: input.resourceId, conversationId: parent.conversationId,
        phase: 'ACCEPTED', controlState: 'NONE', terminalOutcome: null,
        stateVersion: 0, planVersion: 1, pauseGeneration: 0,
        activationDispatchGeneration: 0, jobStopGeneration: 0,
        pendingTerminalOutcome: null, primaryJobStopCause: null,
        secondaryJobStopCauses: [], stopGraceDueAt: null,
        terminalBarrierMode: null, terminalBarrierBlocker: null,
        terminalBarrierNextCheckAt: null, terminalBarrierProbeAttempt: 0,
        controlVersion: 0,
        activationFence: 0, activeActivationId: null,
        activationRecoveryAttempt: 0,
        activationRecoveryRootId: null, activationRecoveryRootKind: null,
        controlBudgetPolicyVersion: CONTROL_BUDGET_POLICY_V1.version,
        jobControlRecoveryReserveMs:
          CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs,
        jobControlRecoveryReservedMs: 0,
        jobControlRecoveryConsumedMs: 0,
        stopControlRecoveryAttempt: 0,
        stopControlRecoveryState: 'IDLE',
        inboxHighWatermark: 0, appliedInboxWatermark: 0, resolvedInboxWatermark: 0,
        inboxSchemaVersion: 3,
        instructions: [...parent.instructions], // immutable snapshot of the source
        parentJobId: input.parentJobId, jobRelationMode: 'DETACHED',
        goal: input.goal ?? parent.goal, createdAt: now, updatedAt: now,
      }, { session });
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${newId}:0`, jobId: newId, sequence: 0, type: 'JobAccepted',
        payload: { forkedFrom: input.parentJobId, commandId: input.commandId }, createdAt: now,
      }, { session });
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(), aggregate: newId, type: 'LaneWakeRequested', state: 'PENDING',
        payload: { jobId: newId, reason: 'fork', activationDispatchGeneration: 0 }, createdAt: now,
      }, { session });
    });
    return { jobId: newId, parentJobId: input.parentJobId, deduped: false };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const winner = await commands.findOne({ _id: key });
      if (winner && winner.payloadHash === payloadHash) return { jobId: winner.jobId, parentJobId: input.parentJobId, deduped: true };
      throw new CommandConflictError(input.resourceId, input.commandId);
    }
    throw err;
  }
}
