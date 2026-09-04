# Prompt startowy: instancja porównująca agentów legacy ↔ V2

> Skopiuj wszystko poniżej linii jako pierwszą wiadomość do nowej instancji.

---

Pracujesz w `/projekty/mastra-agentic-environment/agentic-agents`.

## Twoje zadanie: pilnować JAKOŚCI, nie tego czy „działa"

Druga instancja (ta, z której przychodzisz) rozwija **silnik** durable orchestration V2 i przepina
na niego kolejnych agentów. Ty zajmujesz się czymś innym i równie ważnym: **czy agent przepięty
na V2 dowozi tę samą klasę pracy co w legacy.**

To rozróżnienie kosztowało nas już kilka rund. Canary sprawdzały, czy job **dowozi produkt**.
Okazało się, że produkt potrafi się pojawić, a jakość zniknąć — i żaden test tego nie widział,
bo to nie jest błąd kodu.

**Najbardziej pouczający przykład (i wzorzec, którego szukasz):** `contentAgent` dowoził Content
Pack, w którym wypełnione były **2 sekcje z 8**. Przyczyną nie był bug, tylko **kolizja
human-in-the-loop z trybem headless**: `content/pipeline.md` ma HARD CHECKPOINT mówiący
*„present this to the user and end the turn awaiting go-ahead"*. W runie w tle **nie ma komu
zatwierdzić**, więc agent zatrzymywał się na zawsze — po myśleniu, przed pracą, dla której domena
istnieje. Ta sama kolizja była u `chefAgent` (`checkpoint_profile`, `checkpoint_menu`) i jest
jeszcze u `huntAgent` (nietknięta — hunt nie jest capability V2).

Naprawa **rozróżnia, czego checkpoint pilnuje**: `content/checkpoint_review` bramkuje `ship`
(zapis draftów + przypomnienia w kalendarzu = skutki POZA dokumentem) i **nadal zatrzymuje**;
reszta produkuje dokumenty, nie konsekwencje, więc idzie dalej i zapisuje założenia.

**Szukaj tego samego kształtu u pozostałych agentów.**

## Co konkretnie masz porównać

Stan przepięcia: **8 capability osiągalnych przez V2** (`ORCHESTRATION_V2_CAPABILITIES` w `.env`):
`researcherAgent` (domyślny), `chefAgent`, `contentAgent`, `writerAgent`, `analyticsAgent`,
`deliberationAgent`, `crmAgent`, `designAgent`.

⚠️ **W sensie cutoveru przeniesionych agentów jest ZERO.** V2 jest addytywne — legacy nadal
obsługuje cały ruch produkcyjny (`void executeDelegation`). To pozwala Ci porównywać obie ścieżki
na tym samym agencie.

Dla każdego agenta ustal:

1. **Jaki był pipeline w legacy** — workflow (`src/mastra/workflows/`), kolejność kroków,
   deterministyczne bramki. Przykład: legacy `weekly-content.ts` ma kroki `research-week` →
   `generate-pl` → `translate-en` → `save-drafts` → `create-reminders`. Krok `generate-pl`
   **faktycznie produkuje treść** — a agent V2 zatrzymywał się przed jego odpowiednikiem.
2. **Czy V2 wykonuje te same kroki** — czy któryś wypadł, i dlaczego (checkpoint? budżet?
   brak narzędzia? sufit kroków?).
3. **Czy jakość jest ta sama** — nie „czy plik powstał", tylko czy to ta sama robota.

**Znane wątki i następne prace:**
- **`writerAgent`** — **CZTERY PRÓBY LIVE ZBADANE 2026-08-10; nie powtarzaj ich bez nowej hipotezy.**
  Krótka forma miała 1159 słów i dobrą jakość, ale bez pętli wielu perspektyw. Pierwsza długa
  forma dowiodła utraty pełnego briefu oraz czerwonej jakości. Post-fix długa forma dowiodła,
  że bramka `done` działa fail-closed, ale 15-minutowe okno nie mieści pełnego
  chronicler→critic→reader→polisher.

  Izolowany canary earned-time na porcie `:4114` i bazie
  `writer_canary_earned_20260810_040826` nie był rolloutem. Job
  `job_e41e3729-4dc2-4af6-a828-3a8b97473059` zakończył się `FAILED` po 1494 s, lecz poprawnie
  zarobił dokładnie dwa rozszerzenia po 5 minut za snapshoty v2/v4; v3/v5 zostały
  zdeduplikowane. Eksport ma pięć rozdziałów i 4760 słów, bez U+2014/encji HTML. Domena nadal
  nie przeszła: klucz z niebieską nicią został ujawniony w rozdziale 3 zamiast dopiero 4,
  independent critic dał `72/false`, a projekt poprawnie pozostał w `render` po odrzuceniu
  `done`. Canary ujawnił też narzędzia startujące po terminalizacji.

  **Te luki zostały domknięte deterministycznie, bez drugiego live canary.** Harness ma processor
  Mastry blokujący faktyczne `tool.execute` po abort; regresja realnego dispatchu ma kontrolę
  ujemną (ten sam spóźniony call wykonuje zapis bez fence) i dodatnią (fence blokuje zapis).
  Dotychczasowe processory meta-agenta są zachowane przy dołączaniu fence.
  `run_worker` przekazuje abort, nie dziedziczy globalnego Workspace i rethrowuje cancellation
  przed końcową telemetrią. Gateway klasyfikuje hard cap i idle timeout jako `deadline`.

  Recenzje critic/reader/polish wymagają teraz zaufanego requestu z
  `writer_prepare_worker_review`, dokładnie tego samego canonical whole-snapshot taskSpec oraz
  jednorazowego receipt związanego z niezmienionym outputem. Request/receipt niosą
  `contractRevision`; każda zmiana brief/style/sections/continuity/sources/claims monotonicznie
  zwiększa `reviewRevision`, więc stary wynik traci władzę. Także audyty deterministyczne zapisują
  się tylko przy zgodnym `expectedReviewRevision`. Dla section/continuity/source/claim bump rewizji
  i zależny zapis są jedną transakcją Mongo, bez widocznego stanu pośredniego.

  Claim receiptu, insert audytu, project/manuscript/review fence i inkrementacja `auditRevision`
  są jedną transakcją. Każdy `WriterAudit` dostaje monotoniczną per-project sekwencję; latest
  wybiera `auditRevision`, a nie sam timestamp. Nowszy czerwony wynik blokuje starszy zielony,
  a bieżący red lub unauthorized green cofa `done` do `revision`. Finalne `done` ma CAS na
  manuskrypcie, `reviewRevision` i `auditRevision`.

  `writer_revision_decision` dostaje snapshoty before/after, aktywuje wybrany albo przywraca
  poprzedni, a nierozwiązana najnowsza decyzja blokuje `done`. Full project nie może ominąć tego
  audytu przez `saveAudit=false`, audyt musi wskazywać bieżący `currentManuscriptId`, a score
  dotyczy wybranego snapshotu. Full quality gate wymusza `deliverableLanguage` projektu i
  `minSlopScore >= 80`. ID section/source/claim nie może zostać przeniesione do innego projektu,
  a wartości atomowego patcha projektu są zapisywane przez `$literal`, nie wykonywane jako
  wyrażenia Mongo. Save/activate snapshotu transakcyjnie zmienia flagi current, target i
  `project.currentManuscriptId`/status; brak celu lub niezgodny `matchedCount` wycofuje całość i
  zachowuje poprzedni current. Invalidate pointera i flag current też jest jedną transakcją.
  Numer snapshotu jest rezerwowany w transakcji przed ścieżką `vNNNN`. Dodatkowy kompatybilny pełny,
  nie-partial unique `{projectId:1,version:1}` współistnieje ze starym descending non-unique
  `{projectId:1,version:-1}`. To zmiana kodu bez tworzenia/migracji indeksu na żywej bazie.

  Selection snapshotu i wymagany revision audit commitują razem ze statusem `revision`, zanim
  treść jest synchronizowana do pliku; błąd insertu audytu rollbackuje selection. Potem file-only
  `writerDocumentSyncSelectedSnapshot` zapisuje `manuscript.md` bez drugiego `markCurrent`/DB
  write. Błąd pliku zostawia `revision` i mismatch fail-closed. Completion pobiera latest revision
  niezależnie od top-100. Integration test przypina unresolved revision za 100 nowszymi audytami,
  rollback selection przy wymuszonym błędzie insertu, różne wersje dla równoległych snapshotów
  oraz niezmieniony `auditRevision` po file sync. **Hard Brief Invariants** w promptach stawiają
  jawny brief ponad sugestiami recenzenta.

  Targetowane checki tych ścieżek są zielone. **Nie uruchamiaj kolejnego płatnego canary tylko po
  to, by powtórzyć stary wynik.** Poprawki nie mają jeszcze świeżego dowodu live, więc pełnego
  parytetu Writera ani rolloutu produkcyjnego nadal nie ma. Niekooperująca obietnica providera
  może później się rozwinąć, ale nie uruchomi już opakowanego narzędzia; przymusowe zakończenie
  samego obliczenia wymagałoby osobnej izolacji procesu.
- **`chefAgent`** — dowozi Księgę Menu i **realnie używa** bazy przepisów (`chef_recipe_library`,
  8664 przepisy) oraz audytu molekularnego FlavorDB (biegnie automatycznie wewnątrz
  `chef_generate_menu`, agent nie może go pominąć). **Ale** nazwy składników są nieznormalizowane
  (`'ziemniaków'`, `'szczypta zmielonej kolendry'`, `'kuchnia chińska'` — to kuchnia, nie
  składnik), przez co coverage FlavorDB = 0,429 w probie, średnio 0,592 w bazie, 29% przepisów
  poniżej 0,5. **Normalizacja jest robiona w OSOBNEJ sesji — nie duplikuj jej.**
- **`designAgent`** — zweryfikowany jakościowo (obejrzany render: realna robota projektowa,
  zero placeholderów, zero zewnętrznych zasobów gdy zlecenie tego wymagało).
- **`analyticsAgent`** — decyzję o persistence/signals i docelowym kształcie V2 świadomie
  odłóż do rozmowy z użytkownikiem po zamknięciu bieżących poprawek. Nie deklaruj parytetu legacy.
- **`deliberationAgent`, `crmAgent`** — dowożą produkt, jakości nikt nie porównywał z legacy.

## Jak testujemy (wzorzec, który się sprawdził)

**Canary na ŻYWYM ruchu, na świeżej bazie, bez ubijania serwera.**

```bash
nvm use v22.20.0                      # ⚠️ patrz sekcja o Node niżej
npm run build
FEATURE_ORCHESTRATION_V2_LIVENESS=true \
  MONGODB_DB_V2=orchestration_v2_<twoja-nazwa> \
  node .mastra/output/index.mjs &
```

Zlecenie idzie przez Meta Front (nieblokujący):

```bash
curl -s -X POST http://localhost:4111/v2/front/messages \
  -H 'Content-Type: application/json' -H 'x-resource-id: user:test' \
  -d '{"conversationId":"t1","message":"<zlecenie>"}'
```

**Wynik czytaj Z BAZY, nie z odpowiedzi frontu** (`orch_jobs`, `orch_job_tasks`,
`orch_execution_results` w `MONGODB_DB_V2`):

```bash
mongosh --quiet "mongodb://localhost:27017/<db>?replicaSet=rs0" --eval '
db.orch_jobs.find({}).toArray().forEach(j=>print("OUTCOME="+j.terminalOutcome));
db.orch_execution_results.find({}).toArray().forEach(r=>{
  const t=(r.producer&&r.producer.data&&r.producer.data.text)||"";
  print(r.status+" len="+t.length);});'
```

**Zasady, każda kupiona bólem:**
1. **Świeża baza na canary.** Worker jest SERIAL — stary backlog zagłodzi nowy job i zmierzysz
   kolejkę, nie swoją zmianę.
2. **Nie ubijaj serwera w trakcie próby.** Praca wznawia się przy boocie (trwałość działa), ale
   backlog rośnie z każdym podejściem.
2b. **SPRAWDŹ, KTO TRZYMA PORT 4111, ZANIM ZLECISZ CANARY.** Ta pułapka sfałszowała mi wynik
   testu: uruchomiłem nowy serwer, stary wciąż nasłuchiwał, więc **żądanie poszło do STAREGO**
   i job wylądował w cudzej bazie — a pierwsza próba padła na `connection … to 127.0.0.1:27017
   closed`, czyli na walce procesów o Mongo, nie na wadzie agenta. Cztery procesy naraz biły się
   też o blokadę `mastra.duckdb`. Przed startem:
   ```bash
   ss -ltnp | grep :4111            # kto trzyma port
   ps -eo pid,ppid,etime,args | grep "[i]ndex.mjs"
   ```
   Po starcie potwierdź, że baza z `MONGODB_DB_V2` naprawdę dostaje joby — jeśli jest pusta,
   trafiłeś do innego serwera.
3. **`check:all` musi być zielone (48 pozycji) przed commitem.** Uwaga: `check:dashboard-orchestration`
   **bywa flaky, gdy serwer chodzi** (walczy o połączenia Mongo) — jeśli padnie, zatrzymaj serwer
   i powtórz; przechodzi w izolacji.
4. **Patrz na TREŚĆ dokumentu, nie tylko na długość wyniku.** Content Pack „istniał" mając 2 z 8
   sekcji. Księga Menu „istniała", a job commitował 581 znaków narracji.

**Przydatna diagnostyka, którą już masz w logu serwera:**
- `[Harness] activity gaps: agent=… maxGap=…s events=… mode=…` — najdłuższa cisza w trakcie pracy
- `[orch-v2] run produced no deliverable — …` — mówi, KTÓRY kandydat został odrzucony
- `[artifacts] … stored OUTSIDE any harness run` — zapis nieprzypisany do runu
- `[meta-front] reply promised a notification it cannot send` — front obiecał push, którego nie ma

## ⚠️ Node v22 — obowiązkowo

Build wymaga wersji z `.nvmrc` (**v22.20.0**). Pod **v20 serwer startuje, kończy boot i NIE
NASŁUCHUJE — bez żadnego błędu w logu.** To wygląda jak zawieszenie i kosztowało pół sesji.

W repo jest obejście: `scripts/with-node.sh` (używane przez wszystkie skrypty `npm run check:*`),
ale **przy ręcznym uruchamianiu serwera lub skryptów `npx tsx` musisz pamiętać sam**:

```bash
nvm use v22.20.0     # albo: bash scripts/with-node.sh <komenda>
node -v              # oczekiwane: v22.20.0
```

Jeśli serwer „wstał", a `curl http://localhost:4111/dashboard/orchestration/jobs` nie odpowiada —
**najpierw sprawdź `node -v`**, zanim zaczniesz szukać błędu w kodzie.

## Gdzie czytać

| co | gdzie |
|---|---|
| **plan pracy** (bieżący, z dziennikiem) | `ideas/plan-dziecko-po-odlozeniu-g0.md` — sekcja „⭐ NASTĘPNE KROKI" |
| **opis silnika V2** | `docs/ORCHESTRATION-V2.md` |
| karty agentów (menu routera) | `src/mastra/config/agent-board.ts` |
| co wolno routować | `src/mastra/config/capability-routing.ts` |
| kontrakt trybu headless | `src/mastra/orchestration/execution/headless-contract.ts` |
| pipeline'y domenowe | `src/mastra/prompts/<domena>/pipeline.md` |
| workflowy legacy (do porównania) | `src/mastra/workflows/` |

## Podział pracy

- **Ty:** porównanie legacy ↔ V2 per agent, jakość, brakujące kroki pipeline'u, kolizje
  checkpointów z trybem headless. Zgłaszaj znaleziska jako poprawki promptów domenowych
  (`prompts/<domena>/pipeline.md`) + bramka w `check:<domena>-domain`.
- **Druga instancja:** silnik (liveness, budżety, cutover F6, dashboard jako command client,
  kolejne capability).

**Nie ruszaj** `src/mastra/orchestration/**` bez uzgodnienia — tam pracuje druga instancja.
Twój teren to `prompts/`, `tools/<domena>/`, `scripts/check-<domena>-domain.ts`.

## Jedna zasada ponad innymi

Ta sesja złapała pięć osobnych awarii jednej klasy: **„zbudowane i zielone" ≠ „wpięte"**. Testy
były zielone, bo pisane z *wyobrażenia* o kształcie danych, a nie ze *zrzutu*. Kiedy więc coś
sprawdzasz — **weź prawdziwy zrzut** (dokument, odpowiedź, log) i buduj test z niego. A gdy trzecia
naprawa tego samego objawu nie działa, przestań poprawiać naprawę i **sprawdź, czy agent w ogóle
ma czym wykonać zadanie**.
