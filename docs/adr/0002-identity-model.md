# ADR 0002 — Identity model: auth-owned, fail-closed

**Status:** Accepted.
**Plan refs:** §5, §5.2, `SEC-002`, `DRIFT-AG-004/006`.

## Context

Baseline found agent-global resource fallback (`META_AGENT_ID` used as a user
resource), thread-as-authority confusion, and alias drift
(`metaAgent`/`meta-agent`, `capabilitySmith`/`capability-smith`). These allow
cross-owner reads/writes.

## Decision

1. `tenantId`/`resourceId`/`principalId` come from **auth/ingress only**, never
   from model output. Missing identity is a contract error, not a fallback.
2. `threadId` is a memory container, never an identity/authorization key.
3. Canonical `agentProfileId` with a **versioned alias registry**; new records
   store only the canonical spelling; legacy reads reconcile aliases during
   migration. Model routing reports configured **and** resolved model.
4. IDs are server-minted (UUID). `Date.now()`, model output and framework run
   IDs are never authority. `taskId` ≠ `runtimeRunId`.
5. Branded id types (PR-1, `contracts/ids.ts`) enforce non-mixing at compile
   time; `adoptId` fails closed on empty input.

## Consequences

- Fixes `SEC-002`, `IDN-001`, `DRIFT-AG-004/006`; a dynamic cross-resource
  negative suite + a static fail-closed guard are required to close G1/G2.
- No production path may pass an owner sourced from model content.
