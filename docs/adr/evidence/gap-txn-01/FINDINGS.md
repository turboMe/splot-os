# GAP-TXN-01 — findings

**Spike:** boundary transaction size/time vs Mongo limits, and job-doc hot-spot
contention vs per-task authority (validates `GAP-JOBDOC-01` / ADR 0007). Plus
`$$NOW` inside a multi-statement transaction (`GAP-CLOCK-01` follow-up). (plan
§32, §15.3, §15.5.)

**Verdict: `TXN_BOUNDARY_VIABLE`** (2026-07-23).

## Method

Requires a replica set. Ran against an **ephemeral, isolated** single-node
replica set on port 27018 (`mongo:7 --replSet`, `--rm`, torn down after) — the
production standalone `mastra-mongo` (27017 / `agentforge`) was never touched.
Throwaway DB dropped on exit. Reproduce:

```
npm run spike:mongo-rs:up      # ephemeral rs0 on :27018
npm run spike:gap-txn
npm run spike:mongo-rs:down
```

Probe: `src/mastra/orchestration/spikes/gap-txn-probe.ts`. Manual transaction
runner counts `TransientTransactionError` retries (which `withTransaction` would
otherwise hide).

## Measured (reproducible, concurrency = 48)

| Test | Result |
|---|---|
| Boundary commit, 11 docs | 13 ms |
| Boundary commit, 19 docs | 13 ms |
| Boundary commit, 27 docs | **14 ms** (vs Mongo ~60 s limit) |
| Job-doc hot-spot, 48 concurrent CAS | **1052 retries**, 337 ms, finalSeq = 48 (**no lost updates**) |
| Per-task docs, 48 concurrent CAS | **45 retries**, 165 ms |
| `$$NOW` inside a transaction | works ✓ |

## Findings

1. **Boundary size/time is a non-issue** at realistic document counts: a
   27-document boundary commits in ~14 ms, ~4000× under the transaction time
   limit. Payloads still go to `payloadRef`/artifacts to stay under 16 MB.
2. **Job-doc contention is real and large, but correctness holds.** 48 children
   all CASing the single job authority document produced **1052** transient
   write-conflict retries — yet `finalSeq === 48`, i.e. **zero lost updates**
   (WiredTiger + retry gives serializable outcome, just expensively).
3. **Per-task authority (GAP-JOBDOC-01) cuts contention ~23×** — 1052 → 45
   retries for the same 48-way fan-out and the same total work — because siblings
   no longer collide on one document. Direct empirical support for ADR 0007.
4. `$$NOW`-in-CAS also works **inside** a multi-statement transaction, closing the
   `GAP-CLOCK-01` follow-up for multi-document boundaries.

## Decisions (confirm ADR 0006 / ADR 0007)

- Enforce `maxBoundaryDocuments / maxBoundaryTxnMs / maxBoundaryOplogBytes` well
  under Mongo limits; at current sizes the budget is comfortable.
- **Keep sibling authority on per-task documents** (GAP-JOBDOC-01); reserve
  job-document writes for genuinely job-scoped invariants (terminal barrier,
  jobStop/pause/clock generations).
- Retry `TransientTransactionError` with **bounded jitter**; treat a sustained
  high retry rate on a hot document as a **backpressure / admission signal**
  (§16.2, `maxJobDispatchRate`), not an infinite retry.

## Scope note

Single-node replica set exercises the transaction commit protocol and contention,
but not partition / stepdown / ambiguous-commit — those remain G8 fault-suite
items on a production-like topology (ADR 0006).
