#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  ✅ mark-promoted — finalizuje udany promote po canary
#
#  Użycie:
#    mark-promoted.sh <commit> [slot]
#
#  Po przejściu canary: ustawia w stanie nowy stableCommit, lastPromotedAt
#  oraz aktywny slot, czyści candidate/rollbackDeadline, state=stable.
#  Czysta operacja na pliku stanu (Mongo-niezależna).
#
#  Kod wyjścia: 0 zawsze (poza błędem argumentów).
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="MARK"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_deploy_config

COMMIT="${1:-}"
SLOT="${2:-}"
[ -z "$COMMIT" ] && { err "Użycie: mark-promoted.sh <commit> [slot]"; exit 1; }

NOW="$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")"
PATCH="{\"stableCommit\":\"$COMMIT\",\"lastPromotedAt\":\"$NOW\",\"candidateCommit\":null,\"rollbackDeadline\":null,\"state\":\"stable\""
case "$SLOT" in slot-a|slot-b) PATCH="$PATCH,\"activeSlot\":\"$SLOT\"" ;; esac
PATCH="$PATCH}"

state_merge "$PATCH"
ok "Oznaczono promote: stableCommit=$COMMIT lastPromotedAt=$NOW${SLOT:+ slot=$SLOT}."
exit 0
