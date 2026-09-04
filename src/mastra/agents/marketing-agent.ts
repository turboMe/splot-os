import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { getThinkingProviderOptions } from '../config/thinking-budget.js';
import { updateStatusTool } from '../tools/crm/update-status.js';
import { addInteractionTool } from '../tools/crm/add-interaction.js';
import { searchLeadsTool } from '../tools/crm/search-leads.js';
import { createLeadTool } from '../tools/crm/create-lead.js';
import { updateLeadTool } from '../tools/crm/update-lead.js';
import { recordEmailDraftTool } from '../tools/crm/record-email-draft.js';
import { addContextTool, pushSignalTool } from '../tools/memory/add-context.js';
import {
  gmailSearchTool,
  gmailManageDraftTool,
  calendarCreateEventTool,
  driveUploadFileTool,
} from '../tools/google/google-tools.js';
import {
  rssGetArticlesTool,
  rssSearchArticlesTool,
  rssCreateDigestTool,
} from '../tools/rss/rss-tools.js';
import { searchWebTool, findCompanyLinksTool } from '../tools/search/tavily.js';
import {
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeListNotebooksTool,
  knowledgeCreateNotebookTool,
  knowledgeAddSourceTool,
  knowledgeDeleteNotebookTool,
  knowledgeResearchStartTool,
  knowledgeLookupTool,
} from '../tools/knowledge/knowledge-tools.js';
import {
  telegramSendMessageTool,
  telegramSendFileTool,
} from '../tools/communication/telegram.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { workflowModels } from '../config/workflow-models.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { consultingFormsApiTool } from '../tools/content/consulting-forms-api.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import {
  videoPackageMetadataTool,
  videoGenerateThumbnailTool,
  videoYoutubeUploadTool,
} from '../tools/video/index.js';




const marketingInstructions = `${await loadPrompt('marketing/base')}\n\n${await loadPrompt('shared/skill-shelf')}`;

const marketingTools = {
  // System delegation and worker support
  runWorkerTool,
  runWorkerBatchTool,
  delegateTaskTool,
  // Telegram communication & briefing
  telegramSendMessageTool,
  telegramSendFileTool,
  // Artifacts: this capability's product lands OUTSIDE the conversation, so the
  // headless contract tells it to leave a fetchable record behind. Instructing a
  // tool the agent does not own is how designAgent burned three rounds of work.
  artifactPutTool,
  artifactGetTool,
  artifactListTool,
  // CRM (read + write context)
  searchLeadsTool,
  createLeadTool,
  updateStatusTool,
  updateLeadTool,
  addInteractionTool,
  recordEmailDraftTool,
  // Gmail drafts & Drive
  gmailSearchTool,
  gmailManageDraftTool,
  driveUploadFileTool,
  // Calendar
  calendarCreateEventTool,
  // RSS intelligence
  rssGetArticlesTool,
  rssSearchArticlesTool,
  rssCreateDigestTool,
  // Shared memory
  addContextTool,
  pushSignalTool,
  // Search (Tavily)
  searchWebTool,
  findCompanyLinksTool,
  // Knowledge (NotebookLM & Grounding)
  knowledgeQueryTool,
  knowledgeQueryMultiTool,
  knowledgeListNotebooksTool,
  knowledgeCreateNotebookTool,
  knowledgeAddSourceTool,
  knowledgeDeleteNotebookTool,
  knowledgeResearchStartTool,
  knowledgeLookupTool,
  // Consulting Forms API (inbound leads & candidate applications)
  consultingFormsApiTool,
  // Video YouTube Packaging & Upload Tools (SPLOT OS)
  videoPackageMetadataTool,
  videoGenerateThumbnailTool,
  videoYoutubeUploadTool,
};


function createMarketingAgent(id: string, name: string, model: string): Agent {
  return new Agent({
    id,
    name,
    instructions: marketingInstructions,
    model,
    // TWENTY-THREE tools against Mastra's undeclared default of five steps —
    // the widest gap on the roster. A cold-email flow alone is find the lead,
    // read its history, draft, record the draft, log the interaction: past five
    // before it has done anything worth reporting.
    //
    // The declaration is per-agent rather than per-tool-count on purpose. 23
    // tools is the SURFACE this agent can reach, not the depth of one request;
    // 25 is chosen from the shape of a real flow plus headroom, and canaried
    // agents measured 3-7 steps in practice.
    // Do not leave the output ceiling implicit: OpenRouter otherwise reserves
    // the model maximum (65,536), which can exceed the key's remaining credit
    // allowance before the first token is generated. Email/CRM work needs tool
    // calls and a concise receipt, not a novel-length completion.
    defaultOptions: { maxSteps: 25, modelSettings: { maxOutputTokens: 8192 }, providerOptions: getThinkingProviderOptions('light') },
    defaultGenerateOptionsLegacy: { maxSteps: 25, maxTokens: 8192, providerOptions: getThinkingProviderOptions('light') },
    defaultStreamOptionsLegacy: { maxSteps: 25, maxTokens: 8192, providerOptions: getThinkingProviderOptions('light') },
    defaultNetworkOptions: { maxSteps: 25 },
    memory: new Memory({
      options: {
        lastMessages: 15,
      },
    }),
    inputProcessors: [
      createUnifiedCapabilityShelfProcessor({ agentId: id }),
    ],
    tools: marketingTools,
  });
}

export const marketingAgent = createMarketingAgent(
  'marketing-agent',
  'Marketing Agent',
  workflowModels.marketing.default,
);

export const weeklyContentResearchAgent = createMarketingAgent(
  'weekly-content-research-agent',
  'Weekly Content Research Agent',
  workflowModels.weeklyContent.research,
);

export const weeklyContentCopyAgent = createMarketingAgent(
  'weekly-content-copy-agent',
  'Weekly Content Copy Agent',
  workflowModels.weeklyContent.copyPl,
);

export const weeklyContentCopyRepairAgent = createMarketingAgent(
  'weekly-content-copy-repair-agent',
  'Weekly Content Copy Repair Agent',
  workflowModels.weeklyContent.copyRepair,
);

export const weeklyContentTranslationAgent = createMarketingAgent(
  'weekly-content-translation-agent',
  'Weekly Content Translation Agent',
  workflowModels.weeklyContent.translateEn,
);

export const weeklyContentJsonRepairAgent = createMarketingAgent(
  'weekly-content-json-repair-agent',
  'Weekly Content JSON Repair Agent',
  workflowModels.weeklyContent.jsonRepair,
);

export const producerHuntDiscoveryAgent = createMarketingAgent(
  'producer-hunt-discovery-agent',
  'Producer Hunt Discovery Agent',
  workflowModels.producerHunt.discovery,
);

export const producerHuntEnrichmentAgent = createMarketingAgent(
  'producer-hunt-enrichment-agent',
  'Producer Hunt Enrichment Agent',
  workflowModels.producerHunt.enrichment,
);

export const producerHuntEmailExtractionAgent = createMarketingAgent(
  'producer-hunt-email-extraction-agent',
  'Producer Hunt Email Extraction Agent',
  workflowModels.producerHunt.emailExtraction,
);

export const producerHuntDraftAgent = createMarketingAgent(
  'producer-hunt-draft-agent',
  'Producer Hunt Draft Agent',
  workflowModels.producerHunt.draftEmail,
);

export const producerHuntJsonRepairAgent = createMarketingAgent(
  'producer-hunt-json-repair-agent',
  'Producer Hunt JSON Repair Agent',
  workflowModels.producerHunt.jsonRepair,
);

export const producerHuntCloudFallbackAgent = createMarketingAgent(
  'producer-hunt-cloud-fallback-agent',
  'Producer Hunt Cloud Fallback Agent',
  workflowModels.producerHunt.cloudFallback,
);
