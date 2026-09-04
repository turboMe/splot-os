---
name: safe-file-edit
category: coding
description: Edit source files safely using the staging worktree lifecycle. Read first, write tracked, verify, then apply patch.
keywords: [edit, file, worktree, staging, safe, write]
allowedTools: [view, search_content, coding_init_worktree, coding_write_file_tracked, coding_run_test, coding_apply_patch, coding_remove_worktree]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 400
outputFormat: diff
tags: [file-edit, worktree, staging, safety]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Safe File Edit

## Trigger
Agent needs to modify one or more files in the repository.

## Procedure

### Step 1: Read before writing
ALWAYS read the target file with `view` before making any changes.
Understand:
- File structure and imports
- Coding style and conventions
- Related functions or types that might be affected

### Step 2: Initialize staging worktree
Use `coding.init_worktree` to create an isolated worktree.
This ensures changes don't affect the live codebase until verified.

### Step 3: Make changes
Use `coding.write_file_tracked` for all edits:
- Make small, focused changes
- Preserve existing comments and documentation
- Follow the file's existing coding style
- Add comments for non-obvious logic

### Step 4: Verify
Run `coding.run_test` with the appropriate verification command:
- TypeScript: `npx tsc --noEmit`
- If tests exist: `npm test`
- If linter configured: `npx eslint --no-error-on-unmatched-pattern`

### Step 5: Apply or rollback
- **If verification passes:** Use `coding.apply_patch` to merge to live
- **If verification fails:** Fix the issue and re-verify, or rollback

### Step 6: Cleanup
Use `coding.remove_worktree` to clean up the staging environment.

## Anti-patterns
- ❌ Never use `write_file` directly (bypasses tracking and staging)
- ❌ Never skip the read step (leads to lost comments, broken imports)
- ❌ Never apply patch without verification
- ❌ Never leave worktrees dangling (always cleanup)

## Success criteria
- All changes verified via `coding.run_test`
- No existing tests broken
- Worktree cleaned up after completion
