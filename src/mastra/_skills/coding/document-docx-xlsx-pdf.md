---
name: document-docx-xlsx-pdf
description: Structure, extract, and generate data payloads for Office documents (DOCX, PPTX, XLSX) and structured PDFs using headless tooling.
category: coding
keywords:
  - docx
  - pptx
  - xlsx
  - pdf
  - office
  - reporting
minComplexity: medium
recommendedTier: balanced
allowedTools:
  - view
  - search_content
estimatedTokens: 278
outputFormat: markdown
tags:
  - documents
  - office
  - subagent-tier
version: 1
---

# Procedure: Structured Office & PDF Document Generation

Use this procedure (inspired by Anthropic's official `docx`, `pptx`, `xlsx`, and `pdf` skills) to structure data schemas and headless generation scripts for office deliverables.

---

## 1. Document Structuring Standards

1. **Spreadsheets (XLSX / SheetJS):**
   - Structure sheets with explicit headers, typed numeric/date columns, and automated column width calculations.
   - Separate raw data tabs from summary/KPI dashboard tabs.

2. **Documents & Presentations (DOCX / PPTX):**
   - Enforce hierarchical heading structures (`Heading 1`, `Heading 2`).
   - Use consistent slide layouts (Title slide, 2-column comparative, KPI metric grid).
   - Never embed unformatted raw markdown into binary document generators.

3. **PDF Generation (HTML to PDF / Puppeteer):**
   - Enforce print CSS page break rules (`page-break-inside: avoid;`, `@page { margin: 20mm; }`).
   - Embed fonts locally to avoid missing font artifacts.

---

## 2. Output Contract
Return the generation schema or headless Node.js/Python script that compiles the target document.
