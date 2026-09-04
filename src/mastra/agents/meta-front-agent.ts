/**
 * Meta Front — the fast, non-blocking conversational layer over durable jobs
 * (master plan §4.1, `front_only` class).
 *
 * WHY THIS IS A SEPARATE AGENT (and not `metaAgent` narrowed down)
 * ---------------------------------------------------------------
 * The target model in the plan's migration table is `metaAgent` itself becoming
 * `front_only`: "small command/query toolset, conversation memory, no long
 * tools". That is the destination, but it cannot be the first step. `metaAgent`
 * today carries ~90 tools including every long/mutating one, and production
 * still runs on the LEGACY delegation path (no V2 flag is set anywhere). Turning
 * it into a front today would strip the delegation the live system depends on.
 *
 * So this is the front as a separate, flag-gated agent: it can be exercised and
 * canaried while `metaAgent` keeps working untouched. Collapsing the two — the
 * actual `metaAgent → front_only` cutover — belongs with the Wave 5 legacy
 * consolidation, not here.
 *
 * THE DEFINING CONSTRAINT: this agent must never be able to block.
 * Its entire toolset is the durable-job command/query surface. There is no
 * shell, no git, no n8n, no browser, no media generation, no delegation, no raw
 * database access — not as policy text in the prompt, but structurally, by not
 * giving it those tools. Long work becomes a durable job; the orchestration lane
 * (a separate role, not an agent) picks it up and drives it.
 */
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { durableJobTools } from '../tools/system/orchestration-job-tools.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const metaFrontAgent = new Agent({
  id: 'meta-front',
  name: 'Meta Front',
  instructions: await loadPrompt('meta-front/base'),
  model: resolveModelId(agentModels.metaFrontAgent),
  defaultOptions: { maxSteps: 10, providerOptions: getThinkingProviderOptions('none') },
  defaultGenerateOptionsLegacy: { maxSteps: 10, providerOptions: getThinkingProviderOptions('none') },
  defaultStreamOptionsLegacy: { maxSteps: 10, providerOptions: getThinkingProviderOptions('none') },
  defaultNetworkOptions: { maxSteps: 10 },

  // Conversation memory only. The front is the single logical author of the
  // user's conversation (§"one logical writer per conversation"); it must NOT
  // accumulate job/domain state — that lives durably in the substrate, and is
  // re-read through the tools rather than remembered.
  memory: new Memory({
    options: {
      lastMessages: 20,
      generateTitle: true,
    },
  }),

  // The complete toolset: ten durable-job commands, always on. Small and
  // deterministic on purpose (§4.1) — no discoverable pool, because a front
  // that has to search for its tools is a front that stalls.
  tools: { ...durableJobTools },
});
