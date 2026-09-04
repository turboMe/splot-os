---
name: fix-typescript-error
category: coding
description: Diagnose and fix TypeScript compilation errors by analyzing error messages, reading affected files, and applying minimal targeted patches.
keywords: [typescript, tsc, compilation, type-error, import, interface]
allowedTools: [view, search_content, coding_write_file_tracked, coding_run_test]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 450
outputFormat: patch
tags: [typescript, error-fix, compiler]
version: 1
success_rate: 0.17
total_uses: 6
last_used: 2026-08-18
handoffCapable: true
---
# Fix TypeScript Error

## Trigger
Agent receives a TSC error with file path, line number, and error code.

## Procedure

### Step 1: Read the error
Parse the error message to extract:
- **File path** (e.g., `src/mastra/services/foo.ts`)
- **Line number** (e.g., `:42`)
- **Error code** (e.g., `TS2345`, `TS7006`)
- **Error description**

### Step 2: Read the affected file
Use `view` to read the file around the error line (±20 lines for context).

### Step 3: Identify the root cause
Common patterns:
- **TS2345** (argument type mismatch): Check function signature and caller
- **TS2339** (property does not exist): Check type definition or add optional chaining
- **TS7006** (implicit any): Add explicit type annotation
- **TS2304** (cannot find name): Missing import
- **TS2322** (type not assignable): Interface mismatch
- **TS2353** (object literal extra properties): Remove unknown property or widen type

### Step 4: Search for related patterns
Use `search_content` to find:
- How the type/interface is used elsewhere in the project
- Existing patterns for similar fixes

### Step 5: Apply the fix
Use `coding.write_file_tracked` to make the minimal change that resolves the error.

**Rules:**
- Change as few lines as possible
- Prefer widening types over casting (e.g., `as unknown as X` is a last resort)
- If the fix requires an import, add it at the top of the file
- Never delete existing comments or documentation

### Step 6: Verify
Run `coding.run_test` with `npx tsc --noEmit` to confirm the error is fixed
and no new errors were introduced.

## Success criteria
- `npx tsc --noEmit` exits with code 0
- No new type errors introduced
- Change is minimal and doesn't alter runtime behavior
