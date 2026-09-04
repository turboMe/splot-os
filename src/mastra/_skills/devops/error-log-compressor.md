---
name: error-log-compressor
description: "Use for aggressively compress noisy terminal dumps, build logs, and test traces down to root-cause errors and minimal stack traces."
category: devops
keywords:
  - log
  - error
  - compressor
  - stacktrace
  - triage
minComplexity: simple
recommendedTier: fast
preferLocal: true
estimatedTokens: 284
outputFormat: markdown
tags:
  - diagnostic
  - fast-tier
version: 1
---

# Procedure: Error Log Compressor

Use this procedure when provided with long, noisy terminal dumps (100-500+ lines from `npm build`, `vitest`, `docker`, or runtime panics) to extract the actionable essence of the failure (85%+ token reduction).

---

## 1. Execution Rules

1. **Noise Stripping:**
   - Remove successful HTTP request logs (`fetch 200`), downloading progress bars, ASCII banners, and compilation info logs.
   - Collapse repeated log lines into `... [repeated N times]`.

2. **Core Extraction:**
   - **Exit Code / Signal:** (e.g., `exit code 1`, `SIGSEGV`).
   - **Primary Error Message:** (e.g., `TypeError: Cannot read properties of undefined`).
   - **Relevant Stack Trace:** First 3-5 lines pointing to application source files (strip `node_modules` frames).
   - **Command Context:** The command that failed and key arguments.

3. **Output Contract:**
   Return a concise summary:
   ```markdown
   ### 💥 Error Digest
   - **Message:** <Core Error Message>
   - **File & Line:** `<path/to/file.ts:line>`
   - **Exit Code:** `<exit code>`

   ```
   <Minimal relevant stack trace - max 5 lines>
   ```
   ```
