# Musician Domain — AI Music Generation (`musicianAgent`)

> End-to-end dev plan for a first-class **musician domain** in our Mastra stack:
> a `musicianAgent` (chef-pattern + reflector, lighter state) + parallel music
> subagents + a tool stack that compiles **lyrics + style prompt**, validates
> deterministically, and **closes the full generative loop** by calling a real
> music-generation surface (fal / ElevenLabs / Suno-gateway) via a native tool,
> then downloads a finished audio file (vocals + music in one track).
>
> Sibling plans to mirror for conventions: `agentic-agents/ideas/filmmaker.md`
> (the closest analog — same generate→poll→download shape) and
> `agentic-agents/ideas/designer.md`.
>
> **Key decision up front (locked with the user):** we do NOT anchor on Suno.
> Suno v5 is the quality leader but has **no official public API** (2026), so it
> would force a third-party gateway or a scraper. Default surfaces are the
> *official, commercially-cleared, already-keyed* ones in our stack — **fal**
> (MiniMax Music / ACE-Step / Stable Audio via `FAL_KEY`) and **ElevenLabs Music**
> (`ELEVENLABS_API_KEY`). Suno stays as a config-only, env-swappable
> `suno-gateway` seam for "premium quality on demand", never as the foundation
> and never via scraping.

---

## 0. What the musician domain is — and why it is CHEF (with lighter state)

The musician follows the **`chefAgent` pattern** (persistent project store +
status state machine + reflector + per-phase tool channeling), exactly like
filmmaker/chef/content/hunt/writer. It has **explicit linear phases**
(brief → lyrics → style → safety → generate → review → deliver), so the
reflector + `pipeline-phase-tools.ts` allowlist is the right fit.

### 0.1 Two differences from the filmmaker domain

| | `filmmaker` (Seedance video) | `musician` (music) |
|---|---|---|
| Who renders | external model renders the clip | external model renders the **full song (vocals+music)** |
| State weight | **heavy**: sequence projects, clip lineage, continuity ledger, canon revisions | **light**: a track is usually ONE generation, not a chain of dependent clips. No continuity-lock chain. Project = brief + lyrics + style + takes. |
| Parallelism | **never** fan out across clips (sequential — continuation needs prior accepted take) | album/EP tracks **are** independent → CAN fan out in parallel (inversion of the film rule). Within one track, parallelism is A/B variants only. |
| Generation transport | all surfaces are **async queue + poll** | **mixed**: fal = async poll; **ElevenLabs `POST /v1/music` is SYNC (returns audio bytes directly)**. The surface abstraction must support both. |
| References | first/last frame images (I2V/FLF2V) | optional **reference audio** (audio2audio / remix / extend) + optional **voice id** (ElevenLabs). Not frames. |
| Quality lever | prompt/camera grammar | **lyrics + style-prompt engineering** (borrow Suno prompt skills as reference knowledge). |
| Native audio | Seedance audio is native | the surface IS the audio — no separate TTS for the song. |

**Consequence:** copy the filmmaker scaffold, but **simplify the project store**
(drop clip lineage / continuity-lock / canon-revision machinery; keep
project + track + takes + run-ledger) and **generalize the generate tool's
transport** (sync vs async-poll per surface).

### 0.2 Scope decisions (locked)

1. **Full generative loop = YES, from v1.** Compile lyrics+style AND call a real
   surface to produce the audio file.
2. **Native Mastra tool, NOT MCP.** Generation is a `createTool` calling REST
   (same rationale as filmmaker §0.2: control, run-ledger, pre-send validation,
   smaller attack surface). The available ElevenLabs MCP in this environment does
   not even expose a music-generation tool (only `dubbing` / `voice_change` /
   `list_voices`), confirming native REST is the right path. MCP is a *possible
   future export skin* (v3), not a runtime dependency.
3. **Default surface = fal (MiniMax Music 2.x); ElevenLabs = first-class second
   seam; Suno = config-only gateway seam (DEFERRED implementation).** Every model
   is **env-swappable** (user requirement): change `MUSIC_SURFACE` /
   `MUSIC_FAL_MODEL_ID` and restart — no code touches the model choice. This is
   the same surface-config pattern `config/film-surfaces.ts` already uses.
4. **Meta-agent must be able to DELEGATE to the musician** (not only direct chat)
   — see §8. Same `system_delegate_task` wiring chef/filmmaker use.

### 0.3 What ports / what must be built

| Layer | How | Notes |
|---|---|---|
| Filmmaker scaffold (agent, service, ledger, schemas, validators, project tools, surfaces, check) | **Adapt** (copy structure, simplify state) | `music-*` mirrors `film-*`. |
| Suno/music prompt-engineering knowledge (`claude-ai-music-skills` `suno-engineer`, `suno-band-manager` style/lyric builders) | **Port as reference knowledge** → `_skills/music/*` | These are PROMPT/LYRIC knowledge, NOT infra. Borrow prompts/skills, not infra (project convention). Adapt "Suno V5 grammar" → MiniMax/ACE-Step/ElevenLabs grammar via a style-adapter, like the Veo seam. |
| `music-generate.ts` (generative loop) | **BUILD (new)** | Generalize film-generate transport to sync + async-poll. |
| `music-surfaces.ts` (fal / elevenlabs / suno-gateway) | **BUILD (new)** | Mirror film-surfaces; add `responseMode` + per-surface body mappers. |
| Reference audio input (audio2audio / extend) | **BUILD (light)** | Path/URL guard reused from film-generate `referenceValue()`. |
| Source/fact gate (model IDs, pricing, region) | **Delegate** → `researcherAgent` (PSEV) | Same as filmmaker. |
| Spoken intro/outro TTS, stems/mastering | **DEFER** (v2) | Reuse `design_tts` (ElevenLabs) + ffmpeg only if/when needed. |

---

## 1. Target architecture (mapping)

```
filmmaker domain                  musician domain
────────────────────────────────────────────────────────────────────
prompts/film/{domain,pipeline}.md → prompts/music/{domain,pipeline}.md
_skills/film/*                     → _skills/music/*  (ported Suno prompt knowledge + style/lyric refs)
config/film-schemas/*              → config/music-schemas/* + lib/music-schemas.ts (zod)
tools/film/film-validators.ts      → tools/music/music-validators.ts (lyric/style/spec lint; TS-only is fine — see §4.2)
tools/film/film-service.ts         → tools/music/music-service.ts  (SIMPLIFIED: project + track + takes + runs)
tools/film/film-ledger.ts          → tools/music/music-ledger.ts   (generation-run rows)
tools/film/film-project-tools.ts   → tools/music/music-project-tools.ts
tools/film/film-generate.ts        → tools/music/music-generate.ts (sync + async-poll transports)
config/film-surfaces.ts            → config/music-surfaces.ts      (fal | elevenlabs | suno-gateway)
agents/film-agent.ts               → agents/musician-agent.ts
run_worker(preset:'film')          → run_worker(preset:'music')    (A/B lyric/style variants; album tracks)
researcherAgent source-gate        → SAME (delegate model-id/pricing facts)
```

`musicianAgent` = chef pattern: `combinePrompts('music/domain','music/pipeline')`,
thread-scoped observational memory, `maxSteps: 150`, `createTokenLimiter(120_000)`,
full `music_*` tool stack + `runWorkerTool` + `delegateTaskTool` +
`requestApprovalTool` + standard system/memory tools. Registered as a **pipeline
agent** so delegations auto-route through `generatePipelineWithReflection`.

### 1.1 Naming (must be internally consistent)

The fallback-chain health lookup (`agentModelKeyForId`) requires the Mastra
`agent.id` to be the **kebab-case** of the `agentModels` key. Mirror filmmaker:

| Thing | Value |
|---|---|
| `agentModels` key / registry key / delegate enum / `PIPELINE_PHASE_TOOLS` key / `AGENT_IDS` | `musicianAgent` |
| Mastra `Agent.id` | `musician-agent` |
| `agent-ids.ts` consts | `MUSICIAN_AGENT_ID='musicianAgent'`, `MUSICIAN_AGENT_MASTRA_AGENT_ID='musician-agent'`, `MUSICIAN_AGENT_ALIASES` |
| Tool id prefix | `music_*` (e.g. `music_set_project_status`, `music_generate`) |
| Tool export vars | `music*Tool` (e.g. `musicSetProjectStatusTool`) |
| Worker preset | `music` |
| Static check | `check:musician-domain` |
| Mongo collections | `music_projects`, `music_generation_runs` (reuse `approvals`) |

### 1.2 Pre-implementation hardening (mandatory, from repo review)

1. **`run_worker(preset:'music')` needs two code changes.** Add `workerPresets.music`
   in `config/model-manifest.ts` AND add `music` to the `z.enum([...])` and
   `PRESET_ROLES` in `tools/system/run-worker.ts` (otherwise the manifest
   advertises a preset the tool schema rejects). Cover both in `check:musician-domain`.
2. **Reference/skill loading must be explicit.** Mirror filmmaker: either give
   `musicianAgent` `skill_search`/`skill_load` with frontmatter-indexed
   `_skills/music/*`, OR build dedicated read-only `music_search_reference` /
   `music_load_reference` tools resolving only under `src/mastra/_skills/music`.
   Do NOT rely on prompt-only path instructions with no loader tool.
3. **Paid generation must use the harness tool envelope.** `music_generate` wraps
   its executor in `withToolEnvelope({ toolId:'music_generate', category:'other',
   risk:'medium', defaultAgentId: META_AGENT_ID, redactInputFields:['prompt','lyrics','referenceAudio'] })`
   — same as `film_generate`. A comment is not runtime enforcement.
4. **Approval is fail-closed.** First paid generation in a project returns
   `{ ok:false, error:'approval_required', approvalRequest }` before any remote
   call, unless the project ledger already records approval OR a valid approval
   token/id is supplied. Reuse the film-service approval state machine verbatim
   (`getApprovalStatus` → approved/pending/denied/missing; never collapse to one
   throw — that is what caused the film approval-retry loop).
5. **Code-enforced spend caps.** Port `MUSIC_MAX_PAID_GENERATIONS_PER_TRACK` (default 3)
   and `MUSIC_MAX_PAID_GENERATIONS_PER_PROJECT` (default 12), counted from the
   run-ledger, enforced inside the tool so meta/musician/workers are all bounded.
   Mark content-policy rejections `terminal: true` (re-submitting burns paid spend).
6. **Surface capability validation is part of v1.** `music-surfaces.ts` carries
   per-surface limits (supported modes, length range, output formats, max
   reference audio, vocals support, language support, `responseMode`). Validate
   before sending.
7. **Copyright/safety gate is separate from prompt lint.** A pre-send safety
   validator for: named-artist mimicry ("in the style of [living artist]"),
   exact-voice cloning without consent, IP/lyrics plagiarism, disallowed content.
   Music-specific — `prompt_lint` checks style/lyric SHAPE, not legal risk.
8. **Static domain check required.** `check:musician-domain` early, modeled on
   `check:filmmaker-domain`, so registration drift is caught before any API call.

---

## 2. Model manifest changes (`config/model-manifest.ts`)

> ⚠️ Default = `deepseek-v4-pro` for test economy, BUT every entry is a plain
> `ModelKey` — freely swappable to ANY manifest model (claude-opus-4.8 is the
> strong candidate for taste-bound lyric/style writing). Keep `musicianAssignments`
> granular so sub-roles tune independently. The **music model itself is NOT a
> Mastra `ModelKey`** — it is a remote REST surface, configured in
> `config/music-surfaces.ts`, NOT in the `models` map.

### 2a. `agentModels`
```ts
musicianAgent: 'deepseek-v4-pro' as ModelKey,  // lyric + style-prompt compiler / music director.
// claude-opus-4.8 is a strong candidate for taste-bound lyric writing.
```

### 2b. Worker preset
```ts
// in workerPresets:
music: 'deepseek-v4-pro' as ModelKey,  // parallel lyric/style variants + per-track album fan-out
```
Also update `tools/system/run-worker.ts`: add `'music'` to the `preset`
`z.enum([...])` and `music: 'Lyric/style prompt variants, hook A/B, per-track album drafts'`
to `PRESET_ROLES`. Assert both in `check:musician-domain`.

### 2c. Fallback chain
```ts
// in agentFallbackChains:
musicianAgent: ['deepseek-v4-pro', 'deepseek-v4-flash', 'gemini-2.5-flash'],
// PRODUCTION: ['claude-opus-4.8','claude-sonnet-4.6','gpt-5.5'] — every entry MUST exist
// in config/model-capabilities.ts to be health-checkable.
```

### 2d. New section: musician domain assignments
```ts
// SECTION 10: MUSICIAN DOMAIN ASSIGNMENTS
// Every value is a ModelKey from Section 1 → swap freely while testing.
export const musicianAssignments = {
  orchestrator:  'deepseek-v4-pro' as ModelKey,  // director / phase driver (check asserts this key, mirroring filmmaker)
  lyricist:      'deepseek-v4-pro' as ModelKey,  // lyrics writing (claude-opus-4.8 candidate)
  stylePrompter: 'deepseek-v4-pro' as ModelKey,  // genre/instrument/production style prompt compiler
  interviewer:   'deepseek-v4-pro' as ModelKey,  // vague idea → song brief
  variantWorker: 'deepseek-v4-pro' as ModelKey,  // parallel A/B lyric/style variants (run_worker preset)
  takeReviewer:  'deepseek-v4-pro' as ModelKey,  // listen-back triage (text-only verdict on returned metadata)
} as const;
```

> The existing ElevenLabs TTS aliases (`eleven-v3`, `eleven-multilingual-v2`,
> `eleven-turbo-v2.5`) and `design_tts` are for SPOKEN narration, NOT the song.
> They are only relevant to the DEFERRED spoken-intro/outro v2 path (§15).

---

## 3. Schemas (`config/music-schemas/` + `lib/music-schemas.ts`)

Define JSON Schemas + **zod mirrors** (validated in-process). Far fewer than film
(no clip-lineage/continuity chain).

| Schema | Drives |
|---|---|
| `song-brief.schema.json` | the brief (objective, genre(s), mood, tempo/bpm hint, language, vocal_type instrumental/male/female/duet, structure, references). |
| `prompt-spec.schema.json` | the internal compiled spec before send (mode, lyrics, style_prompt/tags, length_ms, output_format, reference_audio role(s), surface/model). |
| `project-state.schema.json` | the persisted track project (brief, lyrics drafts, style drafts, takes, current_track_id, optional album track list). |
| `take-review.schema.json` | post-generation triage (verdict accept / accept_with_notes / repair / reject, observed notes, requires_user_confirmation). |
| `generation-run.schema.json` | run-ledger row (run_id, surface, provider, model_id, mode, prompt_version, length_ms, reference_tags, result_status, audio_path, output_url, error). |

`generation-mode` enum: `text2music` (T2M) | `lyrics2song` (L2S — lyrics+style→sung
track) | `instrumental` (INST) | `audio2audio` (A2A — remix/restyle) | `extend`
(continue an existing audio). Keep it open enough that surfaces can advertise a
subset via capabilities.

`lib/music-schemas.ts` exports zod versions + `validateSongBrief()`,
`validateMusicPromptSpec()`, `validateMusicProjectState()`, `validateMusicGenerationRun()`.

---

## 4. Tool inventory (`tools/music/`)

### 4.1 `music-generate.ts` — the generative loop (most important)

A single `createTool` that runs the full lifecycle inside one call. Structure
follows `film-generate.ts` (approval gate, spend caps, `withToolEnvelope`, ledger,
safety, capability check), with one generalization: **transport is per-surface**.

**Provider/surface abstraction** (`config/music-surfaces.ts`):
```ts
export type MusicProvider = 'fal' | 'elevenlabs' | 'suno';
export type MusicSurfaceName = 'fal' | 'elevenlabs' | 'suno-gateway';
export type MusicResponseMode = 'async-poll' | 'sync-bytes';

export interface MusicSurfaceCapabilities {
  modes: MusicGenerationMode[];
  lengthMs: { min: number; max: number };
  outputFormats: string[];
  maxReferenceAudio: number;
  supportsVocals: boolean;
  supportsLyrics: boolean;
  languages: 'many' | string[];
}

export interface MusicSurfaceConfig {
  provider: MusicProvider;
  surface: MusicSurfaceName;
  modelId: string;            // env-overridable
  baseUrlEnv: string;
  apiKeyEnv: string;          // 'FAL_KEY' | 'ELEVENLABS_API_KEY' | 'SUNO_GATEWAY_KEY'
  defaultBaseUrl?: string;
  responseMode: MusicResponseMode;   // ★ fal = async-poll; elevenlabs = sync-bytes
  authHeader: 'fal-key' | 'xi-api-key' | 'bearer';
  // per-surface request-body builder + response-url/byte extractor (functions)
  buildBody(spec): Record<string, unknown>;
  // for sync-bytes: response IS the audio; for async-poll: extract task id + result url
}
```

Three surfaces:
```ts
fal: {           // DEFAULT v1. async-poll. Reuses film-generate's fal flow verbatim.
  provider:'fal', surface:'fal', responseMode:'async-poll', authHeader:'fal-key',
  apiKeyEnv:'FAL_KEY', baseUrlEnv:'FAL_BASE_URL', defaultBaseUrl:'https://queue.fal.run',
  modelId: process.env.MUSIC_FAL_MODEL_ID || 'fal-ai/minimax-music/v2',
  capabilities:{ modes:['text2music','lyrics2song','instrumental','audio2audio'],
    lengthMs:{min:10000,max:300000}, outputFormats:['mp3','wav'], maxReferenceAudio:1,
    supportsVocals:true, supportsLyrics:true, languages:'many' },
}
elevenlabs: {    // SYNC. POST /v1/music, header xi-api-key, body {prompt|composition_plan,
                 // music_length_ms (3000..600000), output_format}; response = audio BYTES.
  provider:'elevenlabs', surface:'elevenlabs', responseMode:'sync-bytes', authHeader:'xi-api-key',
  apiKeyEnv:'ELEVENLABS_API_KEY', baseUrlEnv:'ELEVENLABS_BASE_URL', defaultBaseUrl:'https://api.elevenlabs.io',
  modelId: process.env.MUSIC_ELEVEN_MODEL_ID || 'music_v2',
  capabilities:{ modes:['text2music','lyrics2song','instrumental'],
    lengthMs:{min:3000,max:600000}, outputFormats:['mp3_44100_128','wav'], maxReferenceAudio:0,
    supportsVocals:true, supportsLyrics:true, languages:'many' },
}
'suno-gateway': {  // CONFIG-ONLY SEAM (deferred impl). Third-party gateway, NOT scraper.
  provider:'suno', surface:'suno-gateway', responseMode:'async-poll', authHeader:'bearer',
  apiKeyEnv:'SUNO_GATEWAY_KEY', baseUrlEnv:'SUNO_GATEWAY_URL',
  modelId: process.env.MUSIC_SUNO_MODEL_ID || 'chirp-v5',
  capabilities:{ /* … */ },
}
```

**Input (zod, from prompt-spec):**
`{ projectId, trackId, mode (default 'lyrics2song'), prompt (style), lyrics?,
lengthMs?, outputFormat?, referenceAudio?: {role,url|path}[], provider?, surface?,
workspaceDir?, approvalToken?, callerAgentId?, taskId? }`

**Execute phases (inside the tool; agent does NOT step polling):**
1. **Pre-send gate** — `music_lint_prompt` (style + lyrics + spec shape); abort on fail.
2. **Safety gate** — `music_check_safety` (artist mimicry / voice consent / IP); abort on fail.
3. **Capability check** — `validateMusicSurfaceRequest()` (mode, lengthMs, format,
   reference count vs surface caps).
4. **Spend cap + approval** — same fail-closed logic as film-generate.
5. **Dispatch by `responseMode`:**
   - `async-poll` (fal / suno-gateway): POST create → capture `request_id` →
     poll status → fetch result → get audio URL. (Reuse film-generate's
     `runFalGeneration` shape.)
   - `sync-bytes` (elevenlabs): single `POST /v1/music` with `xi-api-key`; the
     **response body IS the audio bytes** → write straight to disk (no poll, no URL).
6. **retrieve/download** — write audio into `workspaceDir`
   (`MUSIC_OUTPUT_DIR` default `music-work/<projectId>`); guard paths under cwd/tmp.
7. **ledger** — append a `generation-run` row.

**Output (zod):** `{ ok, audioPath, taskId?, runId, provider, surface, modelId,
lengthMs?, mode, moderation?, costEstimate?, terminal?, error?, approvalRequest?, approvalToken? }`.

> Suno-gateway branch: keep `provider:'suno'` typed but throw a clear
> "suno-gateway provider not implemented in musician v1" until the user opts in
> (mirrors filmmaker's deferred `veo` branch). When enabled, it is a third-party
> REST gateway only — NEVER cookie/Playwright/captcha scraping (Suno ToS).

### 4.2 `music-validators.ts` (TS-only is acceptable)

Filmmaker wraps Python validators because the seedance repo ships them. The Suno
prompt repos do NOT ship deterministic validators, so implement these **in TS**
(zod + regex rules) — no Python dependency for music:

| Tool id | Purpose |
|---|---|
| `music_lint_prompt` | validate compiled style prompt + lyrics + spec (no placeholders; length within surface caps; structure tags well-formed for `lyrics2song`). |
| `music_check_safety` | copyright/likeness/voice gate (named-artist mimicry, exact-voice clone w/o consent, plagiarized lyrics, disallowed content). Returns `{ ok, errors[], warnings[] }`. |
| `music_check_generation_run` | ledger row vs `generation-run` schema. |

Each returns `{ ok, errors[], warnings[] }`. TS check must pass.

### 4.3 `music-project-tools.ts` — track project store (SIMPLIFIED chef pattern)

Persistent store (same Mongo approach as film-service) keyed by `project_id`,
holding brief + lyric/style drafts + takes + run pointers. **No clip-lineage /
continuity-lock / canon-revision machinery.**

| Tool id | Purpose |
|---|---|
| `music_start_project` | create a project (objective, genre, mood, language, vocal_type, structure, default surface). |
| `music_get_project` / `music_list_projects` | read state. |
| `music_set_project_status` | **the reflector status tool** (see §5). |
| `music_set_brief` | set/refine the song brief (genre, bpm, mood, language, vocal_type, structure). |
| `music_write_lyrics` | store a lyrics draft (versioned) for a track. |
| `music_compile_prompt_spec` | assemble a validated `prompt-spec` from brief + lyrics + style + reference map (lint via `music_lint_prompt`). |
| `music_record_take` | write a take-review (verdict + notes); on `accept` mark the track done. |
| `music_upsert_track` | (album mode, optional) add a track to the project so tracks can fan out in parallel. |

Invariants (lighter than film): a rejected take cannot be marked the deliverable;
the accepted take's `audio_path` is the canonical output; lyrics/style versions
are immutable once a take referencing them is accepted (audit trail).

### 4.4 Reused / delegated (no new code)
- **Source/fact gate** → `delegateTask({ targetAgent:'researcherAgent' })` to
  verify current music-model IDs / pricing / region before asserting platform facts.
- **Reference/skill loading** → `skill_search`/`skill_load` (frontmatter-indexed
  `_skills/music/*`) OR dedicated `music_*_reference` loaders. Must be in `tools`.
- **Spoken intro/outro TTS, stems** → DEFER (v2): reuse `design_tts` + ffmpeg.

---

## 5. Reflector & phases (`config/pipeline-phase-tools.ts`)

Add a `musicianAgent` entry. `statusTool: 'music_set_project_status'`. Because
`delegate-task.ts` routes any `isPipelineAgent(targetAgent)` through
`generatePipelineWithReflection`, this entry is what enables in-flight reflection
+ per-phase tool channeling — no other wiring needed.

`MUSIC_PIPELINE_STATUSES` (export from `music-service.ts`, asserted by the check):
```
intake → brief → source_gate → lyric_write → style_compile → safety_gate →
generate → review → repair → deliver → done
```

```ts
musicianAgent: {
  statusTool: 'music_set_project_status',
  alwaysAvailable: [
    ...SHARED_ALWAYS,
    'music_set_project_status', 'music_get_project', 'music_list_projects',
    'music_check_safety',
  ],
  phases: {
    intake:        ['music_start_project'],
    brief:         ['music_set_brief'],
    source_gate:   ['system_delegate_task'],                                      // researcher verifies model IDs/pricing
    lyric_write:   ['music_write_lyrics', 'system_run_worker'],                   // lyrics (+ A/B variants)
    style_compile: ['music_compile_prompt_spec', 'music_lint_prompt', 'system_run_worker'],
    safety_gate:   ['music_check_safety'],
    generate:      ['music_generate', 'music_check_generation_run', 'system_request_approval'],
    review:        ['music_record_take'],
    repair:        ['music_compile_prompt_spec', 'music_lint_prompt', 'music_generate', 'system_run_worker'],
    deliver:       ['music_get_project', 'music_list_generation_runs'],
    done:          [],
  },
},
```

Checkpoints with `[]` still return `alwaysAvailable` (fail-open). Remember the
**id→key translation** boundary (snake `id`s here; reflector maps to camelCase
tool keys via `buildToolIdToKeyMap`).

---

## 6. Agent file (`agents/musician-agent.ts`)

Copy `agents/film-agent.ts` structure; change tool imports, model key, prompts.

```ts
export const musicianAgent = new Agent({
  id: 'musician-agent',
  name: 'Musician Agent',
  instructions: await combinePrompts('music/domain', 'music/pipeline'),
  model: resolveModelId(agentModels.musicianAgent),
  defaultOptions: { maxSteps: 150 },
  defaultGenerateOptionsLegacy: { maxSteps: 150 },
  defaultStreamOptionsLegacy: { maxSteps: 150 },
  defaultNetworkOptions: { maxSteps: 150 },
  memory: new Memory({ options: { lastMessages: 20,
    observationalMemory: { model: resolveModelId(infrastructure.observationalMemory),
      scope: 'thread', temporalMarkers: true,
      observation: { threadTitle: true, providerOptions: { google: { thinkingConfig: { thinkingBudget: 1024 } } } } },
    generateTitle: true } }),
  inputProcessors: [ createTokenLimiter(120_000) ],
  tools: {
    // project store + state machine
    musicStartProjectTool, musicGetProjectTool, musicListProjectsTool, musicSetProjectStatusTool,
    musicSetBriefTool, musicWriteLyricsTool, musicCompilePromptSpecTool, musicRecordTakeTool,
    // (album mode) musicUpsertTrackTool,
    // validators
    musicLintPromptTool, musicCheckSafetyTool, musicCheckGenerationRunTool,
    // generative loop + ledger
    musicGenerateTool, musicListGenerationRunsTool,
    // reference/skill loading
    skillSearchTool, skillLoadTool,   // or music_*_reference loaders
    // system / memory
    runWorkerTool, delegateTaskTool, requestApprovalTool, currentTimeTool,
    memoryRecallTool, memoryWriteTool, addContextTool,
  },
});
```

> If the musician should accept user-supplied **reference audio attachments** in
> chat (audio2audio / extend), reuse the filmmaker §16 pattern: add
> `attachmentPersistProcessor` to `inputProcessors` (it already allowlists media
> types; extend it to `audio/*`). Otherwise users pass a path/url in text. Treat
> this as an optional post-v1 add-on, exactly like filmmaker §16.

---

## 7. Prompts (`prompts/music/`)

- `domain.md` — the music brain: operating loop, lyric-writing craft, style-prompt
  grammar per surface family, structure conventions (verse/chorus/bridge/hook),
  Polish-vocal guidance (§15), copyright/safety doctrine. Seed from the ported
  `claude-ai-music-skills` / `suno-band-manager` knowledge, adapted to
  MiniMax/ElevenLabs grammar (NOT Suno-only tags).
- `pipeline.md` — Mastra adapter (mirror `prompts/film/pipeline.md`):
  - **Path mapping**: `[ref:x]`/`[skill:y]` → `_skills/music/…`.
  - **Source gate**: delegate model-ID/pricing/region facts to `researcherAgent`;
    never assert platform facts from memory.
  - **Generation contract**: prefer `music_generate` (it lints, safety-checks,
    dispatches sync/async, downloads, ledgers). Gate first paid run via approval.
  - **Parallelism**: lyric/style variants + (album) per-track drafts via
    `run_worker(preset:'music')` ×N with anti-convergence anchors. Album tracks
    MAY fan out in parallel (independent); within one track, only A/B variants.
  - **Delivery defaults**: return audio path(s) + lyrics + style + ledger summary
    + any moderation/licensing caveats with source dates.

### 7.1 Meta routing prompts (do not skip)

Update BOTH routing surfaces (filmmaker §7.1 lesson — designer drifted by only
doing one):

1. `tools/system/delegate-task.ts` — what `targetAgent` values exist + what the
   musician does.
2. `prompts/meta/base.md` + `prompts/meta/intent-router.md` — when meta should
   choose the musician.

Routing phrases (PL + EN): "zrób piosenkę", "skomponuj utwór", "napisz tekst i
muzykę", "wygeneruj muzykę/beat/podkład", "ścieżka dźwiękowa", "jingiel";
"make a song", "compose a track", "generate music", "write lyrics and music",
"instrumental/beat". `intent-router.md`: classify concrete music-generation tasks
as `tool_request` / `workflow_orchestration`, not `general_chat`.

---

## 8. Registration & exposure — including META delegation (user requirement)

Mirror filmmaker §8:

1. **`index.ts`** — register `new Mastra({ agents: { …, musicianAgent } })`.
2. **`config/agent-ids.ts`** — add `MUSICIAN_AGENT_ID='musicianAgent'`,
   `MUSICIAN_AGENT_MASTRA_AGENT_ID='musician-agent'`, `MUSICIAN_AGENT_ALIASES`;
   add both to `canonicalizeRuntimeAgentId` + `agentIdAliases`; add
   `MUSICIAN_AGENT_ID` to `DELEGATION_CALLER_AGENT_IDS` + `DELEGATION_RETURN_AGENT_IDS`
   (it delegates to researcher).
3. **`tools/system/delegate-task.ts`** — add `musicianAgent: 'musicianAgent'` to
   `AGENT_IDS`; add `'musicianAgent'` to the `targetAgent` z.enum; add a domain
   line to the tool `description`; add the recursive self-delegation guard
   (`callerAgentId === MUSICIAN_AGENT_ID && targetAgent === 'musicianAgent'` → blocked);
   add `case 'musicianAgent':` to `buildDelegationSuccessCriteria` (e.g. "names the
   generated audio path(s) or explains why generation was skipped; platform facts
   are researcher-verified; prompt passed lint + safety before send"). **No new
   `execute` branch** — `isPipelineAgent(...)` auto-routes once it's in
   `PIPELINE_PHASE_TOOLS`. ✅
4. **`config/model-capabilities.ts`** — only if switching the fallback chain to
   models not already registered (e.g. `claude-opus-4.8` for production).
5. **`prompts/meta/base.md`** — add `musicianAgent` to the expert-agent table + a
   hard routing rule for music/song/lyrics tasks.
6. **`prompts/meta/intent-router.md`** — classify music-generation requests; PL+EN terms.
7. **Static check** — `check:musician-domain` asserts all of the above.

---

## 9. Environment prerequisites (host)

Add to `.env.example` in the implementation phase:
```dotenv
# ── Musician Agent / music-generation surfaces ─────────────────────────────────
MUSIC_SKILLS_ROOT=
MUSIC_OUTPUT_DIR=music-work
MUSIC_REQUIRE_APPROVAL=true
MUSIC_SURFACE=fal                              # fal | elevenlabs | suno-gateway
MUSIC_MAX_PAID_GENERATIONS_PER_TRACK=3
MUSIC_MAX_PAID_GENERATIONS_PER_PROJECT=12
MUSIC_POLL_INTERVAL_MS=5000
MUSIC_POLL_TIMEOUT_MS=600000
# fal (DEFAULT) — already have FAL_KEY
MUSIC_FAL_MODEL_ID=fal-ai/minimax-music/v2     # or fal-ai/ace-step/..., fal-ai/stable-audio-25/...
FAL_BASE_URL=https://queue.fal.run
FAL_KEY=
# ElevenLabs Music (sync) — already have ELEVENLABS_API_KEY
MUSIC_ELEVEN_MODEL_ID=music_v2
ELEVENLABS_BASE_URL=https://api.elevenlabs.io
ELEVENLABS_API_KEY=
# Suno gateway (config-only seam, deferred; third-party gateway, NOT scraping)
MUSIC_SUNO_MODEL_ID=chirp-v5
SUNO_GATEWAY_URL=
SUNO_GATEWAY_KEY=
```
- **Reused keys** already present: `FAL_KEY`, `ELEVENLABS_API_KEY`, `TAVILY` (researcher).
- **No Python** required (validators are TS). **No ffmpeg** for v1 (surface
  returns a finished mixed track; stems/voiceover-mux is the deferred v2 path).
- **Filesystem**: writable workspace dir for downloaded audio.

---

## 10. Phased implementation plan

- [ ] **P0 · Skill knowledge port** — copy `claude-ai-music-skills`/`suno-band-manager`
  style+lyric reference knowledge → `_skills/music/*` with frontmatter (so
  `SkillRegistry` indexes it). Mark Suno-specific tag grammar as one surface
  family; note adapters for MiniMax/ElevenLabs.
- [ ] **P1 · Skeleton** — `prompts/music/{domain,pipeline}.md`; decide + implement
  the reference-loading mechanism (frontmatter `skill_search`/`skill_load` OR
  `music_*_reference` loaders).
- [ ] **P2 · Schemas** — `config/music-schemas/*` + `lib/music-schemas.ts` (zod
  mirrors + validators). `tsc` passes.
- [ ] **P3 · Manifest** — `agentModels.musicianAgent`, `workerPresets.music`,
  `agentFallbackChains.musicianAgent`, `musicianAssignments`, + `run-worker.ts`
  enum/role for `preset:'music'`. `npm run build` passes.
- [ ] **P4 · Validators (TS)** — `music-validators.ts` (`music_lint_prompt`,
  `music_check_safety`, `music_check_generation_run`). Unit-smoke each.
- [ ] **P5 · Project store + state machine** — `music-service.ts` (simplified) +
  `music-project-tools.ts` + `music-ledger.ts` + `MUSIC_PIPELINE_STATUSES`.
- [ ] **P6 · Generative loop** — `config/music-surfaces.ts` (fal default +
  elevenlabs + suno-gateway seam) + `music-generate.ts` with **both transports**
  (async-poll fal, sync-bytes elevenlabs), `withToolEnvelope`, approval gate,
  spend caps, pre-send safety, capability validation. Suno-gateway branch throws
  "not implemented".
- [ ] **P7 · Agent** — `agents/musician-agent.ts` (chef pattern) + register in `index.ts`.
- [ ] **P8 · Reflector + exposure** — `pipeline-phase-tools.ts` music phases;
  `agent-ids.ts`; `delegate-task.ts` (enum + AGENT_IDS + description + recursive
  guard + success criteria); `prompts/meta/base.md`; `prompts/meta/intent-router.md`.
  Verify meta→musician routes through the reflector.
- [ ] **P9 · Parallelism** — wire lyric/style-variant + (album) per-track workers
  (`run_worker(preset:'music')`) via `pipeline.md`.
- [ ] **P10 · Static domain check** — `src/mastra/scripts/check-musician-domain.ts`
  + `npm run check:musician-domain`, modeled on `check:filmmaker-domain` (manifest,
  run-worker enum, agent registration, delegate routing, meta prompts, env example,
  phase map, prompt/schema/reference files, loader availability, BOTH surface
  transports present).
- [ ] **P11 · E2E validation** — real-model/API queue (see §11).

### Non-model verification gates (per phase)
- `npx tsc --noEmit` after each code phase; `npm run build` after manifest +
  registration; `npm run check:musician-domain` after P8/P10.

### Final real-model / real-API test queue (defer to end)
- [ ] Prompt/path smoke: agent loads `domain.md`+`pipeline.md`, resolves one
  `[ref:]` from `_skills/music`, compiles a tiny `lyrics2song` spec, passes lint.
- [ ] Worker preset smoke: `run_worker({preset:'music'})` resolves the configured model.
- [ ] Source gate: a prompt mentioning a current model ID/pricing delegates to
  researcher before asserting, records source URLs/dates.
- [ ] **Generation (fal, async-poll)**: `music_generate` creates→polls→downloads a
  real audio file + valid ledger row; approval gate fires on first run.
- [ ] **Generation (elevenlabs, sync-bytes)**: `MUSIC_SURFACE=elevenlabs`,
  `POST /v1/music` returns bytes → written to disk directly (no poll); ledger row valid.
- [ ] Safety gate: "in the style of [living artist]" / exact-voice-clone prompt is
  blocked pre-send.
- [ ] Spend cap: repair loop stops at `MUSIC_MAX_PAID_GENERATIONS_PER_TRACK`.
- [ ] Meta delegation: `system_delegate_task({targetAgent:'musicianAgent', …})`
  routes through `generatePipelineWithReflection` with phase channeling.
- [ ] (album, optional) two independent tracks fan out via parallel workers.

---

## 11. Acceptance criteria

1. One-sentence idea → lint-passing lyrics + style prompt + spec JSON.
2. `music_generate` produces a downloaded audio file from a real surface + a valid
   ledger row — on BOTH a fal (async-poll) and an ElevenLabs (sync-bytes) surface.
3. The model/surface is **swappable by env only** (`MUSIC_SURFACE` /
   `MUSIC_FAL_MODEL_ID`) with no code change.
4. First paid generation in a project is approval-gated; spend caps stop runaway loops.
5. Copyright/voice safety gate blocks named-artist mimicry / non-consensual voice clone.
6. Platform-fact prompts trigger a `researcherAgent` source-gate before asserting.
7. Meta-agent can DELEGATE a music task (not only direct chat) through the reflector.
8. Suno is reachable ONLY as an opt-in `suno-gateway` surface; no scraping path exists.

---

## 12. Resolved decisions

- **Don't anchor on Suno** — RESOLVED: default fal (MiniMax) + ElevenLabs second
  seam; Suno is a config-only, env-swappable `suno-gateway` (deferred impl, NEVER
  scraper). Rationale: Suno = quality leader but no official API in 2026.
- **Env-swappable models** — RESOLVED: surface/model config (`config/music-surfaces.ts`
  + `MUSIC_*` env), mirroring `film-surfaces.ts`. User tunes the sweet spot by testing.
- **Transport** — RESOLVED: `music-generate.ts` supports `async-poll` (fal) AND
  `sync-bytes` (ElevenLabs `POST /v1/music` returns audio directly). This is the
  one real engineering difference from `film-generate.ts`.
- **Validators in TS** — RESOLVED: no Python (Suno repos ship none); zod+regex.
- **State weight** — RESOLVED: lighter than film (no clip-lineage/continuity/canon);
  project = brief + lyrics + style + takes + runs.
- **Album/multi-track** — RESOLVED: optional `music_upsert_track` + parallel
  per-track fan-out; not required for v1.
- **MCP / stems / spoken voiceover** — DEFERRED (v2/v3).

---

## 13. What is a "surface"? (and why fal default + ElevenLabs)

Each surface is a vendor endpoint that turns the compiled lyrics+style into a
finished track. The musician compiles the same brief regardless; only the HTTP
call (and transport) differs per surface.

| Surface | What it is | Transport | Pros | Cons |
|---|---|---|---|---|
| **fal** (DEFAULT) | aggregator → MiniMax Music / ACE-Step / Stable Audio | async-poll | one `FAL_KEY` (already have), reuses film-generate flow, commercial use, cheap, 600+ swappable models | aggregator pricing |
| **ElevenLabs Music** | official `POST /v1/music` | **sync-bytes** | official, **cleanest commercial license** (licensed training data), best Polish/multilingual vocals, `ELEVENLABS_API_KEY` already wired | per-min pricing; vocal taste ≠ Suno's |
| **Suno gateway** | third-party gateway exposing Suno v5 | async-poll | top quality (Suno = ELO leader) | unofficial gateway dependency, licensing complexity; **only if Suno's sound is a hard requirement** |

**v1 default: fal (MiniMax Music 2.x).** ElevenLabs is a one-env-flip alternative
for licensing-sensitive / Polish-vocal work. Switching is a config + the matching
`buildBody`/extractor, not a rewrite.

---

## 14. Does the musician have helpers, or work alone?

Same model as chef/filmmaker: orchestrator + 1 standing helper + on-demand workers.
1. **`researcherAgent`** — the source gate. Music-model facts (current model IDs,
   pricing, region, licensing terms) decay; the musician delegates verification
   instead of asserting from memory.
2. **Ephemeral `run_worker(preset:'music')`** — parallel LLM calls for A/B lyric/
   style variants, multilingual lyric variants, and (album mode) independent
   per-track drafts. Unlike film clips, **album tracks may fan out in parallel**.

Everything else it does itself or via its own tools (write lyrics, compile style,
lint, safety, call `music_generate`, ledger, take review).

---

## 15. Lyrics / voice / language (Polish)

- The surface generates **vocals + music together** — no separate TTS for the song.
- **Polish vocals:** ElevenLabs Music supports many languages with strong
  multilingual vocal quality → for PL-language songs, `MUSIC_SURFACE=elevenlabs`
  is the recommended surface; MiniMax (fal) also supports many languages. Suno's
  PL is strong but API-locked. The musician should pick/recommend the surface by
  language requirement (encode this in `pipeline.md`).
- **Spoken intro/outro / lektor (DEFERRED v2):** if a track needs a spoken Polish
  voiceover layered on instrumental, that is post-production — reuse `design_tts`
  (ElevenLabs TTS) + an ffmpeg mux step. No new manifest provider; not a v1 dependency.

---

## 16. Borrowed skill knowledge (Suno prompt repos → `_skills/music`)

`claude-ai-music-skills` (`suno-engineer`) and `suno-band-manager` (style/lyric/
band-profile builders) are **prompt + lyric craft knowledge**, MIT-friendly, and
port as `_skills/music/*` reference knowledge — NOT as infra (project convention:
borrow prompts/skills, not infra). Their "Suno V5 prompt grammar" maps to one
surface family; add a thin style-adapter note for MiniMax/ACE-Step/ElevenLabs
grammar (same idea as the filmmaker's Veo prompt-adapter seam). Do **not** import
any browser-automation / cookie-scraper code from the Suno repos surveyed
(`suno-song-creator-plugin` `/suno-upload`, `gcui-art/suno-api`) — that violates
Suno ToS and is explicitly out of scope.
```
