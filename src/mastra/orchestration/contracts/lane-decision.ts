/**
 * Lane decision contract (plan §4.2) — F5B increment 1.
 *
 * The parent plan splits orchestration in two. The **Orchestration Service** is
 * the deterministic owner of authority: claim, lease/fence, event reduction,
 * timers, terminalization. The **Lane Orchestrator** is "an agentic decision
 * component *inside* that boundary" — it may build a plan, split a goal, pick an
 * execution profile, judge results, decide retry/replan, prepare a synthesis, or
 * formulate a question for the user.
 *
 * This module is the seam between them: the typed decision a lane activation
 * ends with. Today it is produced by a deterministic function; from increment 2
 * a model may produce it instead. Nothing else about the activation changes —
 * the decision still passes through the same freeze/hash/CAS path any producer
 * does.
 *
 * WHY THE DECISION IS DATA, NOT AN ACTION
 * ---------------------------------------
 * §4.2 forbids the Lane Orchestrator from trusting a model-supplied
 * `attemptNumber`, `taskId`, status or fencing token, and from keeping its
 * correctness "only in LLM working memory". So a decision here carries INTENT
 * ONLY. Every identifier, version and fence is inserted by the Service after
 * validation. A model that hallucinates a `taskId` cannot therefore act on
 * anything — there is no field for it to put one in.
 *
 * WHY ACTIVATIONS ARE SHORT
 * -------------------------
 * §4.2: "Each lane activation is short and ends with one of: dispatch, wait,
 * request_user, synthesize or terminalize. Waiting for workers happens in
 * durable state, not inside a model call." That is what lets one orchestrator
 * interleave many jobs: it never holds work in its context, it records a
 * decision and ends. A result later wakes the job and a NEW short activation
 * reads durable state and decides again — which is also why a crash mid-flight
 * costs nothing but a retry.
 */

/** The ways a lane activation may end (§4.2). */
export type LaneDecisionKind =
  | 'dispatch'
  | 'plan_steps'
  | 'wait'
  | 'request_user'
  | 'synthesize'
  | 'terminalize';

/**
 * Create work. `attemptMode` is the execution shape; only `SERIAL` exists in the
 * flat slice — fan-out needs `ORC-DISPATCH-EDGE-01` and is Wave 6-7.
 */
export interface LaneDispatchDecision {
  kind: 'dispatch';
  attemptMode: 'SERIAL';
  /** Optional refinement of what the task should achieve; defaults to the job goal. */
  taskGoal?: string;
  /**
   * WHICH specialist should do the work — a name from the closed menu the
   * decider was given (see `LaneDecisionContext.capabilities`).
   *
   * This is intent, not authority, and the distinction is the whole reason it is
   * a `capability` and not an `agentId`: nothing here is trusted to name a
   * runnable thing. The name is checked against the advertised set before the
   * decision is accepted, and resolved again through the code-owned registry at
   * dispatch time. A name that resolves nowhere is rejected — never coerced to a
   * nearest match, never silently defaulted at this layer.
   *
   * Omitted means "no preference": the Service routes to its default. That is
   * also what happens when the decision is rejected, so a confused model can
   * only ever cost a job the *right* specialist, never route it somewhere the
   * registry does not list.
   */
  capability?: string;
}

/**
 * One step of an ordered plan (F6B).
 *
 * Intent only, exactly like `LaneDispatchDecision.capability`: the model names
 * what each step is for and who should do it, from the closed menu it was given.
 * The budget, the window and the task ids are inserted by code — a decider that
 * could set its own window would be a decider that can spend an hour.
 */
export interface LanePlannedStep {
  goal: string;
  capability?: string;
}

/**
 * Plan a SEQUENCE of steps instead of a single task (F6B).
 *
 * The reason this is a separate kind rather than a repeated `dispatch`: a
 * sequence is one decision about the shape of the whole job, frozen once. Letting
 * the lane emit `dispatch` repeatedly would mean re-deciding the plan on every
 * activation, with a different model call each time and nothing holding the steps
 * together — which is how a job ends up half-planned after a restart.
 *
 * Steps run in the order given, each as its own durable task with its own
 * attempt, budget and specialist, and each seeing what the previous one produced.
 * A failed step blocks the remaining tail rather than letting later steps build
 * on nothing.
 */
export interface LanePlanStepsDecision {
  kind: 'plan_steps';
  steps: LanePlannedStep[];
}

/** Nothing to do this activation; the job stays alive and is woken by an event. */
export interface LaneWaitDecision {
  kind: 'wait';
  reason: string;
}

/** Block on a human answer. The Service opens the durable request (ORC-REQUEST-01). */
export interface LaneRequestUserDecision {
  kind: 'request_user';
  question: string;
}

/** Produce the user-facing synthesis of work already done. */
export interface LaneSynthesizeDecision {
  kind: 'synthesize';
  summary: string;
}

/** Finish the job. The Service still validates state/version before terminalizing. */
export interface LaneTerminalizeDecision {
  kind: 'terminalize';
  outcome: 'COMPLETED' | 'FAILED' | 'PARTIAL';
  reason?: string;
}

export type LaneDecisionV1 =
  | LaneDispatchDecision
  | LanePlanStepsDecision
  | LaneWaitDecision
  | LaneRequestUserDecision
  | LaneSynthesizeDecision
  | LaneTerminalizeDecision;

/**
 * A plan of one step is just a `dispatch`, so a sequence starts at two; the upper
 * bound keeps one activation from committing a runaway amount of work. Both are
 * deliberately small — widen them from a measurement, not from an intuition that
 * bigger plans would be nice.
 */
const MIN_PLAN_STEPS = 2;
const MAX_PLAN_STEPS = 8;

/** Bounded so a model cannot push unbounded text through the decision boundary. */
const MAX_TEXT_CHARS = 2_000;

export class InvalidLaneDecisionError extends Error {
  constructor(readonly detail: string) {
    super(`invalid lane decision: ${detail}`);
    this.name = 'InvalidLaneDecisionError';
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidLaneDecisionError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_TEXT_CHARS) {
    throw new InvalidLaneDecisionError(`${field} exceeds ${MAX_TEXT_CHARS} chars`);
  }
  return value;
}

/**
 * A capability name is an identifier, not free text.
 *
 * Structural only — whether the name means anything is the registry's business
 * (`orchestration/execution/lane-decider.ts` checks it against the advertised
 * menu). This layer just refuses to carry anything that could not be an id:
 * whitespace, punctuation and length are how a "capability" would smuggle prose
 * or an injection payload into whatever renders it downstream.
 */
const CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function requireCapabilityName(value: unknown): string {
  if (typeof value !== 'string' || !CAPABILITY_NAME.test(value)) {
    throw new InvalidLaneDecisionError('dispatch.capability must be a plain identifier');
  }
  return value;
}

/**
 * No key this kind does not define.
 *
 * The header has always claimed "an extra key is a hard error"; until capability
 * routing it was only true for the named authority fields, so a decision could
 * carry an `agentId` and pass. Nothing read it — but "the boundary rejects
 * anything it does not fully understand" is the entire safety argument, and a
 * field that is merely ignored is one refactor away from being honoured.
 * Found while testing that a model cannot name an agent directly.
 */
function assertNoExtraKeys(decision: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(decision)) {
    if (!allowed.includes(key)) {
      throw new InvalidLaneDecisionError(`unknown field ${key} for kind ${String(decision.kind)}`);
    }
  }
}

/**
 * Structural validation, mirroring `assertPlanningProposal`.
 *
 * Deliberately strict and total: an unknown `kind`, a missing field or an extra
 * key is a hard error, not a best-effort coercion. From increment 2 this is the
 * boundary a model's output crosses, and the whole safety argument rests on it
 * rejecting anything it does not fully understand.
 */
export function assertLaneDecision(value: unknown): asserts value is LaneDecisionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidLaneDecisionError('decision must be an object');
  }
  const decision = value as Record<string, unknown>;

  // Identifiers/versions/fences are the Service's business. Their PRESENCE is
  // itself the error: a decision carrying one is either a confused model or an
  // attempt to claim authority, and both must fail loudly rather than be ignored.
  for (const forbidden of ['jobId', 'taskId', 'attemptId', 'planVersion', 'fence', 'activationId']) {
    if (forbidden in decision) {
      throw new InvalidLaneDecisionError(`decision must not carry ${forbidden} — authority is the Service's`);
    }
  }

  switch (decision.kind) {
    case 'dispatch': {
      if (decision.attemptMode !== 'SERIAL') {
        throw new InvalidLaneDecisionError('dispatch.attemptMode must be SERIAL in the flat slice');
      }
      if (decision.taskGoal !== undefined) requireText(decision.taskGoal, 'dispatch.taskGoal');
      if (decision.capability !== undefined) requireCapabilityName(decision.capability);
      assertNoExtraKeys(decision, ['kind', 'attemptMode', 'taskGoal', 'capability']);
      return;
    }
    case 'plan_steps': {
      if (!Array.isArray(decision.steps)) {
        throw new InvalidLaneDecisionError('plan_steps.steps must be an array');
      }
      // Bounded for the same reason every text field is: a decision is a model's
      // output crossing into durable state. An unbounded plan would let one
      // activation commit an arbitrary amount of work, and a job with hundreds of
      // steps is a runaway nobody asked for rather than an ambitious plan.
      if (decision.steps.length < MIN_PLAN_STEPS || decision.steps.length > MAX_PLAN_STEPS) {
        throw new InvalidLaneDecisionError(
          `plan_steps.steps must hold ${MIN_PLAN_STEPS}-${MAX_PLAN_STEPS} steps, got ${decision.steps.length}`,
        );
      }
      decision.steps.forEach((raw, index) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new InvalidLaneDecisionError(`plan_steps.steps[${index}] must be an object`);
        }
        const step = raw as Record<string, unknown>;
        requireText(step.goal, `plan_steps.steps[${index}].goal`);
        if (step.capability !== undefined) requireCapabilityName(step.capability);
        // Same rule as the decision itself: a step may not name a task or claim
        // a window. Ids and budgets are inserted by code.
        assertNoExtraKeys(step, ['goal', 'capability']);
      });
      assertNoExtraKeys(decision, ['kind', 'steps']);
      return;
    }
    case 'wait': {
      requireText(decision.reason, 'wait.reason');
      assertNoExtraKeys(decision, ['kind', 'reason']);
      return;
    }
    case 'request_user': {
      requireText(decision.question, 'request_user.question');
      assertNoExtraKeys(decision, ['kind', 'question']);
      return;
    }
    case 'synthesize': {
      requireText(decision.summary, 'synthesize.summary');
      assertNoExtraKeys(decision, ['kind', 'summary']);
      return;
    }
    case 'terminalize': {
      if (decision.outcome !== 'COMPLETED' && decision.outcome !== 'FAILED' && decision.outcome !== 'PARTIAL') {
        throw new InvalidLaneDecisionError('terminalize.outcome must be COMPLETED, FAILED or PARTIAL');
      }
      if (decision.reason !== undefined) requireText(decision.reason, 'terminalize.reason');
      assertNoExtraKeys(decision, ['kind', 'outcome', 'reason']);
      return;
    }
    default:
      throw new InvalidLaneDecisionError(`unknown decision kind: ${String(decision.kind)}`);
  }
}

/**
 * Why the lane is asking.
 *
 * `plan`     — no work exists yet; decide how to start.
 * `evaluate` — all work finished; decide whether that is the end (`terminalize`)
 *              or whether it is worth another attempt (`dispatch` = retry/replan).
 *
 * The same decider serves both, so it must be told which question it is being
 * asked — otherwise "dispatch" at the end of a job would be indistinguishable
 * from "dispatch" at the start, and a job would replan forever.
 *
 * NOTE: `evaluate` is DEFINED but not yet asked by anything. Increment 3 found
 * that the evaluation cannot live where it first looked like it should: the
 * typed RESULT_DRAIN reducer terminalizes the job inside its own transaction,
 * and the plan forbids it from running a model at all ("RESULT_DRAIN nie
 * uruchamia modelu/toola"). The evaluation therefore belongs to a `FINAL_DECISION`
 * activation, which the plan reserves as "its own typed decision boundary".
 */
export type LaneDecisionReason = 'plan' | 'evaluate';

/** Context a decider may read. Read-only: a decider never mutates state. */
export interface LaneDecisionContext {
  jobId: string;
  goal: string;
  planVersion: number;
  /** Whether the job already has materialized work. */
  hasTasks: boolean;
  /** Which question this is. Defaults to `plan` for older callers. */
  reason?: LaneDecisionReason;
  /**
   * Terminal phases of the job's tasks, when `reason === 'evaluate'`. This is the
   * evidence a decider judges: SUCCEEDED, FAILED, PARTIAL, TIMED_OUT…
   */
  taskPhases?: string[];
  /**
   * How many tasks this job has already materialized. Each replan adds one, so
   * this is also the replan bound — a decider that keeps asking for another
   * attempt is stopped by the Service, not trusted to stop itself.
   */
  taskCount?: number;
  /**
   * What the work actually produced, when `reason === 'evaluate'`.
   *
   * §4.2 asks the lane to "evaluate results AND EVIDENCE". Without this the
   * judge is asked whether the output is good enough while being shown only task
   * phases — it cannot answer, so it retries, and every job burns its full replan
   * budget before the bound stops it. Observed on the first real canary job.
   */
  lastResult?: { status: string; text: string };
  /**
   * What the user has told this job — the original instructions plus every
   * answer to a question the lane asked.
   *
   * Without this a judge that asks a question is structurally unable to notice
   * it was answered: it would see the same unchanged result, ask again, and the
   * job would ping-pong until a bound stopped it. The answer is the only thing
   * that makes asking twice different from asking once.
   */
  instructions?: string[];
  /**
   * How many questions this job has already put to the user. Asking is not free
   * — every question costs the user a round trip — so the judge is told the
   * running total, and the Service bounds it regardless of what the judge does.
   */
  questionsAsked?: number;
  /**
   * The specialists this decider may name, when `reason === 'plan'`.
   *
   * Supplied by the mount rather than known here: the durable substrate keeps no
   * dependency on the agent roster, exactly as it keeps none on models. This one
   * list is BOTH what gets rendered into the prompt and what a returned
   * `capability` is checked against — a decider can never be offered one menu and
   * validated against another.
   *
   * Absent means "no choice offered": the decider names no capability and the
   * Service routes to its default, which is the behaviour before capability
   * routing existed.
   */
  capabilities?: ReadonlyArray<{
    name: string;
    description: string;
    /**
     * Capabilities this one delegates to INSIDE its own run. Supplied by the
     * mount from the Agent Board, for the same reason the rest of this list is:
     * the substrate owns no roster. Read by `repairPlanOwnership`, never
     * rendered — see `config/capability-routing.ts`.
     */
    runsInternally?: readonly string[];
  }>;
  /**
   * The activation's own business cutoff. A model-backed decider MUST bound
   * itself by this: it is what makes "each lane activation is short" (§4.2) a
   * structural property rather than a hope. A decision that arrives after the
   * cutoff cannot be frozen or committed anyway.
   */
  businessOperationCutoffAt: Date;
}

export type LaneDecider = (context: LaneDecisionContext) => Promise<LaneDecisionV1>;

/**
 * The default decider: reproduces today's behavior exactly — always plan one
 * SERIAL task. Increment 1 changes no behavior; it only makes the decision an
 * explicit, validated value so a model-backed decider becomes a drop-in
 * replacement rather than a rewrite.
 */
export const deterministicSerialDecider: LaneDecider = async (context) => (
  context.reason === 'evaluate'
    // Today's behaviour at the end of a job: finished work means the job is
    // finished. Only a real decider proposes another attempt.
    ? { kind: 'terminalize', outcome: 'COMPLETED' }
    : { kind: 'dispatch', attemptMode: 'SERIAL' }
);
