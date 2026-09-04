/**
 * Adapt any Mastra `Agent` into a `ModelCaller` for the Execution Gateway.
 *
 * This is the migration seam: a registered agent becomes a V2 worker by wrapping
 * its `generate()`. The gateway's budget-derived AbortSignal is forwarded to the
 * agent (Mastra passes it to the model — the path GAP-MODEL-ABORT-01 validated).
 * The agent's text output is validated by the A boundary exactly like any other
 * producer (structured envelope → ok; prose → invalid_result), so a prose agent
 * fails honestly rather than reporting a false success.
 *
 * A structural type is used so this module does not hard-depend on @mastra/core;
 * any object with a compatible `generate` works.
 */
import type { ModelCaller } from './gateway.js';

export interface GeneratingAgent {
  generate(
    prompt: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ text?: string }>;
}

export function createMastraAgentCaller(agent: GeneratingAgent): ModelCaller {
  return async ({ prompt, signal }) => {
    // Intentional bare call. This is the MINIMAL seam: the gateway supplies the
    // only governance here (deadline + abort race), which is what the
    // deterministic fixtures want. It is deliberately NOT the profile for a real
    // migrated capability — that is `createHarnessAgentCaller`
    // (./harness-agent-caller.ts), injected via
    // `createRegistryWorker({ makeCaller })` under
    // FEATURE_ORCHESTRATION_V2_HARNESS_WORKER. Using this one for a production
    // agent silently drops depth/reflector/liveness/pending-message handling.
    const res = await agent.generate(prompt, { abortSignal: signal }); // @harness-exempt
    return { text: typeof res.text === 'string' ? res.text : '' };
  };
}
