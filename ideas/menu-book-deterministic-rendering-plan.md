# Menu Book — deterministic rendering plan (+ learning-loop appendix)

**Status:** proposed · **Owner:** dev · **Est. core:** ~3–5 h · **Created:** 2026-06-15

## Why (problem statement)

Across five real Menu Books produced by chefAgent the document richness swings wildly —
**not because the cooking differs, but because formatting is left to the model and the run mode**:

| Księga | linie | bajty | wiersze tabel | karty | tryb |
|---|---|---|---|---|---|
| `6a3c7688` Reykjavik (pre-library) | 1534 | 106K | **263** | 8 | ręczny, checkpointy |
| `e4c44c92` Steakhouse | 875 | 72K | 119 | 5 | po bibliotece |
| `ebc30831` Old Iceland | 1153 | 59K | 107 | 13 | po bibliotece |
| `6c8e1b21` Finnsson | 752 | 65K | 23 | — | po bibliotece |
| `bc25c05c` Reykjavik 2026 (test live) | 1218 | 78K | 75 | 11 | autonomiczny sprint |

**This is variance, not quality.** The personal-recipe-library system is NOT the cause — it only
changes *which* dishes the agent draws on, never the renderer.

### Root cause (confirmed in code)

1. **Two rival rendering paths for recipe cards.**
   - Deterministic compiler `chef_export_menu_book` → `renderRecipeCard` (`tools/chef/chef-tools.ts:832`)
     emits the BOM as a **bullet list** (`- ${qty} ${unit} ${name}`).
   - The model, when it hand-writes `recipe:<slug>` sections via `chef_document_write_section`,
     emits a **GFM table** with a `Uwagi / Specyfikacja` column (the rich look in `6a3c7688`).
   - → identical substance, different look, depending on which path a given run took.

2. **Section doubling.** `replaceSection` (`tools/chef/chef-document-tools.ts:118-133`) appends any
   anchor NOT in `CANONICAL_SECTIONS` as a brand-new `## Heading` at the end of the doc. So
   `insights` duplicates `notes`, `concept` duplicates `profile`, `appendix` has no home, and
   free-form `recipe:<slug>` cards duplicate the compiled `Karty technologiczne` section
   (e.g. `bc25c05c` has 11 cards under `Karty technologiczne` **and** 2 stray `## Receptura:` sections).

3. **Run-mode coupling.** Hand-guided runs (checkpoints) trigger more elaboration passes; the
   autonomous sprint (`bc25c05c`) does one pass. Document depth should not depend on how many
   human turns happened.

## Goal

The Menu Book is **assembled deterministically from the DB** (`chef_menus`, `chef_recipes`,
project profile/recon/notes), with one canonical layout and rich table BOM — identical structure
and depth on every run, hand-guided or autonomous. The model writes *prose* (overview, concept,
insights narrative); the renderer owns *structure* (tables, matrices, card layout, section order).

---

## Phase 1 — Rich table BOM in the deterministic compiler  ⏳

Rewrite `renderRecipeCard` (`tools/chef/chef-tools.ts:832-862`) so the compiler output matches the
best hand-written format (the `6a3c7688` ceviche card) instead of bullet lists.

- Per component, render a GFM table:
  ```
  | Składnik | Ilość | Jednostka | Uwagi / Specyfikacja |
  | :--- | ---: | :--- | :--- |
  | **{componentName}** | | | |   ← group header row
  | {ing.name} | {ing.quantity} | {ing.unit} | {ing.notes ?? ''} |
  ```
- Keep Mise en Place (numbered, with temp/time) and Service Steps as today.
- Render `equipmentNeeded` as a `#### Wymagany Sprzęt` bulleted block (today it is a one-liner).
- Pure formatting change; the data already exists on `ChefRecipe` (componentName, ingredients
  {name,quantity,unit,notes}, miseEnPlace, serviceSteps, equipmentNeeded).

**Acceptance:** re-compiling `bc25c05c` produces table-based cards; byte size rises toward the
`6a3c7688` density with no new model calls.

## Phase 2 — One rendering path (retire model free-form cards)  ⏳

- Make `chef_export_menu_book` the **only** way recipe cards reach the book. Extend it to also fill
  `allergens` (deterministic matrix table from `menu.metadata.allergenMatrix` + per-recipe allergens)
  and `pairings` (table from `dish.pairingWine` / `dish.pairingNonAlcoholic`). These are data we
  already hold — stop letting the model re-type them.
- **Guard:** in `chefDocumentWriteSectionTool` (`chef-document-tools.ts:211`), reject anchors
  matching `^recipe:` with an error hinting "use chef_export_menu_book — cards are compiled from the
  DB, not hand-written." Prevents the duplicate-card class entirely.
- **Prompt:** in `prompts/chef/pipeline.md` (render stage) instruct: cards/menu/allergens/pairings
  are compiled via `chef_export_menu_book`; the agent only authors prose sections (overview, concept,
  recon narrative, insights).

**Acceptance:** no `## Receptura:` headings appear in output; all cards live once under
`Karty technologiczne`.

## Phase 3 — Kill section doubling (anchor canonicalization)  ⏳

In `chef-document-tools.ts`:

- Add `appendix` (and optionally `insights`) to `CANONICAL_SECTIONS` so they get a real skeleton slot
  (with Polish titles in `SECTION_TITLES`), not an appended duplicate.
- Add an **alias map** resolved at the top of `replaceSection`/`getSectionBody`/`titleFor`:
  `concept → profile`, `menu-card → menu`, `allergen-matrix → allergens`, `research-brief → recon`,
  `insights → insights` (now canonical). Unknown anchors that would create a duplicate `##` are
  rejected (return error) rather than silently appended.
- Result: every logical section has exactly one home; the skeleton order is the document order.

**Acceptance:** `grep -c '^## '` on a compiled book equals the canonical section count (no dupes
like `Przegląd` ×2, `Pairingi` ×2).

## Phase 4 — Golden-snapshot regression test  ⏳

- Fixture: a seeded project (menu + 3 recipes) → run `chef_export_menu_book` → assert:
  (a) section count == canonical, (b) each card has a `|`-table BOM, (c) zero duplicate `##`
  headings, (d) byte size within an expected band.
- Guards determinism so future prompt/model drift can't silently re-introduce variance.

## Phase 5 — Backfill verification  ⏳

- Re-compile `bc25c05c` + one more existing project; diff before/after; confirm table BOM, single
  card section, stable structure. (Originals are kept; `.bak` already exists for `ebc30831`.)

## Files touched
- EDIT `tools/chef/chef-tools.ts` — `renderRecipeCard` → table; `chef_export_menu_book` → also fill
  `allergens` + `pairings` deterministically.
- EDIT `tools/chef/chef-document-tools.ts` — `CANONICAL_SECTIONS` (+appendix/insights), anchor alias
  map, `recipe:` write guard.
- EDIT `prompts/chef/pipeline.md` — render-stage routing: compile structure, author only prose.
- NEW  `scripts/__tests__/menu-book-snapshot` (or existing test harness) — golden snapshot.

## What this gains (explicit)
1. **Repeatability** — same depth/structure every run, independent of checkpoints vs autonomous.
2. **Kitchen-usable BOM** — scalable quantity tables + `Uwagi` column, not prose lists.
3. **No duplicated sections / stray cards.**
4. **Cheaper + faster** — model stops re-typing structured data already in Mongo; fewer tokens,
   fewer formatting errors.
5. **Clean separation** — model owns prose, renderer owns structure.

### What it does NOT do
- Won't improve menu *composition* (that's domain.md + library + flavor reasoning).
- Won't invent missing data — empty `Uwagi` cells surface data gaps (useful), but don't fill them.
- Narrative depth still depends on the model; the template only guarantees a slot for it.

---

# Appendix A — Learning loop ("the agent gets better over time")

**Did we discuss this?** Yes. It is recorded in the validated-memory note as
*"domknięcie pętli uczenia (chef_notes → trwała wiedza)"* — closing the learning loop so working
notes become durable knowledge. This appendix specifies it so a dev can build it. It is independent
of the rendering work above.

## Concept

Today the loop is **open**: during a project the agent records working notes via `chef_add_note`
(`type: preference|technique|pairing|feedback`) and can later `chef_search_notes`, but those notes
stay as ephemeral per-project memory. They never feed back into the chef's durable repertoire, and
the successful dishes the agent actually delivered are never harvested. So the agent starts every
project at the same baseline — it does not compound.

**Closing the loop = a flywheel:** deliver a project → distill its lessons + harvest its successful
recipes → persist them into the durable, embedded knowledge the retrieval layer already serves →
the next project starts smarter. The retrieval/embedding infrastructure already exists
(`chef_recipe_library`, bge-m3, hybrid search, idempotent `embeddingTextHash`, P0 relevance gate);
the learning loop is the *promotion* path into it.

## Trigger

On project reaching `done` (or a nightly batch over recently-completed projects). One promotion job
per finished project, idempotent.

## Pipeline (dev-buildable)

1. **Gate — only learn from validated work.** Promote a project only if it passed `critic_gate`
   AND has no negative user `feedback` note overriding it. Never learn from rejected drafts.
   (Without a gate the loop amplifies mistakes.)

2. **Harvest successful recipes → grow the repertoire.** For each `chef_recipes` card in the
   finished project, transform it into a `chef_recipe_library` document (same schema the embed
   script writes), tagged `provenance: "delivered-project:<projectId>"`, `usage: "adapt"`,
   `qualityScore` seeded high (it shipped). Reuse `scripts/embed-recipe-library.ts` logic:
   build `embeddingText`, `embeddingTextHash`, embed via bge-m3, upsert. **Idempotent** — re-running
   skips unchanged (hash match), so re-promotion is safe. The chef's own delivered work compounds
   into his searchable repertoire.

3. **Distill notes → durable lessons.** Feed the project's `chef_notes` (preferences, technique
   takeaways, validated pairings, feedback) + the final menu into a local summarizer
   (`gemma4-e4b`, the existing memory-summarizer model) to produce a small set of durable lessons:
   - validated pairings (`type: pairing`),
   - technique tweaks that worked (`type: technique`),
   - client-segment preferences (e.g. "Reykjavík fine-dining → crowberry/sea-buckthorn acid lift"),
   - what failed and why (from `feedback` + critic notes) as negative constraints.
   Write these to a durable `chef_knowledge` collection (embedded, hybrid-searchable, same retrieval
   service generalized) — separate from per-project `chef_notes`.

4. **Dedup against existing knowledge.** Before insert, embed the candidate lesson and check cosine
   vs existing `chef_knowledge`; if > ~0.9 to an existing lesson, merge/skip instead of duplicating.
   (Same `embeddingTextHash` idempotency as the library.)

5. **Retrieve — no new infra.** Next project's `chef_generate_menu` auto-inject already pulls the
   personal library; extend it to also pull top `chef_knowledge` lessons matching the brief, injected
   as a `learnedContext` block next to `personalContext`. The flywheel closes here: yesterday's
   delivered dishes and distilled lessons are first-class inputs to tomorrow's menu.

## Data model

- `chef_recipe_library` (exists) — gains delivered-project recipes via promotion (provenance-tagged).
- `chef_knowledge` (NEW) — durable distilled lessons: `{ id, type, text, embedding,
  embeddingModelId, embeddingTextHash, sourceProjectIds[], confidence, createdAt }`.
- `chef_notes` (exists) — unchanged; remains the raw per-project capture that feeds distillation.

## Models & cost
- Embedding: existing local **bge-m3** (offline, idempotent, cheap).
- Distillation: existing local **gemma4-e4b** — a few calls per finished project, not per query.
- Promotion is a background job on `done`, never on the request path → zero added latency to a
  live chef session.

## Guardrails
- **Quality gate** (step 1) is mandatory — the single biggest risk is learning junk.
- **Provenance + usage flags** keep delivered recipes as `adapt` (never auto-`locked`); the user can
  later curate signatures into `config/locked-recipes.json`.
- **Idempotency + dedup** keep re-runs safe and the corpus from bloating.
- **Reversibility:** promoted docs are provenance-tagged, so a bad batch can be filtered/rolled back
  by `provenance`.

## Acceptance / metric
Reuse `scripts/eval-recipe-retrieval.ts`: after promoting N projects, recall on a held-out set of
"what would the chef cook for brief X" queries should rise, and auto-injected `personalContext` for
a *new* brief should surface dishes the chef previously delivered for similar briefs. That is the
measurable signal that the agent is compounding.

---

# Appendix B — Should we ingest the 2.2M-recipe corpus? (RecipeNLG)

The file `storage/recipes/full_dataset.csv` (2.3 GB) is **RecipeNLG** — a web scrape
(columns: `title, ingredients, directions, link, source, NER`; `source: Gathered`). It is generic,
English, uncurated, with no flavor profiles, no cuisine/technique tags, no quality scores, and
heavy junk (the user's own curated 8.7k already had 8.6% junk; an uncurated scrape is far worse).

**Recommendation: do NOT merge it into `chef_recipe_library`.** That collection is the chef's
*signature* — the entire differentiator is that it is HIS repertoire. Diluting it with 250× generic
casseroles makes retrieval noisier (the P0 floor + junk filter would fight 250× more noise),
needs a real vector DB (~9 GB of vectors won't fit the current in-memory index), and costs ~40–80 h
of embedding compute — for breadth the chef doesn't cook in.

**The real bottleneck is reasoning, not corpus size.** Retrieval ranks by *similarity*; it does not
reason about whether two ingredients/textures actually combine. That reasoning lives today only in
`domain.md` (complementary/contrasting/bridging rules, texture contrast, Ahn et al. shared-compound
caveat) + the `chef_flavor` NotebookLM + the model approximating the rubric. There is **no explicit
flavor-wheel / flavor-compound engine.** More recipes ≠ better combinations.

**Higher-ROI alternative (spec separately if pursued):** a *flavor-reasoning layer* —
a flavor-compound graph (FlavorDB / Ahn foodpairing) the agent can query to score a candidate
pairing, structured `flavorProfile` fields on recipes, and a texture-contrast checker that validates
"min 3 textures, ≥1 contrasting pair" mechanically instead of by prompt. That yields far more
quality per hour than ingesting 2.2M generic recipes.

**If breadth is still wanted later:** ingest RecipeNLG as a SEPARATE, heavily-filtered, opt-in
"external inspiration" index (never the signature library), ranked strictly below the chef's own
hits, and only after the flavor-reasoning layer exists to vet what it surfaces.
