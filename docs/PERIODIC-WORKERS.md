# Periodic Worker Manager (P2)

Aktualizacja: 2026-06-10 | Status: **Zaimplementowane**

Cykliczne workery tła do monitoringu zdrowia systemu, dostępności modeli, czyszczenia cache,
agregacji telemetrii i konsolidacji pamięci. Wcześniej Mastra miała tylko **one-shot**
`background-task-manager` — brakowało warstwy z timerami. Framework zaadaptowany z Ruflo
(`v3/@claude-flow/hooks/src/workers/index.ts`), ale przepisany natywnie pod Mastrę,
podpięty pod **istniejącą** infrastrukturę i bez nowych zależności.

## Architektura

```
[index.ts startup] → getPeriodicWorkerManager().startAll()
                          │
            ┌─────────────┼───────────────┬───────────────┬──────────────┐
         health(5m)   models(10m)     cache(60m)    telemetry(30m)   memory(15m)
            │             │               │               │              │
         os/gpu-guard  verifyAllModels cleanupBg…    agent_events    extractKnowledge
            │             │               │               │              │
            └─────────────┴───────────────┴───────────────┴──────────────┘
                          │
              każdy run → ring buffer (in-memory, 20) + worker_metrics (Mongo, TTL 7d)
                          │
              status != healthy → logHarnessEvent('worker_alert') + console.warn
```

## Wbudowane workery

| Worker | Interwał | Co robi | Wykorzystuje istniejące | Metryki |
|---|:--:|---|---|---|
| `health` | 5 min | RAM / disk / uptime / VRAM | `os`, `fs.statfs`, `gpu-guard.ts` | `ramUsagePercent`, `diskUsagePercent`, `vramFreeMb`, `loadAvg1m` |
| `models` | 10 min | dostępność Ollama + cloud | `model-availability.ts` | `localAvailable`, `localUnavailable`, `cloudUnavailable` |
| `cache` | 60 min | sprzątanie zakończonych zadań tła | `cleanupBackgroundTasks()` | `removedBackgroundTasks`, `errors` |
| `telemetry` | 30 min | 1h error rate z `agent_events` | kolekcja `agent_events` | `eventsLastHour`, `errorsLastHour`, `errorRate1h` |
| `memory` | 15 min | konsolidacja `system_knowledge` | `memory-extractor.ts` | `knowledgeExtracted` |

## Progi alertów

```typescript
ALERT_THRESHOLDS = {
  ramUsagePercent:  { warn: 80, critical: 95 },
  diskUsagePercent: { warn: 85, critical: 95 },
  errorRate1h:      { warn: 0.3, critical: 0.5 },
};
```

Przekroczenie progu → status `warning`/`critical` → `logHarnessEvent('worker_alert')` + `console.warn`.
Status workera jest też zapisywany do kolekcji `worker_metrics`.

## API publiczne (framework)

```typescript
import {
  getPeriodicWorkerManager,
  registerWorker,
  startAll,
  stopAll,
  getWorkerStatus,
  type PeriodicWorker,
  type WorkerResult,
} from './services/periodic-worker-manager.js';

// własny worker
registerWorker({
  id: 'my-worker',
  name: 'My Worker',
  intervalMs: 5 * 60 * 1000,
  enabled: true,
  handler: async (): Promise<WorkerResult> => ({
    status: 'healthy',
    metrics: { processed: 42 },
  }),
});
```

Gwarancje: pojedynczy worker nie blokuje innych, runy nie nakładają się (`running` guard),
błąd handlera jest łapany (inkrementuje `consecutiveFailures`, nie wywala procesu),
a persystencja do Mongo jest best-effort (`worker_metrics` z TTL 7 dni).

## Endpoint statusu

`GET /deploy/workers-status` — zwraca zagregowany status (`healthy`/`warning`/`critical`)
i stan każdego workera (ostatni run, metryki, ring buffer ostatnich 20 runów).

> **Uwaga:** prefix `/api` jest zarezerwowany przez Mastrę dla wewnętrznych routów, dlatego
> endpoint żyje pod `/deploy/...` zgodnie z konwencją pozostałych statusów (`/deploy/gpu-status` itp.).

```json
{
  "overall": "healthy",
  "count": 5,
  "workers": [
    { "id": "health", "lastStatus": "healthy", "lastMetrics": { "ramUsagePercent": 38, ... }, "recent": [...] }
  ],
  "timestamp": "2026-06-10T..."
}
```

## Integracja przy starcie

`startAll()` jest wywoływane w `src/mastra/index.ts` po inicjalizacji RepoIndexera.
`stopAll()` jest wołane w `cleanupAndExit()` (graceful shutdown / hot-reload), żeby timery
nie przeciekały między restartami `mastra dev`.

## Pliki źródłowe

| Plik | Opis |
|------|------|
| `src/mastra/services/periodic-worker-manager.ts` | Manager + 5 wbudowanych workerów |
| `src/mastra/lib/agent-event-log.ts` | Nowe typy `worker_run_started/completed/failed`, `worker_alert` |
| `src/mastra/services/harness-events.ts` | Rejestracja `worker_*` w `HARNESS_EVENT_TYPES` |
| `src/mastra/lib/mongo.ts` | Indeksy + TTL kolekcji `worker_metrics` |
| `src/mastra/index.ts` | `startAll()`/`stopAll()` + endpoint `/deploy/workers-status` |

## Nowa kolekcja MongoDB

| Kolekcja | Indeksy | TTL |
|---|---|:--:|
| `worker_metrics` | `{workerId, timestamp}`, `{status, timestamp}`, `{expiresAt}` | 7 dni (`expireAfterSeconds: 0` na `expiresAt`) |

## Możliwe rozszerzenia (poza zakresem P2)

- `dashboard-stats.ts` może czytać `worker_metrics` do widoku trendów w dashboardzie.
- Dodatkowe workery (np. recertyfikacja tuneli n8n) przez `registerWorker()`.
