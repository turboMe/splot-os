# 7.6 Agent Evaluation Dashboard — Plan Implementacji

> **Status:** ✅ **Sprint 1 + 2 + 3 ZROBIONE** (data + API + tool + UI dashboard + auto-telemetria)
> **Data planu:** 2026-05-09 | **Ukończono:** 2026-05-09
> **Estymacja oryginalna:** 4-6 dni MVP. **Faktyczne:** ~6-8h łącznie
>   - Sprint 1: ~3-4h (znacznie szybciej dzięki odkryciu że Mastra już zapisuje scorery natywnie)
>   - Sprint 2: ~1-2h (zero-build podejście: vanilla JS + Chart.js CDN zamiast Vite/React)
>   - Sprint 3: ~1-2h (Mastra ma natywny `BaseExporter` — wystarczyło napisać 200-line subklasę)
> **Dokumentacja:** [`docs/AGENT-EVALUATION-DASHBOARD.md`](../docs/AGENT-EVALUATION-DASHBOARD.md)
> **Dashboard URL:** http://localhost:4111/dashboard-ui

---

## TL;DR — Stan po Sprincie 1 + 2 + 3

**Sprint 1 + 2 + 3 ✅ ZROBIONE.** Cała data layer + API + agent tool + UI dashboard + **automatyczna telemetria z agentów**.

**Kluczowe odkrycia podczas implementacji:**
1. Mastra **automatycznie** zapisuje wyniki scorerów do kolekcji `mastra_scorers` (przez `MongoDBStore` scores domain). Etap 1 oryginalnego planu (1.5d "persystencja scorerów") okazał się **zbędny** — wystarczyło tylko czytać z istniejącej kolekcji.
2. Dla MVP UI nie potrzeba Vite/React/Tailwind — **vanilla JS + Chart.js via CDN** w jednym pliku HTML jest wystarczająco bogate i szybsze do utrzymania (zero deps, zero build step, hot-reload przez fs.readFile).
3. Mastra ma natywny **`BaseExporter` z `@mastra/observability`** — exporter dostaje SPAN_STARTED/SPAN_ENDED dla wszystkich span types. Wystarczyło 200-line subklasa zamiast wrapowania `agent.generate()`. Telemetria działa z każdym agentem **bez zmiany ich kodu**.

Co działa:
- ✅ `agent_events` collection — telemetria zasilana **automatycznie** przez `MongoTelemetryExporter`
- ✅ `mastra_scorers` collection — Mastra-managed scorer results (saveScore auto)
- ✅ `lib/model-pricing.ts` — 12 modeli z hardcoded pricing + env override
- ✅ `services/dashboard-stats.ts` — 8 funkcji agregujących
- ✅ `services/mongo-telemetry-exporter.ts` — auto-exporter dla AGENT_RUN/MODEL_GEN/TOOL_CALL spans
- ✅ 8 API routes pod `/dashboard/*` (Mastra rezerwuje `/api/*`)
- ✅ Tool `system.agent_performance_report` w meta + analytics agentach
- ✅ Skill `_skills/meta/agent-performance-analysis.md`
- ✅ Dokumentacja `docs/AGENT-EVALUATION-DASHBOARD.md`
- ✅ MongoDB 7.0 `$percentile` działa dla latency P50/P95/P99
- ✅ **UI Dashboard pod `/dashboard-ui`** — vanilla JS + Chart.js, dark theme, 6 wykresów + 3 tabele + 5 metryki, filtrowanie + auto-refresh
- ✅ **End-to-end smoke test passed** — wywołanie weather-agent → dashboard pokazuje realne dane (totalTasks: 1, cost: $0.008, model: gemini-2.5-pro)

**Co NIE działa od razu:** Mastra Studio (UI na localhost:4111) jest read-only. Dlatego nasz dashboard jest osobnym route'em pod `/dashboard-ui` na tym samym porcie.

---

## Co JUŻ mamy (audyt fundamentów)

### ✅ `agent_events` — solidna baza danych telemetry
Plik: `src/mastra/lib/agent-event-log.ts`
- 23 typy eventów: `task_started`, `task_completed`, `task_failed`, `tool_called`, `tool_error`, `delegation`, `retry_*`, `autoheal_*`, `lesson_learned`, `skill_used`, `approval_*`
- Pola gotowe do agregacji: `agentId`, `taskId`, `model`, `status`, `durationMs`, `tokenUsage` (prompt + completion)
- Indeksy: `(type, timestamp)`, `(agentId, timestamp)`, `(taskId)` — wystarczą do query'ów dashboardowych
- Helper `queryAgentEvents()` z filtrami
- TTL 30 dni — wystarcza dla "ostatnich N dni" widoku

### ✅ `BudgetTracker` — model usage
Plik: `src/mastra/services/budget-tracker.ts`
- Liczy: `requests`, `totalTokens`, `byModel` per provider
- Daily reset, in-memory state
- Już eksponowany przez `/deploy/cloud-free-status`

### ✅ Mastra observability framework
- `@mastra/observability` z DefaultExporter + CloudExporter
- DuckDBStore podpięty jako `observability` storage
- **Niewykorzystywany** — pole gotowe do wypełnienia metrykami

### ✅ API routes infrastructure
- `registerApiRoute()` z Mastra Core
- Już istnieją: `/deploy/health`, `/deploy/gpu-status`, `/deploy/model-status`, `/deploy/cloud-free-status`

---

## Co BRAKUJE (gap analysis)

| Wymaganie z planu | Stan obecny | Brakuje |
|-------------------|-------------|---------|
| Success rate per agent | `agent_events.status` istnieje | Pre-computed aggregation endpoint |
| Success rate per skill | `skill_used` event istnieje | Skill ID nie jest poprawnie linkowany z task outcome |
| Model usage breakdown | `model` w events + BudgetTracker | Brak per-agent × per-model crosstab |
| Cost per task | Tokeny ✅, **USD ❌** | Token→USD pricing table + kalkulator |
| Latency percentiles (P50/P95/P99) | `durationMs` ✅ | Aggregation pipeline z `$percentile` |
| **Scorer results** | Scorery są zarejestrowane, ale wyniki **nie są persystowane** 🔴 KRYTYCZNE | Nowa kolekcja `eval_results` + hook do scorer execution |
| Dashboard UI | Brak | Statyczny React (Vite) lub HTML+htmx |

---

## Architektura proponowanego rozwiązania

```
┌─────────────────────────────────────────────────────────────┐
│  DATA LAYER (MongoDB)                                        │
│  ├─ agent_events (already exists, 30-day TTL)                │
│  ├─ eval_results (NEW — scorer outputs)                      │
│  ├─ model_pricing (NEW — token→USD reference table)          │
│  └─ tasks (already exists)                                   │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ aggregation pipelines
                            │
┌─────────────────────────────────────────────────────────────┐
│  AGGREGATION LAYER (TS services)                             │
│  ├─ services/dashboard-stats.ts (NEW)                        │
│  │   ├─ getAgentSuccessRates(window)                         │
│  │   ├─ getSkillUsageStats(window)                           │
│  │   ├─ getModelBreakdown(window)                            │
│  │   ├─ getLatencyPercentiles(window)                        │
│  │   └─ getCostBreakdown(window)                             │
│  └─ services/cost-calculator.ts (NEW — token×price→USD)      │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │
┌─────────────────────────────────────────────────────────────┐
│  API LAYER (Mastra apiRoutes)                                │
│  ├─ GET /api/dashboard/agents          (success rates)       │
│  ├─ GET /api/dashboard/skills          (skill usage)         │
│  ├─ GET /api/dashboard/models          (model breakdown)     │
│  ├─ GET /api/dashboard/latency         (P50/P95/P99)         │
│  ├─ GET /api/dashboard/cost            (cost analysis)       │
│  ├─ GET /api/dashboard/timeline        (events over time)    │
│  └─ GET /dashboard                     (static HTML UI)      │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ fetch
                            │
┌─────────────────────────────────────────────────────────────┐
│  UI LAYER (statyczny Vite/React build, serwowany przez Mastra) │
│  ├─ Dashboard.tsx (overview + filters)                       │
│  ├─ AgentStatsCard, SkillUsageChart, ModelPie, LatencyHist   │
│  └─ CostTrendLine, RecentTasksTable                          │
└─────────────────────────────────────────────────────────────┘

PLUS: Tool `system.agent_performance_report` — zwraca JSON do agentów,
żeby meta-agent mógł sam analizować swoje performance.
```

---

## ~~Etap 1 — Persystencja scorerów~~ ❌ NIE JEST POTRZEBNE

> **Update 2026-05-09:** Mastra **już zapisuje** wyniki scorerów do kolekcji `mastra_scorers`
> automatycznie przez storage interface (`MongoDBStore` ma scores domain). Wystarczy
> czytać z tej kolekcji w `getScoreStats()` w `services/dashboard-stats.ts` (już zrobione).
> Pierwotny plan poniżej zostawiam dla referencji historycznej.

<details>
<summary>Oryginalny plan (zachowany dla kontekstu)</summary>

**Cel:** Bez tego nie mamy success rates per skill ani jakości odpowiedzi.

### 1.1 Nowa kolekcja `eval_results`
Schema:
```typescript
interface EvalResult {
  evalId: string;           // UUID
  timestamp: Date;
  agentId: string;
  taskId?: string;
  scorerId: string;         // np. 'tool-call-appropriateness'
  score: number;            // 0.0 - 1.0
  threshold?: number;       // próg "passed"
  passed: boolean;
  details?: Record<string, unknown>;  // breakdown z scorera
  model?: string;
  expiresAt: Date;          // 30-day TTL
}
```

Dodać indeksy w `lib/mongo.ts → ensureIndexes()`:
- `(scorerId, timestamp)` 
- `(agentId, timestamp)`
- `(taskId)`
- `(expiresAt)` z `expireAfterSeconds: 0`

### 1.2 Helper `lib/eval-results.ts`
```typescript
export async function logEvalResult(result: Omit<EvalResult, 'evalId' | 'timestamp' | 'expiresAt'>): Promise<void>
export async function queryEvalResults(filters: { agentId?, scorerId?, since?, limit? }): Promise<EvalResult[]>
```

### 1.3 Hook do Mastra scorers
Mastra evaluuje scorery przez `scorers: { ... }` przy agencie. Trzeba:
- Sprawdzić czy Mastra emituje event po wyliczeniu score'a (prawdopodobnie tak — `@mastra/observability`)
- Albo: wrapper `withEvalLogging(scorer)` który po `evaluate()` zapisuje wynik
- Zarejestrować wrapper w każdym agencie zamiast surowego scorera

### 1.4 Walidacja
- Wywołać agenta, sprawdzić czy `eval_results` ma nowe rekordy
- Sprawdzić TTL działa (insert + setTimeout test)

</details>

---

## Etap 2 — Cost Calculator + Pricing Table ✅ ZROBIONE

### 2.1 Kolekcja `model_pricing`
```typescript
interface ModelPricing {
  model: string;            // np. 'claude-sonnet-4-6', 'gpt-4o'
  provider: string;
  inputCostPer1M: number;   // USD
  outputCostPer1M: number;  // USD
  effectiveFrom: Date;
  effectiveTo?: Date;
}
```

Seed wartości dla głównych modeli:
- Claude Sonnet 4.6: $3 / $15 per 1M
- Claude Opus 4.7: $15 / $75 per 1M  
- Claude Haiku 4.5: $1 / $5 per 1M
- GPT-4o: $2.50 / $10 per 1M
- Gemini 2.5 Pro: $1.25 / $5 per 1M
- Local Ollama (qwen3:4b itd.): $0 / $0

### 2.2 `services/cost-calculator.ts`
```typescript
export async function calculateCost(model: string, promptTokens: number, completionTokens: number): Promise<number>
export async function aggregateCostByAgent(window: TimeWindow): Promise<{ agentId, totalUsd }[]>
```

Cache pricing in memory (TTL 1h).

---

**Status:** Zaimplementowane jako `lib/model-pricing.ts` (NIE jako kolekcja MongoDB — hardcoded + env override było wystarczające dla MVP). Można później przenieść do MongoDB jeśli potrzeba historycznej dokładności cen.

---

## Etap 3 — Aggregation Service ✅ ZROBIONE

`services/dashboard-stats.ts` — wszystkie funkcje agregujące.

### Przykładowy pipeline: latency percentiles
```typescript
export async function getLatencyPercentiles(window: TimeWindow): Promise<{
  agentId: string;
  p50: number; p95: number; p99: number;
  count: number;
}[]> {
  const db = await getDb();
  return db.collection('agent_events').aggregate([
    { $match: { type: 'task_completed', timestamp: { $gte: window.from, $lt: window.to } } },
    { $group: {
      _id: '$agentId',
      latencies: { $push: '$durationMs' },
      count: { $sum: 1 }
    }},
    { $project: {
      agentId: '$_id',
      count: 1,
      percentiles: { $percentile: { input: '$latencies', p: [0.5, 0.95, 0.99], method: 'approximate' } }
    }},
    { $project: {
      agentId: 1, count: 1,
      p50: { $arrayElemAt: ['$percentiles', 0] },
      p95: { $arrayElemAt: ['$percentiles', 1] },
      p99: { $arrayElemAt: ['$percentiles', 2] },
    }}
  ]).toArray();
}
```

### Funkcje do zaimplementowania:
- `getAgentSuccessRates(window)` — `task_completed` / (`task_completed` + `task_failed`) per agentId
- `getSkillUsageStats(window)` — count `skill_used` per skillId, plus avg eval score (join z `eval_results`)
- `getModelBreakdown(window)` — count + tokens + cost per model
- `getLatencyPercentiles(window)` — jak wyżej
- `getCostBreakdown(window)` — total USD per agent, per model, per day
- `getTimelineEvents(window, granularity)` — bucket-by-hour count of events per type

---

**Status:** Zaimplementowane jako `services/dashboard-stats.ts`. **Plus** dodane: `getScoreStats(window)` i `getTimeline(window, granularity)`.

---

## Etap 4 — API Routes ✅ ZROBIONE

W `src/mastra/index.ts` dodać:
```typescript
import { registerApiRoute } from '@mastra/core/server';
import * as stats from './services/dashboard-stats.js';

apiRoutes: [
  // ... existing routes
  registerApiRoute('/api/dashboard/agents', { method: 'GET', handler: async (c) => {
    const window = parseTimeWindow(c.req.query());
    return c.json(await stats.getAgentSuccessRates(window));
  }}),
  registerApiRoute('/api/dashboard/skills', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/models', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/latency', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/cost', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/timeline', { method: 'GET', handler: ... }),
]
```

Query params: `?from=2026-05-01&to=2026-05-09&agentId=meta-agent`

---

**Status:** Zaimplementowane w `src/mastra/index.ts`. **Uwaga:** prefix to `/dashboard/*` zamiast `/api/dashboard/*` — Mastra rezerwuje `/api/*` dla swoich endpointów.

---

## Etap 5 — Tool dla agentów ✅ ZROBIONE

`tools/system/agent-performance-report.ts`:
```typescript
export const agentPerformanceReportTool = createTool({
  id: 'system.agent_performance_report',
  description: 'Generuje raport wydajności agentów: success rate, model usage, koszt, latency. Używaj gdy user pyta "jak działa system", "który agent jest najwolniejszy", "ile wydaliśmy".',
  inputSchema: z.object({
    since: z.string().describe('ISO date (e.g. "2026-05-01") lub względny ("7d", "24h")'),
    agentId: z.string().optional(),
    includeBreakdown: z.array(z.enum(['agents', 'skills', 'models', 'latency', 'cost'])).optional().default(['agents', 'cost'])
  }),
  outputSchema: z.object({
    success: z.boolean(),
    period: z.object({ from: z.string(), to: z.string() }),
    summary: z.object({
      totalTasks: z.number(),
      successRate: z.number(),
      totalCostUsd: z.number(),
      avgLatencyMs: z.number(),
    }),
    breakdown: z.record(z.string(), z.unknown()),
    error: z.string().optional(),
  }),
  execute: async (ctx) => {
    // Wywołuje funkcje z services/dashboard-stats.ts
  }
});
```

Zarejestrować w meta-agencie i analytics-agencie.

---

**Status:** Zaimplementowane jako `tools/system/agent-performance-report.ts`, zarejestrowane w meta-agent (ToolSearchProcessor pool) i analytics-agent (always-on).

---

## Etap 6 — UI Dashboard ✅ ZROBIONE (Sprint 2)

> **Update 2026-05-09:** Zaimplementowane w **prostszej wersji niż pierwotnie planowano**.
> Zamiast Vite + React + Tailwind + Recharts (1.5d setup) → vanilla JS + Chart.js via CDN (1-2h).
> Szczegóły: `dashboard/index.html` + route `/dashboard-ui` w `index.ts`.
> Wszystko opisane w `docs/AGENT-EVALUATION-DASHBOARD.md`.

<details>
<summary>Oryginalny plan (Vite/React) — niepotrzebny w obecnej skali</summary>

### 6.1 Stack
- **Vite + React + TypeScript** (osobny build w `dashboard/`)
- **Recharts** dla wykresów (lightweight, ~100kb)
- **Tailwind CSS** dla stylowania
- Build output → `dist/dashboard/` → serwowany przez Mastra jako static files

### 6.2 Strony i komponenty
```
dashboard/
├── index.html
├── src/
│   ├── App.tsx (routing + filters bar)
│   ├── components/
│   │   ├── AgentStatsCard.tsx     (success rate + tasks count per agent)
│   │   ├── SkillUsageChart.tsx    (bar chart top-10 skills)
│   │   ├── ModelBreakdownPie.tsx  (pie chart usage)
│   │   ├── LatencyHistogram.tsx   (P50/P95/P99 per agent)
│   │   ├── CostTrendLine.tsx      (USD per day)
│   │   ├── EventTimeline.tsx      (events/hour stacked area)
│   │   └── RecentTasksTable.tsx   (last 50 tasks z drill-down)
│   ├── api.ts                     (fetch z /api/dashboard/*)
│   └── filters.tsx                (date range, agent picker)
└── vite.config.ts
```

### 6.3 Serwowanie z Mastra
Dwa warianty:

**Wariant A (rekomendowany):** static asset route
```typescript
import { serveStatic } from '@hono/node-server/serve-static';
apiRoutes: [
  registerApiRoute('/dashboard/*', { method: 'GET', handler: serveStatic({ root: './dist/dashboard' }) }),
]
```

**Wariant B:** osobny port (Next.js dev server podczas dev, deploy razem)

### 6.4 Filters bar
- Date range picker (7d/30d/custom)
- Agent multi-select
- Auto-refresh toggle (15s polling)

</details>

### Co zostało faktycznie zaimplementowane (Sprint 2)

**Stack (zero-build):**
- 1 plik HTML (`dashboard/index.html`, ~26KB)
- Vanilla JS (ES2022 modules)
- Chart.js 4.4.6 via jsdelivr CDN
- Inline CSS (~150 linii, dark theme)

**Layout:**
- Filters bar: window picker (24h/7d/14d/30d/90d), granularity (hour/day), refresh button, auto-refresh toggle (30s), status indicator
- Overview cards (5): Tasks · Success Rate · Cost · Avg Latency · Tool Calls
- Wykresy:
  1. **Agents** — stacked bar chart (completed vs failed per agent)
  2. **Models** — doughnut chart (cost USD by model, fallback do invocations dla local)
  3. **Cost trend** — line chart (USD per day)
  4. **Latency** — grouped bar chart (P50/P95/P99 per agent)
  5. **Timeline** — stacked area (events bucketed by hour/day)
  6. **Skills** — horizontal bar chart (top 10 by uses)
- Tabele: agents · models · scorers (z color-coded pill badges)

**Serwowanie:** route `/dashboard-ui` w `index.ts` używa `fs.readFile` przy każdym requeście — hot-reload za darmo (edytujesz HTML → F5 → widzisz zmiany).

**Smoke test:** ✅ `curl /dashboard-ui` zwraca 200 (26KB HTML), `/dashboard/overview` zwraca poprawny JSON.

---

## Etap 7 — Dokumentacja + skill ✅ ZROBIONE

### 7.1 Skill `_skills/meta/agent-performance-analysis.md` ✅
Framework: kiedy investigate, jakie metryki, jak interpretować, jak rekomendować działania.
Zawiera: red flags table, drift detection, anti-patterns, full example flow.

### 7.2 Dokumentacja `docs/AGENT-EVALUATION-DASHBOARD.md` ✅
- Architektura ze schematem ASCII
- Pricing table (12 modeli)
- 8 API endpoints z przykładami curl
- Tool API z przykładem wywołania
- Wymagania uruchomieniowe (MongoDB 7.0+ dla `$percentile`)
- Troubleshooting (3 typowe problemy)
- Instrukcja rozszerzania (jak dodać nowy breakdown / scorer / cenę modelu)

---

## Definicja ukończenia (Acceptance Criteria)

### Sprint 1 ✅ DONE
- [x] ~~Kolekcja `eval_results` istnieje~~ → Mastra używa `mastra_scorers` natywnie
- [x] Pricing zaseedowane 12 modelami w `lib/model-pricing.ts` (anthropic, openai, google, openrouter, ollama)
- [x] 8 endpointów API zwraca poprawne dane (overview, agents, skills, models, latency, cost, scores, timeline)
- [x] Tool `system.agent_performance_report` działa i jest w meta + analytics agentach
- [x] Dokumentacja `docs/AGENT-EVALUATION-DASHBOARD.md` napisana
- [x] Skill `_skills/meta/agent-performance-analysis.md` napisany
- [x] TypeScript: ✅ czysty (`npx tsc --noEmit` 0 błędów)

### Sprint 2 ✅ DONE (UI dashboard)
- [x] Dashboard widoczny pod `/dashboard-ui`, pokazuje:
  - [x] Success rate per agent (stacked bar chart) + tabela
  - [x] Top 10 skills (horizontal bar chart)
  - [x] Model usage (doughnut chart) + tabela z providerem i kosztem
  - [x] Latency P50/P95/P99 (grouped bar chart per agent)
  - [x] Cost trend (line chart, USD/day)
  - [x] Event timeline (stacked area chart)
  - [x] Scorers (tabela z avg score i pass rate)
  - [x] Overview cards (5 metryk)
- [x] Filtry: window picker (24h/7d/14d/30d/90d), granularity (hour/day)
- [x] Auto-refresh toggle (30s)
- [x] Color-coded success rates (zielony/żółty/czerwony)
- [x] Smoke test: HTTP 200 + valid JSON ✅

---

## Ryzyka i mitigacje

| Ryzyko | Mitigacja |
|--------|-----------|
| `agent_events` rośnie szybko (>100k/dzień) | TTL 30 dni już jest; rozważyć rollup do `agent_events_daily` |
| `$percentile` wymaga MongoDB 7.0+ | Sprawdzić wersję — fallback: liczyć w aplikacji |
| Brak wszystkich modeli w `model_pricing` | Default fallback 0 USD + warning w logach |
| Mastra scorers nie emitują eventu | Plan B: wrapper scorera z manualnym `logEvalResult` |
| Cost dla local Ollama = 0 zaniża analizy | Dodać kolumnę `localGpuTimeMs` do alternatywnego "kosztu" |
| UI: refresh co 15s + 6 endpointów = obciążenie | Cache wyniki agregacji w Redis/memory na 60s |

---

## Estymacja czasowa

| Etap | Estymacja | Faktyczne | Status |
|------|-----------|-----------|--------|
| 1. Eval persistence | 1.5 dnia | **0d** | ✅ Mastra robi to natywnie |
| 2. Cost calculator | 0.5 dnia | ~0.5h | ✅ Done |
| 3. Aggregation service | 1 dzień | ~1h | ✅ Done |
| 4. API routes | 0.5 dnia | ~30min | ✅ Done |
| 5. Tool dla agentów | 0.5 dnia | ~30min | ✅ Done |
| 6. UI Dashboard | 1.5 dnia | ~1-2h | ✅ Done (zero-build approach) |
| 7. Dokumentacja | 0.5 dnia | ~30min | ✅ Done |
| **Sprint 1 (data + tool)** | **~3.5 dnia** | **~3-4h** | ✅ DONE |
| **Sprint 2 (UI)** | **~1.5 dnia** | **~1-2h** | ✅ DONE |
| **TOTAL ŁĄCZNIE** | **~5 dni** | **~5-6h** | ✅ |

---

## Sugerowana kolejność wdrażania

1. **Sprint 1 (MVP "data-only"):** Etapy 1-4 + 5 ✅ **ZROBIONE**
   - meta-agent + analytics-agent mogą odpowiadać na pytania "jak działają agenci" przez tool
   - 8 API endpointów gotowych do konsumpcji przez dowolny UI

2. **Sprint 2 (Visual UI):** Etap 6 ✅ **ZROBIONE**
   - Pełny dashboard pod `/dashboard-ui`
   - Zero-build approach: vanilla JS + Chart.js CDN (zamiast Vite/React)
   - Dostępny natychmiast po `npm run dev` (bez osobnej kompilacji UI)

3. **Sprint 3 (Polish) — Backlog:**
   - Cache wyników agregacji (TTL 60s) — przyda się gdy >50 użytkowników
   - Alerty (success rate < 80% → Telegram) — workflow cron, łatwe do dodania
   - Daily rollup gdy `agent_events` urośnie >1M
   - Drill-down: klik w wiersz tabeli → szczegóły taska (`/dashboard/task/:id`)

---

## Quick wins przed pełną implementacją

Już TERAZ można zrobić w 30 min, bez czekania na pełny dashboard:

```typescript
// W tools/system/agent-performance-report.ts (uproszczony tool)
// — używa tylko już istniejących danych:
// agent_events.status, durationMs, model, tokenUsage

const stats = await db.collection('agent_events').aggregate([
  { $match: { timestamp: { $gte: since } } },
  { $group: {
    _id: '$agentId',
    total: { $sum: 1 },
    completed: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
    failed: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
    avgDuration: { $avg: '$durationMs' },
    totalTokens: { $sum: '$tokenUsage.total' }
  }}
]).toArray();
```

Da to: success rate per agent, avg latency, token usage — bez scorers i bez UI.
**To jest realny minimal MVP zrobiony w pół dnia.**
