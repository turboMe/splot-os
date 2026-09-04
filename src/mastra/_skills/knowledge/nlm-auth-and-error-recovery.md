---
name: nlm-auth-and-error-recovery
category: knowledge
description: NotebookLM authentication, session management, error recovery, and rate limiting. Covers login, token refresh, profile switching, re-auth on failure, retry with backoff, and all known error codes with solutions.
keywords: [notebooklm, auth, authentication, login, session, cookies, error, recovery, rate limit, retry, refresh, profile]
allowedTools: [refresh_auth, save_auth_tokens, server_info]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 800
outputFormat: text
tags: [notebooklm, auth, error-recovery, troubleshooting, knowledge-management]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# NotebookLM — Authentication & Error Recovery

## Trigger
Agent encounters authentication errors, needs to refresh session, or handle operation failures.

## Critical Rules (MUST READ)

1. **Sessions expire in ~20 minutes** — re-authenticate when commands fail with auth errors
2. **`--confirm` / `confirm=True` REQUIRED** for ALL generation and delete operations
3. **ALWAYS ask user before DELETE** — deletions are **irreversible**
4. **DO NOT use `nlm chat start`** — it's an interactive REPL. Use `notebook_query` instead
5. **Capture IDs from output** — create/start commands return IDs needed for next steps
6. **Rate limit awareness** — minimum pauses between operations (see table below)

## MCP Authentication Tools

| Tool | Purpose | When to use |
|------|---------|------------|
| `refresh_auth` | Reload auth tokens from disk | After `nlm login` in terminal, or when session is stale |
| `save_auth_tokens` | Manually save cookies | **FALLBACK** — only if `nlm login` CLI fails |
| `server_info` | Check version + auth status | Verify if auth is configured (local check, not live API call) |

## Authentication Procedure

### When auth error occurs:
1. Try `refresh_auth()` first — reloads tokens from disk
2. If still fails → user needs to run `nlm login` in terminal
3. After user runs `nlm login` → call `refresh_auth()` to pick up new tokens

### Profile switching (multiple Google accounts):
- User runs: `nlm login switch <profile>` in terminal
- MCP server instantly uses the new active profile
- No need to call `refresh_auth` — switch is immediate

## Error Recovery Table

| Error | Cause | Solution |
|-------|-------|----------|
| "Cookies have expired" | Session timeout (~20min) | `refresh_auth()` or user runs `nlm login` |
| "authentication may have expired" | Session timeout | Same as above |
| "Notebook not found" | Invalid/deleted ID | Call `notebook_list()` to get valid IDs |
| "Source not found" | Invalid source ID | Call `source_list_drive(notebook_id)` |
| "Rate limit exceeded" | Too many calls too fast | Wait **30 seconds**, then retry |
| "Research already in progress" | Pending research task | Import existing results first, or use `--force` |
| "Import timed out" | Too many sources to import | Increase `timeout` to 600 |
| "Google API error code 3" | Transient deep research error | Retry in a few minutes, or use `mode=fast` |
| Source add timeout | Slow indexing | Increase `wait_timeout` to 300 |

## Rate Limiting Rules

| Operation Type | Minimum Delay |
|---------------|---------------|
| Source add (`source_add`) | 2 seconds |
| Query operations (`notebook_query`) | 2 seconds |
| Research operations | 2 seconds |
| Content generation (`studio_create`) | 5 seconds |
| Batch operations | 10 seconds |

**Daily limits (free tier):** ~50 queries/operations per day.

## Retry Pattern
For transient failures, use exponential backoff:
1. First retry: wait 5 seconds
2. Second retry: wait 10 seconds
3. Third retry: wait 20 seconds
4. After 3 failures: report error to caller

## Re-auth on Failure Pattern
```
1. Try operation
2. If auth error → refresh_auth()
3. Retry operation
4. If still fails → ask user to run `nlm login`
```
