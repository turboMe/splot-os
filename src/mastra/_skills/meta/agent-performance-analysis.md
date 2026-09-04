---
name: agent-performance-analysis
category: meta
description: Framework for analyzing agent system performance using system.agent_performance_report tool. Covers when to investigate, which metrics matter, how to interpret latency/cost/scorer data, and how to recommend remediation. Trigger: "how is the system doing", "performance report", "cost report", "which agent is slowest", "how much did we spend", "performance report", "which skill", "regression check", "drift detection".
keywords: [performance, evaluation, analytics, cost, latency, scorers, monitoring, drift, agents]
allowedTools: [system_agent_performance_report, db_query]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1700
outputFormat: markdown
tags: [meta, performance, evaluation, observability]
version: 1
success_rate: 0
total_uses: 3
last_used: 2026-08-18
handoffCapable: true
---
# Agent Performance Analysis

> Use `system.agent_performance_report` as the primary tool.
> Default window: 7 days. Adjust based on user's question.
> Always present findings as actionable insights, not raw numbers.

## When to Use This Skill

- "How is the system doing?" / "Status of agents"
- "Cost report" / "How much did we spend"
- "Which agent is slowest / failing most?"
- "Which skill is most used?"
- After deployment — verify nothing regressed
- Weekly review — proactive system health check
- Cost surge investigation

## Step 1 — Pick the Right Window

| User question | Suggested `since` |
|---------------|-------------------|
| "Right now" / "Today" | `24h` |
| "This week" | `7d` (default) |
| "Last month" | `30d` |
| "Compare to last week" | Two calls: `7d` + `14d`, then diff |
| "Since deployment" | ISO date when deploy happened |

## Step 2 — Pick the Right Breakdowns

Default breakdown is `["agents", "cost"]`. Add more for deeper analysis:

| Question | Breakdowns to include |
|----------|----------------------|
| Cost / spending | `["cost", "models"]` |
| Latency complaints | `["latency", "agents"]` |
| Quality regression | `["scores", "agents"]` |
| Skill usage | `["skills"]` |
| Full health check | all 6 |

```javascript
system.agent_performance_report({
  since: "7d",
  includeBreakdown: ["agents", "models", "cost", "latency", "scores"]
})
```

## Step 3 — Read the Output Critically

The tool returns:
- `overview` — top-line metrics (always)
- `breakdown` — requested sections
- `summary` — pre-formatted markdown (you can use directly OR rephrase)

### Red flags to watch

| Metric | Red flag | What it means |
|--------|---------|---------------|
| `successRate` | < 0.85 | High failure rate — find which agent |
| `toolErrorRate` | > 0.05 | Tools failing — check tool error events |
| `avgLatencyMs` | > 5000 | Slow system — find P99 outliers |
| Per-agent `successRate` | < 0.7 | Specific agent broken — escalate |
| `p99 / p50` ratio | > 5 | Long-tail latency — usually retries or external API timeout |
| Scorer `avgScore` | drops > 0.1 vs. previous window | Quality regression |
| Scorer `passRate` | < 0.5 | Most outputs failing scorer threshold |
| Cost spike on one agent | 3x usual | Probably loop / runaway |

### Non-issues that look scary

- High cost on `meta-agent`: expected — it orchestrates everything
- Low scorer count for new scorers: takes time to accumulate
- Local Ollama models showing $0 cost: by design (free local GPU)

## Step 4 — Diagnose Drift

To detect regression, run two reports:

```javascript
// This week
const current = await system.agent_performance_report({ since: "7d", includeBreakdown: ["agents", "scores"] })

// Previous week (8-14 days ago)
const previous = await system.agent_performance_report({
  since: "14d", until: "7d", includeBreakdown: ["agents", "scores"]
})
```

Then compare:
- `successRate` per agent: drop > 5pp = regression candidate
- `avgLatencyMs` per agent: increase > 30% = perf regression
- Scorer `avgScore`: drop > 10pp = quality regression

## Step 5 — Recommend Action

Match findings to fixes:

| Symptom | Likely Cause | Recommended Action |
|---------|-------------|-------------------|
| Agent X has < 70% success | Bad prompt / broken tool | Check recent commits to that agent, check tool errors |
| P99 >> P50 for agent | Retries on flaky external API | Check tool error rate, add circuit breaker |
| Cost spike | Loop / runaway tool | `db.query` for `tool_called` count per task |
| Scorer score dropped | Model change or prompt regression | Roll back recent changes |
| Skill X never used | Skill registry missing it OR agent doesn't know about it | Check `skill-search` tool |
| `task_started` >> `task_completed` | Many incomplete tasks | Crashes or timeouts — check `task_failed` events |

## Step 6 — Output Format

Structure response in this order:

```markdown
## System Performance — [period]

**TL;DR:** [1 sentence — green/yellow/red light]

### Headlines
- [Most important number]
- [Second most important]
- [Most concerning trend if any]

### Drill-down
[Selected breakdown details — only what's relevant]

### Recommended actions
- [Concrete next step]
- [Optional second step]

### What I'm watching
- [Metric to revisit next time]
```

## Cross-references with `db.query`

When the tool's aggregations don't have enough detail, drop to raw events:

```javascript
// Last 10 failures for specific agent
db.query({
  collection: "agent_events",
  operation: "find",
  filter: { type: "task_failed", agentId: "marketing-agent" },
  sort: { timestamp: -1 },
  limit: 10
})

// Tool error breakdown
db.query({
  collection: "agent_events",
  operation: "aggregate",
  pipeline: [
    { $match: { type: "tool_error", timestamp: { $gte: new Date("2026-05-01") } } },
    { $group: { _id: "$toolId", count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]
})
```

## Anti-Patterns

❌ Reporting raw JSON to the user — always interpret and summarize
❌ Ignoring "no data" — if `totalTasks === 0`, tell user explicitly (logging not wired up)
❌ Comparing windows of different sizes (24h vs 7d) without normalizing
❌ Drawing conclusions from < 10 samples per agent
❌ Treating Ollama $0 as "free" without acknowledging GPU compute cost
❌ Asking the tool for ALL breakdowns when only 1-2 are relevant — wastes compute

## Example — Full Flow

> The user speaks Polish and the response is user-facing, so the example below keeps the
> Polish user utterance and the Polish response (deliverable). Only the instructions are English.

User: *"Czy ten tydzień był dobry? Jakieś problemy?"*

```javascript
// 1. Run report for full breakdown
const r = await system.agent_performance_report({
  since: "7d",
  includeBreakdown: ["agents", "models", "cost", "latency", "scores"]
})
```

Read findings, identify:
- `overview.successRate` = 0.94 → 🟢 healthy
- One agent with failures: `coding-agent` 0.71 success rate ⚠️
- Cost $4.21, no spike vs typical
- Scorers: stable

Response to user:
```markdown
## Tydzień 2026-05-02 → 2026-05-09 — głównie OK ⚠️

**TL;DR:** System zdrowy ogólnie (94% success), ale `coding-agent` ma problemy.

### Headlines
- 142 tasków, 94% sukcesu, koszt $4.21 (w normie)
- 🔴 `coding-agent`: 71% success rate (8/28 failures)
- Latency P95 stabilne (~3s)

### Co się dzieje z coding-agentem
8 niepowodzeń w ostatnich 7 dniach. Na podstawie szybkiego sprawdzenia
(`db.query` z filtrem task_failed): wszystkie błędy z TypeScript compile errors.
Możliwe że ostatnia zmiana w prompcie sprawiła że agent generuje mniej poprawny kod.

### Rekomendacja
1. Sprawdź ostatni commit do coding-agent (git log)
2. Jeśli to regresja prompta — rollback i porównaj scorer scores
3. Dodać scorer compile-validity dla coding-agenta

### Co śledzę
- Coding-agent success rate w przyszłym tygodniu (cel: > 85%)
- Czy latency P95 nie wzrasta z czasem
```
