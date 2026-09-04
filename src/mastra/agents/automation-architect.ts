import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { AUTOMATION_ARCHITECT_MASTRA_AGENT_ID } from '../config/agent-ids.js';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { Memory } from '@mastra/memory';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import {
  n8nTriggerWebhookTool,
  n8nHealthTool,
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
} from '../tools/n8n/n8n-tools.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { checkPendingUpdatesTool } from '../tools/system/check-pending-updates.js';
import { bgTaskTool } from '../tools/dev/background-task-tool.js';
import { skillsSearchTool } from '../tools/architect/skills-search.js';
import { resolveCredentialsTool } from '../tools/architect/credentials/credential-tools.js';
import { executeAutomationRequestTool } from '../tools/architect/execute-request.js';
import {
  cancelAutomationJobTool,
  getAutomationJobTool,
  listAutomationJobsTool,
  markStaleAutomationJobsTool,
  startAutomationJobTool,
} from '../tools/architect/automation-jobs.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';
// System knowledge (harness upgrade — Sprint A)
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-tools.js';

import { automationPendingUpdatesProcessor } from '../processors/pending-updates.js';
import { automationDecisionOutputProcessor } from '../processors/automation-decision-output.js';
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const automationArchitect = new Agent({
  // Keep Mastra API/thread compatibility; runtime telemetry uses automationArchitect.
  id: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  name: 'Automation Architect',
  instructions: withAnthropicSystemCache(
    `${await loadPrompt('automation/base')}\n\n${await loadPrompt('shared/skill-shelf')}`,
  ),
  // Model comes from the manifest (`agentModels.automationArchitect`), today
  // deepseek-v4-flash with deepseek-v4-pro as first fallback — see the rationale
  // there. The older note here recommending gemini-2.5-pro was stale: that
  // caveat was about GEMINI flash emitting Python-style booleans, which says
  // nothing about the deepseek family.
  // maxRetries handles the occasional AGENT_STREAM_ERROR (finishReason="error"
  // with no payload) that shows up in long tool-call chains.
  model: resolveModelId(agentModels.automationArchitect),
  maxRetries: 3,
  defaultOptions: { maxSteps: 40, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('medium') },
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
        template: `# Automation Architect Working Memory

## Runtime Context
- **Topology**:
- **Last verified n8n status**:
- **Endpoint assumptions**:

## Active Automation Work
- **Current request**:
- **Selected pattern**:
- **Workflow IDs**:
- **Missing config or credentials**:

## Safety Decisions
- **Risk findings**:
- **Explicit activation/real-execution scope**:
- **Activation constraints**:

## Learned Patterns
- **Reliable n8n patterns**:
- **Known validation pitfalls**:
- **Repair notes**:
`,
      },
      generateTitle: {
        model: resolveModelId('gemma4-e4b'),
        instructions:
          'Generate a concise thread title in the user language. Return only the title text, max 60 characters.',
      },
    },
  }),
  tools: {
    // Artifact Store (Etap 3) — exchange documents by ref, not by paste
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    // Agent Board (Etap 2) — agents can discover and use each other
    agentBoardListTool,
    agentBoardGetTool,
    // One-call deterministic Golden Path (pattern, graph_spec, workflow_json, workflow_file)
    executeAutomationRequestTool,
    // Native durable Golden Path jobs
    startAutomationJobTool,
    getAutomationJobTool,
    listAutomationJobsTool,
    cancelAutomationJobTool,
    markStaleAutomationJobsTool,
    // n8n inspection and management
    n8nHealthTool,
    n8nListWorkflowsTool,
    n8nGetWorkflowTool,
    n8nTriggerWebhookTool,
    // Credential resolution
    resolveCredentialsTool,
    // Skills search
    skillsSearchTool,
    // Orchestration for bounded subtasks (delegating to n8nMcpEngineer for node discovery/validation)
    delegateTaskTool,
    runWorkerTool,
    runWorkerBatchTool,
    // Background task results
    checkPendingUpdatesTool,
    // System knowledge (harness upgrade — Sprint A)
    memoryRecallTool,
    memoryWriteTool,
    // Knowledge lookup for business integration specs & webhook schemas
    knowledgeLookupTool,
  },
  // Context window protection (prevents overflow in long Golden Path sessions)
  inputProcessors: [
    automationPendingUpdatesProcessor,
    createUnifiedCapabilityShelfProcessor({
      agentId: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
      additionalTools: {
        bgTaskTool,
      },
    }),
    // Effective limit for Gemini 2.5 Pro. special tokens disabled so <|endoftext|>
    // literals in scraped/automation content don't crash the input workflow.
    createTokenLimiter(120_000),
  ],
  outputProcessors: [automationDecisionOutputProcessor],
});
