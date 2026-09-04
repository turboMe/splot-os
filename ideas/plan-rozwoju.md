# Plan Rozwoju Systemu Agentowego — Mastra Environment

Data rozpoczęcia: 2026-05-09
Autor: Antigravity (Principal Agentic Systems Engineer)
Status: **W TRAKCIE — sesja architektoniczna z Patrykiem**

---

## Spis treści

1. [Stan obecny — audyt systemu](#1-stan-obecny--audyt-systemu)
2. [Wykryte problemy i ryzyka](#2-wykryte-problemy-i-ryzyka)
3. [Decyzje architektoniczne](#3-decyzje-architektoniczne)
4. [Roadmapa rozwoju](#4-roadmapa-rozwoju)

---

## 1. Stan obecny — audyt systemu

### Co już mamy (mocne strony)

| Warstwa | Komponent | Plik | Status |
|---------|-----------|------|--------|
| **Orkiestracja** | metaAgent z ToolSearchProcessor (~50 tools via semantic search) | `agents/meta-agent.ts` | ✅ Działający |
| **Delegacja** | delegate_task → 6 domain agents | `tools/system/delegate-task.ts` | ✅ Działający |
| **Temporary Workers** | run_worker (blank local model executors) | `tools/system/run-worker.ts` | ✅ Działający |
| **Approval Gate** | request_approval | `tools/system/request-approval.ts` | ✅ Działający |
| **Coding Agent** | Workspace tools, tracked writes, worktree, artifacts | `agents/coding-agent.ts` | ✅ Działający |
| **Code Review Agent** | Worktree diff, submit review | `agents/code-review-agent.ts` | ✅ Działający |
| **Smart Router** | Model selection by complexity + VRAM budget + GPU guard | `services/smart-router.ts` | ✅ Działający |
| **Model Registry** | 8 local + 6 cloud models, VRAM tracking | `config/model-capabilities.ts` | ✅ Działający |
| **Parallel Dispatch** | Dependency-aware parallel groups | `services/parallel-dispatch.ts` | ✅ Działający |
| **Subtask Executor** | Retry + escalation (3 attempts) + offline fallback | `services/subtask-executor.ts` | ✅ Działający |
| **GPU Guard** | Live VRAM monitoring, circuit breaker | `services/gpu-guard.ts` | ✅ Działający |
| **Self-Healing** | ErrorCollector → repo-maintenance workflow | `services/error-collector.ts` | ✅ Działający |
| **Shared Memory** | add_context, list_context, push_signal + output processor | `tools/memory/add-context.ts` | ✅ Działający |
| **Worker Lessons** | Semantic recall of past lessons (embeddings) | `tools/system/recall-worker-lessons.ts` | ⚠️ Puste dane |
| **Pattern RAG** | 43 wzorce n8n w Mongo + embedding matching | `tools/architect/pattern-rag.ts` | ✅ Działający |
| **Observability** | DuckDB composite store + CloudExporter | `index.ts` (storage/observability) | ✅ Infrastruktura |
| **Evals / Scorers** | 4 scorery: weather, meta, marketing, architect | `scorers/` | ✅ Bazowe |
| **Blue-Green** | Health endpoint, deploy config, staging worktree | `index.ts` + `.deploy/` | ✅ Bazowe |
| **Prompt Hierarchy** | Modular prompt loader — 7 domen | `prompts/` | ✅ Działający |
| **External Projects** | Tworzenie i praca na projektach poza repo | `tools/dev/external-projects-tools.ts` | ✅ Działający |

### Kluczowe metryki Mongo (z ostatniego audytu)

| Kolekcja | Rekordów | Komentarz |
|----------|----------|-----------|
| `mastra_messages` | ~190 | Aktywnie zapisywane |
| `mastra_threads` | ~21 | Aktywnie zapisywane |
| `automation_patterns` | 43 | Pattern RAG |
| `auto_healing_tickets` | ~9 | Self-healing |
| `code_task_artifacts` | ~16 | Coding pipeline |
| `logs` | ~12920 | Dużo logów |
| `signals` | **0** | ⚠️ Pusta — lessons nie działają |
| `mastra_observational_memory` | **0** | ⚠️ OM nie włączone |
| `token_usage` | **0** | ⚠️ Brak danych kosztowych |
| `workflow_runs` | **0** | ⚠️ Brak telemetrii workflow |

---

## 2. Wykryte problemy i ryzyka

### 🔴 Krytyczne

#### 2.1. Brak pętli uczenia — `signals` = 0 rekordów
**Opis:** `recallWorkerLessonsTool` jest podłączony do metaAgent, ale kolekcja `signals` jest pusta. Meta-agent nigdy nie zapisuje lekcji via `pushSignalTool(type: 'lesson_learned')`. System "odkrywa Amerykę" przy każdym runie.

**Wpływ:** Smart Router i autoheal powtarzają te same błędy. Nie ma feedback loop.

**Fix:** Dodać do promptu metaAgent jawną instrukcję: "po udanym retry lub po wykryciu nietypowego wzorca, ZAWSZE zapisz lekcję". Ewentualnie zrobić to automatycznie w `retryFailedSubtasks()`.

#### 2.2. Brak rejestracji kosztów tokenów — `token_usage` = 0
**Opis:** Pomimo CloudExporter i observability, tabela `token_usage` jest pusta. Nie wiadomo ile kosztują poszczególne agenci, modele, ani workflow.

**Wpływ:** Nie można optymalizować kosztów ani podejmować decyzji o routing na podstawie danych.

**Fix:** Zweryfikować pipeline observability → DuckDB. Prawdopodobnie brakuje konfiguracji eksportera tokenów.

#### 2.3. Brak Observational Memory
**Opis:** `mastra_observational_memory` = 0. OM nie jest włączone dla żadnego agenta. MetaAgent gubi kontekst po ~30 wiadomościach.

**Wpływ:** Przy dłuższych sesjach metaAgent traci kontekst wcześniejszych decyzji.

### 🟡 Ważne

#### 2.4. Shared Memory — niespójne TTL/expiresAt
**Opis:** `addContextTool` zapisuje `expiresAt` jako obiekt `Date`, a `sharedMemoryOutputProcessor` jako ISO string. Filtrowanie `{ $gt: new Date() }` może nie łapać stringów poprawnie.

**Lokalizacja:**
- `tools/memory/add-context.ts:43` → `expiresAt: new Date(...)` (Date)
- `processors/shared-memory-output.ts:90` → `expiresAt: ttl.toISOString()` (string)

**Fix:** Ujednolicić do jednego formatu (rekomendacja: `Date` object, bo Mongo natywnie obsługuje `$gt`).

#### 2.5. `coding.run_test` — przyjmuje dowolną komendę
**Opis:** `runTestCommandTool` w `code-task-artifacts.ts` pozwala agentowi uruchomić dowolną komendę testową. Przy pełniejszej autonomii to ryzyko bezpieczeństwa.

**Fix:** Whitelist dozwolonych komend lub walidacja regex przed exec.

#### 2.6. Subtask executor — jeden agent dla wszystkich ról
**Opis:** `subtask-executor.ts:106` zawsze pobiera `codingAgent` niezależnie od typu subtask. Nie ma wyspecjalizowanych ról (TerminalWorker, FileEditor, QA).

**Wpływ:** Prompty subtaskowe muszą "nadpisywać" ogólny prompt codingAgent. Model dostaje sprzeczne instrukcje.

#### 2.7. Brak Agent Event Log
**Opis:** Nie ma ujednoliconego logu zdarzeń agentowych. Tracing jest w DuckDB, ale nie ma narzędzia do odpytywania go. Agenty nie mogą pytać "co robiłem wczoraj?".

### 🟢 Do rozważenia

#### 2.8. `delegate_task` nie zwraca toolCalls
**Opis:** Tool zwraca tylko `response.text`. Utracone są informacje o toolCalls, tokenUsage, i model routing sub-agenta.

#### 2.9. Brak TTL index w Mongo na `signals` i `shared_memory`
**Opis:** Kolekcje mają `expiresAt` ale prawdopodobnie brakuje TTL index `createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })`.

#### 2.10. `codeReviewAgent` — brak memory
**Opis:** Review agent nie ma Memory. Każdy review jest bezstanowy — agent nie pamięta poprzednich review.

---

## 3. Decyzje architektoniczne

> Poniższe decyzje zostaną podjęte w trakcie rozmowy z Patrykiem.
> Format: **[DECYZJA-XX]** Tytuł — Status: ⏳ Do dyskusji | ✅ Podjęta | ❌ Odrzucona

### [DECYZJA-01] Observational Memory — pilot dla metaAgent

**Status:** ✅ Podjęta (2026-05-09)

**Decyzja:** Włączamy OM dla metaAgent z `scope: 'thread'` i `google/gemini-2.5-flash` jako model Observer/Reflector.

**Konfiguracja startowa:**
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
})
```

**Ryzyka do monitorowania:**
- Dodatkowe koszty LLM (Observer/Reflector calls)
- Ryzyko błędnych obserwacji — weryfikować w Studio Memory tab
- Wymaga poprawnego threadId

**Po pilocie:** Jeśli działa dobrze, włączyć OM również dla **codingAgent** (krok 1.1b). codingAgent potrzebuje OM jeszcze bardziej niż metaAgent — jako orkiestrator subtasków (5-20 per task) szybko przekracza `lastMessages=30` i traci kontekst wcześniejszych wyników, decyzji planistycznych i statusów subagentów.

---

### [DECYZJA-02] Agentic Memory Spine — architektura pamięci systemowej

**Status:** ✅ Podjęta (2026-05-09)

**Propozycja:** Zbudować ujednoliconą warstwę pamięci systemowej:

```
Agent Event Log (Mongo: agent_events)
  → Memory Extractor (background worker)
    → System Knowledge (Mongo: system_knowledge, embeddings)
      → system.memory_recall (tool)
      → system.memory_write_observation (tool)
```

**Typy wiedzy:** `architecture_decision`, `coding_pattern`, `orchestration_pattern`, `n8n_pattern`, `prompt_rule`, `tool_contract`, `failure_case`, `autoheal_recipe`, `user_preference`, `project_fact`

**Priorytety implementacji:**
1. Event log (ustrukturyzowany zapis zdarzeń)
2. Typowane rekordy wiedzy z embeddingami
3. Dwa narzędzia: recall + write
4. Integracja z autoheal (Failure Brain)
5. Obsidian mirror (export, nie core)

**Co mamy na start:**
- Mongo ✅
- Embedder (bge-m3 / Google text-embedding-004) ✅
- Pattern RAG jako wzorzec ✅
- `signals` jako proto-pamięć ✅

**Decyzja:** ⏳

---

### [DECYZJA-03] Darmowe modele cloud — OpenRouter free tier

**Status:** ✅ Podjęta (2026-05-09)

**Decyzja:** Integrujemy OpenRouter free models jako tier `cloud-free` w SmartRouter. **WYŁĄCZNIE dla subagentów** — żaden free model nie może orkiestrować ani planować.

**Zasady:**
- Free modele TYLKO dla subagentów z małymi, wyspecjalizowanymi taskami
- Nie wysyłać: kodu produkcyjnego, sekretów, danych klientów, pełnego kontekstu repo
- Nowy tier w `model-capabilities.ts`: `cloud-free` (między `local-micro` a `cloud-fast`)
- Circuit breaker per model na 429/timeout
- Kupić min. $10 credits → 1000 req/dzień (vs 50 bez credits)

**Kandydaci subagentowi:**
| Rola subagenta | Model | Sens |
|----------------|-------|------|
| Coder worker | `poolside/laguna-m.1:free` | Optymalizowany pod coding |
| Classifier/router | `nvidia/nemotron-3-nano-30b-a3b:free` | Mały, szybki |
| Reasoning fallback | `nvidia/nemotron-3-super-120b-a12b:free` | Duży kontekst |
| Emergency | `openrouter/free` | Niedeterministyczny, ostatnia deska |

---

### [DECYZJA-04] Hierarchia Coding System — fazowane podejście

**Status:** ✅ Podjęta (2026-05-09)

**Decyzja:** Budujemy hierarchię programistyczną inkrementalnie. Zaczynamy od flat hierarchy (Faza A). Master coding agent i domain agents to wizja przyszłościowa (Faza B), wdrażana tylko jeśli flat okaże się niewystarczający.

**Faza A (TERAZ) — codingAgent + wyspecjalizowani subAgenci:**
```
metaAgent (Gemini 2.5 Flash — intent + routing, NIE koduje)
  ↓ delegate_task
codingAgent (Gemini 2.5 Pro — obecny agent, staje się orkiestratorem)
  ↓ dispatch_subtask / run_worker
  ├── FileEditorSubAgent (local/free — tracked writes, patches)
  ├── TerminalSubAgent (local micro — read-only cmds, build)
  ├── QA_SubAgent (local/free — tsc, lint, smoke tests)
  ├── codeReviewAgent (Gemini Flash — już istnieje)
  └── ad-hoc worker (dynamicznie tworzony wg potrzeby via run_worker)
```

**Faza B (PRZYSZŁOŚĆ, jeśli potrzebna) — masterCodingAgent + domain agents:**
```
metaAgent
  ↓ delegate_task
masterCodingAgent (cloud-pro — planuje RAZ, koordynuje)
  ↓ plan → decompose → assign
  ├── frontendCodingAgent (cloud-fast) → subAgenci
  ├── backendCodingAgent (cloud-fast) → subAgenci
  ├── infraCodingAgent (cloud-fast) → subAgenci
  ├── testingCodingAgent (local/free) → subAgenci
  └── codeReviewAgent (cloud-fast)
```

**Dlaczego fazowanie:**
- Faza A pokrywa 90% use cases
- Faza B ma sens dopiero przy projektach 20+ plików w wielu domenach
- Nie budujemy 3 warstw koordynacji zanim 2 warstwy nie udowodnią wartości

**Ekonomika tokenów (Faza A):**
| Warstwa | Model tier | Koszt | Uruchomień na task |
|---------|-----------|-------|--------------------|
| codingAgent (orkiestrator) | cloud-pro | $$$ | 1 (planuje + koordynuje) |
| subAgents (workers) | local/free/cloud-free | $ / $0 | 5-20 (micro-taski) |

**Co trzeba zaprojektować dla Fazy A:**
1. **Specjalizacje subagentów** — jakie role, jakie narzędzia, jakie skille
2. **dispatch_subtask** — ewolucja `subtask-executor.ts` z podbieraniem skilli
3. **Ad-hoc worker creation** — codingAgent tworzy subagenta na zawołanie
4. **Skill loading** — codingAgent ładuje skille do promptu subagenta
5. **Komunikacja w górę** — jak subagent raportuje wyniki do codingAgent

---

### [DECYZJA-05] Skill Registry — dynamiczne skille z semantic search

**Status:** ✅ Podjęta (2026-05-09)

**Decyzja:** Budujemy Skill Registry z embeddingowym wyszukiwaniem, wersjonowaniem i feedbackiem.

**Standard bazowy:** [Agent Skills (agentskills.io)](https://agentskills.io) — branżowy standard (Anthropic/AAIF, Linux Foundation). Adoptowany przez 25+ platform (Claude Code, Cursor, Gemini CLI). Zapewnia interoperacyjność i możliwość importu opensource skilli.

**Nasza strategia:** Bazujemy na standardzie `SKILL.md` + YAML frontmatter. Rozszerzamy go o pola routingowe w sekcji `metadata:`. Dzięki temu:
- Importujemy opensource skille z minimalną adaptacją
- Nasze skille są kompatybilne z ekosystemem
- SmartRouter korzysta z rozszerzonych metadanych do routingu modeli

**Anatomia skilla (standard + nasze rozszerzenia):**
```yaml
# _skills/coding/fix-typescript-error/SKILL.md
---
name: fix-typescript-error                    # [STANDARD] wymagane
description: >                                # [STANDARD] wymagane — trigger dla discovery
  Fix TypeScript compilation errors. Use when tsc reports type errors,
  missing imports, or interface mismatches in .ts/.tsx files.
compatibility: Requires workspace with TypeScript project  # [STANDARD] opcjonalne
allowed-tools: workspace.read_file workspace.search_content coding.write_file_tracked coding.run_test
metadata:                                     # [STANDARD] opcjonalne — tu nasze rozszerzenia
  domain: coding
  min_complexity: simple                      # SmartRouter dobierze model
  estimated_tokens: 3000                      # Budget hint dla routera
  output_format: structured                   # JSON z diff, nie wolny tekst
  tags: [typescript, error-fix, single-file]
  version: 1
  success_rate: null                          # Uzupełniane przez feedback loop
  total_uses: 0
  last_used: null
  author: system
---

## Procedura
1. Przeczytaj plik wskazany w błędzie TypeScript
2. Zidentyfikuj root cause z komunikatu tsc
3. Sprawdź kontekst importów i typów
4. Zastosuj minimalną poprawkę
5. Uruchom `npx tsc --noEmit` na pliku
6. Zwróć diff i diagnostykę
```

**Struktura katalogu skilla (zgodna ze standardem):**
```
_skills/coding/fix-typescript-error/
  SKILL.md                    # Wymagany — frontmatter + procedura
  scripts/                    # Opcjonalny — skrypty pomocnicze
  references/                 # Opcjonalny — dodatkowa dokumentacja
  assets/                     # Opcjonalny — szablony, konfiguracje
```

**Progressive Disclosure (3 etapy):**
1. **Discovery:** Agent ładuje TYLKO `name` + `description` z frontmatter → buduje indeks
2. **Activation:** Gdy task pasuje → agent ładuje pełny `SKILL.md` do kontekstu
3. **Execution:** Agent wykonuje procedurę, korzysta z `scripts/` i `references/`

**Narzędzia Skill Registry:**
```
skill.search(query, domain?, topK?) → top-K matching skills (semantic embedding)
skill.load(skillId) → pełna procedura + metadata + scripts listing
skill.report_result(skillId, success, notes?) → feedback loop (success_rate update)
```

**Flow użycia przez orkiestratora:**
1. codingAgent dostaje subtask: "Fix TS2345 in delegate-task.ts"
2. `skill.search("fix typescript error")` → top match
3. `skill.load("fix-typescript-error")` → procedura + allowed-tools + metadata
4. Tworzy subagenta z: prompt = procedura + kontekst, tools = allowed-tools, model = SmartRouter(min_complexity)
5. Subagent wykonuje procedurę
6. Wynik → quality validation → `skill.report_result()` → success_rate update

**Composability:** Orkiestrator może załadować **kilka skilli** do jednego prompta subagenta.

**Import opensource skilli:** Skille z zewnątrz mają `name` + `description` → nasz system parsuje je poprawnie. Brakujące `metadata.min_complexity` → fallback na `simple`. Brakujące `allowed-tools` → subagent dostaje pełny toolset.

**🔮 PRZYSZŁOŚĆ: Skill Builder Workflow**
Workflow agentowy do automatycznego budowania skilli:
1. Agent napotyka nowy wzorzec zadania bez dopasowanego skilla
2. Uruchamia `skill-builder-workflow` z krótkim opisem
3. Workflow szuka podobnych skilli (bazowy template), generuje procedurę, waliduje `allowed-tools`
4. Zapisuje nowy skill do `_skills/` z `version: 1`, `success_rate: null`
5. Następnym razem agent automatycznie go znajduje → feedback loop mierzy sukces
*Patryk ma działające MVP tego podejścia — do integracji w późniejszej fazie.*

**Integracja z Memory Spine:** Feedback z `report_result` + `user_preference` z pamięci = system uczy się które skille działają dla jakich wzorców tasków.

---

### [DECYZJA-06] Groq jako szybki free tier dla klasyfikacji

**Status:** ❌ Odłożona (2026-05-09)

**Powód:** Brak doświadczenia z providerem. Nie wprowadzamy nowego providera bez przetestowania. Można wrócić do tematu po walidacji OpenRouter free tier.

**Oryginalny pomysł (do rozważenia w przyszłości):**
- Groq jako dedykowany "fast path" dla klasyfikacji, routing, JSON extraction
- Najniższe latency ze wszystkich API, free tier bez karty
- Limity RPM/TPM mogą być wąskie

---

## 4. Roadmapa rozwoju

### Faza 0 — Bugfix & Hardening (PILNE)
- [ ] Fix #2.4: Ujednolicić expiresAt w shared_memory (Date vs string)
- [ ] Fix #2.9: Dodać TTL index na `signals` i `shared_memory`
- [ ] Fix #2.2: Zdiagnozować dlaczego `token_usage` = 0
- [ ] Fix #2.1: Dodać auto-save lesson po retryFailedSubtasks
- [ ] Fix #2.5: Walidacja komend w `runTestCommandTool`

### Faza 1 — Pamięć operacyjna
- [ ] Observational Memory dla metaAgent (DECYZJA-01, krok 1.1)
- [ ] Observational Memory dla codingAgent (DECYZJA-01, krok 1.1b — po walidacji metaAgent)
- [ ] Agent Event Log (DECYZJA-02, krok 1-2)
- [ ] system.memory_recall + system.memory_write dla metaAgent I codingAgent (DECYZJA-02, krok 3)
- [ ] Prompt codingAgent: nauka z orkiestracji (wzorce delegacji, strategii, preferencji)

### Faza 2 — Failure Brain + Skill Registry fundament
- [ ] Integracja z autoheal (DECYZJA-02, krok 4)
- [ ] Failure Brain: recall podobnych awarii przed diagnozą
- [ ] Skill Registry: anatomia skilla (YAML frontmatter), semantic search, `skill.load`
- [ ] Upgrade `skills-search.ts` z keyword → embedding

### Faza 3 — Coding Hierarchy (Faza A: flat)
- [ ] Zdefiniować specjalizacje subagentów (FileEditor, Terminal, QA) w `config/subagent-roles.ts`
- [ ] Ewolucja `subtask-executor.ts` — routing po rolach + skill loading
- [ ] codingAgent → subAgenci (flat dispatch)
- [ ] Ad-hoc worker creation ze skillem via `run_worker`
- [ ] Integracja Skill Registry z subagentami (skill.search → prompt injection)
- [ ] `skill.report_result` feedback loop

### Faza 4 — Cloud free tier + Budget
- [ ] OpenRouter free models jako `cloud-free` tier (DECYZJA-03)
- [ ] Circuit breaker per model
- [ ] Request budget tracker w SmartRouter

### Faza 5 — Coding Hierarchy (Faza B: domain agents)
- [ ] frontendCodingAgent, backendCodingAgent, infraCodingAgent, testingCodingAgent
- [ ] Każdy domain agent zarządza swoimi subagentami
- [ ] Cross-domain koordynacja przez masterCodingAgent

### Faza 6 — Obsidian Mirror + Dashboard
- [ ] Eksport wiedzy systemowej do Obsidian
- [ ] Dzienny raport zdrowia agentów
- [ ] Skill effectiveness dashboard

---

## Changelog decyzji

| Data | Decyzja | Status | Komentarz |
|------|---------|--------|-----------|
| 2026-05-09 | DECYZJA-01 | ✅ | OM pilot metaAgent → po walidacji: OM codingAgent. Obaj orkiestrują i potrzebują kontekstu. |
| 2026-05-09 | DECYZJA-02 | ✅ | Memory Spine + orchestration_pattern. codingAgent zapisuje lekcje orkiestracyjne (read+write). |
| 2026-05-09 | DECYZJA-03 | ✅ | Free modele TYLKO dla subagentów, kupić $10 credits |
| 2026-05-09 | DECYZJA-04 | ✅ | Faza A: codingAgent + subagenci (flat). Faza B: master + domain agents (przyszłość) |
| 2026-05-09 | DECYZJA-05 | ✅ | Skill Registry z minComplexity, semantic search, feedback loop |
| 2026-05-09 | DECYZJA-06 | ❌ | Groq odłożony — brak doświadczenia z providerem |
