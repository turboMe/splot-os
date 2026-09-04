---
name: regex-optimizer
description: Construct, analyze, and optimize regular expressions (RegEx) for performance and ReDoS vulnerability prevention.
category: coding
keywords:
  - regex
  - regexp
  - optimization
  - redos
  - parsing
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 227
outputFormat: markdown
tags:
  - logic
  - regex
  - fast-tier
version: 1
---

# Procedure: Regex Optimizer & Explainer

Use this procedure to generate or optimize regular expressions for JavaScript/TypeScript environments while preventing Catastrophic Backtracking (ReDoS).

---

## 1. Execution Rules

1. **ReDoS Vulnerability Prevention:**
   - Avoid nested quantifiers (e.g., `(a+)+` or `([a-zA-Z]+)*`).
   - Use atomic grouping or mutually exclusive character classes.
   - Anchor expressions with `^` and `$` whenever matching complete strings.

2. **JavaScript / V8 Engine Compatibility:**
   - Ensure syntax compatibility with standard ECMAScript `RegExp`.
   - Set appropriate flags: `g` (global), `i` (case-insensitive), `m` (multiline), `u` (unicode), `s` (dotAll).

3. **Output Contract:**
   Return:
   1. **Constructed RegEx** (in a code block).
   2. **Flags**.
   3. **Step-by-step breakdown** (2-3 concise points).
   4. **3 Match examples and 2 Non-Match examples**.
