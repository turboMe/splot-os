# Personal Recipe Library — implementation plan (decisions locked)

Companion to `recipe-library-retrieval-design.md`. This is the buildable plan.
Storage: MongoDB (system-of-record) + in-memory vector index. Embedder: existing `bge-m3`.

## Decisions (locked — chosen for best quality/effort ratio)

1. **Granularity → one vector per recipe.** The corpus is already component-grained: a sauce is
   one recipe in `sosy-cieple`, a dish is one recipe in `dania-glowne`. There is no nested
   `components[]` to sub-vector. Per-recipe is correct AND simplest. (Sub-vectors revisited only
   if recall@k proves weak on building-block queries.)
2. **Agent usage → auto-inject AND explicit tool.** Auto-retrieve at the MENU stage (so the model
   always starts from the chef's repertoire) + a `chef_search_recipe_library` tool for ad-hoc lookups.
3. **Enrichment → ship v1 from structured fields, run v2 only if eval demands it.** v1 embeds from
   reliable fields (name/ingredients/category/techniques), sidestepping the weak summaries. We measure
   with the eval harness; v2 (local-LLM cleanup) runs only if recall@10 < 0.85.
4. **`locked` policy → everything `adapt` for now.** No signatures curated yet. Add a tiny
   `locked-recipes.json` allowlist (ids) the user can fill later; the loader flags those as
   `usage:"locked"` at load time. Zero hard-coding.

---

## Persistence & lifecycle (embeddings are NOT recomputed on boot)

- **Embeddings persist in Mongo** (`chef_recipe_library.embedding`). They are computed **once** by the
  offline script `embed-recipe-library.ts`, never at Mastra startup.
- **Mastra startup = read-only load**, not re-embedding. On first query the in-memory index is filled
  by *reading* the stored vectors from Mongo (~35 MB read). Zero embedder calls at boot.
- **Adding new recipes** (append-only workflow, no deletions): drop new structured recipes in →
  run `embed-recipe-library.ts`. It is **idempotent via `embeddingTextHash`** — only new/changed
  recipes get embedded; the existing 8.7k are skipped. Then the in-memory index is invalidated/refreshed.
- **Query-time still embeds the query** (one bge-m3 call per search — cheap, unavoidable). Only the
  *corpus* vectors are persisted; we never re-embed the corpus per query or per boot.
- **Model = existing local `bge-m3`** via `lib/embedder.ts`. We store `embeddingModelId` per doc; if the
  embedding model ever changes (dimensions change), a guard detects the mismatch and triggers a full
  re-embed. Until then, vectors are written once and reused forever.

## Phase 1 — Ingestion + embedding  ✅ DONE

> Implemented: `chef_recipe_library` indexes in `tools/chef/db.ts`;
> `scripts/embed-recipe-library.ts` (idempotent via `embeddingTextHash`, qualityScore+lang,
> locked-allowlist flag); `config/locked-recipes.json` (empty); npm script `embed:recipe-library`.
> Embedding run completed against the local bge-m3 (see test plan §1).

**New collection `chef_recipe_library`** (separate from `chef_recipes`). Document = all original
structured fields + `embedding`, `embeddingModelId`, `embeddingText`, `embeddingTextHash`, `lang`,
`qualityScore`.

**Indexes** (extend `tools/chef/db.ts` `ensureChefIndexes`):
- `{ id: 1 }` unique, `{ category: 1 }`, `{ type: 1 }`, `{ "provenance.extractionConfidence": 1 }`
- text index: `{ name: 'text', 'aliases': 'text', searchKeywords: 'text', 'ingredients.name': 'text' }`

**Script `scripts/embed-recipe-library.ts`:**
1. Read `storage/recipes/recipes-structured/*.json`, skip `_*` files (quarantine/index/report) and
   empty arrays.
2. Per recipe: build `embeddingText` (template below), `embeddingTextHash = sha256(text)`.
3. Upsert into `chef_recipe_library`. **Idempotent**: if hash unchanged and `embedding` exists, skip.
4. Batch-embed changed docs via `lib/embedder.ts` `generateEmbeddings` (bge-m3, already throttled).
5. Compute `qualityScore` = f(confidence: high=1.0/med=0.7/low=0.4) × (field-completeness bonus),
   and `lang` (cheap heuristic on diacritics/stopwords).

**`embeddingText` template** (deterministic, high-signal):
```
[KATEGORIA] {category}/{subcategory}
[NAZWA] {name} {aliases joined}
[KUCHNIA] {cuisine}  [TYP] {type}
[TECHNIKI] {techniques}
[SKŁADNIKI] {unique ingredient names}
[PROFIL] {flavorProfile.dominant} {textures} {temperature}
[PAIRING] {pairings}
[OPIS] {first full sentence of summary}
```

Runtime: ~8.7k local embeddings ≈ 10–20 min, offline, one-time (then incremental).

## Phase 2 — Retrieval service (hybrid)  ✅ DONE

> Implemented: `tools/chef/recipe-library-service.ts` — lazy in-memory index (TTL + `invalidateRecipeIndex()`),
> `search(query, opts)` with Mongo pre-filter (category/type/allergen), vector leg (cosine),
> lexical leg (`$text`), RRF (k=60), qualityScore × stage boost rerank, name dedup, full-record hydrate.

**`src/mastra/tools/chef/recipe-library-service.ts`:**

- **In-memory index loader**: on first use, load `{id, embedding, qualityScore, category, type, name}`
  for all docs into a module-level array (~35 MB). Cache + lazy refresh (TTL or explicit invalidate
  after re-embed). This is the scalable evolution of `chef-service.searchNotes`.
- **`search(query, opts)`** where `opts = { category?, type?, dietaryExclude?, limit=6 }`:
  1. **Pre-filter** (Mongo): candidate ids by `category`/`type` + exclude docs whose `allergens`
     intersect `dietaryExclude`. (If no filters, candidate set = all.)
  2. **Vector leg**: embed query (bge-m3) → cosine vs candidate embeddings (in-memory) → top-N (N≈40).
  3. **Lexical leg**: Mongo `$text` search on same candidate filter → top-N.
  4. **Fuse**: Reciprocal Rank Fusion (k=60) of the two ranked lists.
  5. **Rerank**: multiply RRF score by `qualityScore`; stage boost (component vs dish via opts);
     **dedup** near-identical names (keep highest-scored).
  6. Return top-`limit`: `{ id, name, category, type, usage, summary, ingredients, provenance }`.
- Reuse `cosineSimilarity` from `lib/embedder.ts`.

## Phase 3 — Eval harness (quality gate)  ✅ DONE

> Implemented: `scripts/eval-recipe-retrieval.ts` (recall@5/recall@10/MRR, PASS/FAIL vs 0.85) +
> `scripts/fixtures/recipe-gold-queries.json` (30 gold queries with real ids, incl. EN cross-lingual);
> npm script `eval:recipe-retrieval`. Result recorded in test plan §3 below.

**`scripts/eval-recipe-retrieval.ts`** + **`scripts/fixtures/recipe-gold-queries.json`** (~30 queries
with expected hit ids, incl. one EN query for cross-lingual). Computes **recall@5, recall@10, MRR**,
prints a table. Used to tune the §Phase-1 template + RRF and to decide whether v2 is needed.
Acceptance target: **recall@10 ≥ 0.85** on the gold set.

## Phase 4 — Agent tool + auto-inject  ✅ DONE

> Implemented: `chefSearchRecipeLibraryTool` (`chef_search_recipe_library`) in `chef-tools.ts`,
> registered in `chef-agent.ts`; `personalContext` auto-inject in `chef_generate_menu` (profile-derived
> query + dietary exclude); routing notes in `prompts/chef/domain.md` + `pipeline.md`.

- **Tool `chef_search_recipe_library`** (`tools/chef/chef-tools.ts`): inputs `query`, optional
  `category`/`type`/`dietaryExclude`/`limit`; calls `recipe-library-service.search`. Register in
  `agents/chef-agent.ts` tools.
- **Auto-inject in `chef_generate_menu`**: after profile load, call `search()` with profile-derived
  query + filters; append a `personalContext` block next to `notebookContext`, with the contract:
  > "Repertuar szefa — inspiracja i referencja technik. ADAPTUJ (łącz/modyfikuj) do kompozycji.
  >  `usage:locked` zachowaj wiernie jeśli użyte; `adapt` nie kopiuj 1:1."
- **Prompt note** (`prompts/chef/domain.md` + `pipeline.md`): "Sięgnij po repertuar szefa zanim
  wymyślisz danie od zera. NotebookLM = wiedza ogólna; biblioteka = styl szefa."

## Phase 5 — Recipe-stage grounding  ✅ DONE

> Implemented (prompt + tool reuse): `pipeline.md` recipes stage step 0 instructs
> `chef_search_recipe_library(type:"component", stage:"recipe")` before drafting, using the chef's
> exact ratios as canonical reference. No new infra.

In the RECIPES stage, instruct the agent (prompt) to call `chef_search_recipe_library`
(`type:component`, filtered by the dish's elements) before `chef_draft_recipe`, and to use the chef's
exact ratios as the canonical reference. Mostly prompt + tool reuse — no new infra.

## Phase 6 — v2 enrichment (CONDITIONAL on Phase 3)  ⛔ NOT NEEDED

> Eval gate PASSED on v1: **recall@10 = 93.3%** (26/30 recall@5 = 86.7%, MRR = 0.598), well above
> the 0.85 target. Structured-field embedding is sufficient; the local-LLM enrichment pass below is
> NOT run. (Re-evaluate only if a future gold-set expansion drops recall@10 below 0.85.)

Only if recall@10 < 0.85: **`scripts/enrich-recipe-library.ts`** — local `gemma4-e4b` pass per recipe:
clean 1-sentence `summary`, `ingredientsNorm[]` (lemmas), better `searchKeywords`, derive
`flavorProfile`/`pairings`. Recompute hash → re-embed changed docs. Re-run eval to quantify lift.

## Post-launch hardening — P0 relevance gate  ✅ DONE (2026-06-13)

Live E2E run (project `bc25c05c…` "Reykjavik Kitchen Menu Redesign") completed full pipeline
(intake→done, 11/11 recipe cards, PDF rendered). It surfaced one critical retrieval gap:
`search()` always returned `limit` results with no relevance floor, so component grounding could
return junk (e.g. "Key Lime Bars" for "bisque z homara"). Cosine probe showed good hits 0.51–0.61
and junk 0.46–0.55 — **overlapping** bands, so a single cut can't separate cleanly.

Fix (in `recipe-library-service.ts`), two layers:
1. **Structural junk filter at index load** — drops empty-ingredient, numbered-name (`147.`),
   colon-terminated (`TO:`), and over-long (>45 char) entries. **870/8664 filtered** → 7794-entry
   index; junk never enters retrieval.
2. **Cosine relevance floor = 0.50** — gates final hits (all candidates are cosine-scored, so even
   lexical-only hits are gated). Set at the BOTTOM of the good band to drop the clear-junk tail
   (≤0.49) without discarding genuine ~0.51 matches (e.g. tatar→Steak Tartare = 0.510). Skipped when
   the embedder is down (degrade to lexical recall, don't break). The 0.50–0.55 overlap zone is left
   to the orchestrator's judgement — which the live run proved handles it (no junk leaked into the 11
   cards; espresso demi-glace was built from canonical demi-glace base, not a Tiramisu false-match).

Verification: junk gated (`bisque z homara`→0 hits), good preserved (`sos holenderski`→1 hit,
`tatar`→Steak Tartare). **Eval improved: recall@5 86.7%→90.0%, MRR 0.598→0.698, recall@10 held 93.3%.**

P1–P4 (data-cleanup pass, generic auto-inject query, qualityScore discrimination, coverage gap)
remain as future refinements — not blocking.

---

## Files touched
- NEW: `scripts/embed-recipe-library.ts`, `scripts/eval-recipe-retrieval.ts`,
  `scripts/fixtures/recipe-gold-queries.json`, `tools/chef/recipe-library-service.ts`,
  `config/locked-recipes.json`; (cond.) `scripts/enrich-recipe-library.ts`.
- EDIT: `tools/chef/db.ts` (indexes), `tools/chef/chef-tools.ts` (tool + generate_menu inject),
  `agents/chef-agent.ts` (register tool), `prompts/chef/domain.md` + `pipeline.md` (routing note).

## Test plan
1. ✅ Run embed script → `embedded=8664 skipped=0 failed=0 | collection total=8664 withEmbedding=8664`
   (count == active recipes on disk, every doc has an `embedding`).
2. ✅ Eval covers PL + EN queries: `hollandaise sauce` (EN) → PL `grochowka-holenderska`/hollandaise
   in top-2; `italian tomato sauce` / `carbonara sauce` (EN) hit @1.
3. ✅ Eval harness: **recall@10 = 93.3%** (28/30), recall@5 = 86.7%, MRR = 0.598 → PASS (≥ 0.85),
   Phase 6 NOT triggered. (`npm run eval:recipe-retrieval`)
4. ⏳ E2E (runtime): a chef project run shows `personalContext` populated and the menu reflecting the
   repertoire — verify on the next live `chef_generate_menu` call.

## Estimated implementation effort (engineering hours)

| Phase | Scope | Est. |
|------|-------|------|
| 1 | Collection + embed script + indexes + run | 3–4 h |
| 2 | Hybrid retrieval service (RRF, in-mem index, filters) | 4–6 h |
| 3 | Eval harness + author ~30 gold queries | 2–3 h |
| 4 | Tool + register + auto-inject + prompt notes | 3–4 h |
| 5 | Recipe-stage grounding (prompt + reuse) | 1–2 h |
| **Core (1–4)** | **functional system** | **~12–17 h (≈ 2 working days)** |
| +5 | with recipe grounding | +1–2 h (~2.5 days) |
| 6 | v2 enrichment (only if needed) | +4–6 h (~3–3.5 days total) |

**Average estimate: ~2 working days for the full functional system (Phases 1–4), ~2.5 days incl.
Phase 5, and ~3–3.5 days if the conditional v2 enrichment proves necessary.** (Embedding runtime
~10–20 min is offline and not counted as dev time.)
