---
name: google-workspace-integration
category: coding
description: >-
  Integration patterns for Google Sheets and Google Slides via SDK tools.
  Covers spreadsheet creation, reading/writing ranges, A1 notation,
  presentation templating with placeholder replacement, and safe write practices.
  Trigger: "create spreadsheet", "google sheets", "export to sheets",
  "create presentation", "google slides", "report deck", "raport google",
  "presentation builder".
keywords: [google sheets, google slides, spreadsheet, presentation, A1 notation, templating, placeholder, report]
allowedTools: [sheets_create_spreadsheet, sheets_read_range, sheets_write_range, sheets_append_rows, sheets_get_metadata, slides_create_presentation, slides_get_metadata, slides_add_slide, slides_replace_text, slides_add_text_box, slides_delete_slide]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 2200
outputFormat: markdown
tags: [coding, google, sheets, slides, integration]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Google Workspace Integration

> SDK-based tools (no separate MCP server). All operations require valid
> `GOOGLE_REFRESH_TOKEN` in env with the right scopes.
> If you get an authorization error, the user must re-run the OAuth flow.

## When to Use This Skill

- "Export the leads to Google Sheets"
- "Create a weekly report spreadsheet"
- "Generate a pitch deck for [company]"
- "Build a presentation from this data"
- Any time the user needs a deliverable they can share, edit, or print

## Sheets vs Slides — Choose Wisely

| Use case | Tool |
|---------|------|
| Tabular data, lists, KPIs | Sheets |
| Pivots, charts, formulas | Sheets |
| Data the user will sort/filter | Sheets |
| Pitch / sales deck | Slides |
| Report with narrative + headlines | Slides |
| Visual storytelling | Slides |
| Quick exports for sharing | Sheets |

---

## Part 1: Google Sheets

### A1 Notation Cheat Sheet

```
A1            → single cell
A1:C5         → range (3 cols × 5 rows)
A:A           → entire column A
1:1           → entire row 1
Sheet2!A1     → cell in another tab
'My Sheet'!A1 → tab name with spaces (use single quotes)
```

### Pattern 1: Create Report Spreadsheet

```
// Step 1: Create with multiple tabs
sheets.create_spreadsheet({
  title: "Weekly Sales Report — Week 19",
  sheetTitles: ["Summary", "Leads", "Activities", "Pipeline"]
})
// → returns spreadsheetId, url, sheets[]

// Step 2: Write headers + data (UI-friendly: USER_ENTERED interprets formulas)
sheets.write_range({
  spreadsheetId: "abc123",
  range: "Summary!A1:D1",
  values: [["Metric", "Week", "Previous", "Δ"]],
  confirm: true
})

// Step 3: Append rows under headers
sheets.append_rows({
  spreadsheetId: "abc123",
  range: "Summary!A1",  // tells API which table to append to
  values: [
    ["Pipeline value", "€45,000", "€38,000", "+18%"],
    ["New leads", 23, 18, "+28%"],
  ]
})

// Step 4: Share URL with user
// "Report ready: https://docs.google.com/spreadsheets/d/abc123/edit"
```

### Pattern 2: Read Existing Data

```
// First check what tabs exist
sheets.get_metadata({ spreadsheetId: "abc123" })
// → { sheets: [{ title: "Sheet1", rowCount: 1000, ... }] }

// Then read
sheets.read_range({
  spreadsheetId: "abc123",
  range: "Sheet1!A1:D100"
})
// → { values: [[...], [...], ...], rowCount: 47 }
```

### Pattern 3: Append vs Overwrite — Critical Distinction

```
// ✅ APPEND — adds new rows at the end. SAFE.
sheets.append_rows({
  spreadsheetId: "abc",
  range: "Leads!A1",  // Sheets finds the last filled row
  values: [["New Lead", "new@email.com"]]
})

// ⚠️ OVERWRITE — replaces existing data. Requires confirm: true.
sheets.write_range({
  spreadsheetId: "abc",
  range: "Leads!A1:B5",  // these 10 cells will be REPLACED
  values: [["Header1", "Header2"], ...],
  confirm: true
})
```

**Rule:** When user asks to "add" / "dodaj" / "dopisz" → use append.
When user asks to "replace" / "nadpisz" / "zmień" → use write_range with confirm.
When in doubt — ask: "Czy chcesz dopisać na końcu czy nadpisać zakres?"

### Pattern 4: Formulas

`valueInputOption: USER_ENTERED` (default in our service) interprets formulas like UI:

```
sheets.write_range({
  spreadsheetId: "abc",
  range: "Summary!E2",
  values: [["=SUM(B2:D2)"]],
  confirm: true
})
```

### Common Sheets Anti-Patterns

❌ Reading 50,000 rows just to find one — use a filtered read with target range
❌ Writing one cell at a time in a loop — batch into single `write_range` with full grid
❌ Storing dates as strings — pass JS-formatted strings; Sheets will parse with USER_ENTERED
❌ Forgetting to share — files created via API are owned by the service account user; share manually if needed

---

## Part 2: Google Slides

### Templating Workflow (Recommended)

The most reliable way to build slides programmatically is **template + replace**:

```
1. Create a template presentation manually in Slides UI
   - Use placeholders like {{COMPANY_NAME}}, {{REVENUE_2024}}, {{KEY_INSIGHT}}
   - Style it nicely once

2. Save the template ID: e.g. "1abc...xyz"

3. Programmatically copy + replace:
   - Copy template (use Drive API or duplicate manually for now)
   - Call slides.replace_text with all placeholders
   - Done — beautifully styled deck with your data
```

### Pattern 1: Create From Scratch

```
// 1. Create empty presentation
slides.create_presentation({ title: "Q2 Pipeline Review" })
// → presentationId: "xyz789", slideIds: ["g1abc..."]

// 2. Get slide ID of the auto-created title slide
slides.get_metadata({ presentationId: "xyz789" })
// → slides: [{ slideId: "g1abc...", index: 0 }]

// 3. Add a title text box on the first slide
slides.add_text_box({
  presentationId: "xyz789",
  slideId: "g1abc...",
  text: "Q2 Pipeline Review",
  fontSize: 36,
  bold: true,
  x: 500000, y: 1000000,    // ~0.5 inch from top-left
  width: 8000000, height: 800000
})

// 4. Add another slide
slides.add_slide({
  presentationId: "xyz789",
  layout: "TITLE_AND_BODY"
})
```

### Pattern 2: Template + Replace (Strongly Preferred)

This is the **best pattern** for repeatable reports.

```
// Assumes template "PITCH_TEMPLATE_ID" was prepared manually with placeholders.
// (For now: have the user duplicate the template; future: add slides.copy tool.)

slides.replace_text({
  presentationId: "PITCH_TEMPLATE_ID_COPY",
  replacements: {
    "{{CLIENT_NAME}}": "Restauracja U Kowalskiego",
    "{{REVENUE_2024}}": "€450,000",
    "{{GROWTH_RATE}}": "+23% YoY",
    "{{KEY_INSIGHT}}": "Mobile orders jumped 67% after the new app",
    "{{DATE}}": "9 May 2026",
  }
})
// → returns replacementsCount: 5
```

**Template design tips:**
- Use UPPERCASE_SNAKE_CASE inside `{{}}` to avoid accidental matches
- Keep placeholder text short (Slides preserves formatting only on first run of text)
- One placeholder per text run if you need different styling per field

### Pattern 3: EMU (Coordinate System)

Slides uses English Metric Units (EMU):
- 1 inch = 914,400 EMU
- 1 cm = 360,000 EMU
- 1 point (font) = 12,700 EMU

Standard US Letter slide: ~9,144,000 × 5,143,500 EMU (10 × 7.5 inches)

```
// 2-inch wide text box, 1 inch from left, 0.5 inch from top
slides.add_text_box({
  ...,
  x: 914400,                 // 1 inch
  y: 457200,                 // 0.5 inch
  width: 1828800,            // 2 inches
  height: 457200
})
```

### Layouts Available

```
TITLE              — single big title (cover slide)
TITLE_AND_BODY     — title + content area (default)
TITLE_AND_TWO_COLUMNS  — title + two-column layout
SECTION_HEADER     — section divider
BLANK              — no placeholders, full canvas
```

### Common Slides Anti-Patterns

❌ Building complex layouts from scratch with add_text_box for every element
   → instead: prepare a template, use replace_text
❌ Trying to insert images via the API without uploading to Drive first
   → image insertion requires Drive upload + URL — out of scope for current tools
❌ Using `replace_text` with an empty replacement value to "delete" text
   → it works, but leaves an empty placeholder — better: edit template
❌ Calling `delete_slide` without `confirm: true` — it's blocked

---

## Part 3: Building Reports — End-to-End

### Example: Weekly Sales Report

```
// 1. Create deck from template (or scratch)
const deck = await slides.create_presentation({ title: "Sales Week 19" })

// 2. Build summary slide content
await slides.add_text_box({
  presentationId: deck.presentationId,
  slideId: deck.slideIds[0],
  text: "Week 19 — €45k Pipeline, +18% WoW",
  fontSize: 32,
  bold: true,
  x: 500000, y: 500000, width: 8000000, height: 800000
})

// 3. Also export raw data to Sheets (for the user to filter)
const sheet = await sheets.create_spreadsheet({
  title: "Sales Week 19 — Raw Data",
  sheetTitles: ["Pipeline", "Activities"]
})

await sheets.write_range({
  spreadsheetId: sheet.spreadsheetId,
  range: "Pipeline!A1:E1",
  values: [["Lead", "Stage", "Value", "Owner", "LastTouch"]],
  confirm: true
})

await sheets.append_rows({
  spreadsheetId: sheet.spreadsheetId,
  range: "Pipeline!A1",
  values: [
    ["Acme", "Negotiation", 12000, "Linus", "2026-05-08"],
    ["Pierogi+", "Discovery", 4500, "Linus", "2026-05-09"],
  ]
})

// 4. Report URLs to user
// "Done! Deck: <slides-url> | Data: <sheets-url>"
```

---

## Authorization Errors — Quick Diagnostic

| Error | Cause | Fix |
|-------|-------|-----|
| `Request had insufficient authentication scopes` | Refresh token doesn't have Sheets/Slides scopes | Re-run OAuth flow with new scopes |
| `Sheets API has not been used in project X` | API not enabled in Google Cloud | Enable Sheets API in console |
| `invalid_grant` | Refresh token revoked or expired | Re-run OAuth flow |
| `404 spreadsheet not found` | Wrong ID or no permission | Check ID; ensure file is accessible by service account user |

If you hit any of these — STOP and tell the user exactly what to fix. Do NOT retry.
