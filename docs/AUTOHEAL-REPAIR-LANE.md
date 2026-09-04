# Autoheal — Persistent Repair Lane (Etap 2)

Aktualizacja: 2026-06-08

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 2.
Plan docelowy: [ideas/autoheal-update.md](../ideas/autoheal-update.md) (sekcja "Persistent Repair Worktree", Phase 3–4).

## Problem

Autoheal tworzył **worktree-per-ticket**: `agentic-agents-worktrees/<taskId>`, branch `task-<taskId>`.
Każdy retry/cykl dawał nowy katalog i branch. W połączeniu z brakiem cleanupu na ścieżkach
suspend/fail → osierocone worktrees i branche (audyt: 3 fizyczne worktrees, 11 branchy → 8 sierot).

## Rozwiązanie

Jeden **długowieczny** worktree dla całego autoheal:

```text
<project-root>/agentic-agents-repair      (override: ENV AUTOHEAL_REPAIR_WORKTREE)
branch: autoheal/repair
```

- tworzony **raz**, **nigdy** nie usuwany,
- na starcie każdego cyklu resetowany do `stableCommit`,
- akumuluje edycje jednej próby naprawy aż do candidate commit,
- po `apply_patch` merge'owany do source; kolejny cykl startuje z czystej, nowej bazy stable.

Zwykły coding-agent (zadania użytkownika) **nadal** używa per-task worktree (`task-<id>`).
Tryb repair lane dotyczy **wyłącznie** tasków autoheal (`heal-*`).

## Feature flag

```env
AUTOHEAL_REPAIR_LANE_ENABLED=false   # domyślnie OFF — autoheal działa jak dotąd (per-task worktree)
AUTOHEAL_REPAIR_WORKTREE=/projekty/mastra-agentic-environment/agentic-agents-repair  # opcjonalny override ścieżki
```

Dopóki flaga jest OFF, **żadne zachowanie się nie zmienia** — `coding_init_worktree` tworzy per-task worktree.

## Moduł `services/autoheal-repair-lane.ts`

| Funkcja | Rola |
|---------|------|
| `isRepairLaneEnabled()` | czyta flagę `AUTOHEAL_REPAIR_LANE_ENABLED` |
| `isAutohealTask(taskId)` | `taskId.startsWith('heal-')` |
| `getRepairLanePath()` | ścieżka lane (ENV override) |
| `resolveStableCommit(taskId)` | `stableCommit` z cyklu (po `ticketId`) → fallback `HEAD` source |
| `ensureRepairLane(stableCommit)` | tworzy worktree/branch gdy brak; reset `--hard` + `clean -fdx -e .env -e node_modules`; kopiuje `.env` |
| `acquireRepairLane(taskId, stableCommit)` | pozyskuje lane; gdy zajęty przez inny aktywny task → `acquired:false` |

`ensureRepairLane` jest **idempotentne**: przy istniejącym worktree robi tylko reset (nie tworzy drugiego).
`.env` i `node_modules` są zachowywane przy `clean` (potrzebne do build/run candidate w Etapach 4+).

## Integracja z narzędziami worktree (`tools/dev/code-worktree.ts`)

**`coding_init_worktree`** — dla `heal-*` przy fladze ON:
1. `resolveStableCommit(taskId)` → commit bazowy.
2. `acquireRepairLane(taskId, stableCommit)`.
3. Gdy `acquired` → artifact: `worktreePath=lane`, `branchName=autoheal/repair`, `autohealLane=true`, `cycleId`, `stableCommit`.
4. Gdy lane zajęty → log + **fallback** na zwykły per-task worktree (bez psucia cudzej pracy).

**`coding_remove_worktree`** — gdy `autohealLane===true` (lub `worktreePath===lanePath`):
- **NIE** woła `git worktree remove` ani `git branch -D autoheal/repair`,
- tylko odpina artifact (`$unset worktreePath/branchName`, `status='done'`) → zwolnienie lane dla następnego cyklu.

Reszta toolingu (`coding_apply_patch`, `coding_worktree_diff`, read/list) działa bez zmian — operuje na `worktreePath`,
który teraz wskazuje na lane. `apply_patch` merge'uje `autoheal/repair` → source jak każdy inny branch.

## Współbieżność

Lane jest **współdzielony, jednowłaścicielowy**: `acquireRepairLane` sprawdza, czy inny aktywny task
(`status ∉ {done,failed,merged}`) już trzyma lane. Jeśli tak — bieżący task robi fallback na per-task worktree.
W typowym, sekwencyjnym przepływie autoheal (dedup + cooldown + cykl z Etapu 1) lane jest reużywany bez kolizji.

## Test antyregresyjny

3 kolejne starty cyklu (ensure → reset → reset) → **1 katalog `agentic-agents-repair`, 1 branch `autoheal/repair`,
0 przyrostu w `agentic-agents-worktrees/`**. Zweryfikowane smoke-testem replikującym git-logikę `ensureRepairLane`
na realnym repo (osobny branch/path testowy, posprzątany).

## Co dalej

- **Etap 3:** supervisor poza Mastrą — czyta/zapisuje `.deploy/autoheal-state.json`, pilnuje PID/portów `:4111`.
- **Etap 4:** rozdzielenie deploy-blue-green na idempotentne kroki; sloty runtime `.deploy/runtime/slot-a|slot-b`
  jako artefakty z konkretnego commita (repair lane = miejsce pracy, sloty = miejsce uruchamiania).
- **Etap 6:** po canary source synchronizuje się do candidate, a repair lane resetuje do nowego stable (`reset --hard` + `clean -fdx`).
