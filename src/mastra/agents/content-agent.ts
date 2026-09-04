import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { Memory } from '@mastra/memory';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

// ── Content pipeline state-machine tools ──
import {
  contentStartProjectTool,
  contentGetProjectTool,
  contentListProjectsTool,
  contentSetProjectStatusTool,
} from '../tools/content/content-state-tools.js';

// ── Knowledge (content-strategy = HOW to write; docs = WHAT is true) ──
import {
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeLookupTool,
} from '../tools/knowledge/knowledge-tools.js';

// ── Phase 1: research + strategy ──
import { contentFetchSignalsTool } from '../tools/content/content-signals-tools.js';
import { contentQueryStrategyTool } from '../tools/content/content-strategy-tools.js';

// ── Phase 1: Content Pack (external-memory document) ──
import {
  contentDocumentInitTool,
  contentDocumentWriteSectionTool,
  contentDocumentStatusTool,
  contentDocumentRenderTool,
} from '../tools/content/content-document-tools.js';

// ── Phase 1: quality gate + ship ──
import { contentQualityCheckTool } from '../tools/content/content-quality-tools.js';
import {
  contentSaveDraftTool,
  contentScheduleTool,
} from '../tools/content/content-draft-tools.js';
import { consultingPublishArticleTool } from '../tools/content/consulting-publisher-tool.js';

// ── Phase 2: learning loop ──
import {
  contentAddNoteTool,
  contentSearchNotesTool,
} from '../tools/content/content-notes-tools.js';

// ── Phase 3: curated exemplar library (differentiator) ──
import {
  contentSearchExemplarsTool,
  contentAddExemplarTool,
} from '../tools/content/content-exemplar-tools.js';

// ── System / memory ──
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { addContextTool } from '../tools/memory/add-context.js';

// Modeled 1:1 on chefAgent (see agents/chef-agent.ts): the quality moat is the
// architecture — expert rubric prompt (content/domain) + state machine
// (content/pipeline) + always-on business frame (content/business) — not the model.
// Phase 0 registered the state-machine + knowledge + delegation primitives.
// Phase 1 added the core E2E toolset: fresh-signal research, content-strategy
// queries, the Content Pack (incremental external memory), the deterministic
// quality gate, draft persistence (with real observability), and scheduling.
// Phase 2 adds the learning loop (content notes) so quality compounds across runs.
// Phase 3 adds the curated exemplar library (swipe file + voice corpus) — gold judged
// by hand, never auto-ingested from model output, so the bar can only rise.
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const contentAgent = new Agent({
  id: 'content-agent',
  name: 'Content Agent',
  instructions: await combinePrompts('content/domain', 'content/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.contentAgent),
  // The content pipeline chains many tool calls per turn (signals + strategy +
  // per-platform drafts + critique + section writes + status transitions). Without
  // an explicit budget the agent runs at the framework default (~5 steps) and stalls
  // mid-pipeline. Mirror the 150-step budget chefAgent uses.
  defaultOptions: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultNetworkOptions: { maxSteps: 150 },
  memory: new Memory({
    options: {
      lastMessages: 20,
      // Parity with chefAgent: the content pipeline spans many turns, so a per-thread
      // running summary keeps earlier decisions (brief, strategy calendar, approvals)
      // in context once the conversation grows past lastMessages.
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread', // isolate context between separate content chats
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
    createUnifiedCapabilityShelfProcessor({ agentId: 'content-agent' }),
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
    // Content pipeline state machine
    contentStartProjectTool,
    contentGetProjectTool,
    contentListProjectsTool,
    contentSetProjectStatusTool,
    // Knowledge (content-strategy + docs + market backups + local grounding)
    knowledgeQueryTool,
    knowledgeQueryMultiTool,
    knowledgeLookupTool,
    // Research + strategy grounding
    contentFetchSignalsTool,
    contentQueryStrategyTool,
    // Content Pack (incremental external memory)
    contentDocumentInitTool,
    contentDocumentWriteSectionTool,
    contentDocumentStatusTool,
    contentDocumentRenderTool,
    // Quality gate + ship
    contentQualityCheckTool,
    contentSaveDraftTool,
    contentScheduleTool,
    consultingPublishArticleTool,
    // Learning loop (cross-project knowledge)
    contentAddNoteTool,
    contentSearchNotesTool,
    // Curated exemplar library (swipe file + Patryk's voice corpus)
    contentSearchExemplarsTool,
    contentAddExemplarTool,
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
