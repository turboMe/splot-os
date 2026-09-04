/**
 * Capability → agent routing for durable orchestration V2 (plan Fala 6-8).
 *
 * Until now the V2 worker sent EVERY job to one fixed agent
 * (`singleAgentRoute`), so the lane could decide *whether* to dispatch but never
 * *to whom*. This module is the missing half: the closed set of specialists a
 * lane may name, and the resolution of a name to a registered agent.
 *
 * TWO PROPERTIES CARRY THE WHOLE DESIGN
 * -------------------------------------
 * 1. **One roster, not a second one.** The vocabulary is the Agent Board — the
 *    existing single source of truth for "who can do what", already drift-checked
 *    against `index.ts` registration and already used by legacy delegation. A
 *    parallel capability vocabulary would be a second list to keep in sync, and
 *    the first thing to silently rot. So a capability name IS a board id.
 *
 * 2. **The set is closed and code-owned.** A model proposes a capability; this
 *    registry decides whether such a thing exists. A name that is not in
 *    `entries` resolves to `null` — never to a "closest match", never to a
 *    default silently. That is what keeps `dispatch.capability` from being an
 *    authority field: the model can only pick from a menu this code wrote, and
 *    the same registry is consulted again at dispatch time.
 *
 * WHY AN ALLOWLIST RATHER THAN THE WHOLE BOARD
 * --------------------------------------------
 * The V2 flags are live, so a mis-route is not hypothetical. Board agents differ
 * enormously in what a wrong guess costs: a wrong `analyticsAgent` wastes tokens,
 * a wrong `musicianAgent` spends real money on generation, a wrong
 * `automationArchitect` deploys an n8n workflow. The default set is therefore the
 * agents whose worst case is a wasted run, and widening it is a deliberate
 * operator action (`ORCHESTRATION_V2_CAPABILITIES`), not a code change.
 */
import { agentBoard, type AgentCard } from './agent-board.js';
import { canonicalizeRuntimeAgentId } from './agent-ids.js';
import type { ProgressiveAttemptPolicy } from '../orchestration/contracts/execution-budget.js';

export type { ProgressiveAttemptPolicy } from '../orchestration/contracts/execution-budget.js';

export interface CapabilityEntry {
  /** The name a lane may use. Identical to the Agent Board id — see header. */
  capability: string;
  /** The Mastra registry id to run. Identity today; the seam exists for aliases. */
  agentId: string;
  /** One line for the decision prompt. */
  summary: string;
  /** A couple of "use for" hints, kept short — the prompt is a menu, not a manual. */
  useFor: string[];
  /** What this capability is NOT for — the half the router used to be denied. */
  avoidFor: string[];
  /**
   * What the capability expects to be handed, verbatim from the board card.
   *
   * Present on all 21 cards, and it is where an agent says how it wants to be
   * ENGAGED rather than what it does — `chefAgent` reads "Brief OR restaurant URL
   * …; chefAgent runs recon→profile→menu→recipes autonomously". A planner that
   * cannot see this has no way to tell a capability that owns a pipeline from one
   * that needs the work pre-chewed.
   */
  inputContract: string;
  /**
   * Non-negotiables from the card. Sparse on purpose — 4 of 21 cards carry any —
   * so this costs nothing where it is empty and speaks exactly where it matters.
   *
   * This is the field whose absence was measured: `chefAgent`'s card says "Menu/
   * restaurant tasks are ALWAYS one chefAgent delegation" and the lane, which
   * never saw it, split a menu job into research → chef. The research it ordered
   * was generic prose, while chef's own recon would have ordered the Mission A
   * JSON contract its `chef_import_website_profile` mapper is built to read — so
   * the split did not merely duplicate the step, it produced a result chef had no
   * way to consume.
   */
  hardRules: string[];
  /**
   * Capabilities this one delegates to inside its own run (board card
   * `runsInternally`). Carried as DATA rather than folded into the menu text: the
   * words persuade the planner, this lets the lane repair a plan that ignored
   * them. See `AgentCard.runsInternally` for the failure it was measured against.
   */
  runsInternally: string[];
  /**
   * Board `internal`: this capability is reached by the domain that owns it, not
   * by a planner choosing from the menu. Kept on the entry (rather than only on
   * the card) so `forDecider` can drop it while `resolve`, budgets and idle
   * floors keep working for whatever legitimately runs it.
   */
  internal: boolean;
  /**
   * What a finished run of this capability is supposed to produce, taken from the
   * board card's `outputArtifacts`. Used by the headless output contract to tell
   * the agent what its final message must BE — see
   * `orchestration/execution/headless-contract.ts`.
   */
  deliverable: string;
  /**
   * How long one attempt at this capability may run, derived from the board
   * card's `latencyClass`.
   *
   * One constant for every specialist was not a simplification, it was a bug:
   * the V2 window measured 296s and `chefAgent` (`latencyClass: long` — recon →
   * profile → menu → recipes) was cut before producing ANY text, so every
   * attempt failed empty and the job ended FAILED. A worker's budget has to
   * follow what the work actually is.
   */
  attemptCapMs: number;
  /**
   * Optional earned-time policy. `attemptCapMs` remains the immutable absolute
   * ceiling frozen into the task; this policy decides how much of that ceiling a
   * worker has earned so far from distinct, meaningful progress milestones.
   */
  progressiveAttempt?: ProgressiveAttemptPolicy;
  /** Floor under the liveness idle window for this capability. */
  idleFloorMs: number;
}

/**
 * Attempt windows per `latencyClass`. Deliberately coarse: three honest classes
 * the board already maintains beat a per-agent number nobody would keep current.
 */
export const ATTEMPT_CAP_BY_LATENCY: Record<string, number> = {
  seconds: 120_000,
  minutes: 300_000,
  // Raised 900s → 1800s on 2026-08-12, from measurement, by owner decision.
  //
  // The seven-agent sieve run cut two agents that were demonstrably WORKING:
  //
  //     contentAgent        29 events, longest silence  85.5s → cut by the clock
  //     deliberationAgent   39 events, longest silence 134.7s → cut by the clock
  //
  // Liveness called both alive the whole way; only this wall clock ended them.
  // `deliberationAgent` is the clearest case: its Design Council spawns six
  // role-bound workers across proposal → critique → synthesis phases, so a real
  // debate is inherently long rather than stuck.
  //
  // An `extended` profile was proposed once before and REJECTED for lack of
  // evidence, and that rejection was right at the time: the objection was that a
  // longer clock only delays noticing a hang, because a clock cannot tell work
  // from a stall. Liveness now makes that distinction — silence is cut at the
  // idle floor (480s for this class) regardless of the window. So the wall clock
  // is no longer the thing detecting hangs; it is a COST ceiling, and its size is
  // an economic choice rather than a safety one.
  long: 1_800_000,
};

/** Matches the store's own default, for capabilities with no card. */
export const DEFAULT_ATTEMPT_CAP_MS = 300_000;

/**
 * The attempt window for one agent, straight off its board card.
 *
 * Exists so a caller OUTSIDE the V2 registry (the repo-maintenance review step)
 * can ask the same question the registry asks, instead of carrying its own
 * literal. That literal was 180_000 — below what a review measurably takes, and
 * the direct cause of a recorded `Harness LLM call timed out after 180s`.
 *
 * Falls back to the store default for an unknown id, so a caller can never be
 * handed `undefined` and quietly lose its bound.
 */
export function reviewAttemptCapMs(agentId: string | undefined | null): number {
  // Callers hand us the RUNTIME id (`code-review-agent`), the board is keyed by
  // the registry id (`codeReviewAgent`). Without canonicalising, every lookup
  // misses and silently returns the 300s default — the exact bug this helper
  // exists to remove, reintroduced one layer down.
  const boardId = canonicalizeRuntimeAgentId(agentId) ?? agentId ?? '';
  // `canonicalizeRuntimeAgentId` carries alias lists for SOME agents only —
  // `code-review-agent` resolves, `security-review-agent` and
  // `performance-review-agent` do not. Extending those lists would touch the
  // identity used by delegation guards, so the kebab→camel fallback lives here,
  // where the worst case is a budget lookup.
  const card = agentBoard[boardId as keyof typeof agentBoard]
    ?? agentBoard[boardId.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()) as keyof typeof agentBoard];
  return ATTEMPT_CAP_BY_LATENCY[(card as AgentCard | undefined)?.latencyClass ?? '']
    ?? DEFAULT_ATTEMPT_CAP_MS;
}

/**
 * Long-form writing is the first measured consumer of earned attempt time.
 *
 * A live five-chapter run made durable manuscript progress throughout its
 * 15-minute attempt, but was cut before chronicler/critic/reader/polisher. A flat
 * 45-minute timeout would hide hangs for too long. Instead Writer begins with the
 * measured 15-minute window and earns six bounded five-minute extensions only
 * from unique DB-persisted manuscript snapshots. The production composition
 * installs this policy only with the harness caller that can observe trusted
 * tool results; the bare profile falls back to the fixed initial 15 minutes.
 */
export const PROGRESSIVE_ATTEMPT_BY_CAPABILITY: Readonly<Record<string, ProgressiveAttemptPolicy>> = {
  writerAgent: {
    initialWindowMs: 900_000,
    extensionMs: 300_000,
    // Do not bank six extensions in an early burst. A new durable checkpoint
    // earns time only after the current window has entered its final eight
    // minutes; the next extension then moves it back outside this band.
    extensionLeadMs: 480_000,
    maxCapMs: 2_700_000,
    maxExtensions: 6,
  },
};

/**
 * Floors under the liveness IDLE window, per `latencyClass`.
 *
 * Liveness cuts a run for silence, and silence is measured between EVENTS —
 * step boundaries and tool returns, never per token. So an agent that emits a
 * whole document as one tool argument is "silent" for the length of that
 * generation, and the heavier the deliverable the longer that is.
 *
 * The numbers are floors the depth profile may exceed but not undercut, and they
 * are set from measurement rather than intuition. One job per enabled capability,
 * `[Harness] activity gaps`, longest silence while WORKING:
 *
 *     chefAgent          230.0s   ← the one that sets the class
 *     contentAgent       147.2s
 *     deliberationAgent  144.5s
 *     designAgent         99.7s
 *     writerAgent         28.1s
 *     crmAgent            12.2s
 *     researcherAgent      2.2s
 *     analyticsAgent       2.1s
 *
 * The first draft put `long` at 240s, which chef came within 4% of — a margin
 * that is not a margin. Doubling the worst observed case gives room for a slower
 * day without making a hang meaningfully cheaper to detect, because the two
 * errors do not cost the same: too generous merely delays noticing a stall, too
 * tight destroys work in progress and looks exactly like a stall while doing it.
 *
 * Still provisional. Widen further as more samples land.
 */
export const IDLE_FLOOR_BY_LATENCY: Record<string, number> = {
  seconds: 60_000,
  minutes: 120_000,
  long: 480_000,
};

/** Floor for a capability with no card — the middle class, not the smallest. */
export const DEFAULT_IDLE_FLOOR_MS = 120_000;

export interface CapabilityRegistry {
  entries: CapabilityEntry[];
  /** The agent id for a capability, or `null` if the name is not in the closed set. */
  resolve(capability: string): string | null;
  /**
   * The menu as data, in the shape `LaneDecisionContext.capabilities` takes.
   * Rendering belongs to the prompt (`lane-decider.ts`); this module owns the
   * facts. One list, so what is offered and what is accepted cannot diverge.
   */
  forDecider(): Array<{ name: string; description: string; runsInternally?: string[] }>;
  /** What a finished run of this capability must produce; empty when unknown. */
  deliverableFor(capability: string | null): string | undefined;
  /** How long one attempt at this capability may run. */
  attemptCapMsFor(capability: string | null): number | undefined;
  /** Earned-time policy for a capability, when one has been explicitly calibrated. */
  progressiveAttemptPolicyFor(capability: string | null): ProgressiveAttemptPolicy | undefined;
  /** Shortest idle window this capability may be held to (liveness floor). */
  idleFloorMsFor(capability: string | null): number | undefined;
  /** Where work goes when the lane names nothing (operator config, not model input). */
  defaultCapability: string;
}

/**
 * The capabilities enabled by default.
 *
 * Chosen by blast radius, not by usefulness: every one of these produces text or
 * a document and can be thrown away if the route was wrong. Excluded by default
 * are the agents that spend money (`designAgent`, `filmmakerAgent`,
 * `musicianAgent`), write to the outside world (`marketingAgent`, `salesAgent`,
 * `huntAgent`), change the system (`automationArchitect`, `n8nMcpEngineer`,
 * `capabilitySmith`) or the repository (`codingAgent`).
 *
 * `knowledgeAgent` was listed here as an outward writer and that was wrong —
 * checked against its registered toolset, all eight of its tools are reads,
 * memory, skills and the artifact store. Its worst case is a wasted run, the same
 * as `researcherAgent`, which is already the default route. Kept out of the
 * DEFAULT set only because enabling a capability is an operator decision backed
 * by a canary, not a comment correction.
 *
 * None of that is a limit of the router — it routes to whatever is enabled. It is
 * the answer to "what happens the first time the classifier is wrong in
 * production", which with the flags on is a question with a real answer.
 */
/**
 * Capabilities whose PRODUCT is an effect in the outside world, not prose.
 *
 * These runs deploy a workflow, send a mail, write a row, touch a repository.
 * The engine judges a `bounded_text` run by the text it ends with, and for these
 * agents that measures the wrong thing — measured on the automationArchitect
 * canary: the run really did deploy `Mastra - Webhook Email Validator` to n8n
 * (verified through the n8n API, not the agent's own reply) and was still marked
 * FAILED with `empty_output`, because its last text was the harness's own scoring
 * report. The job then re-ran a task whose product already existed, which for an
 * agent with side effects is how the same action happens twice.
 *
 * So they are told to leave something the engine can read: an artifact, recorded
 * at the moment of writing. That is deliberately not a relaxation of "no false
 * success" (§3.6) — a run with no product still fails; the point is that the
 * product must exist where the engine looks.
 *
 * Kept HERE, next to the routing policy it belongs to, because the same facts
 * were already hand-maintained in `audit-agent-readiness.ts` and had been wrong
 * once (it called `crmAgent` an outward writer while its card says "read-only").
 * One statement of a policy, imported by everything that needs it.
 */
export const SIDE_EFFECT_PRODUCT_CAPABILITIES: ReadonlySet<string> = new Set([
  'automationArchitect',
  'n8nMcpEngineer',
  'capabilitySmith',
  'codingAgent',
  'marketingAgent',
  'salesAgent',
  'huntAgent',
]);

export const DEFAULT_V2_CAPABILITIES: readonly string[] = [
  'researcherAgent',
  'chefAgent',
  'contentAgent',
  'writerAgent',
  'analyticsAgent',
  'deliberationAgent',
  'crmAgent',
];

/** `*` = every board id. Empty/absent = the conservative default set. */
export function parseCapabilityAllowlist(raw: string | undefined): readonly string[] | '*' {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_V2_CAPABILITIES;
  if (trimmed === '*') return '*';
  return trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Keep the menu bounded: it is prepended to every planning decision. */
const MAX_USE_FOR = 3;
/**
 * The router was shown what each specialist is FOR and never what it is NOT for.
 *
 * Measured twice on the marketing canary: a job that asked to look up a lead AND
 * write an interaction AND draft a mail AND book a meeting went to `crmAgent`,
 * whose card says in its first line "Quick lead lookup only, read-only CRM" and
 * in `whenNotToUse` "CRM writes → salesAgent". The card was right; the router
 * simply never saw that second line. Two attempts then died against crmAgent's
 * 120s window before a third returned a plan.
 *
 * The boundary is the part that disambiguates, so it travels with the menu.
 */
const MAX_AVOID_FOR = 2;

function toEntry(capability: string, card: AgentCard | undefined): CapabilityEntry {
  const progressiveAttempt = PROGRESSIVE_ATTEMPT_BY_CAPABILITY[capability];
  return {
    capability,
    agentId: capability,
    summary: card?.oneLiner ?? 'General-purpose work.',
    useFor: (card?.whenToUse ?? []).slice(0, MAX_USE_FOR),
    avoidFor: (card?.whenNotToUse ?? []).slice(0, MAX_AVOID_FOR),
    inputContract: card?.inputContract ?? '',
    hardRules: card?.hardRules ?? [],
    runsInternally: card?.runsInternally ?? [],
    internal: card?.internal === true,
    deliverable: (card?.outputArtifacts ?? []).join(', '),
    attemptCapMs:
      progressiveAttempt?.maxCapMs
      ?? ATTEMPT_CAP_BY_LATENCY[card?.latencyClass ?? '']
      ?? DEFAULT_ATTEMPT_CAP_MS,
    ...(progressiveAttempt ? { progressiveAttempt } : {}),
    idleFloorMs: IDLE_FLOOR_BY_LATENCY[card?.latencyClass ?? ''] ?? DEFAULT_IDLE_FLOOR_MS,
  };
}

export interface BuildCapabilityRegistryOptions {
  /** Names to enable, or `*` for the whole board. Unknown names are dropped. */
  allow?: readonly string[] | '*';
  /**
   * Whether an agent is actually resolvable in this process. A capability whose
   * agent is not registered must never reach the menu: the lane would name it,
   * the worker would fail `agent_not_found`, and the job would burn an attempt
   * proving something this code already knew.
   */
  isAvailable?: (agentId: string) => boolean;
  /**
   * Fallback target. Operator configuration, so it is always present in the
   * registry even when the allowlist does not mention it — otherwise a narrow
   * allowlist would leave a job with nowhere to go.
   */
  defaultAgentId: string;
}

export function buildCapabilityRegistry(opts: BuildCapabilityRegistryOptions): CapabilityRegistry {
  const allow = opts.allow ?? DEFAULT_V2_CAPABILITIES;
  const available = opts.isAvailable ?? (() => true);
  const names = allow === '*' ? Object.keys(agentBoard) : allow;

  const seen = new Set<string>();
  const entries: CapabilityEntry[] = [];
  for (const name of [opts.defaultAgentId, ...names]) {
    if (seen.has(name)) continue;
    seen.add(name);
    // The default is exempt from the board check (an operator may point it at
    // any registered agent) but NOT from the availability check.
    if (name !== opts.defaultAgentId && !(name in agentBoard)) continue;
    if (!available(name)) continue;
    entries.push(toEntry(name, agentBoard[name]));
  }

  const byName = new Map(entries.map((e) => [e.capability, e.agentId]));
  return {
    entries,
    resolve: (capability) => byName.get(capability) ?? null,
    attemptCapMsFor: (capability) => entries
      .find((e) => e.capability === (capability ?? opts.defaultAgentId))?.attemptCapMs,
    progressiveAttemptPolicyFor: (capability) => entries
      .find((e) => e.capability === (capability ?? opts.defaultAgentId))?.progressiveAttempt,
    idleFloorMsFor: (capability) => entries
      .find((e) => e.capability === (capability ?? opts.defaultAgentId))?.idleFloorMs,
    deliverableFor: (capability) => {
      const entry = entries.find((e) => e.capability === (capability ?? opts.defaultAgentId));
      return entry?.deliverable ? entry.deliverable : undefined;
    },
    // The menu was a LOSSY projection of the board, and the loss decided a run.
    //
    // `chefAgent`'s card states three times that a menu job is one delegation and
    // that chef runs its own recon; none of those live in `oneLiner`/`whenToUse`/
    // `whenNotToUse`, so the lane never saw them and split a menu job into
    // research → chef. Cost, measured: the generic research it ordered came back
    // as prose, chef's `chef_import_website_profile` mapper only reads the Mission
    // A JSON its OWN recon brief asks for, so the material was unusable and chef
    // improvised for 30 minutes and timed out with nothing.
    //
    // Input contract and hard rules are the two fields where a card says how it
    // must be ENGAGED rather than what it does. Adding them costs +38% of menu
    // length (6.9k → 9.5k chars, measured over all 21 cards) and `hardRules` is
    // empty on 17 of them, so the cost lands almost entirely where it buys
    // something.
    // `runsInternally` rides along as DATA and is deliberately NOT rendered into
    // `description`: the menu is already 8.3k chars, and the planner does not
    // need to be told a second time what `hardRules` says in words. Its consumer
    // is `repairPlanOwnership`, which fixes the plans the words did not prevent.
    //
    // `internal` cards are RESOLVABLE but never OFFERED. The Agent Board marks
    // the three reviewers internal because a reviewer is reached through the
    // coding domain's own review step, not by a planner picking it off a menu —
    // `check:coding-domain` asserts that flag, and the legacy delegation path
    // honours it. The V2 registry did not: it read the board without ever
    // looking at `internal`, and the operator allowlist names all three, so the
    // lane could route a user request straight to `securityReviewAgent`. That
    // guarantee has to hold on the engine that actually carries production
    // traffic, not only on the one it replaced.
    //
    // Filtered HERE rather than in `entries` on purpose: dispatch, budgets and
    // idle floors must keep working for an internal agent that something
    // legitimately runs. Only the planner's menu loses them.
    forDecider: () => entries.filter((e) => !e.internal).map((e) => ({
      name: e.capability,
      description: [
        e.summary,
        e.useFor.length > 0 ? `Use for: ${e.useFor.join('; ')}.` : '',
        e.avoidFor.length > 0 ? `NOT for: ${e.avoidFor.join('; ')}.` : '',
        e.inputContract ? `Input: ${e.inputContract}` : '',
        e.hardRules.length > 0 ? `HARD RULES: ${e.hardRules.join(' ')}` : '',
      ].filter(Boolean).join(' '),
      ...(e.runsInternally.length > 0 ? { runsInternally: [...e.runsInternally] } : {}),
    })),
    defaultCapability: opts.defaultAgentId,
  };
}
