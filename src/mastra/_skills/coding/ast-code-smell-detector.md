---
name: ast-code-smell-detector
description: "Use for static code analysis targeting memory leaks, unhandled promises, async race conditions, and unsafe type escapes in TypeScript/JavaScript."
category: coding
keywords:
  - ast
  - code-smell
  - static-analysis
  - memory-leak
  - typescript
  - javascript
minComplexity: medium
recommendedTier: pro
preferLocal: false
estimatedTokens: 315
outputFormat: markdown
tags:
  - code-quality
  - analysis
  - reasoning-tier
version: 1
---

# Procedure: AST Code Smell Detector

Use this procedure for deep static analysis of TypeScript/JavaScript code snippets to identify resource leaks, concurrency bugs, and anti-patterns prior to compilation or execution.

---

## 1. Audit Dimensions

1. **Resource & Memory Leaks:**
   - Uncleaned event listeners (`EventEmitter`, DOM listeners).
   - Missing `clearTimeout` / `clearInterval` in cleanup hooks or finally blocks.
   - Long-lived unbounded `Map` / `Set` references that should use `WeakMap` / `WeakSet`.
   - Unclosed file handles or database connections.

2. **Async & Concurrency Pitfalls:**
   - Unhandled promise rejections (missing `catch` or `try/catch` around `await`).
   - `async` inside `Array.prototype.forEach` without `Promise.all`.
   - Race conditions on shared mutable module-level state.

3. **Type Strictness:**
   - Unsafe casts (`as any`, `as unknown as T`).
   - Implicit `any` returns on public exports.

---

## 2. Output Contract

```markdown
### 🔍 Static Code Audit

| # | Line Range | Category | Risk & Impact | Recommended Fix |
|---|---|---|---|---|
| 1 | `L15-L22` | Memory Leak | Uncleaned interval | Add `clearInterval` in `finally` |

#### Recommended Refactor:
```typescript
// Refactored clean code
```
```
