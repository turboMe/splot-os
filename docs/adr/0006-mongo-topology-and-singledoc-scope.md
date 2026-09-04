# ADR 0006 — Mongo topology & single-doc fallback scope

**Status:** Accepted for V2 (2026-07-24). Production rollout remains blocked by
the G8 replica-set topology and partition/stepdown/ambiguous-commit fault suite.
**Plan refs:** §15.3, `GAP-TXN-01`, `GAP-SINGLEDOC-01`, G8.

## Context

Production Mongo is **standalone** (`mongo:7`, no `--replSet`, no auth). Multi-
document transactions and change streams require a replica set. The plan's
authority model needs two atomic multi-aggregate boundaries (A, B) plus command
and C boundaries.

## Decision

1. **Preferred:** replica set + multi-document transactions, explicit majority
   write concern/read semantics, ambiguous-commit handling. Startup/readiness
   gate verifies real topology; never "degrade" a transaction to independent
   writes.
2. **Fallback (dev/spike only):** single-document aggregate + embedded outbox —
   **limited to flat, childless jobs**. It cannot express cross-aggregate
   write-conflict prevention (boundary A touches separate parent/child docs) and
   therefore **cannot close** `ORC-DISPATCH-EDGE-01 / ATTACHED-01 / SPECULATION-01`.
   A single-doc spike that skips these is explicitly incomplete.
3. Alternative backends may mark Mongo-specific labels `NOT_APPLICABLE` only
   after this ADR and must run equivalent partition/ambiguous-commit/failover
   tests.
4. Transaction budget (`GAP-TXN-01`): enforce `maxBoundaryDocuments /
   maxBoundaryTxnMs (< ~60 s) / maxBoundaryOplogBytes (< 16 MB)` + hot-spot
   backpressure. **Measured 2026-07-23** (`evidence/gap-txn-01/FINDINGS.md`): a
   27-document boundary commits in ~14 ms and per-task authority cuts hot-spot
   contention ~23× — the budget is comfortable at realistic sizes. Payloads go to
   `payloadRef`/artifacts to stay under 16 MB.

## Consequences

- Provisioning a replica set (even single-node) is on the Fala 0/3 critical path.
- G8 fault suite: stepdown, partition, `TransientTransactionError`,
  `UnknownTransactionCommitResult`, no split-brain / lost outbox / blind retry.
