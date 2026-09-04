# Plan Implementacyjny v2 — Część 1: Fazy 0–2
## Mastra Agentic Environment

Data: 2026-05-09 | Autor: Antigravity + Patryk
Ref: [plan-rozwoju.md](./plan-rozwoju.md) (decyzje architektoniczne)

---

## Konwencje

- **[PLIK]** = ścieżka względna od `src/mastra/`
- **[NOWY]** = nowy plik do stworzenia
- **[EDYCJA]** = modyfikacja istniejącego pliku
- **[TEST]** = weryfikacja po wdrożeniu
- **Zależność:** → oznacza "wymaga ukończenia X przed startem"

---

## FAZA 0 — Bugfix & Hardening

> Cel: Naprawić wykryte problemy z audytu zanim budujemy nowe warstwy.
> Szacowany czas: 1–2 sesje robocze
> Zależności: brak

### 0.1 Ujednolicenie expiresAt (Bug #2.4) — ✅ DONE 2026-05-09

**Problem:** `addContextTool` zapisuje `expiresAt` jako `Date`, `sharedMemoryOutputProcessor` jako ISO string. Query `{ $gt: new Date() }` nie łapie stringów.

**Kroki:**
1. **[EDYCJA]** `processors/shared-memory-output.ts:90`
   - Zmienić `expiresAt: ttl.toISOString()` → `expiresAt: ttl` (obiekt Date)
   - Analogicznie `createdAt: now.toISOString()` → zostawić jako string (to nie jest filtrowane)
2. **[TEST]** Uruchomić metaAgent, wygenerować odpowiedź z decision pattern → sprawdzić w Mongo czy `expiresAt` jest ISODate

### 0.2 TTL Indexy w Mongo (Bug #2.9) — ✅ DONE 2026-05-09

**Problem:** Kolekcje `signals` i `shared_memory` mają pole `expiresAt` ale brak TTL indexu — dokumenty nigdy nie wygasają automatycznie.

**Kroki:**
1. **[NOWY]** `lib/mongo-indexes.ts` — funkcja `ensureIndexes()`:
   ```ts
   export async function ensureIndexes() {
     const db = await getDb();
     await db.collection('signals').createIndex(
       { expiresAt: 1 }, { expireAfterSeconds: 0 }
     );
     await db.collection('shared_memory').createIndex(
       { expiresAt: 1 }, { expireAfterSeconds: 0 }
     );
     await db.collection('auto_healing_tickets').createIndex(
       { expiresAt: 1 }, { expireAfterSeconds: 0 }
     );
   }
   ```
2. **[EDYCJA]** `index.ts` — wywołać `ensureIndexes()` przy starcie Mastry (po `getDb()`)
3. **[TEST]** Wstawić dokument z `expiresAt: new Date(Date.now() - 1000)` → sprawdzić czy Mongo go usunie w ciągu 60s

### 0.3 Diagnostyka token_usage = 0 (Bug #2.2) — ⏳ Wymaga diagnozy runtime

**Problem:** `token_usage` kolekcja jest pusta. Observability pipeline (DuckDB + CloudExporter) nie zapisuje danych tokenowych.

**Kroki:**
1. **[TEST]** Uruchomić `agent.generate()` i sprawdzić w DuckDB: `SELECT * FROM traces WHERE attributes LIKE '%token%' LIMIT 5`
2. Jeśli traces istnieją ale nie ma token_usage → brakuje eksportera
3. Jeśli traces nie istnieją → problem z OTel konfiguracją w `index.ts`
4. **[EDYCJA]** W zależności od diagnozy — dodać hook do `CloudExporter` lub naprawić span attributes
5. **Cel minimum:** Po wdrożeniu każdy `agent.generate()` powinien zapisywać `{ model, promptTokens, completionTokens, totalTokens, costUsd, timestamp }`

### 0.4 Auto-save lesson po retry (Bug #2.1) — ✅ DONE 2026-05-09

**Problem:** `signals` = 0. System nigdy nie zapisuje lekcji z udanych retry/eskalacji.

**Kroki:**
1. **[EDYCJA]** `services/subtask-executor.ts` — w `retryFailedSubtasks()`:
   - Po udanym retry (attempt 2 lub 3) → automatycznie wywołać `pushSignalTool.execute()`:
   ```ts
   // Po linii gdzie result.status = 'success' po retry:
   if (retryQuality.passed && result.qualityCheck?.attempt > 1) {
     const { pushSignalTool } = await import('../tools/memory/add-context.js');
     await pushSignalTool.execute({
       type: 'lesson_learned',
       data: {
         task_pattern: `${subtask.type} on ${subtask.targetFiles.join(', ')}`,
         lesson: `Retry succeeded: ${retryQuality.reason}. Original failure: ${quality.reason}`,
         preset: retryResult.assignedModel,
       },
       ttlHours: 720, // 30 dni
       sourceAgent: 'subtask-executor',
     });
   }
   ```
2. **[EDYCJA]** `prompts/meta/system.md` — dodać sekcję:
   ```
   ## Lekcje i feedback
   Po udanym rozwiązaniu trudnego problemu lub po odkryciu nietypowego wzorca,
   ZAWSZE zapisz lekcję za pomocą shared_memory.push_signal z type='lesson_learned'.
   ```
3. **[TEST]** Uruchomić task który wymaga retry → sprawdzić `db.signals.find({type:'lesson_learned'})`

### 0.5 Walidacja komend w run_test (Bug #2.5) — ✅ DONE 2026-05-09

**Problem:** `runTestCommandTool` przyjmuje dowolną komendę. Ryzyko eskalacji.

**Kroki:**
1. **[EDYCJA]** `tools/dev/code-task-artifacts.ts` — w `runTestCommandTool`:
   ```ts
   const ALLOWED_PREFIXES = [
     'npx tsc', 'npx vitest', 'npx jest', 'npx eslint',
     'npm test', 'npm run test', 'npm run lint', 'npm run build',
     'node --check', 'cat ', 'head ', 'tail ', 'wc ',
   ];
   const isAllowed = ALLOWED_PREFIXES.some(p => command.startsWith(p));
   if (!isAllowed) {
     return { success: false, error: `Command not in allowlist. Allowed: ${ALLOWED_PREFIXES.join(', ')}` };
   }
   ```
2. **[TEST]** Wywołać z `rm -rf /` → powinno zwrócić error. Wywołać z `npx tsc --noEmit` → powinno działać.

---

## FAZA 1 — Pamięć operacyjna

> Cel: System zaczyna pamiętać i uczyć się z własnych operacji.
> Szacowany czas: 3–5 sesji roboczych
> Zależność: → Faza 0 (TTL indexy, expiresAt fix)

### 1.1 Observational Memory dla metaAgent (DECYZJA-01) — ✅ DONE 2026-05-09

**Zależność:** → 0.2 (TTL indexy — OM zapisuje do Mongo)

**Kroki:**
1. **[EDYCJA]** `agents/meta-agent.ts`:
   - Import Memory: `import { Memory } from '@mastra/memory';`
   - Dodać do konstruktora agenta:
   ```ts
   memory: new Memory({
     options: {
       lastMessages: 30,
       observationalMemory: {
         model: 'google/gemini-2.5-flash',
         temporalMarkers: true,
         retrieval: { scope: 'thread' },
       },
     },
   }),
   ```
2. **[TEST]** Uruchomić metaAgent z threadId → prowadzić rozmowę 40+ wiadomości → sprawdzić w Mongo:
   ```
   db.mastra_observational_memory.find().limit(5)
   ```
   Powinny pojawić się dokumenty z obserwacjami i refleksjami.
3. **[TEST]** Sprawdzić w Mastra Studio → Memory tab → potwierdzić że obserwacje są czytelne
4. **Rollback plan:** Jeśli OM generuje bzdury lub kosztuje za dużo → usunąć blok `observationalMemory` z config

### 1.1b Observational Memory dla codingAgent — ✅ DONE 2026-05-09

**Zależność:** → 1.1 (metaAgent pilot musi potwierdzić że OM działa poprawnie)

**Dlaczego codingAgent potrzebuje OM:**
codingAgent w Fazie 3 stanie się orkiestratorem delegującym 5-20 subtasków. Przy `lastMessages=30` po ~15 subtaskach traci kontekst wcześniejszych wyników. Bez OM:
- Nie pamięta co już zmodyfikował → duplikuje zmiany lub tworzy konflikty
- Traci architektoniczne decyzje z początku planowania
- Nie wie które subagenty już zakończyły pracę i z jakim wynikiem

**Kroki:**
1. **[EDYCJA]** `agents/coding-agent.ts`:
   ```ts
   memory: new Memory({
     options: {
       lastMessages: 30,
       observationalMemory: {
         model: 'google/gemini-2.5-flash',
         temporalMarkers: true,
         retrieval: { scope: 'thread' },
       },
     },
   }),
   ```
2. **[TEST]** Zlecić codingAgent task z 10+ subtaskami → sprawdzić czy po subtasku #15 nadal pamięta wyniki subtasku #1-3 (via obserwacje)
3. **Timing:** Wdrożyć PO potwierdzeniu że OM dla metaAgent działa stabilnie (krok 1.1). Jeśli metaAgent pilot wykaże problemy → naprawić je ZANIM włączymy OM dla codingAgent.

### 1.2 Agent Event Log — schemat i zapis (DECYZJA-02, krok 1) — ✅ DONE 2026-05-09

**Zależność:** → 0.2 (TTL indexy)

**Cel:** Ustrukturyzowany log WSZYSTKICH istotnych zdarzeń agentowych w jednej kolekcji.

**Kroki:**
1. **[NOWY]** `lib/agent-event-log.ts`:
   ```ts
   // Typy zdarzeń
   export type AgentEventType =
     | 'task_started' | 'task_completed' | 'task_failed'
     | 'tool_called' | 'tool_error'
     | 'delegation' | 'escalation'
     | 'retry_success' | 'retry_failed'
     | 'autoheal_triggered' | 'autoheal_resolved'
     | 'lesson_learned' | 'skill_used'
     | 'approval_requested' | 'approval_granted' | 'approval_denied';

   export interface AgentEvent {
     eventId: string;          // UUID
     type: AgentEventType;
     timestamp: Date;
     agentId: string;          // 'meta-agent' | 'codingAgent' | ...
     taskId?: string;          // powiązanie z code_task_artifacts
     subtaskId?: string;
     model?: string;           // jaki model był użyty
     toolId?: string;          // jaki tool wywołano
     input?: string;           // skrócony input (max 500 chars)
     output?: string;          // skrócony output (max 500 chars)
     status: 'success' | 'error' | 'pending';
     errorMessage?: string;
     durationMs?: number;
     tokenUsage?: { prompt: number; completion: number };
     metadata?: Record<string, unknown>;
     expiresAt: Date;          // TTL — domyślnie 30 dni
   }

   export async function logAgentEvent(event: Omit<AgentEvent, 'eventId' | 'timestamp' | 'expiresAt'>): Promise<void> {
     const db = await getDb();
     await db.collection('agent_events').insertOne({
       ...event,
       eventId: randomUUID(),
       timestamp: new Date(),
       expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), // 30 dni
     });
   }
   ```
2. **[EDYCJA]** `lib/mongo-indexes.ts` — dodać index:
   ```ts
   await db.collection('agent_events').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
   await db.collection('agent_events').createIndex({ type: 1, timestamp: -1 });
   await db.collection('agent_events').createIndex({ agentId: 1, timestamp: -1 });
   await db.collection('agent_events').createIndex({ taskId: 1 });
   ```
3. **[EDYCJA]** `services/subtask-executor.ts` — dodać `logAgentEvent()` po:
   - Każdym `executeSubtask()` (task_started, task_completed/task_failed)
   - Każdym retry/escalation (retry_success, escalation)
4. **[EDYCJA]** `tools/system/delegate-task.ts` — dodać `logAgentEvent({type:'delegation'})` po wywołaniu sub-agenta
5. **[EDYCJA]** `services/error-collector.ts` — dodać `logAgentEvent({type:'autoheal_triggered'})` w `_triggerWorkflow()`
6. **[TEST]** Uruchomić coding task → sprawdzić `db.agent_events.find().sort({timestamp:-1}).limit(10)`

### 1.3 Memory Extractor — kompresja logów do wiedzy (DECYZJA-02, krok 2) — ✅ DONE 2026-05-09

**Zależność:** → 1.2 (Agent Event Log musi zbierać dane)

**Cel:** Background worker który analizuje `agent_events` i wyciąga typowaną wiedzę do `system_knowledge`.

**Kroki:**
1. **[NOWY]** `services/memory-extractor.ts`:
   ```ts
   export interface SystemKnowledge {
     knowledgeId: string;
     type: 'failure_case' | 'coding_pattern' | 'autoheal_recipe'
         | 'tool_contract' | 'prompt_rule' | 'user_preference'
         | 'project_fact' | 'architecture_decision';
     title: string;            // krótki opis (do embeddingu)
     content: string;          // pełna treść
     embedding: number[];      // vektor z embeddera
     sourceEventIds: string[]; // linki do agent_events
     confidence: number;       // 0-1
     usageCount: number;       // ile razy recall
     createdAt: Date;
     updatedAt: Date;
     expiresAt: Date;          // domyślnie 90 dni, odnawialne
   }

   // Patterns do ekstrakcji:
   // 1. retry_success + retry_failed w tym samym taskId → failure_case
   // 2. powtarzający się tool_error z tym samym errorMessage → tool_contract
   // 3. autoheal_resolved → autoheal_recipe
   // 4. delegation z wysokim tokenUsage → prompt_rule (zbyt drogi prompt)

   export async function extractKnowledge(): Promise<number> {
     // Pobierz nowe eventy od ostatniego runu
     // Grupuj po taskId
     // Dla każdej grupy sprawdź patterny
     // Wygeneruj embedding tytułu
     // Zapisz do system_knowledge
   }
   ```
2. **[NOWY]** `lib/mongo-indexes.ts` — dodać indexy dla `system_knowledge`:
   ```ts
   await db.collection('system_knowledge').createIndex({ type: 1, createdAt: -1 });
   await db.collection('system_knowledge').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
   ```
3. **[TEST]** Uruchomić extractKnowledge() ręcznie po kilku taskach → sprawdzić `db.system_knowledge.find()`

### 1.4 Narzędzia memory_recall i memory_write (DECYZJA-02, krok 3) — ✅ DONE 2026-05-09

**Zależność:** → 1.3 (system_knowledge musi istnieć)

**Kroki:**
1. **[NOWY]** `tools/system/memory-recall.ts`:
   ```ts
   // system.memory_recall — semantic search po system_knowledge
   // Input: query (string), type? (filter), topK (default 5)
   // Output: matching knowledge items z score
   // Implementacja: generateEmbedding(query) → cosineSimilarity z embedding w system_knowledge
   // Wzorzec: identyczny jak recallWorkerLessonsTool ale na system_knowledge
   ```
2. **[NOWY]** `tools/system/memory-write.ts`:
   ```ts
   // system.memory_write_observation — ręczne zapisanie wiedzy
   // Input: type, title, content
   // Output: knowledgeId
   // Agent może jawnie zapisać obserwację/decyzję/pattern
   ```
3. **[EDYCJA]** `agents/meta-agent.ts` — dodać oba narzędzia do toolsetu metaAgent
4. **[EDYCJA]** `agents/coding-agent.ts` — dodać **oba** narzędzia (recall + write). codingAgent potrzebuje write żeby logować wzorce orkiestracyjne.
5. **[EDYCJA]** `prompts/meta/system.md` — dodać instrukcję:
   ```
   ## Pamięć systemowa
   Na początku złożonego zadania ZAWSZE wywołaj system.memory_recall aby sprawdzić
   czy system ma wiedzę o podobnych problemach. Po odkryciu ważnego wzorca
   zapisz go przez system.memory_write_observation.
   ```
6. **[EDYCJA]** `prompts/coding/system.md` — dodać sekcję uczenia orkiestracyjnego:
   ```
   ## Pamięć i nauka z orkiestracji
   Masz dostęp do system.memory_recall i system.memory_write_observation.

   ### Przed złożonym zadaniem:
   - Wywołaj memory_recall z opisem zadania — sprawdź czy masz wiedzę o podobnych wzorcach.

   ### Po zakończeniu złożonego zadania (3+ subtasków):
   ZAWSZE zapisz lekcję orkiestracyjną przez memory_write_observation z type='coding_pattern':
   - Jaka strategia dekompozycji zadziałała (np. "frontend-first", "types-first")
   - Które subagenty/skille zadziałały dobrze, a które wymagały retry
   - Czy podział na grupy parallel był efektywny
   - Jakie preferencje użytkownika zaobserwowałeś

   Przykład:
   memory_write_observation({
     type: 'coding_pattern',
     title: 'Refaktoring typów TS: types-first approach',
     content: 'Przy refaktoringu typów w 8+ plikach, najpierw edytuj interfejsy/typy, potem implementacje. SubAgent file-editor z modelem local-heavy radzi sobie z single-file edits. QA SubAgent po każdej grupie parallel wykrywa regresje wcześnie.',
   })
   ```
6. **[TEST]** Zapisać knowledge via memory_write → recall via memory_recall → sprawdzić czy wraca z odpowiednim score

---

## FAZA 2 — Failure Brain + Skill Registry fundament

> Cel: Autoheal uczy się z historii. Skille stają się dynamiczne.
> Szacowany czas: 4–6 sesji roboczych
> Zależność: → Faza 1 (memory_recall, system_knowledge, agent_events)

### 2.1 Failure Brain — recall awarii przed diagnozą (DECYZJA-02, krok 4) — ✅ DONE 2026-05-09

**Zależność:** → 1.4 (memory_recall tool musi działać)

**Cel:** Gdy ErrorCollector triggeriuje repo-maintenance, workflow NAJPIERW sprawdza czy podobna awaria już występowała i jakie było rozwiązanie.

**Kroki:**
1. **[EDYCJA]** `services/error-collector.ts` — w `_triggerWorkflow()`:
   - Przed uruchomieniem workflow, wywołać memory_recall:
   ```ts
   // Sprawdź czy mamy wiedzę o podobnej awarii
   const { memoryRecallTool } = await import('../tools/system/memory-recall.js');
   const recall = await memoryRecallTool.execute({
     query: `${error.name}: ${error.message}`,
     type: 'failure_case',
     topK: 3,
   });
   // Dodaj wyniki recall do promptu workflow
   if (recall.items?.length > 0) {
     prompt += '\n\n### Znane podobne awarie:\n';
     prompt += recall.items.map(i =>
       `- [score: ${i.score}] ${i.title}: ${i.content}`
     ).join('\n');
   }
   ```
2. **[EDYCJA]** `workflows/repo-maintenance.ts` — w kroku diagnose-and-plan:
   - Dodać sekcję promptu: "Sprawdź znane awarie powyżej — jeśli pasują, użyj ich rozwiązania jako bazy"
3. **[EDYCJA]** `services/error-collector.ts` — w `resolveTicket()`:
   - Po rozwiązaniu → zapisać do system_knowledge jako `autoheal_recipe`:
   ```ts
   await memoryWriteTool.execute({
     type: 'autoheal_recipe',
     title: `Fix: ${ticket.errorMessage.slice(0, 100)}`,
     content: `Error: ${ticket.errorMessage}\nSource: ${ticket.context.source}\nResolution: ticket resolved via workflow ${ticket.workflowRunId}`,
   });
   ```
4. **[TEST]** Wywołać ten sam błąd 2x → za drugim razem workflow powinien znaleźć `failure_case` z pierwszego razu

### 2.2 Skill Registry — parser i indeksowanie (DECYZJA-05) — ✅ DONE 2026-05-09

**Zależność:** → 1.4 (embedder musi działać dla semantic search)

**Cel:** Zbudować fundament Skill Registry: parsowanie SKILL.md, indeksowanie embeddingami, narzędzia search/load/report.

**Kroki:**
1. **[NOWY]** `services/skill-registry.ts`:
   ```ts
   export interface SkillMetadata {
     name: string;              // [STANDARD] wymagane
     description: string;       // [STANDARD] wymagane
     compatibility?: string;
     allowedTools?: string[];   // parsed from space-separated string
     // Nasze rozszerzenia (z metadata:)
     domain?: string;
     minComplexity?: TaskComplexity;
     estimatedTokens?: number;
     outputFormat?: string;
     tags?: string[];
     version?: number;
     successRate?: number | null;
     totalUses?: number;
     lastUsed?: string | null;
     author?: string;
   }

   export interface Skill {
     metadata: SkillMetadata;
     procedure: string;         // markdown body (bez frontmatter)
     filePath: string;          // ścieżka do SKILL.md
     embedding?: number[];      // embedding description
   }

   export class SkillRegistry {
     private skills: Map<string, Skill> = new Map();
     private embeddings: Map<string, number[]> = new Map();

     // Skanuje _skills/ directory, parsuje YAML frontmatter, buduje indeks
     async initialize(skillsDir: string): Promise<void> {}

     // Semantic search po description embeddingach
     async search(query: string, domain?: string, topK = 5): Promise<Array<Skill & {score:number}>> {}

     // Ładuje pełny skill (procedura + metadata + listing scripts/)
     async load(skillName: string): Promise<Skill | null> {}

     // Feedback loop — aktualizuje success_rate w YAML frontmatter
     async reportResult(skillName: string, success: boolean, notes?: string): Promise<void> {}
   }
   ```
2. **[NOWY]** `lib/yaml-frontmatter.ts` — parser YAML frontmatter z markdown:
   ```ts
   export function parseFrontmatter(content: string): { metadata: Record<string,any>; body: string } {}
   export function updateFrontmatter(filePath: string, updates: Record<string,any>): Promise<void> {}
   ```
3. **[NOWY]** Stworzenie katalogu `src/mastra/_skills/` z 3 startowymi skillami:
   - `_skills/coding/fix-typescript-error/SKILL.md`
   - `_skills/coding/safe-file-edit/SKILL.md`
   - `_skills/coding/run-verification/SKILL.md`
4. **[EDYCJA]** `index.ts` — zainicjalizować SkillRegistry przy starcie:
   ```ts
   import { SkillRegistry } from './services/skill-registry.js';
   export const skillRegistry = new SkillRegistry();
   await skillRegistry.initialize('./src/mastra/_skills');
   ```

### 2.3 Narzędzia skill.search, skill.load, skill.report_result — ✅ DONE 2026-05-09

**Zależność:** → 2.2

**Kroki:**
1. **[NOWY]** `tools/system/skill-search.ts`:
   ```ts
   // skill.search — semantic search po skill registry
   // Input: query, domain?, topK?
   // Output: Array<{ name, description, domain, minComplexity, score }>
   // Używa SkillRegistry.search() z embeddingami
   ```
2. **[NOWY]** `tools/system/skill-load.ts`:
   ```ts
   // skill.load — ładuje pełną procedurę skilla
   // Input: skillName
   // Output: { procedure, allowedTools, metadata, scripts[] }
   ```
3. **[NOWY]** `tools/system/skill-report.ts`:
   ```ts
   // skill.report_result — feedback loop
   // Input: skillName, success (bool), notes?
   // Output: { updated, newSuccessRate }
   // Aktualizuje YAML frontmatter: success_rate, total_uses, last_used
   ```
4. **[EDYCJA]** `agents/coding-agent.ts` — dodać 3 narzędzia do toolsetu
5. **[EDYCJA]** `agents/meta-agent.ts` — dodać `skillSearchTool` (discovery only)
6. **[TEST]** `skill.search("typescript error fix")` → powinno zwrócić `fix-typescript-error` z wysokim score. `skill.load("fix-typescript-error")` → pełna procedura.

---

## Kryteria przejścia między fazami

| Przejście | Warunek |
|-----------|---------|
| Faza 0 → 1 | Wszystkie 5 bugfixów wdrożone. `expiresAt` ujednolicony. TTL indexy działają. |
| Faza 1 → 2 | `agent_events` zbiera dane. `system_knowledge` ma min. 5 rekordów. `memory_recall` zwraca wyniki. OM działa dla metaAgent. |
| Faza 2 → 3 | Failure Brain recall działa. Skill Registry ma 3+ skille. `skill.search` zwraca wyniki semantyczne. |

---

*Kontynuacja w [plan-rozwoju-v2-part2.md](./plan-rozwoju-v2-part2.md) — Fazy 3–6*
