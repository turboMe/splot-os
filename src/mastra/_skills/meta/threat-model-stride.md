---
name: threat-model-stride
description: Rapid security analysis of data flows and system boundaries using the STRIDE threat modeling framework (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege).
category: meta
keywords:
  - security
  - stride
  - threat-model
  - architecture
  - hardening
minComplexity: complex
recommendedTier: pro
outputFormat: markdown
tags:
  - security
  - stride
  - meta-tier
version: 1
---

# Procedure: STRIDE Threat Modeling & Boundary Review

Use this procedure to audit data flows, API boundaries, and agentic workflows for security vulnerabilities.

---

## 1. The STRIDE Matrix

Evaluate the system component against the 6 threat categories:

1. **S - Spoofing:** Can an attacker impersonate a trusted user, subagent, or internal webhook?
2. **T - Tampering:** Can data in transit or memory state be modified unauthorized?
3. **R - Repudiation:** Can an action be performed without audit logs / trace records?
4. **I - Information Disclosure:** Are credentials (`.env`, API keys, PII) exposed via error traces or prompts?
5. **D - Denial of Service:** Can unthrottled loops or large payloads exhaust worker memory/CPU?
6. **E - Elevation of Privilege:** Can an untrusted worker trigger tools outside its allowed permissions?

---

## 2. Output Contract

```markdown
### 🛡️ STRIDE Threat Model

| Category | Potential Vulnerability | Risk Level | Mitigation Control |
|---|---|---|---|
| Information Disclosure | Stack traces expose DB URL in logs | High | Sanitize error output before return |
| Elevation of Privilege | Subagent inherits terminal access | Critical | Enforce `workspace: undefined` on worker |

#### Actionable Security Remediations:
1. <Priority 1 security hardening step>
```
