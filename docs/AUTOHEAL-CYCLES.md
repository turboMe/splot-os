# Autoheal — Cycle Store & Plik Stanu (Etap 1)

Aktualizacja: 2026-06-08

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 1.
Plan docelowy: [ideas/autoheal-update.md](../ideas/autoheal-update.md) (Phase 2: Dedup & Cycle Grouping).

## Problem

Dotychczas każde wystąpienie błędu tworzyło ticket `heal-<sygnatura>-<timestamp>`. Timestamp w ID
oznaczał, że **ta sama sygnatura po `failed/expired` rodziła nowy ticket → nowy worktree** — realne
źródło mnożenia osieroconych worktrees/branchy. Brakowało też **jednostki grupującej** jeden problem
(diagnoza + wszystkie próby naprawy) oraz **trwałego stanu runtime poza procesem Mastry**.

## Rozwiązanie (warstwa additive, observe-only)

Etap 1 jest **czysto dodatkowy** — nie zmienia jeszcze zachowania worktree ani promote/rollback.
Wprowadza dwie niezależne warstwy:

1. **Cycle Store (Mongo, diagnostyka)** — jedna sygnatura = jeden cykl; kolejne wystąpienia dopisują obserwację.
2. **Plik stanu (`.deploy/autoheal-state.json`, krytyczny)** — prawda o runtime żyje POZA Mongo i POZA Mastrą.

> Zasada nadrzędna: rollback i dostępność runtime **nigdy** nie zależą od Mongo, LLM ani endpointów Mastry.
> Cycle Store to wygoda analityczna; krytyczny stan to plik + PID/porty.

## Kolekcje MongoDB

| Kolekcja | Rola | Kluczowe indeksy |
|----------|------|------------------|
| `autoheal_cycles` | jeden cykl naprawczy per sygnatura | `cycleId` (unique), `signature+status`, `status+updatedAt` |
| `autoheal_attempts` | próby naprawy w ramach cyklu (candidate/canary/rollback) | `attemptId` (unique), `cycleId+createdAt` |
| `autoheal_runtime_events` | surowe obserwacje wystąpień błędu | `cycleId+createdAt`, `signature+createdAt` |

Indeksy zakładane w `src/mastra/lib/mongo-indexes.ts` (żywy `ensureIndexes` wpięty w `index.ts` — **nie** `lib/mongo.ts`).

### Model `AutohealCycle`

```ts
type AutohealCycleStatus =
  | 'observed' | 'diagnosing' | 'repairing'
  | 'candidate_building' | 'candidate_running' | 'canary'
  | 'promoted' | 'rolled_back' | 'retrying' | 'failed_needs_human';

interface AutohealCycle {
  cycleId: string;            // cycle-<signature>-<ts>
  signature: string;          // sha256(name+message+top stack), 16 znaków
  status: AutohealCycleStatus;
  stableCommit: string;       // git short SHA HEAD w chwili otwarcia cyklu
  repairBranch: 'autoheal/repair';
  currentCandidateCommit?: string;
  observationCount: number;   // ile wystąpień tej sygnatury w cyklu
  ticketId?: string;          // most do auto_healing_tickets (Etap 7)
  createdAt: string; updatedAt: string; lastObservedAt: string;
}
```

**Stany terminalne** (`TERMINAL_CYCLE_STATUSES`): `promoted`, `failed_needs_human`.
Cykl o statusie terminalnym **nie jest aktywny** — kolejne wystąpienie tej samej sygnatury otworzy nowy cykl.

## Plik krytyczny `.deploy/autoheal-state.json`

Lokalizacja: katalog `.deploy/` w **root projektu** (nad `agentic-agents`).
Override: ENV `AUTOHEAL_STATE_FILE` (pełna ścieżka) lub `AUTOHEAL_RUNTIME_DIR` (rodzic = `.deploy`).

```json
{
  "stableCommit": "abc1234",
  "activeSlot": "slot-a",
  "activePid": 12345,
  "activePort": 4111,
  "lastPromotedAt": "2026-06-08T12:00:00.000Z",
  "state": "stable",
  "updatedAt": "2026-06-08T12:00:00.000Z"
}
```

Pola `candidateCommit`, `previousSlot`, `previousPid`, `rollbackDeadline`, `state` są zarezerwowane dla
supervisora (Etap 3) i ścieżki promote/canary/rollback (Etap 5).

Moduł: `src/mastra/services/autoheal-state.ts`
- `readState()` — null gdy brak/uszkodzony plik (bezpieczne dla supervisora),
- `writeState()` / `patchState()` — **zapis ATOMOWY** (`tmp + rename`), żeby supervisor nie odczytał połowicznego stanu w trakcie crashu,
- `getStatePath()` — rozwiązuje ścieżkę z ENV/konwencji.

## Integracja z ErrorCollector

W `services/error-collector.ts` (`_processError`):

1. Liczona sygnatura błędu.
2. **PRZED** cooldownem/dedupem: `getOrCreateCycle(signature, observation)` — obserwacja zapisana **zawsze**
   (nawet gdy cooldown zablokuje trigger workflow), do `autoheal_runtime_events`.
3. Aktywny cykl tej samej sygnatury → `observationCount++`, **bez nowego cyklu i bez nowego worktree**.
4. Gdy powstaje ticket → `linkTicketToCycle(cycleId, ticketId)` (most do Etapu 7).

Cała warstwa jest w `try/catch` i **niekrytyczna**: awaria Mongo nie blokuje healingu.

## Endpointy diagnostyczne (read-only)

| Endpoint | Zwraca |
|----------|--------|
| `GET /deploy/autoheal-cycles?limit=50` | lista cykli (sort `updatedAt` desc) |
| `GET /deploy/autoheal-attempts/:cycleId` | cykl + `attempts[]` + `observations[]` |
| `GET /deploy/runtime-status` | `persistedState` z pliku + `liveProcess` (pid/slot/port/version/uptime) |

Endpointy są **wyłącznie diagnostyczne** — rollback supervisora ich nie używa (czyta plik stanu bezpośrednio).

## Test antyregresyjny

Dwa błędy tej samej sygnatury → **1 cykl, 2 obserwacje, 0 nowych worktree**. Zweryfikowane smoke-testem
replikującym `getOrCreateCycle` na realnym Mongo (`cycleCount=1`, `observationCount=2`, `runtime_events=2`).

## Co dalej

- **Etap 2:** persistent repair lane (`agentic-agents-repair`) — autoheal przestaje tworzyć worktree-per-task,
  cykl steruje resetem repair lane. Wtedy `cycleId/attemptId` staje się scope ledgeru zamiast `worktree per task`.
- **Etap 3:** supervisor poza Mastrą zapisuje/odczytuje `.deploy/autoheal-state.json`.
