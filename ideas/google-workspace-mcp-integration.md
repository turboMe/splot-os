# Google Workspace MCP — Potencjalna Integracja

> Status: 📋 Notatka | Data: 2026-05-09
> Repo: https://github.com/taylorwilsdon/google_workspace_mcp
> Licencja: MIT | ⭐ 2.3k | Forks: 718

## Co to jest

Najpełniejszy MCP server do Google Workspace — 12 serwisów:
Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Chat,
Apps Script, Tasks, Contacts, Custom Search.

2,229 commitów, aktywnie rozwijany, MIT bez żadnych ograniczeń.
Obsługuje OAuth 2.0/2.1, multi-user, stateless mode, Docker.

## Obciążenie systemowe

### Zasoby runtime:
- **CPU**: Minimalne — to proxy do Google API, nie przetwarza danych lokalnie
- **RAM**: ~50-80 MB (Python FastMCP server + auth cache)
- **Dysk**: Brak — stateless mode nie zapisuje nic
- **Sieć**: Jedyny bottleneck — wymaga Google API calls (100-500ms latency per call)
- **GPU**: Żadne — zero obciążenia GPU

### Podsumowanie: Lekki. Znacznie lżejszy niż Ollama czy nawet DuckDB.

## Czy agent się pogubi?

### Ryzyka:
1. **Explosion of tools** — 12 serwisów × N operacji = łatwo 60+ narzędzi.
   Agent może się zgubić w wyborze właściwego toola gdy ma do wyboru
   `gmail_send`, `gmail_draft`, `gmail_reply`, `gmail_forward` etc.

2. **Auth complexity** — OAuth flow wymaga manual setup
   (Google Cloud Project → credentials → consent screen).
   Agent nie może tego zrobić autonomicznie.

3. **Context window pressure** — opisy 60+ narzędzi MCP zjedzą
   ~3-5k tokenów kontekstu zanim agent zacznie myśleć.

4. **Stateful interactions** — operacje Google są stateful
   (tworzysz dokument → dostajesz ID → musisz go śledzić).
   Agent musi utrzymywać stan między wywołaniami.

### Mitigacje:
1. **Tool Tiers** — server ma wbudowane `--tool-tier core|extended|complete`.
   Można uruchomić z `core` (tylko Gmail+Drive+Calendar) i stopniowo rozszerzać.

2. **Service cherry-picking** — `--tools gmail drive` pozwala na precyzyjny wybór.

3. **Nasz SmartRouter** — mógłby kierować tylko workspace-related taski
   do sub-agenta z podpiętym workspace MCP, izolując resztę pipeline'u.

## Rekomendacja

### Nie importować jako skill — podłączyć jako MCP server do dedykowanego sub-agenta.

Architektura:
```
MetaAgent
  └─ workspaceAgent (sub-agent)
       ├─ MCP: google_workspace_mcp (core tier)
       └─ Prompt: "Zarządzaj dokumentami i emailami w Google Workspace"
```

### Kiedy wdrożyć:
- Po stabilizacji diagnostic loop (faza 3 roadmapu)
- Gdy pojawi się realny use case (np. automatyczne raporty do Google Docs)
- Setup: 15-30 min (Google Cloud credentials + Docker)

## Alternatywy do porównania
- Nasz obecny `gmail` MCP server — już mamy Gmail!
- `notebooklm` MCP — już mamy NotebookLM!
- Brakuje: Drive, Calendar, Docs, Sheets, Slides

## Quick Start (gdy przyjdzie czas)

```bash
# 1. Install
uvx workspace-mcp --tool-tier core

# 2. Config
export GOOGLE_OAUTH_CLIENT_ID="..."
export GOOGLE_OAUTH_CLIENT_SECRET="..."

# 3. Connect as MCP in Mastra
# Dodać do mcp-config analogicznie do gmail/notebooklm
```
