# E2E Orchestration Findings (2026-06-18)

Live, read-only end-to-end run of the **real** `metaAgent.generate()` against a
safe multi-domain task, to observe the orchestration pieces built in the
orchestration-upgrade workstreams (WS1/WS2/WS4) actually firing:
recognition-before-action, LLM-authored delegation plan, expert-vs-worker
routing, GoalContract, adaptive depth, and review/approval gates.

- **Driver script:** `src/mastra/scripts/observe-meta-orchestration.ts`
  (real cloud-LLM calls + real read-only delegations; DRY-RUN framed task).
- **Outcome:** the run did **not** reach a clean final synthesis — it got stuck
  in a degenerate tool loop inside an expert delegation, which then triggered a
  300s timeout and a self-heal cascade that itself failed. This surfaced seven
  concrete issues, six of which are now fixed and one confirmed a non-bug.

## What worked

- **GoalContract** created for the root run (5 steps / 5 criteria) and for each
  delegation.
- **Adaptive depth** classified correctly as `critical` (0.90 root, 1.00 sub).
- **Expert delegation (WS4.2)** routed the n8n/credential subtask to the correct
  expert (`automationArchitect`).
- **WS2 replan-on-failure** actually fired after the delegation failed.
- **Self-heal trigger** detected the 300s timeout and opened a repair ticket.

## Findings and fixes

### #1 — Enum drift between `memory_write` and `memory_recall` (ROOT CAUSE) — FIXED
`memory-write.ts` accepted 12 knowledge types (incl. `system_diagnostic`,
`workflow_result`, `operational_note`, `env_config`); `memory-recall.ts` only
accepted the first 8. An agent could **write** a memory with a type it could not
**recall** → recall call rejected by Zod → model retried the same (reasonable)
call → infinite `tool_loop`. This single drift drove the timeout + self-heal
cascade (#3/#4).

**Fix:** single source of truth. `services/memory-extractor.ts` now exports a
runtime `KNOWLEDGE_TYPES` array (with `KnowledgeType` derived from it); both
tools import it, so the two Zod enums can never drift again. Recall's
description now lists all 12 categories.

### #2 — Reflector detects `tool_loop` but doesn't break it — FIXED
The StrategyReflector kept re-triggering `tool_loop` (3×, 4×, 5×…) without
breaking the loop. Root cause was coupled to #5: when the tool universe is
empty, the `dropTools` lever filters from an empty base, produces no allowlist,
and silently no-ops — so the looping tool is never removed.

**Fix (`generate-with-harness.ts`):** added a deadlock guard — when `dropTools`
is requested but there is no tool universe to build an allowlist from, fall back
to `toolChoice: 'none'` for that step, forcing a no-tool step that breaks the
loop. (Plus #5 below, which restores the tool universe for the meta agent.)

### #3 — Self-heal coding run missing `threadId` — FIXED
After the 300s timeout, self-heal launched the repo-maintenance workflow, whose
`diagnose-and-plan` step calls `generateCoding({ taskId })` **without** a
`threadId`. The codingAgent's thread-scoped `ObservationalMemory` processor then
threw `requires a threadId`, exhausting all fallback models — the repair itself
failed.

**Fix (`generate-with-harness.ts`, `callAgentGenerate`):** attach the agent
memory thread using the **resolved** threadId (`input.threadId ?? input.taskId`)
— the same value already used for telemetry/precontext — instead of gating on
the raw `input.threadId`. Callers that pass only `taskId` now get a valid memory
thread.

### #4 — WS2 replan: planner returns empty output — FIXED
`Replan failed: Planner returned empty output`. The planner uses a cloud model
(`workerPresets.reasoning`); a single empty response (gateway saturation /
reasoning-only turn) threw immediately and aborted replanning.

**Fix (`tools/system/plan-task.ts`):** one-shot retry on empty output before
throwing.

### #5 — `prepareStep: listTools is not a function` (meta agent) — FIXED
The meta-harness passed a **stub** `{ generate }` object as the agent into
`generateWithHarness`. The stub had no `listTools`, so prepareStep's tool
enumeration threw, leaving the tool universe empty — which disabled the
`restrictTools`/`dropTools` hard levers (the #2 link).

**Fix (`services/meta-harness.ts`):** the stub now also forwards `listTools`
bound to the real agent, so the harness can enumerate tools and the hard levers
work for the meta agent.

### #6 — `memory_write` hard-rejects content > 2000 chars — FIXED
The input schema enforced `.max(2000)` so Zod rejected over-long writes *before*
`execute` ran — even though `execute` already truncates to 2000. The agent got a
hard validation error instead of a graceful truncation, contributing to retry
churn.

**Fix (`tools/system/memory-write.ts`):** raise the schema cap to 8000 and keep
truncating the stored content to 2000 in `execute` (the truncation is no longer
dead code). Description tells the agent stored content is truncated to 2000.

### #7 — SkillRegistry: "102 found, 83 embedded" — NOT A BUG (verified)
The 19-file gap is by design: `SkillRegistry.initialize()` skips files lacking
both `name` and `description` frontmatter. All 19 skipped files live under
`*-references/`, `*-agents/`, `*-reference/` subdirectories — supporting docs and
sub-agent prompts for the skill-creator / mcp-builder / cli-creator /
security-best-practices bundles, not standalone skills. They are correctly
excluded from skill routing. No change needed.

## Flags enabled for this run

- `FEATURE_DELEGATION_LLM_PLAN` set to `true` (was `false`) so the WS2
  plan-and-execute path is exercised.
- `FEATURE_ADAPTIVE_DEPTH` and `FEATURE_REFLECTION_REPAIR_PASS` were registered
  in `config/harness-flags.ts` and default to `true` in code but were absent
  from `.env`; added explicitly to `.env` and `.env.example`.

## Re-running the observation

```bash
npx tsx src/mastra/scripts/observe-meta-orchestration.ts
```

The script prints a structured report: tool usage across steps, an
expected-behavior checklist (recognition / plan / expert / worker / depth /
contract / gates), chronological key telemetry events, the final answer preview,
and an auto-flagged shortcomings list. After the fixes above, a re-run should
get past the memory-recall loop and reach the blank-worker step + final
synthesis.

---

# Re-run findings (2026-06-18, after #1–#6 fixes)

The re-run **validated the core fixes** but exposed two new, deeper issues of a
different class. Routing was changed for this run to avoid `automationArchitect`
(the n8n expert that originally looped): step 1 was sent to `knowledgeAgent`.

## What the re-run confirmed (fixes held)

- **#1 enum drift — HELD.** `knowledgeAgent` ran `system_memory_recall`
  (query: *"secrets management security best practices"*) **and**
  `system_memory_write_observation` in the same run, produced a ~4.4k-char
  report, and its GoalContract went `→ completed`. No memory-recall `tool_loop`.
- **#3 self-heal `threadId` — HELD.** When the later 300s timeout fired and
  self-heal launched the repo-maintenance `diagnose-and-plan` step, the
  `codingAgent` ran **without** the previous `ObservationalMemory requires a
  threadId` crash.
- **Routing — CORRECT.** The task was handled by `knowledgeAgent`, not
  `automationArchitect`, as instructed.

## New finding A — meta agent never converges after a complete deliverable

Even though the expert delegation returned a complete, usable report, the meta
agent did **not** finalize. Across steps 2–13 the StrategyReflector fired
repeatedly:

- `scope_creep` — tool/delegation argument volume ballooned from the original
  896-char prompt to 3453 → 6623 → 7516 → 8438 chars (it kept re-expanding the
  task instead of closing it out).
- `progress_stall` at step 8 — goal progress flat despite successful tool calls.
- `low_confidence` at steps 10 and 13 — hedging language after 8–9 tool calls.

The run never hit a clean stop and ended in the **`Harness LLM call timed out
after 300s`** (output line 64). In other words, `stopWhen` / `isTaskComplete`
did **not** recognise that a delegation had already produced the deliverable, so
the agent kept churning until the wall-clock timeout.

**Direction (not yet implemented):** the stop-condition needs to treat "a
delegation/worker returned a deliverable that satisfies the open GoalContract
step" as a convergence signal — either by tightening `isTaskComplete` to detect
a satisfied contract, or by capping post-deliverable elaboration steps so the
agent is pushed to synthesize-and-stop rather than re-expand scope.

## New finding B — self-heal cascade is too aggressive + `view` tool loop

A **single** 300s timeout (finding A) triggered the full self-heal pipeline:
`GlobalErrorHandler → ErrorCollector → repo-maintenance-workflow`. That is a
heavy response to one stuck run, and the repair itself then failed:

- The `repo-maintenance` `diagnose-and-plan` step's `codingAgent` looped on the
  read-only `view` tool — `Tool "view" called 5x … possible infinite loop`
  (line 69) and again `called 8x` (line 83) — and itself hit
  `Harness LLM call timed out after 300s` (lines 72–75).

So one convergence failure (A) snowballed into a second timeout inside the
healer, doubling the wasted wall-clock and producing no repair.

**Direction (not yet implemented):** two separate levers —
1. **Gate the cascade.** A plain LLM-call timeout on a *user/observation* run
   should not automatically open a full repo-maintenance coding cycle; self-heal
   should distinguish "transient timeout / convergence stall" from "code/build
   defect" before escalating.
2. **Break the `view` loop in `codingAgent`.** The same `tool_loop` hard-lever
   that now guards memory-recall needs to actually fire for `view`; a repeated
   read-only `view` with no progress should force a no-tool synthesis step (the
   #2 deadlock-guard pattern) rather than running to the 300s timeout.

## Status

A and B were investigated with deep code research (three parallel audits of the
convergence wiring, the reflector tool-loop lever, and the self-heal trigger
chain) and are now **fixed** — see the next section.

---

# Fixes for A / B1 / B2 (2026-06-18)

Implemented in priority order **B2 → B1 → A** (cheapest/safest first; the two B
fixes shrink the blast radius of an A failure, so the riskier convergence change
lands last and is validated together). Best-practice references for the
convergence design: graceful "detect-stall → force-synthesis → terminate with
partial results" ([tool-loop-guard](https://dev.to/mukundakatta/your-agent-is-calling-that-tool-again-tool-loop-guard-4n9c),
[AWS reasoning-loop prevention](https://dev.to/aws/how-to-prevent-ai-agent-reasoning-loops-from-wasting-tokens-2652),
[Inkog infinite-loop detection](https://inkog.io/glossary/infinite-loop-ai-agent)).

### B2 — `tool_loop` lever silently no-ops on a name/key mismatch — FIXED
**Root cause (one line):** the reflector emits `dropTools:['view']` carrying the
tool's *runtime name*, but `generate-with-harness.ts` filtered it against
`agent.listTools()` *registry keys* without translation, so `base.filter()`
removed nothing and the lever no-op'd while still logging `appliedLevers:['dropTools']`.
The codingAgent (self-heal) looped on `view` to the 300s timeout as a result.

**Fix (`services/generate-with-harness.ts`, dropTools block):** translate
`dropTools` id/name → registry key via the existing `idToKey` map (the same
boundary `translateToolIdsToKeys` already crosses for the phase allowlist), then
only trust the allowlist when it **actually shrank** (`allow.length < base.length`).
If the looping tool cannot be excluded that way — empty universe, or a workspace
tool like `view` surfaced *outside* `listTools` so an allowlist can't disable it —
fall back to `toolChoice:'none'` for one step, guaranteeing the loop breaks.

### B1 — a single LLM timeout triggers the full repo-maintenance cascade — FIXED
**Root cause:** `GlobalErrorHandler` reports **every** `unhandledRejection`
(including `Harness LLM call timed out after 300s`) to `ErrorCollector`, whose
guards are purely volumetric (cooldown/dedup/rate-limit) — **no error-type
classification**. So one transient timeout opened a codingAgent diagnose-and-plan
cycle, which ran on the same harness and timed out again (cascade).

**Fix (`services/error-collector.ts`, `_processError`):** after the cycle
observation is recorded (diagnostics preserved), classify the error against a
configurable transient-pattern list (`/Harness LLM call timed out/`,
`/timed out after \d+\s*s/`, `/trajectory is unrecoverable/`,
`/Run stopped early by the strategy reflector/`). A match returns
`{ triggered:false }` **before** any ticket/workflow — the heavy coding cascade is
suppressed, nothing else is lost. Opt back in with
`ERROR_COLLECTOR_ESCALATE_TRANSIENT=true`; extend patterns via
`ERROR_COLLECTOR_TRANSIENT_PATTERNS` (split on `|||`).

### A — meta agent never converges after a complete deliverable — FIXED
**Root cause (two coupled dead ends):**
1. The `isTaskComplete` GoalContract completion scorer reads contract step status
   from Mongo, but a meta run's contract steps are only marked `done` **after**
   `callAgentGenerate` returns (`recordHarnessFinalGoalEvidence`), and delegations
   close a **separate** contract. So mid-run the scorer always reads `passed:false`
   → Mastra keeps re-injecting "incomplete" and re-iterating = the churn engine.
2. `isUnrecoverable` only escalates **hard** failures (tool_loop ≥12×,
   errorRate ≥0.8, delegationFailures ≥6) — it ignores `scope_creep`/
   `progress_stall`/`low_confidence`, so a churning-but-not-erroring run never
   trips `stopWhen` and runs to the 300s wall-clock.

**Fix (graceful convergence; `services/strategy-reflector.ts` +
`services/generate-with-harness.ts`):**
- New `converge` reflector signal: when a delegating run **already holds a usable
  deliverable** (a successful, non-trivial `system_delegate_task`/`system_run_worker`
  result) but keeps churning, and the reflector has **already nagged ≥2×** at low
  error rate, it preempts the soft "re-plan/narrow" signals with a `forceNoTool`
  **"finalize now"** synthesis step (any remaining pure-text subtask is completed
  inline — it needs no tools).
- New `shouldConvergeStop()` predicate wired into the harness `stopWhen` array:
  once the reflection budget is exhausted (max nags spent) with a deliverable
  present and low error rate, the run **stops cleanly** — overriding the
  never-passing completion scorer. Crucially this is a **successful** stop, so —
  unlike `isUnrecoverable` — it stamps **no** error blocker; the best synthesized
  answer is returned verbatim. Emits a `reflector_convergence_stop` telemetry event.
- Naturally scoped: `deliverableSeen` requires delegation/worker results, so the
  signal never fires for non-delegating agents; it is skipped in pipeline mode;
  and the ≥2-nag + budget gates prevent truncating a healthy short run.
- Gated by `FEATURE_REFLECTOR_CONVERGENCE` (default true; registered in
  `config/harness-flags.ts`, added to `.env`/`.env.example`).

## New flags

| Flag | File | Default | Purpose |
|---|---|---|---|
| `FEATURE_REFLECTOR_CONVERGENCE` | harness-flags.ts | `true` | Graceful convergence (A) |
| `ERROR_COLLECTOR_ESCALATE_TRANSIENT` | error-collector.ts | `false` | Restore old always-escalate (B1) |
| `ERROR_COLLECTOR_TRANSIENT_PATTERNS` | error-collector.ts | `''` | Extra transient regexes, `|||`-split (B1) |

`tsc --noEmit` passes clean after all three fixes.
