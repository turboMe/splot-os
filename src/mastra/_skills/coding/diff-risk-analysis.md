---
name: diff-risk-analysis
category: coding
description: Fast pre-review risk triage of a diff. Classifies a change by risk signals (auth, DB migrations, removed validation, hot-path, blast radius) so the reviewer knows what to inspect first and how deep to go.
keywords: [diff, risk, triage, blast-radius, review, migration, hot-path, regression, change-scope]
allowedTools: [coding_worktree_diff, coding_read_worktree_file, search_content]
minComplexity: medium
recommendedTier: pro
estimatedTokens: 750
outputFormat: text
tags: [review, risk, triage, change-analysis]
version: 1
success_rate: 1
total_uses: 1
last_used: 2026-08-18
handoffCapable: true
---
# Diff Risk Analysis — Pre-Review Triage

## Trigger
A reviewer faces a medium/high-complexity diff and needs to prioritize: which
hunks are dangerous, how wide is the blast radius, and where to spend attention
before running the full security/performance/test checklists.

## Procedure
1. Read the diff (`coding_worktree_diff`). For each changed file, score the risk signals below.
2. Compute a **blast radius**: how many other modules import or depend on the touched code.
   Use `search_content` for the changed symbol/file name to count importers.
3. Produce a triage verdict: an ordered list of hotspots, highest risk first.
4. Hand the hotspots to the appropriate deep checklist (security / performance / tests).

## Risk signal table

| Category | Pattern in the diff | Risk | Inspect for |
|---|---|:--:|---|
| **Auth / access** | touches login, session, token, role, permission, middleware guards | high | privilege escalation, missing authz, weakened checks |
| **Removed validation** | deleted `if (!…) throw`, removed zod/schema parse, loosened type | high | unchecked external input now flowing downstream |
| **DB schema / migration** | altered schema, index, migration, collection shape | high | data loss, irreversible change, lock on large table |
| **Process / exec** | new `child_process`, `exec`, `eval`, `Function(`, deserialization | high | RCE / injection on user-derived data |
| **Hot path** | edits inside request handler, render loop, tight loop, worker tick | medium | added latency, N+1, blocking I/O |
| **Concurrency** | new async ordering, shared state, locks, timers, intervals | medium | races, leaks, overlapping runs |
| **External I/O** | new fetch/HTTP target, file path from input, SSRF surface | medium | SSRF, path traversal, untrusted egress |
| **Wide blast radius** | changed symbol imported by many modules | medium | ripple regressions in untouched callers |
| **Error handling** | removed try/catch, swallowed errors, changed throw behavior | low-med | silent failure, masked regressions |
| **Pure additive** | new isolated file, no edits to existing callers | low | scope creep only |

## Blast radius heuristic
- **low** — change is local; few or no external importers of the touched symbol.
- **medium** — touched code is imported by a handful of modules in the same area.
- **high** — shared util / core type / widely-imported module; a regression ripples broadly.

## Output (text)
```
## Risk triage
- Overall risk: low | medium | high
- Blast radius: low | medium | high

### Hotspots (highest first)
1. [file:line] <category> — <why it's risky> → route to: security | performance | tests
2. [file:line] ...

### Safe-ish
- [file] additive / isolated, light-touch review enough
```

## Rules
- This is triage, not the full review — it tells you *where to look*, it does not issue the verdict.
- Never downgrade a high-risk category just because the diff is small; a one-line auth change is still high.
- If nothing matches the high/medium signals, say so plainly and let the reviewer proceed lightweight.
