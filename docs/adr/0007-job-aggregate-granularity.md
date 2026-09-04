# ADR 0007 — Job aggregate granularity & contention

**Status:** Accepted — empirically validated by `GAP-TXN-01` (2026-07-23).
**Plan refs:** §15.5, `GAP-JOBDOC-01`, §16.2, `evidence/gap-txn-01/FINDINGS.md`.

> Measurement: 48-way concurrent fan-out did **1052** transient write-conflict
> retries when all children CAS the single job document, vs **45** when sibling
> authority lives on per-task documents (~23× fewer), same total work, zero lost
> updates. This confirms the decision below.

## Context

"One logical writer per job" is intended, but if every child operation permit
touches the job authority document's `authorityUseSequence`, the entire dispatch
fan-out of a job serializes through one CAS hot-spot, and throughput is capped by
its retry rate.

## Decision

1. `jobId` is the lane key; a second independent sub-lane appears only as an
   explicit `branchId`, never an undefined second id.
2. **Default:** sibling authority sequence lives on a **per-task authority
   document** (`taskAuthorityUseSequence`). The job document is touched only for
   job-scope invariants (terminal barrier, `jobStop`/`pause`/`clock`
   generations), not for every ordinary child dispatch. Children under different
   tasks then do not contend on the job doc.
3. An explicit, measured ceiling `maxJobDispatchRatePerSec` /
   `maxJobFanoutInFlight` per job, wired to admission/backpressure (§16.2). Over
   the ceiling → queueing, not an unbounded retry storm.
4. Final granularity (how much authority truly must live on the job doc) is
   measured together with `GAP-TXN-01` under realistic fan-out. Criterion: full
   one-logical-writer + terminal-barrier semantics at reduced job-doc contention.

## Consequences

- The data model separates `orchestration_jobs` from `job_tasks` authority; the
  reducer touches the minimal set per operation.
- Load/fairness tests (G7) exercise high-fan-out jobs, not just many jobs.
