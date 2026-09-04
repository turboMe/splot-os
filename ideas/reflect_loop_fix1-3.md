# Audyt implementacji Cognitive Loop — fazy 1-4

> Data audytu: 2026-06-05  
> Zakres: `reflect_loop.md`, faza 1, faza 2, faza 3, faza 4  
> Tryb: read-only audit kodu + plan poprawek  
> Wniosek główny: faza 1 jest w większości poprawna, faza 2 po Etapie 1 ma realny second-pass repair, ale nadal nie ma mid-loop injection, faza 3 po Etapie 3 ma operacyjny GoalContract lifecycle + harness/precontext integration, a faza 4 po pierwszej części Etapu 4 realnie steruje `maxSteps`, timeoutem, budżetem kontekstu, depth headerem i configiem reflectora, ale nadal nie ma pełnych bramek `autoDeliberation`, `autoReview`, `requireApproval` ani realnego second-pass po mid-run upgrade.

---

## 1. Executive summary

Implementacja idzie w dobrym kierunku, ale status `COMPLETED` dla faz 2, 3 i 4 jest przedwczesny.

### Ocena faz

| Faza | Deklarowany cel | Obecny stan | Ocena |
|---|---|---|---|
| Faza 1: Prompt-only Planning + Reflector | Dodać planowanie, refleksję i output self-check do promptów | Sekcje dodane do `meta`, `coding`, `automation` | ✅ zasadniczo OK |
| Faza 2: Programmatic Reflector Hook | Hook runtime po każdym kroku, który może wymusić refleksję / re-plan | Hook analizuje kroki, loguje eventy i może uruchomić no-tool repair pass po pierwszym przebiegu | ⚠️ częściowo, po Etapie 1 |
| Faza 3: Goal-Aware Execution | Persystentny GoalContract ze śledzeniem planu, dowodów, postępu i completion | Podstawowy cykl delegacji + harness evidence + precontext/checkpoint + completion scoring działają | ⚠️ częściowo, po Etapie 3 |
| Faza 4: Adaptive Depth Controller | Automatycznie dobrać głębokość: fast / standard / deep / critical | Po pierwszej części Etapu 4 profil steruje `maxSteps`, timeoutem, budżetem kontekstu, depth headerem i reflectorem; bramki review/approval/deliberation nadal są otwarte | ⚠️ częściowo |

### Najważniejsze problemy

1. `StrategyReflector` nadal nie wstrzykuje `decision.message` do kolejnego kroku Mastra ReAct loop. Po Etapie 1 wpływa na wynik przez kontrolowany second-pass repair.
2. `GoalContract` nie jest już fire-and-forget w `system_delegate_task`; `goalContractId` jest zachowywany i zwracany z delegacji.
3. `recordEvidence`, `completeGoalContract`, `formatGoalForPrompt` i `evaluateCompletion` są podłączone do runtime. `recordPlanRevision` nadal nie jest używany automatycznie.
4. `context-checkpoint.ts` ma lightweight `goalContractId`; pełne plan steps/snapshot nadal pozostają w `goal_contracts`.
5. `npm run audit:harness` po Etapie 1 przechodzi; bezpośrednie `agent.generate()` w ścieżkach deliberation mają jawne `@harness-exempt`.
6. `low_confidence` triggeruje decyzję po użyciu narzędzi; `scope_creep` ma minimalną heurystykę. Lepsza wersja powinna użyć GoalContract/originalGoal.
7. Tool result z `success:false` jest liczony jako błąd przez runtime reflector.
8. Po pierwszej części Etapu 4 `DepthProfile` realnie steruje `maxSteps`, `timeoutMs`, `contextBudgetTokens`, depth headerem i configiem reflectora; `autoDeliberation`, `autoReview`, `requireApproval` nadal nie są bramkami runtime.
9. Upgrade głębokości w trakcie runu nie zmienia już ustawionego `generateOptions.maxSteps`, timeoutu ani konfiguracji istniejącego reflectora.
10. `fast` ma po pierwszej części Etapu 4 tani reflector, więc ma runtime sensor eskalacji; nadal brakuje pełnego soft-stop/second-pass po upgrade depth.
11. Klasyfikator został skalibrowany dla audytów, architektury i high-risk, ale nadal pozostaje heurystyczny i powinien być rozszerzany testami na realnych promptach.

---

## 2. Walidacja wykonana podczas audytu

### Komendy

```bash
npx tsc --noEmit
npm run audit:harness
npm run check:strategy-reflector
rg -n "GoalContract|goal_contract|createGoalContract|recordEvidence|completeGoalContract" src/mastra -g '*.ts'
rg -n "onStepFinish|reflector|inject_reflection|agent.generate" src/mastra -g '*.ts'
rg -n "goalContract|autoDeliberation|autoReview|requireApproval|contextBudgetTokens|planning|timeoutMs|depth_classified|depth_upgraded" src/mastra -g '*.ts'
npx tsx -e "import { classifyComplexity } from './src/mastra/services/depth-controller.ts'; /* sample classification smoke check */"
```

### Wyniki

- `npx tsc --noEmit` przeszedł bez błędów.
- Przed Etapem 1 `npm run audit:harness` zakończył się błędem i wykrył 2 bezpośrednie wywołania `agent.generate()`.
- Po Etapie 1 `npm run audit:harness` przechodzi; wykryte direct generate są świadomie oznaczone jako `@harness-exempt`.
- Po Etapie 1 `npm run check:strategy-reflector` przechodzi i pokrywa minimalne sygnały runtime reflectora.
- Po Etapie 3 `npx tsc --noEmit`, `npm run audit:harness` i `npm run check:strategy-reflector` nadal przechodzą.
- Nie ma jeszcze klasycznego test runnera/speców dla nowych usług. Po Etapie 1 `strategy-reflector.ts` ma minimalny check script; `goal-tracker.ts` nadal nie ma pokrycia.
- Nowe typy eventów `reflector_triggered` i `reflector_snapshot` są zarejestrowane.
- Po Etapie 1 dodano eventy `reflection_repair_started`, `reflection_repair_completed`, `reflection_repair_failed`.
- Nowe typy eventów `depth_classified` i `depth_upgraded` są zarejestrowane.
- Po Etapie 3 eventy domenowe `goal_contract_created`, `goal_evidence_recorded`, `goal_plan_revised`, `goal_contract_completed`, `goal_completion_evaluated` są zarejestrowane, a `goal_completion_evaluated` jest logowany przez `evaluateCompletion()`.
- Po pierwszej części Etapu 4 dodano `npm run check:depth-controller`, który pokrywa minimalne przypadki fast/deep/critical i fallback flagi `FEATURE_ADAPTIVE_DEPTH=off`.
- Smoke check klasyfikacji ujawnił zaniżanie głębokości:
  - `zaprojektuj architekturę integracji CRM + email + n8n` → `standard`, score `0.30`;
  - `zmigruj produkcyjną bazę danych i usuń stare indeksy` w fazie `deploy` → `deep`, score `0.40`, a nie `critical`;
  - `zrób dokładny audyt implementacji fazy 4 i sprawdź czy niczego nie pominąłem` → `fast`, score `0.00`, bo `sprawdź` obniża score, a `dokładny` nie matchuje `dokładnie`.
- Po pierwszej części Etapu 4 powyższe klasyfikacje są zabezpieczone przez `npm run check:depth-controller`.

---

## 3. Faza 1 — Prompt-only Planning + Reflector

### Co miało być wykonane

Plan zakładał dodanie:

- `Task Planning`
- `Strategy Reflector`
- `Output Self-Check`

Priorytetowe pliki:

- `src/mastra/prompts/meta/base.md`
- `src/mastra/prompts/coding/base.md`
- `src/mastra/prompts/automation/base.md`

### Co jest zaimplementowane

#### `meta/base.md`

Dodano:

- `## Task Planning (MANDATORY before execution)`
- `## Strategy Reflector (MANDATORY after every tool result)`
- `## Output Self-Check (before sending final response)`

To jest zgodne z planem fazy 1. Meta-agent ma obecnie jawny wymóg stworzenia planu przed narzędziami oraz porównywania kolejnych kroków z planem.

#### `coding/base.md`

Dodano:

- `## Task Planning (MANDATORY for multi-file or multi-step tasks)`
- `## Strategy Reflector (after every tool result or subagent return)`

To jest zgodne z zamysłem, ale nie zawiera osobnej sekcji `Output Self-Check`. Plan fazy 1 wskazywał Output Self-Check explicite głównie dla `meta/base.md`, więc nie traktuję tego jako błąd krytyczny.

#### `automation/base.md`

Dodano:

- `## Strategy Reflector (after every Golden Path step)`

To jest zgodne z opisem w `reflect_loop.md`, gdzie przy automations plan wskazywał przede wszystkim reflector dopasowany do Golden Path.

### Ocena jakości

Faza 1 działa jako prompt-only mechanism. To oznacza, że skuteczność zależy od modelu i nie jest egzekwowana runtime'owo. Jest to zgodne z charakterem tej fazy.

### Ryzyka

1. `meta/base.md` nakazuje pokazać plan użytkownikowi przed wykonaniem. Może to pogorszyć UX przy średnich zadaniach, jeśli model będzie nadmiernie werbalny.
2. `coding/base.md` mówi, że plan ma być wewnętrzny. To jest rozsądne dla coding-agent, ale oznacza brak audytowalnego planu w odpowiedzi.
3. `automation/base.md` nie ma jawnego `Task Planning`, tylko Golden Path reflector. Jest to akceptowalne, jeśli Golden Path jest traktowany jako plan proceduralny.

### Wniosek

Faza 1: **zaakceptować jako ukończoną**, z drobną rekomendacją doprecyzowania UX planowania w `meta/base.md`.

---

## 4. Faza 2 — Programmatic Reflector Hook

### Co miało być wykonane

Według planu faza 2 miała dodać runtime hook:

```typescript
const reflector = getReflector(ctx.runId);
const decision = reflector.analyzeStep(stepResult);

if (decision.action === 'inject_reflection') {
  // Wstrzyknij system message do następnego kroku
}
```

Kluczowy cel: systemowy mechanizm, który nie zależy wyłącznie od promptu.

### Co jest zaimplementowane

Dodano:

- `src/mastra/services/strategy-reflector.ts`
- integrację w `src/mastra/services/generate-with-harness.ts`
- eventy `reflector_triggered`, `reflector_snapshot`
- typy eventów w `agent-event-log.ts`

`StrategyReflector` śledzi:

- liczbę kroków,
- liczbę tool calli,
- error rate,
- zmiany target agent,
- powtórzenia narzędzi,
- delegation failures,
- low confidence keywords.

### Główna luka przed Etapem 1

Reflector nie wpływał na dalszy przebieg generowania.

W `generate-with-harness.ts` decyzja `inject_reflection` kończy się tylko:

```typescript
console.warn(`[Harness] Strategy Reflector: ${decision.signal} — ${decision.reason}`);
```

Komentarz w kodzie mówi wprost, że bezpośrednie wstrzyknięcie do Mastra message stream wymaga przyszłej fazy:

```typescript
// Direct injection into the Mastra message stream requires
// framework-level support (Phase 2.5).
```

Przed Etapem 1 oznaczało to, że faza 2 była monitoringiem + telemetrią, a nie programmatic reflectorem w sensie pierwotnego planu.

### Status po Etapie 1

Dodano kontrolowany wariant **Opcji B: second-pass reflection repair**:

- `generateWithHarness()` po pierwszym przebiegu sprawdza, czy `StrategyReflector` triggerował refleksję.
- Jeśli tak, a `FEATURE_REFLECTION_REPAIR_PASS` jest włączone, harness uruchamia drugi przebieg.
- Drugi przebieg ma `maxSteps: 1` i `toolChoice: 'none'`, więc nie odpala kolejnych narzędzi.
- Prompt repair pass zawiera pierwotne polecenie, listę sygnałów reflectora i poprzednią odpowiedź.
- Jeśli repair pass zwróci niepusty tekst, zastępuje finalną odpowiedź.
- Jeśli repair pass się nie uda, harness wraca do pierwotnej odpowiedzi i loguje błąd.

To daje realny wpływ na finalny output, ale nadal nie jest mid-loop injection do kolejnego kroku ReAct.

### Problem z zakresem harnessa

Przed Etapem 1 `npm run audit:harness` wykrył bezpośrednie wywołania:

- `src/mastra/tools/deliberation/run-deliberation-worker.ts`
- `src/mastra/tools/system/delegate-task.ts` dla `deliberationAgent`

Po Etapie 1 obie ścieżki mają jawne `@harness-exempt` z uzasadnieniem:

- `run-deliberation-worker.ts` jest no-tool text-only debate workerem;
- `delegate-task.ts` dla `deliberationAgent` używa agenta z własnymi narzędziami debate flow i nie jest coding harness flow.

`npm run audit:harness` przechodzi.

### Problem z sygnałami

#### `low_confidence`

Status po Etapie 1: **poprawione**.

`low_confidence` triggeruje refleksję po warmupie i po wystąpieniu tool calli. To ogranicza przypadkowe triggery od zwykłej ostrożnej odpowiedzi bez danych runtime.

#### `scope_creep`

Status po Etapie 1: **minimalnie zaimplementowane**.

Reflector śledzi szacowaną długość argumentów tool calli i porównuje ją z długością oryginalnego promptu. To wykrywa najprostszy przypadek driftu, ale idealna wersja powinna porównywać nowe delegacje z `GoalContract.originalGoal`.

#### `success:false`

Przed Etapem 1 `failedToolCalls` rosło tylko przy `tr.isError === true`. W wielu systemach narzędzia zwracają wynik typu:

```json
{ "success": false, "error": "..." }
```

Po Etapie 1 `success:false` jest liczone jako failure przez `isFailureResult()`.

#### Argumenty tool calli

Przed Etapem 1 w jednej części `generate-with-harness.ts` kod poprawnie czytał `tc.payload.toolName` i `tc.payload.args`, ale reflector dostawał tylko:

```typescript
toolName: String(tc.toolName ?? tc.name ?? ''),
args: tc.args,
```

Po Etapie 1 dodano normalizację `normalizeToolCall()` i `normalizeToolResult()`, więc reflector i post-hoc logging używają tego samego, spójnego widoku danych.

### Problem z progami

Konfiguracja ma:

```typescript
maxDirectionChanges: 3
```

a plan mówił trigger `> 2`. Obecnie trigger jest:

```typescript
if (this.directionChanges > this.config.maxDirectionChanges)
```

czyli przy domyślnym `3` odpali dopiero po 4 zmianach, nie po 3.

Podobnie:

```typescript
maxToolRepetitions: 4
if (count >= this.config.maxToolRepetitions)
```

Plan mówił o `> 3`, więc tu akurat zachowanie jest równoważne.

### Wniosek

Faza 2: **częściowo domknięta po Etapie 1**.  
Jest już realny runtime effect przez second-pass repair, poprawione liczenie błędów i normalizacja payloadów. Nadal brakuje testów jednostkowych reflectora oraz idealnego mid-loop injection/re-plan.

---

## 5. Faza 3 — Goal-Aware Execution

### Co miało być wykonane

Plan fazy 3 zakładał:

1. `GoalContract` z planem i success criteria.
2. Generowanie kontraktu na początku delegacji.
3. Rejestrowanie dowodów po każdym tool result.
4. Porównywanie przez reflector postępu z planem.
5. Ewaluację completion przed odpowiedzią.
6. Trigger re-plan, jeśli completion `< 70%`.
7. Persist do istniejącej warstwy checkpointów albo integrację z nią.

### Co jest zaimplementowane

Dodano:

- `src/mastra/services/goal-tracker.ts`
- import w `src/mastra/tools/system/delegate-task.ts`
- po Etapie 2: awaited `createGoalContract(...)` przy delegacji
- po Etapie 2: `goalContractId` w wyniku `system_delegate_task`
- po Etapie 2: `recordEvidence(...)` i `completeGoalContract(...)` dla podstawowego cyklu delegacji
- kolekcję logiczną `goal_contracts` z TTL 7 dni i indeksami

Serwis ma sensowny szkielet:

- `createGoalContract`
- `recordEvidence`
- `recordPlanRevision`
- `updateConfidence`
- `completeGoalContract`
- `getGoalContract`
- `getActiveContractForTask`
- `formatGoalForPrompt`
- `listActiveContracts`

### Główna luka przed Etapem 2

Tworzony kontrakt nie jest potem używany.

W `delegate-task.ts`:

```typescript
void createGoalContract({...}).catch(() => {});
```

To oznacza:

- kod nie czeka na utworzenie kontraktu,
- nie zna `contractId`,
- nie może później wywołać `recordEvidence`,
- nie może oznaczyć completion,
- nie może dodać GoalContract do promptu,
- nie może powiązać kontraktu z wynikiem delegacji.

### Status po Etapie 2

Podstawowy cykl delegacji jest już podłączony:

- `createGoalContract(...)` jest `await` z łagodną degradacją przy awarii Mongo.
- `goalContractId` jest zachowywany i zwracany w output `system_delegate_task`.
- Eventy delegacji dostają `taskId = goalContractId` oraz `data.goalContractId`.
- Synchroniczne delegacje zapisują evidence dla success/failure.
- Synchroniczne delegacje kończą kontrakt przez `completeGoalContract(...)`.
- Async delegacje zapisują evidence `in_progress`, ale nie kończą kontraktu, bo realny wynik wraca później.
- `completeGoalContract(...)` wrzuca final evidence do `evidenceFor` dla success i do `evidenceAgainst` dla failure/abandoned.
- Confidence calculation ma poprawioną kolejność warunków, więc `critical` jest osiągalne.

### Problem z importami

Przed Etapem 2 `delegate-task.ts` importował:

```typescript
createGoalContract, recordEvidence, completeGoalContract
```

ale używał tylko `createGoalContract`.

Po Etapie 2 importy są używane w runtime.

### Problem z jakością planu

Przed Etapem 2 `plannedSteps` miało zawsze jeden krok:

```typescript
plannedSteps: [{
  description: context.taskDescription.slice(0, 150),
  targetAgent: context.targetAgent,
}]
```

To nie jest realny plan. To jest skrócony opis całej delegacji zapisany jako jeden krok.

Plan fazy 3 zakładał model-generated plan steps + success criteria. Obecna implementacja nie generuje ani nie parsuje planu.

Po Etapie 2 minimalny plan ma 3 kroki: odebranie briefu, wykonanie pracy przez agenta, zwrócenie wyniku zgodnego z kontraktem. To jest lepsze niż jeden sztuczny krok, ale nadal nie jest model-generated planem z promptu użytkownika.

### Problem z success criteria

Przed Etapem 2 success criteria to było zawsze:

```typescript
['Delegation returns success: true']
```

To jest za słabe. Taki warunek mówi tylko, że tool zwrócił `success:true`, ale nie mówi, czy wynik faktycznie spełnia cel użytkownika.

Przykład: sub-agent może zwrócić `success:true`, ale odpowiedzieć niepełnie, bez testów albo bez wymaganych danych.

Po Etapie 2 success criteria są minimalnie domenowe dla `codingAgent`, `automationArchitect`, `knowledgeAgent` i `deliberationAgent`.

### Problem z progress

`currentProgress` jest przeliczany tylko na podstawie statusów kroków:

```typescript
doneOrSkipped / steps.length
```

Przed Etapem 2 `recordEvidence` nigdzie nie było wywoływane, więc kroki zostawały `pending`, a progress zostawał `0`.

Po Etapie 2 podstawowe evidence jest zapisywane z delegacji. Dla sync success wszystkie 3 kroki mogą dojść do `done`; dla failure kroki wykonania/zwrotu wyniku są oznaczane jako `failed`; dla async praca zostaje `in_progress`.

### Problem z confidence

Przed Etapem 2 był bug logiczny w kolejności warunków:

```typescript
else if (againstCount > forCount) confidence = 'low';
else if (againstCount > forCount * 2) confidence = 'critical';
```

Warunek `critical` jest praktycznie nieosiągalny, bo jeśli `againstCount > forCount * 2`, to wcześniej spełni się też `againstCount > forCount`.

Powinno być odwrotnie:

```typescript
if (againstCount > forCount * 2) critical
else if (againstCount > forCount) low
```

Status po Etapie 2: poprawione.

### Problem z context checkpoint

Plan mówił o rozszerzeniu `context-checkpoint.ts` o plan steps. Obecny `TaskCheckpoint` nie ma:

- `plannedSteps`,
- `goalContractId`,
- `successCriteria`,
- `currentProgress`,
- `confidenceLevel`.

`context-assembler.ts` ładuje tylko checkpoint, nie ładuje aktywnego GoalContract.

Status po Etapie 3:

- `TaskCheckpoint` ma `goalContractId?: string`.
- `appendToCheckpoint(...)` może zapisać `goalContractId`.
- `formatCheckpointForPrompt(...)` pokazuje powiązany `GoalContract`.
- `context-assembler.ts` ładuje kontrakt po jawnym `goalContractId` albo aktywny kontrakt po `taskId`.
- Pełny plan/progress/confidence pozostają w `goal_contracts`; checkpoint trzyma tylko lekki link.

### Problem z eventami

Przed Etapem 2 plan mówił, że event types są registered. Zarejestrowano eventy reflectora, ale nie było dedykowanych eventów GoalContract.

Przed Etapem 2 `completeGoalContract` logował ogólne `task_completed`, ale:

- nie ma `goal_contract_created`,
- nie ma `goal_evidence_recorded`,
- nie ma `goal_contract_revised`,
- nie ma `goal_contract_completed`.

Dla observability i debugowania cognitive loop to będzie zbyt mało precyzyjne.

Status po Etapie 3: dodano typy `goal_contract_created`, `goal_evidence_recorded`, `goal_plan_revised`, `goal_contract_completed`, `goal_completion_evaluated`. Wszystkie są logowane przez `goal-tracker.ts`, w tym `goal_completion_evaluated` przez `evaluateCompletion()`.

### Wniosek

Faza 3: **częściowo domknięta po Etapie 3**.  
Podstawowy cykl GoalContract, harness evidence, async completion, precontext/checkpoint link i completion scoring działają. Pełne Goal-Aware Execution nadal wymaga twardego completion gate/re-plan oraz bezpośredniego użycia progressu przez StrategyReflector.

---

## 6. Faza 4 — Adaptive Depth Controller

### Co miało być wykonane

Plan fazy 4 zakładał kontroler, który automatycznie dobiera głębokość przetwarzania:

```text
Simple task -> fast path: single model, no reflector, no plan
  -> if fails or uncertainty
Medium task -> standard: plan + reflector enabled, retry allowed
  -> if fails or high risk
Complex task -> full: deliberation + multi-agent + review loop
  -> if still stuck
Escalation -> human approval required
```

Profil miał sterować:

- planning,
- reflectorem,
- deliberation,
- review,
- approval,
- `maxSteps`.

### Co jest zaimplementowane

Dodano:

- `src/mastra/services/depth-controller.ts`,
- `FEATURE_ADAPTIVE_DEPTH` w `src/mastra/config/harness-flags.ts`,
- eventy `depth_classified` i `depth_upgraded`,
- integrację klasyfikacji w `generate-with-harness.ts`,
- `maxSteps` zależne od `getEffectiveProfile(runId).maxSteps`,
- bramkowanie reflectora przez `profile.reflector.enabled`,
- depth-aware config dla reflectora,
- run-scoped depth state,
- auto-upgrade w `StrategyReflector.trigger()`.

To jest sensowny szkielet fazy 4. Kod kompiluje się i telemetrycznie zapisuje klasyfikację.

### Co działa realnie

#### `maxSteps`

`callAgentGenerate()` ustawia:

```typescript
maxSteps: getEffectiveProfile(harnessContext?.runId ?? '').maxSteps
```

To jest realne podłączenie profilu do wykonania.

#### Reflector gating

`generate-with-harness.ts` pobiera profil i odpala `reflector.analyzeStep()` tylko jeśli:

```typescript
currentProfile.reflector.enabled
```

To jest realne podłączenie `fast` vs `standard/deep/critical` do runtime.

#### Telemetria

Logowane są:

- `depth_classified`,
- `depth_upgraded`.

To wystarcza do obserwacji klasyfikatora i późniejszej kalibracji.

### Główna luka

`DepthProfile` wygląda pełniej niż jego runtime effect.

Profil zawiera:

```typescript
planning
goalContract
autoDeliberation
autoReview
requireApproval
contextBudgetTokens
timeoutMs
```

ale obecnie nie są one realnie podłączone do wykonania.

Efekt: faza 4 nie jest jeszcze pełnym Adaptive Depth Controllerem. To jest raczej `maxSteps + reflector gating + telemetry`.

### Problem z `timeoutMs`

Profile mają timeout:

- `fast`: `60_000`,
- `standard`: `180_000`,
- `deep`: `300_000`,
- `critical`: `300_000`.

Ale `withTimeout()` używa:

```typescript
input.timeoutMs
```

a nie:

```typescript
depthProfile.timeoutMs
```

W praktyce:

- jeśli caller przekaże `timeoutMs: 300_000`, to każdy profil ma 300s;
- jeśli caller nie przekaże timeoutu, profilowy timeout nie działa;
- event `depth_classified` raportuje timeout z profilu, który może nie być realnie użyty.

To jest rozjazd między telemetrią a zachowaniem runtime.

Status po pierwszej części Etapu 4: **naprawione**. Harness wylicza `effectiveTimeoutMs = input.timeoutMs ?? depthProfile.timeoutMs`, przekazuje go do `callAgentGenerate()` i raportuje w eventach.

### Problem z `contextBudgetTokens`

`DepthProfile.contextBudgetTokens` nie jest używany przy budowaniu precontextu.

`generate-with-harness.ts` przekazuje:

```typescript
maxTokens: input.contextPolicy?.maxTokens
```

Nie ma fallbacku:

```typescript
input.contextPolicy?.maxTokens ?? depthProfile.contextBudgetTokens
```

Efekt: `fast` nie ogranicza automatycznie kontekstu do 4k, a `deep/critical` nie zwiększają go do 32k.

Status po pierwszej części Etapu 4: **naprawione**. Context builder dostaje `input.contextPolicy?.maxTokens ?? depthProfile.contextBudgetTokens`.

### Problem z planning

Profil deklaruje:

```typescript
planning: 'skip' | 'inline' | 'persisted'
```

ale nie ma wpływu na prompt ani runtime.

W `fast` profil mówi `planning: 'skip'`, ale `meta/base.md` i `coding/base.md` nadal zawierają instrukcje planowania dla nietrywialnych zadań. Brakuje injection albo precontextu typu:

```text
Depth profile: fast. Skip explicit planning unless task becomes non-trivial.
```

Analogicznie `deep` i `critical` deklarują `persisted`, ale nie tworzą GoalContract ani checkpointu planu.

Status po pierwszej części Etapu 4: **częściowo naprawione**. Harness wstrzykuje `## Execution Depth` z instrukcją planowania dla `skip`/`inline`/`persisted`; automatyczny persisted plan storage pozostaje otwarty.

### Problem z GoalContract

Profil `deep` i `critical` mają:

```typescript
goalContract: true
```

ale `generate-with-harness.ts` nie tworzy ani nie podłącza GoalContract na podstawie tego pola.

To dziedziczy problem fazy 3: GoalContract pozostaje osobnym szkieletem, a depth nie przełącza go realnie.

### Problem z autoDeliberation

Profil `deep` i `critical` mają:

```typescript
autoDeliberation: true
```

ale nie ma runtime mechanizmu, który:

- automatycznie deleguje do `deliberationAgent`,
- dołącza deliberation result do kolejnego kroku,
- eskaluje przy sprzecznych tool resultach,
- zatrzymuje odpowiedź do czasu uzyskania deliberation.

`StrategyReflector` tylko zwraca message z sugestią:

```text
Consider delegating to deliberationAgent
```

ale message nadal nie jest wstrzykiwane do modelu, więc autoDeliberation nie działa programowo.

### Problem z autoReview

Profil `critical` ma:

```typescript
autoReview: true
```

Nie znaleziono integracji, która wymuszałaby code review, output review albo quality gate dla critical depth.

To pole jest obecnie deklaratywne.

### Problem z requireApproval

Profil `critical` ma:

```typescript
requireApproval: true
```

Nie znaleziono integracji z `harness-policy.ts`, `system_request_approval` ani tool envelope, która wymuszałaby human gate tylko dlatego, że depth = `critical`.

Efekt: krytyczny profil nie różni się od deep pod względem approval. Różni się głównie ostrzejszym reflector config.

### Problem z upgrade depth

`StrategyReflector.trigger()` wykonuje:

```typescript
if (currentDepth === 'fast') {
  upgradeRunDepth(..., 'standard', ...);
} else if (currentDepth === 'standard' && (...)) {
  upgradeRunDepth(..., 'deep', ...);
}
```

To wygląda dobrze telemetrycznie, ale ma ograniczony efekt runtime:

1. `generateOptions.maxSteps` jest ustawione raz przed `agent.generate()`. Upgrade z `standard` do `deep` w środku runu nie zmieni już realnego `maxSteps` z 25 na 40.
2. `reflector` jest tworzony raz z configiem `currentProfile.reflector.config`. Upgrade nie zmieni configu istniejącego reflectora.
3. `goalContract`, `autoDeliberation`, `autoReview`, `requireApproval` po upgrade też nie zostają uruchomione.
4. `fast` ma `reflector.enabled = false`, więc reflector w ogóle nie analizuje kroków. To oznacza, że ścieżka `fast -> standard` przez reflector praktycznie się nie uruchomi.

Najważniejszy punkt: skoro `fast` wyłącza reflector, to nie ma runtime czujnika, który wykryje failure/uncertainty i podniesie depth. Fast może zakończyć się zbyt płytko.

Status po pierwszej części Etapu 4: punkt 4 jest **naprawiony**. `fast` ma teraz lightweight reflector z `maxReflectionsPerRun: 1`. Pozostałe ograniczenia upgrade depth nadal obowiązują: upgrade nie przebudowuje aktualnego `generateOptions` i nie uruchamia jeszcze kontrolowanego second-pass/gate.

### Problem z klasyfikatorem

Klasyfikator jest prosty i szybki, ale ma widoczne ryzyko zaniżania głębokości.

Smoke check:

```text
short status => fast 0.00
audit detailed => fast 0.00
design => standard 0.30
critical migration => deep 0.40
quick code check => fast 0.00
```

Przykłady problematyczne:

- `zrób dokładny audyt implementacji fazy 4 i sprawdź czy niczego nie pominąłem` zostało sklasyfikowane jako `fast`, bo `sprawdź` jest simple keyword, a `dokładny` nie matchuje `dokładnie`.
- `zaprojektuj architekturę integracji CRM + email + n8n` wpada tylko w `standard`, mimo że prompt i reguły meta-agenta mówią, że architektura/integracja wielu domen powinna iść do deliberation/deep.
- `zmigruj produkcyjną bazę danych i usuń stare indeksy` w fazie `deploy` wpada w `deep`, nie `critical`, mimo wysokiego ryzyka.

Status po pierwszej części Etapu 4: przykłady audytowe, architektoniczne i high-risk są pokryte przez `npm run check:depth-controller`; `chat` jest neutralny, a critical/deep floor chroni przed zaniżeniem.

Brakuje sygnałów z planu fazy 4:

- historyczne wyniki z `system_knowledge`,
- risk level z reguł deliberation,
- predicted tool count,
- jawne high-risk keywords typu `produkcyjna baza`, `delete`, `security`, `migration`, `credential`, `payment`, `approval`.

### Problem z event counters

`depth_classified` jest logowane fire-and-forget i nie zwiększa `eventsWritten`.

To nie jest krytyczne dla działania, ale `eventsWritten` w `HarnessGenerateResult` może zaniżać liczbę faktycznych zdarzeń.

### Wniosek

Faza 4: **częściowo zaimplementowana, ale nie completed**.

Za poprawne można uznać:

- klasyfikator,
- profile,
- feature flag,
- eventy,
- run-scoped state,
- użycie `maxSteps`,
- użycie profilowego timeoutu,
- użycie profilowego budżetu kontekstu,
- depth header wstrzykiwany do promptu,
- bramkowanie reflectora.

Nie działa jeszcze pełny adaptive depth:

- profil nie steruje planowaniem,
- profil nie steruje GoalContract,
- profil nie steruje deliberation,
- profil nie steruje review,
- profil nie steruje approval,
- profil steruje planowaniem tylko promptowo przez depth header; persisted storage nadal nie jest automatyczny,
- GoalContract działa, jeśli `goalContractId` istnieje, ale deep/critical nie tworzą go jeszcze automatycznie,
- upgrade w trakcie runu ma ograniczony wpływ,
- fast ma lightweight ścieżkę obserwacji, ale upgrade nadal nie wymusza second-pass/gate.

---

## 7. Plan poprawek

Poniższy plan zakłada zachowanie obecnej architektury i możliwie mały blast radius.

---

## 7.1. Poprawki dla fazy 2

### P2.1. Rozdzielić telemetry reflector od execution reflector — ✅ wykonane częściowo

Obecny kod jest dobry jako telemetry layer. Trzeba jasno nazwać aktualny stan:

- `analyzeStep()` generuje decyzję,
- eventy i snapshoty są zapisywane,
- decyzja wpływa na finalny output przez second-pass repair,
- decyzja nadal nie wpływa na następny krok w środku ReAct loop.

Następny krok idealny: dodać mechanizm wpływu na kolejne kroki, jeśli Mastra udostępni bezpieczne mid-loop injection.

### P2.2. Dodać realne wstrzyknięcie refleksji — ✅ wykonane jako Opcja B

Do wyboru są 3 ścieżki.

#### Opcja A: jeśli Mastra wspiera modyfikację messages między krokami

W `onStepFinish` należy wstrzyknąć system/developer message:

```text
STRATEGY REFLECTION:
<decision.message>

Before calling another tool, explicitly re-plan in 2-4 bullets and decide whether to continue, change approach, or escalate.
```

To jest najbardziej zgodne z pierwotnym planem.

#### Opcja B: jeśli Mastra nie wspiera dynamic injection

Wykorzystać kontrolowany second-pass:

1. Pierwszy `generate()` wykonuje się do końca.
2. Jeśli reflector triggerował krytyczny sygnał, harness nie zwraca od razu odpowiedzi.
3. Harness wykonuje drugie `generate()` z dopiętym reflection context i podsumowaniem poprzedniego przebiegu.

Minus: droższe i mniej eleganckie.  
Plus: działa bez framework-level support.

Status po Etapie 1: wdrożono tę opcję jako no-tool repair pass z `maxSteps: 1` i `toolChoice: 'none'`.

#### Opcja C: soft-stop przez policy

Jeśli `decision.action === 'inject_reflection'`, hook ustawia run-level flag:

```typescript
reflectionRequired: true
```

Następne narzędzie przez tool envelope sprawdza flagę i blokuje wykonanie, zwracając modelowi komunikat wymuszający re-plan. To jest bardziej inwazyjne, ale może działać bez modyfikacji message stream.

### P2.3. Poprawić odczyt tool call payloadów — ✅ wykonane

Ujednolicić ekstrakcję:

```typescript
function normalizeToolCall(tc) {
  const payload = tc.payload as Record<string, unknown> | undefined;
  return {
    toolName: String(payload?.toolName ?? tc.toolName ?? tc.name ?? ''),
    args: payload?.args ?? tc.args ?? {},
    toolCallId: tc.toolCallId,
  };
}
```

Analogicznie dla tool results.

### P2.4. Liczyć `success:false` jako failure — ✅ wykonane

`processToolResults()` powinien traktować jako błąd:

- `tr.isError === true`,
- `result.success === false`,
- string zawierający `"success":false`,
- string zawierający znane marker errors, jeśli takie istnieją w repo.

### P2.5. Dodać brakujący trigger `low_confidence` — ✅ wykonane

Po `low_progress` albo przed nim:

```typescript
if (this.lowConfidenceDetected) {
  return this.trigger('low_confidence', ...);
}
```

Warto ograniczyć to do sytuacji, gdzie jednocześnie występuje np. `stepNumber >= warmupSteps` albo `totalToolCalls > 0`, żeby nie triggerować od zwykłej ostrożnej odpowiedzi.

### P2.6. Dodać `scope_creep` — ⚠️ wykonane minimalnie

Minimalna wersja:

- zapisać `originalPromptTokensEstimate`,
- zapisać plan size / first prompt size,
- porównać z długością aktualnych tool args, delegacji lub outputu.

Lepsza wersja:

- GoalContract zna `originalGoal`,
- reflector porównuje nowe delegacje i opisy z `originalGoal`,
- jeśli target/context rozszerza się bez uzasadnienia, triggeruje re-plan.

Status po Etapie 1: dodano minimalną heurystykę opartą o rozrost argumentów tool calli względem oryginalnego promptu. GoalContract-based scope creep nadal zostaje w planie fazy 3/4.

### P2.7. Naprawić harness audit — ✅ wykonane

Dla wykrytych bezpośrednich generate:

- albo świadomie oznaczyć `// @harness-exempt` i dodać uzasadnienie,
- albo przepiąć na wspólny harness.

Szczególnie `deliberationAgent` powinien raczej dostać harness, bo reflector ma auto-escalate właśnie do niego.

Status po Etapie 1: audyt przechodzi. Dwie ścieżki deliberation są jawnie oznaczone `@harness-exempt`; pełne przepięcie deliberation na harness pozostaje opcjonalnym refaktorem.

### P2.8. Dodać testy jednostkowe reflectora — ✅ wykonane jako check script

Minimalne testy:

1. `tool_loop` odpala po 4 wywołaniach tego samego toola.
2. `high_error_rate` odpala przy >50% błędów.
3. `direction_instability` odpala przy właściwym progu.
4. `delegation_failures` odpala przy `success:false`.
5. `low_confidence` odpala po wykryciu fraz.
6. `maxReflectionsPerRun` blokuje nadmiarowe refleksje.

Status po Etapie 1: dodano `src/mastra/scripts/check-strategy-reflector.ts` i skrypt `npm run check:strategy-reflector`. Skrypt nie wprowadza nowego frameworka testowego; używa `node:assert/strict` i uruchamia szybkie regresje dla sygnałów reflectora.

---

## 7.2. Poprawki dla fazy 3

### P3.1. GoalContract creation musi być awaited — ✅ wykonane

Zamiast:

```typescript
void createGoalContract(...)
```

powinno być:

```typescript
const goalContract = await createGoalContract(...);
```

Jeśli Mongo padnie, można degradować łagodnie, ale trzeba jawnie mieć:

```typescript
let goalContractId: string | undefined;
```

Status po Etapie 2: `system_delegate_task` robi `await createGoalContract(...)` przez helper z łagodną degradacją do `null`.

### P3.2. Powiązać GoalContract z delegacją — ✅ wykonane dla `system_delegate_task`

Trzeba zapisać `goalContractId` w:

- `runId` albo `taskId`,
- `logAgentEvent.data`,
- wyniku `delegateTaskTool` albo metadata,
- async delegation record, jeśli `async:true`.

Minimalny wariant:

```typescript
const goalTaskId = delegationThreadId;
const goalContract = await createGoalContract(...);
```

Nie tworzyć sztucznego `delegation-${delegationThreadId.slice(0, 12)}`, bo to utrudnia lookup.

Status po Etapie 2: `goalContractId` jest zwracany w output toola, trafia do `taskId`/`data` eventów delegacji, a `taskId` kontraktu bazuje na `delegationThreadId`.

### P3.3. Rejestrować evidence po wyniku delegacji — ✅ wykonane dla delegacji sync, async jako `in_progress`

Po udanej delegacji:

```typescript
await recordEvidence(goalContract.contractId, {
  stepId: 'step-1',
  type: 'for',
  description: summarizeDelegationResult(responseText),
  stepStatus: 'done',
});
await completeGoalContract(goalContract.contractId, 'completed', ...);
```

Po błędzie:

```typescript
await recordEvidence(goalContract.contractId, {
  stepId: 'step-1',
  type: 'against',
  description: error.message,
  stepStatus: 'failed',
});
await completeGoalContract(goalContract.contractId, 'failed', ...);
```

Status po Etapie 2: sync success zapisuje evidence `for` i kończy kontrakt jako `completed`; sync failure zapisuje evidence `against` i kończy jako `failed`; async start zapisuje evidence `in_progress` bez zamykania kontraktu.

### P3.4. Nie oznaczać success wyłącznie przez `success:true` — ✅ wykonane minimalnie

Dla każdego typu agenta success criteria powinny być domenowe.

Przykłady:

#### `codingAgent`

- wskazane pliki przeczytane,
- zmiany wykonane lub audyt dostarczony,
- `tsc --noEmit` / testy uruchomione albo brak możliwości jasno opisany,
- finalny JSON zgodny z `Final Status Format`.

#### `automationArchitect`

- terminal status obecny,
- `automationId` i `workflowId` obecne, jeśli deploy/test succeeded,
- validation result i risk score podane,
- repair attempts opisane.

#### `knowledgeAgent`

- odpowiedź oparta o źródła NotebookLM,
- brak niezweryfikowanych twierdzeń,
- artifacts/source IDs zwrócone, jeśli wymagane.

#### `deliberationAgent`

- warianty ocenione,
- trade-offy opisane,
- rekomendacja uzasadniona,
- ryzyka i open questions wymienione.

Status po Etapie 2: dodano minimalne domenowe success criteria dla `codingAgent`, `automationArchitect`, `knowledgeAgent`, `deliberationAgent` oraz wspólne kryteria dla pozostałych agentów.

### P3.5. Generować realne plannedSteps — ⚠️ wykonane minimalnie

Nie wystarczy jeden krok z całym `taskDescription`.

Minimalny wariant bez dodatkowego LLM:

- jeśli delegacja idzie do jednego agenta, stwórz 3 kroki:
  1. agent analyzes task,
  2. agent executes / investigates,
  3. agent returns result matching output contract.

Lepszy wariant:

- Meta-agent już ma prompt-level plan.
- Dodać opcjonalne pole do `system_delegate_task`:

```typescript
plan?: {
  steps: Array<{ description: string; targetAgent?: string }>;
  successCriteria: string[];
}
```

Wtedy Meta-agent przekazuje swój plan do runtime, a GoalContract nie musi zgadywać.

Najlepszy wariant:

- Dodać osobny `planning` parser/generator, który z taskDescription wyciąga JSON:

```json
{
  "originalGoal": "...",
  "plannedSteps": [...],
  "successCriteria": [...]
}
```

Status po Etapie 2: dodano minimalny 3-krokowy plan dla każdej delegacji. Model-generated plan z promptu lub jawne pole `plan` nadal zostają jako lepsza wersja.

### P3.6. Wpiąć GoalContract w harness — ✅ wykonane

`HarnessGenerateInput` powinien dostać:

```typescript
goalContractId?: string
```

Następnie `onStepFinish` powinien:

1. mapować tool result na evidence,
2. aktualizować step status,
3. przekazywać progress snapshot do `StrategyReflector`.

Status po Etapie 3: `HarnessGenerateInput` ma `goalContractId`; `onStepFinish` mapuje tool results na evidence; po final output/failure uruchamiane jest `evaluateCompletion()`. Progress snapshot nie jest jeszcze bezpośrednio konsumowany przez `StrategyReflector`, ale jest dostępny w `goal_contracts`.

### P3.7. Wpiąć GoalContract w precontext — ✅ wykonane

`context-assembler.ts` powinien obok checkpointu ładować aktywny kontrakt:

```typescript
const contract = taskId ? await getActiveContractForTask(taskId) : null;
```

i dokładać:

```typescript
formatGoalForPrompt(contract)
```

To sprawi, że model przy wznowieniu zadania zobaczy:

- cel,
- plan,
- progress,
- evidence against,
- confidence.

Status po Etapie 3: `context-assembler.ts` ładuje kontrakt po `goalContractId` albo aktywny kontrakt po `taskId`, a następnie dodaje `formatGoalForPrompt(contract)` do sekcji checkpoint/precontext.

### P3.8. Rozszerzyć `context-checkpoint.ts` — ✅ wykonane minimalnie

Opcja minimalna:

```typescript
goalContractId?: string;
```

Opcja pełniejsza:

```typescript
goalContractId?: string;
plannedSteps?: Array<...>;
successCriteria?: string[];
currentProgress?: number;
confidenceLevel?: ConfidenceLevel;
```

Rekomendacja: trzymać pełny kontrakt w `goal_contracts`, a w checkpoint zapisywać tylko `goalContractId` + krótki snapshot.

Status po Etapie 3: checkpoint ma `goalContractId?: string`, loader/formatter go obsługują, a harness best-effort linkuje istniejący checkpoint do kontraktu.

### P3.9. Dodać `evaluateCompletion()` — ✅ wykonane

W `goal-tracker.ts` powinno dojść:

```typescript
export async function evaluateCompletion(contractId: string): Promise<{
  score: number;
  passed: boolean;
  missingCriteria: string[];
  recommendation: 'finalize' | 'replan' | 'ask_user' | 'escalate';
}>
```

Minimalna logika:

- progress z kroków,
- evidenceFor vs evidenceAgainst,
- confidenceLevel,
- obecność wymaganych success criteria.

Próg z planu:

```typescript
if (score < 0.7) trigger re-plan
```

Status po Etapie 3: `evaluateCompletion()` zwraca `score`, `passed`, `missingCriteria`, `recommendation`, `progress`, `confidenceLevel` i loguje `goal_completion_evaluated`. Wynik jest na razie telemetryczno-diagnostyczny; wymuszony re-plan/blocking gate zostaje jako dalsza praca.

### P3.10. Naprawić confidence calculation — ✅ wykonane

Obecnie `critical` może nie zostać ustawione przez złą kolejność warunków.

Poprawka logiczna:

```typescript
if (againstCount > forCount * 2) confidence = 'critical';
else if (againstCount > forCount) confidence = 'low';
else if (againstCount === 0 && forCount > 0) confidence = 'high';
else confidence = 'medium';
```

### P3.11. Dodać eventy GoalContract — ✅ wykonane

Dodać typy:

- `goal_contract_created`
- `goal_evidence_recorded`
- `goal_plan_revised`
- `goal_contract_completed`
- `goal_completion_evaluated`

To ułatwi dashboard, debug i późniejszą kalibrację.

Status po Etapie 2: typy eventów są zarejestrowane. `goal_contract_created`, `goal_evidence_recorded`, `goal_plan_revised`, `goal_contract_completed` są logowane; `goal_completion_evaluated` czeka na P3.9.

### P3.12. Dodać testy jednostkowe GoalTracker

Minimalne testy:

1. `createGoalContract` tworzy dokument z TTL i krokami.
2. `recordEvidence` aktualizuje step status i progress.
3. `completeGoalContract` ustawia status i completedAt.
4. `recordPlanRevision` zwiększa `planRevisions`.
5. `evaluateCompletion` zwraca `passed:false` przy progress `<70%`.
6. confidence przechodzi w `critical` przy przewadze evidenceAgainst.

---

## 7.3. Poprawki dla fazy 4

### P4.1. Użyć profilowego timeoutu — ✅ wykonane

W `callAgentGenerate()` timeout powinien być efektywny z profilu:

```typescript
const effectiveProfile = getEffectiveProfile(ctx.runId);
const effectiveTimeoutMs = input.timeoutMs ?? effectiveProfile.timeoutMs;
```

i dalej:

```typescript
withTimeout(call, effectiveTimeoutMs, ...)
```

Ważne: jeśli caller jawnie podał `timeoutMs`, powinien móc nadpisać profil. Jeśli nie podał, profil powinien działać.

Status wdrożenia:

- `generateWithHarness()` liczy `effectiveTimeoutMs = input.timeoutMs ?? depthProfile.timeoutMs`.
- `callAgentGenerate()` dostaje już efektywny timeout.
- Eventy `depth_classified`, `llm_call_started`, `llm_call_completed` i `llm_call_failed` raportują efektywny timeout.

### P4.2. Użyć profilowego budgetu kontekstu — ✅ wykonane

Przy budowaniu precontextu:

```typescript
maxTokens: input.contextPolicy?.maxTokens ?? depthProfile.contextBudgetTokens
```

To dopina realne różnice:

- `fast` ma mały kontekst,
- `standard` dostaje średni,
- `deep/critical` dostają większy.

Status wdrożenia:

- Context builder dostaje `input.contextPolicy?.maxTokens ?? depthProfile.contextBudgetTokens`.
- Eventy harnessa raportują `contextBudgetTokens`.

### P4.3. Wstrzyknąć depth profile do promptu albo precontextu — ✅ wykonane

Model musi wiedzieć, jaki tryb obowiązuje.

Minimalny depth header:

```markdown
## Execution Depth
Level: fast|standard|deep|critical
Planning: skip|inline|persisted
Reflector: enabled|disabled
Goal contract: enabled|disabled
Review gate: enabled|disabled
Approval gate: enabled|disabled
```

Dla `fast` instrukcja powinna mówić:

```text
Keep answer direct. Do not produce explicit plan unless the task becomes non-trivial.
```

Dla `deep/critical`:

```text
Persist or reference a GoalContract and verify completion criteria before final response.
```

Status wdrożenia:

- Harness wstrzykuje nagłówek `## Execution Depth` przed prompt użytkownika.
- Nagłówek zawiera `level`, `score`, sygnały klasyfikatora, `maxSteps`, timeout, budżet kontekstu, `planning`, reflector, GoalContract, deliberation, review i approval gates.
- `precontext_injected` zapisuje teraz łączny kontekst głębokości i precontextu agenta.

### P4.4. Dopiąć `planning` — 🟡 częściowo wykonane

`DepthProfile.planning` powinien sterować zachowaniem:

- `skip`: bez jawnego planu, chyba że model wykryje ryzyko;
- `inline`: plan promptowy, bez storage;
- `persisted`: create/update GoalContract albo checkpoint planu.

Bez tego pole `planning` jest tylko opisem.

Status wdrożenia:

- `planning` steruje instrukcją w `Execution Depth`.
- Brakuje jeszcze automatycznego persisted plan storage/checkpoint planu tworzonego przez harness.

### P4.5. Dopiąć `goalContract` — 🟡 częściowo wykonane przez Etap 3

Jeśli `profile.goalContract === true`, harness powinien:

1. utworzyć albo załadować GoalContract,
2. przekazać `goalContractId` do `HarnessGenerateInput`,
3. zapisać go w eventach,
4. aktualizować evidence w `onStepFinish`,
5. dodać GoalContract do precontextu.

To powinno być wspólne z poprawkami fazy 3, a nie osobny mechanizm.

Status wdrożenia:

- Harness obsługuje `goalContractId`, evidence i `evaluateCompletion()`.
- GoalContract jest widoczny w precontext, jeśli kontrakt istnieje albo id jest przekazane.
- Brakuje jeszcze automatycznego tworzenia brakującego GoalContract dla każdego deep/critical harness runu.

### P4.6. Dopiąć `autoDeliberation`

Jeśli `profile.autoDeliberation === true`, a reflector wykryje:

- sprzeczne tool results,
- direction instability,
- delegation failures,
- confidence critical,
- high-risk uncertainty,

system powinien uruchomić deliberation w kontrolowany sposób.

Praktyczny wariant:

1. Reflector ustawia run flag `deliberationRequired`.
2. Harness kończy bieżący generate albo blokuje kolejne narzędzie.
3. Harness uruchamia deliberation pass.
4. Wynik deliberation wraca jako precontext do second-pass generate.

Nie wystarczy tekst "consider deliberationAgent", jeśli nie jest wstrzykiwany do modelu.

### P4.7. Dopiąć `autoReview`

Jeśli `profile.autoReview === true`, final response powinien przejść review gate.

Wariant minimalny:

- dla coding tasks: uruchom `generateReview` albo istniejący code review agent;
- dla automation tasks: sprawdź terminal status, risk score, validation i test result;
- dla knowledge/research: sprawdź groundedness i brak niezweryfikowanych twierdzeń;
- dla meta responses: output self-check + completion score.

`autoReview` musi produkować verdict:

```typescript
'approve' | 'needs_changes' | 'block'
```

Przy `needs_changes` powinien nastąpić second-pass repair, przy `block` eskalacja do użytkownika.

### P4.8. Dopiąć `requireApproval`

Jeśli `profile.requireApproval === true`, trzeba powiązać to z policy layer.

Przykład:

```typescript
if (profile.requireApproval && actionIsExternallyVisibleOrDestructive) {
  require system_request_approval
}
```

Nie każde critical zadanie musi pytać o zgodę przed samą analizą, ale critical depth powinien wymuszać approval przed:

- deploy,
- delete,
- migration,
- send email,
- credential changes,
- production data changes,
- workflow activation.

### P4.9. Naprawić mid-run upgrade

Obecny upgrade depth jest głównie telemetryczny. Żeby działał realnie:

#### Opcja A: upgrade działa od kolejnego runu

Zapisać depth upgrade w run state i użyć go dopiero w second-pass generate.

To jest najprostsze i zgodne z ograniczeniem, że `generateOptions.maxSteps` nie zmieni się w środku `agent.generate()`.

#### Opcja B: soft-stop i second-pass

Gdy depth wzrośnie:

1. ustaw `depthUpgradeRequired`,
2. przerwij lub zakończ bieżącą pętlę,
3. uruchom drugi generate z nowym profilem.

#### Opcja C: tool-envelope gate

Przy kolejnym tool callu tool envelope zwraca kontrolowany komunikat:

```text
Depth upgraded from standard to deep. Stop and re-plan before more tool calls.
```

To wymaga integracji z policy/tool envelope.

### P4.10. Dać `fast` tani czujnik eskalacji — ✅ wykonane

Nie można całkiem wyłączyć obserwacji w `fast`, jeśli fast ma eskalować po porażce.

Opcje:

- `fast`: reflector disabled, ale lightweight failure monitor enabled;
- `fast`: reflector enabled z bardzo luźnym configiem i `maxReflectionsPerRun: 1`;
- `fast`: tool envelope monitoruje wyłącznie `success:false`, `isError`, low confidence text i max tool calls.

Najpraktyczniejszy profil:

```typescript
fast.reflector = {
  enabled: true,
  config: {
    warmupSteps: 2,
    maxToolRepetitions: 4,
    maxStepsWithoutProgress: 8,
    maxReflectionsPerRun: 1,
    errorRateThreshold: 0.8,
  }
}
```

Wtedy fast jest nadal tani, ale ma ścieżkę awaryjną.

Status wdrożenia:

- `fast.reflector.enabled = true`.
- Profil `fast` ma luźny config: krótki warmup, `maxReflectionsPerRun: 1`, wyższy próg błędów i limit powtórzeń.

### P4.11. Skalibrować klasyfikator — ✅ wykonane

Trzeba poprawić słowniki i progi.

#### Dodać polskie warianty

- `audyt`, `audit`,
- `dokładny`, `dokladny`, `dokładna`, `dokladna`,
- `szczegółowy`, `szczegolowy`,
- `implementacja`,
- `architektura`,
- `produkcyjna`, `produkcja`,
- `usuń`, `usun`, `delete`,
- `bezpieczeństwo`, `security`,
- `sekrety`, `credentials`,
- `migracja`, `migration`.

#### Podnieść high-risk signals

Osobny regex:

```typescript
const CRITICAL_KEYWORDS = /produkc|delete|usuń|usun|migrac|security|credential|secret|deploy|activate|payment|database|baza danych/i;
```

Dla niego `+0.35` albo bezpośredni floor:

```typescript
if (criticalMatch) score = Math.max(score, 0.70)
```

#### Nie karać nadmiernie `chat`

Obecnie `phase: chat` odejmuje `0.10`. To zaniża zadania strategiczne, bo wiele z nich startuje jako chat. Lepiej:

- `chat` nie odejmuje nic,
- tylko `list` i `query` są simple phases,
- `chat` jest neutralny.

#### Architektura multi-domain powinna być deep

Jeśli:

```typescript
complex_keyword && multi_domain
```

to depth powinien mieć floor `deep`.

Jeśli:

```typescript
high_risk && complex_keyword
```

to floor `critical`.

Status wdrożenia:

- Dodano polskie i angielskie warianty dla audytu, dokładności, implementacji, architektury, produkcji, usuwania, bezpieczeństwa, credentiali, migracji i deploymentu.
- Dodano osobny `CRITICAL_KEYWORDS` z floorem `critical`.
- Dodano `ARCHITECTURE_KEYWORDS` z floorem `deep` dla zadań projektowych.
- `chat` jest neutralny; simple phases zostały ograniczone do `list` i `query`.
- `simple_keyword` jest ignorowany, jeśli w tym samym promptcie są sygnały complex/high-risk/architecture/deep.

### P4.12. Dodać testy klasyfikatora — ✅ wykonane

Minimalne przypadki:

1. `jaki status?` -> `fast`.
2. `sprawdź szybko ten plik` -> `fast` albo `standard`, zależnie od polityki.
3. `zrób dokładny audyt implementacji fazy 4` -> co najmniej `deep`.
4. `zaprojektuj architekturę integracji CRM + email + n8n` -> `deep`.
5. `zmigruj produkcyjną bazę danych` -> `critical`.
6. `deploy workflow z credentialami i aktywuj` -> `critical` albo `deep` + approval gate.
7. `porównaj trzy podejścia architektoniczne` -> `deep`.
8. feature flag off -> `deep`.

Status wdrożenia:

- Dodano `src/mastra/scripts/check-depth-controller.ts`.
- Dodano `npm run check:depth-controller`.
- Check obejmuje osiem przypadków z listy, w tym fallback `FEATURE_ADAPTIVE_DEPTH=off`.

### P4.13. Dodać testy integracji harnessa

Minimalne testy:

1. `fast` ustawia `maxSteps=10`.
2. `standard` ustawia `maxSteps=25`.
3. `deep/critical` ustawiają `maxSteps=40`.
4. `timeoutMs` z profilu jest używany, jeśli input nie podał timeoutu.
5. `contextBudgetTokens` trafia do context buildera.
6. `reflector.enabled=false` pomija `analyzeStep`.
7. upgrade depth emituje `depth_upgraded`.
8. upgrade depth powoduje second-pass albo inną realną zmianę zachowania.

---

## 8. Rekomendowana kolejność prac

### Etap 1 — domknąć fazę 2 jako realny runtime hook — ✅ ukończony

- [x] Ujednolicić ekstrakcję tool call/result payloadów.
- [x] Liczyć `success:false` jako błąd.
- [x] Dodać trigger `low_confidence`.
- [x] Dodać albo realne message injection, albo second-pass reflection.
- [x] Naprawić lub świadomie oznaczyć direct `agent.generate()` z `audit:harness`.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md` po Etapie 1.
- [x] Dodać testy reflectora.

Status po Etapie 1:

- `npx tsc --noEmit` przechodzi.
- `npm run audit:harness` przechodzi.
- `npm run check:strategy-reflector` przechodzi.
- Faza 2 ma runtime repair pass, ale nie ma jeszcze idealnego mid-loop injection.
- Etap 1 jest zamknięty w wariancie second-pass repair.

### Etap 2 — domknąć podstawowy cykl GoalContract — ✅ ukończony

- [x] `await createGoalContract`.
- [x] Zachować `goalContractId`.
- [x] Rejestrować evidence po success/failure delegacji.
- [x] Kończyć kontrakt przez `completeGoalContract`.
- [x] Dodać eventy GoalContract.
- [x] Naprawić confidence calculation.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md` po Etapie 2.

Status po Etapie 2:

- `npx tsc --noEmit` przechodzi.
- `npm run audit:harness` przechodzi.
- `npm run check:strategy-reflector` przechodzi.
- Podstawowy lifecycle GoalContract działa dla `system_delegate_task`.
- Async delegacje pozostają aktywne jako `in_progress`; domknięcie wynikiem async przechodzi do Etapu 3.

### Etap 3 — wpiąć GoalContract w harness i precontext — ✅ ukończony

- [x] Dodać `goalContractId` do `HarnessGenerateInput`.
- [x] Aktualizować evidence w `onStepFinish`.
- [x] Ładować aktywny GoalContract w `context-assembler`.
- [x] Dodać `goalContractId` do checkpointu.
- [x] Dodać `evaluateCompletion`.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md` po Etapie 3.

Status po Etapie 3:

- `npx tsc --noEmit` przechodzi.
- `npm run audit:harness` przechodzi.
- `npm run check:strategy-reflector` przechodzi.
- Harness zapisuje evidence z tool results i final output/failure do GoalContract.
- Async delegation przenosi `goalContractId` i domyka kontrakt po wyniku background.
- GoalContract jest widoczny w precontext przez `context-assembler`.
- `evaluateCompletion()` działa jako scoring/recommendation telemetry, ale nie wymusza jeszcze blocking re-plan.

### Etap 4 — dopiąć fazę 4 do realnego runtime effect — ✅ ukończony

Najpierw:

- [x] użyć `timeoutMs`,
- [x] użyć `contextBudgetTokens`,
- [x] dodać depth header do precontextu,
- [x] skalibrować klasyfikator,
- [x] dodać `npm run check:depth-controller`,
- [x] dać `fast` tani czujnik eskalacji,
- [x] zaktualizować `docs/COGNITIVE-LOOP.md` po pierwszej części Etapu 4.

Potem:

- [x] podłączyć `planning` na poziomie depth header,
- [x] dopiąć persisted plan storage dla `planning: persisted` przez GoalContract planned steps,
- [x] automatycznie tworzyć albo ładować brakujący `GoalContract` dla deep/critical harness runów,
- [x] dodać completion gate dla GoalContract jako no-tool repair pass,
- [x] podłączyć `autoDeliberation`,
- [x] podłączyć `autoReview`,
- [x] podłączyć `requireApproval`,
- [x] zrobić second-pass albo tool-envelope gate dla upgrade depth.

Status po ukończeniu Etapu 4:

- `npx tsc --noEmit` przechodzi.
- `npm run audit:harness` przechodzi.
- `npm run check:strategy-reflector` przechodzi.
- `npm run check:depth-controller` przechodzi.
- `npm run check:harness-depth` przechodzi.
- Depth profile realnie steruje timeoutem, budżetem kontekstu, depth headerem, `maxSteps`, configiem reflectora i auto-GoalContract dla deep/critical.
- `planning: persisted` ma runtime storage w GoalContract planned steps.
- Completion gate ocenia deep/critical przed finalnym outputem i może uruchomić no-tool repair pass.
- `autoDeliberation` uruchamia no-tool deliberation/re-plan pass po sygnałach reflectora.
- `autoReview` uruchamia critical-depth no-tool review pass.
- `requireApproval` działa jako final approval gate oraz twardy blok high-risk/approval-required tooli w tool envelope dla critical depth.
- Upgrade depth uruchamia kontrolowany no-tool second pass po pierwszym przebiegu.
- Krytyczne/strategiczne prompty nie powinny już spadać do `fast` tylko dlatego, że phase=`chat`.

### Etap 5 — finalizacja statusu faz 3 i 4 — ✅ ukończony

Warunki ukończenia:

- nowa delegacja tworzy GoalContract,
- wynik delegacji aktualizuje progress,
- błędne tool results trafiają do evidenceAgainst,
- kontrakt jest widoczny w precontext,
- reflector widzi progress i może triggerować re-plan,
- final response może zostać zablokowany lub skorygowany przy completion `<70%`,
- depth profile realnie steruje timeoutem, kontekstem, planowaniem i gates,
- critical profile wymusza review/approval dla działań wysokiego ryzyka,
- testy jednostkowe przechodzą,
- `npm run audit:harness` nie zgłasza nieuzasadnionych bypassów.

Status:

- Warunki domknięcia faz 3/4 są spełnione w wariancie no-tool gates + tool-envelope approval block.
- Pozostaje możliwe dalsze ulepszenie jakościowe: pełna ścieżka zewnętrznego human approval po zablokowaniu high-risk toola.

---

## 9. Definition of Done dla faz 1-4

### Faza 1 DoD

- `meta/base.md` ma planning, reflector, output self-check.
- `coding/base.md` ma planning i reflector dla coding workflow.
- `automation/base.md` ma Golden Path reflector.
- Prompt nie powoduje nadmiernego gadulstwa na prostych zadaniach.

Status: **spełnione w wystarczającym stopniu**.

### Faza 2 DoD

- `onStepFinish` analizuje każdy krok harnessa.
- Decyzja reflectora wpływa na finalny output przez no-tool repair pass.
- Idealny wariant nadal wymaga wpływu na kolejny krok modelu albo kontrolowanego soft-stop/gate.
- `reflector_triggered` i `reflector_snapshot` są logowane.
- `success:false` jest liczone jako failure.
- `low_confidence`, `tool_loop`, `high_error_rate`, `direction_instability`, `delegation_failures`, `low_progress` mają testy.
- Harness audit nie wykazuje nieintencjonalnych bypassów.

Status: **spełnione w wariancie second-pass repair**. Idealny mid-loop injection nadal byłby lepszy jakościowo, ale runtime ma realny wpływ na finalny output i depth-upgrade second pass.

### Faza 3 DoD

- Każda nietrywialna delegacja tworzy GoalContract.
- `goalContractId` jest powiązany z run/task/delegation.
- Tool results i wyniki delegacji zapisują evidence.
- Progress i confidence są aktualizowane.
- Completion jest oceniany przed finalizacją.
- Przy completion `<70%` system uruchamia re-plan albo eskalację.
- GoalContract jest dostępny w precontext/checkpoint.
- Są testy GoalTracker.

Status: **spełnione w wariancie runtime GoalContract + completion gate**. Spełnione: create/auto-ensure, `goalContractId`, evidence z delegacji i tool results, progress/confidence, completion evaluation, precontext/checkpoint link, eventy i no-tool completion repair przy niezaliczonej ocenie. Bezpośrednie użycie progressu przez StrategyReflector pozostaje możliwym ulepszeniem, ale nie blokuje domknięcia fazy.

### Faza 4 DoD

- `classifyComplexity()` ma testy dla simple, standard, deep i critical.
- Klasyfikator nie zaniża zadań architektonicznych, audytowych, migracyjnych i produkcyjnych.
- `maxSteps` pochodzi z depth profile.
- `timeoutMs` pochodzi z depth profile, jeśli caller go nie nadpisał.
- `contextBudgetTokens` steruje precontextem.
- `planning` steruje promptem/precontextem albo GoalContract.
- `goalContract` tworzy lub ładuje kontrakt dla `deep` i `critical`.
- `autoDeliberation` realnie uruchamia deliberation gate lub second-pass.
- `autoReview` realnie uruchamia review gate.
- `requireApproval` integruje się z policy/approval dla akcji wysokiego ryzyka.
- Upgrade depth powoduje realną zmianę zachowania, nie tylko event.
- Fast path ma tani failure monitor albo luźny reflector, żeby mógł eskalować.

Status: **spełnione po Etapie 4**. Runtime używa depth profile do `maxSteps`, timeoutu, budżetu kontekstu, persisted planning przez GoalContract, auto-deliberation, auto-review, approval gate, high-risk tool blocking i second-pass po upgrade depth. Pokrycie: `check:depth-controller` + `check:harness-depth`.

---

## 10. Podsumowanie końcowe

Obecna implementacja domyka pętlę poznawczą w praktycznym wariancie runtime gates.

Największa różnica między planem a kodem:

- plan zakładał mechanizm decyzyjny,
- kod dla fazy 2 daje obserwowalność i bezpieczny second-pass repair,
- kod dla fazy 3 daje operacyjny lifecycle GoalContract, harness evidence, precontext/checkpoint link, completion scoring i completion repair,
- kod dla fazy 4 daje adaptive runtime: depth profile, gates, approval block i second-pass po upgrade.

Aktualny runtime contract:

```text
PLAN z promptu
  → GoalContract w storage
  → tool results jako evidence
  → StrategyReflector porównuje evidence z planem
  → DepthController dobiera i aktualizuje runtime gates
  → no-tool repair / deliberation / review / approval gate / final self-check
```

System nie tylko wykonuje kolejne tool calle, ale regularnie sprawdza, czy nadal zmierza do celu. Największe sensowne ulepszenie po domknięciu: zewnętrzna ścieżka human approval po zablokowaniu high-risk toola.

---

## 11. Etap 6 — post-test hardening po realnym dry-run meta-agenta

> Dodano po teście dry-run z 2026-06-08. Test potwierdził bezpieczeństwo braku mutacji, ale ujawnił luki integracyjne: błędny kontrakt `automationArchitect` dla read-only audytu, niedomkniętą finalną odpowiedź meta-agenta, brak pełnej telemetrii root `meta-agent`, mylący status `agent_runs=waiting` i obcięty final output w logach.

### 6.1. Rozdzielić kontrakt `automationArchitect`: read-only analysis vs Golden Path — ✅ wykonane

- [x] Dodać klasyfikację briefu delegacji do `automationArchitect`.
- [x] Dla trybu `read_only_analysis` akceptować użyteczny raport bez `automationId`/`workflowId`.
- [x] Dla trybu `golden_path` nadal wymagać terminalnego statusu i `automationId`/`workflowId`, jeśli deploy/test się udał.
- [x] Dopasować success criteria GoalContract do trybu read-only.
- [x] Dodać regresję `npm run check:automation-delegation-contract`.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md`.

Status:

- Read-only audyt typu „audit przed deployem workflow z credentialami” jest klasyfikowany jako `read_only_analysis`.
- Prawdziwy brief typu „deploy and test workflow” pozostaje `golden_path`.
- Puste/nieużyteczne odpowiedzi read-only nadal kończą się błędem `automation_read_only_response_incomplete`.
- Check `npm run check:automation-delegation-contract` przechodzi.

### 6.2. Naprawić finalną syntezę meta-agenta — ✅ wykonane

- [x] Meta-agent nie może kończyć odpowiedzi zapowiedzią raportu bez raportu.
- [x] Final response musi zawierać sekcje: plan, delegacje, GoalContract, depth, approval gate, zablokowane działania, werdykt.
- [x] Meta-agent musi raportować `success:false` z tool result jako częściowe niepowodzenie, nie jako „oba procesy przebiegły pomyślnie”.
- [x] Dopisać prompt rule / self-check w `src/mastra/prompts/meta/base.md`.
- [x] Dopisać analogiczne reguły do `src/mastra/prompts/meta/response.md`.
- [x] Dodać regresję `npm run check:meta-final-synthesis`.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md`.

Status:

- `base.md` ma sekcję `Delegation Result Accounting`.
- `response.md` wymusza traktowanie `success:false` jako częściowego błędu.
- Prompt zakazuje kończenia odpowiedzi zapowiedzią raportu bez raportu.
- Check `npm run check:meta-final-synthesis` przechodzi.

### 6.3. Objąć root `meta-agent` pełną pętlą runtime — ✅ wykonane

- [x] Ustalić, dlaczego główny task meta-agenta nie ma własnych eventów `depth_classified`, `goal_contract_created`, `auto_review_*`, `approval_gate_*`, `reflector_snapshot`.
- [x] Upewnić się, że root meta-agent przechodzi przez ten sam harness/depth/GoalContract flow co delegacje.
- [x] Dodać walidację logów dla root taska.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md`.

Status:

- Dodano `src/mastra/services/meta-harness.ts`.
- `metaAgent.generate()` jest opakowane przez `installMetaAgentHarness()`.
- Root meta-agent dostaje depth header, depth profile, auto-GoalContract dla deep/critical, review/approval gates i harness telemetry.
- Check `npm run check:meta-harness-wrapper` przechodzi.

### 6.4. Poprawić observability runów i pełny zapis outputu — ✅ wykonane

- [x] `agent_runs` nie powinno zostawać w `waiting`, jeśli run zakończył finalną odpowiedź.
- [x] Dodać albo dopiąć `run_completed` / `run_failed`.
- [x] Zapisać pełny final output meta-agenta jako artefakt, bo `agent_events.task_completed.output` jest obcinany.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md`.

Status:

- `completeHarnessTurn()` ustawia `status: completed` i `completedAt`.
- Dodano event `run_completed` do `agent_run_events` oraz `agent_events`.
- `llm_output` jest zapisywany jako `harness_artifacts` także bez trunkacji preview.
- Check `npm run check:meta-harness-wrapper` sprawdza status runu, `run_completed` i artefakt outputu.

### 6.5. Dodać regresyjny dry-run check pętli myślowej — ✅ wykonane

- [x] Dodać check script, np. `npm run check:cognitive-loop-dry-run`.
- [x] Sprawdzać brak `automation_requests`, `automation_events` i mutujących tooli.
- [x] Sprawdzać sukces read-only delegacji `automationArchitect` i `codingAgent`.
- [x] Sprawdzać root telemetry dla meta-agenta.
- [x] Sprawdzać, że final response zawiera kompletny raport i nie zawiera niedokończonych przejść typu „przejdźmy teraz”.
- [x] Zaktualizować `docs/COGNITIVE-LOOP.md`.

Status:

- Dodano `src/mastra/scripts/check-cognitive-loop-dry-run.ts`.
- Check używa fake root meta-agenta, więc nie wykonuje realnego n8n deploy/activation ani żadnej mutacji.
- Waliduje `depth_classified`, `goal_contract_created`, `auto_review_completed`, `approval_gate_completed`, `run_completed`, `agent_runs.status=completed` i artefakt `llm_output`.
- Waliduje finalny raport i blokuje niedokończone przejścia typu „przejdźmy teraz”.
- Check `npm run check:cognitive-loop-dry-run` przechodzi.
