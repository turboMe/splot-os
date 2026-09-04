#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🔄 Blue-Green Deploy Script for Mastra Self-Healing
#  
#  Procedura:
#  1. Buduje kod w STAGING slocie
#  2. Uruchamia STAGING na zapasowym porcie
#  3. Czeka na health-check (max 60s)
#  4. Jeśli OK → swap (STAGING staje się LIVE)
#  5. Jeśli FAIL → rollback (kill staging, live bez zmian)
#
#  Użycie:
#    bash scripts/deploy-blue-green.sh              # Pełny deploy
#    bash scripts/deploy-blue-green.sh --dry-run    # Tylko build+health, bez swap
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_DIR/deploy.config.json"
DEPLOY_DIR="/projekty/mastra-agentic-environment/.deploy"
DRY_RUN="${1:-}"

# ── Etap 4: opt-in delegacja do idempotentnych kroków (zgodność wstecz) ──
# Domyślnie OFF — ten skrypt działa jak dotąd (monolit niżej). Gdy
# AUTOHEAL_USE_STEPS=true → cienki orchestrator scripts/autoheal/run-deploy.sh
# (build-candidate→start→verify[→promote→mark]). Interfejs (--dry-run) zachowany.
if [ "${AUTOHEAL_USE_STEPS:-false}" = "true" ]; then
  exec bash "$SCRIPT_DIR/autoheal/run-deploy.sh" ${DRY_RUN:+"$DRY_RUN"}
fi

# ── Colors ──
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ── Load nvm ──
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use --silent 22 >/dev/null 2>&1 || true

# ── Helpers ──
log_info()  { echo -e "${CYAN}[DEPLOY]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[DEPLOY ✅]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[DEPLOY ⚠️]${NC} $1"; }
log_error() { echo -e "${RED}[DEPLOY ❌]${NC} $1"; }

timestamp() { date '+%Y-%m-%d_%H-%M-%S'; }

sync_runtime_env() {
  local source_env="$1" target_env="$2" tmp
  [ -f "$source_env" ] || { log_error "Brak źródłowego pliku środowiska: $source_env"; return 1; }
  mkdir -p "$(dirname "$target_env")"
  tmp="${target_env}.tmp-$$"
  if ! install -m 600 -- "$source_env" "$tmp"; then
    rm -f -- "$tmp"
    log_error "Nie udało się przygotować runtime .env."
    return 1
  fi
  mv -f -- "$tmp" "$target_env"
}

# ── Parse config ──
LIVE_DIR=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['A']['dir'])")
STAGING_DIR=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['B']['dir'])")
LIVE_PORT=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['A']['port'])")
STAGING_PORT=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['B']['port'])")
HEALTH_TIMEOUT=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['healthCheck']['timeoutMs'] // 1000)")
HEALTH_INTERVAL=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['healthCheck']['intervalMs'] // 1000)")
LIVE_OBSERVABILITY_PATH=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('observability',{}).get('livePath', '$LIVE_DIR/storage/mastra-observability.duckdb'))")
CANDIDATE_OBSERVABILITY_PATH=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('observability',{}).get('candidatePath', ':memory:'))")
OBSERVABILITY_PROBE_ENDPOINT=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('observability',{}).get('probeEndpoint', '/api/observability/feedback?perPage=1'))")

case "$LIVE_OBSERVABILITY_PATH" in
  /*) ;;
  *) log_error "Live observability wymaga ścieżki bezwzględnej: $LIVE_OBSERVABILITY_PATH"; exit 1 ;;
esac
if [ "$CANDIDATE_OBSERVABILITY_PATH" != ":memory:" ]; then
  case "$CANDIDATE_OBSERVABILITY_PATH" in
    /*) ;;
    *) log_error "Candidate observability wymaga :memory: albo ścieżki bezwzględnej."; exit 1 ;;
  esac
  if [ "$(readlink -m -- "$LIVE_OBSERVABILITY_PATH")" = "$(readlink -m -- "$CANDIDATE_OBSERVABILITY_PATH")" ]; then
    log_error "Candidate i Live nie mogą wskazywać tego samego observability DuckDB."
    exit 1
  fi
fi

# Sonda wykonuje prawdziwy odczyt z domeny observability. Sam /health potrafi
# odpowiedzieć 200 nawet wtedy, gdy DuckDB jest zablokowany przez inny proces.
observability_health_ok() {
  local port="$1" response=""
  response=$(curl -sf --max-time 10 \
    "http://localhost:${port}${OBSERVABILITY_PROBE_ENDPOINT}" 2>/dev/null || echo "")
  [ -n "$response" ] && printf '%s' "$response" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert isinstance(d, dict)
assert isinstance(d.get("feedback"), list)
assert isinstance(d.get("pagination"), dict)
' 2>/dev/null
}

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

stop_pid_bounded() {
  local pid="$1" label="${2:-process}"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  pid_alive "$pid" || { wait "$pid" 2>/dev/null || true; return 0; }

  log_warn "Stopping $label (PID $pid)…"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    pid_alive "$pid" || break
    sleep 1
  done
  if pid_alive "$pid"; then
    log_warn "$label did not exit after 10s — sending SIGKILL."
    kill -KILL "$pid" 2>/dev/null || true
    for _ in $(seq 1 5); do
      pid_alive "$pid" || break
      sleep 1
    done
  fi
  wait "$pid" 2>/dev/null || true
  ! pid_alive "$pid"
}

live_observability_lock_pids() {
  lsof -t -- "$LIVE_OBSERVABILITY_PATH" 2>/dev/null || true
  if [ -e "${LIVE_OBSERVABILITY_PATH}.wal" ]; then
    lsof -t -- "${LIVE_OBSERVABILITY_PATH}.wal" 2>/dev/null || true
  fi
}

wait_live_observability_unlock() {
  local timeout="${1:-15}" elapsed=0 holders=""
  while [ "$elapsed" -lt "$timeout" ]; do
    holders="$(live_observability_lock_pids)"
    [ -z "$holders" ] && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  holders="$(live_observability_lock_pids)"
  log_error "Live observability DuckDB nadal ma otwarte uchwyty (PID: ${holders//$'\n'/, })."
  return 1
}

wait_full_readiness() {
  local port="$1" timeout="${2:-30}" interval="${3:-3}" elapsed=0 response=""
  while [ "$elapsed" -lt "$timeout" ]; do
    sleep "$interval"
    elapsed=$((elapsed + interval))
    response="$(curl -sf --max-time 5 "http://localhost:${port}/health" 2>/dev/null || echo "")"
    if [ -n "$response" ] \
      && printf '%s' "$response" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('success')==True or d.get('status')=='ok'" 2>/dev/null \
      && observability_health_ok "$port"; then
      return 0
    fi
    log_info "Readiness :$port (HTTP + observability) ($elapsed/${timeout}s)…"
  done
  return 1
}

# ── Ensure dirs ──
mkdir -p "$DEPLOY_DIR/logs"

LOG_FILE="$DEPLOY_DIR/logs/deploy-$(timestamp).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log_info "═══════════════════════════════════════"
log_info "  Blue-Green Deploy Started"
log_info "  Live:    $LIVE_DIR (port $LIVE_PORT)"
log_info "  Staging: $STAGING_DIR (port $STAGING_PORT)"
log_info "  Mode:    ${DRY_RUN:-production}"
log_info "  Log:     $LOG_FILE"
log_info "═══════════════════════════════════════"

# ══════════════════════════════════════════════════════════════════
#  Step 1: Prepare STAGING directory
# ══════════════════════════════════════════════════════════════════

log_info "Step 1: Preparing staging directory..."

if [ ! -d "$STAGING_DIR" ]; then
  log_info "Creating staging via rsync (first run)..."
  mkdir -p "$STAGING_DIR"
fi

rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.mastra' \
  --exclude='.git' \
  --exclude='mastra.duckdb' \
  --exclude='mastra.duckdb.wal' \
  --exclude='storage/mastra-observability.duckdb' \
  --exclude='storage/mastra-observability.duckdb.wal' \
  --exclude='storage/mastra-observability.duckdb.pre-retention-*' \
  --exclude='storage/mastra-observability.duckdb.pre-retention-*.wal' \
  --exclude='.env' \
  --exclude='.deploy' \
  "$LIVE_DIR/" "$STAGING_DIR/"

# Zapisz wersję (SHA) z live repo jako marker — bez kopiowania .git
LIVE_SHA=$(cd "$LIVE_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')
echo "$LIVE_SHA" > "$STAGING_DIR/.deploy-version"

# `.env` jest konfiguracją runtime, nie artefaktem commita. Synchronizujemy go
# przy każdym deployu, aby istniejący staging nie zachował starych flag/tokenów.
sync_runtime_env "$LIVE_DIR/.env" "$STAGING_DIR/.env"
log_info "Staging .env zsynchronizowany z Live (uprawnienia 0600)."

log_ok "Staging synced from live (version: $LIVE_SHA)"

# ══════════════════════════════════════════════════════════════════
#  Step 2: Install deps + Build in STAGING
# ══════════════════════════════════════════════════════════════════

log_info "Step 2: Building in staging..."

cd "$STAGING_DIR"

if [ ! -d "node_modules" ]; then
  log_info "Installing dependencies..."
  npm install --silent 2>&1 || pnpm install --silent 2>&1
fi

log_info "Running mastra build..."
npx mastra build 2>&1
BUILD_EXIT=$?

if [ $BUILD_EXIT -ne 0 ]; then
  log_error "Build FAILED (exit code $BUILD_EXIT). Aborting deploy."
  exit 1
fi

log_ok "Build successful"

# ══════════════════════════════════════════════════════════════════
#  Step 3: Start STAGING on alternate port
# ══════════════════════════════════════════════════════════════════

log_info "Step 3: Starting staging server on port $STAGING_PORT..."

# Kill any previous staging process
if [ -f "$DEPLOY_DIR/slot-b.pid" ]; then
  OLD_PID=$(cat "$DEPLOY_DIR/slot-b.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log_warn "Killing old staging process (PID $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

log_info "Candidate observability: $CANDIDATE_OBSERVABILITY_PATH (izolowane od Live)"
PORT=$STAGING_PORT DEPLOY_SLOT=B MASTRA_DUCKDB_PATH="$CANDIDATE_OBSERVABILITY_PATH" \
  node .mastra/output/index.mjs &
STAGING_PID=$!
echo "$STAGING_PID" > "$DEPLOY_DIR/slot-b.pid"

log_info "Staging started with PID $STAGING_PID"

# ══════════════════════════════════════════════════════════════════
#  Step 4: Health check
#  Mastra ma wbudowany /health → {"success":true}
#  Nasz custom /deploy/health → {"status":"ok", "version": ...}
# ══════════════════════════════════════════════════════════════════

log_info "Step 4: Waiting for health check (max ${HEALTH_TIMEOUT}s)..."

# Używamy wbudowanego /health jako primary (pewniejszy)
HEALTH_URL="http://localhost:${STAGING_PORT}/health"
ELAPSED=0
HEALTHY=false

while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))

  RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null || echo "")
  if [ -n "$RESPONSE" ]; then
    # Mastra wbudowany /health zwraca {"success":true}
    if echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('success')==True or d.get('status')=='ok'" 2>/dev/null \
      && observability_health_ok "$STAGING_PORT"; then
      HEALTHY=true
      break
    fi
  fi

  log_info "Health check attempt ($ELAPSED/${HEALTH_TIMEOUT}s)..."
done

if [ "$HEALTHY" = true ]; then
  log_ok "Staging is ready: HTTP i observability działają."
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

  # Spróbuj też nasz custom health dla pełnych danych
  CUSTOM_HEALTH=$(curl -sf "http://localhost:${STAGING_PORT}/deploy/health" 2>/dev/null || echo "")
  if [ -n "$CUSTOM_HEALTH" ]; then
    log_ok "Custom deploy health:"
    echo "$CUSTOM_HEALTH" | python3 -m json.tool 2>/dev/null || echo "$CUSTOM_HEALTH"
  fi
else
  log_error "Staging failed health check after ${HEALTH_TIMEOUT}s!"
  log_error "Killing staging process..."
  
  # Tylko kill staging — NIE revertujemy gita! To nie jest nasza wina.
  kill "$STAGING_PID" 2>/dev/null || true
  rm -f "$DEPLOY_DIR/slot-b.pid"

  log_error "STAGING FAILED. Live remains untouched on port $LIVE_PORT."
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
#  Step 5: Swap or dry-run report
# ══════════════════════════════════════════════════════════════════

if [ "$DRY_RUN" = "--dry-run" ]; then
  log_ok "DRY RUN: Staging verified healthy. Stopping staging process."
  kill "$STAGING_PID" 2>/dev/null || true
  rm -f "$DEPLOY_DIR/slot-b.pid"
  
  log_ok "═══════════════════════════════════════"
  log_ok "  DRY RUN COMPLETE — staging healthy"
  log_ok "  Version: $(cat "$STAGING_DIR/.deploy-version" 2>/dev/null || echo 'unknown')"
  log_ok "═══════════════════════════════════════"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
#  Step 5b: GRACEFUL SWAP — staging becomes live (Etap 10.1)
# ══════════════════════════════════════════════════════════════════

log_info "Step 5: Graceful Swap — staging becomes live on :$LIVE_PORT..."

LIVE_VERSION=$(cd "$LIVE_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')
STAGING_VERSION=$(cat "$STAGING_DIR/.deploy-version" 2>/dev/null || echo 'unknown')

log_info "Live version (current):  $LIVE_VERSION"
log_info "Staging version (new):   $STAGING_VERSION"

# ── 5b.1: Backup current Live build for rollback ──
ROLLBACK_DIR="$DEPLOY_DIR/rollback/$(timestamp)"
mkdir -p "$ROLLBACK_DIR"

log_info "Creating rollback backup → $ROLLBACK_DIR"

# Kopiujemy zbudowany output (szybki rollback bez rebuildu)
if [ -d "$LIVE_DIR/.mastra/output" ]; then
  cp -a "$LIVE_DIR/.mastra/output" "$ROLLBACK_DIR/output"
fi
# Zapisujemy wersję i .env
echo "$LIVE_VERSION" > "$ROLLBACK_DIR/.deploy-version"
sync_runtime_env "$LIVE_DIR/.env" "$ROLLBACK_DIR/.env"
# Zapisujemy ścieżkę do źródłowego katalogu live
echo "$LIVE_DIR" > "$ROLLBACK_DIR/.live-dir"
# Link do najnowszego rollbacku
ln -sfn "$ROLLBACK_DIR" "$DEPLOY_DIR/rollback/latest"

log_ok "Rollback backup created (version: $LIVE_VERSION)"

# ── 5b.2: Kill staging on :4222 (already verified healthy) ──
log_info "Stopping staging (:$STAGING_PORT)..."
kill "$STAGING_PID" 2>/dev/null || true
sleep 2
rm -f "$DEPLOY_DIR/slot-b.pid"

# ── 5b.3: Kill old Live on :4111 ──
log_info "Stopping old Live (:$LIVE_PORT)..."
if [ -f "$DEPLOY_DIR/slot-a.pid" ]; then
  OLD_LIVE_PID=$(cat "$DEPLOY_DIR/slot-a.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_LIVE_PID" ] && kill -0 "$OLD_LIVE_PID" 2>/dev/null; then
    kill "$OLD_LIVE_PID" 2>/dev/null || true
    # Czekamy na graceful shutdown (max 10s)
    for i in $(seq 1 10); do
      kill -0 "$OLD_LIVE_PID" 2>/dev/null || break
      sleep 1
    done
    # Force kill jeśli wciąż żyje
    kill -9 "$OLD_LIVE_PID" 2>/dev/null || true
  fi
fi

# Dodatkowe zabezpieczenie: kill cokolwiek na porcie Live
ORPHAN_PID=$(lsof -ti :"$LIVE_PORT" 2>/dev/null || echo "")
if [ -n "$ORPHAN_PID" ]; then
  log_warn "Killing orphan process on :$LIVE_PORT (PID: $ORPHAN_PID)"
  kill "$ORPHAN_PID" 2>/dev/null || true
  sleep 1
fi

log_ok "Old Live stopped"

# ── 5b.4: Start staging code on Live port (:4111) ──
log_info "Starting NEW Live from staging code on :$LIVE_PORT..."

cd "$STAGING_DIR"
mkdir -p "$(dirname "$LIVE_OBSERVABILITY_PATH")"
log_info "Live observability: $LIVE_OBSERVABILITY_PATH"
PORT=$LIVE_PORT DEPLOY_SLOT=A MASTRA_DUCKDB_PATH="$LIVE_OBSERVABILITY_PATH" \
  node .mastra/output/index.mjs > "$DEPLOY_DIR/logs/live-$(timestamp).log" 2>&1 &
NEW_LIVE_PID=$!
echo "$NEW_LIVE_PID" > "$DEPLOY_DIR/slot-a.pid"

log_info "New Live started with PID $NEW_LIVE_PID"

# ── 5b.5: Verify new Live health on :4111 ──
log_info "Verifying new Live health on :$LIVE_PORT..."

SWAP_HEALTHY=false
SWAP_ELAPSED=0
SWAP_TIMEOUT=30

while [ $SWAP_ELAPSED -lt $SWAP_TIMEOUT ]; do
  sleep "$HEALTH_INTERVAL"
  SWAP_ELAPSED=$((SWAP_ELAPSED + HEALTH_INTERVAL))

  SWAP_RESPONSE=$(curl -sf "http://localhost:${LIVE_PORT}/health" 2>/dev/null || echo "")
  if [ -n "$SWAP_RESPONSE" ]; then
    if echo "$SWAP_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('success')==True or d.get('status')=='ok'" 2>/dev/null \
      && observability_health_ok "$LIVE_PORT"; then
      SWAP_HEALTHY=true
      break
    fi
  fi

  log_info "Post-swap health check ($SWAP_ELAPSED/${SWAP_TIMEOUT}s)..."
done

if [ "$SWAP_HEALTHY" = true ]; then
  log_ok "═══════════════════════════════════════"
  log_ok "  SWAP COMPLETE ✅"
  log_ok "  New Live running on :$LIVE_PORT"
  log_ok "  Version: $STAGING_VERSION"
  log_ok "  PID: $NEW_LIVE_PID"
  log_ok "  Rollback: $ROLLBACK_DIR"
  log_ok "═══════════════════════════════════════"

  # ── 5b.6: Launch watchdog ──
  WATCHDOG_SCRIPT="$SCRIPT_DIR/watchdog.sh"
  if [ -f "$WATCHDOG_SCRIPT" ]; then
    log_info "Launching watchdog (10-minute observation)..."
    MASTRA_DUCKDB_PATH="$LIVE_OBSERVABILITY_PATH" bash "$WATCHDOG_SCRIPT" \
      --live-port "$LIVE_PORT" \
      --live-pid "$NEW_LIVE_PID" \
      --rollback-dir "$ROLLBACK_DIR" \
      --config "$CONFIG_FILE" \
      --log "$DEPLOY_DIR/logs/watchdog-$(timestamp).log" &
    WATCHDOG_PID=$!
    echo "$WATCHDOG_PID" > "$DEPLOY_DIR/watchdog.pid"
    log_ok "Watchdog started (PID $WATCHDOG_PID) — monitoring for 10 minutes"
  else
    log_warn "Watchdog script not found at $WATCHDOG_SCRIPT — skipping observation"
  fi
else
  log_error "═══════════════════════════════════════"
  log_error "  POST-SWAP HEALTH CHECK FAILED!"
  log_error "  Initiating EMERGENCY ROLLBACK..."
  log_error "═══════════════════════════════════════"

  # Zatrzymaj wadliwy runtime i upewnij się, że nie pozostał listener ani lock
  # wspólnego produkcyjnego DuckDB. Rollback nie może wystartować drugim writerem.
  if ! stop_pid_bounded "$NEW_LIVE_PID" "failed new Live"; then
    log_warn "Failed new Live nadal zgłasza żywy PID; sprawdzam port i locki."
  fi

  while IFS= read -r ORPHAN_PID; do
    [ -n "$ORPHAN_PID" ] || continue
    if ! stop_pid_bounded "$ORPHAN_PID" "orphan listener :$LIVE_PORT"; then
      log_error "Nie udało się zatrzymać procesu $ORPHAN_PID na :$LIVE_PORT."
      exit 2
    fi
  done < <(lsof -tiTCP:"$LIVE_PORT" -sTCP:LISTEN 2>/dev/null || true)

  if ! wait_live_observability_unlock 15; then
    log_error "ROLLBACK ABORTED: produkcyjny DuckDB nie zwolnił locka. Wymagana interwencja."
    exit 2
  fi

  # Restore from rollback backup
  if [ -d "$ROLLBACK_DIR/output" ]; then
    log_info "Restoring Live from rollback backup..."
    cd "$LIVE_DIR"
    PORT=$LIVE_PORT DEPLOY_SLOT=A MASTRA_DUCKDB_PATH="$LIVE_OBSERVABILITY_PATH" \
      node "$ROLLBACK_DIR/output/index.mjs" > "$DEPLOY_DIR/logs/rollback-$(timestamp).log" 2>&1 &
    RESTORED_PID=$!
    echo "$RESTORED_PID" > "$DEPLOY_DIR/slot-a.pid"
    if wait_full_readiness "$LIVE_PORT" 30 "$HEALTH_INTERVAL"; then
      log_ok "Live restored and ready (PID $RESTORED_PID, version: $LIVE_VERSION)"
    else
      log_error "ROLLBACK FAILED: old Live did not reach HTTP + observability readiness."
      stop_pid_bounded "$RESTORED_PID" "unhealthy rollback Live" || true
      rm -f "$DEPLOY_DIR/slot-a.pid"
      exit 2
    fi
  else
    log_error "NO ROLLBACK BACKUP FOUND! Live is DOWN. Manual intervention required."
    exit 2
  fi

  exit 1
fi

log_ok "═══════════════════════════════════════"
log_ok "  DEPLOY COMPLETE"
log_ok "  Live: :$LIVE_PORT (PID $NEW_LIVE_PID)"
log_ok "  Version: $STAGING_VERSION"
log_ok "  Watchdog: active (10 min)"
log_ok "  Log: $LOG_FILE"
log_ok "═══════════════════════════════════════"
