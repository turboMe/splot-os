---
name: cli-creator
category: coding
description: "Build a composable CLI from API docs, an OpenAPI spec, existing curl examples, an SDK, a web app, or a local script. Use when the user wants to create a command-line tool that can run from any repo, expose composable read/write commands, return stable JSON, manage auth, and pair with a companion skill."
keywords: [cli, command-line, tool, create, build, rust, typescript, python, argparse, clap]
source: openai/skills
recommendedTier: pro
handoffCapable: true
---

# CLI Creator

Create a real CLI that future agent threads can run by command name from any working directory.
This skill is for durable tools, not one-off scripts.

## Start

Name the target tool, its source, and the first real jobs it should do:

- Source: API docs, OpenAPI JSON, SDK docs, curl examples, browser app, existing internal script.
- Jobs: literal reads/writes such as `list drafts`, `download failed job logs`, `search messages`.
- Install name: a short binary name such as `ci-logs`, `slack-cli`, `sentry-cli`.

Before scaffolding, check whether the proposed command already exists:

```bash
command -v <tool-name> || true
```

## Choose the Runtime

Inspect the user's machine and source material:

```bash
command -v cargo rustc node pnpm npm python3 uv || true
```

- Default to **Rust** for a durable CLI: one fast binary, strong argument parsing, easy install.
- Use **TypeScript/Node** when the official SDK or auth helper is the reason the CLI can be better.
- Use **Python** when the source is data science, local file transforms, or Python-heavy admin tooling.

State the choice in one sentence before scaffolding.

## Command Contract

Build toward this surface:

- `tool-name --help` shows every major capability.
- `tool-name --json doctor` verifies config, auth, version, endpoint reachability.
- `tool-name init ...` stores local config when env-only auth is painful.
- Discovery commands find top-level containers (accounts, projects, repos).
- Resolve commands turn names/URLs/slugs into stable IDs.
- Read commands fetch objects and list/search collections with `--limit`.
- Write commands do one named action each, support `--dry-run`.
- `--json` returns stable machine-readable output.
- A raw escape hatch exists: `request`, `api`, etc.

For detailed composable CLI patterns, see `cli-creator-references/agent-cli-patterns.md`.

## Auth and Config

Support in this precedence order:

1. Environment variable using the service's standard name (e.g., `GITHUB_TOKEN`).
2. User config under `~/.<tool-name>/config.toml`.
3. `--api-key` flag only for explicit one-off tests.

Never print full tokens. `doctor --json` should report auth source and what's missing.

## Build Workflow

1. Read the source to inventory resources, auth, pagination, IDs, rate limits.
2. Sketch the command list in chat. Keep names short and shell-friendly.
3. Scaffold the CLI with a README.
4. Implement `doctor`, discovery, resolve, read commands, one write path.
5. Install on PATH so `tool-name ...` works outside the source folder.
6. Smoke test from another directory: `command -v <tool-name>`, `--help`, `--json doctor`.
7. Run format, typecheck/build, unit tests.

## Runtime Defaults

### Rust
- `clap` for commands, `reqwest` for HTTP, `serde`/`serde_json` for payloads, `toml` for config, `anyhow` for errors.
- Add `make install-local` target.

### TypeScript/Node
- `commander` or `cac` for commands, native `fetch` or official SDK for HTTP, `zod` only where needed.
- `package.json` `bin` entry + `pnpm link --global`.

### Python
- `argparse` or `typer` for commands, `requests`/`httpx` for HTTP, stdlib for local ops.
- `pyproject.toml` console script or wrapper for PATH.
