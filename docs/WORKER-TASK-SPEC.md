# WorkerTaskSpec — strukturalny kontrakt delegacji

> WS1 z `ideas/orchestration-upgrade-plan.md`. Zaimplementowane 2026-06-18.
>
> **Po co:** wąskim gardłem jakości w systemach wieloagentowych jest **opis zadania, nie model workera** (Anthropic, „Multi-agent research system"). Mglisty brief → worker dubluje pracę albo zostawia dziury. `WorkerTaskSpec` uogólnia sprawdzony wzorzec `AutomationSpec` (jawny scope + success criteria + output contract) na **każdą** ścieżkę delegacji, nie tylko n8n Golden Path.

---

## Co to jest

Czysty helper (schemat Zod + renderer), bez rejestracji własnego toola:

- **Plik:** `src/mastra/tools/system/worker-task-spec.ts`
- **Eksport:** `workerTaskSpecSchema` (Zod), `WorkerTaskSpec` (typ output), `WorkerTaskSpecInput` (typ input), `renderWorkerBrief(input)`

`renderWorkerBrief` przyjmuje **typ wejściowy** schematu i parsuje go wewnętrznie, więc defaulty Zod (`inputs`, `constraints`, `effort`…) są zawsze zastosowane — wołający może podać surowy argument toola bez pre-parsowania.

---

## Pola schematu

| Pole | Wymagane | Sens |
|---|---|---|
| `goal` | ✅ | Jedno mierzalne zdanie — jak wygląda sukces |
| `context` | — | Fakty, których worker nie zgadnie (nazwy, historia, decyzje) |
| `inputs[]` | — | Dane do przetworzenia, verbatim: `{ name, value, source }` |
| `outputContract` | ✅ | `{ format, schema?, example? }` — wołający na tym polega, by skonsumować wynik |
| `scope` | — | `{ inScope[], outOfScope[] }` — **`outOfScope` to największa dźwignia przeciw dublowaniu pracy** |
| `successCriteria[]` | ✅ (min 1) | Sprawdzalne warunki — **bramka jakości** |
| `constraints` | — | `{ language?, tone?, maxLength?, avoid[] }` |
| `tools[]` | — | Narzędzia/źródła, których worker ma użyć |
| `effort` | — (`medium`) | `quick` / `medium` / `thorough` — skaluj do złożoności |

**Ważne o języku:** brief jest **zawsze po angielsku**. `constraints.language` dotyczy języka **dostarczanego artefaktu** (np. `pl` dla polskiego posta, `en` dla analizy wewnętrznej), nie języka briefu. Jest to zgodne z regułą meta-agenta: deleguje po angielsku, a userowi odpowiada w jego języku.

---

## Jak używać

### W `system_run_worker` i `system_delegate_task`

Oba toole przyjmują teraz **opcjonalne** `taskSpec`. Gdy podane → renderowane do briefu i ma pierwszeństwo nad polem prozą:

- `run_worker`: `taskSpec` > `taskBrief` (fallback)
- `delegate_task`: `taskSpec` > `taskDescription` (fallback)

Gdy nie podasz ani `taskSpec`, ani pola prozą → `execute` zwraca błąd `underspecified_task`.

### Przykład (delegate_task)

```ts
delegate_task({
  targetAgent: 'huntAgent',
  taskSpec: {
    goal: 'Find 5 goat-cheese producers near Wrocław that supply restaurants',
    context: 'GastroBridge lead hunt. PL market. Client wants restaurant-grade suppliers.',
    outputContract: { format: 'json', schema: 'array of { name, city, email, score }' },
    scope: {
      inScope: ['discovery', 'qualification', 'verified email extraction'],
      outOfScope: ['do NOT send emails', 'no placeholders', 'do not invent contact data'],
    },
    successCriteria: ['exactly 5 qualified producers', 'every email verified', 'RODO footer in drafts'],
    constraints: { language: 'pl', avoid: ['generic templates'] },
    effort: 'thorough',
  },
});
```

Renderuje deterministyczny brief (blokowy układ `GOAL / CONTEXT / INPUTS / SCOPE / OUTPUT / SUCCESS CRITERIA / CONSTRAINTS / TOOLS / EFFORT`); puste sekcje są pomijane.

---

## Kompatybilność wsteczna

Pola prozą (`taskBrief`, `taskDescription`) są **opcjonalne i dalej działają** — istniejące wywołania nie wymagają zmian. `taskSpec` to ścieżka preferowana dla nowego kodu i lepszych wyników sub-agentów.

---

## Guidance w promptcie

`src/mastra/prompts/meta/base.md` (sekcje A — delegacja, oraz „How to brief a worker") instruują meta-agenta, by **preferował `taskSpec`** i zawsze wypełniał `scope.outOfScope` + `successCriteria`.

---

## Weryfikacja

- `tsc --noEmit` — zielony.
- Renderer smoke-tested: pełny spec (wszystkie sekcje), minimalny (puste pominięte, defaulty zastosowane), pusty `successCriteria` odrzucony przez schemat.
- **Pozostaje:** live E2E na 1 realnym przepływie (np. hunt cold-email) — wymaga uruchomionego systemu.

---

## Następne kroki (reszta planu)

WS2 — ożywić `GoalContract` (Plan-and-Execute + replanowanie przez Reflektor/`prepareStep`). WS3 — audyt opisów narzędzi + MCP. WS4 — szablon planu w promptach. Szczegóły: `ideas/orchestration-upgrade-plan.md`.
