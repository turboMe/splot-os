---
name: nlm-notebook-management
category: knowledge
description: NotebookLM notebook CRUD operations — create, list, get, describe, rename, delete notebooks. Also covers notebook querying (one-shot Q&A with sources).
keywords: [notebooklm, notebook, create, list, delete, query, describe, rename, knowledge]
allowedTools: [notebook_create, notebook_list, notebook_get, notebook_describe, notebook_query, notebook_rename, notebook_delete]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 400
outputFormat: json
tags: [notebooklm, notebook, crud, knowledge-management]
version: 1
success_rate: 1
total_uses: 1
last_used: 2026-05-14
handoffCapable: true
---
# NotebookLM — Notebook Management

## Trigger
Agent needs to create, list, query, or manage NotebookLM notebooks.

## MCP Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `notebook_list` | List all notebooks | `max_results` (default 100) |
| `notebook_create` | Create new notebook | `title` (optional) |
| `notebook_get` | Get notebook details with sources | `notebook_id` (required) |
| `notebook_describe` | AI-generated summary + suggested topics | `notebook_id` (required) |
| `notebook_query` | One-shot Q&A against sources in notebook | `notebook_id`, `query`, `source_ids` (optional), `conversation_id` (for follow-ups) |
| `notebook_rename` | Rename notebook | `notebook_id`, `new_title` |
| `notebook_delete` | **PERMANENT** delete | `notebook_id`, `confirm=True` required |

## Procedure

### Create Notebook
1. Call `notebook_create(title="Descriptive Title")`
2. Capture returned `notebook_id` — needed for all subsequent operations

### Query Notebook (RAG)
1. Call `notebook_query(notebook_id, query="Your question")`
2. For follow-ups: pass `conversation_id` from previous response
3. For large notebooks (50+ sources): use `notebook_query_start` + `notebook_query_status` (async polling)

### Delete Notebook
⚠️ **ALWAYS ask user for confirmation first. Deletions are IRREVERSIBLE.**
1. Show notebook title and source count
2. Call `notebook_delete(notebook_id, confirm=True)` only after explicit approval

## Rate Limiting
- Query operations: **2 second** minimum between calls
- List/get operations: no special throttling needed
