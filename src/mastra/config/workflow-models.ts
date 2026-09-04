/**
 * Central model routing for Mastra workflows.
 *
 * All model IDs are sourced from config/model-manifest.ts (Single Source of Truth).
 * Change models there, restart Mastra, and workflows/agents that import this
 * file will pick up the new runtime model assignment.
 */

import { resolveModelId, workflowAssignments, agentModels } from './model-manifest.js';

export const modelPresets = {
  // Local / private / cheapest
  localMarketing: resolveModelId(workflowAssignments.marketing.default),
  localReasoning: resolveModelId(agentModels.salesAgent),
  localPowerful: resolveModelId(agentModels.salesAgent),

  // Google
  googlePro: resolveModelId(workflowAssignments.coding.default),
  googleFlash: resolveModelId(workflowAssignments.coding.review),

  // OpenAI
  openaiPro: resolveModelId('gpt-5.5'),
  openaiMini: resolveModelId('gpt-5.3-mini'),

  // Anthropic
  anthropicSonnet: resolveModelId('claude-sonnet-4.6'),
  anthropicHaiku: resolveModelId('claude-haiku-4.5'),
} as const;

export const workflowModels = {
  marketing: {
    // Used by the general registered marketingAgent and non-weekly-content marketing workflows.
    default: resolveModelId(workflowAssignments.marketing.default),
  },

  weeklyContent: {
    // Good local/default split. To use cloud copy, change copyPl to e.g.
    // modelPresets.googlePro, modelPresets.openaiPro, or modelPresets.anthropicSonnet.
    research: resolveModelId(workflowAssignments.weeklyContent.research),
    copyPl: resolveModelId(workflowAssignments.weeklyContent.copyPl),
    copyRepair: resolveModelId(workflowAssignments.weeklyContent.copyRepair),
    translateEn: resolveModelId(workflowAssignments.weeklyContent.translateEn),
    jsonRepair: resolveModelId(workflowAssignments.weeklyContent.jsonRepair),
  },

  producerHunt: {
    // Discovery/enrichment can stay local for cheaper exploratory work.
    // For better outreach quality, draftEmail is the first step worth moving to cloud.
    discovery: resolveModelId(workflowAssignments.producerHunt.discovery),
    enrichment: resolveModelId(workflowAssignments.producerHunt.enrichment),
    emailExtraction: resolveModelId(workflowAssignments.producerHunt.emailExtraction),
    draftEmail: resolveModelId(workflowAssignments.producerHunt.draftEmail),
    jsonRepair: resolveModelId(workflowAssignments.producerHunt.jsonRepair),
    cloudFallback: resolveModelId(workflowAssignments.producerHunt.cloudFallback),
  },

  coding: {
    // Master agents — static model assignment
    default: resolveModelId(workflowAssignments.coding.default),       // diagnose-and-plan (needs reasoning)
    patch: resolveModelId(workflowAssignments.coding.patch),           // execute-patch fallback (when no diagnosticPlan)
    review: resolveModelId(workflowAssignments.coding.review),         // code review
    selfHealingPlanner: resolveModelId(workflowAssignments.coding.selfHealingPlanner),
    selfHealingReview: resolveModelId(workflowAssignments.coding.selfHealingReview),
    jsonRepair: resolveModelId(workflowAssignments.coding.jsonRepair),
    // Worker routing is DYNAMIC via SmartRouter (config/model-capabilities.ts).
    // Each subtask gets assigned based on complexity, VRAM budget, and cost.
    // See: services/smart-router.ts
  },
} as const;
