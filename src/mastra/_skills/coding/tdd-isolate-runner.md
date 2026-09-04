---
name: tdd-isolate-runner
description: Enforce a strict Red-Green-Refactor (TDD) cycle for isolated units and functions before committing changes to production code.
category: coding
keywords:
  - tdd
  - test
  - vitest
  - refactor
  - unit-test
minComplexity: medium
recommendedTier: pro
allowedTools:
  - view
  - coding.write_file_tracked
  - execute_command
estimatedTokens: 204
outputFormat: markdown
tags:
  - testing
  - tdd
  - subagent-tier
version: 1
---

# Procedure: TDD Isolate Runner (Red-Green-Refactor)

Use this procedure when implementing new business logic or bug fixes to ensure complete test coverage for edge cases.

---

## 1. Execution Cycle

1. **Step 1 (RED):**
   - Write a unit test (`*.test.ts`) covering expected inputs, edge cases (`null`, empty arrays, network failures), and boundary conditions.
   - Run the test suite (`vitest run path/to/file.test.ts`) and confirm that **the test FAILS for the expected reason**.

2. **Step 2 (GREEN):**
   - Write the minimal production code necessary to make the failing test pass.
   - Re-run the test suite and confirm it turns green (PASS).

3. **Step 3 (REFACTOR):**
   - Clean up code structure, improve variable naming, remove dead code, and ensure strict TypeScript types while keeping tests green.
