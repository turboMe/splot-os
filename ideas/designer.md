# Design Domain — Porting `huashu-design` into Mastra

> End-to-end plan to recreate the open-source `huashu-design` skill (skills.sh, MIT)
> as a first-class **design domain** in our Mastra stack: a `designAgent` + parallel
> design subagents + a tool stack wrapping the repo's scripts, exposed to
> meta / coding / content agents via `delegateTask`.
>
> Source repo (read-only, do NOT modify logic — translation only):
> `agentic-agents/storage/repos_external/huashu-design`
> License: MIT (commercial use OK, attribution appreciated).

---

## 0. What `huashu-design` is (and what ports losslessly)

It is an **agent-agnostic markdown skill** — not an app with its own LLM. The host
agent (Claude Code / Cursor / **our `designAgent`**) is the LLM. It produces:
interactive HTML prototypes (iOS/Android/macOS/browser frames), HTML slide decks →
**editable PPTX**, timeline animations → **MP4/GIF/60fps + BGM**, infographics,
a **design-direction advisor**, a **5-dimension expert critique**, and **voiceover**
narration videos.

| Layer | Ports how | Notes |
|---|---|---|
| `SKILL.md` (the brain) | **Lossless** → `prompts/design/*.md` | Core philosophy, anti-slop, junior workflow, asset protocol |
| `references/*.md` (24 docs) | **Lossless** → `_skills/design/*` | On-demand knowledge (styles, pitfalls, critique, pipelines) |
| `assets/` (React components, BGM, SFX, showcases) | **Lossless** (copy) | Stage+Sprite engine, device frames — static material |
| `scripts/` (render/export/verify) | **Lossless** (wrap, don't rewrite) | Deterministic Node/Python tools |
| Parallel subagents (advisor / critique) | **Functional equivalent** | Native `Task` tool → our `run_worker` ×N parallel |
| `WebSearch` (fact-check Principle #0) | **Functional equivalent** | → delegate to `researcherAgent` (PSEV) |
| Image gen (`huashu-gpt-image` / `nano-banana-pro`) | **Substitute** | NOT in repo — use our `gemini-image-pro` / `imagen-4-ultra` |
| TTS (ByteDance Doubao) | **Substitute** | Chinese voice-clone API — replace with **ElevenLabs** |

**Biggest quality lever = the model assigned to `designAgent`.** The skill is
model-bound; the prompt ports perfectly but output fidelity tracks the model. Use a
frontier coder/multimodal (Claude Opus/Sonnet), NOT a flash-lite.

---

## 1. Translation recovery — DONE (2026-06-18)

The in-progress ZH→EN translation had **truncated 11 functional files** (content loss,
not leftover Chinese). Recovered from `git HEAD` and fully re-translated:

| File | Was | Now |
|---|---|---|
| `SKILL.md` | 241/631 | 634 ✓ |
| `assets/director-notes-samples/launch-film-30s-sample.md` | 25/1713 | 1713 ✓ |
| `references/slide-decks.md` | 297/745 | 745 ✓ |
| `references/animation-pitfalls.md` | 22/402 | 402 ✓ |
| `references/editable-pptx.md` | 19/334 | 334 ✓ |
| `references/design-styles.md` | 184/370 | 370 ✓ |
| `references/audio-design-rules.md` | 123/260 | 260 ✓ |
| `references/animation-best-practices.md` | 491/506 | 506 ✓ |
| `references/apple-gallery-showcase.md` | 324/338 | 338 ✓ |
| `assets/deck_index.html` | 221/348 | 348 ✓ |
| `assets/showcases/infographic/infographic-takram.html` | 568/669 | 670 ✓ |

Intentional residual non-English (correct, leave as-is): Kenya Hara's Japanese quote +
`至` char example in launch-film; literal path `参考动画/BEST-PRACTICES.md`.

**Out of scope / open decision (never part of the translation pass):**
- `README.md` — this is the *Chinese* default README; `README.en.md` is the full
  English one. Decide: keep Chinese, or replace with English. Not runtime-critical.
- `demos/*` (sample outputs; non-`-en` files are intentionally Chinese),
  `.env.example` / `.gitignore` comments, `LICENSE` (author name), `banner.svg`.

---

## 2. Target architecture (mapping)

```
huashu-design skill                Mastra design domain
─────────────────────────────────────────────────────────────────
SKILL.md                     →     prompts/design/domain.md  (+ pipeline.md)
references/*.md               →     _skills/design/*.md   (skill_search/skill_load)
assets/ (components, BGM,SFX) →     assets/design/  (served to generated HTML)
scripts/*.js|.mjs|.py|.sh     →     tools/design/* (createTool wrappers)
native parallel subagents     →     run_worker(preset:'design') × N in parallel
WebSearch (Principle #0)      →     delegateTask → researcherAgent
brand asset fetch             →     tools/design/fetch-assets (new)
image generation              →     tools/design/generate-image (gemini-image-pro)
voiceover TTS                 →     tools/design/tts (ElevenLabs)
```

`designAgent` follows the **chefAgent pattern** (`agents/chef-agent.ts`):
`combinePrompts('design/domain','design/pipeline')`, thread-scoped memory,
`maxSteps: 150`, `createTokenLimiter(120_000)`, full tool stack + `delegateTask` +
`runWorkerTool`.

---

## 3. Model manifest changes (`config/model-manifest.ts`)

### 3a. Add ElevenLabs to Section 1 (TTS inventory)
```ts
// ElevenLabs (klucz: ELEVENLABS_API_KEY) — najlepsza jakość TTS + voice cloning
'eleven-v3': 'elevenlabs/eleven_v3',                  // najnowszy, emocje/tagi
'eleven-multilingual-v2': 'elevenlabs/eleven_multilingual_v2', // 29 języków, stabilny
'eleven-turbo-v2.5': 'elevenlabs/eleven_turbo_v2_5',  // niski latency
```
> Image gen + Imagen + GPT-Image + FLUX already exist in the inventory — reuse them.

### 3b. Add `designAgent` to Section 2 (agentModels)
```ts
designAgent: 'claude-opus-4.8' as ModelKey,  // HTML/design orchestrator — Claude best at frontend/taste
```

### 3c. New Section: design domain sub-model assignments
```ts
// SECTION 7: DESIGN DOMAIN ASSIGNMENTS
export const designAssignments = {
  htmlGenerator:   'claude-sonnet-4.6' as ModelKey, // parallel subagents: strong frontend, best value
  directionAdvisor:'claude-opus-4.8'  as ModelKey,  // 3-direction strategy
  expertCritique:  'gpt-5.5'          as ModelKey,  // 5-dim review — independent provider for diversity
  narrationWriter: 'claude-sonnet-4.6' as ModelKey, // voiceover script
  imageGen:        'gemini-image-pro' as ModelKey,  // "nano banana" — content/product illustration
  imageGenPhoto:   'imagen-4-ultra'   as ModelKey,  // photorealistic fallback
  tts:             'eleven-multilingual-v2' as ModelKey,
} as const;
```

### 3d. Add a `design` worker preset (Section 4)
```ts
// in workerPresets:
design: 'claude-sonnet-4.6' as ModelKey,  // parallel HTML generation subagents
```

### 3e. Fallback chain for designAgent (Section 4b)
```ts
// in agentFallbackChains:
designAgent: ['claude-opus-4.8', 'claude-sonnet-4.6', 'gpt-5.5'],
```

---

## 4. Tool inventory (`tools/design/`) — wrap, don't rewrite

Each tool shells out to the existing repo script (kept verbatim) and returns
structured output. Pattern: `execFile`/`spawn` from a pinned `DESIGN_SKILL_ROOT`.

| Tool id | Wraps | Purpose |
|---|---|---|
| `design_render_video` | `scripts/render-video.js` | HTML animation → MP4 (Playwright + ffmpeg) |
| `design_render_video_seek` | `scripts/render-video-seek.js` | deterministic 60fps frame-seek render |
| `design_convert_formats` | `scripts/convert-formats.sh` | MP4 → 60fps interp + GIF |
| `design_add_music` | `scripts/add-music.sh` | MP4 + BGM mix |
| `design_export_pptx` | `scripts/html2pptx.js` + `export_deck_pptx.mjs` | HTML deck → editable PPTX |
| `design_export_pdf` | `scripts/export_deck_pdf.mjs` / `export_deck_stage_pdf.mjs` | deck → vector PDF |
| `design_gen_thumbs` | `scripts/gen_deck_thumbs.mjs` | deck gallery thumbnails |
| `design_verify` | `scripts/verify.py` | Playwright multi-viewport visual QA |
| `design_fetch_images` | `scripts/fetch_images.py` | real images from Wikimedia Commons |
| `design_fetch_brand_assets` | NEW | logo (svgl→simpleicons→favicon) / press-kit / UI shots |
| `design_generate_image` | NEW → manifest-selected Google Gemini Image / Imagen / OpenAI GPT Image | AI image gen (replaces huashu-gpt-image) |
| `design_tts` | NEW → ElevenLabs (replaces `tts-doubao.mjs`) | narration audio; **must return `duration`** |
| `design_narrate_pipeline` | `scripts/narrate-pipeline.mjs` (re-point TTS to `design_tts`) | script.md → voiceover.mp3 + timeline.json |

⚠️ `narrate-pipeline.mjs` + `render-narration.sh` + `mix-voiceover.sh` are coupled to
Doubao's response contract (per-segment `duration` → `timeline.json`). The new
`design_tts` (ElevenLabs) **must reproduce that JSON shape** so the pipeline is a
drop-in swap.

---

## 5. Subagents & parallelism

The skill's two parallel flows map to `run_worker(preset:'design')` called **N× in
one message** (true parallelism), each with an isolated context + anti-convergence
anchor (index / reference case / designer name) — exactly as the skill prescribes for
"runtimes that spawn subagents":

1. **Design Direction Advisor** (vague brief): freeze one shared spec → spawn **3**
   parallel workers, each forced onto a different school from `design-styles.md`
   (Seconds Roulette / camp-based / designer-anchored) → 3 distinct HTML options.
2. **Multi-perspective expert critique**: spawn workers per perspective → consolidate
   into radar + Keep/Fix/Quick-Wins punch list (`critique-guide.md`).

The orchestrator (`designAgent`) does substantive work while workers run (writes the
critique framework, fixes the main version), mirroring the case study.

---

## 6. Research delegation

- **Fact verification (Principle #0)** — "does DJI Pocket 4 exist / version / specs" →
  `delegateTask({ targetAgent: 'researcherAgent', ... })`. Our PSEV researcher is a
  1:1 match (returns triangulated findings + source URLs). **Do not rebuild.**
- **Brand asset acquisition** — downloading logos/renders/UI screenshots/colors is
  NOT what the researcher does (it's a text/JSON information-gatherer, "do NOT
  download files"). This stays as domain tools (`design_fetch_brand_assets`,
  `design_fetch_images`).

---

## 7. Registration & exposure

1. `agents/design-agent.ts` — new agent (chef pattern).
2. `index.ts` — register `designAgent` in `new Mastra({ agents: { ... } })`.
3. `config/agent-ids.ts` — add `DESIGN_AGENT_ID`; include in
   `DELEGATION_CALLER_AGENT_IDS` / `DELEGATION_RETURN_AGENT_IDS` if it will delegate.
4. `tools/system/delegate-task.ts` — add `designAgent` to `AGENT_IDS`, the
   `targetAgent` enum, and the routing description so **meta / coding / content** can
   delegate ("make a launch animation", "build an iOS prototype", "turn this deck into
   editable PPTX"). Use plain `generate` (NOT `generatePipelineWithReflection`) for v1 —
   see Resolved decisions §11.
5. `config/pipeline-phase-tools.ts` — no change for v1 (reflector deferred; only touch
   this if we later add explicit design phases).

---

## 8. Environment prerequisites (host)

- **Binaries:** `ffmpeg` + `ffprobe`, Playwright Chromium (`npx playwright install
  chromium`), Python 3, optionally `yt-dlp` (product/UI frames from launch videos).
- **npm:** `playwright`, `pptxgenjs`, `sharp`, `pdf-lib` (already in the repo's
  `package.json`).
- **Fonts:** display serifs used by styles (or self-host to `assets/design/fonts/`).
- **API keys:** `ELEVENLABS_API_KEY` (new), `GOOGLE_GENERATIVE_AI_API_KEY` (image gen +
  imagen — present), `TAVILY` (researcher — present).
- **Filesystem:** `designAgent` needs a real working dir with write access to emit HTML
  and run scripts (like `codingAgent`'s workspace).

---

## 9. Phased implementation plan (the path we follow)

- [x] **P0 · Translation recovery** — all 11 truncated files restored from HEAD + verified.
- [x] **P1 · Skeleton** — `prompts/design/{domain,pipeline}.md` (from `SKILL.md`),
  `_skills/design/*` (from `references/*`), copy `assets/` → `assets/design/`.
  - DONE 2026-06-18: `src/mastra/prompts/design/domain.md` is a lossless copy of
    `SKILL.md` (634 lines); `pipeline.md` adds the Mastra path/delegation adapter;
    copied 24 reference docs to `src/mastra/_skills/design` and 104 asset files to
    `src/mastra/assets/design`.
  - End-test note: after agent registration, ask `designAgent` to load one reference
    from `_skills/design` and one component from `assets/design` while creating a tiny
    HTML prototype, to verify prompt path adaptation in a real model run.
- [x] **P2 · Model manifest** — add ElevenLabs aliases, `designAgent`,
  `designAssignments`, `design` worker preset, fallback chain.
  - DONE 2026-06-18: added ElevenLabs TTS aliases, `agentModels.designAgent`,
    `designAssignments`, `workerPresets.design`, `agentFallbackChains.designAgent`,
    and `run_worker` enum/description support for `preset: 'design'`.
    Added `claude-opus-4.8` to the model capability registry so the design fallback
    chain is health-checkable.
  - End-test note: in the final model run, call `system_run_worker` with
    `preset: 'design'` for a small HTML variation brief and verify the returned model
    is `anthropic/claude-sonnet-4-6`; also verify `fallbackChainForAgent('design-agent')`
    resolves Opus → Sonnet → GPT-5.5.
- [ ] **P3 · Read-only tools first** — `design_fetch_images`, `design_fetch_brand_assets`,
  `design_generate_image`, `design_verify`. Validate each in isolation.
  - PARTIAL 2026-06-18: added `src/mastra/tools/design/design-tools.ts` with
    structured wrappers for `design_fetch_images` (`scripts/fetch_images.py`),
    `design_fetch_brand_assets` (SVGL → Simple Icons → favicon fallback), and
    `design_verify` (`scripts/verify.py`). TypeScript check passes.
  - UPDATE 2026-06-18: added `design_generate_image` using Google GenAI REST for
    Gemini image and Imagen models, writing generated bitmap files and returning
    structured paths/errors. TypeScript check passes.
  - UPDATE 2026-06-18: extended `design_generate_image` to support OpenAI GPT Image
    aliases (`gpt-image-2`, `gpt-image-1`) in addition to Google models. The tool now
    resolves provider from `model-manifest.ts`, so `designAssignments.imageGen` and
    `designAssignments.imageGenPhoto` can be switched between Google/Imagen/OpenAI
    without code changes. TypeScript check passes.
  - UPDATE 2026-06-18: fixed `design_verify`/Huashu script root resolution for both
    source runtime and `.mastra/output` runtime; added optional `DESIGN_SKILL_ROOT`
    override. Smoke test now finds `storage/repos_external/huashu-design`, then fails
    only because Python `playwright` is not installed on the host.
  - Still open: isolation validation is deferred to the final real-model/API test queue.
  - End-test note: run `design_fetch_images` against one Wikimedia query, run
    `design_fetch_brand_assets` for two known brands with official logos, generate one
    small image with `gemini-image-pro`, repeat image generation with `gpt-image-2`
    using `OPENAI_API_KEY`, then run `design_verify` on a minimal local HTML file
    and inspect screenshot paths plus console/page error reporting.
- [ ] **P4 · Export tools** — `design_render_video(_seek)`, `convert_formats`,
  `export_pptx`, `export_pdf`, `gen_thumbs`. Confirm binaries on host.
  - PARTIAL 2026-06-18: added structured wrappers in
    `src/mastra/tools/design/design-tools.ts` for `design_render_video`,
    `design_render_video_seek`, `design_convert_formats`, `design_add_music`,
    `design_export_pptx`, `design_export_pdf`, and `design_gen_thumbs`. TypeScript
    check passes.
  - Still open: host validation with Playwright Chromium, ffmpeg/ffprobe, pptxgenjs,
    sharp, and pdf-lib is deferred to the final validation queue.
  - End-test note: render a minimal Stage animation with both realtime and seek
    renderers, convert it to 60fps/GIF, mix one built-in BGM mood, export a 2-slide
    multi-file deck to PDF/PPTX, and generate deck thumbnails.
- [ ] **P5 · Voiceover** — `design_tts` (ElevenLabs, duration-contract), re-point
  `narrate-pipeline.mjs`, end-to-end narration MP4.
  - PARTIAL 2026-06-18: added `design_tts` using ElevenLabs text-to-speech
    `/with-timestamps` when requested, writes audio plus optional alignment sidecar,
    and returns measured `duration`. Added `design_narrate_pipeline`, a Mastra-native
    ElevenLabs replacement for the Doubao-coupled script: parses `## scene-id` and
    `[[cue:id]]`, generates chunk audio, concatenates `voiceover.mp3`, and writes
    huashu-compatible `timeline.json`. TypeScript check passes.
  - Still open: validate with a real ElevenLabs voice/API key and run final
    narration HTML → MP4 through `render-narration.sh`/mixing flow.
  - End-test note: synthesize one single segment with timestamps, then run a two-scene
    narration script and verify `timeline.json.totalDuration`, per-scene chunks/cues,
    and final `voiceover.mp3` duration with `ffprobe`.
- [x] **P6 · Agent** — `agents/design-agent.ts` + register + memory + token limiter +
  `runWorkerTool` + `delegateTaskTool`.
  - DONE 2026-06-18: added `src/mastra/agents/design-agent.ts` using the chef/content
    pattern: `combinePrompts('design/domain', 'design/pipeline')`, `agentModels.designAgent`,
    thread-scoped observational memory, `maxSteps: 150`, `createTokenLimiter(120_000)`,
    all `design_*` tools, plus `runWorkerTool`, `delegateTaskTool`, approval/time/memory
    tools. Registered `designAgent` in `src/mastra/index.ts`. TypeScript check passes.
  - End-test note: start Mastra and verify `/api/agents` exposes `designAgent`, then run
    a tiny prompt that uses one design tool and one `run_worker(preset:'design')`
    delegation without invoking exports beyond the final validation queue.
- [x] **P7 · Parallelism** — wire Direction Advisor (3 workers) + expert critique.
  - DONE 2026-06-18: wired by prompt + runtime primitives rather than a new state
    machine: `pipeline.md` maps advisor/critique flows to isolated
    `system_run_worker({ preset: 'design' })` calls, P2 registered the `design`
    preset, and P6 exposes `runWorkerTool` to `designAgent`. No reflector or
    `pipeline-phase-tools.ts` mapping added for v1, matching Resolved decisions §11.
  - End-test note: in the final real-model run, verify a vague brief produces three
    isolated worker calls with distinct anchors, and a critique prompt produces
    separate perspective outputs before consolidation.
- [x] **P8 · Exposure** — `delegate-task.ts` enum + description; agent-ids (plain
  `generate`, no reflector for v1).
  - DONE 2026-06-18: added `DESIGN_AGENT_ID` / `DESIGN_AGENT_MASTRA_AGENT_ID` and
    aliases in `config/agent-ids.ts`, included design in delegation caller/return
    enums, added `designAgent` to `system_delegate_task` routing, target enum,
    domain description, recursive self-delegation guard, and delegation success
    criteria. TypeScript check passes. `pipeline-phase-tools.ts` intentionally
    unchanged for v1.
  - End-test note: call `system_delegate_task({ targetAgent: 'designAgent', ... })`
    from meta/coding/content context and verify it routes through plain direct
    `generate` with memory, not `generatePipelineWithReflection`.
- [ ] **P9 · E2E validation** — run `test-prompts.json` style prompts: iOS prototype,
  keynote→PPTX, launch animation→MP4, infographic→PDF, 5-dim review.

### Non-model verification so far

- 2026-06-18: `npx tsc --noEmit --pretty false` passes after P1-P8 code changes.
- 2026-06-18: `npm run build` passes after final `designAssignments` correction and
  `designAgent` registration.

### Final real-model test queue (defer until implementation end)

- [ ] **Prompt/path smoke**: `designAgent` loads `prompts/design/domain.md` +
  `pipeline.md`, references one doc from `_skills/design`, and inlines one component
  from `assets/design` into a tiny HTML prototype.
- [ ] **Worker preset smoke**: `system_run_worker({ preset: 'design', ... })` returns
  using `anthropic/claude-sonnet-4-6`; fallback lookup for `design-agent` resolves
  Opus → Sonnet → GPT-5.5.
- [ ] **P3 tool isolation**: Wikimedia image fetch, brand logo fetch, one generated image,
  one Google/Imagen generated image, one OpenAI generated image, and HTML verification
  all return structured outputs with paths and failure details.
- [ ] **Advisor parallelism**: vague one-sentence brief triggers 3 isolated design
  directions, each with a distinct anchor and separate HTML output.
- [ ] **Research gate**: a prompt mentioning a current product/version delegates to
  `researcherAgent` before asserting facts and writes/returns source URLs.
- [ ] **Export stack**: deck HTML → PDF; editable PPTX has real text frames; animation
  HTML → MP4 has no black-frame head; GIF/60fps conversion works where required.
- [ ] **Voiceover stack**: ElevenLabs `design_tts` returns audio plus measured duration;
  narration pipeline emits `timeline.json`; final MP4 has voiceover timing aligned.
- [ ] **Acceptance prompts**: run the five capability classes from P9: iOS prototype,
  keynote→PPTX, launch animation→MP4, infographic→PDF, and 5-dimension review.

---

## 10. Acceptance criteria

1. One-sentence brief → finished deliverable in each of the 5 capability classes.
2. Editable PPTX exports as **real text frames** (not image-bed).
3. Animation MP4 has no black-frame head (the `__ready`/`__seek` trim works).
4. Brand task fetches a **real logo** (no CSS silhouette) per the Asset Protocol.
5. Vague brief auto-triggers **3 parallel directions** with isolated contexts.
6. Voiceover MP4 has narration timed to `timeline.json` from ElevenLabs.
7. Fact-bearing prompts trigger a `researcherAgent` delegation before asserting.

---

## 11. Resolved decisions

- **README.md** — RESOLVED: keep Chinese (repo convention); `README.en.md` is the
  English one. Not runtime-critical, no action.
- **Demos** — RESOLVED: leave `demos/*` as-is (sample outputs, non-`-en` intentionally
  Chinese). No translation.
- **Reflector** — RESOLVED: **NOT in v1**. Use plain `generate` (`maxSteps: 150`, like
  chef). The reflector only pays off for deterministic phase-gated state machines (needs
  a `*_set_project_status` tool + linear phases + `pipeline-phase-tools.ts` allowlists);
  design is open-ended + parallel-subagent-driven, so it would just fail-open. Revisit
  only if we later define explicit design phases (intake→advisor→draft→variations→
  critique→export) with a `design_set_project_status` tool.
- **Generative video (Veo)** — RESOLVED: **skip**. huashu uses HTML→record (Stage+Sprite
  HTML/CSS/JS recorded via Playwright Chromium `recordVideo` + ffmpeg → MP4/GIF), NOT a
  diffusion model. Veo is a different category and too costly for tests. Env needs
  ffmpeg+ffprobe+Playwright Chromium instead. Revisit only for true generative clips.
