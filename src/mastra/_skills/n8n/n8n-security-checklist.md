---
name: n8n-security-checklist
category: n8n
description: Security review checklist for n8n workflows - input validation, credentials, data exposure
keywords: [n8n, security, checklist, review, audit, risk, credentials, validation]
recommendedTier: private
handoffCapable: true
---
# n8n Security Review Checklist

Use this checklist when reviewing a workflow for security issues. Check each item and report findings.

## 1. Input Validation

- [ ] Public webhooks validate incoming payload structure
- [ ] User-controlled strings are NOT passed directly to shell commands
- [ ] URL inputs are validated before HTTP requests (no SSRF)
- [ ] JSON inputs are parsed with error handling
- [ ] File paths are sanitized (no directory traversal)

## 2. Credential Safety

- [ ] No hardcoded API keys, tokens, or passwords in node parameters
- [ ] Credentials use n8n's credential store, not plain text
- [ ] No secrets passed in webhook URLs or query parameters
- [ ] No secrets included in Telegram messages or external notifications

## 3. Data Exposure

- [ ] Sensitive data (PII, financial) is not sent to external services unnecessarily
- [ ] Telegram messages do not contain raw customer data
- [ ] LLM prompts do not include secrets or full database dumps
- [ ] Error messages do not leak internal system details

## 4. Execution Safety

- [ ] Code nodes do not use `eval()` or `Function()` on user input
- [ ] Shell commands (if any) use allowlisted commands only
- [ ] HTTP requests go to known, trusted endpoints
- [ ] No recursive workflow triggers (prevents infinite loops)
- [ ] Batch operations have size limits

## 5. Authentication & Authorization

- [ ] Public webhooks have authentication (header check, secret path, or IP allowlist)
- [ ] Admin-level operations require explicit approval
- [ ] Webhook paths are not guessable (use UUIDs or secrets)

## 6. Rate Limiting & Resource Protection

- [ ] Schedule triggers have reasonable intervals (not every second)
- [ ] HTTP requests have timeouts configured
- [ ] LLM calls have input truncation (max 5000 chars typical)
- [ ] Batch operations have concurrency limits

## 7. Data Persistence

- [ ] Sensitive data is not stored in workflow static data
- [ ] MongoDB writes use proper collection names (not overwriting system collections)
- [ ] Deduplication state does not grow unbounded
- [ ] Logs do not contain full request/response bodies with sensitive data

## 8. AgentForge-Specific Rules

- [ ] Prefer AgentForge API over direct MongoDB access
- [ ] All generated workflows are created as INACTIVE
- [ ] No workflow can auto-activate itself
- [ ] Critical actions (delete, send to customer) are blocked by default
- [ ] Ollama is used for private tasks, Gemini only when high precision needed

## Risk Scoring Guide

| Finding | Score Impact |
|---------|-------------|
| Hardcoded credentials | +50 (critical) |
| Shell command injection possible | +80 (critical) |
| No input validation on public webhook | +30 (high) |
| Sensitive data in notifications | +20 (medium) |
| Missing error handling | +10 (low) |
| Missing rate limiting | +10 (low) |
