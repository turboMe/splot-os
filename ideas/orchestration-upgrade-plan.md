# 🎯 Orchestration Upgrade — Plan dla deva (harness-grade routing, planowanie, delegacja, narzędzia)

> **Cel:** Podnieść meta-agenta i agentów domenowych do poziomu, w którym **idealnie dobierają narzędzia/skille, piszą realne plany z pętlą replanowania i zrzucają na workerów zadania opisane strukturalnym kontraktem** — zamiast luźnym prozą. Po domknięciu infrastruktury user przechodzi do budowy wyspecjalizowanych agentów gastronomicznych.
>
> **Data startu:** 2026-06-18
> **Status:** **WS1 + WS2 + WS4 ZAIMPLEMENTOWANE (2026-06-18)**.
> - **WS1** — `worker-task-spec.ts` (schema + renderer), wpięty do `run_worker` i `delegate_task` (kompatybilność wsteczna), guidance w `meta/base.md`.
> - **WS2** — `tools/system/plan-task.ts` (`planSchema` z jawnymi `assumptions` + `generatePlan` + `planTaskTool`), wpięty do delegacji za flagą `FEATURE_DELEGATION_LLM_PLAN` (plan LLM → `GoalContract.plannedSteps` + `assumptions`, fallback do statycznego planu), replan-on-failure przez `recordPlanRevision`+evidence(against), heurystyka „kiedy planować" w `meta/base.md`. Dok: `docs/PLAN-AND-REPLAN.md`.
> - **WS4** — spójność promptów: inline `📋 Plan` w `meta/base.md` dzieli słownik z `system_plan_task` (goal · assumptions · steps[intent→agent, success] · checkpoints · done), jednoliniowy *Routing rule* (ekspert=tool stack vs worker=tekst), reguła „rozpoznanie przed akcją" (`search_tools`+`recall_worker_lessons`+`system_memory_recall` PRZED planem).
> - `tsc --noEmit` zielony; `planSchema` smoke-tested (valid/empty-assumptions/empty-steps/defaults). Pozostaje live E2E (1 realny przepływ na każdą zmianę). WS3 — user, równolegle.
> **Filozofia:** To NIE jest budowa od zera. Najlepsze wzorce już istnieją w repo (`AutomationSpec`, `GoalContract`, Reflektor/`prepareStep`, `ToolSearchProcessor`) — robota polega na **uogólnieniu i podłączeniu** ich, nie na pisaniu nowych silników.

---

## 0. Werdykt diagnostyczny — gdzie jesteśmy (zweryfikowane w kodzie)

System trafił w te same wzorce, które Anthropic/OpenAI/LangGraph opisali jako best practice 2024–2025. Dowody:

| Wzorzec (nazwa „oficjalna") | Co masz dziś | Plik |
|---|---|---|
| **Deferred / searchable tools** (tool RAG) | `ToolSearchProcessor`: ~11 always-on, ~55 przez `search_tools` (topK=12) | `agents/meta-agent.ts:116-179` |
| **Orchestrator-worker** | `delegate_task` (eksperci) + `run_worker` (blank LLM) | `tools/system/delegate-task.ts`, `run-worker.ts` |
| **Reflexion** (self-reflection retry) | `previousAttempt {output, criticism}` + max 3 | `run-worker.ts:83-91, 160-170` |
| **Structured task spec + capability gating** | `AutomationSpec.dataPolicy` + `successCriteria` + `riskLevel` + `requiresApproval` | `tools/architect/types.ts:11-74` |
| **Tool/pattern descriptions for routing** | `PatternKnowledgeCard.useWhen/avoidWhen/intentExamples/commonFailures` | `tools/architect/types.ts:112-126` |
| **Plan + evidence skeleton** | `GoalContract`: `plannedSteps`, `successCriteria`, `recordEvidence(for/against)`, `evaluateCompletion` | `tools/system/delegate-task.ts:660-805` |
| **In-flight replanning primitive** | `generatePipelineWithReflection` (Reflektor) + Mastra 1.31 `prepareStep` | `services/generate-pipeline-with-reflection.ts`, `ideas/reflektor_update.md` |

**Trzy dziury (wszystkie to „uogólnij/podłącz", nie „zbuduj"):**

1. **Asymetria kontraktu zadania.** `AutomationSpec` jest świetny, ale istnieje TYLKO dla n8n. Generyczna delegacja używa luźnego prozą stringa: `taskDescription: z.string().min(20)` (`delegate-task.ts:105`), `taskBrief: z.string().min(50)` (`run-worker.ts:65`). Wzorzec wymyślony dla jednej domeny nie został uogólniony.
2. **Plan jest atrapą.** `buildDelegationPlan(targetAgent)` zwraca **te same 3 generyczne kroki dla każdego agenta** (`delegate-task.ts:749-764`) — plan nie jest generowany przez LLM ani nie steruje wykonaniem. Silnik (`GoalContract`) jest, tor jest sztywny.
3. **Replanowanie tylko dla pipeline agentów.** Reflektor/`prepareStep` obejmuje chef/content/hunt; meta-agent i pozostali eksperci nie mają pętli „założenie pękło → przeplanuj".

---

## 1. WS1 — `WorkerTaskSpec`: uogólnić `AutomationSpec` na całą delegację

> **Dlaczego najpierw:** Anthropic („Multi-agent research system") — wąskim gardłem jakości jest **opis zadania, nie model workera**. Mgliste briefy → workerzy dublują pracę lub zostawiają dziury. To największy zysk za najmniej kodu, a wzór (`AutomationSpec`) już masz.

### 1.1 Nowy plik: `tools/system/worker-task-spec.ts`

Zod schema (zbuduj z `AutomationSpec` jako szablonu myślowego — przenieś `dataPolicy`, `successCriteria`, `riskLevel`):

```ts
export const workerTaskSpecSchema = z.object({
  goal: z.string().min(10),               // jedno zdanie, mierzalne
  context: z.string(),                     // tło: nazwy, historia, ograniczenia
  inputs: z.array(z.object({               // jak AutomationSpec.inputs
    name: z.string(), value: z.unknown(), source: z.enum(['user','derived','memory','runtime']),
  })).default([]),
  outputContract: z.object({               // ZAMIAST "OUTPUT FORMAT" prozą
    format: z.enum(['prose','json','markdown_table','code','list']),
    schema: z.string().optional(),         // opis/JSON-schema oczekiwanego kształtu
    example: z.string().optional(),
  }),
  scope: z.object({                        // granice — to eliminuje dublowanie pracy
    inScope: z.array(z.string()),
    outOfScope: z.array(z.string()).default([]),
  }),
  successCriteria: z.array(z.string()).min(1),  // sprawdzalne, jak AutomationSpec
  constraints: z.object({
    language: z.string().default('pl'),
    tone: z.string().optional(),
    maxLength: z.string().optional(),
    avoid: z.array(z.string()).default([]),
  }).default({}),
  tools: z.array(z.string()).default([]),  // które narzędzia/źródła użyć
  effort: z.enum(['quick','medium','thorough']).default('medium'), // skaluj wysiłek do złożoności
});
```

### 1.2 Renderer: `renderWorkerBrief(spec): string`
Czysta funkcja spec → deterministyczny prompt (sekcje: GOAL / CONTEXT / INPUTS / SCOPE (in/out) / OUTPUT CONTRACT / SUCCESS CRITERIA / CONSTRAINTS / TOOLS). To zastępuje ręcznie pisaną prozę w `run-worker.ts:121` i `delegate-task.ts:105`.

### 1.3 Podłączenie (kompatybilność wsteczna)
- `run_worker`: dodaj `taskSpec?: workerTaskSpecSchema` obok istniejącego `taskBrief`. Jeśli `taskSpec` podany → `systemPrompt = renderWorkerBrief(taskSpec)`. `taskBrief` zostaje jako fallback (nie psuj istniejących wywołań).
- `delegate_task`: analogicznie `taskSpec?` obok `taskDescription`.
- **Walidacja jako bramka jakości:** jeśli `outOfScope` puste i `successCriteria.length < 1` → zwróć błąd „task underspecified" zanim odpalisz workera (tani guard przeciw mglistym briefom).

### 1.4 Prompt guidance
W `prompts/meta/base.md` (sekcja delegacji) zamień prozą-szablon „GOAL/CONTEXT/OUTPUT/CONSTRAINTS" na: „Buduj `taskSpec` (structured). Zawsze wypełnij `scope.outOfScope` i `successCriteria` — to one decydują o jakości."

### 1.5 Acceptance
- [x] `run_worker` i `delegate_task` przyjmują `taskSpec`, renderują deterministyczny brief. *(worker-task-spec.ts + wpięcie; smoke-test OK)*
- [x] Underspecified spec (brak success criteria) odrzucony przez schemat; brak `taskSpec`/`taskBrief` → czytelny błąd `underspecified_task` w execute.
- [x] Stare wywołania (`taskBrief`/`taskDescription`) dalej działają (oba pola opcjonalne, fallback zachowany; `tsc` zielony).
- [ ] 1 realny przepływ (np. hunt cold-email) przepięty na `taskSpec` i porównany jakościowo. *(live E2E — wymaga uruchomionego systemu)*

---

## 2. WS2 — Planowanie: ożywić `GoalContract` (Plan-and-Execute + replanowanie)

> **Wzorzec:** Plan-and-Execute z pętlą replanowania (LangGraph: planner → executor → replan). Mechanizm rewizji: po każdym etapie odtwórz pozostałe kroki z `past_steps`, gdy obserwacja przeczy **założeniu**. Silnik (`GoalContract`) już jest — trzeba go ożywić.

### 2.1 Plan generowany przez LLM (nie sztywny)
`buildDelegationPlan` (`delegate-task.ts:749`) zwraca dziś 3 stałe kroki. Zamień na realny krok planowania:
- Nowy `tools/system/plan-task.ts` → `planTaskTool`: wejście = cel + kontekst, wyjście = `Plan` (Zod).
- **`Plan` MUSI mieć jawne `assumptions`** — bo replanowanie wyzwala się, gdy obserwacja przeczy założeniu. Bez nich agent nie wie *kiedy* przeplanować.

```ts
export const planSchema = z.object({
  goal: z.string(),
  assumptions: z.array(z.string()),        // ← klucz do replanowania
  steps: z.array(z.object({
    id: z.string(),
    intent: z.string(),
    toolOrAgent: z.string().optional(),
    expectedOutput: z.string(),
    successCheck: z.string(),               // jak poznam, że krok się udał
  })),
  checkpoints: z.array(z.string()),         // po którym kroku zweryfikować assumptions
});
```

### 2.2 Replanowanie przez istniejący `prepareStep`/Reflektor
- Reflektor (`ideas/reflektor_update.md`) ma już `prepareStep` (Mastra 1.31) dla chef/content/hunt. **Rozszerz wyzwalacz**: gdy wynik kroku przeczy któremuś `assumptions` → wstrzyknij refleksję + wywołaj re-plan pozostałych kroków (`toolChoice: 'none'` = re-plan w tekście, bez akcji — dokładnie ten mechanizm opisany w reflektor_update.md §0).
- Zapisuj rewizje jako `recordEvidence(type:'against', ...)` w `GoalContract` — masz to API gotowe (`delegate-task.ts:679`).

### 2.3 Plan jako artefakt-kontrakt (jak TodoWrite u Claude Code)
- Plan trzymaj w `GoalContract.plannedSteps`, aktualizuj przy replanowaniu (kontrakt żyje, nie jest one-shot). To daje obserwowalność: dashboard już czyta `agent_events` → pokaż plan + rewizje jako żywy stan.

### 2.4 Kiedy planować (nie zawsze — to koszt)
- Heurystyka w `prompts/meta/base.md`: planuj jawnie gdy zadanie ma ≥3 kroki LUB efekty uboczne (deploy/send/write) LUB delegację do >1 agenta. Proste zapytania → bez planu (jak Claude Code: plan mode tylko dla złożonych zmian).

### 2.5 Acceptance
- [x] `planTaskTool` generuje `Plan` z niepustymi `assumptions` i `successCheck` per krok. *(schema wymusza `assumptions.min(1)` + `successCheck` per krok; smoke-test zielony)*
- [x] Złamane założenie w trakcie → mierzalna rewizja planu (widoczna w `GoalContract` evidence). *(`replanDelegationContract` na porażce delegacji → `recordPlanRevision` (planRevisions++) + evidence(against) + zaktualizowane `assumptions`; za flagą `FEATURE_DELEGATION_LLM_PLAN`)*
- [x] Proste zadanie NIE odpala planowania (brak regresji latencji). *(brak auto-wywołania `plan_task`; heurystyka „≥3 kroki / efekty uboczne / >1 agent" w `meta/base.md`; flaga domyślnie OFF → zero regresji)*
- [ ] Dashboard pokazuje plan + rewizje. *(`plannedSteps`/`planRevisions` już w `GoalContract`; event `goal_plan_revised` loguje rewizje. Wizualizacja rewizji na dashboardzie do potwierdzenia w live E2E)*

> **Uwaga o zakresie WS2.2:** in-flight re-plan *wewnątrz* runu sub-agenta jest już realizowany przez istniejący Reflektor (`forceNoTool` na `high_error_rate`/`progress_stall`/`wrong_tool` = re-plan w tekście). WS2 dokłada **kontraktową** rewizję planu na poziomie delegacji (obserwowalna w `GoalContract`), bez przepisywania wysokoryzykowej pętli harnessu. Flaga `FEATURE_DELEGATION_LLM_PLAN` domyślnie OFF — włączyć na czas E2E.

---

## 3. WS3 — Dobór narzędzi: metadane, konsolidacja, MCP

> **Mechanizm masz** (`ToolSearchProcessor` = tool RAG). To, co Claude robi lepiej, to **jakość metadanych** — model wybiera narzędzie po opisie. Anthropic („Writing tools for agents"): dopracowanie opisów dało skok na SWE-bench.

### 3.1 Audyt opisów 66 narzędzi „jak dla nowego pracownika"
Dla każdego toola w `tools/`:
- Opis mówi **kiedy** użyć (nie tylko co robi) + **kiedy NIE** (jak `PatternKnowledgeCard.avoidWhen` — masz wzór).
- Parametry jednoznaczne: `user_id` nie `user`; każdy `.describe()` wypełniony.
- Returns: nazwy semantyczne, nie UUID; błędy „actionable" (co zrobić dalej).
- **Deliverable:** checklista przejścia + diff opisów. Najtańszy duży zysk.

### 3.2 Konsolidacja (mniej, „grubszych" narzędzi)
- Kandydat #1: **8 narzędzi gmail-draft** (`gmail_create_draft/list/get/send/delete/update`) → rozważ `manage_draft(action, ...)` LUB zostaw, ale dodaj `useWhen` do każdego.
- Zasada Anthropic: `schedule_event` (find availability + book) > `list_users`+`list_events`+`create_event`. Mniej okazji do złego wyboru.

### 3.3 Namespacing (już masz — dokończ)
- `chef_`, `n8n_`, `architect_` są OK. Wyrównaj resztę: każdy tool ma prefiks domeny. Mierzalny wpływ na trafność wg Anthropic.

### 3.4 MCP jako warstwa „nie buduj sam"
- **Serwer MCP = darmowy (open-source).** Płatne bywa tylko API pod spodem (Tavily/Firecrawl już znasz z `*_DAILY_LIMIT`).
- Kandydaci do podpięcia zamiast utrzymywania własnego kodu:
  - **Google Workspace MCP** → zastępuje ręczne `tools/google/*` (gmail/calendar). Masz już `ideas/google-workspace-mcp-integration.md` — dopnij.
  - **GitHub MCP** (oficjalny, free) → zamiast custom github tooling.
  - **Filesystem / Git / Postgres / Playwright MCP** (wszystkie free, lokalne).
- Źródła: `registry.modelcontextprotocol.io` (oficjalny rejestr), `github.com/modelcontextprotocol/servers` (referencyjne), `github.com/appcypher/awesome-mcp-servers` (lista). Bierz **first-party** (GitHub/Slack/Notion/Cloudflare/Stripe) — mają gotowy auth.
- Mastra ma natywnego klienta MCP → podpięcie to konfiguracja, nie rewrite.

### 3.5 Acceptance
- [ ] 100% narzędzi ma `useWhen` + (gdzie sensowne) `avoidWhen` w opisie.
- [ ] Gmail skonsolidowany lub udokumentowany.
- [ ] ≥1 własny tool-stack (np. Google) zastąpiony serwerem MCP, stare narzędzia usunięte.

---

## 4. WS4 — Szablon planu i guidance w promptach (spójność)

> Plan u Claude Code **wyłania się z rozpoznania**, nie z formularza — ale guidance steruje *kiedy* i *jak*. Zakoduj to raz, nie powtarzaj w każdym promncie.

### 4.1 Szablon planu (struktura, nie sztywny formularz)
Do `prompts/meta/base.md` (i analogicznie do ekspertów), jeden blok referencyjny:
```
CEL: <jedno zdanie, mierzalne>
ZAŁOŻENIA: <co przyjmuję za prawdę — replanowanie to sprawdza>
ETAPY: [{ id, intencja, narzędzie/agent, oczekiwane_wyjście, sprawdzenie_sukcesu }]
PUNKTY_KONTROLNE: <po którym etapie zweryfikować założenia>
```

### 4.2 Guidance delegacji
- „Buduj `taskSpec`, nie prozę. Zawsze `outOfScope` + `successCriteria`."
- „Deleguj gdy zadanie wymaga TOOL STACK eksperta; `run_worker` dla czystej generacji tekstu." (masz to w `delegate-task.ts:76-77` — wzmocnij).

### 4.3 Reguła „rozpoznanie przed akcją"
- Dla zadań złożonych: search/recon przed planem (jak Explore subagent u Claude Code). U Ciebie: `search_tools` + `recall_worker_lessons` + memory recall PRZED `plan_task`.

### 4.4 Acceptance
- [x] Jeden blok szablonu planu w bazowych promptach, bez duplikacji. (`meta/base.md` — inline `📋 Plan` rozszerzony o `Assumptions` + per-step `success`, z notką że dzieli słownik z `system_plan_task`: goal · assumptions · steps[intent → agent, success] · checkpoints · done.)
- [x] Guidance delegacji wskazuje `taskSpec`. (Sekcja A) — `PREFERRED — pass a structured taskSpec`, `always fill outOfScope` + `successCriteria`; dodany jednoliniowy *Routing rule*: ekspert = tool stack/identity/memory, worker = czysta generacja tekstu.)
- [x] Reguła „rozpoznanie przed akcją" w `Task Planning` — `search_tools` + `recall_worker_lessons` + `system_memory_recall` równolegle PRZED planem (WS4.3).

---

## 5. Kolejność i zależności

```
WS1 (WorkerTaskSpec)  ──►  WS4 (guidance wskazuje taskSpec)
        │
        └──►  WS2 (Plan-and-Execute; plan produkuje taskSpec-y dla kroków)
                      │
WS3 (tool metadata + MCP) ── równolegle, niezależne ──┘
```

**Rekomendowana sekwencja:**
1. **WS1** — największy zysk/koszt, odblokuje resztę (plan kroków = taskSpec-y).
2. **WS2** — ożywienie `GoalContract` + replanowanie przez Reflektor.
3. **WS3** — audyt opisów + 1 migracja MCP (można robić równolegle, niezależne od WS1/2).
4. **WS4** — domknięcie guidance.

---

## 6. Czego NIE robić (świadome decyzje)

- **Nie przepisywać routingu.** `delegate_task`/`run_worker` (orchestrator-worker) są dobre. Ewentualny jawny klasyfikator intencji (`prompts/meta/intent-router.md` istnieje, ale nieegzekwowany) to optymalizacja, nie brak — odłóż.
- **Nie budować nowego silnika planowania.** `GoalContract` + Reflektor wystarczą — ożywić, nie zastępować.
- **Nie zastępować narzędzi domenowych (chef/n8n/hunt) MCP-em.** To Twoja wartość. MCP tylko dla generycznych integracji (Google/GitHub/FS).
- **Nie wprowadzać hierarchii „super-agent nad meta" teraz.** Najpierw te 4 WS (infrastruktura). Hierarchia ma sens dopiero gdy delegacja jest kontraktowa i planowanie działa.

---

## 7. Definicja ukończenia (cały plan)

System osiąga „harness-grade", gdy:
1. Każda delegacja przechodzi przez `taskSpec` ze scope + success criteria (nie prozą).
2. Złożone zadania mają LLM-generowany plan z jawnymi założeniami, a złamane założenie wyzwala mierzalne replanowanie.
3. Każde narzędzie ma opis sterujący wyborem (`useWhen`/`avoidWhen`).
4. ≥1 własny tool-stack zastąpiony serwerem MCP (mniej kodu do utrzymania).

Po tym: user przechodzi do budowy wyspecjalizowanych agentów gastronomicznych na stabilnej infrastrukturze.
