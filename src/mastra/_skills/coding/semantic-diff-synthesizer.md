---
name: semantic-diff-synthesizer
description: Transform raw unified git diffs into human-readable release notes, PR changelogs, and semantic impact summaries.
category: coding
keywords:
  - diff
  - git
  - changelog
  - synthesis
  - summary
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 284
outputFormat: markdown
tags:
  - git
  - diff
  - fast-tier
version: 1
---

# Procedure: Semantic Diff Synthesizer

Use this procedure to convert raw unified git diffs into clean, executive changelogs highlighting business logic changes rather than raw line numbers.

---

## 1. Execution Rules

1. **Semantic Understanding Over Line Mechanics:**
   - Avoid mechanical descriptions like *"Added line 45"*.
   - Explain *intent* and *impact*: *"Added input validation for email fields before triggering Stripe checkout"*.
   - Explicitly flag any Breaking Changes.

2. **Categorization:**
   Group modifications into:
   - 🚀 **Features:** New user-visible capabilities.
   - 🐛 **Fixes:** Bug and regression fixes.
   - 🔒 **Security:** Hardening, token handling, sanitization.
   - ⚡ **Performance:** Cache additions, query optimization, bundle reduction.
   - 🧹 **Refactor:** Code cleanups without behavioral changes.

---

## 2. Output Contract

```markdown
### 📝 Semantic Changelog

- **Core Impact:** <1-sentence high-level summary>
- **Breaking Changes:** [NONE | DETECTED: <description>]

#### Changes by Module:
- **[Feature/Fix]** `path/to/module.ts`: <Concise description of modified behavior>
```
