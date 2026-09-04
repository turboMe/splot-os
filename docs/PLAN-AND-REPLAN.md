# Plan-and-Execute + Replanowanie — żywy plan w GoalContract

> WS2 z `ideas/orchestration-upgrade-plan.md`. Zaimplementowane 2026-06-18.
>
> **Po co:** statyczny plan nie napędza wykonania i nie da się go rewidować. `buildDelegationPlan` zwracał te same 3 ogólne kroki dla **każdego** zadania. WS2 zamienia to na **realny plan generowany przez LLM** z jawnymi `assumptions` (założeniami) — bo replanowanie wyzwala się dokładnie wtedy, gdy obserwacja **przeczy założeniu**. Plan żyje w `GoalContract` (jak `TodoWrite` u Claude Code), a nie jest jednorazowym artefaktem.

---

## Co powstało

### 1. `src/mastra/tools/system/plan-task.ts` (rdzeń)

Czysty helper + tool:

- **`planSchema`** (Zod) — kontrakt planu:
  ```ts
  {
    goal: string,
    assumptions: string[],          // min(1) — klucz do replanowania, NIGDY pusty
    steps: [{
      id: string,
      intent: string,
      toolOrAgent?: string,
      expectedOutput: string,
      successCheck: string,         // jak poznam, że krok się udał
    }],                             // min(1)
    checkpoints: string[],          // default [] — po którym kroku zweryfikować założenia
  }
  ```
- **`generatePlan(args)`** — re-używalny helper. Woła model `workerPresets.reasoning`, parsuje odpowiedź (tolerancyjnie: fence + pierwszy `{...}`), waliduje przez `planSchema`. Rzuca, gdy model nie wyprodukuje planu zgodnego ze schematem — wołający decyduje o fallbacku.
- **`planTaskTool`** (`system_plan_task`) — tool dla meta-agenta. Wejście: `goal` + `context?` + `availableTools?`. Wyjście: `{ plan?, success, error? }`.

Brief planera jest **zawsze po angielsku** (zgodnie z regułą meta-agenta).

### 2. `services/goal-tracker.ts` (warstwa trwałości — additywnie)

- `GoalContract.assumptions?: string[]` — nowe, opcjonalne pole (legacy/statyczne plany zostawiają puste).
- `createGoalContract({ …, assumptions? })` — przyjmuje założenia przy tworzeniu kontraktu.
- `recordPlanRevision(contractId, newSteps, reason, newAssumptions?)` — 4. opcjonalny argument aktualizuje założenia przy rewizji. **Mierzalność:** `$inc: planRevisions` + wpis do `evidenceFor` (`"Plan revised: …"`) + event `goal_plan_revised`.

Wszystkie zmiany są wstecznie kompatybilne — istniejący wołający nie wymagają zmian.

### 3. `tools/system/delegate-task.ts` (wpięcie, za flagą)

- `createDelegationGoalContract` — gdy `FEATURE_DELEGATION_LLM_PLAN` jest ON, generuje plan LLM (`generatePlan`) i mapuje `Plan.steps` → `plannedSteps`, a `Plan.assumptions` → `GoalContract.assumptions`. **Fallback** do statycznego `buildDelegationPlan` przy każdej porażce planera — delegacja nigdy się nie blokuje.
- `replanDelegationContract` — na porażce delegacji (złamane założenie „agent X wykona to wg planu") regeneruje plan i woła `recordPlanRevision` + evidence(against). Wpięte w `completeDelegationGoalFailure` (oba miejsca porażki).

### 4. `prompts/meta/base.md` (guidance — WS2.4)

Sekcja „When to use `system_plan_task`": planuj strukturalnie **tylko** gdy ≥3 kroki **LUB** efekty uboczne (deploy/send/write) **LUB** >1 agent. Proste zapytania → bez `plan_task` (koszt + latencja).

### 5. `meta-agent.ts`

`planTaskTool` zarejestrowany w always-on tools (sekcja Orchestration).

---

## Flaga `FEATURE_DELEGATION_LLM_PLAN`

Dodana do `config/harness-flags.ts`. **Domyślnie OFF** → zero regresji latencji/zachowania:

- **OFF (default):** delegacja używa statycznego planu (zachowanie sprzed WS2). `planTaskTool` jest dostępny dla meta-agenta niezależnie od flagi.
- **ON:** delegacja generuje plan LLM do `GoalContract` + replan-on-failure. **Włączyć na czas live E2E.**

```bash
FEATURE_DELEGATION_LLM_PLAN=1
```

---

## Jak wyzwala się replanowanie

1. Plan ma jawne `assumptions` (np. „repo się buduje", „creds istnieją").
2. **In-flight, wewnątrz runu sub-agenta:** istniejący Reflektor już re-planuje w tekście — `forceNoTool: true` na sygnałach `high_error_rate` / `progress_stall` / `wrong_tool` (`services/strategy-reflector.ts`). WS2 tego nie dotyka (wysokie ryzyko).
3. **Na poziomie kontraktu delegacji:** gdy delegacja zwróci porażkę → `replanDelegationContract` regeneruje plan, zapisuje **mierzalną rewizję** (`planRevisions++`, nowe `plannedSteps`, nowe `assumptions`, evidence(against)). Obserwowalne w `GoalContract` i przez event `goal_plan_revised`.

To świadomy podział: in-flight (wewnątrz agenta) = Reflektor; kontraktowy (między próbami) = `recordPlanRevision`.

---

## Weryfikacja

- `tsc --noEmit` — zielony.
- `planSchema` smoke-tested: poprawny plan przechodzi; puste `assumptions` odrzucone; puste `steps` odrzucone; `checkpoints` domyśla się `[]`.
- **Pozostaje:** live E2E na 1 realnym przepływie delegacji z `FEATURE_DELEGATION_LLM_PLAN=1` — sprawdzić, że plan LLM ląduje w `GoalContract`, a wymuszona porażka daje rewizję widoczną na dashboardzie.

---

## WS4 — spójność promptów (ZROBIONE)

Żeby inline-plan meta-agenta i strukturalny `system_plan_task` mówiły jednym językiem, `prompts/meta/base.md` dostał trzy zmiany:

1. **Jeden słownik planu (bez duplikacji).** Inline `📋 Plan` używa tych samych pojęć co `planSchema`: `goal · assumptions · steps[intent → agent/tool, success] · checkpoints · done`. Dodana notka mówi wprost, że inline plan i `Plan` z narzędzia są wymienne — różnią się tylko poziomem formalności. `assumptions` są jawnym wyzwalaczem replanowania w obu formach.
2. **Routing rule (delegacja vs worker).** Jednoliniowa reguła pod „Two delegation paths": deleguj do EKSPERTA gdy potrzebny jego **tool stack / identity / memory thread**; `run_worker` dla **czystej generacji tekstu** bez narzędzi. Wzmocniona istniejąca preferencja `taskSpec` (`always fill outOfScope` + `successCriteria`).
3. **Rozpoznanie przed akcją.** Na początku `Task Planning`: dla zadań nietrywialnych odpal równolegle (read-only) `search_tools` + `system_recall_worker_lessons` + `system_memory_recall` ZANIM napiszesz plan — plan ma odzwierciedlać to, co znalazłeś.

Zmiany są czysto promptowe (markdown), więc nie ruszają embeddingów ani runtime'u; `tsc --noEmit` zielony.

## Następne kroki (reszta planu)

WS3 — audyt opisów narzędzi + MCP (robi user, równolegle). Po WS3: jeśli zmienią się opisy narzędzi, pool `ToolSearchProcessor` embedduje w runtime (restart wystarcza); persystowane RAG-i (pattern-rag, system-knowledge) wymagają rebuildu. Szczegóły: `ideas/orchestration-upgrade-plan.md`.
