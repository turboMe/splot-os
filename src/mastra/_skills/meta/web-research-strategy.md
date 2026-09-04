---
name: web-research-strategy
category: meta
description: >-
  Multi-step web research strategy for autonomous agents.
  Implements Plan-Search-Extract-Verify loop with multi-query expansion,
  source triangulation, credibility scoring, and confidence assessment.
  Use when agent needs to research a topic thoroughly rather than single-query.
keywords: [research, web-search, strategy, triangulation, multi-query, tavily, firecrawl, planning]
allowedTools: [search_web, search_find_company_links, fs_read_file]
minComplexity: moderate
recommendedTier: fast
estimatedTokens: 1250
outputFormat: text
tags: [research, strategy, web, meta]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Web Research Strategy

> For thorough research tasks. Do NOT use for simple factual lookups
> (use `search_web` directly for those).

## Trigger
- "research X thoroughly"
- "find comprehensive information about Y"
- "compare options for Z"
- Producer-hunt enrichment, competitor analysis, market research
- Any task requiring multiple sources and cross-verification

## The PSEV Loop (Plan → Search → Extract → Verify)

```
┌─────────────────────────────────────────────┐
│  1. PLAN                                     │
│  Decompose query → 3-5 sub-questions         │
│  Define: what counts as "enough" evidence    │
├─────────────────────────────────────────────┤
│  2. SEARCH                                   │
│  Run Tavily search per sub-question          │
│  Expand queries if results are thin          │
├─────────────────────────────────────────────┤
│  3. EXTRACT                                  │
│  Deep-read top results (Firecrawl/read)      │
│  Extract facts, data points, quotes          │
├─────────────────────────────────────────────┤
│  4. VERIFY                                   │
│  Cross-reference findings across sources     │
│  Score confidence per claim                  │
│  Identify contradictions & gaps              │
│  Decision: STOP or REFINE & loop back        │
└─────────────────────────────────────────────┘
```

## Step 1: PLAN — Query Decomposition

Given a broad research question, decompose into 3-5 targeted sub-questions.

**Example:**
- Main query: "Best practices for restaurant food cost management"
- Sub-questions:
  1. "What is an ideal food cost percentage for restaurants 2025?"
  2. "How to calculate food cost per dish recipe"
  3. "Restaurant inventory management techniques reduce waste"
  4. "Menu engineering food cost optimization strategies"
  5. "Food cost software tools comparison restaurants"

**Rules:**
- Each sub-question should be answerable independently
- Cover different aspects: definition, process, tools, examples
- Use specific terms (avoid vague "best" without context)
- Include year/date for time-sensitive topics

## Step 2: SEARCH — Multi-Query Execution

For each sub-question, run `search_web`:
```
search_web({ query: "sub-question here", maxResults: 5 })
```

**Query Expansion Rules:**
- If < 3 results returned: rephrase with synonyms
- If results are irrelevant: add domain-specific terms
- Try both English and Polish queries for bilingual topics
- Add "2025" or "2026" for current data

**Source Priority:**
1. 🟢 Official documentation / .gov / .edu
2. 🟢 Industry publications (e.g., NRA, AHLA)
3. 🟡 Major tech blogs (e.g., docs, official blogs)
4. 🟡 Reputable news outlets
5. 🟠 Community forums (Reddit, StackOverflow)
6. 🔴 Unknown blogs / marketing content (lower weight)

## Step 3: EXTRACT — Deep Reading

For the top 2-3 results per sub-question, extract deeply:
- **If Firecrawl available:** `firecrawl.scrape({ url })` → full markdown
- **If not:** Use result snippets from Tavily

**Extract:**
- Key facts and numbers (with source URL)
- Definitions and processes
- Pros/cons for comparisons
- Author credentials (if available)
- Publication date

## Step 4: VERIFY — Triangulation & Confidence

### Source Triangulation
A claim is verified when **3+ independent sources** agree.

| Sources agreeing | Confidence | Label |
|-----------------|------------|-------|
| 3+ independent | 🟢 High | VERIFIED |
| 2 sources | 🟡 Medium | LIKELY |
| 1 source only | 🟠 Low | UNVERIFIED |
| Sources contradict | 🔴 Conflict | DISPUTED |

### Stop Criteria
**STOP** researching when:
- All sub-questions have 🟢 High confidence answers
- 3+ iterations without new information
- Total search calls > 20 (cost limit)

**CONTINUE** researching when:
- Any sub-question has 🟠 Low or 🔴 Conflict
- Critical data point missing
- User requested "deep" or "thorough" research

## Output Format

```markdown
## Research Report: [Topic]

### Key Findings
1. **[Finding]** (Confidence: 🟢 High)
   - Sources: [url1], [url2], [url3]
   
2. **[Finding]** (Confidence: 🟡 Medium)
   - Sources: [url1], [url2]
   - Note: [caveat]

### Data Points
| Metric | Value | Source | Confidence |
|--------|-------|--------|------------|
| ... | ... | ... | 🟢/🟡/🟠 |

### Contradictions & Gaps
- [Source A] says X, but [Source B] says Y
- No data found for: [topic]

### Methodology
- Sub-questions: [N]
- Total searches: [N]
- Sources analyzed: [N]
- Research iterations: [N]
```

## Anti-Patterns (DON'T)

❌ Single-query research (use `search_web` directly instead)
❌ Trusting first result without verification
❌ Ignoring contradictory evidence
❌ Citing marketing content as authoritative
❌ Researching indefinitely (max 20 searches)
❌ Mixing opinions with facts without labeling

## Success Criteria
- 3+ sub-questions per research task
- All findings have confidence scores
- Contradictions explicitly noted
- Sources cited for every claim
- Research completes within 20 search calls
