---
name: sentiment-review-intelligence
description: Mine public customer reviews (Google Places, TripAdvisor, Trustpilot) to extract operational bottlenecks, service velocity issues, and competitor sentiment.
category: research
keywords:
  - sentiment
  - reviews
  - google-places
  - tripadvisor
  - research
  - consulting
minComplexity: medium
recommendedTier: balanced
allowedTools:
  - view
  - search_content
estimatedTokens: 371
outputFormat: markdown
tags:
  - research
  - sentiment
  - subagent-tier
version: 1
---

# Procedure: Customer Review Intelligence & Operational Sentiment Mining

Use this procedure (for GastroBridge and consulting research) to analyze 50-500+ customer reviews and extract recurring operational failure modes and competitive advantages.

---

## 1. Analysis Dimensions

1. **Categorical Sentiment Breakdown:**
   - **Service & Staff:** Wait times, friendliness, knowledge, order accuracy.
   - **Product / Food Quality:** Portion sizing, taste consistency, temperature, presentation.
   - **Value Perception (Price vs Experience):** Complaints regarding price bumps or hidden fees.
   - **Atmosphere & Cleanliness:** Noise levels, hygiene, restroom cleanliness, decor.

2. **Trend & Seasonality Detection:**
   - Differentiate recent 90-day sentiment vs historical ratings to detect operational declines following management or chef turnover.

3. **High-Frequency Keyword Clustering:**
   - Isolate repeated negative phrases (e.g., *"waited 45 mins"*, *"cold fries"*, *"overpriced"*) and positive differentiators.

---

## 2. Output Contract

```markdown
### 🔍 Review Sentiment Intelligence

- **Analyzed Sample:** N reviews
- **Net Sentiment Score:** [Positive / Neutral / Negative]

| Category | Sentiment (%) | Top Repeated Complaint | Operational Recommendation |
|---|---|---|---|
| Service Velocity | 42% Neg | Long wait on weekends | Add runner during peak hours |
| Quality Consistency| 15% Neg | Inconsistent steak temp | Calibrate kitchen timers / SOP |
```
