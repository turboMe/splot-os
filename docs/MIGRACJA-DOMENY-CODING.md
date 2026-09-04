# Domena Coding — spis zdolności legacy i przenoszenie na V2

Dokument roboczy migracji. **Jedna pozycja = jedna zdolność, którą legacy realnie
ma.** Kolumna „dowód" wypełnia się dopiero po przebiegu na żywo, nie po
implementacji — zasada tego projektu: „zbudowane i zielone" ≠ „wpięte".

Zakres: `codingAgent`, `codeReviewAgent`, `securityReviewAgent`,
`performanceReviewAgent` oraz cała maszyneria, którą uruchamiają.

Reguła nadrzędna właściciela: **na V2 ma być tak samo albo lepiej.** Pozycja
przenoszona „w części" jest pozycją otwartą.

Stan legenda: ⬜ nietknięte · 🔧 w robocie · ✅ przeniesione i potwierdzone live ·
⛔ zablokowane decyzją/faktem · ➖ świadomie poza zakresem

Konfiguracja migracji: cała domena jedzie na `deepseek-v4-pro`
(`workflowAssignments.coding`, decyzja właściciela 2026-08-12), żeby „port jest
zły" i „ten model nigdy by tego nie zrobił" nie były nierozróżnialne.

> ⚠️ **Ten dokument nie był aktualizowany od 2026-08-18.** Stan `.env` poszedł
> od tego czasu do przodu, więc poniższe „🔧/⬜" mogą nie znaczyć tego, co
> znaczyły w dniu zapisu. Zmierzone 2026-08-22
> (pełny audyt: `ideas/audyt-domena-coding-2026-08-22.md`):
> - flagi cutoveru `FEATURE_ORCHESTRATION_V2_DELEGATION` i
>   `..._AUTOMATION_JOBS` są **WŁĄCZONE** (decyzja właściciela 2026-08-18) —
>   nie „zakomentowane, nie wolno włączać", jak twierdziła poprzednia wersja
>   tego nagłówka;
> - `codingAgent`/`codeReviewAgent`/`securityReviewAgent`/`performanceReviewAgent`
>   są w `ORCHESTRATION_V2_CAPABILITIES` (`.env`), ale przez V2 przeszło **jedno**
>   zadanie codingu od kiedykolwiek — „na liście" ≠ „sprawdzone ruchem";
> - `capability_builds` w Mongo (`agentforge`) = **0 dokumentów** — ścieżka I1
>   (BUILD) nigdy nie doszła do końca pod żadnym silnikiem;
> - dwa nowe defekty znalezione żywym testem I1/capabilitySmith 2026-08-22:
>   `artifact_get`/`artifact_list` odrzucały każdy artefakt bez `laneId`
>   (naprawione), i bramka zgody (`generate-with-harness.ts:3055`) łapie
>   nieszkodliwe briefy po samym słowie „sekret"/„secret" — patrz audyt, §N1/N2.

---

## A. Nawigacja i czytanie kodu

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| A1 | mapa repo rankowana AST + PageRank, multi-repo przez `repoPath` | `repo_map` | ✅ | Sonda bezpośrednia: mapa rankowana zwraca realny wynik dla zapytania |
| A2 | statystyki indeksu | `repo_stats` | ✅ | Sonda: 1716 plików, 186 473 symboli, 24 283 definicji, 162 190 referencji |
| A3 | przebudowa indeksu | `repo_reindex` | ✅ | Sonda: przebudowa indeksu 148 ms, `indexed=2 total=1716` |
| A4 | outline pliku: symbole, zakresy linii, sygnatury, rodzic | `code_outline` | ✅ | Sonda: symbole, rodzaje i sygnatury dla realnego pliku |
| A5 | wyszukiwanie semantyczne po embeddingach, chunking AST-aware, SQLite per repo | `code_search` | ✅ | canary A r2 2026-08-12: wywołane, `completed`, 400 chunków rozgrzewki + wynik |
| A6 | statystyki embeddingów | `code_embed_stats` | ✅ | **Rozgrzewka offline dodana**: `npm run warm:code-index`. Zmierzone: 24 393 chunków, 400 na przebieg (~47 s), czyli ~38 min od zera — dokładnie ta praca, którą wcześniej agent wykonywał W ŚRODKU zadania (Z9). Skrypt jest przerywalny i wznawialny (cache trwały), zatrzymuje się gdy przebieg nie robi postępu, zamiast kręcić się w nieskończoność |
| A7 | graf: kto zależy od symbolu, tranzytywnie | `graphify_affected` | ✅ | **NAPRAWIONE (Z31)**: zwracało „0 nodes depend on X" dla symbolu o stopniu 396, bo CLI odpowiada `No unique node match` na stdout z kodem 0. Teraz rozwiązuje nazwę przez `explain` i ponawia po ID; nierozstrzygnięty symbol to uczciwe `available:false`. Live: 661 zależnych |
| A8 | graf: symbol + sąsiedzi | `graphify_explain` | ✅ | Sonda: węzeł, źródło, społeczność, stopień 396, lista połączeń |
| A9 | graf: węzły-huby | `graphify_god_nodes` | ✅ | Sonda: ranking węzłów-hubów z liczbą krawędzi |
| A10 | workspace: `view`, `find_files`, `search_content`, `workspace_search` | `codeWorkspace` | ✅ | canary A r2 2026-08-12: `search_content` ×4 (dwa równoległe w tej samej sekundzie) + `view` ×2, wszystkie `completed` |
| A11 | LSP (`typescript-language-server`) | `lsp_inspect`, `lsp: true` | ✅ **DOWÓD LIVE 23.08** | `check:workspace-lsp` — realny `typescript-language-server` wystartowany przez `createWorkspaceTools(codeWorkspace)`, hover zwrócił prawdziwą sygnaturę + JSDoc, definition trafił w realny plik |
| A12 | indeks BM25 + `autoIndexPaths` (src, docs, ideas, scratch) | `codeWorkspace` | ✅ **DOWÓD LIVE 23.08** | `check:workspace-bm25` — realny BM25 na wycinku repo zwrócił trafny chunk. Zmierzone: pełny `codeWorkspace.init()` (3099 plików, ~657MB) przekracza 3 min — za wolne na rutynową bramkę, stąd test na mniejszym realnym wycinku |

**Uwaga:** te same narzędzia ma `metaAgent` (read-only) i częściowo
`codeReviewAgent`. Karta boardu mówi wprost: „just LOOKING at code → meta ma
własne read-only". Przy migracji nie duplikować.

---

## B. Pisanie kodu we własnym repozytorium

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| B1 | izolowany worktree per zadanie, branch `task-<taskId>` | `coding_init_worktree` | ✅ | canary B 2026-08-12: worktree `task_2c20ab32-…` powstał; nazwa niesie ID zadania ORKIESTRACJI, nie wymyślone przez model |
| B2 | **repair lane**: jeden długowieczny worktree `agentic-agents-repair`, branch `autoheal/repair`, reset do `stableCommit` na starcie cyklu | `autoheal-repair-lane.ts`, flaga `AUTOHEAL_REPAIR_LANE_ENABLED` | ✅ **DOWÓD LIVE 23.08** | `ensureRepairLane()` wywołane bezpośrednio na realnym lane (był zastały na commicie z 09.08) — 126 ms, HEAD lane'u = realny HEAD głównego repo, drzewo czyste po `clean -fdx`, `.env` zachowany |
| B3 | zapis pliku śledzony, blokada zapisu poza worktree | `coding_write_file_tracked` | ✅ | canary B 2026-08-12: **rozstrzygające** — `isCodingTaskScoped` w worktree 1×, w live repo **0×**. HEAD live nietknięty (`699bd08`) |
| B4 | ledger zmian: snapshot przed/po, hash, limit 2 MB | `coding_record_before_change`, `coding_record_after_change` | ✅ | Sonda: snapshot przed i po, ten sam identyfikator zmiany |
| B5 | selektywne cofanie: per plik i hurtem | `coding_reject_file`, `coding_reject_all` | ✅ | Sonda: `reject_file` i `reject_all` — status `rejected`, licznik cofniętych |
| B6 | zatwierdzanie: per plik i hurtem | `coding_accept_file`, `coding_accept_all` | ✅ | Sonda: `accept_file` i `accept_all` — status `accepted`, `conflicts: 0` |
| B7 | usunięcie worktree | `coding_remove_worktree` | ✅ | canary B 2026-08-12: po zadaniu `git worktree list` = 2 (repo + repair lane), zero gałęzi `task-*` |
| B8 | live repo READ-ONLY przez workspace | `readOnly: true` | ✅ | Potwierdzone przez ODMOWĘ: zapis do live repo bez worktree zwrócił `[SAFETY] Write to live repo blocked` |
| B9 | sprzątanie osieroconych worktrees/branchy | `scripts/autoheal-prune-worktrees.sh` | ✅ | **URUCHOMIONE, EXIT=0**: domyślnie dry-run, rozdziela branche w pełni zmergowane do master (bezpieczne) od niezmergowanych (decyzja człowieka); zgłosiło 0 sierot |
| B10 | bramka pustego worktree przed recenzją (1 retry → twardy stop) | `worktreeHasChanges()` w workflow | ✅ | **Dowód live z grupy G**: „worktree pusty po implementacji — jedna próba ponowna", potem zatrzymanie cyklu zamiast wysłania pustki do recenzji |

---

## C. Uruchamianie komend i weryfikacja

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| C1 | komendy testowe z allowlisty, 60 s, wynik do artefaktu | `coding_run_test` | ✅ | canary A r2 2026-08-12: agent spróbował `echo …`, dostał CZYTELNĄ ODMOWĘ z nazwą klasy i alternatywami, run poszedł dalej i skończył sukcesem. Odmowa, nie zawieszenie |
| C2 | te same w tle jako durable task | `coding_run_test(background:true)` | ✅ | Sonda: `background: true` zwraca `bgTaskId` natychmiast |
| C3 | zadania w tle: start/status/wait/tail/output/cancel/cleanup/list | `bg_task` | ✅ | Sonda: start w tle zwraca `pid` i status `running`; komenda spoza allowlisty jest odrzucana z żądaniem zgody |
| C4 | **miękkie przerwanie**: ukończone zadanie tła budzi agenta wiadomością pending, leasing at-least-once | `pending-message-queue` | ✅ | Round-trip w bramie: zakolejkowanie → odbiór przez adresata → **drugi odbiór pusty** (nie wydaje dwa razy); pilna wiadomość widoczna bez odbierania |
| C5 | dowolna komenda powłoki z bramką zgody | workspace `execute_command` | ✅ | canary A r2 2026-08-12: `headless: withholding execute_command (47 of 48 tools remain)` — jedno odjęte, `view`/`search_content` przeżyły i były używane |

---

## D. Stan zadania

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| D1 | artefakt zadania: status, plan, `diagnosticPlan`, `diffSummary`, `filesChanged`, `testResult` | `coding_create_artifact` / `update` / `get` | ✅ | canary B 2026-08-12: artefakt zadania utworzony i zaktualizowany w trakcie runu |
| D2 | checkpoint kontekstu: decyzje, pliki, znane problemy, następne kroki, postęp subtasków; TTL 7 dni; auto-zapis po grupie | `context-checkpoint.ts` | ✅ | **NAPRAWIONE (Z32)**: `appendToCheckpoint` robił `updateOne` BEZ `upsert`, a jedyny writer z upsertem (`saveCheckpoint`) ma zero wywołań — dokument nigdy nie powstawał, każdy zapis był cichym no-opem, a `context-assembler` czytał pustkę. Round-trip w bramie |
| D3 | ledger aktywności plikowej: ostrzeżenie, gdy dwa subtaski dotykają tego samego pliku (nakładające się linie) | `file-activity.ts` | ✅ | Round-trip w bramie: ostrzega przy innym agencie na tym samym pliku w tym samym zadaniu, milczy przy tym samym agencie. **Flaga `FEATURE_FILE_ACTIVITY_LEDGER` domyślnie WYŁĄCZONA** |

---

## E. Recenzja kodu

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| E1 | recenzent jako OSOBNY KROK sekwencji, własny run i toolset | `codeReviewAgent` | ✅ | canary E 2026-08-17: `plan_steps` = `codingAgent→codeReviewAgent`; krok recenzji `WAITING_DEPENDENCY` na kroku autora, oba `SUCCEEDED`; log `withholding … (17 of 18 tools)` = inny toolset niż autora (48) |
| E2 | precontext recenzji | `FEATURE_REVIEW_PRECONTEXT=true` | ✅ | **Zarejestrowany w V2 2026-08-17.** V2 nie woła `generateReview`, więc recenzent pracował bez diffu, listy zmienionych plików, sygnałów weryfikacji i wcześniejszych notatek — i nic tego nie mówiło. Wspólny obiekt `reviewPrecontextFields` dzielony z legacy, żeby ścieżki nie mogły się rozjechać |
| E3 | werdykt strukturalny ✅/🔴/🟡/📊 | `coding/review.md` | ✅ | canary E 2026-08-17: pełny format z trzema realnymi uwagami (redundantny import, zależność platformowa `normalize`, brak testu) — recenzja, nie stempel |
| E4 | zapis werdyktu | `coding_submit_review` | ✅ | canary E 2026-08-17: w bazie `status=done verdict=approve files=2` — werdykt jest w artefakcie, nie tylko w tekście runu |
| E5 | narzędzia worktree dla recenzenta (diff, list, read) | `code-worktree.ts` | ✅ | canary E 2026-08-17: `coding_worktree_diff` + `coding_read_worktree_file` ×2, wszystkie `completed`; recenzent cytuje numery linii, więc czytał diff |
| E6 | promień rażenia recenzji: `graphify_affected` + `code_search` | dodane do recenzenta | ✅ | Recenzent ma `graphify_affected` + `code_search`. **Do dziś `graphify_affected` zwracał zawsze 0** (Z31), więc promień rażenia był strukturalnie martwy — recenzent widziałby „nic od tego nie zależy" przy każdej zmianie. Po naprawie: 661 zależnych dla `getDb` |
| E7 | pętla naprawcza, max 3 iteracje | `decisionGate` + `MAX_REVIEW_ITERATIONS` | ✅ | `MAX_REVIEW_ITERATIONS = 3` egzekwowane w `decisionGate` (`repo-maintenance.ts:773`), nie tylko w treści promptu |
| E8 | delegacja do recenzenta wprost z agenta | `delegateToReviewer` + `system_delegate_task` | ✅ | **DOWÓD LIVE (grupa J)**: `codingAgent → codeReviewAgent`, werdykt `approve` w artefakcie zadania; osobno `codingAgent → researcherAgent` z realną odpowiedzią |
| E9 | **recenzja bezpieczeństwa** (STRIDE/DREAD, OWASP, supply chain) | `securityReviewAgent` | ✅ | **DOWÓD LIVE 2026-08-17**: `securityReviewAgent` przeczytał `one-time-permit.ts`, wczytał metodykę i wydał werdykt **BLOCK** — znajdując DWIE realne dziury w kodzie napisanym tego samego dnia: brak wiązania zgody z narzędziem oraz zużycie „raz na konsumenta" zamiast raz globalnie. Obie naprawione (Z35) |
| E10 | **recenzja wydajności** (hot path, N+1, alokacje, indeksy) | `performanceReviewAgent` | ✅ | **DOWÓD LIVE 2026-08-17**: recenzja wydajności `file-activity.ts` — 4268 zn., odwołania `plik:linia`, analiza pokrycia indeksu złożonego, nazwane ryzyko skali. Wynik pochodzi z przebiegu POGŁĘBIAJĄCEGO („drugie przejście"), więc potwierdza też Z33 |
| E11 | skille metodyczne na żądanie: `stride-dread`, `owasp-code-review`, `dependency-vulnerability-scan`, `diff-risk-analysis`, `performance-profiling` | `_skills/` | ✅ | `skill_search` + `skill_load` działają: `stride-dread`, `owasp-code-review`, `performance-profiling` znajdowalne i ładowalne. **Naprawione przy okazji (Z34)**: 45 z 826 skilli miało opis `">-"`, bo parser frontmatteru nie znał bloków składanych YAML — a opis to jedyne, po czym agent wybiera metodykę |

---

## F. Merge i wdrożenie własnego kodu

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| F1 | merge worktree → live przez narzędzie agenta | `coding_apply_patch` | ✅ | **DOWÓD LIVE 2026-08-17**: pełna pętla z człowiekiem — agent zapisał plik i poprosił o zgodę → operator zatwierdził → drugi job scalił. Żywe repo `5bdad62 → c4a5232`, plik obecny, permit ostemplowany `liveMergeConsumedBy`. Zweryfikowane `git log`, nie raportem agenta. Kanarek wyciągnął **5 defektów** (Z14–Z18) |
| F2 | merge deterministyczny w workflow, bramkowany flagą albo zgodą człowieka | `mergeWorktreeToLive()` + `AUTOHEAL_AUTO_PROMOTE` / `confirmMerge` | ✅ | **DOWÓD LIVE 2026-08-23**: pełny `repoMaintenanceWorkflow` przez realne HTTP (`create-run`→`start-async`→`resume-async`), NIE `coding_apply_patch` (to F1). Pierwsza próba (`f2-live-merge-2026-08-23`) wyłapała 2 nowe defekty przy okazji (patrz niżej) — parallel-dispatch subtask padł na 30s timeout LLM, rework naprawił plik, ale re-review na modelu fallback (`gemini-2.5-flash` po awarii `custom-deepseek/deepseek-v4-pro`) zwrócił 0 tool call i `decisionGate` po cichu przeczytał STARY `reviewVerdict` z Mongo zamiast zauważyć że recenzja się nie odbyła — `loop_back`, run zakończony bez merge'a (**Z38, ✅ naprawione tego samego dnia** — patrz sekcja Z14–Z21 niżej). **Druga próba** (`f2-live-merge-2026-08-23b`, świeży taskId) przeszła czysto: `diagnose→patch→review(approve)→suspend`, `resume-async` z `{confirmMerge:true}` (ludzka brama, `AUTOHEAL_AUTO_PROMOTE` cały czas `false`) → `mergeWorktreeToLive()` scaliła. **Zweryfikowane niezależnie `git log`/`git show`, nie raportem narzędzia** (wzorzec Z15): HEAD żywego repo `afd1f4e → f5a36787` (`--no-ff` merge `task-f2-live-merge-2026-08-23b`), `git show --stat` = dokładnie 1 plik +1 linia, treść pliku zgodna z żądaniem — nie pusty merge. Kod: `decisionGate` w `repo-maintenance.ts` → `mergeWorktreeToLive()`. `deploy-and-verify` po merge'u zrobił TYLKO dry-run build+verify na stagingu (`DEPLOY_AUTO_SWAP=false`), :4111 nietknięty |
| F3 | tryb PR: push gałęzi, utworzenie PR, czekanie na CI (5 min), squash merge, usunięcie zdalnej gałęzi, `git pull` | `GITHUB_PR_MODE=true`, `services/github.ts` | ⬜ | **Niesprawdzalne tutaj**: `GITHUB_PR_MODE` domyślnie OFF, brak `gh` CLI, a remote wskazuje starą nazwę repozytorium. Kod istnieje (`github.ts`, `pr-body-builder.ts`); weryfikacja wymaga zdalnego repo i decyzji właściciela |
| F4 | blue-green: `build-candidate` → `start-candidate` → `verify-candidate` → `promote-candidate` → `canary-watch` (60 s) → `mark-promoted` | `scripts/autoheal/*.sh` | ✅ | **DOWÓD LIVE 2026-08-23**: pełny realny cykl przez `scripts/autoheal/run-deploy.sh <commit>` (`AUTOHEAL_CANARY_SECONDS=120`), commit `afd1f4e` na branchu `hotfix/transient-tool-shelf`. Build (`npx mastra build`, ~64s) → start slot-b :4222 → verify zdrowy (`/deploy/health` version=afd1f4e) → promote (backup + swap) → canary 120s, 34 sondy, PID stabilny, 0 błędów → `mark-promoted`. `.deploy/autoheal-state.json` (który PRZED tym w ogóle nie istniał — cały katalog `.deploy/` był nieobecny, gorzej niż "stale") teraz poprawnie: `stableCommit=afd1f4e activeSlot=slot-b activePid=615714 state=stable`. `:4111` faktycznie serwuje nowego kandydata (`curl /health` potwierdza pid=615714). Przy okazji naprawiony realny bug: `realPromote()` w `capability-build.ts` (osobna ścieżka CGP self-build, NIE użyta tutaj) w ogóle nie wołała `start-candidate.sh` — `verify-candidate` zawsze pollowałaby pusty port. Fix + `check:capability-build-promote-sequence` |
| F5 | rollback deterministyczny do stabilnej wersji, backup przed swapem | `rollback-to-stable.sh` | ✅ | `npm run autoheal:test:rollback` EXIT=0, powtórzone po zmianach w narzędziach; :4111 nietknięty |
| F6 | ponowienie nieudanego wdrożenia | `retry-deploy.sh` | ✅ | `npm run autoheal:test:retry` EXIT=0, powtórzone po zmianach |
| F7 | fallback lokalny | `local-fallback.sh` | ⬜ | Skrypt istnieje. Nieuruchamiany — przełącza Live |
| F8 | synchronizacja kanonu | `sync-canon.sh` (świadomie OFF) | ➖ | |
| F9 | self-swap odłączony (`setsid`), przeżywa zabicie własnego procesu | `deployAndVerify` + `deploy-blue-green.sh` | ✅ | **DOWÓD LIVE 2026-08-23 — ta sama ewidencja co F4, nie osobny przebieg**: promujący proces (mój `bash scripts/autoheal/run-deploy.sh` przez Bash-tool) zakończył się CAŁKOWICIE (zwrócił wynik) zanim sprawdziłem drzewo procesów — czyli cały łańcuch wzywający (`run-deploy.sh`→`promote-candidate.sh`→subshell→`setsid`) już nie istniał. Kandydat (PID 615714) mimo to żył: `ps` pokazał `PGID=615714 SID=615714` (lider własnej sesji — dokładny efekt `setsid`, nie odziedziczona sesja) i `PPID=6297` = `/usr/lib/systemd/systemd --user` (reaper sierot, PID zupełnie niezwiązany z łańcuchem wzywającym). To bezpośredni dowód procesowy że zabicie/zakończenie inwokera NIE zabija kandydata — dokładnie własność, którą `setsid … < /dev/null` w `promote-candidate.sh:94` ma gwarantować. Osobny kontrolowany kill-test uznany za zbędny (instrukcja zadania: nie duplikować promocji tylko po to, by "wyprodukować" osobny dowód, gdy F4 już go dostarczył) |
| F10 | dry-run wdrożenia bez przełączania Live | `deploy-blue-green.sh --dry-run` | ✅ | **URUCHOMIONE 2026-08-17, EXIT=0**: `deploy-blue-green.sh --dry-run` → build kandydata → start na slocie B (:4222) → health-check zdrowy → staging zatrzymany. Zero wywołań `promote-candidate`/`mark-promoted`, **Live :4111 nietknięty** (potwierdzone po fakcie). Ścieżka dry-run kończy się przed promocją — sprawdzone w kodzie PRZED uruchomieniem |
| F11 | supervisor poza Mastrą (bash, bez importu kodu Mastry), stan w pliku `.deploy/autoheal-state.json` | `autoheal-supervisor.sh` | ➖ | infrastruktura, nie agent |

---

## G. Cykl samonaprawy

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| G1 | przechwytywanie błędów runtime (`uncaughtException`, `unhandledRejection`) | `global-error-handler.ts` | ✅ | Wpięte i **potwierdzone w zbudowanym serwerze**, nie w źródle: `initGlobalErrorHandlers()` wołane w `index.ts:2371`, log startowy obecny. Brama sprawdza rejestrację nasłuchiwaczy ORAZ samo wywołanie |
| G2 | deduplikacja po sygnaturze, cooldown 60 s, max 3 aktywne, TTL 24 h, max 3 próby na sygnaturę, samoochrona | `error-collector.ts` | ✅ | Wszystkie limity pokryte: cooldown, dedup, TTL (istniejący `test-error-collector.ts` — **był zarejestrowany NIGDZIE, przechodził 14/14 w próżnię**, teraz `check:error-collector`), plus limit prób na sygnaturę, backoff i klasyfikacja transient w nowej `check:autoheal-cycle`. Timeout NIE otwiera cyklu naprawczego — inaczej healer diagnozuje przeciążenie tym, co właśnie się przeciążyło |
| G3 | jeden cykl na sygnaturę, kolejne wystąpienia dopisują obserwację | `autoheal_cycles` | ✅ | Jedna sygnatura = jeden cykl, kolejne wystąpienia dopisują obserwację; ticket linkowany do cyklu. Brama behawioralna na `getOrCreateCycle` |
| G4 | ticket `heal-<sygnatura>` uruchamia pełny workflow | `error-collector.ts:255` | ✅ | **DOWÓD LIVE 2026-08-17** — trzy przebiegi przez `/deploy/crash-test`. Workflow rusza, diagnozuje, planuje podzadania, i **uczciwie się zatrzymuje** zamiast wysłać puste worktree do recenzji. Wyciągnął 3 defekty (Z22–Z24). Pusty worktree jest tu POPRAWNY: crash-test wstrzykuje sfabrykowany błąd bez odpowiednika w kodzie |
| G5 | rozwiązanie ticketu po merge (nie po swapie) | `resolveHealTicket()` | ✅ | Ticket rozwiązywany po MERGE w obu ścieżkach, nie po swapie — zweryfikowane asercją na kolejności względem `mergeWorktreeToLive` |
| G6 | podgląd operatora: status, cykle, próby | `/deploy/auto-heal-status`, `/deploy/autoheal-cycles`, `/deploy/autoheal-attempts/:cycleId` | ✅ | Wszystkie trzy endpointy odpowiadają na żywo. Przy okazji: brama zaśmieciła podgląd operatora własnymi ticketami — sprzątanie kluczuje teraz po **sygnaturach**, nie po tekście (Z24) |

---

---

## DWA TRYBY PRACY — mapa przed przenoszeniem *(2026-08-17)*

`codingAgent` ma **dwa zadania o przeciwnych kształtach**, i mylenie ich jest
najgroźniejszym nieporozumieniem w tej domenie. Legacy rozróżnia je poprawnie;
przenoszenie musi to rozróżnienie zachować.

| | TRYB 1 — WŁASNY KOD | TRYB 2 — NOWY / OBCY PROJEKT |
|---|---|---|
| po co | autoheal, dobudowywanie sobie narzędzi, praca nad własnym kodem | zbudowanie nowej aplikacji, praca w cudzym repo |
| gdzie | `/projekty/mastra-agentic-environment/agentic-agents` | `/projekty/agent-projects/<nazwa>` |
| live repo | **READ-ONLY** przez workspace | n/d |
| zapis | wyłącznie do worktree, przez `coding_write_file_tracked` | wprost do projektu, `writeExternalProjectFile` |
| worktree | **TAK** — izolowany per zadanie, branch `task-<id>` | **NIE** — nie ma po co |
| komendy | allowlista (tsc, testy, lint, build, `npm run check:*`) | **dowolne**, `runExternalProjectCommand` — w tym `git commit` |
| dotarcie do produkcji | merge za zgodą → blue-green → canary 60 s → promote/rollback | **nie dotyczy** — nie ma czego przełączać |
| dlaczego tak | agent edytuje runtime, w którym sam działa | to nie jest jego runtime; jedyne, co się liczy, to żeby nie sięgnął z powrotem do siebie |

**Wybór trybu jest wyłącznie promptowy.** Nie ma routingu ani flagi:
`coding/base.md` mówi „External projects … use `createExternalProject` ONLY when
building something outside your own codebase" i „gdy mowa o »repozytorium«,
chodzi o TWÓJ workspace". To jest cała logika przełączania.

### Tryb 1 ma TRZY cele, które dzielą worktree i różnią się tym, co potem

| | 1a. AUTOHEAL | 1b. DOBUDOWA WŁASNYCH NARZĘDZI | 1c. ZWYKŁA PRACA NAD KODEM |
|---|---|---|---|
| co uruchamia | błąd runtime → `ErrorCollector` → ticket `heal-<sygnatura>` | luka zdolności → `capabilitySmith` → `capability-build.ts` | zlecenie od człowieka / meta |
| identyfikator | `heal-*` (rozpoznawany po prefiksie) | `buildId` | dowolny `taskId` |
| worktree | repair lane `agentic-agents-repair` (długowieczny, resetowany do `stableCommit`) **albo** per-task, zależnie od `AUTOHEAL_REPAIR_LANE_ENABLED` | per-build, z **claimem na `repo:src/mastra/**`** żeby dwa buildy się nie przepletły | per-task, `task-<id>` |
| bramka jakości | recenzja `codeReviewAgent`, max 3 iteracje | **`npx tsc --noEmit` ORAZ `npm run check:all` w worktree** — czerwone = brak merge'u, zawsze | recenzja + `coding_run_test` |
| zgoda na merge | `AUTOHEAL_AUTO_PROMOTE=true` **pomija człowieka** (tylko dla `heal-*`) | **jednorazowy permit** zatwierdzony przez człowieka | człowiek: `confirmMerge` |
| co dalej | blue-green: build → start → verify → **promote** → canary 60 s → mark/rollback | promote **domyślnie OFF**, rejestracja capability jako `built/shadow` | `deploy-blue-green.sh --dry-run`, bez przełączania Live |
| kto jest właścicielem | supervisor w bashu, **poza Mastrą** — rollback nie zależy od LLM, Mongo ani endpointów | `capability-build.ts` z fencingiem i lease | człowiek |

**Wspólny mianownik trzech:** agent edytuje runtime, w którym żyje, więc każda
z nich ma worktree, bramkę jakości i osobną decyzję o dotarciu do produkcji.
**Różnica:** kto tę decyzję podejmuje i co ją bramkuje.

**Zasada, która trzyma to całe piętro** (`AUTOHEAL-PROMOTE-ROLLBACK.md`):
*rollback i dostępność runtime NIGDY nie zależą od Mongo, LLM ani endpointów
Mastry*. Stan żyje w pliku `.deploy/autoheal-state.json`, backup powstaje PRZED
swapem, sonda Mongo w canary jest best-effort. Przenoszenie na V2 nie może tego
naruszyć — durable job jest w Mongo, więc **promote/rollback musi zostać poza
jobem**, inaczej awaria Mongo zabiera mechanizm ratunkowy.

### Na czym NAPRAWDĘ stoi izolacja trybu 2

**Nie na workspace.** `getOrCreateExternalProject` buduje pełny `Workspace`
(własny filesystem, sandbox, LSP, bm25, bramka zgody na komendy) — i **nikt go
nigdy nie odczytuje**: wszystkie trzy narzędzia czytają wyłącznie `project.path`,
a `project.workspace` nie ma ani jednego konsumenta w całym `src/`. Kolejny
obiekt zbudowany i niewpięty; **siódmy przypadek tego wzorca** w tym projekcie.

Izolacja pochodzi z trzech strażników ścieżek:
1. `getOrCreateExternalProject` odmawia utworzenia projektu wewnątrz katalogu agenta;
2. nazwa projektu jest sanityzowana (`[^a-z0-9-_] → -`), więc nie przemyci `/` ani `..`;
3. `writeExternalProjectFile` sprawdza, czy ścieżka wypada wewnątrz projektu.

**Konsekwencja martwego workspace'u, którą trzeba znać:** w trybie 2 narzędzia
`view` / `find_files` / `search_content` / `lsp_inspect` **nadal wskazują na
własne repo agenta**, bo należą do `codeWorkspace`. Czytanie obcego projektu idzie
przez `repo_map` / `code_search` / `code_outline` z parametrem `repoPath` oraz
przez powłokę (`cat`, `ls` w `runExternalProjectCommand`). To samo dotyczy **Graphify**:
narzędzia `graphify_affected`/`explain`/`god_nodes` czytają sztywny graf z `src/mastra/graphify-out/graph.json`
głównego repozytorium. W projektach zewnętrznych graf nie powstaje automatycznie.
Dla większych obcych projektów (np. rozbudowane bazy TS/Python) warto pamiętać o opcji parametryzacji
Graphify o `projectPath`/`graphPath` oraz opcjonalnym `graphify update <projectPath>`, by agent miał pełny blast radius w obcym kodzie.
To działa, ale nie jest tym samym co workspace i warto o tym wiedzieć przy pisaniu promptu.

### 🔴 Znalezisko: strażnik ścieżki miał dziurę prefiksową *(naprawione)*

`writeExternalProjectFile` porównywał `fullPath.startsWith(project.path)`.
Zmierzone:

```
projekt: /projekty/agent-projects/app
  src/a.ts                                        → wewnątrz  (poprawnie)
  ../../mastra-agentic-environment/…/index.ts     → blokowane (poprawnie)
  ../app-evil/x.ts                                → PRZECHODZI  ← dziura
```

Strażnik trzymał się przeciw ucieczce, o której ktoś pomyślał, i wpuszczał tę,
o której nikt nie pomyślał: **katalog rodzeństwa, którego nazwa rozszerza nazwę
projektu**. Poprawne pytanie wymaga separatora — i było już poprawnie zadane
w `harness-policy.ts`, tylko prywatnie. Wyciągnięte do `lib/path-containment.ts`,
oba miejsca importują je teraz zamiast mieć własną pisownię.

Brama: `check:external-project-isolation` (7 asercji, w tym regresja na dziurę
prefiksową i asercja „jedna implementacja, nie trzy").

### Co V2 zmienia w trybie 2 — sprawdzone

- **Odcięcie narzędzi zawieszających go NIE dotyczy.** Withholding usuwa
  `execute_command` / `write_file` / `index_content`, czyli nazwy z `codeWorkspace`.
  Narzędzia projektów zewnętrznych mają inne nazwy, więc tryb 2 działa headless
  bez zmian — i to jest właściwe: tam nie ma czego chronić przed agentem.
- **`taskId` z runu go nie dotyczy** — narzędzia zewnętrzne nie biorą `taskId`.
- **⚠️ `repoPath` precontextu wskazuje na własne repo agenta**, także gdy pracuje
  nad projektem zewnętrznym. Legacy zachowuje się identycznie (`delegate-task.ts`
  podaje `AGENTIC_AGENTS_REPO` bezwarunkowo), więc **to nie jest regresja** — ale
  jest to mapa niewłaściwego repozytorium wstrzykiwana do promptu. Pozycja otwarta.

---

## H. Projekty poza własnym kodem

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| H1 | utworzenie projektu w `/projekty/agent-projects/<nazwa>` z szablonem (empty/typescript/node) + `git init` | `createExternalProject` | ✅ | Sonda: projekt tworzony w `/projekty/agent-projects/<nazwa>` **od razu z gitem** (`hasGit: true`) |
| H2 | zapis pliku ze strażnikiem ucieczki ze ścieżki | `writeExternalProjectFile` | ✅ | **Naprawione (Z36)**: strażnik ucieczki jest poprawny (odmowa dla sąsiedniego projektu, zagnieżdżonej trawersacji i ścieżki bezwzględnej), ale LEGALNY zapis do podkatalogu padał na `ENOENT` — narzędzie nie tworzyło katalogów nadrzędnych, a nowy projekt jest pusty, więc pierwszy plik agenta to prawie zawsze `src/index.js` |
| H3 | **dowolna komenda w projekcie** (30 s, `spawn`, SIGKILL całej grupy) — w tym `git commit` | `runExternalProjectCommand` | ✅ | Sonda: dowolna komenda działa — `node src/index.js` zwrócił wynik, a `git add + commit + log` przeszedł w **repozytorium projektu**. To jest drugi tryb pracy: bez worktree, bez bramki zgody, bez blue-green |
| H4 | osobny workspace per projekt | `external-project-workspace.ts` | ✅ **USUNIĘTE 23.08** (`352b46d`) | Martwy `Workspace` skasowany zamiast wpięty — zero konsumentów w `src/`, izolacja i tak stała na strażnikach ścieżek. `check:external-project-isolation`/`check:external-project-mode` bez zmian |
| H5 | lista istniejących projektów | `listExternalProjects` | ✅ | Sonda: lista zwraca nazwę, ścieżkę i `hasGit` |

---

## I. Rozbudowa systemu o nowe zdolności

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| I1 | ścieżka BUILD: bramka specyfikacji → lane + claims `repo:src/mastra/**` → delegacja do worktree → **bramka jakości `tsc --noEmit` ORAZ `check:all` w worktree** → merge po zielonym → promote za jednorazowym zezwoleniem → rejestracja | `capability-build.ts` | 🔧 | Ścieżka 7-krokowa kompletna i bramkowana (`check:capability-build-gates`, `check:capability-build-lease`); bramka jakości to `tsc --noEmit` **oraz** `check:all` W WORKTREE. Live zweryfikowana 2026-07-22 pod legacy. **Z V2 osiągalna tylko opt-in** — `capabilitySmith` ma kartę boardu, ale nie ma go w `DEFAULT_V2_CAPABILITIES` |
| I2 | jednorazowe zezwolenie: roszczenie i konsumpcja w jednym CAS, rozróżnia `already_used` od `pending` | `realConsumeApproval` | ✅ | Roszczenie i konsumpcja w jednym CAS; wydzielone do `one-time-permit.ts` i **dzielone** z bramką merge codingAgenta — dwie kopie reguły permitu to jak jedna z nich zaczyna token tylko *oglądać*. Rozróżnia `already_used` od `pending`, a od 2026-08-17 także `wrong_task` (wiązanie z zadaniem, które człowiek widział) |
| I3 | Capability Gap Protocol: `mcp_discover` → sandbox z fałszywymi sekretami → zgoda człowieka → attach | `capabilitySmith`, `capability-attach.ts` | ➖ | inny agent |
| I4 | destylacja skilli z udanych przebiegów | `skill-distillation` | ✅ | **Wpięte do V2 2026-08-17 + dowód live**: kandydat `codingAgent trigger=tool_calls toolCalls=5` z celem submitowanego joba, odczytany z bazy. Wcześniej `recordDistillationCandidate` miał DWÓCH wywołujących — legacy `delegate-task.ts` i ścieżkę build — więc **żadna praca na V2 niczego nie uczyła**. Przy okazji wyczyszczone 1114 śmieci z bram (86% korpusu). **OTWARTE: nikt nie uruchamia konsumenta** (`skill:nightly`), wszystkie kandydaty `pending` |

---

## J. Delegacja i równoległość

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| J1 | router modelu per subtask: złożoność + budżet VRAM + żywy `GpuGuard` + circuit breaker + budżet chmury | `smart-router.ts` | ✅ | Zweryfikowany i **naprawiony**: `file-editor` przypięty do `deepseek-v4-pro` (decyzja właściciela), z awaryjną ścieżką na najmocniejszy chmurowy — nigdy na lokalny. Brama `check:repair-model-floor` (asercje behawioralne: wyzwalany wyłącznik obwodu, prawdziwy `routeSubtasks`) |
| J2 | **równoległy dispatch**: grupy sekwencyjnie, subtaski w grupie przez `Promise.allSettled` | `parallel-dispatch.ts` | 🔧 | **Topologia 3-węzłowa Mongo (`rs3f8`, porty 27019–27021) jest już w pełni przygotowana i przetestowana** (`scripts/f8-mongo-rs3.sh`), wystarczy podpiąć w ramach epiku F8/G8 — patrz §Z4 |
| J3 | walidacja jakości subtaska: `no_files_changed`, `tsc_errors`, `target_files_missed`, `agent_reported_failure`, `empty_diagnostics`, `partial_completion` | `subtask-executor.ts` | ✅ | Wszystkie **5** sygnałów pokryte bramą `check:subtask-quality-loop`, 3 z nich zaobserwowane live na cyklach autohealu. Szósty (`partial_completion`) był zadeklarowany w typie i **nigdy nieemitowany** — w legacy też; usunięty, brama pilnuje, że każdy zadeklarowany sygnał ma producenta |
| J4 | eskalacja modelu po nieudanej próbie (`local-micro → … → cloud-pro`), 3 próby, potem `needs_human` | `ESCALATION_PATH` | ✅ | Live 3× na cyklach autohealu (`gpt-oss-20b → gpt-5.3-mini`, `gemma → bielik`). Brama dowodzi dwóch własności, których live nie pokazał: drabina idzie **wyłącznie w górę** (inaczej pętla) i kończy się na `needs_human`, a nie cichym sukcesem |
| J5 | fallback offline: błąd chmury → lokalny, błąd lokalnego → chmura | `findOfflineFallback` | ✅ | **Naprawiony defekt**: reguła brzmiała *„cloud error → cheapest local"*, więc jeden 429 od dostawcy oddawał naprawę kodu modelowi 4B — po cichu. To DRUGI, niezależny producent decyzji o modelu; przypięcie routera samo w sobie tej dziury nie zamykało |
| J6 | wykrywanie konfliktów plikowych między subtaskami | `dispatchResult.conflictingFiles` | ✅ | Wykrywanie po fakcie: plik edytowany przez >1 podzadanie trafia do `conflictingFiles` i do czytelnego podsumowania. Brama sprawdza obie połowy — wykrycie ORAZ pokazanie |
| J7 | role subagentów z ograniczonym toolsetem, modelem i promptem | `subagent-roles.ts` | ✅ **ZAMKNIĘTE 23.08** | Wszystkie trzy części zrobione: (1) `promptTemplate` faktycznie ładowany (`loadPrompt`), realne pliki `subagent-*.md` zamiast ad-hoc tekstu; (2) `allowedTools` egzekwowane przez `generateOptions.activeTools` — przy okazji naprawiony bug nazewnictwa (`workspace_*` nigdy nie pasowało do realnych kluczy); (3) terminal/qa przeniesione na modele chmurowe w `smart-router.ts` (`ROLES_EXCLUDED_FROM_LOCAL`), naprawione też w DRUGIM, niezależnym producencie decyzji (`findOfflineFallback`). `check:subagent-roles-enforced` dowodzi żywym testem na realnym `TransientToolShelfProcessor`, że `coding_write_file_tracked` nigdy nie staje się wywoływalny dla roli `terminal`, nawet po „udanym" `load_tool` |
| J8 | delegacja do prawdziwych agentów (researcher, deliberation) | `system_delegate_task` | ✅ | **DOWÓD LIVE**: `codingAgent → researcherAgent`, realna odpowiedź 2060 B. Przy okazji naprawiona atrybucja — telemetria zapisywała delegację pod `meta-agent` (rodzina Z11), przez co uczciwy przebieg wyglądał na zmyślony |
| J9 | workery tekstowe ad hoc, **równolegle w jednym kroku** | `system_run_worker` | ✅ | **DOWÓD LIVE**: 52 zdarzenia `worker_run_*`, kilka wystartowanych w tej samej sekundzie — czyli równolegle w jednym kroku, zgodnie z opisem |

---

## K. Pamięć, skille, uczenie się

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| K1 | precontext codingu: pamięć semantyczna + skille + mapa repo + checkpoint, budżet 2048 tok | `coding-precontext.ts`, `codingPrecontextFields` | ✅ | canary A r2 2026-08-12: `precontext_injected injected=true tokens=2168 repoMap=true checkpoint=true memory=3 skills=3 suppressed:[]` |
| K2 | odczyt/zapis wiedzy trwałej | `system_memory_recall`, `system_memory_write_observation` | ✅ | canary A r2 2026-08-12: `system_memory_recall` ×2 równolegle, `completed` |
| K3 | rejestr skilli: szukanie, ładowanie, raportowanie wyniku (`success_rate` w YAML) | `skill_search`, `skill_load`, `skill_report_result` | ✅ | Round-trip: `reportResult` inkrementuje licznik w pamięci **i** zapisuje `total_uses`/`success_rate`/`last_used` do frontmatteru pliku skilla. Wyszukiwanie i ładowanie potwierdzone w E11 |
| K4 | asynchroniczny worker pamięci + deduplikacja wstrzykniętych wspomnień | `semantic-memory-worker.ts` | ✅ | Round-trip: `filterPreviouslyInjectedMemoryIds` po `recordInjectedMemoryContext` pomija już wstrzyknięte id i zwraca tylko nowe. **Uwaga: zakres to `threadId`** (z fallbackiem na `taskId`) — wywołanie bez żadnego z nich nie deduplikuje wcale |
| K5 | artefakty systemowe wymieniane po referencji | `artifact_put` / `get` / `list` | ✅ | canary A r2 2026-08-12: `art-51e1b921` ZWERYFIKOWANY U ŹRÓDŁA — `analysis_report`, 5468 zn., sha256, `producedBy=codingAgent`; koperta niosła `artifacts=1` |
| K5b | **wynik konsumowalny przez następny krok** (kanał artefaktów w kopercie) | `diff_patch`, `review_report`, `analysis_report` | ✅ | canary B 2026-08-12: DWA artefakty zweryfikowane u źródła — `art-3c879f6f` (`diff_patch`, 666 zn., sha `cc80ca6d`) i `art-e4f68f8d` (`review_report`, 1734 zn., sha `f6be43fc`); koperta niosła `artifacts=2` |
| K6 | dokumentacja bibliotek na żądanie | Context7 MCP | ✅ | Serwer `Context7 Documentation MCP Server v4.0.2` startuje w kanarkach, toolset podpięty do codingAgenta (`...context7Tools`), ładowanie defensywne — awaria MCP nie blokuje startu |

---

## L. Nadzór nad przebiegiem

| # | zdolność | gdzie w legacy | V2 | dowód |
|---|---|---|---|---|
| L1 | GoalContract + scorer ukończenia celu | `goal-tracker`, `goal-completion-scorer` | ✅ | **DOWÓD LIVE**: 25 zdarzeń `output_score` z kanarków recenzji, każde z prawdziwym `goalContractId` i uzasadnieniem. Kluczowe: harness SAM tworzy kontrakt, gdy wywołujący go nie ma (`harnessGoalContract?.contractId ?? input.goalContractId`) — a V2 żadnego nie podaje, więc bez tego każdy job V2 leciałby nieoceniony. Scorer napędza pętlę `isTaskComplete`: wynik 0 wstrzykuje informację zwrotną i ponawia |
| L2 | Strategy Reflector: scope creep, pętla narzędzia, brak postępu, zmiana kierunku | `strategy-reflector.ts` | ✅ | **DOWÓD LIVE**: 24 zdarzenia `reflector_intervention`, z `appliedLevers: ["injectSystem"]` — czyli reflektor nie tylko wykrywa, ale **działa**. Wyzwalacze zaobserwowane na żywo: `high_error_rate` (100% wywołań narzędzi z błędem) i `low_progress` (krok 9/16 bez postępu). Interwencje logują się do Mongo, NIE na konsolę |
| L3 | telemetria narzędzi z klasą ryzyka i decyzją polityki | `tool_executions` | ✅ | **DOWÓD LIVE**: wpis `tool_executions` niesie `category`, `risk` ORAZ pełną `policyDecision` (allow, requiresApproval, severity, reason, matchedRule, enforcementMode). Odnotowane: `enforcementMode: log_only`, `enforced: false` — polityka obserwuje, nie blokuje |
| L4 | profil głębokości: kroki, okno, liveness, próg zgody | `depth-controller.ts` | ✅ | **DOWÓD LIVE**: profile liczone i stosowane w kanarkach V2 (`critical score=0.70 maxSteps=40 reflector=true`, `fast score=0.10 maxSteps=10`). Profil niesie cztery składowe: sufit kroków, okno bezczynności, liveness i budżet refleksji |

---

## ZNALEZISKA BLOKUJĄCE

### Z37 — spójność embeddingów: zabramkowana, bo pomyłka tu jest niewidoczna

Pytanie właściciela („czy nie użyjemy innego modelu niż wcześniej") okazało się
trafne jako ryzyko, choć stan był czysty. Zmierzone:

- model: **`ollama/local/bge-m3`**, 1024 wymiary, z `.env`
  (`EMBEDDING_PROVIDER=ollama`, `EMBEDDING_MODEL=bge-m3`);
- w indeksie: **wyłącznie ten jeden model**, zero wektorów z innego;
- **19 miejsc** liczących embeddingi, wszystkie przez jeden `lib/embedder.ts`;
- kod już chronił przed mieszaniem: chunk pamięta `embedding_model`, a cache jest
  użyty ponownie tylko przy zgodności — zmiana modelu wymusza przeliczenie.

Wektory z dwóch modeli dzielą przestrzeń wyłącznie przez przypadek. Pomyłka tu
nie rzuca wyjątku, nie loguje się i nie oblewa testu — wyszukiwanie po prostu
zaczyna zwracać bzdury, a objaw („code search się popsuł") wskazuje w zupełnie
inne miejsce. Stąd brama `check:embedding-consistency`.

**Brama miała własny defekt tej samej klasy.** Asercja „nikt nie sięga do
providera bezpośrednio" nie mogła oblać: usuwanie komentarzy tnie linię od
pierwszego `//`, co trafia w `http://` i wycinało `/api/embed` **zanim** asercja
zdążyła spojrzeć. Wykryte przez podrzucenie prawdziwego obejścia i sprawdzenie,
czy brama je złapie — nie złapała. Poprawione: `//` zaczyna komentarz tylko wtedy,
gdy nie stoi po dwukropku ani cudzysłowie.


### Z36 — nowy projekt nie przyjmował pierwszego pliku

Strażnik ucieczki ze ścieżki w `writeExternalProjectFile` jest **poprawny** —
odmówił zapisu do sąsiedniego projektu, przez zagnieżdżoną trawersację i po
ścieżce bezwzględnej. Ale `writeFileSync` nie tworzy katalogów nadrzędnych, a
nowy projekt jest pusty, więc pierwszy plik agenta budującego aplikację
(`src/index.js`, `docs/README.md`) kończył się `ENOENT`.

Odmowa ataków i odmowa pracy w jednym oddechu to najgorsza możliwa kombinacja —
wygląda dokładnie jak „to narzędzie jest zepsute". Katalog tworzony jest teraz
PO sprawdzeniu zawierania, więc nie może powstać nigdzie indziej.

Uwaga metodologiczna: przy pierwszym podejściu **omal nie zgłosiłem fałszywego
defektu** — moja sonda nazwała projekt `…-evil` i ścieżka `../…-evil/x` wróciła
do wnętrza tego samego projektu, co wyglądało na ucieczkę. Dopiero test
„projekt A pisze do projektu B" pokazał prawdę: strażnik działa.


### Z33 — produkt runu ginął, gdy harness robił kolejny przebieg

`securityReviewAgent` wykonał 43 wywołania narzędzi, przeczytał właściwe pliki i
wyprodukował recenzję na 5790 znaków — scorer celu ją zobaczył i zaliczył. Job
mimo to skończył się `FAILED` z `run produced no deliverable`, bo **końcowa
odpowiedź miała jeden krok**: `#### Completion Check Results`.

Przyczyna to znana pułapka w nowym miejscu: harness robi KILKA `generate` i
zwraca ostatni, więc kroki wcześniejszych przebiegów są nieosiągalne z obiektu,
który dostaje wywołujący. `bestDeliverable` pamiętał tylko odpowiedzi PRZEBIEGÓW,
a nie kroki wewnątrz nich.

Naprawa jest tą samą lekcją co przy artefaktach: **nie odzyskuj faktu o runie z
obiektu, który framework może przekształcić — zapisz go w momencie zdarzenia**
(`run-deliverables.ts`, karmione z `onStepFinish`). Najdłuższy niebędący raportem
frameworka tekst wygrywa, żeby „teraz to zweryfikuję" nie wyparło samej pracy.

### Z34 — 45 skilli opisywało się jako `">-"`

Frontmatter używa składanych bloków YAML (`description: >-` + wcięte linie), a
parser brał **sam wskaźnik** jako wartość. Wyszukiwarka skilli zwracała więc
`"description": ">-"` dla każdego z nich — a opis to jedyne, po czym agent wybiera
metodykę. Wyszukiwanie działało, ranking działał, odpowiedź była bezużyteczna.

### Z35 — recenzja bezpieczeństwa znalazła dwie dziury w kodzie z tej samej sesji

To jest dowód wartości E9, więc zapisane osobno. `securityReviewAgent` wydał
werdykt **BLOCK** na `one-time-permit.ts` i miał rację w dwóch punktach:

1. **Zgoda nie była wiązana z AKCJĄ.** Filtr CAS wiązał token z `id` + `status` +
   „jeszcze niezostemplowany". Zgoda wydana przez człowieka na akcję niskiego
   ryzyka (np. wysyłkę maila) autoryzowałaby `coding_apply_patch` i scalenie do
   żywego repozytorium — człowiek odpowiadał na inne pytanie niż to, które token
   ostatecznie przypieczętował.
2. **„Dokładnie raz" obowiązywało per konsument, nie globalnie.** Stempel jest
   per `stampPrefix`, więc ten sam token dawał się spalić raz przez `promote` i
   raz przez `liveMerge`.

Obie naprawione (`forTool` → wynik `wrong_tool`; wspólny znacznik
`permitConsumedBy` w filtrze CAS), obie z falsyfikowalnymi asercjami.

Recenzent wskazał też trzecią rzecz, **nienaprawioną**: `POST
/dashboard/approvals/:id/approve` nie ma widocznej autoryzacji. To pytanie o
model zagrożeń pulpitu (dziś lokalny), nie o ten plik — do decyzji właściciela.


### Z31 — `graphify_affected` mówił „nic od tego nie zależy" o symbolu ze stopniem 396

CLI rozstrzyga wyłącznie po **wewnętrznym ID węzła**, a na nazwę, której nie może
przypiąć, odpowiada `No unique node match for <symbol>` — **na stdout, z kodem
wyjścia 0**. Parser nie widział krawędzi, więc narzędzie raportowało
`0 nodes depend on getDb` dla symbolu, dla którego jego własny `explain` pokazuje
stopień 396 i listę połączeń.

Dla narzędzia do analizy wpływu to najgorszy możliwy kształt porażki: mówi
**„nic od tego nie zależy, można zmieniać"**, gdy w rzeczywistości w ogóle nie
spojrzało. Istniejąca brama `check:graphify-affected-parse` przechodziła — jej
własny nagłówek przyznaje, że testuje parser na fikstrurach, a ścieżkę live
zostawia jako ręczną.

Naprawa: wykrycie po **nagłówku sukcesu** (`Affected nodes for`), nie po treści
błędu (żeby nie zależeć od brzmienia CLI), plus automatyczne rozwiązanie nazwy
przez `explain` → ponowienie po ID. Nierozstrzygnięty symbol to teraz uczciwe
`available: false` z podpowiedzią. Live po poprawce: **661 zależnych**.

### Z32 — checkpoint kontekstu **nigdy nie powstawał**

`appendToCheckpoint` wołał `updateOne({ taskId }, …)` **bez `upsert`**, a jedyny
writer z upsertem (`saveCheckpoint`) ma **zero wywołań** poza własnym modułem.
Obaj realni wywołujący (`subtask-executor`, `generate-with-harness`) używają tej
pierwszej. Efekt: dokument nie powstawał, każdy zapis pasował do zera dokumentów
i cicho przepadał, a czytelnik (`context-assembler` → `loadCheckpoint`) za każdym
razem dostawał pustkę.

Zero błędów, zero ostrzeżeń, zero wierszy — agent po prostu zachowywał się tak,
jakby nie miał pamięci między krokami. Zmierzone: 0 dokumentów w
`context_checkpoints` po pozornie udanym zapisie. Brama
`check:coding-state-round-trips` sprawdza teraz PIERWSZY zapis, bo to on ginął.

### Metodologiczne — sondy z pamięci są zawodne

Cztery razy w tej turze wyciągnąłem błędny wniosek z pustego wyniku, bo sonda
używała złej nazwy pola, złej kolekcji albo złego parametru
(`createdAt` vs `timestamp`, `pending_messages` vs `pending_user_messages`,
`targetAgentId` vs `agentId`, złe argumenty `create_artifact`). **Za każdym razem
odczytałem sygnaturę ze źródła i pustka znikała.** Dlatego bramy w tej turze
wołają prawdziwe funkcje w prawdziwej kolejności zapis→odczyt, zamiast
odtwarzać zapytania.


### Z28 — **pinu zdolności nie dało się użyć z API**

`acceptStartCommand` przyjmuje pin `capability`, **waliduje** go
(`invalid capability pin: …`), zapisuje jako `requestedCapability`, a
`activations.ts:1218` go honoruje. Cały łańcuch działał poza pierwszym ogniwem:
granica HTTP nigdy go nie przekazywała — słowo „capability" nie występowało w
`handlers.ts` **ani razu**.

Skutek: żaden wywołujący nie mógł wskazać agenta. O wszystkim decydował model
czytający treść celu. Zmierzone: zadanie zgłoszone dla `codingAgent` wykonał
`deliberationAgent`, który uczciwie zaraportował, że nie ma żadnego z żądanych
narzędzi. Jedna linia w `handlers.ts`; brama `check:durable-delegation` sprawdza
teraz pin **od strony API**, nie tylko od strony store'u.

### Z29 — awaryjny fallback oddawał naprawę modelowi 4B

Drugi, **niezależny** producent decyzji o modelu. Router przypina naprawy do
modelu domeny coding — a `findOfflineFallback` miał regułę *„cloud error →
cheapest local model (free)"*. Jeden błąd 429 od dostawcy wystarczał, żeby
naprawa kodu trafiła na `qwen3.5:4b`, po cichu, z `console.warn` jako jedynym
śladem.

**Lekcja ogólna:** gdy decyzja ma dwóch producentów, przypięcie jednego nie jest
przypięciem. Dlatego `check:repair-model-floor` ma teraz dwie asercje awaryjne, a
nie jedną.

### Z30 — telemetria przypisywała delegację `meta-agent`

`callerAgentId` ma `.default(META_AGENT_ID)`, a `resolveDelegationCaller` już
wcześniej wolał tożsamość z runu — tylko blok telemetryczny używał surowej
deklaracji. Wykonanie i zapis mówiły co innego.

Zmierzone: `codingAgent` oddelegował do `researcherAgent`, run zalogował
`caller identity taken from the run: codingAgent (the call declared meta-agent)`,
a `tool_executions` zapisało to pod `meta-agent`. **Kosztowało śledztwo w tej
samej sesji** — przez chwilę wyglądało to na agenta zmyślającego delegację,
której nie wykonał. To ta sama rodzina co Z11 i ta sama cena: nic nie pada, a
każda późniejsza diagnoza czyta błędny zapis „kto co zrobił".


### Z25 — **praca na V2 niczego nie uczyła**

`recordDistillationCandidate` miał dokładnie dwóch wywołujących: legacy
`delegate-task.ts` i ścieżkę build. Ścieżka trwałej orkiestracji — **żadnego**.
Czyli im więcej pracy przechodziło na V2, tym mniej system się uczył.

Nic nie padało. Nie ma błędu, ostrzeżenia ani czerwonego testu — korpus po prostu
przestaje rosnąć, a nieobecność jest zauważalna dopiero miesiącami później.

Legacy czyta `lessons` z koperty wyniku. V2 **w ogóle nie parsuje koperty**
(`parseResultEnvelope` nie ma wywołań w całym `orchestration/`), więc dowodem
jest to, co run ZROBIŁ: liczba wywołań narzędzi i to, czy podniósł się po błędzie
narzędzia. Oba to wyzwalacze, które `shouldDistill` już rozpoznaje.

**Dowód live:** kandydat `codingAgent trigger=tool_calls toolCalls=5` z celem
zgłoszonego joba, odczytany z `distillation_candidates`.

### Z26 — licznik wpięty w hook, którego dostaje TYLKO writer

Mój własny błąd, złapany **przez diagnostykę w pierwszym przebiegu**, nie przez
rozumowanie. `onStepObservation` istniał wyłącznie wewnątrz
`agentId === 'writerAgent' && progressPolicy`, a ja umieściłem w nim liczniki —
więc run codingAgenta z **19 realnymi wywołaniami narzędzi** raportował
`toolCalls=0`. Asercje bramy były przy tym zielone: dowodziły, że liczniki są
podpięte do hooka, którego ten agent nigdy nie dostawał.

Obserwacja kroku nie jest specyficzna dla writera — hook jest teraz bezwarunkowy,
a praca writer-progress siedzi za własnym warunkiem WEWNĄTRZ niego. Dlatego też
dołożona linia diagnostyczna: „brak kandydata" i „hak nie zadziałał" wyglądają z
zewnątrz identycznie.

### Z27 — bramy uczyły system o własnych fikstrurach

**86% korpusu (1114 z 1290) to były śmieci z bram**: 918 kopii jednego celu
smoke-testowego z `check-capability-build-gates.ts:50` — po jednej na każde
uruchomienie `check:all` — plus 196 z bramy lease. Obie bramy **miały** listy
sprzątające; żadna nie znała kolekcji `distillation_candidates`, bo listy
powstały, zanim ścieżka build zaczęła zapisywać kandydatów.

Koszt to nie zabłąkany wiersz: destylator wydaje wywołania modelu na to, co jest
w kolejce, więc korpus w 7/8 złożony z fikstur zamienia pętlę uczenia w maszynę
do ponownego uczenia się `echo`. Wyczyszczone, obie bramy uzupełnione,
`check:v2-learning-loop` pilnuje czystości korpusu po każdym pełnym przebiegu
(zweryfikowane: 0 śmieci po pełnym `check:all`).

**OTWARTE — konsument nie jest uruchamiany.** Wszystkie kandydaty mają status
`pending`. `skill:nightly` istnieje w `package.json`, ale nic go nie planuje.
Wpiąłem wejście do rurociągu, którego wyjście nigdy nie ruszyło; uruchomienie
kosztuje wywołania modelu, więc to decyzja właściciela, nie defekt.


### Z22 — **naprawę kodu wykonywał model 12B lokalny** *(najcięższe w grupie G)*

`smart-router.ts` sortuje kandydatów regułą wpisaną w jego własny komentarz —
*„2. Prefer local if VRAM available (cost = 0)"* — a jedynym filtrem jakości jest
`estimatedComplexity`, czyli liczba, którą model diagnozujący wystawia **sam
sobie**. Nic nie odróżniało NAPISANIA POPRAWKI od streszczenia loga, więc cykl
autohealu oddawał edycje kodu modelowi `gemma4:12b`.

Oba pierwsze przebiegi G4 skończyły się tak samo:

```
[SubtaskExecutor] Retry: Quality issues: no_files_changed,
                  target_files_missed, empty_diagnostics
[SubtaskExecutor] Escalate: ollama/local/gemma4:12b → bielik-11b
→ worktree pusty po implementacji (dwie próby) → cykl zatrzymany
```

Drabina eskalacji nie mogła pomóc: na za mały model odpowiadała **innym modelem
lokalnym**, 12B → 11B. Oszczędność była zresztą pozorna — naprawa, która nic nie
produkuje, kosztuje cały cykl i zostawia defekt na miejscu.

**Nie jest to zakaz modeli lokalnych.** Reguła pyta o ROLĘ podzadania (tą samą
funkcją, której używa wykonawca): `file-editor` idzie na model mocny, `terminal`
/ `qa` / `researcher` dalej korzystają z workerów — bo po to są. Nieznany typ
domyślnie trafia na model mocny; to właściwy kierunek pomyłki.

Zweryfikowane live po poprawce: `add-simulated-guard` i `update-docs`
(**file-editor**) → `gpt-oss-20b` → `gpt-5.3-mini`, **zero modeli lokalnych**;
`add-regression-check` (**terminal**) → gemma → Bielik, zgodnie z zamysłem.
Brama `check:repair-model-floor`.

**Zamknięte:** `file-editor` przypięty na sztywno do `deepseek-v4-pro` (decyzja właściciela 17.08, commit `0c7b3f4`), z awaryjną ścieżką na najmocniejszy chmurowy — nigdy lokalny. Brama `check:repair-model-floor`.

### Z23 — cykl, który się zatrzymał, **blokował healera na 24 h**

Ticket przechodził w `in_progress` **po** zakończeniu workflow, a stan terminalny
ustawiał wyłącznie `resolveHealTicket()` — wołany tylko po udanym merge. Każde
inne zakończenie (pusty worktree, odrzucona recenzja, zablokowany merge,
konflikt) zostawiało ticket `in_progress` aż do TTL.

`in_progress` jest liczone przez **trzy** rzeczy naraz: deduplikację sygnatury,
limit `MAX_ACTIVE=3` i podgląd operatora. Trzy nieudane naprawy i samonaprawa
jest martwa na dobę, raportując przy tym trzy naprawy „w toku". Bez żadnego logu.

Naprawione: `in_progress` **przed** startem (status wreszcie mówi prawdę, także
gdy proces zginie w trakcie), status terminalny po zakończeniu, zawężony do
ticketów wciąż otwartych — żeby nie nadpisać `completed` po udanym merge.
Przyczyna wyciągana z miejsca, w którym naprawdę jest: workflow tłumaczył się
RZUCAJĄC wyjątek, więc ticket zapisywał gołe `workflow failed`.

Dowód live: ticket `heal-c007f76a…` → `failed` po ~150 s, **0 blokujących**.

### Z24 — brama zaśmiecała podgląd operatora

Sprzątanie kluczowało po tekście błędu, a test transientowy **nadpisuje treść**
komunikatu, żeby pasowała do klasyfikatora — czyli kasuje własny klucz. W
`/deploy/auto-heal-status` siedział ticket z prób falsyfikacji, czytający
`Harness LLM call timed out after 900s`, nie do odróżnienia od prawdziwego
incydentu. Sprzątanie kluczuje teraz po **sygnaturach** i przetrwa nawet
oblanie bramy w połowie.


### Z14–Z18 — pięć defektów, które wyciągnął jeden kanarek merge'a *(2026-08-17)*

Wszystkie pięć leżało na jednej ścieżce (`coding_apply_patch`), żaden nie był
widoczny dla testów, i **żadnego nie znalazłoby czytanie kodu** — każdy wymagał
uruchomienia rzeczy naprawdę, na tej maszynie.

**Z14 — zakres zadania blokował kontynuację między jobami.** Reguła „run
wygrywa" (Z10) chroni przed wymyślonym identyfikatorem, ale merge bramkowany
człowiekiem Z DEFINICJI jest drugim jobem: job 1 buduje i pyta, człowiek
zatwierdza, job 2 scala. Run nadpisywał poprawny identyfikator podany przez
model, a narzędzie zgłaszało „No active worktree" dla worktree leżącego na dysku.
Naprawa dzieli regułę po tym, co narzędzie ROBI: tworzenie bierze zakres z runu,
operacje na istniejącej pracy honorują jawny identyfikator, a argument o
autorytecie przenosi się na permit — który jest teraz **związany z zadaniem, jakie
człowiek widział** (`forTaskId`, wynik `wrong_task`).

**Z15 — pusty merge raportował sukces.** Zamierzone „przełknięcie" pustego
commita kończyło się komunikatem *„Changes successfully merged into the main
repository! Live environment updated."* przy nieruszonym HEAD. Teraz gałąź bez
commitów to `success: false` z nazwaną przyczyną.

**Z16 — zgoda człowieka była spalana przed sprawdzeniem, czy jest co scalać.**
Kolejność odwrócona: permit wydawany dopiero, gdy wiadomo, że gałąź coś niesie —
i nadal przed dotknięciem żywego repo. Zweryfikowane live: odmówiony merge
zostawił `consumedBy=-`.

**Z17 — wstrzyknięcie powłoki przez `commitMessage`.** `promisify(exec)` odpala
`/bin/sh -c`, a wiadomość commita (tekst od modelu) była wklejana między
cudzysłowy do polecenia wykonywanego w repozytorium, z którego ten system
działa: `commitMessage: 'x"; <cokolwiek>; #'` było poleceniem, nie wiadomością.
Wszystkie wywołania gita w żywym repo przeszły na wektor argumentów.

**Z18 — git na tej maszynie mówi po polsku.** To defekt KLASOWY, nie jeden
przypadek. `includes('nothing to commit')` jest tu fałszywe zawsze (git odpowiada
`nic do złożenia, drzewo robocze czyste`), więc przełknięcie z Z15 nigdy nie
mogło zadziałać. Sprzątanie worktree miało ten sam wzorzec i było zepsute **w
każdym języku**: tolerowało `not registered`/`not found`, a git mówi
`is not a working tree`. Nowa brama `check:git-locale-independence` zakazuje
podejmowania decyzji na podstawie tłumaczonego tekstu — decyduje kod wyjścia albo
`--porcelain`.

**Z20 — konflikt scalania NIE BYŁ WYKRYWANY w trzech miejscach.** To ta sama
klasa co Z18, ale konsekwencja jest najcięższa w całej sesji. `/conflict/i.test()`
nie łapie polskiego `KONFLIKT (zawartość): Konflikt scalania` (inna litera), więc
`git merge --abort` **nigdy nie leciał** — a repozytorium, z którego ten system
działa, zostawało w niedokończonym merge'u ze znacznikami konfliktu w plikach.
Kolejny build kompilowałby te znaczniki. Trafione w:

- `repo-maintenance.ts` §`mergeWorktreeToLive` (ścieżka autoheal),
- `capability-build.ts` §`realMergeBranch` (ścieżka samorozbudowy) — z
  komentarzem *„Leave the tree clean: a half-merged repo is worse than no merge"*
  bezpośrednio nad detekcją, która nie mogła zadziałać,
- `coding_apply_patch` (naprawione już przy Z17 przejściem na wektor argumentów).

Decyzja idzie teraz ze STANU gita: `MERGE_HEAD` istnieje dokładnie wtedy, gdy
merge jest nieukończony, w każdym języku. Brama `check:git-locale-independence`
łapie też wariant regexowy (`/conflict/i.test(...)`), nie tylko `includes()`.

**Z21 — zgoda autohealowa sięgała w bok.** Kontynuacja (Z14) pozwala modelowi
nazwać zadanie, a grant autohealowy jest bramkowany wyłącznie prefiksem `heal-`.
Run w `heal-A` mógł więc nazwać `heal-B` i przy `AUTOHEAL_AUTO_PROMOTE` scalić
gałąź, o którą żaden supervisor nie prosił. Flaga daje pasowi prawo promowania
**własnej** pracy i tyle teraz egzekwuje (`runTaskId`). Legacy bez zadeklarowanego
zakresu runu działa jak dotąd.

### Z38 — recenzja na modelu fallback nie wołała żadnego narzędzia, a gate przeczytał stary werdykt *(znalezione przy dowodzie live F2, 2026-08-23, ✅ NAPRAWIONE 2026-08-23, `c5fcb0f`)*

Odkryte podczas pierwszej próby F2 (`f2-live-merge-2026-08-23`, porzucona —
druga próba `…-2026-08-23b` przeszła czysto i to ona jest dowodem F2 powyżej).
Pierwsza iteracja recenzji poprawnie zgłosiła `needs_changes` (plik faktycznie
nie istniał — parallel-dispatch subtask padł na sztywny 30s timeout wywołania
LLM, 3/3 próby). Wewnętrzna pętla naprawcza w `decisionGate` poprawiła plik
(potwierdzone na dysku: plik istniał, `git status --porcelain` widział go jako
`??`), po czym wywołała `generateReview` po raz drugi. Ten drugi call trafił na
zepsutą konfigurację providera (`custom-deepseek/deepseek/deepseek-v4-pro` —
`Could not find config for provider custom-deepseek`), fallback przełączył się
na `google/gemini-2.5-flash`, a odpowiedź fallbacku miała **`steps=1,
toolCalls=0, toolResults=0`** — model nigdy nie zawołał `submitReviewTool`,
mimo że tekst odpowiedzi zaczynał się od słowa „approve” (skomentował
POPRZEDNIĄ iterację, nie ocenił bieżącego stanu). `decisionGate` czyta werdykt
z Mongo PO tym callu (`updatedArtifact?.reviewVerdict || 'needs_changes'`) —
skoro nic go nie nadpisało, odczytał STARY werdykt z pierwszej iteracji
(`needs_changes`) i zgłosił `loop_back`, jakby druga recenzja naprawdę się
odbyła i podtrzymała odrzucenie. Operator (albo automatyczna pętla) nie ma
żadnego sygnału, że recenzja się w ogóle nie wykonała — poprawiona zmiana
utyka bez śladu błędu.

**✅ Naprawione tego samego dnia.** Oba miejsca czytające `reviewVerdict`
(`execute-review-agent` i wewnętrzna pętla `decisionGate`) przechodzą teraz
przez `runReviewAndGetVerdict()`: liczy wpisy `[REVIEW]` w `artifact.plan`
(ten sam marker co `submitReviewTool` pisze i co `review-precontext.ts` już
filtruje) przed i po wywołaniu `generateReview`. Jeśli liczba się nie
zwiększyła — narzędzie nie zostało wywołane w tej rundzie — jedno ponowienie
z jawną instrukcją „zawołaj submitReviewTool TERAZ", a jeśli to też
zawiedzie: `throw` zamiast cichego zwrotu starego werdyktu. `db` i
`generateReview` (jako `callReview`) są teraz iniekowalne (wzorzec z
`capability-build.ts`), więc `check:review-verdict-freshness` odtwarza
dokładnie ten żywy scenariusz fałszywym recenzentem — bez LLM — i dowodzi:
(1) prawdziwe wywołanie narzędzia jest ufane od razu, bez zbędnego
ponowienia, (2) scenariusz Z38 (stary werdykt w tle, zero wywołań narzędzi)
odzyskuje się przy ponowieniu, (3) recenzent, który NIGDY nie woła narzędzia,
wywala krok błędem, nie cichym `loop_back`. Zweryfikowane też, że trzy inne
bramki importujące ten plik (`check:autoheal-cycle`,
`check:headless-approval`, `check:coding-task-scope`) nadal przechodzą.

**Z19 — nadpisanie zakresu było ciche wobec modelu.** Agent dostał polecenie
zapisu do worktree wcześniejszego joba, run przekierował zapis do własnego,
narzędzie odpowiedziało „success", a agent poprosił CZŁOWIEKA o zatwierdzenie
scalenia gałęzi, na której jego pliku nie było. Jedna linia na stdout serwera,
nic czego aktor mógłby dosięgnąć. Teraz sprzeczność wraca w wyniku narzędzia
(`scopeOverrideNote`) — zgoda milczy, różnica mówi.


### Z1 — bramka zgody ZAWIESZA run zamiast odmówić
`code-workspace.ts:233` → Mastra suspenduje agenta, a w tle nikt nie wznowi
(`generate-with-harness.ts:645` tylko to loguje). Precedens naprawy jest w repo:
merge delegowany LLM-owi zawieszał autoheal, więc zastąpiono go deterministyczną
funkcją. Dwie pozostałe drogi do powłoki (`coding_run_test`, `bg_task`)
**odmawiają nieblokująco** i to jest wzorzec do powtórzenia.

### Z2 — dwaj recenzenci są nieosiągalni
`securityReviewAgent` i `performanceReviewAgent`: żaden kod ich nie woła (tylko
import i rejestracja), a cztery prompty obiecują do nich delegację. Nie mają też
kart na Agent Boardzie, więc `delegate_task` nie przyjmie ich jako celu.
Dwa niezależne przerwania tego samego kanału.

### Z3 — merge do live nie ma bramki w narzędziu agenta
`coding_apply_patch` robi `git add && git commit && git merge` do
`AGENTIC_AGENTS_REPO`. **W kodzie nie ma żadnego sprawdzenia flagi.** Słowa
„Requires approval" są wyłącznie w opisie narzędzia. Jedyna bramka to polityka
harnessu, unieważniona przez `HARNESS_POLICY_MODE=log_only` w `.env`.
Flagi (`AUTOHEAL_AUTO_PROMOTE`, `DEPLOY_AUTO_SWAP`) bramkują **workflow**, nie
narzędzie. Do przeniesienia „lepiej": narzędzie ma honorować tę samą flagę co
workflow.

### Z4 — równoległość na V2 ma inny kształt
Fan-out zadań wymaga >1 pętli workera i bramy G8 (topologia ≥3 węzłów,
partition/stepdown) — to osobny etap F8. Dostępna dziś forma to **wiele wywołań
w jednym kroku** (AI SDK wykonuje je przez `Promise.all` —
`node_modules/ai/dist/index.mjs:4705`). Ale `run_worker` jest **text-only bez
narzędzi**, więc workery nadają się na analizę i recenzję, nie na edycję plików.

**Stan przygotowania pod F8/G8:**
Topologia 3-węzłowa Mongo (`rs3f8`, porty `27019/27020/27021`, skrypt `scripts/f8-mongo-rs3.sh`) **jest już w pełni przygotowana i przetestowana na żywo**. Wystarczy podpiąć ją w ramach epiku F8/G8.

### Z5 — role subagentów są w większości deklaracją
Z pięciu pól `SubAgentRole` cztery nigdy nie zostały odczytane: `promptTemplate`
i `skills` (`git log -S` → zero commitów w całej historii), `defaultModelTier`
(tylko w definicji i w planie), `allowedTools` (drukowane w prompcie, zero
enforcementu, w dodatku nazwami trzeciej konwencji). Trzy pliki
`prompts/coding/subagent-*.md` (215 linii) są martwe.

**Decyzja właściciela (23.08.2026): OŻYWIĆ I DOMKNĄĆ.**
1. Wpiąć szablony promptów `subagent-*.md` do `subtask-executor.ts` (ładowanie z plików).
2. Egzekwować `allowedTools` w harnessie (fizyczny sandbox narzędziowy per rola).
3. **Przejście subagentów testów/terminala w `smart-router.ts` na modele chmurowe** (tanie/szybkie zamiast lokalnej Ollamy).
4. Embeddingi pozostają lokalne na Ollamie (`bge-m3`).
5. **Wymogi pod optymalny Parallel Work**:
   - Limit falowy (concurrency cap: 2–4 workerów naraz).
   - Ścisła rozłączność plików (disjoint targetFiles dla `file-editor`, brak wyścigów i `git index.lock`).
   - Unikalny `attemptId`/`runId` per subtask w harnessie.
   - Odporność na rate limity API chmurowych.

**✅ ZAMKNIĘTE 23.08.2026, punkty 1–4.** Realny `loadPrompt(role.promptTemplate)`
zamiast ad-hoc nagłówka; `generateOptions.activeTools = role.allowedTools`
faktycznie ogranicza wywoływalność narzędzi (dowód live na realnym
`TransientToolShelfProcessor` — `coding_write_file_tracked` nigdy nie staje
się wywoływalny dla `terminal`, nawet po pozornie udanym `load_tool`); przy
okazji naprawiony bug nazewnictwa (`workspace_*` nigdy nie pasowało do
realnych kluczy `view`/`find_files`/…); terminal/qa przeniesione na chmurę w
**obu** niezależnych producentach decyzji o modelu (`smart-router.ts` +
`findOfflineFallback`). Brama: `check:subagent-roles-enforced`.
**Punkt 5 (Parallel Work) NIE zrobiony** — należy do epiku równoległego
dispatchu (J2/F8/G8), nie do tej sesji.

### Z6 — V2 nie podaje `taskId` ani `repoPath`
Prompt V2 to `goal + upstream + kontrakt headless`. Wszystkie narzędzia
worktree/artefaktu biorą `taskId` jako argument — legacy wstrzykuje go jawnie
(„## Identyfikator zadania: …"), na V2 model by go wymyślił. Bez `repoPath`
precontext dopisuje `repoPath_missing` i **pomija mapę repo oraz checkpoint**.

### Z7 — cztery rozjechane kopie listy „bezpiecznych komend"
`code-workspace.ts` (zawiesza), `harness-policy.ts` (blokuje w `enforce`),
`code-task-artifacts.ts` ×2 (odmawia). `npm run check:all` jest dozwolone w trybie
tła `coding_run_test`, zabronione w pierwszym planie i w workspace.
`npm run build` i `npx vitest/jest/eslint` przechodzą w polityce, a zawieszają
w workspace.

### Z9 — długie narzędzie jest dla liveness nieodróżnialne od zawieszenia *(ZMIERZONE 2026-08-12, canary A)*

Pierwszy `code_search` w tym repo trafił na **zimny cache embeddingów** i zaczął
embedować całe drzewo WEWNĄTRZ jednego wywołania narzędzia, ~10 chunków/s.
Pracował przez cały czas (licznik 1410 → 2711 w cztery minuty), ale wywołanie
narzędzia **nie emituje zdarzenia liveness**, więc watchdog zobaczył osiem minut
ciszy i uciął próbę. Retry zaczynał tę samą rozgrzewkę od nowa.

```
3 zadania · 3 próby · 3 × TIMED_OUT · 0 znaków wyniku · job FAILED
```

To jest dokładnie ta awaria, której liveness miał zapobiegać („tnij za ciszę,
nigdy za długą pracę") — pokonana przez jedyny przypadek, którego nie widzi.

**Mechanizm istniał i nie miał wywołań.** `touchCurrentRunLiveness()` jest
napisany dokładnie do tego i wyeksportowany z `run-budget.ts`; `grep` po całym
`src/` dawał **zero** wywołań poza własną definicją. Zbudowane, poprawne,
niewpięte — ten sam kształt co martwy kanał artefaktów, nieosiągalny liveness
i `plan_steps`. **Szósty raz.**

**Naprawa ma dwie połowy, bo każda sama zostawia awarię:**
1. pętla embeddingów **zgłasza, że pracuje** (`touchCurrentRunLiveness` w środku
   pętli, nie raz przed nią — watchdog mierzy przerwę MIĘDZY zdarzeniami);
2. jedno wywołanie robi **ograniczony wycinek** rozgrzewki (`MAX_EMBEDS_PER_CALL`),
   odpowiada tym, co ma, i **mówi, że indeks się rozgrzewa** (`indexWarming`,
   `chunksPendingEmbedding`). Chunk ponad budżet jest mimo to ZAPISANY, więc
   następne wywołanie kontynuuje, zamiast zaczynać od tego samego miejsca.

Brama: `check:long-tool-liveness` (5 asercji, w tym umiejscowienie wywołania
wewnątrz pętli i to, że odroczony chunk trafia do zapisu).

### Z10 — sekwencja `plan_steps` rozjeżdżała zakres autora i recenzenta *(2026-08-17, złapane PRZED canary)*

Na V2 job może być SEKWENCJĄ: napisz poprawkę, potem ją zrecenzuj. Każdy krok to
**osobne zadanie z własnym `taskId`**. Zakres oparty na `taskId` kroku dałby
recenzentowi inny zakres niż autorowi — szukałby diffu pod identyfikatorem,
pod który nic nie zapisano, i zgłosiłby „brak worktree" dla pracy, która istnieje.

Legacy rozstrzyga to od zawsze: `repo-maintenance-workflow` przeprowadza **jeden**
`taskId` przez diagnose → patch → review → merge, a `delegate-task` używa jednego
id na delegację. Czyli **legacy „task" = V2 JOB, nie V2 task**.

Zakres bierze teraz job (z wątku `orch-v2-job:<id>`), a `taskId` kroku jest
fallbackiem dla legacy, gdzie już jest jednostką pracy. Prefiks `heal-` przeżywa,
więc uprawnienie do merge'u autohealowego działa bez zmian.

Brama: `check:coding-task-scope` (7 asercji: autorytet runu, wspólny zakres dwóch
kroków jednego joba, izolacja dwóch jobów, nietknięte legacy, prefiks `heal-`).

### Z8 — brak bramy domenowej
Osiem innych domen ma `check:*-domain`. Coding i review nie mają żadnej.

---

## ZROBIONE

| data | co | dowód |
|---|---|---|
| 2026-08-12 | `check:prompt-tool-names` — prompt może nazywać tylko narzędzia, które model widzi; klucze czterech agentów domeny przepisane na id | pierwszy pomiar: 56 nieosiągalnych nazw w 8 agentach; po naprawie prompty `coding/` czyste, `check:all` 62 sekcje exit 0 |
| 2026-08-12 | modele domeny ujednolicone na `deepseek-v4-pro` | `workflowAssignments.coding` |
| 2026-08-12 | **Z6** — `taskId` bierze się z RUNU, nie z tego, co wpisał model (107 miejsc, jeden helper + hak `normalizeInput` w kopercie, żeby polityka i wykonanie widziały to samo); `repoPath` i precontext codingu w rejestrze capability | `check:capability-precontext` +2 asercje |
| 2026-08-12 | **Z1** — run bezludny nie dostaje narzędzi, które zawieszają; allowlista liczy też narzędzia workspace'u, żeby nie odebrać `view`/`lsp_inspect`; fail-open gdy nie da się ich wyliczyć | `check:headless-approval` (5 asercji, oblewa bez zmiany) |
| 2026-08-12 | **Z3** — `coding_apply_patch` egzekwuje uprawnienie, które deklarował: autoheal+`AUTOHEAL_AUTO_PROMOTE` albo jednorazowy token; permit wyciągnięty do jednego miejsca dzielonego z capability-build | `check:live-merge-permission` (6 asercji, 2 na żywym RS) |
| 2026-08-12 | **Z7** — jedna klasyfikacja komend zamiast czterech rozjechanych kopii; `npm run build`, `npx vitest`, `node --check`, `npm run check:*` przechodzą teraz wszędzie tak samo | `check:command-approval-gate` +4 asercje, w tym antydryfowa |
| 2026-08-12 | **Z2** — trzej recenzenci przestali być niewidzialni: karty na Agent Boardzie (21 zamiast 18), wpisy w `AGENT_IDS`, modele w manifeście, sufit 25 kroków (mieli domyślne 5 Mastry), `codeReviewAgent` dostał `system_delegate_task`. Od teraz obejmuje ich KAŻDY audyt — `audit:agent-readiness` 21/21, `check:deliverable-capability`, `check:agent-board-sync` | audyty i bramy wymusiły uzupełnienie trzech map, które ich nie znały |
| 2026-08-17 | **odświeżanie grafu graphify zweryfikowane u źródła**: `core.hooksPath=scripts/git-hooks`, hook `post-commit` odpalił `graph-refresh.sh` w tle, `graph.json` przyrósł o 63 KB, a symbole z tej sesji przeszły z 0 na 9-10 zależności. Wyzwalaczem jest COMMIT — dlatego podczas długiej pracy bez commita graf się starzeje i agent widzi pustkę (tak było w canary A) | `stat` + `runGraphifyAffected` przed i po |
| 2026-08-17 | **canary E (recenzja) — `TERMINAL/COMPLETED`**, 3 zadania (rodzic + 2 kroki), oba kroki `SUCCEEDED`, 2 próby OK. Model sam zaplanował `codingAgent→codeReviewAgent`; recenzent to OSOBNY run z własnym toolsetem (18 narzędzi vs 48 autora). Werdykt **APPROVE** z trzema realnymi uwagami. Zweryfikowane u źródła: `isSameRoot` w worktree 1×, w live **0×**, HEAD `a281d36` niezmieniony, `verdict=approve` w `code_task_artifacts` | odczyt z bazy + `grep` + `git log` |
| 2026-08-17 | **Z10 potwierdzone live**: worktree i artefakt kluczowane na `job_3c0d49bd-…` (ID JOBA), więc recenzent — osobne zadanie — trafił w zakres autora. Bez tej zmiany zgłosiłby brak worktree dla pracy, która istnieje | `git worktree list` + `code_task_artifacts.taskId` |
| 2026-08-17 | **Z11 — telemetria przypisywała cudzą pracę codingowi.** `extractToolMetadata` zwracał `agentId: undefined` dla narzędzia wywołanego bez tego argumentu, co NADPISYWAŁO prawdziwe id z kontekstu runu, a łańcuch fallbacku kończy się na `CODING_AGENT_ID`. Efekt: wszystkie wywołania RECENZENTA zapisane jako `codingAgent`. Nic nie padło — i to jest kosztowne, bo psuje zapis kto co zrobił, z którego czyta każda późniejsza diagnoza | `check:headless-approval` +1 asercja (oblewa bez naprawy) |
| 2026-08-17 | **mapa dwóch trybów pracy** — własny kod (worktree/canary/blue-green) vs nowy projekt (bez worktree, bez canary, wolne commity); plus rozbicie trybu 1 na trzy cele: autoheal, dobudowa narzędzi, zwykła praca. Wybór trybu jest wyłącznie promptowy, bez routingu | odczyt kodu, sekcja „DWA TRYBY PRACY" |
| 2026-08-17 | **Z10** — zakres pracy codingu to JOB, nie krok; bez tego recenzent w sekwencji nie widziałby worktree autora. Złapane rozumowaniem przed canary, nie po awarii | `check:coding-task-scope` (7 asercji) |
| 2026-08-17 | **dziura prefiksowa w strażniku projektów zewnętrznych** — `../app-evil/x.ts` przechodził, bo porównanie było bez separatora. Poprawna implementacja istniała w `harness-policy.ts` prywatnie; wyciągnięta do `lib/path-containment.ts` | `check:external-project-isolation` (7 asercji) |
| 2026-08-17 | **martwy Workspace projektu zewnętrznego** — tworzony z LSP, sandboxem i bramkami, `project.workspace` bez ani jednego konsumenta. Siódmy przypadek wzorca „zbudowane i niewpięte". Udokumentowany, nie usunięty | `grep` po całym `src/` |
| 2026-08-12 | **canary B (worktree) — `TERMINAL/COMPLETED`**, 1 zadanie, 1 próba OK, 2 artefakty. Sekwencja: worktree → `coding_write_file_tracked` → `npx tsc --noEmit` **przeszedł** → artefakty → **worktree i gałąź usunięte**. Zweryfikowane u źródła: HEAD live `699bd08` NIEZMIENIONY, `isCodingTaskScoped` w live 0×, w worktree 1×, zero gałęzi `task-*`. **Zero merge'u — dokładnie jak w zleceniu** | odczyt z bazy + `git log`/`git worktree list`/`grep` |
| 2026-08-12 | **odmowa zamiast zawieszenia — dwa niezależne trafienia live**: canary A `echo …`, canary B `cd … && git diff`. Obie odrzucone z komunikatem nazywającym klasę komendy; **oba runy poszły dalej i skończyły sukcesem**. W canary B agent po odmowie natychmiast sięgnął po `coding_run_test` z `git diff` — czyli komunikat był WYKONALNY, nie ślepym zaułkiem | `tool_executions` (status `blocked`) |
| 2026-08-12 | **uczciwość raportu pod presją**: `git diff` w worktree był pusty, bo plik nie istnieje w HEAD. Agent to zauważył, NAZWAŁ przyczynę w `blockersOrRisks` i włożył realny patch do artefaktu zamiast zgłosić pustkę albo zmyślić diff | `art-3c879f6f` + pole `blockersOrRisks` |
| 2026-08-12 | **canary A runda 2 — `TERMINAL/COMPLETED`**, 1 zadanie, 1 próba OK, 8154 zn., 1 artefakt, zero replanów. **Raport zweryfikowany u źródła:** definicja w `coding-task-scope.ts:32` (dokładnie), 1 bezpośredni caller w `code-task-artifacts.ts:205` (dokładnie), `requireCodingTaskId` 9+7+5=21 przy deklarowanym „~22". Analiza kodu, który powstał w TEJ sesji, więc nie z wiedzy modelu. Zero worktree, zero zapisów w repo | odczyt z bazy + weryfikacja `grep` u źródła |
| 2026-08-12 | **Z6 na poziomie narzędzia**: w argumentach zablokowanego `coding_run_test` widnieje `taskId: task_9d7c6e52-…`, czyli identyfikator zadania orkiestracji — model go NIE wymyślił, `requireCodingTaskId` wziął go z runu | `tool_executions.inputPreview` |
| 2026-08-12 | **Z9** — długie narzędzie zgłasza pracę i ogranicza własną rozgrzewkę; `touchCurrentRunLiveness()` dostał pierwszego wywołującego w historii | `check:long-tool-liveness` (5 asercji) |
| 2026-08-12 | **canary A (czytający) — FAILED, i to jest wynik**: 3 próby × TIMED_OUT, zero wyniku. Złapał Z9, którego nie wyłapałby żaden test. Potwierdził za to LIVE: Z1 (`withholding execute_command`, 47 z 48 narzędzi zostało), Z6/K1 (`precontext repoMap=true checkpoint=true, suppressed: []`), K5b (agent wołał `code_search` pod nową nazwą) | log canary + `agent_events.precontext_injected` |
| 2026-08-12 | **karty wewnętrzne** — `internal: true` na Agent Boardzie: pomocnik domenowy zostaje celem delegacji i podlega audytom, ale znika z rosteru meta, bo meta ma do niego trasowanie ZABRONIONE. Objęci: trzej recenzenci + `n8nMcpEngineer`, którego karta zabraniała delegacji spoza architekta, a mimo to kosztował miejsce w prompcie na każdej turze | `check:meta-prompt-size` −26,1% (przed dodaniem kart granica pękła na −22,7%); `check:agent-board-sync` sprawdza obie strony |
| 2026-08-12 | **J8/J9/H5** — `codingAgent` dostał `system_run_worker`, `system_delegate_task`, `system_request_approval`, `listExternalProjects`; sześć kopii strażnika samodelegacji zastąpione jedną regułą | `check:delegation-hardening-tools` +9 asercji |
| 2026-08-24 | **audyt zasięgu Graphify w projektach zewnętrznych (Tryb 2)**: potwierdzono, że Graphify czyta wyłącznie graf `src/mastra/graphify-out/graph.json` głównego repo i nie indeksuje automatycznie obcych projektów pod `/projekty/agent-projects/`. Wpisano rekomendację na przyszłość: dla dużych projektów zewnętrznych parametryzować `graphify_*` o `projectPath`/`graphPath` oraz opcjonalny build grafu w katalogu projektu | audyt kodu `services/graphify.ts`, `external-projects-tools.ts` i katalogu `agent-projects` |

