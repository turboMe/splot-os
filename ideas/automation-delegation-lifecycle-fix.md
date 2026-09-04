# Automation Delegation Lifecycle Fix — plan naprawy

Data planu: 2026-06-23
Status: plan implementacyjny, bez zmian runtime w tym pliku.

Kontekst: pierwszy live test pełnej ścieżki **meta → automationArchitect** (prompt: codzienny digest newsów gastro → RSS z kilku źródeł → klasyfikacja Ollama → streszczenie Ollama → MongoDB → Telegram, „nie aktywuj"). Workflow zbudowany **znakomicie** — i jego jakość/rozmiar NIE są przedmiotem tej naprawy. Problemy leżą wyłącznie w plumbingu delegacji.

## 0. Status implementacji

Branch: `fix/automation-delegation-lifecycle`. tsc --noEmit: 0 błędów.

- [x] WS-A: Abortowalna delegacja (zabicie zombie po timeoutcie).
  - `generate-with-harness.ts`: `withTimeout` przyjmuje `onTimeout`; `callAgentGenerate` tworzy `AbortController`, wstrzykuje `abortSignal` do generateOptions (łączy z opcjonalnym `input.abortSignal` przez `AbortSignal.any`), abortuje na timeout. `HarnessGenerateInput.abortSignal?` dodane.
  - `delegate-task.ts`: nowy `generateWithAbortableTimeout(agent, prompt, options, targetAgent)` — abort na timeout; podmienione 3 ścieżki direct-generate (n8nMcpEngineer, deliberation, other). Ścieżki harness (automation/coding/knowledge) abortują przez harness wewnętrznie.
- [x] WS-B: Async-by-default dla buildów automation — flaga `FEATURE_AUTOMATION_ASYNC_DEFAULT` (default OFF) w `harness-flags.ts`; `delegate-task.ts` routuje golden_path do async gdy ON (read-only zawsze sync). Default OFF, bo sync+WS-C wraca szybko, a ścieżka async ma kruchy return path (pending-update na następną interakcję).
- [x] WS-C: Terminate-on-terminal — zrobione PROMPTEM (`prompts/automation/base.md` sekcja „Stop And Report On A Clean Terminal"): po `tested`/`draft_created` z automationId+workflowId i bez żądania aktywacji architekt MA wypisać raport i STOP, nie re-runować execute/deploy/test. Scorer GoalContract (kryteria: terminal status + automationId/workflowId) już kończy iterację, gdy raport jest na wyjściu. Świadomie NIE twardy `stopWhen` (ryzyko pustego finalnego tekstu → fałszywy failed). Twardy backstop konwergencji = ewentualny follow-up jeśli prompt okaże się za miękki live.
- [~] WS-D: Budżet timeoutu + uczciwy status na timeout + smoke regresyjny.
  - [x] Budżet env-override: `DELEGATION_AUTOMATION_TIMEOUT_MS` (default 600_000), `getAutomationDelegationTimeoutMs()` użyte w automation sync+async; dodane do `.env`/`.env.example`.
  - [ ] Uczciwy `partial_success` na timeout-with-artifact.
  - [ ] Smoke `check:automation-delegation-lifecycle`.
- [ ] WS-E (opcjonalnie): odporność na transient `Error communicating with n8n` przy deploy.

## 1. Obserwacje z live testu (2026-06-23)

Oś czasu (kontrakt `goal-...`, agent `automationArchitect`, model deepseek-v4-pro):

- 19:06:20 — utworzony kontrakt delegacji meta→architekt. Deadline harnessu (300s) = ~19:11:20.
- 19:06:32 — `architect_match_pattern` success.
- 19:07:45 — `architect_execute_automation_request` success → `automation_requests.status = tested`. Workflow `1NqSL6jrtCAEVAm3` „Mastra - Gastro Daily News Digest" utworzony w n8n jako **inactive**, mock test OK. **Czas do kompletnego tested: ~85s.**
- 19:10:37 — `architect_deploy_automation` success (kolejny cykl, mimo że tested już był).
- ~19:11:20 — przekroczony próg 300s.
- 19:11:52 — kontrakt oznaczony `failed`. evidenceAgainst: „Harness LLM call timed out after 300s", „Harness failed before final response", „Delegation failed before producing an acceptable result". Zadziałał replan WS2 (plan revised — broken assumption).
- 19:12:42 — `architect_execute_automation_request` success (PO timeoutcie — zombie).
- 19:13:35 — `failure_case` zapisany (hook failure-learning zadziałał).
- 19:13:46 — `architect_test_workflow` success (zombie). Dalej `reflector_intervention`, spawn `run-worker-powerful-*`, kolejne `test_run` aż do restartu ~19:15+.

Fakty dodatkowe:
- Jeden deploy złapał transient `deployAutomationTool {success:false, message:"Error communicating with n8n"}`; architekt odzyskał (finalny stan tested).
- **Brak delegacji do n8nMcpEngineer i brak coverage gap** — architekt złożył kompletny custom workflow, pokrycie capability = OK, więc gate nie wymusił MCP. (Ścieżka MCP handoff sterowana przez meta wciąż nieobserwowana live — osobny TODO testowy, nie część tej naprawy.)
- **Brak duplikatów** w n8n (jeden workflow, aktualizowany in-place). Zombie NIE aktywował workflow (Telegram+Mongo → approval-gated).
- Drobiazg jakości danych: `automation_requests.workflowId` = undefined mimo utworzonego workflow (wfId nie został zapisany do dokumentu request).

## 2. Przyczyny źródłowe

- **RC1 — synchroniczny twardy timeout 300s.** Ścieżka meta→architekt idzie przez `generateAutomation` z `timeoutMs: 300_000` (`tools/system/delegate-task.ts`, gałąź `targetAgent === 'automationArchitect'`). Build automation (compose+deploy+test+repair) bywa legalnie dłuższy, a meta i czat usera są zablokowane.
- **RC2 — timeout anuluje CZEKANIE, nie PRACĘ.** `withDelegationTimeout` i harnessy używają `Promise.race` z timeoutem, ale przegrany promise (`agent.generate`) nie dostaje `AbortSignal`. Po 300s delegacja zwraca `failed`, a generacja architekta leci dalej jako **zombie** (~4+ min), pali compute, spawnuje workery i może mutować stan.
- **RC3 — brak przechwycenia pierwszego terminala.** Golden Path osiągnął `tested` (inactive) w 85s, ale wynik nie został przechwycony/zwrócony — agent (popychany m.in. przez in-flight Strategy Reflector) iterował dalej aż do timeoutu. Brak reguły „terminal status + brief spełniony → STOP i zwróć".
- **RC4 — UX: udany artefakt raportowany jako porażka.** Delegacja, która faktycznie wyprodukowała zdeployowany + przetestowany inactive workflow, zwróciła do meta `success:false` (timeout). User słyszy „nie udało się", choć się udało.

## 3. Zasady projektowe

- Nie ruszamy jakości/rozmiaru workflow ani zachowania kompozycji architekta — działa dobrze.
- Naprawiamy wyłącznie cykl życia delegacji: anulowanie, transport (async), wczesny terminal, uczciwy status.
- Zmiany addytywne i wstecznie kompatybilne; każda za env-flagą tam, gdzie zmienia zachowanie runtime.
- Golden Path pozostaje jedynym właścicielem deploy/test/activate. n8nMcpEngineer pozostaje read-only.
- Kod po angielsku; odznaczać etapy w tym pliku; docs na koniec; nie ruszać `agentic-agents-staging/`.

## 4. Plan naprawy

### WS-A — Abortowalna delegacja (priorytet 1, kasuje zombie)

Cel: po timeoutcie underlying generation faktycznie się zatrzymuje.

Prace:
1. Najpierw zweryfikować, że `agent.generate`/harnessy przyjmują `abortSignal` w opcjach (AI SDK to wspiera; potwierdzić wersję `@mastra/core`). Jeśli tak — przekazać sygnał. Jeśli nie — owinąć generację tak, by dało się ją przerwać (np. step-budget hard-stop w harnessie).
2. W `delegate-task.ts` wprowadzić `AbortController` per delegacja. `withDelegationTimeout` na timeout woła `controller.abort(reason)` ZAMIAST tylko rejectować race.
3. Przekazać `abortSignal` do: `agent.generate` (gałęzie direct + n8nMcpEngineer + pipeline), `generateAutomation`, `generateCoding`, `generateKnowledge`, `startAsyncDelegation`.
4. W harnessach: respektować `abortSignal` w pętli kroków (przerwać przed kolejnym tool/LLM call, gdy `signal.aborted`).
5. Strategy Reflector / `prepareStep`: gdy `signal.aborted`, nie wstrzykiwać kolejnych interwencji.

Acceptance:
- Wymuszony timeout testowy → **0 eventów `agent_events` z tego `taskId`/agenta w ciągu 15s** po deadline.
- Brak spawnu nowych workerów po deadline.

### WS-B — Async-by-default dla buildów automation (priorytet 1, kasuje fałszywe „failed" + blokadę czatu)

Cel: meta nie czeka 300s synchronicznie na build; user dostaje natychmiast „buduję, wrócę z wynikiem", a wynik wraca pending-update.

Prace:
1. Wykorzystać ISTNIEJĄCĄ ścieżkę async dla `automationArchitect` (`context.async` → `startAsyncDelegation` → pending-update). Nie budujemy od zera.
2. Routing: gdy `targetAgent === 'automationArchitect'` i tryb to build/golden_path (nie `read_only_analysis` wg `classifyAutomationArchitectDelegationMode`), domyślnie iść async. Read-only analysis zostaje sync.
3. Prompt meta + opis `delegateTaskTool`: dla budowania/wdrażania automatyzacji preferuj async (`async:true`, `callerAgentId:"meta-agent"`, `callerThreadId`).
4. Upewnić się, że pending-update z wynikiem trafia do właściwego `returnToThreadId` meta i jest czytelny dla usera (status + automationId + workflowId + active=false).
5. Opcjonalna flaga: `FEATURE_AUTOMATION_ASYNC_DEFAULT=true`.

Acceptance:
- Zlecenie buildu przez meta → natychmiastowa odpowiedź „rozpoczęto, wrócę z wynikiem" + `delegationId`.
- Po zakończeniu: pending-update z terminalnym statusem Golden Path i ID workflow.
- Czat usera nie wisi i nie dostaje „failed", gdy build trwa.

### WS-C — Terminate-on-terminal (priorytet 2, zwróć świetny wynik od razu)

Cel: gdy Golden Path osiągnie czysty terminal (`tested`/`draft_created`/`active`/`blocked`/`manual_review_required`) i brief jest spełniony (np. „zbuduj inactive, nie aktywuj"), przechwyć wynik i zakończ — zamiast pętlić. To NIE redukcja zakresu pracy, tylko rozpoznanie „gotowe" i szybkie zwrócenie dobrego artefaktu.

Prace:
1. W `generateAutomation` (harness) wykrywać, że `architect_execute_automation_request` zwrócił terminalny `tested`/`draft_created` z `workflowId`. Zapamiętać to jako kandydat-wynik.
2. Jeśli brief = „nie aktywuj" / read-only-deploy, po pierwszym czystym `tested` zakończyć turę i zwrócić wynik (bez wymuszania kolejnych cykli execute/deploy).
3. Strategy Reflector: po terminalu sukcesu z spełnionym celem NIE eskalować „popraw/iteruj". Dodać warunek goal-met → zakończ.
4. Naprawić zapis `automation_requests.workflowId` (był undefined), żeby przechwycenie i raport miały twarde ID.

Acceptance:
- Build, który osiąga `tested` w ~85s, zwraca wynik w ciągu ~kilkunastu sekund od tested, nie po 3-4 min.
- W `agent_events` brak kolejnych `architect_execute/deploy/test` po przechwyconym terminalnym tested (przy briefie „nie aktywuj").

### WS-D — Budżet timeoutu + uczciwy status + regresja

Prace:
1. Podnieść budżet automation delegation (np. 300s → 600s) jako siatka bezpieczeństwa, env-override `DELEGATION_AUTOMATION_TIMEOUT_MS`. Po WS-A/B/C rzadko będzie używany, ale chroni legalnie długie buildy.
2. Uczciwy status na timeout: jeśli artefakt powstał (workflow utworzony/tested) mimo timeoutu, kontrakt/odpowiedź ma to odzwierciedlać (np. `partial_success` + automationId/workflowId), nie czyste `failed`.
3. Smoke regresyjny `check:automation-delegation-lifecycle`:
   - wymusza krótki timeout testowy → asercja: brak zombie (0 eventów po deadline),
   - asercja: ścieżka async zwraca delegationId i potem pending-update,
   - asercja: po pierwszym `tested` brak dalszych cykli (early terminate),
   - cleanup utworzonego inactive workflow po ID (prefix smoke), `KEEP_SMOKE_WORKFLOWS` honorowany.

### WS-E — Transient n8n deploy (opcjonalnie, niski priorytet)

Prace:
1. W `architect_deploy_automation` odróżnić błąd transient (`Error communicating with n8n`, ECONNRESET/timeout) od błędu walidacji/policy.
2. Bounded retry z backoff (np. 2 próby) tylko dla transient connectivity, bez maskowania błędów walidacji.

## 5. Kolejność i ryzyka

Kolejność: WS-A (zombie to największe ryzyko: palenie compute + możliwa mutacja stanu) → WS-B (UX + odblokowanie czatu) → WS-C (efektywność + szybki zwrot dobrego wyniku) → WS-D (siatka + regresja) → WS-E.

Ryzyka:
- Abort w złym miejscu może uciąć trwający zapis do Mongo/n8n w połowie. Mitigacja: abort sprawdzać na granicy kroków (przed kolejnym tool call), nie w środku I/O; deploy/test idempotentne (update in-place po workflowId).
- Async zmienia kontrakt odpowiedzi meta (z pełnego wyniku na „started + pending"). Mitigacja: jasny komunikat + niezawodny pending-update; read-only analysis zostaje sync.
- Early-terminate nie może uciąć legalnej pętli repair po realnym błędzie walidacji. Mitigacja: terminować tylko na CZYSTYM terminalu sukcesu (tested/draft_created bez nierozwiązanych errors), nie na pierwszym deploy.

## 6. Acceptance całości

1. Po wymuszonym timeoutcie brak jakiejkolwiek aktywności osieroconej generacji (zero eventów po deadline).
2. Build przez meta nie blokuje czatu i nie raportuje „failed", gdy artefakt powstał.
3. Czysty `tested` inactive jest zwracany szybko po osiągnięciu, z automationId + workflowId.
4. Smoke lifecycle przechodzi i jest w CI manualnym (nie w domyślnym `check:automation`, bo wymaga live modeli).
5. Jakość/rozmiar generowanych workflowów bez zmian (poza zakresem).

---

# Live test #2 (2026-06-23, prompt: catering + Google Sheets) — findings + WS-E/F/G

## Przebieg
- meta→architekt→**MCP delegacja ODPALIŁA** (trudniejszy prompt zadziałał — Google Sheets pociągnął MCP). ✅
- Architekt zbudował `Catering Lead Form Handler` (`A3hYGmcYOYPMS7Ku`, inactive, 16 node'ów) — strukturalnie świetny (webhook→validate→IF→HTTP enrich→Ollama→IF hot/regular→Telegram+Gmail→Mongo→Google Sheets→respond).
- ALE: 2 kontrakty n8nMcpEngineer (failed 20:18:32→20:20:31, completed 20:25:29→20:26:00), **toolId=ZERO w obu** — engineer NIGDY nie wywołał realnego narzędzia MCP.
- Architekt NIE zrobił fail-closed: retry MCP + **10× execute/deploy**, churn do ~okolic 900s; WS-A wygasił run cicho (bez churning-zombie). ✅ WS-A.
- Symptom braku realnej walidacji: `Google Sheets [googleSheets v2]` — typeVersion przestarzały (aktualny v4+); `validate_node` by to złapał.

## DLACZEGO MCP nie zadziałał (root cause)
- n8n-mcp serwer jest ZDROWY: standalone `listToolsets` zwraca 7 narzędzi w ~587ms.
- Engineer ładuje narzędzia w `n8n-mcp-engineer.ts:loadAllowedN8nMcpTools()` przez **WSPÓLNY `mcpClient`** (mcp.ts spawnuje 7 serwerów: notebooklm, playwright, firecrawl, gmail, n8n-mcp, context7). Na DOWOLNYM błędzie `catch` po cichu zwraca `{}` (tylko `console.warn`). Ładowane RAZ przy module-init (na całe życie procesu).
- Efekt: przy tym starcie engineer dostał **pusty toolset** (kruchość współdzielonego spawn/timing) → uruchomił się BEZ narzędzi → **sfabrykował handoff z wiedzy modelu** (deepseek), nie z realnego MCP.
- Kontrakt `evaluateN8nMcpEngineerDelegationContract` sprawdza TYLKO słowa-klucze w TEKŚCIE (`hasN8nMcpHandoffEvidence` regex) → drugi sfabrykowany handoff (z właściwymi słowami) przeszedł jako „completed". Strażnik nie weryfikuje REALNEGO użycia narzędzi.
- (Drugorzędnie możliwe: deepseek „narrating without executing". Naprawy poniżej pokrywają oba przypadki.)

## Problemy
- P1 (root): ładowanie toolsetu MCP engineera kruche + ciche → bieg bez narzędzi.
- P2: kontrakt weryfikuje TEKST, nie realne tool-calle → akceptuje fabrykację.
- P3: architekt nie egzekwuje fail-closed po nieudanym MCP handoff → churn (10× execute/deploy).
- P4: nieaktualne typeVersion w wyjściu (googleSheets v2) — skutek braku realnej walidacji.

## WS-E — niezawodność n8nMcpEngineer (priorytet 1) — DONE (tsc 0, dedicated client live-verified 593ms/7 tools)
- [x] E1: DEDYKOWANY `n8nMcpClient` tylko z `n8n-mcp` (`mcp.ts`, id `n8n-mcp-dedicated`, timeout 60s); n8n-mcp USUNIĘTY ze współdzielonego `mcpClient`. Engineer importuje `n8nMcpClient`/`n8nMcpEnabled`. Probe realnego eksportu: 7 tools w 593ms.
- [x] E2: FAIL LOUD — loader loguje `console.error` (nie warn) z jasnym skutkiem; przy pustym toolset engineer i tak zostanie odrzucony przez F1 (twardy guarant).
- [x] E3: Retry (2 próby) w loaderze; lazy-load zbędny — dedykowany klient ładuje niezawodnie w ~0.6s przy module-init.

## WS-F — weryfikacja REALNEGO użycia narzędzi (priorytet 1) — DONE (tsc 0)
- [x] F1: `delegate-task.ts` — `extractCalledToolNames(response)` (toolCalls / per-step / tool-call content parts) + `evaluateN8nMcpEngineerDelegationContract(text, calledTools)`: gdy MCP włączony a zero realnych wywołań n8n MCP → `n8n_mcp_handoff_no_real_tool_use` (delegacja `success:false`). Log `n8nMcpToolsCalled` dla obserwowalności. Gdy MCP wyłączony — stary text-based fallback (engineer legit działa ze skills).

## WS-G — egzekucja fail-closed architekta (priorytet 2) — DONE (tsc 0)
- [x] G1: RUNTIME gate. Nowy `services/mcp-handoff-state.ts` — flaga run-scoped (klucz z ALS `getHarnessExecutionContext` runId/taskId/threadId, wspólny dla delegacji i Golden Path w jednym biegu; envelope tylko czyta context, nie tworzy nowego). `delegate-task`: porażka MCP handoff → `markMcpHandoffFailed()`, sukces → `clearMcpHandoffFailed()`. `automation-golden-path` (po coverage, przed runtime/deploy): `isMcpHandoffFailed()` → `blocked` z `failureClass: mcp_handoff_failed` + recovery `rerun_successful_mcp_handoff`. Flaga `FEATURE_MCP_HANDOFF_GATE` (default on). Architekt odzyskuje przez udaną re-delegację (czyści flagę) albo raportuje blocked. E1 czyni re-delegację niezawodną.
- [ ] G2 (opcjonalnie): early-stop „stuck build" (reflector unrecoverable na powtarzanych porażkach execute/deploy), by nie churnować do timeoutu.

## WS-H (opcjonalnie) — bezpieczeństwo typeVersion
- [ ] Walidacja typeVersion node'ów przed deploy (flaga na nieaktualne jak googleSheets v2), najlepiej przez MCP `validate_workflow` gdy dostępny.

## Kolejność
WS-E + WS-F najpierw (root cause + strażnik, który to maskował). Potem WS-G. WS-H opcjonalnie. WS-A..D (lifecycle) — DONE, WS-A potwierdzone live (cichy abort, brak zombie).

---

# Test #4 (clean catering) findings + WS-C-hard + WS-J — analiza i plan (2026-06-23)

## Przebieg testu #4 (po usunięciu copy-source googleSheets)
- Setup OK: architekt próbował `n8n_get_workflow A3hYGmcYOYPMS7Ku` (stary catering) → **404** (usunięty) → build od zera. (Potwierdza: architekt kopiuje istniejące workflowy — usunięcie było konieczne.)
- Workflow POPRAWNY: `Catering Lead Form Handler v2` (`xgnX3OOPcb2WvAKy`), inactive, **googleSheets v4** (poprawny, nie v2 jak w sfabrykowanym #2), **0 write_file**, **0 duplikatów** (25 execute → 1 wf, update in-place), osiągnął `tested`.
- ❌ **0 delegacji MCP** — architekt zgadł Sheets (v4 trafnie; w #2 v2 źle). E1/F1/WS-G nie wyzwolone.
- ❌ **25× execute_automation_request** po `tested`, churn; 4× reflector_intervention bez skutku. WS-A utnie przy 900s.

## ROOT CAUSE 1 — over-iteracja (WS-C prompt za słaby)
`strategy-reflector.ts` ma gotową konwergencję (§A, linie 882-898): gdy `deliverableSeen && reflectionsTriggered>=2 && totalToolCalls>=3 && errorRate<=threshold && !pipelineMode` → sygnał `converge` → harness `convergenceStop` HALTuje + wymusza no-tool synthesis (finalny raport, bez ryzyka pustego tekstu).
**W teście #4 spełnione były WSZYSTKIE warunki oprócz `deliverableSeen`.** Bo `deliverableSeen=true` ustawia się (linia 784) TYLKO dla `DELEGATION_TOOLS`. Sukces `architect_execute_automation_request` (status `tested`) NIE jest rozpoznawany jako deliverable → konwergencja nigdy nie odpala → 25× churn.

## ROOT CAUSE 2 — pomijanie MCP (gucze node configs)
Delegacja do MCP zależy od samooceny modelu (prompt: „deleguj gdy niepewny typeVersion/node"). Deepseek nadpewny → pomija (#3, #4: 0 delegacji) → zgaduje typeVersion (loteria: v4 ok w #4, v2 źle w #2). E1/F1/WS-G odpalają tylko przy delegacji → przy 0 delegacji są martwe. **Potrzeba deterministycznego wymuszenia walidacji, niezależnego od decyzji modelu.**

## FIX WS-C-hard — konwergencja rozpoznaje terminal Golden Path (priorytet 1, ~5 linii)
- [ ] `strategy-reflector.ts` linia ~784: oprócz `DELEGATION_TOOLS` ustaw `deliverableSeen=true` także gdy `tr.toolName ∈ {architect_execute_automation_request, architect_deploy_automation}` i wynik to sukces terminalny (`status ∈ {tested, draft_created, active}`, nie blocked/failed). Helper `isAutomationTerminalDeliverable(toolName, result)`.
- Efekt: po pierwszym `tested` + churn (reflections>=2) konwergencja odpala → wymusza syntezę raportu → architekt KOŃCZY (zamiast 25× execute). Reużywa istniejącej, bezpiecznej maszynerii (synteza no-tool = niepusty raport).
- [ ] (opcjonalnie) Idempotency latch: run-scoped `markBuildComplete(result)` w `execute-request`; przy ponownym wywołaniu dla tego samego speca/workflow SHORT-CIRCUIT (zwróć cache + „STOP, already built", bez realnego Golden Path). Czyni te ~kilka wywołań przed konwergencją tanimi.

## FIX WS-J — deterministyczny node-validation gate w Golden Path (priorytet 1)
Gwarantuje poprawne node configs NIEZALEŻNIE od delegacji modelu. Reużywa dedykowanego `n8nMcpClient` (E1, ~0.6s/call).
- [ ] CORE_NODE_TYPES (z patternów + rejestr): webhook, code, respondToWebhook, httpRequest, scheduleTrigger, rssFeedRead(Trigger), if, errorTrigger, telegram(Trigger), gmail(Trigger), mongoDb, merge, html, formTrigger, splitInBatches, aggregate, set, noOp, manualTrigger. (NON-CORE = reszta, np. googleSheets, switch.)
- [ ] Krok `node_validation` w Golden Path (po compose/resolve, przed deploy): dla każdego NON-CORE node'a wywołaj `validate_node(type, typeVersion, params)` przez dedykowany klient. Błąd (zły typeVersion/params) → `blocked` z `failureClass: node_validation_failed` + treść validate_node (poprawny typeVersion + co naprawić). Architekt re-komponuje z poprawną informacją.
- [ ] Gdy MCP niedostępny → `warn` (nie blokuj; loguj). Flaga `FEATURE_NODE_VALIDATION_GATE` (default on), `NODE_VALIDATION_GATE_MODE=off|warn|block`.
- Engineer (n8nMcpEngineer) zostaje do DISCOVERY (search_nodes/templates); F1/WS-G chronią tę ścieżkę. WS-J to deterministyczna gwarancja.
- [ ] (alternatywa rozważona, ODRZUCONA jako mniej pewna) „force delegation" gate — wymaga, by architekt zdelegował; nadal zależy od modelu, że poprawnie użyje feedbacku. WS-J (Golden Path waliduje sam) jest pewniejszy.

## Sekwencja i ryzyka
- Kolejność: WS-C-hard (najpierw — taniej, kasuje churn, ~5 linii) → WS-J (node validation). Razem: architekt kończy szybko, a node'y są deterministycznie zwalidowane.
- Ryzyko WS-C-hard: konwergencja może uciąć legalny build, który PO `tested` musi jeszcze aktywować. Mitigacja: konwergencja odpala tylko przy CHURNIE (reflections>=2 + powtórzenia), nie na pierwszym `tested`; sekwencja tested→test→activate (różne kroki) jej nie wyzwala.
- Ryzyko WS-J: false-block dla node'a, który jest OK ale validate_node go nie zna. Mitigacja: `warn` mode na start; block tylko po potwierdzeniu na patternach; MCP-unavailable → warn.
- Ryzyko latencji WS-J: ~0.6s × liczba non-core nodes (zwykle 1-3) = ~2s. Akceptowalne.

## Acceptance
1. Build osiągający `tested` zwraca raport i KOŃCZY w ciągu ~kilku kroków od tested (nie 25× execute). Konwergencja widoczna w eventach (`reflector_convergence_stop`).
2. Workflow z googleSheets (lub innym non-core) NIE deployuje się ze złym typeVersion — albo zwalidowany (poprawny), albo `blocked: node_validation_failed`.
3. WS-C-hard reużywa konwergencji (brak nowego stopWhen, brak ryzyka pustego raportu).
4. tsc 0; smoke `check:automation-delegation-lifecycle` rozszerzony o: (a) brak churnu po tested, (b) block na stale typeVersion.

## STATUS WS-C-hard + WS-J — DONE (2026-06-23, tsc 0)
- [x] WS-C-hard: `strategy-reflector.ts` — helper `isAutomationTerminalDeliverable(toolName, result)` (execute/deploy → status tested/draft_created/active, tolerant na envelope/compaction). Wpięty w OBA miejsca `deliverableSeen`: evaluate (sygnał `converge`) i `shouldConvergeStop` (halt). Reużywa istniejącej konwergencji (no-tool synthesis = niepusty raport). Zero nowego stopWhen.
- [x] WS-J: zbudowany jako **force-delegation** (nie direct-validate_node-from-Golden-Path — schemat n8n-mcp owinięty przez Mastrę `~standard`, niewprowadzalny z zewnątrz; engineer ZNA interfejs, więc on waliduje). `mcp-handoff-state.ts`: latch sukcesu (`markMcpHandoffSucceeded`/`hasSuccessfulMcpHandoff`). `delegate-task.ts`: oznacza sukces handoffu. `automation-golden-path.ts`: `CORE_NODE_TYPES` + `nonCoreNodeTypes()` + bramka `node_validation` przed deploy — non-core node (np. googleSheets) + brak udanego handoffu → `blocked: node_validation_required`. Flaga `NODE_VALIDATION_GATE_MODE=off|warn|block` (default block). Prompt base.md: reakcja na `node_validation_required` + `mcp_handoff_failed`.
- Efekt łączny: architekt KOŃCZY po `tested` (konwergencja), a non-core node'y WYMUSZAJĄ delegację do MCP → E1/F1/WS-G wreszcie odpalają, engineer realnie waliduje (validate_node), zamiast zgadywania typeVersion.
- [ ] TODO: smoke `check:automation-delegation-lifecycle` (brak churnu po tested + block na non-core bez handoffu). Live verify.

## WS-C-hard — SKORYGOWANA diagnoza + robust fix (2026-06-24, tsc 0)
Live test #5 ujawnił, że pierwsza wersja WS-C-hard NIE zadziałała (architekt wisiał po `tested`, convergence_stop=0). Głębsza analiza:
- `errorRateThreshold = 0.5` (DEFAULT_CONFIG), a errorRate runu ~0.1-0.27 → **errorRate NIE był blokerem**. Moja korekta errorRate (isResolvableGateBlock) celowała w nie-problem (zostawiona jako defensywa — gate-blocki i tak nie powinny liczyć się do errorRate).
- Reflektor jest **per-run** (`getReflector({runId})` cache) → `reflectionsTriggered` accumuluje (7≥2 OK) → lifecycle NIE bloker.
- **Prawdziwy bloker: `deliverableSeen=false`** — parsing `tested` ze steps (`isAutomationTerminalDeliverable`) zawiódł live (toolName/status w znormalizowanym/skompaktowanym wyniku nieosiągalny).
- **PROPER FIX: deterministyczny run-scoped latch.** `mcp-handoff-state.ts`: `markAutomationDeliverable()`/`hasAutomationDeliverable()` (ALS run key). `automation-golden-path.ts:buildResult` ustawia latch gdy status ∈ {tested,draft_created,active} + workflowId. `strategy-reflector.ts`: `deliverableSeen ||= hasAutomationDeliverable()` w OBU metodach (evaluate + shouldConvergeStop). Niezależne od parsowania — Golden Path WIE, że wyprodukował deliverable. Parsing (`isAutomationTerminalDeliverable`) zostaje jako wtórny sygnał.
- Test #5 potwierdził za to: **WS-J ✅ (block→wymusił MCP), E1/F1 ✅ (engineer realnie wołał validate_node+get_node), googleSheets v4 zwalidowany ✅, WS-A ✅ (uciął wiszący run bez zombie)**. Brakowało tylko czystego finalize → ten latch.
- [ ] Live verify #6: pełny przebieg z czystym zakończeniem (convergence po zwalidowanym tested).

---

# finalize-on-deliverable — IMPLEMENTED (2026-06-24, tsc 0). Plan: `ideas/finalize-on-deliverable-plan.md`

## Skorygowany root cause (głębszy niż konwergencja)
Wiszenie po `tested` NIE jest problemem konwergencji — to objaw. **Prawdziwy silnik: natywny scorer
`isTaskComplete` (`createGoalCompletionScorer`) strukturalnie NIGDY nie przechodzi dla delegacji
automation.** Kontrakt delegacji to LLM/static-plan (`createDelegationGoalContract`), więc nie jest
„generycznym" kontraktem harnessu → `maybeAutoFinalizeGenericHarnessContract` (warunek
`isGenericHarnessContract`) się nie odpala; a `evaluateCompletion` nigdy nie daje `score>=0.7`, bo kroki
planu nie są domykane W TRAKCIE runu (`recordHarnessFinalGoalEvidence` domyka je dopiero PO powrocie
`agent.generate`, czego przy wiszeniu nie ma). Scorer zwraca 0 → Mastra w kółko wstrzykuje feedback
„not complete" → wiszenie do WS-A. Konwergencja była tylko OBEJŚCIEM tego scorera, bramkowanym
`reflectionsTriggered` (>=2 / budget=5), które w czystym runie (0 interwencji) nie odpala. **Wszystkie
poprzednie próby celowały w obejście; ta naprawia właściwy mechanizm.**

## Fix — 3 dźwignie na deterministycznym latchu (status), niezależne od reflektora; flaga `FEATURE_AUTOMATION_FINALIZE_ON_DELIVERABLE` (default ON)
- [x] **Latch z statusem** — `mcp-handoff-state.ts`: `deliveredRuns` trzyma `{status,at}`;
  `markAutomationDeliverable(status)`, nowy `getAutomationDeliverableStatus()`, `hasAutomationDeliverable()`
  bez zmian. Helpery: `looksLikeAutomationReport` (lustro `isAutomationArchitectContractComplete` — status+IDs),
  `briefRequiresActivation`, `shouldForceAutomationReport` (active→tak; tested→tak o ile brief nie chce
  aktywacji; draft_created→nie), `automationFinalizeEnabled`. `golden-path:buildResult` →
  `markAutomationDeliverable(input.status)`.
- [x] **Lever 1 — deliverable-aware completion scorer** (`goal-completion-scorer.ts`):
  `maybeAutoFinalizeAutomationContract` — gdy latch + `looksLikeAutomationReport(output)` →
  `completeGoalContract` + zwróć 1 (finalizacja natywną drogą isTaskComplete). BEZ wymogu zero
  evidenceAgainst (terminal superseduje rozwiązane gate-blocki). Naprawia czysty hang #6.
- [x] **Lever 2 — prepareStep force-report** (`generate-with-harness.ts`, przed reflektorem): gdy
  `shouldForceAutomationReport(status, ctx.originalPrompt)` → `toolChoice:'none'` +
  `AUTOMATION_REPORT_NOW_INSTRUCTION`. Kasuje churn #4, wymusza poprawny raport. Event
  `automation_finalize_forced`.
- [x] **Lever 3 — stopWhen backstop** (`generate-with-harness.ts`, dodany do stopWhen array): kończy pętlę
  gdy latch∈{tested,active} I `looksLikeAutomationReport(lastStepText)` — niezależnie od tego, czy
  isTaskComplete steruje pętlą. Zero ryzyka pustego tekstu (kończy tylko gdy raport JUŻ jest). Event
  `automation_finalize_stop`. `lastReflectorStepText` helper.
- [x] base.md: gdy brief wymaga aktywacji → execute z `activate:true` atomowo (wspiera guard Lever 2).
- [x] flaga w `config/harness-flags.ts` + `.env.example`.

## TODO — live verify #7 (wymaga restartu Mastry przez usera)
Sekwencja: usuń catering wf z n8n (API DELETE) → restart Mastry → prompt cateringowy do meta. Asercje:
`status=tested` (googleSheets **v4**) + **brak execute/deploy/test PO tested** + **goal_contract architekta →
`completed`** ~kilkanaście s po tested (NIE active do 900s) + event `automation_finalize_stop`/`forced` LUB
`goal_completion_evaluated passed:true` + delegacja `success:true`. `reflector_intervention=0` jest OK.
**WATCH-ITEM:** potwierdzić, że post-passy (auto-review/approval, krytyczna głębia) NIE wycinają
automationId/workflowId z finalnego raportu (wcześniej nie odpalały się przez wiszenie).
