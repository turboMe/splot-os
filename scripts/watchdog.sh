#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🐕 Watchdog — 10-minute post-deploy observation (Etap 10.2)
#
#  Monitoruje nową wersję Live po swap. Jeśli wykryje problemy:
#    → Automatycznie zabija nowy Live
#    → Przywraca stary Live z rollback backupu
#    → Wysyła alert (n8n webhook)
#
#  Uruchamiany automatycznie przez deploy-blue-green.sh po swap.
#
#  Użycie (automatyczne):
#    bash scripts/watchdog.sh \
#      --live-port 4111 \
#      --live-pid 12345 \
#      --rollback-dir /path/to/rollback \
#      --config /path/to/deploy.config.json \
#      --log /path/to/watchdog.log
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ──
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_wd()    { echo -e "${CYAN}[WATCHDOG]${NC} $(date '+%H:%M:%S') $1"; }
log_ok()    { echo -e "${GREEN}[WATCHDOG ✅]${NC} $(date '+%H:%M:%S') $1"; }
log_warn()  { echo -e "${YELLOW}[WATCHDOG ⚠️]${NC} $(date '+%H:%M:%S') $1"; }
log_error() { echo -e "${RED}[WATCHDOG ❌]${NC} $(date '+%H:%M:%S') $1"; }

# ── Parse args ──
LIVE_PORT=""
LIVE_PID=""
ROLLBACK_DIR=""
CONFIG_FILE=""
LOG_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --live-port) LIVE_PORT="$2"; shift 2 ;;
    --live-pid) LIVE_PID="$2"; shift 2 ;;
    --rollback-dir) ROLLBACK_DIR="$2"; shift 2 ;;
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Redirect to log file if specified
if [ -n "$LOG_FILE" ]; then
  exec > >(tee -a "$LOG_FILE") 2>&1
fi

# ── Validate args ──
if [ -z "$LIVE_PORT" ] || [ -z "$LIVE_PID" ] || [ -z "$ROLLBACK_DIR" ]; then
  log_error "Missing required args: --live-port, --live-pid, --rollback-dir"
  exit 1
fi

# ── Load config ──
DEPLOY_DIR="/projekty/mastra-agentic-environment/.deploy"
DURATION_MINUTES=10
CHECK_INTERVAL=30
MAX_ERRORS=3
# Etap 0.1: realna baza i kolekcja sygnałów błędów (było: mastra_agents.error_logs — martwe)
MONGO_DB="agentforge"
MONGO_ERROR_COLLECTION="agent_events"
ALERT_WEBHOOK=""

if [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ]; then
  DURATION_MINUTES=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('watchdog',{}).get('durationMinutes', 10))" 2>/dev/null || echo 10)
  CHECK_INTERVAL=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('watchdog',{}).get('checkIntervalSeconds', 30))" 2>/dev/null || echo 30)
  MAX_ERRORS=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('watchdog',{}).get('maxErrorsBeforeRollback', 3))" 2>/dev/null || echo 3)
  MONGO_DB=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('watchdog',{}).get('mongoDb', 'agentforge'))" 2>/dev/null || echo "agentforge")
  MONGO_ERROR_COLLECTION=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('watchdog',{}).get('mongoErrorCollection', 'agent_events'))" 2>/dev/null || echo "agent_events")
  ALERT_WEBHOOK=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('watchdog',{}).get('alertWebhook', ''))" 2>/dev/null || echo "")
fi

# Etap 0.3: jeśli config nie podał webhooka albo podał przeterminowany trycloudflare,
# zbuduj go z runtime ENV N8N_PUBLIC_WEBHOOK_BASE_URL (URL rotuje przy restarcie tunelu).
if [ -z "$ALERT_WEBHOOK" ] || echo "$ALERT_WEBHOOK" | grep -q "trycloudflare.com"; then
  if [ -n "${N8N_PUBLIC_WEBHOOK_BASE_URL:-}" ]; then
    ALERT_WEBHOOK="${N8N_PUBLIC_WEBHOOK_BASE_URL%/}/webhook/telegram-reply"
  fi
fi

DURATION_SECONDS=$((DURATION_MINUTES * 60))
TOTAL_CHECKS=$((DURATION_SECONDS / CHECK_INTERVAL))
HEALTH_URL="http://localhost:${LIVE_PORT}/health"
DEPLOY_HEALTH_URL="http://localhost:${LIVE_PORT}/deploy/health"
WATCHDOG_START=$(date +%s)

log_wd "═══════════════════════════════════════"
log_wd "  Watchdog started"
log_wd "  Monitoring: :$LIVE_PORT (PID $LIVE_PID)"
log_wd "  Duration: ${DURATION_MINUTES} minutes ($TOTAL_CHECKS checks)"
log_wd "  Interval: ${CHECK_INTERVAL}s"
log_wd "  Max errors before rollback: $MAX_ERRORS"
log_wd "  Rollback dir: $ROLLBACK_DIR"
log_wd "═══════════════════════════════════════"

# ── Mongo error count helper ──
# Etap 0.1: liczy realne błędy runtime z agentforge.agent_events
# (status:'error' w typach task_failed/tool_error/llm_call_failed/run_failed)
# w oknie ostatnich CHECK_INTERVAL*2 sekund — świeże błędy po przełączeniu Live, nie cała historia.
get_mongo_error_count() {
  local since_date
  since_date=$(date -u -d "-$((CHECK_INTERVAL * 2)) seconds" '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || \
               date -u -v-$((CHECK_INTERVAL * 2))S '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || echo "")

  if [ -z "$since_date" ]; then
    echo "0"
    return
  fi

  local count
  count=$(mongosh --quiet --eval "
    db.getSiblingDB('$MONGO_DB').getCollection('$MONGO_ERROR_COLLECTION')
      .countDocuments({
        timestamp: { \$gte: new Date('$since_date') },
        status: 'error',
        type: { \$in: ['task_failed','tool_error','llm_call_failed','run_failed'] }
      })
  " 2>/dev/null || echo "0")

  echo "${count:-0}"
}

# ── Alert helper ──
send_alert() {
  local alert_type="$1"  # "rollback" or "promoted"
  local message="$2"
  local version
  version=$(cat "$ROLLBACK_DIR/.deploy-version" 2>/dev/null || echo "unknown")

  local emoji="✅"
  if [ "$alert_type" = "rollback" ]; then
    emoji="🚨"
  fi

  local text_msg="${emoji} <b>MASTRA WATCHDOG: ${alert_type^^}</b>\n\n${message}\n\n<b>Version:</b> <code>${version}</code>\n<b>Port:</b> <code>${LIVE_PORT}</code>"

  # n8n webhook alert
  if [ -n "$ALERT_WEBHOOK" ]; then
    log_wd "Sending alert via n8n webhook..."
    # Format zgodny z workflow Telegram Outbound Reply
    curl -sf -X POST "$ALERT_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{
        \"chatId\": \"578179283\",
        \"text\": \"$text_msg\",
        \"parse_mode\": \"HTML\"
      }" 2>/dev/null || log_warn "Alert webhook failed (non-critical)"
  fi

  # Mastra API fallback — próbuj wywołać endpoint diagnostyczny
  curl -sf -X POST "http://localhost:${LIVE_PORT}/deploy/watchdog-alert" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"$alert_type\",\"message\":\"$message\"}" 2>/dev/null || true
}

# ── Rollback procedure ──
do_rollback() {
  local reason="$1"

  log_error "═══════════════════════════════════════"
  log_error "  WATCHDOG ROLLBACK TRIGGERED!"
  log_error "  Reason: $reason"
  log_error "═══════════════════════════════════════"

  # 1. Kill current (broken) Live
  log_wd "Killing broken Live (PID $LIVE_PID)..."
  kill "$LIVE_PID" 2>/dev/null || true
  sleep 2
  kill -9 "$LIVE_PID" 2>/dev/null || true

  # Kill anything on the port
  local orphan
  orphan=$(lsof -ti :"$LIVE_PORT" 2>/dev/null || echo "")
  if [ -n "$orphan" ]; then
    kill "$orphan" 2>/dev/null || true
    sleep 1
  fi

  # 2. Restore from backup
  if [ -d "$ROLLBACK_DIR/output" ]; then
    log_wd "Restoring previous Live from $ROLLBACK_DIR..."
    local live_dir
    live_dir=$(cat "$ROLLBACK_DIR/.live-dir" 2>/dev/null || echo "/projekty/mastra-agentic-environment/agentic-agents")

    cd "$live_dir"
    PORT=$LIVE_PORT DEPLOY_SLOT=A node "$ROLLBACK_DIR/output/index.mjs" > "$DEPLOY_DIR/logs/rollback-$(date '+%Y-%m-%d_%H-%M-%S').log" 2>&1 &
    RESTORED_PID=$!
    echo "$RESTORED_PID" > "$DEPLOY_DIR/slot-a.pid"

    # Verify restored health
    sleep 5
    local restored_health
    restored_health=$(curl -sf "$HEALTH_URL" 2>/dev/null || echo "")
    if [ -n "$restored_health" ]; then
      log_ok "Live RESTORED successfully (PID $RESTORED_PID)"
      local old_version
      old_version=$(cat "$ROLLBACK_DIR/.deploy-version" 2>/dev/null || echo "unknown")
      log_ok "Running previous version: $old_version"
    else
      log_error "RESTORED Live is not responding! Manual intervention needed."
    fi
  else
    log_error "NO ROLLBACK BACKUP FOUND! Live is DOWN!"
  fi

  # 3. Send alert
  send_alert "rollback" "Auto-rollback triggered: $reason"

  # 4. Cleanup PID
  rm -f "$DEPLOY_DIR/watchdog.pid"

  exit 1
}

# ═══════════════════════════════════════════════════════════════════
#  Main monitoring loop
# ═══════════════════════════════════════════════════════════════════

CONSECUTIVE_FAILURES=0
CHECK_NUMBER=0

while [ $CHECK_NUMBER -lt $TOTAL_CHECKS ]; do
  sleep "$CHECK_INTERVAL"
  CHECK_NUMBER=$((CHECK_NUMBER + 1))

  ELAPSED=$((CHECK_NUMBER * CHECK_INTERVAL))
  REMAINING=$(( DURATION_SECONDS - ELAPSED ))

  # ── Check 1: Is the process alive? ──
  if ! kill -0 "$LIVE_PID" 2>/dev/null; then
    do_rollback "Live process (PID $LIVE_PID) is DEAD"
  fi

  # ── Check 2: Health endpoint ──
  HEALTH_RESPONSE=$(curl -sf --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "")
  if [ -z "$HEALTH_RESPONSE" ]; then
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    log_warn "Health check FAILED (attempt $CONSECUTIVE_FAILURES/$MAX_ERRORS) — remaining: ${REMAINING}s"

    if [ $CONSECUTIVE_FAILURES -ge $MAX_ERRORS ]; then
      do_rollback "Health check failed $MAX_ERRORS consecutive times"
    fi
    continue
  else
    # Reset consecutive failures on success
    if [ $CONSECUTIVE_FAILURES -gt 0 ]; then
      log_wd "Health recovered after $CONSECUTIVE_FAILURES failures"
    fi
    CONSECUTIVE_FAILURES=0
  fi

  # ── Check 3: Mongo error count ──
  ERROR_COUNT=$(get_mongo_error_count)
  if [ "$ERROR_COUNT" -gt "$MAX_ERRORS" ] 2>/dev/null; then
    do_rollback "Too many runtime errors in agent_events ($ERROR_COUNT in last $((CHECK_INTERVAL * 2))s, max: $MAX_ERRORS)"
  fi

  # ── Status report ──
  MINUTES_LEFT=$((REMAINING / 60))
  SECONDS_LEFT=$((REMAINING % 60))
  log_wd "Check $CHECK_NUMBER/$TOTAL_CHECKS — OK ✓ (errors: $ERROR_COUNT, remaining: ${MINUTES_LEFT}m${SECONDS_LEFT}s)"

done

# ═══════════════════════════════════════════════════════════════════
#  Observation period complete — PROMOTE
# ═══════════════════════════════════════════════════════════════════

log_ok "═══════════════════════════════════════"
log_ok "  WATCHDOG COMPLETE — VERSION PROMOTED ✅"
log_ok "  ${DURATION_MINUTES} minutes without issues"
log_ok "  Live: :$LIVE_PORT (PID $LIVE_PID)"
log_ok "═══════════════════════════════════════"

# Cleanup: opcjonalnie usuwamy stary backup (ale zachowujemy ostatni)
# Na razie zostawiamy — niech się zbierają, user może czyścić ręcznie.
# Przyszłościowo: rotacja max 5 backupów.

# Wyślij sukces alert
send_alert "promoted" "New version promoted after ${DURATION_MINUTES} minutes of stable operation"

# Cleanup PID
rm -f "$DEPLOY_DIR/watchdog.pid"

log_ok "Watchdog exiting. New version is stable."
