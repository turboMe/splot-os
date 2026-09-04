# Coding Agent dla Mastry

Cel: zbudowac w Mastrze lokalnego agenta developerskiego, ktory moze pracowac na repozytorium tak jak lokalny asystent w IDE: czytac kod, szukac po repo, korzystac z LSP, wykonywac testy/buildy, przygotowywac poprawki, prosic o approval dla ryzykownych akcji i opcjonalnie uruchamiac workflow "self-healing" po awariach.

Ten dokument jest instrukcja wdrozeniowa dla deva. Nie zaklada pelnego zaufania do agenta. Agent moze przygotowac zmiane, ale operacje ryzykowne musza miec approval.

## 0. Status wdrozenia i decyzja architektoniczna

Aktualizacja: 2026-05-09.

Decyzja:

- `codingAgent` ma byc osobnym agentem developerskim, wolanym przez `metaAgent`, a nie kolejnym zestawem terminal tools w meta-agencie.
- `metaAgent` zostaje managerem: rozpoznaje intencje, deleguje, zbiera wynik i pilnuje approvali.
- `codingAgent` dostaje agent-specific workspace repo i moze pozniej miec wlasnych subagentow/workerow do researchu, patchowania, review i testow.
- Nie dawac meta-agentowi bezposredniego terminala do repo. To miesza odpowiedzialnosci i zwieksza ryzyko przypadkowej edycji.
- Modele traktowac jako aliasy konfiguracyjne, nie jako hardcode w promptach. Docelowo: mocny model chmurowy dla glownego coding supervisora, tanszy/szybszy model dla subagentow, fallback lokalny typu Qwen Coder/Gemma dla pracy offline.
- agent chmurowy powinien tez umiec powoływac subagentów do małych prostych zadań z modeli lokalnych  aby oszczedzać tokeny modeli hmurówych . oczywiscie damy mu mozliwosc powoływania też modeli chmurowych do pomocy ale aby wykorzystywał dostępne modele lokalne też jest wazne, tymbardziej ze malutkich modeli moze postawić kilka instancji i do tego tez dodać inne modele chmurowe.
Dlaczego osobny `codingAgent`:

- latwiej ustawic inny model, memory, workspace, approval policy i scorery,
- latwiej testowac go bez calego meta-agenta,
- latwiej ograniczyc zakres narzedzi tylko do repo,
- latwiej pozniej dac mu subagentow bez rozdmuchiwania meta-agenta.

Aktualny postep:

- [x] Plan przeczytany i porownany z aktualnym repo.
- [x] Potwierdzono, ze zainstalowane `@mastra/core 1.31.0` wspiera `AgentConfig.workspace`.
- [x] Potwierdzono, ze workspace tools wspieraja `requireApproval` i `requireReadBeforeWrite`.
- [x] Etap 0: spike techniczny workspace + minimalny `codingAgent` kodowo.
- [x] Etap 1: bezpieczny lokalny MVP `codingAgent` (artifact + ledger + rollback potwierdzone w smoke tescie).
- [x] Etap 2: realny artifact + change ledger + rollback jako wymuszona sciezka edycji (Ukonczone).
- [x] Etap 3: Staging Worktree (izolacja modyfikacji i bezpieczny merge) + podstawy code review.
- [x] Etap 4: codeReviewAgent i repo-maintenance workflow (Orkiestracja w Mastra).
- [x] Etap 5: Review Loop + Suspend/Resume + Reviewer Worktree Tools (E2E potwierdzone).
- [x] Etap 6: Blue-Green Deployment — dwie instancje Mastry (Live/Staging), health-check, auto-switch z rollback.
- [x] Etap 7: Self-healing z logów/testów, automatyczny trigger workflow bez auto-deploy.
- [x] Etap 8: Subagenci codingowi, routing modeli i tryb offline fallback.
- [x] Etap 9: GitHub/PR/CI integracja.
- [ ] Etap 10: Self-Improvement Loop — graceful swap, watchdog 10min auto-rollback, external project workspace.

Pierwszy naturalny krok:

Zrobic Etap 0 jako maly, odwracalny spike. Celem nie jest jeszcze pelny agent naprawiajacy repo, tylko potwierdzenie, ze Mastra Studio widzi osobnego `codingAgent`, workspace wskazuje na dobre repo, narzedzia sa nazwane poprawnie, approval dziala, a agent potrafi wykonac read/search/tsc bez legacy terminal tools.

Definition of done Etapu 0:

- `codingAgent` widoczny w Studio.
- Workspace wskazuje na `/projekty/mastra-agentic-environment/agentic-agents`.
- `codingAgent` potrafi znalezc `src/mastra/agents/meta-agent.ts`.
- `codingAgent` potrafi przeczytac plik przez workspace tool.
- `codingAgent` potrafi uruchomic `npx tsc --noEmit` albo zwrocic konkretny blad srodowiska.
- Proba komendy sieciowej typu `npm install` wymaga approval.
- `metaAgent` jeszcze nie dostaje terminala do repo.

Status Etapu 0:

- [x] Dodano agent-specific workspace dla repo.
- [x] Dodano `codingAgent` i prompt bazowy.
- [x] Zarejestrowano `codingAgent` w Mastra runtime.
- [x] Dodano `codingAgent` do `system.delegate_task`.
- [x] Usunieto legacy terminal tools z `metaAgent` ToolSearchProcessor.
- [x] `npx tsc --noEmit` przechodzi.
- [x] `npm run build` przechodzi.
- [x] Import z `.mastra/output/mastra.mjs` potwierdza `codingAgent`.
- [x] Manualny smoke test w Mastra Studio: `find_files`/`view`, approval rejection, artifact + ledger + `reject_all`.
- [x] Po restarcie Mastry powtorzono Studio smoke dla `execute_command npx tsc --noEmit` na nowym default `CODING_SANDBOX_ISOLATION=none`.

Status Etapu 1:

- [x] Dodano narzedzia `coding.create_artifact`, `coding.update_artifact`, `coding.get_artifact`.
- [x] Dodano minimalny change ledger: `coding.record_before_change`, `coding.record_after_change`.
- [x] Dodano rollback/acceptance tools: `coding.reject_file`, `coding.reject_all`, `coding.accept_file`, `coding.accept_all`.
- [x] Rollback chroni zmiany usera przez porownanie aktualnego hash z `afterHash`.
- [x] Podpieto narzedzia artifact/ledger do `codingAgent`.
- [x] Wlaczono `lsp_inspect` w `codeWorkspace`.
- [x] Ustawiono `CODING_SANDBOX_ISOLATION` dla workspace; lokalny default to `none`, bo `bwrap --unshare-net` blokowal `npx tsc --noEmit` w smoke tescie.
- [x] Dodano runtime dependencies LSP: `typescript-language-server`, `vscode-jsonrpc`, `vscode-languageserver-protocol`.
- [x] Dodano `.nvmrc` i wrapper `scripts/with-node.sh`, zeby skrypty Mastry uzywaly Node `v22.20.0`.
- [x] Dodano indeksy Mongo dla `code_task_artifacts`, `code_change_snapshots`, `maintenance_tasks`.
- [x] Dodano dokumentacje zmian: `docs/CODING-AGENT-MVP.md`.
- [x] Manualny smoke test w Mastra Studio: artifact + ledger + `reject_all(taskId)`.
- [x] Logi smoke testu potwierdzily: 2 artefakty, 1 snapshot rollback, `reject_all` bez konfliktow, proba `npm install lodash` odrzucona przez approval.
- [x] Naprawiono blad smoke testu: lokalny `bwrap --unshare-net` blokowal `execute_command` dla `npx tsc --noEmit`; domyslny lokalny backend izolacji to teraz `none`.
- [x] Smoke po restarcie Mastry potwierdzil, ze `execute_command npx tsc --noEmit` dziala poprawnie w runtime.

Status Etapu 2:

- [x] Dodac tracked write tool, np. `coding.write_file_tracked(taskId, path, content, summary)`, ktory wymusza artifact + snapshot before + zapis + snapshot after w jednej sciezce.
- [x] Zostawic surowe `write_file` tylko jako awaryjne narzedzie z approval, a codzienna prace agenta przeniesc na tracked write.
- [x] Dodac tracking komend weryfikacyjnych do artifactu, zeby `commandsRun` i `testResult` nie zalezal tylko od recznej aktualizacji przez model.
- [x] Dodac test narzedziowy dla tracked write: nowy plik, edycja istniejacego pliku, `reject_file`, konflikt po zmianie usera.
- [x] Zaktualizowac prompt `coding/base.md`, zeby Etap 2 byl domyslna sciezka pracy.

Status Etapu 3:

- [x] Zbudowano narzędzia worktree (`init_worktree`, `remove_worktree`).
- [x] Zastosowano resolver ścieżek `getWorkspacePath`.
- [x] Zaimplementowano narzędzie The Merge (`coding.apply_patch`).
- [x] Przeprowadzono walidację E2E Worktree.

Status Etapu 4 (CodeReview Agent & Orkiestracja Workflow) — UKOŃCZONY:

- [x] Stworzono `codeReviewAgent` z dedykowanym promptem (`prompts/coding/review.md`).
- [x] Dodano narzędzie `coding.submit_review` (submitReviewTool) do rejestracji werdyktu w Mongo.
- [x] Zarejestrowano agenta i narzędzia w głównym pliku Mastra (`index.ts`).
- [x] Zbudowano bazowy `repo-maintenance-workflow` z krokami Coding → Review.
- [x] Przeprowadzono test E2E w Mastra Studio: codingAgent stworzył artefakt, reviewer go zrecenzował i zapisał werdykt w Mongo.

Status Etapu 5 (Review Loop + Suspend/Resume + Reviewer Worktree Tools) — UKOŃCZONY:

Plan:
1. `decision-gate` step: bramka decyzyjna po Code Review.
2. Jeśli `approve` → workflow zawieszany (`suspend`) z komunikatem i oczekuje na `confirmMerge: true` od człowieka.
3. Po `resume` z `confirmMerge: true` → automatycznie `coding.apply_patch` + `coding.remove_worktree`.
4. Jeśli `needs_changes` → pętla naprawcza (codingAgent poprawia, codeReviewAgent re-review), max 3 iteracje.
5. Jeśli `block` lub limit iteracji → natychmiastowe zatrzymanie z komunikatem.

Zaimplementowano:
- [x] `decision-gate` step z `suspendSchema` i `resumeSchema`.
- [x] Pętla naprawcza wewnątrz bramki (do MAX_REVIEW_ITERATIONS = 3).
- [x] Auto-merge po zatwierdzeniu przez człowieka.
- [x] Kompilacja TSC czysta (0 błędów).
- [x] Narzędzia worktree dla reviewera: `coding.worktree_diff`, `coding.list_worktree_files`, `coding.read_worktree_file`.
- [x] Automatyczne wypełnianie `diffSummary` (backup w kodzie workflow po zakończeniu pracy codingAgent).
- [x] Test E2E w Mastra Studio: pełny cykl coding → review (approve) → suspend → resume (confirmMerge: true) → apply_patch → cleanup worktree. Plik wylądował w live repo, commit zmergowany na mastera.

Status Etapu 6 (Blue-Green Deployment) — ZAKOŃCZONO:

Zaimplementowano:
- [x] Health endpoint (`/deploy/health` oraz natywne `/health`).
- [x] Deploy config `deploy.config.json` — Slot A (:4111 live), Slot B (:4222 staging), health params.
- [x] Deploy script `scripts/deploy-blue-green.sh` — rsync bez `.git` → build → start staging → health loop → fallback na błąd.
- [x] Integracja deploy step z `repo-maintenance-workflow` (krok `deploy-and-verify`).
- [x] Oczyszczenie historii repozytorium (GitHub push fix).

Status Etapu 7 (Self-Healing Error Collector) — ZAKOŃCZONO:

Zaimplementowano:
- [x] `ErrorCollector` service — dedup (hash signature), cooldown (60s), limit aktywnych (3), TTL (24h), self-protection.
- [x] Global Error Handlers — `process.on('uncaughtException')` + `process.on('unhandledRejection')`.
- [x] Kolekcja Mongo `auto_healing_tickets` z indeksami (ticketId unique, signature+status, TTL expiry).
- [x] Crash-test endpoint `/deploy/crash-test` do symulowania awarii i testowania E2E.
- [x] Status endpoint `/deploy/auto-heal-status` do diagnostyki aktywnych napraw.
- [x] Integracja ticket resolution w `deploy-and-verify` (auto-zamykanie po udanym deploy).
- [x] Rejestracja globalnych handlerów przy starcie Mastry w `index.ts`.
- [x] Konfiguracja ENV: `ERROR_COLLECTOR_ENABLED`, `COOLDOWN_MS`, `MAX_ACTIVE`, `TTL_HOURS`.
- [x] Dokumentacja: `docs/SELF-HEALING-ERROR-COLLECTOR.md`.
- [x] Kompilacja TSC czysta (0 błędów).

---

### Strategiczne innowacje dla Coding Agenta (Maj 2026)

Aby agent był jeszcze bardziej autonomiczny i stabilny w trudnych refaktorach, docelowo wdrażamy następujące ulepszenia:

1. [x] **Inline Verification wewnątrz Tracked Write:** Narzędzie `write_file_tracked` nie tylko robi snapshot i zapisuje plik, ale asynchronicznie odpytuje kompilator/linter.
2. [x] **Dekompozycja Stanu (Ledger vs Artifact):** Kompresja JSON.
3. [x] **Staging Worktree (Podstawa i Narzędzia):** Agent otrzymał resolver ścieżek `getWorkspacePath(taskId)` oraz dwa potężne narzędzia `coding.init_worktree` (kopiujące `.env` i separujące branch) oraz `coding.remove_worktree`. Operacje dyskowe lądują teraz w wyznaczonym worktree!
4. [x] **The Merge (`coding.apply_patch`):** Narzędzie do finalizacji zadań. Commituje zmiany z worktree i wywołuje `git merge` w środowisku Live, z wbudowaną ochroną (automatyczny `--abort` na wypadek konfliktów).
5. [x] **CodeReview & Workflow:** Podział obowiązków między codingAgent i codeReviewAgent w ramach Mastra Workflow.
6. [x] **Decision Gate + Suspend/Resume:** Bramka decyzyjna z Human-in-the-Loop. Approve → suspend → merge. Needs_changes → pętla naprawcza (max 3).
7. [x] **Reviewer Worktree Tools:** Narzędzia do inspekcji worktree przez codeReviewAgent (`worktree_diff`, `list_worktree_files`, `read_worktree_file`). Reviewer sam sprawdza pliki zamiast polegać na metadanych.
8. [x] **Blue-Green Deployment:** Dwie instancje Mastry, skrypt izolujący build, weryfikacja logiki deploymentu (dry-run) przez dedykowany krok w workflow po zmergowaniu kodu.
9. [x] **Self-Healing Error Collector:** `ErrorCollector` z deduplikacją, cooldownem i limitem. Globalne handlery `uncaughtException`/`unhandledRejection`. Auto-trigger `repo-maintenance-workflow`. Crash-test endpoint do E2E.
10. [x] **Faza Diagnostyczna (Diagnose → Patch split):** Workflow rozbity na `diagnose-and-plan` (szerokie badanie kontekstu, analiza wpływu, plan z subtaskami) → `execute-patch` (realizacja planu). Prompt diagnostyczny ładowany dynamicznie z `prompts/coding/diagnose.md` — NIE siedzi w base.md agenta. Schema `diagnosticPlan` w artifact z subtaskami, priorytetami i zależnościami — gotowa do dekompozycji na subagentów w Etapie 8.
11. [x] **Model Capability Registry + Smart Router:** Centralny rejestr modeli (`config/model-capabilities.ts`) z VRAM budgetem, bezpiecznymi limitami kontekstu (anti-freeze), tier-ami (micro/light/heavy/cloud-fast/cloud-pro) i concurrent slots. `SmartRouter` (`services/smart-router.ts`) buduje graf zależności subtasków, organizuje je w grupy parallel execution i przypisuje najtańszy model zdolny obsłużyć daną złożoność, respektując limit 16GB VRAM (overflow → cloud). Subtask schema rozszerzony o `assignedModel`, `parallelGroup`, `estimatedVramMb`.
12. [x] **Model Availability Check (Etap 8.1):** `services/model-availability.ts` — weryfikacja dostępności modeli przy starcie. Ollama: `ollama list` → parse → porównanie z registry. Cloud: lightweight ping per provider (Google/OpenAI/Anthropic) z timeout 5s. Aktualizacja `available` in-memory w `modelRegistry`. Endpoint diagnostyczny `/deploy/model-status`. Cache z TTL 60s. Quick-check wariant `verifyPlanModels()` do weryfikacji tylko modeli z bieżącego planu przed dispatch.
13. [x] **Subtask Executor (Etap 8.2):** `services/subtask-executor.ts` — wrapper wykonujący pojedynczy subtask z scope-owanym promptem. Agent dostaje wąski kontekst (tylko swoje pliki docelowe, opis i kontekst z poprzednich subtasków) zamiast całego planu. Timeout per complexity (trivial=30s, simple=60s, moderate=120s, complex=300s). Zbiera wyniki z artifact Mongo po wykonaniu.
14. [x] **Intelligent Retry & Escalation (Etap 8.3a):** Walidacja jakości wyniku subtaska przez 5 sygnałów: `no_files_changed`, `tsc_errors`, `target_files_missed`, `agent_reported_failure`, `empty_diagnostics`. Trzy poziomy reakcji: (1) RETRY z wzbogaconym promptem (błędy + kontekst z poprzedniej próby), (2) ESCALATE do mocniejszego modelu (micro→light→heavy→cloud-fast→cloud-pro), (3) MARK `needs_human`. Max 3 próby. Pełna historia eskalacji w `qualityCheck`.
15. [x] **Parallel Dispatch Engine (Etap 8.3):** `services/parallel-dispatch.ts` — sekwencyjny dispatch grup, równoległy wewnątrz grupy przez `Promise.allSettled`. Pre-flight VRAM check per grupę. Circuit breaker na critical subtask failure (przerywa kolejne grupy). Result aggregator z conflict detection (ten sam plik edytowany przez >1 subtask). Pauza 2s między grupami na VRAM unload. Endpoint diagnostyczny `formatDispatchResult()`.
16. [x] **Offline Fallback (Etap 8.4):** Wbudowany w `executeSubtask()` — heurystyczna detekcja błędów infrastrukturalnych (timeout, ECONNREFUSED, 503, OOM, rate limit). Cloud error → re-route do najtańszego local (jeśli VRAM). Local error → re-route do najtańszego cloud. Max 1 fallback attempt. Odróżnia błędy infrastrukturalne (fallback) od logicznych (retry/escalation w 8.3a).
17. [x] **Integration: execute-patch refactor (Etap 8.5):** `repo-maintenance.ts` execute-patch refactored z PATH A (parallel dispatch) i PATH B (legacy fallback). PATH A: czyta `routingSummary` z artifact → `dispatchSubtasks()` → agregacja wyników → zapis `dispatchResult` w Mongo → auto-diff. PATH B: zachowany stary single-agent mode gdy brak routingu. Pełna backward-compatibility.
18. [x] **GitHub Service (Etap 9.1):** `services/github.ts` — centralny klient GitHub API via `@octokit/rest`. Funkcje: `pushBranch()` (git push via CLI), `createPR()` (Octokit REST), `getPRStatus()` (check runs + combined status), `waitForCI()` (polling co 30s, max 5 min), `mergePR()` (squash merge via API), `deleteRemoteBranch()`, `getGitHubStatus()` (diagnostyka). Config: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_PR_MODE`, `GITHUB_AUTO_MERGE`.
19. [x] **GitHub Actions CI (Etap 9.2):** `.github/workflows/ci.yml` — pipeline na `pull_request` do `master`. Steps: checkout → Node 22 setup (npm cache) → `npm ci` → `npx tsc --noEmit` → `npm run build`. Timeout 10 min.
20. [x] **PR Body Builder (Etap 9.3):** `services/pr-body-builder.ts` — generuje ustrukturyzowane opisy PR: root cause, tabela zmian (plik/subtask/model/status), dispatch summary (succeeded/failed/needsHuman), review verdict, quality checklist. Generuje tytuł PR (auto-heal prefix) i labels (`bot`, `auto-heal`, `local-model`/`cloud-model`, `high-risk`, `needs-human`).
21. [x] **Decision Gate PR Mode (Etap 9.4):** `decision-gate` refactored: `GITHUB_PR_MODE=true` → commit w worktree → push branch → create PR z body/labels → waitForCI → suspend. Resume: merge PR via API (squash) → delete remote branch → git pull local → remove worktree. `GITHUB_PR_MODE=false` → legacy local merge. Endpoint `/deploy/github-status`.
22. [x] **Branch Cleanup (Etap 9.6):** Jednorazowe wyczyszczenie 6 stałych worktrees i task-* branchy. Auto-cleanup po `mergePR` (deleteRemoteBranch + remove_worktree). `.gitignore` zahardowany (sekrety, credentials, klucze prywatne, bazy danych).
23. [ ] **Graceful Swap (Etap 10.1):** `deploy-blue-green.sh` rozszerzony o prawdziwy swap: backup buildu Live → kill staging → kill Live → restart staging code na porcie Live (:4111) → health verify → launch watchdog. Emergency rollback z backupu jeśli post-swap health fail. `deploy.config.json` rozszerzony o sekcję `watchdog` i `rollback.backupDir`.
24. [ ] **Watchdog Auto-Rollback (Etap 10.2):** `scripts/watchdog.sh` — 10-minutowy monitor post-swap. Co 30s sprawdza: process alive, `/health` endpoint, Mongo error count. 3 consecutive failures → auto-kill nowy Live → restore z backupu → alert via n8n webhook. Po 10 min bez problemów → "promoted". PID tracking w `.deploy/watchdog.pid`.
25. [ ] **Deploy Workflow Dual Mode (Etap 10.3):** `deploy-and-verify` step obsługuje `DEPLOY_AUTO_SWAP=true` (pełny swap + watchdog) i `DEPLOY_AUTO_SWAP=false` (dry-run, domyślne bezpieczne). Timeout zwiększony do 5 min dla swap mode.
26. [ ] **External Projects Workspace (Etap 10.4):** `workspaces/external-project-workspace.ts` — fabryka izolowanych workspace'ów dla kodowania INNYCH projektów. Katalog bazowy: `/projekty/agent-projects/<name>`. Safety: blokada dostępu do `/projekty/mastra-agentic-environment/`. Obsługa: git init, npm init, TypeScript template. Registry in-memory + listing z dysku.


---

Kluczowa zasada dla self-healing (wzmocniona przez Staging Worktree):

Agent docelowo nie powinien edytować live checkoutu, z którego aktualnie działa Mastra, jeżeli zadanie dotyczy kodu samej Mastry. Najpierw przygotowuje zmianę w staging worktree, zapisuje stan, testuje go na izolowanym porcie, a dopiero finalny approved/apply step przenosi zmiany do live i restartuje usługi.

## 1. Aktualny stan

Repo:

```txt
/projekty/mastra-agentic-environment/agentic-agents
```

Mastra core:

```txt
@mastra/core 1.31.0
```

Istniejace elementy:

- `src/mastra/index.ts` ma globalny `workspace` ustawiony na `/projekty/splot-projects`.
- `src/mastra/agents/meta-agent.ts` ma stare custom terminal tools w `ToolSearchProcessor`:
  - `fs.read_file`
  - `fs.write_file`
  - `shell.execute`
- `src/mastra/tools/terminal/terminal-tools.ts` uzywa sandboxa z Mongo setting `sandbox_path`, a gdy go nie ma, domyslnie `/tmp/sandbox-Jarvis`.
- To znaczy, ze meta-agent nie pracuje realnie na repo `agentic-agents`; probuje dzialac w osobnym sandboxie.

Problem:

- Gdy user prosi meta-agenta o prace na lokalnym repo, agent trafia w permission denied albo w zly katalog.
- `system.request_approval` istnieje, ale nie jest spiete z terminalem. To tylko rejestr approvala w Mongo, nie natywne zatrzymanie narzedzia terminalowego.

Wniosek:

- Nie rozszerzac starego `terminal-tools.ts` jako glownego narzedzia do developmentu.
- Zbudowac dedykowany `codingAgent` na natywnym Mastra `Workspace`.
- Meta-agent ma delegowac prace codingowa do `codingAgent`, a nie sam wykonywac terminal.

## 2. Docelowa architektura

### 2.1 Agenci

#### `metaAgent`

Rola:

- rozpoznaje intencje,
- deleguje coding tasks,
- zadaje pytania doprecyzowujace,
- zbiera wynik od `codingAgent`,
- pilnuje approvali.

Nie powinien miec pelnego terminala do repo.

#### `codingAgent`

Rola:

- czyta pliki,
- szuka po repo,
- uzywa LSP,
- proponuje i wprowadza zmiany,
- uruchamia bezpieczne komendy,
- dla ryzykownych komend pokazuje approval.

Model:

- lokalny mocniejszy model do rutynowych zmian, np. `ollama/local/qwen3-coder:30b`,
- fallback chmurowy do trudnych zmian, np. `google/gemini-2.5-pro`, `openai/gpt-5.2`, `anthropic/claude-sonnet-4-5`.

#### `codeReviewAgent`

Rola:

- nie edytuje plikow,
- ocenia diff,
- szuka regresji, ryzyk, brakujacych testow,
- sugeruje poprawki.

Model:

- najlepiej chmurowy lub mocny lokalny,
- ten agent powinien byc bardziej rygorystyczny niz kreatywny.

#### `testAgent` albo workflow step

Rola:

- uruchamia `npx tsc --noEmit`, testy, lint,
- streszcza output,
- nie pisze kodu.

To moze byc zwykly workflow step bez osobnego LLM.

### 2.2 Workspaces

Nalezy uzyc natywnego `Workspace` Mastry, nie custom terminal tools.

Workspace daje:

- filesystem,
- sandbox do komend,
- search/BM25,
- skills,
- approval per tool,
- LSP inspection.

Konfiguracja powinna byc agent-specific, czyli przypieta do `codingAgent`, nie tylko globalnie w `new Mastra({ workspace })`.

### 2.3 Jak user bedzie tego uzywal

System ma wspierac trzy rownolegle tryby pracy. To nie sa alternatywy do wyboru, tylko trzy przydatne sciezki:

#### Direct coding

User pisze bezposrednio do `codingAgent`, gdy wie, ze zadanie dotyczy kodu.

Przyklad:

```txt
Napraw blad walidacji w crm.search_leads i odpal tsc.
```

`codingAgent`:

- szuka kontekstu po repo,
- czyta pliki,
- uzywa LSP,
- robi zmiany,
- uruchamia lokalna weryfikacje,
- zostawia raport z diffem i komendami.

#### Meta-agent jako manager

User pisze do `metaAgent`, a `metaAgent` rozpoznaje, ze to zadanie kodowe i deleguje do `codingAgent`.

Przyklad:

```txt
Sprawdz czemu meta-agent ma permission denied przy terminalu i napraw.
```

`metaAgent`:

- rozpoznaje intencje,
- deleguje do `codingAgent`,
- moze poprosic `codeReviewAgent` o review,
- oddaje userowi finalny raport.

#### Repo maintenance workflow

User albo system uruchamia workflow na podstawie bledu, logow lub failing command.

Przyklad:

```txt
Uruchom repo-maintenance dla ostatniego bledu z logow Mastry.
```

Workflow:

- zbiera logi,
- prosi `codingAgent` o diagnoze i patch,
- odpala testy/tsc,
- prosi `codeReviewAgent` o review,
- zatrzymuje sie na approval przed finalizacja.

VS Code zostaje podgladem repo i diffow. Mastra Studio jest miejscem rozmowy z agentem, approvali i raportow.

### 2.4 Task artifacts

Kazdy coding task powinien zostawiac jawny artefakt pracy. To jest lokalny odpowiednik Antigravity Artifacts: user widzi nie tylko finalna odpowiedz, ale tez plan, dotkniete pliki, komendy i wynik weryfikacji.

Minimalny ksztalt artefaktu:

```ts
type CodeTaskArtifact = {
  taskId: string;
  status: 'planning' | 'editing' | 'testing' | 'reviewing' | 'waiting_approval' | 'done' | 'failed';
  agentId: 'codingAgent' | 'codeReviewAgent' | 'metaAgent';
  userRequest: string;
  plan: string[];
  filesRead: string[];
  filesChanged: Array<{
    path: string;
    beforeHash: string;
    afterHash: string;
    summary: string;
  }>;
  commandsRun: Array<{
    command: string;
    approvalRequired: boolean;
    exitCode?: number;
    summary: string;
  }>;
  approvalsRequested: Array<{
    approvalId: string;
    reason: string;
    status: 'pending' | 'approved' | 'rejected';
  }>;
  diffSummary: string;
  testResult?: {
    command: string;
    status: 'passed' | 'failed' | 'skipped';
    summary: string;
  };
  reviewVerdict?: 'approve' | 'needs_changes' | 'block';
  rollbackAvailable: boolean;
  createdAt: string;
  updatedAt: string;
};
```

Przechowywanie:

- kolekcja Mongo `code_task_artifacts`,
- opcjonalnie kopia plikowa w `.mastra/code-runs/<taskId>/artifact.json`,
- finalny raport agenta powinien linkowac/odnosic sie do tego `taskId`.

Docelowo artefakt powinien byc kompatybilny z grafem zadan `codingMasterAgent`.
Nie trzeba tego w pelni implementowac w MVP, ale schemat i indeksy powinny byc
latwe do rozszerzenia o:

- `rootTaskId` i `parentTaskId`,
- `coordinatorAgentId` i `assignedAgentId`,
- role workera, np. `frontend`, `backend`, `tester`, `reviewer`, `docs`, `repo-maintenance`,
- `modelAlias` i opcjonalny `modelOverride`,
- `workspaceId`, `repoId`, `repoSlot`,
- zaleznosci miedzy subtasks,
- liste dokumentow zaktualizowanych w ramach zadania.

## 3. Pliki do dodania

Dodaj:

```txt
src/mastra/workspaces/code-workspace.ts
src/mastra/agents/coding-agent.ts
src/mastra/agents/code-review-agent.ts
src/mastra/prompts/coding/base.md
src/mastra/prompts/coding/review.md
src/mastra/tools/dev/code-task-artifacts.ts
src/mastra/tools/dev/code-change-ledger.ts
src/mastra/workflows/dev/repo-maintenance.ts
src/mastra/config/dev-workspaces.ts
```

Opcjonalnie pozniej:

```txt
src/mastra/tools/dev/git-tools.ts
src/mastra/tools/dev/approval-resolver.ts
src/mastra/scripts/check-workspace-agent.ts
src/mastra/scripts/index-code-workspace.ts
```

## 4. Konfiguracja modeli

Rozszerz `src/mastra/config/workflow-models.ts`.

Dodaj:

```ts
export const workflowModels = {
  // ...

  coding: {
    default: modelPresets.localReasoning,
    patch: modelPresets.localReasoning,
    review: modelPresets.googlePro,
    selfHealingPlanner: modelPresets.localReasoning,
    selfHealingReview: modelPresets.googlePro,
    jsonRepair: modelPresets.localMarketing,
  },
} as const;
```

Jesli chcesz trzymac coding modele osobno, mozna dodac `src/mastra/config/coding-models.ts`, ale lepiej zostac przy jednym centralnym pliku, bo juz mamy `workflow-models.ts`.

## 5. Workspace dla repo

Utworz `src/mastra/workspaces/code-workspace.ts`.

Proponowany szkic:

```ts
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';

export const AGENTIC_AGENTS_REPO = '/projekty/mastra-agentic-environment/agentic-agents';

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isReadOnlyCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /^pwd$/,
    /^ls(\s|$)/,
    /^find\s/,
    /^rg(\s|$)/,
    /^sed\s+-n\s/,
    /^cat\s/,
    /^head(\s|$)/,
    /^tail(\s|$)/,
    /^wc(\s|$)/,
    /^git\s+status(\s|$)/,
    /^git\s+diff(\s|$)/,
    /^git\s+log(\s|$)/,
    /^git\s+show(\s|$)/,
    /^git\s+branch(\s|$)/,
  ].some((pattern) => pattern.test(c));
}

function isSafeVerificationCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /^npx\s+tsc\s+--noEmit$/,
    /^npm\s+test(\s|$)/,
    /^npm\s+run\s+test(\s|$)/,
    /^npm\s+run\s+lint(\s|$)/,
    /^npm\s+run\s+build(\s|$)/,
    /^pnpm\s+test(\s|$)/,
    /^pnpm\s+lint(\s|$)/,
    /^pnpm\s+build(\s|$)/,
  ].some((pattern) => pattern.test(c));
}

function isNetworkCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /^npm\s+install\b/,
    /^pnpm\s+install\b/,
    /^npm\s+update\b/,
    /^pnpm\s+update\b/,
    /^npx\s+(?!tsc\s+--noEmit\b)/,
    /^curl\b/,
    /^wget\b/,
    /^git\s+fetch\b/,
    /^git\s+pull\b/,
    /^docker\s+pull\b/,
    /^docker\s+compose\s+pull\b/,
    /\bnode\s+.*fetch\s*\(/,
  ].some((pattern) => pattern.test(c));
}

function isBlockedCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /\brm\s+-rf\b/,
    /^rm\s/,
    /^sudo\b/,
    /^su\b/,
    /^chmod\s+-R\b/,
    /^chown\s+-R\b/,
    /^git\s+reset\b/,
    /^git\s+clean\b/,
    /^git\s+checkout\s+--\b/,
    /^git\s+push\s+--force\b/,
    /^docker\s+system\s+prune\b/,
    /^mongo\b.*--eval\b.*drop/i,
    /\bdropDatabase\s*\(/i,
  ].some((pattern) => pattern.test(c));
}

function requiresCommandApproval(command: string): boolean {
  if (isBlockedCommand(command)) return true;
  if (isNetworkCommand(command)) return true;
  if (isReadOnlyCommand(command)) return false;
  if (isSafeVerificationCommand(command)) return false;
  return true;
}

export const codeWorkspace = new Workspace({
  id: 'agentic-agents-code-workspace',
  name: 'Agentic Agents Repo Workspace',

  filesystem: new LocalFilesystem({
    basePath: AGENTIC_AGENTS_REPO,
  }),

  sandbox: new LocalSandbox({
    workingDirectory: AGENTIC_AGENTS_REPO,
    isolation: 'bwrap',
    nativeSandbox: {
      // MVP: no network in the default coding sandbox.
      // Networked commands need a separate approved execution path.
      allowNetwork: false,
    },
  }),

  lsp: true,
  bm25: true,
  autoIndexPaths: [
    'src',
    'ideas',
    'docs',
    'scratch',
    'package.json',
    'tsconfig.json',
  ],
  skills: [
    'src/mastra/_skills/terminal',
  ],

  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
      name: 'view',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      name: 'write_file',
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
      name: 'find_files',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
      name: 'search_content',
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      name: 'execute_command',
      requireApproval: ({ args }) => requiresCommandApproval(String(args.command ?? '')),
    },
    [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
      name: 'lsp_inspect',
    },
  },
});
```

Uwagi:

- `write_file` powinien miec `requireApproval: true` na MVP.
- `requireReadBeforeWrite: true` chroni przed nadpisaniem pliku, ktorego agent nie przeczytal.
- `execute_command` powinien wykonywac bez approval tylko read-only i test/build/lint.
- Dla `npm install`, migracji, `git commit`, `git push`, deploy, restartow i operacji destrukcyjnych approval jest wymagany.
- Defaultowy sandbox codingowy nie powinien miec internetu. Komendy sieciowe powinny isc przez osobna zatwierdzona sciezke, a nie przez zwykle `execute_command`.
- Nie indeksuj `node_modules`, `.git`, `.mastra/output`, `.env`, `src/mastra/public/mastra.duckdb*`.

Jezeli `LocalFilesystem` w tej wersji nie ma opcji ignore/exclude, ogranicz `autoIndexPaths` tylko do bezpiecznych katalogow, jak wyzej.

### 5.1 Repo indexing i odswiezanie indexu

Nie nalezy zakladac, ze agent "zna cale repo". Agent ma miec zestaw narzedzi do szybkiego zbierania kontekstu:

- `rg` / `search_content` dla tekstowego wyszukiwania,
- BM25 index dla szybkiego workspace search,
- `find_files` dla struktury katalogow,
- LSP dla symboli, definicji, typow i diagnostyki,
- jawne `view` dla plikow, ktore agent chce zmieniac.

Jak robia to dobre IDE:

- VS Code/Copilot uzywa hybrydy: workspace index, struktura plikow, search tekstowy, semantic search, LSP, aktywny plik, zaznaczenie i git state.
- Dla repo na GitHubie moze istniec remote index oparty o stan commitu.
- Dla lokalnych zmian VS Code bierze aktualny content plikow lokalnych, bo remote index nie zna uncommitted changes.

Nasza wersja MVP:

- `bm25: true`,
- `autoIndexPaths` tylko dla `src`, `docs`, `ideas`, `scratch`, `package.json`, `tsconfig.json`,
- `node_modules`, `.git`, `.mastra`, `.env` i pliki DB nigdy nie wchodza do indexu,
- po starcie Mastry workspace buduje/odswieza index,
- dodac tool albo skrypt `index-code-workspace.ts`, ktory pozwala recznie przebudowac index,
- po wiekszych zmianach agent moze wywolac `index_content` albo poprosic usera o odswiezenie indexu.

Indexowanie nie wymaga chatu LLM.

- BM25 i `rg` nie wymagaja LLM.
- LSP nie wymaga LLM.
- Semantic search wymaga embedding modelu, ale to nie jest chat LLM.
- Nie uzywac malego chat modelu typu Qwen 1.7B jako "indexera". Jesli bedzie potrzebny semantic index, lepiej uzyc modelu embeddingowego, np. `nomic-embed-text`, `bge-m3` albo embedding modelu pod kod.

Na MVP nie dodawac semantic embeddings, chyba ze BM25 + LSP beda niewystarczajace.

### 5.2 Network policy

Domyslny coding sandbox:

- `allowNetwork: false`,
- pozwala na lokalne komendy read-only,
- pozwala na lokalne testy/buildy, jesli zaleznosci sa juz zainstalowane,
- blokuje praktyczne skutki `curl`, `wget`, `npm install`, `git pull`, `docker pull`, nawet jesli filtr komend mialby blad.

Komendy sieciowe:

- wymagaja approval,
- powinny byc wykonywane przez osobny approved workflow/tool, nie przez zwykly sandbox,
- musza zapisac w artifact:
  - powod,
  - dokladna komende,
  - czy dotykaja lockfile,
  - czy zmieniaja dependencies,
  - wynik.

Na start nie budowac automatycznego network runnera. Gdy agent potrzebuje internetu, ma poprosic usera o zgode i jasno wyjasnic po co.

## 6. Prompt coding agenta

Utworz `src/mastra/prompts/coding/base.md`.

Tresciowo:

```md
# Coding Agent

Jestes lokalnym agentem developerskim dla repo GastroBridge / Agentic Agents.

## Zasady

- Pracujesz tylko w skonfigurowanym workspace repo.
- Najpierw czytasz kod i szukasz kontekstu, potem edytujesz.
- Nie zgadujesz API. Sprawdz pliki, typy, importy i lokalne wzorce.
- Preferuj male, odwracalne zmiany.
- Nie usuwasz zmian uzytkownika.
- Przed edycja pliku zawsze go przeczytaj.
- Po zmianach uruchom najtansza sensowna weryfikacje:
  - TypeScript: `npx tsc --noEmit`
  - testy/lint tylko jesli dotycza zmiany.
- Jesli komenda wymaga approval, popros o zgode i nie obchodz zabezpieczen.
- Nie wykonuj `git reset`, `git clean`, `rm`, `git push`, deploy ani migracji DB bez approval.
- Kazdy task kodowy ma miec artifact: plan, filesRead, filesChanged, commandsRun, diffSummary, testResult.
- Przed edycja zapisz snapshot przez change ledger, zeby user mogl odrzucic wszystkie zmiany albo pojedyncze pliki.

## Styl pracy

1. Zidentyfikuj pliki.
2. Przeczytaj minimalny potrzebny kontekst.
3. Zapisz plan w artifact.
4. Edytuj przez narzedzia objete ledgerem.
5. Uruchom weryfikacje.
6. Zaktualizuj artifact.
7. Podsumuj:
   - zmienione pliki,
   - wynik testow,
   - ryzyka,
   - rollback status,
   - nastepny krok.

## Narzedzia workspace

- `find_files` do listowania.
- `search_content` do szukania.
- `view` do czytania.
- `write_file` do edycji.
- `execute_command` do testow i diagnostyki.
- `lsp_inspect` do symboli, definicji i typow.
```

## 7. `codingAgent`

Utworz `src/mastra/agents/coding-agent.ts`.

Szkic:

```ts
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { loadPrompt } from '../lib/prompt-loader.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';
import { workflowModels } from '../config/workflow-models.js';

export const codingAgent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: await loadPrompt('coding/base'),
  model: workflowModels.coding.default,
  workspace: codeWorkspace,
  memory: new Memory({
    options: {
      lastMessages: 20,
    },
  }),
});
```

Wazne:

- Nie dodawaj starych `terminal-tools.ts`.
- Nie dawaj agentowi Gmail/CRM/n8n, chyba ze osobna potrzeba.
- Ten agent ma byc skoncentrowany na repo.

## 8. `codeReviewAgent`

Utworz `src/mastra/prompts/coding/review.md`.

```md
# Code Review Agent

Jestes rygorystycznym reviewerem.

Priorytety:

1. Bugi i regresje.
2. Bezpieczenstwo.
3. Brakujace testy.
4. Niezgodnosc ze stylem repo.
5. Nadmierny zakres zmian.

Nie przepisuj calego rozwiazania, jesli nie trzeba.
Zwracaj wynik po polsku.

Format:

## Findings
- [severity] file:line - opis problemu i konsekwencja

## Test gaps
- ...

## Verdict
approve | needs_changes | block
```

Utworz `src/mastra/agents/code-review-agent.ts`.

```ts
import { Agent } from '@mastra/core/agent';
import { loadPrompt } from '../lib/prompt-loader.js';
import { workflowModels } from '../config/workflow-models.js';

export const codeReviewAgent = new Agent({
  id: 'code-review-agent',
  name: 'Code Review Agent',
  instructions: await loadPrompt('coding/review'),
  model: workflowModels.coding.review,
});
```

Na start review agent nie musi miec workspace. Wystarczy, ze workflow poda mu diff i wyniki testow. Pozniej mozna mu dac read-only workspace.

## 9. Rejestracja agentow

W `src/mastra/index.ts`:

Dodaj importy:

```ts
import { codingAgent } from './agents/coding-agent';
import { codeReviewAgent } from './agents/code-review-agent';
```

Dodaj do `agents`:

```ts
agents: {
  // ...
  codingAgent,
  codeReviewAgent,
}
```

Opcjonalnie:

- usun globalny `workspace` z `new Mastra({ ... })`, jesli nie jest uzywany,
- albo zmien globalny workspace na repo, ale bezpieczniej jest miec workspace agent-specific.

Nie rekomenduje globalnego workspace jako glownego mechanizmu dla wszystkich agentow, bo marketing/sales/analytics nie potrzebuja terminala do repo.

## 10. Integracja z meta-agentem

### 10.1 Usunac albo ograniczyc legacy terminal tools

W `src/mastra/agents/meta-agent.ts` obecnie w `ToolSearchProcessor` sa:

```ts
readFileTool,
writeFileTool,
shellExecuteTool,
```

Docelowo:

- usun je z meta-agenta,
- albo zostaw tylko jako `legacy sandbox`, ale zmien opisy promptu, zeby meta-agent nie uzywal ich do repo.

Rekomendacja: usunac z poola meta-agenta, zeby nie mylil `/tmp/sandbox-Jarvis` z prawdziwym repo.

### 10.2 Dodac delegacje coding taskow

`system.delegate_task` musi wspierac `codingAgent`.

Sprawdz `src/mastra/tools/system/delegate-task.ts`.

Dodaj `codingAgent` do enum/listy targetow i routingu.

Opis:

```txt
codingAgent -> lokalna praca na repo, czytanie/edycja plikow, testy, build, LSP, przygotowywanie patchy.
codeReviewAgent -> review diffu, ryzyka, brakujace testy.
```

W `src/mastra/prompts/meta/base.md` dodaj do tabeli ekspertow:

```md
| `codingAgent` | Praca na lokalnym repo: analiza kodu, poprawki, testy, LSP | Workspace repo, terminal z approval |
| `codeReviewAgent` | Review diffu i ryzyk technicznych | Read-only review |
```

Dodaj regule:

```md
Jesli user prosi o prace na kodzie/repo/testach/terminalu, deleguj do `codingAgent`.
Nie uzywaj legacy `shell.execute` do repo.
```

## 11. Approval policy

### 11.1 Bez approval

Mozna wykonywac:

```txt
pwd
ls
find
rg
sed -n
cat
head
tail
wc
git status
git diff
git log
git show
npx tsc --noEmit
npm test
npm run test
npm run lint
npm run build
```

### 11.2 Approval wymagany

Wymagaj approval dla:

```txt
npm install
pnpm install
npm update
git commit
git push
git pull
git merge
git rebase
docker compose up/down
mastra start/dev jezeli uruchamia dlugi proces
migracje DB
skrypty dotykajace produkcyjnych danych
deploy
```

### 11.3 Zawsze blokuj albo wymagaj bardzo mocnego approval

```txt
rm
rm -rf
git reset
git clean
git checkout --
git push --force
chmod -R
chown -R
dropDatabase
docker system prune
```

### 11.4 Edycje plikow

Bootstrap MVP, zanim ledger bedzie gotowy:

- kazdy `write_file` wymaga approval,
- `requireReadBeforeWrite: true`.

Docelowy tryb codingowy po wdrozeniu change ledger:

- agent moze edytowac pliki w dozwolonym workspace bez approval per zapis,
- przed kazda edycja musi zapisac snapshot `before`,
- po edycji zapisuje hash i summary `after`,
- user moze odrzucic caly task albo pojedyncze pliki,
- commit/push/deploy/restart dalej wymagaja osobnego approval,
- edycje plikow spoza `allowedScope` sa blokowane albo wymagaja approval.

Po dodatkowym ustabilizowaniu:

- mozna pozwolic bez approval na edycje plikow w `ideas/`, `scratch/`, test fixtures,
- kod produkcyjny `src/` dalej approval albo approval tylko przy pierwszym zapisie w danym turnie.

### 11.5 Change ledger i rollback

Cel: osiagnac UX podobny do Antigravity/VS Code, gdzie agent moze przygotowac komplet zmian, a user moze jednym ruchem odrzucic calosc albo pojedyncze pliki.

MVP: snapshot ledger w tym samym repo.

Przed zapisem pliku agent zapisuje:

```ts
type CodeChangeSnapshot = {
  taskId: string;
  path: string;
  beforeHash: string;
  beforeContent: string;
  afterHash?: string;
  afterContent?: string;
  status: 'open' | 'accepted' | 'rejected' | 'conflict';
  createdAt: string;
  updatedAt: string;
};
```

Po zapisie pliku agent uzupelnia `afterHash` i `afterContent`.

Narzedzia:

```txt
coding.reject_file(taskId, path)
coding.reject_all(taskId)
coding.accept_file(taskId, path)
coding.accept_all(taskId)
```

Zasada bezpieczenstwa:

- `reject_file` wykonuje revert tylko jesli aktualny hash pliku == `afterHash`,
- jezeli user zmienil plik po pracy agenta, status zmienia sie na `conflict`,
- przy konflikcie agent nie nadpisuje zmian usera automatycznie,
- conflict wymaga recznej decyzji usera.

Przechowywanie:

- kolekcja Mongo `code_change_snapshots`,
- opcjonalnie kopia plikowa `.mastra/code-runs/<taskId>/snapshots/*.json`.

Wersja docelowa dla duzych zadan:

- git worktree per task, np. `/projekty/.agent-worktrees/<taskId>`,
- agent pracuje w osobnym katalogu,
- reject all = usuniecie worktree,
- accept = zastosowanie patcha do glownego repo,
- ten tryb jest bezpieczniejszy dla duzych refaktorow, ale mniej wygodny do natychmiastowego podgladu w aktualnym VS Code.

Rekomendacja:

- MVP: snapshot ledger w glownym repo, zeby VS Code od razu pokazywal diff,
- etap pozniejszy: worktree mode dla duzych/refaktoryzacyjnych zadan.

## 12. Repo maintenance workflow

Dodaj `src/mastra/workflows/dev/repo-maintenance.ts`.

Cel:

- samodzielna naprawa problemow po logach/testach,
- ale z approval przed zapisem finalnym, commitem albo restartem.

Input:

```ts
z.object({
  issue: z.string(),
  logs: z.string().optional(),
  failingCommand: z.string().optional(),
  allowedScope: z.array(z.string()).optional(),
  autoApply: z.boolean().default(false),
})
```

Kroki:

1. `create-artifact`
   - utworz `code_task_artifacts` dla runu.
   - Output: `taskId`, status `planning`.

2. `collect-context`
   - `codingAgent` szuka plikow i zbiera kontekst.
   - Output: podejrzane pliki, hipotezy, plan.
   - Zaktualizuj artifact: `plan`, `filesRead`.

3. `diagnose`
   - `codingAgent` analizuje logi i kod.
   - Output: root cause, minimal patch plan.

4. `prepare-patch`
   - `codingAgent` edytuje pliki.
   - Kazda edycja przechodzi przez change ledger.
   - Jesli `write_file` ma approval, Studio pokaze approval card.
   - Zaktualizuj artifact: `filesChanged`, `diffSummary`.

5. `verify`
   - uruchom:
     - `npx tsc --noEmit`,
     - testy specyficzne dla zmiany,
     - ewentualnie lint/build.
   - Output: status, raw logs skrocone do istotnych fragmentow.
   - Zaktualizuj artifact: `commandsRun`, `testResult`.

6. `review`
   - pobierz `git diff`.
   - `codeReviewAgent` ocenia diff + test output.
   - Output: `approve | needs_changes | block`.
   - Zaktualizuj artifact: `reviewVerdict`.

7. `repair-loop`
   - jezeli `needs_changes`, wroc do `prepare-patch`.
   - max 3 iteracje.

8. `human-approval`
   - workflow `suspend()` przed:
     - commitem,
     - pushem,
     - restartem,
     - deployem,
     - migracja DB.
   - Pokaz userowi artifact + diff + rollback options.

9. `finalize`
   - po approval wykonaj tylko zatwierdzone akcje.
   - Zaktualizuj artifact: `done` albo `failed`.

Pseudokod suspend step:

```ts
const humanApprovalStep = createStep({
  id: 'human-approval',
  inputSchema: z.object({
    summary: z.string(),
    diff: z.string(),
    tests: z.string(),
  }),
  suspendSchema: z.object({
    summary: z.string(),
    diff: z.string(),
    tests: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
  outputSchema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      return await suspend(inputData);
    }
    return {
      approved: resumeData.approved,
      feedback: resumeData.feedback,
    };
  },
});
```

Mastra zapisuje snapshot workflow przy `suspend()`, wiec run mozna wznowic po restarcie.

## 13. Self-healing system

Self-healing nie powinien znaczyc "agent sam deployuje poprawke".

Bezpieczny self-healing:

1. Trigger:
   - blad workflow,
   - failing trace,
   - test failure,
   - blad z logow terminala,
   - reczny request usera.

2. Agent robi:
   - diagnoze,
   - patch,
   - test,
   - review.

3. Agent NIE robi bez approval:
   - commit,
   - push,
   - deploy,
   - restart produkcji,
   - migracja danych.

4. Agent zapisuje wynik:
   - `reports` albo `shared_memory`,
   - `lesson_learned`,
   - link do diffu/trace.

### 13.1 Kolekcja Mongo na zadania naprawcze

Dodaj kolekcje `maintenance_tasks`:

```ts
{
  id: string,
  status: 'new' | 'diagnosing' | 'patching' | 'testing' | 'reviewing' | 'waiting_approval' | 'done' | 'failed',
  source: 'manual' | 'trace' | 'workflow' | 'test' | 'log',
  issue: string,
  logs?: string,
  suspectedFiles?: string[],
  changedFiles?: string[],
  testCommand?: string,
  testResult?: string,
  reviewVerdict?: 'approve' | 'needs_changes' | 'block',
  createdAt: string,
  updatedAt: string
}
```

### 13.2 Automatyczne lessons

Po udanej naprawie:

```ts
shared_memory.push_signal({
  type: 'lesson_learned',
  data: {
    task_pattern: 'repo maintenance failure fix',
    lesson: 'Co bylo przyczyna, jak wykryto, jaki patch zadzialal.',
    changedFiles: [...]
  },
  ttlHours: 720
})
```

## 14. GitHub i lokalny git

Rozdziel te dwie rzeczy:

- Workspace/local sandbox = lokalne pliki, lokalny git, testy.
- GitHub MCP/API = issue, PR, CI, review comments, remote branches.

MVP nie wymaga GitHub MCP.

Kolejnosc:

1. Najpierw lokalny `codingAgent`.
2. Potem workflow `repo-maintenance`.
3. Potem GitHub MCP albo GitHub app:
   - create PR,
   - read review comments,
   - check CI,
   - comment on PR.

Nie rob commit/push w pierwszej wersji. Najpierw pokazuj diff i testy.

## 15. Scorery i guardrails

Dodaj scorer `codingPatchCompletenessScorer`.

Plik:

```txt
src/mastra/scorers/coding-agent-scorer.ts
```

Sprawdzaj:

- czy agent przeczytal pliki przed edycja,
- czy uruchomil test/tsc,
- czy nie wykonal blokowanej komendy,
- czy final zawiera liste zmienionych plikow,
- czy nie zmienil plikow spoza scope.

Dodaj do `src/mastra/index.ts` w `scorers`.

## 16. Minimalny MVP

Zakres pierwszego PR:

1. `code-workspace.ts`
2. `coding-agent.ts`
3. `coding/base.md`
4. `code-task-artifacts.ts`
5. minimalny `code-change-ledger.ts`
6. rejestracja `codingAgent` w `index.ts`
7. rozszerzenie `workflow-models.ts`
8. meta prompt update z informacja, ze coding idzie przez `codingAgent`
9. usuniecie legacy terminal tools z meta-agent ToolSearchProcessor albo jasne oznaczenie ich jako legacy sandbox

Nie rob jeszcze:

- self-healing workflow,
- GitHub MCP,
- commit/push automation,
- remote sandbox.
- semantic embedding index.

Acceptance criteria MVP:

- W Mastra Studio widac `codingAgent`.
- Agent potrafi:
  - `find_files`,
  - `search_content`,
  - `view`,
  - `lsp_inspect`,
  - `execute_command: npx tsc --noEmit`.
- Proba wykonania `npm install` pokazuje approval.
- Proba `rm -rf` nie wykonuje sie bez approval.
- Domyslny coding sandbox nie ma network access.
- Agent potrafi zrobic mala zmiane w `ideas/*.md`.
- Edycja wymaga read-before-write.
- Coding task zapisuje artifact z planem, filesRead, filesChanged, commandsRun i testResult.
- `reject_all(taskId)` cofa zmiane agenta, jesli pliki nie byly pozniej edytowane przez usera.
- `npx tsc --noEmit` przechodzi po dodaniu agenta.

## 17. Drugi etap

Zakres drugiego PR:

1. `code-review-agent.ts`
2. `coding/review.md`
3. `repo-maintenance.ts`
4. `maintenance_tasks`, `code_task_artifacts`, `code_change_snapshots` indexes w `init-db.ts`
5. workflow registration w `index.ts`
6. meta prompt: "dla awarii kodu uruchom repo-maintenance"
7. reczny `index-code-workspace.ts` albo tool do odswiezania workspace indexu

Acceptance criteria:

- Workflow przyjmuje log bledu i znajduje podejrzane pliki.
- Przygotowuje patch.
- Uruchamia `npx tsc --noEmit`.
- Pobiera `git diff`.
- `codeReviewAgent` zwraca verdict.
- Workflow zatrzymuje sie na `suspend()` przed finalizacja.

## 18. Trzeci etap

Zakres:

- GitHub MCP/app integration,
- PR creation,
- CI check,
- review comments loop,
- optional branch management.

Approval wymagany dla:

- commit,
- push,
- PR open,
- merge,
- rerun CI,
- deploy.

## 19. Ryzyka

### 19.1 Agent nadpisze zmiany usera

Mitigacja:

- `requireReadBeforeWrite`,
- change ledger z `beforeHash`, `beforeContent`, `afterHash`,
- `reject_file` i `reject_all`,
- revert tylko jesli aktualny hash == `afterHash`,
- konflikt zamiast nadpisania, jezeli user edytowal plik po agencie,
- przed finalem `git diff --name-only`,
- zakaz `git checkout --`,
- zakaz `git reset`,
- final summary z lista plikow.

### 19.2 Agent uruchomi dlugi proces

Mitigacja:

- timeouty,
- approval dla `npm run dev`, `mastra dev`, `docker compose up`,
- uzycie background process manager dopiero w pozniejszym etapie.

### 19.3 Agent przeczyta sekrety

Mitigacja:

- nie indeksowac `.env`,
- prompt: nie czytac secrets bez wyraznej prosby,
- `SensitiveDataFilter` juz jest w observability,
- najlepiej dodac workspace exclude/allowed policy jesli dostepna w uzywanej wersji.

### 19.4 Agent sam naprawia wlasny runtime i psuje Mastrę

Mitigacja:

- self-healing robi patch + test + review,
- deploy/restart tylko po approval,
- zostawic mozliwosc recznego revertu przez czlowieka.

### 19.5 Agent uzyje internetu albo pobierze niechciane zaleznosci

Mitigacja:

- defaultowy coding sandbox ma `allowNetwork: false`,
- `npm install`, `curl`, `wget`, `git pull`, `docker pull` wymagaja osobnej zatwierdzonej sciezki,
- zwykle `execute_command` nie sluzy do komend sieciowych,
- kazda komenda sieciowa musi byc zapisana w artifact z powodem i wynikiem,
- lockfile/dependency changes wymagaja review.

## 20. Self-healing staging, restart i resume

To jest krytyczna czesc architektury, jesli agent ma kiedys naprawiac swoje wlasne repo.

Zasada:

- live runtime nie jest miejscem pracy agenta,
- live runtime tylko uruchamia aktualnie zatwierdzona wersje,
- agent przygotowuje zmiany w osobnym staging worktree,
- apply/restart jest osobnym etapem z approval albo jawnie wlaczonym trybem automatycznym.

### 20.1 Warstwy pracy

1. Live repo:
   - katalog, z ktorego dziala Mastra,
   - nieedytowany bezposrednio przez self-healing,
   - restartowany dopiero po zatwierdzeniu patcha.

2. Staging worktree:
   - np. `/projekty/.agent-worktrees/<taskId>`,
   - agent czyta, edytuje, testuje i reviewuje zmiany tutaj,
   - moze miec osobny branch `agent/self-heal/<taskId>`.

3. Runtime supervisor:
   - skrypt/systemd/n8n/docker entrypoint poza kodem agenta,
   - potrafi zatrzymac Mastrę, zastosowac patch, uruchomic build/test/health-check, zrestartowac kontenery,
   - po restarcie uruchamia resume pending tasks.

Dlaczego:

- jezeli agent zmieni kod live w trakcie `mastra dev`, watcher moze przeładowac uszkodzony kod i agent przestanie odpowiadac,
- jezeli zmiana zepsuje import/startup, agent nie bedzie w stanie sam cofnac zmiany,
- osobny supervisor musi byc prosty i odporny, bo to on ratuje system po blednym patchu.

### 20.2 Resume po restarcie

Kazdy self-healing task musi miec zapisany stan poza procesem Node:

```ts
type ResumableMaintenanceTask = {
  id: string;
  status:
    | 'planning'
    | 'patching'
    | 'testing'
    | 'reviewing'
    | 'waiting_apply'
    | 'applying'
    | 'restarting'
    | 'verifying_after_restart'
    | 'done'
    | 'failed'
    | 'rollback_required';
  workflowRunId?: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  patchCommit?: string;
  liveCommitBeforeApply?: string;
  lastCompletedStep: string;
  nextStep: string;
  lastCommand?: string;
  restartRequested: boolean;
  resumeAfterRestart: boolean;
  healthCheckUrl?: string;
  rollbackCommand?: string;
  createdAt: string;
  updatedAt: string;
};
```

Po starcie Mastry uruchamia sie lekki bootstrap:

```txt
resume-maintenance-pending
```

Ten bootstrap:

- szuka zadan `status in ['restarting', 'verifying_after_restart', 'rollback_required']`,
- sprawdza health endpointy,
- jezeli system wstal, wznawia workflow od `nextStep`,
- jezeli system nie wstal, oznacza task jako `rollback_required` i uruchamia bezpieczny rollback przez supervisora albo prosi usera o interwencje.

### 20.3 Apply/restart jako osobny protokol

Finalny apply nie powinien byc zwyklym `execute_command` od agenta.

Potrzebny jest osobny, maly i przewidywalny mechanizm:

```txt
agent-apply-patch --task <taskId>
agent-restart-stack --task <taskId>
agent-verify-health --task <taskId>
agent-rollback --task <taskId>
```

Minimalny flow:

1. Agent tworzy patch/commit w staging worktree.
2. Testy przechodza w staging.
3. Review agent zatwierdza albo wskazuje poprawki.
4. Task przechodzi w `waiting_apply`.
5. W trybie manualnym user zatwierdza apply.
6. Supervisor:
   - zapisuje `liveCommitBeforeApply`,
   - zatrzymuje dev server/kontenery wymagajace restartu,
   - aplikuje patch do live repo albo przelacza branch/symlink,
   - odpala build/test smoke,
   - restartuje serwery/kontenery,
   - zapisuje `resumeAfterRestart: true`.
7. Po restarcie bootstrap wznawia task i robi health-check.
8. Jezeli health-check przejdzie, task = `done`.
9. Jezeli health-check nie przejdzie, supervisor rollbackuje do `liveCommitBeforeApply`.

### 20.4 Poziomy automatyzacji przez ENV

Pelna automatyzacja powinna byc mozliwa, ale domyslnie wylaczona.

```txt
CODING_AUTONOMY_LEVEL=manual|assisted|autonomous
CODING_ALLOW_SELF_MODIFY=false
CODING_ALLOW_RESTART=false
CODING_ALLOW_NETWORK=false
CODING_MAX_REPAIR_ITERATIONS=3
CODING_MAX_CHANGED_FILES=20
CODING_REQUIRE_REVIEW=true
CODING_REQUIRE_HEALTHCHECK=true
```

Interpretacja:

- `manual`:
  - agent przygotowuje patch, test i review,
  - apply/restart/rollback tylko po user approval.

- `assisted`:
  - agent moze sam wykonac drobne, niskiego ryzyka apply w dozwolonym scope,
  - restart dalej wymaga approval,
  - network/dependencies/DB migracje wymagaja approval.

- `autonomous`:
  - agent moze zatwierdzac patch, restartowac i kontynuowac naprawe,
  - tylko jesli `CODING_ALLOW_SELF_MODIFY=true` i `CODING_ALLOW_RESTART=true`,
  - wymagany staging worktree, review, health-check i rollback,
  - nadal blokowac destructive operations bez osobnego allowlist.

Autonomous mode jest sensowny dla lokalnego/dev env. Nie traktowac go jako produkcyjnego defaultu.

### 20.5 Jak rosnie jakosc wraz z modelami

Architektura powinna zakladac, ze modele beda coraz lepsze.

Dlatego:

- modele sa aliasami w configu, nie zaszyte w agentach,
- task artifacts, testy, review i health-checki zostaja takie same niezaleznie od modelu,
- lepszy model dostaje te same narzedzia i guardrails, ale robi lepsze diagnozy i patche,
- lokalny fallback daje ci ciaglosc pracy offline, nawet jezeli chmurowy model nie jest dostepny.

To jest poprawny kierunek: inwestujemy w runtime, narzedzia, pamiec, rollback i ewaluacje, a jakosc rozumowania bedzie rosla wraz z podmienianymi modelami.

### 20.6 Dual repo / blue-green runtime

Jeszcze bezpieczniejszy wariant self-healing to dwa sloty repo/runtime:

```txt
/projekty/agent-runtime-a   # aktualnie aktywny slot
/projekty/agent-runtime-b   # pasywny slot do patchowania
/projekty/agent-current -> /projekty/agent-runtime-a
```

Zasada:

- system dziala z aktywnego slotu,
- agent pracuje na pasywnym slotcie,
- po testach supervisor przelacza `agent-current` albo kontener na nowy slot,
- stary slot zostaje nietkniety jako rollback target.

Minimalny flow:

1. Runtime dziala ze slotu A.
2. Agent dostaje blad/logi.
3. Supervisor synchronizuje slot B do aktualnego commita slotu A.
4. Agent przygotowuje patch w slotcie B.
5. Slot B przechodzi testy, build i review.
6. Supervisor zapisuje:
   - aktywny slot przed zmiana,
   - commit slotu A,
   - commit slotu B,
   - health-check URL,
   - timeout rollbacku, np. 120 sekund.
7. Supervisor przelacza runtime na slot B i restartuje uslugi.
8. Watchdog czeka maksymalnie 120 sekund na health-check.
9. Jezeli slot B wstanie:
   - status taska = `verifying_after_restart`,
   - agent dostaje logi startowe i kontynuuje zadanie.
10. Jezeli slot B nie wstanie:
   - supervisor automatycznie wraca na slot A,
   - status taska = `rollback_required` albo `failed_after_switch`,
   - logi z nieudanego startu slotu B sa zapisywane do task artifact,
   - agent po powrocie dostaje te logi jako material do kolejnej proby.

To jest lepsze niz praca w live repo, bo:

- stary runtime zostaje gotowy do natychmiastowego powrotu,
- nie trzeba odtwarzac plikow przez reczny revert,
- restart moze byc traktowany jak transakcja z timeoutem,
- agent moze uczyc sie z logow nieudanego slotu bez utraty dzialajacej wersji.

To jest w praktyce lokalny blue-green deployment. Dla self-modifying agenta to powinien byc docelowy tryb autonomiczny.

Przyklady ENV dla tego trybu:

```txt
CODING_DEPLOY_STRATEGY=worktree|blue_green
CODING_ACTIVE_SLOT=/projekty/agent-runtime-a
CODING_PASSIVE_SLOT=/projekty/agent-runtime-b
CODING_CURRENT_SYMLINK=/projekty/agent-current
CODING_HEALTHCHECK_TIMEOUT_SECONDS=120
CODING_AUTO_ROLLBACK=true
```

Wazne ograniczenia:

- przelaczenie slotu musi robic supervisor, nie LLM,
- health-check musi byc deterministyczny,
- rollback nie moze zalezec od dzialania nowego kodu,
- logi z nieudanego slotu musza byc zapisane poza slotem, np. Mongo albo `/projekty/agent-runtime-logs/<taskId>`.

### 20.7 Promocja slotu i synchronizacja repo

Po przelaczeniu na nowy slot nie nalezy od razu uznawac go za nowa baze pracy. Potrzebne jest okno stabilnosci.

Proponowany warunek promocji:

```txt
CODING_PROMOTION_STABILITY_SECONDS=300
CODING_PROMOTION_ERROR_THRESHOLD=0
```

Slot moze zostac promowany, jezeli przez 5 minut:

- health-check odpowiada poprawnie,
- proces Mastry nie restartuje sie w petli,
- logi nie zawieraja bledow poziomu `error`/`fatal`,
- kluczowe endpointy API/Studio odpowiadaja,
- pending workflow resume nie konczy sie bledem.

Flow po udanym switchu:

1. Slot A byl aktywny.
2. Agent przygotowal poprawke w slocie B.
3. Supervisor przelaczyl runtime na slot B.
4. Watchdog potwierdzil szybki health-check, np. po 120 sekundach.
5. System wchodzi w `stabilization_window`.
6. Przez 300 sekund supervisor zbiera:
   - logi startowe,
   - health-checki,
   - exit codes,
   - najwazniejsze trace errors.
7. Jezeli okno stabilnosci przejdzie, supervisor robi `promote_slot`.
8. Slot B staje sie oficjalnym aktywnym baseline.
9. Slot A zostaje zsynchronizowany z B i staje sie nowym pasywnym slotem do kolejnych zmian.
10. Agent moze kontynuowac prace tylko na pasywnym slocie A.

Synchronizacja slotow:

```txt
active_slot=B
passive_slot=A
baseline_commit=<commit_B_po_promocji>
```

Supervisor powinien wykonac synchronizacje deterministycznie, bez LLM:

- upewnic sie, ze pasywny slot nie ma niezapisanych zmian,
- jesli ma zmiany z niezakonczonego taska, oznaczyc task jako `conflict` i nie nadpisywac,
- ustawic pasywny slot na `baseline_commit`,
- odtworzyc dependencies/cache tylko jezeli potrzebne,
- zapisac w Mongo, ktory slot jest aktywny i jaki commit jest baseline.

Mozliwe implementacje:

1. Git branch/worktree:
   - sloty sa worktree tego samego repo,
   - promocja = commit/merge fast-forward na branch baseline,
   - sync pasywnego = reset pasywnego worktree do baseline,
   - wymaga ostroznego blokowania `git reset` tylko dla supervisora, nie dla agenta.

2. Rsync/copy:
   - slot pasywny jest kopiowany z aktywnego po promocji,
   - prostsze mentalnie,
   - wolniejsze i latwiej przypadkiem skopiowac smieci, jezeli nie ma dobrej listy exclude.

Rekomendacja:

- dla kodu uzywac git worktree + baseline branch,
- dla logow, artifactow, Mongo i cache trzymac dane poza slotami,
- agent nie wykonuje `git reset`; robi to tylko supervisor w kontrolowanym kroku sync.

Blokada rownoleglych zmian:

- w danym momencie tylko jeden self-healing task moze miec status `applying`, `restarting`, `stabilization_window` albo `promoting`,
- kolejne taski moga byc kolejkowane, ale nie moga edytowac slotu, ktory jest w trakcie promocji,
- po promocji wszystkie nowe taski startuja z aktualnego baseline.

Jezeli w 5-minutowym oknie pojawia sie blad:

- nie promowac slotu,
- jezeli blad jest krytyczny, rollback na poprzedni slot,
- jezeli blad jest niekrytyczny, status `needs_repair_on_passive_slot`,
- przekazac agentowi:
  - logi z okna stabilnosci,
  - commit nowego slotu,
  - informacje, czy rollback zostal wykonany,
  - ostatni dobry baseline.

To pozwala agentowi pracowac w cyklu:

```txt
patch passive -> switch -> observe 5 min -> promote -> sync old slot -> patch passive
```

To jest wlasciwy kierunek dla autonomicznej naprawy, bo agent zawsze pracuje na nieaktywnym slocie, a aktywny slot pozostaje chroniony przez health-check, rollback i promocje.

### 20.8 Docelowa hierarchia coding master

Strategiczny kierunek:

```txt
metaAgent
  -> codingMasterAgent
      -> codingWorkerAgent(frontend/backend/tester/reviewer/docs/maintenance)
          -> codingSubAgent(lokalny tani model albo wybrany model chmurowy)
```

Znaczenie warstw:

- `metaAgent` rozumie intencje usera i decyduje, ze to zadanie kodowe.
- `codingMasterAgent` dostaje glowny cel operacji, rozbija go na mniejsze zadania, dobiera workerow, pilnuje kolejnosci, konfliktow, artifactow, approvali i finalnej weryfikacji.
- `codingWorkerAgent` to rozwiniecie obecnego `codingAgent`: pracuje w przydzielonym repo/scope, moze czytac, edytowac, testowac i prosic o pomoc subagentow.
- `codingSubAgent` wykonuje male, dobrze ograniczone zadania: research w jednym katalogu, analiza bledu, przygotowanie wariantu testu, review wycinka diffu.

Decyzje na teraz:

- Obecny `codingAgent` zostaje MVP hybryda supervisora i workera. Nie rozdzielac go jeszcze fizycznie, ale projektowac artifacty, memory i model config tak, zeby pozniej mozna bylo wydzielic `codingMasterAgent` bez migracji calego systemu.
- Routing modeli ma byc konfiguracyjny. Domyslnie master uzywa mocniejszego modelu, workerzy moga uzywac modeli lokalnych/tanszych, a `modelOverride` pozwala recznie wlaczyc mocniejsze modele dla wszystkich warstw.
- Subagenci nie dostaja pelnego repo bez powodu. Dostaja scope, zadanie, limit narzedzi i zapis wyniku do parent artifact.
- Konflikty i scalanie wynikow workerow sa odpowiedzialnoscia `codingMasterAgent`, nie pojedynczego workera.
- Dla self-modifying flow obowiazuje dual repo/blue-green. Autonomiczne zmiany w kodzie agenta nie powinny isc bezposrednio w aktywny runtime.

### 20.9 Tworzenie nowych projektow przez coding master

`codingMasterAgent` powinien docelowo umiec zakladac nowe repozytoria/projekty, ale tylko w jawnie dozwolonych lokalizacjach.

Proponowane ENV:

```txt
CODING_PROJECTS_ROOT=/projekty/splot-projects
CODING_ALLOW_PROJECT_CREATE=false
```

Zasady:

- tworzenie projektu wymaga osobnego approval, dopoki nie ma zaufanej polityki automatyzacji,
- agent nie moze tworzyc projektow poza `CODING_PROJECTS_ROOT`,
- scaffold powinien inicjalizowac `README`, podstawowe docs, `.gitignore`, konfiguracje runtime i pierwszy artifact zadania,
- jezeli projekt jest tworzony z szablonu, szablon musi byc jawnie wybrany albo pochodzic z allowlisty,
- pierwszy commit/projektowy baseline robi deterministyczne narzedzie supervisora, nie swobodna komenda LLM,
- dokumentacja projektu jest czescia definition of done, nie dodatkiem po fakcie.

### 20.10 Dokumentacja jako wymagany artefakt

Kazdy istotny task codingowy powinien zostawiac trzy warstwy dokumentacji:

- task artifact: co agent zrobil, jakie pliki czytal/zmienial, jakie komendy uruchomil i jakie byly wyniki,
- dokumentacja techniczna w repo, jezeli zmiana dotyka zachowania, konfiguracji albo procesu,
- aktualizacja planu/decision logu, jezeli decyzja zmienia architekture albo kolejny etap prac.

To jest szczegolnie wazne dla ukladu z masterem i workerami, bo bez jawnych artifactow trudno bedzie debugowac, ktory agent podjal dana decyzje i dlaczego.

## 21. Test manualny po wdrozeniu

Po restarcie Mastry:

1. Zapytaj `codingAgent`:

```txt
Pokaż strukturę repo i znajdź plik definicji meta-agenta.
```

Oczekiwane:

- uzywa `find_files` albo `search_content`,
- znajduje `src/mastra/agents/meta-agent.ts`.

2. Zapytaj:

```txt
Uruchom npx tsc --noEmit.
```

Oczekiwane:

- wykonuje bez approval,
- zwraca status i istotny output.

3. Zapytaj:

```txt
Zmień literówkę w ideas/codding-agent.md.
```

Oczekiwane:

- najpierw czyta plik,
- zapisuje snapshot w change ledger,
- zapisuje zmiane albo prosi o approval, jesli ledger/write policy jest jeszcze w trybie bootstrap,
- artifact pokazuje `filesChanged`,
- `reject_all(taskId)` moze cofnac zmiane, jesli plik nie byl pozniej recznie edytowany.

4. Zapytaj:

```txt
Uruchom npm install lodash.
```

Oczekiwane:

- prosi o approval,
- nie wykonuje przez defaultowy coding sandbox,
- rekomenduje osobna approved network sciezke.

5. Zapytaj:

```txt
Usuń node_modules przez rm -rf node_modules.
```

Oczekiwane:

- blokuje albo wymaga bardzo jawnego approval,
- rekomenduje bezpieczniejsza alternatywe.

## 22. Decyzje projektowe

Rekomendowane decyzje:

- Meta-agent zostaje orkiestratorem.
- Coding agent dostaje workspace.
- Review agent jest osobny.
- Terminal legacy zostaje tylko dla izolowanych eksperymentow albo zostaje usuniety z meta-agent pool.
- Self-healing przygotowuje poprawki, ale nie deployuje bez czlowieka.
- GitHub MCP dopiero po lokalnym MVP.
- Self-modification dziala przez staging worktree i supervisor, nie przez edycje live runtime w trakcie pracy.
- Docelowa hierarchia to `metaAgent -> codingMasterAgent -> codingWorkerAgent -> codingSubAgent`.
- Obecny `codingAgent` jest MVP workera/supervisora; nie rozbijac go jeszcze, ale artifacty i memory projektowac pod przyszly task graph.
- Dla autonomicznej pracy nad samym soba preferowany jest dual repo/blue-green z deterministycznym supervisorem i auto-rollbackiem.
- Tworzenie nowych repo przez `codingMasterAgent` ma byc mozliwe tylko pod jawnie ustawionym `CODING_PROJECTS_ROOT` i z approval.
- Dokumentacja zmian jest wymagana czescia flow codingowego.

## 23. Zrodla

Mastra Workspaces:

```txt
https://mastra.ai/blog/announcing-mastra-workspaces
```

Mastra LSP inspection:

```txt
https://mastra.ai/blog/lsp-inspection-for-mastra-workspaces
```

Mastra human-in-the-loop / approval placement:

```txt
https://mastra.ai/blog/hitl-where-to-put-approval-in-agents-and-workflows
```

Mastra suspend/resume:

```txt
https://mastra.ai/docs/workflows/suspend-and-resume
```

VS Code workspace context / indexing:

```txt
https://code.visualstudio.com/docs/copilot/reference/workspace-context
```

Google Antigravity overview:

```txt
https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/
```
