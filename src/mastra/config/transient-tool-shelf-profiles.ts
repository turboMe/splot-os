/**
 * Temporary, in-process tool-shelf profiles.
 *
 * This is deliberately smaller than the durable Execution Capability Broker.
 * Profiles only decide which schemas are pinned and how many discoverable
 * schemas may be visible in one model step. They do not grant permissions:
 * the processor can only select tools already attached to the agent (plus an
 * explicitly supplied legacy ToolSearch pool).
 */

export interface TransientToolShelfProfile {
  /** Runtime Agent.id. Used for flags, telemetry and deterministic state keys. */
  agentId: string;
  /** Runtime object keys or Tool.id values that must always remain visible. */
  coreTools?: string[];
  /** Normalized substrings that pin matching runtime keys/Tool.id values. */
  corePatterns?: string[];
  /** Host-side lexical preselections for step zero. */
  initialTopK: number;
  /** Maximum number of non-core tools active at once. */
  maxActive: number;
  /** Number of compact results returned by search_tools. */
  searchTopK: number;
  /** Optional PL/EN/domain terms keyed by runtime object key or Tool.id. */
  toolTags?: Record<string, string[]>;
  /** Keep all configured agent tools pinned; only an additional pool is shelved. */
  preserveConfiguredToolsAsCore?: boolean;
}

const DEFAULT_CORE_PATTERNS = [
  'status',
  'progress',
  'pending update',
  'request approval',
  'skill search',
  'skill load',
  'memory recall',
  'artifact put',
  'artifact get',
];

const DEFAULT_PROFILE: Omit<TransientToolShelfProfile, 'agentId'> = {
  corePatterns: DEFAULT_CORE_PATTERNS,
  initialTopK: 4,
  maxActive: 8,
  searchTopK: 6,
};

const PROFILES: Record<string, Partial<TransientToolShelfProfile>> = {
  'researcher-agent': {
    coreTools: [
      'artifactPutTool',
      'artifactGetTool',
      'skillSearchTool',
      'skillLoadTool',
      'writeExternalProjectFileTool',
      'writeExternalProjectFile',
      'writeFileTool',
      'fs_write_file',
    ],
    initialTopK: 4,
    maxActive: 7,
    toolTags: {
      searchWebTool: ['web search', 'wyszukiwanie internetu', 'szukaj strony', 'tavily search'],
      findCompanyLinksTool: ['company links', 'linki firmy', 'discover pages'],
      tavilyExtractTool: ['batch extract', 'scrape websites', 'scrapowanie stron', 'ekstrakcja treści'],
      writeExternalProjectFileTool: ['save json file', 'zapisz json na dysku', 'project writer'],
      writeFileTool: ['write file', 'zapis pliku', 'filesystem'],
      playwright: ['browser dom visual', 'przeglądarka playwright', 'javascript page'],
      firecrawl: ['crawl website', 'map site', 'scrape firecrawl'],
    },
  },
  'meta-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 7,
  },
  'knowledge-agent': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 3,
    maxActive: 7,
  },
  // The architect's configured tools ARE the Golden Path: pattern match/compose,
  // credential resolution, validate, risk, deploy, readback, test, repair,
  // activate. Shelving them behind lexical search removed the agent's only route
  // to ground truth and it fell back to writing n8n JSON from model memory —
  // producing a hallucinated `rssFeedRead` typeVersion 2.5 (this install has
  // [1, 1.1, 1.2]) and an empty credential id, while `composeWorkflowTool`'s
  // builders held the correct typeVersion and `resolveCredentialsTool` held the
  // real credential the whole time. Pin the toolkit like `meta-agent` and
  // `knowledge-agent` already do; only the extra `bgTaskTool` pool stays
  // discoverable.
  'automation-architect': {
    preserveConfiguredToolsAsCore: true,
    initialTopK: 4,
    maxActive: 8,
  },
  'coding-agent': {
    coreTools: [
      'artifact_put',
      'artifact_get',
      'coding_get_artifact',
      'system_request_approval',
      'skill_search',
      'skill_load',
      'repo_map',
      'code_search',
    ],
    maxActive: 9,
  },
  'design-agent': {
    coreTools: ['designWriteDeliverableTool', 'requestApprovalTool', 'memoryRecallTool'],
    maxActive: 7,
  },
  'chef-agent': {
    coreTools: [
      'artifactPutTool',
      'artifactGetTool',
      'chefGetProjectTool',
      'chefSetProjectStatusTool',
      'chefDocumentStatusTool',
      'requestApprovalTool',
    ],
    maxActive: 8,
  },
  'content-agent': {
    coreTools: [
      'artifactPutTool',
      'artifactGetTool',
      'contentGetProjectTool',
      'contentSetProjectStatusTool',
      'contentDocumentStatusTool',
      'requestApprovalTool',
    ],
    maxActive: 8,
  },
  'hunt-agent': {
    coreTools: [
      'artifactPutTool',
      'artifactGetTool',
      'huntGetProjectTool',
      'huntSetProjectStatusTool',
      'huntDocumentStatusTool',
      'requestApprovalTool',
    ],
    maxActive: 8,
  },
  'writer-agent': {
    coreTools: ['artifactPutTool', 'artifactGetTool', 'requestApprovalTool'],
    maxActive: 8,
  },
  'filmmaker-agent': {
    coreTools: ['artifactPutTool', 'artifactGetTool', 'requestApprovalTool'],
    maxActive: 8,
  },
  'musician-agent': {
    coreTools: ['artifactPutTool', 'artifactGetTool', 'requestApprovalTool'],
    maxActive: 8,
  },
  'capability-smith': {
    coreTools: ['mcpDiscoverTool', 'capabilitySandboxTool', 'requestApprovalTool'],
    initialTopK: 3,
    maxActive: 6,
  },
  // Same starvation the architect hit, one level down. This agent's ENTIRE
  // purpose is the read-only n8n MCP allowlist (search_nodes / get_node /
  // validate_node / validate_workflow / search_templates / get_template /
  // tools_documentation) — seven tools, already the narrowest surface in the
  // system. Shelving them meant every handoff had to spend its first steps
  // discovering and loading its own reason for existing. Measured 2026-08-24:
  // the returned handoff opens with "`search_nodes` is not currently available.
  // I need to load the appropriate tool first", and 3 of 5 delegations that run
  // came back as `n8n_mcp_handoff_empty` — the step budget (maxSteps 8) was gone
  // before the model could write the synthesis the contract requires. Pinning
  // the configured set costs nothing here: it is small, read-only, and the whole
  // job.
  'n8n-mcp-engineer': {
    preserveConfiguredToolsAsCore: true,
    coreTools: ['artifact_put', 'artifact_get', 'skill_search', 'skill_load'],
    initialTopK: 3,
    maxActive: 10,
  },
  'marketing-agent': {
    coreTools: ['artifactPutTool', 'artifactGetTool'],
    initialTopK: 4,
    maxActive: 8,
  },
};

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function profileFamily(agentId: string): string {
  if (agentId.startsWith('weekly-content-')) return 'marketing-agent';
  if (agentId.startsWith('producer-hunt-')) return 'marketing-agent';
  return agentId;
}

export function resolveTransientToolShelfProfile(
  agentId: string,
  overrides: Partial<TransientToolShelfProfile> = {},
): TransientToolShelfProfile {
  const configured = PROFILES[profileFamily(agentId)] ?? {};
  return {
    ...DEFAULT_PROFILE,
    ...configured,
    ...overrides,
    agentId,
    coreTools: [...new Set([...(configured.coreTools ?? []), ...(overrides.coreTools ?? [])])],
    corePatterns: [
      ...new Set([
        ...DEFAULT_CORE_PATTERNS,
        ...(configured.corePatterns ?? []),
        ...(overrides.corePatterns ?? []),
      ]),
    ],
    initialTopK: positiveInt(process.env.INTERIM_TOOL_SHELF_INITIAL_TOP_K)
      ?? overrides.initialTopK
      ?? configured.initialTopK
      ?? DEFAULT_PROFILE.initialTopK,
    maxActive: positiveInt(process.env.INTERIM_TOOL_SHELF_MAX_ACTIVE)
      ?? overrides.maxActive
      ?? configured.maxActive
      ?? DEFAULT_PROFILE.maxActive,
    searchTopK: positiveInt(process.env.INTERIM_TOOL_SHELF_SEARCH_TOP_K)
      ?? overrides.searchTopK
      ?? configured.searchTopK
      ?? DEFAULT_PROFILE.searchTopK,
    toolTags: {
      ...(configured.toolTags ?? {}),
      ...(overrides.toolTags ?? {}),
    },
  };
}

export function isTransientToolShelfEnabled(agentId: string): boolean {
  if (/^(false|0|no|off)$/i.test(process.env.FEATURE_INTERIM_TOOL_SHELF ?? '')) return false;
  const configured = process.env.INTERIM_TOOL_SHELF_AGENTS?.trim();
  if (!configured || configured === '*') return true;
  const allowed = new Set(configured.split(',').map((value) => value.trim()).filter(Boolean));
  return allowed.has(agentId) || allowed.has(profileFamily(agentId));
}
