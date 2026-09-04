#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🧪 test-retry-loop — antyregresja pętli ponawiania (Etap 7)
#
#  Dowodzi, że retry-deploy.sh:
#    A) gdy KAŻDY candidate pada (rollback OK, rc=1) → po MAX_ATTEMPTS
#       kończy 1, ustawia state=failed_needs_human, loguje N prób. Stable żyje.
#    B) gdy któraś próba przejdzie (rc=0) → kończy 0, BEZ failed_needs_human,
#       loguje tylko tyle prób, ile było potrzeba.
#    C) gdy próba zwróci rc=2 (rollback ZAWIÓDŁ) → natychmiastowy stop,
#       exit 2, state=failed_needs_human, BEZ dalszych prób (fatalny).
#
#  PEŁNA IZOLACJA: realny run-deploy.sh podmieniony atrapą (AUTOHEAL_RUN_DEPLOY),
#  własny .deploy / state / attempts-log. Bez LLM/Mastry/Mongo. REALNY :4111 nietknięty.
#
#  Kod wyjścia: 0 = wszystkie scenariusze OK, 1 = regresja.
# ═══════════════════════════════════════════════════════════════════

set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
t_log() { echo -e "${CYAN}[TEST-RETRY]${NC} $1"; }
t_ok()  { echo -e "${GREEN}[TEST-RETRY ✅]${NC} $1"; }
t_err() { echo -e "${RED}[TEST-RETRY ❌]${NC} $1"; }

SANDBOX="$(mktemp -d /tmp/autoheal-retry.XXXXXX)"
FAILED=0
cleanup() { rm -rf "$SANDBOX" 2>/dev/null || true; }
trap cleanup EXIT
t_log "Sandbox: $SANDBOX"

state_get() { python3 -c "import json;print(json.load(open('$1')).get('$2',''))" 2>/dev/null || echo ""; }
count_attempts() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

# ── Atrapa run-deploy: zwraca kod wg pliku-scenariusza ──
#   Plik $FAKE_PLAN zawiera kody wyjścia po jednym w linii; atrapa zużywa kolejne.
make_fake_run_deploy() {
  local path="$1" plan="$2" counter="$3"
  cat > "$path" <<EOF
#!/usr/bin/env bash
# atrapa run-deploy — odczytuje kolejny kod wyjścia z planu
n=\$(cat "$counter" 2>/dev/null || echo 0)
n=\$((n + 1))
echo "\$n" > "$counter"
rc=\$(sed -n "\${n}p" "$plan")
[ -z "\$rc" ] && rc=1
echo "[FAKE-DEPLOY] wywołanie \$n → exit \$rc"
exit "\$rc"
EOF
  chmod +x "$path"
}

run_scenario() {
  # run_scenario <name> <max> <plan-multiline> <expected-rc> <expected-state> <expected-attempt-count>
  local name="$1" max="$2" plan_str="$3" exp_rc="$4" exp_state="$5" exp_count="$6"
  local dir="$SANDBOX/$name"
  mkdir -p "$dir"
  local deploy="$dir/.deploy"; mkdir -p "$deploy"
  local state="$deploy/state.json"
  local attempts="$deploy/attempts.jsonl"
  local plan="$dir/plan.txt"; printf '%s\n' "$plan_str" > "$plan"
  local counter="$dir/counter.txt"
  local fake="$dir/fake-run-deploy.sh"
  make_fake_run_deploy "$fake" "$plan" "$counter"

  # stan startowy: stable żyje
  printf '{\n  "stableCommit": "stable0",\n  "activeSlot": "slot-a",\n  "state": "stable"\n}\n' > "$state"

  AUTOHEAL_DEPLOY_DIR="$deploy" \
  AUTOHEAL_STATE_FILE="$state" \
  AUTOHEAL_ATTEMPTS_LOG="$attempts" \
  AUTOHEAL_RUN_DEPLOY="$fake" \
  AUTOHEAL_MAX_ATTEMPTS="$max" \
  AUTOHEAL_RETRY_BACKOFF_SECONDS="0" \
  AUTOHEAL_LOCAL_FALLBACK_ENABLED="false" \
    bash "$SELF_DIR/retry-deploy.sh" "testcommit" >/dev/null 2>&1
  local rc=$?

  local got_state; got_state="$(state_get "$state" state)"
  local got_count; got_count="$(count_attempts "$attempts")"

  local pass=1
  [ "$rc" -eq "$exp_rc" ]            || { t_err "$name: exit=$rc oczekiwano $exp_rc"; pass=0; }
  [ "$got_state" = "$exp_state" ]    || { t_err "$name: state=$got_state oczekiwano $exp_state"; pass=0; }
  [ "$got_count" -eq "$exp_count" ]  || { t_err "$name: prób=$got_count oczekiwano $exp_count"; pass=0; }

  if [ "$pass" -eq 1 ]; then
    t_ok "$name: exit=$rc state=$got_state prób=$got_count — OK."
  else
    t_err "$name: REGRESJA."; FAILED=1
  fi
}

# ═══ Scenariusz A: każdy candidate pada (3× rc=1), max=3 → failed_needs_human, 3 próby ═══
t_log "═══ A: wszystkie próby nieudane (rollback OK) ═══"
run_scenario "A" 3 $'1\n1\n1' 1 "failed_needs_human" 3

# ═══ Scenariusz B: 2. próba przechodzi (rc=1, rc=0), max=3 → stable, 2 próby ═══
t_log "═══ B: druga próba przechodzi ═══"
run_scenario "B" 3 $'1\n0\n0' 0 "stable" 2

# ═══ Scenariusz C: 1. próba rc=2 (rollback padł) → fatalny stop, 1 próba ═══
t_log "═══ C: rollback zawiódł (rc=2) — fatalny stop ═══"
run_scenario "C" 3 $'2\n0\n0' 2 "failed_needs_human" 1

echo ""
if [ "$FAILED" -eq 0 ]; then
  t_ok "═══ WSZYSTKIE SCENARIUSZE PRZESZŁY — pętla ponawiania działa, brak nieskończonej pętli. ═══"
  exit 0
else
  t_err "═══ REGRESJA — zob. wyżej. ═══"
  exit 1
fi
