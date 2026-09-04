# GAP-CLOCK-01 — findings

**Spike:** can `storeNow < deadline` be evaluated as part of the conditional
write (not a read-only snapshot), so the time predicate races atomically with the
CAS? (plan §32, §15.5, §10; feeds ADR 0005 / `ORC-TIME-01`.)

**Verdict: `STORE_TIME_IN_CAS_WORKS`** (2026-07-23).

## Method

Single-document concern → run against the existing **standalone** Mongo
(`mongodb 7.2.0` driver) using a throwaway DB dropped on exit (no replica set, no
touch of `agentforge`; confirmed no leftover spike DBs). Probe:
`src/mastra/orchestration/spikes/gap-clock-probe.ts` (`npm run spike:gap-clock`).
Two candidate mechanisms + two races, using `$$NOW` (server time), never an
app-supplied `Date`, so process clock skew is not authority.

## Measured (all pass)

| Test | Result |
|---|---|
| M1 pipeline `$$NOW` guard, now<deadline | fires → PAUSED, gen++ ✓ |
| M1 pipeline `$$NOW` guard, now≥deadline | blocked → unchanged, gen stays ✓ |
| M2 `$expr`+`$$NOW` filter, now<deadline | matches → PAUSED, gen++ ✓ |
| M2 `$expr`+`$$NOW` filter, now≥deadline | no match → not paused ✓ |
| RACE: two concurrent generation-CAS pauses | exactly one wins, gen=1 ✓ |
| BOUNDARY: past deadline, pause vs due concurrently | due wins, pause fails its time guard, gen=1 ✓ |

## Decision

- **Recommended mechanism:** `$expr` + `$$NOW` in the **query filter**, combined
  with a generation field — the time predicate AND the CAS are one conditional
  write:
  ```js
  findOneAndUpdate(
    { _id, clockGen: expectedGen, $expr: { $lt: ['$$NOW', '$deadlineAt'] } },
    { $set: { state: 'PAUSED' }, $inc: { clockGen: 1 } })
  ```
- Pipeline-form (`$$NOW` inside `$cond`) also works and is the fallback when the
  update must compute derived fields from the guard result.
- This resolves the store-time-authority question for **single-document**
  authority (job/task/attempt/request rows) — pause-vs-due, claim-vs-cutoff,
  answer-vs-expiry (`ORC-TIME-01`). Timer events remain durable wakeups only;
  authority is in the CAS.

## Scope note / follow-up

- Multi-**document** boundaries (A/B touching the ancestor chain) still need
  `GAP-TXN-01` on a replica set; that spike will reuse `$$NOW`-in-CAS inside the
  transaction and measure cost.
- `$$NOW` is transaction/operation start time; for single-doc updates that is the
  operation time and is sufficient here. Re-verify semantics once inside a
  multi-statement transaction (GAP-TXN-01).
