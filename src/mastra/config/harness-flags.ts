/**
 * Feature flags for the jcode-inspired Mastra harness rollout.
 *
 * Flags are intentionally read at call time so local runs can change process.env
 * before invoking a harness component in tests or scripts.
 */

export const HARNESS_FEATURE_FLAG_NAMES = [
  'FEATURE_CODING_PRECONTEXT',
  'FEATURE_REVIEW_PRECONTEXT',
  'FEATURE_AUTOMATION_PRECONTEXT',
  'FEATURE_KNOWLEDGE_PRECONTEXT',
  'FEATURE_ASYNC_SEMANTIC_MEMORY',
  'FEATURE_FILE_ACTIVITY_LEDGER',
  'FEATURE_CODE_OUTLINE',
  'FEATURE_BACKGROUND_TASKS',
  'FEATURE_SOFT_INTERRUPTS',
  'FEATURE_MASTRA_HARNESS',
  'FEATURE_TOOL_ENVELOPE',
  'FEATURE_OUTPUT_COMPACTION',
  'FEATURE_HARNESS_POLICY',
  'FEATURE_HARNESS_REPLAY',
  'FEATURE_ADAPTIVE_DEPTH',
  'FEATURE_REFLECTION_REPAIR_PASS',
  'FEATURE_REFLECTOR_PREPARE_STEP',
  'FEATURE_REFLECTOR_GOAL_TRIGGERS',
  'FEATURE_REFLECTOR_HARD_LEVERS',
  'FEATURE_REFLECTOR_STOP_WHEN',
  // §A — graceful convergence: when a delegating run already holds a usable
  // deliverable but keeps churning, force a no-tool synthesis and stop cleanly
  // (overrides a never-passing completion scorer) instead of running to timeout.
  'FEATURE_REFLECTOR_CONVERGENCE',
  'FEATURE_OUTPUT_SCORING',
  'FEATURE_PIPELINE_REFLECTOR',
  'FEATURE_PIPELINE_PHASE_TOOLS',
  // WS2 — replace the static delegation plan with an LLM-authored plan
  // (explicit assumptions + per-step successCheck) and replan-on-failure.
  'FEATURE_DELEGATION_LLM_PLAN',
  // loop_fix P1 — generate-time model health gate: before agent.generate(),
  // swap an unhealthy (unavailable / circuit-open) model for the first healthy
  // model in the agent's fallback chain, and feed run outcomes back into the
  // circuit breaker. Default OFF (behaviour-preserving).
  'FEATURE_MODEL_HEALTH_GATE',
  // WS-B — route automationArchitect BUILD delegations (golden_path mode) to the
  // async path by default so meta is not blocked. Default OFF (sync + WS-C
  // stop-on-terminal already returns fast).
  'FEATURE_AUTOMATION_ASYNC_DEFAULT',
  // finalize-on-deliverable — once the Golden Path produced a terminal-for-brief
  // deliverable (tested/active), make the run END with a final report instead of
  // hanging to the wall-clock timeout. Drives three coordinated levers: the
  // deliverable-aware completion scorer, a prepareStep force-report, and a
  // stopWhen backstop. All independent of the reflector budget. Default ON.
  'FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE',
  // Etap 1 (IDEALSYSTEMMASTERPLAN) — Task Ledger: every background lane
  // (async delegation, bg task, automation job, cron trigger) is mirrored in
  // Mongo task_ledger; meta reads its turn digest from there. Default ON;
  // rollback = FEATURE_LEDGER_V1=false (writers keep their own lifecycle).
  'FEATURE_LEDGER_V1',
  // Etap 3 (IDEALSYSTEMMASTERPLAN) — communication contracts: delegation briefs
  // get the result-envelope instruction appended and delegation results are
  // parsed into a ResultEnvelope (prose falls back gracefully). Default ON;
  // rollback = FEATURE_COMM_CONTRACTS=false (briefs/results as before).
  'FEATURE_COMM_CONTRACTS',
  // Etap 5 (IDEALSYSTEMMASTERPLAN) — claims scheduler: lanes declaring
  // overlapping resource claims are serialized (lease/lock in task_ledger),
  // disjoint claims run in parallel, the kill switch blocks new starts.
  // Default ON; rollback = FEATURE_LEDGER_SCHEDULER=false (no gating).
  'FEATURE_LEDGER_SCHEDULER',
  // Etap 5 — idempotency: side-effect tools (n8n trigger, gmail draft, CRM
  // write) dedup on a content hash so a retry does not double-execute.
  // Default ON; rollback = FEATURE_IDEMPOTENCY=false.
  'FEATURE_IDEMPOTENCY',
  // Etap 6 (IDEALSYSTEMMASTERPLAN) — skill distillation (success brain):
  // successful tasks (≥5 tool calls / recovery / user correction) are
  // distilled into SKILL.md by a cheap model, mini-evaluated before
  // activation, counted, and curated. Default ON; rollback =
  // FEATURE_SKILL_DISTILLATION=false (no candidate recording, no distillation).
  'FEATURE_SKILL_DISTILLATION',
  // E7-BUILD — the BUILD half of the Capability Gap Protocol: spec gate → lane +
  // claims → coding delegation in a worktree → tsc + check:all → merge, with
  // promote left behind a human approval. Default ON; set
  // FEATURE_CAPABILITY_BUILD=false to take the capability_build tool away from
  // capabilitySmith (discovery/attach path is unaffected).
  'FEATURE_CAPABILITY_BUILD',
  // Etap 8 (IDEALSYSTEMMASTERPLAN) — Graphify code impact map: the
  // graphify_affected tool gives codingAgent transitive reverse-dependency
  // impact of a symbol before editing (fail-soft: degrades to a hint when the
  // CLI/graph is absent). Default ON; the tool no-ops gracefully without the
  // graph, so this is safe to leave on. Rollback = FEATURE_GRAPHIFY=false.
  'FEATURE_GRAPHIFY',
  // Graphify Phase 2 — auto-inject blast-radius (graphify_affected/explain) into
  // coding/review precontext so a subtask starts with impact analysis already in
  // context instead of depending on the model remembering to ask for it. One call
  // per precontext build, fail-soft, section suppressed when uninformative.
  // Default ON: current coding-domain usage is low, so the added cost is low too,
  // and any task that does land there gets full treatment. Rollback = false.
  'FEATURE_GRAPHIFY_PRECONTEXT',
  // Delegation hardening P1 (ideas/delegation-depth-hardening-plan.md) — the
  // depth classifier is stateless, so a one-word continuation command
  // ("Deleguj", "dalej") inside a critical task classifies as `fast`
  // (60s/10 steps/4k context) and starves the heavy work it continues.
  // With this flag, short continuation imperatives inherit the thread's
  // recent heavy depth level. Default ON; rollback = false (stateless).
  'FEATURE_DEPTH_THREAD_INHERITANCE',
  // The same starvation from the opposite direction: not a short CONTINUATION,
  // but a short and entirely CORRECT first brief. "Przygotuj nowe menu dla
  // restauracji <url>" carries no classifiable signal, so an eleven-phase
  // pipeline agent classified `fast` and was told to keep it direct — measured:
  // 4 recipe cards for 18 dishes and five empty Menu Book sections, in a third
  // of the window it was given. With this flag an agent registered in
  // PIPELINE_PHASE_TOOLS never runs below `standard`. Default ON; rollback =
  // false, which restores prompt-only classification.
  'FEATURE_PIPELINE_DEPTH_FLOOR',
  // Delegation hardening P2 — sync delegation timeouts are static (900s
  // direct) and blind to the parent's remaining run budget, so a `fast` (60s)
  // parent can start a 240s child that mathematically cannot return in time.
  // With this flag the child timeout is capped to the parent's remaining
  // budget minus a safety margin, and a delegation that no longer fits the
  // sync window is auto-routed to the async path (pending-update delivery).
  // Default ON; rollback = false (static timeouts).
  'FEATURE_DELEGATION_BUDGET_COORDINATION',
  // Delegation hardening P3 — when a sync delegation times out, the child's
  // partial work (tool results already in its delegation thread) was silently
  // discarded. With this flag the timeout error envelope carries a `salvage`
  // pointer to the delegation thread and the system_delegation_salvage tool
  // can compress that thread into a reusable digest — no re-scraping.
  // Default ON; rollback = false (timeout = total loss, as before).
  'FEATURE_DELEGATION_TIMEOUT_SALVAGE',
  // Liveness budgets (ideas/liveness-budget-plan.md) — replace the fixed
  // wall-clock with "is it still alive and progressing?": a run is cut for
  // silence (idle timeout, reset by every step) or for an absolute hard-cap
  // backstop, never merely for taking long. Duration is a poor proxy for
  // flailing — an agent can work correctly for ten minutes or loop in thirty
  // seconds — and the fixed clock also forced the loop detectors to be tuned
  // down (strategy-reflector §loop_fix.P2c). Default OFF until the detectors
  // are recalibrated (plan L4) and tool AbortSignals are airtight (plan L3).
  'FEATURE_LIVENESS_BUDGET',
  // Telegram native gateway — replace the n8n-webhook-over-Cloudflare-tunnel
  // path for the "Mastra - Telegram Meta-Agent Gateway v3" workflow with an
  // in-process long-polling connector (getUpdates), removing the tunnel and
  // n8n as points of failure for this one integration. Precondition: the
  // Telegram webhook must be deleted first via `npm run switch:telegram-native`
  // (getUpdates 409s while a webhook is registered — Telegram allows only one
  // delivery mode at a time). Default OFF. Rollback = set this to false, run
  // `npm run switch:telegram-n8n` to restore the webhook + reactivate the n8n
  // workflow, then restart.
  'FEATURE_TELEGRAM_NATIVE_GATEWAY',
  // Telegram gateway attachments — inbound photo/document/voice/audio/video
  // support on top of FEATURE_TELEGRAM_NATIVE_GATEWAY. Narrower than the
  // parent flag on purpose: if attachment handling misbehaves (e.g. large
  // base64 payloads), this can be flipped off alone, keeping native text
  // chat working, without falling all the way back to n8n. Default OFF.
  'FEATURE_TELEGRAM_GATEWAY_ATTACHMENTS',
  // Performance optimization flags: gate post-pass no-tool LLM passes that cause 15-40s latency
  'FEATURE_HARNESS_AUTO_REVIEW',
  'FEATURE_HARNESS_AUTO_DELIBERATION',
  'FEATURE_HARNESS_GOAL_REPAIR',
  // Dynamic thinking budget based on classified depth profile (fast=none, standard=light, deep=medium, critical=deep)
  'FEATURE_DYNAMIC_THINKING_BUDGET',
  // Concurrency-aware deterministic DAG planning in GoalContract
  'FEATURE_HARNESS_DETERMINISTIC_PLAN',
  // Tiered prompt architecture for metaAgent (base-core + base-orchestration on demand)
  'FEATURE_META_TIERED_PROMPT',
] as const;

export type HarnessFeatureFlagName = typeof HARNESS_FEATURE_FLAG_NAMES[number];

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function isHarnessFeatureEnabled(
  flagName: HarnessFeatureFlagName,
  defaultValue = false,
): boolean {
  return parseBooleanEnv(process.env[flagName], defaultValue);
}

export function getHarnessFeatureFlags(): Record<HarnessFeatureFlagName, boolean> {
  return Object.fromEntries(
    HARNESS_FEATURE_FLAG_NAMES.map((flagName) => [
      flagName,
      isHarnessFeatureEnabled(flagName),
    ]),
  ) as Record<HarnessFeatureFlagName, boolean>;
}
