import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { Agent } from '@mastra/core/agent';
import { agentModels, resolveModelId } from '../config/model-manifest.js';
import { Memory } from '@mastra/memory';
import { updateStatusTool } from '../tools/crm/update-status.js';
import { addInteractionTool } from '../tools/crm/add-interaction.js';
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { crmGetStatsTool } from '../tools/crm/crm-stats.js';
import { createLeadTool } from '../tools/crm/create-lead.js';
import { updateLeadTool } from '../tools/crm/update-lead.js';
import { addContextTool } from '../tools/memory/add-context.js';
import {
  gmailManageDraftTool,
  calendarCreateEventTool,
  calendarFindEventTool,
} from '../tools/google/google-tools.js';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-lookup-tool.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { createTokenLimiter } from '../lib/token-limiter.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const salesAgent = new Agent({
  id: 'sales-agent',
  name: 'Sales Agent (Consultative Deal Architect)',
  instructions: await combinePrompts('sales/base', 'shared/skill-shelf'),
  model: resolveModelId(agentModels.salesAgent),
  defaultOptions: { maxSteps: 25, providerOptions: getThinkingProviderOptions('light') },
  defaultGenerateOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('light') },
  defaultStreamOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('light') },
  defaultNetworkOptions: { maxSteps: 25 },
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: 'sales-agent' }),
    createTokenLimiter(120_000),
  ],
  memory: new Memory({
    options: {
      lastMessages: 15,
    },
  }),
  tools: {
    // Delegation & worker tools
    runWorkerTool,
    runWorkerBatchTool,
    delegateTaskTool,
    // Artifacts
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    // Knowledge & Domain grounding
    knowledgeLookupTool,
    // CRM capabilities
    searchLeadsTool,
    crmGetStatsTool,
    createLeadTool,
    updateLeadTool,
    updateStatusTool,
    addInteractionTool,
    addContextTool,
    // Communication & Scheduling
    gmailManageDraftTool,
    calendarCreateEventTool,
    calendarFindEventTool,
  },
});
