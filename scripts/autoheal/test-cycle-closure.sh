#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🧪 test-cycle-closure — antyregresja domknięcia cyklu (Etap 6)
#
#  Dowodzi, że sync-canon.sh:
#    A) ff-merge'uje kandydata do kanonu, resetuje repair lane do czysta
#       i przy spełnionym inwariancie (runtime==stable==source) kończy 0,
#    B) gdy inwariant jest złamany (runtime != source na slocie deploy),
#       kończy 1 i ustawia state=invariant_violation — BEZ dotykania Live.
#
#  PEŁNA IZOLACJA — wszystko w mktemp:
#    • tymczasowe repo-kanon (git init, branch master) — NIE prawdziwy REPO_DIR
#      (override przez AUTOHEAL_CANON_DIR),
#    • osobny repair lane (klon kanonu na autoheal/repair),
#    • własny .deploy / state / runtime (AUTOHEAL_DEPLOY_DIR/STATE_FILE/RUNTIME_DIR).
#  REALNE repo i REALNY :4111 nie są dotykane. Bez LLM/Mastry/Mongo.
#
#  Kod wyjścia: 0 = oba scenariusze OK, 1 = regresja.
# ═══════════════════════════════════════════════════════════════════

set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
t_log()  { echo -e "${CYAN}[TEST-CLOSURE]${NC} $1"; }
t_ok()   { echo -e "${GREEN}[TEST-CLOSURE ✅]${NC} $1"; }
t_warn() { echo -e "${YELLOW}[TEST-CLOSURE ⚠️]${NC} $1"; }
t_err()  { echo -e "${RED}[TEST-CLOSURE ❌]${NC} $1"; }

SANDBOX="$(mktemp -d /tmp/autoheal-closure.XXXXXX)"
FAILED=0
cleanup() { rm -rf "$SANDBOX" 2>/dev/null || true; }
trap cleanup EXIT

t_log "Sandbox: $SANDBOX"

# ── Tożsamość git tylko dla sandbox (nie ruszamy globalnego configu) ──
export GIT_AUTHOR_NAME="closure-test" GIT_AUTHOR_EMAIL="closure@test"
export GIT_COMMITTER_NAME="closure-test" GIT_COMMITTER_EMAIL="closure@test"

# ── Helper: świeży kanon + repair lane + stan, na potrzeby jednego scenariusza ──
# Zwraca (przez echo) "STABLE0 CANDIDATE1" — krótkie SHA.
build_fixture() {
  local root="$1"
  local canon="$root/canon" lane="$root/lane"
  rm -rf "$root"; mkdir -p "$canon"

  git -C "$canon" init -q -b master
  echo "v0" > "$canon/app.txt"
  git -C "$canon" add app.txt
  git -C "$canon" commit -q -m "stable0"
  local stable0; stable0="$(git -C "$canon" rev-parse --short HEAD)"

  echo "v1" > "$canon/app.txt"
  git -C "$canon" add app.txt
  git -C "$canon" commit -q -m "candidate1"
  local cand1; cand1="$(git -C "$canon" rev-parse --short HEAD)"

  # Kanon cofamy na stable0 (jak przed ff-merge); candidate1 wciąż osiągalny jako commit.
  git -C "$canon" reset -q --hard "$stable0"

  # Repair lane: klon kanonu (ma oba commity), gałąź autoheal/repair na stable0 + brud do sprzątnięcia.
  git clone -q "$canon" "$lane"
  git -C "$lane" fetch -q origin "$cand1" 2>/dev/null || true
  git -C "$lane" checkout -q -b autoheal/repair "$stable0"
  echo "dirty" > "$lane/UNCOMMITTED_GARBAGE.txt"          # untracked → clean -fdx ma usunąć
  echo "tampered" >> "$lane/app.txt"                       # tracked mod → reset --hard ma cofnąć

  echo "$stable0 $cand1"
}

# ── Helper: zapisz minimalny state file ──
write_state() {
  local file="$1" stable="$2" slot="$3"
  mkdir -p "$(dirname "$file")"
  cat > "$file" <<JSON
{
  "stableCommit": "$stable",
  "activeSlot": "$slot",
  "state": "stable"
}
JSON
}

# ── Helper: odczyt pola ze stanu ──
state_get() { python3 -c "import json;print(json.load(open('$1')).get('$2',''))" 2>/dev/null || echo ""; }

run_sync() {
  # run_sync <canon> <lane> <deploy_dir> <state_file> <runtime_dir> <commit>
  AUTOHEAL_CANON_DIR="$1" \
  AUTOHEAL_REPAIR_WORKTREE="$2" \
  AUTOHEAL_DEPLOY_DIR="$3" \
  AUTOHEAL_STATE_FILE="$4" \
  AUTOHEAL_RUNTIME_DIR="$5" \
  bash "$SELF_DIR/sync-canon.sh" "$6"
}

# ═══════════════════════════════════════════════════════════════════
#  SCENARIUSZ A — happy path: inwariant spełniony, cykl domknięty
# ═══════════════════════════════════════════════════════════════════
t_log "═══ Scenariusz A: inwariant spełniony (runtime==stable==source) ═══"
A="$SANDBOX/A"
read -r A_STABLE0 A_CAND1 <<< "$(build_fixture "$A")"
t_log "stable0=$A_STABLE0 candidate1=$A_CAND1"

A_DEPLOY="$A/.deploy"; A_STATE="$A_DEPLOY/state.json"; A_RUNTIME="$A_DEPLOY/runtime"
# Jak po mark-promoted: stableCommit już = candidate1, slot deploy aktywny.
write_state "$A_STATE" "$A_CAND1" "slot-a"
# runtime slot odpalony na candidate1 (.deploy-version = candidate1).
mkdir -p "$A_RUNTIME/slot-a"
echo "$A_CAND1" > "$A_RUNTIME/slot-a/.deploy-version"

if run_sync "$A/canon" "$A/lane" "$A_DEPLOY" "$A_STATE" "$A_RUNTIME" "$A_CAND1"; then
  A_RC=0; else A_RC=$?; fi
t_log "sync-canon exit=$A_RC"

A_CANON_HEAD="$(git -C "$A/canon" rev-parse --short HEAD)"
A_LANE_HEAD="$(git -C "$A/lane" rev-parse --short HEAD)"
A_LANE_DIRTY="$(git -C "$A/lane" status --porcelain 2>/dev/null)"
A_STATE_STABLE="$(state_get "$A_STATE" stableCommit)"
A_STATE_STATE="$(state_get "$A_STATE" state)"

A_PASS=1
[ "$A_RC" -eq 0 ]                  || { t_err "A: oczekiwano exit 0, jest $A_RC"; A_PASS=0; }
[ "$A_CANON_HEAD" = "$A_CAND1" ]   || { t_err "A: kanon HEAD=$A_CANON_HEAD != candidate1=$A_CAND1"; A_PASS=0; }
[ "$A_LANE_HEAD" = "$A_CAND1" ]    || { t_err "A: lane HEAD=$A_LANE_HEAD != candidate1=$A_CAND1"; A_PASS=0; }
[ -z "$A_LANE_DIRTY" ]             || { t_err "A: repair lane NIE czysty: $A_LANE_DIRTY"; A_PASS=0; }
[ "$A_STATE_STABLE" = "$A_CAND1" ] || { t_err "A: state.stableCommit=$A_STATE_STABLE != candidate1"; A_PASS=0; }
[ "$A_STATE_STATE" = "stable" ]    || { t_err "A: state.state=$A_STATE_STATE != stable"; A_PASS=0; }

if [ "$A_PASS" -eq 1 ]; then
  t_ok "Scenariusz A: kanon ff→candidate1, lane czysty, inwariant OK, exit 0."
else
  t_err "Scenariusz A: REGRESJA."; FAILED=1
fi

# ═══════════════════════════════════════════════════════════════════
#  SCENARIUSZ B — inwariant złamany: runtime != source na slocie deploy
# ═══════════════════════════════════════════════════════════════════
t_log "═══ Scenariusz B: inwariant złamany (runtime=stable0, source=candidate1) ═══"
B="$SANDBOX/B"
read -r B_STABLE0 B_CAND1 <<< "$(build_fixture "$B")"
t_log "stable0=$B_STABLE0 candidate1=$B_CAND1"

B_DEPLOY="$B/.deploy"; B_STATE="$B_DEPLOY/state.json"; B_RUNTIME="$B_DEPLOY/runtime"
# Stan jak po mark-promoted (stable=candidate1), ALE runtime slot wciąż na STARYM stable0
# → po ff-merge kanonu na candidate1 inwariant runtime==source pęka.
write_state "$B_STATE" "$B_CAND1" "slot-a"
mkdir -p "$B_RUNTIME/slot-a"
echo "$B_STABLE0" > "$B_RUNTIME/slot-a/.deploy-version"   # ← rozjazd

if run_sync "$B/canon" "$B/lane" "$B_DEPLOY" "$B_STATE" "$B_RUNTIME" "$B_CAND1"; then
  B_RC=0; else B_RC=$?; fi
t_log "sync-canon exit=$B_RC"

B_STATE_STATE="$(state_get "$B_STATE" state)"
B_PASS=1
[ "$B_RC" -eq 1 ]                          || { t_err "B: oczekiwano exit 1, jest $B_RC"; B_PASS=0; }
[ "$B_STATE_STATE" = "invariant_violation" ] || { t_err "B: state.state=$B_STATE_STATE != invariant_violation"; B_PASS=0; }

if [ "$B_PASS" -eq 1 ]; then
  t_ok "Scenariusz B: inwariant wykryty, exit 1, state=invariant_violation."
else
  t_err "Scenariusz B: REGRESJA."; FAILED=1
fi

# ═══════════════════════════════════════════════════════════════════
echo ""
if [ "$FAILED" -eq 0 ]; then
  t_ok "═══ WSZYSTKIE SCENARIUSZE PRZESZŁY — domknięcie cyklu działa, realne repo nietknięte. ═══"
  exit 0
else
  t_err "═══ REGRESJA — zob. wyżej. ═══"
  exit 1
fi
