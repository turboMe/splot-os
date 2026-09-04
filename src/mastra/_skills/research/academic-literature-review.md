---
name: academic-literature-review
category: research
description: >-
  Rigour for reading scientific and technical literature — papers, preprints, benchmark claims,
  clinical or empirical studies. Extraction protocol, methodology critique, preprint caution, and
  translation into engineering conclusions. Trigger when the sources are papers rather than pages.
keywords: [academic-research, papers, arxiv, preprint, literature-review, methodology, ablation, benchmark-claims, peer-review, literatura-naukowa, artykuly-naukowe, badania, przeglad-literatury]
allowedTools: [search_web, tavily_extract, fetch_page, knowledge_add_source, knowledge_query, artifact_put]
minComplexity: complex
recommendedTier: pro
estimatedTokens: 800
outputFormat: markdown
tags: [research, science, academic, literature, evidence]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Academic & Technical Literature Review

## 1. Trigger

The sources are **papers**: arXiv preprints, conference papers, journal articles, technical reports,
vendor benchmark whitepapers. Different rules apply than to web research, because a paper's claim and
a paper's *evidence for* that claim are separate objects and only one of them is in the abstract.

For a large corpus, prefer routing through `knowledgeAgent` — a NotebookLM notebook holds many PDFs
better than a research thread does, and the sources stay queryable afterwards.

## 2. Extraction protocol

For each paper, in this order:

1. **Identity** — title, authors, institution, **venue and review status** (NeurIPS/Nature vs arXiv
   preprint vs corporate blog), DOI or URL, publication date, and version (`v1` vs `v3` can be a
   different paper).
2. **Claim** — what is asserted, stated as one falsifiable sentence. What is the baseline it beats?
3. **Method** — dataset (public or proprietary?), sample size, how the comparison was run, what
   hardware/model/config.
4. **Ablation** — did they show the proposed component *caused* the improvement, or only that the
   whole system scores higher? No ablation means the mechanism is unproven, whatever the headline says.
5. **Reported limitations** — and the ones **not** reported that the method obviously has.

## 3. The four questions that catch most bad claims

- **Is the baseline current and tuned?** Beating a weak or stale baseline is the most common way a
  result looks larger than it is.
- **Is the effect bigger than the variance?** Single-seed results, no error bars, no confidence
  interval → the number is an anecdote. For small N, an impressive percentage can be two examples.
- **Is the test set clean?** Contamination and train/test leakage invalidate the comparison entirely,
  and are rarely disclosed.
- **Who benefits?** Note commercial affiliation when a paper ranks its authors' product first. This
  is not disqualifying — it is a reason to look harder at the method section.

## 4. Preprint discipline

A preprint is **not peer-reviewed**. Treat its claims as provisional until either a review venue
accepts it or an independent party reproduces it. Say which of those happened.

Where a claim is load-bearing for a decision, hand it to `adversarial-fact-checker` — a paper is a
tier-1 source for *what its authors claim*, not automatically for *what is true*.

## 5. Output

```markdown
### <Tytuł> — <Autorzy>, <venue / preprint>, <YYYY-MM>
**Status:** peer-reviewed | preprint | corporate report · **Pewność:** wysoka | umiarkowana | niska

**Teza (1 zdanie):** …

| Wymiar | Wartość |
|---|---|
| Baseline | … |
| Dane | … (public / proprietary), N = … |
| Metryka | … |
| Wynik | … (± …, seeds: …) |
| Ablacja | tak / nie — co pokazała |

**Ograniczenia:** raportowane + zauważone.
**Implikacja praktyczna:** co to zmienia dla naszego systemu — albo „nic, na tym etapie".
**Źródło:** [DOI/URL] (odczytane YYYY-MM-DD)
```

The **practical implication** line is the point of the whole exercise. A literature review that ends
in a summary and not a decision was reading, not research.
