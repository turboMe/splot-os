#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  📚 Autoheal deploy — wspólna biblioteka kroków (Etap 4)
#
#  Współdzielone przez idempotentne kroki blue-green:
#    build-candidate · start-candidate · verify-candidate
#    promote-candidate · rollback-to-stable · mark-promoted
#
#  Zasada: kroki są MAŁE, idempotentne i mają jednoznaczny kod wyjścia.
#  Sloty runtime (.deploy/runtime/slot-a|slot-b) to miejsce URUCHAMIANIA —
#  deterministyczne kopie z konkretnego commita (git archive, bez .git).
#  Source repo to KANON (źródło commitów), NIE artefakt uruchomieniowy.
#
#  Ten plik jest tylko sourcowany (`source lib.sh`), nie uruchamiany wprost.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Ścieżki (z lokalizacji skryptu) ──
AUTOHEAL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$AUTOHEAL_LIB_DIR/../.." && pwd)"
PROJECT_ROOT="$(cd "$REPO_DIR/.." && pwd)"

DEPLOY_DIR="${AUTOHEAL_DEPLOY_DIR:-$PROJECT_ROOT/.deploy}"
RUNTIME_DIR="${AUTOHEAL_RUNTIME_DIR:-$DEPLOY_DIR/runtime}"
CONFIG_FILE="${AUTOHEAL_CONFIG_FILE:-$REPO_DIR/deploy.config.json}"
STATE_FILE="${AUTOHEAL_STATE_FILE:-$DEPLOY_DIR/autoheal-state.json}"

# ── Kolory / logi ──
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
_tag="${AUTOHEAL_STEP_TAG:-STEP}"
log()  { echo -e "${CYAN}[$_tag]${NC} $(date '+%H:%M:%S') $1"; }
ok()   { echo -e "${GREEN}[$_tag ✅]${NC} $(date '+%H:%M:%S') $1"; }
warn() { echo -e "${YELLOW}[$_tag ⚠️]${NC} $(date '+%H:%M:%S') $1"; }
err()  { echo -e "${RED}[$_tag ❌]${NC} $(date '+%H:%M:%S') $1"; }

# ── Node przez nvm (jak reszta toolingu) ──
load_node() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # .nvmrc is the source of truth (dev enforces it via scripts/with-node.sh).
  local required
  required="$(tr -d '[:space:]' < "$REPO_DIR/.nvmrc" 2>/dev/null || echo 22)"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
    if ! nvm use --silent "$required" >/dev/null 2>&1; then
      err "Node $required unavailable in nvm (default=$(nvm version default 2>/dev/null)). Run: nvm install $required"
      exit 1
    fi
  fi
  # HARD gate, matching with-node.sh. The old `nvm use 22 || true` silently fell
  # back to the nvm default (v20) whenever the switch failed — and mastra breaks
  # on v20. A production start-candidate/build-candidate must FAIL loudly rather
  # than run mastra on the wrong Node and produce the exact conflicts we hit.
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt 22 ]; then
    err "Node >=22 required (mastra), runtime is v$(node --version 2>/dev/null | tr -d v). Check nvm/.nvmrc."
    exit 1
  fi
}

# ── Odczyt configu ──
cfg() {
  # cfg <python-expr-na-c> [default]
  python3 -c "import json;c=json.load(open('$CONFIG_FILE'));print($1)" 2>/dev/null || echo "${2:-}"
}
read_deploy_config() {
  LIVE_PORT="$(cfg "c['slots']['A']['port']" 4111)"
  STAGING_PORT="$(cfg "c['slots']['B']['port']" 4222)"
  SOURCE_DIR="$(cfg "c['slots']['A']['dir']" "$REPO_DIR")"
  HEALTH_TIMEOUT="$(cfg "c['healthCheck']['timeoutMs']//1000" 60)"
  HEALTH_INTERVAL="$(cfg "c['healthCheck']['intervalMs']//1000" 3)"
  local configured_live_observability configured_candidate_observability configured_observability_probe
  configured_live_observability="$(cfg "c.get('observability',{}).get('livePath','')" "")"
  configured_candidate_observability="$(cfg "c.get('observability',{}).get('candidatePath','')" "")"
  configured_observability_probe="$(cfg "c.get('observability',{}).get('probeEndpoint','')" "")"
  LIVE_OBSERVABILITY_PATH="${AUTOHEAL_LIVE_OBSERVABILITY_PATH:-${configured_live_observability:-$SOURCE_DIR/storage/mastra-observability.duckdb}}"
  CANDIDATE_OBSERVABILITY_PATH="${AUTOHEAL_CANDIDATE_OBSERVABILITY_PATH:-${configured_candidate_observability:-:memory:}}"
  OBSERVABILITY_PROBE_ENDPOINT="${AUTOHEAL_OBSERVABILITY_PROBE_ENDPOINT:-${configured_observability_probe:-/api/observability/feedback?perPage=1}}"
  if ! [ "${HEALTH_INTERVAL:-0}" -ge 1 ] 2>/dev/null; then HEALTH_INTERVAL=1; fi
}

# ── Inwariant observability: testowy candidate nigdy nie dotyka Live DuckDB ──
validate_observability_paths() {
  [ -n "${LIVE_OBSERVABILITY_PATH:-}" ] || { err "Brak ścieżki Live observability DuckDB."; return 1; }
  [ -n "${CANDIDATE_OBSERVABILITY_PATH:-}" ] || { err "Brak ścieżki candidate observability DuckDB."; return 1; }

  case "$LIVE_OBSERVABILITY_PATH" in
    /*) ;;
    *) err "Live observability wymaga ścieżki bezwzględnej: $LIVE_OBSERVABILITY_PATH"; return 1 ;;
  esac

  if [ "$CANDIDATE_OBSERVABILITY_PATH" != ":memory:" ]; then
    case "$CANDIDATE_OBSERVABILITY_PATH" in
      /*) ;;
      *) err "Candidate observability wymaga :memory: albo ścieżki bezwzględnej: $CANDIDATE_OBSERVABILITY_PATH"; return 1 ;;
    esac
    local live_normalized candidate_normalized
    live_normalized="$(readlink -m -- "$LIVE_OBSERVABILITY_PATH")"
    candidate_normalized="$(readlink -m -- "$CANDIDATE_OBSERVABILITY_PATH")"
    if [ "$live_normalized" = "$candidate_normalized" ]; then
      err "Candidate i Live wskazują ten sam observability DuckDB: $live_normalized"
      return 1
    fi
  fi
}

# Atomowa synchronizacja runtime `.env`. Slot nigdy nie zachowuje starego
# zestawu flag/tokenów po idempotentnym buildzie lub ponownym starcie.
sync_runtime_env() {
  local source_env="$1" target_env="$2" target_dir tmp
  [ -f "$source_env" ] || { err "Brak źródłowego pliku środowiska: $source_env"; return 1; }
  target_dir="$(dirname "$target_env")"
  mkdir -p "$target_dir"
  tmp="${target_env}.tmp-$$"
  if ! install -m 600 -- "$source_env" "$tmp"; then
    rm -f -- "$tmp"
    err "Nie udało się przygotować runtime .env."
    return 1
  fi
  mv -f -- "$tmp" "$target_env"
}

# ── Mapowanie slot → katalog / litera DEPLOY_SLOT / pidfile ──
slot_dir()    { echo "$RUNTIME_DIR/$1"; }
slot_letter() { case "$1" in slot-a) echo A ;; slot-b) echo B ;; *) echo X ;; esac; }
slot_pidfile(){ echo "$DEPLOY_DIR/$1.pid"; }

# ── Health-check: czeka aż /health odpowie, zwraca 0/1 ──
wait_health() {
  local port="$1" timeout="${2:-60}" interval="${3:-3}" elapsed=0 resp=""
  while [ "$elapsed" -lt "$timeout" ]; do
    sleep "$interval"; elapsed=$((elapsed + interval))
    resp="$(curl -sf --max-time 5 "http://localhost:${port}/health" 2>/dev/null || echo "")"
    if [ -n "$resp" ] && echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('success')==True or d.get('status')=='ok'" 2>/dev/null; then
      return 0
    fi
    log "health :$port ($elapsed/${timeout}s)…"
  done
  return 1
}

# ── Twarda sonda observability ────────────────────────────────────
# GET /api/observability/feedback wykonuje prawdziwe zapytanie do domeny
# observability. Dzięki temu odróżnia gotowy runtime od procesu, którego zwykły
# /health działa mimo niedostępnego/zablokowanego DuckDB.
observability_health_ok() {
  local port="$1" resp=""
  resp="$(curl -sf --max-time 10 \
    "http://localhost:${port}${OBSERVABILITY_PROBE_ENDPOINT}" 2>/dev/null || echo "")"
  [ -n "$resp" ] && printf '%s' "$resp" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert isinstance(d, dict)
assert isinstance(d.get("feedback"), list)
assert isinstance(d.get("pagination"), dict)
' 2>/dev/null
}

# Pełna readiness = proces HTTP oraz działająca domena observability.
wait_ready() {
  local port="$1" timeout="${2:-60}" interval="${3:-3}" elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    sleep "$interval"; elapsed=$((elapsed + interval))
    if curl -sf --max-time 5 "http://localhost:${port}/health" 2>/dev/null \
        | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('success')==True or d.get('status')=='ok'" 2>/dev/null \
      && observability_health_ok "$port"; then
      return 0
    fi
    log "readiness :$port (HTTP + observability) ($elapsed/${timeout}s)…"
  done
  return 1
}

# ── Czy port należy do znanego pidu (żeby nie zabić cudzego procesu) ──
pid_on_port() { lsof -ti :"$1" 2>/dev/null | head -n1 || echo ""; }
pid_alive()   { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# ── Atomowy merge fragmentu JSON do pliku stanu (schemat autoheal-state.ts) ──
state_merge() {
  # state_merge '<json-object>'
  local patch="$1"
  mkdir -p "$DEPLOY_DIR"
  local tmp="${STATE_FILE}.tmp-$$-$(date +%s)"
  STATE_FILE_ENV="$STATE_FILE" PATCH="$patch" python3 - "$tmp" <<'PY'
import json, os, sys, datetime
tmp = sys.argv[1]
sf = os.environ["STATE_FILE_ENV"]
try:
    with open(sf) as f:
        state = json.load(f)
except Exception:
    state = {}
state.update(json.loads(os.environ["PATCH"]))
state["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
PY
  mv -f "$tmp" "$STATE_FILE"
}

# ── Rozwiązanie commita do krótkiego SHA w source repo ──
resolve_commit() {
  local ref="${1:-HEAD}"
  git -C "$SOURCE_DIR" rev-parse --short "$ref" 2>/dev/null || echo "$ref"
}
