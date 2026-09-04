#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🦙 local-fallback — lokalny runner ostatniej szansy (Etap 7.3)
#
#  Uruchamiany przez retry-deploy.sh PO wyczerpaniu prób, gdy wszystkie
#  candidate'y padły. Działa WYŁĄCZNIE lokalnie (Ollama, HTTP) i jest
#  bezwzględnie OGRANICZONY:
#
#    • startuje TYLKO gdy stable runtime (:LIVE_PORT) NIE wstaje
#      (gdy stable żyje — nie ma czego ratować, kończy 0 i nic nie robi),
#    • NIGDY nie robi promote/rollback/swap — to wyłącznie domena supervisora,
#    • jedynie PROPONUJE diagnozę/patch do pliku dla człowieka,
#    • Ollama nieosiągalny → best-effort skip (exit 0, nie wywraca niczego).
#
#  To NIE jest część krytycznej ścieżki dostępności — czysto doradcze.
#
#  Kody wyjścia: 0 = nic do roboty / propozycja zapisana / best-effort skip.
#               (Celowo nie zwraca błędu — nie ma blokować retry-deploy.)
# ═══════════════════════════════════════════════════════════════════

AUTOHEAL_STEP_TAG="FALLBACK"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/lib.sh"
read_deploy_config

OLLAMA_HOST="${AUTOHEAL_OLLAMA_HOST:-http://localhost:11434}"
FALLBACK_MODEL="${AUTOHEAL_FALLBACK_MODEL:-qwen3-coder:30b}"
OUT_DIR="${AUTOHEAL_FALLBACK_DIR:-$DEPLOY_DIR/fallback}"
LIVE_LOG="${AUTOHEAL_LIVE_LOG:-$DEPLOY_DIR/live.log}"

# ── 1. Czy stable w ogóle padł? Jeśli żyje — nic nie robimy. ──
if curl -sf --max-time 5 "http://localhost:${LIVE_PORT}/health" >/dev/null 2>&1; then
  ok "Stable na :$LIVE_PORT odpowiada — brak powodu do fallbacku. Kończę (no-op)."
  exit 0
fi
warn "Stable na :$LIVE_PORT NIE odpowiada — uruchamiam doradczy fallback (BEZ promote/rollback)."

# ── 2. Czy Ollama osiągalny? Brak → best-effort skip. ──
if ! curl -sf --max-time 5 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  warn "Ollama nieosiągalny ($OLLAMA_HOST) — pomijam fallback (best-effort, exit 0)."
  exit 0
fi

# ── 3. Zbierz lekki kontekst: ostatnie linie logu + ostatnia próba ──
mkdir -p "$OUT_DIR"
TS="$(date -u '+%Y%m%dT%H%M%S')"
OUT_FILE="$OUT_DIR/fallback-$TS.md"
ATTEMPTS_LOG="${AUTOHEAL_ATTEMPTS_LOG:-$DEPLOY_DIR/autoheal-attempts.jsonl}"

LOG_TAIL=""
[ -f "$LIVE_LOG" ] && LOG_TAIL="$(tail -n 60 "$LIVE_LOG" 2>/dev/null || echo "")"
LAST_ATTEMPT=""
[ -f "$ATTEMPTS_LOG" ] && LAST_ATTEMPT="$(tail -n 1 "$ATTEMPTS_LOG" 2>/dev/null || echo "")"
STABLE="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('stableCommit',''))" 2>/dev/null || echo "")"

# ── 4. Zapytaj Ollama o diagnozę (best-effort; timeout twardy) ──
log "Pytam $FALLBACK_MODEL o diagnozę (host=$OLLAMA_HOST)…"
PROMPT="Jesteś inżynierem SRE. Runtime Mastry NIE wstaje na stable commit ${STABLE}.
Ostatnia próba autoheal (JSONL): ${LAST_ATTEMPT:-brak}
Ostatnie linie logu runtime:
${LOG_TAIL:-brak logu}

Podaj zwięźle: (1) najprawdopodobniejszą przyczynę, (2) konkretny patch lub krok naprawczy,
(3) test który by to wychwycił. NIE proponuj restartu na ślepo. Maks 200 słów."

RESPONSE="$(OLLAMA_HOST="$OLLAMA_HOST" MODEL="$FALLBACK_MODEL" PROMPT="$PROMPT" python3 - <<'PY'
import json, os, urllib.request
host = os.environ["OLLAMA_HOST"].rstrip("/")
payload = json.dumps({"model": os.environ["MODEL"], "prompt": os.environ["PROMPT"], "stream": False}).encode()
try:
    req = urllib.request.Request(host + "/api/generate", data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        print(json.loads(r.read().decode()).get("response", "").strip())
except Exception as e:
    print(f"__OLLAMA_ERROR__ {e}")
PY
)"

if echo "$RESPONSE" | grep -q "__OLLAMA_ERROR__"; then
  warn "Zapytanie do Ollama nie powiodło się: ${RESPONSE#__OLLAMA_ERROR__ } — pomijam (best-effort)."
  exit 0
fi

# ── 5. Zapisz propozycję dla człowieka — NIE aplikujemy, NIE promujemy ──
{
  echo "# Autoheal local-fallback — propozycja (do RĘCZNEJ oceny)"
  echo ""
  echo "- Wygenerowano: ${TS}"
  echo "- Model: ${FALLBACK_MODEL}"
  echo "- Stable commit: ${STABLE:-unknown}"
  echo "- Ostatnia próba: ${LAST_ATTEMPT:-brak}"
  echo ""
  echo "> ⚠️ To jest WYŁĄCZNIE propozycja. Nie zaaplikowano żadnej zmiany,"
  echo "> nie wykonano promote/rollback. Decyzja i wdrożenie należą do człowieka."
  echo ""
  echo "## Diagnoza / patch"
  echo ""
  echo "$RESPONSE"
} > "$OUT_FILE"

ok "Propozycja zapisana: $OUT_FILE (NIE zaaplikowano — wymaga decyzji człowieka)."
state_merge "{\"fallbackProposal\":\"$OUT_FILE\"}"
exit 0
