#!/usr/bin/env bash
# n8n-tunnel-up.sh
#
# Idempotentny startup orchestrator dla Mastry:
#  1. Mongo       — jezeli port 27017 odpowiada, skip; inaczej docker compose up mongo.
#  2. n8n         — jezeli af-n8n jest running, skip (moze byc z jarvis compose);
#                   inaczej docker compose up n8n.
#  3. cloudflared — zawsze docker compose up cloudflared (no-op jesli juz running).
#  4. Czeka na URL z logow cloudflared (max 60s).
#  5. Wpisuje N8N_PUBLIC_WEBHOOK_BASE_URL/N8N_WEBHOOK_URL/N8N_HOST/N8N_PROTOCOL/N8N_PROXY_HOPS
#     do agentic-agents/.env.
#  6. Restartuje n8n tylko jezeli URL zmienil sie wzgledem .env (i jezeli n8n
#     jest zarzadzany przez ten compose; w przeciwnym razie uzytkownik dostaje
#     warning, bo n8n trzyma WEBHOOK_URL z runtime env).
#
# Brak tunelu / docker / .env nie blokuje `mastra dev` — skrypt loguje warning
# i konczy z exit 0.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$(cd "$REPO_ROOT/.." && pwd)/docker-compose.yml"
ENV_FILE="$REPO_ROOT/.env"
TUNNEL_CONTAINER="af-cloudflared-n8n"
N8N_CONTAINER="af-n8n"
MONGO_PORT="${MONGO_PORT:-27017}"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { printf "${CYAN}[tunnel]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[tunnel]${NC} %s\n" "$*"; }
err()  { printf "${RED}[tunnel]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[tunnel]${NC} %s\n" "$*"; }

if ! command -v docker >/dev/null 2>&1; then
    warn "docker nie znaleziony w PATH — pomijam tunnel setup."
    exit 0
fi

container_running() {
    [ -n "$(docker ps -q -f "name=^${1}$" 2>/dev/null)" ]
}

port_in_use() {
    # bash /dev/tcp probe — true jezeli port lokalny odpowiada
    (echo > "/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

# 1. Mongo
if port_in_use "$MONGO_PORT"; then
    log "mongo: port $MONGO_PORT zajety, zakladam ze juz dziala — skip."
else
    log "mongo: uruchamiam..."
    docker compose -f "$COMPOSE_FILE" up -d mongo --wait >/dev/null 2>&1 \
        || warn "mongo compose up nie powiodl sie (ten skrypt nie blokuje dev)."
fi

# 2. n8n
if container_running "$N8N_CONTAINER"; then
    log "n8n: kontener $N8N_CONTAINER juz dziala — skip."
    N8N_MANAGED_BY_MASTRA=false
else
    log "n8n: uruchamiam przez mastra compose..."
    if docker compose -f "$COMPOSE_FILE" up -d n8n >/dev/null 2>&1; then
        N8N_MANAGED_BY_MASTRA=true
    else
        warn "n8n compose up nie powiodl sie. Sprawdz: docker compose -f $COMPOSE_FILE logs n8n"
        N8N_MANAGED_BY_MASTRA=false
    fi
fi

# 3. cloudflared
if ! docker compose -f "$COMPOSE_FILE" up -d cloudflared >/dev/null 2>&1; then
    err "cloudflared compose up nie powiodl sie. Sprawdz: docker compose -f $COMPOSE_FILE logs cloudflared"
    exit 0
fi

# 4. Czekaj na URL z cloudflared (max 60s)
IS_NAMED_TUNNEL=false
if docker inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
    CONTAINER_ARGS=$(docker inspect "$TUNNEL_CONTAINER" --format '{{range .Args}}{{.}} {{end}}' 2>/dev/null || echo "")
    if [[ "$CONTAINER_ARGS" == *"n8n-mastra"* ]]; then
        IS_NAMED_TUNNEL=true
    fi
fi

if [ "$IS_NAMED_TUNNEL" = "true" ]; then
    log "Wykryto staly Cloudflare Named Tunnel (n8n-mastra). Uzywam adresu https://n8n.gastrobridge.com"
    TUNNEL_URL="https://n8n.gastrobridge.com"
else
    log "czekam na URL z cloudflared (max 60s)..."
    TUNNEL_URL=""
    for i in $(seq 1 60); do
        TUNNEL_URL=$(docker logs "$TUNNEL_CONTAINER" 2>&1 \
            | grep -oE 'https://[-a-zA-Z0-9.]+\.trycloudflare\.com' \
            | tail -n 1 || true)
        if [ -n "$TUNNEL_URL" ]; then break; fi
        sleep 1
    done

    if [ -z "$TUNNEL_URL" ]; then
        warn "nie znaleziono URL trycloudflare w logach $TUNNEL_CONTAINER po 60s."
        warn "sprawdz: docker logs $TUNNEL_CONTAINER"
        warn "publiczne webhooki nie beda dzialac do czasu reczego ustawienia N8N_PUBLIC_WEBHOOK_BASE_URL."
        exit 0
    fi
fi

log "URL tunelu: $TUNNEL_URL"

# 5. Update .env
set_env_var() {
    local key="$1" value="$2"
    touch "$ENV_FILE"
    if grep -q "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
}

get_env_var() {
    local key="$1"
    [ -f "$ENV_FILE" ] || return
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-
}

PREVIOUS_URL="$(get_env_var N8N_PUBLIC_WEBHOOK_BASE_URL || true)"
TUNNEL_HOST="${TUNNEL_URL#https://}"

set_env_var "N8N_PUBLIC_WEBHOOK_BASE_URL" "$TUNNEL_URL"
set_env_var "N8N_WEBHOOK_URL"             "$TUNNEL_URL"
set_env_var "N8N_HOST"                    "$TUNNEL_HOST"
set_env_var "N8N_PROTOCOL"                "https"
set_env_var "N8N_PROXY_HOPS"              "1"

ok ".env zaktualizowane (N8N_PUBLIC_WEBHOOK_BASE_URL=$TUNNEL_URL)"

# 6. Restart n8n tylko jezeli URL sie zmienil
if [ "$PREVIOUS_URL" = "$TUNNEL_URL" ]; then
    ok "URL tunelu nie zmienil sie — n8n nie wymaga restartu."
    exit 0
fi

if [ "$N8N_MANAGED_BY_MASTRA" = "true" ]; then
    log "URL tunelu zmieniony — recreate n8n z nowym WEBHOOK_URL..."
    if docker compose -f "$COMPOSE_FILE" up -d --force-recreate n8n >/dev/null 2>&1; then
        ok "n8n zrestartowany ze swiezym tunelem."
    else
        err "n8n recreate nie powiodlo sie. Sprawdz: docker logs $N8N_CONTAINER"
    fi
    exit 0
fi

# n8n nalezy do innego compose (typowo: jarvis-dashboard-agent). W tej sytuacji
# Mastra .env zaktualizowala sie, ale kontener n8n nadal trzyma stary WEBHOOK_URL
# w runtime env — bo jego compose czyta swoj wlasny .env (jarvis), a nie ten
# tutaj. Bez tego fallbacku za kazdym razem trzeba bylo recznie aktualizowac
# jarvis .env i robic compose up --force-recreate n8n.
OWNER_LABELS="$(docker inspect "$N8N_CONTAINER" \
    --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
    2>/dev/null || true)"
OWNER_COMPOSE_FILE="${OWNER_LABELS%%|*}"
OWNER_WORKDIR="${OWNER_LABELS##*|}"

if [ -z "$OWNER_COMPOSE_FILE" ] || [ ! -f "$OWNER_COMPOSE_FILE" ]; then
    warn "URL tunelu sie zmienil, ale nie udalo sie ustalic ownera kontenera $N8N_CONTAINER."
    warn "Zaktualizuj WEBHOOK_URL recznie: docker rm -f $N8N_CONTAINER && (twoja procedura up)."
    exit 0
fi

OWNER_ENV_FILE="$OWNER_WORKDIR/.env"
log "n8n nalezy do compose: $OWNER_COMPOSE_FILE — synchronizuje jego .env i robie recreate."

# Aktualizuj env owner-compose tak samo jak nasz .env (te same nazwy zmiennych
# uzywa jarvis compose; jezeli inny compose ma inne nazwy, sed nie znajdzie i
# nie ruszy nic).
if [ -f "$OWNER_ENV_FILE" ]; then
    update_owner_env() {
        local key="$1" value="$2"
        if grep -q "^${key}=" "$OWNER_ENV_FILE"; then
            sed -i "s|^${key}=.*|${key}=${value}|" "$OWNER_ENV_FILE"
        fi
    }
    update_owner_env "N8N_WEBHOOK_URL"             "$TUNNEL_URL"
    update_owner_env "N8N_PUBLIC_WEBHOOK_BASE_URL" "$TUNNEL_URL"
    update_owner_env "N8N_HOST"                    "$TUNNEL_HOST"
    update_owner_env "N8N_PROTOCOL"                "https"
    update_owner_env "N8N_PROXY_HOPS"              "1"
    ok "$OWNER_ENV_FILE zaktualizowany."
else
    warn "$OWNER_ENV_FILE nie istnieje — zostawiam env owner-compose bez zmian."
fi

if docker compose -f "$OWNER_COMPOSE_FILE" up -d --force-recreate n8n >/dev/null 2>&1; then
    ok "n8n zrestartowany przez owner-compose ze swiezym tunelem."
    warn "UWAGA: Twoja sesja n8n w przegladarce wygasla (cookie z poprzedniego URL)."
    warn "Zaloguj sie ponownie na: $TUNNEL_URL"
    warn "Pamietaj rowniez zaktualizowac OAuth Redirect URI w Google Cloud Console:"
    warn "  $TUNNEL_URL/rest/oauth2-credential/callback"
else
    err "Recreate n8n przez $OWNER_COMPOSE_FILE nie powiodl sie."
    err "Sprawdz: docker logs $N8N_CONTAINER"
fi
