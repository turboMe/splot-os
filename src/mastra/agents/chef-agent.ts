import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { Memory } from '@mastra/memory';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

// ── Chef domain tools (16) ──
import {
  chefStartProjectTool,
  chefUpdateProfileTool,
  chefGenerateMenuTool,
  chefDraftRecipeTool,
  chefSearchRecipeLibraryTool,
  chefGetProjectTool,
  chefListProjectsTool,
  chefSaveMenuTool,
  chefGetMenuTool,
  chefIterateMenuTool,
  chefGetRecipeTool,
  chefQueryKnowledgeTool,
  chefSuggestPairingTool,
  chefScorePairingTool,
  chefSuggestPairingsTool,
  chefCheckSeasonalTool,
  chefAddNoteTool,
  chefSearchNotesTool,
  chefExportMenuTool,
  chefExportMenuBookTool,
  chefImportWebsiteProfileTool,
  chefSetProjectStatusTool,
} from '../tools/chef/chef-tools.js';
import { isFlavorPairingEnabled } from '../config/chef-flags.js';

// ── Menu Book document tools ──
import {
  chefDocumentInitTool,
  chefDocumentWriteSectionTool,
  chefDocumentStatusTool,
  chefDocumentRenderTool,
  chefDocumentPdfTool,
} from '../tools/chef/chef-document-tools.js';

// ── Recon / research ──
import { reviewsGooglePlaceTool } from '../tools/research/reviews-google-place.js';
import {
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeLookupTool,
} from '../tools/knowledge/knowledge-tools.js';
import { consultingFormsApiTool } from '../tools/content/consulting-forms-api.js';

// ── System / memory ──
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { addContextTool } from '../tools/memory/add-context.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const chefAgent = new Agent({
  id: 'chef-agent',
  name: 'Chef Agent',
  instructions: await combinePrompts('chef/domain', 'chef/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.chefAgent),
  // The Menu Book pipeline chains many tool calls per turn (recon delegations +
  // section writes + status transitions). Without an explicit budget the agent
  // runs at the framework default (~5 steps) and stalls mid-pipeline (e.g. after
  // recon, at profile_synthesis), needing user nudges. Mirror the 40-step budget
  // every other pipeline agent (meta/coding/knowledge/automation/deliberation) uses.
  defaultOptions: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultNetworkOptions: { maxSteps: 150 },
  memory: new Memory({
    options: {
      lastMessages: 20,
      // Parity with codingAgent: the chef pipeline is long (recon → profile → menu →
      // recipes for ~10 dishes) and spans many turns, so a per-thread running summary
      // keeps earlier decisions (profile, recon insights, approvals) in context once the
      // conversation grows past lastMessages. Model is the local gemma4-e4b summariser.
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread', // isolate context between separate chef chats
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
  // Context-window protection for long autonomous pipeline runs (chef's
  // gemini-3.1-flash-lite-preview has a large window, but perf degrades past ~120K).
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: 'chef-agent' }),
    // special tokens disabled so scraped recon content containing <|endoftext|>
    // literals is counted as plain text instead of crashing the input workflow.
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
    // Chef domain
    chefStartProjectTool,
    chefUpdateProfileTool,
    chefGenerateMenuTool,
    chefDraftRecipeTool,
    chefSearchRecipeLibraryTool,
    chefGetProjectTool,
    chefListProjectsTool,
    chefSaveMenuTool,
    chefGetMenuTool,
    chefIterateMenuTool,
    chefGetRecipeTool,
    chefQueryKnowledgeTool,
    chefSuggestPairingTool,
    // Molecular flavor-pairing tools (FlavorDB) — registered only when the A/B flag is ON
    // (CHEF_FLAVOR_PAIRING_ENABLED). Read once at module load; flip env + restart to compare.
    ...(isFlavorPairingEnabled()
      ? { chefScorePairingTool, chefSuggestPairingsTool }
      : {}),
    chefCheckSeasonalTool,
    chefAddNoteTool,
    chefSearchNotesTool,
    chefExportMenuTool,
    // Menu Book (incremental document)
    chefDocumentInitTool,
    chefDocumentWriteSectionTool,
    chefDocumentStatusTool,
    chefDocumentRenderTool,
    chefDocumentPdfTool,
    chefExportMenuBookTool,
    // Pipeline (E2): recon synthesis + state machine
    chefImportWebsiteProfileTool,
    chefSetProjectStatusTool,
    // Recon / knowledge
    reviewsGooglePlaceTool,
    knowledgeQueryTool,
    knowledgeQueryMultiTool,
    knowledgeLookupTool,
    // Consulting Forms API (menu audits)
    consultingFormsApiTool,
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
