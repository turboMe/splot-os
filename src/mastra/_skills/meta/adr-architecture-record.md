---
name: adr-architecture-record
description: "Use for standardize and record key architectural decisions using the Architecture Decision Record format (ADR: Context, Decision, Consequences)."
category: meta
keywords:
  - adr
  - architecture
  - decision
  - documentation
  - governance
minComplexity: medium
recommendedTier: pro
outputFormat: markdown
tags:
  - architecture
  - adr
  - meta-tier
version: 1
---

# Procedure: Architecture Decision Record (ADR) Generator

Use this procedure (from Addy Osmani's Documentation and ADRs discipline) to capture critical architectural decisions, framework adoptions, or structural changes.

---

## 1. ADR Template Format

```markdown
# ADR-[NUMBER]: [Concise Title of Decision]

- **Status:** [Proposed | Accepted | Deprecated | Superseded by ADR-XXX]
- **Date:** YYYY-MM-DD
- **Authors:** [Role / Agent]

## 1. Context & Problem Statement
What business or technical problem are we solving? What are the key constraints?

## 2. Options Considered
1. **Option A:** [Pros / Cons / Operational Cost]
2. **Option B:** [Pros / Cons / Operational Cost]

## 3. Decision Outcome
Chosen Option: **Option X**, because [explicit technical justification].

## 4. Consequences
- **Positive:** Benefits gained.
- **Negative / Risks:** Technical debt or trade-offs accepted.
- **Mitigation Strategy:** How risks are monitored and contained.
```
