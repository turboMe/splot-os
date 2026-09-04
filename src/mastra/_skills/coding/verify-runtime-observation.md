---
name: verify-runtime-observation
category: coding
description: >-
  Verification by running the thing and watching it, not by running the gates. Establishes the
  change scope, finds the surface where it is observable, drives it, probes around it, and returns
  PASS/FAIL/BLOCKED/SKIP with captured evidence. Trigger before declaring any non-trivial change
  done, and before promoting a candidate.
keywords: [verification, runtime-observation, evidence, pass-fail, false-success, smoke-test, drive-the-app, proof]
allowedTools: [shell_execute, coding_worktree_diff, coding_read_worktree_file, coding_run_test, design_verify, artifact_put]
minComplexity: medium
recommendedTier: pro
estimatedTokens: 2000
outputFormat: markdown
tags: [coding, verification, qa, evidence, release]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---

# Verification = Runtime Observation

Adapted from the Claude Code `verify` skill for this runtime.

## 1. The premise

**Verification is running the thing and watching what it does.** You start it, drive it to where the
changed code executes, and capture what you saw. That capture is the evidence. Nothing else is.

**Running `check:all` is not verification.** Neither is `npm run build`, `coding_run_test`, or a
typecheck. They prove the gates run — the same thing they proved yesterday on unchanged code. They
are worth running; they are not this.

**Importing a function and calling it is not verification either.** You wrote a unit test inline. The
function did what you already knew it did from reading it. Whatever calls it in production ends at an
HTTP route, an agent step, a workflow trigger, or a rendered file. Go there.

This system's recorded failure mode is precisely the one this guards against: a run marked `tested`
because a mock returned; a scorer with its own definition of success reporting a pass; a header that
said one thing while the body said another. Every one of those would have survived a gate run and
none would have survived being watched.

## 2. Establish the scope

```bash
git log --oneline @{u}..            # how many commits are in play
git diff @{u}.. --stat              # the full range, not just HEAD~1
git diff HEAD --stat                # uncommitted working tree
```

Or `coding_worktree_diff` when the work is in a coding worktree. State the commit count.

**The diff is ground truth; the description is a claim about it.** Read both. If they disagree, that
is already a finding — report it whatever else happens.

## 3. Find the surface

The surface is where something — a person or another program — meets the change.

| Change reaches | Surface | How you observe it here |
|---|---|---|
| Agent prompt / instructions | the agent | `POST /api/agents/<id>/generate` with a real task — **`memory.thread` is required**, the call fails without it |
| Tool implementation | the tool's caller | drive an agent that holds the tool, or the `check:*` harness that exercises it end to end |
| Orchestration / durable job | the job | `orchestration_start_job` → `orchestration_get_job` until it settles; read the terminal state, not the acknowledgement |
| n8n workflow | n8n | `architect_test_workflow` (`mock` proves shape, **`real_credentials` proves execution** — say which you ran) |
| Design deliverable | pixels | `design_verify`, then look at the screenshot |
| Dashboard / analytics UI | the browser | headless `agent-browser` against the running instance; `npm run build` only for the typecheck half |
| CLI / script | the terminal | run it, capture stdout **and** the exit code |
| Service / API route | the socket | send the request, capture the response body |
| Build-shaped change | the bundle | `npm run build` then run from `.mastra/output` — dev-only success is a known failure class here |

**No runtime surface at all** — docs, comments, type-only declarations, a test file on its own —
report **SKIP**, one line, and do not run gates to fill the space.

## 4. Drive it

The shortest path that makes the changed lines execute:

- changed a flag → run with the flag on **and** off;
- changed a handler → hit that route;
- changed an error path → cause the error;
- changed a prompt rule → give the agent the input that rule exists for.

**Read your plan back before running it.** If every step is build / typecheck / gate, you have
planned a CI rerun. Find a step that reaches the surface, or report BLOCKED.

**Destructive path?** If the change touches code that deploys, sends, deletes, activates, or writes
outside the workspace and there is no mock or safe target — do not drive it live. Verify around it
and say plainly which path you did not exercise and why.

## 5. Probe around it

Confirming the claim is the first half. You are the only one who actually ran it, so what you noticed
is worth as much as the verdict.

- new flag → empty value, passed twice, conflicting combination, typo (does the error name it?)
- new route / tool input → wrong shape, missing required field, oversized payload
- changed error path → the *adjacent* errors it did not touch — did the refactor cover them too?
- state / persistence → do it twice; do it with stale state underneath; do it concurrently
- agent behaviour → the input that should make it refuse, and the one that should make it delegate

Mark probes `🔍`. **A step list that is all ✅ and no 🔍 is a happy-path replay** — still a PASS, but
you stopped halfway. A probe that finds nothing is still worth a line: it tells the author what was
covered.

## 6. Capture

Stdout, response bodies, screenshots, job documents, log excerpts. **Captured output is evidence;
your recollection is not.** Something unexpected — capture it, note it, then decide whether it is the
change or the environment. Unrelated breakage is a finding, not noise.

Isolate shared state: ports, tmux sessions, lock files, the Mongo database. You share a namespace
with a running system.

## 7. Report

```markdown
## Weryfikacja: <one line — what changed>

**Werdykt:** PASS | FAIL | BLOCKED | SKIP

**Twierdzenie:** <what it is supposed to do — your read of the diff, plus any mismatch with the description>

**Metoda:** <how you got a handle: what you started, against which surface>

### Kroki
1. ✅/❌/⚠️/🔍 <what you did to the running system> → <what it showed>
   <evidence: captured output, response body, screenshot ref>

**Dowód:** <the one capture a reviewer looks at>

### Obserwacje
<Anything that made you pause — friction, surprise, an odd default, a slow path.
Lead with ⚠️ for what is worth interrupting a reviewer for. Each probe gets a line even when it held.>
```

**Verdicts**

- **PASS** — you ran it and it did what it should, at its surface. Not: gates green, build clean, code looks right.
- **FAIL** — you ran it and it did not. Or it broke something else. Or diff and description disagree materially.
- **BLOCKED** — you could not reach a state where the change is observable. This is not a verdict on
  the change. Say exactly where it stopped.
- **SKIP** — no runtime surface exists. One line why.

**No partial pass.** "Three of four worked" is FAIL until the fourth passes or is explained away.

**When in doubt, FAIL.** A false PASS ships broken code and gets discovered in production. A false
FAIL costs one more look. The asymmetry is not close.
