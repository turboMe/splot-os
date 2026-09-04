import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

// ── Design domain tools ──
import {
  designAddMusicTool,
  designConvertFormatsTool,
  designExportPdfTool,
  designExportPptxTool,
  designFetchBrandAssetsTool,
  designFetchImagesTool,
  designGenThumbsTool,
  designGenerateImageTool,
  designNarratePipelineTool,
  designRenderVideoSeekTool,
  designRenderVideoTool,
  designTtsTool,
  designVerifyTool,
} from '../tools/design/design-tools.js';
import { designWriteDeliverableTool } from '../tools/design/design-document-tools.js';
import {
  comfyuiGenerateImageTool,
  comfyuiStatusTool,
  comfyuiFreeVramTool,
} from '../tools/design/comfyui-tools.js';

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

export const designAgent = new Agent({
  id: 'design-agent',
  name: 'Design Agent',
  instructions: await combinePrompts('design/domain', 'design/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.designAgent),
  // Design runs can chain research, worker variants, asset acquisition, visual QA,
  // and export steps. Match the broad autonomous budget used by chef/content.
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
    createUnifiedCapabilityShelfProcessor({ agentId: 'design-agent' }),
    createTokenLimiter(120_000),
  ],
  tools: {
    // Deliverable persistence — the render/export tools below all consume a path
    // that only this tool can create.
    designWriteDeliverableTool,
    // Design assets and generation
    designFetchImagesTool,
    designFetchBrandAssetsTool,
    designGenerateImageTool,
    // ComfyUI Local Visual Studio
    comfyuiGenerateImageTool,
    comfyuiStatusTool,
    comfyuiFreeVramTool,
    // Visual QA
    designVerifyTool,
    // Video/deck export stack
    designRenderVideoTool,
    designRenderVideoSeekTool,
    designConvertFormatsTool,
    designAddMusicTool,
    designExportPptxTool,
    designExportPdfTool,
    designGenThumbsTool,
    // Voiceover
    designTtsTool,
    designNarratePipelineTool,
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
