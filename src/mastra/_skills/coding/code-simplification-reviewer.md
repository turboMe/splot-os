---
name: code-simplification-reviewer
description: "Use for review code snippets to eliminate premature abstractions, flatten deeply nested control flow, and enforce straightforward clarity."
category: coding
keywords:
  - refactor
  - simplification
  - clean-code
  - complexity
  - code-review
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 333
outputFormat: markdown
tags:
  - code-quality
  - simplification
  - fast-tier
version: 1
---

# Procedure: Code Simplification Reviewer

Use this procedure (inspired by Addy Osmani's Code Simplification discipline) to review and flatten over-engineered code, replacing complex design patterns with clear, maintainable TypeScript/JavaScript logic.

---

## 1. Simplification Rules

1. **Flatten Deep Nesting (Early Returns):**
   - Replace nested `if/else` ladders with guard clauses and early returns.
   - Limit nesting depth to a maximum of 2 levels.

2. **Remove Premature Abstractions:**
   - Inline single-use helper functions that add cognitive overhead.
   - Replace complex inheritance or generic factory patterns with plain object maps or simple functions.

3. **Simplify Boolean Expressions:**
   - Simplify compound booleans using De Morgan's laws.
   - Extract convoluted conditions into self-documenting descriptive variables (`const isUserEligible = ...`).

4. **Preserve Exact Runtime Behavior:**
   - Do NOT alter external function signatures or return types.
   - Ensure all edge cases (`null`, `undefined`, empty collections) behave identically.

---

## 2. Output Contract

```markdown
### 🧹 Code Simplification

- **Complexity Reduction:** <Summary of eliminated patterns>
- **Lines of Code:** <Before vs After count>

#### Simplified Code:
```typescript
// Flattened, simplified implementation
```
```
