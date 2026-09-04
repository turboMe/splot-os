/**
 * Model-backed lane decider (plan §4.2) — F5B increment 2.
 *
 * Increment 1 made "what should this activation do" an explicit, validated value
 * produced by a deterministic function. This is the same seam with a model
 * behind it: the Lane Orchestrator as an "agentic decision component *inside*"
 * the Orchestration Service's deterministic boundary.
 *
 * WHAT MAKES THIS SAFE
 * --------------------
 * The model's output is a *proposal*, and the boundary treats it as hostile
 * until validated:
 *
 *  - it is bounded by the activation's OWN business cutoff, via the same
 *    `runBoundedModelCall` the worker uses. That is what makes "each lane
 *    activation is short" structural: the call cannot outlive the window in
 *    which its result could be frozen anyway;
 *  - it is parsed strictly and passed through `assertLaneDecision`, which
 *    rejects anything carrying authority (`taskId`, `fence`, `planVersion`, …) —
 *    §4.2 forbids trusting model-supplied identifiers, and the contract gives
 *    them nowhere to live;
 *  - every identifier and version is inserted afterwards by the Service;
 *  - any failure — timeout, unparseable text, invalid shape — throws, and the
 *    caller falls back to the deterministic decision with a durable operator
 *    alert. A confused model can slow a job down; it cannot corrupt one.
 *
 * The model is deliberately reached through `ModelCaller`/`runBoundedModelCall`
 * rather than a long agent loop: this is one short structured question, not a
 * task. There is no tool access by construction — §4.2 forbids the Lane
 * Orchestrator from executing domain tools.
 */
import type { LaneDecider, LaneDecisionContext, LaneDecisionV1 } from '../contracts/lane-decision.js';
import { assertLaneDecision, InvalidLaneDecisionError } from '../contracts/lane-decision.js';
import { runBoundedModelCall, type ModelCaller } from './gateway.js';

/** Enough for a decision object; anything larger is a runaway, not an answer. */
const MAX_DECISION_CHARS = 4_000;

export class LaneDecisionUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`lane decision unavailable: ${detail}`);
    this.name = 'LaneDecisionUnavailableError';
  }
}

/**
 * Pull the decision object out of the model's text.
 *
 * Models wrap JSON in prose or fences no matter how firmly the prompt says not
 * to, so the first balanced `{...}` is extracted rather than trusting the whole
 * response to parse. This is leniency about FRAMING only — the object itself
 * still faces the strict validator, so a lenient reader cannot widen what is
 * accepted.
 */
export function extractDecisionJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new LaneDecisionUnavailableError('empty model response');
  if (trimmed.length > MAX_DECISION_CHARS) {
    throw new LaneDecisionUnavailableError(`response exceeds ${MAX_DECISION_CHARS} chars`);
  }

  const start = trimmed.indexOf('{');
  if (start === -1) throw new LaneDecisionUnavailableError('no JSON object in response');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch (error) {
          throw new LaneDecisionUnavailableError(`unparseable JSON: ${(error as Error).message}`);
        }
      }
    }
  }
  throw new LaneDecisionUnavailableError('unterminated JSON object');
}

/**
 * The question put to the model. Compact on purpose — this is one short call.
 *
 * It MUST branch on `reason`. With one shared prompt the judge received exactly
 * the same text for "how should this start" and "is this good enough", and since
 * a goal plus "work materialized: yes" reads as a job needing action, it answered
 * `dispatch` every time — every canary job burned its whole replan budget before
 * the bound stopped it. The judge has to know it is judging, and has to see what
 * it is judging.
 */
export function buildDecisionPrompt(context: LaneDecisionContext): string {
  if (context.reason === 'evaluate') {
    const result = context.lastResult;
    const instructions = context.instructions ?? [];
    const asked = context.questionsAsked ?? 0;
    return [
      'The work for this job has FINISHED. Decide whether it is done.',
      '',
      `Original goal: ${context.goal || '(no goal recorded)'}`,
      `Task outcomes: ${(context.taskPhases ?? []).join(', ') || '(none)'}`,
      `Attempts so far: ${context.taskCount ?? 1}`,
      ...(instructions.length > 0
        ? ['', 'What the user has already told this job:', ...instructions.map((i) => `- ${i}`)]
        : []),
      ...(asked > 0 ? ['', `You have already asked the user ${asked} question(s).`] : []),
      '',
      'What the work produced:',
      result
        ? `[status: ${result.status}]\n${result.text || '(no text)'}`
        : '(no result recorded)',
      '',
      'Choose one:',
      '- {"kind":"terminalize","outcome":"COMPLETED"} — this reasonably satisfies the goal.',
      '- {"kind":"dispatch","attemptMode":"SERIAL"} — try again. Only when the output is clearly',
      '  wrong or empty, OR when the user has just answered a question and the work should now',
      '  be redone with that answer.',
      '- {"kind":"request_user","question":"..."} — the work came back ASKING for information',
      '  rather than delivering, and no reasonable attempt can succeed without the user. Ask for',
      '  everything you need in ONE question.',
      '',
      'Prefer finishing: another attempt costs time and money, and a question costs the user a',
      'round trip. But do NOT accept a request for information as if it were the deliverable —',
      'a job that ends COMPLETED while its output is a question has failed the user quietly.',
      '',
      'Reply with one JSON decision object and nothing else.',
    ].join('\n');
  }
  const menu = context.capabilities ?? [];
  return [
    'Decide how to START this durable job.',
    '',
    `Goal: ${context.goal || '(no goal recorded)'}`,
    `Work already materialized: ${context.hasTasks ? 'yes' : 'no'}`,
    `Plan version: ${context.planVersion}`,
    ...(menu.length > 0
      ? [
        '',
        'Specialists you may assign the work to, by capability name:',
        ...menu.map((c) => `- ${c.name}: ${c.description}`),
        '',
        'When dispatching, add "capability":"<one name from the list above>".',
        'Pick the specialist whose description actually covers this goal. If none',
        'clearly does, omit the field rather than forcing a bad fit — the work then',
        'goes to the general default.',
      ]
      : []),
    '',
    // The two shapes that are executable at PLAN time, spelled out.
    //
    // They were not, and that is why the whole F6B sequence machinery was
    // unreachable: the contract validated `plan_steps`, the store committed it,
    // `materializePlannedSteps`/`promoteSequencedSteps` ran it from the live
    // lane, `check:multi-step-plan` asserted it — and no prompt ever told the
    // model the decision existed, so nothing ever produced one. The gate was
    // green because it constructed the decision itself.
    //
    // Listed here rather than left to the agent's system prompt for the same
    // reason the evaluate branch lists its three: the branch has to say which
    // options belong to the question it is asking. `plan_steps` belongs ONLY
    // here — at evaluate time FINAL_DECISION cannot execute it and would fall
    // through to terminalize, finishing the job on a decision meaning
    // "there is more to do".
    'Choose one:',
    '- {"kind":"dispatch","attemptMode":"SERIAL"} — one specialist can carry this goal to the',
    '  end. This is the normal choice.',
    // The step example names `capability` only when a menu exists. A mount with
    // no registry must not invite a choice it cannot offer — caught by
    // `check:capability-routing` on the first version of this block, which put
    // the word in front of every mount.
    ...(menu.length > 0
      ? [
        '- {"kind":"plan_steps","steps":[{"goal":"…","capability":"…"},…]} — the goal is a',
        '  sequence of 2 to 8 stages needing DIFFERENT specialists, run in order, each seeing',
        '  what the previous one produced. Two stages that would go to the same specialist are',
        '  one stage.',
      ]
      : [
        '- {"kind":"plan_steps","steps":[{"goal":"…"},…]} — the goal is a sequence of 2 to 8',
        '  stages that cannot be done in one run, executed in order, each seeing what the',
        '  previous one produced.',
      ]),
    '- {"kind":"request_user","question":"…"} — starting is impossible without something only',
    '  the user has. This costs a round trip, so it is a last resort.',
    '',
    'Reply with one JSON decision object and nothing else.',
  ].join('\n');
}

/**
 * Build a decider that asks a model, bounded by the activation window.
 *
 * Injected rather than imported by the store, so the durable substrate keeps no
 * dependency on agents or models — the same reason `ModelCaller` is injected
 * into the execution gateway.
 */
export function createModelLaneDecider(opts: {
  callModel: ModelCaller;
  /**
   * The specialists this decider may assign work to. Closed over here rather
   * than threaded through the store: the durable substrate has no business
   * knowing the agent roster, and the menu that is rendered must be the same
   * object the answer is validated against.
   */
  capabilities?: ReadonlyArray<{ name: string; description: string }>;
}): LaneDecider {
  return async (raw: LaneDecisionContext): Promise<LaneDecisionV1> => {
    const context: LaneDecisionContext = raw.capabilities || !opts.capabilities
      ? raw
      : { ...raw, capabilities: opts.capabilities };
    const result = await runBoundedModelCall({
      deadlineAt: context.businessOperationCutoffAt.getTime(),
      callModel: opts.callModel,
      prompt: buildDecisionPrompt(context),
    });

    if (!result.ok) {
      // Deadline or abort: the activation window is closing, so there is no
      // point retrying inside it. The caller degrades deterministically.
      throw new LaneDecisionUnavailableError(result.reason ?? 'bounded call failed');
    }

    const decision = extractDecisionJson(result.text ?? '');
    // Strict gate. Everything above this line treats the model as untrusted input.
    assertLaneDecision(decision);
    assertCapabilityWasOffered(decision, context);
    return repairPlanOwnership(decision, context);
  };
}

/**
 * Drop plan steps that duplicate work a later capability performs INSIDE its own
 * run, and collapse what is left when a plan is no longer a plan.
 *
 * WHY A REPAIR AND NOT A REJECTION
 * --------------------------------
 * Rejecting looks like the safer boundary and is the worse one here. A rejected
 * decision falls back to `{kind:'dispatch', attemptMode:'SERIAL'}` with NO
 * capability, which routes to the mount's default agent — `researcherAgent` in
 * production. So "refuse the bad research → chef plan" would have sent the whole
 * menu job to the researcher. The plan is not unsafe, it is over-specified: the
 * repair removes the redundant step and keeps everything the model got right.
 *
 * WHY THE COLLAPSE CARRIES NO `taskGoal`
 * --------------------------------------
 * This is the part that actually fixes the measured failure, and it is easy to
 * get backwards. A task with no goal of its own inherits the JOB goal, and
 * `semanticPromptFor` then hands it to the agent byte for byte. Every planner-
 * authored step goal in the three live menu jobs had dropped the restaurant URL
 * ("Na podstawie przeanalizowanej oferty zaproponuj odświeżoną wersję menu") —
 * 0 of 20 chefAgent tasks in V2 history ever received one — and chef's `recon`
 * branch is entered only "when we have a URL/name". Collapsing to the model's
 * wording would keep the split's damage after removing the split. Collapsing to
 * the job goal is what the one working path (a pinned delegation, which also
 * writes no task goal) has always done.
 *
 * An earlier step is dropped when ANY later step's capability declares it, not
 * only the immediate predecessor: the measured filmmaker plan was
 * researcher → content → filmmaker, and both consumers run their own research.
 * The last step can never be dropped — nothing follows it to absorb it — so this
 * always leaves at least one step.
 */
export function repairPlanOwnership(
  decision: LaneDecisionV1,
  context: LaneDecisionContext,
): LaneDecisionV1 {
  if (decision.kind !== 'plan_steps') return decision;
  const absorbs = new Map<string, readonly string[]>();
  for (const c of context.capabilities ?? []) {
    if (c.runsInternally && c.runsInternally.length > 0) absorbs.set(c.name, c.runsInternally);
  }
  if (absorbs.size === 0) return decision;

  const redundant = new Set<number>();
  decision.steps.forEach((step, index) => {
    const absorbed = absorbs.get(step.capability ?? '');
    if (!absorbed) return;
    for (let earlier = 0; earlier < index; earlier++) {
      const candidate = decision.steps[earlier]!.capability;
      if (candidate && absorbed.includes(candidate)) redundant.add(earlier);
    }
  });
  if (redundant.size === 0) return decision;

  const kept = decision.steps.filter((_, index) => !redundant.has(index));
  // Loud on purpose. A plan silently rewritten under the operator is how a
  // routing decision becomes impossible to explain after the fact.
  console.warn(
    `[orch-v2] plan repaired for job ${context.jobId}: dropped `
    + `${[...redundant].map((i) => decision.steps[i]!.capability).join(', ')} — `
    + `absorbed by a later capability that runs it internally. `
    + `${decision.steps.length} step(s) → ${kept.length}`,
  );
  if (kept.length >= MIN_REPAIRED_PLAN_STEPS) return { kind: 'plan_steps', steps: kept };
  const survivor = kept[0];
  return {
    kind: 'dispatch',
    attemptMode: 'SERIAL',
    // No `taskGoal` — see the header. The job goal is the mandate.
    ...(survivor?.capability !== undefined ? { capability: survivor.capability } : {}),
  };
}

/** Below this a plan is a single task, and `assertLaneDecision` would reject it. */
const MIN_REPAIRED_PLAN_STEPS = 2;

/**
 * A named capability must be one this activation actually offered.
 *
 * `assertLaneDecision` can only check the SHAPE of the name — it has no roster,
 * by design. This is the other half: the menu that went into the prompt is the
 * menu the answer is judged against, so a hallucinated or stale specialist is a
 * rejected decision rather than a route.
 *
 * Rejecting rather than dropping the field is deliberate. A model that names a
 * specialist which does not exist has misunderstood the job, and quietly running
 * that job on the default agent would hide exactly the signal worth having — the
 * caller's fallback path already handles this with an operator alert.
 */
function assertCapabilityWasOffered(decision: LaneDecisionV1, context: LaneDecisionContext): void {
  const named = decision.kind === 'dispatch'
    ? [decision.capability]
    // A plan's steps were exempt, and the exemption was invisible rather than
    // deliberate: this returned early for every kind but `dispatch`, so a plan
    // could name a specialist the menu never offered. It then survived the
    // boundary, got frozen into durable state, and failed at execution as
    // `no_route` — after the plan had already consumed the job's task budget, so
    // no retry was possible. Same rule, both shapes.
    : decision.kind === 'plan_steps'
      ? decision.steps.map((step) => step.capability)
      : [];
  for (const capability of named) {
    if (capability === undefined) continue;
    if (!(context.capabilities ?? []).some((c) => c.name === capability)) {
      throw new InvalidLaneDecisionError(`capability "${capability}" was not offered`);
    }
  }
}
