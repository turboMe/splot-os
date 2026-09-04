---
name: md-to-office
description: >
  Convert Markdown text to professional Office formats (DOCX, XLSX, PPTX, PDF, HTML,
  CSV, JSON, XML, LaTeX, Jupyter Notebook) using the markdown-exporter CLI tool.
  Reverse pipeline complement to office-to-md.
category: coding
keywords:
  - markdown
  - docx
  - xlsx
  - pptx
  - pdf
  - html
  - csv
  - json
  - xml
  - latex
  - export
  - conversion
  - document-generation
source: https://github.com/bowenliang123/markdown-exporter
license: Apache-2.0
recommendedTier: pro
handoffCapable: true
---

# Markdown → Office Export Skill

Transform Markdown text into professional document formats using the
`markdown-exporter` CLI tool (Python, Apache 2.0).

> **Relationship**: This skill is the reverse of `office-to-md`.
> Together they form a bidirectional document pipeline:
> `office-to-md` (import) ↔ `md-to-office` (export).

## Installation

```bash
# Using pip
pip install md-exporter

# Using uv (recommended)
uv tool install md-exporter

# Verify
markdown-exporter -h
```

## Supported Conversions

| Tool | Input | Output |
|------|-------|--------|
| `md_to_docx` | Markdown text | Word document (.docx) |
| `md_to_xlsx` | Markdown tables | Excel spreadsheet (.xlsx) |
| `md_to_pptx` | Markdown slides (Pandoc style) | PowerPoint (.pptx) |
| `md_to_pdf` | Markdown text | PDF document (.pdf) |
| `md_to_html` | Markdown text | HTML file (.html) |
| `md_to_csv` | Markdown tables | CSV file (.csv) |
| `md_to_json` | Markdown tables | JSON/JSONL file (.json) |
| `md_to_xml` | Markdown text | XML file (.xml) |
| `md_to_latex` | Markdown tables | LaTeX file (.tex) |
| `md_to_ipynb` | Markdown text | Jupyter Notebook (.ipynb) |
| `md_to_codeblock` | Code blocks | Individual source files |
| `md_to_md` | Markdown text | Markdown file (.md) |

## Usage Patterns

### Basic CLI Syntax

```bash
markdown-exporter <subcommand> <input.md> <output.ext> [options]
```

All commands take **file paths** as input (not stdin).

### 1. Markdown → Word Document

```bash
# Basic conversion
markdown-exporter md_to_docx /path/input.md /path/output.docx

# With custom template for branded styling
markdown-exporter md_to_docx /path/input.md /path/output.docx --template /path/template.docx
```

### 2. Markdown Tables → Excel

```bash
# Each markdown table becomes a separate sheet
markdown-exporter md_to_xlsx /path/input.md /path/output.xlsx

# Force all cells to text type
markdown-exporter md_to_xlsx /path/input.md /path/output.xlsx --force-text True
```

### 3. Markdown → PowerPoint

Slides must follow [Pandoc slide show syntax](https://pandoc.org/MANUAL.html#slide-shows):
- `# Heading 1` = section dividers
- `## Heading 2` = individual slides
- `---` = horizontal rules for slide breaks
- `::::: columns` / `::: column` = multi-column layouts
- `::: notes` = speaker notes

```bash
# Basic slides
markdown-exporter md_to_pptx /path/slides.md /path/presentation.pptx

# With branded template
markdown-exporter md_to_pptx /path/slides.md /path/output.pptx --template /path/template.pptx
```

### 4. Markdown → PDF

```bash
markdown-exporter md_to_pdf /path/input.md /path/output.pdf
```

### 5. Markdown Tables → JSON/JSONL

```bash
# JSONL format (default) — one JSON object per line
markdown-exporter md_to_json /path/input.md /path/output.json

# JSON array format
markdown-exporter md_to_json /path/input.md /path/output.json --style json_array
```

### 6. Extract Code Blocks

```bash
# Extract to directory (each block → separate file by language)
markdown-exporter md_to_codeblock /path/input.md /path/output_dir/

# Extract and compress to ZIP
markdown-exporter md_to_codeblock /path/input.md /path/output.zip --compress
```

## Common Options

| Option | Description | Available In |
|--------|-------------|-------------|
| `--template` | Custom DOCX/PPTX template path | md_to_docx, md_to_pptx |
| `--strip-wrapper` | Remove code block wrapper (```) | Most tools |
| `--force-text` | Force cell values to text type | md_to_xlsx |
| `--style` | JSON output style: `jsonl` or `json_array` | md_to_json |
| `--compress` | Bundle output into ZIP archive | md_to_codeblock |

## Workflow Integration

### Report Generation Pipeline

```bash
# 1. Agent generates analysis in Markdown
# 2. Export to multiple formats
markdown-exporter md_to_docx report.md report.docx --template brand.docx
markdown-exporter md_to_pdf report.md report.pdf
markdown-exporter md_to_xlsx data_tables.md data.xlsx
```

### Bidirectional Document Pipeline

```bash
# Import: Office → Markdown (using office-to-md skill)
markitdown document.docx > content.md

# Process/Transform with AI...

# Export: Markdown → Office (using this skill)
markdown-exporter md_to_docx content.md output.docx
```

### RAG Data Export

```bash
# Convert structured analysis tables to machine-readable formats
markdown-exporter md_to_json analysis.md data.jsonl
markdown-exporter md_to_csv analysis.md data.csv
```

## Key Implementation Details

- **All input must be file paths** — write Markdown to a temp file first if needed
- **Multiple tables** in one file → multiple sheets in XLSX, numbered output files
- **Pandoc-style slides** required for PPTX — standard Markdown won't produce correct layouts
- **Template support**: Custom DOCX/PPTX templates let you match corporate branding
- **No external dependencies beyond Python** — pure Python conversion engine
