#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🔎 verify-candidate — health-check kandydata (READ-ONLY)
#
#  Użycie:
#    verify-candidate.sh <port> [timeout_s]
#
#  Czeka aż /health odpowie sukcesem ORAZ aż odczyt z domeny observability
#  przejdzie (max timeout). Nic nie zmienia, niczego nie ubija — czysta
#  weryfikacja. Drukuje /deploy/health jeśli jest.
#
#  Kod wyjścia: 0 = zdrowy, 1 = nie wstał w czasie.
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="VERIFY"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_deploy_config
validate_observability_paths

PORT="${1:-}"
TIMEOUT="${2:-$HEALTH_TIMEOUT}"
[ -z "$PORT" ] && { err "Użycie: verify-candidate.sh <port> [timeout_s]"; exit 1; }

log "Weryfikacja readiness :$PORT (HTTP + observability, max ${TIMEOUT}s, interwał ${HEALTH_INTERVAL}s)…"
if wait_ready "$PORT" "$TIMEOUT" "$HEALTH_INTERVAL"; then
  ok "Kandydat gotowy na :$PORT — /health i observability działają."
  DH="$(curl -sf --max-time 5 "http://localhost:${PORT}/deploy/health" 2>/dev/null || echo "")"
  [ -n "$DH" ] && { log "/deploy/health:"; echo "$DH" | python3 -m json.tool 2>/dev/null || echo "$DH"; }
  exit 0
else
  err "Kandydat NIE osiągnął pełnej readiness na :$PORT w ${TIMEOUT}s."
  exit 1
fi
