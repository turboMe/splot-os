---
name: performance-profiling
category: coding
description: >-
  Deep performance-review methodology: use to identify hot paths, reason about
  algorithmic complexity, spot N+1 / blocking I/O / allocation pressure, and
  separate real regressions from premature micro-optimization.
keywords: [performance, profiling, latency, complexity, n+1, hot-path, throughput, memory, optimization, scalability]
allowedTools: [coding_worktree_diff, coding_read_worktree_file, code_search, coding_run_test]
minComplexity: complex
recommendedTier: pro
estimatedTokens: 800
outputFormat: text
tags: [performance, profiling, optimization, review]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Performance Profiling — Deep Review Methodology

## Trigger
A change is performance-sensitive: it sits on a request/render hot path, processes
collections at scale, touches the database, or a reviewer suspects a regression in
latency, throughput, or memory.

## Guiding principle
**Profile before optimizing.** Reason from where time and memory actually go, not from
aesthetics. A clever micro-optimization off the hot path is noise; an O(n²) loop on a
request path is a bug. Optimize the path that runs most, on the data that grows largest.

## Procedure
1. Read the diff. Locate the **hot path**: which changed code runs per-request, per-item,
   per-frame, or in a tight/worker loop? Ignore cold one-off init code.
2. For each hot-path hunk, evaluate the analysis dimensions below.
3. Estimate scale: how big does `n` (input size, collection length, fan-out) realistically get?
   A pattern that is fine at n=10 may be fatal at n=10⁵.
4. Where a benchmark or test exists, run it (`coding_run_test`) to confirm rather than guess.
5. Report findings; reserve a blocking verdict for *real* regressions, not style.

## Analysis dimensions

| Dimension | What to look for | Typical fix |
|---|---|---|
| **Algorithmic complexity** | nested loops over the same data (O(n²)), repeated linear scans | `Map`/`Set` index, single pass, precompute |
| **N+1 / chatty I/O** | DB/API/file call inside a loop | batch query (`$in`), `Promise.all`, dataloader |
| **Blocking the event loop** | sync I/O, heavy regex / JSON on large input in the hot path | async API, stream, move off hot path, worker |
| **Sequential awaits** | independent `await`s one after another in a loop | `Promise.all` to parallelize |
| **Allocation / GC pressure** | per-iteration object/array/closure churn, big intermediate copies | reuse buffers, avoid needless `.map().filter()` chains, stream |
| **Missing DB index** | new query filter/sort on an unindexed field | add compound index matching the query shape |
| **Cache opportunity** | recomputing a pure, expensive result repeatedly | memoize / cache with sane invalidation |
| **Unbounded growth** | unbounded array/Map/cache, no TTL or cap | cap size, ring buffer, TTL |
| **Over-fetching** | selecting/returning far more data than used | project fields, paginate |

## What is NOT a finding
- Micro-optimizations off the hot path (string concat style, `for` vs `forEach` on tiny arrays).
- Theoretical scaling concerns for code that provably runs on small, bounded inputs.
- Readability trade-offs that buy negligible speed — note as 🟡 at most.

## Output (text)
```
### ✅ Strengths
- Performance-positive aspects (e.g. proper batching, indexed query)

### 🔴 Critical (blocking)
- [file:line] regression → **impact:** <latency/throughput/memory at what scale> → **fix:** <concrete>

### 🟡 Suggestions (non-blocking)
- [file:line] optimization worth doing but not blocking

### 📊 Summary
- Hot path affected: yes | no
- Worst-case complexity: O(...)
- Risk level: low | medium | high
```

## Verdict guidance
- A measurable regression on a real hot path (N+1, O(n²) at scale, blocking I/O) → blocking 🔴.
- Off-path or small-bounded-input concerns → 🟡, never block.
- Always cite `file:line`, name the scale at which it hurts, and give a concrete fix.
