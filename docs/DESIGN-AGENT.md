# Design Domain

> Status: implementation wired through P8. The `designAgent` is registered and
> routable through `system_delegate_task`. Real model/API/export validation is
> intentionally deferred to the final queue in `ideas/designer.md`.

## Cel

Design domain ports the MIT `huashu-design` skill into Mastra as a first-class
HTML design/prototyping domain. It is intended for:

- high-fidelity HTML prototypes and app mockups,
- HTML slide decks with PDF/PPTX export paths,
- timeline animations recorded to MP4/GIF,
- infographics and visualizations,
- design direction advisor mode,
- multi-perspective critique.

The source repo remains read-only at:

```text
storage/repos_external/huashu-design
```

## Current Runtime Layout

- `src/mastra/prompts/design/domain.md` is a lossless copy of `SKILL.md`.
- `src/mastra/prompts/design/pipeline.md` maps huashu paths and workflows to
  Mastra delegation/tooling.
- `src/mastra/_skills/design/*` contains the 24 reference docs.
- `src/mastra/assets/design/*` contains the copied asset bundle: frames, deck
  shells, animation helpers, BGM/SFX, showcases, and examples.
- `src/mastra/agents/design-agent.ts` defines the runtime agent with the
  chef/content pattern: design prompts, Opus model, thread memory, 150 max
  steps, token limiter, `runWorkerTool`, `delegateTaskTool`, and the full
  `design_*` stack.
- `src/mastra/tools/design/design-tools.ts` exports:
  - `designFetchImagesTool` → wraps `scripts/fetch_images.py`.
  - `designFetchBrandAssetsTool` → tries SVGL, Simple Icons, then favicon.
  - `designGenerateImageTool` → manifest-selected Google Gemini Image, Google
    Imagen, or OpenAI GPT Image via direct REST calls.
  - `designVerifyTool` → wraps `scripts/verify.py`.
  - `designRenderVideoTool` and `designRenderVideoSeekTool` → wrap Huashu video
    render scripts.
  - `designConvertFormatsTool` and `designAddMusicTool` → wrap format/BGM shell
    helpers.
  - `designExportPptxTool`, `designExportPdfTool`, `designGenThumbsTool` →
    wrap deck export helpers.
  - `designTtsTool` → ElevenLabs TTS with measured duration and optional
    timestamp sidecar.
  - `designNarratePipelineTool` → Mastra-native narration script parser that
    emits `voiceover.mp3` and Huashu-compatible `timeline.json`.
- `src/mastra/tools/system/delegate-task.ts` can route to `designAgent` through
  plain direct `generate` for v1.

## Model Assignments

Configured in `src/mastra/config/model-manifest.ts`:

- `agentModels.designAgent`: `claude-opus-4.8`.
- `workerPresets.design`: `claude-sonnet-4.6`.
- `designAssignments.htmlGenerator`: `claude-sonnet-4.6`.
- `designAssignments.directionAdvisor`: `claude-opus-4.8`.
- `designAssignments.expertCritique`: `gpt-5.5`.
- `designAssignments.imageGen`: `gemini-image-pro`.
- `designAssignments.imageGenPhoto`: `imagen-4-ultra`.
- `designAssignments.tts`: `eleven-multilingual-v2`.

`designAssignments.imageGen` and `designAssignments.imageGenPhoto` can be changed
to any image alias supported by `design_generate_image`: `gemini-image-pro`,
`gemini-image-flash`, `imagen-4-fast`, `imagen-4`, `imagen-4-ultra`,
`gpt-image-2`, or `gpt-image-1`.

`run_worker` accepts `preset: 'design'`.

## Open Work

- Run the final real-model/API validation queue recorded in
  `ideas/designer.md`.
- Validate host prerequisites: ffmpeg/ffprobe, Playwright Chromium, Python,
  Python `playwright` package plus browser install, pptxgenjs/sharp/pdf-lib,
  Google image API key, and ElevenLabs voice/API key.
- Only after validation, close P3/P4/P5/P9 in the plan.

## Validation Policy

Full model/API/export tests are deferred until implementation end. Current
non-model verification:

```bash
npx tsc --noEmit --pretty false
npm run build
```

pass after agent registration, delegation routing, and the final
`designAssignments` correction.
