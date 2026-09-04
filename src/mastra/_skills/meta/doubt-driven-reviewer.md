---
name: doubt-driven-reviewer
description: Fresh-context adversarial review of high-stakes architectural assumptions and design decisions using the CLAIM -> EXTRACT -> DOUBT -> RECONCILE framework.
category: meta
keywords:
  - doubt
  - review
  - architecture
  - adversarial
  - validation
minComplexity: medium
recommendedTier: pro
preferLocal: false
estimatedTokens: 366
outputFormat: markdown
tags:
  - architecture
  - review
  - reasoning-tier
version: 1
---

# Procedure: Doubt-Driven Reviewer

Use this procedure (from Addy Osmani's Doubt-Driven Development) to challenge non-trivial in-flight decisions with a fresh, adversarial perspective before cementing changes into code.

---

## 1. The 4-Step Doubt Framework

1. **CLAIM:** Identify the explicit or implicit assumption being made (e.g., *"We can use an in-memory Map for caching session states"*).
2. **EXTRACT:** Isolate the operating conditions and constraints required for this claim to hold true (e.g., *"Assumes single-instance deployment, zero worker restarts, and <1000 concurrent sessions"*).
3. **DOUBT:** Actively formulate failure modes and break scenarios (e.g., *"What happens during container restart? What happens if horizontal autoscaling adds 3 replicas? What happens when memory spikes?"*).
4. **RECONCILE:** Propose either:
   - **Validation:** Evidence proving why the doubt is non-critical in current scope.
   - **Mitigation:** An architectural safeguard or alternate pattern (e.g., Redis or file-backed storage).

---

## 2. Output Contract

```markdown
### 🛡️ Doubt-Driven Architecture Review

| # | Stated Claim / Assumption | Key Failure Mode (Doubt) | Severity | Reconciled Recommendation |
|---|---|---|---|---|
| 1 | In-memory session cache | Loss of state on restart | High | Use Redis or persistent SQLite slot |

#### Verdict:
- **Status:** [APPROVED | BLOCKED PENDING MITIGATION]
- **Key Action Item:** <Concrete next step>
```
