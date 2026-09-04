---
name: agentic-actions-auditor
category: security
description: >-
  Audit CI/CD pipelines and agentic workflows for security vulnerabilities
  including prompt injection vectors, permission escalation, secrets exposure,
  and supply chain attack patterns. Use when reviewing GitHub Actions, GitLab CI,
  or any AI-driven automation pipeline for security risks.
keywords: [security, audit, cicd, github-actions, prompt-injection, supply-chain, pipeline]
allowedTools: [fs_read_file, shell_execute, search_content]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 800
outputFormat: text
tags: [security, audit, cicd, agentic]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Agentic Actions Auditor

> Adapted from [TrailOfBits](https://github.com/trailofbits/skills) (Apache-2.0).

## Trigger
Review CI/CD workflows for security vulnerabilities, especially those invoking
AI coding agents (Claude Code Action, Gemini CLI, OpenAI Codex).

## Procedure

### Step 1: Discover workflow files
```bash
find .github/workflows -name "*.yml" -o -name "*.yaml" 2>/dev/null
```

### Step 2: Identify AI action steps

Scan `uses:` fields for known AI actions:

| Action Reference | Type |
|-----------------|------|
| `anthropics/claude-code-action` | Claude |
| `google-github-actions/run-gemini-cli` | Gemini |
| `openai/codex-action` | Codex |
| `actions/ai-inference` | GitHub AI |

```bash
grep -rn "claude-code-action\|run-gemini-cli\|codex-action\|ai-inference" .github/workflows/
```

### Step 3: Capture security context

For each AI step, record:
- **`prompt`** field content and any `${{ }}` expressions
- **`env:` blocks** — check for `${{ github.event.* }}` values
- **Trigger events** — flag `pull_request_target`, `issue_comment`, `issues`
- **Permissions** — flag broad `contents: write`
- **Sandbox settings** — flag `danger-full-access`, `--yolo`, `unsafe`
- **User allowlists** — flag wildcard `"*"`

### Step 4: Detect attack vectors

**Vector A — Env Var Intermediary:**
`env:` block captures `${{ github.event.* }}` → prompt reads that env var.
YAML looks clean but AI receives attacker input at runtime.

**Vector B — Direct Expression Injection:**
`${{ github.event.* }}` directly inside `prompt` field.

**Vector C — CLI Data Fetch:**
Prompt instructs AI to run `gh issue view` / `gh pr view` fetching attacker content.

**Vector D — PR Target + Checkout:**
`pull_request_target` + checkout of PR head = runs attacker code with secrets.

**Vector E — Error Log Injection:**
CI logs or `workflow_dispatch` inputs passed to AI prompt.

**Vector F — Subshell Expansion:**
Tool allowlist includes commands supporting `$()` (e.g., `echo $(env)`).

**Vector G — Eval of AI Output:**
`eval`/`$()` in `run:` step consuming `steps.*.outputs.*`.

**Vector H — Dangerous Sandbox:**
`danger-full-access`, `Bash(*)`, `--yolo`, `safety-strategy: unsafe`.

**Vector I — Wildcard Allowlists:**
`allowed_non_write_users: "*"` or `allow-users: "*"`.

### Step 5: Severity assessment

| Factor | Raises | Lowers |
|--------|--------|--------|
| Trigger | `pull_request_target` | `push`, `workflow_dispatch` |
| Sandbox | `danger-full-access` | Restrictive defaults |
| Allowlist | Wildcard `"*"` | Named users |
| Data flow | Direct (B) | Indirect multi-hop (A,C,E) |
| Permissions | `contents: write` | Read-only |

Vectors H/I without co-occurring injection (A-G) = Info/Low.

### Step 6: Report format

```
### [Vector Name]
- Severity: High/Medium/Low/Info
- File: .github/workflows/review.yml
- Impact: What attacker achieves
- Evidence: YAML snippet
- Data Flow: numbered steps from attacker input to AI agent
- Remediation: specific fix
```

Summary: "Analyzed X workflows, Y AI instances. Found Z findings."

## Success criteria
- All `.github/workflows/` files scanned
- All AI action instances cataloged
- Each vector (A-I) checked
- Findings include remediation
- No false positives (config weaknesses without injection = Info)
