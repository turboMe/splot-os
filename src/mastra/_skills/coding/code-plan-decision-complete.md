---
name: code-plan-decision-complete
category: coding
description: >-
  Planning gate for code changes — a plan is done only when the executor has zero architectural,
  naming, or interface decisions left to make. Locks exact paths, exact signatures, known callers,
  the verification command, and explicit out-of-scope. Trigger before the first tracked write on
  any change touching more than one file or one contract.
keywords: [plan, decision-complete, implementation-plan, pre-execution, interface-contract, blast-radius, scope, delegation-brief]
allowedTools: [code_search, code_outline, repo_map, graphify_affected, coding_read_worktree_file, coding_worktree_diff, system_plan_task]
minComplexity: medium
recommendedTier: pro
estimatedTokens: 1700
outputFormat: markdown
tags: [coding, planning, architecture, contracts, delegation]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Decision-Complete Planning

## 1. The gate

A plan is **decision-complete** when the executor — a subagent, a worker, or you in ten steps' time —
makes **zero** decisions about architecture, naming, or interfaces while editing. Every remaining
choice was resolved by reading the code or by a stated assumption.

This matters more here than in a normal repo, because plans cross a process boundary: they become
`system_delegate_task` briefs and `system_run_worker` specs. A vague line in a plan is not a small
gap — it is a decision silently reassigned to an agent with less context than you have right now.

**"Implement appropriate error handling"** is not a plan step. It is a note that the planning is
unfinished.

## 2. The checklist — all seven, or it is not done

- [ ] **Exact paths.** Every file to be created or modified, by repo-relative path. No "the relevant config".
- [ ] **Exact signatures.** New or changed functions, types, and schema fields written out in full
      TypeScript. If the plan cannot state the type, the design is not settled.
- [ ] **Callers identified.** For every changed signature or return shape, the call sites found with
      `code_search` (or `graphify_affected`) and listed. Unknown blast radius = unfinished plan.
- [ ] **Every named file has been read.** `coding_read_worktree_file` / `code_outline`. Never put a
      file in a plan you have not opened — this is the single most common source of plans that
      dissolve on contact.
- [ ] **Flag / rollback stated.** How the change is turned off: feature flag, additive-only, or
      "revert the commit". New behaviour on a live path defaults to flag-gated and OFF.
- [ ] **Verification command written out.** The literal command, with its target. See §4.
- [ ] **Out of scope, explicitly.** What you are deliberately not touching, and why. This is what
      stops scope creep from being reinterpreted as initiative.

## 3. Plan shape

```markdown
# [Change title]

## 1. Problem
What is broken or missing, and the evidence for it (error text, failing check, file:line).

## 2. Decision
The approach chosen, in one paragraph — and the alternative rejected, in one sentence.
If a flag gates this: FEATURE_X, default OFF.

## 3. Changes

### [MODIFY] src/mastra/services/foo.ts:88-104
- Current behaviour: returns `null` when the lane is missing.
- New behaviour: throws `LaneNotFoundError`.
- Contract:
  ```typescript
  export function resolveLane(id: string, opts?: { allowMissing?: boolean }): Lane;
  ```
- Callers (verified with `code_search "resolveLane"`):
  - `src/mastra/tools/system/run-worker.ts:240` — wraps in try/catch, no change needed.
  - `src/mastra/orchestration/dispatch.ts:117` — relies on the `null` return. **Must be updated in this change.**

### [NEW] src/mastra/services/lane-errors.ts
- Purpose: the error class above. ~15 lines, no dependencies.

## 4. Verification
```bash
npm run check:coding-domain
npm run check:all
```
Expected: both green. `check:all` is the full gate (~39 s, not minutes).

## 5. Out of scope
- The legacy `dispatchV1` path — it is scheduled for removal and reads lanes differently.
- Any reformatting of touched files beyond the changed lines.
```

## 4. Verification is a command, not an intention

Name the narrowest gate that would actually fail if the change is wrong, then the broad one:

- domain gates: `npm run check:coding-domain`, `check:orchestration-contracts`, `check:transient-skill-shelf`, …
- full gate: `npm run check:all` (`bash scripts/check-all.sh`)
- build-shaped risk: `npm run build` — some failures only appear in the bundle, never in dev

Two traps worth planning around:

1. **`check:all` runs under `set -e`.** One failing probe kills every later check, so a green run
   after a red one is not proof the middle was ever reached — read which check reported last.
2. **A fresh worktree has no `node_modules`.** Plan the install step, or plan to run the gate in the
   main checkout.

## 5. Two rules about the diff itself

- **Blast radius is the plan's business.** Change only the lines the plan names. Reformatting,
  renaming, and drive-by cleanups in touched files are separate work — they hide the real change
  from review and from `git blame`.
- **Match the surrounding code.** This codebase deliberately carries *why*-comments recording
  decisions and traps (see the header comments in `pipeline-phase-tools.ts` or `analytics-agent.ts`).
  Follow local density: do not strip existing explanatory comments, and do not add narration of
  *what* the code does.

## 6. Stop conditions

Stop planning and ask when — and only when — the answer changes the design and is not discoverable:

- two mutually exclusive architectures are both defensible (state both, recommend one);
- the change is destructive, paid, or externally visible;
- a business rule is required that exists nowhere in the code.

Everything else — paths, schemas, existing conventions, flags, ports, current state — is
**discoverable**. Reading is faster than asking, and asking about a discoverable fact spends the
human's attention on something a `code_search` would have answered.
