---
name: spec-driven-feature-builder
description: "Use for spec-First methodology: authoring comprehensive, verifiable technical specifications and acceptance criteria before writing implementation code."
category: meta
keywords:
  - spec
  - design
  - architecture
  - requirements
  - planning
minComplexity: complex
recommendedTier: pro
allowedTools:
  - view
  - search_content
estimatedTokens: 171
outputFormat: markdown
tags:
  - architecture
  - planning
  - meta-tier
version: 1
---

# Procedure: Spec-Driven Feature Builder

Use this procedure (from Addy Osmani's Spec-Driven Development) before writing code for any non-trivial feature or module.

---

## 1. Required Specification Sections

1. **Problem & Business Goal:** Clear rationale and user-facing value.
2. **Measurable Success Metrics:** Hard metrics (e.g., *p95 latency < 150ms*, *0 new typescript errors*).
3. **Input / Output Contracts:** Strict Zod/TypeScript schemas for request parameters and return values.
4. **Error Handling & Edge Cases:** Behavior during timeouts, missing resources, and rate limits.
5. **Automated Verification Plan:** Explicit list of unit and integration test assertions.
