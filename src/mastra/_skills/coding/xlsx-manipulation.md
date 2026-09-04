---
name: xlsx-manipulation
description: >
  Create, read, and modify Excel (.xlsx) workbooks using openpyxl — without
  Microsoft Excel installed. Covers data I/O, formatting, charts, pivot tables,
  formulas, conditional formatting, and validation.
category: coding
keywords:
  - excel
  - xlsx
  - openpyxl
  - spreadsheet
  - workbook
  - charts
  - pivot-tables
  - formatting
  - data-validation
  - formulas
source: https://github.com/haris-musa/excel-mcp-server
license: MIT
recommendedTier: pro
handoffCapable: true
---

# Excel (.xlsx) Manipulation Skill

Create, read, and modify Excel workbooks programmatically using `openpyxl` (MIT).
No Microsoft Excel installation required.

> **Distilled from**: [excel-mcp-server](https://github.com/haris-musa/excel-mcp-server)
> (3.8k ⭐, MIT). Patterns extracted as standalone skill for autonomous use.

## Installation

```bash
pip install openpyxl
```

## Core Operations

### 1. Workbook & Sheet Management

```python
from openpyxl import Workbook, load_workbook

# Create new workbook
wb = Workbook()
ws = wb.active
ws.title = "Sales Data"
wb.save("report.xlsx")

# Open existing workbook
wb = load_workbook("report.xlsx")

# Create additional sheets
ws2 = wb.create_sheet("Summary")
ws3 = wb.create_sheet("Charts", 0)  # Insert at position 0

# Copy sheet
wb.copy_worksheet(wb["Sales Data"])

# Rename sheet
wb["Sales Data"].title = "Q1 Sales"

# Delete sheet
del wb["Sheet1"]

# List all sheets
print(wb.sheetnames)  # ['Charts', 'Q1 Sales', 'Summary']

wb.save("report.xlsx")
```

### 2. Writing Data

```python
from openpyxl import Workbook

wb = Workbook()
ws = wb.active

# Write individual cells
ws["A1"] = "Product"
ws["B1"] = "Revenue"
ws["C1"] = "Quarter"

# Write from list of dicts (most common pattern)
data = [
    {"Product": "Widget A", "Revenue": 15000, "Quarter": "Q1"},
    {"Product": "Widget B", "Revenue": 23000, "Quarter": "Q1"},
    {"Product": "Widget C", "Revenue": 8500, "Quarter": "Q2"},
]

# Header row
headers = list(data[0].keys())
for col_idx, header in enumerate(headers, 1):
    ws.cell(row=1, column=col_idx, value=header)

# Data rows
for row_idx, record in enumerate(data, 2):
    for col_idx, key in enumerate(headers, 1):
        ws.cell(row=row_idx, column=col_idx, value=record[key])

wb.save("report.xlsx")
```

### 3. Reading Data

```python
from openpyxl import load_workbook

wb = load_workbook("report.xlsx", data_only=True)
ws = wb.active

# Read all data as list of dicts
headers = [cell.value for cell in ws[1]]
data = []
for row in ws.iter_rows(min_row=2, values_only=True):
    record = dict(zip(headers, row))
    data.append(record)

# Read specific range
for row in ws.iter_rows(min_row=1, max_row=5, min_col=1, max_col=3, values_only=True):
    print(row)

# Get sheet metadata
print(f"Dimensions: {ws.dimensions}")
print(f"Max row: {ws.max_row}, Max col: {ws.max_column}")
```

### 4. Formulas

```python
# Apply formulas
ws["D2"] = "=B2*1.1"       # Simple formula
ws["D3"] = "=SUM(B2:B10)"  # Aggregate
ws["D4"] = '=IF(B2>10000,"High","Low")'  # Conditional

# Named ranges for clarity
from openpyxl.workbook.defined_name import DefinedName
ref = "Q1Sales!$B$2:$B$100"
defn = DefinedName("RevenueRange", attr_text=ref)
wb.defined_names.add(defn)
```

## Formatting

### 5. Cell Styling

```python
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, numbers

# Font styling
header_font = Font(name="Calibri", size=12, bold=True, color="FFFFFF")

# Background fill
header_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")

# Alignment
center_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

# Borders
thin_border = Border(
    left=Side(style="thin"),
    right=Side(style="thin"),
    top=Side(style="thin"),
    bottom=Side(style="thin"),
)

# Apply to header row
for cell in ws[1]:
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = center_align
    cell.border = thin_border

# Number formatting
for row in ws.iter_rows(min_row=2, min_col=2, max_col=2):
    for cell in row:
        cell.number_format = '#,##0.00'  # Currency-like
        # Or: cell.number_format = numbers.FORMAT_CURRENCY_USD_SIMPLE
```

### 6. Column Width & Row Height

```python
# Auto-fit approximation
from openpyxl.utils import get_column_letter

for col_idx in range(1, ws.max_column + 1):
    max_length = 0
    column_letter = get_column_letter(col_idx)
    for row in ws.iter_rows(min_col=col_idx, max_col=col_idx, values_only=True):
        for cell_value in row:
            if cell_value:
                max_length = max(max_length, len(str(cell_value)))
    ws.column_dimensions[column_letter].width = max_length + 4

# Fixed row height
ws.row_dimensions[1].height = 30  # Header row
```

### 7. Conditional Formatting

```python
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule
from openpyxl.styles import PatternFill

# Highlight cells > 20000
red_fill = PatternFill(start_color="FF9999", end_color="FF9999", fill_type="solid")
ws.conditional_formatting.add(
    "B2:B100",
    CellIsRule(operator="greaterThan", formula=["20000"], fill=red_fill)
)

# Color scale (green → yellow → red)
ws.conditional_formatting.add(
    "B2:B100",
    ColorScaleRule(
        start_type="min", start_color="63BE7B",
        mid_type="percentile", mid_value=50, mid_color="FFEB84",
        end_type="max", end_color="F8696B",
    )
)

# Data bars
ws.conditional_formatting.add(
    "B2:B100",
    DataBarRule(start_type="min", end_type="max", color="638EC6")
)
```

### 8. Merge Cells

```python
# Merge for title
ws.merge_cells("A1:D1")
ws["A1"] = "Q1 Sales Report"
ws["A1"].alignment = Alignment(horizontal="center")

# Unmerge
ws.unmerge_cells("A1:D1")
```

## Advanced Features

### 9. Charts

```python
from openpyxl.chart import BarChart, LineChart, PieChart, Reference

# Bar chart
chart = BarChart()
chart.type = "col"
chart.title = "Revenue by Product"
chart.x_axis.title = "Product"
chart.y_axis.title = "Revenue ($)"

data = Reference(ws, min_col=2, min_row=1, max_row=ws.max_row)
cats = Reference(ws, min_col=1, min_row=2, max_row=ws.max_row)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.shape = 4  # Rounded corners

ws.add_chart(chart, "E2")

# Pie chart
pie = PieChart()
pie.title = "Revenue Distribution"
pie.add_data(data, titles_from_data=True)
pie.set_categories(cats)
ws.add_chart(pie, "E18")

# Line chart
line = LineChart()
line.title = "Trend"
line.add_data(data, titles_from_data=True)
line.set_categories(cats)
ws.add_chart(line, "E34")

wb.save("report.xlsx")
```

### 10. Pivot Table (Manual Construction)

openpyxl doesn't have native pivot tables, but you can build them programmatically:

```python
from collections import defaultdict

# Source data (list of dicts)
records = [
    {"Region": "North", "Product": "A", "Sales": 100},
    {"Region": "North", "Product": "B", "Sales": 200},
    {"Region": "South", "Product": "A", "Sales": 150},
    {"Region": "South", "Product": "B", "Sales": 300},
]

# Aggregate
pivot = defaultdict(lambda: defaultdict(float))
for r in records:
    pivot[r["Region"]][r["Product"]] += r["Sales"]

# Write pivot to new sheet
ws_pivot = wb.create_sheet("Pivot")
products = sorted({r["Product"] for r in records})

# Headers
ws_pivot.cell(row=1, column=1, value="Region")
for i, prod in enumerate(products, 2):
    ws_pivot.cell(row=1, column=i, value=prod)

# Data
for row_idx, (region, sales) in enumerate(sorted(pivot.items()), 2):
    ws_pivot.cell(row=row_idx, column=1, value=region)
    for col_idx, prod in enumerate(products, 2):
        ws_pivot.cell(row=row_idx, column=col_idx, value=sales.get(prod, 0))

wb.save("report.xlsx")
```

### 11. Data Validation

```python
from openpyxl.worksheet.datavalidation import DataValidation

# Dropdown list
dv_list = DataValidation(
    type="list",
    formula1='"Q1,Q2,Q3,Q4"',
    allow_blank=True,
)
dv_list.error = "Please select a valid quarter"
dv_list.errorTitle = "Invalid Quarter"
ws.add_data_validation(dv_list)
dv_list.add("C2:C100")

# Number range validation
dv_range = DataValidation(
    type="whole",
    operator="between",
    formula1=0,
    formula2=1000000,
)
dv_range.error = "Value must be between 0 and 1,000,000"
ws.add_data_validation(dv_range)
dv_range.add("B2:B100")
```

### 12. Row/Column Operations

```python
# Insert rows
ws.insert_rows(3, amount=2)   # Insert 2 rows at position 3

# Delete rows
ws.delete_rows(5, amount=1)   # Delete 1 row at position 5

# Insert columns
ws.insert_cols(2, amount=1)   # Insert 1 column at position 2

# Delete columns
ws.delete_cols(4, amount=2)   # Delete 2 columns starting at position 4
```

### 13. Copy Ranges

```python
from copy import copy

# Copy range A1:C5 to E1:G5
for row in ws.iter_rows(min_row=1, max_row=5, min_col=1, max_col=3):
    for cell in row:
        target = ws.cell(
            row=cell.row,
            column=cell.column + 4,
            value=cell.value
        )
        if cell.has_style:
            target.font = copy(cell.font)
            target.fill = copy(cell.fill)
            target.border = copy(cell.border)
            target.alignment = copy(cell.alignment)
            target.number_format = cell.number_format
```

## Complete Report Template

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.chart import BarChart, Reference
from openpyxl.utils import get_column_letter

def create_sales_report(data: list[dict], output_path: str):
    """Create a professionally formatted sales report."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Sales Report"

    # === Title ===
    ws.merge_cells("A1:D1")
    ws["A1"] = "Quarterly Sales Report"
    ws["A1"].font = Font(size=16, bold=True, color="2F5496")
    ws["A1"].alignment = Alignment(horizontal="center")
    ws.row_dimensions[1].height = 40

    # === Headers ===
    headers = list(data[0].keys())
    header_font = Font(bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")

    for col_idx, header in enumerate(headers, 1):
        cell = ws.cell(row=3, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")

    # === Data ===
    for row_idx, record in enumerate(data, 4):
        for col_idx, key in enumerate(headers, 1):
            ws.cell(row=row_idx, column=col_idx, value=record[key])

    # === Auto-width ===
    for col_idx in range(1, len(headers) + 1):
        col_letter = get_column_letter(col_idx)
        ws.column_dimensions[col_letter].width = 18

    # === Chart ===
    chart = BarChart()
    chart.title = "Revenue by Product"
    chart.type = "col"
    data_ref = Reference(ws, min_col=2, min_row=3, max_row=3 + len(data))
    cats_ref = Reference(ws, min_col=1, min_row=4, max_row=3 + len(data))
    chart.add_data(data_ref, titles_from_data=True)
    chart.set_categories(cats_ref)
    ws.add_chart(chart, f"A{4 + len(data) + 2}")

    wb.save(output_path)
    return output_path
```

## Key Differences from excel-mcp-server

| Feature | excel-mcp-server | This Skill |
|---------|:---:|:---:|
| Runtime | MCP server process | Standalone Python |
| Dependencies | openpyxl + fastmcp | openpyxl only |
| Invocation | Tool calls via MCP | Direct Python code |
| Use case | AI agent tool calling | Script-based automation |

This skill extracts the **openpyxl patterns** for direct use without requiring
a running MCP server — ideal for autonomous coding agents that can write
and execute Python scripts directly.
