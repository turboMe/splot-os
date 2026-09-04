# Meta-Agent: nieblokująca rozmowa, trwała orkiestracja i warstwa głosowa

**Data researchu:** 2026-07-22  
**Status:** rozeznanie architektoniczne — bez zmian implementacyjnych  
**Dokument bazowy:** [IDEALSYSTEMMASTERPLAN.md](./IDEALSYSTEMMASTERPLAN.md)

## Werdykt

Nie należy uruchamiać kilku niezależnych „mózgów” Meta dla tej samej rozmowy. Zalecana architektura to:

- jeden logiczny Meta-Front będący właścicielem rozmowy,
- osobny, trwały lane/job dla każdego większego celu,
- pula agentów wykonawczych,
- wyniki wracające jako zdarzenia, które automatycznie wybudzają właściwy lane,
- wiele fizycznych replik dopiero później, z kolejką lub blokadą per rozmowa/lane.

Master plan zmierza w dobrym kierunku i sam ostatecznie dochodzi do podobnej konkluzji: lanes zamiast równorzędnych instancji Meta. Natomiast oznaczenie E1 jako ukończone jest obecnie zbyt optymistyczne. Istnieje delegacja asynchroniczna i Ledger, ale nie ma jeszcze autonomicznej, trwałej pętli:

```text
wynik agenta → ocena → retry/replan → następna delegacja → synteza
```

Dzisiejszy przepływ jest bliższy temu:

```text
wynik agenta → pending message → oczekiwanie na następną wiadomość użytkownika
```

## Co faktycznie działa obecnie

Meta może zwolnić swoją turę po delegacji tylko wtedy, gdy konkretna ścieżka wybierze `async: true`. Domyślnie `async` jest wyłączone w [`delegate-task.ts`](../src/mastra/tools/system/delegate-task.ts).

Po delegacji asynchronicznej:

1. Rekord zostaje zapisany.
2. Praca jest uruchamiana przez `void executeDelegation(...)` w tym samym procesie Node.
3. Po zakończeniu wynik trafia do kolejki pending messages.
4. Meta zobaczy go dopiero przed następnym `generate`, gdy processor pobierze pending updates.

Kluczowe miejsca:

- [`async-delegation.ts`](../src/mastra/services/async-delegation.ts),
- [`pending-message-queue.ts`](../src/mastra/services/pending-message-queue.ts),
- [`pending-updates.ts`](../src/mastra/processors/pending-updates.ts).

Nie ma zdarzenia wywołującego krótką, autonomiczną turę orkiestratora. Jeżeli użytkownik już nic nie napisze, Meta nie oceni rezultatu, nie ponowi zadania i nie złoży wyniku.

Task Ledger jest obecnie głównie warstwą obserwowalności. Dokumentacja [`TASK-LEDGER.md`](../docs/TASK-LEDGER.md) mówi wprost, że Ledger obserwuje istniejące procesy, ale nimi nie steruje.

## Czy Meta jest dziś „zablokowany”

Trzeba rozróżnić dwa rodzaje blokowania:

- Zwykłe `await agent.generate()` nie musi blokować całego event loop Node. Serwer może technicznie przyjąć drugi request, ale pierwsza tura Meta pozostaje otwarta, a dwa runy na tym samym `threadId` mogą ścigać się o pamięć, narzędzia i kolejność zapisów.
- `execSync` faktycznie blokuje event loop. Taka ścieżka istnieje w narzędziach codingowych i może zatrzymać również nową rozmowę z Meta nawet na około 30 sekund w [`external-projects-tools.ts`](../src/mastra/tools/dev/external-projects-tools.ts).

Sam wrapper Meta oczekuje na cały harness w [`meta-harness.ts`](../src/mastra/services/meta-harness.ts). Dodatkowo modyfikuje `generate`, ale nie zapewnia identycznego zachowania dla `stream`, co będzie szczególnie ważne przy komunikacji głosowej.

## Audyt wszystkich klas agentów

W `delegateTask` jest 18 celów delegacji.

| Klasa | Agenci | Obecna sytuacja |
|---|---|---|
| Dedykowane harnessy | coding, automation, knowledge | Potrafią działać async, ale bez jawnego `async: true` Meta czeka nawet 300/1200/300 sekund. |
| Sync-only | n8n MCP, deliberation | Meta zawsze czeka na zakończenie `generate`. |
| Generic/direct | marketing, sales, analytics, CRM, researcher, design, capabilitySmith | Kod obsługuje async, lecz Agent Board nadal część z nich opisuje jako sync. Prompt i runtime mają więc niespójną politykę. |
| Pipeline | chef, content, hunt, writer, filmmaker, musician | Tryb sync używa pipeline reflectora, ale async przechodzi przez zwykłe `agent.generate`. Async traci więc część ograniczeń, telemetrii i refleksji pipeline’u. |

Dodatkowo wewnętrzne blank-workery uruchamiane przez [`run-worker.ts`](../src/mastra/tools/system/run-worker.ts) są zawsze oczekiwane i nie mają wspólnego mechanizmu async/timeout.

Najpoważniejsze problemy przekrojowe:

- Restart procesu może pozostawić job jako `running`, mimo że nikt już go nie wykonuje.
- Pending queue nie ma atomowego claimu: najpierw odczytuje rekordy, potem osobno oznacza je jako zużyte.
- Brak `threadId` uruchamia globalny fallback, więc istnieje ryzyko skonsumowania aktualizacji należącej do innej rozmowy.
- Nested delegation ma niespójne `caller/origin/returnAgent`; część orkiestratorów nie ma processora odbierającego wynik.
- Asynchroniczny `ResultEnvelope` nie jest wystarczająco oceniany. Samo zwrócenie tekstu może oznaczyć GoalContract jako ukończony, nawet gdy wynik jest częściowy.
- Anulowanie często zmienia status, ale nie przerywa faktycznego procesu lub wywołania.
- Claims dla większości ścieżek pokazują konflikt, lecz realnie nie wstrzymują wykonania.

Te problemy powodują, że uruchomienie teraz kilku instancji Meta zwiększyłoby ryzyko duplikacji, błędnego routingu i konfliktów pamięci.

## Docelowa architektura

```text
Tekst / STT
    │
    ▼
Conversation Actor / Meta-Front
- jeden logiczny writer per conversation_id
- krótka rozmowa i statusy
- przyjmuje korekty, pause/cancel, nowe zadania
- nie czeka na wykonawców
    │
    │ start_job() → job_id
    ▼
Durable Orchestration Lane
- osobny lane per cel
- plan_version, attempt_id, budżet, deadline
- planowanie, fan-out/fan-in
- review, retry, replan, approval, synthesis
    │
    ├── coding
    ├── researcher
    ├── writer
    └── inni wykonawcy
         │
         ▼
    trwałe result events
         │
         └──────► lane zostaje automatycznie wybudzony
                       │
                       ├── ponawia / zmienia plan
                       ├── deleguje kolejny krok
                       ├── pyta użytkownika
                       └── publikuje wynik i krótki status
```

Meta-Front i lane mogą korzystać z tego samego modelu oraz części promptu, więc dla użytkownika nadal będzie to „ten sam Meta”. Nie powinny jednak być tym samym aktywnym runem ani współdzielić jednego mutable threadu zadania.

Najważniejszy podział identyfikatorów:

- `conversation_id` — rozmowa z użytkownikiem,
- `job_id`/`lane_id` — jeden cel użytkownika,
- `task_id` — pojedyncza delegacja,
- `attempt_id` — konkretna próba,
- `plan_version` — wersja planu, która wygenerowała próbę.

Dzięki temu wynik starszej próby nie zostanie przypadkowo dołączony do nowego planu.

Lane powinien mieć jawną maszynę stanów:

```text
ACCEPTED → PLANNING → DISPATCHING → AWAITING_RESULTS
         → REVIEWING
         → RETRYING | REPLANNING | AWAITING_USER
         → SYNTHESIZING
         → COMPLETED | FAILED | CANCELLED
```

Każda zmiana stanu i event publikowany do kolejki powinny być atomowe poprzez inbox/outbox. Konsumenci muszą być idempotentni, ponieważ praktyczne systemy kolejkowe zwykle gwarantują dostarczenie co najmniej raz, a nie dokładnie raz.

## Jak użytkownik może rozmawiać podczas pracy

Nowa wiadomość użytkownika powinna zostać sklasyfikowana jako jedna z czterech operacji:

1. zwykła rozmowa niezwiązana z aktywnym jobem,
2. pytanie o status,
3. korekta konkretnego joba,
4. anulowanie/przerwanie albo rozpoczęcie nowego joba.

Dla korekty trzeba ustalić jawne zachowanie:

- `queue` — zastosuj po bieżącym kroku,
- `steer` — zmień plan istniejącego joba,
- `interrupt` — przerwij bieżącą próbę,
- `fork` — rozpocznij osobny job.

Wiadomości użytkownika dla jednej rozmowy powinny być serializowane. Same joby mogą działać równolegle.

Jest to zgodne z dojrzałymi rozwiązaniami:

- Mastra ostrzega, że dwa równoległe runy zapisujące do jednego threadu prowadzą do niespójności i proponuje strategie queue/debounce/batch/skip: [Mastra multi-user agents](https://mastra.ai/blog/building-multi-user-multi-channel-agents).
- LangGraph wymusza jawne strategie konfliktu na jednym threadzie, m.in. enqueue, interrupt i rollback: [LangGraph background runs](https://docs.langchain.com/langsmith/agent-server-api/thread-runs/create-background-run).
- Temporal traktuje workflow jak trwały, stanowy aktor przyjmujący Signals, Queries i Updates: [Temporal message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing).
- Orleans również opiera bezpieczeństwo na pojedynczym writerze/turnie aktora i ostrzega przed niekontrolowanym interleavingiem: [Orleans scheduling](https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-scheduling).

## Czy korzystać z wielu instancji Meta

Tak, ale dopiero w następującym znaczeniu:

- wiele replik bezstanowego API,
- wiele równoległych rozmów,
- wiele lane’ów/jobów,
- osobna pula workerów.

Nie należy uruchamiać:

- dwóch instancji równocześnie zapisujących do tej samej rozmowy,
- dwóch Meta podejmujących niezależne decyzje o tym samym jobie,
- routingu wyniku workera do przypadkowej instancji Meta.

Routing powinien zapewniać jeden logiczny writer przez partition key, lease, kolejkę FIFO per conversation/lane albo optimistic locking z wersją stanu.

## Co daje obecna i nowsza Mastra

Projekt deklaruje `@mastra/core ^1.31.0`, a lockfile przypina wersję 1.32.1.

Ta wersja ma już prymitywy Background Tasks i Durable Agents, których projekt obecnie nie wykorzystuje. Background Tasks zapewniają trwały stan, limity współbieżności, retry, wznowienie i obserwację wykonywania:

- [Mastra Background Tasks](https://mastra.ai/docs/long-running-agents/background-tasks),
- [Mastra Durable Agents](https://mastra.ai/blog/introducing-durable-agents).

Nowsze mechanizmy pasują jeszcze lepiej:

- Signals: adresowalne pętle, kolejka wiadomości, deduplikacja i wybudzanie agenta; wymagają co najmniej 1.39 — [Mastra Signals](https://mastra.ai/blog/announcing-agent-signals).
- Event system/PubSub: replay zdarzeń i rozproszone transporty; od 1.34 — [Mastra Events](https://mastra.ai/blog/introducing-mastras-event-system).
- AgentController: sesje, subagenci, tryby, uprawnienia i interakcja z aktywnymi agentami; wymaga 1.47+ — [Mastra AgentController](https://mastra.ai/blog/build-claude-code-for-x-with-agentcontroller).
- Snapshoty workflow przechowują stan kroków, retry i suspend/resume — [Mastra workflow snapshots](https://mastra.ai/en/reference/workflows/snapshots).

Rekomendacja: nie budować od razu całego runtime’u od zera. Najpierw przeprowadzić izolowany spike aktualizacji Mastry i sprawdzić Background Tasks, Signals, Durable Agents oraz AgentController z obecnym customowym Meta harness. Dopiero potem zdecydować, która część własnego harnessu nadal jest potrzebna.

Temporal warto rozważyć dopiero, jeżeli potrzebne będą wielogodzinne lub wielodniowe joby, silny restart/replay, wiele zewnętrznych efektów ubocznych i skalowanie na wiele procesów. Zapewnia mocniejszą trwałość, ale też większy koszt operacyjny: [Temporal](https://docs.temporal.io/).

## STT/TTS

Warstwę głosową należy oddzielić od orkiestracji:

```text
audio → VAD/STT → tekstowy event → Meta-Front
Meta-Front → { displayText, spokenText, artifactRefs }
                           │
                           └── TTS tylko dla spokenText
```

`spokenText` powinien zawierać wyłącznie:

- przyjęcie zadania,
- istotny milestone,
- pytanie lub prośbę o akceptację,
- błąd/bloker,
- krótkie zakończenie.

Przykłady:

- „Przyjąłem. Uruchamiam research i analizę kodu.”
- „Pierwszy agent skończył, ale wynik wymaga ponowienia.”
- „Potrzebuję decyzji: poprawić obecny wariant czy zacząć nowy?”
- „Gotowe. Pełny raport jest w panelu.”

Pełne wyniki delegacji i logi powinny trafiać do UI/artifact store, nigdy bezpośrednio do TTS.

W obecnym kodzie audio jest rozpoznawane jako typ załącznika, ale nie ma kompletnego przepływu STT → Meta → TTS. Załącznik zostaje zasadniczo zastąpiony markerem tekstowym w [`prompt-attachments.ts`](../src/mastra/services/prompt-attachments.ts).

Referencyjna architektura Mastry dla voice stosuje taki sam podział: aktywny agent głosowy z przodu, trwały workflow w tle i statusy wracające przez event bus/SSE — [Mastra voice architecture](https://mastra.ai/blog/voice-agent-render-assemblyai).

Od początku należy także uwzględnić barge-in: użytkownik powinien móc przerwać TTS, a historia musi odzwierciedlać tylko fragment, który faktycznie usłyszał.

## Czy trzeba najpierw testować każdego agenta

Tak, ale nie przez 18 kosztownych, pełnych E2E.

Najpierw jeden parametryczny test kontraktu uruchamiany dla wszystkich agentów:

- prawidłowy routing sync/async,
- szybkie potwierdzenie przyjęcia async,
- osobny child thread,
- poprawne `caller/origin/return`,
- dokładnie jeden callback,
- `ok/partial/failed/blocked`,
- timeout i rzeczywiste cancellation,
- idempotencja i ochrona przed rekurencją.

Potem realny smoke per klasa wykonawcza:

- dedicated harness: coding, automation, knowledge,
- sync-only: n8n, deliberation,
- generic: researcher/design/capability,
- pipeline: co najmniej writer oraz jeden agent media,
- nested delegation: automation, writer, capabilitySmith.

Najważniejszy test całego systemu powinien wyglądać tak:

1. Tura A uruchamia zadanie trwające 10–20 sekund.
2. W trakcie tura B na tym samym `threadId` zadaje Meta proste pytanie.
3. B odpowiada bez czekania na A.
4. Wynik A automatycznie wybudza właściwy lane.
5. Lane dokładnie raz wykonuje review/retry/replan/synthesis.
6. Żadna wiadomość nie zostaje utracona ani przypisana do innego wątku.

Trzeba też wstrzyknąć awarie:

- restart procesu,
- podwójny callback,
- wynik poza kolejnością,
- stary `attempt_id`,
- provider rate-limit,
- anulowanie subprocessu,
- kilka jednoczesnych wyników.

Obecny test [`e2e-ledger-three-lanes.ts`](../src/mastra/scripts/e2e-ledger-three-lanes.ts) tego nie dowodzi. Uruchamia trzy procesy `sleep`, nie wykonuje dwóch rozmów z Meta i mierzy „chat fluid” jako szybkość odczytu Mongo poniżej 1,5 sekundy.

## Proponowana kolejność wdrożenia

1. Spisać kontrakt Conversation/Job/Task/Attempt oraz zasady `queue/steer/interrupt/fork`.
2. Zrobić izolowany spike nowszej Mastry, szczególnie Signals i AgentController.
3. Zbudować test kontraktowy dla wszystkich 18 agentów i krytyczny test same-thread.
4. Oddzielić Meta-Front od trwałego Orchestration Lane.
5. Zamienić pending-user-message na trwały event wybudzający lane.
6. Dodać inbox/outbox, deduplikację, `plan_version`, retry/replan i prawdziwe cancel.
7. Rozdzielić proces/pulę workerów od procesu rozmowy i zarezerwować zasoby modelu dla Meta-Front.
8. Ujednolicić async pipeline’y oraz nested delegation.
9. Dopiero na stabilnej pętli zdarzeniowej podłączyć STT/TTS.

## Decyzja końcowa

Docelowo system powinien mieć **jednego logicznego Meta prowadzącego rozmowę, dowolnie wiele trwałych instancji lane-orchestratora per zadanie oraz dowolnie wiele workerów**.

Zachowuje to spójną osobowość i pamięć Meta, pozwala użytkownikowi dalej rozmawiać podczas wykonywania delegacji, a jednocześnie nie odbiera systemowi możliwości retry, replanningu, fan-inu i końcowej syntezy.
