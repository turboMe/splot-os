# GameDev Domain — Agentic Unreal Engine 5.8 production (`gameDevAgent`)

> End-to-end dev plan for a first-class **gamedev domain** in our Mastra stack: a
> `gameDevAgent` (chef-pattern + reflector) that drives the **official Unreal MCP**
> plugin shipped in UE 5.8 (a local MCP server at `http://127.0.0.1:8000/mcp`) to
> build small 3D game prototypes — levels, actors, materials, lighting, simple
> mechanics — and **closes the loop** with Unreal's automation tests + a
> screenshot/VLM take-review acting as the deliverable scorer.
>
> Sibling plans to mirror for conventions: `agentic-agents/ideas/filmmaker.md`
> (closest CHEF analog) and `agentic-agents/ideas/musician.md`.
>
> **The one big inversion vs filmmaker/musician (read first):** filmmaker/musician
> deliberately use a **native REST tool, NOT MCP**, because fal/ElevenLabs are paid
> remote surfaces where we need our own run-ledger + pre-send validation. Here the
> situation is reversed: **Epic SHIPS the surface as an MCP server**. So the
> generative surface IS MCP — consumed via a **dedicated, feature-flagged, isolated
> `MCPClient`** (the `n8nMcpClient` precedent in `src/mastra/mcp.ts`), NOT the shared
> `mcpClient`. We still wrap it with a thin native control/state layer (project
> store + build/test ledger + status state machine + approval/safety + a
> game-thread serialization queue), because the raw MCP tools give us none of that.
> This is the same hybrid the n8n domain already uses: MCP for the actions, native
> tools for orchestration/state/safety.

---

## 0. What the gamedev domain is — and why it is CHEF (MCP-surfaced)

The gamedev domain follows the **`chefAgent` pattern** (persistent project store +
status state machine + reflector + per-phase tool channeling), exactly like
filmmaker/chef/content/hunt/writer. It has **explicit linear phases**
(design → asset-plan → blockout → implement → test → repair → deliver), so the
reflector + `pipeline-phase-tools.ts` allowlist is the right fit.

### 0.1 Three differences from the filmmaker/musician domains

| | filmmaker/musician | **gamedev** |
|---|---|---|
| Generation surface | native REST tool (fal/ElevenLabs); **NOT MCP** | **the surface IS MCP** — Epic's official Unreal MCP server, consumed via a dedicated `MCPClient` |
| Determinism of the loop | one POST → poll → download a finished artifact | **many small, serial, stateful editor mutations** (spawn actor, set light, make material…) against a live editor that holds mutable state |
| Concurrency | film = never fan out across clips; music = album tracks CAN | **never overlap editor calls** — Unreal executes MCP calls on the **game thread, serially** (Epic warns against overlapping calls). Workers are for *planning only*, never concurrent editor writes. |
| "Render" cost | paid per generation | **no per-call \$ cost** (local editor), but high **state-corruption risk** — a bad call can break a scene/blueprint. The guard is validation + tests, not a spend cap. |
| Deliverable scorer | take-review on a returned MP4/audio | **automation test pass + zero blueprint/compile errors + VLM screenshot verdict** (the hard, novel part — see §15) |

**Consequence:** copy the filmmaker scaffold (agent, service, ledger, schemas,
project tools, status machine, reflector, check), but (a) swap the REST
`*-generate.ts` for a **dedicated Unreal MCP client + a serialization wrapper**,
and (b) make the deliverable gate a **test/inspect/screenshot loop** instead of a
single take on a downloaded file.

### 0.2 Scope decisions (locked with the user)

1. **Dev-time agents only for v1.** We automate *building* a game in the editor.
   **Runtime in-game NPC AI (NVIDIA ACE / LLM NPCs) is DEFERRED** to a separate
   later track (§17). The cheapest entry into that track later is ElevenLabs voice
   (already in our stack), not ACE.
2. **MCP surface, dedicated + flagged.** Unreal MCP is consumed via a dedicated
   `unrealMcpClient` (mirror `n8nMcpClient`), gated by `FEATURE_UNREAL_MCP`,
   isolated from the shared `mcpClient` so a missing/flaky editor can never empty
   another agent's toolset. **Localhost only — never expose** (Unreal MCP has **no
   auth layer**; Epic says do not expose remotely).
3. **Experimental API → discover tools at runtime, do NOT hardcode.** Unreal MCP is
   marked Experimental; tool names/shapes will churn. The agent enumerates the
   server's tools via `unrealMcpClient.getTools()` and reasons over their live
   schemas; our prompt teaches *categories of action*, not a frozen tool list. The
   source gate (researcher) verifies current UE 5.8 / Unreal MCP facts before we
   assert any tool name/path.
4. **Narrowest possible v1 = the "mini gra" slice.** One map, one player, pickups,
   one interactable door, one enemy, one quest, simple UI, **one automation test
   that walks the level**. The point of v1 is to prove the **build + verify loop**,
   not to ship a game.
5. **Cross-domain from v1, but additive.** gamedev DELEGATES to existing domains:
   design (concept/HUD/mockups), writer (narrative/fabuła + devblog), filmmaker
   (trailer/previs), musician (soundtrack + NPC voice), coding (C++/Blueprint/Python
   toolset authoring), automation/n8n (CI/release/Discord/crash-log). See §13.
6. **Branching narrative is FLAG-GATED.** The "deep multi-scenario per step"
   designer the user asked for ships behind `FEATURE_GAMEDEV_BRANCHING`; the base
   loop works without it. See §14.
7. **Meta-agent must be able to DELEGATE to gamedev** (not only direct chat) — §8.

### 0.3 What ports / what must be built

| Layer | How | Notes |
|---|---|---|
| Filmmaker scaffold (agent, service, ledger, schemas, validators, project tools, status machine, reflector entry, check script) | **Adapt** (copy structure) | `game-*` mirrors `film-*`. |
| `unrealMcpClient` (dedicated MCP client + serialization wrapper) | **BUILD (new)** | The `n8nMcpClient` pattern in `mcp.ts`. Replaces the REST `*-generate.ts`. |
| `game-service.ts` / `game-project-tools.ts` (project + level + actors + takes + build/test runs) | **BUILD** (adapt film) | Persists what the editor cannot: project intent, planned blockout, build/test ledger, take verdicts. |
| `game-verify.ts` (test + inspect-errors + screenshot/VLM scorer) | **BUILD (new, the crux)** | The deliverable gate. See §15. |
| Custom Unreal MCP **toolsets** (Python, registered in-editor) | **BUILD via codingAgent** | Epic's Toolset Registry; `codingAgent` writes focused Python tools (`create_basic_level`, `spawn_pickup_item`, `run_gameplay_test`…). |
| Concept/HUD/mockups, 3D meshes, trailer, soundtrack, NPC voice, devblog | **Delegate / reuse** | design / Higgsfield `generate_3d` / filmmaker / musician / writer / content. §13. |
| Branching narrative graph | **BUILD (flag-gated)** as a `writerAgent` capability | §14. |
| Runtime in-game NPC AI (ACE/LLM NPC) | **SKIP v1** | Separate later track. §17. |

---

## 1. Target architecture (mapping)

```
filmmaker domain                  gamedev domain
────────────────────────────────────────────────────────────────────
prompts/film/{domain,pipeline}.md → prompts/game/{domain,pipeline}.md
config/film-schemas/*              → config/game-schemas/* + lib/game-schemas.ts (zod)
tools/film/film-validators.ts      → tools/game/game-validators.ts (spec/blockout/test-plan lint; TS)
tools/film/film-service.ts         → tools/game/game-service.ts (project + level + actors + takes + runs)
tools/film/film-ledger.ts          → tools/game/game-ledger.ts  (build/test run rows)
tools/film/film-project-tools.ts   → tools/game/game-project-tools.ts
tools/film/film-generate.ts (REST) → [INVERTED] src/mastra/mcp.ts: unrealMcpClient (dedicated, flagged)
                                      + tools/game/game-editor.ts (serialization wrapper over MCP tools)
[NEW]                              → tools/game/game-verify.ts (test + inspect + screenshot/VLM scorer)
config/film-surfaces.ts            → config/game-targets.ts (UE version, project root, MCP url, capability map)
agents/film-agent.ts               → agents/game-dev-agent.ts
run_worker(preset:'film')          → run_worker(preset:'gamedev')  (design/plan variants — NEVER editor writes)
researcherAgent source-gate        → SAME (verify UE 5.8 / Unreal MCP API facts; experimental → decays fast)
design_generate_image (reuse)      → SAME (concept/HUD/mockups; + Higgsfield generate_3d for meshes)
```

`gameDevAgent` = chef pattern: `combinePrompts('game/domain','game/pipeline')`,
thread-scoped observational memory, `maxSteps: 150`, `createTokenLimiter(120_000)`,
the full `game_*` native tool stack **plus the dynamically-loaded Unreal MCP
toolset** (from `unrealMcpClient.getTools()`) + `runWorkerTool` + `delegateTaskTool`
+ `requestApprovalTool` + standard system/memory tools. Registered as a **pipeline
agent** so delegations auto-route through `generatePipelineWithReflection`.

### 1.1 Naming (must be internally consistent)

The fallback-chain health lookup (`agentModelKeyForId`) requires the Mastra
`agent.id` to be the **kebab-case** of the `agentModels` key. Mirror filmmaker:

| Thing | Value |
|---|---|
| `agentModels` key / registry key / delegate enum / `PIPELINE_PHASE_TOOLS` key / `AGENT_IDS` | `gameDevAgent` |
| Mastra `Agent.id` | `game-dev-agent` |
| `agent-ids.ts` consts | `GAMEDEV_AGENT_ID='gameDevAgent'`, `GAMEDEV_AGENT_MASTRA_AGENT_ID='game-dev-agent'`, `GAMEDEV_AGENT_ALIASES` |
| Native tool id prefix | `game_*` (e.g. `game_set_project_status`, `game_run_test`) |
| MCP tools | namespaced by the client (e.g. `unreal_*` / server-defined) — **discovered, not authored** |
| Tool export vars | `game*Tool` (e.g. `gameSetProjectStatusTool`) |
| Worker preset | `gamedev` |
| Static check | `check:gamedev-domain` |
| Mongo collections | `gamedev_projects`, `gamedev_build_runs` (reuse `approvals`) |
| Feature flags | `FEATURE_UNREAL_MCP`, `FEATURE_GAMEDEV_BRANCHING` |

### 1.2 Pre-implementation hardening (mandatory — the genuinely hard parts)

These are NOT generic wishlist items; they are the failure modes specific to
driving a live, experimental, single-threaded editor.

1. **Dedicated isolated MCP client + serialization queue.** Add `unrealMcpClient`
   to `src/mastra/mcp.ts` modeled on `n8nMcpClient` (separate `MCPClient`,
   `servers` empty when `FEATURE_UNREAL_MCP !== 'true'`). Because Unreal runs MCP
   calls **serially on the game thread**, `tools/game/game-editor.ts` MUST funnel
   every editor mutation through a single in-process async mutex (one in-flight
   editor call at a time). **Never** `Promise.all` editor writes; **never** let
   `run_worker` issue editor calls.
2. **Runtime tool discovery, fail-soft.** On agent build, if `FEATURE_UNREAL_MCP`
   is off or the editor is unreachable, `getTools()` returns `{}` and the agent
   must still load (design/plan/delegate phases work; editor phases return a clear
   "editor not connected" status, not a crash). Mirror n8n's "falls back to local
   skills only" comment.
3. **Source gate is mandatory before asserting any UE/MCP fact.** Unreal MCP is
   Experimental; model IDs, tool names, default ports, and Toolset Registry APIs
   change. The agent delegates to `researcherAgent` (PSEV) to verify current facts
   and records source URLs/dates — never asserts the tool surface from memory.
4. **Approval + change scope, not spend caps.** There is no per-call \$ cost, but
   there is **state-corruption risk**. First *destructive* editor batch in a
   project (delete actor, overwrite asset, save-all) is **approval-gated** and
   fail-closed (`{ ok:false, error:'approval_required', approvalRequest }`).
   Read/inspect calls are free.
5. **A real deliverable scorer.** The reason our other domains finish is a
   structural completion signal (chef's deliverable-aware scorer,
   finalize-on-deliverable). gamedev's signal = **automation test passes + zero
   blueprint/compile errors + VLM screenshot verdict** (`game-verify.ts`, §15).
   Without this the agent will "talk" instead of converge — this is the single
   highest-risk item; build it in P6, before the full agent.
6. **Step/mutation budget per phase.** Port the automation lesson
   (`GAMEDEV_MAX_EDITOR_MUTATIONS_PER_PHASE`, default ~40) counted from the
   ledger, enforced in `game-editor.ts`, so a confused agent cannot thrash the
   editor. Mark validation/test failures `terminal:true` where re-running is
   futile.
7. **Forbidden-action allowlist.** Mirror the automation domain's "forbidden
   nodes" lesson (a real bug we hit): explicitly deny dangerous editor ops not
   needed for a prototype (project-settings rewrites, source-control ops, plugin
   enable/disable, packaging from the editor agent — packaging belongs to the
   release seam, §13).
8. **Static domain check.** `check:gamedev-domain` early, modeled on
   `check:filmmaker-domain`, so registration drift is caught before any editor
   call.

---

## 2. Model manifest changes (`config/model-manifest.ts`)

> ⚠️ Default = `deepseek-v4-pro` for test economy, BUT every entry is a swappable
> `ModelKey`. `claude-opus-4.8` is the strong candidate for the planner/design role
> (spatial reasoning, encounter design) and for the **VLM take-review** (screenshot
> verdict needs a strong multimodal model). Keep `gameDevAssignments` granular.

### 2a. `agentModels`
```ts
gameDevAgent: 'deepseek-v4-pro' as ModelKey,  // editor director / build planner.
```

### 2b. Worker preset
```ts
// in workerPresets:
gamedev: 'deepseek-v4-pro' as ModelKey,  // PLANNING variants only (blockout/layout/encounter), NEVER editor writes
```
Also update `tools/system/run-worker.ts`: add `'gamedev'` to the `preset`
`z.enum([...])` and `gamedev: 'Level blockout / layout / encounter / test-plan variants (planning only — never editor mutations)'`
to `PRESET_ROLES`. Assert both in `check:gamedev-domain`.

### 2c. Fallback chain
```ts
// in agentFallbackChains:
gameDevAgent: ['deepseek-v4-pro', 'deepseek-v4-flash', 'gemini-2.5-flash'],
// PRODUCTION: ['claude-opus-4.8','claude-sonnet-4.6','gpt-5.5'] — every entry MUST exist
// in config/model-capabilities.ts to be health-checkable.
```

### 2d. New section: gamedev domain assignments
```ts
// SECTION 11: GAMEDEV DOMAIN ASSIGNMENTS
// Every value is a ModelKey from Section 1 → swap freely while testing.
export const gameDevAssignments = {
  director:     'deepseek-v4-pro' as ModelKey,  // phase driver / build planner (check asserts this key)
  designer:     'deepseek-v4-pro' as ModelKey,  // game loop, mechanics, level design (claude-opus-4.8 candidate)
  editorOps:    'deepseek-v4-pro' as ModelKey,  // translates plan → Unreal MCP tool calls
  takeReviewer: 'gpt-image-2'     as ModelKey,  // ★ VLM screenshot verdict — MUST be multimodal (see §15)
  variantWorker:'deepseek-v4-pro' as ModelKey,  // parallel blockout/encounter variants (run_worker preset)
} as const;
```
> NOTE: there is **no remote generation model** to register (the "surface" is the
> local editor). `takeReviewer` MUST be a vision-capable model — confirm capability
> in `config/model-capabilities.ts`.

---

## 3. Schemas (`config/game-schemas/` + `lib/game-schemas.ts`)

JSON Schemas + **zod mirrors** (validated in-process).

| Schema | Drives |
|---|---|
| `game-brief.schema.json` | objective, genre, target slice (mechanics list, win condition), UE version, project root. |
| `level-plan.schema.json` | the planned blockout BEFORE editor work: rooms/areas, spawn points, pickups, doors, enemy patrol, nav requirements, lighting intent. |
| `actor-spec.schema.json` | per-actor intent (type, class/blueprint, transform, params, source asset id) — lineage between *intent* and *what the MCP call created*. |
| `project-state.schema.json` | persisted project (brief, level-plan, actor specs, asset manifest, narrative-graph ref, takes, current_status). |
| `take-review.schema.json` | post-build triage (verdict accept / accept_with_notes / repair / reject, test results, error counts, screenshot verdict, requires_user_confirmation). |
| `build-run.schema.json` | ledger row (run_id, kind: `editor_batch`\|`automation_test`\|`screenshot`, mcp_calls[], result_status, artifacts[], error). |

`lib/game-schemas.ts` exports zod versions + `validateGameBrief()`,
`validateLevelPlan()`, `validateActorSpec()`, `validateGameProjectState()`,
`validateBuildRun()`.

---

## 4. Tool inventory

### 4.1 `unrealMcpClient` — the dedicated MCP surface (`src/mastra/mcp.ts`)

Add to `mcp.ts`, modeled **exactly** on `n8nMcpClient`:

```ts
export const unrealMcpEnabled = process.env.FEATURE_UNREAL_MCP === 'true';

// Dedicated, isolated MCP client for the gameDevAgent only. Separate from the
// shared mcpClient so a missing/crashed Unreal Editor can never empty other
// agents' tools. Unreal MCP is a LOCAL server inside the editor (no auth) — bind
// to localhost only, never expose. When disabled, servers={} and the gamedev
// agent falls back to design/plan/delegate phases only.
export const unrealMcpClient = new MCPClient({
  id: 'unreal-mcp-dedicated',
  timeout: Number(process.env.GAMEDEV_MCP_TIMEOUT_MS ?? 180_000),
  servers: unrealMcpEnabled
    ? { 'unreal': { url: new URL(process.env.UNREAL_MCP_URL ?? 'http://127.0.0.1:8000/mcp') } }
    : {},
});
```
The gamedev agent loads these tools at build time via
`await unrealMcpClient.getTools()` (spread into `tools`). Tool names are
**discovered**, not hardcoded (experimental API).

### 4.2 `game-editor.ts` — serialization + safety wrapper (native)

A thin native layer that the agent uses to *invoke* MCP editor actions safely.
It does **not** reimplement editor logic; it enforces the cross-cutting rules the
raw MCP tools lack:

| Tool id | Purpose |
|---|---|
| `game_editor_status` | probe the editor connection + list available MCP tool names/categories (cached). Returns `connected:false` cleanly when the editor is down. |
| `game_apply_batch` | run an **ordered, serial** batch of editor mutations through the in-process mutex; pre-validates each against `actor-spec`/`level-plan`; checks the forbidden-action allowlist; enforces `GAMEDEV_MAX_EDITOR_MUTATIONS_PER_PHASE`; appends an `editor_batch` ledger row; first destructive batch is approval-gated. |
| `game_inspect` | read-only editor queries (list actors, blueprint errors, scene outline) — never gated. |

Wrap executors in `withToolEnvelope({ toolId, category:'other', risk:'medium', … })`
(real runtime enforcement, not a comment), exactly like `film_generate`.

### 4.3 `game-verify.ts` — the deliverable scorer (NEW, the crux — see §15)

| Tool id | Purpose |
|---|---|
| `game_run_test` | run an Unreal **automation test** via MCP; parse pass/fail; ledger an `automation_test` run. |
| `game_inspect_errors` | aggregate blueprint/compile/log errors into a structured count + list. |
| `game_capture_viewport` | take an in-editor screenshot via MCP → write under `GAMEDEV_OUTPUT_DIR`. |
| `game_review_take` | feed screenshot(s) + test results + error list to the **VLM take-reviewer** (`gameDevAssignments.takeReviewer`) → structured `take-review` verdict. **This is the convergence signal.** |

### 4.4 `game-project-tools.ts` + `game-service.ts` + `game-ledger.ts` (chef store)

Persistent Mongo store keyed by `project_id` (same approach as film-service),
holding the brief + level-plan + actor specs + asset manifest + takes + run
pointers. Tools:

| Tool id | Purpose |
|---|---|
| `game_start_project` | create a project (objective, slice, UE version, project root, default target). |
| `game_get_project` / `game_list_projects` | read state. |
| `game_set_project_status` | **the reflector status tool** (§5). |
| `game_set_level_plan` | store/refine the validated `level-plan` (lint via `game_lint_plan`). |
| `game_upsert_actor_spec` | create/update an actor intent + link it to the MCP-created object id after a batch. |
| `game_set_asset_manifest` | record imported assets (paths, source: design image / `generate_3d` GLB / Fab) for the asset pipeline. |
| `game_record_take` | write a take-review (verdict + test + errors + screenshot); on `accept`, mark the slice done. |
| `game_list_build_runs` | read the ledger. |

Invariants: a rejected take cannot be the deliverable; the accepted take's
test-report + level path is the canonical output; level-plan is immutable once a
take referencing it is accepted (audit trail).

### 4.5 `game-validators.ts` (TS-only)

| Tool id | Purpose |
|---|---|
| `game_lint_plan` | validate `level-plan` / `actor-spec` shape (no placeholders; spawn points reachable in plan graph; budgets sane). |
| `game_check_safety` | forbidden-action gate (project-settings/source-control/plugin/packaging ops blocked for the editor agent; IP/asset-license note). |
| `game_check_build_run` | ledger row vs `build-run` schema. |

### 4.6 Reused / delegated (no new code) — cross-domain seams (§13)
- **Concept art / HUD / UI mockups** → `design_generate_image` (`tools/design/design-tools.ts`).
- **3D meshes for import** → Higgsfield MCP `generate_3d` (image→GLB) → record in `game_set_asset_manifest`.
- **Custom Python toolsets for Unreal MCP** → delegate to `codingAgent`.
- **Source/fact gate** → `delegateTask({ targetAgent:'researcherAgent' })`.
- **Narrative / fabuła / devblog** → `writerAgent` (branching graph = §14, flag-gated).
- **Trailer / previs** → `filmmakerAgent`; **soundtrack / NPC voice** → `musicianAgent`.

---

## 5. Reflector & phases (`config/pipeline-phase-tools.ts`)

Add a `gameDevAgent` entry. `statusTool: 'game_set_project_status'`. Because
`delegate-task.ts` routes any `isPipelineAgent(targetAgent)` through
`generatePipelineWithReflection`, this entry enables in-flight reflection +
per-phase tool channeling — no other wiring needed.

`GAMEDEV_PIPELINE_STATUSES` (export from `game-service.ts`, asserted by the check):
```
intake → design_gate → source_gate → asset_plan → blockout → implement →
test → repair → deliver → done
```

```ts
gameDevAgent: {
  statusTool: 'game_set_project_status',
  alwaysAvailable: [
    ...SHARED_ALWAYS,
    'game_set_project_status', 'game_get_project', 'game_list_projects',
    'game_editor_status', 'game_inspect', 'game_check_safety',
  ],
  phases: {
    intake:      ['game_start_project'],
    design_gate: ['game_set_level_plan', 'game_lint_plan', 'system_run_worker',
                  'system_delegate_task'],                                   // designer + (flag) writer narrative
    source_gate: ['system_delegate_task'],                                   // researcher verifies UE/MCP facts
    asset_plan:  ['game_set_asset_manifest', 'design_generate_image',
                  'system_delegate_task'],                                   // concept/HUD + generate_3d + coding(toolsets)
    blockout:    ['game_upsert_actor_spec', 'game_apply_batch', 'system_request_approval'],
    implement:   ['game_upsert_actor_spec', 'game_apply_batch', 'system_delegate_task',
                  'system_request_approval'],                                // coding agent for C++/Blueprint helpers
    test:        ['game_run_test', 'game_inspect_errors', 'game_capture_viewport', 'game_review_take'],
    repair:      ['game_apply_batch', 'game_lint_plan', 'game_run_test', 'system_run_worker'],
    deliver:     ['game_get_project', 'game_list_build_runs'],
    done:        [],
  },
},
```
Checkpoints with `[]` still return `alwaysAvailable` (fail-open). Remember the
**id→key translation** boundary (snake `id`s here; reflector maps to camelCase via
`buildToolIdToKeyMap`). MCP tool keys are namespaced by the client; the editor
phases reach them through the agent's loaded toolset, not by listing each MCP name
in this map.

---

## 6. Agent file (`agents/game-dev-agent.ts`)

Copy `agents/film-agent.ts` structure; change tool imports, model key, prompts,
and **load the MCP toolset dynamically**.

```ts
import { unrealMcpClient } from '../mcp';

const unrealTools = await unrealMcpClient.getTools().catch(() => ({})); // fail-soft

export const gameDevAgent = new Agent({
  id: 'game-dev-agent',
  name: 'GameDev Agent',
  instructions: await combinePrompts('game/domain', 'game/pipeline'),
  model: resolveModelId(agentModels.gameDevAgent),
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
    gameStartProjectTool, gameGetProjectTool, gameListProjectsTool, gameSetProjectStatusTool,
    gameSetLevelPlanTool, gameUpsertActorSpecTool, gameSetAssetManifestTool, gameRecordTakeTool, gameListBuildRunsTool,
    // editor surface (serialized) + verify (scorer)
    gameEditorStatusTool, gameApplyBatchTool, gameInspectTool,
    gameRunTestTool, gameInspectErrorsTool, gameCaptureViewportTool, gameReviewTakeTool,
    // validators
    gameLintPlanTool, gameCheckSafetyTool, gameCheckBuildRunTool,
    // reused cross-domain
    designGenerateImageTool,
    // system / memory
    runWorkerTool, delegateTaskTool, requestApprovalTool, currentTimeTool,
    memoryRecallTool, memoryWriteTool, addContextTool,
    // ★ dynamically discovered Unreal MCP editor tools (empty when editor offline)
    ...unrealTools,
  },
});
```

---

## 7. Prompts (`prompts/game/`)

- `domain.md` — the gamedev brain: game-director identity; the build+verify loop;
  **"you are a team of executor juniors, the user is technical director"** doctrine;
  safety/forbidden-action doctrine; **categories** of editor action (levels,
  actors, lighting, materials, tests) described as *capabilities to look for in the
  live MCP toolset*, NOT a frozen list; serial-editor rule (one mutation at a time).
- `pipeline.md` — Mastra adapter (mirror `prompts/film/pipeline.md`):
  - **Source gate**: verify UE 5.8 / Unreal MCP facts (tool names, ports, Toolset
    Registry) via `researcherAgent` before asserting; record source dates.
  - **Editor contract**: plan first (`game_set_level_plan`, lint), then apply via
    `game_apply_batch` (serial, validated, approval-gated for destructive ops).
    Never call MCP editor tools directly in parallel.
  - **Verify contract**: a slice is NOT done until `game_run_test` passes,
    `game_inspect_errors` is clean, and `game_review_take` returns `accept`.
  - **Parallelism**: blockout/encounter/test-plan *variants* via
    `run_worker(preset:'gamedev')` — **planning only**, never editor writes.
  - **Cross-domain**: when the task needs concept/HUD → design; meshes →
    `generate_3d`; narrative → writer (branching only if `FEATURE_GAMEDEV_BRANCHING`);
    trailer → filmmaker; music/voice → musician; CI/release → automation. §13.
  - **Delivery defaults**: return level path + automation test report + screenshot +
    build/test ledger summary + any caveats with source dates.

### 7.1 Meta routing prompts (do not skip — designer drifted by doing only one)
Update BOTH `tools/system/delegate-task.ts` (target list + what gamedev does) and
`prompts/meta/base.md` + `prompts/meta/intent-router.md` (when meta picks gamedev).
Routing phrases (PL + EN): "zrób grę / poziom / level", "Unreal / UE5 / Unreal
Engine", "spawnuj aktora", "blockout", "mechanika gry", "test automatyczny w
Unrealu"; "build a game/level", "Unreal Engine", "spawn an actor", "blockout",
"gameplay test". `intent-router.md`: classify concrete editor/build tasks as
`tool_request` / `workflow_orchestration`, not `general_chat`.

---

## 8. Registration & exposure — including META delegation (user requirement)

Mirror filmmaker §8:

1. **`index.ts`** — register `new Mastra({ agents: { …, gameDevAgent } })`.
2. **`config/agent-ids.ts`** — add `GAMEDEV_AGENT_ID='gameDevAgent'`,
   `GAMEDEV_AGENT_MASTRA_AGENT_ID='game-dev-agent'`, `GAMEDEV_AGENT_ALIASES`; add
   both to `canonicalizeRuntimeAgentId` + `agentIdAliases`; add `GAMEDEV_AGENT_ID`
   to `DELEGATION_CALLER_AGENT_IDS` + `DELEGATION_RETURN_AGENT_IDS` (it delegates to
   researcher/design/coding/writer/filmmaker/musician).
3. **`tools/system/delegate-task.ts`** — add `gameDevAgent: 'gameDevAgent'` to
   `AGENT_IDS`; add `'gameDevAgent'` to the `targetAgent` z.enum; add a domain line
   to the `description`; add the recursive self-delegation guard
   (`callerAgentId === GAMEDEV_AGENT_ID && targetAgent === 'gameDevAgent'` →
   blocked); add `case 'gameDevAgent':` to `buildDelegationSuccessCriteria` (e.g.
   "names the built level path + a passing automation test report, OR explains why
   the editor was unreachable; UE/MCP facts are researcher-verified; destructive
   ops were approval-gated"). **No new `execute` branch** — `isPipelineAgent(...)`
   auto-routes once it's in `PIPELINE_PHASE_TOOLS`. ✅
4. **`config/model-capabilities.ts`** — ensure `takeReviewer` (VLM) is registered;
   add production fallback models if you switch the chain.
5. **`prompts/meta/base.md`** + **`prompts/meta/intent-router.md`** — add gamedev
   routing (PL + EN).
6. **Static check** — `check:gamedev-domain` asserts all of the above + the
   `unrealMcpClient` flag wiring + the run-worker enum.

---

## 9. Environment prerequisites (host) — heavier than other domains

Unlike fal/ElevenLabs (just a key), gamedev needs a **running native editor**. This
is a different operational class than our Docker host-network + Cloudflare tunnel
stack: the Unreal Editor runs locally with the plugin enabled, hosting the MCP
server on `127.0.0.1:8000`.

- **Unreal Engine 5.8** installed (Linux: Ubuntu, NVIDIA drivers; the user's
  Ubuntu 24.04 / 64 GB / RTX 5060 Ti 16 GB is comfortably above Epic's
  RTX 2080 / 32 GB minimum). Biggest pain = UE-on-Linux setup + C++ toolchain, not
  compute.
- **Unreal MCP plugin enabled**, editor open, MCP server listening on
  `127.0.0.1:8000/mcp` (localhost only; **no auth — never expose**).
- **Python 3** on host (for authoring custom Toolset Registry tools, via codingAgent).
- **Reused keys** already present: image gen (`GOOGLE_GENERATIVE_AI_API_KEY` /
  `OPENAI_API_KEY`) for concept/HUD; `TAVILY` for researcher; `FAL_KEY` for the
  Higgsfield/`generate_3d` and filmmaker/musician seams.

Add to `.env.example`:
```dotenv
# ── GameDev Agent / Unreal Engine 5.8 (OPTIONAL until the editor is running) ──
FEATURE_UNREAL_MCP=false
UNREAL_MCP_URL=http://127.0.0.1:8000/mcp
GAMEDEV_MCP_TIMEOUT_MS=180000
GAMEDEV_PROJECT_ROOT=                       # absolute path to the .uproject on host
GAMEDEV_OUTPUT_DIR=gamedev-work
GAMEDEV_REQUIRE_APPROVAL=true               # gate first destructive editor batch
GAMEDEV_MAX_EDITOR_MUTATIONS_PER_PHASE=40
GAMEDEV_UE_VERSION=5.8
# ── Branching narrative designer (flag-gated, §14) ───────────────────────────
FEATURE_GAMEDEV_BRANCHING=false
```

---

## 10. Phased implementation plan

- [ ] **P0 · Host bring-up (manual, gated)** — install UE 5.8, enable Unreal MCP,
  confirm the server answers on `127.0.0.1:8000/mcp`, connect a generic MCP client
  (Claude Code) and run ONE editor action by hand. No Mastra code yet. This proves
  the surface exists before we wrap it.
- [ ] **P1 · MCP client + skeleton** — add `unrealMcpClient` to `mcp.ts` (flagged,
  isolated); `prompts/game/{domain,pipeline}.md`; verify `getTools()` returns the
  live tool list when the editor is up and `{}` when down (fail-soft).
- [ ] **P2 · Schemas** — `config/game-schemas/*` + `lib/game-schemas.ts` (zod). `tsc` passes.
- [ ] **P3 · Manifest** — `agentModels.gameDevAgent`, `workerPresets.gamedev`,
  `agentFallbackChains.gameDevAgent`, `gameDevAssignments`, + `run-worker.ts`
  enum/role for `preset:'gamedev'`. `npm run build` passes.
- [ ] **P4 · Validators + store** — `game-validators.ts`; `game-service.ts` +
  `game-project-tools.ts` + `game-ledger.ts` + `GAMEDEV_PIPELINE_STATUSES`.
- [ ] **P5 · Editor wrapper** — `game-editor.ts` (serialization mutex, batch
  validation, forbidden-action allowlist, mutation budget, approval gate,
  `withToolEnvelope`).
- [ ] **P6 · Verify loop (THE CRUX, before the agent)** — `game-verify.ts`
  (`game_run_test`, `game_inspect_errors`, `game_capture_viewport`,
  `game_review_take` with the VLM). Smoke against a trivial scene: prove a verdict
  comes back. **Do not proceed until this converges.**
- [ ] **P7 · Agent** — `agents/game-dev-agent.ts` (chef pattern, dynamic MCP
  toolset) + register in `index.ts`.
- [ ] **P8 · Reflector + exposure** — `pipeline-phase-tools.ts`; `agent-ids.ts`;
  `delegate-task.ts`; `prompts/meta/base.md`; `prompts/meta/intent-router.md`.
  Verify meta→gamedev routes through the reflector.
- [ ] **P9 · Cross-domain seams** — wire design (`design_generate_image`),
  `generate_3d`, coding (toolset authoring), writer (narrative), researcher (source
  gate) into `pipeline.md` (no new state machine). §13.
- [ ] **P10 · Static domain check** — `scripts/check-gamedev-domain.ts` +
  `npm run check:gamedev-domain` (manifest, run-worker enum, agent registration,
  delegate routing, meta prompts, env example, phase map, `unrealMcpClient` flag,
  schema/prompt files, VLM reviewer registered).
- [ ] **P11 · Flag-gated branching narrative** — §14, behind `FEATURE_GAMEDEV_BRANCHING`.
- [ ] **P12 · E2E "mini gra" slice** — §11 acceptance.

### Non-model verification gates (per phase)
- `npx tsc --noEmit` after each code phase; `npm run build` after manifest +
  registration; `npm run check:gamedev-domain` after P8/P10.

### Final real-editor test queue (defer to end; requires UE running)
- [ ] `game_editor_status` reports connected + lists live MCP tools.
- [ ] `game_apply_batch` spawns a floor + a player start + a pickup, **serially**,
  ledgers an `editor_batch`, and the first destructive op triggers approval.
- [ ] `game_run_test` runs a level-walk automation test and parses pass/fail.
- [ ] `game_review_take` returns an `accept`/`repair` verdict from a real screenshot.
- [ ] Meta delegation: `system_delegate_task({targetAgent:'gameDevAgent', …})`
  routes through `generatePipelineWithReflection` with phase channeling.

---

## 11. Acceptance criteria (the "mini gra" slice)

1. One brief → a lint-passing `level-plan` + actor specs.
2. `game_apply_batch` builds: one map, player start, ≥1 pickup, one interactable
   door, one enemy with a patrol, simple UI — all via serial MCP calls, ledgered.
3. `game_run_test` runs an automation test that walks the level; the deliverable
   gate is **test pass + zero blueprint/compile errors + VLM `accept`**.
4. First destructive editor batch is approval-gated; the mutation budget stops a
   thrashing loop.
5. If the editor is offline, the agent degrades gracefully (design/plan/delegate
   work; editor phases report "not connected", no crash).
6. UE/Unreal-MCP facts are researcher-verified before assertion.
7. Meta-agent can DELEGATE a gamedev task (not only direct chat) through the reflector.
8. At least one cross-domain seam demonstrated end-to-end (e.g. design concept →
   `generate_3d` mesh → recorded in asset manifest).

---

## 12. Resolved decisions

- **MCP, not REST** — RESOLVED: Epic ships the surface as MCP, so we consume it via
  a dedicated, flagged, isolated `unrealMcpClient` (`n8nMcpClient` precedent), wrapped
  by a native serialization/state/safety layer. This is the inversion of the
  filmmaker/musician "native tool NOT MCP" rule, justified by who owns the surface.
- **Tool surface discovered at runtime** — RESOLVED: experimental API → never
  hardcode tool names; `getTools()` + researcher source gate.
- **Serial editor, planning-only parallelism** — RESOLVED: single in-flight editor
  mutation (game-thread); `run_worker` for variants only.
- **Deliverable scorer** — RESOLVED: test pass + clean errors + VLM screenshot
  verdict; this is the highest-risk component, built before the agent (P6).
- **Runtime NPC AI (ACE/LLM NPC)** — DEFERRED to a separate track (§17).
- **Branching narrative** — RESOLVED: flag-gated `writerAgent` capability, not a new
  top-level agent (§14).
- **Models** — RESOLVED: default `deepseek-v4-pro`, swappable; `takeReviewer` MUST
  be multimodal.

---

## 13. Cross-domain integration map (the user's actual question)

This is where gamedev becomes more than a build bot: it turns the whole
environment into a **micro game studio** orchestrated by the meta-agent. A "game
project" is a cross-domain GoalContract; gamedev delegates outward via
`system_delegate_task` and tool reuse.

| Seam | Target | What it produces for the game | Notes |
|---|---|---|---|
| **Concept / HUD / UI mockups** | `designAgent` / `design_generate_image` | key art, menu screens, HUD layouts, icon sheets, concept-before-blockout | tool reuse, no agent delegation needed for image gen |
| **3D assets** | Higgsfield MCP `generate_3d` (image→GLB) | meshes from concept images → import into UE; + textures/skyboxes via image gen | a real pipeline: concept → GLB → `game_set_asset_manifest` → editor import |
| **Custom editor tools** | `codingAgent` | focused **Python toolsets** for Unreal's Toolset Registry (`create_basic_level`, `spawn_pickup_item`, `run_gameplay_test`…) + C++/Blueprint helpers | Epic recommends small, focused tool functions — codingAgent authors them |
| **Narrative / fabuła** | `writerAgent` | story bible, quest text, dialogue, lore; **branching graph** when `FEATURE_GAMEDEV_BRANCHING` (§14) | writer already owns canon/continuity authority — perfect fit |
| **Devblog / build-in-public** | `writerAgent` (blog) + `contentAgent` (IG/TikTok/LinkedIn) | progress posts, devlog, social — indie marketing | the user's original idea; high value for indie |
| **Trailer / previs / cutscene animatics** | `filmmakerAgent` (Seedance/Veo) | marketing trailer, previs, cutscene drafts | reuse the full filmmaker loop |
| **Soundtrack / SFX cues** | `musicianAgent` | menu music, ambient loops, combat stingers | fal MiniMax / ElevenLabs Music, already wired |
| **NPC / dialogue voice** | `musicianAgent`/ElevenLabs TTS | voiced dialogue lines (dev-time) | cheapest entry into the runtime-NPC track later (§17) |
| **Source/fact gate** | `researcherAgent` | current UE 5.8 / Unreal MCP facts | mandatory for experimental API |
| **CI / release / community / crash-logs** | `automationArchitect` (n8n) | packaging trigger, itch/Steam upload, Discord bot, crash-log ingest, playtest-feedback forms | packaging stays OUT of the editor agent (forbidden-action list) and IN the release seam |

> **Meta-orchestration framing:** the meta-agent is the "studio producer". A
> request like *"prototype a small horror level and announce it"* fans out:
> design (concept) → gamedev (blockout+implement+test) → musician (ambient) →
> filmmaker (teaser) → writer/content (devblog+posts) → automation (Discord). Each
> domain already exists; gamedev is the missing node.

---

## 14. Flag-gated Narrative Branch Designer (the user's "ścieżki rozwoju" agent)

The user asked for an *additional agent that writes development/progression paths —
deep multi-scenario experiences for each step — toggleable with a flag.*

**Decision: implement as a `writerAgent` capability, not a new top-level agent.**
Rationale: `writerAgent` already owns fiction canon/continuity authority,
anti-slop, and the audit/quality loop (per `writer_agent_implementation_plan.md`).
A standalone agent would duplicate all of that. We add a narrative *mode* +
*worker* + *graph schema*, exposed cleanly enough that it FEELS like a dedicated
capability, and gate the whole thing behind `FEATURE_GAMEDEV_BRANCHING`. (If the
user later wants true process isolation, promote it to `narrativeBranchAgent` using
the same schema — the schema is the contract, so the port is mechanical.)

Components (all behind the flag):
- **`writerAgent` projectType `game_narrative`** — produces a **branching narrative
  graph**: nodes = story/quest steps; edges = player choices; **each node carries N
  scenario variants** ("deep multi-scenario per step"). Reuses writer's canon
  authority so branches never contradict accepted lore.
- **`run_worker(preset:'narrative_branch')`** — parallel generation of the N
  alternative scenario variants per node (this is the legitimate parallelism here —
  variants are independent), each with an anti-convergence anchor.
- **`branch-graph.schema.json`** (in `config/game-schemas/`) — `{ nodes[]: { id,
  step, canon_refs[], variants[]: { id, condition, outcome, consequences[],
  next_node_id } }, entry_node_id }`. zod mirror + a `game_lint_branch_graph`
  validator (no orphan nodes, no dangling edges, every variant reachable, canon
  refs resolve).
- **Consumption by gamedev** — `gameDevAgent` reads the validated graph and wires
  it into UE as quest/dialogue state (via MCP, or via a codingAgent-authored
  Blueprint helper). The graph is the contract between the writer's narrative and
  the editor's implementation.

Wiring when `FEATURE_GAMEDEV_BRANCHING=true`: add the `narrative_branch` worker
preset (manifest + run-worker enum), the `game_narrative` writer mode +
`branch-graph` schema/validator, and a `gamedev → writer` delegation line in
`pipeline.md`'s `design_gate`. When the flag is off, gamedev's narrative need is
served by plain `writerAgent` prose (no graph), and none of the branch machinery
loads. `check:gamedev-domain` asserts the flag toggles the preset/schema cleanly.

---

## 15. The verify/scorer loop (why it is the crux)

Our other domains converge because they have a structural completion signal
(chef's deliverable-aware scorer; the finalize-on-deliverable work). Game artifacts
have no such built-in signal — "is this level good/working?" does not score
itself. Without a real gate, `gameDevAgent` will *describe* work instead of
finishing it (the exact "architect doesn't know when to stop" failure we already
fixed once for automation, but worse here because the deliverable is soft).

The gate (`game-verify.ts`) is a **three-signal AND**:
1. **Automation test passes** (`game_run_test`) — e.g. a level-walk test that spawns
   the player, reaches the goal, confirms the pickup/door/enemy exist. This is the
   objective spine. (Research precedent: AutoUE / SimWorld Studio close the loop
   with compile + physics + VLM feedback.)
2. **Zero blueprint/compile errors** (`game_inspect_errors`) — structural integrity.
3. **VLM screenshot verdict = accept** (`game_capture_viewport` →
   `game_review_take` with a multimodal model) — catches "compiles + passes but
   looks broken" (no lighting, actors underground, empty scene). This is the taste
   gate the automated test cannot express.

`game_review_take` writes a `take-review` row; on `accept` the slice is done
(reflector → `deliver`); on `repair` the agent loops with the specific findings,
bounded by the mutation budget. **Build this in P6, before the agent**, and do not
proceed to P7 until a trivial scene yields a real verdict — it is the single thing
that decides whether the domain is autonomous or just talkative.

---

## 16. Does gamedev have helpers, or work alone?

Same model as chef/filmmaker: orchestrator + standing helpers + on-demand workers.
- **Standing delegations:** `researcherAgent` (source gate), `codingAgent` (Python
  toolsets + C++/Blueprint helpers), `designAgent`/`generate_3d` (assets),
  `writerAgent` (narrative), and the §13 marketing/release seams.
- **Ephemeral `run_worker(preset:'gamedev')`** — parallel **planning** variants
  (blockout, layout, encounter, test-plan) with anti-convergence anchors. **Never**
  editor mutations (game-thread serial).
- **Everything editor-side it does itself** via the serialized `game_apply_batch` /
  `game_inspect` / verify tools over the live MCP toolset.

---

## 17. Runtime in-game NPC AI — DEFERRED (separate track)

The source raises two levels: (1) dev agents that *build* the game — this plan; and
(2) game agents that *live inside* the game as NPCs. Track (2) is **out of scope for
v1** and is a different engineering problem (latency, cost, steerability,
hallucination/safety of NPC behavior, shipping constraints — Unreal MCP toolsets in
cooked/shipping builds must be registered explicitly and lack auth).

When revisited, the cheapest entry is **ElevenLabs voice (already in our stack)** for
voiced/dialogue NPCs, then **NVIDIA ACE Game Agent SDK** (UE5 plugins for ASR/SLM/TTS,
local low-latency, Blueprint/C++ function calling) or a custom local API. Treat it as
a new domain/track with its own plan, not an extension of this one.
```
