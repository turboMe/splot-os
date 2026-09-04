# Etap 5 — Promote + Canary 60s + deterministyczny rollback

Aktualizacja: 2026-06-08

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 5.
Buduje na idempotentnych krokach blue-green z Etapu 4 (zob. [BLUE-GREEN-DEPLOYMENT.md](BLUE-GREEN-DEPLOYMENT.md)).

## Cel

Bezpieczne przełączenie świeżo zbudowanego kandydata na Live (:4111) **z automatycznym
powrotem do stabilnej wersji**, gdy coś pójdzie nie tak — w pełni po stronie supervisora,
**bez zależności od Mastry/LLM/Mongo** dla samego rollbacku.

## Zasada nadrzędna

Rollback i utrzymanie dostępności runtime NIGDY nie mogą zależeć od Mongo, LLM ani
endpointów Mastry-jako-aplikacji. Dlatego:

- Stan żyje w pliku `.deploy/autoheal-state.json` (atomowy zapis), nie w Mongo.
- Backup stabilnego `output` + PID powstaje **przed** swapem.
- Sonda Mongo w canary jest **wyłącznie best-effort** — gdy Mongo jest nieosiągalny,
  sonda jest pomijana, **nie** wywraca canary.

## Przepływ (orchestrator `run-deploy.sh`)

```
build-candidate → start-candidate → verify-candidate
   └─(production)→ promote-candidate → canary-watch(60s) → mark-promoted
                        │                     │
                   post-swap verify       FAIL → rollback-to-stable
                   FAIL → rollback
```

| Krok | Plik | Rola | Kod wyjścia |
|------|------|------|-------------|
| promote | `scripts/autoheal/promote-candidate.sh` | backup Live → pre-swap state → swap na :4111 → post-swap verify (+ auto-rollback) | 0 ok / 1 rollback / 2 krytyczne |
| **canary** | `scripts/autoheal/canary-watch.sh` | **agresywne okno 60s** świeżego Live | 0 przeżył / 1 awaria |
| rollback | `scripts/autoheal/rollback-to-stable.sh` | przywraca stable z `.deploy/rollback/latest` (bez LLM/Mongo) | 0 ok / 1 brak backupu / 2 unhealthy |
| mark | `scripts/autoheal/mark-promoted.sh` | finalizacja: `stableCommit`+`lastPromotedAt`, czyści candidate | 0 |

## Canary (5.2) — sondy

`canary-watch.sh <port> [seconds] [logfile]`, interwał 2–5s, każda sonda to twardy warunek:

1. `/health` → `success:true` / `status:ok`
2. `/deploy/health` → zdrowy, **gdy endpoint istnieje** (brak odpowiedzi ≠ FAIL)
3. PID na porcie **żyje**
4. **brak restart-loopu** — PID na porcie nie zmienia się między sondami
5. log Live bez fatalnych sygnatur: `EADDRINUSE`, `AMBIGUOUS_MODULE_SYNTAX`, „Cannot determine intended module format"
6. **brak eksplozji błędów** w `agentforge.agent_events` (`task_failed/tool_error/llm_call_failed/run_failed`)
   — **best-effort**: brak `mongosh`/Mongo down → sonda pominięta (zwraca 0), canary NIE pada

Pierwsza spełniona awaria → exit 1 → caller wykonuje deterministyczny rollback.

## Pre-promote state (5.1)

`promote-candidate.sh` przed swapem zapisuje do `autoheal-state.json`:
`candidateCommit`, `previousSlot`, `previousPid`, `activePort`, `rollbackDeadline`
(now + `AUTOHEAL_CANARY_SECONDS`), `state=promoting`. Po udanym post-swap verify: `state=canary`.
`mark-promoted` po canary: `state=stable`, `stableCommit=<commit>`, czyści `candidate*`/`rollbackDeadline`.

## Supervisor jako właściciel sterowania (5.5)

Supervisor pozostaje **OBSERVE-ONLY domyślnie**. Aktywny deploy to osobny, gated tryb:

```bash
# Domyślnie ZABLOKOWANE (exit 3) — bezpieczeństwo:
bash scripts/autoheal-supervisor.sh --promote HEAD

# Świadome włączenie aktywnego sterowania:
AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=false bash scripts/autoheal-supervisor.sh --promote <ref>
AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=false bash scripts/autoheal-supervisor.sh --promote HEAD --dry-run
```

Supervisor jedynie **deleguje** do `run-deploy.sh` (nie importuje kodu Mastry). `--dry-run`
zatrzymuje się po `verify-candidate` na :4222 — **:4111 nietknięty**.

npm skróty: `autoheal:promote`, `autoheal:promote:dry`, `autoheal:test:rollback`.

### Zdjęcie ludzkiej bramki `confirmMerge` — tylko dla autoheal

`workflows/repo-maintenance.ts → decision-gate` pomija ludzki `suspend(confirmMerge)`
**wyłącznie** gdy:

- `AUTOHEAL_AUTO_PROMOTE=true` (domyślnie OFF), **oraz**
- task jest autohealowy (`isAutohealTask(taskId)` → prefiks `heal-*`).

Zadania użytkownika **zawsze** wymagają potwierdzenia człowieka — bramka nietknięta.
Helper: `autohealAutoConfirmMerge(taskId)`.

## Test sztucznej awarii (5.4) — dowód auto-rollbacku

`scripts/autoheal/test-artificial-failure.sh` (`npm run autoheal:test:rollback`):

- **Pełna izolacja**: własny `.deploy` (mktemp), własny stan, porty **4555/4556**.
  Runtime podstawiony lekkimi fake-serwerami (node http) — szybko, bez `mastra build`.
  **REALNY :4111 nie jest dotykany.**
- Wykonuje **realne** kroki `promote-candidate` / `canary-watch` / `rollback-to-stable`.

| Scenariusz | Symulacja | Oczekiwanie | Wynik |
|-----------|-----------|-------------|-------|
| A | candidate żyje, ale **nie bind-uje portu** (jak blocker ERR_AMBIGUOUS) | post-swap verify FAIL → auto-rollback | ✅ stable wrócił |
| B | candidate zdrowy przy swapie, **umiera w trakcie canary** | canary wykrywa martwy PID → rollback | ✅ stable wrócił |

Po obu: `:4555` zdrowy, `activeSlot=slot-a`, `stableCommit=stable0`. `tsc --noEmit` czysty.

## Macierz awarii (test antyregresyjny 5)

| Awaria | Mechanizm obronny |
|--------|-------------------|
| candidate nie startuje / nie bind-uje | post-swap verify (30s) FAIL → rollback (scenariusz A) |
| health nie odpowiada / pada po promote | canary sonda 1+3 → rollback (scenariusz B) |
| restart-loop (PID skacze) | canary sonda 4 → rollback |
| zły port / `EADDRINUSE` | canary sonda 5 (skan logu) → rollback |
| eksplozja błędów runtime | canary sonda 6 (Mongo, best-effort) → rollback |
| **Mongo down** | canary sonda 6 pominięta → canary NIE pada (twarde sygnały dalej działają) |
| rollback też pada | exit 2 / `state=rollback_failed` → wymagana interwencja (alert) |

## Granica Etapu 5 vs 6

Etap 5 dowozi bezpieczny swap z deterministycznym powrotem. **Domknięcie cyklu** (sync
kanonu source = `git merge --ff-only <candidateCommit>`, reset repair lane, inwariant
`runtimeVersion == stableCommit == sourceHEAD`) to **Etap 6** — `docs/AUTOHEAL-CYCLE-CLOSURE.md`.
