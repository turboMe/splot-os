/**
 * Registry-backed worker (plan §4.3, §13) — runs a registered Mastra agent as a
 * V2 worker by resolving it through `getAgent` (the running Mastra instance).
 *
 * This resolves the PR-18 finding: a registered agent must run inside the app
 * runtime (its input processors need that context), so we resolve it via
 * `mastra.getAgent(id)` rather than importing it standalone. The gateway's
 * budget-derived AbortSignal is forwarded, and the agent's output is mapped by
 * the A boundary like any producer.
 *
 * Capability→agent routing is a `route` function: `capabilityRoute` resolves the
 * specialist the lane froze into the plan, `singleAgentRoute` is the one-target
 * skeleton kept for fixtures.
 */
import type { WorkerContext, WorkerFixture } from '../store/worker.js';
import {
  runBoundedModelCall,
  modelResultToProducer,
  type ModelCaller,
  type ResultMode,
} from './gateway.js';
import type { ProgressiveAttemptPolicy } from '../contracts/execution-budget.js';
import { createMastraAgentCaller } from './mastra-agent-caller.js';
import { buildHeadlessContract } from './headless-contract.js';
import { SIDE_EFFECT_PRODUCT_CAPABILITIES } from '../../config/capability-routing.js';

export interface RegistryAgent {
  generate(prompt: string, options?: { abortSignal?: AbortSignal }): Promise<{ text?: string }>;
}

export interface RouteDecision {
  agentId: string;
  /** Complete prompt actually shown to the agent. */
  prompt: string;
  /** Semantic goal/instructions before operational wrappers are appended. */
  classificationPrompt?: string;
  resultMode?: ResultMode;
}

/**
 * How the routed agent is actually invoked. Injected so the *governance* profile
 * is a decision of the mount, not baked into the worker:
 *  - default (`createMastraAgentCaller`): a bare `agent.generate` — minimal, and
 *    what the deterministic fixtures rely on.
 *  - `harnessCallerFactory` (`./harness-agent-caller.js`): the full harness
 *    profile (depth, reflector, liveness, pending messages, tool envelopes), so
 *    a migrated capability is not *less* governed on V2 than on legacy.
 */
export type WorkerCallerFactory = (args: {
  agent: RegistryAgent;
  agentId: string;
  ctx: WorkerContext;
  progressPolicy?: ProgressiveAttemptPolicy;
}) => ModelCaller;

export interface RegistryWorkerOpts {
  getAgent: (id: string) => RegistryAgent | undefined;
  route: (ctx: WorkerContext) => RouteDecision | null;
  /** Defaults to the bare `agent.generate` caller. */
  makeCaller?: WorkerCallerFactory;
}

export function createRegistryWorker(opts: RegistryWorkerOpts): WorkerFixture {
  return async (ctx) => {
    const decision = opts.route(ctx);
    if (!decision) return { status: 'failed', error: { code: 'no_route', message: 'no agent routed for this job' } };
    const agent = opts.getAgent(decision.agentId);
    if (!agent) return { status: 'failed', error: { code: 'agent_not_found', message: decision.agentId } };

    // The policy is frozen in the task proposal and snapshotted onto the
    // attempt. Never re-read capability configuration at execution time.
    const progressPolicy = ctx.progressiveAttempt ?? undefined;
    const callModel = opts.makeCaller
      ? opts.makeCaller({ agent, agentId: decision.agentId, ctx, progressPolicy })
      : createMastraAgentCaller(agent);

    const r = await runBoundedModelCall({
      deadlineAt: ctx.businessOperationCutoffAt.getTime(),
      workDeadlineAt: ctx.workDeadlineAt.getTime(),
      callModel,
      prompt: decision.prompt,
      classificationPrompt: decision.classificationPrompt,
      parentSignal: ctx.signal,
      reportProgress: ctx.reportProgress,
    });
    return modelResultToProducer(r, decision.resultMode ?? 'bounded_text');
  };
}

/**
 * What the previous step of an ordered plan produced (F6B).
 *
 * Rendered as a labelled block rather than folded into the goal: the agent has to
 * be able to tell "this is what came before, and whose work it was" from "this is
 * what you must do". Without the distinction a step reads its predecessor's
 * output as part of its own brief.
 *
 * Artifact ids are named explicitly because the excerpt is bounded — a step that
 * needs the whole 30 KB document has to know there is one and how to ask for it.
 */
function upstreamBlock(ctx: WorkerContext): string {
  if (!ctx.upstream || ctx.upstream.length === 0) return '';
  const parts = ctx.upstream.map((step) => [
    `--- WYNIK POPRZEDNIEGO KROKU (${step.capability ?? 'nieznany specjalista'}) ---`,
    step.goal ? `Zadanie tamtego kroku: ${step.goal}` : '',
    `Status: ${step.status}`,
    step.summary ? `Podsumowanie: ${step.summary}` : '',
    step.artifacts.length > 0
      ? `Artefakty (pełna treść pod tymi id): ${step.artifacts.join(', ')}`
      : '',
    step.preview ? `Wynik:\n${step.preview}` : '',
  ].filter(Boolean).join('\n'));
  return parts.join('\n\n');
}

/**
 * W3 — in a multi-step plan the TASK is the mandate; the job goal is context.
 *
 * This used to render the job goal first and label the task "refines but never
 * replaces the full goal". For a single-task job that is exactly right. For a
 * step of a plan it says the opposite of what is meant, and specialists followed
 * it faithfully:
 *
 *   - a research step briefed "fetch and analyse the CURRENT menu of this
 *     restaurant" fetched the real pages, then delivered a NEW menu with
 *     suggested prices — because the job goal said to create one. The real menu
 *     it had in hand never reached the chef step that needed it;
 *   - an earlier three-step plan had EVERY step deliver the whole package, so
 *     the same work was done three times and the middle step's product was lost
 *     from the final answer.
 *
 * Neither is a routing defect: the plan was well split, the briefs were precise,
 * and the framing overrode both. So the framing is what changes. The job goal
 * stays — a step that cannot see why it exists writes to nobody — but it is
 * named as background, and the deliverable is the task's alone.
 *
 * A single-task job keeps the previous shape byte for byte: there is no other
 * step to confuse it with, and rewording it would be a change with no defect
 * behind it.
 *
 * THAT LAST PARAGRAPH WAS FALSE, AND IT COST A PIPELINE
 * -----------------------------------------------------
 * The branch was `taskGoal !== jobGoal`, not "is this a step of a plan", and the
 * lane emits a sharpened `taskGoal` on plenty of single dispatches. So a
 * one-task job was told its rewritten goal is "the only thing you deliver",
 * that "later steps cover the rest" when none exist, and that the user's own
 * sentence is "NOT a description of what to hand back" — measured verbatim on
 * live chefAgent job task_827b8697. Anything the lane's rewrite dropped (a URL,
 * a venue name) was demoted to background in the same move.
 *
 * Now the branch asks the question it meant to ask (`ctx.planStep`, written by
 * the store when the step is created). A single task renders the job goal as the
 * mandate and keeps a supplied `taskGoal` as a focus note — nothing is silently
 * discarded, and nothing the user wrote is relabelled as background.
 */
function semanticPromptFor(ctx: WorkerContext): string {
  const jobGoal = ctx.jobGoal?.trim() || ctx.goal || 'Respond briefly.';
  const taskGoal = (ctx.taskGoal ?? ctx.goal).trim();
  if (!ctx.planStep) {
    const base = taskGoal && taskGoal !== jobGoal
      ? [
          jobGoal,
          '',
          'Focus for this attempt — a sharpening of the goal above, never a replacement',
          'for it. Everything the goal states still applies:',
          taskGoal,
        ].join('\n')
      : jobGoal;
    return ctx.instructions.length > 0
      ? `${base}\n\nAdditional instructions:\n${ctx.instructions.map((i) => `- ${i}`).join('\n')}`
      : base;
  }
  const base = taskGoal && taskGoal !== jobGoal
    ? [
        'YOUR TASK — this is what you deliver, and the only thing you deliver:',
        taskGoal,
        '',
        'Background — the larger job this step belongs to. Context for HOW to do your',
        'task well; NOT a description of what to hand back. Later steps cover the rest,',
        'and doing their part wastes the run and overwrites their work:',
        jobGoal,
        '',
        'If your task is to gather, read or analyse something, the findings themselves',
        'ARE the deliverable — report them as you found them, including exact figures,',
        'names and quotes. Do not improve, round or re-imagine them into the finished',
        'product; the step that owns that product needs your raw material intact.',
      ].join('\n')
    : jobGoal;
  const withInstructions = ctx.instructions.length > 0
    ? `${base}\n\nAdditional instructions:\n${ctx.instructions.map((i) => `- ${i}`).join('\n')}`
    : base;
  return withInstructions;
}

/**
 * The prompt the agent actually sees: the semantic task, then what the previous
 * step produced, then the operational contract.
 *
 * The upstream block is appended HERE and not inside `semanticPromptFor`, for
 * the same reason the headless contract is: `classificationPrompt` feeds depth
 * classification, and a step whose predecessor happened to return two kilobytes
 * would otherwise be classified as harder work than the identical step after a
 * terse one. What the task IS must not depend on how verbose its predecessor was.
 */
function promptFor(ctx: WorkerContext, contract?: string): RouteDecision['prompt'] {
  return [semanticPromptFor(ctx), upstreamBlock(ctx), contract]
    .filter((part) => part && part.length > 0)
    .join('\n\n');
}

/**
 * Skeleton router: sends every job to one default agent, using the job goal as
 * the prompt and returning a bounded-text result. Kept for fixtures and for a
 * mount that deliberately wants one target; `capabilityRoute` is what a real
 * deployment uses.
 */
export function singleAgentRoute(agentId: string, resultMode: ResultMode = 'bounded_text') {
  return (ctx: WorkerContext): RouteDecision => {
    const classificationPrompt = semanticPromptFor(ctx);
    return { agentId, prompt: classificationPrompt, classificationPrompt, resultMode };
  };
}

/**
 * Route by the capability frozen into the task's plan.
 *
 * The lane chose the specialist; this only resolves that choice against the
 * code-owned registry — a SECOND time, deliberately. The first check happened
 * when the decision was accepted, but the plan is durable and the process that
 * runs it may be minutes or a restart later, with a different allowlist or a
 * roster that no longer registers that agent. Re-resolving means a route is only
 * ever as valid as the registry at the moment of execution.
 *
 * An unresolvable capability FAILS the attempt (`null` → `no_route`) rather than
 * quietly falling back to the default. The job was planned for a specialist; a
 * silent substitution would produce a plausible answer from the wrong expert,
 * which is worse than a visible failure. A task with no capability at all is a
 * different case — that is "no preference", and the default is correct.
 */
export function capabilityRoute(opts: {
  resolve: (capability: string) => string | null;
  defaultAgentId: string;
  resultMode?: ResultMode;
  /**
   * What a finished run of this capability must produce. Supplying it turns on
   * the headless output contract — the instructions that tell an agent written
   * for conversation that this run has nobody to talk to, and that its final
   * message IS the result. Omitted, the prompt is exactly what it was before.
   */
  deliverableFor?: (capability: string | null) => string | undefined;
}) {
  const contractFor = (capability: string | null): string | undefined => (
    opts.deliverableFor
      ? buildHeadlessContract({
        deliverable: opts.deliverableFor(capability),
        // Read from the routing policy rather than from a second list here: the
        // same facts were hand-kept in two places once already, and one of them
        // was wrong about an agent for a whole stage.
        sideEffectProduct: capability !== null
          && SIDE_EFFECT_PRODUCT_CAPABILITIES.has(capability),
      })
      : undefined
  );
  return (ctx: WorkerContext): RouteDecision | null => {
    const resultMode = opts.resultMode ?? 'bounded_text';
    const classificationPrompt = semanticPromptFor(ctx);
    if (!ctx.capability) {
      return {
        agentId: opts.defaultAgentId,
        prompt: promptFor(ctx, contractFor(null)),
        classificationPrompt,
        resultMode,
      };
    }
    const agentId = opts.resolve(ctx.capability);
    if (!agentId) return null;
    return {
      agentId,
      prompt: promptFor(ctx, contractFor(ctx.capability)),
      classificationPrompt,
      resultMode,
    };
  };
}
