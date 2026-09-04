# Cognitive Loop — Planning + Strategy Reflector + Adaptive Depth

> **Phases:** 1-4 — in progress, updated 2026-06-17  
> **Status:** Phase 1 complete; Phase 2 has an in-flight `prepareStep` actuator (Reflektor Part 1) plus Part 2 §2.1–2.7 — GoalContract-aware triggers, structural failure detection, per-signal cooldown, hard levers, `stopWhen` give-up/escalate, and native `isTaskComplete` output scoring (all flags default ON). **Part 2 complete.** **Part 3 complete** — pipeline-mode reflector (per-phase, soft-levers-only) + per-phase `activeTools` allowlists for chef/content/hunt and the automation Golden Path (`FEATURE_PIPELINE_REFLECTOR`, `FEATURE_PIPELINE_PHASE_TOOLS`, both default ON). Phases 3-4 remain partial runtime integrations.

## Overview

The Cognitive Loop is a mandatory reasoning protocol that forces agents to:
1. **Plan** before executing (explicit steps + success criteria)
2. **Reflect** after each tool result (compare against plan)
3. **Self-check** before responding (verify completeness and accuracy)

This replaces the previous "show your plan in one sentence, then execute" instruction with a structured decision-making protocol inspired by state-of-the-art agentic architectures (ChatGPT, Claude Opus).

## Architecture

```
User message
     ↓
  ┌─────────┐
  │  PLAN   │  Restate goal → steps → risks → agents → success criteria
  └────┬────┘
       ↓
  ┌──────────┐
  │ EXECUTE  │  Call tool / delegate to agent
  └────┬─────┘
       ↓
  ┌───────────┐
  │ REFLECTOR │  Goal check → hypothesis → direction → evidence → routing → risk
  └────┬──────┘
       ↓
  On track? ──Yes──→ Next step
       │
       No
       ↓
  ┌──────────┐
  │ RE-PLAN  │  Adjust steps, change agents, escalate if needed
  └────┬─────┘
       ↓
  Continue execution...
       ↓
  ┌─────────────┐
  │ SELF-CHECK  │  Answer matches question? Plan complete? Facts verified?
  └──────┬──────┘
         ↓
  Final response to user
```

## Implementation per Agent

### Meta Agent (`prompts/meta/base.md`)

Three new prompt sections added:

| Section | Purpose | Trigger |
|---|---|---|
| **Task Planning** | Explicit plan with steps, risks, criteria | Before any non-trivial execution |
| **Strategy Reflector** | 6-point validation after each tool result | After EVERY tool call |
| **Output Self-Check** | 5-point verification before responding | Before final response |

**Auto-escalation rules:** The meta-agent is instructed to route to `deliberationAgent` when:
- Direction changed 2+ times in same task
- Tool results contradict each other
- Confidence drops below "medium"
- Task scope expanded significantly

**Post-test synthesis guard:** The meta-agent must account for every delegated result before final synthesis. `success:false`, `status:error`, or an error field is treated as partial failure even when the returned text is useful evidence. For audit/dry-run reports, the final response must include the full report now; it must not stop at a transition such as "let's now prepare the report".

### Coding Agent (`prompts/coding/base.md`)

Two new prompt sections adapted for code orchestration:

| Section | Purpose | Adaptation |
|---|---|---|
| **Task Planning** | Plan files to read/edit/test, choose subagents | Max 7 steps, `tsc` as done criteria |
| **Strategy Reflector** | Quality + cross-step impact checks | Focuses on compile errors, regressions |

**Escalation:** After 2 retries → escalate to Meta Agent with diagnostics.

### Automation Architect (`prompts/automation/base.md`)

One section adapted for the Golden Path workflow:

| Section | Purpose | Adaptation |
|---|---|---|
| **Strategy Reflector** | Validation, risk, credential, repair-loop checks | Aligned with Golden Path stages |

**Key rule:** Same repair with same input 2x → stop, report `manual_review_required`.

## Planning Exception

Trivial tasks skip the planning step entirely:
- Single tool lookups
- Direct answers from memory
- Read-only analysis
- Casual conversation

## Reflector Decision Matrix

| Signal State | Action |
|---|---|
| All green | Continue with plan |
| 1-2 yellow | Adjust plan, note the change |
| Any red | STOP → Re-plan → Explain to user |
| Critical divergence | Escalate to deliberationAgent |

## Phase 2: Runtime Strategy Reflector (Runtime Repair Added 2026-06-05; In-Flight `prepareStep` Added 2026-06-17)

The `StrategyReflector` is a programmatic runtime hook that monitors agent execution step-by-step and detects anomalous patterns. It operates independently of prompt compliance.

There are now **two runtime modes**, selected by the `FEATURE_REFLECTOR_PREPARE_STEP` flag (default **ON**):

- **In-flight mode (flag ON — Reflektor Part 1):** the reflector runs as a Mastra `prepareStep` actuator BEFORE each step. On an anomaly it injects the reflection as a system message and narrows the action space for the NEXT step (drops the looping tool from `activeTools`, or forces `toolChoice:'none'` to re-plan). The correction reaches the model *in-flight*, before the next action — not post-hoc. Because the run self-corrects in-flight, the post-hoc repair pass is intentionally skipped.
- **Post-hoc mode (flag OFF — legacy):** `analyzeStep` accumulates signals from `onStepFinish` and, after the initial generation completes, a controlled no-tool reflection repair pass (`maxSteps=1`, `toolChoice=none`) rewrites the final prose. This cannot change tool selection mid-loop — only the final text.

### Architecture — In-flight mode (flag ON)

```
prepareStep({ steps, stepNumber, systemMessages, state })   ← runs BEFORE each step
     ↓
 normalizeSteps(steps) → reflector.evaluateHistory()         ← stateless, recomputes from full history
     ↓
 decision.action === 'inject_reflection' ?
     ↓ (yes)
 budget check (maxReflectionsPerRun) + cooldown (state.lastInterventionStep, 2 steps)
     ↓
 reflector.recordIntervention()                              ← keeps getTriggeredReflections() populated
     ↓
 ┌─ Apply intervention levers ──────────────────────────────┐
 │  injectSystem  → systemMessages = [...existing, reflection]│ (read+append, preserves base instructions)
 │  dropTools     → activeTools = universe − [loopTool]       │ (never empty; deadlock guard)
 │  forceNoTool   → toolChoice = 'none'                       │ (re-plan in text, no action)
 └───────────────────────────────────────────────────────────┘
     ↓
 logHarnessEvent('reflector_intervention')  → return overrides to the loop
```

`onStepFinish` still runs for tool-envelope logging + goal evidence, but `analyzeStep` is **gated off** when the flag is ON (the in-flight `evaluateHistory` path owns signal evaluation + counting, so signals are never counted twice).

> **Implementation note — where tool calls live in `prepareStep`.** Inside the `prepareStep` processor each `StepResult`'s convenience getters (`step.toolCalls` / `step.toolResults` / `step.content`) are **empty**; the authoritative record is in `step.response.messages[]` as `tool-call` (assistant) and `tool-result` (tool) content parts. `normalizeSteps` therefore reads `response.messages`, dedupes by `toolCallId` (later steps re-include earlier messages), and rebuilds one history entry per unique tool call. It keeps a fallback to top-level `step.toolCalls` for the `onStepFinish` shape / future Mastra versions. This was verified by the deterministic E2E `npm run e2e:reflector-prepare-step`.

### Architecture — Post-hoc mode (flag OFF)

```
onStepFinish(stepResult)
     ↓
 Normalize tool calls/results
     ↓
 StrategyReflector.analyzeStep()
     ↓
 ┌─ Accumulate signals ──────────────────────┐
 │  - Count tool calls (total / failed)      │
 │  - Track direction changes (delegation)   │
 │  - Detect tool call loops                 │
 │  - Monitor delegation failures            │
 │  - Scan for low-confidence keywords       │
 │  - Estimate minimal scope creep           │
 └───────────────────────────────────────────┘
     ↓
 ┌─ Check thresholds ───────────────────────┐
 │  error_rate > 50%  → inject_reflection   │
 │  tool called 4x    → inject_reflection   │
 │  direction changes > 3 → inject_reflection│
 │  delegation failures > 2 → inject_reflect│
 │  low confidence    → inject_reflection   │
 │  scope creep       → inject_reflection   │
 │  step > 20         → inject_reflection   │
 └───────────────────────────────────────────┘
     ↓
 Log to agent_events
     ↓
 If any reflection was triggered and repair is enabled:
 run no-tool reflection repair pass (maxSteps=1, toolChoice=none)
```

### Signals Monitored

| Signal | Threshold | Meaning |
|---|---|---|
| `high_error_rate` | > 50% tool calls fail | Agent is using wrong tools or arguments |
| `tool_loop` | Same tool called 4+ times | Possible infinite loop |
| `direction_instability` | 3+ delegation target changes | Agent is oscillating |
| `delegation_failures` | 2+ sub-agent failures | Sub-agents struggling |
| `low_confidence` | Low-confidence language after tool use | Agent is unsure after observing evidence |
| `scope_creep` | Tool/delegation args expand far beyond original prompt | Task may be drifting |
| `low_progress` | 20+ steps without result | Agent may be stuck |
| `wrong_tool` *(Part 2 §2.2)* | A tool keeps "succeeding" (no error) but returns trivial/empty results ≥2× | Model pushes an inadequate tool instead of changing approach |
| `progress_stall` *(Part 2 §2.1)* | GoalContract progress flat (Δ ≤ 0.01) over K samples despite low-error tool activity | Productive-looking but not advancing the goal |

> **Part 2 §2.1/2.2 — GoalContract-aware triggers** (`FEATURE_REFLECTOR_GOAL_TRIGGERS`, default ON, only active when the run has a `goalContractId`). `progress_stall`/`wrong_tool` are passed `goalTriggersEnabled` + a per-step `progressSamples` series via `EvaluateContext` (the reflector stays pure/flag-free; the harness reads the flag). Goal progress is sampled before each step from `getGoalContract` and now moves granularly mid-run (`goal-tracker.recalculateProgress` blends step ratio with a saturating evidence proxy), so a flat delta is a real stall signal rather than noise.

### Safety Features

- **Warmup:** No reflections during first 3 steps (let agent establish context)
- **Max reflections:** 5 per run (prevent reflection loops); enforced in both modes (`isReflectionBudgetExhausted()`)
- **Per-signal cooldown (in-flight, Part 2 §2.4):** `interventionCooldownSteps = 2` — the SAME signal waits ≥2 steps before re-firing (hysteresis: gives the model room to regenerate), but a DIFFERENT, higher-priority signal may still intervene on the next step. Tracked via `lastInterventionStepBySignal` + `isSignalInCooldown(signal, stepNumber)`; replaces the prior single global step-gap lock.
- **Non-empty allowlist (in-flight):** `dropTools`/`restrictTools` never produce an empty `activeTools`; full toolset returns after the cooldown
- **Hard levers high-confidence only (Part 2 §2.5):** `escalateModel`/`forceTool`/`restrictTools` only layer on when far past threshold (e.g. loop ≥2× `maxToolRepetitions`, delegation failures ≥2×) AND `FEATURE_REFLECTOR_HARD_LEVERS` is ON; soft levers (`injectSystem`/`dropTools`/`forceNoTool`) are always preferred first. `escalateModel` is a no-op unless `REFLECTOR_ESCALATION_MODEL` is set.
- **Structural failure detection (Part 2 §2.3):** the unified, exported `isFailureResult` checks structured fields first (`isError`/`success:false`/`status:'error'|'failed'`/`error!=null`/`type` starting `error`) before any bounded JSON-string heuristic, so prose like "failedSteps: 0", "no errors", "error handling" no longer mis-fires as a failure.
- **Non-fatal:** All reflector errors are caught (`prepareStep`/`stopWhen` return safe defaults on any error); execution never interrupted
- **Run-scoped:** Each run gets independent signal tracking; cleanup on completion
- **No-tool repair:** The post-hoc repair pass is capped at `maxSteps=1` and `toolChoice=none`
- **Feature gates:** `FEATURE_REFLECTOR_PREPARE_STEP` (in-flight actuator), `FEATURE_REFLECTOR_GOAL_TRIGGERS` (§2.1/2.2 signals), `FEATURE_REFLECTOR_HARD_LEVERS` (§2.5 hard levers), `FEATURE_REFLECTOR_STOP_WHEN` (§2.6 give-up + escalate), `FEATURE_OUTPUT_SCORING` (§2.7 native `isTaskComplete`), `FEATURE_PIPELINE_REFLECTOR` (Part 3 pipeline mode), `FEATURE_PIPELINE_PHASE_TOOLS` (Part 3 per-phase `activeTools`) — all default ON; `FEATURE_REFLECTION_REPAIR_PASS` controls the post-hoc repair pass (auto-skipped when the in-flight flag is ON)

### Knowing when to give up: `stopWhen` (Part 2 §2.6)

The harness wires a custom `stopWhen` (`FEATURE_REFLECTOR_STOP_WHEN`, default ON) backed by the stateless `reflector.isUnrecoverable(steps)` predicate. It ends the run early — with an explicit blocker note appended to the response text and a `reflector_stop_when` event — when the trajectory is unrecoverable, instead of burning the rest of the step budget to feign success. `isUnrecoverable` is conservative (far past the normal reflection thresholds): a catastrophic loop (≥ `maxToolRepetitions × 3`), a sustained ≥0.8 error rate over ≥6 calls, or delegation failures ≥ `maxDelegationFailures × 3`.

> **Mastra 1.32 quirk — `maxSteps` and a custom `stopWhen` are mutually exclusive.** In Mastra's loop, when `maxSteps` is a number it is converted to `stepCountIs(maxSteps)` and *replaces* any user `stopWhen`. To keep BOTH the step-count backstop AND the unrecoverable predicate, the harness drops `maxSteps` (when stopWhen is enabled) and passes `stopWhen` as an OR-array `[stepCountIs(stepCeiling), isUnrecoverablePredicate]`. `stepCountIs` is imported from the `ai` package (not `@mastra/core`). Verified by `npm run e2e:reflector-stop-when`.

### Knowing when it is actually done: native output scoring (Part 2 §2.7)

When the run carries a `goalContractId`, the harness attaches a native Mastra `isTaskComplete` config (`FEATURE_OUTPUT_SCORING`, default ON) built from `createGoalCompletionScorer(goalContractId)` (`src/mastra/scorers/goal-completion-scorer.ts`). After each iteration Mastra runs the scorer; while it returns `0` (GoalContract `evaluateCompletion().passed === false`) Mastra auto-injects feedback and **re-iterates**, and finalizes once it returns `1`. The whole loop stays bounded by the `stopWhen`/step-count ceiling, so a never-completing contract can never run away. The scorer is deterministic (0/1 mapping straight from `evaluateCompletion`) and **fail-open** — it returns `1` on any evaluation error so a Mongo/contract glitch can never trap a run in an infinite feedback loop. `onComplete` emits an `output_score` event. The scorer is built per-run via a factory closure because Mastra's `CompletionContext` does not reliably carry our contract id. Note: `CompletionConfig` in Mastra 1.32 has **no `maxIterations` field** — the iteration bound comes solely from `stopWhen`/`maxSteps`.

### Pipeline-mode reflector + per-phase tools (Part 3 — chef/content/hunt + automation)

Deterministic, long-running state-machine agents (chef / content / hunt) run via a bare `agent.generate` with `maxSteps: 150` on their own `defaultOptions`. They deliberately **do not** go through the coding/automation harness — its depth controller caps `maxSteps ≤ 40` and layers GoalContract gates that would derail a 150-step pipeline. Part 3 instead wraps them in `generatePipelineWithReflection` (`src/mastra/services/generate-pipeline-with-reflection.ts`), routed from `delegate-task.ts` behind `FEATURE_PIPELINE_REFLECTOR`. The wrapper adds **only** `prepareStep` (reflection + per-phase tool channeling) and light telemetry — no depth controller, `maxSteps` override, `stopWhen`, GoalContract triggers, or hard levers.

**Pipeline mode never fights the state machine.** `EvaluateContext.pipelineMode` (§3.3B in `strategy-reflector.ts`) narrows the active signal set drastically:
- **Disabled:** `low_progress` (150 steps is normal), `direction_instability` (direction is dictated by the state machine), `scope_creep`, `low_confidence`, `progress_stall` (no GoalContract in pipelines).
- **Enabled, counted PER PHASE:** `tool_loop`, `high_error_rate`, and `wrong_tool` (the main signal — "wrong tool for this phase"). Signals are windowed to the steps since the last `*_set_*_status` transition (`pipelinePhaseBoundary`), so a bad early phase never poisons a later healthy one. Warmup is measured against the per-phase window, not the whole run.
- **Soft levers only:** `injectSystem` + `dropTools`. `forceNoTool`, `escalateModel`, `forceTool`, and `restrictTools` are stripped via `toPipelineIntervention`.

**Per-phase `activeTools` allowlists (§3.4/3.5, `pipeline-phase-tools.ts`, `FEATURE_PIPELINE_PHASE_TOOLS`)** are the strongest lever: instead of detecting a wrong tool *after* the fact, the harness surfaces only that phase's tools for the next step. The map is **fail-open** — unknown agent / phase / empty allowlist → `null` (no restriction, never block) — and **permissive**: an `alwaysAvailable` superset (status, getters, document, memory, knowledge, approval) is unioned into every phase so the agent can always inspect state and advance (`*_set_*_status`). For chef/content/hunt the current phase is detected from step history; for the automation architect (which already runs through the harness) the Golden Path phase comes straight from `input.phase` and `resolvePhaseTools('automationArchitect', phase)` channels each phase (e.g. `validate` cannot reach `architect_deploy_automation`; the free-form `chat` phase is unmapped → fail-open). The Phase-Exit Check (Warstwa A) lives in the chef/content/hunt prompts and works with no flag at all.

**⚠️ Naming boundary (`id` vs registry key).** The phase maps in `pipeline-phase-tools.ts` are authored in registered tool **`id`s** (`chef_set_project_status`) for readability, but Mastra's step history, `activeTools`, and the model's tool registry all key on the tool **object KEY** — the camelCase export-variable name (`chefSetProjectStatusTool`, what `agent.listTools()` returns). The two differ. Every value crossing into `prepareStep` (status-tool match for phase detection, `activeTools` allowlist, reflector `phaseTools` hint) is therefore translated `id → key` via `buildToolIdToKeyMap(await agent.listTools())` + `translateToolIdsToKeys(ids, idToKey)` (both fail-open: `null`/zero-matches → `null` = no restriction). Skipping this translation makes phase detection silently return `null` forever — the feature degrades to a no-op (this is exactly what the first live run exhibited: a successful chef run with zero `pipeline_*` telemetry).

**⚠️ AI SDK v5 arg/result extraction.** `normalizeSteps` (`generate-with-harness.ts`) reconstructs step history for the reflector. Its **fallback path** (top-level `step.toolCalls`) must read v5's `input`/`output` fields, not just legacy `args`/`result` — AI SDK v5 carries tool-call arguments under `input` and results under `output`/`output.value`. When `normalizeToolCall` read only `args`, a v5-shaped step produced empty args (`{}`), so `args.status` was `undefined` and phase detection went blind. Combined with ObservationalMemory compacting the in-context message window mid-run, this is what made the SNAPS live run emit only the *first* `pipeline_phase_transition` (`recon`) despite advancing all the way to `done`: after the first window compaction every later status call lost its args → `currentPhase` collapsed to `null` → `activeTools` fail-opened (interventions logged `phase:null`, `dropTools` became a no-op). Three defenses now stack: (1) `normalizeToolCall`/`normalizeToolResult` read `input`/`output`; (2) `detectCurrentPhase` + `pipelinePhaseBoundary` fall back to the status tool's returned `{ status }` and keep scanning past indeterminate calls instead of bailing to `null`; (3) the wrapper keeps a **sticky** last-known phase so a transiently trimmed window never silently disables channeling.

`npm run check:pipeline-reflector` covers all of this deterministically (phase windowing, soft-levers-only, disabled global signals, fail-open allowlists, automation Golden Path channeling, **id→key translation**, **v5 `input`/`output` extraction**, **result-fallback phase detection**).

### Files

- `src/mastra/services/strategy-reflector.ts` — Core reflector service
- `src/mastra/services/generate-with-harness.ts` — Integration hook
- `src/mastra/services/harness-events.ts` — Event types
- `src/mastra/lib/agent-event-log.ts` — Event registry
- `src/mastra/services/goal-tracker.ts` — GoalContract progress (granular `recalculateProgress` for `progress_stall`)
- `src/mastra/scorers/goal-completion-scorer.ts` — `createGoalCompletionScorer` factory: deterministic, fail-open 0/1 scorer wired into native `isTaskComplete` (§2.7)
- `src/mastra/scripts/check-strategy-reflector.ts` — Signal regression checks (incl. `evaluateHistory` + lever mapping, §2.1–2.6: isFailureResult, cooldown, wrong_tool, progress_stall, hard levers, isUnrecoverable)
- `src/mastra/scripts/check-goal-completion-scorer.ts` — Mongo-gated unit check: incomplete contract → score 0, completed contract → score 1 (§2.7)
- `src/mastra/scripts/e2e-reflector-prepare-step.ts` — Deterministic E2E: real `agent.generate()` loop honors the in-flight `prepareStep` `activeTools` override
- `src/mastra/scripts/e2e-reflector-stop-when.ts` — Deterministic E2E: real `agent.generate()` loop honors the custom `stopWhen` (§2.6) and halts an unrecoverable run early
- `src/mastra/scripts/e2e-reflector-output-scoring.ts` — Mongo-gated E2E: real `agent.generate()` loop runs `isTaskComplete`, re-iterates while the scorer returns 0, finalizes when it returns 1 (§2.7)
- `src/mastra/services/generate-pipeline-with-reflection.ts` — Part 3 lightweight pipeline wrapper: `prepareStep` (pipeline-mode reflector + per-phase `activeTools`) + telemetry around bare `agent.generate`, **no** depth controller / `maxSteps` override / `stopWhen` (chef/content/hunt keep their own 150-step `defaultOptions`)
- `src/mastra/config/pipeline-phase-tools.ts` — Part 3 per-phase tool maps (chef/content/hunt status-tool-driven + automation Golden Path); fail-open `resolvePhaseTools`, `getStatusToolName`, `isPipelineAgent`, plus the `id → key` boundary helpers `buildToolIdToKeyMap` / `translateToolIdsToKeys`
- `src/mastra/scripts/check-pipeline-reflector.ts` — Part 3 regression checks: phase detection/windowing, per-phase `high_error_rate`/`wrong_tool`, soft-levers-only, disabled global signals, fail-open allowlists, automation Golden Path channeling

### Telemetry Events

| Event | When | Data |
|---|---|---|
| `reflector_triggered` | Threshold exceeded | signal, reason, snapshot |
| `reflector_intervention` | In-flight `prepareStep` applies a lever | signal, reason, stepNumber, appliedLevers, droppedTools, forcedTool, escalatedModel |
| `reflector_stop_when` *(Part 2 §2.6)* | `stopWhen` declares the trajectory unrecoverable → run ends early | reason (blocker), stepCount |
| `output_score` *(Part 2 §2.7)* | Native `isTaskComplete` scorer evaluates an iteration's output via `onComplete` | goalContractId, complete, completionReason, scorerCount |
| `pipeline_phase_transition` *(Part 3)* | Pipeline wrapper detects a new phase from the last `*_set_*_status` call | phase, stepNumber |
| `pipeline_phase_tools_applied` *(Part 3 §3.4/3.5)* | A per-phase `activeTools` allowlist is applied for a step | phase, toolCount |
| `pipeline_reflector_intervention` *(Part 3 §3.3B)* | Pipeline-mode reflector applies a soft lever inside a phase | signal, reason, phase, stepNumber, appliedLevers, droppedTools |
| `reflector_snapshot` | Run completion | Full signal snapshot for the run |
| `reflection_repair_started` | Post-hoc repair pass begins | triggering signals |
| `reflection_repair_completed` | Post-hoc repair pass returns usable text | triggering signals |
| `reflection_repair_failed` | Post-hoc repair pass errors | triggering signals, error |

### Current Limits

With `FEATURE_REFLECTOR_PREPARE_STEP` ON, the reflector achieves dynamic mid-loop re-planning: it injects a system reflection and reshapes `activeTools`/`toolChoice` for the next step *before* the model acts. **Reflektor Part 2 is complete:** GoalContract-aware triggers (`progress_stall`/`wrong_tool`, §2.1/2.2), structural `isFailureResult` that no longer mis-fires on prose (§2.3), per-signal cooldown/hysteresis (§2.4), high-confidence hard levers (`escalateModel`/`forceTool`/`restrictTools`, §2.5), `stopWhen` give-up + escalate (§2.6), and native `isTaskComplete` output scoring that re-iterates until the GoalContract is satisfied (§2.7, `FEATURE_OUTPUT_SCORING` + `goal-completion-scorer.ts`). **Reflektor Part 3 is also complete:** chef/content/hunt run through `generatePipelineWithReflection` (pipeline-mode, per-phase, soft-levers-only) and per-phase `activeTools` allowlists channel chef/content/hunt + the automation Golden Path (`FEATURE_PIPELINE_REFLECTOR` / `FEATURE_PIPELINE_PHASE_TOOLS`, both default ON, fail-open by construction).

Signal regression checks are available through `npm run check:strategy-reflector` (tool loops, high error rate, direction instability, delegation failures, low-confidence text, max-reflection guard, the stateless `evaluateHistory` lever mapping, and Part 2 §2.1–2.6: structural `isFailureResult`, per-signal cooldown, `wrong_tool`, `progress_stall`, hard levers, `isUnrecoverable`); `npm run check:goal-completion-scorer` validates the §2.7 0/1 scorer mapping (incomplete→0, complete→1). Three deterministic E2Es exercise the real Mastra loop: `npm run e2e:reflector-prepare-step` (in-flight `activeTools` override), `npm run e2e:reflector-stop-when` (early stop on an unrecoverable run), and `npm run e2e:reflector-output-scoring` (native `isTaskComplete` re-iterates while incomplete then finalizes). Part 3 adds `npm run check:pipeline-reflector` (pipeline-mode windowing, soft-levers-only, disabled global signals, fail-open per-phase allowlists, automation Golden Path channeling).

## Phase 3: Goal-Aware Execution (Harness Integration Added 2026-06-05)

The `GoalTracker` persists GoalContracts to MongoDB, enabling objective tracking of task progress, plan revisions, and evidence accumulation across agent runs.

Current status: the service exists and `system_delegate_task` creates an awaited GoalContract, records delegation evidence, and returns `goalContractId`. Harness calls can now receive that ID, record tool-result evidence from `onStepFinish`, inject GoalContract state through context assembly, and run deterministic completion evaluation.

Async delegations also carry `goalContractId` and complete the originating contract when the background result succeeds or fails.

### GoalContract Schema

```typescript
interface GoalContract {
  contractId: string;        // Unique ID
  taskId: string;            // Parent task/delegation
  agentId: string;           // Responsible agent
  originalGoal: string;      // User's actual goal

  // Plan
  plannedSteps: Array<{
    stepId: string;
    description: string;
    targetAgent: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
    evidence?: string;
  }>;

  // Tracking
  successCriteria: string[];
  currentProgress: number;   // 0.0 - 1.0 (auto-calculated)
  planRevisions: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  confidenceLevel: 'high' | 'medium' | 'low' | 'critical';

  // Lifecycle
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  expiresAt: Date;           // TTL: 7 days
}
```

### API

| Function | Purpose |
|---|---|
| `createGoalContract()` | Create contract with goal, steps, criteria |
| `recordEvidence()` | Add evidence for/against, update step status |
| `recordPlanRevision()` | Replace steps when approach changes |
| `updateConfidence()` | Manually set confidence level |
| `completeGoalContract()` | Mark as completed/failed/abandoned |
| `evaluateCompletion()` | Score completion and recommend finalize/replan/ask_user/escalate |
| `getActiveContractForTask()` | Retrieve active contract by task ID |
| `formatGoalForPrompt()` | Token-efficient format for prompt injection |
| `listActiveContracts()` | Diagnostics: list all active contracts |

### Auto-Progress Calculation

Progress and confidence are automatically recalculated when evidence is recorded:
- **Progress:** `done_or_skipped_steps / total_steps`
- **Confidence:** Based on evidence balance (for vs against)

### Integration

- **delegate-task.ts:** Delegations create an awaited GoalContract, return `goalContractId`, record evidence, and complete sync contracts
- **generate-with-harness.ts:** Accepts `goalContractId`, maps tool results to evidence, evaluates completion after final output/failure
- **context-assembler.ts:** Loads explicit or active GoalContract and formats it into checkpoint/precontext
- **context-checkpoint.ts:** Stores a lightweight `goalContractId` link
- **async-delegation.ts:** Carries `goalContractId` through background execution and completes the contract on async result
- **Strategy Reflector:** Can use recorded GoalContract progress in future stages
- **MongoDB:** `goal_contracts` collection with TTL index (auto-cleanup)

### Current Limits

- Completion evaluation is telemetry/recommendation only; it does not yet block or force a re-plan.
- GoalContract tests are still pending.
- StrategyReflector does not yet consume GoalContract progress directly.

### Telemetry Events

| Event | When | Data |
|---|---|---|
| `goal_contract_created` | Contract is created | contractId, taskId, targetAgent, step/criteria counts |
| `goal_evidence_recorded` | Evidence is added | contractId, stepId, evidence type, step status |
| `goal_plan_revised` | Plan is replaced | contractId, step count |
| `goal_contract_completed` | Contract is completed/failed/abandoned | final status, final evidence |
| `goal_completion_evaluated` | Completion is scored | score, passed, recommendation, missing criteria |

### Files

- `src/mastra/services/goal-tracker.ts` — Core service
- `src/mastra/tools/system/delegate-task.ts` — Delegation integration
- `src/mastra/services/generate-with-harness.ts` — Harness evidence + completion evaluation
- `src/mastra/services/context-assembler.ts` — GoalContract precontext injection
- `src/mastra/services/context-checkpoint.ts` — Checkpoint goalContractId link
- `src/mastra/services/async-delegation.ts` — Async GoalContract completion

## Phase 4: Adaptive Depth Controller (Partial)

The `DepthController` classifies task complexity from the user prompt and automatically adjusts how deeply the system processes each task.

### Depth Levels

| Level | maxSteps | Planning | Reflector | GoalContract | Deliberation | Timeout |
|---|---|---|---|---|---|---|
| `fast` | 10 | ❌ skip | ✅ lightweight | ❌ | ❌ | 60s |
| `standard` | 25 | ✅ inline | ✅ relaxed | ❌ | ❌ | 180s |
| `deep` | 40 | ✅ persisted | ✅ strict | ✅ | ✅ auto | 300s |
| `critical` | 40 | ✅ persisted | ✅ very strict | ✅ | ✅ + review + approval | 300s |

### Classification Algorithm

Weighted signal scoring (0.0-1.0) based on runtime signals:

| Signal | Weight | Examples |
|---|---|---|
| Message length | 0.15 | <80 chars → fast, >500 → deep |
| Complexity keywords (PL+EN) | 0.25 | "zaprojektuj", "audyt", "refactor", "migrate" |
| High-risk keywords (PL+EN) | 0.35 + floor | "produkcja", "delete", "credentials", "deploy" |
| Architecture keywords | 0.15 + floor | "architektura", "wariant", "trade-off" |
| Simplicity keywords | -0.15 | "pokaż", "sprawdź", "list"; ignored when complex/high-risk signals are present |
| Phase analysis | ±0.15 | `diagnose`/`compose` → complex, `list`/`query` → simple; `chat` is neutral |
| Multi-domain markers | 0.15 | 2+ domains mentioned → complex |
| Explicit hints | ±0.20 | "szybko" → fast, "dokładnie" → deep |
| Question-only detection | -0.15 | Single question → fast |

**Score mapping:** <0.15 → fast, 0.15-0.40 → standard, 0.40-0.70 → deep, >=0.70 → critical.

Strategic floors prevent shallow routing:

- high-risk keywords floor the run to `critical`;
- complex + multi-domain floors to `deep`;
- complex + architecture/design language floors to `deep`;
- complex + deep-detail hint floors to `deep`.

### Auto-Escalation

Depth can be upgraded in run state (never downgraded):

```
fast + lightweight reflector trigger → upgrade to standard
standard + direction_instability/delegation_failures → upgrade to deep
```

The in-flight `generateOptions.maxSteps` is still not mutated mid-call, but the harness now runs a controlled no-tool depth-upgrade second pass after the first call when the run depth increases.

### Feature Flag

`FEATURE_ADAPTIVE_DEPTH` (default: `true`). When disabled, all runs use the `deep` profile (backward compatible with pre-Phase 4 behavior).

### Files

- `src/mastra/services/depth-controller.ts` — Classifier + profiles + state
- `src/mastra/services/generate-with-harness.ts` — maxSteps/timeout/reflector gating
- `src/mastra/services/strategy-reflector.ts` — Auto-escalation hooks
- `src/mastra/services/harness-tool-envelope.ts` — Critical-depth approval block for high-risk tools
- `src/mastra/config/harness-flags.ts` — Feature flag
- `src/mastra/scripts/check-depth-controller.ts` — Classifier regression check
- `src/mastra/scripts/check-harness-depth-integration.ts` — Runtime depth integration check
- `src/mastra/scripts/check-automation-delegation-contract.ts` — Automation delegation contract regression check

### Current Runtime Effect

- `maxSteps` is selected from the effective depth profile at generation start.
- `timeoutMs` comes from the selected profile unless the caller overrides it.
- `contextBudgetTokens` is passed to the context builder unless the caller overrides `contextPolicy.maxTokens`.
- An `Execution Depth` header is injected before the user prompt so the model sees planning, reflector, GoalContract, deliberation, review, and approval expectations.
- For `deep`/`critical`, the harness ensures an active GoalContract when one is not supplied, using it as persisted planning storage.
- GoalContract completion is evaluated before final telemetry; failed deep/critical completion can trigger a no-tool completion repair pass.
- `autoDeliberation` can run a no-tool deliberation/re-plan pass after reflection signals such as direction instability.
- `autoReview` runs a critical-depth no-tool review pass before final completion evaluation.
- `requireApproval` has two runtime effects: a final approval gate rewrites high-risk answers to require explicit approval, and the tool envelope blocks high-risk/approval-required tools under critical depth before `execute()`.
- Mid-run depth upgrade triggers a no-tool second pass so the final answer reflects the higher depth profile.
- The `fast` profile keeps a lightweight reflector enabled so shallow runs still have an escalation sensor.
- Runtime reflector analysis is gated by the profile.
- Depth classification and upgrades are logged.
- `npm run check:depth-controller` validates representative fast/deep/critical classifications and feature-flag fallback.
- `npm run check:harness-depth` validates maxSteps, context budget, review/approval gates, auto-deliberation, depth-upgrade second pass, and critical high-risk tool blocking.
- `system_delegate_task` distinguishes automation read-only analysis from Golden Path execution. Read-only `automationArchitect` audits are accepted as usable expert reports without requiring `automationId`/`workflowId`; deploy/test/create/update/activate briefs still require a terminal Golden Path contract.
- `npm run check:automation-delegation-contract` validates that split, including dry-run audits that mention deployment only as analysis context.
- `npm run check:meta-final-synthesis` validates the prompt rules that prevent hidden partial failures and unfinished final reports.
- Root `metaAgent.generate()` is wrapped by `installMetaAgentHarness()`, so the top-level orchestrator run now receives depth classification, depth header injection, auto-GoalContract for deep/critical prompts, review/approval gates, and harness telemetry instead of applying those only to delegated sub-agent calls.
- `npm run check:meta-harness-wrapper` validates the root wrapper with a critical dry-run prompt, including maxSteps selection, memory thread preservation, auto-review, and approval gate execution.
- Completed harness turns now set `agent_runs.status=completed`, write `completedAt`, emit `run_completed`, and attach the full output artifact ID to run events.
- Harness LLM outputs are persisted as `harness_artifacts` even when they fit within the preview, so root meta-agent final answers can be recovered even if `agent_events.task_completed.output` is truncated.
- `npm run check:cognitive-loop-dry-run` runs a deterministic root meta-agent dry-run regression: critical depth, synthetic read-only delegations, no automation mutations, review/approval gates, final report completeness, `run_completed`, and final `llm_output` artifact.

### Current Limits

- `planning: persisted` is backed by GoalContract planned steps; checkpoint plan snapshots remain lightweight.
- `goalContract` is auto-ensured for deep/critical harness calls and injected into context when available.
- Deliberation/review/depth-upgrade passes are intentionally no-tool passes; they change the final answer but do not perform new verification.
- Critical-depth approval blocks high-risk tool execution through the tool envelope; externally approved continuation still needs an explicit approval path/tool.
- The dry-run regression is deterministic with fake agent responses; a live model/n8n end-to-end test is still a separate operational smoke test.

### Telemetry Events

| Event | When | Data |
|---|---|---|
| `depth_classified` | Run start | level, score, signals, maxSteps |
| `depth_upgraded` | Auto-escalation | previousLevel, newLevel, reason |
| `depth_upgrade_second_pass_*` | After depth escalation | previous/new level, revised output |
| `auto_deliberation_*` | Deep/critical instability | signals, revised output |
| `auto_review_*` | Critical finalization | review verdict/output |
| `approval_gate_*` | Critical high-risk output | approval requirement |
| `goal_completion_gate_*` | Deep/critical completion failure | score, recommendation |

## Architecture Summary

Target architecture for all 4 phases:

```
User message
     ↓
 DepthController.classify()          ← Phase 4
     ↓ DepthProfile
 ┌─ PLAN (if depth ≥ standard) ──┐   ← Phase 1
 │  steps, risks, success criteria │
 └───────────────────────────────┘
     ↓
 ┌─ EXECUTE ─────────────────────┐
 │  tool calls / delegations     │
 └───────────────────────────────┘
     ↓
 ┌─ REFLECTOR (prompt) ──────────┐   ← Phase 1
 │  6-point validation           │
 └───────────────────────────────┘
     ↓
 ┌─ REFLECTOR (runtime) ─────────┐   ← Phase 2 (if depth ≥ standard)
 │  signals → threshold check    │
 │  → trigger repair/escalation  │   ← Phase 4
 └───────────────────────────────┘
     ↓
 ┌─ GoalContract ────────────────┐   ← Phase 3 (if depth ≥ deep)
 │  evidence tracking, progress  │
 └───────────────────────────────┘
     ↓
 ┌─ SELF-CHECK ──────────────────┐   ← Phase 1
 │  verify completeness          │
 └───────────────────────────────┘
     ↓
 Final response
```

## Related Files

- `src/mastra/prompts/meta/base.md` — Meta Agent prompt with full Cognitive Loop
- `src/mastra/prompts/meta/response.md` — Meta Agent final response synthesis rules
- `src/mastra/prompts/coding/base.md` — Coding Agent prompt with Planning + Reflector
- `src/mastra/prompts/automation/base.md` — Automation Architect prompt with Reflector
- `src/mastra/services/depth-controller.ts` — Phase 4: Adaptive Depth Controller
- `src/mastra/services/strategy-reflector.ts` — Phase 2: Runtime signal monitoring + repair triggers
- `src/mastra/services/goal-tracker.ts` — Phase 3: Persistent GoalContract tracking
- `src/mastra/services/generate-with-harness.ts` — Harness integration (all phases)
- `src/mastra/services/meta-harness.ts` — Root meta-agent generate wrapper
- `src/mastra/tools/system/delegate-task.ts` — Delegation with GoalContract creation
- `src/mastra/config/harness-flags.ts` — Feature flags (incl. `FEATURE_ADAPTIVE_DEPTH`, `FEATURE_REFLECTION_REPAIR_PASS`, `FEATURE_REFLECTOR_PREPARE_STEP`)
- `src/mastra/services/harness-events.ts` — All cognitive loop event types
- `src/mastra/lib/agent-event-log.ts` — Event type registry
- `src/mastra/scripts/check-meta-final-synthesis.ts` — Meta final synthesis prompt regression check
- `src/mastra/scripts/check-meta-harness-wrapper.ts` — Root meta-agent harness wrapper regression check
- `src/mastra/scripts/check-cognitive-loop-dry-run.ts` — Deterministic root cognitive-loop dry-run regression check
- `pomysły/reflect_loop.md` — Full implementation roadmap (all phases)
- `ideas/reflektor_update.md` — In-flight self-correction roadmap (Parts 1-3); Part 1 = `prepareStep` actuator
- `docs/META-AGENT-PATTERNS.md` — Meta Agent orchestration patterns
- `docs/MASTRA-HARNESS-LAYER.md` — Harness architecture
