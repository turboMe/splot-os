---
name: anti-slop-content-sanitizer
description: "Use for strip AI cliches, buzzwords, inflated adjectives, and synthetic passive phrasing from emails, marketing copy, and documentation."
category: marketing
keywords:
  - anti-slop
  - copywriting
  - editing
  - tone
  - natural-language
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 243
outputFormat: text
tags:
  - content
  - editing
  - fast-tier
version: 1
---

# Procedure: Anti-Slop Content Sanitizer

Use this procedure to eliminate synthetic AI mannerisms, inflated buzzwords, and repetitive cliches from drafts, emails, and articles.

---

## 1. Blacklist of AI Cliches & Phrasing

1. **Banned Openers & Metaphors:**
   - *"In today's fast-paced digital landscape..."*
   - *"Let's dive into / delve into..."*
   - *"Game-changer / Revolutionary / Seamlessly integrate / Robust solution"*
   - *"It is crucial to remember / It is worth noting that..."*
   - *"Testament to / Beacon of / Unleash the power of..."*

2. **Stylistic Rules:**
   - Eliminate unnecessary emojis (keep 0, max 1 for casual notes).
   - Cut redundant introductory and concluding filler sentences.
   - Replace abstract praise with verifiable facts and metrics (e.g., replace *"our lightning-fast tool"* with *"executes in under 200ms"*).

---

## 2. Output Contract
Return ONLY the cleaned, human-sounding text without meta-commentary or disclaimers.
