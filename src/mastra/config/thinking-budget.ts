/**
 * Central Thinking Budget Matrix & Provider Options
 *
 * Configures dynamic and tiered reasoning/thinking budgets across providers
 * (@ai-sdk/google, @ai-sdk/anthropic, @ai-sdk/openai).
 *
 * Tiers:
 *  - 'none':   0 tokens / disabled (sub-second fast routing, classification, JSON extract)
 *  - 'light':  1024 tokens / low   (balanced domain work, drafting, tool dispatch)
 *  - 'medium': 2048 tokens / med   (n8n workflow compose, code patch, content strategy)
 *  - 'deep':   4096-8192 tokens    (deep code review, security audit, novel polishing)
 */

export type ThinkingTier = 'none' | 'light' | 'medium' | 'deep';

export interface ThinkingProviderOptions {
  google?: {
    thinkingConfig?: {
      thinkingBudget?: number;
    };
  };
  anthropic?: {
    thinking?: {
      type: 'enabled' | 'disabled';
      budgetTokens?: number;
    };
  };
  openai?: {
    reasoningEffort?: 'low' | 'medium' | 'high';
  };
  [key: string]: any;
}

/**
 * Returns providerOptions structured for Mastra and AI SDK for the specified thinking tier.
 */
export function getThinkingProviderOptions(tier: ThinkingTier = 'light'): ThinkingProviderOptions {
  switch (tier) {
    case 'none':
      return {
        google: {},
        anthropic: { thinking: { type: 'disabled' } },
        openai: { reasoningEffort: 'low' },
      };
    case 'light':
      return {
        google: { thinkingConfig: { thinkingBudget: 1024 } },
        anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } },
        openai: { reasoningEffort: 'low' },
      };
    case 'medium':
      return {
        google: { thinkingConfig: { thinkingBudget: 2048 } },
        anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } },
        openai: { reasoningEffort: 'medium' },
      };
    case 'deep':
      return {
        google: { thinkingConfig: { thinkingBudget: 8192 } },
        anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
        openai: { reasoningEffort: 'high' },
      };
  }
}

/**
 * Default tier assignments by agent key or id.
 */
export const AGENT_THINKING_TIERS: Record<string, ThinkingTier> = {
  metaAgent: 'light',
  'meta-agent': 'light',
  metaFrontAgent: 'none',
  'meta-front-agent': 'none',
  laneOrchestratorAgent: 'none',
  'lane-orchestrator-agent': 'none',
  crmAgent: 'none',
  'crm-agent': 'none',
  weatherAgent: 'none',
  'weather-agent': 'none',
  writerAgent: 'light',
  'writer-agent': 'light',
  marketingAgent: 'light',
  'marketing-agent': 'light',
  salesAgent: 'light',
  'sales-agent': 'light',
  analyticsAgent: 'light',
  'analytics-agent': 'light',
  researcherAgent: 'light',
  'researcher-agent': 'light',
  contentAgent: 'medium',
  'content-agent': 'medium',
  chefAgent: 'medium',
  'chef-agent': 'medium',
  automationArchitect: 'medium',
  'automation-architect': 'medium',
  n8nMcpEngineer: 'none',
  'n8n-mcp-engineer': 'none',
  knowledgeAgent: 'light',
  'knowledge-agent': 'light',
  codingAgent: 'medium',
  'coding-agent': 'medium',
  codeReviewAgent: 'deep',
  'code-review-agent': 'deep',
  securityReviewAgent: 'deep',
  'security-review-agent': 'deep',
  performanceReviewAgent: 'medium',
  'performance-review-agent': 'medium',
  deliberationAgent: 'deep',
  'deliberation-agent': 'deep',
  designAgent: 'medium',
  'design-agent': 'medium',
  filmmakerAgent: 'medium',
  'filmmaker-agent': 'medium',
  musicianAgent: 'medium',
  'musician-agent': 'medium',
  capabilitySmith: 'medium',
  'capability-smith': 'medium',
};

/**
 * Helper to get default providerOptions for a given agent.
 */
export function getAgentThinkingOptions(agentKeyOrId: string, overrideTier?: ThinkingTier): ThinkingProviderOptions {
  const tier = overrideTier ?? AGENT_THINKING_TIERS[agentKeyOrId] ?? 'light';
  return getThinkingProviderOptions(tier);
}
