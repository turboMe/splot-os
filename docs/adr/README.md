# Architecture Decision Records — durable orchestration refactor

ADRs for the Meta Front + durable orchestration + execution-gateway program.
Source of truth for scope is
[`ideas/meta-front-durable-orchestration-and-execution-plan.md`](../../ideas/meta-front-durable-orchestration-and-execution-plan.md);
these records capture the individual decisions that plan mandates.

## Status legend

- **Accepted** — decided; implementation may depend on it.
- **Proposed (pending spike)** — direction chosen, but a Fala 0 feasibility
  measurement (`§15.2` / `§32`) can still change it. Blocks Fala 3 until resolved.
- **Superseded** — replaced by a later ADR (linked).

## Index

| ADR | Title | Status | Plan refs |
|---|---|---|---|
| [0001](0001-durable-backend-and-contract-ownership.md) | Durable backend & application-owned contracts | Accepted (backend via spike) | §0, §15.1 |
| [0002](0002-identity-model.md) | Identity model: auth-owned, fail-closed | Accepted | §5, `SEC-002` |
| [0003](0003-strict-result-envelope.md) | Strict result envelope, no false success | Accepted | §9.1, `RES-001` |
| [0004](0004-time-domains-and-execution-budget.md) | Time domains & ExecutionBudget | Accepted | §10 |
| [0005](0005-feasibility-spikes.md) | Fala 0 feasibility spikes (`GAP-MODEL-ABORT/WORKER-ISO/TXN/CLOCK`) | Proposed (pending spike) | §32, §15.2 |
| [0006](0006-mongo-topology-and-singledoc-scope.md) | Mongo topology & single-doc fallback scope | Proposed (pending spike) | §15.3, `GAP-SINGLEDOC-01` |
| [0007](0007-job-aggregate-granularity.md) | Job aggregate granularity & contention | Proposed (pending spike) | §15.5, `GAP-JOBDOC-01` |

## Convention

One decision per file, numbered `NNNN-kebab-title.md`. Each record: Context →
Decision → Consequences → Status. A change in a decision's *semantics* gets a new
ADR that supersedes the old one; renaming is not enough (mirrors the plan's
contract-versioning rule §15.7).
