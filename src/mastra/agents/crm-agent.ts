import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { crmGetStatsTool } from '../tools/crm/crm-stats.js';
import { createLeadTool } from '../tools/crm/create-lead.js';
import { updateLeadTool } from '../tools/crm/update-lead.js';
import { updateStatusTool } from '../tools/crm/update-status.js';
import { addInteractionTool } from '../tools/crm/add-interaction.js';
import { recordEmailDraftTool } from '../tools/crm/record-email-draft.js';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const crmAgent = new Agent({
  id: 'crm-agent',
  name: 'CRM Specialist (Cloud)',
  instructions: await combinePrompts('crm/pipeline', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.crmAgent),
  defaultOptions: { maxSteps: 15, providerOptions: getThinkingProviderOptions('light') },
  defaultGenerateOptionsLegacy: { maxSteps: 15, providerOptions: getThinkingProviderOptions('light') },
  defaultStreamOptionsLegacy: { maxSteps: 15, providerOptions: getThinkingProviderOptions('light') },
  defaultNetworkOptions: { maxSteps: 15 },
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: 'crm-agent' }),
    createTokenLimiter(120_000),
  ],
  memory: new Memory({
    options: {
      lastMessages: 15,
    },
  }),
  tools: {
    searchLeadsTool,
    crmGetStatsTool,
    createLeadTool,
    updateLeadTool,
    updateStatusTool,
    addInteractionTool,
    recordEmailDraftTool,
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    runWorkerTool,
    runWorkerBatchTool,
    delegateTaskTool,
  },
});
