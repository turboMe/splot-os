---
name: doc-parser
category: coding
description: "Parse complex documents (PDF, DOCX, PPTX, images) using IBM's docling library with AI-powered layout analysis, OCR, multi-column handling, and structured export. Use when dealing with academic papers, financial reports, contracts, or any document requiring intelligent structure extraction beyond simple text."
keywords: [docling, parser, pdf, ocr, layout, table-extraction, figure-extraction, multi-column, ibm]
source: claude-office-skills
recommendedTier: pro
handoffCapable: true
---

# Document Parser (IBM Docling)

## Overview
Advanced document parsing using **docling** — IBM's state-of-the-art document understanding library. Handles complex PDFs, Word docs, and images while preserving structure, extracting tables, figures, and multi-column layouts.

## Dependencies
```bash
pip install docling
pip install docling[all]   # full functionality
pip install docling[ocr]   # OCR support
```

## Supported Formats
| Format | Extension | Notes |
|--------|-----------|-------|
| PDF | .pdf | Native and scanned (OCR) |
| Word | .docx | Full structure preserved |
| PowerPoint | .pptx | Slides as sections |
| Images | .png, .jpg | OCR + layout analysis |
| HTML | .html | Structure preserved |

## Basic Usage
```python
from docling.document_converter import DocumentConverter

converter = DocumentConverter()
result = converter.convert("document.pdf")
doc = result.document

# Export options
markdown = doc.export_to_markdown()
text = doc.export_to_text()
json_doc = doc.export_to_dict()
```

## Advanced Configuration
```python
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions

pipeline_options = PdfPipelineOptions()
pipeline_options.do_ocr = True
pipeline_options.do_table_structure = True
pipeline_options.table_structure_options.do_cell_matching = True

converter = DocumentConverter(
    allowed_formats=[InputFormat.PDF, InputFormat.DOCX],
    pdf_backend_options=pipeline_options
)
```

## Document Iteration
```python
for element in doc.iterate_items():
    print(f"Type: {element.type}")   # heading, paragraph, table, picture, code
    print(f"Text: {element.text}")
    if element.type == "table":
        df = element.export_to_dataframe()
```

## Table Extraction
```python
import pandas as pd

def extract_tables(doc_path):
    converter = DocumentConverter()
    result = converter.convert(doc_path)
    tables = []
    for element in result.document.iterate_items():
        if element.type == "table":
            tables.append({
                'page': element.prov[0].page_no if element.prov else None,
                'dataframe': element.export_to_dataframe()
            })
    return tables
```

## Figure Extraction
```python
def extract_figures(doc_path, output_dir):
    import os
    converter = DocumentConverter()
    result = converter.convert(doc_path)
    figures = []
    os.makedirs(output_dir, exist_ok=True)
    for element in result.document.iterate_items():
        if element.type == "picture":
            info = {
                'caption': getattr(element, 'caption', None),
                'page': element.prov[0].page_no if element.prov else None,
            }
            if hasattr(element, 'image'):
                path = os.path.join(output_dir, f"figure_{len(figures)+1}.png")
                element.image.save(path)
                info['path'] = path
            figures.append(info)
    return figures
```

## Academic Paper Parser
```python
def parse_academic_paper(pdf_path):
    converter = DocumentConverter()
    doc = converter.convert(pdf_path).document
    paper = {'title': None, 'abstract': None, 'sections': [], 'tables': [], 'figures': []}
    current_section = None
    for element in doc.iterate_items():
        text = getattr(element, 'text', '')
        if element.type == 'title':
            paper['title'] = text
        elif element.type == 'heading':
            if 'abstract' in text.lower():
                current_section = 'abstract'
            elif 'reference' in text.lower():
                current_section = 'references'
            else:
                paper['sections'].append({'title': text, 'content': ''})
                current_section = 'section'
        elif element.type == 'paragraph':
            if current_section == 'abstract':
                paper['abstract'] = text
            elif current_section == 'section' and paper['sections']:
                paper['sections'][-1]['content'] += text + '\n'
        elif element.type == 'table':
            paper['tables'].append({
                'caption': getattr(element, 'caption', None),
                'data': element.export_to_dataframe() if hasattr(element, 'export_to_dataframe') else None
            })
    return paper
```

## Batch Processing
```python
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

def batch_parse(input_dir, output_dir, max_workers=4):
    converter = DocumentConverter()
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    def process(doc_path):
        try:
            md = converter.convert(str(doc_path)).document.export_to_markdown()
            (output_path / f"{doc_path.stem}.md").write_text(md)
            return {'file': str(doc_path), 'status': 'success'}
        except Exception as e:
            return {'file': str(doc_path), 'status': 'error', 'error': str(e)}

    docs = list(input_path.glob('*.pdf')) + list(input_path.glob('*.docx'))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        return list(executor.map(process, docs))
```

## Best Practices
1. **Use Appropriate Pipeline**: Configure OCR/table options for your doc type
2. **Handle Large Documents**: Process in chunks if needed
3. **Verify Table Extraction**: Complex tables may need review
4. **GPU Recommended**: For best OCR/layout performance
5. **Cache Results**: Store parsed documents for reuse

## Limitations
- Very large documents may require chunking
- Handwritten content needs OCR preprocessing
- Complex nested tables may need manual review
- Some encrypted PDFs not supported
- GPU recommended for best performance
