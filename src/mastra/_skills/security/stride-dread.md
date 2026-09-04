---
name: stride-dread
category: security
description: >-
  STRIDE threat-classification + DREAD risk-prioritization methodology.
  Use it for changes touching auth, cryptography, deserialization,
  permissions, or trust boundaries.
keywords: [security, threat-modeling, stride, dread, risk, auth, attack-surface, trust-boundary]
allowedTools: [fs_read_file, search_content, shell_execute]
minComplexity: complex
recommendedTier: pro
estimatedTokens: 1000
outputFormat: text
tags: [security, threat-modeling, stride, dread]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# STRIDE / DREAD — Threat Modeling

> Inspired by: [Microsoft STRIDE](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats),
> [OWASP Threat Modeling](https://owasp.org/www-community/Threat_Modeling).

## When to run
- Change touches **auth/authz** (login, tokens, sessions, roles).
- Change in **cryptography** (hashing, encryption, signatures, keys).
- **Deserialization** of external data (JSON/YAML/pickle/proto from untrusted source).
- A new **trust boundary** (new endpoint, webhook, 3rd-party API integration).
- Operations on **permissions** or sensitive data (PII, secrets).

For simple changes (single file, no I/O on user data) — **do not use**; the Security checklist in `review.md` is enough.

## Step 1: Identify assets and boundaries
Briefly list:
- **Assets** — what we protect (user data, tokens, keys, state integrity).
- **Actors** — who interacts (user, anon, admin, external system).
- **Trust boundaries** — where data crosses a trust threshold (network → app, app → DB, app → 3rd-party).

## Step 2: STRIDE — threat classification

For each boundary/flow, go through the 6 categories:

| Letter | Threat | Violated property | Control question |
|--------|--------|-------------------|------------------|
| **S** | Spoofing | Authentication | Can someone impersonate another actor? Is identity verified? |
| **T** | Tampering | Integrity | Can data (request, payload, state, file) be modified in transit/at rest? |
| **R** | Repudiation | Non-repudiation | Is the action logged so the actor cannot deny it? |
| **I** | Information Disclosure | Confidentiality | Does sensitive data leak (error message, log, response, timing)? |
| **D** | Denial of Service | Availability | Can unbounded input / an expensive operation exhaust resources? |
| **E** | Elevation of Privilege | Authorization | Can an actor gain privileges they should not have? |

For each threat found, record: `[STRIDE-letter] description → attack vector`.

## Step 3: DREAD — prioritization

Score each threat 1-3 (low/med/high) across 5 dimensions:

| Dimension | Question |
|-----------|----------|
| **D**amage | How much damage on a successful attack? |
| **R**eproducibility | How easily can the attack be repeated? |
| **E**xploitability | How much effort/knowledge does the exploit require? |
| **A**ffected users | How many users are affected? |
| **D**iscoverability | How easy is the vulnerability to find? |

**Risk score = sum (5-15).** Action thresholds:
- **12-15** → 🔴 blocking, fix before merge.
- **8-11** → 🟡 plan a fix, document as known-risk if deferred.
- **5-7** → ⚪ monitor, acceptable.

## Step 4: Mitigations

For each threat ≥8 give a concrete countermeasure:

| STRIDE | Typical mitigations |
|--------|---------------------|
| Spoofing | MFA, strong sessions, webhook signature verification, mutual TLS |
| Tampering | HMAC/signatures, schema validation, integrity checks, query parameterization |
| Repudiation | Audit log with timestamp and actor id, append-only log |
| Info Disclosure | Encryption at-rest/in-transit, log redaction, generic errors, no timing leak |
| DoS | Rate limiting, input size validation, timeouts, pagination, circuit breaker |
| Elevation | Least privilege, authz check on every operation, deny-by-default |

## Output format

```markdown
## Threat Model — [component/change]

### Assets and boundaries
- Assets: ...
- Trust boundaries: ...

### Threats (STRIDE × DREAD)
| ID | STRIDE | Description | Vector | DREAD | Score | Mitigation |
|----|--------|-------------|--------|-------|-------|------------|
| T1 | E | ... | ... | 3/3/2/3/2 | 13 🔴 | ... |

### Verdict
- Blocking (≥12): [list of IDs or "none"]
- To plan (8-11): [...]
- Recommendation: block | needs_changes | approve
```

## Success criteria
- Every trust boundary went through all 6 STRIDE categories.
- Every threat has a DREAD score and an assigned mitigation or a conscious acceptance.
- Verdict consistent with thresholds (≥12 = blocking).
