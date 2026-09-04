---
name: nlm-workflow-patterns
category: knowledge
description: NotebookLM proven workflow patterns — Research to Podcast pipeline, Quick Content Ingestion, Study Materials Generation, Drive Document Workflow, Batch & Cross-Notebook Workflow. Step-by-step sequences for common multi-tool tasks.
keywords: [notebooklm, workflow, pattern, pipeline, research, podcast, ingest, study, drive, batch, cross-notebook, sequence]
allowedTools: [notebook_create, source_add, research_start, research_status, research_import, studio_create, studio_status, notebook_query, batch, cross_notebook_query, tag, source_list_drive, source_sync_drive, download_artifact]
minComplexity: moderate
recommendedTier: fast
estimatedTokens: 1050
outputFormat: json
tags: [notebooklm, workflow, pipeline, best-practices, knowledge-management]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# NotebookLM — Proven Workflow Patterns

## Trigger
Agent needs to execute a multi-step NotebookLM workflow (research, content generation, batch processing).

## Pattern 1: Research → Podcast Pipeline

Full deep research with audio output.

### Steps:
1. **Create notebook**: `notebook_create(title="AI Research 2026")` → capture `notebook_id`
2. **Start deep research**: `research_start(query="agentic AI trends", notebook_id=ID, mode="deep")`
3. **Wait for completion**: `research_status(notebook_id=ID, max_wait=300)` — polls until done
4. **Import sources**: `research_import(notebook_id=ID, task_id=TASK_ID)` — import all discovered
5. **Generate podcast**: `studio_create(notebook_id=ID, artifact_type="audio", audio_format="deep_dive", confirm=True)`
6. **Check status**: `studio_status(notebook_id=ID)` — repeat until `completed` (takes 2-5 min)
7. **Download**: `download_artifact(notebook_id=ID, artifact_type="audio", output_path="podcast.mp3")`

## Pattern 2: Quick Content Ingestion

Add multiple URLs/text quickly to existing notebook.

### Steps:
1. **Add sources sequentially** (2s pause between each):
   ```
   source_add(notebook_id=ID, source_type="url", url="https://example1.com", wait=True)
   # wait 2 seconds
   source_add(notebook_id=ID, source_type="url", url="https://example2.com", wait=True)
   # wait 2 seconds
   source_add(notebook_id=ID, source_type="text", text="My notes...", title="Notes", wait=True)
   ```
2. **Verify**: `notebook_get(notebook_id=ID)` — check source count

## Pattern 3: Study Materials Generation

Generate comprehensive study materials from existing notebook.

### Steps:
1. **Verify sources exist**: `notebook_get(notebook_id=ID)`
2. **Generate study guide**: `studio_create(notebook_id=ID, artifact_type="report", report_format="Study Guide", confirm=True)` — wait 5s
3. **Generate quiz**: `studio_create(notebook_id=ID, artifact_type="quiz", question_count=10, difficulty="medium", focus_prompt="Comprehensive review", confirm=True)` — wait 5s
4. **Generate flashcards**: `studio_create(notebook_id=ID, artifact_type="flashcards", difficulty="medium", focus_prompt="Core terms", confirm=True)` — wait 5s
5. **Generate mind map**: `studio_create(notebook_id=ID, artifact_type="mind_map", title="Topic Overview", confirm=True)`
6. **Check all artifacts**: `studio_status(notebook_id=ID)`

## Pattern 4: Drive Document Workflow

Sync and work with Google Drive documents.

### Steps:
1. **Add Drive source**: `source_add(notebook_id=ID, source_type="drive", document_id="DOC_ID", doc_type="doc", wait=True)`
2. **Check freshness later**: `source_list_drive(notebook_id=ID)` — shows stale/fresh status
3. **Sync stale sources**: `source_sync_drive(source_ids=["ID1","ID2"], confirm=True)`
4. **Query updated content**: `notebook_query(notebook_id=ID, query="What changed?")`

## Pattern 5: Batch & Cross-Notebook Workflow

Organize and query across multiple notebooks.

### Steps:
1. **Tag notebooks**: 
   ```
   tag(action="add", notebook_id=ID1, tags="ai,research")
   tag(action="add", notebook_id=ID2, tags="ai,product")
   ```
2. **Cross-query**: `cross_notebook_query(query="What are the main conclusions?", tags="ai")`
3. **Batch generate**: `batch(action="studio", artifact_type="audio", tags="ai", confirm=True)`

## Pattern 6: Temporary Research Notebook (Cleanup)

One-shot research with automatic cleanup.

### Steps:
1. **Create temp notebook**: `notebook_create(title="TEMP: Research for [task]")` → capture ID
2. **Add sources / run research**
3. **Query for answers**: `notebook_query(notebook_id=ID, query="...")`
4. **Extract answers** — save to workflow output
5. **Cleanup**: `notebook_delete(notebook_id=ID, confirm=True)` — ALWAYS cleanup temp notebooks

## Decision Tree: Which Pattern?

```
Need to...
├─► Find new sources about a topic → Pattern 1 (Research → Podcast)
├─► Add known URLs/text to notebook → Pattern 2 (Quick Ingestion)
├─► Create learning materials → Pattern 3 (Study Materials)
├─► Work with Google Drive docs → Pattern 4 (Drive Workflow)
├─► Query across multiple notebooks → Pattern 5 (Batch/Cross)
└─► One-time research, discard after → Pattern 6 (Temp + Cleanup)
```
