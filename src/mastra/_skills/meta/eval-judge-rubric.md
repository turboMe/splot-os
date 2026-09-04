---
name: eval-judge-rubric
description: "Use for objective, rubric-based evaluation of agent artifacts (code, emails, reports, schemas) yielding a deterministic PASS/FAIL verdict and numerical score."
category: meta
keywords:
  - eval
  - judge
  - rubric
  - acceptance
  - review
  - quality-gate
minComplexity: medium
recommendedTier: pro
preferLocal: false
estimatedTokens: 353
outputFormat: markdown
tags:
  - eval
  - quality-gate
  - reasoning-tier
version: 1
---

# Procedure: LLM-as-a-Judge Evaluation Rubric

Use this procedure as an impartial, rubric-driven judge to evaluate artifacts produced by other agents or models against strict acceptance criteria.

---

## 1. Judging Rules

1. **Absolute Impartiality:**
   - No conversational pleasantries.
   - Evaluate solely against specified input criteria and constraints.
   - Any broken hard constraint results in an immediate **FAIL** verdict.

2. **Scoring Scale (1.0 to 5.0):**
   - **1.0:** Completely non-compliant, broken logic, critical hallucinations.
   - **2.0:** Partial implementation with major flaws or missing core requirements.
   - **3.0:** Meets baseline requirements but exhibits edge-case bugs or poor style.
   - **4.0:** High quality, all constraints satisfied, minor cosmetic observations.
   - **5.0:** Flawless production-grade execution, exemplary documentation, zero defects.

---

## 2. Output Contract

```markdown
### ⚖️ Judge Verdict: [PASS | FAIL]
- **Overall Score:** X.X / 5.0
- **Summary:** <1-sentence core justification>

#### Evaluation Breakdown:
| Criterion | Weight | Score (1-5) | Status | Observations |
|---|---|---|---|---|
| Logical Correctness | 40% | X/5 | [PASS/FAIL] | ... |
| Schema Compliance | 30% | X/5 | [PASS/FAIL] | ... |
| Security & Safety | 30% | X/5 | [PASS/FAIL] | ... |

#### Required Action Items:
1. <Exact remediation step required to achieve PASS>
```
