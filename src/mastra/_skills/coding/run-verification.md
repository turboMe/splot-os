---
name: run-verification
category: coding
description: Run verification commands (TSC, tests, linters) and interpret results. Determines if code changes are safe to apply.
keywords: [test, verify, tsc, lint, check, validation]
allowedTools: [coding_run_test, view]
minComplexity: trivial
recommendedTier: fast
estimatedTokens: 300
outputFormat: verdict
tags: [verification, testing, quality-gate]
version: 1
success_rate: 1
total_uses: 1
last_used: 2026-08-18
handoffCapable: true
---
# Run Verification

## Trigger
Agent needs to verify that code changes are correct before applying them.

## Procedure

### Step 1: Run TypeScript check
Execute `coding.run_test` with command `npx tsc --noEmit`.

**Interpret results:**
- Exit code 0 → ✅ No type errors
- Exit code 1 → ❌ Type errors found → parse error messages

### Step 2: Run tests (if applicable)
Check if test files exist for the modified files:
- Look for `*.test.ts`, `*.spec.ts` in the same directory
- If found, run `coding.run_test` with `npx jest --passWithNoTests`

### Step 3: Produce verdict
Report one of:
- **PASS** — all checks passed, safe to apply
- **FAIL_TYPE** — type errors found (include error details)
- **FAIL_TEST** — tests failed (include failure summary)
- **FAIL_LINT** — lint violations (include count and severity)

### Decision matrix

| TSC | Tests | Verdict | Action |
|-----|-------|---------|--------|
| ✅ | ✅ or N/A | PASS | Apply patch |
| ❌ | any | FAIL_TYPE | Fix types first |
| ✅ | ❌ | FAIL_TEST | Fix failing tests |

## Success criteria
- Clear verdict with actionable error details if failed
- No false positives (don't report pass if there are errors)
