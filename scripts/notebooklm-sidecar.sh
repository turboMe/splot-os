#!/usr/bin/env bash
# NotebookLM MCP Sidecar Launcher
# This script manages Xvfb and the NotebookLM MCP server for use as a background service.

set -euo pipefail

PROJECT_ROOT="/projekty/mastra-agentic-environment/agentic-agents"
PROFILE_DIR="${PROJECT_ROOT}/chrome_profile_notebooklm"
CONFIG_FILE="${PROJECT_ROOT}/notebooklm-config.json"

# 1. Clean up stale Chrome processes and locks
if pgrep -f "user-data-dir=${PROFILE_DIR}" >/dev/null 2>&1; then
  echo "[notebooklm-sidecar] Killing stale Chrome processes..."
  pkill -f "user-data-dir=${PROFILE_DIR}" || true
  sleep 1
  pkill -9 -f "user-data-dir=${PROFILE_DIR}" || true
fi

if [ -d "${PROFILE_DIR}" ]; then
  rm -f "${PROFILE_DIR}/SingletonLock" \
        "${PROFILE_DIR}/SingletonCookie" \
        "${PROFILE_DIR}/SingletonSocket" 2>/dev/null || true
fi

# 2. Start or reuse Xvfb on display :99
if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
  echo "[notebooklm-sidecar] Starting Xvfb on :99..."
  Xvfb :99 -screen 0 1280x1024x24 &
  XVFB_PID=$!
  sleep 1
else
  echo "[notebooklm-sidecar] Xvfb already running on :99"
fi

export DISPLAY=:99

# Ensure Chrome and Xvfb die when this script is killed
trap 'echo "Stopping sidecar..."; pkill -f "user-data-dir=${PROFILE_DIR}" || true; [ -n "${XVFB_PID:-}" ] && kill $XVFB_PID || true' EXIT SIGTERM SIGINT

# 3. Start NotebookLM MCP server over SSE
cd "${PROJECT_ROOT}"

echo "[notebooklm-sidecar] Starting NotebookLM MCP Server on http://127.0.0.1:8765/sse"
exec uvx --with undetected-chromedriver --with "setuptools<70" \
  --from notebooklm-mcp-cli notebooklm-mcp \
  --transport sse --host 127.0.0.1 --port 8765
