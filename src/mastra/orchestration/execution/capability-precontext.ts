/**
 * Domain precontext for a V2 capability run.
 *
 * WHY THIS EXISTS
 * ---------------
 * Legacy is not one path but three, and they do not give an agent the same
 * thing. Most agents go through a bare `agent.generate`; a few go through a
 * DEDICATED harness that also builds a domain precontext — a compact block of
 * the operational facts that agent cannot work without.
 *
 * V2 gave every capability the same generic harness: depth, reflector, step
 * ceiling, liveness, tool envelopes, attempt budget. That is an upgrade for the
 * generic agents and a REGRESSION for the four with a dedicated harness, because
 * `harness-agent-caller` passed no `contextBuilder` at all. For
 * `automationArchitect` the loss is concrete: without its precontext a run does
 * not know which credentials exist, which patterns have already worked, or which
 * failures have already been diagnosed — so it would design against a system it
 * cannot see, on an engine whose whole promise is "same or better".
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a second copy of the wiring. Each entry hands back the SAME object
 * the legacy harness spreads, so the two cannot drift apart. The registry only
 * answers "does this capability have one, and where does it live".
 *
 * Imports are deferred to call time on purpose: the automation modules pull the
 * legacy Mongo client at load, and the V2 mount's module graph is kept free of
 * it — the same deferral `harness-agent-caller` already uses for the artifact
 * store.
 */
import type { HarnessGenerateInput } from '../../services/generate-with-harness.js';

/**
 * The precontext-related slice of a harness call.
 *
 * `repoPath` is part of it because for `codingAgent` the precontext is not built
 * from the prompt alone: `buildCodingPrecontext` reads the repository map and the
 * task checkpoint through it, and without one it records `repoPath_missing` and
 * returns half the sections. Every legacy call site passes it explicitly; V2 has
 * no call site, so it travels with the registry entry.
 */
export type CapabilityPrecontextFields = Pick<
  HarnessGenerateInput,
  'precontextFeatureFlag' | 'precontextFeature' | 'precontextDefaultEnabled' | 'contextBuilder' | 'repoPath'
>;

/**
 * Capabilities whose legacy path builds a domain precontext.
 *
 * Each entry is added WITH that agent's canary, never ahead of it: a registry
 * entry that has never run is a claim, not a capability.
 */
const LOADERS: Record<string, () => Promise<CapabilityPrecontextFields>> = {
  automationArchitect: async () => {
    const { automationPrecontextFields } = await import('../../services/automation-harness.js');
    return automationPrecontextFields;
  },
  knowledgeAgent: async () => {
    const { knowledgePrecontextFields } = await import('../../services/knowledge-harness.js');
    return knowledgePrecontextFields;
  },
  codingAgent: async () => {
    const { codingPrecontextFields } = await import('../../services/coding-harness.js');
    return codingPrecontextFields;
  },
  // The reviewer runs as its OWN V2 task (proven live: codingAgent →
  // codeReviewAgent), and V2 never calls `generateReview`, so it was reviewing
  // from the brief alone — no diff, no changed files, no verification signals,
  // no earlier review notes. Nothing said so; the review simply had less to go on.
  codeReviewAgent: async () => {
    const { reviewPrecontextFields } = await import('../../services/review-harness.js');
    return reviewPrecontextFields;
  },
  // Same generic reviewer harness as codeReviewAgent (`buildReviewPrecontext`
  // keys off the runtime `agentId`, not a hardcoded reviewer) — legacy already
  // gives these two the same precontext, so V2 must not give them less.
  securityReviewAgent: async () => {
    const { reviewPrecontextFields } = await import('../../services/review-harness.js');
    return reviewPrecontextFields;
  },
  performanceReviewAgent: async () => {
    const { reviewPrecontextFields } = await import('../../services/review-harness.js');
    return reviewPrecontextFields;
  },
};

/** Capability ids that have a domain precontext (for audits and gates). */
export const CAPABILITIES_WITH_PRECONTEXT = Object.keys(LOADERS);

/**
 * The precontext fields for a capability, or `{}` when it has none.
 *
 * Returning an empty object rather than `undefined` keeps the call site a plain
 * spread: a capability without a precontext must produce a harness call byte-for
 * byte identical to the one it made before this file existed.
 */
export async function precontextForCapability(
  agentId: string,
): Promise<CapabilityPrecontextFields | Record<string, never>> {
  const load = LOADERS[agentId];
  if (!load) return {};
  try {
    return await load();
  } catch (error) {
    // A precontext that cannot be built must not fail an otherwise valid run —
    // it degrades the run to what V2 did before, which is still a working turn.
    // Said out loud, because a silently missing precontext looks exactly like an
    // agent that suddenly got worse at its job.
    console.warn(
      `[orch-v2] precontext for ${agentId} could not be loaded — the run continues WITHOUT it: `
      + `${(error as Error).message}`,
    );
    return {};
  }
}
