#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🎼 run-deploy — cienki orchestrator kroków blue-green (Etap 4)
#
#  Składa idempotentne kroki w jeden przepływ:
#    build-candidate → start-candidate → verify-candidate
#      [→ promote-candidate → canary-watch → mark-promoted]   (poza --dry-run)
#
#  Gdy canary po promote zawiedzie → rollback-to-stable (Etap 5).
#
#  Użycie:
#    run-deploy.sh [commit|ref] [--dry-run]
#      commit: domyślnie HEAD source repo
#      --dry-run: tylko build+start+verify na porcie staging, BEZ swapu na Live
#
#  Każdy krok to osobny skrypt z własnym kodem wyjścia — orchestrator
#  jedynie je łączy i przerywa na pierwszym błędzie.
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="DEPLOY"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/lib.sh"
read_deploy_config

REF="HEAD"; DRY=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY="--dry-run" ;;
    -*) warn "Nieznana flaga: $a (ignoruję)" ;;
    *) REF="$a" ;;
  esac
done

COMMIT="$(resolve_commit "$REF")"
SLOT="slot-b"   # buduj na nieaktywnym slocie
log "═══ run-deploy: commit=$COMMIT slot=$SLOT mode=${DRY:-production} ═══"

bash "$SELF_DIR/build-candidate.sh" "$COMMIT" "$SLOT"        || { err "build-candidate fail"; exit 1; }
bash "$SELF_DIR/start-candidate.sh" "$SLOT" "$STAGING_PORT"  || { err "start-candidate fail"; exit 1; }

if ! bash "$SELF_DIR/verify-candidate.sh" "$STAGING_PORT" "$HEALTH_TIMEOUT"; then
  err "verify-candidate fail — zatrzymuję kandydata, Live nietknięty."
  P="$(cat "$(slot_pidfile "$SLOT")" 2>/dev/null || echo "")"
  pid_alive "$P" && kill "$P" 2>/dev/null || true
  exit 1
fi

if [ "$DRY" = "--dry-run" ]; then
  P="$(cat "$(slot_pidfile "$SLOT")" 2>/dev/null || echo "")"
  pid_alive "$P" && { kill "$P" 2>/dev/null || true; rm -f "$(slot_pidfile "$SLOT")"; }
  ok "DRY-RUN OK — kandydat $COMMIT zbudowany i zdrowy na :$STAGING_PORT. Brak swapu na Live."
  exit 0
fi

# ── Promote: swap kandydata na Live (+ auto-rollback przy post-swap verify) ──
bash "$SELF_DIR/promote-candidate.sh" "$SLOT" || { err "promote-candidate fail (rollback w kroku)"; exit 1; }

# ── Canary: agresywne okno obserwacji świeżego Live. FAIL → deterministyczny rollback. ──
if ! bash "$SELF_DIR/canary-watch.sh" "$LIVE_PORT" "${AUTOHEAL_CANARY_SECONDS:-60}"; then
  err "canary FAIL — uruchamiam rollback-to-stable…"
  if bash "$SELF_DIR/rollback-to-stable.sh"; then
    err "═══ run-deploy ROLLED BACK — Live :$LIVE_PORT przywrócony na stable ═══"
    exit 1
  else
    err "═══ run-deploy KRYTYCZNE — rollback także zawiódł, wymagana interwencja ═══"
    exit 2
  fi
fi

# ── Canary OK → finalizacja ──
bash "$SELF_DIR/mark-promoted.sh" "$COMMIT" "$SLOT"

# ── Domknięcie cyklu (Etap 6): sync kanonu + reset repair lane + inwariant ──
# Gated flagą (domyślnie OFF). Niepowodzenie NIE wywraca udanego deployu — Live już działa.
if [ "${AUTOHEAL_SYNC_CANON:-false}" = "true" ]; then
  if bash "$SELF_DIR/sync-canon.sh" "$COMMIT"; then
    ok "Domknięcie cyklu OK — kanon zsynchronizowany na $COMMIT."
  else
    SC_RC=$?
    warn "sync-canon zwrócił $SC_RC — deploy POZOSTAJE udany (Live na $COMMIT), ale kanon/lane wymaga uwagi."
  fi
else
  log "AUTOHEAL_SYNC_CANON!=true — pomijam domknięcie cyklu (kanon nie ruszany)."
fi

ok "═══ run-deploy COMPLETE — Live :$LIVE_PORT na $COMMIT (canary przeszedł) ═══"
exit 0
