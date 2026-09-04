# Baseline agentów przed projektem Meta-Front, durable orchestration i timeoutów

Status: plan do przekazania modelowi  
Zakres: audyt i testy diagnostyczne, bez implementowania poprawek  
Wersja formatu wyników: `agent-baseline/v1`

## 1. Polecenie nadrzędne dla wykonawcy

Przeprowadź kompletny baseline konfiguracji i zachowania agentów w repozytorium
`/projekty/mastra-agentic-environment/agentic-agents` jako materiał wejściowy do
projektu:

- szybkiego Meta-Frontu obsługującego rozmowę, statusy i sterowanie;
- trwałych jobów/lane'ów wykonujących cele użytkownika w tle;
- workerów domenowych;
- wspólnej architektury deadline'ów, timeoutów, retry, cancel i recovery.

Nie wdrażaj żadnych poprawek. Nie zmieniaj kodu aplikacji, konfiguracji, zależności,
schematów bazy ani danych użytkownika. Możesz utworzyć wyłącznie raporty wynikowe
opisane w sekcji 15 oraz tymczasowe, testowe skrypty poza `src/`, najlepiej w `/tmp`.

Najważniejsza zasada badania:

> Nie testuj tylko `agentId`. Testuj macierz `agent × ścieżka uruchomienia`, ponieważ
> ten sam agent może zachowywać się inaczej w `generate`, `stream`, delegacji sync,
> delegacji async, workflow, scheduled task i bezpośrednim wywołaniu.

Nie zakładaj, że każdy agent domenowy musi sam być asynchroniczny. Dopuszczalne jest,
aby agent blokował przypisany mu worker/lane. Niedopuszczalne jest, aby blokował
Meta-Front lub wspólny event loop w sposób uniemożliwiający obsłużenie innej rozmowy.

## 2. Pytania, na które baseline musi odpowiedzieć

1. Jakie agenty faktycznie istnieją, które są zarejestrowane w Mastrze, a które są
   tworzone dynamicznie lub wyłącznie wewnątrz workflowów?
2. Jaki model, limit kroków, timeout, pamięć, zestaw narzędzi i łańcuch procesorów
   obowiązuje efektywnie dla każdego agenta na każdej ścieżce wywołania?
3. Które ścieżki przechodzą przez pełny harness, pipeline reflector, częściowy wrapper
   albo omijają harness całkowicie?
4. Czy `generate` i `stream` mają te same gwarancje timeoutu, pamięci, telemetryki,
   ResultEnvelope, reflection, attachmentów i cancel?
5. Skąd pochodzą `resourceId`, `conversationId`, `threadId`, `taskId` i `runId` oraz
   czy ich fallbacki mogą łączyć niezależne rozmowy albo wykonania?
6. Czy wynik delegacji trafia do właściwego odbiorcy dokładnie raz i czy może
   autonomicznie wybudzić dalszą orkiestrację bez nowej wiadomości użytkownika?
7. Czy długi job A pozwala Meta obsłużyć krótką wiadomość B w tej samej rozmowie oraz
   wiadomość C w innej rozmowie?
8. Czy timeout i cancel zatrzymują rzeczywistą pracę: model, narzędzie, HTTP/MCP,
   polling oraz subprocess, a nie wyłącznie oczekiwanie wywołującego?
9. Czy retry, restart albo utrata lease mogą wywołać podwójny side effect, zgubić wynik
   lub pozwolić starej próbie nadpisać nowy stan?
10. Które agenty można migrować wspólną falą, a które wymagają osobnego adaptera lub
    zmian w pamięci/harnessie?

## 3. Materiały obowiązkowe do przeczytania

Przed testami przeczytaj w całości:

- `ideas/timeouts-audit.md`;
- `ideas/timeouts-architecture-implementation-plan.md`;
- `ideas/meta-agent-nonblocking-orchestration-research.md`;
- `docs/TASK-LEDGER.md`;
- repozytoryjne `AGENTS.md` i wszystkie bardziej lokalne instrukcje obejmujące
  analizowane pliki.

Następnie przejrzyj co najmniej:

- `src/mastra/index.ts` — rzeczywisty rejestr agentów, storage i runtime;
- `src/mastra/agents/**/*.ts` — definicje agentów;
- `src/mastra/config/model-manifest.ts` — rozwiązywanie modeli i worker presets;
- `src/mastra/config/agent-board.ts` — deklarowana klasyfikacja i tryb delegacji;
- `src/mastra/services/meta-harness.ts`;
- `src/mastra/services/generate-with-harness.ts`;
- dedykowane harnessy coding/automation/knowledge;
- `src/mastra/services/generate-pipeline-with-reflection.ts`;
- `src/mastra/tools/system/delegate-task.ts`;
- `src/mastra/tools/system/run-worker.ts`;
- async delegation, pending queue, background tasks, automation jobs, scheduled tasks,
  Task Ledger i claims scheduler;
- `package.json` oraz faktycznie zainstalowane wersje z lockfile/node_modules.

## 4. Zakres agentów

Nie przyjmuj poniższej listy bez weryfikacji. Uzgodnij inventory z trzema źródłami:

1. definicje/fabryki w kodzie;
2. `new Mastra({ agents: ... })`;
3. runtime registry lub publiczny endpoint agentów, jeśli serwer jest już bezpiecznie
   uruchomiony.

Punktem startowym są obecnie 29 kluczy rejestru:

```text
weatherAgent
crmAgent
metaAgent
marketingAgent
producerHuntDiscoveryAgent
producerHuntEnrichmentAgent
producerHuntEmailExtractionAgent
producerHuntDraftAgent
producerHuntJsonRepairAgent
producerHuntCloudFallbackAgent
salesAgent
analyticsAgent
automationArchitect
n8nMcpEngineer
codingAgent
codeReviewAgent
securityReviewAgent
performanceReviewAgent
knowledgeAgent
researcherAgent
deliberationAgent
chefAgent
contentAgent
huntAgent
designAgent
writerAgent
filmmakerAgent
musicianAgent
capabilitySmith
```

Oprócz tego zinwentaryzuj:

- dynamiczne agenty i presety tworzone przez `system_run_worker`;
- plannerów, reviewerów i deliberation workers tworzonych w locie;
- agenty używane wyłącznie wewnątrz workflowów lub pipeline'ów;
- aliasy: klucz rejestracyjny, `Agent.id`, nazwa z Agent Board i identyfikatory
  używane przez delegację mogą się różnić.

Każdy zarejestrowany agent musi mieć kompletny audyt statyczny. Każdy user-facing lub
delegowalny agent musi mieć bezpieczny smoke albo jawny status `NOT_RUN` wraz z powodem.

## 5. Zasady bezpieczeństwa

### 5.1 Zakazy

Bez osobnej, jawnej zgody użytkownika nie wolno:

- wysyłać maili, wiadomości Telegram/Slack lub publikować treści;
- wdrażać, aktywować, modyfikować ani usuwać workflowów n8n;
- wykonywać płatnej generacji obrazu, filmu, audio lub zewnętrznego enrichmentu;
- modyfikować produkcyjnego CRM, kalendarza, arkuszy, dokumentów lub baz wiedzy;
- zmieniać prawdziwych plików projektowych poprzez coding/design/writer agents;
- instalować lub aktualizować zależności;
- zmieniać `.env`, feature flags, Docker Compose albo konfigurację usług;
- restartować lub zabijać procesów, których test nie uruchomił i nie posiada;
- uruchamiać `npm run check:all` bez wcześniejszej inspekcji każdego skryptu wchodzącego
  w skład komendy;
- uznawać istniejącej nazwanej komendy `check:*` za bezpieczną tylko na podstawie nazwy.

### 5.2 Izolacja

- Używaj unikalnego prefiksu testowego dla wszystkich `resourceId`, `threadId`,
  fixture IDs i nazw artefaktów.
- Nie używaj istniejących threadów użytkownika ani istniejących rekordów jobów.
- Przed uruchomieniem każdego testu sprawdź jego kod, zależności i cleanup.
- Testy mutujące Mongo mogą działać wyłącznie na jednoznacznie testowych rekordach,
  które da się odfiltrować po `reportId`.
- Testy kill/restart wykonuj tylko w izolowanym procesie uruchomionym przez test.
- Jeśli nie da się zagwarantować izolacji efektu, ustaw `NOT_RUN`/`BLOCKED`; nie próbuj
  obchodzić ograniczenia.
- Nie loguj sekretów, pełnych promptów zawierających dane użytkownika ani surowych
  credentiali. Stosuj redakcję również w snapshotach bazy.

### 5.3 Współbieżność z innymi testami

Przed live testami sprawdź, czy inne sesje nie obciążają tych samych modeli, GPU, n8n,
Mongo lub repozytorium. Jeśli obciążenie jest aktywne, nie konkuruj z nim. Oznacz okno
pomiarowe jako niewiarygodne albo poczekaj na zgodę użytkownika. Nie zabijaj cudzych
testów.

## 6. Reguły dowodowe

Każde twierdzenie oznacz jednym ze statusów źródła:

```text
measured        wartość zmierzona podczas testu
observed        zachowanie widoczne w logu, trace, bazie lub artefakcie
static_analysis wynik inspekcji kodu lub konfiguracji
inferred        wniosek niepotwierdzony bezpośrednio
unknown         nie udało się ustalić
not_applicable  nie dotyczy
```

Nie wolno zamieniać `unknown`, `NOT_RUN` ani `NOT_SUPPORTED` na `false` lub `PASS`.

Dozwolone statusy testu:

```text
PASS
FAIL
PARTIAL
BLOCKED
NOT_SUPPORTED
NOT_RUN
INCONCLUSIVE
```

Każdy wynik musi zawierać:

- czas UTC i commit SHA;
- dokładną komendę lub opis wywołania;
- exit code;
- użyte identyfikatory korelacyjne;
- stan istotnych rekordów przed i po;
- log/trace albo reprodukowalny dowód kodowy;
- rozdzielenie oczekiwania od obserwacji;
- informację, czy test mógł pozostawić proces lub side effect.

Samo stwierdzenie „agent odpowiedział” albo „test przeszedł” nie jest dowodem.

## 7. Faza A — preflight i manifest środowiska

Nie uruchamiaj jeszcze agentów.

1. Zapisz:

   - datę UTC, branch, commit i stan dirty worktree;
   - Node, npm i system operacyjny;
   - deklarowane oraz zainstalowane wersje wszystkich pakietów Mastry;
   - model providers i dostępne modele, bez sekretów;
   - topologię Mongo, storage Mastry, observability store, kolejkę/PubSub;
   - uruchomione procesy/serwisy wymagane przez testy;
   - skuteczne wartości feature flags wraz z wartością domyślną w miejscu użycia;
   - brakujące credentiale/usługi, które zablokują testy.

2. Zapisz bazowy stan:

   - aktywne joby, background tasks, scheduled tasks i lanes;
   - aktywne procesy testowe;
   - testowe kolekcje/rekordy, jeśli istnieją;
   - git status.

3. Nadaj całemu badaniu `reportId`. Wszystkie nowe testowe rekordy muszą być z nim
   korelowalne.

## 8. Faza B — pełne inventory statyczne

### 8.1 Konfiguracja każdego agenta

Dla każdego agenta zbierz wartości skonfigurowane i efektywne:

- klucz rejestru, `Agent.id`, display name, aliasy i domena;
- plik definicji, fabryka/singleton, plik rejestracji;
- model skonfigurowany, model rozwiązany w runtime, provider, fallbacki i retry;
- źródła instrukcji, dynamicznego promptu, cache i przybliżony rozmiar promptu;
- wszystkie limity kroków:
  - `defaultOptions.maxSteps`;
  - legacy generate/stream/network options;
  - `stopWhen`;
  - limity harness/depth profile;
  - limity pipeline'u, workflowu i tool-loop;
- wszystkie timeouty, deadline'y, poll intervals, retry/backoff i safety margins;
- narzędzia eager, narzędzia odkrywane dynamicznie i narzędzia MCP;
- input/output processors, scorers, workspace, artifact store i attachment path;
- klasy side effectów, approval gates i wymagane usługi zewnętrzne;
- deklarowany tryb Agent Board oraz rzeczywistą ścieżkę w `delegate-task`;
- znane blocking Node APIs, subprocessy i potencjalnie nieograniczone pętle.

Nie raportuj tylko wartości zapisanej przy konstrukcji agenta. Wyznacz `effectiveMaxSteps`
i `effectiveTimeout` osobno dla każdej ścieżki uruchomienia.

### 8.2 Pamięć

Dla każdego agenta ustal:

- czy posiada Mastra Memory i jaką wersję;
- backend oraz wspólny/odrębny store;
- `lastMessages`;
- working memory: enabled, scope, template i writer;
- semantic recall: enabled i opcje;
- observational memory: enabled, model, scope i opcje;
- title generation;
- memory-related input/output processors;
- shared-memory tools lub automatyczny zapis po odpowiedzi;
- skąd pochodzą `resourceId` i `threadId` w każdej ścieżce;
- zachowanie przy braku identyfikatora;
- politykę reuse threadu dla conversation, joba, taska, attemptu i retry;
- czy agent lub background result może pisać do conversation threadu;
- czy dwa agenty współdzielą mutable memory scope.

Utwórz fingerprint każdej unikalnej konfiguracji pamięci. Głębokie testy kompresji lub
restartu można wykonać na reprezentancie fingerprintu, ale inventory musi obejmować
każdego agenta.

### 8.3 Harness i ścieżki wykonania

Dla każdego agenta zbuduj uporządkowany łańcuch wrapperów dla:

- bezpośredniego `generate`;
- bezpośredniego `stream`;
- sync delegation;
- async delegation;
- workflow/pipeline;
- scheduled/background execution;
- endpointu lub kanału komunikacyjnego, jeśli występuje.

Rozróżnij co najmniej profile:

```text
meta generate wrapper
full generateWithHarness
dedicated coding harness
dedicated automation harness
dedicated knowledge harness
pipeline reflector wrapper
generic direct generate
run-worker dynamic agent
scheduled direct agent/workflow
Mastra background/durable primitive
```

Dla każdej ścieżki ustal:

- czy obejmuje `generate` i `stream`;
- gdzie powstają `runId`, `turnId`, `taskId` i thread;
- czy `runId` jest unikalny dla dwóch równoległych wywołań tego samego taska;
- gdzie liczony jest deadline i czy retry/restart go resetuje;
- czy zewnętrzny `AbortSignal` jest łączony i propagowany do narzędzi;
- czy wrapper zachowuje cały `ToolExecutionContext`, w tym `mastra`, `agent`,
  `requestContext`, `suspend`, `resumeData` i `onProgress`;
- preprocessing, attachment persistence, precontext i depth classification;
- reflection/review/GoalContract/ResultEnvelope;
- postprocessing, artifacts, telemetry i cleanup;
- co dzieje się z pracą po timeout, disconnect i cancel.

### 8.4 Narzędzia

Zbuduj inventory narzędzi co najmniej dla wszystkich narzędzi:

- długich lub używanych przez Meta;
- sieciowych, bazodanowych, MCP i pollingowych;
- uruchamiających subprocess;
- wykonujących zewnętrzny side effect;
- używanych w delegacji, statusie, cancel i notification.

Dla każdego ustal:

- przewidywaną klasę czasu;
- timeout i retry na wszystkich warstwach;
- przyjęcie oraz forwarding `AbortSignal`;
- kill strategy subprocessu;
- idempotency key, claims/lease i fencing;
- approval/dry-run;
- możliwość weryfikacji i kompensacji efektu;
- użycie `execSync`, `spawnSync`, synchronicznego filesystemu lub surowego `fetch`;
- bezpieczną fixture testową albo powód braku testu live.

## 9. Faza C — klasyfikacja istniejących testów

Najpierw zinwentaryzuj wszystkie skrypty `check:*`, `e2e:*`, `audit:*`, `baseline:*`
i właściwe skrypty TypeScript. Dla każdego przypisz:

```text
static_only
deterministic_local
mongo_fixture
live_llm
live_external_read
external_write
paid
destructive_or_process_control
unknown
```

Zapisz, co test naprawdę sprawdza, a czego nie sprawdza. Szczególnie:

- parser lub `source.includes(...)` nie jest live testem agenta;
- dry-run nie dowodzi cancel ani crash recovery;
- `e2e:ledger-three-lanes` nie dowodzi same-thread A/B ani autonomous wake;
- `check:all` nie jest testem wszystkich agentów ani nieblokującej orkiestracji.

Kandydaci do inspekcji obejmują m.in. testy:

- Agent Board i prompt size;
- ResultEnvelope i GoalContract;
- agent memory thread;
- depth controller, harness depth i Meta harness wrapper;
- cognitive loop, strategy/pipeline reflector i final synthesis;
- ledger lifecycle, claims, idempotency i artifact handoff;
- scheduled tasks;
- automation contracts/autonomy/golden path;
- design/writer/filmmaker/musician domain;
- n8n/MCP oraz capability gates.

Uruchom wyłącznie podzbiór uznany za bezpieczny po inspekcji. Dla testów live lub
mutujących przedstaw użytkownikowi listę i zakres przed startem, jeżeli wcześniejsze
polecenie nie udziela jednoznacznej zgody.

## 10. Faza D — bezpieczny baseline każdego agenta

### 10.1 Poziomy pokrycia

Dla każdego agenta wykonaj lub oznacz:

1. `STATIC` — pełna konfiguracja i execution-path inventory; obowiązkowe dla wszystkich.
2. `SMOKE_DIRECT` — krótka, bezpieczna odpowiedź przez bezpośrednią ścieżkę.
3. `MEMORY_CONTINUITY` — jeśli memory enabled.
4. `DOMAIN_READ_ONLY` — reprezentatywne zadanie domenowe bez efektu ubocznego.
5. `MULTISTEP_SAFE` — bezpieczne zadanie wielokrokowe lub dry-run.
6. `FAILURE_OR_PARTIAL` — kontrolowany błąd/partial/blocked bez mutacji.
7. `META_ROUTE` — dla każdego user-facing/delegowalnego agenta.
8. `BACKGROUND_ROUTE` — dla każdego agenta, którego docelowo Meta ma uruchamiać jako
   job lub task joba.

Jeżeli agent nie może zostać bezpiecznie uruchomiony, nie zastępuj testu prostszym i
nie oznaczaj PASS. Zwróć `NOT_RUN` z dokładnym brakującym sandboxem lub fixture.

### 10.2 Szablon bezpiecznego promptu

Prompt musi być dopasowany do domeny, ale zawierać jawny kontrakt:

```text
To jest izolowany test diagnostyczny. Wykonaj wyłącznie analizę/read-only/dry-run.
Nie wysyłaj wiadomości, nie wdrażaj, nie aktywuj, nie zapisuj do systemów zewnętrznych,
nie uruchamiaj płatnej generacji i nie modyfikuj plików projektu ani danych użytkownika.
Zwróć wymagany mały rezultat oraz prawidłowy ResultEnvelope, jeśli ta ścieżka go wymaga.
Marker testu: <reportId/testCaseId>.
```

Przykładowe bezpieczne klasy zadań:

- coding/review: analiza małego fixture lub wskazanego fragmentu, bez edycji;
- automation/n8n: audit read-only lokalnej fixture, bez deploy/activate;
- design/film/music: storyboard, brief, krytyka lub plan bez generacji płatnej;
- writer/content/marketing: krótki draft do testu, bez publikacji;
- CRM/sales/hunt: analiza syntetycznych rekordów, bez zapisu i outreach;
- knowledge/research: lokalny lub jawnie testowy materiał, bez kosztownego crawl;
- capability: klasyfikacja syntetycznej luki, bez attach/install;
- helper/reviewer: krótki, deterministyczny input bez narzędzi mutujących.

### 10.3 Pamięć — test dynamiczny

Dla każdego memory-enabled agenta albo reprezentanta dokładnie identycznego fingerprintu:

1. Zapisz losowy, niesensytywny marker w `resource R1/thread T1`.
2. Zapytaj o marker w tej samej parze R1/T1.
3. Zapytaj w R1/T2 — marker nie może przeciec, jeśli oczekiwany scope to thread.
4. Użyj R2/T1 — dane użytkownika nie mogą przeciec między resources.
5. Uruchom dwa równoległe requesty na T1 i zbadaj kolejność zapisów.
6. Wywołaj ścieżkę bez `threadId`; powinna jawnie odrzucić albo użyć bezpiecznego,
   deterministycznego scope, nigdy globalnego fallbacku.
7. Jeśli bezpiecznie możliwe, uruchom nowy proces i potwierdź persistence.
8. Sprawdź, czy attempt backgroundowy ma własny thread i nie zapisuje tool trace do
   conversation threadu.

Nie traktuj odpowiedzi modelu jako jedynego dowodu. Sprawdź zapis pamięci lub trace.

### 10.4 Limity kroków

- Zapisz configured i effective maxSteps dla każdego uruchomienia.
- Zmierz faktyczną liczbę kroków, model calls i tool calls.
- Test wyczerpania limitu wykonuj tylko na bezpiecznym no-op fixture i po jednym
  reprezentancie każdego execution-profile fingerprintu.
- Sprawdź różnicę `generate`, `stream`, sync delegation, async delegation i scheduled.
- Zapisz finish reason oraz czy postprocessing i artifacts wykonały się po zatrzymaniu.

## 11. Faza E — testy Meta-Front i pracy w tle

### 11.1 Zasada pokrycia

Każdy agent dostępny z Agent Board lub `delegate-task` powinien zostać przetestowany
przez rzeczywistą ścieżkę Meta przynajmniej raz, bezpiecznym zadaniem. Nie musi to być
za każdym razem kosztowny chaos test. Głębokie scenariusze wykonaj na reprezentancie
każdego unikalnego execution profile.

### 11.2 ORCH-AB-SAME-CONVERSATION

1. Utwórz testową rozmowę `C1`.
2. Poproś Meta o uruchomienie wystarczająco długiego, bezpiecznego zadania A przez
   wskazanego agenta domenowego w tle.
3. Zmierz `requestAckMs` i zapisz zwrócone identyfikatory.
4. Natychmiast wyślij krótką wiadomość B na C1, np. pytanie o status albo prostą
   odpowiedź niewymagającą domenowego workera.
5. B musi zakończyć się przed terminalnym wynikiem A. Zmierz latency względem idle
   Meta baseline.
6. W trakcie A zapytaj o status bez ponownego uruchamiania lub przejmowania joba.
7. Rozłącz klienta, który rozpoczął A; sprawdź, czy zaakceptowany job nadal działa.
8. Po zakończeniu sprawdź wynik, artefakt, routing i dokładnie jedno powiadomienie.

### 11.3 ORCH-CROSS-CONVERSATION

Podczas A na C1 wyślij wiadomość C w rozmowie C2 tego samego resource oraz D w rozmowie
innego testowego resource. Sprawdź responsywność, brak przecieku pamięci, statusów,
pending messages i Ledger digest.

### 11.4 ORCH-PARALLEL-JOBS

Uruchom dwa niezależne joby w jednej rozmowie, a następnie dwa joby z konfliktem
resource claim na izolowanej fixture. Sprawdź:

- czy niezależne prace mogą działać równolegle;
- czy konflikt jest serializowany;
- czy conversation messages nadal zachowują kolejność;
- czy status rozróżnia joby;
- czy ukończenie jednego nie konsumuje wyniku drugiego.

### 11.5 ORCH-FANOUT-REVIEW-SYNTHESIS

Na bezpiecznym read-only celu sprawdź fan-out do kilku workerów, zebranie wyników,
walidację ResultEnvelope, review i finalną syntezę. Jeśli obecna architektura nie potrafi
autonomicznie wybudzić review/syntezy, oznacz `NOT_SUPPORTED` lub `FAIL` zgodnie z
oczekiwanym invariantem — nie symuluj sukcesu kolejną wiadomością użytkownika.

## 12. Faza F — kontrakty wyniku, timeout i cancel

### 12.1 ResultEnvelope

Sprawdź osobno:

- `ok` z artefaktem;
- `partial`;
- `blocked_needs_approval`;
- `failed`;
- pusty tekst;
- prose bez envelope;
- wadliwy JSON;
- poprawny tekst po technicznym timeout;
- artefakt zapisany tuż przed timeoutem.

Zweryfikuj kolejność: worker result -> parse/validate -> review -> state transition.
Samo zakończenie promise nie może automatycznie oznaczać spełnienia celu.

### 12.2 Warstwy timeoutu

Na bezpiecznych fixture sprawdź przynajmniej po jednym reprezentancie:

- model/provider;
- tool call;
- HTTP/fetch;
- MCP;
- polling zewnętrznego joba;
- subprocess;
- cały harness run;
- sync child względem parent budget;
- async job po zakończeniu requestu;
- scheduled workflow/agent.

Dla każdego zapisz:

- configured i effective deadline;
- queue wait i active execution osobno;
- overshoot po deadline;
- czy underlying work faktycznie ustał;
- czy wystąpił późny zapis, side effect lub wynik;
- czy retry zachował aggregate budget, czy dostał pełny nowy timeout.

### 12.3 Cancel, pause, interrupt, steer i fork

Jeśli operacja istnieje, sprawdź:

- cancel przed dispatch;
- cancel podczas model call;
- cancel podczas tool/subprocess;
- cancel równocześnie z completion;
- pause bez aktywnego lease;
- interrupt aktualnej próby bez terminalizacji całego celu;
- steer powodujący nową wersję planu;
- spóźniony wynik starej wersji;
- fork z nową tożsamością i bez współdzielenia mutable execution state.

Dowodem cancel jest brak dalszej aktywności i side effectów po grace period, a nie sam
status `cancelled` w bazie.

## 13. Faza G — durability, races i resource isolation

Te testy wymagają izolowanego runtime'u. Jeśli go nie ma, raportuj `BLOCKED`, nie testuj
na procesie użytkownika.

### 13.1 Restart/crash checkpoints

Zabij wyłącznie test-owned process w następujących punktach:

1. po zaakceptowaniu joba przed dispatch;
2. po lease przed startem;
3. podczas model call;
4. podczas narzędzia;
5. po side effekcie przed zapisem terminalnego stanu;
6. po zapisie wyniku przed notification/ack;
7. w stanie oczekiwania na użytkownika.

Sprawdź recovery na innym workerze, zachowanie deadline'u, liczbę prób i dokładnie jeden
efekt końcowy.

### 13.2 Wyścigi

Sprawdź w izolacji:

- dwa consumery pending queue;
- dwa digest readers;
- heartbeat kontra stale reconciler;
- dwa workery po wygaśnięciu lease;
- utrata lease i późny zapis starego workera;
- exact claim oraz glob claim race;
- duplikat i out-of-order event;
- cancel kontra completion;
- ten sam `taskId` użyty przez dwa równoległe runy;
- brak `threadId`;
- wynik joba A kierowany do rozmowy B.

Każdy test powinien mieć kontrolowany barrier zamiast polegać tylko na przypadkowym
timingu.

### 13.3 Responsywność i starvation

Zmierz idle baseline Meta, a następnie Meta podczas:

- jednego długiego workera;
- kilku równoległych workerów;
- subprocessu;
- narzędzia zawierającego synchroniczną operację;
- obciążenia jednego lokalnego model provider/GPU.

Zapisuj co najmniej:

- time to first token;
- request/job acceptance latency;
- latency krótkiej odpowiedzi B;
- event-loop lag max oraz, jeśli możliwe, p95;
- queue wait;
- worker execution;
- result delivery latency;
- CPU/RSS i model/provider saturation w granicach bezpiecznej obserwacji.

Nie myl odłączenia Promise z izolacją zasobów. Fire-and-forget w tym samym procesie może
nadal blokować event loop lub zagłodzić pulę modeli.

## 14. Minimalna macierz pokrycia

### 14.1 Wszystkie agenty

Wymagane:

- 100% registered agents: inventory statyczne;
- 100% memory-enabled agents: konfiguracja i derivation IDs;
- 100% user-facing/delegowalnych agentów: direct safe smoke lub jawny safety blocker;
- 100% Agent Board targets: klasyfikacja rzeczywistej sync/async route;
- 100% długich/mutujących agentów: bezpieczna klasyfikacja background suitability;
- 100% różnic konfiguracja deklarowana vs efektywna: lista driftów.

### 14.2 Testy głębokie przez fingerprint

Co najmniej jeden reprezentant każdego profilu:

```text
Meta wrapper
dedicated coding harness
dedicated automation harness
dedicated knowledge harness
pipeline reflector agent
generic direct agent
dynamic run-worker
scheduled agent/workflow
subprocess background task
mutating external tool behind approval/dry-run
```

W raporcie jawnie wskaż reprezentanta i agenty, na które wynik jest ekstrapolowany.
Ekstrapolacja ma status `inferred`, nie `measured`.

## 15. Obowiązkowy format wyników

Utwórz katalog:

```text
ideas/meta-agent-orchestration-baseline-results/<reportId>/
```

Zawartość:

```text
baseline-summary.md
manifest.json
agent-inventory.json
tool-inventory.json
execution-paths.md
test-runs.jsonl
orchestration-scenarios.jsonl
failures.jsonl
evidence-index.json
coverage-gaps.md
architecture-input.md
```

Jeśli nie możesz dostarczyć wielu plików, zwróć jeden Markdown z identycznymi sekcjami
i rekordami JSON/JSONL w osobnych blokach. Nie pomijaj danych strukturalnych.

### 15.1 `manifest.json`

```json
{
  "schemaVersion": "agent-baseline/v1",
  "reportId": "uuid",
  "startedAt": "UTC ISO-8601",
  "completedAt": "UTC ISO-8601",
  "repository": {
    "path": "...",
    "commit": "...",
    "branch": "...",
    "dirty": true,
    "preExistingChanges": [],
    "changesCreatedByTest": []
  },
  "environment": {
    "os": "...",
    "nodeVersion": "...",
    "packageManager": "...",
    "mastraPackages": {},
    "modelProviders": [],
    "databaseTopology": "...",
    "storageLayout": [],
    "queueOrPubSub": "...",
    "processLayout": [],
    "externalServices": [],
    "featureFlags": []
  },
  "coverage": {
    "sourceDefinedAgents": [],
    "registeredAgents": [],
    "boardAgents": [],
    "dynamicAgentProfiles": [],
    "testedAgents": [],
    "notRunAgents": [],
    "inventoryDiscrepancies": []
  },
  "limitations": [],
  "redactionPolicy": "..."
}
```

### 15.2 `agent-inventory.json`

Jeden rekord na dokładny klucz rejestracyjny:

```json
{
  "agentId": "exact-registration-key",
  "runtimeAgentId": "...",
  "displayName": "...",
  "domain": "...",
  "aliases": [],
  "implementation": {
    "class": "Agent|Pipeline|Dynamic|Other",
    "definitionFile": "repo-relative path",
    "registrationFile": "repo-relative path",
    "interfaces": ["generate", "stream", "delegation", "workflow"]
  },
  "model": {
    "configured": "...",
    "effectiveObserved": "...",
    "resolverOrFallback": "...",
    "maxRetries": null,
    "evidenceIds": []
  },
  "steps": {
    "configuredMaxSteps": null,
    "effectiveByPath": {},
    "otherIterationLimits": [],
    "evidenceIds": []
  },
  "memory": {
    "enabled": null,
    "implementation": "...",
    "storageBackend": "...",
    "resourceIdDerivationByPath": {},
    "threadIdDerivationByPath": {},
    "threadReusePolicy": "...",
    "historyOptions": {},
    "workingMemory": {},
    "semanticRecall": {},
    "observationalMemory": {},
    "inputProcessors": [],
    "outputProcessors": [],
    "titleGeneration": null,
    "isolationAssessment": "...",
    "evidenceIds": []
  },
  "harness": {
    "orderedWrappersByPath": {},
    "generateCovered": null,
    "streamCovered": null,
    "toolExecutionCovered": null,
    "goalContractEnforced": null,
    "resultEnvelopeEnforced": null,
    "runIdCreation": "...",
    "contextFieldsPreserved": [],
    "contextFieldsLost": [],
    "abortSignalPropagation": "...",
    "deadlinePropagation": "...",
    "retryLayers": [],
    "reflectionOrReviewPath": "...",
    "evidenceIds": []
  },
  "delegation": {
    "canDelegate": null,
    "canBeDelegatedTo": null,
    "defaultModeDeclared": "sync|async|both|unknown",
    "effectiveRoutes": {},
    "callerIdentityDerivation": "...",
    "returnIdentityDerivation": "...",
    "resultDelivery": "...",
    "durableAfterRestart": null,
    "evidenceIds": []
  },
  "execution": {
    "candidateClass": "front_only|interactive_bounded|background_job|lane_internal|hybrid|unknown",
    "candidateClassSource": "inferred|measured|unknown",
    "configuredTimeouts": [],
    "retryPolicies": [],
    "cancellationMechanisms": [],
    "queueOrStore": "...",
    "sideEffectClasses": [],
    "knownBlockingCalls": [],
    "requiredServices": [],
    "evidenceIds": []
  },
  "tools": [],
  "staticRisks": [],
  "configurationDrift": [],
  "inventoryStatus": "complete|partial|unknown"
}
```

### 15.3 `tool-inventory.json`

```json
{
  "toolId": "...",
  "usedByAgents": [],
  "implementationFile": "...",
  "category": "read|write|network|database|subprocess|delegation|other",
  "expectedDurationClass": "short|medium|long|unbounded|unknown",
  "sideEffects": [],
  "destructive": false,
  "idempotencyMechanism": "...",
  "acceptsAbortSignal": null,
  "forwardsAbortSignal": null,
  "configuredTimeouts": [],
  "retryLayers": [],
  "subprocessKillStrategy": "...",
  "usesBlockingNodeApi": null,
  "safeTestFixture": "...",
  "evidenceIds": []
}
```

### 15.4 `test-runs.jsonl`

Każde uruchomienie, również nieudane, jest osobnym rekordem:

```json
{
  "schemaVersion": "agent-baseline/v1",
  "baselineRunId": "uuid",
  "testCaseId": "AGENT.<agentId>.<scenario>.01",
  "agentId": "exact-registration-key",
  "startedAt": "UTC ISO-8601",
  "channel": "generate|stream|delegation|workflow|scheduled|endpoint",
  "executionMode": "sync|async|unknown",
  "fixtureId": "...",
  "inputHash": "sha256",
  "identity": {
    "resourceId": "...",
    "conversationId": "...",
    "threadId": "...",
    "jobId": "...",
    "taskId": "...",
    "attemptId": "...",
    "runtimeRunId": "..."
  },
  "effectiveConfig": {
    "model": "...",
    "depthProfile": "...",
    "maxSteps": null,
    "memoryEnabled": null,
    "harnessChain": [],
    "timeouts": []
  },
  "timing": {
    "requestAckMs": null,
    "timeToFirstTokenMs": null,
    "timeToJobAcceptedMs": null,
    "queueWaitMs": null,
    "activeExecutionMs": null,
    "totalDurationMs": null,
    "deliveryLatencyMs": null,
    "frontUnavailableMs": null,
    "cancelToActualStopMs": null,
    "eventLoopLagMaxMs": null
  },
  "execution": {
    "modelCalls": null,
    "stepsUsed": null,
    "retryCount": null,
    "toolCalls": [],
    "processIds": [],
    "continuedAfterClientDisconnect": null
  },
  "result": {
    "status": "PASS|FAIL|PARTIAL|BLOCKED|NOT_SUPPORTED|NOT_RUN|INCONCLUSIVE",
    "terminalState": "...",
    "domainAssertions": [],
    "resultEnvelope": {
      "present": null,
      "status": "...",
      "valid": null
    },
    "artifacts": [],
    "unexpectedSideEffects": []
  },
  "routing": {
    "threadWrites": [],
    "databaseRecords": [],
    "events": [],
    "pendingMessages": [],
    "deliveredToExpectedConversation": null,
    "duplicateDelivery": null
  },
  "failureIds": [],
  "evidenceIds": [],
  "notes": ""
}
```

Nie agreguj surowych prób. W podsumowaniu podaj `n`, medianę, minimum, maksimum i p95.
Przy `n < 10` oznacz p95 jako orientacyjne.

### 15.5 `orchestration-scenarios.jsonl`

```json
{
  "schemaVersion": "agent-baseline/v1",
  "scenarioRunId": "uuid",
  "scenarioId": "ORCH-...",
  "participants": {
    "frontAgent": "metaAgent",
    "workerAgents": [],
    "conversations": [],
    "jobs": []
  },
  "timeline": [
    {
      "offsetMs": 0,
      "action": "...",
      "expected": "...",
      "observed": "...",
      "evidenceIds": []
    }
  ],
  "assertions": {
    "frontRemainedResponsive": null,
    "conversationOrderPreserved": null,
    "jobsRanInParallel": null,
    "threadIsolationPreserved": null,
    "resultRoutedExactlyOnce": null,
    "autonomousWakeOccurred": null,
    "aggregateBudgetPreserved": null,
    "actualExecutionStoppedOnCancel": null,
    "restartRecoveredWork": null,
    "staleResultRejected": null
  },
  "status": "PASS|FAIL|PARTIAL|BLOCKED|NOT_SUPPORTED|NOT_RUN|INCONCLUSIVE",
  "failureIds": [],
  "evidenceIds": []
}
```

### 15.6 `failures.jsonl`

```json
{
  "failureId": "MEM-001",
  "category": "MEM",
  "severity": "P0|P1|P2|P3|P4",
  "confidence": "high|medium|low",
  "reproducibility": "always|intermittent|once|unknown",
  "affectedAgents": [],
  "affectedTools": [],
  "affectedScenarios": [],
  "symptom": "...",
  "expected": "...",
  "actual": "...",
  "suspectedLayer": "...",
  "rootCause": "...",
  "rootCauseStatus": "observed|static_analysis|inferred|unknown",
  "impactOnTargetArchitecture": "...",
  "evidenceIds": []
}
```

Taksonomia:

```text
AGT  poprawność domenowa agenta
CFG  konfiguracja i drift wartości efektywnej
MEM  pamięć, thread/resource scope, wyciek kontekstu
HRN  harness i generate/stream/pipeline parity
DEL  delegacja, blocking i routing wyniku
IDN  identyfikatory i korelacja
BUD  deadline, timeout, retry i reset budżetu
CAN  cancel/abort nie zatrzymuje pracy
DUR  restart, utrata lub podwójne wykonanie
CON  race, atomicity, lease, claims i fencing
RES  ResultEnvelope, review i błędny sukces
EVT  event, inbox/outbox, kolejność, wake i dedupe
SID  side effect, idempotencja i kompensacja
PER  latency, event-loop lag i starvation
OBS  trace, metryki i diagnozowalność
SEC  izolacja użytkownika i rozmowy
INF  baza, storage, kolejka, provider i infrastruktura
TST  test nieważny, niestabilny lub nieobserwowalny
```

P0 oznacza wyciek danych lub destrukcyjny problem bezpieczeństwa. P1 oznacza utratę lub
duplikację pracy, błędny sukces albo niemożność zatrzymania kosztownego działania.

### 15.7 `evidence-index.json`

```json
{
  "evidenceId": "E-0001",
  "type": "source|command|log|trace|database_snapshot|http|artifact|screenshot",
  "pathOrTraceId": "...",
  "commit": "...",
  "lineOrTimeRange": "...",
  "command": "...",
  "exitCode": null,
  "capturedAt": "UTC ISO-8601",
  "sha256": "...",
  "excerpt": "redacted compact excerpt",
  "redacted": true,
  "supports": ["agent-id", "baseline-run-id", "failure-id"]
}
```

### 15.8 `baseline-summary.md`

Na początku umieść cztery tabele:

```text
agent | class | model | memory fingerprint | maxSteps by path |
harness generate/stream | effective sync/async | durability |
smoke | główny blocker
```

```text
tool | agents | long/blocking | side effects | abort signal | timeout |
retry | idempotency | subprocess kill
```

```text
scenario | result | front ack | B before A | front blocked | job result |
routing | cancel/restart | failure IDs
```

```text
agent | observed median/p95/max | execution-class candidate |
memory isolation change | harness gap | non-abortable dependency | migration risk
```

Następnie podaj:

- liczbę agentów wykrytych, zinwentaryzowanych, przetestowanych i pominiętych;
- macierz `agent × invocation path`;
- listę P0/P1/P2;
- wszystkie nieznane pola;
- testy niewykonane i dokładne przyczyny;
- przypadki, które mogły pozostawić proces lub side effect;
- porównanie konfiguracji deklarowanej i efektywnej;
- osobne sekcje `Observations`, `Inferences`, `Architecture constraints`.

### 15.9 `architecture-input.md`

To nie jest finalny plan implementacyjny. Dokument ma przekazać fakty potrzebne do jego
napisania:

- zalecana klasa wykonania każdego agenta:
  - `front_only`;
  - `interactive_bounded`;
  - `background_job`;
  - `lane_internal`;
  - `hybrid`;
- execution-profile fingerprints i sugerowane fale migracji;
- wymagane zmiany pamięci/threadów;
- ścieżki omijające harness;
- nieabortowalne zależności;
- wymagania infrastrukturalne dla testów, których nie dało się wykonać;
- release gates wynikające z potwierdzonych awarii.

Każda rekomendacja musi wskazywać dowody i być jawnie oznaczona jako `inferred`.

## 16. Kryteria ukończenia baseline'u

Baseline jest kompletny dopiero, gdy:

- wszystkie źródła agent inventory zostały uzgodnione;
- każdy zarejestrowany agent ma pełny rekord statyczny;
- każdy delegowalny agent ma sklasyfikowaną rzeczywistą ścieżkę Meta;
- każdy memory profile ma dowód izolacji lub jawny brak testu;
- każdy harness/execution profile ma co najmniej jeden deep test lub `BLOCKED`;
- istnieją surowe rekordy każdej próby, nie tylko agregaty;
- wszystkie scenariusze P0 mają wynik albo jednoznaczny `NOT_SUPPORTED/BLOCKED`;
- każda awaria ma minimalną reprodukcję i evidence IDs;
- nie wprowadzono zmian w kodzie ani niezamierzonych side effectów;
- końcowy git status został porównany z preflight;
- wykonawca jawnie wypisał luki, niewiadome i ograniczenia wiarygodności pomiarów.

## 17. Minimalny zestaw P0 do zwrócenia nawet przy ograniczonym czasie

Jeżeli pełny baseline nie mieści się w dostępnym czasie, nie skracaj raportu przez
ukrywanie braków. Dostarcz w pierwszej kolejności:

1. pełne static inventory wszystkich agentów;
2. macierz pamięć/maxSteps/model/harness/timeout/delegation mode;
3. macierz `agent × direct/sync/async/workflow/generate/stream`;
4. Meta A-long/B-quick na tym samym threadzie;
5. cross-thread i cross-resource isolation;
6. autonomous wake i exactly-once result delivery;
7. rzeczywisty abort po timeout i cancel;
8. ResultEnvelope partial/failed/invalid;
9. dwa równoległe runy z tym samym taskId;
10. representative restart/crash albo `BLOCKED` z opisem brakującego sandboxu;
11. lista wszystkich `NOT_RUN`, `NOT_SUPPORTED`, `unknown` i safety blockers.

## 18. Końcowa odpowiedź wykonawcy

W odpowiedzi do użytkownika podaj wyłącznie:

1. ścieżkę do katalogu wyników;
2. commit i `reportId`;
3. liczby coverage;
4. najważniejsze potwierdzone P0/P1;
5. agentów/testy pominięte wraz z powodami;
6. informację o pozostawionych procesach lub side effectach;
7. linki do `baseline-summary.md`, `agent-inventory.json`,
   `orchestration-scenarios.jsonl`, `failures.jsonl` i `architecture-input.md`.

Nie implementuj poprawek i nie pisz finalnego planu architektury. Po zebraniu tej paczki
wróci ona do osobnego modelu, który skonfrontuje wyniki z audytem timeoutów i raportem
Meta oraz przygotuje nadrzędny plan wdrożeniowy.
