# Filmmaker Domain — Porting `seedance-2.0` into Mastra

> End-to-end dev plan to recreate the open-source `seedance-2.0` skill pack
> (Emily2040, MIT) as a first-class **filmmaker domain** in our Mastra stack:
> a `filmmakerAgent` (chef-pattern + reflector) + parallel film subagents + a
> tool stack that wraps the repo's deterministic validators, persists sequence
> project state, and **closes the full generative loop** by calling a real
> Seedance 2.0 surface (fal/Runway/Volcengine) via a native tool.
>
> Source repo (read-only, do NOT modify logic): clone to
> `agentic-agents/storage/repos_external/seedance-2.0`
> License: MIT (commercial use OK).
>
> Sibling plan to mirror for conventions: `agentic-agents/ideas/designer.md`.

---

## 0. What `seedance-2.0` is — and why it is a CHEF, not a DESIGNER

`seedance-2.0` is an **agent-agnostic markdown skill pack** (one root `SKILL.md`
+ 28 sub-skills + 56 references + 5 JSON schemas + Python validators + dated
source data). The host agent IS the LLM. It is NOT an app and **ships no API
client** — the repo explicitly states: *"Do not claim this repository provides a
live Seedance API wrapper. It is an agent-skill workflow and reference package."*

### 0.1 Two critical differences from the design domain

| | `huashu-design` (designer) | `seedance-2.0` (filmmaker) |
|---|---|---|
| Who renders | **host LLM renders** (writes HTML→Playwright+ffmpeg→MP4 locally) | **host LLM does NOT render** — compiles a prompt for an **external** Seedance model |
| `scripts/` | renderers/exporters (do real local work) | **validators/linters** (`prompt_lint.py`, `project_state_check.py`, `continuity_chain_check.py`, …) — deterministic checks, NOT generation |
| Deliverable | finished file on disk | a compiled prompt + spec JSON + shot list **and** (loop-closed) a generated MP4 fetched from a remote surface |
| State | mostly stateless, per-deliverable | **heavily stateful**: sequence projects, project-state capsule, take history, continuity ledger |
| Host binaries | ffmpeg + Playwright Chromium required | **none** — remote model renders; we only do HTTP + file download |

**Consequence:** the filmmaker follows the **`chefAgent` pattern** (persistent
project store + status state machine + reflector + per-phase tool channeling),
NOT the open-ended `designAgent` pattern. The designer plan deliberately
*skipped* the reflector because design is open-ended; seedance has **explicit
linear phases**, so the reflector + `pipeline-phase-tools.ts` allowlist is the
right fit here (exactly like chef/content/hunt/writer).

### 0.2 Scope decisions (locked with the user)

1. **Full generative loop = YES, from v1.** The agent compiles the prompt AND
   calls a real Seedance surface to produce the video.
2. **Native Mastra tool, NOT MCP.** Generation is a `createTool` calling REST.
   We neither build an MCP server nor plug in a third-party one (AceDataCloud /
   MuAPI / RunComfy) — those are unofficial wrappers (some still Seedance 1.x),
   give us no run-ledger / pre-send validation, and widen the attack surface
   (cf. SkillInject). MCP is a *possible future export skin* (v3), not a runtime
   dependency.
3. **Seedance only for v1; Veo DEFERRED.** Skills compile *Seedance-grammar*
   prompts. Veo (which can do Polish audio) has a different prompt grammar +
   reference policy, so it is NOT just "another model id" — it needs a
   prompt-adapter. Keep `film_generate`'s provider field typed (`'seedance' |
   'veo'`) so the seam EXISTS, but do NOT implement the `veo` branch in v1
   (no stub, no `compileForVeo()`). Revisit Veo as a separate later task.
4. **Meta-agent must be able to DELEGATE to the filmmaker** (not only a direct
   chat path) — see §8. This is the same `system_delegate_task` wiring chef uses.

### 0.3 What ports losslessly vs must be built

| Layer | Ports how | Notes |
|---|---|---|
| `SKILL.md` (root operating loop) | **Lossless** → `prompts/film/domain.md` | Already English — NO translation pass (unlike designer P0). |
| `skills/*/SKILL.md` (28) + `references/*.md` (56) | **Lossless** → `_skills/film/*` | Preserve `[skill:x]` / `[ref:y]` routing via the `pipeline.md` adapter. |
| `schemas/*.json` (5) | **Lossless** → `config/film-schemas/` + zod mirrors | Real validation contracts (prompt-spec, project-state, clip-contract, take-review, generation-run). |
| `scripts/*.py` (validators) | **Wrap, don't rewrite** → `tools/film/*` | Deterministic Python; shell out from a pinned root. |
| `data/*.json` (community-patterns, sources) | **Lossless** (copy) | Dated source registry + community patterns. |
| `vocab` zh/ja/ko/es/ru | **Lossless** (copy, NO translation) | Native prompt vocab is intentionally non-English. |
| Parallel subagents (variants / critique) | **Functional equiv** | Native worker → `run_worker(preset:'film')` ×N. |
| Source gate / fact-check (`api-status`, model IDs, pricing) | **Functional equiv** | → delegate to `researcherAgent` (PSEV). |
| First/last-frame reference images (I2V/FLF2V) | **Reuse** | → existing `design_generate_image` tool. |
| **Seedance API client** | **BUILD (new)** | Not in repo. `film_generate` → fal/Runway/Volcengine REST. |
| `assets/*` (README infographics), `.github/`, `agents/openai.yaml`, `install_codex_skill.py`, `README*`, `CHANGELOG` | **SKIP** | Packaging of the source repo, not domain knowledge. |

---

## 1. Target architecture (mapping)

```
seedance-2.0                       Mastra filmmaker domain
────────────────────────────────────────────────────────────────────
SKILL.md                      →    prompts/film/domain.md (+ pipeline.md adapter)
skills/*/ + references/*       →    _skills/film/*   (skill_search / skill_load)
schemas/*.json                 →    config/film-schemas/*.json + lib/film-schemas.ts (zod)
scripts/*.py (validators)      →    tools/film/film-validators.ts (createTool wrappers)
data/*.json, vocab/*           →    _skills/film/{data,vocab}/*
project-state persistence      →    tools/film/film-project-tools.ts (chef-pattern store)
native parallel subagents      →    run_worker(preset:'film') × N in parallel
WebSearch / source gate        →    delegateTask → researcherAgent
first/last frame generation    →    REUSE tools/design/design-tools.ts (design_generate_image)
[NEW] generative loop          →    tools/film/film-generate.ts (film_generate, REST)
[NEW] run ledger               →    tools/film/film-ledger.ts (generation-run.schema)
```

`filmmakerAgent` = chef pattern: `combinePrompts('film/domain','film/pipeline')`,
thread-scoped observational memory, `maxSteps: 150`, `createTokenLimiter(120_000)`,
full `film_*` tool stack + `design_generate_image` + `runWorkerTool` +
`delegateTaskTool` + standard system/memory tools. Registered as a **pipeline
agent** so delegations auto-route through `generatePipelineWithReflection`.

### 1.1 Naming (must be internally consistent)

The fallback-chain health lookup (`agentModelKeyForId`) requires the Mastra
`agent.id` to be the **kebab-case** of the `agentModels` key. Mirror designer:

| Thing | Value |
|---|---|
| `agentModels` key / registry key / delegate enum / `PIPELINE_PHASE_TOOLS` key / `AGENT_IDS` | `filmmakerAgent` |
| Mastra `Agent.id` | `filmmaker-agent` |
| `agent-ids.ts` consts | `FILMMAKER_AGENT_ID='filmmakerAgent'`, `FILMMAKER_AGENT_MASTRA_AGENT_ID='filmmaker-agent'` |
| Tool id prefix | `film_*` (e.g. `film_set_project_status`, `film_generate`) |
| Tool export vars | `film*Tool` (e.g. `filmSetProjectStatusTool`) |

> Earlier chat said id `film-agent`; standardize on `filmmaker-agent` so the
> kebab of `filmmakerAgent` matches and the model-health gate resolves. (If you
> prefer the agent key `filmAgent`/id `film-agent`, change BOTH consistently.)

### 1.2 Pre-implementation hardening from repo review

These are mandatory fixes before coding the domain, based on the current Mastra
repo shape (not generic wishlist items):

1. **`run_worker(preset:'film')` needs two code changes, not one.** Adding
   `workerPresets.film` in `model-manifest.ts` is not enough: `tools/system/run-worker.ts`
   has a hard `z.enum([...])` and `PRESET_ROLES`. Add `film` to both, otherwise
   the model manifest will advertise a preset the tool schema rejects.
2. **Reference/skill loading must be explicit.** The plan says `_skills/film/*`
   with `[skill:x]` / `[ref:y]`, but `filmmakerAgent` must actually have a way to
   load those files. Options:
   - add `skill_search` / `skill_load` tools to `filmmakerAgent` using snake_case
     registry keys, and ensure copied film files have frontmatter (`name` +
     `description`) so `SkillRegistry` indexes them; or
   - build dedicated read-only `film_search_reference` / `film_load_reference`
     tools that resolve only under `src/mastra/_skills/film`.
   Do NOT rely on prompt-only path instructions if the agent has no loader tool.
3. **Paid/video generation must use the harness tool envelope.** `film_generate`
   should wrap its executor in `withToolEnvelope({ toolId:'film_generate',
   category:'other', risk:'medium', ... })` so paid remote calls are visible to
   policy, telemetry, and redaction. A comment saying `risk:'medium'` is not
   runtime enforcement.
4. **Approval needs a concrete token path.** First paid generation should be
   blocked unless the project already has approval recorded OR the input includes
   a valid approval token/id returned by `system_request_approval`. The tool
   should return `approval_required` without calling the surface when approval is
   missing.
5. **Surface capability validation is part of v1.** `config/film-surfaces.ts`
   should include per-surface limits (supported modes, duration range,
   resolution/aspect ratio, reference role/count limits, last-frame support,
   polling settings), not only `{ provider, surface, modelId }`. Validate before
   sending to fal/Runway/Ark.
6. **Safety/content gate is separate from prompt lint.** Add a pre-send safety
   validator or policy helper for likeness/IP/brand/persona/copyright-risk and
   disallowed generation classes. `prompt_lint.py` checks Seedance prompt shape;
   it is not a legal/safety gate.
7. **Static domain check required.** Add `check:filmmaker-domain` early, modeled
   after `check:writer-domain`, so registration drift is caught before any real
   API call.

---

## 2. Model manifest changes (`config/model-manifest.ts`)

> ⚠️ Default = `deepseek-v4-pro` for test economy, BUT every entry below is a
> plain `ModelKey` from the Section 1 inventory — **freely swappable to ANY model
> in the manifest** (claude-opus-4.8, gemini-3.1-pro-preview, gpt-5.5, …) to find
> the sweet spot by testing. Change the alias, restart, done — no other code
> touches the model choice. Keep `filmmakerAssignments` granular so individual
> sub-roles (compiler vs reviewer vs variant worker) can be tuned independently.

### 2a. `agentModels` (Section 2)
```ts
filmmakerAgent: 'deepseek-v4-pro' as ModelKey,  // Seedance prompt-compiler + director.
// Swap to any manifest alias to find the sweet spot (claude-opus-4.8 /
// gemini-3.1-pro-preview / gpt-5.5 are strong candidates for taste-bound
// prompt-compilation + source-gate reasoning).
```

### 2b. Worker preset (Section 4)
```ts
// in workerPresets:
film: 'deepseek-v4-pro' as ModelKey,  // parallel prompt-variant / critique subagents
```

Also update `tools/system/run-worker.ts`:
- add `film` to the `preset` `z.enum([...])`;
- add `film: 'Seedance prompt variants, take-review perspectives, continuity critique'`
  to `PRESET_ROLES`;
- include this in `check:filmmaker-domain`.

### 2c. Fallback chain (Section 4b)
```ts
// in agentFallbackChains:
filmmakerAgent: ['deepseek-v4-pro', 'deepseek-v4-flash', 'gemini-2.5-flash'],
// PRODUCTION: ['claude-opus-4.8','claude-sonnet-4.6','gpt-5.5'] — every entry MUST exist
// in config/model-capabilities.ts to be health-checkable (add claude-opus if you switch).
```

### 2d. New Section: filmmaker domain assignments
```ts
// SECTION 9: FILMMAKER DOMAIN ASSIGNMENTS
// Every value is a ModelKey from Section 1 → swap freely while testing for the
// sweet spot. Granular on purpose so each sub-role is tunable independently.
export const filmmakerAssignments = {
  promptCompiler:  'deepseek-v4-pro' as ModelKey,  // T2V/I2V/V2V/R2V prompt writing
  interviewer:     'deepseek-v4-pro' as ModelKey,  // vague idea → film brief (seedance-interview)
  variantWorker:   'deepseek-v4-pro' as ModelKey,  // parallel A/B prompt variants (run_worker preset)
  takeReviewer:    'deepseek-v4-pro' as ModelKey,  // retake-protocol triage (multimodal helps)
  referenceFrame:  'gpt-image-2'     as ModelKey,  // first/last frame gen (reuse image stack)
} as const;
```

> NOTE: the **video** model is NOT a Mastra `ModelKey` (it's a remote REST
> surface, not a text/image model the SDK resolves). Surface/model-id config
> lives in `config/film-surfaces.ts` (see §4.1), NOT in the `models` map.
> Veo (`veo-3.1`) already exists in `models` and is reused only when the
> Veo provider seam is enabled.

---

## 3. Schemas (`config/film-schemas/` + `lib/film-schemas.ts`)

Copy the 5 JSON Schemas verbatim, then add **zod mirrors** so tools validate
in-process (the Python validators are a second, deterministic gate).

| Schema | Drives |
|---|---|
| `prompt-spec.schema.json` | the internal prompt spec before compilation (mode, reference_roles, opening_state_source, endpoint, beat exclusions, natural_language_prompt). |
| `project-state.schema.json` | the persisted sequence project (story, world_bible, reference_registry, beats, clips, take_history, canon_revision). |
| `clip-contract.schema.json` | per-clip lineage (parent_clip_id, sequence_index, narrative_job, shot_structure, planned start/end, continuity_locks, status). |
| `take-review.schema.json` | post-generation triage (verdict accept/accept_with_deviation/repair/reject, observed states, beats, continuity_breaks, requires_user_confirmation). |
| `generation-run.schema.json` | the run ledger row (run_id, surface, input_mode, prompt, reference_tags, result_status). |

`lib/film-schemas.ts` exports zod versions + `validateXxx()` helpers used by the
project/ledger/generate tools.

---

## 4. Tool inventory (`tools/film/`)

### 4.1 `film-generate.ts` — the NEW generative loop (most important)

A single `createTool` that runs the async lifecycle end-to-end inside one call.

**Provider abstraction.** `config/film-surfaces.ts`:
```ts
export type FilmProvider = 'seedance' | 'veo';
export interface FilmSurfaceConfig {
  provider: FilmProvider;
  surface: string;        // 'fal' | 'runway' | 'volcengine' (seedance) | 'google' (veo)
  modelId: string;        // e.g. 'seedance2' (runway), 'doubao-seedance-2-0-260128' (ark)
  baseUrlEnv: string;     // env var holding base URL when applicable
  apiKeyEnv: string;      // e.g. 'FAL_KEY', 'RUNWAY_API_KEY', 'ARK_API_KEY'
}
export const DEFAULT_FILM_SURFACE: FilmSurfaceConfig = { provider:'seedance', surface:'fal', /* … */ };
```
> Pick ONE Seedance surface for v1. Recommendation: **fal** (single `FAL_KEY`,
> simplest `seedance2` route). Keep the others behind config, not code.

**Input (zod, from prompt-spec):**
`{ projectId, clipId, mode (T2V|I2V|V2V|R2V|FLF2V|edit|extend), prompt,
durationSec, aspectRatio, resolution, referenceRoles[] (role+url|path),
provider?, surface?, workspaceDir }`

**Execute phases (all inside the tool; the agent does NOT step through polling):**
1. **Pre-send gate** — call `film_lint_prompt` (zod + Python `prompt_lint.py`);
   abort with structured error if it fails. Never send an invalid prompt.
2. **create** — `POST` create-task on the surface with the mapped body
   (`prompt`, `mode`, `duration`, `aspect_ratio`, `resolution`, references).
   Capture `task_id`.
3. **poll** — loop `GET task/{id}` every N s (config; default ~5s) until
   `completed`/`failed`, with a hard timeout + attempt budget.
4. **retrieve** — `GET` output URL(s); **download MP4 (+ last frame) into
   `workspaceDir`**.
5. **ledger** — append a `generation-run` row via `film-ledger.ts`.

**Output (zod):** `{ ok, videoPath, lastFramePath?, taskId, provider, surface,
modelId, durationSec, moderation?, costEstimate?, error? }`.

**Risk/approval:** mark the tool `risk:'medium'` and gate the *first* paid
generation in a project behind `system_request_approval` (cost guard), mirroring
how mutation-heavy tools ask before spending.

Runtime detail: implement the risk marker through `withToolEnvelope`, not as a
comment-only convention. The first paid run gate must be fail-closed:
`film_generate` returns `{ ok:false, error:'approval_required', approvalRequest? }`
before any remote POST unless the project ledger already records approval or the
input carries a valid approval token/id.

> Veo seam: DEFERRED for v1. Keep the `provider` field typed `'seedance' | 'veo'`
> but throw a clear "veo provider not implemented" error on the `veo` branch.
> Implementing it (a `compileForVeo()` grammar adapter + Google Veo call via
> `models['veo-3.1']`, behind `FEATURE_FILM_VEO`) is a separate later task.

### 4.2 `film-validators.ts` — wrap the Python validators (read-only)

Pattern = `tools/design/design-tools.ts`: `execFile` from a pinned
`FILM_SKILL_ROOT` (`storage/repos_external/seedance-2.0`, with a
`.mastra/output` fallback + `FILM_SKILL_ROOT` env override, exactly like
`design_verify`'s root resolution).

| Tool id | Wraps | Purpose |
|---|---|---|
| `film_lint_prompt` | `scripts/prompt_lint.py` | validate the compiled prompt (golden sections, no placeholders). |
| `film_check_project_state` | `scripts/project_state_check.py` | validate project-state capsule vs schema + invariants. |
| `film_check_continuity` | `scripts/continuity_chain_check.py` | clip lineage / continuity-lock chain integrity. |
| `film_check_sources` | `scripts/source_registry_check.py` | dated source registry sanity (api-status freshness). |
| `film_check_generation_run` | `scripts/generation_run_check.py` | ledger row vs generation-run schema. |
| `film_check_sequence_eval` | `scripts/sequence_eval_check.py` | (optional) sequence eval rubric. |

Each returns `{ ok, errors[], warnings[] }`. TS check must pass.

### 4.3 `film-project-tools.ts` — sequence project store (chef pattern)

A persistent store (same storage approach as the chef project store) keyed by
`project_id`, holding the `project-state` capsule + clip contracts + take
history. Tools:

| Tool id | Purpose |
|---|---|
| `film_start_project` | create a project (story objective, mode, surface, clip budget, aspect/resolution defaults). |
| `film_get_project` / `film_list_projects` | read state. |
| `film_set_project_status` | **the reflector status tool** (see §5). |
| `film_upsert_clip` | create/update a clip contract (planned start/end, continuity_locks, shot_structure). |
| `film_record_take` | write a take-review (verdict + observed states); on `accept`, the observed `end_state`/`last_frame` becomes the next clip's opening source (canon update). |
| `film_get_canon` | return current accepted canon (for continuation prompts). |
| `film_compile_prompt_spec` | assemble a `prompt-spec` from project + clip + reference map (validated by `film_lint_prompt`). |

Invariants to enforce (from `SKILL.md` Sequence Gate): accepted observed state
overrides planned; rejected footage cannot become a continuation source; future
beats stay provisional; reference tags survive unchanged; continuity updated
after each accepted take.

### 4.4 Reused / delegated (no new code)
- **First/last frame images** → `design_generate_image` (import from
  `tools/design/design-tools.ts`). Output path/URL feeds `referenceRoles`.
- **Source/fact gate** → `delegateTask({ targetAgent:'researcherAgent' })` to
  verify current model IDs / pricing / region before asserting platform facts.
- **Reference/skill loading** → either reuse `skill_search` / `skill_load` with
  indexed frontmatter on copied film files, or add film-specific loaders. The
  selected path must be present in `filmmakerAgent.tools`; prompt path mapping
  alone is not executable.

---

## 5. Reflector & phases (`config/pipeline-phase-tools.ts`)

Add a `filmmakerAgent` entry. `statusTool: 'film_set_project_status'`. Because
`delegate-task.ts` routes any `isPipelineAgent(targetAgent)` through
`generatePipelineWithReflection`, this entry is what makes in-flight reflection +
per-phase tool channeling work for the filmmaker — no other wiring needed.

Proposed phases (linear, mirrors `SKILL.md` operating loop):

```ts
filmmakerAgent: {
  statusTool: 'film_set_project_status',
  alwaysAvailable: [
    ...SHARED_ALWAYS,
    'film_set_project_status', 'film_get_project', 'film_list_projects',
    'film_get_canon', 'film_check_project_state', 'film_check_continuity',
  ],
  phases: {
    intake:        ['film_start_project'],                                   // goal, mode, surface, budget
    source_gate:   ['system_delegate_task', 'film_check_sources'],           // researcher verifies api-status/model IDs
    mode_select:   ['film_upsert_clip'],                                     // T2V/I2V/V2V/R2V/FLF2V + shot_structure
    reference_map: ['film_upsert_clip', 'design_generate_image', 'system_run_worker'], // assign roles; gen first/last frame
    prompt_build:  ['film_compile_prompt_spec', 'film_lint_prompt', 'system_run_worker'], // compile + parallel variants
    generate:      ['film_generate', 'film_check_generation_run', 'system_request_approval'], // call surface + ledger
    take_review:   ['film_record_take', 'film_check_continuity'],            // retake-protocol verdict
    repair:        ['film_compile_prompt_spec', 'film_lint_prompt', 'film_generate', 'system_run_worker'], // one-variable retake
    deliver:       ['film_get_project', 'film_get_canon'],                   // hand back paths + ledger
    done:          [],
  },
},
```

Checkpoints with `[]` still return `alwaysAvailable` (fail-open). Remember the
**id→key translation** boundary: this map uses snake `id`s; the reflector
translates to camelCase tool keys via `buildToolIdToKeyMap`.

---

## 6. Agent file (`agents/film-agent.ts`)

Copy `agents/chef-agent.ts` structure exactly. Differences: tool imports, model
key, prompts.

```ts
export const filmmakerAgent = new Agent({
  id: 'filmmaker-agent',
  name: 'Filmmaker Agent',
  instructions: await combinePrompts('film/domain', 'film/pipeline'),
  model: resolveModelId(agentModels.filmmakerAgent),
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
    filmStartProjectTool, filmGetProjectTool, filmListProjectsTool, filmSetProjectStatusTool,
    filmUpsertClipTool, filmRecordTakeTool, filmGetCanonTool, filmCompilePromptSpecTool,
    // validators
    filmLintPromptTool, filmCheckProjectStateTool, filmCheckContinuityTool,
    filmCheckSourcesTool, filmCheckGenerationRunTool,
    // generative loop
    filmGenerateTool,
    // reused image gen (first/last frame)
    designGenerateImageTool,
    // system / memory
    runWorkerTool, delegateTaskTool, requestApprovalTool, currentTimeTool,
    memoryRecallTool, memoryWriteTool, addContextTool,
  },
});
```

---

## 7. Prompts (`prompts/film/`)

- `domain.md` — **lossless** copy of `SKILL.md` (operating loop, sequence gate,
  load map, soul). Authoritative film brain.
- `pipeline.md` — Mastra adapter (mirror `prompts/design/pipeline.md`):
  - **Path mapping**: `[ref:x]` / `[skill:y]` → load from `_skills/film/…`.
  - **Source gate**: delegate fact/model-ID/pricing verification to
    `researcherAgent`; never assert platform facts from memory.
  - **Reference frames**: when a mode needs first/last frame, use
    `design_generate_image` and record the path in the reference map.
  - **Generation contract**: prefer `film_generate`; it lints before sending,
    polls, downloads, and ledgers. Gate the first paid run via approval.
  - **Parallelism**: prompt variants / take perspectives via
    `run_worker(preset:'film')` ×N with anti-convergence anchors; NEVER fan out
    across sequence clips (they are sequential — continuation depends on the
    prior accepted take).
  - **Delivery defaults**: return video path(s) + last frame + ledger summary +
    any moderation/caveats with source dates.

### 7.1 Meta routing prompts (do not skip)

There are two separate routing surfaces:

1. `tools/system/delegate-task.ts` tells any caller what `targetAgent` values
   exist and what each expert can do.
2. `prompts/meta/base.md` + `prompts/meta/intent-router.md` teach the meta-agent
   when to choose those targets before it calls the tool.

For `filmmakerAgent`, update both layers. Add it to the meta-agent domain table
and add explicit Polish/English routing phrases such as:

- "zrób film", "wygeneruj wideo", "klip", "sekwencja", "Seedance",
  "T2V/I2V/V2V/FLF2V", "prompt do generacji wideo";
- "make a video", "generate a clip", "film sequence", "Seedance video".

Also update `intent-router.md` so concrete film/video generation tasks classify
as `tool_request` or `workflow_orchestration`, not `general_chat`.

Repo-review note: `writerAgent` is already described in `meta/base.md` and
`intent-router.md`; it also has `check:writer-domain` asserting those routing
hooks. `designAgent` exists in `delegate-task.ts`, but the current meta prompt
does not list it in the domain table, so design routing is partially implicit.
For filmmaker we should not repeat that drift: add prompt routing and a static
check from day one.

---

## 8. Registration & exposure — including META delegation (user requirement)

The meta-agent (and other callers) must be able to **delegate** to the filmmaker,
not just chat with it directly. Wiring (mirror designer's P8):

1. **`index.ts`** — register in `new Mastra({ agents: { …, filmmakerAgent } })`
   (registry key `filmmakerAgent`).
2. **`config/agent-ids.ts`**:
   - add `FILMMAKER_AGENT_ID='filmmakerAgent'`, `FILMMAKER_AGENT_MASTRA_AGENT_ID='filmmaker-agent'`, `FILMMAKER_AGENT_ALIASES`.
   - add both to `canonicalizeRuntimeAgentId` + `agentIdAliases`.
   - if the filmmaker will itself delegate (it does — researcher), add
     `FILMMAKER_AGENT_ID` to `DELEGATION_CALLER_AGENT_IDS` and
     `DELEGATION_RETURN_AGENT_IDS`.
3. **`tools/system/delegate-task.ts`** — THE meta-delegation path:
   - add `filmmakerAgent: 'filmmakerAgent'` to the `AGENT_IDS` map.
   - add `'filmmakerAgent'` to the `targetAgent` z.enum.
   - add a domain line to the tool `description` (so meta/coding/content/designer
     know when to route): e.g. *"filmmakerAgent → Seedance 2.0 video production:
     from a film idea or sequence brief → source-gated prompt compilation
     (T2V/I2V/V2V/R2V/FLF2V) → validation → real generation on a Seedance surface
     → take review + continuity → delivered MP4 + run ledger. Any 'zrób film /
     wideo / klip / sekwencja / generuj wideo z Seedance' → filmmakerAgent."*
   - add a recursive self-delegation guard (copy the designAgent block):
     `if (callerAgentId === FILMMAKER_AGENT_ID && targetAgent === 'filmmakerAgent') → blocked`.
   - add a `case 'filmmakerAgent':` to `buildDelegationSuccessCriteria` (e.g.
     "names the generated video path(s) or explains why generation was skipped;
     platform facts are researcher-verified; prompt passed lint before send").
   - **No new branch needed in `execute`**: once `filmmakerAgent` is in
     `PIPELINE_PHASE_TOOLS` (§5), the existing `isPipelineAgent(...)` branch
     auto-routes it through `generatePipelineWithReflection`. ✅
4. **`config/model-capabilities.ts`** — only if you switch the fallback chain to
   models not already registered there (e.g. `claude-opus-4.8` for production).
5. **`prompts/meta/base.md`** — add `filmmakerAgent` to the expert-agent table
   and add a hard routing rule for film/video/Seedance tasks.
6. **`prompts/meta/intent-router.md`** — classify film/video generation requests
   as tool/workflow requests. Include Polish terms (`film`, `wideo`, `klip`,
   `sekwencja`, `Seedance`) and English terms.
7. **Static check** — `check:filmmaker-domain` must assert all of the above:
   delegate enum, `AGENT_IDS`, recursive guard, success criteria, meta prompt,
   intent-router, phase map, manifest, run-worker enum, env example.

---

## 9. Environment prerequisites (host)

- **API key for the chosen Seedance surface**: `FAL_KEY` (recommended v1), or
  `RUNWAY_API_KEY` / `ARK_API_KEY` for the alternatives.
- **Python 3** on the host (for the wrapped validators) — same requirement the
  designer's `design_verify` already imposes.
- **Reused keys** (already present): `GOOGLE_GENERATIVE_AI_API_KEY` /
  `OPENAI_API_KEY` for `design_generate_image`; `TAVILY` for researcher.
- **Filesystem**: a workspace dir with write access for downloaded MP4s (same
  pattern as codingAgent's workspace).
- **No ffmpeg / Playwright** required for v1 (remote model renders; Seedance
  audio is native). ffmpeg only returns for the DEFERRED PL-voiceover path (§15)
  to mux a TTS track. Veo seam (deferred) reuses the existing Google key.

Add these to `.env.example` in the implementation phase:

```dotenv
# ── Filmmaker Agent / Seedance surfaces (OPTIONAL until real generation) ─────
FILM_SKILLS_ROOT=
FILM_SKILL_ROOT=
FILM_OUTPUT_DIR=film-work
FILM_REQUIRE_APPROVAL=true
FILM_SURFACE=fal
FAL_BASE_URL=https://queue.fal.run
FILM_FAL_MODEL_ID=fal-ai/bytedance/seedance/v2/text-to-video
FILM_FAL_SUBMIT_PATH=
FILM_POLL_INTERVAL_MS=5000
FILM_POLL_TIMEOUT_MS=600000
FAL_KEY=
RUNWAY_API_KEY=
RUNWAY_BASE_URL=
FILM_RUNWAY_MODEL_ID=seedance2
ARK_API_KEY=
ARK_BASE_URL=
FILM_ARK_MODEL_ID=doubao-seedance-2-0
```

---

## 10. Phased implementation plan

- [x] **P0 · Source clone** — clone Emily2040/seedance-2.0 (read-only) to
  `storage/repos_external/seedance-2.0`. NO translation pass (already English;
  vocab stays native). Add to `.gitignore`/repo-external conventions as designer did.
- [x] **P1 · Skeleton** — `prompts/film/{domain,pipeline}.md`; copy `skills/*`
  + `references/*` → `_skills/film/*`; copy `data/*` + `vocab/*`; copy
  `schemas/*` → `config/film-schemas/`. Verify `[ref:]`/`[skill:]` routing in
  `pipeline.md`. Decide and implement the reference-loading mechanism:
  frontmatter-indexed `skill_search`/`skill_load` OR dedicated film loaders.
- [x] **P2 · Schemas** — `lib/film-schemas.ts` (zod mirrors + validators). `tsc` passes.
- [x] **P3 · Manifest** — `agentModels.filmmakerAgent`, `workerPresets.film`,
  `agentFallbackChains.filmmakerAgent`, `filmmakerAssignments`, plus
  `run-worker.ts` enum/role support for `preset:'film'`. `npm run build` passes.
- [x] **P4 · Validators (read-only)** — `film-validators.ts` wrapping the 5–6
  Python scripts with the design-style root resolution + `FILM_SKILL_ROOT`. Smoke
  each in isolation (expects Python present).
- [x] **P5 · Project store + state machine** — `film-project-tools.ts`
  (start/get/list/status/upsert_clip/record_take/get_canon/compile_prompt_spec)
  + enforce sequence invariants. `film-ledger.ts` (generation-run rows).
- [x] **P6 · Generative loop** — `config/film-surfaces.ts` + `film-generate.ts`
  (one surface, fal). Pre-send lint, create/poll/retrieve, download, ledger,
  `withToolEnvelope`, approval gate on first paid run, pre-send safety gate, and
  per-surface capability validation. Provider field typed `'seedance' | 'veo'`;
  `veo` branch throws "not implemented" (deferred).
- [x] **P7 · Agent** — `agents/film-agent.ts` (chef pattern) + register in `index.ts`.
- [x] **P8 · Reflector + exposure** — `pipeline-phase-tools.ts` film phases;
  `agent-ids.ts`; `delegate-task.ts` (enum + AGENT_IDS + description + recursive
  guard + success criteria); `prompts/meta/base.md`; `prompts/meta/intent-router.md`.
  Verify meta→filmmaker delegation routes through the reflector.
- [x] **P9 · Parallelism** — wire prompt-variant + take-perspective workers
  (`run_worker(preset:'film')`) via `pipeline.md` (no new state machine).
- [x] **P10 · Static domain check** — add `src/mastra/scripts/check-filmmaker-domain.ts`
  + `npm run check:filmmaker-domain`, modeled after `check:writer-domain`, covering
  manifest, run-worker enum, agent registration, delegate routing, meta prompts,
  env example, phase map, prompt/schema/reference files, and loader availability.
- [ ] **P11 · E2E validation** — run `evals/`-style prompts (see §11).

### Non-model verification gates (per phase)
- `npx tsc --noEmit` after each code phase; `npm run build` after manifest +
  registration; `npm run check:filmmaker-domain` after P8/P10.

### Final real-model / real-API test queue (defer to end)
- [ ] Prompt/path smoke: agent loads `domain.md`+`pipeline.md`, resolves one
  `[ref:]` from `_skills/film`, compiles a tiny T2V prompt-spec, passes lint.
- [ ] Worker preset smoke: `run_worker({preset:'film'})` resolves the configured model.
- [ ] Source gate: a prompt mentioning a current model ID/pricing delegates to
  researcher before asserting, and records source URLs/dates.
- [ ] Generation: `film_generate` (fal) creates→polls→downloads a real MP4 and
  appends a valid `generation-run` ledger row; approval gate fires on first run.
- [ ] Reference frame: `design_generate_image` produces a first frame that feeds
  an I2V generation.
- [ ] Sequence: clip 2 continuation uses clip 1's accepted last frame as opening
  source; rejected take cannot be used as a source.
- [ ] Meta delegation: `system_delegate_task({targetAgent:'filmmakerAgent', …})`
  from meta routes through `generatePipelineWithReflection` with phase channeling.

---

## 11. Acceptance criteria

1. One-sentence idea → a finished, lint-passing Seedance prompt + spec JSON.
2. `film_generate` produces a downloaded MP4 from a real surface + a valid ledger row.
3. I2V/FLF2V: a generated first/last frame (via `design_generate_image`) drives generation.
4. Sequence project: accepted observed end-state overrides planned and becomes the
   next clip's opening source; rejected footage is excluded from canon.
5. Platform-fact prompts trigger a `researcherAgent` source-gate before asserting.
6. Meta-agent can DELEGATE a film task (not only direct chat) and the run goes
   through the reflector with per-phase tool channeling.
7. First paid generation in a project is approval-gated (cost guard).

---

## 12. Resolved decisions

- **Veo** — RESOLVED: DEFERRED. Provider field stays typed `'seedance' | 'veo'`;
  `veo` branch throws "not implemented". Revisit as a separate task.
- **Models** — RESOLVED: default `deepseek-v4-pro`, but every `agentModels` /
  `filmmakerAssignments` / `workerPresets.film` entry is a swappable `ModelKey`.
  User will tune to the sweet spot by testing different manifest models.
- **v1 Seedance surface** — RECOMMENDED: **fal** (single `FAL_KEY`, simplest
  `seedance2` route, no China-account/region hurdles). See §13 for the rationale.
  Runway / Volcengine Ark stay config-only (`config/film-surfaces.ts`).
- **MCP export (v3)** — out of scope now; revisit only if external clients must
  call the film stack.

---

## 13. What is a "surface"? (and why fal for v1)

Seedance 2.0 is **one model (ByteDance)** reachable through several **vendor
endpoints** ("surfaces"). The skill compiles the same prompt regardless; only the
HTTP call in `film_generate` differs per surface. Options:

| Surface | What it is | Pros | Cons |
|---|---|---|---|
| **fal** | 3rd-party aggregator exposing `seedance2` | one `FAL_KEY`, clean REST + polling, fastest to integrate, no region gate | aggregator pricing, not the source-of-truth spec |
| **Runway** | Runway's own API (`seedance2`, `runway://` uploads) | official-ish, MCP also exists | plan/region constraints, SDK field lag, reference-count rules |
| **Volcengine Ark** | ByteDance's official China cloud (`doubao-seedance-2-0-*`) | authoritative model IDs, first/last-frame roles, `return_last_frame` | China account + identity verification + region/entitlement hurdles |

**Recommendation: fal for v1** — lowest friction to close the loop and validate
the whole pipeline. Because `film-generate.ts` uses a provider/surface config
(§4.1), switching to Runway or Ark later is a config + one mapping function, not
a rewrite.

---

## 14. Does the filmmaker have helpers, or work alone?

**It has helpers — two kinds — but no bespoke stable of mini-agents.** Same
delegation model as chef/content/hunt:

1. **`researcherAgent` (a real domain agent)** — the *source gate*. Seedance
   facts (current model IDs, pricing, region/entitlement, `api-status` freshness)
   decay, so the filmmaker delegates verification via `system_delegate_task`
   instead of asserting from memory. This is the only standing sub-agent it leans on.
2. **Ephemeral workers via `run_worker(preset:'film')`** — not persistent agents,
   just parallel LLM calls the orchestrator spawns for: A/B prompt variants of
   one clip, multilingual prompt variants, or take-review perspectives. Each gets
   an isolated context + anti-convergence anchor. **Never** fan out across
   sequence clips (they're sequential — a continuation needs the prior accepted take).

Everything else it does **itself or via its own tools** (compile prompt, lint,
project store, take review, ledger, call `film_generate`). First/last-frame
images come from a **tool reuse** (`design_generate_image`), NOT an agent
delegation. So: orchestrator + 1 standing helper (researcher) + on-demand
workers — it does the craft itself, delegates only facts and parallel grunt work.

---

## 15. Audio / voice — only Seedance for v1 (NO new voice provider)

**Seedance 2.0 generates audio natively** (`SKILL.md`: "native audio",
"dialogue, lip-sync and audio"). So the v1 loop needs **no separate TTS/voice
model** — sound (incl. dialogue) comes out of the video model itself. The only
non-text provider we add is the **Seedance surface**.

**Polish-voiceover caveat (DEFERRED, like Veo).** Seedance's native dialogue is
strong in EN/ZH, weak in PL. A Polish lektor/dub is a **post-production** path:
generate clean/quiet video → overlay a TTS track. This needs **no new manifest
provider** — reuse the existing TTS stack:
- manifest already has `eleven-*`, `gemini-tts-*`, `openai tts` aliases;
- the design domain already ships `design_tts` (ElevenLabs, returns measured
  `duration`) + a narration pipeline → reuse, don't rebuild.

**Cost:** this path reintroduces **ffmpeg** (to mux the audio track onto the
downloaded MP4) — which the Seedance-native-audio v1 does NOT need. So the PL
voiceover path is a clean v2 add (reuse `design_tts` + an ffmpeg mux step),
not a v1 dependency.

> Optional: add a `tts: 'eleven-multilingual-v2' as ModelKey` line to
> `filmmakerAssignments` now (unused in v1) to reserve the seam, mirroring how
> `designAssignments.tts` is wired. No code depends on it until the PL-voiceover
> path is built.
```

---

## 16. User-supplied photos — image-input plan (post-implementation add-on)

**Status:** filmmaker is implemented; this section adds the missing path for
feeding the USER'S OWN photos into generation (modes I2V / FLF2V / R2V / V2V).

### 16.0 Current state (verified in code)

`film_generate.referenceRoles[]` (`{ role, url, path, tag }`,
`tools/film/film-generate.ts:19`) is the ONLY image-in channel. `referenceValue()`
(`film-generate.ts:135-150`) resolves:
- `url` → sent as-is to fal;
- `path` → read from disk, base64 data-URI, **must be inside `cwd` or `/tmp`,
  ≤10 MB, jpg/png/webp/mp4** (path-traversal + size guard at lines 141-150).

So three routes today:
- **(c) photo from a directory → WORKS** (put file under cwd/`/tmp`, give the
  agent the path; it sets `referenceRoles[].path`).
- **(b) meta delegation → partial** — `system_delegate_task` is TEXT-ONLY
  (`taskDescription`/`taskSpec`, no binary field); meta can only forward a
  path/URL string, not the image bytes.
- **(a) attach image in Mastra Studio chat → DOES NOT reach production** — the
  filmmaker has no tool to persist an attachment to disk; `film_generate` needs
  a path/url it cannot obtain from a vision-only message part.

### 16.1 Why this is an inputProcessor, NOT an LLM tool

An LLM **cannot emit the raw bytes of an image it was shown**, so a
`save_image(bytes)` tool would have nothing to write. But the bytes ARE present
at ingestion: AI SDK v6 delivers an attachment as a message part
`{ type: 'file', mediaType, filename?, url }` where `url` is a `data:` base64
URL or a hosted `http(s)` URL (verified: `ai@6.0.177` `FileUIPart`; Mastra
`MastraMessageContentV2.parts[]`, `@mastra/core@1.32.1`
`agent/message-list/state/types.d.ts:71`; legacy bytes may also sit in
`content.experimental_attachments[]`). Therefore persistence belongs in an
**inputProcessor** (`BaseProcessor.processInput`, runs once before the model),
modelled on `src/mastra/processors/pending-updates.ts`.

### 16.2 New processor — `AttachmentPersistProcessor`

File: `src/mastra/processors/attachment-persist.ts` (template: `pending-updates.ts`).

`processInput(args)`:
1. Take only the **latest user message** (avoid re-saving memory-recalled parts).
2. Scan `message.content.parts[]` for `type === 'file'` with `mediaType` in an
   allowlist (`image/png|jpeg|webp`, optional `video/mp4`); also scan
   `content.experimental_attachments[]`.
3. Per attachment: decode `data:` base64 OR `fetch` the hosted URL; enforce
   ≤10 MB; write to `film-work/_inbox/<threadId-or-uuid>/<uuid>.<ext>` (resolved
   under `cwd`, so it passes the `film_generate` guard).
4. **Strip the heavy part:** replace the base64 `file` part with a short text
   part (or drop it) so the data-URL does not blow the token budget.
5. Inject a `systemMessage` listing saved paths + mediaType + filename, e.g.
   `## Załączniki użytkownika (zapisane na dysku)` + `- film-work/_inbox/<id>/abc.jpg (image/jpeg, "portret.jpg")`.
6. `try/catch` with pass-through (return `messages` unchanged on error), like
   `pending-updates`.

Export `attachmentPersistProcessor` (no constructor args needed; path lives
under `cwd`).

### 16.3 Wiring (order matters)

- **filmmaker** (`agents/film-agent.ts:74`):
  `inputProcessors: [ attachmentPersistProcessor, createTokenLimiter(120_000) ]`
  — persist+strip BEFORE token counting.
- **meta** (`agents/meta-agent.ts:206`): add `attachmentPersistProcessor` at the
  FRONT (before `pendingUpdatesProcessor` / `ToolSearchProcessor`), so an image
  attached to meta is saved and meta sees the path note.

### 16.4 No change to `delegate-task.ts`

Delegation stays text. Meta forwards the saved **path string** in
`taskDescription`; filmmaker puts it into `referenceRoles[].path`. Route (b)
solved without touching the delegation contract.

### 16.5 Prompt changes

- `prompts/film/domain.md` + `film/pipeline.md`: when a "Załączniki użytkownika"
  system note appears, treat listed paths as input material — assign a role
  (`first_frame`/`identity`/`last_frame`/`motion`/`reference`), pick the mode
  (`I2V`/`FLF2V`/`R2V`/`V2V`), pass as `film_generate.referenceRoles[].path`.
- `prompts/meta/intent-router.md` (+ `base.md`): for a filmmaker task with
  attached images, copy the note's paths **verbatim** into the delegation text.

### 16.6 Static check

Extend `scripts/check-filmmaker-domain.ts`: assert `attachmentPersistProcessor`
is present in `inputProcessors` of BOTH filmmaker and meta (catch wiring
regressions in CI).

### 16.7 Tests / acceptance

- Unit: synthetic `MastraDBMessage` with a `data:`-URL file part → file written
  under `film-work/_inbox/`, ≤10 MB passes / >10 MB rejected, note carries the
  path, heavy part stripped.
- E2E (a): Studio chat with filmmaker, attach jpg, "make a 6s clip from this" →
  `film_generate` called `mode:'I2V'`, `referenceRoles:[{role,path}]`.
- E2E (b): attach to meta, "delegate to filmmaker a video from this photo" →
  meta delegates with path in text → filmmaker generates.
- (c) regression: still works.

### 16.8 Risks / notes

- Hosted Studio URLs may expire → download to disk; a stable public URL may also
  be passed straight through (`film_generate` accepts `url`).
- Multi-image role assignment left to model/user (note only lists); optional
  convention "first image = first_frame".
- System note lives per-call; files persist on disk, so later turns can still
  reference paths.

**Scope:** 1 new file (processor) + 2 wirings (film-agent, meta-agent) + 2
prompts + 1 check. No change to `film_generate` or `delegate-task`.
