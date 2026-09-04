---
name: pdf-extraction
category: coding
description: "Extract text, tables, and metadata from PDFs using pdfplumber with character-level positioning, accurate table detection, and visual debugging. Use for data mining from financial reports, invoices, multi-column documents, and structured PDF content."
keywords: [pdf, extract, table, pdfplumber, text, invoice, data-mining, parse]
source: claude-office-skills
recommendedTier: pro
handoffCapable: true
---

# PDF Data Extraction

## Overview
Precise extraction of text, tables, and metadata from PDFs using **pdfplumber** — character-level positioning, accurate table detection, visual debugging.

## Dependencies
```bash
pip install pdfplumber
pip install Pillow  # for image debugging (optional)
```

## Basic Usage
```python
import pdfplumber

with pdfplumber.open('document.pdf') as pdf:
    first_page = pdf.pages[0]
    print(pdf.metadata)        # title, author, date
    print(len(pdf.pages))      # page count
    text = first_page.extract_text()
```

## Text Extraction

### With Layout Preservation
```python
text = page.extract_text(
    x_tolerance=3,
    y_tolerance=3,
    layout=True,
    x_density=7.25,
    y_density=13
)
```

### Character-Level Access
```python
for char in page.chars:
    print(f"'{char['text']}' at ({char['x0']}, {char['top']})")
    print(f"  Font: {char['fontname']}, Size: {char['size']}")
```

### Extract by Font (e.g., bold text only)
```python
def extract_by_font(page, font_name):
    chars = [c for c in page.chars if font_name in c['fontname']]
    return ''.join(c['text'] for c in chars)

bold_text = extract_by_font(page, 'Bold')
```

## Table Extraction

### Basic
```python
tables = page.extract_tables()
for table in tables:
    for row in table:
        print(row)
```

### Advanced Settings
```python
table_settings = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "edge_min_length": 3,
    "min_words_vertical": 3,
    "min_words_horizontal": 1,
}
tables = page.extract_tables(table_settings)
```

### Tables to DataFrames
```python
import pandas as pd

def pdf_tables_to_dataframes(pdf_path):
    dfs = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            for j, table in enumerate(page.extract_tables()):
                if table and len(table) > 1:
                    df = pd.DataFrame(table[1:], columns=table[0])
                    df['_page'] = i + 1
                    dfs.append(df)
    return dfs
```

## Visual Debugging
```python
im = page.to_image(resolution=150)
im.draw_rects(page.chars)
im.draw_lines(page.lines)
im.debug_tablefinder()
im.save('debug.png')
```

## Cropping & Region Extraction
```python
bbox = (0, 0, 300, 200)  # (x0, top, x1, bottom)
cropped = page.crop(bbox)
text = cropped.extract_text()
tables = cropped.extract_tables()
```

## Multi-Column Layout
```python
def extract_columns(page, num_columns=2):
    width = page.width
    col_width = width / num_columns
    columns = []
    for i in range(num_columns):
        cropped = page.crop((i * col_width, 0, (i+1) * col_width, page.height))
        columns.append(cropped.extract_text())
    return columns
```

## Invoice Data Extraction
```python
import re

def extract_invoice_data(pdf_path):
    data = {'invoice_number': None, 'date': None, 'total': None, 'line_items': []}
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        text = page.extract_text()
        inv = re.search(r'Invoice\s*#?\s*:?\s*(\w+)', text, re.IGNORECASE)
        if inv: data['invoice_number'] = inv.group(1)
        total = re.search(r'Total\s*:?\s*\$?([\d,]+\.?\d*)', text, re.IGNORECASE)
        if total: data['total'] = float(total.group(1).replace(',', ''))
        for table in page.extract_tables():
            if table and any('description' in str(row).lower() for row in table[:2]):
                for row in table[1:]:
                    if row and len(row) >= 3:
                        data['line_items'].append({
                            'description': row[0], 'quantity': row[1], 'amount': row[-1]
                        })
    return data
```

## Best Practices
1. **Debug Visually**: Use `to_image()` to understand PDF structure
2. **Tune Table Settings**: Adjust tolerances for your specific PDF
3. **Handle Scanned PDFs**: Use OCR first (pdfplumber is for native text)
4. **Process Page by Page**: For large PDFs, avoid loading all at once

## Limitations
- Cannot extract from scanned/image PDFs (use OCR first)
- Complex layouts may need manual tuning
- Some PDF encryption types not supported
