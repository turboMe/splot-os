---
name: nlm-studio-content-generation
category: knowledge
description: NotebookLM studio — generate podcasts (audio), videos, reports, quizzes, flashcards, mind maps, slides, infographics, data tables from notebook sources. Check status, download, export artifacts.
keywords: [notebooklm, studio, podcast, audio, video, report, quiz, flashcards, mind map, slides, infographic, data table, generate, artifact]
allowedTools: [studio_create, studio_status, studio_delete, studio_revise, download_artifact, export_artifact]
minComplexity: moderate
recommendedTier: balanced
estimatedTokens: 1000
outputFormat: json
tags: [notebooklm, studio, content-generation, podcast, report, knowledge-management]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# NotebookLM — Studio Content Generation

## Trigger
Agent needs to generate content artifacts (audio, video, reports, quizzes, etc.) from notebook sources.

## MCP Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `studio_create` | Generate artifact | `notebook_id`, `artifact_type`, `confirm=True`, + type-specific options |
| `studio_status` | Check generation progress | `notebook_id`, `action` (status/rename/list_types) |
| `studio_delete` | Delete artifact | `notebook_id`, `artifact_id`, `confirm=True` |
| `studio_revise` | Revise individual slides | `notebook_id`, `artifact_id`, `slide_instructions`, `confirm=True` |
| `download_artifact` | Download to file | `notebook_id`, `artifact_type`, `output_path` |
| `export_artifact` | Export to Google Docs/Sheets | `notebook_id`, `artifact_id`, `export_type` (docs/sheets) |

## Artifact Types & Options

### Audio (Podcast)
```
studio_create(notebook_id, artifact_type="audio",
  audio_format="deep_dive",  # deep_dive | brief | critique | debate
  audio_length="default",     # short | default | long
  focus_prompt="key topic",   # optional focus
  language="en",              # BCP-47 code
  confirm=True
)
```

### Video
```
studio_create(notebook_id, artifact_type="video",
  video_format="explainer",          # explainer | brief
  visual_style="auto_select",        # auto_select | classic | whiteboard | kawaii | anime | watercolor | retro_print | heritage | paper_craft
  confirm=True
)
```

### Report
```
studio_create(notebook_id, artifact_type="report",
  report_format="Briefing Doc",  # "Briefing Doc" | "Study Guide" | "Blog Post" | "Create Your Own"
  custom_prompt="...",           # required for "Create Your Own"
  confirm=True
)
```

### Quiz
```
studio_create(notebook_id, artifact_type="quiz",
  question_count=10,     # number of questions (default 2)
  difficulty="medium",   # easy | medium | hard
  focus_prompt="...",    # optional
  confirm=True
)
```

### Flashcards
```
studio_create(notebook_id, artifact_type="flashcards",
  difficulty="medium",   # easy | medium | hard
  focus_prompt="...",    # optional
  confirm=True
)
```

### Mind Map
```
studio_create(notebook_id, artifact_type="mind_map",
  title="Topic Overview",
  confirm=True
)
```

### Slide Deck
```
studio_create(notebook_id, artifact_type="slide_deck",
  slide_format="detailed_deck",  # detailed_deck | presenter_slides
  slide_length="default",        # short | default
  confirm=True
)
```
Revise slides: `studio_revise(notebook_id, artifact_id, slide_instructions=[{"slide": 1, "instruction": "Make title larger"}], confirm=True)` — creates NEW deck.

### Infographic
```
studio_create(notebook_id, artifact_type="infographic",
  orientation="landscape",           # landscape | portrait | square
  detail_level="standard",           # concise | standard | detailed
  infographic_style="auto_select",   # auto_select | sketch_note | professional | bento_grid | editorial | instructional | bricks | clay | anime | kawaii | scientific
  confirm=True
)
```

### Data Table
```
studio_create(notebook_id, artifact_type="data_table",
  description="Extract all dates and events",  # REQUIRED
  confirm=True
)
```

## Common Options (all types)
- `source_ids` — limit to specific sources (default: all)
- `language` — BCP-47 code (en, es, fr, de, ja, pl)
- `focus_prompt` — guide generation focus

## Procedure

### Generate Content
1. Call `studio_create(...)` with `confirm=True`
2. Poll `studio_status(notebook_id)` until status is `completed`
3. Status values: `completed` (✓), `in_progress` (●), `failed` (✗)
4. Generation times: audio 2-5min, video 3-10min, reports ~30s

### Download / Export
- `download_artifact(notebook_id, artifact_type="audio", output_path="podcast.mp3")`
- `export_artifact(notebook_id, artifact_id, export_type="docs")` → Google Docs
- `export_artifact(notebook_id, artifact_id, export_type="sheets")` → Google Sheets

## Rate Limiting
- Content generation: **5 seconds** between calls
