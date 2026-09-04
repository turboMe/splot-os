---
name: sparc
category: coding
description: >-
  SPARC methodology (Specification, Pseudocode, Architecture, Refinement,
  Completion) — a structured process from requirements to working code.
  Use it for complex feature/refactor tasks that need design before coding.
keywords: [coding, methodology, sparc, design, architecture, specification, refinement, tdd]
allowedTools: [fs_read_file, search_content, coding_write_file_tracked, coding_run_test]
minComplexity: complex
recommendedTier: pro
estimatedTokens: 700
outputFormat: text
tags: [coding, methodology, sparc, design]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# SPARC — Structured implementation process

> Inspired by the SPARC methodology (Specification → Pseudocode → Architecture →
> Refinement → Completion). For complex tasks where jumping straight to code
> causes rework and gaps.

## When to use
- Complex feature / refactor spanning >1 file or non-trivial logic.
- Unclear requirements worth pinning down before coding.
- **Do not use** for simple changes (single file, obvious fix) — it is overhead.

## Phase 1: Specification (What and why)
Before writing a line of code, establish:
- **Goal** — what problem we solve, what value it delivers.
- **Inputs/outputs** — the contract: types, formats, ranges.
- **Acceptance criteria** — measurable "done" conditions (best: as a list of testable assertions).
- **Constraints** — performance, compatibility, security, repo style.
- **Edge cases** — empty input, null, boundaries, external errors.

> Output: a short spec (5-10 lines). If requirements are unclear — close them first.

## Phase 2: Pseudocode (How — logic)
- Lay out the algorithm in pseudocode / steps, without language syntax.
- Identify data structures and key operations.
- Mark decision points and loops — look here for O(n²), N+1, blocking complexity.
- **Design the tests here** (TDD): one per acceptance-criteria assertion.

## Phase 3: Architecture (Where — structure)
- How does the change fit existing code? Which modules/files we touch.
- Responsibility boundaries: what is new vs an extension.
- Dependencies and data-flow direction.
- Minimize scope: no unsanctioned refactors outside the task.

## Phase 4: Refinement (Iterative implementation + TDD)
Loop, one small step at a time:
1. Write a test (red) — from phase 2.
2. Simplest implementation (green).
3. Refactor (clean) — without changing behavior.
4. Run tests (`coding_run_test`), repeat.
- For test strategy → skill `tdd-london`.

## Phase 5: Completion (Verification and closing)
- All acceptance criteria met and covered by a test.
- Run full verification → skill `run-verification` (lint/typecheck/test/build).
- No scope beyond the task; clean diff.
- Update documentation if the public contract changed.

## Output format (working note)

```markdown
## SPARC — [task]
### S: Spec
- Goal: ... / Contract: ... / Criteria: [a, b, c] / Edge: [...]
### P: Pseudocode
- algorithm steps + list of tests to write
### A: Architecture
- files: [...] / flow: ...
### R: Refinement
- TDD iterations (red→green→clean), test status
### C: Completion
- criteria ✅, run-verification PASS, docs updated
```

## Success criteria
- Spec has measurable acceptance criteria **before** code.
- Every criterion has a corresponding test.
- Completion phase = green verification + no scope creep.
