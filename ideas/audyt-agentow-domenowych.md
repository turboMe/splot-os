# Audyt agentów domenowych — plan odhaczania

**Po co to jest.** Chef pod V2 oddawał niedokończoną pracę: 25 dań, **zero**
przepisów, projekt stanął na `recipes`, 8 z 8 workerów padło. Ta sama praca w
kontakcie bezpośrednim wychodziła kompletna. Po naprawie ten sam pipeline dowiózł
**26 dań / 26 przepisów / Księgę 47 KB / PDF w 23 minuty**.

Żadna z przyczyn nie była specyficzna dla chefa. Wszystkie mogą siedzieć u
pozostałych agentów — dlatego ten dokument. Idziemy agent po agencie i odhaczamy.

**Data:** 2026-08-19. **Referencja:** `ideas/chef-kompletnosc-pipeline-v2.md` (diagnoza źródłowa).

---

## Dwie zasady, o które w tym wszystkim chodzi

**Z1 — Agent z krokami wewnętrznymi wykonuje je SAM.**
Jeśli agent ma własny pipeline, lane nie ma prawa wyjąć z niego kroku i uruchomić
go osobno, bo uruchomi go z INNYMI założeniami niż pipeline agenta. Chef ma recon
jako fazę 2 swojej maszyny stanów; lane rozbijał to na `researcher → chef` i przy
okazji wycinał URL z zadania chefa — recon nigdy nie startował, w 20 z 20 zadań.
Nośnik zasady w kodzie: `AgentCard.runsInternally` + `repairPlanOwnership`.

**Z2 — Jakość wyniku sprawdzana według wymagań pipeline'u, w KODZIE.**
Pipeline chefa opisywał `qa_final` i „Phase-Exit Check". Oba były wyłącznie zdaniami
w prompcie — nic ich nie egzekwowało. Efekt: 5 z 10 ostatnich projektów `done` było
niekompletnych, jeden z nich to **63 dania i 0 przepisów**. Zdanie w prompcie to nie
brama. Brama to kod, który ODMAWIA.

> Kontrola, którą widać na dobrym przebiegu: krytyk zwrócił `verdict: "fix"`
> (powtórzenie techniki w trzech pastach), chef zapisał menu **v2**, dopiero potem
> przepisy — i `qa_final` → `render` → `done` przeszły po kolei. Tak ma wyglądać
> domknięcie.

---

## Dziewięć kontroli

Każda ma polecenie, kryterium zaliczenia i to, co pokazała u chefa.
**K1–K4b są darmowe** (źródło, baza, API dostawców) — wyczerp je do końca.
K5–K8 wymagają przebiegu i dopiero wtedy mają sens.

### K1. Czy modele agenta i jego workerów SĄ SERWOWANE i UŻYTECZNE
```bash
npm run probe:worker-presets
```
Zalicza, gdy każdy preset zwraca poprawny JSON. **U chefa: 3 z 5 presetów martwe** —
`fast` i `default` wskazywały modele Groq wycofane w sierpniu 2026 (manifest sam
ostrzegał: `decommission Aug 2026`), `reasoning` zwracał same białe znaki.
73% wszystkich workerów padało od 08-12. Zamienniki leżały gotowe w manifeście,
nikt nie przepiął presetów.

Uwaga: sprawdzenie listy modeli łapie model USUNIĘTY, nie zepsuty. OpenRouter nadal
ogłasza model, który oddaje pustkę — dlatego probe robi PRAWDZIWĄ generację.

### K2. Czy lane nie rozbija pipeline'u agenta (Z1)
```bash
grep -n "runsInternally" src/mastra/config/agent-board.ts
npm run check:lane-decider-model
```
Zalicza, gdy agent z własnym pipeline'em ma `runsInternally` wymieniające każdego
specjalistę, którego woła u siebie w środku, a `hardRules` w karcie mówią o
PODZIALE pracy, nie o prawie zapisu.
**Otwarte: `automationArchitect` jest agentem pipeline'owym i NIE MA `runsInternally`.**

### K3. Czy istnieje brama kompletności w kodzie (Z2)
```bash
npm run check:chef-completeness-gate     # wzorzec dla innych domen
```
Zalicza, gdy narzędzie zamykające projekt ODMAWIA zamknięcia przy niekompletnym
produkcie i wymienia, czego brakuje. U chefa `chef_set_project_status` przyjmowało
każde przejście, w tym `done`. Teraz odmawia i wypisuje dania bez przepisu.

Wzorzec do przeniesienia: `missingRecipeDishes()` w `src/mastra/tools/chef/chef-tools.ts`
— porównuje produkty deklarowane (dania z NAJNOWSZEJ wersji) z wytworzonymi (przepisy),
po nazwie znormalizowanej (NFC + trim + lowercase + spacje), bo krytyk potrafi
przemianować pozycję między wersjami.

### K4. Czy telemetria mówi prawdę
```javascript
// mongosh — ile wywołań „udanych" faktycznie zwróciło błąd walidacji
db.agent_events.find({type:"tool_called", timestamp:{$gte: OD}}, {input:1,toolId:1})
  .forEach(d => { if (String(d.input||"") === "{}") print("EMPTY ARGS: " + d.toolId); });
```
Zalicza, gdy odrzucenie walidacji ma `type: "tool_error"` i `status: "error"`.
**U chefa 145 kolejnych odrzuceń było zapisanych jako `success`** — dlatego defekt
był niewidoczny. Mastra ZWRACA błąd walidacji jako wynik narzędzia, więc
`span.errorInfo` jest puste; klasyfikator musi patrzeć na kształt wyniku
(`error === true && 'validationErrors' in result`).

### K4b. Czy sufit kroków pasuje do zestawu narzędzi (darmowe)
```bash
npm run audit:agent-limits
```
Mastra tnie na 5 krokach, gdy agent nic nie zadeklaruje — a harness może sufit tylko
PODNIEŚĆ do deklaracji agenta, nigdy obniżyć. Sprawdź, czy deklaracja starczy na
realną pracę: `crmAgent` deklaruje 5.

### K5. Czy pipeline przechodzi WSZYSTKIE fazy do końca
Po przebiegu:
```javascript
db.agent_events.find({timestamp:{$gte:OD}, toolId:"<domena>SetProjectStatusTool"},{input:1})
  .toArray().map(d => (String(d.input).match(/"status":"([a-z_]+)"/)||[])[1]).join(" → ")
```
Zalicza, gdy widać pełną ścieżkę do stanu końcowego, z fazą kontroli jakości w środku.
Dobry przebieg chefa: `recon → profile_synthesis → checkpoint_profile → menu_draft →
critic_gate → checkpoint_menu → qa_final → render → done`.

### K6. Czy produkt pokrywa deklarację
Zalicza, gdy każda zadeklarowana pozycja ma swój wytwór — liczone **po TOŻSAMOŚCI,
nie po liczbie**, i **względem najnowszej wersji**, nie pierwszej.

Dwie pułapki, obie zaliczone na żywo w tej sesji:

- **Licznik kłamie w obie strony.** Przebieg KOL dał 19 pozycji menu i 15 przepisów —
  wyglądało na brak czterech. W rzeczywistości menu miało 15 UNIKALNYCH dań; cztery
  pozycje występowały podwójnie (raz w menu degustacyjnym, raz à la carte), co jest
  normalną konstrukcją karty. Pokrycie było pełne. Porównuj zbiory nazw
  znormalizowanych, nigdy `count` do `count`.
- **`findOne` zwraca wersję dowolną.** Sumac miał 26/26, ale porównany do v1 wyglądał
  na niepokryty, bo krytyk przemianował danie w v2.

Normalizacja nazwy: `NFC + trim + lowercase + zwinięcie spacji`.

### K7. Czy sekcje dokumentu są WYPEŁNIONE, nie tylko obecne
```bash
python3 - <<'PY'
import re; t=open("<ścieżka>",encoding="utf-8").read()
for m in re.finditer(r'<!-- section:([a-z0-9:_-]+) start -->(.*?)<!-- section:\1 end -->', t, re.S):
    b=m.group(2).strip(); print(f"{m.group(1):<16}{len(b):>6}" + ("  <-- PUSTA" if len(b)<40 else ""))
PY
```
Zalicza, gdy żadna sekcja kanoniczna nie jest pusta. Sama obecność nagłówka nic nie
znaczy.

Gdzie szukać dokumentu (ten sam model zakotwiczonych sekcji):

| domena | narzędzia | katalog |
|---|---|---|
| chef | `chef_document_*` (+ `_pdf`) | `Jarvis-Projects/menu-books` |
| content | `content_doc_*` | `Jarvis-Projects/content-packs` |
| hunt | `hunt_doc_*` | `Jarvis-Projects/hunt-reports` |
| writer | `writer_document_*` (+ `_export`) | `Jarvis-Projects/writer-books` |

**`filmmakerAgent` i `musicianAgent` NIE mają dokumentu sekcyjnego** — ich produktem
są artefakty medialne. Dla nich K7 zamień na: czy zadeklarowane ujęcia/utwory mają
zapisany plik i artefakt (`media_ref`). Tu obowiązuje istniejąca brama
`npm run check:deliverable-capability` — agent deklarujący `media_ref` MUSI mieć
narzędzie, które zapisuje plik. Ta brama złapałaby lukę designu bez canary.

### K7b. Czy równoległe zapisy do dokumentu się nie gubią
```bash
npm run check:document-concurrency    # chef + content + hunt + writer
```
Zalicza, gdy batch równoległych zapisów sekcji ląduje w pliku W CAŁOŚCI.

**To NIE jest teoria — złapane na żywym przebiegu KOL.** Narzędzie
`*_doc_write_section` czyta cały dokument, wstawia swoją sekcję i zapisuje całość
z powrotem. Pipeline pisze karty batchami po 4-6 równolegle, więc wszyscy pisarze
startują z tych samych bajtów i przeżywa tylko ostatni:

| moment | zapisów równolegle | przetrwało |
|---|---|---|
| 19:39:20 | 5 | **1** |
| 19:40:00 | 5 | **1** |
| 19:41:02 | 1 (szeregowo) | **1** |

11 zapisanych kart → **3 w pliku**. Baza miała komplet 15 przepisów, dokument nie.
**Naprawione 2026-08-19** wspólnym `withDocumentLock` (`lib/document-write-lock.ts`)
w chef/content/hunt; writer miał własną serializację od początku i jako jedyny
przeżywa falsyfikację bez zmian.

### K7c. Czy dokument jest KOMPILOWANY na koniec
Zalicza, gdy narzędzie kompilujące (`chef_export_menu_book` i odpowiedniki) zostało
wywołane po ostatniej zmianie treści. Przebieg Sumac wywołał je 2×, przebieg KOL
**ani razu** — i dlatego jego Księga ma 12 KB zamiast ~45 KB, z pustymi sekcjami
`recipes`/`allergens`/`pairings`/`notes`, mimo kompletu przepisów w bazie.

> **Wniosek ogólny, najważniejszy w tym dokumencie:**
> **kompletność w bazie ≠ kompletność produktu.** Brama K3 sprawdza bazę i to jest
> dobre, ale niewystarczające. Do bramy trzeba dołożyć warunek na DOKUMENT —
> inaczej agent zamyka projekt jako `done`, mając komplet danych i wybrakowany
> deliverable. Dokładnie to zrobił KOL.

### K8. Czy produkt DOCIERA do użytkownika
```bash
curl -s -H 'x-resource-id: agent:metaFrontAgent' \
  "http://localhost:4111/v2/conversations/<CID>/projections?after=0"
```
Zalicza, gdy wiadomość końcowa niesie produkt albo ścieżkę/artefakt.
**U chefa NIE ZALICZA:** Księga, PDF i artefakt powstały, a rozmowa dostała samo
`„Zadanie … zakończone: COMPLETED."` — bez odnośnika. Produkt istnieje, ale użytkownik
go nie dostaje. To jest otwarte dla WSZYSTKICH domen.

---

## Tabela do odhaczania

Legenda: ✅ zaliczone · ❌ defekt · ⬜ niesprawdzone · — nie dotyczy

### Agenci z własnym pipeline'em (najwyższy priorytet — tu mieszka ta klasa błędów)

| agent | K1 modele | K2 lane | K3 brama | K4 telem. | K4b kroki | K5 fazy | K6 pokrycie | K7 sekcje | K7b równoległość | K7c kompilacja | K8 dostawa |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **chefAgent** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅⁴ | ✅⁵ | ✅⁶ | ❌ |
| contentAgent | ✅¹ | ⬜ | **❌³** | ✅¹ | ✅ | ⬜ | ⬜ | ⬜ | ✅⁸ | ⬜ | ⬜ |
| writerAgent | ✅¹ | ⬜ | **❌³** | ✅¹ | ✅ | ⬜ | ⬜ | ⬜ | ✅⁹ | ⬜ | ⬜ |
| huntAgent | ✅¹ | ⬜ | **❌³** | ✅¹ | ✅ | ⬜ | ⬜ | ⬜ | ✅⁸ | ⬜ | ⬜ |
| filmmakerAgent | ✅¹ | ⬜ | **❌³** | ✅¹ | ✅ | ⬜ | ⬜ | — | — | ⬜ | ⬜ |
| musicianAgent | ✅¹ | ⬜ | **❌³** | ✅¹ | ✅ | ⬜ | ⬜ | — | — | ⬜ | ⬜ |
| automationArchitect | ✅¹ | ❌² | ⬜ | ✅¹ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

¹ naprawa presetów i telemetrii jest GLOBALNA — dotknęła wszystkich. Wymaga jednak
potwierdzenia na przebiegu, bo każdy pipeline woła inne presety.
² agent pipeline'owy bez `runsInternally` — do rozstrzygnięcia, czy deleguje.
³ **zmierzone 2026-08-19, nie przypuszczenie:** żadna z pięciu pozostałych domen nie
ma bramy kompletności. Wszystkie przyjmują dowolne przejście, w tym końcowe —
dokładnie stan, w jakim chef ogłaszał `done` przy 63 daniach i 0 przepisach.
Narzędzia do przerobienia (wzorzec: `missingRecipeDishes` w `chef-tools.ts`):

| domena | narzędzie | plik |
|---|---|---|
| content | `content_set_project_status` | `tools/content/content-state-tools.ts:107` |
| writer | `writer_set_project_status` | `tools/writer/writer-tools.ts:236` |
| hunt | `hunt_set_run_status` | `tools/hunt/hunt-state-tools.ts:116` |
| film | `film_set_project_status` | `tools/film/film-project-tools.ts:94` |
| music | `music_set_project_status` | `tools/music/music-project-tools.ts:95` |

⁴ przebieg pinowany (Sumac) dał komplet sekcji; przebieg przez lane (KOL) zostawił
`recipes`/`allergens`/`pairings`/`notes` puste. Obie przyczyny naprawione (wyścig +
brama na dokument); **do ponownego dowodu na żywym przebiegu**.
⁵ naprawione + brama `check:document-concurrency`, sfalsyfikowana (bez blokady
ginie 5 z 6 sekcji).
⁶ **naprawione 2026-08-19**: brama `done` sprawdza teraz DOKUMENT, nie tylko bazę —
sekcje kanoniczne muszą być niepuste, a karty przepisów obecne w Księdze (czyli
`chef_export_menu_book` musi się wykonać). Sfalsyfikowane w
`check:chef-completeness-gate`: komplet w Mongo przy niewypełnionej Księdze = odmowa.
⁸ **naprawione 2026-08-19** wspólnym `withDocumentLock` (`lib/document-write-lock.ts`).
Sfalsyfikowane: bez blokady chef/content/hunt gubią 5 z 6 sekcji w batchu.
⁹ writer **miał własną serializację od początku** (`withWriterDocumentMutation`) —
jako jedyny przeżywa falsyfikację bez zmian. Objęty bramą, żeby refaktor tego cicho
nie usunął.

### Agenci bez pipeline'u (K1/K2/K4 i tak obowiązują)

| agent | K1 | K2 | K4 | uwagi |
|---|---|---|---|---|
| designAgent | ✅¹ | ⬜ | ✅¹ | `media_ref`; brama `check:deliverable-capability` |
| codingAgent | ✅¹ | ⬜ | ✅¹ | ciężki promień rażenia — pisze kod |
| researcherAgent | ✅¹ | — | ✅¹ | wołany wewnętrznie przez 6 pipeline'ów |
| knowledgeAgent | ✅¹ | ⬜ | ✅¹ | same odczyty |
| deliberationAgent | ✅¹ | ⬜ | ✅¹ | |
| analyticsAgent | ✅¹ | ⬜ | ✅¹ | model OpenRouter bywał zepsuty |
| crmAgent | ✅¹ | ⬜ | ✅¹ | efekt w świecie; **deklaruje 5 kroków** — sprawdzić, czy starczy na jego zestaw narzędzi |
| salesAgent | ✅¹ | ⬜ | ✅¹ | efekt w świecie |
| marketingAgent | ✅¹ | ⬜ | ✅¹ | |
| capabilitySmith | ✅¹ | ⬜ | ✅¹ | |
| codeReviewAgent | ✅¹ | — | ✅¹ | |
| securityReviewAgent | ✅¹ | — | ✅¹ | |
| performanceReviewAgent | ✅¹ | — | ✅¹ | |

---

## Ustalenia globalne — dotyczą każdego agenta

1. **Presety workerów naprawione** — `fast`→`gpt-oss-20b`, `default`/`reasoning`→`gpt-oss-120b`.
   Nowa brama: `npm run probe:worker-presets`. Uruchamiać po KAŻDEJ zmianie manifestu
   i okresowo — dostawcy wycofują modele bez uprzedzenia.
2. **Sonda dostępności modeli** sprawdza teraz konkretne id, nie samą osiągalność dostawcy.
   Wcześniej wycofany model u zdrowego dostawcy raportował `api_ok`.
3. **Telemetria** klasyfikuje zwrócony błąd walidacji jako `tool_error`.
4. **Bezpiecznik pętli** działa też bez listy fazowej i po wyczerpaniu budżetu refleksji
   (3 na przebieg — w pipelinie 150-krokowym wyczerpuje się wcześnie).

5. **Równoległe zapisy sekcji** serializowane w chef/content/hunt wspólnym
   `withDocumentLock` (`lib/document-write-lock.ts`); writer miał własną blokadę.
   Brama: `npm run check:document-concurrency` (wszystkie 4 domeny).
6. **Brama `done` chefa sprawdza produkt, nie tylko bazę** — sekcje kanoniczne
   niepuste + karty przepisów obecne w Księdze.

### Rzeczy OTWARTE (nie naprawione)

- **K8 dostawa produktu** — rozmowa dostaje status, nie produkt. Dotyczy wszystkich domen.
- **`chef_generate_menu` nadpisuje status na `generating`** — wartość spoza 11-stanowej
  maszyny (`chef-tools.ts:102`). Psuje wznawialność. Sprawdzić, czy inne domeny mają
  analogiczny zapis spoza własnego enuma.
- **Puste argumenty narzędzia** — model bywa niezdolny zserializować duży zagnieżdżony
  schemat za pierwszym razem. Zmierzone: 10 pustych wywołań, potem 5 poprawnych.
  Jest to **przejściowe**. Próg wykrywania odrzuceń walidacji podniesiony do
  2× `maxToolRepetitions` (12), czyli POWYŻEJ zaobserwowanego punktu wyjścia z pętli
  (~10), żeby bezpiecznik nie ucinał pracy, która zaraz by wylądowała. Do potwierdzenia
  pomiarem na drugiej domenie.
- **`insights` bez URL-i** — pipeline chefa żąda źródeł z URL, przebieg dał atrybucję
  bez linków.
- **Kanalizowanie faz** (`pipeline_phase_tools_applied`) odpala się wyłącznie dla
  `recon` i `menu_draft` — nigdy dla `recipes`, `qa_final`, `render`. Wygląda na
  martwe w późnych fazach.

---

## Zasady wydawania przebiegów

Przebieg to ~25 minut i realne pieniądze. **K1–K4 są darmowe — wyczerp je do końca,
zanim odpalisz cokolwiek.** U chefa całą diagnozę (5 przyczyn) postawiono bez ani
jednego przebiegu; przebieg służył wyłącznie POTWIERDZENIU.

- Pierwszy przebieg domeny: **pinowany** (`capability` w komendzie) — izoluje pipeline
  od routingu.
- Ostatni: **przez lane** (bez `capability`) — dopiero to jest droga użytkownika.
- Testuj na świeżym obiekcie. Baza jest współdzielona; powtórzona nazwa grozi
  podebraniem gotowego wyniku i fałszywym sukcesem.
- **Edycja pliku restartuje `mastra dev` i zabija job w locie.** Zmiany planuj między
  przebiegami.
