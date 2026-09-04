# ADR 0001 — Durable backend & application-owned contracts

**Status:** Accepted (direction); concrete backend chosen by Fala 0 spike (ADR 0005/0006).
**Plan refs:** §0, §15.1, §15.3.

## Context

The system must turn long/risky commands into durable jobs that survive API,
worker and orchestrator crashes, resume autonomously, and never double-apply
side effects. The runtime today is Mastra 1.31 with a **standalone** MongoDB
(`mongodb://…/agentforge`, verified in `docker-compose.yml`), DuckDB used only
for observability. Mastra native background tasks are not enabled/verified.

## Decision

1. Orchestration **contracts belong to the application**, not to implicit SDK
   behaviour: identity, job/task/attempt, result schema, inbox/outbox, ACL,
   side-effect policy and conversation projection are ours.
2. Introduce a `DurableExecutionBackend` port + a shared conformance/fault suite.
3. Choose the backend by measured spike, not API presence: pinned Mastra-native
   (Background Tasks / Durable Agents / Signals) **vs** a small Mongo-backed
   dispatcher/worker (lease, fencing, inbox/outbox, recovery). Default if native
   fails the gates: application Mongo-backed backend. Temporal only later, if
   multi-day workflows + heavy compensation justify it.
4. The contract layer (branded ids, state models, strict result envelope,
   execution budget) is implemented first and is backend-agnostic — delivered in
   PR-1 under `src/mastra/orchestration/contracts/`.

## Consequences

- Front/worker contracts stay stable across a backend swap.
- `NOT_RUN/BLOCKED` never closes a gate; the conformance suite is backend-aware
  only for mechanics, not for guarantees.
- Backend decision is due by end of Fala 0 and recorded in ADR 0006.
