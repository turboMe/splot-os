import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { n8nMcpClient, n8nMcpEnabled } from '../mcp.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { N8N_MCP_ENGINEER_MASTRA_AGENT_ID } from '../config/agent-ids.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';

const instructions = withAnthropicSystemCache(
  `${await loadPrompt('automation/n8n-mcp-engineer')}\n\n${await loadPrompt('shared/skill-shelf')}`,
);

const allowedN8nMcpToolNames = [
  'tools_documentation',
  'search_nodes',
  'get_node',
  'search_templates',
  'get_template',
  'validate_node',
  'validate_workflow',
];

const n8nMcpTools = await loadAllowedN8nMcpTools();

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const n8nMcpEngineer = new Agent({
  id: N8N_MCP_ENGINEER_MASTRA_AGENT_ID,
  name: 'n8n MCP Engineer',
  instructions,
  model: resolveModelId(agentModels.n8nMcpEngineer),
  maxRetries: 2,
  defaultOptions: { maxSteps: 24, providerOptions: getThinkingProviderOptions('none') },
  defaultGenerateOptionsLegacy: { maxSteps: 24, providerOptions: getThinkingProviderOptions('none') },
  defaultStreamOptionsLegacy: { maxSteps: 24, providerOptions: getThinkingProviderOptions('none') },
  defaultNetworkOptions: { maxSteps: 24 },
  memory: new Memory({
    options: {
      lastMessages: 24,
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
        template: `# n8n MCP Engineer Working Memory

## Runtime Topology
- Mastra API: http://localhost:4111
- n8n REST/UI: http://localhost:5678
- Ollama: http://localhost:11434
- MongoDB: localhost:27017/agentforge
- MCP mode: readonly

## Node Lessons
- reliable node typeVersions:
- common required parameters:
- validation pitfalls:

## Template Lessons
- useful templates:
- template IDs:
- attribution notes:

## Handoff State
- current request:
- selected template:
- node plan:
- validation status:
- open questions:

## Safety
- forbidden mutation tools: create/update/delete/activate/deploy_template/manage_credentials/autofix/test/executions
- credential assumptions:
- deployment must go through Automation Architect:
`,
      },
      generateTitle: {
        model: resolveModelId('gemma4-e4b'),
        instructions:
          'Generate a concise thread title for an n8n MCP discovery or validation task. Return only the title text, max 60 characters.',
      },
    },
  }),
  tools: {
    // Artifacts: this capability's product lands OUTSIDE the conversation, so the
    // headless contract tells it to leave a fetchable record behind. Instructing a
    // tool the agent does not own is how designAgent burned three rounds of work.
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    ...n8nMcpTools,
  },
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: N8N_MCP_ENGINEER_MASTRA_AGENT_ID }),
    createTokenLimiter(80_000),
  ],
});

async function loadAllowedN8nMcpTools(): Promise<Record<string, any>> {
  if (!n8nMcpEnabled) {
    return {};
  }

  // WS-E — load from the DEDICATED n8n-mcp client with a bounded retry. Standalone
  // n8n-mcp lists its 7 tools in ~0.6s, so one retry absorbs a transient first-spawn
  // hiccup without hanging startup. If it STILL returns empty we log LOUDLY (error,
  // not warn): the engineer must never silently pretend to validate. WS-F is the
  // hard guarantee — the delegation contract rejects any handoff that made no real
  // MCP tool call.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const toolsets = await n8nMcpClient.listToolsets();
      const tools = (toolsets['n8n-mcp'] ?? {}) as Record<string, any>;
      const picked = pickTools(tools, allowedN8nMcpToolNames);
      if (Object.keys(picked).length > 0) return picked;
      console.error(`[n8nMcpEngineer] n8n-mcp returned 0 allowed tools (attempt ${attempt}/2).`);
    } catch (error) {
      console.error(`[n8nMcpEngineer] n8n-mcp listToolsets failed (attempt ${attempt}/2):`, (error as Error).message);
    }
  }
  console.error(
    '[n8nMcpEngineer] n8n MCP tools UNAVAILABLE after retries — engineer has NO discovery/validation tools. '
    + 'Delegations will be rejected as n8n_mcp_handoff_no_real_tool_use until MCP is restored.',
  );
  return {};
}

function pickTools<T extends Record<string, any>>(tools: T, names: string[]): Record<string, any> {
  return Object.fromEntries(
    names
      .map((name) => [name, tools[name]])
      .filter(([, tool]) => Boolean(tool))
      .map(([name, tool]) => [
        name,
        prepareN8nMcpTool(name, tool),
      ]),
  );
}

function prepareN8nMcpTool(name: string, tool: any): any {
  const prepared = tool && typeof tool === 'object'
    ? { ...tool, id: name }
    : tool;

  if (name !== 'validate_workflow' || !prepared || typeof prepared.execute !== 'function') {
    return prepared;
  }

  const execute = prepared.execute.bind(prepared);
  return {
    ...prepared,
    execute: async (...args: any[]) => {
      if (getValidateWorkflowMode() !== 'live') {
        return {
          ok: false,
          tool: 'validate_workflow',
          validationStatus: 'mcp_validate_workflow_advisory',
          error: 'n8n_mcp_validate_workflow_advisory_mode',
          message: 'Live n8n-mcp validate_workflow is disabled because the installed n8n-mcp version can emit output that violates its declared MCP schema.',
          findings: [
            'Use search_nodes, get_node, and validate_node evidence for node/typeVersion/config guidance.',
            'Automation Architect must run architect_validate_workflow and the Golden Path validator before deploy or activation.',
          ],
        };
      }

      try {
        return await execute(...args);
      } catch (error) {
        if (!isN8nValidateWorkflowSchemaMismatch(error)) {
          throw error;
        }

        const message = sanitizeErrorMessage(error);
        return {
          ok: false,
          tool: 'validate_workflow',
          validationStatus: 'mcp_output_schema_mismatch',
          error: 'n8n_mcp_validate_workflow_schema_mismatch',
          message,
          findings: [
            'n8n-mcp validate_workflow returned structured error details that do not match its declared MCP output schema.',
            'Treat this workflow as not fully MCP-validated by n8n-mcp.',
            'Use search_nodes, get_node, validate_node, and Automation Architect Golden Path validation before any deploy or activation.',
          ],
        };
      }
    },
  };
}

function getValidateWorkflowMode(): 'advisory' | 'live' {
  return process.env.N8N_MCP_VALIDATE_WORKFLOW_MODE === 'live' ? 'live' : 'advisory';
}

function isN8nValidateWorkflowSchemaMismatch(error: unknown): boolean {
  const message = sanitizeErrorMessage(error);
  return /Structured content does not match the tool's output schema/i.test(message)
    && /errors\/\d+\/details must be string/i.test(message);
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
}
