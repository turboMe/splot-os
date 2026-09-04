# Migracja agentów na silnik V2 — instrukcja wykonawcza

Pracujesz w `/projekty/mastra-agentic-environment/agentic-agents`.
Twoje zadanie: **przenieść kolejnych agentów na silnik orkiestracji V2, jednego po
drugim**, według wzorca, który przeszedł już przez pięciu agentów plus zbiorczy
przegląd siódemki domyślnej.

Ta instrukcja jest kompletna. **Nie improwizuj procedury** — jeśli czegoś tu nie
ma, to znaczy, że masz o to zapytać, a nie wymyślić.

---

## 0. Zasada nadrzędna, z której wynika cała reszta

> **Agent na V2 ma działać tak samo albo lepiej niż na legacy. Każda różnica
> in minus jest blokadą migracji, nie „drobiazgiem do poprawienia później".**

Drugi filar, równie ważny:

> **„Zbudowane i zielone" ≠ „wpięte".** Testy dowodzą, że kod robi to, co robi —
> nie że cokolwiek do niego dociera. **Każdy** dotychczasowy canary znalazł
> defekt, którego nie wyłapał żaden test. Zaplanuj, że Twój też znajdzie.

---

## 1. Co przeczytać, ZANIM dotkniesz kodu

W tej kolejności:

| plik | po co |
|---|---|
| `docs/MIGRACJA-AGENTA-NA-V2.md` | **sito K1–K11** + protokół canary + karty już zmigrowanych agentów |
| `docs/ORCHESTRATION-V2.md` | jak działa silnik (sekcje F6, F6B, F7) |
| `ideas/plan-dziecko-po-odlozeniu-g0.md` | dziennik: sekcja „F7 — AGENT 1/2…" — przeczytaj obie, to wzorzec Twojego wpisu |
| `src/mastra/config/agent-board.ts` | karty agentów = menu, z którego router wybiera |
| `src/mastra/config/capability-routing.ts` | co wolno routować, budżety, podłogi idle, `SIDE_EFFECT_PRODUCT_CAPABILITIES` |

**Nie zaczynaj od kodu. Zacznij od sita.**

---

## 2. Co „zmigrowany" znaczy, a czego NIE znaczy

| | |
|---|---|
| **Znaczy** | agent jest osiągalny jako capability V2, przeszedł canary na żywym zleceniu, a wszystkie jego zdolności działają nie gorzej niż na legacy |
| **NIE znaczy** | legacy przestaje działać. Legacy zostaje do etapu F9. V2 jest **równoległe**, za flagami, rollback = zdjęcie flagi |

**Dziś żaden agent nie ma odebranego ruchu legacy.** Produkcja jedzie na legacy,
bo flagi F6 są domyślnie wyłączone. Jeśli przeczytasz gdzieś „agent jest
przepięty", sprawdź, czy nie znaczy to tylko „jest w allowliście" — to dwie różne
rzeczy i mylenie ich jest kosztowne.

---

## 2b. Stan flag — co realnie jedzie, gdy odpalisz `npm run dev`

**Silnik V2 jest włączony tylko na JEDNEJ drodze wejścia.** To najczęstsze
nieporozumienie przy tym projekcie:

| droga | co się dzieje |
|---|---|
| czat z agentem w **Mastra Studio** | **legacy** — zwykły endpoint agentowy, bez durable joba i kontraktu headless |
| **`POST /v2/front/messages`** | **V2** — harness, lane orchestrator, durable job |
| delegacje w tle (meta → agent) | **legacy** (`FEATURE_ORCHESTRATION_V2_DELEGATION` wyłączona) |
| automatyzacje n8n (Golden Path) | **legacy** (`FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS` wyłączona) |

Silnik wypisuje to przy starcie — czytaj tę linię, zanim uznasz coś za defekt:

```
[orch-v2] worker profile: HARNESS | lane: AGENTIC | delegation: legacy (…) | automation: legacy (…)
```

**Flagi cutoveru (`_DELEGATION`, `_AUTOMATION_JOBS`) są w `.env` ZAKOMENTOWANE
świadomą decyzją właściciela: najpierw kończymy agentów, potem cutover.
NIE włączaj ich sam.** `FEATURE_ORCHESTRATION_V2_LIVENESS=true` jest włączona.

---

## 3. Czego wymaga nowy silnik od agenta

To jest lista rzeczy, które V2 robi inaczej niż legacy. **Znaj ją na pamięć,
zanim zaczniesz** — z niej wynikają wszystkie kryteria.

1. **Run jest bezludny.** Nikt nie czyta odpowiedzi w trakcie i nikt nie
   odpowie. **Ostatnia wiadomość runu jest zapisywana jako wynik** i to jedyne,
   co zobaczy użytkownik. Pytanie zamiast produktu = job zamknięty pytaniem
   w środku.
2. **Sufit kroków.** Mastra domyślnie tnie na **5 krokach**, gdy agent nic nie
   deklaruje. Harness ustawia własny profil (10/25/40). **Reguła w mocy: harness
   może PODNIEŚĆ sufit do deklaracji agenta, nigdy go poniżej niej obniżyć.**
3. **Liveness zamiast zegara.** Run jest cięty za **ciszę**, nie za długość
   pracy. Podłoga ciszy bierze się z `latencyClass` karty agenta.
4. **Wynik przez kopertę producenta.** Tryb `bounded_text` uznaje run za udany,
   gdy zwróci **niepusty tekst, który nie jest raportem frameworka**. Pusty
   wynik = `FAILED`. To celowe („no false success") — **nie rozluźniaj tego**.
5. **Agent może być KROKIEM sekwencji.** Następny krok dostaje 2000-znakowy
   urywek poprzednika **plus id artefaktów**, po których może pobrać całość.
6. **Pamięć jest inna, ale równoważna:** wątek `orch-v2-job:<jobId>` per job,
   **jeden** resource `orch-v2` dla całej linii (NIE per agent — przy per-agent
   delegacja wewnątrz runu wywalała się na „wrong resourceId"), a
   `memory_recall`/`memory_write` idą do tej samej globalnej kolekcji co legacy.
7. **Precontext domenowy** trzeba agentowi **jawnie przyznać** — patrz K3.

---

## 4. Sito — 11 kryteriów, każdy agent przechodzi wszystkie

Pełne opisy: `docs/MIGRACJA-AGENTA-NA-V2.md`. Skrót operacyjny:

| # | kryterium | jak sprawdzić |
|---|---|---|
| K1 | sufit kroków zadeklarowany i sensowny | `npm run audit:agent-limits` |
| K2 | da się zapisać deliverable | `npm run check:deliverable-capability` |
| K3 | precontext domenowy nie ginie | `npm run check:capability-precontext` |
| K4 | pamięć warstwowa równoważna | czytanie kodu — czy agent polega na ciągłości wątku między delegacjami (prawie żaden nie polega) |
| K5 | skille i wyszukiwanie narzędzi | `inputProcessors` są na agencie → przenoszą się same |
| K6 | delegacja do agentów i workerów | czy ma `delegateTaskTool` / `runWorkerTool` |
| K7 | nic nie czeka na człowieka | czy któreś narzędzie **blokuje** zamiast zwrócić stan |
| K8 | zależność zewnętrzna (MCP/sidecar) | `npm run audit:agent-readiness` (wykrywa import `../mcp.js`) |
| K9 | wynik konsumowalny przez następny krok | `npm run audit:agent-readiness` |
| K9b | **to, co agent zapisał, dociera dalej** | `npm run check:artifact-handoff` |
| K10 | **zgoda właściciela na efekt w świecie** | **pytasz człowieka** — patrz §5 |
| K11 | czy produktem agenta jest tekst | patrz niżej |

**K11 rozwinięte, bo to najświeższa i najkosztowniejsza pułapka:** tryb
`bounded_text` ocenia run po tekście. Agent, którego produktem jest **efekt
w świecie** (wdrożony workflow, wysłany mail, wpis w CRM), może wykonać całą
pracę i dostać `FAILED` — a wtedy **silnik uruchamia zadanie od nowa i akcja
w świecie może się powtórzyć**. Takie agenty są wypisane w
`SIDE_EFFECT_PRODUCT_CAPABILITIES` (`capability-routing.ts`) i dostają dodatkową
regułę domknięcia w kontrakcie headless. **Jeśli migrujesz agenta piszącego na
zewnątrz, sprawdź, czy jest na tej liście.**

---

## 5. ⛔ Granica, której NIE wolno Ci przekroczyć samodzielnie

Wszyscy pozostali do migracji agenci mają **ciężki promień rażenia**: pieniądze
(design/filmmaker/musician), zapis na zewnątrz (marketing/sales/hunt/knowledge),
zmiana systemu (coding/automationArchitect/capabilitySmith/n8nMcpEngineer).

**K10 to decyzja właściciela, nie audytu.** Zanim uruchomisz canary agenta:

1. **Zapytaj człowieka wprost**, nazywając KONKRETNY efekt:
   „błędna trasa wyśle maila z Twojego Gmaila", a nie „to pisze na zewnątrz".
2. **Poczekaj na wyraźną zgodę.** Brak odpowiedzi ≠ zgoda.
3. **Nie rozszerzaj zgody.** Zgoda na „deploy" nie obejmuje „aktywacji".
   Przy automationArchitect deployowaliśmy **nieaktywny** workflow właśnie
   dlatego — aktywacja to żywe wyzwalacze, czyli osobny efekt.
4. Zapisz w karcie migracji, **na co dokładnie** zgoda została udzielona.

---

## 6. Kolejność agentów i znane blokady

| # | agent | ścieżka legacy | efekt w świecie | stan |
|---|---|---|---|---|
| 1 | ~~`designAgent`~~ | generyczna | płatna generacja | ✅ zrobiony |
| 2 | ~~`automationArchitect`~~ | dedykowany harness | deploy n8n | ✅ zrobiony |
| 3 | ~~`huntAgent`~~ | pipeline | zapisy do CRM | ✅ zrobiony |
| 4 | ~~`marketingAgent`~~ | generyczna | Gmail, CRM, kalendarz, NotebookLM | ✅ zrobiony |
| 5 | ~~`salesAgent`~~ | agent UŻYTY JAK FUNKCJA w 3 workflow | Gmail, CRM, kalendarz | ⏸️ **POMINIĘTY świadomie** — właściciel przebudowuje domenę; patrz dziennik F7 w planie |
| 6 | ~~`knowledgeAgent`~~ | dedykowany harness | tworzy notatniki w Google użytkownika | ✅ zrobiony (K3 i K8 potwierdzone live) |
| 7 | `filmmakerAgent`, `musicianAgent` | pipeline | **płatna generacja** | najpierw suchy przebieg BEZ płatnej generacji; wymaga zgody |
| 8 | `codingAgent` | dedykowany harness | repozytorium | ⛔ K7: `requiresCodeCommandApproval` **zawiesza run**, a w tle nie ma komu odpowiedzieć — to osobna praca, NIE migracja |
| 9 | `capabilitySmith`, `n8nMcpEngineer` | — | zmieniają system | nieruszane |

**⭐ ZADANIE NR 1 DLA CIEBIE (nie migracja, tylko domknięcie pomiaru):**
`deliberationAgent` nie ma potwierdzonego dowiezienia pod V2. Okno klasy `long`
podniesiono do 1800 s, a instrukcję fazy propozycji zmieniono z „may run in
parallel" na nakaz wysłania wszystkich wywołań w JEDNYM kroku. Nikt tego nie
zmierzył. **To jest bezpieczny test — deliberation nie ma efektów w świecie.**
Sprawdź dwie rzeczy naraz:
1. czy job kończy się `COMPLETED` w oknie 1800 s;
2. czy w logu jest JEDEN krok z czterema wywołaniami `runDeliberationWorkerTool`,
   zamiast czterech kolejnych kroków po jednym.

Zlecenie, które trafia do tego agenta (sprawdzone): „Rozważ i podważ warianty:
dostawa własna czy przez agregator dla restauracji na 60 kuwertów? Oceń trade-offy
obu wariantów i rozstrzygnij, który wybrać. To jest dylemat do debaty, nie
research.

**Bierz w tej kolejności.** Jeśli chcesz ją zmienić, uzasadnij i zapytaj.

**Styl treści — reguła globalna, NIE per agent.** Zakaz myślnika em (U+2014)
i jego encji HTML obowiązuje w każdej treści dla człowieka. Żyje w JEDNYM
miejscu — `src/mastra/prompts/shared/house-style.md` — a `prompt-loader.ts`
dokleja go do instrukcji każdego agenta na obu silnikach. **Nie dopisuj tej
reguły do promptu migrowanego agenta**: wcześniej była powtórzona trzy razy
u writera i nieobecna u wszystkich pozostałych, przez co hunt wysłał myślnik
w temacie maila do skrzynki właściciela. Pilnuje tego `npm run check:house-style`.
Poczta wychodząca ma dodatkowo twardy filtr w `buildOutboundMime`
(`npm run check:outbound-mail`) — prompt to prośba, lejek to gwarancja.

**Uwaga do K3:** mechanizm jest gotowy (`capability-precontext.ts`), ale wpisy
mają tylko agenci po canary. **Wpis w rejestrze bez canary to deklaracja, nie
zdolność** — dodawaj go WYŁĄCZNIE razem z canary tego agenta.

---

## 7. Procedura — wykonaj dokładnie w tej kolejności

### Krok 1. Rozpoznanie (bez zmian w kodzie)

```bash
npm run audit:agent-readiness
npm run audit:agent-limits
```

Przeczytaj plik agenta w `src/mastra/agents/`, jego kartę w `agent-board.ts`
i sprawdź: `defaultOptions.maxSteps`, `inputProcessors`, listę narzędzi, importy
`../mcp.js`, czy ma `delegateTaskTool`/`runWorkerTool`, czy któreś narzędzie
blokuje w oczekiwaniu na człowieka.

### Krok 2. Baseline bramy

```bash
nvm use v22.20.0
npm run check:all
```

**Musi być zielone przed Twoją zmianą.** Jeśli nie jest — to nie Twoja zmiana
i masz o tym powiedzieć, a nie naprawiać po drodze.

### Krok 3. Domknięcie blokad z sita

Napraw tylko to, co sito wskazało. Każda naprawa = **jedno miejsce**, nie kopia:
jeśli fakt istnieje już gdzieś w kodzie, **importuj go**, nie przepisuj.

### Krok 4. Brama po zmianie

```bash
npm run typecheck
npm run check:all
```

### Krok 5. Zgoda właściciela (K10)

Patrz §5. **Nie przechodź dalej bez niej.**

### Krok 6. Canary na ŻYWYM zleceniu

```bash
nvm use v22.20.0
npm run build
ss -ltnp | grep :4111    # KTO trzyma port PRZED startem
```

Start serwera — **capability włączasz zmienną, NIGDY edycją
`DEFAULT_V2_CAPABILITIES`** (canary nie zmienia produkcji):

```bash
FEATURE_ORCHESTRATION_V2=true FEATURE_ORCHESTRATION_V2_LIVENESS=true FEATURE_ORCHESTRATION_V2_HARNESS_WORKER=true FEATURE_ORCHESTRATION_V2_LANE_ORCHESTRATOR=true ORCHESTRATION_V2_CAPABILITIES='researcherAgent,chefAgent,contentAgent,writerAgent,analyticsAgent,deliberationAgent,crmAgent,designAgent,automationArchitect,NOWY_AGENT' MONGODB_DB_V2=orchestration_v2_canary_NOWY node .mastra/output/index.mjs > /tmp/canary.log 2>&1 &
```

**Świeża baza V2 na każdy canary** (`MONGODB_DB_V2`) — worker jest SERIAL, stary
backlog zagłodzi nowy job i zmierzysz kolejkę zamiast swojej zmiany.

Zlecenie wysyłasz tak (**łatwo pomylić: nagłówek `x-resource-id`, pole `message`,
NIE `text`**):

```bash
curl -s -X POST http://localhost:4111/v2/front/messages -H 'Content-Type: application/json' -H 'x-resource-id: canary_x' -d '{"conversationId":"conv_1","message":"TUTAJ REALNE ZLECENIE"}'
```

**Zlecenie ma być prawdziwe i wąskie.** Jeśli agent może wydać pieniądze,
napisz w zleceniu jawny zakaz („NIE generuj obrazów ani wideo").

### Krok 7. Odczyt wyniku **Z BAZY**, nie z odpowiedzi frontu

Front potrafi zmyślić — jest na to osobny strażnik, ale nie ufaj mu jako
źródłu. Czytaj kolekcje w bazie `MONGODB_DB_V2`:

| kolekcja | czego szukasz |
|---|---|
| `orch_jobs` | `phase` = `TERMINAL`, `terminalOutcome` = `COMPLETED` |
| `orch_job_tasks` | ile zadań, jakie `phase`, jakie `capability` |
| `orch_job_attempts` | ile prób, `lifecycle`, `outcome` |
| `orch_execution_results` | `producer.status`, `producer.data.text`, **`producer.artifacts`** |

Skrypt odczytu **pisz w katalogu repo** (inaczej nie zobaczy `node_modules`)
i **skasuj go po użyciu**.

### Krok 8. Weryfikacja efektu W ŚWIECIE

Jeśli agent coś zmienił na zewnątrz — **sprawdź to u źródła, nie w odpowiedzi
agenta**. Przy n8n: `GET http://localhost:5678/api/v1/workflows` z nagłówkiem
`X-N8N-API-KEY` (klucz w `.env`). Przy CRM/Gmail: odpowiednia kolekcja/API.

### Krok 9. Sprzątanie

- zatrzymaj serwer canary (`kill <pid>` po `ss -ltnp | grep :4111`)
- usuń skrypty pomocnicze z repo
- **nie kasuj cudzych plików roboczych** — jeśli coś wygląda na odpadek, ale
  jest śledzone przez git, zapytaj

---

## 8. ✅ Kiedy wolno oznaczyć agenta jako ZMIGROWANEGO

**Wszystkie poniższe naraz.** Brak choćby jednego = migracja OTWARTA.

1. `npm run check:all` — **exit 0, zero błędów**. Dopuszczalne są wyłącznie te
   trzy opcjonalne pominięcia sterowane zmiennymi (porównaj z poprzednim
   zielonym logiem, muszą być identyczne):
   - `live check skipped (set RUN_AGENT_MEMORY_THREAD_LIVE=true)`
   - `5 skipped (abstract)`
   - `Optional N8N webhook smoke skipped`
2. Sito **K1–K11** domknięte albo **świadomie odnotowane** z uzasadnieniem.
3. Canary: `phase=TERMINAL`, `terminalOutcome=COMPLETED`.
4. **Wynik jest PRODUKTEM**, nie opisem produktu, nie pytaniem, nie raportem
   frameworka. Sprawdź `producer.data.text` **oczami**.
5. **Zero replanów z fałszywego powodu** — jeśli w `orch_job_tasks` jest więcej
   zadań niż plan zakładał, zrozum dlaczego, zanim uznasz sukces.
6. Efekt w świecie **zweryfikowany u źródła** (jeśli agent go wywołuje).
6b. **Raport agenta ZGADZA SIĘ z tym, co naprawdę się stało.** Policz obiekty
   u źródła PRZED i PO runie i porównaj z tym, co agent twierdzi. Zmierzone na
   huntAgencie: raport mówił „utworzono rekordy CRM" dla dwóch firm, a powstał
   jeden — druga leżała w bazie od maja i nie została tknięta. **Raport
   zawyżający jest gorszy niż awaria: wygląda jak sukces.**
7. **Brak duplikatu akcji** — jeśli agent działa na zewnątrz, policz obiekty
   u źródła. Jeden run = jeden skutek.
8. Zgoda właściciela (K10) **udzielona i zapisana** w karcie.

**Jeśli czegoś nie sprawdziłeś — napisz to wprost w karcie w polu
`NIEZWERYFIKOWANE`.** To jest wymagane, nie opcjonalne. Raport, który sugeruje
więcej, niż zostało sprawdzone, jest gorszy niż brak raportu.

---

## 9. Co zaktualizować po każdym agencie

| plik | co dopisać |
|---|---|
| `docs/MIGRACJA-AGENTA-NA-V2.md` §5 | **wypełniona karta migracji** (szablon w §4 tego samego pliku) |
| `ideas/plan-dziecko-po-odlozeniu-g0.md` | wpis `#### F7 — AGENT N: <id>` w sekcji F7 — **wzoruj się na wpisach AGENT 1 i AGENT 2**; oraz odhaczenie w tabeli postępu (sekcja „Dziennik postępu", wiersz `F7`) |
| `docs/ORCHESTRATION-V2.md` | **tylko** jeśli canary zmienił coś w silniku — opis mechanizmu i bramy |
| `docs/PROMPT-MIGRACJA-AGENTOW-V2.md` (ten plik) | jeśli canary dał nową regułę, dopisz ją do sita i do §8 |

**Karta migracji musi zawierać:** datę, wynik canary (job/tasks/attempts), co
canary złapał, i sekcję `NIEZWERYFIKOWANE`.

---

## 10. Reguły pracy, które w tym projekcie wyszły najdrożej

**1. Nie testuj przeciwko własnej atrapie.** Trzy razy z rzędu bug schował się za
test doublem. **Gdy test nazywa się od jakiejś logiki, ta logika MUSI się w nim
wykonać.** Atrapę stawiaj na granicy zewnętrznej (model, sieć), nie w środku
mechanizmu, który sprawdzasz.

**2. Pusty kontener wygląda identycznie jak kontener, którego nikt nie czyta.**
Kanał artefaktów był martwy dla KAŻDEGO runu w historii, bo caller liczył id
i je wyrzucał, a czytnik szukał złego pola. **Gdy sprawdzasz pole — sprawdź też,
kto je wypełnia.**

**3. Nie odzyskuj faktu o runie z obiektu, który framework może przekształcić.**
Zapisuj fakt w momencie zdarzenia. Dwie próby czytania id artefaktów z
odpowiedzi modelu poległy z dwóch różnych powodów.

**4. Gdy trzecia łatka nie działa — przestań łatać i DOMKNIJ MAPĘ.** Bariera
stopu miała cztery punkty obrony, a decydujący był pierwszy, nie ostatni.

**5. Mierz przed przełączeniem.** Podłoga ciszy była o 4% wyższa od realnej ciszy
chefa. „Zostawmy jak było" zabiłoby pracujące runy i wyglądałoby jak zawieszenie.

**6. Audyt, którego awarie wyglądają jak jego ustalenia, jest gorszy niż żaden.**
Zduplikowany odczyt `maxSteps` dał 18 fałszywych ustaleń naraz.

**7. Router widzi TYLKO to, co jest w menu — a menu to nie cała karta.**
`forDecider()` składa opis z `oneLiner` + kilku pierwszych `whenToUse` + kilku
`whenNotToUse`. Zdolność dopisana na końcu `whenToUse` zostanie **ucięta**, a karta
poprawiona „na papierze" nic nie zmieni. Sprawdzaj menu tak, jak widzi je model:
zbuduj rejestr i wypisz `forDecider()`.

**8. Agent w tle nie wie, jaki jest dzień.** Zmierzone: „przyszły tydzień"
wylądowało trzy miesiące wstecz, bo jedyną datą w zasięgu był przykład w opisie
narzędzia. Kontrakt headless podaje dziś datę, a narzędzia z datą odrzucają
przeszłość. **Nie wstawiaj konkretnych dat do opisów narzędzi** — model użyje ich
jako kotwicy.

**9. Sukces agenta to nie to samo co jego opowieść o sukcesie.** Zawsze licz
efekty u źródła przed i po. Trzy z trzech canary znalazły rozjazd między tym, co
się stało, a tym, co silnik albo agent o tym powiedział.

**10. Fail-closed na jakości jest nieproporcjonalny, gdy kosztem jest cały
deliverable.** `writerAgent` RZUCAŁ wyjątkiem na jednym myślniku: próba failed,
retry failed identycznie, job FAILED, użytkownik dostał zero — a nieudana próba
jest PONAWIANA, więc model płacił za regenerację całego tekstu. Zakaz był już
w jego promptach 3× i w regule globalnej, więc „poproś jeszcze raz" było
wyczerpane. Teraz normalizuje. **Pytaj: czy ta bramka chroni jakość, czy niszczy
pracę?**

**11. Czytaj `goal` joba, nie swoją wiadomość.** Meta Front PRZEPISUJE polecenie
użytkownika na cel joba, a router widzi ten cel. „Rozstrzygnij dylemat: dostawa
własna czy agregator" zostało przepisane na „Przygotuj analizę porównawczą modeli
dostaw" i trafiło do researchera — całkiem sensownie, bo to opis researchu.
Diagnozując błędną trasę, zacznij od `goal` w `orch_jobs`.

**12. Zegar nie jest już mechanizmem bezpieczeństwa.** Okno klasy `long` to
1800 s, ale zawieszenia wykrywa **cisza** (podłoga 480 s), niezależnie od okna.
Timeout przy dużej liczbie zdarzeń i krótkich przerwach = praca ucięta, NIE
zawieszenie. Sprawdzaj `activity gaps` w logu, zanim nazwiesz coś awarią.

**13. Pole autorytetu nigdy nie pochodzi z treści modelu.** `callerAgentId`
decydował o dostępie do wewnętrznego pomocnika, a przychodził jako argument
narzędzia — więc dowolny agent mógł się podszyć, a zapomnienie pola potrafiło
zabić całą budowę workflow. Tożsamość stempluje runtime z kontekstu wykonania.
Gdy widzisz bramkę porównującą coś, co wpisał model — to jest defekt, nie feature.

**14. Fakt o runie czytaj po JAWNYM kluczu, jeśli czytasz go PO runie.**
`getHarnessExecutionContext()` istnieje tylko wewnątrz runu; kod komponujący wynik
jest już poza nim i zobaczy „nic się nie stało". Wzorzec do skopiowania:
`run-artifacts` (`getRunArtifacts(runId)`) i `mcpHandoffFailedForRun(runId)`.
**Ten sam błąd wystąpił już trzy razy.**

**15. Brama nie może startować prawdziwej pracy, żeby czegoś dowieść.** Test
wołający `delegateTaskTool.execute` zawiesił `check:all` na 5 minut, bo narzędzie
ciągnie cały graf agentów. Wyprowadź DECYZJĘ do czystej funkcji i testuj ją.

**16. Jedna definicja, nie kopia.** Za każdym razem, gdy ten sam fakt żył w dwóch
miejscach, jedno z nich okazało się nieaktualne — i to zawsze wychodziło późno.

**17. Brama, która sama konstruuje swoje wejście, dowodzi KONSUMENTA, nie
producenta.** `check:multi-step-plan` budował decyzję `plan_steps` ręcznie
i podawał ją do store'u: 17 asercji na zielono, a **żaden prompt w systemie nie
wymieniał tej decyzji**, więc przez cały czas od zamknięcia F6B nic jej nie
tworzyło i każdy job jechał jako pojedyncze zadanie. Dokładnie ten sam kształt co
martwy kanał artefaktów i nieosiągalny liveness — **trzeci raz**. Pytanie
kontrolne przy każdej bramie: *czy w produkcji cokolwiek wytwarza to wejście?*
Jeśli odpowiedź wymaga zgadywania, dopisz asercję po stronie producenta (u nas:
„czy `plan_steps` jest w promptcie") i **sprawdź, że oblewa przed poprawką** —
`git stash` na zmienionych plikach, przebieg bramy, `git stash pop`.

**18. Liveness nie widzi WNĘTRZA wywołania narzędzia.** Watchdog mierzy przerwę
między zdarzeniami, a zdarzenia padają na granicach kroków. Narzędzie, które
pracuje dziesięć minut w jednym wywołaniu, jest dla niego **nieodróżnialne od
zawieszenia** — zmierzone: `code_search` na zimnym cache'u embeddingów ściął
trzy próby z rzędu, zero wyniku, job FAILED, a licznik chunków rósł przez cały
czas. Jest na to `touchCurrentRunLiveness()` i **nie miał ani jednego
wywołującego**, aż do tej naprawy. Gdy dokładasz narzędzie, które może pracować
dłużej niż podłoga ciszy: niech zgłasza postęp W PĘTLI (nie raz przed nią)
**oraz** ogranicza porcję pracy na jedno wywołanie. Sama pierwsza połowa
zamienia awarię w bardzo długi run; sama druga zostawia ciszę.

**19. Sprawdź GRANULARNOŚĆ, nie tylko obecność.** Legacy „task" nie musi znaczyć
tego samego co V2 „task". W domenie coding jeden `taskId` przechodzi przez cały
workflow (diagnose → patch → review → merge), a na V2 to jest **JOB**: każdy krok
sekwencji ma własne zadanie z własnym id. Zakres oparty na kroku dałby recenzentowi
inny worktree niż autorowi — i objaw byłby myląco niewinny: „brak worktree" dla
pracy, która istnieje. Gdy przenosisz cokolwiek, co niesie identyfikator jednostki
pracy, zapytaj: **czym jest jednostka pracy po obu stronach?**

**20. Jeden agent może mieć DWA tryby o przeciwnych regułach.** `codingAgent`
pracuje nad własnym kodem (repo read-only, worktree, allowlista komend, blue-green
z canary) **albo** nad nowym projektem (`/projekty/agent-projects/*`: bez worktree,
bez canary, dowolne komendy, wolne commity). Przenoszenie tylko jednego trybu
wygląda na ukończone, dopóki ktoś nie zleci tego drugiego. Wybór trybu bywa
**wyłącznie promptowy** — nie szukaj flagi, sprawdź prompt.

**21. `undefined` w spreadzie KASUJE, nie pomija.** `{...kontekst, ...zArgumentów}`
z `agentId: undefined` po prawej wymazuje prawdziwe `agentId` z lewej — a łańcuch
fallbacku prowadzi gdzieś, gdzie nikt nie patrzy. Zmierzone: wszystkie wywołania
narzędzi RECENZENTA zapisały się w telemetrii jako `codingAgent`. Nic nie padło,
i dlatego to drogie: psuje zapis „kto co zrobił", z którego czyta każda późniejsza
diagnoza. **Gdy budujesz metadane ze scalania źródeł, pomijaj klucze bez wartości
zamiast wpisywać `undefined`.**

**22. Narzędzia zewnętrzne SĄ PRZETŁUMACZONE — nie podejmuj decyzji na ich
prozie.** Git na tej maszynie odpowiada po polsku: `nic do złożenia, drzewo
robocze czyste`. Dwie wysłane decyzje sprawdzały angielskie `nothing to commit`
i `not registered`, więc były tu fałszywe **zawsze**, a jedna z nich była
zepsuta również po angielsku (git mówi `is not a working tree`, co nie pasuje do
żadnego z wzorców). Typy się zgadzają, testy przechodzą, a zachowanie jest złe
tylko na maszynie, która to uruchamia — recenzent czyta angielskie zdanie w
swoim języku i się z nim zgadza. **Decyduj z kodu wyjścia albo z `--porcelain`;
gdy musisz czytać prozę, przypnij `LC_ALL=C` w miejscu wywołania.** Brama:
`check:git-locale-independence`.

**22b. Gdy znajdziesz jedną instancję pułapki lokalizacyjnej, PRZESZUKAJ RESZTĘ.**
Pierwsza była w `coding_apply_patch`. Grep wyciągnął drugą (sprzątanie worktree,
zepsutą też po angielsku) i — przez wariant REGEXOWY, którego pierwszy grep nie
łapał — dwie kolejne w ścieżkach merge'a autohealu i samorozbudowy, gdzie
`/conflict/i` nie łapie polskiego `KONFLIKT`. Ta trzecia i czwarta były
najgroźniejsze: `git merge --abort` nigdy nie leciał, więc żywe repo zostawało w
niedokończonym merge'u ze znacznikami konfliktu, a komentarz nad kodem obiecywał
dokładnie odwrotnie. **Rozszerz bramę o wariant regexowy, nie tylko `includes()`.**

**26b. Sprawdź, czy TEST jest w ogóle uruchamiany.** `test-error-collector.ts`
przechodził 14/14 i nie było go ani w `package.json`, ani w `check:all`. Ten sam
wzorzec „zbudowane i zielone ≠ wpięte", tylko zastosowany do narzędzia, które ma
ten wzorzec wyłapywać. **`grep` nazwy pliku w `package.json` i `check-all.sh`
zanim uznasz obszar za pokryty.**

**27. Optymalizacja kosztowa nie ma wstępu na ścieżkę naprawczą.** Router
autohealu wybierał modele regułą „prefer local if VRAM available (cost = 0)", z
jedynym filtrem w postaci złożoności szacowanej przez sam model. Naprawy kodu
robił model 12B, worktree wychodził pusty, a drabina eskalacji odpowiadała
**innym modelem lokalnym** (12B → 11B). Oszczędność pozorna: naprawa, która nic
nie produkuje, kosztuje cały cykl i zostawia defekt. **Pytaj o ROLĘ pracy, nie o
jej deklarowaną trudność** — i domyślnie kieruj nieznane na model mocny.

**28. Zadanie, które się skończyło, musi ZWOLNIĆ zasób.** Ticket autohealu
zamykał wyłącznie udany merge; każde inne zakończenie zostawiało `in_progress`
na 24 h, a ten stan liczą dedup, limit aktywnych i podgląd operatora naraz.
Trzy nieudane naprawy = system martwy, raportujący trzy naprawy „w toku". **Gdy
stan blokuje kolejne próby, wypisz go w KAŻDEJ ścieżce wyjścia, nie tylko w
szczęśliwej** — i ustawiaj „w toku" PRZED pracą, żeby śmierć procesu zostawiała
prawdę.

**29. Sprawdź, czy PĘTLE UCZENIA widzą V2.** `recordDistillationCandidate` miał
dwóch wywołujących — legacy `delegate-task.ts` i ścieżkę build — a trwała
orkiestracja żadnego. Nic nie padało; korpus po prostu przestawał rosnąć w miarę
przenoszenia pracy na V2, i nieobecność widać dopiero miesiącami później. **Przy
każdej migracji grepuj, czy ścieżka V2 woła to, co woła legacy po sukcesie.**

**30. Hook, który dostaje JEDEN agent, to nie jest hook.** Wpiąłem liczniki
destylacji w `onStepObservation` istniejący tylko dla `writerAgent` — run
codingAgenta z 19 wywołaniami narzędzi raportował `toolCalls=0`, a asercje bramy
były zielone, bo dowodziły podpięcia do hooka, którego ten agent nie dostawał.
**Zanim wpniesz się w istniejący hook, sprawdź, KOMU jest podawany.** I dołóż
linię diagnostyczną: „brak wyniku" i „hak nie zadziałał" wyglądają identycznie.

**31. Brama nie może pisać do produkcyjnych danych uczących.** 86% korpusu
destylacji (1114 z 1290) stanowiły fikstury bram — 918 kopii jednego celu
smoke-testowego, po jednej na każde `check:all`. Obie bramy MIAŁY listy
sprzątające, tylko żadna nie znała tej kolekcji, bo listy powstały wcześniej niż
zapis. **Gdy dokładasz zapis do jakiejkolwiek ścieżki, przejrzyj sprzątanie
KAŻDEJ bramy, która tę ścieżkę uruchamia.**

**32. Gdy decyzja ma DWÓCH producentów, przypięcie jednego nie jest
przypięciem.** Router przypina naprawy do mocnego modelu — a `findOfflineFallback`
niezależnie wybierał *„cloud error → cheapest local"*, więc jeden 429 oddawał
naprawę modelowi 4B. **Po każdej zmianie reguły wyboru grepuj, kto jeszcze
wybiera to samo.**

**33. Zanim uznasz, że agent zmyślił — sprawdź, czy telemetria mówi prawdę.**
Delegacja `codingAgent → researcherAgent` zapisała się pod `meta-agent`
(`callerAgentId` ma `.default(META_AGENT_ID)`, a blok telemetryczny nie używał
resolvera). Wyglądało to na wymyśloną delegację; kosztowało śledztwo. Podobnie
`system_run_worker` pisze do `agent_events` z polem **`timestamp`**, nie
`createdAt` — zapytanie po złym polu daje „zero wywołań" dla narzędzia, które
wykonało 52 zdarzenia. **Zweryfikuj sondę kontrolą: policz wiersze BEZ filtra,
zanim uwierzysz w pustkę.**

**34. „Nie znalazłem" to nie to samo co „nie ma".** `graphify_affected`
odpowiadał `0 nodes depend on X` dla symbolu ze stopniem 396, bo CLI wypisuje
`No unique node match` na stdout z kodem 0, a parser widział zero krawędzi. W
narzędziu do analizy wpływu to najgroźniejszy kształt porażki — mówi „można
zmieniać, nic od tego nie zależy". **Rozróżniaj brak wyniku od nieudanego
zapytania, i wykrywaj to po NAGŁÓWKU SUKCESU, nie po treści błędu.**

**35. Zapis bez `upsert` do dokumentu, którego nikt nie tworzy, jest no-opem.**
`appendToCheckpoint` robił `updateOne({taskId}, …)` bez upsert, a jedyny writer z
upsertem miał zero wywołań — checkpoint nigdy nie powstawał, więc agent działał
bez pamięci między krokami, bez jednego błędu. **Testuj PIERWSZY zapis, nie
kolejny: ginie właśnie ten.**

**36. Zanim uznasz pustkę za defekt, sprawdź sygnaturę w źródle.** W jednej turze
cztery razy pomyliłem nazwę pola, kolekcji albo parametru (`createdAt` vs
`timestamp`, `pending_messages` vs `pending_user_messages`, `targetAgentId` vs
`agentId`). Za każdym razem „narzędzie nie działa" okazywało się „sonda pyta o
coś innego". **Pisz bramy jako round-trip przez PRAWDZIWE funkcje zapisu i
odczytu — nie odtwarzaj zapytań z pamięci.**

**37. Napisałem asercję, która NIE MOGŁA oblać — sprawdź swój helper.** Helper
`check` w bramie był SYNCHRONICZNY, a ja podałem mu callback `async`. Odrzucenie
promisy nigdy nie trafiało do `catch`, więc test drukował ✓ niezależnie od
wszystkiego. Wykryte dopiero eksperymentem wprost (sabotaż zmieniał zachowanie,
a brama dalej świeciła na zielono). **Po napisaniu asercji ZAWSZE zepsuj kod i
zobacz ✗ — jeśli nie widzisz, testujesz nic.**

**38. Recenzja bezpieczeństwa opłaca się natychmiast — uruchom ją na WŁASNYM
świeżym kodzie.** `securityReviewAgent` dostał `one-time-permit.ts` napisany tego
samego dnia i wydał BLOCK z dwoma trafnymi zarzutami: zgoda nie była wiązana z
akcją (approval na maila autoryzowałby merge do żywego repo) i „dokładnie raz"
obowiązywało per konsument, nie globalnie. Obu nie zauważyłem, pisząc ten kod.

**23. Tekst od modelu w poleceniu powłoki to polecenie, nie tekst.**
`promisify(exec)` odpala `/bin/sh -c`. Wiadomość commita napisana przez model
była wklejana między cudzysłowy do `git commit` uruchamianego w repozytorium, z
którego ten system działa. Wygląda jak szczegół formatowania i to jest dokładnie
ta właściwość, która czyni to groźnym. **Wszystko, co dotyka żywego repo, idzie
wektorem argumentów (`execFile`), nigdy linią poleceń.**

**24. Reguła autorytetu, która blokuje kontynuację, jest niepełna.** „Run
wygrywa" chroni przed identyfikatorem wymyślonym przez model — ale operacja
bramkowana człowiekiem Z DEFINICJI przechodzi przez DRUGI job (buduj i zapytaj →
człowiek zatwierdza → scal). Podziel regułę po tym, co narzędzie robi:
**tworzenie** bierze zakres z runu, **operacja na istniejącej pracy** honoruje
jawny identyfikator, a autorytet przenieś na permit — związany z zadaniem, jakie
człowiek widział, nie z dowolną gałęzią, którą nazwie późniejszy run.

**25. Cicha korekta produkuje pewny siebie fałszywy raport.** Gdy nadpisujesz
to, co podał model, **powiedz mu to w WYNIKU narzędzia**, nie w logu serwera.
Zmierzone: run przekierował zapis do własnego worktree (słusznie), narzędzie
odpowiedziało „success", a agent poprosił człowieka o zatwierdzenie scalenia
gałęzi, na której jego pliku nie było. Nic nie padło. Zgoda ma milczeć, różnica
ma mówić.

**26. Asercja czytająca ŹRÓDŁO sprawdza kształt, nie zachowanie.** Napisana
przeze mnie brama na „pusty merge nie kłamie" przeszła bez zmian, gdy wyłączyłem
strażnika przez `if (false && …)` — bo szukanego tekstu w kodzie nie ubyło.
Wydziel decyzję do funkcji i wywołaj ją naprawdę. Asercje na źródle zostaw dla
**kolejności** i dla zakazów („to już nigdy nie ma wrócić") — i strip'uj wtedy
komentarze, bo inaczej brama trafia w prozę tłumaczącą poprawkę.

---

## 11. Pułapki środowiska (oszczędzą Ci godzin)

- **Node v22 obowiązkowo** (`nvm use v22.20.0`). Pod v20 serwer startuje,
  **nie nasłuchuje i nie loguje błędu**.
- **Sprawdź port 4111 PRZED startem** — może go trzymać cudzy proces.
- **Nie ubijaj serwera w trakcie próby** — praca wznawia się przy boocie, ale
  backlog rośnie.
- **Druga sesja może pracować w tym samym drzewie.** Zrób `git status --short`
  przed uznaniem bramy za wiarygodną. Commituj **wyłącznie jawnymi ścieżkami**
  (`git add <plik>`). **NIGDY `git add -A`** — raz zagarnęło to cudzą pracę.
- `check:all` sam podnosi efemeryczny replica set na :27018; `REQUIRE_RS=1`
  zamienia pominięcie w błąd.

**Diagnostyka, którą masz w logu serwera:**

| linia | znaczenie |
|---|---|
| `[Harness] Depth: fast\|standard\|deep\|critical (score=…)` | jaki profil dostał run |
| `[Harness] step ceiling raised to the agent's own N` | K1 zadziałało |
| `[Harness] activity gaps: … maxGap=…s` | najdłuższa cisza w trakcie pracy |
| `[orch-v2] run produced no deliverable — …` | **KTÓRY kandydat na wynik został odrzucony** |
| `[artifacts] <id> was stored OUTSIDE any harness run` | zapis, którego żaden job nie odda jako wyniku |
| `[meta-front] reply promised a notification it cannot send` | front obiecał coś, czego nie zrobi |

---

## 12. Jak raportować

Po każdym agencie napisz człowiekowi:

1. **co zadziałało** — z liczbami z bazy, nie z wrażeń;
2. **co canary złapał** — mechanizm, nie objaw;
3. **czego NIE sprawdziłeś** — wprost;
4. **czy agent jest zmigrowany** wg listy z §8, i jeśli nie — czego brakuje.

**Nie pisz, że coś przeszło, jeśli tego nie widziałeś w bazie albo u źródła.**
