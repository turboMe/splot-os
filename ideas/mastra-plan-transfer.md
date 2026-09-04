# Plan migracji Jarvis → Mastra

**Wersja:** 2026-05-04
**Stary repo:** `/projekty/jarvis-dashboard-agent` (jarvis – szkic)
**Nowy repo:** `/projekty/mastra-agentic-environment/agentic-agents` (cel – Mastra 1.31)
**Cel:** Zostawić jarvis tylko jako referencję domeny i prompty. Zbudować docelową infrastrukturę na Mastra. Dashboard: zachować UX, podmienić warstwę API na klienta Mastra.

---

## 0. TL;DR – co Mastra daje za darmo, czego NIE przepisujemy

Mastra zastępuje (NIE przenosimy 1:1 z jarvis):

| Komponent jarvis | Plik(i) jarvis | Zastępca w Mastra |
|---|---|---|
| `apps/workers/src/core/queue.ts` (BullMQ) | queue.ts | Mastra Workflows + jej runtime (`workflow.start`, `.stream`, `.resume`) |
| `apps/workers/src/core/scheduler.ts` (node-cron) | scheduler.ts | Mastra scheduled triggers / external cron → `workflow.start` |
| `apps/workers/src/core/events.ts` (Redis pub/sub + SSE) | events.ts | Mastra observability + workflow `.stream()` events |
| `apps/workers/src/core/logger.ts` | logger.ts | PinoLogger (już jest w `index.ts`) + Observability |
| `apps/workers/src/core/heartbeat.ts` | heartbeat.ts | Mastra Studio pokazuje stan agentów natywnie |
| `apps/workers/src/core/db.ts` (MongoClient) | db.ts | `MongoDBStore` w `mastra.storage` (już jest) |
| `apps/workers/src/core/base-agent.ts` (LLM fallback, runs/log telemetria) | base-agent.ts | Mastra `Agent` + Observability (DefaultExporter, CloudExporter) |
| `apps/workers/src/agents/meta-agent/react-loop.ts` (666 linii ReAct) | react-loop.ts | Wbudowana pętla `Agent.stream()` z tool calling – rezygnujemy z własnej |
| `apps/workers/src/agents/meta-agent/tool-rag-service.ts` | tool-rag-service.ts | Mastra `ToolSearchProcessor` (RAG po embedingach narzędzi) |
| `apps/workers/src/core/shared-memory.ts` (`signals`, `shared_memory`) | shared-memory.ts | `Memory` (working memory + semantic recall) – per agent lub globalna |
| `packages/llm/src/router.ts` (multi-provider z fallbackiem) | router.ts | `model: "google/gemini-2.5-pro"` (model router Mastry); fallback przez `try/catch` + alternatywny agent |
| `packages/llm/src/embeddings.ts` | embeddings.ts | Mastra `embedder` w `Memory` |
| `apps/workers/src/core/approval-manager.ts` | approval-manager.ts | Workflow `suspend()` / `resume()` (Mastra natywnie) |
| `apps/workers/src/index.ts` (worker bootstrap) | apps/workers/src/index.ts | `mastra dev` / `mastra start` |
| `apps/workers/src/core/Agent.ts` (legacy duplicate) | Agent.ts | Wyrzucamy |

Mastra NIE robi za nas – musimy przenieść:

| Domena jarvis | Trzeba przepisać do Mastra |
|---|---|
| Prompts (`*/prompts/*.md`) – treść instrukcji | Tak – do `src/mastra/prompts/` (plik per use-case) |
| Definicje narzędzi domenowych (CRM, Gmail, n8n, NotebookLM, Chef, RSS) | Częściowo zrobione – patrz Etap 4 |
| Workflowy domenowe: producer-hunt, weekly-content, inbox-monitor, sync-crm, automated-followup, morning-briefing, proposal-generator, meeting-scheduler, onboarding-checklist, weekly-report, roi-calculator, trend-analysis | Tylko 2 ze szkicu – patrz Etap 6 |
| Logika risk-scoring + RAG patternów dla automation-architect (`packages/automation-architect`) | Nie ma w Mastra – patrz Etap 7 |
| Routing intencji + plan wiedzy (intent-router, knowledge-plan) – jeżeli zostawiamy | W Mastra realizujemy przez Supervisor + ToolSearchProcessor + opcjonalny "router agent" (Etap 5) |
| Dashboard Next.js (`apps/dashboard`) – UI biznesowy | Zachowujemy UI, podmieniamy backend (Etap 8) |
| Skille (`packages/agent-skills/registry/*.md`) | Kopiujemy plikami; ładuje je narzędzie `subtask.delegate_loop` (Etap 4G) |

---

## 1. Stan obecny – co już jest w `mastra-agentic-environment`

`/projekty/mastra-agentic-environment/agentic-agents` – Mastra 1.31, Node ≥22.13, ESM, MongoDB + DuckDB, Pino, `@mastra/observability`, `@mastra/mcp`, `@mastra/memory`, `@mastra/evals`. `package.json` skrypty: `dev` / `build` / `start` (`mastra` CLI).

### 1.1. `src/mastra/index.ts` – root config

Zarejestrowane:
- **Workflows:** `weatherWorkflow`, `weeklyContentWorkflow` (3 stepy, mock), `producerHuntWorkflow` (3 stepy, częściowo działa – zapisuje do `crm_leads`).
- **Agents:** `weatherAgent` (z evalami, jedyny z `Memory`), `crmAgent` (Ollama gemma4:26b, 1 narzędzie), `metaAgent` (Gemini, 31 narzędzi), `marketingAgent` (Gemini, 0 narzędzi – stub), `salesAgent` (Gemini, 2 narzędzia), `analyticsAgent` (stub), `automationArchitect` (stub).
- **Storage:** `MastraCompositeStore` → MongoDBStore (`agentforge`) + DuckDBStore (observability).
- **Logger:** `PinoLogger`.
- **Observability:** `DefaultExporter` (DuckDB), `CloudExporter` (jeśli `MASTRA_CLOUD_ACCESS_TOKEN`), `SensitiveDataFilter`.

### 1.2. `src/mastra/agents/`

| Plik | Stan | Tools | Memory | Evals |
|---|---|---|---|---|
| `meta-agent.ts` | działa, instrukcje krótkie (5 linii) | 31 (CRM, Gmail×7, Calendar, n8n×7, Chef×4, RSS×5, terminal×3, delegateTask, addContext) | — | — |
| `marketing-agent.ts` | szkielet | 0 | — | — |
| `sales-agent.ts` | szkielet | 2 (`updateStatusTool`, `addInteractionTool`) | — | — |
| `analytics-agent.ts` | szkielet | 0 | — | — |
| `automation-architect.ts` | szkielet | 0 | — | — |
| `crm-agent.ts` | działa (Ollama) | 1 (`searchLeadsTool`) | — | — |
| `weather-agent.ts` | demo, zostawić jako wzór | 1 (`weatherTool`) | `new Memory()` | 3 scorery |
| `marketing/steps/*.ts` | 11 plików skopiowanych z jarvis – nie podpięte do żadnego workflow | n/d | n/d | n/d |

### 1.3. `src/mastra/tools/`

Zaimplementowane (działają lub prawie):
- `crm-tools.ts` – `searchLeadsTool` (działa, MongoDB `leads`).
- `crm/{create-lead,update-status,search-leads,add-interaction}.ts` – **STUBY** (zwracają mock, nie piszą do DB).
- `google/{gmail.ts,calendar.ts,auth.ts,google-tools.ts}` – kompletne 7 narzędzi Gmail + 1 Calendar (OAuth2 z refresh tokenem).
- `n8n/{client.ts,n8n-tools.ts}` – kompletne 7 narzędzi (`trigger`, `health`, `list/get/update/activate/deactivate workflows`).
- `rss/rss-tools.ts` – kompletne 5 narzędzi + `RssService`.
- `chef/{db.ts,chef-service.ts,chef-tools.ts}` – `ChefService` ~640 linii, 4 narzędzia (`start_project`, `update_profile`, `generate_menu`, `draft_recipe`).
- `terminal/terminal-tools.ts` – kompletne 3 narzędzia z sandboxem `/tmp/sandbox-Jarvis` (path traversal protection, 15 s timeout, 2 MB buffer).
- `memory/add-context.ts` – **STUB** (mock, brak persystencji).
- `system/delegate-task.ts` – działa (mapuje `targetAgent` → `agent.generate()`).
- `weather-tool.ts` – demo.

### 1.4. `src/mastra/mcp.ts`

Zarejestrowany serwer MCP NotebookLM (`uvx notebooklm-mcp server`). **Wyłączony** w `meta-agent.ts:87` z powodu problemów z Selenium.

### 1.5. `docs/`

Istnieje `MIGRATION-PLAN.md` (wstępny, 5-krokowy), `AGENTS-AND-TOOLS.md` (mapowanie pojęć), `WORKFLOWS.md`, `MCP-INTEGRATION.md`. Są rzetelne ale ogólne – ten plik zastępuje je dla deva.

### 1.6. Procentowy progress (vs. jarvis)

| Domena | % | Brakuje |
|---|---|---|
| Storage / runtime / observability | 100 % | – |
| Meta-agent jako supervisor | 65 % | prompty, ToolSearchProcessor, intent router, approvals |
| Marketing-agent | 40 % | prompty, narzędzia, 6 workflowów, podpięcie steps |
| Sales-agent | 20 % | prompty, 3 workflowy, narzędzia draftowania |
| Analytics-agent | 5 % | prompty, narzędzia, 3 workflowy |
| Automation-architect | 45 % | risk scoring, pattern catalog, RAG, deploy tool |
| Chef | 85 % | NotebookLM MCP (Selenium), iterate menu, query knowledge tool |
| Terminal worker | 100 % | – (jeśli zachowujemy taki mały zakres skilli) |
| Gmail/Calendar | 100 % / 60 % | brak `findEventByQuery`, `updateEvent`, `deleteEvent` jako tooli |
| n8n | 100 % | – |
| RSS | 100 % | – |
| CRM | 60 % | crm/* tooli – wszystkie 4 są stubami |
| Tavily search | 0 % | trzeba przepisać `packages/search` |
| LLM router / fallback | 30 % | brak `try/catch` + Ollama fallback per agent |
| NotebookLM | 0 % aktywny | MCP wyłączony |
| Approvals | 0 % | brak suspend/resume w workflowach |
| Shared memory | 10 % | tylko stub addContext |
| Prompts library | 0 % | nie ma `src/mastra/prompts/` |
| Dashboard ↔ Mastra | 0 % | dashboard nadal pyta MongoDB jarvis bezpośrednio |
| **Razem** | **~55 %** | |

---

## 2. Zasady ogólne (przed startem)

1. **Praca toczy się w `/projekty/mastra-agentic-environment/agentic-agents`.** W jarvis NIC nie zmieniamy – zostaje jako *read-only reference*. Wyjątek: dashboard (`apps/dashboard`) – patrz Etap 8 (decyzja: skopiować vs. trzymać tam, podpiąć do Mastry).
2. **Każdy plik tooli/agentów/workflowów ma 1 odpowiedzialność.** Nie wracamy do mega-`tool-definitions.ts` (1184 linii) z jarvis.
3. **Modele:**
   - `meta-agent`, `automation-architect` (planowanie): `google/gemini-2.5-pro`
   - `marketing`, `sales`, `analytics` (egzekucja): `google/gemini-2.5-flash` (taniej) z fallbackiem `google/gemini-2.5-pro`
   - `chef-agent` (jak go wprowadzimy): `google/gemini-2.5-pro`
   - `crm-agent`, `terminal-worker` (lokalne, deterministyczne): Ollama (`gemma3:27b` lub `qwen3:32b` – do potwierdzenia)
   - Embeddingi: `text-embedding-004` (Google) lub `nomic-embed-text` (Ollama). Decyzja: Google (już mamy klucz).
4. **Prompty:** `src/mastra/prompts/<obszar>/<nazwa>.md`. W kodzie ładujemy `await readFile(import.meta.resolve(...))`. Powód: edycja bez rebuilda + diff w PR.
5. **Schematy:** Zod 4. Wszystkie input/output narzędzi i workflowów mają `z.object({...}).strict()`.
6. **Kolekcje MongoDB:** zachowujemy te same nazwy co jarvis (`leads`, `tasks`, `runs`, `logs`, `approvals`, `conversations`, `chef_*`, `rss_*`, `signals`, `shared_memory`). Mastra dokłada własne (`mastra_messages`, `mastra_threads`, `mastra_traces`, `mastra_workflow_snapshots`) – nie kolidują.
7. **Sekrety:** wszystkie z `.env`. Lista wymaganych zmiennych w Etapie 9.
8. **Observability:** zaczynamy z `DefaultExporter` (DuckDB lokalnie). Nie podpinamy zewnętrznych (Langfuse/Datadog) na MVP.
9. **Approvals = `suspend()` w workflowie**, nie własna kolekcja. Patrz Etap 7B.
10. **Czego NIE TYKAĆ:**
    - `weather-agent.ts`, `weather-workflow.ts`, `weather-tool.ts`, `scorers/weather-scorer.ts` – zostawić jako wzór (jedyny agent z Memory + evalami).
    - `index.ts` storage/observability – jest poprawnie zrobione.
    - `terminal-tools.ts` – działa, sandbox jest OK.
    - `google/auth.ts`, `google/gmail.ts`, `google/calendar.ts` – gotowe, nie refaktoryzować.
    - `n8n/client.ts`, `n8n/n8n-tools.ts` – j.w.
    - `chef-service.ts` – 85 % gotowe, tylko dodajemy brakujące narzędzia.

---

## 3. Etap 1 – Sprzątanie i fundamenty (1 sesja)

### 3.1. Usuń duplikaty / stuby (commit "chore: cleanup")

- `src/mastra/tools/crm-tools.ts` – ZACHOWAĆ (działa). Przenieść jego zawartość do `src/mastra/tools/crm/search-leads.ts` (zastępuje obecny stub) i usunąć plik `crm-tools.ts`. Zaktualizować import w `crm-agent.ts:18` i `meta-agent.ts:4`.
- `src/mastra/tools/crm/create-lead.ts`, `update-status.ts`, `add-interaction.ts` – obecnie zwracają mock. W Etapie 4A wymienimy execute na realne MongoDB.
- `src/mastra/tools/memory/add-context.ts` – stub. W Etapie 4F podmienimy.
- `src/mastra/agents/marketing/steps/` – 11 plików skopiowanych "na surowo" z jarvis i NIE są używane. Przenieść do `src/mastra/_jarvis-reference/marketing-steps/` (folder z prefiksem `_` aby zaznaczyć: do portu, nie do importu). Po Etapie 6 całkowicie skasować.

### 3.2. Załóż katalogi

```
src/mastra/
├── prompts/                     # NEW
│   ├── meta/
│   ├── marketing/
│   ├── sales/
│   ├── analytics/
│   ├── automation/
│   └── chef/
├── lib/                         # NEW (utilities cross-tool)
│   ├── mongo.ts                 # singleton getDb()
│   ├── embedder.ts              # singleton embedder
│   ├── prompt-loader.ts         # loadPrompt(name) → string
│   └── tavily.ts                # client (Etap 4D)
├── tools/                       # rozbudowa istniejącej
│   ├── crm/
│   ├── google/
│   ├── n8n/
│   ├── rss/
│   ├── chef/
│   ├── memory/
│   ├── system/
│   ├── terminal/
│   ├── search/                  # NEW (tavily)
│   └── architect/               # NEW (risk scoring, pattern catalog)
└── workflows/
    ├── marketing/               # NEW
    ├── sales/                   # NEW
    └── analytics/               # NEW
```

### 3.3. `src/mastra/lib/mongo.ts`

Skopiować logikę `apps/workers/src/core/db.ts:1-62` z jarvis (lazy MongoClient, cached). Wystawić: `getDb()`, `getRssDb()`, `closeDb()`. Z tego korzystają wszystkie narzędzia domenowe które chodzą w MongoDB (CRM, RSS, Chef, shared memory).

### 3.4. `src/mastra/lib/prompt-loader.ts`

```ts
export async function loadPrompt(relativePath: string): Promise<string>
```
Czyta z `src/mastra/prompts/<path>.md`. Bez templatingu na MVP – jeśli prompt potrzebuje danych dynamicznych, robimy `prompt + "\n\n## Context\n" + JSON.stringify(ctx)`.

### 3.5. `src/mastra/lib/embedder.ts`

Singleton `google('text-embedding-004')` (lub fallback Ollama). Wykorzystywany w (a) Memory, (b) ToolSearchProcessor, (c) RAG patternów automation-architect (Etap 7), (d) chef notes embedding.

**Definition of done Etapu 1:** `pnpm dev` startuje, Mastra Studio (`http://localhost:4111`) widzi 7 agentów + 3 workflowy. Brak duplikatów `crm-tools.ts`. Folder `prompts/` istnieje (puste podfoldery z `.gitkeep`).

---

## 4. Etap 2 – Prompts (1 sesja)

Cel: skopiować istniejące prompty z jarvis i dostosować do Mastry. **Nie piszemy ich od nowa.** Jarvis ma sprawdzone prompty PL z głosem founderską.

### 4.1. Mapowanie 1:1

| Z jarvis | Do Mastra | Używany przez |
|---|---|---|
| `apps/workers/src/agents/meta-agent/prompts/base.md` | `prompts/meta/base.md` | `metaAgent.instructions` (template) |
| `.../meta-agent/prompts/intent-router.md` | `prompts/meta/intent-router.md` | router-agent (Etap 5) – opcjonalny |
| `.../meta-agent/prompts/knowledge-plan.md` | `prompts/meta/knowledge-plan.md` | `knowledgePlanTool` (Etap 4F) |
| `.../meta-agent/prompts/react.md` | **NIE PRZENOSIĆ** – Mastra ma własną pętlę | – |
| `.../meta-agent/prompts/response.md` | `prompts/meta/response.md` | `metaAgent.instructions` |
| `.../meta-agent/prompts/tools.md` | usunąć – Mastra opisuje narzędzia z `description` | – |
| `.../meta-agent/prompts/chef-domain.md` | `prompts/chef/domain.md` | `chefAgent.instructions` (Etap 6E) |
| `.../marketing-agent/prompts/research.md` | `prompts/marketing/research.md` | `researchTool` w producer-hunt |
| `.../marketing-agent/prompts/copy-pl.md` | `prompts/marketing/copy-pl.md` | weekly-content workflow |
| `.../marketing-agent/prompts/copy-en.md` | `prompts/marketing/copy-en.md` | j.w. |
| `.../marketing-agent/prompts/cold-email-draft.md` | `prompts/marketing/cold-email.md` | producer-hunt step "draft" |
| `.../marketing-agent/prompts/outreach-draft.md` | `prompts/marketing/outreach-draft.md` | producer-hunt |
| `.../terminal-worker/prompts/react.md` | **NIE PRZENOSIĆ** – Mastra robi pętlę | – |

### 4.2. `metaAgent.instructions`

Obecnie 5 linii. Przepisać na: `await loadPrompt('meta/base.md') + '\n\n' + await loadPrompt('meta/response.md')`. Plus statyczna lista zarejestrowanych agentów do delegacji + dostępnych workflowów (generowana z `Object.keys(mastra.agents)`).

**Definition of done Etapu 2:** wszystkie wymienione prompty istnieją w `prompts/`, `metaAgent.instructions` używa `loadPrompt`. Test ręczny w Mastra Studio: chat z meta-agentem zwraca polskie odpowiedzi w stylu founderskim.

---

## 5. Etap 3 – Memory + ToolSearchProcessor (1 sesja)

### 5.1. Memory dla wszystkich agentów

Każdy agent dostaje `memory: new Memory({ options: { lastMessages: 20, semanticRecall: { topK: 3 } } })`. Powód: rozmowa wieloturowa w dashboardzie + cross-task recall.

**Edytowane pliki:** `meta-agent.ts`, `marketing-agent.ts`, `sales-agent.ts`, `analytics-agent.ts`, `automation-architect.ts`, `crm-agent.ts`. **NIE TYKAĆ:** `weather-agent.ts` (już ma).

### 5.2. ToolSearchProcessor dla `metaAgent`

Meta-agent ma 31 tooli i będzie miał ~50. Dołączamy:
```ts
import { ToolSearchProcessor } from '@mastra/core/agent/processors';
// w metaAgent:
inputProcessors: [
  new ToolSearchProcessor({
    embedder: getEmbedder(),
    topK: 8,
    alwaysInclude: ['delegateTaskTool', 'searchLeadsTool', 'addContextTool'],
  })
]
```
Skutek: do promptu trafia tylko 8 narzędzi najtrafniejszych do zapytania (zamiast 31). Zastępuje `tool-rag-service.ts` z jarvis.

### 5.3. Working memory schema

Dla `metaAgent` i `marketingAgent`: zdefiniować szablon working memory (np. `{ activeProjectId, activeLeadEmail, autonomyMode }`). Dokumentacja Mastra: `Memory({ options: { workingMemory: { template: '...' } } })`.

**Definition of done Etapu 3:** wszyscy agenci mają Memory; meta-agent w Studio przy zapytaniu "znajdź leady z Mazowsza" dostaje tylko CRM-owe narzędzia w prompcie (sprawdzić w trace).

---

## 6. Etap 4 – Domknięcie tooli (2-3 sesje)

Cel: każdy stub zamienić na realny zapis/odczyt. Dodać brakujące.

### 6.1. CRM tools (4A) – PRIORYTET

Pliki: `tools/crm/{create-lead,update-status,search-leads,add-interaction}.ts`.

Wymiana `execute`:
- `searchLeadsTool` – już ma działający kod w starym `crm-tools.ts`; przenieść.
- `createLeadTool` – `db.collection('leads').findOneAndUpdate({email}, { $setOnInsert: {...}, $set: { updatedAt }}, { upsert: true })`.
- `updateStatusTool` – referencja: `packages/crm/src/leads.ts:81` z jarvis (push do `history`, walidacja statusów z `CRM_STATUSES`). Skopiować enum statusów do `tools/crm/_constants.ts`.
- `addInteractionTool` – `db.collection('leads').updateOne({...}, { $push: { history: {...} }, $set: { lastInteractionAt: new Date() }})`.

Dodać brakujące:
- `crm/update-lead.ts` – odpowiednik `crm.update_lead` z jarvis.
- `crm/record-email-draft.ts` – analog `crm.record_email_draft`.

### 6.2. Memory tool (4B)

`tools/memory/add-context.ts` – wymienić mock execute na zapis do kolekcji `shared_memory`. Schema (1:1 z `apps/workers/src/core/shared-memory.ts`):
```
{ id, sourceAgent, type, key?, content, ttlHours, expiresAt, createdAt }
```
Dodać `tools/memory/list-context.ts`, `tools/memory/push-signal.ts` (`signals` collection), `tools/memory/search-memory.ts` (semantyczne, embedding).

### 6.3. NotebookLM (4C)

**Decyzja architektoniczna:** MCP NotebookLM (`mcp.ts`) jest wyłączony przez Selenium. Dwie ścieżki:

**A) Naprawić Selenium** (preferowane long-term) – wymaga dystrybucji ChromeDrivera w środowisku Mastra. Out of scope MVP.

**B) Przepisać `packages/notebooklm/src/client.ts` z jarvis na zwykłe narzędzie Mastra** (preferowane MVP). Owija CLI `nlm` przez `child_process.spawn`. Pliki:
- `tools/knowledge/notebooklm-client.ts` – kopia `packages/notebooklm/src/client.ts`.
- `tools/knowledge/query-tool.ts` – `knowledge.query` (notebook + question).
- `tools/knowledge/list-notebooks-tool.ts`.
- `tools/knowledge/create-notebook-tool.ts` (do tymczasowych research-notebooków używanych w producer-hunt enrichment).
- `tools/knowledge/add-source-tool.ts`.
- `tools/knowledge/delete-notebook-tool.ts`.

Po zrobieniu – usunąć import `mcpClient` z `meta-agent.ts:8` i zostawić MCP zarejestrowane na potem. Podpiąć `knowledge.*` do `metaAgent.tools` i `marketingAgent.tools`.

### 6.4. Tavily search (4D)

Skopiować `packages/search/src/index.ts` z jarvis (~110 linii) do `tools/search/tavily-service.ts`. Dwa narzędzia:
- `searchWebTool` (`{query, maxResults}`)
- `findCompanyLinksTool` (`{companyName, region}`) – heurystyki dla LinkedIn/Facebook/panoramafirm itd.

Wymagane env: `TAVILY_API_KEY`. Podpiąć do `marketingAgent` (producer-hunt enrichment) i `metaAgent`.

### 6.5. Calendar uzupełnienia (4E)

Dodać do `google/google-tools.ts`:
- `calendarFindEventTool` (find by query/email)
- `calendarUpdateEventTool`
- `calendarDeleteEventTool`

Logika już jest w `google/calendar.ts` – tylko wystawić jako tools.

### 6.6. Chef uzupełnienia (4F)

Dodać do `chef/chef-tools.ts` brakujące (z jarvis tool-definitions.ts:835-1066):
- `chef.get_project`, `chef.list_projects`, `chef.save_menu`, `chef.get_menu`, `chef.iterate_menu`, `chef.get_recipe`, `chef.query_knowledge` (używa knowledge.* z 4C), `chef.suggest_pairing`, `chef.check_seasonal`, `chef.add_note`, `chef.search_notes`, `chef.export_menu`.

Większość metod już istnieje w `ChefService` – tylko owinięcie w `createTool()`.

### 6.7. Skille / agent-skills (4G)

Skopiować `packages/agent-skills/registry/` z jarvis do `src/mastra/_skills/` (markdown + YAML frontmatter). Narzędzie `subtask.delegate_loop` z jarvis = u nas: nowy agent `terminalWorkerAgent` (Etap 6F) z prompt = załadowany skill. **Nie kopiujemy** `packages/agent-skills/src/scripts/fetch-skills.ts` (skrypt fetchujący z GitHuba) – uruchamiamy go jednorazowo w starym repo, kopiujemy gotowe `.md`.

### 6.8. Approvals tool (4H)

W Mastra approvals robimy przez `suspend()` w workflowie (Etap 7B). Ale dla pojedynczego tool-call w trakcie konwersacji meta-agenta potrzebujemy mechanizmu "zarejestruj prośbę o approval, nie wykonuj". Strategia:
- `tools/system/request-approval.ts` – tool który zapisuje rekord w `approvals` (1:1 schema z jarvis `approval-manager.ts`) i zwraca `{ pendingApprovalId, status: 'pending' }`. Meta-agent dostaje to w obserwacji i kończy turę z prośbą o zatwierdzenie.
- Dashboardowy endpoint `/api/approvals/execute` (Etap 8) wywołuje wtedy odpowiednie narzędzie z `skipApproval: true` przez `mastra.getAgent(...).generate(...)`.

**Definition of done Etapu 4:** wszystkie tool-execute-y są realne (nie mockują). Test: w Mastra Studio z meta-agentem wykonać "stwórz lead Acme z Pomorza" → w MongoDB pojawia się rekord. "Wyszukaj producentów mleka" → Tavily zwraca wyniki.

---

## 7. Etap 5 – Meta-agent jako Supervisor (1 sesja)

### 7.1. Decyzja: Network vs. delegateTaskTool

Mastra ma dwie opcje:
- **Agent Networks** – natywna delegacja, automatyczna (eksperymentalna).
- **Custom delegate tool** – mamy już `delegateTaskTool`, prostsze, deterministyczne.

**Wybieramy delegateTaskTool** (prostsze, debugujemy w trace). Refaktor:
- `tools/system/delegate-task.ts` – obecnie hardkodowane 4 agentów. Zmienić na: czyta `mastra.getAgents()` i akceptuje dowolnego po `name`. Dodać `workflowName?: string` – jeśli podane, woła `mastra.getWorkflow(workflowName).start()` zamiast agenta.

### 7.2. Workflow.trigger jako tool

Dodać `tools/system/trigger-workflow.ts`:
```
input: { workflowId, payload }
execute: const wf = mastra.getWorkflow(workflowId);
         const run = await wf.createRun();
         const result = await run.start({ inputData: payload });
         return { runId: run.id, status: result.status };
```
Meta-agent używa go zamiast `delegateTaskTool` gdy widzi konkretny workflow do uruchomienia (producer-hunt, weekly-report itd.).

### 7.3. Intent-router (opcjonalnie)

W jarvis `intent-router.md` klasyfikuje intent → wybór ścieżki. W Mastra to można robić:
- **A)** w `metaAgent` przez prompt + tool-search (już mamy ToolSearchProcessor) – wystarczające w 80 % przypadków.
- **B)** osobny `routerAgent` z structuredOutput (`outputSchema = MetaIntentSchema`) – pierwsza tura przed delegacją. Tylko jeśli okaże się że meta-agent źle dobiera narzędzia.

**Decyzja MVP:** A. Wracamy do B jeśli evale wykażą problem.

**Definition of done Etapu 5:** w Studio "wygeneruj cotygodniowy briefing" → meta-agent woła `triggerWorkflow({ workflowId: 'morningBriefing' })`. "Zaplanuj automatyzację webhooka" → `delegateTaskTool({ targetAgent: 'automationArchitect' })`.

---

## 8. Etap 6 – Workflowy (3-4 sesje)

Każdy workflow = `createWorkflow({ id, inputSchema, outputSchema })` ze stepami `createStep({...})`. Pliki z jarvis (`apps/workers/src/agents/marketing-agent/index.ts:197-979`, `sales-agent/index.ts:88-372`, `analytics-agent/index.ts:107-233`) są źródłem prawdy logiki – nie bash+rg, tylko otwórz, przeczytaj, port.

### 8.1. Marketing workflows

**Workflow: `producerHuntWorkflow`** – istnieje, ale uproszczony. Rozbudować do 8 stepów (1:1 z jarvis):

| Step | Plik | Logika z jarvis |
|---|---|---|
| `discover-leads` | `workflows/marketing/producer-hunt/01-discover.ts` | `steps/outreach.ts:30-215` (Tavily + NotebookLM rhd/rynek + Discovery notebook) |
| `create-research-leads` | `02-research-only.ts` | `index.ts:461-478` (lead bez maila → status `research_needed`) |
| `enrich-leads` | `03-enrich.ts` | `steps/enrichment.ts:14-120` (temp NotebookLM + cleanup) |
| `extract-emails` | `04-extract-email.ts` | `index.ts:499-510` (LLM email-extraction) |
| `draft-cold-emails` | `05-draft.ts` | `steps/drafting.ts:10-164` (cold-email prompt + 2-tier repair) |
| `create-gmail-drafts` | `06-gmail.ts` | `gmail.createDraft` + `crm.record_email_draft` |
| `save-drafts-fs` | `07-save-fs.ts` | `DraftsStore.save` (Etap 6G – decyzja, czy zachowujemy filesystem store) |
| `update-crm` | `08-crm.ts` | `crm.upsertLead` + `crm.addInteraction` |
| `await-approval` | `09-approval.ts` | `await suspend()` |
| `send-on-approve` | `10-send.ts` | resume → `gmail.sendDraft` per draft |

Step `09` używa `suspend()`. Frontend dashboardu (Etap 8) wywołuje `mastra.getWorkflow('producerHunt').createRun({runId}).resume({stepId: 'await-approval', resumeData: {approved: true}})`.

**Workflow: `weeklyContentWorkflow`** – 6 stepów (research → copy-pl → copy-en → image-placeholder → drafts → approval).
**Workflow: `inboxMonitorWorkflow`** – 1 trigger + step (`steps/email-check.ts`). Cron co 30 min (Etap 9.4).
**Workflow: `syncCrmWorkflow`** – 1 step (`steps/sync-sent.ts`).
**Workflow: `automatedFollowupWorkflow`** – 4 stepy (query stale leads → follow-up draft → save → suspend → resume sends).
**Workflow: `morningBriefingWorkflow`** – 1 step (`steps/morning-briefing.ts`).

### 8.2. Sales workflows

- `proposalGeneratorWorkflow` – 5 stepów (find-lead → llm-proposal → save-fs → gmail-draft → suspend approval).
- `meetingSchedulerWorkflow` – 3 stepy (find-lead → calendar-create → crm-log).
- `onboardingChecklistWorkflow` – 4 stepy (find-lead → llm-checklist → save-fs → suspend).

### 8.3. Analytics workflows

- `weeklyReportWorkflow` – 4 stepy (collect-metrics → push-signals → llm-report → save).
- `roiCalculatorWorkflow` – 2 stepy (query-funnel → calculate).
- `trendAnalysisWorkflow` – 3 stepy (notebook-query → llm-insights → save-memory).

### 8.4. Drafts filesystem store (4G)

**Decyzja:** zachowujemy filesystem (jak w jarvis `packages/drafts/src/store.ts`) – dashboard już to ogląda. Skopiować `DraftsStore` do `src/mastra/lib/drafts-store.ts`. Wykorzystywany w stepach `save-fs`.

**Definition of done Etapu 6:** wszystkie 12 workflowów zarejestrowanych w `mastra.workflows`. W Studio każdy ma diagram, można uruchomić ręcznie z input. Producer-hunt z `approvalMode=true` zatrzymuje się na `await-approval`.

---

## 9. Etap 7 – Brakujące domeny (2 sesje)

### 9.1. Automation Architect (7A)

Refaktor `packages/automation-architect` z jarvis (~30 plików) do Mastra:

- `tools/architect/types/` – kopiuj `AutomationRequest`, `AutomationSpec`, `RiskReport` (Zod schemy z jarvis `src/schemas/`).
- `tools/architect/risk/` – `forbiddenNodes.ts`, `riskRules.ts`, `scoreRisk.ts` (kopia 1:1).
- `tools/architect/patterns/catalog.ts` + `builders/*` – 12 pre-built patternów (kopia 1:1).
- `tools/architect/pattern-rag.ts` – embedduje `catalog.ts` przez `getEmbedder()`, zapisuje do `automation_patterns` w MongoDB. Funkcja `searchPatterns(spec)` – cosine similarity.
- `tools/architect/composer.ts` – `blockComposer` (kopia 1:1).
- Tools (eksponowane do `automationArchitect.tools`):
  - `architectPlanSpecTool` – LLM → `AutomationSpec`.
  - `architectMatchPatternTool` – RAG.
  - `architectLookupNodeTool`.
  - `architectComposeWorkflowTool`.
  - `architectValidateWorkflowTool`.
  - `architectAssessRiskTool`.
  - `architectDeployAutomationTool` – calls `n8nUpdateWorkflowTool` lub `n8nCreateWorkflowTool` (do dodania w Etap 4 – brakujące w n8n-tools).
  - `architectSyncPatternsTool`.

Te tools podpinamy do `automationArchitect.instructions` ze szczegółowym promptem (z jarvis `prompts/react.md:82-235` opisuje "golden path" pipeline).

### 9.2. Approvals przez suspend/resume (7B)

W Mastra workflow:
```ts
const awaitApproval = createStep({
  id: 'await-approval',
  inputSchema: z.object({ drafts: z.array(...) }),
  resumeSchema: z.object({ approved: z.boolean(), reason: z.string().optional() }),
  outputSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, suspend, resumeData }) => {
    if (!resumeData) {
      // pierwsze wejście – zapisz prośbę i zawieś
      await db.collection('approvals').insertOne({ ... });
      return await suspend({ drafts: inputData.drafts });
    }
    return { approved: resumeData.approved };
  }
});
```
Dashboard pokazuje listę zawieszonych runów (Mastra API: `mastra.getStorage().listSuspendedRuns()`) i wystawia przyciski. Schema `approvals` collection – kompatybilna z jarvis (żeby nie przepisywać UI).

### 9.3. Shared memory (7C)

Etap 4B daje narzędzia `addContextTool`, `listContextTool`, `pushSignalTool`. Tu robimy:
- `outputProcessors: [SharedMemoryAttacher]` na `metaAgent` – przed każdą turą agenta dokleja do contextu aktywne sygnały (wycinka z `signals` z TTL > now). 1:1 z `getSharedMemoryPrompt()` z jarvis `base-agent.ts`.
- Cron co 5 min czyści wygasłe (jarvis `proactive.ts:33-64` – tu Mastra Workflow `cleanupSharedMemoryWorkflow` z triggerem cron).

**Definition of done Etapu 7:** automation-architect kończy w Studio pełen flow "trigger → spec → match → compose → validate → assess → suspend → resume → deploy → activate" dla testowego webhooka. Producer-hunt suspend na approval pokazuje rekord w MongoDB `approvals` zgodny ze schemą jarvis.

---

## 10. Etap 8 – Dashboard (1-2 sesje)

**Strategia:** zachowujemy `apps/dashboard` z jarvis (UI jest dobry). **Przenosimy go do `mastra-agentic-environment/apps/dashboard`** (osobny pnpm/npm workspace) lub **trzymamy w jarvis i podpinamy do Mastry przez HTTP** – decyzja użytkownika. Plan zakłada przeniesienie (czyściej).

### 10.1. Migracja dashboardu

1. `cp -r /projekty/jarvis-dashboard-agent/apps/dashboard /projekty/mastra-agentic-environment/apps/dashboard`. Założyć tam workspace pnpm/npm (Mastra używa npm – sprawdzić, czy nie konfliktuje).
2. Zaktualizować `apps/dashboard/package.json` – usunąć zależności workspace `@af/*`, zostawić same publiczne.

### 10.2. Co usuwamy w dashboardzie

- `src/lib/queue.ts` (BullMQ) – nie używamy już Redisa. Zastępca: HTTP do Mastra workflow `createRun().start()`.
- `src/lib/approval-flow.ts` – funkcja generuje BullMQ payload. Zastępca: `mastra.getWorkflow(...).createRun({runId}).resume(...)`.
- `src/app/api/events/route.ts` (SSE z Redis) – zastępca: SSE z Mastra workflow `.stream()` lub Mastra Studio events.
- `src/lib/db.ts` (MongoClient) – ZACHOWAĆ tymczasowo (dashboard nadal czyta `tasks`, `runs`, `logs`, `approvals`, `leads`, `chef_*`, `rss_*`). Te kolekcje są wspólne. Ale: docelowo dashboard powinien pytać Mastrę przez `mastra.getStorage().getMessages(...)` itd. – etap 2 refaktoringu, na razie skip.

### 10.3. API routes – mapowanie

| Stary endpoint | Nowy backend |
|---|---|
| `POST /api/tasks/trigger` | `mastra.getAgent(agentId).generate(...)` lub `getWorkflow(workflowId).createRun().start(input)` |
| `GET /api/tasks/[id]` | Zostawić (czyta z MongoDB `tasks`+`runs`+`logs`) – Mastra zapisuje swoje `mastra_traces` osobno; dashboard widzi i jedne i drugie |
| `POST /api/approvals/execute` | `getWorkflow(...).createRun({runId}).resume({stepId: 'await-approval', resumeData: {approved}})` |
| `POST /api/meta-agent/chat` | `mastra.getAgent('metaAgent').generate({messages, threadId, resourceId})` – Mastra Memory zarządza historią, kolekcję `conversations` z jarvis można zostawić tylko do listy threadów |
| `GET /api/meta-agent/sync` | j.w. + polling status |
| `GET /api/events` | Mastra `agent.stream()` zwraca AsyncIterable, można reemitować jako SSE |
| `GET /api/settings/llm` | Zostawić – kolekcja `settings` jest wspólna |
| `GET /api/settings/runtime` | `runtime-health.ts` – update: zamiast pingować Redis, pingnąć Mastra `/api` healthcheck |
| `GET /api/crm`, `/api/knowledge`, `/api/rss`, `/api/drafts`, `/api/alerts`, `/api/analytics` | Zostawić bez zmian (czytają wspólne kolekcje) |
| `GET /api/agents/[id]/heartbeat` | Mastra Studio pokazuje status; w dashboardzie czytać z `mastra_traces` (ostatnia aktywność per agent) |
| `POST /api/auth/google/*` | Zostawić |

### 10.4. Klient Mastry w dashboardzie

Dodać `apps/dashboard/src/lib/mastra-client.ts`:
```ts
import { MastraClient } from '@mastra/client-js';
export const mastraClient = new MastraClient({
  baseUrl: process.env.NEXT_PUBLIC_MASTRA_URL ?? 'http://localhost:4111'
});
```
Wywołania: `mastraClient.getAgent('metaAgent').generate(...)`.

### 10.5. Studio jako dev-tool

Mastra Studio (`http://localhost:4111`) zostaje do debugowania (chat playground, traces, evals). Główny UX dla użytkownika to dashboard Next.js – produkcyjnie odpalany pod inną domeną.

**Definition of done Etapu 8:** dashboard ładuje się obok Mastry. Klikanie na "uruchom workflow" w `/agents` faktycznie startuje Mastra workflow. Approval w `/approvals` resume'uje suspended run. Chat w `/meta-agent` rozmawia z Mastra metaAgent przez `/v1/agents/...`.

---

## 11. Etap 9 – Operacje (1 sesja)

### 11.1. `.env`

Wymagane (kompilacja `.env.example`):
```
# storage
MONGODB_URI=mongodb://localhost:27017/agentforge

# LLM
GOOGLE_GENERATIVE_AI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434

# Google services
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=

# Search
TAVILY_API_KEY=

# n8n
N8N_BASE_URL=http://localhost:5678
N8N_API_KEY=
N8N_PUBLIC_WEBHOOK_BASE_URL=

# NotebookLM CLI
NLM_BINARY_PATH=nlm

# Mastra (opcjonalne)
MASTRA_CLOUD_ACCESS_TOKEN=

# Worker config
SANDBOX_PATH=/tmp/sandbox-Jarvis
```

### 11.2. `package.json` skrypty

Dodać:
- `dev:dashboard` – Next.js dev na porcie 3000.
- `dev:all` – concurrently `mastra dev` + `dev:dashboard`.
- `db:indexes` – jednorazowy skrypt który tworzy indeksy w MongoDB (kopia `apps/workers/src/core/db.ts:ensureChefIndexes` + indeksy dla `leads.email`, `tasks.taskId`, `approvals.status`, `signals.expiresAt` TTL).

### 11.3. Cron / scheduled triggers

Mastra na MVP nie ma natywnego cron triggera (sprawdzić w wersji 1.31, dokumentacja niejasna). Zewnętrzny cron (systemd timer / GH Actions / `node-cron` w osobnym mini-procesie) wywołuje HTTP `POST /v1/workflows/{id}/start`. Schedule mapowany 1:1 z `packages/shared/src/agentConfig.ts`:

```
weekly-content      → 0 7  * * 1
producer-hunt       → 0 8  * * 3   (disabled by default)
inbox-monitor       → */30 * * * *  (disabled)
sync-crm            → 0 10 * * *
automated-followup  → 0 9  * * *
morning-briefing    → 0 8  * * *
weekly-report       → 0 7  * * 1
roi-calculator      → 0 13 * * 5
trend-analysis      → 0 9  * * 2
proposal-generator  → 0 10 * * *
meeting-scheduler   → 0 11 * * *
onboarding-checklist→ 0 12 * * *
```
Zostawiamy domyślnie wszystko **disabled** poza `weekly-content` i `morning-briefing`, włączamy ręcznie z dashboardu.

### 11.4. Indeksy MongoDB (uruchomić raz po pierwszym deploy)

```
leads: {email:1}, {status:1}, {region:1}, {updatedAt:-1}
tasks: {taskId:1}, {agentId:1}, {createdAt:-1}, {status:1}
runs: {taskId:1}, {agentId:1}
logs: {timestamp:-1}, {agentId:1}, {level:1}, TTL 30 dni na timestamp
approvals: {status:1}, {createdAt:-1}, {executionTaskId:1}
signals: {expiresAt:1} TTL
shared_memory: {expiresAt:1} TTL
conversations: {threadId:1}, {updatedAt:-1}
chef_projects, chef_menus, chef_recipes, chef_notes – jak w `ensureChefIndexes`
automation_patterns: {embedding} – Atlas vector index (lub fallback w pamięci)
```

### 11.5. Observability MVP

`DefaultExporter` (DuckDB) wystarcza. Po stabilizacji rozważyć Langfuse (zewnętrzny, darmowy tier) dla per-step kosztu i diff promptów.

**Definition of done Etapu 9:** `.env.example` istnieje. `pnpm dev:all` uruchamia Mastra Studio na :4111 i dashboard na :3000. Indeksy w MongoDB utworzone. Zewnętrzny cron strzelający w Mastra workflow `weekly-content` co poniedziałek przetestowany ręcznie.

---

## 12. Etap 10 – Evale i jakość (ciągłe)

### 12.1. Skopiować schemat z `weather-agent.ts`

Dla najczęściej używanych ścieżek dodać scorery:
- `metaAgent` – tool-call appropriateness (czy do CRM zapytania użył CRM tools? czy do automatyzacji – architect?).
- `marketingAgent` (drafting) – completeness (czy email ma subject + body + personalization?).
- `automationArchitect` – risk soundness (czy assessRisk zostało wywołane przed deployem?).

Nie blokujące, sampling 10-20%.

### 12.2. Snapshot testy promptów

Każdy prompt z `src/mastra/prompts/` przechodzi przez prosty test "render → diff" w CI – żeby PR widać, że prompt się zmienił.

---

## 13. Kolejność wykonania (rekomendowana)

```
Sprint 1 (≤1 tydzień):
  Etap 1 (sprzątanie, lib)                      [1 sesja]
  Etap 2 (prompts)                               [1 sesja]
  Etap 4A + 4B (CRM tools + memory tool)        [1 sesja]
  Etap 3 (Memory + ToolSearchProcessor)         [1 sesja]

Sprint 2:
  Etap 4C (NotebookLM przez CLI)                [1 sesja]
  Etap 4D (Tavily)                              [0.5 sesji]
  Etap 4E + 4F (Calendar + Chef uzupełnienia)  [1 sesja]
  Etap 5 (Supervisor + triggerWorkflow)         [0.5 sesji]

Sprint 3:
  Etap 6 marketing workflows (1-3)              [1 sesja]
  Etap 6 marketing workflows (4-6)              [1 sesja]
  Etap 6 sales workflows                        [1 sesja]
  Etap 6 analytics workflows                    [1 sesja]

Sprint 4:
  Etap 7A (Automation Architect)                [2 sesje]
  Etap 7B (Approvals przez suspend)             [0.5 sesji]
  Etap 7C (Shared memory processor)             [0.5 sesji]

Sprint 5:
  Etap 8 (Dashboard refactor)                   [2 sesje]
  Etap 9 (Operacje, env, cron, indeksy)         [1 sesja]

Continuous: Etap 10 (evale, snapshoty).
```

---

## 14. Czego NIE ROBIMY (świadomie)

1. Nie przenosimy `apps/workers/src/index.ts` (worker bootstrap) – Mastra to robi.
2. Nie przenosimy własnej pętli ReAct ani regex-parsowania z `terminal-worker/index.ts` ani `react-loop.ts`.
3. Nie przenosimy `LLMRouter` ani fallback chain – Mastra ma model providers; w razie potrzeby fallback robimy `try/catch` na `agent.generate` i wołamy zapasowego agenta z innym `model:`.
4. Nie przenosimy własnego event/SSE buslo-ka – Mastra workflow `.stream()` + Studio.
5. Nie przepisujemy wszystkich 70 tooli z jarvis – wiele to duplikaty (np. `system.read_tasks`, `system.read_logs`) które dashboard i tak robi bezpośrednio z DB.
6. Nie kopiujemy `apps/workers/src/core/Agent.ts` (legacy duplikat `base-agent.ts`).
7. Nie ruszamy `weather-*` plików – zostają jako wzorzec.
8. Nie tykamy istniejących, działających tooli Gmail/Calendar/n8n/RSS/terminal w mastra repo.
9. Nie naprawiamy Selenium NotebookLM MCP teraz – obchodzimy przez CLI tool (Etap 4C).
10. Nie projektujemy Atlas Vector Search dla pełnego RAG patternów na MVP – fallback w pamięci (cosine on `automation_patterns` collection) wystarcza dla 12 patternów.

---

## 15. Definition of Done (cały transfer)

- W Mastra Studio widać 8+ agentów (meta, marketing, sales, analytics, automation-architect, chef, terminal, crm, weather) i 12+ workflowów.
- Każdy workflow uruchomi się z UI Studio na test inputach i zakończy bez błędów (lub zatrzyma na approval).
- Dashboard Next.js mówi do Mastry przez `MastraClient` – nie ma już `BullMQ.add` ani direct Redis pub/sub.
- MongoDB ma kolekcje `leads`, `approvals`, `chef_*`, `rss_*`, `signals`, `shared_memory`, `automation_patterns`, `conversations` PLUS Mastrowe (`mastra_messages`, `mastra_threads`, `mastra_traces`, `mastra_workflow_snapshots`).
- Cron (zewnętrzny) startuje `morningBriefingWorkflow` codziennie o 8:00 z sukcesem.
- Producer-hunt z 3 leadami testowymi przechodzi pełen flow: discover → enrich → draft → suspend → resume → wysyła 3 maile testowe.
- Plik `apps/workers/` (cały folder) jest usunięty z jarvis lub przeniesiony do `_archive/`.
- W jarvis zostają tylko `apps/dashboard/` (jeśli nie przeniesiony), `packages/shared/src/types.ts` jako referencja, oraz `ideas/` z planami.

---

**Koniec planu. Plik: `ideas/mastra-plan-transfer.md`. Następny krok: zacząć Etap 1, sesja sprzątania.**
