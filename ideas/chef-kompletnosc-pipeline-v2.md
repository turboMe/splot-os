# Chef pod V2 nie kończy pipeline'u — dlaczego i co z tym zrobić

**Dla kogo:** nowa instancja, świeże okno kontekstowe.
**Data zebrania faktów:** 2026-08-19. Wszystko poniżej zmierzone w źródle albo na żywych jobach.
**Gałąź:** `refactor/meta-front-durable-orchestration`. **Zmiany z poprzedniej sesji są NIEZACOMMITOWANE** — `git status` pokaże ~21 zmodyfikowanych plików. Nie cofaj ich bez powodu; są opisane w §2.

> **BUDŻET: maksymalnie 3 pełne przebiegi pipeline'u chefa.** Jeden przebieg to ~30 minut i realne pieniądze. Zaplanuj, na co je wydajesz, ZANIM odpalisz pierwszy. Analiza źródła, sondy offline na modelu decydującym i odpytywanie bazy są darmowe i nielimitowane — używaj ich do wyczerpania, zanim sięgniesz po przebieg.

---

## 1. Zadanie

Chef wykonuje swoją pracę **bardzo dobrze w kontakcie bezpośrednim** i **niekompletnie przez Meta Front → lane**. Trzeba to wyrównać.

Cztery pytania właściciela, wszystkie otwarte:

1. **Dlaczego chef nie domyka wszystkich kroków?** W pipelinie jest faza kontroli kompletności (`qa_final`) i „Phase-Exit Check" przed każdym przejściem, które mają wracać do tego, czego nie zrobiono. Wrażenie właściciela: pod V2 to się nie dzieje. Zweryfikuj to, zamiast przyjąć.
2. **Jakie modele są realnie podłączone do chefa pod V2?** Czy coś się gubi na modelu, który do tego nie pasuje. Wstępne rozpoznanie w §5.3 — nie jest zamknięte.
3. **Co trzeba zrobić, żeby chef pracował tak samo dobrze na obu drogach?**
4. Przetestuj na **nowej restauracji z działającą stroną** (recon musi mieć co czytać; lista już zużytych w §6).

**Oczekiwane wyjście: NAJPIERW PLAN**, dopiero potem zmiany. Właściciel wprost prosi o zaplanowanie całego podejścia, żeby nie kręcić się w kółko.

---

## 2. Co już naprawione — NIE ROBIĆ TEGO PONOWNIE

Poprzednia sesja zamknęła **inny** defekt: lane rozbijał „zrób menu dla restauracji \<URL\>" na `researcher → chef` i wycinał URL z zadania chefa, przez co faza `recon` nigdy nie startowała (0 z 20 zadań `capability=chefAgent` w historii V2 dostało URL). To jest naprawione i zweryfikowane:

| zmiana | dowód |
|---|---|
| `hardRules` chefa/content/writer/hunt mówią o **podziale**, nie o prawie zapisu | żywy model, 5 przebiegów/wariant: `dispatch(chefAgent)` 5/5, było `plan_steps` 5/5 |
| `AgentCard.runsInternally` + `repairPlanOwnership` (`lane-decider.ts`) | zadziałało live na decyzji dla filmmakera; symulacja na 5 historycznych planach bez fałszywych trafień |
| Meta Front przestał pisać harmonogramy i zmyślać fakty (`prompts/meta-front/base.md`) | „potrzebuje nowe menu dla restauracji \<url\>" → cel zapisany 1:1; było 5-punktową specyfikacją |
| `assertCapabilityWasOffered` obejmuje `plan_steps` (było tylko `dispatch`) | `check:lane-decider-model` |
| rodzic planu nie liczy się do `maxLaneTasks` | każdy plan ≥2 kroków był „wyczerpany" przy pierwszym osądzie |
| jedna implementacja renderowania wyniku (`renderProducerText` w `queries.ts`) | były trzy, dwie robiły `JSON.stringify` na kopercie `{text}` |
| `chef_import_website_profile` odrzuca analizę bez dań i bez cen | wcześniej przyjmował `{}` i zapisywał `currentMenuRef` z samym `capturedAt`, **fałszując dowód reconu** |
| nagłówek głębokości drukuje **efektywny** sufit kroków | drukował `Max steps: 10`, gdy realny sufit to 150 (chef się do dziesiątki stosował) |
| `Context budget` znika, gdy nikt go nie egzekwuje | ma JEDNEGO konsumenta — `input.contextBuilder`; chef/writer/content go nie mają |
| podłoga głębokości `standard` dla agentów z `PIPELINE_PHASE_TOOLS` (`FEATURE_PIPELINE_DEPTH_FLOOR`) | poprawny krótki brief punktował `score 0.00` → `fast` |

**Stan bram:** 94 przebiegnięte pojedynczo. Trwale czerwona jedna — `check:embedding-consistency`, środowiskowa (indeks `.mastra/repo-index.db` bez tabeli `code_chunks`), **blokuje `check:all`, bo skrypt ma `set -e`**. Trzy bramy durable (`durable-automation`, `durable-delegation`, `durable-job-tools`) padają w pakiecie i przechodzą pojedynczo — konkurują o replica set z pracującym jobem.

---

## 3. Twardy pomiar: trzy przebiegi tej samej pracy

| przebieg | ścieżka | czas | dania | przepisy | status projektu |
|---|---|---|---|---|---|
| **Apotek** (`621f82e9-…`) | endpoint agentowy, **bez harnessu** | **35,6 min** | 18 | **18** | `done` |
| **Sæta Svínið** (`3eb43567-…`) | V2, profil `fast` (przed poprawkami) | 9,7 min | 18 | 4 | `done` |
| **Reykjavik Bistro** (`771924ae-…`) | V2, profil `standard` (po poprawkach) | 16,9 min | 25 | **0** | `recipes` |

Apotek to jedyny kompletny przebieg: `profile.currentMenuRef` wypełnione, 18 kart przepisów, wszystkie sekcje Księgi, tabela `insights` wiążąca cytat z recenzji z decyzją w karcie. Plik: `/projekty/splot-projects/menu-books/621f82e9-2efb-4dcd-ba9c-cd4bdbba59a6.md` (40 722 zn.). **To jest wzorzec, do którego równasz.**

### 3.1 Liczba, która może tłumaczyć wszystko

**Jedyny kompletny przebieg zajął 35,6 min. V2 daje chefowi 30.**

`ATTEMPT_CAP_BY_LATENCY.long = 1_800_000` w `config/capability-routing.ts`. Endpoint agentowy tego okna nie ma. Canary Reykjavik Bistro oddał wynik **12:19:12 przy odcięciu 12:19:39** — 27 s przed ścianą.

Komentarz przy tej stałej sam podaje argument za podniesieniem: od czasu liveness to **cisza** wykrywa zawieszenie (podłoga bezczynności chefa = 480 s), a zegar jest sufitem **kosztowym**, więc jego rozmiar to decyzja ekonomiczna, nie bezpieczeństwa. Ale **nie podnoś go odruchowo** — jeśli workery się wywalają (§3.2), dłuższe okno kupi tylko dłuższą awarię.

### 3.2 Co naprawdę się działo w oknie canary (11:49–12:20)

Zdarzenia **bez filtra po `agentId`** — to jest kluczowe, patrz §4.1:

```
tool_called: 182        worker_run_started: 26     worker_run_completed: 18
task_failed: 18         worker_run_failed:  8      task_completed: 11
depth_upgraded: 4       reflection_repair_started: 4
auto_deliberation_started: 2    auto_review_started: 4    approval_gate_started: 4
soft_interrupt_queued: 40       soft_interrupt_consumed: 4
policy_blocked: 4       capability_gap: 3         tool_call_failed: 2
```

**8 z 26 workerów padło, 18 zadań padło.** Faza `recipes` deleguje karty dań właśnie do `run_worker` (batche 4-6/turę) — i oddała **zero przepisów przy 25 daniach**. To jest najmocniejszy trop w całym materiale.

Drugi trop: `depth_upgraded: 4` — reflektor eskalował głębokość w trakcie, więc `auto_deliberation` i `approval_gate` weszły mimo startu na `standard`. Sprawdź, czy `requireApproval` nie blokuje zapisów bezobsługowo (`policy_blocked: 4`).

Workery chodziły do **12:18:46**, czyli do samego odcięcia. To **nie był zwis** — to była praca, która nie dowoziła.

---

## 4. Pułapki pomiarowe — poprzednia instancja się na nich przejechała

### 4.1 `agent_events` filtrowane po `agentId` KŁAMIE
Filtr `{agentId:'chefAgent'}` pokazał **6 wywołań narzędzi** dla przebiegu, który założył projekt, zapisał menu na 25 dań i zapisał Księgę. Bez filtra: **182**. Sub-runy i workery logują się pod innymi id. Każdy wniosek z „ile chef zrobił wywołań" oparty na tym filtrze jest bezwartościowy.

### 4.2 `depth_classified` loguje wartość PROFILU, nie efektywną
Pole `maxSteps` w tym zdarzeniu to `depthProfile.maxSteps` (10/25/40). Realny sufit podnosi `stepCeilingFor` do deklaracji agenta (chef: **150**). Nie wyciągaj z tego logu wniosku, że run miał 10 kroków.

### 4.3 W ścieżce V2 większość profilu głębokości jest nadpisywana
`maxSteps` → deklaracja agenta. `timeoutMs` → okno capability. `idleTimeoutMs` → podłoga liveness per capability. `hardCapMs` → własny V2. `contextBudgetTokens` → **nie ogranicza niczego** dla agenta bez `contextBuilder` (chef nie ma; mają tylko automationArchitect, knowledgeAgent, codingAgent i trzej recenzenci). Z profilu realnie zostaje: `planning`, `goalContract`, `autoDeliberation`, `autoReview`, `requireApproval`, progi reflektora. **Podnoszenie profilu „żeby dać więcej tokenów" jest nieporozumieniem.**

### 4.4 `deep`/`critical` są bezobsługowo ryzykowne
`goalContract: true` instaluje generyczny kontrakt, którego krok 1 to „Clarify the objective, constraints and success criteria" — niedomykalny bez człowieka. Zmierzone: 12 kolejnych ocen „NOT COMPLETE (replan)" i dwa spalone okna 30 min. `critical` dokłada `requireApproval`. Dlatego podłoga to `standard`.

### 4.5 Reszta
- **Node v22 obowiązkowo** (`bash scripts/with-node.sh …`). Pod v20 serwer startuje, nie nasłuchuje i nie loguje błędu.
- Serwer chodzi jako `mastra dev` (watch) — **edycja pliku restartuje go i zabija job w locie**. Planuj edycje między przebiegami.
- Endpoint V2 jest pod **`/v2/...`**, nie `/api/v2/...`. `POST /v2/conversations/:cid/commands` przyjmuje `capability` i **pinuje właściciela z pominięciem lane'a** — to najczystszy sposób na izolowanie zmiennej. Nagłówek: `x-resource-id: agent:metaFrontAgent`.
- **Nie ufaj zielonej bramie jako dowodowi zachowania.** W poprzedniej sesji brama asertowała obecność stringa i deklarowała w komentarzu gwarancję behawioralną, której nie mierzyła; string był, a defekt działał.
- Treść wyniku joba siedzi w `producer.data.text`; `orch_jobs` nie ma pola `status` (jest `phase` + `terminalOutcome`).
- **Nie dotykaj**: `docs/PROMPT-INSTANCJA-SILNIK-V2.md`, `docs/STATUS-AGENTOW-SILNIK-V2.md`, `src/mastra/scripts/f8-*` — należą do innej instancji.

---

## 5. Co zbadać, zanim wydasz pierwszy przebieg

### 5.1 Czy `qa_final` i Phase-Exit Check w ogóle się uruchamiają
`prompts/chef/pipeline.md` §9 każe sprawdzić, czy każde danie ma przepis (`getRecipesByProject` vs menu), spójność alergenów, `chef_document_status` = wszystkie sekcje kanoniczne wypełnione. Przed każdym przejściem jest też „Phase-Exit Check". Ustal z danych, czy pod V2 to się wykonuje — projekt Reykjavik Bistro utknął na statusie `recipes`, więc do `qa_final` prawdopodobnie nie doszedł. **Pytanie do rozstrzygnięcia: czy pipeline nie ma bramy, która NIE POZWALA ogłosić `done` przy niekompletnej Księdze — i czy taka brama powinna być kodem (`chef_set_project_status` odmawia przejścia), a nie zdaniem w prompcie.** To jest najmocniejszy kandydat na trwałe rozwiązanie problemu „nie domyka kroków".

### 5.2 Dlaczego padło 8 workerów
`worker_run_failed: 8`, `task_failed: 18`. Znajdź treść tych błędów (`agent_events` bez filtra po agencie, plus `run-worker.ts` ma gałąź `'Worker returned empty output (no text)'`). Jeśli to puste odpowiedzi modelu — patrz §5.3.

### 5.3 Modele — rozpoznanie wstępne, NIEZAMKNIĘTE
Sprawdzone w `config/model-manifest.ts`:
- `chefAgent: 'deepseek-v4-pro'` — chmura, nie lokalny.
- `workerPresets.fast: 'groq-llama-3.1-8b'`, `.reasoning: 'nemotron-omni-reasoning-free'`, `.powerful: 'nemotron-ultra-free'`.
- Lokalne modele (`ollama/local/*`) w manifeście są, ale **przypisane do innych agentów** (crmAgent, salesAgent). Intuicja właściciela o „lokalnym modelu, który się gubi" **nie potwierdza się dla ścieżki chefa** — ale:

⭐ **Faza `recipes` i `critic_gate` jadą na `run_worker` preset `reasoning` = `nemotron-omni-reasoning-free`, czyli DARMOWY TIER.** Darmowe tiery rate-limitują i potrafią oddać pustkę. To jest bardzo dobry kandydat na przyczynę 8 padniętych workerów i 0 przepisów przy 25 daniach. Zweryfikuj, zanim cokolwiek zmienisz — i sprawdź, czy przebieg bezpośredni (ten udany, 18/18) używał tych samych presetów, czy innych.

### 5.4 Dlaczego menu urosło do 25 dań
Po zdjęciu „keep it direct" chef zrobił 25 dań zamiast 18 — czyli **więcej kart do napisania w tym samym oknie**. Rozważ, czy pipeline nie powinien wiązać liczby dań z budżetem, albo kończyć Księgę przyrostowo tak, żeby przerwanie w połowie zostawiało komplet dla podzbioru dań.

---

## 6. Restauracje już zużyte — weź inną

`apotek.is`, `fjallkona.is`, `grillmarkadurinn.is`, `fiskmarkadurinn.is`, `saetasvinid.is`, `kopar.is`, „Reykjavik Kitchen", „Reykjavik Bistro". Baza jest współdzielona — powtórzenie nazwy grozi podebraniem gotowego wyniku i fałszywym sukcesem. Weź lokal z **realną, czytelną stroną** (recon musi mieć co czytać), spoza tej listy.

---

## 7. Jak wydać 3 przebiegi

Propozycja, nie nakaz — ale uzasadnij odstępstwo:

1. **Przebieg 1 — pomiar odniesienia, bez zmian w kodzie.** Nowa restauracja ze stroną, **pinowana** przez `/v2/conversations/:cid/commands` z `capability: chefAgent`. Pin zwiera lane'a, więc izoluje pytanie „czy chef pod V2 domyka pipeline", bez mieszania z routingiem. Zbierz: błędy workerów, czy doszedł do `qa_final`, które sekcje puste, na czym zszedł czas.
2. **Przebieg 2 — po naprawie tego, co przebieg 1 pokazał.** Ta sama restauracja jest OK, jeśli usuniesz jej projekt z bazy; inaczej weź kolejną.
3. **Przebieg 3 — dowód końcowy przez Meta Front**, czyli pełna droga, której dotyczy zgłoszenie właściciela.

Jeśli przebieg 1 rozstrzygnie sprawę jednoznacznie, drugi możesz sobie darować i zostawić zapas.

---

## 8. Czego oczekujemy na wyjściu

1. **Plan** — zanim cokolwiek zmienisz. Co badasz, w jakiej kolejności, na co wydajesz każdy z 3 przebiegów, i jakie zdarzenie każe ci zmienić plan.
2. Odpowiedź, **dlaczego chef nie domyka kroków**, z dowodem (plik i linia albo pomiar z żywego joba).
3. Odpowiedź, **czy modele są tu współwinne** — potwierdzenie albo obalenie tropu z §5.3.
4. Propozycja, jak **zrównać obie drogi**, z jawnym rozróżnieniem: co jest naprawą kodu, a co decyzją właściciela (np. podniesienie okna z 30 na 45 min kosztuje pieniądze i to nie jest twoja decyzja).
5. Dla każdego wniosku — dowód. Jeśli czegoś nie da się rozstrzygnąć bez zmiany kodu albo bez czwartego przebiegu, **powiedz to wprost, zamiast zgadywać**.
