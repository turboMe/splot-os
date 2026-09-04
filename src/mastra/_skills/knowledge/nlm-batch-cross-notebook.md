---
name: nlm-batch-cross-notebook
category: knowledge
description: NotebookLM batch operations and cross-notebook queries — query multiple notebooks, add sources across notebooks, batch create/delete, generate artifacts in batch. Tags for smart selection.
keywords: [notebooklm, batch, cross-notebook, multi-notebook, query, tag, smart-select, aggregate]
allowedTools: [batch, cross_notebook_query, tag, pipeline]
minComplexity: moderate
recommendedTier: balanced
estimatedTokens: 500
outputFormat: json
tags: [notebooklm, batch, cross-notebook, multi-notebook, knowledge-management]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# NotebookLM — Batch, Cross-Notebook & Pipelines

## Trigger
Agent needs to operate across multiple notebooks at once, or run multi-step pipelines.

## MCP Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `batch` | Same action across many notebooks | `action` (query/add_source/create/delete/studio), `notebook_names`/`tags`/`all` |
| `cross_notebook_query` | Aggregated answers with per-notebook citations | `query`, `notebook_names`/`tags`/`all` |
| `tag` | Tag management for smart selection | `action` (add/remove/list/select), `notebook_id`, `tags` |
| `pipeline` | Multi-step workflows | `action` (run/list), `notebook_id`, `pipeline_name`, `input_url` |

## Batch Operations
```
batch(action="query", query="What are the key findings?", notebook_names="AI Research, Dev Tools")
batch(action="add_source", source_url="https://...", tags="ai,research")
batch(action="create", titles="Project A, Project B, Project C")
batch(action="delete", notebook_names="Old Project", confirm=True)
batch(action="studio", artifact_type="audio", tags="research", confirm=True)
```

## Cross-Notebook Query
Returns aggregated answers with per-notebook citations:
```
cross_notebook_query(query="Compare approaches", notebook_names="Notebook A, Notebook B")
cross_notebook_query(query="Summarize", tags="ai,research")
cross_notebook_query(query="Everything", all=True)
```

## Tags & Smart Select
```
tag(action="add", notebook_id="...", tags="ai,research,llm")
tag(action="remove", notebook_id="...", tags="ai")
tag(action="list")
tag(action="select", query="ai research")  # find notebooks by tag match
```

## Built-in Pipelines
```
pipeline(action="list")
pipeline(action="run", notebook_id="...", pipeline_name="ingest-and-podcast", input_url="https://...")
```
Available: `ingest-and-podcast`, `research-and-report`, `multi-format`

## Rate Limiting
- Batch operations: **10 seconds** between calls
- Cross-notebook queries: **2 seconds**
