# NotebookLM MCP — Standalone Sidecar Plan

**Status:** APPROVED — implementacja + PoC w toku
**Data:** 2026-05-10
**Powód powstania:** uvx-stdio integracja z `notebooklm-mcp` blokuje start Mastry na ~121s i często kończy się błędem CDP port mismatch (Chrome 148 + undetected-chromedriver 3.5.5 + `--headless=new`). Workflow `producer-hunt` traci jakość bez NLM (LLM fallback ze snippetów Tavily ≠ pełna analiza notebooka).

---

## 1. Diagnoza root cause

### Bug A — Top-level await blokuje Mastra start
`mcpClient.listToolsets()` jest wywoływane z top-level await w module agenta (np. `researcher-agent.ts`). Gdy serwer MCP startuje powoli (uvx fresh = pobranie undetected-chromedriver + setuptools + Chrome warm-up), cały moduł czeka. Z domyślnym timeoutem 60s × 3 retries = **121s blokada** przed pojawieniem się jakiegokolwiek toola.

### Bug B — CDP port mismatch w `--headless=new`
- Chrome 148 startuje z `--remote-debugging-port=X`
- chromedriver oczekuje na innym porcie Y
- Skutek: `cannot connect to chrome at 127.0.0.1:Y from unknown error: unable to discover open pages`
- Reprodukowalne 100%, znany bug undetected-chromedriver 3.5.5 vs Chrome 148

### Bug C — Cold-start co restart Mastry
Każde `Ctrl+C` + restart `mastra dev` = uvx ephemeral env się kasuje, Chrome startuje od zera z profilu, NotebookLM ładuje session ~10-30s. Developer experience: bardzo wolny feedback loop.

### Bug D — Logi NLM zatopione
Stderr z child procesu uvx jest mixowany z logami Mastry → trudno zauważyć błąd selenium między 200 linijkami Mastra dev output.

---

## 2. Strategia rozwiązania

**Każdy bug rozwiązuje osobne podejście; połączenie wszystkich daje stabilną integrację.**

| Bug | Fix |
|---|---|
| A — top-level await blokuje | **Sidecar HTTP/SSE** — Mastra robi szybki HTTP handshake (~100ms); jeśli sidecar nie żyje, łagodny błąd zamiast 121s blokady (try/catch w agentach już jest) |
| B — CDP port mismatch | **Xvfb + headed Chrome** — virtual display `:99` + Chrome bez `--headless=new`; ścieżka, którą undetected-chromedriver supportuje od lat |
| C — Cold-start co restart | **systemd --user unit** — sidecar żyje obok Mastry, Chrome trzymany warm, restart Mastry = darmowy |
| D — Logi zatopione | **journalctl --user -u notebooklm-mcp -f** — dedykowany strumień |

### Kluczowe założenie projektowe
**Decoupling:** NLM ma własny lifecycle. Mastra konsumuje narzędzia, ale nie zarządza ich procesem. To jest standard MCP — większość MCP serwerów w produkcji żyje jako daemons.

---

## 3. Architektura docelowa

```
┌─────────────────────────────┐    HTTP/SSE     ┌──────────────────────────────────────┐
│ Mastra dev (Node)           │ ──────────────▶ │ notebooklm-mcp sidecar (Python)      │
│ src/mastra/mcp.ts:          │ :8765/sse       │ • FastMCP SSE serwer                 │
│   notebooklm: {             │                 │ • Xvfb :99 (managed by launcher)     │
│     url: new URL(           │                 │ • Chrome HEADED przez UC             │
│       'http://127.0.0.1:    │                 │ • profile chrome_profile_notebooklm/ │
│       8765/sse')            │ ◀── tools ───── │ • CWD = agentic-agents/              │
│   }                         │                 │ • config = notebooklm-config.json    │
│ • lazy connect na 1. tool   │                 └──────────────────────────────────────┘
│ • try/catch w agentach      │                              ▲
└─────────────────────────────┘                              │ ExecStart
                                                  ┌──────────┴──────────────┐
                                                  │ ~/.config/systemd/user/ │
                                                  │ notebooklm-mcp.service  │
                                                  │ Restart=on-failure      │
                                                  │ RestartSec=10           │
                                                  └─────────────────────────┘
```

### Components

**`scripts/notebooklm-sidecar.sh`**
- Cleanup Chrome lock files (`SingletonLock`, `SingletonCookie`, `SingletonSocket`)
- Start Xvfb `:99` jeśli nie żyje (`pgrep -f "Xvfb :99"`)
- `export DISPLAY=:99`
- `cd <PROJECT_ROOT>` (krytyczne — server odczytuje config relatywnie)
- `exec uvx --with undetected-chromedriver --with "setuptools<70" --from notebooklm-mcp notebooklm-mcp -c <abs_path>/notebooklm-config.json server --transport sse --host 127.0.0.1 --port 8765`
- Trap `SIGTERM`/`SIGINT` → kill Chrome processes używające naszego profilu + Xvfb (jeśli my go odpaliliśmy)

**`notebooklm-config.json`** (już istnieje, zmiany minimalne)
- `headless: false` ✅ (już ustawione) — z Xvfb display=:99 Chrome wstaje "headed" w wirtualnym buforze
- `auth.profile_dir: "./chrome_profile_notebooklm"` ✅
- `auth.use_persistent_session: true` ✅
- `default_notebook_id: "..."` ✅
- Nic do zmiany.

**`~/.config/systemd/user/notebooklm-mcp.service`**
```ini
[Unit]
Description=NotebookLM MCP Sidecar
After=graphical-session.target

[Service]
Type=exec
ExecStart=/projekty/mastra-agentic-environment/agentic-agents/scripts/notebooklm-sidecar.sh
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
# Environment for headless host (no DBus issues)
Environment="HOME=/home/linus"

[Install]
WantedBy=default.target
```

**`src/mastra/mcp.ts`** — zmiana:
```typescript
'notebooklm': {
  url: new URL('http://127.0.0.1:8765/sse'),
  // requestInit?: { headers: {...} }  // nie potrzeba
},
```
Zostawiamy `timeout: 180000` na MCPClient (sidecar bywa wolny przy pierwszym wywołaniu po długim idle).

---

## 4. Implementation steps (kolejność wykonania)

### Phase 1: Proof of Concept (manual, bez systemd)
1. **Utworzyć launcher** `scripts/notebooklm-sidecar.sh` z Xvfb cleanup
2. **Test manual:** `./scripts/notebooklm-sidecar.sh` — zweryfikować że:
   - Xvfb wstaje na :99
   - Chrome ładuje się przez UC (nie ma exit error)
   - Notebook się otwiera (potrzeba session z ./chrome_profile_notebooklm/)
   - SSE endpoint odpowiada na `curl -N http://127.0.0.1:8765/sse`
3. **Test direct MCP call:** prosty Python klient woła `list_notebooks` przez SSE
4. **Update mcp.ts** na URL transport
5. **Restart Mastra dev** — zweryfikować szybki startup (<10s) i obecność notebooklm tools w UI

### Phase 2: Production hardening
6. Stworzyć systemd user unit
7. `systemctl --user enable --now notebooklm-mcp`
8. Verify: `systemctl --user status notebooklm-mcp`, `journalctl --user -u notebooklm-mcp -n 50`
9. Restart komputera → zweryfikować że NLM wstaje samo

### Phase 3: Cleanup + dokumentacja
10. Stary `notebooklm-mcp-launcher.sh` (stdio variant) zostawić jako legacy lub usunąć
11. Update README.md z instrukcją start/stop sidecara
12. Dodać wpis do `CLAUDE.md` lub project memory: "NotebookLM żyje jako systemd user unit, nie spawn z Mastry"

---

## 5. Test plan (każdy krok validuje swój scope)

| # | Test | Success criteria | Co weryfikuje |
|---|---|---|---|
| T1 | `./scripts/notebooklm-sidecar.sh` (manual) | Pojawia się "FastMCP server running on http://127.0.0.1:8765/sse" w stdout | Xvfb + Chrome warm-up działa |
| T2 | `curl -N http://127.0.0.1:8765/sse` | Connection otwarty, event stream live | SSE transport żyje |
| T3 | Python smoke test (`mcp` SDK) → call `list_notebooks` | Lista notatników wraca | Selenium ↔ NotebookLM authenticated session |
| T4 | `mastra dev` start | `<10s` startup, notebooklm tools widoczne w `listToolsets()` | Mastra HTTP→sidecar handshake |
| T5 | Knowledge agent w Mastra UI: "Listę moich notebooków" | Realna odpowiedź | End-to-end Mastra → sidecar → NLM |
| T6 | `systemctl --user restart notebooklm-mcp`, czekać 30s, T5 | Nadal działa | Auto-restart resilience |
| T7 | Reboot komputera, login, otwórz Mastra | NLM tools obecne bez ręcznej akcji | systemd auto-start |

---

## 6. Risk register & fallback plan

### Ryzyko 1 — Xvfb non-headless dalej wywala undetected-chromedriver
**Symptom:** Mimo Xvfb, Chrome dalej crashuje na CDP handshake.
**Plan B1:** Pin undetected-chromedriver do 3.5.4 (poprzednia stabilna):
```bash
uvx --with "undetected-chromedriver==3.5.4" --with "setuptools<70" ...
```
**Plan B2:** Pin Chrome do 147:
```bash
# Pobierz .deb 147 z https://www.slimjet.com/chrome/google-chrome-old-version.php
sudo dpkg -i google-chrome-stable_147.deb
sudo apt-mark hold google-chrome-stable
```

### Ryzyko 2 — Sidecar SSE rozłącza się po idle
**Symptom:** Po godzinie idle, Mastra dostaje connection refused / timeout.
**Plan:** Dodać keepalive ping w MCPClient lub `requestInit: { signal: longTimeout }`. Jeśli nie pomaga — `--transport http` (streamable HTTP zamiast SSE).

### Ryzyko 3 — Chrome profile rozjeżdża się przy concurrent access
**Symptom:** Sidecar i ręczny Chrome z tego profilu = lock conflict.
**Plan:** Sidecar już robi cleanup locków przy starcie. Dodatkowo: w README jasno powiedzieć "nie odpalaj Chrome z chrome_profile_notebooklm/ ręcznie".

### Ryzyko 4 — Auth wygasa
**Symptom:** Session cookies wygasły, NotebookLM przekierowuje na login.
**Plan:** Detection w sidecarze (selenium sprawdza obecność loginu) → log error → user re-runs `notebooklm-mcp init`. Out of scope dla tego PoC, ale dodać do health-check toola.

---

## 7. Out of scope (świadomie pominięte)

- Multi-notebook concurrent access (jedna instancja sidecara = jeden warm Chrome)
- High availability / horizontal scaling (lokalne dev środowisko)
- Cookies refresh automation (manual re-init przez `notebooklm-mcp init`)
- Migracja z undetected-chromedriver na Playwright (większy projekt; rozważyć tylko jeśli UC dalej będzie problematyczny)

---

## 8. Decyzje zatwierdzone przez usera

- ✅ **Auto-start:** systemd --user (auto przy logowaniu)
- ✅ **Xvfb:** zarządzany przez sidecar (start/cleanup w launcherze)
- ✅ **Kolejność:** zapisać plan w `ideas/`, potem proof of concept

---

## 9. Status implementacji

- [x] Plan zatwierdzony i zapisany (ten dokument)
- [x] Phase 1.1 — `scripts/notebooklm-sidecar.sh`
- [x] Phase 1.2 — Manual test sidecara (T1-T3)
- [x] Phase 1.3 — Update `mcp.ts` na URL transport
- [x] Phase 1.4 — Test integracji z Mastrą (T4-T5)
- [x] Phase 2 — systemd unit + auto-start (T6-T7)
- [x] Phase 3 — Cleanup + dokumentacja
