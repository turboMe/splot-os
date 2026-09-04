# Chef Agent — Menu Engineering & "Księga Menu" (Menu Book)

> **Phase:** E3 (chef-agent-dev-plan) — polish (PDF render, menu scorer, failure-brain, recon budgets)
> **Status:** ✅ Implemented + verified (components live; full agent-driven E2E = runtime)
> **Date:** 2026-06-12

A domain agent that designs professional menus and recipes. From a brief OR a
restaurant URL → recon (menu + reviews) → client profile → menu → recipes →
an incrementally-built **Menu Book** (Markdown document on disk).

> **Language note:** all source, prompts, tool descriptions and docs are in English.
> Only the **Menu Book artifact content** (section titles, rendered Markdown labels,
> placeholders) stays Polish on purpose — it is a deliverable for Polish restaurant clients.

## Architecture

```
metaAgent
  └── system_delegate_task(chefAgent)        ← meta no longer holds chef tools
        ├── chef_* (domain tools: profile, menu, recipes, notes, pairings)
        ├── chef_search_recipe_library (chef's own ~8.7k-recipe repertoire; hybrid vector+lexical)
        ├── chef_import_website_profile (recon→profile: mapper avgMain→tier, difficultyTarget…)
        ├── chef_set_project_status (state machine: 11 pipeline statuses)
        ├── chef_document_* (init / write_section / status / render)   ← Menu Book
        ├── chef_export_menu_book (menu + recipes → Menu Book sections)
        ├── reviews_google_place (Places API New, reputation recon)
        ├── knowledge_query / _multi (culinary corpus NotebookLM: chef_*)
        ├── delegate_task → researcherAgent   (Mission A: menu recon, Mission B: reputation)
        └── system_run_worker (reasoning/powerful)  (critic gate, recipe batch, mapping)
```

**Model:** `gemini-3.1-flash-lite-preview` (decision D-M1) — lightweight, reliable
tool-calling. Heavy generation is delegated to a worker (`powerful`).

## "Menu Book" pipeline — state machine (11 statuses)

Status is tracked with `chef_set_project_status` (persisted to DB → the pipeline is
resumable and auditable). Two hard `request_approval` checkpoints stop the pipeline for sign-off.

```
intake → recon → profile_synthesis → checkpoint_profile → menu_draft
                                                              │
done ← render ← qa_final ← recipes ← checkpoint_menu ← critic_gate
```

| Status | What it does | Executor / tools |
|---|---|---|
| `intake` | detects the input (conversation vs URL); Menu Book skeleton | `chef_start_project`, `chef_document_init` |
| `recon` | Mission A (menu) + Mission B (reviews) IN PARALLEL | `delegate_task→researcherAgent`, `reviews_google_place` |
| `profile_synthesis` | recon→profile (mapper) + gap filling | `chef_import_website_profile`, `run_worker(fast)` |
| `checkpoint_profile` | **GATE #1** — profile sign-off | `request_approval` |
| `menu_draft` | menu composition done PERSONALLY per domain.md | `chef_generate_menu`, `chef_save_menu` |
| `critic_gate` | validate menu vs profile (fresh eyes) | `run_worker(reasoning)` + `chef_iterate_menu` |
| `checkpoint_menu` | **GATE #2** — menu card sign-off | `request_approval` |
| `recipes` | technical recipe cards IN PARALLEL (batch 4-6/turn) | `run_worker(reasoning)`, `chef_draft_recipe`, `knowledge_query(chef_classic)` |
| `qa_final` | completeness, allergen matrix, unit lint | `getRecipesByProject`, `chef_document_status` |
| `render` | artifact finalization + control compile | `chef_document_render`, `chef_export_menu_book` |
| `done` | pipeline closed | `chef_set_project_status(done)` |

Transitions are **autonomous** (apart from the two checkpoints) — once the state data is
complete, the agent sets the status and enters the next one. Rule: **write the Menu Book
section FIRST, report AFTER**. Full spec (critic and recipe briefs, anti-patterns):
`src/mastra/prompts/chef/pipeline.md` + researcher mission briefs
`src/mastra/prompts/research/menu-recon.md` (A) and `reputation-recon.md` (B);
domain rules in `domain.md`.

## Menu Book — incremental document

File `<projectId>.md` in `CHEF_DOCS_DIR` (default `/projekty/splot-projects/menu-books`),
built section-by-section as the project progresses (NOT in one shot at the end).

**8 canonical sections** (skeleton from `chef_document_init`, anchored with HTML comments):
`overview`, `profile`, `recon`, `menu`, `recipes`, `pairings`, `allergens`, `notes`.

**Dynamic sections** (E2, appended on first write — validated by `ANCHOR_PATTERN`):
`recipe:<slug>` (e.g. `recipe:short-rib` → title "Receptura: short rib") and the plan's
narrative sections: `title`, `research-brief`, `concept`, `menu-card`, `allergen-matrix`,
`insights`, `appendix`.

Sections are anchored by a `<!-- section:ANCHOR start -->` … `<!-- section:ANCHOR end -->`
pair. `chef_document_write_section` replaces (`mode:'replace'`, default) or appends
(`mode:'append'`) the content between the markers (**idempotent upsert** — safe to call
repeatedly, does not duplicate the anchor). `append` mode is for incremental building
(e.g. successive `recipe:<slug>` = successive separate writes → proof of incrementality).
Path-traversal guard: `projectId` is sanitized + the path must stay under `CHEF_DOCS_DIR`.

### Document tools

| Tool | Action |
|---|---|
| `chef_document_init` | creates the Menu Book skeleton (idempotent — does not overwrite an existing one) |
| `chef_document_write_section` | writes/updates 1 section by anchor |
| `chef_document_status` | progress `filled/total` (e.g. 3/8) + `missing` list |
| `chef_document_render` | returns the full file content |
| `chef_document_pdf` | renders the Menu Book to a print-ready PDF via headless Chromium (E3) |
| `chef_export_menu_book` | assembles the latest menu + `getRecipesByProject` → `menu`/`recipes` sections |

## PDF render (E3, D-R1)

`chef_document_pdf` renders `<projectId>.md` → `<projectId>.pdf` via headless Chrome
(`CHEF_CHROME_BIN`, default `google-chrome-stable`, `--headless=new --print-to-pdf`).
Markdown → HTML uses `micromark` + `micromark-extension-gfm`, so **GFM tables become real
bordered `<table>`s** — critical for recipe BOM tables and the allergen matrix. Print CSS
is A4-tuned (margins, `page-break-inside:avoid` on tables, font fallback for Polish glyphs).
Section anchors are stripped before rendering; the temp HTML is cleaned up afterwards.

> **Gotcha:** a Markdown pipe table only renders as a real table if it has the GFM
> separator row (`| --- | --- |`). Without it the pipes render as literal text — recipe
> BOM tables MUST include the `|---|---|` divider.

## Menu quality scorer (E3)

`scoreChefMenu(menu, profile?)` (`scorers/chef-agent-scorer.ts`) is a **deterministic**
(no LLM judge, reproducible) rubric over a `ChefMenu`, encoding the `domain.md` rules:

| Dimension | Rule |
|---|---|
| `schemaValidity` | each dish has name/description/ingredients/techniques |
| `progression` | temperature/intensity arc across courses (coverage + variety) |
| `textures` | ≥3 distinct textures per dish |
| `techniques` | ≤2 dishes per technique type, never consecutive |
| `dietaryPaths` | parallel vegetarian / gluten-free paths exist (declared restrictions when a profile is given) |
| `difficultyParity` | within ±1 of `profile.difficultyTarget.score` (skipped + weight redistributed when absent) |

Weighted overall in [0,1], pass threshold `0.70`. `chefMenuQualityScorer` is a thin
`createScorer` wrapper (deterministic `analyze` function) registered in `index.ts`.

## Failure-brain lessons (E3)

`scripts/seed-chef-lessons.mjs` seeds 7 chef-pipeline lessons into `system_knowledge`
(`failure_case` / `prompt_rule` / `tool_contract`) via `writeKnowledge` (idempotent, dedup
by type+title), so chefAgent surfaces them via `memory_recall`. Covers: incremental document
writes, status on every transition, recipes-after-approval, no direct scraping / single-writer,
verify classic ratios, `execute(context)` contract, GFM separator row for BOM tables.

## Recon cost guards (E3, R4)

`budget-tracker.ts` registers metered recon providers `tavily` / `places` / `firecrawl`
with daily request caps (env `TAVILY_DAILY_LIMIT` / `PLACES_DAILY_LIMIT` /
`FIRECRAWL_DAILY_LIMIT`, alert at 80%). `reviews_google_place` is guarded:
`isOverBudget('places')` → degrade to the researcher; `recordRequest('places', …)` after
each API call. Wiring Tavily/Firecrawl (researcher tools) is a follow-up on the researcher side.

## Pipeline (E2) — recon→profile synthesis and the state machine

| Tool | Action |
|---|---|
| `chef_import_website_profile` | deterministic recon→profile mapper: `avgMain → priceRange.tier` (PLN thresholds via env `CHEF_PRICE_TIER_PLN`, default `35,70,130` → budget/mid/premium/luxury), `difficultyTarget` (parity ±1), `currentMenuRef` (snapshot), `cuisineTypes`, `identity.signatureDishes` (from reputation). Persisted via `updateProfile` (deepMerge), returns `missingFields`. |
| `chef_set_project_status` | sets 1 of 11 pipeline statuses (`intake…done`); called on every phase transition |

Extended data model (`ChefProfile`): `difficultyTarget {score, rationale}` +
`currentMenuRef {url, format, avgMainPrice, currency, dishCount, styleNotes, difficultyScore, capturedAt}`.
Mapper inputs = the Mission A (`CurrentMenuAnalysisSchema`) and Mission B (`ReputationSchema`) contracts.

## reviews_google_place — reputation recon

Google Places API (New) `places:searchText` (headers `X-Goog-Api-Key` + `X-Goog-FieldMask`).
Returns rating, review count, price level and up to 5 reviews. **Graceful degradation:**
without `GOOGLE_MAPS_API_KEY` → `{ success:false, degraded:true, hint }` (chefAgent gathers
reviews via `delegate_task → researcherAgent`). 403 → hint to enable "Places API (New)" in GCP.

## Registration (4 points)

| File | What |
|---|---|
| `index.ts` | import `chefAgent` + entry in the `agents` map |
| `config/model-manifest.ts` | `agentModels.chefAgent` |
| `tools/system/delegate-task.ts` | `AGENT_IDS` + `targetAgent` enum + description (routing: generic "direct generate", no harness) |
| `prompts/meta/base.md` | delegation table row + routing paragraph |

> **Note:** domain agents are NOT in `config/agent-ids.ts` — neither is chefAgent.
> The meta-agent lost its 16 chef tools — the whole menu domain belongs to chefAgent via delegation.

## Verification (E1, 2026-06-11)

- `npm run build` — ✅ green.
- `chef_document_*` e2e: write 3 sections → status **3/8**, idempotent re-write does not
  duplicate the anchor, file on disk under `CHEF_DOCS_DIR`.
- `reviews_google_place` live: Pod Fredrą Wrocław → rating **4.2**, 2334 reviews,
  5 reviews returned; degrades without a key.

## Verification (E2, 2026-06-11)

- `npm run build` — ✅ green.
- **Incremental document** (fs): 2 canonical writes + 6 dynamic `recipe:<slug>`
  (append) + 1 re-append = **9 separate section writes** (proof of incrementality);
  6 distinct anchors, short-rib NOT duplicated, append accumulates fragments,
  `titleFor` → "Receptura: short rib".
- **recon→profile mapper** (live Mongo): avgMain 75 → tier **premium**, `difficultyTarget` 3,
  `currentMenuRef.dishCount` 3, `cuisineTypes` + `signatureDishes` mapped — **all
  persisted in the profile in the DB**. Tier thresholds: 10 boundary cases ✅.
- **Pipeline statuses** (live Mongo): 10 `recon…done` transitions ✅, `done` persists,
  a non-existent project is rejected.
- **Boundary:** full agent-driven E2E (URL → LLM → researcher → chef → menu-book.md) =
  a runtime test on the live agent; here each component was verified individually.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `CHEF_DOCS_DIR` | Optional | Menu Book directory (default `/projekty/splot-projects/menu-books`) |
| `CHEF_PRICE_TIER_PLN` | Optional | 3 PLN thresholds for `priceRange.tier` (default `35,70,130` → budget/mid/premium/luxury) |
| `CHEF_CHROME_BIN` | Optional | Chrome/Chromium binary for `chef_document_pdf` (default `google-chrome-stable`) |
| `GOOGLE_MAPS_API_KEY` | Optional | Places API (New) — `reviews_google_place`; without it degrades to the researcher |
| `TAVILY_DAILY_LIMIT` / `PLACES_DAILY_LIMIT` / `FIRECRAWL_DAILY_LIMIT` | Optional | Daily recon request caps (defaults in code: 100/200/100) |

## Verification (E3, 2026-06-12)

- `npm run build` — ✅ green; `chef_document_pdf` and `chef-menu-quality` present in the `.mastra/output` bundle.
- **PDF**: a Menu Book with a valid GFM BOM table renders to `%PDF-1.4` (~46 KB); `pdftotext -layout`
  shows aligned table columns. A table missing the `|---|` separator row renders as literal text.
- **Scorer**: a well-formed E2-shaped menu → **1.00 / pass** (est-difficulty 3); a degenerate menu
  (3× braise consecutive, no textures/temps/dietary) → **0.196 / fail** with per-dimension diagnostics.
- **Failure-brain** (live Mongo): 7 lessons created; `recallKnowledge('chef menu book pipeline …')`
  → 4 hits, top score 0.725.
- **Recon budgets**: `tavily`/`places`/`firecrawl` registered (100/200/100); `isOverBudget('places')` false at start.

## Pipeline-stall & routing fixes (2026-06-12)

Two live-run defects were found by analysing the logs of two failed pipeline runs and fixed:

- **chefAgent stalled at `profile_synthesis`.** Root cause: chefAgent set NO step budget, so it ran
  at the framework default (~5 steps) and got cut off after the expensive recon delegations — needing
  user nudges to continue. Every other pipeline agent (meta/coding/knowledge/automation/deliberation)
  already sets `maxSteps: 40`. Fix: added `defaultOptions` + the three legacy variants with
  `maxSteps: 40` to `chef-agent.ts`, and tightened the autonomy language (a "Continuation contract" in
  `prompts/chef/pipeline.md` and an extended "Autonomous continuation" in `prompts/chef/domain.md`):
  "report" = a short status line in the SAME turn, NOT a turn end; the only turn-ending events are the
  two `request_approval` gates and unanswerable missing-info questions.
- **Meta-agent bypassed the chef pipeline.** On a "modernize the restaurant menu" request the meta-agent
  decomposed it into a codingAgent job — a `scripts/populate-*.ts` script writing Mongo + the Menu Book
  directly — which stalled pending approval and left the project as a skeleton. Fix: added a hard rule to
  `prompts/meta/base.md`: a menu/restaurant/Księga-Menu task is ALWAYS one
  `system_delegate_task(chefAgent)` call, never a coding/populate-script task; only chefAgent writes chef
  data.

## Memory parity with codingAgent (2026-06-12)

chefAgent was built lighter than the other pipeline agents. After the `maxSteps` fix it was
brought closer to codingAgent's memory stack (pipeline runs are long — recon → profile → menu →
recipes for ~10 dishes — and span many turns):

- **`observationalMemory`** (Mastra `Memory` option) — per-thread running summary so earlier
  decisions (profile, recon insights, approvals) stay in context once the conversation grows past
  `lastMessages: 20`. Summariser model `gemma4-e4b` (`infrastructure.observationalMemory`),
  `scope: 'thread'`, `temporalMarkers`, `observation.threadTitle`. Plus `generateTitle: true`.
- **`TokenLimiterProcessor`** (`inputProcessors`, 120K) — context-overflow guard for long
  autonomous runs, same limit codingAgent uses.

What chef has via shared/global infrastructure (already, regardless of agent config): embeddings
through its own tools (`chef_search_notes` RAG over chef notes, `memory_recall` over
`system_knowledge`), and the **global `MemoryExtractor`** service that mines all agents' events into
`system_knowledge`. chef also has domain-specific external memory: chef notes + the Menu Book on
disk + the MongoDB project state (resumable after a crash).

**Still NOT wired (deliberate, deferred):** the jcode-style **harness**. coding/automation/knowledge
route through domain-specific harness wrappers (`generateCoding`/`generateAutomation`/
`generateKnowledge` over `generateWithHarness` with a per-domain precontext builder); chef uses the
generic direct-`generate` path in `delegate-task`. Giving chef a harness properly needs a
`chef-precontext.ts` + `chef-harness.ts` + `FEATURE_CHEF_PRECONTEXT` flag + a delegate-task route.
**Caveat:** `generateWithHarness` sets `maxSteps` from the depth-controller profile (default 10), so
a naive harness wiring would override chef's `maxSteps: 40` and risk re-introducing the
`profile_synthesis` stall — the harness is a separate, careful task, not a bolt-on.

## Personal Recipe Library — the chef's own repertoire (2026-06-13)

A vector-searchable store of the chef's **own** ~8.7k structured recipes (separate from
NotebookLM, which is general culinary knowledge). It makes the agent start menu ideation and recipe
drafting from the chef's signature style instead of inventing from scratch.

> **Two knowledge sources, kept distinct:** NotebookLM (`chef_*` notebooks) = general canon/theory;
> the recipe library (`chef_search_recipe_library`) = the chef's repertoire (his dishes, his exact
> component ratios, his style). The `usage` flag governs reuse: `adapt` = combine/modify freely,
> never copy 1:1; `locked` = preserve faithfully if used.

### Storage & lifecycle (embeddings persist — NOT recomputed at boot)

- **Collection `chef_recipe_library`** (system-of-record), separate from per-project `chef_recipes`.
  Each doc = all structured fields + `embedding` (1024-d bge-m3), `embeddingModelId`, `embeddingText`,
  `embeddingTextHash`, `lang`, `qualityScore`, `usage`.
- Embeddings are computed **once, offline** by `scripts/embed-recipe-library.ts`
  (`npm run embed:recipe-library`) and **persisted in Mongo**. Mastra startup never re-embeds the
  corpus — the retrieval service only **reads** vectors into a lazy in-memory index.
- **Append-only & idempotent:** drop new structured recipes into
  `storage/recipes/recipes-structured/*.json` and re-run the script. It skips unchanged recipes via
  `embeddingTextHash` (sha256 of `embeddingText`) and only embeds new/changed ones. A model-id guard
  forces a re-embed if the embedding model (dimensions) ever changes.
- **Embedded text** is built from *reliable* structured fields (category/name/cuisine/type/techniques/
  ingredients/profile/pairings + first summary sentence), sidestepping the weak mechanical summaries.
- `config/locked-recipes.json` (`{ "ids": [] }`) is an allowlist; ids listed there are flagged
  `usage:"locked"` at embed time. Empty = everything stays `adapt`.

### Retrieval — hybrid, Mongo-Community compatible (no `$vectorSearch`)

`tools/chef/recipe-library-service.ts` `search(query, opts)`:
1. **Pre-filter** (category / type / allergen-exclude) over the in-memory index.
2. **Vector leg** — embed query (bge-m3), cosine vs candidate embeddings, top-40.
3. **Lexical leg** — Mongo `$text` on the same candidates (exact names vectors miss), top-40.
4. **Fuse** — Reciprocal Rank Fusion (RRF, k=60).
5. **Rerank** — × `qualityScore`, stage boost (components at recipe stage / dishes at menu stage),
   dedup near-identical names.
6. Hydrate top-`limit` full records. `invalidateRecipeIndex()` drops the cache after re-embed.

### Agent integration (3 points)

- **Tool `chef_search_recipe_library`** — ad-hoc lookups (`query`, optional
  `category`/`type`/`dietaryExclude`/`stage`/`limit`). Registered in `chef-agent.ts`.
- **Auto-inject at MENU stage** — `chef_generate_menu` returns a `personalContext` block (top-8 of the
  chef's repertoire, profile-derived query + dietary exclude) next to `notebookContext`.
- **Grounding at RECIPE stage** — `pipeline.md` instructs `chef_search_recipe_library(type:"component",
  stage:"recipe")` before drafting, to reuse the chef's exact ratios (fewer hallucinated ratios).
  Routing notes added to `prompts/chef/domain.md` + `pipeline.md`.

### Quality gate

`scripts/eval-recipe-retrieval.ts` (`npm run eval:recipe-retrieval`) runs 30 gold queries
(`scripts/fixtures/recipe-gold-queries.json`, incl. EN cross-lingual) and reports recall@5,
recall@10, MRR. Acceptance: **recall@10 ≥ 0.85**; below that triggers the conditional v2 enrichment
(local-LLM cleanup of summaries/keywords/lemmas, then re-embed). Plan + decisions:
`ideas/recipe-library-implementation-plan.md`.

## Embedding robustness — Ollama bge-m3 runner crash (2026-06-12)

At startup the SkillRegistry (~100 skills) and the MemoryExtractor both call `generateEmbedding`
independently; the concurrent burst crashed the bge-m3 runner
(`llama runner process has terminated`) → 500s, `0 with embeddings`, and knowledge saved without
vectors. `generateEmbeddings()` was only sequential *per caller* — there was no global cap across
callers. Fix (`src/mastra/lib/embedder.ts`): a process-wide semaphore around every Ollama embedding
request (`EMBEDDING_CONCURRENCY`, default 2) plus exponential-backoff retry of transient runner
crashes / 5xx / connection errors (`EMBEDDING_MAX_RETRIES`, default 3). Centralised in the embedder,
so SkillRegistry, MemoryExtractor and `saveKnowledge` all benefit without per-caller changes.

> **Operational note (2026-06-12):** during this investigation the *live* cause of the 500s turned
> out to be infrastructure, not load — the GPU (RTX 5060 Ti / driver 580 / CUDA 13) was **wedged**:
> 100% utilisation with **zero compute processes** and `cudaMalloc … device(s) is/are busy or
> unavailable`, so EVERY Ollama model load failed (the chat model too, not just bge-m3). The embedder
> hardening above only makes the system **degrade gracefully** (retry, then save-without-vector) — it
> cannot conjure embeddings while the GPU is down. Remedy is operational: restart the Ollama service
> (`sudo systemctl restart ollama`) and, if util stays pinned with no process, reboot to clear the
> driver state. After recovery the SkillRegistry re-embeds on the next dev start and MemoryExtractor
> resumes storing vectors; knowledge written without a vector during the outage stays non-searchable
> until re-extracted/re-seeded.
