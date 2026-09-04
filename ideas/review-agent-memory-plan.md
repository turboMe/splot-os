# Code Review Agent Memory Plan

Status: implemented on 2026-05-16

## Scope

Add memory to `codeReviewAgent` without adding working memory.

This phase should include:

- Mastra `Memory` with `lastMessages: 30`,
- Observational Memory scoped to `thread`,
- `system_memory_recall`,
- `system_memory_write_observation`,
- prompt rules that make memory secondary to the current diff and file reads.

This phase should not include:

- working memory,
- skill search,
- tool search,
- repo-map / checkpoint / call-site expansion.

## Implementation Steps

1. Update `src/mastra/agents/code-review-agent.ts`.
   - Import `Memory`.
   - Import `resolveModelId` and `infrastructure` for the observational memory model.
   - Register `memoryRecallTool` and `memoryWriteTool` under stable snake_case names.
   - Add `memory: new Memory({ options: { lastMessages: 30, observationalMemory: ... } })`.

2. Update `src/mastra/prompts/coding/review.md`.
   - Document the new memory tools.
   - Tell the reviewer to use recall only for complex or risky reviews.
   - Tell the reviewer to save durable lessons only for non-obvious, reusable review findings.
   - State explicitly that current worktree diff and file reads override memory.

3. Verify.
   - Run `npm run build`.
   - Run `npm run audit:harness`.

## Expected Effect

The review loop should keep continuity across repeated review iterations for the same `taskId`, because `repo-maintenance` now calls `generateReview()` with `threadId: taskId`.

The reviewer should also be able to recall and save durable system knowledge about recurring review risks, common coding-agent mistakes, tool contracts, and repository-specific quality rules.
