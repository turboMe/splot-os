# F7 — co zostało z migracji agentów

**Dla kogo:** osobna instancja. **Nie koliduje** z instancją domykającą F8 (patrz §6).
**Data zebrania faktów:** 2026-08-18. Wszystko poniżej **policzone w źródle**, nie
przepisane z planu — plan w kilku miejscach jest nieaktualny i mówi o stanie sprzed tygodnia.

> ⚠️ **Aktualizacja 2026-08-22 — ten dokument sam jest już nieaktualny w
> kluczowym miejscu.** Pełny audyt: `ideas/audyt-domena-coding-2026-08-22.md`.
> Zmierzone dziś, nie przepisane z planu:
> - §1 twierdzi „`orch_jobs` = 0, silnik V2 nigdy nie przetworzył ani jednego
>   zadania w produkcji" i „flagi cutoveru **nie wolno włączać**". Oba nieaktualne:
>   `FEATURE_ORCHESTRATION_V2_DELEGATION=true` i `..._AUTOMATION_JOBS=true` są
>   włączone od 2026-08-18 (decyzja właściciela, komentarz w `.env` to
>   potwierdza), a `orch_jobs` ma **70 dokumentów** (32 COMPLETED / 34 FAILED /
>   3 UNKNOWN_OUTCOME / 1 RECONCILING);
> - rozkład tych 70 po capability: `researcherAgent` 35, `chefAgent` 26,
>   `designAgent` 22, `writerAgent` 8, `contentAgent` 3, `analyticsAgent` 2,
>   `deliberationAgent` 1, `codingAgent` 1, `crmAgent` 1, 12 bez capability.
>   Większość z 34 porażek to jedno powtarzane zadanie `researcherAgent`
>   (scraping turdus.com.pl) — **nie** domena coding;
> - §3 (domena coding, 71/86) w dużej mierze nadal aktualne jako inwentarz, ale
>   „71 ✅" liczy dowody z KANARKÓW pod legacy, nie z ruchu V2 — codingAgent
>   przez V2 przeszedł raz;
> - `capabilitySmith` (I1, ścieżka BUILD) **nadal nieosiągalny z V2** — ani w
>   kodowym `DEFAULT_V2_CAPABILITIES`, ani w `.env` `ORCHESTRATION_V2_CAPABILITIES`
>   (świadomie, zmienia system). `capability_builds` w Mongo = 0 rekordów,
>   pod żadnym silnikiem ścieżka BUILD nigdy nie doszła do końca — zweryfikowane
>   dziś żywym testem, znaleziono i naprawiono jeden blokujący defekt
>   (`artifact_get` odrzucał artefakty bez `laneId`) i jeden podejrzany
>   (bramka zgody łapie słowo „sekret" niezależnie od realnego ryzyka).
>
> **Aktualizacja 2026-08-23 — obie podejrzane pozycje wyjaśnione i zamknięte,
> plus cała reszta domeny coding domknięta.** Pełny stan:
> `ideas/audyt-domena-coding-2026-08-22.md` §7. Skrót: bramka zgody
> naprawiona (nie tylko "podejrzana"), a prawdziwą przyczyną tego, że
> `codingAgent` nigdy nie kończył zapisu w delegacji CGP, był dwuznaczny
> komunikat systemowy tool-shelfa ("next step" czytane jako "zakończ turę i
> czekaj") — potwierdzone bezpośrednim testem, plik faktycznie powstał po
> naprawie. `capabilitySmith`/I1 pozostaje świadomie poza V2 (decyzja
> właściciela), ale ścieżka BUILD sama w sobie ma teraz komplet dowodów
> live po stronie legacy. Domena coding: 22/22 w grupach A+B, Z8 (jedyna
> domena bez bramy) domknięte, J7 (role subagentów) w pełni ożywione.

**Kryteria migracji:** `docs/MIGRACJA-AGENTA-NA-V2.md` (sito K1–K10 + protokół canary +
karta per agent). **Runbook:** `docs/PROMPT-MIGRACJA-AGENTOW-V2.md`. Przeczytaj oba.

---

## 1. Pełny obraz — 20 zdolności na Agent Board

Źródło prawdy to `src/mastra/config/agent-board.ts` (20 kart) i
`DEFAULT_V2_CAPABILITIES` w `src/mastra/config/capability-routing.ts:246`.

| # | Kategoria | Ile | Kto |
|---|---|---|---|
| 1 | **Włączone w V2** (zestaw domyślny) | **7** | `researcherAgent` `chefAgent` `contentAgent` `writerAgent` `analyticsAgent` `deliberationAgent` `crmAgent` |
| 2 | **Przez sito, ale NIEwłączone** — wstrzymane promieniem rażenia | **5** | `designAgent` `automationArchitect` `huntAgent` `marketingAgent` `knowledgeAgent` |
| 3 | **Domena coding — w trakcie** (71 z 86 pozycji) | **4** | `codingAgent` `codeReviewAgent` `securityReviewAgent` `performanceReviewAgent` |
| 4 | **Świadomie pominięty** (decyzja właściciela 2026-08-11) | **1** | `salesAgent` |
| 5 | **Nietknięte — zero śladu w planie** | **3** | `filmmakerAgent` `musicianAgent` `capabilitySmith` |

Poza boardem: `metaAgent` (front, osobny tor), `weatherAgent` (demo Mastry, zepsuty model),
sześć `producerHunt*` (subagenci `huntAgent`, jadą razem z nim).

### Kontekst, bez którego te liczby wprowadzają w błąd

Zmierzone dziś na produkcji: **`orch_jobs` = 0**. Silnik V2 nigdy nie przetworzył ani
jednego zadania w produkcji. „Włączone" z wiersza 1 znaczy „capability jest w zestawie
domyślnym routera", **nie** „przepływa przez to ruch". Flagi cutoveru są zakomentowane
(`.env`, linie 420–421) i **nie wolno ich włączać** — to decyzja właściciela.

Praktyczny wniosek: nie zakładaj, że coś działa, bo jest na liście. Kolumna „dowód"
wypełnia się po przebiegu na żywo, nie po implementacji.

---

## 2. Kolejność migracji — ustalona badaniem, nie preferencją

Legacy to **nie jedna ścieżka, tylko trzy**, i od tego zależy, czy V2 jest ulepszeniem
czy ryzykiem:

| ścieżka legacy | kto | V2 jest… |
|---|---|---|
| dedykowany harness | coding, automation, knowledge, review | ⛔ **gorsze** — V2 nie podaje `contextBuilder` |
| pipeline + reflektor | chef, content, hunt, writer, **film**, **music** | porównywalne |
| generyczna (gołe `agent.generate`) | design, analytics, crm, sales, marketing | ✅ wyraźnie lepsze |

**Stąd: najpierw ścieżka generyczna, na końcu dedykowany harness.**

---

## 3. Domena coding — 71 z 86, ale realnie do zrobienia jest 9

Inwentarz: `docs/MIGRACJA-DOMENY-CODING.md`, **86 pozycji w 12 grupach**. Policzone
dzisiaj po kolumnie „V2": **71 ✅ / 15 otwartych**. Z tych 15 tylko dziewięć jest pracą —
reszta to świadome nie-cele i rzeczy zablokowane faktem.

| gr | gotowe | otwarte |
|---|---|---|
| A. Nawigacja i czytanie kodu | 10 | A11 A12 |
| B. Pisanie kodu we własnym repo | 9 | B2 |
| C. Uruchamianie komend | 5 | — |
| D. Stan zadania | 3 | — |
| E. Recenzja kodu | 11 | — |
| **F. Merge i wdrożenie** | 4 | **F2 F3 F4 F7 F8 F9 F11** |
| G. Cykl samonaprawy | 6 | — |
| H. Projekty poza własnym kodem | 4 | H4 |
| I. Rozbudowa o nowe zdolności | 2 | I1 I3 |
| J. Delegacja i równoległość | 7 | J2 J7 |
| K. Pamięć, skille, uczenie się | 6 | — |
| L. Nadzór nad przebiegiem | 4 | — |

### Rozbiór tych 15 według znacznika

**🔧 w robocie — zaimplementowane, brak dowodu live (7). To jest praca.**

| poz | co | uwaga |
|---|---|---|
| A11 | LSP (`typescript-language-server`) | |
| A12 | indeks BM25 + `autoIndexPaths` | rozgrzewka indeksu zrobiona (24 374 fragmentów) |
| B2 | repair lane — długowieczny worktree `agentic-agents-repair` | |
| F2 | merge deterministyczny, bramkowany flagą albo zgodą człowieka | ⚠️ patrz §4 |
| F4 | blue-green: `build-candidate` → … → `promote` | ⚠️ **restartuje żywy serwer** |
| F9 | self-swap odłączony (`setsid`), przeżywa zabicie własnego procesu | ⚠️ **restartuje żywy serwer** |
| I1 | ścieżka BUILD: bramka specyfikacji → lane + claims → delegacja | |

**⬜ nietknięte (2).**

| poz | co | uwaga |
|---|---|---|
| F3 | tryb PR: push, PR, czekanie na CI, squash merge | **niesprawdzalne tutaj** — `GITHUB_PR_MODE` OFF, brak `gh` CLI, remote wskazuje starą nazwę repo. Wymaga decyzji właściciela |
| F7 | fallback lokalny | wykonalne |

**➖ świadomie poza zakresem (3):** F8 synchronizacja kanonu, F11 supervisor poza Mastrą,
I3 Capability Gap Protocol. **Nie otwieraj bez pytania.**

**⛔ zablokowane faktem/decyzją (3):** H4 osobny workspace per projekt, J2 równoległy
dispatch, J7 role subagentów z ograniczonym toolsetem. **Powód jest zapisany przy pozycji
w dokumencie — przeczytaj, zanim uznasz, że da się to ruszyć.**

---

## 4. Co masz zrobić — w tej kolejności

### Krok 1 — domknij domenę coding, zaczynając od nieinwazyjnych

**A11, A12, B2, I1, F7** — żadna nie restartuje serwera ani nie dotyka żywego kodu
produkcyjnego. Każda potrzebuje **dowodu z przebiegu na żywo**, nie implementacji: kolumna
„dowód" ma opisywać, co się realnie stało.

Pozostawienie domeny w połowie jest najgorszym stanem — legacy i V2 obsługują wtedy różne
podzbiory tej samej pracy.

### Krok 2 — F2, potem F4 i F9, ale dopiero po uzgodnieniu

**F2 (merge)** — właściciel wypowiedział się wprost i to jest granica uprawnień:

> *„merge jest za flagą, więc jeśli jest włączona, to agent może mergować zmiany z worktree
> do własnego kodu oraz używać blue-green, żeby się przełączać na nowy kod po testach —
> jeśli chodzi o autoheal lub pisanie własnych nowych narzędzi. A jeśli pracuje w nowym
> repozytorium poza swoim własnym kodem, to normalnie może commitować na utworzonym tam
> gicie."*

**F4 i F9 restartują żywy serwer.** W drzewie pracują inne instancje. **Zapytaj właściciela
przed pierwszym przebiegiem** i uprzedź, że serwer na chwilę zniknie.

### Krok 3 — trzy nietknięte agentki przez sito

`filmmakerAgent` i `musicianAgent` idą **ścieżką pipeline'ową** (V2 porównywalne) — te
dwie pierwsze. `capabilitySmith` **zmienia system**, więc na końcu i tylko za zgodą.

Każda przez pełne sito K1–K10 z `docs/MIGRACJA-AGENTA-NA-V2.md` + protokół canary.

### Czego NIE robisz

- **NIE włączasz nowych capability w `DEFAULT_V2_CAPABILITIES`.** Wiersz 2 z §1 jest
  wstrzymany świadomie: to agenci, którzy wydają pieniądze, piszą na zewnątrz albo
  zmieniają system. Włączenie każdego z nich to osobna zgoda właściciela na **konkretny
  efekt w świecie**, poparta canary.
- **NIE włączasz flag cutoveru** (`.env` 420–421).
- Nie otwierasz pozycji ➖ i ⛔ bez pytania.
- Nie ruszasz plików instancji F8 (§6).

---

## 5. Definicja ukończenia

- pozycje z kroku 1 mają **dowód z przebiegu na żywo** w `docs/MIGRACJA-DOMENY-CODING.md`,
  nie opis implementacji;
- każda nowa brama **sfalsyfikowana** — zepsuj kod, zobacz ✗;
- `bash scripts/check-all.sh` exit 0;
- `.env` w stanie zastanym;
- wpis w dzienniku `ideas/plan-dziecko-po-odlozeniu-g0.md` §6 z numerami commitów.

---

## 6. Jak nie wejść w drogę pozostałym instancjom

**Wszystkie instancje pracują w TYM SAMYM drzewie** `/projekty/mastra-agentic-environment/agentic-agents`.
To nie są osobne worktree.

**Pliki instancji F8 — NIE DOTYKAJ:**
```
src/mastra/scripts/f8-*.ts
scripts/f8-mongo-chaos.sh
src/mastra/orchestration/store/conversation-writer.ts
src/mastra/orchestration/store/attempts.ts
src/mastra/orchestration/store/txn.ts
docs/PROMPT-INSTANCJA-SILNIK-V2.md
docs/STATUS-AGENTOW-SILNIK-V2.md
```
Trzy pliki `store/` tamta instancja **celowo psuje i przywraca** przy falsyfikacji. Jeśli
zobaczysz je w `git status` w dziwnym stanie — to nie defekt, to trwająca falsyfikacja.

**Wspólne, z ostrożnością:** `package.json` i dziennik w planie §6 — dopisuj **jednym
ruchem i commituj od razu**, nie trzymaj rozgrzebanego pliku.

**Zawsze `git status --short` przed uznaniem czegokolwiek za swoje.**

---

## 7. Zasady pracy w repo

- **Node v22 obowiązkowo** (`nvm use v22.20.0`). Pod v20 serwer startuje, **nie nasłuchuje
  i nie loguje błędu** — wygląda jak zawieszenie bez przyczyny.
- Cała domena coding jedzie na **`deepseek-v4-pro`** (decyzja właściciela 2026-08-12), żeby
  „port jest zły" i „ten model nigdy by tego nie zrobił" nie były nierozróżnialne.
- Commituj **wyłącznie jawnymi ścieżkami**. **Nigdy `git add -A`.**
- **Po napisaniu asercji zepsuj kod i sprawdź, że widzisz ✗.** W poprzedniej sesji cztery
  asercje okazały się niezdolne do oblania — każda wyglądała rozsądnie. Brama, która nie
  potrafi oblać, jest dekoracją.
- **Zanim uznasz pustkę za defekt: policz wiersze bez filtra i przeczytaj sygnaturę w
  źródle.** Dziewięć „defektów" w jednej sesji okazało się błędami sondy — złe nazwy pól
  (`createdAt` vs `timestamp`), zła kolekcja (`harness_events` vs `agent_events`),
  niezainicjowany rejestr. Przy pisaniu tego dokumentu też: uznałem kill switch za
  niewpięty w V2, bo szukałem w `src/mastra/orchestration/`, a wpięcie jest w `index.ts`.
- **Mastra: `tools` — nazwą narzędzia w runtime jest KLUCZ obiektu**, nie
  `createTool({id})`. Ta pomyłka przeszła przez zielone testy pisane z wyobrażenia o
  kształcie odpowiedzi zamiast ze zrzutu.
- **Mastra tnie na 5 krokach**, jeśli agent nie deklaruje `maxSteps`. Poza harnessem to
  jedyny sufit.
- **Git tu mówi po polsku** — nie buduj logiki na angielskim wyjściu gita
  (`nothing to commit` nigdy nie wystąpi). Decyduj po kodzie wyjścia albo `--porcelain`.
