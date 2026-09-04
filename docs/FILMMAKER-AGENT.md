# Filmmaker Agent

> Status: v1 foundation implemented. Seedance reference pack, film state,
> prompt/canon tooling, validators, approval-gated `film_generate`, generation
> ledger, meta/delegation routing, pipeline phase allowlists, model manifest
> entries, and static domain check are in place.
> Date: 2026-06-21

`filmmakerAgent` is the Seedance/film/video generation domain. It follows the
chef/writer pipeline pattern rather than the open-ended design pattern: durable
project state in MongoDB, phase status transitions, deterministic validators,
prompt contracts, take review, and an explicit remote-generation ledger.

## Runtime Pieces

| File | Purpose |
|---|---|
| `src/mastra/agents/film-agent.ts` | Mastra `filmmakerAgent` definition |
| `src/mastra/prompts/film/domain.md` | Ported root `seedance-2.0` operating prompt |
| `src/mastra/prompts/film/pipeline.md` | Mastra adapter for phases, tools, routing, and approval gates |
| `src/mastra/_skills/film/*` | Ported Seedance skills, references, data, and examples |
| `src/mastra/config/film-schemas/*.schema.json` | Ported JSON schema contracts |
| `src/mastra/lib/film-schemas.ts` | Zod mirrors and validation helpers |
| `src/mastra/config/film-surfaces.ts` | Seedance/Veo surface capabilities and env config |
| `src/mastra/tools/film/film-service.ts` | Mongo-backed project state and generation ledger service |
| `src/mastra/tools/film/film-project-tools.ts` | Project, clip, canon, prompt-spec, and take-review tools |
| `src/mastra/tools/film/film-reference-tools.ts` | Read-only loaders/search for the ported Seedance corpus |
| `src/mastra/tools/film/film-validators.ts` | Wrappers around `seedance-2.0` Python validators |
| `src/mastra/tools/film/film-generate.ts` | Approval-gated remote generation tool with MP4 download |
| `src/mastra/tools/film/film-ledger.ts` | Generation-run ledger tools |
| `src/mastra/scripts/check-filmmaker-domain.ts` | Static drift check for registration, routing, phases, schemas |

## Collections

| Collection | Role |
|---|---|
| `film_projects` | Project state capsule, status, clips, beats, canon, take history |
| `film_generation_runs` | Remote generation attempts, result state, output paths, errors |
| `approvals` | Existing system approval records consumed by first paid generation |

## Pipeline

The registered phases are:

```text
intake -> source_gate -> mode_select -> reference_map -> prompt_build
-> generate -> take_review -> repair -> deliver -> done
```

`PIPELINE_PHASE_TOOLS.filmmakerAgent` channels tools per phase. `film_generate`
is only available in the `generate` phase; state/status/read tools and reference
loaders stay available across phases.

## Generation Contract

`film_generate` uses `withToolEnvelope`, validates:

- project existence;
- prompt safety red flags;
- surface capability limits;
- first paid-run approval;
- API key presence;
- reference file boundaries under the repo or `/tmp`.

Without approval it returns `approval_required` and does not call the remote
surface. v1 implements the Seedance/fal path; `provider: "veo"` fails closed
until a separate prompt adapter exists.

Generated files are written under:

```text
FILM_OUTPUT_DIR || film-work/<projectId>
```

## Environment

Important `.env` keys:

```text
FILM_SKILLS_ROOT=
FILM_SKILL_ROOT=
FILM_OUTPUT_DIR=film-work
FILM_REQUIRE_APPROVAL=true
FILM_SURFACE=fal
FAL_KEY=
FAL_BASE_URL=https://queue.fal.run
FILM_FAL_MODEL_ID=fal-ai/bytedance/seedance/v2/text-to-video
FILM_FAL_SUBMIT_PATH=
FILM_POLL_INTERVAL_MS=5000
FILM_POLL_TIMEOUT_MS=600000
RUNWAY_API_KEY=
RUNWAY_BASE_URL=
FILM_RUNWAY_MODEL_ID=seedance2
ARK_API_KEY=
ARK_BASE_URL=
FILM_ARK_MODEL_ID=doubao-seedance-2-0
```

`FAL_KEY` should stay empty until a run is intentionally approved. The static
domain check does not need it.

## Routing

Meta now routes film/video requests through both layers:

- `system_delegate_task` exposes `filmmakerAgent` and describes Seedance/video
  tasks.
- `prompts/meta/base.md` and `prompts/meta/intent-router.md` explicitly classify
  film/video generation, Seedance prompts, clip continuation, take review, and
  MP4 delivery as filmmaker work.

Design remains responsible for static visual/design artifacts, decks,
infographics, launch animations, and reference image generation. Filmmaker can
reuse `design_generate_image` for first/last-frame references.

## Verification

```bash
npm run check:filmmaker-domain
npm run build
git diff --check
```

`check:filmmaker-domain` is intentionally network-free and does not call fal.
