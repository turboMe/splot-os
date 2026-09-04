---
name: markdown-table-normalizer
description: "Use for standardize, align, and clean messy or broken Markdown tables and unstructured tabular text into valid GFM tables."
category: general
keywords:
  - markdown
  - table
  - formatting
  - gfm
  - normalizer
minComplexity: trivial
recommendedTier: fast
preferLocal: true
estimatedTokens: 222
outputFormat: markdown
tags:
  - formatting
  - fast-tier
version: 1
---

# Procedure: Markdown Table Normalizer

Use this procedure to convert disorganized or corrupted tabular text into clean, 100% compliant GitHub-Flavored Markdown (GFM) tables.

---

## 1. Execution Rules

1. **GFM Table Structure:**
   - Every row must begin and end with a pipe character `|`.
   - The header row must be followed by a separator row `|---|---|`.
   - Use colons for alignment: `|:---|` (left), `|:---:|` (center), `|---:|` (right). Left-align text, right-align numbers/currencies.

2. **Cell Content Sanitization:**
   - Replace newlines within cells with `<br>` or spaces.
   - Escape literal pipes inside cell content with `\|`.
   - Remove duplicate or entirely empty rows.
   - Align column widths with spaces for raw source readability.

3. **Output Contract:**
   - Return ONLY the normalized Markdown table.
   - Do NOT include markdown commentary or preambles.
