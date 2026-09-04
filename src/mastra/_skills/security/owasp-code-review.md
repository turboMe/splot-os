---
name: owasp-code-review
category: security
description: >-
  Code review against the OWASP Top 10 (2021). Maps concrete code patterns
  to vulnerability categories with ready ❌/✅ examples. Use it when reviewing
  changes touching web/API/I/O/user data.
keywords: [security, owasp, code-review, injection, xss, ssrf, access-control, vulnerability]
allowedTools: [fs_read_file, search_content, shell_execute]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 900
outputFormat: text
tags: [security, owasp, code-review]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# OWASP Top 10 — Code Review

> Inspired by: [OWASP Top 10 (2021)](https://owasp.org/Top10/),
> [OWASP Code Review Guide](https://owasp.org/www-project-code-review-guide/).

## Goal
Systematic review of a diff/file against the 10 most common vulnerability classes.
For each category: a control question + a pattern to catch.

## A01: Broken Access Control
- Does every sensitive operation check authz **before** executing?
- Is IDOR possible (accessing another's resource by changing an id in URL/body)?
- Deny-by-default, not allow-by-default.
```ts
// ❌ no owner check
const doc = await db.docs.findOne({ id: req.params.id });
// ✅ enforce owner
const doc = await db.docs.findOne({ id: req.params.id, ownerId: req.user.id });
```

## A02: Cryptographic Failures
- Secrets in code/repo? Weak algorithms (MD5/SHA1 for passwords)? No TLS?
- Passwords hashed with salt (bcrypt/argon2), not plain/encrypt.
```ts
// ❌ const hash = crypto.createHash('md5').update(pw).digest('hex');
// ✅ const hash = await argon2.hash(pw);
```

## A03: Injection (SQL/NoSQL/Command/LDAP)
- String interpolation in a query or shell command?
- Always parameterize; no `eval`/`child_process` on user data without an allowlist.
```ts
// ❌ db.query(`SELECT * FROM u WHERE email='${email}'`)
// ✅ db.query('SELECT * FROM u WHERE email=$1', [email])
```

## A04: Insecure Design
- No rate limiting on login/password-reset endpoints?
- No business validation (e.g. negative amount, negative quantity)?
- Was a threat model considered? (delegate to `stride-dread` when complex).

## A05: Security Misconfiguration
- Debug/verbose errors in production (stack trace in response)?
- Default credentials, open CORS (`*` with credentials), unnecessary headers.
```ts
// ❌ res.status(500).json({ error: err.stack })
// ✅ res.status(500).json({ error: 'Internal error' }); logger.error(err);
```

## A06: Vulnerable and Outdated Components
- New dependencies with known CVEs? (delegate to `dependency-vulnerability-scan`).
- Pinned versions, no `latest` in production.

## A07: Identification and Authentication Failures
- Weak password policy, no lockout, sessions without expiry/rotation?
- Tokens with proper TTL, invalidation on logout/password change.

## A08: Software and Data Integrity Failures
- Deserialization of untrusted data without schema validation?
- No signature verification of updates/webhooks/CI artifacts.
```ts
// ❌ const obj = JSON.parse(body); // then obj used as trusted
// ✅ const obj = schema.parse(JSON.parse(body)); // zod/validation
```

## A09: Security Logging and Monitoring Failures
- Sensitive data (passwords, tokens, PII) in logs?
- No logging of critical events (login, permission change, authz errors)?
```ts
// ❌ logger.info('login', { user, password })
// ✅ logger.info('login', { userId: user.id })
```

## A10: Server-Side Request Forgery (SSRF)
- Fetch/request to a user-supplied URL without an allowlist?
- Host/scheme validation, block internal ranges (169.254.x, 10.x, localhost).
```ts
// ❌ await fetch(req.query.url)
// ✅ if (!ALLOWED_HOSTS.has(new URL(req.query.url).host)) throw new Error('blocked');
```

## Output format

```markdown
## OWASP Code Review — [scope]
| OWASP | Status | File:line | Description | Severity | Fix |
|-------|--------|-----------|-------------|----------|-----|
| A03 | 🔴 | api.ts:42 | interpolation in query | high | parameterize |
| A01 | ✅ | — | authz checked | — | — |

### Verdict
- Critical (🔴): [list or "none"]
- Recommendation: block | needs_changes | approve
```

## Success criteria
- Each of the 10 categories marked ✅ / 🟡 / 🔴 / N/A.
- Every 🔴 has file:line + a concrete fix.
- For complex auth/crypto — delegate to `stride-dread`.
