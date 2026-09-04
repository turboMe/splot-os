---
name: playwright-browser-automation
category: coding
description: >-
  Browser automation via Playwright MCP server. Provides tools for
  navigating web pages, clicking elements, filling forms, taking screenshots,
  and extracting data using accessible tree mode (token-efficient).
  Use for web scraping, UI testing, form automation, and web app debugging.
keywords: [browser, playwright, automation, scraping, testing, screenshot, form, navigation]
allowedTools: [shell_execute, fs_read_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 650
outputFormat: text
tags: [browser, automation, testing, web]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Playwright Browser Automation

> Adapted from [OpenAI Codex Playwright Skill](https://github.com/openai/codex-skills)
> and [@playwright/mcp](https://github.com/microsoft/playwright-mcp).

## MCP Server

Playwright MCP is configured in `mcp.ts`:
```typescript
'playwright': {
  command: 'npx',
  args: ['@playwright/mcp@latest'],
}
```

## Available Tools (via MCP)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL |
| `browser_click` | Click element by ref |
| `browser_fill` | Type text into input |
| `browser_select` | Select dropdown option |
| `browser_screenshot` | Capture page screenshot |
| `browser_snapshot` | Get accessible tree (a11y snapshot) |
| `browser_evaluate` | Run JavaScript in page context |
| `browser_pdf` | Generate PDF of page |
| `browser_close` | Close browser |

## Core Workflow

### 1. Navigate → Snapshot → Interact
```
1. browser_navigate({ url: 'https://example.com' })
2. browser_snapshot()          → get element refs (e1, e2, e3...)
3. browser_click({ ref: 'e5' })  → interact with element
4. browser_snapshot()          → re-snapshot after DOM change
```

### 2. When to re-snapshot
- After clicking links/buttons (DOM changes)
- After form submission
- After any navigation
- When element refs become stale

### 3. Screenshot for visual debugging
```
browser_screenshot({ fullPage: true })
```

## Best Practices

### Performance
- **Use snapshot mode** (accessible tree) instead of screenshots for most tasks
- Snapshot is ~10x more token-efficient than screenshot descriptions
- Only use screenshots when visual verification is needed

### Reliability
- Always re-snapshot after navigation
- Use element refs from the LATEST snapshot only
- Set reasonable timeouts for slow pages
- Handle cookie consent popups before interacting

### Safety
- Never enter real credentials — use test accounts
- Don't scrape sites that prohibit it (check robots.txt)
- Rate-limit requests to avoid being blocked
- Use `browser_close()` when done

## Integration with SubAgent Roles

Playwright tools are available to the **QA SubAgent** for e2e testing.
Add to `subagent-roles.ts` if needed for other roles:
```typescript
'browser_navigate', 'browser_click', 'browser_fill',
'browser_snapshot', 'browser_screenshot'
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Browser not found" | Run `npx playwright install chromium` |
| Stale element refs | Re-snapshot the page |
| Timeout on navigate | Increase timeout or check URL |
| Cookie consent blocks | Snapshot → find consent button → click it first |
