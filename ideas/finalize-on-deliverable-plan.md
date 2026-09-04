# PLAN — „Architekt wie kiedy skończyć" (finalize-on-deliverable)

Data: 2026-06-24. Autor: nowa instancja (Opus). Status: **DO ZATWIERDZENIA — bez zmian runtime.**
Kontynuacja: `ideas/HANDOFF-automation-architect-finalize.md` + `ideas/automation-delegation-lifecycle-fix.md`.

---

## 0. TL;DR

Główny problem (architekt wisi po `tested` aż do WS-A 900s) **nie jest** problemem konwergencji reflektora.
To tylko objaw. **Prawdziwy root cause: natywny scorer kompletności Mastry (`isTaskComplete`)
strukturalnie NIGDY nie przechodzi dla delegacji automation** → Mastra w nieskończoność wstrzykuje
feedback „not complete" i każe modelowi iterować dalej. Konwergencja reflektora była *obejściem* tego
scorera, ale jest bramkowana licznikiem interwencji (`reflectionsTriggered`), który w czystym runie = 0.

**Fix = naprawić właściwy mechanizm (scorer), nie obejście (konwergencję).** Trzy skoordynowane,
deterministyczne dźwignie oparte o istniejący run-scoped latch `hasAutomationDeliverable()`, w pełni
**niezależne od licznika reflektora**:

1. **Scorer-aware finalize (rdzeń)** — `goal-completion-scorer.ts`: scorer zwraca `1` (complete), gdy
   Golden Path wyprodukował terminalny deliverable (latch) **i** model wypisał poprawny raport. Kończy
   run natywną drogą Mastry, raportem jako finalną odpowiedzią.
2. **prepareStep force-report (domykacz)** — `generate-with-harness.ts`: gdy latch = `tested`/`active`,
   wymuś `toolChoice:'none'` + instrukcję „napisz raport końcowy teraz". Kasuje churn (#4) i wymusza
   raport, na którym scorer (1) finalizuje.
3. **stopWhen backstop (asekuracja)** — `generate-with-harness.ts`: predykat kończący pętlę, gdy latch
   = `tested`/`active` **i** w ostatnim kroku jest już raport. Domyka run nawet gdyby `isTaskComplete`
   nie był sterownikiem pętli. Zero ryzyka pustego tekstu (kończy tylko gdy raport JUŻ istnieje).

Wszystko za flagą `FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE` (default ON). Blast radius = wyłącznie
automation (latch ustawia tylko Golden Path; dla innych agentów wszystkie trzy dźwignie to no-op).

---

## 1. Zweryfikowany root cause (z odczytu kodu, nie z handoffu)

### 1.1 Łańcuch który wisi
`meta → delegateTaskTool(automationArchitect) → generateAutomation (sync, timeout 900s) →
generateWithHarness → callAgentGenerate → agent.generate(prompt, { stopWhen, isTaskComplete,
prepareStep, onStepFinish, abortSignal })`.

Pętla `agent.generate` zwraca, gdy: (a) model da finalną odpowiedź **i** `isTaskComplete` ją zaakceptuje,
albo (b) wystrzeli któryś `stopWhen`. W czystym runie **żadne z tych nie następuje** → pętla mieli do
WS-A 900s.

### 1.2 Dlaczego `isTaskComplete` nigdy nie przechodzi (TWARDY root cause)
`generate-with-harness.ts:1176-1203` ustawia:
```ts
generateOptions.isTaskComplete = {
  scorers: [createGoalCompletionScorer(goalContractId, { autoFinalizeOnOutput: true })],
  strategy: 'all', ...
};
```
`createGoalCompletionScorer` (`scorers/goal-completion-scorer.ts`) zwraca `1` tylko gdy:
- `evaluateCompletion(goalContractId).passed === true`, **albo**
- `autoFinalizeOnOutput` zadziała — ale `maybeAutoFinalizeGenericHarnessContract` **wymaga
  `isGenericHarnessContract(contract)`** (linia 102), tj. dokładnie 3 generycznych kroków harnessu
  („Clarify the objective…", „Execute the task…", „Verify completion…").

Kontrakt delegacji automation jest tworzony przez `createDelegationGoalContract`
(`delegate-task.ts:967`) z planu `buildDelegationPlan` (static) **albo** LLM-plan (WS2,
`planToDelegationSteps`). **W obu przypadkach to NIE jest generyczny kontrakt harnessu** →
`isGenericHarnessContract` = false → auto-finalize się NIE odpala.

Zostaje więc tylko `evaluateCompletion().passed`. A ten (`goal-tracker.ts:438`):
```ts
score = currentProgress*0.6 + evidenceScore*0.25 + confidenceScore*0.15
passed = score >= 0.7 && failedSteps === 0 && confidence !== 'critical'
```
`currentProgress` (`recalculateProgress`, waga 0.6) liczony jest głównie z **formalnie domkniętych
kroków planu** (`stepProgress = doneOrSkipped / steps.length`). Kroki LLM-planu delegacji **nigdy nie
są oznaczane `done` w trakcie runu** — `recordHarnessToolGoalEvidence` zapisuje tylko ogólne
for/against (nie domyka kroków), a `recordHarnessFinalGoalEvidence` (które domyka step-1/2/3) odpala
się **dopiero po powrocie `agent.generate`** — czego w czasie wiszenia NIGDY nie ma.

**Wniosek:** w trakcie pętli `currentProgress ≈ 0` → `score ≪ 0.7` → scorer zwraca `0` →
Mastra wstrzykuje „not complete, missing: step X pending…" i iteruje dalej. **To jest silnik
wiszenia/churnu.** (Komentarz w kodzie wprost nazywa to „never-passing completion scorer":
`generate-with-harness.ts:1136`.)

### 1.3 Dlaczego konwergencja (obejście) nie ratuje czystego runu
- Sygnał `converge` (`strategy-reflector.ts:956-965`) wymaga `this.reflectionsTriggered >= 2`.
- `shouldConvergeStop` (`strategy-reflector.ts:1169-1212`) **najpierw** sprawdza
  `isReflectionBudgetExhausted()` = `reflectionsTriggered >= maxReflectionsPerRun` (=5)
  (`strategy-reflector.ts:1245`).

W **czystym runie (test #6): `reflector_intervention = 0`** → ani `>=2`, ani `>=5` → **żadna ścieżka
konwergencji nie odpala**, niezależnie od tego, że latch `hasAutomationDeliverable()` jest poprawnie
ustawiony (potwierdzone: WS-C-hard final, `mcp-handoff-state.ts:48-68`, `buildResult`
`automation-golden-path.ts:1447-1452`). Konwergencja działa tylko w *brudnym* runie (reflektor zanaga
≥2×, np. test #5: 7 interwencji). **To jest dokładnie obserwacja z handoffu — potwierdzona w kodzie.**

### 1.4 Dlaczego wszystkie poprzednie próby zawiodły
| Próba | Cel | Dlaczego padła |
|---|---|---|
| WS-C (prompt „Stop And Report") | model | miękki, model ignoruje |
| `isAutomationTerminalDeliverable` (parsing steps) | konwergencja | parsing znormalizowanego/skompaktowanego wyniku zawodzi live |
| errorRate refinement | konwergencja | celował w nie-problem (errorRate < threshold) |
| run-scoped latch + konwergencja | konwergencja | **latch OK, ale konwergencja bramkowana `reflectionsTriggered` (0 w czystym runie)** |

**Wspólny błąd wszystkich prób: celowały w KONWERGENCJĘ (obejście) bramkowaną licznikiem reflektora.**
Ten plan celuje w **SCORER `isTaskComplete` (właściwy mechanizm finalizacji Mastry)** + dedykowane
dźwignie, **całkowicie pomijając licznik reflektora.** To jakościowo inna warstwa naprawy.

---

## 2. Projekt rozwiązania

Wszystkie trzy dźwignie czytają jeden deterministyczny sygnał: **status terminalny ustawiony przez
Golden Path** (rozszerzony latch). Latch jest ustawiany w tym samym kontekście ALS co tool-calle i
scorer (`runWithHarnessExecutionContext` owija `agent.generate`), więc keying jest spójny — to ten sam
mechanizm, którym WS-J `hasSuccessfulMcpHandoff` działa live.

### Lever 1 — Deliverable-aware completion scorer (RDZEŃ, naprawia #6)
`scorers/goal-completion-scorer.ts`. Po nieudanym `evaluateCompletion` i nieudanym generic-finalize,
dodaj automation-finalize:
```
jeśli hasAutomationDeliverable() === true
   ORAZ looksLikeAutomationReport(output) === true     // status terminalny + automationId + workflowId
then:
   completeGoalContract(goalContractId, 'completed', '…')   // tak jak generic auto-finalize
   return 1
```
- **`looksLikeAutomationReport(text)`** (nowy, lokalny helper, lustro `isAutomationArchitectContractComplete`):
  `text` zawiera słowo statusu (`tested|active|draft_created|blocked|manual_review_required`) **oraz**
  `automationid` **oraz** `workflowid` (lower-case). Gwarantuje, że finalna odpowiedź **przejdzie też
  text-kontrakt delegacji** (`delegate-task.ts:844`) → sukces, nie false-failed.
- **Brak wymogu `evidenceAgainst === 0`** (świadomie inaczej niż generic): wcześniejsze rozwiązane
  gate-blocki (`node_validation_required`) zostawiają against-evidence; terminalny `tested` je
  superseduje. Latch = dowód realnego sukcesu.
- Skutek dla #6: model po `tested` wypisuje raport → scorer (1) → Mastra finalizuje raportem.
  **Niezależne od reflektora.** Zero ryzyka pustego tekstu (wymaga poprawnego raportu na wyjściu).

### Lever 2 — prepareStep force-report (DOMYKACZ, kasuje churn #4 + wymusza jakość raportu)
`generate-with-harness.ts`, w `prepareStep` **przed** logiką reflektora (ok. linia 888):
```
jeśli automationFinalizeEnabled()
   ORAZ shouldForceAutomationReport(status, ctx.originalPrompt):
then return {
  ...phaseResult,
  toolChoice: 'none',
  systemMessages: [...systemMessages, { role:'system', content: REPORT_NOW_INSTRUCTION }],
}
```
- `REPORT_NOW_INSTRUCTION`: „Workflow jest zbudowany i przetestowany. Napisz finalny raport TERAZ i nie
  wołaj narzędzi: nazwa, automationId, workflowId, status (np. tested/inactive), wynik walidacji, risk
  score, brakujące credentiale." (zgodne z `base.md` „Response To The Caller").
- `shouldForceAutomationReport(status, prompt)`:
  - `status === 'active'` → **true** (aktywacja zrobiona).
  - `status === 'tested'` → **true tylko gdy `!briefRequiresActivation(prompt)`** (nie ucinamy
    legalnej aktywacji w brief-ach „włącz to").
  - `status === 'draft_created'` → **false** (nie ucinamy legalnej pętli repair/test).
- `briefRequiresActivation(prompt)`: `\b(activate|activation|włącz|wlacz|enable|uruchom)\b` AND NOT
  `\b(nie aktyw|don'?t activate|do not activate|bez aktyw|nie włącz|inactive|nie uruchamiaj|tylko
  zbuduj|only build|nie włączaj)\b`. (`ctx.originalPrompt` = brief, dostępny w closure —
  `generate-with-harness.ts:352`.)
- Egzekwuje **istniejącą politykę** z `base.md:33-42` („tested = deliverable, report, stop") —
  deterministycznie, czego miękki prompt (WS-C) nie potrafił.

### Lever 3 — stopWhen finalize backstop (ASEKURACJA, niezależność od semantyki isTaskComplete)
`generate-with-harness.ts`, dodaj do `stopWhen` array (linia 1165) trzeci predykat
`automationFinalizeStop`:
```
true jeśli automationFinalizeEnabled()
        ORAZ getAutomationDeliverableStatus() ∈ {tested, active}
        ORAZ looksLikeAutomationReport(tekst ostatniego kroku)
```
- Kończy pętlę gdy raport JUŻ jest → **brak ryzyka pustego finalnego tekstu** (handoff §6 ostrzeżenie
  zaadresowane wprost).
- Łapie przypadek, gdyby `isTaskComplete` nie był sterownikiem pętli (Mastra 1.32 quirk). Jeśli Lever 1
  zadziała pierwszy — Lever 3 nigdy nie wystrzeli (redundancja celowa).
- Loguje `reflector_convergence_stop`-podobny event `automation_finalize_stop` (obserwowalność).

### Brief-aware latch (wsparcie dla Lever 2/3)
`mcp-handoff-state.ts`: `deliveredRuns: Map<string, number>` → `Map<string, { status, at }>`.
- `markAutomationDeliverable(status)` — przyjmuje status.
- `hasAutomationDeliverable()` — bez zmian (true dla tested/draft/active; reflektor używa dalej).
- `getAutomationDeliverableStatus()` — nowy; zwraca status albo null. Używają Lever 2/3.
`automation-golden-path.ts:1451`: `markAutomationDeliverable(input.status)`.

#### Uzupełnienie 2026-08-24 — latch musi też wiedzieć JAK test przeszedł

Sam status nie wystarcza. `tested` zatrzaskuje się na teście **mock** dokładnie tak
samo jak na `real_credentials`: komunikat sukcesu Golden Path brzmi „deployed as
inactive draft and passed **mock** test", a `lastTest.mode` jest tam typowany
dosłownie `'mock'`, bo ta ścieżka nigdy nie robi nic innego. Skutek zmierzony na
żywo (architekt, workflow `9w40oeYIdZ343PM2`): brief, którego definition-of-done
brzmiała „you ran an end-to-end test against real credentials and real data",
został **domknięty na walidacji strukturalnej**, a run zakończył się, wskazując
realny test jako „następny krok", którego nie wykonał.

Zmiany:
- `AutomationDeliverableDetails.testMode?: 'mock' | 'manual' | 'real_credentials'` —
  wypełniane przez `test-workflow.ts` (miało `mode` w parametrach i używało go
  wyłącznie do wiersza audytowego) oraz przez `buildResult` z `input.lastTest?.mode`.
- `briefRequiresRealTest(prompt)` — bliźniak `briefRequiresActivation`; ta sama
  reguła „caller poprosił o jeszcze jeden krok, więc nie domykaj ponad nim",
  zastosowana do wykonania zamiast do aktywacji.
- `shouldForceAutomationReport(status, prompt, testMode?)` — przy `tested`
  odmawia domknięcia, gdy brief chce realnego testu, a mamy tylko mock.

**Świadomie NIE zmieniono:** mapowania mock→`draft_created`. To by cofnęło rdzeń
tego planu (dźwignia przestałaby domykać zwykłe buildy i wróciłby churn #4).
`testMode` jest **opcjonalny** — caller, który nie wie, jak poszedł test, zachowuje
poprzednie zachowanie, więc zawężenie działa tylko tam, gdzie są na nie dowody.
`stopWhen` (Lever 3) też zostaje bez zmian: on wymaga, żeby model **już napisał**
raport, więc niczego nie wypycha przedwcześnie.

Bramka: `check:automation-finalize-lever` — asertuje OBA kierunki (mock nie domyka
briefu z realnym testem; mock nadal domyka zwykły build).

---

## 3. Zmiany plik-po-pliku

1. **`config/harness-flags.ts`** — dodać `FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE` do
   `HARNESS_FEATURE_FLAG_NAMES`. Helper `automationFinalizeEnabled()` (default ON) — w
   `mcp-handoff-state.ts` (obok `mcpHandoffGateEnabled`) albo flags.

2. **`services/mcp-handoff-state.ts`** — latch trzyma status; `markAutomationDeliverable(status)`,
   nowy `getAutomationDeliverableStatus()`, `hasAutomationDeliverable()` bez zmian sygnatury;
   `automationFinalizeEnabled()`.

3. **`services/automation-golden-path.ts:1451`** — `markAutomationDeliverable(input.status)`.

4. **`scorers/goal-completion-scorer.ts`** — Lever 1: automation-finalize + `looksLikeAutomationReport`.
   Import `hasAutomationDeliverable` z `mcp-handoff-state.js` (reszta już zaimportowana:
   `completeGoalContract`, `getGoalContract`).

5. **`services/generate-with-harness.ts`** — Lever 2 (prepareStep, ~l.888) + Lever 3 (stopWhen array,
   ~l.1165) + helpery `briefRequiresActivation`, `shouldForceAutomationReport`, `looksLikeAutomationReport`
   (współdzielony — wyciągnąć do `mcp-handoff-state.ts` lub małego util, by scorer i harness nie
   duplikowały). Import latch-getterów.

6. **`prompts/automation/base.md`** — drobne wzmocnienie sekcji „Stop And Report": gdy brief wymaga
   aktywacji, wołaj `architect_execute_automation_request` z `activate:true` (atomowo testuje+aktywuje),
   nie testuj i aktywuj osobno. (Wspiera guard Lever 2; opcjonalne.)

7. **`.env.example`** — `FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE=true` + 1 komentarz.

8. **`ideas/automation-delegation-lifecycle-fix.md`** — odhaczyć po implementacji + live verify.

Bez ruszania: konwergencji reflektora (zostaje backstopem dla innych agentów/brudnych runów),
Golden Path quality/compose, WS-A/B/D/E/F/G/J (działają).

---

## 4. Red-team / analiza bezpieczeństwa

| Scenariusz | Wynik z fixem |
|---|---|
| **#6 czysty hang po tested** | Lever 2 wymusza raport → Lever 1 finalizuje. Koniec ~1-2 kroki po tested. ✅ FIX |
| **#4 churn 25× execute** | Lever 2 wymusza no-tool zaraz po latch=tested → brak ponownego execute. ✅ FIX |
| **catering + googleSheets (MCP)** | przed tested status=blocked (nie latchuje) → Lever 2 nie odpala, architekt robi MCP dance; po tested latch → finalize. WS-J/E1/F1 nietknięte. ✅ |
| **brief „włącz to" (activate)** | execute(activate:true)→active→latch=active→Lever 2 force po aktywacji. Jeśli architekt testuje najpierw (tested) — guard `briefRequiresActivation` NIE wymusza → aktywacja nieucięta. ✅ |
| **draft_created (test failed)** | Lever 2 NIE wymusza (status∉{tested,active}) → repair/test nieucięty. Lever 1 finalizuje tylko jeśli model sam zaraportuje terminal. ✅ |
| **read-only analysis** | brak Golden Path execute → brak latch → wszystkie 3 dźwignie no-op. ✅ bez regresji |
| **inni agenci (coding/chef/...)** | nigdy nie wołają Golden Path → `hasAutomationDeliverable()` zawsze false → wszystkie 3 dźwignie no-op. ✅ zerowy wpływ |
| **puste finalne wyjście** | Lever 1 i 3 kończą TYLKO gdy `looksLikeAutomationReport` (raport + ID-ki obecne). Nigdy nie finalizują pustki. ✅ |
| **sukces raportowany jako failed** | Lever 1 finalizuje tylko na raporcie kontrakt-valid → `isAutomationArchitectContractComplete` przejdzie → delegacja success. ✅ |
| **post-passy (auto-review/approval) po finalize** | Lever 1 woła `completeGoalContract` → `evaluateCompletion().passed` → goal-completion-gate POMINIĘTY. auto-review/approval (critical depth, no-tool rewrite) mogą przepisać raport — **WATCH-ITEM live: potwierdzić, że automationId/workflowId zostają.** Jeśli stripują → osobny mikro-fix (instrukcja „zachowaj ID"). |
| **flaga OFF** | powrót do obecnego (wiszącego) zachowania — czysty rollback. ✅ |

Ryzyka resztkowe (świadomie zaakceptowane):
- brief „aktywuj" utknięty na `tested` (activation blocked policy): Lever 2 nie wymusi, padnie na Lever 1
  (jeśli model zaraportuje) lub reflektor/WS-A — **nie gorzej niż dziś** (dziś też wisi).
- post-pass mangling raportu — watch-item powyżej; pre-existing ścieżka, nie wprowadzana tym fixem.

---

## 5. Plan testów (live, wg constraints handoffu §8)

1. `tsc --noEmit` = 0.
2. Usuń catering workflow z n8n (API DELETE; UI „Archive" nie kasuje) — inaczej architekt skopiuje
   googleSheets i ominie MCP.
3. User restartuje Mastrę (ładuje working tree), uzbroić obserwację (mongosh > monitor).
4. Prompt testowy catering (handoff §8) do meta.
5. Asercje (Mongo `agentforge`):
   - `automation_requests.status = tested` (googleSheets **v4**, inactive, 0 dup).
   - **`agent_events`: brak `architect_execute/deploy/test` PO terminalnym tested** (koniec churnu).
   - **`goal_contracts` architekta → `completed`** w ~kilkanaście s po tested (NIE `active` do 900s).
   - event `automation_finalize_stop` LUB `output_score complete:true` LUB
     `goal_completion_evaluated passed:true`.
   - delegacja `success:true`, raport zawiera automationId+workflowId+status.
   - `reflector_intervention` może być 0 — **i to OK** (to był warunek porażki, teraz nie blokuje).
6. Regresja: szybki read-only prompt do architekta → sync, raport, brak wpływu finalize.
7. (opcjonalnie) smoke `check:automation-delegation-lifecycle` rozszerzony o asercję „brak churnu po tested".

---

## 6. Kolejność implementacji
flags → mcp-handoff-state (latch+status+getters+flag) → golden-path (1 linia) → scorer (Lever 1) →
generate-with-harness (Lever 2+3) → base.md → .env.example → `tsc` → live verify → odhaczyć docs +
update pamięci.

## 7. Rollback
`FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE=false` → wszystkie 3 dźwignie no-op, zachowanie jak dziś.
Latch-status to addytywna zmiana struktury (czytana tylko przez nowy kod + boolean-getter dla reflektora).
