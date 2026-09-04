---
name: nlm-research
category: knowledge
description: NotebookLM deep research — discover new sources from web or Google Drive. Start research, monitor progress, import discovered sources into notebook.
keywords: [notebooklm, research, discover, web search, drive search, deep research, fast research, import]
allowedTools: [research_start, research_status, research_import]
minComplexity: moderate
recommendedTier: fast
estimatedTokens: 500
outputFormat: json
tags: [notebooklm, research, discovery, web-search, knowledge-management]
version: 1
success_rate: 1
total_uses: 1
last_used: 2026-07-20
handoffCapable: true
---
# NotebookLM — Research (Source Discovery)

## Trigger
Agent needs to find NEW sources about a topic from the web or Google Drive.

## MCP Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `research_start` | Start research task | `query`, `notebook_id` (or creates new), `mode` (fast/deep), `source` (web/drive) |
| `research_status` | Poll progress | `notebook_id`, `task_id` (optional), `max_wait` (default 300s), `compact` (default true) |
| `research_import` | Import discovered sources | `notebook_id`, `task_id`, `source_indices` (optional — imports all by default), `timeout` (default 300) |

## Procedure

### Step 1: Start Research
```
research_start(
  query="agentic AI trends 2026",
  notebook_id="...",     # or omit to create new notebook
  mode="fast",           # fast (~30s, ~10 sources) | deep (~5min, ~40 sources, web only)
  source="web"           # web | drive
)
```
Capture `task_id` from response.

### Step 2: Monitor Progress
```
research_status(
  notebook_id="...",
  task_id="...",
  max_wait=300           # blocks until complete or timeout
)
```
Poll until `status="completed"`. Use `compact=False` for full source details.

### Step 3: Import Sources
```
research_import(
  notebook_id="...",
  task_id="...",
  # source_indices=[0,2,5]  # optional: import specific sources only
  timeout=300               # increase for large notebooks
)
```

## Mode Selection
| Mode | Duration | Sources | Use When |
|------|----------|---------|----------|
| `fast` | ~30s | ~10 | Quick lookups, time-sensitive tasks |
| `deep` | ~5min | ~40+ | Comprehensive research, web only |

## Rate Limiting
- Research operations: **2 seconds** between calls

## Error Recovery
| Error | Solution |
|-------|----------|
| "Research already in progress" | Use `--force` or import existing results first |
| "Import timed out" | Increase `timeout` to 600 for larger notebooks |
| "Google API error code 3" | Retry in a few minutes, or use `mode=fast` |
