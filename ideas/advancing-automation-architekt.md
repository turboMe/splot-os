# Automation Architect — Plan Upgrade'u do Poziomu Coding Agenta

> Status: ANALIZA UKOŃCZONA  
> Data: 2026-05-13  
> Cel: Podniesienie Automation Architect do poziomu coding agenta, wykorzystując infrastrukturę zbudowaną w jcode-inspired memory and harness plan.

## Diagnoza: Co Ma Coding Agent, Czego Brakuje Automation Architect

Coding agent przeszedł kompleksową transformację — z agenta "nadziei" (liczymy, że model pamięta) na agenta z harnessem (system pilnuje kontekstu, telemetrii, bezpieczeństwa i pamięci). Automation Architect ma Golden Path, ale reszta infrastruktury go omija.

### Porównanie Feature-by-Feature

| Feature | Coding Agent | Automation Architect | Gap |
|---------|:---:|:---:|-----|
| **Harness wrapper** (`generateCoding`) | ✅ Pełny | ❌ Brak | `delegate-task.ts` używa `agent.generate()` bezpośrednio |
| **Auto Pre-Context** (memory, skills, repo map) | ✅ Via harness | ❌ Brak | Nie dostaje pasywnej pamięci przed turą |
| **Async Semantic Memory** | ✅ Schedule po turze | ❌ Brak | Nie uczy się z failure cases, nie dostaje pending memory |
| **Tool Envelope** (telemetria, policy) | ✅ 11 narzędzi | ❌ 0 narzędzi | Żaden architect tool nie jest objęty envelope |
| **Output Compaction** | ✅ test/search/diff | ❌ Brak | Golden Path JSON, deploy responses, validation reports mogą być duże |
| **Policy Layer** (log-only) | ✅ read/write/shell/git | ❌ Brak | Deploy/activate to high-risk — powinny być logowane |
| **Run State** (`agent_runs`, `agent_run_events`) | ✅ Per coding call | ❌ Brak | Brak trace'u delegacji do architeka |
| **FileTouch Ledger** | ✅ Coding tools | N/A | Architect nie edytuje plików bezpośrednio |
| **Background Tasks** (`bg_task`) | ✅ Via `coding_run_test` | ❌ Brak | Deploy + test mógłby być async |
| **Soft Interrupts** (pending messages) | ✅ subtask/parallel-dispatch | ❌ Brak | Nie dostaje urgent messages mid-session |
| **Code Outline/Search** | ✅ `code_outline`, `code_search` V2 | N/A | Nie dotyczy workflow JSON |
| **`system_memory_recall`** tool | ✅ Jest | ❌ Brak | Nie może szukać w pamięci systemowej |
| **`system_memory_write`** tool | ✅ Jest | ❌ Brak | Nie zapisuje lekcji do pamięci |
| **`skill_search` / `skill_load`** tools | ✅ Jest | ❌ Tylko `architect_skills_search` | Oddzielny, niespójny z systemowym registry |
| **`TokenLimiterProcessor`** | ✅ 120K limit | ❌ Brak | Ryzyko overflow przy długich sesjach |
| **`pendingUpdatesProcessor`** | ✅ Meta agent | ❌ Brak | Nie odbiera async results |
| **`sharedMemoryOutputProcessor`** | ✅ Meta agent | ❌ Brak | Nie persystuje decyzji do shared memory |
| **Replay/Debug** | ✅ `replay-harness-run.ts` | ❌ Brak | Brak trace'u dla automation sessions |
| **Anthropic System Cache** | ✅ `withAnthropicSystemCache` | ❌ Brak | Static instructions nie są cache-friendly |
| **Working Memory template** | ✅ Rozbudowany | ✅ Jest | OK — ma template |
| **maxSteps** | ✅ 40 | ❌ Default (?) | Może nie wystarczać dla Golden Path + repair loop |

---

## Rekomendowane Zmiany — Priorytetyzowane

### 🔴 Priorytet 1: Harness Wrapper dla Automation Architect

**Problem:** `delegate-task.ts` deleguje do `automationArchitect` przez gołe `agent.generate()`. Oznacza to:
- brak `runId`/`turnId` — zero traceability
- brak pre-contextu — agent nie dostaje pasywnej pamięci
- brak async semantic memory — nie uczy się z porażek
- brak run state — nie wiadomo, w jakiej fazie jest

**Rozwiązanie:** Stworzyć `generateAutomation()` wrapper (albo generyczny `generateWithHarness()`) analogiczny do `generateCoding()`, ale z fazami dopasowanymi do automation:

```ts
export type AutomationHarnessPhase =
  | 'discover'     // pattern search, runtime check
  | 'compose'      // build workflow JSON
  | 'validate'     // validate + risk score
  | 'deploy'       // deploy inactive
  | 'test'         // mock/real test
  | 'repair'       // repair loop
  | 'activate'     // activate workflow
  | 'chat';        // general conversation
```

**Zmiana w `delegate-task.ts`:** Routing `automationArchitect` przez harness, tak jak `codingAgent`:

```ts
if (context.targetAgent === 'automationArchitect') {
  const harnessResult = await generateAutomation({
    agent,
    agentId: 'automationArchitect',
    prompt: context.taskDescription,
    threadId: delegationThreadId,
    phase: 'chat',
    timeoutMs: 300_000,
  });
  // ...
}
```

> [!TIP]
> Alternatywa: uogólnić `generateCoding()` na `generateWithHarness()` z konfigurowalnym zestawem faz i kontekstów. Wtedy jeden wrapper obsługuje wszystkich agentów "harnessowych".

---

### 🔴 Priorytet 2: System Memory Tools

**Problem:** Automation Architect nie ma `memoryRecallTool` ani `memoryWriteTool`. Oznacza to:
- nie może samodzielnie szukać w `system_knowledge`
- nie zapisuje lekcji z udanych/nieudanych deployów
- nie korzysta z `failure_case`, `architecture_decision`, `tool_contract`

**Rozwiązanie:** Dodać do `automation-architect.ts`:

```ts
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';

tools: {
  // ...existing tools...
  memoryRecallTool,
  memoryWriteTool,
}
```

---

### 🔴 Priorytet 3: Skill Registry Spójność

**Problem:** Automation Architect ma własny `architect_skills_search`, który jest niezależny od systemowego `SkillRegistry`. Coding Agent używa `skillSearchTool` + `skillLoadTool` z `_skills/` registry.

**Rozwiązanie:** Dodać systemowe `skillSearchTool` i `skillLoadTool` obok istniejącego `architect_skills_search` (który zostaje jako domain-specific). To daje dostęp do `_skills/n8n/`, `_skills/security/`, `_skills/devops/` itd.

```ts
import { skillSearchTool } from '../tools/system/skill-search.js';
import { skillLoadTool } from '../tools/system/skill-load.js';
```

---

### 🟡 Priorytet 4: Tool Envelope dla Architect Tools

**Problem:** Żaden z architect tools nie jest objęty `withToolEnvelope()`. Deploy, activate, test — to high-risk operacje bez telemetrii.

**Rozwiązanie:** Objąć envelope najważniejsze narzędzia:

| Tool | Category | Risk |
|------|----------|------|
| `architect_deploy_automation` | `network` | `high` |
| `architect_activate_automation` | `network` | `high` |
| `architect_execute_automation_request` | `network` | `high` |
| `architect_test_workflow` | `network` | `medium` |
| `architect_repair_workflow` | `other` | `medium` |
| `architect_validate_workflow` | `other` | `low` |
| `architect_risk_score` | `other` | `low` |
| `architect_compose_workflow` | `other` | `low` |
| `architect_match_pattern` | `search` | `low` |

To daje:
- `tool_executions` w Mongo dla każdego deployu
- `policy_allowed`/`policy_blocked` logowanie
- replay trace dla pełnego Golden Path

---

### 🟡 Priorytet 5: Output Compaction

**Problem:** Golden Path zwraca obszerne wyniki: validation reports, risk findings, pełne workflow JSON, test plans. To zaśmieca kontekst modelu.

**Rozwiązanie:** Zintegrować `compactHarnessOutput()` w:
- `executeAutomationGoldenPath()` — kompaktować `steps`, `validation`, `risk` do preview
- `architect_validate_workflow` — pełna validation → artifact, preview do modelu
- `architect_deploy_automation` — pełny workflow snapshot → artifact

---

### 🟡 Priorytet 6: TokenLimiterProcessor + maxSteps

**Problem:** Brak `TokenLimiterProcessor` oznacza ryzyko context overflow przy długich sesjach. Brak jawnego `maxSteps` oznacza potencjalne ograniczenie kroków.

**Rozwiązanie:**

```ts
import { TokenLimiterProcessor } from '@mastra/core/processors';

export const automationArchitect = new Agent({
  // ...
  defaultOptions: { maxSteps: 40 },
  defaultGenerateOptionsLegacy: { maxSteps: 40 },
  defaultStreamOptionsLegacy: { maxSteps: 40 },
  defaultNetworkOptions: { maxSteps: 40 },
  inputProcessors: [
    new TokenLimiterProcessor({
      limit: 120_000,
    }),
  ],
});
```

---

### 🟡 Priorytet 7: Anthropic System Cache

**Problem:** `instructions: await loadPrompt('automation/base')` — brak `withAnthropicSystemCache()`. Static instructions nie są cache-friendly.

**Rozwiązanie:**

```ts
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';

instructions: withAnthropicSystemCache(await loadPrompt('automation/base')),
```

> [!NOTE]
> Automation Architect używa Gemini Pro, nie Anthropic. `withAnthropicSystemCache` działa tylko z Claude. Ale warto dodać na wypadek model switcha — jest no-op dla Gemini.

---

### 🟢 Priorytet 8: Async Delegation Support

**Problem:** `delegate-task.ts` wspiera `async=true` tylko dla `codingAgent`. Automation architect nie może być delegowany w tle.

**Rozwiązanie:** Dodać support `async` dla `automationArchitect` w `delegate-task.ts`. Deploy + test + repair loop to doskonały kandydat na background execution.

---

### 🟢 Priorytet 9: Shared Memory Output Processor

**Problem:** Meta agent ma `sharedMemoryOutputProcessor`, który persystuje kluczowe decyzje. Automation architect nie ma — jego deployment decisions giną z kontekstem.

**Rozwiązanie:** Rozważyć `outputProcessors: [sharedMemoryOutputProcessor]` lub dedykowany automation-specific output processor.

---

### 🟢 Priorytet 10: Background Tasks Integration

**Problem:** Golden Path jest synchroniczny. Długi deploy + test + 3x repair loop może trwać minuty.

**Rozwiązanie:** Dodać `bgTaskTool` do architect tools, albo zintegrować Golden Path z `BackgroundTaskManager` — startować Golden Path jako background task z `wake=true`, żeby wynik wrócił jako pending message.

---

## Kolejność Implementacji

### Sprint A — Fundamenty (najwyższy ROI) ✅ UKOŃCZONY `60e7542`
1. ✅ Rozszerzono `HarnessPhase` o fazy automation (discover, compose, validate, deploy, test, repair, activate)
2. ✅ Route automation architect delegacje przez harness w `delegate-task.ts` (sync + async)
3. ✅ Dodano `memoryRecallTool` + `memoryWriteTool`
4. ✅ Dodano systemowe `skillSearchTool` + `skillLoadTool` + `skillReportTool`
5. ✅ Dodano `maxSteps: 40` + `TokenLimiterProcessor` (120K)
6. ✅ Dodano `withAnthropicSystemCache`
7. ✅ Prompt v3.0 z sekcją System Memory

### Sprint B — Telemetria i Bezpieczeństwo ✅ UKOŃCZONY
1. ✅ Objąć architect tools `withToolEnvelope()` — wszystkie 9 narzędzi (deploy, activate, execute, test, repair, validate, risk, compose, match)
2. ✅ Output compaction dla Golden Path (limit 1000 znaków w logach, 4000 w strukturach)
3. ✅ Policy log-only (log-only mode) dla deploy/activate/test/compose
4. ✅ Rejestracja decyzji Policy i telemetrii w MongoDB (`tool_executions`, `harness_events`)

### Pre-Sprint C — Autonomia Architekta ✅ UKOŃCZONY
1. ✅ Twardy failure-learning hook dla Golden Path: `blocked`, `manual_review_required` i exception zapisuja `failure_case`, `automation_events` oraz `task_failed`
2. ✅ Recovery strategy layer: draft validation retry, mock-test repair strategies, `recoveryStrategies` w wyniku Golden Path
3. ✅ Pending updates dla `automationArchitect` przez dedykowany `PendingUpdatesProcessor`
4. ✅ Subagent delegation: `system_delegate_task` + `system_run_worker` dostepne dla architekta z `callerAgentId`
5. ✅ Kontrolowany `ToolSearchProcessor`: krytyczne narzedzia zostaja stale dostepne, rzadkie orchestration tools sa discoverable
6. ✅ Background task plumbing: `bg_task` moze targetowac aktualnego agenta/thread przez harness context, completion wraca jako pending message

### Sprint C — Autonomia Operacyjna ✅ UKOŃCZONY

**Cel Sprintu C:** przejsc od architekta, ktory ma juz pamiec, retry i telemetry, do architekta, ktory potrafi bezpiecznie prowadzic dlugie zadania automatyzacyjne jako durable workflow: startowac Golden Path w tle, wracac z wynikiem do wlasciwego agenta, dostawac automation-specific pre-context i persystowac decyzje operacyjne bez polegania na tresci ostatniej odpowiedzi modelu.

Sprint C nie powinien dodawac nowych ryzykownych mozliwosci deploy/activate. Ma ustrukturyzowac to, co juz istnieje:
- Golden Path pozostaje jedyna deterministyczna sciezka build/deploy/test/repair.
- Activation nadal wymaga policy/approval.
- Background execution nie moze obchodzic risk score, approval ani credential checks.
- Subagenci nie moga wykonywac deployu ani activation za architekta.

#### C1. Dedykowany Automation Pre-Context

**Problem:** `automationArchitect` korzysta teraz z ogolnego harnessu, ale pre-context nadal jest mocno coding-oriented. Architekt potrzebuje przed tura innego zestawu faktow: runtime topology, n8n health, credential registry, pattern catalog, podobne failure cases i aktywne automations.

**Zakres implementacji:**

1. Dodac `src/mastra/services/automation-precontext.ts`.
2. Publiczne API:
   - `buildAutomationPrecontext(input)`
   - `AutomationPrecontextInput`
   - `AutomationPrecontextResult`
3. Pre-context ma budowac zwiezly blok systemowy z sekcji:
   - `Runtime Topology`: mode, endpointy dla n8n/Mastra/Ollama/Mongo, public webhook base URL.
   - `n8n Runtime Health`: ostatni znany health check lub informacja, ze trzeba odswiezyc przez `architect_runtime_check`.
   - `Credential Registry`: tylko nazwy/uslugi i status configured/missing, bez sekretow.
   - `Pattern Candidates`: top pasujace executable patterns dla requestu, plus ostrzezenie o abstract patterns.
   - `Known Failure Cases`: top `failure_case` z `system_knowledge` dla podobnego requestu/workflow/patternu.
   - `Active Automation State`: jezeli znane `automationId`/`workflowId`, pokaz status, lastTest, riskVerdict, repairAttempts.
   - `Pending Automation Updates`: wyniki background/durable jobs zwiazane z tym threadem albo automationId.
4. Dodac feature flag:
   - `FEATURE_AUTOMATION_PRECONTEXT=true`
5. Budzet kontekstu:
   - default maks. 6-8 KB tekstu,
   - max 5 failure cases,
   - max 5 pattern candidates,
   - dlugie dane do artifactu przez `compactHarnessOutput()`.
6. Pre-context ma byc jawnie oznaczony jako pomocniczy:
   - aktualne tool results maja pierwszenstwo,
   - runtime topology z toola ma pierwszenstwo nad pamiecia,
   - brak credentiala w pre-context nie jest ostatecznym dowodem; przed deployem i tak musi przejsc resolver/validator.

**Kryteria akceptacji:**

- Architekt przed zadaniem widzi runtime topology, credential summary i podobne failure cases bez recznego recall.
- Pre-context nie ujawnia sekretow.
- Pre-context nie dubluje duzych workflow JSON-ow.
- Przy wylaczonej fladze zachowanie architekta zostaje jak obecnie.

#### C2. Uogolnienie Harnessu: `generateWithHarness()`

**Problem:** `generateCoding()` obsluguje juz `automationArchitect`, ale nazwa i czesc semantyki sa codingowe. Sprint C powinien uporzadkowac to bez duzego refactoru naraz.

**Rekomendacja:** zrobic opcje A z poprzedniej decyzji architektonicznej: jeden generyczny harness core i cienkie aliasy per agent.

**Zakres implementacji:**

1. Dodac `src/mastra/services/generate-with-harness.ts`.
2. Przeniesc wspolny core z `coding-harness.ts`:
   - run state,
   - `runId`/`turnId`,
   - timeout,
   - tool execution context,
   - feature flags,
   - LLM telemetry,
   - async semantic memory scheduling.
3. Dodac konfiguracje per agent:
   - `agentId`,
   - `phase`,
   - `contextBuilder`,
   - `repoPath` optional,
   - `memoryResource`,
   - `precontextFeatureFlag`.
4. Zachowac `generateCoding()` jako wrapper/alias, zeby nie rozwalic istniejacych call-site'ow.
5. Dodac `generateAutomation()` jako cienki wrapper:
   - `agentId: "automationArchitect"`,
   - fazy: `discover`, `compose`, `validate`, `deploy`, `test`, `repair`, `activate`, `chat`,
   - `contextBuilder: buildAutomationPrecontext`.
6. Przepiac:
   - `delegate-task.ts` dla `automationArchitect`,
   - `async-delegation.ts` dla `automationArchitect`,
   - ewentualne przyszle durable jobs.

**Kryteria akceptacji:**

- `generateCoding()` nadal dziala bez zmiany kontraktu.
- `automationArchitect` nie idzie przez coding-specific pre-context.
- `agent_runs`, `agent_run_events`, `tool_executions` nadal maja spojne `runId`/`turnId`.
- `npm run audit:harness` nadal przechodzi.

#### C3. Durable Golden Path Job

**Problem:** `bg_task` jest ogolnym mechanizmem background command. Golden Path nie powinien byc uruchamiany jako shell command. Potrzebuje natywnego job managera, ktory zapisuje stan, wynik i adresata pending update.

**Zakres implementacji:**

1. Dodac `src/mastra/services/automation-job-manager.ts`.
2. Publiczne API:
   - `startAutomationJob(input)`
   - `getAutomationJob(jobId)`
   - `listAutomationJobs(filter)`
   - `cancelAutomationJob(jobId)` jako best-effort
   - `markStaleAutomationJobs()`
3. Mongo collection: `automation_jobs`.
4. Minimalny schema:
   - `jobId`
   - `automationId`
   - `targetAgentId`
   - `callerAgentId`
   - `callerThreadId`
   - `architectThreadId`
   - `status`: `queued` / `running` / `completed` / `failed` / `cancelled` / `stale`
   - `inputPreview`
   - `resultPreview`
   - `resultArtifactId`
   - `error`
   - `startedAt`, `completedAt`, `lastHeartbeatAt`, `expiresAt`
   - `runId`, `turnId`
5. Job wykonuje `executeAutomationGoldenPath(input)` w tle w procesie Mastry, nie przez shell.
6. Wynik joba:
   - pelny wynik do `harness_artifacts`, jezeli duzy,
   - preview do `automation_jobs.resultPreview`,
   - pending message do `targetAgentId`/`callerThreadId`,
   - jezeli job przyszedl z meta, wynik musi wrocic do `meta-agent`,
   - jezeli job wystartowal architekt dla siebie, wynik wraca do `automationArchitect`.
7. Dodac tool:
   - `architect_start_automation_job`
   - ewentualnie `architect_get_automation_job`
   - ewentualnie `architect_list_automation_jobs`
8. Alternatywa do rozważenia w implementacji:
   - rozszerzyc `architect_execute_automation_request` o `background: true`,
   - ale preferowany jest osobny tool, bo kontrakt sync Golden Path pozostaje prosty.

**Kryteria akceptacji:**

- Architekt moze wystartowac dlugi Golden Path i od razu dostac `jobId`.
- Po zakonczeniu wynik wraca jako pending update do wlasciwego agenta.
- Job nie aktywuje workflowa bez approval/policy.
- Restart procesu nie udaje, ze job nadal dziala; stare `running` przechodza w `stale`.
- Pelny wynik jest osiagalny przez artifact/job lookup, a model dostaje tylko preview.

#### C4. Automation Decision Output Processor

**Problem:** meta-agent ma shared memory output processor, ale architekt potrzebuje bardziej strukturalnej pamieci decyzji: deploy status, blokady, risk, activation constraints, credential gaps i rezultat testow.

**Zakres implementacji:**

1. Dodac `src/mastra/processors/automation-decision-output.ts`.
2. Processor ma parsowac finalne odpowiedzi architekta heurystycznie, ale nie polegac tylko na prose. Priorytet danych:
   - wynik `architect_execute_automation_request`,
   - `automation_jobs`,
   - `automation_requests`,
   - final response text jako fallback.
3. Zapisywac do `shared_memory`:
   - `type: "automation_decision"`
   - `sourceAgent: "automationArchitect"`
   - `automationId`
   - `workflowId`
   - `status`
   - `riskVerdict`
   - `lastTestStatus`
   - `activationAllowed`
   - `summary`
   - TTL: 3-7 dni.
4. Dla trwalych lekcji nadal uzywac `system_knowledge`:
   - `failure_case` dla porazek,
   - `workflow_result` dla udanych recovery,
   - `architecture_decision` dla decyzji projektowych.
5. Podpiac processor do `automationArchitect.outputProcessors`.

**Kryteria akceptacji:**

- Meta-agent i inne agenty moga odzyskac ostatnie decyzje architekta bez parsowania calej rozmowy.
- Processor nie zapisuje sekretow ani pelnych workflow JSON.
- Nie zapisuje smieci dla krotkich rozmow bez decyzji.

#### C5. Contract: Meta -> Architect -> Background -> Meta

**Problem:** mamy juz `callerAgentId`, `targetAgentId` i pending updates, ale Sprint C musi utrwalic kontrakt routingu wynikow.

**Zakres implementacji:**

1. Ustandaryzowac metadata dla delegacji i jobs:
   - `originAgentId`
   - `originThreadId`
   - `targetAgentId`
   - `targetThreadId`
   - `returnToAgentId`
   - `returnToThreadId`
2. `delegate-task.ts`:
   - przy async delegation do `automationArchitect` przekazuje origin/return metadata.
3. `automation-job-manager.ts`:
   - uzywa `returnToAgentId`/`returnToThreadId` do pending message.
4. `PendingUpdatesProcessor`:
   - konsumuje tylko wiadomosci dla swojego `agentId` lub legacy unscoped.
5. `checkPendingUpdates`:
   - wspiera `agentId` i opcjonalny `threadId`,
   - nie powinien przypadkowo zjesc wyniku przeznaczonego dla innego agenta.

**Kryteria akceptacji:**

- Async task z meta do architekta wraca do meta.
- Background job wystartowany przez architekta dla siebie wraca do architekta.
- Legacy unscoped messages nadal dzialaja dla kompatybilnosci.

#### C6. Verification Scripts

**Zakres implementacji:**

1. Dodac `src/mastra/scripts/check-automation-autonomy.ts`.
2. Check powinien pokrywac:
   - automation pre-context buduje blok i redaguje credentiale,
   - durable job startuje i zapisuje rekord `automation_jobs`,
   - completion kolejkuje pending message z `targetAgentId`,
   - `takePendingMessages({ agentId })` nie konsumuje cudzego wyniku,
   - failure Golden Path zapisuje `failure_case`,
   - output processor zapisuje `automation_decision`.
3. Dodać npm script:
   - `check:automation-autonomy`

**Kryteria akceptacji:**

- `npm run check:automation-autonomy` przechodzi lokalnie.
- Istniejace checki nadal przechodza:
   - `npm run build`
   - `npm run audit:harness`
   - `npm run check:automation-patterns`
   - `npm run check:automation-golden-path`
   - `npm run check:n8n-runtime`

#### C7. Scope Guardrails

Sprint C nie obejmuje:

- pelnego workera kolejki odpornego na restart procesu z resume od srodka Golden Path,
- web UI dla jobs,
- nowych patternow n8n,
- nowych credential providerow,
- automatycznej aktywacji bez approval,
- przekazywania pelnego tool poola meta-agentowi albo architektowi,
- refactoru wszystkich agentow na nowy harness w jednym kroku.

#### Kolejnosc Prac W Sprincie C

1. ✅ `automation-precontext.ts` + feature flag + minimalna integracja z obecnym harness call-site.
2. ✅ `generateWithHarness()` + `generateAutomation()` bez zmiany zachowania coding agenta.
3. ✅ `automation-job-manager.ts` + `architect_start_automation_job` / get / list / cancel / stale marking.
4. ✅ Pending routing contract dla jobow i delegacji (`origin*`, `target*`, `returnTo*`).
5. ✅ `automation-decision-output.ts`.
6. ✅ `check:automation-autonomy`.
7. ✅ Pelny build i smoke checks.

#### Definition Of Done

Sprint C jest domkniety, gdy:

1. ✅ Architekt dostaje automation-specific pre-context przed tura.
2. ✅ Golden Path moze dzialac jako natywny durable job, bez shell `bg_task`.
3. ✅ Wyniki background/durable wracaja do wlasciwego agenta i threadu.
4. ✅ Decyzje architekta sa zapisywane do shared memory w formacie strukturalnym.
5. ✅ Failure/recovery learning z Pre-Sprint C nadal dziala.
6. ✅ Nie pojawia sie nowa sciezka obejscia policy/approval.
7. ✅ Wszystkie checki Sprintu C oraz dotychczasowe checki automatyzacji przechodza.

**Weryfikacja wykonana 2026-05-14:**
- `npx tsc --noEmit`
- `npm run build`
- `npm run audit:harness`
- `npm run check:automation-autonomy`
- `npm run check:automation-patterns`
- `npm run check:n8n-runtime`
- `npm run check:automation-golden-path`

---

## Decyzja Architektoniczna: Jeden Harness czy Osobne?

Dwie opcje:

**A) Uogólnić `generateCoding()` → `generateWithHarness()`**
- Jedna brama dla coding, automation, knowledge, etc.
- Fazy i kontekst konfigurowane per agent type
- Mniej kodu, łatwiejsze utrzymanie

**B) Osobny `generateAutomation()`**
- Dedykowane fazy, konteksty, pre-context sources
- Automation pre-context mógłby ładować pattern catalog, runtime topology, credential registry zamiast repo map
- Więcej kodu, ale lepsze dopasowanie

> [!IMPORTANT]
> **Rekomendacja: Opcja A z konfigurowalnym kontekstem.** Harness core (run state, events, memory, policy) jest identyczny. Różnica leży tylko w pre-context sources, które można parametryzować.

---

## Podsumowanie

Stan poczatkowy: Automation Architect mial solidny Golden Path, ale byl odciety od wiekszosci infrastruktury harnessowej zbudowanej w planie jcode-inspired.

Stan po Sprint A, Sprint B i Pre-Sprint C:

1. Harness wrapper, run state i semantic memory scheduling sa aktywne przez `generateCoding()` dla `automationArchitect`.
2. System memory tools, skill registry, maxSteps, token protection i prompt cache wrapper sa podpiete.
3. Architect tools maja Tool Envelope, policy log-only, telemetry i output compaction.
4. Golden Path ma failure-learning hook, recovery strategy layer i zapisuje naprawy/porażki do pamieci systemowej.
5. Architekt ma pending updates, subagent delegation, run workers oraz kontrolowany discoverable `bg_task`.

Pozostale elementy sa juz materialem na Sprint C: dedykowany automation pre-context, durable Golden Path job i automation-specific shared decision processor.
