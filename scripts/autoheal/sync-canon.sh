#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🔗 sync-canon — domknięcie cyklu autoheal (Etap 6)
#
#  Użycie:
#    sync-canon.sh <commit>
#
#  Po udanym promote+canary+mark: czyni źródłowy kanon = działająca wersja,
#  resetuje repair lane do nowego stable i sprawdza inwariant wersji.
#  WSZYSTKO bez LLM/Mastry/Mongo (czysty git + plik stanu).
#
#  6.1  ff-merge kandydata do kanonu (master). NIGDY nie forsuje — gdy nie da się
#       fast-forward, przerywa i raportuje (decyzja człowieka).
#       Tryb PR (AUTOHEAL_GITHUB_PR_MODE=true): `pull --ff-only` (merge zrobił GitHub).
#  6.2  reset repair lane (autoheal/repair) → newStable: reset --hard + clean -fdx
#       (z zachowaniem .env i node_modules). Brak lane = pomiń (utworzy go TS na starcie cyklu).
#  6.3  inwariant: runtimeVersion == stableCommit == sourceHEAD.
#       Egzekwowany dla slotów deploy (slot-a/slot-b); dla dev ("default") tylko ostrzega
#       (dev nie jest synchronizowany z kanonem — żyje przez `mastra dev`).
#  6.4  Runtime ZOSTAJE na slocie deploy. Powrót na kanon tylko przez bezpieczny restart/swap
#       (poza zakresem tego kroku — tu nic nie restartujemy).
#
#  Kod wyjścia: 0 = kanon zsynchronizowany + inwariant OK,
#               1 = ff niemożliwy / inwariant złamany (Live NIE jest ruszany),
#               2 = błąd resetu repair lane (kanon mógł zostać zsynchronizowany).
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="SYNC-CANON"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/lib.sh"
read_deploy_config

COMMIT_ARG="${1:-}"
[ -n "$COMMIT_ARG" ] || { err "Użycie: sync-canon.sh <commit>"; exit 1; }

CANON_DIR="${AUTOHEAL_CANON_DIR:-$REPO_DIR}"   # kanon = source repo (override dla testów sandbox)
COMMIT="$(git -C "$CANON_DIR" rev-parse --short "$COMMIT_ARG" 2>/dev/null || echo "$COMMIT_ARG")"
REPAIR_DIR="${AUTOHEAL_REPAIR_WORKTREE:-$PROJECT_ROOT/agentic-agents-repair}"
REPAIR_BRANCH="autoheal/repair"

# ── Bieżąca gałąź kanonu (musi być nie-detached) ──
CANON_BRANCH="$(git -C "$CANON_DIR" symbolic-ref --short -q HEAD || echo "")"
if [ -z "$CANON_BRANCH" ]; then
  err "Kanon $CANON_DIR jest w stanie detached HEAD — odmawiam ff-merge (bezpieczeństwo)."
  exit 1
fi

# ═══ 6.1 — sync kanonu ═══
log "Kanon: $CANON_DIR (branch=$CANON_BRANCH) → ff-merge $COMMIT"
if ! git -C "$CANON_DIR" diff --quiet || ! git -C "$CANON_DIR" diff --cached --quiet; then
  err "Kanon ma niezacommitowane zmiany — odmawiam merge (nie nadpisuję pracy w toku)."
  exit 1
fi

if [ "${AUTOHEAL_GITHUB_PR_MODE:-false}" = "true" ]; then
  log "Tryb PR — merge wykonał GitHub; pobieram fast-forward z origin/$CANON_BRANCH"
  git -C "$CANON_DIR" fetch origin "$CANON_BRANCH" --quiet 2>/dev/null || warn "fetch origin nieudany (kontynuuję lokalnie)"
  if git -C "$CANON_DIR" merge --ff-only "origin/$CANON_BRANCH" 2>/dev/null; then
    ok "Kanon zsynchronizowany z origin/$CANON_BRANCH."
  else
    warn "Brak ff z origin/$CANON_BRANCH — próbuję lokalny commit $COMMIT."
    git -C "$CANON_DIR" merge --ff-only "$COMMIT" || { err "ff-merge niemożliwy. Kanon nietknięty."; exit 1; }
  fi
else
  MERGE_OUT="$(git -C "$CANON_DIR" merge --ff-only "$COMMIT" 2>&1)" && MERGE_RC=0 || MERGE_RC=$?
  if [ "${MERGE_RC:-0}" -ne 0 ]; then
    err "ff-merge $COMMIT niemożliwy (nie jest potomkiem $CANON_BRANCH). Kanon NIETKNIĘTY — wymagana decyzja człowieka."
    err "git: $MERGE_OUT"
    exit 1
  fi
  if echo "$MERGE_OUT" | grep -qiE "Already up to date|up-to-date"; then
    ok "Kanon już zawiera $COMMIT (no-op)."
  else
    ok "Kanon fast-forward → $COMMIT."
  fi
fi
SOURCE_HEAD="$(git -C "$CANON_DIR" rev-parse --short HEAD)"

# ═══ 6.2 — reset repair lane ═══
if [ -d "$REPAIR_DIR/.git" ] || [ -f "$REPAIR_DIR/.git" ]; then
  log "Reset repair lane $REPAIR_DIR → $COMMIT (zachowuję .env/node_modules)"
  {
    git -C "$REPAIR_DIR" checkout "$REPAIR_BRANCH" 2>/dev/null || git -C "$REPAIR_DIR" checkout -b "$REPAIR_BRANCH" "$COMMIT"
    git -C "$REPAIR_DIR" reset --hard "$COMMIT"
    git -C "$REPAIR_DIR" clean -fdx -e .env -e node_modules
  } || { err "Reset repair lane nieudany — kanon zsynchronizowany, ale lane wymaga uwagi."; exit 2; }
  # Sanity: lane czysty
  if [ -n "$(git -C "$REPAIR_DIR" status --porcelain 2>/dev/null)" ]; then
    warn "Repair lane wciąż ma zmiany po clean (sprawdź .gitignore)."
  else
    ok "Repair lane czysty na $COMMIT."
  fi
else
  log "Repair lane nie istnieje ($REPAIR_DIR) — pomijam (TS utworzy go na starcie cyklu)."
fi

# ═══ 6.3 — inwariant wersji ═══
STABLE="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('stableCommit',''))" 2>/dev/null || echo "")"
ACTIVE_SLOT="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('activeSlot',''))" 2>/dev/null || echo "")"

# runtimeVersion: preferuj .deploy-version aktywnego slotu (niezależne od Mastry); fallback /deploy/health
RUNTIME_VER=""
case "$ACTIVE_SLOT" in
  slot-a|slot-b) RUNTIME_VER="$(cat "$(slot_dir "$ACTIVE_SLOT")/.deploy-version" 2>/dev/null || echo "")" ;;
esac
if [ -z "$RUNTIME_VER" ]; then
  RUNTIME_VER="$(curl -sf --max-time 5 "http://localhost:${LIVE_PORT}/deploy/health" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")"
fi

log "Inwariant: runtime=$RUNTIME_VER stable=$STABLE source=$SOURCE_HEAD (slot=$ACTIVE_SLOT)"
state_merge "{\"stableCommit\":\"$SOURCE_HEAD\",\"sourceHead\":\"$SOURCE_HEAD\",\"canonSyncedAt\":\"$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')\",\"state\":\"stable\"}"

case "$ACTIVE_SLOT" in
  slot-a|slot-b)
    if [ "$RUNTIME_VER" = "$STABLE" ] && [ "$STABLE" = "$SOURCE_HEAD" ]; then
      ok "Inwariant OK — runtime == stable == sourceHEAD == $SOURCE_HEAD. Cykl domknięty."
      exit 0
    else
      err "INWARIANT ZŁAMANY — runtime=$RUNTIME_VER stable=$STABLE source=$SOURCE_HEAD. Live NIE ruszany; wymagana uwaga."
      state_merge "{\"state\":\"invariant_violation\"}"
      exit 1
    fi ;;
  *)
    warn "Aktywny slot='$ACTIVE_SLOT' (dev/default) — runtime nie jest synchronizowany z kanonem."
    warn "Pomijam twardy assert runtime==source (dev żyje przez 'mastra dev'). Kanon=$SOURCE_HEAD."
    ok "Kanon zsynchronizowany ($SOURCE_HEAD), repair lane zresetowany. Cykl domknięty (tryb dev)."
    exit 0 ;;
esac
