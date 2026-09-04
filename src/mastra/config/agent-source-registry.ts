/**
 * Agent Source Registry — Centralne źródło prawdy o strukturze i lokalizacji agentów w systemie.
 *
 * Eliminuje rozproszenie definicji i map pomiędzy delegate-task.ts, model-manifest.ts,
 * agent-ids.ts oraz index.ts.
 */

export interface AgentSourceDefinition {
  /** Klucz rejestracji w Mastra (np. 'marketingAgent') */
  readonly registryKey: string;
  /** Kanoniczny ID agenta (z agent-ids.ts) */
  readonly canonicalId: string;
  /** ID w instancji Mastra (z agent-ids.ts, np. 'marketing-agent') */
  readonly mastraId: string;
  /** Ścieżka do pliku źródłowego agenta względem src/mastra */
  readonly sourceFile: string;
  /** Ścieżka do promptu systemowego (względem src/mastra/prompts) */
  readonly promptPath?: string;
  /** Domena biznesowa / techniczna */
  readonly domain:
    | 'orchestration'
    | 'engineering'
    | 'review'
    | 'sales'
    | 'marketing'
    | 'knowledge'
    | 'creative'
    | 'operations'
    | 'utility';
  /** Czy agent jest tylko wewnętrznym pomocnikiem domeny (ukryty przed globalnym Meta) */
  readonly internal?: boolean;
}

export const AGENT_SOURCE_REGISTRY: Record<string, AgentSourceDefinition> = {
  metaAgent: {
    registryKey: 'metaAgent',
    canonicalId: 'meta-agent',
    mastraId: 'meta-agent',
    sourceFile: 'agents/meta-agent.ts',
    promptPath: 'meta/base.md',
    domain: 'orchestration',
  },
  metaFrontAgent: {
    registryKey: 'metaFrontAgent',
    canonicalId: 'metaFrontAgent',
    mastraId: 'meta-front',
    sourceFile: 'agents/meta-front-agent.ts',
    promptPath: 'meta-front/base.md',
    domain: 'orchestration',
    internal: true,
  },
  laneOrchestratorAgent: {
    registryKey: 'laneOrchestratorAgent',
    canonicalId: 'laneOrchestratorAgent',
    mastraId: 'lane-orchestrator',
    sourceFile: 'agents/lane-orchestrator-agent.ts',
    promptPath: 'lane-orchestrator/base.md',
    domain: 'orchestration',
    internal: true,
  },
  codingAgent: {
    registryKey: 'codingAgent',
    canonicalId: 'codingAgent',
    mastraId: 'coding-agent',
    sourceFile: 'agents/coding-agent.ts',
    promptPath: 'coding/domain.md',
    domain: 'engineering',
  },
  codeReviewAgent: {
    registryKey: 'codeReviewAgent',
    canonicalId: 'codeReviewAgent',
    mastraId: 'code-review-agent',
    sourceFile: 'agents/code-review-agent.ts',
    promptPath: 'code-review/domain.md',
    domain: 'review',
    internal: true,
  },
  securityReviewAgent: {
    registryKey: 'securityReviewAgent',
    canonicalId: 'securityReviewAgent',
    mastraId: 'security-review-agent',
    sourceFile: 'agents/security-review-agent.ts',
    promptPath: 'security-review/domain.md',
    domain: 'review',
    internal: true,
  },
  performanceReviewAgent: {
    registryKey: 'performanceReviewAgent',
    canonicalId: 'performanceReviewAgent',
    mastraId: 'performance-review-agent',
    sourceFile: 'agents/performance-review-agent.ts',
    promptPath: 'performance-review/domain.md',
    domain: 'review',
    internal: true,
  },
  salesAgent: {
    registryKey: 'salesAgent',
    canonicalId: 'salesAgent',
    mastraId: 'sales-agent',
    sourceFile: 'agents/sales-agent.ts',
    promptPath: 'sales/domain.md',
    domain: 'sales',
  },
  crmAgent: {
    registryKey: 'crmAgent',
    canonicalId: 'crmAgent',
    mastraId: 'crm-agent',
    sourceFile: 'agents/crm-agent.ts',
    promptPath: 'crm/domain.md',
    domain: 'sales',
  },
  analyticsAgent: {
    registryKey: 'analyticsAgent',
    canonicalId: 'analyticsAgent',
    mastraId: 'analytics-agent',
    sourceFile: 'agents/analytics-agent.ts',
    promptPath: 'analytics/domain.md',
    domain: 'operations',
  },
  weatherAgent: {
    registryKey: 'weatherAgent',
    canonicalId: 'weatherAgent',
    mastraId: 'weather-agent',
    sourceFile: 'agents/weather-agent.ts',
    promptPath: 'weather/domain.md',
    domain: 'utility',
  },
  automationArchitect: {
    registryKey: 'automationArchitect',
    canonicalId: 'automationArchitect',
    mastraId: 'automation-architect',
    sourceFile: 'agents/automation-architect.ts',
    promptPath: 'automation-architect/domain.md',
    domain: 'engineering',
  },
  n8nMcpEngineer: {
    registryKey: 'n8nMcpEngineer',
    canonicalId: 'n8nMcpEngineer',
    mastraId: 'n8n-mcp-engineer',
    sourceFile: 'agents/n8n-mcp-engineer.ts',
    promptPath: 'n8n-mcp-engineer/domain.md',
    domain: 'engineering',
    internal: true,
  },
  marketingAgent: {
    registryKey: 'marketingAgent',
    canonicalId: 'marketingAgent',
    mastraId: 'marketing-agent',
    sourceFile: 'agents/marketing-agent.ts',
    promptPath: 'marketing/domain.md',
    domain: 'marketing',
  },
  knowledgeAgent: {
    registryKey: 'knowledgeAgent',
    canonicalId: 'knowledgeAgent',
    mastraId: 'knowledge-agent',
    sourceFile: 'agents/knowledge-agent.ts',
    promptPath: 'knowledge/notebooklm-agent.md',
    domain: 'knowledge',
  },
  researcherAgent: {
    registryKey: 'researcherAgent',
    canonicalId: 'researcherAgent',
    mastraId: 'researcher-agent',
    sourceFile: 'agents/researcher-agent.ts',
    promptPath: 'researcher/domain.md',
    domain: 'knowledge',
  },
  deliberationAgent: {
    registryKey: 'deliberationAgent',
    canonicalId: 'deliberationAgent',
    mastraId: 'deliberation-agent',
    sourceFile: 'agents/deliberation-agent.ts',
    promptPath: 'deliberation/domain.md',
    domain: 'orchestration',
    internal: true,
  },
  chefAgent: {
    registryKey: 'chefAgent',
    canonicalId: 'chefAgent',
    mastraId: 'chef-agent',
    sourceFile: 'agents/chef-agent.ts',
    promptPath: 'chef/domain.md',
    domain: 'operations',
  },
  contentAgent: {
    registryKey: 'contentAgent',
    canonicalId: 'contentAgent',
    mastraId: 'content-agent',
    sourceFile: 'agents/content-agent.ts',
    promptPath: 'content/domain.md',
    domain: 'marketing',
  },
  huntAgent: {
    registryKey: 'huntAgent',
    canonicalId: 'huntAgent',
    mastraId: 'hunt-agent',
    sourceFile: 'agents/hunt-agent.ts',
    promptPath: 'hunt/domain.md',
    domain: 'marketing',
  },
  designAgent: {
    registryKey: 'designAgent',
    canonicalId: 'designAgent',
    mastraId: 'design-agent',
    sourceFile: 'agents/design-agent.ts',
    promptPath: 'design/domain.md',
    domain: 'creative',
  },
  writerAgent: {
    registryKey: 'writerAgent',
    canonicalId: 'writerAgent',
    mastraId: 'writer-agent',
    sourceFile: 'agents/writer-agent.ts',
    promptPath: 'writer/domain.md',
    domain: 'creative',
  },
  filmmakerAgent: {
    registryKey: 'filmmakerAgent',
    canonicalId: 'filmmakerAgent',
    mastraId: 'filmmaker-agent',
    sourceFile: 'agents/filmmaker-agent.ts',
    promptPath: 'filmmaker/domain.md',
    domain: 'creative',
  },
  musicianAgent: {
    registryKey: 'musicianAgent',
    canonicalId: 'musicianAgent',
    mastraId: 'musician-agent',
    sourceFile: 'agents/musician-agent.ts',
    promptPath: 'musician/domain.md',
    domain: 'creative',
  },
  capabilitySmith: {
    registryKey: 'capabilitySmith',
    canonicalId: 'capabilitySmith',
    mastraId: 'capability-smith',
    sourceFile: 'agents/capability-smith.ts',
    promptPath: 'capability-smith/domain.md',
    domain: 'engineering',
  },
} as const;

export type AgentRegistryKey = keyof typeof AGENT_SOURCE_REGISTRY;

export const ALL_AGENT_REGISTRY_KEYS = Object.keys(AGENT_SOURCE_REGISTRY) as AgentRegistryKey[];

export const DELEGATION_TARGET_AGENT_KEYS = Object.entries(AGENT_SOURCE_REGISTRY)
  .filter(
    ([_, def]) =>
      !def.internal ||
      def.registryKey === 'deliberationAgent' ||
      def.registryKey === 'n8nMcpEngineer' ||
      def.registryKey === 'codeReviewAgent' ||
      def.registryKey === 'securityReviewAgent' ||
      def.registryKey === 'performanceReviewAgent',
  )
  .map(([key]) => key as AgentRegistryKey);

export function getAgentSourceDef(key: string): AgentSourceDefinition | undefined {
  return AGENT_SOURCE_REGISTRY[key];
}
