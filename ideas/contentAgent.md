# Content Agent — implementation plan (workflow → specialized agent)

Goal: build a **content-creation agent** (`contentAgent`) for Instagram, LinkedIn and TikTok
copy + LLM image-generation prompts, modeled 1:1 on the architecture that makes `chefAgent` good.
Move from the linear `weekly-content` workflow to an autonomous, tool-driven, delegating agent.

**`weekly-content` workflow STAYS.** It is not in the way, keeps running as a fallback / cron path.
We *reuse* its deterministic logic by wrapping it in tools, but we **do not delete or modify it**
beyond optionally extracting shared helpers into a lib both can import. Source of truth for the
"moat" pattern: `agentic-agents/src/mastra/agents/chef-agent.ts`,
`prompts/chef/domain.md`, `prompts/chef/pipeline.md`.

---

## Why this works (the moat is architecture, not the model)

ChefAgent's quality comes from five patterns (orchestrator = light `gemini-3.1-flash-lite`, NOT a
flagship). We copy all five:

| Chef pattern | Content equivalent |
|---|---|
| `chef/domain.md` = expert rubric (menu engineering) | `content/domain.md` = copywriting + virality rubric |
| `chef/pipeline.md` = state machine + autonomous-continuation contract | `content/pipeline.md` = content production states |
| Menu Book built section-by-section (external memory, crash-safe) | **Content Pack** built section-by-section |
| NotebookLM (culinary canon) | **`content-strategy` notebook** (how to write + virality) |
| Recipe Library (8.7k recipes, hybrid retrieval) | Best-performing-posts library (Phase 3) |
| `run_worker` + `delegate_task` + `chef_notes` | same primitives, unchanged |

The migration's essence: today orchestration is hardcoded in TS (`weekly-content.ts`, agents called
with `toolChoice:'none'`, `maxSteps:1`). In chef, the **agent** orchestrates via prompt + tools +
a persisted state machine. We replicate that.

---

## Decisions (locked — best quality/effort ratio)

1. **Agent-driven, not a new workflow.** `contentAgent` runs the pipeline through `content/domain.md`
   + `content/pipeline.md` + a state machine persisted to Mongo. Mirror `chef-agent.ts` construction
   exactly (combinePrompts, `maxSteps:150`, thread-scoped `observationalMemory`, `createTokenLimiter`).
2. **Reuse deterministic gold from `weekly-content.ts` by wrapping, not rewriting.** JSON-repair,
   LinkedIn length gate (1000–2200), hashtag normalization, anti-repetition history, fresh-signal
   scoring become tools the agent calls. The workflow keeps its own copies untouched. Where trivial,
   lift pure helpers into `lib/content-shared.ts` and have both import them (no behavior change to the
   workflow).
3. **Image prompts are first-class (Art Director role) — prompts only, no execution.**
   Decided 2026-06-15: *a great prompt is enough.* No image generation/storage in scope, now or
   v1+. A dedicated `art_direction` state + `run_worker(powerful)` produce per-platform, per-model
   image prompts. Kill the `Realistyczny obraz HoReCa dla tematu: X` fallback.
4. **Two knowledge notebooks, two jobs (resolved 2026-06-15).**
   - `content-strategy` (new) = **HOW to write** — user-provided articles on great IG/LinkedIn/TikTok
     content + virality. Direct analog of `chef_query_knowledge`.
   - `docs` (existing alias → "GastroBridge: Przewodnik po Platformie i Dokumentacja Q&A") =
     **WHAT is true** — the single, well-loaded knowledge base about the project AND about Patryk
     (everything publicly shareable). This is THE business/founder fact source; the agent queries it
     via `knowledge_query({notebook:'docs', ...})`. `rynek/konkurencja/rhd` remain available for
     market/competitor freshness but are secondary (RSS covers most of that).
5. **TikTok — full scope** (new vs workflow). Decided 2026-06-15: *everything*. Not just the spoken
   script (hook 0–3s → scenes → on-screen text → CTA → audio/sound suggestion) but also the visual
   production plan: **shot-list, storyboard (scene-by-scene), and B-roll image/video prompts**.
   The Content Pack `tiktok` section carries both the script and the production plan.
6. **Models follow the chef lesson — no blind flagship.** Orchestrator = light cloud (flash-lite);
   heavy creative = `run_worker powerful` (35B); critique = `run_worker reasoning` (30B). Routed via
   `config/model-manifest.ts`.
7. **Content Pack is the external-memory artifact** (analog Menu Book): incremental, crash-resumable,
   persisted to Mongo + disk, rendered at the end.
8. **Differentiator library is curated gold, NOT engagement-derived** (Q5 resolved 2026-06-15).
   We do not have engagement data and we must not feed the library with workflow-generated posts
   (circular, lowers the bar). Solution: seed from **human-curated gold** — an external swipe file +
   the founder's own authentic posts — exactly the way the recipe library was seeded from the user's
   own 8.7k human-authored recipes (gold, not metrics). Engagement becomes an *additive promotion
   gate* later, never the seed. Full design in §"Exemplar library — cold-start design". Build is
   Phase 3; bootstrap voice via few-shot in `domain.md` from day one.
9. **No cron yet, but make scheduling trivial to add later** (Q4 resolved 2026-06-15). Expose a
   single callable entrypoint + a documented switch so a cron/trigger can be wired in minutes when
   wanted. See §"Scheduling (future cron)".

### Non-goals (v1)
- No deletion/refactor of `weekly-content` beyond optional pure-helper extraction.
- No automatic publishing — ship to drafts + calendar reminders, human approves (parity with workflow).
- No image *generation* execution at all (prompts only — decided).
- No engagement-feedback learning loop wired to live metrics (Phase 3, gated + additive).
- No cron/trigger wired now (only the entrypoint + switch made ready).

---

## Architecture overview

```
contentAgent (orchestrator, gemini-3.1-flash-lite, maxSteps 150)
  │  drives state machine via prompt; builds Content Pack incrementally
  ├─ RESEARCH:      content_fetch_signals (RSS digests from Mongo)
  │                 + delegate_task → researcherAgent (deep web research, optional)
  ├─ STRATEGY:      content_query_strategy (notebook 'content-strategy': hooks, virality)
  │                 + knowledge_query (founder/rynek/konkurencja) + content_search_notes
  │                 → weekly angle/format calendar  [checkpoint_strategy]
  ├─ DRAFT:         run_worker(powerful) ×N → LI / IG / TikTok copy variants
  ├─ CRITIQUE:      run_worker(reasoning) → score + best-of-N + editor pass
  ├─ ART_DIRECTION: run_worker(powerful) → image prompts per platform & per image model
  ├─ ASSEMBLE:      content_doc_write_section → Content Pack (crash-safe)
  └─ SHIP:          content_quality_check → content_save_draft → content_schedule
                                            [checkpoint_review before drafts go out]
```

---

## Business grounding — how the agent knows GastroBridge (4 layers)

The agent is grounded in the business through four complementary layers, so every post is built around
GastroBridge without reconstructing positioning ad hoc:

1. **Identity layer — static, always in context (`content/business.md` + `content/domain.md`).**
   Baked into the system prompt → every post is grounded with ZERO queries (cheap, deterministic).
   `business.md` is the **editorial/strategy distillation** (positioning one-liner, ICP + priority,
   messaging pillars, value props + proof points, differentiation vs Choco/Proky/Rekki, current
   quarter focus, CTAs per platform, guardrails, voice fingerprint, branded terms). It deliberately
   does NOT duplicate encyclopedic facts — those live in the `docs` notebook. Skeleton already created
   at `src/mastra/prompts/content/business.md` (Patryk fills it before Phase 1).
2. **Deep-facts layer — retrieval on demand (`docs` NotebookLM notebook).** THE single, well-loaded
   knowledge base about the project + founder (publicly shareable). Agent calls
   `knowledge_query({notebook:'docs', question})` whenever it needs a specific fact (a feature, the
   story, a number). Optional thin wrapper `content_query_business` fixing the notebook id.
3. **Freshness layer — RSS digests from Mongo (`content_fetch_signals`).** Pegs content to what is
   happening now in the market.
4. **Learning layer — `content_notes`.** Accumulated business facts + what worked over time.

Why `business.md` AND the `docs` notebook (not redundant): the notebook answers *"what is true about
GastroBridge/Patryk"* (facts, narrative Q&A, retrieval latency, broad). `business.md` answers *"how do
we position and message it for content"* (editorial decisions a Q&A doc rarely encodes), and it is
always-on in the prompt so the agent never has to query for the strategic frame. Facts → notebook;
strategy/voice/guardrails → `business.md`.

---

## Component 1 — Prompts (≈70% of quality lives here)

### `prompts/content/domain.md` (expert scaffold, NOT a persona)
Direct analog of `chef/domain.md` (164 lines of expertise). Sections:
- **Founder voice** (Patryk, ex-Head Chef who codes) + brand DNA — reuse from `marketing/copy-pl.md`
  and the `founder` notebook, but as *style exemplars with 2–3 real best posts baked in* (few-shot),
  not just adjectives.
- **Hook taxonomy**: pattern-interrupt, contrarian, data-shock, story-open, question-open — with
  when-to-use.
- **Per-platform rules**:
  - LinkedIn (personal vs company): long-form structure, 1000–2200 chars, CTA style, hashtag pool.
  - Instagram: caption + carousel (slide-by-slide) + reel structure, emoji budget, 10–15 hashtags.
  - **TikTok** (new, full scope): hook 0–3s, scene beats, on-screen text, spoken script, CTA, sound
    suggestion — PLUS production plan: shot-list (shot type WS/MS/CU, angle, movement), storyboard
    (scene-by-scene description), and B-roll image/video generation prompts.
- **Virality principles**: retention, shareability, saves>likes, comment-bait, hook density.
- **Hashtag strategy**: research/trend-driven mix (big/medium/niche), not a static pool.
- **Art-direction principles**: brand visual identity, per-model prompt syntax
  (Flux / SDXL / Midjourney / DALL-E / "Nano Banana"), aspect ratios (LI 1.91:1, IG 4:5 & 1:1,
  story/reel/TikTok 9:16), negative prompts, carousel = N coherent frames.
- **Knowledge routing contract**: when to query `content-strategy` (HOW to write) vs project
  notebooks (WHAT is true) vs `content_fetch_signals` (WHAT is fresh) vs `content_search_notes`
  (what worked before). Anti-hallucination: keep `no-current-source` discipline from `research.md`.

### `prompts/content/pipeline.md` (state machine + autonomous continuation)
Analog of `chef/pipeline.md`. States:
`intake → research → strategy → checkpoint_strategy → draft → critique → art_direction → assemble
→ checkpoint_review → ship → done`.
- **Autonomous continuation contract** (the exact rule that stops chef from stalling): chain tool
  calls without pausing; only the two checkpoints ask the user. Stalling at a non-checkpoint state is
  a defect. After each `content_doc_write_section`, set next status and continue.
- Resume contract: on restart, read project status from Mongo and continue from the last state.

Loaded via `combinePrompts('content/business', 'content/domain', 'content/pipeline')` — business brief
first (the strategic frame), then craft rules, then the state machine. Same mechanism as chef.

---

## Component 2 — NotebookLM `content-strategy` notebook

Mechanism already exists (`tools/knowledge/notebooklm-client.ts`, `knowledge-tools.ts`).

Steps:
1. Add alias in `NOTEBOOK_TITLE_ALIASES` (`notebooklm-client.ts`):
   `'content-strategy': 'ContentStrategy - Social Media & Virality'` (final title TBD by user).
2. Add `'content-strategy'` to `KNOWN_NOTEBOOKS` (`knowledge-tools.ts:11`).
3. User populates the notebook with articles on IG/LinkedIn/TikTok writing + virality.
4. Agent (STRATEGY state) calls `knowledge_query({ notebook:'content-strategy', question })` — direct
   analog of `chef_query_knowledge`. Optionally a thin `content_query_strategy` wrapper that fixes the
   notebook id and shapes the question.

---

## Component 3 — RSS digests from Mongo (already built, just wrap)

DB `rss_intelligence`, collections `content_signals` + `rss_articles` + `digests`.
Reuse `searchFreshContentSignals()` (`lib/content-signals.ts`) and `rss_get_digests`
(`tools/rss/rss-tools.ts`). New tool `content_fetch_signals` wraps both:

```ts
// tools/content/content-signals-tool.ts
content_fetch_signals: {
  input:  { weekDate?: string, language?: string, limit?: number, minRelevance?: number, excludeUsed?: boolean }
  output: { signals: FreshContentSignal[], digests: {subject,body}[] }
}
```
Signals already carry `hooks[]`, `bestAngles[]`, scoring — ideal STRATEGY input.

---

## Component 4 — Delegation primitives (both exist; reuse unchanged)

- **`run_worker`** (`tools/system/run-worker.ts`): clean model, presets `fast/default/reasoning/powerful/cloud`,
  `taskBrief` IS the system prompt, supports retry via `previousAttempt`. Used for copy batches
  (`powerful`), critique (`reasoning`), image-prompt crafting (`powerful`), EN adaptation.
- **`delegate_task`** (`tools/system/delegate-task.ts`): to specialist agents w/ tools+memory. Used for
  deep web research via `researcherAgent`. **Must add `contentAgent` to the target enum**
  (`tools/system/delegate-task.ts` + `config/subagent-roles.ts` if relevant).

---

## Component 5 — Content Pack (external memory; clone Menu Book tooling)

New `tools/content/content-document-tools.ts`, cloned from `tools/chef/chef-document-tools.ts`:
`content_doc_init / content_doc_write_section / content_doc_status / content_doc_render`.
Anchor sections: `brief, research, strategy (calendar+angles), linkedin, instagram, tiktok,
image-briefs, distribution`. Gives crash-recovery, auditability, incremental build with critique
(not one-shot generation). Persist to Mongo collection `content_projects` + disk render
(reuse `lib/drafts-store.ts` for the per-post drafts).

---

## Component 6 — Learning loop (clone chef_notes)

`content_add_note / content_search_notes` (types: `winning-hook, voice, format-insight,
engagement-feedback`). Mongo collection `content_notes`, optional bge-m3 semantic search with regex
fallback (same resilience pattern as chef notes). Phase 3 feeds real metrics here.

---

## Tools spec — reuse vs new

**Reuse as-is (system/shared):** `run_worker`, `delegate_task`, `knowledge_query`,
`knowledge_query_multi`, `current_time`, `memory_recall`, `memory_write`, `add_context`,
`request_approval`, `calendar_create_event`.

**New (under `tools/content/`):**
| Tool | Purpose | Backed by |
|---|---|---|
| `content_start_project` / `content_set_status` | state machine persistence | new `content_projects` collection (clone chef status tool) |
| `content_get_project` / `content_list_projects` | resume / inspect | same |
| `content_fetch_signals` | RSS digests from Mongo | `searchFreshContentSignals` + `rss_get_digests` (wrap) |
| `content_query_strategy` | query `content-strategy` notebook | `knowledge_query` (wrap, fixed notebook) |
| `content_doc_*` | Content Pack assembly | clone `chef-document-tools.ts` |
| `content_quality_check` | length/hashtag/voice/anti-repetition gates | lift logic from `weekly-content.ts` (do not modify workflow) |
| `content_save_draft` | persist drafts + FIX observability bug | `lib/drafts-store.ts` (write real model+cost, not hardcoded `gemma`/`0`) |
| `content_schedule` | calendar reminders | `calendar_create_event` |
| `content_add_note` / `content_search_notes` | learning loop | new `content_notes` collection |

**Helpers to optionally lift into `lib/content-shared.ts`** (pure, no behavior change; workflow can
import the same): `extractJsonText`, `tryParseJson`, `normalizeHashtags`, `cleanGeneratedText`,
length-gate predicates, anti-repetition history loader. If extraction risks touching the workflow,
prefer copying into the tool instead — workflow stays frozen.

---

## Agent file (clone chef-agent.ts)

`agentic-agents/src/mastra/agents/content-agent.ts`:
```ts
export const contentAgent = new Agent({
  id: 'content-agent',
  name: 'Content Agent',
  instructions: await combinePrompts('content/business', 'content/domain', 'content/pipeline'),
  model: resolveModelId(agentModels.contentAgent),   // add to model-manifest
  defaultOptions: { maxSteps: 150 }, /* + legacy/network mirrors as in chef */
  memory: new Memory({ options: {
    lastMessages: 20,
    observationalMemory: { model: resolveModelId(infrastructure.observationalMemory),
      scope: 'thread', temporalMarkers: true,
      observation: { threadTitle: true, providerOptions: { google: { thinkingConfig: { thinkingBudget: 1024 } } } } },
    generateTitle: true,
  }}),
  inputProcessors: [ createTokenLimiter(120_000) ],
  tools: { /* content_* + system/shared tools listed above */ },
});
```

### Registration — fully independent agent, delegatable by meta (parity with chefAgent)
`contentAgent` is a self-contained agent (own id, instructions, tools, memory) like `chefAgent`. It
does not depend on other agents to exist; it only *reuses* shared system primitives (`run_worker`,
`delegate_task → researcherAgent`, `knowledge_query`). Wiring so meta can delegate to it:
- `config/model-manifest.ts`: add `agentModels.contentAgent` (flash-lite) + any worker tiers.
- `src/mastra/index.ts`: import + register `contentAgent` in the agents map.
- `tools/system/delegate-task.ts`: add `'contentAgent'` to the `targetAgent` enum (line ~96), to the
  `AGENT_IDS` map, and a one-line domain entry in the tool description block (where `chefAgent` is
  listed, ~line 84).
- `prompts/meta/base.md`: add a routing row in the delegation table (where `chefAgent` is, ~line 31)
  **and** a routing rule, mirroring the chef ownership boundary (~lines 33–39): content/social tasks
  are ALWAYS a single `system_delegate_task(contentAgent)` call; meta does not write content itself.
- `prompts/meta/intent-router.md`: add the routing entry too (router + base.md must agree).

**Routing disambiguation vs `marketingAgent` (important — avoid overlap).** Today `marketingAgent`
is described as "Polish copy, social". To keep meta routing unambiguous, split ownership explicitly:
- `contentAgent` OWNS multi-platform **content production**: LinkedIn + Instagram + TikTok posts,
  image prompts, the Content Pack, weekly content planning. Any "napisz post / kontent / karuzela /
  reel / TikTok / content na tydzień" → `contentAgent`.
- `marketingAgent` keeps cold-emails, producer-hunt, RSS digest creation, Gmail drafts, CRM-side
  marketing. It no longer owns weekly social content production.
Update both `marketingAgent`'s and `contentAgent`'s descriptions in `delegate-task.ts` + `meta/base.md`
so the boundary is explicit. (`weekly-content` workflow stays as-is regardless.)

---

## Migration (workflow stays alive)

1. `weekly-content` keeps running untouched.
2. Build `contentAgent` in parallel; register it.
3. Cron/scheduler can call the agent with a standard brief
   ("prepare weekly content: 5 LI, 3 IG, 2 TikTok") instead of the workflow — switchable.
4. When agent quality ≥ workflow, optionally point the cron at the agent; the workflow remains as a
   deterministic fallback. No deletion.

---

## Phases

- **Phase 0 — Foundation:** `content/domain.md` + `content/pipeline.md`, notebook alias, agent file
  (clone chef), registration (manifest/index/delegate enum/intent-router), state-machine tools
  (`content_start_project/set_status/get/list`). → agent talks and holds state.
- **Phase 1 — Core E2E:** `content_fetch_signals`, `content_query_strategy`, Content Pack tools,
  `content_save_draft` (+ observability fix), `content_quality_check`, `content_schedule`. → generates
  + saves LI/IG end-to-end through the agent.
- **Phase 2 — "Genius":** critique/best-of-N via `run_worker(reasoning)`, dedicated Art Director
  (per-model image prompts), **full TikTok** (script + shot-list + storyboard + B-roll prompts),
  `content_notes` learning loop.
- **Phase 3 — Differentiator (exemplar library):** build `content_exemplars` from curated gold
  (swipe file + founder voice corpus), hybrid retrieval cloned from `recipe-library-service.ts`,
  `content_search_exemplars` tool + auto-inject at DRAFT stage. Engagement-promotion gate +
  `content_import_engagement` (manual CSV) are additive and optional. Semantic anti-repetition
  (embeddings) lands here too. See §"Exemplar library — cold-start design".

---

## Test plan

1. **Phase 0:** agent boots, registered, `delegate_task` to it works, status persists+resumes after
   a simulated crash (kill mid-run, restart, continues from last state).
2. **Phase 1:** dry-run a week → Content Pack rendered with all anchors, N drafts saved with correct
   metadata (real model+cost, not hardcoded), calendar reminders created. Compare output parity vs
   `weekly-content` on the same `weekDate`.
3. **Phase 2:** critique gate measurably rejects/raises weak drafts (log scores); image prompts vary
   per model+platform and pass a manual rubric; TikTok scripts have all beats.
4. **Phase 3:** retrieval recall on a gold set of past posts; ablation showing notes/library biasing
   selection.

Add an eval harness like chef's `eval-recipe-retrieval.ts` when Phase 3 retrieval lands.

---

## Risks / where quality actually comes from (be honest)

- **Quality lives in `content/domain.md` + the `content-strategy` notebook contents.** Everything else
  is plumbing copied from chef. Underinvesting in the rubric or shipping a thin notebook = mediocre
  output regardless of wiring.
- **Long autonomous runs**: rely on the autonomous-continuation contract + token limiter (chef proved
  it). Without `maxSteps` budget the agent stalls mid-pipeline.
- **Don't blind-swap to flagship models** (cost × many worker calls; knowledge ceiling = notebook, not
  model). Tiered escalation only.
- **Workflow safety**: prefer copying helpers into tools over editing `weekly-content.ts`; if lifting
  into `lib/content-shared.ts`, run the workflow's path after to confirm zero behavior change.

---

## Resolved decisions (answers locked 2026-06-15)

1. **Image execution → prompts only.** A great prompt is enough. No generation/storage, ever in scope.
2. **TikTok scope → everything.** Script + shot-list + storyboard + B-roll prompts (see Decision 5).
3. **`content-strategy` notebook → keep the name `content-strategy`.** Alias points to it; the user
   creates the notebook and adds the article links. Curation: this plan provides the starter link list
   (see §"Knowledge base — starter articles"); the user adds them as sources in NotebookLM.
4. **Cron → none now, but make it trivial later.** Build a callable entrypoint + documented switch
   (see §"Scheduling (future cron)").
5. **Best-posts library → curated gold, not engagement data.** Cold-start solved via swipe file +
   founder voice corpus; engagement is an optional additive promotion gate (see §"Exemplar library —
   cold-start design").

---

## Exemplar library — cold-start design (Q5 resolved)

**The problem.** Phase 3 wants a "best-performing-posts" library (the analog of chef's 8.7k-recipe
library). But (a) there is no engagement data, and (b) feeding it with `weekly-content`-generated
posts is circular and would *lower* the quality bar.

**The insight.** The recipe library was never metric-derived — it was seeded from the user's own
**human-authored gold** (8.7k real recipes). Quality came from curation, not analytics. Apply the
same principle: **decouple the quality bar from engagement metrics.** Seed from curated gold now;
let engagement become an *additive* gate later that can only *raise* the bar, never seed it.

**Two curated gold corpora (zero engagement data needed):**
1. **Swipe file (external exemplars).** Hand-picked excellent/viral posts from adjacent niches
   (founder & build-in-public, foodtech, HoReCa, B2B). Carries proven STRUCTURE / HOOK / FORMAT
   patterns. Does NOT carry Patryk's voice — that is fine, it is a pattern bank.
2. **Voice corpus (founder's own).** Patryk's own authentic best writing (posts he wrote himself
   pre-workflow, anything he is proud of, or transcripts from the `founder` notebook). Hand-picked
   for VOICE. ~10–30 entries is enough.

**Storage & retrieval (clone recipe-library-service.ts).** One Mongo collection `content_exemplars`,
each doc: `text`, `platform`, `hookType`, `format`, `whyItWorks`, `source` (`swipe`|`voice`|`proven`),
`qualityScore` (manual 0–1, NOT engagement), `embedding` (bge-m3), `embeddingTextHash`, `lang`.
Hybrid retrieval identical to recipe library: pre-filter → cosine leg + `$text` leg → RRF(k=60) →
rerank (×qualityScore, platform/stage boost) → dedup. Exposed as `content_search_exemplars` +
auto-injected at the DRAFT stage so the agent always pattern-matches against gold.

**Distinction vs the `content-strategy` notebook.** Notebook = *theory* (articles on how to write /
why things go viral). Exemplar library = *concrete artifacts* (actual example posts for pattern
retrieval). Complementary, not redundant.

**Quality guardrail (answers the user's worry directly).** Nothing auto-enters `content_exemplars`.
Entry requires EITHER human curation (`swipe`/`voice`) OR — later — `source:'proven'`: a published
post that exceeded an engagement threshold AND passed a human approval gate. Agent/workflow output
can **never** auto-feed the library. Structurally impossible to dilute quality.

**Bootstrap before Phase 3.** Until the library exists, voice is bootstrapped by baking 2–3 real
founder posts as few-shot exemplars directly into `content/domain.md`. The library is the *scaled*
version (hundreds of retrievable exemplars, most-relevant-per-topic) of that same idea.

**Engagement data, when/if it appears (deferred, additive).** Simplest path = manual CSV export from
LinkedIn/Instagram analytics → tool `content_import_engagement` matches rows to drafts by
`draftId`/url → flags high performers for human review → approved ones promoted to `content_exemplars`
as `source:'proven'`. Upgrade to LI/IG API or the operational dashboard later. The library is fully
functional with zero engagement data; this path only adds real-world winners on top.

---

## Knowledge base — starter articles for the `content-strategy` notebook

User creates the NotebookLM notebook titled `content-strategy` and adds these as sources. Grouped by
theme. These are vetted starting points — skim and drop any that read as thin product pitches; the
notebook quality directly caps output quality (§Risks).

**Virality — theory / psychology (Jonah Berger STEPPS):**
- https://knowledge.wharton.upenn.edu/article/contagious-jonah-berger-on-why-things-catch-on/
- https://unruly.co/blog/article/2015/10/26/jonah-berger-6-key-stepps-to-creating-contagious-content/
- https://www.searchlaboratory.com/2014/07/contagious-content-stepps-and-the-science-of-shareability/

**Copywriting frameworks (AIDA / PAS / BAB + storytelling):**
- https://www.hivedigital.com/blog/writing-frameworks-for-marketing-content/
- https://monolit.sh/blog/copywriting-formulas-social-media-aida-pas-bab-explained
- https://www.animusstudios.com/blog/ad-formats-and-structures-combining-copywriting-formulas-with-storytelling-frameworks

**LinkedIn (hooks, frameworks, founder personal brand):**
- https://www.outx.ai/blog/linkedin-post-hook-examples
- https://usevisuals.com/blog/top-frameworks-for-viral-linkedin-hooks
- https://www.justinwelsh.me/article/how-to-build-personal-brand-on-linkedin
- https://superpen.io/blog/justin-welsh-linkedin-strategy/

**Instagram (captions, carousels, engagement):**
- https://metricool.com/instagram-carousels/
- https://creatorflow.so/blog/instagram-carousel-posts-guide/
- https://www.krumzi.com/blog/how-to-write-social-media-captions-that-actually-get-engagement-2026-guide
- https://glowsocial.com/blog/social-media-caption-length

**TikTok (hooks, retention, script structure):**
- https://www.opus.pro/blog/tiktok-hook-formulas
- https://sendshort.ai/guides/tiktok-hooks/
- https://www.retiplex.com/blog/how-to-write-tiktok-scripts
- https://virvid.ai/blog/ai-shorts-script-hook-ultimate-guide-2026

**Short-form video production (storyboard / shot-list / B-roll — for full TikTok scope):**
- https://www.studiobinder.com/templates/shot-list/b-roll-shot-list-template/
- https://boords.com/shot-list-template
- https://blog.celtx.com/how-to-storyboard-a-video/
- https://www.techsmith.com/blog/shot-list/

> Note: NotebookLM ingests URLs as sources. For paywalled/JS-heavy pages that import poorly, paste the
> article text as a text source instead. Re-run notebook curation periodically as tactics drift
> (platform algorithms change yearly).

---

## Scheduling (future cron) — ready but not wired

No cron now. Make it a one-liner later:
1. Expose a single callable entrypoint, e.g. `runContentAgentWeekly(brief)` in
   `agentic-agents/src/mastra/entrypoints/content-agent-run.ts`, that builds a standard brief
   ("prepare weekly content: N LI, M IG, K TikTok for week X") and invokes `contentAgent`.
2. Document a switch (env flag `CONTENT_AGENT_CRON_ENABLED` + a commented trigger registration) so a
   scheduled trigger (the project's existing trigger/cron mechanism) can call that entrypoint when the
   user wants recurrence. Until then it is invoked manually / on demand.
3. `weekly-content` workflow keeps its own (current) scheduling untouched.
