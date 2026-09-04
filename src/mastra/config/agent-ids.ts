export const META_AGENT_ID = 'meta-agent' as const;

/**
 * Meta Front — registered in Mastra as `meta-front`, but owned durable jobs are
 * keyed `metaFrontAgent`.
 *
 * Both spellings reach the durable-job tools: the dedicated front endpoint opens
 * a harness run stamped `metaFrontAgent`, while an ordinary Studio chat supplies
 * Mastra's own `meta-front`. Without an alias those two land in DIFFERENT owner
 * spaces (`durableJobOwner`), and because owner scoping deliberately makes "not
 * yours" indistinguishable from "does not exist", the front would simply not see
 * jobs it started through the other door — no error, just a job that vanished.
 */
export const META_FRONT_AGENT_ID = 'metaFrontAgent' as const;
export const META_FRONT_MASTRA_AGENT_ID = 'meta-front' as const;

export const META_FRONT_AGENT_ALIASES = [
  META_FRONT_AGENT_ID,
  META_FRONT_MASTRA_AGENT_ID,
] as const;

/**
 * Canonical runtime/telemetry id for Automation Architect.
 *
 * Mastra's public Agent.id is still `automation-architect` for API/thread
 * compatibility; new harness telemetry, pending messages, and durable jobs use
 * `automationArchitect`.
 */
export const AUTOMATION_ARCHITECT_AGENT_ID = 'automationArchitect' as const;
export const AUTOMATION_ARCHITECT_MASTRA_AGENT_ID = 'automation-architect' as const;

export const CODING_AGENT_ID = 'codingAgent' as const;
export const CODING_AGENT_MASTRA_AGENT_ID = 'coding-agent' as const;

export const CODE_REVIEW_AGENT_ID = 'codeReviewAgent' as const;
export const CODE_REVIEW_AGENT_MASTRA_AGENT_ID = 'code-review-agent' as const;

export const KNOWLEDGE_AGENT_ID = 'knowledgeAgent' as const;
export const KNOWLEDGE_AGENT_MASTRA_AGENT_ID = 'knowledge-agent' as const;

export const N8N_MCP_ENGINEER_AGENT_ID = 'n8nMcpEngineer' as const;
export const N8N_MCP_ENGINEER_MASTRA_AGENT_ID = 'n8n-mcp-engineer' as const;

export const DELIBERATION_AGENT_ID = 'deliberationAgent' as const;
export const DELIBERATION_AGENT_MASTRA_AGENT_ID = 'deliberation-agent' as const;

export const DESIGN_AGENT_ID = 'designAgent' as const;
export const DESIGN_AGENT_MASTRA_AGENT_ID = 'design-agent' as const;

export const WRITER_AGENT_ID = 'writerAgent' as const;
export const WRITER_AGENT_MASTRA_AGENT_ID = 'writer-agent' as const;

export const FILMMAKER_AGENT_ID = 'filmmakerAgent' as const;
export const FILMMAKER_AGENT_MASTRA_AGENT_ID = 'filmmaker-agent' as const;

export const MUSICIAN_AGENT_ID = 'musicianAgent' as const;
export const MUSICIAN_AGENT_MASTRA_AGENT_ID = 'musician-agent' as const;

export const CHEF_AGENT_ID = 'chefAgent' as const;
export const CHEF_AGENT_MASTRA_AGENT_ID = 'chef-agent' as const;

export const CONTENT_AGENT_ID = 'contentAgent' as const;
export const CONTENT_AGENT_MASTRA_AGENT_ID = 'content-agent' as const;

export const ANALYTICS_AGENT_ID = 'analyticsAgent' as const;
export const ANALYTICS_AGENT_MASTRA_AGENT_ID = 'analytics-agent' as const;

export const RESEARCHER_AGENT_ID = 'researcherAgent' as const;
export const RESEARCHER_AGENT_MASTRA_AGENT_ID = 'researcher-agent' as const;

export const CRM_AGENT_ID = 'crmAgent' as const;
export const CRM_AGENT_MASTRA_AGENT_ID = 'crm-agent' as const;

export const MARKETING_AGENT_ID = 'marketingAgent' as const;
export const MARKETING_AGENT_MASTRA_AGENT_ID = 'marketing-agent' as const;

export const SALES_AGENT_ID = 'salesAgent' as const;
export const SALES_AGENT_MASTRA_AGENT_ID = 'sales-agent' as const;

export const HUNT_AGENT_ID = 'huntAgent' as const;
export const HUNT_AGENT_MASTRA_AGENT_ID = 'hunt-agent' as const;

// Etap 7 (CGP) — owner of the Capability Gap Protocol
export const CAPABILITY_SMITH_AGENT_ID = 'capabilitySmith' as const;
export const CAPABILITY_SMITH_MASTRA_AGENT_ID = 'capability-smith' as const;

export const AUTOMATION_ARCHITECT_AGENT_ALIASES = [
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
] as const;

export const CODING_AGENT_ALIASES = [
  CODING_AGENT_ID,
  CODING_AGENT_MASTRA_AGENT_ID,
] as const;

export const CODE_REVIEW_AGENT_ALIASES = [
  CODE_REVIEW_AGENT_ID,
  CODE_REVIEW_AGENT_MASTRA_AGENT_ID,
] as const;

export const KNOWLEDGE_AGENT_ALIASES = [
  KNOWLEDGE_AGENT_ID,
  KNOWLEDGE_AGENT_MASTRA_AGENT_ID,
] as const;

export const N8N_MCP_ENGINEER_AGENT_ALIASES = [
  N8N_MCP_ENGINEER_AGENT_ID,
  N8N_MCP_ENGINEER_MASTRA_AGENT_ID,
] as const;

export const DELIBERATION_AGENT_ALIASES = [
  DELIBERATION_AGENT_ID,
  DELIBERATION_AGENT_MASTRA_AGENT_ID,
] as const;

export const DESIGN_AGENT_ALIASES = [
  DESIGN_AGENT_ID,
  DESIGN_AGENT_MASTRA_AGENT_ID,
] as const;

export const WRITER_AGENT_ALIASES = [
  WRITER_AGENT_ID,
  WRITER_AGENT_MASTRA_AGENT_ID,
] as const;

export const FILMMAKER_AGENT_ALIASES = [
  FILMMAKER_AGENT_ID,
  FILMMAKER_AGENT_MASTRA_AGENT_ID,
] as const;

export const MUSICIAN_AGENT_ALIASES = [
  MUSICIAN_AGENT_ID,
  MUSICIAN_AGENT_MASTRA_AGENT_ID,
] as const;

export const CHEF_AGENT_ALIASES = [
  CHEF_AGENT_ID,
  CHEF_AGENT_MASTRA_AGENT_ID,
] as const;

export const CONTENT_AGENT_ALIASES = [
  CONTENT_AGENT_ID,
  CONTENT_AGENT_MASTRA_AGENT_ID,
] as const;

export const CAPABILITY_SMITH_AGENT_ALIASES = [
  CAPABILITY_SMITH_AGENT_ID,
  CAPABILITY_SMITH_MASTRA_AGENT_ID,
] as const;

export const ANALYTICS_AGENT_ALIASES = [
  ANALYTICS_AGENT_ID,
  ANALYTICS_AGENT_MASTRA_AGENT_ID,
] as const;

export const RESEARCHER_AGENT_ALIASES = [
  RESEARCHER_AGENT_ID,
  RESEARCHER_AGENT_MASTRA_AGENT_ID,
] as const;

export const CRM_AGENT_ALIASES = [
  CRM_AGENT_ID,
  CRM_AGENT_MASTRA_AGENT_ID,
] as const;

export const MARKETING_AGENT_ALIASES = [
  MARKETING_AGENT_ID,
  MARKETING_AGENT_MASTRA_AGENT_ID,
] as const;

export const SALES_AGENT_ALIASES = [
  SALES_AGENT_ID,
  SALES_AGENT_MASTRA_AGENT_ID,
] as const;

export const HUNT_AGENT_ALIASES = [
  HUNT_AGENT_ID,
  HUNT_AGENT_MASTRA_AGENT_ID,
] as const;

export const PENDING_UPDATES_AGENT_IDS = [
  META_AGENT_ID,
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  CODING_AGENT_ID,
] as const;

export const DELEGATION_CALLER_AGENT_IDS = [
  META_AGENT_ID,
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  DELIBERATION_AGENT_ID,
  DESIGN_AGENT_ID,
  DESIGN_AGENT_MASTRA_AGENT_ID,
  WRITER_AGENT_ID,
  WRITER_AGENT_MASTRA_AGENT_ID,
  FILMMAKER_AGENT_ID,
  FILMMAKER_AGENT_MASTRA_AGENT_ID,
  MUSICIAN_AGENT_ID,
  MUSICIAN_AGENT_MASTRA_AGENT_ID,
] as const;

export const DELEGATION_RETURN_AGENT_IDS = [
  META_AGENT_ID,
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  CODING_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  DELIBERATION_AGENT_ID,
  DESIGN_AGENT_ID,
  DESIGN_AGENT_MASTRA_AGENT_ID,
  WRITER_AGENT_ID,
  WRITER_AGENT_MASTRA_AGENT_ID,
  FILMMAKER_AGENT_ID,
  FILMMAKER_AGENT_MASTRA_AGENT_ID,
  MUSICIAN_AGENT_ID,
  MUSICIAN_AGENT_MASTRA_AGENT_ID,
] as const;

export function canonicalizeRuntimeAgentId(agentId: string | null | undefined): string | undefined {
  if (!agentId) return undefined;
  if ((META_FRONT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return META_FRONT_AGENT_ID;
  }
  if ((AUTOMATION_ARCHITECT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return AUTOMATION_ARCHITECT_AGENT_ID;
  }
  if ((CODING_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CODING_AGENT_ID;
  }
  if ((CODE_REVIEW_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CODE_REVIEW_AGENT_ID;
  }
  if ((KNOWLEDGE_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return KNOWLEDGE_AGENT_ID;
  }
  if ((N8N_MCP_ENGINEER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return N8N_MCP_ENGINEER_AGENT_ID;
  }
  if ((DELIBERATION_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return DELIBERATION_AGENT_ID;
  }
  if ((DESIGN_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return DESIGN_AGENT_ID;
  }
  if ((WRITER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return WRITER_AGENT_ID;
  }
  if ((FILMMAKER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return FILMMAKER_AGENT_ID;
  }
  if ((MUSICIAN_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return MUSICIAN_AGENT_ID;
  }
  if ((CHEF_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CHEF_AGENT_ID;
  }
  if ((CONTENT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CONTENT_AGENT_ID;
  }
  if ((CAPABILITY_SMITH_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CAPABILITY_SMITH_AGENT_ID;
  }
  if ((ANALYTICS_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return ANALYTICS_AGENT_ID;
  }
  if ((RESEARCHER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return RESEARCHER_AGENT_ID;
  }
  if ((CRM_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return CRM_AGENT_ID;
  }
  if ((MARKETING_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return MARKETING_AGENT_ID;
  }
  if ((SALES_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return SALES_AGENT_ID;
  }
  if ((HUNT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return HUNT_AGENT_ID;
  }
  return agentId;
}

export function agentIdAliases(agentId: string | null | undefined): string[] {
  if (!agentId) return [];
  if ((AUTOMATION_ARCHITECT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...AUTOMATION_ARCHITECT_AGENT_ALIASES];
  }
  if ((CODING_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CODING_AGENT_ALIASES];
  }
  if ((CODE_REVIEW_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CODE_REVIEW_AGENT_ALIASES];
  }
  if ((KNOWLEDGE_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...KNOWLEDGE_AGENT_ALIASES];
  }
  if ((N8N_MCP_ENGINEER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...N8N_MCP_ENGINEER_AGENT_ALIASES];
  }
  if ((DELIBERATION_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...DELIBERATION_AGENT_ALIASES];
  }
  if ((DESIGN_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...DESIGN_AGENT_ALIASES];
  }
  if ((WRITER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...WRITER_AGENT_ALIASES];
  }
  if ((FILMMAKER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...FILMMAKER_AGENT_ALIASES];
  }
  if ((MUSICIAN_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...MUSICIAN_AGENT_ALIASES];
  }
  if ((CHEF_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CHEF_AGENT_ALIASES];
  }
  if ((CONTENT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CONTENT_AGENT_ALIASES];
  }
  if ((CAPABILITY_SMITH_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CAPABILITY_SMITH_AGENT_ALIASES];
  }
  if ((ANALYTICS_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...ANALYTICS_AGENT_ALIASES];
  }
  if ((RESEARCHER_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...RESEARCHER_AGENT_ALIASES];
  }
  if ((CRM_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...CRM_AGENT_ALIASES];
  }
  if ((MARKETING_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...MARKETING_AGENT_ALIASES];
  }
  if ((SALES_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...SALES_AGENT_ALIASES];
  }
  if ((HUNT_AGENT_ALIASES as readonly string[]).includes(agentId)) {
    return [...HUNT_AGENT_ALIASES];
  }
  return [agentId];
}

export function agentIdFieldFilter(agentId: string | null | undefined): string | { $in: string[] } | undefined {
  const aliases = agentIdAliases(agentId);
  if (aliases.length === 0) return undefined;
  return aliases.length === 1 ? aliases[0] : { $in: aliases };
}

/**
 * Is this delegation an agent handing its own task back to itself?
 *
 * A pure predicate rather than a check inside the tool, because the tool's
 * `execute` needs a Mastra instance, a thread and a model to reach — so the rule
 * would only ever be exercised by a live run, which is how the previous version
 * of it went untested. It WAS six hand-written `if` blocks naming six agents
 * (`automationArchitect`, `knowledgeAgent`, `designAgent`, `writerAgent`,
 * `filmmakerAgent`, `musicianAgent`) with no gate over any of them, and a list
 * that grows only when someone remembers is a list that is already incomplete:
 * `codingAgent` was about to become the seventh entry.
 *
 * Canonicalized on BOTH sides on purpose. The caller arrives as a runtime id
 * (`coding-agent`, stamped by the run) and the target as an Agent Board id
 * (`codingAgent`, typed by the model), and comparing those two spellings
 * directly would let every self-delegation through.
 */
export function isSelfDelegation(
  callerAgentId: string | null | undefined,
  targetAgentId: string | null | undefined,
): boolean {
  const caller = canonicalizeRuntimeAgentId(callerAgentId);
  const target = canonicalizeRuntimeAgentId(targetAgentId);
  return Boolean(caller && target && caller === target);
}
