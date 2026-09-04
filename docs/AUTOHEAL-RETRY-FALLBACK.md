# Etap 7 — Retry loop + limity + lokalny fallback (Ollama)

Aktualizacja: 2026-06-08

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 7.
Owija deterministyczny deploy z Etapu 5 ([AUTOHEAL-PROMOTE-ROLLBACK.md](AUTOHEAL-PROMOTE-ROLLBACK.md))
i domknięcie cyklu z Etapu 6 ([AUTOHEAL-CYCLE-CLOSURE.md](AUTOHEAL-CYCLE-CLOSURE.md)) w kontrolowaną pętlę.

## Cel

Kontrolowane **ponawianie** próby naprawy bez ryzyka **nieskończonej pętli** `build → promote → rollback`.
Po wyczerpaniu limitu prób system wchodzi w jawny stan `failed_needs_human` — **stable cały czas żyje**.

## Zasada nadrzędna

Limit prób i stan żyją w **pliku** (`.deploy/autoheal-state.json` + `.deploy/autoheal-attempts.jsonl`) —
**bez Mongo/LLM/Mastry**. Lokalny fallback (Ollama) jest **best-effort i czysto doradczy**: nie jest na
krytycznej ścieżce dostępności i NIGDY nie robi promote/rollback.

## Pętla `retry-deploy.sh [ref] [--dry-run]`

`scripts/autoheal/retry-deploy.sh` owija `run-deploy.sh` w pętlę:

```
for attempt in 1..MAX_ATTEMPTS:
   state = retrying (attemptCount, lastAttemptId, candidateCommit)
   rc = run-deploy.sh <ref>           # re-resolve commita co próbę (repair lane mógł wypchnąć nowy)
   record_attempt(jsonl: attemptId, attempt, commit, exitCode, failureReason)
   rc==0 → state=stable → exit 0       # któraś próba przeszła, Live na nowej wersji
   rc==2 → state=failed_needs_human → exit 2   # FATALNY: rollback też padł, natychmiastowy stop
   rc==1 → rollback OK, stable żyje → backoff → następna próba
po pętli (same rc==1) → state=failed_needs_human → [opcjonalny local-fallback] → exit 1
```

### Klasyfikacja błędów (7.2)

| rc z `run-deploy` | Znaczenie | Reakcja pętli |
|-------------------|-----------|---------------|
| 0 | promote+canary OK | sukces, `state=stable`, exit 0 |
| 1 | candidate padł, **rollback OK** (stable żyje) | retryowalny — kolejna próba (do limitu) |
| 2 | **rollback ZAWIÓDŁ** | **fatalny** — natychmiastowy stop, `state=failed_needs_human`, exit 2 |

### Kody wyjścia `retry-deploy.sh`

| Kod | Znaczenie |
|-----|-----------|
| 0 | Któraś próba przeszła — Live na nowej wersji. |
| 1 | Wyczerpano próby, każdy candidate rolled back → `failed_needs_human`. **Stable żyje.** |
| 2 | Fatalny — rollback zawiódł w którejś próbie. Wymagana interwencja. |

### Log prób (7.1)

`.deploy/autoheal-attempts.jsonl` — jedna linia na próbę (append-only):

```json
{"attemptId":"heal-attempt-20260608T...-1","attempt":1,"commit":"abc1234","exitCode":1,"failureReason":"candidate_failed_rolled_back","ts":"2026-06-08T..."}
```

Stan w `autoheal-state.json`: `state` (`retrying`/`failed_needs_human`/`stable`), `attemptCount`,
`lastAttemptId`, `candidateCommit`, `failureReason`. Schemat: `src/mastra/services/autoheal-state.ts`.

## Flagi (Etap 7)

| Flaga | Domyślnie | Rola |
|-------|-----------|------|
| `AUTOHEAL_MAX_ATTEMPTS` | `2` | Limit prób w pętli. |
| `AUTOHEAL_RETRY_BACKOFF_SECONDS` | `5` | Odstęp między próbami. |
| `AUTOHEAL_ATTEMPTS_LOG` | `.deploy/autoheal-attempts.jsonl` | Plik logu prób. |
| `AUTOHEAL_LOCAL_FALLBACK_ENABLED` | `false` | Włącza doradczy fallback Ollama po wyczerpaniu prób. |
| `AUTOHEAL_OLLAMA_HOST` | `http://localhost:11434` | Endpoint Ollama dla fallbacku. |
| `AUTOHEAL_FALLBACK_MODEL` | `qwen3-coder:30b` | Model do diagnozy. |
| `AUTOHEAL_RUN_DEPLOY` / `AUTOHEAL_LOCAL_FALLBACK` | (delegaci) | Override **tylko** dla testów sandbox. |

## Lokalny fallback `local-fallback.sh` (7.3)

Doradczy runner ostatniej szansy — uruchamiany przez `retry-deploy.sh` po wyczerpaniu prób, gdy
`AUTOHEAL_LOCAL_FALLBACK_ENABLED=true`. Twarde ograniczenia:

1. Startuje **tylko gdy stable `/health` nie odpowiada** (gdy stable żyje → no-op, exit 0).
2. **Nigdy** nie robi promote/rollback/swap — to wyłącznie domena supervisora.
3. Pyta Ollama (`/api/generate`, twardy timeout) o diagnozę/patch/test → zapis do
   `.deploy/fallback/fallback-<ts>.md` **dla człowieka**. Nic nie aplikuje.
4. Ollama nieosiągalny → best-effort skip (exit 0, nie wywraca pętli).

## Podłączenie w supervisorze (7)

```bash
# Domyślnie ZABLOKOWANE (exit 3) — jak --promote:
bash scripts/autoheal-supervisor.sh --promote-retry HEAD

# Świadome włączenie aktywnego sterowania z pętlą ponawiania:
AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=false AUTOHEAL_MAX_ATTEMPTS=3 \
  bash scripts/autoheal-supervisor.sh --promote-retry HEAD
```

Mapowanie kodów: 0 OK / 1 `failed_needs_human` (stable żyje) / 2 krytyczne / 3 zablokowane bramką.
npm: `autoheal:promote:retry`.

## Test antyregresyjny 7 (`npm run autoheal:test:retry`)

`scripts/autoheal/test-retry-loop.sh` — **pełna izolacja**: realny `run-deploy.sh` podmieniony atrapą
(`AUTOHEAL_RUN_DEPLOY`) zwracającą kody wg planu; własny `.deploy`/state/attempts-log. Bez LLM/Mongo,
**realny :4111 nietknięty**.

| Scenariusz | Plan rc | Oczekiwanie | Wynik |
|-----------|---------|-------------|-------|
| A | `1,1,1` (max=3) | exit 1, `failed_needs_human`, 3 próby, stable żyje | ✅ |
| B | `1,0` (max=3) | exit 0, `stable`, 2 próby | ✅ |
| C | `2` (max=3) | exit 2, `failed_needs_human`, 1 próba (fatalny stop) | ✅ |

## Granica i status

Etap 7 zamyka rdzeń autoheal: bezpieczny swap (5) + domknięcie cyklu (6) + kontrolowane ponawianie z
limitem i doradczym fallbackiem (7). Pełny przepływ PR/GitHub (7.4) pozostaje **opcjonalny** i poza
krytyczną ścieżką — flaga `AUTOHEAL_GITHUB_PR_MODE` jest już obsługiwana w `sync-canon.sh`.
