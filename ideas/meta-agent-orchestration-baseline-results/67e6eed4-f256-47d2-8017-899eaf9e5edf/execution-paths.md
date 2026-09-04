# Execution-path audit — baseline `67e6eed4`

Report ID: `67e6eed4-f256-47d2-8017-899eaf9e5edf`  
Repository: `/projekty/mastra-agentic-environment/agentic-agents`  
Audited commit: `eff419ee54280fb4f517d56833ab8b772fbf485b`  
Method: exhaustive static path audit plus bounded local dynamic probes against disposable Mongo databases and local Ollama models. No external network, workflow, webhook, paid provider, production mutation, or repository implementation change was made.

The audit followed the repository-local Mastra skill and pinned installed documentation/source where framework behavior mattered. Statements remain labelled as observed, static analysis, inferred, unknown, or not run; installed-source inspection is not promoted to dynamic proof.

## Executive result

The current system does **not** have one uniform orchestration boundary.

- The full harness is guaranteed for `meta-agent.generate` and for coding/automation/knowledge calls made through their dedicated helpers. It is not globally installed on every Agent.
- `meta-agent.stream`, every other agent's direct `generate`/`stream`, most workflow-internal Agent calls, scheduled Agent calls, and dynamic `run-worker` calls bypass the full harness.
- Synchronous delegation has four materially different paths: full harness (3 agents), minimal pipeline wrapper (6 agents), direct abortable generate, and workflow trigger. Their timeout, cancellation, GoalContract, memory, telemetry, and completion semantics differ.
- Async delegation is a Mongo status record plus a same-process fire-and-forget Promise. It is not restart-durable and has no claim/lease/attempt/recovery/cancel protocol.
- Pending-result delivery is next-turn polling, not autonomous wake. Consumption is read-then-update, so it is neither atomic nor exactly once; a missing thread ID enables a global cross-thread fallback.
- Scheduled tasks are the strongest durable path (atomic lease and dispatch idempotency record), but there is no lease renewal or fencing. Same-task expired attempts can overlap, stale attempts can overwrite dispatch state, cancellation does not abort active work, and completion has crash windows before next-step/recurrence/wake creation.
- Task Ledger is explicitly observational. Its transitions and digest consumption are not CAS/transactional, and glob-overlap claim acquisition is check-then-insert rather than atomic.
- There is no application-wide `conversationId`. Correlation is assembled from `resourceId`, `threadId`, `taskId`, `runId`, `turnId`, `subtaskId`, and route-specific IDs with inconsistent fallbacks.

Baseline verdict: the required end-to-end invariants (uniform harness behavior, restart survival, parent cancellation, deadline propagation, scoped memory, exactly-once delivery, fenced claims/attempts, and honest completion) are **not established**. Targeted probes additionally observed cross-resource use of one memory thread, pre-aborted calls persisting input, same-task parallel run-ID collapse, and repeated empty direct responses from ten Board agents.

## 1. Generate and stream entry points

| Entry path | Effective execution | Harness/depth/GoalContract | Timeout and cancellation | Static verdict |
|---|---|---|---|---|
| Registered `meta-agent.generate` (Studio/SDK/custom callers resolving the registered instance) | `installMetaAgentHarness` replaces only `generate`, then calls `generateWithHarness` | Full harness | Harness timeout aborts its own model call. Caller `abortSignal` stays inside `generateOptions`, while `generateWithHarness` expects it as a top-level input and overwrites it with its own signal; caller cancellation is therefore lost. | Covered by full harness, but parent cancellation is broken and attachment persistence occurs before the harness deadline/try boundary. Evidence: `src/mastra/agents/meta-agent.ts:135`, `src/mastra/services/meta-harness.ts:24-38`, `src/mastra/services/meta-harness.ts:40-58`, `src/mastra/services/meta-harness.ts:75-89`, `src/mastra/services/generate-with-harness.ts:1352-1365`. |
| `meta-agent.stream` | Original Agent stream method | No full harness wrapper; Agent-level memory/processors still apply | No application harness deadline/GoalContract/reflector/approval wrapper | Bypass. The installer type and mutation mention only `generate`; no stream replacement exists. Evidence: `src/mastra/services/meta-harness.ts:22-34`, `src/mastra/services/meta-harness.ts:91-94`. |
| Any non-meta registered Agent called directly with `generate` | Original Agent generate | No full harness unless the caller explicitly uses a dedicated helper | Caller-specific/SDK behavior | Bypass by default. All agents are registered as normal instances; only meta is monkey-patched. Evidence: `src/mastra/index.ts:1919-1949`, `src/mastra/agents/meta-agent.ts:135`. |
| Any non-meta registered Agent called directly with `stream` | Original Agent stream | No full harness | Caller-specific/SDK behavior | Bypass by default. A concrete workflow uses bare stream. Evidence: `src/mastra/workflows/weather-workflow.ts:151-163`. |
| Custom `/deploy/automation-architect/generate` | Calls `automationArchitect.generate` directly with memory and maxSteps | Does **not** call `generateAutomation` | Route has no shared-harness parent deadline/cancel plumbing | Dedicated-harness bypass despite the route name. Evidence: `src/mastra/index.ts:138-176`. |

The full harness does more than wrap the main model call: adaptive depth, run deadline, GoalContract, telemetry, reflection, review/approval and artifact persistence are assembled in `generateWithHarness` (`src/mastra/services/generate-with-harness.ts:191-250`, `src/mastra/services/generate-with-harness.ts:401-647`). Therefore a bare Agent call is not behaviorally equivalent.

### Full-harness internal gaps

- `runId = input.runId ?? input.taskId ?? randomUUID()` and `threadId = input.threadId ?? input.taskId`. Parallel siblings that share a task ID but pass no run ID share run-scoped depth/deadline/reflector keys. `turnId` alone is unique. Evidence: `src/mastra/services/generate-with-harness.ts:191-196`.
- Depth state and deadline are registered before GoalContract/precontext work, but the main `try/catch` starts later. An exception before that try can leave deadline/depth/reflector state undisposed. Cleanup is duplicated in success/catch rather than guaranteed by one outer `finally`. Evidence: `src/mastra/services/generate-with-harness.ts:204-235`, `src/mastra/services/generate-with-harness.ts:401`, `src/mastra/services/generate-with-harness.ts:628-647`, `src/mastra/services/generate-with-harness.ts:728-731`.
- The main Agent call is abortable, but review, repair, deliberation and goal-completion passes are separate bare Agent calls without the same timeout/abort envelope. Representative evidence: `src/mastra/services/generate-with-harness.ts:1917-1945`, `src/mastra/services/generate-with-harness.ts:2367-2395`, `src/mastra/services/generate-with-harness.ts:2500-2528`.
- Main-call memory uses the resolved thread and `memoryResource ?? agentId ?? harness`, which is correct for task-only callers (`src/mastra/services/generate-with-harness.ts:806-816`). Some post-pass code gates memory on raw `input.threadId`, so a task-only call can still omit memory on a later pass (`src/mastra/services/generate-with-harness.ts:1922-1929`).

## 2. Delegation paths

The delegate tool itself is wrapped by `withToolEnvelope`. That wrapper returns a one-argument function and never receives Mastra's ToolExecutionOptions/AbortSignal; it synthesizes only harness metadata before calling the underlying execute function. Thus a caller disconnect/cancel cannot propagate through the delegate tool boundary. Evidence: `src/mastra/services/harness-tool-envelope.ts:92-104`, `src/mastra/services/harness-tool-envelope.ts:112-154`.

| Target/path | Execution gateway | Semantics and gaps |
|---|---|---|
| `codingAgent` sync | `generateCoding` → full shared harness | 300 s static timeout, delegation thread used as task/thread. Evidence: `src/mastra/tools/system/delegate-task.ts:398-409`, `src/mastra/services/coding-harness.ts:23-47`. |
| `automationArchitect` sync | `generateAutomation` → full shared harness | Default automation budget can be much longer than the parent; unlike generic paths this branch is handled before generic parent-budget coordination. Evidence: `src/mastra/tools/system/delegate-task.ts:436-490`, `src/mastra/services/automation-harness.ts:24-45`. |
| `knowledgeAgent` sync | `generateKnowledge` → full shared harness | 300 s static timeout, dedicated precontext/memory. Evidence: `src/mastra/tools/system/delegate-task.ts:549-594`, `src/mastra/services/knowledge-harness.ts:24-42`. |
| Six generic pipeline agents: chef/content/hunt/writer/filmmaker/musician | `generatePipelineWithReflection` | Minimal reflector/phase wrapper only; explicitly excludes depth, hard stop, GoalContract triggers and output scoring. Outer timeout is a non-aborting `Promise.race`, so a timed-out pipeline can continue mutating. Evidence: `src/mastra/config/pipeline-phase-tools.ts:49-426`, `src/mastra/tools/system/delegate-task.ts:798-844`, `src/mastra/services/generate-pipeline-with-reflection.ts:1-20`, `src/mastra/services/generate-pipeline-with-reflection.ts:95-107`, `src/mastra/services/generate-pipeline-with-reflection.ts:263-268`, `src/mastra/tools/system/delegate-task.ts:1443-1463`. The phase map also contains automation, but that target is intercepted earlier by its dedicated full-harness branch. |
| `n8nMcpEngineer` | Direct `generateWithAbortableTimeout` | Sync-only, memory present, step cap 8/default config, parent-budget capped. No full harness. Evidence: `src/mastra/tools/system/delegate-task.ts:295-310`, `src/mastra/tools/system/delegate-task.ts:621-637`. |
| `deliberationAgent` | Direct `generateWithAbortableTimeout` | Sync-only direct generate, memory present, parent-budget capped. No full harness. Evidence: `src/mastra/tools/system/delegate-task.ts:702-717`, `src/mastra/tools/system/delegate-task.ts:744-750`. |
| All remaining sync agents | Direct `generateWithAbortableTimeout` | Own timeout AbortController and parent-budget cap, but no full harness. Because tool runtime cancellation is lost at the envelope, only the locally-created timeout can abort. Evidence: `src/mastra/tools/system/delegate-task.ts:744-861`, `src/mastra/tools/system/delegate-task.ts:1472-1505`. |
| Generic/dedicated async | `startAsyncDelegation` | Returns success immediately; execution/delivery analysis is in §4. Evidence: `src/mastra/tools/system/delegate-task.ts:360-380`, `src/mastra/tools/system/delegate-task.ts:442-478`, `src/mastra/tools/system/delegate-task.ts:549-568`, `src/mastra/tools/system/delegate-task.ts:759-777`. |

Delegation identity defaults are `delegationThreadId = context.threadId || delegation-UUID`, resource `context.resourceId || META_AGENT_ID`, return thread `returnToThreadId ?? callerThreadId ?? context.threadId`, and origin thread the return thread unless explicit. Evidence: `src/mastra/tools/system/delegate-task.ts:265-277`.

Structured completion is also inconsistent. The synchronous outer wrapper parses a ResultEnvelope, but prose fallback is treated as `status: ok`; only parsed `failed` and `blocked_needs_approval` force `success=false`, while `partial` remains successful. Evidence: `src/mastra/tools/system/delegate-task.ts:936-990`. Async completion never applies this parser and marks any resolved output successful.

## 3. Workflow and parallel paths

- `workflow_trigger` resolves a workflow, creates a run, and synchronously awaits `run.start`; it has no application timeout, AbortSignal, async handoff, or recovery wrapper. The SDK supplies the run ID. Evidence: `src/mastra/tools/system/trigger-workflow.ts:22-47`.
- Many workflow steps call agents directly: analytics (`src/mastra/workflows/analytics/weekly-report.ts:129`, `src/mastra/workflows/analytics/trend-analysis.ts:299`, `src/mastra/workflows/analytics/roi-calculator.ts:178`), marketing (`src/mastra/workflows/marketing/automated-followup.ts:99`, `src/mastra/workflows/marketing/inbox-monitor.ts:140`, `src/mastra/workflows/marketing/morning-briefing.ts:105`), sales (`src/mastra/workflows/sales/proposal-generator.ts:98`, `src/mastra/workflows/sales/meeting-scheduler.ts:145`, `src/mastra/workflows/sales/onboarding-checklist.ts:141`), producer-hunt (`src/mastra/workflows/producer-hunt.ts:367`, `src/mastra/workflows/producer-hunt.ts:1276-1294`), and weekly content (`src/mastra/workflows/weekly-content.ts:1108`). These calls do not gain the full harness merely because the outer code is a workflow.
- Weather uses a bare stream and therefore demonstrates the stream bypass concretely (`src/mastra/workflows/weather-workflow.ts:151-163`).
- Repo maintenance is the positive exception: it calls the coding dedicated harness (`src/mastra/workflows/repo-maintenance.ts:65-101`).
- Parallel coding dispatch uses `Promise.allSettled` and passes the same outer `taskId` to every subtask (`src/mastra/services/parallel-dispatch.ts:164-168`, `src/mastra/services/subtask-executor.ts:161-180`). Since the full harness defaults run ID to task ID, sibling runs can collide in run-scoped state unless a unique run ID is supplied.
- Mastra workflow persistence/restart behavior is framework-owned and cannot be proven by this application-only static read. It must be measured by the baseline restart test; application code adds no cross-process cancellation or deadline protocol around `run.start`.

## 4. Async delegation, pending delivery, and wake semantics

### Async delegation is not restart durable

`startAsyncDelegation` inserts a Mongo row and then starts `void executeDelegation(...)` in the current Node process. There is no durable queue, claim, lease, heartbeat, attempt ID, reaper/recovery scan, or cancellation API. A crash after insert leaves a `running` row with no worker; a crash before insert completion cannot be recovered. Evidence: `src/mastra/services/async-delegation.ts:99-159`.

Special targets use their dedicated harnesses, while generic async targets use direct abortable generate (`src/mastra/services/async-delegation.ts:192-251`). On completion, the delegation row is marked completed **before** the pending result is queued (`src/mastra/services/async-delegation.ts:258-305`). `queuePendingMessage` catches insert errors and returns `undefined` (`src/mastra/services/pending-message-queue.ts:81-103`), so this ordering can permanently produce `completed` with no deliverable. There is no outbox or retry.

### Delivery is at-most-best-effort, not exactly once

- Pending message IDs are random and have no deterministic idempotency/deduplication key. The schema scopes only task/thread/target agent, not resource/conversation/tenant. Evidence: `src/mastra/services/pending-message-queue.ts:54-79`.
- Consumption does `find(...pending)` and then a separate `markConsumed`; two consumers can read and return the same documents. Evidence: `src/mastra/services/pending-message-queue.ts:106-149`.
- If both task and thread are supplied, scope is `$or`, not a conjunction. Evidence: `src/mastra/services/pending-message-queue.ts:215-219`.
- The input processor consumes pending updates only when a later Agent turn starts. Without a thread ID it queries all pending background/automation messages for the target agent and marks them consumed, permitting cross-thread/cross-resource delivery. Evidence: `src/mastra/processors/pending-updates.ts:67-113`.
- The explicit `check_pending_updates` tool is another competing poller with similar read-then-update behavior. There is no autonomous Meta turn or wake loop.

Therefore "delivered automatically" in delegation responses means "injected on a future interaction if a consumer finds it", not active wake or exactly-once handoff.

## 5. Scheduled tasks

Positive controls:

- A due task is leased atomically with a unique lease ID; expired leased/running rows can be reclaimed and the retry counter increments at lease time. Completion/failure can be scoped by lease ID. Evidence: `src/mastra/services/scheduled-task-store.ts:174-283`.
- Non-worker-command targets get a unique dispatch idempotency record and completed results can replay. Evidence: `src/mastra/services/scheduled-task-store.ts:374-447`, `src/mastra/scripts/scheduled-task-runner.ts:199-234`.

Gaps that invalidate a strict durability/exactly-once claim:

- Lease is fixed (default 10 minutes); the runner has no renewal/heartbeat. A task longer than the lease can be leased by another runner. Evidence: `src/mastra/services/scheduled-task-store.ts:160-179`, `src/mastra/scripts/scheduled-task-runner.ts:65-96`.
- An existing `running` dispatch blocks only when it belongs to a **different** task ID. A second expired attempt of the same task refreshes and dispatches even while the first process may still run. Evidence: `src/mastra/services/scheduled-task-store.ts:410-447`.
- Dispatch completion/failure updates by only `idempotencyKey`; there is no attempt/lease/fencing token, so a stale attempt can overwrite a newer one. Evidence: `src/mastra/services/scheduled-task-store.ts:450-493`.
- `WORKER_COMMAND` explicitly has no dispatch idempotency key. Evidence: `src/mastra/services/scheduled-task-store.ts:374-385`.
- After side-effect dispatch, the runner separately writes chain result, marks task complete, creates next step, creates recurrence, and queues wake. Crashes can duplicate a side effect before dispatch completion or permanently lose next/recurrence/wake after the task becomes terminal. Evidence: `src/mastra/scripts/scheduled-task-runner.ts:96-138`, `src/mastra/scripts/scheduled-task-runner.ts:199-230`.
- Scheduled cancellation changes Mongo status and unsets the lease; it does not abort a live Agent/workflow/webhook execution. Evidence: `src/mastra/services/scheduled-task-store.ts:309-324`.
- Scheduled Agent execution is direct `agent.generate`, with thread `scheduled-task-${taskId}` and resource fallback `META_AGENT_ID`; it passes no run/attempt ID, timeout, or AbortSignal. Evidence: `src/mastra/scripts/scheduled-task-runner.ts:367-397`.
- Wake is another pending message created only after completion and needs an existing future turn. Evidence: `src/mastra/scripts/scheduled-task-runner.ts:471-509`.

## 6. Detached background commands

`background-task-manager` spawns a detached shell **before** inserting its Mongo record. A DB failure can orphan the process. It tracks children in an in-memory map and attaches exit listeners in the originating process; after restart, those listeners and the map are gone. Evidence: `src/mastra/services/background-task-manager.ts:101-165`.

Status recovery only checks PID liveness and a status file; the detached child itself does not write that status file, so after parent restart an exited process can degrade to `unknown`. Evidence: `src/mastra/services/background-task-manager.ts:204-227`, `src/mastra/services/background-task-manager.ts:434-465`.

Cancellation sends best-effort SIGTERM and immediately marks the row cancelled without waiting for confirmed exit or escalating to SIGKILL. The original exit handler updates by only task ID and can later overwrite cancelled with completed/failed. Evidence: `src/mastra/services/background-task-manager.ts:318-382`, `src/mastra/services/background-task-manager.ts:434-458`. Wake is emitted only by that original exit handler (`src/mastra/services/background-task-manager.ts:495-518`), so it is lost across parent restart.

## 7. Task Ledger and resource claims

Task Ledger declares itself observational; it does not own execution (`src/mastra/services/task-ledger.ts:1-18`). The unique `(source, sourceId)` index is useful (`src/mastra/services/task-ledger.ts:136-145`), but:

- A transition reads state, validates it, then updates by lane ID without expected-state/version in the predicate. Concurrent transitions can both validate stale state and overwrite. Evidence: `src/mastra/services/task-ledger.ts:216-249`.
- Finished digest consumption reads undigested rows then separately sets `digestedAt`; concurrent readers can both return the same lanes. Evidence: `src/mastra/services/task-ledger.ts:362-409`.
- Push notifications are fire-and-forget HTTP with no outbox, retry, or dedupe and are not a Meta wake. Evidence: `src/mastra/services/task-ledger.ts:449-474`.
- Async delegations explicitly have no heartbeat loop (`src/mastra/services/async-delegation.ts:143-154`), so ledger staleness is a timer, not proof of ownership/liveness.

Claim locks have a unique exact-claim key, but glob overlaps are detected by a read scan before inserts. Two distinct overlapping glob strings can race and both acquire. Acquisition is compensating rather than transactional, there is no renewal or fencing token, and the upsert updates `expiresAt` before confirming the existing lock belongs to this lane. Evidence: `src/mastra/services/task-ledger-scheduler.ts:115-189`. Polling cancellation is only an optional synchronous callback, not an AbortSignal (`src/mastra/services/task-ledger-scheduler.ts:207-239`). The file documents that full preemption/enforcement is not implemented (`src/mastra/services/task-ledger-scheduler.ts:20-22`).

## 8. Dynamic `run-worker`

`run-worker` builds an ad-hoc text-only Agent and calls bare `worker.generate(systemPrompt)` with no memory, timeout, AbortSignal, full harness, task/thread/resource/run correlation, or durable execution record. Worker and telemetry IDs use `Date.now()`, so same-millisecond calls can collide. Evidence: `src/mastra/tools/system/run-worker.ts:140-169`, `src/mastra/tools/system/run-worker.ts:223-235`.

`attemptNumber` is model/tool input constrained to 1–3, not a server-managed attempt/fencing identity (`src/mastra/tools/system/run-worker.ts:120-128`). Depending on the selected model preset this path can incur paid model usage, but cost/budget cancellation is not coupled to a parent run.

## 9. Identifier and isolation matrix

| Identifier | Creation/fallback | Isolation/durability consequence |
|---|---|---|
| `conversationId` | No execution-code use found. `rg` finds only NotebookLM documentation references. | There is no single conversation key to bind task, thread and resource. |
| `resourceId` | Meta: `memory.resource ?? META_AGENT_ID`. Delegation: `context.resourceId ?? META_AGENT_ID`. Scheduled Agent: `task.resourceId ?? META_AGENT_ID`. | Omitted resource collapses callers into an agent-global resource namespace; this is unsafe for multi-user/tenant memory. Evidence: `src/mastra/services/meta-harness.ts:75-89`, `src/mastra/tools/system/delegate-task.ts:268-277`, `src/mastra/scripts/scheduled-task-runner.ts:379-384`. |
| `threadId` | Meta: memory thread or task ID. Delegation: caller-supplied thread or new delegation UUID. Async target: explicit target or `async-delegation-${delegationId}`. Scheduled: `scheduled-task-${taskId}`. | Mostly stable per task/delegation, but pending fallback can consume without it; post-harness passes can omit task-derived memory. |
| `taskId` | Full harness accepts caller task; meta creates `meta-UUID`; delegation commonly uses delegation thread; scheduled creates UUID. | Overloaded as goal key, run fallback and sometimes thread. Parallel children sharing it collide in run-scoped registries. |
| `runId` | Full harness: explicit → task ID → UUID. Pipeline: fresh `pipeline-UUID`. Workflow: SDK run ID. Run-worker: timestamp string. Scheduled Agent: none passed. | Not globally unique when task ID or millisecond timestamp is reused; absent on several paths. |
| `turnId` / `subtaskId` | Harness creates UUID turn ID; subtask is caller supplied. | Turn is unique, but run-scoped maps still use colliding run ID. |
| route-specific work IDs | Async `delegationId`, background `taskId`, scheduled `taskId`, ledger `laneId`, claim string. | Each is independently generated; there is no mandatory parent/attempt/fencing chain across stores. |
| attempt | Scheduled has numeric `retry.attempt`; run-worker accepts model-provided `attemptNumber`; other routes have none. | No globally unique attempt ID/fencing token; stale completion cannot be rejected consistently. |

## 10. Cancellation and restart matrix

| Path | Parent/user cancellation | Timeout aborts work? | Restart survival | Completion/delivery |
|---|---|---|---|---|
| Meta full generate | Caller signal lost by wrapper plumbing | Main model call: yes; pre/post work: incomplete | No resume protocol for in-flight harness | Harness writes telemetry/artifacts; no exactly-once final delivery contract |
| Dedicated sync delegation | Tool runtime signal lost | Own harness main call: yes | No resume | Sync response, ResultEnvelope parser only at outer tool |
| Generic direct sync | Tool runtime signal lost | Locally-created timeout: yes, cooperative | No resume | Sync response |
| Pipeline sync | Tool runtime signal lost | **No**; outer race only | No resume | Sync response; timed-out work may continue |
| Async delegation | No cancel API | Local timeout for child only | **No**; same-process Promise | Pending queue, non-atomic and next-turn only |
| Workflow trigger | No signal passed | No application timeout | Framework-owned/unknown | Synchronously awaited result |
| Scheduled task | DB cancel only | No shared abort | Lease permits reclaim, but overlap/fencing gaps | Multi-write completion and pending wake crash windows |
| Detached background command | Operator SIGTERM best effort | TTL is retention/stale horizon, not kill deadline | Child can survive, tracking/wake cannot | Exit-listener dependent |
| Run-worker | No signal passed | No timeout | No | Direct text result only |

## 11. Existing package-script inventory and safe candidates

The complete machine-readable inventory is in `/tmp/agent-baseline-67e6eed4-test-classification.json`.

- Matching scripts: **47**
- Direct TypeScript targets: **45**
- Composites: **2** (`check:all`, `check:automation`)
- Marked safe under documented conditions: **21**
- Marked unsafe without isolation/approval: **26**
- Executed during the complete baseline: **21 source/deterministic candidates** (20 passed, `audit:harness` failed as expected), plus four isolated fake-model harness checks, TypeScript typecheck, two direct local-provider controls, direct agent smokes, and one parallel same-task harness probe. Individual records are in `test-runs.jsonl`.

Safe source-only/deterministic candidates:

1. `check:agent-board-sync`
2. `check:meta-prompt-size`
3. `check:result-envelope-parse`
4. `check:graphify-affected-parse`
5. `check:automation-coverage`
6. `check:automation-patterns`
7. `audit:harness`
8. `check:automation-delegation-contract`
9. `check:n8n-mcp-engineer`
10. `check:meta-final-synthesis`
11. `check:strategy-reflector`
12. `check:pipeline-reflector`
13. `check:writer-domain` (writes and removes a fresh `/tmp` directory)
14. `check:design-domain`
15. `check:filmmaker-domain`
16. `check:musician-domain`
17. `e2e:reflector-prepare-step` (local mock model)
18. `e2e:reflector-stop-when` (local mock model)
19. `check:depth-controller`
20. `check:command-approval-gate`
21. `check:agent-generate-memory-thread`, **only** with `RUN_AGENT_MEMORY_THREAD_LIVE` unset/false

Mock-model checks that write harness state were executed only after redirecting them to a dedicated disposable database and confirming teardown. Unsafe/live candidates remained unexecuted.

High-risk test-inventory findings:

- `check:ledger-claims-conflict` cleanup deletes claim locks by `laneId: /^lane-/`, potentially affecting unrelated live lanes (`src/mastra/scripts/check-ledger-claims-conflict.ts:36-41`).
- `e2e:artifact-handoff` creates a large artifact file but cleans only Mongo rows, leaving an orphan under the default `.mastra/artifacts` (`src/mastra/scripts/e2e-artifact-handoff.ts:94-127`, `src/mastra/services/artifact-store.ts:61-104`).
- `check:automation-live-safe-webhook` uses a live model, inserts approval, activates an n8n workflow and triggers its webhook, with no cleanup (`src/mastra/scripts/live-safe-automation-webhook.ts:48-120`).
- `check:n8n-mcp-pipeline-smoke` is not database-free in its default coverage-block mode because Golden Path finalization records failure learning (`src/mastra/scripts/check-n8n-mcp-pipeline-smoke.ts:39-67`, `src/mastra/services/automation-golden-path.ts:197-207`).
- `check:cognitive-loop-dry-run`, `check:meta-harness-wrapper`, and `check:harness-depth` use fake models but write full harness state to Mongo and do not clean it.
- `check:scheduled-tasks` creates persistent indexes in addition to fixture rows, and can invoke a live n8n webhook when `CHECK_SCHEDULED_TASK_N8N_WEBHOOK_PATH` is set (`src/mastra/scripts/check-scheduled-task-orchestrator.ts:248-315`).

## 12. Baseline tests that must be added or strengthened

The existing suite has useful unit/static coverage, but it does not establish the plan's critical cross-path invariants. Highest-priority baseline probes:

1. Generate-vs-stream parity for meta and a non-meta agent, asserting depth, GoalContract, telemetry, memory, deadline and approval behavior.
2. Cancellation from HTTP/tool execution through meta → delegate → child, including a side-effect tool that proves no write occurs after cancel.
3. Pipeline timeout with a cooperative/non-cooperative tool, proving the underlying Agent stops rather than only the waiter.
4. Async delegation restart after each boundary: before/after row insert, after child start, after result row update, before/after queue insert.
5. Two concurrent pending consumers, plus missing-thread multi-resource cases, asserting no duplicate/cross-thread delivery.
6. Scheduled lease expiry with two workers and a long side effect; assert a fencing token rejects stale completion.
7. Scheduled crash injection at every completion boundary (dispatch record, task completion, next step, recurrence, wake).
8. Background parent restart and cancel/exit race.
9. Concurrent ledger transitions/digest readers and overlapping glob claim acquisition.
10. Parallel sibling run-ID uniqueness and isolation of depth/deadline/reflector state.
11. Honest completion across prose, partial, blocked and failed ResultEnvelope states on sync, async, workflow, scheduled and run-worker paths.

## 13. Dynamic observations added to the path audit

- **Direct local-provider control:** `gemma4:e4b` and `gemma4:12b` each returned non-empty `DIRECT_OK`, so local model reachability was established without external network use.
- **Direct Agent interface:** 13/29 registered agents (13/18 Board targets) were invoked with `maxSteps: 1`, `toolChoice: none`, unique resource/thread identities, and disposable databases. Sales, CRM, and Writer returned non-empty output; ten Board agents returned empty text in two independent runs with zero tool calls. Root cause remains unknown.
- **Generate/stream parity:** Sales produced non-empty `DIRECT_OK` through both direct generate and direct stream on `gemma4:12b`. This is interface parity for that narrow probe, not harness parity.
- **Memory boundary:** one Sales thread created for resource A accepted a later turn under resource B. The thread owner stayed A while stored messages contained both resource identities. The database was inspected before teardown; this is an observed cross-resource isolation failure.
- **Cancellation boundary:** a pre-aborted direct Sales generate completed normally in 18–19 ms and persisted the user turn in three of three trials. The result does not prove continued model work, but it disproves fail-before-mutation behavior at this entry point.
- **Parallel run identity:** two overlapping `generateWithHarness` calls with the same `taskId` and no explicit `runId` used one runtime run ID and one `agent_runs` row, with two start events, two completion events, and two output artifacts. Both model calls completed; mutable run state was not isolated.
- **Restart recovery and autonomous wake:** not dynamically exercised because doing so safely required a test-owned isolated HTTP runtime, worker lifecycle, and completion consumer not present in the preflight environment. Static path findings therefore remain the evidence source for those capabilities.
12. Resource/thread isolation with omitted IDs; the expected behavior should fail closed rather than use `META_AGENT_ID` as a shared user resource.

These tests require isolated Mongo collections/database names and unique report-prefixed IDs; any live LLM, external read/write, paid, or process-control case must remain opt-in and separately approved.
