#!/usr/bin/env bash
# Universal Scheduled Task Runner supervisor.
#
# Usage:
#   bash scripts/scheduled-task-runner-supervisor.sh
#   bash scripts/scheduled-task-runner-supervisor.sh --once
#   bash scripts/scheduled-task-runner-supervisor.sh --status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="${SCHEDULED_TASK_SUPERVISOR_DIR:-$REPO_DIR/../.deploy}"
PID_FILE="${SCHEDULED_TASK_SUPERVISOR_PID_FILE:-$DEPLOY_DIR/scheduled-task-runner-supervisor.pid}"
INTERVAL="${SCHEDULED_TASK_SUPERVISOR_RESTART_SECONDS:-5}"

mode="${1:-loop}"

mkdir -p "$DEPLOY_DIR"

status() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "{\"running\":true,\"pid\":$pid,\"pidFile\":\"$PID_FILE\"}"
      return 0
    fi
  fi
  echo "{\"running\":false,\"pidFile\":\"$PID_FILE\"}"
}

run_once() {
  cd "$REPO_DIR"
  SCHEDULED_TASK_RUNNER_ONCE=1 npm run scheduled-tasks
}

run_loop() {
  echo "$$" > "$PID_FILE"
  trap 'rm -f "$PID_FILE"; exit 0' INT TERM EXIT
  cd "$REPO_DIR"
  echo "[scheduled-task-supervisor] started pid=$$"
  while true; do
    set +e
    npm run scheduled-tasks
    code=$?
    set -e
    echo "[scheduled-task-supervisor] runner exited code=$code; restart in ${INTERVAL}s"
    sleep "$INTERVAL"
  done
}

case "$mode" in
  --once) run_once ;;
  --status) status ;;
  ""|loop) run_loop ;;
  *)
    echo "Unknown mode: $mode" >&2
    exit 2
    ;;
esac
