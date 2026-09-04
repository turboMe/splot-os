#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_VERSION="$(tr -d '[:space:]' < "$PROJECT_DIR/.nvmrc")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  if ! nvm use --silent "$NODE_VERSION" >/dev/null; then
    echo "Required Node version $NODE_VERSION is not installed. Run: nvm install $NODE_VERSION" >&2
    exit 1
  fi
else
  echo "nvm not found at $NVM_DIR/nvm.sh; using PATH node: $(command -v node || echo missing)" >&2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not available after environment setup." >&2
  exit 1
fi

ACTUAL_VERSION="$(node -p "process.versions.node")"
node -e "
const actual = process.versions.node.split('.').map(Number);
const required = '22.13.0'.split('.').map(Number);
const ok = actual[0] > required[0] ||
  (actual[0] === required[0] && (actual[1] > required[1] ||
  (actual[1] === required[1] && actual[2] >= required[2])));
if (!ok) {
  console.error('Node >=22.13.0 is required, got v' + process.versions.node);
  process.exit(1);
}
"

if [ "$#" -eq 0 ]; then
  echo "Node v$ACTUAL_VERSION"
  exit 0
fi

exec "$@"
