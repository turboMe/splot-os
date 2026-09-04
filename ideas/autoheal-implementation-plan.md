# Autoheal — Plan Implementacyjny (wykonawczy)

> Plan wykonawczy do [autoheal-update.md](./autoheal-update.md). Bazuje na audycie obecnej
> implementacji. Każdy etap jest osobny, feature-flagowany i ma test antyregresyjny bez LLM.
> **Zasada nadrzędna:** rollback i utrzymanie dostępności runtime NIGDY nie zależą od LLM ani Mastry.
>
> **Legenda statusów:** `[ ]` todo · `[~]` w toku · `[x]` zrobione

---

## Kontekst / fakty bazowe (zweryfikowane w kodzie)

- Baza Mongo: `agentforge` (z `MONGODB_URI`, `getDb()` → `client.db()`). **NIE** `mastra_agents`.
- Sygnały błędów runtime: kolekcja `agent_events` (typy `task_failed`, `tool_error`, `llm_call_failed`, `run_failed`), plus tickety `auto_healing_tickets`.
- Detekcja: `services/global-error-handler.ts` → `services/error-collector.ts` (ticket `heal-<sig>-<ts>`).
- Workflow: `workflows/repo-maintenance.ts` (diagnose → patch → review → decisionGate[suspend na human] → deployAndVerify).
- Worktree per-task: `tools/dev/code-worktree.ts` → `agentic-agents-worktrees/<taskId>`, branch `task-<taskId>`.
- Deploy/swap/rollback: `scripts/deploy-blue-green.sh`, `scripts/watchdog.sh`, `deploy.config.json`.
- Health: `/deploy/health` w `src/mastra/index.ts` (zwraca version/slot/port/pid).
- Stan na dysku w chwili audytu: 3 fizyczne worktrees, 11 branchy `task-*` → 8 osieroconych.

---

## Etap 0 — Quick fixes (niskie ryzyko, natychmiastowa wartość)  `[x]`

Cel: usunąć martwe i mylące mechanizmy zanim ruszymy infrastrukturę.
**Status: ZROBIONE 2026-06-08** — tsc czyste, watchdog/config zwalidowane, docs zaktualizowane.

0.1 `[x]` **Martwy `error_logs` w watchdogu.** `scripts/watchdog.sh` pyta
   `getSiblingDB('mastra_agents').getCollection('error_logs')` — zła baza i zła kolekcja → zawsze 0.
   Zmiana: pytać `agentforge.agent_events` o `status:'error'` w typach
   `{task_failed,tool_error,llm_call_failed,run_failed}` z ostatnich N minut.
   Dodać też fallback na `auto_healing_tickets` (status pending/in_progress utworzone po starcie nowego Live).
   Config `deploy.config.json`: `watchdog.mongoDb`, `watchdog.mongoErrorCollection: agent_events`.

0.2 `[x]` **Fałszywe „healed" na dry-run.** `repo-maintenance.ts` (`deployAndVerify`) rozwiązuje ticket
   również gdy wynik to `DRY RUN COMPLETE` (brak realnego swap, live nadal z bugiem).
   Zmiana: `resolveTicket` tylko gdy `isSwapSuccess` (realny swap), nie na dry-run.

0.3 `[x]` **Przeterminowany alert webhook.** `deploy.config.json.watchdog.alertWebhook` ma zahardkodowany
   stary URL trycloudflare (rotuje przy restarcie). Zmiana: watchdog czyta bazę webhooka z ENV
   `N8N_PUBLIC_WEBHOOK_BASE_URL` (+ ścieżka `/webhook/telegram-reply`), config tylko jako fallback.

0.4 `[x]` **Stabilizacja dedupu sygnatury.** `ticketId = heal-<sig>-<ts>` zawiera timestamp →
   ta sama sygnatura po `failed/expired` tworzy nowy ticket → nowy worktree. To realne źródło
   mnożenia worktrees. Zmiana minimalna (pełne rozwiązanie w Etapie 1): rozszerzyć dedup w
   `error-collector.ts` o stany `failed` w oknie `ERROR_COLLECTOR_RETRY_BACKOFF_MS` i twardy limit
   prób na sygnaturę (`ERROR_COLLECTOR_MAX_ATTEMPTS_PER_SIGNATURE`).

0.5 `[x]` **Helper sprzątania osieroconych worktrees/branchy (bezpieczny).**
   Nowy `scripts/autoheal-prune-worktrees.sh`:
   - `git worktree prune` (nieszkodliwe),
   - listuje branche `task-*` bez aktywnego worktree,
   - usuwa TYLKO te w pełni zmergowane do `master` (`git branch --merged`),
   - resztę raportuje do ręcznej decyzji. Domyślnie `--dry-run`; usuwanie wymaga `--force`.
   **Nie uruchamiamy destrukcyjnej części automatycznie.**

**Test antyregresyjny 0:** `scripts/with-node.sh npx tsc --noEmit` czyste; watchdog liczy realne błędy
(wstrzyknąć sztuczny `agent_events` error i sprawdzić licznik); dry-run nie rozwiązuje ticketa.

**Docs:** zaktualizować `docs/BLUE-GREEN-DEPLOYMENT.md` i `docs/SELF-HEALING-ERROR-COLLECTOR.md`.

---

## Etap 1 — Autoheal Cycle Store + plik stanu  `[x]`

Cel: jedna jednostka grupująca problem (sygnatura) zamiast luźnych ticketów; trwały stan poza procesem.
**Status: ZROBIONE 2026-06-08** — tsc czyste, smoke (1 cykl / 2 obserwacje) przeszedł, docs `AUTOHEAL-CYCLES.md` dodane.

1.1 `[x]` Kolekcje: `autoheal_cycles`, `autoheal_attempts`, `autoheal_runtime_events` (+ indeksy w `lib/mongo-indexes.ts` — to żywy `ensureIndexes` wpięty w `index.ts`, NIE `lib/mongo.ts`).
   Model `AutohealCycle` wg `autoheal-update.md` w nowym `lib/autoheal-cycles.ts` (status machine + `TERMINAL_CYCLE_STATUSES`).
1.2 `[x]` Plik krytyczny `.deploy/autoheal-state.json` (stableCommit, activeSlot, activePid, activePort, lastPromotedAt + pola promote/rollback dla Etapu 5).
   Moduł `services/autoheal-state.ts` (read/write ATOMOWY tmp+rename, niezależny od Mongo, ENV `AUTOHEAL_STATE_FILE`/`AUTOHEAL_RUNTIME_DIR`).
1.3 `[x]` `error-collector.ts`: `getOrCreateCycle(signature)` wołane PRZED cooldown/dedup — obserwacja zapisana zawsze.
   Ta sama sygnatura z aktywnym cyklem = dopisanie obserwacji (`autoheal_runtime_events`), bez nowego worktree. Ticket linkowany do cyklu (`linkTicketToCycle`). Warstwa niekrytyczna (try/catch, healing leci dalej gdy Mongo padnie).
1.4 `[x]` Endpointy diagnostyczne (read-only): `/deploy/autoheal-cycles`, `/deploy/autoheal-attempts/:cycleId`,
   `/deploy/runtime-status`. Rollback NIE zależy od nich (supervisor czyta plik stanu bezpośrednio).

**Test antyregresyjny 1:** dwa błędy tej samej sygnatury → 1 cykl, 2 obserwacje, 0 nowych worktree. **✅ przeszedł** (`_smoke.mjs`, sprzątnięty).
**Docs:** nowy `docs/AUTOHEAL-CYCLES.md`. **✅**

---

## Etap 2 — Persistent Repair Lane (likwidacja mnożenia worktrees)  `[x]`

Cel: jeden długowieczny worktree dla autoheal zamiast worktree-per-ticket.
**Status: ZROBIONE 2026-06-08** — tsc czyste, smoke (3 cykle → 1 katalog/1 branch, 0 przyrostu) PASS. Flaga `AUTOHEAL_REPAIR_LANE_ENABLED` (default OFF).

2.1 `[x]` Stały worktree `agentic-agents-repair`, branch `autoheal/repair` (tworzony raz, NIGDY nie usuwany).
   `services/autoheal-repair-lane.ts`: `getRepairLanePath` (ENV `AUTOHEAL_REPAIR_WORKTREE`), `ensureRepairLane`, `acquireRepairLane`.
2.2 `[x]` `tools/dev/code-worktree.ts`: `coding_init_worktree` dla tasków `heal-*` (gdy flaga ON) używa repair lane zamiast
   tworzyć nowy worktree. Reset `--hard <stableCommit>` + `clean -fdx -e .env -e node_modules` na starcie cyklu.
   `coding_remove_worktree` dla lane tylko ODPINA artifact (bez `worktree remove`/`branch -D`).
2.3 `[x]` Per-task worktree (`task-<id>`) zostaje dla zwykłego coding-agenta. Repair lane dotyczy WYŁĄCZNIE `heal-*`.
   Gdy lane zajęty przez inny aktywny task → fallback na per-task worktree (brak korupcji cudzej pracy).
2.4 `[x]` Artifact dostaje `cycleId` + `autohealLane:true` + `stableCommit` przy pozyskaniu lane (scope ledgeru = cykl).

**Test antyregresyjny 2:** 3 kolejne cykle autoheal → wciąż jeden katalog `agentic-agents-repair`,
jeden branch `autoheal/repair`, zero przyrostu w `agentic-agents-worktrees/`. **✅ PASS** (smoke bash, sprzątnięty).
**Docs:** `docs/AUTOHEAL-REPAIR-LANE.md`. **✅**

---

## Etap 3 — Supervisor poza Mastrą (observe-only)  `[x]`

Cel: właściciel promote/rollback, który żyje, gdy Mastra umiera.
**Status: ZROBIONE 2026-06-08** — supervisor obserwuje realny runtime (:4111), pisze schemat-zgodny
stan, ścieżka `down` zweryfikowana bez zabijania żywego runtime. tsc nie dotyczy (bash).

3.1 `[x]` `scripts/autoheal-supervisor.sh` (mały, bez importu kodu Mastry): czyta PID/port `:4111`,
   `/health`, `/deploy/health`, zapisuje `.deploy/autoheal-state.json`. Tryb observe — nic nie zabija.
3.2 `[x]` Flagi ENV: `AUTOHEAL_SUPERVISOR_ENABLED=false`, `AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=true`,
   `AUTOHEAL_SUPERVISOR_INTERVAL_SECONDS=15`, `AUTOHEAL_CANARY_SECONDS=60`, `AUTOHEAL_MAX_ATTEMPTS=2`.
3.3 `[x]` Launcher: `npm run autoheal:supervisor` (+ `:once`, `:status`). Systemd/nohup — opcjonalny,
   opisany w docs (pętla z `trap` na SIGINT/SIGTERM, gotowa pod nohup/systemd).

**Test antyregresyjny 3:** `[x]` supervisor poprawnie odczytuje realny stan runtime i pisze plik stanu
(PID 8677, slot, version, `state:stable`); symulacja martwego runtime (config → nieużywany port) →
supervisor zapisuje `state:down`, `activePid:null`, **w observe nie reaguje** (brak kill/start/swap).
**Docs:** `docs/AUTOHEAL-SUPERVISOR.md` (utworzony).

---

## Etap 4 — Rozdzielenie deploy-blue-green na idempotentne kroki  `[x]`

Cel: atomowe, testowalne operacje zamiast jednego dużego skryptu.
**Status: ZROBIONE 2026-06-08** — 6 kroków + wspólny `lib.sh` + cienki orchestrator;
build kandydata zweryfikowany bez dotykania `:4111`. Sloty runtime z `git archive` (deterministycznie).

4.1 `[x]` Wydzielone do `scripts/autoheal/`: `build-candidate`, `start-candidate`, `verify-candidate`,
   `promote-candidate`, `rollback-to-stable`, `mark-promoted` (+ `lib.sh`). Każdy idempotentny,
   każdy z jednoznacznym kodem wyjścia.
4.2 `[x]` Sloty runtime `.deploy/runtime/slot-a|slot-b` jako **deterministyczne** kopie z commita
   (`git archive <commit>` — dokładne drzewo, bez `.git`/cruft; `node_modules` symlink ze source;
   `.deploy-version` = SHA). Source repo = KANON commitów, nie artefakt uruchomieniowy.
4.3 `[x]` `deploy-blue-green.sh` zyskał opt-in delegację (`AUTOHEAL_USE_STEPS=true` → `run-deploy.sh`);
   domyślnie monolit działa bez zmian (zgodność wstecz). Orchestrator: build→start→verify[→promote→mark].

**Test antyregresyjny 4:** `[x]` każdy krok osobno; `build-candidate HEAD slot-b` materializuje slot i
   buduje (idempotentny re-build = SKIP), a `:4111` (PID 353684 / `90c9bcc`) pozostaje nietknięty przez
   cały build i start; `start-candidate slot-b :4222` startuje osobny proces; `verify-candidate`
   **poprawnie zwrócił FAIL** (nie skłamał „healthy"). Live nietknięty.

> ✅ **NAPRAWIONE (2026-06-08):** bundel `.mastra/output/index.mjs` rzucał `unhandledRejection:
> "Cannot determine intended module format because both require() and top-level await are present"`
> → proces żył, ale **nie bind-ował portu** (utykał po `SkillRegistry init`). Przyczyna: 7 wolnych
> (FREE) wywołań `require()` w źródłach — Node 22 liczy je jako marker CJS, a obecność top-level
> `await` jako marker ESM → ambiguity. **Fix:** usunięto wszystkie FREE `require()` ze źródeł
> (`model-capabilities.ts`, `subtask-executor.ts`, `external-project-workspace.ts`, `repo-indexer.ts`):
> wbudowane moduły → statyczne `import`, `gpu-guard` → statyczny `import` (brak cyklu),
> opcjonalny tree-sitter → **związany** `require` z `createRequire(import.meta.url)` (zachowuje
> graceful degradation, ale nie jest już markerem CJS). Po rebuildzie bundel jest jednoznacznie ESM:
> startuje, bind-uje port i `/health` zwraca `{"success":true}` (zweryfikowane na :4333, `tsc --noEmit`
> czysty, live `:4111` nietknięty). Etap 5 (promote/canary) ma teraz bind-owalnego kandydata.

**Docs:** `docs/BLUE-GREEN-DEPLOYMENT.md` rozszerzony o sekcję „Idempotentne kroki (Etap 4)".

---

## Etap 5 — Promote + Canary 60s + deterministyczny rollback  `[x]`

Cel: bezpieczne przełączenie z auto-powrotem, w pełni po stronie supervisora.

5.1 `[x]` Pre-promote: zapis `.deploy/autoheal-state.json` (stable/candidate/previousPid/rollbackDeadline).
   → `promote-candidate.sh` zapisuje pre-swap (`candidateCommit/previousSlot/previousPid/rollbackDeadline/state=promoting`).
5.2 `[x]` Canary 60s, interwał 2–5s, agresywny: `/health`, `/deploy/health`, PID alive, brak restart-loop,
   brak `EADDRINUSE`, brak eksplozji `task_failed/tool_error` w `agent_events`.
   → nowy `scripts/autoheal/canary-watch.sh` (sonda Mongo BEST-EFFORT — Mongo down ≠ FAIL).
5.3 `[x]` Rollback path bez LLM/Mastry (z gotowego backupu output + PID).
   → `rollback-to-stable.sh` (z `.deploy/rollback/latest`), wpięty w `run-deploy.sh` i `promote-candidate.sh`.
5.4 `[x]` **Test sztucznej awarii:** celowo zepsuty candidate → supervisor wraca na stable automatycznie.
   → `scripts/autoheal/test-artificial-failure.sh` (sandbox, porty 4555/4556, REALNY :4111 nietknięty).
   Scenariusz A (nie bind-uje) + B (umiera w canary) — **oba PASS**, rollback przywrócił stable.
5.5 `[x]` Włączyć realny swap dla autoheal (zdjąć zależność od `confirmMerge` człowieka w trybie autoheal —
   zostaje gate tylko dla zadań użytkownika; autoheal promuje po canary).
   → supervisor `--promote [ref] [--dry-run]` (gated `AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=false`, deleguje do
   `run-deploy.sh`); workflow `decision-gate` pomija ludzką bramkę tylko dla `heal-*` przy `AUTOHEAL_AUTO_PROMOTE=true`.

**Test antyregresyjny 5:** macierz z `autoheal-update.md` (candidate nie startuje / health nie odpowiada /
pada po promote / zły port / Mongo down / Mastra down → stable nietknięty albo czysty rollback).
→ pokryte przez `test-artificial-failure.sh` (A: nie startuje, B: pada po promote) + best-effort sonda Mongo
(Mongo down nie wywraca canary). `tsc --noEmit` czysty.
**Docs:** `docs/AUTOHEAL-PROMOTE-ROLLBACK.md`.

---

## Etap 6 — Domknięcie cyklu (sync source + reset repair lane)  `[x]`

Cel: po sukcesie source = działająca wersja, repair lane czysty, cykl powtarzalny.

6.1 `[x]` Po canary: `candidateCommit` → `stableCommit`. Sync kanonu:
   `git -C agentic-agents merge --ff-only <candidateCommit>` (lub PR-merge gdy `AUTOHEAL_GITHUB_PR_MODE`).
   → `scripts/autoheal/sync-canon.sh` 6.1: ff-only (NIGDY force; gdy nie da się ff → exit 1, kanon nietknięty).
     Tryb PR: `fetch origin/<branch>` + `merge --ff-only origin/<branch>`. Odmawia merge przy detached HEAD
     lub niezacommitowanych zmianach kanonu.
6.2 `[x]` Reset repair lane: `git -C agentic-agents-repair reset --hard <newStable> && clean -fdx`.
   → sync-canon 6.2: `checkout autoheal/repair` + `reset --hard` + `clean -fdx -e .env -e node_modules`.
     Brak lane = pomiń (TS utworzy na starcie cyklu). Błąd resetu → exit 2 (kanon już zsynchronizowany).
6.3 `[x]` Inwariant po promocji: `runtimeVersion == stableCommit == sourceHEAD` (twardy assert, blokada gdy rozjazd).
   → sync-canon 6.3: dla slotów deploy (slot-a/slot-b) twardy assert; rozjazd → exit 1 + `state=invariant_violation`,
     Live NIE ruszany. Dla dev/`default` tylko ostrzeżenie (dev żyje przez `mastra dev`, nie z kanonu).
     `runtimeVersion` z `.deploy-version` aktywnego slotu (fallback `/deploy/health`).
6.4 `[x]` Runtime pozostaje na slocie deploy; powrót na kanon tylko przez bezpieczny restart/proxy swap.
   → sync-canon nic nie restartuje; podłączony w `run-deploy.sh` po `mark-promoted` za flagą
     `AUTOHEAL_SYNC_CANON` (domyślnie OFF); jego porażka NIE wywraca udanego deployu (Live już działa).

**Test antyregresyjny 6:** `scripts/autoheal/test-cycle-closure.sh` (`npm run autoheal:test:closure`) —
sandbox (mktemp): tymczasowe repo-kanon + repair lane + stan, REALNE repo/Live nietknięte.
A) inwariant spełniony → kanon ff→candidate, lane czysty, exit 0; B) rozjazd runtime↔source na slocie deploy →
exit 1 + `state=invariant_violation`. **Oba scenariusze PASS.**
**Docs:** `docs/AUTOHEAL-CYCLE-CLOSURE.md`.

---

## Etap 7 — Retry loop + limity + lokalny fallback  `[x]`

Cel: kontrolowane ponawianie bez nieskończonej pętli build→promote→rollback.

7.1 `[x]` Po rollbacku: zapis `failureReason/logs/healthTrace/exitCode` do `autoheal_attempts`, nowy `attemptId`.
   → `scripts/autoheal/retry-deploy.sh` po każdej próbie append do `.deploy/autoheal-attempts.jsonl`
     (`attemptId`, `attempt`, `commit`, `exitCode`, `failureReason`, `ts`) + `state_merge`
     (`attemptCount`, `lastAttemptId`, `candidateCommit`). Plikowo (Mongo-niezależnie) — to ono
     egzekwuje limit. Pola w `services/autoheal-state.ts` (`retrying`/`failed_needs_human`).
7.2 `[x]` Limity: `AUTOHEAL_MAX_ATTEMPTS`, backoff, klasyfikacja fatalnych błędów, stan `failed_needs_human`.
   → retry-deploy: limit `AUTOHEAL_MAX_ATTEMPTS` (domyślnie 2), `AUTOHEAL_RETRY_BACKOFF_SECONDS`,
     klasyfikacja: rc=2 (rollback też padł) = FATALNY → natychmiastowy stop; rc=1 = retryowalny.
     Po wyczerpaniu prób → `state=failed_needs_human` (stable żyje). re-resolve commita co próbę.
7.3 `[x]` Lokalny fallback runner (Ollama) tylko gdy Mastra nie wstaje na stable — proponuje patch/testy,
   NIE robi promote/rollback (to zawsze supervisor).
   → `scripts/autoheal/local-fallback.sh` (gated `AUTOHEAL_LOCAL_FALLBACK_ENABLED`, domyślnie OFF):
     startuje TYLKO gdy stable `/health` nie odpowiada; pyta Ollama (`/api/generate`, twardy timeout)
     o diagnozę/patch → zapis do `.deploy/fallback/*.md` dla człowieka. NIGDY nie aplikuje ani nie
     promuje. Ollama down → best-effort skip (exit 0). Nie jest na krytycznej ścieżce dostępności.
7.4 `[~]` (Opcjonalnie) PR/GitHub jako tryb publikacji/audytu, nie warunek autoheal.
   → Flaga `AUTOHEAL_GITHUB_PR_MODE` obsłużona już w `sync-canon.sh` (Etap 6); pełny przepływ PR
     pozostaje opcjonalny i poza krytyczną ścieżką (świadomie nie wymuszany).

Podłączenie: supervisor `--promote-retry [ref]` (gated tą samą bramką `OBSERVE_ONLY=false`),
deleguje do `retry-deploy.sh`. npm: `autoheal:promote:retry`, `autoheal:test:retry`.

**Test antyregresyjny 7:** `scripts/autoheal/test-retry-loop.sh` (`npm run autoheal:test:retry`) — sandbox
(atrapa run-deploy via `AUTOHEAL_RUN_DEPLOY`, własny state/attempts-log, realny :4111 nietknięty):
A) każdy candidate pada → po `MAX_ATTEMPTS` `failed_needs_human`, N prób w logu, stable żyje;
B) 2. próba przechodzi → exit 0, `stable`, 2 próby; C) rc=2 (rollback padł) → fatalny stop, exit 2, 1 próba.
**Wszystkie scenariusze PASS.**
**Docs:** `docs/AUTOHEAL-RETRY-FALLBACK.md`.

---

## Kolejność i ryzyko

0 (low) → 1 (low, additive) → 2 (medium, gasi mnożenie worktrees) → 3 (observe, low) →
4 (medium) → 5 (high — promote/rollback) → 6 (medium/high — inwariant wersji) → 7 (logika pętli).

Nie wdrażać jednym refaktorem. Każdy etap pod flagą; do Etapu 5 włącznie wszystko działa w trybie
obserwacyjnym bez realnego przełączania produkcyjnego runtime.
