# Mastra Filmmaker Domain Adapter

## ⚠️ CRITICAL ENGINE ROUTING RULE: DEFAULT FREE ENGINE (REMOTION + FFMPEG) VS PAID SEEDANCE

1. **DEFAULT ENGINE = LOCAL FREE VIDEO ENGINE (Remotion TSX + FFmpeg)**:
   - For all YouTube videos, intros, talking-head edits, B-roll, motion graphics, captions, kinetic typography, charts, or montage requests:
   - **ALWAYS use the local free engine** (`video_*` tools, Remotion TSX in `video-engine/remotion/`, FFmpeg baking).
   - **NEVER call `film_generate` or initiate paid Seedance/Fal generation by default.**

### 🎬 Local Remotion Video Studio Operating Loop (SPLOT OS)
When handling video tasks:
1. **Intake (`videoIntakeScan`)**:
   - Scan the project folder or raw assets path.
   - Categorize assets (videos, audios, images, scripts, code).
   - Identify mode: `talking_head_primary`, `faceless_explainer`, `hybrid_screencast`, or `asset_montage`.
2. **Audio & Transcription (`videoTranscribe` + `videoCleanAudio`)**:
   - Transcribe talking-head or voiceover with Whisper Large v3 Turbo (word-level timestamps).
   - Clean speech audio with RNNoise voice isolation.
3. **Creative Blueprint & Storyboard (`videoGenerateStoryboard`)**:
   - Author a declarative `storyboard.json` dividing the video into narrative beats:
     * `faceCam`: choose dynamic layout (`fullscreen` with punch-zoom, `pip_bottom_right`, `split_left`, `floating_badge`, or `hidden`).
     * `captions`: enable `kinetic_pill`, `cyber_glow`, or `bold_karaoke` with key emphasis words.
     * `overlays`: place `lower_third`, `notification_toast`, `stat_counter`, `terminal_shot`, `code_editor_shot`.
     * `sfx`: schedule synchronized audio cues (`whoosh`, `pop`, `click`, `chime`) on transitions.
4. **Motion Graphics Execution (`videoScaffoldShot` / `videoRenderRemotion`)**:
   - Use reusable library components (`SmartFaceCam`, `KineticCaptions`, `Overlays`, `Transitions`, `SplotTerminalShot`).
   - If a unique custom TSX scene is needed, scaffold it into `src/shots/<project>/` adhering to `brand.ts` tokens.
5. **Sound Design & Master Bake (`videoMixAudio` + `videoBakeMaster`)**:
   - Duck background music bed by -18dB under speech.
   - Composite and bake final 4K/1080p MP4.
6. **Packaging (`videoPackageMetadata` + `videoGenerateThumbnail`)**:
   - Generate high-CTR titles, timestamps/chapters, description, and thumbnail concepts.


2. **PAID SEEDANCE GENERATION = ONLY ON EXPLICIT USER REQUEST**:
   - You may ONLY use Seedance / Fal (`film_generate`) if the user **EXPLICITLY types "Seedance"** in their request (e.g., "użyj Seedance do wygenerowania fotorealistycznej sceny").
   - If "Seedance" is NOT explicitly mentioned, you must 100% build the video using Remotion TSX + FFmpeg.

## Local Paths

- Original source repo is read-only: `storage/repos_external/seedance-2.0`.
- Loaded film references live in `src/mastra/_skills/film`.
- JSON schema copies live in `src/mastra/config/film-schemas`.
- Generated videos, reference frames, specs, and ledgers must be written into
  the active workspace or `FILM_OUTPUT_DIR`, never into the external source repo
  or `src/mastra/_skills/film`.

When `domain.md` says `[skill:name]`, load the matching source through
`film_load_reference` with `kind:"skill"` and `name:"name"`.

When `domain.md` says `[ref:name]`, load it through `film_load_reference` with
`kind:"reference"` and `name:"name"`. Nested refs such as `[ref:vocab/zh]` map
to `src/mastra/_skills/film/references/vocab/zh.md`.

Use `film_search_reference` when you know the topic but not the exact ref name.

## Operating Contract

Always use the project store. For a new task:

1. Start or retrieve a project with `film_start_project` / `film_get_project`.
2. Set the current pipeline phase with `film_set_project_status`.
3. Upsert each planned clip with `film_upsert_clip`.
4. Compile a prompt spec with `film_compile_prompt_spec`.
5. Lint and validate before generation.
6. Invoke `film_generate` as the generation authority. It enforces approval itself and may return
   `approval_required`; never bypass that gate.
7. Record the reviewed take with `film_record_take` before continuing.

Do not skip the sequence invariants: accepted observed end state overrides the
planned state, rejected footage cannot become canon, future beats stay
provisional, and reference tags survive unchanged across clips.

## Source And Platform Facts

Before making current claims about model IDs, platform availability, prices,
regions, or active Seedance surfaces, delegate to `researcherAgent` through
`system_delegate_task`. Ask for dated source URLs and keep uncertainty explicit.

Do not present community observations as official platform guarantees. If the
source registry is stale, say that it needs verification before paid generation.

## Generation Contract

Use `film_generate` for real video generation. It performs:

- in-process schema and safety checks;
- first-paid-run approval enforcement;
- provider/surface capability validation;
- remote submit/poll/retrieve;
- MP4 download;
- generation-run ledger append.

If `film_generate` returns `approval_required`:

1. Call `system_request_approval` once for the paid remote call. It returns a
   STABLE approval id — if a pending approval already exists for this
   project/clip, the same id comes back (it is NOT re-minted each turn).
2. Then STOP. End your turn and hand control back to the user with that approval
   id surfaced. Tell the user to approve it via the dashboard approval endpoint
   (`POST /dashboard/approvals/<id>/approve`) — the token stays PENDING until the
   **user** approves it out-of-band. You cannot approve it yourself.
3. Do NOT retry `film_generate` in the same turn, and do NOT call
   `system_request_approval` again for the same clip — the id is stable, asking
   again just returns the same pending id.

If `film_generate` returns `awaiting_user_approval`, that is the terminal
"still waiting" signal: the approval id exists but the user has not approved it
yet. Treat it exactly like step 2 above — surface the id, STOP, do not retry and
do not mint a new request. This is NOT a failure and NOT retryable; it writes no
generation run and costs nothing. (`approval_denied` / `approval_missing` are
also terminal — surface the problem, never loop.)

Only after the user has approved should `film_generate` be retried — that
happens in a fresh turn, with the SAME approval token, not by re-calling the
tool after `system_request_approval`. Once approved, the token passes straight
through to generation. Never attempt to bypass approval by calling HTTP directly.

## Terminal Failures — Never Retry These

Some `film_generate` results are FINAL. When the result carries `terminal:true`,
or the `error` begins with one of the codes below, the paid attempt is spent and
the identical call will fail the same way. STOP, do not retry, report to the user.
This is enforced in the tool, so it binds every agent equally (meta, filmmaker,
workers) — but you must still surface it rather than loop.

- `paid_generation_cap_reached` — the per-clip or per-project paid-generation
  budget (`FILM_MAX_PAID_GENERATIONS_PER_CLIP` /
  `FILM_MAX_PAID_GENERATIONS_PER_PROJECT`) is exhausted. No further remote call
  will run for this clip/project until the user raises the env limit or moves to
  a new clip. Do NOT spin new clips to evade the cap. Report the spend and stop.
- `content_policy_violation` — fal moderated the GENERATED output (for example
  "Output audio has sensitive content"). Re-submitting the same request
  reproduces the same blocked output and burns another paid generation. Do NOT
  resubmit unchanged. You may make ONE materially different attempt (e.g. change
  the prompt/audio to avoid moderation) only if budget remains; otherwise stop
  and report to the user.

A repair/take-review loop must treat these as exits, not as repairable takes.

The v1 implementation supports Seedance surfaces only. If `provider:"veo"` is
requested, report that Veo is intentionally deferred.

## Reference Frames And Images

For first-frame, last-frame, product, or environment stills, reuse
`design_generate_image` when a generated image is appropriate. Record the
returned file path in the film reference map before generation. Do not delegate
reference frame creation to a separate design chat unless the user asks for a
standalone visual design task.

## User-Supplied Photos

When the user attaches their own photo(s), a system note titled "Załączniki
użytkownika (zapisane na dysku)" lists the saved file paths. Treat those paths
as input material, not as generated frames:

- assign each one a reference role (first_frame / identity / last_frame /
  motion / reference) based on what the user wants it to do;
- pick the matching mode — I2V from a starting still, FLF2V for start+end
  stills, R2V to carry identity/style, V2V from a supplied clip;
- persist each one during the `reference_map` phase by calling
  `film_upsert_clip` with `referenceRoles:[{ tag, role, path }]`, using the
  verbatim saved path. This writes the photo into the project
  `reference_registry` so it survives across clips and re-entries instead of
  living only in the current message;
- pass each path verbatim in `film_generate.referenceRoles[].path` (the tool
  reads it from disk; the path is absolute and already inside the workspace).

Before `film_generate`, read the project `reference_registry` (via
`film_get_project` / `film_get_canon`) and feed any persisted user photo into
`referenceRoles` rather than substituting a freshly generated image. A
user-supplied photo is input material — do NOT replace it with
`design_generate_image` output.

Do NOT verify a saved attachment path with `mastra_workspace_file_stat`,
`list_files`, or any other workspace file tool. Those tools are rooted at a
different base than `film_generate` and will report a valid absolute attachment
path as "outside the workspace" / "missing" — a false negative. Trust the
absolute path from the "Załączniki użytkownika" system note as-is and pass it
straight into `film_upsert_clip` and `film_generate.referenceRoles[].path`.
`film_generate` reads the file itself and is the only authority on whether the
path is valid. If `film_generate` rejects the path, surface that error; never
abort the run on a workspace-tool stat result.

If no system note is present but the user clearly refers to a photo, ask for the
file path or have them re-attach it — do not invent a path.

## Parallel Work

Use `system_run_worker` with `preset:"film"` for independent prompt variants,
take-review perspectives, multilingual rewrites, or continuity critique. Give
each worker the same frozen project/clip context and a different
anti-convergence anchor.

Never fan out across sequence clips. Clip N+1 depends on Clip N's accepted
observed end state.

## Completion Gate

Before reporting a clip/project as delivered, verify that the accepted take is recorded, the returned
video path comes from a successful generation result, and the continuity/canon state reflects the
accepted observed end state. A submitted task, approval request, or tool call by itself is not success.

## Delivery Defaults

Return:

- generated video path(s);
- last frame path if available;
- prompt spec summary;
- generation-run id/task id;
- continuity/canon update;
- source dates or caveats for platform facts;
- any moderation, safety, or approval caveats.
