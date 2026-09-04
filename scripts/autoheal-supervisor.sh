#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🛡️  Autoheal Supervisor (Etap 3 OBSERVE + Etap 5 PROMOTE)
#
#  Proces POZA Mastrą. NIE importuje kodu Mastry. Ma być mały i nudny:
#  health-check, process management, git, pliki stanu.
#
#  Zasada nadrzędna (ideas/autoheal-update.md):
#    rollback i dostępność runtime NIGDY nie zależą od Mastry/LLM/Mongo.
#    Dlatego supervisor żyje samodzielnie i pisze .deploy/autoheal-state.json.
#
#  Tryb OBSERVE (Etap 3, domyślny): tylko obserwuje aktywny runtime (:4111),
#  odczytuje PID/port/health/wersję i zapisuje stan. NIC NIE ZABIJA.
#
#  Tryb PROMOTE (Etap 5, --promote): supervisor jest WŁAŚCICIELEM aktywnego
#  sterowania — deleguje do scripts/autoheal/run-deploy.sh (build→start→verify→
#  promote→canary 60s→mark, z deterministycznym rollbackiem przy awarii).
#  Wymaga AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=false (inaczej odmawia — bezpiecznie).
#
#  Użycie:
#    bash scripts/autoheal-supervisor.sh                    # pętla obserwacyjna
#    bash scripts/autoheal-supervisor.sh --once             # jeden cykl (test/cron)
#    bash scripts/autoheal-supervisor.sh --status           # wypisz plik stanu i wyjdź
#    bash scripts/autoheal-supervisor.sh --promote [ref]    # aktywny deploy (Etap 5, gated)
#    bash scripts/autoheal-supervisor.sh --promote [ref] --dry-run  # build+verify, bez swapu
#    bash scripts/autoheal-supervisor.sh --promote-retry [ref]  # pętla ponawiania (Etap 7, gated)
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$REPO_DIR/.." && pwd)"
DEPLOY_DIR="${AUTOHEAL_DEPLOY_DIR:-$PROJECT_ROOT/.deploy}"
CONFIG_FILE="${AUTOHEAL_CONFIG_FILE:-$REPO_DIR/deploy.config.json}"
STATE_FILE="${AUTOHEAL_STATE_FILE:-$DEPLOY_DIR/autoheal-state.json}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()   { echo -e "${CYAN}[SUPERVISOR]${NC} $(date '+%H:%M:%S') $1"; }
ok()    { echo -e "${GREEN}[SUPERVISOR ✅]${NC} $(date '+%H:%M:%S') $1"; }
warn()  { echo -e "${YELLOW}[SUPERVISOR ⚠️]${NC} $(date '+%H:%M:%S') $1"; }
err()   { echo -e "${RED}[SUPERVISOR ❌]${NC} $(date '+%H:%M:%S') $1"; }

# ── Flagi ENV (per ideas/autoheal-update.md) ──
ENABLED="${AUTOHEAL_SUPERVISOR_ENABLED:-false}"
OBSERVE_ONLY="${AUTOHEAL_SUPERVISOR_OBSERVE_ONLY:-true}"
INTERVAL="${AUTOHEAL_SUPERVISOR_INTERVAL_SECONDS:-15}"
CANARY_SECONDS="${AUTOHEAL_CANARY_SECONDS:-60}"
MAX_ATTEMPTS="${AUTOHEAL_MAX_ATTEMPTS:-2}"

# ── Argumenty ──
MODE="loop"
PROMOTE_REF="HEAD"
PROMOTE_DRYRUN=""
case "${1:-}" in
  --once)    MODE="once" ;;
  --status)  MODE="status" ;;
  --promote|--promote-retry)
             [ "$1" = "--promote-retry" ] && MODE="promote-retry" || MODE="promote"
             # Opcjonalny ref (pomijając kolejne flagi) + opcjonalny --dry-run
             for a in "${@:2}"; do
               case "$a" in
                 --dry-run) PROMOTE_DRYRUN="--dry-run" ;;
                 -*)        warn "Nieznana flaga promote: $a (ignoruję)" ;;
                 *)         PROMOTE_REF="$a" ;;
               esac
             done ;;
  "")        MODE="loop" ;;
  *)         warn "Nieznany argument: $1 (ignoruję)" ;;
esac

# ── Odczyt configu (slot A: port + pidfile) ──
read_config() {
  ACTIVE_PORT=4111
  ACTIVE_PIDFILE="$DEPLOY_DIR/slot-a.pid"
  ACTIVE_SLOT="slot-a"
  if [ -f "$CONFIG_FILE" ]; then
    ACTIVE_PORT=$(python3 -c "import json;c=json.load(open('$CONFIG_FILE'));print(c.get('slots',{}).get('A',{}).get('port',4111))" 2>/dev/null || echo 4111)
    ACTIVE_PIDFILE=$(python3 -c "import json;c=json.load(open('$CONFIG_FILE'));print(c.get('slots',{}).get('A',{}).get('pidFile','$DEPLOY_DIR/slot-a.pid'))" 2>/dev/null || echo "$DEPLOY_DIR/slot-a.pid")
  fi
}

# ── Stable commit z source repo (HEAD) ──
git_head() {
  git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

# ── Odczyt PID aktywnego runtime: pidfile → lsof na porcie ──
detect_pid() {
  local pid=""
  if [ -f "$ACTIVE_PIDFILE" ]; then
    pid=$(cat "$ACTIVE_PIDFILE" 2>/dev/null || echo "")
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"; return
  fi
  # Fallback: kto słucha na porcie
  lsof -ti :"$ACTIVE_PORT" 2>/dev/null | head -n1 || echo ""
}

# ── Health-check: zwraca JSON z /deploy/health albo "" ──
fetch_deploy_health() {
  curl -sf --max-time 8 "http://localhost:${ACTIVE_PORT}/deploy/health" 2>/dev/null || echo ""
}
fetch_basic_health() {
  curl -sf --max-time 8 "http://localhost:${ACTIVE_PORT}/health" 2>/dev/null && echo "ok" || echo ""
}

# ── Atomowy zapis stanu (tmp + mv), zgodny ze schematem services/autoheal-state.ts ──
write_state() {
  local stable="$1" slot="$2" pid="$3" port="$4" health_state="$5"
  mkdir -p "$DEPLOY_DIR"
  local prev_promoted="null"
  if [ -f "$STATE_FILE" ]; then
    prev_promoted=$(python3 -c "import json;print(json.dumps(json.load(open('$STATE_FILE')).get('lastPromotedAt')))" 2>/dev/null || echo "null")
  fi
  local pid_json="null"
  [ -n "$pid" ] && pid_json="$pid"
  local tmp="${STATE_FILE}.tmp-$$-$(date +%s)"
  STABLE="$stable" SLOT="$slot" PIDJSON="$pid_json" PORT="$port" HSTATE="$health_state" PREV="$prev_promoted" \
  python3 - "$tmp" <<'PY'
import json, os, sys, datetime
tmp = sys.argv[1]
state = {
  "stableCommit": os.environ["STABLE"],
  "activeSlot": os.environ["SLOT"],
  "activePid": json.loads(os.environ["PIDJSON"]),
  "activePort": int(os.environ["PORT"]),
  "lastPromotedAt": json.loads(os.environ["PREV"]),
  "state": os.environ["HSTATE"],
  "observedBy": "autoheal-supervisor",
  "updatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
}
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
PY
  mv -f "$tmp" "$STATE_FILE"
}

# ── Jeden cykl obserwacji ──
observe_once() {
  read_config
  local pid health deploy_health version slot health_state
  pid=$(detect_pid)
  deploy_health=$(fetch_deploy_health)
  health=$(fetch_basic_health)

  if [ -n "$deploy_health" ]; then
    version=$(echo "$deploy_health" | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
    slot=$(echo "$deploy_health" | python3 -c "import sys,json;print(json.load(sys.stdin).get('slot','$ACTIVE_SLOT'))" 2>/dev/null || echo "$ACTIVE_SLOT")
  else
    version=$(git_head)
    slot="$ACTIVE_SLOT"
  fi

  # Stan zdrowia (tylko obserwacja — żadnej reakcji w tym etapie)
  if [ -n "$health" ] && [ -n "$pid" ]; then
    health_state="stable"
    ok "Runtime OK — :$ACTIVE_PORT PID=${pid:-?} slot=$slot version=$version"
  elif [ -n "$pid" ]; then
    health_state="unhealthy"
    warn "Proces żyje (PID $pid) ale /health nie odpowiada na :$ACTIVE_PORT (OBSERVE — brak reakcji)"
  else
    health_state="down"
    err "Brak procesu na :$ACTIVE_PORT i brak /health (OBSERVE — brak reakcji)"
  fi

  write_state "$version" "$slot" "$pid" "$ACTIVE_PORT" "$health_state"
}

# ═══════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════

if [ "$MODE" = "status" ]; then
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo "{}"
    warn "Brak pliku stanu: $STATE_FILE"
  fi
  exit 0
fi

# ── Tryb PROMOTE (Etap 5) — aktywne sterowanie, gated flagą ──
if [ "$MODE" = "promote" ]; then
  if [ "$OBSERVE_ONLY" = "true" ]; then
    err "Promote ZABLOKOWANY: AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=true (domyślnie)."
    err "Aktywny swap wymaga jawnego AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=false — bezpieczeństwo Etapu 5."
    exit 3
  fi
  RUN_DEPLOY="$SCRIPT_DIR/autoheal/run-deploy.sh"
  [ -f "$RUN_DEPLOY" ] || { err "Brak orchestratora: $RUN_DEPLOY"; exit 1; }
  log "═══ PROMOTE (Etap 5) — ref=$PROMOTE_REF ${PROMOTE_DRYRUN:-production}, canary=${CANARY_SECONDS}s ═══"
  log "Supervisor deleguje deterministyczny deploy do run-deploy.sh (rollback bez LLM/Mongo)."
  AUTOHEAL_CANARY_SECONDS="$CANARY_SECONDS" bash "$RUN_DEPLOY" "$PROMOTE_REF" ${PROMOTE_DRYRUN:+$PROMOTE_DRYRUN}
  rc=$?
  case "$rc" in
    0) if [ -n "$PROMOTE_DRYRUN" ]; then
         ok "DRY-RUN OK (rc=0) — kandydat zbudowany i zdrowy na staging, BEZ swapu. :4111 nietknięty."
       else
         ok "Promote/canary OK (rc=0) — Live na nowej wersji."
       fi ;;
    1) warn "Promote nieudany → wykonano rollback (rc=1). Stable żyje." ;;
    2) err  "KRYTYCZNE: rollback także zawiódł (rc=2) — wymagana interwencja." ;;
    *) err  "Nieznany kod wyjścia run-deploy: $rc" ;;
  esac
  exit "$rc"
fi

# ── Tryb PROMOTE-RETRY (Etap 7) — pętla ponawiania z limitem, gated tą samą bramką ──
if [ "$MODE" = "promote-retry" ]; then
  if [ "$OBSERVE_ONLY" = "true" ]; then
    err "Promote-retry ZABLOKOWANY: AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=true (domyślnie)."
    err "Aktywne sterowanie wymaga jawnego AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=false."
    exit 3
  fi
  RETRY_DEPLOY="$SCRIPT_DIR/autoheal/retry-deploy.sh"
  [ -f "$RETRY_DEPLOY" ] || { err "Brak pętli ponawiania: $RETRY_DEPLOY"; exit 1; }
  log "═══ PROMOTE-RETRY (Etap 7) — ref=$PROMOTE_REF ${PROMOTE_DRYRUN:-production}, max=${MAX_ATTEMPTS}, canary=${CANARY_SECONDS}s ═══"
  AUTOHEAL_CANARY_SECONDS="$CANARY_SECONDS" AUTOHEAL_MAX_ATTEMPTS="$MAX_ATTEMPTS" \
    bash "$RETRY_DEPLOY" "$PROMOTE_REF" ${PROMOTE_DRYRUN:+$PROMOTE_DRYRUN}
  rc=$?
  case "$rc" in
    0) ok   "Retry OK (rc=0) — któraś próba przeszła, Live na nowej wersji." ;;
    1) warn "Wyczerpano próby (rc=1) → state=failed_needs_human. Stable żyje, wymagana decyzja człowieka." ;;
    2) err  "KRYTYCZNE: rollback zawiódł w którejś próbie (rc=2) — wymagana interwencja." ;;
    *) err  "Nieznany kod wyjścia retry-deploy: $rc" ;;
  esac
  exit "$rc"
fi

if [ "$ENABLED" != "true" ]; then
  warn "Supervisor wyłączony (AUTOHEAL_SUPERVISOR_ENABLED=$ENABLED). Uruchamiam i tak w trybie obserwacji jednorazowej tylko gdy --once."
  if [ "$MODE" != "once" ]; then
    log "Pętla nie startuje. Ustaw AUTOHEAL_SUPERVISOR_ENABLED=true aby włączyć ciągłą obserwację."
    exit 0
  fi
fi

if [ "$OBSERVE_ONLY" != "true" ]; then
  warn "AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=$OBSERVE_ONLY — ale aktywne sterowanie (promote/rollback) jest w Etapie 5. Wymuszam OBSERVE."
fi

log "═══════════════════════════════════════"
log "  Autoheal Supervisor — OBSERVE-ONLY"
log "  Repo:       $REPO_DIR"
log "  State file: $STATE_FILE"
log "  Interval:   ${INTERVAL}s   Canary(cfg): ${CANARY_SECONDS}s   MaxAttempts(cfg): ${MAX_ATTEMPTS}"
log "  Mode:       $MODE"
log "═══════════════════════════════════════"

if [ "$MODE" = "once" ]; then
  observe_once
  ok "Jednorazowa obserwacja zapisana → $STATE_FILE"
  exit 0
fi

# Pętla obserwacyjna
trap 'log "Supervisor zatrzymany (signal)."; exit 0' INT TERM
while true; do
  observe_once || warn "Cykl obserwacji nie powiódł się (kontynuuję)."
  sleep "$INTERVAL"
done
