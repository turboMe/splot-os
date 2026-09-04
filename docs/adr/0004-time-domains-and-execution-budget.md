# ADR 0004 — Time domains & ExecutionBudget

**Status:** Accepted (shape); numeric values calibrated later (canary).
**Plan refs:** §10, §10.1, §10.5, `BUD-001`, `K8`.

## Context

Today timeouts conflate request, waiter, worker, poll, lease and business SLA.
A single overall timeout cannot cover a multi-hour job; post-passes get a "fresh
full timeout"; a dead 25/25 no-progress threshold never triggers recovery
(`K8`). `@mastra/deployer` also installs an invisible global Hono 180 s wall.

## Decision

1. Separate time domains (§10 table): front request, accept/enqueue, queue SLA,
   activation, attempt work + hard deadline, operation cap, overall job SLA,
   awaiting-user expiry, lease TTL, retention. Only some hold active compute.
2. Each attempt has one absolute `hardDeadlineAt` and two protected reserves:
   `workDeadlineAt = hardDeadlineAt − reserveForFinalizeMs`,
   `businessOperationCutoffAt = workDeadlineAt − resultCommitReserveMs`.
   New business work must end by the business cutoff; the reserves are for
   validation/commit and stop/cleanup only.
3. Child deadline rule: `min(parentBusinessOperationCutoff, now + opCap)` — a
   child never outlives the parent minus its cap (`K2–K4`).
4. Step policy: `maxStepsWithoutProgress ≤ maxSteps − recoveryReserveSteps`,
   triggered at `>=`; "progress" is a typed event, not model text (`K8`).
5. Prompt/harness metadata is derived from the **final** child budget after all
   caps; the runtime budget is authority, not the number shown to the model.
6. Bounded routes obey `applicationHardDeadline ≤ min(verified transport limits)
   − finalization reserve`. Long public n8n flows use `202 accept → status`.

## Consequences

- Contract math delivered in PR-1 (`contracts/execution-budget.ts`) with
  invariant validation; store timers + AbortSignal composition come in Fala 2/3.
- Final numeric policies are versioned and calibrated per
  `capabilityId + profile + provider/model`; not frozen from baseline.
