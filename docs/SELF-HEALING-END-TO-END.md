# Self-Healing — pełny cykl end-to-end

> Jak system samodzielnie naprawia własny błąd runtime: od wykrycia po wdrożenie
> na produkcję z canary, bez człowieka. Pierwszy pełny autonomiczny przebieg:
> 2026-07-23 (commit naprawy `e02b220`, promote potwierdzony canary 60 s).
>
> Dokumenty komponentów: [BLUE-GREEN-DEPLOYMENT](BLUE-GREEN-DEPLOYMENT.md),
> [AUTOHEAL-CYCLES](AUTOHEAL-CYCLES.md), [AUTOHEAL-PROMOTE-ROLLBACK](AUTOHEAL-PROMOTE-ROLLBACK.md),
> [AUTOHEAL-REPAIR-LANE](AUTOHEAL-REPAIR-LANE.md), [SELF-HEALING-ERROR-COLLECTOR](SELF-HEALING-ERROR-COLLECTOR.md).

## Przepływ (bez człowieka, gdy flagi ON)

```
runtime error (unhandledRejection/uncaughtException)
  → GlobalErrorHandler → ErrorCollector (dedup / cooldown / limity)
  → ticket heal-<sig> → repo-maintenance-workflow
     1. diagnose-and-plan   codingAgent diagnozuje (LLM), tworzy artifact + plan
     2. execute-patch       codingAgent pisze poprawkę w PER-TASK worktree
                            (bramka: pusty worktree → 1 retry → hard stop)
     3. execute-review      codeReviewAgent (OSOBNY model) → approve/needs_changes
                            (ma graphify_affected + code_search: blast radius)
     4. decision-gate       approve + AUTOHEAL_AUTO_PROMOTE →
                            mergeWorktreeToLive() DETERMINISTYCZNIE (git merge → master)
                            → resolveHealTicket() (healing = fix w źródle)
     5. deploy-and-verify   AUTOHEAL_AUTO_SWAP → deploy DETACHED (przeżywa self-swap):
                            build-candidate slot-b → start :4222 → verify health
                            → promote (zabij Live, start kandydata :4111, setsid)
                            → canary (okno obserwacji) → mark-promoted (stableCommit)
```

Efekt: `:4111` biega na naprawionym kodzie, master ma poprawkę, ticket resolved.

## Flagi (config/harness-flags + .env)

| Flaga | Domyślnie | Rola |
|---|---|---|
| `ERROR_COLLECTOR_ENABLED` | **false** | Główny zawór. false = błędy runtime NIE otwierają ticketów/cyklu. |
| `AUTOHEAL_AUTO_PROMOTE` | false | Pomija ludzką bramkę scalenia — **tylko dla `heal-*`**. Zadania usera zawsze wymagają zgody. |
| `DEPLOY_AUTO_SWAP` | false | Realny swap na :4111 (nie sam dry-run staging). |
| `AUTOHEAL_USE_STEPS` | false | Kroki idempotentne (run-deploy) zamiast starego monolitu. |
| `AUTOHEAL_REPAIR_LANE_ENABLED` | false→**true** | Jeden długowieczny worktree naprawczy. **Do pełnego swapu użyj false** (per-task worktree → czysty `git merge` do HEAD; repair lane resetowany do stableCommit rozjeżdża się z master). |
| `AUTOHEAL_SYNC_CANON` | false | **Zostaw OFF.** `mergeWorktreeToLive` już merguje kanon; sync-canon zrobiłby drugi merge. |
| `AUTOHEAL_SUPERVISOR_OBSERVE_ONLY` | true | Blokuje promote przez supervisora (osobna ścieżka od workflow). |

**Domyślny stan = wszystko OFF (bezpieczny).** Autoheal jest świadomie wyłączony przy
pracy nad kodem — inaczej wyłapywałby zmiany w edycji jako błędy.

## Jak uruchomić pełny test (Live przez system deploy, NIE `mastra dev`)

`mastra dev` (hot-reload, slot=default) i FULL SWAP (slot-based) **nie mogą współistnieć
na :4111** — swap zabija PID ze `slot-a.pid`, którego dev tam nie zapisuje. Live musi
być uruchomiony przez system deploy:

```bash
# 0. zatrzymaj dev; wstaw kontrolowany defekt (osobny commit, do cofnięcia)
# 1. flagi: ERROR_COLLECTOR_ENABLED, AUTOHEAL_AUTO_PROMOTE, DEPLOY_AUTO_SWAP = true;
#    AUTOHEAL_REPAIR_LANE_ENABLED = false
# 2. zbuduj i uruchom Live jako slot-a (PID → slot-a.pid, żeby promote go zabił):
bash scripts/autoheal/build-candidate.sh HEAD slot-a
cp .env ../.deploy/runtime/slot-a/.env          # Live czyta SWÓJ .env
bash scripts/autoheal/start-candidate.sh slot-a 4111
# 3. wywołaj defekt, obserwuj slot-a log + .deploy/logs/selfswap-*.log:
curl http://127.0.0.1:4111/deploy/defect-probe
```

Sukces: nowy Live PID ≠ stary na :4111, `CANARY ✅`, `MARK ✅`, `run-deploy COMPLETE`.
Po teście: flagi OFF, cofnij defekt, `mastra dev` z powrotem.

> Pułapki operacyjne: w nieinteraktywnej powłoce `mastra` nie jest na PATH —
> `PATH="$PWD/node_modules/.bin:$PATH" bash scripts/with-node.sh mastra dev`.
> `kill $(pgrep -f "mastra dev" | head -1)` zabija tylko JEDEN proces — łatwo
> nagromadzić kilka serwerów; weryfikuj `ss -ltn | grep 4111`.

## 11 blockerów wykrytych i naprawionych (2026-07-22/23)

Wzorzec: **większość to różnice dev↔build** — działało w `mastra dev`, nie w produkcyjnym
buildzie. Utrzymuj tę listę jako antyregresję.

| # | Objaw | Przyczyna | Commit |
|---|---|---|---|
| 1 | staging bundle nie startuje | slot trzymał `node_modules` z maja (build-candidate odpalał symlink tylko przy `! -e`) | `66b2dd3` |
| 2 | review nigdy się nie wykonuje | recenzent i codingAgent dzielili `threadId` (wątek należy do twórcy) | `46efd2e0` |
| 3 | „Exhausted all fallback models" | przebiegi naprawcze harnessu gubiły `threadId ?? taskId` | `af18fac` |
| 4 | pusty worktree → pętla review | brak bramki pustego worktree przed recenzją | `c128d8f` |
| 5 | każda komenda pyta o approval | gate czytał `args.command`; payload bywa `{context:{command}}` → `''` → default-deny | `6894f17` |
| 6 | „Could not find config for provider custom-deepseek" | build nie ładował `.env`; gateway-guard `if(process.env.KEY)` przy starcie modułu widział pusto | `4096f40` |
| 7 | mastra na v20 (konflikty) | `load_node` robił `nvm use 22 || true` — cichy fallback na nvm default v20 | `6f82c1d` |
| 8 | 0 zapisów agenta w buildzie | thread-scoped ObservationalMemory rzucała przy fallbacku modelu → exhausted | `caea600` |
| 9 | merge wisi na approval | merge delegowany do LLM; agent improwizował `git` przez execute_command (approval-gated) | `d650d5d` |
| 10 | `/scripts/deploy-blue-green.sh: No such file` | ścieżka liczona od cwd (slot dir), nie od repo | `6ab8c26` |
| 11 | swap ubijał własny deploy | self-swap: promote zabija Live, którego dzieckiem jest deploy (SIGPIPE) | `2908411`, `cda4663` |

## Znane ograniczenia (świadome)

- **Ticket resolve = po merge, nie po swap.** Healing jest zakończony gdy fix trafi do
  źródła; swap to osobny krok wdrożeniowy. Ticket i tak self-expiruje przez TTL.
- **Supervisor observe-only.** Promote uruchamia workflow (przez flagi), nie supervisor.
  Supervisor tylko obserwuje runtime i pisze `autoheal-state.json`.
- **Sync-canon OFF.** Kanon (master) jest już mergowany przez `mergeWorktreeToLive`.
- **Rollback/dostępność NIE zależą od LLM/Mongo** — deterministyczne skrypty +
  backup w `.deploy/rollback/latest`. Testy antyregresji: `autoheal:test:rollback`,
  `autoheal:test:closure`, `autoheal:test:retry` (pełna izolacja, :4111 nietknięty).

## Kluczowa lekcja

Cała **logika** cyklu przechodziła w `mastra dev` na długo przed produkcją. Realne
blokery leżały w **różnicach środowiska build vs dev** (ładowanie `.env`, wersja node,
observational memory, proces self-swap) — niewidoczne bez testu w prawdziwym slot-based
buildzie. Każdą nową zdolność autohealu weryfikuj w buildzie, nie tylko w dev.
