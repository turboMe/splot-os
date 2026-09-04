---
name: modern-react-perf-audit
description: "Use for performance audit of React 19 / Next.js components targeting re-render cascades, useEffect misuses, missing memoization, and Server/Client boundary optimization."
category: coding
keywords:
  - react
  - nextjs
  - performance
  - rerender
  - useeffect
  - memo
minComplexity: medium
recommendedTier: pro
allowedTools:
  - view
  - search_content
  - lsp_inspect
estimatedTokens: 322
outputFormat: markdown
tags:
  - react
  - performance
  - subagent-tier
version: 1
---

# Procedure: Modern React & Next.js Performance Audit

Use this procedure (inspired by Vercel React Best Practices) when auditing frontend code for rendering performance, hydration overhead, and bundle efficiency.

---

## 1. Audit Dimensions

1. **React Server Component (RSC) Boundaries:**
   - Keep `'use client'` strictly at the leaves of the component tree.
   - Never fetch data in Client Components when data can be fetched in Server Components or passed via Server Actions.

2. **Re-render Cascades & Memoization:**
   - Identify inline object/array allocations passed as props to memoized children.
   - Use `useMemo` / `useCallback` strategically for heavy computations or reference-stable handlers.
   - Replace unnecessary `useEffect` state syncing with derived state.

3. **Asset & Dynamic Imports:**
   - Ensure heavy third-party components (charts, rich-text editors) are lazy-loaded via `dynamic(() => import(...), { ssr: false })`.

---

## 2. Output Contract

```markdown
### ⚡ React Performance Audit

| Component / File | Issue | Severity | Proposed Remediation |
|---|---|---|---|
| `components/DataGrid.tsx` | Inline object in dependency array | Medium | Hoist static config outside component |

#### Optimized Refactor:
```tsx
// Optimized component code
```
```
