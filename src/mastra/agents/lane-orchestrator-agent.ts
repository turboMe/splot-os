/**
 * Lane Orchestrator (plan §4.2) — the agentic decision component inside the
 * Orchestration Service's deterministic boundary.
 *
 * TOOL-LESS BY CONSTRUCTION. §4.2 forbids this component from "bypassing the
 * queue and executing arbitrary domain tools". Rather than instructing it not
 * to, it is given none: its only output is a decision object, which the Service
 * validates and carries out. It also has no memory — §4.2 forbids keeping its
 * correctness "only in LLM working memory", and every activation re-reads
 * durable state instead.
 *
 * Reached through `runBoundedModelCall`, so the activation's own business cutoff
 * bounds it. One short structured question per activation, never a task loop.
 */
import { Agent } from '@mastra/core/agent';

import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const laneOrchestratorAgent = new Agent({
  id: 'lane-orchestrator',
  name: 'Lane Orchestrator',
  instructions: await loadPrompt('lane-orchestrator/base'),
  model: resolveModelId(agentModels.laneOrchestratorAgent),
  defaultOptions: { maxSteps: 5, providerOptions: getThinkingProviderOptions('none') },
  defaultGenerateOptionsLegacy: { maxSteps: 5, providerOptions: getThinkingProviderOptions('none') },
  defaultStreamOptionsLegacy: { maxSteps: 5, providerOptions: getThinkingProviderOptions('none') },
  defaultNetworkOptions: { maxSteps: 5 },
  // No tools, no memory — see the header.
});
