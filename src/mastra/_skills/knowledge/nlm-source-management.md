---
name: nlm-source-management
category: knowledge
description: NotebookLM source operations — add URLs, text, Drive docs, files to notebooks. List, describe, get content, rename, sync Drive sources, delete sources.
keywords: [notebooklm, source, add, url, text, drive, file, upload, sync, delete, content]
allowedTools: [source_add, source_list_drive, source_describe, source_get_content, source_rename, source_sync_drive, source_delete]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 550
outputFormat: json
tags: [notebooklm, source, ingest, url, drive, knowledge-management]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# NotebookLM — Source Management

## Trigger
Agent needs to add content (URLs, text, files, Drive docs) to a notebook, or manage existing sources.

## MCP Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `source_add` | Add source to notebook | `notebook_id`, `source_type` (url/text/drive/file), `url`, `text`, `title`, `document_id`, `file_path`, **`wait=True`**, `wait_timeout=120` |
| `source_list_drive` | List sources with Drive freshness | `notebook_id` |
| `source_describe` | AI summary + keywords | `source_id` |
| `source_get_content` | Raw text content (no AI) | `source_id` |
| `source_rename` | Rename source | `notebook_id`, `source_id`, `new_title` |
| `source_sync_drive` | Sync stale Drive sources | `source_ids`, `confirm=True` |
| `source_delete` | **PERMANENT** delete | `source_id`, `confirm=True` |

## Procedure

### Adding Sources
1. **ALWAYS** use `source_add` with `wait=True` and `wait_timeout=120`
   - This waits for full indexing before returning
   - Do NOT use setTimeout or manual waiting
2. When adding multiple sources, add them **sequentially** with **2 second pause** between calls (rate limiting)
3. Source types:
   - `url`: Web pages, YouTube URLs
   - `text`: Pasted text content (requires `title`)
   - `drive`: Google Drive docs (requires `document_id`, optional `doc_type`: doc/slides/sheets/pdf)
   - `file`: Local file upload (requires `file_path`)
4. Bulk URLs: use `urls` param (list) instead of `url` (single)

### Drive Source Sync
1. Call `source_list_drive(notebook_id)` to check freshness
2. If stale sources found: `source_sync_drive(source_ids=[...], confirm=True)`

### Getting Source Content
- `source_describe` — AI-generated summary with keyword chips
- `source_get_content` — raw indexed text, no AI processing (faster, good for export)

## Rate Limiting
- Source add operations: **2 seconds** between calls
- NotebookLM tolerates 404 URLs — no need to pre-validate

## Error Recovery
| Error | Solution |
|-------|----------|
| "Source not found" | Run `source_list_drive(notebook_id)` to get valid IDs |
| Source add timeout | Increase `wait_timeout` to 300 |
