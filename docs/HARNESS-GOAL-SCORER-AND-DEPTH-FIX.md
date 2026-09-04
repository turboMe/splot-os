# Hardening Harnessu: Klasyfikator Głębokości i Auto-Finalizacja GoalContractScorer

Data wdrożenia: **2026-08-28**  
Pliki źródłowe:
- `src/mastra/services/depth-controller.ts`
- `src/mastra/scorers/goal-completion-scorer.ts`
- `src/mastra/scripts/check-depth-controller.ts`
- `src/mastra/scripts/check-goal-completion-scorer.ts`

---

## 1. Problem i Diagnoza

### A. False-Positive w Klasyfikatorze Głębokości (`depth-controller.ts`)
W regexie `CRITICAL_KEYWORDS` znajdował się surowy rdzeń `aktyw`, który miał wykrywać operacje krytyczne (takie jak aktywacja workflow na produkcji czy aktywacja reguł), jednak dopasowywał się do zwykłych zapytań o stan (`"czy jest cos aktywnego"`, `"aktywne zadania"`).
W rezultacie zapytania informacyjne otrzymywały poziom `critical`:
- Budżet do 40 kroków,
- Wymuszony 5-etapowy kontrakt celu (`goal_contracts`),
- Rygorystyczny ewaluator `GoalCompletionScorer` i bramka `AutoReview`.

### B. Klincz w `GoalCompletionScorer` (`goal-completion-scorer.ts`)
Generyczny kontrakt celu dla fazy `chat` zawiera 5 syntetycznych kroków (`step-1` do `step-5`), które nie są indywidualnie odhaczane przez narzędzia bazodanowe.
Gdy agent w trakcie pracy napotkał pojedynczy, niekrytyczny błąd narzędzia (np. błąd modułu w `eval` lub błąd składniowy, który za chwilę poprawił), harness zapisywał ten fakt do `evidenceAgainst`.
Linijka:
```typescript
if (contract.evidenceAgainst.length > 0) return null;
```
powodowała, że funkcja `maybeAutoFinalizeGenericHarnessContract` zwracała `null`, `evaluateCompletion()` odrzucało ukończenie (`passed: false`), a pętla Mastry `isTaskComplete` wielokrotnie re-injektowała feedback `incomplete (replan)` do modelu.

W efekcie model kręcił się w pętli, aż w desperacji sam wykonał polecenie `mongosh` modyfikujące rekord w `goal_contracts` na `completed`.

---

## 2. Wdrożone Zmiany

### A. Precyzyjny wzorzec w `depth-controller.ts`
Zastąpiono `/aktyw/` precyzyjnymi formami czasownikowymi/rzeczownikowymi:
```typescript
const CRITICAL_KEYWORDS = /produkc|usuń|usun|delete|migrac|migration|bezpieczeń|bezpieczen|security|credential|credentials|secret|sekret|deploy|activate|aktywacj|aktywuj|aktywowa|payment|płatno|platno|database|baza danych/i;
```

### B. Odporność na przejściowe błędy narzędzi w `goal-completion-scorer.ts`
W `maybeAutoFinalizeGenericHarnessContract` usunięto sztywną blokadę na `evidenceAgainst.length > 0`. Zamiast tego sprawdzany jest warunek braku krytycznie nieudanych kroków (`status === 'failed'`):
```typescript
const hasFailedStep = contract.plannedSteps.some((step) => step.status === 'failed');
if (hasFailedStep) return null;
```
Gdy model wygeneruje merytoryczną odpowiedź końcową (`outputText.length >= minOutputChars`), kontrakt jest pomyślnie zamykany i nie blokuje oddania odpowiedzi użytkownikowi.

---

## 3. Weryfikacja

1. `npx tsx src/mastra/scripts/check-depth-controller.ts` → **PASS**
2. `npx tsx src/mastra/scripts/check-goal-completion-scorer.ts` → **PASS** (w tym Case 3b z przejściowym błędem narzędzia)
3. `npx tsc --noEmit` → **PASS (0 błędów)**
