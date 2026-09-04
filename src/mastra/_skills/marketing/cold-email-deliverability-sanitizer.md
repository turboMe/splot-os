---
name: cold-email-deliverability-sanitizer
description: Sanitize cold outreach copy, strip spam trigger words, optimize subject lines, and enforce strict B2B deliverability standards.
category: marketing
keywords:
  - email
  - deliverability
  - spam
  - outreach
  - marketing
  - sales
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 373
outputFormat: markdown
tags:
  - marketing
  - email
  - fast-tier
version: 1
---

# Procedure: Cold Email Deliverability & Copy Sanitizer

Use this procedure before sending or drafting outbound sales emails to ensure high inbox placement rates (primary tab) and avoid spam filters.

---

## 1. Deliverability & Copy Rules

1. **Spam Trigger Elimination:**
   - Strip aggressive marketing buzzwords: *"100% free"*, *"Guaranteed ROI"*, *"Act now"*, *"Risk-free"*, *"Cash bonus"*, excessive exclamation marks (`!!!`), and ALL-CAPS words.
   - Eliminate tracking links or naked URLs in the first touchpoint (use plain text or single domain links).

2. **B2B Cold Email Formula (The 3-Sentence Rule):**
   - **Sentence 1 (Relevant Observation):** Specific trigger or compliment regarding their company/role.
   - **Sentence 2 (Value / Problem):** Concise 1-sentence value proposition or peer benchmark.
   - **Sentence 3 (Low-Friction CTA):** Low-commitment interest check (e.g., *"Open to checking a 2-minute loom?"* instead of *"Book a 45-minute call"*).
   - **Length:** Keep total body under 80 words.

3. **Subject Line Optimization:**
   - 2 to 4 words max, lowercase, conversational, no clickbait (e.g., *"quick question re: [company]"*, *"idea for [initiative]"*).

---

## 2. Output Contract

```markdown
### 📬 Cleaned Outreach Email

- **Subject Line Options:**
  1. `<Option A - 3 words>`
  2. `<Option B - 3 words>`
- **Word Count:** <Number of words - must be < 80>
- **Spam Score:** [LOW / ZERO SPAM TRIGGERS]

#### Body:
```text
<Cleaned email body>
```
```
