---
name: office-to-md
category: coding
description: "Convert Office documents (Word, Excel, PowerPoint, PDF) to Markdown using Microsoft's markitdown library. Use when you need to ingest document content into text-based workflows, create searchable archives, or prepare documents for AI processing."
keywords: [markdown, convert, docx, xlsx, pptx, pdf, markitdown, extraction, office]
source: claude-office-skills
recommendedTier: pro
handoffCapable: true
---

# Office to Markdown Converter

## Overview
Convert Office formats to clean Markdown using **markitdown** — Microsoft's open-source conversion tool.

## Dependencies
```bash
pip install markitdown

# For image/audio processing
pip install markitdown[all]
```

## Supported Formats
| Format | Extension | Output |
|--------|-----------|--------|
| Word | .docx | Headings, tables, lists, formatting |
| Excel | .xlsx | Each sheet → Markdown table |
| PowerPoint | .pptx | Slides as sections + speaker notes |
| PDF | .pdf | Text extraction |
| HTML | .html | Clean markdown |
| Images | .jpg, .png | OCR with vision model |

## Basic Usage

### Python API
```python
from markitdown import MarkItDown

md = MarkItDown()
result = md.convert("document.docx")
markdown_text = result.text_content

# Save to file
with open("output.md", "w") as f:
    f.write(result.text_content)
```

### Command Line
```bash
markitdown document.docx > output.md
markitdown document.docx -o output.md
```

## Format-Specific Notes

### Word → Markdown
Preserves: headings (as # headers), bold/italic, lists, tables, hyperlinks.

### Excel → Markdown
Each sheet becomes a section. Data becomes markdown tables:
```markdown
## Sheet1
| Name | Department | Salary |
|------|------------|--------|
| John | Engineering | $80,000 |
```

### PowerPoint → Markdown
Each slide becomes a section. Speaker notes included if present.

## Batch Conversion
```python
from markitdown import MarkItDown
from pathlib import Path

def batch_convert(input_dir, output_dir):
    md = MarkItDown()
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    for ext in ['.docx', '.xlsx', '.pptx', '.pdf']:
        for file in input_path.glob(f'*{ext}'):
            try:
                result = md.convert(str(file))
                out = output_path / f"{file.stem}.md"
                out.write_text(result.text_content)
                print(f"Converted: {file.name}")
            except Exception as e:
                print(f"Error: {file.name}: {e}")
```

## AI-Ready Corpus Builder
```python
from markitdown import MarkItDown
from pathlib import Path
import json

def create_ai_corpus(doc_folder, output_file):
    md = MarkItDown()
    corpus = []
    for doc in Path(doc_folder).glob('**/*'):
        if doc.suffix in ['.docx', '.pdf', '.pptx', '.xlsx']:
            try:
                result = md.convert(str(doc))
                corpus.append({
                    'source': str(doc),
                    'filename': doc.name,
                    'content': result.text_content,
                    'type': doc.suffix[1:]
                })
            except Exception as e:
                print(f"Skipped {doc.name}: {e}")
    Path(output_file).write_text(json.dumps(corpus, indent=2))
    return corpus
```

## Document Archive with Metadata
```python
def archive_document(doc_path, archive_dir):
    md = MarkItDown()
    result = md.convert(doc_path)
    output = f"""---
source: {os.path.basename(doc_path)}
converted: {datetime.now().strftime('%Y-%m-%d')}
---

{result.text_content}
"""
    out_path = os.path.join(archive_dir, f"{Path(doc_path).stem}.md")
    Path(out_path).write_text(output)
    return out_path
```

## Limitations
- Complex formatting may be simplified
- Images are not embedded (use vision model for descriptions)
- Track changes in Word are not preserved
- Comments may not be extracted
