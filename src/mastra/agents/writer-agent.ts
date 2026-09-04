import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { Memory } from '@mastra/memory';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

import {
  writerAddNoteTool,
  writerAddSourcesTool,
  writerAnalyzeStyleSampleTool,
  writerAuditSlopTool,
  writerGetContinuityTool,
  writerGetProjectTool,
  writerListAuditsTool,
  writerListClaimsTool,
  writerListProjectsTool,
  writerListSectionsTool,
  writerListSourcesTool,
  writerSaveAuditTool,
  writerSearchNotesTool,
  writerSetProjectStatusTool,
  writerStartProjectTool,
  writerUpdateContinuityTool,
  writerUpdateStyleProfileTool,
  writerUpsertClaimsTool,
  writerUpsertSectionTool,
  writerValidateContinuityTool,
  writerVerifyClaimsTool,
} from '../tools/writer/writer-tools.js';

import {
  writerDocumentExportTool,
  writerDocumentInitTool,
  writerDocumentReadTool,
  writerDocumentSnapshotTool,
  writerDocumentWriteSectionTool,
} from '../tools/writer/writer-document-tools.js';

import {
  writerIngestResearchResultTool,
  writerPrepareResearchDelegationTool,
  writerPrepareWorkerReviewTool,
  writerQualityGateTool,
  writerRevisionDecisionTool,
} from '../tools/writer/writer-workflow-tools.js';

import {
  voiceStudioRenderAudiobookTool,
  voiceStudioFreeVramTool,
  voiceStudioGetStatusTool,
} from '../tools/writer/voicestudio-tools.js';

import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { addContextTool } from '../tools/memory/add-context.js';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-lookup-tool.js';
import { consultingPublishArticleTool } from '../tools/content/consulting-publisher-tool.js';
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const writerAgent = new Agent({
  id: 'writer-agent',
  name: 'Writer Agent',
  instructions: await combinePrompts('writer/domain', 'writer/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.writerAgent),
  defaultOptions: { maxSteps: 150, providerOptions: getThinkingProviderOptions('light') },
  defaultGenerateOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('light') },
  defaultStreamOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('light') },
  defaultNetworkOptions: { maxSteps: 150 },
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
    createUnifiedCapabilityShelfProcessor({ agentId: 'writer-agent' }),
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
    // Writer project state
    writerStartProjectTool,
    writerGetProjectTool,
    writerListProjectsTool,
    writerSetProjectStatusTool,
    writerUpdateStyleProfileTool,
    writerAnalyzeStyleSampleTool,
    writerUpsertSectionTool,
    writerListSectionsTool,
    // Fiction continuity
    writerUpdateContinuityTool,
    writerGetContinuityTool,
    writerValidateContinuityTool,
    // Factual writing ledgers
    writerAddSourcesTool,
    writerListSourcesTool,
    writerUpsertClaimsTool,
    writerListClaimsTool,
    writerVerifyClaimsTool,
    // Quality/audit/notes
    writerAuditSlopTool,
    writerSaveAuditTool,
    writerListAuditsTool,
    writerAddNoteTool,
    writerSearchNotesTool,
    // Incremental manuscript files
    writerDocumentInitTool,
    writerDocumentWriteSectionTool,
    writerDocumentReadTool,
    writerDocumentSnapshotTool,
    writerDocumentExportTool,
    // Research, worker review, and revision workflow helpers
    writerPrepareResearchDelegationTool,
    writerIngestResearchResultTool,
    writerPrepareWorkerReviewTool,
    writerQualityGateTool,
    writerRevisionDecisionTool,
    // System / memory
    runWorkerTool,
    runWorkerBatchTool,
    delegateTaskTool,
    requestApprovalTool,
    currentTimeTool,
    memoryRecallTool,
    memoryWriteTool,
    addContextTool,
    knowledgeLookupTool,
    consultingPublishArticleTool,
    // VoiceStudio (OmniVoice) Audio Generation & VRAM Management
    voiceStudioRenderAudiobookTool,
    voiceStudioFreeVramTool,
    voiceStudioGetStatusTool,
  },
});
