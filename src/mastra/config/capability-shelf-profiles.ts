/**
 * Capability Shelf Profiles (Smart Capability Shelf)
 *
 * Configures tool and skill shelf policies per agent:
 *   1. Domain Pinning: Creative and narrow agents have `preserveConfiguredToolsAsCore: true` (100% of domain tools pinned).
 *   2. Large Hubs (coding, researcher, marketing): Dynamic shelf with phase bundles and auto-dependencies.
 *   3. Safe limits: maxActive (default 10), initialTopK (default 4), maxSkillTokens (default 8000).
 */

export interface CapabilityShelfProfile {
  /** Runtime Agent.id */
  agentId: string;
  /** Tools that must always remain visible */
  coreTools?: string[];
  /** Skills that are permanently loaded in system prompt */
  coreSkills?: string[];
  /** Normalized substrings that pin matching runtime keys / tool IDs */
  corePatterns?: string[];
  /** Host-side hybrid preselection count for step 0 */
  initialTopK: number;
  /** Maximum number of non-core capabilities active at once */
  maxActive: number;
  /** Number of compact results returned by capability_search */
  searchTopK: number;
  /** Max characters/tokens allocated for active skill system instructions */
  maxSkillTokens?: number;
  /** Named capability bundles for phase-based loading */
  toolBundles?: Record<string, string[]>;
  /** Automatic dependency expansion: when key is loaded, values are pinned too */
  autoDependencies?: Record<string, string[]>;
  /** Keep 100% of configured agent tools pinned; shelf only manages skills & extra pools */
  preserveConfiguredToolsAsCore?: boolean;
}

const DEFAULT_CORE_PATTERNS = [
  'status',
  'progress',
  'pending update',
  'request approval',
  'requestApproval',
  'system_request_approval',
  'memory recall',
  'artifact put',
  'artifact get',
  'artifact_put',
  'artifact_get',
];

const DEFAULT_PROFILE: Omit<CapabilityShelfProfile, 'agentId'> = {
  corePatterns: DEFAULT_CORE_PATTERNS,
  initialTopK: 4,
  maxActive: 10,
  searchTopK: 5,
  maxSkillTokens: 8000,
};

const PROFILES: Record<string, Partial<CapabilityShelfProfile>> = {
  // ── 1. LARGE TOOL HUBS (Dynamic Shelf) ────────────────────────────────────────

  'coding-agent': {
    coreTools: [
      'artifact_put',
      'artifact_get',
      'system_request_approval',
      'repo_map',
    ],
    initialTopK: 4,
    maxActive: 10,
    searchTopK: 6,
    toolBundles: {
      inspect: ['view', 'search_content', 'find_files', 'workspace_search', 'repo_map', 'lsp_inspect'],
      write: ['coding_write_file_tracked', 'coding_create_artifact', 'coding_accept_file', 'coding_reject_file'],
      test_run: ['coding_run_test', 'execute_command', 'bg_task', 'tdd-isolate-runner'],
      git_worktree: ['coding_init_worktree', 'coding_remove_worktree', 'coding_apply_patch'],
      impact_analysis: ['graphify_affected', 'graphify_explain', 'graphify_god_nodes', 'code_outline'],
      docs_external: ['context7_resolve_library_id', 'context7_query_docs'],
      webgl_3d: ['threejs-r3f-scene-architect', 'spline-3d-interactive-embed', 'glsl-webgl-shader-effects', 'css-3d-parallax-transforms'],
      perf_audit: ['modern-react-perf-audit', 'wcag-accessibility-audit', 'ast-code-smell-detector'],
      mcp_builder: ['mcp-server-builder', 'openapi-to-mcp-converter'],
    },
    autoDependencies: {
      search_content: ['coding_write_file_tracked'],
      lsp_inspect: ['coding_write_file_tracked'],
      coding_write_file_tracked: ['coding_run_test', 'coding_create_artifact'],
    },
  },

  'researcher-agent': {
    coreTools: [
      'artifactPutTool',
      'artifactGetTool',
      'requestApprovalTool',
      'writeExternalProjectFileTool',
    ],
    initialTopK: 4,
    maxActive: 10,
    searchTopK: 6,
    toolBundles: {
      web_search: ['searchWebTool', 'findCompanyLinksTool'],
      web_extract: ['tavilyExtractTool', 'firecrawl_scrape', 'firecrawl_crawl', 'writeExternalProjectFileTool'],
      browser_dom: ['playwright_navigate', 'playwright_click', 'playwright_fill', 'playwright_evaluate', 'writeExternalProjectFileTool'],
      report_write: ['writeExternalProjectFileTool', 'writeFileTool'],
      intel_verification: ['source-driven-verifier', 'sentiment-review-intelligence'],
    },
    autoDependencies: {
      tavilyExtractTool: ['writeExternalProjectFileTool', 'artifactPutTool'],
      firecrawl_scrape: ['writeExternalProjectFileTool'],
      firecrawl_crawl: ['writeExternalProjectFileTool'],
      playwright_navigate: ['writeExternalProjectFileTool'],
    },
  },

  'marketing-agent': {
    coreTools: [
      'artifactPutTool',
      'artifactGetTool',
      'requestApprovalTool',
    ],
    initialTopK: 4,
    maxActive: 8,
    searchTopK: 5,
    toolBundles: {
      crm_pipeline: ['searchLeadsTool', 'createLeadTool', 'updateStatusTool', 'updateLeadTool', 'addInteractionTool'],
      email_outreach: ['recordEmailDraftTool', 'gmailSearchTool', 'gmailManageDraftTool', 'calendarCreateEventTool', 'cold-email-deliverability-sanitizer', 'anti-slop-content-sanitizer', 'multi-touch-cadence-planner'],
      market_intel: ['rssGetArticlesTool', 'rssSearchArticlesTool', 'rssCreateDigestTool', 'searchWebTool', 'viral-hook-storytelling', 'abm-account-dossier-builder'],
      knowledge_research: ['knowledgeQueryTool', 'knowledgeQueryMultiTool', 'knowledgeListNotebooksTool', 'knowledgeResearchStartTool'],
    },
  },

  // ── 2. CREATIVE PIPELINE AGENTS (100% Domain Tools Core Pinned) ──────────────

  'design-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'writer-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'filmmaker-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'film-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'musician-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  // ── 3. CODE REVIEW SPECIALISTS (100% Tools Core Pinned) ──────────────────────

  'code-review-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 6,
  },

  'performance-review-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 6,
  },

  'security-review-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 6,
  },

  // ── 4. NARROW DOMAIN & INFRASTRUCTURE AGENTS (100% Core Pinned) ──────────────

  'sales-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
    toolBundles: {
      objection_handling: ['b2b-objection-matrix-solver', 'knowledgeLookupTool'],
      deal_qualification: ['meddpicc-deal-qualifier', 'searchLeadsTool'],
      onboarding: ['client-onboarding-orchestrator', 'calendarCreateEventTool'],
    },
  },

  'crm-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 6,
    toolBundles: {
      churn_prevention: ['client-health-churn-sentinel', 'searchLeadsTool'],
      deal_qualification: ['meddpicc-deal-qualifier', 'searchLeadsTool'],
      onboarding: ['client-onboarding-orchestrator', 'updateStatusTool'],
    },
  },

  'analytics-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'deliberation-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'automation-architect': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 4,
    maxActive: 8,
  },

  'n8n-mcp-engineer': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'meta-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'knowledge-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'chef-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'content-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'hunt-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 8,
  },

  'capability-smith': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 6,
  },
};

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function profileFamily(agentId: string): string {
  if (agentId === 'film-agent') return 'filmmaker-agent';
  if (agentId.startsWith('weekly-content-')) return 'marketing-agent';
  if (agentId.startsWith('producer-hunt-')) return 'marketing-agent';
  return agentId;
}

export function resolveCapabilityShelfProfile(
  agentId: string,
  overrides: Partial<CapabilityShelfProfile> = {},
): CapabilityShelfProfile {
  const configured = PROFILES[profileFamily(agentId)] ?? {};
  return {
    ...DEFAULT_PROFILE,
    ...configured,
    ...overrides,
    agentId,
    coreTools: [...new Set([...(configured.coreTools ?? []), ...(overrides.coreTools ?? [])])],
    coreSkills: [...new Set([...(configured.coreSkills ?? []), ...(overrides.coreSkills ?? [])])],
    corePatterns: [
      ...new Set([
        ...DEFAULT_CORE_PATTERNS,
        ...(configured.corePatterns ?? []),
        ...(overrides.corePatterns ?? []),
      ]),
    ],
    toolBundles: {
      ...(configured.toolBundles ?? {}),
      ...(overrides.toolBundles ?? {}),
    },
    autoDependencies: {
      ...(configured.autoDependencies ?? {}),
      ...(overrides.autoDependencies ?? {}),
    },
    initialTopK: positiveInt(process.env.CAPABILITY_SHELF_INITIAL_TOP_K)
      ?? overrides.initialTopK
      ?? configured.initialTopK
      ?? DEFAULT_PROFILE.initialTopK,
    maxActive: positiveInt(process.env.CAPABILITY_SHELF_MAX_ACTIVE)
      ?? overrides.maxActive
      ?? configured.maxActive
      ?? DEFAULT_PROFILE.maxActive,
    searchTopK: positiveInt(process.env.CAPABILITY_SHELF_SEARCH_TOP_K)
      ?? overrides.searchTopK
      ?? configured.searchTopK
      ?? DEFAULT_PROFILE.searchTopK,
  };
}

export function isCapabilityShelfEnabled(agentId: string): boolean {
  if (/^(false|0|no|off)$/i.test(process.env.FEATURE_CAPABILITY_SHELF ?? '')) return false;
  const configured = process.env.CAPABILITY_SHELF_AGENTS?.trim();
  if (!configured || configured === '*') return true;
  const allowed = new Set(configured.split(',').map((value) => value.trim()).filter(Boolean));
  return allowed.has(agentId) || allowed.has(profileFamily(agentId));
}

export { resolveCapabilityShelfProfile as getCapabilityShelfProfile, PROFILES as CAPABILITY_SHELF_PROFILES };
