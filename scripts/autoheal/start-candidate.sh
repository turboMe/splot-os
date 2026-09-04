#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  ▶️  start-candidate — uruchamia zbudowany slot na zadanym porcie
#
#  Użycie:
#    start-candidate.sh <slot> [port]
#      slot: slot-a | slot-b
#      port: domyślnie STAGING_PORT z configu (zwykle 4222)
#
#  Idempotentne: jeśli slot ma żywy proces (pidfile) — najpierw go ubija,
#  potem startuje świeży. Zabija TYLKO własny pid slotu (nie cudzy port).
#
#  Kod wyjścia: 0 = wystartowany (PID w pidfile), 1 = błąd.
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="START"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_deploy_config
validate_observability_paths

SLOT="${1:-}"
PORT="${2:-$STAGING_PORT}"
case "$SLOT" in slot-a|slot-b) ;; *) err "Użycie: start-candidate.sh <slot-a|slot-b> [port]"; exit 1 ;; esac

SLOT_DIR="$(slot_dir "$SLOT")"
LETTER="$(slot_letter "$SLOT")"
PIDFILE="$(slot_pidfile "$SLOT")"

sync_runtime_env "$SOURCE_DIR/.env" "$SLOT_DIR/.env" \
  || { err "Synchronizacja .env do $SLOT nie powiodła się."; exit 1; }

[ -f "$SLOT_DIR/.mastra/output/index.mjs" ] || { err "Slot $SLOT nie zbudowany (brak output). Najpierw build-candidate."; exit 1; }

# ── Ubij poprzedni proces TEGO slotu (idempotencja) ──
if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null || echo "")"
  if pid_alive "$OLD"; then
    warn "Ubijam poprzedni proces slotu $SLOT (PID $OLD)…"
    kill "$OLD" 2>/dev/null || true
    for _ in $(seq 1 10); do pid_alive "$OLD" || break; sleep 1; done
    kill -9 "$OLD" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

mkdir -p "$DEPLOY_DIR/logs"
LOGF="$DEPLOY_DIR/logs/${SLOT}-$(date '+%Y%m%d-%H%M%S').log"

log "Start slotu $SLOT (DEPLOY_SLOT=$LETTER) na :$PORT z izolowanym observability=$CANDIDATE_OBSERVABILITY_PATH…"
(
  cd "$SLOT_DIR"
  load_node
  PORT="$PORT" DEPLOY_SLOT="$LETTER" MASTRA_DUCKDB_PATH="$CANDIDATE_OBSERVABILITY_PATH" \
    node .mastra/output/index.mjs > "$LOGF" 2>&1 &
  echo $! > "$PIDFILE"
)
NEWPID="$(cat "$PIDFILE" 2>/dev/null || echo "")"
[ -n "$NEWPID" ] || { err "Nie udało się zapisać PID."; exit 1; }

ok "Slot $SLOT wystartował: PID=$NEWPID :$PORT  log=$LOGF"
exit 0
