---
name: review-candidate-verification
category: coding
description: >-
  Second pass for code review — turns raw candidate findings into a verified set by ruling each one
  CONFIRMED, PLAUSIBLE or REFUTED against the code, with a strict bar for refuting. Cuts false
  positives without losing real bugs. Trigger after a review has produced findings and before they
  are reported or acted on.
keywords: [code-review, verification, false-positives, findings, confirmed-plausible-refuted, review-quality, triage]
allowedTools: [coding_worktree_diff, coding_read_worktree_file, code_search, code_outline, graphify_affected, coding_submit_review]
minComplexity: complex
recommendedTier: pro
estimatedTokens: 1700
outputFormat: markdown
tags: [coding, review, quality, verification, findings]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Review Pass 2 — Candidate Verification

Adapted from the Claude Code `code-review` skill. This is the **second** pass. The first pass (the
review agent's own procedure) produces candidates; this one decides which of them are real.

## 1. Why a second pass exists

A single-pass reviewer has to be both suspicious and cautious at the same time, and it cannot be
both. Loosen it and the report fills with speculation the author has to argue down; tighten it and
real bugs get self-censored as "probably intentional".

Splitting fixes that. **Pass 1 is recall-biased** — surface anything that could be wrong, cheaply.
**Pass 2 is precision-biased** — a separate look at each candidate, with the burden of proof on
*refuting*, not on keeping.

## 2. Input

A list of candidates, each with `file`, `line`, a one-sentence `summary`, and a concrete
`failure_scenario` (inputs/state → wrong output). A candidate without a failure scenario is not a
finding, it is an opinion — send it back or drop it.

First, **dedup**: same defect + same location + same mechanism → keep one, the clearest.

## 3. The ruling

For each surviving candidate, read the diff hunk, the enclosing function, and — when the claim is
about a caller or a contract — the other side. Then rule exactly one of:

### CONFIRMED
The failure is constructible from the code. You can name the input or state that triggers it and
trace it to the wrong result.

### PLAUSIBLE — this is the default
The mechanism is real and the state that triggers it is realistic, even if you cannot prove it
occurs today. **Do not refute a candidate for being "speculative" or "depending on runtime state"
when the state is realistic.** These are PLAUSIBLE, not REFUTED:

- concurrency and ordering races; two writers on one document
- `null`/`undefined` on a rare but reachable path — error handler, cold cache, absent optional field
- falsy-zero treated as missing (`if (count)` where `0` is meaningful)
- off-by-one at a boundary the code does not exclude
- retry storms, partial failure, a timeout that fires mid-commit
- a regex or allowlist that lost an anchor
- a fallback path that returns success with empty content while the caller reads stale state as fresh

### REFUTED — only with a construction
Refute only when you can *show* it, and show it in the ruling:

- **factually wrong** — quote the actual line that contradicts the candidate;
- **provably impossible** — a type, a constant, or an enforced invariant excludes it; cite it;
- **already handled in this diff** — cite the guard, by file and line;
- **pure style with no observable effect.**

"Looks fine to me", "the author probably meant it", and "unlikely in practice" are not refutations.
If that is all you have, the ruling is PLAUSIBLE.

**Keep CONFIRMED and PLAUSIBLE. Drop REFUTED.**

## 4. Scale the effort to the risk

Pair this with `diff-risk-analysis`: the triage verdict picks the depth.

| Diff risk | Pass 1 breadth | Pass 2 | Findings cap |
|---|---|---|---|
| low — docs, config, isolated addition | 2-3 angles | dedup only, keep CONFIRMED | 3 |
| medium — normal feature or fix | 4-6 angles | full ruling on each candidate | 6 |
| high — auth, migrations, removed validation, hot path, orchestration | 8 angles | full ruling, and re-read every caller of a changed signature | 10 |

Above the cap: keep the most severe and say how many were dropped. A report of thirty findings is a
report nobody finishes reading.

## 5. Conventions findings need a citation

A convention violation is reportable only when you can **quote the exact rule and the exact line that
breaks it** — from `CLAUDE.md`, `AGENTS.md`, an eslint config, or a stated repo standard. No style
preferences, no "spirit of the doc". In this repo that includes the inverse: **do not flag
explanatory `why`-comments as noise** — they are house style and carry decisions the code cannot.

## 6. Output

Ranked most-severe first, each carrying its ruling:

```markdown
### 🔴 Krytyczne
- `[CONFIRMED] src/mastra/services/dispatch.ts:117` — brak `await` na `submitAttemptResult()`.
  Scenariusz: dwa workery kończą w tym samym tiku → drugi zapis wygrywa, wynik pierwszego ginie bez błędu.
  Dowód: `dispatch.ts:117` wywołuje bez `await`, a `submitAttemptResult` zwraca `Promise<void>` (`orchestration/store.ts:88`).

### 🟡 Prawdopodobne
- `[PLAUSIBLE] src/mastra/tools/system/run-worker.ts:240` — `if (count)` traktuje `0` jak brak wartości.
  Scenariusz: pusty rejestr skilli → ścieżka fallbacku zamiast poprawnego "zero trafień".

### Odrzucone w weryfikacji
- ~~`lane-errors.ts:12` — nieobsłużony wyjątek~~ → REFUTED: `dispatch.ts:120` łapie i loguje.
```

Keeping the refuted list visible is deliberate — it tells the author what was examined, which a bare
short report cannot, and it stops the same candidate being re-raised next round.

## 7. Invariants

1. **Burden of proof is on refuting.** Ambiguity keeps a finding as PLAUSIBLE.
2. **Every kept finding has a failure scenario.** Concrete inputs or state → concrete wrong outcome.
3. **Every REFUTED ruling cites its construction.** A refutation without evidence is an opinion
   overruling a suspicion, and the suspicion was better supported.
4. **The verdict is not the deliverable — the findings are.** A blocking verdict with three vague
   items is worse than a clean pass with one sharp one.
