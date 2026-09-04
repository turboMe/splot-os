# Task Ledger — jedno źródło prawdy o pracy systemu (Etap 1)

> Implementacja Etapu 1 planu `ideas/IDEALSYSTEMMASTERPLAN.md` (blueprint §3.2).
> Wdrożono: 2026-07-20, branch `feat/ideal-system-etap-1-task-ledger`.
> Feature flag: `FEATURE_LEDGER_V1` (default **ON**; rollback = `FEATURE_LEDGER_V1=false`).

## Co to jest

Kolekcja Mongo `task_ledger` — każda jednostka pracy w tle (lane) ma jeden rekord.
Ledger **tylko obserwuje**: czterej pisarze lifecycle'u raportują przez fail-safe
adaptery, ich własna logika jest nietknięta. Odpowiedź na „co się dzieje w systemie?"
= jedna tania kwerenda (digest czytany w ~5 ms przy działających lane'ach), nigdy
przerywanie pracy agentów.

## Model danych (`services/task-ledger.ts`)

```
LaneRecord {
  laneId, laneNo (numer dla operatora: "#17"),
  source: async_delegation | background_task | automation_job | cron | manual,
  sourceId (id w kolekcji pisarza), goal, agentId, threadId,
  state: queued → running ↔ blocked/awaiting_approval → done/failed/cancelled,
  priority, budget { capUsd, spentUsd }, claims[] (scheduler w E5),
  heartbeatAt, staleAfterMs, milestones[], artifacts[], plans[],
  parent/children, pauseRequested, cancelRequested, digestedAt
}
```

Przejścia walidowane (`transitionLane` rzuca na nielegalne); szybkie ścieżki błędów
mogą iść `queued → done/failed` przez implicit start. Lane bez heartbeatu dłużej niż
`staleAfterMs` jest domykany jako `failed(stale)` przez leniwy reconciler przy odczycie
digestu (bez dodatkowego crona).

## Pisarze (adaptery — Etap 1)

| Pisarz | Punkty wpięcia | Heartbeat / staleness |
|---|---|---|
| `async-delegation.ts` | start → running; wynik → done/failed | brak pętli; `staleAfterMs = timeout + 120 s` |
| `background-task-manager.ts` | spawn → running; exit → done/failed; error → failed; cancel → cancelled | brak pętli; `staleAfterMs = TTL` (24 h default) |
| `automation-job-manager.ts` | insert → queued; start → running; wynik → done/failed; cancel → cancelled | realny heartbeat co 5 s (`ledgerTouchBySource`), stale po 15 min |
| `cron-runner.ts` | trigger → lane efemeryczny (done/failed w jednym kroku) | n/d — lane rejestruje **wynik triggera**, nie lifecycle workflow (ten żyje w serwerze Mastra) |

Wszystkie zapisy są fire-and-forget (`void`, catch + warn) — awaria Mongo/ledgera nigdy
nie psuje właściwej pracy.

## Odczyt — protokół tury meta

1. `checkPendingUpdates` zwraca teraz dodatkowo `laneDigest` (running / needs-attention /
   finished-since-last-check). Lane'y zakończone są raportowane **dokładnie raz**
   (pole `digestedAt`, konsumuje tylko meta).
2. `pendingUpdatesProcessor` wstrzykuje blok tylko dla lane'ów wymagających uwagi
   (blocked / awaiting_approval / kill switch) — świadomie wąsko, żeby nie puchły tokeny.
3. Sekcja **Turn protocol** w `prompts/meta/base.md` (v3.1): digest przed odpowiedzią,
   klasyfikacja QUESTION/TASK/GOAL, komendy operatora.

## Toole operatora (`tools/system/ledger-tools.ts`, zarejestrowane u meta)

- `ledger_status()` — digest; `ledger_status(laneId: 17)` — szczegół lane'a (milestones, artefakty).
- `ledger_control(action, laneId?, priority?)`:
  - `cancel` — twardy kill dla `background_task`/`automation_job` (przez ich managery);
    dla `async_delegation` w E1 tylko flaga + zamknięcie lane'a (promise nie ma kill-switcha — run drenuje do timeoutu);
  - `pause`/`resume` — pełne dla `queued`, dla `running` flaga `pauseRequested` (egzekwowanie → scheduler E5);
  - `priority` — pole dla schedulera E5;
  - `pause_all`/`resume_all` — globalny **kill switch** (dokument w `task_ledger_settings`,
    widoczny w każdym digeście).

## Push na telefon

Przejścia do `blocked | awaiting_approval | done | failed` POST-ują JSON na
`LEDGER_PUSH_WEBHOOK_URL` (timeout 5 s, fire-and-forget). Wdrożony workflow n8n
**„Mastra - Task Ledger Push (Telegram)"** (id `9AfovUJUIvhghzll`, aktywny):
webhook `POST /webhook/mastra-ledger-push` → Telegram (chat 578179283).
Zweryfikowano e2e 2026-07-20 (execution success). Wyłączenie: pusty
`LEDGER_PUSH_WEBHOOK_URL` albo deaktywacja workflow.

**Uwaga:** działający serwer Mastra czyta env przy starcie — po dodaniu
`LEDGER_PUSH_WEBHOOK_URL` do `.env` push z procesu serwera ruszy po jego restarcie.

## Testy

- `npm run check:ledger-lifecycle` — state machine, unikalność, stale-reconciler,
  digest-once, kontrole, kill switch (14 asercji, bez LLM).
- `npm run e2e:ledger-three-lanes` — 3 RÓWNOLEGŁE lane'y przez prawdziwy
  background-task-manager: digest mid-flight (3× running, odczyt <1,5 s),
  wyniki 2×done + 1×failed z zachowanym exit code, `laneDigest` w
  `checkPendingUpdates`, raportowanie finished-once.
- `npm run check:all` — nowa brama zbiorcza (C2.3): wszystkie deterministyczne
  checki + oba powyższe. Poza bramą (celowo): `typecheck` (3 pre-existing błędy
  scheduled-task), checki wymagające żywego n8n/serwera (`check:n8n-runtime`,
  `check:n8n-mcp-pipeline-smoke`, `check:automation-live-safe-webhook`, `e2e:webhook`).

## Ograniczenia E1 (świadome — patrz plan E5)

- Claims są **zapisywane**, ale nie schedulowane (kolizje/kolejka → Etap 5).
- Pauza działającego lane'a = tylko flaga (preempcja → scheduler E5).
- Kill switch jest surfacowany w digest/prompt, ale nie blokuje jeszcze twardo
  `startAsyncDelegation` (egzekwowanie przy schedulerze E5).
- Lane crona rejestruje trigger, nie przebieg workflow (lifecycle workflowów
  Mastra → osobne wpięcie, rozważane w E5/E8).
