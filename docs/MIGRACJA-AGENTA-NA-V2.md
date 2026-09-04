# Migracja agenta na silnik V2 — kryteria i protokół

Sito, przez które przechodzi **każdy** agent, zanim uznamy go za przeniesiony.
Powstało z badania kodu 2026-08-11, nie z założeń — każde kryterium wskazuje na
konkretny mechanizm i mówi, gdzie go sprawdzić.

**Zasada nadrzędna:** agent na V2 ma być **taki sam albo lepszy**. Każda różnica
in minus jest blokadą migracji, nie „drobiazgiem do poprawienia później".

---

## 0. Co „migracja" tutaj znaczy — i czego NIE znaczy

| | |
|---|---|
| **Znaczy** | agent jest osiągalny jako capability V2, przeszedł canary, a wszystkie jego zdolności działają na nowej ścieżce nie gorzej niż na starej |
| **NIE znaczy** | legacy przestaje działać. Legacy zostaje do F9; V2 jest **równoległe**, za flagą, z rollbackiem przez zdjęcie flagi |

Dziś **żaden agent nie jest przepięty w sensie odebrania ruchu legacy**. Siedem
capability jest *osiągalnych* przez V2 i przeszło canary; produkcja nadal jedzie
na legacy, bo flagi F6 są domyślnie wyłączone.

---

## 1. Dwie ścieżki — co agent dostaje na każdej

Zbadane, nie założone. **Legacy nie jest jedną ścieżką**, tylko trzema, i od tego
zależy, czy V2 jest ulepszeniem, czy ryzykiem regresji:

| ścieżka legacy | kto nią idzie | co dostaje |
|---|---|---|
| **dedykowany harness** | coding, automation, knowledge, review | pełny profil **+ precontext domenowy** |
| **pipeline + reflektor** | chef, content, hunt, writer, filmmaker, musician | profil pipeline'owy, liveness, narzędzia fazowe |
| **generyczna** | **cała reszta — w tym design, analytics, crm, sales, marketing** | **gołe `agent.generate`** z wątkiem pamięci i płaskim timeoutem |

Na V2 **każdy** agent dostaje ten sam profil harnessu (`harnessCallerFactory`):
głębokość, reflektor, sufit kroków, liveness, koperty narzędzi, budżet próby.

**Wniosek, którydecyduje o kolejności migracji:** dla agentów ze ścieżki
generycznej V2 jest **wyraźnym ulepszeniem**. Dla agentów z dedykowanym
harnessem trzeba najpierw sprawdzić kryterium 3 (precontext), bo tam V2 dziś
**daje mniej**.

---

## 2. Kryteria — sito dla każdego agenta

### K1 — Sufit kroków jest zadeklarowany i sensowny
**Dlaczego:** Mastra domyślnie tnie na **5 krokach** (`__text`/`__stream`), a poza
harnessem to jedyny sufit, jaki istnieje. `marketingAgent` miał 23 narzędzia
i limit 5 — nie mógł przeprowadzić żadnego wieloetapowego przepływu.
**Jak sprawdzić:** `npm run audit:agent-limits`
**Przechodzi, gdy:** agent deklaruje `defaultOptions.maxSteps`, a liczba ma
uzasadnienie w kształcie pracy (nie w liczbie narzędzi — to powierzchnia, nie głębokość).
**Reguła w mocy:** harness może PODNIEŚĆ sufit do deklaracji, nigdy go obniżyć.

### K2 — Deliverable da się zapisać
**Dlaczego:** `designAgent` obiecywał `media_ref` bez ŻADNEGO narzędzia zapisu —
pipeline ścinał się na kroku 1, a trzy rundy pracy poszły na złą hipotezę.
**Jak sprawdzić:** `npm run check:deliverable-capability`
**Przechodzi, gdy:** agent deklarujący `*_ref` ma narzędzie tworzące plik.

### K3 — Precontext: czy agent go traci ✅ *(odblokowane 2026-08-11)*
**Dlaczego:** V2 nie przekazywał `contextBuilder` — runy V2 miały zero
precontextu. Dla agenta ze ścieżki generycznej to bez zmian (i tak go nie miał).
Dla coding/automation/knowledge/review to była **regresja**: bez precontextu
automation nie wie, jakie ma credentiale, które wzorce zadziałały ani jakie
awarie są już rozpoznane.
**Rozwiązane:** `orchestration/execution/capability-precontext.ts` — rejestr
per capability, ładowany leniwie (moduły automation ciągną legacy klienta Mongo,
a graf modułów montażu V2 ma być od niego wolny). Rejestr oddaje **ten sam
obiekt**, który spreaduje legacy (`automationPrecontextFields`), więc oba końce
nie mogą się rozjechać.
**Jak sprawdzić:** `npm run check:capability-precontext`
**Przechodzi, gdy:** agent nie miał precontextu **albo** ma wpis w rejestrze,
a canary potwierdził, że treść dociera do modelu.
**⛔ Nadal zablokowani:** coding, knowledge, review — mają własny precontext, ale
**wpis w rejestrze bez canary to deklaracja, nie zdolność**. Dodawaj wpis
WYŁĄCZNIE razem z canary tego agenta.

### K4 — Pamięć warstwowa: równoważna lub lepsza
**Dlaczego:** to była największa obawa i **zbadanie ją rozbroiło** — ale tylko
dlatego, że warstwy są trzy i każda zachowuje się inaczej:

| warstwa | legacy | V2 | werdykt |
|---|---|---|---|
| wątek Mastra `Memory` (working/observational) | świeży `delegation-<uuid>` per delegacja | świeży `orch-v2-job:<jobId>` per job | **równoważne** — obie świeże na jednostkę pracy |
| `resource` (przestrzeń nazw) | `context.resourceId` lub `meta-agent` | stała `orch-v2` | inna przestrzeń, obie izolowane; **celowo** odcięte na czas canary |
| `memory_recall` / `memory_write` → `system_knowledge` | globalna kolekcja | **ta sama** globalna kolekcja | **identyczne** |

**Przechodzi, gdy:** agent nie polega na ciągłości wątku między delegacjami
(prawie żaden nie polega — legacy też daje świeży wątek).
**⚠️ Uwaga:** `orch-v2` to JEDEN resource dla całej linii, nie per-agent. Jest tak
celowo: przy per-agent zasobie delegacja wewnątrz runu wywalała się na
„wrong resourceId", trzy próby wracały puste, job kończył się `FAILED`.

### K5 — Skille i wyszukiwanie narzędzi
**Dlaczego:** to warstwa poziomu AGENTA (`inputProcessors`, `ToolSearchProcessor`,
`skills` w `run_worker`), nie harnessu — więc przenosi się sama.
**Jak sprawdzić:** `inputProcessors` agenta + czy `run_worker` dostaje `skills`.
**Przechodzi, gdy:** procesory są na agencie (a nie wstrzykiwane przez konkretny
harness legacy). Skille do workera ładuje `SkillRegistry` → prompt, identycznie na obu ścieżkach.

### K5b — Prompt nazywa narzędzia, które model REALNIE widzi *(dodane 2026-08-12, pomiar domeny coding)*
**Dlaczego:** Mastra nadaje narzędziu nazwę **klucza obiektu `tools`**, nigdy
`createTool({id})` — projekt zna ten fakt (`ORCHESTRATION-V2.md` §„id ≠ the name
the runtime reports"), ale zastosował go tylko do selekcji artefaktów. Prompty
nikt nie sprawdził. Zmierzone: `codeReviewAgent` zaczyna instrukcję od
„`coding_worktree_diff` — **Use this first**", a runtime oferuje `worktreeDiffTool`;
**sześć z jedenastu** nazw nie istniało. U `codingAgent` dziewięć.
**Dlaczego to przeżyło:** model zwykle trafia w bliską nazwę ze swojego rejestru,
więc defekt degraduje się w dodatkowe tury i sporadyczny zły wybór, a nie w błąd.
Tym gorzej: nie ma objawu, który ktoś by zauważył.
**Jak sprawdzić:** `npm run check:prompt-tool-names`
**Przechodzi, gdy:** każdy backtickowany token promptu, który JEST zarejestrowanym
id narzędzia, jest też kluczem, pod którym ten agent je wystawia.
**Naprawa jest po stronie AGENTA, nie promptu:** klucz przepisujemy na id
(`coding_worktree_diff: worktreeDiffTool`), bo id to słowo, którego już używają
prompty, dokumentacja i `pipeline-phase-tools.ts`.
**⚠️ Zakres bramy:** dziś twardo obowiązuje dla promptów `coding/`. Pozostałe
33 przypadki (automation 23, researcher 5, capabilitySmith 4, crm 1) brama
**wypisuje jako backlog** — ich naprawa przemianowuje klucze u agentów PO canary,
więc to decyzja właściciela, nie efekt uboczny cudzego zadania.

### K6 — Delegacja: do agentów i do workerów
**Dlaczego:** agent nie ma robić wszystkiego sam. `delegateTaskTool` i
`runWorkerTool` muszą działać z wnętrza runu V2.
**Jak sprawdzić:** czy agent ma te narzędzia; czy `run_worker` nie wymaga kontekstu
harnessu (nie wymaga — buduje własnego, tekstowego agenta ad hoc).
**Przechodzi, gdy:** delegacja wewnątrz runu V2 kończy się wynikiem, nie pustką.
**Regresja historyczna do pilnowania:** patrz K4 — per-agent resource ją zabijał.

### K7 — Nic nie czeka na człowieka bez człowieka
**Dlaczego:** to klasa defektu, którą ten projekt usuwał wielokrotnie. Job w tle
nie ma komu odpowiedzieć.
**Jak sprawdzić:** czy jakiekolwiek narzędzie agenta **czeka** na zgodę zamiast
zwrócić stan.
**Przechodzi, gdy:** narzędzia zgody zwracają natychmiast (`requestApprovalTool`
zapisuje `pending` i wraca — OK) **albo** agent używa `NEEDS_INPUT` z kontraktu headless.
**⛔ Blokada dla:** `codingAgent` — `requiresCodeCommandApproval` zawiesza run.

### K8 — Zależność zewnętrzna (MCP/sidecar)
**Dlaczego:** statyczny toolset **zaniża** i możliwości, i promień rażenia.
`knowledgeAgent` wygląda na 8 wewnętrznych narzędzi, a realnie tworzy notatniki
w Google użytkownika przez sidecar MCP.
**Jak sprawdzić:** `npm run audit:agent-readiness` (wykrywa import `../mcp.js`)
**Przechodzi, gdy:** zależność jest znana, sidecar żyje, a promień rażenia
policzony **po** narzędziach MCP, nie tylko po statycznych.

### K9 — Wynik konsumowalny przez następny krok *(nowe po F6B)*
**Dlaczego:** agent bywa teraz **krokiem sekwencji**. Proza tam, gdzie następny
krok potrzebuje dokumentu, to awaria pipeline'u, nie słaby wynik.
**Jak sprawdzić:** `npm run audit:agent-readiness` (kryterium „wynik").
**Przechodzi, gdy:** `outputArtifacts` zawiera typ referencyjny lub strukturalny.

### K9b — To, co agent ZAPISAŁ, dociera do następnego kroku *(dodane przez canary designu)*
**Dlaczego:** deklaracja z K9 mówi tylko, że agent *ma prawo* wyprodukować plik.
Canary designu pokazał, że plik powstawał, a **referencja do niego ginęła**:
`ModelCaller` zwracał `{ text, fromArtifact }` i **nie miał kanału na id**, więc
`producer.artifacts` było puste dla każdego runu w historii. Niezależnie od tego
czytnik (`readUpstreamResults`) szukał pola `a.id`, gdy kontrakt nazywa je
`artifactId` — dwa przerwania w tym samym kanale, każde wystarczające samo.
**Skutek zmierzony:** krok designu zapisywał 18 KB dokumentu, a następny krok
dostawał 2 000-znakowy urywek i **żadnego sposobu, by sięgnąć po resztę** — choć
prompt już mu obiecywał „pełna treść pod tymi id".
**Jak sprawdzić:** `npm run check:artifact-handoff`
**Przechodzi, gdy:** `producer.artifacts` niesie `{artifactId, type, summary, hash}`,
a `ctx.upstream[].artifacts` następnego kroku zawiera to id.
**⚠️ Czego NIE dowodzi stara brama:** `check:multi-step-plan` sam wstrzykiwał
`artifacts: ['art-1']` do kontekstu i sprawdzał, że prompt to renderuje. Dowodził
renderera, nie tego, że producent cokolwiek tam wkłada — **i dlatego martwy kanał
przeżył**. Test pisany z wyobrażenia o danych, nie z danych.

### K10 — Promień rażenia jest zaakceptowany świadomie
**Dlaczego:** domyślny allowlist to agenci, których najgorszy przypadek to
zmarnowany run. **Wszyscy pozostali mają cięższy** — pieniądze, zapis na zewnątrz,
zmiana systemu.
**Przechodzi, gdy:** właściciel systemu **jawnie** zgodził się na ten konkretny
efekt w świecie. To decyzja człowieka, nie audytu.

---

## 3. Protokół canary — ta sama sekwencja dla każdego

1. **Sito K1–K10.** Blokady domknięte albo świadomie odnotowane.
2. **Wyjściowy `check:all`** zielony (0 błędów, 0 SKIP) — baseline przed zmianą.
3. **Włączenie capability** przez `ORCHESTRATION_V2_CAPABILITIES`, nie przez
   edycję domyślnej listy — canary nie zmienia produkcji.
4. **Świeża baza V2** (`MONGODB_DB_V2=orchestration_v2_<agent>`) — worker jest
   seryjny, stary backlog zagłodziłby nowy job i zmierzyłbyś kolejkę.
5. **Realne zlecenie** przez Meta Front, **wynik czytany Z BAZY**, nie z odpowiedzi frontu.
6. **Porównanie z legacy** na tym samym zleceniu: czy V2 dał to samo lub więcej.
7. **Zapis dowodu** w planie: co zadziałało, co canary złapał, czego nie sprawdzono.

**Czego canary nie zastąpi:** sito mówi, czego brakuje w deklaracjach — nie czy
agent zadziała. **Każdy dotychczasowy canary znalazł defekt, którego żadna
z tych reguł by nie wyłapała.**

---

## 4. Karta migracji — do wypełnienia per agent

```
AGENT: <id>
Ścieżka legacy: dedykowany harness | pipeline | generyczna
K1 sufit kroków      [ ]  deklaracja: ___
K2 zapis deliverable [ ]
K3 precontext        [ ]  miał na legacy? tak/nie
K4 pamięć            [ ]  polega na ciągłości wątku? tak/nie
K5 skille/tool search[ ]
K6 delegacja         [ ]  delegate_task / run_worker
K7 brak czekania     [ ]
K8 zależność MCP     [ ]
K9 wynik konsumowalny[ ]
K9b referencja dociera[ ] artifacts w kopercie: ___
K10 zgoda właściciela[ ]  efekt: ___
CANARY: data ___ wynik ___ co złapał ___
NIEZWERYFIKOWANE: ___
```

### K11 — Czy produktem agenta jest TEKST *(dodane przez canary automationArchitect)*
**Dlaczego:** tryb `bounded_text` uznaje run za udany, gdy zwróci niepusty tekst.
Dla agenta, którego produktem jest **efekt w świecie** (wdrożony workflow), to
kryterium mierzy niewłaściwą rzecz. Zmierzone: architekt **wdrożył workflow do
n8n** (`Mastra - Webhook Email Validator`, nieaktywny — zweryfikowane w API n8n),
po czym zadanie V2 dostało `empty_output` i `FAILED`, bo ostatnim tekstem runu był
raport scorera harnessu. Silnik uznał pracę za nieudaną i **uruchomił ją od nowa**
— przy agencie z efektami ubocznymi to ryzyko powtórzenia akcji w świecie
(w tym przebiegu duplikat NIE powstał — sprawdzone w n8n, jeden workflow).
**Jak sprawdzić:** czy `outputArtifacts` z karty to dokument, czy referencja do
czegoś, co agent robi na zewnątrz; i czy agent kończy run zapisem artefaktu.
**Przechodzi, gdy:** produkt runu jest tekstem lub **zapisanym artefaktem**
(kanał z K9b) — a nie wyłącznie efektem ubocznym plus milczeniem.
**✅ ROZWIĄZANE 2026-08-11:** takie agenty są wypisane w
`SIDE_EFFECT_PRODUCT_CAPABILITIES` (`capability-routing.ts` — **jedno** miejsce,
z którego czyta zarówno runtime, jak i audyt) i dostają w kontrakcie headless
dodatkową regułę domknięcia: zapisz produkt przez `artifact_put` (**plik NIE
wystarczy — plik jest niewidoczny dla joba**) i zakończ krótkim raportem
nazywającym id-y tego, co zmieniłeś w świecie.
**Reguła trafia WYŁĄCZNIE do tych agentów** — ośmiu wcześniej zweryfikowanych
dostaje prompt bajt w bajt taki, z jakim przechodzili canary. Pilnuje tego
asercja w `npm run check:headless-contract`.
**Świadomie NIE rozluźniono „no false success" (§3.6):** run bez produktu ma
failować; rzecz w tym, żeby produkt istniał tam, gdzie silnik patrzy.

---

## 5. Karty wypełnione

### designAgent — 2026-08-11

```
AGENT: designAgent
Ścieżka legacy: generyczna (gołe agent.generate)
K1 sufit kroków      [x]  deklaracja: 150; profil dał 10, harness PODNIÓSŁ do 150
K2 zapis deliverable [x]  design_write_deliverable (plik + artefakt jednym wywołaniem)
K3 precontext        [x]  nie miał go na legacy — brak regresji
K4 pamięć            [x]  nie polega na ciągłości wątku; system_knowledge identyczne
K5 skille/tool search[x]  procesory na agencie, przenoszą się same
K6 delegacja         [x]  ma delegate_task / run_worker
K7 brak czekania     [x]  żadne narzędzie nie czeka na człowieka
K8 zależność MCP     [x]  brak importu ../mcp.js
K9 wynik konsumowalny[x]  outputArtifacts: media_ref, document
K9b referencja dociera[x] artifacts: [{artifactId: art-52d71c2c…, type: document, hash: sha256}]
K10 zgoda właściciela[x]  efekt: płatna generacja — canary jechał z JAWNYM zakazem
                          generowania obrazów i wideo, więc nic płatnego nie ruszyło
CANARY: 2026-08-11 | TERMINAL/COMPLETED, 1 zadanie, 1 próba OK, 0 replanów (design)
        wynik 18 434 zn. z <!DOCTYPE, fromArtifact=true
        Depth: fast (score=0.15) → sufit podniesiony do 150
        maxGap 60,1 s przy podłodze idle 480 s (margines 8×)
CO ZŁAPAŁ: martwy kanał artefaktów (patrz K9b) — DWA niezależne przerwania,
        niewidoczne dla wszystkich istniejących testów
NIEZWERYFIKOWANE: ścieżka z PŁATNĄ generacją obrazu/wideo (świadomie pominięta);
        designAgent NIE jest w DEFAULT_V2_CAPABILITIES — canary szedł przez
        ORCHESTRATION_V2_CAPABILITIES, produkcja bez zmian
```

### automationArchitect — 2026-08-11

```
AGENT: automationArchitect
Ścieżka legacy: dedykowany harness (+ precontext domenowy)
K1 sufit kroków      [x]  deklaracja: 40 (= najgłębszy profil; 49 narzędzi)
K2 zapis deliverable [x]  artifact_put; automation_workflow jest legalnym typem
K3 precontext        [x]  MIAŁ na legacy → V2 dostał TEN SAM obiekt (rejestr capability)
K4 pamięć            [x]  nie polega na ciągłości wątku między delegacjami
K5 skille/tool search[x]  inputProcessors na agencie
K6 delegacja         [x]  delegateTaskTool + runWorkerTool; deleguje do Golden Path
K7 brak czekania     [x]  requestApprovalTool zapisuje `pending` i WRACA, nie blokuje
K8 zależność MCP     [x]  pośrednia (n8nMcpEngineer); sidecar :8765 odpowiada, n8n 200
K9 wynik konsumowalny[x]  automation_workflow, analysis_report
K9b referencja dociera[x] Golden Path ZAPISUJE wdrożony workflow jako artefakt
                          w momencie deployu (nie prosimy o to modelu)
K10 zgoda właściciela[x]  efekt: DEPLOY do n8n — zgoda udzielona 2026-08-11.
                          Aktywacja NIE objęta zgodą → canary deployował NIEAKTYWNY
K11 produkt = tekst  [x]  reguła domknięcia w kontrakcie headless

CANARY RUNDA 1 (przed naprawą): workflow WDROŻONY (`Mastra - Webhook Email
        Validator`, active=false — zweryfikowany przez API n8n), a zadanie V2
        FAILED z `empty_output` → job powtórzył pracę, która już istniała.
CANARY RUNDA 2 (po naprawie): TERMINAL/COMPLETED, 1 zadanie, 1 próba OK,
        0 replanów. Wynik = raport: workflowId `lyKat4puV2nXxet2`, active=false,
        risk 15, status tested. Zweryfikowane u źródła: workflow istnieje w n8n,
        NIEAKTYWNY, utworzony 09:37:52. Depth: deep (0.55), maxGap 29,0 s.
CO ZŁAPAŁ: GAP-SIDE-EFFECT-RESULT-01 — `bounded_text` ocenia run po prozie,
        a produktem tego agenta jest efekt w świecie. Fałszywe FAILED przy
        agencie z efektami ubocznymi = ryzyko POWTÓRZENIA akcji w świecie.
CANARY RUNDA 3: artefakt DOCIERA do koperty (`art-5ace2429`, automation_workflow,
        hash) — ale ujawnił regresję, którą sam wprowadziłem: `fromArtifact`
        podmienił czytelny raport na 3601 zn. surowego JSON-a.
CANARY RUNDA 4 (ostateczna): TERMINAL/COMPLETED, 1 zadanie, 1 próba OK, 0 replanów.
        `fromArtifact=false` → produktem jest RAPORT (5004 zn.), a artefakt
        `art-72f2aaa9` jest DOŁĄCZONY jako referencja. Zweryfikowane u źródła:
        `Mastra - Invoice ID Validator`, id `cvFwxEYsCml4jioA`, active=false,
        utworzony 10:00:24. maxGap 38,8 s. Zero linii `run produced no deliverable`.
NIEZWERYFIKOWANE:
  - trop `substantive final output (2519 chars)` z rundy 1 (scorer widział wynik,
    którego `bestDeliverable` nie zachował) NIE został domknięty — objaw zniknął,
    przyczyna nie została ustalona. Nie blokuje: produkt runu nie zależy już od
    tego, czy model zdąży coś powiedzieć.
  - aktywacja workflow (żywe wyzwalacze) — świadomie poza zakresem zgody.
  - w raporcie rundy 4 model wtrącił dwa chińskie znaki („已完成") w polskim
    tekście — usterka jakości modelu, nie silnika; nie wpływa na wynik.
  - automationArchitect NIE jest w DEFAULT_V2_CAPABILITIES.
```

### huntAgent — 2026-08-11

```
AGENT: huntAgent
Ścieżka legacy: pipeline + reflektor
K1 sufit kroków      [x]  deklaracja: 150 (pipeline discover→score→enrich→draft→CRM)
K2 zapis deliverable [x]  artifact_put; outputArtifacts: lead_batch, email_draft, crm_update
K3 precontext        [x]  nie miał go na legacy (ścieżka pipeline) — brak regresji
K4 pamięć            [x]  nie polega na ciągłości wątku
K5 skille/tool search[x]  inputProcessors na agencie
K6 delegacja         [x]  delegateTaskTool + runWorkerTool
K7 brak czekania     [x]  requestApprovalTool zapisuje `pending` i wraca
K8 zależność MCP     [x]  brak importu ../mcp.js
K9 wynik konsumowalny[x]  lead_batch + research_report
K9b referencja dociera[x] 3 artefakty w kopercie (2× research_report + lead_batch)
K10 zgoda właściciela[x]  efekt: ZAPIS DO CRM — zgoda udzielona 2026-08-11.
                          Maile: agent NIE MA narzędzia wysyłki (tylko szkice);
                          właściciel dopuścił adres wyłącznie admin@example.com
K11 produkt = tekst  [x]  raport jako produkt, artefakty DOŁĄCZONE (fromArtifact=false)

CANARY RUNDA 1: COMPLETED, ale raport ZAWYŻAŁ wykonaną pracę — twierdził
        „CRM records created" dla DWÓCH producentów, a powstał JEDEN lead
        (186→187); drugi (Sernica) leżał w CRM od maja i NIE został tknięty
        (updatedAt 2026-05-08, status research_needed).
NAPRAWA: reguła dokładności w bloku side-effect kontraktu headless — raportuj
        WYŁĄCZNIE to, co zwróciły narzędzia; „już istniał" ≠ „utworzony".
CANARY RUNDA 2: TERMINAL/COMPLETED, 1 zadanie, 1 próba OK, 0 replanów.
        CRM 187→189 = DOKŁADNIE 2 nowe leady, tyle samo deklaruje raport.
        Szkice Gmaila zweryfikowane w wywołaniach narzędzi:
        `to: admin@example.com` dla OBU, temat prefiksowany [SZKIC].
        Artefakty: art-ad79297e, art-f52af50e (research_report), art-1b6dc532 (lead_batch).
CO ZŁAPAŁ: raport zawyżający efekty w świecie u agenta piszącego na zewnątrz —
        gorsze niż awaria, bo wygląda jak sukces i nikt tego nie sprawdza.
NIEZWERYFIKOWANE:
  - skuteczność reguły dokładności potwierdzona JEDNYM przebiegiem; to obserwacja,
    nie dowód, że model zawsze będzie raportował zgodnie z toolResults.
  - treść szkiców w samym Gmailu odczytana z argumentów wywołań narzędzi, NIE
    z konta Gmail (brak autoryzacji w tej sesji).
  - tekst wyniku to sklejona narracja faz („Teraz faza discover…"), nie zwięzły
    raport końcowy — usterka czytelności, nie poprawności.
  - huntAgent NIE jest w DEFAULT_V2_CAPABILITIES.
```

### marketingAgent — 2026-08-11

```
AGENT: marketingAgent
Ścieżka legacy: generyczna (gołe agent.generate)
K1 sufit kroków      [x]  deklaracja: 25 (26 narzędzi po dodaniu artefaktów)
K2 zapis deliverable [x]  DODANE w tej migracji — wcześniej „writes via: —"
K3 precontext        [x]  nie miał go na legacy
K4 pamięć            [x]  nie polega na ciągłości wątku
K5 skille/tool search[x]  inputProcessors na agencie
K6 delegacja         [ ]  BRAK delegate_task / run_worker — patrz NIEZWERYFIKOWANE
K7 brak czekania     [x]  brak narzędzi blokujących
K8 zależność MCP     [x]  brak importu ../mcp.js (NotebookLM idzie przez narzędzia knowledge)
K9 wynik konsumowalny[x]  email_draft, crm_update, document
K9b referencja dociera[~] agent NIE wywołał artifact_put mimo instrukcji (artifacts: [])
K10 zgoda właściciela[x]  efekt: KALENDARZ + CRM + maile TYLKO na admin@example.com;
                          NotebookLM (tworzenie/dodawanie źródeł/USUWANIE) — zgoda
                          udzielona osobno 2026-08-11
K11 produkt = tekst  [x]  raport jako produkt; jest na liście side-effect

CANARY RUNDA 1 i 2: router wybrał `crmAgent` (read-only, okno 120 s) — DWA
        TIMED_OUT, trzecia próba zwróciła PLAN, a job i tak COMPLETED.
        Realnie wykonano JEDNO wywołanie: searchLeadsTool. Nic nie powstało.
NAPRAWA: menu routera nie zawierało `whenNotToUse` (i ucinało `whenToUse` do 2).
        Router widział, do czego agent służy, i NIGDY do czego nie.
CANARY RUNDA 3: router wybrał marketingAgent, 4 realne narzędzia, zapisy w CRM
        i wydarzenie w kalendarzu potwierdzone w historii leada.
        ALE: wydarzenie z datą 2026-05-28 (TRZY MIESIĄCE WSTECZ) opisane jako
        „przyszły tydzień", plus ZMYŚLONE id artefaktu w raporcie.
NAPRAWA: kontrakt headless podaje dziś datę; narzędzie kalendarza ODRZUCA
        przeszłość; z opisu narzędzia usunięto przykładową datę (agent
        zakotwiczył się właśnie na niej).
CANARY RUNDA 4: TERMINAL/COMPLETED, 1 zadanie, 1 próba OK, router = marketingAgent,
        wydarzenie na 2026-08-18T10:00Z = faktycznie przyszły tydzień.
NIEZWERYFIKOWANE:
  - agent nadal kończy raport wzmianką o artefakcie, którego NIE zapisał
    (`artifacts: []`). Słabsza wersja tego samego defektu co u hunta.
  - K6: marketingAgent nie ma delegate_task ani run_worker — nie może zlecić
    pracy dalej. Na legacy też nie mógł, więc to NIE jest regresja, ale jest
    ograniczeniem względem hunta i architekta.
  - ⚠️ Wydarzenie z rundy 3 (`krqdt0robguapg21bindp6gp3g`, 2026-05-28) ZOSTAŁO
    w kalendarzu właściciela. Nie usuwałem go.
  - marketingAgent NIE jest w DEFAULT_V2_CAPABILITIES.
```

### knowledgeAgent — 2026-08-11

```
AGENT: knowledgeAgent
Ścieżka legacy: dedykowany harness (+ precontext domenowy)
K1 sufit kroków      [x]  deklaracja: 40
K2 zapis deliverable [x]  artefakty + research_report/document
K3 precontext        [x]  wpis w rejestrze DODANY RAZEM Z CANARY; potwierdzony
                          telemetrią: feature=knowledge_precontext, injected=true, 321 tok
K4 pamięć            [x]  nie polega na ciągłości wątku
K5 skille/tool search[x]  POTWIERDZONE LIVE: search_tools + load_tool w runie
K6 delegacja         [x]  ma narzędzia delegacji
K7 brak czekania     [x]  brak narzędzi blokujących
K8 zależność MCP     [x]  PIERWSZY ŻYWY TEST: notebook_create, source_add,
                          notebook_query wykonane przez sidecar MCP z runu V2
K9 wynik konsumowalny[x]  research_report, document
K9b referencja dociera[x] nie dotyczy — produktem jest raport (nie jest na liście side-effect)
K10 zgoda właściciela[x]  efekt: TWORZENIE notatnika i dodawanie źródeł w Google
                          użytkownika. Zgoda 2026-08-11 na zakres: jeden notatnik
                          + zapytanie. USUWANIE JAWNIE WYŁĄCZONE ze zlecenia.
K11 produkt = tekst  [x]  raport jest produktem

CANARY: TERMINAL/COMPLETED, 1 zadanie, 1 próba OK, 0 replanów.
        Utworzono notatnik `bb1acf41-ad5c-42ad-81d0-bbc2fb632900`, źródło
        `a047e5f7-f741-4047-b57a-cfea7433cc72`, zwrócono odpowiedź z zapytania.
        Żadnego wywołania usuwającego w całym runie.
CO POTWIERDZIŁ (a nie złapał): to pierwszy canary, który NIE znalazł nowego
        defektu. Powód jest sprawdzalny: trzy mechanizmy, które go dotyczyły
        (precontext, kanał artefaktów, kontrakt headless), zostały naprawione
        przy poprzednich agentach.
NIEZWERYFIKOWANE:
  - istnienie notatnika potwierdzone łańcuchem wywołań (create → source_add →
    query na TYM id), nie odczytem z konta Google.
  - ścieżka usuwania notatnika NIE była testowana (świadomie).
  - knowledgeAgent NIE jest w DEFAULT_V2_CAPABILITIES.
```

### Siódemka domyślna — przebieg zbiorczy 2026-08-11

Siedem agentów z `DEFAULT_V2_CAPABILITIES` przeszło canary **we wcześniejszych
etapach, zanim sito K1–K11 powstało**. Ten przebieg puszcza je przez sito i przez
maszynerię zmienioną tego dnia (kontrakt headless, loader promptów, kanał
artefaktów, menu routera) — jeden job na agenta, jedna wspólna baza.

**Statyka (K1, K2, K8, K9, K10):** wszyscy deklarują sufit kroków; wynik
konsumowalny u wszystkich; promień rażenia u każdego to „zmarnowany run" (dlatego
są domyślni). `analyticsAgent` i `crmAgent` nie mają narzędzia artefaktu, ale
deklarują `analysis_report` — prozę, więc brama słusznie ich nie oblewa.

| agent | K3 precontext | K5 procesory | K6 delegacja | K7 zgoda | K8 MCP |
|---|---|---|---|---|---|
| researcher | brak (bez regresji) | ✗ | ✗ | — | **importuje `../mcp.js`** |
| chef | brak | ✓ | ✓ | nieblokująca | — |
| content | brak | ✓ | ✓ | nieblokująca | — |
| writer | brak | ✓ | ✓ | nieblokująca | — |
| analytics | brak | ✗ | ✗ | — | — |
| deliberation | brak | ✗ | ✗ | — | — |
| crm | brak | ✗ | ✗ | — | — |

Brak procesorów i delegacji u czterech agentów **nie jest regresją** — na legacy
też ich nie mieli. Jest ograniczeniem: nie zlecą pracy dalej i nie mają
dynamicznego wyszukiwania narzędzi.

**Przebieg live — 7 jobów:**

| agent | wynik | dowód |
|---|---|---|
| `researcherAgent` | ✅ COMPLETED | 1466 zn. |
| `chefAgent` | ✅ COMPLETED | 3400 zn., **2 artefakty w kopercie** (K9b live) |
| `contentAgent` | ✅ COMPLETED **po retry** | pierwsza próba TIMED_OUT, druga 9429 zn. |
| `crmAgent` | ✅ COMPLETED | 70 zn., lookup w 120 s |
| `writerAgent` | ❌ **JOB FAILED** | timeout + 2× `forbidden U+2014` |
| `analyticsAgent` | ❌ FAILED | `error from Nvidia: ResourceExhausted (33/32)` — **problem dostawcy modelu, nie silnika** |
| `deliberationAgent` | ⚠️ nie dostał zadania | zlecenie o modelu dostaw poszło do `researcherAgent` (COMPLETED, 1 artefakt) |

**🔴 CO ZŁAPAŁ — writer tracił CAŁE opowiadanie przez jeden znak.**
`enforceWriterOutputPunctuation` RZUCAŁ wyjątkiem na U+2014. Zmierzone: 150-słowowe
opowiadanie z jednym myślnikiem → próba failed → retry failed identycznie → **job
FAILED, użytkownik dostał zero**. Zakaz był już w promptach writera **trzy razy**
i od dziś w regule globalnej, więc „poproś jeszcze raz" było wyczerpane. Dodatkowo
nieudana próba jest PONAWIANA, czyli model płaci za regenerację całego tekstu
z powodu jednego znaku. **Naprawa: normalizacja zamiast wyjątku** (audyt anty-slop
nadal ocenia jakość). Asercja w `check:artifact-handoff`.

**NIEZWERYFIKOWANE / do decyzji:**
- `analyticsAgent` ma zepsuty backend modelu (ResourceExhausted u dostawcy) —
  to konfiguracja modelu, poza zakresem migracji.
- router wysłał zadanie porównawcze do `researcherAgent` zamiast
  `deliberationAgent` — granica rozmyta w KARTACH, ta sama klasa co crm/marketing.
- `contentAgent` potrzebował retry (900 s okno) — jeden pomiar, nie trend.

#### Weryfikacja po naprawach — 2026-08-11, przebieg drugi

| co sprawdzane | wynik |
|---|---|
| **writerAgent po zmianie polityki myślnika** | ✅ `SUCCEEDED` — 783 zn. prawdziwego opowiadania. Naprawa potwierdzona LIVE, nie tylko testem deterministycznym |
| **analyticsAgent na modelu `deepseek-v4-pro`** | ✅ `SUCCEEDED` — 3392 zn. raportu z liczbami; **zero `ResourceExhausted`** w logu |
| **routing do `deliberationAgent`** | ✅ router wybrał deliberation, gdy zlecenie brzmiało „rozważ i podważ warianty, oceń trade-offy" |
| `deliberationAgent` — dowiezienie | ⚠️ 1. próba `TIMED_OUT` przy oknie 900 s |

**⭐ USTALENIE O ROUTINGU DELIBERATION:** poprzedni przebieg nie trafił do tego
agenta nie dlatego, że karta jest zła, tylko dlatego, że **Meta Front PRZEPISUJE
wiadomość na cel joba**, a router widzi ten przepisany cel, nie oryginalne słowa.
„Rozstrzygnij dylemat: dostawa własna czy agregator" front zamienił na „Przygotuj
analizę porównawczą modeli dostaw" — i to jest opis researchu. Sformułowanie
w języku debaty przeszło poprawnie.

**⭐ DWA POMIARY TEGO SAMEGO KSZTAŁTU — okno 900 s bywa za małe dla pracy, która
NIE wisi:**

| agent | zdarzenia | najdłuższa cisza | werdykt liveness | co go ścięło |
|---|---|---|---|---|
| `contentAgent` | 29 | 85,5 s | żyje | zegar 900 s |
| `deliberationAgent` | 39 | 134,7 s | żyje | zegar 900 s |

Oba pracowały aż do cięcia. To jest dokładnie ten dowód, którego brakowało, gdy
profil `extended` (1800 s) został wcześniej **odrzucony** — wtedy nie dało się
odróżnić „pracuje" od „zawiesił się", a teraz liveness to rozstrzyga. **Decyzja
o podniesieniu okna należy do właściciela (koszt), nie do audytu.**

**Jak testować `deliberationAgent` (odpowiedź na pytanie o jego rolę):** jest
osiągalny DWIEMA drogami i obie warto sprawdzać osobno —
1. **routing z frontu**, gdy użytkownik prosi o debatę (wymaga sformułowania,
   które przetrwa przepisanie przez Meta Front);
2. **delegacja od innego agenta** — `delegate-task.ts` mapuje `deliberationAgent`
   jako cel, ale **tylko synchronicznie** (jest jawnie wykluczony z delegacji
   async). To ścieżka „agent nie wie, jak podejść do zadania, więc pyta".

Niezależnie od obu harness ma własny `maybeRunAutoDeliberationPass`: gdy reflektor
wykryje sygnały wymagające przemyślenia, run robi **przebieg deliberacyjny bez
narzędzi** na własnym wyniku. To NIE jest wywołanie `deliberationAgent`.

#### `deliberationAgent` — czym jest naprawdę *(zbadane 2026-08-12)*

Pytanie właściciela: „czy w legacy miał delegację, bo pamiętam, że to kilku
agentów, którzy ze sobą rozmawiają". **Jedno i drugie po trosze — i różnica ma
konsekwencje.**

**NIE ma delegacji do innych agentów.** `deliberationAgent` nie rejestruje
`delegateTaskTool` ani `runWorkerTool` (zweryfikowane: 0 trafień). Nigdy nie woła
chefa, researchera ani nikogo z rostera.

**Ma za to własną radę.** `runDeliberationWorkerTool` „spawns an LLM worker bound
to a specific Design Council role", **może być wołany wielokrotnie równolegle**,
a role są rozdzielone fazami, żeby propozycja nie mieszała się z krytyką:

| faza | role | model |
|---|---|---|
| `proposal` | systemsArchitect, llmEngineer, creativeStrategist | `deepseek-v4-pro` |
| `proposal` | memoryArchitect | `gemini-3.1-flash-lite` |
| `critique`, `second_critique` | redTeamCritic | `deepseek-v4-pro` |
| `synthesis` | synthesisPlanner | `deepseek-v4-pro` |

Czyli **sześć „głosów" z własnymi modelami**, ale są to **efemeryczne workery
związane rolą**, nie zarejestrowani agenci. Wrażenie „kilku agentów rozmawia" jest
trafne co do zachowania i mylące co do mechanizmu: rada żyje WEWNĄTRZ jednego runu.

**Co się zmieniło na V2:** sam agent i jego rada są identyczne. Zmieniła się
ścieżka wywołania — legacy miało dla niego skrót (`delegate-task.ts`: „Route
deliberationAgent: direct generate (no harness needed)"), a V2 uruchamia go **pod
harnessem** (głębokość, reflektor, liveness, budżet próby). Stąd timeout
w przebiegu sita: rada sześciu ról przez trzy fazy jest z natury długa, a nie
zawieszona — 39 zdarzeń, najdłuższa cisza 134,7 s.

**Jak go testować (trzy niezależne ścieżki):**
1. **routing z frontu** — sformułowanie musi przetrwać przepisanie na `goal` joba;
   „rozważ i podważ warianty, oceń trade-offy" działa, „przygotuj analizę
   porównawczą" trafia do researchera;
2. **delegacja od innego agenta** — `delegate-task.ts` mapuje go jako cel, ale
   **wyłącznie synchronicznie** (jawnie wykluczony z async);
3. **rada wewnątrz runu** — czy w logu widać wiele wywołań
   `runDeliberationWorkerTool` w różnych fazach. To jest test tego, że deliberacja
   naprawdę się odbyła, a nie że jeden model napisał esej.

**Nie mylić z `maybeRunAutoDeliberationPass`** w harnessie: to przebieg BEZ
narzędzi na własnym wyniku agenta, uruchamiany sygnałem reflektora. Nie ma nic
wspólnego z `deliberationAgent`.

#### Rada obraduje RÓWNOLEGLE — projekt legacy, stan V2 *(2026-08-12)*

Właściciel: „w legacy ci agenci zastanawiali się jednocześnie, a agent główny
sklejał raport — żeby debata nie była odpytywaniem agenta po agencie, bo to by
trwało bardzo długo".

**Projekt potwierdzony w kodzie i nienaruszony przez V2:**
- narzędzie rady deklaruje wprost: „CAN be called multiple times **in parallel**
  for independent sub-tasks or multiple roles";
- `prompts/deliberation/pipeline.md` opisuje fazę propozycji jako równoległą;
- **nic w V2 nie serializuje wywołań** — koperta narzędzi harnessu używa
  `Promise.all`, a `toolChoice: 'none'` pojawia się tylko w dedykowanych
  przebiegach bezanarzędziowych. Równoległość zależy więc od tego, czy MODEL
  wyśle kilka wywołań w JEDNYM kroku.

**Znaleziona słabość — instrukcja była PRZYZWALAJĄCA, nie nakazująca:**
„Proposal calls **may** run in parallel". Dla modelu „może" to nie „ma".
Sekwencyjne odpytanie czterech ról mnoży czas debaty przez liczbę miejsc przy
stole — dokładnie to, czemu ten projekt miał zapobiec. Zmienione na nakaz:
**wszystkie wywołania fazy propozycji w JEDNYM kroku, jako równoległe wywołania
narzędzia**, z uzasadnieniem (role są niezależne z definicji: każda dostaje ten
sam wsad i nie widzi cudzych propozycji).

**⚠️ NIEZWERYFIKOWANE — ale NIE jest to defekt (sprostowanie 2026-08-12).**
Pierwotnie zapisałem tu, że próba „przekroczyła okno" — to była MOJA pomyłka
w rachunku czasu. Odczyt z bazy rozstrzyga:

    attemptCapMs zadania      = 1 800 000   (nowe okno ZASTOSOWANE)
    businessOperationCutoffAt = 01:19:20
    stan sprawdzony o          01:11        → RUNNING, ~8 min do deadline'u

Zatrzymałem serwer przed upływem tego okna. **Run był w budżecie i pracował; to ja
go przerwałem.** Nic nie wymaga naprawy przed dalszą pracą.

Otwarte zostaje wyłącznie to, czego nikt nie zmierzył: **czy `deliberationAgent`
dowozi w oknie 1800 s** i **czy faza propozycji rusza równolegle** po zmianie
instrukcji. Test jest tani i jednoznaczny — w logu ma się pojawić JEDEN krok
z czterema wywołaniami `runDeliberationWorkerTool`, zamiast czterech kolejnych
kroków po jednym.

#### Współpraca `automationArchitect` ↔ `n8nMcpEngineer` — stan zbadany 2026-08-12

**Trasa działa, ale handoff jest odrzucany — i to bramka ma rację.**

Test na żywo: zlecenie budowy workflow z węzłem **spoza rdzenia** (Google Sheets),
czyli pierwsze, które w ogóle wymusza handoff — wszystkie wcześniejsze canary
używały wyłącznie webhooka i kodu, więc ta ścieżka nigdy nie startowała.

**Co zadziałało:**
- architekt **dwukrotnie** zawołał `delegateTaskTool` z `targetAgent: "n8nMcpEngineer"`;
- serwer MCP jest zdrowy: `npx -y n8n-mcp` wystawia **7 narzędzi w 2 s**
  (`search_nodes`, `get_node`, `validate_node`, `validate_workflow`,
  `get_template`, `search_templates`, `tools_documentation`);
- loader inżyniera **nie zgłosił błędu** (`[n8nMcpEngineer]` zero wystąpień
  w logu), więc narzędzia były podłączone przy starcie.

**Co zawiodło:** kontrakt delegacji odrzucił handoff kodem
**`n8n_mcp_handoff_no_real_tool_use`** — inżynier nie wywołał ŻADNEGO prawdziwego
narzędzia MCP, czyli odpowiadał z wiedzy modelu. Bramka istnieje dokładnie po to
(komentarz w kodzie: „the failure mode that shipped a stale googleSheets
typeVersion") i zadziałała prawidłowo.

**ROZSTRZYGNIĘTE POWTÓRKĄ (2026-08-12):** współpraca **działa end-to-end**, a
awaria jest **NIEDETERMINISTYCZNA**. Ten sam scenariusz uruchomiony ponownie:
handoff powiódł się, architekt zaraportował dane z MCP (`typeVersion 4.6`,
`operation appendOrUpdate`, `googleSheetsOAuth2Api`, wymagane parametry),
zapisał artefakt walidacji (`art-5d52581c`), a w n8n powstał
**`Mastra - Webhook Email to Google Sheets`, `active=false`, 02:11:37** —
zweryfikowane w API n8n. Czyli inżynier **czasem** odpowiada bez wywołania
narzędzi MCP, a kontrakt to wyłapuje. Infrastruktura jest zdrowa.

**Diagnostyka dodana na przyszłość:** odrzucony handoff loguje teraz własne
dowody (`[n8n-mcp-handoff] REJECTED <kod> — <kształt odpowiedzi>`): ile kroków,
ile `toolCalls` na każdym, jakie typy części `content`, jakie klucze odpowiedzi.
Bez tego „inżynier nie wywołał narzędzi" i „ekstrakcja ich nie widzi" wyglądają
identycznie z zewnątrz — a to rozróżnienie kosztowało już dwa śledztwa przy
`findArtifactIds`.

**NIEROZSTRZYGNIĘTE (węższe):** dlaczego model raz woła narzędzia, a raz nie. To druga możliwość jest realna, bo ta
sama klasa błędu dwukrotnie pogrzebała `findArtifactIds` (odczyt faktu o runie
z obiektu, który framework może przekształcić). Sonda bezpośrednia nie przeszła —
agent wymaga storage z instancji Mastry, więc test musi iść przez serwer.
**To pierwszy krok następnej sesji.**

**🔴 DRUGI DEFEKT, NIEZALEŻNY — architekt złamał własną regułę fail-closed.**
Jego prompt mówi wprost: po nieudanym obowiązkowym handoffie „stop and report
`blocked` with `failureClass: mcp_handoff_failed`. Do not compose, deploy, test,
or activate". Zamiast tego skomponował workflow, zapisał go do pliku
`n8n_workflow.json` i wystawił „Raport końcowy" z tabelą węzłów. **Job zamknął się
jako `COMPLETED`, a w n8n nie powstało NIC** (zweryfikowane w API: najnowsze
workflow są z poprzedniego dnia). Deterministyczna bramka deployu zadziałała —
skłamała ETYKIETA joba i treść raportu.

**✅ NAPRAWIONE:** wynik runu jest teraz **anotowany faktem runtime'u**, gdy
obowiązkowy handoff padł: `[weryfikacja systemu] Obowiązkowy handoff do
n8nMcpEngineer NIE POWIÓDŁ SIĘ w tym runie…`, wraz z informacją, czy cokolwiek
zostało wdrożone. Anotacja, nie porażka — analiza w raporcie jest prawdziwa,
fałszywa jest tylko jej wymowa; a nieudana próba byłaby PONAWIANA, co przy
agencie z efektami ubocznymi powtarza akcję w świecie.

**Pułapka, którą to odsłoniło:** wszystkie czytniki w `mcp-handoff-state`
rozwiązują klucz przez `getHarnessExecutionContext()`, który istnieje **tylko
wewnątrz runu**. Kod komponujący wynik działa PO runie, więc widziałby zawsze
„brak awarii". Dodane `mcpHandoffFailedForRun(runId)` i
`automationDeliverableForRun(runId)` — odczyt po jawnym kluczu, dokładnie tak jak
`run-artifacts`. To ten sam błąd, który dwukrotnie pogrzebał `findArtifactIds`:
fakt o runie odczytywany z miejsca, które run już opuścił.
