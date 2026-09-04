# Plan-dziecko: pełna ścieżka Fal 1–10 z pominięciem G0

**Rodzic:** [`meta-front-durable-orchestration-and-execution-plan.md`](./meta-front-durable-orchestration-and-execution-plan.md)
**Hand-off rodzica:** [`docs/ORCHESTRATION-PAUSED-HANDOFF.md`](../docs/ORCHESTRATION-PAUSED-HANDOFF.md)
**Utworzony:** 2026-07-29 · **Zrewidowany:** 2026-07-29 (po weryfikacji, czy G0 faktycznie blokuje)
**Status:** aktywny — to jest plan, wg którego pracujemy

---

## 0. Czym ten dokument jest

**Jest planem nadrzędnym w praktyce** — realizujemy Fale 1–10 rodzica, **pomijając domykanie G0**.
Cel: **szybciej dojść do realnego korzystania z systemu po refaktorze**, zamiast najpierw
budować pełny dowód, że wszystko jest udowodnione.

**Nie jest** rewizją rodzica. Rodzic pozostaje źródłem prawdy dla *treści* Fal, kontraktów
i bramek. Ten dokument mówi **w jakiej kolejności i z jakim pominięciem** je realizujemy.

---

## 1. Ustalenie kluczowe: G0 NIE blokuje Fal 3–10

To było przedmiotem nieporozumienia i zostało zweryfikowane w źródłach.

W całym planie rodzica istnieje **dokładnie jeden** zapis o warunku wejścia do dalszych Fal
(§rodzic G0, ostatni punkt):

> „cztery próby wykonalności `GAP-MODEL-ABORT-01/WORKER-ISO-01/TXN-01/CLOCK-01` mają
> utrwalone evidence z **pomiarem** […] **przed jakąkolwiek pracą Fali 3**;
> wszystkie ADR-y `GAP-*` są zaakceptowane."

**Ten warunek jest SPEŁNIONY:**

| Warunek | Stan | Dowód |
|---|---|---|
| 4 spike'i z pomiarem | ✅ RESOLVED 2026-07-23 | `docs/adr/evidence/gap-{model-abort,worker-iso,clock,txn}-01/` |
| ADR 0005 (spikes) | ✅ **Accepted** | „all four resolved by measurement" |
| ADR 0007 (job aggregate) | ✅ **Accepted** | „empirically validated by GAP-TXN-01" |
| ADR 0006 (topologia) | ✅ **Accepted for V2** | — |

**Pozostałe 9 punktów G0** dotyczy *wiarygodności testów* — czy wolno powiedzieć
„udowodnione", a nie czy wolno pisać kod i przepinać ruch.

**Co z tego wynika:** możemy realizować Fale 1–10. Tracimy formalną pewność
(`qualificationStatus` zostanie `NOT_QUALIFIED`), zyskujemy ~17–30 sesji.

### Co realnie mamy dziś

| Rzecz | Stan |
|---|---|
| Substrat durable (store, lease/fence, A/B/C, recovery, timery, HTTP, 10 komend) | ✅ zbudowany, PR-2..41 |
| Kontrakty w manifeście | **19 implemented / 11 verified / 10 deferred** |
| Deterministyczne e2e | 31 suite'ów (3 w laboratorium G0, 28 poza) |
| Owned komponenty runtime testowego §19.1 | ✅ wszystkie (PR-42..51) |
| `FEATURE_ORCHESTRATION_V2` | **OFF**, brak `MONGODB_URI_V2` w `.env` |

---

## 2. Twarde blockery przepięcia agentów (to, co NAPRAWDĘ blokuje)

Nie G0. Te trzy:

### B1 — produkcyjny Mongo jest standalone
Zweryfikowane w `docker-compose.yml`: serwis `mongo` nie ma `--replSet`.
**Bez replica setu nie ma transakcji**, a cały substrat V2 na nich stoi
(granice A/B/C, CAS, outbox). Efemeryczny `rs0` na :27018 istnieje **wyłącznie do testów**.
→ **Etap F1.**

### B2 — routing V2 to skeleton
`index.ts` przy `FEATURE_ORCHESTRATION_V2=true` montuje
`singleAgentRoute(ORCHESTRATION_V2_DEFAULT_AGENT ?? 'weatherAgent')` — routing do **jednego**
agenta. Do przepięcia realnych capability potrzebny prawdziwy router.
→ **Etap F5.**

### B3 — G8: fault suite na topologii produkcyjnej
ADR 0006 mówi wprost: *„Production rollout remains blocked by the G8 replica-set topology
and partition/stepdown/ambiguous-commit fault suite."*
**To jest jedyna bramka, której NIE pomijamy** — dotyczy utraty danych na produkcji, nie
wiarygodności testów.
→ **Etap F8.**

---

## 3. Zasady

1. **`check:all` zielony przed każdym commitem** (63 pozycje).
7. **Canary przed rozbudową** — flagi V2 są włączone od 2026-07-30; realny ruch wyłapał
   2 bugi, których testy nie widziały. Nowe warstwy weryfikuj live, nie tylko bramką.
2. **Każde przepięcie za flagą + canary** — najpierw jedna capability, nie wszystkie.
3. **Rollback zdefiniowany przed włączeniem**, nie po awarii.
4. **Weryfikacja live > zielony check.** Potwierdzone 3× w tej sesji (PR-44/48/50): realne
   bugi ujawniają się dopiero, gdy ścieżka staje się osiągalna.
5. **Nie domykamy G0 „przy okazji"** — jeśli etap zaczyna wymagać migracji 28 suite'ów,
   to znak, że wyszliśmy poza zakres.
6. **Dziennik (§6) uzupełniany po każdym etapie**, jak §33 u rodzica.

---

## 4. Etapy

Kolejność wynika z zależności, nie z numeracji Fal rodzica.

---

### F1 — produkcyjny replica set *(odblokowuje wszystko)*

**Dlaczego pierwszy:** bez transakcji żaden element V2 nie ruszy na produkcji. Niezależny
od reszty — można zrobić natychmiast. Blocker B1.

**Prace**
1. `docker-compose.yml`: `mongo` → `command: ["--replSet","rs0","--bind_ip_all"]`.
2. Jednorazowe `rs.initiate()` (single-node RS — dane zachowane, bez migracji).
3. `MONGODB_URI` → `?replicaSet=rs0`; sprawdzić, że legacy działa bez zmian.
4. Healthcheck świadomy RS (dziś `ping`, powinien sprawdzać `isWritablePrimary`).
5. `MONGODB_URI_V2` w `.env.example` + doc.

**Definicja ukończenia**
- `rs.status()` → PRIMARY; legacy agenci działają bez regresji.
- Transakcja przechodzi na produkcyjnej instancji (nie tylko na :27018).
- Restart kontenera zachowuje RS.

**Ryzyko:** średnie — dotyka produkcyjnej bazy. **Rollback:** usunąć `--replSet`
(single-node RS jest wstecznie czytelny jako standalone).
**Rozmiar:** ~1 sesja. **Fala rodzica:** przygotowanie do 3/G8.

---

### F2 — Fala 1: containment, identity, uczciwy wynik

**Kontrakty deferred do domknięcia:** `SEC-001` (pełny), `HRN-001`.

**Prace**
1. **`SEC-001` pełne** — PR-41 zrobił *partial* (usunął globalny fallback, wymusił scoped
   claim). Zostaje: immutable resource-owner predicate + backfill, globalny `laneDigest`,
   lease/ACK redelivery, cutover legacy→V2.
2. **`HRN-001`** — parytet `generate`/`stream`. *„skeleton uses generate via gateway; stream
   parity not built"*. Istotne: **streaming to jedyna ścieżka przeżywająca ścianę 180 s**.
3. Containment registry z Fali 1: capability bez recovery ownera zwraca typed
   `job_unavailable_until_migrated` zamiast działać po cichu.

**Definicja ukończenia**
- `check:pending-message-scope` pokrywa pełny predicate, nie tylko scoped claim.
- Ścieżka `stream` ma te same inwarianty co `generate` (dowód: test parytetu).
- Żadna quarantined capability nie przyjmuje pracy bez recovery ownera.

**Ryzyko:** średnie (dotyka żywej ścieżki pending/memory).
**Rozmiar:** 2–3 sesje. **Fala rodzica:** 1, gate G1-core/G2-core.

---

### F3 — Fala 2: Execution Kernel i prawdziwe anulowanie

**Kontrakty:** `CAN-002` ✅ `verified`, `HRN-002` ✅ `verified` (oba zrobione — patrz niżej).
**Częściowo już zrobione w E0** (patrz dziennik): `budgetedFetch`≈`fetchWithDeadline`,
`budgetedPoll`≈tick ograniczony resztą budżetu, `budgetedProcess`≈timeout na git.

**Prace**
1. ✅ **Signal composition** — `abortSignal` przez granicę delegacji (`e3978d3`). Harness tworzy
   kontroler **przed** kontekstem i publikuje w nim skomponowany sygnał; narzędzia w głębi pętli
   modelu wreszcie widzą abort rodzica. Async lane świadomie bez sygnału.
2. ✅ **„child deadline ≤ parent minus reserve"** (G3-core) — K3/K4 zamknięte: sync
   coding/knowledge przez `resolveDelegationBudget`, a automation przy **niewykonalnym oknie
   routuje do async** zamiast startować sync, który nie zdąży.
3. ✅ **`CAN-002`** (`a7319c7`) — gateway pipeline przyjmuje `AbortSignal`,
   `withDelegationTimeout` **abortuje** zamiast porzucać czekanie, profil = liveness
   (cisza + hard cap) startowany tam, gdzie jest `prepareStep`.
4. ✅ **`HRN-002`** (`2d97500`) — pipeline agenci idący ASYNC (nie tylko sync) dostają teraz
   TĘ SAMĄ ochronę reflektor+liveness co CAN-002 dał sync. `executeDelegation` rozgałęzia się na
   `isPipelineAgent(agentId)` przed generic fallbackiem; `generatePipelineAsync` zachowuje ten sam
   kształt abortable-timeout co `generateGenericAsync` (nie osłabia istniejącego bound).
5. ✅ **K15** `execSync` (`e0c80d2`) — `runExternalProjectCommandTool` blokował event loop
   na 30 s, zamrażając **wszystkie równoległe agenty**. Naprawione `spawn` async (wzorzec
   `meta-execute-command.ts`) z prawdziwym `SIGKILL` na grupie procesów (nie tylko shellu —
   złożone polecenia typu `sleep 5 && echo x` forkują sierotę, gdyby zabić tylko lidera).
   `check:external-project-command-nonblocking` (w check:all) dowodzi obu właściwości.
6. ⬜ `budgetedMongo` — jedyna pozycja pozostała w F3, odłożona (nieblokująca).

**Definicja ukończenia**
- ✅ Przerwanie rodzica **zatrzymuje** pracę dziecka — `e2e:delegation-abort` (7 asercji,
  deterministyczne) **+ `live-verify:f3-can002` na realnym Ollama** (dowód, nie deklaracja).
- ✅ Pipeline ma realny cancel i własny bound (liveness), nie tylko timeout delegacji —
  **live-verified**, `CAN-002` → `verified` w manifeście.
- ✅ Żadne **sync** dziecko nie dostaje budżetu większego niż rodzic może przeżyć.
- ✅ Pipeline agenci NIE tracą ochrony, gdy idą ASYNC zamiast sync — `check:async-pipeline-routing`
  (real Mongo) + `live-verify:f3-can002` Proof D (realny Ollama, prawdziwa odpowiedź „Paris").

**Ryzyko:** średnie. Za flagą.
**Rozmiar:** 3–4 sesje. **Fala rodzica:** 2, gate G3-core.

---

### F4 — Fala 3: domknięcie kontraktów substratu ✅ (bez kodu — patrz audyt niżej)

**Kontrakty deferred (przed audytem):** `ORC-TXN-A-EVIDENCE-01`, `ORC-RESULT-READY-01`,
`ORC-SPECULATION-01`, `ORC-ATTACHED-01`.

**Audyt 2026-07-29 (przed napisaniem czegokolwiek):** przeczytany realny kod (`attempts.ts`,
`control-boundary.ts`, `e2e-orchestration-result-ready.ts`, master plan §Tier-1/Tier-2) zamiast
zakładać, że opis w planie jest aktualny. Dwa ustalenia:

1. **`ORC-RESULT-READY-01` był źle sklasyfikowany.** Notatki opisywały dokładnie ten sam
   kształt „partial flat-slice, reszta deferred", co bracia kontraktu już oznaczeni
   `implemented` (`ORC-TXN-A-01`, `ORC-TXN-B-01`, `ORC-AUTH-ACTIVATION-01`). Poprawione na
   `implemented` — **zero zmiany kodu, tylko etykieta była zła.**
2. **Cała reszta obu kontraktów jest zgatowana konsumentem z Fali 6–7, którego nie ma.**
   `task-due eligibility` i `effects/artifacts` nie mają nawet pól w schemacie (nie
   „nieprzetestowane" — **nierozpoczęte**). `bounded ancestor touch` wymaga realnej
   child/edge authority (`ORC-DISPATCH-EDGE-01`: aktywuje się z `codingAgent`, Fala 6).
   Brakujący „activation kind" to `FINAL_DECISION` (wiąże się z `deliberationAgent`, Fala 7).
   `finish_as_evidence` (`ORC-TXN-A-EVIDENCE-01`) ma **zero wywołań w całym repo** — nawet
   jedyny dziś podłączony do V2 agent (`weatherAgent`) go nie woła, i w przeciwieństwie do
   `ORC-SPECULATION-01`/`ORC-ATTACHED-01` nie miał nawet zadeklarowanego
   `firstConsumerCapability`. Budowanie tego teraz byłoby dokładnie tym samym „budowanie
   przed konsumentem", którego plan świadomie unika dla speculation/attached. Dzisiejszy
   fail-closed `409` **już jest** bezpiecznym stanem wymaganym przez Tier-1 — kompletna
   funkcja nie ma dziś niczego, co by ją zwalidowało.

**Decyzja (potwierdzona przez usera):** żadnego spekulacyjnego kodu. `ORC-TXN-A-EVIDENCE-01`
zostaje `deferred` (z rozszerzoną notatką w manifeście tłumaczącą dlaczego bezpiecznie).
`ORC-RESULT-READY-01` → `implemented` (poprawka etykiety). Naturalny następny krok to **F5**
— dopiero realny routing wyprodukuje konsumentów, którzy nadadzą sens reszcie tych kontraktów.

**Definicja ukończenia**
- ✅ Manifest odzwierciedla rzeczywisty stan kodu, nie aspirację.
- ✅ Żaden kod nie został napisany na zapas bez konsumenta.
- ✅ `check:all` (54 pozycje) zielony — bez zmian, bo nie zmienił się żaden kod runtime.

**Ryzyko:** brak (dokumentacja). **Rozmiar:** 1 sesja (zamiast szacowanych 2–3 — audyt
pokazał, że pisanie kodu byłoby pracą na zapas). **Fala rodzica:** 3, gate G4 (częściowo —
pełne G4 i tak czeka na migrację Fal 6–9, zgodnie z regułą rodzica „pełnej bramki nie da się
zamknąć przed migracją wszystkich objętych nią capability").

---

### F5 — Fala 4: Meta Front V2 + realny routing *(pierwsze realne użycie)*

**To jest etap, po którym system zaczyna być używany.** Blocker B2.

**Korekta po audycie (2026-07-29, ten sam wzorzec co F4):** master plan §Fala 4 **nie
wymienia** „realnego routera capability→agent" wśród Prac — to była moja własna nadinterpretacja
przy pisaniu tego planu-dziecka. Kod sam mówi wprost (`index.ts` komentarz nad
`configureV2Mount`): *„real capability routing is Fala 6-8"*. `singleAgentRoute` (jeden
kanarek) **zostaje** przez F5 — to nie jest coś do zastąpienia teraz. Prawdziwa luka F5 to
warstwa PRZED routerem: nic dziś nie KONSUMUJE tego API (zero agentów, zero dashboardu) —
patrz punkt 1 poniżej, przenumerowany z „router" na „konsument".

**Prace**
0. ✅ **Profil harnessu dla workera V2** (`b0a25e2`) — warunek konieczny, którego pierwotna
   lista nie miała: dopóki job V2 biegł gołym `agent.generate`, przepięcie czegokolwiek na V2
   było regresją. Za flagą `FEATURE_ORCHESTRATION_V2_HARNESS_WORKER` (default OFF).
1. ✅ ~~Realny router zamiast singleAgentRoute~~ → **realny konsument** (`9636976`):
   `metaAgent` ma 4 narzędzia (`orchestration_start_job`/`get_job`/`list_jobs`/`cancel_job`)
   w puli odkrywalnej, za flagą `FEATURE_ORCHESTRATION_V2_AGENT_TOOLS` (default OFF).
   Powierzchnia V2 przestała być „zbudowana i nieużywana". **Zostaje:** dashboard jako
   reader/command client (punkt 4) — nie multi-capability routing, to Fala 6-8.
2. ✅ **Rozdzielenie promptu/pamięci/toolsetu Meta Frontu** (`b6cab68` toolset, `8d53d3c`
   tożsamość+prompt): `metaFrontAgent` — osobny agent, prompt `meta-front/base`, pamięć
   wyłącznie konwersacyjna, toolset = dokładnie 10 komend durable-job i **nic więcej**
   (nieblokowalność jest STRUKTURALNA, nie obietnicą w promptcie). Własny endpoint
   `POST /v2/front/messages`. **Świadomie NIE przerabiam `metaAgent` na `front_only`** —
   to cel docelowy tabeli migracji, ale nie pierwszy krok (patrz dziennik).
3. Logiczna serializacja komend per conversation.
4. 🔄 Conversation projection + reconnect cursor (dashboard jako reader/command client) —
   **reader ZROBIONY** (`acc133d`): `GET /dashboard/orchestration/jobs[/:jobId]`, read-only,
   z rozróżnieniem „flaga OFF" od „brak pracy". Brakuje dashboardu jako **command clienta**
   (dziś tylko czyta) i UI (na razie same endpointy JSON).
5. HTTP `202` + status + SSE/poll — **poll gotowy i live-verified; SSE nie istnieje**.

**Definicja ukończenia**
- A-long/B-quick działa w tej samej i różnych rozmowach. ✅ różne rozmowy (Proof D);
  ta sama rozmowa pokrywa istniejący `e2e:orchestration-conversation`.
- Status **nie budzi** joba; completion **nie wymaga** nowej wiadomości. (strukturalnie
  zagwarantowane przez reducery — GET jest czystym odczytem)
- ✅ Kill/restart Frontu nie gubi accepted joba ani kursorów — **live-verified** (Proof B/C).
- **Jedna realna capability przechodzi end-to-end przez V2** (canary). ✅ mechanizm
  zweryfikowany (Proof A) — `weatherAgent` dziś kończy `FAILED` z powodu zepsutego slugu
  modelu OpenRouter (niezwiązane, osobny spawn_task), co jest akceptowalne jako dowód
  mechanizmu, nie biznesowego sukcesu.

**Ryzyko:** wysokie — pierwszy realny ruch. Flaga + jedna capability + rollback per cohort.
**Rozmiar:** 4–6 sesji (~1 zużyta na pierwszy plaster). **Fala rodzica:** 4, gates G4-wake/G5-front.

---

### F5B — Lane Orchestrator: agentowy koordynator wewnątrz deterministycznej granicy

**Dlaczego osobny etap:** F5 dał *powierzchnię* (front, komendy, reader) i *trwałość*, ale
**nie dał koordynacji**. Dziś „planowanie" w linii to `PLAN_SINGLE_SERIAL_TASK_V1` — czysto
deterministyczny reducer tworzący jedno zadanie; w całym lane **nie ma ani jednego wywołania
modelu**. Czyli V2 jest dziś *trwalsze* od legacy, ale nie *mądrzejsze*. To jest ta wartość
metaAgenta-koordynatora, o którą trzeba zawalczyć osobno.

**Co to jest wg rodzica (§4.2):** Orchestration Service pozostaje **deterministycznym**
właścicielem (claim, lease/fence, redukcja, timery, terminalizacja). **Lane Orchestrator** to
*„agentowy komponent decyzyjny **wewnątrz** tej granicy"*: buduje/aktualizuje plan, rozbija cel
na taski, wybiera profil wykonania, ocenia wyniki, decyduje retry/replan/review, przygotowuje
syntezę, formułuje pytanie do użytkownika. **Nie może**: omijać kolejki i wykonywać dowolnych
narzędzi domenowych, zapisywać rozmowy, terminalizować bez walidacji przez Service, ufać
modelowemu `attemptNumber`/`taskId`/statusowi/fence, ani utrzymywać poprawności wyłącznie
w LLM working memory.

**Zasada, która przesądza o kształcie:** *„Każda aktywacja linii jest **krótka** i kończy się
jedną z decyzji: dispatch, wait, request_user, synthesize lub terminalize. Oczekiwanie na
workery odbywa się w stanie trwałym, **nie wewnątrz wywołania modelu**."* Koordynator nie
„trzyma" zadań — robi jedną decyzję i kończy; wynik budzi job i odpala **nową** krótką
aktywację nad trwałym stanem. Stąd żonglowanie wieloma zadaniami wychodzi samo: **jeden
logiczny writer na job, ale wiele jobów równolegle**.

**Szew jest już w kodzie** (`store/activations.ts`): dziś sekwencja to
`claimPlanningActivation` → `startPlanningActivation` → **`proposal` zbudowany na sztywno** →
`markPlanningActivationPayloadReady` (zamraża generation+hash przed business cutoffem) →
reducer commituje **dokładnie ten hash** przed work deadline. Zmieniamy **wyłącznie krok
trzeci**. Lease, fence, marker, hash, CAS, recovery — zostają bez zmian.

**Prace**
1. ✅ **Granica decyzji bez modelu** (`e609eed`) — `LaneDecisionV1` w
   `contracts/lane-decision.ts` (5 decyzji §4.2), `assertLaneDecision` **totalna i ostra**
   (nieznany kind / brak pola / zły typ / tablica / null / za długi tekst → wyjątek, nigdy
   koercja), decydent **wstrzykiwany** do `runPlanningActivation` jak `ModelCaller` do
   gateway'a, default = `deterministicSerialDecider` odtwarzający dotychczasowy plan.
   **Decyzja niesie WYŁĄCZNIE intencję:** zamiast sanitizować `jobId`/`taskId`/`planVersion`/
   `fence`, kontrakt **nie daje im gdzie zamieszkać** — sama ich OBECNOŚĆ to błąd. Fan-out
   (`PARALLEL`/`FANOUT`) odrzucany **na kontrakcie**, nie po cichu degradowany do jednego
   zadania. Fail-closed: decydent, który rzuci lub zwróci śmieć, degraduje do
   deterministycznego `dispatch`, nie zatrzymuje linii. **Zero zmian zachowania —
   zweryfikowane na żywym replica secie:** `activation`, `full-loop`, `result-drain`
   i `autonomous` przechodzą bez zmian. Test: `check:lane-decision` (w check:all).
2. ✅ **Model produkuje DECYZJĘ, nigdy autorytet** (`019b677`) — za flagą
   `FEATURE_ORCHESTRATION_V2_LANE_ORCHESTRATOR` (**default OFF**).
   **Ograniczony samą aktywacją:** wywołanie idzie przez ten sam `runBoundedModelCall` co
   worker, z `businessOperationCutoffAt` aktywacji jako deadline — „aktywacja jest krótka"
   staje się **strukturalne**, bo wywołanie nie może przeżyć okna, w którym jego wynik dałoby
   się w ogóle zamrozić; okno już wygasłe **nie startuje wywołania w ogóle**.
   **Parsowanie łagodne w OPRAWIE, ostre w TREŚCI:** modele owijają JSON w prozę i fence'y
   niezależnie od promptu, więc wyciągany jest pierwszy zbalansowany obiekt — ale sam obiekt
   idzie do `assertLaneDecision` bez zmian, więc łagodność wobec oprawy **nie poszerza** tego,
   co jest akceptowane. **Fail-closed i NIE po cichu:** timeout/pustka/śmieć/zły kształt →
   deterministyczny `dispatch` **+ wpis `OperatorAlertRequested`** w outboxie (deterministyczny
   `_id`) — linia cicho jadąca bez koordynatora wygląda identycznie jak linia działająca
   poprawnie i to jest awaria warta wychwycenia. `laneOrchestratorAgent` jest **bez narzędzi
   i bez pamięci** z konstrukcji (§4.2 tego zabrania — więc nie dostaje ich, zamiast być
   proszonym, żeby nie używał). Test: `check:lane-decider-model` (macierz adwersarialna na
   skryptowanym modelu). **Zweryfikowane live:** serwer raportuje `lane: AGENTIC (model
   decides)`, realny job → `COMPLETED`, **zero alertów fallbacku**.
3. 🔀 **Ocena wyniku → retry/replan — SCALONE Z PUNKTEM 5** (ustalenie 2026-07-30, `fd0650e`).
   Pierwotne założenie („aktywacja po `RESULT_DRAIN` decyduje") jest **niewykonalne w tym
   miejscu**: job zaplanowany typową ścieżką terminalizuje się **wewnątrz**
   `runResultDrainActivation` (reducer liczy i commituje `terminalOutcome` we własnej
   transakcji i wraca z `laneStep`), a terminal jest monotoniczny — zanim legacy gałąź
   terminal-advance staje się osiągalna, job jest już zamknięty. Plan zresztą **zabrania**
   wprost: *„RESULT_DRAIN nie uruchamia modelu/toola"*, i w tym samym zdaniu wskazuje
   właściwe miejsce: *„FINAL_DECISION ma własny typed decision boundary"*. `FINAL_DECISION`
   jest **już zarezerwowanym** `ACTIVATION_KIND` z chronioną rezerwą terminalną, stworzonym
   dokładnie po to, by w jednym commicie zapisać decyzję terminal/partial/eskalacja.
   **Wniosek: ocena wyniku, replan i synteza to JEDNA praca — nowa aktywacja
   `FINAL_DECISION`, nie hak w drenie.** Szew zbudowany w złym miejscu został **wycofany**,
   nie zostawiony jako martwy kod (odpalałby się tylko dla jobów poza typową ścieżką, a task
   dorobiony przez `createTask` nie niesie `resultApplyMode`, więc replan miałby inną
   semantykę stosowania wyniku niż oryginał). Zostawiony: rozszerzenie kontraktu
   (`reason`/`taskPhases`/`taskCount`) — to kształt, którego `FINAL_DECISION` potrzebuje.
4. ✅ **`request_user` — człowiek w pętli** (`1423c44`). Pytanie linii zadawane jest **w trakcie
   planowania**, zanim istnieje task/attempt — więc wiąże się z samym jobem
   (`ControlRequestDoc.taskId` → nullable). To była cała istota tego przyrostu, bo istniejąca
   maszyneria requestów zakładała task **wszędzie**, a dwa jej konsumenty uczyniłyby takie
   pytanie bezużytecznym: `answerJobRequest` robił twardy CAS na tasku i rzucał → pytanie
   **nieodpowiadalne**; `expireStaleRequests` pomijał request bez taska → pytanie
   **niewygasalne**. Oba blokowałyby joba na zawsze, każde z drugiej strony — oba przypięte
   testem. `openLaneUserRequest` trzyma **maksymalnie jedno** otwarte pytanie na job (retry
   aktywacji nie stackuje kolejki pytań) i emituje projektowalny `JobAwaitingInput` **bez**
   wake'a linii (job czeka na człowieka; budzenie linii tylko by ją kręciło). **Aktywacja
   zadająca pytanie jest rozliczana** — zapytanie to jej wykonana praca, więc musi zwolnić
   unikalny slot joba i wyczyścić wskaźnik; bez tego slot zostawał zajęty i job **nie mógł
   zaplanować nawet po odpowiedzi** (złapane testem, nie czytaniem). Pętla domyka się **bez
   nowej powierzchni**: front już pokazuje `awaitingAnswer` i odpowiada przez
   `orchestration_answer_job_request`.
5. ✅ **`FINAL_DECISION` — ocena wyniku + replan** (`0453812`, wchłonęło punkt 3).
   **Umiejscowienie było całą robotą** — dwa celowe inwarianty blokują oczywiste podejścia,
   oba znalezione testem, nie czytaniem: (a) dren commituje terminalizację **we własnej
   transakcji**, a terminal jest **monotoniczny**, więc hak tam zawsze przychodzi za późno
   (plan i tak zabrania modelu w drenie); (b) `advanceJobFromTasks` **odmawia** terminalizacji
   joba typed-drain w `AWAITING_RESULTS` z założenia („RESULT_DRAIN owns every AWAITING_RESULTS
   terminal transition") — delegowanie zakończenia do niego po cichu nic nie robiło i parkowało
   joba na zawsze. Rozwiązanie: dren **odracza** (stosuje wynik, zostawia job nieterminalny,
   pisze własny wake — inaczej brak successor planu = zawis), a `FINAL_DECISION` ocenia
   i **pisze terminal własną granicą** — dokładnie to, co plan nazywa „własnym typed decision
   boundary". **Wynik pochodzi ze STANU ZADAŃ, nie z modelu** — sędzia mówiący `COMPLETED` nad
   FAILED taskiem nie wybieli go; wybiera CZY skończyć, zadania decydują JAK. **Ogranicznik
   replanów** = liczba tasków (bez zmiany schematu), wyczerpanie → terminal **+ alert operatora**
   (job kończący się z braku prób wygląda identycznie jak udany). **Każda niebezpieczna ścieżka
   kończy joba**: rzucający sędzia, zła decyzja, przegrany wyścig admisji, pauza. Replan wraca
   do `READY` + wake, bo inaczej gałąź drenu ucina pętlę przed dispatchem i nowy task nigdy nie
   biegnie. **Zakres uczciwy:** chroniona rezerwa terminalna z §11 **nie istnieje** (brak pul
   budżetowych poza STOP), więc slice ogranicza się własnym oknem; eskalacja i manual-recovery
   niezbudowane. Live: `decidedBy: FINAL_DECISION`, 1 task, 0 alertów.
6. ⬜ **Fan-out (wiele tasków, fan-in)** — **świadomie ODŁOŻONE**: wymaga
   `ORC-DISPATCH-EDGE-01` na pełnym dependency closure i multi-task apply w B. Do Fal 6-7,
   razem z pierwszym realnym konsumentem topologii dziecięcej.

**Definicja ukończenia**
- Każda decyzja modelu przechodzi **dokładnie tę samą** ścieżkę marker→hash→CAS co dzisiejszy
  plan; commit admituje wyłącznie zamrożony hash.
- **Model nie może podnieść autorytetu** — test: decyzja z podrobionym `jobId`/`taskId`/
  `planVersion`/fence jest odrzucona, nie zastosowana.
- **Aktywacja jest krótka**: czekanie na workera odbywa się w stanie trwałym. Mierzalne —
  czas aktywacji jest rzędu jednego wywołania modelu, nie czasu trwania joba.
- **Crash w połowie aktywacji** → następna aktywacja czyta trwały stan i kontynuuje
  (istniejące `CONTROL_RECOVERY`/reaper obejmuje nową ścieżkę, udowodnione testem).
- **Wiele jobów równolegle**, każdy z własną linią, bez cross-talk i bez podwójnego writera.
- Flaga OFF → zachowanie **bit w bit** dzisiejsze (deterministyczny `dispatch`).

**Czego świadomie NIE robimy w tym etapie**
- fan-out/fan-in i topologii dziecięcej (punkt 6 wyżej);
- routingu capability→agent — to nadal Fale 6-8, `singleAgentRoute` zostaje;
- przenoszenia legacy `delegate_task` pod linię — to F6.

**Ryzyko:** **wysokie** — to pierwszy model wpuszczony w linię orkiestracji, czyli w miejsce,
które ma autorytet nad stanem joba. Mitygacja jest strukturalna, nie proceduralna: model
zwraca *propozycję*, nie decyzję wykonawczą; wszystkie identyfikatory i wersje wstawia kod;
walidacja + hash + CAS są niezmienione; fallback deterministyczny; flaga OFF.
**Rozmiar:** 3–5 sesji. **Fala rodzica:** 4 (review/retry/replan/synthesis), gates G4-wake/G5-front.
**Kontrakty dotknięte:** `ORC-AUTH-ACTIVATION-01` (authority aktywacji), `ORC-RESULT-READY-01`
(marker/hash), `ORC-REQUEST-01` (`request_user`), `ORC-BUDGET-01` (`FINAL_DECISION` reserve).

---

### ⭐ NASTĘPNY KROK — czytaj to najpierw po przerwie

**Stan na 2026-08-10, koniec sesji. F1–F6 ZAMKNIĘTE.** Silnik potrafi dziś: przyjąć polecenie
nieblokująco, zapisać je trwale, **wybrać specjalistę**, wykonać pod pełnym profilem harnessu,
ocenić własny wynik i ponowić próbę, zapytać człowieka i domknąć job — wszystko przeżywa restart
procesu. **A od F6 dwa mechanizmy tła faktycznie zeszły z legacy** (delegacja async i Automation
Golden Path), trzeci jest utwardzony (capability BUILD), Ledger jest projekcją zamiast drugiego
schedulera, a wyzwalacze mają regułę next-fire.

**Flagi V2 są WŁĄCZONE w `.env` od 2026-07-30.** Dwie flagi F6 (`…_DELEGATION`,
`…_AUTOMATION_JOBS`) są **domyślnie OFF** — trzeba je włączyć świadomie, per mechanizm; rollback
to ich zdjęcie. Prace 3–5 są **bez flagi**, bo to naprawy defektów, nie przełączniki.

#### CO ZOSTAŁO — trzy rzeczy poza migracją agentów (F6B odhaczone)

Migracja agentów (F7) jest największa, ale **nie jedyna** — i nie pierwsza. Poza nią zostaje:

| # | Co | Rozmiar | Dlaczego to nie jest opcjonalne |
|---|---|---|---|
| ~~0~~ | ~~**F6B — plan wielozadaniowy**~~ ✅ **ZROBIONE 2026-08-10** | — | ~~**Idzie PRZED migracją agentów.** Dziś job prowadzi przez dokładnie jednego agenta; zlecenie na trzech specjalistów rozpada się na delegacje wewnątrz jednego runu, których substrat nie widzi i po restarcie **powtarza od zera**. Maszyneria fan-out/fan-in istnieje i jest wpięta w lane — brakuje pięciu nazwanych rzeczy (patrz §F6B). Migracja agentów bez tego zakonserwuje obecny kształt.~~ Zamknięte: kroki jadą w kolejności z własnymi budżetami, widzą wynik poprzednika, a anulowanie domyka job. Zdolność modelu do ZAPROPONOWANIA planu dołożona dopiero 2026-08-12 (`GAP-PLAN-STEPS-01`) — stan i dowody trzyma sekcja §F6B, nie ten wiersz. |
| **A** | **F8 — G8 fault suite** na topologii ≥3 węzłów | 3–5 sesji | Jedyny formalny blocker rolloutu wg ADR 0006. Dotyczy **utraty danych**, nie wiarygodności testów: partition worker↔Mongo w trakcie claim/heartbeat, stepdown primary w trakcie odnawiania lease, powrót starego primary po wygaśnięciu fence. **F1 dał single-node RS — wystarcza do transakcji, NIE wystarcza do stepdown/partition.** To jedyny etap wymagający nowej infrastruktury. |
| **B** | **F9 — rollout i USUNIĘCIE legacy** | 3–5 sesji | Kohorty, SLO, alerty, próba rollbacku N/N-1, zero ruchu legacy przez ustalony okres — i dopiero potem kasowanie `void executeDelegation` i flag. **Warunek wejścia jest już mierzalny:** `npm run audit:cutover` musi pokazać `drained-in-v1 = 0` (2026-08-10: **1 wiersz**). |
| **C** | **Ogony z F5** — dashboard jako **command client** (dziś tylko czyta), SSE zamiast pollingu, korpus NL routingu (K5) | 1–2 sesje | Nie blokuje niczego, ale bez command clienta operator może durable joba **obejrzeć, ale nie zatrzymać** inaczej niż przez agenta. |

**Świadomie NIE robimy** (to decyzje, nie zaległości — patrz §5): `ORC-TXN-A-EVIDENCE-01`,
`ORC-SPECULATION-01`, `ORC-ATTACHED-01` (zgatowane konsumentem, którego nie ma), fan-out/fan-in,
chroniona rezerwa budżetowa dla `FINAL_DECISION`, `budgetedMongo`, klasa `extended` 1800 s
(dowody jej nie popierają).

**Dwie rzeczy do zapamiętania z F6, bo obie kosztowały:**
1. **Trzy razy z rzędu bug chował się za TEST DOUBLEM** (`findArtifactIds`, `readResult`,
   `consumeApproval`). Gdy test nazywa się od jakiejś logiki, ta logika **musi się w nim wykonać**.
2. **Cutover potrafi po cichu WYPROWADZIĆ pracę spod istniejącej kontroli bezpieczeństwa.**
   Po przeniesieniu mechanizmu sprawdź, kto jeszcze go pilnował (kill switch, stale-reconciler,
   claims) i czy nadal sięga. Kill switch przestał działać dla wszystkiego, co przeniosłem —
   naprawione dopiero w pracy 4.

#### ✅ CANARY WYKONANY 2026-07-30 — flagi SĄ włączone w `.env`

**Canary zarobił na siebie w pierwszym realnym jobie.** Znalazł dwa bugi, których
deterministyczne testy nie mogły złapać (`68f8352`):

1. **Sędzia nie wiedział, że ocenia — i nie miał czym.** `buildDecisionPrompt` ignorował
   `reason`, więc „jak zacząć" i „czy to wystarczy" dawały **identyczny** prompt; przy celu
   i „praca zmaterializowana: tak" naturalną odpowiedzią jest `dispatch`, więc sędzia kazał
   powtarzać **za każdym razem**. Do tego **nie widział wyniku** — tylko fazy zadań — więc
   nawet wiedząc, że ocenia, nie mógł ocenić jakości. §4.2 każe oceniać „results **and
   evidence**"; evidence brakowało. Efekt: **3 próby zamiast 1**, zakończone dopiero przez
   ogranicznik replanów + alert. Ogranicznik zadziałał, ale **maskował zepsutego sędziego**,
   zamiast łapać rzadki przypadek. Naprawa: prompt rozgałęziony na `reason` + wynik (status
   i tekst, cap 4k) w kontekście. **Po naprawie: 3 zadania → 1, 1 alert → 0.**
2. **Front obiecywał powiadomienie, którego nie umie dostarczyć** („poinformuję Cię, gdy
   praca się zakończy") — push nie istnieje, użytkownik czekałby na wiadomość, która nigdy
   nie przyjdzie. Prompt tego teraz zabrania i każe zaprosić do pytania.

**Stan po naprawach (zweryfikowany live):** 2 joby, **2 zadania**, **0 alertów**, oba
`COMPLETED`; front zlecił drugą pracę w trakcie raportowania pierwszej, wylistował obie
z poprawnymi statusami, dashboard operatora je pokazał. Obie regresje przypięte
w `check:lane-decider-model`.

**Konfiguracja w `.env` (backup: `.env.backup-20260730-212222`):** cztery flagi V2 +
`ORCHESTRATION_V2_DEFAULT_AGENT=researcherAgent`, baza `orchestration_v2`.
**Rollback:** zakomentuj cztery `FEATURE_*` — legacy nie jest wyłączane, nic nie przejmuje
automatycznie.

#### ~~Krok 1: CANARY~~ ✅ ZROBIONE — oryginalna instrukcja poniżej dla referencji

```bash
FEATURE_ORCHESTRATION_V2=true
FEATURE_ORCHESTRATION_V2_HARNESS_WORKER=true      # bez tego przepięcie = regresja
FEATURE_ORCHESTRATION_V2_LANE_ORCHESTRATOR=true   # agentowy koordynator
FEATURE_ORCHESTRATION_V2_AGENT_TOOLS=true         # narzędzia + Meta Front
MONGODB_URI_V2=mongodb://localhost:27017/?replicaSet=rs0
MONGODB_DB_V2=orchestration_v2
ORCHESTRATION_V2_DEFAULT_AGENT=researcherAgent    # coś użytecznego, nie weatherAgent
```

**Dlaczego to przed dalszym kodem:** każda kolejna faza (routing capability→agent, migracja
agentów) buduje NA tym silniku. Puszczenie przez niego realnego ruchu **teraz**, przy jednej
capability i pełnej obserwowalności (`/dashboard/orchestration/jobs`), wychwyci to, czego
testy nie widzą — dokładnie tak jak w tej sesji live-verify wychwycił tripwire, pustą
odpowiedź i martwe pętle tła. Rollback = usunięcie flag. **Zero ryzyka dla legacy** — nic się
nie wyłącza, nowy silnik stoi obok.

**Na co patrzeć w canary:** czy joby kończą się `COMPLETED`; czy `decidedBy: FINAL_DECISION`
pojawia się w zdarzeniach; czy są alerty `lane_replan_exhausted` / `final_decision_fallback`
/ `lane_decision_fallback` (każdy = sędzia zawodzi i degradujemy po cichu); ile realnie kosztuje
tokenowo aktywacja linii.

#### ✅ KROK 2 ZROBIONY — router capability→agent (`0140a2c`)

**Wariant B: koordynator proponuje capability, granica ją waliduje.** Model nie podaje
`agentId` ani żadnego identyfikatora — nazywa **capability z zamkniętego menu**, które napisał
kod. Ten sam wzorzec co reszta linii: model proponuje, granica dysponuje.

```
decyzja linii   {"kind":"dispatch","attemptMode":"SERIAL","capability":"chefAgent"}
      ↓ walidacja względem menu, które faktycznie zaoferowano
zamrożony plan  PlanningProposalV1.capability → TaskDoc.capability
      ↓ ponowne rozwiązanie w momencie dispatchu
worker          capabilityRoute → mastra.getAgent('chefAgent')
```

**Sześć decyzji projektowych, każda z powodem:**

1. **Słownikiem jest Agent Board, nie druga lista.** Board to istniejące jedyne źródło prawdy
   „kto co potrafi", już pilnowane driftowo względem `index.ts` i już używane przez legacy
   delegację. Równoległy słownik capability byłby pierwszą rzeczą, która cicho zgnije.
2. **Zaoferowane = akceptowane.** Rejestr budowany JEDEN raz przy mountcie; ten sam obiekt
   renderuje menu do promptu i waliduje odpowiedź, więc linia nie może dostać w menu
   specjalisty, którego worker nie umie uruchomić.
3. **Nazwa spoza menu jest ODRZUCANA, nie pomijana.** Ciche puszczenie takiego joba na
   domyślnym agencie ukrywa jedyny sygnał, który ma tu wartość; istniejąca ścieżka fallbacku
   i tak routuje na default, ale **z alertem operatorskim**.
4. **Wybór jest trwały.** Zamrożony w hashowanej propozycji pod tym samym fence'em co zadanie
   — retry, crash między freeze a commit i restart procesu trafiają do TEGO SAMEGO specjalisty.
   Rozwiązywanie capability przy dispatchu z innej decyzji zrobiłoby z trasy własność tego,
   kto akurat uruchomił workera.
5. **Nieaktualna capability FAILUJE** (`no_route`) zamiast podstawiać kogoś innego. Wiarygodna
   odpowiedź od złego eksperta jest gorsza niż widoczna porażka.
6. **Domyślna lista jest wąska.** `ORCHESTRATION_V2_CAPABILITIES` domyślnie zawiera agentów,
   których najgorszy przypadek to zmarnowany run; ci, którzy wydają pieniądze (`musicianAgent`,
   `filmmakerAgent`, `designAgent`), piszą na zewnątrz (`marketingAgent`, `salesAgent`,
   `huntAgent`) lub zmieniają system (`automationArchitect`, `codingAgent`, `capabilitySmith`)
   są opt-in. Flagi są włączone, więc pierwsze pomylone trafienie dzieje się na produkcji.
   `*` = cały board.

Przy okazji podpięty `dispatch.taskGoal` — był w kontrakcie, ale **nikt go nie czytał**, więc
doprecyzowanie zadania przez linię było po cichu wyrzucane.

**Dwie luki znalezione przez testy, nie przez przegląd:**

- `assertLaneDecision` twierdził w nagłówku „nadmiarowy klucz to twardy błąd", ale egzekwował
  tylko nazwane pola autorytetu — decyzja mogła nieść `agentId` i przejść. Nic go nie czytało,
  ale „granica odrzuca wszystko, czego nie rozumie w pełni" to CAŁY argument bezpieczeństwa,
  a pole tylko-ignorowane jest o jeden refaktor od bycia honorowanym. Teraz totalny per kind.
- **Meta Front sam napisał menu** zamiast oddać je `chefAgent`. „Odpowiadaj wprost, gdy
  możesz" czyta się modelowi jako „odpowiadaj na wszystko, na co umiesz wygenerować tekst" —
  co cicho przywraca jednego generalistę, którego ten silnik ma zastąpić. Prompt ma teraz
  twardą regułę na górze (deliverable → zawsze `orchestration_start_job`). **Uwaga: pierwsza,
  łagodniejsza wersja poprawki NIE zadziałała** — `gemini-3.1-flash-lite` wymagał reguły
  imperatywnej i zamkniętej listy wyjątków, nie akapitu z uzasadnieniem.

**Canary (live, produkcyjny build):** „zaprojektuj menu degustacyjne" → `chefAgent`,
„napisz opowiadanie" → `writerAgent`; oba zamrożone na zadaniu, oba `COMPLETED`, **0 alertów**.
Wcześniejsze joby w tej samej bazie mają `capability: null` — ścieżka additive trzyma.
Testy: `check:capability-routing` (21 asercji, część deterministyczna + część na realnym RS).

#### 🔄 KROK 3 — headless contract dla specjalistów (część 1 z 2 ZROBIONA)

**Router działa; specjaliści nie są gotowi.** Canary routingu pokazał to na obu jobach:
`chefAgent` odpowiedział pytaniami doprecyzowującymi zamiast menu (a sędzia uznał to za
`COMPLETED`), `writerAgent` zwrócił komentarz reflektora O opowiadaniu zamiast opowiadania.
Żadnego z tych dwóch `check:all` nie widzi.

##### ✅ 3a. `request_user` w `FINAL_DECISION` (`9a3112a`)

Sędzia ma trzecią odpowiedź: praca **wróciła z pytaniem, nie z produktem**. Powtórka zapytałaby
znowu, a terminalizacja daje użytkownikowi `COMPLETED`, w którym leży pytanie.

| własność | jak wymuszona |
|---|---|
| job NIE jest skończony | idzie w `AWAITING_USER` z trwałym pytaniem; **`advanceJobFromTasks` odmawia teraz terminalizacji tej fazy** — wcześniej zamknąłby taki job na następnym ticku, bo wszystkie zadania są `SUCCEEDED` i nic tam nie protestowało |
| odpowiedź naprawdę pomaga | `answerJobRequest` wpycha ją do `instructions` i wraca do `READY`; **worker przy powtórce ją widzi** — asercja end-to-end, bo odpowiedź, która zadowala tylko sędziego, byłaby teatrem |
| sędzia nie pyta o to, co już wie | kontekst oceny niesie `instructions` (z każdą odpowiedzią) i `questionsAsked`; bez tego drugie spojrzenie widzi ten sam niezmieniony wynik i pyta ponownie |
| pytania są ograniczone | `ORCHESTRATION_V2_MAX_LANE_QUESTIONS` (domyślnie 2), potem koniec + alert `lane_questions_exhausted`. Ten limit waży **więcej** niż limit replanów: każde okrążenie kosztuje CZŁOWIEKA rundę, nie tylko tokeny |

**Pułapka live:** ścieżka odpala się tylko, gdy specjalista **zapyta zamiast zmyślić**. Na canary
`chefAgent` raz zapytał, a przy niemal identycznym zleceniu następnym razem po cichu wymyślił
temat („Las"). To jest dokładnie argument za 3b — `request_user` to maszyneria, decyzja
specjalisty to druga połowa.

##### ✅ 3a-bis. Meta Front nie może zmyślić joba (ten sam commit)

Canary routingu złapał dwie rzeczy, które front robił NA ŻYWO:

1. **zgłosił „zacząłem, ID `job_coffee_article`" nie wywoławszy narzędzia.** Nic nie istniało.
   To jest najgroźniejszy tryb awarii tej warstwy, bo **wygląda identycznie jak sukces** —
   użytkownik czeka na coś, czego nie ma;
2. **zwrócił pusty string**, dwa razy z rzędu, dla jednego konkretnego sformułowania.

Oba to własności modelu (`gemini-3.1-flash-lite`, wybranego dla latencji) i wrócą pod
obciążeniem. `services/meta-front-reply.ts` sprawdza więc **fakty, nie styl**: tura wie, jakie
jobId zwróciły JEJ WŁASNE wywołania narzędzi, a każdy inny token `job_…` w tekście jest zmyślony.
Odpowiedź, która oblała audyt, jest **raz korygowana** (autorstwo zostaje przy froncie, więc
zostaje też język użytkownika) i dopiero po drugim niepowodzeniu podmieniana na stały komunikat.
Sprawdza twierdzenia o **jobach** (weryfikowalne), nie twierdzenia w ogóle — front nadal potrafi
napisać „przeszukałem pliki", czego nie robi.
**Po naprawie:** oba sformułowania, które padały, działają; artykuł o kawie dostał **prawdziwy**
`job_0b21c0c1-…` zgodny z raportem. Test: `check:meta-front-reply` (9 asercji, obie awarie
live przypięte).

##### ✅ 3b. Kontrakt wyjścia dla trybu headless (`cfa7fdd`)

**Kontrakt należy do TRYBU URUCHOMIENIA, nie do agenta.** Dlatego jest w jednym miejscu
(`orchestration/execution/headless-contract.ts`), doklejany do promptu każdej trasy, i obejmuje
wszystkie 18 capability naraz — a oczekiwany artefakt bierze z karty Agent Board
(`outputArtifacts`), nie z drugiego opisu, który mógłby się rozjechać.

Wyklucza **oba** kierunki błędu naraz, i to jest sedno — „pytaj, gdy nie wiesz" daje pierwszy,
„nigdy nie pytaj" daje drugi:

- kończ **gotową pracą**, nie planem, nie streszczeniem, nie refleksją;
- brak szczegółu **nie jest powodem do zatrzymania**: wybierz sensowne domyślne, ZRÓB pracę
  i dopisz jedną linijkę z założeniami;
- tylko gdy cel jest niemożliwy bez czegoś, co ma wyłącznie użytkownik — odpowiedz dokładnie
  `NEEDS_INPUT: <jedno pytanie>`.

**Marker jest rozpoznawany deterministycznie** w `FINAL_DECISION`, zanim ktokolwiek zapyta model
— pytanie modelu „czy to produkt, czy pytanie?" to dokładnie to, co już raz zawiodło. Gotowy
produkt, który tylko *wspomina* marker, nie jest brany za blokadę.

**Dwa defekty, które to wyciągnęło** (żadnego suite wcześniej nie widział):

1. `renderResultText` serializował całą kopertę wyniku → **sędzia czytał zaescapowany JSON**
   zamiast odpowiedzi, a `{"text":"` stało przed wszystkim, co próbuje czytać wynik strukturalnie
   (dlatego marker był niewidoczny).
2. **Zasób pamięci V2 był per-agent** (`orch-v2:<agentId>`). Specjalista może delegować WEWNĄTRZ
   swojego runu — recon chefa sięga po researchera — i wtedy procesor pamięci agenta wewnętrznego
   odrzucał wiadomości agenta zewnętrznego: `wrong resourceId. Input orch-v2:chefAgent, expected
   orch-v2:researcherAgent`. **Trzy puste próby i job FAILED.** Job to jedna rozmowa, więc jeden
   zasób; wątek per job jest tym, co realnie rozdziela joby. Regresja przypięta w
   `check:v2-harness-worker`.

✅ **CANARY 3B DOKOŃCZONY 2026-08-08 — wynik podzielony.**

**Pułapka środowiskowa (kosztowała pół sesji):** zbudowany serwer „nie wstawał" — proces żył,
boot dochodził do `SkillRegistry`, port 4111 nigdy nie nasłuchiwał, **zero błędów w logu**.
Przyczyna: domyślny `node` w powłoce spadł do **v20**, a natywne moduły builda są skompilowane
pod **v22** (`.nvmrc`). Zawsze startuj build przez `scripts/with-node.sh` albo po `nvm use`.

| agent | wynik | ocena |
|---|---|---|
| `writerAgent` | `COMPLETED`, 1 zadanie, wynik = **samo opowiadanie** („# Zegarmistrz z Kazimierza…") | ✅ **regresja #3 zamknięta** — wcześniej zwracał komentarz reflektora O opowiadaniu |
| `chefAgent` | `FAILED`: zadanie 1 pusty wynik → replan → zadanie 2 `SUCCEEDED`, ale **wynikiem jest raport scorera** | ❌ nadal zepsute, **z inną przyczyną niż zakładaliśmy** |

**Co dokładnie wraca od chefa (dowód z logu):**
```
{"text":"#### Completion Check Results\n\nOverall: ✅ COMPLETE\nDuration: 7ms\n
**Goal Completion Scorer** (goal-completion)\nScore: 1 ✅ …\n✅ The task is complete."}
```
To **nie jest tekst agenta** — to raport wewnętrznego scorera harnessu, który stał się ostatnim
tekstem runu, a `fullResponseText` bierze `response.text` i commituje go jako wynik joba.

**Wniosek — to inna klasa niż 3b i kontrakt jej nie naprawi.** Kontrakt mówi agentowi, czym ma
być JEGO ostatnia wiadomość; tu ostatniej wiadomości **nie napisał agent**, tylko podsystem
harnessu. Writer wyzdrowiał, bo jego wyciek (refleksja) pochodził od modelu — chef nie, bo jego
pochodzi z harnessu.

⚠️ **Dodatkowo: poprawka zasobu pamięci pozostaje niepotwierdzona.** Błąd `wrong resourceId`
już nie występuje w logu, ale pierwsze zadanie chefa nadal kończy się **pustym wynikiem bez
żadnego błędu**, więc nie wiadomo, czy to ta sama przyczyna, czy kolejna.

⚠️ **Zauważone przy okazji:** job z zadaniami `[FAILED, SUCCEEDED]` dostaje `terminalOutcome:
FAILED` (reduktor: jakikolwiek FAILED → FAILED). Po replanie, który się UDAŁ, użytkownik
dostaje „FAILED" mimo dowiezionej pracy. Do decyzji: czy udany replan ma kasować wcześniejszą
porażkę.

##### ✅ Wybór tekstu wyniku w harnessie — ZROBIONE (`657f596`)

`extractFullOutputText` deleguje do `services/harness-output-text.ts`: pomija tekst autorstwa
frameworka i schodzi do **ostatniego realnego kroku z produktem**. Caller V2 czytał
`response.text` bezpośrednio — teraz idzie przez ten sam selektor, bo inaczej wróciłby dokładnie
ten bug na ścieżce, która go wywołała.

**Matcher jest CELOWO wąski.** Dwa błędy mają nierówny koszt: przeoczenie nowego artefaktu
frameworka tylko przywraca dzisiejsze zachowanie, a odrzucenie prawdziwego produktu **niszczy
pracę po cichu i niezauważalnie**. Dlatego wzorzec musi odpowiadać output'owi, który realnie
zaobserwowaliśmy, a testy ważą kierunek „to NIE jest artefakt" mocniej. Gdy wszystkie kandydatury
są artefaktem → wynik pusty, bo pusty wynik **wywala próbę widocznie**, a „✅ The task is
complete" wygląda jak sukces. Test: `check:harness-output-text` (9 asercji).

##### ✅ Budżet próby per capability — ZROBIONE

Okno idzie za `latencyClass` z Agent Board (`seconds` 120 s / `minutes` 300 s / `long` 900 s),
liczone przez KOD (model, który mógłby ustawić sobie okno, mógłby ustawić sobie godzinę)
i **zamrożone na zadaniu** razem z capability — retry po restarcie ma dostać to okno, które
wybrał plan, nie to, które akurat jest w configu. **Live: zadanie chefa ma `attemptCapMs:
900000`, okno próby zmierzone 896 s zamiast 296 s.**

Przy okazji naprawiony bug routingu, który wyszedł z canary: **replan tworzył zadanie BEZ
capability**, więc powtórka joba chefowego szła do agenta DOMYŚLNEGO — job po cichu zmieniał
specjalistę w połowie. Replan dziedziczy teraz specjalistę i budżet
(`check:final-decision` → „a replan keeps the specialist and its budget").

##### ✅ CHEF NAPRAWIONY — kolizja limitów, dokładnie ta, o której mówiłeś

**Prześledzenie legacy dało odpowiedź od razu.** Dwie ścieżki nie zgadzały się co do limitu,
którego żadna nie ogłaszała:

| ścieżka | jak woła agenta | realny sufit kroków |
|---|---|---|
| legacy delegacja | `agent.generate(prompt, { memory })` — **bez `maxSteps`** | własne `defaultOptions` agenta: **150** |
| harness / V2 | profil głębokości `deep` | **40**, nadpisując agenta |

`chefAgent` deklaruje 150, bo recon → profil → menu → przepisy → księga w mniejszej liczbie się
nie mieści. Przy 40 przepracował całe 894 s i **nie zwrócił ani znaku** — a że wygląda to
identycznie jak timeout, trzy wcześniejsze śledztwa (zasób pamięci, wybór deliverable, budżet
próby) znalazły po drodze trzy PRAWDZIWE bugi, ale nie ten.

**Reguła: harness może PODNIEŚĆ sufit do tego, co deklaruje agent — nigdy go nie obniża.**
Podniesienie nie wydłuża krótkiej tury (model kończy, gdy skończy), a obniżenie poniżej
strukturalnej potrzeby pipeline'u nie oszczędza nic: run pali całe okno i zwraca ZERO, po czym
job go powtarza. Agent, który nic nie deklaruje, dostaje profil bez zmian, a podniesienie jest
**logowane** — bo cicho inny sufit to dokładnie ten mechanizm, który ukrywał się przez cztery
canary. Test: `check:step-ceiling`.

**Live:** `[Harness] step ceiling raised to the agent's own 150 (profile: 40)`, a job chefa
skończył `COMPLETED`, jedno zadanie, z widocznym pipeline'em w wyniku (założenia → profil →
research → menu → krytyk → v3 → karty techniczne). **Potwierdził się też kontrakt headless:**
run **zadeklarował założenia** („kuchnia polska z nowoczesnym twistem, sezon jesienny, fine
dining") zamiast pytać albo zmyślać po cichu.

Ten sam run pokazał, że raport `isTaskComplete` **nie zawsze jest całym tekstem** — tu był
doklejony na KOŃCU narracji agenta, więc selektor deliverable ucina teraz również ogon.

##### ✅ AUDYT LIMITÓW ZROBIONY (`audit:agent-limits`, `b3ba3ed`)

Trzy niezależne wymiary budżetu, każdy konfigurowany gdzie indziej — i nic ich nie uzgadniało:

| wymiar | gdzie ustawiany |
|---|---|
| **KROKI** | `defaultOptions.maxSteps` agenta (`src/mastra/agents/*`) |
| **OKNO PRÓBY** | capability → `latencyClass` (`config/capability-routing`) |
| **CZAS / liveness** | profil głębokości (`services/depth-controller`) |

Profile: `fast` 10 kroków/60s, `standard` 25/180s, `deep` 40/300s, `critical` 40/300s.

**Główne ustalenie: SIEDMIU z osiemnastu agentów deklaruje więcej kroków niż najgłębszy profil**
— chef, content, design, filmmaker, hunt, musician, writer (po 150) oraz researcher (50).
Czyli **bug chefa był utajony u sześciu kolejnych**; nie wyszedł tylko dlatego, że legacy
deleguje ich ścieżką direct-generate, która **nie podaje `maxSteps` w ogóle**. Każde przepięcie
takiego agenta na V2 (czyli na harness) trafiłoby dokładnie w tę samą ścianę.

Pozostałe ustalenia:
- **4 agentów nie deklaruje nic** (analytics, crm, marketing, sales) → sufit po cichu należy do
  profilu. Dla `crmAgent` (`seconds`, szybki lokalny lookup) to jest OK i celowe; dla reszty to
  brak decyzji, nie decyzja.
- **2 deklarują MNIEJ niż profil** (capabilitySmith 24, n8nMcpEngineer 24) → profil ich podnosi,
  więc ich własny limit jest dekoracyjny.
- **researcher: 50 kroków, ale tylko 300 s okna** — jedyny przypadek „długi pipeline, krótki
  zegar". Nie zmieniam go: to domyślny agent V2 i przechodził live wielokrotnie, więc zmiana
  byłaby naprawianiem czegoś, co działa. **Do obserwacji, nie do ruchu.**

**Audyt skłamał przy pierwszym uruchomieniu i to też jest wynik:** `filmmakerAgent` leży
w `film-agent.ts`, a nieistniejąca ścieżka została zaraportowana jako „nie deklaruje maxSteps" —
**defekt, którego nie było, w tym samym kształcie co sześć, które były**. Nieczytelne źródło jest
teraz twardym błędem, nigdy findingiem. Audyt, którego awarie wyglądają jak jego ustalenia, jest
gorszy niż jego brak.

##### ✅ CANARY POZOSTAŁYCH CAPABILITY ZROBIONY 2026-08-08

Po jednym realnym jobie przez Meta Front, produkcyjny build, flagi ON:

| zlecenie | trasa | wynik | produkt? |
|---|---|---|---|
| posty social o jesiennym menu | `contentAgent` | COMPLETED, **17 684 zn.** Content Pack | ✅ + **zadeklarował założenie** („treści dla GastroBridge") |
| raport KPI systemu za tydzień | `analyticsAgent` | COMPLETED, 1 785 zn. raport z TL;DR | ✅ |
| lookup leada w CRM | `crmAgent` | COMPLETED, **69 zn.** „nie odnaleziono leada" | ✅ — krótka odpowiedź JEST tu produktem |
| debata architektoniczna (Design Council) | `deliberationAgent` | COMPLETED, 6 933 zn. ustrukturyzowana debata | ✅ |

**Wszystkie cztery: 1 zadanie, 0 replanów, wynik = produkt** (nie narracja, nie refleksja, nie
raport scorera). Zużycie kroków: **1–6** — czyli nikt z tej czwórki nie zbliża się do sufitów;
problem limitów dotyczy pipeline'ów typu chef, nie zwykłych zadań.

**Jedno realne ustalenie o routerze:** pytanie biznesowe „czy wchodzić w dostawy przez Glovo —
argumenty za i przeciw + rekomendacja" poszło do **`analyticsAgent`, nie `deliberationAgent`**.
Wynik był dobry (analiza ROI z marżami), a wybór obronny — to było pytanie o opłacalność — ale
`deliberationAgent` dał się wybrać dopiero przy jawnym „zwołaj Design Council / debata
architektoniczna". **Granica analytics ↔ deliberation jest rozmyta w opisach kart**, nie w
kodzie routera. Jeśli kiedyś zacznie to przeszkadzać, poprawiać należy `whenNotToUse` w kartach
boardu, bo to one są promptem routera.

**Stan włączonych capability: 6 z 7 zweryfikowanych live** (chef, writer, content, analytics,
deliberation, crm). Nie ruszony: `researcherAgent` — ale on jest domyślnym agentem i przeszedł
live wielokrotnie od pierwszego canary.

##### 🔄 designAgent WŁĄCZONY 2026-08-09 — trasa i budżet OK, deliverable NIE

`ORCHESTRATION_V2_CAPABILITIES` jest teraz **jawną listą w `.env`** (7 domyślnych + `designAgent`);
ustawienie tej zmiennej **zastępuje** kodowy default, więc siódemka musi być wypisana ręcznie.
Backup `.env` zrobiony przed zmianą.

**Canary (prototyp HTML wizytówki restauracji):** job `COMPLETED`, trasa `designAgent`,
`attemptCapMs: 900000`, 1 zadanie, 0 replanów. **Routing i budżet działają.**

**ALE wynik ma 316 znaków i nie zawiera projektu:**
```
Now let me verify the design renders correctly:#### Completion Check Results
Overall: ✅ COMPLETE … Reason: complete — substantive final output (2316 chars) …
```
Dwie rzeczy naraz:
1. **Raport frameworka był doklejony BEZ znaku nowej linii**, wprost do zdania agenta — a mój
   strip był zakotwiczony na `\n`, więc nie zadziałał. **Naprawione** (`197b485`): nagłówek
   markdown w środku zdania to nie jest coś, co robi proza, więc wariant bez newline pozostaje
   wąski. Test z tym dokładnym kształtem przypięty.
2. **Głębszy problem, NIENAPRAWIONY:** nawet po odcięciu raportu zostaje zdanie
   „Now let me verify the design renders correctly:" — **a nie prototyp**. Sam scorer mówi, że
   realny output miał **2316 znaków**. `designAgent` **narratuje PO dowiezieniu**, więc heurystyka
   „ostatni krok nie będący artefaktem" wybiera komentarz zamiast produktu.

##### 🔄 WYBÓR PRODUKTU Z ARTEFAKTÓW (`a8e3ceb`) — zaimplementowany, live NIEDOKOŃCZONY

**Zasada: jeśli run ZAPISAŁ artefakt, to artefakt jest produktem, a tekst jest komentarzem.**
To nie jest heurystyka: id wraca z `artifact_put` **wewnątrz tego runu**, a Artifact Store nie
zapisuje żadnego `runId` — więc nic innego nie potrafi powiązać dokumentu z runem, który go
wytworzył.

**Pierwsza wersja była GORSZA niż to, co zastępowała, i to jest najważniejsza lekcja z tej rundy.**
Skanowała całą odpowiedź po `art-…`, więc łapała też artefakty, które agent tylko **PRZECZYTAŁ**
(`artifact_get`/`artifact_list`). Live: job projektowy zacommitował **niepowiązany dokument
researchowy o piekarni** („Swiss AI Bakers") jako swój produkt. **Podanie użytkownikowi CUDZEJ
pracy jest gorsze niż podanie mu narracji** — narrację widać od razu, podmieniony dokument
wygląda jak wynik. Naprawione: id brane wyłącznie z wyników `artifact_put`, test zbudowany
dokładnie z tej awarii.

⚠️ **STATUS: nie zweryfikowane live po naprawie read/write.** Deterministycznie zielone
(`check:harness-output-text`, `check:all` 69/69), ale canary designu po poprawce nie został
przejechany. **To jest pierwsza rzecz do zrobienia.**

##### 🔄 CANARY DESIGNU — NIEDOKOŃCZONY, ale przyczyna jest znana i NIE jest to bug

Trzy podejścia (`c-design2/3/4`) nie dały czystego dowodu. Diagnoza po drodze **obaliła moją
własną hipotezę** i to jest tu najważniejsze do przekazania:

- podejrzewałem, że statyczny import `artifact-store` (ciągnie **legacy** `lib/mongo.js`) do
  grafu modułów mountu V2 zabił pętlę lane — job stał w `ACCEPTED` z PENDING wake i zerem
  aktywacji. **Zrobiłem import leniwym i NIC się nie zmieniło**, więc hipoteza jest fałszywa;
- prawdziwy powód: **kolejka, nie awaria**. `c-design3` po pewnym czasie sam przeszedł do
  `DISPATCHING`. W bazie stały trzy nieterminalne joby designu naraz, worker jest **SERIAL**,
  a okno próby designu to **900 s** — więc świeży job czeka za poprzednimi. Do tego
  **ubijanie serwera w połowie próby zostawia pracę, która wznawia się przy następnym boocie**
  (czyli trwałość działa zgodnie z projektem) i backlog rośnie z każdym podejściem.

**Wniosek operacyjny na przyszłe canary:** przed canary długiego agenta wyczyścić/dokończyć
nieterminalne joby, albo użyć osobnej bazy (`MONGODB_DB_V2`), i **nie ubijać serwera w trakcie
próby** — inaczej mierzy się kolejkę, a nie zmianę. Import leniwy został (jest słuszny sam
w sobie, `76a8e74`), ale **nie jest naprawą** i tak jest opisany w kodzie.

##### ✅ PRAWDZIWA PRZYCZYNA 2026-08-09 (`881016c`): designAgent NIE MIAŁ CZYM ZAPISAĆ PLIKU

Czysty canary na pustej bazie zaczął się od sprawdzenia pipeline'u agenta w legacy — i to
sprawdzenie **unieważniło trzy poprzednie rundy diagnozy**. Problem nie był w wyborze produktu.
`designAgent` **nie miał ani jednego narzędzia zapisującego cokolwiek**:

- `run_worker` jest z definicji **text-in/text-out, BEZ narzędzi** („pure text-in-text-out
  generation") — HTML wraca ze workera jako string i umiera w tool resulcie;
- **każde** narzędzie designu, które produkuje plik (`design_render_video`, `design_export_pdf`,
  `design_export_pptx`, `design_gen_thumbs`), przyjmuje `htmlPath`/`slidesDir`, który **musi już
  istnieć na dysku**;
- czyli pipeline był **ścięty na pierwszym kroku**, a reguła z `pipeline.md` („generated user
  deliverables must be written into the active project directory") nazywała operację, której agent
  **nie potrafił wykonać**.

Każdy inny agent domenowy ma taki zapisywacz — `chef_document_write_section`,
`hunt_doc_write_section`, `deliberation_write_artifact`, `music_write_lyrics`. Domena designu
została przeportowana **bez niego**.

**Dlatego wybór produktu z artefaktów nie mógł pomóc:** warunkiem był artefakt zapisany przez run,
a agent nie miał `artifact_put` ani niczego, co by zapisywało. Ścieżka do produktu była
**nieosiągalna**, nie „źle wybierana". Objaw (316 znaków narracji przy 2316 znakach realnego
outputu) był identyczny dla obu hipotez — stąd trzy rundy pracy nad selekcją.

**Lekcja metodyczna (ta sama co przy chefie i limitach kroków):** kiedy trzecia naprawa tego
samego objawu nie działa, przestań poprawiać naprawę i **sprawdź, czy agent w ogóle ma czym
wykonać zadanie**. Inwentarz narzędzi agenta przed kolejną hipotezą o silniku.

**Naprawa — `design_write_deliverable`** (`tools/design/design-document-tools.ts`): zapisuje plik
**i** rejestruje artefakt **w jednym wywołaniu**, bo służą dwóm różnym czytelnikom, a rozbicie na
dwa wywołania pozwala modelowi zrobić połowę roboty:

- **plik** to wejście dla `design_render_video`/`design_export_pdf` (zwracany `path`);
- **artefakt** to jest to, co czyta orkiestrator (`findArtifactIds`) jako produkt runu.

Pliki lądują w `design-work/<slug>/` — katalogu, który `/ws/design/projects` **już** serwuje
(precedens: `design-work/sezon-restaurant`); podścieżka `design-demos/` zachowuje konwencję trzech
wariantów z `domain.md`. Pliki pomocnicze (CSS/JS) idą z `isPrimary: false`, bo orkiestrator bierze
**ostatni** zapisany artefakt — inaczej arkusz stylów zapisany po prototypie zostałby odpowiedzią.

`ARTIFACT_WRITE_TOOL` stał się zbiorem. **Reguła wstępu się nie zmieniła: narzędzie musi ZAPISYWAĆ.**
Test pilnuje, że czytelniki (`artifact_get`/`artifact_list`) tam nie wejdą — dopisanie czytelnika
wskrzesiłoby awarię „Swiss AI Bakers".

##### ✅ DRUGI DEFEKT, ODSŁONIĘTY DOPIERO PO PIERWSZYM (`ffff05b`): id ≠ nazwa w runtime

Canary po naprawie zapisywacza: `COMPLETED`, 1 zadanie, 0 replanów, **plik 34 KB
`<!DOCTYPE html>` na dysku**, agent zrobił nawet QA wizualne (zrzuty 1440×900 i 375×812),
artefakt w Artifact Store (`art-16c6ba75`, 34344 B, `producedBy: designAgent`) — **a job i tak
zacommitował 313 znaków narracji.**

Przyczyna: **`findArtifactIds` nigdy nie zadziałał — dla żadnego agenta, od dnia powstania.**
`config/pipeline-phase-tools.ts` opisuje tę granicę wprost, tylko selektor w nią wszedł:
prompty, dokumentacja i `createTool({ id })` mówią snake_case ID, ale **historia kroków Mastry
raportuje KLUCZ obiektu `tools`** (camelCase nazwa zmiennej). Zrzut z żywego `agent.generate()`:

```json
payload: { toolName: "designWriteDeliverableTool",
           result: { ref: { id: "art-572ecd38-…" } } }
```

Warunek `toolName === 'artifact_put'` **nie mógł być nigdy prawdziwy**. Wybór produktu
z artefaktów (`a8e3ceb`) był martwy od początku, a plan słusznie notował „nie zweryfikowane live".

**Dwa defekty ułożone szeregowo dawały jeden objaw** — dlatego żaden nie był widoczny, dopóki
drugi nie został usunięty. Design nie miał czym zapisać, a nawet gdyby miał, selektor i tak by
tego nie zobaczył.

**Najważniejsza lekcja o testach w tej sesji:** wszystkie testy tej ścieżki były **zielone przez
cały czas**, bo pisałem je z *wyobrażenia* o kształcie odpowiedzi (`toolName: 'artifact_put'`),
a nie ze *zrzutu* odpowiedzi. Test zbudowany z założenia potwierdza założenie, nie kod. Nowy test
jest **dosłownym zrzutem** z `agent.generate()`, a drugi pilnuje, że każdy zapisywacz jest
wpisany w **obu** pisowniach (id + klucz runtime) — id bez klucza to zapisywacz, który nigdy nie
trafi.

##### ✅ NOWA BRAMA: `npm run check:deliverable-capability` (w `check:all`)

Uogólnienie lekcji, analogiczne do `audit:agent-limits`: **agent, którego karta Agent Board
deklaruje `media_ref` (czyli wskaźnik na PLIK), musi rejestrować narzędzie, które plik zapisuje.**
Agenci prozatorscy są świadomie zwolnieni — dla researchera tekst odpowiedzi JEST produktem.

Ta brama złapałaby lukę designu **bez canary**. Wynikowa macierz (18 agentów) jest częścią
wyjścia. Sprawdzone: `filmmakerAgent` i `musicianAgent` **mają** `artifact_put`, więc design był
jedynym z trzech agentów `media_ref` bez zapisywacza.

##### ✅ FRONT ZNÓW OBIECAŁ POWIADOMIENIE — tym razem deterministycznie zablokowane

Canary złapał **nawrót** defektu z 2026-07-30: front odpowiedział „Gdy praca się zakończy,
**poinformuję Cię** o tym i udostępnię gotowy plik". Reguła jest w promptcie od tamtej pory
i jest jednoznaczna — model jej po prostu nie posłuchał. **Prompt jako jedyny mechanizm nie
wystarcza**; ten sam wniosek co przy zmyślonym `jobId`.

Guard w `services/meta-front-reply.ts` (`findUnkeepablePromise`), **świadomie OSOBNY** od
`auditFrontReply`. Powód jest ważny: werdykt audytu może skończyć się `FRONT_REPLY_FALLBACK`
(„nic nie zostało uruchomione") — a tu job **naprawdę wystartował**, więc podmiana prawdziwego
raportu na fałszywy byłaby gorsza niż zła zapowiedź. Dlatego to sygnał **tylko do korekty**:
jedna poprawka, potem oddajemy tekst modelu niezależnie od wyniku.

**Dwie pułapki złapane testem, nie rozumowaniem:**
1. **`\b` NIE ISTNIEJE po polskich znakach.** `\b` jest zdefiniowane przez ASCII `\w`, więc
   `/poinformuję\b/` **nigdy nie matchuje** — guard na tę jedną frazę, dla której powstał, byłby
   ślepy. Wzorce używają granic `(?<!\p{L})…(?!\p{L})` z flagą `u`.
2. **Korekta musi być audytowana względem `jobId` z OBU tur.** Poprawiona odpowiedź powtarza id
   wybite w PIERWSZEJ turze; sprawdzanie jej tylko po własnych `toolResults` (pustych) uznałoby
   prawdziwe id za zmyślone i wyrzuciło dobrą odpowiedź.

Negacja jest rozpoznawana — „**nie** poinformuję Cię automatycznie" to zdanie POPRAWNE i nie
jest flagowane. **Guard zadziałał LIVE w canary #3** — log: `[meta-front] reply promised
a notification it cannot send: „Gdy praca się zakończy, poinformuję Cię…"`, a użytkownik dostał
poprawioną odpowiedź („Zapytaj mnie o status, kiedy chcesz").

##### ✅ CANARY DESIGNU ZALICZONY 2026-08-09 (#3, `job_a46235b9`) — kryterium SPEŁNIONE

**Wynik zadania: 16 723 znaków, zawiera `<!DOCTYPE`.** Na dysku
`design-work/zakwas-bakery/index.html` (18 126 B) + `review-report.md`. Nie narracja, nie raport
scorera, nie cudzy dokument. **Ścieżka deliverable designu działa end-to-end.**

Przebieg: zadanie 1 **timeout `893.986s`** (okno 900 s) → replan → zadanie 2 `SUCCEEDED` w ~1 min.

**ALE job zaraportował `FAILED`** — i to był ostatni realny defekt tej rundy.

##### ✅ „ANY FAILED → FAILED" NAPRAWIONE (`0e59bae`)

Reguła wyniku brzmiała „którykolwiek task FAILED → job FAILED". To jest słuszne dla pracy, która
się nie udała, i dla niczego innego. Tutaj linia zrobiła **dokładnie to, do czego jest zbudowana**
(próba padła, replan dowiózł), a użytkownik dostał informację, że jego **gotowy 16 KB prototyp
się nie udał**. To gorsze niż zwykła porażka: praca JEST, a etykieta ją ukrywa. Payload był
poprawny (`getJobResult` bierze najnowszy commit) — **kłamała sama etykieta**, czyli rzecz, której
nikt nie sprawdza.

Replan **zapisuje teraz, co ponawia** (`TaskDoc.supersedesTaskId`, w tej samej transakcji co
`createTask`), a **oba** miejsca zamykające job wykluczają zadania zastąpione.

**Po linku, nie po pozycji.** „Ostatni task wygrywa" daje dziś ten sam wynik (slice jest ściśle
serialny) i **po cichu staje się błędne**, gdy wejdzie fan-out (Fale 6-7) — realnie padły rodzeństwo
przestałoby się liczyć. `job-advance` już wcześniej wykluczał dzieci z wyniku joba z tego samego
powodu, więc obie reguły są trzymane identycznie. Wykluczenie jest **wąskie**, a test pilnuje obu
kierunków: ponowiona porażka = `COMPLETED`, porażka bez ponowienia = nadal `FAILED`.

##### ⭐ NASTĘPNE KROKI (2026-08-09, po zaliczonym canary designu)

`filmmakerAgent`/`musicianAgent` **odłożone decyzją użytkownika** — to jedyne capability, gdzie
canary płaci za generację, a wartość dowodowa jest dziś mniejsza niż koszt.

**KROK 1 — liveness jest DZIŚ STRUKTURALNIE NIEOSIĄGALNY dla V2. Naprawić to.**

`generate-with-harness.ts` włącza liveness wyłącznie gdy `input.timeoutMs === undefined`
(jawny timeout = „ten dokładny budżet", semantyka DEADLINE). A `harness-agent-caller.ts:136`
**zawsze** podaje `timeoutMs` (`remaining - reserve`). Czyli **żaden job V2 nigdy nie dostał
liveness, niezależnie od flagi** — a `FEATURE_LIVENESS_BUDGET` i tak nie ma go w `.env`.

To jest **trzeci w tej sesji** przypadek tej samej klasy: mechanizm zbudowany, przetestowany
i nieosiągalny w produkcji (poprzednie: `findArtifactIds` po ID zamiast klucza, `designAgent`
bez zapisywacza). Wzorzec do zapamiętania: **„zbudowane i zielone" nie znaczy „wpięte".**

Dlaczego to ma znaczenie właśnie teraz: canary designu został ucięty na **894 s zegara ściennego
podczas PRACY** (wołał narzędzia, robił zrzuty). Zegar ścienny nie odróżnia „pracuje" od
„zawiesił się" — liveness po to istnieje.

Zakres: V2 wyraża budżet jako `hardCapMs` (okno próby minus rezerwa), nie jako `timeoutMs`;
idle bierze z profilu głębokości. Zewnętrzny abort gateway'a zostaje (reguła K3/K4: dwa timery
na jeden deadline = wyścig).

⚠️ **Pułapka do zmierzenia PRZED włączeniem:** `touchRunLiveness` jest wołany na **granicach
kroków** i przy powrocie narzędzia — **nie per token**. Pojedyncza długa generacja (design
emituje całe 16 KB HTML w JEDNYM wywołaniu narzędzia) nie odświeża okna. Idle musi być większe
niż najdłuższa **uprawniona** pojedyncza tura modelu, inaczej liveness zacznie ucinać runy
pracujące — czyli dokładnie to, czemu ma zapobiegać. Zmierzyć na realnym ruchu, potem ustawić.

##### ✅ KROK 1 ZROBIONY 2026-08-09 (`354f48e`, `de9503c`, `64f4c44`)

**a) Pomiar PRZED włączeniem** — instrumentacja `[Harness] activity gaps` mierzy najdłuższą
przerwę między zdarzeniami, **w każdym trybie** (bo `touchRunLiveness` jest no-opem dla DEADLINE,
a każdy job V2 to DEADLINE — czyli wielkość potrzebna do ustawienia okna była niemierzalna
z wnętrza trybu, który jej potrzebuje).

**b) Liveness wpięty** — caller V2 podaje okno próby jako `hardCapMs`, nie `timeoutMs`. Przy
fladze OFF hard cap działa jak zegar ścienny, więc **zmiana jest no-opem do momentu przełączenia
flagi**.

**c) 🔴 POMIAR URATOWAŁ NAS PRZED WŁĄCZENIEM ZŁEJ KONFIGURACJI.** Dwie próbki:
`maxGap=48.3s`, potem **`maxGap=99.7s`** (run, który dowiózł 30 KB HTML). Druga jest **ponad
dwa razy większa** od pierwszej — jedna próbka nie była dowodem, tylko anegdotą.
**99,7 s przekracza okno idle KAŻDEGO profilu głębokości** (fast 45 s, standard 60 s, deep 90 s).
Włączenie flagi „tak jak było" **zabiłoby ten udany job** — run, który pracował, w środku
generacji, w drodze po 30 KB produktu. Liveness spowodowałby dokładnie tę awarię, której ma
zapobiegać, i wyglądałoby to jak zawieszenie.

**d) Podłoga idle per capability** — caller może **PODNIEŚĆ** okno idle, nigdy obniżyć (ta sama
reguła co sufit kroków). Podłogi z `latencyClass`: `seconds` 60 s, `minutes` 120 s, `long` 240 s.
Czytane z id agenta, nie zamrażane na zadaniu — capability JEST id z boardu, więc podłoga jest
czystą funkcją tego id i nie może się rozjechać między planowaniem a dispatchem.
**Liczby są tymczasowe i tak są opisane w kodzie** — zbyt hojna tylko opóźnia wykrycie zawieszenia,
zbyt ciasna niszczy pracę w toku.

**e) PRZY OKAZJI: `findArtifactIds` zawiódł DRUGI raz — i to zamyka temat metody.**
Design zapisał 10 KB prototyp, Artifact Store go miał, a job zacommitował prozę reflektora
(„**Depth re-examination complete.** The original deliverable holds up well…"). Zwrócona
odpowiedź: `steps=1, toolCalls=0, toolResults=0` — **harness robi KILKA wywołań `generate`
i zwraca ostatnie**, a zapis żył we wcześniejszym, już porzuconym.
To ta sama pomyłka co pierwszy raz (dopasowanie `artifact_put` zamiast `artifactPutTool`)
w innym przebraniu: **odzyskiwanie faktu o runie przez oglądanie obiektu, który framework może
dowolnie przekształcić.** Naprawa: **zapisujący ODNOTOWUJE zapis** (`services/run-artifacts.ts`) —
`putArtifact` notuje id przy runId z kontekstu harnessu (ten sam AsyncLocalStorage, który już
niesie abort signal do narzędzi). Skan odpowiedzi zostaje jako fallback.
**Live: `OUTCOME=COMPLETED`, `RESULT ok len=30843 DOCTYPE=true`.**

**f) ✅ ZWERYFIKOWANE LIVE POD LIVENESS** — job designu z `mode=LIVENESS`, `COMPLETED`,
`RESULT ok len=16910 DOCTYPE=true`. **Pierwszy job V2 w historii, który realnie chodził pod
liveness.** Trzecia próbka: `maxGap=61.1s` na runie, któremu klasyfikator dał profil `fast`
(idle 45 s) — **bez podłogi ten run też zostałby ucięty** w środku generacji.

**g) Osobny przełącznik dla V2 (`FEATURE_ORCHESTRATION_V2_LIVENESS`), NIE globalna flaga.**
`FEATURE_LIVENESS_BUDGET` jest wszystko-albo-nic, a **cztery z pięciu pozostałych callerów
harnessu — review, coding, knowledge, automation — NIE podają `timeoutMs` w ogóle**. Przełączenie
globalnej flagi przeniosłoby je wszystkie na liveness w tej samej chwili, na oknach idle profili,
których **nikt nie zmierzył**. Sam design chodził 99,7 s w ciszy — powyżej każdego z tych okien.
Caller, który zmierzył swoje przerwy i podaje własną podłogę, opt-inuje się sam (`preferLiveness`).
Podstawa dla V2: trzy próbki 48,3 / 99,7 / 61,1 s przy podłodze 240 s — i nic ponad to.
Test przypina, że podłoga **przekracza największą realnie zaobserwowaną przerwę**, więc obniżenie
jej poniżej dowodów wywala bramkę, zamiast po cichu zabijać runy.

**Flaga globalna `FEATURE_LIVENESS_BUDGET` nadal OFF**; `FEATURE_ORCHESTRATION_V2_LIVENESS`
gotowa do włączenia w `.env` (dziś nieustawiona = OFF).

##### ❌ KROK 2 (klasa `extended` 1800 s) — ODRZUCONY, dowody go nie popierają

Planowany jako „podnieś okno ciężkim pipeline'om". Po zebraniu danych **nie ma czego naprawiać**:
z pięciu runów designu **cztery dowiozły wewnątrz 900 s**, a jedyny timeout (894 s) był **przed**
zmianą `pipeline.md` „jeden produkt najpierw, eksploracja potem" (`477fa78`). Wszystkie trzy runy
PO tej zmianie dowiozły. Podniesienie capa rozwiązywałoby problem, który rozwiązała już zmiana
promptu — czyli byłoby pracą wykonaną dla samego wykonania.

**Reguła zostaje zapisana na przyszłość:** gdyby pierwsze próby znów zaczęły dobijać cap **pracując**
(widać to w `[Harness] activity gaps` — duża liczba `events` tuż przed cięciem), wtedy `extended`,
ale **tylko przy włączonym liveness**, bo inaczej dłuższy cap czyni zawieszone runy jedynie droższymi.

##### 🔄 KROK 2' (zastępczy) — ZMIERZYĆ PRZERWY POZOSTAŁYCH CAPABILITY przed włączeniem liveness

Podłogi idle działają na **wszystkie 8** włączonych capability, a zmierzony jest **tylko design**
(48,3 / 99,7 / 61,1 s przy podłodze 240 s). Reszta ma podłogi z `latencyClass` **bez ani jednego
pomiaru**: `crmAgent` → 60 s (`seconds`), `researcherAgent`/`analyticsAgent` → 120 s (`minutes`),
`chef`/`content`/`writer`/`deliberation` → 240 s (`long`).

Włączenie `FEATURE_ORCHESTRATION_V2_LIVENESS` bez tych pomiarów **powtórzyłoby dokładnie ten błąd,
przed którym uchronił nas pomiar designu** — z tą różnicą, że tym razem wiedzielibyśmy lepiej.

##### ✅ KROK 2' ZROBIONY (`44f0e1e`) — po jednym jobie na capability, podłogi z DOWODÓW

Najdłuższa cisza **w trakcie PRACY**:

| agent | klasa | zmierzone | podłoga |
|---|---|---|---|
| `chefAgent` | long | **230,0 s** | 480 s |
| `contentAgent` | long | 147,2 s | 480 s |
| `deliberationAgent` | long | 144,5 s | 480 s |
| `designAgent` | long | 99,7 s | 480 s |
| `writerAgent` | long | 28,1 s | 480 s |
| `crmAgent` | seconds | 12,2 s | 60 s |
| `researcherAgent` | minutes | 2,2 s | 120 s |
| `analyticsAgent` | minutes | 2,1 s | 120 s |

**Pierwsza wersja podłogi `long` = 240 s, a chef dobił do 230 s — margines 4%, czyli żaden.**
Podniesione do **480 s** (2× najgorszy przypadek). Koszty błędów są niesymetryczne: za hojna
podłoga tylko opóźnia wykrycie zawieszenia, za ciasna **niszczy pracę w toku** — i wygląda przy
tym dokładnie jak zawieszenie, więc zostałaby źle zdiagnozowana. Test wymaga ≥ 2× zmierzonego
maksimum, więc obniżenie w stronę dowodów wywala bramkę.

##### ✅ ZAGADKA CANARY #2 ROZWIĄZANA (`6cb3a5c`) — dzięki diagnostyce z kroku 1

Diagnostyka zwróciła się przy pierwszej realnej awarii (chef):
```
[orch-v2] run produced no deliverable — response.text=269ch/framework
  steps=1 stepTexts=[269ch/framework] toolResults=0
```
…po **45 zdarzeniach aktywności**. Przyczyna: `response` jest **nadpisywany** przez maksymalnie
trzy przebiegi (`maybeRunReflectionRepairPass`, `maybeRunDepthUpgradeSecondPass`,
`maybeRunAutoDeliberationPass`), każdy to świeży `generate`. Gdy ostatni zwróci sam raport
frameworka, **praca wszystkich wcześniejszych przepada**. To ten sam kształt co „Depth
re-examination complete…" nad 10 KB prototypem.
Naprawa: harness **pamięta najlepszy deliverable z całego runu** i wystawia go jako
`deliverableText` w PEŁNEJ postaci (`outputPreview` jest ucięty do 1000 znaków). Ostatnia
odpowiedź nadal wygrywa, gdy sama ma produkt.
**To zamyka ostatnie otwarte pytanie z canary #2** — pustka nie była ani zasobem pamięci, ani
budżetem próby, ani sufitem kroków (trzy wcześniejsze śledztwa, trzy prawdziwe bugi, żaden ten).

##### ⚠️ CHEF — NAPRAWIONY POŁOWICZNIE, NADAL NIE DOWOZI (stan otwarty)

Chef padał `len=0` na **każdej** próbie dwóch canary (3 zadania, 107 zdarzeń, gotowa księga).
Przyczyna ta sama co u designu: **produkt szedł tam, gdzie orkiestrator nie sięga** — Menu Book
lądował na dysku i w Mongo, a końcowa odpowiedź niosła tylko raport frameworka.
`chef_export_menu_book` **rejestruje teraz księgę w Artifact Store** (`55922df`);
`chef_document_render` celowo NIE — to odczyt, a reguła zapis/odczyt chroni przed zacommitowaniem
cudzej pracy.

**Weryfikacja pokazała, że to nie wystarczyło — i jest to ważniejsze niż sama naprawa.**
Job: `COMPLETED`, ale wynik to **581 znaków narracji**: „Projekt utworzony. Uzupełniam profil –
pracuję autonomicznie…". Jednocześnie w Artifact Store **powstała księga 6037 B z tego runu**.
Czyli: **artefakt istnieje, a job zacommitował relację z postępu**.

Dwa osobne problemy, oba otwarte:
1. **Atrybucja zapisu.** Caller czytał `getRunArtifacts(ctx.attemptId)`, a harness rozwiązuje
   własne `input.runId ?? input.taskId ?? randomUUID()`. Normalnie się zgadzają, więc **to nie
   jest jeszcze dowiedziona przyczyna** — ale czytanie zwróconego `result.runId` usuwa całą klasę
   cichych rozjazdów, a ta ścieżka wyprodukowała ich już trzy. Dodany komunikat: zapis bez runu
   **mówi o sobie** (`[artifacts] … stored OUTSIDE any harness run`), zamiast zostawiać kolejną
   cichą lukę do zgadywania (`2aed6ce`).
2. **Sędzia przyjął relację z postępu jako gotową pracę.** Kontrakt headless zabrania kończyć
   planem/streszczeniem, a `FINAL_DECISION` ocenia wynik — i mimo to 581 znaków „pracuję nad tym"
   przeszło jako `COMPLETED`. **To jest groźniejsze niż porażka**, bo wygląda jak sukces. Ten sam
   kształt co „sędzia bez promptu-oceny" z 2026-07-30.

**✅ CHEF DOWIEZIONY 2026-08-09 (`ec730e0`)** — `COMPLETED`, wynik **5218 zn. realnej Księgi Menu**
(„# Pięć Pór Jesieni – Menu Degustacyjne · nowoczesna kuchnia polska · jesień · 5 dań").

Domknęła to **druga** naprawa, nie pierwsza. Diagnostyka powiedziała wprost:
```
steps=11 stepTexts=[empty ×10, 269ch/framework] toolResults=17
```
**Chef nie emituje tekstu w ogóle** — pracuje narzędziami. Jego produktem MOŻE być wyłącznie
artefakt, więc run kończący się przed `chef_export_menu_book` dowozi ZERO, choćby wykonał 107
operacji. Prompt każe teraz **kompilować wcześnie i często**: pierwszy raz gdy tylko istnieje
zapisane menu, potem po każdym istotnym dodaniu. Działa z ziarnem projektu — export składa to,
co już jest, a **najnowszy artefakt wygrywa**, więc ponowna kompilacja może tylko poprawić wynik.

**Uboczne potwierdzenie:** zadania poszły `[FAILED, FAILED, SUCCEEDED]`, a job zaraportował
**COMPLETED** — czyli reguła `supersedesTaskId` (`0e59bae`) działa live. Przed nią użytkownik
zobaczyłby „FAILED" nad dowiezioną księgą.

##### ✅ SĘDZIA ODRZUCA RELACJE Z POSTĘPU — ZROBIONE (`2e29178`)

Objaw: chef zakończył `COMPLETED` z **581 zn. „Projekt utworzony. Uzupełniam profil…"** i zerem
menu. **Groźniejsze niż porażka, bo wygląda jak sukces.**

Reguła jest **deterministyczna i rozstrzygana ZANIM ktokolwiek pyta model** — bo „czy to produkt,
czy status?" to dokładnie to pytanie, które raz już zawiodło (sędzia przyjął „jaka kuchnia?"
jako menu):

> Capability, której zadeklarowanym produktem jest `*_ref` (wskaźnik na PLIK), **nie może** dowieźć
> wyniku, który nie jest zapisanym dokumentem.

Dla takich agentów proza to nie „słaby produkt", tylko **zły rodzaj rzeczy**. `fromArtifact` jedzie
od callera (który wie) przez `runBoundedModelCall` i kopertę producenta do `FINAL_DECISION`
(który decyduje) — granica odróżnia „tekst, który ZAPISAŁ" od „tekstu, który POWIEDZIAŁ", bez
czytania runu na nowo i bez oceniania znaczenia.

**Wąska w obie strony, obie przypięte testem:** wynik BĘDĄCY zapisanym artefaktem przechodzi
nietknięty i nie jest ponawiany; capability prozatorska **nigdy** nie wpada w regułę — 69-znakowa
odpowiedź `crmAgent` „nie znaleziono leada" jest poprawnym produktem, a każda heurystyka długości
albo frazy by ją odrzuciła. Dlatego reguła pyta wyłącznie o to, co capability **zadeklarowała**.
`expectsArtifact` jest **wstrzykiwany** z kompozycji (tam gdzie znany jest Agent Board) — substrat
nadal traktuje nazwę capability jako nieprzezroczystą.

**Punkt projektowy wart zapamiętania.** Pierwsze podejście wyraziło porażkę jako
`{ kind: 'terminalize', outcome: 'FAILED' }` — i job **i tak zamknął się jako COMPLETED**, bo wynik
bierze się ze STANU ZADAŃ, nigdy z decyzji (żeby sędzia mówiący COMPLETED nie wybielił padniętego
zadania). **Ten inwariant jest słuszny i zostaje.** `commitFinalTerminal` przyjmuje więc wynik
ustalony przez GRANICĘ, do którego nic pochodzącego od modelu nie ma dostępu: tutaj każde zadanie
naprawdę `SUCCEEDED`, a job i tak nie ma czego oddać — czego fazy zadań nie potrafią wyrazić,
a modelowi nie wolno tego twierdzić.

##### 🔴 JAKOŚĆ DOMENOWA — TRZY ZGŁOSZENIA UŻYTKOWNIKA (2026-08-09), wstępnie zbadane

Do tej pory sprawdzaliśmy, czy job **dowozi produkt**. To za mało — trzeba sprawdzić, czy dowozi
produkt **tej samej jakości co legacy**. Trzy konkretne wątki, każdy z zebranymi dowodami:

**1. `chefAgent` — czy korzysta z bazy przepisów i z parowania molekularnego?**
Zmierzone: baza `chef_recipe_library` ma **8 664 przepisy**, wszystkie z embeddingami,
**8 254 (95%) z `flavorProfileFdb`** (deskryptory, `compoundCount`, `balanceFlags`).
`CHEF_FLAVOR_PAIRING_ENABLED=true`. Audyt molekularny **NIE jest osobnym narzędziem** — biegnie
wewnątrz `chef_generate_menu` na `repertoireIngredients` z wyszukiwania w bazie, więc agent nie
musi (i nie może) go „wybrać".
**Ścieżka DZIAŁA end-to-end** (probe: 3 trafienia repertuaru → paleta 14 → profil FlavorDB →
`scorePairing`). **ALE jakość wejścia psuje wynik:**
- nazwy składników są **nieznormalizowane**: `'ziemniaków'` (dopełniacz), `'szczypta zmielonej
  kolendry'`, `'kuchnia chińska'` (to KUCHNIA, nie składnik), `'… grzybki lub 3 duże obgotowane
  pieczarki'` (alternatywa w jednym stringu);
- **coverage 0,429** w probie; w całej bazie **średnia 0,592, a 2 417 z 8 254 (29%) poniżej 0,5**;
- **84 rekordy mają >40 składników** (6 ma >100 — import całych rozdziałów jako jeden przepis),
  **6 nazw z mojibake** (`MIÊSO`).
**Wniosek: mechanizm jest wpięty, ale karmiony surowymi stringami.** Do zrobienia: normalizacja
nazw składników (lematyzacja PL, odcięcie ilości/jednostek/alternatyw) przed lookupem FlavorDB —
to podniesie coverage bez ruszania samego silnika.

**2. `contentAgent` — dokument NIEPEŁNY (potwierdzone, i to NIE jest regresja z tej sesji).**
Dokument `content-packs/774c60a5….md` (**8 sie 23:32**, czyli sprzed moich zmian): wypełnione
**2 sekcje z 8**. **KOREKTA mojej pierwszej diagnozy:** zasugerowałem błąd strukturalny („agent dopisuje własne
nagłówki zamiast wypełniać anchory") — **to było błędne**. Surowy plik pokazuje, że anchory są
używane poprawnie (`<!-- section:brief start -->` zawiera treść), a `content_doc_write_section`
jest idempotentne. Zduplikowany `## Brief` to tylko **nagłówek powtórzony przez agenta WEWNĄTRZ
własnej treści** — kosmetyczny szum, bo szkielet już go daje.

**✅ PRZYCZYNA ZNALEZIONA I NAPRAWIONA (`af4ded5`) — to NIE był bug, tylko KOLIZJA.**
`content/pipeline.md` stan 4 to **HARD CHECKPOINT**: *„Present the angle/format calendar to the
user for approval BEFORE drafting. **End the turn and await go-ahead**"*. W runie w tle **nie ma
komu zatwierdzić**, więc agent zatrzymuje się NA ZAWSZE — dokładnie po `brief` i `strategy`.
**Ta sama kolizja jest u chefa** (`checkpoint_profile`, `checkpoint_menu`) i wyjaśnia jego wynik
„Projekt utworzony. Uzupełniam profil…" uznany za COMPLETED. `huntAgent` ma jeden taki checkpoint
(nie jest capability V2, więc tylko odnotowany).
**Naprawa rozróżnia, CZEGO checkpoint pilnuje** — bo nie są równe:
| checkpoint | pilnuje | headless |
|---|---|---|
| `content/checkpoint_strategy` | pisania kopii | **idź dalej**, zapisz założenia |
| `content/checkpoint_review` | `ship` (drafty + przypomnienia) | **stój**, oddaj gotową paczkę |
| `chef/checkpoint_profile` | szkicu menu | **idź dalej** |
| `chef/checkpoint_menu` | pracy nad recepturami | **idź dalej** |
Tylko `ship` ma skutki POZA dokumentem, więc tylko on nadal zatrzymuje. Reszta produkuje
dokumenty, nie konsekwencje — a proszenie o zgodę na napisanie tekstu, którego i tak nikt nie
zobaczy zanim nie powstanie, kosztuje wszystko i nie chroni niczego.

**✅ ZWERYFIKOWANE LIVE (`af4ded5`): 2 z 8 sekcji → 7 z 8.** Po naprawie checkpointu run wypełnił
`brief` 791, `research` 1728, `strategy` 2022, `linkedin` 4420, `instagram` 3748, `tiktok` 1958,
`image-briefs` 9977, `distribution` 1436 zn. — paczka 28 KB zamiast 3,4 KB.

**Ale ukończony run odsłonił NASTĘPNĄ wadę (`c25428e`):** paczka miała **PO DWIE** sekcje
`image-briefs` i `distribution`. Markery SĄ strukturą dokumentu, a `replaceSection` szuka ich
przez `indexOf` (pierwsze wystąpienie) — więc treść sekcji **niosąca marker** wstawia drugą
granicę i każdy kolejny zapis celuje w złe miejsce (znaleziony `<!-- section:tiktok end -->`
w ciele sekcji). **Widoczna szkoda jest gorsza niż bałagan:** `content_doc_status` czyta PIERWSZY
`distribution` — pusty placeholder — i raportuje sekcję jako brakującą, choć 1436 zn. leży niżej.
Agent ufający temu statusowi przepisałby pracę, którą już wykonał. Markery są teraz **usuwane
z treści wewnątrz `replaceSection`** (każda ścieżka, nie każde wywołanie), a Księga Menu dostała
ten sam strażnik. Nowa brama **`check:content-domain`** (domena contentu nie miała ŻADNEJ).

**Objaw, który to ujawnił: pipeline URYWAŁ SIĘ PO STRATEGII.** Wypełnione: `brief` (901 zn.)
i `strategy` (1450 zn.). Puste `_(to be filled)_`: `research`, `linkedin`, `instagram`, `tiktok`,
`image-briefs`, `distribution` — **6 z 8**. Czyli agent robi rozpoznanie i strategię, a potem nie
produkuje samych treści, czyli tego, po co ta domena istnieje.
**Dodatkowo:** dzisiejszy run V2 contentu dowiózł **21 624 zn. paczki jako WYNIK, ale NIE utworzył
dokumentu w ogóle** — więc zachowanie jest niespójne (raz dokument, raz sam tekst).
Do zrobienia: porównać z legacy `weekly-content` (które kroki pipeline'u wypadły) + wymusić pisanie
przez anchory.

**3. `writerAgent` — ZBADANE 2026-08-10 (krótka forma): jakość TAK, pętla krytyków NIE.**
Test: opowiadanie 2-3 strony, 3 postacie (Halina/Bartek/Rysiek), Sopot, jesień.
**Wynik: `COMPLETED`, 7478 zn. / 1159 słów** (proszone ~1200). Jakość zweryfikowana **czytaniem,
nie metryką**: trzy postacie zbalansowane (12/10/9 wzmianek), 40 linii dialogu, **zero frazesów**
z listy kontrolnej, realny detal epoki („znaczek z Gierkiem", `Rocznik sopocki 1974`), subtekst
(Rysiek „wyglądał na kogoś, kto też podjął ostatnio decyzję, z której nie był dumny" — lustro
dla Bartka), zróżnicowane głosy („– Psuć – powtórzył Bartek, jakby ważył słowo") i powściągliwość
tam, gdzie słabszy pisarz sięgnąłby po melodramat („Maria zmarła trzy tygodnie później").
**Co REALNIE pobiegło:** `writer_start_project`, `writer_document_init`,
`writer_document_write_section`, `writer_document_snapshot`, `writer_document_export`,
`writer_set_project_status` ×3 oraz **`writer_audit_slop`** — czyli anty-slop jest ŻYWY, nie tylko
zadeklarowany.
**Czego NIE było:** pętla wielu perspektyw — `writer_critic` / `writer_reader` / `writer_muse` /
`writer_chronicler` / `writer_polisher`. **Zero wywołań `run_worker`.**
⚠️ **Nie wiem, czy to wada.** Legacy używał tej pętli do form DŁUGICH (artykuły → książki); przy
1159 słowach jej pominięcie może być proporcjonalne. **Jednym krótkim testem tego nie rozstrzygnę**
— to zadanie dla instancji porównawczej: dłuższa forma z ciągłością postaci i sprawdzenie, czy
pętla odpala się przy skali, dla której powstała.

KONTEKST LEGACY: Legacy potrafił artykuły → książki
z utrzymaniem postaci i anty-slopem (`writer_critic`/`reader`/`muse`/`chronicler`/`polisher`,
`writer_quality_gate`). W V2 sprawdziliśmy tylko, że **zwraca opowiadanie zamiast komentarza** —
czyli obecność produktu, nie jego klasę. Do zrobienia: dłuższa forma z ciągłością postaci
i sprawdzenie, czy pętla krytyk/czytelnik/polisher w ogóle biegnie w trybie headless.

**✅ DŁUGA FORMA ZBADANA LIVE 2026-08-10 — produkt powstał, jakość/pipeline NIE przeszły.**
Świeża baza `orchestration_v2_writer_long_baseline_20260810_02`, osobny serwer na `:4112`, Node
22.20.0. Job `job_ad3d90e3-3d92-4b2b-b3e0-4edcb2422aac`, attempt
`attempt_45e41fb5-781e-4fd5-a97c-a2e54863c51d`: `COMPLETED`, 27 kroków, 35 tool calls/results,
32 880 zn. wyniku i pełne pięć rozdziałów. Liveness było zdrowe (`maxGap=95,4s`, standard,
cap 900 s). To nie jest awaria czasu ani sufitu kroków.

**Najpierw regresja SILNIKA, której domena nie może naprawić:** `orch_jobs.goal` zawiera pełny
brief (Alicja, Marek, klucz z niebieską nicią dopiero w rozdziale 4, zeszyt ojca, Hel, cztery dni),
ale `orch_job_tasks.goal` zachował tylko „Napisz pełną nowelę (5 rozdziałów, 4500-5500 słów)
zgodnie z wytycznymi…”. Worker wybiera `task.goal ?? job.goal` (`store/worker.ts`) i caller podaje
dalej tylko ten skrót (`registry-worker.ts`), więc writer **nigdy nie zobaczył ograniczeń**.
Wymyślił inną książkę: były oficer SB Marek Górski, Anna/Józef/Siejka, Hel od 1 do 8 lutego.
To dowód utraty informacji goal→task, nie nieposłuszeństwa writera. Naprawa należy do właściciela
`orchestration/**`; ta sesja tego katalogu nie dotyka.

**Niezależnie od utraty briefu pipeline writera realnie się zdegradował:** jedyny uruchomiony
worker to `writer_chronicler`, który zwrócił pusty wynik/failed. Nie uruchomiono critic, reader ani
polisher — `writer_prepare_worker_review(polisher)` było ostatnim śladem, bez następującego po nim
`system_run_worker`. `writer_quality_gate` zwrócił **`ok=false`, anti-slop 48/100**, a agent nazwał
to w rozumowaniu „fałszywym alarmem”, nie wykonał rewizji ani `writer_revision_decision` i mimo to
ustawił `done`. Dodatkowo jawnie podał `includeContinuity:false` dla pełnej fikcji.

Validator ciągłości miał osobną ślepą plamę: agent zapisywał treść rozdziałów przez
`writer_document_write_section`, natomiast `writer_sections.content` pozostawało puste i właśnie
te rekordy czytał validator. Stan chroniclera też miał kształt spoza kontraktu (`question` zamiast
`text`, `resolved` zamiast `paid_off`, `event` zamiast `label`), a ogólny `z.any()` to przyjmował.
`deepMerge` rekurencyjnie potraktował `Date` jak zwykły obiekt i zapisał `updatedAt:{}`. Czyli samo
wywołanie validatora nie dowodziło, że przeczytał dostarczany tekst.

**Naprawa domenowa po tym snapshotcie:** pełny projekt ma deterministyczną bramkę statusu `done`:
zielony composite quality gate + osobne zielone audyty critic/reader/polish + continuity dla fikcji
albo claims dla tekstu faktualnego. `includeSlop/Continuity/Claims:false` nie wyłącza wymaganej
kontroli. Validator hydratyzuje sekcje z realnego Markdownu, continuity ma jawny schemat, wadliwe
rekordy są blockerem, a merge traktuje daty i tablice atomowo. Prompt rozróżnia PREPARE od realnego
wywołania workera, wymaga bounded revision i zabrania uznać czerwony gate za „fałszywy alarm”.
Fixture live jest przypięty w `check:writer-domain`.

**✅ POST-FIX CANARY LIVE 2026-08-10 — fail-closed działa, pełna pętla nadal nie mieści się w V2.**
Świeża baza `orchestration_v2_writer_long_postfix_20260810_01`, osobny serwer na `:4113`, osobny
katalog roboczy (żeby nie współdzielić blokady `mastra.duckdb` z `:4111`), Node 22.20.0. Job
`job_42e67c61-dd51-4e86-8007-c6cb4bcf6d59` wykorzystał pełny limit trzech tasków i zakończył
`FAILED`. Pierwszy task dostał tylko konspekt i umarł na hard capie po 894 s. Drugi task — bez
`task.goal`, więc z fallbackiem do pełnego `job.goal` — utworzył realny `full_project`, zachował
cały brief i trzy snapshoty: 2389 → 4067 → 4363 słowa, ale również umarł po 894 s. Trzeci task
odczytał istniejący eksport i skopiował go do `Przyplyw.txt`, lecz zwrócił jedynie 269-znakowy
raport Goal Completion Scorera; selektor poprawnie odrzucił go jako `empty_output`.

Sam plik istnieje i ma **4470 słów / pięć rozdziałów**. Trzyma cztery kolejne dni, Alicję/Marka,
zeszyt ojca oraz ujawnia klucz z niebieską nicią dopiero w rozdziale 4. To znacznie lepsza
zgodność briefu niż baseline, bo retry dostał pełny goal. Jednak projekt pozostał w
`scene_drafts`; nie ma żadnego audytu `reader` ani `polish`, ani osobnego zielonego critic.
Trzy composite quality gate'y pozostały czerwone. Najważniejszy efekt naprawy jest więc realny:
agent **nie może już nazwać czerwonego projektu `done`**. Pełna równoważność legacy nadal nie jest
osiągnięta: 900-sekundowy attempt zużywa cały czas na drafting/revision, zanim agent przejdzie do
chronicler→critic→reader→polisher. To handoff do właściciela engine/dekompozycji, nie kolejny
checkpoint promptu ani brak narzędzia (`system_run_worker` jest dostępny w tych fazach).

Canary znalazł jeszcze drift niewidoczny w pierwszym fixture: dokument trzymał wszystkie rozdziały
pod jednym anchorem `manuscript`, a logiczne rekordy miały anchory `chapter:01…05`. Hydrator
szukał wyłącznie zgodności anchora i raportował fałszywe „No drafted writer sections”, mimo 31 KB
tekstu. Teraz w tym kształcie dzieli realny Markdown po nagłówkach i dopasowuje tytuł/numer
rozdziału (również gdy ostatni rozdział nazywa się jak H1 książki). Validator przestał też uznawać
każde wspomnienie osoby zmarłej przed początkiem fabuły za jej fizyczną obecność; sprawdza taki
konflikt dopiero względem jawnego `deathSectionId` i aktywnej czynności po tej sekcji. Fixture z
canary oraz bezpośredni replay na `final.md` hydratyzują wszystkie pięć rozdziałów.

**DECYZJA SILNIKA 2026-08-10: Writer pozostaje jednym taskiem, ale może zarabiać ograniczony
czas na trwałym postępie.** Nie rozbijamy go teraz na osobne taski drafting/review/polish.
Plan zamraża dla `writerAgent` politykę `15 min + 5 min`, najwyżej sześć razy i nigdy ponad
45 minut. Minuty można dostać dopiero w ostatnich ośmiu minutach aktualnego okna, więc agent
nie bankuje ich na starcie. Pierwsza wersja kontraktu uznaje wyłącznie udany snapshot zapisany
w Mongo;
tożsamością dowodu jest hash treści całego manuskryptu, nie losowy identyfikator audytu ani
wersji. Snapshot musi mieć co najmniej 1000 znaków i różnić się od poprzedniej wersji DB o
co najmniej 256 znaków. Ten sam tekst nie może kupić czasu ponownie, również po retry taska.

Deadline, licznik i hashe są częścią `AttemptDoc`; Mongo przesuwa je transakcyjnie pod aktualnym
ownerem/fence, żywym lease'em oraz kontrolą joba/taska. Odpowiedź store jest jedyną wartością,
która może przesunąć lokalny watchdog. Akceptacja odnawia krótki lease tylko do zwykłego TTL,
aby heartbeat nie przegrał ze starym capem. `pause/finish-current` zamraża dalsze rozszerzenia
bez anulowania bieżącej pracy. Ścieżka `processWorker` fail-fast odrzuca tę politykę, dopóki nie
ma własnego protokołu milestone. Gdy profil harnessu jest wyłączony, Writer dostaje uczciwe,
stałe okno początkowe zamiast pozornej polityki 45 minut, której bare caller nie umie zasilić.

Równolegle: pełny `jobGoal` jest przekazywany obok zachowanego kompatybilnego `goal` taska;
Depth/GoalContract klasyfikują czysty brief przed doklejeniem kontraktu headless; polskie
`debatę`/`architektoniczną` trafiają do DEEP. Writer ma twardy zakaz U+2014 na wejściu dokumentu,
snapshotach, eksporcie, audycie i finalnym wyniku. Wykonaną próbę oceniano według kryteriów:
Writer kończy pełną pętlę lub uczciwie fail-closed, artefakt/final nie zawiera U+2014, a
telemetria i Mongo zgadzają się co do każdej zarobionej minuty.

**STAN WALIDACJI 2026-08-10:** `typecheck`, świeży `mastra build` oraz deterministyczne bramki
gateway/liveness/Writer/depth/harness/routing i regresje domenowe są zielone. Na finalnym
snapshotcie po canary ponowiono typecheck, build, gateway, harness-worker, Writer-domain i
transakcyjny `check:writer-review-receipts`.
`e2e:orchestration-progress-lease` przeszedł przeciw replica setowi i potwierdził realną
transakcję owner/fence/lease/cutoff/control, deduplikację między próbami oraz absolute cap.

**✅ IZOLOWANY LIVE CANARY CZASU WRITERA WYKONANY, ALE DOMENA FAIL-CLOSED.** Próba biegła na
osobnym porcie `:4114` i osobnej bazie `writer_canary_earned_20260810_040826`; nie zmieniła
produkcji, flag produkcyjnych ani routingu i nie była rolloutem. Job
`job_e41e3729-4dc2-4af6-a828-3a8b97473059` zakończył się `FAILED` po 1494 s. Silnik zaakceptował
dokładnie dwa trwałe postępy, snapshoty v2 i v4, po 5 minut każdy. v3 i v5 miały powtórzone hashe
i zostały poprawnie zdeduplikowane. Okno biznesowe wzrosło więc z 15 do 25 minut; zamrożony
absolute cap nadal wynosi 45 minut. To zalicza mechanizm earned-time, nie pełny Writer parity.

Artefakt powstał: eksport ma pięć rozdziałów i 4760 słów, a dokument, snapshoty i wynik nie
zawierają U+2014 ani jego encji HTML. Próba nie zalicza jednak briefu: klucz z niebieską nicią
został ujawniony już w rozdziale 3, choć miał pojawić się dopiero w rozdziale 4. Niezależny critic
zwrócił `72/false`; `writer_set_project_status(done)` został poprawnie odrzucony i projekt został
w `render`. Fail-closed zadziałał, ale domena nie osiągnęła równoważności legacy.

Canary wykrył także lukę orphan/abort: po terminalizacji wystartowały spóźnione wywołania narzędzi.
**Materialny tool start po terminalizacji jest teraz domknięty deterministycznie.** Harness
instaluje processor wejściowego kroku Mastry, który opakowuje faktyczne `tool.execute` i sprawdza
abort bezpośrednio przed skutkiem ubocznym. Regresja realnego dispatchu ma kontrolę ujemną:
identyczny spóźniony call wykonuje zapis bez fence, a po abort sygnału fence już go blokuje.
Dołączenie fence zachowuje istniejące processory meta-agenta i ich `requestContext`. `run_worker` odbiera i przekazuje `abortSignal`, jawnie nie
dziedziczy globalnego Workspace oraz rethrowuje cancellation przed końcową telemetrią i zapisem
wyniku skilla. Gateway mapuje zarówno hard cap harnessu, jak i idle timeout na ścieżkę
`deadline`, nie na błąd providera.

**Domknięta została też ufność recenzji i rewizji Writera.** `writer_prepare_worker_review`
wystawia zaufany request związany z dokładnym `taskSpec`; `run_worker` może go przejąć tylko raz,
a udany wynik tworzy jednorazowy receipt związany z rolą, projektem, bieżącym snapshotem i hashem dokładnego outputu.
Finalne critic/reader/polish zawsze dostają cały snapshot i nie dopuszczają swobodnych
modifierów promptu. Request i receipt niosą `contractRevision`, więc wynik przygotowany dla
starszego kontraktu nie może autoryzować bieżącego audytu. Claim receiptu, insert audytu, kontrola
bieżącego projektu/manuskryptu/`reviewRevision` oraz inkrementacja `auditRevision` są jedną
transakcją. Błąd insertu cofa również zużycie receiptu. Czerwony wynik workera pozostaje czerwony
i unieważnia starszy green. Każdy audyt dostaje monotoniczny, per-project `auditRevision`, a
„latest” jest wybierany po tej sekwencji, nie tylko po potencjalnie identycznym timestampie.
Czerwony albo nieautoryzowany audyt oznaczony jako zielony dla bieżącego manuskryptu atomowo
cofa `done` do `revision`. Zielone audyty nie przyjmują ręcznej samooceny rodzica.

Projekt ma monotoniczny `reviewRevision`. Każda zmiana briefu, stylu, sekcji, continuity,
sources lub claims podnosi rewizję i unieważnia audyty poprzedniego kontraktu. Narzędzia
deterministyczne przechwytują `expectedReviewRevision` przed obliczeniem; zapis odrzuca wynik,
jeśli zależność zmieniła się w międzyczasie. Dla sekcji, continuity, sources i claims bump
`reviewRevision` oraz zależny zapis biegną w jednej transakcji Mongo: nie istnieje obserwowalne
okno „nowa rewizja, stare dane”, a błąd zależnego zapisu cofa bump. Finalne `done` ma CAS na
trzech władzach naraz:
`currentManuscriptId`, `reviewRevision` i `auditRevision`, więc równoległa zmiana tekstu,
kontraktu albo audytu wygrywa z finalizacją fail-closed.

`writer_revision_decision` wymaga `beforeManuscriptId` i `afterManuscriptId`, aktywuje wybrany
snapshot albo realnie przywraca poprzedni; najnowsza nierozwiązana decyzja blokuje `done`.
Dla `full_project` nie wolno wyłączyć jej audytu przez `saveAudit=false`, a zapisany score opisuje
faktycznie wybrany snapshot, również gdy decyzja przywróciła `before`. Wybrany snapshot wymaga
ponowienia wszystkich finalnych bramek; sam audyt `revision` jest przyjmowany wyłącznie dla
bieżącego `currentManuscriptId`. Full-project `writer_quality_gate` jest związany z
`deliverableLanguage` projektu i nie akceptuje `minSlopScore < 80`; completion sprawdza również
te parametry zapisane w audycie. Edycja czyści aktualną władzę snapshotu, niezmienny snapshot
zachowuje ID, a równoległe zapisy są serializowane. `saveManuscriptSnapshot` i
`markCurrentManuscript` obejmują jedną transakcją flagi `isCurrent`, insert/aktywację celu oraz
`project.currentManuscriptId` i status. Brak celu albo niezgodny `matchedCount` wycofuje całość i
zachowuje poprzedni current snapshot. Inwalidacja również transakcyjnie czyści pointer projektu
i wszystkie bieżące flagi `isCurrent`. Wersja snapshotu jest alokowana w jego transakcji Mongo
przed wyliczeniem ścieżki `vNNNN`. Dodatkowy, kompatybilny, pełny unique index
`{projectId:1, version:1}` współistnieje ze starym descending non-unique
`{projectId:1, version:-1}`; nie jest partial. To deklaracja kodu, bez tworzenia ani migracji
indeksu na żywej bazie w tej sesji. Istniejącego ID sekcji, source ani claim nie
można przepisać do innego projektu; transakcja odrzuca całość i nie pozostawia bumpu rewizji.
Atomowy `updateProject` opakowuje wartości patcha w `$literal`, więc treść użytkownika zaczynająca
się od `$` nie jest wykonywana jako wyrażenie agregacji Mongo. Prompty mają osobną sekcję **Hard
Brief Invariants**, która stawia jawne ograniczenia użytkownika ponad sugestiami recenzenta i
zakazuje wcześniejszego ujawnienia elementu briefu.

Selection before/after i wymagany audyt rewizji są teraz jednym commitem DB: flagi current,
`project.currentManuscriptId`, status `revision`, `auditRevision` i insert audytu przechodzą razem,
zanim zawartość wybranego snapshotu jest synchronizowana do pliku. Synchronizacja używa file-only
`writerDocumentSyncSelectedSnapshot`, bez drugiego `markCurrentManuscript` ani innego zapisu DB.
Błąd insertu audytu cofa selection; późniejszy błąd pliku pozostawia status `revision` i mismatch
plik↔current, więc completion fail-closed. Completion pobiera najnowszy audyt `revision` osobnym
zapytaniem, więc nierozwiązana decyzja nie znika po wypadnięciu poza zwykłe okno 100 audytów.

Targetowany integration `check:writer-review-receipts` przypina trzy wyścigi: 100 późniejszych
audytów nie ukrywa unresolved revision, wymuszony błąd insertu cofa zmianę current snapshotu, a
dwa równoległe snapshoty dostają różne wersje projektu. Dodatkowo potwierdza, że file-only sync
nie zmienia `auditRevision` po atomowym commicie selection+audit.

Targetowane regresje `check:orchestration-gateway`, `check:v2-harness-worker`,
`check:writer-domain` i `check:writer-review-receipts` są zielone.
Nie wykonano drugiego live canary. Odkryte poprawki mają więc dowód deterministyczny, ale jeszcze
nie nowy dowód live; nie deklarujemy pełnego parytetu Writera ani rolloutu produkcyjnego i nie
powtarzamy płatnego canary bez nowej hipotezy. Świadoma granica: niekooperująca obietnica providera
może po abort później się rozwinąć, lecz processor nie dopuści już jej narzędzi do skutku ubocznego.
Przymusowe zakończenie samego obliczenia wymagałoby izolacji procesowej i pozostaje osobną,
przyszłą granicą.

Obecny kontrakt Writera zakłada jedną instancję procesu. Mutex projektu jest lokalny dla procesu;
przed przyszłym uruchomieniem wielu replik trzeba dodać trwały cross-process fence pomiędzy
sprawdzeniem wybranego snapshotu a podmianą pliku. Bez niego DB nadal zablokuje fałszywe `done`,
ale druga instancja mogłaby nadpisać nowszą edycję pliku.

**4. `analyticsAgent` — V2 dowozi prawdziwą telemetrię, ale NIE pracę legacy.** Istniejący canary
`job_11a76952-7cce-471a-b1e7-aec9749211d6` naprawdę użył
`agentPerformanceReportTool`/`n8nListWorkflowsTool`/`listContextTool` i podał realne liczby systemu.
Jednak agent nie miał żadnego narzędzia do CRM, RSS, `workflow_runs`, `signals` ani `reports`, nie
miał `analytics/pipeline.md`, nie porównał dwóch okresów i niczego nie utrwalił. Legacy ma osobne
collect→LLM→persist dla weekly/ROI/trends, a trend dodatkowo emituje sygnały. `COMPLETED` oznaczało
więc sensowny raport telemetryczny, ale inną klasę roboty.

Port nie może kopiować legacy bez korekty: trend czyta `rss_articles` z `agentforge` (0), choć
realna baza `rss_intelligence` ma 11 356 rekordów; workflowy oczekują nieobecnych dziś akcji
`email_sent/email_received/meeting_scheduled` i statusów typu `aktywny_partner`, więc brak danych
zamieniają w fałszywe zera. Nowy kontrakt ma mówić `N/A/unavailable`, podawać provenance i
denominator oraz nazywać coś trendem wyłącznie przy dwóch równych, niepokrywających się oknach.

**DECYZJA ŚWIADOMIE ODŁOŻONA DO ROZMOWY Z UŻYTKOWNIKIEM 2026-08-10:** port domenowy daje
Analytics prawdziwe, read-only
collectory CRM/system/workflow/RSS i bezpieczny kontrakt raportowania, ale nie dodaje jeszcze
zapisu do `reports` ani emisji `signals`. Po zamknięciu zmian Writer/Deliberation/engine wracamy
do decyzji, czy te skutki uboczne mają być częścią agenta V2, osobnym idempotentnym workflowem,
czy pozostać w legacy. Wracamy do tej decyzji dopiero po zakończeniu bieżących poprawek i rozmowie
z użytkownikiem. Do tego czasu nie deklarujemy pełnego parytetu Analytics z legacy.

**5. `deliberationAgent` — dwie twarde regresje V2 i brak deterministycznego pipeline'u.** Legacy
i V2 wołają ten sam promptowy agent; V2 utrwala tylko zewnętrzny task, a proposal/krytyka/synteza
są niecheckpointowanymi tool callami. Run `job_f7c1ee44-f305-4c09-8b9d-6509946c8bb3` trwał 354,4 s,
lecz został sklasyfikowany jako FAST mimo decyzji HIGH-risk: classifier dostał goal już owinięty
headless contractem, znalazł literalne `short` i luźne polskie `ile` we własnym angielskim
wrapperze (`fast_hint:short`, `simple_keyword_ignored:ile`). Planning=skip, GoalContract=false,
critique skipped. Reproducer doprecyzował przyczynę: wrapper zatruwał sygnały, ale oba czyste
polskie goale również wpadały do FAST, bo słownik nie rozpoznawał odmian `debatę` i
`architektoniczną`.

Domena też nie broniła swojej jakości: wszystkie role startowały równolegle z tym samym intake,
więc redTeam i synthesisPlanner zachowywały się jak kolejni proposerzy; brakowało sekwencji
proposal→critique→synthesis→drugi red-team. Dwa puste wyniki workerów zwróciły `success:true` i
model sam robił retry. Board wymaga memo + action plan, a centralnie utrwalono tylko memo. Naprawa
domenowa dodaje pipeline/final gate i odrzuca pusty wynik. Naprawa silnika przekazuje osobny,
czysty `classificationPrompt` do Depth/GoalContract oraz późniejszych review/upgrade passów,
poprawia polskie prefiksy i granicę słowa `ile`. Oba przechwycone goale klasyfikują się teraz jako
DEEP w deterministycznej bramce; świeży post-fix live canary pozostaje do wykonania.

**6. `crmAgent` — brak utraconego legacy pipeline'u, ale lookup miał dwa realne defekty danych.**
Legacy i V2 używają tego samego świadomie read-only `crmAgent` + `searchLeadsTool`; tu nie należy
dodawać skutków ubocznych. Naprawione: surowy regex (nazwa z nawiasami dawała false negative) przez
literal exact-first→escaped contains oraz obietnica „interaction history”, choć wynik jej nie
zwracał. Odpowiedź ma teraz `matchKind/resultKind/totalMatched`, pełne `latestInteraction`
(`timestamp` lub legacy `ts`, action/description/agentId), status `research_enriched`, a brak
jakiegokolwiek locatora kończy się `NEEDS_INPUT`, nie skanem całej kolekcji. Fixture pochodzi z
realnego snapshotu CRM.

**Wspólny mianownik:** dowieziony artefakt ≠ dowieziona jakość. Canary sprawdzały obecność
produktu; te trzy wątki sprawdzają, czy **pipeline domenowy przeżył przepięcie na V2**.

**STAN NARZĘDZI I SKILLI V2:** worker pobiera przez `mastra.getAgent(id)` tę samą instancję
specjalisty, której używa legacy; nie tworzy okrojonej kopii. Harness wywołuje ogólną fazę `chat`,
która nie jest mapowana w ograniczeniach fazowych, więc agent zachowuje wszystkie zadeklarowane
narzędzia. Skille również nie są dodawane globalnie: Researcher i inni agenci mający
`skill_search`/`skill_load` użyją ich bezpośrednio, a Writer/Chef/Content zachowują swoje ścieżki
`run_worker` i delegacji. To daje parytet powierzchni narzędzi z legacy, nie automatyczny parytet
zachowania. Analytics nadal świadomie nie ma persistence/signals i czeka na decyzję po rozmowie
z użytkownikiem. Writer ma już świeży canary: mechanizm earned-time przeszedł, lecz domena
zakończyła fail-closed. Poprawki abort/review/revision/hard-brief są zielone deterministycznie,
ale nie mają drugiego dowodu live, więc pełnego parytetu nadal nie ma. Deliberation nadal czeka
na świeży post-fix live canary. Domyślna lista V2 pozostaje konserwatywna; agenci kosztowi,
zewnętrznie mutujący i kodujący są opt-in.

##### ✅ BRAMA NA KOLIZJĘ CHECKPOINT↔HEADLESS (`0f1f514`)

Kolizja „checkpoint czekający na człowieka w runie bez człowieka" jest **niewidoczna dla wszystkich
pozostałych testów**, bo to nie jest błąd kodu. Kosztowała dwóch agentów, zanim ktokolwiek
przeczytał DOKUMENT zamiast statusu (content 2 z 8 sekcji, chef „Uzupełniam profil…" jako
COMPLETED).

`check:headless-checkpoints` wymaga, żeby każdy pipeline mogący zatrzymać się na człowieku
**powiedział, co robi run w tle**. Brama **celowo NIE narzuca odpowiedzi** — część checkpointów
POWINNA nadal zatrzymywać, bo pilnują skutków poza dokumentem — wymaga tylko, żeby pytanie zostało
odpowiedziane tam, gdzie agent to przeczyta.

**Brama zarobiła na siebie natychmiast: oblała `huntAgent`**, którego `checkpoint_review` nie miał
żadnej reguły headless. Hunt został wcześniej nietknięty, bo „nie jest capability V2" — czyli
dokładnie w ten sposób utajona pułapka dożywa do momentu, gdy ktoś go włączy.

Checkpoint hunta **nadal zatrzymuje** (pilnuje wysyłki do realnych prospektów — skutku, którego
nikt nie cofnie). Zmienia się to, że run **oddaje wyrenderowany raport jako wynik** i mówi, że
wysyłka czeka na zgodę, zamiast czekać w ciszy nieodróżnialnej od zawieszenia.
**Gotowy, niewysłany raport jest produktem. Cicha zwłoka nie jest.**

Stan bram domenowych: chef ✓, content ✓, hunt ✓; design/film/music/writer nie mają checkpointów.

##### ⭐⭐ NASTĘPNY KROK (zaplanowany na 2026-08-10 ~04:35): ZGODA NA KOMENDĘ W TRYBIE HEADLESS

**Cel:** rozstrzygnąć, co robi run w tle, gdy `requiresCodeCommandApproval` żąda zgody człowieka —
i tym samym odblokować `codingAgent` jako capability V2.

**Dlaczego to, a nie co innego:** to ostatnia znana instancja klasy, którą ta sesja przerabiała
pięć razy — „mechanizm zaprojektowany pod nadzór człowieka, uruchomiony bez człowieka". Content,
chef i hunt zostały naprawione i zabezpieczone bramą `check:headless-checkpoints`, ale ta brama
patrzy **tylko na prompty pipeline'ów**. Bramka zgody na komendy żyje w KODZIE
(`workspaces/code-workspace.ts` + `harness-tool-envelope.ts`), więc brama jej nie widzi — a skutek
jest ten sam: job utyka w ciszy nieodróżnialnej od zawieszenia.

**Zakres:**
1. Prześledzić, co dziś robi `requiresCodeCommandApproval`, gdy nikt nie może zatwierdzić —
   czy zawiesza, czy odrzuca, czy czeka bez końca. **Zmierzyć, nie zgadywać.**
2. W trybie headless komenda wymagająca zgody musi kończyć się `NEEDS_INPUT: <jedno pytanie>`
   z kontraktu headless (mechanizm ISTNIEJE i jest rozpoznawany deterministycznie w
   `FINAL_DECISION`), a nie cichym czekaniem. Job idzie w `AWAITING_USER` z pytaniem, zamiast
   umierać na sufit czasu.
3. Rozszerzyć `check:headless-checkpoints` (albo dodać siostrzaną bramę) o bramki zgody
   **w kodzie**, nie tylko w promptach — inaczej następna taka bramka znów przejdzie niezauważona.
4. Dopiero potem canary `codingAgent` z jawną listą capability i **osobną bazą**.

**Ustalenia, na których to stoi (sprawdzone, nie założone):**
- `acceptSnapshot` tylko oznacza wiersz w Mongo; **nie scala, nie pushuje**;
  `getWorkspacePathForWrite` **rzuca** bez worktree, a narzędzi `merge`/`promote`/`push`
  **nie ma w ogóle** → zapisy agenta nie sięgają prawdziwego repo.
- Realne ryzyko to **wykonanie komendy**, i ono JEST bramkowane (`check:command-approval-gate`).

⚠️ **UWAGA OPERACYJNA — DRUGA SESJA W TYM SAMYM DRZEWIE.** Równoległa sesja edytuje
writer/crm/deliberation/prompty. W trakcie tej rundy `model-capabilities.ts` był w połowie edycji
i **wywalił `check:all` błędem składni**. Zanim uznasz bramę za wiarygodną:
```bash
git status --short            # czy drzewo jest cudzą pracą w toku?
```
Jeśli tak — **weryfikuj suitą docelową** (`npm run check:final-decision` itp.), commituj
**wyłącznie jawnymi ścieżkami** (`git add <plik>`), **NIGDY `git add -A`** (raz już skasowało to
mój własny plik i zagarnęło cudze zmiany).

##### 🔄 KROK 3 — ZREWIDOWANY: `knowledgeAgent` to SŁABY kandydat (sprawdzone, nie założone)

Canary miał go włączyć. **Router świadomie go NIE wybrał** i miał rację: pytanie o wzorzec Saga
poszło do `researcherAgent` (`COMPLETED`, 3840 zn. realnej treści). Karta `knowledgeAgent` mówi
wprost: *„research grounded in OUR curated NotebookLM corpus"*, a `whenNotToUse`: *„live public-web
reads → researcherAgent"*. Trasa była poprawna.

Wnioski, które to zmienia:
- `knowledgeAgent` jest **wąski** (NotebookLM nad naszym korpusem) i zależy od **zewnętrznej
  usługi** (`getNlmClient`). Jego canary byłby **niejednoznaczny**: porażka mogłaby znaczyć „V2
  nie działa" albo „NotebookLM niedostępny". Włączenie daje mało, a diagnostykę psuje.
- **Poprawka komentarza była słuszna** (`4c9925a`) — nie pisze na zewnątrz — ale „bezpieczny"
  nie znaczy „wart włączenia".

**Nowy kandydat na krok 3: `codingAgent`** — jedyny z grupy B o realnej wartości i, paradoksalnie,
**najlepiej zagatowany**: pracuje w izolowanym worktree i ma ledger akceptacji plików
(`coding_accept_file`/`coding_reject_file`). **KOREKTA: mój wcześniejszy warunek był PRZESZACOWANY.** Napisałem, że `coding_accept_all`
pozwala „napisać i samemu zaakceptować zmiany w repo". Dosłownie prawda, ale myląca co do skutku —
przeczytałem `acceptSnapshot` (`code-change-ledger.ts:206`): ono **tylko sprawdza hash i oznacza
snapshot jako `accepted` w Mongo**. Nie scala, nie pushuje, nie dotyka gałęzi. Do tego
`getWorkspacePathForWrite` jest **STRICT — rzuca, gdy nie ma worktree**, więc zapisy agenta nigdy
nie trafiają do prawdziwego repo, a narzędzia `coding_merge`/`promote`/`push` **nie istnieją
w ogóle**. Realny promień rażenia: pliki w izolowanym worktree + wpis w ledgerze.

**PRAWDZIWY warunek wstępny jest inny i lepiej ugruntowany:** `codingAgent` uruchamia komendy
powłoki, a te przechodzą przez `requiresCodeCommandApproval` — bramkę, która przy komendzie
niebezpiecznej **zawiesza run i czeka na człowieka**. W trybie headless to jest **dokładnie ta
sama klasa kolizji**, na którą właśnie postawiliśmy bramę (`check:headless-checkpoints`): job
utknąłby w ciszy nieodróżnialnej od zawieszenia. Przed włączeniem `codingAgent` trzeba więc
rozstrzygnąć, co robi run w tle, gdy komenda wymaga zgody — najpewniej `NEEDS_INPUT` z kontraktu
headless zamiast cichego czekania.

**Zasada, która się tu potwierdziła:** capability włącza się, gdy ma realny ruch do obsłużenia,
a nie dlatego, że przeszła audyt bezpieczeństwa.

**KROK 4 — drobne z planu:** dashboard jako **command client** (dziś tylko czyta), SSE (dziś
poll), synteza tekstowa w `synthesize` (dziś traktowana jak „skończ").

**KROK 5 — F6/Fala 5: cutover.** Właściwy cel planu: zastąpić `void executeDelegation` trwałym
dispatchem (`GAP-CUTOVER-01`). ~~Do dziś przeniesionych agentów jest ZERO w sensie cutoveru~~ —
**praca 1 z 5 ZROBIONA 2026-08-10, patrz „F6 KROK 1" niżej.**

##### F6 KROK 1 — `async-delegation` jedzie na durable jobach (flaga `FEATURE_ORCHESTRATION_V2_DELEGATION`, domyślnie OFF)

**Audyt PRZED kodem opłacił się drugi raz.** `grep` konsumentów pokazał, że
`startAsyncDelegation` jest wołane z **czterech** miejsc w `delegate-task.ts`, za każdym razem
w tym samym kształcie. Szew jest więc **w serwisie, nie w wywołaniach** — przecięcie w środku
`startAsyncDelegation` przenosi wszystkie cztery naraz i zostawia narzędzie nietknięte, a rollback
to jedna flaga zamiast czterech revertów. Sygnatura i zwracane `{ delegationId }` bez zmian.

**Trzy rzeczy, których substrat NIE miał i trzeba było dobudować** (reszta już była):
1. **Przypięcie specjalisty.** Legacy już wie, kogo chce (`targetAgent`), więc pytanie modelu
   planującego byłoby i marnotrawstwem wywołania, i szansą na **inną** odpowiedź.
   `StartJobInput.capability` → `JobDoc.requestedCapability`, a `runPlanningActivation` przy
   przypięciu **pomija decydera**. Walidacja kształtu **na granicy komend** — zła nazwa zamrożona
   w przyjętym jobie wywalałaby każdą próbę na zawsze, a accept to ostatni moment, gdy błąd trzyma
   jeszcze wołający. Job **nieprzypięty** jest bajt w bajt jak przed zmianą (pole POMINIĘTE, nie
   `null`). Replan dziedziczy pin istniejącą ścieżką `previous?.capability`.
2. **Most powrotny.** Kontraktem legacy nigdy nie było „jobId" — to **pending message w wątku
   wołającego** i wiersz `async_delegations` w stanie terminalnym. `runDelegationCompletionBridge`
   trzyma ten kontrakt, więc pending updates metaAgenta, Task Ledger i GoalContract nie muszą
   wiedzieć, że cokolwiek się przeniosło. Dwie **różne bazy** → żadna transakcja ich nie obejmie:
   most to odpytywana projekcja na ticku `reconcile` (`afterReconcile`), z kluczem idempotencji.
   **Kolejność jest celowa:** wiadomość trafia do kolejki ZANIM wiersz opuści `running`, bo koszty
   są niesymetryczne — duplikat to widoczny szum, zgubiona wiadomość to wołający, który **nigdy**
   nie dowie się, że praca skończona. `queuePendingMessage` przyjmuje teraz `messageId`, więc
   duplikat jest **sklejany**, nie tylko tolerowany (`$setOnInsert` zachowuje PIERWSZĄ wersję —
   ponowienie nie może nadpisać treści, którą agent mógł już wziąć).
3. **Jedna definicja klucza właściciela.** `durableJobOwner(agentId)` współdzielone z
   `orchestration-job-tools.ts`. Dwa pasujące szablony stringa wystarczyłyby, żeby działać dziś
   i **po cichu** zepsuć się później: owner scoping celowo zrównuje „nie twoje" z „nie istnieje",
   więc job zakluczowany inaczej niż wywodzi `orchestration_get_job` nie jest nigdzie błędem —
   jest po prostu jobem, którego wołający **nigdy nie zobaczy ani nie odpowie**.

**FAIL-OPEN świadomie.** Wszystko, czego durable nie obsłuży (flaga off, brak kompozycji,
nieroutowalny cel, store niedostępny) → `null` i delegacja idzie **dokładnie tą drogą co wcześniej**.
Substrat, który po cichu połykałby delegacje, których nie umie zrouty, byłby gorszy niż
fire-and-forget, które zastępuje. Wiersz zapisuje, który tor zadziałał (`dispatch`).
**Bramka „kto może"** to ten sam rejestr capability co menu lane'a, pytany **PRZED** acceptem —
bo fallbackiem samego routera jest „agent domyślny", więc sprawdzenie tam zamieniłoby
`delegate_task(targetAgent:'codingAgent')` w odpowiedź od `researcherAgent` i nic by tego nie
powiedziało.

**`AWAITING_USER` wychodzi jako PYTANIE, nigdy jako wynik** (raz, nie raz na tick). Zaraportowanie
joba zaparkowanego na człowieku jako skończonej delegacji byłoby kłamstwem, na którym wołający
działa — ta sama klasa, co „mechanizm pod nadzór człowieka, uruchomiony bez człowieka". Wołający
jest agentem trzymającym `orchestration_answer_job_request`, więc wiadomość mówi, czym odblokować.

**DOWÓD LIVE (2026-08-10, `MONGODB_DB_V2=orchestration_v2_f6_delegation`, czytane Z BAZY):**
- *Cutover:* `metaAgent` → `delegate_task(researcherAgent, async:true)` → log
  `[AsyncDelegation] → durable job job_a1a0cf16…`; job z `requestedCapability: researcherAgent`,
  task z zamrożonym `capability: researcherAgent`, `TERMINAL/COMPLETED`, most zapisał wiersz
  `completed` (745 zn.) + **jedną** pending message `delegation-result:<delegationId>`.
- *Przeżycie restartu — właściwy sens całej roboty:* druga delegacja **`SIGKILL` w locie**
  (job `DISPATCHING`, task `DISPATCHED`, wiersz `running`, zero wiadomości). Po restarcie substrat
  zapisał **próbę 1 → `WORKER_LOST`**, wykonał **próbę 2 → `OK`**, `COMPLETED`, a most dowiózł
  2154 zn. do wątku wołającego. Na legacy ta praca jest **nie do odzyskania**, a wiersz zostaje
  `running` aż do TTL.

**ZNANE OGRANICZENIA — istniały wcześniej i są niezależne od toru** (mówię to wprost, bo przy
canary wyglądają jak wada cutoveru):
- `callerThreadId` jest **argumentem MODELU** w `delegate_task`. Gdy model go nie poda,
  `delegate_task` wymyśla `meta-<uuid>` i wynik ląduje w wątku, którego nikt nie czyta —
  zaobserwowane w canary 1, identycznie na obu torach.
- Na `POST /api/agents/:id/generate` `PendingUpdatesProcessor` loguje `pending_scope_missing`
  i **w ogóle nie pyta kolejki** (ta sama pułapka braku `threadId`, która wymusiła osobny endpoint
  Meta Frontu) — więc zakolejkowany wynik nie jest tam konsumowany w następnej turze. Niezależne
  od toru: procesor nie dochodzi do kolejki, więc nie ma znaczenia, kto ten wiersz zapisał.

**ZNALEZISKO POBOCZNE, warte osobnej roboty:** ~20 skryptów orkiestracyjnych czyta
`MONGODB_URI_SPIKE_RS ?? localhost:27018`, a `check:all` **nie podnosi** tego replica setu
(kontener jest `--rm`). Zmierzone: pełny `check:all` wyszedł **exit 0 z 5 liniami SKIP** —
`check:lane-request-user`, `check:final-decision`, `check:capability-routing`,
`check:durable-delegation` i `e2e:orchestration-progress-lease` pominęły swoje sekcje trwałości.
Po `npm run spike:mongo-rs:up` wszystkie pięć wykonują się w całości i przechodzą. Czyli
„check:all zielone (52 pozycje)" **zawyżało pokrycie**: trwała połowa asercji V2 nie wykonywała
się wcale. To kolejna instancja „zielone, bo nigdy nie zostało uruchomione".

**Bramka:** `npm run check:durable-delegation` (18 asercji; sekcje trwałości i mostu wymagają RS,
most dodatkowo używa głównej bazy aplikacji i po sobie sprząta).

##### F6 KROK 2 — Automation Golden Path na durable jobach (flaga `FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS`, domyślnie OFF)

Ten sam kształt `void …(…)` co delegacja, ale **największy promień rażenia w systemie**, bo ten
pipeline **deployuje do n8n**. Trzy konkretne defekty — pierwsze dwa naprawione **na OBU torach**,
bo flaga jest domyślnie wyłączona, a produkcja siedzi na legacy:

1. **Wejście istniało tylko w domknięciu.** Wiersz `automation_jobs` przeżywał restart, ale pracy,
   którą opisywał, **nikt nie mógł powtórzyć** — wiersz był pokwitowaniem za coś, co przestało
   istnieć. `goldenPathInput` jest teraz trwały; bez tego żadne „trwałe attempts" nie mają sensu.
2. **Cancel nie anulował.** `liveJobs` to była procesowo-lokalna `Map` czytana w trzech miejscach,
   z których **żadne nie było w środku pipeline'u**. Cancel w trakcie builda ustawiał wiersz na
   `cancelled` i pozwalał deploy/test/repair lecieć dalej — stop operatora tłumił **raport**, nie
   pracę. Teraz `executeAutomationGoldenPath` przyjmuje `{ signal, onStep }` sprawdzane na każdej
   granicy kroku, a heartbeat (i tak chodzący co 5 s) **odczytuje wiersz z powrotem** — więc stop
   wydany w innym procesie dociera do pracującego pipeline'u. Bez drugiego timera.
3. **Zero progresu.** `lastHeartbeatAt` dowodzi, że proces żyje, i nie mówi nic o tym, czy run jest
   na `risk_score` czy trzy naprawy głębiej.

**Capability może teraz nazywać FUNKCJĘ** (`native-worker.ts`). Golden Path to pipeline i danie mu
trwałych prób, lease'u, fence'u i realnej bariery stopu nie powinno wymagać udawania rozmowy.
Substrat bez zmian: dalej zamraża capability w planie, dalej leasuje próbę, dalej podaje ten sam
`WorkerContext` — zmienia się tylko to, CO biegnie. Kompozycja z workerem agentowym, nie zamiana
(jedna kolejka, jedna ścieżka claimu). Mapa executorów jest code-owned w korzeniu kompozycji, więc
nazwa wyprodukowana przez model może z niej tylko **wybierać**, nigdy jej nie rozszerzyć.
`Object.hasOwn`, nie `in` — capability o nazwie `toString` nie może trafić na prototyp i zostać
wywołana.

**Wejście NIE jest kopiowane do store'u orkiestracji** — executor czyta je z wiersza po `v2JobId`.
Duplikat specyfikacji workflow w drugiej bazie to dwie kopie, które mogą się różnić co do tego, co
się właściwie buduje.

**Build `blocked` to job COMPLETED.** Dwa pytania, których nie wolno skleić: czy skończyła się
PRÓBA i czy udał się BUILD. Naruszenie polityki albo werdykt ryzyka to system działający poprawnie
— zaraportowanie tego jako failed job zrobiłoby z każdej słusznej blokady awarię, a lane ponawiałby
odmowę, która odmówi znowu.

**Budżet:** Golden Path zachowuje własne 20 minut (to samo, co legacy async automation). Domyślne
300 s store'u to jedna trzecia — odziedziczenie tego po cichu tłukłoby buildy w środku naprawy
i wyglądałoby, jakby pipeline się pogorszył, a nie jakby zmienił się budżet.

**DWA DEFEKTY, KTÓRE ZŁAPAŁ DOPIERO PRZEBIEG LIVE — testy ich nie widziały:**
- **`undefined` to nie JSON.** `summarizeForResult` ustawiał nieobecne pola na `undefined`,
  a walidator koperty producenta odrzuca wszystko, czego JSON nie przenosi tożsamościowo. Jedno
  `failureClass: undefined` → `invalid_result` → job `FAILED` i **zero zapisanego wyniku**: Golden
  Path, który poprawnie przeszedł pięć kroków, raportował się jako crash. Wszystkie testy
  przechodziły, **bo walidowały most względem WŁASNEJ atrapy `readResult`**. Naprawa to `compact()`,
  ale prawdziwa naprawa to nowa asercja podająca wyjście executora do `validateProducerResult` —
  jedynego walidatora, którego zdanie się liczy. (Ta sama klasa co „zielone, bo pisane z wyobrażenia
  o kształcie danych".)
- **Współbieżny `$push` nie zachowuje kolejności.** Pierwsza wersja zapisywała każdy checkpoint
  niezależnie i ślad wracał przemieszany (`coverage_check` przed `resolve_workflow`), co odpowiada
  na „które kroki poszły", ale nie na „dokąd doszło" — czyli na jedyne pytanie, jakie się śladowi
  progresu zadaje. `createProgressRecorder` serializuje łańcuch i stempluje ciągłe `seq`; używają go
  **oba tory**, żeby ślad znaczył to samo niezależnie od tego, kto budował.

**DOWÓD LIVE (`npm run live:f6-automation`)** — realny dispatch, realna granica komend, realny lane,
realny native worker, realny Golden Path, realny most: `dispatch=durable`, job przypięty do
`automation_golden_path`, task `SUCCEEDED`, job `COMPLETED` w 1 próbie, ślad
`resolve_workflow → forbidden_node_policy → coverage_check → node_validation → runtime_check:blocked`,
wiersz `completed`, jedna pending message. Baner zbudowanego serwera potwierdza kompozycję:
`automation: DURABLE (native capability)`.

**ŚWIADOMIE NIEZWERYFIKOWANE — i nie wolno tego twierdzić:** cancel przychodzący w środku builda,
który **już zdeployował**. Udowodnienie tego wymaga przebiegu piszącego do żywego n8n użytkownika.
Skrypt live używa workflow zatrzymywanego na `runtime_check` — pięć kroków, a `deploy_inactive`
jest szósty — więc nic nie dociera do n8n; ścieżka anulowania jest udowodniona jednostkowo na
realnym przebiegu Golden Path.

**Bramka:** `npm run check:durable-automation` (24 asercje; nic w niej nie deployuje).

##### F6 KROK 3 — capability BUILD: odnawiany lease, fence, jednorazowy permit (bez flagi)

W odróżnieniu od prac 1 i 2 plan **nie** każe tu przenosić wykonania na durable joby. Każe
sprawić, żeby dwóch niebezpiecznych momentów nie dało się osiągnąć bez posiadania prawa do nich:
`git merge` do żywego repo i `promote`, który przełącza to, co serwuje :4111. Cztery defekty —
wszystkie znalezione **czytaniem kodu, nie z padającego runu**, i wszystkie CICHE, dlatego przeżyły.

**1. Lease nigdy nie był odnawiany.** Build bierze `repo:src/mastra/**` raz, TTL 20 minut,
a `cleanupExpired` **KASUJE** wygasły zamek. Build to delegacja + `npx tsc --noEmit` +
`npm run check:all` w worktree — rutynowo dłużej niż 20 minut. Zamek po cichu znikał w trakcie,
kod dalej wierzył, że trzyma repo, a **drugi build mógł wziąć ten sam claim i mergować do tego
samego repozytorium równocześnie**. Nic tu nie rzuca błędu; dowiadujesz się z historii gita.
`renewClaims` przedłuża lease i w tym samym round-tripie mówi, czy lane nadal go trzyma.
Własność jest w **filtrze**, nigdy w update — więc może przedłużyć swój zamek i **nigdy nie może
go stworzyć ani ukraść**.

**2. Nie było fence'u w miejscu użycia.** Odnawianie zwęża okno, nie zamyka go. Merge i promote
pytają teraz BAZĘ, czy ten lane nadal trzyma claim, zamiast ufać zmiennej sprzed dwudziestu minut.

**3. Permit promote był CZYTANY, nie WYDAWANY.** `checkApproval` pytał tylko, czy token mówi
`approved`, i nic nie oznaczało go jako zużyty — więc jedna ludzka zgoda mogła promować dowolną
liczbę razy, dla dowolnych commitów, w nieskończoność. Permit, który przeżywa swoje użycie, nie
jest permitem, tylko stałym uprawnieniem, na które nikt się nie zgodził. `consumeApproval` to
jeden atomowy CAS stemplujący `promoteConsumedBy`/`promoteConsumedCommit`; dwa buildy ścigające
się o jeden token = dokładnie jeden promuje. Wydawany **PRZED** przełączeniem, żeby promote, który
padnie w połowie, nie zostawił permitu wyglądającego na nieużyty.

**4. Zabity build wyglądał jak pracujący.** `void runCapabilityBuild(...)` zostawiał wiersze
`running` dla procesu, który już nie istniał, i **nie było czego ich sprzątać**. Tick odnawiania
jest teraz też heartbeatem, a `markStaleCapabilityBuilds` zamyka wiersze, które przestały
raportować — mówiąc wprost, że **żaden merge ani promote się nie odbył**. Zarejestrowane jako
**periodic worker**, nie jako narzędzie agenta: przemiatanie, które działa tylko gdy ktoś o nie
poprosi, nie przemiata, a nikt nie pyta o build, o którym zapomniał. (Dokładnie ten kształt ma
nadal `markStaleAutomationJobs` — tylko narzędzie — warte osobnego spojrzenia.)

**Do tego izolacja process group.** `timeout` z `execFile` sygnalizuje bezpośrednie dziecko, czyli
tu `bash`. Komenda to `npm run check:all`: npm odpala node, node tsx, tsx kilkadziesiąt skryptów.
Zabicie basha zostawiało to drzewo żywe — trzymające worktree, CPU i połączenia do Mongo,
niewidoczne dla builda, który je porzucił — więc następny build konkurował z **duchem poprzedniego**.
Teraz `detached: true` na czele własnej grupy i sygnał do `-pgid`, TERM potem KILL. Świadomie NIE
`linux-process-tree` z warstwy orkiestracji: tamto dowodzi pustki drzewa skanem `/proc` dla
fenced durable attempts, a tu potrzeba tylko „zatrzymaj drzewo, które sam odpaliłeś".

**DOWÓD:** `npm run check:capability-build-lease` — 13 asercji przeciwko **PRAWDZIWEMU** store'owi
claimów i **PRAWDZIWEJ** kolekcji `approvals`, bo bug żyje w interakcji odnawiania, wygaśnięcia
i sprzątania, a atrapa zamka testowałaby tylko moje wyobrażenie o niej. W tym: nieodnawiany lease
wygasa i fence to zauważa; odnowiony przeżywa swój pierwotny termin; build, któremu ukradziono
zamek w trakcie delegacji, ODMAWIA merge'a; jeden token nie promuje dwa razy; i **realne drzewo
procesów z realnym wnukiem**, ubite timeoutem i zaobserwowane jako nieżywe.

**TEN SAM BŁĄD Z ATRAPĄ ZDARZYŁ SIĘ ZNOWU — i tu go złapałem.** Pierwsza wersja testów permitu
stubowała `consumeApproval` na `'approved'`, więc asercje dowodziły, że atrapa zwraca to, co
zwraca atrapa, a logika jednorazowości, od której wzięły nazwę, **nigdy się nie wykonała**. Oba
testy promote mają ją teraz nieostubowaną. To **trzecia praca z rzędu**, w której bug chował się
za test doublem: `findArtifactIds`, `readResult`, `consumeApproval`.

**Bramka:** `npm run check:capability-build-lease` (w `check:all`).

##### F6 KROK 4 — Ledger jako projekcja + kill switch sięga V2 (bez flagi)

Prace 1 i 2 przeniosły delegację i automation na durable joby. Tym samym **stworzyły dwie władze
odpowiadające na te same dwa pytania**, a obie odpowiedzi są ciche, gdy są błędne.

**Kto decyduje, czy praca żyje?** `reconcileStaleLanes` ocenia lane po heartbeacie i oznacza
`failed`. Durable job przeżywa restarty, jest ponawiany po `WORKER_LOST` i może czekać na
człowieka — a każde z tego wygląda dla stopera dokładnie jak cisza. I szkoda była **trwała**:
terminalne stany lane'a są **pochłaniające**, a `ledgerTransitionBySource` przy terminalnym lane
robi wczesny return — więc prawdziwe `done`, które przychodziło potem, **znikało bez słowa**. Model
odczytu raportowałby porażkę, która się nie wydarzyła, na zawsze, i nic by temu nie zaprzeczyło.

Lane ma teraz `owner: 'durable'` + id joba, który projektuje. Stale-reconciler wyklucza je
**w ZAPYTANIU**, nie w pętli: żywotność tej pracy to fakt, który substrat już ustala leasem,
próbami i `WORKER_LOST`. `ledgerProjectDurableState` odbija stany nieterminalne i jest **węższy**
od zwykłej tranzycji — odmawia ruszenia lane'a, którego substrat nie posiada (projekcja nie może
nadpisać tego, co projektuje) i nie wskrzesi zamkniętego lane'a. Widoczny zysk: job zablokowany na
człowieku pokazuje w digeście `awaiting_approval` zamiast `running` — „czeka na Ciebie" przestaje
wyglądać jak „pracuje".

**Kto decyduje, czy RUSZA nowa praca?** Kill switch Ledgera znaczy „lane'y tła są zapauzowane"
i honoruje go każda legacy pętla. Durable lane orchestrator dispatchuje prosto ze store'u i **nigdy
o nim nie słyszał** — więc stop operatora zatrzymywał **TYM MNIEJ, im więcej pracy przenieśliśmy**,
wciąż czytając się jako „zatrzymane". Kontrola bezpieczeństwa, która po cichu się zwęża w miarę
adopcji nowego substratu, jest gorsza niż jej brak. Mount przyjmuje teraz `pauseDispatch`, pytany
przed każdym drainem. Semantyka jak §8.4 pause: **zero nowych dispatchy, praca w locie się dosettla**
(ubijanie to `cancel` — destrukcyjny i per-job). **Fail-open:** rzucający przełącznik to zepsuty
odczyt, a nie operator proszący o zatrzymanie wszystkiego; zaklinowanie pętli na czkawce Mongo
byłoby własną awarią.

**DOWÓD:** `npm run check:ledger-projection` — 11 asercji. Połowa lane'owa przeciwko **prawdziwej**
kolekcji lane'ów (bug żyje w interakcji reconcilera, pochłaniających stanów terminalnych i joba,
który przeżywa swój heartbeat). Połowa kill-switchowa **bootuje PRAWDZIWY mount** z prawdziwymi
timerami na replica secie i asercjonuje ZACHOWANIE: przy stopie przyjęty job nie planuje nic
i zostaje `ACCEPTED` (pauza, nie porażka); po zwolnieniu — planuje; a rzucający przełącznik
przepuszcza pracę.

**Pierwsza wersja tej sekcji asercjonowała TEKST ŹRÓDŁA** (`indexOf('pauseDispatch') < indexOf('drainLane')`).
To dokładnie ten błąd, za który ten projekt już raz zapłacił (asercja padła po przeformatowaniu,
choć broniona własność była nietknięta) — zastąpione mountem, który naprawdę chodzi.

**Bramka:** `npm run check:ledger-projection` (w `check:all`).

##### F6 KROK 5 — GAP-CUTOVER-01: cutover żywych danych (bez flagi)

Ostatni element F6 i jedyny, którego definicja ukończenia dotyczy **danych, które już istnieją**,
a nie kodu: każdy legacy wiersz sklasyfikowany, żaden autonomiczny wyzwalacz nie odpalony zero ani
dwa razy.

**Dlaczego akurat wyzwalacze są trudne.** Każda inna awaria w tym systemie sama się zgłasza — job
pada, lane robi się czerwony, agent raportuje błąd. Wyzwalacz, który odpalił się **zero razy, nie
zostawia ŻADNEGO śladu**: rzecz, która się nie wydarzyła, nic nie zapisuje. A ten, który odpalił się
dwa razy, wygląda jak harmonogram pracujący pilniej. Dwa realne defekty tego kształtu:

1. **Odpala DWA RAZY.** `markScheduledTaskCompleted` jest lease-scoped i zwraca `null`, gdy lease
   tego runnera już wygasł i inny runner przejął wystąpienie. Runner **wyrzucał tę wartość do kosza**
   i tak czy siak tworzył następne wystąpienie. Jedno odpalenie → dwa przyszłe wiersze, i od tego
   momentu harmonogram chodził podwójnie, **na zawsze**. Naprawa: advance dopiero po WYGRANEJ
   completion (tu jest ustalany jedyny autorytatywny wykonawca wystąpienia) + `succeedsTaskId`
   i `succession` pod **unikalnym indeksem częściowym**, więc nawet wyścig zbiega się do jednego
   następcy.
2. **Odpala ZERO razy.** Completion i utworzenie następcy to dwa zapisy; proces, który padnie
   pomiędzy, zostawia rekurencję po prostu **zatrzymaną**. `findStoppedRecurrences` je raportuje,
   `repairStoppedRecurrence` restartuje jedną.

**NEAR-MISS, który trzeba zapisać.** Pierwsza wersja reconcilera uznawała „nie ma wiersza-następcy"
za „zatrzymane". Wystąpienia sprzed tej pracy nie mają `succeedsTaskId`, więc historyczny łańcuch
A→B→C czyta się jako **trzy** bezpotomne completion-y — ta reguła **wskrzesiłaby każdy powtarzalny
harmonogram, jaki ten system kiedykolwiek uruchomił, po kilka razy**, a każdy restart **ODPALA**
(potencjalnie agenta albo workflow n8n). Reguła, która ją zastąpiła, zadaje uczciwe pytanie
**per łańcuch**: rekurencja żyje, dopóki którekolwiek wystąpienie jej łańcucha jest `scheduled`,
`leased` albo `running`. Łańcuchy anulowane i wygasłe też są wykluczone — restartowanie tego, co
operator anulował, byłoby gorsze niż zostawienie zatrzymanego.

**Naprawa jest RAPORTOWANA, nie automatyczna.** Utworzenie scheduled taska to nie poprawka
księgowa — ten wiersz odpala. Sweeper, który po cichu restartowałby każdy harmonogram uznany za
zatrzymany, podejmowałby tę decyzję **hurtowo, na żywych danych, w imieniu operatora**.
`npm run audit:cutover` jest read-only i nazywa decyzje; podejmuje je człowiek.

**DOWÓD LIVE (realne kolekcje):**
```
async_delegations   imported-to-v2 2 | drained-in-v1 1 | terminal-legacy 10
automation_jobs     imported-to-v2 1 | drained-in-v1 0 | terminal-legacy 0
scheduled_tasks     duplicate successors 0 | stopped recurrences 0 | live 0
```
Ta jedna delegacja `drained-in-v1` to uczciwa liczba do pilnowania: legacy wiersz wciąż na starym
torze, **musi dojść do zera, zanim `void executeDelegation` da się usunąć**. To właśnie znaczy tu
„drain" — nie usterka, tylko odliczanie.

**I UCZCIWE OGRANICZENIE tej zielonej linii:** `scheduled_tasks` jest **pusta**, więc „żaden
wyzwalacz nie odpalił się zero ani dwa razy" jest tu prawdą **pustą**. To dowód, że nic nie jest
zepsute TERAZ, a nie dowód, że naprawa działa. Naprawa jest udowodniona osobno, na skonstruowanych
danych, przeciwko prawdziwemu store'owi i prawdziwemu unikalnemu indeksowi:
`npm run check:scheduled-succession` (11 asercji).

**NIETESTOWANE i nie twierdzę inaczej:** runner reagujący na przegraną completion. Wywołanie tego
zachowaniowo wymaga, by drugi runner ukradł lease **pomiędzy** leasem a completion tego runnera,
a `processOneDueScheduledTask` nie ma szwu do wpięcia — każda wersja takiego testu jest albo
wyścigowa, albo sięga po **prawdziwy harmonogram operatora**, żeby udowodnić swoją tezę. Mechanizm,
na którym guard stoi, jest udowodniony; sam trzyliniowy guard jest przejrzany. Wcześniejszy szkic
asercjonował TEKST ŹRÓDŁA runnera — czyli błąd, za który ten projekt już raz zapłacił.

**Bramki:** `npm run check:scheduled-succession` (w `check:all`) + `npm run audit:cutover` (raport).

##### (odłożone) `filmmakerAgent` / `musicianAgent` — gdyby wracać: najpierw suchy przebieg

Warunek z poprzedniej rundy („nie włączać, dopóki wybór produktu nie działa") jest **spełniony**:
wybór z artefaktów działa i jest przypięty zrzutem z żywego runu. Oba agenty **mają** już
`artifact_put` (potwierdzone przez `check:deliverable-capability`).

**Uwaga na koszt — to jedyna capability, gdzie canary PŁACI za generację** (fal/ElevenLabs).
Dlatego kolejność:
1. **Suchy przebieg bez płatnej generacji** — zlecenie, które kończy się artefaktem tekstowym
   (np. storyboard/plan ujęć albo tekst piosenki), żeby zweryfikować trasę, budżet i wybór
   produktu **zanim** wydamy pieniądze.
2. Dopiero potem jeden pełny, płatny canary — **za zgodą użytkownika**, bo to wydatek.

**Odłożone świadomie (mierzone, nie zgadywane):**
- **Limity kroków — NIE ruszać.** Zużycie w canary: **3, 5, 7, 7 kroków** przy suficie 150.
  Podnoszenie byłoby no-opem.
- **Okno czasu — nie podnosić jako pierwszy ruch.** Wąskim gardłem jest kształt pracy designu
  (front-loading researchu: 234K tokenów wejścia, czytanie 40 presetów stylów, 3 warianty),
  nie sam zegar. Najpierw `pipeline.md` „jeden produkt najpierw, eksploracja potem" (`477fa78`),
  potem **ponowny pomiar**. Jeśli pierwsze próby dalej będą dobijać 900 s **pracując**, wtedy
  klasa `extended` (1800 s) — ale **razem z liveness**, bo zegar ścienny nie odróżnia „pracuje"
  od „zawiesił się", i podniesienie go bez liveness czyni zawieszone runy tylko droższymi.

Kolejność dalej:

4. **Migracja pozostałych agentów** (F7) — każdy z własnym profilem, flagą i canary.
5. Drobne: dashboard jako **command client** (dziś tylko czyta), SSE (dziś poll), synteza
   tekstowa w `synthesize` (dziś traktowana jak „skończ").

#### Czego świadomie NIE robimy (i dlaczego to nie jest dług)

- **Chroniona rezerwa budżetowa dla `FINAL_DECISION`** (§11) — wymaga maszynerii pul
  budżetowych, której nie ma poza pulą STOP; slice ogranicza się własnym oknem. Fala 7.
- **Fan-out / fan-in** — wymaga `ORC-DISPATCH-EDGE-01` na pełnym dependency closure. Fale 6-7.
- **`ORC-TXN-A-EVIDENCE-01`, `ORC-SPECULATION-01`, `ORC-ATTACHED-01`** — zgatowane konsumentem,
  który nie istnieje (audyt F4). To decyzja, nie zaległość.

---

### F6 — Fala 5: konsolidacja mechanizmów tła + cutover

**Migrowane** (wszystkie działają dziś jako legacy): `async-delegation`,
`background-task-manager`, `automation-job-manager`, `capability-build`, scheduled
store/runner, Task Ledger, pending messages/claims.

**Prace**
1. ✅ **ZROBIONE 2026-08-10** — zastąpić `void executeDelegation` trwałym dispatch
   (`services/durable-delegation.ts`, flaga `FEATURE_ORCHESTRATION_V2_DELEGATION`, domyślnie OFF;
   dowód live: `WORKER_LOST` → retry → `COMPLETED` po `SIGKILL`). Szczegóły w dzienniku, „F6 KROK 1".
   **Nie zrobione w tym kroku:** „spawn **po** trwałym claimie" dotyczy workerów procesowych
   (`PROCESS_GROUP`); tor delegacji jedzie in-process registry workerem, który claimuje próbę
   trwale, zanim ją uruchomi — czyli warunek jest spełniony dla TEJ ścieżki, nie dla wszystkich.
2. ✅ **ZROBIONE 2026-08-10** — Automation Golden Path → trwałe tasks/attempts z realnym cancel
   i checkpointowanym progress (`services/durable-automation-jobs.ts` +
   `orchestration/execution/native-worker.ts`, flaga `FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS`,
   domyślnie OFF). Szczegóły w dzienniku, „F6 KROK 2". **Nie zweryfikowane live i nie wolno tego
   twierdzić:** cancel w środku builda, który JUŻ zdeployował — wymaga przebiegu piszącego do
   żywego n8n użytkownika.
3. ✅ **ZROBIONE 2026-08-10** — capability BUILD → odnawiany lease/fence, izolowany process group,
   merge/promote za świeżym fencem i jednorazowym permitem (`capability-build.ts` +
   `renewClaims`/`claimsStillHeld` w `task-ledger-scheduler.ts`). **Bez flagi — to nie cutover,
   tylko usunięcie czterech cichych defektów; obowiązuje od razu.** Szczegóły w dzienniku,
   „F6 KROK 3". **Niezweryfikowane live:** pełny realny build (delegacja + `check:all` w worktree
   + merge) — wymaga zapisu do repo użytkownika.
4. ✅ **ZROBIONE 2026-08-10** — Task Ledger jako **projekcja**, nie scheduler (`owner: 'durable'`
   + `ledgerProjectDurableState` w `task-ledger.ts`, `pauseDispatch` w moncie). **Bez flagi** —
   to naprawa dwóch defektów, które WPROWADZIŁY prace 1 i 2. Szczegóły w dzienniku, „F6 KROK 4".
5. ✅ **ZROBIONE 2026-08-10** — **`GAP-CUTOVER-01`**: jeden autorytatywny wykonawca (advance
   tylko po WYGRANEJ completion), reguła next-fire (`succeedsTaskId`+`succession` pod unikalnym
   indeksem częściowym), wykrywanie zatrzymanych rekurencji + jawna naprawa, raport klasyfikujący
   żywe wiersze (`npm run audit:cutover`). Szczegóły w dzienniku, „F6 KROK 5".

**Definicja ukończenia**
- Restart każdej ścieżki odzyskuje pracę; brak in-memory registry jako źródła prawdy.
- Cutover ma evidence: żaden autonomiczny wyzwalacz nie odpalił się **zero ani dwa razy**;
  każdy legacy wiersz sklasyfikowany `drained-in-v1 | imported-to-v2 | terminal-legacy`.

**Ryzyko:** wysokie (żywe dane). Per mechanizm, z osobnym rollbackiem.
**Rozmiar:** 5–8 sesji. **Fala rodzica:** 5, gate G5-legacy-runtime.

---

### F6B — Plan wielozadaniowy: sekwencja domenowa *(substrat, NIE migracja agentów)*

**Dlaczego osobny etap.** F7 to przepinanie agentów jeden po drugim na istniejący tor. To jest co
innego: **dziś tor umie przeprowadzić przez job DOKŁADNIE JEDNEGO agenta.** Zlecenie „zrób research,
napisz artykuł, dorób grafikę" dostanie jedno zadanie i jednego specjalistę; podział na kroki wydarzy
się co najwyżej *wewnątrz* jego runu, przez starą delegację — a wtedy substrat go nie widzi i po
restarcie **powtórzy całość zamiast wznowić od kroku 2**. Przepięcie kolejnych agentów tego nie
naprawi, bo brakuje nie agentów, tylko **planu**.

Manifest już to przewiduje: `ORC-DISPATCH-EDGE-01` ma `activatingWave: 'Fala 6'` i
`firstConsumerCapability: 'codingAgent'`. Ten etap to jest właśnie ta aktywacja.

#### Co JUŻ ISTNIEJE — nie budować od nowa

Audyt kodu (2026-08-10) pokazał, że maszyneria jest w większości gotowa i **wpięta w lane**:

- `spawnChildTasks` — kompletny, transakcyjny fan-out: dzieci `READY`, krawędzie `ACTIVE`
  (`REQUIRED`/`OPTIONAL`), rodzic parkowany na `WAITING_DEPENDENCY`, wake lane'a. Wszystko w jednej
  transakcji, z CAS na `stateVersion` joba.
- `resolveParentTask` — fan-in po `REQUIRED` dzieciach, i **lane woła go co takt** (gałąź
  `WAITING_DEPENDENCY` w `laneStep`). To nie jest kod na półce.
- `WAITING_DEPENDENCY` jest znane granicy kontroli, granicy żądań, mapowaniu prób i reduktorowi stopu.
- Wynik joba liczy się już **wyłącznie z zadań-korzeni** — dziecko nie zafałszuje wyniku joba.

**Jedyne wywołanie `spawnChildTasks` w całym repo to skrypt `e2e-orchestration-children.ts`.**
Klasyczne „zbudowane i zielone ≠ wpięte”: brakuje wyłącznie tego, żeby ktoś te dzieci **tworzył**.

#### Prace — pięć nazwanych braków

1. **Decyzja lane'a, która planuje więcej niż jedno zadanie.** Słownik to dziś `dispatch` (jedno
   zadanie), `wait`, `request_user`, `synthesize`, `terminalize`. Dochodzi rodzaj planujący kroki
   + nowy rodzaj propozycji (`PLAN_STEPS_V1`), zamrażany **tym samym** markerem hash/generacja co
   `PLAN_SINGLE_SERIAL_TASK_V1` — bez własnej, nowej ścieżki autorytetu.
2. **Dziecko musi nieść specjalistę i budżet.** `spawnChildTasks` wstawia dziś TYLKO `goal` — bez
   `capability`, `attemptCapMs`, `progressiveAttempt`. Bez tego każdy krok pojedzie do **agenta
   domyślnego**; to dokładnie ten bug, który już raz wystąpił przy replanie i został naprawiony
   dziedziczeniem. `ChildSpec` rozszerzony, wartości rozstrzyga **KOD** z rejestru capability, nie
   model — model nazywa capability, kod nadaje okno.
3. **Kanał wyniku między krokami.** `WorkerContext` niesie `jobGoal`, `taskGoal`, `instructions`
   i **nic z wyniku poprzednika**; `resolveParentTask` patrzy wyłącznie na FAZY dzieci, nie na ich
   wyniki. Krok 2 nie ma jak zobaczyć, co zrobił krok 1. Dochodzi jawne wejście zadania:
   **referencje** do wyników poprzedników (id wyniku/artefaktu, nie wklejona treść — duże rzeczy
   idą przez artifact store), plus ich render w prompcie.
4. **Krawędź modeluje rodzic→dziecko, nie krok→krok.** Rodzeństwo nie ma między sobą kolejności,
   a wszystkie dzieci wstają `READY` naraz.

   ##### ✅ ROZSTRZYGNIĘTE 2026-08-10 — uporządkowane rodzeństwo, nie zagnieżdżanie

   **Zagnieżdżanie ODPADA i przesądził o tym kod, nie gust.** W `spawnChildTasks` rodzic jest
   **węzłem agregującym, a nie pracą**: dostaje `WAITING_DEPENDENCY` i nigdy się nie wykonuje,
   a wykonują się dzieci. Łańcuch „root parkuje na A, A parkuje na B, B parkuje na C" oznaczałby
   więc, że realną pracą jest **wyłącznie C**, a kolejność wykonania jest **odwrócona** względem
   zamierzonej. To nie modeluje sekwencji, tylko degeneruje się do jednego kroku.

   **Wybrane: rodzeństwo z poprzednikiem.** Dziecko dostaje opcjonalne `awaitsTaskId`; z nim wstaje
   w `WAITING_DEPENDENCY` zamiast `READY`, a osobny, transakcyjny krok lane'a promuje je do `READY`
   dopiero, gdy poprzednik jest `SUCCEEDED`. Rodzic agreguje po staremu, przez istniejące krawędzie.

   **Dlaczego akurat `WAITING_DEPENDENCY`, a nie nowa faza:** tę fazę znają już granica kontroli,
   granica żądań, mapowanie prób i reduktor stopu. Nowa faza wymagałaby nauczenia o niej pięciu
   miejsc, z których każde fail-close'uje na nieznanym stanie. Sprawdzone, że nie ma kolizji
   z fan-inem: `resolveParentTask` szuka krawędzi, w których dana zadanie jest RODZICEM — czekający
   krok żadnych nie ma, więc funkcja zwraca `false` i idzie dalej.

   **Poprzednik `PARTIAL` NIE odblokowuje kolejnego kroku** (blokuje jak porażka). Krok sekwencji
   konsumuje wyjście poprzednika; budowanie na niekompletnym wejściu daje wiarygodnie wyglądającą
   odpowiedź z błędnych danych — dokładnie tę klasę, której ten projekt unika wszędzie indziej.
   Wartość wyodrębniona jako stała, żeby dało się to zrewidować pomiarem, a nie przez przepisywanie.
5. **Bramy Tier-2 — ZMIERZONE 2026-08-10, nie zgadnięte.** Odpalony probe: job z planem
   dwustopniowym, `cancelJob`, potem drain lane'a. Wynik jest **lepszy i gorszy** niż notatka
   w manifeście sugerowała:
   - ✅ **stop DOCIERA do wszystkich zadań** — rodzic i oba kroki lądują w `CANCELLED`,
     **żadnej sieroty**;
   - ❌ **job NIGDY się nie domyka**: zostaje `phase: RECONCILING`, `terminalOutcome: null`,
     `pendingTerminalOutcome: CANCELLED`, `terminalBarrierMode: BLOCKED_UNSUPPORTED`,
     `blocker: dispatch_edge_present`, plus alert `terminal_barrier_unsupported`.

   Czyli substrat **fail-close'uje głośno i uczciwie** — odmawia udawania, że rozliczył krawędzie,
   i woła operatora. Praca do zrobienia jest więc **węższa niż „napraw cancel"**: nauczyć
   `FLAT_STOP_V1` rozliczać krawędzie, gdy wszystkie zadania są już terminalne, żeby anulowany
   plan wielokrokowy mógł osiągnąć `CANCELLED` zamiast wisieć w `RECONCILING`.

   **⚠️ KOLEJNOŚĆ: ta praca idzie PRZED decyzją lane'a (pkt 1).** Odwrotnie pierwszy plan
   wyprodukowany przez model trafiłby po anulowaniu w barierę fail-closed i zawisł — a to jest
   dokładnie ten kształt („mechanizm pod nadzór człowieka, uruchomiony bez człowieka"), którego
   ten projekt unika. Ścieżka ZWYKŁEGO ukończenia działa (dowód: e2e w `check:multi-step-plan`
   dociąga plan 3-krokowy do `COMPLETED`); niedomknięty jest wyłącznie tor STOP.

#### Postęp

- ✅ **Slice 1 (`c1ad2e7`)** — kroki niosą własne capability i budżet, rodzeństwo ma kolejność
  (`awaitsTaskId`), `promoteSequencedSteps` zwalnia następny krok po `SUCCEEDED` poprzednika
  i blokuje **cały ogon** przy porażce. Model sekwencji rozstrzygnięty: uporządkowane rodzeństwo,
  nie zagnieżdżanie.
- ✅ **Slice 2 (`69ae719`)** — krok widzi wynik poprzednika: `WorkerContext.upstream`
  (referencje + wycinek 2 kB, nie cały ładunek) i render w prompcie **poza**
  `classificationPrompt`, żeby gadatliwość poprzednika nie zmieniała klasyfikacji głębokości.
- ✅ **Slice 3 ZROBIONE 2026-08-10** — anulowany plan wielokrokowy **domyka się**.

  **Pierwsze podejście cofnięte, drugie trafiło — bo domknąłem mapę zamiast łatać dalej.**
  Zatrzask miał cztery punkty, a decydujący był **pierwszy, nie ostatni**: `cancelJob`
  w `control-boundary.ts` klasyfikuje kształt **w momencie anulowania**, czyli wtedy, gdy kroki
  planu z konieczności jeszcze żyją, i stamtąd wywodzi `terminalBarrierMode`. Skan odzysku patrzy
  wyłącznie na joby `FLAT_STOP_V1`, więc raz zatrzaśnięty job **nigdy nie wracał pod rozpatrzenie**
  — poprawianie samego reduktora nie mogło pomóc. Szukałem strażnika NIŻEJ; siedział WYŻEJ.

  **Rozwiązanie to jedno rozróżnienie:** `pending` („kształt znany, praca się jeszcze odkłada")
  kontra `!supported` („kształt nieznany"). Plan w trakcie anulowania jest `pending` → zero
  blockera → job zachowuje `FLAT_STOP_V1` i istniejąca maszyneria probe/backoff przegląda go
  ponownie, gdy kroki się odłożą. Wtedy klasyfikator zwraca `supported`, a krawędzie są rozliczane
  **w tej samej transakcji co terminal**.

  **⚠️ ISTNIEJĄCE TESTY ZŁAPAŁY REALNĄ REGRESJĘ, którą wprowadziłem.** Pierwsza wersja uznawała za
  `pending` każdy job z krawędziami i nieterminalnymi zadaniami — w tym taki z krawędzią
  **wiszącą**, wskazującą na nieistniejące dziecko. Takie dziecko **nigdy się nie odłoży**, więc
  zamieniłbym głośną blokadę na **nieskończone czekanie**. Dwa przypadki w
  `e2e:orchestration-terminal-stop` i `e2e:orchestration-stop-control-recovery` budują dokładnie
  ten kształt i padły. Warunek zawężony: `pending` wymaga, żeby **każda** krawędź łączyła dwa
  zadania TEGO joba. Niespójna topologia dalej blokuje i woła operatora.

  **DOWÓD:** `check:multi-step-plan` (15 asercji) — anulowanie planu 3-krokowego kończy job jako
  `CANCELLED`, wszystkie zadania `CANCELLED`, wszystkie krawędzie `SETTLED`, a przy anulowaniu job
  **nie jest** zatrzaskiwany; plus osobna asercja, że krawędź wisząca **nadal** blokuje. Do tego
  zielone: `terminal-stop`, `stop-control-recovery`, `attempt-stop`, `process-supervisor`,
  `children`, `control`, `orchestration-store`, `orchestration-coverage`.

- ✅ **Slice 4 ZROBIONE 2026-08-10** — **model potrafi stworzyć sekwencję**, więc plan
  wielokrokowy jest wreszcie osiągalny z realnego żądania, a nie tylko z kodu.

  **Nowy rodzaj decyzji `plan_steps`** (2–8 kroków, walidowane jak każda inna decyzja: krok nie może
  nieść `taskId`, budżetu ani niczego, co należy do Service'u). Osobny rodzaj, a nie powtarzany
  `dispatch`, bo sekwencja to **jedna decyzja o kształcie całego joba, zamrożona raz** — emitowanie
  `dispatch` w kółko znaczyłoby przeplanowywanie przy każdej aktywacji, innym wywołaniem modelu za
  każdym razem, i job w połowie zaplanowany po restarcie.

  **Realizacja dwoma idempotentnymi ruchami — ścieżka autorytetu NIETKNIĘTA:**
  1. propozycja zamraża **listę kroków** na rodzicu, którego commit zapisuje jako
     `WAITING_DEPENDENCY` (czyli niedispatchowalny — nie ma okna, w którym plan poleciałby jako
     zwykła praca do jednego agenta);
  2. osobny ruch lane'a (`materializePlannedSteps`) widzi rodzica z planem i **bez krawędzi**
     → woła istniejące `spawnChildTasks`, łańcuchując krok po kroku.

  Crash pomiędzy kosztuje jeden budzik: lista kroków żyje na rodzicu, więc informacja do odzysku
  **przeżywa aktywację, która ją wyprodukowała**. Nie trzeba było rozszerzać
  `commitPlanningActivation` — zmienił się payload, nie gwarancje.

  **Budżety nadaje KOD.** Model nazywa capability z zamkniętego menu, `attemptCapFor` /
  `progressiveAttemptFor` wyliczają okno — dokładnie ta sama zasada co przy pojedynczym zadaniu.

  **DOWÓD:** `check:multi-step-plan` (17 asercji) — decyzja `plan_steps` z trzema specjalistami daje
  trzy realne zadania wykonane w kolejności, a writer dostaje 900 s **wyliczone przez kod, nie
  podane przez model**; plus asercje bezpieczeństwa na rozmiar planu i na to, że krok nie może
  rościć sobie autorytetu.

**F6B ZAMKNIĘTE — cztery slice'y, wszystkie z dowodem.** Zlecenie obejmujące kilku specjalistów
przechodzi dziś przez substrat jako **plan**: model go proponuje, kod zamraża, kroki wykonują się
w kolejności, każdy jako własne trwałe zadanie z własnym budżetem, widząc wynik poprzednika;
porażka blokuje ogon zamiast budować na niczym, a anulowanie domyka job i rozlicza krawędzie.

> ⚠️ **Sprostowanie 2026-08-12:** „model go proponuje" nie było prawdą aż do
> `GAP-PLAN-STEPS-01` — decyzja `plan_steps` nie występowała w ŻADNYM promptcie,
> więc żaden model nie mógł jej wybrać. Cała reszta zdania była i jest prawdziwa.
> Szczegóły niżej, w sekcji „SPROSTOWANIE".

**Czego F6B świadomie NIE zrobiło** (do rozważenia dopiero z pomiarem, nie z intuicji):
równoległe wykonanie rodzeństwa (wymaga >1 pętli workera i bramy G8), spekulacja
(`ORC-SPECULATION-01`), zagnieżdżone joby ATTACHED (`ORC-ATTACHED-01`), oraz przekazywanie wyniku
**głębiej niż o jedno ogniwo** — dziś krok widzi bezpośredniego poprzednika, nie cały łańcuch.

#### Definicja ukończenia — dowód, nie deklaracja

- **E2E:** zlecenie 3-krokowe przez Meta Front → w bazie **3 zadania + krawędzie**, każde
  z **innym** capability zamrożonym w planie, wykonane w zadanej kolejności.
- **Restart w środku kroku 2:** po boocie krok 1 pozostaje zaliczony, wznawia się wyłącznie krok 2.
  Dowód z `orch_job_attempts`: `WORKER_LOST` **tylko** przy kroku 2.
- **Kanał wyniku:** krok 2 dostaje w prompcie referencję do wyniku kroku 1 — dowód **ze zrzutu
  prompta**, nie z założenia, że „powinien dostać”.
- **Cancel:** anulowanie joba z żywymi dziećmi zatrzymuje wszystkie, zero sierot w
  `orch_job_attempts`, job terminalizuje **raz**.
- **Tryby krawędzi przeżywają nową ścieżkę:** `OPTIONAL` dziecko pada → job `COMPLETED`;
  `REQUIRED` pada → job `FAILED`.
- **Brama:** nowy `check:multi-step-plan` w `check:all`, plus canary live na jednym realnym
  zleceniu domenowym przechodzącym przez **dwóch różnych** agentów.

**Czego ten etap świadomie NIE robi:** równoległego wykonania rodzeństwa (wymaga >1 pętli workera
i bramy G8 — patrz F8), spekulacji (`ORC-SPECULATION-01`), zagnieżdżonych jobów ATTACHED
(`ORC-ATTACHED-01`).

**Ryzyko:** średnie. Substrat istnieje i jest przetestowany, ale cancel/fence na dzieciach to
Tier-2, a reduktor stopu trzeba otworzyć na krawędzie — czyli dotknąć kodu, który dziś fail-close'uje.
**Rozmiar:** 3–5 sesji. **Fala rodzica:** 6, kontrakt `ORC-DISPATCH-EDGE-01`.

**Kolejność względem F7:** przed migracją agentów pipeline'owych (Fala 7). Migracja chefa/writera/
designera bez planu wielozadaniowego zakonserwuje obecny kształt — każdy z nich musiałby dalej
delegować wewnątrz runu, czyli dokładnie to, co ten etap usuwa.

#### F6B — SPROSTOWANIE: „ZAMKNIĘTE" było o jedno ogniwo za wcześnie ✅ *(2026-08-12, `GAP-PLAN-STEPS-01`)*

Wpis powyżej mówi: *„model go proponuje, kod zamraża, kroki wykonują się w kolejności"*.
**Pierwsza połowa tego zdania nie była prawdą przez cały czas od zamknięcia etapu.**

Zbadane przy rozpoznaniu domeny coding (bo `coding → review` to kanoniczna sekwencja
dwukrokowa, czyli dokładnie kształt, dla którego F6B powstało):

| warstwa | stan |
|---|---|
| kontrakt `plan_steps` + walidator (2–8 kroków, `{goal, capability}`) | ✅ był |
| `activations.ts:1276` — zamrożenie planu, **budżet per krok z capability** | ✅ był |
| `lane-orchestrator.ts:182` `materializePlannedSteps` w ŻYWYM lane | ✅ był |
| `lane-orchestrator.ts:190` `promoteSequencedSteps` | ✅ był |
| `check:multi-step-plan` (17 asercji) | ✅ był |
| **`prompts/lane-orchestrator/base.md`** | 🔴 nagłówek „**The five decisions**", bez `plan_steps` |
| **gałąź PLAN w `buildDecisionPrompt`** | 🔴 **zero słownika decyzji** — cel, menu capability, „Reply with one JSON decision object" |

`grep -rn plan_steps src/` → kontrakt, store, test. **Zero producentów.**

**Skutek:** każdy job od F6B jechał jako pojedyncze zadanie. Zlecenie na dwóch
specjalistów albo wciskało się w run jednego agenta, albo szło do tego, który
najlepiej pasował do przepisanego celu.

**Dlaczego brama tego nie widziała:** `check:multi-step-plan` **sam konstruuje**
obiekt decyzji i podaje go do store'u. Dowodzi, że store wykona sekwencję —
nie że ktokolwiek o nią prosi. Ten sam kształt co przy kanale artefaktów.
**Trzeci raz w tym projekcie test pisany z wyobrażenia o danych, nie z danych.**

**Naprawa (4 pliki, brakowało OGNIWA, nie maszynerii):**
- `prompts/lane-orchestrator/base.md` — `plan_steps` w słowniku + reguła kształtu kroku
- `execution/lane-decider.ts` — gałąź PLAN wymienia trzy wykonywalne decyzje
- `store/final-decision.ts` — alert `final_decision_unexecutable_kind`, bo `plan_steps`
  przy ocenie **przechodzi w terminalizację**, czyli kończy job decyzją znaczącą
  „jest jeszcze robota"
- `check:lane-decider-model` — 4 asercje

**Granica jest wymuszona strukturalnie:** planowanie odpala się z `laneStep`
wyłącznie przy `tasks.length === 0`, więc sekwencji nie da się zaproponować dla
joba, który ma już pracę. Prompt oceny dalej podaje tylko swoje trzy decyzje.

**Dowód, że brama nie jest teatrem:** dwie z czterech asercji **oblewają na
poprzednich promptach** (sprawdzone odwróceniem zmiany przez `git stash`).
Pozostałe dwie pinują kontrakt i przechodziły od zawsze — dokładnie tak jak
maszyneria.

**CANARY 2026-08-12 — model SIĘGNĄŁ po `plan_steps` za pierwszym razem.**
Świeża baza, zlecenie „zbadaj ceny masła, potem napisz 300 słów dla restauratorów":

```
task_5b3a98c9  WAITING_DEPENDENCY  plannedSteps=[…→researcherAgent, …→writerAgent]
task_9abe1cd1  SUCCEEDED   cap=researcherAgent  capMs=300 000    → 2793 zn. + 1 artefakt
task_85762ab1  DISPATCHED  cap=writerAgent      capMs=2 700 000  awaits=task_9abe1cd1
krawędzie: 2, obie REQUIRED     zero alertów operatorskich
```

Obie połowy projektu zadziałały: **model** wybrał kształt i specjalistów,
**kod** policzył okno per krok z capability (researcher 300 s dla klasy `minutes`,
writer 2700 s = jego `maxCapMs` z earned-time). Brak alertu potwierdza, że
decyzja przyszła od modelu, nie z deterministycznego fallbacku. `maxGap` kroku 1: 5,6 s.

**NIEZWERYFIKOWANE — krok 2 NIE dowiózł, przerwałem go świadomie.** `writerAgent`
trafił na niespełniony GoalContract i zamiast pisać tekst **zdelegował do
`deliberationAgent`** zadanie „Diagnose why a GoalContract … is stuck". Rada odbyła
dwie rundy grepując repozytorium. Nic nie wyszło poza proces (sprawdzone: zero
zapisów w plikach i repo, zero approvals, zero background tasks, wszystkie
wywołania to odczyty), ale run przestał pracować nad swoim briefem, więc został
zatrzymany zamiast palić okno 45 min.

**Dwa znaleziska z tego przebiegu, na razie bez bramy:**
1. **Workery rady deliberation mają odziedziczone narzędzia Workspace**
   (`grep`, `read_file`, `list_dir`) mimo deklaracji „text-only". `docs/STATUS-AGENTOW-SILNIK-V2.md`
   oznacza to 🔴 od 2026-08-10 z analizy kodu — **to pierwsza obserwacja na żywo**.
2. **Agent potrafi porzucić brief na rzecz SAMODIAGNOZY silnika, w którym działa.**
   Kontrakt headless mówi „skończ produktem", nie mówi „nie debuguj orkiestratora".
   U writera to nieszkodliwe, bo umie tylko czytać. **Ten sam odruch u `codingAgent`,
   który umie pisać i mergować, nie jest nieszkodliwy** — patrz F7 §codingAgent.

---

### F7 — Fale 6–9: migracja agentów i narzędzi

#### F7 — SITO MIGRACYJNE (obowiązuje każdego agenta)

Pełne kryteria: **`docs/MIGRACJA-AGENTA-NA-V2.md`** (K1–K10 + protokół canary +
karta per agent). Powstało z badania kodu 2026-08-11.

**Najważniejsze ustalenie badania — legacy to NIE jedna ścieżka, tylko trzy**, i od
tego zależy, czy V2 jest ulepszeniem czy ryzykiem:

| ścieżka legacy | kto | co dostaje | V2 jest… |
|---|---|---|---|
| dedykowany harness | coding, automation, knowledge, review | profil + **precontext domenowy** | ⛔ **gorsze** — V2 nie podaje `contextBuilder` |
| pipeline + reflektor | chef, content, hunt, writer, film, music | profil pipeline'owy | porównywalne |
| **generyczna** | **design, analytics, crm, sales, marketing i reszta** | **gołe `agent.generate`** | ✅ **wyraźnie lepsze** |

**Stąd kolejność migracji:** najpierw ścieżka generyczna (V2 tylko dokłada), na
końcu agenci z dedykowanym harnessem (V2 musi się najpierw nauczyć precontextu).

**Pamięć warstwowa — zbadana i rozbrojona.** Trzy warstwy, każda inna:
wątek Mastry jest świeży na obu ścieżkach (legacy: `delegation-<uuid>`, V2:
`orch-v2-job:<id>`), `resource` różni się przestrzenią nazw (celowa izolacja
canary), a **`memory_recall`/`memory_write` czytają globalną `system_knowledge`,
więc działają IDENTYCZNIE**. Skille i `ToolSearchProcessor` to warstwa AGENTA,
nie harnessu, więc przenoszą się same.

#### F7 KROK 0 — pas gotowości (ZROBIONE 2026-08-10)

Decyzja użytkownika: **najpierw pas gotowości przez cały roster, potem migracja**. Wykonany jako
**pomiar**, nie jako ręczne przygotowywanie 18 agentów — przygotowanie przed konsumentem to
w tym projekcie wielokrotnie opłacony antywzorzec (`findArtifactIds` nie działał dla ŻADNEGO
agenta, liveness był nieosiągalny, `designAgent` obiecywał pliki bez narzędzia do zapisu).

**`npm run audit:agent-readiness`** — pięć kryteriów, każde wyprowadzone z defektu, który ten
system realnie wypuścił: sufit kroków (chef), zapisywalność deliverable (design), zegar vs kształt
pracy (researcher), promień rażenia, oraz **NOWE z F6B: czy wynik da się skonsumować jako wejście
następnego kroku**.

**⚠️ NAJWAŻNIEJSZE ZNALEZISKO — inne niż mówiła linijka audytu.** Mastra ma własny domyślny sufit
**`maxSteps = 5`** (`__text`/`__stream` w `@mastra/core`, odczytane z paczki, nie założone). Agent
bez deklaracji nie jest „bez limitu" — jest **cicho ścięty na piątym kroku** wszędzie poza
harnessem. A czwórka bez deklaracji to:

| agent | narzędzia | sufit przed | po |
|---|---|---|---|
| `crmAgent` | 1 | 5 | **5** (świadomie — jeden lookup read-only) |
| `analyticsAgent` | 8 | 5 | **25** (nie mógł wywołać własnych kolektorów) |
| `salesAgent` | 7 | 5 | **25** (pisze do CRM, Gmaila, kalendarza) |
| `marketingAgent` | **23** | 5 | **25** (najgorszy przypadek na rosterze) |

To nie była kosmetyka audytu, tylko **realne ograniczenie funkcjonalne**: `marketingAgent`
z 23 narzędziami nie mógł przeprowadzić żadnego wieloetapowego przepływu.

**Poprawiony został też sam audyt**, bo mówił nieprawdę w groźną stronę: werdykt „deklaruje mniej
niż profil → **dekoracyjne**" zachęcał do usunięcia deklaracji, która **poza harnessem jest jedynym
sufitem, jaki istnieje**. Skasowanie jej cofnęłoby marketing do pięciu kroków.

**Zegar researchera — rozstrzygnięty POMIAREM, nie ruchem liczby.** 50 kroków w oknie 300 s
wyglądało na sprzeczność; **12 zakończonych runów trwało 1–11 s** (27× zapasu), więc żaden z limitów
nigdy się nie zbliżył do związania. Zmiana sufitu na 12 płytkich próbkach byłaby zgadywaniem
z dodatkowymi krokami — ustalenie zostaje jako **latentne**, z zapisanym pomiarem i warunkiem, co
je rozstrzygnie.

**Stan po paście:** 18/18 agentów bez zastrzeżeń blokujących, 1 latentne do rozważenia.
**Uwaga, którą audyt drukuje sam:** „gotowy" znaczy „nic zmierzalnego nie stoi na przeszkodzie",
NIE „przejdzie canary" — każdy dotychczasowy canary znalazł defekt, którego żadna z tych reguł
by nie wyłapała.



Realizowane **stopniowo**, agent po agencie — nie jako jeden skok.

| Fala | Zakres | Rozmiar |
|---|---|---|
| 6 | dedicated full-harness agents (meta, coding, automation, knowledge…) | 3–5 |
| 7 | pipeline, media i special direct (chef/content/hunt/writer/film/music) | 3–5 |
| 8 | bounded i hybrid capabilities | 2–4 |
| 9 | workflow-only + jawne dynamic workers | 2–3 |

**Definicja ukończenia (per agent):** capability ma manifest, policy routing, cancel/deadline
test, idempotency dla write, approval dla destructive — i **przechodzi canary**.

**Ryzyko:** średnie per agent (izolowane). **Rozmiar:** 10–17 sesji łącznie.

---

#### F7 — AGENT 1: `designAgent` ✅ *(2026-08-11)*

**Wynik canary:** `TERMINAL/COMPLETED`, jedno zadanie, **jedna próba `OK`**, zero
replanów, 18 434 zn. HTML z `<!DOCTYPE`, `fromArtifact=true`. Karta migracji:
`docs/MIGRACJA-AGENTA-NA-V2.md` §5.

**Co canary potwierdził (K1 na żywo):** klasyfikator głębokości ocenił to zlecenie
na `fast` = 10 kroków, a harness **podniósł sufit do zadeklarowanych przez agenta
150**. Bez tej deklaracji wieloetapowy pipeline designu jechałby na dziesięciu
krokach. Reguła „harness może PODNIEŚĆ, nigdy obniżyć" zadziałała w produkcyjnym
kształcie, nie w teście.

**Co canary ZŁAPAŁ — martwy kanał artefaktów (`GAP-ART-HANDOFF-01`):**

Objaw był jednym pustym polem: `producer.artifacts: []`, mimo że plik powstał
(artefakt `document`, 18 450 zn., w Mongo). Przyczyny były **dwie i niezależne**,
każda wystarczająca sama:

1. **Nikt kanału nie wypełniał.** `ModelCaller` zwracał `{ text, fromArtifact }` —
   **bez miejsca na referencje**. `harness-agent-caller` liczył id artefaktów
   (żeby zdecydować, czy deliverable to zapisany dokument) i **wyrzucał je**.
2. **Czytnik szukał złego pola.** `readUpstreamResults` mapował `a.id`, a kontrakt
   od zawsze nazywa to `artifactId` — odrzuciłby każdą referencję, nawet gdyby
   ktoś je wysłał.

**Zmierzony skutek:** krok designu zapisywał 18 KB dokumentu, a następny krok
sekwencji dostawał **2 000-znakowy urywek i żaden sposób, by sięgnąć po resztę** —
podczas gdy jego prompt już obiecywał „Artefakty (pełna treść pod tymi id)".
Awaria dotyczyła **każdego agenta produkującego pliki**, nie tylko designu.

**Dlaczego nie wykrył tego żaden test:** `check:multi-step-plan` sam wstrzykiwał
`upstream: [{ artifacts: ['art-1'] }]` i sprawdzał, że prompt to renderuje.
Dowodził renderera — nie tego, że producent kiedykolwiek coś tam wkłada. **Trzeci
raz w tym projekcie ten sam wzorzec: test pisany z wyobrażenia o danych zamiast
z danych, które realnie płyną.**

**Naprawa (4 pliki + brama):**
- `contracts/result-envelope.ts` — eksport `ProducerArtifactRef`, żeby oba końce
  brały kształt z kontraktu, a nie z pamięci
- `execution/gateway.ts` — `ModelCaller` i `BoundedCallResult` dostają kanał;
  `modelResultToProducer` przenosi go do koperty (pomijany, gdy pusty — walidator
  odrzuca wartości nieprzeżywające JSON round-tripu)
- `execution/harness-agent-caller.ts` — buduje `{artifactId, type, summary, hash}`
  i zwraca je **obiema** ścieżkami (także gdy deliverable to tekst: run może
  zapisać plik I go omówić)
- `store/worker.ts` — czyta `artifactId`
- **`npm run check:artifact-handoff`** (6 asercji, w `check:all`) — od koperty
  producenta, przez **prawdziwy** walidator i replica set, po kontekst następnego
  workera. Jedna asercja przypina kontrakt: referencja pod kluczem `id` **musi
  zostać odrzucona**, zamiast po cichu zniknąć.

**Dowód live po naprawie:** ten sam scenariusz, świeża baza, nowy build →
`artifacts: [{artifactId: "art-52d71c2c…", type: "document", summary: "…", hash: sha256}]`,
`fromArtifact: true`. **Kryterium K9b dopisane do sita.**

**Pomiar:** `maxGap 60,1 s` przy podłodze idle designu 480 s — margines 8×.

**Czego NIE sprawdzono:** ścieżki z **płatną** generacją obrazu/wideo (canary
jechał z jawnym zakazem). `designAgent` **nie jest** w `DEFAULT_V2_CAPABILITIES`
— szedł przez `ORCHESTRATION_V2_CAPABILITIES`, produkcja bez zmian.

---

#### F7 — AGENT 2: `automationArchitect` ✅ *(canary 2026-08-11, domknięty w rundzie 4)*

**K10 — zgoda właściciela: UDZIELONA** na deploy do n8n (2026-08-11). Canary
celowo zlecił deploy **NIEAKTYWNY**: aktywacja to osobny efekt (żywe wyzwalacze),
więc nie została wzięta z tej zgody.

**✅ K3 ODBLOKOWANE — precontext dociera na V2.** `capability-precontext.ts`:
rejestr per capability, ładowany leniwie, oddający **ten sam obiekt**, który
spreaduje legacy (`automationPrecontextFields` w `automation-harness.ts`). Brama
`npm run check:capability-precontext` (4 asercje) uruchamia PRAWDZIWY harness
z atrapą wyłącznie na granicy zewnętrznej (agent) i sprawdza, że
`## Automation Passive Context` wraz z `### Credential Registry` trafia do
promptu przed treścią zadania — a agent bez precontextu dostaje wywołanie
NIEZMIENIONE. Jedna asercja pilnuje **tożsamości** obiektu, nie równości
głębokiej: kopia przeszłaby deep-check i i tak by się rozjechała.

**Canary — co zadziałało:** router wybrał `automationArchitect`, `Depth: critical`
(score 0.70, 40 kroków), liveness `maxGap 42,4 s` przy podłodze 480 s,
delegacja do Golden Path (`executeAutomationRequestTool`), a **workflow
naprawdę powstał w n8n**: `Mastra - Webhook Email Validator`, id `5KA0EzcmxyeH7kbi`,
`active=false`, utworzony 09:09:54 — zweryfikowane przez API n8n, nie przez
odpowiedź agenta.

**🔴 CO CANARY ZŁAPAŁ — `GAP-SIDE-EFFECT-RESULT-01` (NIENAPRAWIONE):**

Zadanie, które **wykonało pracę**, zostało oznaczone `FAILED` z `empty_output`.
Ciąg zdarzeń, w kolejności:

1. run zrobił 4 kroki i 3 wywołania narzędzi (`n8nGetWorkflow`, `write_file`,
   `updateWorkingMemory`) — praca realna;
2. ostatnim tekstem runu był **raport scorera harnessu** („#### Completion Check
   Results … ✅ The task is complete");
3. matcher `isFrameworkArtifactText` **słusznie** go odrzucił — to nie jest
   produkt agenta;
4. `bestDeliverable` z całego runu też był pusty (`stepTexts=[empty,empty,empty,
   269ch/framework]`), więc `bounded_text` zwrócił `empty_output`;
5. job uznał pracę za nieudaną i **odpalił zadanie od nowa** — trzecia próba
   dreptała w miejscu (reflektor: `progress_stall` na kroku 17 i 19), mimo że
   produkt już stał w n8n.

**Trop, którego NIE domknąłem (uczciwie):** w odrzuconym raporcie scorer pisze
`substantive final output (2519 chars) closed generic harness GoalContract` —
czyli **widział wynik na 2519 znaków**, którego `bestDeliverable` nie zachował,
choć `rememberDeliverable` stoi po każdym z czterech przebiegów. Skąd te 2519
znaków pochodziło, nie ustaliłem — i nie zgaduję. To jest następny krok śledztwa.

**Dlaczego to poważne, a nie kosmetyczne:** przy agencie z efektami ubocznymi
fałszywe `FAILED` znaczy **powtórzenie akcji w świecie**. W tym przebiegu
duplikat nie powstał (sprawdzone: jeden workflow w n8n), ale nic tego nie
gwarantowało.

**Kierunek naprawy (do decyzji, NIE wykonane):** architekt **ma** `artifact_put`,
a `automation_workflow` jest legalnym typem artefaktu — K2 przechodzi. Brakuje
reguły DOMKNIĘCIA runu: produkt ma zostać zapisany jako artefakt (wtedy niesie go
kanał z K9b i `fromArtifact` domyka wynik), zamiast kończyć się `write_file` plus
milczeniem. **Świadomie NIE rozluźniam „no false success" (§3.6)** — run bez
produktu ma failować; rzecz w tym, żeby produkt istniał tam, gdzie silnik patrzy.

**✅ NAPRAWIONE tego samego dnia — `GAP-SIDE-EFFECT-RESULT-01` ZAMKNIĘTE:**

Naprawa NIE rozluźnia „no false success" (§3.6). Run bez produktu nadal failuje;
zmienione zostało to, **gdzie produkt istnieje**:

- `SIDE_EFFECT_PRODUCT_CAPABILITIES` w `capability-routing.ts` — **jedna** lista
  agentów, których produktem jest efekt w świecie. Czyta ją runtime (kontrakt
  headless) **i** audyt gotowości; wcześniej te same fakty żyły ręcznie w skrypcie
  audytu i **raz już były błędne** (crmAgent jako „piszący na zewnątrz", gdy jego
  karta mówi „read-only" w pierwszej linii).
- kontrakt headless dostaje dla nich dodatkową regułę domknięcia: zapisz produkt
  przez `artifact_put` (**plik NIE wystarczy — plik jest niewidoczny dla joba**)
  i zakończ krótkim raportem z id-ami tego, co zmieniłeś w świecie.
- **reguła trafia WYŁĄCZNIE do nich.** Ośmiu wcześniej zweryfikowanych agentów
  dostaje prompt bajt w bajt taki, z jakim przechodzili canary — pilnuje tego
  osobna asercja, bo cicha zmiana promptu wszystkim to osobna migracja, nie
  poprawka jednego agenta.
- `npm run check:headless-contract` — 3 nowe asercje (reguła istnieje / nie
  wycieka do pozostałych / źródłem listy jest polityka routingu, nie kopia).

**CANARY RUNDA 2 (po naprawie), to samo zlecenie w innym wariancie:**
`TERMINAL/COMPLETED`, **1 zadanie, 1 próba `OK`, 0 replanów**. Wynik = raport
nazywający `workflowId lyKat4puV2nXxet2`, `active=false`, risk 15, status tested.
**Zweryfikowane u źródła:** workflow `Mastra - Webhook - Phone Validator` istnieje
w n8n, **NIEAKTYWNY**, utworzony 09:37:52. `Depth: deep` (0,55), `maxGap 29,0 s`.
W logu **nie ma** linii `run produced no deliverable`.

**Runda 2 zostawiła jednak połowę reguły niepotwierdzoną:** agent **nie wywołał
`artifact_put`**, więc `producer.artifacts` było puste. Diagnoza po zajrzeniu
w log: architekt robi **jedno** wywołanie (`executeAutomationRequestTool`)
i nigdy nie trzyma JSON-a w ręku — proszenie go o zapis to proszenie o duplikat
cudzej pracy, a durability zależałaby od tego, czy model zechce posłuchać.

**✅ DOMKNIĘTE DETERMINISTYCZNIE (rundy 3–4):** to **Golden Path zapisuje
wdrożony workflow jako artefakt w momencie deployu** (`automation-golden-path.ts`,
tuż po `deploy_inactive/success`, gdy obiekt workflow jest w ręku). Zapis nigdy
nie wywraca deployu — workflow już żyje w n8n, więc brak zapisu jest raportowany,
nie rzucany. Asercja w `check:automation-golden-path` (brama naprawdę deployuje
do n8n) wymaga artefaktu typu `automation_workflow` z definicją w treści.

**Runda 3 ujawniła regresję, którą wprowadziłem tą naprawą:** skoro artefakt
istnieje, `fromArtifact` podmienił czytelny raport na **3601 zn. surowego JSON-a**.
Dla designu artefakt JEST produktem; dla automatyzacji jest REFERENCJĄ, a
produktem jest raport. Rozstrzygane tym samym jednym źródłem
(`SIDE_EFFECT_PRODUCT_CAPABILITIES`), z deterministycznym dowodem po obu stronach
granicy w `check:artifact-handoff` (atrapą jest agent, artefakt zapisywany
naprawdę).

**CANARY RUNDA 4 (ostateczna):** `TERMINAL/COMPLETED`, 1 zadanie, 1 próba `OK`,
0 replanów, `fromArtifact=false`, wynik = raport (5004 zn.) + **dołączona**
referencja `art-72f2aaa9`. U źródła: `Mastra - Invoice ID Validator`,
`cvFwxEYsCml4jioA`, `active=false`, 10:00:24. `maxGap 38,8 s`. Zero linii
`run produced no deliverable`.

**✅ TROP `substantive final output (2519 chars)` DOMKNIĘTY** *(2026-08-18)*.

Przyczyna: **scorer miał WŁASNĄ definicję „wyniku runu"**. `extractScoredOutputText`
brał `record.text` bez pytania, czy to nie jest framework mówiący o runie, a w
ostateczności zwracał `JSON.stringify(output)` — serializację obiektu odpowiedzi,
która nigdy nie jest produktem i **zawsze** przekracza próg 80 znaków.

Więc scorer zamykał kontrakt celu jako „complete — substantive final output" dla
runu, którego deliverable był pusty. Dwa komponenty trzymały dwa różne pojęcia tej
samej rzeczy i rozjeżdżały się w najgorszą stronę: łagodniejszy był ten, który
decyduje o SUKCESIE. `harness-output-text.ts` dokumentował tę samą sprzeczność z
canary designu („substantive final output (684 chars)", a funkcja zwracała `''`) —
objaw opisano, przyczyny nie naprawiono.

Naprawa: scorer używa `extractDeliverableText`, czyli **tej samej** definicji co
harness. §3.6 „no false success" jest własnością PARY, nie jednej strony: czego
harness nie odda jako produkt, tego scorer nie ma prawa przyjąć jako dowód
ukończenia. Brama `check:goal-completion-scorer` ma asercję na wspólne źródło i
na zakaz powrotu `JSON.stringify(output)` — falsyfikowalną.

**Status: `automationArchitect` ZMIGROWANY** wg listy warunków z sita.
Nadal **nie jest** w `DEFAULT_V2_CAPABILITIES` — włączenie domyślne to osobna
decyzja operatora. Kryterium **K11** dopisane do sita.

---

#### F7 — AGENT 3: `huntAgent` ✅ *(2026-08-11)*

**K10 — zgoda właściciela: UDZIELONA** na zapis do CRM. Maile: agent **nie ma
narzędzia wysyłki** (tylko szkice — „send is human-gated by design" w jego
toolsecie); właściciel dopuścił jeden adres, `admin@example.com`.

**Sito bez blokad:** 150 kroków, `artifact_put`, `delegate_task` + `run_worker`,
zgoda nieblokująca, brak MCP, ścieżka pipeline (więc brak precontextu do
utracenia). Jest na liście `SIDE_EFFECT_PRODUCT_CAPABILITIES`, więc dostał regułę
domknięcia od razu.

**🔴 CO ZŁAPAŁ CANARY (runda 1) — raport ZAWYŻAJĄCY efekty w świecie:**
job skończył `COMPLETED`, a jego wynik twierdził „CRM records created" dla
DWÓCH producentów. W CRM przybył **jeden** lead (186→189 licznik: 186→187).
Drugi (Sernica Dolnośląska) leżał w bazie **od maja** i nie został tknięty —
`updatedAt 2026-05-08`, status `research_needed`. **Dla agenta piszącego na
zewnątrz to gorsze niż awaria: wygląda jak sukces i nikt tego nie sprawdza
przed działaniem na podstawie raportu.**

**Naprawa:** reguła dokładności w tym samym bloku side-effect kontraktu headless —
raportuj WYŁĄCZNIE to, co zwróciły narzędzia; „już istniał" ≠ „utworzony", a krok
pominięty ma być nazwany pominiętym. Asercja w `check:headless-contract`.

**CANARY RUNDA 2:** `TERMINAL/COMPLETED`, 1 zadanie, 1 próba `OK`, 0 replanów.
**CRM 187→189 = dokładnie 2 nowe leady, tyle samo deklaruje raport.** Trzy
artefakty w kopercie (2× `research_report` + `lead_batch`), `fromArtifact=false`,
czyli produktem jest raport, a referencje są DOŁĄCZONE. Szkice Gmaila
zweryfikowane w argumentach wywołań: `to: admin@example.com` dla obu,
temat prefiksowany `[SZKIC]`.

**⭐ Runda 2 potwierdziła też połowę reguły, której architekt nie mógł
potwierdzić:** hunt **sam** wywołał `artifact_put` — bo w odróżnieniu od
architekta trzyma swój produkt w ręku.

**⚠️ NIEZWERYFIKOWANE:** skuteczność reguły dokładności to JEDNA obserwacja, nie
dowód; treść szkiców odczytana z argumentów narzędzi, nie z konta Gmail; tekst
wyniku to sklejona narracja faz, nie zwięzły raport (czytelność, nie poprawność).

**Status: `huntAgent` ZMIGROWANY.** Nie jest w `DEFAULT_V2_CAPABILITIES`.

---

#### F7 — STYL TREŚCI I POCZTA WYCHODZĄCA ✅ *(2026-08-11)*

Wyszło z inboxu, nie z testu: właściciel otworzył szkice po canary hunta
i zobaczył dwie rzeczy.

**1. Temat maila jako mojibake — błąd MIME, nie agenta.** `buildRfc822` wpisywał
polski temat **surowo w nagłówek**, a nagłówek RFC 5322 jest z definicji ASCII.
TREŚĆ była poprawna cały czas (`Content-Type: charset=UTF-8` ją pokrywa) — i to
właśnie czyniło objaw zagadkowym: **dwie różne warstwy, brakowało jednej.**
Naprawa: kodowanie RFC 2047 (`=?UTF-8?B?…?=`) z podziałem na słowa kodowane
**po granicach ZNAKÓW, mierzonych w BAJTACH** (cięcie w środku znaku zamienia
mojibake nieodkodowane na mojibake dobrze sformowane), plus jawne
`Content-Transfer-Encoding: 8bit`.

**2. Myślnik em w treści i temacie.** Reguła istniała od dawna — ale wyłącznie
w promptach `writerAgent`, powtórzona tam **trzy razy**, i nieobecna u wszystkich
pozostałych. Dlatego writer oblewał własny run za U+2014, a hunt wysyłał go
w temacie do skrzynki właściciela. **Tak uniwersalna reguła staje się regułą
o jednym agencie: nie decyzją, tylko tym, że nikt jej nie dopisał do jedenastego
promptu.**

**Rozwiązanie — dwie warstwy, każda robi to, w czym jest dobra:**
- **prompt (prośba, szeroka):** `prompts/shared/house-style.md` = JEDNO źródło,
  doklejane przez `prompt-loader.ts` do instrukcji każdego agenta, na obu
  silnikach. `combinePrompts` dokleja raz, nie raz na plik (hunt łączy dwa
  prompty). Fragmenty (`shared/`, `_generated/`) są wyłączone, bo są wciągane
  do promptów, które regułę już niosą. Reguła podaje ZAMIENNIKI (przecinek,
  dwukropek, kropka, dywiz) — zakaz bez alternatywy jest obchodzony, nie
  przestrzegany.
- **lejek (gwarancja, wąska):** `buildOutboundMime` normalizuje U+2014 w temacie
  I treści każdej wychodzącej wiadomości. Model może zapomnieć; lejek nie.
  Półpauza (U+2013) zostaje nietknięta — jest poprawna w zakresach („10–12"),
  a ciche przepisywanie ich byłoby innym błędem w przebraniu tej poprawki.

**Dlaczego nie normalizujemy WSZYSTKIEGO, co produkują agenci:** myślnik bywa
poprawny w artefaktach nietekstowych (typografia w HTML designu, cytat ze źródła,
kod). Ciche przepisywanie tam to osobny defekt. Twarde wymuszenie zostaje tam,
gdzie treść wychodzi do człowieka, oraz u writera, gdzie interpunkcja JEST
jakością produktu.

**Bramy:** `npm run check:outbound-mail` (7 asercji — temat dekodowany Z POWROTEM
i porównany z oryginałem, nie dopasowywany po kształcie: dopasowanie kształtu
przeszłoby dla kodowania dobrze sformowanego i błędnego) oraz
`npm run check:house-style` (5 asercji — reguła jest w instrukcjach, które agent
NAPRAWDĘ dostaje, dokładnie raz).

**⚠️ REGUŁA KOSZTUJE MIEJSCE W PROMPCIE — brama to złapała.** Pierwsza wersja
bloku (990 zn., z uzasadnieniem „dlaczego") zjadła margines budżetu promptu:
`check:meta-prompt-size` zszedł z wymaganych −25% do **−24,0%** i OBLAŁ. Gate ma
rację: dokładany do KAŻDEGO agenta blok płaci się tyle razy, ilu jest agentów.
Skrócone do 312 zn. (sam zakaz plus zamienniki, uzasadnienie zostało tutaj)
→ **−25,5%**. Reguła dla przyszłych bloków wspólnych: uzasadnienie do
dokumentacji, do promptu tylko instrukcja.

**⚠️ NIEZWERYFIKOWANE:** szkice utworzone PRZED tą poprawką nadal mają zepsute
tematy — nie ruszałem ich, to skrzynka właściciela. Kopie szkiców zapisane
w CRM (`metadata.draft`) nie przechodzą przez lejek pocztowy, więc mogą nadal
zawierać U+2014. Reguła w prompcie to prośba do modelu; twardą gwarancję ma
tylko poczta wychodząca.

---

#### F7 — AGENT 4: `marketingAgent` ✅ *(2026-08-11)*

**K10:** kalendarz + CRM + maile wyłącznie na adres właściciela; NotebookLM
(tworzenie, dodawanie źródeł, **usuwanie**) autoryzowane osobno. Agent **nie ma
narzędzia wysyłki maila** — tylko szkice.

**🔴 DEFEKT 1 — ROUTER NIE WIDZIAŁ GRANIC (`GAP-ROUTER-BOUNDARY-01`).** Dwie
pierwsze rundy trafiły do `crmAgent`: agenta read-only z oknem 120 s. Dwa
`TIMED_OUT`, trzecia próba zwróciła PLAN („Wykonam zapytanie…"), a job zamknął się
jako **COMPLETED**. Realnie: JEDNO wywołanie `searchLeadsTool`, zero zapisów.
**Karta crm mówiła wprost `whenNotToUse: ['CRM writes → salesAgent']` — router
tego zdania NIGDY nie dostawał.** `forDecider()` składał opis z `oneLiner`
i **dwóch** pierwszych `whenToUse`; `whenNotToUse` nie było w menu w ogóle.
Dlatego pierwsza poprawka kart nic nie dała: dopisane zdolności marketingu
(kalendarz, notatniki) wylądowały na pozycjach 3-5 i zostały **ucięte**.
Naprawa: menu niesie `NOT for: …` (2 pozycje) i `Use for:` podniesione do 3;
w karcie marketingu rozstrzygające zdolności przesunięte na początek.

**🔴 DEFEKT 2 — RUN NIE WIEDZIAŁ, JAKI JEST DZIEŃ.** Runda 3 dowiozła pracę
(zapis w CRM i wydarzenie potwierdzone w historii leada), ale wydarzenie miało
datę **2026-05-28, trzy miesiące WSTECZ**, opisane w raporcie jako „przyszły
tydzień". Przyczyna: nic nie podaje bieżącej daty, a jedyną datą w zasięgu był
**przykład w opisie narzędzia** (`e.g., 2026-05-10T12:00:00Z`) — agent zakotwiczył
się na nim i dodał dwa tygodnie. Naprawa dwuwarstwowa: kontrakt headless podaje
`Today is <ISO>` (jedno miejsce, każdy agent), a narzędzie kalendarza **odrzuca
datę z przeszłości** (prompt prosi, narzędzie gwarantuje); z opisu usunięto
przykładową datę.

**⭐ Defekt 3, znaleziony przy okazji:** `marketingAgent`, `salesAgent`
i `n8nMcpEngineer` były na liście `SIDE_EFFECT_PRODUCT_CAPABILITIES` — czyli
kontrakt kazał im zapisać produkt przez `artifact_put` — **nie mając tego
narzędzia**. To luka wprowadzona przeze mnie razem z tą listą, w tej samej klasie
co designAgent. Wszystkie trzy dostały narzędzia artefaktów, a
`check:deliverable-capability` pilnuje teraz niezmiennika: kto jest na liście,
musi mieć czym zapisać.

**CANARY RUNDA 4:** `TERMINAL/COMPLETED`, 1 zadanie, 1 próba `OK`, router =
`marketingAgent`, wydarzenie na `2026-08-18T10:00Z` = faktycznie przyszły tydzień.

**⚠️ NIEZWERYFIKOWANE:** agent nadal kończy raport wzmianką o artefakcie, którego
NIE zapisał (`artifacts: []`) — słabsza wersja defektu hunta. `marketingAgent` nie
ma `delegate_task` ani `run_worker` (na legacy też nie miał, więc nie regresja).
**Wydarzenie z rundy 3 (`krqdt0robguapg21bindp6gp3g`, 2026-05-28) zostało
w kalendarzu właściciela — nie usuwałem go.**

**Status: `marketingAgent` ZMIGROWANY.** Nie jest w `DEFAULT_V2_CAPABILITIES`.

---

#### F7 — `salesAgent`: ŚWIADOMIE POMINIĘTY *(decyzja właściciela 2026-08-11)*

**Nie migrujemy go teraz.** Właściciel planuje przebudowę tej domeny i chce
najpierw rozstrzygnąć jej kształt. To decyzja produktowa, nie techniczna blokada.

**Ustalenie z badania kodu, istotne dla tej przebudowy — `salesAgent` jest
JEDNYM I DRUGIM naraz:**

| warstwa | co to jest |
|---|---|
| definicja | **prawdziwy agent** Mastry: prompt `sales/base`, 10 narzędzi, `maxSteps: 25` |
| realne użycie | **trzy sztywne workflow** — `proposal-generator`, `meeting-scheduler`, `onboarding-checklist` (po 4-5 deterministycznych kroków) |

W tych workflow agent jest wołany **jako funkcja, nie jako agent**:
`await salesAgent.generate(prompt)` — jedno wywołanie, bez narzędzi, wynik
parsowany **regexem** szukającym bloku ```json. Workflow sam ładuje leada z CRM
i sam składa prompt. **Dziesięć narzędzi agenta jest na tej ścieżce nieosiągalne**,
a wywołanie omija harness w całości: bez profilu głębokości, bez reflektora, bez
liveness.

**Co z tego wynika dla przebudowy:** wybór nie brzmi „agent czy workflow", bo dziś
jest to agent użyty jak funkcja. Pytanie brzmi, które z trzech workflow mają
zostać deterministyczne (bo ich kroki są naprawdę stałe), a które powinny stać się
zadaniem agenta z narzędziami. Migracja na V2 ma sens dopiero po tej decyzji —
przeniesienie dzisiejszego kształtu utrwaliłoby „agenta jako generator JSON-a".

---

#### F7 — AGENT 5: `knowledgeAgent` ✅ *(2026-08-11)*

**K10:** zgoda na **utworzenie jednego notatnika i zapytanie**; usuwanie jawnie
wyłączone ze zlecenia (agent tę zdolność ma).

**⭐ PIERWSZY CANARY, KTÓRY NIE ZNALAZŁ NOWEGO DEFEKTU** — i to jest sprawdzalny
wynik, nie szczęście: trzy mechanizmy, które go dotyczyły, zostały naprawione
przy poprzednich agentach (rejestr precontextu, kanał artefaktów, kontrakt
headless). Migracja zajęła jedną rundę zamiast czterech.

**K3 UDOWODNIONE NA DRUGIM AGENCIE — mechanizm jest ogólny, nie tezą.**
Telemetria `agent_events / precontext_injected`:

| agent | feature | injected | tokeny |
|---|---|---|---|
| `knowledgeAgent` | `knowledge_precontext` | **true** | 321 |
| `automationArchitect` | `automation_precontext` | **true** | 411 |
| `designAgent` | `depth_context` | **false** | 0 |

Trzeci wiersz jest tu równie ważny: agent generyczny **nie** dostaje precontextu
domenowego, czyli rejestr nie wycieka na wszystkich.

**K8 — PIERWSZY ŻYWY TEST ZALEŻNOŚCI MCP.** Run V2 wykonał `notebook_create`,
`source_add` i `notebook_query` przez sidecar NotebookLM. Dotąd żaden canary nie
dotknął agenta, którego zdolności pochodzą z zewnętrznego serwera. Przy okazji
K5 na żywo: `search_tools` + `load_tool` w tym samym runie.

**CANARY:** `TERMINAL/COMPLETED`, 1 zadanie, 1 próba `OK`, 0 replanów. Notatnik
`bb1acf41…`, źródło `a047e5f7…`, odpowiedź z zapytania w wyniku. **Zero wywołań
usuwających.**

**⚠️ NIEZWERYFIKOWANE:** istnienie notatnika potwierdzone łańcuchem wywołań
(create → source_add → query na TYM id), nie odczytem z konta Google. Ścieżka
usuwania świadomie nietestowana.

---

#### F7 — STRAŻNIK TWIERDZEŃ O ARTEFAKTACH ✅ *(2026-08-11)*

Właściciel słusznie zakwestionował moje „nie naprawiłem, bo reguła w prompcie bez
canary to deklaracja". To prawda o REGULE W PROMPCIE, ale nie wynika z niej, że
defektu nie da się naprawić — **orkiestrator zna dokładny zbiór artefaktów, które
run zapisał**, więc twierdzenie o artefakcie spoza tego zbioru jest sprawdzalnym
fałszem, nie kwestią stylu.

`artifact-claim-guard.ts` porównuje raport z **własnym rejestrem zapisów runu**
(`run-artifacts`, zapisywanym w momencie zdarzenia). Wzorzec ten sam co strażnik
prawdomówności Meta Frontu.

**Dlaczego ANOTUJE, a nie failuje:** to są capability, których produktem jest
efekt w świecie. Nieudana próba jest **powtarzana**, a powtórzenie powtarza
efekt — dokładnie ta szkoda, dla której otwarto `GAP-SIDE-EFFECT-RESULT-01`.
Praca się wydarzyła i raport jest w większości prawdziwy; fałszywe jest jedno
zdanie, więc korygowane jest jedno zdanie, przez runtime, w wyniku który czyta
człowiek.

Matcher jest **wąski celowo** (kształt `art-…` oraz `Artifact_ID:`): strażnik,
który anotuje poprawny raport, jest gorszy niż jego brak, bo to anotacja jest
tym, co użytkownik czyta. Cztery asercje w `check:artifact-handoff`, w tym ta
najważniejsza — **prawdziwy raport zostaje bajt w bajt taki sam**.

---

#### F7 — SIÓDEMKA DOMYŚLNA PRZEZ SITO ✅ *(2026-08-11)*

Siedmiu agentów z `DEFAULT_V2_CAPABILITIES` przeszło canary **zanim sito K1–K11
powstało** — a sito zbudowano właśnie z defektów, które tamte canary przepuściły.
Ten etap zamienia siedem „prawdopodobnie w porządku" na siedem sprawdzonych.
Drugi powód, mocniejszy: tego dnia zmieniłem maszynerię wspólną (kontrakt
headless, loader promptów, kanał artefaktów, menu routera), a to właśnie ci
agenci są najbardziej narażeni na regresję z mojej ręki.

**Metoda:** statyka dla wszystkich naraz + **jeden job na agenta** w jednej bazie,
z domyślnym allowlistem (bez `ORCHESTRATION_V2_CAPABILITIES`), czyli dokładnie
w konfiguracji produkcyjnej.

**Wynik: 4 czyste, 1 z retry, 2 wymagające decyzji.**

| agent | wynik | dowód |
|---|---|---|
| `researcherAgent` | ✅ | 1466 zn. |
| `chefAgent` | ✅ | 3400 zn., **2 artefakty w kopercie** — K9b potwierdzone live u agenta, którego nikt pod tym kątem nie sprawdzał |
| `contentAgent` | ✅ po retry | 1. próba TIMED_OUT, 2. dowiozła 9429 zn. |
| `crmAgent` | ✅ | 70 zn. w oknie 120 s |
| `writerAgent` | ❌ **JOB FAILED** | patrz niżej |
| `analyticsAgent` | ❌ | `ResourceExhausted` u dostawcy modelu (Nvidia 33/32) — **nie defekt silnika** |
| `deliberationAgent` | ⚠️ | nie dostał zadania: zlecenie porównawcze poszło do `researcherAgent` |

**🔴 GŁÓWNE ZNALEZISKO — `writerAgent` tracił CAŁE opowiadanie przez jeden znak.**
`enforceWriterOutputPunctuation` **rzucał wyjątkiem** na U+2014. Zmierzone:
150-słowowe opowiadanie z jednym myślnikiem → próba `failed` → retry `failed`
identycznie → **job FAILED, użytkownik dostał zero**. Zakaz był już w promptach
writera **trzy razy** i od dziś w regule globalnej, więc „poproś jeszcze raz"
zostało wyczerpane. Do tego nieudana próba jest PONAWIANA — model płaci za
regenerację całego tekstu z powodu jednego znaku.

**Naprawa: normalizacja zamiast wyjątku.** Audyt anty-slop nadal ocenia jakość,
więc nie przepuszczamy słabego tekstu — ratujemy go przed nieproporcjonalną karą.
Asercja w `check:artifact-handoff` (prawdziwy caller, atrapa tylko na agencie).

**WERYFIKACJA PO NAPRAWACH (przebieg drugi, tego samego dnia):**
- **`writerAgent` ✅ `SUCCEEDED`** — 783 zn. opowiadania. Naprawa potwierdzona
  LIVE, nie tylko testem deterministycznym.
- **`analyticsAgent` ✅ `SUCCEEDED`** na modelu `deepseek-v4-pro` (podmiana decyzją
  właściciela) — 3392 zn. raportu, **zero `ResourceExhausted`**. Awaria była
  w dostawcy modelu, nie w agencie ani w silniku.
- **routing do `deliberationAgent` ✅** przy sformułowaniu „rozważ i podważ
  warianty, oceń trade-offy".

**⭐ DLACZEGO POPRZEDNIO NIE TRAFIŁO DO DELIBERATION — nie karta zawiniła:**
**Meta Front PRZEPISUJE wiadomość na cel joba, a router widzi ten cel, nie
oryginalne słowa.** „Rozstrzygnij dylemat: dostawa własna czy agregator" zostało
przepisane na „Przygotuj analizę porównawczą modeli dostaw" — czyli opis
researchu. To zmienia sposób diagnozowania błędnych tras: **czytaj `goal` joba,
nie swoją wiadomość.**

**⭐ OKNO 900 s BYWA ZA MAŁE DLA PRACY, KTÓRA NIE WISI — dwa pomiary:**

| agent | zdarzenia | najdłuższa cisza | liveness | co ścięło |
|---|---|---|---|---|
| `contentAgent` | 29 | 85,5 s | żyje | zegar 900 s |
| `deliberationAgent` | 39 | 134,7 s | żyje | zegar 900 s |

Oba pracowały aż do cięcia. **To jest dowód, którego brakowało, gdy profil
`extended` (1800 s) został wcześniej ODRZUCONY** — wtedy zegar nie odróżniał
„pracuje" od „zawiesił się", a teraz liveness to rozstrzyga. Podniesienie okna to
decyzja kosztowa właściciela, nie audytu; **nie ruszam jej sam**.

**Ustalenia bez zmiany kodu:**
- `researcherAgent` **importuje `../mcp.js`** — ma zależność MCP, której tabelka
  statusów wcześniej nie pokazywała.
- `researcher`, `analytics`, `deliberation`, `crm` **nie mają procesorów wejścia
  ani delegacji**. Na legacy też nie mieli, więc to NIE regresja — ale znaczy, że
  nie zlecą pracy dalej i nie mają dynamicznego wyszukiwania narzędzi.
- `analyticsAgent` ma zepsuty backend modelu. To konfiguracja, nie migracja.
- router pomylił `deliberationAgent` z `researcherAgent` — ta sama klasa co
  crm/marketing: granica rozmyta w KARTACH, nie w kodzie.

---

#### F7 — WSPÓŁPRACA `automationArchitect` ↔ `n8nMcpEngineer` ✅ *(2026-08-12)*

Zadanie od właściciela: „zajmij się n8nMcpEngineerem i tym, żeby architekt mógł
korzystać z jego pomocy podczas budowy workflow'ów". Pierwszy test, który w ogóle
wymusza handoff — zlecenie z węzłem **spoza rdzenia** (Google Sheets). Wszystkie
wcześniejsze canary używały webhooka i kodu, więc ta ścieżka nigdy nie startowała.

**WERDYKT: współpraca DZIAŁA end-to-end.** Powtórka scenariusza dowiozła
walidację z MCP (`typeVersion 4.6`, `operation appendOrUpdate`,
`googleSheetsOAuth2Api`, wymagane parametry), artefakt walidacji `art-5d52581c`
i **realny deploy**: `Mastra - Webhook Email to Google Sheets`, `active=false`,
02:11:37 — zweryfikowane w API n8n, nie w raporcie agenta.

**Pierwszy przebieg jednak PADŁ** — i to jest wartość tego etapu, bo pokazał trzy
rzeczy naraz.

**1. Awaria jest NIEDETERMINISTYCZNA, nie infrastrukturalna.** Serwer MCP jest
zdrowy (`npx -y n8n-mcp` → **7 narzędzi w 2 s**), loader inżyniera nie zgłosił
błędu, więc narzędzia były podłączone. Kontrakt odrzucił handoff kodem
`n8n_mcp_handoff_no_real_tool_use`: inżynier **czasem** odpowiada z wiedzy modelu,
nie wywołując żadnego narzędzia. Bramka istnieje dokładnie po to (w kodzie:
„the failure mode that shipped a stale googleSheets typeVersion") i zadziałała.

**2. 🔴 Tożsamość wywołującego pochodziła z DEKLARACJI MODELU.** Bramka
wpuszczająca do inżyniera porównywała `callerAgentId` — argument narzędzia
z `default(meta-agent)`. Psuło się to w obie strony naraz: gdy architekt zapomniał
pola, handoff wracał jako `caller_not_allowed`, a jego własny prompt kazał mu
**porzucić całą budowę**; jednocześnie **dowolny agent mógł zadeklarować, że jest
architektem** i sięgnąć po wewnętrznego pomocnika. To jest ta klasa pola, której
koperta wyniku już nie czyta z treści modelu — tożsamość stempluje runtime.
Naprawione: `resolveDelegationCaller` bierze ją z kontekstu wykonania; poza runem
(skrypty, wywołania legacy) deklaracja nadal obowiązuje, więc nic działającego się
nie zmienia.

**3. 🔴 Architekt złamał własną regułę fail-closed.** Po nieudanym obowiązkowym
handoffie jego prompt nakazuje `blocked / mcp_handoff_failed` i zakaz komponowania.
Zamiast tego skomponował workflow, zapisał do pliku i wystawił „Raport końcowy"
z tabelą węzłów — a **job zamknął się jako `COMPLETED`, podczas gdy w n8n nie
powstało NIC**. Deterministyczna bramka deployu zadziałała; skłamała ETYKIETA.
Naprawione **anotacją faktem runtime'u**, nie kolejną prośbą w prompcie (ta była
i została zignorowana): wynik niesie zdanie o nieudanym handoffie i o tym, czy
cokolwiek wdrożono. Anotacja, a nie porażka — analiza jest prawdziwa, fałszywa
jest jej wymowa, a nieudana próba byłaby PONAWIANA.

**⚠️ PUŁAPKA, KTÓRĄ TO ODSŁONIŁO (trzeci raz ta sama):** wszystkie czytniki
w `mcp-handoff-state` rozwiązują klucz przez `getHarnessExecutionContext()`,
istniejący **tylko wewnątrz runu**. Kod komponujący wynik działa PO runie, więc
widziałby zawsze „brak awarii". Dodane `mcpHandoffFailedForRun(runId)` /
`automationDeliverableForRun(runId)` — odczyt po jawnym kluczu, lustrzanie do
`run-artifacts`. **To ten sam błąd, który dwukrotnie pogrzebał `findArtifactIds`.**

**Diagnostyka na przyszłość:** odrzucony handoff loguje własne dowody
(`[n8n-mcp-handoff] REJECTED <kod> — <kształt odpowiedzi>`: liczba kroków,
`toolCalls` na krok, typy części `content`, klucze odpowiedzi). Bez tego
„inżynier nie wywołał narzędzi" i „ekstrakcja ich nie widzi" wyglądają identycznie
z zewnątrz.

---


---

#### F7 — DOMENA CODING: PRZENIESIENIE 🔄 *(2026-08-12…17, `codingAgent` + 3 recenzentów)*

Najbardziej rozbudowana domena w legacy. **Zmapowana pozycja po pozycji PRZED
przenoszeniem** — `docs/MIGRACJA-DOMENY-CODING.md`, **87 zdolności** w 12 grupach,
z kolumną „dowód", która wypełnia się dopiero po przebiegu na żywo.

**Stan: 12 pozycji z dowodem live, 7 zaimplementowanych bez dowodu, 63 nietknięte.**
`codingAgent` NIE jest w `DEFAULT_V2_CAPABILITIES`; canary szły przez zmienną
środowiskową, produkcja bez zmian.

**⭐ USTALENIE, KTÓRE ZMIENIA KSZTAŁT MIGRACJI: to nie jedna domena, tylko DWA
TRYBY o przeciwnych regułach.**

| | własny kod | nowy/obcy projekt |
|---|---|---|
| gdzie | `agentic-agents` | `/projekty/agent-projects/<nazwa>` |
| live repo | READ-ONLY | n/d |
| worktree | tak, per zadanie | **nie ma po co** |
| komendy | allowlista | **dowolne, w tym `git commit`** |
| droga do produkcji | merge za zgodą → blue-green → canary → promote/rollback | **nie dotyczy** |

Tryb pierwszy ma jeszcze **trzy cele** dzielące worktree, a różniące się tym, kto
decyduje o dotarciu do produkcji: autoheal (`heal-*`, `AUTOHEAL_AUTO_PROMOTE`
pomija człowieka, supervisor w bashu poza Mastrą), dobudowa własnych narzędzi
(`capability-build`, bramka `tsc` + `check:all` w worktree, jednorazowy permit),
zwykła praca (człowiek, `confirmMerge`, deploy tylko dry-run).
**Wybór trybu jest wyłącznie promptowy — nie ma routingu ani flagi.**

**Dziewięć znalezisk zamkniętych.** Każde to maszyneria, która istniała, była
poprawna i nic do niej nie docierało:

| | co |
|---|---|
| `GAP-PLAN-STEPS-01` | sekwencja F6B nieosiągalna: kontrakt, store, żywy lane i brama 17 asercji gotowe, a **żaden prompt nie wymieniał decyzji**. Brama była zielona, bo sama konstruowała wejście |
| `Z1` | run bezludny dostawał narzędzia, które **zawieszają** na zgodę; Mastra suspenduje agenta, a w tle nikt nie wznowi |
| `Z2` | dwaj recenzenci **nieosiągalni** — nikt ich nie wołał, a cztery prompty obiecywały delegację |
| `Z3` | `coding_apply_patch` deklarował „Requires approval" i **nie egzekwował niczego** |
| `Z6` | V2 nie podawał ani `taskId`, ani `repoPath` — agent wymyśliłby identyfikator, precontext gubił mapę repo i checkpoint |
| `Z7` | **cztery rozjechane kopie** listy bezpiecznych komend |
| `Z9` | `code_search` na zimnym cache'u embeddingów pracował ~40 min w JEDNYM wywołaniu; liveness nie widzi wnętrza wywołania → 3 próby, 3 timeouty, zero wyniku. `touchCurrentRunLiveness()` istniał i **nie miał ani jednego wywołującego** |
| `Z10` | zakres pracy = JOB, nie krok; inaczej recenzent w sekwencji nie widzi worktree autora |
| `Z11` | telemetria przypisywała cudzą pracę codingowi: `agentId: undefined` z argumentów **nadpisywał** prawdziwe id z runu, a fallback kończy się na `CODING_AGENT_ID`. Wszystkie wywołania RECENZENTA zapisane jako `codingAgent` |

Plus **dziura prefiksowa** w strażniku projektów zewnętrznych (`../app-evil/x.ts`
przechodził) i **martwy Workspace** projektu zewnętrznego — siódmy przypadek
wzorca „zbudowane i niewpięte".

**Dowody live (dwa canary, każde twierdzenie sprawdzone U ŹRÓDŁA, nie na słowo):**
- **canary A** `COMPLETED`, 8154 zn., 1 artefakt. Raport o funkcji powstałej W TEJ
  SESJI, więc nie z wiedzy modelu: definicja w linii 32 — **dokładnie**, 1 caller
  bezpośredni — **dokładnie**, 21 pośrednich przy deklarowanym „~22".
- **canary B** `COMPLETED`, 2 artefakty. Worktree → zapis → `tsc` → artefakty →
  **worktree i gałąź usunięte**. Rozstrzygające: `isCodingTaskScoped` w worktree
  1×, w live repo **0×**, HEAD live niezmieniony.
- **odmowa zamiast zawieszenia trafiła 2× w 2 canary**, oba runy przeżyły
  i skończyły sukcesem; w canary B agent po odmowie sam sięgnął po właściwe
  narzędzie, więc komunikat był WYKONALNY.

**Nowe bramy** w `check:all`: `prompt-tool-names`, `headless-approval`,
`live-merge-permission`, `long-tool-liveness`, `external-project-isolation`,
`coding-task-scope`, `git-locale-independence`, plus asercje w pięciu
istniejących. Brama: **exit 0**. Stan spisu: **16 pozycji z dowodem live, 8 bez, 57 nietkniętych** z 87.

**Konfiguracja migracji:** cała domena na `deepseek-v4-pro` (decyzja właściciela),
żeby „port jest zły" i „ten model by tego nie zrobił" były rozróżnialne.

**Trzeci canary — RECENZJA (grupa E):** `TERMINAL/COMPLETED`, 3 zadania, oba kroki
`SUCCEEDED`. Model sam zaplanował `codingAgent→codeReviewAgent`, recenzent dostał
**własny run z własnym toolsetem** (18 narzędzi wobec 48 autora), wydał werdykt
`approve` z trzema realnymi uwagami i zapisał go w artefakcie zadania. U źródła:
`isSameRoot` w worktree 1×, w live **0×**, HEAD niezmieniony.

**Czwarty canary — MERGE DO ŻYWEGO REPO (F1) ✅** *(2026-08-17)*. Pełna pętla z
człowiekiem, bez skrótów: agent zapisał plik w worktree i poprosił o zgodę →
operator zatwierdził przez `/dashboard/approvals` → **drugi job** scalił. U
źródła (`git log`, nie raport agenta): żywe repo `5bdad62 → c4a5232`, plik
obecny, permit ostemplowany `liveMergeConsumedBy`. Commit sondy cofnięty,
worktree i gałęzie posprzątane.

Ten jeden canary wyciągnął **sześć defektów, których nie znalazłoby czytanie
kodu** (Z14–Z19, spis w `docs/MIGRACJA-DOMENY-CODING.md`), w tym trzy o
charakterze klasowym:

- **kontynuacja między jobami** — reguła „run wygrywa" (Z10) blokowała dokładnie
  ten kształt, który merge bramkowany człowiekiem MUSI mieć: buduj i zapytaj →
  zatwierdź → scal w drugim jobie. Autorytet przeniesiony na permit związany z
  zadaniem (`forTaskId` → `wrong_task`);
- **git mówi po polsku** — `includes('nothing to commit')` jest tu fałszywe
  zawsze, a bliźniaczy wzorzec w sprzątaniu worktree był zepsuty **w każdym
  języku**. Nowa brama `check:git-locale-independence`;
- **cicha korekta** — nadpisanie zakresu było widoczne tylko na stdout serwera,
  więc agent poprosił CZŁOWIEKA o zgodę na scalenie gałęzi, na której jego pliku
  nie było. Teraz różnica wraca w wyniku narzędzia.

Plus: wstrzyknięcie powłoki przez `commitMessage` (tekst modelu w `sh -c` w
żywym repo), pusty merge raportowany jako sukces, i spalanie zgody człowieka
przed sprawdzeniem, czy jest co scalać.

**Metodologiczne, warte zapamiętania:** moja pierwsza brama na „pusty merge nie
kłamie" **przeszła bez zmian, gdy wyłączyłem strażnika** — czytała źródło, więc
sprawdzała kształt, nie zachowanie. Przepisana na wywołanie wydzielonej funkcji
przeciw prawdziwemu repozytorium. Reguła 26 w runbooku.

**Grupa F po zmapowaniu (2026-08-17):** F1 ✅ z dowodem live, F5/F6 ✅ (testy
izolowane EXIT=0, powtórzone po zmianach w narzędziach), F2/F4/F9/F10 🔧
zmapowane i częściowo zweryfikowane, F3 niesprawdzalne tutaj (brak `gh`, remote
na starej nazwie), F8/F11 świadomie poza zakresem agenta.

**Ustalenie architektoniczne, które zmienia ramę dla F2–F10 i G:** autoheal NIE
idzie przez V2 — `repo-maintenance` woła codingAgenta przez `generateCoding` →
`generateWithHarness`, czyli legacy. Flagi V2 go nie dotyczą. Nie ma więc czego
„przenosić": jest do zdecydowania, czy cykl autohealu ma kiedyś stać się jobem
V2. Za to obie ścieżki **dzielą narzędzia**, więc naprawy Z17/Z18/Z20 działają na
autohealu tak samo jak na V2 — i to właśnie tam Z20 był najgroźniejszy.

**Grupa G — ZAMKNIĘTA 6 z 6 *(2026-08-17)*.** Trzy przebiegi na żywo przez
`/deploy/crash-test`. Cykl rusza, diagnozuje, planuje podzadania i **uczciwie się
zatrzymuje** zamiast wysłać puste worktree do recenzji. Pusty worktree jest tu
poprawny: crash-test wstrzykuje sfabrykowany błąd bez odpowiednika w kodzie.

Trzy defekty, każdy niewidoczny bez uruchomienia (pełny opis Z22–Z24):

- **naprawę kodu wykonywał model 12B lokalny.** Router ma regułę „prefer local if
  VRAM available (cost = 0)", a jedynym filtrem jakości jest złożoność, którą
  model szacuje sam sobie. Nic nie odróżniało napisania poprawki od streszczenia
  loga. Drabina eskalacji odpowiadała na za mały model **innym lokalnym**,
  12B → 11B. Teraz reguła pyta o ROLĘ: `file-editor` → model mocny,
  `terminal`/`qa` → dalej workery. Live po poprawce: edycje na `gpt-oss-20b` →
  `gpt-5.3-mini`, zero lokalnych; weryfikacja na gemma/Bieliku, zgodnie z zamysłem;
- **cykl, który się zatrzymał, blokował healera na 24 h.** Tylko udany MERGE
  zamykał ticket, a `in_progress` liczą trzy rzeczy naraz (dedup, `MAX_ACTIVE=3`,
  podgląd operatora). Trzy nieudane naprawy = samonaprawa martwa, raportująca
  trzy naprawy „w toku", bez żadnego logu;
- **istniejący `test-error-collector.ts` był zarejestrowany NIGDZIE** — ani w
  `package.json`, ani w `check:all` — i przechodził 14/14 w próżnię. Ten sam
  wzorzec co siedem razy wcześniej, tym razem zastosowany do TESTU.

**Ustalenie do decyzji właściciela:** podłoga wyklucza dziś modele lokalne z
edycji kodu, ale router nadal bierze NAJTAŃSZY chmurowy model spełniający
deklarowaną złożoność — a złożoność szacuje sam model. Czy `file-editor` ma być
przypięty wprost do `deepseek-v4-pro`?

**Grupa I — 3 z 4 *(2026-08-17)*, I3 poza zakresem (inny agent).** I2 (permit
jednorazowy) był już zrobiony i jest **dzielony** z bramką merge codingAgenta.
I1 (ścieżka BUILD) kompletna i bramkowana, live z lipca pod legacy, z V2
osiągalna tylko opt-in — `capabilitySmith` nie jest w `DEFAULT_V2_CAPABILITIES`.

I4 dał trzy znaleziska (Z25–Z27):

- **praca na V2 niczego nie uczyła.** `recordDistillationCandidate` miał dwóch
  wywołujących: legacy `delegate-task.ts` i ścieżkę build; trwała orkiestracja
  żadnego. Nic nie padało — korpus po prostu przestawał rosnąć. Wpięte, dowód
  live: kandydat `codingAgent trigger=tool_calls toolCalls=5` z celem joba;
- **mój licznik siedział w hooku, którego dostaje TYLKO writer.** Run codingAgenta
  z 19 wywołaniami narzędzi raportował `toolCalls=0`, a asercje bramy były
  zielone — dowodziły podpięcia do hooka, którego ten agent nie dostawał.
  Złapane przez dołożoną linię diagnostyczną w PIERWSZYM przebiegu, nie przez
  rozumowanie;
- **86% korpusu to były fikstury bram** (1114 z 1290; 918 kopii jednego celu
  smoke-testowego, po jednej na każde `check:all`). Obie bramy miały sprzątanie,
  żadna nie znała tej kolekcji. Wyczyszczone i zabezpieczone bramą.

**OTWARTE dla właściciela:** wszystkie kandydaty mają status `pending` — nikt nie
uruchamia `skill:nightly`. Wejście rurociągu jest wpięte, wyjście nigdy nie
ruszyło; uruchomienie kosztuje wywołania modelu, więc to decyzja, nie defekt.

**Decyzja właściciela wdrożona:** `file-editor` przypięty do `deepseek-v4-pro`
(`REPAIR_MODEL_KEY`), z awaryjną ścieżką, która przy niedostępności modelu spada
na najmocniejszy dostępny **chmurowy** — nigdy na lokalny. Asercja awaryjna jest
behawioralna: brama wywala wyłącznik obwodu przypiętego modelu i sprawdza, co
router wybierze.

**Grupa J — 7 z 9 *(2026-08-17)*, J2 i J7 zablokowane wcześniejszymi ustaleniami
(fan-out wymaga G8 §Z4; role subagentów mają cztery z pięciu pól nieczytane §Z5).**

J8 i J9 z dowodem live: `codingAgent → researcherAgent` (2060 B realnej
odpowiedzi) oraz 52 zdarzenia `worker_run_*`, kilka w tej samej sekundzie —
równolegle w jednym kroku. Trzy defekty (Z28–Z30):

- **pinu zdolności nie dało się użyć z API.** Store go przyjmował, walidował i
  honorował; granica HTTP nigdy go nie przekazywała — słowo „capability" nie
  występowało w `handlers.ts` ani razu. Zadanie zgłoszone dla `codingAgent`
  wykonał `deliberationAgent`, który uczciwie zgłosił brak żądanych narzędzi;
- **awaryjny fallback oddawał naprawę modelowi 4B.** Drugi, niezależny producent
  decyzji o modelu: jeden 429 od dostawcy wystarczał. Lekcja ogólna — gdy decyzja
  ma dwóch producentów, przypięcie jednego nie jest przypięciem;
- **telemetria przypisywała delegację `meta-agent`** (rodzina Z11), przez co
  uczciwy przebieg wyglądał na zmyślony i kosztował śledztwo w tej samej sesji.

**Metodologiczne:** dwa razy pod rząd wyciągnąłem błędny wniosek z pustego wyniku
sondy — raz przez błędną atrybucję, raz przez zapytanie po `createdAt` zamiast
`timestamp`. Reguła 33 w runbooku: policz wiersze BEZ filtra, zanim uwierzysz
w pustkę.

**Grupy A/B/C/D *(2026-08-17)*: 22 pozycje sprawdzone sondą bezpośrednią** —
wywołanie każdego narzędzia wprost, bez agenta i bez tokenów. Dwa realne defekty:

- **`graphify_affected` mówił „nic od tego nie zależy" o symbolu ze stopniem
  396.** CLI rozstrzyga tylko po ID węzła, a na nazwę odpowiada
  `No unique node match` na stdout z kodem 0 — parser widział zero krawędzi.
  Dla analizy wpływu to najgorszy kształt porażki: „można zmieniać". Istniejąca
  brama przechodziła, bo testuje parser na fikstrurach (jej własny nagłówek to
  przyznaje). Po naprawie: 661 zależnych;
- **checkpoint kontekstu nigdy nie powstawał.** `appendToCheckpoint` bez
  `upsert`, a jedyny writer z upsertem ma zero wywołań — każdy zapis pasował do
  zera dokumentów i cicho przepadał, `context-assembler` czytał pustkę. Agent
  działał bez pamięci między krokami, bez jednego błędu.

Do odnotowania, bez naprawy: **indeks embeddingów jest pusty** (`totalChunks: 0`,
`code_search` startuje na zimno) i **`FEATURE_FILE_ACTIVITY_LEDGER` jest domyślnie
wyłączona**.

**Metodologiczne:** cztery razy w tej turze pusty wynik sondy okazał się moim
błędem (zła nazwa pola/kolekcji/parametru), nie defektem. Dlatego nowe bramy są
round-tripami przez prawdziwe funkcje zapisu i odczytu, a nie odtworzeniem
zapytań — reguły 34–36 w runbooku.

**Grupa E — ZAMKNIĘTA 11 z 11 *(2026-08-17)*.** E9 i E10 z dowodem live:
`securityReviewAgent` wydał werdykt BLOCK na `one-time-permit.ts`, a
`performanceReviewAgent` recenzję wydajności `file-activity.ts` na 4268 znaków z
analizą pokrycia indeksów.

**Najważniejsze: recenzja bezpieczeństwa znalazła DWIE realne dziury w kodzie
napisanym tego samego dnia** — zgoda nie była wiązana z akcją (approval na maila
autoryzowałby merge do żywego repo) i „dokładnie raz" obowiązywało per konsument,
nie globalnie. Obie naprawione. To jest dowód, że E9 zarabia na siebie.

Trzy defekty przy okazji (Z33–Z35): produkt runu ginął przy przebiegu
pogłębiającym (harness zwraca ostatni `generate`, więc kroki wcześniejszych są
nieosiągalne — zapis w momencie zdarzenia, `run-deliverables.ts`); 45 skilli
opisywało się jako `">-"`, bo parser frontmatteru nie znał bloków składanych YAML;
precontext recenzji nie był zarejestrowany w V2, więc recenzent pracował bez
diffu i bez wcześniejszych notatek.

**Metodologiczne, najostrzejsza lekcja tej sesji:** napisałem asercję, która NIE
MOGŁA oblać — helper `check` był synchroniczny, a callback `async`, więc
odrzucenie promisy nigdy nie trafiało do `catch`. Wykryte eksperymentem wprost.
Reguła 37 w runbooku.

**Grupa L — ZAMKNIĘTA 4 z 4 *(2026-08-17)*.** Cały nadzór nad przebiegiem
zweryfikowany na żywo w V2, bez ani jednego defektu: 25 zdarzeń `output_score`
z prawdziwym kontraktem celu (L1), 24 `reflector_intervention` z
`appliedLevers: ["injectSystem"]` — reflektor wykrywa **i działa** (L2), pełna
telemetria z klasą ryzyka i decyzją polityki (L3), profile głębokości liczone i
stosowane (L4).

Jedyne ustalenie warte zapamiętania: **harness SAM tworzy kontrakt celu**, gdy
wywołujący go nie ma — a V2 żadnego nie podaje. Bez tego każdy job V2 leciałby
nieoceniony i nic by tego nie powiedziało. Dopisane do bramy
`check:v2-harness-worker` razem z asercją, że telemetria narzędzi niesie
`risk` + `policyDecision`.

Odnotowane, bez naprawy: `enforcementMode: log_only`, `enforced: false` —
polityka narzędziowa obserwuje, nie blokuje.

**Metodologiczne:** w tej turze **sześć razy** pusty wynik sondy okazał się moim
błędem (zła kolekcja: `harness_events` zamiast `agent_events`; złe pole czasu;
złe nazwy parametrów). Za każdym razem ratowała mnie ta sama rutyna: policzyć
wiersze BEZ filtra i przeczytać sygnaturę ze źródła.

**Grupy H i K — ZAMKNIĘTE *(2026-08-17)*.** Drugi tryb pracy (nowe repo, bez
worktree) zweryfikowany sondą i zabramkowany: projekt powstaje z gitem, dowolne
komendy działają, `git commit` w repozytorium projektu przechodzi, a strażnik
odmawia zapisu do sąsiedniego projektu. Jeden realny defekt (Z36): **nowy projekt
nie przyjmował pierwszego pliku**, bo narzędzie nie tworzyło katalogów
nadrzędnych — a agent budujący aplikację zaczyna od `src/index.js`.

K3 i K4 potwierdzone round-tripem (licznik użyć skilla zapisuje się do
frontmatteru; deduplikacja wstrzykniętej pamięci pomija już wstrzyknięte id),
K6 działa (serwer Context7 startuje w kanarkach).

**A6 — rozgrzewka indeksu embeddingów DODANA** (`npm run warm:code-index`).
Zmierzone: 24 393 chunków, ~38 min od zera. To dokładnie ta praca, którą wcześniej
agent wykonywał w środku zadania i która zabiła jeden run pod zegarem (Z9).

**Metodologiczne — najostrzejsze z tej tury:** przy H2 **omal nie zgłosiłem
fałszywego defektu**. Moja sonda nazwała projekt `…-evil`, więc ścieżka
`../…-evil/x` wróciła do wnętrza tego samego projektu i wyglądała jak udana
ucieczka. Dopiero test „projekt A pisze do projektu B" pokazał, że strażnik
działa poprawnie. Łącznie w tej turze **dziewięć** pustych/mylących wyników sondy
okazało się moimi błędami.

**Stan spisu po tej sesji: 71 z 86 pozycji gotowych**, 7 częściowo, 2 nietknięte,
3 świadomie pominięte, 3 zablokowane wcześniejszymi ustaleniami.

**F10 uruchomione na żywo (EXIT=0)**: `deploy-blue-green.sh --dry-run` zbudował
kandydata, wystartował go na slocie B (:4222), zweryfikował zdrowie i zatrzymał
staging — **bez jednego wywołania `promote-candidate`, Live :4111 nietknięty**.
Ścieżkę dry-run sprawdziłem w kodzie PRZED uruchomieniem: kończy się przed
promocją. Przy okazji potwierdza F4 w części `build → start → verify`.

**Co zostaje i DLACZEGO:**
- **F2, F3, F7, F9 oraz promocja w F4** — przełączają Live albo wymagają GitHuba
  (`GITHUB_PR_MODE` off, brak `gh`, remote na starej nazwie). Nie uruchamiam ich
  bez wyraźnej decyzji właściciela;
- **A11, A12** (LSP, BM25) — zadeklarowane i podpięte do workspace'u codingAgenta;
  weryfikacja wymaga tury agenta, nie sondy;
- **B2** (repair lane) — mechanizm i długowieczny worktree istnieją, brak dowodu
  live;
- **I1** — ścieżka BUILD kompletna i bramkowana, live z lipca pod legacy;
  z V2 osiągalna wyłącznie opt-in (`capabilitySmith` poza domyślnym zestawem).

**NIEZWERYFIKOWANE / nietknięte:** grupy E, L, H, K, G, I, J ZAMKNIĘTE (brak precontextu
recenzji na V2, pętli naprawczej, recenzji bezpieczeństwa i wydajności na żywo),
F (merge i wdrożenie, **4 z 11** — F1 live, F5/F6 testami, reszta zmapowana),
I (dobudowa narzędzi, 0 z 4), J (równoległość i routing modeli, 0 z 9).
`AUTOHEAL_AUTO_PROMOTE` i `DEPLOY_AUTO_SWAP` pozostają `false` — merge w F1
przeszedł **jednorazowym tokenem zatwierdzonym przez człowieka**, nie flagą.
Cache embeddingów code-searcha nie ma rozgrzewki offline.

---

### F8 — G8: fault suite na topologii produkcyjnej *(bramka, której NIE pomijamy)*

**Dlaczego nie pomijamy:** dotyczy **utraty danych na produkcji**, nie wiarygodności testów.
ADR 0006 wskazuje ją jako jedyny formalny blocker rolloutu.

**Prace:** partition worker↔Mongo podczas claim/heartbeat; primary stepdown podczas lease
renewal; `TransientTransactionError`; `UnknownTransactionCommitResult`; powrót starego primary
po wygaśnięciu fence; opóźniony/zdublowany retry.

**Definicja ukończenia:** brak split-brain, lost outbox i duplicate effect — z evidence.

**Rozmiar:** 3–5 sesji. **Uwaga:** wymaga topologii ≥3 węzły (F1 daje single-node RS,
wystarczający do transakcji, **niewystarczający** do stepdown/partition).

---

### F9 — Fala 10: rollout, canary i usunięcie legacy

**Prace:** kohorty i stopniowy rollout; SLO i alerty; N/N-1 rollback rehearsal;
zero legacy traffic przez ustalony okres; dopiero potem usunięcie legacy i flag.

**Definicja ukończenia:** każdy tool ID ma dokładnie jeden status
`migrated | retired | quarantined`; legacy backlog = 0 przez ustalony okres.

**Rozmiar:** 3–5 sesji. **Fala rodzica:** 10, gate G9.

---

## 5. Czego świadomie NIE robimy

| Rzecz | Powód |
|---|---|
| **Domykanie G0** (26 crash-window §20.3, migracja 28 z 31 suite'ów) | ~17–30 sesji; dotyczy wiarygodności testów, nie działania. `qualificationStatus` zostaje `NOT_QUALIFIED` — świadomie. |
| `ORC-SPECULATION-01`, `ORC-ATTACHED-01` | rodzic sam gatuje je falą konsumenta — nie budować bez potrzeby |
| `GAP-RETENTION-01` | retencja gorących kolekcji — dopiero gdy wolumen zaboli |
| Pełne G1 (macierz 12 fingerprintów × profile × tryby pamięci) | ogromna macierz; robimy G1-core |

**Cena pominięcia G0, wprost:** testy pozostają wiarygodne „praktycznie" (bramka `PASSED`
dla 3 suite'ów + 28 e2e działających poza laboratorium), ale **nie formalnie**. Jeśli po
przepięciu pojawi się nieodtwarzalny błąd, brakuje nam laboratorium, żeby go
deterministycznie odtworzyć. To jest świadomie przyjęte ryzyko.

---

## 6. Dziennik postępu

| Etap | Stan | Commity | Notatki |
|---|---|---|---|
| **E0** — liveness zamiast wall-clocka *(część F3/Fali 2)* | ✅ | `40e1ef5` `79c960c` `0dfb218` `8b45add` `48e0ea0` `9ad150f` | Run cięty za ciszę (`IDLE_TIMEOUT`) albo backstop (`HARD_CAP`), **nigdy za długość pracy**. Dowód E2E: ten sam agent ginie pod zegarem 700 ms, pod liveness kończy w 1,36 s. Zrealizowane elementy Fali 2: `budgetedFetch`≈`fetchWithDeadline`, `budgetedPoll`≈tick ograniczony resztą budżetu, `budgetedProcess`≈timeout git. Naprawione: **K8** (`standard` miał `maxStepsWithoutProgress: 25 === maxSteps` → dźwignia **nigdy** nie odpalała), **K11**, **K17** (ollama probe blokował discovery modeli), **K18**. Znalezione: 3 checki delegacji nigdy nieuruchamiane → wpięte do `check:all`. Flaga `FEATURE_LIVENESS_BUDGET` **OFF**. |
| **F1** — produkcyjny replica set | ✅ | `docker-compose.yml`, `docs/MONGO-REPLICA-SET.md` | Mongo standalone → **single-node RS `rs0`**, `PRIMARY` po 1 s. **Blocker B1 zdjęty: transakcje działają na produkcyjnej instancji** (dowód: `withTransaction` przez sterownik aplikacji = commit; wcześniej niemożliwe). Dane nietknięte: `agentforge` 391.8 MB przed i po, **121 kolekcji** widocznych przez sterownik. `check:all` exit 0 — zero regresji legacy. Healthcheck zmieniony `ping` → **`isWritablePrimary`**, bo `ping` odpowiada też na niezainicjowanym RS (kontener raportowałby `healthy` przy martwych transakcjach). **PUŁAPKA złapana przed zmianą: wolumen jest `external`** — dane żyją w `jarvis-dashboard-agent_mongo-data`, nie w `mastra-agentic-environment_mongo-data` (który też istnieje i ma ~302 MB osieroconych danych); backup „po nazwie projektu" dał archiwum pustego wolumenu 865 KB zamiast 488 MB. Backupy przed operacją: `mongodump` 210 MB (logiczny, na żywo) + `tar` wolumenu 488 MB (fizyczny) w `.backups/`. Rollback: usunąć `command:` i `?replicaSet=rs0` — dane pozostają czytelne. **Uwaga: single-node RS wystarcza do transakcji, ale NIE spełnia G8** (partition/stepdown wymaga ≥3 węzłów) → F8. |
| **F2** — Fala 1 containment/identity | ✅ (w zakresie mającym dziś sens) | `b4f9ec3` `61fec15` `8876788` | **`SEC-001` lease/ACK ZROBIONE.** Claim zapisywał `consumed` w tej samej atomowej operacji, która pobierała rekord → **crash między pobraniem a pokazaniem wiadomości agentowi bezpowrotnie ją gubił** (interrupt użytkownika znikał bez śladu). Teraz claim **dzierżawi** (`claimed` + `claimedBy` + deadline), `ackPendingMessages` rozlicza go **fencingowany na dokładnym właścicielu** dopiero gdy treść trafi do promptu, a wygasłe lease'y są odzyskiwane przed kolejnym claimem. Dostarczenie: exactly-once normalnie, **at-least-once przy crashu** — właściwy kompromis dla interruptu użytkownika. Redelivery bounded (3 → `stale`). Wszystkich 5 konsumentów ACK-uje; tool i procesor **awaitują** (oddają treść natychmiast, więc rekord musi być rozliczony zanim obserwator zobaczy dostarczenie), ścieżki executora rozliczają **cały** batch, nie tylko urgent. `check:pending-message-scope` **11 → 15**. **USTALENIE zmieniające zakres: w legacy `resourceId` to agentId, nie tożsamość użytkownika** (`resourceId: originAgentId ?? META_AGENT_ID`) — system jest **jednoosobowy**, więc „immutable resource-owner binding + backfill" i scoping `laneDigest` chronią przed cross-owner disclosure, **którego dziś nie ma**. Odłożone do momentu pojawienia się wielodostępu. **`HRN-001` — połowa bezpieczeństwa ZROBIONA** (`8876788`): wywołanie modelu z pominięciem harnessu omija **wszystkie** jego inwarianty (profil głębokości, reflektor, budżet liveness, konsumpcja pending, koperty narzędzi), a guard pokrywał **tylko `.generate()`** — ścieżka streamingowa mogła je ominąć bez śladu. Guard rozszerzony o `.stream()` (zawężony do uchwytów agentowych, by node streams/fetch/MCP nie hałasowały), embeddingi wykluczone (nie sięgają modelu czatowego). Wszystkie 5 znalezionych naruszeń rozstrzygnięte **pojedynczo**: pipeline-gateway = odpowiednik harnessu dla profilu pipeline, `plan-task` = bounded no-tool single-step z własnym timeoutem, weather = demo Mastry. **`audit:harness` istniał jako skrypt, ale NIE był w `check:all`** — dokładnie tak wślizgnęło się naruszenie w `plan-task` (ten sam wzorzec co 3 osierocone checki delegacji); teraz wpięty. **Budowa samego stream gateway świadomie odłożona** — nie istnieje żaden konsument streamu (jedyne `.stream()` w repo to demo), więc byłaby to praca na zapas; naturalny konsument to powierzchnia SSE/poll Meta Frontu → **F5**. |
| **F3** — Fala 2 Execution Kernel | ✅ (kontrakty + K15 zrobione; `budgetedMongo` świadomie odłożone) | `e3978d3` `a7319c7` `2a28fe0` `a1c2ee2` `2d97500` `e0c80d2` (+E0) | **Signal composition + K3/K4 ZROBIONE.** Timeout/cancel przerywał **czekanie, nie pracę** — `delegate-task` nie miał jak się dowiedzieć, że rodzic został przerwany, więc rodzic umierał, a dziecko biegło dalej, paląc tokeny i mutując n8n/Mongo bez odbiorcy (plan: „cancel DB nie jest utożsamiany z actual stop"). Harness tworzy teraz `AbortController` **przed** otwarciem kontekstu i publikuje w nim skomponowany sygnał — narzędzia w głębi pętli modelu (które nigdy nie dostają argumentów harnessu) wreszcie widzą abort rodzica. Delegacja komponuje go na **każdej ścieżce sync** (generic + coding/knowledge/automation); **ścieżka async świadomie NIE** — tam przeżycie rodzica jest intencją, nie patologią. **K4:** sync coding/knowledge miały zaszyte `300_000` omijające koordynację → teraz `resolveDelegationBudget`. **K3 (ciekawszy przypadek):** automation z płaskimi 20 min — sam cap by go zepsuł (golden-path build realnie potrzebuje więcej niż okno rodzica), więc **niewykonalne okno routuje do async** zamiast startować sync, który dowodliwie nie zdąży. `e2e:delegation-abort` (6 asercji, w `check:all`): dziecko, które samo nigdy się nie kończy, **jest przerywane przez abort rodzica**, lokalny timeout przy tym nie odpala, timeout dziecka nie rusza rodzica, a kolejność `controller → context` jest asercjowana (odwrotna = narzędzia ślepe). **Zostaje w F3:** `HRN-002` (async pipeline pod kernelem), `budgetedMongo`, K15 `execSync`.
**LIVE-VERIFIED 2026-07-29** (`2a28fe0`): dwa dowody na realnym lokalnym Ollama (nie mock)
przez `live-verify:f3-can002` (opt-in, poza `check:all` — jak `spike:gap-model-abort`).
Proof A: sygnał opublikowany na kontekście wykonania (`getCurrentRunAbortSignal`) skomponowany
dokładnie jak w `delegate-task.ts`, aborcie rodzica podczas realnej generacji `generateText` —
osiada dokładnie w momencie deadline'u, z **dokładnym powodem aborta** propagowanym przez.
Proof B: **realne odkrycie**, którego mock nie mógł wykryć — Mastra `Agent.generate()`
**NIE odrzuca** obietnicy przy abort. Resolves z `finishReason: 'tripwire'` i pustym tekstem
(realna generacja faktycznie się zatrzymuje — osiadła po ~60 ms, a nie po pełnej generacji ~200
pozycji — więc abort **działał**, tylko nie ujawniał się jako odrzucenie). Naiwny wywołujący
widziałby anulowany run jako **pusty sukces**. Naprawione: `generatePipelineWithReflection`
wykrywa `finishReason==='tripwire' && input.abortSignal?.aborted` **razem** (nigdy osobno, by
nie przechwycić genuinego tripwire'u niezwiązanego z abortem) i rzuca jawnie z oryginalnym
powodem. `e2e:delegation-abort` ma teraz statyczny guard przeciw regresji tej gałęzi.
**Manifest: `CAN-002` → `verified`.**

**Proof C ujawniła DRUGIE, WAŻNIEJSZE wystąpienie tej samej luki — w samym harnessie**
(`a1c2ee2`), obejmujące **wszystkie** sync delegacje przez harness (coding/knowledge/
automation), nie tylko pipeline. `withTimeout`/`withLivenessGuard` mają WŁASNY jawny
`reject`, który zawsze wygrywa wyścig z **wewnętrznym** timeoutem/liveness harnessu —
ale **zewnętrzny abort rodzica** (skomponowany przez `input.abortSignal`, dokładnie tak
jak robi to `delegate-task` dla coding/knowledge/automation) **nie ma konkurującego
reject**, jeśli odpali się przed wewnętrznym deadline'em harnessu. Potwierdzone live:
timeout harnessu ustawiony na 60 s (daleko), sam zewnętrzny sygnał odpalony po 3 s →
wywołanie **resolves** po ~3060 ms z `finishReason: 'tripwire'` i pustym tekstem —
`delegate-task` zobaczyłby `outputPreview: ""` i wywołał `completeDelegationGoalSuccess`
z niczym, **traktując anulowanego rodzica jako udany, pusty wynik**. To jest dokładnie
awaria, którą F3 miał naprawić — jedną warstwę głębiej niż tam, gdzie po raz pierwszy
udowodniono, że skomponowany sygnał dociera. Naprawione tym samym wzorcem (wykrycie
`finishReason==='tripwire' && composedAbortSignal.aborted` razem, throw oryginalnego
powodu), umieszczone PRZED zapisem sukcesu circuit-breakera (anulowanie to nie porażka
modelu). Live-verify Proof C: reject dokładnie w ~3011 ms z dokładnym powodem, przy
timeout harnessu celowo ustawionym daleko (izoluje dokładnie tę ścieżkę). **`CAN-002` DOMKNIĘTE** (`a7319c7`): agenci pipeline mieli 150 kroków i **zero zegara**, a jedynym ograniczeniem był timeout delegacji będący **gołym `Promise.race`** — odrzucał czekanie wywołującego, podczas gdy pipeline biegł dalej, wołał narzędzia i mutował stan. Nie mogli więc ani skończyć na limicie kroków (150 w oknie ≤240 s jest nieosiągalne — limit był fikcją), ani zostać zatrzymani. Gateway przyjmuje teraz `AbortSignal` i przekazuje do `agent.generate`, a `withDelegationTimeout` **abortuje** zamiast porzucać czekanie. Profil = **liveness, nie zegar** (render/rekonesans legalnie trwa minuty; cięcie po czasie powtórzyłoby błąd, od którego właśnie odeszliśmy), envelope szerszy niż w harnessie bo fazy mediów mają naturalne ciche fragmenty. **Pułapka ominięta: liveness startuje TYLKO tam, gdzie wpięty jest `prepareStep`** — inaczej zdrowy run bez czego touchować wyglądałby na milczący i zostałby ucięty. Manifest: `implemented` → **`verified`** po Proof D (patrz niżej).

**`HRN-002` DOMKNIĘTE** (`2d97500`): luka symetryczna do `CAN-002`, ale w **ASYNC** linii —
`executeDelegation` rzucał wszystkie nie-coding/nie-knowledge/nie-automation agenty (czyli
też chef/content/hunt/writer/filmmaker/musician, gdy trafiały w gałąź async) do gołego
`generateGenericAsync`: żadnego reflektora, żadnego liveness, tylko płaski timeout. Ochrona
pipeline agenta **zależała od tego, która gałąź go akurat złapała** — sync dostawał pełny
profil z `CAN-002`, async nie dostawał nic. Naprawa: nowa `generatePipelineAsync` (ten sam
kształt abortable-timeout co `generateGenericAsync`, więc istniejący bound się nie osłabia),
`executeDelegation` rozgałęzia się na `isPipelineAgent(agentId)` **przed** fallbackiem
generic. Zweryfikowane dwiema niezależnymi ścieżkami: `check:async-pipeline-routing` (w
`check:all`, realny replica-set Mongo w izolowanej throwaway bazie + scripted model,
rozróżnia trasowanie przez licznik wywołań `Agent.prototype.listTools()` — odkrycie po
drodze: goły `agent.generate()` **sam** woła `listTools()` raz wewnętrznie, więc baseline to
1 nie 0; pipeline = 2 [wewnętrzne + własne jawne wywołanie gatewaya], generic = 1) oraz
**Proof D** w `live-verify:f3-can002` — prawdziwy lokalny Ollama, `startAsyncDelegation` dla
`chefAgent` z pytaniem „What is the capital of France?", realna odpowiedź modelu **„Paris"**
(3635 ms) przez cały łańcuch `startAsyncDelegation → generatePipelineAsync →
generatePipelineWithReflection → agent.generate`. **Manifest: `HRN-002` `deferred` →
`verified`** (`testCaseIds: ['check:async-pipeline-routing', 'live-verify:f3-can002']`,
`evidenceIds: ['2d97500']`). **Nie rozwiązane, świadomie poza zakresem:** brak zewnętrznego
anulowania trwającej delegacji async (`void executeDelegation` to fire-and-forget bez
przechowanego kontrolera) — to Fala 5/F6, nie ten fragment. **Zostaje w F3 (odłożone, nie
blokujące):** `budgetedMongo`.

**K15 DOMKNIĘTE** (`e0c80d2`) — `runExternalProjectCommandTool` używał `execSync`, blokując
cały event loop Node na czas działania dziecka (do 30 s), czyli zamrażając **wszystkie**
równoległe agenty na serwerze — najgroźniejsza otwarta pozycja długu z `docs/TECH-DEBT-TIMEOUTS.md`.
Naprawione `spawn` (ten sam wzorzec co `meta-execute-command.ts`) z realnym `SIGKILL` na
timeoucie. **Detal złapany przez nowy test:** `child.kill()` na samym procesie shella NIE
wystarcza dla poleceń złożonych (`sleep 5 && echo x`) — bash forkuje `sleep` jako dziecko, na
które tylko czeka, więc zabicie shella zostawia je jako sierotę biegnącą do naturalnego końca.
Naprawione `spawn(..., {detached:true})` + `process.kill(-child.pid, 'SIGKILL')` (zabija całą
grupę procesów). `check:external-project-command-nonblocking` (w `check:all`) dowodzi obu
właściwości wprost na prawdziwym `runCommand`: event loop tyka podczas działania dziecka
(execSync by go zablokował), a polecenie przekraczające timeout jest naprawdę zabite w <2s,
nie zostawione wiszące do swojego naturalnego końca (5s). |
| **F4** — Fala 3 kontrakty substratu | ✅ (bez kodu) | `26363a6` | **Audyt zamiast implementacji.** Plan zakładał pisanie `ORC-RESULT-READY-01` remainder + `ORC-TXN-A-EVIDENCE-01`; przeczytanie realnego kodu (`attempts.ts`, `control-boundary.ts`, e2e `result-ready`) i master planu (sekcja Tier-1/Tier-2) pokazało dwie rzeczy. **(1) Błędna etykieta:** `ORC-RESULT-READY-01` miał w notatkach dokładnie ten sam kształt „partial flat-slice" co bracia już `implemented` (`ORC-TXN-A-01`, `ORC-TXN-B-01`, `ORC-AUTH-ACTIVATION-01"), a mimo to wisiał na `deferred` — poprawione, zero zmiany kodu. **(2) Cała reszta obu kontraktów jest zgatowana konsumentem, którego nie ma:** `task-due`/`effects-artifacts` nie mają nawet pól w schemacie (nierozpoczęte, nie tylko nieprzetestowane); `bounded ancestor touch` czeka na `codingAgent` (Fala 6, patrz notatki `ORC-DISPATCH-EDGE-01`); brakujący activation kind to `FINAL_DECISION` (`deliberationAgent`, Fala 7); `finish_as_evidence` (`ORC-TXN-A-EVIDENCE-01`) ma **zero wywołań w całym repo** — nawet jedyny agent podłączony do V2 dziś (`weatherAgent`) go nie woła, i w przeciwieństwie do `ORC-SPECULATION-01`/`ORC-ATTACHED-01` nie miał zadeklarowanego `firstConsumerCapability`. Budowa tego teraz byłaby dokładnie tym „budowaniem przed konsumentem", którego plan świadomie unika gdzie indziej — dzisiejszy fail-closed `409` **już jest** bezpiecznym stanem, jakiego wymaga Tier-1; kompletna funkcja nie miałaby dziś niczego, co by ją zwalidowało. User potwierdził: zero spekulacyjnego kodu, `ORC-TXN-A-EVIDENCE-01` zostaje `deferred` z rozszerzoną notatką, `ORC-RESULT-READY-01` → `implemented`. `check:all` (54 pozycje) zielony bez zmian, bo runtime się nie zmienił. |
| **F5** — Fala 4 Meta Front + routing | 🔄 profil harnessu + konsument + reader + toolset + **Meta Front (tożsamość+prompt)** | `b0a25e2` `9636976` `acc133d` `b6cab68` `8d53d3c` (+`a53bbf7` `146f6cd` `01af2e0` `9eaa2df` `4282bc5`) | **Audyt przed kodem (ten sam wzorzec co F4) ujawnił, że większość „hydrauliki" już istniała**: store transactions, framework-agnostic handlery (`createOrchestrationApi`: start/list/get/jobCommand/getConversation — cancel/pause/resume/steer/append/fork/answer), i realne trasy Hono (`v2RouteDefs`, zamontowane w `index.ts` pod flagą). Czego brakowało: dowodu, że którekolwiek z tego przeżywa kontakt z prawdziwym, zbudowanym serwerem i prawdziwym restartem procesu — istniejący `e2e:orchestration-mastra-routes` woła handlery przez MOCK kontekst Hono, nigdy nie otwiera portu. **`live-verify:f5-mastra-routes`** (opt-in, poza check:all) startuje realny zbudowany serwer (`.mastra/output/index.mjs`, ten sam artefakt co `start-candidate.sh`) przeciw throwaway bazie na PRAWDZIWYM produkcyjnym replica set, i steruje nim gołym `fetch`. **Proof A:** POST komenda → realny dispatch → realne wywołanie modelu → ograniczony terminal przez realne HTTP. Kanarek (`weatherAgent`) na DOMYŚLNYM mouncie (goły caller) kończy `FAILED`/`empty_output` — **ustalona przyczyna** (odczytana ze store'u, nie zgadywana): bez `stopWhen`/`maxSteps` agent emituje tool call i nigdy nie dochodzi do finalnego tekstu, więc `bounded_text` nie ma czego zapakować. **To nie jest wina providera ani orkiestracji** (pierwotnie błędnie przypisałem to nieaktualnemu slugowi OpenRoutera — ten był realnym, osobnym bugiem, naprawionym w `d6cff05`, ale nie tą przyczyną). Mechanizm jest poprawny: job accepted→dispatched→attempted→terminalized. Kontrast w Proof E. **Proof A cd.:** terminal job widoczny przez conversation projection (odpytywane w pętli — `drainConversation` odpala się na ticku `reconcile()` co 5s, nie synchronicznie przy terminalizacji). **Proof B (dokładnie kryterium ukończenia F5):** SIGTERM w połowie, drugi niezależny proces na TEJ SAMEJ bazie → job i projekcja identyczne, nie przetworzone drugi raz, nie zdublowane. **Proof C:** zrestartowany proces przyjmuje i kończy NOWĄ pracę (pętle lane/worker faktycznie wznowione, nie tylko martwe odczyty). **Proof D:** dwa jobs w dwóch różnych conversationId kończą się niezależnie, zero cross-talk (A-long/B-quick w różnych rozmowach). Manifest: `ORC-TXN-C-01` → `verified` (pierwszy realny-HTTP + realny-restart dowód). **PROFIL HARNESSU DLA WORKERA V2** (`b0a25e2`) — znalezione przy audycie dokumentacji, **przestawiło kolejność prac F5**: worker V2 (`createMastraAgentCaller`) sięgał modelu **gołym `agent.generate`**, czyli capability przepięta na V2 **straciłaby** profil głębokości, reflektor, liveness, konsumpcję pending messages i koperty narzędzi — **regresja** względem tego, co `CAN-002`/`HRN-002` właśnie udowodniły na legacy. Dlatego „wepnij konsumenta" NIE mogło być pierwsze. `createHarnessAgentCaller` przepuszcza attempt przez `generateWithHarness`, wstrzykiwany jako `createRegistryWorker({makeCaller})` za flagą `FEATURE_ORCHESTRATION_V2_HARNESS_WORKER` (**default OFF**, więc shipped default bez zmian). Budżet zagnieżdżony po regule K3/K4: gateway trzyma zewnętrzny abort na `businessOperationCutoffAt`, harness dostaje `remaining - reserve` (dwa timery na jeden deadline byłyby wyścigiem). **Dwie pułapki ominięte, obie zablokowane testem:** wynik bierze PEŁNY tekst odpowiedzi, nie `outputPreview` (ucięty do 1000 znaków — zepsułby każdą większą kopertę `structured`), a pamięć V2 jest scope'owana na `orch-v2:<agentId>` + thread per job, żeby kanarek nie zanieczyścił pamięci produkcyjnego agenta. **`audit:harness` skanuje teraz `orchestration/`** — ten katalog był dla guardu strukturalnie niewidoczny, i dokładnie tak ta ścieżka mogła biegać bez profilu; goły caller ma jawny `@harness-exempt` z wyjaśnieniem, `orchestration/coverage/` pominięty (prosa w `notes` cytuje `agent.generate(...)`). **Dowód empiryczny mocniejszy niż argument za zmianą:** przy TYM SAMYM promptcie domyślny goły mount kończy `failed/empty_output`, a mount z harnessem **`COMPLETED`** — profil zmienia WYNIKI, nie tylko telemetrię. Testy: `check:v2-harness-worker` (w check:all, realny replica-set + kontrolowany fake model: asercja, że `prepareStep`+`stopWhen`+`memory` faktycznie trafiają na option bag) + `live-verify:f5-mastra-routes` **Proof E** (realny serwer z flagą, dowód z jego własnego stdoutu). Manifest: dopisane do `HRN-002` („pozostałe raw paths pod wspólnym kernelem" — ten worker był właśnie takim raw pathem, przeoczonym przy pierwszym domknięciu).

**PIERWSZY REALNY KONSUMENT** (`9636976`) — powierzchnia V2 przestała być „zbudowana i nieużywana". `metaAgent` dostał 4 narzędzia (`orchestration_start_job`/`get_job`/`list_jobs`/`cancel_job`) w **puli odkrywalnej** (nie always-on: durable job to praca, która ma przeżyć restart, nie każda tura), za flagą `FEATURE_ORCHESTRATION_V2_AGENT_TOOLS` (**default OFF**). **In-process, nie po HTTP** — agent wołający własny serwer odziedziczyłby niewidzialną ścianę 180 s `@mastra/deployer` bez żadnego zysku; narzędzia wołają store bezpośrednio przez `getV2Store()` (ten sam singleton co mount → jedno połączenie, jeden zestaw pętli). **Tożsamość NIGDY nie jest argumentem narzędzia** (§5.2 fail-closed): `resourceId` (`agent:<agentId>`) i `conversationId` pochodzą z kontekstu wykonania harnessu; gdyby model mógł podać `resourceId`, czytałby i anulował cudze joby po prostu o to prosząc. Job nieposiadany odpowiada dokładnie tak jak nieistniejący (brak existence oracle). **Trzy luki zamknięte po drodze, wszystkie znalezione testem, nie rozumowaniem:** (a) `getJobStatus` zwraca tylko status, a projekcja terminalna nie niesie payloadu — wołający widział `COMPLETED` i **nie miał jak odczytać wyniku**; dodane owner-scoped `getJobResult`. (b) **Cel nie uczestniczył w dedupe komendy** — `acceptStartCommand` hashuje wyłącznie `payload`, a narzędzie podawało `payload: {}`, więc ten sam `idempotencyKey` z INNYM celem po cichu zwracał PIERWSZY job, podczas gdy wołający był przekonany, że zakolejkował nowy; cel wędruje teraz do payloadu → jawny konflikt. (c) **Pętle tła startowały dopiero przy pierwszym UWIERZYTELNIONYM żądaniu HTTP** (`getStore()` jest za auth-checkiem w `withApi`) — dla substratu durable błąd podwójny: zrestartowany serwer zostawiał już przyjęte joby w `ACCEPTED`, a producent nie-HTTP (właśnie te narzędzia) nie dostawał wykonania **w ogóle**; `startV2Mount()` startuje je teraz przy boocie, błąd logowany a nie rzucany (niedostępny Mongo nie może blokować bootu). Testy: `check:durable-job-tools` (w check:all, realny replica set — pełna pętla + asercje, że obcy agent nie odczyta/nie anuluje/nie wylistuje cudzego joba, że tożsamość podana w inpucie nic nie daje i że narzędzia fail-closed bez kontekstu i przy fladze off) + **Proof F** w `live-verify:f5-mastra-routes`: narzędzie startuje job z procesu testowego, **osobny wystartowany serwer** go wykonuje, a narzędzie odczytuje **realną odpowiedź** (62 znaki realnego tekstu modelu) — ten rozjazd procesów to cały sens durable joba.

**DASHBOARD JAKO READER** (`acc133d`) — „durable job, którego nie widzisz, to durable job, któremu nie ufasz"; ta część musi istnieć **zanim** przepniemy jakikolwiek realny ruch, nie po. `GET /dashboard/orchestration/jobs` (board + liczniki, filtrowalne) i `/jobs/:jobId` (jeden job wraz z **payloadem wyniku**). **Świadomie NIE pod `/dashboard/v2/*`** — tamte to **analytics** dashboard v2 i nie mają z orkiestracją nic wspólnego poza cyfrą; zmieszanie ich byłoby stałym źródłem pomyłek. **Read-only z konstrukcji** (odczyt statusu nie może budzić joba, §8.2) — check asercjuje, że wyrenderowanie boardu zostawia każdy dokument joba i licznik zdarzeń nietknięty. **Najważniejszy do poprawnego zrobienia był stan, w którym produkcja jest DZIŚ:** przy `FEATURE_ORCHESTRATION_V2` OFF reader zwraca `enabled:false`, a **nie pusty board** — „substrat nie działa" i „działa, ale nie ma pracy" wyglądają na naiwnym dashboardzie identycznie, a mylenie ich jest aktywnie szkodliwe; skonfigurowany-ale-nieosiągalny store zwraca `unavailable` z tego samego powodu. Liczniki liczone po **całym** (przefiltrowanym) boardzie, nie po zwróconej stronie — inaczej `limit` po cichu zaniżałby ilość pracy. **Różnica zakresu, świadoma i udokumentowana:** to konsola operatora systemu jednoosobowego, więc czyta **ponad właścicielami**, w przeciwieństwie do narzędzi agentowych i handlerów `/v2`, które wiążą jeden `resourceId` z tożsamości wołającego — dlatego musi zostać za dotychczasową (lokalną, nieuwierzytelnioną) posturą dashboardu; cele skrócone w liście, pełny cel i wynik tylko dla jawnie wskazanego joba. Test: `check:dashboard-orchestration` (w check:all, realny RS). Zweryfikowane live na wystartowanym serwerze: pusty board → realny job → `completed:1` → detal zwrócił **realną odpowiedź modelu**, 404 dla nieznanego id.

**PEŁNY TOOLSET AGENTOWY — 10 KOMEND** (`b6cab68`): dołożone `pause`/`resume`/`append_instruction`/`steer`/`fork`/`answer_job_request`. Powierzchnia agentowa pokrywa teraz wszystko, co store faktycznie obsługuje. **Prawdziwa pułapka to idempotencja:** `applyControl` hashuje wyłącznie `{type, jobId}`, więc stały per-job `commandId` sprawiłby, że **DRUGI** pause trafia na zapisaną komendę, deduplikuje się i zwraca `changed:false` — cykl pause→resume→pause **po cichu zostawiłby joba działającego**. Dlatego każda komenda kontrolna losuje świeży `commandId`, a jawny `idempotencyKey` służy wyłącznie do bezpiecznego ponowienia **tej jednej** komendy; obie połowy przypięte testem. **Dwa świadome pominięcia zamiast cienkich wrapperów:** `activeAttemptPolicy: finish_as_evidence` NIE jest wystawiony (jest fail-closed do czasu `ORC-TXN-A-EVIDENCE-01`, a przełącznik, który zawsze zwraca błąd, jest gorszy niż jego brak), oraz `steer` po materializacji planu jest odrzucany przez store z założenia (wynik starego planu mógłby terminalizować nowy) — narzędzie tłumaczy to na **wskazówkę** („użyj append_instruction, albo anuluj i zacznij od nowa") zamiast surowego 409, który model po prostu by ponowił. Tak samo `resume` w nieustabilizowanej barierze pauzy zwraca `retryable:true`, a odpowiedź na zamknięte pytanie mówi, że było już odpowiedziane albo wygasło. `check:durable-job-tools` urósł do **19 asercji**, w tym: każda nowa komenda kontrolna jest owner-scoped (nie tylko odczyty), a obcy wołający wykonujący pause/resume/append/steer/fork/answer zostawia joba nietkniętego.

**META FRONT — TOŻSAMOŚĆ I PROMPT** (`8d53d3c`): `metaFrontAgent` (§4.1 `front_only`) — szybki agent konwersacyjny, do którego zawsze można się dobić; długą pracę zamienia w durable job, potwierdza w sekundach z `jobId` i raportuje w kolejnych turach, **nigdy nie trzymając otwartego połączenia do końca joba**. **Nieblokowalność jest STRUKTURALNA, nie obietnicą w promptcie:** cały jego toolset to 10 komend durable-job — nie ma shella, gita, n8n, przeglądarki, mediów, delegacji ani surowego dostępu do bazy, po które mógłby sięgnąć; `check:meta-front-agent` egzekwuje to **kategoriami** po realnych id narzędzi, więc dołożenie „jeszcze jednego" musi najpierw wywalić ten test. **Świadomie OSOBNY agent, nie zwężony `metaAgent`** — mimo że tabela migracji planu mówi, iż to `metaAgent` ma zostać `front_only`: to cel, nie pierwszy krok, bo metaAgent ma dziś ~90 narzędzi, a produkcja jedzie **w całości** na legacy delegacji, więc zwężenie go teraz **zatrzymałoby działający system**; scalenie obu to cutover Fali 5 (test pilnuje, że metaAgent zachowuje swój toolset). **Konieczny był dedykowany endpoint `POST /v2/front/messages` i ustalenie DLACZEGO było właściwą robotą:** narzędzia jobowe wywodzą tożsamość z *runu*, a zwykły endpoint agentowy Mastry **żadnego runu nie otwiera** — wstrzykuje `threadId` tylko dla narzędzi sub-agentowych, nie dla zwykłych. Front osiągnięty tamtą drogą **mógł rozmawiać, ale nigdy zakolejkować pracy**: każdy `start_job` padał na „no run identity", a model przepraszał i odpowiadał inline (zaobserwowane live, dwa razy, zanim znalazłem przyczynę w źródłach Mastry). Endpoint wiąże `conversationId` i zasób wołającego wokół `generate` — dokładnie obowiązek „autoryzacja oraz związanie `resourceId` z `conversationId`", który §4.1 przypisuje frontowi. Model: `gemini-3.1-flash-lite` (front klasyfikuje, potwierdza i raportuje — ciężki model przeczyłby sensowi). **Dowód live (Proof G):** front przyjął zlecenie w **1,6 s** z realnym `jobId`, w bazie pojawił się realny durable job dla tej rozmowy, a kolejna tura **tej samej rozmowy** zaraportowała gotowy wynik — nie powtórzenie własnej wcześniejszej wiadomości.

**Zostaje w F5** (4-6 sesji szacunku, ~6 zużytych): dashboard jako **command client** + UI (dziś same endpointy JSON), NL routing corpus (K5), SSE (dziś tylko poll). **I krok operacyjny, nie kodowy: włączyć flagi w `.env`** — dziś produkcyjny `.env` nie ma ANI JEDNEJ flagi V2, więc trasy nie są zamontowane, pętle nie chodzą, front nie jest zarejestrowany, a narzędzia nie są oferowane. Wszystko powyżej jest **udowodnione, nie wdrożone**. |
| **F5B** — Lane Orchestrator | ✅ (flat slice; rezerwa budżetowa odłożona) | `e609eed` `019b677` `fd0650e` `1423c44` `0453812` | Agentowy koordynator wewnątrz deterministycznej granicy (§4.2 rodzica). **Powód wydzielenia:** F5 dał powierzchnię i trwałość, ale nie koordynację — dziś w lane nie ma **ani jednego wywołania modelu**, planowanie to deterministyczne `PLAN_SINGLE_SERIAL_TASK_V1`. Szew istnieje: w `activations.ts` propozycja planu jest zbudowana **na sztywno** między `startPlanningActivation` a `markPlanningActivationPayloadReady`; zmieniamy wyłącznie ten krok, a lease/fence/marker/hash/CAS zostają. Zasada: model produkuje **propozycję**, nigdy autorytet — identyfikatory i wersje wstawia kod. |
| F6 — Fala 5 konsolidacja + cutover | ✅ (5/5 prac; drain legacy trwa) | `905d035` `cf9aa2a` `409759d` `1181824` `22fda60` | Delegacja i automation zeszły z legacy, capability BUILD utwardzony, Ledger jest projekcją a kill switch sięga V2. Dziennik: „F6 KROK 1–5". **Zostało odliczanie: 1 wiersz `drained-in-v1` musi dojść do zera, zanim legacy da się usunąć.** |
| **F6B** — plan wielozadaniowy (sekwencja domenowa) | ✅ (4/4 slice'y) + 🔧 `GAP-PLAN-STEPS-01` domknięte 2026-08-12 | `c1ad2e7` `69ae719` `fb72308` + (ten commit) | **Substrat, nie migracja.** Dziś tor prowadzi przez job dokładnie JEDNEGO agenta. `spawnChildTasks`/`resolveParentTask` istnieją i lane je woła — brakuje tego, żeby ktoś dzieci TWORZYŁ, żeby niosły capability i budżet, oraz kanału wyniku między krokami. Aktywacja `ORC-DISPATCH-EDGE-01`. **SPROSTOWANIE:** przez cały czas od zamknięcia `plan_steps` NIE WYSTĘPOWAŁO w żadnym promptcie — kontrakt, store, żywy lane i brama 17 asercji były gotowe, a model nigdy nie dostał tej opcji, więc każdy job jechał jako pojedyncze zadanie. Brama była zielona, bo **sama konstruowała decyzję**. Naprawa: słownik w `prompts/lane-orchestrator/base.md` + gałąź PLAN `buildDecisionPrompt` + alert `final_decision_unexecutable_kind` + 4 asercje (dwie oblewają na starych promptach). **Canary z realnym modelem: DO ZROBIENIA.** |
| F7 — Fale 6–9 migracja agentów | 🔄 (5 zmigrowanych + siódemka przez sito + handoff MCP; sales pominięty) | `63c6eb0` `9ac5ed3` `c27b9f8` + (ten commit) | KROK 0 pas gotowości 18/18. **Sito K1–K11** (`docs/MIGRACJA-AGENTA-NA-V2.md`) — K9b i K11 dopisane przez canary, nie przez projektowanie. **designAgent ✅** (martwy kanał artefaktów: dwa niezależne przerwania). **automationArchitect ✅** (K3 precontext + `GAP-SIDE-EFFECT-RESULT-01`: wdrożony workflow raportowany jako FAILED i powtarzany). **huntAgent ✅** (raport ZAWYŻAŁ zapisy do CRM). **marketingAgent ✅** (router nie widział `whenNotToUse`; run nie znał dzisiejszej daty i wpisał follow-up 3 miesiące wstecz). **Współpraca architekt↔n8nMcpEngineer zweryfikowana** (deploy węzła spoza rdzenia; tożsamość wywołującego z runu, nie z deklaracji modelu). Instrukcja wykonawcza dla kolejnych: `docs/PROMPT-MIGRACJA-AGENTOW-V2.md`. |
| F8 — G8 fault suite | ✅ 6/6 scenariuszy (§3.1–3.5 z `ideas/f8-pozostale-scenariusze.md`) + wszystkie 3 właściwości z definicji ukończenia (brak split-brain / duplicate effect / **lost outbox**) | `eb9809d` `7c163ff` `a63e840` `940dd68` `cc67d71` (+ ten commit) | patrz akapit niżej |
**F8 — DOMKNIĘCIE** (`eb9809d` `7c163ff` `a63e840` `940dd68` `cc67d71`): kolejność wg §2 dokumentu-zadania —
najpierw **lost outbox** (jedyny pilny, bo nie wymaga trzech węzłów i produkcja dziś jest jednowęzłowa), potem
§3.2–3.5 w dowolnej kolejności. Wszystkie sześć scenariuszy zielone i **jawnie sfalsyfikowane** (nie zadeklarowane
— każda asercja zepsuta i uruchomiona, żeby zobaczyć ✗, zanim uznana za dowód). Poza `check:all` — potrzebują
zestawu 3-węzłowego (`npm run infra:rs3:up`), zgodnie z §6 dokumentu-zadania.

**`f8:no-lost-outbox`** znalazł i naprawił **prawdziwy bug** w `conversation-writer.ts` (nie w teście): strażnik
idempotencji mailboxa łapał duplikat-key 11000 i osiadał zdarzenie na `DELIVERED` **w tej samej transakcji** —
ale duplikat-key wewnątrz transakcji ABORTUJE ją po stronie serwera, więc ten `updateOne` sam dostawał kod 251
z etykietą `TransientTransactionError`, `runTxn` restartował callback, trafiał na TEN SAM duplikat i wypalał
budżet 50 retry. Ponieważ writer zawsze bierze NAJSTARSZE zdarzenie PENDING, jedno przeterminowane zdarzenie
zablokowałoby drenaż KAŻDEJ rozmowy na zawsze. Naprawa: czytaj slot PRZED insertem (wzorzec, którego już używają
`command-boundary.ts:184` i cztery miejsca w `control-boundary.ts` — ten writer był tu wyjątkiem). Po drodze
zmierzono i poprawiono błędne zdanie w nagłówku `f8-unknown-commit-idempotent.ts`: etykiety `MongoNetworkError`
z zabitego commitu **NIE są puste** — noszą `UnknownTransactionCommitResult` (sprawdzone printem w
`f8:transient-retry-split`), więc `runTxn` retryuje COMMIT, nie callback; asercje się nie zmieniły, rozumowanie
w komentarzu było błędne. Osobne odkrycie: zabity commit zostawia transakcję OTWARTĄ na serwerze (locki trzymane
do `transactionLifetimeLimitSeconds`, zmierzone 67–87s odzysku) — kolejny writer nie jest "zepsuty", tylko
zakolejkowany za duchem.

**`f8:stepdown-lease-renewal`**: pierwsza hipoteza falsyfikacji (wyłączyć branch `TransientTransactionError` w
`runTxn`) była błędna i **zmierzona jako błędna**, nie zgadnięta — 8874 transakcji przepchniętych przez realny
`rs.stepDown()` dało zero retry, zero błędów; sterownik Mongo absorbuje realny stepdown W CAŁOŚCI, zanim
cokolwiek dotrze do `runTxn`. Prawdziwa falsyfikacja: klient PINOWANY (`directConnection`) do zdegradowanego
węzła nie potrafi dokończyć pracy, podczas gdy zwykły (routowany po pełnej liście seedów) klient przechodzi przez
handover bez przeszkód — to jest realne ryzyko regresji (ktoś kopiuje wzorzec `directConnection` z własnych
scenariuszy chaosu do zwykłej ścieżki kodu), nie "sterownik czasem zawodzi".

**`f8:partition-claim-heartbeat`** (3 ramiona: musi dokończyć / granica ttl-vs-outage / wyparcie przez realną
elekcję) odkrył, że odmowa `submitAttemptResult` dla zakończonego attemptu jest **czterowarstwowa**: górne
porównanie fence (`attempts.ts:1558`), `leaseOwnerAtCommit` (`:1562`), hash payloadu (`:1565`), i domyślne
"zamknięte" przejście na końcu blocku FINISHED (`:1587`). Pierwsze TRZY próby falsyfikacji (wyłączenie jednej
warstwy na raz) zostały zielone — każda kolejna warstwa łapała to, co poprzednia przepuściła, czasem z INNYM
komunikatem (`payload_hash_mismatch` zamiast `stale_fence_or_lease`). Tylko wyłączenie wszystkich czterech NARAZ
dało prawdziwy, niezabezpieczony commit. Ten sam ślad wykorzystany bez powtarzania w `f8:delayed-retry-after-terminal`.

**`f8:delayed-retry-after-terminal`** testuje skalę MINUT (>90 000 ms, `jobControlRecoveryReserveMs`), zmierzone
a nie założone (log drukuje realny upływ czasu), i dowozi JOB (nie tylko task) do faktycznego stanu terminalnego
przez `drainLane` przed powrotem spóźnionego workera. Po drodze: warstwa czwarta z powyższego odkrycia jest CZYSTĄ
DECYZJĄ bez zapisu — jej falsyfikacja fałszuje SYGNAŁ (`committed:true` zamiast `false`), nie tworzy drugiego
dokumentu w `results`; asercja o liczbie wyników i asercja o prawdzie sygnału rozdzielone celowo, żeby żadna nie
twierdziła więcej niż zmierzyła.

`bash scripts/check-all.sh` → **exit 0** po wszystkich zmianach. Odblokowuje canary z
`ideas/rollout-wlaczenie-silnika-v2.md` (czekał na "domknięcie ostatniego scenariusza F8") — decyzja o
włączeniu flag należy do właściciela, nie jest skutkiem tej sesji.

| F9 — Fala 10 rollout | ⬜ | — | — |
| **ROLLOUT V2 — włączenie uzgodnionego zestawu** *(`ideas/rollout-wlaczenie-silnika-v2.md`)* | 🔄 przygotowanie ✅, **canary 0/8** | `bd48e6b` | **Blocker §2 zdjęty.** `securityReviewAgent`/`performanceReviewAgent` nie miały precontextu w V2, choć legacy daje go **każdemu** recenzentowi (`buildReviewPrecontext` kluczuje po runtime `agentId`, nie po zaszytym ID) — włączenie ich w tym stanie znaczyłoby „ten sam agent dostaje mniej kontekstu niż wcześniej". **Falsyfikacja wykryła, że brama była DEKORACJĄ:** przed naprawą usunięcie loadera zostawiało `check:capability-precontext` zielone (exit 0), bo wszystkie asercje nazywały agentów po ID i żadna nie dotyczyła nowych wpisów; po dopisaniu dwóch asercji tożsamości ta sama operacja daje `1 FAILED` (exit 1). Bez falsyfikacji dołożylibyśmy wpisy pod bramę niezdolną ich obronić. **Audyt pełnego rosteru (30 wpisów w `index.ts`, nie z pamięci):** precontext w legacy ma **tylko 6** agentów — 4 zarejestrowane + ci dwaj; reszta idzie bare-generate albo przez `generatePipelineWithReflection`, który świadomie **nie** dodaje nic domenowego, więc nikt inny nic nie traci. **`n8nMcpEngineer` zweryfikowany i celowo POZA listą** — to nie capability, tylko krok wewnątrz runu architekta: `dispatchDurableDelegation` ma jedno wywołanie (`async-delegation.ts:176`), a MCP nie może tam trafić trzema zatrzaskami (async odrzucany `:365`, `return` przed blokiem async `:679`/`:830`, `supportsGenericAsync` `:819`). Brama tożsamości (`:357`, tylko `automationArchitect`) przeżywa V2, bo `resolveDelegationCaller` (`:152`) bierze identity z **runu** i kanonikalizuje — inaczej build umierałby na brakującym polu, nie na pracy. Budżet handoffu na V2 ≥ legacy (idle resetuje się na zdarzeniach → pełne 240 s; legacy w 19. minucie daje ~40 s). **Wykluczeni:** `filmmakerAgent` `musicianAgent` `capabilitySmith` (decyzja 2026-08-18), `salesAgent` (właściciel potwierdził wykluczenie 2026-08-18). ⚠️ **Flagi w `.env`, ale serwer NIE zrestartowany — tło nadal jedzie legacy, `orch_jobs` = 0.** Canary czeka na domknięcie ostatniego scenariusza F8. |

---

## 7. Szacunek całości

| Etap | Sesje | Stan |
|---|---|---|
| F1 replica set | 1 | ✅ zrobione |
| F2 Fala 1 | 2–3 | ✅ zrobione (w zakresie mającym sens) |
| F3 Fala 2 | 3–4 | ✅ zrobione (kontrakty + K15); zostaje odłożone `budgetedMongo` (nieblokujące) |
| F4 Fala 3 | ~~2–3~~ 1 (bez kodu) | ✅ zrobione (audyt; reszta zgatowana Falami 6–7) |
| **F5 Meta Front — pierwsze realne użycie** | **4–6** | 🔄 ~6 zużytych: real HTTP + restart + profil harnessu + reader + toolset + **Meta Front działa live**; zostaje command-client/UI + NL routing + SSE + **włączenie flag w `.env`** |
| **F5B Lane Orchestrator** (agentowy koordynator) | **3–5** | ✅ zrobione (flat slice): granica decyzji + model decyduje + człowiek w pętli + **ocena wyniku/replan**; odłożone: chroniona rezerwa budżetowa, eskalacja, synteza tekstowa, fan-out |
| F6 Fala 5 cutover | 5–8 | ✅ **5 zużytych, 5/5 prac**. 1+2 = cutover za flagą (OFF), live-verified: SIGKILL→`WORKER_LOST`→retry→`COMPLETED`; durable Golden Path bez deployu. 3+4+5 bez flagi (naprawy): lease/fence/permit w BUILD; Ledger jako projekcja + kill switch sięga V2; reguła next-fire + `audit:cutover`. Zostało odliczanie `drained-in-v1 → 0` |
| **F6B plan wielozadaniowy** | **3–5** | ✅ zrobione w 1 sesji (4 slice'y). Było **przed Falą 7** — bez tego migracja pipeline'owych agentów zakonserwuje delegację wewnątrz runu |
| F7 Fale 6–9 agenci | 10–17 | ⬜ |
| F8 G8 | 3–5 | ⬜ |
| F9 rollout | 3–5 | ⬜ |
| **Pozostało** | **~16–27 sesji** | F7 agenci (10–17) + F8 G8 (3–5) + F9 rollout (3–5); ogony F5 (dashboard command client, SSE, NL routing) 1–2 |

**Do pierwszego realnego użycia zostało: włączenie flag** — F1–F4 zamknięte, F5 działa live
(front przyjmuje zlecenie, durable job przeżywa restart, wynik wraca do rozmowy). To już nie
jest kwestia sesji, tylko decyzji operacyjnej.

**Ale uwaga na to, czego włączenie flag NIE da:** dopóki nie ma **F5B**, linia orkiestracji
jest deterministyczna — jeden task, jeden agent (`singleAgentRoute`), zero oceny wyników
i przeplanowania. V2 jest wtedy *trwalsze* od legacy, ale **nie mądrzejsze**; koordynację
wieloma agentami nadal robi legacy `metaAgent`. F5B jest etapem, który tę wartość odzyskuje.

Dla porównania: samo domknięcie G0 to ~17–30 sesji **bez** żadnego użycia.

**Postęp kontraktów:** `deferred` **10 → 7**, `verified` **11 → 14** (`CAN-002`, `HRN-002`,
`ORC-TXN-C-01`), `implemented` **19** netto bez zmiany (`ORC-RESULT-READY-01` relabel z
`deferred`, zero zmiany kodu, skompensowane przez `ORC-TXN-C-01` awans do `verified`).
`SEC-001` i `HRN-001` zostają `deferred` mimo domknięcia sensownych części — pełne wymagają
wielodostępu (nie istnieje) i konsumenta streamu (pojawi się w F5).
`ORC-SPECULATION-01`/`ORC-ATTACHED-01`/`ORC-TXN-A-EVIDENCE-01` rodzic gatuje falą konsumenta
(6–7) — mogą zostać `deferred` na stałe i **to nie jest dług**, tylko świadoma decyzja
(F4 audyt dołożył `ORC-TXN-A-EVIDENCE-01` do tej samej kategorii — zero konsumentów, patrz F4).

---

## 8. Dług i dokumenty towarzyszące

- [`docs/TECH-DEBT-TIMEOUTS.md`](../docs/TECH-DEBT-TIMEOUTS.md) — dług A–E (K15 `execSync`
  zamraża event loop; I5 `curl` bez limitu w rollbacku — warto zrobić przy okazji F1/F3)
- [`ideas/liveness-budget-plan.md`](./liveness-budget-plan.md) — szczegóły E0
- [`ideas/timeouts-audit.md`](./timeouts-audit.md) — źródłowa mapa kolizji
- [`docs/ORCHESTRATION-PAUSED-HANDOFF.md`](../docs/ORCHESTRATION-PAUSED-HANDOFF.md) —
  jak wznowić G0, gdy zdecydujemy je domknąć

⚠️ **Terminologia:** „Meta Front" = **nowa warstwa V2** (F5), a **nie** dzisiejszy `metaAgent`
(zweryfikowane: `metaAgent` używa komend V2 zero razy).
