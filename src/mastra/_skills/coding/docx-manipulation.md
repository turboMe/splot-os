---
name: docx-manipulation
category: coding
description: "Create, edit, and manipulate Word documents (.docx) programmatically using python-docx. Use when tasks involve generating reports, contracts, letters, or editing existing Word files with proper formatting, styles, tables, and images."
keywords: [docx, word, document, python-docx, report, contract, template, table, formatting]
source: claude-office-skills
recommendedTier: pro
handoffCapable: true
---

# DOCX Manipulation

## Overview
Programmatic creation, editing, and manipulation of Microsoft Word (.docx) documents using **python-docx**.

## Dependencies
```bash
pip install python-docx
```

## python-docx Fundamentals
```python
from docx import Document
from docx.shared import Inches, Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.style import WD_STYLE_TYPE

# Create new document
doc = Document()

# Or open existing
doc = Document('existing.docx')
```

## Document Structure
```
Document
├── sections (margins, orientation, size)
├── paragraphs (text with formatting)
├── tables (rows, cells, merged cells)
├── pictures (inline images)
└── styles (predefined formatting)
```

## Adding Content

### Paragraphs & Headings
```python
doc.add_heading('Main Title', level=0)
doc.add_heading('Section Title', level=1)
para = doc.add_paragraph('Normal text here')
doc.add_paragraph('Note: Important!', style='Intense Quote')

# Inline formatting
para = doc.add_paragraph()
para.add_run('Bold text').bold = True
para.add_run(' and ')
para.add_run('italic text').italic = True
```

### Tables
```python
table = doc.add_table(rows=3, cols=3)
table.style = 'Table Grid'
table.cell(0, 0).text = 'Header 1'

# Add row dynamically
row = table.add_row()
row.cells[0].text = 'New data'

# Merge cells
a = table.cell(0, 0)
b = table.cell(0, 2)
a.merge(b)
```

### Images
```python
doc.add_picture('image.png', width=Inches(4))
```

## Formatting

### Paragraph Formatting
```python
para = doc.add_paragraph('Formatted text')
para.alignment = WD_ALIGN_PARAGRAPH.CENTER
para.paragraph_format.line_spacing = 1.5
para.paragraph_format.space_after = Pt(12)
para.paragraph_format.first_line_indent = Inches(0.5)
```

### Character Formatting
```python
from docx.shared import RGBColor
run = para.add_run('Styled text')
run.bold = True
run.font.name = 'Arial'
run.font.size = Pt(14)
run.font.color.rgb = RGBColor(0x00, 0x00, 0xFF)
```

### Page Setup
```python
from docx.enum.section import WD_ORIENT
section = doc.sections[0]
section.page_width = Inches(11)
section.page_height = Inches(8.5)
section.orientation = WD_ORIENT.LANDSCAPE
section.left_margin = Inches(1)
```

## Common Patterns

### Report Template
```python
def create_report(title, sections):
    doc = Document()
    doc.add_heading(title, 0)
    doc.add_paragraph(f'Generated: {datetime.now()}')
    for section_title, content in sections.items():
        doc.add_heading(section_title, 1)
        doc.add_paragraph(content)
    return doc
```

### Table from Data
```python
def add_data_table(doc, headers, rows):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = 'Table Grid'
    for i, header in enumerate(headers):
        table.rows[0].cells[i].text = header
        table.rows[0].cells[i].paragraphs[0].runs[0].bold = True
    for row_data in rows:
        row = table.add_row()
        for i, value in enumerate(row_data):
            row.cells[i].text = str(value)
    return table
```

### Mail Merge / Template Fill
```python
def fill_template(template_path, replacements):
    doc = Document(template_path)
    for para in doc.paragraphs:
        for key, value in replacements.items():
            if f'{{{key}}}' in para.text:
                para.text = para.text.replace(f'{{{key}}}', value)
    return doc
```

## Built-in Styles
`'Normal'`, `'Heading 1-9'`, `'Title'`, `'Subtitle'`, `'Quote'`, `'Intense Quote'`, `'List Bullet'`, `'List Number'`, `'Table Grid'`, `'Light Shading'`, `'Medium Grid 1'`

## Best Practices
1. **Structure First**: Plan document hierarchy before coding
2. **Use Styles**: Consistent formatting via styles, not manual formatting
3. **Save Often**: Call `doc.save()` periodically for large documents
4. **Handle Errors**: Check file existence before opening
5. **Clean Up**: Remove template placeholders after filling

## Limitations
- Cannot execute macros or VBA code
- Complex templates may lose some formatting
- Limited support for SmartArt, Charts
- No direct PDF conversion (use separate tool)
