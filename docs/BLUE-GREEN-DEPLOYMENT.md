# Etap 6: Blue-Green Deployment dla Self-Healing

Aktualizacja: 2026-05-08

## Problem

Po `apply_patch` (git merge) pliki na dysku się zmieniają, ale uruchomiony proces Node.js
nadal korzysta ze starego kodu w pamięci. Aby nowy kod zaczął działać, trzeba zrestartować Mastrę.

Ryzyka:
- Nowy kod może crashować przy starcie → agent sam się ubił
- Brak mechanizmu automatycznego powrotu do działającej wersji
- Agent nie może naprawić samego siebie jeśli już nie działa

## Architektura Blue-Green

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  LIVE (slot A)              │     │  STAGING (slot B)           │
│  Port: 4111                 │     │  Port: 4222                 │
│  Dir: agentic-agents/       │     │  Dir: agentic-agents-stg/   │
│  Status: AKTYWNY            │     │  Status: TESTOWY            │
│  PID: zapisany w pidfile    │     │  PID: zapisany w pidfile    │
└─────────────────────────────┘     └─────────────────────────────┘
             │                                    │
             │            ┌──────────┐            │
             └────────────│ Deployer │────────────┘
                          │ Script   │
                          └──────────┘
                               │
                        health-check
                        swap portów
                        rollback
```

## Komponenty do zbudowania

### 1. Health-check endpoint (`/health`)
- Zwraca JSON z: status, uptime, version (git SHA), timestamp
- Mastra go serwuje automatycznie (custom server hook lub middleware)
- Plik: `src/mastra/server/health.ts`

### 2. Deploy config (`deploy.config.json`)
- Definicje slotów (A/B), porty, ścieżki, PID files
- Plik: `deploy.config.json`

### 3. Deploy script (`scripts/deploy-blue-green.sh`)
Procedura po zatwierdzonym `apply_patch`:
1. Zbuduj nowy kod w STAGING (`mastra build`)
2. Uruchom STAGING na porcie 4222
3. Czekaj max 30s na health-check
4. Jeśli health OK → zamień porty (STAGING ↔ LIVE)
5. Jeśli health FAIL → `git revert`, wyłącz STAGING, LIVE pozostaje nietkniętą

### 4. Integracja z workflow
- `decision-gate` po `apply_patch` wywołuje deploy script
- Nowy krok `deploy-and-verify` w workflow

## Plan implementacji

- [ ] Krok 1: Health endpoint + deploy config
- [ ] Krok 2: Deploy script (build → start → verify → swap/rollback)
- [ ] Krok 3: Integracja z `repo-maintenance-workflow`
- [ ] Krok 4: Test E2E: workflow → coding → review → merge → deploy → health

---

## Aktualizacja: Etap 0 autoheal — quick fixes (2026-06-08)

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 0.

### 0.1 — Naprawa martwego źródła błędów w watchdogu

`scripts/watchdog.sh` pytał `getSiblingDB('mastra_agents').getCollection('error_logs')` — **zła baza i zła kolekcja** (realna baza to `agentforge`, kolekcji `error_logs` nie ma) → licznik zawsze zwracał 0, więc rollback po eksplozji błędów nigdy się nie uruchamiał. Teraz watchdog:

- pyta `agentforge.agent_events` o `status:'error'` w typach `task_failed/tool_error/llm_call_failed/run_failed`,
- liczy błędy w oknie ostatnich `checkIntervalSeconds * 2` (świeże błędy po przełączeniu, nie cała historia),
- baza i kolekcja są konfigurowalne: `deploy.config.json → watchdog.mongoDb`, `watchdog.mongoErrorCollection`.

### 0.3 — Alert webhook z runtime zamiast martwego URL

`deploy.config.json → watchdog.alertWebhook` miał zahardkodowany URL `*.trycloudflare.com`, który **rotuje przy każdym restarcie tunelu** → alerty nie dochodziły. Teraz:

- pole w configu jest puste (`""`),
- watchdog buduje URL z ENV `N8N_PUBLIC_WEBHOOK_BASE_URL` + `/webhook/telegram-reply`,
- jeśli config zawiera stary URL `trycloudflare.com`, jest on ignorowany na rzecz ENV.

### 0.5 — Bezpieczne sprzątanie osieroconych worktrees/branchy

Nowy `scripts/autoheal-prune-worktrees.sh` (domyślnie `--dry-run`):

- `git worktree prune` + lista branchy `task-*` bez aktywnego worktree,
- usuwa (z `--force`) **tylko** branche w pełni zmergowane do `master`,
- niezmergowane jedynie raportuje (decyzja człowieka).

Stan w chwili audytu: 7 zmergowanych sierot (bezpieczne), 1 niezmergowana (`task-workflow-automation-client-hunt` — zostawiona).

> Trwałe rozwiązanie mnożenia worktrees (persistent repair lane) przychodzi w Etapie 2.

---

## Aktualizacja: Etap 4 autoheal — idempotentne kroki blue-green (2026-06-08)

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 4.

### Problem z monolitem

`scripts/deploy-blue-green.sh` był jednym dużym skryptem (build+start+health+swap+rollback+watchdog).
Trudny do testowania krok po kroku, niełatwy do sterowania przez supervisora (Etap 5), a Live runtime
był utożsamiany z **katalogiem source** (slot A `dir` = repo) — czyli source pełnił rolę artefaktu
uruchomieniowego.

### Rozwiązanie: 6 idempotentnych kroków + sloty runtime

Katalog `scripts/autoheal/` (+ wspólny `lib.sh`):

| Krok | Rola | Kod wyjścia |
|------|------|-------------|
| `build-candidate.sh <commit> [slot]` | materializuje slot z commita (`git archive`) + `mastra build` | 0 ok/aktualne, 1 błąd |
| `start-candidate.sh <slot> [port]` | startuje zbudowany slot na porcie (domyślnie :4222) | 0 ok, 1 błąd |
| `verify-candidate.sh <port> [timeout]` | health-check (READ-ONLY, nic nie zmienia) | 0 zdrowy, 1 nie wstał |
| `promote-candidate.sh <slot>` | backup Live → swap kandydata na :4111 → post-swap verify → auto-rollback | 0 ok, 1 rollback, 2 krytyczne |
| `rollback-to-stable.sh [dir]` | przywraca poprzedni Live z backupu (bez LLM/Mastry/Mongo) | 0 ok, 1 brak backupu, 2 unhealthy |
| `mark-promoted.sh <commit> [slot]` | finalizacja po canary: `stableCommit`+`lastPromotedAt` w stanie | 0 |

Cienki orchestrator `run-deploy.sh` łączy je: build → start → verify [→ promote → mark]
(z `--dry-run` zatrzymuje się po verify, bez swapu).

### Sloty runtime — determinizm

`.deploy/runtime/slot-a` i `.deploy/runtime/slot-b` to **miejsce uruchamiania**. Slot powstaje przez
`git archive <commit> | tar -x` — dokładne drzewo commita, **bez `.git` i bez cruftu roboczego**.
`node_modules` jest symlinkowany ze source (build kompiluje źródła), `.deploy-version` zapisuje SHA →
idempotencja: ponowny `build-candidate` z tym samym SHA to no-op. **Source repo = kanon commitów**,
nie artefakt uruchomieniowy (repair lane = miejsce pracy, sloty = miejsce uruchamiania).

### Zgodność wstecz

`deploy-blue-green.sh` zyskał opt-in na początku:

```bash
AUTOHEAL_USE_STEPS=true bash scripts/deploy-blue-green.sh [--dry-run]   # → run-deploy.sh
bash scripts/deploy-blue-green.sh                                       # bez flagi: stary monolit
```

Domyślnie (flaga nieustawiona) **zachowanie się nie zmienia**.

### Granica Etapu 4 vs 5

Kroki `promote`/`rollback` istnieją jako deterministyczne building-blocki, ale **pełny canary 60s**,
agresywne sondy i macierz awarii to **Etap 5** (supervisor jako właściciel sterowania). W Etapie 4
testujemy bezpiecznie tylko `build`/`start`/`verify` na porcie staging — **`:4111` pozostaje nietknięty**.

### Test antyregresyjny 4

`build-candidate HEAD slot-b` materializuje `.deploy/runtime/slot-b` i buduje output, podczas gdy
`:4111` przez cały czas odpowiada na `/health` z niezmienionym PID/wersją. Ponowny `build-candidate`
z tym samym SHA = SKIP (idempotencja). `start-candidate` startuje osobny proces na :4222, a
`verify-candidate` zwraca poprawny kod — bez dotykania Live.

### ✅ Blocker Etapu 5 ROZWIĄZANY (2026-06-08): bundel bind-uje port

W teście Etapu 4 `verify-candidate` **poprawnie zgłosił FAIL**: zbudowany `.mastra/output/index.mjs`
przy starcie rzucał
`unhandledRejection: "Cannot determine intended module format because both require() and top-level
await are present"`. Global error handler to łapił (proces nie ginął), ale serwer HTTP **nie
bind-ował portu** — kandydat utykał po `SkillRegistry init`.

**Przyczyna.** Node 22 wykrywa format modułu heurystycznie. Liczy **wolne (FREE, niezwiązane)**
identyfikatory `require`/`module`/`exports` jako marker CJS. Bundel ESM zawierał jednocześnie
top-level `await` (marker ESM) **oraz** 7 wolnych `require()` (marker CJS) → ambiguity → fatal.
esbuild (przez `mastra build`) emitował te `require()` bez bannera `createRequire`.

**Fix (usunięcie wszystkich FREE `require()` ze źródeł):**

| Plik | Było | Jest |
|------|------|------|
| `config/model-capabilities.ts` | `const { getGpuGuard } = require('../services/gpu-guard.js')` | statyczny `import { getGpuGuard }` (brak cyklu) |
| `services/subtask-executor.ts` | `const { getGpuGuard } = require('./gpu-guard.js')` | statyczny `import { getGpuGuard }` |
| `workspaces/external-project-workspace.ts` | `const { readdirSync, statSync } = require('fs')` | dołożone do statycznego `import ... from 'fs'` |
| `services/repo-indexer.ts` (konstruktor) | `const { mkdirSync } = require('fs')` | statyczny `import { mkdirSync } from 'node:fs'` |
| `services/repo-indexer.ts` (tree-sitter ×3) | wolne `require('tree-sitter*')` | **związany** `require` z `createRequire(import.meta.url)` |

Kluczowa subtelność: opcjonalny tree-sitter musi zostać `require` (try/catch → graceful degradation,
gdy brak natywnych modułów). Lokalny `const require = createRequire(import.meta.url)` jest
**związany**, więc Node **nie** liczy go jako markera CJS — ambiguity znika, a degradacja działa.

**Weryfikacja.** Po `mastra build` bundel startuje, **bind-uje port** i `/health` zwraca
`{"success":true}` (test na :4333, neutralnym wobec live/staging). `tsc --noEmit` czysty. Live
`:4111` (przez `mastra dev`) nietknięty przez cały test.

> Uwaga deploy: kroki blue-green materializują slot z **commita** (`git archive`), więc fix musi
> być scommitowany, zanim realny promote/canary z Etapu 5 zbuduje go w slocie.

> Aktywne przełączenie z canary i deterministycznym rollbackiem opisuje `docs/AUTOHEAL-PROMOTE-ROLLBACK.md` (Etap 5).
