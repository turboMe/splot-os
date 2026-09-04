# Delegation & Depth Hardening

Plan: `ideas/delegation-depth-hardening-plan.md` · Branch: `fix/delegation-depth-hardening`

Root cause analysis of the live 2026-07-21 failure ("Finnsson case"): a
research → design delegation chain died without ever reaching designAgent.
Four independent causes, each fixed behind its own flag.

## The failure, in one paragraph

Meta received a critical-depth task (research Bistro Finnsson → delegate a
website redesign to designAgent). The researcher delegation hit a static 240s
timeout **47s after its parent had already died** at its own 300s budget —
~226s of finished scraping was discarded because the single `artifact_put` was
planned for the end. Two hours later the user typed `"Deleguj"`; the stateless
depth classifier scored it 0.00 → `fast` (60s / 10 steps / 4k context), the
model emitted `delegateTaskTool` with empty args at that starved budget, and
the turn timed out. designAgent was never invoked.

## P1 — Thread depth inheritance (sticky depth)

**Flag:** `FEATURE_DEPTH_THREAD_INHERITANCE` (default ON)

`classifyComplexity` now accepts a `threadId`. Each harness turn records its
level in an in-memory thread registry (`recordThreadDepth`, 6h TTL, lighter
turns never overwrite or extend a heavier memory). A **short continuation
imperative** (`Deleguj`, `dalej`, `kontynuuj`, `continue`, … — full-message
anchored regex `CONTINUATION_COMMAND`) inherits the thread's remembered level
when that level is deep/critical, emitting a `depth_inherited:<level>` signal.

Deliberate non-inheritance:
- an explicit fast hint (`szybko`, `krótko`) always wins;
- status questions (`Jak status?`, `Jestes?`) stay `fast` — instead, their
  depth header gains an instruction to **report status only and not resume
  the heavy work** (the second half of the live failure: a 60s status turn
  resumed scraping and died mid-work);
- long messages with real content classify on their own signals;
- `standard`-level threads do not propagate.

Files: `services/depth-controller.ts`, `services/generate-with-harness.ts`.

## P2 — Parent↔child budget coordination

**Flag:** `FEATURE_DELEGATION_BUDGET_COORDINATION` (default ON)
**Env:** `DELEGATION_SYNC_SAFETY_MARGIN_MS` (120000), `DELEGATION_MIN_VIABLE_SYNC_MS` (60000)

`generateWithHarness` publishes its wall-clock deadline into a run-budget
registry (`services/run-budget.ts`, keyed by `runId`). Tools executing inside
the run read the remaining budget via the harness execution context
(AsyncLocalStorage) — no reliance on the model passing caller ids.

`resolveDelegationBudget(targetAgent)` in `delegate-task.ts` then caps every
sync delegation timeout to `min(staticDefault, parentRemaining − margin)`:

- pipeline agents (chef/content/hunt/…), generic agents (researcher, design,
  writer, film, …), `n8nMcpEngineer`, `deliberationAgent` — all capped;
- harness-routed coding/automation/knowledge paths are unchanged (they manage
  their own budgets and async modes);
- when the capped window is **below the min-viable threshold**, a sync call is
  mathematically doomed → the delegation is **auto-routed to async** and the
  result arrives as a pending update on the next turn;
- explicit `async: true` is now honored for generic/pipeline agents too
  (previously silently ignored; only coding/automation/knowledge supported it);
- `async-delegation.ts` gained a generic background branch (plain abortable
  `agent.generate`) — previously every unknown agent fell through to the
  CODING harness, which was wrong for them;
- board data fix: `designAgent.delegation` `sync` → `both` (it was
  contradicting `latencyClass: long`); roster regenerated via
  `build-agent-board.ts`.

Outside a harness run (no registry entry) everything degrades to the old
static defaults — zero behavior change for non-harness callers.

### P2b — the reserve must cover the parent's ANSWER (2026-08-24)

The margin was 20s, which covered "receive the result and persist state" but not
the parent's own closing LLM call. A child was therefore allowed to consume
effectively the whole parent budget, and finished work died with nobody left to
report it. Measured to the second on a meta→`automationArchitect` run:

| time | event |
|---|---|
| 14:35:12 | meta starts, 1200s budget → hard deadline 14:55:12 |
| 14:47:20 | architect returns a correct, deployed workflow + a "next step" note |
| 14:49:31 | meta reads the next step as an instruction and re-delegates; 341s remain → child granted 341−20 = **320.867s** |
| 14:54:54 | child times out; **18s** left for meta |
| 14:55:12 | meta `run_failed` on the wall clock → caller got **HTTP 504, empty body** |

The n8n workflow built at 14:47 was live and correct the whole time; the user
simply never saw it. Two changes:

1. **Reserve raised 20s → 120s.** It must cover one closing model step *plus* the
   post-run harness work — `auto_review` alone measured 40s at `critical` depth.
   Sizing up is the safe direction: a child that no longer fits is either capped
   shorter (still returning something reportable) or fails the viability gate and
   routes to async, which returns immediately and leaves the parent its full
   remaining time. Both beat losing the run.
2. **A capped delegation says so in its result.** An architect report legitimately
   ends with a recommended next step; the caller reads that as an instruction and
   delegates again — correct when there is budget, fatal when there is not. When
   `cappedByParent` is set, the returned text now carries a `[delegation budget]`
   footer telling the caller to finalize and *not* delegate again.

The invariant to preserve when tuning these numbers: **whatever the child is
granted, the parent must retain a window large enough to answer.** `check:delegation-budget`
asserts the LEFTOVER (`parentRemaining − childGrant ≥ ~120s`), not just the grant,
so lowering the reserve without thinking fails the gate.

## P3 — Salvage on delegation timeout

**Flag:** `FEATURE_DELEGATION_TIMEOUT_SALVAGE` (default ON)

A timed-out delegation now returns a `salvage` pointer
(`{ delegationThreadId, hint }`) in the tool result, and the new
**`system_delegation_salvage`** tool (registered on meta) compresses that
thread's tool results + assistant notes from `mastra_messages` into a bounded
digest (~20k chars, newest-first priority, reasoning never leaks). Meta can
compile the result directly or re-delegate **with the digest as context**
instead of redoing the work.

Verified against the real failure thread: the digest recovers 39 tool results
of Finnsson research that the old code silently discarded.

Additionally, every `taskSpec` brief with an `artifactType` now carries a
checkpoint rule: persist partial results via `artifact_put`
(`partial_<type>`) after each phase — a timeout must never destroy finished
work (`worker-task-spec.ts`).

Deliberately rejected: "promote-to-background on timeout" (letting the child
finish after the parent gave up) — it would reintroduce the zombie runs WS-A
eliminated. If a delegation should outlive the parent, the correct path is
async from the start (P2's auto-switch).

## P4 — Small tool fixes (each burned steps in the live run)

- **P4a** `plan-task.ts`: `expectedOutput` is optional with default `''` +
  backfill from `intent` before parse. Planner LLMs notoriously drop the
  field; a missing string used to reject the whole plan.
- **P4b** `prompts/shared/subagent-researcher.md`: firecrawl_extract flat-schema
  rules (no `additionalProperties`), Tavily `site:`-only warning, and an
  explicit "image-only pages: don't retry, pivot to secondary sources" rule.
  (firecrawl arrives via MCP — no local wrapper to sanitize in.)
- **P4c** `tools/search/tavily.ts`: `repairSiteOnlyQuery` appends the domain
  name as a term when a query consists only of `site:` operators (Tavily 400s
  otherwise).
- **P4d** `delegate-task.ts`: new `taskSpecArtifactId` input — long briefs
  travel as an artifact reference instead of a giant inline tool argument
  (how the live run produced `delegateTaskTool args={}` at a 4k budget).

## P5 — depth_floor signal fix

`depth_floor` is only emitted when a real floor (>0) engages. Previously a
negative score (`question_only` on chit-chat) tripped `0 > score` and logged a
bogus `depth_floor:deep` on every "Jestes?".

## Checks

```bash
npx tsx src/mastra/scripts/check-depth-controller.ts          # P1 + P5 (live fixtures)
npx tsx src/mastra/scripts/check-delegation-budget.ts         # P2 + P2b (registry, cap, viability, parent leftover, flags)
npx tsx src/mastra/scripts/check-delegation-salvage.ts        # P3 (needs Mongo; live-thread bonus)
npx tsx src/mastra/scripts/check-delegation-hardening-tools.ts # P4a + P4c
npx tsx src/mastra/scripts/check-agent-board-sync.ts          # board/roster consistency
npx tsx src/mastra/scripts/check-harness-depth-integration.ts # regression
```

## Rollback

Each pillar has an independent kill switch (set to `false` in `.env`):
`FEATURE_DEPTH_THREAD_INHERITANCE`, `FEATURE_DELEGATION_BUDGET_COORDINATION`,
`FEATURE_DELEGATION_TIMEOUT_SALVAGE`. All default ON in code.

## Known limitations / follow-ups

- Thread-depth and run-budget registries are in-memory: a process restart
  resets them (degrades to pre-fix behavior for the first turn). A Mongo
  fallback via `depth_classified` events is sketched in the plan (P1 step 4).
- Mid-run depth upgrades (strategy reflector) do not bump the thread registry.
- P6 (VLM/OCR `image_extract` for image-only menus) is a separate mini-project
  — see the plan.
- E2E scenario replay (full Telegram flow) still pending — see plan's final
  verification criteria.
