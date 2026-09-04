# Musician domain — porting `claude-ai-music-skills` into `_skills/music/*`

**Status:** COMPLETE — P1-P6 port complete and verified on 2026-06-23.
Approved scope: port **everything** useful for
maximum agent capability (all genres, all artist deep-dives, all craft skills,
mastering/mix/promo/release knowledge). Infra (MCP server, Python tools, state
machine, dashboards) is NOT ported — convention is *borrow prompts/skills, not infra*.

**Goal.** Give `musicianAgent` the same depth of reference knowledge the filmmaker
domain has from seedance-2.0. Today `_skills/music/` does **not exist** and the
agent has **no** `skill_search`/`skill_load` or `music_*_reference` loader wired —
so all the songwriting / style-prompt / genre craft is missing. This plan ports a
large CC0 corpus and wires a dedicated, path-safe reference loader exactly like
`film-reference-tools.ts`.

---

## 0. Source repo facts (verified)

- **Repo:** `bitwize-music-studio/claude-ai-music-skills`, cloned at `/tmp/claude-ai-music-skills`.
- **License:** **CC0 1.0 Universal** (public-domain dedication). We may copy, modify,
  redistribute freely, incl. commercially. No attribution legally required — we will
  still record provenance in frontmatter (courtesy + traceability).
- **Corpus sizes:**
  - `skills/` — **55** skill dirs (each `SKILL.md` + optional supporting `*.md`).
  - `genres/` — **387** genre `README.md` files + **100** artist deep-dives under
    `genres/<g>/artists/*.md`.
  - `reference/` — ~50 docs (suno grammar, mastering, release, promotion, workflows,
    cloud, cross-platform, sheet-music, quick-start).
  - `templates/` — 13 markdown templates (album/track/artist/genre/research/promo/*).
- **Infra we DROP:** `servers/` (MCP), `tools/` (Python), `migrations/`, `hooks/`,
  `config/`, `tests/`, `.mcp.json`, `pyproject.toml`, `requirements*.txt`, `Makefile`,
  `ruff.toml`, `Makefile`, `.github/`, `docs/images/`.

### 0.1 Why a dedicated loader (not SkillRegistry)

Two separate systems coexist in this repo:

1. **`SkillRegistry`** (`services/skill-registry.ts`) — semantic-search registry that
   scans `_skills/**` for `*.md` **with `name`+`description` frontmatter**, embeds
   them, and exposes `skill_search`/`skill_load`. Category = first path segment.
   This is what prints `[SkillRegistry] Initialized: N skills` at startup (the count
   the user watches).
2. **Dedicated domain loaders** — `film-reference-tools.ts` exposes
   `film_load_reference` / `film_search_reference`, resolving **only** under
   `_skills/film/{skills,references,data,examples}`, path-safe, no embeddings.
   Filmmaker uses THIS, not the registry, for `[skill:x]`/`[ref:y]` routing.

**Design decision (mirror filmmaker):** build `music_load_reference` /
`music_search_reference` over `_skills/music`. Consequence by file type:

| File type placed under `_skills/music/` | Has `name`+`desc` frontmatter? | SkillRegistry picks it up? | Reachable via `music_*_reference`? |
|---|---|---|---|
| `skills/<name>/SKILL.md` (ported craft skills) | **Yes** (we add it) | **Yes** → category `music` | Yes (`[skill:name]`) |
| `references/genres/<g>.md` (387) | No | No (kept out of registry) | Yes (`[ref:genres/<g>]`) |
| `references/grammar/*.md`, `references/*` | No | No | Yes (`[ref:...]`) |
| `data/*`, `examples/*` | No | No | Yes |

So the ~15 craft skills **also** become semantically searchable (registry count
rises — directly answers "tyle samo skills w bazie"), while the 387 genres +
grammar stay loader-only and do **not** bloat the embedding index.

---

## 1. Target directory layout (mirrors `_skills/film/`)

```
src/mastra/_skills/music/
  skills/
    lyric-writer/SKILL.md            (+ craft-reference.md, examples.md, documentary-standards.md)
    lyric-reviewer/SKILL.md          (+ checklist-reference.md)
    lyric-refiner/SKILL.md
    pronunciation-specialist/SKILL.md (+ word-lists.md)
    style-prompt-engineer/SKILL.md   (← adapted from suno-engineer + genre-practices.md)
    album-conceptualizer/SKILL.md    (+ album-types.md)
    genre-creator/SKILL.md
    explicit-checker/SKILL.md
    plagiarism-checker/SKILL.md
    voice-checker/SKILL.md
    pre-generation-check/SKILL.md    (adapted: gate list → our lint/safety/caps)
    album-art-director/SKILL.md      (+ visual-styles.md, prompt-examples.md, album-types.md)
    mastering-engineer/SKILL.md      (+ genre-presets.md)        [v2-deferred exec, kept as knowledge]
    mix-engineer/SKILL.md            (+ mix-presets.md)          [v2-deferred exec, kept as knowledge]
    promo-writer/SKILL.md            (+ copy-formulas.md)
    promo-director/SKILL.md          (+ technical-reference.md, visualization-guide.md)
    promo-reviewer/SKILL.md          (+ platform-rules.md)
    release-director/SKILL.md        (+ platform-guides.md)
  references/
    genres/<genre>.md                (387 files, bulk copy of genres/<g>/README.md)
    genres/artists/<genre>__<artist>.md  (100 artist deep-dives, flattened names)
    grammar/structure-tags.md
    grammar/voice-tags.md
    grammar/instrumental-tags.md
    grammar/pronunciation-guide.md
    grammar/tips-and-tricks.md
    grammar/v5-best-practices.md     (kept verbatim as Suno-native reference)
    grammar/surface-grammar-adapter.md   ← NEW (the critical Suno→fal/ElevenLabs map)
    mastering/*.md                   (4 docs)
    release/*.md                     (4 docs)
    promotion/*.md                   (6 docs)
    workflows/*.md                   (7 docs)
    sheet-music/*.md, cloud/*.md, cross-platform/*.md, quick-start/*.md
    terminology.md, model-strategy.md, distribution.md, streaming-mastering-specs.md
  data/
    genre-list.json                 (from reference/suno/genre-list.md, parsed to JSON)
    artist-blocklist.md             (impersonation-safety data → feeds music-validators stance)
    structure-tags.json, voice-tags.json   (optional structured extracts)
  examples/
    track-template.md, album-template.md, artist-template.md, genre-template.md
    promo/*.md                      (5 platform templates)
    example-prompt-specs/*.md       (1–3 hand-written MusicPromptSpec exemplars for our surfaces)
```

Naming notes:
- Artist deep-dives are flattened to `genres/artists/<genre>__<artist>.md` so the
  loader's flat `references/<name>` resolution works without deep nesting collisions.
- `suno-engineer` is renamed `style-prompt-engineer` — its content is rewritten to be
  surface-neutral (it is the single most Suno-coupled skill).

---

## 2. Skill-by-skill disposition (all 55)

### 2.1 PORT + ADAPT (craft / prompt / lyric knowledge) — 18 skills

| Source skill | Target | Adaptation needed |
|---|---|---|
| lyric-writer | skills/lyric-writer | strip `bitwize-music-mcp` from allowed-tools; replace "Suno" refs with surface-neutral + pointer to adapter; keep prosody/rhyme craft verbatim. Bring craft-reference.md, examples.md, documentary-standards.md. |
| lyric-reviewer | skills/lyric-reviewer | de-Suno checklist; map "before Suno generation" → "before `music_generate`". Bring checklist-reference.md. |
| lyric-refiner | skills/lyric-refiner | de-Suno; multi-pass refinement is surface-agnostic. |
| pronunciation-specialist | skills/pronunciation-specialist | de-Suno; "Suno mispronunciations" → "TTS/sung mispronunciation on fal/ElevenLabs". Bring word-lists.md. |
| **suno-engineer** | **skills/style-prompt-engineer** | **Largest rewrite.** Suno Style Box/Lyrics Box/meta-tag DSL → free-text style prompt + (fal) reference audio + (ElevenLabs) `music_length_ms`. Point hard at surface-grammar-adapter. Bring genre-practices.md. |
| album-conceptualizer | skills/album-conceptualizer | de-Suno; 7-phase concept planning maps to our project/track store. Bring album-types.md. |
| genre-creator | skills/genre-creator | adapt output path → `_skills/music/references/genres/`; keep genre-doc schema. |
| explicit-checker | skills/explicit-checker | keep as knowledge; cross-link to `music_check_safety`. |
| plagiarism-checker | skills/plagiarism-checker | keep; cross-link to impersonation stance; web-search via researcherAgent delegate. |
| voice-checker | skills/voice-checker | AI-tell detection is surface-agnostic; keep verbatim minus MCP. |
| pre-generation-check | skills/pre-generation-check | **rewrite gate list** to our reality: sources verified (researcher), lyric reviewed, pronunciation resolved, safety clear (`music_check_safety`), style prompt complete, **paid-cap not reached**, approval token if first paid run. |
| album-art-director | skills/album-art-director | art-prompt knowledge is portable; cover-art generation routes to our image-gen substitute. Bring visual-styles.md, prompt-examples.md, album-types.md. |
| mastering-engineer | skills/mastering-engineer | **knowledge only** (exec deferred to v2 per musician.md §0.3). Bring genre-presets.md. Mark `execution: deferred`. |
| mix-engineer | skills/mix-engineer | **knowledge only** (deferred). Bring mix-presets.md. Mark deferred. |
| promo-writer | skills/promo-writer | platform copy formulas portable. Bring copy-formulas.md. |
| promo-director | skills/promo-director | 15s vertical video knowledge → can route to filmmaker domain. Bring technical-reference.md, visualization-guide.md. |
| promo-reviewer | skills/promo-reviewer | platform rules portable. Bring platform-rules.md. |
| release-director | skills/release-director | distribution/QA knowledge portable. Bring platform-guides.md. |

### 2.2 DROP (infra / workflow / state / we-already-have) — 37 skills

- **bitwize workflow/state:** about, album-dashboard, album-ideas, new-album,
  next-step, promote-idea, rename, resume, session-start, setup, configure,
  health-check, help, test, tutorial, validate-album, clipboard.
- **bitwize import/IO infra:** import-art, import-audio, import-track,
  cloud-uploader, sheet-music-publisher.
- **generic research (we have `researcherAgent`):** researcher, document-hunter,
  verify-sources, researchers-biographical, researchers-financial, researchers-gov,
  researchers-historical, researchers-journalism, researchers-legal,
  researchers-primary-source, researchers-security, researchers-tech,
  researchers-verifier.

> Rationale: these encode bitwize's filesystem/state machine and MCP, which collide
> with our `music-service` project store and harness. The research skills duplicate
> `researcherAgent` (PSEV source-gate) that the musician already delegates to.

---

## 3. The critical adaptation — `references/grammar/surface-grammar-adapter.md` (NEW)

The repo's grammar assumes **Suno V5/V5.5**: a "Style Box" + "Lyrics Box", bracketed
meta-tags (`[Verse]`, `[Chorus]`, `[Bridge]`, `[Intro]`, `[Outro]`, `[End]`), voice
tags, instrumental tags, persona/weirdness/style-influence sliders. **Our default
surfaces do NOT use that DSL:**

| Concept | Suno | fal MiniMax / ACE-Step (default) | ElevenLabs Music |
|---|---|---|---|
| Style input | "Style Box" free text + meta-tags | single free-text `prompt`/`style_prompt` | `prompt` (free text) |
| Lyrics | "Lyrics Box" with `[section]` tags | `lyrics` field; section tags mostly ignored | folded into `prompt`; no separate lyric DSL |
| Structure tags `[Verse]/[Chorus]` | native | **advisory** — convert to natural language ("a driving chorus after two verses") | not honored |
| Voice tags (`[male vocal]`) | native | put in style prompt as plain words | put in prompt as plain words |
| Instrumental | toggle + tags | `generation_mode: instrumental` / `vocal_type` | describe "instrumental" in prompt |
| Reference audio | upload | `reference_audio_url` (audio2audio/extend, ≤10MB) | **NOT supported** (`maxReferences: 0`) |
| Length | implicit | model default | explicit `music_length_ms` (3k–600k) |
| Artist "in style of" | blocked by Suno | **blocked by our `music_check_safety`** → use descriptive era/genre/instrumentation | same |

The adapter doc is the single source of truth every ported skill references instead
of repeating Suno assumptions. It also documents the **Suno seam** (`suno-gateway`,
disabled unless `SUNO_GATEWAY_BASE_URL` set) where the native grammar *does* apply.

---

## 4. Code changes

### 4.1 NEW — `src/mastra/tools/music/music-reference-tools.ts`
Near-verbatim adaptation of `film-reference-tools.ts`:
- `resolveMusicSkillsRoot()` — candidates: `MUSIC_SKILLS_ROOT`,
  `cwd/src/mastra/_skills/music`, `cwd/agentic-agents/src/mastra/_skills/music`,
  `__dirname`-relative fallbacks. Throw if none exist.
- `safeResolveUnder()` — identical path-traversal guard.
- `candidatePaths(kind, name)` — `skill` → `skills/<n>/SKILL.md` | `skills/<n>.md`;
  `reference` → `references/<n>.md` | `references/<n>`; `data` → `data/<n>(.json|.jsonl)`;
  `example` → `examples/<n>(.md|.json)`.
- `musicLoadReferenceTool` (`music_load_reference`): inputs `{kind, name, maxChars}`,
  outputs `{success, path, content, truncated, error}`.
- `musicSearchReferenceTool` (`music_search_reference`): inputs `{query, kind, limit}`,
  filename + snippet term-scoring over the 4 dirs.

### 4.2 WIRE — `src/mastra/agents/musician-agent.ts`
Add import + add `musicLoadReferenceTool`, `musicSearchReferenceTool` to the `tools`
map. (They must be in `tools`, not just prompt text — musician.md §1.2.2.)

### 4.3 PROMPTS — `src/mastra/prompts/music/{domain,pipeline}.md`
Add the `[skill:...]`/`[ref:...]` routing vocabulary, mirroring film/domain.md:
- Style gate → `[skill:style-prompt-engineer]` + `[ref:grammar/surface-grammar-adapter]`.
- Lyric gate → `[skill:lyric-writer]` → `[skill:lyric-reviewer]` → `[skill:pronunciation-specialist]`.
- Genre lookup → `[ref:genres/<genre>]`.
- Safety gate → `[skill:explicit-checker]` + `[ref:data/artist-blocklist]` (alongside `music_check_safety`).
- Pre-gen gate → `[skill:pre-generation-check]` before `music_generate`.
- Concept/album → `[skill:album-conceptualizer]`.

### 4.4 CHECK — `src/mastra/scripts/check-musician-domain.ts`
Extend `requiredFiles` + add assertions:
- `_skills/music/skills/style-prompt-engineer/SKILL.md` exists.
- `_skills/music/skills/lyric-writer/SKILL.md` exists.
- `_skills/music/references/grammar/surface-grammar-adapter.md` exists.
- `references/genres/` has ≥ 300 files (sanity floor).
- `tools/music/music-reference-tools.ts` exports both tools.
- `musician-agent.ts` wires `music_load_reference` + `music_search_reference`.
- At least one ported SKILL.md has `name`+`description` frontmatter (registry pickup).

### 4.5 SkillRegistry — no code change
The registry already scans `_skills/**`. Once SKILL.md files land under
`_skills/music/skills/*`, a restart re-indexes them under category `music`
(`SKILL_EMBEDDING_CONCURRENCY` honored). The startup count rises by the number of
ported craft skills (~18). No migration; restart suffices (per memory: runtime
ToolSearchProcessor/registry embeds on boot; only persisted RAGs need rebuild).

---

## 5. Adaptation checklist (apply to every ported SKILL.md)

1. **Frontmatter** → match film format:
   ```yaml
   ---
   name: <skill-name>
   description: "This skill should be used when ..."   # registry-searchable trigger text
   license: CC0-1.0
   user-invocable: true
   tags: [songwriting | style-prompt | lyrics | genre | mastering | promo ...]
   metadata:
     version: "1.0.0"
     updated: "2026-06-22"
     parent: "musician"
     source_repo: "bitwize-music-studio/claude-ai-music-skills"
     source_skill: "<original-name>"
   ---
   ```
2. **Remove** `argument-hint`, `model`, `effort`, `prerequisites`, and
   `bitwize-music-mcp` from `allowed-tools` (those are bitwize-runtime concepts).
3. **Replace** every "Suno"/"Suno V5"/"Style Box"/"Lyrics Box" with surface-neutral
   wording + a pointer: *"see `[ref:grammar/surface-grammar-adapter]` for how this
   maps to the active surface (fal MiniMax / ElevenLabs / suno-gateway)."*
4. **Rewire file/path assumptions** (album dir READMEs, `dirname` tricks, state files)
   to our `music-service` project/track store and `music_*` tools.
5. **Cross-link our tools** where the skill overlaps: `music_check_safety`,
   `music_lint_prompt`, `music_compile_prompt_spec`, `music_write_lyrics`,
   `music_generate`, `music_record_take`.
6. **Keep craft verbatim** — prosody, rhyme, syllable, density-per-BPM, genre
   conventions: these are the value; do not water them down.
7. **Defer markers** — mastering/mix get `metadata.execution: deferred` and a note
   that audio DSP is v2 (no ffmpeg/stem pipeline yet).

---

## 6. Genre + artist corpus port (bulk, scripted)

- **387 genre READMEs:** copy `genres/<g>/README.md` → `_skills/music/references/genres/<g>.md`
  verbatim (CC0, surface-neutral knowledge). The "Suno Prompt Keywords" section stays
  (useful keyword bank; rename mentally to "style keywords").
- **100 artist deep-dives:** copy `genres/<g>/artists/<a>.md` →
  `_skills/music/references/genres/artists/<g>__<a>.md`. **Guardrail:** these are
  descriptive style references, NOT "clone this artist" instructions. The
  `style-prompt-engineer` skill must convert artist refs → descriptive
  era/genre/instrumentation; the existing `STYLE_IMPERSONATION_PATTERNS` gate in
  `music-validators.ts` still blocks "in the style of <named artist>" at generate time.
- **A one-shot copy step** (Bash `cp`, not committed as a tool) performs the bulk copy;
  only the ~18 SKILL.md files and the adapter doc are hand-edited.

---

## 7. Implementation phases (ordered, each independently verifiable)

- [x] **P1 — Loader + wiring (smallest vertical slice).**
  Create `_skills/music/` skeleton (empty dirs + the adapter doc + one ported skill
  `style-prompt-engineer`). Add `music-reference-tools.ts`. Wire into agent. Extend
  check. `tsc` + `npm run build` + `check:musician-domain` green.
- [x] **P2 — Craft skills.** Port + adapt the remaining 17 skills (§2.1) with supporting
  files. Re-run check; SkillRegistry restart/count confirmation deferred to P6.
- [x] **P3 — Grammar + reference docs.** Port `reference/suno/*` (as grammar/), plus
  mastering/release/promotion/workflows/sheet-music/cloud/cross-platform/quick-start,
  terminology, model-strategy, distribution, streaming-mastering-specs.
- [x] **P4 — Genre corpus (bulk).** Copy 387 genre READMEs + 100 artist deep-dives via
  script. Build `data/genre-list.json` + `data/artist-blocklist.md`.
- [x] **P5 — Examples + prompts.** Port templates → `examples/`; write 1–3 native
  `MusicPromptSpec` exemplars for fal + ElevenLabs. Fill `[skill:]`/`[ref:]` routing
  into `prompts/music/{domain,pipeline}.md`.
- [x] **P6 — Validate end to end.** `tsc`, `npm run build`, `check:musician-domain`;
  initialize SkillRegistry and confirm music count; smoke-test
  `music_search_reference("synthwave")` and `music_load_reference(reference, genres/synthwave)`.

---

## 8. Acceptance criteria

- [x] `_skills/music/` exists with `skills/ references/ data/ examples/` populated.
- [x] `music_load_reference` + `music_search_reference` exported, path-safe, wired into `musicianAgent.tools`.
- [x] `surface-grammar-adapter.md` present; every ported skill points to it instead of assuming Suno.
- [x] 18 craft skills ported with CC0 frontmatter; SkillRegistry initialization confirmed 18 `music` skills / 129 total skills.
- [x] ≥ 387 genre files + 100 artist deep-dives under `references/genres/`.
- [x] `prompts/music/{domain,pipeline}.md` route via `[skill:]`/`[ref:]`.
- [x] `tsc --noEmit` EXIT 0, `npm run build` successful, `check:musician-domain` passed.
- [x] No infra ported (no MCP, no Python, no bitwize state machine).

## 9. Risks / decisions

- **Corpus weight:** ~500 markdown files (~3–5 MB) added to the repo. Acceptable —
  CC0, loader-only (not embedded except 18 skills), high capability payoff.
- **Suno coupling:** mitigated by the adapter doc + de-Suno checklist; `v5-best-practices.md`
  kept verbatim but explicitly labelled "Suno-native; applies only to suno-gateway seam".
- **Impersonation safety:** artist deep-dives are knowledge, not cloning licenses;
  enforcement stays at the `music_check_safety` generate-time gate.
- **Mastering/mix execution:** ported as **knowledge only**; DSP pipeline (ffmpeg/stems)
  remains v2 per musician.md §0.3 — skills are marked `execution: deferred`.
- **Provenance:** CC0 needs no attribution, but `metadata.source_repo`/`source_skill`
  is recorded for traceability and future upstream sync.
```
