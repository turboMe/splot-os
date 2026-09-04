# Analytics Dashboard V2

Status: implemented 2026-06-23.

Analytics V2 is the read-only operational dashboard API used by `/dashboard-ui`.
It aggregates Mongo telemetry from `agent_events`, `tool_executions`, `mastra_scorers`
and related trace identifiers into canonical agent/model/tool/quality views.

## Runtime Cache

V2 aggregations are protected by a short in-memory cache in
`src/mastra/services/dashboard-analytics-v2.ts`.

Environment variables:

```env
DASHBOARD_V2_CACHE_TTL_MS=15000
DASHBOARD_V2_CACHE_MAX_ENTRIES=250
```

Behavior:

- TTL defaults to 15 seconds; set `DASHBOARD_V2_CACHE_TTL_MS=0` to disable.
- Cache keys include endpoint name, time window, granularity and filters.
- Concurrent identical requests share the same pending promise.
- Failed aggregation promises are evicted immediately.
- Cache is process-local and expires only by TTL or max-entry pruning.

Keep this cache short. The dashboard is used for live telemetry, so long TTLs can
hide active failures.

## Common Query Parameters

All endpoints support:

| Parameter | Example | Notes |
| --- | --- | --- |
| `since` | `7d`, `24h`, `2026-06-20` | Defaults to last 7 days. |
| `until` | `2026-06-23` | Optional absolute upper bound. |
| `agentId` | `meta-agent` | Canonical agent filter. |
| `model` | `deepseek-v4-pro` | Canonical model filter. |
| `toolCategory` | `network` | Tool envelope category filter. |
| `toolRisk` | `high` | Tool envelope risk filter. |
| `toolStatus` | `failed` | Tool envelope status filter. |

Trace endpoints also support:

| Parameter | Example | Notes |
| --- | --- | --- |
| `runId` | `run_...` | Trace resolver key. |
| `taskId` | `task_...` | Trace resolver key. |
| `threadId` | `thread_...` | Trace resolver key. |
| `status` | `failed` | Trace status filter. |
| `limit` | `25` | Trace list limit. |

## Endpoint Contract

Base path: `/dashboard`.

| Endpoint | Response | Purpose |
| --- | --- | --- |
| `GET /v2/summary` | `DashboardV2Summary` | Executive health strip, deltas and alerts. |
| `GET /v2/agents` | `{ data, window }` | Canonical agent rollups with success, latency, tools, tokens and cost. |
| `GET /v2/models` | `{ data, window }` | Model FinOps rollups, pricing gaps, aliases and token/cost shares. |
| `GET /v2/latency` | `{ data, window }` | Overall and per-agent latency percentiles plus slowest runs/events. |
| `GET /v2/timeline` | `{ data, window }` | Health timeline buckets and annotations. |
| `GET /v2/tools` | `{ data, window }` | Tool envelope status, category, risk, policy and hanging executions. |
| `GET /v2/skills` | `{ data, window }` | Skill operations from tool envelopes plus legacy skill events. |
| `GET /v2/quality` | `{ data, window }` | Scorer coverage, pass rates, failures, gaps and previous-window trend. |
| `GET /v2/traces` | `{ data, window }` | Trace summaries for Trace Explorer. |
| `GET /v2/traces/:id` | `{ data, window }` or `404` | Trace detail resolved by trace id, event id, run id, task id, thread id or turn id. |

`/v2/timeline` also supports `granularity=hour|day`. Invalid values fall back to
`day`.

## Visual Regression Checklist

Run after UI or analytics layout changes:

```bash
npm run build
npm run dev
```

Open `http://localhost:4111/dashboard-ui`, switch to Analytics, then capture:

- Desktop top view: health strip, filters, alerts, first charts.
- Desktop mid view: agents/models, latency, timeline annotations.
- Desktop trace view: Trace Explorer list/detail and Live rail open/closed.
- Mobile/narrow view: filters wrap correctly, tables scroll, Live rail does not
  cover primary content.

Suggested screenshot paths:

```text
/tmp/mastra-analytics-v2-desktop-top.png
/tmp/mastra-analytics-v2-desktop-mid.png
/tmp/mastra-analytics-v2-desktop-traces.png
/tmp/mastra-analytics-v2-mobile.png
```

Acceptance points:

- No runtime console errors through one full refresh cycle.
- Section-level errors stay local to the failing section.
- Drill-down links still open Trace Explorer or apply global filters.
- Charts do not overlap tables on desktop or narrow viewports.
- Live rail opens and closes without leaking into other dashboard tabs.
