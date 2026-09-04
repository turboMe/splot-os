# Universal Task Orchestrator

> Status: MVP + hardening implemented on 2026-06-26. Source plan: `ideas/universal-task-orchestrator.md`.

Universal Task Orchestrator gives the meta-agent a durable way to schedule future, delayed, recurring, and chained work inside the Mastra runtime. It does not depend on an external Claude scheduler or a generated `SKILL.md`; tasks are stored in MongoDB and executed by a local runner process.

## Runtime Flow

```text
metaAgent / other system code
  -> schedule_task
  -> MongoDB scheduled_tasks
  -> npm run scheduled-tasks
  -> dispatcher
      -> AGENT: mastra.getAgent(registryKey).generate(...)
      -> MASTRA_WORKFLOW: workflow.createRun().start(...)
      -> N8N_WEBHOOK: N8nService.triggerWebhook(...)
      -> WORKER_COMMAND: safe internal aliases only
  -> MongoDB task_chains
  -> optional pending_user_messages wake-up
```

## Main Files

| Area | File |
| --- | --- |
| Scheduled task store | `src/mastra/services/scheduled-task-store.ts` |
| Chain result store | `src/mastra/services/task-chain-store.ts` |
| Scheduler tool | `src/mastra/tools/system/schedule-task.ts` |
| Management tools | `src/mastra/tools/system/scheduled-task-management.ts` |
| Chain tools | `src/mastra/tools/system/task-chain-tools.ts` |
| Thread context fallback | `src/mastra/tools/system/get-thread-context.ts` |
| Dashboard serializer | `src/mastra/services/scheduled-task-dashboard.ts` |
| Runner and dispatcher | `src/mastra/scripts/scheduled-task-runner.ts` |
| Runner supervisor | `scripts/scheduled-task-runner-supervisor.sh` |
| Smoke test | `src/mastra/scripts/check-scheduled-task-orchestrator.ts` |
| Meta-agent registration | `src/mastra/agents/meta-agent.ts` |
| Mongo indexes | `src/mastra/lib/mongo.ts`, `src/mastra/lib/mongo-indexes.ts`, `src/mastra/scripts/init-db.ts` |

## Tools

`schedule_task` creates a durable scheduled task. Required fields are:

- `fireAt` or `cronExpression`
- `targetType`: `AGENT`, `MASTRA_WORKFLOW`, `N8N_WEBHOOK`, or `WORKER_COMMAND`
- `targetIdentifier`: agent registry key, workflow id, n8n webhook path, or worker alias
- `promptOrInstruction`: concrete instruction and success criteria

Recommended fields for chained work:

- `chainName`
- `stepName`
- `chainId`
- `parentThreadId`
- `resourceId`
- `wake`
- `nextStep`
- `idempotencyKey` for side-effecting targets

`get_chain_context` reads previous chain results from `task_chains`.

`save_chain_result` stores a manual step result for later chain steps.

`get_thread_context` reads recent messages from `mastra_threads` / `mastra_messages`. It is a deterministic Mongo fallback and returns `semanticSearchUsed: false`.

Management tools:

- `list_scheduled_tasks`
- `get_scheduled_task`
- `cancel_scheduled_task`
- `reschedule_scheduled_task`

## Runner

Run the scheduler worker with:

```bash
npm run scheduled-tasks
```

Run it under the lightweight supervisor with:

```bash
npm run scheduled-tasks:supervisor
npm run scheduled-tasks:once
npm run scheduled-tasks:status
```

Useful environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCHEDULED_TASK_RUNNER_ID` | generated from pid | Stable runner id for leases |
| `SCHEDULED_TASK_RUNNER_INTERVAL_MS` | `15000` | Poll interval when no task was processed |
| `SCHEDULED_TASK_RUNNER_BATCH` | `5` | Max due tasks per tick |
| `SCHEDULED_TASK_RUNNER_ONCE` | unset | Set to `1` for one-shot execution |

The runner leases due tasks atomically, marks them running, dispatches the target, writes `task_chains`, marks completion or retry/failure, then optionally queues a pending update for `checkPendingUpdates`.

## Dashboard API

Read/manage scheduled tasks through:

| Endpoint | Purpose |
| --- | --- |
| `GET /dashboard/scheduled-tasks?status=&chainId=&targetType=&limit=50` | list tasks and status counts |
| `GET /dashboard/scheduled-tasks/:taskId` | read one task |
| `POST /dashboard/scheduled-tasks/:taskId/cancel` | cancel scheduled/leased/running task |
| `POST /dashboard/scheduled-tasks/:taskId/reschedule` | move scheduled/failed/cancelled task to new `fireAt` or `cronExpression` |

`/dashboard-ui` and `/workspace-ui` both expose a Scheduler tab backed by these endpoints.

## Safety Boundaries

- `targetIdentifier` for `AGENT` is the Mastra registry key, for example `metaAgent`, `automationArchitect`, `codingAgent`, not necessarily `agent.id`.
- `WORKER_COMMAND` is allowlisted to safe aliases: `noop`, `echo_payload`, and `fail` for tests.
- Side effects such as sending email, deployment, purchases, destructive DB writes, or public posts must be approved before scheduling.
- `AGENT`, `N8N_WEBHOOK`, and `MASTRA_WORKFLOW` dispatches use `scheduled_task_dispatches` idempotency records. The idempotency key is either explicit or derived from `targetType:targetIdentifier:taskId`; downstream webhook/workflow payloads also receive it.

## Verification

```bash
npm run check:scheduled-tasks
npm run build
```

The smoke test creates due `WORKER_COMMAND` tasks, validates retry and `nextStep`, exercises fake `AGENT` and `MASTRA_WORKFLOW` dispatches, verifies dispatch idempotency replay, checks management tools, reads `get_chain_context` / `get_thread_context`, and cleans up its test documents.

Optional live n8n smoke:

```bash
CHECK_SCHEDULED_TASK_N8N_WEBHOOK_PATH=<webhook-path> npm run check:scheduled-tasks
```

Known follow-ups:

- stronger downstream idempotency integration for specific external services that support native idempotency headers
- richer dashboard actions such as bulk cancel and chain timeline visualization
