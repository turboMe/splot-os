/**
 * SubAgent Role Definitions (Phase 3.1)
 *
 * Defines the specialization roles for codingAgent's sub-agents.
 * Each role has:
 *   - Constrained tool whitelist (principle of least privilege)
 *   - Default model tier (cheapest capable)
 *   - Prompt template reference
 *   - Optional pre-loaded skills
 *
 * The subtask-executor (3.2) uses these roles to:
 *   1. Select the right sub-agent type for each subtask
 *   2. Build a scoped prompt with only relevant tools
 *   3. Route to the cheapest capable model
 *
 * Design decisions:
 *   - 3 roles (not 5+): file-editor, terminal, qa. Keeps it lean for
 *     Phase A (flat hierarchy). More roles can be added in Phase B if needed.
 *   - allowedTools are string IDs that map to actual tool objects in the executor.
 *   - defaultModelTier is a preference hint; SmartRouter may override based
 *     on GPU/VRAM availability.
 */

import type { ModelTier } from './model-capabilities.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubAgentRole {
  /** Unique role identifier */
  roleId: string;
  /** Human-readable name */
  name: string;
  /** When should the orchestrator pick this sub-agent? */
  description: string;
  /** Whitelisted tool IDs this role may use */
  allowedTools: string[];
  /**
   * Documentation of intent, not an enforced setting — nothing reads this
   * field (confirmed by `git log -S defaultModelTier` returning zero commits,
   * Z5 in docs/MIGRACJA-DOMENY-CODING.md). Actual routing is decided in
   * `smart-router.ts` by role ID (`ROLES_THAT_WRITE_CODE`,
   * `ROLES_EXCLUDED_FROM_LOCAL`), which is what to change if you want this
   * role's routing to actually differ, not this field.
   */
  defaultModelTier: ModelTier;
  /** Prompt template path (relative to prompts/) */
  promptTemplate: string;
  /** Pre-loaded skill names (optional — loaded from SkillRegistry) */
  skills?: string[];
}

// ── Subtask Type → Role Mapping ──────────────────────────────────────────────

/**
 * Maps subtask.type values to sub-agent role IDs.
 * Used by resolveSubAgent() in subtask-executor.ts (Phase 3.2).
 */
export const SUBTASK_TYPE_TO_ROLE: Record<string, string> = {
  // File editing tasks
  edit: 'file-editor',
  create: 'file-editor',
  refactor: 'file-editor',
  fix: 'file-editor',
  patch: 'file-editor',

  // Terminal / build tasks
  test: 'terminal',
  build: 'terminal',
  install: 'terminal',
  run: 'terminal',

  // Quality assurance tasks
  verify: 'qa',
  lint: 'qa',
  review: 'qa',
  check: 'qa',
  validate: 'qa',
  e2e: 'qa',

  // Research / browser tasks (Phase F2)
  research: 'researcher',
  browse: 'researcher',
  scrape: 'researcher',
  search: 'researcher',
};

/** Default role when subtask type is unknown */
export const DEFAULT_ROLE = 'file-editor';

// ── Role Definitions ─────────────────────────────────────────────────────────

export const SUBAGENT_ROLES: Record<string, SubAgentRole> = {
  /**
   * File Editor SubAgent
   *
   * Primary workhorse — reads, modifies, and creates source files.
   * Has full workspace read access + tracked write tools.
   * Does NOT run commands (that's terminal's job).
   */
  'file-editor': {
    roleId: 'file-editor',
    name: 'File Editor SubAgent',
    description:
      'Edits source files in the workspace. Use when the subtask requires ' +
      'creating, modifying, or refactoring code files. Has read access to ' +
      'the full workspace and tracked write capability.',
    allowedTools: [
      // Read — real registered keys (code-workspace.ts renames), not the
      // 'workspace_*' prefix this list used before this was actually
      // enforced: nothing noticed the mismatch while it was prompt-only text.
      'view',
      'find_files',
      'search_content',
      'workspace_search',
      'lsp_inspect',
      // Impact analysis (safety net for blast radius on shared symbols)
      'graphify_affected',
      // Write (tracked)
      'coding_write_file_tracked',
      // Artifact management
      'coding_create_artifact',
      'coding_get_artifact',
      'coding_update_artifact',
    ],
    defaultModelTier: 'local-heavy',
    promptTemplate: 'coding/subagent-file-editor',
    skills: ['safe-file-edit'],
  },

  /**
   * Terminal SubAgent
   *
   * Runs read-only commands: build, test, lint, type-check.
   * Can READ files for context but CANNOT write/edit them.
   * Uses cheapest model — command execution is deterministic.
   */
  'terminal': {
    roleId: 'terminal',
    name: 'Terminal SubAgent',
    description:
      'Runs read-only terminal commands: build, test, lint, type-check. ' +
      'Use when the subtask requires running verification commands. ' +
      'Can read files for context but does NOT edit files.',
    allowedTools: [
      // Read
      'view',
      'find_files',
      'search_content',
      // Commands (safe only)
      'coding_run_test',
      // Artifact (every role reports through this, per buildScopedPrompt's
      // universal "describe what you did" instruction — a role whose
      // allowedTools omits it can run commands but can never report on them)
      'coding_get_artifact',
      'coding_update_artifact',
    ],
    defaultModelTier: 'cloud-free',
    promptTemplate: 'coding/subagent-terminal',
    skills: ['run-verification'],
  },

  /**
   * QA SubAgent
   *
   * Verifies correctness of changes: runs tsc, eslint, smoke tests.
   * Analyzes output and produces structured quality signals.
   * Focused on diagnosis, not fixing — reports issues back to orchestrator.
   */
  'qa': {
    roleId: 'qa',
    name: 'QA SubAgent',
    description:
      'Verifies the correctness of code changes. Runs type-checking, ' +
      'linting, smoke tests, and e2e browser tests via Playwright. ' +
      'Produces structured quality signals. ' +
      'Does NOT edit files — only reports issues for the orchestrator to fix.',
    allowedTools: [
      // Read
      'view',
      'find_files',
      'search_content',
      'lsp_inspect',
      // Commands (safe only)
      'coding_run_test',
      // Artifact (read + update for quality notes)
      'coding_get_artifact',
      'coding_update_artifact',
      // Browser automation (Phase F2 — Playwright MCP; not yet wired to codingAgent's own toolset)
      'browser_navigate',
      'browser_click',
      'browser_fill',
      'browser_snapshot',
      'browser_screenshot',
    ],
    defaultModelTier: 'cloud-free',
    promptTemplate: 'coding/subagent-qa',
    skills: ['run-verification', 'e2e-testing-playwright'],
  },

  /**
   * Researcher SubAgent (Phase F2)
   *
   * Performs web research, scraping, and data extraction.
   * Uses Tavily search + Playwright browser + Firecrawl for thorough research.
   * Reports findings back to orchestrator in structured format.
   */
  'researcher': {
    roleId: 'researcher',
    name: 'Research SubAgent',
    description:
      'Performs autonomous web research, scraping, and data extraction. ' +
      'Uses multi-query expansion, source triangulation, and confidence scoring. ' +
      'Reports findings in structured format with source citations.',
    allowedTools: [
      // Read
      'workspace_view',
      // Web search
      'search_web',
      'search_find_company_links',
      // Browser automation (Playwright MCP)
      'browser_navigate',
      'browser_click',
      'browser_fill',
      'browser_snapshot',
      'browser_screenshot',
      // Artifact management
      'coding_create_artifact',
      'coding_update_artifact',
    ],
    defaultModelTier: 'cloud-fast',
    promptTemplate: 'shared/subagent-researcher',
    skills: ['web-research-strategy', 'playwright-browser-automation'],
  },
};

// ── Utility Functions ────────────────────────────────────────────────────────

/**
 * Resolve the appropriate sub-agent role for a subtask.
 * Falls back to 'file-editor' for unknown types.
 */
export function resolveSubAgentRole(subtaskType: string): SubAgentRole {
  const roleId = SUBTASK_TYPE_TO_ROLE[subtaskType] ?? DEFAULT_ROLE;
  return SUBAGENT_ROLES[roleId] ?? SUBAGENT_ROLES[DEFAULT_ROLE];
}

/**
 * Get all defined role IDs.
 */
export function getAllRoleIds(): string[] {
  return Object.keys(SUBAGENT_ROLES);
}

/**
 * Check if a tool ID is allowed for a given role.
 */
export function isToolAllowed(roleId: string, toolId: string): boolean {
  const role = SUBAGENT_ROLES[roleId];
  if (!role) return false;
  return role.allowedTools.includes(toolId);
}
