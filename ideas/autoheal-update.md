# Autoheal Update Plan

## Cel

Docelowy autoheal ma samodzielnie wykrywać błędy runtime, przygotowywać poprawki w izolowanej kopii kodu, uruchamiać poprawioną wersję jako candidate runtime, a po krótkim canary przełączać produkcyjny runtime. Rollback po przełączeniu musi być w pełni automatyczny i niezależny od Mastry, LLM oraz chmury.

Najważniejsza zasada: **LLM może diagnozować i pisać poprawki, ale nie może być wymagany do rollbacku ani do utrzymania dostępności runtime.**

## Założenia Bezpieczeństwa

- Aktualny runtime może się zawiesić, stracić endpointy albo całkiem paść.
- Po aktywacji poprawionej wersji Mastra może nie działać, więc rollback nie może zależeć od żadnego endpointu Mastry.
- Chmura może być niedostępna; po awarii candidate można opcjonalnie użyć lokalnego modelu, ale tylko do dalszej diagnozy/naprawy, nigdy do decyzji rollback.
- Stan krytyczny musi być zapisany poza procesem Mastry: plikowo w `.deploy/autoheal-state.json` plus opcjonalnie w Mongo jako lustro diagnostyczne.
- Każda próba musi być odtwarzalna: commit, diff, logi startu, logi health-checków, decyzja promote/rollback.

## Docelowa Architektura

### 1. Source Repo

Canonical source zostaje w:

```text
/projekty/mastra-agentic-environment/agentic-agents
```

To repo jest punktem prawdy po zaakceptowanej/promowanej naprawie. Nie powinno być edytowane bezpośrednio przez agenta w trakcie pracy runtime.

### 2. Persistent Repair Worktree

Zamiast tworzyć nowe worktree dla każdej naprawy/ticketa, system utrzymuje jeden długowieczny repair lane:

```text
/projekty/mastra-agentic-environment/agentic-agents-repair
branch: autoheal/repair
```

Ten worktree:

- jest resetowany do aktualnego stable source przed rozpoczęciem nowego cyklu,
- może akumulować wiele małych edycji w ramach jednej próby naprawy,
- przechowuje całą serię poprawek aż do finalnego candidate commit,
- nie jest usuwany po każdym tasku,
- po udanej promocji synchronizuje się z canonical source i staje się czystą bazą kolejnego cyklu.

### 3. Runtime Slots

Runtime powinien działać ze slotów zarządzanych przez supervisora, najlepiej jako git worktree albo deterministyczna kopia z konkretnego commita:

```text
.deploy/runtime/slot-a
.deploy/runtime/slot-b
```

Slot aktywny obsługuje `:4111`. Slot candidate startuje na porcie staging, np. `:4222`, a potem może zostać przełączony na `:4111`.

Ważne: sloty runtime są artefaktami uruchomieniowymi, a nie miejscem pracy agenta.

### 4. Autoheal Supervisor

Nowy proces poza Mastrą:

```text
scripts/autoheal-supervisor.ts albo scripts/autoheal-supervisor.sh
```

Supervisor musi:

- startować stable runtime,
- pilnować PID i portów,
- wykonywać health-checki,
- uruchamiać candidate runtime,
- robić promote,
- robić rollback bez LLM,
- zapisywać stan do `.deploy/autoheal-state.json`,
- po rollbacku zlecać kolejną próbę naprawy do działającego stable runtime albo lokalnego fallback runnera.

Supervisor nie powinien importować kodu Mastry. Ma być możliwie mały i nudny: shell/Node, health checks, process management, git, pliki stanu.

## Docelowy Flow

### Phase 0: Stable Runtime Baseline

Supervisor utrzymuje zapis:

```json
{
  "stableCommit": "abc123",
  "activeSlot": "slot-a",
  "activePid": 12345,
  "activePort": 4111,
  "lastPromotedAt": "ISO_DATE"
}
```

Baseline jest aktualizowany tylko po zakończonym canary bez błędów.

### Phase 1: Runtime Error Detection

Źródła sygnałów:

- `uncaughtException`,
- `unhandledRejection`,
- brak odpowiedzi `/health`,
- brak odpowiedzi `/deploy/health`,
- powtarzalne `5xx`,
- wzrost `agent_events` typu `task_failed`, `tool_error`, `llm_call_failed`,
- crash procesu,
- port zajęty albo proces startuje z `EADDRINUSE`,
- n8n/automation runtime health failures, jeśli dotyczą działania systemu.

Sygnały dzielimy na dwie klasy:

- **runtime availability incidents**: supervisor reaguje deterministycznie natychmiast.
- **repairable code incidents**: ErrorCollector tworzy albo aktualizuje autoheal cycle.

### Phase 2: Dedup I Cycle Grouping

Obecny problem: nowy `heal-<signature>-<timestamp>` łatwo tworzy nowy task i worktree.

Docelowo potrzebujemy `autoheal_cycles`:

```ts
type AutohealCycle = {
  cycleId: string;
  signature: string;
  status:
    | 'observed'
    | 'diagnosing'
    | 'repairing'
    | 'candidate_building'
    | 'candidate_running'
    | 'canary'
    | 'promoted'
    | 'rolled_back'
    | 'retrying'
    | 'failed_needs_human';
  attempts: AutohealAttempt[];
  stableCommit: string;
  repairBranch: 'autoheal/repair';
  currentCandidateCommit?: string;
  createdAt: string;
  updatedAt: string;
};
```

Dla tej samej sygnatury i aktywnego cyklu system nie tworzy nowego worktree. Dopisuje obserwację do istniejącego cycle.

### Phase 3: Repair Lane Preparation

Supervisor albo workflow przygotowuje repair worktree:

```bash
git -C agentic-agents fetch --all --prune
git -C agentic-agents-repair reset --hard <stableCommit>
git -C agentic-agents-repair clean -fdx
git -C agentic-agents-repair checkout autoheal/repair
```

Warunek: `stableCommit` musi być tym commitem, z którego działa aktualny healthy runtime.

### Phase 4: LLM Repair

Mastra/codingAgent działa tylko nad `agentic-agents-repair`.

Zasady:

- `coding_init_worktree` powinno zostać zastąpione albo rozszerzone o tryb `autoheal_repair_lane`.
- Dla autoheal `taskId` nie powinien tworzyć nowej ścieżki worktree.
- Wszystkie edycje trafiają do jednego repair worktree.
- Ledger nadal zapisuje snapshoty i pliki zmienione, ale scope jest `cycleId + attemptId`, nie `worktree per task`.
- Agent może robić wiele małych edycji, retry, poprawki po review i testy w tym samym repair lane.

Minimalny kontrakt narzędzia:

```ts
coding_prepare_autoheal_lane({ cycleId, stableCommit })
coding_write_file_tracked({ cycleId, attemptId, path, content })
coding_run_test({ cycleId, attemptId, command })
coding_finalize_candidate({ cycleId, attemptId })
```

### Phase 5: Candidate Commit

Po lokalnych testach:

```bash
git -C agentic-agents-repair add .
git -C agentic-agents-repair commit -m "autoheal: fix <signature> attempt <n>"
```

Powstaje `candidateCommit`.

Ten commit jest jeszcze niepromowany. Nie zmienia active runtime.

### Phase 6: Candidate Build

Supervisor przygotowuje candidate runtime slot z dokładnie tego commita:

```text
.deploy/runtime/slot-b
commit: candidateCommit
port: 4222
```

Build i start:

```bash
npm ci albo npm install --prefer-offline
npm run build
PORT=4222 DEPLOY_SLOT=candidate node .mastra/output/index.mjs
```

Walidacja przed promote:

- proces żyje,
- `/health` zwraca sukces,
- `/deploy/health` zwraca `status: ok`,
- wersja w endpointzie zgadza się z `candidateCommit`,
- smoke tests krytycznych endpointów przechodzą,
- jeżeli błąd dotyczył konkretnego endpointu/toola, uruchomić test reprodukujący.

Jeżeli candidate nie przejdzie, active runtime nie jest dotykany. System zapisuje logi i wraca do Phase 4.

### Phase 7: Promote With Deterministic Rollback

Promote jest operacją supervisora, bez LLM.

Przed promote supervisor zapisuje:

```json
{
  "stableCommit": "abc123",
  "candidateCommit": "def456",
  "previousSlot": "slot-a",
  "candidateSlot": "slot-b",
  "previousPid": 12345,
  "rollbackDeadline": "now + 60s",
  "state": "promoting"
}
```

Kroki:

1. Zostaw previous runtime gotowy do rollbacku tak długo, jak to możliwe.
2. Zatrzymaj listener na `:4111` albo przełącz port/proxy.
3. Uruchom candidate na `:4111`.
4. Przez pierwsze 60 sekund supervisor wykonuje agresywny canary check co 2-5 sekund.
5. Jeśli candidate nie odpowiada, crashuje, zwraca fatal health albo generuje krytyczne błędy, supervisor natychmiast robi rollback.

Rollback w tym oknie:

- kill candidate PID,
- start previous stable build/slot na `:4111`,
- potwierdź `/health`,
- oznacz attempt jako `rolled_back`,
- zachowaj candidate slot i logi do diagnozy,
- zleć kolejną rundę naprawy na repair lane.

Żadnego LLM w rollback path.

### Phase 8: Canary 60s

Minimum canary:

- `/health`,
- `/deploy/health`,
- PID alive,
- brak restart loop,
- brak nowych krytycznych wpisów w logu procesu,
- brak `EADDRINUSE`,
- brak eksplozji `task_failed/tool_error` w `agent_events`, jeżeli Mongo działa,
- opcjonalnie synthetic request do najważniejszych agentów/tooli.

Canary config:

```env
AUTOHEAL_CANARY_SECONDS=60
AUTOHEAL_CANARY_INTERVAL_MS=3000
AUTOHEAL_MAX_CANARY_ERRORS=1
AUTOHEAL_ROLLBACK_ON_HEALTH_MISS=true
```

### Phase 9: Promotion Complete

Po 60 sekundach bez krytycznych błędów:

1. `candidateCommit` staje się `stableCommit`.
2. Canonical source repo synchronizuje się do candidate:

```bash
git -C agentic-agents fetch origin
git -C agentic-agents checkout master
git -C agentic-agents merge --ff-only candidateCommit
```

albo, jeśli używamy PR:

- merge PR,
- pull canonical repo,
- potwierdź, że `HEAD == candidateCommit` albo commit merge zawiera candidate diff.

3. Repair worktree resetuje się do nowego stable:

```bash
git -C agentic-agents-repair reset --hard <newStableCommit>
git -C agentic-agents-repair clean -fdx
```

4. Aktywny runtime może:

- pozostać na runtime slot, jeśli sloty są oficjalnym sposobem uruchamiania,
- albo zostać przełączony z powrotem na canonical repo dopiero po osobnym, bezpiecznym restart/proxy swap.

Rekomendacja: runtime powinien zawsze działać ze slotów `.deploy/runtime/*`, nie bezpośrednio z repo źródłowego. Canonical repo jest źródłem, sloty są deployment artifacts.

### Phase 10: Failed Candidate Retry Loop

Jeżeli candidate padł po promote:

1. Supervisor rollbackuje do stable.
2. Zapisuje `attempt.failureReason`, `logs`, `healthTrace`, `exitCode`.
3. System dopisuje te dane do `autoheal_cycles`.
4. Stable runtime wraca do pracy.
5. Autoheal uruchamia kolejną rundę na tym samym repair lane.
6. Repair lane startuje od stable commit plus może wykorzystać patch/logi z nieudanego candidate jako kontekst.
7. Nowy candidate dostaje kolejny `attemptId`.

Pętla trwa do:

- successful promote,
- przekroczenia `AUTOHEAL_MAX_ATTEMPTS`,
- wykrycia destrukcyjnego ryzyka,
- braku lokalnego modelu i braku działającej Mastry,
- wymaganej decyzji człowieka.

## Lokalny Fallback Model

Jeżeli stable runtime wrócił po rollbacku, normalna naprawa może iść przez Mastrę.

Jeżeli Mastra nie może wstać nawet na stable:

- supervisor próbuje uruchomić minimalny local repair runner,
- local runner używa Ollama/local model,
- zakres local runnera jest ograniczony do:
  - czytania logów,
  - proponowania małych patchy,
  - uruchamiania testów,
  - commitowania candidate w repair lane.

Local fallback nie robi promote/rollback. Nadal robi to supervisor.

## Zmiany W Obecnym Systemie

### A. Zastąpić Per-Task Worktree Dla Autoheal

Obecne:

```text
agentic-agents-worktrees/<taskId>
branch task-<taskId>
```

Docelowe dla autoheal:

```text
agentic-agents-repair
branch autoheal/repair
scope cycleId/attemptId
```

Per-task worktree może zostać dla zwykłych zadań coding agenta, ale autoheal ma osobny tryb.

### B. Dodać Autoheal Cycle Store

Kolekcje:

```text
autoheal_cycles
autoheal_attempts
autoheal_runtime_events
```

Plik krytyczny:

```text
.deploy/autoheal-state.json
```

Mongo jest wygodne do analityki, ale rollback używa pliku i PID/portów.

### C. Przerobić Deploy Script Na Supervisor-Owned Flow

Obecny `deploy-blue-green.sh` robi dużo rzeczy naraz. Docelowo rozdzielić:

- `build-candidate`,
- `start-candidate`,
- `verify-candidate`,
- `promote-candidate`,
- `rollback-to-stable`,
- `mark-promoted`.

Każdy krok powinien być idempotentny.

### D. Poprawić Watchdog

Watchdog musi czytać właściwe źródła błędów:

- proces/PID,
- port,
- `/health`,
- `/deploy/health`,
- log pliku procesu,
- `agent_events`, jeśli Mongo działa.

Nie powinien polegać na nieistniejącym `mastra_agents.error_logs`.

### E. Statusy I Dashboard

Endpointy diagnostyczne:

```text
/deploy/autoheal-status
/deploy/autoheal-cycles
/deploy/autoheal-attempts/:cycleId
/deploy/runtime-status
```

Te endpointy są tylko diagnostyczne. Rollback nie zależy od nich.

## State Machine

```text
healthy
  -> incident_detected
  -> cycle_opened
  -> repair_lane_prepared
  -> repairing
  -> candidate_committed
  -> candidate_building
  -> candidate_running
  -> pre_promote_verified
  -> promoting
  -> canary
  -> promoted
  -> healthy
```

Ścieżki błędów:

```text
candidate_building -> repair_failed -> repairing
candidate_running -> repair_failed -> repairing
canary -> rollback -> retrying -> repairing
promoting -> emergency_rollback -> retrying -> repairing
```

## Ocena Trudności I Ryzyka Regresji

To nie jest jedna mała poprawka, tylko zmiana infrastrukturalna o średnim/wysokim ryzyku. Największe ryzyko nie leży w samym LLM ani w coding agencie, tylko w warstwie, która zarządza procesami, portami, buildami, slotami runtime i decyzją promote/rollback.

### Najbardziej Ryzykowne Obszary

1. **Supervisor poza Mastrą**
   - Najważniejszy i najtrudniejszy element.
   - Musi działać nawet wtedy, gdy Mastra, endpointy i modele nie działają.
   - Błąd w supervisorze może zostawić system bez aktywnego runtime albo z dwoma procesami walczącymi o `:4111`.

2. **Promote/rollback slotów runtime**
   - Wysokie ryzyko regresji.
   - Krytyczne szczegóły: PID-y, zombie procesy, `EADDRINUSE`, stare procesy na porcie, niespójne `.env`, niepełny build, proces uruchomiony z innego commita niż zapisany w stanie.
   - Ta część musi mieć deterministic tests z celowo psutym candidate runtime.

3. **Persistent repair lane zamiast per-task worktree**
   - Średnie ryzyko.
   - Trzeba zachować per-task worktree dla zwykłego coding agenta, ale dla autoheal używać jednego `agentic-agents-repair`.
   - Największe ryzyko: popsucie izolacji zapisu albo ledgeru, jeśli narzędzia nie rozróżnią `taskId`, `cycleId` i `attemptId`.

4. **Synchronizacja canonical repo po canary**
   - Średnie/wysokie ryzyko.
   - Jeżeli source repo zostanie zsynchronizowane z innym commitem niż aktywny stable runtime, kolejny cykl autoheal będzie startował z fałszywej bazy.
   - Trzeba zawsze sprawdzać `runtimeVersion == stableCommit == sourceHead` po promocji.

5. **Retry loop po rollbacku**
   - Logicznie trudne.
   - Bez limitów system może wejść w nieskończoną pętlę build -> promote -> rollback -> repair.
   - Wymagane są limity prób, backoff, klasyfikacja fatalnych błędów i stan `failed_needs_human`.

### Mniej Ryzykowne Obszary

- dodanie kolekcji `autoheal_cycles`,
- endpointy statusowe,
- zapis i odczyt `.deploy/autoheal-state.json`,
- dodanie nowych flag ENV,
- dashboard/status read-only,
- rozszerzenie dokumentacji i kontraktów narzędzi.

### Zasada Wdrażania

Tego nie należy wdrażać jednym dużym refaktorem. Każdy etap powinien mieć feature flagę i możliwość pracy w trybie obserwacyjnym bez przełączania runtime.

Proponowane flagi:

```env
AUTOHEAL_SUPERVISOR_ENABLED=false
AUTOHEAL_SUPERVISOR_OBSERVE_ONLY=true
AUTOHEAL_CANDIDATE_BUILD_ENABLED=false
AUTOHEAL_PROMOTE_ENABLED=false
AUTOHEAL_ROLLBACK_ENABLED=true
AUTOHEAL_REPAIR_LANE_ENABLED=false
```

## Bezpieczna Kolejność Wdrożenia

1. **Observe-only supervisor**
   - Supervisor tylko obserwuje aktualny PID, port `:4111`, `/health`, `/deploy/health`.
   - Nie zabija procesów, nie startuje candidate, nie robi promote.
   - Cel: potwierdzić, że widzi realny stan runtime i poprawnie zapisuje `.deploy/autoheal-state.json`.

2. **Candidate build bez promote**
   - System buduje candidate slot na `:4222`.
   - Active runtime na `:4111` pozostaje nietknięty.
   - Cel: sprawdzić build, env, start procesu, health i logi bez ryzyka downtime.

3. **Canary bez przełączenia live**
   - Candidate działa na `:4222` przez 60 sekund.
   - Supervisor wykonuje takie same checki, jakie potem będą użyte po promote.
   - Cel: przetestować logikę oceny zdrowia przed realnym przełączaniem.

4. **Promote + natychmiastowy rollback testowy**
   - W kontrolowanym teście candidate jest celowo psuty.
   - Supervisor musi automatycznie wrócić do stable bez udziału Mastry i LLM.
   - Cel: udowodnić, że rollback path działa w najgorszym scenariuszu.

5. **Realny promote z 60s canary**
   - Dopiero po przejściu testów sztucznej awarii.
   - Nadal pod feature flagą i z małą liczbą dopuszczonych typów zmian.

6. **Persistent repair lane**
   - Po ustabilizowaniu supervisora przepiąć autoheal z per-task worktree na `agentic-agents-repair`.
   - Zwykły coding agent nadal może używać per-task worktree.

7. **Retry loop po rollbacku**
   - Na końcu dodać automatyczne kolejne próby.
   - Najpierw z limitem `AUTOHEAL_MAX_ATTEMPTS=2`, potem zwiększyć do docelowego limitu.

## Minimalne Testy Antyregresyjne

Każdy etap powinien mieć testy uruchamiane bez LLM:

- candidate nie startuje -> active runtime zostaje nietknięty,
- candidate startuje, ale `/health` nie odpowiada -> brak promote,
- candidate przechodzi preflight, ale pada po promote -> rollback do stable,
- candidate zajmuje zły port -> rollback/brak promote,
- stary proces nie daje się ubić -> supervisor raportuje stan i nie gubi stable metadata,
- Mongo nie działa -> rollback nadal działa na podstawie pliku stanu i PID,
- Mastra endpointy nie działają -> rollback nadal działa,
- source repo HEAD różni się od stable runtime -> promocja blokowana,
- repair lane ma dirty state przed startem -> reset albo blokada z raportem.

## Minimalny MVP

1. Dodać `autoheal-supervisor` jako niezależny proces.
2. Dodać `.deploy/autoheal-state.json`.
3. Przestawić watchdog na 60s canary i poprawne źródła błędów.
4. Dodać persistent `agentic-agents-repair` dla autoheal.
5. Zmienić `coding_init_worktree`, żeby dla `taskId`/`cycleId` autoheal używał repair lane zamiast tworzyć nowe worktree.
6. Dodać `autoheal_cycles`, żeby deduplikować aktywne problemy i próby.
7. Rozdzielić build candidate od promote.
8. Po rollbacku automatycznie tworzyć kolejną attempt z logami candidate.
9. Dopiero potem integrować PR/GitHub jako opcjonalny tryb publikacji, nie jako warunek autoheal.

## Docelowa Konfiguracja

```env
AUTOHEAL_ENABLED=true
AUTOHEAL_MODE=supervised
AUTOHEAL_REPAIR_WORKTREE=/projekty/mastra-agentic-environment/agentic-agents-repair
AUTOHEAL_RUNTIME_DIR=/projekty/mastra-agentic-environment/.deploy/runtime
AUTOHEAL_CANARY_SECONDS=60
AUTOHEAL_CANARY_INTERVAL_MS=3000
AUTOHEAL_MAX_ATTEMPTS=5
AUTOHEAL_USE_LOCAL_FALLBACK_MODEL=true
AUTOHEAL_LOCAL_MODEL=ollama/qwen3-coder:latest
AUTOHEAL_CLOUD_ALLOWED_DURING_REPAIR=true
AUTOHEAL_CLOUD_ALLOWED_DURING_ROLLBACK=false
AUTOHEAL_GITHUB_PR_MODE=optional
```

## Najważniejsze Decyzje Do Podjęcia

1. Czy runtime zawsze ma działać ze slotów `.deploy/runtime/*`, czy po promocji ma wracać do canonical repo?
2. Czy source repo ma być fast-forwardowane bez PR po canary, czy PR ma zostać tylko jako mirror/audit?
3. Czy lokalny fallback model ma mieć prawo commitować patch, czy tylko przygotowywać rekomendację dla stable Mastry?
4. Ile prób autoheal robimy przed oznaczeniem `failed_needs_human`?
5. Jakie smoke testy są obowiązkowe dla Mastry, n8n, knowledge-agent i automation architect?

## Rekomendacja

Najczystszy model: **runtime zawsze działa ze slotów deploy, source repo jest canonical truth, repair worktree jest jeden i długowieczny, a supervisor jest jedynym właścicielem promote/rollback.**

Wtedy po udanym canary:

- candidate staje się stable,
- source repo jest synchronizowane do candidate,
- repair lane resetuje się do nowego stable,
- kolejny cykl startuje z czystej, poprawionej bazy,
- rollback zawsze działa nawet wtedy, gdy Mastra i modele są martwe.
