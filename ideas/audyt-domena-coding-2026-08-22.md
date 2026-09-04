# Audyt domeny coding + capability smith — 2026-08-22

**Dla kogo:** odpowiedź na pytanie właściciela „czego brakuje po przejściu na V2".
**Metoda:** żadna liczba poniżej nie jest przepisana z planu — wszystko odczytane
z `.env`, Mongo (`agentforge`, `orchestration_v2`) i `git log` w dniu audytu.
Źródła planistyczne: `docs/MIGRACJA-DOMENY-CODING.md` (86 pozycji, grup A–L) i
`ideas/f7-co-zostalo-z-migracji-agentow.md` (podsumowanie 18.08). **Oba
nieaktualizowane od 18.08** — ten dokument mierzy rozjazd i go zamyka w
nagłówkach obu.

---

## 0. Najpierw: oba dokumenty źródłowe kłamią o stanie `.env` i ruchu

| twierdzenie dokumentu (18.08) | stan zmierzony dziś (22.08) |
|---|---|
| „flagi cutoveru zakomentowane, nie wolno ich włączać" | `FEATURE_ORCHESTRATION_V2_DELEGATION=true` + `FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS=true` — **włączone 18.08, decyzja właściciela** (komentarz w `.env` to potwierdza) |
| „`orch_jobs` = 0, V2 nigdy nic nie przetworzył" | **70 jobów** w `orchestration_v2.orch_jobs`: 32 `COMPLETED`, 34 `FAILED`, 3 `UNKNOWN_OUTCOME`, 1 zawieszony w `RECONCILING` |
| „domena coding: 4 agenty w trakcie, niewłączone w V2" | wszystkie 4 (`codingAgent`, `codeReviewAgent`, `securityReviewAgent`, `performanceReviewAgent`) są w `ORCHESTRATION_V2_CAPABILITIES` (16 agentów łącznie, `.env:414`) |
| `GITHUB_PR_MODE` OFF | `=true` w `.env:362` — ale `gh` CLI nadal nie istnieje na maszynie, więc F3 i tak niesprawdzalne |
| `FEATURE_FILE_ACTIVITY_LEDGER` domyślnie wyłączona | `=true` w `.env:235` |

**Pułapka do zapamiętania:** „agent jest na liście `ORCHESTRATION_V2_CAPABILITIES`"
≠ „agent jest sprawdzony ruchem". Rozkład 70 jobów po capability:

```
researcherAgent   35
chefAgent         26
designAgent       22
writerAgent        8
(brak capability)  7
(cap: null)         5
contentAgent        3
analyticsAgent      2
deliberationAgent   1
codingAgent         1   ← przez cały V2 przeszło JEDNO zadanie codingu
crmAgent            1
```

34 porażki to niemal wyłącznie `researcherAgent` na jednym zadaniu (scraping
turdus.com.pl, powtarzane). CodingAgent ma za sobą jeden przejazd — statystycznie
nic o nim nie wiadomo z ruchu produkcyjnego; to, co wiadomo, pochodzi z kanarków
opisanych w `MIGRACJA-DOMENY-CODING.md` i z Testu B w tej sesji.

---

## 1. Praca w oddzielnym repo (grupa H, `MIGRACJA-DOMENY-CODING.md`) — 5/5 gotowe

| poz | stan | co dokończyć |
|---|---|---|
| H1–H3, H5 | ✅ | tworzenie projektu z gitem, zapis ze strażnikiem ucieczki (Z36 naprawione), dowolna komenda w projekcie, lista projektów |
| **H4** | ✅ **NAPRAWIONE 23.08** (`352b46d`) | Martwy `Workspace` (LSP, sandbox, bramka zgody) usunięty z `getOrCreateExternalProject` — zero konsumentów w `src/`, izolacja i tak stała na 3 strażnikach ścieżek. `check:external-project-isolation` i `check:external-project-mode` przechodzą bez zmian — dowód, że gwarancje izolacji nigdy nie zależały od usuniętej części |
| — | ✅ **NAPRAWIONE 23.08** (`08d821b`) | `repoPath` precontextu wskazywał na własne repo agenta nawet dla projektów zewnętrznych. `repoPathForCodingDelegation()` w `delegate-task.ts` teraz wysyła `''` (nie `undefined`, bo `??` w `coding-harness.ts`/`async-delegation.ts` inaczej cicho przywróci domyślną wartość) gdy brief jednoznacznie wskazuje `/projekty/agent-projects/` lub `createExternalProject(`. `check:coding-delegation-repo-path` (7 asercji) dowodzi obu kierunków |

---

## 2. Indeksy repo i praca na plikach (grupy A + B) — 22/22 gotowe ✅

| poz | stan | co dokończyć |
|---|---|---|
| A1–A10 | ✅ | mapa AST/PageRank, statystyki indeksu, reindeks, outline, wyszukiwanie semantyczne, graf zależności (Z31 naprawione), workspace read |
| **A11** | ✅ **DOWÓD LIVE 23.08** | `check:workspace-lsp` — realny `typescript-language-server` wystartowany na żywo, hover zwrócił prawdziwą sygnaturę + JSDoc dla `resolvePhaseTools`, definition trafił w realny plik. Falsyfikacja: przesunięta linia → hover padł, przywrócona → zielone |
| **A12** | ✅ **DOWÓD LIVE 23.08** | `check:workspace-bm25` — realny BM25 na wycinku `src/mastra/config` zwrócił trafny chunk z `pipeline-phase-tools.ts`. **Zmierzone przy okazji:** pełny `codeWorkspace.init()` (autoIndexPaths = cały `src/mastra`, 3099 plików, ~657 MB) przekracza 3 min — za wolne na rutynową bramkę, stąd test na mniejszym realnym wycinku, nie na pełnej konfiguracji produkcyjnej |
| B1, B3–B10 | ✅ | worktree per zadanie, zapis śledzony, ledger zmian, cofanie/zatwierdzanie, usuwanie worktree, blokada zapisu do live repo, sprzątanie sierot, bramka pustego worktree |
| **B2** | ✅ **DOWÓD LIVE 23.08** | `ensureRepairLane()` wywołane bezpośrednio na realnym lane (był zastały na commicie z 09.08, ~2 tygodnie). 126 ms: HEAD lane'u zresetowany na realny HEAD głównego repo, branch `autoheal/repair` zachowany, drzewo czyste po `clean -fdx`, `.env` zachowany |

---

## 3. Blue-green (grupa F) — **7/11 gotowe (F2/F4/F9 dowiezione 2026-08-23)**

To jest miejsce, gdzie „prawie gotowe" najbardziej myli: cała ścieżka
build→start→verify przechodzi na żywo, ale **kończyła się tuż przed
przełączeniem** aż do 2026-08-23 — patrz dopisek w sekcji 7 poniżej za
szczegółami dowodu.

| poz | stan | co dokończyć |
|---|---|---|
| F1 | ✅ | merge worktree→live przez narzędzie agenta, pełna pętla z człowiekiem, dowód live 17.08 (5 defektów Z14–Z18 wyciągniętych i naprawionych) |
| **F2** | ✅ **DOWÓD LIVE 23.08** | merge deterministyczny w workflow (`mergeWorktreeToLive()`, brama `confirmMerge`) — pełny `repoMaintenanceWorkflow` przez realne HTTP, HEAD żywego repo `afd1f4e→f5a36787`, zweryfikowane `git log`/`git show`. Przy okazji **Z38** (recenzja po fallbacku modelu, 0 tool call, `decisionGate` czyta stary werdykt) — **✅ naprawione tego samego dnia** (`runReviewAndGetVerdict()` + `check:review-verdict-freshness`, `c5fcb0f`) |
| **F3** | ⬜ | **tryb PR** (push gałęzi → PR → czekanie na CI 5 min → squash merge → usunięcie zdalnej gałęzi) — kod istnieje (`services/github.ts`, `pr-body-builder.ts`), `GITHUB_PR_MODE=true`, ale **brak `gh` CLI** na maszynie i remote wskazuje starą nazwę repo. Wymaga decyzji właściciela + `gh auth login` |
| **F4** | ✅ **DOWÓD LIVE 23.08** | blue-green pełny cykl (`build-candidate → start-candidate → verify-candidate → promote-candidate → canary-watch 120s → mark-promoted`) przez `scripts/autoheal/run-deploy.sh`, commit `afd1f4e`, `:4111` faktycznie serwuje nowego kandydata (PID 615714). Przy okazji naprawiony realny bug w `capability-build.ts` (`realPromote()` bez `start-candidate.sh`) + nowa brama `check:capability-build-promote-sequence` |
| F5, F6 | ✅ | rollback deterministyczny, ponowienie nieudanego wdrożenia — oba `npm run autoheal:test:*` exit 0 |
| **F7** | ⬜ | fallback lokalny (`local-fallback.sh`) — skrypt istnieje, nieuruchamiany, bo przełącza Live |
| F8 | ➖ | synchronizacja kanonu — świadomie OFF |
| **F9** | ✅ **DOWÓD LIVE 23.08** | self-swap odłączony (`setsid`, przeżywa zabicie własnego procesu) — ta sama ewidencja co F4 (nie osobny przebieg): kandydat `PGID=SID=615714` (lider własnej sesji), `PPID=6297`=`systemd --user`, łańcuch wzywający już nie istniał gdy to sprawdzono |
| F10 | ✅ | dry-run bez przełączania Live — uruchomiony 17.08, exit 0, Live :4111 nietknięty |
| F11 | ➖ | supervisor poza Mastrą — infrastruktura, nie agent |

### F3 — czy warto włączać? (pytanie właściciela 23.08, odpowiedź poniżej)

**Co to jest:** zamiast dzisiejszego mechanizmu (worktree → zgoda w
dashboardzie → lokalny `git merge`), F3 pchałoby branch na GitHub, otwierało
prawdziwy PR, czekało na CI, i robiło squash-merge przez GitHuba.

**Do czego by się przydało:** normalny workflow code review — widoczna
historia na GitHubie, prawdziwe CI zamiast tylko lokalnego `check:all`,
łatwiejsze komentowanie/przeglądanie zmian pisanych przez AI, ślad audytowy
poza tym serwerem.

**Rekomendacja: NIE włączać teraz.** To głównie system autonomiczny,
jednoosobowy, samohostowany — dzisiejszy lokalny merge + zgoda w
dashboardzie jest **szybszy i nie zależy od sieci/GitHuba/kolejki CI**, a to
akurat ma znaczenie dla ścieżki autohealu: czekanie na zewnętrzne CI mogłoby
zablokować naprawę systemu, który akurat naprawia siebie. Do tego brakuje
`gh` CLI i remote wskazuje starą nazwę repo — wymaga pracy porządkowej,
zanim cokolwiek ruszy. Warte rozważenia dopiero, jeśli dojdzie drugi
człowiek do reviewowania zmian, albo pojawi się potrzeba widoczności na
GitHubie niezależnie od dashboardu.

---

## 4. Capability Smith (grupa I)

| poz | stan | co dokończyć |
|---|---|---|
| **I1** | 🔧 | ścieżka BUILD 7-krokowa (spec → lane+claims → delegacja → `tsc`+`check:all` w worktree → merge → promote za zgodą → rejestracja) — **kompletna i obramkowana**: `check:capability-build-gates` i `check:capability-build-lease` zielone bez LLM. Live zweryfikowana 22.07 **pod legacy**. **Z V2 nieosiągalna**: `capabilitySmith` nie jest ani w kodowym `DEFAULT_V2_CAPABILITIES`, ani w `.env` `ORCHESTRATION_V2_CAPABILITIES` (świadomie wyłączony — zmienia system, decyzja właściciela) |
| I2 | ✅ | jednorazowe zezwolenie (CAS), rozróżnia `already_used`/`pending`/`wrong_task` |
| I3 | ➖ | CGP jako całość — świadomie poza zakresem tego dokumentu (inny agent) |
| I4 | ✅/🔴 | destylacja skilli wpięta i dowiedziona live 17.08. **Konsument (`skill:nightly`) nie był planowany do dziś** — patrz N3 niżej, zamknięte w tej sesji |

**Zweryfikowane w tej sesji (Test A + Test B, żywy agent, nie sonda):**

- **Test A (FIND/STANDARD, bez zależności od codingAgenta)** — ✅ zdrowy. 3
  materialnie różne zapytania `mcp_discover` dla luki OCR/PDF, zero kandydatów,
  Smith **odmówił fabrykowania** `capabilityId` i zaraportował uczciwy `BLOCKED`
  zamiast fałszywego sukcesu. Zapisał realny `decision_memo`.
- **Test B (DEEP/BUILD)** — dwa przebiegi:
  - **Run 1**: zablokowany na `artifact_get` (patrz N1) — codingAgent nie mógł
    odczytać specu, 3/3 próby padły identycznie, agent zaczął (błędnie) grepować
    dysk zamiast Mongo.
  - **Run 2, po naprawie N1**: `artifact_get` naprawiony, codingAgent **trzykrotnie
    zdelegowany**, raz realnie utworzył worktree/branch
    (`task-delegation-1a685b86-…`), ale **w żadnej z 3 prób nie zapisał ani
    jednego pliku** — ugrzązł na wewnętrznej bramce zgody codingAgenta
    („awaiting explicit approval" / „blocked on approval"). Smith **poprawnie
    rozpoznał pustý diff i odmówił wywołania `capabilityBuildTool`**, żeby nie
    zarejestrować nieistniejącej capability jako `built/shadow`. Zapisał
    diagnozę do pamięci (`failure_case`). Podejrzenie przyczyny: **N2** niżej.
  - **`capability_builds` w Mongo: 0 dokumentów.** Ścieżka BUILD nigdy nie
    dobiegła końca ani razu, pod żadnym silnikiem, dla żadnej capability.

### I1 — czy warto włączać? (pytanie właściciela 23.08, odpowiedź poniżej)

**Co to jest:** kiedy jakiś agent trafia na „nie mam narzędzia do X",
capabilitySmith może sam napisać specyfikację nowego narzędzia, zlecić
implementację codingAgentowi w izolowanym worktree, przepuścić to przez
`tsc` + `check:all` jako bramkę jakości, i **zmergować** do repo, jeśli
przeszło. Promocja na produkcję wymaga osobnej ludzkiej zgody — ale sam
merge kodu do repo już dzieje się automatycznie, bez pytania.

**Do czego by się przydało:** mechanizm samo-rozbudowującego się systemu —
zamiast ręcznie dopisywać nowe narzędzie za każdym razem, gdy któryś z
domenowych agentów (chef, design, filmmaker…) czegoś nie ma, system mógłby
sam to zauważyć i zaproponować gotowy, przetestowany kod do przejrzenia.

**Rekomendacja: NIE włączać jeszcze, potrzebny jeden pełny żywy przebieg
najpierw.** Dwa powody: (1) to agent, który **sam pisze i sam merguje kod do
systemu, w którym działa** — nawet z bramkami jakości, spora
odpowiedzialność do włączenia bez pełnego zaufania do ścieżki delegacji; (2)
w tej sesji naprawiłem dwa realne bugi na tej dokładnej ścieżce (N1 —
`artifact_get` odrzucał specy bez `laneId`; N4 — dwuznaczny komunikat
tool-shelfa), ale **`capability_builds` w Mongo nadal ma zero dokumentów** —
mechanizm gate'ów jest sprawdzony bez LLM-a i solidny, lecz nikt nigdy nie
dowiózł pełnego przebiegu spec→delegacja→merge→rejestracja do końca, ani
razu, pod żadnym silnikiem. Zanim to włączać na stałe do V2, warto zobaczyć
choć jeden kompletny, żywy przebieg na czymś banalnym.

---

## 5. Poza czterema kategoriami właściciela

| poz | stan | co |
|---|---|---|
| **Z8** | ✅ **ZAMKNIĘTE 23.08** (`ae86de8`) | **brak bramy domenowej** dla coding/review — 8 innych domen ma `check:*-domain`, coding i review nie miały żadnej. Naprawione: `check:coding-domain` (12 asercji: tożsamość, modele, sufity kroków, karty boardu, granica zapis/recenzja, delegacja, wpięcie w gate) |
| J2 | ✅ **epik ZAMKNIĘTY, kroki 1–6 oraz luki A–D domknięte 23.08** | Równoległy dispatch już jechał w produkcyjnej pętli self-healingu; naprawiona została działająca ścieżka, nie włączona nowa. ✅ 1: atomowy, atrybuowany zapis (stary gubił 7/8). ✅ 2a: run jest źródłem `subtaskId`. ✅ 2b: czytelnik izoluje pliki subtaska, agregator ma zero fałszywych konfliktów, legacy ma głośny fallback. ✅ 3: wspólny limit local+cloud domyślnie 3; pomiar 9 subtasków peak 9 → 3 z zachowaniem `allSettled`. ✅ 4: rozłączne pliki. ✅ 5: osobny `threadId` per subtask. ✅ 6: store-owned lease/fence per subtask, obie połowy F8 potwierdzone. **Audyt po epiku znalazł cztery luki obok J2 i wszystkie są zamknięte:** A ✅ zapis pod lease’em nie uruchamia tsc, solo ma 60 s i prawdziwy komunikat po timeout; B ✅ `commandsRun` bierze atrybucję z runu, czytelnik izoluje komendy z zaworem legacy, ostatni tsc wygrywa; C ✅ `coding_update_artifact` pod lease’em nie nadpisuje rejestrów narzędziowych, trzy listy raportowe są addytywne, solo nadal zastępuje; D ✅ żywy `.env` jawnie ma `J2_DISPATCH_CONCURRENCY=3`, oba aliasy filmowego rootu działają, `ARK_*`/`RUNWAY_*` pozostają świadomie nieustawione. Bramy czerwone przed poprawkami i zielone po nich: `check:tracked-write-tsc-scope`, `check:subtask-file-attribution`, `check:subtask-quality-loop`, `check:dispatch-concurrency-cap`, `check:filmmaker-domain`, `f8:subtask-artifact-fencing`. **Końcowo: `check:all` 94/0 exit 0, `tsc --noEmit` exit 0, `infra:rs3:prove` zielone, rs3f8 3/3 (`term: 41`).** Residuale J2 bez zmian: domyślny `runId` nadal wspólny po `taskId`; fence obejmuje `code_task_artifacts`, nie cofa wcześniejszego filesystem/snapshot/file_activity. |
| J7 | ✅ **ZAMKNIĘTE 23.08** | role subagentów ożywione: realne `loadPrompt(role.promptTemplate)`, `allowedTools` egzekwowane przez `generateOptions.activeTools` (+ naprawiony bug nazewnictwa `workspace_*`), terminal/qa na chmurze w obu producentach decyzji o modelu (`smart-router.ts` + `findOfflineFallback`). `check:subagent-roles-enforced` dowodzi żywym testem na realnym shelfie. Punkt 5 planu (Parallel Work — concurrency cap, disjoint files, unikalny runId) **nie zrobiony**, należy do epiku J2/F8/G8 |
| Z22 | ✅ zrobione | `file-editor` przypięty na sztywno do `deepseek-v4-pro` (commit `0c7b3f4`), fallback wyłącznie chmurowy, brama `check:repair-model-floor` |
| Z35 (trzecia część) | ✅ **NAPRAWIONE 23.08** (`3ad52c8`) | `POST /dashboard/approvals/:id/approve` nie miał żadnej autoryzacji — wskazał to `securityReviewAgent` żywym werdyktem BLOCK 17.08. Naprawa: opcjonalny (domyślnie wyłączony) token `Bearer` przez `DASHBOARD_APPROVAL_TOKEN`, zgodnie z konwencją innych flag bezpieczeństwa w tym projekcie (`AUTOHEAL_AUTO_PROMOTE`, `DEPLOY_AUTO_SWAP` — off by default). Nieustawiony = dokładnie dzisiejsze zachowanie (dashboard lokalny), więc nie blokuje właściciela; ostrzeżenie startowe nazywa endpoint i zmienną. `check:dashboard-approval-auth` (11 asercji) dowodzi obu stanów |

> [!IMPORTANT]
> **Notatka architektoniczna do J7 (Projekt optymalnego Parallel Work & Wąskie gardła):**
> Przy domykaniu J7 i wdrażaniu równoległego dispatchingu subagentów należy uwzględnić następujące krytyczne punkty:
> 1. **Model falowy (Wave-based Concurrency Cap)**: Sweet spot to grupy po 2–4 workerów naraz. Masowy fan-out (10–15 workerów) grozi natychmiastowym dławieniem rate limitami API chmurowych (429), zjadaniem CPU przez komendy terminala lub OOM.
> 2. **Ścisła rozłączność plików (Disjoint File Partitioning)**: Dwóch `file-editor`ów może pracować równolegle w jednej grupie TYLKO wtedy, gdy ich `targetFiles` są w 100% rozłączne. Współdzielenie plików prowadzi do wyścigów nadpisywania i błędów Gita (`fatal: Unable to create '.git/index.lock'`).
> 3. **Twardy sandbox narzędziowy**: Worker terminalowy musi mieć fizycznie odebrane narzędzia zapisu plików (`allowedTools` w harnessie), a edytor plików nie może odpalać terminala.
> 4. **Izolacja tożsamości w Harnessie**: Każdy subtask w grupie musi otrzymywać unikalny `runId`/`attemptId` (zamiast wspólnego `taskId`), aby wpisy w ledgerze Mongo, logi i telemetria nie nadpisywały się wzajemnie.
> 5. **Izolacja testów terminala**: Równoległe testy (`vitest`/`jest`) muszą unikać konfliktów portów sieciowych, plików tymczasowych oraz przeciążenia wątków.

---

## 6. Nowe znaleziska z tej sesji (22.08) — nie ma ich w żadnym dokumencie planistycznym

### N1 — `artifact_get`/`artifact_list` odrzucały KAŻDY artefakt bez `laneId` ✅ NAPRAWIONE

`outputSchema` obu narzędzi (`src/mastra/tools/system/artifact-tools.ts:63,108`)
deklarował `laneId: z.string().optional()`. Zod `.optional()` akceptuje
`string | undefined`, **nie `null`**. `putArtifact` (`artifact-store.ts:85`)
zapisuje `laneId: input.laneId`; gdy wywołujący nie poda lane'a (normalny
przypadek dla specu pisanego poza kontekstem lane'a — np. przez
`capabilitySmith`), sterownik MongoDB ciche zamienia JS `undefined` na
zapisany `null`. Efekt: **każdy artefakt kiedykolwiek utworzony bez jawnego
`laneId` był trwale nieodczytywalny przez `artifact_get`** dla wszystkich
agentów w systemie, nie tylko dla capabilitySmith/codingAgent. `check:capability-build-gates`
tego nie łapał, bo woła `getArtifact()` bezpośrednio, z pominięciem
opakowania Zod.

Naprawa: `.optional().nullable()` w obu miejscach. **Zweryfikowane live** w
Teście B run 2 — zero błędów walidacji w kilkunastu kolejnych wywołaniach
`artifact_get`, codingAgent po raz pierwszy w historii tej capability dotarł
do `coding_init_worktree`.

Status: ✅ zacommitowane (`d82d974`).

### N2 — bramka zgody przepisuje odpowiedź po dopasowaniu SŁOWA, nie akcji ✅ NAPRAWIONE

`requiresApprovalGate` (`generate-with-harness.ts:3055`) to jeden regex:

```js
/deploy|activate|aktyw|delete|usuń|usun|migrac|migration|credential|secret|
sekret|production|produkc|payment|płatno|platno|send email|wyślij|wyslij|
workflow activation|database|baza danych/i
  .test(`${originalPrompt}\n${output}`)
```

Zweryfikowane wykonaniem: brief Testu B („Zero efektów ubocznych, **zero
sekretów**, tylko odczyt plików i raport") **trafia** ten regex (słowo
„sekret"), mimo że opisuje operację **bez** żadnego z rzeczywiście ryzykownych
działań. Przy profilu głębokości `critical` (jedyny z `requireApproval: true`)
uruchamia to `maybeRunApprovalGatePass` → przebieg **bez narzędzi**, z
instrukcją „przepisz odpowiedź tak, by prosiła o zgodę przed akcją wysokiego
ryzyka". Wywołujący dostaje ogólne „Status: blocked on approval" i **nie ma
jak odróżnić** „bramka mnie przepisała po słowie klucz" od „naprawdę
potrzebuję zgody na coś".

To pasuje czasowo i behawioralnie do tego, co zaobserwowano w Teście B run 2:
3 delegacje do codingAgenta, każda kończąca się niejasnym „blocked on
approval" bez zapisu pliku, mimo że spec explicite mówił o braku sekretów i
efektów ubocznych.

**Naprawa:** ograniczone spojrzenie wstecz (30 znaków) na wskazówkę negacji
tuż przed dopasowaniem (`no`/`zero`/`without`/`nie`/`bez`/…) —
`requiresApprovalGate` w `generate-with-harness.ts`, eksportowana do testów.
Celowo nie jest to prawdziwe NLP: może tylko WYGASIĆ trafienie, nigdy go nie
dodać, więc realne, nienegowane ryzyko nadal działa jak wcześniej. Dowód:
`check:approval-gate-negation` (10 asercji) — sfalsyfikowany na starym regexie
PRZED wdrożeniem (4/10 czerwone), zielony po. Zacommitowane (`41b893d`),
wpięte do `check:all`.

**Nierozstrzygnięte do końca:** czy to była JEDYNA przyczyna „blocked on
approval" w Teście B, czy nakłada się z osobną, rzeczywistą bramką zapisu
plików w worktree codingAgenta — `maybeRunApprovalGatePass` działa PO
zakończeniu kroków modelu i tylko przepisuje tekst finalnej odpowiedzi, więc
realne wywołania narzędzi (np. `coding_init_worktree`, które w run 2
rzeczywiście się powiodło) mogły już zajść, zanim gate nadpisał raport.
Wymaga kolejnego żywego przebiegu Testu B, żeby to rozstrzygnąć — nie zrobione
w tej sesji ze względu na koszt (każdy przebieg to kilka minut i realne
wywołania modelu).

### N3 — nikt nie uruchamiał `skill:nightly` (Z27, „OTWARTE" w dokumencie) — ✅ zamknięte w tej sesji

`cron-runner.ts` (mechanizm nohup) padł na reboocie 19.08 i nigdy nie wstał.
Zastąpiony realnym wpisem w systemowym `crontab` (`0 3 * * *` nocna destylacja,
`0 4 * * 0` tygodniowy kurator, oba przez `scripts/with-node.sh`, więc
Node ≥22 wymuszony). Ręczne uruchomienie 22.08 przetworzyło zaległe 15
kandydatów → 14 `distilled`, 12 nowych plików w `_skills/auto/`.

**✅ POTWIERDZONE 23.08 03:00 — `crontab` faktycznie odpalił się samodzielnie**,
bez żadnej interwencji: `logs/skill-nightly.log` powstał dokładnie o 3:00,
`processed=1 activated=1 quarantined=0`. Mechanizm jest teraz w pełni
autonomiczny.

### N4 — komunikat systemowy tool-shelfa mylił model co do tego, kiedy dostanie kolejny krok ✅ NAPRAWIONE

Otwarty wątek z N2 (czy `codingAgent` kiedykolwiek dojdzie do zapisu pliku w
delegacji CGP) — rozwiązany. `TransientToolShelfProcessor`
(`processors/transient-tool-shelf.ts`) wstrzykuje po `load_tool`:
*„Loaded/released tools change on the next step."* Za mało jednoznaczne:
model w 5 kolejnych próbach ładował narzędzie i **kończył turę** komunikatem
statusowym, zamiast kontynuować i faktycznie go użyć — dokładnie wzorzec z
decision memo `art-5e2301df`.

**Zdiagnozowane bezpośrednim testem**, nie domysłem: zdelegowałem zadanie
wprost do `codingAgent` (z pominięciem capabilitySmith/CGP) z jednym dodanym
zdaniem doprecyzowującym — model **faktycznie doszedł do
`coding_write_file_tracked`**, plik powstał na dysku z żądaną treścią.

**Naprawa:** komunikat przepisany na jednoznaczny — „VERY NEXT tool call,
automatically, within this same turn — you do not stop, end your reply, or
wait for a new invocation". Dotyczy **wszystkich ~16 agentów na tool-shelfie**
(coding, capability-smith, researcher, meta, chef, content, hunt, writer,
design, automation-architect, knowledge, filmmaker, musician, marketing,
n8n-mcp-engineer), nie tylko coding. `check:transient-tool-shelf` ma nowy
blok regresyjny, sfalsyfikowany na starym tekście przed wdrożeniem (czerwone
z dokładnie tym samym komunikatem błędu co w opisie).

---

## 7. Stan na koniec sesji (22–23.08) — zamknięte i otwarte

### Zamknięte tej sesji, w kolejności

1. ✅ N1 (`d82d974`) — `artifact_get`/`artifact_list` odrzucały artefakty bez `laneId`.
2. ✅ N2 (`41b893d`) — bramka zgody nie przepisuje już odpowiedzi po samym słowie kluczowym w negowanym kontekście.
3. ✅ Trzy pozycje implementacyjne (repoPath `08d821b`, Z35 `3ad52c8`, H4 `352b46d`).
4. ✅ N4 / tool-shelf (`c397eef`) — dwuznaczny komunikat „next step" naprawiony; **to była prawdziwa przyczyna** blokera zapisanego jako „otwarte z N2" w poprzedniej wersji tego dokumentu, potwierdzone bezpośrednim testem (plik faktycznie powstał).
5. ✅ Z8 (`ae86de8`) — `check:coding-domain`, ostatnia domena bez bramy.
6. ✅ A11/A12/B2 (`aba0e52`, `0f7cba5`, dowód live bez commitu) — LSP, BM25, repair lane, wszystkie ze zmierzonym dowodem live.
7. ✅ J7 (`4673195`) — role subagentów w pełni ożywione (prompty, egzekwowanie narzędzi, routing modeli), punkt 5 planu (Parallel Work) świadomie zostawiony na epik J2.
8. ✅ N3 — `crontab` nocnej destylacji potwierdzony jako **realnie autonomiczny** (`logs/skill-nightly.log` powstał samodzielnie o 3:00, bez interwencji).

### Dopisek 2026-08-23 — F4/F9/F2 dowiezione na żywo

Przed uruchomieniem czegokolwiek: `.deploy/autoheal-state.json` **nie istniał
w ogóle** (cały katalog `.deploy/` nieobecny — gorzej niż „stary", jak
zakładał ten dokument), `autoheal-supervisor` nie chodził, a `:4111` serwował
osierocony `mastra dev` odpalony ręcznie 22.08. Znaleziona też DRUGA,
niezależna instancja `mastra dev` (uruchomiona przez `~/Pulpit/Mastra.sh` ~8
min wcześniej, żywa ale nie nasłuchująca na żadnym porcie — najpewniej
`EADDRINUSE` przeciw sierocie z 22.08). Za zgodą właściciela obie ubite
precyzyjnie (bez ruszania sesji pts/2 poza tymi dwoma drzewami procesów).

- **F4 ✅** — pełny realny cykl `scripts/autoheal/run-deploy.sh <commit>`
  (`AUTOHEAL_CANARY_SECONDS=120`) na commicie `afd1f4e`: build→start(:4222)→
  verify→promote(backup+swap)→canary 120s (34 sondy, PID stabilny, 0 błędów)→
  mark-promoted. `:4111` faktycznie serwuje nowy PID (potwierdzone `curl
  /health` niezależnie od logu skryptu). `autoheal-state.json` teraz istnieje
  i jest zgodny z rzeczywistością. Przy okazji naprawiony realny bug:
  `realPromote()` w `capability-build.ts` (osobna ścieżka CGP, nie użyta tu)
  w ogóle nie wołała `start-candidate.sh` — `verify-candidate` zawsze
  pollowałaby pusty port 4222. Fix + nowa brama
  `check:capability-build-promote-sequence`.
- **F9 ✅** — ta sama ewidencja co F4, bez osobnej promocji (instrukcja
  zadania: nie duplikować promocji tylko po to, by „wyprodukować” osobny
  dowód). Proces promujący (mój `bash run-deploy.sh` przez narzędzie Bash)
  zakończył się CAŁKOWICIE zanim sprawdziłem drzewo procesów — a kandydat
  (PID 615714) żył dalej: `PGID=SID=615714` (lider własnej sesji, dokładny
  efekt `setsid`) i `PPID=6297` = `systemd --user` (reaper sierot, PID
  niezwiązany z łańcuchem wzywającym). Bezpośredni dowód procesowy, że
  zabicie/zakończenie inwokera nie zabija kandydata.
- **F2 ✅** — pełny `repoMaintenanceWorkflow` przez realne HTTP
  (`create-run`→`start-async`→`resume-async`), NIE `coding_apply_patch` (to
  F1). Pierwsza próba wyłapała **nowy defekt Z38** (recenzja na modelu
  fallback zwróciła 0 wywołań narzędzi, `decisionGate` po cichu przeczytał
  STARY werdykt z Mongo zamiast zauważyć że recenzja się nie odbyła —
  **naprawione tego samego dnia**, `c5fcb0f`). Druga próba (świeży taskId)
  przeszła czysto: `approve` → suspend → `resume-async {confirmMerge:true}`
  (ludzka brama, `AUTOHEAL_AUTO_PROMOTE` cały czas `false`) →
  `mergeWorktreeToLive()` scaliła. **Zweryfikowane niezależnie `git
  log`/`git show`** (wzorzec Z15, nie raport narzędzia): HEAD żywego repo
  `afd1f4e → f5a36787`, `git show --stat` = dokładnie 1 plik +1 linia.
  Szczegóły obu prób i pełny tekst Z38 (ze stanem fixu):
  `docs/MIGRACJA-DOMENY-CODING.md` grupa F i sekcja Z14–Z21.

### Otwarte, świadomie poza tą sesją

- **F3** — wymaga `gh auth login` i decyzji, czy w ogóle otwierać tryb PR na tym repo (remote wskazuje starą nazwę).
- **J2 pełny fan-out dispatch** — epik zamknięty 23.08; plan, czerwone pomiary i dowody w `ideas/j2-parallel-dispatch-2026-08-23.md`. Kroki 1–6 zrobione w kolejności 2a → 2b → 3 → 4 → 5 → 6. Zdanie „infrastruktura gotowa, wystarczy podpiąć" było mylące: równoległość już działała i była niepoprawna; rs3f8 był potrzebny dopiero do końcowego G8 fencingu. Zestaw po dwóch kontrolowanych elekcjach J2 został uzdrowiony i pozostaje podniesiony (`term: 39`).
- **Z22/J7 decyzje** już zamknięte — nie mylić z J2, który zostaje.
- **Graphify w projektach zewnętrznych (Tryb 2, do pamięci dla większych projektów)** — audyt 2026-08-24 wykazał, że `graphify_affected`/`explain`/`god_nodes` czytają sztywny graf z `src/mastra/graphify-out/graph.json` głównego repozytorium. W trybie 2 (`/projekty/agent-projects/<nazwa>`) graf nie jest generowany. Jeśli agent wejdzie w rozwój większych zewnętrznych baz kodu, warto rozważyć parametryzację narzędzi o `projectPath`/`graphPath` i opcjonalny krok `graphify update <projectDir>`, by agent miał analizę wpływu (blast radius) także w obcym repo.

### Zasada, która się sprawdziła

Aktualizować oba dokumenty planistyczne (`MIGRACJA-DOMENY-CODING.md`,
`f7-co-zostalo-z-migracji-agentow.md`) po **każdej** zamkniętej pozycji, nie
zbiorczo na koniec — ryzyko rozjazdu jak ten zmierzony w §0 (dokumenty
kłamały o realnym stanie `.env`/`orch_jobs` przez 4 dni ciszy) rośnie z
każdym dniem odkładania.
