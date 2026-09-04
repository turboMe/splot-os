/**
 * Skeleton lane reductions: plan a job and reduce it from its task outcomes
 * (plan §7.1, §7.2 — the job side of the B boundary).
 *
 * Planner-created one-root SERIAL tasks now delegate pending durable results to
 * the typed RESULT_DRAIN reducer. The legacy terminal-task aggregation remains
 * for compatibility paths (invalid results, stop reducers and child fan-in).
 * The full multi-item B classifier remains deferred. Typed RESULT_DRAIN jobs
 * are nevertheless fenced from this compatibility terminalizer in-transaction:
 * their B boundary is the sole authority while the job is
 * AWAITING_RESULTS/RECONCILING.
 */
import type { Db, MongoClient } from 'mongodb';
import type { JobTerminalOutcome } from '../contracts/index.js';
import { newOutboxId } from '../contracts/index.js';
import { runTxn } from './txn.js';
import { COLLECTIONS, type JobDoc, type TaskDoc, type JobEventDoc, type OutboxDoc, type DispatchEdgeDoc } from './collections.js';
import { runPlanningActivation } from './activations.js';
import type { LaneDecider } from '../contracts/lane-decision.js';
import type { ProgressiveAttemptPolicy } from '../contracts/execution-budget.js';
import { runResultDrainActivation } from './result-drain.js';

async function nextEventSeq(db: Db, jobId: string, session: import('mongodb').ClientSession): Promise<number> {
  const last = await db.collection<JobEventDoc>(COLLECTIONS.events).find({ jobId }, { session }).sort({ sequence: -1 }).limit(1).next();
  return (last?.sequence ?? -1) + 1;
}

/**
 * Plan a READY/ACCEPTED job through the first typed BUSINESS activation slice.
 * The activation freezes one bounded SERIAL-task proposal and atomically commits
 * task + job + event + successor wake + activation settlement.
 */
export async function planJob(
  client: MongoClient,
  db: Db,
  jobId: string,
  authority?: { requiredActivationId: string | null },
  opts?: {
    decide?: LaneDecider;
    attemptCapFor?: (capability: string | null) => number | undefined;
    progressiveAttemptFor?: (
      capability: string | null,
    ) => ProgressiveAttemptPolicy | undefined;
  },
): Promise<{ taskId: string } | null> {
  const planned = await runPlanningActivation(client, db, jobId, {
    requiredActivationId: authority?.requiredActivationId,
    decide: opts?.decide,
    attemptCapFor: opts?.attemptCapFor,
    progressiveAttemptFor: opts?.progressiveAttemptFor,
  });
  if (planned) return { taskId: planned.taskId };
  // Direct callers do not carry a claimed-wake identity. If a pre-plan steer
  // won after the first activation was materialized, it atomically abandoned
  // that slot and minted a fresh plan/generation. Retry once from the durable
  // aggregate so the caller observes the winning authority. A wake-scoped call
  // must never launder its old handle into this retry.
  if (authority) return null;
  const [current, task] = await Promise.all([
    db.collection<JobDoc>(COLLECTIONS.jobs).findOne({
      _id: jobId,
      terminalOutcome: null,
      controlState: 'NONE',
      phase: { $in: ['ACCEPTED', 'READY'] },
      activeActivationId: null,
    }),
    db.collection<TaskDoc>(COLLECTIONS.tasks).findOne(
      { jobId },
      { projection: { _id: 1 } },
    ),
  ]);
  if (!current || task) return null;
  const retried = await runPlanningActivation(client, db, jobId, {
    decide: opts?.decide,
    attemptCapFor: opts?.attemptCapFor,
    progressiveAttemptFor: opts?.progressiveAttemptFor,
  });
  return retried ? { taskId: retried.taskId } : null;
}

/**
 * Reduce a nonterminal job from its tasks' outcomes. Skeleton terminal barrier:
 * only when every task is terminal does the job terminalize —
 * COMPLETED (all SUCCEEDED), PARTIAL (any PARTIAL), FAILED (any FAILED).
 * Returns the terminal outcome, or null if work is still in progress.
 */
export async function advanceJobFromTasks(
  client: MongoClient,
  db: Db,
  jobId: string,
  expectedActivationDispatchGeneration?: number,
): Promise<JobTerminalOutcome | null> {
  const typedResultTask = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({
    jobId,
    resultApplyMode: 'RESULT_DRAIN_V1',
  });
  const typedResultJob = typedResultTask
      ? await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({
        _id: jobId,
        terminalOutcome: null,
        controlState: { $ne: 'STOP_REQUESTED' },
        phase: { $in: ['AWAITING_RESULTS', 'RECONCILING'] },
      })
    : null;
  const typedDrainPending = Boolean(
    typedResultTask
    && typedResultJob
    && (
      (
        typedResultTask.phase === 'AWAITING_RESULT'
        && typeof typedResultTask.pendingResultId === 'string'
      )
      || typedResultJob.phase === 'RECONCILING'
      || typedResultJob.resolvedInboxWatermark < typedResultJob.inboxHighWatermark
    ),
  );
  if (typedDrainPending) {
    if (
      expectedActivationDispatchGeneration !== undefined
      && !await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({
        _id: jobId,
        activationDispatchGeneration: expectedActivationDispatchGeneration,
        terminalOutcome: null,
      }, { projection: { _id: 1 } })
    ) {
      return null;
    }
    const drained = await runResultDrainActivation(client, db, jobId);
    return drained?.outcome ?? null;
  }

  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const { value } = await runTxn(client, async (session) => {
    const job = await jobs.findOne({
      _id: jobId,
      ...(expectedActivationDispatchGeneration === undefined
        ? {}
        : { activationDispatchGeneration: expectedActivationDispatchGeneration }),
    }, { session });
    if (
      !job
      || job.terminalOutcome !== null
      || job.controlState === 'STOP_REQUESTED'
      // A job blocked on a human answer is NOT finished, however terminal its
      // tasks look. Without this, a lane question asked after the work came back
      // would be closed by this reducer on the very next tick — the tasks are
      // all SUCCEEDED, so nothing else here would object.
      || job.phase === 'AWAITING_USER'
    ) return null;

    const tasks = await db.collection<TaskDoc>(COLLECTIONS.tasks).find({ jobId }, { session }).toArray();
    if (tasks.length === 0) return null;

    // The read-before-txn fast path above is only an optimization. A may append
    // ingress after it, so the terminal authority must be re-established from
    // the transaction snapshot. RESULT_DRAIN owns every
    // AWAITING_RESULTS/RECONCILING terminal transition, including a redrive
    // obligation behind the already-advanced resolved watermark.
    if (
      tasks.some((task) => task.resultApplyMode === 'RESULT_DRAIN_V1')
      && (
        job.phase === 'AWAITING_RESULTS'
        || job.phase === 'RECONCILING'
        || job.resolvedInboxWatermark < job.inboxHighWatermark
      )
    ) {
      return null;
    }

    const TERMINAL_TASK = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'TIMED_OUT', 'CANCELLED', 'SUPERSEDED', 'UNKNOWN_OUTCOME']);
    // The barrier requires ALL tasks (incl. children) to have settled...
    if (!tasks.every((t) => TERMINAL_TASK.has(t.phase))) return null; // still in progress

    // ...but the JOB outcome comes from ROOT tasks only — children roll up into
    // their parent via fan-in (resolveParentTask), so a failed optional child
    // must not fail the job.
    const childIds = new Set((await db.collection<DispatchEdgeDoc>(COLLECTIONS.edges).find({ jobId }, { session }).toArray()).map((e) => e.childTaskId));
    // ...and a task a replan RETRIED is excluded for the same reason a child is:
    // it is not an independent piece of the job's result. Reporting FAILED for
    // work the retry then delivered tells the user their finished deliverable
    // failed. Kept identical to `commitFinalTerminal`, so the two paths that can
    // close a job cannot disagree about what its outcome means.
    const supersededIds = new Set(
      tasks.map((t) => t.supersedesTaskId).filter((id): id is string => typeof id === 'string'),
    );
    const roots = tasks.filter((t) => !childIds.has(t._id) && !supersededIds.has(t._id));

    const outcome: JobTerminalOutcome =
      roots.some((t) => t.phase === 'FAILED') ? 'FAILED'
      : roots.some((t) => t.phase === 'TIMED_OUT') ? 'TIMED_OUT'
      : roots.some((t) => t.phase === 'CANCELLED') ? 'CANCELLED'
      : roots.some((t) => t.phase === 'BLOCKED') ? 'BLOCKED'
      : roots.some((t) => t.phase === 'UNKNOWN_OUTCOME') ? 'UNKNOWN_OUTCOME'
      : roots.some((t) => t.phase === 'PARTIAL') ? 'PARTIAL'
      : roots.every((t) => t.phase === 'SUCCEEDED') ? 'COMPLETED'
      : 'UNKNOWN_OUTCOME';

    const now = new Date();
    const cas = await jobs.updateOne(
      {
        _id: jobId,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: { $ne: 'STOP_REQUESTED' },
        activeActivationId: null,
        ...(expectedActivationDispatchGeneration === undefined
          ? {}
          : { activationDispatchGeneration: expectedActivationDispatchGeneration }),
      },
      {
        $set: { phase: 'TERMINAL', terminalOutcome: outcome, updatedAt: now },
        $inc: {
          stateVersion: 1,
          activationDispatchGeneration: 1,
          jobStopGeneration: 1,
        },
      },
      { session },
    );
    if (cas.modifiedCount !== 1) throw new Error('advanceJob CAS lost');

    const seq = await nextEventSeq(db, jobId, session);
    await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({ _id: `${jobId}:${seq}`, jobId, sequence: seq, type: 'JobTerminalized', payload: { terminalOutcome: outcome }, createdAt: now }, { session });
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({ _id: newOutboxId(), aggregate: jobId, type: 'JobTerminal', state: 'PENDING', payload: { jobId, terminalOutcome: outcome }, createdAt: now }, { session });
    return outcome;
  });
  return value;
}
