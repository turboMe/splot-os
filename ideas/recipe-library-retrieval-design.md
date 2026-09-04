# Personal Recipe Library — vector retrieval & chef-agent integration (design)

Status: DESIGN ONLY (no code yet). Storage stays MongoDB for now.

## 0. What we have (reality check)

- Source: `storage/recipes/recipes-structured/*.json` — **8,664** active recipes, schema-clean
  (24 fields, all present). `_quarantine.json` (1,252 junk) and helper files (`kremy-cukiernicze`=[],
  `_newly_empty_after_strip`) are **excluded** from ingestion.
- Mixed PL/EN content. `bge-m3` (our embedder, `lib/embedder.ts`) is multilingual + cross-lingual →
  mixed language is fine; no translation needed for v1.
- Quality gaps that limit retrieval if embedded naively:
  - `summary` = mechanical, truncated concatenation → weak semantic signal.
  - `searchKeywords` = noisy (case-forms, leaked headers).
  - ingredient `name` in grammatical cases, not lemmas.
  - confidence skew: 7,686 medium / 611 low / 367 high.
- Mongo **Community** has no `$vectorSearch`. Retrieval must be app-side (in-memory cosine), like
  the existing `chef-service.searchNotes` pattern — but designed to scale to ~10k.

## 1. Storage model

New collection **`chef_recipe_library`** (separate from `chef_recipes`, which is per-project
*output* — never mix the two). One document per recipe:

```jsonc
{
  ...all original structured fields...,
  "embedding": [/* 1024 floats, bge-m3 */],
  "embeddingModelId": "ollama/local/bge-m3",
  "embeddingText": "…the exact text we embedded…",
  "embeddingTextHash": "sha256(...)",   // for idempotent re-embedding
  "lang": "pl" | "en" | "mixed",
  "qualityScore": 0.0-1.0               // derived from confidence + field completeness (for ranking)
}
```

Indexes: `{ id: 1 }` unique, `{ category: 1 }`, `{ type: 1 }`, `{ "provenance.extractionConfidence": 1 }`,
plus a **text index** on `name`, `aliases`, `searchKeywords`, `ingredients.name` for the lexical leg.

## 2. The #1 lever: what we embed (embeddingText)

Do NOT embed the weak `summary` alone. Build a deterministic, high-signal document from the
*reliable* structured fields. Proposed template (per recipe):

```
[KATEGORIA] {category} / {subcategory}
[NAZWA] {name} {aliases}
[KUCHNIA] {cuisine}   [TYP] {type}
[TECHNIKI] {techniques}
[SKŁADNIKI] {ingredient names, deduped}      ← dominant flavor/identity signal
[PROFIL] {flavorProfile.dominant} {textures} {temperature}
[UŻYCIE/PAIRING] {pairings}
[OPIS] {summary, cleaned/first sentence only}
```

Why: name + ingredients + category + techniques are robust even when summary is junk. This makes
v1 retrieval good without first fixing every summary. Store the assembled string in `embeddingText`
so re-embeds are reproducible and diffable.

## 3. Retrieval pipeline (hybrid, Mongo-compatible)

For a query (or an auto-built query from the project profile):

1. **Metadata pre-filter** (Mongo query) — narrow the candidate set cheaply and correctly:
   - `category`/`type` (e.g. only `sosy-cieple`, or only `type:component` at recipe stage),
   - dietary/allergen constraints from the profile (exclude allergens to avoid),
   - optional cuisine/season hints.
   This both speeds things up and prevents semantically-close-but-wrong hits.
2. **Vector leg** — embed the query (bge-m3), cosine vs the candidate set, take top-N.
   Use an **in-memory cached index** of `{id, embedding, qualityScore, category, type}` loaded once
   at startup (≈8.7k×1024 floats ≈ 35 MB RAM; per-query cosine ≈ few ms). Refresh on library change.
3. **Lexical leg** — Mongo `$text` search on the same candidate set (catches exact names like
   "demi-glace", "sos beszamelowy" that vectors sometimes miss).
4. **Fuse** — Reciprocal Rank Fusion (RRF) of vector + lexical lists. Cheap, robust, no tuning.
5. **Rerank / post-process**:
   - boost by `qualityScore` (downrank `low` confidence),
   - **diversify**: drop near-duplicate names so we don't return 5 variants of one sauce,
   - stage-aware boost: components at RECIPE stage, dishes at MENU stage.
6. Return top-K (default 5–8) with `id, name, category, summary, ingredients, usage, provenance`.

Threshold: tune empirically (start ~0.3 cosine floor like `searchNotes`), but rely on RRF rank, not
a hard cosine cutoff, for the primary ordering.

## 4. Embedding pipeline (offline, one-time + incremental)

A script (`scripts/embed-recipe-library.ts`) that:
1. Reads category JSONs (skip `_*` files + quarantine), upserts into `chef_recipe_library`.
2. Builds `embeddingText` (§2), computes hash; skips if hash unchanged & embedding present (idempotent).
3. Calls `generateEmbeddings` (existing `lib/embedder.ts`, bge-m3, already throttled/retried) in
   batches; writes `embedding` + `embeddingModelId` + `embeddingTextHash`.
4. Computes `qualityScore` and `lang`.
- Cost: ~8.7k local embeddings ≈ 10–20 min on bge-m3 with concurrency 2. Fully offline.
- Re-runnable: changing the §2 template re-embeds only changed docs.

## 5. Agent integration — two injection points (+ explicit tool)

This is HOW the agent uses it. Maps to the two stages we identified.

**(a) MENU ideation — automatic injection in `chef_generate_menu`.**
After profile is ready, auto-retrieve top-K of the chef's OWN recipes/components (filtered by
cuisine/season/establishment) and add a `personalContext` block alongside the NotebookLM
`notebookContext`. Framing instruction (the Lego↔creative contract):
> "PONIŻEJ przepisy z własnego repertuaru szefa. Użyj ich jako inspiracji i referencji technik.
>  ADAPTUJ swobodnie — łącz, modyfikuj, dopasuj do kompozycji i profilu. Pozycje oznaczone
>  `usage:locked` zachowaj wiernie, jeśli ich użyjesz. NIE kopiuj 1:1 pozycji `adapt`."

**(b) RECIPE writing — grounding in `chef_draft_recipe` flow.**
Before composing a dish's technical card, retrieve the chef's matching component recipes (his exact
ratios) and inject them as the canonical reference → fidelity to his techniques, fewer hallucinated ratios.

**(c) Explicit tool `chef_search_recipe_library`** for targeted lookups the agent decides to run
("znajdź moje najlepsze demi-glace", "wegetariańskie purée jesienne"). Inputs: `query`, optional
`category`/`type`/`dietary` filters, `limit`. Returns ranked recipes (§3).

Wire (c) into the agent tool list; add (a)/(b) into the existing tool bodies. Prompt (`chef/domain.md`,
`chef/pipeline.md`) gets a short routing note: "Najpierw sięgnij po repertuar szefa
(`chef_search_recipe_library`) zanim wymyślisz danie od zera; NotebookLM = wiedza ogólna, biblioteka =
styl szefa."

## 6. Data-quality remediation (phased — don't block v1)

- **v1 (now):** embed from structured fields (§2). Robust despite weak summaries. Ship + measure.
- **v2 (optional, incremental):** a batch enrichment pass with a cheap LOCAL model (e.g. `gemma4-e4b`)
  to, per recipe: rewrite a clean 1-sentence `summary`, lemmatize ingredient names into a parallel
  `ingredientsNorm[]`, regenerate `searchKeywords`, fill `flavorProfile`/`pairings` when derivable.
  Re-embed changed docs. This measurably lifts retrieval; do it after v1 proves the pipeline.
- Keep `low`-confidence recipes in the store but downranked; flag for your manual review via a report.

## 7. Evaluation harness (so "very good" is measured, not vibes)

Build a small gold set: ~30 representative queries with expected hit ids
("sos do szparagów", "demi-glace", "wegetariańska przystawka", "zupa krem z dyni", an English query to
test cross-lingual). Measure **recall@5 / recall@10** and MRR. Use it to tune: the §2 template, RRF
weights, quality boost, threshold. Re-run after v2 enrichment to quantify the lift.

## 8. Scaling note

In-memory cosine over ~8.7k is fine (tens of ms). Boundaries to watch: if the library grows past
~50–100k chunks, or we add per-component sub-vectors, move the vector leg to a real ANN store
(Qdrant/LanceDB local) while keeping Mongo as system-of-record. Not needed now.

## 9. Phased plan

1. **Ingest + embed** — `chef_recipe_library` collection + `embed-recipe-library.ts` (§1,2,4).
2. **Retrieval service** — `recipeLibraryService.search()` (hybrid §3) + in-memory index loader.
3. **Eval harness** — gold queries + recall@k (§7). Tune §2/§3.
4. **Agent wiring** — `chef_search_recipe_library` tool (c) + auto-inject in `chef_generate_menu` (a).
5. **Recipe-stage grounding** (b) in `chef_draft_recipe` flow.
6. **v2 enrichment** (optional) — local-LLM cleanup pass + re-embed (§6).

## Open decisions (need answers before implementation)
1. **Embedding granularity**: one vector per recipe (recommended, simple) vs also per-component
   sub-vectors (better building-block recall, more vectors). Start per-recipe?
2. **Auto-inject vs tool-only**: bake retrieval into `chef_generate_menu` automatically, or rely on the
   agent calling `chef_search_recipe_library` itself? (Recommend: both — auto at menu stage, tool for ad-hoc.)
3. **v2 enrichment now or later**: ship v1 from structured fields first and measure, or invest in the
   local-LLM cleanup pass up front?
4. **`locked` policy**: any recipes you want hard-locked as signatures from day one, or treat all as
   `adapt` until you curate?
