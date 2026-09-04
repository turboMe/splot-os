#!/usr/bin/env bash
# Etap 8 — refresh the Graphify code graph after code changes.
# Fail-soft by design: NEVER blocks a commit/merge. Skips silently when the
# CLI or the initial graph is absent (first build is manual: npm run graph:build).
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR" || exit 0

# Resolve the graphify binary: env → .env → persistent venv → PATH.
BIN="${GRAPHIFY_BIN:-}"
[ -z "$BIN" ] && [ -f .env ] && BIN="$(grep -E '^GRAPHIFY_BIN=' .env | tail -1 | cut -d= -f2-)"
[ -z "$BIN" ] && [ -x "$HOME/.venvs/graphify/bin/graphify" ] && BIN="$HOME/.venvs/graphify/bin/graphify"
[ -z "$BIN" ] && command -v graphify >/dev/null 2>&1 && BIN="graphify"
[ -z "$BIN" ] && exit 0                                   # no graphify → skip

"$BIN" --version >/dev/null 2>&1 || exit 0                # not runnable → skip
[ -f src/mastra/graphify-out/graph.json ] || exit 0       # no graph yet → skip (manual first build)

mkdir -p .mastra
# Incremental, code-only, detached — must not delay the git operation.
# After graph update, extracts lightweight trend summary to trend.jsonl and prunes old snapshots.
(
  "$BIN" update src/mastra >> .mastra/graph-refresh.log 2>&1
  bash "$SCRIPT_DIR/with-node.sh" npx tsx src/mastra/scripts/graph-trend-step.ts >> .mastra/graph-refresh.log 2>&1
) & >/dev/null 2>&1
exit 0
