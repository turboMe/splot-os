# ADR 0005 — Fala 0 feasibility spikes

**Status:** Accepted — all four resolved 2026-07-23 by measurement. Remaining
gate work is the production-like topology fault suite
(partition/stepdown/ambiguous commit, ADR 0006 / G8), not these feasibility
questions.
**Plan refs:** §32, §15.2, §16.1, §15.3, §15.5.

## Progress

| Spike | Status | Evidence |
|---|---|---|
| `GAP-MODEL-ABORT-01` | ✅ Resolved — `ABORT_WORKS` | `evidence/gap-model-abort-01/FINDINGS.md` |
| `GAP-WORKER-ISO-01` | ✅ Resolved — `ISOLATE_SYNC_KEEP_ASYNC` | `evidence/gap-worker-iso-01/FINDINGS.md` |
| `GAP-CLOCK-01` | ✅ Resolved — `STORE_TIME_IN_CAS_WORKS` | `evidence/gap-clock-01/FINDINGS.md` |
| `GAP-TXN-01` | ✅ Resolved — `TXN_BOUNDARY_VIABLE`; per-task authority cuts contention ~23× | `evidence/gap-txn-01/FINDINGS.md` |

## Context

Four assumptions underpin the correctness guarantees but were not proven against
the live runtime. Each can change the execution architecture.

## Decisions to resolve (each = a measured spike, then this ADR is updated)

### `GAP-MODEL-ABORT-01` — in-flight model abort — ✅ RESOLVED (positive)
Proven by measurement (`evidence/gap-model-abort-01/FINDINGS.md`): aborting the
AI-SDK call (the exact `createOpenAICompatible` + `streamText`/`generateText`
path Mastra wraps) stops token delivery in ~2 ms (0 chunks after abort) and
rejects `generateText` at the abort point, vs a 6.3 s full run. Reproducible.
- **Result:** cooperative in-flight cancel of the model call is viable.
- **Follow-ups (not blockers):** confirm the Mastra `agent` wrapper forwards
  `abortSignal`; per-capability confirmation that *remote/cloud* providers stop
  compute/billing on abort (local Ollama stops on connection close).

### `GAP-WORKER-ISO-01` — worker process isolation — ✅ RESOLVED
Measured (`evidence/gap-worker-iso-01/FINDINGS.md`): a CPU-bound synchronous
attempt on the main thread freezes the event loop for its **entire** duration
(max lag = full workload, 1500/1000 ms); the same work in a `worker_thread`, and
any async-I/O work, keep the loop at ~1 ms. Combined with `GAP-MODEL-ABORT-01`:
- LLM attempts use cooperative in-process cancel for the model call; async token
  streaming does not block the loop → may stay in-process.
- **Isolate** CPU-bound/synchronous/non-cooperative attempts. `worker_thread`
  protects the event loop for CPU-bound JS; media/subprocess/browser/git attempts
  additionally need a killable **OS process** (`child_process` + TERM/grace/KILL,
  plan §11.2) because their cancel is non-cooperative.
- Front/dispatcher never runs a synchronous heavy attempt (G3/G7). No "every
  attempt in its own process" rule is needed. Worker pools (§16.1) split by
  isolation need, not just concurrency.

### `GAP-TXN-01` — boundary transaction budget — ✅ RESOLVED
Measured on an ephemeral replica set (`evidence/gap-txn-01/FINDINGS.md`): a
27-document boundary commits in ~14 ms (vs ~60 s limit); 48-way job-doc CAS gave
1052 transient retries but **zero lost updates**; moving sibling authority to
per-task docs cut retries to 45 (**~23×**); `$$NOW` works inside a transaction.
- Enforce `maxBoundaryDocuments/TxnMs/OplogBytes` (comfortable at these sizes).
- Keep sibling authority on per-task docs (confirms ADR 0007); job-doc writes
  only for job-scoped invariants.
- Retry `TransientTransactionError` with bounded jitter; sustained hot-doc retries
  are a backpressure/admission signal (§16.2), not infinite retry.
- **Remaining (G8, not this spike):** partition/stepdown/ambiguous-commit on a
  production-like topology (ADR 0006).

### `GAP-CLOCK-01` — store-time inside the CAS — ✅ RESOLVED
Measured (`evidence/gap-clock-01/FINDINGS.md`, standalone Mongo, throwaway DB):
`$$NOW` works both as an `$expr` guard in the query filter (time predicate +
generation CAS in one conditional write — **recommended**) and inside a
pipeline-form `$cond`. Two concurrent generation-CAS pauses resolve to exactly
one winner; at a passed deadline, due wins and pause fails its time guard. This
resolves store-time authority for **single-document** rows
(job/task/attempt/request) — `ORC-TIME-01` is feasible without a separate read.
- **Follow-up:** re-verify `$$NOW` semantics **inside a multi-statement
  transaction** as part of `GAP-TXN-01` (multi-document boundaries A/B).

## Consequences

- G0 requires stored, measured evidence for all four and accepted ADRs before
  any Fala 3 work.
- A negative result changes dispatcher/lease/adapter shape and is reflected in
  ADR 0006 (topology) and ADR 0007 (granularity).
