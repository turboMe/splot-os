# Architecture input

Baseline run: `67e6eed4-f256-47d2-8017-899eaf9e5edf`  
Schema: `agent-baseline/v1`  
Commit: `eff419ee54280fb4f517d56833ab8b772fbf485b`

This is not an implementation plan. It separates observations from inferences and records
constraints that a later architecture plan must confront. Every recommendation is explicitly
marked `inferred`.

## Observations

### Dynamic observations

- **observed — P0 memory isolation failure:** isolated `salesAgent` accepted
  `resource-b` on a thread owned by `resource-a`. The thread row retained owner A, while
  persisted messages for that thread contained both resources. Evidence:
  `E-DYN-MEM-CROSS-RESOURCE`; failure `MEM-001`.

- **observed — P1 pre-abort failure:** an already-aborted direct generate resolved in
  18-19 ms and persisted its user message in 3/3 isolated repetitions. Evidence:
  `E-DYN-CAN-PREABORT-3X`; failure `CAN-003`.

- **observed — P1 attempt identity collision:** two concurrent harness calls with one
  `taskId` and no `runId` returned the same run ID. Storage held one run row, two start
  events, two completion events, and two output artifacts under that ID. Evidence:
  `E-DYN-SAME-TASKID-PARALLEL`; failure `IDN-001`.

- **observed — P1 false-success contract:** the deterministic parser test confirmed that
  prose, invalid status, malformed JSON, empty/undefined input, and non-envelope JSON all
  become fallback `ok` with `parsed=false`. Evidence: `E-DYN-RESULT-PARSER`; failure
  `RES-001`.

- **observed — P2 agent output failure:** ten Board agents returned empty text with no
  tools in two runs: `marketingAgent`, `analyticsAgent`, `deliberationAgent`,
  `chefAgent`, `contentAgent`, `huntAgent`, `designAgent`, `filmmakerAgent`,
  `musicianAgent`, and `capabilitySmith`. Provider/control calls returned non-empty text.
  The responsible layer remains unknown. Evidence: `E-DYN-BOARD-SMOKE-RUN1`,
  `E-DYN-BOARD-SMOKE-RUN2`, `E-DYN-PROVIDER-CONTROL`; failure `AGT-001`.

- **observed — test-environment gap:** `npx tsx` found no local runner, attempted a
  registry fetch, and failed with `ENOTFOUND`; no dependency was installed. Evidence:
  `E-DYN-NPX-TSX-ENOTFOUND`; failure `TST-001`.

### Static observations

- **static_analysis:** 29 keys are registered in the Mastra agent registry
  (`src/mastra/index.ts:1919-1949`). The Agent Board exposes 18 delegatable cards with
  declared sync/async and latency metadata
  (`src/mastra/config/agent-board.ts:23-39`,
  `src/mastra/config/agent-board.ts:39-390`).

- **static_analysis:** six producer-hunt helpers and three review agents are registered
  workflow/lane helpers rather than Board targets
  (`src/mastra/agents/marketing-agent.ts:119-153`,
  `src/mastra/workflows/producer-hunt.ts:612-620`,
  `src/mastra/workflows/repo-maintenance.ts:456-484`).

- **static_analysis:** missing thread identity permits an agent-global pending-result read
  and consume (`src/mastra/processors/pending-updates.ts:78-113`,
  `src/mastra/tools/system/check-pending-updates.ts:62-77`). Failure `SEC-001`.

- **static_analysis:** Meta falls back to the constant `META_AGENT_ID` as memory resource,
  while its working memory has implicit resource scope
  (`src/mastra/services/meta-harness.ts:75-89`,
  `src/mastra/agents/meta-agent.ts:145-184`,
  `node_modules/@mastra/core/dist/docs/references/docs-memory-working-memory.md:9-14`).
  Failure `SEC-002`.

- **static_analysis:** Meta root harness wraps `generate` only
  (`src/mastra/services/meta-harness.ts:20-34`); six pipeline agents use a separate bare
  generate wrapper (`src/mastra/tools/system/delegate-task.ts:798-818`,
  `src/mastra/services/generate-pipeline-with-reflection.ts:263-268`). Failures
  `HRN-001`, `HRN-002`.

- **static_analysis:** `withToolEnvelope` drops Mastra's second tool execution context,
  including `abortSignal` (`src/mastra/services/harness-tool-envelope.ts:92-104`,
  `node_modules/@mastra/core/dist/tools/types.d.ts:303-325`). Pipeline timeout is a
  wait-only race (`src/mastra/tools/system/delegate-task.ts:1443-1463`), and harness
  postpasses call the model outside the primary timeout
  (`src/mastra/services/generate-with-harness.ts:2337-2395`). Failures `CAN-001`,
  `CAN-002`, `BUD-001`.

- **static_analysis:** custom async delegation persists a running record and starts
  `void executeDelegation(...)` in-process
  (`src/mastra/services/async-delegation.ts:95-159`); the Mastra instance does not enable
  native background tasks (`src/mastra/index.ts:119-120`,
  `src/mastra/index.ts:1899-1970`). Failure `DUR-001`.

- **static_analysis:** async completion is queued for pickup on the next user interaction,
  not an autonomous conversation wake
  (`src/mastra/services/async-delegation.ts:4-13`,
  `src/mastra/tools/system/delegate-task.ts:788-795`). Failure `EVT-001`.

## Inferences

All content in this section is an `inferred` recommendation derived from the observations
above; it is not measured behavior or a final implementation sequence.

### Recommended execution class per registered agent

| Agent registration key | Recommended class | Inferred basis |
|---|---|---|
| `weatherAgent` | `interactive_bounded` | **inferred** — one focused weather tool and concise role (`src/mastra/agents/weather-agent.ts:7-23`). |
| `crmAgent` | `interactive_bounded` | **inferred** — Board calls it a read-only, seconds-class lookup (`src/mastra/config/agent-board.ts:156-166`). |
| `metaAgent` | `front_only` | **inferred** — supervisor owns routing/status/steering and must remain bounded (`src/mastra/agents/meta-agent.ts:193-240`). |
| `marketingAgent` | `hybrid` | **inferred** — minutes-class drafting/CRM work mixes bounded briefs with side-effecting drafts (`src/mastra/config/agent-board.ts:40-60`). |
| `producerHuntDiscoveryAgent` | `lane_internal` | **inferred** — workflow-local discovery helper (`src/mastra/agents/marketing-agent.ts:119-123`, `src/mastra/workflows/producer-hunt.ts:612-620`). |
| `producerHuntEnrichmentAgent` | `lane_internal` | **inferred** — narrow producer-hunt helper (`src/mastra/agents/marketing-agent.ts:125-129`). |
| `producerHuntEmailExtractionAgent` | `lane_internal` | **inferred** — direct workflow extraction step (`src/mastra/workflows/producer-hunt.ts:1270-1295`). |
| `producerHuntDraftAgent` | `lane_internal` | **inferred** — narrow workflow drafting helper (`src/mastra/agents/marketing-agent.ts:137-141`). |
| `producerHuntJsonRepairAgent` | `lane_internal` | **inferred** — fallback schema-repair helper (`src/mastra/agents/marketing-agent.ts:143-147`). |
| `producerHuntCloudFallbackAgent` | `lane_internal` | **inferred** — workflow-local cloud fallback (`src/mastra/agents/marketing-agent.ts:149-153`). |
| `salesAgent` | `hybrid` | **inferred** — minutes-class CRM/proposal/calendar work includes mutations (`src/mastra/config/agent-board.ts:63-76`). |
| `analyticsAgent` | `interactive_bounded` | **inferred** — sync monitoring/report role (`src/mastra/config/agent-board.ts:79-92`), subject to `AGT-001`. |
| `automationArchitect` | `background_job` | **inferred** — Board marks long builds and recommends async (`src/mastra/config/agent-board.ts:95-118`). |
| `n8nMcpEngineer` | `lane_internal` | **inferred** — architect-only read/validation helper (`src/mastra/config/agent-board.ts:121-134`, `src/mastra/tools/system/delegate-task.ts:295-311`). |
| `codingAgent` | `background_job` | **inferred** — long repo/build/test work with an existing async branch (`src/mastra/config/agent-board.ts:169-191`). |
| `codeReviewAgent` | `lane_internal` | **inferred** — review-only workflow step (`src/mastra/agents/code-review-agent.ts:16-39`, `src/mastra/workflows/repo-maintenance.ts:456-484`). |
| `securityReviewAgent` | `lane_internal` | **inferred** — narrow read/review tool set (`src/mastra/agents/security-review-agent.ts:14-31`). |
| `performanceReviewAgent` | `lane_internal` | **inferred** — narrow read/review tool set (`src/mastra/agents/performance-review-agent.ts:14-31`). |
| `knowledgeAgent` | `background_job` | **inferred** — long batch/deep NotebookLM work (`src/mastra/config/agent-board.ts:137-153`). |
| `researcherAgent` | `hybrid` | **inferred** — bounded lookups plus async deep reads/scrapes (`src/mastra/config/agent-board.ts:214-230`). |
| `deliberationAgent` | `background_job` | **inferred** — strategic debate is declared long but currently sync-only (`src/mastra/config/agent-board.ts:194-211`, `src/mastra/tools/system/delegate-task.ts:702-741`). |
| `chefAgent` | `background_job` | **inferred** — long deterministic menu pipeline (`src/mastra/config/agent-board.ts:233-250`). |
| `contentAgent` | `background_job` | **inferred** — long content-pack pipeline (`src/mastra/config/agent-board.ts:253-266`). |
| `huntAgent` | `background_job` | **inferred** — long discovery/enrichment/outreach pipeline (`src/mastra/config/agent-board.ts:269-282`). |
| `designAgent` | `hybrid` | **inferred** — quick critique versus async full builds (`src/mastra/config/agent-board.ts:285-308`). |
| `writerAgent` | `background_job` | **inferred** — long-form/canon pipeline despite sync Board metadata (`src/mastra/config/agent-board.ts:311-327`). |
| `filmmakerAgent` | `background_job` | **inferred** — premium remote media generation declared sync/long (`src/mastra/config/agent-board.ts:330-343`). |
| `musicianAgent` | `background_job` | **inferred** — premium audio generation declared sync/long (`src/mastra/config/agent-board.ts:372-385`). |
| `capabilitySmith` | `hybrid` | **inferred** — bounded classification plus sandbox/build/approval work (`src/mastra/config/agent-board.ts:346-369`). |

### Execution-profile fingerprints and migration grouping input

The “wave” labels below are **inferred priority groupings**, not an implementation plan.

| Fingerprint | Current members | Observed/static boundary | Inferred wave input |
|---|---|---|---|
| `FP-FRONT-GENERATE-ONLY` | `metaAgent` | Generate-only root harness; stream bypass (`HRN-001`). | **inferred Wave 0/1** — P0 identity/routing gates before channel parity. |
| `FP-DEDICATED-HARNESS` | `codingAgent`, `automationArchitect`, `knowledgeAgent` | Dedicated sync harness plus custom process-local async (`DUR-001`, `BUD-001`). | **inferred Wave 1/2** — durable attempt identity and aggregate deadline. |
| `FP-PIPELINE-LIGHTWEIGHT` | `chefAgent`, `contentAgent`, `huntAgent`, `writerAgent`, `filmmakerAgent`, `musicianAgent` | Bare pipeline generate and wait-only timeout (`HRN-002`, `CAN-002`). | **inferred Wave 2** — background profile retaining pipeline checkpoints. |
| `FP-GENERIC-DIRECT` | `marketingAgent`, `salesAgent`, `analyticsAgent`, `crmAgent`, `researcherAgent`, `designAgent`, `capabilitySmith` | Abortable direct sync plus process-local generic async; `CAN-003` and `AGT-001` constrain confidence. | **inferred Wave 3** — split bounded interaction from durable work per agent. |
| `FP-SPECIAL-SYNC-DIRECT` | `n8nMcpEngineer`, `deliberationAgent` | Dedicated sync-only direct branches. | **inferred Wave 2/3** — keep helper internal; move long deliberation behind a job boundary. |
| `FP-WORKFLOW-LANE` | six producer helpers; three reviewers | Direct workflow/lane generation. | **inferred Wave 4** — inherit parent attempt identity/deadline/fencing. |
| `FP-STANDALONE-BOUNDED` | `weatherAgent` | Focused direct agent outside Board routing. | **inferred Wave 4** — standard bounded contract and memory identity checks. |

### Inferred memory and identity requirements

- **inferred:** require `resourceId` at every user-facing boundary and reject its absence;
  never use `META_AGENT_ID` as user-memory resource. Evidence: `SEC-002`, `MEM-001`.
- **inferred:** separate immutable `taskId`, `jobId`, `attemptId`, and `runtimeRunId`;
  never derive attempt identity from task identity. Evidence: `IDN-001`.
- **inferred:** keep every background attempt's tool trace and working memory in its own
  attempt thread; persist the return route separately. Evidence:
  `src/mastra/services/async-delegation.ts:102-125`.
- **inferred:** declare memory scope explicitly on every memory-enabled agent instead of
  relying on framework defaults. Evidence: `MEM-001`, `SEC-002`.

## Architecture constraints

These are **inferred architecture constraints**, not prescribed implementation steps.

### Routing and isolation constraints

- **inferred constraint:** no user-visible result may be read or consumed without
  `resourceId + conversation/thread + target + message/job` scope. Missing scope must fail
  closed. Evidence: `SEC-001`.
- **inferred constraint:** a persisted thread must have one immutable resource owner, and
  ownership validation must happen before any message write. Evidence: `MEM-001`.
- **inferred constraint:** a user-facing memory call without resource identity must fail
  before memory retrieval or persistence. Evidence: `SEC-002`.

### Execution and durability constraints

- **inferred constraint:** an accepted background job needs durable dispatch, claim/lease,
  checkpoint, recovery, and stale-attempt fencing; a process-local promise is insufficient.
  Evidence: `DUR-001`.
- **inferred constraint:** task/job/attempt/runtime-run identities must remain distinct in
  storage, events, artifacts, deadline state, depth state, and cleanup. Evidence:
  `IDN-001`.
- **inferred constraint:** one absolute deadline and cancellation signal must cover
  precontext, model calls, retries, tools, pipeline phases, postpasses, persistence, and
  terminalization. Evidence: `CAN-001`, `CAN-002`, `CAN-003`, `BUD-001`.
- **inferred constraint:** cancellation success requires observed cessation after a grace
  period and no later message/artifact/side effect; a status flag or rejected wait is not
  proof. Evidence: `CAN-003`.

### Result and event constraints

- **inferred constraint:** only a validated `ok` envelope may terminalize success.
  `partial`, `blocked`, `failed`, empty, prose-only, and malformed outputs must remain
  distinguishable. Evidence: `RES-001`.
- **inferred constraint:** worker completion must atomically enqueue a deduplicated result
  and wake the owning conversation without a new user message. Evidence: `EVT-001`.
- **inferred constraint:** generate, stream, async, pipeline, workflow, and scheduled paths
  may have different execution profiles but must share identity, result, cancel, evidence,
  and terminalization invariants. Evidence: `HRN-001`, `HRN-002`.

### Non-abortable and startup boundaries

- **static_analysis:** the tool envelope discards Mastra execution context
  (`src/mastra/services/harness-tool-envelope.ts:92-154`).
- **static_analysis:** pipeline timeout cannot abort its bare generate
  (`src/mastra/services/generate-pipeline-with-reflection.ts:263-268`,
  `src/mastra/tools/system/delegate-task.ts:1443-1463`).
- **static_analysis:** harness postpasses do not consume the root deadline
  (`src/mastra/services/generate-with-harness.ts:1866-1945`,
  `src/mastra/services/generate-with-harness.ts:2337-2395`).
- **static_analysis:** importing the shared MCP module can create credential/token files
  and configure `npx` subprocess servers (`src/mastra/mcp.ts:37-143`);
  `knowledgeAgent`, `codingAgent`, and `researcherAgent` perform top-level MCP discovery
  (`src/mastra/agents/knowledge-agent.ts:47-54`,
  `src/mastra/agents/coding-agent.ts:47-54`,
  `src/mastra/agents/researcher-agent.ts:30-40`).

### Inferred infrastructure needed for blocked tests

1. **inferred:** a test-owned Mastra process with dedicated port, Mongo database,
   workspace, and report-prefixed fixtures.
2. **inferred:** a sanitized environment disabling real Google/Gmail, n8n management,
   Firecrawl, Playwright, paid media, and import-time MCP subprocess discovery.
3. **inferred:** deterministic no-op model/tool fixtures exposing AbortSignal observation,
   late writes, process IDs, and grace-period activity.
4. **inferred:** a test-owned dispatcher/worker that can be killed at restart checkpoints
   without touching user processes.
5. **inferred:** a local, preinstalled test runner; no `npx` network resolution. Evidence:
   `TST-001`.

### Inferred release gates

1. **inferred P0 gate:** cross-resource C1/C2/R2 tests prove zero memory disclosure,
   zero cross-owner writes, and zero wrongful pending-result consumption (`MEM-001`,
   `SEC-001`, `SEC-002`).
2. **inferred result gate:** invalid/empty/prose/partial/failed/blocked contracts cannot
   become success (`RES-001`).
3. **inferred cancellation gate:** pre-dispatch, model, tool, subprocess, pipeline, and
   postpass cancellation proves actual stop and no late write (`CAN-001`–`CAN-003`,
   `BUD-001`).
4. **inferred durability gate:** restart at each checkpoint yields recovery or one
   deterministic failure, exactly one terminal event, and stale-result rejection
   (`DUR-001`).
5. **inferred identity gate:** concurrent attempts sharing taskId retain distinct run IDs,
   records, budgets, reflectors, events, and artifacts (`IDN-001`).
6. **inferred parity gate:** generate/stream/async/pipeline/workflow/scheduled paths satisfy
   the same invariants (`HRN-001`, `HRN-002`).
7. **inferred wake gate:** completion triggers autonomous review/synthesis and exactly-one
   delivery without another user turn (`EVT-001`).
8. **inferred agent-readiness gate:** the ten repeated empty-output Board agents must return
   non-empty output or explicit typed failure on their intended execution profiles
   (`AGT-001`).

### Unknowns that remain

- Root cause of the ten repeated empty agent outputs (`AGT-001`).
- Exact internal layer allowing cross-resource messages in an already-owned thread
  (`MEM-001`).
- Exact layer that observes an already-aborted signal only after persistence, or ignores it
  (`CAN-003`).
- Dynamic full-Meta A-long/B-quick responsiveness and result routing.
- Actual stop after cancel for wrapped tools, MCP, HTTP, subprocesses, pipelines, and
  harness postpasses.
- Restart recovery, leases, claims, fencing, outbox dedupe, and notification counts.
- Dynamic Meta-path coverage for every Board target.

These remain `unknown`, `NOT_RUN`, or `BLOCKED`; none is converted to `PASS`.
