# Web Research & Browser Automation

> **Phase:** F2 (Skills Audit Implementation Plan)  
> **Status:** ✅ Implemented  
> **Date:** 2026-05-09

## Overview

Phase 2 adds autonomous web research and browser automation capabilities to the Mastra agentic environment. Agents can now navigate websites, fill forms, scrape data, and conduct multi-source research autonomously.

## Components

### 1. Playwright MCP Server (`mcp.ts`)

Browser automation via Microsoft's Playwright MCP protocol:
- Accessible tree mode (token-efficient — no screenshots needed for most tasks)
- Full browser control: navigate, click, fill, select, screenshot, evaluate, PDF

```typescript
'playwright': {
  command: 'npx',
  args: ['@playwright/mcp@latest'],
}
```

**Available tools:** `browser_navigate`, `browser_click`, `browser_fill`, `browser_select`, `browser_snapshot`, `browser_screenshot`, `browser_evaluate`, `browser_pdf`, `browser_close`

### 2. Firecrawl MCP Server (`mcp.ts`) — Conditional

Web scraping with LLM-ready markdown output. Only loaded when `FIRECRAWL_API_KEY` is set:
- Single-page scrape → clean markdown
- Multi-page deep crawl
- Semantic search across crawled pages

### 3. Researcher SubAgent Role (`subagent-roles.ts`)

New sub-agent specialization for research tasks:
- **Tools:** `search.web`, `search.find_company_links`, Playwright browser tools
- **Skills:** `web-research-strategy`, `playwright-browser-automation`
- **Model tier:** `cloud-fast` (research needs good reasoning)

**Subtask type mappings:** `research`, `browse`, `scrape`, `search`

### 4. QA SubAgent — Enhanced

QA SubAgent now includes Playwright browser tools for e2e testing:
- `browser_navigate`, `browser_click`, `browser_fill`, `browser_snapshot`, `browser_screenshot`
- New skill: `e2e-testing-playwright`

## Skills Created

| Skill | File | Purpose |
|-------|------|---------|
| `playwright-browser-automation` | `_skills/coding/playwright-browser-automation.md` | Core browser automation patterns |
| `web-research-strategy` | `_skills/meta/web-research-strategy.md` | PSEV loop (Plan-Search-Extract-Verify) |
| `e2e-testing-playwright` | `_skills/coding/e2e-testing-playwright.md` | E2E test writing patterns |
| `browser-form-filling` | `_skills/coding/browser-form-filling.md` | Form automation patterns |
| `browser-login-flow` | `_skills/coding/browser-login-flow.md` | Auth flow automation |

## Architecture

```
MetaAgent / CodingAgent
    │
    ├── research subtask → Researcher SubAgent
    │       │
    │       ├── search.web (Tavily)
    │       ├── browser_* (Playwright MCP)
    │       └── firecrawl.* (Firecrawl MCP, optional)
    │
    └── e2e/verify subtask → QA SubAgent
            │
            ├── coding.run_test (unit/integration)
            └── browser_* (Playwright MCP → e2e tests)
```

## Web Research Strategy — PSEV Loop

```
PLAN → Decompose query into 3-5 sub-questions
  ↓
SEARCH → Run Tavily search per sub-question
  ↓
EXTRACT → Deep-read top results (Firecrawl/Playwright)
  ↓
VERIFY → Cross-reference: 3+ sources = VERIFIED, 1 source = UNVERIFIED
  ↓
STOP or REFINE (max 20 searches)
```

## Files Modified

| File | Change |
|------|--------|
| `mcp.ts` | **MODIFIED** — added Playwright + Firecrawl MCP servers |
| `config/subagent-roles.ts` | **MODIFIED** — QA gets browser tools, new Researcher role |
| `_skills/coding/*.md` | **NEW** — 3 browser/testing skills |
| `_skills/meta/web-research-strategy.md` | **NEW** — research strategy |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `FIRECRAWL_API_KEY` | Optional | Enables Firecrawl MCP for deep web scraping |
| `GOOGLE_MAPS_API_KEY` | Optional | Places API (New) — restaurant reviews tool (chef recon, E1). Separate from Gmail OAuth. |

---

## Update 2026-06-11 — E0 (chef-agent-dev-plan)

Foundational unblock for the chef "Księga Menu" pipeline. See `ideas/chef-agent-dev-plan.md` §9.

### `researcherAgent` is now delegable
Previously the standalone `researcherAgent` (PSEV) was registered in `index.ts` but **missing from `AGENT_IDS` in `delegate-task.ts`** — so no agent could delegate to it (only producer-hunt used it via direct import). Fixed:
- Added `researcherAgent` to `AGENT_IDS`, to the `targetAgent` enum, and to the tool description in `tools/system/delegate-task.ts` (routes through the generic "direct generate" path — no harness).
- Added its row + routing guidance to `prompts/meta/base.md` (researcher = live public web / full-page reads; knowledgeAgent = curated NotebookLM corpus).
- Aligned `prompts/shared/subagent-researcher.md` Allowed Tools to the agent's real toolset (removed nonexistent `workspace_view`/`coding_*`; added `tavily_extract`, `firecrawl_scrape/crawl`, `skill_search/load`).

### Tavily: 3-layer search (snippets → full pages → extract)
`tools/search/tavily.ts` upgraded (decision **D-T1: manual code, not `@mastra/tavily`** — avoids a new dependency / peer-dep risk):
- `search_web` gained `searchDepth ('basic'|'advanced')` and `includeRawContent ('none'|'markdown')` inputs; returns optional `rawContent`.
- **New `tavily_extract` tool** (`/extract`, 1-20 URLs, `extractDepth` default `advanced`) — pulls full markdown (incl. tables, e.g. menus) from URLs you already have. Wired into `researcherAgent` as the preferred deep-read path: `tavily_extract → firecrawl_scrape → Playwright`.

### Deep-read order of preference (researcher)
```
tavily_extract (advanced)  →  firecrawl_scrape (if FIRECRAWL_API_KEY)  →  Playwright browser_navigate+snapshot
```

> **Verification:** code builds green; live e2e passed — `tavily_extract` (advanced) on a real Wrocław menu page returned **13,427 chars** of raw_content (status 200, 0 failures). GoalContract met.
>
> **Providers configured & live-tested (2026-06-11):** Tavily `/search`+`/extract` (200), Firecrawl `/v2/scrape` (200, 13.3k chars markdown — MCP server now mounts via `mcp.ts`, researcher auto-loads `firecrawl_*` tools), Google Places New `places:searchText` (200, after enabling the API in GCP). Full researcher deep-read chain is active: `tavily_extract → firecrawl_scrape → Playwright`.
