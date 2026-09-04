import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { Memory } from '@mastra/memory';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

// ── Deterministic quality gates (Phase 0) + Market Pack resolver (Phase 1) ──
import { huntQualityTools } from '../tools/hunt/hunt-quality-tools.js';

// ── Pipeline state machine + Hunt Report document (Phase 2) ──
import { huntStateTools } from '../tools/hunt/hunt-state-tools.js';
import { huntDocumentTools } from '../tools/hunt/hunt-document-tools.js';

// ── CRM (read + write) ──
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { createLeadTool } from '../tools/crm/create-lead.js';
import { updateLeadTool } from '../tools/crm/update-lead.js';
import { updateStatusTool } from '../tools/crm/update-status.js';
import { addInteractionTool } from '../tools/crm/add-interaction.js';
import { recordEmailDraftTool } from '../tools/crm/record-email-draft.js';

// ── Gmail drafts (NO send tool — send is human-gated by design) ──
import {
  gmailSearchTool,
  gmailManageDraftTool,
} from '../tools/google/google-tools.js';

// ── Discovery (Tavily) + knowledge (NotebookLM) ──
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily.js';
import {
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeLookupTool,
} from '../tools/knowledge/knowledge-tools.js';

// ── System / memory ──
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { addContextTool } from '../tools/memory/add-context.js';

// Modeled 1:1 on chefAgent / contentAgent (see agents/chef-agent.ts): the quality moat is the
// ARCHITECTURE — an expert rubric prompt (hunt/domain) + a state machine (hunt/pipeline) + must-call
// deterministic gates (hunt_* quality tools) — not the model. The 6 "producer-hunt agents" were one
// agent differing only by model; this replaces them with a single chef-style conductor that delegates
// discovery to researcherAgent, deep research to knowledgeAgent/NotebookLM, and narrow sub-tasks to
// run_worker, while the deterministic gates own qualification + draft compliance.
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const huntAgent = new Agent({
  id: 'hunt-agent',
  name: 'Hunt Agent',
  instructions: await combinePrompts('hunt/domain', 'hunt/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.huntAgent),
  // The hunt pipeline chains many tool calls per turn (discovery delegation + per-lead score →
  // enrich → extract → draft → gate → CRM/Gmail). Without an explicit budget the agent runs at the
  // framework default (~5 steps) and stalls mid-pipeline. Mirror the 150-step budget chef/content use.
  defaultOptions: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultNetworkOptions: { maxSteps: 150 },
  memory: new Memory({
    options: {
      lastMessages: 20,
      // Parity with chef/content: the hunt pipeline spans many turns (a batch of leads, each through
      // score→enrich→draft), so a per-thread running summary keeps earlier decisions (HuntBrief,
      // market, approvals) in context once the conversation grows past lastMessages.
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread', // isolate context between separate hunt chats
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
  // Context-window protection for long autonomous pipeline runs.
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: 'hunt-agent' }),
    createTokenLimiter(120_000),
  ],
  tools: {
    // Artifact Store (Etap 3) — exchange documents by ref, not by paste
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    // Agent Board (Etap 2) — agents can discover and use each other
    agentBoardListTool,
    agentBoardGetTool,
    // Deterministic quality gates + Market Pack (the spine — must-call)
    ...huntQualityTools,
    // Pipeline state machine + Hunt Report (resumable external memory)
    ...huntStateTools,
    ...huntDocumentTools,
    // CRM
    searchLeadsTool,
    createLeadTool,
    updateLeadTool,
    updateStatusTool,
    addInteractionTool,
    recordEmailDraftTool,
    // Gmail drafts (no send)
    gmailSearchTool,
    gmailManageDraftTool,
    // Discovery + knowledge (NotebookLM & Local Grounding)
    searchWebTool,
    findCompanyLinksTool,
    knowledgeQueryTool,
    knowledgeQueryMultiTool,
    knowledgeLookupTool,
    // System / memory
    runWorkerTool,
    runWorkerBatchTool,
    delegateTaskTool,
    requestApprovalTool,
    currentTimeTool,
    memoryRecallTool,
    memoryWriteTool,
    addContextTool,
  },
});
