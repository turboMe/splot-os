# `orchestration/` — Durable Orchestration V2

Experimental, additive durable-orchestration substrate. It is mounted into the
Mastra runtime only behind `FEATURE_ORCHESTRATION_V2=true` (OFF by default), uses
`orch_*` collections, defaults to the separate `orchestration_v2` database, and
requires a MongoDB **replica set**. The mount still uses a header-auth stub and
is not production-ready.

- **Architecture, module map, invariants, how to run:**
  [`docs/ORCHESTRATION-V2.md`](../../../docs/ORCHESTRATION-V2.md)
- **Decisions:** [`docs/adr/`](../../../docs/adr/) (0001–0007, incl. resolved
  feasibility spikes 0005)
- **Master plan & per-PR progress:**
  [`ideas/meta-front-durable-orchestration-and-execution-plan.md`](../../../ideas/meta-front-durable-orchestration-and-execution-plan.md)
  (§33 progress log)

Layout: `contracts/` (types), `store/` (Mongo substrate and A/B/C/process-truth
boundaries), `execution/` (gateway, model/registered-agent adapters and the
opt-in Linux PROCESS_GROUP supervisor/worker), `http/` (standalone and
flag-mounted Meta Front), `service/` (background loops), `coverage/` (executable
program inventory), `testing/` (owned Mongo test runtime, bounded five-artifact
evidence, parent pipe/read-back and fail-closed cleanup), and `spikes/`
(feasibility probes).
