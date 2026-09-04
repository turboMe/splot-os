---
name: comp-title-finder
description: Find and analyze comparable titles for query letters, marketing, and positioning strategy
author: Writing Secrets
version: 1.0.0
triggers:
  - "comp title"
  - "comp titles"
  - "comparable"
  - "comparison title"
  - "query letter comp"
  - "market position"
  - "books like mine"
  - "similar books"
permissions:
  - file:read
  - web:search
---

# Comp Title Finder — Premium Skill

Find perfect comparable titles for query letters, Amazon categories, marketing copy, and positioning strategy. Stop guessing — know exactly where your book fits in the market.

## Comp Title Discovery

Feed it your manuscript details and get strategic comp title recommendations:

### Input
```yaml
book:
  title: "The Silent Hour"
  genre: "Psychological Thriller"
  subgenre: "Domestic Suspense"
  themes:
    - "gaslighting"
    - "unreliable narrator"
    - "small-town secrets"
  tone: "Dark, atmospheric, slow burn"
  protagonist: "Woman uncovering her husband's hidden life"
  setting: "Pacific Northwest, present day"
  word_count: 82000
  target_audience: "Readers of Gillian Flynn and Ruth Ware"
  unique_elements:
    - "Dual timeline (present/10 years ago)"
    - "Epistolary elements (found journals)"
```

### Output
```
Comp Title Analysis: "The Silent Hour"

═══ PRIMARY COMPS (Best for Query Letters) ═══

1. "The Wife Between Us" by Greer Hendricks & Sarah Pekkanen (2018)
   Match Score: 92%
   Why: Domestic suspense, unreliable narrator, husband's secrets
   Market proof: NYT Bestseller, 500K+ copies
   ⚠️ Freshness: 2018 — still relevant but agents prefer 2-5 year window
   Pitch angle: "For readers who loved the twist in The Wife Between Us"

2. "The Last Thing He Told Me" by Laura Dave (2021)
   Match Score: 87%
   Why: Woman uncovering husband's hidden past, atmospheric, slow burn
   Market proof: #1 NYT, Apple TV+ adaptation
   ✅ Freshness: Perfect window
   Pitch angle: "The atmospheric dread of The Last Thing He Told Me meets..."

3. "The Maid" by Nita Prose (2022)
   Match Score: 71%
   Why: Mystery, distinctive voice, slow reveal
   ⚠️ Note: Different subgenre — use only if emphasizing voice/style

═══ SECONDARY COMPS (Marketing & Categories) ═══

4-6. [Additional comps for Amazon categories, BookBub, social media]

═══ COMPS TO AVOID ═══
❌ "Gone Girl" — Too obvious, agents will eye-roll
❌ "The Girl on the Train" — Overused as comp, signals lazy research
❌ Any book 10+ years old (unless a classic touchstone)

═══ QUERY LETTER COMP FORMULA ═══
"THE SILENT HOUR is a 82,000-word psychological thriller —
The Last Thing He Told Me meets The Wife Between Us
with the atmospheric Pacific Northwest setting of Megan Miranda's
The Last House Guest."
```

## Comp Validation

Already have comp titles? Validate them:

- **Relevance check** — Does this comp actually match your book?
- **Freshness check** — Is this comp too old? (Agents want 2-5 years)
- **Sales check** — Did this comp sell well enough to reference?
- **Overuse check** — Is every query letter citing this book?
- **Audience overlap** — Do readers of this comp want YOUR book?
- **Agent/editor perception** — What does citing this comp signal?

## Market Positioning Map

Visual map of where your book sits in the competitive landscape:

```
Market Position Map: Psychological Thriller (Domestic)

DARKER ←────────────────────────→ LIGHTER
  │                                    │
  │  "Behind        ★ YOUR BOOK       │
  │   Closed        "The Silent       │
  │   Doors"         Hour"            │
SLOW │                                │ FAST
BURN │    "The Wife          "The     │ PACED
  │     Between Us"     Maid"         │
  │                                    │
  │  "Gone           "The Last        │
  │   Girl"           Thing He        │
  │                    Told Me"        │
  │                                    │

Your Niche: Dark + Slow Burn quadrant
Competition density: MODERATE (good — not oversaturated)
Reader appetite: HIGH (this quadrant is trending up)
```

## Category Strategy

Recommend optimal Amazon/BISAC categories based on comp analysis:

1. **Primary BISAC** — Where your book belongs by content
2. **Strategic BISAC** — Where you'll rank fastest
3. **Amazon Browse Categories** — Up to 10 specific categories
4. **Keyword Strategy** — 7 backend keywords for KDP
5. **Category rank analysis** — Competition density per category

## Agent Research Integration

When used with comp titles, enhance your query letter research:

- Which agents repped your comp titles?
- Which editors acquired them?
- Which imprints publish in this space?
- Recent deals in your comp zone (from Publishers Marketplace style analysis)
- Submission strategy based on comp alignment

## Trend Analysis

Analyze whether your book's positioning is trending up or down:

- **Subgenre trajectory** — Is domestic suspense growing or saturating?
- **Theme trends** — Are unreliable narrators still fresh?
- **Format trends** — Are dual timelines hot or tired?
- **Audience sentiment** — What are readers asking for on Goodreads/BookTok?

## Commands
- `find comps` — Full comp title discovery from your book details
- `validate comps [title1, title2]` — Check if your comps work
- `market position` — Visual positioning map
- `category strategy` — Amazon/BISAC category recommendations
- `comp for query` — Generate query-letter-ready comp formula
- `trend check [subgenre]` — Is your positioning trending up or down?
