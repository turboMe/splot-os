---
name: browser-form-filling
category: coding
description: >-
  Browser form filling patterns for Playwright MCP. Covers autofill strategies,
  error recovery, multi-step forms, captcha handling, and dynamic fields.
  Use when agent needs to programmatically fill web forms.
keywords: [browser, form, filling, autofill, captcha, playwright, input, validation]
allowedTools: [shell_execute, fs_read_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 700
outputFormat: text
tags: [browser, forms, automation]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Browser Form Filling

## Trigger
- "Fill out this form"
- "Submit an application on website X"
- "Automate data entry in web form"
- Multi-step registration flows

## Core Workflow

### Step 1: Snapshot the form
```
browser_navigate({ url: 'https://example.com/form' })
browser_snapshot()
```
Review the accessible tree to identify:
- Input fields (text, email, phone, textarea)
- Select/dropdown menus
- Radio buttons and checkboxes
- Submit button
- Hidden fields

### Step 2: Fill fields in order
```
browser_fill({ ref: 'e5', value: 'Jan Kowalski' })  // name
browser_fill({ ref: 'e7', value: 'jan@example.com' }) // email
browser_select({ ref: 'e9', value: 'Poland' })         // dropdown
browser_click({ ref: 'e11' })                           // checkbox
```

### Step 3: Verify before submit
```
browser_snapshot()  // re-snapshot to verify filled values
```

### Step 4: Submit
```
browser_click({ ref: 'e15' })  // submit button
browser_snapshot()              // check for success/error messages
```

## Patterns

### Multi-step / Wizard Forms
```
1. Fill page 1 fields
2. Click "Next"
3. browser_snapshot() — get page 2 refs
4. Fill page 2 fields
5. Click "Next" or "Submit"
```

### Dynamic Fields (show/hide based on selection)
```
1. Select triggering option
2. browser_snapshot() — new fields appear
3. Fill newly visible fields
```

### Date Pickers
- Try `browser_fill` with ISO format first: `2025-01-15`
- If date picker widget: click open → navigate month/year → click day
- Fallback: `browser_evaluate` to set value directly

### File Uploads
```
browser_evaluate({
  expression: 'document.querySelector("input[type=file]").files'
})
```
Note: File upload via MCP may be limited. Use evaluate to set value.

### Captcha Handling
- **reCAPTCHA v2**: Cannot be automated — flag to user
- **reCAPTCHA v3**: Usually invisible, no action needed
- **hCaptcha**: Cannot be automated — flag to user
- **Simple math captcha**: Evaluate and fill answer
- **Best practice**: Use test/staging environments with captcha disabled

## Error Recovery

| Error | Recovery |
|-------|----------|
| "Required field" | Re-snapshot → find empty required field → fill it |
| "Invalid email" | Verify email format → re-fill |
| "Element not found" | Re-snapshot → refs may have changed |
| Form reset after error | Re-fill all fields from scratch |
| Timeout | Re-navigate → re-fill |

## Safety Rules

1. **Never fill real credentials** — use test accounts
2. **Never submit payment forms** with real card data
3. **Check robots.txt** before automating on external sites
4. **Don't submit forms** on production systems without user approval
5. **Log all form submissions** for audit trail

## Success Criteria
- All visible required fields filled
- Form submitted successfully (no validation errors)
- Confirmation page/message verified
- No real sensitive data used in automation
