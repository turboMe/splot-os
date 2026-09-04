#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🔀 promote-candidate — kandydat (zbudowany slot) staje się Live :4111
#
#  Użycie:
#    promote-candidate.sh <slot>
#
#  Procedura (idempotentny krok blue-green):
#    1. Odczyt commita kandydata (slot/.deploy-version).
#    2. BACKUP aktualnego Live (output+version+.env+pid) → .deploy/rollback/<ts>
#       i symlink .deploy/rollback/latest  (umożliwia rollback bez LLM/Mongo).
#    3. Zapis pre-swap do stanu: previousSlot/previousPid/candidateCommit.
#    4. Zatrzymanie starego Live i startu kandydata na LIVE_PORT (DEPLOY_SLOT=A).
#    5. Post-swap verify. Gdy FAIL → automatyczny rollback-to-stable.
#
#  ❗ To krok AKTYWNEGO sterowania. Sam canary 60s + pełna macierz rollbacku =
#  Etap 5 (supervisor). Tu dostarczamy deterministyczny, testowalny building block.
#
#  Kod wyjścia: 0 = promote OK, 1 = rollback wykonany, 2 = brak backupu/krytyczne.
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="PROMOTE"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/lib.sh"
read_deploy_config
validate_observability_paths

SLOT="${1:-}"
case "$SLOT" in slot-a|slot-b) ;; *) err "Użycie: promote-candidate.sh <slot-a|slot-b>"; exit 1 ;; esac

SLOT_DIR="$(slot_dir "$SLOT")"
LETTER="$(slot_letter "$SLOT")"
PIDFILE="$(slot_pidfile "$SLOT")"
[ -f "$SLOT_DIR/.mastra/output/index.mjs" ] || { err "Slot $SLOT nie zbudowany."; exit 1; }
sync_runtime_env "$SOURCE_DIR/.env" "$SLOT_DIR/.env" \
  || { err "Synchronizacja .env do promowanego slotu nie powiodła się."; exit 1; }
COMMIT="$(cat "$SLOT_DIR/.deploy-version" 2>/dev/null || echo unknown)"

TS="$(date '+%Y-%m-%d_%H-%M-%S')"
ROLLBACK_DIR="$DEPLOY_DIR/rollback/$TS"
mkdir -p "$ROLLBACK_DIR"

# ── 2. Backup aktualnego Live ──
PREV_PID="$(cat "$DEPLOY_DIR/slot-a.pid" 2>/dev/null || echo "")"
[ -z "$PREV_PID" ] && PREV_PID="$(pid_on_port "$LIVE_PORT")"
PREV_VERSION="$(curl -sf --max-time 5 "http://localhost:${LIVE_PORT}/deploy/health" 2>/dev/null \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo unknown)"

log "Backup aktualnego Live (v=$PREV_VERSION, PID=${PREV_PID:-?}) → $ROLLBACK_DIR"
# Z którego katalogu działa obecny Live? Preferuj poprzedni slot runtime, fallback source.
PREV_SLOT="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('activeSlot',''))" 2>/dev/null || echo "")"
PREV_DIR=""
case "$PREV_SLOT" in slot-a|slot-b) PREV_DIR="$(slot_dir "$PREV_SLOT")" ;; esac
[ -z "$PREV_DIR" ] || [ ! -d "$PREV_DIR/.mastra/output" ] && PREV_DIR="$SOURCE_DIR"
if [ -d "$PREV_DIR/.mastra/output" ]; then
  cp -a "$PREV_DIR/.mastra/output" "$ROLLBACK_DIR/output"
fi
echo "$PREV_VERSION" > "$ROLLBACK_DIR/.deploy-version"
echo "$PREV_DIR"     > "$ROLLBACK_DIR/.live-dir"
echo "${PREV_SLOT:-source}" > "$ROLLBACK_DIR/.live-slot"
sync_runtime_env "$SOURCE_DIR/.env" "$ROLLBACK_DIR/.env" \
  || { err "Nie udało się zabezpieczyć .env dla rollbacku."; exit 2; }
ln -sfn "$ROLLBACK_DIR" "$DEPLOY_DIR/rollback/latest"
ok "Backup gotowy (rollback-to-stable może z niego wrócić)."

# ── 3. Pre-swap state ──
ROLLBACK_DEADLINE="$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=${AUTOHEAL_CANARY_SECONDS:-60})).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")"
state_merge "{\"candidateCommit\":\"$COMMIT\",\"previousSlot\":\"${PREV_SLOT:-source}\",\"previousPid\":${PREV_PID:-null},\"activePort\":$LIVE_PORT,\"rollbackDeadline\":\"$ROLLBACK_DEADLINE\",\"state\":\"promoting\"}"

# ── 4a. Zatrzymaj kandydata na porcie staging (przenosi się na Live) ──
if [ -f "$PIDFILE" ]; then
  CP="$(cat "$PIDFILE" 2>/dev/null || echo "")"
  if pid_alive "$CP"; then kill "$CP" 2>/dev/null || true; sleep 2; fi
  rm -f "$PIDFILE"
fi

# ── 4b. Zatrzymaj stary Live (graceful → force) ──
log "Zatrzymuję stary Live na :$LIVE_PORT…"
if pid_alive "$PREV_PID"; then
  kill "$PREV_PID" 2>/dev/null || true
  for _ in $(seq 1 10); do pid_alive "$PREV_PID" || break; sleep 1; done
  kill -9 "$PREV_PID" 2>/dev/null || true
fi
ORPH="$(pid_on_port "$LIVE_PORT")"
if [ -n "$ORPH" ]; then warn "Sprzątam sierotę na :$LIVE_PORT (PID $ORPH)"; kill "$ORPH" 2>/dev/null || true; sleep 1; fi

# ── 4c. Start kandydata na Live ──
mkdir -p "$DEPLOY_DIR/logs"
LOGF="$DEPLOY_DIR/logs/live-$TS.log"
mkdir -p "$(dirname "$LIVE_OBSERVABILITY_PATH")"
log "Start kandydata $SLOT na Live :$LIVE_PORT (DEPLOY_SLOT=A, observability=$LIVE_OBSERVABILITY_PATH)…"
(
  cd "$SLOT_DIR"; load_node
  # setsid + </dev/null detaches the new Live into its own session. In an autoheal
  # self-swap the whole deploy chain (Live → execSync deploy-blue-green →
  # run-deploy → this) descends from the OLD Live we just killed; without detach
  # the new Live is a grandchild of a dying process and gets torn down with it,
  # leaving :4111 empty. Detached, it outlives the swap that spawned it.
  PORT="$LIVE_PORT" DEPLOY_SLOT=A MASTRA_DUCKDB_PATH="$LIVE_OBSERVABILITY_PATH" \
    setsid node .mastra/output/index.mjs > "$LOGF" 2>&1 < /dev/null &
  echo $! > "$DEPLOY_DIR/slot-a.pid"
)
NEW_PID="$(cat "$DEPLOY_DIR/slot-a.pid" 2>/dev/null || echo "")"
log "Nowy Live PID=$NEW_PID"

# ── 5. Post-swap verify ──
if wait_ready "$LIVE_PORT" 30 "$HEALTH_INTERVAL"; then
  state_merge "{\"activeSlot\":\"$SLOT\",\"activePid\":${NEW_PID:-null},\"activePort\":$LIVE_PORT,\"state\":\"canary\"}"
  ok "Promote OK — kandydat $SLOT ($COMMIT) na Live :$LIVE_PORT, PID=$NEW_PID. (canary/mark = dalej)"
  exit 0
fi

err "Post-swap readiness FAIL (HTTP lub observability) — uruchamiam rollback-to-stable…"
kill "$NEW_PID" 2>/dev/null || true; sleep 2
if bash "$SELF_DIR/rollback-to-stable.sh"; then
  exit 1
else
  err "ROLLBACK także zawiódł — wymagana interwencja."
  exit 2
fi
