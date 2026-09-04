---
name: tdd-london
category: coding
description: >-
  London School (mockist) TDD — outside-in development driven by behavior and
  collaborator interactions. Use it when designing new units with clear
  collaborators, or when test strategy matters more than trivial code.
keywords: [coding, tdd, testing, london-school, mocks, outside-in, red-green-refactor, bdd]
allowedTools: [fs_read_file, coding_write_file_tracked, coding_run_test, search_content]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 900
outputFormat: text
tags: [coding, tdd, testing, mocks]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# TDD London School (mockist, outside-in)

> Inspired by: "Growing Object-Oriented Software, Guided by Tests" (Freeman & Pryce),
> the London/mockist TDD school.

## Core idea
Drive design **outside-in**: start from the desired behavior at the boundary,
then discover the collaborators a unit needs. Mock the collaborators to specify
the **interactions** (the contract between objects), not just return values.

- **London (mockist):** test behavior and collaborations; mock dependencies; verify interactions. Good for discovering interfaces and decoupled design.
- **Detroit/Classicist:** test state; use real objects; verify end results. Better for pure logic/algorithms.

Pick London when the unit **coordinates collaborators**. Pick classicist for **pure computation** — do not over-mock value logic.

## The cycle (red → green → refactor)
1. **Red** — write one failing test describing the next behavior.
2. **Green** — simplest code to pass (even hardcoded at first).
3. **Refactor** — remove duplication, clarify names, keep tests green.
Small steps; never write code without a failing test demanding it.

## Outside-in workflow
1. Start with an **acceptance test** for the feature at the system boundary (the "what").
2. Drop to a **unit test** for the top-level object; mock its collaborators.
3. Those mocks reveal the next interfaces to build → recurse inward.
4. Work down until collaborators are real, simple, or already tested.
5. The acceptance test goes green when the chain is complete.

## What to mock — and what NOT to
- **Mock:** owned abstractions you designed (repositories, gateways, services you control).
- **Do NOT mock:** value objects, pure functions, types you don't own (HTTP client internals, libs) — wrap them in an adapter and mock the adapter instead.
- Avoid over-specification: assert the interactions that matter, not every call. Brittle "mock everything" tests break on refactor.

## Test quality checklist
- [ ] One behavior per test; name states the behavior (`returns 401 when token expired`).
- [ ] Arrange-Act-Assert structure is visible.
- [ ] Test fails for the right reason before implementation (verify red).
- [ ] Mocks verify a meaningful contract, not implementation trivia.
- [ ] Edge cases covered: empty, null, boundary, error path.
- [ ] No logic in tests (no loops/conditionals deciding assertions).
- [ ] Fast and deterministic — no real network/clock/filesystem in unit tests.

## Few-shot

```typescript
// Outside-in: specify the interaction with a mocked collaborator
it('charges the customer once when the order is placed', async () => {
  const payments = { charge: vi.fn().mockResolvedValue({ ok: true }) };
  const service = new OrderService(payments);

  await service.place({ customerId: 'c1', amount: 100 });

  expect(payments.charge).toHaveBeenCalledExactlyOnceWith('c1', 100);
});
```

```typescript
// ❌ over-mocking pure logic — brittle and pointless
const adder = { add: vi.fn().mockReturnValue(3) };
// ✅ test pure logic with real values (classicist)
expect(add(1, 2)).toBe(3);
```

## Output format (working note)

```markdown
## TDD plan — [unit/feature]
- Acceptance test: [behavior at boundary]
- Collaborators to mock: [...]
- Unit tests (red list): [behavior 1, behavior 2, edge cases]
- Cycle log: red→green→refactor per behavior, `coding_run_test` status
```

## Success criteria
- Each behavior was demonstrably red before green.
- Mocks express contracts, not incidental calls.
- Pure logic tested with real values, not mocked.
- All tests green via `coding_run_test`; edge cases covered.
