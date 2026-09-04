---
name: adversarial-fact-checker
category: research
description: >-
  Adversarial claim verification. Turns findings into atomic falsifiable claims, searches for
  disconfirming evidence, and resolves numeric conflicts by methodology rather than averaging.
  Trigger when sources disagree, when a claim is load-bearing for a decision, or before
  publishing figures, dates, pricing, or benchmark results.
keywords: [fact-checking, verification, disconfirming-evidence, claim-verification, contradiction, conflicting-sources, accuracy, provenance]
allowedTools: [search_web, tavily_extract, fetch_page, writer_upsert_claims, writer_verify_claims, artifact_put]
minComplexity: medium
recommendedTier: fast
estimatedTokens: 1400
outputFormat: markdown
tags: [research, fact-checking, verification, accuracy, quality]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Adversarial Fact-Checking

## 1. Trigger

Load this when the PSEV **VERIFY** step hits one of:

- two sources report different numbers, dates, or versions for the same thing;
- a claim is load-bearing (a decision, a price, a deployment, a client-facing statement rests on it);
- the finding is surprising — a surprising claim is either a real find or a misread, and those need
  different handling.

Do **not** load it for routine multi-source agreement. Concurring sources need citation, not a trial.

## 2. The move that makes this work: search to break the claim, not to support it

Confirmation search finds confirmation. That is the whole failure mode. So:

1. **Atomise.** Rewrite the finding as one falsifiable sentence with a subject, a value, and a date.
   - ❌ "Framework X has good transaction support."
   - ✅ "Framework X supports distributed transactions in version 2.4, GA since 2026-03."
2. **Invert the query.** Search the *negation*, not the claim.
   - `"framework X" 2.4 distributed transactions NOT supported limitation issue`
   - `"framework X" transactions bug regression 2.4`
3. **Three independent angles**, not three URLs — three *kinds* of source:
   - **Primary**: official release notes, changelog, the source code, the filing, the spec.
   - **Independent reproduction**: a benchmark with a published method, a second implementation.
   - **Errata**: issue tracker, known-issues page, post-mortems, community reports of it failing.
4. **Score the outcome.**

| Refutations | Verdict | What you do |
|---|---|---|
| 0 of 3 | ✅ **VERIFIED** | State it with the primary citation and its date. |
| 1 of 3 | 🟡 **DISPUTED** | Keep it, but carry the dissent inline — never silently drop the minority source. |
| 2+ of 3 | 🔴 **REFUTED** | Remove the claim. If it was going to be a headline, say explicitly that it was checked and did not hold. |

An angle that returns **nothing** is not a refutation and not a confirmation. It is a gap — record
it as one. Absence of counter-evidence in a low-coverage topic proves nothing.

## 3. Numeric conflicts: reconcile the definition before the number

When two sources give different figures, the near-certain cause is a different definition, not a lie.
Check, in order: **metric definition** (revenue vs ARR vs bookings; active vs registered; GAAP vs
adjusted), **time window** (trailing twelve months vs fiscal year vs quarter), **scope** (segment vs
consolidated; region vs global), **vintage** (a changelog supersedes a news article).

If it still does not reconcile, publish the conflict rather than resolving it by fiat:

| Source | Value | Metric definition | As of |
|---|---|---|---|
| Vendor pricing page (primary) | 120 PLN / mies. | per seat, annual billing | 2026-08-24 |
| Comparison article (tier 3) | 89 PLN / mies. | promo, first year only | 2026-02 |

**Never average conflicting numbers.** An average of two different metrics is a third number that
measures nothing and cannot be traced back to a source.

## 4. Source authority tiers

1. **Primary** — official docs, changelogs, source code, filings, the vendor's own pricing page,
   peer-reviewed papers.
2. **High** — analyst reports with stated method, major outlets, benchmarks that publish their harness.
3. **Medium** — community blogs, forum threads, vendor comparison pages (vendor comparisons of
   *competitors* are marketing, not evidence).
4. **Low** — anonymous claims, SEO affiliate roundups, undated content, anything without a method.

A tier-3 source can *raise a question* about a tier-1 claim. It cannot *refute* it. Refutation
requires a source at the same tier or higher.

## 5. Output

Attach a verification line to each checked claim. In a research artifact:

```markdown
- Cena Enterprise: **120 PLN/seat/mies.** (roczne rozliczenie) — ✅ VERIFIED
  [Cennik vendora](https://…) 2026-08-24 · sprawdzone przeciw: archiwum cennika, wątek G2, changelog
- Udział rynkowy 34% — 🟡 DISPUTED: raport analityka podaje 34% (2026 Q1, tylko PL),
  vendor podaje 41% (2026 Q2, CEE). Różny zasięg geograficzny, nie sprzeczność.
- „Obsługuje offline POS" — 🔴 REFUTED: docs listują to jako roadmap Q4;
  dwa wątki supportu potwierdzają brak w 2026-08. Usunięte z porównania.
```

When the agent has the writer claim tools, the same verdicts go through `writer_upsert_claims` /
`writer_verify_claims` so the audit survives the conversation.

## 6. Invariants

1. **A citation is a URL plus a date.** A bare domain name is not a citation.
2. **Never cite a search snippet.** Fetch the page (`tavily_extract` / `fetch_page`) before quoting
   a number from it — snippets truncate exactly where the qualifier was.
3. **Report the check, not just the result.** "Verified" without naming what you tried to break it
   with is indistinguishable from "I did not check."
4. **A refuted claim leaves a trace.** Say it was checked and dropped; silent deletion means the
   next run repeats the work.
