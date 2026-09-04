---
name: market-research-methodology
category: meta
description: >-
  Systematic framework for market research tasks. Covers data source priority
  hierarchy, research phases (scope → data → synthesis → validate),
  confidence scoring per finding, and structured output.
  Trigger: "research the market for X", "market analysis", "market size",
  "industry trends", "target customer research", "market opportunity".
keywords: [market research, industry analysis, market size, TAM SAM SOM, trends, data sources, confidence]
allowedTools: [search_web, business_competitor_analysis, search_find_company_links]
minComplexity: moderate
recommendedTier: fast
estimatedTokens: 2100
outputFormat: markdown
tags: [meta, research, market, business, methodology]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Market Research Methodology

> Systematic, evidence-based market research framework.
> Prioritizes authoritative sources. Applies confidence scores to every finding.
> Do NOT use for simple factual lookups — use `search.web` directly for those.

## When to Use This Skill

- "What is the market size for [industry]?"
- "Research the Polish food service market"
- "What are the trends in [sector]?"
- "Who are the target customers for [product]?"
- "Is there opportunity in [market segment]?"
- Before any product/business decision requiring market validation

---

## Phase 1: Scope Definition

Before searching, define:

1. **Market boundaries** — geographic (PL? EU? global?), segment (B2B/B2C?), industry
2. **Key questions** — what decisions does this research inform?
3. **Required outputs** — market size? growth rate? customer segments? key players?
4. **Time horizon** — current state? 3-year projection? historical trend?

**Decompose into 4-6 sub-questions:**
- Market size & growth rate (TAM/SAM/SOM)
- Key customer segments (who buys? why?)
- Major players & market share
- Industry trends & drivers
- Regulatory / macro environment
- Unmet needs / white spaces

---

## Phase 2: Data Source Priority

Research in this order — higher priority sources override lower ones:

```
🟢 TIER 1 — Primary (cite directly, high confidence)
  - Official government statistics (.gov, GUS, Eurostat, US Census)
  - Central bank / financial authority reports
  - Industry association data (NRA, AHLA, PFHiŻ, etc.)
  - EU/World Bank datasets

🟡 TIER 2 — Secondary (good evidence, moderate confidence)
  - Major research firms: McKinsey, Deloitte, PwC, BCG reports
  - Industry publications: FoodService Europe, Restaurant Business
  - Publicly traded company filings (10-K, annual reports)
  - Academic journals

🟡 TIER 3 — Supplementary (triangulation, lower weight)
  - Reputable news outlets (Reuters, Bloomberg, Financial Times)
  - Trade press (specific industry news sites)
  - LinkedIn industry insights

🟠 TIER 4 — Indicative only (always verify elsewhere)
  - Market research firms with paywalled full reports (free excerpts)
  - Press releases from companies (biased but useful for facts)
  - Community forums (Reddit, industry Slack)

🔴 AVOID as primary source
  - Anonymous blogs / marketing content
  - Wikipedia (use as starting point only, verify all citations)
  - Unattributed statistics ("studies show...")
```

**Search query templates by tier:**
```
Tier 1: "GUS rynek gastronomia 2024 statystyki"
         "Eurostat food service industry statistics"
Tier 2: "McKinsey restaurant industry report 2025"
         "Deloitte food beverage market outlook"
Tier 3: "restaurant industry Poland market size 2024 news"
Tier 4: "food service market Poland Reddit forum"
```

---

## Phase 3: Research Execution

### 3.1 Market Size & Growth

**Required data points:**
- TAM (Total Addressable Market): total market if you had 100% share
- SAM (Serviceable Addressable Market): segment you can realistically reach
- SOM (Serviceable Obtainable Market): realistic capture in 3-5 years
- CAGR (Compound Annual Growth Rate): 3-5 year projection

**Search sequence:**
```
1. "[industry] market size [country] 2024 statistics"
2. "[industry] revenue [country] GUS / Eurostat / Statista"
3. "[industry] CAGR forecast 2025 2030"
4. "[segment] market share Poland / Europe"
```

**Size estimation heuristics** (when official data unavailable):
- Number of businesses × average spend/year = proxy TAM
- Cross-reference 2-3 sources, take average
- Note methodology in output

### 3.2 Customer Segments

**Research angles:**
- Demographics (age, income, business size, geography)
- Psychographics (values, pain points, buying triggers)
- Behavioral (buying frequency, channel preference, LTV)

**Search sequence:**
```
1. "[product category] target customers who buys"
2. "[industry] customer segments B2B B2C"
3. "[industry] buyer persona survey report"
4. "[industry] customer pain points problems"
```

### 3.3 Trends & Drivers

**Categories to cover:**
- Technology trends (digitization, automation, AI adoption)
- Consumer behavior shifts
- Regulatory changes (EU legislation, local law)
- Economic factors (inflation, labor costs, supply chain)
- Sustainability / ESG pressures

**Search sequence:**
```
1. "[industry] trends 2025 2026"
2. "[industry] future outlook challenges opportunities"
3. "[industry] digital transformation technology adoption"
4. "[industry] regulations EU Poland upcoming"
```

### 3.4 Competitive Landscape

Use `business.competitor_analysis` for key players:
```
business.competitor_analysis({ companyName: "Leader Co", industry: "...", focusAreas: ["overview", "products", "pricing"] })
```

Supplement with:
```
search.web({ query: "[industry] top companies market leaders [country] 2024" })
search.web({ query: "[industry] market share breakdown report" })
```

---

## Phase 4: Confidence Scoring

Apply to EVERY finding before including in output:

| Evidence Strength | Score | Label | How to apply |
|-------------------|-------|-------|-------------|
| 3+ Tier 1 sources agree | 0.9 | 🟢 VERIFIED | State as fact |
| 1 Tier 1 source | 0.75 | 🟢 STRONG | State as fact, cite source |
| 2+ Tier 2 sources | 0.6 | 🟡 LIKELY | "Evidence suggests..." |
| 1 Tier 2 source | 0.5 | 🟡 MODERATE | "According to [source]..." |
| Tier 3 sources only | 0.3 | 🟠 INDICATIVE | "Reported by..." |
| Estimated/inferred | 0.2 | 🟠 ESTIMATE | "Estimated based on..." |
| Single Tier 4 source | 0.1 | 🔴 UNVERIFIED | Flag explicitly |

**Aggregated research confidence:**
- All key findings 🟢: Report confidence = HIGH
- Mix of 🟢 and 🟡: Report confidence = MEDIUM
- Mostly 🟠/🔴: Report confidence = LOW — flag limitations prominently

---

## Phase 5: Output Format

```markdown
## Market Research Report: [Topic]
*Date: [YYYY-MM-DD] | Geography: [X] | Research confidence: [HIGH/MEDIUM/LOW]*

---

### Executive Summary
[3-5 bullet points: key findings, market size, growth rate, top opportunities]

---

### Market Size
| Metric | Value | Year | Source | Confidence |
|--------|-------|------|--------|------------|
| TAM | [€Xbn / X units] | 2024 | [source] | 🟢 |
| SAM | [€Xbn] | 2024 | [estimate] | 🟡 |
| CAGR | [X%] | 2024-2028 | [source] | 🟡 |

*Methodology: [How TAM was calculated if not from official source]*

---

### Customer Segments
| Segment | Size | Key Needs | Channel | LTV est. |
|---------|------|-----------|---------|----------|
| [SMB restaurants] | [40% of market] | [inventory mgmt] | [direct] | [€Xk/yr] |

---

### Key Trends
1. **[Trend Name]** (Confidence: 🟢)
   > [Description + why it matters]
   Sources: [url1], [url2]

2. **[Trend Name]** (Confidence: 🟡)
   > [Description]

---

### Competitive Landscape
[Summary from competitor_analysis tool or manual research]

| Player | Market Position | Key Strength | Weakness |
|--------|----------------|--------------|---------|
| [Co A] | Leader | [X] | [Y] |
| [Co B] | Challenger | [X] | [Y] |

---

### Market Gaps & Opportunities
- [Unmet need #1] — (Confidence: 🟡 Medium)
- [Underserved segment] — (Confidence: 🟠 Indicative)

---

### Risks & Constraints
- [Regulatory risk]
- [Economic headwind]
- [Competitor response risk]

---

### Data Limitations
- [What we couldn't find / what would improve confidence]
- [Data freshness caveats]

### Sources
- [Full URL list with tier labels]
```

---

## Research Budgets

| Task | Max searches | Target confidence |
|------|-------------|-------------------|
| Quick market snapshot | 5-8 searches | MEDIUM |
| Standard market analysis | 10-15 searches | HIGH |
| Deep sector report | 20-30 searches | HIGH |
| Single data point check | 2-3 searches | any |

**Stop when:**
- All key questions answered at 🟡 or above
- Search count > 25 (cost limit)
- 3 consecutive searches return no new information

**Continue when:**
- Critical metric (TAM/CAGR) still at 🟠 or lower
- Contradictions between sources unresolved
- User explicitly requested "deep" or "thorough" research

---

## Common Mistakes

❌ Presenting Statista paywall excerpts as authoritative (partial data)
❌ Using market size from a vendor's marketing page (biased)
❌ Conflating TAM with SAM in growth projections
❌ Treating 2019/2020 data as current for post-COVID markets
❌ Forgetting to specify geography (global ≠ Poland ≠ EU)
❌ No confidence scores on findings — every number needs a source
