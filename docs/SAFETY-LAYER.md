# Safety Layer — Terminal Guard & Secrets Redaction

> **Phase:** F1 (Skills Audit Implementation Plan)  
> **Status:** ✅ Implemented  
> **Date:** 2026-05-09

## Overview

The Safety Layer is the foundational security infrastructure for the Mastra agentic environment. It prevents agents from executing dangerous commands and leaking secrets through logs or prompts.

## Components

### 1. Terminal Safety Guard (`lib/terminal-safety-guard.ts`)

Three-tier command classification system that intercepts all `shell.execute` calls:

| Action | Rules | Behavior |
|--------|-------|----------|
| **BLOCK** | 22 | Immediate rejection — command never executes |
| **CONFIRM** | 12 | Warning logged — executes with safety note |
| **ALLOW** | default | Normal execution |

**Categories covered:**
- **Filesystem** — `rm -rf /`, `dd`, `mkfs`, `shred`, `chmod 777`
- **System** — fork bombs, `shutdown`, `kill PID 1`, `killall -9`
- **Database** — `DROP DATABASE`, `TRUNCATE TABLE`, `db.dropDatabase()`
- **Network** — `curl | bash`, `wget | sh`, env exfiltration
- **Crypto** — SSH private key access, `.env` file reading

**Workspace-safe paths:** Operations within `/projekty/`, `/tmp/sandbox`, `node_modules/`, `dist/`, `build/` have relaxed rules (e.g., `rm -rf node_modules/` is allowed).

### 2. Secrets Redactor (`lib/secrets-redactor.ts`)

Automatic detection and redaction of 20+ types of secrets:

- **Provider keys:** OpenAI, Anthropic, Google, AWS, Stripe, GitHub, Slack, Telegram, SendGrid, OpenRouter
- **Generic patterns:** Bearer tokens, Basic auth, JWT tokens, private key blocks
- **Environment variables:** `API_KEY=`, `PASSWORD=`, `TOKEN=` assignments
- **Connection strings:** Password portion in `://user:pass@host` URIs

**Integration:** Automatically applied to all `agent_events` MongoDB writes (input, output, errorMessage fields).

### 3. Skills Created

| Skill | File | Purpose |
|-------|------|---------|
| `terminal-safety-guard` | `_skills/security/terminal-safety-guard.md` | Guard documentation & rules |
| `secrets-redaction` | `_skills/security/secrets-redaction.md` | Redactor patterns & usage |
| `mcp-server-risk-auditor` | `_skills/security/mcp-server-risk-auditor.md` | MCP server audit checklist |
| `dependency-vulnerability-scan` | `_skills/security/dependency-vulnerability-scan.md` | npm audit procedures |
| `license-compliance` | `_skills/security/license-compliance.md` | License allow/blocklist |
| `prompt-injection-defense` | `_skills/security/prompt-injection-defense.md` | Injection attack defense |

## Architecture

```
Agent request
    │
    ▼
shell.execute(cmd)
    │
    ▼
checkCommand(cmd)  ─── terminal-safety-guard.ts
    │
    ├── BLOCK  → reject + logSafetyEvent()
    ├── CONFIRM → warn + logSafetyEvent() + execute
    └── ALLOW  → execute
                    │
                    ▼
              logAgentEvent()
                    │
                    ▼
              sanitize(text) ─── secrets-redactor.ts
                    │
                    ▼
              MongoDB (clean data)
```

## Files Modified

| File | Change |
|------|--------|
| `lib/terminal-safety-guard.ts` | **NEW** — 34 safety rules |
| `lib/secrets-redactor.ts` | **NEW** — 20+ redaction patterns |
| `lib/agent-event-log.ts` | **MODIFIED** — integrated secrets redaction |
| `tools/terminal/terminal-tools.ts` | **MODIFIED** — integrated safety guard |
| `_skills/security/*.md` | **NEW** — 6 security skills |
