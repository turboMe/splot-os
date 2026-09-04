---
name: json-schema-repair
description: "Use for repair, coerce, and validate corrupted, truncated, or markdown-polluted JSON into strict target schema."
category: coding
keywords:
  - json
  - repair
  - schema
  - validation
  - parsing
  - zod
minComplexity: trivial
recommendedTier: fast
preferLocal: true
estimatedTokens: 311
outputFormat: raw-json
tags:
  - data-hygiene
  - transformation
  - fast-tier
version: 1
---

# Procedure: JSON Schema Repair

Use this procedure when received text contains broken JSON, unclosed brackets, single quotes, or unwanted markdown wrappers (` ```json `), and downstream systems require strict `JSON.parse()` compatibility.

---

## 1. Execution Rules

1. **Strict Raw JSON Output:**
   - Return ONLY valid JSON syntax.
   - Do NOT include markdown code blocks (` ```json ` or ` ``` `), introductory text, or concluding notes.
   - The first character of output must be `{` or `[`.

2. **Common Corruption Fixes:**
   - **Unclosed Brackets:** Close missing curly `}` or square `]` brackets, removing the last incomplete key/value pair if truncated.
   - **Quotes:** Replace single quotes `'key'` with double quotes `"key"`.
   - **Trailing Commas:** Remove trailing commas before closing brackets (e.g., `{"a": 1,}` -> `{"a": 1}`).
   - **Invalid Literals:** Replace `undefined`, `NaN`, `None` with `null` or appropriate defaults.
   - **Escaped Characters:** Fix invalid escape sequences (`\n`, `\"`, `\\`).

3. **Schema Coercion:**
   - If a target schema or field list is provided, ensure required keys are present (fill with defaults: `null`, `""`, `[]`, or `0`).
   - Strip unmapped or severely corrupted outlier fields.
