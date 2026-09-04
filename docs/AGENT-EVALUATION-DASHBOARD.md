# Agent Evaluation Dashboard

> **Status:** ✅ Sprint 1 + 2 + 3 zakończone — dane + API + tool + UI + **automatyczna telemetria**.
> **Otwórz dashboard:** http://localhost:4111/dashboard-ui (po `npm run dev`)
> **Lokalizacja kodu:** `src/mastra/lib/model-pricing.ts`, `src/mastra/services/dashboard-stats.ts`, `src/mastra/services/mongo-telemetry-exporter.ts`, `src/mastra/tools/system/agent-performance-report.ts`, `dashboard/index.html`, `src/mastra/index.ts`
> **Audyt:** kat. 19 (Self-Improvement)

---

## Co to jest

Warstwa agregacji telemetrii agentów — odpowiada na pytania:

- Który agent ma najlepszy success rate?
- Ile wydaliśmy w tym tygodniu na cloud LLM?
- Który skill jest używany najczęściej?
- Który agent ma największą latencję (P95/P99)?
- Czy scorery wskazują na regresję jakości?

Wszystko czytane z **istniejących źródeł** — żadna nowa kolekcja nie była potrzebna:

| Źródło | Co tam jest |
|--------|-------------|
| `agent_events` (MongoDB) | Logi tasków, tool calls, błędów, opóźnień, użycia tokenów |
| `mastra_scorers` (MongoDB) | Wyniki scorerów (Mastra zapisuje to **automatycznie** gdy `sampling.rate > 0`) |

---

## Quick Start

```bash
# Uruchom serwer Mastra (włącznie z dashboardem — żaden osobny proces nie jest potrzebny)
npm run dev

# Otwórz w przeglądarce
http://localhost:4111/dashboard-ui
```

Dashboard automatycznie ładuje dane z `/dashboard/*` JSON endpoints. Filtry: window (24h / 7d / 14d / 30d / 90d), granularity (hour/day), auto-refresh (30s).

---

## Architektura

```
┌─────────────────────────────────────────────────────────────┐
│ DATA LAYER                                                   │
│ ├─ agent_events     (logAgentEvent — własna telemetry)      │
│ └─ mastra_scorers   (Mastra storage — saveScore automatic)  │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │ aggregation pipelines
                           │
┌─────────────────────────────────────────────────────────────┐
│ services/dashboard-stats.ts                                  │
│ ├─ getOverview(window)              high-level summary       │
│ ├─ getAgentSuccessRates(window)     per-agent breakdown      │
│ ├─ getSkillUsageStats(window)       skill_used events        │
│ ├─ getModelBreakdown(window)        per-model usage + cost   │
│ ├─ getLatencyPercentiles(window)    P50/P95/P99              │
│ ├─ getCostBreakdown(window)         USD per agent/model/day  │
│ ├─ getScoreStats(window)            scorer results agg.      │
│ └─ getTimeline(window, granularity) hour/day buckets         │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
        ┌──────────────────┼──────────────────┬──────────────┐
        ▼                  ▼                  ▼              ▼
┌─────────────────┐ ┌─────────────────┐ ┌──────────────┐ ┌─────────────┐
│ HTTP JSON API   │ │ DASHBOARD UI    │ │ AGENT TOOL   │ │ ANALYTICS   │
│ /dashboard/*    │ │ /dashboard-ui   │ │ system.agent │ │ AGENT       │
│ (8 endpoints)   │ │ (HTML + JS +    │ │ _performance │ │ (always-on) │
│                 │ │  Chart.js)      │ │ _report      │ │             │
└─────────────────┘ └─────────────────┘ └──────────────┘ └─────────────┘
```

---

## Pricing (USD per 1M tokens)

`lib/model-pricing.ts` zawiera hardcoded ceny dla głównych modeli, plus override przez env var:

```bash
# Nadpisanie pricingu dla pojedynczych modeli
export MODEL_PRICING_OVERRIDE_JSON='{"my-custom-model":{"inputPer1M":1.0,"outputPer1M":2.0,"provider":"openai"}}'
```

Zaseedowane modele (stan na 2026-05):

| Model | Input $/1M | Output $/1M | Provider |
|-------|-----------|-------------|----------|
| claude-opus-4-7 | $15 | $75 | anthropic |
| claude-sonnet-4-6 | $3 | $15 | anthropic |
| claude-haiku-4-5 | $1 | $5 | anthropic |
| gpt-4o | $2.50 | $10 | openai |
| gpt-4o-mini | $0.15 | $0.60 | openai |
| o1 | $15 | $60 | openai |
| gemini-2.5-pro | $1.25 | $5 | google |
| gemini-2.5-flash | $0.075 | $0.30 | google |
| qwen3:* / llama3.1:* (Ollama) | $0 | $0 | ollama (local GPU) |

Modele nieznane: koszt = 0, provider = "unknown" (nie psuje agregacji, tylko zaniża sumę — dodaj je do tabeli żeby widzieć prawdziwy koszt).

---

## API Endpoints

Wszystkie endpointy:
- są **read-only**
- akceptują query params: `?since=<window>` i `?until=<ISO_date>`
- `since` może być relatywne (`7d`, `24h`, `30m`) lub ISO date (`2026-05-01`)
- domyślne okno: ostatnie **7 dni**

### Lista endpointów

| Endpoint | Co zwraca |
|----------|-----------|
| `GET /dashboard/overview` | Summary: totalTasks, successRate, totalCostUsd, avgLatencyMs |
| `GET /dashboard/agents` | Per-agent: tasks, success rate, latency, cost, tokens |
| `GET /dashboard/skills` | Per-skill: uses, agents, avg duration |
| `GET /dashboard/models` | Per-model: invocations, tokens, cost, agents using it |
| `GET /dashboard/latency` | Per-agent P50/P95/P99 latency |
| `GET /dashboard/cost` | Cost USD: byAgent + byModel + byDay |
| `GET /dashboard/scores` | Scorer results: avg score, pass rate, distribution |
| `GET /dashboard/timeline?granularity=hour\|day` | Event counts bucketed |

### Przykłady

```bash
# Last 24h overview
curl http://localhost:4111/dashboard/overview?since=24h

# Cost breakdown for May 2026
curl "http://localhost:4111/dashboard/cost?since=2026-05-01&until=2026-05-31"

# Latency percentiles last 7 days
curl http://localhost:4111/dashboard/latency

# Score quality drift over last 30 days
curl http://localhost:4111/dashboard/scores?since=30d
```

### Przykładowa odpowiedź `/dashboard/overview`

```json
{
  "window": { "from": "2026-05-02T...", "to": "2026-05-09T..." },
  "totalTasks": 142,
  "successRate": 0.937,
  "totalErrors": 9,
  "totalToolCalls": 487,
  "toolErrorRate": 0.018,
  "totalTokens": 1283450,
  "totalCostUsd": 4.213789,
  "uniqueAgents": 8,
  "uniqueModels": 5,
  "avgLatencyMs": 3128
}
```

---

## Agent tool: `system.agent_performance_report`

Ten sam dataset, ale dostępny dla agentów — żeby meta-agent / analytics-agent mógł sam analizować swoje performance.

### Sygnatura

```typescript
{
  since?: "7d" | "24h" | "2026-05-01"     // default: "7d"
  until?: "2026-05-09"                     // default: now
  agentId?: "meta-agent"                   // filter to single agent
  includeBreakdown?: ["agents", "skills", "models", "latency", "cost", "scores"]
}
```

### Zwraca

- `period` — okno dat
- `overview` — top-level stats (zawsze)
- `breakdown` — wybrane sekcje
- `summary` — gotowy markdown do wyświetlenia userowi

### Przykładowe wywołanie przez agenta

User pyta: *"Ile wydaliśmy w tym tygodniu na cloud LLM i który agent najwięcej?"*

Agent wywołuje:
```javascript
system.agent_performance_report({
  since: "7d",
  includeBreakdown: ["cost", "models"]
})
```

Odpowiedź zawiera `summary`:
```
📊 Performance report — 2026-05-02 → 2026-05-09
Tasks: 142 | Success: 93.7% | Cost: $4.2138 | Avg latency: 3128ms | Agents: 8

Top models:
  • claude-sonnet-4-6: 234× — $3.4521
  • gpt-4o-mini: 156× — $0.1234
  • qwen3:14b: 412× — $0.0000

Most expensive agent: meta-agent — $2.8721
```

Zarejestrowane w:
- `meta-agent` — w ToolSearchProcessor pool (discoverable on demand)
- `analytics-agent` — w bazowych tools (zawsze dostępne)

---

## Skąd biorą się dane

### `agent_events` (auto-telemetria via Mastra Observability)

**Wszystkie agent runs są zapisywane AUTOMATYCZNIE** przez `MongoTelemetryExporter`
(zarejestrowany w `Observability` config w `index.ts`). Bez ręcznego instrumentowania.

Mechanizm:
- Mastra dla każdego `agent.generate()` / `agent.stream()` tworzy `AGENT_RUN` span (root)
- Child spans: `MODEL_GENERATION` (per LLM call), `TOOL_CALL` (per tool invocation)
- `MongoTelemetryExporter` implementuje `BaseExporter` z `@mastra/observability`
- Akumuluje token usage + model per `traceId` z `MODEL_GENERATION` spans
- Gdy `AGENT_RUN` SPAN_ENDED → loguje `task_completed` / `task_failed` z pełnymi danymi
- `TOOL_CALL` SPAN_ENDED → loguje `tool_called` / `tool_error`
- Fire-and-forget: błąd telemetry nigdy nie blokuje agenta

Eventy automatycznie wpadają do MongoDB:
- `task_completed` — agent zakończył sukcesem (z `durationMs`, `tokenUsage`, `model`)
- `task_failed` — błąd w agent run (z `errorMessage`)
- `tool_called` / `tool_error` — per tool invocation (z `toolId`, `durationMs`)

Eventy które nadal wymagają ręcznego `logAgentEvent()`:
- `skill_used` — gdy agent użył skilla (TODO: można dodać do MongoTelemetryExporter)
- `delegation`, `retry_*`, `autoheal_*`, `approval_*` — emit przez własne hooki (np. `delegate-task.ts`)

**Bonus:** LLM-based scorers (np. `translation-quality-scorer`) tworzą wewnętrzne AGENT_RUN spany,
więc widzimy też ich koszt i latency w dashboardzie (jako pseudo-agent `judge`).

### `mastra_scorers` (zarządzane przez Mastra)

Mastra **automatycznie** zapisuje wynik scorera do `mastra_scorers` gdy:
1. Scorer jest zarejestrowany w agencie (`scorers: { ... }`)
2. `sampling.rate > 0`
3. Storage backend ma scores domain (MongoDB tak, mamy `MongoDBStore`)

Schema (skrót):
```
{ id, scorerId, entityId, entityType: 'AGENT', runId,
  score: number, source: 'LIVE'|'TEST',
  scorer: {...}, entity: {...},
  analyzeStepResult, preprocessStepResult,
  createdAt, updatedAt }
```

---

## Wymagania uruchomieniowe

- **MongoDB 7.0+** — `getLatencyPercentiles()` używa `$percentile` (wymaga MongoDB 7.0). Mamy `mongo:7` w docker-compose ✅
- **Storage scopes** — Scores domain w composite store (już skonfigurowany ✅)

---

## UI Dashboard (Sprint 2 — done)

**Lokalizacja:** [`dashboard/index.html`](../dashboard/index.html) — pojedynczy plik HTML.

**Stack (zero-build):**
- Vanilla JS (ES2022 modules) — bez React/Vite/build step
- [Chart.js 4.4.6](https://www.chartjs.org/) via jsdelivr CDN
- Inline CSS (~150 linii, dark theme, ~250 zmiennych CSS)

**Komponenty na ekranie:**
1. **Filters bar** — window picker (24h/7d/14d/30d/90d), granularity (hour/day), refresh button, auto-refresh toggle (30s), status indicator
2. **Overview cards** — 5 metryk: Tasks, Success Rate, Cost, Avg Latency, Tool Calls
3. **Agents & Models** — bar chart (success/failure stacked) + doughnut chart (cost by model)
4. **Cost & Latency** — line chart (USD per day) + grouped bar chart (P50/P95/P99 per agent)
5. **Activity & Skills** — stacked area timeline + horizontal bar chart (top 10 skills)
6. **Detailed Tables** — agents / models / scorers (z pill badges dla success rate i avg score)

**Kolory:** zielony >=90% success, żółty 70-90%, czerwony <70%. Cost-aware: jeśli wszystkie modele to local Ollama ($0), pie chart automatycznie przełącza się na invocations zamiast cost.

**Serwowanie:** `/dashboard-ui` route w `index.ts` czyta plik z dysku przy każdym requeście (`fs.readFile`). Hot-reload działa — edytujesz HTML, zmieniasz okno, F5 i widzisz zmiany. Bez build step.

---

## Co NIE jest jeszcze zrobione (backlog)

| Funkcjonalność | Status | Notatka |
|---------------|--------|---------|
| Skill→event linkage (`skill_used` events) | ⏳ Backlog | MongoTelemetryExporter loguje tylko AGENT_RUN/TOOL_CALL/MODEL_GEN. Skill registry by emitować przez własny hook |
| Analytics V2 API/cache docs | ✅ Done | Szczegóły: [`ANALYTICS-DASHBOARD-V2.md`](ANALYTICS-DASHBOARD-V2.md) |
| Alerty (np. "success rate spadł poniżej 80%") | ⏳ Backlog | Można wbudować przez Telegram tool z workflow cron |
| Daily rollup → `agent_events_daily` | ⏳ Backlog | Gdy `agent_events` urośnie >1M rekordów |
| Drill-down: klik w wiersz tabeli → szczegóły taska | ⏳ Backlog | Wymaga nowego endpointu `/dashboard/task/:id` z trace tree |
| Per-event cost (zapis kosztu w `agent_events`) | ⏳ Możliwe | Aktualnie cost liczony on-the-fly przy agregacji (ok dla MVP) |

---

## Walidacja

### TypeScript
```bash
npx tsc --noEmit  # ✅ czysta kompilacja
```

### Smoke test API (po starcie serwera)
```bash
curl -s http://localhost:4111/dashboard/overview | jq .
curl -s http://localhost:4111/dashboard/agents | jq '.data[0]'
curl -s http://localhost:4111/dashboard/cost?since=24h | jq .
```

### Smoke test agent tool

W Mastra Studio, do meta-agent:
> "Pokaż mi raport wydajności z ostatnich 7 dni z breakdown na koszty i modele."

Meta powinien wywołać `system.agent_performance_report({ since: "7d", includeBreakdown: ["cost", "models"] })`.

---

## Rozszerzanie

### Dodanie nowego breakdown

1. Napisz funkcję agregującą w `services/dashboard-stats.ts`
2. Dodaj API route w `index.ts`
3. (Opcjonalnie) dodaj key do `BREAKDOWNS` w `agent-performance-report.ts`
4. Dodaj sekcję do `buildSummary()` jeśli ma być w summary

### Aktualizacja cen modeli

Edytuj `DEFAULT_MODEL_PRICING` w `lib/model-pricing.ts` lub ustaw `MODEL_PRICING_OVERRIDE_JSON` w `.env`.

### Nowy scorer

Wystarczy zarejestrować w agencie z `sampling.rate > 0`. Mastra automatycznie zapisze do `mastra_scorers`. `getScoreStats()` zacznie pokazywać go natychmiast.

---

## Troubleshooting

### `/dashboard/overview` zwraca `totalTasks: 0`

Brak event'ów `task_completed` lub `task_failed` w okresie. Sprawdź:
```bash
db.query({ collection: "agent_events", operation: "count",
  filter: { type: { $in: ["task_completed", "task_failed"] } } })
```

Jeśli 0 — `MongoTelemetryExporter` nie jest zarejestrowany. Zweryfikuj w `index.ts`:
```typescript
observability: new Observability({
  configs: { default: {
    exporters: [
      new DefaultExporter(),
      new CloudExporter(),
      new MongoTelemetryExporter(),  // ← musi być TUTAJ
    ],
  }},
})
```

Jeśli zarejestrowany ale wciąż 0 — sprawdź czy żaden agent w ogóle nie był wywołany w okresie:
```bash
db.query({ collection: "agent_events", operation: "count" })  # bez filtru
```

### `/dashboard/scores` zwraca pustą tablicę

Mastra nie zapisuje scorów. Możliwe przyczyny:
1. Brak scorerów zarejestrowanych w agentach (sprawdź `agents/*.ts → scorers: { ... }`)
2. `sampling.rate = 0`
3. Storage scores domain nie skonfigurowany — sprawdź `storage` w `index.ts`

### Cost = 0 dla wszystkich agentów

Albo modele są lokalne (Ollama, koszt = 0 by design), albo brak `model` w event'ach. Sprawdź:
```bash
db.query({ collection: "agent_events", operation: "distinct", field: "model" })
```

### Latency endpoints zwracają błąd "$percentile not supported"

MongoDB poniżej 7.0. Update do `mongo:7` w docker-compose lub dodaj fallback z aplikacyjnym obliczaniem percentyli.
