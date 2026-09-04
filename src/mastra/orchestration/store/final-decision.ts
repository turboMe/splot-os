/**
 * FINAL_DECISION — judging finished work (plan §4.2, §7.6).
 *
 * The Lane Orchestrator's second question. `runPlanningActivation` asks "how
 * should this start"; this asks "is what came back actually good enough, or is it
 * worth another attempt". §4.2 lists exactly that among its duties: "evaluate
 * results and evidence, decide retry/replan/review, prepare a synthesis".
 *
 * WHY IT IS A SEPARATE ACTIVATION AND NOT A HOOK IN THE DRAIN
 * ----------------------------------------------------------
 * The obvious place looks like the result-drain reducer, since that is what
 * turns a finished task into a finished job. It is the wrong place twice over:
 *
 *  - the drain commits terminalization inside its own transaction, and terminal
 *    is monotonic — by the time a hook could look at the outcome, the job is
 *    already closed and nothing can reopen it;
 *  - the plan forbids it outright — "RESULT_DRAIN nie uruchamia modelu/toola" —
 *    and names the alternative in the same sentence: "FINAL_DECISION ma własny
 *    typed decision boundary".
 *
 * So the drain DEFERS (see `deferTerminalDecision`): it applies the result, leaves
 * the job non-terminal, and wakes the lane. This module then judges under its own
 * authority and either terminalizes or replans.
 *
 * SCOPE (honest)
 * --------------
 * This is the flat-slice version. The protected terminal-decision reserve
 * (`jobTerminalDecisionActiveReserveMs`) that §11 requires does not exist yet —
 * no budget pool machinery does beyond the STOP control pool — so this slice
 * bounds itself by an explicit window instead and does not claim the reserve.
 * Escalation and manual-recovery decisions are likewise not built. What IS here:
 * judge → terminalize or replan, bounded, fail-closed, alerting.
 */
import type { Db, MongoClient } from 'mongodb';
import type { JobTerminalOutcome } from '../contracts/index.js';

import {
  assertLaneDecision,
  type LaneDecider,
  type LaneDecisionV1,
} from '../contracts/lane-decision.js';
import {
  COLLECTIONS,
  type ControlRequestDoc,
  type JobDoc,
  type OutboxDoc,
  type TaskDoc,
} from './collections.js';
import { createTask } from './attempts.js';
import { parseNeedsInput } from '../execution/headless-contract.js';
import { getJobResult, renderProducerText } from './queries.js';
import { openLaneUserRequest } from './request-boundary.js';
import { runTxn } from './txn.js';
import type { JobEventDoc } from './collections.js';

/**
 * Replan bound. Each replan materializes one more task, so the task count IS the
 * counter — no schema change, and it measures exactly the thing that runs away.
 *
 * This is not optional. A judge that keeps answering "try again" would otherwise
 * loop forever, burning tokens on a job that can never finish. The Service stops
 * it; the judge is not trusted to stop itself.
 */
const TERMINAL_TASK_PHASES = new Set([
  'SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED',
  'TIMED_OUT', 'CANCELLED', 'SUPERSEDED', 'UNKNOWN_OUTCOME',
]);

/** Bounded: the judge needs enough to recognize the work, not the whole payload. */
const MAX_JUDGED_RESULT_CHARS = 4_000;

// This module's own copy was the only correct one of three; it now lends the
// implementation to the other two rather than being duplicated a fourth time.
const renderResultText = renderProducerText;

const DEFAULT_MAX_LANE_TASKS = 3;

/** The judging call is bounded like any other lane model call (§4.2: activations are short). */
const DEFAULT_DECISION_WINDOW_MS = 15_000;

function maxLaneTasks(): number {
  const raw = Number(process.env.ORCHESTRATION_V2_MAX_LANE_TASKS);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_LANE_TASKS;
}

function decisionWindowMs(): number {
  const raw = Number(process.env.ORCHESTRATION_V2_FINAL_DECISION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DECISION_WINDOW_MS;
}

export type FinalDecisionOutcome =
  | { action: 'terminalized'; outcome: string }
  | { action: 'replanned'; taskId: string }
  | { action: 'asked'; requestId: string }
  | { action: 'skipped'; reason: string };

/**
 * Question bound, the counterpart of the replan bound.
 *
 * A judge that answers `request_user` every time would bounce the job between
 * "waiting on a human" and "judging" forever, and each lap costs the USER a
 * round trip rather than just tokens — so this ceiling matters more than the
 * replan one, not less.
 */
const DEFAULT_MAX_LANE_QUESTIONS = 2;

function maxLaneQuestions(): number {
  const raw = Number(process.env.ORCHESTRATION_V2_MAX_LANE_QUESTIONS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_LANE_QUESTIONS;
}

async function alert(
  db: Db,
  jobId: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
    { _id: id },
    {
      $setOnInsert: {
        aggregate: jobId,
        type: 'OperatorAlertRequested',
        state: 'PENDING',
        payload,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  ).catch(() => undefined);
}

/**
 * Judge a job whose work has finished but whose terminal call was deferred.
 *
 * Returns `skipped` whenever the job is not in that state, so it is safe to call
 * speculatively from the lane. Every failure path resolves toward FINISHING: a
 * broken judge may slow a job down, never keep it alive forever.
 */
export async function runFinalDecisionActivation(
  client: MongoClient,
  db: Db,
  jobId: string,
  opts: {
    decide?: LaneDecider;
    /**
     * Does this capability's declared deliverable REQUIRE a stored artifact?
     *
     * Injected, not read from the Agent Board here: `TaskDoc.capability` is
     * opaque to the substrate — the worker's router owns what the name means —
     * so the store must not learn to interpret it.
     */
    expectsArtifact?: (capability: string | null) => boolean;
  } = {},
): Promise<FinalDecisionOutcome> {
  const decide = opts.decide;
  if (!decide) return { action: 'skipped', reason: 'no_decider' };

  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const job = await jobs.findOne({ _id: jobId, terminalOutcome: null });
  if (!job) return { action: 'skipped', reason: 'not_open' };
  // Judging creates work, so it obeys the same rule as planning: nothing new
  // happens behind a pause or a stop (§8.4).
  if (job.controlState !== 'NONE') return { action: 'skipped', reason: 'controlled' };

  const tasks = await db.collection<TaskDoc>(COLLECTIONS.tasks).find({ jobId }).toArray();
  if (tasks.length === 0) return { action: 'skipped', reason: 'no_tasks' };

  if (!tasks.every((task) => TERMINAL_TASK_PHASES.has(task.phase))) {
    return { action: 'skipped', reason: 'work_in_flight' };
  }

  const limit = maxLaneTasks();
  // The replan budget counts ATTEMPTS AT THE WORK, not rows in the collection.
  //
  // A `plan_steps` decision writes one aggregation parent plus one task per
  // step, so a perfectly ordinary two-step plan arrived here holding three tasks
  // against a limit of three — "exhausted" before a single retry, on the first
  // and only judgement. Measured consequences, all three of them silent:
  // the judge model was never asked whether the work was any good; no replan was
  // possible however clearly it had failed; and `lane_replan_exhausted` fired on
  // jobs that had replanned exactly zero times (job_d9841a71, taskCount 3,
  // COMPLETED; job_b1fdfde6, taskCount 4, every task SUCCEEDED).
  //
  // The parent never runs — `spawnChildTasks` parks it on WAITING_DEPENDENCY and
  // it exists to aggregate — so it is not an attempt at anything.
  const workTasks = tasks.filter((task) => !task.plannedSteps || task.plannedSteps.length === 0);
  const exhausted = workTasks.length >= limit;
  const questionsAsked = await db.collection<ControlRequestDoc>(COLLECTIONS.requests)
    .countDocuments({ jobId, kind: 'user' });

  // Did the run come back BLOCKED rather than finished? The headless output
  // contract gives an agent one structural way to say so, and recognizing it
  // here — deterministically, before any model is consulted — is the point:
  // asking a model "is this a deliverable or a question?" is exactly what
  // already failed once, when the judge accepted "which cuisine?" as a menu.
  const committedResult = await getJobResult(db, job.resourceId, jobId).catch(() => null);
  const blockedOn = committedResult
    ? parseNeedsInput(renderResultText(committedResult.data))
    : null;

  // Did the run come back with a PROGRESS REPORT instead of the thing it was
  // asked for? For a capability whose declared deliverable is a ref — a Menu
  // Book, a rendered file — prose is never the product, so this is a fact about
  // the result rather than a judgement about its quality, and it is settled here
  // before any model is asked.
  //
  // Live failure: a chef job committed 581 chars of "Projekt utworzony.
  // Uzupełniam profil — pracuję autonomicznie…" and finished COMPLETED, with no
  // menu at all. That is worse than a failure, because it looks like success and
  // nobody goes looking.
  //
  // Deliberately narrow. It asks only "did the run store the document it was
  // supposed to produce", never "is this good" — the judge still owns quality,
  // and a length or phrasing heuristic would reject `crmAgent`'s legitimate
  // 69-character answer.
  const lastTask = workTasks[workTasks.length - 1];
  const wantsArtifact = opts.expectsArtifact?.(lastTask?.capability ?? null) === true;
  const gotArtifact = Boolean(
    committedResult
    && typeof committedResult.data === 'object'
    && committedResult.data !== null
    && (committedResult.data as { fromArtifact?: unknown }).fromArtifact === true,
  );
  const succeeded = tasks.some((task) => task.phase === 'SUCCEEDED');
  // The rule asks "did the capability that owed a document produce one", so both
  // halves must be about THAT task. `succeeded` used to be true if ANY task in
  // the job succeeded, which in a plan means a different specialist entirely:
  // job_a625e520's chef step TIMED_OUT with zero characters, its researcher step
  // succeeded, and the job was filed as `lane_deliverable_missing` — "returned
  // prose where a document belongs" — when nothing had been returned at all. The
  // outcome was right; the diagnosis sent the operator looking for the wrong bug.
  const ownerDelivered = lastTask?.phase === 'SUCCEEDED';
  const prosePassedOffAsDocument = wantsArtifact && ownerDelivered && !gotArtifact;

  let decision: LaneDecisionV1;
  if (prosePassedOffAsDocument && !exhausted) {
    // Retry rather than ask: there is nothing to judge. The replan bound still
    // applies below, so this cannot loop.
    decision = { kind: 'dispatch', attemptMode: 'SERIAL' };
  } else if (prosePassedOffAsDocument && exhausted) {
    // Out of retries with still no document. Finish, and make the reason
    // visible — a job that ends holding prose where a file belongs must not look
    // like one that succeeded.
    await alert(db, jobId, `obx_final_no_artifact:${jobId}:${tasks.length}`, {
      alertType: 'lane_deliverable_missing',
      jobId,
      capability: lastTask?.capability ?? null,
      taskCount: tasks.length,
    });
    decision = { kind: 'terminalize', outcome: 'FAILED' };
  } else if (blockedOn && questionsAsked < maxLaneQuestions()) {
    // No judgement call to make: the specialist stated it cannot proceed without
    // the user. The question bound still applies below.
    decision = { kind: 'request_user', question: blockedOn };
  } else if (exhausted) {
    // Out of retries. Finish — and alert only when the ceiling actually cost
    // something, because an alert that fires on delivered work teaches the
    // operator to ignore the one that matters.
    //
    // Two shapes deserve it and one does not:
    //
    //   [SUCCEEDED, SUCCEEDED, SUCCEEDED]  the judge kept rejecting good work and
    //                                      the Service had to stop it — a judge
    //                                      malfunction, exactly what the bound is for
    //   [FAILED, FAILED, FAILED]           nothing was ever delivered
    //   [FAILED, FAILED, SUCCEEDED]        the retries did their job — no alert
    //
    // The last is the live case: chef committed a 39 KB Menu Book on its third
    // attempt and `lane_replan_exhausted` fired anyway. So the quiet case is
    // precisely "some attempt failed AND the work still got delivered".
    const retriesEarnedTheirKeep = succeeded && tasks.some((task) => task.phase === 'FAILED');
    if (!retriesEarnedTheirKeep) {
      await alert(db, jobId, `obx_final_decision_exhausted:${jobId}:${tasks.length}`, {
        alertType: 'lane_replan_exhausted',
        jobId,
        taskCount: tasks.length,
        limit,
      });
    }
    decision = { kind: 'terminalize', outcome: 'COMPLETED' };
  } else {
    try {
      // Show the judge what the work actually produced. Judging "is this good
      // enough" from task phases alone is impossible, so the judge retried every
      // time and every job burned its full replan budget — seen on the first
      // real canary job (3 attempts, replan bound hit, for work that was fine).
      const committed = committedResult;
      decision = await decide({
        jobId,
        goal: job.goal ?? '',
        planVersion: job.planVersion,
        hasTasks: true,
        reason: 'evaluate',
        // Only real attempts: a plan's aggregation parent has a phase but never
        // ran, and showing it to the judge as evidence invites a verdict on work
        // nobody did.
        taskPhases: workTasks.map((task) => task.phase),
        taskCount: workTasks.length,
        // The answers to earlier questions live here (`answerJobRequest` pushes
        // them), and they are the only reason a second look can reach a
        // different conclusion than the first.
        instructions: job.instructions ?? [],
        questionsAsked,
        ...(committed
          ? {
              lastResult: {
                status: committed.status,
                text: renderResultText(committed.data).slice(0, MAX_JUDGED_RESULT_CHARS),
              },
            }
          : {}),
        businessOperationCutoffAt: new Date(Date.now() + decisionWindowMs()),
      });
      assertLaneDecision(decision);
    } catch (error) {
      // Fail closed toward finishing. Treating an unusable judgement as "retry"
      // would turn a broken judge into an endless job.
      await alert(db, jobId, `obx_final_decision_fallback:${jobId}:${tasks.length}`, {
        alertType: 'final_decision_fallback',
        jobId,
        detail: (error as Error).message,
      });
      decision = { kind: 'terminalize', outcome: 'COMPLETED' };
    }
  }

  // The work came back asking for information instead of delivering it. Retrying
  // would just ask again, and terminalizing would hand the user a `COMPLETED`
  // job whose "result" is a question — the failure the canary caught, where
  // chefAgent asked which cuisine and the job closed as a success.
  //
  // So the job goes to the user, not to the bin. Answering it pushes the answer
  // into `instructions` and returns the job to READY, where the next judgement
  // sees the answer and can order a retry that will actually work.
  if (decision.kind === 'request_user') {
    const questionLimit = maxLaneQuestions();
    if (questionsAsked >= questionLimit) {
      // Out of questions. Finish and say so — the alternative is a job that
      // interrogates the user indefinitely, which is worse than a visible stop.
      await alert(db, jobId, `obx_final_questions_exhausted:${jobId}:${questionsAsked}`, {
        alertType: 'lane_questions_exhausted',
        jobId,
        questionsAsked,
        limit: questionLimit,
      });
    } else {
      const asked = await openLaneUserRequest(client, db, { jobId, question: decision.question })
        .catch(() => null);
      // A failure here (lost race, job already controlled) falls through to
      // finishing rather than leaving the job suspended with nobody waiting.
      if (asked) return { action: 'asked', requestId: asked.requestId };
    }
  }

  if (decision.kind === 'dispatch') {
    try {
      // Inherit the routing of the work being retried. Without this the replan
      // has no capability and the worker sends it to the default agent — the
      // job would silently change specialist halfway through.
      const previous = workTasks[workTasks.length - 1];
      const taskId = await createTask(client, db, jobId, job.planVersion, {
        // A replan may refine the current focus, but the worker renders it next
        // to the immutable full job goal rather than replacing that brief.
        goal: decision.taskGoal ?? previous?.goal ?? null,
        capability: previous?.capability ?? null,
        attemptCapMs: previous?.attemptCapMs ?? null,
        progressiveAttempt: previous?.progressiveAttempt ?? null,
        durableProgressFingerprints: previous?.durableProgressFingerprints ?? [],
        // Record WHAT this retries, so the job's outcome can tell a superseded
        // failure from a real one.
        supersedesTaskId: previous?._id ?? null,
      });
      // The job must leave AWAITING_RESULTS, or the lane's result-drain branch
      // short-circuits every tick before reaching dispatch and the new task is
      // never picked up — the replan would exist on paper and never run. Same
      // transition `answerJobRequest` makes when it resumes a job.
      await reopenForReplan(client, db, jobId);
      return { action: 'replanned', taskId };
    } catch {
      // Lost the admission race against a concurrent stop/steer/terminal. Fall
      // through to finishing rather than retrying blindly.
    }
  }

  // A judgement this boundary cannot carry out still finishes the job, and that
  // is the safe behaviour — but it must not be a SILENT one. `plan_steps` is the
  // case that matters: it means "there is more work to do", and finishing on it
  // looks from the outside exactly like a judge that said COMPLETED. It only
  // reaches here at all because the plan-time prompt offers it and a model may
  // reach for it in the wrong branch; planning is where it belongs, and by then
  // this job has tasks so it can never be planned again.
  if (decision.kind === 'plan_steps' || decision.kind === 'wait' || decision.kind === 'synthesize') {
    await alert(db, jobId, `obx_final_decision_unexecutable:${jobId}:${decision.kind}:${tasks.length}`, {
      alertType: 'final_decision_unexecutable_kind',
      jobId,
      decisionKind: decision.kind,
      taskCount: tasks.length,
    });
  }

  // Everything else — terminalize, plus the still-unwired kinds (`wait`,
  // `synthesize`) and any `request_user` that could not be opened — finishes the
  // job.
  //
  // It writes the terminal itself rather than delegating: `advanceJobFromTasks`
  // refuses a typed-drain job in AWAITING_RESULTS on purpose ("RESULT_DRAIN owns
  // every AWAITING_RESULTS terminal transition"), and the drain has already
  // applied and resolved everything, so re-running it finds nothing to do. This
  // is exactly what the plan means by FINAL_DECISION having "its own typed
  // decision boundary".
  // The ONLY boundary-established outcome: the capability declared a document as
  // its deliverable and the run stored none. Task phases cannot say this — every
  // one of them SUCCEEDED — and it is a fact the code checked, not a judgement
  // the model offered.
  const outcome = await commitFinalTerminal(
    client, db, jobId,
    prosePassedOffAsDocument ? 'FAILED' : undefined,
  );
  return outcome
    ? { action: 'terminalized', outcome }
    : { action: 'skipped', reason: 'terminal_commit_declined' };
}

/**
 * Return a replanned job to the lane's normal dispatch path.
 *
 * Also emits a wake: in production nothing else would run the lane for this job,
 * so without it the replan would sit until an unrelated event happened by.
 */
async function reopenForReplan(client: MongoClient, db: Db, jobId: string): Promise<void> {
  await runTxn(client, async (session) => {
    const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
    const job = await jobs.findOne(
      { _id: jobId, terminalOutcome: null, controlState: 'NONE' },
      { session },
    );
    if (!job) return false;
    const now = new Date();
    const cas = await jobs.updateOne(
      { _id: jobId, stateVersion: job.stateVersion, terminalOutcome: null, controlState: 'NONE' },
      { $set: { phase: 'READY', updatedAt: now }, $inc: { stateVersion: 1 } },
      { session },
    );
    if (cas.modifiedCount !== 1) return false;
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
      { _id: `obx_final_replan_wake:${jobId}:${job.stateVersion}` },
      {
        $setOnInsert: {
          aggregate: jobId,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          payload: {
            jobId,
            reason: 'final_decision_replan',
            activationDispatchGeneration: job.activationDispatchGeneration,
          },
          createdAt: now,
        },
      },
      { session, upsert: true },
    );
    return true;
  });
}

/**
 * Write the job's terminal outcome under FINAL_DECISION's own boundary.
 *
 * The outcome is DERIVED FROM TASK STATE, never from what the judge said: a model
 * answering `terminalize: COMPLETED` over a failed task must not be able to
 * whitewash it. The judge chooses *whether* to finish; the tasks decide *how* it
 * finished.
 */
async function commitFinalTerminal(
  client: MongoClient,
  db: Db,
  jobId: string,
  /**
   * A terminal outcome established by THE BOUNDARY, not by the judge.
   *
   * The rule below — outcome from task state, never from the model — exists so a
   * judge claiming COMPLETED cannot whitewash a failed task, and it stays. This
   * parameter is not a hole in it: nothing model-supplied can reach it. The only
   * caller passes a fact the code checked itself (the capability's declared
   * deliverable is a stored document, and no document was stored), which task
   * phases genuinely cannot express — every task SUCCEEDED, and the job still
   * has nothing to hand over.
   */
  boundaryOutcome?: JobTerminalOutcome,
): Promise<string | null> {
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const { value } = await runTxn(client, async (session) => {
    // A job waiting on a human is not finished, whatever its tasks say. The
    // lane already skips FINAL_DECISION while AWAITING_USER; this is the same
    // rule at the only place that can actually close the job.
    const job = await jobs.findOne(
      { _id: jobId, terminalOutcome: null, controlState: 'NONE', phase: { $ne: 'AWAITING_USER' } },
      { session },
    );
    if (!job) return null;

    const tasks = await db.collection<TaskDoc>(COLLECTIONS.tasks)
      .find({ jobId }, { session }).toArray();
    if (tasks.length === 0) return null;
    if (!tasks.every((task) => TERMINAL_TASK_PHASES.has(task.phase))) return null;

    // A retried failure is not the job's outcome.
    //
    // The rule used to be "any FAILED task → FAILED", which is right for work
    // that failed and right for nothing else. On the design canary the lane did
    // exactly what it is built to do — first attempt timed out at 894s, the
    // replan finished in about a minute and committed a 16 KB HTML prototype —
    // and the job was reported FAILED. The user is told their finished work
    // failed, which is worse than a plain failure: it hides a real deliverable.
    //
    // A superseded task is excluded by the LINK the replan wrote, not by
    // position. "The last task wins" would give the same answer today, when the
    // slice is strictly serial, and quietly become wrong the moment fan-out
    // lands (Fala 6-7) — a genuinely failed sibling would stop counting.
    const superseded = new Set(
      tasks.map((task) => task.supersedesTaskId).filter((id): id is string => typeof id === 'string'),
    );
    const live = tasks.filter((task) => !superseded.has(task._id));

    const outcome = boundaryOutcome
      ?? (live.some((task) => task.phase === 'FAILED') ? 'FAILED'
        : live.some((task) => task.phase === 'PARTIAL') ? 'PARTIAL'
        : live.some((task) => task.phase === 'SUCCEEDED') ? 'COMPLETED'
        : 'FAILED');

    const now = new Date();
    const cas = await jobs.updateOne(
      { _id: jobId, stateVersion: job.stateVersion, terminalOutcome: null, controlState: 'NONE' },
      {
        $set: { phase: 'TERMINAL', terminalOutcome: outcome, activeActivationId: null, updatedAt: now },
        $inc: { stateVersion: 1, activationDispatchGeneration: 1, jobStopGeneration: 1 },
      },
      { session },
    );
    if (cas.modifiedCount !== 1) return null;

    const last = await db.collection<JobEventDoc>(COLLECTIONS.events)
      .find({ jobId }, { session }).sort({ sequence: -1 }).limit(1).next();
    const sequence = (last?.sequence ?? -1) + 1;
    await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
      _id: `${jobId}:${sequence}`,
      jobId,
      sequence,
      type: 'JobTerminalized',
      payload: { terminalOutcome: outcome, decidedBy: 'FINAL_DECISION' },
      createdAt: now,
    }, { session });
    await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
      _id: `obx_final_terminal:${jobId}`,
      aggregate: jobId,
      type: 'JobTerminal',
      state: 'PENDING',
      payload: { jobId, terminalOutcome: outcome },
      createdAt: now,
    }, { session });

    return outcome;
  });
  return value;
}

/** True when this job is finished-but-deferred and therefore needs judging. */
export async function needsFinalDecision(db: Db, jobId: string): Promise<boolean> {
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .findOne({ _id: jobId, terminalOutcome: null, controlState: 'NONE' });
  if (!job) return false;
  const tasks = await db.collection<TaskDoc>(COLLECTIONS.tasks)
    .find({ jobId }, { projection: { phase: 1 } }).toArray();
  if (tasks.length === 0) return false;
  return tasks.every((task) => TERMINAL_TASK_PHASES.has(task.phase));
}
