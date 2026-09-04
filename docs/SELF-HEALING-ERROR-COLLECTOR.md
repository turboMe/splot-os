# Etap 7: Self-Healing — Error Collector & Auto-Heal Trigger

Aktualizacja: 2026-05-09

## Cel

Automatyczny "Łowca Błędów" — serwis nasłuchujący wyjątki runtime i automatycznie inicjujący `repo-maintenance-workflow` w celu naprawy kodu.

## Architektura

```
┌──────────────────────────────────────────────────┐
│  Mastra Runtime                                   │
│                                                    │
│  ┌──────────────────┐    ┌──────────────────────┐ │
│  │ Global Error     │───>│  ErrorCollector       │ │
│  │ Handlers         │    │  (singleton)          │ │
│  │ - uncaughtExc.   │    │  ┌─ hashError()       │ │
│  │ - unhandledRej.  │    │  ├─ dedup (Mongo)     │ │
│  └──────────────────┘    │  ├─ cooldown (60s)    │ │
│                          │  ├─ max active (3)    │ │
│  ┌──────────────────┐    │  └─ TTL (24h)        │ │
│  │ /deploy/         │───>└──────────┬───────────┘ │
│  │   crash-test     │              │              │
│  └──────────────────┘              ▼              │
│                          ┌──────────────────────┐ │
│                          │ repo-maintenance-wf  │ │
│                          │                       │ │
│                          │ 1. diagnose-and-plan  │ │
│                          │    (prompts/diagnose) │ │
│                          │ 2. execute-patch      │ │
│                          │ 3. review             │ │
│                          │ 4. decision-gate      │ │
│                          │ 5. deploy-and-verify  │ │
│                          └──────────────────────┘ │
└──────────────────────────────────────────────────┘
```

## Pliki

| Plik | Opis |
|------|------|
| `src/mastra/services/error-collector.ts` | Serwis ErrorCollector — dedup, cooldown, trigger workflow |
| `src/mastra/services/global-error-handler.ts` | Bootstrap globalnych handlerów `process.on(...)` |
| `src/mastra/prompts/coding/diagnose.md` | Prompt diagnostyczny — ładowany dynamicznie przez workflow |
| `src/mastra/index.ts` | Rejestracja handlerów + endpointy crash-test i status |
| `src/mastra/lib/mongo.ts` | Indeksy dla `auto_healing_tickets` |
| `src/mastra/workflows/repo-maintenance.ts` | Dwa nowe kroki: `diagnose-and-plan` + `execute-patch` |

## Kolekcja MongoDB: `auto_healing_tickets`

```json
{
  "ticketId": "heal-a1b2c3d4-1715214000000",
  "errorSignature": "a1b2c3d4e5f6g7h8",
  "errorMessage": "Cannot read property 'value' of undefined",
  "stackTrace": "TypeError: Cannot read...\n    at ...",
  "context": {
    "source": "uncaughtException",
    "origin": "uncaughtException",
    "metadata": { "processUptime": 3600 }
  },
  "status": "pending | in_progress | resolved | failed | expired",
  "workflowRunId": "run-uuid",
  "createdAt": "2026-05-09T01:30:00.000Z",
  "updatedAt": "2026-05-09T01:30:00.000Z",
  "expiresAt": "2026-05-10T01:30:00.000Z"
}
```

### Indeksy

- `ticketId` — unique
- `errorSignature + status` — deduplikacja
- `status + createdAt` — sortowanie aktywnych
- `expiresAt` — TTL (automatyczne usuwanie)

## Mechanizmy bezpieczeństwa

### 1. Deduplikacja

Błąd jest haszowany (`sha256` z `name + message + top 3 stack lines`) na 16-znakową sygnaturę. Jeśli istnieje ticket z tą samą sygnaturą w statusie `pending` lub `in_progress`, nowy workflow NIE jest odpalany.

### 2. Cooldown

Między kolejnymi triggerami workflow musi upłynąć minimum `ERROR_COLLECTOR_COOLDOWN_MS` (domyślnie 60s). Chroni przed lawiną workflow przy kaskadowych błędach.

### 3. Limit aktywnych

Maksymalnie `ERROR_COLLECTOR_MAX_ACTIVE` (domyślnie 3) jednoczesnych ticketów `pending` + `in_progress`. Po przekroczeniu limitu nowe błędy są ignorowane.

### 4. TTL

Tickety automatycznie wygasają po `ERROR_COLLECTOR_TTL_HOURS` (domyślnie 24h) dzięki indeksowi TTL w MongoDB.

### 5. Self-protection

Błędy rzucone wewnątrz samego `ErrorCollector` NIE triggerują kolejnego heal. Flagą `selfProtectionStack` zapobiegamy nieskończonej rekurencji.

### 6. Ticket resolution

Po udanym `deploy-and-verify` w workflow, jeśli `taskId` zaczyna się od `heal-`, ticket jest automatycznie oznaczany jako `resolved`.

## Konfiguracja ENV

| Zmienna | Domyślna | Opis |
|---------|----------|------|
| `ERROR_COLLECTOR_ENABLED` | `true` | Wyłącza cały ErrorCollector |
| `ERROR_COLLECTOR_COOLDOWN_MS` | `60000` | Cooldown między triggerami (ms) |
| `ERROR_COLLECTOR_MAX_ACTIVE` | `3` | Max jednoczesnych ticketów |
| `ERROR_COLLECTOR_TTL_HOURS` | `24` | TTL ticketów (godziny) |

## Endpointy

### `GET /deploy/crash-test`

Symuluje błąd i odpala ErrorCollector. Parametr `?type=TypeError` kontroluje typ błędu.

Odpowiedź:
```json
{
  "crashSimulated": true,
  "healingTriggered": true,
  "reason": "Workflow triggered",
  "ticketId": "heal-a1b2c3d4-1715214000000",
  "timestamp": "2026-05-09T01:30:00.000Z"
}
```

### `GET /deploy/auto-heal-status`

Zwraca aktywne tickety auto-healing.

Odpowiedź:
```json
{
  "activeTickets": 1,
  "tickets": [...],
  "timestamp": "2026-05-09T01:30:00.000Z"
}
```

## Flow E2E

1. Użytkownik uderza w zepsuty endpoint → błąd runtime
2. `process.on('uncaughtException')` łapie wyjątek
3. `GlobalErrorHandler` przekazuje do `ErrorCollector.reportError()`
4. ErrorCollector:
   - Haszuje błąd → sygnatura
   - Sprawdza dedup (Mongo) → brak duplikatu
   - Sprawdza cooldown → OK
   - Sprawdza limit aktywnych → OK
   - Tworzy ticket w `auto_healing_tickets`
   - Fire-and-forget: `repoMaintenanceWorkflow.createRun().start()`
5. **`diagnose-and-plan`** (nowy krok):
   - Ładuje prompt z `prompts/coding/diagnose.md` (dynamicznie, nie z base.md agenta)
   - codingAgent skanuje: plik błędu, importy, zależności, testy
   - Wypełnia `diagnosticPlan` w artifact: rootCause, impactAnalysis, subtaski
6. **`execute-patch`** (nowy krok):
   - Pobiera `diagnosticPlan` z artifact
   - Realizuje subtaski w kolejności priorytetów
   - Tworzy worktree, edytuje pliki, generuje diff
7. `codeReviewAgent` reviewuje diff
8. `decision-gate` → suspend na zatwierdzenie przez człowieka
9. Po `resume(confirmMerge: true)` → `apply_patch` + `remove_worktree`
10. `deploy-and-verify` → dry-run build + ticket resolution
11. Człowiek dostaje jedynie: *"Fix gotowy. Proszę o zatwierdzenie."*

## Faza diagnostyczna — DiagnosticPlan

Prompt diagnostyczny jest ładowany **dynamicznie** z `prompts/coding/diagnose.md` przez krok workflow — NIE jest częścią stałego prompta agenta (`base.md`). Dzięki temu:

- Gdy user rozmawia z codingAgent w Studio → lekki generalny prompt
- Gdy workflow triggeruje diagnostykę → ciężki diagnostyczny prompt wstrzyknięty przez step
- Gdy Etap 8 doda subagentów → master wstrzykuje subtask-specific prompty workerom

### Schema diagnosticPlan w artifact

```json
{
  "rootCause": "Brak null-checku na property 'value' w handlerze",
  "hypothesis": "Endpoint nie waliduje wejścia, undefined propaguje do handlera",
  "impactAnalysis": {
    "errorFile": "src/mastra/index.ts",
    "errorLine": 42,
    "directFiles": ["src/mastra/routes/api.ts"],
    "dependentFiles": ["src/mastra/services/handler.ts"],
    "testFiles": [],
    "configFiles": ["deploy.config.json"]
  },
  "riskLevel": "low",
  "riskJustification": "Izolowany handler, brak efektów ubocznych",
  "subtasks": [
    {
      "id": "add-null-check",
      "description": "Dodaj walidację wejścia",
      "targetFiles": ["src/mastra/routes/api.ts"],
      "type": "edit",
      "priority": 1,
      "estimatedComplexity": "trivial",
      "dependencies": []
    }
  ],
  "verificationPlan": {
    "commands": ["npx tsc --noEmit"],
    "expectedOutcome": "Zero błędów kompilacji"
  }
}
```

Ta struktura jest gotowa do dekompozycji na subagentów w **Etapie 8** — każdy subtask może być przekazany osobnemu workerowi.

---

## Aktualizacja: Etap 0 autoheal — quick fixes (2026-06-08)

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 0. Poprawki po audycie self-healingu.

### 0.2 — Koniec fałszywego „healed" na dry-run

Wcześniej `deploy-and-verify` oznaczał ticket jako `resolved`, gdy deploy zakończył się `DRY RUN COMPLETE` — mimo że **dry-run nie przełącza Live** (bug nadal działa w runtime). Teraz:

- ticket `heal-*` jest rozwiązywany **tylko po realnym swapie** (`SWAP COMPLETE` / `DEPLOY COMPLETE`),
- po samym dry-run ticket **pozostaje otwarty**, a log jasno informuje, że Live wciąż ma stary kod.

Plik: `src/mastra/workflows/repo-maintenance.ts` (`deployAndVerify`).

### 0.4 — Stabilizacja dedupu sygnatury (anty-wyciek worktrees)

`ticketId = heal-<sig>-<ts>` zawiera timestamp → ta sama sygnatura po `failed/expired` tworzyła nowy ticket → nowy worktree (źródło osieroconych branchy). Dodano w `error-collector.ts`:

- **twardy limit prób na sygnaturę** (`ERROR_COLLECTOR_MAX_ATTEMPTS_PER_SIGNATURE`, domyślnie 3) — po przekroczeniu błąd nie odpala kolejnego healu (kandydat do `failed_needs_human` w Etapie 7),
- **backoff po porażce** (`ERROR_COLLECTOR_RETRY_BACKOFF_MS`, domyślnie 600000 ms) — niedawno nieudana sygnatura nie jest ponawiana natychmiast.

### Nowe zmienne ENV

| Zmienna | Domyślna | Opis |
|---------|----------|------|
| `ERROR_COLLECTOR_MAX_ATTEMPTS_PER_SIGNATURE` | `3` | Maks. ticketów (łącznie) na jedną sygnaturę błędu |
| `ERROR_COLLECTOR_RETRY_BACKOFF_MS` | `600000` | Okno backoffu po `failed/expired` dla tej samej sygnatury |

> Pełna deduplikacja per-cykl (zamiast per-ticket) i likwidacja worktree-per-task przychodzą w Etapach 1–2.
