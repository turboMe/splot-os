# Phase 3 — Coding Hierarchy (Flat Architecture)

> Status: ✅ Complete | 3.1 ✅ | 3.2 ✅ | 3.3 ✅ | 3.4 ✅ | Completed: 2026-05-09

## Overview

Phase 3 transforms `codingAgent` from a monolithic executor into a role-based orchestrator.
Each subtask is now routed to a specialized sub-agent role with constrained tools,
appropriate model tier, and optionally loaded skill procedures from the Skill Registry.

This is "Phase A" (flat hierarchy) — the simplest architecture that solves the problem.
Phase B (5.x — full domain agents) is optional and only needed if flat proves insufficient.

## Architecture

```
codingAgent (orchestrator)
  ├→ subtask-executor.ts
  │     ├→ resolveSubAgentRole(subtask.type) → file-editor | terminal | qa
  │     ├→ findBestSkill(subtask, role) → Skill procedure from registry
  │     └→ buildScopedPrompt(subtask, role, skill) → constrained execution
  │
  ├→ run-worker.ts (ad-hoc workers)
  │     ├→ skills param → loads procedures from SkillRegistry
  │     └→ allowedTools param → informational tool whitelist
  │
  └→ Skill feedback loop
        ├→ skill.reportResult(success) after each subtask
        └→ success_rate updated in YAML frontmatter
```

## 3.1 SubAgent Role Definitions ✅

### File Created

| File | Purpose |
|------|---------|
| `config/subagent-roles.ts` | Role definitions, type-to-role mapping, utility functions |

### Roles Defined

| Role ID | Name | Tools | Model Tier | Use When |
|---------|------|-------|-----------|----------|
| `file-editor` | File Editor SubAgent | view, search, write_file_tracked, lsp_inspect | `local-heavy` | Creating, modifying, refactoring code |
| `terminal` | Terminal SubAgent | view, search, run_test | `local-micro` | Running build, test, lint commands |
| `qa` | QA SubAgent | view, search, lsp_inspect, run_test | `local-micro` | Verifying correctness, quality signals |

### Subtask Type → Role Mapping

```
edit, create, refactor, fix, patch → file-editor
test, build, install, run          → terminal
verify, lint, review, check        → qa
(unknown)                          → file-editor (default)
```

### Prompt Templates Created

| File | Role | Key Constraints |
|------|------|-----------------|
| `prompts/coding/subagent-file-editor.md` | File Editor | No terminal commands, structured JSON output |
| `prompts/coding/subagent-terminal.md` | Terminal | No file editing, whitelisted commands only |
| `prompts/coding/subagent-qa.md` | QA | No fixing, only structured quality signals |

## 3.2 Subtask Executor Upgrade ✅

### Key Changes to `services/subtask-executor.ts`

1. **Role resolution**: `resolveSubAgentRole(subtask.type)` maps each subtask to the
   appropriate role before execution.

2. **Skill loading**: `findBestSkill(subtask, role)` performs semantic search on the
   SkillRegistry to find a matching procedure. Score threshold: 0.35.

3. **Scoped prompt**: `buildScopedPrompt()` replaces the old `buildSubtaskPrompt()`:
   - Includes role name and description
   - Injects skill procedure if found
   - Lists only the role's allowed tools
   - Adds role-specific instructions (e.g., "NIE edytuj plików" for terminal)

4. **Retry with context**: `buildRetryPrompt()` now also includes role and skill
   context, so retries benefit from the same specialization.

5. **Skill feedback**: After each subtask execution, `getSkillRegistry().reportResult()`
   is called with success/failure status and notes.

### Design Decision: Same Agent, Scoped Prompt

Rather than creating separate Mastra Agent instances for each role, we reuse the existing
`codingAgent` with different prompts and model overrides. This is simpler and avoids
tool registration complexity. The role's `allowedTools` list is injected into the prompt
as an instruction constraint — the agent is told which tools are in scope.

## 3.3 Ad-hoc Worker Creation ✅

### Changes to `tools/system/run-worker.ts`

New parameters added:
- **`skills: string[]`** — Skill names to load from registry. Procedures are injected
  into the worker's system prompt.
- **`allowedTools: string[]`** — Informational tool whitelist for prompt context.

New output field:
- **`skillsLoaded: string[]`** — Names of skills that were successfully loaded.

### Workflow

```
codingAgent uses skill.search() → finds matching skill
  └→ codingAgent calls run_worker(skills=["fix-typescript-error"])
       └→ run_worker loads skill procedure from registry
            └→ Worker receives: taskBrief + skill procedure + tool list
                 └→ Worker produces result
                      └→ run_worker reports skill.reportResult(success)
```

## 3.4 Skill Feedback Loop ✅

The feedback loop is implemented in two places:

1. **subtask-executor.ts**: After each subtask execution, if a skill was loaded,
   `reportResult(name, passed, notes)` is called. Both success and failure paths
   report back.

2. **run-worker.ts**: After worker completion, if skills were loaded,
   `reportResult()` is called. Both success and failure paths report back.

This creates a closed loop:
```
Skill used → quality check → report → success_rate updated in YAML
```

Over time, skills with consistently low success_rate can be identified for improvement
or deprecation, while high-performing skills gain confidence.

## Verification

All code changes compile cleanly: `npx tsc --noEmit` → 0 errors.

## Files Summary

### New Files

| File | Purpose |
|------|---------|
| `config/subagent-roles.ts` | SubAgent role definitions and type-to-role mapping |
| `prompts/coding/subagent-file-editor.md` | File editor sub-agent prompt |
| `prompts/coding/subagent-terminal.md` | Terminal sub-agent prompt |
| `prompts/coding/subagent-qa.md` | QA sub-agent prompt |

### Modified Files

| File | Change |
|------|--------|
| `services/subtask-executor.ts` | Role resolution, skill loading, scoped prompts, feedback loop |
| `tools/system/run-worker.ts` | `skills` and `allowedTools` params, skill feedback |
| `prompts/coding/base.md` | Subagent creation instructions for codingAgent |
