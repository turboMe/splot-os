# Autoheal — Supervisor poza Mastrą (Etap 3, OBSERVE-ONLY)

Aktualizacja: 2026-06-08

Realizacja [ideas/autoheal-implementation-plan.md](../ideas/autoheal-implementation-plan.md), Etap 3.
Plan docelowy: [ideas/autoheal-update.md](../ideas/autoheal-update.md) (sekcja "Supervisor", Phase 5–9).

## Po co osobny proces

**Zasada nadrzędna:** rollback i dostępność runtime NIGDY nie zależą od Mastry, LLM ani Mongo.
Gdyby właściciel promote/rollback żył *wewnątrz* Mastry, śmierć Mastry zabrałaby też mechanizm
ratunkowy. Dlatego supervisor to **osobny proces w bashu**, który **nie importuje kodu Mastry** —
mały i nudny: health-check, odczyt PID/portu, zapis pliku stanu.

W **Etapie 3** supervisor działa w trybie **OBSERVE-ONLY**: tylko obserwuje aktywny runtime,
odczytuje stan i go zapisuje. **Niczego nie zabija**, nie startuje candidate, nie robi
promote/rollback — aktywne sterowanie jest w Etapie 5.

## Plik

`scripts/autoheal-supervisor.sh` — jedyny artefakt Etapu 3.

## Co robi jeden cykl (`observe_once`)

1. `read_config` — czyta slot A (`port`, `pidFile`) z `deploy.config.json` (fallback: `:4111`,
   `.deploy/slot-a.pid`). Parsowanie przez `python3` (bez zależności od Node).
2. `detect_pid` — PID aktywnego runtime: najpierw pidfile (jeśli proces żyje, `kill -0`),
   w razie braku fallback `lsof -ti :<port>`.
3. Health: `curl /deploy/health` (version/slot) oraz `curl /health` (basic OK).
4. Wyznacza `health_state`:
   - `stable` — `/health` odpowiada **i** jest PID,
   - `unhealthy` — proces żyje, ale `/health` milczy,
   - `down` — brak procesu i brak `/health`.
5. `write_state` — **atomowy** zapis `.deploy/autoheal-state.json` (tmp + `mv -f`), schemat zgodny
   z `services/autoheal-state.ts`. Pole `lastPromotedAt` jest **zachowywane** z poprzedniego pliku.

W każdym przypadku supervisor tylko loguje i zapisuje stan — w `unhealthy`/`down` **nie podejmuje
żadnej akcji** (komunikat `OBSERVE — brak reakcji`).

## Plik stanu `.deploy/autoheal-state.json`

Leży w **korzeniu projektu** (rodzic repo `agentic-agents`), nie w repo. Przykład (runtime żywy):

```json
{
  "stableCommit": "90c9bcc",
  "activeSlot": "default",
  "activePid": 8677,
  "activePort": 4111,
  "lastPromotedAt": null,
  "state": "stable",
  "observedBy": "autoheal-supervisor",
  "updatedAt": "2026-06-08T14:31:16.000Z"
}
```

Ten sam plik czyta/zapisuje moduł `services/autoheal-state.ts` (od strony Mastry, tylko do odczytu
w endpointcie `/deploy/runtime-status`). Supervisor jest jego **niezależnym** pisarzem.

## Flagi ENV

| Zmienna | Domyślnie | Rola |
|---------|-----------|------|
| `AUTOHEAL_SUPERVISOR_ENABLED` | `false` | Czy startuje pętla ciągła. Gdy `false` — pętla nie rusza; `--once` działa zawsze. |
| `AUTOHEAL_SUPERVISOR_OBSERVE_ONLY` | `true` | W Etapie 3 wymuszone na observe. `false` daje tylko ostrzeżenie (sterowanie = Etap 5). |
| `AUTOHEAL_SUPERVISOR_INTERVAL_SECONDS` | `15` | Odstęp między cyklami w trybie pętli. |
| `AUTOHEAL_CANARY_SECONDS` | `60` | Czas canary (używane od Etapu 5; tu tylko logowane). |
| `AUTOHEAL_MAX_ATTEMPTS` | `2` | Limit prób (Etap 7; tu tylko logowane). |
| `AUTOHEAL_DEPLOY_DIR` / `AUTOHEAL_CONFIG_FILE` / `AUTOHEAL_STATE_FILE` | auto | Override ścieżek (przydatne w testach). |

## Uruchomienie

```bash
npm run autoheal:supervisor          # pętla observe (wymaga AUTOHEAL_SUPERVISOR_ENABLED=true)
npm run autoheal:supervisor:once     # jeden cykl (test / cron)
npm run autoheal:supervisor:status   # wypisz aktualny plik stanu
```

Tryb pętli ma `trap` na `SIGINT`/`SIGTERM` (czyste wyjście), więc nadaje się pod `nohup` lub
unit systemd. Przykład nohup:

```bash
AUTOHEAL_SUPERVISOR_ENABLED=true nohup npm run autoheal:supervisor \
  > .deploy/supervisor.log 2>&1 &
```

Szkic unitu systemd (opcjonalny, do dopięcia w Etapie 5 wraz ze sterowaniem):

```ini
[Service]
Environment=AUTOHEAL_SUPERVISOR_ENABLED=true
WorkingDirectory=/projekty/mastra-agentic-environment/agentic-agents
ExecStart=/usr/bin/bash scripts/autoheal-supervisor.sh
Restart=always
```

## Test antyregresyjny (Etap 3)

1. **Realny runtime → `stable`:** `--once` przy żywej Mastrze (:4111) zapisuje `state:stable`
   z poprawnym `activePid`, `activeSlot`, `version`. Zweryfikowane (PID 8677, version `90c9bcc`).
2. **Martwy runtime → `down`, bez reakcji:** symulacja przez override configu na nieużywany port
   (`AUTOHEAL_CONFIG_FILE` → `slots.A.port=4999`, tymczasowy `AUTOHEAL_STATE_FILE`). Supervisor
   zapisuje `state:down`, `activePid:null` i loguje `OBSERVE — brak reakcji` — **nie zabija, nie
   startuje, nie robi swap**. Żywy runtime pozostaje nietknięty (test nie zabija realnej Mastry).

## Co dalej

- **Etap 4:** rozdzielenie `deploy-blue-green` na idempotentne kroki + sloty runtime
  `.deploy/runtime/slot-a|slot-b` (sloty = miejsce uruchamiania candidate).
- **Etap 5:** supervisor przestaje być observe-only — przejmuje promote + canary (`AUTOHEAL_CANARY_SECONDS`)
  i **deterministyczny rollback** do stable, gdy candidate nie przejdzie. Dopiero tu `OBSERVE_ONLY=false`
  realnie zmienia zachowanie.
