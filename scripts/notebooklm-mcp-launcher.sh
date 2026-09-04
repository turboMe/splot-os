#!/usr/bin/env bash
# notebooklm-mcp launcher — auto-cleanup + headless server start.
#
# Powód: notebooklm-mcp używa Selenium + Chrome z profilem zapisanym w
# chrome_profile_notebooklm/. Chrome jest paranoidalny o single-instance per
# profile — jeśli poprzednia instancja nie zamknie się czysto (Ctrl+C, crash,
# user otworzył Chrome ręcznie z tym profilem), zostają lock files
# (SingletonLock/SingletonCookie/SingletonSocket) i nowa instancja nie wstanie.
#
# Ten skrypt:
#   1. Zabija żywe Chrome procesy używające naszego profilu
#   2. Usuwa lock files (są bezpieczne do usunięcia gdy Chrome nie żyje)
#   3. Uruchamia notebooklm-mcp server w trybie headless
#
# Uruchamiany przez Mastra MCPClient (zdefiniowany w src/mastra/mcp.ts).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${PROJECT_ROOT}/chrome_profile_notebooklm"

# ── 1. Kill wiszące Chrome procesy z naszego profilu ─────────────────────────
# pgrep -f matchuje pełną command line; nasz profile ma unikalną nazwę.
if pgrep -f "user-data-dir=${PROFILE_DIR}" >/dev/null 2>&1; then
  echo "[notebooklm-launcher] killing stale Chrome processes using ${PROFILE_DIR}" >&2
  pkill -f "user-data-dir=${PROFILE_DIR}" || true
  # Daj im chwilę na czysty exit przed force kill
  sleep 1
  pkill -9 -f "user-data-dir=${PROFILE_DIR}" || true
fi

# ── 2. Usuń lock files (Singleton*) ──────────────────────────────────────────
# Te są symlinkami do PID-ów / sockets. Zostają po brudnym shutdown.
if [ -d "${PROFILE_DIR}" ]; then
  rm -f "${PROFILE_DIR}/SingletonLock" \
        "${PROFILE_DIR}/SingletonCookie" \
        "${PROFILE_DIR}/SingletonSocket" 2>/dev/null || true
fi

# ── 3. Odpal notebooklm-mcp server (headless) ────────────────────────────────
# CWD + explicit -c <abs_path> żeby notebooklm-mcp NA PEWNO znalazł nasz config
# (Mastra child processes mogą startować z innego CWD; bez -c serwer robił
# defaults i tworzył pusty profile w src/mastra/public/chrome_profile_notebooklm).
cd "${PROJECT_ROOT}"
exec uvx --with undetected-chromedriver --with "setuptools<70" \
  --from notebooklm-mcp notebooklm-mcp \
  -c "${PROJECT_ROOT}/notebooklm-config.json" \
  server --headless
