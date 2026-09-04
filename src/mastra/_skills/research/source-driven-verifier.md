---
name: source-driven-verifier
description: Verify API usages, framework methods, and technical claims strictly against official documentation and verifiable source truth.
category: research
keywords:
  - verification
  - documentation
  - api
  - source-driven
  - ground-truth
minComplexity: medium
recommendedTier: balanced
preferLocal: false
estimatedTokens: 287
outputFormat: markdown
tags:
  - fact-checking
  - reasoning-tier
version: 1
---

# Procedure: Source-Driven Verifier

Use this procedure (inspired by Addy Osmani's Source-Driven Development) to ensure library imports, configuration flags, and API methods exist in official documentation rather than being LLM hallucinations.

---

## 1. Verification Dimensions

1. **API Signature Integrity:**
   - Confirm method names, parameters, and return types match official framework releases (e.g., Mastra, Zod, React 19, TypeScript 5+).
   - Flag deprecated methods and suggest modern equivalents.

2. **Ground Truth Citation:**
   - Anchor technical justifications in authoritative references (official docs, standard RFCs, repository source files).
   - Reject ungrounded assumptions with explicit evidence.

---

## 2. Output Contract

```markdown
### 📚 Source-Driven Verification

| Proposed API / Method | Official Status | Confidence | Verified Source / Notes |
|---|---|---|---|
| `z.object().passthrough()` | Valid | 100% | Zod Official API |
| `agent.runSync()` | Deprecated / Invalid | 100% | Mastra v0.x uses `agent.generate()` |

#### Recommendations:
- <Correction details for any hallucinated or deprecated calls>
```
