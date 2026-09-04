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
  filmCompilePromptSpecTool,
  filmGetCanonTool,
  filmGetProjectTool,
  filmListProjectsTool,
  filmRecordTakeTool,
  filmSetProjectStatusTool,
  filmStartProjectTool,
  filmUpsertClipTool,
} from '../tools/film/film-project-tools.js';
import {
  filmLoadReferenceTool,
  filmSearchReferenceTool,
} from '../tools/film/film-reference-tools.js';
import {
  filmCheckContinuityTool,
  filmCheckGenerationRunTool,
  filmCheckProjectStateTool,
  filmCheckSequenceEvalTool,
  filmCheckSourcesTool,
  filmLintPromptTool,
} from '../tools/film/film-validators.js';
import {
  filmAppendGenerationRunTool,
  filmListGenerationRunsTool,
} from '../tools/film/film-ledger.js';
import { filmGenerateTool } from '../tools/film/film-generate.js';
import { designGenerateImageTool } from '../tools/design/design-tools.js';

import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { currentTimeTool } from '../tools/system/current-time.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { addContextTool } from '../tools/memory/add-context.js';
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

import { videoTools } from '../tools/video/index.js';


export const filmmakerAgent = new Agent({
  id: 'filmmaker-agent',
  name: 'Filmmaker Agent',
  instructions: await combinePrompts('film/domain', 'film/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.filmmakerAgent),
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
    createUnifiedCapabilityShelfProcessor({ agentId: 'filmmaker-agent' }),
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
    // Film project state, canon, and prompts
    filmStartProjectTool,
    filmGetProjectTool,
    filmListProjectsTool,
    filmSetProjectStatusTool,
    filmUpsertClipTool,
    filmRecordTakeTool,
    filmGetCanonTool,
    filmCompilePromptSpecTool,
    // Seedance reference corpus
    filmLoadReferenceTool,
    filmSearchReferenceTool,
    // Validators and ledgers
    filmLintPromptTool,
    filmCheckProjectStateTool,
    filmCheckContinuityTool,
    filmCheckSourcesTool,
    filmCheckGenerationRunTool,
    filmCheckSequenceEvalTool,
    filmAppendGenerationRunTool,
    filmListGenerationRunsTool,
    // Paid generation and reference-frame creation
    filmGenerateTool,
    designGenerateImageTool,
    // Video YouTube Production Engine tools (SPLOT OS)
    ...videoTools,
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

