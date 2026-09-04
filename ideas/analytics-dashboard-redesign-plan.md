# Analytics Dashboard Redesign Plan

Data: 2026-06-23
Status: Fazy 1–8 zaimplementowane i zweryfikowane live (Analytics V2 redesign done)

## Status implementacji

Aktualizacja: 2026-06-23

Faza 1: rozdzielenie plików bez zmiany zachowania została wykonana.

Wykonane:

- dodano `dashboard/analytics.js` i przeniesiono do niego obecny renderer/fetch/live activity Analytics;
- dodano `dashboard/analytics.css` jako miejsce na style Analytics V2;
- podpięto assety w `dashboard/index.html`;
- dodano route `GET /dashboard-ui/analytics.js`;
- dodano route `GET /dashboard-ui/analytics.css`;
- usunięto dwa zduplikowane inline bloki Analytics z `dashboard/index.html`;
- `window.MastraAnalytics` wystawia `init`, `refresh`, `destroy` i przejmuje obecny widok bez zmiany endpointów;
- główne event listenery Analytics są spinane przez `AbortController`, żeby `destroy()` mógł je posprzątać;
- `npm run build` zakończył się sukcesem;
- `node --check dashboard/analytics.js` przeszedł bez błędów składni.

Faza 2: normalizacja i backend V2 została rozpoczęta i podpięta do widoku Analytics.

Wykonane:

- rozszerzono `src/mastra/config/agent-ids.ts` o brakujące aliasy camel/kebab dla agentów domenowych;
- dodano `src/mastra/services/dashboard-analytics-v2.ts`;
- dodano `GET /dashboard/v2/summary`;
- dodano `GET /dashboard/v2/agents`;
- dodano `GET /dashboard/v2/models`;
- dodano `GET /dashboard/v2/latency`;
- dodano `GET /dashboard/v2/timeline`;
- dodano `GET /dashboard/v2/tools`;
- dodano `GET /dashboard/v2/skills`;
- dodano `GET /dashboard/v2/quality`;
- V2 rollupuje `plan-task-*` do `planTasks` i workerów do `workers`;
- V2 normalizuje wybrane aliasy modeli, np. `deepseek/deepseek/deepseek-v4-*`;
- V2 używa `tool_executions` jako canonical source dla Tool Envelopes & Policy;
- V2 agreguje skille z `tool_executions.toolId` (`skill_search`, `skill_load`, `skill_report_result`) oraz zachowuje fallback na legacy `skill_used`;
- V2 agreguje jakość z `mastra_scorers`, `agent_events.output_score` i `agent_events.goal_completion_evaluated`;
- smoke V2 na lokalnym Mongo zwrócił poprawny wynik dla 7 dni: 653 taski, 23 agentów po canonical rollupie, 13 modeli, 379 tool executions;
- `npm run build` zakończył się sukcesem po dodaniu backendu V2.

Faza 3: pierwsza przebudowa UI Analytics została rozpoczęta.

Wykonane:

- `dashboard/analytics.js` używa endpointów V2 dla health stripu, agentów, modeli, tool envelopes i skilli;
- pierwszy ekran pokazuje `System Health` z tasks, success rate, cost, p95 latency, tool envelopes i scorer coverage;
- dodano alerty operacyjne: high tool failure rate, low scorer coverage, hanging executions, high-risk blocked, zero-token models, missing pricing;
- `Agents & Models` pokazuje canonical agents zamiast surowych `plan-task-*`/`run-worker-*`;
- `Tool Envelopes & Policy` pokazuje status mix, breakdown kategorii, approval gates, high-risk blocks, hanging started, policy blocks, top tool hotspots, failure classes i hanging executions;
- `Activity & Skills` pokazuje skill operations z tool envelopes oraz tabelę `Skill Operation Details`;
- scorer absence jest pokazywane jako quality coverage gap, a nie jako neutralny pusty stan;
- donut modeli został zastąpiony rankingiem FinOps z kartami spend/top driver/pricing gaps/zero-token calls;
- tabela modeli pokazuje paski kosztów, tokenów i calls oraz `$/1k tok`, error rate i P95 latency;
- dodano endpoint i widok latency long-tail: p50/p95/p99, p99/p50 ratio, max latency, percentyle per agent;
- dodano tabelę `Slowest Runs & Events` z typem eventu, agentem, trace/task id, czasem i modelem;
- legacy `Event Timeline` został zastąpiony health timeline V2 z throughput, failures, tool failed/blocked, cost, P95 latency i token context;
- dodano `Timeline Annotations` dla run failures, task failures, tool envelope blocks/failures, policy blocks, approval gates, worker alerts, reflector interventions, reflection repairs i autoheal events;
- sample annotacji timeline są limitowane długością po stronie backendu;
- dodano osobną sekcję `Quality, Scorers & Evals`;
- sekcja quality pokazuje task coverage, pass rate, avg score, źródła jakości, histogram score, coverage by agent, scorer summaries, recent quality failures i coverage gaps;
- endpoint `/dashboard/v2/quality` w lokalnym smoke dla 7 dni zwrócił 653 taski, 703 quality evaluations, 21.3% task coverage, 430 `goal_completion_evaluated` i 273 `output_score`;
- dodano globalne filtry Analytics V2: `agentId`, `model`, `toolCategory`, `toolRisk`, `toolStatus`;
- filtry są obsługiwane przez `/dashboard/v2/summary`, `/agents`, `/models`, `/latency`, `/timeline`, `/tools`, `/skills` i `/quality`;
- UI ma pasek filtrów globalnych oraz `Clear filters`; wykres kosztu korzysta z filtrowanego timeline V2 zamiast legacy `/dashboard/cost`;
- smoke filtrów potwierdził zawężanie danych dla `agentId=meta-agent`, `model=deepseek-v4-pro` oraz `toolStatus=blocked&toolRisk=high`;
- live UI zostało sprawdzone na działającym `localhost:4111/dashboard-ui` po restarcie procesu dev.
- `/dashboard/v2/summary` zwraca `compare.previousWindow` i delty dla tasks, success rate, cost, tokens, tool failure rate, scorer coverage oraz P95 latency;
- `/dashboard/v2/quality` zwraca `trend.previousWindow` i delty dla task coverage, pass rate, avg score oraz liczby ewaluacji;
- UI pokazuje delty względem poprzedniego okresu w kaflach `System Health` i `Quality, Scorers & Evals`.
- dodano pierwszy slice `Trace Explorer`: `/dashboard/v2/traces`, `/dashboard/v2/traces/:id`, lista trace summaries, detail eventów, tool envelopes i score outcomes;
- UI ma sekcję `Trace Explorer` z filtrami `runId`, `taskId`, `threadId`, `status`, limitem wyników i klikanym panelem detailu.

Faza 7 (drill-downy + live rail) została dokończona.

Wykonane:

- backend dokłada reprezentatywny `traceId` do każdej anotacji timeline (`/dashboard/v2/timeline`), żeby anotacja prowadziła do przykładowego śladu (event docs używają `traceKeyFromEvent`, tool docs `traceKeyFromTool`);
- projekcje zapytań timeline (events + tools) dostały `runId/taskId/threadId/turnId`, bez tego anotacje nie miały z czego wyliczyć `traceId`;
- `hangingStarted` w `/dashboard/v2/tools` zwraca teraz `runId/taskId/threadId`, więc zawieszone egzekucje są klikalne do trace;
- frontend ma jeden delegowany handler `[data-drill]` na roocie zakładki (sprzątany przez `AbortController`): `trace`, `agent`, `model`, `section`;
- `focusTrace(ids)` otwiera konkretny run/task/thread w `Trace Explorer` bez ruszania filtrów globalnych: ustawia filtry trace, ładuje listę i detail, scrolluje do sekcji; detail rozwiązuje się przez dowolne z eventId/runId/taskId/threadId/turnId;
- drill do trace podpięty pod: `Slowest Runs & Events`, `Timeline Annotations`, `Recent Quality Failures` (po `taskId`), `Hanging Executions`, oraz link `trace ↳` w nagłówku grupy Live Activity;
- drill filtrujący: wiersze tabeli `Agents` ustawiają `agentId`, wiersze `Models` ustawiają `model` i przeładowują dashboard;
- karty alertów są klikalne i scrollują do powiązanej sekcji (`alertSectionFor`: tool/policy/risk → Tool Envelopes, scorer/quality → Quality, latency → Cost & Latency, cost/model/token → Agents & Models);
- każda sekcja dostała stałe `id` (`section-health`, `section-agents`, `section-latency`, `section-tools`, `section-activity`, `section-quality`, `section-traces`, `section-tables`) jako cele scrolla;
- `Live Agent Activity` przeniesione z pełnoszerokiej sekcji do wąskiego, zwijanego raila (`position: fixed`, prawa krawędź, domyślnie zwinięty, toggle `LIVE`); rail żyje wewnątrz `#tab-analytics`, więc nie wycieka na inne zakładki;
- weryfikacja live na `localhost:4111/dashboard-ui` headless Chromium: 0 błędów runtime przez pełny cykl refresh, 10 instancji Chart.js, 108 wierszy drill, drill ze `Slowest Runs` ładuje detail (80 event cards) i podświetla wiersz na liście, drill agenta ustawia filtr i przeładowuje, rail otwiera/zamyka się poprawnie;
- `npm run build` zakończył się sukcesem po zmianach backendu.

Faza 8 (polish, performance, dokumentacja) została dokończona.

Wykonane:

- potwierdzono deduplikację Analytics JS: renderer Analytics działa z zewnętrznego `dashboard/analytics.js`, a assety są serwowane przez `/dashboard-ui/analytics.js` i `/dashboard-ui/analytics.css`;
- `loadAll()` nie używa już jednego globalnego `Promise.all` z jednym catch: endpointy są rozliczane per sekcja przez `settleEndpoint`, więc błąd jednej sekcji nie blankuje całego dashboardu;
- dodano sekcyjne loading/error states dla health, agents, models, latency, timeline, skills, quality, traces, tools i legacy scorers;
- dodano krótki cache agregacji Analytics V2 w `src/mastra/services/dashboard-analytics-v2.ts`: TTL domyślnie 15s, max 250 wpisów, promise dedupe dla równoległych identycznych requestów, natychmiastowa ewikcja po błędzie;
- dodano konfigurację cache do `.env.example`: `DASHBOARD_V2_CACHE_TTL_MS`, `DASHBOARD_V2_CACHE_MAX_ENTRIES`;
- dodano dokumentację kontraktu i operacyjnych zasad cache w `docs/ANALYTICS-DASHBOARD-V2.md`;
- zaktualizowano backlog `docs/AGENT-EVALUATION-DASHBOARD.md`, żeby cache/docs V2 nie wisiały jako niezrobione;
- poprawiono polish UI: neutralne placeholdery filtrów (`Any agent/model/category`) i responsywny dwurzędowy top nav pod mobile/narrow viewport;
- visual regression live na `localhost:4111/dashboard-ui`: desktop top, desktop mid, Trace Explorer z otwartym live rail i mobile/narrow; screenshoty zapisane jako `/tmp/mastra-analytics-v2-desktop-top.png`, `/tmp/mastra-analytics-v2-desktop-mid.png`, `/tmp/mastra-analytics-v2-desktop-traces.png`, `/tmp/mastra-analytics-v2-mobile.png`;
- końcowa weryfikacja: `node --check dashboard/analytics.js`, `npx tsc --noEmit --pretty false`, `npm run build`, smoke endpointów `/dashboard/v2/*` dla 7d oraz brak błędów runtime w `agent-browser`.

Najbliższe kroki poza tym planem:

- obserwować realne latency endpointów i rozmiar kolekcji Mongo; jeśli `agent_events` urośnie do dużych wolumenów, kolejnym krokiem będzie daily/hourly rollup zamiast wydłużania TTL cache.

## Cel

Przeprojektować zakładkę Analytics w `http://localhost:4111/dashboard-ui` z prostego dashboardu MVP w pełnoprawne centrum analityczne dla systemu agentów: szybka ocena zdrowia systemu, kosztów, jakości, narzędzi, skilli, scorerów i konkretnych śladów wykonania.

Dashboard ma odpowiadać na pytania operacyjne:

- Czy system działa lepiej czy gorzej niż w poprzednim oknie?
- Które agenty, modele, narzędzia i skille generują koszt, błędy albo opóźnienia?
- Czy jakość odpowiedzi i wykonania jest mierzona scorerami, a jeśli nie, gdzie mamy lukę pokrycia?
- Które tool envelopes są blokowane, zawieszone, ryzykowne albo najczęściej failują?
- Z jakiego runu/taska można przejść do konkretnego śladu zdarzeń, artefaktów, błędów i ocen?

## Co zostało sprawdzone

- Live UI `dashboard-ui`, zakładka Analytics, w widoku desktopowym i po scrollu.
- `dashboard/index.html`, szczególnie markup i JS Analytics.
- Endpointy dashboardu rejestrowane w `src/mastra/index.ts`.
- Logika agregacji w `src/mastra/services/dashboard-stats.ts`.
- Schemat zdarzeń w `src/mastra/lib/agent-event-log.ts`.
- Tool envelopes w `src/mastra/services/harness-tool-envelope.ts`.
- Eksporter telemetryczny w `src/mastra/services/mongo-telemetry-exporter.ts`.
- Normalizacja agentów w `src/mastra/config/agent-ids.ts`.
- Istniejące dokumenty: `ideas/agent-evaluation-dashboard-plan.md`, `docs/AGENT-EVALUATION-DASHBOARD.md`, `src/mastra/_skills/meta/agent-performance-analysis.md`.
- Lokalne dane Mongo: `agent_events`, `tool_executions`, `mastra_scorers`, `harness_artifacts`, `async_delegations`, `approvals`, `autoheal_cycles`.
- Inspiracje z dokumentacji Grafana, PostHog, LangSmith, Datadog LLM Observability i paperu o dashboard design patterns.

## Diagnoza obecnego Analytics

Obecny ekran ma dobrą bazę MVP: filtry czasu, KPI, wykresy agentów/modeli/kosztów/latencji, timeline, skills, scorers i tabele szczegółowe. Problemem nie jest brak danych, tylko brak warstwy interpretacji.

Najważniejsze problemy:

- `Tasks per Agent` pokazuje zbyt wiele surowych identyfikatorów. W badanym oknie 7 dni UI pokazał 257 agentów, ale wiele z nich to `plan-task-*`, `run-worker-*`, `worker:*`, warianty camel/kebab albo `unknown`.
- `Top Skills` jest puste, bo backend czyta tylko event `skill_used`, a realne dane o skillach i operacjach skillowych pojawiają się też w tool envelopes, np. `skill_search`, `skill_load`, `skill_report_result`, oraz w registry skill metadata.
- Scorers są ukryte na końcu i w oknie 7 dni mogą wyglądać jak brak funkcji. W rzeczywistości trzeba pokazywać też coverage gap, ostatnie wyniki, trend i brak próbkowania jako problem jakości.
- Dane o tool envelopes istnieją, ale nie są widoczne w Analytics. Kolekcja `tool_executions` daje statusy `completed`, `failed`, `blocked`, `started`, kategorie, risk, policy decision, duration, artefakty i błędy.
- Wykres model usage jako donut jest słaby do porównywania kosztu, tokenów i efektywności. Lepsza będzie tabela/ranking z barami oraz alertami aliasów modeli i braków pricingu.
- Latencja jest pokazywana, ale nie prowadzi do diagnozy long-tail. Potrzebne są p50/p95/p99, p99/p50 ratio, heatmapa agent x dzień i lista najwolniejszych runów.
- Timeline obecnie liczy wąski zestaw starych eventów (`task_completed`, `task_failed`, `tool_error`). System ma znacznie bogatsze zdarzenia: `run_*`, `llm_call_*`, `tool_call_*`, `policy_*`, `approval_*`, `output_score`, `goal_*`, `worker_*`, `reflector_*`.
- Detailed tables są za nisko, ciasne i częściowo nieczytelne. Dla operacyjnego dashboardu tabele muszą być drill-downem z filtrowaniem, a nie końcówką strony.
- Plik `dashboard/index.html` jest bardzo duży i zawiera zduplikowane/owinięte skrypty Analytics. To zwiększa ryzyko regresji przy większym redesignie.

## Obserwacje z danych lokalnych

Przykładowe wartości z badanego okna 7 dni:

- 653 taski, success rate ok. 93.7%, error rate tooli ok. 5.0%.
- 54.90M tokenów i ok. $37.79 kosztu.
- 141 błędów, 1,993 tool calls, średnia latencja ok. 8.9s.
- Najdroższe agenty: `chef-agent`, `content-agent`, `designAgent`, `meta-agent`, `automationArchitect`.
- `automationArchitect` ma niski success rate w tym oknie i powinien być automatycznie wyróżniony jako hotspot.
- Najdroższe modele: `gemini-3.5-flash`, `deepseek-v4-pro`, `claude-opus-4-8`, `deepseek-v4-flash`.
- Są aliasy modeli z zerowym kosztem/tokenami, np. warianty `deepseek/deepseek/...`, co wymaga normalizacji lub flagowania.
- `tool_executions` ma kilkaset rekordów i pokazuje realne problemy, np. failed/blocked high-risk network/shell oraz konkretne narzędzia o wysokim fail rate.
- `mastra_scorers` ma mało rekordów, więc Analytics powinno pokazywać nie tylko wynik scorerów, ale też brak pokrycia jako metrykę.

## Zasady projektowe

Inspiracje branżowe są spójne:

- Dashboard powinien opowiadać konkretną historię i redukować obciążenie poznawcze, a nie tylko wyświetlać wszystkie dane naraz.
- Dla operacji systemowych warto używać RED: rate, errors, duration.
- Dla systemów produkcyjnych warto też patrzeć na golden signals: latency, traffic, errors, saturation.
- Dla LLM/agent systems potrzebne są dodatkowo: koszt, tokeny, traces, tool calls, jakość/evals/feedback i polityki bezpieczeństwa.
- Główne wykresy powinny mieć drill-downy i filtry globalne, żeby dało się przejść od anomalii do konkretnego runu.

Źródła:

- Grafana dashboard best practices: https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/
- PostHog dashboards: https://posthog.com/docs/product-analytics/dashboards
- LangSmith observability: https://docs.langchain.com/langsmith/observability
- Datadog LLM Observability: https://docs.datadoghq.com/llm_observability/
- Dashboard Design Patterns: https://arxiv.org/abs/2205.00757

## Docelowa architektura informacji

### 1. Globalny pasek filtrów

Stały pasek na górze zakładki:

- Time range: 1h, 24h, 7d, 30d, custom.
- Compare: previous period on/off.
- Granularity: hour/day/week.
- Group by: canonical agent, domain agent, worker, model, tool, skill.
- Filters: agent, model, tool category, risk, status, scorer, runId, taskId.
- Refresh i auto-refresh.
- Tryb danych: production, harness, all, jeśli da się rozróżnić źródło.

Wszystkie sekcje powinny respektować ten sam zakres czasu i filtry.

### 2. Executive Health Strip

Pierwszy ekran ma dawać odpowiedź w mniej niż 10 sekund:

- Health score systemu.
- Work throughput: tasks/runs per hour.
- Success rate z deltą vs poprzedni okres.
- Error budget: task failures + tool failures + policy blocked high-risk.
- Cost total i cost per successful task.
- p95/p99 latency.
- Token usage i tokens per successful task.
- Quality coverage: procent tasków/runów ze scorerem.
- Open approvals / blocked tools / hanging tool executions.

Każdy kafel powinien mieć trend sparkline, deltę i próg ostrzegawczy.

### 3. Health Timeline

Zastąpić prosty Event Timeline wykresem warstwowym:

- Throughput: completed/failed runs/tasks.
- Errors: task failed, tool failed, policy blocked.
- Latency p95 jako linia.
- Cost jako linia lub osobna oś.
- Anotacje: autoheal cycles, worker alerts, approval gates, reflection repairs.

Po kliknięciu punktu: lista runów/tasków z tego bucketu.

### 4. Agent Performance

Zamiast surowego `Tasks per Agent`:

- Ranking top 12 canonical agents + bucket `Workers/Plans/Other`.
- Tabela agentów z kolumnami: tasks, success rate, delta, tool fail rate, avg/p95 latency, cost, tokens, scorer coverage, last error.
- Scatter: cost vs success rate, rozmiar punktu = task count, kolor = error rate.
- Heatmapa agent x dzień: error rate albo p95 latency.
- Przełącznik `Show workers` do analizy `run-worker-*`, `plan-task-*`, `worker:*`.

Wymagane jest odseparowanie agentów domenowych od workerów technicznych.

### 5. Models & Cost

Donut modeli zastąpić analizą FinOps:

- Ranking modeli po koszcie, tokenach, invocation count i cost per successful task.
- Stacked bars kosztu po dniach i modelach.
- Tabela model efficiency: input tokens, output tokens, total tokens, cost, latency, error rate, success contribution.
- Alerty:
  - missing pricing,
  - zero-token invocations,
  - model aliases,
  - sudden cost spike,
  - drogi model przy niskiej jakości/scorer pass rate.

### 6. Latency & Reliability

Osobna sekcja dla long-tail:

- Percentile lollipop/table: p50, p75, p95, p99, max.
- p99/p50 ratio jako sygnał niestabilności.
- Heatmapa latency by agent/day albo model/day.
- Top slowest runs/tasks z linkiem do trace explorer.
- Retry/delegation correlation, jeśli run ma retried/delegated events.

### 7. Tool Envelopes & Policy

Nowa sekcja z danych `tool_executions`:

- Status mix: completed, failed, blocked, started/hanging.
- Breakdown po category: search, memory, network, file, shell, approval, other.
- Breakdown po risk: low, medium, high.
- Top failing tools: fail count, fail rate, avg duration, error class.
- Policy view: allowed vs blocked, high-risk blocked, pending approvals.
- Hanging executions: `status=started` starsze niż próg.
- Artefakty: liczba `outputArtifactId`, typy artefaktów z `harness_artifacts`.

To jest kluczowe, bo tool envelopes są najbliżej realnej obserwowalności działań agentów.

### 8. Skills & Knowledge

Nowa sekcja skilli nie powinna zależeć tylko od `skill_used`.

Dane wejściowe:

- `tool_executions.toolId` dla `skill_search`, `skill_load`, `skill_report_result`.
- Eventy `skill_used`, jeśli występują.
- Skill registry/frontmatter: `total_uses`, `success_rate`, `last_used`, kategorie, agent affinity.
- Ewentualne błędy `skill_load` i brak wyników `skill_search`.

Widoki:

- Skill operations funnel: search -> load -> report/result.
- Top searched skills, top loaded skills, top failed skills.
- No-result/search miss rate.
- Skill success rate vs usage.
- Skill coverage by agent.
- Lista skilli, które są często szukane, ale rzadko ładowane albo mają niski success rate.

### 9. Quality, Scorers & Evals

Scorers powinny być jedną z głównych sekcji, nie tabelką końcową.

Widoki:

- Scorer coverage: ile runów/tasków ma ocenę.
- Average score i pass rate per scorer.
- Distribution: histogram/box plot score.
- Trend vs poprzedni okres.
- Scores by agent/model/tool category.
- Recent failures: najniższe score z runId/taskId i reason, jeśli jest.
- Coverage gap: agenty lub task types bez scorerów.

Dodatkowe źródła:

- `mastra_scorers`.
- `agent_events` typu `output_score`.
- `goal_completion_evaluated`.
- Auto-review events, jeśli mają wynik jakości.

### 10. Trace Explorer

Nowy drill-down zamiast samej Live Activity:

- Lista runów/tasków z filtrowaniem.
- Oś czasu eventów: `run_started`, `llm_call_*`, `tool_call_*`, `policy_*`, `approval_*`, `output_score`, `run_completed/failed`.
- Agregacja po `runId`, `taskId`, `threadId`, `turnId`.
- Podgląd tool envelopes: inputPreview, outputPreview, duration, status, errorClass, artifact.
- Podgląd scorer outcomes.
- Szybki link z każdej anomalii, tabeli i wykresu.

Ważne: input/output preview musi mieć limit długości i respektować istniejące zasady redakcji danych.

### 11. Live Rail

Live Activity warto zostawić, ale jako wąski panel:

- ostatnie błędy,
- worker alerts,
- high-risk blocks,
- approval gates,
- najnowsze failed runs,
- link do Trace Explorer.

Live rail nie powinien dominować nad analizą historyczną.

## Kontrakty danych do dodania

Zostawić stare endpointy dla kompatybilności, ale dodać wersję V2:

Wspólne parametry V2:

- `since`, `until`
- `agentId`: filtr po canonical agent id albo raw id
- `model`: filtr po normalized model id albo raw aliasie
- `toolCategory`: filtr dla danych z `tool_executions.category`
- `toolRisk`: filtr dla danych z `tool_executions.risk`
- `toolStatus`: filtr dla danych z `tool_executions.status`

Uwaga: filtry tooli zawężają głównie metryki oparte o `tool_executions`; metryki eventowe bez relacji do tool envelope pozostają filtrowane po agent/model.

### `GET /dashboard/v2/summary`

Parametry: `since`, `compare`, `filters`.

Zwraca:

- totals: tasks, runs, tool executions, llm calls, tokens, cost.
- rates: successRate, taskFailureRate, toolFailureRate, policyBlockRate.
- latency: avg, p50, p95, p99.
- quality: scorerCoverage, avgScore, passRate.
- alerts: structured red/yellow flags.
- compare: `previousWindow` i delty poprzedniego okresu dla kluczowych metryk.

### `GET /dashboard/v2/agents`

Zwraca canonical rollupy:

- `canonicalAgentId`
- `displayName`
- `entityKind`: `agent`, `worker`, `plan`, `system`, `unknown`
- tasks, runs, success/failure
- toolCalls, toolFailures
- cost, tokens
- latency percentiles
- scorer coverage/pass rate
- sparkline buckets
- top errors

### `GET /dashboard/v2/models`

Zwraca:

- normalized model id
- raw aliases
- invocations
- input/output/total tokens
- cost
- cost per successful task
- latency
- error rate
- pricing status: `priced`, `missing_pricing`, `zero_tokens`, `alias`
- cost share, token share, zero-token invocations i `costPer1kTokensUsd`

### `GET /dashboard/v2/latency`

Zwraca:

- overall latency: samples, avg, p50, p75, p95, p99, max, p99/p50 ratio
- byAgent: canonical agent, entity kind, samples, avg, p50, p75, p95, p99, max, p99/p50 ratio
- slowest: eventId, type, agentId, model, duration, timestamp, runId/taskId/threadId/turnId, first error

### `GET /dashboard/v2/timeline`

Parametry: `since`, `until`, `granularity=hour|day`.

Zwraca:

- buckets z throughput: task started/completed/failed, run completed/failed
- tool health: failed/blocked tool envelopes, high-risk blocked, policy blocks, approval gates
- signals: worker alerts, reflector interventions, reflection repairs, autoheal events, output scores
- FinOps per bucket: tokens i costUsd
- latency per bucket: avg i p95
- annotations: bucket, type, severity, label, count, truncated sample

### `GET /dashboard/v2/tools`

Oparte głównie o `tool_executions`.

Zwraca:

- byStatus, byCategory, byRisk
- topTools
- topFailures
- blockedHighRisk
- hangingStarted
- artifacts
- policyDecisions

### `GET /dashboard/v2/skills`

Zwraca:

- search/load/report funnel
- topSkills
- missedSearches
- usage by agent
- registry metrics, jeśli dostępne
- tool execution metrics dla skill tools

### `GET /dashboard/v2/quality`

Zwraca:

- totals: tasks, scoredTasks, nativeScorerRecords, outputScoreEvents, goalEvaluations
- coverage: taskCoverage, nativeScorerCoverage, outputScoreCoverage, goalEvaluationCoverage
- outcome: avgScore, passRate, passed, failed, evaluated
- distribution: bucket `0-0.3`, `0.3-0.7`, `0.7-1.0`
- scorerSummaries: scorerId, source, totalEvaluations, avgScore, passRate, low/mid/high
- byAgent: agentId, tasks, scoredTasks, coverage, avgScore, passRate, failed
- recentFailures: source, scorerId, agentId, taskId, score, timestamp, truncated reason
- coverageGaps: agents below 20% task coverage
- trend: `previousWindow`, taskCoverage, passRate, avgScore, evaluated

Do dodania później:

- breakdown per model/tool category, gdy V2 filtry i trace join będą gotowe;

### `GET /dashboard/v2/traces`

Parametry: `since`, `agentId`, `model`, `status`, `runId`, `taskId`, `threadId`, `limit`.

Zwraca paginowaną listę trace summaries:

- IDs: runId, taskId, threadId, turnId.
- status, agent, model, cost, tokens, latency.
- event counts.
- tool execution count.
- scorer evaluation count.
- first error.

### `GET /dashboard/v2/traces/:id`

Zwraca ograniczoną długością oś eventów dla konkretnego run/task/thread oraz powiązane tool envelopes i scorer outcomes.

## Normalizacja i jakość danych

### Agenty

Rozszerzyć `src/mastra/config/agent-ids.ts`:

- dodać aliasy camel/kebab dla `chef`, `analytics`, `content`, `researcher`, `crm`, `marketing`, `sales`, `writer`, `filmmaker`, `automation`.
- klasyfikować `plan-task-*` jako `plan`.
- klasyfikować `run-worker-*`, `worker:*`, `deliberation-worker-*` jako `worker`.
- utrzymać `unknown`, ale pokazywać root-cause: brak agentId w evencie, tool-only telemetry, legacy exporter.

### Modele

Wprowadzić normalizację model IDs:

- `deepseek/deepseek/deepseek-v4-flash` -> `deepseek-v4-flash`, jeśli to faktycznie ten sam provider/model.
- `deepseek/deepseek/deepseek-v4-pro` -> `deepseek-v4-pro`.
- lokalne aliasy Ollama oznaczać jako `local`.
- brak pricingu i zero tokens pokazywać jako jawny problem danych.

### Zdarzenia tooli

Ustalić metrykę bazową:

- legacy events: `tool_called`, `tool_error`.
- envelope events: `tool_call_started`, `tool_call_completed`, `tool_call_failed`.
- canonical source dla tool reliability powinna być kolekcja `tool_executions`.
- legacy events można używać jako fallback i do timeline historycznego, ale nie mieszać bez deduplikacji.

### Scorers

Pokazywać brak danych jako sygnał:

- `0 scorer records in range` nie znaczy "OK", tylko "quality coverage missing".
- Dodać coverage target, np. przynajmniej 20-30% istotnych tasków albo wszystkie wybrane task types.

## Frontend

### Struktura

Najbezpieczniejsza ścieżka:

1. Nie przepisywać całego dashboardu od razu.
2. Wydzielić Analytics do osobnego modułu frontendowego, np. `dashboard/analytics.js` i ewentualnie `dashboard/analytics.css`, ładowanego przez obecny `dashboard/index.html`.
3. Zostawić istniejące endpointy i widok jako fallback do czasu ukończenia V2.
4. Dopiero po stabilizacji usunąć duplikaty skryptów Analytics z `dashboard/index.html`.

Jeżeli projekt musi pozostać jednym plikiem HTML, sekcja Analytics powinna mimo to mieć wyraźny podział:

- state,
- fetch clients,
- renderers,
- chart helpers,
- table helpers,
- formatters.

### Proces rozdzielenia Analytics na osobne pliki

Rekomendowany kierunek: rozdzielić Analytics z `dashboard/index.html`, ale zrobić to warstwowo, bez build stepu i bez jednoczesnego przepisywania całej zakładki.

Docelowy minimalny układ:

```text
dashboard/
  index.html
  analytics.css
  analytics.js
```

Docelowy układ po stabilizacji V2:

```text
dashboard/
  index.html
  analytics/
    analytics.css
    analytics.js
    api.js
    charts.js
    formatters.js
    renderers.js
    state.js
```

Pierwsza iteracja powinna użyć wariantu minimalnego, bo obecny dashboard jest single-file i nie ma build pipeline. Rozbicie na folder `dashboard/analytics/*` warto zrobić dopiero wtedy, gdy V2 urośnie do kilku wyraźnych modułów.

### Route'y dla assetów

Obecnie `/dashboard-ui` czyta i zwraca jeden plik `dashboard/index.html`. Po wyciągnięciu JS/CSS trzeba dodać jawne route'y w `src/mastra/index.ts`:

- `GET /dashboard-ui/analytics.js`
- `GET /dashboard-ui/analytics.css`

Te route'y powinny:

- czytać pliki z `/projekty/mastra-agentic-environment/agentic-agents/dashboard`,
- ustawiać poprawny `Content-Type`,
- zwracać 404/500 z krótkim JSON-em przy braku pliku,
- nie serwować dowolnych ścieżek z query parametru, żeby nie zrobić przypadkowego file servera.

Nie rekomenduję od razu route'a typu `/dashboard-ui/assets/:path`, bo zwiększa powierzchnię błędu. Dwa jawne assety wystarczą na start.

### Zmiany w `dashboard/index.html`

Pierwszy krok powinien być mechaniczny:

1. Dodać link do CSS:

```html
<link rel="stylesheet" href="/dashboard-ui/analytics.css">
```

2. Dodać skrypt:

```html
<script defer src="/dashboard-ui/analytics.js"></script>
```

3. Zostawić istniejące inline skrypty jako fallback w pierwszym commicie, ale osłonić je warunkiem, żeby nie inicjalizowały Analytics drugi raz.

Docelowo trzeba mieć jeden globalny punkt startowy, np.:

```js
window.MastraAnalytics?.init({
  rootId: 'tab-analytics',
  apiBase: '/dashboard',
});
```

W trakcie migracji można użyć flagi:

```js
window.__MASTRA_ANALYTICS_EXTERNAL__ = true;
```

Stare inline Analytics powinno sprawdzać tę flagę i nie wykonywać własnego `loadAll()`, jeśli zewnętrzny moduł przejął inicjalizację.

### Granice odpowiedzialności plików

`dashboard/index.html`:

- struktura całego dashboardu,
- zakładki,
- wspólne nawigacje,
- kontenery dla Analytics,
- ładowanie `analytics.css` i `analytics.js`.

`dashboard/analytics.css`:

- layout tylko zakładki Analytics,
- health strip,
- sekcje V2,
- tabele,
- responsywność,
- empty/error/loading states.

`dashboard/analytics.js` w pierwszej iteracji:

- local state Analytics,
- fetch do endpointów V1 i V2,
- render overview,
- render charts,
- render tables,
- obsługa filtrów,
- lifecycle `init`, `destroy`, `refresh`.

Po stabilizacji można rozdzielić `analytics.js`:

- `api.js`: fetchery i fallback V1/V2.
- `state.js`: stan filtrów, cache odpowiedzi, compare period.
- `formatters.js`: format money, tokens, duration, percent, deltas.
- `charts.js`: wrapper Chart.js, destroy/update, common scales.
- `renderers.js`: sekcje HTML, empty/error states, tabele.
- `analytics.js`: tylko orchestration i publiczne API.

### Publiczne API modułu Analytics

`analytics.js` powinien wystawić jedno API na `window`:

```js
window.MastraAnalytics = {
  init(options),
  refresh(),
  destroy(),
};
```

`init(options)`:

- znajduje root zakładki,
- podpina event listenery filtrów,
- tworzy początkowy state,
- ładuje dane,
- renderuje sekcje.

`refresh()`:

- bierze aktualne filtry,
- odświeża dane,
- nie dubluje chart instances,
- zachowuje scroll i aktywne sortowanie tabel, jeśli to praktyczne.

`destroy()`:

- niszczy wykresy Chart.js,
- odpina event listenery,
- czyści timery auto-refresh.

Ten kontrakt pozwoli później przełączać zakładki bez wycieków timerów i wielu instancji wykresów.

### Fallback i kompatybilność

W okresie migracji Analytics powinien mieć trzy poziomy fallbacku:

1. Jeśli `/dashboard/v2/*` istnieje, używać V2.
2. Jeśli V2 nie istnieje, używać obecnych `/dashboard/*`.
3. Jeśli endpoint zwróci błąd, pokazać sekcyjny error state, a nie psuć całej zakładki.

Dla danych, które nie istnieją w V1:

- Tool Envelopes: pokazać "Requires `/dashboard/v2/tools`" albo empty state, dopóki backend nie jest gotowy.
- Skills V2: fallback do `/dashboard/skills`, ale z warningiem, że to tylko `skill_used`.
- Quality V2: fallback do `/dashboard/scores`.
- Traces: ukryć sekcję albo pokazać disabled state do czasu endpointu.

### Kolejność migracji frontendowej

1. Dodać asset routes dla `analytics.js` i `analytics.css`.
2. Utworzyć puste pliki z minimalnym `window.MastraAnalytics`.
3. Podpiąć pliki w `dashboard/index.html`.
4. Przenieść tylko helpery formatowania i chart lifecycle do `analytics.js`.
5. Przenieść fetch/state obecnego Analytics.
6. Przenieść render obecnych sekcji bez zmiany UI.
7. Uruchomić smoke test: obecny Analytics wygląda i działa jak wcześniej.
8. Dopiero po tym zacząć redesign V2 sekcja po sekcji.
9. Po stabilizacji usunąć stare inline Analytics z `dashboard/index.html`.

To ogranicza ryzyko: najpierw zmienia się architekturę plików bez zmiany zachowania, potem zachowanie bez ruszania reszty dashboardu.

### Testy po rozdzieleniu

Po samym wyciągnięciu plików, zanim zacznie się redesign:

- `curl -sS http://localhost:4111/dashboard-ui` zwraca HTML.
- `curl -sS http://localhost:4111/dashboard-ui/analytics.js` zwraca JS.
- `curl -sS http://localhost:4111/dashboard-ui/analytics.css` zwraca CSS.
- Zakładka Analytics ładuje dane z obecnych endpointów.
- Nie ma podwójnych requestów po jednym wejściu w zakładkę.
- Auto-refresh nie tworzy wielu timerów po przełączaniu tabów.
- Chart.js nie zostawia starych instancji po zmianie filtrów.
- Screenshot pierwszego viewportu jest zgodny z baseline albo różni się tylko technicznymi detalami ładowania assetów.

### Wykresy

Użyć Chart.js tam, gdzie wystarcza, ale zmienić typy:

- Donut modeli -> horizontal ranked bar + tabela.
- Surowy agent bar -> top N canonical agents + bucket other/workers.
- Timeline -> stacked bar + line overlays.
- Latency -> percentile table/lollipop + heatmap.
- Cost -> stacked daily bars + model/agent ranking.
- Skills -> funnel + ranking.
- Scorers -> coverage cards + histogram/box-like distribution.

### UX

- Pierwszy ekran powinien zmieścić health strip i główny timeline.
- Sekcje powinny być pełnoszerokimi bandami lub czytelnymi panelami, bez zagnieżdżania kart.
- Tabele powinny mieć sticky header, sortowanie, limity i drill-down.
- Kolory tylko semantycznie: success, warning, danger, neutral.
- Empty states muszą tłumaczyć brak danych jako problem danych, nie jako pusty wykres.
- Mobile: filtry zwijane, tabele z priorytetowymi kolumnami, wykresy bez ścisku osi X.

## Fazy implementacji

### Faza 0: baseline i bezpieczeństwo

- Zachować screenshoty obecnego Analytics jako baseline.
- Dodać krótkie smoke query dla obecnych endpointów.
- Spisać przykładowe dokumenty z `agent_events`, `tool_executions`, `mastra_scorers`.
- Potwierdzić, które dane są wrażliwe w input/output preview.

### Faza 1: rozdzielenie plików bez zmiany zachowania

- Dodać `dashboard/analytics.js`.
- Dodać `dashboard/analytics.css`.
- Dodać route `GET /dashboard-ui/analytics.js`.
- Dodać route `GET /dashboard-ui/analytics.css`.
- Podpiąć assety w `dashboard/index.html`.
- Wystawić `window.MastraAnalytics`.
- Przenieść obecny Analytics JS etapami:
  - formatters,
  - Chart.js helper,
  - fetch/loadAll,
  - renderers,
  - event listeners,
  - auto-refresh.
- Zostawić fallback inline tylko do momentu potwierdzenia, że zewnętrzny moduł działa.
- Usunąć duplikaty inline Analytics po weryfikacji.
- Zweryfikować, że UI zachowuje się jak przed migracją.

### Faza 2: normalizacja i V2 backend

- Dodać canonical agent classifier.
- Dodać model normalizer.
- Dodać endpoint `/dashboard/v2/summary`.
- Dodać endpointy `/dashboard/v2/agents`, `/models`, `/tools`.
- [x] Zaimplementować compare to previous period.
- Dodać testy agregacji na fixture danych.

### Faza 3: nowy overview

- Przebudować top health strip.
- Zastąpić Event Timeline wykresem health timeline.
- Dodać alert cards z red flags:
  - success rate spada,
  - tool error rate > próg,
  - p99/p50 ratio wysokie,
  - cost spike,
  - scorer coverage niskie,
  - blocked high-risk tools,
  - hanging executions.

### Faza 4: agents, models, cost, latency

- Zastąpić surowy agent chart canonical rankingiem i tabelą.
- Dodać scatter cost vs success.
- Dodać model efficiency table.
- Dodać cost breakdown po modelu/agent/day.
- Dodać latency percentiles i long-tail heatmap.

### Faza 5: envelopes i skills

- Dodać Tool Envelopes & Policy.
- Dodać Skills & Knowledge.
- Wykrywać skill metrics z `tool_executions` i registry, nie tylko z `skill_used`.
- Dodać top failures, hanging executions, blocked high-risk, no-result skill searches.

### Faza 6: quality i scorers

- [x] Dodać Quality section.
- [x] Połączyć `mastra_scorers`, `output_score`, `goal_completion_evaluated`.
- [x] Dodać coverage, pass rate i distribution.
- [x] Pokazywać brak scoringu jako coverage gap.
- [x] Dodać recent failures z taskId, scorerem i reason.
- [x] Dodać trend względem poprzedniego okresu.

### Faza 6.5: globalne filtry Analytics V2

- [x] Dodać kontrakt query params `agentId`, `model`, `toolCategory`, `toolRisk`, `toolStatus`.
- [x] Podpiąć filtry w backendzie dla summary, agents, models, latency, timeline, tools, skills i quality.
- [x] Dodać pasek filtrów w UI.
- [x] Przepiąć cost chart na filtrowany timeline V2.
- [x] Zweryfikować endpointy filtrowane przez curl.

### Faza 7: trace explorer i live rail

- [x] Dodać trace list i trace detail.
- [x] Dodać filtry po runId/taskId/threadId.
- [x] Dodać detail eventów, tool envelopes i scorer outcomes.
- [x] Podłączyć drill-downy z wykresów/tabel.
- [x] Przenieść Live Activity do wąskiego raila.

### Faza 8: polish, performance, dokumentacja

- [x] Deduplicacja Analytics JS.
- [x] Loading/error states per section.
- [x] Cache krótkich agregacji, jeśli Mongo zacznie być wolne.
- [x] Dokumentacja endpointów V2.
- [x] Visual regression screenshots desktop/mobile.

## Kryteria akceptacji

- Pierwszy ekran pokazuje zdrowie systemu, trend i najważniejsze anomalie bez scrollowania.
- Agent chart nie pokazuje setek workerów jako równorzędnych agentów.
- Skill section ma dane z realnych operacji skillowych lub jasny coverage warning.
- Tool envelope section pokazuje statusy, ryzyko, policy decisions, top failures i hanging executions.
- Scorer section pokazuje coverage, wyniki i brak danych jako problem jakości.
- Model/cost section pokazuje koszt, tokeny, efektywność i alias/missing pricing warnings.
- Każdy ważny alert pozwala przejść do trace/run/task.
- Endpointy V1 działają nadal albo mają kontrolowany fallback.
- Testy agregacji pokrywają normalizację agentów, modeli, tool envelopes i puste scorers.
- UI przechodzi podstawową weryfikację screenshotami na desktop i mobile.

## Ryzyka

- `dashboard/index.html` jest duży i łatwo wprowadzić regresję przy edycji w jednym pliku.
- Dane telemetryczne są częściowo legacy i częściowo envelope-based, więc trzeba jawnie wybrać canonical source per metryka.
- Brak pełnego pricingu lub token usage może zaniżać koszt.
- Sparse scorers mogą sprawić, że quality dashboard będzie bardziej coverage dashboardem niż score dashboardem na początku.
- Trace explorer może ujawniać input/output preview, więc musi mieć limity i redakcję.
- Agregacje po dużych oknach mogą wymagać indeksów w Mongo.

## Minimalny pierwszy zakres wdrożenia

Największy zwrot da pierwsza iteracja:

1. Canonicalizacja agentów i modeli.
2. `/dashboard/v2/summary`, `/agents`, `/models`, `/tools`.
3. Nowy health strip.
4. Nowy agent ranking zamiast surowego chartu.
5. Tool Envelopes & Policy.
6. Skill operations z `tool_executions`.
7. Scorer coverage warning.

To już zmieni Analytics z dashboardu metryk w narzędzie diagnozowania systemu.
