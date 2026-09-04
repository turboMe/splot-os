/**
 * Same-job child tasks — dispatch-edge fan-out / fan-in (plan §5.1, §15.5,
 * ORC-DISPATCH-EDGE-01). Skeleton subset: a parent task spawns child tasks with
 * REQUIRED edges; the parent does not succeed until every REQUIRED child settles.
 *
 * This is the Tier-2 contract that unblocks agents with delegation (e.g.
 * Coding → reviewers, Hunt → producer helpers). No speculation/attached-nested
 * yet — those are separate contracts.
 */
import type { Db, MongoClient } from 'mongodb';
import { newTaskId, newOutboxId } from '../contracts/index.js';
import type { ProgressiveAttemptPolicy } from '../contracts/execution-budget.js';
import { runTxn } from './txn.js';
import {
  COLLECTIONS,
  type TaskDoc,
  type DispatchEdgeDoc,
  type JobDoc,
  type OutboxDoc,
  type EdgeCompletion,
} from './collections.js';

const TERMINAL_TASK = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'TIMED_OUT', 'CANCELLED', 'SUPERSEDED', 'UNKNOWN_OUTCOME']);
const FAILED_TASK = new Set(['FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'UNKNOWN_OUTCOME']);

export interface ChildSpec {
  goal: string;
  completionMode?: EdgeCompletion;
  /**
   * Which specialist runs this step, and under what budget.
   *
   * Until F6B a child carried `goal` alone, so every step of a plan would have
   * routed to the DEFAULT agent — the same defect already fixed once for
   * replans, where a job silently changed specialist halfway through. Code-owned
   * exactly like `PlanningProposalV1.capability`: a model may name a capability,
   * the composition root decides what window it gets.
   */
  capability?: string | null;
  attemptCapMs?: number | null;
  progressiveAttempt?: ProgressiveAttemptPolicy | null;
  /**
   * Index of the sibling in THIS spawn call that must succeed first.
   *
   * An index rather than a taskId because ids are generated inside this
   * transaction — a caller cannot name one it has not seen. Must point BACKWARDS,
   * which makes a cycle unrepresentable rather than merely discouraged.
   */
  after?: number;
}

/**
 * A predecessor must have SUCCEEDED for the next step to run — `PARTIAL` does
 * not release it.
 *
 * A sequence step consumes its predecessor's output. Continuing on a partial one
 * produces a plausible-looking answer built on incomplete input, which is the
 * failure this system avoids everywhere else; a visibly blocked step is the
 * cheaper mistake. Named so it can be revisited by measurement rather than by
 * rewriting the condition.
 */
const RELEASES_NEXT_STEP = new Set(['SUCCEEDED']);

/**
 * Spawn child tasks under a parent and park the parent on its children.
 * One transaction creates the child tasks + ACTIVE edges and sets the parent to
 * WAITING_DEPENDENCY, then wakes the lane to dispatch the children.
 */
export async function spawnChildTasks(
  client: MongoClient, db: Db,
  input: { jobId: string; parentTaskId: string; children: ChildSpec[] },
): Promise<{ childTaskIds: string[] }> {
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const edges = db.collection<DispatchEdgeDoc>(COLLECTIONS.edges);
  const { value } = await runTxn(client, async (session) => {
    const parent = await tasks.findOne({ _id: input.parentTaskId, jobId: input.jobId }, { session });
    if (!parent) throw new Error(`parent task ${input.parentTaskId} not found`);
    // A forward or self reference would either dangle or deadlock the plan. Both
    // are rejected here rather than discovered as a job that never moves.
    for (const [index, spec] of input.children.entries()) {
      if (spec.after === undefined) continue;
      if (!Number.isInteger(spec.after) || spec.after < 0 || spec.after >= index) {
        throw new Error(`child ${index} must wait on an EARLIER sibling, got after=${spec.after}`);
      }
    }
    const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
      .findOne({
        _id: input.jobId,
        terminalOutcome: null,
        controlState: 'NONE',
      }, { session });
    if (!job) throw new Error(`job ${input.jobId} is not dispatchable`);

    const now = new Date();
    const jobTouch = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
      {
        _id: job._id,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: 'NONE',
      },
      { $set: { updatedAt: now }, $inc: { stateVersion: 1 } },
      { session },
    );
    if (jobTouch.modifiedCount !== 1) {
      throw new Error(`job ${input.jobId} lost child-dispatch authority`);
    }
    // Ids are allocated for the whole batch first, so a step can name a
    // predecessor that does not exist yet at insert time.
    const childTaskIds = input.children.map(() => newTaskId());
    for (const [index, spec] of input.children.entries()) {
      const childId = childTaskIds[index]!;
      const awaitsTaskId = spec.after === undefined ? null : childTaskIds[spec.after] ?? null;
      await tasks.insertOne({
        _id: childId, jobId: input.jobId,
        // A step with a predecessor must NOT be dispatchable yet: the lane picks
        // any READY task, so coming up READY would run the whole plan at once
        // and in arbitrary order.
        phase: awaitsTaskId ? 'WAITING_DEPENDENCY' : 'READY',
        controlState: 'NONE', attemptMode: 'SERIAL',
        planVersion: parent.planVersion, stopGeneration: 0, retryNotBefore: null, goal: spec.goal,
        capability: spec.capability ?? null,
        attemptCapMs: spec.attemptCapMs ?? null,
        progressiveAttempt: spec.progressiveAttempt ?? null,
        awaitsTaskId,
        // "This is a step of a plan", written where it is known for certain.
        // The worker renders a plan step differently from a single task, and
        // until this existed it could only tell them apart by whether the lane
        // happened to supply a task goal — which is not the same question.
        parentTaskId: input.parentTaskId,
        activeAttemptId: null, createdAt: now, updatedAt: now,
      }, { session });
      await edges.insertOne({
        _id: `edge_${globalThis.crypto.randomUUID()}`, jobId: input.jobId, parentTaskId: input.parentTaskId,
        childTaskId: childId, completionMode: spec.completionMode ?? 'REQUIRED', lifecycle: 'ACTIVE', createdAt: now,
      }, { session });
    }
    await tasks.updateOne({ _id: input.parentTaskId }, { $set: { phase: 'WAITING_DEPENDENCY', updatedAt: now } }, { session });
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
      _id: newOutboxId(), aggregate: input.jobId, type: 'LaneWakeRequested', state: 'PENDING',
      payload: {
        jobId: input.jobId,
        reason: 'child_fanout',
        activationDispatchGeneration: job.activationDispatchGeneration,
      },
      createdAt: now,
    }, { session });
    return { childTaskIds };
  });
  return value;
}

/**
 * Turn a frozen plan into real tasks (F6B).
 *
 * The second half of a `plan_steps` decision. Planning commits a PARENT carrying
 * `plannedSteps` and parks it on `WAITING_DEPENDENCY`; this materializes those
 * steps through the ordinary fan-out, chaining each to its predecessor so they
 * run in the order the plan was written.
 *
 * Idempotent by construction: it only acts on a parent that has a plan and NO
 * edges yet, so a crash between committing the plan and creating its steps costs
 * one wake, and a second lane tick finds the edges already present and does
 * nothing. That is why the list lives on the parent rather than in the
 * activation — the recovery information survives the activation that produced it.
 */
export async function materializePlannedSteps(
  client: MongoClient,
  db: Db,
  jobId: string,
): Promise<{ parentTaskId: string; childTaskIds: string[] } | null> {
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const parent = await tasks.findOne({
    jobId,
    phase: 'WAITING_DEPENDENCY',
    plannedSteps: { $exists: true, $ne: null },
  });
  if (!parent?.plannedSteps || parent.plannedSteps.length === 0) return null;
  const existing = await db.collection<DispatchEdgeDoc>(COLLECTIONS.edges)
    .findOne({ jobId, parentTaskId: parent._id });
  if (existing) return null;

  const { childTaskIds } = await spawnChildTasks(client, db, {
    jobId,
    parentTaskId: parent._id,
    children: parent.plannedSteps.map((step, index) => ({
      goal: step.goal,
      capability: step.capability ?? null,
      attemptCapMs: step.attemptCapMs ?? null,
      progressiveAttempt: step.progressiveAttempt ?? null,
      // Each step waits for the one before it; the first waits for nothing.
      ...(index > 0 ? { after: index - 1 } : {}),
    })),
  });
  return { parentTaskId: parent._id, childTaskIds };
}

/**
 * Release the next step of a sequence, or block it because its predecessor did
 * not deliver (F6B).
 *
 * This is the only thing that makes an ordered plan move, and it is deliberately
 * its own transaction rather than a side effect of finishing a task: the
 * predecessor may settle through several different paths (ordinary result,
 * replan, stop, quarantine), and hanging promotion off one of them would leave
 * the sequence stuck whenever it settled through another.
 *
 * Idempotent and CAS-guarded, so two lane ticks (or two processes) racing on the
 * same step promote it once. Returns how many steps changed, so the caller can
 * tell "the plan moved" from "nothing to do".
 */
export async function promoteSequencedSteps(
  client: MongoClient,
  db: Db,
  jobId: string,
): Promise<{ released: string[]; blocked: string[] }> {
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const waiting = await tasks
    .find({ jobId, phase: 'WAITING_DEPENDENCY', awaitsTaskId: { $ne: null } })
    .toArray();
  if (waiting.length === 0) return { released: [], blocked: [] };

  const released: string[] = [];
  const blocked: string[] = [];
  for (const step of waiting) {
    const predecessor = await tasks.findOne({ _id: step.awaitsTaskId! });
    if (!predecessor) continue;
    const succeeded = RELEASES_NEXT_STEP.has(predecessor.phase);
    const settled = TERMINAL_TASK.has(predecessor.phase);
    if (!succeeded && !settled) continue; // still working — nothing to decide yet

    const { value } = await runTxn(client, async (session) => {
      const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
        { _id: jobId, terminalOutcome: null, controlState: 'NONE' },
        { session },
      );
      if (!job) return null;
      const moved = await tasks.updateOne(
        // Phase is part of the filter: a step some other tick already released
        // must not be released twice, nor released after being blocked.
        { _id: step._id, phase: 'WAITING_DEPENDENCY', awaitsTaskId: step.awaitsTaskId },
        {
          $set: {
            phase: succeeded ? 'READY' : 'BLOCKED',
            updatedAt: new Date(),
            // Why a step never ran is the first thing anyone asks when a plan
            // stops halfway; without this the row says only BLOCKED.
            ...(succeeded ? {} : { blockedReason: `predecessor ${step.awaitsTaskId} ended ${predecessor.phase}` }),
          },
        },
        { session },
      );
      if (moved.modifiedCount !== 1) return null;
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(), aggregate: jobId, type: 'LaneWakeRequested', state: 'PENDING',
        payload: {
          jobId,
          reason: succeeded ? 'step_released' : 'step_blocked',
          activationDispatchGeneration: job.activationDispatchGeneration,
        },
        createdAt: new Date(),
      }, { session });
      return succeeded;
    });
    if (value === true) released.push(step._id);
    else if (value === false) blocked.push(step._id);
  }
  return { released, blocked };
}

/**
 * Fan-in: if every REQUIRED child of a WAITING_DEPENDENCY parent has settled,
 * resolve the parent (SUCCEEDED, or FAILED if a required child failed) and settle
 * its edges. Returns true if it resolved the parent.
 */
export async function resolveParentTask(
  client: MongoClient,
  db: Db,
  jobId: string,
  parentTaskId: string,
  expectedActivationDispatchGeneration?: number,
): Promise<boolean> {
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const edges = db.collection<DispatchEdgeDoc>(COLLECTIONS.edges);
  const { value } = await runTxn(client, async (session) => {
    const parent = await tasks.findOne({ _id: parentTaskId, jobId }, { session });
    if (!parent || parent.phase !== 'WAITING_DEPENDENCY') return false;
    const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
      .findOne({
        _id: jobId,
        terminalOutcome: null,
        controlState: 'NONE',
        ...(expectedActivationDispatchGeneration === undefined
          ? {}
          : { activationDispatchGeneration: expectedActivationDispatchGeneration }),
      }, { session });
    if (!job) return false;

    const parentEdges = await edges.find({ parentTaskId, lifecycle: 'ACTIVE' }, { session }).toArray();
    if (parentEdges.length === 0) return false;

    const childIds = parentEdges.map((e) => e.childTaskId);
    const children = await tasks.find({ _id: { $in: childIds } }, { session }).toArray();
    const childById = new Map(children.map((c) => [c._id, c]));

    const required = parentEdges.filter((e) => e.completionMode === 'REQUIRED');
    const allRequiredTerminal = required.every((e) => TERMINAL_TASK.has(childById.get(e.childTaskId)?.phase ?? ''));
    if (!allRequiredTerminal) return false;

    const anyRequiredFailed = required.some((e) => FAILED_TASK.has(childById.get(e.childTaskId)?.phase ?? ''));
    const now = new Date();
    const jobTouch = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
      {
        _id: job._id,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: 'NONE',
        ...(expectedActivationDispatchGeneration === undefined
          ? {}
          : { activationDispatchGeneration: expectedActivationDispatchGeneration }),
      },
      { $set: { updatedAt: now }, $inc: { stateVersion: 1 } },
      { session },
    );
    if (jobTouch.modifiedCount !== 1) return false;
    await tasks.updateOne({ _id: parentTaskId }, { $set: { phase: anyRequiredFailed ? 'FAILED' : 'SUCCEEDED', updatedAt: now } }, { session });
    await edges.updateMany({ parentTaskId, lifecycle: 'ACTIVE' }, { $set: { lifecycle: 'SETTLED' } }, { session });
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
      _id: newOutboxId(), aggregate: jobId, type: 'LaneWakeRequested', state: 'PENDING',
      payload: {
        jobId,
        reason: 'fan_in',
        activationDispatchGeneration: job.activationDispatchGeneration,
      },
      createdAt: now,
    }, { session });
    return true;
  });
  return value;
}
