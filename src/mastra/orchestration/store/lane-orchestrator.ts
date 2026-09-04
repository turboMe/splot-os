/**
 * Autonomous lane orchestrator (plan §4.2, §9.2) — skeleton.
 *
 * A wake pops a job forward through idempotent, single-move `laneStep`s:
 *   ACCEPTED/READY (no task)      → plan (create task, job DISPATCHING)
 *   task READY/RETRY, no attempt  → dispatch a QUEUED attempt
 *   typed result inbox ready      → fenced RESULT_DRAIN applies task + job
 *   legacy all-tasks terminal     → reduce job to its terminal outcome
 *   otherwise                     → wait (a worker result will wake it again)
 *
 * Each move is its own transaction and is safe to re-run (idempotent guards), so
 * a lost wake or a crash mid-sequence is recovered by the next wake / a
 * reconciler. `drainLane` consumes PENDING wakes; no polling of job state.
 */
import type { Db, MongoClient } from 'mongodb';
import type { JobTerminalOutcome, AttemptLifecycle } from '../contracts/index.js';
import type { LaneDecider } from '../contracts/lane-decision.js';
import type { ProgressiveAttemptPolicy } from '../contracts/execution-budget.js';
import { runTxn } from './txn.js';
import { COLLECTIONS, type JobDoc, type TaskDoc, type AttemptDoc, type OutboxDoc } from './collections.js';
import { planJob, advanceJobFromTasks } from './job-advance.js';
import { runFinalDecisionActivation } from './final-decision.js';
import { AttemptDispatchAuthorityLostError, dispatchAttempt } from './attempts.js';
import { materializePlannedSteps, promoteSequencedSteps, resolveParentTask } from './child-tasks.js';
import { materializePlanningActivationInSession } from './activations.js';
import {
  materializeResultDrainActivationInSession,
  runResultDrainActivation,
} from './result-drain.js';

const TERMINAL_TASK_PHASES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'TIMED_OUT', 'CANCELLED', 'SUPERSEDED', 'UNKNOWN_OUTCOME']);
const LIVE_ATTEMPT: AttemptLifecycle[] = ['QUEUED', 'LEASED', 'RUNNING', 'STOP_REQUESTED'];

export type LaneAction = 'planned' | 'dispatched' | 'drained' | 'terminalized' | 'resolved_parent' | 'wait' | 'none';
export interface LaneStepResult { action: LaneAction; jobId: string; outcome?: JobTerminalOutcome; attemptId?: string; }
export interface LaneWakeHandle {
  wakeId: string;
  jobId: string;
  activationDispatchGeneration: number;
  /** Exact planning activation materialized with the wake, if applicable. */
  planningActivationId: string | null;
  /** Exact bounded RESULT_DRAIN activation materialized with the wake. */
  resultDrainActivationId: string | null;
}
export interface LaneStepAuthority {
  activationDispatchGeneration: number;
  planningActivationId: string | null;
  resultDrainActivationId?: string | null;
}

/**
 * F5B: how a lane activation decides what to do next. Threaded rather than kept
 * in module state so the store stays injectable and two mounts cannot fight over
 * one global decider. Omitted → the deterministic single-SERIAL-task behaviour.
 */
export interface LaneRunOptions {
  decide?: LaneDecider;
  /**
   * Attempt window for a chosen capability. Injected like `decide` so the
   * substrate stays free of the agent roster; code-owned, never model-supplied.
   */
  attemptCapFor?: (capability: string | null) => number | undefined;
  /** Code-owned earned-time policy frozen with the task plan. */
  progressiveAttemptFor?: (
    capability: string | null,
  ) => ProgressiveAttemptPolicy | undefined;
  /**
   * Whether a capability's declared deliverable requires a stored artifact.
   * Injected for the same reason as `attemptCapFor`: the substrate must not
   * learn to interpret capability names.
   */
  expectsArtifact?: (capability: string | null) => boolean;
}

/** Make at most one safe progress move for a job. */
export async function laneStep(
  client: MongoClient,
  db: Db,
  jobId: string,
  authority?: LaneStepAuthority,
  opts?: LaneRunOptions,
): Promise<LaneStepResult> {
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({
    _id: jobId,
    ...(authority
      ? { activationDispatchGeneration: authority.activationDispatchGeneration }
      : {}),
  });
  if (!job || job.terminalOutcome !== null) return { action: 'none', jobId };

  const tasks = await db.collection<TaskDoc>(COLLECTIONS.tasks).find({ jobId }).toArray();

  // PROCESS_STOP_V1 owns all progress while stop is pending. In particular,
  // neither RESULT_DRAIN nor the compatibility terminalizer may turn a stop
  // request into a business result or a premature terminal outcome.
  if (job.controlState === 'STOP_REQUESTED') {
    return { action: 'wait', jobId };
  }

  // F5B/FINAL_DECISION: work has finished but the drain deferred the terminal
  // call, so the lane judges the result before the job closes. Runs BEFORE the
  // drain branch because the drain has nothing left to apply at this point and
  // would simply return "wait", parking the job forever.
  if (opts?.decide && job.phase !== 'AWAITING_USER') {
    const judged = await runFinalDecisionActivation(client, db, jobId, {
      decide: opts.decide,
      expectsArtifact: opts.expectsArtifact,
    });
    if (judged.action === 'terminalized') {
      return { action: 'terminalized', jobId, outcome: judged.outcome as LaneStepResult['outcome'] };
    }
    if (judged.action === 'replanned') return { action: 'planned', jobId };
    // The judge sent the job to the user. It is now AWAITING_USER with an open
    // question, so this activation is over — falling through would let the
    // terminal-advance branch below close a job somebody is waiting to answer.
    if (judged.action === 'asked') return { action: 'wait', jobId };
  }

  // Opt-in PR-32 A→inbox→B slice. RESULT_DRAIN is the only reducer allowed to
  // apply an AWAITING_RESULT task, including a captured finish-current result
  // while PAUSE_REQUESTED. It performs no model/tool/dispatch work.
  const typedResultDrainJob =
    (job.phase === 'AWAITING_RESULTS' || job.phase === 'RECONCILING')
    && tasks.some((task) => task.resultApplyMode === 'RESULT_DRAIN_V1');
  if (typedResultDrainJob) {
    const drained = await runResultDrainActivation(client, db, jobId, {
      requiredActivationId: authority
        ? authority.resultDrainActivationId ?? null
        : undefined,
      // With a judge configured the drain applies the result but leaves the
      // terminal call to FINAL_DECISION above — terminal is monotonic, so this
      // is the last moment that choice still exists.
      deferTerminalDecision: opts?.decide !== undefined,
    });
    if (drained) {
      if (drained.outcome === null) {
        return { action: 'drained', jobId };
      }
      return {
        action: 'terminalized',
        jobId,
        outcome: drained.outcome,
      };
    }
    // A typed tail that is quarantined, retry-delayed, pause-deferred or simply
    // has no eligible row must not fall through into the legacy terminalizer.
    // PENDING_REDRIVE can be eligible behind the resolved watermark, so phase
    // authority — not only `resolved < high` — selects the typed reducer.
    return { action: 'wait', jobId };
  }

  // Terminal advance is always allowed — an in-flight attempt that finished may
  // complete the job even while paused (§8.4: pause stops NEW dispatch only).
  if (tasks.length > 0 && tasks.every((t) => TERMINAL_TASK_PHASES.has(t.phase))) {
    const outcome = await advanceJobFromTasks(
      client,
      db,
      jobId,
      authority?.activationDispatchGeneration,
    );
    if (outcome) return { action: 'terminalized', jobId, outcome };
  }

  // No new work while paused.
  if (job.controlState !== 'NONE') return { action: 'wait', jobId };

  if ((job.phase === 'ACCEPTED' || job.phase === 'READY') && tasks.length === 0) {
    const planned = await planJob(
      client,
      db,
      jobId,
      authority
        ? { requiredActivationId: authority.planningActivationId }
        : undefined,
      opts,
    );
    return { action: planned ? 'planned' : 'wait', jobId };
  }

  // F6B: a frozen plan becomes real tasks. Before step promotion, because a plan
  // that has just been committed has no steps yet and nothing to promote.
  const materialized = await materializePlannedSteps(client, db, jobId);
  if (materialized) return { action: 'planned', jobId };

  // F6B: release the next step of an ordered plan, or block it because its
  // predecessor did not deliver. Runs BEFORE fan-in and before ready-task
  // selection: a step released now is dispatchable in this same tick, and a step
  // blocked now lets fan-in settle the parent instead of waiting for a task that
  // will never run.
  const sequenced = await promoteSequencedSteps(client, db, jobId);
  if (sequenced.released.length > 0 || sequenced.blocked.length > 0) {
    return { action: 'planned', jobId };
  }

  // Fan-in: resolve a parent whose REQUIRED children have all settled.
  for (const t of tasks) {
    if (t.phase === 'WAITING_DEPENDENCY') {
      const resolved = await resolveParentTask(
        client,
        db,
        jobId,
        t._id,
        authority?.activationDispatchGeneration,
      );
      if (resolved) return { action: 'resolved_parent', jobId };
    }
  }

  const now = Date.now();
  const readyTask = tasks.find((t) =>
    t.phase === 'READY'
    || (t.phase === 'RETRY_PENDING' && (!t.retryNotBefore || t.retryNotBefore.getTime() <= now)));
  if (readyTask) {
    const live = await db.collection<AttemptDoc>(COLLECTIONS.attempts).findOne({ taskId: readyTask._id, lifecycle: { $in: LIVE_ATTEMPT } });
    if (!live) {
      try {
        const { attemptId } = await dispatchAttempt(client, db, {
          jobId,
          taskId: readyTask._id,
          expectedActivationDispatchGeneration: authority?.activationDispatchGeneration,
          // The window frozen with the plan, not a fresh lookup: a retry after a
          // restart must run under the same budget the first attempt had.
          ...(typeof readyTask.attemptCapMs === 'number'
            ? { attemptCapMs: readyTask.attemptCapMs }
            : {}),
        });
        return { action: 'dispatched', jobId, attemptId };
      } catch (err) {
        // Another lane iteration won the SERIAL dispatch CAS after our read.
        // That is expected contention, not a failed lane/reconciler tick.
        if (err instanceof AttemptDispatchAuthorityLostError) {
          return { action: 'wait', jobId };
        }
        throw err;
      }
    }
  }

  return { action: 'wait', jobId };
}

/** Step a job until it stops making progress (wait/terminal/none). */
export async function runLaneForJob(
  client: MongoClient,
  db: Db,
  jobId: string,
  maxSteps = 50,
  authority?: LaneStepAuthority,
  opts?: LaneRunOptions,
): Promise<LaneStepResult> {
  let last: LaneStepResult = { action: 'wait', jobId };
  for (let i = 0; i < maxSteps; i++) {
    last = await laneStep(client, db, jobId, authority, opts);
    // A planning activation commits exactly one bounded proposal and emits its
    // own successor wake. Let that durable handoff drive dispatch instead of
    // doing more BUSINESS work under the same consumed wake.
    if (
      last.action === 'planned'
      || last.action === 'drained'
      || last.action === 'wait'
      || last.action === 'none'
      || last.action === 'terminalized'
    ) break;
  }
  return last;
}

/** Claim the oldest current-generation wake and return its immutable authority. */
export async function claimNextWake(client: MongoClient, db: Db): Promise<LaneWakeHandle | null> {
  for (;;) {
    const { value } = await runTxn<
      | { status: 'empty' }
      | { status: 'skipped' }
      | { status: 'claimed'; handle: LaneWakeHandle }
    >(client, async (session) => {
      const wake = await db.collection<OutboxDoc>(COLLECTIONS.outbox).findOneAndUpdate(
        { type: 'LaneWakeRequested', state: 'PENDING' },
        { $set: { state: 'PUBLISHED' } },
        { session, sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      if (!wake) return { status: 'empty' };

      const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
        .findOne({ _id: wake.aggregate }, { session });
      if (!job) return { status: 'skipped' };

      // A wake is authority for exactly the generation that emitted it.
      // Publishing stale/malformed wakes settles their at-least-once transport
      // record but must never launder them into a current activation.
      const rawPayload = wake.payload as unknown;
      const wakeGeneration =
        rawPayload !== null && typeof rawPayload === 'object'
          ? (rawPayload as Record<string, unknown>).activationDispatchGeneration
          : undefined;
      if (
        typeof wakeGeneration !== 'number'
        || !Number.isInteger(wakeGeneration)
        || wakeGeneration !== job.activationDispatchGeneration
      ) {
        return { status: 'skipped' };
      }

      // The first typed activation consumer is planning. Publishing its wake,
      // inserting PENDING activation and acquiring the job slot share this txn;
      // a crash can therefore leave either a durable activation or a still-
      // pending wake, never a consumed wake with no recovery owner.
      const planningActivation = await materializePlanningActivationInSession(db, job, session, {
        sourceWakeId: wake._id,
      });
      const resultDrainActivation = planningActivation
        ? null
        : await materializeResultDrainActivationInSession(db, job, session, {
            sourceWakeId: wake._id,
          });
      return {
        status: 'claimed',
        handle: {
          wakeId: wake._id,
          jobId: wake.aggregate,
          activationDispatchGeneration: wakeGeneration,
          planningActivationId: planningActivation?._id ?? null,
          resultDrainActivationId: resultDrainActivation?._id ?? null,
        } satisfies LaneWakeHandle,
      };
    });
    if (value.status === 'claimed') return value.handle;
    if (value.status === 'empty') return null;
  }
}

/** Consume all pending lane wakes, running the lane for each woken job. */
export async function drainLane(client: MongoClient, db: Db, opts?: LaneRunOptions): Promise<number> {
  let processed = 0;
  for (;;) {
    const handle = await claimNextWake(client, db);
    if (!handle) break;
    await runLaneForJob(client, db, handle.jobId, 50, {
      activationDispatchGeneration: handle.activationDispatchGeneration,
      planningActivationId: handle.planningActivationId,
      resultDrainActivationId: handle.resultDrainActivationId,
    }, opts);
    processed++;
  }
  return processed;
}
