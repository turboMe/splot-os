# Architektura Agentów i Narzędzi w Mastra (Jarvis -> Mastra)

## Słownik pojęć

| Jarvis (stary system) | Mastra (nowy system) |
| --- | --- |
| `BaseAgent.run()` / `react-loop.ts` | Pętla `Thought-Action-Observation` obsługiwana natywnie w `.generate()` lub `.stream()`. Brak konieczności ręcznego pisania pętli. |
| `MetaAgentToolDefinition` z `zod` | `createTool()` z wejściem w postaci schematu `zod` oraz opcjonalnym wyjściem. Narzędzia mają wbudowaną akcję `execute`. |
| BullMQ `suggestedJobs` | **Mastra Workflows** dla długich operacji. **Supervisor Agents** dla orkiestracji mniejszych agentów. |
| `SharedMemoryService` / Telemetria w MongoDB | Natywny Storage w Mastra (`MastraMongoDBStore`). Obsługuje `Working Memory`, zapisuje wywołania modeli oraz umożliwia *Semantic Recall*. |

## Jak Tworzymy Agenty

Zamiast dziedziczyć z `BaseAgent` i rejestrować agenta w wielkim switchu, w Mastra każdy agent jest oddzielną instancją klasy `Agent`. 

Przykład Głównego Agenta:
```typescript
import { Agent } from '@mastra/core/agent';

export const metaAgent = new Agent({
  name: 'Meta Agent',
  instructions: '...',
  model: {
    provider: 'OLLAMA',
    name: 'llama3',
    toolChoice: 'auto',
  },
  // W przypadku Głównego Agenta (Supervisor), przekazujemy mu narzędzia 
  // do delegacji zadań (np. "SalesAgentTool")
});
```

## Jak Tworzymy Narzędzia

Każde narzędzie tworzymy poprzez moduł `createTool`. Zwraca on funkcję asynchroniczną, która zostanie automatycznie wykonana przez Agenta podczas cyklu "Action", o ile model uzna to za konieczne.

### Standard narzędzia (np. CRM)
Pliki trzymamy w `src/mastra/tools/[domena]/[narzedzie].ts`.

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const exampleTool = createTool({
  id: 'Example Tool',
  description: 'Zawsze opisuj, kiedy AI powinno tego użyć',
  input: z.object({
    // schemat Zod
  }),
  execute: async ({ context }) => {
    // Logika narzędzia (np. update w bazie, strzał do API)
    return { status: 'ok' };
  }
});
```

## Automatyczne Wyszukiwanie Narzędzi (RAG dla Skilli)

W Jarvis posiadałeś setki narzędzi i domen. Wrzucenie ich wszystkich naraz do jednego promptu przepełnia kontekst modelu. W Mastra możemy użyć `ToolSearchProcessor` oraz mechanizmów sieci agentów, by dołączać narzędzia *tylko* wtedy, gdy są potrzebne. Oznacza to mniejsze zużycie tokenów i brak halucynacji związanych z wyborem błędnego narzędzia.

## Durable Scheduled Orchestration

Meta Agent ma natywne narzędzia do planowania pracy w czasie: `schedule_task`, `list_scheduled_tasks`, `get_scheduled_task`, `cancel_scheduled_task`, `reschedule_scheduled_task`, `get_chain_context`, `save_chain_result` i `get_thread_context`. Zadania trafiaja do MongoDB (`scheduled_tasks`), wyniki kroków do `task_chains`, idempotency dispatchu do `scheduled_task_dispatches`, a proces `npm run scheduled-tasks` albo `npm run scheduled-tasks:supervisor` wykonuje je przez lokalny dispatcher Mastry: agent, workflow, n8n webhook albo bezpieczny `WORKER_COMMAND`.

Szczegoly operacyjne: [`UNIVERSAL-TASK-ORCHESTRATOR.md`](UNIVERSAL-TASK-ORCHESTRATOR.md).

## Sub-Agenci

Aby odciążyć Głównego Agenta i zapewnić wyższą skuteczność, skomplikowane obszary obsługiwane są przez węższych ekspertów:
- **Marketing Agent** (`marketingAgent`): Odpowiada za wyszukiwanie informacji (RSS), analizę podsumowań i obsługę komunikacji e-mail/kalendarza.
- **Sales Agent** (`salesAgent`): Aktualizuje statusy lejków w CRM i loguje poszczególne interakcje z potencjalnymi klientami. Posiada bezpośredni dostęp do narzędzi manipulacji CRM (updateStatusTool, addInteractionTool).
- **Analytics Agent** (`analyticsAgent`): Systemowy analityk logów operacyjnych. Raportuje błędy i wąskie gardła w zewnętrznych narzędziach (np. monitorowanie statusu n8n).
- **Automation Architect** (`automationArchitect`): Bezpośrednio zarządza systemami n8n, projektuje workflow'y i waliduje ich poprawność używając narzędzi specyficznych dla domen automatyzacji.
- **n8n MCP Engineer** (`n8nMcpEngineer`): Wewnętrzny subagent dostępny tylko dla `automationArchitect`. Obsługuje read-only `n8n-mcp` discovery/validation (`search_nodes`, `get_node`, `search_templates`, `get_template`, `validate_node`, `validate_workflow`) i zwraca handoff do Golden Path. Szczegóły: [`N8N-MCP-ENGINEER.md`](N8N-MCP-ENGINEER.md).
- **Knowledge Agent** (`knowledgeAgent`): Wąski operator Google NotebookLM. Obsługuje notebooki, źródła, research, cross-notebook Q&A i Studio artifacts przez NotebookLM MCP. Długie zadania mogą wracać do Meta Agenta przez pending updates. Status: closed 2026-05-14 po pozytywnych testach runtime/API/UI.
- **Design Agent** (`designAgent`): Port `huashu-design` jako domena HTML design/prototype/deck/animation z advisor mode, workerami `preset: design`, wrapperami `design_*`, eksportem PDF/PPTX/MP4/GIF, asset retrieval, image generation oraz ElevenLabs narration. Agent jest zarejestrowany i dostępny przez `system_delegate_task`; realne testy modeli/API/eksportów są odłożone do końcowej kolejki z [`DESIGN-AGENT.md`](DESIGN-AGENT.md).
- **Filmmaker Agent** (`filmmakerAgent`): Port `seedance-2.0` jako domena Seedance/film/video generation. Obsługuje stan projektu i kanon ujęć, prompt contracts T2V/I2V/V2V, reference loaders, deterministyczne walidatory, approval-gated `film_generate`, MP4 download ledger, take review i repair loops. Szczegóły: [`FILMMAKER-AGENT.md`](FILMMAKER-AGENT.md).
- **Musician Agent** (`musicianAgent`): Domena generowania muzyki/piosenek/audio (chef-pattern, lżejszy stan — utwór ≈ jedna generacja). Env-swappable surfaces: **fal** (ACE-Step async-poll default for text/lyrics), **fal-minimax-reference** (MiniMax with required reference audio), **fal-stable-audio**, **ElevenLabs Music** (sync-bytes) + opt-in seam `suno-gateway`. Obsługuje stan projektu/ścieżek/take'ów w Mongo, lyric/style authoring, walidatory TS (lint/safety/run), approval-gated `music_generate` (spend caps + content-policy), generation ledger, oraz **kartę Musician w dashboard-ui z odtwarzaczem audio** (`/ws/musician/*`, byte-range streaming). Korpus referencyjny `_skills/music/*` w trakcie portu (plan: [`../ideas/musician-skills-port.md`](../ideas/musician-skills-port.md)). Szczegóły: [`MUSICIAN-AGENT.md`](MUSICIAN-AGENT.md).

Dzięki natywnej obsłudze takich struktur, Meta Agent staje się *Supervisorem*, decydując do którego agenta "oddelegować" konkretne polecenie (lub workflow).
