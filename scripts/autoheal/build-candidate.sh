#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🏗️  build-candidate — materializuje slot runtime z commita i buduje
#
#  Użycie:
#    build-candidate.sh <commit|ref> [slot]
#      slot: slot-a | slot-b   (domyślnie slot-b — zwykle nieaktywny)
#
#  Co robi (idempotentnie):
#    1. Rozwiązuje <commit> do krótkiego SHA w source repo (KANON).
#    2. Jeśli slot już zbudowany z tego SHA (.deploy-version + output) → SKIP.
#    3. Synchronizuje `.env`, czyści slot (zachowując node_modules + świeży
#       `.env`) i wypakowuje git archive
#       danego commita (DETERMINISTYCZNIE — dokładne drzewo, bez .git/cruft).
#    4. Linkuje node_modules ze source (szybko; build kompiluje źródła).
#    5. `npx mastra build`.  ❗ NIE dotyka portu Live (:4111).
#
#  Kod wyjścia: 0 = zbudowane/aktualne, 1 = błąd buildu/argumentów.
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="BUILD"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_deploy_config

REF="${1:-}"
SLOT="${2:-slot-b}"
[ -z "$REF" ] && { err "Brak argumentu <commit|ref>."; exit 1; }
case "$SLOT" in slot-a|slot-b) ;; *) err "Nieznany slot: $SLOT (slot-a|slot-b)"; exit 1 ;; esac

COMMIT="$(resolve_commit "$REF")"
SLOT_DIR="$(slot_dir "$SLOT")"

log "Commit=$COMMIT  slot=$SLOT  dir=$SLOT_DIR"
mkdir -p "$SLOT_DIR"

# Synchronizuj PRZED fast-path idempotencji. Ten sam commit może wymagać nowego
# tokenu/flagi środowiskowej bez przebudowy kodu.
sync_runtime_env "$SOURCE_DIR/.env" "$SLOT_DIR/.env" \
  || { err "Synchronizacja .env do $SLOT nie powiodła się."; exit 1; }
log "Runtime .env zsynchronizowany ze source (uprawnienia 0600)."

# ── 2. Idempotencja: już zbudowane z tego commita? ──
if [ -f "$SLOT_DIR/.deploy-version" ] \
   && [ "$(cat "$SLOT_DIR/.deploy-version" 2>/dev/null)" = "$COMMIT" ] \
   && [ -f "$SLOT_DIR/.mastra/output/index.mjs" ]; then
  ok "Slot $SLOT już zbudowany z $COMMIT — pomijam (idempotentnie)."
  exit 0
fi

# ── 3. Czyść slot (zachowaj node_modules i świeży .env), wypakuj commit ──
log "Czyszczę slot (zachowuję node_modules, .env)…"
find "$SLOT_DIR" -mindepth 1 -maxdepth 1 \
  ! -name node_modules ! -name .env -exec rm -rf {} + 2>/dev/null || true

log "git archive $COMMIT → $SLOT_DIR (deterministyczne drzewo commita)…"
git -C "$SOURCE_DIR" archive "$COMMIT" | tar -x -C "$SLOT_DIR"

# ── 4. node_modules (`.env` został zsynchronizowany przed fast-path) ──
# node_modules: symlink do source, ZAWSZE. Wcześniej ten blok odpalał się tylko
# przy `! -e`, więc slot z prawdziwym katalogiem (np. po ręcznym npm install)
# zostawał na zamrożonych zależnościach na zawsze — kod z `git archive` był
# świeży, a moduły z maja. Efekt: bundle stagingu nie startował
# ("does not provide an export named ..."), health check padał po 60 s i CAŁA
# weryfikacja self-healingu była martwa, mimo że sam mechanizm działał.
if [ -d "$SOURCE_DIR/node_modules" ]; then
  LINK_TARGET="$(readlink "$SLOT_DIR/node_modules" 2>/dev/null || echo "")"
  if [ "$LINK_TARGET" != "$SOURCE_DIR/node_modules" ]; then
    rm -rf "$SLOT_DIR/node_modules"
    ln -s "$SOURCE_DIR/node_modules" "$SLOT_DIR/node_modules"
    log "node_modules → symlink do source (odświeżony; slot dziedziczy zależności repo)."
  fi
elif [ ! -e "$SLOT_DIR/node_modules" ]; then
  warn "Brak node_modules w source — uruchamiam npm install w slocie."
  ( cd "$SLOT_DIR" && load_node && npm install --silent ) || { err "npm install nie powiódł się."; exit 1; }
fi

# ── 5. Build ──
log "npx mastra build…"
(
  cd "$SLOT_DIR"
  load_node
  npx mastra build
) || { err "Build nie powiódł się dla $COMMIT."; exit 1; }

if [ ! -f "$SLOT_DIR/.mastra/output/index.mjs" ]; then
  err "Build zakończony, ale brak .mastra/output/index.mjs."
  exit 1
fi

echo "$COMMIT" > "$SLOT_DIR/.deploy-version"
ok "Zbudowano slot $SLOT z commita $COMMIT (Live :$LIVE_PORT nietknięty)."
exit 0
