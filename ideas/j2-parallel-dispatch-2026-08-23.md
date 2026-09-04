# J2 — realny równoległy dispatch subtasków (plan epiku)

**Data:** 2026-08-23
**Stan wejściowy w audycie:** `J2 | 🔧 przygotowane | … topologia 3-węzłowa Mongo
(rs3f8) jest już w pełni przygotowana i przetestowana, wystarczy podpiąć ją w
ramach epiku F8/G8`
**Stan po pomiarze (ta sesja):** to zdanie jest prawdziwe co do topologii i
**mylące co do reszty**. Topologia nie jest wąskim gardłem J2. Wąskim gardłem
jest to, że ścieżka dispatchu ma pięć defektów współbieżności, których replica
set nie naprawia, bo nie są to defekty trwałości — to defekty *atrybucji i
wyścigu w jednym dokumencie*.

---

## 0. Co zweryfikowałem, zanim cokolwiek napisałem

Cytat z `docs/MIGRACJA-DOMENY-CODING.md` §Z4 mówił: *„Fan-out zadań wymaga >1
pętli workera … Dostępna dziś forma to wiele wywołań w jednym kroku … Ale
`run_worker` jest text-only bez narzędzi, więc workery nadają się na analizę i
recenzję, nie na edycję plików."*

**Ten cytat nie opisuje ścieżki, o którą chodzi w J2.** Sprawdzone w kodzie:

| twierdzenie Z4 | stan faktyczny |
|---|---|
| fan-out wymaga >1 pętli workera | `parallel-dispatch.ts:169` **już dziś** robi `Promise.allSettled` po subtaskach grupy |
| workery są text-only, więc nie edytują plików | dotyczy `run_worker` (V2). Dispatch subtasków **nie** używa `run_worker` — woła `generateCoding()` z pełnym toolsetem `codingAgent`, ograniczonym przez `activeTools = role.allowedTools` (J7) |
| trzeba to dopiero podpiąć | jest podpięte: `repo-maintenance.ts:180` → `dispatchSubtasks()`, PATH A, warunek wejścia = `artifact.diagnosticPlan.routingSummary` istnieje |

Czyli: **równoległość na tej ścieżce już działa i już dziś jedzie na produkcji
w pętli self-healingu.** J2 nie polega na „włączeniu" jej. Polega na tym, że
działa niepoprawnie i nikt tego nie zmierzył.

### Topologia — zweryfikowana osobiście, nie na słowo

```
scripts/f8-mongo-rs3.sh up   → rs3f8, 3 członków, term: 37, 1 PRIMARY + 2 SECONDARY
npm run infra:rs3:prove      → PASSED (16 asercji: txn 3-kolekcyjna, rollback, odczyt z secondary)
```

`term: 37` to samo w sobie dowód, że zestaw był realnie maltretowany — 37 elekcji
to ślad po suicie F8, nie po jednym uruchomieniu. Wolumeny przetrwały z sierpnia.
**Skrypt nie dotyka portu 27017 ani bazy `agentforge`** (`assert_own_volume`).
Produkcja jedzie dalej na jednowęzłowym `rs0` (`MONGODB_URI` w `.env`).

### Co F8 udowodniło — i czego NIE udowodniło dla J2

Osiem scenariuszy F8 (`src/mastra/scripts/f8-*.ts`, zamknięte 18.08) operuje na
kolekcjach `effect*` i dowodzi własności **sklepu orkiestracji**: fencing
attemptów, dzierżawy, outbox, granice transakcji, brak split-brain.

Sprawdzone `grep`em po kolekcjach: **żaden scenariusz F8 nie dotyka
`code_task_artifacts`, `context_checkpoints` ani `file_activity`** — czyli
dokładnie tych trzech kolekcji, do których pisze dispatch subtasków.

To nie jest zarzut wobec F8. To rozgraniczenie: G8 ma spełnione przesłanki
(topologia + narzędzia do wstrzykiwania faultów + udowodniony fencing), ale
**dla innego sklepu**. Sklep, do którego pisze dispatch, nie ma ani dzierżaw,
ani fencingu, ani transakcji — pisze `findOne` + `$set` na całej tablicy.

---

## 1. Mapa: co dokładnie się psuje przy współbieżności

### D1 — atrybucja plików do subtaska nie istnieje (potwierdzone w kodzie)

`subtask-executor.ts:931` — `collectSubtaskResult(taskId, subtaskId)` **przyjmuje
`subtaskId` i nigdy go nie używa**. Ciało funkcji czyta `artifact.filesChanged`
całego zadania i zwraca to jako wynik *tego jednego* subtaska.

Nie może zrobić lepiej, bo wpisy nie niosą atrybucji:
`code-change-ledger.ts:148` zapisuje `{ path, beforeHash, afterHash, summary }`
— bez `subtaskId`.

Najostrzejszy szczegół: **system tę informację ma i wyrzuca**. Ta sama funkcja
narzędzia, kilka linii niżej (`code-change-ledger.ts:443`), przekazuje
`context.subtaskId` do `recordFileActivity()`. Czyli `file_activity` wie, który
subtask ruszył który plik. `artifact.filesChanged` — tablica, którą realnie
czyta bramka jakości i detektor konfliktów — traci to dokładnie na granicy
`upsertArtifactFileChange()`.

Konsekwencje, wszystkie na żywej ścieżce:
- `validateSubtaskQuality` → `no_files_changed` nigdy nie zapali się dla
  subtaska A, jeśli jego sąsiad B cokolwiek zapisał;
- `target_files_missed` tak samo — plik sąsiada zalicza się jako mój;
- `aggregateResults` → `conflictingFiles` liczy „ten sam plik u >1 subtaska",
  a skoro każdy subtask widzi wszystkie pliki, to **każdy plik jest konfliktem**,
  gdy tylko grupa ma >1 subtaska.

### D2 — utrata zapisów przy współbieżnym RMW (ZMIERZONE)

`upsertArtifactFileChange()` robi `findOne` → filtruj tablicę → `$set` **całej
tablicy**. Dwóch pisarzy naraz: obaj czytają starą tablicę, obaj nadpisują
całość, ostatni wygrywa i kasuje wpis pierwszego.

Zmierzone na rs3f8 (skrypt scratch, wierna kopia obecnej implementacji, 3 przebiegi):

```
concurrent writers: 8
entries surviving in artifact.filesChanged: 1
LOST: 7
```

Powtarzalne 3/3. **Uczciwe zastrzeżenie:** to nasycony przypadek najgorszy —
osiem zapisów bez pracy LLM pomiędzy. W realnym runie zapisy dzieli latencja
modelu, więc realna strata jest niższa. Ale okno (`findOne`→`updateOne`, kilka
ms) jest realne i rośnie z fan-outem, a jeden subtask zapisujący kilka plików
pod rząd koliduje sam z sąsiadem. Mechanizm jest potwierdzony; skala zależy od
przeplotu.

Czego to dotyka poza jakością: `code-worktree.ts:432` (lista zmienionych plików),
`pr-body-builder` (treść PR-a), `diffSummary`.

**Replica set tego nie naprawia.** To wyścig read-modify-write w jednym
dokumencie, nie problem trwałości.

### D3 — brak limitu falowego (potwierdzone w kodzie)

`Promise.allSettled(group.subtasks.map(…))` — nieograniczony fan-out. Grupa o 12
subtaskach to 12 równoczesnych wywołań LLM. `VramBudgetTracker` ogranicza tylko
modele lokalne; subtaski chmurowe nie mają żadnego limitu (a `file-editor` jest
**przypięty do chmury** przez `REPAIR_MODEL_KEY`, więc typowa grupa edytorska
jest w 100% poza tym limitem). Punkt 1 notatki właściciela: sweet spot 2–4.

### D4 — grupy równoległe budowane bez rozłączności plików (potwierdzone w kodzie)

`buildParallelGroups()` (`smart-router.ts:105`) sortuje topologicznie **wyłącznie
po `dependencies`**. `targetFiles` nie jest brane pod uwagę ani razu. Dwa
subtaski `file-editor` z tym samym plikiem docelowym i bez zadeklarowanej
zależności trafiają do jednej grupy i piszą równolegle.

Do jednego worktree: `resolveRepoPath(taskId)` → `getWorkspacePath(taskId)` —
**wszystkie subtaski zadania dzielą jeden katalog roboczy git**. Punkt 2 notatki
właściciela (`git index.lock`) dotyczy dokładnie tego.

### D5 — wspólny `threadId` dla całej grupy (potwierdzone w kodzie)

`generate-with-harness.ts:298`: `const threadId = input.threadId ?? input.taskId`.
`executeSubtask` nie podaje `threadId`. Zatem **wszystkie równoległe subtaski
piszą do jednego wątku pamięci Mastry naraz** i dzielą `recordThreadDepth`.
`threadId` nie jest per-wywołanie. Punkt 4 notatki właściciela. Inspekcja przed
krokiem 5 wykryła też, że komentarz o `runId` był nieprawdziwy:
`generateWithHarness` liczy `input.runId ?? input.taskId ?? randomUUID()`, a
`executeSubtask` nie podaje `runId`, więc subtaski jednego zadania dzielą także
`runId`. Wiążąca decyzja kroku 5 dotyczy `threadId`; ten osobny residual nie jest
naprawiany ukradkiem w J2.

### Podsumowanie mapy

| defekt | naprawia to rs3? | dowodliwe bez LLM? |
|---|---|---|
| D1 atrybucja | nie | tak — realny Mongo |
| D2 utrata zapisów | nie | tak — zmierzone |
| D3 brak limitu fal | nie | tak — czysta funkcja |
| D4 kolizja plików w grupie | nie | tak — czysta funkcja |
| D5 wspólny threadId | nie | tak — inspekcja wywołania |

**Wniosek dla właściciela:** rs3 jest gotowy i przyda się dopiero w kroku 6
(fencing subtasków pod stepdown). Kroki 1–5 są niezależne od topologii i to one
są prawdziwym „podpięciem". Rozmiar epiku: **większy niż sugeruje wiersz audytu,
ale w innym miejscu** — nie w infrastrukturze, tylko w poprawności ścieżki, która
już dziś jedzie na produkcji.

---

## 2. Kroki, każdy z własnym falsyfikowalnym sprawdzeniem

Zasada domu: najpierw asercja, która **oblewa na obecnym zachowaniu**, potem
poprawka. Każdy krok jest osobnym, kompletnym plastrem.

### Krok 1 — zapis do artefaktu: atomowy i atrybuowany ✅ ZROBIONY (ta sesja)

**Defekt:** D2 + write-side D1.
**Zmiana:** `upsertArtifactFileChange()` przestaje nadpisywać całą tablicę
(`$pull` + `$push`, dwie atomowe operacje zamiast RMW) i zapisuje `subtaskId`
przy wpisie.
**Bramka:** `check:subtask-file-attribution` — realny Mongo, N równoległych
pisarzy do różnych plików; asercja: przeżywa N wpisów, każdy z własnym
`subtaskId`. Falsyfikacja przed poprawką: 1 z 8.

### Krok 2 — odczyt: wynik subtaska to jego własna praca

**Defekt:** read-side D1.

> **DECYZJA WŁAŚCICIELA (23.08, podjęta w jego imieniu): krok 2 dzieli się na
> 2a i 2b, w tej kolejności. 2b BEZ 2a jest szkodliwe.**
>
> Pierwsza wersja tego kroku brzmiała „nieatrybuowane = niczyje". To jest
> niebezpieczne, dopóki `subtaskId` pochodzi z **argumentu, który podaje MODEL** —
> `buildScopedPrompt` mówi mu „pass subtaskId=…" i na tym koniec. Model zapomina,
> wpis traci atrybucję, subtask nie widzi własnej pracy, zapala się
> `no_files_changed` → retry → eskalacja na przypięty `deepseek-v4-pro`. Sami
> byśmy wyprodukowali tryb awarii, który pali drogi model i może zaaplikować tę
> samą edycję drugi raz.
>
> To ten sam kształt błędu co `findArtifactIds` (dwa razy) — fakt o runie
> odzyskiwany z czegoś, co może go zgubić, zamiast zapisany w momencie zdarzenia.

**2a — atrybucja przestaje zależeć od modelu (WARUNEK WSTĘPNY). ✅ ZROBIONE 23.08**
`subtaskId` bierze się z kontekstu runu harnessu — `executeSubtask` już dziś
podaje `subtaskId` do `generateCoding()`, więc harness go zna. Argument od modelu
zostaje wyłącznie jako **fallback**, nigdy jako źródło prawdy.
**Bramka:** wywołanie narzędzia **bez** argumentu `subtaskId`, wewnątrz runu
harnessu, który go ma → wpis i tak niesie atrybucję. Falsyfikacja przed
poprawką: realny tool-call zapisał plik, ale wpis miał `subtaskId: undefined`.
Po poprawce bramka przechodzi przez prawdziwy `Agent`, `generateCoding`, dispatch
narzędzi Mastry, `coding_write_file_tracked`, filesystem i Mongo na rs3f8;
sprawdza też błędny identyfikator od modelu, fallback poza runem,
`file_activity`, `tool_executions` i wpięcie `executeSubtask` → harness.

**2b — dopiero teraz odczyt filtruje. ✅ ZROBIONE 23.08**
`collectSubtaskResult(taskId, subtaskId)` filtruje po `subtaskId` (parametr
przestaje być martwy). Wpisy bez atrybucji należą do nikogo.

**Zawór bezpieczeństwa (obowiązkowy, nie opcjonalny):** jeśli `filesChanged` jest
**niepuste**, ale **żaden** wpis nie ma `subtaskId` — atrybucja nie działa (stare
dane sprzed kroku 1 albo zepsuta ścieżka 2a). Wtedy `collectSubtaskResult`
zwraca **całość, czyli dzisiejsze zachowanie**, i loguje głośne ostrzeżenie z
`taskId`. Uzasadnienie asymetrii kosztów:
- fałszywy **negatyw** (praca niewidoczna) → retry + eskalacja na drogi model,
  ryzyko podwójnej edycji tego samego pliku;
- fałszywy **pozytyw** (praca sąsiada zaliczona mnie) → dokładnie to, co dzieje
  się dziś, znane i przeżywalne.

Degradacja do dzisiejszego zachowania jest bezpieczna. Ciche „zero plików" nie jest.

**Bez migracji starych danych.** Informacji, której nigdy nie zapisano, nie da się
uzupełnić wstecz; artefakty są per-zadanie, a `context_checkpoints` ma TTL 7 dni.
Zawór powyżej pokrywa cały zastany stan.

**Bramka (2b):** rozszerzenie `check:subtask-file-attribution` — dwa subtaski,
każdy dostaje wyłącznie swoje pliki; `aggregateResults` na tych danych zgłasza
**zero** konfliktów (dziś: każdy plik jako konflikt); plus asercja zaworu:
artefakt ze starymi, nieatrybuowanymi wpisami zwraca całość i ostrzega.
Falsyfikacja przed poprawką: A dostał także plik B, agregator widział konflikty,
stan mieszany zwracał wszystkie wpisy, a zachowanie legacy nie ostrzegało.
Zielona bramka woła produkcyjne `collectSubtaskResult` i `aggregateResults` na
realnym Mongo; zawór działa wyłącznie dla artefaktu całkowicie legacy.

### Krok 3 — limit falowy ✅ ZROBIONE 23.08

**Defekt:** D3.

> **DECYZJA: domyślnie 3, zmienna `J2_DISPATCH_CONCURRENCY`, jeden wspólny limit
> dla lokalnych i chmurowych.** Trójka to środek widełek 2–4 z notatki
> właściciela. Jeden limit, nie dwa, bo wiążącym ograniczeniem są rate limity
> chmury, a nie VRAM: `file-editor` jest **przypięty do chmury**
> (`REPAIR_MODEL_KEY`), więc typowa grupa edytorska w całości omija
> `VramBudgetTracker`. Drugi limit na lokalne byłby martwym kodem.

**Zmiana:** pomocnik `runWithConcurrency(items, limit, fn)` w
`parallel-dispatch.ts`. Zachowuje semantykę `allSettled` (jeden padnięty subtask
nie ubija fali) — to nie może się zmienić, bo `retryFailedSubtasks` zakłada, że
dostaje wynik dla **każdego** subtaska grupy.
**Bramka:** `check:dispatch-concurrency-cap` — instrumentowana funkcja licząca
szczyt równoczesnych wywołań przy 9 subtaskach; asercja `peak <= limit`.
Falsyfikacja przed poprawką: peak = 9.
Po poprawce produkcyjny `runWithConcurrency` daje peak = 3, zachowuje kolejność
i wynik `fulfilled`/`rejected` dla każdego elementu. Bramka sprawdza też, że
dispatch naprawdę używa helpera i czyta `J2_DISPATCH_CONCURRENCY`, a wartości
niepoprawne wracają do zatwierdzonej domyślnej trójki.

### Krok 4 — rozłączność plików wewnątrz grupy ✅ ZROBIONE 23.08

**Defekt:** D4.

> **DECYZJA: rozbijamy WYŁĄCZNIE kolizje zapis–zapis, nie zapis–odczyt.**
> Rozbijanie na odczytach zserializowałoby prawie wszystko i skasowało sens
> równoległości. Zapis–odczyt (np. `terminal` odpalający `tsc`, gdy edytor
> jeszcze pisze) to realne, **świadomie przyjęte** ryzyko — w praktyce
> weryfikacja zwykle **zależy** od edycji, więc sort topologiczny i tak wypycha
> ją do późniejszej grupy. Do rewizji w kroku 6, nie wcześniej.

**Zmiana:** `buildParallelGroups()` po sorcie topologicznym rozbija grupę tak,
by żadne dwa subtaski **piszące** (`subtaskWritesCode`) nie dzieliły
`targetFiles`. Kolidujący ląduje w kolejnej grupie — to zawsze bezpieczne,
bo grupy są sekwencyjne.
**Bramka:** `check:parallel-group-disjoint-files` — dwa `fix` na tym samym pliku
bez zależności; asercja: różne `parallelGroup`. Falsyfikacja przed poprawką: oba
w grupie 0. Druga asercja (przeciw nadgorliwości): dwa subtaski *czytające* ten
sam plik **zostają** razem.
Po poprawce postproces każdego poziomu topologicznego rozbija wyłącznie kolizje
write–write. Bramka obejmuje też write–read, rozłączne writery, pakowanie wielu
writerów, zależności, fallback cyklu i publiczny `routeSubtasks`, który nadaje
rzeczywiste `parallelGroup`.

### Krok 5 — tożsamość runu per subtask

**Defekt:** D5.

> **DECYZJA: `${taskId}::${subtask.id}`, i to jest cel, nie skutek uboczny.**
> Subtaski mają dostawać kontekst przez `previousResults` w prompcie (już tak
> jest, `buildScopedPrompt` ma sekcję „Context from Previous Subtasks"), a nie
> przez podglądanie sobie nawzajem historii wątku w trakcie równoległej pracy.
> `resourceId` jest bezpieczne: **wszystkie subtaski jadą jako `codingAgent`**,
> więc znana pułapka „wątek należy do tego, kto go stworzył" (ta, która wywalała
> `codeReviewAgent`) tu nie występuje. Checkpoint jest kluczowany po `taskId`,
> nie po `threadId`, więc zostaje wspólny — i tak ma być.

**Zmiana:** `executeSubtask` podaje jawny `threadId`.
⚠️ **Mimo powyższego — potwierdź przed zmianą, nie po:** czy `recordThreadDepth`
i precontext nigdzie nie zakładają `threadId === taskId`.
**Bramka:** `check:subtask-thread-isolation` — dwa subtaski jednego zadania mają
różne `threadId`; wpisy w logu zdarzeń nie mieszają się.

✅ **ZROBIONE 23.08.** `executeSubtask` przekazuje dokładnie
`${taskId}::${subtask.id}`. Czerwony przebieg pokazał, że prawdziwy harness i log
zdarzeń potrafią zachować rozłączne wątki, ale produkcyjne wywołanie nadal nie
przekazywało `threadId`. Po poprawce dwa równoległe wywołania `generateCoding`
jednego zadania zapisują po jednym `llm_call_completed` wyłącznie pod swoim
wątkiem. Bramka sprawdza też niezależne dziedziczenie głębokości oraz to, że
precontext rozdziela `threadId`, a checkpoint świadomie pozostaje po `taskId`.
Residual poza decyzją D5: domyślny `runId` nadal spada do wspólnego `taskId`;
asynchroniczna pamięć semantyczna wyłączona domyślnie nadal ma taskowy fallback.

### Krok 6 — dopiero tutaj rs3 zaczyna być potrzebny

**Defekt:** brak fencingu na `code_task_artifacts` — subtask, który stracił
łączność w trakcie stepdownu, może dopisać wynik po tym, jak grupa poszła dalej.

> **DECYZJA: zakres to JEDNA własność — „subtask, który stracił swoje miejsce w
> planie, nie dopisuje do artefaktu".** Nie budujemy drugiego sklepu
> orkiestracji. Wzorzec bierzemy z `f8-partition-claim-heartbeat`, **razem z
> jego ostrzeżeniem**: *system, który po każdej czkawce sieciowej wyrzuca pracę,
> jest bezpieczny i bezużyteczny*. Czyli obie połowy muszą być w bramce: stary
> subtask ma zostać odrzucony, ale subtask, którego **nikt nie wyprzedził**, ma
> dokończyć.

**Zmiana:** dzierżawa/fencing dla subtaska.
**Bramka:** scenariusz w stylu F8, ale na `code_task_artifacts`, na rs3f8, z
`f8-mongo-chaos.sh`.
**To jest właściwe G8 dla J2** i dopiero on konsumuje przygotowaną topologię.

✅ **ZROBIONE 23.08.** Każdy `executeSubtask` atomowo claimuje własny slot
`subtaskLeases.<sha256(subtaskId)>` w dokumencie artefaktu. Właściciel i
monotoniczny `fence` pochodzą ze store'u, przechodzą przez kontekst harnessu i
są częścią predykatu rzeczywistych mutacji `coding_update_artifact`,
`coding_run_test` oraz ledgera plików. Lease ma 30 s i heartbeat co najwyżej
10 s. Wygaśnięcie samo **nie** blokuje zapisu — dopiero takeover podnosi fence;
ukończony run yielda slot bez zerowania historii fence.

`f8:subtask-artifact-fencing` działa na tymczasowej bazie na rs3f8 i używa
`f8-mongo-chaos.sh`. Czerwona falsyfikacja: prawdziwy
`coding_update_artifact` ze starym fence zwrócił `success:true` i nadpisał
`filesChanged`. Zielony G8 dowodzi obu połówek decyzji:
- partycja 6 s przy lease 3 s, bez rywala: ten sam właściciel po heal zapisuje;
- partycja 25 s: realna elekcja (`term 38 → 39`), owner B przejmuje `fence 2`
  i zapisuje, owner A z `fence 1` jest odrzucony; zostaje dokładnie wpis B.

Bramka przeprowadza stary fence także przez prawdziwy `generateCoding`, Agenta
i dispatch narzędzia Mastry, więc nie jest to helper bez konsumenta. `finally`
zawsze wykonuje `heal`; rs3f8 zostaje podniesiony, wolumeny nie są czyszczone.

**Świadomy residual poza zatwierdzoną własnością:** fence chroni mutacje
`code_task_artifacts`. Nie cofa zapisu do filesystemu, `code_change_snapshots`
ani best-effort `file_activity`, który mógł nastąpić przed odrzuconą mutacją
artefaktu. Zapisy workflow wykonywane poza kontekstem równoległego subtaska są
celowo task-scoped i nie dostają sztucznego lease'u.

**Kolejność jest istotna:** kroki 1–2 muszą iść przed 3–4, bo bez atrybucji nie
da się zmierzyć, czy limit fal i rozłączność cokolwiek poprawiły — wynik i tak
byłby zlepkiem całego zadania.

---

## 3. Co wymaga osobnej zgody właściciela

Zgoda na start J2 **nie obejmuje** poniższych. Żaden krok 1–6 ich nie wymaga i
żaden nie jest w nich zaplanowany:

- **restart żywego serwera** — nic w krokach 1–6 tego nie potrzebuje; bramki
  jadą jako osobne procesy `tsx`;
- **dotykanie historii gita żywego repo** (jak F2/F4/F9 — `mergeWorktreeToLive`,
  auto-promote, self-swap) — poza zakresem;
- **`AUTOHEAL_AUTO_PROMOTE` / `DEPLOY_AUTO_SWAP`** — zostają jak są;
- **`down --purge` na rs3f8** — skasowałoby wolumeny z historią elekcji (po G8
  J2 `term: 39`); zostawiam
  zestaw stojący.

Kroki 1–2 zmieniają **kształt zapisu** w `code_task_artifacts` (dochodzi
`subtaskId`). Zmiana jest addytywna i wstecznie zgodna dla czytelników.
Pytanie o zastane wpisy zostało rozstrzygnięte w kroku 2 (zawór bezpieczeństwa,
bez migracji) — **nie trzeba go zadawać ponownie**.

### ⚠️ `npm run check:all` jest dziś ZEPSUTY — i to NIE należy do J2

`check:embedding-consistency` (linia 86 `scripts/check-all.sh`) wywala się na
`no such table: code_chunks`. Skrypt jedzie pod `set -euo pipefail`, więc
**zatrzymuje się tam i ~100 bramek za tą linią w ogóle się nie uruchamia** — w
tym `check:subtask-file-attribution` (linia 116).

Przyczyna: dwa różne indeksery piszą pod tę samą nazwę pliku
`.mastra/repo-index.db`. Indekser LSP/BM25 (A11/A12, `aba0e52`/`0f7cba5`, ten sam
dzień) zostawia tam tabele `files`/`symbols`; sprawdzenie embeddingów oczekuje
`code_chunks`, a jego strażnik `existsSync` przepuszcza, bo **jakiś** indeks pod
tą ścieżką jest.

**To osobne zadanie, ma własny chip. Nie naprawiaj tego przy okazji J2.**
Do czasu naprawy weryfikuj tak (98 ze 100 przechodzi):

```bash
sed -n '87,200p' scripts/check-all.sh | grep '^npm run' | sed 's/^npm run //' \
  | while read -r c; do npm run "$c" >/dev/null 2>&1 || echo "FAIL: $c"; done
```

Znane, **niezwiązane z J2** czerwone: `check:groq-model-ids` (preset
`run_worker` wskazuje `openrouter-free-auto`, własny chip). `check:final-decision`
oblewa uruchomiony pojedynczo, a przechodzi normalnie — potrzebuje repliki,
którą `check-all.sh` sam sobie stawia.

---

## 4. Stan na koniec sesji 23.08

- ✅ Zmapowane i **zweryfikowane w kodzie**, nie na słowo: 5 defektów (D1–D5).
- ✅ Zmierzone: D2 — 7 z 8 zapisów ginie, 3/3 przebiegi.
- ✅ Topologia rs3f8 podniesiona i sprawdzona osobiście (`infra:rs3:prove` PASSED).
- ✅ Rozgraniczone: co F8 udowodnił (sklep orkiestracji) vs. czego J2 potrzebuje
  (`code_task_artifacts` — bez fencingu).
- ✅ **Krok 1 zaimplementowany + bramka** (`fcc9ebc`).
- ✅ **Krok 2a zaimplementowany + bramka:** `subtaskId` bierze się z kontekstu
  runu przed policy/telemetrią/body narzędzia; argument modelu jest tylko
  fallbackiem bez runu. Czerwona falsyfikacja: prawdziwy zapis przeszedł, ale
  `filesChanged[0].subtaskId` był `undefined`. Zielony przebieg używa prawdziwego
  dispatchu Mastry i realnego Mongo na rs3f8.
- ✅ **Krok 2b zaimplementowany + bramka:** produkcyjny czytelnik zwraca wyłącznie
  pliki pytającego subtaska, a produkcyjny agregator nie tworzy fałszywych
  konfliktów. Artefakt całkowicie legacy zachowuje dzisiejszy wynik i głośno
  ostrzega z `taskId`; w stanie mieszanym wpisy bez atrybucji są niczyje.
- ✅ **Krok 3 zaimplementowany + bramka:** jeden limit obejmuje lokalne i
  chmurowe subtaski; domyślnie 3, przez `J2_DISPATCH_CONCURRENCY`. Pomiar tej
  samej dziewiątki: stary fan-out peak = 9, produkcyjny helper peak = 3;
  semantyka `allSettled` i kolejność wejściowa zachowane.
- ✅ **Krok 4 zaimplementowany + bramka:** żadne dwa writery w grupie nie dzielą
  dokładnego `targetFiles`; read–read i świadomie zaakceptowane write–read nadal
  są równoległe. Podfale zachowują porządek zależności i działają także w
  fallbacku cyklu; publiczny router nadaje rozłączne `parallelGroup`.
- ✅ **Krok 5 zaimplementowany + bramka:** każdy subtask dostaje stabilny
  `${taskId}::${subtask.id}` jako `threadId`; dwa prawdziwe wywołania harnessu
  jednego zadania nie mieszają wpisów `llm_call_completed`. Potwierdzone osobno:
  depth i precontext akceptują rozłączny wątek, checkpoint zostaje wspólny po
  `taskId`. Ujawniony residual: `runId` nadal domyślnie spada do `taskId` — to nie
  jest część zatwierdzonej zmiany D5.
- ✅ **Krok 6 zaimplementowany + G8:** store-owned lease/fence per subtask jest
  częścią predykatu mutacji artefaktu. Krótka partycja bez takeover nie wyrzuca
  pracy; długa partycja wywołuje realną elekcję i takeover `1 → 2`, po którym
  stary właściciel nie może dopisać. Dowód obejmuje prawdziwy harness i realne
  `coding_update_artifact`; rs3f8 po `heal` stoi z trzema zdrowymi członkami,
  `term: 39`.
- ✅ **Wszystkie decyzje projektowe kroków 2–6 podjęte** (bloki „DECYZJA" wyżej) —
  nowa instancja ma wykonywać, nie wybierać. Najważniejsza: krok 2 rozbity na
  2a/2b, bo „nieatrybuowane = niczyje" **bez** deterministycznej atrybucji
  tworzyłoby tryb awarii palący przypięty drogi model.
- ✅ Kroki 1–6 wykonane w zatwierdzonej kolejności.

### Reguły pracy dla kolejnej instancji

1. **Jeden krok = jeden commit.** Mały i kompletny bije duży i niedokończony.
2. **Najpierw asercja, która oblewa na obecnym kodzie, potem poprawka.** Bramka,
   która nigdy nie była czerwona, niczego nie dowodzi.
3. **Nie ufaj „zbudowane i zielone".** Ten projekt ma na to trzy udokumentowane
   wpadki (`findArtifactIds` dwa razy, liveness nieosiągalny dla V2). Sprawdź, czy
   cokolwiek **dociera** do kodu, który testujesz.
4. **Komentarze i skrypty bramek po angielsku**, dokumenty w `ideas/` po polsku —
   tak jest w całym repo.
5. **`git status --short` przed każdym `git add`.** Drzewo bywa dzielone z innymi
   instancjami; `src/mastra/_skills/coding/test-generator.md` jest zmodyfikowany
   przez kogoś innego i **nie należy go commitować**. Nigdy `git add -A`.

Główna korekta wobec audytu: **J2 to nie „podpiąć gotową infrastrukturę".
Równoległość już jedzie na produkcji i jest niepoprawna.** Topologia jest
gotowa i potrzebna dopiero w kroku 6.
