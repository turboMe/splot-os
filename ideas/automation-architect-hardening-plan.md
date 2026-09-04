# PLAN DLA DEVA — utwardzenie Automation Architect po live verify #7

Data: 2026-06-25. Branch: `fix/automation-delegation-lifecycle`. Status: **CZĘŚĆ A WDROŻONA I ZWERYFIKOWANA LOKALNIE**.
Powiązane: `ideas/finalize-on-deliverable-plan.md` (DONE, zweryfikowane live), `ideas/automation-delegation-lifecycle-fix.md`.

---

## 0. Kontekst — co pokazał live verify #7 (2026-06-24/25)

**finalize-on-deliverable DZIAŁA i jest zweryfikowany live** (run #7, 16:44–17:00):
`execute → status=tested 16:59:26 → automation_finalize_forced (Lever 2, step 28) → output_score success (Lever 1 scorer przeszedł) 16:59:45 → contract completed 17:00:39`. Zero post-tested churn. **Nie ruszamy finalize — działa.**

ALE test odsłonił 4 problemy UPSTREAM (osobne od finalize), które utrudniają/opóźniają dotarcie do `tested`:
1. **P1 — architekt komponuje ZABRONIONE node'y i churnuje** (5× execute failed na `executeCommand/writeBinaryFile/readBinaryFiles`, brak recovery).
2. **P2a — `scope_creep` fałszywy pozytyw** na dużym (legalnym) workflow JSON (6× w run #7).
3. **P2b — wolna droga do pierwszego `tested`** (~890s z 900s budżetu — finalize ledwo zdążył): manualne kroki zamiast one-shot execute + planner timeout 45s + latencja deepseek.
4. **P3 (drobny) — monitor odczytywał błędne pole `workflowId`** mimo że dokument poprawnie przechowuje kanoniczne `n8nWorkflowId`.

**POZA ZAKRESEM (świadomie odłożone przez właściciela):** wyrzucenie `mastra_workspace_execute_command` z toolsetu architekta (16× policy_blocked w run #7). „To nie jest takie proste" — osobny temat. FIX 1 (recovery na forbidden) i tak zmniejszy desperację, która prowadzi do prób shella.

---

## FIX 1 (P1, priorytet 1) — Forbidden nodes: blokuj WCZEŚNIE z poprawnym recovery (nie „deleguj do MCP")

### Problem + dowód
Run #7 (nocne runy 02:40+): 5× `architect_execute_automation_request` failed z:
`Deploy blocked: workflow uses node types outside the validated set (writeBinaryFile, executeCommand, readBinaryFiles) and no n8n MCP validation happened this run. Delegate to n8nMcpEngineer...`
→ architekt albo deleguje do MCP (bezsensownie — MCP nie zalegalizuje executeCommand), albo retryuje bez zmiany, albo próbuje shella (16× policy_blocked).

### Root cause (kod)
Pipeline `executeAutomationRequest` (Golden Path) idzie: resolve → coverage → mcp-gate → **node_validation gate** → runtime → normalize → **validate**.
- Bramka node_validation ([automation-golden-path.ts:276-317](src/mastra/services/automation-golden-path.ts#L276)) liczy `nonCoreNodeTypes()` = każdy node spoza `CORE_NODE_TYPES` ([:36-42](src/mastra/services/automation-golden-path.ts#L36)). Forbidden node'y (`executeCommand` itd.) NIE są w CORE → trafiają jako „non-core" → `blocked` z `failureClass: node_validation_required` + komunikat „deleguj do MCP" ([:298-302](src/mastra/services/automation-golden-path.ts#L298)).
- Prawdziwy check `FORBIDDEN_NODE_TYPES` ([node-registry.ts:59-67](src/mastra/tools/architect/validation/node-registry.ts#L59)) jest w `workflow-validator.ts:506` — czyli DALEJ w pipeline (po node-gate). Node-gate blokuje PIERWSZY → forbidden check nigdy nie odpala w ścieżce execute.

### Zmiana
**(a) Nowa bramka forbidden-nodes PRZED bramką node_validation** (najlepiej zaraz po zresolvowaniu workflow JSON, przed coverage), w `automation-golden-path.ts`:
- Import `FORBIDDEN_NODE_TYPES` z `../tools/architect/validation/node-registry.js`.
- Helper `forbiddenNodeTypes(workflow): string[]` (analogicznie do `nonCoreNodeTypes`, dopasowanie po pełnym `n8n-nodes-base.*`).
- Jeśli `forbidden.length > 0` → `return finalize(buildResult({ success:false, status:'blocked', failureClass:'forbidden_nodes', ... }))` z komunikatem:
  > „Workflow uses FORBIDDEN nodes (X). These are prohibited by policy and CANNOT be deployed or validated via MCP. REPLACE them: external API/command → httpRequest (or Code node); file read/write → Code node + MongoDB/Google Sheets; ssh → HTTP API. Recompose WITHOUT these nodes and rerun. Do NOT delegate to n8nMcpEngineer and do NOT retry unchanged."
- `recoveryStrategies`: `{ name:'replace_forbidden_nodes', outcome:'blocked', reason:'Remove/replace forbidden nodes with allowed equivalents; MCP cannot help here.' }`.
- Flaga `FORBIDDEN_NODE_GATE_MODE=off|warn|block` (default `block`), wzorem `getNodeValidationGateMode()`.

**(b) `nonCoreNodeTypes()` — wyklucz forbidden** (defensywa, by przy `FORBIDDEN_NODE_GATE_MODE!=block` forbidden nie udawały „non-core → MCP"):
filtruj `short` należące do (forbidden short-names) zanim trafią do `found`.

**(c) `prompts/automation/base.md`** — sekcja recovery na `failureClass: "forbidden_nodes"`:
> „When Golden Path returns `failureClass: "forbidden_nodes"`, the workflow uses prohibited nodes (executeCommand, read/writeBinaryFile, readWriteFile, ssh). Do NOT delegate to MCP, do NOT retry unchanged, do NOT use shell. REPLACE: external fetch → httpRequest; local command → not allowed (use httpRequest to an API); file read/write → Code node + MongoDB/Google Sheets. Recompose and rerun once."
Dodatkowo wzmocnić Hard Prohibitions mapą intencji → dozwolone node'y.

**(d) `strategy-reflector.ts` — NIE dodawać `forbidden_nodes` do `RESOLVABLE_GATE_FAILURES`** ([:420-422](src/mastra/services/strategy-reflector.ts#L420)). Ma liczyć się do error-rate, żeby powtarzane forbidden-kompozycje tripowały reflektor (tool_loop/error → szybsze zatrzymanie churnu). (Brak zmiany kodu — tylko świadomie pominąć.)

**(e) (do potwierdzenia)** `workflow-validator.ts:506` — upewnić się, że forbidden node daje severity ERROR (nie warning), żeby `architect_validate_workflow` też je łapał przed execute.

### Acceptance
- Workflow z `executeCommand` → Golden Path zwraca w JEDNYM strzale `blocked` + `forbidden_nodes` + komunikat „replace". Architekt rekomponuje bez forbidden (bez delegacji do MCP, bez retry-unchanged). Brak 5× execute-failed i 16× shell.
- Reflektor liczy powtórzony forbidden jako error (nie neutralny gate).

### Ryzyko
Minimalne — dokłada wcześniejszą, bardziej trafną blokadę. `block` to default polityki (i tak nie wolno deployować forbidden). `warn` jako wentyl bezpieczeństwa.

---

## FIX 2 (P2a, priorytet 2) — `scope_creep` fałszywy pozytyw na dużym workflow JSON

### Problem + dowód
Run #7: `scope_creep ×6`. Próg = `originalPromptChars(6005) × scopeCreepMultiplier(3) = 18015`, a `totalToolArgChars = 21890` (legalny 16-node workflow JSON przekazywany wielokrotnie do compose/validate/deploy). Reflektor co chwilę wstrzykuje „zawęź zakres / przeplanuj" → szum + marnowanie budżetu reflektora na poprawnym buildzie.

### Root cause (kod)
`strategy-reflector.ts` `evaluateHistory` blok scope_creep ([:1013-1020](src/mastra/services/strategy-reflector.ts#L1013)): `totalToolArgChars > originalPromptChars * scopeCreepMultiplier`. Architekt z definicji emituje duży JSON → sygnał jest dla niego strukturalnie nietrafny (jak dla pipeline agentów, gdzie scope_creep jest już wyłączony via `pipelineMode`).

### Zmiana (rekomendacja: suppress dla architekta)
- W `evaluateHistory` evalContext dodać flagę `suppressScopeCreep?: boolean`; blok scope_creep pomijać gdy `true`.
- W harnessie (`generate-with-harness.ts`, budowa evalContext do `reflector.evaluateHistory`) ustawić `suppressScopeCreep: input.agentId === AUTOMATION_ARCHITECT_AGENT_ID` (import z `config/agent-ids.js`).
- Ta sama polityka musi obowiązywać w legacy `analyzeStep`, żeby wyłączenie `FEATURE_REFLECTOR_PREPARE_STEP` nie przywróciło regresji.
- Alternatywa (bardziej chirurgiczna, opcjonalna): wykluczyć argi tooli niosących workflow JSON (`architect_compose_workflow`, `architect_validate_workflow`, `architect_deploy_automation`, `architect_execute_automation_request`) z `totalToolArgChars`. Precyzyjniejsze, ale więcej kodu. Rekomendacja: suppress (prościej, scope_creep i tak nie wnosi wartości dla tego agenta).

### Acceptance
Runy automation: 0 interwencji `scope_creep` mimo dużego JSON. Budżet reflektora idzie tylko na realne anomalie (tool_loop/error/forbidden).

### Ryzyko
Znikome — scope_creep to soft „narrow scope", bez wartości dla deterministycznego buildera dużych JSON-ów. Inne sygnały (tool_loop/high_error_rate/forbidden via error-rate) zostają.

---

## FIX 3 (P2b, priorytet 2) — skrócić drogę do `tested` + dać finalize zapas czasu

### Problem + dowód
Run #7 osiągnął `tested` przy ~890s z 900s budżetu — finalize zmieścił się o włos. Gdyby compose był ~10s wolniejszy, WS-A uciąłby PRZED finalize. Przyczyny: (i) manualne kroki Golden Path zamiast one-shot execute; (ii) planner LLM timeout 45s ([plan-task.ts:56](src/mastra/tools/system/plan-task.ts#L56)) opóźnia utworzenie kontraktu; (iii) latencja deepseek.

### Zmiany (niezależne — można wdrażać osobno)
**(a) `prompts/automation/base.md` — wymusić one-shot execute jako PIERWSZĄ akcję buildu.** `architect_execute_automation_request` robi compose+validate+risk+deploy+test+repair wewnętrznie. Sekcja „Golden Path" już to preferuje (linia 14), ale architekt w run #7 robił kroki manualnie. Wzmocnić: „For ANY build/deploy/test request, your FIRST tool call MUST be `architect_execute_automation_request`. Use manual single-gate tools ONLY if it returns an input-shape error you cannot satisfy." Mniej kroków = mniej latencji = mniej ekspozycji na reflektor.

**(b) `tools/system/plan-task.ts` — szybszy fallback planu.** Obniżyć `DEFAULT_PLAN_TIMEOUT_MS` 45_000 → 25_000 (env `PLAN_TASK_TIMEOUT_MS` jeśli istnieje przez `getPlanTimeoutMs()`), LUB pomijać LLM-plan dla delegacji do `automationArchitect` (architekt i tak prowadzi własny plan Golden Path; `createDelegationGoalContract` może iść od razu static-plan dla tego targetu). Rekomendacja: pominąć LLM-plan dla automationArchitect (zero wartości, -45s w złym przypadku).

**(c) Siatka bezpieczeństwa: podnieść `DELEGATION_AUTOMATION_TIMEOUT_MS` 900000 → 1200000.** Build udał się przy ~890s; bufor chroni przed zagłodzeniem finalize przy wolnym modelu. Zmienić default w kodzie oraz `.env`/`.env.example`, żeby brak env nie cofał budżetu do 900s.

### Acceptance
Czas do `tested` wyraźnie krótszy (mniej kroków); finalize z komfortowym zapasem; wolny planner nie dokłada 45s.

### Ryzyko
(a) prompt — niskie (egzekwuje istniejącą preferencję). (b) pominięcie planu — niskie (architekt ma własny Golden Path). (c) timeout — żadne (tylko większy bufor).

---

## FIX 4 (P3, priorytet 3, drobny) — kanoniczne `automation_requests.n8nWorkflowId`

### Problem + dowód
Dokument tested z run #7 miał poprawne `n8nWorkflowId`, ale monitor raportował `wf=-`, ponieważ czytał nieistniejące pole `workflowId`. (Finalize zadziałał — problem dotyczył raportu/telemetrii.)

### Namiar (kod)
`automation-golden-path.ts` zapisuje i odczytuje `n8nWorkflowId`; indeks Mongo oraz wszystkie runtime consumers również używają tej nazwy. Nie dodawać zduplikowanego pola `workflowId`. Naprawić monitor/query boundary na `n8nWorkflowId` (opcjonalnie `workflowId ?? n8nWorkflowId` tylko przy odczycie legacy) i dodać regresję po deploy/tested.

### Acceptance
Dokument `automation_requests` ma `n8nWorkflowId` zgodne z `AutomationGoldenPathResult.workflowId` po deploy/tested.

---

## Kolejność, flagi, ryzyko zbiorcze
1. **FIX 1** (forbidden gate) — kasuje najgorszy churn, czysty bug. Flaga `FORBIDDEN_NODE_GATE_MODE` (default block).
2. **FIX 3c** (env timeout) — natychmiastowa 1-liniowa siatka.
3. **FIX 2** (scope_creep suppress) — mały, kasuje szum.
4. **FIX 3a/3b** (one-shot prompt + planner) — skraca czas do tested.
5. **FIX 4** (workflowId) — drobny, na koniec.

Wszystkie zmiany addytywne, automation-scoped, za flagami gdzie zmieniają runtime. Nie ruszamy finalize (działa), konwergencji reflektora (backstop innych agentów), Golden Path quality.

## Test plan (live, constraints jak w handoffie §8)
1. `tsc --noEmit` = 0.
2. Usuń catering v2 `rUUNFkIooKkIDkSG` + każdy nowy catering przed testem (API DELETE).
3. Restart Mastry → 2 prompty do meta:
   - (A) standardowy catering (handoff §8) → asercja: `tested` + finalize (jak #7), **0 scope_creep**, krótszy czas do tested, brak forbidden.
   - (B) prompt prowokujący forbidden (np. „użyj polecenia systemowego / zapisz plik na dysku") → asercja: `forbidden_nodes` block w jednym strzale + rekompozycja bez forbidden, **bez delegacji MCP, bez retry-unchanged, bez 16× shell**.
4. Mongo: brak `node_validation_required` na forbidden; `reflector_intervention` bez scope_creep; `automation_requests.n8nWorkflowId` zgodne z wynikiem Golden Path.

## Rollback
`FORBIDDEN_NODE_GATE_MODE=warn|off`; scope_creep suppress za flagą/agentId; timeout/planner env-revert.

---

## Wynik implementacji części A — 2026-06-25

- Early forbidden gate zwraca `forbidden_nodes` przed coverage/MCP node gate i zapisuje recovery `replace_forbidden_nodes`.
- Forbidden node'y są wyłączone z `nonCoreNodeTypes`, więc nie mogą zostać błędnie skierowane do MCP.
- `scope_creep` jest wyłączony dla `automationArchitect` w `evaluateHistory` i legacy `analyzeStep`; inne agenty zachowują sygnał.
- Planner i replan LLM są pomijane wyłącznie dla `automationArchitect`; pozostałe agenty respektują `FEATURE_DELEGATION_LLM_PLAN`.
- Domyślny i lokalny timeout delegacji Automation Architecta wynosi 1 200 000 ms.
- Kanoniczne pole Mongo pozostaje `n8nWorkflowId`; dodano regresję zgodności z `AutomationGoldenPathResult.workflowId`.
- Zweryfikowane: TypeScript, Strategy Reflector, Pipeline Reflector, delegacja, MCP Engineer, autonomy, coverage, patterns oraz pełny Golden Path z testowym deployem i cleanupem.

---

# CZĘŚĆ B — szersze utwardzenie z audytu (`AUDYTKIERUNKIROZWOJUv2.md`)

Dopisane 2026-06-25 po weryfikacji audytu w kodzie. **Tu TYLKO punkty o niskim ryzyku i realnym sensie.**
Ryzykowne/niepewne świadomie pominięte — patrz „Pominięte" na końcu (z uzasadnieniem, żeby nie wracać do tego w kółko).

## FIX 5 (E) — Offline eval set + runner (niskie ryzyko: zero zmian w runtime/produkcji)

### Po co
Audyt słusznie: „najwyższy ROI = pomiar". Ale **mechanizm z audytu (podpiąć 6 scorerów live z samplingiem) jest dla TEGO kodu ryzykowny** (patrz „Pominięte"). Bezpieczny zysk to **eval offline**: te same scorery uruchamiane **na żądanie, na FINALNYCH outputach**, nie na produkcji. Wprost zabezpiecza nasze fixy P1–P4 przed regresją (uruchom przed/po zmianie).

### Stan (zweryfikowany w kodzie)
- Scorery istnieją i są zarejestrowane: `index.ts:1858` (8 szt.). Deterministyczne: `chefMenuQualityScorer`, `goal-completion`. LLM-judge na `google/gemini-2.5-pro`: meta/automation/deliberation/marketing/translation (model w `model-manifest.ts:53`, klucze obecne — działa, ale kosztuje).
- **Żywe podpięcie ma tylko `weather-agent.ts:24`.** `goal-completion` działa live jako bramka harnessu (`isTaskComplete`) — to inny mechanizm, zostaje.

### Zmiana
1. **Wersjonowany zbiór testowy** — 15–30 realnych zadań na kluczowy agent (automation, chef, meta), np. `eval/sets/<agent>.jsonl` (prompt + ewentualny oczekiwany kształt/notatka). Zaczynamy od automation (catering + 2–3 inne buildy) — żeby mierzyć efekt FIX 1–4.
2. **Runner offline** (`scripts/eval-run.ts`, `npm run check:eval -- <agent>`): dla każdego zadania bierze finalny output i przepuszcza przez **pasujący istniejący scorer** (deterministyczne za darmo; LLM-judge gemini tylko on-demand → koszt ograniczony i kontrolowany). Zapis wyników (score + reason) do pliku/kolekcji do porównania przebiegów.
3. **CONSTRAINT (ważne):** DuckDB single-writer — runner NIE może importować `index.js` jako osobny proces, gdy serwer trzyma lock. Musi iść **przez działający serwer :4111** (jak live testy) albo przy zatrzymanym serwerze. Udokumentować w skrypcie.

### Acceptance
`npm run check:eval -- automation` zwraca per-zadanie score na zbiorze held-out; uruchamiane przed/po FIX 1–4 pokazuje brak regresji (lub poprawę). Zero wpływu na produkcję.

### Ryzyko
Niskie — czysty pomiar offline, nic w runtime. Jedyny koszt: gemini przy LLM-judge (tylko gdy odpalasz eval, nie na produkcji).

## FIX 6 (G) — Domknięcie pętli uczenia, SELEKTYWNIE (niskie ryzyko: addytywne narzędzia)

### Stan (zweryfikowany)
- researcher/analytics/crm/marketing/sales — **brak** importów `memoryRecall/Write` (grep pusty). ✓ audyt.
- `skillReportTool` importują tylko: automation, coding, n8n-mcp, knowledge (te „4"). ✓ audyt.

### Zmiana (tylko tam, gdzie jest wartość)
1. **researcher-agent → pamięć.** Dodać `memoryRecallTool` (`../tools/system/memory-recall.js`) + `memoryWriteTool` (`../tools/system/memory-write.js`) do importów i bloku `tools`. Wzorzec 1:1 jak `coding-agent.ts:35-36,86-87`. Krótka nota w prompcie: „recall przed researchem, write po (czemu źródło słabe / co już sprawdzone)". Wartość: realna w domenie researchu.
2. **`skillReportTool` → agenci kreatywni używający skilli, którzy nie raportują** (content, writer, design, chef, hunt; ewentualnie marketing/film jeśli ładują skille). Import `skillReportTool` (`../tools/system/skill-report.js`) + do bloku `tools`. Domyka pętlę „które skille działają" (`successRate`/`totalUses` w `skill-registry.ts`).

### Acceptance
researcher zapisuje/odczytuje `system_knowledge`; kreatywni raportują wynik skilla → `successRate` zaczyna się wypełniać dla nich.

### Ryzyko
Niskie — to dodanie istniejących narzędzi do toolsetu. Jedyny watch: nad-wywoływanie → mitygacja notką w prompcie. Zgodne z [[feedback_memory_layers]] (warstwy wystarczają; NIE dokładamy semanticRecall).

---

## Świadomie POMINIĘTE (na razie) — ryzykowne/niepewne, z uzasadnieniem

- **Live-attach scorerów LLM-judge (meta/automation/deliberation/marketing) przez Mastra `scorers:`** — (a) koszt gemini-2.5-pro na każdym zsamplowanym przebiegu + nowa zależność chmurowa; (b) **harness woła `agent.generate()` do ~7× na zadanie** (main + repair/depth/deliberation/review/approval/goal-repair) → agent-level scorer odpaliłby się **per-pass**, nie per-zadanie → zaszumione oceny + zwielokrotniony koszt; (c) **niezweryfikowane**, czy agent-scorery w ogóle odpalają przez ścieżkę harnessu/zagnieżdżenie. → zastąpione eval offline (FIX 5).
- **Live-attach nawet deterministycznych scorerów** — ta sama niepewność per-pass/firing; do czasu weryfikacji trzymać w evalu offline.
- **Blanket pamięć dla analytics/crm/marketing/sales** — lekkie/szybkie z założenia; marginalna wartość + koszt tokenów; sprzeczne z zasadą warstw. Ewentualnie pojedynczo, jeśli któryś realnie cierpi.
- **Wyrzucenie `mastra_workspace_execute_command` z architekta** — odłożone przez właściciela (16× policy_blocked w run #7; „nie takie proste"). FIX 1 (recovery na forbidden) zmniejsza desperację prowadzącą do prób shella.
- **DSPy/GEPA/Ax, distylacja cloud→local, RL/Agent Lightning, pełne ślady prompt→odpowiedź** — duże/strategiczne osie z audytu; osobny roadmap, poza tym planem hardeningu. Warunek wstępny i tak = najpierw eval (FIX 5).
