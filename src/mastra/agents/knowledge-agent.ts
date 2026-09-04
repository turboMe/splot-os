/**
 * Knowledge Agent — Dedicated NotebookLM operations agent.
 *
 * Purpose:
 *   Encapsulates ALL NotebookLM interactions (create, source add, query,
 *   research, studio, cleanup) into a single reusable agent that can be
 *   called by meta-agent, marketing workflows, or any orchestrator.
 *
 * Tools:
 *   - Core MCP tools from NotebookLM server (always visible)
 *   - Remaining NotebookLM MCP tools via ToolSearchProcessor
 *   - skill_search + skill_load for on-demand retrieval of NLM procedures
 *
 * Prompt Architecture (token-efficient):
 *   System prompt = ONLY the concise role definition (~66 lines):
 *     - Role, responsibilities, operational rules, known notebooks
 *     - Instruction to use skill_search for detailed procedures
 *   Full SKILL.md documentation is NOT in system prompt. Instead:
 *     - Split into semantic skills in _skills/knowledge/
 *     - Indexed by SkillRegistry with embeddings
 *     - Agent retrieves relevant sections on-demand via skill_search → skill_load
 *
 * Design decisions:
 *   - Separate from search/browser agents — handles ONLY NLM operations
 *   - Token-efficient: ~66 line prompt + on-demand skills vs ~776 lines always
 *   - Model controlled via agentModels.knowledgeAgent in model-manifest.ts
 *   - Has Memory — tracks notebook aliases, active research, source state,
 *     and operational NotebookLM lessons by thread.
 */

import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { Memory } from '@mastra/memory';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { mcpClient } from '../mcp.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';

import { knowledgePendingUpdatesProcessor } from '../processors/pending-updates.js';
import { knowledgeBootstrapTool } from '../tools/knowledge/bootstrap-tool.js';

const knowledgeInstructions = withAnthropicSystemCache(
  `${await loadPrompt('knowledge/notebooklm-agent')}\n\n${await loadPrompt('shared/skill-shelf')}`,
);

// Get only NotebookLM MCP toolsets (exclude playwright, firecrawl)
const mcpToolsets = await mcpClient.listToolsets();
const nlmTools = (mcpToolsets['notebooklm'] ?? {}) as Record<string, any>;
const alwaysVisibleNlmToolNames = ['server_info', 'refresh_auth', 'notebook_list'];
const alwaysVisibleNlmTools = pickTools(nlmTools, alwaysVisibleNlmToolNames);
const discoverableNlmTools = aliasToolIdsToLocalNames(omitTools(nlmTools, alwaysVisibleNlmToolNames));

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const knowledgeAgent = new Agent({
  id: 'knowledge-agent',
  name: 'Knowledge Agent (NotebookLM)',
  instructions: knowledgeInstructions,
  model: resolveModelId(agentModels.knowledgeAgent),
  maxRetries: 2,
  defaultOptions: { maxSteps: 40, providerOptions: getThinkingProviderOptions('light') },
  defaultGenerateOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('light') },
  defaultStreamOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('light') },
  defaultNetworkOptions: { maxSteps: 40 },
  memory: new Memory({
    options: {
      lastMessages: 30,
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
      workingMemory: {
        enabled: true,
        template: `# Knowledge Agent Working Memory

## NotebookLM Runtime
- Active account:
- Last MCP/auth status:
- Known MCP limitations:
- MCP param convention: snake_case (e.g. notebook_id, source_id) — use the EXACT param names from the loaded tool schema, never camelCase.

## Notebook Aliases
- alias -> notebook_id -> title -> purpose

## Active Research
- taskId:
- notebook_id:
- status:
- next check:

## Source State
- recently added sources:
- indexing status:
- source failures:

## Operational Lessons
- reliable tool sequences:
- known failure modes:
- user preferences:
`,
      },
      generateTitle: {
        model: resolveModelId('gemma4-e4b'),
        instructions:
          'Generate a concise thread title for a NotebookLM task. Return only the title text, max 60 characters.',
      },
    },
  }),
  tools: {
    // Artifact Store (Etap 3) — exchange documents by ref, not by paste
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    // Always-visible NotebookLM MCP tools.
    ...alwaysVisibleNlmTools,
    knowledgeBootstrapTool,
    runWorkerBatchTool,
    system_run_worker_batch: runWorkerBatchTool,
    system_memory_recall: memoryRecallTool,
    system_memory_write_observation: memoryWriteTool,
  },
  inputProcessors: [
    knowledgePendingUpdatesProcessor,
    createUnifiedCapabilityShelfProcessor({
      agentId: 'knowledge-agent',
      additionalTools: discoverableNlmTools,
    }),
    // special tokens disabled so <|endoftext|> literals in scraped content don't crash it.
    createTokenLimiter(120_000),
  ],
});

function pickTools<T extends Record<string, any>>(tools: T, names: string[]): Record<string, any> {
  return Object.fromEntries(
    names
      .map((name) => [name, tools[name]])
      .filter(([, tool]) => Boolean(tool)),
  );
}

function omitTools<T extends Record<string, any>>(tools: T, omittedNames: string[]): Record<string, any> {
  const omitted = new Set(omittedNames);
  return Object.fromEntries(
    Object.entries(tools).filter(([name, tool]) => !omitted.has(name) && Boolean(tool)),
  );
}

function aliasToolIdsToLocalNames<T extends Record<string, any>>(tools: T): Record<string, any> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      tool && typeof tool === 'object'
        ? { ...tool, id: name }
        : tool,
    ]),
  );
}
