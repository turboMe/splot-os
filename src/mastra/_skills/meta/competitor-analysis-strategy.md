---
name: competitor-analysis-strategy
category: meta
description: >-
  Strategic framework for competitive intelligence gathering using
  business_competitor_analysis tool. Covers SWOT synthesis, Porter's 5 Forces
  framing, pricing intelligence, and output formatting.
  Trigger: "analyze competitor", "research competition", "competitive intel",
  "how does X compare", "battlecard for X".
keywords: [competitor, analysis, competitive intelligence, SWOT, pricing, market, research, battlecard]
allowedTools: [business_competitor_analysis, search_web, search_find_company_links]
minComplexity: moderate
recommendedTier: fast
estimatedTokens: 1300
outputFormat: markdown
tags: [meta, research, business, competitive]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Competitor Analysis Strategy

> Use `business_competitor_analysis` as the primary research tool.
> Supplement with `search_web` for gaps.
> Output: structured SWOT + competitive summary.

## When to Use This Skill

- "Analyze [Company]" / "Tell me about [Company]"
- "How do we compare to [Competitor]?"
- "Create a competitive battlecard for [Company]"
- "What are [Company]'s pricing and products?"
- Producer-hunt: researching whether a supplier has existing digital tools
- Market entry: mapping the competitive landscape before product decisions

## Step-by-Step Framework

### Step 1 — Define Scope
Before calling the tool, clarify:
- **Who?** Full legal name + known aliases (e.g. "Comarch ERP" not just "Comarch")
- **Industry context?** Narrows search to relevant results
- **What matters most?** (pricing? product gaps? customer sentiment?)

### Step 2 — Run Competitor Analysis Tool

```
business_competitor_analysis({
  companyName: "Exact Company Name",
  website: "https://company.com",        // optional but recommended
  industry: "restaurant management SaaS", // optional — improves relevance
  focusAreas: ["overview", "products", "pricing", "reviews", "news"],
  language: "en",                         // or "pl" for Polish companies
  maxResultsPerArea: 4
})
```

**Focus area selection:**
| Goal | Focus Areas |
|------|-------------|
| Quick overview | `["overview", "products"]` |
| Pricing benchmark | `["pricing", "products"]` |
| Customer perception | `["reviews", "overview"]` |
| Full battlecard | all 5 areas |
| Recent changes | `["news", "overview"]` |

### Step 3 — Synthesize Raw Context

The tool returns `rawContext` — concatenated snippets organized by section.
Use this to extract:

**Company profile:**
- What does the company do? (1-2 sentences)
- Founded when? Headquarters? Size?
- Primary customer segment

**Products & Features:**
- List key products/services
- Flagship features vs. competitors
- Missing features (gaps)

**Pricing:**
- Model: freemium / subscription / per-seat / custom / one-time
- Price range: entry-level → enterprise
- Free trial? Open pricing vs. "contact sales"?

**Customer Sentiment** (from reviews section):
- Recurring praise themes
- Recurring complaint themes
- NPS / star rating if available
- Review sources: G2, Capterra, Trustpilot, Google Maps

### Step 4 — SWOT Analysis

Based on synthesized context, build a SWOT:

```
## SWOT — [Company Name]

**Strengths** (internal positives)
- [What they do well that competitors don't]
- [Strong brand recognition / market share]
- [Superior technology / UX]

**Weaknesses** (internal negatives)
- [Pricing too high for SMB]
- [Poor mobile experience]
- [Limited integrations]

**Opportunities** (external positives our company could exploit)
- [Competitor has no Polish localization]
- [No HORECA-specific features]
- [Poor customer support ratings — we can differentiate here]

**Threats** (external negatives)
- [Large VC funding — may undercut pricing]
- [Enterprise contracts lock in customers]
- [Network effects in their platform]
```

### Step 5 — Confidence Scoring

Apply confidence scores to each finding:

| Finding | Confidence | Rule |
|---------|------------|------|
| Verified on official website | 🟢 High | Primary source |
| Mentioned in 3+ reviews | 🟡 Medium | Multiple independent sources |
| From 1 blog post | 🟠 Low | Single source |
| Inferred/estimated | 🔴 Speculative | Flag as such |

### Step 6 — Output Format

**Standard competitive summary:**
```markdown
## Competitive Analysis: [Company Name]
*Researched: [date] | Confidence: [overall score]*

### Overview
[2-3 sentences: who they are, market position, key differentiator]

### Products & Services
| Product | Description | Target |
|---------|-------------|--------|
| ... | ... | ... |

### Pricing
- **Model:** [freemium/subscription/etc]
- **Entry:** [price or "N/A"]
- **Mid-tier:** [price]
- **Enterprise:** [contact sales / estimate]

### Strengths
- [S1]
- [S2]

### Weaknesses / Gaps
- [W1]
- [W2]

### Our Competitive Opportunity
[1-2 sentences: where we have an advantage or can differentiate]

### Sources
- [url1]
- [url2]
```

## Multi-Competitor Comparison

When comparing 2+ competitors, run `business_competitor_analysis` for each,
then build a comparison matrix:

```markdown
## Competitive Matrix

| Feature | Us | CompetitorA | CompetitorB |
|---------|-------|-------------|-------------|
| Pricing | [X] | [Y] | [Z] |
| Mobile app | ✅ | ❌ | ✅ |
| API | ✅ | ✅ | ❌ |
| Polish language | ✅ | ❌ | ❌ |
| Free trial | ✅ | ✅ | ❌ |
```

## Anti-Patterns

❌ Trusting a single source for pricing (always triangulate)
❌ Using marketing copy as "strength" evidence — look for reviews
❌ Ignoring negative results (gaps = opportunities)
❌ Reporting estimated prices as confirmed facts without flagging
❌ Running only 1 search query per competitor

## Supplementary Searches

If `business_competitor_analysis` misses something, supplement with `search_web`:

```
search_web({ query: "[Company] pricing 2025 site:g2.com OR site:capterra.com" })
search_web({ query: "[Company] vs [OurProduct] comparison" })
search_web({ query: "[Company] customer complaints problems" })
search_web({ query: "[Company] funding investment valuation" })
```
