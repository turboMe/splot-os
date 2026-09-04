---
name: acceptance-criteria-builder
category: meta
description: >-
  Build testable acceptance criteria, Given-When-Then scenarios, edge cases, and definition-of-done before feature implementation. Use when planning tasks or constructing verification criteria.
keywords: [requirements, acceptance-criteria, given-when-then, testing, definition-of-done, edge-cases]
allowedTools: [fs_read_file, repo_map]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 1100
outputFormat: text
tags: [meta, planning, quality, requirements]
version: 1
success_rate: 1
total_uses: 1
last_used: 2026-06-17
handoffCapable: true
---
# Acceptance Criteria Builder

## Trigger
- Before starting any feature implementation
- When `diagnosticPlan` needs a `verificationPlan`
- When user says "implement X" without specifying success criteria
- Before code review (to verify against criteria)

## Output Format

### Given/When/Then Scenarios

```gherkin
Feature: [Feature Name]

  Scenario: Happy path — [description]
    Given [precondition]
    When [action]
    Then [expected result]

  Scenario: Edge case — [description]
    Given [precondition]
    When [edge case action]
    Then [expected handling]

  Scenario: Error case — [description]
    Given [precondition]
    When [error condition]
    Then [error handling]
```

### Example: User Login Feature

```gherkin
Feature: User Login

  Scenario: Successful login with valid credentials
    Given user is on the login page
    And user has a valid account
    When user enters correct email and password
    And clicks "Login" button
    Then user is redirected to dashboard
    And user name is displayed in header

  Scenario: Failed login with wrong password
    Given user is on the login page
    When user enters correct email but wrong password
    And clicks "Login" button
    Then error message "Invalid credentials" is displayed
    And user remains on login page
    And password field is cleared

  Scenario: Login with account locked
    Given user has failed login 5 times
    When user attempts another login
    Then error message "Account locked" is displayed
    And lockout duration is shown

  Scenario: Login form validation
    Given user is on the login page
    When user clicks "Login" without entering email
    Then validation error "Email is required" is shown
    And form is not submitted
```

## Edge Case Inventory

For every feature, systematically check:

### Input Edge Cases
| Category | Examples |
|----------|---------|
| Empty/null | Empty string, null, undefined |
| Boundary | 0, -1, MAX_INT, empty array |
| Format | Unicode, emoji, HTML injection, SQL injection |
| Size | Very long strings, huge files, many items |
| Type | Wrong type, NaN, Infinity |

### State Edge Cases
| Category | Examples |
|----------|---------|
| Concurrent | Two users editing same resource |
| Timing | Slow network, timeout, race condition |
| Order | Out-of-order events, duplicate events |
| Permission | Unauthorized access, expired token |
| Data | Missing relations, orphaned records |

### Integration Edge Cases
| Category | Examples |
|----------|---------|
| API | Service down, rate limited, wrong response |
| Database | Connection lost, duplicate key, migration |
| External | Third-party API changed, deprecated |

## Definition of Done Generator

For any task, generate a DoD checklist:

```markdown
## Definition of Done: [Task Name]

### Functionality
- [ ] All acceptance criteria scenarios pass
- [ ] Edge cases handled (see inventory)
- [ ] Error messages are user-friendly

### Code Quality
- [ ] TypeScript compiles without errors
- [ ] No new linting warnings
- [ ] Functions have JSDoc comments
- [ ] No hardcoded values (use constants/config)

### Testing
- [ ] Unit tests for new functions
- [ ] Integration tests for API changes
- [ ] E2E test for critical user flow (if applicable)

### Documentation
- [ ] README updated (if new feature)
- [ ] API docs updated (if endpoint changed)
- [ ] Migration notes (if DB schema changed)

### Review
- [ ] Self-review completed
- [ ] No TODO/FIXME left in code
- [ ] Changes are backward compatible
```

## Integration with DiagnosticPlan

```typescript
interface VerificationPlan {
  acceptanceCriteria: Array<{
    scenario: string;
    given: string;
    when: string;
    then: string;
    priority: 'critical' | 'important' | 'nice-to-have';
  }>;
  edgeCases: string[];
  definitionOfDone: string[];
  testCommands: string[];   // e.g., ['npx tsc --noEmit', 'npm test']
}
```

## Procedure

1. **Read the task description** — identify the feature/change
2. **Generate 3-5 Given/When/Then scenarios** (happy + edge + error)
3. **Run edge case inventory** — check each category
4. **Produce Definition of Done** checklist
5. **Output verification commands** to run after implementation

## Success Criteria
- Every task has ≥ 3 acceptance criteria before coding starts
- Edge cases explicitly identified
- Definition of Done checklist generated
- Verification commands specified
