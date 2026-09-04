#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  ⏪ rollback-to-stable — przywraca poprzedni Live z backupu
#
#  Użycie:
#    rollback-to-stable.sh [rollback_dir]     (domyślnie .deploy/rollback/latest)
#
#  Zasada nadrzędna: rollback NIE zależy od LLM/Mastry/Mongo. Operuje na
#  gotowym backupie (output + .deploy-version + .live-dir) zrobionym przed swapem.
#
#  Idempotentne: zabija cokolwiek trzyma LIVE_PORT i startuje stabilny output.
#
#  Kod wyjścia: 0 = przywrócono i zdrowy, 1 = brak backupu, 2 = wstał ale unhealthy.
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="ROLLBACK"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_deploy_config
validate_observability_paths

RB_DIR="${1:-$DEPLOY_DIR/rollback/latest}"
[ -d "$RB_DIR" ] || { err "Brak katalogu backupu: $RB_DIR"; exit 1; }
[ -f "$RB_DIR/output/index.mjs" ] || { err "Backup bez output/index.mjs: $RB_DIR"; exit 1; }

RB_VERSION="$(cat "$RB_DIR/.deploy-version" 2>/dev/null || echo unknown)"
RB_DIR_SRC="$(cat "$RB_DIR/.live-dir" 2>/dev/null || echo "$SOURCE_DIR")"
RB_SLOT="$(cat "$RB_DIR/.live-slot" 2>/dev/null || echo source)"

# Stary output może pochodzić ze slotu z nieaktualnym `.env`. Przed startem
# synchronizujemy go z kanonicznym source; kod pozostaje rollbackowany, sekrety
# i flagi operacyjne pozostają aktualne.
if [ "$(readlink -m -- "$RB_DIR_SRC")" != "$(readlink -m -- "$SOURCE_DIR")" ]; then
  sync_runtime_env "$SOURCE_DIR/.env" "$RB_DIR_SRC/.env" \
    || { err "Synchronizacja .env dla rollbacku nie powiodła się."; exit 1; }
fi

log "Rollback → wersja $RB_VERSION (slot=$RB_SLOT) z $RB_DIR"

# ── Zatrzymaj cokolwiek trzyma Live ──
CUR="$(cat "$DEPLOY_DIR/slot-a.pid" 2>/dev/null || echo "")"
[ -z "$CUR" ] && CUR="$(pid_on_port "$LIVE_PORT")"
if pid_alive "$CUR"; then
  warn "Zatrzymuję obecny Live (PID $CUR)…"
  kill "$CUR" 2>/dev/null || true
  for _ in $(seq 1 10); do pid_alive "$CUR" || break; sleep 1; done
  kill -9 "$CUR" 2>/dev/null || true
fi
ORPH="$(pid_on_port "$LIVE_PORT")"
[ -n "$ORPH" ] && { kill "$ORPH" 2>/dev/null || true; sleep 1; }

# ── Start stabilnego output na Live ──
mkdir -p "$DEPLOY_DIR/logs"
LOGF="$DEPLOY_DIR/logs/rollback-$(date '+%Y%m%d-%H%M%S').log"
log "Start stabilnego output na :$LIVE_PORT…"
mkdir -p "$(dirname "$LIVE_OBSERVABILITY_PATH")"
(
  cd "$RB_DIR_SRC" 2>/dev/null || cd "$SOURCE_DIR"
  load_node
  PORT="$LIVE_PORT" DEPLOY_SLOT=A MASTRA_DUCKDB_PATH="$LIVE_OBSERVABILITY_PATH" \
    node "$RB_DIR/output/index.mjs" > "$LOGF" 2>&1 &
  echo $! > "$DEPLOY_DIR/slot-a.pid"
)
RP="$(cat "$DEPLOY_DIR/slot-a.pid" 2>/dev/null || echo "")"

if wait_ready "$LIVE_PORT" 30 "$HEALTH_INTERVAL"; then
  state_merge "{\"activeSlot\":\"$RB_SLOT\",\"activePid\":${RP:-null},\"activePort\":$LIVE_PORT,\"stableCommit\":\"$RB_VERSION\",\"candidateCommit\":null,\"rollbackDeadline\":null,\"state\":\"stable\"}"
  ok "Rollback OK — Live :$LIVE_PORT na $RB_VERSION, PID=$RP."
  exit 0
fi

err "Przywrócony Live nie osiągnął readiness HTTP + observability — krytyczne."
state_merge "{\"state\":\"rollback_failed\"}"
exit 2
