# Phase 1 — Operational Memory

> Status: ✅ Complete | 1.1 ✅ | 1.1b ✅ | 1.2 ✅ | 1.3 ✅ | 1.4 ✅ | Completed: 2026-05-09

## Overview

Phase 1 gives the system the ability to **remember and learn** from its own operations.
It builds on the infrastructure fixes from Phase 0 (TTL indexes, expiresAt types, etc.).

## 1.1 Observational Memory for metaAgent ✅

**File:** `agents/meta-agent.ts`

Enabled Mastra's built-in Observational Memory (OM) on the metaAgent by adding the
`observationalMemory` config block to the Memory constructor:

```ts
memory: new Memory({
  options: {
    lastMessages: 30,
    observationalMemory: {
      model: 'google/gemini-2.5-flash',
      temporalMarkers: true,
    },
  },
}),
```

### How it works

OM uses a three-agent architecture:
1. **Actor** — the main agent, sees observations + recent unobserved messages
2. **Observer** — extracts structured observations when message history exceeds threshold
3. **Reflector** — condenses observations when they grow too large

This keeps the metaAgent performant across long conversations (40+ messages) by automatically
compressing older context into observations rather than losing it via `lastMessages` truncation.

### Where to verify OM compression

1. **MongoDB:** `db.mastra_observational_memory.find().sort({_id:-1}).limit(5).pretty()`
2. **Mastra Studio:** Agent → Memory tab → observations visible in UI
3. **Console logs:** `[ObservationalMemory]` prefix on observe/reflect events
4. **Test:** 20+ messages on one threadId → Observer auto-compresses older messages

### Rollback

Remove the `observationalMemory` block from config to revert to pure `lastMessages: 30`.

## 1.1b Observational Memory for codingAgent ✅

**File:** `agents/coding-agent.ts`

Same config as metaAgent, enabled after successful pilot test. Configuration:
- `lastMessages: 30` (bumped from 20 for parity)
- `observationalMemory` with Gemini 2.5 Flash + temporal markers
- `generateTitle: true` + `threadTitle: true`

Keeps context across 15+ subtask orchestrations — Observer compresses earlier results
automatically.

## 1.2 Agent Event Log ✅

### New module: `lib/agent-event-log.ts`

Centralized, structured log of ALL significant agent events in one MongoDB collection
(`agent_events`). Events have 30-day TTL for automatic cleanup.

**Event types:**
`task_started`, `task_completed`, `task_failed`, `tool_called`, `tool_error`,
`delegation`, `escalation`, `retry_success`, `retry_failed`,
`autoheal_triggered`, `autoheal_resolved`, `lesson_learned`, `skill_used`,
`approval_requested`, `approval_granted`, `approval_denied`

### Indexes (in `lib/mongo-indexes.ts`)

- `{ expiresAt: 1 }` — TTL auto-cleanup
- `{ type: 1, timestamp: -1 }` — query by event type
- `{ agentId: 1, timestamp: -1 }` — query by agent
- `{ taskId: 1 }` — lookup events for a specific task

### Instrumentation points

| File | Events logged |
|------|--------------|
| `services/subtask-executor.ts` | `task_completed`, `retry_success`, `task_failed` |
| `tools/system/delegate-task.ts` | `delegation` (success + error, with timing) |
| `services/error-collector.ts` | `autoheal_triggered` |

## 1.3 Memory Extractor ✅

### New module: `services/memory-extractor.ts`

Background worker that analyzes `agent_events` and extracts typed knowledge
patterns into `system_knowledge`. Knowledge has **90-day renewable TTL** —
items that get recalled have their TTL refreshed automatically.

### Pattern Detectors

| # | Pattern | Event types | Knowledge type |
|---|---------|-------------|----------------|
| 1 | Retry succeeded after failure | `retry_success` | `failure_case` |
| 2 | Repeated tool errors | `tool_error` (same errorMessage ×2+) | `tool_contract` |
| 3 | Auto-heal triggered | `autoheal_triggered` + `autoheal_resolved` | `autoheal_recipe` |
| 4 | Costly delegation (>60s) | `delegation` with high `durationMs` | `prompt_rule` |
| 5 | Unrecovered failures | `task_failed` without matching `retry_success` | `failure_case` |

### SystemKnowledge Schema

```ts
interface SystemKnowledge {
  knowledgeId: string;
  type: KnowledgeType;       // 8 categories
  title: string;             // for embedding + display
  content: string;           // full context (max 1000 chars)
  embedding: number[];       // vector from embedder
  sourceEventIds: string[];  // links to agent_events
  confidence: number;        // 0–1, grows with repetition
  usageCount: number;        // incremented on recall
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;           // 90 days, renewable
}
```

### Deduplication

When saving knowledge with an existing `(type, title)` match, the extractor:
- Refreshes TTL
- Increases confidence by 0.1
- Merges `sourceEventIds` via `$addToSet`

### Indexes

- `{ expiresAt: 1 }` — TTL auto-cleanup
- `{ type: 1, createdAt: -1 }` — query by knowledge type
- `{ knowledgeId: 1 }` — unique lookup

### Usage

```ts
import { extractKnowledge } from './services/memory-extractor.js';
const count = await extractKnowledge(); // run manually or on schedule
```

## 1.4 Memory Tools ✅

### Tools

| Tool | Agents | Purpose |
|------|--------|---------|
| `system.memory_recall` | metaAgent, codingAgent | Semantic vector search over `system_knowledge`. Auto-renews TTL on hit. |
| `system.memory_write_observation` | metaAgent, codingAgent | Explicit knowledge persistence. Deduplicates by `(type, title)`, increments confidence. |

### Files

- `tools/system/memory-recall.ts` — Recall tool with embedding search + TTL renewal
- `tools/system/memory-write.ts` — Write tool with deduplication

### System prompt integration

Both agents have updated system prompts (`prompts/meta/base.md`, `prompts/coding/base.md`)
with explicit instructions:
- **Before complex tasks:** Call `memory_recall` to check for known patterns
- **After significant discoveries:** Call `memory_write_observation` to persist lessons

## 1.5 Working Memory + Auto-Titles ✅

**File:** `agents/meta-agent.ts`

Additional memory features enabled on metaAgent:

- **Working Memory** — persistent scratchpad surviving across sessions with template:
  - User Preferences (language, communication style, decision authority)
  - Active Project Context (phase, decisions, blockers)
  - Learned Patterns (strategies, pitfalls)
- **generateTitle: true** — auto-generates descriptive thread titles
- **threadTitle: true** — OM refines titles during compression

## Verification

All changes pass `npx tsc --noEmit` with zero errors.

---

> **Next:** [Phase 2 — Failure Brain + Skill Registry](./PHASE-2-FAILURE-BRAIN-SKILL-REGISTRY.md)
