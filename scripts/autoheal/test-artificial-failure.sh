#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🧪 test-artificial-failure — Etap 5.4: celowo zepsuty candidate → auto-rollback
#
#  Dowodzi, że deterministyczny rollback działa BEZ Mastry/LLM/Mongo, na REALNYCH
#  krokach (promote-candidate · canary-watch · rollback-to-stable). Runtime jest
#  podstawiony LEKKIMI fake-serwerami (node http), więc test jest szybki i nie
#  wymaga `mastra build`.
#
#  ⚠️ IZOLACJA: własny katalog .deploy (mktemp), własny stan, własne porty
#  (4555/4556). REALNY Live :4111 NIE jest dotykany w żaden sposób.
#
#  Scenariusze:
#    A) candidate NIE bind-uje portu  → promote-candidate post-swap verify FAIL
#       → auto-rollback → stable znów zdrowy.
#    B) candidate zdrowy przy swapie, ale UMIERA w trakcie canary
#       → canary-watch FAIL → rollback-to-stable → stable znów zdrowy.
#
#  Kod wyjścia: 0 = oba scenariusze OK (rollback przywrócił stable), 1 = regresja.
# ═══════════════════════════════════════════════════════════════════

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
tlog()  { echo -e "${CYAN}[TEST]${NC} $1"; }
tok()   { echo -e "${GREEN}[TEST ✅]${NC} $1"; }
twarn() { echo -e "${YELLOW}[TEST ⚠️]${NC} $1"; }
terr()  { echo -e "${RED}[TEST ❌]${NC} $1"; }

LIVE_PORT=4555
STAGING_PORT=4556

# ── Sandbox ──
SBX="$(mktemp -d /tmp/autoheal-test.XXXXXX)"
export AUTOHEAL_DEPLOY_DIR="$SBX/.deploy"
export AUTOHEAL_RUNTIME_DIR="$SBX/.deploy/runtime"
export AUTOHEAL_STATE_FILE="$SBX/.deploy/autoheal-state.json"
export AUTOHEAL_CONFIG_FILE="$SBX/deploy.config.json"
export AUTOHEAL_CANARY_SECONDS=20
mkdir -p "$AUTOHEAL_RUNTIME_DIR/slot-a/.mastra/output" \
         "$AUTOHEAL_RUNTIME_DIR/slot-b/.mastra/output" \
         "$AUTOHEAL_DEPLOY_DIR/logs"

FAILED=0
cleanup() {
  for p in "$LIVE_PORT" "$STAGING_PORT"; do
    pid="$(lsof -ti :"$p" 2>/dev/null | head -n1 || echo "")"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$SBX"
}
trap cleanup EXIT INT TERM

# Upewnij się, że porty testowe są wolne na starcie
for p in "$LIVE_PORT" "$STAGING_PORT"; do
  pid="$(lsof -ti :"$p" 2>/dev/null | head -n1 || echo "")"
  [ -n "$pid" ] && { twarn "Port $p zajęty (PID $pid) — zwalniam"; kill "$pid" 2>/dev/null || true; sleep 1; }
done

# ── Config sandbox (porty testowe, krótki health timeout) ──
cat > "$AUTOHEAL_CONFIG_FILE" <<JSON
{
  "slots": {
    "A": { "label": "live",    "dir": "$AUTOHEAL_RUNTIME_DIR/slot-a", "port": $LIVE_PORT,    "pidFile": "$AUTOHEAL_DEPLOY_DIR/slot-a.pid" },
    "B": { "label": "staging", "dir": "$AUTOHEAL_RUNTIME_DIR/slot-b", "port": $STAGING_PORT, "pidFile": "$AUTOHEAL_DEPLOY_DIR/slot-b.pid" }
  },
  "healthCheck": { "endpoint": "/health", "customEndpoint": "/deploy/health", "timeoutMs": 15000, "intervalMs": 2000, "requiredSuccesses": 1 },
  "observability": { "livePath": "$AUTOHEAL_RUNTIME_DIR/slot-a/storage/mastra-observability.duckdb", "candidatePath": ":memory:", "probeEndpoint": "/api/observability/feedback?perPage=1" },
  "watchdog": { "maxErrorsBeforeRollback": 3, "mongoDb": "agentforge", "mongoErrorCollection": "agent_events" },
  "rollback": { "backupDir": "$AUTOHEAL_DEPLOY_DIR/rollback", "logDir": "$AUTOHEAL_DEPLOY_DIR/logs" }
}
JSON

# ── Fake runtime: healthy server ──
cat > "$AUTOHEAL_RUNTIME_DIR/slot-a/.mastra/output/index.mjs" <<'JS'
import http from 'node:http';
const port = Number(process.env.PORT || 4555);
const version = process.env.FAKE_VERSION || 'stable0';
const slot = process.env.DEPLOY_SLOT || 'A';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ success: true })); }
  if (req.url === '/deploy/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ success: true, version, slot })); }
  if (req.url?.startsWith('/api/observability/feedback')) { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ pagination: { total: 0, page: 0, perPage: 1, hasMore: false }, feedback: [] })); }
  res.writeHead(404); res.end();
}).listen(port, () => console.log('[fake-healthy] listening :' + port + ' v=' + version));
JS
echo "stable0" > "$AUTOHEAL_RUNTIME_DIR/slot-a/.deploy-version"
printf '%s\n' \
  'OBSERVABILITY_RETENTION_ENABLED=true' \
  'OBSERVABILITY_RETENTION_DAYS=3' \
  'OBSERVABILITY_RETENTION_TOKEN=test-only-token' \
  > "$AUTOHEAL_RUNTIME_DIR/slot-a/.env"
chmod 600 "$AUTOHEAL_RUNTIME_DIR/slot-a/.env"

# ── Helpers ──
health_ok() { curl -sf --max-time 4 "http://localhost:$1/health" 2>/dev/null | grep -q '"success":true'; }
state_get() { python3 -c "import json;print(json.load(open('$AUTOHEAL_STATE_FILE')).get('$1',''))" 2>/dev/null || echo ""; }
runtime_env_ok() {
  cmp -s "$AUTOHEAL_RUNTIME_DIR/slot-a/.env" "$AUTOHEAL_RUNTIME_DIR/slot-b/.env" \
    && [ "$(stat -c '%a' "$AUTOHEAL_RUNTIME_DIR/slot-b/.env" 2>/dev/null || echo '')" = "600" ]
}

start_live_stable() {
  # Start healthy slot-a na LIVE_PORT i ustaw stan jak po normalnym starcie.
  # Najpierw zwolnij porty po ewentualnym poprzednim scenariuszu.
  for p in "$LIVE_PORT" "$STAGING_PORT"; do
    pid="$(lsof -ti :"$p" 2>/dev/null | head -n1 || echo "")"
    [ -n "$pid" ] && { kill "$pid" 2>/dev/null || true; sleep 1; kill -9 "$pid" 2>/dev/null || true; }
  done
  rm -f "$AUTOHEAL_DEPLOY_DIR/slot-a.pid" "$AUTOHEAL_DEPLOY_DIR/slot-b.pid"
  ( cd "$AUTOHEAL_RUNTIME_DIR/slot-a"; FAKE_VERSION=stable0 PORT=$LIVE_PORT DEPLOY_SLOT=A \
      node .mastra/output/index.mjs > "$AUTOHEAL_DEPLOY_DIR/logs/live-init.log" 2>&1 & echo $! > "$AUTOHEAL_DEPLOY_DIR/slot-a.pid" )
  python3 - <<PY
import json
json.dump({"stableCommit":"stable0","activeSlot":"slot-a","activePid":int(open("$AUTOHEAL_DEPLOY_DIR/slot-a.pid").read()),
           "activePort":$LIVE_PORT,"lastPromotedAt":None,"state":"stable","updatedAt":"2026-06-08T00:00:00.000Z"},
          open("$AUTOHEAL_STATE_FILE","w"), indent=2)
PY
  for _ in $(seq 1 10); do health_ok "$LIVE_PORT" && return 0; sleep 1; done
  return 1
}

assert_recovered() {
  # Po rollbacku: Live zdrowy, slot=slot-a, stableCommit=stable0
  local label="$1"
  if health_ok "$LIVE_PORT" && [ "$(state_get activeSlot)" = "slot-a" ]; then
    tok "$label — rollback przywrócił stable (:$LIVE_PORT zdrowy, slot=slot-a, stable=$(state_get stableCommit))"
    return 0
  fi
  terr "$label — REGRESJA: Live niezdrowy lub stan nie wrócił na slot-a (slot=$(state_get activeSlot) health=$(health_ok "$LIVE_PORT" && echo ok || echo FAIL))"
  return 1
}

# ═══════════════════════════════════════════════════════════════════
tlog "═══ PRECHECK — idempotentny build odświeża runtime .env ═══"
cp "$AUTOHEAL_RUNTIME_DIR/slot-a/.mastra/output/index.mjs" \
  "$AUTOHEAL_RUNTIME_DIR/slot-b/.mastra/output/index.mjs"
echo "HEAD" > "$AUTOHEAL_RUNTIME_DIR/slot-b/.deploy-version"
if bash "$SELF_DIR/build-candidate.sh" HEAD slot-b >/dev/null 2>&1 && runtime_env_ok; then
  tok "Runtime .env zsynchronizowany także na fast-path; treść zgodna, tryb 0600."
else
  terr "Runtime .env NIE został poprawnie zsynchronizowany przez build-candidate."
  FAILED=1
fi

# Statyczny kontrakt monolitycznego emergency rollbacku. Nie uruchamia deployu;
# dowodzi kolejności: stop → orphan cleanup → unlock → start → pełna readiness.
if MONOLITH="$SELF_DIR/../deploy-blue-green.sh" python3 - <<'PY'
import os
from pathlib import Path

src = Path(os.environ['MONOLITH']).read_text()
emergency = src[src.index('POST-SWAP HEALTH CHECK FAILED!'):]
required_in_order = [
    'stop_pid_bounded "$NEW_LIVE_PID"',
    'lsof -tiTCP:"$LIVE_PORT" -sTCP:LISTEN',
    'wait_live_observability_unlock 15',
    'MASTRA_DUCKDB_PATH="$LIVE_OBSERVABILITY_PATH"',
    'if wait_full_readiness "$LIVE_PORT"',
    'Live restored and ready',
]
positions = [emergency.index(token) for token in required_in_order]
assert positions == sorted(positions), positions
assert 'Live restored from backup' not in emergency
PY
then
  tok "Monolith rollback: bounded stop, orphan cleanup, unlock i pełna readiness — kontrakt OK."
else
  terr "Monolith rollback nie spełnia kontraktu bezpieczeństwa."
  FAILED=1
fi

# ═══════════════════════════════════════════════════════════════════
tlog "═══ SCENARIUSZ A — candidate NIE bind-uje portu ═══"
# slot-b: proces żyje, ale nigdy nie bind-uje (jak blocker ERR_AMBIGUOUS)
cat > "$AUTOHEAL_RUNTIME_DIR/slot-b/.mastra/output/index.mjs" <<'JS'
console.log('[fake-broken] alive but NEVER binding a port');
setInterval(() => {}, 1 << 30);
JS
echo "brokenA" > "$AUTOHEAL_RUNTIME_DIR/slot-b/.deploy-version"

if ! start_live_stable; then terr "Setup A: stable nie wstał"; FAILED=1; else
  tlog "stable Live zdrowy na :$LIVE_PORT (PID $(cat "$AUTOHEAL_DEPLOY_DIR/slot-a.pid"))"
  # promote slot-b → post-swap verify FAIL → promote sam woła rollback-to-stable
  bash "$SELF_DIR/promote-candidate.sh" slot-b
  rc=$?
  tlog "promote-candidate exit=$rc (oczekiwane 1 = wykonano rollback)"
  assert_recovered "Scenariusz A" || FAILED=1
fi

# ═══════════════════════════════════════════════════════════════════
tlog "═══ SCENARIUSZ B — candidate UMIERA w trakcie canary ═══"
# slot-b: bind-uje i jest zdrowy, ale po DIE_AFTER_MS kończy proces (symulacja crashu)
cat > "$AUTOHEAL_RUNTIME_DIR/slot-b/.mastra/output/index.mjs" <<'JS'
import http from 'node:http';
const port = Number(process.env.PORT || 4555);
http.createServer((req, res) => {
  res.writeHead(200, {'content-type':'application/json'});
  if (req.url?.startsWith('/api/observability/feedback')) {
    return res.end(JSON.stringify({ pagination: { total: 0, page: 0, perPage: 1, hasMore: false }, feedback: [] }));
  }
  res.end(JSON.stringify({ success: true }));
})
  .listen(port, () => console.log('[fake-dying] listening :' + port));
setTimeout(() => { console.error('[fake-dying] exiting to simulate canary crash'); process.exit(1); }, Number(process.env.DIE_AFTER_MS || 6000));
JS
echo "brokenB" > "$AUTOHEAL_RUNTIME_DIR/slot-b/.deploy-version"

if ! start_live_stable; then terr "Setup B: stable nie wstał"; FAILED=1; else
  tlog "stable Live zdrowy na :$LIVE_PORT (PID $(cat "$AUTOHEAL_DEPLOY_DIR/slot-a.pid"))"
  # promote: post-swap verify przejdzie (candidate bind-uje), state=canary
  DIE_AFTER_MS=6000 bash "$SELF_DIR/promote-candidate.sh" slot-b
  tlog "promote exit=$? — candidate na Live, wchodzę w canary…"
  # canary: candidate umrze ~6s → canary FAIL → rollback
  if bash "$SELF_DIR/canary-watch.sh" "$LIVE_PORT" 20; then
    terr "Scenariusz B — canary NIE wykrył śmierci candidate (regresja)"; FAILED=1
  else
    tlog "canary poprawnie zgłosił FAIL — uruchamiam rollback-to-stable"
    bash "$SELF_DIR/rollback-to-stable.sh" >/dev/null 2>&1 || true
    assert_recovered "Scenariusz B" || FAILED=1
  fi
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  tok "═══ WSZYSTKIE SCENARIUSZE OK — auto-rollback działa, stable nietknięty ═══"
  exit 0
else
  terr "═══ REGRESJA — patrz logi powyżej ═══"
  exit 1
fi
