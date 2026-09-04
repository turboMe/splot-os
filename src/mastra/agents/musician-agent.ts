import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { Memory } from '@mastra/memory';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { attachmentPersistProcessor } from '../processors/attachment-persist.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

import {
  musicCompilePromptSpecTool,
  musicGetProjectTool,
  musicListProjectsTool,
  musicRecordTakeTool,
  musicSetBriefTool,
  musicSetProjectStatusTool,
  musicStartProjectTool,
  musicUpsertTrackTool,
  musicWriteLyricsTool,
} from '../tools/music/music-project-tools.js';
import {
  musicCheckGenerationRunTool,
  musicCheckSafetyTool,
  musicLintPromptTool,
} from '../tools/music/music-validators.js';
import {
  musicLoadReferenceTool,
  musicSearchReferenceTool,
} from '../tools/music/music-reference-tools.js';
import {
  musicAppendGenerationRunTool,
  musicListGenerationRunsTool,
} from '../tools/music/music-ledger.js';
import { musicGenerateTool } from '../tools/music/music-generate.js';

import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { addContextTool } from '../tools/memory/add-context.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const musicianAgent = new Agent({
  id: 'musician-agent',
  name: 'Musician Agent',
  instructions: await combinePrompts('music/domain', 'music/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.musicianAgent),
  defaultOptions: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 150, providerOptions: getThinkingProviderOptions('medium') },
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
    attachmentPersistProcessor,
    createUnifiedCapabilityShelfProcessor({ agentId: 'musician-agent' }),
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
    // Music project state, brief, lyrics, style, and prompts
    musicStartProjectTool,
    musicGetProjectTool,
    musicListProjectsTool,
    musicSetProjectStatusTool,
    musicSetBriefTool,
    musicWriteLyricsTool,
    musicUpsertTrackTool,
    musicCompilePromptSpecTool,
    musicRecordTakeTool,
    // Music reference corpus
    musicLoadReferenceTool,
    musicSearchReferenceTool,
    // Validators and ledgers
    musicLintPromptTool,
    musicCheckSafetyTool,
    musicCheckGenerationRunTool,
    musicAppendGenerationRunTool,
    musicListGenerationRunsTool,
    // Paid generation
    musicGenerateTool,
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
