---
name: email-communication-strategy
category: meta
description: >-
  Email communication strategy for agents. Covers cold email,
  follow-up timing, subject line optimization, thread management,
  personalization and A/B testing. Integrates with producer-hunt
  and CRM workflows.
keywords: [email, communication, cold-email, follow-up, marketing, outreach, personalization]
allowedTools: [search_web, fs_read_file]
minComplexity: moderate
recommendedTier: balanced
estimatedTokens: 1200
outputFormat: text
tags: [communication, email, strategy, marketing]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Email Communication Strategy

> NOTE: the email templates and example subject lines below are the Polish DELIVERABLE
> (emails ship to a Polish audience), so they stay in Polish. Only the instructions are English.

## Trigger
- Drafting cold emails (producer-hunt)
- Follow-up after no reply
- Bulk email campaigns
- Template creation for outreach

## Cold Email Framework — AIDA

```
A — Attention:  Personalized hook (name, company, context)
I — Interest:   Value for the recipient (not about us, about THEM)
D — Desire:     Concrete benefit + social proof
A — Action:     One clear CTA (Call-To-Action)
```

### Reference Cold Email (Polish deliverable — keep verbatim)

```
Subject: [Imię], pytanie o [konkretny temat z ich branży]

Cześć [Imię],

Widziałem, że [firma] specjalizuje się w [konkretny produkt/usługa].
[1 zdanie personalizacji — coś z ich strony/LinkedIn].

Pomagamy firmom z branży [HoReCa/produkcja] w [konkretna korzyść].
[Social proof: "Współpracujemy z X firmami z regionu Y"].

Czy mógłbym poświęcić 15 minut na krótką rozmowę w przyszłym tygodniu?

Pozdrawiam,
[Podpis]
```

## Subject Line Rules

### ✅ Effective patterns (example subjects stay Polish — deliverable)
| Pattern | Example | Open Rate |
|---------|---------|-----------|
| Question + name | "[Imię], współpraca z [branża]?" | ~35% |
| Concrete number | "3 sposoby na obniżenie food cost o 15%" | ~30% |
| Curiosity | "Pytanie o [ich produkt]" | ~28% |
| Personalization | "Re: [ich event/artykuł]" | ~40% |

### ❌ Avoid
- ALL CAPS
- More than 1 emoji
- "Oferta specjalna!!!"
- No personalization
- Subject > 50 characters

## Follow-up Cadence

```
Day 0:  Email 1 — First contact (cold email)
Day 3:  Email 2 — Short follow-up ("Czy dostał/a Pan/i mój email?")
Day 7:  Email 3 — Extra value (case study, article)
Day 14: Email 4 — Breakup email ("Ostatni raz piszę...")
```

### Follow-up Rules
1. **Max 4 emails** in one sequence
2. **Never** send > 1 email/day to the same person
3. **Change the angle** in each follow-up (don't repeat)
4. **Breakup email** has the highest response rate (~12%)
5. **Don't send** on weekends or after 18:00

### Follow-up Template (Polish deliverable — keep verbatim)
```
Subject: Re: [oryginalny subject]

Cześć [Imię],

Piszę krótki follow-up do mojego emaila z [dzień].
[1 nowe zdanie wartości / nowy kąt].

Czy [firma] jest zainteresowana [konkretna propozycja]?

Pozdrawiam,
[Podpis]
```

## Personalization Levels

| Level | Time required | When to use |
|-------|--------------|-------------|
| **L1** Basic | 0 min | Name + company from the database |
| **L2** Research | 2 min | + something from their site/LinkedIn |
| **L3** Deep | 5 min | + concrete analysis of their business |
| **L4** Bespoke | 15 min | VIP leads, strategic partners |

### Personalization Sources
- Company website (→ Firecrawl/Playwright)
- The person's LinkedIn profile
- Google News about the company
- Their social media (Facebook, Instagram)
- KRS / rejestr.io (financial data)

## Email Structure Rules

### Length
- **Cold email:** max 150 words (5-7 sentences)
- **Follow-up:** max 80 words (3-4 sentences)
- **Answer to a question:** max 300 words

### Formatting
- Short paragraphs (1-2 sentences)
- Whitespace between paragraphs
- One bold span max
- No attachments in a cold email

### CTA (Call To Action)
- **One CTA per email** — don't offer a choice
- Concrete: "Czy środa o 10:00 pasuje?" instead of "Kiedy Pan może?"
- Low-friction: "15 minut rozmowy" instead of "spotkanie"

## Thread Management

### Thread tracking
```typescript
interface EmailThread {
  recipientEmail: string;
  company: string;
  sequenceStep: number;  // 1-4
  lastSentAt: Date;
  nextFollowUpAt: Date | null;
  status: 'active' | 'replied' | 'bounced' | 'unsubscribed' | 'completed';
  opens: number;
  clicks: number;
}
```

### Status Transitions
```
active → replied (got response)
active → bounced (delivery failed)
active → completed (sequence finished, no reply)
active → unsubscribed (opt-out request)
replied → (manual handling)
```

## Integration with Producer-Hunt

```
1. producer-hunt discovery → list of companies
2. producer-hunt enrichment → contact, email, context
3. email-communication-strategy → draft email with AIDA
4. producer-hunt draft → generate the email
5. Follow-up cadence → schedule the sequence
```

## Anti-Patterns

❌ Mass blast with no personalization
❌ Long emails (> 200 words cold)
❌ Multiple CTAs in one email
❌ Follow-up on the same day
❌ Ignoring bounce/unsubscribe
❌ No subject line testing

## Success Criteria
- Cold email < 150 words
- Personalization min. L2 (company + something from research)
- Follow-up cadence 3-7-14 days
- Max 4 emails in a sequence
- Subject < 50 characters, personalized
