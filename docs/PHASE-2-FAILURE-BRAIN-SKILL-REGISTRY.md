# Phase 2 — Failure Brain + Skill Registry

> Status: ✅ Complete | 2.1 ✅ | 2.2 ✅ | 2.3 ✅ | Completed: 2026-05-09

## Overview

Phase 2 builds on the knowledge infrastructure from Phase 1 to create a self-improving
auto-heal system (Failure Brain) and a dynamic Skill Registry for agent capabilities.

## 2.1 Failure Brain ✅

### Concept

When a runtime error triggers the self-healing workflow, the system now **checks past
experience first** before starting diagnosis. If a similar error was seen and fixed before,
the fix recipe is injected into the workflow prompt — dramatically reducing diagnosis time.

### Architecture

```
Error occurs
  └→ ErrorCollector._triggerWorkflow()
       ├→ recallKnowledge(error, type='failure_case')   ← NEW
       ├→ recallKnowledge(error, type='autoheal_recipe') ← NEW
       └→ Build prompt with known failures section
            └→ repo-maintenance-workflow starts

Ticket resolved
  └→ ErrorCollector.resolveTicket()
       └→ writeKnowledge('autoheal_recipe', fix details) ← NEW
```

### Files Changed

| File | Change |
|------|--------|
| `lib/failure-brain.ts` | **New** — standalone `recallKnowledge()` and `writeKnowledge()` functions for programmatic access |
| `services/error-collector.ts` | **Modified** — `_triggerWorkflow()` now searches failure_case + autoheal_recipe before building prompt |
| `services/error-collector.ts` | **Modified** — `resolveTicket()` now saves autoheal_recipe after resolution |

### How it works

1. **Before workflow trigger** (`_triggerWorkflow`):
   - Searches `system_knowledge` for `failure_case` items matching the error (top 3, score ≥ 0.4)
   - Searches for `autoheal_recipe` items (top 2, score ≥ 0.4)
   - Injects matching knowledge into the workflow prompt as "known similar failures"
   - Non-fatal: if recall fails, workflow runs normally without historical context

2. **After ticket resolution** (`resolveTicket`):
   - Fetches the full ticket data before marking it resolved
   - Saves an `autoheal_recipe` to `system_knowledge` with:
     - Error message and source
     - Stack trace hint (first 3 lines)
     - Resolution details (workflow run ID)
   - Deduplicates by title — repeated fixes increase confidence

### Design Decision: Direct Functions vs Tool Interface

Internal services (ErrorCollector, workflows) don't have Mastra tool execution context.
Instead of fighting the tool interface, `lib/failure-brain.ts` extracts the core logic
into standalone `recallKnowledge()` and `writeKnowledge()` functions. These share the same
algorithms as `memoryRecallTool` and `memoryWriteTool` but can be called directly.

### Testing

To verify Failure Brain:
1. Trigger the same error twice via crash-test endpoint
2. First time: workflow runs without history (no knowledge yet)
3. First fix resolves → autoheal_recipe saved to system_knowledge
4. Second time: workflow prompt includes the recipe from step 3
5. Verify in MongoDB: `db.system_knowledge.find({type: 'autoheal_recipe'})`

## Verification

All code changes compile cleanly: `npx tsc --noEmit` → 0 errors.

---

## 2.2 Skill Registry ✅

### Concept

A central service that scans `_skills/` for markdown files with YAML frontmatter,
generates embeddings for semantic search, and provides search/load/report APIs.

### Architecture

```
Mastra startup
  └→ index.ts: getSkillRegistry().initialize('_skills/')
       ├→ Scan directories recursively for *.md files
       ├→ Parse YAML frontmatter (name, description, keywords, category, etc.)
       ├→ Generate embeddings via lib/embedder.js
       └→ Build in-memory search index

Agent needs a skill
  └→ skill.search("fix typescript error")
       └→ Cosine similarity against embeddings → ranked results
```

### Files Created

| File | Purpose |
|------|---------|
| `lib/yaml-frontmatter.ts` | Parse/update YAML frontmatter in markdown files |
| `services/skill-registry.ts` | Core registry: scan, index, search, load, report |
| `_skills/coding/fix-typescript-error.md` | Starter skill: TS error diagnosis & fix |
| `_skills/coding/safe-file-edit.md` | Starter skill: worktree-based safe editing |
| `_skills/coding/run-verification.md` | Starter skill: verification & verdict |

### Existing Skills Inventory

The registry also indexes existing skills with frontmatter:
- **terminal/** — 6 skills (git-conflict-resolver, swe-repo-explorer, etc.)
- **n8n/** — 6 skills (workflow rules, node catalog, expression syntax, etc.)
- **coding/** — 3 new starter skills

Total: **15+ skills** at initialization.

### Key Design Decisions

- **Singleton pattern**: `getSkillRegistry()` ensures single instance
- **Async embeddings**: Generated in parallel at startup, non-fatal on failure
- **Keyword fallback**: If embeddings unavailable, falls back to term matching
- **In-memory index**: No external database needed; skills are small (<50 files)
- **`import.meta.dirname`**: Used to resolve `_skills/` relative to compiled output

---

## 2.3 Skill Tools ✅

### Tools Created

| Tool | Agent | Purpose |
|------|-------|---------|
| `skill.search` | metaAgent + codingAgent | Semantic search by task description |
| `skill.load` | codingAgent | Load full skill procedure for execution |
| `skill.report_result` | codingAgent | Feedback loop (updates success_rate in YAML) |

### Feedback Loop

```
Agent discovers skill → loads procedure → executes it
  ├→ Success: skill.report_result(name, true)
  │    └→ success_rate ↑, total_uses++, last_used updated
  └→ Failure: skill.report_result(name, false, "reason")
       └→ success_rate ↓, notes for improvement
```

The success_rate is persisted in the YAML frontmatter of each skill file.
Over time, this creates a natural quality signal — low-rate skills can be
improved or deprecated, high-rate skills gain confidence.

### Agent Integration

- **metaAgent**: Gets `skill.search` only (discovery). Delegates execution to codingAgent.
- **codingAgent**: Gets all 3 tools (search + load + report). Executes skills directly.

### Testing

```bash
# Verify skill discovery
curl http://localhost:4111/api/agents/coding-agent/generate \
  -d '{"messages":[{"role":"user","content":"search for skills about typescript errors"}]}'

# Expected: skill.search returns fix-typescript-error with high score
```
