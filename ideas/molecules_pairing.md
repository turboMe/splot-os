# Molecular flavor pairing — FlavorDB reasoning layer for chefAgent

**Status:** proposed · **Owner:** dev · **Est. core:** ~2.5–3.5 dni · **Created:** 2026-06-15
**Source repo:** https://github.com/tarek-kerbedj/flavor_db2.0 (FlavorDB / cosylab IIIT-Delhi scrape)

## Why

Today the chef's flavor reasoning is **qualitative only**: `domain.md` rules (complementary /
contrasting / bridging, texture contrast, Ahn et al. 2011 East-Asian caveat) + the `chef_flavor`
NotebookLM, applied by the model from a prompt rubric. Retrieval (`chef_recipe_library`) ranks by
*similarity*, never by whether two ingredients chemically combine. So the agent **guesses** pairings.

FlavorDB is the canonical food→flavor-compound database underlying the very Ahn et al. 2011 "Flavor
network" paper `domain.md` already cites. Adding it gives the agent a **quantitative pairing engine**:
it can *compute* shared-compound overlap and descriptor profiles instead of approximating. This is a
far higher-ROI investment than ingesting more recipes (see `menu-book-deterministic-rendering-plan.md`
Appendix B) — it adds *reasoning*, not just corpus.

### What the repo actually contains (verified 2026-06-15)
- `flavordb.csv` — **936 ingredients**: `entity id, alias, synonyms, scientific name, category,
  molecules` (molecules = set of PubChem IDs).
- `molecules.csv` — **1792 molecules**: `pubchem id, common name, flavor profile` (descriptor set:
  `fruity, sweet, nutty, pungent, fishy, …`).
- `food-tutorial.ipynb` — scraping/cleaning demo with NetworkX (reference only).
- Coverage probe against the chef's ingredients was **good**: lamb, salmon (8 variants), cod, trout,
  char, rye, juniper, dill, cardamom, mushroom, potato, coffee, chocolate, even **crowberry**. Gap:
  sea-buckthorn (rokitnik). → usable, but coverage is partial; the engine MUST degrade gracefully.

## Design principles (locked)

1. **Decision-support, not oracle.** The scorer FLAGS and EXPLAINS pairings; it never auto-rejects a
   dish. The model + `domain.md` make the final call. (The shared-compound hypothesis is
   cuisine-dependent and contested — overtrusting it would mislead, esp. for Asian menus.)
2. **Cuisine-aware from day one.** Western cuisines reward HIGH shared-compound overlap
   (complementary); East-Asian reward LOW overlap (contrasting) — Ahn et al. 2011. A single scorer
   that ignores this is actively wrong half the time.
3. **Graceful fallback.** When an ingredient can't be resolved to FlavorDB, return
   `matched:false` and tell the model to fall back to `domain.md` rules — never emit a false-confident
   zero score.
4. **Deterministic + cheap.** Scoring is pure set math (no LLM). The only model used is the existing
   local **bge-m3** for one-time cross-lingual ingredient matching. No flagship calls, no per-query
   LLM.
5. **Separate from the signature library.** FlavorDB is *reference chemistry*, not the chef's
   repertoire. It lives in its own collections; it never pollutes `chef_recipe_library`.

---

## Phase 0 — Vendoring the data  ⏳

- Copy `flavordb.csv` + `molecules.csv` into `storage/flavordb/` (raw, version-pinned). Record source
  URL, commit SHA, and license note (`storage/flavordb/SOURCE.md`) — scraped academic data, fine for
  internal use; verify before commercial redistribution.

## Phase 1 — Parse + load to Mongo  ⏳

Offline, idempotent script `scripts/load-flavordb.ts`:
- Robustly parse the messy set syntax (`"{'sweet', 'fruity'}"`, embedded commas in quotes) — use a
  tolerant tokenizer, not naive `split(',')`.
- Build two collections:
  - **`chef_flavor_molecules`**: `{ pubchemId:number, commonName:string, descriptors:string[] }`
  - **`chef_flavor_ingredients`**: `{ entityId, name (alias), synonyms:string[], scientificName,
    category, moleculeIds:number[], descriptors:string[] (union over its molecules),
    nameEmbedding:number[] (bge-m3 of `name + synonyms`, for Phase 2) }`
- Indexes (extend `tools/chef/db.ts ensureChefIndexes`): `chef_flavor_ingredients` `{entityId:1}`
  unique, `{name:1}`, text index on `{name,synonyms}`; `chef_flavor_molecules` `{pubchemId:1}` unique.
- Embeddings persisted once (same pattern as recipe library): never recomputed at boot.

## Phase 2 — Cross-lingual ingredient resolver (the hard part)  ⏳

The chef's recipes are **Polish**; FlavorDB is **English**. We need
`chef ingredient name → FlavorDB entity`. Build a resolver, persist matches, measure coverage.

- `scripts/build-flavor-aliases.ts`:
  1. Extract the chef's ingredient vocabulary (distinct `ingredients.name` from `chef_recipe_library`
     + `chef_recipes`), normalized (lowercase, strip quantities/units/notes, basic lemmatization).
  2. For each, embed with bge-m3 (multilingual — handles PL↔EN) and cosine-match against the
     persisted `nameEmbedding` of `chef_flavor_ingredients`; accept if cosine ≥ ~0.62 (tune on a
     hand-checked sample), else mark unresolved.
  3. Persist `chef_flavor_aliases`: `{ chefName, entityId|null, method:'exact'|'embed'|'manual',
     score }`. Plus a manual-override file `config/flavor-aliases-overrides.json` for high-value
     misses (e.g. `rokitnik → sea buckthorn` if/when added).
  4. **Emit a coverage report** (matched / total, and matched-weighted-by-frequency). This is a gate:
     if coverage of the *top-200 most-used* ingredients < ~70%, prioritize manual overrides before
     wiring the scorer into the pipeline.
- `tools/chef/flavor-service.ts` exposes `resolveIngredient(name) → {entityId, matched, score}`
  (alias cache → embed fallback), lazy in-memory index like `recipe-library-service.ts`.

## Phase 3 — Pairing scorer service  ⏳

In `tools/chef/flavor-service.ts` (pure functions over the loaded data):
- `getIngredientProfile(name) → { matched, compounds:number[], descriptors:string[], category }`.
- `scorePairing(a, b, { cuisine }) → { matched, shared:number, jaccard:number,
  sharedDescriptors:string[], verdict:'strong'|'moderate'|'weak'|'unknown', axis:'complementary'|'contrasting', rationale:string }`
  - `shared = |compounds(a) ∩ compounds(b)|`, `jaccard = shared / |union|`.
  - **Cuisine map**: `western|european|mediterranean|americas` → reward high overlap (complementary);
    `east-asian|chinese|japanese|thai|korean` → reward low overlap (contrasting, per Ahn 2011);
    unknown → report both, pick no side.
  - `verdict` from jaccard thresholds (cuisine-flipped); `rationale` names the shared descriptors
    ("łączy nuty `nutty`+`caramel` przez 8 wspólnych związków").
- `suggestBridges(a, b, limit) → top-k` third ingredients maximizing `shared(a,x)+shared(x,b)`
  (the bridging rule from `domain.md`, now computed).
- `profileForIngredients(names[]) → { dominantDescriptors, compoundHistogram, balanceFlags }`
  (aggregate for a whole dish/menu — detects monotony: same dominant aroma across courses).
- Reuse `cosineSimilarity`/embeddings from `lib/embedder.ts`. All scoring is deterministic set math.

## Phase 4 — Recipe library flavor enrichment  ⏳

`scripts/enrich-recipe-flavor.ts` — for each `chef_recipe_library` doc:
- Resolve its ingredients → aggregate `flavorProfile = { descriptors:string[],
  dominant:string[], compoundCount, coverage:0..1 }`; store on the doc.
- **Idempotent** via a `flavorProfileHash`; append-only, skips unchanged.
- This fills the structured `flavorProfile` field (previously empty/weak) and unlocks **menu-level**
  pairing (course-to-course aroma rotation, "max 2 dishes same dominant family").
- OPTIONAL (v2, behind a flag): append top descriptors to `embeddingText` and re-embed → may lift
  retrieval recall. Measure with `eval-recipe-retrieval.ts` before committing; skip if no lift.

## Phase 5 — Agent tools + pipeline integration  ⏳

Tools (`tools/chef/chef-tools.ts`, registered in `agents/chef-agent.ts`):
- **`chef_score_pairing`** — inputs `a`, `b`, optional `cuisine`; returns the `scorePairing` result.
- **`chef_suggest_pairings`** — inputs `ingredient`, `cuisine`, `limit`; ranked partners + bridges
  (for ideation when composing a dish/component).

Auto-integration (deterministic passes, results injected for the model to act on):
- **Menu stage (`chef_generate_menu`)**: after the draft, run `profileForIngredients` per dish +
  `scorePairing` on each dish's key pairs (cuisine from `profile.cuisineTypes`). Emit a
  **`flavorAudit`** block next to `personalContext`: per-dish verdicts, flagged weak pairings + bridge
  suggestions, and a menu-level aroma-rotation check. The model refines using it (does NOT
  auto-rewrite).
- **Recipe/composition stage (`pipeline.md`)**: when designing a component, the agent calls
  `chef_suggest_pairings` to ground combinations in computed overlap before drafting.
- **Prompts**: new `domain.md` subsection "Flavor-compound reasoning (FlavorDB)" — when to call the
  scorer, how to read `verdict`/`axis`, the cuisine caveat, and that it AUGMENTS (not replaces) the
  qualitative rules. `pipeline.md` menu_draft + recipes steps reference the new tools.

## Phase 6 — Eval harness (quality gate)  ⏳

`scripts/eval-flavor-pairing.ts` + `scripts/fixtures/flavor-gold-pairings.json`:
- **Canonical good pairings** (Western, should score high): tomato+basil, lamb+rosemary,
  strawberry+balsamic, coffee+chocolate, pork+apple, beef+mushroom.
- **Canonical contrasting / anti** set (should NOT score "strong" complementary): tested for ranking.
- **Cross-cuisine**: an East-Asian pair that SHOULD score well under contrasting logic but poorly
  under Western logic — verifies the cuisine flip works.
- Metrics: ranking agreement (good > bad), cuisine-flip correctness, and **coverage** (% pairs both
  ingredients resolved). Acceptance: good pairings rank above anti pairings in ≥ 85% of cases AND
  top-200 ingredient coverage ≥ 70%.

---

## Architecture fit
Three layers, complementary — do not conflate:
- **`domain.md`** = qualitative rubric (textures, temperature, narrative, the *rules*).
- **`chef_flavor` NotebookLM** = general theory/canon (prose knowledge).
- **FlavorDB engine (this plan)** = quantitative compound math (the *numbers*).
The engine answers "do these two chemically overlap, and is that good for THIS cuisine?"; the rubric
and NotebookLM answer "what makes a coherent plate/menu". The model orchestrates all three.

## Files touched
- NEW: `scripts/load-flavordb.ts`, `scripts/build-flavor-aliases.ts`, `scripts/enrich-recipe-flavor.ts`,
  `scripts/eval-flavor-pairing.ts`, `scripts/fixtures/flavor-gold-pairings.json`,
  `tools/chef/flavor-service.ts`, `config/flavor-aliases-overrides.json`,
  `storage/flavordb/{flavordb.csv,molecules.csv,SOURCE.md}`.
- EDIT: `tools/chef/db.ts` (indexes), `tools/chef/chef-tools.ts` (2 tools + `chef_generate_menu`
  flavorAudit inject), `agents/chef-agent.ts` (register tools),
  `tools/chef/recipe-library-service.ts` (optional: surface `flavorProfile` in hits),
  `prompts/chef/domain.md` + `pipeline.md` (routing/usage notes).

## Risks & mitigations
1. **Cross-lingual matching accuracy (top risk)** → bge-m3 embed match + manual overrides +
   coverage-gate + graceful `matched:false` fallback. Never fail silently.
2. **Shared-compound hypothesis is cuisine-dependent/contested** → cuisine-aware scorer + framed as
   decision-support; no auto-rejection.
3. **Coverage gaps (specialty/Nordic ingredients)** → fallback to `domain.md`; overrides for
   high-frequency misses; report surfaces what's missing.
4. **Messy CSV parsing** → tolerant tokenizer + a parse-sanity assertion (expected row counts 936 /
   1792) in `load-flavordb.ts`.
5. **Licensing** → vendored with SOURCE.md; internal-use scope flagged.

## Persistence & lifecycle (same discipline as the recipe library)
- FlavorDB collections + embeddings are loaded **once** by the offline scripts, persisted in Mongo,
  **never recomputed at boot**. Services read them into lazy in-memory indexes.
- Re-import only when the source CSVs change (parse-sanity guard + hash). Alias and enrichment scripts
  are idempotent (hash-gated, append-only).
- Query-time pairing is pure set math over the in-memory index — no embedder call per score
  (embedder only used once for unmatched-name resolution, then cached in `chef_flavor_aliases`).

## Test plan
1. `load-flavordb.ts` → assert 936 ingredients / 1792 molecules loaded, every ingredient has
   `descriptors` (union non-empty for matched molecules), embeddings present.
2. `build-flavor-aliases.ts` → coverage report; manually verify ~30 PL→EN matches; top-200 coverage
   ≥ 70% (else add overrides).
3. Unit: `scorePairing('tomato','basil',{cuisine:'mediterranean'})` → strong/complementary;
   same pair under `{cuisine:'japanese'}` → flips to weak (sanity of the cuisine logic).
4. `enrich-recipe-flavor.ts` → spot-check a recipe's `flavorProfile.dominant` matches intuition;
   idempotent re-run skips all.
5. `eval-flavor-pairing.ts` → good > anti in ≥ 85%; cuisine flip correct. (`npm run eval:flavor-pairing`)
6. E2E: a chef run shows a populated `flavorAudit` and the menu reflecting a bridge suggestion or a
   flagged-pairing fix.

## Estimated effort
| Phase | Scope | Est. |
|------|-------|------|
| 0 | Vendor data + SOURCE.md | 0.5 h |
| 1 | Parse + load to Mongo + indexes | 3–4 h |
| 2 | Cross-lingual resolver + coverage report | 5–7 h |
| 3 | Pairing scorer service (score/bridge/profile) | 5–6 h |
| 4 | Recipe library flavor enrichment | 3–4 h |
| 5 | Tools + register + auto-inject + prompts | 4–5 h |
| 6 | Eval harness + gold set | 3–4 h |
| **Core (1–6)** | **functional quantitative pairing** | **~2.5–3.5 working days** |

The win: chefAgent stops guessing flavor combinations and starts *computing* them — cuisine-aware,
explainable, and grounded in the same science `domain.md` already cites.
