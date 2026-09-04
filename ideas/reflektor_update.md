# 🪞 Reflektor Update — Real In-Flight Self-Correction Loop

> **Cel:** Przekształcić obecny reflektor z mechanizmu *post-hoc* (monitoring + naprawa PO zakończeniu odpowiedzi) w **realną pętlę samokorekty w locie**, która we właściwych momentach zmienia nie tylko tekst, ale też **dobór narzędzi** — tak jak robią to najnowsze modele (Claude/GPT z interleaved reasoning).
>
> **Data startu:** 2026-06-16
> **Status:** Wszystkie 3 części rozpisane + weryfikacja końcowa wykonana (2026-06-16). **CZĘŚĆ 1 ZAIMPLEMENTOWANA (2026-06-17)** za flagą `FEATURE_REFLECTOR_PREPARE_STEP` (default ON) — `tsc --noEmit` + `check:strategy-reflector` zielone; pozostaje canary E2E (§1.9). Części 2–3 do implementacji.
> **Poprzednie dokumenty:** `pomysły/reflect_loop.md` (Fazy 1–4), `pomysły/reflect_loop_fix1-3.md`
> **Plik źródłowy rdzenia:** `src/mastra/services/generate-with-harness.ts`, `src/mastra/services/strategy-reflector.ts`, `src/mastra/services/depth-controller.ts`

---

## 0. Dlaczego ten update — diagnoza obecnego stanu

Fazy 1–4 (z `reflect_loop.md`) zbudowały solidny fundament, ale mają jedną fundamentalną lukę:

| Warstwa | Co robi dziś | Problem |
|---|---|---|
| **Reflektor promptowy** (Faza 1, `meta/coding/automation base.md`) | Model „po cichu" przechodzi 6-punktowy checklist po każdym wyniku narzędzia | Miękkie — zależy wyłącznie od posłuszeństwa modelu promptowi, brak twardego egzekwowania |
| **Reflektor runtime** (Faza 2, `strategy-reflector.ts`) | Liczy sygnały na `onStepFinish`, generuje komunikat `STOP...` | **Komunikat trafia tylko do `console.warn`** — model go NIGDY nie widzi w locie ([generate-with-harness.ts:737-745](../src/mastra/services/generate-with-harness.ts)). Komentarz w kodzie twierdzi, że injection „wymaga wsparcia frameworka (Phase 2.5)" |
| **Passy post-run** (repair + deliberation) | Po zakończeniu runa: no-tool, `maxSteps: 1` przepisanie finalnej odpowiedzi | Działa PO fakcie. Nie przerwie pętli narzędzia w trakcie, nie zmieni doboru narzędzi — tylko poprawia prozę |

**Sedno problemu:** `onStepFinish` uruchamia się PO kroku i **nie może mutować strumienia** wykonania. Cała interwencja programistyczna jest więc albo niewidoczna dla modelu (console.warn), albo po fakcie (repair pass).

### Przełom techniczny (zweryfikowany w tym repo)

Komentarz „Phase 2.5 wymaga wsparcia frameworka" jest **nieaktualny** — Mastra 1.31 to wspiera:

- **`prepareStep`** — funkcja uruchamiana **PRZED każdym krokiem**. Otrzymuje `{ steps, stepNumber, model, messages }` i może zwrócić nadpisania:
  - `model` — eskalacja na mocniejszy model na krok naprawczy
  - `toolChoice` — wymuszenie konkretnego narzędzia LUB trybu `'none'` (re-plan w tekście, bez akcji)
  - `activeTools` (`string[]`) — **zawężenie dostępnych narzędzi** (np. odebranie zapętlonego narzędzia)
  - `systemMessages` / `messages` — wstrzyknięcie refleksji do kontekstu TEGO kroku (`systemMessages` zastępuje WSZYSTKIE system messages → read+append, by nie zgubić instrukcji bazowych; brak osobnego pola `system`)
- **`stopWhen`** — custom warunek stopu (np. „3 nieudane interwencje → zatrzymaj i eskaluj do człowieka"); typ `StopCondition`, helpery count typu `stepCountIs` są z pakietu `ai`, NIE z Mastry
- **`agent.listTools()`** — zwraca pełną mapę narzędzi agenta → można zbudować allowlistę przez odjęcie

> Uwaga: kontrakt `prepareStep` to mastrowy `ProcessInputStepArgs → ProcessInputStepResult` (loop API nowego `agent.generate()`), bogatszy niż goły AI SDK `experimental_prepareStep`. Szczegóły i poprawiona sygnatura w sekcji 1.5.

To jest dokładnie mechanizm, którego brakowało. `prepareStep` zamienia reflektor z **obserwatora po fakcie** w **aktuator przed akcją**.

### Jak robią to najlepsze modele (cel jakościowy)

Claude/GPT nie mają osobnego „modelu-krytyka". Robią **interleaved reasoning**: po każdym wyniku narzędzia rozumują, czy wynik zgadza się z oczekiwaniem, i dostrajają następne wywołanie — w tym samym kontekście, ciągle, **przed** zatwierdzeniem akcji, i potrafią zmienić **samą akcję** (inne narzędzie, inne argumenty), nie tylko prozę. Cztery zasady, które chcemy osiągnąć:

1. Refleksja **inline i ciągła**, nie osobny pass.
2. **Przed** zatwierdzeniem akcji, warunkowana realną obserwacją.
3. Może zmienić **przestrzeń akcji** (narzędzia), nie tylko tekst.
4. **Adaptacyjny próg** — trywialny krok zero narzutu; zaskakująca/sprzeczna obserwacja → głębsza deliberacja.

---

## 1. Roadmap — podział na 3 części

> Projekt jest duży, więc dzielimy go na 3 niezależnie wdrażalne (i flagowalne) części. Każda przynosi wartość samodzielnie i nie blokuje poprzedniej.

| Część | Zakres | Agenci | Ryzyko |
|---|---|---|---|
| **CZĘŚĆ 1** ✅ **ZAIMPLEMENTOWANA** | **Rdzeń in-flight: `prepareStep` aktuator** w harnessie. Refleksja dociera do modelu PRZED krokiem. Pierwsze dźwignie: injekcja `system` + zawężenie `activeTools` + `toolChoice:'none'`. Refaktor reflektora na bezstanowy. Za flagą. | Agenci przez harness: meta, coding, automation, review, knowledge | 🟡 średnie |
| **CZĘŚĆ 2** ✅ rozpisana | **Inteligentniejsze wyzwalanie + głębszy re-dobór narzędzi:** trigger oparty o stagnację GoalContract zamiast licznika kroków, nowy sygnał `wrong_tool`, cooldown/histereza per-sygnał, naprawa `isFailureResult`, `stopWhen`, output scoring przed finałem. | jw. | 🟡 średnie |
| **CZĘŚĆ 3** ✅ **ZAIMPLEMENTOWANA** | **Agenci pipeline'owi:** chef/content/hunt + automation. Refleksja na **granicach faz** (nie każdy krok — żeby nie zepsuć deterministycznej ścieżki). Dedykowany reflektor pipeline'owy + per-phase `activeTools` allowlista. | chefAgent, contentAgent, huntAgent, automationArchitect | 🔴 wyższe — wymaga ostrożności z determinizmem |

**Zasada nadrzędna dla Części 3 (zapamiętać):** content/hunt/chef mają **deterministyczną ścieżkę zadaniową** (fazy z checkpointami). Reflektor NIE może jej łamać — ma działać tylko w **odpowiednich momentach** (granice faz, wykryta anomalia), nigdy jako przeszkadzający override na każdym kroku.

---

## CZĘŚĆ 1 — Rdzeń in-flight: `prepareStep` aktuator

### 1.1. Cel części

Sprawić, by starannie napisane komunikaty reflektora (te `STOP. Re-evaluate...` z `strategy-reflector.ts`) **faktycznie docierały do modelu PRZED następnym krokiem**, oraz dać harnessowi pierwsze realne dźwignie zmiany **przestrzeni akcji** (narzędzi), a nie tylko tekstu. Wszystko za flagą, w pełni odwracalne, z fallbackiem do obecnego zachowania.

**Zakres Części 1:** tylko agenci opakowani harnessem (meta, coding, automation, review, knowledge). chef/content/hunt są **świadomie poza** Częścią 1 — trafią do Części 3 z innym, pipeline'owym podejściem.

### 1.2. Nowa flaga

W `src/mastra/config/harness-flags.ts`, dodać do `HARNESS_FEATURE_FLAG_NAMES`:

```ts
'FEATURE_REFLECTOR_PREPARE_STEP',   // Część 1: in-flight prepareStep intervention
```

- **Default: `false`** na start (bezpieczeństwo — canary rollout).
- Gdy `false` → harness działa dokładnie jak dziś (`onStepFinish` monitoring + repair pass). Zero zmiany zachowania.
- Gdy `true` → dochodzi `prepareStep` aktuator.

### 1.3. Refaktor reflektora na bezstanowy (`strategy-reflector.ts`)

**Problem:** obecny `StrategyReflector` jest *inkrementalny* — akumuluje stan (`this.totalToolCalls`, `this.toolCallCounts`...) wywoływany z `onStepFinish` krok po kroku. Ale `prepareStep` dostaje **całą historię `steps` za każdym razem**. Uruchamianie obu naraz = podwójne liczenie.

**Rozwiązanie:** dodać metodę czystą (idempotentną), liczącą sygnały z pełnej tablicy `steps`:

```ts
// strategy-reflector.ts — NOWA metoda, obok istniejącej analyzeStep
evaluateHistory(steps: StepHistoryInput[]): ReflectorDecision {
  // przelicza WSZYSTKIE sygnały od zera na podstawie pełnej historii
  // (totalToolCalls, errorRate, toolCallCounts, directionChanges, ...)
  // zwraca tę samą strukturę ReflectorDecision + interventions[]
}
```

- Logika progów (warmup, maxToolRepetitions, errorRateThreshold itd.) i mapowanie na sygnały — **bez zmian merytorycznych**, tylko źródło danych to `steps[]` zamiast inkrementu.
- Istniejące `analyzeStep` (inkrementalne) **zostaje** dla trybu flag-off (telemetria w `onStepFinish`).
- Bonus: bezstanowość pozwala docelowo usunąć moduł-poziomową `Map _instances` i lifecycle `disposeReflector` — ale **NIE w Części 1** (żeby nie ruszać za dużo naraz; usunięcie zaplanować po pełnym rollout).

**Rozszerzenie `ReflectorDecision`** o opis interwencji (jakie dźwignie zastosować):

```ts
export interface ReflectorIntervention {
  injectSystem?: string;            // wstrzyknij ten system message do następnego kroku
  dropTools?: string[];             // odbierz te narzędzia (activeTools = universe - dropTools)
  forceNoTool?: boolean;            // toolChoice: 'none' na ten krok (wymuś re-plan)
  escalateModel?: boolean;          // (przygotowane, użyte szerzej w Części 2)
}
export interface ReflectorDecision {
  action: 'continue' | 'inject_reflection';
  signal?: ReflectorSignalKind;
  reason?: string;
  intervention?: ReflectorIntervention;   // NOWE
  snapshot?: ReflectorSnapshot;
}
```

### 1.4. Mapowanie sygnał → dźwignia (konserwatywne w Części 1)

W Części 1 trzymamy się **bezpiecznych, odwracalnych** dźwigni. Twardszych (eskalacja modelu, wymuszony konkretny `toolChoice`) używamy dopiero w Części 2.

| Sygnał | Dźwignia w Części 1 | Uzasadnienie |
|---|---|---|
| `tool_loop` (X wywołane ≥N razy) | `dropTools: [X]` na **2 kroki** (time-boxed) + `injectSystem` z komunikatem „znajdź inną drogę" | Model MUSI dobrać inne narzędzie — pierwszy realny re-dobór |
| `high_error_rate` | `injectSystem` (komunikat re-evaluate) + opcjonalnie `forceNoTool` na 1 krok | Wymuszony re-plan w rozumowaniu zanim znów uderzy narzędziem |
| `direction_instability` | `injectSystem` („zatwierdź jedną ścieżkę") | Miękkie — nie chcemy forsować routingu w Cz.1 |
| `delegation_failures` | `injectSystem` (istniejący komunikat) | jw. |
| `low_confidence` | `injectSystem` (istniejący komunikat) | jw. |
| `scope_creep` | `injectSystem` (istniejący komunikat) | jw. |
| `low_progress` | `injectSystem` (istniejący komunikat) | backstop |

**Headline Części 1:** sama injekcja `system` (komunikaty wreszcie docierają do modelu w locie) + `dropTools` dla `tool_loop` (pierwszy re-dobór narzędzi). To 70% wartości przy kontrolowanym ryzyku.

### 1.5. Integracja z harnessem (`callAgentGenerate`)

W `callAgentGenerate` ([generate-with-harness.ts:666](../src/mastra/services/generate-with-harness.ts)), obok istniejącego `generateOptions.onStepFinish`, dodać `generateOptions.prepareStep` — **tylko gdy flaga włączona**:

```ts
const prepareStepEnabled =
  reflectorEnabled &&
  isHarnessFeatureEnabled('FEATURE_REFLECTOR_PREPARE_STEP', false);

if (prepareStepEnabled) {
  // Enumeracja uniwersum narzędzi (raz, do budowy allowlisty)
  const toolUniverse = Object.keys(await input.agent.listTools());

  // Sygnatura args = Mastra `ProcessInputStepArgs` (NIE goły AI SDK type — patrz korekta API niżej):
  // { steps, stepNumber, systemMessages, state, model, tools, toolChoice, activeTools, messages, ... }
  generateOptions.prepareStep = async ({ steps, stepNumber, systemMessages, state }) => {
    try {
      const decision = reflector.evaluateHistory(normalizeSteps(steps));
      if (decision.action !== 'inject_reflection' || !decision.intervention) {
        return undefined;                   // brak anomalii → ZERO narzutu, model leci normalnie
      }
      // cooldown: nie wstrzykuj dwa kroki z rzędu — stan trzymamy w `state` (persist per-request)
      const lastStep = (state.lastInterventionStep as number | undefined) ?? -Infinity;
      if (stepNumber - lastStep < INTERVENTION_COOLDOWN_STEPS) return undefined;
      state.lastInterventionStep = stepNumber;
      // Rejestruj interwencję w reflektorze, by post-run passy ją widziały (patrz 1.5.1)
      reflector.recordIntervention(decision, stepNumber);

      const iv = decision.intervention;
      const result: ProcessInputStepResult = {};

      // ✅ Injekcja przez `systemMessages` (READ istniejące + APPEND nasz wpis).
      // `ProcessInputStepResult.systemMessages` ZASTĘPUJE wszystkie system messages,
      // więc MUSIMY przepisać istniejące + dodać refleksję — inaczej agent straci instrukcje bazowe.
      if (iv.injectSystem) {
        result.systemMessages = [...systemMessages, { role: 'system', content: iv.injectSystem }];
      }

      if (iv.dropTools?.length) {
        const allow = toolUniverse.filter((t) => !iv.dropTools!.includes(t));
        if (allow.length > 0) result.activeTools = allow;   // string[]; NIGDY nie zostawiaj pustej listy
      }

      if (iv.forceNoTool) result.toolChoice = 'none';

      // Telemetria każdej interwencji
      logHarnessEvent({ type: 'reflector_intervention', /* signal, stepNumber, applied levers */ });

      return result;
    } catch (err) {
      // Reflektor NIGDY nie może wywalić wykonania agenta
      console.warn('[Harness] prepareStep reflector error (non-fatal):', err);
      return undefined;
    }
  };
}
```

> ✅ **Korekta API (zweryfikowana w `@mastra/core` 1.31):** w Mastra `prepareStep` to `PrepareStepFunction` przyjmujący `ProcessInputStepArgs` i zwracający `ProcessInputStepResult` (NIE goły AI SDK `experimental_prepareStep`, który ma węższy kontrakt: tylko `model`/`toolChoice`/`experimental_activeTools`, bez `messages`/`systemMessages`). Mastrowy `ProcessInputStepResult` **nie ma pola `system`** — ma za to `systemMessages` (zastępuje WSZYSTKIE system messages) oraz `messages`/`messageList`/`activeTools` (`string[]`)/`toolChoice`/`model`. Dlatego refleksję wstrzykujemy przez **read+append `systemMessages`** (`[...systemMessages, { role:'system', content }]`) — to zachowuje instrukcje bazowe i trzyma refleksję jako prawdziwy blok systemowy (rozwiązuje wątpliwość „czy model honoruje system-message w środku konwersacji"). Cooldown trzymamy w `state` (pole `ProcessInputStepArgs.state` — persist per-request), nie w closure. **Harness woła NOWE `agent.generate()` (loop-based, `AgentExecutionOptionsBase`), nie `generateLegacy()`** — dlatego `prepareStep`/`stopWhen`/`activeTools` są honorowane.

- `normalizeSteps` — adapter z formatu Mastra `StepResult[]` na `StepHistoryInput[]` reflektora (toolName, args, result, isError, text). Analogiczny do istniejących `normalizeToolCall`/`normalizeToolResult`.

#### 1.5.1. Relacja z passami post-run (rozstrzygnięcie luki)

`prepareStep` (bezstanowy `evaluateHistory`) i istniejące passy post-run (`maybeRunReflectionRepairPass`, `maybeRunAutoDeliberationPass`) oba zależą od `getTriggeredReflections()`. Rozstrzygnięcie:

- Gdy flaga **ON**: `onStepFinish` **przestaje** wołać inkrementalne `analyzeStep` (żeby nie dublować liczenia), ale `prepareStep` **rejestruje** każdą interwencję przez nowe `reflector.recordIntervention(...)` → `getTriggeredReflections()` pozostaje wypełnione (telemetria + auto-deliberation działają jak dotąd).
- **Repair pass** (`maybeRunReflectionRepairPass`, no-tool przepisanie prozy) staje się w trybie ON **redundantny** — korekta zaszła już w locie. Dlatego przy fladze ON repair pass jest **świadomie pomijany** (warunek: jeśli były interwencje in-flight → nie uruchamiaj post-hoc repair). Auto-deliberation (deep/critical) **zostaje** — to inna funkcja (ustrukturyzowana debata), nie zwykłe przepisanie.
- Gdy flaga **OFF**: wszystko jak dziś (`analyzeStep` w `onStepFinish` + oba passy post-run).

### 1.6. Twarde zabezpieczenia (bezpieczeństwo)

1. **Flaga default OFF** — zero zmiany zachowania bez świadomego włączenia.
2. **try/catch wokół całego `prepareStep`** → na każdy błąd zwróć `{}` (no-op). Reflektor nigdy nie przerywa runa.
3. **`activeTools` time-boxed** — `dropTools` aktywne max 2 kroki, potem pełny zestaw wraca. Nigdy nie zostawiamy pustej allowlisty (deadlock guard).
4. **Cooldown** (`INTERVENTION_COOLDOWN_STEPS`, np. 2) — brak injekcji dwa kroki z rzędu; model dostaje przestrzeń na regenerację.
5. **Limit interwencji per run** — reużyć istniejący `maxReflectionsPerRun` z profilu głębokości.
6. **Brak twardych override'ów w Cz.1** — żadnego wymuszonego `toolChoice: {tool}` ani eskalacji modelu (to Część 2, po zebraniu telemetrii).
7. **Pełna telemetria** — nowy event `reflector_intervention` z: sygnał, krok, zastosowane dźwignie, lista odebranych narzędzi. Pozwala audytować, czy interwencje pomagają czy szkodzą, przed włączeniem na stałe.

### 1.7. Pliki do zmiany (Część 1)

| Plik | Zmiana |
|---|---|
| `src/mastra/config/harness-flags.ts` | + flaga `FEATURE_REFLECTOR_PREPARE_STEP` |
| `src/mastra/services/strategy-reflector.ts` | + `evaluateHistory(steps)` (bezstanowa), + typ `ReflectorIntervention`, + mapowanie sygnał→dźwignia |
| `src/mastra/services/generate-with-harness.ts` | + `generateOptions.prepareStep` w `callAgentGenerate` (za flagą), + `normalizeSteps`, gating `analyzeStep` w `onStepFinish` gdy flaga ON |
| `src/mastra/services/harness-events.ts` | + typ eventu `reflector_intervention` |
| `src/mastra/lib/agent-event-log.ts` | + rejestracja typu eventu |
| `src/mastra/scripts/check-strategy-reflector.ts` | + przypadki testowe dla `evaluateHistory` i mapowania dźwigni |
| `src/mastra/scripts/e2e-reflector-prepare-step.ts` (NOWY) | deterministyczny E2E: real `agent.generate()` + mock model → Mastra honoruje `prepareStep`/`activeTools`; `npm run e2e:reflector-prepare-step` |

### 1.8. Kryteria akceptacji (Część 1)

- [x] `tsc --noEmit` przechodzi.
- [x] Flaga OFF → zachowanie identyczne jak dziś (`prepareStep` dodawany tylko gdy `prepareStepEnabled`; `analyzeStep` wraca do `onStepFinish` gdy flaga OFF).
- [x] Flaga ON, scenariusz `tool_loop` → `evaluateHistory` zwraca `intervention.dropTools=[loopTool]` + `injectSystem` (unit test `check:strategy-reflector`); `prepareStep` buduje zawężone `activeTools` + loguje `reflector_intervention`.
- [x] Flaga ON, scenariusz `high_error_rate` → `intervention.forceNoTool=true` + `injectSystem`; `prepareStep` wstrzykuje refleksję przez read+append `systemMessages` (unit test).
- [x] `dropTools` nigdy nie tworzy pustej allowlisty (guard `allow.length > 0`); cooldown (`INTERVENTION_COOLDOWN_STEPS=2`) przywraca pełny zestaw narzędzi.
- [x] Błąd wewnątrz `prepareStep` nie przerywa runa (try/catch → `return undefined`).
- [x] Brak podwójnego liczenia sygnałów (gdy flaga ON, `analyzeStep` nie jest wołane w `onStepFinish` — gating `!prepareStepEnabled`).
- [x] **Deterministyczny E2E** (`npm run e2e:reflector-prepare-step`): realny loop `agent.generate()` z mockowym modelem zapętlającym narzędzie → Mastra WOŁA nasz `prepareStep` i HONORUJE override `activeTools` (4. krok dostaje tylko `escape_tool`, `loop_tool` usunięty), interwencja `tool_loop` zarejestrowana (injectSystem+dropTools), run kończy się `finishReason:stop`.
  - 🐞 **Bug złapany przez E2E:** wewnątrz `prepareStep` `StepResult.toolCalls/toolResults/content` są PUSTE — realny zapis narzędzi jest w `step.response.messages[]` (części `tool-call`/`tool-result`). Pierwotne `normalizeSteps` czytało puste pola → loop NIGDY by się nie wykrył przy fladze ON. Naprawione: `normalizeSteps` czyta `response.messages` z dedupem po `toolCallId` (fallback na top-level `toolCalls` zachowany).
- [ ] Canary LIVE (§1.9): realny run meta-agenta na prawdziwym LLM z flagą ON → telemetria `reflector_intervention` w Mongo na żywym ruchu (krok operacyjny, nie blokuje implementacji).

### 1.9. Plan rolloutu (Część 1)

1. Implementacja za flagą OFF → merge (zero ryzyka produkcyjnego).
2. Włączyć flagę lokalnie/dev → przepuścić scenariusze testowe z `check-strategy-reflector.ts`.
3. Canary: włączyć flagę **tylko dla meta-agenta** (orchestrator — największy zwrot, bo kaskaduje) na realnych zadaniach.
4. Analiza telemetrii `reflector_intervention`: czy interwencje korelują z lepszymi wynikami? Czy nie ma fałszywych `tool_loop`/`high_error_rate` (uwaga na słaby `isFailureResult` — naprawa w Części 2)?
5. Jeśli OK → rozszerzyć flagę na coding/automation/review/knowledge.
6. Po stabilnym okresie → rozważyć default ON.

### 1.10. Znane ograniczenia Części 1 (świadomie przeniesione dalej)

- Wyzwalanie wciąż oparte o **liczniki** (kroki/powtórzenia), nie o realny postęp celu → **Część 2** (trigger oparty o stagnację GoalContract).
- Brak sygnału `wrong_tool` (narzędzie „sukces" ale nieadekwatne) → **Część 2**.
- `isFailureResult` (heurystyka stringowa) daje fałszywe trafienia → naprawa w **Część 2**.
- chef/content/hunt nieobjęte → **Część 3** (podejście pipeline'owe, granice faz).
- Brak `stopWhen` (poddanie się i eskalacja do człowieka) → **Część 2**.

---

## CZĘŚĆ 2 — Inteligentniejsze wyzwalanie + głębszy re-dobór narzędzi

### 2.0. Cel części

Część 1 dała **aktuator** (`prepareStep`) i pierwsze miękkie dźwignie. Część 2 odpowiada na pytanie **„KIEDY i JAK MOCNO interweniować"** tak, jak robią to najlepsze modele: refleksja wyzwalana **zaskoczeniem/stagnacją celu** (a nie licznikiem kroków), z dostępem do twardszych dźwigni (eskalacja modelu, wymuszony dobór narzędzia), oraz świadomością, **kiedy się poddać** (`stopWhen` → eskalacja do człowieka) i **czy finalna odpowiedź w ogóle spełnia cel** (output scoring).

Wszystko za osobnymi flagami, każda niezależnie włączalna po zebraniu telemetrii z Części 1.

### 2.1. Wyzwalanie oparte o postęp celu, nie o licznik (surprise-triggered)

**Problem z Cz.1:** triggery wciąż oparte o liczniki (`maxStepsWithoutProgress: 20`, `maxToolRepetitions`). To prymitywny proxy — najlepszy moment na refleksję to **gdy obserwacja przeczy oczekiwaniu / cel nie posuwa się do przodu**, a nie sztywny numer kroku.

**Rozwiązanie:** podpiąć GoalContract (`goal-tracker.ts`) jako źródło sygnału. Mamy już:
- `currentProgress` (0.0–1.0), `confidenceLevel`, `evidenceFor[]`/`evidenceAgainst[]`,
- `evaluateCompletion()` → zwraca akcję `replan`/`escalate`/`done` + progress + confidence,
- ewidencja aktualizowana w trakcie runa przez `recordHarnessToolGoalEvidence` ([generate-with-harness.ts:972](../src/mastra/services/generate-with-harness.ts)).

Nowy sygnał **`progress_stall`**: postęp celu nie drgnął (`Δ currentProgress ≈ 0`) przez K kroków **mimo** udanych wywołań narzędzi → znak, że agent „kręci się" produktywnie wyglądającymi, ale bezowocnymi akcjami.

> ⚠️ **Zależność/limit do uwzględnienia:** obecnie ewidencja jest gruboziarnista — `recordHarnessToolGoalEvidence` zawsze loguje pod `stepId: 'step-2'` ([:984](../src/mastra/services/generate-with-harness.ts)), więc `currentProgress` może nie rosnąć płynnie per narzędzie. **Część 2 musi najpierw poprawić granularność ewidencji** (mapować evidence na realne `plannedSteps`, albo wyliczać proxy-postęp z proporcji `evidenceFor`/`evidenceAgainst`), inaczej `progress_stall` będzie zaszumiony. To pierwsze zadanie tej części.

Liczniki kroków **zostają jako backstop** (najwyższy próg), ale `progress_stall` + sygnały sprzeczności stają się głównymi triggerami.

### 2.2. Nowy sygnał `wrong_tool` (narzędzie „sukces", ale nieadekwatne)

To bezpośrednio adresuje obawę usera: agent może **za pierwszym razem źle dobrać narzędzie** — wywołanie się powiedzie (brak błędu), ale nie przybliża celu. Tego obecny reflektor w ogóle nie wykrywa (liczy tylko błędy i pętle).

Heurystyki detekcji (kombinacja, nie pojedyncza):
1. **Pusty/trywialny wynik** — narzędzie zwraca pustą tablicę, `0 results`, `null`, lub bardzo krótki wynik względem oczekiwania.
2. **Postęp celu nie drgnął** mimo `success: true` (powiązane z `progress_stall`).
3. **Low-confidence w tekście tuż po udanym narzędziu** (reużycie `LOW_CONFIDENCE_PATTERNS`).
4. **Powtórzenie udanego narzędzia z rosnącymi argumentami** (model „dopycha" złe narzędzie zamiast zmienić podejście) — odróżnić od `tool_loop` (ten liczy też błędy).

Dźwignia dla `wrong_tool`: `injectSystem` nazywający lepszych kandydatów + opcjonalnie `dropTools: [nieadekwatne]` (jak w Cz.1). To realny **re-dobór narzędzi w nowym podejściu**, nie tylko tekst.

### 2.3. Naprawa `isFailureResult` (redukcja fałszywych triggerów)

`isFailureResult` w `strategy-reflector.ts` ([:457](../src/mastra/services/strategy-reflector.ts)) używa szerokiego dopasowania stringów: `compact.includes('failed')`, `'error:'`, `'"status":"error"'`. To daje **fałszywe trafienia** — wynik, który tylko *wspomina* słowo („failedSteps: 0", „no errors", „error handling works") zawyża `errorRate` → zbędne interwencje. To realne ryzyko przy włączaniu twardszych dźwigni.

Naprawa:
- Priorytet dla **sygnałów strukturalnych**: flaga `isError` z frameworka + pola obiektu (`success === false`, `status === 'error'`, `error != null`).
- Dopasowanie stringów **tylko** dla małych, JSON-podobnych wyników; usunąć gołe `.includes('failed')`/`'error:'` na wolnym tekście.
- Ujednolicić z istniejącym `isGoalFailureResult` (osobna, prawie-duplikat funkcja w `generate-with-harness.ts` [:978](../src/mastra/services/generate-with-harness.ts)) → wspólny helper, jedna definicja prawdy.

### 2.4. Cooldown/histereza per-sygnał (zamiast globalnego limitu)

**Problem:** Cz.1 reużywa `maxReflectionsPerRun` (globalny limit) — jedna interwencja `tool_loop` może „zużyć" budżet i zablokować późniejszą, ważniejszą `high_error_rate`.

**Rozwiązanie:** osobny cooldown per typ sygnału. Każdy sygnał ma własny licznik „ostatni krok interwencji" i minimalny odstęp. Dzięki temu:
- różne problemy mogą być adresowane niezależnie,
- ten sam problem nie jest „młócony" co krok (histereza — po interwencji daj modelowi 2–3 kroki na regenerację, dopiero potem re-trigger tego samego sygnału).

### 2.5. Twardsze dźwignie (po walidacji telemetrii z Cz.1)

Rozszerzyć `ReflectorIntervention` (z Cz.1) o dźwignie, których w Cz.1 świadomie nie użyliśmy:

| Dźwignia | Mechanizm `prepareStep` | Kiedy |
|---|---|---|
| `escalateModel: true` | nadpisanie `model` na mocniejszy na **jeden** krok naprawczy | utknięcie nieodwracalne / `progress_stall` przy wysokim ryzyku |
| `forceTool: { toolName }` | `toolChoice: { type: 'tool', toolName }` | **wysoka pewność** — np. po powtarzalnej porażce wymuś `system_request_approval` albo delegację do `deliberationAgent` |
| `restrictTools: [...]` | `activeTools` = kuratorowany podzbiór naprawczy | gdy wiadomo, która rodzina narzędzi jest właściwa |

Zasada bezpieczeństwa (utrzymana z Cz.1): **preferuj miękkie nad twarde**; `forceTool`/`escalateModel` tylko przy wysokiej pewności (np. ten sam tool+args ≥4× lub `evaluateCompletion → escalate`). Wszystkie time-boxed, z telemetrią.

### 2.6. `stopWhen` — wiedzieć kiedy się poddać i eskalować

Dziś agent dopala do `maxSteps` nawet gdy utknął. Dodać custom `stopWhen` (Mastra/AI SDK: `StopCondition = ({ steps }) => boolean | Promise<boolean>`, może być tablicą — semantyka OR: zatrzymaj, gdy KTÓRYKOLWIEK warunek prawdziwy):

```ts
generateOptions.stopWhen = async ({ steps }) => {
  // poddaj się, gdy: N interwencji bez poprawy LUB evaluateCompletion → 'escalate'
  return reflector.isUnrecoverable(normalizeSteps(steps));
};
```

> ⚠️ **Korekta #1 (helper count NIE z Mastra):** `stepCountIs`/`hasToolCall`/`isLoopFinished` NIE są eksportowane przez `@mastra/core` — pochodzą z pakietu `ai` (AI SDK).
>
> ⚠️ **Korekta #2 (WAŻNE — `maxSteps` vs `stopWhen` są wzajemnie wykluczające się w Mastra 1.32):** wbrew pierwotnemu planowi (`maxSteps` zostaje jako backstop, `stopWhen` to tylko predykat) — w `chunk-DDFT2H3T.js:20464-20468` Mastra robi `if (maxSteps && typeof maxSteps==='number') stopWhenToUse = stepCountIs(maxSteps); else stopWhenToUse = stopWhen;`. Czyli **gdy przekażesz liczbowy `maxSteps`, Twój `stopWhen` jest IGNOROWANY**. Rozwiązanie wdrożone w harnessie: gdy `FEATURE_REFLECTOR_STOP_WHEN` jest ON, **usuwamy `maxSteps`** i przekazujemy `stopWhen` jako **tablicę OR**: `[stepCountIs(stepCeiling), isUnrecoverablePredicate]` (`stepCeiling` = poprzedni `maxSteps` z profilu). Dzięki temu zachowujemy ZARÓWNO backstop liczby kroków, JAK I predykat nieodwracalności. `stepCountIs` importowany z `ai`. Potwierdzone E2E (`e2e:reflector-stop-when`): stop po 12/20 krokach. `isUnrecoverable(steps)` jest bezstanowe (liczy z pełnej historii — spójnie z `evaluateHistory`).

Po zatrzymaniu przez `stopWhen` → harness kończy run z jasnym komunikatem blokera (zamiast pozornego sukcesu) i — jeśli to meta/delegacja — eskaluje do człowieka (powiązanie z istniejącym `system_request_approval`/checkpointami). To realizuje „know when to escalate" z najlepszych systemów.

### 2.7. Output Scoring przed finałem — natywny `isTaskComplete` (zamiast własnej hydrauliki)

W `reflect_loop.md` węzeł `OUTPUT SCORE → czy odpowiedź spełnia kryteria?` był oznaczony 🟡/❌. Część 2 go domyka.

> ✅ **Decyzja po weryfikacji (Mastra 1.32.1):** zamiast budować własną pętlę „self-score → jeśli źle, sklej prompt naprawczy → odpal repair pass", użyjemy **natywnego `isTaskComplete`** (`agent.types.d.ts:482`, typ `CompletionConfig` z `loop/network/validation.d.ts:88`). Robi dokładnie tę pętlę za nas, ale lepiej zaimplementowaną.

**Czym jest `isTaskComplete`:** opcja `agent.generate()`/`stream()` (supervisor pattern). Po każdej iteracji odpala scorery; gdy nie przechodzą, **automatycznie dokleja feedback do message list** (model widzi *dlaczego* niedokończone i poprawia) i iteruje aż `isComplete` albo do `maxIterations`. Kształt:

```ts
// WDROŻONE (src/mastra/services/generate-with-harness.ts, za FEATURE_OUTPUT_SCORING):
generateOptions.isTaskComplete = {
  scorers: [createGoalCompletionScorer(goalContractId)], // factory: createScorer z @mastra/core/evals, contractId w closure
  strategy: 'all',                 // 'all' = wszystkie muszą przejść | 'any' = wystarczy jeden
  onComplete: (r) => logHarnessEvent({ type: 'output_score', complete: r.complete, completionReason: r.completionReason }),
};
```

> ⚠️ **Korekta (Mastra 1.32 — brak `maxIterations` w `CompletionConfig`):** pierwotny szkic zakładał pole `maxIterations: 5` wewnątrz `isTaskComplete`. W rzeczywistości `CompletionConfig` (`loop/network/validation.d.ts:88`) ma TYLKO `scorers`/`strategy`/`timeout`/`parallel`/`onComplete`/`suppressFeedback` — **nie ma `maxIterations`**. Pętlę re-iteracji ogranicza istniejący `maxSteps` / step ceiling z `stopWhen` (§2.6), więc dodatkowy sufit nie jest potrzebny. `onComplete` dostaje `CompletionRunResult` (`complete`/`completionReason`/`scorers`), nie `isComplete`. Plik scorera: `src/mastra/scorers/goal-completion-scorer.ts` (konwencja katalogu `scorers/`, nie `services/`).

**Co piszemy sami (a co dowozi framework):**
- **My:** definicja `goalContractScorer` przez `createScorer` — opakowuje `evaluateCompletion()` z GoalContract (progress/confidence/`evidenceAgainst`) w wynik 0/1. To samo „co znaczy gotowe", które i tak musielibyśmy zdefiniować. Wzorzec już mamy w `deliberation-scorer.ts`.
- **Framework:** pętla iterowania, automatyczne wstrzykiwanie feedbacku, `strategy`/`maxIterations`/`onComplete`. Tej hydrauliki NIE piszemy — to redukuje ryzyko i kod względem pierwotnego planu (ręczny `maybeRunReflectionRepairPass` z budowaniem promptu).

**`maxIterations: 5`** — świadomie wyższe niż minimalne 1–2. To górny limit; `isTaskComplete` re-iteruje CAŁEGO agenta, a agenci harnessowi mają `maxSteps` cap 10–40, więc worst-case to 5× run. W praktyce pętla kończy się gdy scorer przejdzie. **Dostroić per profil głębokości** (fast: 2–3, deep/critical: 5), żeby nie mnożyć kosztu na trywialnych zadaniach.

**Zakres (potwierdzony przeglądem ścieżek wywołań):**
- ✅ **Agenci przez harness** (coding, automation, knowledge, meta) — wpinamy w `generateOptions` harnessu za flagą `FEATURE_OUTPUT_SCORING`. To główny zakres.
- ⚠️ **Agenci przez goły `agent.generate`** (marketing, sales, analytics, crm, researcher, deliberation — gałąź „All other agents" `delegate-task.ts:482`) — NIE automatycznie; wymaga ręcznego dodania `isTaskComplete` do tej gałęzi. Opcjonalne rozszerzenie (dostają GoalContract, więc ten sam scorer pasuje), ale poza minimalnym zakresem Cz.2.
- ❌ **Pipeline (chef/content/hunt)** — celowo poza (własne kryteria per faza, §3.9). Bez zmian.

**Do potwierdzenia w PoC:** czy `isTaskComplete` działa identycznie na gołym `agent.generate` jak w network/supervisor loop (typ jest na opcjach generate → powinno; zweryfikować zachowanie + że re-iteracja respektuje `maxSteps` i memory thread).

### 2.8. Nowe flagi (Część 2)

```ts
'FEATURE_REFLECTOR_GOAL_TRIGGERS',   // progress_stall + wrong_tool oparte o GoalContract
'FEATURE_REFLECTOR_HARD_LEVERS',     // escalateModel / forceTool / restrictTools
'FEATURE_REFLECTOR_STOP_WHEN',       // custom stopWhen → wczesna eskalacja
'FEATURE_OUTPUT_SCORING',            // natywny isTaskComplete (GoalContract scorer) na agentach harnessowych
```

Wszystkie default **OFF**. `isFailureResult` fix + cooldown per-sygnał + granularność ewidencji to poprawki jakościowe **bez flagi** (czysty zysk, nie zmieniają kontraktu) — ale warto je wdrożyć i przetestować przed włączeniem `FEATURE_REFLECTOR_GOAL_TRIGGERS`.

### 2.9. Pliki do zmiany (Część 2)

| Plik | Zmiana |
|---|---|
| `src/mastra/config/harness-flags.ts` | + 4 flagi z 2.8 |
| `src/mastra/services/strategy-reflector.ts` | + sygnał `progress_stall`, `wrong_tool`; naprawa `isFailureResult`; cooldown per-sygnał; `isUnrecoverable(steps)` (bezstanowe); rozszerzenie `ReflectorIntervention` o `escalateModel`/`forceTool`/`restrictTools` |
| `src/mastra/services/goal-tracker.ts` | granularność ewidencji (mapowanie na `plannedSteps` zamiast hardcoded `step-2`) + ewent. proxy-progress |
| `src/mastra/services/generate-with-harness.ts` | podpięcie progress-deltą do reflektora; `stopWhen`; twarde dźwignie w `prepareStep`; **`isTaskComplete` (natywny output scoring)** za flagą; ujednolicenie `isGoalFailureResult`↔`isFailureResult` |
| `src/mastra/scorers/goal-completion-scorer.ts` (NOWY — katalog `scorers/`, nie `services/`) | factory `createGoalCompletionScorer(goalContractId)`: `createScorer` opakowujący `evaluateCompletion()` (GoalContract → 0/1, fail-open na błędzie) — wpinany jako `isTaskComplete.scorers` |
| `src/mastra/services/harness-events.ts` + `lib/agent-event-log.ts` | + eventy `reflector_stop_when`, `output_score` (dla `progress_stall` używamy generycznego `reflector_intervention` z polem `signal`, bez osobnego typu) |
| `src/mastra/scripts/check-strategy-reflector.ts` | testy §2.1–2.6: isFailureResult, cooldown per-sygnał, wrong_tool, progress_stall, hard levers, isUnrecoverable |
| `src/mastra/scripts/check-goal-completion-scorer.ts` (NOWY) | test jednostkowy scorera §2.7 (incomplete→0, complete→1; Mongo-gated) |
| `src/mastra/scripts/e2e-reflector-stop-when.ts` (NOWY) | E2E §2.6: realny `agent.generate` honoruje `stopWhen` (tablica OR), wczesny stop |
| `src/mastra/scripts/e2e-reflector-output-scoring.ts` (NOWY) | E2E §2.7: realny `agent.generate` re-iteruje przez `isTaskComplete`, finalizuje gdy scorer→1 |

### 2.10. Kryteria akceptacji (Część 2)

- [x] `tsc --noEmit` przechodzi; flagi domyślnie ON (override planu) → walidowane E2E.
- [x] `isFailureResult` nie klasyfikuje jako błąd wyników typu „failedSteps: 0", „no errors", „error handling" (testy jednostkowe §2.3).
- [x] `progress_stall`: scenariusz z udanymi narzędziami i zerowym Δprogress przez K kroków → trigger; scenariusz z rosnącym progress → brak triggera.
- [x] `wrong_tool`: udane narzędzie + pusty wynik + low-confidence → trigger + `injectSystem` z kandydatami.
- [x] Cooldown per-sygnał: dwa różne sygnały mogą interweniować w tym samym runie; ten sam sygnał respektuje histerezę.
- [x] `FEATURE_REFLECTOR_HARD_LEVERS` ON: scenariusz wysokiej pewności → `forceTool`/`escalateModel` widoczne w `prepareStep`; przy niskiej pewności — tylko miękkie.
- [x] `stopWhen`: scenariusz nieodwracalny → run kończy się wcześnie z komunikatem blokera, NIE dopala do maxSteps. (E2E `e2e:reflector-stop-when`: stop po 12/20 krokach.)
- [x] `FEATURE_OUTPUT_SCORING` ON: odpowiedź poniżej progu kryteriów → `isTaskComplete` re-iteruje z auto-feedbackiem; powyżej → zwrot bez dodatkowej iteracji. Event `output_score` z `onComplete`. (E2E `e2e:reflector-output-scoring`: 2 wywołania modelu, `onComplete` → `complete:true`.) **Korekta:** `CompletionConfig` w Mastra 1.32 NIE ma pola `maxIterations` — pętlę ogranicza istniejący `maxSteps`/stopWhen step ceiling, nie pole scorera.
- [x] `goalContractScorer` (`createScorer`) zwraca 1 dla spełnionych `successCriteria`, 0 gdy `evidenceAgainst`/niski progress — test jednostkowy bez odpalania pełnego agenta. (`check:goal-completion-scorer`: incomplete→0, complete→1; Mongo-gated skip.)

### 2.11. Rollout (Część 2)

1. Najpierw poprawki bez flagi: `isFailureResult` + cooldown per-sygnał + granularność ewidencji → merge, obserwacja telemetrii (mniej fałszywych triggerów z Cz.1).
2. `FEATURE_REFLECTOR_GOAL_TRIGGERS` na meta-agencie → walidacja `progress_stall`/`wrong_tool`.
3. `FEATURE_OUTPUT_SCORING` (natywny `isTaskComplete`) → najpierw `maxIterations` niskie (2) na meta, walidacja że re-iteracja odpala się tylko gdy trzeba (nie spowalnia dobrych odpowiedzi); potem podnieść do 5 per profil.
4. `FEATURE_REFLECTOR_STOP_WHEN` → walidacja wczesnej eskalacji.
5. `FEATURE_REFLECTOR_HARD_LEVERS` **na końcu** (najbardziej inwazyjne) → wąski canary, ścisła obserwacja czy nie „walczy z modelem".

### 2.12. Znane ograniczenia Części 2 (przeniesione do Cz.3)

- Wszystko powyżej dotyczy agentów przez harness. chef/content/hunt nadal nieobjęte (osobne, pipeline'owe podejście) → **Część 3**.
- Output scoring używa GoalContract — agenci pipeline'owi mają własne kryteria per faza, co wymaga innego modelu scoringu → **Część 3**.

---

## CZĘŚĆ 3 — Agenci pipeline'owi (chef / content / hunt + automation)

### 3.0. Cel części i zasada nadrzędna

Objąć refleksją agentów z najdłuższymi ścieżkami i największą liczbą narzędzi — **dokładnie tych, których obawa usera dotyczy** (mogą za pierwszym razem źle dobrać narzędzie). ALE: chef/content/hunt mają **deterministyczną ścieżkę zadaniową** (maszyny stanów z checkpointami). 

> 🔴 **ZASADA NADRZĘDNA:** refleksja ma **wzmocnić** pipeline, nie **złamać** go. Działa wyłącznie w **odpowiednich momentach** (granice faz, wykryta anomalia w obrębie fazy), NIGDY jako override na każdym kroku. Domyślnie fail-open: każda wątpliwość → nie ingeruj, pozwól pipeline'owi działać.

### 3.1. Kluczowe odkrycie — granice faz są deterministycznie wykrywalne

Wszystkie trzy agenty mają **jawne maszyny stanów** z narzędziem ustawiającym status na każdej tranzycji (persystowane do DB → resumable + auditable):

| Agent | Narzędzie statusu | Stany |
|---|---|---|
| chef | `chef_set_project_status` | intake → recon → profile_synthesis → **checkpoint_profile** → menu_draft → critic_gate → **checkpoint_menu** → recipes → qa_final → render → done |
| content | `content_set_project_status` | intake → research → strategy → **checkpoint_strategy** → draft → critique → art_direction → assemble → **checkpoint_review** → ship → done |
| hunt | `hunt_set_run_status` | intake → discover → score → enrich → extract_email → draft → assemble → **checkpoint_review** → ship → done |

**To jest fundament Części 3:** nie musimy zgadywać granic faz — agent sam je **ogłasza** wywołaniem `*_set_*_status`. „Właściwy moment" na refleksję = wywołanie tego narzędzia (tranzycja faz). Bieżącą fazę odczytujemy w `prepareStep` skanując `steps` wstecz po ostatnim wywołaniu `*_set_*_status` i jego argumencie.

Dodatkowo: chef ma już `critic_gate`, content `critique` — **wbudowane krytyki**. Część 3 je **uzupełnia**, nie duplikuje.

### 3.2. Problem architektoniczny — nie wolno użyć harness depth

chef/content/hunt **nie idą przez harness** — są wołane gołym `agent.generate` w gałęzi „All other agents" ([delegate-task.ts:482](../src/mastra/tools/system/delegate-task.ts)), z `maxSteps: 150`. **Nie wolno ich naiwnie owinąć `generateWithHarness`**, bo depth controller capuje `maxSteps ≤ 40` ([depth-controller.ts](../src/mastra/services/depth-controller.ts)) → rozbiłby 150-krokowy pipeline.

**Rozwiązanie:** dedykowany, lekki wrapper `generatePipelineWithReflection` — NIE pełny harness. Wstrzykuje tylko `prepareStep` + `onStepFinish` (telemetria) wokół `agent.generate`, **bez** depth controllera, bez capowania kroków, bez GoalContract. Wołany z `delegate-task.ts` zamiast gołego `agent.generate` dla chef/content/hunt.

### 3.3. Dwie warstwy (obie konserwatywne)

#### Warstwa A — Prompt-level phase-exit check (tanie, bezpieczne, bez flagi)

Dodać do promptów chef/content/hunt (`*/pipeline.md`) krótką sekcję **kryteriów wyjścia z fazy** — refleksja TYLKO na granicy, nie co krok:

```markdown
## Phase-Exit Check (before each `*_set_*_status` transition)

Before transitioning to the next state, silently verify:
1. Did this phase produce the evidence/artifact it was responsible for?
2. Did any tool return empty/irrelevant output that I'm about to ignore?
3. Did I use the tools appropriate for THIS phase (not a wrong first pick)?
If a phase's exit criteria aren't met → stay in the phase and fix it before transitioning.
Do NOT output this checklist. This is the ONLY reflection point — do not reflect every step.
```

To wzorzec Fazy 1 (jak meta/coding), ale **pipeline-aware** (granice faz, nie każde narzędzie). 60% wartości przy zerowym ryzyku dla determinizmu. Obecnie chef/content/hunt **nie mają żadnej** sekcji reflektora.

#### Warstwa B — Programmatic pipeline reflector (za flagą, fail-open)

`prepareStep` z konfiguracją **pipeline-tuned** w `strategy-reflector.ts`. Względem profili z Cz.1/2 — drastycznie zawężone, by nie ingerować w długi, deterministyczny bieg:

| Sygnał | W pipeline'ie? | Uzasadnienie |
|---|---|---|
| `tool_loop` | ✅ tak | to samo narzędzie błądzi wielokrotnie = realny problem |
| `high_error_rate` (w obrębie fazy) | ✅ tak, liczone **per faza** (reset na tranzycji) | błędy kumulują się w fazie, nie globalnie przez 150 kroków |
| `wrong_tool` (per faza) | ✅ tak — **główny sygnał** | bezpośrednio adresuje „źle dobrać narzędzie"; patrz allowlista 3.4 |
| `low_progress` / step-count | ❌ **WYŁĄCZONE** | 150 kroków to norma, nie anomalia |
| `direction_instability` | ❌ **WYŁĄCZONE** | kierunek narzuca maszyna stanów, nie model |
| `scope_creep` | ❌ wyłączone | zakres zdefiniowany przez fazy |

Dźwignie: tylko **miękkie** (`injectSystem` z nazwaniem właściwych narzędzi dla fazy) + `dropTools` dla `tool_loop`. **Bez** `forceTool`/`escalateModel`/`stopWhen` dla pipeline'ów (zbyt inwazyjne wobec determinizmu — pipeline ma własne checkpointy i krytyki do zatrzymań).

### 3.4. Per-phase `activeTools` allowlista — najsilniejsza dźwignia (za flagą)

To jest **najmocniejsze i najbardziej naturalne** narzędzie dla deterministycznych pipeline'ów: zamiast wykrywać zły dobór narzędzia PO fakcie, **zapobiegaj** mu — w danej fazie udostępnij tylko narzędzia tej fazy. Mapa faza→narzędzia (przykład dla chefa):

| Faza | Dozwolone narzędzia (superset, permissive) |
|---|---|
| recon | `chefImportWebsiteProfileTool`, `reviewsGooglePlaceTool`, `chefQueryKnowledgeTool`, `chefSearchRecipeLibraryTool` + status/doc |
| menu_draft | `chefGenerateMenuTool`, `chefSuggestPairingTool`, `chefCheckSeasonalTool`, `chefSearchRecipeLibraryTool` + status/doc |
| recipes | `chefDraftRecipeTool`, `chefGetRecipeTool`, `chefQueryKnowledgeTool` + status/doc |
| render | `chefDocumentRenderTool`, `chefDocumentPdfTool`, `chefExportMenuBookTool` + status |

Twarde zasady bezpieczeństwa (determinizm > wszystko):
1. **Fail-open:** nieznana faza / brak mapy / pusta allowlista → **pełny zestaw narzędzi** (nigdy nie blokuj).
2. **Permissive supersets:** allowlisty zawierają zapas (narzędzia statusu, dokumentu, knowledge **zawsze** dostępne we wszystkich fazach), by nie zablokować legalnego użycia.
3. **Narzędzia tranzycji zawsze dostępne** — `*_set_*_status`, `*_get_*` w każdej fazie (inaczej agent nie wyjdzie z fazy).
4. **Za osobną flagą** `FEATURE_PIPELINE_PHASE_TOOLS`, walidowane per agent osobno na realnych biegach E2E.
5. **Telemetria** — log każdego zawężenia per faza, by zobaczyć czy nie blokujemy nic legalnego, zanim włączymy na stałe.

### 3.5. Automation Architect — lżejszy przypadek

`automationArchitect` już ma reflektor promptowy (Faza 1) i **idzie przez harness** (`automation-harness`, `automation/base.md`). Dla niego Część 3 to:
- Korzysta automatycznie z `prepareStep` z Cz.1/2 (jest agentem harness).
- Dodać per-phase `activeTools` allowlistę dla faz Golden Path (discover → compose → validate → deploy → test → repair → activate) — analogicznie do 3.4, mapa faza→narzędzia Golden Path.
- Wzorzec validate→repair→re-validate już częściowo istnieje; per-phase tools go wzmacnia (np. w fazie `validate` tylko narzędzia walidacji, nie deploy).

Nie wymaga wrappera (już ma harness), więc to głównie rozszerzenie mapy faz.

### 3.6. Pliki do zmiany (Część 3)

| Plik | Zmiana |
|---|---|
| `src/mastra/prompts/chef/pipeline.md`, `content/pipeline.md`, `hunt/pipeline.md` | + sekcja „Phase-Exit Check" (Warstwa A, bez flagi) |
| `src/mastra/services/generate-pipeline-with-reflection.ts` (NOWY) | lekki wrapper: `prepareStep` + `onStepFinish` wokół `agent.generate`, BEZ depth controllera/capowania |
| `src/mastra/tools/system/delegate-task.ts` | routować chef/content/hunt przez wrapper zamiast gołego `agent.generate` ([:482](../src/mastra/tools/system/delegate-task.ts)) — za flagą |
| `src/mastra/services/strategy-reflector.ts` | + tryb/config `pipeline` (wyłączone low_progress/direction/scope; per-faza error rate; reset na tranzycji); wykrywanie bieżącej fazy z `steps` |
| `src/mastra/config/pipeline-phase-tools.ts` (NOWY) | mapy faza→narzędzia dla chef/content/hunt/automation |
| `src/mastra/services/automation-harness.ts` lub depth-controller | podpięcie per-phase allowlisty Golden Path dla automation |
| `src/mastra/config/harness-flags.ts` | + `FEATURE_PIPELINE_REFLECTOR`, `FEATURE_PIPELINE_PHASE_TOOLS` |
| `src/mastra/services/harness-events.ts` + `lib/agent-event-log.ts` | + eventy `pipeline_phase_transition`, `pipeline_reflector_intervention`, `pipeline_phase_tools_applied` |
| `src/mastra/scripts/` | nowy check: `check-pipeline-reflector.ts` (fazy, fail-open, brak ingerencji w happy-path) |

### 3.7. Kryteria akceptacji (Część 3) — ✅ ZAIMPLEMENTOWANE

> ⚠️ **Decyzja projektowa:** wbrew „default OFF" z planu, obie flagi
> (`FEATURE_PIPELINE_REFLECTOR`, `FEATURE_PIPELINE_PHASE_TOOLS`) są **default
> ENABLED** w `.env` i `.env.example` (standing instruction projektu). Determinizm
> jest chroniony konstrukcyjnie (warmup per-faza, soft-only levers, fail-open),
> nie samym wyłączeniem flagi — patrz `check:pipeline-reflector`.

- [x] `tsc --noEmit` przechodzi (clean). Happy-path: pipeline-mode reflektor na „zdrowym" oknie fazy → `continue` (test `happy`).
- [x] **Determinizm nietknięty:** clean run w pipeline mode → ZERO interwencji (unit: `happy`, `low-progress-pipeline`, `dir-pipeline`).
- [x] Wykrywanie fazy: `pipelinePhaseBoundary` czyta bieżący stan z ostatniego `*_set_*_status` (`args.status`) w `steps` (testy windowingu).
- [x] `wrong_tool` per faza: trywialne wyniki narzędzia w bieżącej fazie → `injectSystem` (z nazwą fazy + kandydatami) + `dropTools`, **soft only** (test `wrong-tool`).
- [x] Fail-open: nieznany agent / faza `null` / zmyślona faza → `null` (brak blokady); pusta faza → `alwaysAvailable` (nigdy puste) — test `resolvePhaseTools`.
- [x] Narzędzia `*_set_*_status` i `*_get_*` dostępne w KAŻDEJ fazie (`alwaysAvailable`) — test menu_draft + checkpoint_profile.
- [x] `high_error_rate` liczony per faza (reset na tranzycji), nie globalnie — testy `error-reset` (przed tranzycją nie przecieka) + `error-in-phase`.
- [x] Błąd w `prepareStep` pipeline'a → run kończy się normalnie — `generate-pipeline-with-reflection.ts` + harness owijają prepareStep w `try/catch → return undefined`.
- [x] Phase-Exit Check (Warstwa A) — w promptach chef/content/hunt, bez flagi, „po cichu" przed każdą tranzycją (§3.3A).
- [x] §3.5 automation: per-phase Golden Path tools (validate nie eksponuje `architect_deploy_automation`; `chat` fail-opens) — test `automation Golden Path`.

### 3.8. Rollout (Część 3)

1. **Warstwa A (prompt) najpierw** — dodać Phase-Exit Check do chef/content/hunt, bez flagi. Bieg E2E happy-path każdego agenta → potwierdzić brak regresji (najtańszy, najbezpieczniejszy zysk).
2. `FEATURE_PIPELINE_REFLECTOR` na **jednym** agencie (chef — najlepiej zwalidowany E2E wg pamięci projektu) → obserwacja telemetrii `pipeline_*`, potwierdzić ZERO interwencji na happy-path.
3. Test negatywny: sztucznie wymusić zły dobór narzędzia → potwierdzić, że `wrong_tool` interweniuje miękko i pipeline się nie wykoleja.
4. `FEATURE_PIPELINE_PHASE_TOOLS` na chefie → walidować, że allowlisty nie blokują nic legalnego (telemetria), dopiero potem content/hunt.
5. Automation: per-phase Golden Path tools osobno (już ma harness).
6. Po stabilnym okresie per agent → rozważyć default ON, agent po agencie.

### 3.9. Znane ograniczenia / decyzje

- Pipeline'owy reflektor **świadomie nie ma** `stopWhen`/`forceTool`/`escalateModel` — zatrzymania należą do checkpointów i krytyk pipeline'u (chef `critic_gate`, content `critique`, hunt `checkpoint_review`), nie do reflektora. To celowe, by nie walczyć z maszyną stanów.
- Per-phase allowlisty wymagają utrzymania mapy przy zmianach narzędzi agenta — udokumentować, że dodanie nowego narzędzia chefa wymaga aktualizacji `pipeline-phase-tools.ts` (inaczej fail-open je przepuści, ale nie skanalizuje do fazy).
- Output scoring (z Cz.2) oparty o GoalContract **nie dotyczy** pipeline'ów (mają własne kryteria per faza) — ewentualny pipeline output-scoring to przyszłe rozszerzenie, poza zakresem tego planu.

---

## WERYFIKACJA KOŃCOWA (2026-06-16)

Przeszedłem cały plan kontra realny kod repo i typy `@mastra/core` 1.31. Poniżej co potwierdzone, co poprawione i co zostaje do empirycznego sprawdzenia w PoC.

### A. Potwierdzone fakty techniczne (kontra kod/typy)

1. **`prepareStep` istnieje i jest bogatszy niż AI SDK.** Eksponowany na poziomie generate options jako `prepareStep?: PrepareStepFunction` (`agent.types.d.ts:454`). Kontrakt: `ProcessInputStepArgs → ProcessInputStepResult` (`processors/index.d.ts:139/184`), NIE goły `experimental_prepareStep` z AI SDK v5 (`_types/.../ai-sdk.types.d.ts:1307`, który zwraca tylko `model`/`toolChoice`/`experimental_activeTools`).
2. **Harness woła NOWE `agent.generate()`** (`generate-with-harness.ts:766`) — loop-based (`AgentExecutionOptionsBase`, `agent.d.ts:829`), nie `generateLegacy()` (AI SDK v4). Więc `prepareStep`/`stopWhen`/`activeTools` są realnie honorowane.
3. **`ProcessInputStepResult` pola:** `model`, `toolChoice`, `activeTools` (`string[]`), `messages` (`MastraDBMessage[]`), `messageList`, `systemMessages` (CoreMessageV4[], **zastępuje wszystkie**), `tools`, `modelSettings`, `structuredOutput`, `retryCount`. **Brak pola `system`.**
4. **`ProcessInputStepArgs` daje:** `steps`, `stepNumber`, `systemMessages` (czytelne), `state` (persist per-request), `model`, `tools`, `toolChoice`, `activeTools`, `messages`, `messageId`. → cooldown w `state`, injekcja przez read+append `systemMessages`.
5. **`stopWhen`** eksponowany (`agent.types.d.ts:405`, typ `StopCondition` V5/V6, może być tablicą — semantyka OR). `maxSteps` zostaje twardym backstopem count.
6. **Tool ID maszyn stanów potwierdzone:** `chef_set_project_status`, `content_set_project_status`, `hunt_set_run_status` — granice faz są deterministycznie wykrywalne (fundament Cz.3).
7. **Pipeline'i przez goły `agent.generate`** w `delegate-task.ts` (gałąź „All other agents"), maxSteps:150 — potwierdza, że nie wolno owijać ich depth-capped harnessem (Cz.3 §3.2).

### B. Poprawki wprowadzone w trakcie weryfikacji

1. **Injekcja `system` → `systemMessages` (read+append).** Pierwotny szkic używał `result.system` (nie istnieje) → potem `messages` append → finalnie `systemMessages: [...systemMessages, {role:'system', content}]`. To jedyny sposób, który zachowuje instrukcje bazowe i trzyma refleksję jako blok systemowy (§1.5 + nota API).
2. **Cooldown w `state`, nie w closure.** Wykorzystuje `ProcessInputStepArgs.state` (§1.5).
3. **`stopWhen` bez `stepCountIs`.** `stepCountIs`/`hasToolCall`/`isLoopFinished` to helpery pakietu `ai`, NIE eksport Mastry. `stopWhen` = wyłącznie custom predykat `isUnrecoverable(steps)`; limit kroków zostaje na `maxSteps` (§2.6 + nota).
4. **`isUnrecoverable(steps)` bezstanowe** — spójne z `evaluateHistory` (§2.6, §2.9).
5. **Relacja z passami post-run** rozstrzygnięta (§1.5.1): przy fladze ON `analyzeStep` w `onStepFinish` milknie, `recordIntervention` utrzymuje `getTriggeredReflections()`, repair pass świadomie pomijany, auto-deliberation zostaje.
6. **Bullet §0** o dźwigniach `prepareStep` zaktualizowany do realnego kontraktu.

### C. Spójność między częściami (cross-check)

- **`ReflectorIntervention`** używany spójnie: Cz.1 definiuje `injectSystem`/`dropTools`/`forceNoTool` (+ `escalateModel` przygotowane); Cz.2 dokłada `escalateModel`/`forceTool`/`restrictTools`; Cz.3 używa wyłącznie podzbioru miękkiego (`injectSystem`/`dropTools`). Brak konfliktu.
- **`evaluateHistory(steps)` (bezstanowe)** jest wspólnym rdzeniem dla `prepareStep` (Cz.1), triggerów celu (Cz.2) i trybu pipeline (Cz.3). Jedno źródło prawdy.
- **Flagi** narastają addytywnie i wszystkie default OFF: Cz.1 `FEATURE_REFLECTOR_PREPARE_STEP`; Cz.2 `FEATURE_REFLECTOR_GOAL_TRIGGERS`/`_HARD_LEVERS`/`_STOP_WHEN`/`FEATURE_OUTPUT_SCORING`; Cz.3 `FEATURE_PIPELINE_REFLECTOR`/`FEATURE_PIPELINE_PHASE_TOOLS`. Kolejność rolloutu zachowuje zależności (Cz.1 → telemetria → Cz.2 miękkie przed twardymi → Cz.3 prompt przed programatyką).
- **Determinizm pipeline'ów** chroniony konsekwentnie: refleksja tylko na granicach faz, fail-open, wyłączone `low_progress`/`direction_instability`/`scope_creep`, brak `stopWhen`/`forceTool` w pipeline'ach.

### D. Do empirycznego potwierdzenia w PoC (nie blokuje planu, ale zweryfikować na starcie Cz.1)

1. **Format `messages`/`systemMessages` przy zwrocie.** `systemMessages` to `CoreMessageV4[]`, `messages` to `MastraDBMessage[]` — potwierdzić dokładny kształt wpisu refleksji (czy `{role:'system', content:string}` wystarcza, czy potrzeba pełnego DB-message). Pierwsza rzecz do sprawdzenia.
2. **Czy `prepareStep` faktycznie odpala przy każdym kroku** przez używaną ścieżkę `agent.generate` (loop vs. ewentualne short-circuity przy `maxSteps:1` w passach naprawczych — tam i tak nie chcemy reflektora).
3. **Współistnienie `stopWhen` + `maxSteps`** — potwierdzić semantykę OR (którykolwiek kończy run).
4. **Natywny `isTaskComplete` scorer** — ✅ **przyjęty do §2.7** (nie budujemy własnej hydrauliki). Potwierdzony w 1.32.1 (`agent.types.d.ts:482`, `CompletionConfig`). Do potwierdzenia w PoC: identyczne działanie na gołym `agent.generate` jak w network loop + respektowanie `maxSteps`/memory podczas re-iteracji.

### F. Korekta wersji + dodatki z researchu (sesja kontynuacyjna)

- **Zainstalowana wersja to `@mastra/core` 1.32.1** (nie 1.31). Wszystkie zweryfikowane fakty z sekcji A nadal obowiązują (potwierdzone w 1.32.1).
- **§2.7 przepisane** na natywny `isTaskComplete` (`maxIterations: 5` jako sufit, dostrajany per profil) + nowy plik `goal-completion-scorer.ts`. Zakres potwierdzony przeglądem ścieżek `delegate-task.ts`: harness agents ✅, „all other agents" goły generate ⚠️ (opcjonalne rozszerzenie), pipeline ❌ (celowo poza).
- **Trade-off KV-cache (NOWY punkt PoC):** injekcja przez `systemMessages` (read+append, §1.5) przepisuje prefix promptu → unieważnia prompt-cache dla kolejnych kroków; append do `messages` (ogon) zachowuje cache prefixu, ale słabiej trzyma się jako blok systemowy. Interwencje są rzadkie (cooldown), więc koszt prawdopodobnie akceptowalny — ale **zmierzyć w PoC** i wybrać świadomie. Dotyczy Cz.1.
- **Poza zakresem (z researchu, świadomie):** protokoły A2A/ACP (agenci in-process), spec `SKILL.md`/repo skilli (osobny tor), natywna klasa `Harness` 1.32.1 (TUI orchestrator — kolizja nazw z naszym `generate-with-harness.ts`, inny cel). „Architectural reduction" tools + token-threshold routing — komplementarne strategicznie, ale poza reflektorem.

### E. Werdykt

Plan jest **spójny, wykonalny i bezpieczny** (flagi OFF + fail-open + try/catch + telemetria-first). Kluczowe założenie techniczne („`prepareStep` pozwala na in-flight zmianę narzędzi i kontekstu") jest **potwierdzone w typach 1.31**. Punkty z sekcji D to normalne PoC-checki, nie luki projektowe. Rekomendacja: zacząć od Części 1 za flagą OFF, canary na meta-agencie, dopiero potem Cz.2/Cz.3.
