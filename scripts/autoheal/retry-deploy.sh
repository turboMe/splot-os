#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🔁 retry-deploy — kontrolowana pętla ponawiania (Etap 7)
#
#  Użycie:
#    retry-deploy.sh [commit|ref] [--dry-run]
#
#  Owija deterministyczny run-deploy.sh w pętlę z LIMITEM prób, backoffem,
#  klasyfikacją błędów i zapisem każdej próby — żeby NIGDY nie wpaść w
#  nieskończoną pętlę build→promote→rollback. WSZYSTKO bez LLM/Mastry/Mongo
#  (limit i stan żyją w pliku; Ollama-fallback jest best-effort i opcjonalny).
#
#  7.1  Po każdej próbie: append do .deploy/autoheal-attempts.jsonl
#       (attemptId, ts, commit, exitCode, failureReason) + state_merge.
#  7.2  Limit AUTOHEAL_MAX_ATTEMPTS (domyślnie 2), backoff między próbami,
#       klasyfikacja: rc=2 (rollback też padł) = FATALNY → natychmiastowy stop.
#       Po wyczerpaniu prób przy rc=1 → state=failed_needs_human.
#  7.3  Po wyczerpaniu prób: opcjonalny local-fallback.sh (Ollama, best-effort) —
#       tylko gdy stable NIE wstaje. NIE robi promote/rollback. Włącz flagą.
#
#  Kody wyjścia:
#    0 = któraś próba przeszła (Live na nowej wersji)
#    1 = wyczerpano próby, każdy candidate rolled back → failed_needs_human
#        (STABLE ŻYJE — rollback zadziałał za każdym razem)
#    2 = FATALNY — rollback zawiódł w którejś próbie (wymagana interwencja)
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="RETRY"
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

MAX_ATTEMPTS="${AUTOHEAL_MAX_ATTEMPTS:-2}"
if ! [ "$MAX_ATTEMPTS" -ge 1 ] 2>/dev/null; then MAX_ATTEMPTS=1; fi
BACKOFF="${AUTOHEAL_RETRY_BACKOFF_SECONDS:-5}"
if ! [ "$BACKOFF" -ge 0 ] 2>/dev/null; then BACKOFF=0; fi
ATTEMPTS_LOG="${AUTOHEAL_ATTEMPTS_LOG:-$DEPLOY_DIR/autoheal-attempts.jsonl}"
# Override'y delegatów — produkcyjnie domyślne; nadpisywane tylko w testach sandbox.
RUN_DEPLOY="${AUTOHEAL_RUN_DEPLOY:-$SELF_DIR/run-deploy.sh}"
LOCAL_FALLBACK="${AUTOHEAL_LOCAL_FALLBACK:-$SELF_DIR/local-fallback.sh}"

# ── Rejestracja jednej próby (JSONL, append, atomowość na poziomie linii) ──
record_attempt() {
  # record_attempt <attemptId> <n> <commit> <exitCode> <reason>
  local id="$1" n="$2" commit="$3" rc="$4" reason="$5"
  mkdir -p "$DEPLOY_DIR"
  ATT_ID="$id" ATT_N="$n" ATT_COMMIT="$commit" ATT_RC="$rc" ATT_REASON="$reason" ATT_LOG="$ATTEMPTS_LOG" \
  python3 - <<'PY'
import json, os, datetime
rec = {
  "attemptId": os.environ["ATT_ID"],
  "attempt": int(os.environ["ATT_N"]),
  "commit": os.environ["ATT_COMMIT"],
  "exitCode": int(os.environ["ATT_RC"]),
  "failureReason": os.environ["ATT_REASON"] or None,
  "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
}
with open(os.environ["ATT_LOG"], "a") as f:
    f.write(json.dumps(rec) + "\n")
PY
}

reason_for_rc() {
  case "$1" in
    0) echo "" ;;
    1) echo "candidate_failed_rolled_back" ;;
    2) echo "rollback_failed" ;;
    *) echo "unknown_exit_$1" ;;
  esac
}

log "═══ retry-deploy: ref=$REF max=$MAX_ATTEMPTS backoff=${BACKOFF}s mode=${DRY:-production} ═══"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  COMMIT="$(resolve_commit "$REF")"   # re-resolve co próbę: repair lane mógł wypchnąć nowy commit
  ATTEMPT_ID="heal-attempt-$(date -u '+%Y%m%dT%H%M%S')-$attempt"
  log "── Próba $attempt/$MAX_ATTEMPTS (commit=$COMMIT, id=$ATTEMPT_ID) ──"
  state_merge "{\"state\":\"retrying\",\"attemptCount\":$attempt,\"lastAttemptId\":\"$ATTEMPT_ID\",\"candidateCommit\":\"$COMMIT\"}"

  # set -e (z lib.sh) NIE może przerwać pętli przy niezerowym rc — łapiemy jawnie.
  if bash "$RUN_DEPLOY" "$REF" ${DRY:+$DRY}; then rc=0; else rc=$?; fi
  REASON="$(reason_for_rc "$rc")"
  record_attempt "$ATTEMPT_ID" "$attempt" "$COMMIT" "$rc" "$REASON"

  case "$rc" in
    0)
      ok "Próba $attempt PRZESZŁA (rc=0) — Live na nowej wersji. Czyszczę stan prób."
      state_merge "{\"state\":\"stable\",\"failureReason\":\"\"}"
      exit 0 ;;
    2)
      err "Próba $attempt: rc=2 (rollback ZAWIÓDŁ) — błąd FATALNY, przerywam pętlę."
      state_merge "{\"state\":\"failed_needs_human\",\"failureReason\":\"$REASON\"}"
      exit 2 ;;
    1)
      warn "Próba $attempt: candidate nieudany, rollback OK (stable żyje)."
      ;;
    *)
      warn "Próba $attempt: nieznany rc=$rc — traktuję jak nieudaną (stable powinien żyć)."
      ;;
  esac

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    [ "$BACKOFF" -gt 0 ] && { log "Backoff ${BACKOFF}s przed kolejną próbą…"; sleep "$BACKOFF"; }
  fi
  attempt=$((attempt + 1))
done

# ── Wyczerpano próby — każdy candidate rolled back, STABLE ŻYJE ──
err "Wyczerpano $MAX_ATTEMPTS prób — żaden candidate nie przeżył. Stable nietknięty."
state_merge "{\"state\":\"failed_needs_human\",\"failureReason\":\"max_attempts_exhausted\"}"

# ── 7.3 — opcjonalny lokalny fallback (Ollama), best-effort, BEZ promote/rollback ──
if [ "${AUTOHEAL_LOCAL_FALLBACK_ENABLED:-false}" = "true" ] && [ -f "$LOCAL_FALLBACK" ]; then
  log "Local-fallback włączony — uruchamiam (best-effort, NIE rusza Live)."
  bash "$LOCAL_FALLBACK" || warn "local-fallback zwrócił błąd (best-effort — ignoruję)."
else
  log "Local-fallback wyłączony (AUTOHEAL_LOCAL_FALLBACK_ENABLED!=true) — pomijam."
fi

err "═══ retry-deploy: FAILED_NEEDS_HUMAN — wymagana decyzja człowieka. Stable żyje. ═══"
exit 1
