---
name: kpi-anomaly-triage
description: "Use for statistical anomaly detection in business metrics (MRR, conversion rates, CAC, churn, API latency), causal correlation, and executive action briefing."
category: analytics
keywords:
  - analytics
  - kpi
  - anomaly
  - metrics
  - conversion
  - triage
minComplexity: medium
recommendedTier: pro
preferLocal: false
estimatedTokens: 311
outputFormat: markdown
tags:
  - analytics
  - diagnostic
  - reasoning-tier
version: 1
---

# Procedure: KPI Anomaly Triage & Root-Cause Briefing

Use this procedure when automated monitoring detects a statistically significant spike or drop in business or operational metrics (e.g., >20% deviation from 30-day baseline).

---

## 1. Triage Workflow

1. **Verify Anomaly Authenticity:**
   - Check for tracking artifacts, timezone offsets, tracking tag dropouts, or seasonality (e.g., weekend dips, holiday closures).

2. **Multi-Variable Correlation:**
   - Correlate metric drop/spike against:
     - Traffic source changes (e.g., paid ad pause, bot traffic spike).
     - Recent software releases or third-party API outages.
     - Device/browser breakdown (e.g., iOS WebKit bug).

3. **Quantify Financial / Operational Impact:**
   - Calculate projected revenue loss or conversion drag if unaddressed for 7/30 days.

---

## 2. Output Contract

```markdown
### 📊 KPI Anomaly Report: [METRIC NAME]

- **Deviation:** [+/- XX% vs 30d Baseline]
- **Severity:** [CRITICAL | WARNING | INFORMATIONAL]
- **Root Cause Hypothesis:** <Concise explanation of underlying driver>

#### Diagnostic Evidence:
- **Correlated Factor 1:** ...
- **Correlated Factor 2:** ...

#### Executive Action Plan:
1. <Immediate corrective action step>
```
