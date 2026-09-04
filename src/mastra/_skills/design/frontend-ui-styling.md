---
name: frontend-ui-styling
description: "Use for craft distinctive, bespoke frontend interfaces with cohesive typography, Tailwind v4 design tokens, and refined micro-interactions, avoiding generic AI slop."
category: design
keywords:
  - frontend
  - tailwind
  - design
  - typography
  - ui
  - anti-slop
minComplexity: medium
recommendedTier: pro
allowedTools:
  - view
  - search_content
estimatedTokens: 315
outputFormat: markdown
tags:
  - frontend
  - styling
  - subagent-tier
version: 1
---

# Procedure: Frontend UI Styling & Design Tokens

Use this procedure (inspired by Anthropic's `frontend-design` and `theme-factory` skills) to build visually polished, brand-aligned interfaces that feel deliberate and handcrafted rather than generic template AI outputs.

---

## 1. Design Principles

1. **Avoid Generic "AI Slop" Aesthetics:**
   - Avoid overused purple/indigo gradients on pure black backgrounds unless explicitly requested.
   - Choose purposeful color palettes: neutral slates/zincs with a single sharp accent color.
   - Use high-contrast, clean typography (e.g., modern sans-serif like Inter/Geist or crisp monospace for technical dashboards).

2. **Spacing & Visual Hierarchy:**
   - Adhere strictly to a 4px/8px spatial grid (`p-2`, `p-4`, `p-6`, `gap-4`).
   - Use subtle borders (`border border-zinc-200/80 dark:border-zinc-800/80`) and muted background cards rather than harsh drop shadows.

3. **Micro-Interactions:**
   - Add snappy transitions (`transition-colors duration-150`, active scale states `active:scale-[0.98]`).
   - Ensure hover states provide immediate, subtle visual feedback.

---

## 2. Output Contract
Return the complete component markup (React/JSX/Tailwind) with inline styling tokens and layout structure.
