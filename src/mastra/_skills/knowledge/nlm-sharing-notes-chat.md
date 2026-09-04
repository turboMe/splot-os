---
name: nlm-sharing-notes-chat
category: knowledge
description: NotebookLM sharing, notes management, and chat configuration — invite collaborators, public links, create/update notes, configure chat behavior and response length.
keywords: [notebooklm, share, invite, public link, notes, chat, configure, response length, collaborator]
allowedTools: [notebook_share_status, notebook_share_public, notebook_share_invite, notebook_share_batch, note, chat_configure]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 450
outputFormat: json
tags: [notebooklm, sharing, notes, chat, collaboration, knowledge-management]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# NotebookLM — Sharing, Notes & Chat

## Trigger
Agent needs to share notebooks, manage notes, or configure chat behavior.

## MCP Tools

### Sharing
| Tool | Purpose | Key Params |
|------|---------|------------|
| `notebook_share_status` | Check current sharing settings | `notebook_id` |
| `notebook_share_public` | Enable/disable public link | `notebook_id`, `is_public` (default True) |
| `notebook_share_invite` | Invite collaborator | `notebook_id`, `email`, `role` (viewer/editor) |
| `notebook_share_batch` | Invite multiple at once | `notebook_id`, `recipients` (list of {email, role}), `confirm=True` |

### Notes
| Tool | Purpose | Key Params |
|------|---------|------------|
| `note` | Unified note operations | `notebook_id`, `action` (create/list/update/delete), `title`, `content`, `note_id` |

Actions:
- `create` — new note with `title` and `content`
- `list` — all notes in notebook
- `update` — modify existing note (`note_id` required)
- `delete` — permanent, requires `confirm=True`

Notes are **included in queries** — they influence AI responses.

### Chat Configuration
| Tool | Purpose | Key Params |
|------|---------|------------|
| `chat_configure` | Configure chat behavior | `notebook_id`, `goal` (default/learning_guide/custom), `response_length` (default/longer/shorter), `custom_prompt` |

## Procedure

### Share notebook
1. Check current: `notebook_share_status(notebook_id)`
2. Public link: `notebook_share_public(notebook_id, is_public=True)`
3. Invite: `notebook_share_invite(notebook_id, email="user@example.com", role="editor")`

### Add notes
1. `note(notebook_id, action="create", title="Key Insights", content="My observations...")`
2. Notes persist and influence all future queries and content generation
