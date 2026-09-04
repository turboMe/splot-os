#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🐤 canary-watch — agresywne okno obserwacji świeżo przełączonego Live (Etap 5.2)
#
#  Użycie:
#    canary-watch.sh <port> [seconds] [logfile]
#      port:    port świeżo przełączonego runtime (zwykle LIVE_PORT 4111)
#      seconds: długość canary (domyślnie AUTOHEAL_CANARY_SECONDS lub 60)
#      logfile: log procesu do skanu EADDRINUSE/crashu (domyślnie najnowszy live-*.log)
#
#  Sondy w każdym interwale (2–5s), każda jako twardy warunek:
#    1. /health        → success/ok
#    2. /deploy/health → success/ok (gdy endpoint istnieje; brak ≠ FAIL)
#    3. observability    → prawdziwy odczyt z DuckDB
#    4. PID na porcie ŻYJE
#    5. brak restart-loopu: PID na porcie NIE zmienia się między sondami
#    6. log nie zawiera EADDRINUSE / unhandledRejection / AMBIGUOUS od startu canary
#    7. brak eksplozji błędów w agent_events (BEST-EFFORT — Mongo down ≠ FAIL)
#
#  Zasada nadrzędna: canary NIE może zależeć od Mongo/LLM. Sonda Mongo jest
#  wyłącznie best-effort — jeśli Mongo nieosiągalny, sonda jest POMIJANA (nie FAIL).
#  Twarde sygnały (health/PID/log) są niezależne od Mastry-jako-aplikacji.
#
#  Kod wyjścia: 0 = przeżył całe okno zdrowy, 1 = wykryto awarię (caller → rollback).
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="CANARY"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/lib.sh"
read_deploy_config
validate_observability_paths

PORT="${1:-$LIVE_PORT}"
SECONDS_WINDOW="${2:-${AUTOHEAL_CANARY_SECONDS:-60}}"
LOGFILE="${3:-}"
[ -n "$PORT" ] || { err "Użycie: canary-watch.sh <port> [seconds] [logfile]"; exit 1; }

# Interwał sondy: agresywny 2–5s (z healthCheck.intervalMs, ograniczony do [2,5])
INTERVAL="${HEALTH_INTERVAL:-3}"
if ! [ "$INTERVAL" -ge 2 ] 2>/dev/null; then INTERVAL=2; fi
if [ "$INTERVAL" -gt 5 ] 2>/dev/null; then INTERVAL=5; fi

# Najnowszy log Live, jeśli nie podano (do skanu crashów)
if [ -z "$LOGFILE" ]; then
  LOGFILE="$(ls -t "$DEPLOY_DIR/logs/live-"*.log 2>/dev/null | head -n1 || echo "")"
fi

# Próg eksplozji błędów (z watchdog.maxErrorsBeforeRollback)
MAX_ERRORS="$(cfg "c['watchdog']['maxErrorsBeforeRollback']" 3)"
MONGO_DB="$(cfg "c['watchdog']['mongoDb']" agentforge)"
MONGO_COLL="$(cfg "c['watchdog']['mongoErrorCollection']" agent_events)"

START_PID="$(pid_on_port "$PORT")"
START_EPOCH="$(date +%s)"
SINCE_ISO="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"

log "═══ canary :$PORT — okno ${SECONDS_WINDOW}s, interwał ${INTERVAL}s, startPID=${START_PID:-?} ═══"
[ -n "$LOGFILE" ] && log "skan logu: $LOGFILE"

# ── Sonda Mongo (best-effort): liczba świeżych błędów runtime od startu canary ──
# Mongo nieosiągalny / brak mongosh → zwraca 0 (NIE blokuje canary).
mongo_error_count() {
  command -v mongosh >/dev/null 2>&1 || { echo 0; return; }
  local c
  c=$(mongosh --quiet --eval "
    db.getSiblingDB('$MONGO_DB').getCollection('$MONGO_COLL')
      .countDocuments({
        timestamp: { \$gte: new Date('$SINCE_ISO') },
        status: 'error',
        type: { \$in: ['task_failed','tool_error','llm_call_failed','run_failed'] }
      })
  " 2>/dev/null || echo 0)
  echo "${c:-0}"
}

# ── Skan logu na fatalne sygnatury (od startu canary; best-effort) ──
log_has_fatal() {
  [ -n "$LOGFILE" ] && [ -f "$LOGFILE" ] || return 1
  grep -qE "EADDRINUSE|AMBIGUOUS_MODULE_SYNTAX|Cannot determine intended module format" "$LOGFILE" 2>/dev/null
}

elapsed=0
while [ "$elapsed" -lt "$SECONDS_WINDOW" ]; do
  sleep "$INTERVAL"; elapsed=$(( $(date +%s) - START_EPOCH ))

  # (4) PID żyje na porcie
  CUR_PID="$(pid_on_port "$PORT")"
  if [ -z "$CUR_PID" ] || ! pid_alive "$CUR_PID"; then
    err "canary FAIL @${elapsed}s — brak żywego procesu na :$PORT"
    exit 1
  fi
  # (5) brak restart-loopu (PID stabilny)
  if [ -n "$START_PID" ] && [ "$CUR_PID" != "$START_PID" ]; then
    err "canary FAIL @${elapsed}s — restart-loop: PID zmienił się $START_PID → $CUR_PID"
    exit 1
  fi
  # (1) /health
  if ! curl -sf --max-time 5 "http://localhost:${PORT}/health" 2>/dev/null \
      | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('success')==True or d.get('status')=='ok'" 2>/dev/null; then
    err "canary FAIL @${elapsed}s — /health nie odpowiada poprawnie"
    exit 1
  fi
  # (2) /deploy/health — gdy istnieje. Brak endpointu (pusta odpowiedź) NIE jest FAIL;
  #     FAIL tylko gdy odpowiedział, ale jawnie niezdrowy.
  DH="$(curl -sf --max-time 5 "http://localhost:${PORT}/deploy/health" 2>/dev/null || echo "")"
  if [ -n "$DH" ]; then
    if ! echo "$DH" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('success')!=False and d.get('status') not in ('error','down','unhealthy')" 2>/dev/null; then
      err "canary FAIL @${elapsed}s — /deploy/health zgłosił niezdrowy stan"
      exit 1
    fi
  fi
  # (3) realny odczyt z observability DuckDB — twardy warunek
  if ! observability_health_ok "$PORT"; then
    err "canary FAIL @${elapsed}s — domena observability nie odpowiada poprawnie"
    exit 1
  fi
  # (6) log bez fatalnych sygnatur
  if log_has_fatal; then
    err "canary FAIL @${elapsed}s — fatalna sygnatura w logu (EADDRINUSE/AMBIGUOUS)"
    exit 1
  fi
  # (7) eksplozja błędów (best-effort)
  EC="$(mongo_error_count)"
  if [ "$EC" -gt "$MAX_ERRORS" ] 2>/dev/null; then
    err "canary FAIL @${elapsed}s — eksplozja błędów w $MONGO_COLL ($EC > $MAX_ERRORS)"
    exit 1
  fi

  log "canary OK @${elapsed}/${SECONDS_WINDOW}s — PID=$CUR_PID errors=${EC}"
done

ok "canary PASS — :$PORT zdrowy przez ${SECONDS_WINDOW}s (PID=$START_PID, brak restart-loopu/eksplozji)."
exit 0
