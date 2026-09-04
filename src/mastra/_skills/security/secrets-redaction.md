---
name: secrets-redaction
category: security
description: >-
  Secrets Redactor — automatic redaction of API keys, tokens, passwords
  and other sensitive data from agent logs, prompts and outputs.
  Detects 20+ secret types (OpenAI, Anthropic, Google, AWS, Stripe,
  GitHub, Slack, Telegram, JWT, private keys) and replaces them with
  [REDACTED:secret-type].
keywords: [security, secrets, redaction, api-key, token, password, sanitization, leak-prevention]
allowedTools: [fs_read_file]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 650
outputFormat: text
tags: [security, secrets, data-protection, critical]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Secrets Redaction

> Detection patterns based on [gitleaks](https://github.com/gitleaks/gitleaks)
> and [detect-secrets](https://github.com/Yelp/detect-secrets).

## Trigger
**AUTOMATIC** — integrated with `agent-event-log.ts`.
Every event logged to MongoDB passes through redaction.

## What gets redacted

| Provider | Pattern | Example |
|----------|------|---------|
| OpenAI | `sk-proj-*`, `sk-*T3BlbkFJ*` | `sk-proj-abc...xyz` → `[REDACTED:openai-api-key]` |
| Anthropic | `sk-ant-api03-*` | → `[REDACTED:anthropic-api-key]` |
| Google | `AIza*` | → `[REDACTED:google-api-key]` |
| AWS | `AKIA*`, `ASIA*` | → `[REDACTED:aws-access-key]` |
| Stripe | `sk_live_*`, `sk_test_*` | → `[REDACTED:stripe-api-key]` |
| GitHub | `ghp_*`, `gho_*` | → `[REDACTED:github-token]` |
| Slack | `xoxb-*`, `xoxp-*` | → `[REDACTED:slack-token]` |
| Telegram | `123456789:ABC...` | → `[REDACTED:telegram-bot-token]` |
| SendGrid | `SG.*.*` | → `[REDACTED:sendgrid-api-key]` |
| OpenRouter | `sk-or-v1-*` | → `[REDACTED:openrouter-key]` |
| JWT | `eyJ*.eyJ*.*` | → `[REDACTED:jwt-token]` |
| Private Keys | `-----BEGIN * PRIVATE KEY-----` | → `[REDACTED:private-key-block]` |
| Bearer Auth | `Bearer <token>` | → `Bearer [REDACTED:bearer-token]` |
| Basic Auth | `Basic <base64>` | → `Basic [REDACTED:basic-auth]` |
| Env Variables | `API_KEY=<value>` | → `API_KEY=[REDACTED:env-value]` |
| Connection Strings | `://user:pass@host` | → `://user:[REDACTED:password]@host` |

## Integration

### Automatic (already active)
```typescript
// agent-event-log.ts — input/output/errorMessage are sanitized
await logAgentEvent({
  input: 'My key is sk-proj-abc123...',  // → 'My key is [REDACTED:openai-api-key]'
  output: 'Connection: mongodb://user:secret@host',  // → password redacted
});
```

### Manual
```typescript
import { redactSecrets, containsSecrets, getSafeEnvSnapshot } from './secrets-redactor.js';

// Full redaction
const result = redactSecrets(someText);
console.log(result.text);           // Sanitized text
console.log(result.redactedCount);  // Number of secrets found
console.log(result.redactedTypes);  // ['openai-api-key', 'jwt-token']

// Quick check (boolean)
if (containsSecrets(userInput)) {
  console.warn('Input contains secrets!');
}

// Safe snapshot of env vars
const safeEnv = getSafeEnvSnapshot();
// Only NODE_ENV, PORT, HOST, TZ etc. — no API keys
```

## Files
- `lib/secrets-redactor.ts` — main logic
- `lib/agent-event-log.ts` — automatic integration

## Success Criteria
- 20+ secret types detected
- Agent event log contains no raw secrets
- Zero false positives on normal code
- < 1ms overhead per redaction call
