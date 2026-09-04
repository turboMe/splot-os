# Etap 6 — Domknięcie cyklu (sync kanonu + reset repair lane + inwariant wersji)

Aktualizacja: 2026-06-08

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 6.
Domyka pętlę po bezpiecznym swapie z Etapu 5 (zob. [AUTOHEAL-PROMOTE-ROLLBACK.md](AUTOHEAL-PROMOTE-ROLLBACK.md)).

## Cel

Po udanym `promote + canary + mark-promoted`: uczynić **źródłowy kanon** (source repo) równym
działającej wersji, zresetować repair lane do nowego stable i potwierdzić **inwariant wersji**
`runtimeVersion == stableCommit == sourceHEAD`. Dzięki temu kolejny cykl autoheal startuje z czystej,
spójnej bazy.

## Zasada nadrzędna

Domknięcie cyklu jest **czysto gitowe + plik stanu** — **bez LLM / Mastry / Mongo**. Jego niepowodzenie
**nigdy** nie wywraca udanego deployu: Live już działa na nowej wersji, a sync kanonu to operacja
„porządkowa" po fakcie. Dlatego w `run-deploy.sh` jest gated flagą (domyślnie OFF) i jego błąd daje
tylko `warn`, nie rollback.

## Krok `sync-canon.sh <commit>`

`scripts/autoheal/sync-canon.sh` — domknięcie cyklu w trzech fazach:

| Faza | Działanie | Bezpieczeństwo |
|------|-----------|----------------|
| 6.1 sync kanonu | `git merge --ff-only <commit>` na bieżącej gałęzi kanonu | **NIGDY force**. Brak ff → exit 1, kanon NIETKNIĘTY (decyzja człowieka). Odmawia przy detached HEAD lub niezacommitowanych zmianach. |
| 6.2 reset repair lane | `checkout autoheal/repair` + `reset --hard <commit>` + `clean -fdx -e .env -e node_modules` | Brak lane → pomiń (TS odtworzy na starcie cyklu). Błąd resetu → exit 2 (kanon już zsynchronizowany). |
| 6.3 inwariant | porównanie `runtime == stable == source` | Sloty deploy: twardy assert. Rozjazd → exit 1 + `state=invariant_violation`, **Live nietknięty**. |

### Tryb PR (`AUTOHEAL_GITHUB_PR_MODE=true`)

Merge wykonał GitHub — kanon synchronizuje się przez `fetch origin/<branch>` + `merge --ff-only origin/<branch>`
(fallback na lokalny commit, gdy brak ff z origin).

### Inwariant (6.3) — skąd `runtimeVersion`

1. Preferencja: `.deploy-version` aktywnego slotu (`slot_dir(activeSlot)/.deploy-version`) — niezależne od Mastry.
2. Fallback: `GET /deploy/health` → pole `version` (gdy plik niedostępny).

| Aktywny slot | Zachowanie |
|--------------|------------|
| `slot-a` / `slot-b` (deploy) | Twardy assert `runtime == stable == source`. Rozjazd → exit 1, `state=invariant_violation`. |
| `default` (dev, `mastra dev`) | Tylko ostrzeżenie — dev żyje z `mastra dev`, nie jest synchronizowany z kanonem. exit 0. |

> **Uwaga o dev:** Live `:4111` w trybie `mastra dev` (slot `default`) świadomie rozjeżdża się z dyskiem/kanonem
> — to oczekiwane. Twardy inwariant dotyczy wyłącznie slotów deploy, na które wchodzi się przez realny swap.

### Kody wyjścia

| Kod | Znaczenie |
|-----|-----------|
| 0 | Kanon zsynchronizowany + inwariant OK (lub tryb dev) — cykl domknięty. |
| 1 | ff niemożliwy **lub** inwariant złamany — Live NIE jest ruszany, wymagana uwaga. |
| 2 | Błąd resetu repair lane — kanon mógł zostać zsynchronizowany, lane wymaga uwagi. |

## Podłączenie w orchestratorze (`run-deploy.sh`)

Po `mark-promoted`, za flagą `AUTOHEAL_SYNC_CANON` (domyślnie OFF):

```
… → mark-promoted → [AUTOHEAL_SYNC_CANON=true] → sync-canon
                          porażka → warn (deploy POZOSTAJE udany, Live na nowej wersji)
```

`AUTOHEAL_SYNC_CANON != true` → krok pominięty, kanon nietknięty (jawny `log`).

## Test antyregresyjny 6 (`npm run autoheal:test:closure`)

`scripts/autoheal/test-cycle-closure.sh` — **pełna izolacja w mktemp**:

- tymczasowe repo-kanon (`git init`, branch `master`) przez override `AUTOHEAL_CANON_DIR`,
- osobny repair lane (klon kanonu na `autoheal/repair`, z brudem do sprzątnięcia),
- własny `.deploy` / state / runtime (`AUTOHEAL_DEPLOY_DIR` / `AUTOHEAL_STATE_FILE` / `AUTOHEAL_RUNTIME_DIR`).

**REALNE repo i REALNY `:4111` nie są dotykane.** Uruchamia **realny** `sync-canon.sh`.

| Scenariusz | Ustawienie | Oczekiwanie | Wynik |
|-----------|-----------|-------------|-------|
| A | `runtime == stable == candidate` na `slot-a` | kanon ff→candidate, lane czysty, `state=stable`, exit 0 | ✅ |
| B | `runtime=stable0`, `source=candidate1` (rozjazd na slocie deploy) | exit 1, `state=invariant_violation` | ✅ |

`AUTOHEAL_CANON_DIR` dodano w `sync-canon.sh` **wyłącznie** dla testowalności (sandbox) — produkcyjnie kanon = `REPO_DIR`.

## Flagi (Etap 6)

| Flaga | Domyślnie | Rola |
|-------|-----------|------|
| `AUTOHEAL_SYNC_CANON` | `false` | Włącza domknięcie cyklu w `run-deploy.sh` po `mark-promoted`. |
| `AUTOHEAL_GITHUB_PR_MODE` | `false` | Sync kanonu przez `origin/<branch>` (merge zrobił GitHub). |
| `AUTOHEAL_REPAIR_WORKTREE` | `…/agentic-agents-repair` | Ścieżka repair lane do resetu. |
| `AUTOHEAL_CANON_DIR` | `REPO_DIR` | Override kanonu — **tylko testy sandbox**. |

## Granica Etapu 6 vs 7

Etap 6 domyka pojedynczy udany cykl (source = działająca wersja, lane czysty, inwariant trzyma).
**Kontrolowane ponawianie** po nieudanych próbach (zapis `autoheal_attempts`, `AUTOHEAL_MAX_ATTEMPTS`,
stan `failed_needs_human`, lokalny fallback Ollama) to **Etap 7** — `docs/AUTOHEAL-RETRY-FALLBACK.md`.
