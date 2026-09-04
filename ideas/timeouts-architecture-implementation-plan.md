# Plan ustrukturyzowania timeoutów i budżetów wykonania

Stan: 2026-07-22

Charakter: plan architektoniczny po weryfikacji `ideas/timeouts-audit.md`; bez zmian implementacyjnych.

Kod zweryfikowano na `feat/e7-capability-build` @ `4f91a7a`. W trakcie opracowania branch został niezależnie zmergowany i checkout przełączono na `master` @ `4102780`; commit `4f91a7a` jest jego przodkiem, a dwa późniejsze commity to merge E7 i dokumentacja. Audyt bazowy opisuje wcześniejszy branch `fix/delegation-depth-hardening`, dlatego poniżej rozdzielono ustalenia aktualne, korekty audytu i nowe blokery z E7.

---

## 1. Decyzja architektoniczna

Najlepszym rozwiązaniem nie jest jeden plik z większą liczbą stałych `TIMEOUT_MS`. Potrzebne są dwa współpracujące mechanizmy:

1. **Drzewo budżetów wykonania dla pracy synchronicznej** — jeden absolutny `deadlineAt`, przekazywany od transportu przez run, delegację, planner, retry, post-pass, tool, fetch/poll i proces. Dziecko może dostać wyłącznie deadline wcześniejszy od rodzica. Timeout musi wywołać realne anulowanie, a nie tylko przestać czekać na żywą obietnicę.
2. **Trwały execution plane dla pracy długiej** — każde zadanie, którego bezpieczny P95 nie mieści się w request budget, ma zostać zapisane jako job, dostać własny deadline, lease odnawiany heartbeatami, fencing token, checkpointy, anulowanie i recovery po restarcie. Request zwraca `202 + jobId`.

Granica sync/async ma wynikać z klasy operacji i transportu, nie z długości promptu. Cognitive depth nadal może sterować krokami, reflektorem i kontekstem, ale nie może samodzielnie przyznawać dodatkowego czasu.

Nie należy:

- podnosić globalnego Hono timeout do 10–30 minut;
- traktować streamingu jako obejścia dla buildów i mutujących workflowów;
- rozwijać obecnego `run-budget.ts` jako kolejnej mapy liczb bez propagacji sygnału;
- dodawać następnych lokalnych `Promise.race`;
- uznawać wpisu `status: cancelled` albo wygaśnięcia rekordu za dowód zatrzymania pracy.

---

## 2. Skorygowany obraz stanu obecnego

### 2.1. Sufity zewnętrzne

| Warstwa | Stan zweryfikowany | Znaczenie |
|---|---|---|
| Publiczny Cloudflare → n8n | Domyślny Proxy Read Timeout wynosi obecnie **120 s**, nie 100 s. Tunel repo wystawia n8n `:5678`, nie Mastrę `:4111`. | Dotyczy publicznego webhooka tylko wtedy, gdy n8n synchronicznie czeka na lokalną Mastrę. Stan wdrożonych workflowów trzeba zweryfikować operacyjnie. |
| Mastra/Hono | `@mastra/deployer` 1.32.1 instaluje globalny timeout **180 s**, bo `src/mastra/index.ts` nie ustawia `server.timeout`. | To faktyczny sufit JSON requestów do Mastry. Middleware Hono zwraca 504 przez `Promise.race`, ale nie abortuje handlera. |
| Node `server.requestTimeout` | Domyślne 300 s dotyczy **odbioru całego requestu**, nie wykonania handlera ani generowania odpowiedzi. | Nie jest sufitem dla runu. Może zwrócić 408 przed wywołaniem listenera. |
| Streaming | Utworzenie `Response` może zakończyć oczekiwanie middleware Hono, podczas gdy stream trwa dalej. | To właściwość transportu, nie kontrakt bezpieczeństwa dla długich mutacji. Nadal obowiązują disconnect, proxy i brak durability. |

Źródła zewnętrzne: [Cloudflare Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) oraz [Node.js `server.requestTimeout`](https://nodejs.org/api/http.html#serverrequesttimeout).

### 2.2. Korekty tez audytu K1–K18

| Punkt | Ocena po inspekcji aktualnego kodu |
|---|---|
| K1 | Deadline rzeczywiście nie rośnie, ale upgrade **nie podnosi in-flight maxSteps 10→40**. `stepCeiling` jest zamrożony przed głównym generate. Upgrade zmienia mapę/profil i może włączyć dodatkowe, nieograniczone post-passy. Jest częściowo kosmetyczny, częściowo powiększa ogon. |
| K2 | Brak relacji 150 kroków ↔ czas jest realny, lecz 150 to sufit, nie wymagana liczba kroków. Nie ma podstaw do tezy, że każdy pipeline zawsze timeoutuje. Film/music w async dostają 900 s. Sync pipeline używa jednak nieabortowalnego timeoutu i może zostawić zombie. |
| K3/K4 | Potwierdzone dla sync: coding/knowledge 300 s i automation 1200 s omijają resolver rodzica. Niezależny budżet async jest poprawną ideą, ale obecne async nie jest trwałym workerem. |
| K5 | Auto-`forcedAsync` działa tylko dla generic lane. Coding/automation/knowledge obchodzą resolver; n8nMcpEngineer i deliberation próbują skrócony sync. Planner może zużyć budżet zanim viability zostanie sprawdzone. |
| K6 | Mechanizm opisany w audycie nie odpowiada kodowi: capowane generic/pipeline nie dostają depth headera, a harnessowe dzieci z headerem właśnie nie są capowane. Nadal istnieje szerszy problem: lokalny budżet dziecka może przekraczać życie rodzica/transportu. |
| K7 | Potwierdzone i szersze. Registry deadline startuje przed precontextem, ale główny timer później dostaje ponownie cały timeout. GoalContract, precontext, planning, post-passy i persistence nie mają jednego zegara. Cleanup nie jest bezwarunkowym zewnętrznym `finally`. |
| K8 | Potwierdzone. Dla standard `maxStepsWithoutProgress=25` przy `maxSteps=25` nigdy nie zadziała; fast reaguje praktycznie za późno. |
| K9 | Potwierdzone jako konflikt klasy operacji i delegacji. Procesy potomne nie zawsze przeżyją timeout bezpośredniego `execFile`, ale wnuki/process group i praca po śmierci rodzica pozostają ryzykiem. |
| K10 | Narracja per-chunk jest rzeczywistym resetowaniem timeoutu; po niej dochodzą osobne concat/ffprobe. Część wczesnych `return` omija cleanup plików tymczasowych. Korekta: PDF nie wykonuje dwóch execów w jednym przebiegu — gałęzie są rozłączne i kończą się `return`. |
| K11/K12 | Potwierdzone: deadline pętli nie ogranicza pojedynczego wiszącego fetch; submit może powstać przed deadline, a download już po nim. Wspólny MCP timeout nie modeluje różnych operacji, discovery/listToolsets sumuje czasy wielu serwerów, a reconnect może wykonać kolejne pełne wywołanie. |
| K13 | Audyt miesza dwa tory: knowledgeAgent korzysta z MCP 180 s, a lokalny NotebookLM CLI ma osobny zestaw timeoutów. CLI query bez jawnej wartości dostaje około 310 s, a cross-notebook wykonuje do 4 zapytań sekwencyjnie. Oba tory wymagają wspólnej polityki, ale nie są jednym call chainem. |
| K14/K15 | Potwierdzone jako rozproszenie polityki; `execSync` nadal blokuje event loop. |
| K16 | Potwierdzone i niepełne. Helper producer-hunt nazywa się `generateJsonWithFallback`, nie `generateJsonWithRepair`. Gołe generate występują również m.in. w scheduled runnerze i trasach/usługach dodanych poza listą audytu. |
| K17 | Potwierdzone; bieżący branch dodaje również nieabortowalny download attachmentów. |
| K18 | Git pozostaje nieograniczony. Korekta: Graphify ma lokalny limit 20 s i preflight 5 s; problemem jest brak budżetu rodzica, nie nieskończony lokalny czas. |

### 2.3. Korekty infrastruktury I1–I16

- I4: inicjalizacja modeli, indeksu repo i skill registry jest uruchamiana fire-and-forget. Problemem jest raczej **przedwczesne readiness**, nie fałszywy timeout zdrowego, blokującego startupu.
- I5: nieograniczonych probe’ów jest więcej niż dwa; część wskazana w audycie nie decyduje bezpośrednio o rollbacku.
- I6: legacy watchdog i modular canary są ścieżkami rozłącznymi. Rzeczywisty race występuje między pełnym overwrite stanu przez supervisor i `state_merge` deployu, bez locka/CAS/generation id.
- I7: `n8n.listWorkflows()` ma lokalne 10 s, ale browser polling nadal nie ma timeoutu/single-flight, a endpoint odpytuje nieograniczony zbiór eventów bez `maxTimeMS`.
- I8: po uwzględnieniu clampów niżej w stacku pozostaje **6**, nie 8, tras bez bezpiecznego limitu; część ma dodatkowo N+1.
- I10: `AUTOMATION_DEFAULT_TIMEZONE` jest martwe. Rozjazd wynika z niejawnego dziedziczenia timezone n8n i builderów cron bez jawnej strefy.
- I11: ręczne `--promote` może działać poza observe-only; stała pętla pozostaje obserwacyjna i nie ma trwałego launchera.
- I12: dodatkowy duplikat to `FEATURE_KNOWLEDGE_PRECONTEXT`. Puste `CHEF_DOCS_DIR` wraca przez `||` do tego samego defaultu; `NLM_BINARY_PATH` rzeczywiście staje się PATH-zależny.
- I15: brak auth i CORS `*` obejmuje dużo więcej niż approvals i `/ws`: również generate, cancel/reschedule, mutacje workspace oraz side-effecting `GET /deploy/crash-test`.

### 2.4. Korekty „fosyliów”

- Martwe env są potwierdzone: `AUTOMATION_MAX_FIX_ATTEMPTS`, `META_AGENT_MAX_STEPS`, `META_AGENT_SYNC_TIMEOUT_MS`.
- `waitAndAcquireClaims` ma produkcyjnych callerów; nie jest martwy.
- `waitBackgroundTask` jest używany przez background task tool; nie jest martwy.
- `HarnessGenerateInput.abortSignal` jest praktycznie martwy na granicy delegacji, ale dodatkowo wspólny tool envelope gubi sygnał przekazany przez SDK.
- Mongo `serverSelectionTimeoutMS=5000` ogranicza wybór serwera, nie wszystkie operacje Mongo, indeksowanie ani czas zapytań.

---

## 3. Dodatkowe blokery znalezione poza audytem

### P0 — naruszają izolację albo pozwalają pracy żyć po śmierci właściciela

#### N1. Kolizja `runId = taskId`

`generateWithHarness` wybiera `input.runId ?? input.taskId ?? randomUUID()`. Parallel dispatch uruchamia wiele subtasków z tym samym `taskId`, różnymi `subtaskId` i bez osobnego `runId`.

Stan mapowany tylko po `runId` obejmuje:

- depth w `depth-controller.ts`;
- deadline w `run-budget.ts`;
- reflector w `strategy-reflector.ts`;
- rekord `agent_runs` i status bieżącego subtaska.

Skutki:

- ostatni start nadpisuje deadline/depth rodzeństwa;
- równoległe subtaski współdzielą jeden reflector i prompt/config pierwszej instancji;
- pierwszy finisher usuwa deadline oraz reflector pozostałych;
- `resolveDelegationBudget` po cudzym cleanupie wraca do niecapowanych wartości;
- pierwszy ukończony run może oznaczyć wspólny rekord `completed`, gdy inne nadal pracują;
- kolejne retry tego samego subtaska nadpisują historię zamiast mieć osobny attempt.

`runId` musi identyfikować pojedynczą próbę wykonania. Korelacja należy do osobnych `rootRunId`, `parentRunId`, `taskId`, `subtaskId`, `attemptId`.

#### N2. `withToolEnvelope` wyrzuca `ToolExecutionOptions.abortSignal`

Mastra przekazuje executorowi drugi argument runtime z `abortSignal`. `withToolEnvelope` zwraca funkcję przyjmującą tylko input i przekazuje dalej własne metadata. `wrapWithResultEnvelope` w delegate-task również przyjmuje jeden argument.

Timeout `agent.generate` może więc abortować model, ale już rozpoczęty `system_delegate_task`, `bg_task` lub inny wrapped tool nie dostaje sygnału i może dalej mutować stan.

Osobno `meta-harness.ts` nie promuje `options.abortSignal` do top-level `HarnessGenerateInput.abortSignal`; harness zastępuje go własnym sygnałem. Disconnect klienta nie przechodzi pełnego łańcucha.

#### N3. Planner działa przed wyborem skutecznego budżetu

Delegate może wykonać do dwóch prób po 45 s przez nieabortowalny `Promise.race`, zanim obliczy viability childa. Po timeout/errorze może dołożyć replan. W runie fast planner może przeżyć rodzica, cleanup usunie deadline, a późniejszy resolver przyzna osieroconemu toolowi pełny statyczny budżet.

#### N4. Timeout głównego LLM nie jest timeoutem lifecycle

Precontext zużywa registry deadline, lecz główny generate później dostaje od nowa pełne 60/180/300 s. Post-passy są gołymi generate bez timeoutu i bez sygnału. Wyjątek przed głównym `try` albo wewnątrz obsługi błędu może zostawić rejestry bez cleanupu.

### P0/P1 — obecne „async” nie jest trwałe

#### N5. Async delegation jest tylko `void executeDelegation`

Rekord ląduje w Mongo, ale executor żyje w procesie serwera. Restart/deploy traci pracę; nie ma osobnego lease, heartbeat, recovery ani trwałej kolejki. Fire-and-forget otwarcie lane i osobny transition mogą się ścigać przy szybkim zakończeniu.

#### N6. Capability BUILD może utracić claim w trakcie zdrowej pracy

Na branchu E7:

- każda komenda może trwać 30 min;
- quality gate uruchamia kolejno `tsc` i `check:all`, więc lokalny sufit wynosi 60 min;
- claim lease ma 20 min i nie jest odnawiany;
- lane staje się stale po 15 min bez heartbeat;
- reconciliation może oznaczyć zdrowy build jako failed i zwolnić claim;
- kolejny build może zacząć mutować repo równolegle;
- finalny transition failed → done jest niepoprawny i błąd jest połykany;
- postęp kroków jest trzymany w pamięci, a Mongo dostaje pustą listę na starcie i pełny report dopiero na końcu;
- `startCapabilityBuild` uruchamia `void runCapabilityBuild`, bez recovery po restarcie.

To jest split-brain na krytycznej ścieżce repo/merge/promotion, nie tylko brak timeoutu.

#### N7. Scheduled runner może uruchomić tę samą pracę drugi raz

Dispatch nie ma total deadline ani abortu. Lease ma 10 min bez renewal; agent używa gołego `agent.generate`; batch jest sekwencyjny. Po wygaśnięciu lease drugi runner może przejąć nadal wykonywane zadanie. Domyślna idempotency nie blokuje skutecznie reacquire tego samego `taskId` w stanie running.

#### N8. Background task TTL nie zatrzymuje procesu

`expiresAt` oznacza retencję/staleness rekordu, nie runtime deadline. Status po restarcie zależy od PID/status file, ale in-memory child listener przepada. Cancel oznacza rekord jako cancelled bez potwierdzenia wyjścia i bez gwarantowanego TERM → grace → KILL dla całego process group. To samo rozróżnienie dotyczy cancel automation job, który zmienia boolean/status, ale nie abortuje trwającego Golden Path.

### P1 — budżety resetują się w retry, pollach i operacjach I/O

#### N9. Retry subtasków nie ma aggregate deadline

Initial + retry + escalation resetują timeout per próba; każda próba może uruchomić dodatkowy offline fallback. Dla complex daje teoretycznie do sześciu calli po 300 s. `MAX_RETRY_ATTEMPTS` jest nieużywany. Grupy są sekwencyjne, więc suma nie ma sufitu rodzica.

#### N10. Prompt attachments

`prompt-attachments.ts` pobiera arbitralny URL bez sygnału, czyta całe `arrayBuffer()`, a limit rozmiaru sprawdza dopiero potem. Dzieje się to przed utworzeniem harnessowego budgetu w meta-harness. To jednocześnie nieskończone czekanie poza root deadline, memory amplification i związane ryzyko SSRF/redirectów.

#### N11. Brak operacyjnego deadline Mongo

`serverSelectionTimeoutMS` nie ogranicza zapytań po zestawieniu połączenia. Dashboard, index bootstrap, lane/claim operations i inne query nie mają jednolitego `maxTimeMS`/client-side deadline. Wisząca operacja DB może wyjść poza request/job i zablokować readiness.

#### N12. Niepełne pokrycie helperów

Poza listą audytu pozostają m.in. gołe generate w scheduled runnerze, producer-hunt, custom generate route i wybranych workflowach oraz fetch bez sygnału w cron runnerze i prompt attachments. Wspólny tool envelope obejmuje tylko część narzędzi, więc nie jest dziś globalnym punktem egzekucji.

Dalsze nieanulujące `Promise.race` występują w coding/knowledge/automation precontext. MCP discovery enumeruje serwery sekwencyjnie; nightly distillation może uruchomić dziesiątki sekwencyjnych generate; producer-hunt i weekly-content mnożą LLM calls per lead/sekcję.

#### N13. Brak limitów liczności i fan-out

Sam timeout pojedynczej operacji nie ogranicza sumy:

- design narrate resetuje limit per chunk, bez totalnego limitu scen;
- NotebookLM cross-query wykonuje do 4 długich query sekwencyjnie;
- producer-hunt ma nieograniczony `count`, pętle per lead i wielokrotne fallbacki LLM;
- Tavily może wykonać do 30 zapytań równolegle;
- MCP discovery sumuje retry wielu serwerów;
- skill distillation i content flows wykonują serie generate.

Polityka musi zawierać `maxItems`, `maxFanOut`, `maxConcurrency` i koszt/attempt quota, nie tylko milisekundy.

### P1/P2 — infrastruktura może uznać niegotowy lub uszkodzony proces za zdrowy

#### N14. Health nie jest readiness

`/health` i `/deploy/health` zwracają sukces niezależnie od krytycznej inicjalizacji. Listener jest dostępny przed ukończeniem event engine, Mongo/indexów i zadań startowych. Promotion może przełączyć ruch na proces niegotowy funkcjonalnie.

#### N15. Brak graceful drain i supervision

SIGTERM wykonuje natychmiastowy `process.exit(0)`; nie ma zatrzymania acceptu, readiness=false, abortu sync runów, oczekiwania na workerów, release lease ani `closeDb`. Mastra działa jako background Node z pidfile, bez trwałego supervisora. `uncaughtException` może zostać połknięty i proces pozostać „healthy” w stanie nieokreślonym.

#### N16. Deploy nie ma jednego deadline/state ownera

Brakuje globalnego locka, generation id i zweryfikowanej tożsamości PID. `npm install`, build, część curl/mongosh nie mają limitu. Pola `deploy.config.json` są częściowo dekoracyjne, a wait helper nie wlicza czasu samego probe’a. Równoległe ścieżki mogą utracić update stanu.

#### N17. Timeout nie chroni przed OOM ani nieautoryzowanym side effect

Media routes alokują cały Range lub czytają pełny plik; surowe limity query mają pozostałe luki; CORS jest `*`, auth nie jest ustawione. Publiczny endpoint jobów/status/cancel nie może zostać bezpiecznie wystawiony, dopóki nie ma auth/RBAC, rate limitu, clampów i streamowania bounded chunków.

#### N18. CI nie egzekwuje kontraktu

CI wykonuje tsc i build, ale nie `check:all`. `check:delegation-budget` nie jest zarejestrowany w `package.json`. `check:all` to 37 sekwencyjnych komend bez własnego total budget; test capability build używa fake’ów i nie sprawdza lease, restartu, progress ani czasu.

---

## 4. Niezmienniki docelowego systemu

Implementacja jest poprawna dopiero, gdy zawsze obowiązują następujące reguły:

1. Każda próba ma unikalny `runId`; identyfikatory korelacyjne nie są kluczami stanu wykonania.
2. Każda praca ma dokładnie jeden absolutny `deadlineAt` albo jawnie deklaruje brak deadline tylko dla procesu-supervisora.
3. `child.deadlineAt <= parent.deadlineAt - reserve`.
4. Planner, retry, post-pass, polling i finalizacja zużywają ten sam root deadline; żadna próba nie resetuje zegara.
5. Timeout kończy pracę: AbortSignal dla cooperative I/O/LLM, a dla procesu TERM → bounded grace → KILL całej grupy.
6. Jeśli komponent nie potrafi honorować abortu, nie wolno wykonywać go jako długiej pracy wewnątrz requestu.
7. Request kończy się przed limitem transportu z rezerwą na serializację, zapis stanu i odpowiedź.
8. Długi job jest zapisany przed zwróceniem `202`; restart workera nie gubi go.
9. `deadlineAt`, `leaseExpiresAt`, `heartbeatAt` i `retentionExpiresAt` są osobnymi polami i mają osobne znaczenie.
10. Lease jest odnawiany; utrata lease abortuje pracę. Fencing token blokuje późne mutacje starego workera.
11. Cancel ma stan przejściowy `cancelling`; `cancelled` pojawia się dopiero po potwierdzonym zatrzymaniu lub z jawnym `terminationUnconfirmed`.
12. Każdy retry ma `attemptId`, server-side licznik i mieści się w root deadline.
13. Każdy fetch ma total deadline, per-attempt deadline, limit body i politykę redirect/retry.
14. Każdy poll ogranicza również pojedynczy request oraz sleep, nie tylko warunek `while`.
15. Każdy zewnętrzny proces ma deadline, bounded output i gwarantowany cleanup potomków.
16. Fan-out ma jawne `maxItems`, `maxConcurrency` i koszt quota; suma dzieci nadal mieści się w root deadline.
17. Każde zapytanie listujące ma clamp, projection/paginację i deadline DB.
18. Status `completed/failed/timed_out/cancelled` jest zapisywany tylko przez aktualnego właściciela lease/fencing tokena.
19. Timeout mutującej operacji rozróżnia `aborted_before_commit` od `unknown_outcome`; nie wykonuje ślepego retry side effectu.
20. Telemetria odróżnia `deadline_exceeded`, `operation_timeout`, `client_cancelled`, `lease_lost`, `worker_lost` i `transport_timeout`.

---

## 5. Docelowa architektura

### 5.1. Jedno źródło polityki

Utworzyć deklaratywny, typowany rejestr, np.:

- `src/mastra/config/execution-budget-policy.ts`;
- `src/mastra/config/execution-budget-env.ts`.

Rejestr ma opisywać nazwaną klasę, a nie anonimową liczbę:

- transport: `edge_public`, `internal_http`, `stream_session`;
- execution lane: `interactive`, `durable_job`;
- workload: `reasoning`, `coding`, `research`, `media`, `automation`, `capability_build`, `scheduled`, `deploy`, `probe`;
- operation: `llm`, `http_attempt`, `poll_total`, `process`, `mongo_query`, `post_pass`, `cleanup`.

Każdy wpis zawiera:

- total duration;
- rezerwę rodzica;
- per-attempt cap;
- max attempts i backoff;
- maxItems, maxFanOut, maxConcurrency i koszt quota;
- step quota, jeśli dotyczy;
- sync eligibility;
- job deadline;
- heartbeat/lease policy;
- retryability i idempotency requirement.

Env nadpisuje wyłącznie jawnie wybrane wartości. Wszystkie jednostki mają sufiks, walidację zakresu i fail-fast przy błędnej wartości. Duplikaty env oraz rozjazd z `.env.example` są błędem CI.

### 5.2. `ExecutionBudget` zamiast mapy deadline’ów

Utworzyć runtime service, np. `src/mastra/services/execution-budget.ts`, z kontraktem:

- `budgetId`, `policyVersion`;
- `runId`, `rootRunId`, `parentRunId`, `taskId`, `subtaskId`, `attemptId`;
- `executionClass`, `lane`;
- monotoniczne wyliczanie remaining oraz utrwalone wall-clock `deadlineAt`;
- połączony `AbortSignal`;
- `child(operation, requestedMs, reserveMs)`;
- `remainingMs()`, `throwIfExpired(phase)`, `checkpoint(phase)`;
- typed timeout/cancel error.

AsyncLocalStorage jest wygodnym transportem in-process, ale granice muszą być jawne:

- wrapper HTTP tworzy root budget;
- harness dostaje budget jako argument i ustawia ALS;
- tool executor zachowuje pełne `ToolExecutionOptions` i łączy sygnały;
- delegacja tworzy child budget;
- durable job serializuje `deadlineAt`, policy version i correlation, a worker tworzy nowy root runtime context;
- background job po zaakceptowaniu nie dziedziczy krótkiego deadline requestu. Request budget obejmuje tylko walidację, zapis i enqueue.

Dotychczasowe `run-budget.ts` powinno zostać zastąpione adapterem kompatybilności, a następnie usunięte.

### 5.3. Unikalna tożsamość runu

Rozdzielić:

- `taskId`: cel biznesowy/korelacja;
- `subtaskId`: jednostka planu;
- `runId`: pojedyncze uruchomienie;
- `attemptId`: konkretna próba/retry;
- `rootRunId` i `parentRunId`: drzewo;
- `turnId`: interakcja.

Harness zawsze generuje unikalny `runId`, chyba że caller jawnie przekazuje poprawny unikalny identyfikator. Parallel dispatch tworzy osobny run per subtask i attempt. Mongo `agent_runs`, reflector, depth, tool events i budget registry używają runId; widoki agregują po task/root.

### 5.4. Cognitive depth oddzielony od execution class

`fast/standard/deep/critical` ma odpowiadać za:

- maxSteps;
- context budget;
- planning/reflection;
- recovery reserve.

Nie ma bezpośrednio decydować, czy film, build lub automation zmieści się w 60 s. Execution class jest wybierana deterministycznie z:

- endpointu/transportu;
- docelowego agenta/workflow/toola;
- jawnego trybu `sync|async`;
- deklarowanych capabilities i side effects;
- historycznego P95.

Prompt classifier może być sygnałem pomocniczym dopiero po routingu. Testy muszą obejmować naturalne polskie imperatywy: `zrób`, `wygeneruj`, `przygotuj`, `znajdź`, `napisz`, `popraw`, `stwórz`, `nagraj`, `zaplanuj`.

Mid-run depth upgrade nie przedłuża root deadline. Jeśli głębsza praca się nie mieści, system zapisuje checkpoint i przechodzi do durable joba zamiast udawać dodatkowy budżet.

### 5.5. Jeden registry executorów delegacji

Zastąpić specjalne gałęzie coding/automation/knowledge/generic deklaratywnym rejestrem:

- target agent;
- workload class;
- sync executor;
- async job handler;
- maxSteps/cognitive profile;
- sync eligibility;
- default duration;
- wymagane claims;
- idempotency/side-effect class;
- salvage strategy.

Resolver działa **przed plannerem**. Planner, child i replan dostają child budgets z tego samego root. Generic pipeline sync używa abortowalnego wrappera; sync i async nie mogą zmieniać semantyki pipeline/reflektora bez jawnej decyzji.

### 5.6. Cały lifecycle pod jednym budżetem

Outer scope harnessu obejmuje:

1. GoalContract/bootstrap;
2. precontext;
3. planning;
4. main generate;
5. tool executions;
6. reflection/depth/deliberation/review/approval/goal-repair;
7. persistence i final response reserve.

Każdy post-pass używa wspólnego abortowalnego helpera z małym child budgetem. Pass jest pomijany z jawną telemetryką, jeśli remaining jest mniejsze niż rezerwa. Cleanup wszystkich rejestrów jest w jednym bezwarunkowym `finally`.

### 5.7. Wspólne adaptery I/O

#### `budgetedFetch`

- łączy caller signal, budget signal i per-attempt timer;
- odróżnia total deadline od per-attempt timeout;
- ogranicza redirects, body/download bytes oraz czas odczytu body;
- retry tylko dla bezpiecznych/idempotentnych operacji;
- mutacje raportują niejednoznaczny wynik zamiast automatycznie ponawiać po timeout;
- exponential backoff + jitter + `Retry-After`, ale wyłącznie w remaining;
- timeoutuje również poll request i download;
- zwraca typed error i telemetrykę.

Migracja obejmuje film/music, prompt attachments, Ollama, weather, reviews, cron runner, Tavily, webhooks, n8n REST i pozostałe fetch.

Remote submit/poll powinien utrwalać remote job id i, jeśli provider to wspiera, wykonywać jawne cancel. Brak potwierdzenia cancel jest stanem `terminationUnconfirmed`, a nie sukcesem.

#### `budgetedPoll`

- jeden absolute deadline;
- child budget na każdy request;
- abortowalny sleep;
- brak nowego ticka po abort;
- ostatni odczyt tylko jeśli mieści się w remaining;
- zapis remote job id do salvage/checkpoint.

#### `budgetedProcess`

- preferuje `spawn/execFile`, nie `execSync`;
- uruchamia kontrolowaną process group;
- TERM → grace → KILL całej grupy;
- bounded stdout/stderr;
- `GIT_TERMINAL_PROMPT=0` i nieinteraktywne flagi;
- jawny shell tylko tam, gdzie konieczny;
- deadline rodzica + lokalny cap;
- status końcowy dopiero po `exit/close`.

Migracja obejmuje git/worktree, design/ffmpeg/Playwright, NotebookLM CLI, Graphify, terminal/external-projects, deploy i capability gates.

Adapter gwarantuje cleanup katalogów tymczasowych także przy każdym early return, timeout i abort.

#### `budgetedMongo`

- connection/server selection jako osobna polityka;
- client-side operation deadline i, gdzie wspierane, server-side `maxTimeMS`;
- paginacja/projection/clamp;
- bounded index bootstrap;
- retry tylko dla bezpiecznych operacji;
- checkpoint przed/po mutacji i fencing token dla jobów.

#### MCP i NotebookLM

- Rozdzielić klientów/toolsets per serwer i ładować je leniwie zamiast wykonywać globalne `listToolsets()`.
- Discovery wszystkich serwerów ma jeden startup budget, kontrolowaną współbieżność i jawny wynik partial.
- Reconnect/retry zużywa ten sam deadline; nie uruchamia drugiej pełnej próby po jego wyczerpaniu.
- NotebookLM MCP i lokalny CLI pozostają osobnymi transportami, ale korzystają z tej samej workload policy, cardinality limitów i budget adapters.
- Cross-notebook oraz pętle producer-hunt mają total deadline i bounded item count.

### 5.8. Trwały job execution plane

Zamiast kolejnych `void run...` utworzyć wspólny `execution_jobs` store i osobny supervised worker.

Minimalny rekord:

- `jobId`, `type`, `payloadRef`, `policyVersion`;
- `taskId/rootRunId/parentRunId`;
- `status: queued|leased|running|cancelling|completed|failed|timed_out|cancelled`;
- `deadlineAt`, `leaseExpiresAt`, `heartbeatAt`, `retentionExpiresAt`;
- `leaseOwner`, monotoniczny `fencingToken`;
- `attempt/maxAttempts/nextAttemptAt`;
- `claims`;
- `progress`, `checkpoint`, `resultArtifactId`, `error`;
- `cancelRequestedAt`, `terminationConfirmedAt`.

Worker:

- atomowo lease’uje job;
- odnawia lease i claims heartbeatem;
- kończy pracę po utracie fencing tokena;
- przed każdym side effectem sprawdza ownership;
- odzyskuje job po restarcie;
- uruchamia idempotentne/checkpointowalne handlery;
- publikuje progress po każdym kroku;
- jest nadzorowany przez systemd lub kontener z restart policy;
- przy SIGTERM przestaje lease’ować, ustawia draining i kończy/abortuje bieżące prace w ograniczonym czasie.

Do migracji:

1. async delegation;
2. automation job manager;
3. capability build;
4. scheduled task runner;
5. background task manager;
6. media generation/polling;
7. repo maintenance/deploy, jeśli ma pozostać sterowany z aplikacji.

Capability build wymaga dodatkowo fenced repo claim, unikalnego worktree, heartbeat podczas każdego commandu i sprawdzenia fencing tokena bezpośrednio przed merge/promotion.

### 5.9. Transport i API

- Jawnie ustawić globalny `server.timeout=180000` dla widoczności, ale nie traktować go jako cancel.
- Każdy route dostaje application budget mniejszy od sufitu transportu.
- Długie trasy zwracają `202 { jobId, statusUrl, cancelUrl }`.
- Status jest tani, paginowany i cacheable; progress opcjonalnie przez SSE. SSE przenosi stan joba, nie trzyma samej pracy w handlerze.
- Disconnect klienta abortuje wyłącznie pracę sync. Zaakceptowany durable job żyje według własnego kontraktu.
- Publiczne n8n ma szybko zaakceptować żądanie i nie czekać na Mastrę.
- Custom `/deploy/automation-architect/generate`, film/music, capability build i podobne nie mogą wykonywać długiej mutacji w JSON request.

Przed wystawieniem job API: auth/RBAC, CORS allowlist, rate limits, idempotency key i audyt uprawnień cancel/approve.

---

## 6. Początkowa polityka budżetów

Wartości są punktem startowym do rollout, nie wiecznym kontraktem. Po wdrożeniu telemetryki należy je stroić na P95/P99.

| Klasa | Application deadline | Zasada |
|---|---:|---|
| `edge_public_accept` | 10 s | Walidacja, persist, enqueue, `202`. Żadnego LLM/build/media. |
| `edge_public_sync` | 90 s | Tylko bounded read/krótka interakcja. Zostawia 30 s do domyślnej ściany Cloudflare 120 s. |
| `internal_http_sync` | 165 s | Zostawia 15 s przed Hono 180 s na finalizację/transport. |
| `health_probe` | 3–5 s | Bez ciężkich zależności dla liveness; readiness ma bounded checks. |
| `dashboard_query` | 2–5 s | Clamp, projection, cache; klient ma krótszy timeout i single-flight. |
| `post_pass` | min(15–30 s, remaining) | Pomijany, jeśli naruszyłby final response reserve. |
| `job_coding/knowledge` | początkowo 5 min | Zachować obecną zgodność, ale jako total job deadline. |
| `job_media` | początkowo 15 min | Submit, poll i download pod jednym deadline. |
| `job_automation` | początkowo 20 min | Total deadline całego Golden Path, nie per faza. |
| `job_capability_build` | początkowo 90 min | Jeden total deadline obejmujący wait, gate, merge i opcjonalną promotion; fazy biorą child budget. |

Lease nie powinien być równy maksymalnemu czasowi joba. Zalecany start:

- heartbeat co 15–30 s;
- lease TTL 3–4 × heartbeat;
- renewal atomowy z fencing tokenem;
- natychmiastowy abort przy utracie lease;
- retention liczona osobno w dniach.

Step budget pozostaje osobną quota. Dla standard/fast próg no-progress ma zostawiać co najmniej 2–3 kroki recovery i mieć jednoznaczną semantykę `>=`.

---

## 7. Plan realizacji

### Etap 0 — kontrakt, baseline i testy regresyjne

Cel: zamrozić poprawne rozumienie przed zmianą zachowania.

- Dodać ADR opisujący sync/durable boundary, absolutny deadline, lease i fencing.
- Zarejestrować bieżące p50/p95/p99 oraz timeout/orphan counts tam, gdzie dane istnieją.
- Zbudować automatyczny inventory: `agent.generate`, `fetch`, `Promise.race`, `exec/execFile/spawn/execSync`, poll loops, Mongo list/query, raw timeout literals.
- Utworzyć allowlistę uzasadnionych wyjątków z właścicielem i datą usunięcia.
- Dodać failing tests dla:
  - runId collision w parallel dispatch;
  - utraty ToolExecutionOptions.abortSignal;
  - coding/automation/knowledge omijających parent budget;
  - post-passu po deadline;
  - retry resetującego root deadline;
  - capability claim/lane wygaśniętych podczas zdrowego gate;
  - scheduled duplicate po lease expiry.
- Dodać `check:delegation-budget` do package scripts, ale nie uznawać go za wystarczające pokrycie.

Gate wyjścia: udokumentowana macierz klas i czerwone testy odtwarzające P0.

### Etap 1 — P0 containment i poprawna tożsamość

- Oddzielić runId/taskId/subtaskId/attemptId/root/parent.
- Naprawić parallel dispatch i persistence `agent_runs`.
- Zmienić `withToolEnvelope` i wszystkie dodatkowe wrappery tak, aby zachowywały pełne `ToolExecutionOptions`.
- Przekazać client/root abort przez meta-harness do top-level HarnessGenerateInput.
- Umieścić cleanup depth/deadline/reflector w bezwarunkowym outer `finally`.
- Dodać abortowalny timer do planner/replan i sprawdzać viability przed plannerem.
- Tymczasowo wymusić async dla sync automation build/media/capability paths, zanim durable worker będzie gotowy; read-only analysis może pozostać sync.

Gate wyjścia: slow tool kończy się po abort rodzica; równoległe subtaski nie współdzielą żadnego execution state.

### Etap 2 — rdzeń `ExecutionBudget` i policy registry

- Wprowadzić typowaną politykę i walidację env.
- Zaimplementować absolute deadline, child budget, reserve, signal composition i typed errors.
- Dodać ALS oraz jawny argument na granicach usług.
- Przepiąć cały harness lifecycle, post-passy i persistence.
- Zastąpić specjalne lane’y delegacji registry executorów.
- Przenieść planner, retry, fallback, replan i salvage do wspólnego root budget.
- Oddzielić cognitive depth od execution class.
- W headerach/prompcie raportować rzeczywisty effective remaining oraz lane, nie lokalny profil timeoutu.

Gate wyjścia: test property-based potwierdza dla całego drzewa `child.deadline <= parent.deadline - reserve`; suma retry/post-pass nie przekracza root.

### Etap 3 — adaptery I/O i procesów

- Wdrożyć `budgetedFetch`, `budgetedPoll`, `budgetedProcess`, `budgetedMongo`.
- Najpierw migrować najwyższe ryzyko:
  1. film/music/design;
  2. prompt attachments;
  3. git/worktree i shell;
  4. NotebookLM/MCP/n8n;
  5. dashboard queries;
  6. pozostałe fetch/generate.
- Usunąć `execSync` z event loop.
- Dodać process-group termination oraz bounded output.
- Dodać static check zakazujący nowych naked calls poza allowlistą.

Gate wyjścia: testy fault injection dla hung TCP, hung body, hung poll, child + grandchild process, Git credential prompt i Mongo query.

### Etap 4 — durable execution plane

- Zbudować store/state machine, worker, lease renewal, fencing, cancellation, recovery i progress.
- Zapewnić osobny supervisor oraz readiness workera.
- Zmigrować async delegation.
- Zmigrować automation jobs.
- Zmigrować capability build i naprawić progress per step.
- Zmigrować scheduled runner; dodać heartbeat i prawdziwą idempotency ownership.
- Zmigrować background tasks; rozdzielić runtime deadline od retention.
- Zmigrować media remote jobs.
- Dodać status/cancel API z auth i idempotency.

Gate wyjścia: kill -9 workera w każdej fazie powoduje bezpieczny reclaim albo terminalny wynik, bez podwójnego side effectu; stary worker nie może zapisać po utracie fencing tokena.

### Etap 5 — transport, readiness i deploy

- Jawnie ustawić Hono timeout i route-level budgets.
- Przekształcić długie JSON routes w `202 + jobId`.
- Rozdzielić `/live`, `/ready`, `/drain`.
- Readiness zależy od krytycznych zależności i zakończonego bootstrapu.
- Wdrożyć graceful shutdown: unready, stop accept/lease, abort sync, bounded drain, release/close, exit.
- Po `uncaughtException`: unready, bounded flush, exit non-zero.
- Ujednolicić deploy do jednej ścieżki z `flock`, generation id, jednym state ownerem i deadline na każdą komendę/probe.
- Dodać systemd/container supervision Mastry i job workera.
- Zweryfikować faktyczne publiczne workflowy n8n i ich response mode.

Gate wyjścia: deploy nie promuje procesu przed readiness; rolling restart nie gubi jobów; request w drain dostaje kontrolowane 503/Retry-After.

### Etap 6 — dashboard, konfiguracja i pełny rollout

- Single-flight recursive polling z abortem, backoffem i jitterem.
- Cache/projection/paginacja/maxTimeMS oraz clamping sześciu pozostałych tras.
- Streamować media bounded chunkami; dodać auth/RBAC/CORS allowlist/rate limits.
- Usunąć martwe env i duplikaty; wyjaśnić timezone i wszystkie AUTOHEAL knobs.
- Rozbić `check:all` na shardy z per-check deadline/cleanup; włączyć realną bramkę do CI. Live E2E oddzielić.
- Rollout per workload przez feature flag i shadow telemetry.
- Po stabilizacji usunąć stare helpery, mapy, literalne timeouty i allowlist entries.

Gate wyjścia: kryteria Definition of Done z sekcji 11.

---

## 8. Mapa migracji

| Obszar | Pliki/punkty startowe | Docelowa zmiana |
|---|---|---|
| Run identity | `generate-with-harness.ts`, `parallel-dispatch.ts`, `subtask-executor.ts`, `harness-run-state.ts` | Unikalne run/attempt i jawna korelacja. |
| Budget core | `run-budget.ts`, `harness-execution-context.ts`, `depth-controller.ts` | `ExecutionBudget`, policy registry, depth niezależny od czasu. |
| Tool boundary | `harness-tool-envelope.ts`, `delegate-task.ts`, `meta-harness.ts` | Zachować ToolExecutionOptions, łączyć sygnały, resolver przed plannerem. |
| Harness lifecycle | `generate-with-harness.ts`, wszystkie *-harness | Jeden outer deadline, abortowalne post-passy, finally cleanup. |
| Retry/parallel | `subtask-executor.ts`, `parallel-dispatch.ts`, `plan-task.ts` | Aggregate deadline, attemptId, server-side licznik. |
| HTTP/poll | film, music, prompt attachments, Tavily, weather, Ollama, reviews, cron, n8n | Wspólny fetch/poll adapter. |
| Procesy | design, code-worktree, terminal, external-projects, NotebookLM, Graphify | Process group, TERM/KILL, output cap, parent deadline. |
| Mongo | `lib/mongo.ts`, dashboard/services/stores | Operation deadlines, maxTimeMS, clamp/pagination. |
| Jobs | async-delegation, automation-job-manager, capability-build, scheduled-task-store/runner, background-task-manager | Jeden trwały store/worker/state machine. |
| Claims/ledger | `task-ledger*.ts` | Heartbeat, renewal, fencing; oddzielić lease/deadline/retention. |
| HTTP API | `index.ts` i route registry | Route class, 202/status/cancel, live/ready/drain. |
| Deploy | `scripts/autoheal/*`, `deploy-blue-green.sh`, `deploy.config.json` | Jedna ścieżka, lock, generation, bounded commands, readiness. |
| UI | `dashboard/analytics.js`, `dashboard/index.html` | Abort, single-flight, backoff, bounded query. |
| CI/config | `package.json`, `.github/workflows/ci.yml`, env files | Static guards, shardy, schema/env parity. |

---

## 9. Strategia testów

### Unit i property tests

- child deadline nigdy nie przekracza parent minus reserve;
- retry/backoff/poll nie wychodzą poza root deadline;
- AbortSignal.any zachowuje client, parent i local cause;
- cleanup jest idempotentny;
- timeout/cancel/lease lost mają odrębne typed errors;
- fake clock dla expiry, heartbeat i renewal;
- classifier routuje naturalne promptowe imperatywy do poprawnej workload class;
- runId jest unikalny przy wspólnym taskId/subtask retry.
- cardinality/fan-out nie przekracza maxItems/maxConcurrency ani root deadline.

### Integration

- wolny wrapped tool faktycznie kończy pracę po timeout rodzica;
- pipeline sync nie kontynuuje po odpowiedzi timeout;
- post-passy nie uruchamiają się bez remaining reserve;
- planner i replan dzielą root deadline;
- hung fetch body i hung poll request są abortowane;
- timeout mutacji zwraca `unknown_outcome` i nie uruchamia automatycznego duplikującego retry;
- proces z wnukiem jest ubijany jako grupa;
- Mongo unavailable/slow query kończy się kontrolowanie;
- scheduled task nie duplikuje side effectu po lease expiry;
- capability gate odnawia claim i persistuje każdy krok;
- utrata fencing tokena blokuje merge/promotion;
- cancel czeka na potwierdzenie termination.

### Restart/chaos

- kill workera przed side effect, po side effect i przed final save;
- restart Mastry po enqueue, w trakcie async delegation i podczas media poll;
- utrata Mongo oraz chwilowe odzyskanie;
- provider timeout i retry z `Retry-After`;
- częściowo niedostępne MCP discovery kończy się bounded partial result, bez sumowania pełnych timeoutów wszystkich serwerów;
- SIGTERM podczas request sync i podczas durable job;
- deploy równoległy odrzucony przez lock;
- stary PID/generation nie może zostać uznany za aktualny.

### E2E

- bezpośredni internal Mastra sync;
- publiczny Cloudflare → n8n → Mastra accept/status;
- long automation/media/build zwraca 202 w <10 s;
- SSE/poll status nie jest właścicielem pracy;
- readiness/promotion/drain;
- auth/RBAC dla start/status/cancel/approve.

Testy używają skróconych fake deadlines, nie wielominutowego realnego czekania.

---

## 10. Telemetria i diagnostyka

Każdy event run/tool/job powinien zawierać:

- policy version i execution class;
- budget/root/parent/run/attempt ids;
- `deadlineAt`, requested/effective/remaining before/after;
- phase/operation;
- abort cause i czy termination zostało potwierdzone;
- queue wait, execution time, finalization time;
- attempt/retry/backoff;
- lease owner, fencing token, heartbeat age;
- transport path;
- remote job/process id dla salvage.

Metryki:

- P50/P95/P99 per route/workload/phase/tool;
- timeout rate z rozbiciem na transport/application/operation;
- client cancellations;
- timeout-to-abort latency;
- orphan/termination-unconfirmed count;
- lease renew failures i fence rejections;
- queue age/depth;
- 504 Hono, 524 Cloudflare, 408 ingress;
- post-pass skipped due budget;
- step exhaustion/no-progress;
- duplicate side-effect prevention;
- readiness bootstrap duration.

Alert krytyczny: praca pozostaje aktywna po terminalnym stanie rodzica albo zapis po utracie fencing tokena.

---

## 11. Definition of Done

Cała inicjatywa jest zakończona, gdy:

- nie ma współdzielonego execution state między równoległymi runami;
- każdy generate/fetch/poll/process/DB query na ścieżce produkcyjnej jest objęty budget adapterem albo udokumentowaną allowlistą;
- nie ma produkcyjnego timeoutu implementowanego wyłącznie przez `Promise.race`;
- wszystkie child deadlines przechodzą automatyczny invariant test;
- request timeout/client disconnect zatrzymuje pracę sync i jej narzędzia;
- zadania >90 s na ścieżce publicznej wracają jako trwałe joby;
- restart Mastry/workera nie gubi zaakceptowanych jobów;
- lease są odnawiane, a fencing blokuje późne zapisy;
- retry mają server-side attempt count i aggregate deadline;
- capability build oraz scheduled tasks nie mogą działać równolegle po wygaśnięciu lease;
- cancel oznacza potwierdzone zatrzymanie albo jawne `terminationUnconfirmed`;
- liveness/readiness/draining mają odrębne, przetestowane kontrakty;
- deploy jest serializowany, bounded i oparty o readiness;
- env schema nie dopuszcza duplikatów, martwych publicznych knobs ani niejawnych jednostek;
- CI uruchamia statyczne guardy, unit/integration i właściwe shardy `check:all`;
- dashboard nie nakłada requestów i wszystkie listy są bounded;
- auth/RBAC/CORS/rate limits chronią start/cancel/approve i mutujące route’y;
- przez ustalony okres obserwacji nie występują orphan runs, lease split-brain ani timeouty transportowe długich jobów.

---

## 12. Zalecana kolejność PR-ów

1. Testy reprodukujące P0 + unikalne runId.
2. Zachowanie ToolExecutionOptions/abortSignal + outer finally.
3. Typed policy i `ExecutionBudget`.
4. Harness lifecycle + delegacja/planner/retry.
5. Fetch/poll adapters.
6. Process/Mongo adapters.
7. Durable job store/worker.
8. Migracja async delegation i scheduled tasks.
9. Migracja automation/capability/media/background.
10. HTTP 202/status/cancel + auth.
11. Readiness/drain/supervision/deploy lock.
12. Dashboard, env schema, CI i usunięcie legacy.

Każdy PR powinien być behavior-preserving albo objęty osobną flagą, mieć test fault-injection i nie łączyć zmiany architektury z masowym tuningiem liczb. Najpierw należy wymusić relacje i anulowanie, dopiero potem stroić wartości.

---

## 13. Rekomendacja końcowa

Priorytetem nie jest zmiana `180000` na większą wartość. Najpierw trzeba naprawić dwie luki P0 — współdzielony `runId` oraz utratę `abortSignal` w tool envelope — bo obecnie podważają nawet częściowo wdrożoną koordynację P2.

Następnie należy wdrożyć absolutny `ExecutionBudget` dla całego synchronicznego lifecycle i równolegle zbudować trwały job worker. Media, automation, capability build, długi coding/research i scheduled work powinny przejść do jobów, zamiast walczyć o coraz większe request timeouty.

Dopiero na tej bazie punktowe poprawki z audytu — clampy, env, dashboard, curl, Git, Tavily, NotebookLM, no-progress i deploy — staną się trwałe, ponieważ nowe ścieżki będą automatycznie dziedziczyły kontrakt czasu zamiast tworzyć kolejną niezależną liczbę.
