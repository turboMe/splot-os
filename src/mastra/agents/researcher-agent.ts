/**
 * Researcher Agent — Standalone web research agent (PSEV strategy).
 *
 * Purpose:
 *   Autonomous deep web research using the Plan-Search-Extract-Verify loop.
 *   Can be called directly from the UI or by orchestrating agents.
 *
 * Tools:
 *   - searchWebTool / findCompanyLinksTool — Tavily web search
 *   - tavilyExtractTool — full-page content extraction (fast deep-read path)
 *   - Playwright MCP toolset — browser navigation and scraping
 *   - skillSearchTool / skillLoadTool — on-demand research procedures
 *
 * Prompt:
 *   Loaded from prompts/shared/subagent-researcher.md
 */

import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { Memory } from '@mastra/memory';
import { mcpClient } from '../mcp.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { searchWebTool, findCompanyLinksTool, tavilyExtractTool } from '../tools/search/tavily.js';
import { writeExternalProjectFileTool } from '../tools/dev/external-projects-tools.js';
import { writeFileTool } from '../tools/terminal/terminal-tools.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-lookup-tool.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { wrapPlaywrightToolsWithPolicy } from '../services/browser-tool-policy-wrapper.js';

const researcherInstructions = `${await loadPrompt('shared/subagent-researcher')}\n\n${await loadPrompt('shared/skill-shelf')}`;

// Defensywnie: nie pozwól żeby padły MCP serwery (np. notebooklm/Chrome) zablokowały start agenta.
// Researcher i tak ma użyteczny baseline (Tavily + skill tools); playwright/firecrawl to bonus.
let playwrightTools: Record<string, any> = {};
let firecrawlTools: Record<string, any> = {};
try {
  const mcpToolsets = await mcpClient.listToolsets();
  // Wrapped BEFORE it ever reaches `tools:` — raw MCP tools bypass
  // withToolEnvelope entirely, so gating happens here or not at all.
  playwrightTools = wrapPlaywrightToolsWithPolicy(mcpToolsets['playwright'] ?? {});
  firecrawlTools = mcpToolsets['firecrawl'] ?? {};
} catch (err) {
  console.warn('[researcher-agent] MCP listToolsets failed — startuję bez playwright/firecrawl:', (err as Error).message);
}

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const researcherAgent = new Agent({
  id: 'researcher-agent',
  name: 'Researcher Agent (PSEV)',
  instructions: researcherInstructions,
  model: resolveModelId(agentModels.researcherAgent),
  defaultOptions: { maxSteps: 50, providerOptions: getThinkingProviderOptions('light') },
  defaultGenerateOptionsLegacy: { maxSteps: 50, providerOptions: getThinkingProviderOptions('light') },
  defaultStreamOptionsLegacy: { maxSteps: 50, providerOptions: getThinkingProviderOptions('light') },
  defaultNetworkOptions: { maxSteps: 50 },
  // Researcher was previously stateless ("No memory configured" on every delegation). The PSEV loop
  // can run up to 50 steps per delegation and orchestrators (huntAgent) pass a thread/resource through
  // delegate_task — without Memory the running summary was dropped and a multi-step research thread
  // could not retain its own earlier findings. Thread-scoped memory mirrors chef/content/hunt so the
  // research keeps its plan + verified facts in context as the step count grows.
  memory: new Memory({
    options: {
      lastMessages: 20,
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread',
        temporalMarkers: true,
        observation: {
          messageTokens: 50000,
          threadTitle: true,
          providerOptions: {
            google: {
              thinkingConfig: {
                thinkingBudget: 1024,
              },
            },
          },
        },
        reflection: {
          observationTokens: 60000,
        },
      },
      generateTitle: true,
    },
  }),
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: 'researcher-agent' }),
  ],
  tools: {
    // Artifact Store (Etap 3) — exchange documents by ref, not by paste
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    writeExternalProjectFileTool,
    writeFileTool,
    // Read-only CRM lookup. The researcher decides what enters a qualified-jobs
    // payload, so "have we already written to this address?" has to be
    // answerable HERE — otherwise the same offer is handed downstream every day
    // and the ledger's application_status stays a guess.
    searchLeadsTool,
    searchWebTool,
    findCompanyLinksTool,
    tavilyExtractTool,
    requestApprovalTool,
    system_request_approval: requestApprovalTool,
    runWorkerBatchTool,
    system_run_worker_batch: runWorkerBatchTool,
    knowledgeLookupTool,
    ...playwrightTools,
    ...firecrawlTools,
  },
});
