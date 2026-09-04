# Plan Implementacyjny v2 — Część 2: Fazy 3–6
## Mastra Agentic Environment

Data: 2026-05-09 | Autor: Antigravity + Patryk
Ref: [plan-rozwoju.md](./plan-rozwoju.md) | [Część 1](./plan-rozwoju-v2-part1.md)

---

## FAZA 3 — Coding Hierarchy (Faza A: flat)

> Cel: codingAgent staje się orkiestratorem z wyspecjalizowanymi subagentami.
> Szacowany czas: 5–8 sesji roboczych
> Zależność: → Faza 2 (Skill Registry musi działać)

### 3.1 Definicja specjalizacji subagentów — ✅ DONE 2026-05-09

**Zależność:** → 2.3 (skill tools)

**Cel:** Zdefiniować 3 wyspecjalizowane role subagentów + ad-hoc worker pattern.

**Kroki:**
1. **[NOWY]** `config/subagent-roles.ts`:
   ```ts
   export interface SubAgentRole {
     roleId: string;
     name: string;
     description: string;      // dla orkiestratora — kiedy użyć tego subagenta
     allowedTools: string[];    // whitelist narzędzi
     defaultModelTier: 'local-micro' | 'local-light' | 'local-heavy' | 'cloud-free' | 'cloud-fast';
     promptTemplate: string;   // ścieżka do promptu roli
     skills?: string[];        // pre-loaded skille (opcjonalne)
   }

   export const SUBAGENT_ROLES: Record<string, SubAgentRole> = {
     'file-editor': {
       roleId: 'file-editor',
       name: 'File Editor SubAgent',
       description: 'Edytuje pliki źródłowe. Używaj gdy subtask wymaga modyfikacji kodu.',
       allowedTools: [
         'workspace.read_file', 'workspace.search_content',
         'coding.write_file_tracked', 'coding.apply_patch',
         'coding.get_artifact', 'coding.update_artifact',
       ],
       defaultModelTier: 'local-heavy',
       promptTemplate: 'coding/subagent-file-editor',
     },
     'terminal': {
       roleId: 'terminal',
       name: 'Terminal SubAgent',
       description: 'Uruchamia komendy read-only (build, test, lint). NIE edytuje plików.',
       allowedTools: [
         'coding.run_test', 'workspace.read_file',
         'workspace.list_dir', 'workspace.search_content',
       ],
       defaultModelTier: 'local-micro',
       promptTemplate: 'coding/subagent-terminal',
     },
     'qa': {
       roleId: 'qa',
       name: 'QA SubAgent',
       description: 'Weryfikuje poprawność zmian: tsc, eslint, smoke test. Raportuje sygnały jakości.',
       allowedTools: [
         'coding.run_test', 'workspace.read_file',
         'workspace.search_content',
       ],
       defaultModelTier: 'local-micro',
       promptTemplate: 'coding/subagent-qa',
     },
   };
   ```

2. **[NOWY]** Prompty ról subagentów:
   - `prompts/coding/subagent-file-editor.md`
   - `prompts/coding/subagent-terminal.md`
   - `prompts/coding/subagent-qa.md`
   
   Każdy prompt zawiera:
   - Jasną definicję roli i granic ("TY nie uruchamiasz komend", "TY nie piszesz plików")
   - Format outputu (structured JSON z diff/diagnostics)
   - Instrukcję skill loading ("Twoja procedura jest poniżej, wykonaj ją krok po kroku")

### 3.2 Ewolucja subtask-executor z routing po rolach — ✅ DONE 2026-05-09

**Zależność:** → 3.1

**Cel:** `subtask-executor.ts` automatycznie wybiera subagenta na podstawie typu subtask i ładuje skill.

**Kroki:**
1. **[EDYCJA]** `services/subtask-executor.ts`:
   - Nowa funkcja `resolveSubAgent(subtask)`:
     ```ts
     function resolveSubAgent(subtask: RoutableSubtask): SubAgentRole {
       // type: 'edit' | 'create' → file-editor
       // type: 'test' | 'build' → terminal
       // type: 'verify' | 'lint' → qa
       // default → file-editor
     }
     ```
   - W `executeSubtask()`: zamiast `mastra.getAgent('codingAgent')` → tworzy scoped agent:
     ```ts
     const role = resolveSubAgent(subtask);
     const skillResult = await skillRegistry.search(subtask.description, role.roleId);
     const loadedSkill = skillResult[0] ? await skillRegistry.load(skillResult[0].name) : null;

     const prompt = buildScopedPrompt(subtask, role, loadedSkill, context);
     const modelId = smartRouter.selectModel(role.defaultModelTier, subtask.estimatedComplexity);

     // Temporary agent z ograniczonym toolsetem
     const tools = filterTools(allTools, role.allowedTools);
     const response = await codingAgent.generate(prompt, { model: modelId, tools });
     ```
   - Po wykonaniu: `skillRegistry.reportResult(loadedSkill.name, quality.passed)`

2. **[EDYCJA]** `services/subtask-executor.ts` — nowa funkcja `buildScopedPrompt()`:
   ```ts
   function buildScopedPrompt(
     subtask: RoutableSubtask,
     role: SubAgentRole,
     skill: Skill | null,
     context: SubtaskContext,
   ): string {
     return [
       `## Rola: ${role.name}`,
       `${role.description}`,
       '',
       skill ? `## Procedura (Skill: ${skill.metadata.name})` : '',
       skill ? skill.procedure : '',
       '',
       `## Zadanie`,
       subtask.description,
       `## Pliki docelowe`,
       subtask.targetFiles.map(f => `- ${f}`).join('\n'),
       `## Dozwolone narzędzia`,
       role.allowedTools.map(t => `- ${t}`).join('\n'),
     ].join('\n');
   }
   ```

3. **[TEST]** Uruchomić coding task z 3 subtaskami → sprawdzić logi:
   - file-editor subtask → użyty model local-heavy + skill loaded
   - terminal subtask → użyty model local-micro
   - qa subtask → użyty model local-micro, raport quality signals

### 3.3 Ad-hoc worker creation przez codingAgent — ✅ DONE 2026-05-09

**Zależność:** → 3.2

**Cel:** codingAgent może tworzyć subagentów na zawołanie (bez predefiniowanej roli) via ulepszony `run_worker`.

**Kroki:**
1. **[EDYCJA]** `tools/system/run-worker.ts`:
   - Dodać opcjonalny parametr `skills: string[]` — lista skilli do załadowania:
   ```ts
   skills: z.array(z.string()).optional()
     .describe('Lista nazw skilli do załadowania do promptu workera'),
   ```
   - W execute: jeśli `skills` podane → `skillRegistry.load()` każdy → dołącz procedury do promptu
   - Dodać parametr `allowedTools: string[]` — whitelist narzędzi dla workera

2. **[EDYCJA]** `prompts/coding/system.md` — dodać instrukcję:
   ```
   ## Tworzenie subagentów
   Gdy zadanie wymaga specjalisty którego nie masz jako zarejestrowanego subagenta:
   1. Użyj skill.search() aby znaleźć odpowiedni skill
   2. Użyj system.run_worker z parametrem skills=[nazwa_skilla]
   3. Worker automatycznie otrzyma procedurę skilla i ograniczony toolset
   ```

3. **[TEST]** codingAgent dostaje task bez pasującego subagenta → tworzy ad-hoc workera ze skillem → worker wykonuje zadanie

### 3.4 Integracja Skill Registry z subagentami — feedback loop — ✅ DONE 2026-05-09

**Zależność:** → 3.2, 3.3

**Cel:** Zamknięcie pętli: skill used → quality check → report → success_rate update.

**Kroki:**
1. **[EDYCJA]** `services/subtask-executor.ts` — w `retryFailedSubtasks()`:
   - Po quality validation → `skillRegistry.reportResult(skillName, passed, reason)`
   - Logować do `agent_events` jako `skill_used`

2. **[NOWY]** Cron/startup task w `index.ts`:
   ```ts
   // Co 24h — oblicz success_rate dla każdego skilla
   // na podstawie agent_events {type: 'skill_used'}
   setInterval(async () => {
     await skillRegistry.recalculateRates();
   }, 24 * 3600 * 1000);
   ```

3. **[TEST]** Po 10 użyciach skilla → sprawdzić `success_rate` w YAML frontmatter — powinno być liczbą 0-1

---

## FAZA 4 — Cloud free tier + Budget

> Cel: OpenRouter free models jako dodatkowy tier dla subagentów. Budget tracking.
> Szacowany czas: 2–3 sesje robocze
> Zależność: → Faza 3 (subagenci muszą działać, żeby mieć komu przypisać free modele)

### 4.1 OpenRouter free tier w model registry (DECYZJA-03) — ✅ DONE 2026-05-09

**Kroki:**
1. **[EDYCJA]** `config/model-capabilities.ts`:
   - Dodać nowy tier `'cloud-free'` do `ModelTier`
   - Dodać modele:
   ```ts
   {
     modelId: 'openrouter/poolside/laguna-m.1:free',
     tier: 'cloud-free',
     maxComplexity: 'simple',
     safeContextWindow: 8000,
     vramMb: 0,
     available: true,
     costPer1kTokens: 0,
   },
   {
     modelId: 'openrouter/nvidia/nemotron-3-nano-30b-a3b:free',
     tier: 'cloud-free',
     maxComplexity: 'trivial',
     safeContextWindow: 4000,
     vramMb: 0,
     available: true,
     costPer1kTokens: 0,
   },
   ```
2. **[EDYCJA]** `services/smart-router.ts`:
   - Dodać `'cloud-free'` do ESCALATION_PATH (między `local-micro` a `cloud-fast`)
   - Dodać logic: cloud-free modele NIGDY nie mogą być wybrane dla roli orkiestratora
3. **[EDYCJA]** `.env` — dodać `OPENROUTER_API_KEY`
4. **[TEST]** SmartRouter z subtask o complexity `trivial` → powinien preferować `cloud-free` nad `cloud-fast` (tańszy)

### 4.2 Circuit breaker per model — ✅ DONE 2026-05-09

**Zależność:** → 4.1

**Kroki:**
1. **[NOWY]** `services/circuit-breaker.ts`:
   ```ts
   export class ModelCircuitBreaker {
     private failures: Map<string, { count: number; lastFailure: Date }> = new Map();
     private readonly threshold = 3;       // 3 failures → open circuit
     private readonly resetMs = 300_000;   // 5 min reset

     isOpen(modelId: string): boolean {}
     recordFailure(modelId: string): void {}
     recordSuccess(modelId: string): void {}
   }
   ```
2. **[EDYCJA]** `services/subtask-executor.ts` — sprawdzić circuit breaker przed `executeSubtask()`
3. **[EDYCJA]** `services/smart-router.ts` — `selectModel()` pomija modele z otwartym circuit breakerem
4. **[TEST]** Symulować 3x 429 od OpenRouter → model powinien być pominięty przez 5 min

### 4.3 Request budget tracker — ✅ DONE 2026-05-09

**Zależność:** → 4.1

**Kroki:**
1. **[NOWY]** `services/budget-tracker.ts`:
   ```ts
   export class BudgetTracker {
     // Śledzenie dziennego zużycia per provider
     // OpenRouter free: max 1000 req/day (z credits)
     // Alerty gdy > 80% budżetu
     async recordRequest(provider: string, modelId: string, tokens: number): Promise<void> {}
     async getRemainingBudget(provider: string): Promise<{ remaining: number; limit: number }> {}
     async isOverBudget(provider: string): Promise<boolean> {}
   }
   ```
2. **[EDYCJA]** `services/smart-router.ts` — przed wyborem cloud-free modelu sprawdź `budgetTracker.isOverBudget('openrouter')`
3. **[TEST]** Po 950 requestach → SmartRouter powinien przestać wybierać cloud-free i fallbackować na local

---

## FAZA 5 — Coding Hierarchy (Faza B: domain agents)

> Cel: Pełna 3-warstwowa hierarchia (jeśli Faza A okaże się niewystarczająca).
> Szacowany czas: 8–12 sesji roboczych
> Zależność: → Faza 3 (Faza A musi działać i być przetestowana)
> ⚠️ UWAGA: Ta faza jest OPCJONALNA. Wdrażać TYLKO jeśli flat hierarchy nie wystarczy.

### 5.1 masterCodingAgent

**Kroki:**
1. **[NOWY]** `agents/master-coding-agent.ts`:
   - Model: `google/gemini-2.5-pro` (planuje RAZ na zlecenie)
   - Narzędzia: `planning.create_plan`, `planning.dispatch_to_domain`, `skill.search`, `memory_recall`
   - Prompt: architekt-planer, NIE koduje sam
2. **[NOWY]** `prompts/coding/master.md` — prompt planowania i dekompozycji
3. **[NOWY]** `tools/coding/create-plan.ts` — tworzy ustrukturyzowany plan z podziałem na domeny

### 5.2 Domain coding agents

**Kroki:**
1. **[NOWY]** `agents/frontend-coding-agent.ts` — focus: React, CSS, UI components
2. **[NOWY]** `agents/backend-coding-agent.ts` — focus: API, database, services
3. **[NOWY]** `agents/infra-coding-agent.ts` — focus: CI/CD, config, dependencies
4. **[NOWY]** `agents/testing-coding-agent.ts` — focus: tests, coverage, e2e
5. Każdy agent: własny prompt, własne narzędzia, zarządza swoimi subagentami

### 5.3 Cross-domain koordynacja

**Kroki:**
1. **[EDYCJA]** `tools/system/delegate-task.ts` — dodać domain agents do `AGENTS_MAP`
2. **[NOWY]** `services/cross-domain-coordinator.ts` — rozwiązywanie konfliktów między domenami (np. frontend i backend edytują ten sam typ)

---

## FAZA 6 — Obsidian Mirror + Dashboard

> Cel: Eksport wiedzy i monitoring zdrowia systemu.
> Szacowany czas: 2–3 sesje robocze
> Zależność: → Faza 2 (system_knowledge musi mieć dane)

### 6.1 Eksport do Obsidian

**Kroki:**
1. **[NOWY]** `tools/system/obsidian-export.ts`:
   - Eksportuje `system_knowledge` do plików Markdown w formacie Obsidian
   - Tworzy wiki-links między powiązanymi rekordami
   - Generuje daily note z podsumowaniem aktywności
2. **[NOWY]** Cron: co 24h eksport nowych rekordów do `~/Obsidian/AgentKnowledge/`

### 6.2 Dzienny raport zdrowia

**Kroki:**
1. **[NOWY]** `services/health-report.ts`:
   - Agregacja z `agent_events`: ile tasków, ile retry, ile eskalacji, ile failures
   - Top 5 najczęstszych błędów
   - Skill effectiveness ranking (top/bottom 5 skilli po success_rate)
   - Budget usage per provider
2. **[NOWY]** `tools/system/health-report.ts` — tool dla metaAgent do generowania raportu on-demand

### 6.3 Skill effectiveness dashboard

**Kroki:**
1. **[NOWY]** API endpoint `/api/skills/stats` — zwraca success_rate, total_uses, last_used per skill
2. **[NOWY]** Prosta strona w Mastra Studio lub standalone HTML z wizualizacją

---

## PRZYSZŁOŚĆ — Skill Builder Workflow

> Nie ma przypisanej fazy — do integracji gdy Skill Registry będzie dojrzały.

### Koncept:
1. **Trigger:** codingAgent szuka skilla przez `skill.search()` → brak wyników (score < 0.3)
2. **Workflow:** `skill-builder-workflow` uruchamiany automatycznie:
   - Input: opis zadania + kontekst
   - Krok 1: Szukaj podobnych skilli (template)
   - Krok 2: LLM generuje procedurę SKILL.md z poprawnym frontmatter
   - Krok 3: Walidacja: czy `allowed-tools` istnieją w systemie
   - Krok 4: Zapisz do `_skills/{domain}/{name}/SKILL.md`
   - Krok 5: `skillRegistry.initialize()` (re-index)
3. **Feedback:** Nowy skill ma `success_rate: null`, `total_uses: 0` → system mierzy skuteczność
4. **Integracja:** Patryk ma działające MVP — do adaptacji pod nasz format SKILL.md

---

## Podsumowanie — kolejność wdrożeń

```
FAZA 0 (1-2 sesje)     FAZA 1 (3-5 sesji)      FAZA 2 (4-6 sesji)
├─ 0.1 expiresAt fix    ├─ 1.1 OM metaAgent      ├─ 2.1 Failure Brain
├─ 0.2 TTL indexy       ├─ 1.2 Agent Event Log   ├─ 2.2 Skill Registry
├─ 0.3 token_usage      ├─ 1.3 Memory Extractor  └─ 2.3 Skill tools
├─ 0.4 auto-save lesson └─ 1.4 memory tools
└─ 0.5 run_test guard
         │                       │                       │
         ▼                       ▼                       ▼
FAZA 3 (5-8 sesji)      FAZA 4 (2-3 sesje)      FAZA 5 (OPCJA)
├─ 3.1 SubAgent roles    ├─ 4.1 OpenRouter free   ├─ 5.1 masterCodingAgent
├─ 3.2 Executor upgrade  ├─ 4.2 Circuit breaker   ├─ 5.2 Domain agents
├─ 3.3 Ad-hoc workers   └─ 4.3 Budget tracker    └─ 5.3 Cross-domain
└─ 3.4 Skill feedback
         │                                              │
         ▼                                              ▼
FAZA 6 (2-3 sesje)                              PRZYSZŁOŚĆ
├─ 6.1 Obsidian export                          └─ Skill Builder Workflow
├─ 6.2 Health report
└─ 6.3 Skill dashboard
```

**Łączny szacowany czas: 17–29 sesji roboczych (Fazy 0–4 + 6)**
**Z Fazą 5 (opcjonalna): 25–41 sesji**

---

## Nowe pliki do stworzenia (zestawienie)

| Faza | Plik | Typ |
|------|------|-----|
| 0 | `lib/mongo-indexes.ts` | Nowy |
| 1 | `lib/agent-event-log.ts` | Nowy |
| 1 | `services/memory-extractor.ts` | Nowy |
| 1 | `tools/system/memory-recall.ts` | Nowy |
| 1 | `tools/system/memory-write.ts` | Nowy |
| 2 | `services/skill-registry.ts` | Nowy |
| 2 | `lib/yaml-frontmatter.ts` | Nowy |
| 2 | `tools/system/skill-search.ts` | Nowy |
| 2 | `tools/system/skill-load.ts` | Nowy |
| 2 | `tools/system/skill-report.ts` | Nowy |
| 2 | `_skills/coding/fix-typescript-error/SKILL.md` | Nowy |
| 2 | `_skills/coding/safe-file-edit/SKILL.md` | Nowy |
| 2 | `_skills/coding/run-verification/SKILL.md` | Nowy |
| 3 | `config/subagent-roles.ts` | Nowy |
| 3 | `prompts/coding/subagent-file-editor.md` | Nowy |
| 3 | `prompts/coding/subagent-terminal.md` | Nowy |
| 3 | `prompts/coding/subagent-qa.md` | Nowy |
| 4 | `services/circuit-breaker.ts` | Nowy |
| 4 | `services/budget-tracker.ts` | Nowy |
| 5 | `agents/master-coding-agent.ts` | Nowy |
| 5 | `agents/frontend-coding-agent.ts` | Nowy |
| 5 | `agents/backend-coding-agent.ts` | Nowy |
| 5 | `agents/infra-coding-agent.ts` | Nowy |
| 5 | `agents/testing-coding-agent.ts` | Nowy |
| 6 | `services/health-report.ts` | Nowy |
| 6 | `tools/system/obsidian-export.ts` | Nowy |

## Istniejące pliki do edycji (zestawienie)

| Faza | Plik | Zmiana |
|------|------|--------|
| 0 | `processors/shared-memory-output.ts` | Fix expiresAt Date vs string |
| 0 | `index.ts` | Wywołanie ensureIndexes() |
| 0 | `services/subtask-executor.ts` | Auto-save lesson po retry |
| 0 | `tools/dev/code-task-artifacts.ts` | Whitelist komend run_test |
| 0 | `prompts/meta/system.md` | Instrukcja lesson saving |
| 1 | `agents/meta-agent.ts` | OM config + memory tools |
| 1 | `agents/coding-agent.ts` | memory_recall tool |
| 1 | `services/error-collector.ts` | logAgentEvent + failure brain |
| 1 | `tools/system/delegate-task.ts` | logAgentEvent |
| 2 | `workflows/repo-maintenance.ts` | Failure brain prompt |
| 3 | `services/subtask-executor.ts` | Role routing + skill loading |
| 3 | `tools/system/run-worker.ts` | skills param + allowedTools |
| 3 | `prompts/coding/system.md` | Instrukcja subagent creation |
| 4 | `config/model-capabilities.ts` | cloud-free tier + models |
| 4 | `services/smart-router.ts` | cloud-free routing + budget check |
