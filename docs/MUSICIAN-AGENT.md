# Musician Agent

> Status: v1 generation domain implemented. Agent, prompt contracts, Zod schemas,
> env-swappable surfaces (fal + ElevenLabs + Suno seam), Mongo project/track/run
> state, TypeScript validators, approval-gated `music_generate` (sync + async
> transports), generation ledger, meta/delegation routing, pipeline phase
> allowlists, model-manifest entries, static domain check, and a **dashboard-ui
> Musician workspace card with an audio player** are in place.
> **Pending:** the `_skills/music/*` reference corpus + `music_*_reference` loaders
> (port of `claude-ai-music-skills`) — see [`../ideas/musician-skills-port.md`](../ideas/musician-skills-port.md).
> Date: 2026-06-23

`musicianAgent` is the music / song / audio generation domain. It follows the
chef/filmmaker pipeline pattern but with **lighter state**: a music track is
essentially ONE generation, so there is no clip-lineage / continuity / canon
machinery. A project is a brief + lyrics + style prompt + takes + a remote
generation run-ledger. Unlike film clips, album tracks **can** fan out in parallel.

The text LLM brain (`agentModels.musicianAgent = deepseek-v4-pro`) writes lyrics,
style prompts, and orchestrates gates. The **actual music generator** is a remote
surface (fal / ElevenLabs / Suno-gateway), selected and model-swapped entirely via
environment — never in the model manifest.

## Runtime Pieces

| File | Purpose |
|---|---|
| `src/mastra/agents/musician-agent.ts` | Mastra `musicianAgent` definition (id `musician-agent`) |
| `src/mastra/prompts/music/domain.md` | Operating prompt for songwriting / style / generation |
| `src/mastra/prompts/music/pipeline.md` | Mastra adapter: phases, tools, routing, approval gates |
| `src/mastra/lib/music-schemas.ts` | Zod schemas (prompt-spec, generation-run) + helpers |
| `src/mastra/config/music-surfaces.ts` | fal / ElevenLabs / suno-gateway capabilities + env config + `responseMode` |
| `src/mastra/tools/music/music-service.ts` | Mongo-backed project / track / take / run state service |
| `src/mastra/tools/music/music-project-tools.ts` | Project, track, brief, lyrics, prompt-spec, take-review tools |
| `src/mastra/tools/music/music-validators.ts` | Pure-TS lint / safety / generation-run validators (no Python) |
| `src/mastra/tools/music/music-generate.ts` | Approval-gated remote generation (sync-bytes + async-poll), audio download |
| `src/mastra/tools/music/music-ledger.ts` | Generation-run ledger tools |
| `src/mastra/services/workspace-service.ts` | Music workspace funcs: list / bundle / audio-path / asset-root guards |
| `src/mastra/scripts/check-musician-domain.ts` | Static drift check for registration, routing, phases, surfaces, gates |
| _(pending)_ `src/mastra/tools/music/music-reference-tools.ts` | Read-only loaders for the ported `_skills/music/*` corpus |
| _(pending)_ `src/mastra/_skills/music/*` | Ported lyric/style/genre knowledge (CC0) |

## Collections

| Collection | Role |
|---|---|
| `music_projects` | Project state, status, tracks, brief, lyrics, style, take history |
| `music_generation_runs` | Remote generation attempts, result state, audio path/URL, errors |
| `approvals` | Existing system approval records consumed by first paid generation |

## Pipeline

Registered phases (`MUSIC_PIPELINE_STATUSES`):

```text
intake -> brief -> source_gate -> lyric_write -> style_compile -> safety_gate
-> generate -> review -> repair -> deliver -> done
```

`PIPELINE_PHASE_TOOLS.musicianAgent` channels tools per phase. `music_generate`
is only available in the `generate` phase; state/status/read tools stay available
across phases.

## Surfaces (env-swappable)

| Surface | `responseMode` | Default model (`env`) | Notes |
|---|---|---|---|
| `fal` (default) | `async-poll` | `MUSIC_FAL_MODEL_ID` = `fal-ai/ace-step` | submit → poll → download; reuses `FAL_KEY` / `FAL_BASE_URL`. Text/lyrics-to-audio via ACE-Step (`tags` + optional `lyrics`). |
| `fal-ace-step` | `async-poll` | `MUSIC_FAL_ACE_STEP_MODEL_ID` = `fal-ai/ace-step` | Explicit ACE-Step surface for lyrics/text generation. |
| `fal-stable-audio` | `async-poll` | `MUSIC_FAL_STABLE_AUDIO_MODEL_ID` = `fal-ai/stable-audio` | Prompt-to-audio/instrumental surface (`prompt` + `seconds_total`), no supplied lyrics. |
| `fal-minimax-reference` | `async-poll` | `MUSIC_FAL_MINIMAX_MODEL_ID` = `fal-ai/minimax-music` | MiniMax reference-audio surface. Requires `reference_audio_url`; do not use for text-only generation. |
| `elevenlabs` | `sync-bytes` | `MUSIC_ELEVENLABS_MODEL_ID` = `music_v1` | `POST /v1/music` returns audio bytes directly (no poll). `xi-api-key`. **No reference audio.** Honors `music_length_ms` (3k–600k). |
| `suno-gateway` | `async-poll` | `MUSIC_SUNO_MODEL_ID` = `suno-v5` | **Disabled** unless `SUNO_GATEWAY_BASE_URL` is set. ToS-compliant gateway seam ONLY — never a scraper. |

Surface choice: `MUSIC_SURFACE` env (or per-call `surface`/`provider`). Each model
is swapped via its `MUSIC_*_MODEL_ID` env — no code change.

## Generation Contract

`music_generate` uses `withToolEnvelope` (risk: medium) and is **fail-closed** in
order:

1. **spend caps** — `MUSIC_MAX_PAID_GENERATIONS_PER_TRACK` / `_PER_PROJECT`
   (code-enforced; returns terminal `paid_generation_cap_reached`);
2. **lint** — `music_lint_prompt` (style present/not-JSON, lyrics vs mode, length, reference for audio2audio/extend);
3. **safety** — `music_check_safety` (terminal on prohibited content; warns on artist impersonation);
4. **capability** — surface limits (length, reference count, vocal/instrumental);
5. **provider payload** — catches ElevenLabs 4100-char prompt limit and fal model schema mismatches before remote spend;
6. **approval gate** — every paid run requires `system_request_approval`; the token is scoped to the exact project/track/surface/mode/provider/model and otherwise returns terminal `approval_scope_mismatch`;
7. **API key presence**;
8. **generation** (transport per `responseMode`).

Generated/downloaded audio is written under:

```text
MUSIC_OUTPUT_DIR || music-work/<projectId>      (file: <runId>.<ext>)
```

The ledger row's `audio_path` points at the actual downloaded file.

## Tools

| Group | Tools |
|---|---|
| Project state | `music_start_project`, `music_get_project`, `music_list_projects`, `music_set_brief`, `music_set_project_status`, `music_upsert_track`, `music_record_take` |
| Authoring | `music_write_lyrics`, `music_compile_prompt_spec` |
| Validation | `music_lint_prompt`, `music_check_safety`, `music_check_generation_run` |
| Generation | `music_generate` |
| Ledger | `music_append_generation_run`, `music_list_generation_runs` |

Plus standard `system_*` / `memory_*` tools, `run_worker` (preset `music`),
`system_delegate_task`, `system_request_approval`.

## Workspace UI (dashboard-ui)

The operational dashboard (`dashboard/index.html`, served at
`/dashboard-ui`) has a **Musician** tab with project list + a view pane that plays
back generated tracks via an HTML5 `<audio controls preload="metadata">` player.

Backend routes (registered in `src/mastra/index.ts`):

| Route | Purpose |
|---|---|
| `GET /ws/musician/projects` | List music projects (cards: track/run counts, latest audio URL) |
| `GET /ws/musician/projects/:id` | Project bundle: project + tracks + generation runs |
| `GET /ws/musician/runs/:runId/audio` | Byte-range (HTTP 206) audio streaming; content-type by extension (wav/flac/ogg/pcm/mpeg) |
| `DELETE /ws/musician/projects/:id` | Delete a music project |

`services/workspace-service.ts` provides `listMusicProjects`,
`getMusicProjectBundle`, `getMusicRunAudioPath`, and path-safety guards
(`musicAssetRoots()` / `safeMusicAssetPath()`). Audio is served only from allowed
roots: `MUSIC_OUTPUT_DIR`, `src/mastra/public/music-work`, and `music-work` — so
files in the default output location play without being moved into `public/`.

## Environment

Important `.env` keys:

```text
MUSIC_OUTPUT_DIR=music-work
MUSIC_REQUIRE_APPROVAL=true
MUSIC_MAX_PAID_GENERATIONS_PER_TRACK=3
MUSIC_MAX_PAID_GENERATIONS_PER_PROJECT=12
MUSIC_SURFACE=fal
FAL_KEY=                      # reused from filmmaker
FAL_BASE_URL=https://queue.fal.run
MUSIC_FAL_MODEL_ID=fal-ai/ace-step
MUSIC_FAL_SUBMIT_PATH=
MUSIC_FAL_ACE_STEP_MODEL_ID=fal-ai/ace-step
MUSIC_FAL_ACE_STEP_SUBMIT_PATH=
MUSIC_FAL_STABLE_AUDIO_MODEL_ID=fal-ai/stable-audio
MUSIC_FAL_STABLE_AUDIO_SUBMIT_PATH=
MUSIC_FAL_MINIMAX_MODEL_ID=fal-ai/minimax-music
MUSIC_FAL_MINIMAX_SUBMIT_PATH=
MUSIC_FAL_STABLE_AUDIO_STEPS=100
ELEVENLABS_API_KEY=           # reused from design TTS
ELEVENLABS_BASE_URL=
MUSIC_ELEVENLABS_MODEL_ID=music_v1
MUSIC_ELEVENLABS_SUBMIT_PATH=
SUNO_GATEWAY_BASE_URL=        # leave empty to keep Suno seam disabled
SUNO_GATEWAY_API_KEY=
MUSIC_SUNO_MODEL_ID=suno-v5
MUSIC_SUNO_SUBMIT_PATH=
MUSIC_POLL_INTERVAL_MS=5000
MUSIC_POLL_TIMEOUT_MS=600000
```

Keys may stay empty until a run is intentionally approved; the static domain check
is network-free and needs none of them.

## Routing

Meta routes music / song / audio requests through both layers:

- `system_delegate_task` exposes `musicianAgent` and describes songwriting, lyric
  writing, style/genre prompts, sung/instrumental tracks, audio remix/extend,
  album/track planning, take review, and song repair.
- `prompts/meta/base.md` and `prompts/meta/intent-router.md` classify
  music/song/audio generation (incl. "wygeneruj piosenkę/utwór/muzykę/ścieżkę") as
  musician work — always one `system_delegate_task(musicianAgent)` call.

Filmmaker remains responsible for video; design for static visual artifacts.
`promo-director`-style 15s vertical promo videos route back to the filmmaker domain.

## Verification

```bash
npm run check:musician-domain
npm run build
git diff --check
```

`check:musician-domain` is intentionally network-free and does not call fal or
ElevenLabs.
