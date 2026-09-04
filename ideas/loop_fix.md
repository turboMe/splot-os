# Loop & Timeout Hardening Plan (`loop_fix.md`)

> Status: **IMPLEMENTED** (2026-06-18) — code complete, tsc clean, live E2E pending. See §6.
> Follow-up to the A / B1 / B2 fixes already shipped
> (see `docs/E2E-ORCHESTRATION-FINDINGS.md`). This document covers the THREE new
> root causes surfaced by the live E2E re-run on real agents, in fix order.

---

## What we're fighting with (briefing for a fresh model)

> Read this section first. It is self-contained: it assumes you have NOT seen the prior
> conversation and gives you everything needed to pick up the work cold.

### The system in one paragraph
This is a **Mastra** (TypeScript AI-agent framework) **multi-agent orchestration** stack at
`/projekty/mastra-agentic-environment/agentic-agents`. A top-level `metaAgent` receives a
task, classifies its depth, builds a plan, and **delegates** subtasks either to a domain
**expert agent** (`system_delegate_task` → e.g. `knowledgeAgent`, `researcherAgent`) or to a
generic **blank worker** (`system_run_worker`). Every agent runs through a shared **harness**
gateway (`src/mastra/services/generate-with-harness.ts`) that wraps `agent.generate()` and
adds: a **StrategyReflector** (anomaly detector that intervenes between steps via Mastra
`prepareStep`/`stopWhen`), a **GoalContract** completion scorer, adaptive depth, an
ErrorCollector self-heal cascade, and structured telemetry (`agent_events` in Mongo).

### The core thing we are fighting
**Agent runs that do not converge cleanly** — they either (a) spin in a tool-retry loop, or
(b) run slowly until a hard **300s wall-clock timeout** kills the whole `agent.generate()`.
The harness's stop/convergence machinery only runs **between steps**, so it cannot rescue a
run whose individual steps are simply slow. When the 300s timeout throws, it surfaces as an
`unhandledRejection` ("Harness LLM call timed out after 300s").

### What we already tried (shipped, do NOT redo)
* **A — graceful convergence**: a `converge` reflector signal + `shouldConvergeStop` stopWhen
  predicate that forces a no-tool synthesis when a usable deliverable already exists but the
  run keeps churning. *Correct for the infinite-loop-with-deliverable case, but structurally
  CANNOT catch a slow-step wall-clock timeout (predicate never gets a turn).*
* **B1 — transient-error gating** in `services/error-collector.ts`: LLM timeouts /
  "unrecoverable" reflector stops are classified as transient and do NOT open a
  repo-maintenance coding cascade. **Verified working in the live run.**
* **B2 — dropTools name/key fix**: the reflector's `dropTools` lever now translates runtime
  tool name → registry key and falls back to `forceNoTool` when a tool isn't droppable.

### Why the latest run still failed (the precise mechanism)
1. `callAgentGenerate` wraps the ENTIRE multi-step generate in ONE
   `withTimeout(..., 300_000)` (`generate-with-harness.ts:1142`). Not per-call.
2. Per-step latency was high because **2 cloud model providers were unavailable**
   (`[PeriodicWorkerManager] ALERT: 0 local + 2 cloud model(s) unavailable`) — likely Google
   (Gemini) and/or OpenAI.
3. There is **NO generate-time model fallback**: each agent's model is resolved **statically
   at construction** via `resolveModelId(agentModels.X)`. The availability signal is **pure
   telemetry consumed by nothing**. So a dead/slow model just burns the 300s budget.
4. Amplifier: `knowledgeAgent` looped on the NotebookLM **MCP** tool `notebook_query`,
   passing `notebookId` (camelCase) while the strict MCP schema requires `notebook_id`
   (snake_case, `must NOT have additional properties`). It self-corrected eventually but
   wasted ~6–9 steps.

### Why "another model" is being brought in
The fix touches three independent subsystems (model routing, the AI-SDK tool-call repair
hook, and the reflector's failure accounting). It is not that any single step is impossible —
it is that the **research spike on Mastra's `experimental_repairToolCall` passthrough** and
the **generate-time fallback design** benefit from a second opinion. Everything needed to
execute is specified below with exact file paths and line numbers; treat this as an
implementable spec, not an open-ended investigation.

### Hard constraints (project conventions — obey these)
* **Language**: all code / tooling / prompts in **English**; only user-facing meta-agent
  replies and Polish deliverables are Polish.
* **Single source of truth for models**: `src/mastra/config/model-manifest.ts`. Never
  hardcode a model id elsewhere.
* **Do NOT touch**: WS3 tool-description embeddings (separately owned), `agentic-agents-staging/`,
  or the shipped A/B1/B2 logic.
* **`.env` discipline**: any new flag added to `.env.example` must also be added to `.env`.
* **Feature-flag new behaviour** via `isHarnessFeatureEnabled(name, default)` in
  `config/harness-flags.ts`; default OFF or behaviour-preserving so production is unaffected.
* **Verify with** `bash scripts/with-node.sh npx tsc --noEmit` (must be 0 errors) before any
  E2E. Run E2E LAST, on real agents, pinned to cheap DeepSeek.

### Key files / line anchors
| Concern | File | Anchor |
|---------|------|--------|
| Whole-run 300s timeout | `services/generate-with-harness.ts` | `withTimeout` ~`:1142` |
| Tool-result error parsing | `services/generate-with-harness.ts` | `normalizeToolResult` ~`:1289` (isError ~`:1307`) |
| Reflector signals/levers | `services/strategy-reflector.ts` | `evaluateHistory`, `isUnrecoverable`, `DEFAULT_CONFIG` |
| Model assignments | `config/model-manifest.ts` | `agentModels` ~`:193`, `workerPresets` ~`:256` |
| Availability signal | `services/model-availability.ts` + `periodic-worker-manager.ts` | "model(s) unavailable" alert |
| Circuit breaker (exists, only smart-router) | `services/circuit-breaker.ts`, `services/smart-router.ts` | `isOpen()` ~smart-router `:165` |
| knowledgeAgent prompt seed | `agents/knowledge-agent.ts` | working-memory template ~`:93,97` |
| E2E harness/test | `scripts/observe-meta-orchestration.ts` | drives real `metaAgent.generate()` |

### Manifest change already applied (2026-06-18)
`knowledgeAgent` and `researcherAgent` were switched from `gemini-3.1-flash-lite` to
**`deepseek-v4-flash`** so test runs stay on the cheapest cloud provider that also stayed UP
during the failure. (metaAgent was already on `deepseek-v4-pro`.)

---

## 0. What the test actually was

Script: `src/mastra/scripts/observe-meta-orchestration.ts` — a read-only, multi-domain
DRY-RUN that drives the **real** `metaAgent.generate()`. The task (Polish) has 3 steps:

1. Ask a knowledge/research expert (knowledgeAgent / researcherAgent) for a READ-ONLY
   synthesis of secure-secret-storage best practices in a TypeScript project.
2. A pure-text classification subtask (no tools) — 5 secret-leak spots → 3 categories.
3. Synthesize both into a concise Polish report with a "needs human approval" recommendation.

Hard constraints baked into the prompt: no mutations, and explicitly **do NOT use
automationArchitect or any n8n tool**. The script asserts expected behaviours
(recognition-before-action, LLM plan, expert delegation, blank worker, GoalContract,
review/approval gates) and prints an OBSERVATION REPORT.

### Models exercised by this task (from `config/model-manifest.ts`)

| Role | Agent | Model (alias → id) | Cloud? |
|------|-------|--------------------|--------|
| Orchestrator | `metaAgent` | `deepseek-v4-pro` → `deepseek/deepseek/deepseek-v4-pro` | DeepSeek cloud |
| Expert (step 1) | `knowledgeAgent` | `gemini-3.1-flash-lite` → `google/gemini-3.1-flash-lite` | Google cloud |
| Expert (alt) | `researcherAgent` | `gemini-3.1-flash-lite` | Google cloud |
| Blank worker (step 2) | `system_run_worker` preset | `default`=`qwen3.5-9b` (local), `powerful`=`deepseek-v4-pro`, `cloud`=`deepseek-v4-flash` | mixed |

The live run logged `[PeriodicWorkerManager] ALERT: 0 local + 2 cloud model(s) unavailable`.
The two unavailable cloud providers were almost certainly **Google** (knowledgeAgent's
Gemini) and/or **OpenAI** — `metaAgent` itself is on DeepSeek. That unavailability is the
prime suspect for the slow per-step latency that pushed the run past the 300s wall-clock.

### Testing recommendation: pin everything to cloud DeepSeek

DeepSeek is the cheapest metered provider in the manifest
(`deepseek-v4-flash` = $0.14/$0.28 per 1M; `deepseek-v4-pro` = $0.435/$0.87) and was the
one cloud provider that stayed UP during the failing run. For E2E test runs we want:

* **Cost**: burn credits on the cheapest provider.
* **Determinism**: avoid "model unavailable → 300s hang" muddying the loop signal we're
  actually trying to observe.

Proposed mechanism (small, test-only): an env-gated global model override read at agent
construction / harness model-resolution time, e.g. `TEST_FORCE_MODEL=deepseek-v4-flash`.
When set, every `agentModels.*` resolves to that single DeepSeek model (worker presets too).
Default unset → production manifest unchanged. This pairs naturally with P1 (model
resolution) below and makes test runs both cheap and immune to cross-provider outages.

---

## 1. Root-cause reconstruction (why the run died)

The run did **not** infinitely loop — it was **too slow**, and the budget that killed it is
a single whole-run wall-clock timeout:

* `callAgentGenerate` wraps the ENTIRE multi-step `agent.generate()` in **one**
  `withTimeout(call, timeoutMs=300_000, "Harness LLM call timed out after 300s")`
  (`generate-with-harness.ts:1142`). It is NOT a per-LLM-call timeout.
* `stopWhen` / `convergence_stop` predicates only run **between** steps. If cumulative
  step latency exceeds 300s, the predicates never get a turn → the convergence fix (A)
  is structurally unable to catch this failure mode. (A remains correct for the
  infinite-loop-with-deliverable case it was built for.)
* Per-step latency was inflated because **2 cloud models were unavailable** and there is
  **no generate-time fallback**: each agent's model is resolved **statically at
  construction** (`agents/*.ts` → `resolveModelId(agentModels.X)`); the
  `PeriodicWorkerManager` availability signal is **pure telemetry, consumed by nothing**.
  The circuit-breaker exists but only wires into `smart-router` (coding subtasks), not
  orchestrator agents.
* Amplifier (not the killer): `knowledgeAgent` looped on `notebook_query` because it
  passed `notebookId` (camelCase) while the NotebookLM **MCP** tool schema requires
  `notebook_id` (snake_case) and is strict (`must NOT have additional properties`). The
  agent eventually self-corrected and produced the deliverable — but burned ~6–9 steps.

### Confirmed B1 success (kept for the record)

```
[ErrorCollector] Transient error (Harness LLM call timed out) — NOT escalating to code repair.
[GlobalErrorHandler] Self-healing skipped: ... not escalating to repo-maintenance coding cycle
```

The 300s timeout did NOT trigger the repo-maintenance coding cascade. B1 verified in prod.

---

## 2. The three problems, in fix order

### P3 — knowledge-agent prompt hygiene (cheap, do first)
**Problem**: `agents/knowledge-agent.ts` working-memory template (~lines 93, 97) seeds the
agent's mental model with `notebookId` (camelCase), biasing it to send the wrong arg name
to the snake_case MCP tool.
**Fix**: stop hardcoding `notebookId` in the template; state explicitly that NotebookLM MCP
tools use **snake_case** params (e.g. `notebook_id`) and that the agent must use the exact
param names from the **loaded tool schema**. Belt-and-suspenders; removes the trigger for
this specific agent. ~10 min, zero risk.

### P2a — `experimental_repairToolCall` (systemic cure for the whole class)
**Problem**: any strict-schema tool (especially external MCP) that rejects a guessed arg
name produces an identical retry loop. This will recur wherever agent arg-naming drifts
from a canonical schema.
**Fix**: register a tool-call repair hook at the harness boundary (`callAgentGenerate`
`generateOptions`). When validation fails with
`must have required property 'X'` / `must NOT have additional properties`, deterministically
remap object keys camelCase↔snake_case to satisfy the schema **before** surfacing failure.
One hook kills `notebookId→notebook_id` for **all** tools.
**Research spike (blocking)**: confirm Mastra forwards `experimental_repairToolCall` through
`agent.generate(prompt, options)` (AI SDK v5 supports it; verify Mastra passthrough). If it
does NOT, fall back to a lighter remap in P2b only.

### P2b — validation failure becomes first-class + fast cut (safety net)
**Problem**: a Mastra "Tool input validation failed" may not register as `isError`
(`normalizeToolResult`, `generate-with-harness.ts:1307`), so error-rate signals
(`high_error_rate`, `isUnrecoverable` error path) may never fire — only the raw repetition
ceiling (`maxToolRepetitions*unrecoverableLoopMultiplier = 4*3 = 12`) catches it, far too late.
**Fix**:
1. Count "Tool input validation failed" as `isError` in `normalizeToolResult` so the
   reflector's error-rate machinery sees it.
2. Add a **fast unrecoverable cut**: same `toolName` + same validation-error signature
   ≥ 3× → `isUnrecoverable` returns true (independent of the 12-repetition ceiling), so an
   unrepairable schema wall stops the run quickly instead of burning the step budget.
3. Optionally echo the exact validation-error text into the reflector's `tool_loop` inject
   message so the model is told precisely which param names to use.

### P1 — generate-time model fallback / health gate (dominant cause, biggest piece)
**Problem**: an unavailable/slow model has no escape hatch; the static per-agent model and
the unconsumed availability signal let one dead provider burn the full 300s.
**Fix (core, low-risk — do this first within P1)**: a **pre-flight health gate** in
`callAgentGenerate`. Before calling `generate`, check `model-availability.available` +
circuit-breaker for the agent's resolved model; if it is down, swap `generateOptions.model`
to a healthy fallback from a per-agent (or global orchestrator) fallback chain in the
manifest. Directly fixes the observed "2 cloud models unavailable → 300s hang". Reuses
existing `services/model-availability.ts` + `services/circuit-breaker.ts`.
**Fix (stretch, optional — defer)**: shorter **per-attempt** timeout + retry on a fallback
model for a model that is UP but slow. Tricky: Mastra runs the whole multi-step loop inside
one `generate()`, so mid-loop model swapping isn't possible from outside — a retry re-runs
`generate` on the fallback model with thread/memory carrying prior state. Flag as the main
design question; do not attempt in the first pass.

**Manifest addition needed**: an ordered fallback chain (per-agent or a shared
"orchestrator fallback" list), e.g. `deepseek-v4-pro → deepseek-v4-flash → gemini-2.5-flash-lite`.

---

## 3. Recommended order & rationale

```
P3  →  P2a (+ research spike)  →  P2b  →  P1 (core gate; stretch deferred)  →  docs  →  E2E
```

* Cheap + systemic first (P3, P2): quick wins, fewer wasted steps, lower blast radius.
* P1 last as the "main course": highest impact on the actual timeout, but needs care and
  reuse of the circuit-breaker/availability substrate.
* **E2E pinned to `TEST_FORCE_MODEL=deepseek-v4-flash`** so the validation run is cheap and
  not contaminated by cross-provider outages.

## 4. Honesty caveat

Part of this specific failure was **exhausted credits / provider unavailability**. P1 makes
the system **degrade gracefully** instead of hanging 300s, but if **all** providers are
down there is nothing to fall back to. Check credit balances in parallel with the code work.

## 5. Out of scope / explicitly NOT touched

* WS3 tool-description embeddings (owned by user). The `notebook_query` arg mismatch is a
  **schema** issue (MCP snake_case vs agent camelCase), NOT caused by the WS3 description
  rewrites.
* `agentic-agents-staging/`.
* The shipped A / B1 / B2 logic — these new fixes are additive and target the
  no-deliverable / slow-run paths, distinct from A's convergence (deliverable-present) path.

---

## 6. Implementation status (updated 2026-06-18)

> Status: **IMPLEMENTED** (code complete, `tsc --noEmit` = 0 errors). Live E2E pending —
> run last, pinned to `TEST_FORCE_MODEL=deepseek-v4-flash`.

### P3 — knowledge-agent prompt hygiene ✅ DONE
* `agents/knowledge-agent.ts` working-memory template: added a strict **snake_case MCP
  param** rule + Notebook Aliases / Active Research sections (`notebook_id`, not `notebookId`).
* `prompts/knowledge/notebooklm-agent.md`: new "Parameter names (strict)" section;
  `notebookId` → `notebook_id` in the examples and Response Format.

### P2a — `experimental_repairToolCall` ❌ NOT VIABLE (research spike result)
* **Finding**: Mastra's public `Agent.generate()` does **not forward** an
  `experimental_repairToolCall` option to the underlying AI-SDK call. There is no supported
  passthrough, so the AI-SDK-native tool-call repair hook cannot be wired without patching
  Mastra internals (out of scope / high blast radius). **Pivoted to P2b** per the plan's
  contingency.

### P2b — validation failures as `isError` + fast unrecoverable cut ✅ DONE
* `services/strategy-reflector.ts`: new exported `isValidationFailureResult(result)` matching
  tool-input-validation patterns ("invalid arguments for tool", "must NOT have additional
  properties", "must have required propert…", etc.). In `isUnrecoverable`, a
  `validationFailuresByTool` counter triggers a fast cut at `maxToolRepetitions` (4) — placed
  **before** the raw 12-rep loop ceiling so a tool that keeps failing schema validation is
  killed early, but with enough headroom for in-flight reflection to self-correct.
* `services/generate-with-harness.ts`: `normalizeToolResult` now flags
  `isValidationFailureResult(result)` as `isError` so these surface to the reflector.

### P1 — generate-time model health gate ✅ DONE (core; stretch deferred)
* `config/model-manifest.ts`: `agentModelKeyForId(agentId)` (camelCase key or kebab Mastra
  id), `orchestratorFallbackChain` + per-agent `agentFallbackChains` (only models present in
  `model-capabilities.ts` — `gemini-2.5-flash`, not the unregistered `-flash-lite`),
  `fallbackChainForAgent(agentId)`, and `resolveTestForcedModelId()` (reads `TEST_FORCE_MODEL`).
* `services/model-health-gate.ts` (NEW): `isModelHealthy(modelId)` (registry.available &&
  circuit closed; unknown models assumed available) + `selectHealthyModelId({agentId,
  requestedModelId})` walking the fallback chain; degrades gracefully (returns intended) when
  nothing healthy is found.
* `services/generate-with-harness.ts` `callAgentGenerate`: TEST_FORCE_MODEL override (highest
  precedence) → else `FEATURE_MODEL_HEALTH_GATE` gate (swaps unhealthy model, emits
  `model_health_fallback` telemetry). Timeout/success feed `getCircuitBreaker()` so a slow/dead
  model opens its circuit and future runs route around it.
* `tools/system/run-worker.ts`: worker `modelId` resolution honours `resolveTestForcedModelId()`
  before the preset map.

### Flags / env
* `config/harness-flags.ts`: registered `FEATURE_MODEL_HEALTH_GATE` (default OFF →
  behaviour-preserving).
* `.env` + `.env.example`: added `FEATURE_MODEL_HEALTH_GATE=false` and empty `TEST_FORCE_MODEL=`.

### Remaining
* Live E2E (deferred to user), pinned `TEST_FORCE_MODEL=deepseek-v4-flash`; flip
  `FEATURE_MODEL_HEALTH_GATE=true` to validate the fallback path. Check provider credit
  balances in parallel (§4 caveat).

---

## 7. First observation run + follow-up fix (P2c) — 2026-06-18

First E2E with `TEST_FORCE_MODEL=deepseek-v4-flash FEATURE_MODEL_HEALTH_GATE=true`
(`scripts/observe-meta-orchestration.ts`) surfaced a failure mode the original plan did
NOT target, plus one false alarm.

### Confirmed working
* **P3**: `knowledgeAgent` emitted `notebook_query args={"notebook_id":...}` — snake_case,
  0× `notebookId`.
* **B1**: transient 300s timeout logged `Self-healing skipped … not escalating to
  repo-maintenance` — the coding cascade did NOT fire.

### False alarm (NOT a defect)
* The forced model resolved to `deepseek/deepseek/deepseek-v4-flash` — this is the
  **intended** 3-segment custom-gateway id (`model-manifest.ts` §DEEPSEEK), not a
  double-prefix bug. `resolveTestForcedModelId()` is correct. No change made.

### The real failure → P2c (unproductive / empty-result loop)
`knowledgeAgent` looped on MCP `notebook_query`, querying notebook after notebook and
getting **empty results** (`toolResult: undefined result=""`). It hit the in-flight
`tool_loop` reflection at 3/6/9/12× but the run never stopped and blew the **300s
wall-clock TWICE**. Root cause: empty results are neither `isError`/`isFailureResult`
(so the error-rate path never fired) nor validation failures (so the P2b cut never
fired), and the raw loop ceiling was `maxToolRepetitions(4) × unrecoverableLoopMultiplier(3)
= 12`, which 300s beat.

**Fix (`strategy-reflector.ts`)** — two levers, no new flag (extends the already-shipped
`FEATURE_REFLECTOR_STOP_WHEN` predicate, same as P2b):
1. Lowered `unrecoverableLoopMultiplier` **3 → 2** (raw ceiling 12 → 8). ("lower the
   tool_loop threshold")
2. New `maxUnproductiveLoopRepetitions = 6`: `isUnrecoverable` now counts per-tool
   TRIVIAL (empty/no-op, non-error, non-delegation) results and cuts at 6 — below the raw
   ceiling, giving the in-flight reflection (fires at 4) one nudge+cooldown cycle first.

Unit coverage added in `check-strategy-reflector.ts` (raw ceiling 5→ok/6→cut; trivial-loop
5→ok/6→cut). `tsc` clean, reflector checks pass.

## 8. Second observation run + follow-up fix (P2d) — 2026-06-18

Re-run with the P2c fix surfaced a DIFFERENT loop, this time at the **meta-agent** level:
it called `delegateTaskTool({})` and `runWorkerTool({})` with **empty arguments** (missing
required `targetAgent` / `preset`), Mastra rejected each on input validation, the model
retried — and the run blew the **300s wall-clock** again. (Forced cheap `deepseek-v4-flash`
struggles to emit valid tool-call arguments — the underlying trigger, a model-quality issue.)

Three real defects found (the P2b validation cut from before should have caught this but
did not):

1. **`isValidationFailureResult` boolean bug** — Mastra returns its validation error AS the
   tool result: `{ error: true, message: "Tool input validation failed …", validationErrors }`
   (see `@mastra/core` `validateToolInput`). The detector extracted the message via
   `record.error ?? record.message ?? record.text`; since `error` is the BOOLEAN `true`, the
   `??` chain picked it and the `typeof === 'string'` guard failed, so the real message in
   `record.message` was never inspected → the cut never fired. **Fix**: detect the structural
   marker (`error === true && 'validationErrors' in record`) directly, and pick the first
   STRING-typed field (`message` → string `error` → `text`).
2. **`DELEGATION_TOOLS` name mismatch** — the set held the tool `.id`s
   (`system_delegate_task` / `system_run_worker`) but the reflector sees the tool NAME the LLM
   uses, which is the agent's registration KEY (`delegateTaskTool` / `runWorkerTool`). So
   delegation-failure accounting AND convergence deliverable-detection never matched at
   runtime. **Fix**: include both forms in the set.
3. **Per-tool validation cut splits on alternating tools** — an
   `delegateTaskTool({})`/`runWorkerTool({})` alternation keeps each per-tool counter below
   the threshold. **Fix**: a GLOBAL `totalValidationFailures` cut at `maxToolRepetitions`.

All three in `strategy-reflector.ts`, no new flag (extends `FEATURE_REFLECTOR_STOP_WHEN`).
Unit coverage added (Mastra envelope detection; global cut 4→cut / 3→ok). `tsc` clean,
reflector checks pass. Re-run E2E to confirm the meta validation loop now stops before 300s.

> NOTE (model quality): both observed loops (`notebook_query` empty results, and empty-arg
> delegation) are downstream of the forced cheap `deepseek-v4-flash` producing weak tool
> calls. The reflector cuts now bound the damage (no 300s hang), but a non-forced run on a
> stronger model is the real validation of orchestration quality.

## §9 — P2e: stateful loop-intervention backstop (third E2E loop)

The P2d fixes still did NOT stop the third E2E run — it again hit
`Harness LLM call timed out after 300s`. The log showed the deeper mechanism:

- The forced `deepseek-v4-flash` emitted **malformed tool-call JSON** — AI SDK logged
  `Error converting tool call input to JSON` (the model appended an extra trailing `}`).
  AI SDK then coerced the args to `{}`, Mastra validated `{}`, and validation failed
  (`… Provided arguments: {}`).
- Crucially these malformed calls do **not** reliably normalize into countable tool
  RESULTS: `normalizeSteps` rebuilds history from `response.messages` keyed by
  `toolCallId`, and the reflector's `tool_loop` count stayed pinned at "3x" at every
  trigger (steps 4,6,8,…,16) instead of growing. So NONE of the steps-based
  `isUnrecoverable` cuts (raw ceiling, per-tool/global validation, trivial) ever tripped.
- Meanwhile the in-flight **prepareStep** path detected the loop perfectly — it fired
  `tool_loop` 7 times — but prepareStep can only inject reflections, it cannot stop the run.
  Nothing converted "the reflector kept nudging the same loop" into a hard stop, so the
  model looped freely until the 300s wall-clock timeout.

**Fix (P2e):** add a STATEFUL backstop to `isUnrecoverable`. The reflector is a per-run
singleton shared by both prepareStep and the stopWhen predicate, and `recordIntervention`
already records every fired reflection in `this.triggeredReflections`. So `isUnrecoverable`
now also returns true once it has recorded `maxRepeatedStuckInterventions` (default **3**)
interventions of the SAME *stuck* signal — evaluated FIRST, so it fires even when the
normalized steps are empty/under-counted. At the default 2-step cooldown the 3rd repeat
lands at ≈ step 8 (or later for a signal that only warms up after the GoalContract has data,
like `low_progress`), so the run is cut instead of burning to 300s.

New config field `maxRepeatedStuckInterventions` (DEFAULT_CONFIG = 3), in
`strategy-reflector.ts`; no new flag (extends `FEATURE_REFLECTOR_STOP_WHEN`). Unit coverage
added (3 recorded `tool_loop`/`low_progress` interventions → unrecoverable even with empty
steps; 2 → ok; a steering signal like `wrong_tool` does NOT count). `tsc` clean, reflector
checks pass.

### §9.1 — generalized after a 4th E2E loop on a DIFFERENT signal

The first P2e cut only counted `tool_loop`. A 4th forced-flash run then looped on
`low_progress` instead (flat-progress churn at steps 16,18,20,22,24,26 → 300s timeout) —
the model found a *different* way to fail. This is the decisive evidence that the forced
cheap `deepseek-v4-flash` is the ROOT TRIGGER: each run it fails differently (malformed
tool-call JSON → `tool_loop`, or flat progress → `low_progress`), and the reflector's soft
nudges can't rescue a model too weak to recover. So P2e was generalized to a `STUCK_SIGNALS`
set (`tool_loop`, `low_progress`, `high_error_rate`, `delegation_failures`) — steering
signals (`wrong_tool`, `scope_creep`, `low_confidence`) are deliberately excluded so a
healthy run that self-corrects a few times is not cut. Validation of orchestration QUALITY
(not just damage-bounding) requires re-running on a stronger non-forced model
(`TEST_FORCE_MODEL=deepseek-v4-pro`, which is also the metaAgent's real default).
