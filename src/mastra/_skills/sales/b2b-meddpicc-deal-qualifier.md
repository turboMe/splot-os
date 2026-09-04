---
name: b2b-meddpicc-deal-qualifier
description: Rigorous qualification of sales opportunities and call transcripts using the MEDDPICC framework (Metrics, Economic Buyer, Decision Criteria, Decision Process, Paper Process, Implicated Pain, Champion, Competition).
category: sales
keywords:
  - sales
  - meddpicc
  - qualification
  - discovery
  - deal
  - crm
minComplexity: medium
recommendedTier: pro
preferLocal: false
estimatedTokens: 481
outputFormat: markdown
tags:
  - sales
  - qualification
  - reasoning-tier
version: 1
---

# Procedure: B2B MEDDPICC Deal Qualification & Pipeline Triage

Use this procedure to analyze discovery call transcripts, sales notes, or meeting summaries to evaluate deal health and calculate closing probability.

---

## 1. MEDDPICC Audit Dimensions

Score each dimension from 0 to 10 (0 = Unknown/Missing, 10 = Verified & Documented):

1. **M - Metrics:** What quantifiable ROI or financial metric does the customer expect?
2. **E - Economic Buyer:** Has the person with ultimate budget authority been identified and engaged?
3. **D - Decision Criteria:** What technical and commercial criteria will decide the vendor?
4. **D - Decision Process:** What exact approval milestones must happen before contract sign-off?
5. **P - Paper Process:** What are the legal, procurement, and security review steps and timelines?
6. **I - Implicated Pain:** What is the cost of doing nothing (business pain if unaddressed)?
7. **C - Champion:** Who is our internal advocate with influence and personal interest in success?
8. **C - Competition:** Who else are they evaluating (direct competitors or internal build)?

---

## 2. Output Contract

```markdown
### 🎯 MEDDPICC Deal Health Score: [XX / 80]

- **Deal Risk Level:** [LOW | MEDIUM | HIGH]
- **Key Red Flag:** <The single biggest risk in this opportunity>

| Dimension | Score (0-10) | Status | Evidence / Notes |
|---|---|---|---|
| Metrics | X/10 | [VERIFIED / UNKNOWN] | ... |
| Economic Buyer | X/10 | [VERIFIED / UNKNOWN] | ... |
| Decision Criteria | X/10 | [VERIFIED / UNKNOWN] | ... |
| Decision Process | X/10 | [VERIFIED / UNKNOWN] | ... |
| Paper Process | X/10 | [VERIFIED / UNKNOWN] | ... |
| Implicated Pain | X/10 | [VERIFIED / UNKNOWN] | ... |
| Champion | X/10 | [VERIFIED / UNKNOWN] | ... |
| Competition | X/10 | [VERIFIED / UNKNOWN] | ... |

#### Next Recommended Actions (Deal Accelerator):
1. <Action 1 to fill highest-priority information gap>
```
