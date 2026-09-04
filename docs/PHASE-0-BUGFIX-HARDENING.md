# Phase 0 — Bugfix & Hardening

> Completed: 2026-05-09 (4/5 tasks, 0.3 requires runtime diagnosis)

## Overview

Phase 0 addresses critical bugs and security gaps discovered during the system audit,
before building new infrastructure layers in Phases 1+.

## Changes

### 0.1 expiresAt Type Fix

**File:** `processors/shared-memory-output.ts`

The `SharedMemoryOutputProcessor` was storing `expiresAt` as an ISO string (`ttl.toISOString()`)
instead of a native `Date` object. This caused MongoDB queries using `{ $gt: new Date() }` in
`listContextTool` to never match string-typed expiration values.

**Fix:** Changed to `expiresAt: ttl` (native Date). The `addContextTool` already used native Date,
so this brings consistency across all writers.

### 0.2 TTL Indexes

**Files:** `lib/mongo-indexes.ts` (new), `index.ts` (modified)

Created `ensureIndexes()` that ensures TTL indexes exist on:
- `signals.expiresAt`
- `shared_memory.expiresAt`
- `auto_healing_tickets.expiresAt`

Called at Mastra startup (fire-and-forget with error logging). The `init-db.ts` script already
had some of these indexes, but `ensureIndexes()` provides runtime safety for fresh deployments.

### 0.3 token_usage Diagnostics (PENDING)

**Status:** Requires runtime diagnosis.

**Finding:** The `token_usage` Mongo collection has indexes defined in `init-db.ts` and is read
by `roi-calculator.ts`, but **no code writes** to it. The observability pipeline
(DuckDB + CloudExporter) stores traces/spans but doesn't aggregate them into the
`token_usage` collection.

**Next step:** Run the system, call `agent.generate()`, and check DuckDB for token attributes
in spans. Then build the appropriate exporter/hook.

### 0.4 Auto-save Lessons After Retry

**Files:** `services/subtask-executor.ts`, `prompts/meta/base.md`

The subtask executor now automatically saves a `lesson_learned` signal to MongoDB when:
- A retry succeeds (attempt 2) — captures what the original failure was and why retry worked
- An escalation succeeds (attempt 3) — captures model capability boundaries

Uses direct MongoDB insert (not `pushSignalTool.execute()`) to avoid type complexity.
Lessons have 30-day TTL (720 hours) and follow the same schema as manually saved lessons.

The meta-agent prompt was also strengthened: lesson saving is now marked as "ALWAYS" (not optional)
and a new instruction encourages saving lessons after any hard problem resolution.

### 0.5 Command Whitelist for run_test

**File:** `tools/dev/code-task-artifacts.ts`

`runTestCommandTool` now validates commands against an allowlist of safe prefixes before execution:

```
npx tsc, npx vitest, npx jest, npx eslint,
npm test, npm run test, npm run lint, npm run build,
node --check, cat, head, tail, wc
```

Commands not matching any prefix are rejected immediately with an error listing allowed prefixes.
This prevents command injection via the `coding.run_test` tool.

## Verification

All changes pass `npx tsc --noEmit` with zero errors.

## Transition Criteria to Phase 1

| Criterion | Status |
|-----------|--------|
| expiresAt uses native Date everywhere | ✅ |
| TTL indexes created at startup | ✅ |
| token_usage pipeline working | ⏳ Requires runtime diagnosis |
| Lessons auto-saved after retry | ✅ |
| run_test command whitelist | ✅ |

---

> **Next:** [Phase 1 — Operational Memory](./PHASE-1-OPERATIONAL-MEMORY.md)
