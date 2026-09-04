/**
 * Pipeline per-phase tool allowlists (Reflektor Part 3 §3.4).
 *
 * The strongest, most natural lever for deterministic state-machine agents
 * (chef / content / hunt): instead of detecting a wrong tool pick AFTER the
 * fact, PREVENT it — in a given phase, surface only that phase's tools as the
 * `activeTools` allowlist for the next step.
 *
 * 🔴 Determinism > everything. Hard safety rules baked into `resolvePhaseTools`:
 *   1. FAIL-OPEN — unknown agent / unknown phase / empty allowlist → `null`
 *      (the caller applies NO restriction, i.e. the full toolset). Never block.
 *   2. PERMISSIVE SUPERSETS — `alwaysAvailable` (status, getters, document,
 *      knowledge, memory, approval) is unioned into EVERY phase so a legitimate
 *      cross-phase call is never blocked.
 *   3. TRANSITION + READ tools (`*_set_*_status`, `*_get_*`, doc/status) live in
 *      `alwaysAvailable` so the agent can ALWAYS advance or inspect its state.
 *
 * Tool ids here are the registered tool `id`s (what Mastra reports from
 * `listTools()` and what appears in step history) — NOT the import variable
 * names. Adding a NEW tool to an agent requires updating the relevant phase
 * here, otherwise fail-open lets it through but it won't be channeled to a phase.
 */

export interface PipelinePhaseToolMap {
  /**
   * Phase-transition tool id (e.g. `chef_set_project_status`). Used by the
   * pipeline reflector to detect the current phase from step history. Empty
   * string for agents whose phase is supplied out-of-band (automation: the
   * harness passes `input.phase` directly — no status tool to scan for).
   */
  statusTool: string;
  /** Tools available in EVERY phase (unioned into each phase's allowlist). */
  alwaysAvailable: string[];
  /** Phase id → tools specific to that phase. */
  phases: Record<string, string[]>;
}

// ── Shared system/memory/knowledge tools every pipeline phase may use ──
const SHARED_ALWAYS = [
  'system_current_time',
  'system_memory_recall',
  'system_memory_write_observation',
  'shared_memory_add_context',
  'system_request_approval',
  'knowledge_query',
  'knowledge_query_multi',
];

export const PIPELINE_PHASE_TOOLS: Record<string, PipelinePhaseToolMap> = {
  // ── Chef — "Menu Book" (11 states) ──
  chefAgent: {
    statusTool: 'chef_set_project_status',
    alwaysAvailable: [
      ...SHARED_ALWAYS,
      'chef_set_project_status',
      'chef_get_project',
      'chef_list_projects',
      'chef_get_menu',
      'chef_get_recipe',
      'chef_document_init',
      'chef_document_write_section',
      'chef_document_status',
      'chef_add_note',
      'chef_search_notes',
      'chef_query_knowledge',
    ],
    phases: {
      intake: ['chef_start_project', 'chef_update_profile', 'system_run_worker'],
      recon: ['system_delegate_task', 'reviews_google_place', 'chef_search_recipe_library'],
      profile_synthesis: [
        'chef_import_website_profile',
        'chef_update_profile',
        'system_run_worker',
        'system_delegate_task',
      ],
      checkpoint_profile: [],
      menu_draft: [
        'chef_generate_menu',
        'chef_save_menu',
        'chef_suggest_pairing',
        'chef_score_pairing',
        'chef_suggest_pairings',
        'chef_check_seasonal',
        'chef_search_recipe_library',
        'system_run_worker',
      ],
      critic_gate: ['chef_iterate_menu', 'system_run_worker'],
      checkpoint_menu: [],
      recipes: [
        'chef_draft_recipe',
        'chef_search_recipe_library',
        'chef_suggest_pairings',
        'system_run_worker',
        'system_delegate_task',
      ],
      qa_final: ['system_run_worker'],
      render: [
        'chef_document_render',
        'chef_document_pdf',
        'chef_export_menu',
        'chef_export_menu_book',
      ],
      done: [],
    },
  },

  // ── Content — "Content Pack" (11 states) ──
  contentAgent: {
    statusTool: 'content_set_project_status',
    alwaysAvailable: [
      ...SHARED_ALWAYS,
      'content_set_project_status',
      'content_get_project',
      'content_list_projects',
      'content_doc_init',
      'content_doc_write_section',
      'content_doc_status',
      'content_add_note',
      'content_search_notes',
    ],
    phases: {
      intake: ['content_start_project'],
      research: ['content_fetch_signals', 'system_delegate_task'],
      strategy: ['content_query_strategy', 'content_search_exemplars'],
      checkpoint_strategy: [],
      draft: ['content_search_exemplars', 'content_save_draft', 'system_run_worker'],
      critique: ['content_quality_check', 'system_run_worker'],
      art_direction: ['system_run_worker'],
      assemble: ['content_doc_status'],
      checkpoint_review: ['content_quality_check'],
      ship: ['content_save_draft', 'content_schedule', 'content_doc_render', 'content_add_exemplar'],
      done: [],
    },
  },

  // ── Hunt — lead-hunting pipeline (10 states) ──
  huntAgent: {
    statusTool: 'hunt_set_run_status',
    alwaysAvailable: [
      ...SHARED_ALWAYS,
      'hunt_set_run_status',
      'hunt_get_run',
      'hunt_list_runs',
      'hunt_get_market_pack',
      'hunt_doc_init',
      'hunt_doc_write_section',
      'hunt_doc_status',
    ],
    phases: {
      intake: ['hunt_start_run'],
      discover: ['system_delegate_task', 'search_web', 'search_find_company_links'],
      score: ['hunt_score_lead'],
      enrich: [
        'system_delegate_task',
        'hunt_validate_enrichment_identity',
        'hunt_score_lead',
        'system_run_worker',
      ],
      extract_email: ['hunt_pick_best_email', 'system_run_worker'],
      draft: ['hunt_validate_draft', 'system_run_worker'],
      assemble: [
        'crm_create_lead',
        'crm_update_lead',
        'crm_update_status',
        'crm_add_interaction',
        'crm_record_email_draft',
        'crm_search_leads',
        'gmail_create_draft',
        'hunt_doc_render',
      ],
      checkpoint_review: ['hunt_doc_render'],
      ship: ['crm_update_status', 'gmail_update_draft', 'gmail_get_draft'],
      done: [],
    },
  },

  // ── Writer — long-form writing pipeline (fiction + factual) ──
  writerAgent: {
    statusTool: 'writer_set_project_status',
    alwaysAvailable: [
      ...SHARED_ALWAYS,
      'writer_set_project_status',
      'writer_get_project',
      'writer_list_projects',
      'writer_list_sections',
      'writer_document_read',
      'writer_add_note',
      'writer_search_notes',
      'writer_list_audits',
    ],
    phases: {
      intake: [
        'writer_start_project',
        'writer_analyze_style_sample',
        'writer_document_init',
      ],
      detect: [
        'writer_start_project',
        'writer_update_style_profile',
        'writer_analyze_style_sample',
        'writer_document_init',
      ],
      setup_project: [
        'writer_start_project',
        'writer_update_style_profile',
        'writer_document_init',
        'writer_document_write_section',
      ],
      world_build: [
        'writer_update_continuity',
        'writer_get_continuity',
        'writer_upsert_section',
        'writer_document_write_section',
        'system_run_worker',
      ],
      research: [
        'writer_prepare_research_delegation',
        'system_delegate_task',
        'writer_ingest_research_result',
        'writer_add_sources',
        'writer_list_sources',
        'writer_upsert_claims',
        'writer_document_write_section',
      ],
      source_verify: [
        'writer_list_sources',
        'writer_ingest_research_result',
        'writer_upsert_claims',
        'writer_list_claims',
        'writer_save_audit',
        'system_run_worker',
      ],
      claim_plan: [
        'writer_ingest_research_result',
        'writer_upsert_claims',
        'writer_list_claims',
        'writer_document_write_section',
      ],
      outline: [
        'writer_upsert_section',
        'writer_document_write_section',
        'writer_update_continuity',
        'writer_upsert_claims',
        'system_run_worker',
      ],
      scene_drafts: [
        'writer_upsert_section',
        'writer_document_write_section',
        'writer_document_snapshot',
        'writer_update_continuity',
        'writer_get_continuity',
        'system_run_worker',
      ],
      chronicler_pass: [
        'writer_update_continuity',
        'writer_get_continuity',
        'writer_validate_continuity',
        'writer_save_audit',
        'writer_prepare_worker_review',
        'system_run_worker',
      ],
      section_write: [
        'writer_upsert_section',
        'writer_document_write_section',
        'writer_document_snapshot',
        'writer_upsert_claims',
        'writer_list_sources',
        'system_run_worker',
      ],
      claim_verify: [
        'writer_verify_claims',
        'writer_quality_gate',
        'writer_list_claims',
        'writer_save_audit',
      ],
      critic_gate: [
        'writer_document_snapshot',
        'writer_audit_slop',
        'writer_validate_continuity',
        'writer_verify_claims',
        'writer_quality_gate',
        'writer_prepare_worker_review',
        'writer_save_audit',
        'system_run_worker',
      ],
      revision: [
        'writer_document_snapshot',
        'writer_document_write_section',
        'writer_upsert_section',
        'writer_update_continuity',
        'writer_upsert_claims',
        'writer_quality_gate',
        'writer_prepare_worker_review',
        'writer_revision_decision',
        'writer_save_audit',
        'system_run_worker',
      ],
      polish: [
        'writer_audit_slop',
        'writer_quality_gate',
        'writer_prepare_worker_review',
        'writer_revision_decision',
        'writer_document_write_section',
        'writer_document_snapshot',
        'writer_save_audit',
        'system_run_worker',
      ],
      render: [
        'writer_document_snapshot',
        'writer_document_export',
        'writer_document_write_section',
      ],
      done: [],
    },
  },

  // ── Filmmaker — Seedance video generation pipeline ──
  filmmakerAgent: {
    statusTool: 'film_set_project_status',
    alwaysAvailable: [
      ...SHARED_ALWAYS,
      'system_delegate_task',
      'system_run_worker',
      'film_set_project_status',
      'film_get_project',
      'film_list_projects',
      'film_get_canon',
      'film_list_generation_runs',
      'film_load_reference',
      'film_search_reference',
    ],
    phases: {
      intake: ['film_start_project', 'film_upsert_clip'],
      source_gate: [
        'system_delegate_task',
        'film_check_sources',
        'film_upsert_clip',
      ],
      mode_select: [
        'film_upsert_clip',
        'film_check_project_state',
        'film_load_reference',
        'film_search_reference',
      ],
      reference_map: [
        'film_upsert_clip',
        'film_load_reference',
        'film_search_reference',
        'design_generate_image',
        'system_delegate_task',
      ],
      prompt_build: [
        'film_compile_prompt_spec',
        'film_lint_prompt',
        'film_check_project_state',
        'film_check_continuity',
        'system_run_worker',
      ],
      generate: [
        'film_generate',
        'film_append_generation_run',
      ],
      take_review: [
        'film_record_take',
        'film_check_generation_run',
        'film_check_sequence_eval',
        'film_check_continuity',
        'system_run_worker',
      ],
      repair: [
        'film_upsert_clip',
        'film_compile_prompt_spec',
        'film_lint_prompt',
        'film_check_continuity',
        'system_run_worker',
      ],
      deliver: [
        'film_check_project_state',
        'film_check_generation_run',
        'film_check_sequence_eval',
      ],
      done: [],
    },
  },

  // ── Musician — music generation pipeline (lighter than filmmaker) ──
  musicianAgent: {
    statusTool: 'music_set_project_status',
    alwaysAvailable: [
      ...SHARED_ALWAYS,
      'system_delegate_task',
      'system_run_worker',
      'music_set_project_status',
      'music_get_project',
      'music_list_projects',
      'music_list_generation_runs',
      'music_load_reference',
      'music_search_reference',
    ],
    phases: {
      intake: ['music_start_project', 'music_upsert_track', 'music_set_brief'],
      brief: ['music_set_brief', 'music_upsert_track'],
      source_gate: ['system_delegate_task'],
      lyric_write: ['music_write_lyrics', 'system_run_worker'],
      style_compile: ['music_compile_prompt_spec', 'music_lint_prompt', 'system_run_worker'],
      safety_gate: ['music_check_safety', 'music_lint_prompt'],
      generate: ['music_generate', 'music_append_generation_run'],
      review: ['music_record_take', 'music_check_generation_run', 'system_run_worker'],
      repair: [
        'music_set_brief',
        'music_write_lyrics',
        'music_compile_prompt_spec',
        'music_lint_prompt',
        'music_check_safety',
        'system_run_worker',
      ],
      deliver: ['music_check_generation_run'],
      done: [],
    },
  },

  // ── Automation Architect — n8n Golden Path (§3.5) ──
  // Phase comes from the harness `input.phase` (discover → compose → validate →
  // deploy → test → repair → activate), NOT from a status tool — `statusTool` is
  // intentionally empty. The `chat` phase is deliberately UNMAPPED so it
  // fail-opens to the full toolset (free-form delegation / analysis).
  automationArchitect: {
    statusTool: '',
    alwaysAvailable: [
      'system_memory_recall',
      'system_memory_write_observation',
      'system_delegate_task',
      'system_run_worker',
      'skill_search',
      'skill_load',
      'skill_report_result',
      'checkPendingUpdates',
      // Read/inspect + Golden-Path orchestration are valid in every phase.
      'n8n_health',
      'n8n_list_workflows',
      'n8n_get_workflow',
      'architect_execute_automation_request',
      'architect_start_automation_job',
      'architect_get_automation_job',
      'architect_list_automation_jobs',
      'architect_cancel_automation_job',
      'architect_mark_stale_automation_jobs',
      'architect_risk_score',
      'architect_skills_search',
    ],
    phases: {
      discover: ['architect_sync_patterns', 'architect_match_pattern'],
      compose: ['architect_compose_workflow', 'architect_resolve_credentials', 'architect_match_pattern'],
      validate: ['architect_validate_workflow', 'architect_runtime_check', 'architect_resolve_credentials'],
      deploy: ['architect_deploy_automation', 'architect_resolve_credentials'],
      test: ['architect_test_workflow', 'architect_runtime_check', 'n8n_trigger'],
      repair: ['architect_repair_workflow', 'architect_validate_workflow', 'architect_runtime_check'],
      activate: ['architect_activate_automation', 'n8n_trigger'],
    },
  },
};

/**
 * Resolve the `activeTools` allowlist for an agent in a given phase.
 *
 * FAIL-OPEN: returns `null` (→ apply NO restriction) when the agent is unknown,
 * the phase is null/unknown, OR the resulting allowlist would be empty. A phase
 * mapped to `[]` (e.g. checkpoints) still returns `alwaysAvailable` so the agent
 * keeps its status/getter/doc tools — never an empty toolset.
 */
export function resolvePhaseTools(agentKey: string, phase: string | null): string[] | null {
  const map = PIPELINE_PHASE_TOOLS[agentKey];
  if (!map || !phase) return null;
  const phaseTools = map.phases[phase];
  if (phaseTools === undefined) return null; // unknown phase → fail-open
  const allow = Array.from(new Set([...map.alwaysAvailable, ...phaseTools]));
  return allow.length > 0 ? allow : null;
}

/** The phase-transition tool id for an agent, or undefined if not a pipeline agent. */
export function getStatusToolName(agentKey: string): string | undefined {
  return PIPELINE_PHASE_TOOLS[agentKey]?.statusTool;
}

/** Whether an agent is a registered pipeline agent. */
export function isPipelineAgent(agentKey: string): boolean {
  return agentKey in PIPELINE_PHASE_TOOLS;
}

/**
 * ⚠️ Naming boundary. This map is authored in registered tool **`id`s** (the
 * snake_case `createTool({ id })` value — readable, matches prompts/docs). But
 * Mastra's step history, `activeTools` allowlist, and the model's tool registry
 * all key on the agent's **tool-object KEY** (the camelCase export-variable name,
 * e.g. `chefSetProjectStatusTool`). The two differ, so every value crossing into
 * `prepareStep` (status-tool match, `activeTools`, reflector hints) MUST be
 * translated from id → key first. These helpers do that from a live tool registry
 * (`agent.listTools()`), so the static map stays human-readable.
 */

/** Build an `id → registryKey` map from an `agent.listTools()` result. */
export function buildToolIdToKeyMap(registry: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(registry)) {
    const id = (value as { id?: unknown })?.id;
    if (typeof id === 'string' && id) map[id] = key;
  }
  return map;
}

/**
 * Translate a list of tool `id`s to their registry keys, dropping any id that
 * isn't present in this agent's toolset. Returns `null` when the input is null
 * OR nothing maps (→ caller fail-opens to no restriction, never an empty set).
 */
export function translateToolIdsToKeys(
  ids: string[] | null,
  idToKey: Record<string, string>,
): string[] | null {
  if (!ids) return null;
  const keys = ids.map((id) => idToKey[id]).filter((k): k is string => typeof k === 'string');
  return keys.length > 0 ? keys : null;
}

/**
 * Minimal structural view of a normalized step, so this config module stays free
 * of a runtime dependency on the reflector just to read two arrays.
 */
export interface PhaseDetectionStep {
  toolCalls?: Array<{ toolName: string; args?: unknown }>;
  toolResults?: Array<{ toolName: string; result?: unknown; isError?: boolean }>;
}

/**
 * The pipeline agent's CURRENT phase, read back from what it actually did.
 *
 * A pipeline agent announces every transition by calling its own status tool, so
 * the newest such call is the authoritative phase — there is no separate place
 * where "the phase" is stored, and inventing one would be a second source of
 * truth to keep in sync.
 *
 * Lives HERE, next to the phase map it reads against, because it now has two
 * consumers: the legacy pipeline wrapper and the V2 harness. It was previously
 * private to the wrapper, and copying it into the harness would have created
 * exactly the drift this codebase has been bitten by before — two implementations
 * of one rule, free to disagree silently.
 *
 * `statusToolName` must be the tool's REGISTRY KEY, not its authored id: step
 * history reports keys. Returns `null` when this window contains no transition —
 * callers keep their own last-known value rather than treating that as "no phase".
 */
export function detectPipelinePhase(
  steps: PhaseDetectionStep[],
  statusToolName: string,
): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const statusCall = (step?.toolCalls ?? []).find((c) => c.toolName === statusToolName);
    if (!statusCall) continue;
    // Prefer the call's `status` argument…
    const args = statusCall.args as Record<string, unknown> | undefined;
    if (typeof args?.status === 'string') return args.status;
    // …but fall back to the status tool's RETURNED `{ status }` (the status tool
    // echoes the new phase). Robust against arg-extraction gaps across AI SDK
    // message shapes.
    const statusResult = (step?.toolResults ?? []).find((r) => r.toolName === statusToolName);
    const rv = statusResult?.result as Record<string, unknown> | undefined;
    if (typeof rv?.status === 'string') return rv.status;
    // A status call exists but its phase is indeterminate in this window — keep
    // scanning older steps rather than giving up (return null).
  }
  return null;
}
