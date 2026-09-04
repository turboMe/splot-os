/**
 * Agent Board — the roster as DATA, not prose (Etap 2, IDEALSYSTEMMASTERPLAN A1).
 *
 * Single source of truth for "who can do what". Replaces the two hand-kept
 * copies that used to live in delegate-task.ts's description (~6k chars) and
 * prompts/meta/base.md's delegation table.
 *
 * Consumers:
 *   - scripts/build-agent-board.ts → Mongo `agent_board` (cards + model +
 *     track record) + prompts/meta/_generated/roster.md (compact roster)
 *   - tools/system/agent-board-tools.ts → agent_board_list / agent_board_get
 *   - delegate-task.ts → targetAgent enum (AGENT_BOARD_IDS — no manual sync)
 *   - check:agent-board-sync → drift detection vs index.ts registration
 *
 * Editing rule: when an agent's scope changes, edit ITS CARD here — the
 * roster, the enum, and the board tools all follow automatically.
 */

import type { ArtifactType } from './artifact-types.js';

export type { ArtifactType } from './artifact-types.js';

export type AgentCard = {
  id: string;
  oneLiner: string;
  whenToUse: string[];
  whenNotToUse: string[];
  /** How to formulate the brief — what MUST be in the taskSpec. */
  inputContract: string;
  outputArtifacts: ArtifactType[];
  delegation: 'sync' | 'async' | 'both';
  costClass: 'local' | 'cheap' | 'standard' | 'premium';
  latencyClass: 'seconds' | 'minutes' | 'long';
  examples: { brief: string; note: string }[];
  /** Hard routing rules learned from real failures — surfaced in full card. */
  hardRules?: string[];
  /**
   * Capabilities this one delegates to INSIDE its own run, as part of a pipeline
   * phase it owns.
   *
   * The planner may not put a separate step in front of such a capability: the
   * step would do the same work with none of the contract. Measured — `chefAgent`
   * delegates two recon missions whose JSON its `chef_import_website_profile`
   * mapper is built to read, and every menu job naming a website was split into
   * research → chef instead. The generic research came back as prose, the mapper
   * had nothing to read (its fields are all optional, so it accepted an empty
   * analysis silently), and chef's `recon` branch was never entered because the
   * planner's step goal no longer carried the URL: 0 of 20 chefAgent tasks in V2
   * history ever received one.
   *
   * Prose said this already — `hardRules` says it in words the planner reads. This
   * is the same fact as DATA, so the lane can repair a bad plan rather than hope
   * a model was persuaded (`repairPlanOwnership` in
   * `orchestration/execution/lane-decider.ts`). Both, deliberately: the wording
   * stops most plans from being written, the field catches the rest.
   *
   * Derived from the phases in `config/pipeline-phase-tools.ts` that carry
   * `system_delegate_task`, but declared here because the roster — not the tool
   * map — is where "how to engage this agent" belongs.
   */
  runsInternally?: string[];
  /**
   * A helper only its owning domain may call — kept OFF meta's generated roster.
   *
   * The card still exists in every other sense: it is a delegation target, it is
   * audited, and `agent_board_get` returns it. What changes is that meta is not
   * paid to read about a route it is forbidden to take. `n8nMcpEngineer`'s own
   * card has said "callers other than automationArchitect are blocked" since it
   * shipped, and it still cost meta a roster entry on every single turn.
   *
   * The budget is real: `check:meta-prompt-size` requires the combined static
   * prompt to stay 25% under the E0 baseline, and adding the three review cards
   * pushed it to 23.3% before this.
   */
  internal?: boolean;
};

export const agentBoard: Record<string, AgentCard> = {
  marketingAgent: {
    id: 'marketingAgent',
    oneLiner: 'Cold-emails, RSS digests, Gmail drafts, CRM writes, calendar bookings, NotebookLM research.',
    whenToUse: [
      'CRM WRITES for marketing: interactions, status changes, lead updates',
      'booking a meeting or follow-up in the calendar',
      'cold email / follow-up drafting into Gmail',
      'RSS digest creation',
      'NotebookLM notebooks: create, add sources, query, delete',
    ],
    whenNotToUse: [
      'multi-platform social content (posts/reels/carousels) → contentAgent',
      'lead discovery from scratch → huntAgent',
    ],
    inputContract: 'Goal + target audience/lead context + tone; name the CRM records or RSS scope involved.',
    outputArtifacts: ['email_draft', 'crm_update', 'document'],
    delegation: 'sync',
    costClass: 'standard',
    // Creating drafts with attachments is an external, multi-step operation
    // (lead/grounding → draft → Gmail upload → CRM receipt). The V2 scheduler
    // turns `minutes` into a 300s cap, which cut observed batches while they
    // were still making progress. Use the established long operation window.
    latencyClass: 'long',
    examples: [{
      brief: 'Draft a follow-up email (PL, human tone) for lead X after 7 days of silence; save as Gmail draft.',
      note: 'Drafts only — sending is always human-approved.',
    }],
  },

  salesAgent: {
    id: 'salesAgent',
    oneLiner: 'CRM pipeline ops, proposals, onboarding, meeting scheduling (CRM + Calendar + Gmail).',
    whenToUse: ['pipeline updates and proposals', 'onboarding sequences', 'meeting scheduling'],
    whenNotToUse: ['lead hunting → huntAgent', 'marketing copy → marketingAgent/contentAgent'],
    inputContract: 'Goal + lead/deal identifiers + desired pipeline outcome.',
    outputArtifacts: ['crm_update', 'email_draft', 'document'],
    delegation: 'sync',
    costClass: 'cheap',
    latencyClass: 'minutes',
    examples: [{
      brief: 'Move deal Y to "proposal", generate proposal outline, schedule a call slot next week.',
      note: 'Has Calendar access; meta never books meetings itself.',
    }],
  },

  analyticsAgent: {
    id: 'analyticsAgent',
    oneLiner: 'KPI reports, ROI, anomalies, trend analysis over system + n8n telemetry.',
    whenToUse: ['KPI/ROI reporting', 'anomaly and trend analysis'],
    whenNotToUse: ['system performance questions meta can answer via system_agent_performance_report directly'],
    inputContract: 'Metric window + questions to answer; name comparison periods when relevant.',
    outputArtifacts: ['analysis_report'],
    delegation: 'sync',
    costClass: 'cheap',
    latencyClass: 'minutes',
    examples: [{
      brief: 'Compare lead conversion 14d vs previous 14d; flag anomalies with likely causes.',
      note: 'Read-only over telemetry.',
    }],
  },

  automationArchitect: {
    id: 'automationArchitect',
    oneLiner: 'n8n workflow design + Golden Path deploy with guardrails (Pattern RAG, risk scoring, MCP validation).',
    whenToUse: [
      'build/update/deploy/test n8n automations from a natural-language goal',
      'read-only risk analysis of existing workflows',
    ],
    whenNotToUse: [
      'raw workflow JSON authored by meta — architect owns graph synthesis, MCP validation, and Golden Path deploy',
      'legacy Jarvis workflows (no "Mastra - " prefix) — read-only, never modify',
      'simple one-off API queries that do not require an n8n workflow',
    ],
    inputContract: 'Natural-language automation goal + trigger/services involved + risk constraints (credentials, activation).',
    outputArtifacts: ['automation_workflow', 'analysis_report'],
    delegation: 'both',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Build an n8n workflow: webhook → validate payload → append row to Google Sheets; deploy inactive.',
      note: 'Async preferred for builds (20 min budget); returns deploy status + workflow id.',
    }],
    hardRules: [
      'Meta never authors or passes raw workflow JSON — Meta delegates the natural-language goal or taskSpec to automationArchitect.',
    ],
  },

  n8nMcpEngineer: {
    id: 'n8nMcpEngineer',
    internal: true,
    oneLiner: 'INTERNAL helper of automationArchitect: n8n MCP node/template discovery + read-only validation.',
    whenToUse: ['(automationArchitect only) node/template discovery, validate_node/validate_workflow'],
    whenNotToUse: ['any direct delegation from meta or other agents — callers other than automationArchitect are blocked'],
    inputContract: 'Node/template query or candidate workflow JSON to validate (read-only).',
    outputArtifacts: ['analysis_report'],
    delegation: 'sync',
    costClass: 'standard',
    latencyClass: 'minutes',
    examples: [{
      brief: '(from architect) Validate candidate workflow nodes at empirical typeVersions; report errors.',
      note: 'Read-only; never deploys.',
    }],
  },

  knowledgeAgent: {
    id: 'knowledgeAgent',
    oneLiner: 'Google NotebookLM research: notebook/source ops, cross-notebook Q&A, Studio artifacts.',
    whenToUse: [
      'research grounded in OUR curated NotebookLM corpus',
      'long deep research / source indexing / Studio generation (async)',
    ],
    whenNotToUse: ['live public-web reads → researcherAgent'],
    inputContract: 'Question(s) + which notebooks/corpus scope + expected output format.',
    outputArtifacts: ['research_report', 'document'],
    delegation: 'both',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Cross-notebook: summarize our culinary corpus stance on fermentation menus; cite sources.',
      note: 'Async for batch/deep work — results return via pending updates.',
    }],
  },

  crmAgent: {
    id: 'crmAgent',
    oneLiner: 'Quick lead lookup only — read-only CRM on a fast local model.',
    whenToUse: ['fast single-lead lookups'],
    whenNotToUse: [
      'CRM writes → salesAgent',
      'anything BEYOND a lookup in one request (write, draft, booking) → marketingAgent',
      'meta can use searchLeads tool directly for trivial lookups',
    ],
    inputContract: 'Lead name/email/company to look up.',
    outputArtifacts: ['analysis_report'],
    delegation: 'sync',
    costClass: 'local',
    latencyClass: 'seconds',
    examples: [{ brief: 'Find lead "Kowalski dairy" and return status + last interaction.', note: 'Read-only.' }],
  },

  codingAgent: {
    id: 'codingAgent',
    oneLiner: 'Local repo work: read/search code, prepare patches on worktrees, run safe verification commands.',
    whenToUse: [
      'code/repo/tests/TypeScript changes',
      'long builds/tests as background tasks (async)',
    ],
    whenNotToUse: [
      'just LOOKING at code — meta has read-only repo_map/code_search/worktree tools',
      'chef data population scripts (hard rule below)',
    ],
    inputContract: 'WHAT to change + acceptance criteria. Never include workspace paths — it knows its repo.',
    outputArtifacts: ['diff_patch', 'review_report'],
    delegation: 'both',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Add tool X to agent Y with schema Z; run typecheck + relevant check:*; report diff.',
      note: 'Works on isolated worktree; meta reviews via coding_worktree_diff.',
    }],
    hardRules: [
      'NEVER used to populate chef/Menu-Book data via scripts — chef domain writes belong to chefAgent exclusively.',
    ],
  },

  codeReviewAgent: {
    id: 'codeReviewAgent',
    internal: true,
    oneLiner: 'Code review of a task worktree: correctness, blast radius, structured verdict.',
    whenToUse: [
      'a coding task needs a verdict before merge',
      're-review after a rework round',
    ],
    whenNotToUse: [
      'writing the code → codingAgent',
      'deep threat modelling of an auth/crypto change → securityReviewAgent',
    ],
    inputContract: 'The taskId whose worktree holds the change, plus the review iteration when this is a re-review.',
    outputArtifacts: ['review_report'],
    delegation: 'sync',
    costClass: 'standard',
    // `long`, not `minutes`, from measurement (2026-08-24). The `minutes` class
    // grants a 300s attempt cap, which the store turns into a 296s business
    // window — and BOTH reviewers we have real data for have SUCCEEDED past it:
    // securityReviewAgent 324s, codeReviewAgent 315s. securityReviewAgent's
    // three recorded failures are all `deadline` at exactly 296s, alternating
    // with successes, i.e. a coin flip on a budget the size of the work.
    // performanceReviewAgent is reclassified with them: it is the same workload
    // (read a diff plus the repo, produce a structured verdict) and has exactly
    // one recorded run, so leaving the least-evidenced reviewer on the tighter
    // budget would just hide the same cut until it reviews something large.
    // The asymmetry decides it — an over-wide wall clock costs latency on a hang
    // (and liveness, not the clock, is what detects hangs), while an under-wide
    // one deterministically kills work that was going fine.
    latencyClass: 'long',
    examples: [{
      brief: 'Review task <id>: diff is in its worktree; check correctness, blast radius and tests, then submit a verdict.',
      note: 'Assessment only — never edits files. Records the verdict with coding_submit_review.',
    }],
  },

  securityReviewAgent: {
    id: 'securityReviewAgent',
    internal: true,
    oneLiner: 'Deep security review of a diff: STRIDE/DREAD, OWASP, dependency risk.',
    whenToUse: [
      'diff touches auth, crypto, deserialization or a trust boundary',
      'a dependency/supply-chain question about a change',
    ],
    whenNotToUse: [
      'ordinary review → codeReviewAgent',
      'performance questions → performanceReviewAgent',
    ],
    inputContract: 'The taskId whose worktree holds the change + which surface is security-relevant.',
    outputArtifacts: ['review_report'],
    delegation: 'sync',
    costClass: 'standard',
    // `long`, not `minutes`, from measurement (2026-08-24). The `minutes` class
    // grants a 300s attempt cap, which the store turns into a 296s business
    // window — and BOTH reviewers we have real data for have SUCCEEDED past it:
    // securityReviewAgent 324s, codeReviewAgent 315s. securityReviewAgent's
    // three recorded failures are all `deadline` at exactly 296s, alternating
    // with successes, i.e. a coin flip on a budget the size of the work.
    // performanceReviewAgent is reclassified with them: it is the same workload
    // (read a diff plus the repo, produce a structured verdict) and has exactly
    // one recorded run, so leaving the least-evidenced reviewer on the tighter
    // budget would just hide the same cut until it reviews something large.
    // The asymmetry decides it — an over-wide wall clock costs latency on a hang
    // (and liveness, not the clock, is what detects hangs), while an under-wide
    // one deterministically kills work that was going fine.
    latencyClass: 'long',
    examples: [{
      brief: 'Task <id> changes the session check in auth.ts. Run a threat model and give a verdict.',
      note: 'Methodology comes from a loaded skill (stride-dread / owasp-code-review), not from memory.',
    }],
  },

  performanceReviewAgent: {
    id: 'performanceReviewAgent',
    internal: true,
    oneLiner: 'Deep performance review of a diff: hot paths, N+1, blocking I/O, indexes.',
    whenToUse: [
      'diff is on a hot path or processes data at scale',
      'a latency, throughput or memory regression is suspected',
    ],
    whenNotToUse: [
      'ordinary review → codeReviewAgent',
      'micro-optimisation with no measured regression',
    ],
    inputContract: 'The taskId whose worktree holds the change + which path is believed to be hot and why.',
    outputArtifacts: ['review_report'],
    delegation: 'sync',
    costClass: 'standard',
    // `long`, not `minutes`, from measurement (2026-08-24). The `minutes` class
    // grants a 300s attempt cap, which the store turns into a 296s business
    // window — and BOTH reviewers we have real data for have SUCCEEDED past it:
    // securityReviewAgent 324s, codeReviewAgent 315s. securityReviewAgent's
    // three recorded failures are all `deadline` at exactly 296s, alternating
    // with successes, i.e. a coin flip on a budget the size of the work.
    // performanceReviewAgent is reclassified with them: it is the same workload
    // (read a diff plus the repo, produce a structured verdict) and has exactly
    // one recorded run, so leaving the least-evidenced reviewer on the tighter
    // budget would just hide the same cut until it reviews something large.
    // The asymmetry decides it — an over-wide wall clock costs latency on a hang
    // (and liveness, not the clock, is what detects hangs), while an under-wide
    // one deterministically kills work that was going fine.
    latencyClass: 'long',
    examples: [{
      brief: 'Task <id> rewrites the lead search query. Check for N+1 and index coverage; verdict.',
      note: 'Profile before optimising — blocks real regressions, not style preferences.',
    }],
  },

  deliberationAgent: {
    id: 'deliberationAgent',
    oneLiner: 'Structured debate / Design Council: critique, architecture planning, trade-off resolution.',
    whenToUse: [
      'user asks to debate/challenge/compare approaches ("rozważ", "podważ", "oceń warianty")',
      'design/architecture spanning 2+ domains',
      'ambiguous/strategic/high-risk decisions; unclear which agent should execute',
    ],
    whenNotToUse: ['simple lookups, direct edits, executing an already-decided plan, obvious single-domain tasks'],
    inputContract: 'Decision question + options known so far + constraints + what a decision memo must settle.',
    outputArtifacts: ['decision_memo', 'action_plan'],
    delegation: 'sync',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Debate: monorepo vs split repos for the consulting site; decide with migration risks.',
      note: 'Meta NEVER answers architecture/strategy questions itself — this is the router.',
    }],
  },

  researcherAgent: {
    id: 'researcherAgent',
    oneLiner: 'Autonomous open-web research (PSEV): deep-read full pages, extract menus/reviews/facts, triangulate sources.',
    whenToUse: [
      'reading specific websites (menus, reviews, press) — full page content, not snippets',
      'fact triangulation across sources with citations',
    ],
    whenNotToUse: ['simple lookups (meta searchWeb suffices)', 'curated-corpus questions → knowledgeAgent'],
    inputContract: 'URLs or search intent + exactly which facts to extract + output structure.',
    outputArtifacts: ['research_report'],
    delegation: 'both',
    costClass: 'cheap',
    latencyClass: 'long',
    examples: [{
      brief: 'Extract full menu + price ranges + top review themes for restaurant X (URL); cite pages.',
      note: 'Async for long scrapes.',
    }],
  },

  chefAgent: {
    id: 'chefAgent',
    oneLiner: 'Menu engineering & "Księga Menu": brief/URL → recon → client profile → menu → recipes → menu book on disk.',
    whenToUse: ['ANY professional menu/recipe/tasting-menu/catering design task', 'Księga Menu creation/updates'],
    whenNotToUse: ['generic cooking chat that needs no pipeline'],
    inputContract: 'Brief OR restaurant URL + cuisine/constraints; chefAgent runs recon→profile→menu→recipes autonomously.',
    outputArtifacts: ['menu_book_ref', 'document'],
    delegation: 'sync',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Modernize the menu for restaurant X (URL): recon menu+reviews, then propose new card + 5 recipes into Księga.',
      note: 'One delegation — never decomposed by meta.',
    }],
    hardRules: [
      // The rule used to read "ALWAYS one chefAgent delegation — NEVER a
      // codingAgent script, NEVER direct Mongo/file writes", and a planner
      // reading it split a menu job into research → chef anyway: both of its
      // clauses are about WHO MAY WRITE chef data, and a plan whose final step
      // is a chefAgent delegation satisfies them literally. Measured on the live
      // decider, 5 runs per variant: with this wording the same goal returns one
      // dispatch 5/5; with the old one it returned research → chef 5/5.
      'A menu/restaurant/Księga goal is ALWAYS ONE step — never put a research or analysis step in front of chefAgent, even when the goal names a website. chefAgent runs its own recon by delegating to researcherAgent under a strict JSON contract its importer reads; generic research handed to it instead is unusable.',
      'Menu/restaurant/Księga work is chefAgent-exclusive — NEVER a codingAgent script, NEVER direct Mongo/file writes.',
      'Chef Mongo collections + Menu Book files are chefAgent-exclusive.',
    ],
    // `recon` delegates Mission A (menu) and Mission B (reputation); see
    // prompts/chef/pipeline.md and prompts/research/menu-recon.md.
    runsInternally: ['researcherAgent'],
  },

  contentAgent: {
    id: 'contentAgent',
    oneLiner: 'Multi-platform social content: LinkedIn + Instagram + TikTok posts, captions, scripts, image prompts, weekly plans.',
    whenToUse: ['"napisz post / kontent / karuzela / reel / TikTok / content na tydzień"', 'Content Pack production'],
    whenNotToUse: ['cold email / CRM marketing → marketingAgent', 'long-form articles/books → writerAgent'],
    inputContract: 'Platforms + piece count + theme; grounded in strategy notebook + RSS signals automatically.',
    outputArtifacts: ['content_pack'],
    delegation: 'sync',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Weekly content: 2×LinkedIn + 3×IG + 1×TikTok on menu-engineering theme; PL; with image prompts.',
      note: 'Owns virality/strategy grounding — meta never writes social copy.',
    }],
    hardRules: [
      // Measured 3/3 on the live decider: a content goal naming a website
      // returned research → content. contentAgent owns a `research` phase
      // (`content_fetch_signals` + its own delegation) and grounds drafts in the
      // strategy notebook; research handed to it from outside bypasses both.
      'A content goal is ONE step — never put a research step in front of contentAgent. It runs its own research/strategy phase and grounds drafts in the strategy notebook + RSS signals.',
    ],
    // prompts/content/pipeline.md:80 — the `research` phase delegates.
    runsInternally: ['researcherAgent'],
  },

  huntAgent: {
    id: 'huntAgent',
    oneLiner: 'Lead hunting + compliant cold outreach: discovery → scoring → enrichment → verified emails → drafts → CRM.',
    whenToUse: ['"znajdź dostawców / producentów / leady / hunt / cold mail do firm" from free-form intent'],
    whenNotToUse: ['single-lead lookup → crmAgent', 'pipeline ops on existing deals → salesAgent'],
    inputContract: 'Free-form intent with segment + region + count (e.g. "5 goat-cheese producers near Wrocław supplying restaurants").',
    outputArtifacts: ['lead_batch', 'email_draft', 'crm_update'],
    delegation: 'sync',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Find 3 Italian-product importers for a Warsaw client; qualify, enrich, draft PL cold emails.',
      note: 'Drafts only (RODO/GDPR-gated); never sends. PL market first-class.',
    }],
    hardRules: [
      // Caught by re-measuring the live decider after the chef/content/writer
      // rules were added: the longer menu moved this goal from one dispatch to
      // hunt → marketing, 3/3. huntAgent's own `draft`, `assemble` and `ship`
      // phases already validate drafts, create Gmail drafts and write the CRM
      // (config/pipeline-phase-tools.ts), so a marketing step after it repeats
      // all three — against a live mailbox and a live CRM, which is where "one
      // redundant step" stops being a wasted run.
      'A lead-hunting goal is ONE step — huntAgent runs discovery through drafting, Gmail drafts and CRM writes itself. Never add an outreach, drafting or CRM step after it; that duplicates writes to a real mailbox and a real CRM.',
    ],
    // `discover` and `enrich` delegate — prompts/hunt/pipeline.md:72, :87.
    runsInternally: ['researcherAgent', 'knowledgeAgent'],
  },

  designAgent: {
    id: 'designAgent',
    oneLiner: 'Local AI Image Generation (ComfyUI / txt2img / Pa1rykman LoRA / fantasy covers / marketing visuals) & High-fidelity UI design: HTML prototypes, decks, infographics, animations, exports.',
    whenToUse: [
      '"wygeneruj obraz / portret / grafikę / okładkę w ComfyUI / lokalnie"',
      'Local AI image generation in ComfyUI (Krea2, LoRA pa1rykman, face-detailer, fantasy/anime, portraits)',
      '"zaprojektuj landing / prototyp / slajdy / animację / infografikę"',
      'editable PPTX decks, launch animations, 5-dimension design critique',
    ],
    whenNotToUse: [
      'production app code in a repo → codingAgent (only when explicitly asked to implement)',
      'video generation → filmmakerAgent',
      'never write ad-hoc Python/curl scripts from metaAgent to invoke ComfyUI — delegate to designAgent',
    ],
    inputContract: 'Image prompt/subject/aspect-ratio OR deliverable type + brand/content constraints + export format.',
    outputArtifacts: ['media_ref', 'document'],
    delegation: 'both',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [
      {
        brief: 'Generate a dark anime fantasy warrior 16:9 illustration in ComfyUI with portrait LoRA to fantasy-covers.',
        note: 'Invokes comfyui-generate-image tool, applies optical prompt rules, saves to media/generations/.',
      },
      {
        brief: 'Landing prototype (HTML) for GastroBridge audit offer; brand colors; export PDF one-pager too.',
        note: 'Includes AI image generation + ElevenLabs narration pipelines. Full builds: prefer async:true.',
      },
    ],
    hardRules: [
      'ALWAYS delegate any image/graphic generation request mentioning ComfyUI, local AI generation, portraits, LoRA pa1rykman, or fantasy covers to designAgent via delegate_task(agentId: "designAgent"). NEVER write ad-hoc Python scripts or run raw curl/bash commands to trigger ComfyUI directly from meta-agent.',
    ],
  },

  writerAgent: {
    id: 'writerAgent',
    oneLiner: 'Long-form writing & local audio generation: books, chapters, stories, essays; VoiceStudio (OmniVoice) audiobook rendering (PL/EN); manuscript continuity.',
    whenToUse: [
      '"napisz opowiadanie / książkę / rozdział / artykuł / raport", "kontynuuj manuskrypt"',
      '"nagraj audiobook / wygeneruj audio / VoiceStudio / stwórz opowiadanie z głosem"',
      'research-backed or scientific/expert articles with source ledgers',
    ],
    whenNotToUse: ['social posts/captions/reels → contentAgent', 'cold email → marketingAgent'],
    inputContract: 'Genre/format + length + language + style constraints; for continuations name the manuscript; specify audio preferences (PL, EN, or both) if audio requested.',
    outputArtifacts: ['document', 'media_ref'],
    delegation: 'sync',
    costClass: 'standard',
    latencyClass: 'long',
    examples: [{
      brief: 'Write chapter 3 continuing manuscript M, keep canon + style profile; 4k words PL.',
      note: 'Anti-slop + continuity/canon gates built in.',
    }, {
      brief: 'Write sci-fi story and render PL audiobook in VoiceStudio using patryk-polish-voice.',
      note: 'Directly executes voicestudio_render_audiobook with automatic VRAM reclamation.',
    }],
    hardRules: [
      // Same defect as chefAgent's, measured on the same decider: a
      // research-backed article returned research → write 3/3. writerAgent owns
      // a `research` phase whose `writer_prepare_research_delegation` builds the
      // brief and whose `writer_ingest_research_result` reads the answer back
      // into a source ledger — a generic research step in front produces prose
      // that never enters that ledger.
      'A writing goal is ONE step — never put a research step in front of writerAgent. It runs its own research phase and ingests the result into its source/claim ledger.',
      'For VoiceStudio/OmniVoice audio generation tasks, delegate directly to writerAgent which authors the formatted script with phonetics and directly triggers voicestudio_render_audiobook.',
    ],
    // prompts/writer/pipeline.md:74 — `system_delegate_task` targetAgent researcherAgent.
    runsInternally: ['researcherAgent'],
  },

  filmmakerAgent: {
    id: 'filmmakerAgent',
    oneLiner: 'Video studio & Remotion engine: talking head edits, SmartFaceCam, kinetic captions, overlays, storyboard→shots, render delivery.',
    whenToUse: [
      '"wygeneruj wideo / zmontuj odcinek / dodaj napisy / remotion", talking head facecam editing, storyboard-to-video, kinetic karaoke captions',
      'YouTube video pipelines in /projekty/splot-projects/youtube-agent',
    ],
    whenNotToUse: ['static visual/deck assets → designAgent', 'video infra code → codingAgent (explicit only)'],
    inputContract: 'Brief + projectFolder (in /projekty/splot-projects/youtube-agent/videos/) + duration/format; renders output to /projekty/splot-projects/youtube-agent/output/.',
    outputArtifacts: ['media_ref'],
    delegation: 'both',
    costClass: 'premium',
    latencyClass: 'long',
    examples: [{
      brief: 'Assemble episode from /projekty/splot-projects/youtube-agent/videos/odcinek-01: transcribe, generate storyboard with SmartFaceCam and kinetic captions, render MP4.',
      note: 'Async-first long-running pipeline — writes all assets and outputs outside git repo.',
    }],
    // `source_gate` delegates — prompts/film/pipeline.md:44. `reference_map` calls
    // `design_generate_image` as a TOOL, which is not a delegation, so designAgent
    // is deliberately not listed.
    runsInternally: ['researcherAgent'],
  },

  capabilitySmith: {
    id: 'capabilitySmith',
    oneLiner: 'Capability Gap Protocol owner: finds/sandboxes/attaches MCP servers or drives tool builds when the system lacks a capability.',
    whenToUse: [
      'an agent reported "no tool for X" (capability gap) — find or build the missing capability',
      'evaluate/attach a new MCP server (discover → isolated sandbox → human approval → attach)',
    ],
    whenNotToUse: [
      'the capability already exists — check skill_search / agent_board first',
      'one-off coding tasks with no reusable capability → codingAgent',
    ],
    inputContract: 'Describe the GAP (what the system could not do + example task). Smith classifies, searches registry, sandboxes, and STOPS at the human approval gate.',
    outputArtifacts: ['decision_memo', 'action_plan'],
    delegation: 'sync',
    costClass: 'standard',
    latencyClass: 'minutes',
    examples: [{
      brief: 'Gap: hunt cannot read Slack channels. Find an MCP server for Slack, sandbox it, request my approval to attach.',
      note: 'Never attaches without an approved approvalId; secrets only as env var NAMES.',
    }],
    hardRules: [
      'NEVER attach a capability without human approval (status machine enforces awaiting_approval → approved token).',
      'Unknown MCP servers are untrusted: sandbox with mock secrets first, always.',
    ],
  },

  musicianAgent: {
    id: 'musicianAgent',
    oneLiner: 'Music/song/audio generation: lyrics, style prompts, sung/instrumental tracks, remix/extend, take review.',
    whenToUse: ['"wygeneruj piosenkę / utwór / muzykę / beat / instrumental", audio remix/extend, album tracks'],
    whenNotToUse: ['video → filmmakerAgent', 'standalone prose/lyrics without music → writerAgent only if explicitly no audio'],
    inputContract: 'Genre/mood + sung vs instrumental + length + language + optional reference audio.',
    outputArtifacts: ['media_ref'],
    delegation: 'sync',
    costClass: 'premium',
    latencyClass: 'long',
    examples: [{
      brief: 'Write PL lyrics + generate a folk-pop song, 2 takes, pick better, deliver audio.',
      note: 'Paid generation approval-gated (fal async + ElevenLabs sync).',
    }],
    // `source_gate` delegates — prompts/music/pipeline.md:63.
    runsInternally: ['researcherAgent'],
  },
};

/** Delegation enum — replaces the hand-kept z.enum list in delegate-task.ts. */
export const AGENT_BOARD_IDS = Object.keys(agentBoard) as [string, ...string[]];

export function getAgentCard(agentId: string): AgentCard | undefined {
  return agentBoard[agentId];
}
