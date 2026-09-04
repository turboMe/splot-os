# Task Understanding & Testing Quality

> **Phase:** F3 (Skills Audit Implementation Plan)  
> **Status:** ✅ Implemented  
> **Date:** 2026-05-09

## Overview

Phase 3 enhances the agent's ability to properly understand tasks before coding and produce high-quality test coverage. These skills improve the "thinking before doing" capability.

## Components

### 1. Ambiguity Resolver (`_skills/meta/ambiguity-resolver.md`)

Decision framework for when agents MUST ask vs when they CAN assume:

```
HIGH ambiguity + HIGH impact → 🔴 MUST ASK
HIGH ambiguity + LOW impact  → 🟡 SHOULD ASK
LOW ambiguity  + HIGH impact → 🟡 CAN ASSUME (state it)
LOW ambiguity  + LOW impact  → 🟢 CAN ASSUME
```

**Key features:**
- 15-point ambiguity detection checklist (scope, technical, behavior, integration, verification)
- Scoring: 0-2 unchecked → proceed, 3-5 → cautious, 6+ → must ask
- Question templates for scope, technical choice, and assumption statements
- Anti-patterns: analysis paralysis, blind execution, premature implementation

### 2. Acceptance Criteria Builder (`_skills/meta/acceptance-criteria-builder.md`)

Generates structured Given/When/Then scenarios before coding:

- **3-5 scenarios per feature** (happy path + edge case + error case)
- **Edge case inventory** covering input, state, and integration edge cases
- **Definition of Done** checklist generator (functionality, code quality, testing, documentation)
- **Integration with `diagnosticPlan.verificationPlan`** for automated verification

### 3. Integration Testing (`_skills/coding/integration-testing.md`)

Comprehensive patterns for integration tests:

- **API endpoint testing** with supertest
- **Database layer testing** with mongodb-memory-server
- **External API mocking** with vitest `vi.fn()`
- **Test fixtures** pattern for reusable test data
- **Isolation rules** — independent tests, clean state, no network calls

## Skills Created

| Skill | File | Category |
|-------|------|----------|
| `ambiguity-resolver` | `_skills/meta/ambiguity-resolver.md` | Task Understanding |
| `acceptance-criteria-builder` | `_skills/meta/acceptance-criteria-builder.md` | Quality Planning |
| `integration-testing` | `_skills/coding/integration-testing.md` | Test Patterns |

## Impact on Agent Workflow

```
Task received
    │
    ▼
ambiguity-resolver  →  Ask/Assume decision
    │
    ▼
acceptance-criteria-builder  →  Given/When/Then + DoD
    │
    ▼
coding (with clear criteria)
    │
    ▼
integration-testing patterns  →  Write tests
    │
    ▼
verification against acceptance criteria
```
