# BASELINE — Etap 0 planu Systemu Idealnego

> Zamrożony punkt odniesienia dla planu `ideas/IDEALSYSTEMMASTERPLAN.md` (zasada C2.4:
> „żaden etap nie broni się opinią, tylko liczbą"). Każdy kolejny etap dopisuje tu
> swój pomiar vs te liczby.
>
> Wygenerowano: **2026-07-20**, branch `feat/ideal-system-etap-0-baseline`
> (baza: `fix/automation-delegation-lifecycle` @ a817307 — stan działający live).

## 1. Jak odtworzyć pomiar

```bash
npm run baseline:metrics   # → reports/baseline/baseline-metrics-<data>.json
```

Skrypt: `src/mastra/scripts/baseline-metrics.ts`. Źródło danych: Mongo
`agent_events` + `mastra_scorers` przez istniejące agregacje
`services/dashboard-stats.ts` (te same, których używa tool
`system_agent_performance_report`). Koszty liczone z `tokenUsage × lib/model-pricing.ts`.

**Ograniczenia źródeł (ustalone w rozpoznaniu):**
- `agent_events` ma **TTL 30 dni** — okno 30d to maksymalny horyzont; baseline trzeba
  czytać z commitowanego JSON-a, nie z żywej bazy.
- `services/budget-tracker.ts` jest **in-memory** (reset przy restarcie) — świadomie
  NIE jest źródłem baseline'u.
- Tokeny per tura żyją na eventach `task_completed`/`task_failed` (skumulowane per
  tura agenta). Eventy `llm_call_completed` **nie niosą** `tokenUsage` (zweryfikowane
  na żywych danych: 0/43 dla meta) — to potencjalny kandydat do poprawy telemetrii,
  ale baseline liczy z poziomu tur, co odpowiada metryce planu „tokeny/turę meta".

## 2. Metryki bazowe (okno 30d: 2026-06-20 → 2026-07-20)

Pełny zrzut: `reports/baseline/baseline-metrics-2026-07-20.json`
(okno 7d w zrzucie jest puste — system nie miał ruchu w ostatnim tygodniu; miarodajne jest 30d).

| Metryka (plan C3) | Wartość baseline |
|---|---|
| **Tokeny / tura meta (prompt)** | śr. **85 609** · p50 50 574 · p95 219 707 (n=125) |
| Tokeny / tura meta (completion) | śr. 1 595 · p50 804 · p95 4 781 |
| Czas / tura meta | śr. 98 s · p50 16 s · p95 484 s |
| **Koszt / zadanie** | **$0,0337** (893 zadania · $30,06 łącznie) |
| Success rate zadań | 91,2 % (893 zadania, wszystkie agenty) |
| Koszt meta (30d) | $5,04 (130 tur) |
| **Delegacje** | 118 · success **76,3 %** · śr. 154 s · p50 95 s · p95 592 s |
| Równoległe lane'y bez kolizji | 0 (brak mechanizmu — Ledger dopiero w E1) |
| Tokeny łącznie (30d) | 68 748 232 |

Top cele delegacji (30d): researcherAgent 23× (78,3 %), n8nMcpEngineer 20× (95 %),
filmmakerAgent 18× (94,4 %), musicianAgent 15× (100 %), automationArchitect 13× (**69,2 %** — najsłabszy).

## 3. Stan checków (`check:*` + `e2e:*`)

Uruchomione sekwencyjnie 2026-07-20 na żywej infrastrukturze (Mongo, n8n, cloudflared,
serwer Mastra :4111 — wszystko up).

### Zielone (27)

| Check | Czas | Uwagi |
|---|---|---|
| check:meta-final-synthesis | <1s | asercje promptów meta |
| check:agent-generate-memory-thread | 1s | |
| check:n8n-mcp-engineer | 1s | |
| check:design-domain | <1s | |
| check:writer-domain | 1s | |
| check:filmmaker-domain | 1s | |
| check:musician-domain | <1s | |
| check:depth-controller | 1s | |
| check:harness-depth | 1s | |
| check:meta-harness-wrapper | 1s | fake agent, bez LLM |
| check:cognitive-loop-dry-run | 2s | fake agent, bez LLM |
| check:strategy-reflector | <1s | |
| check:pipeline-reflector | 1s | deterministyczny |
| check:goal-completion-scorer | 1s | pisze testowy GoalContract do Mongo |
| check:automation-delegation-contract | 1s | |
| check:automation-coverage | 1s | |
| check:automation-patterns | 1s | |
| check:automation-golden-path | 4s | |
| check:automation-autonomy | 3s | Mongo |
| check:scheduled-tasks | 1s | Mongo |
| check:n8n-runtime | <1s | sonda żywych endpointów n8n |
| check:n8n-mcp-pipeline-smoke | 1s | tryb coverage-block (bez serwera) |
| e2e:reflector-prepare-step | 2s | mock model, deterministyczny |
| e2e:reflector-stop-when | 1s | mock model, deterministyczny |
| e2e:reflector-output-scoring | 1s | mock model, deterministyczny |
| check:automation-live-safe-webhook | 153s | żywy n8n + realna delegacja LLM (architekt); deploy echo-webhooka + cleanup |
| e2e:webhook | 1s | pełny Golden Path bez LLM: compose→validate→risk(15/approve)→deploy(inactive)→mock test→cleanup |

`check:automation` (composite) = n8n-runtime + coverage + patterns + golden-path — pokryty częściami.

### Known-failing (1)

| Check | Status | Opis |
|---|---|---|
| `npx tsc --noEmit` | **3 błędy** | Pre-existing, wprowadzone commitem a817307 (scheduled tasks): `scheduled-task-store.ts:365` (typy findOneAndUpdate), `schedule-task.ts:104` (timezone `string` vs `string\|undefined`), `schedule-task.ts:113` (`nextStep: unknown`). Do naprawy osobnym zadaniem — nie blokuje runtime (tsx nie type-checkuje przy starcie). |

Nie ma npm scriptu `typecheck` ani `check:all` — kandydaci do dodania w E1
(plan C2.3 wymaga `check:all` jako bramy etapów).

## 3a. Pomiar Etapu 1 — Task Ledger (2026-07-20)

Branch `feat/ideal-system-etap-1-task-ledger`. Pełny opis: `docs/TASK-LEDGER.md`.

| Kryterium wyjścia E1 | Wynik |
|---|---|
| 3 lane'y w tle równolegle | ✅ `e2e:ledger-three-lanes`: 3 lane'y przez realny background-task-manager, wszystkie widoczne w jednym digeście |
| Czat płynny przy pracy w tle | ✅ odczyt digestu **5 ms** przy 3 działających lane'ach (asercja <1,5 s) |
| `status` pokazuje prawdę | ✅ digest: running/attention/finished-once; stale lanes auto-domykane (reconciler) |
| Push przychodzi na telefon | ✅ workflow n8n `9AfovUJUIvhghzll` aktywny; test e2e webhook→Telegram: execution success |
| Rollback | flaga `FEATURE_LEDGER_V1` (default ON) |

Nowe checki w bramie: `check:ledger-lifecycle` (14 asercji), `e2e:ledger-three-lanes`;
dodano `npm run check:all` (25 checków, wymóg C2.3) i `npm run typecheck`.
`check:all` przechodzi w całości po zmianach E1 (weryfikacja 2026-07-20).
Równoległe lane'y bez kolizji: mechanizm obserwacji jest; scheduler claims → E5.

## 3b. Pomiar Etapu 2 — Agent Board (2026-07-20)

Branch `feat/ideal-system-etap-2-agent-board`. Pełny opis: `docs/AGENT-BOARD.md`.

| Kryterium wyjścia E2 | Wynik |
|---|---|
| Tokeny/turę meta ↓ ≥25% | ✅ statyczny balast promptu **41 512 → 29 549 zn. (−28,8%)**; metryka live do potwierdzenia po ruchu (`baseline:metrics`) |
| `agent_board_get('researcherAgent')` z track recordem | ✅ zweryfikowane live: 96% ok, ~$0,147/task, ~1 min (n=25), model deepseek-v4-pro |
| Roster nie odstaje od kodu | ✅ `check:agent-board-sync` (9 asercji) w `check:all`; `check:meta-prompt-size` pilnuje regresji rozmiaru |
| Agenci widzą się nawzajem | ✅ toole tablicy u meta + 7 orkiestratorów domenowych |

Bonus z track recordu: tablica od razu ujawnia automationArchitect **39% ok**
(n=122, 30d) — najsłabsze ogniwo delegacji; kandydat na cel naprawczy przed E4.

## 3c. Pomiar Etapu 3 — Kontrakty komunikacji (2026-07-20)

Branch `feat/ideal-system-etap-3-communication-contracts`. Pełny opis: `docs/COMMUNICATION-CONTRACTS.md`.

| Kryterium wyjścia E3 | Wynik |
|---|---|
| Handoff research→writer przez ref+summary, nie wklejkę | ✅ `e2e:artifact-handoff`: 76 KB research → brief 646 zn., full content round-trip byte-identyczny |
| Koszt sekwencji spada mierzalnie vs wklejka | ✅ **−99,2%** payloadu handoffu (646 vs 76 225 zn.); >512 KB → storage plikowy |
| ResultEnvelope parsowany, fallback dla prozy | ✅ `check:result-envelope-parse` (9 asercji): fenced/bare/fallback, złe statusy bez wyjątku |
| Rollback | flaga `FEATURE_COMM_CONTRACTS` (default ON) |

Nowe w bramie: `check:result-envelope-parse`, `e2e:artifact-handoff`. `check:all`
przechodzi (53 przejścia, exit 0). TaskBrief v2 (`inputs[].artifactId`,
`outputContract.artifactType`, `laneId`, `claims[]`) + `plan-task.out` gotowe pod
bramki Plays w E4. `claims[]` zapisywane, scheduler → E5.

## 3d. Pomiar Etapu 5 — Claims/Scheduler/Idempotencja (2026-07-20)

Branch `feat/ideal-system-etap-5-claims-scheduler`. Pełny opis: `docs/CLAIMS-SCHEDULER.md`.
(Etap 4 — Plays — świadomie odłożony; patrz sekcja „Postęp wykonania" w planie.)

| Kryterium wyjścia E5 | Wynik |
|---|---|
| 2 lane na ten sam workflow n8n → drugi czeka; rozłączne → równolegle | ✅ `check:ledger-claims-conflict`: lease/lock, konflikt→queue, disjoint→parallel, release→promocja, `waitAndAcquireClaims` faktycznie czeka |
| Podwójne wykonanie niemożliwe przy retry | ✅ `check:idempotency-replay`: retry nie dubluje efektu; porażka retryable; jawny klucz dedupuje |
| Egzekwowanie realne | ✅ bramka `queued→running` w automation-job (claim `n8n:workflow:<id>` auto-derywowany) + kill switch wstrzymuje start |
| Rollback | flagi `FEATURE_LEDGER_SCHEDULER`, `FEATURE_IDEMPOTENCY` (default ON) |

Nowe w bramie: `check:ledger-claims-conflict`, `check:idempotency-replay`.
`check:all` przechodzi (exit 0). Idempotencja wpięta w 4 efekty (n8n_trigger,
gmail create+send, crm add_interaction); crm_create_lead pominięty (już upsert).
Metryka planu „równoległe lane'y bez kolizji: 0 → ≥3" — mechanizm dostarczony;
liczba live po wygenerowaniu ruchu. Preempcja fire-and-forget → dalszy rework.

## 3e. Pomiar Etapu 6 — Skill Distillation / success brain (2026-07-20)

Branch `feat/ideal-system-etap-6-skill-distillation`. Pełny opis: `docs/SKILL-DISTILLATION.md`.

| Kryterium wyjścia E6 | Wynik |
|---|---|
| Zadanie → skill → powtórka używa skilla | ✅ `check:skill-distill-roundtrip`: candidate→writer→SKILL.md→registry ładuje z puli; mini-eval gate'uje jakość, GARBAGE→kwarantanna |
| Kurator lifecycle | ✅ `check:curator-lifecycle`: liczniki, stale(30d)/archive(90d), niski success→repair |
| ≥25% taniej / ≥10 skilli po 2 tyg. | metryka LIVE — mechanizm dostarczony; liczba po działaniu nocnego cyklu na ruchu |
| Rollback | flaga `FEATURE_SKILL_DISTILLATION` (default ON) |

Nowe w bramie: `check:skill-distill-roundtrip`, `check:curator-lifecycle`.
`check:all` przechodzi (exit 0). Success brain domyka pętlę z istniejącym failure
brain (error-collector). Destylacja na lokalnym modelu (cron 03:00, koszt ~0);
curator niedziela 04:00. Trigger: envelope.lessons z E3.

## 3f. Pomiar Etapu 7 — Capability Gap Protocol (2026-07-22)

Branch `fix/delegation-depth-hardening` (wspólny). Opis: `docs/CAPABILITY-GAP-PROTOCOL.md`.

| Kryterium wyjścia E7 | Wynik |
|---|---|
| „Wczoraj nie umiał, dziś sam się nauczył" z jednym „ok" | ✅ `e2e:cgp-discover-attach` na PRAWDZIWYM serwerze MCP: gap→sandbox→approval→attach→invoke, dokładnie jedna akcja człowieka (zatwierdzenie id) |
| Sandbox nie widzi realnych sekretów | ✅ `check:cgp-sandbox-isolation` + e2e: w trialu serwer widzi `sandbox-mock-secret-*`, po attachu realny sekret z `.env` |
| Zero samo-zatwierdzania | ✅ attach przy `pending` odrzucony; maszyna stanów blokuje skróty |
| Rollback | protokół bierny (nikt nie woła = nic się nie dzieje); attach zawsze za zgodą |

Nowe w bramie: `check:cgp-sandbox-isolation`, `e2e:cgp-discover-attach`.
`check:all` przechodzi (exit 0). Testy wykryły 2 realne błędy implementacji
(PATH sandboxa bez nvm-owego node; kształt argumentów MCP) — oba naprawione.

## 4. Notatki dla kolejnych etapów

- **E1 (Task Ledger):** delegacje piszą eventy `type:'delegation'` z `agentId=target`,
  `durationMs`, `status` — adapter Ledgera ma gotowe punkty wpięcia w
  `delegate-task.ts` (4 miejsca logowania), `async-delegation.ts`,
  `background-task-manager.ts`, `automation-job-manager.ts`.
- **E2 (Agent Board):** metryka „tokeny/turę meta" spadnie głównie przez odchudzenie
  rosteru w prompcie — cel E2: ≥25 % vs 85 609 tok/turę ⇒ **≤ 64 207**.
- **Cel C3 po E10:** tokeny/turę −40 % ⇒ ≤ 51 365; koszt/zadanie −50 % ⇒ ≤ $0,0168;
  delegacje ≥3 równoległe lane'y bez kolizji.
- 7-dniowe okno było puste w dniu pomiaru — porównania robić na oknie 30d albo
  po wygenerowaniu świeżego ruchu (zadanie wzorcowe z C3 wciąż do zdefiniowania).
