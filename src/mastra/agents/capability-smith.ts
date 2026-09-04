/**
 * Capability Smith (Etap 7 — IDEALSYSTEMMASTERPLAN §4, blueprint CGP).
 *
 * Owner of the Capability Gap Protocol: when an agent hits "no tool for X",
 * this agent finds an existing MCP server (registry search → isolated sandbox
 * trial → human approval → attach) or drives the BUILD path (spec → codingAgent
 * on a worktree → existing checks + autoheal promote).
 *
 * Standard model (plan): the work is orchestration + judgment, not volume.
 */
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';
import { mcpDiscoverTool } from '../tools/system/mcp-discover.js';
import {
  capabilitySandboxTool,
  capabilityRequestAttachTool,
  capabilityAttachTool,
  capabilityListTool,
  capabilityInvokeTool,
  capabilityBuildTool,
  capabilityBuildStatusTool,
} from '../tools/system/capability-tools.js';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const capabilitySmith: Agent = new Agent({
  id: 'capability-smith',
  name: 'Capability Smith',
  instructions: withAnthropicSystemCache(
    `${await loadPrompt('capability/base')}\n\n${await loadPrompt('shared/skill-shelf')}`,
  ),
  model: resolveModelId(agentModels.capabilitySmith),
  defaultOptions: { maxSteps: 24, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 24, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 24, providerOptions: getThinkingProviderOptions('medium') },
  defaultNetworkOptions: { maxSteps: 24 },
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: 'capability-smith' }),
  ],
  tools: {
    // CGP surface
    mcpDiscoverTool,
    capabilitySandboxTool,
    capabilityRequestAttachTool,
    capabilityAttachTool,
    capabilityListTool,
    capabilityInvokeTool,
    // Search existing before building (protocol step 2)
    agentBoardListTool,
    agentBoardGetTool,
    // Artifacts (spec/decision memos — Etap 3 contracts)
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    // BUILD path + approvals
    delegateTaskTool,
    capabilityBuildTool,
    capabilityBuildStatusTool,
    requestApprovalTool,
    // System knowledge
    memoryRecallTool,
    memoryWriteTool,
  },
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
        },
        reflection: {
          observationTokens: 60000,
        },
      },
      generateTitle: true,
    },
  }),
});
