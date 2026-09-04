---
name: wcag-accessibility-audit
description: Digital accessibility audit for HTML/JSX/Tailwind interfaces adhering strictly to WCAG 2.2 AA standards (contrast, ARIA, focus traps, keyboard navigation).
category: design
keywords:
  - a11y
  - wcag
  - accessibility
  - aria
  - keyboard
minComplexity: medium
recommendedTier: balanced
allowedTools:
  - view
  - search_content
estimatedTokens: 301
outputFormat: markdown
tags:
  - design
  - a11y
  - subagent-tier
version: 1
---

# Procedure: WCAG 2.2 AA Accessibility Audit

Use this procedure (inspired by Vercel Web Design Guidelines) to audit UI components for accessibility compliance.

---

## 1. Compliance Checklist

1. **Semantics & Screen Readers:**
   - Icon-only buttons must have `aria-label` or visually hidden `.sr-only` text.
   - Form inputs must be linked to `<label htmlFor="...">`.
   - Use landmark tags (`<main>`, `<nav>`, `<header>`, `<article>`) rather than arbitrary nested `<div>` wrappers.

2. **Keyboard Navigation & Focus Management:**
   - Every interactive element must display a visible `:focus-visible` ring.
   - Modals and drawers must implement active focus trapping and dismiss on `Escape`.
   - Logical tab order matching visual flow.

3. **Color Contrast:**
   - Regular body text must meet minimum 4.5:1 contrast against background.
   - Large text (≥18pt or 14pt bold) and interactive controls must meet minimum 3:1.

---

## 2. Output Contract

```markdown
### ♿ Accessibility (WCAG 2.2 AA) Audit

| Element / File | WCAG Guideline | Violation | Remediation |
|---|---|---|---|
| `<button className="p-2">` | 4.1.2 Name, Role, Value | Missing label | Add `aria-label="Close dialog"` |
```
