---
name: automation-client-hunt-strategy
description: >-
  Strategy for finding companies that need process automation.
  Defines the ICP, buying signals, Tavily query patterns,
  qualification scoring and a B2B cold-email template.
category: meta
keywords: [prospecting, lead-gen, automation, n8n, cold-email, B2B, Poland]
allowedTools: [search_web, search_find_company_links]
minComplexity: 3
recommendedTier: balanced
estimatedTokens: 550
outputFormat: json
tags: [sales, outbound, prospecting]
version: 1.0.0
handoffCapable: true
---

# Automation Client Hunt Strategy

## ICP (Ideal Customer Profile)
- Company in Poland, 5-50 employees
- Target industries: e-commerce, marketing agencies, accounting offices,
  logistics companies, software houses, service businesses
- Buying signals:
  1. Job postings for 'data entry', 'virtual assistant', 'operations specialist'
  2. No integrations visible on the site (e.g. manual forms, no API)
  3. The company is growing (new locations, products) but processes are still manual
  4. Google Reviews complaints about slow service / order errors
  5. Site with no chatbot, no automated replies, no CRM integration

## Query patterns (Tavily)
For each industry, use a combination (search strings stay in Polish — Polish market):
- '[branża] firma Polska zatrudnia data entry 2026'
- '[branża] Polska mała firma manual processes'
- '[branża] Polska oferty pracy operations assistant'
- 'automatyzacja procesów [branża] Polska case study' (look for competitors' clients)
- 'site:pracuj.pl [branża] data entry' (job postings = buying signal)

## Qualification scoring (1-10)
- 8-10: clear signal (data-entry job posting + no automation on the site)
- 5-7: indirect signal (growing company + no integrations)
- 1-4: reject (too small, too large, already has visible automation)

## B2B cold-email template
Rules:
- Max 150 words
- Start with the company's PROBLEM, not with yourself
- One concrete use-case, not a list of services
- CTA: a 15-minute call
- Opt-out (verbatim Polish line in the email): 'Jeśli nie chcesz otrzymywać wiadomości, odpowiedz STOP.'
- FORBIDDEN words (avoid these Polish buzzwords in the email): innowacyjny, kompleksowy,
  synergiczny, holistyczny, rewolucyjny, cutting-edge, game-changer
- Tone: direct, concrete, human

## Output format
```json
{
  "firms": [{
    "name": "string",
    "website": "string",
    "industry": "string",
    "size": "string | null",
    "automation_signal": "string",
    "contact_email": "string | null",
    "quality_score": "number",
    "proposed_usecase": "string",
    "estimated_hours_saved": "number",
    "proposed_subject_line": "string"
  }]
}
```
