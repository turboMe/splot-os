# Universal Task Orchestrator - plan implementacji po audycie kodu

> Status: MVP + HARDENING ZAIMPLEMENTOWANE | Data: 2026-06-26  
> Cel: dac agentom zdolnosc planowania zadan w czasie: uruchamiania agentow, n8n webhookow i Mastra workflow, z lancuchowaniem krokow, stanem w MongoDB i kontrolowanym lazy-load kontekstu z poprzednich watkow.
> Implementacja: `scheduled_tasks` + `task_chains` + `scheduled_task_dispatches`, narzedzia `schedule_task` / `list_scheduled_tasks` / `get_scheduled_task` / `cancel_scheduled_task` / `reschedule_scheduled_task` / `get_chain_context` / `save_chain_result` / `get_thread_context`, runner `npm run scheduled-tasks`, supervisor `npm run scheduled-tasks:supervisor`, smoke `npm run check:scheduled-tasks`.

---

## Wynik audytu planu

Pierwotny kierunek byl dobry, ale plan mial kilka blednych zalozen wzgledem realnego runtime w tym repo.

### Bledne zalozenia do usuniecia

1. **`mcp__scheduled-tasks` nie jest dostepne w repo jako tool Mastry.**  
   W kodzie nie ma implementacji ani rejestracji `mcp__scheduled-tasks`, `create_scheduled_task`, `update_scheduled_task` ani `schedule_task`. Wystepowaly tylko w tym dokumencie. Nie mozemy budowac MVP na zalozeniu, ze meta-agent juz ma taki transport.

2. **`SKILL.md` nie powinien byc dispatcherem runtime.**  
   Claude Code scheduled task moglby uruchomic prompt, ale taki prompt nie ma gwarantowanego dostepu do narzedzi Mastry (`workflow_trigger`, `n8n_trigger`, `system_delegate_task`, `save_chain_result`). Dispatcher musi byc kodem w procesie Mastry albo jawnie wywolanym endpointem Mastry, nie instrukcja w zewnetrznym `SKILL.md`.

3. **`memory.searchMessages()` istnieje, ale nie jest jeszcze pewnym fundamentem MVP.**  
   Lokalny `@mastra/memory` ma `searchMessages()`, ale wymaga `retrieval: { vector: true }` oraz Memory-level `vectorStore` + `embedder`. Obecne agenty maja `observationalMemory`, ale nie maja jawnie skonfigurowanego vector store w `new Memory(...)`. Dlatego `get_thread_context` musi miec fallback na zwykly odczyt watku / raw messages / istniejace `system_knowledge`, a semantyczne wyszukiwanie rozmow zostaje opcja po tescie Fazy 0.

4. **Nie budujemy osobnego swiata jobow od zera.**  
   Repo ma juz przydatne prymitywy: `async-delegation`, `background-task-manager`, `automation-job-manager`, `pending-message-queue`, `checkPendingUpdates`, `triggerWorkflowTool`, `n8nTriggerWebhookTool`, `getDb()` i indeksy Mongo. Nowy scheduler powinien je rozszerzac, nie omijac.

---

## Co juz mamy w kodzie

| Komponent | Realny stan |
|---|---|
| Mastra workflow trigger | `src/mastra/tools/system/trigger-workflow.ts` (`workflow_trigger`) |
| n8n webhook trigger | `src/mastra/tools/n8n/n8n-tools.ts` (`n8n_trigger`) |
| Delegacja agentow | `src/mastra/tools/system/delegate-task.ts` (`system_delegate_task`) |
| Async delegacje | `src/mastra/services/async-delegation.ts` + `pending_user_messages` |
| Durable background tasks | `src/mastra/services/background-task-manager.ts` |
| Durable automation jobs | `src/mastra/services/automation-job-manager.ts` |
| Cron runner | `src/mastra/scripts/cron-runner.ts`, ale obecnie statyczny |
| Mongo connection + indeksy | `src/mastra/lib/mongo.ts` |
| Shared semantic memory | `system_knowledge` przez `memory_write` / `memory_recall` |
| Memory threads | `Memory.getThreadById()`, `recall()`, `getContext()` w `@mastra/memory` |
| Conversation semantic search | API istnieje jako `searchMessages()`, ale wymaga vector/retrieval konfiguracji |

---

## Architektura docelowa

Zamiast transportu Claude `mcp__scheduled-tasks`, MVP powinien byc natywny dla Mastry:

```text
AGENT / USER
  |
  | calls schedule_task
  v
Scheduled Task Store (MongoDB: scheduled_tasks)
  - taskId, chainId, target, schedule, status, retry policy
  - parentThreadId, resourceId, nextStep, payload
  |
  | picked up by
  v
Mastra Scheduled Task Runner
  - long-running script: npm run scheduled-tasks
  - checks due tasks every N seconds
  - leases one task atomically
  - dispatches through local code
  |
  +--> targetType=AGENT          -> mastra.getAgent(...).generate(...) / harness adapter
  +--> targetType=MASTRA_WORKFLOW -> workflow.createRun().start(...)
  +--> targetType=N8N_WEBHOOK     -> N8nService.triggerWebhook(...)
  +--> targetType=WORKER_COMMAND  -> background-task-manager, if explicitly allowed
  |
  v
Task Chain Store (MongoDB: task_chains)
  - step results, artifacts, errors, timing, expiresAt TTL
  |
  v
pending_user_messages
  - optional wake-up for meta-agent/user thread
```

### Dlaczego tak

- Dziala w tym repo bez zewnetrznego Claude scheduler transportu.
- Zachowuje tool access, telemetry, harness, GoalContract i pending-update pattern.
- Pozwala uruchamiac n8n i Mastra workflow bez proszenia modelu, zeby "pamietal" jak dispatchowac.
- Jest testowalne lokalnie przez jeden skrypt runnera i Mongo.

---

## Model danych

### ScheduledTask

```ts
type TargetType = 'AGENT' | 'N8N_WEBHOOK' | 'MASTRA_WORKFLOW' | 'WORKER_COMMAND';

type ScheduledTaskStatus =
  | 'scheduled'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

interface ScheduledTask {
  taskId: string;
  status: ScheduledTaskStatus;

  schedule: {
    fireAt?: Date;              // one-time execution
    cronExpression?: string;    // recurring execution, phase 2
    timezone?: string;          // default UTC
  };

  targetType: TargetType;
  targetIdentifier: string;     // agent registry key / webhookPath / workflowId / command alias
  promptOrInstruction: string;
  payload?: Record<string, unknown>;

  chainId?: string;
  stepName?: string;
  chainName?: string;
  parentThreadId?: string;
  resourceId?: string;

  nextStep?: Omit<ScheduledTask, 'taskId' | 'status'>;

  retry: {
    maxAttempts: number;
    attempt: number;
    backoffMs: number;
  };

  lease?: {
    leaseId: string;
    leasedAt: Date;
    expiresAt: Date;
    runnerId: string;
  };

  wake?: {
    targetAgentId: string;      // default meta-agent
    threadId?: string;
  };

  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;             // TTL, e.g. 30 days
}
```

### TaskChainEntry

```ts
interface TaskChainEntry {
  chainId: string;
  stepName: string;
  taskId: string;
  status: 'completed' | 'failed';
  completedAt: Date;
  resultPreview?: string;
  resultArtifactId?: string;
  result?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
  expiresAt: Date;             // TTL, e.g. 30 days
}
```

### Indeksy Mongo

Dodac do `ensureIndexes()`:

```ts
db.collection('scheduled_tasks').createIndex({ taskId: 1 }, { unique: true });
db.collection('scheduled_tasks').createIndex({ status: 1, 'schedule.fireAt': 1 });
db.collection('scheduled_tasks').createIndex({ chainId: 1, createdAt: 1 });
db.collection('scheduled_tasks').createIndex({ 'lease.expiresAt': 1 });
db.collection('scheduled_tasks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

db.collection('task_chains').createIndex({ chainId: 1, completedAt: 1 });
db.collection('task_chains').createIndex({ taskId: 1 }, { unique: true, sparse: true });
db.collection('task_chains').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```

---

## Strategia watku i kontekstu

Nowy run scheduled task powinien dostawac nowy `threadId`, a poprzedni watek powinien byc referencja przez `parentThreadId`.

Powody:

1. Izolujemy context window kazdego odpalenia.
2. Nie przeciagamy 50+ poprzednich wiadomosci do kazdego crona.
3. Dajemy agentowi jawny, tani mechanizm lazy-load.
4. Zachowujemy powiazanie audytowe: `chainId`, `taskId`, `parentThreadId`, `resourceId`.

### `get_thread_context`

Tool powinien dzialac warstwowo:

1. Jesli Memory ma dzialajace `searchMessages()` z vector retrieval: zwroc top-K obserwacji dla `parentThreadId`.
2. Jesli nie: uzyj `getThreadById()` / `recall()` / storage messages dla ostatnich N wiadomosci.
3. Jesli raw messages sa niedostepne: zwroc metadane watku + sugestie uzycia `system_memory_recall`.
4. Zawsze limituj wynik, np. 2000-3000 tokenow.

To oznacza, ze MVP nie blokuje sie na vector store, a po wlaczeniu retrievalu od razu zyska lepszy recall.

---

## Narzedzia dla agentow

### `schedule_task`

Plik: `src/mastra/tools/system/schedule-task.ts`

Tworzy wpis w `scheduled_tasks`. Nie wywoluje zewnetrznego Claude scheduler.

Minimal input:

```ts
{
  fireAt?: string;
  cronExpression?: string;
  targetType: 'AGENT' | 'N8N_WEBHOOK' | 'MASTRA_WORKFLOW';
  targetIdentifier: string;
  promptOrInstruction: string;
  payload?: Record<string, unknown>;
  chainId?: string;
  chainName?: string;
  stepName?: string;
  parentThreadId?: string;
  resourceId?: string;
  nextStep?: { ... };
  wake?: boolean;
}
```

Zasady:

- `chainId` generowany automatycznie, jesli nie podany.
- `parentThreadId` przekazywany przez model albo przez wrapper/harness, jesli da sie go odczytac.
- `targetIdentifier` dla agenta musi byc registry key, np. `metaAgent`, `automationArchitect`, `knowledgeAgent`.
- Mutujace albo zewnetrzne skutki uboczne nadal musza respektowac istniejace approval gates.

### `get_chain_context`

Plik: `src/mastra/tools/system/task-chain-tools.ts`

Readonly. Zwraca wyniki poprzednich krokow po `chainId`, najlepiej jako skrot + artifact id.

### `save_chain_result`

Tez w `task-chain-tools.ts`, ale docelowo nie powinien byc wymagany od modelu w normalnym path. Runner zapisuje wynik automatycznie po kazdym dispatchu. Tool jest przydatny tylko, gdy agent wykonuje podkroki wewnatrz jednego scheduled run.

### `get_thread_context`

Plik: `src/mastra/tools/system/get-thread-context.ts`

Lazy-load poprzedniego watku. Musi degradowac sie bez vector search.

---

## Runner

Plik: `src/mastra/scripts/scheduled-task-runner.ts`

Runner moze zastapic albo rozszerzyc obecny `cron-runner.ts`. Najbezpieczniej dodac nowy skrypt i potem wpiac go do `npm run cron`, gdy testy przejda.

Wymagania:

1. Co 15-30 sekund znajduje due tasks:
   - `status: scheduled`
   - `schedule.fireAt <= now`
   - albo expired lease do recovery
2. Atomowo lease'uje jeden task:
   - `findOneAndUpdate` z warunkiem statusu
   - zapisuje `leaseId`, `runnerId`, `lease.expiresAt`
3. Ustawia `running`.
4. Dispatchuje po `targetType`.
5. Zapisuje `task_chains`.
6. Ustawia `completed` albo `failed`.
7. Jesli `nextStep` istnieje i aktualny krok zakonczyl sie sukcesem, tworzy nastepny `scheduled_tasks`.
8. Jesli `wake` wlaczone, kolejkuje wynik do `pending_user_messages`.
9. Przy bledzie respektuje retry policy.

### Dispatcher

`AGENT`:

- MVP: `mastra.getAgent(targetIdentifier).generate(prompt, { memory: { thread, resource } })`.
- Dla specjalnych agentow warto uzyc istniejacych harness adapters, gdy sa dostepne (`generateAutomation`, `generateKnowledge`, `generateCoding`), zeby zachowac telemetry i precontext.

`MASTRA_WORKFLOW`:

- Uzyc logiki z `triggerWorkflowTool`: `workflow.createRun().start({ inputData })`.

`N8N_WEBHOOK`:

- Uzyc `N8nService.triggerWebhook(webhookPath, data)`.
- `targetIdentifier` powinien byc `webhookPath`, nie pelny URL, zgodnie z aktualnym `n8n_trigger`.

`WORKER_COMMAND`:

- Nie w MVP albo tylko allowlista aliasow.
- Nie przyjmowac arbitralnego shell command od modelu w schedulerze.

---

## Fazy implementacji

### Faza 0 - weryfikacja runtime (0.5 dnia)

- [x] Potwierdzic, ze runner moze importowac `mastra` bez cyklu ubocznego. Implementacja: dynamic import tylko w trybie CLI.
- [x] Sprawdzic nazwy registry agentow w `index.ts`. Runner oczekuje registry key, np. `metaAgent`, `automationArchitect`, `codingAgent`.
- [x] Sprawdzic realny dostep do Memory messages: fallback czyta `mastra_threads` / `mastra_messages` z Mongo.
- [x] Zweryfikowac, czy `searchMessages()` dziala bez dodatkowego vector store. Decyzja MVP: nie uzywamy semantic search; `get_thread_context` jawnie zwraca `semanticSearchUsed: false`.
- [x] Zdecydowac, czy `cron-runner.ts` rozszerzamy, czy dodajemy osobny `scheduled-task-runner.ts`. Wybrano osobny runner.

### Faza 1 - store i indeksy (0.5-1 dnia)

- [x] `src/mastra/services/scheduled-task-store.ts`
- [x] `src/mastra/services/task-chain-store.ts`
- [x] Indeksy w `src/mastra/lib/mongo.ts`, `src/mastra/lib/mongo-indexes.ts` i `src/mastra/scripts/init-db.ts`
- [x] Smoke test store/runner: create, lease, complete, chain result.
- [x] Dodatkowy regresyjny test retry + nextStep.

### Faza 2 - narzedzia systemowe (1 dzien)

- [x] `schedule_task`
- [x] `get_chain_context`
- [x] `save_chain_result`
- [x] `get_thread_context`
- [x] `list_scheduled_tasks`
- [x] `get_scheduled_task`
- [x] `cancel_scheduled_task`
- [x] `reschedule_scheduled_task`
- [x] Rejestracja w `meta-agent.ts` jako core orchestration tools.

### Faza 3 - runner i dispatcher (1-1.5 dnia)

- [x] `src/mastra/scripts/scheduled-task-runner.ts`
- [x] Dispatcher dla `AGENT`, `MASTRA_WORKFLOW`, `N8N_WEBHOOK`, plus bezpieczny `WORKER_COMMAND`.
- [x] Retry + lease recovery
- [x] Auto-save chain result
- [x] Queue result do `pending_user_messages`
- [x] `package.json` script: `scheduled-tasks`
- [x] Supervisor script: `scheduled-tasks:supervisor`, `scheduled-tasks:once`, `scheduled-tasks:status`

### Faza 4 - integracja z meta-agentem (0.5 dnia)

- [x] Instrukcja w promptach meta: kiedy uzywac `schedule_task`.
- [x] Zakaz planowania niezatwierdzonych skutkow ubocznych.
- [x] Kontrakt promptowy: kazdy scheduled chain ma miec success criteria w `promptOrInstruction`, `wake`, `chainName`, `stepName`.

### Faza 5 - hardening (1 dzien)

- [x] Dashboard/read API dla scheduled tasks.
- [x] Cancel/reschedule tool.
- [x] Recurring cron support z bezpiecznym next-fire calculation.
- [x] Idempotency key dla `N8N_WEBHOOK` i workflow przez `scheduled_task_dispatches`.
- [x] Metrics w `agent_events` / harness events.

### Faza 6 - testy i operacje (0.5 dnia)

- [x] Smoke retry + `nextStep`.
- [x] Fake `AGENT` dispatch smoke.
- [x] Fake `MASTRA_WORKFLOW` dispatch smoke.
- [x] Idempotency replay smoke.
- [x] Optional live `N8N_WEBHOOK` smoke za `CHECK_SCHEDULED_TASK_N8N_WEBHOOK_PATH`.
- [x] `/dashboard-ui` Scheduler tab.
- [x] `/workspace-ui` Scheduler tab.

### Follow-up po hardeningu

- [ ] Natywne idempotency headers/keys per zewnetrzna usluga, tam gdzie API je wspiera.
- [ ] Timeline chainow w dashboardzie: widok krok po kroku, retry, wynik, pending wake-up.

---

## Przyklad: 21:00 -> 00:00 -> 06:00

Meta-agent wywoluje `schedule_task` tylko dla kroku 1:

```ts
{
  chainName: 'cold-email-pipeline-2026-06-25',
  stepName: 'lead-snapshot',
  fireAt: '2026-06-25T21:00:00Z',
  targetType: 'AGENT',
  targetIdentifier: 'metaAgent',
  promptOrInstruction: 'Collect lead X data from CRM, save a concise result for the next step.',
  wake: false,
  nextStep: {
    chainName: 'cold-email-pipeline-2026-06-25',
    stepName: 'deep-research',
    fireAt: '2026-06-26T00:00:00Z',
    targetType: 'AGENT',
    targetIdentifier: 'automationArchitect',
    promptOrInstruction: 'Read chain context, run deep research for lead X, save findings.'
  }
}
```

Runner po sukcesie kroku 1 sam tworzy krok 2. Krok 2 po sukcesie tworzy krok 3:

```ts
{
  stepName: 'cold-email-draft',
  fireAt: '2026-06-26T06:00:00Z',
  targetType: 'AGENT',
  targetIdentifier: 'huntAgent',
  promptOrInstruction: 'Read chain context and create a Gmail draft or CRM draft. Do not send email without approval.',
  wake: true
}
```

Wynik kroku 3 trafia do `task_chains` oraz jako pending update do watku meta-agenta.

---

## Priorytet implementacji

**Must have:** Faza 0-3.  
**Should have:** Faza 4.  
**Nice to have:** Faza 5.

Szacunek po korekcie: 3-5 dni dla stabilnego MVP, bo trzeba dodac durable scheduler, lease/retry i dispatch w procesie Mastry. To jest wiecej pracy niz wrapper nad Claude scheduled tasks, ale jest zgodne z realnym kodem i bedzie dzialac poza jedna sesja Claude Code.

---

## Decyzja gotowa do implementacji

Implementacje zaczynac od Mastra-native scheduler:

1. Store + indeksy.
2. `schedule_task` i chain tools.
3. Runner z dispatcherem.
4. Rejestracja w meta-agent.
5. Smoke test: schedule one due task that calls a harmless agent/workflow and writes chain result.

Nie implementowac w MVP:

- zewnetrznego `mcp__scheduled-tasks`,
- generowania `SKILL.md`,
- arbitralnych shell commands jako scheduled target,
- pelnego cross-thread vector RAG przed potwierdzeniem `searchMessages()` w runtime.
