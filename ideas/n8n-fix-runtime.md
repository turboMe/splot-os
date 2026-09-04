# Plan implementacji: stabilizacja n8n runtime i Automation Architect

## Cel

Naprawic sciezke budowania i wdrazania workflow n8n tak, aby `meta-agent` i `automationArchitect` nie gubily struktury gotowego JSON-a, nie powtarzaly tych samych nieudanych prob oraz nie oznaczaly niepolaczonego workflow jako poprawnie przetestowanego.

Plan bazuje na audycie prob z 2026-05-14, szczegolnie nieudanej delegacji `Tech News Aggregator Pro v2`.

## Diagnoza startowa

1. `architect_execute_automation_request` umie wykonac Golden Path, ale przy delegacji tekstowej pierwszy raz dostal `workflow` jako string zamiast obiektu:
   - blad: `workflow object is required for mode=workflow_json`.

2. Kolejne proby mialy juz workflow jako obiekt, ale `connections` uzywaly `node.id`, np. `scheduleTrigger_01`, `rssAggregator_01`, zamiast `node.name`, np. `Hourly Schedule Trigger`, `RSS Aggregator`.
   - walidator zwracal: `Connection references unknown source node`.
   - deterministic repair nie mial strategii na taki przypadek.

3. `strict` validation nie wymaga sensownego grafu wykonania. Workflow z wieloma node'ami i `connectionCount=0` moze przejsc jako `tested`, jezeli same node'y sa poprawne.

4. Telemetria uzywa dwoch identyfikatorow architekta:
   - Mastra agent id: `automation-architect`,
   - harness/pending/tool envelope id: `automationArchitect`.
   To utrudnia analize logow i pending updates.

5. `classifyToolError` klasyfikuje tekst `Workflow validation blocked deploy` jako `policy_blocked`, mimo ze policy miala `effectiveAllow=true`.

6. Async delegation trzyma tylko `outputPreview`, ktory jest przycinany do 1000 znakow przez harness. Przy dlugich wynikach traci sie szczegoly potrzebne meta-agentowi.

## Zakres implementacji

Wykonac zmiany w pieciu obszarach:

1. Normalizacja workflow JSON przed walidacja i deployem.
2. Twardsza walidacja grafu n8n.
3. Strukturalna sciezka meta-agent -> Automation Golden Path, bez przekazywania duzego JSON-a jako tekstu.
4. Spojna telemetria i klasyfikacja bledow.
5. Testy regresyjne i diagnostyka operacyjna.

## Faza 1: normalizacja `connections` id -> name

> Status: wykonane w pierwszym etapie implementacji.  
> Zakres: `normalizeConnectionKeys`, `architect_validate_workflow`, `architect_repair_workflow`, regresja w `check-automation-golden-path`.

### Pliki

- `src/mastra/tools/architect/validation/workflow-validator.ts`
- `src/mastra/tools/architect/testing/repair-workflow.ts`
- `src/mastra/services/automation-golden-path.ts`
- `src/mastra/scripts/check-automation-patterns.ts`
- nowy lub istniejacy test smoke w `src/mastra/scripts/check-automation-golden-path.ts`

### Kroki

1. [x] Rozszerzyc `normalizeConnectionKeys(workflowJson)` tak, aby budowala mapy:
   - `nodeNameByName`,
   - `nodeNameById`,
   - opcjonalnie `nodeNameBySlug`, np. camelCase/kebabCase/lowercase dla typowych pomylek LLM.

2. [x] Dla kazdego source key w `workflow.connections`:
   - jezeli key pasuje do `node.name`, zostawic bez zmian;
   - jezeli key pasuje do `node.id`, przeniesc connection pod `node.name`;
   - jezeli key po strip quotes/trim pasuje do `node.name`, przeniesc;
   - jezeli key po strip quotes/trim pasuje do `node.id`, przeniesc do `node.name`.

3. [x] Dla kazdego targeta `connections[*].main[*][*].node`:
   - jezeli target pasuje do `node.id`, zamienic na `node.name`;
   - jezeli target po strip quotes/trim pasuje do `node.id` albo `node.name`, zamienic na `node.name`.

4. [x] Zwracac czytelne warningi, np.:
   - `Connections: source "scheduleTrigger_01" matched node.id and was normalized to node.name "Hourly Schedule Trigger".`
   - `Connections from "RSS Aggregator": target "ollamaLlmClassifier_01" matched node.id and was normalized to "Ollama LLM Classifier".`

5. [x] Dodac fallback merge przy kolizji:
   - jezeli `connections[name]` juz istnieje i normalizowany `connections[id]` tez istnieje, polaczyc output groups ostroznie;
   - jezeli merge jest niejednoznaczny, dodac warning i zostawic blad walidacji, zamiast kasowac dane.

6. [x] Uzyc tej normalizacji w kazdym miejscu, ktore dotyka workflow przed walidacja:
   - `deployAutomationTool`,
   - `executeAutomationGoldenPath`,
   - `validateWorkflowTool` albo przynajmniej dac opcje `normalize: true`,
   - `repairWorkflowTool`.

### Acceptance criteria

- [x] Workflow, ktory ma node'y z `id` i `name`, ale `connections` po `id`, przechodzi normalizacje do `connections` po `name`.
- [x] Walidacja tego workflow nie zwraca `Connection references unknown source node` tylko dlatego, ze uzyto `id`.
- [x] Warningi mowia dokladnie, co zostalo zmienione.

### Weryfikacja etapu

- `npm run check:automation-golden-path` przeszedl.
- Nowa regresja w tym checku raportuje `connectionIdNormalization=passed`.

## Faza 2: walidacja grafu i reachability

> Status: wykonane w drugim etapie implementacji.  
> Zakres: analiza grafu workflow, metryki reachability, blokada orphan executable nodes w `strict`/`activation`, regresja w `check-automation-golden-path`.

### Pliki

- `src/mastra/tools/architect/validation/workflow-validator.ts`
- `src/mastra/tools/architect/validation/validation-types.ts`
- `src/mastra/tools/architect/testing/mock-data.ts`
- `src/mastra/tools/architect/testing/test-workflow.ts`

### Kroki

1. [x] Dodac do walidatora funkcje `analyzeWorkflowGraph(workflow)`:
   - indeksuje node'y po `name`;
   - buduje adjacency list z `connections`;
   - wykrywa trigger node'y;
   - liczy reachable nodes od triggerow;
   - wykrywa orphan nodes, isolated executable nodes i disconnected components.

2. [x] Dodac reguly dla profili:
   - `draft`: disconnected graph jako warning, chyba ze workflow ma wiecej niz 1 executable node i `connectionCount=0`, wtedy error;
   - `strict`: disconnected executable nodes jako error;
   - `activation`: brak triggera, brak sciezki od triggera do node'ow wykonawczych albo orphan send/write nodes jako error.

3. [x] Zdefiniowac helper `isExecutableNode(node)`:
   - ignorowac `stickyNote`, opcjonalnie `noOp`;
   - traktowac send/write/http/code/telegram/mongo/gmail/rss jako executable.

4. [x] Dla workflow z wieloma niezaleznymi triggerami dopuscic kilka komponentow, ale kazda komponenta z executable node musi zaczynac sie triggerem; jawny subworkflow przechodzi przez `executeWorkflowTrigger`.

5. [x] Rozszerzyc wynik walidacji o metryki:
   - `triggerCount`,
   - `reachableNodeCount`,
   - `orphanNodeCount`,
   - `disconnectedComponents`.

6. [x] Zweryfikowac `testWorkflowTool` w trybie `mock`: uzywa `validateWorkflow(..., 'strict')`, wiec po dodaniu strict graph validation nie moze zwrocic `passed/tested` dla niepolaczonego grafu.

### Acceptance criteria

- [x] Workflow z wieloma executable node'ami i `connectionCount=0` nie moze przejsc walidacji.
- [x] Workflow z jednym triggerem i liniowa sciezka trigger -> transform -> send przechodzi.
- [x] Workflow z niepolaczonym executable send/write node dostaje error w `strict` i `activation`.

### Weryfikacja etapu

- `npm run check:automation-golden-path` przeszedl.
- Nowa regresja w tym checku raportuje `graphValidation=passed`.
- `npm run check:automation-patterns` przeszedl: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.
- `npm run check:automation` przeszedl; runtime raportuje tylko niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- Cztery warningi sa oczekiwane dla draft-patternow bez klasycznego triggera; nie sa bledami strukturalnymi.
- `npm run build` przeszedl.

## Faza 3: naprawa deterministic repair dla bledow connection

> Status: wykonane w trzecim etapie implementacji.  
> Zakres: connection-aware repair, stopReason dla mapowania manualnego, recoveryStrategies z precyzyjna nazwa, regresja `connectionRepair=passed`.

### Pliki

- `src/mastra/tools/architect/testing/repair-workflow.ts`
- `src/mastra/services/automation-golden-path.ts`
- `src/mastra/services/automation-failure-learning.ts`

### Kroki

1. [x] Dodac strategię repair dla komunikatow:
   - `Connection references unknown source node`,
   - `Connection from "X" references unknown target`.

2. [x] Strategia ma wykonac:
   - normalize id -> name;
   - strip quotes/trim;
   - jezeli target/source nadal nieznany, probowac fuzzy match tylko przy wysokiej pewnosci, np. normalized lowercase exact bez spacji/podkreslen;
   - jezeli nadal nieznany, zwrocic `manual_connection_mapping_required` z lista brakujacych nazw.

3. [x] Po repair zawsze uruchomic `validateWorkflow(..., 'draft')` i `validateWorkflow(..., 'strict')`.

4. [x] Dodac do `recoveryStrategies` bardziej precyzyjna nazwe:
   - `connection_id_to_name_repair`,
   - `connection_graph_repair`,
   - `manual_connection_mapping_required`.

5. [x] Zmienic komunikat `No deterministic draft repair was possible`, aby zawieral klase powodu, np.:
   - `No deterministic draft repair was possible: unknown connection source did not match any node.id or node.name.`

### Acceptance criteria

- [x] Proby podobne do `Tech News Aggregator Pro v2` nie koncza sie identycznym retry bez klasy powodu.
- [x] Jezeli blad jest naprawialny przez mapowanie ID na name, deterministic repair naprawia workflow i walidacja strict przechodzi.
- [x] Jezeli blad nie jest naprawialny, wynik zawiera konkretna liste missing source/target oraz `manual_connection_mapping_required`.

### Weryfikacja etapu

- `npm run check:automation-golden-path` przeszedl.
- Nowa regresja w tym checku raportuje `connectionRepair=passed`.
- Regresja `$vars.*` raportuje `unsupportedVars=passed`: lokalny n8n CE nie ma `$vars`, a repair nie usuwa ich juz cicho.
- `npm run check:automation` przeszedl; runtime raportuje tylko niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `npm run build` przeszedl.

## Faza 4: strukturalny kontrakt meta-agent -> automation runtime

> Status: wykonane w czwartym etapie implementacji.  
> Zakres: `system_start_automation_request`, podlaczenie do meta-agenta, prompt rule, regresja w `check:automation-autonomy`.

### Pliki

- `src/mastra/agents/meta-agent.ts`
- `src/mastra/tools/system/delegate-task.ts`
- `src/mastra/tools/architect/automation-jobs.ts`
- `src/mastra/services/automation-job-manager.ts`
- opcjonalnie nowy tool: `src/mastra/tools/system/start-automation-request.ts`

### Problem

Meta-agent obecnie deleguje do `automationArchitect` tekstowo. Nawet jezeli ma gotowy JSON, to JSON przechodzi jako prompt. Przy duzych workflowach model moze:

- zamienic obiekt w string,
- zgubic `name`,
- zmienic `connections`,
- zaczac powtarzac proby zamiast wywolac narzedzie raz z poprawnym inputem.

### Kroki

1. [x] Dodac narzedzie dostepne dla meta-agenta, ktore przyjmuje strukturalny input Golden Path:

   ```ts
   {
     mode: 'pattern' | 'workflow_file' | 'workflow_json',
     request?: string,
     patternId?: string,
     spec?: unknown,
     workflow?: unknown,
     workflowFilePath?: string,
     workflowName?: string,
     activate?: boolean,
     returnToAgentId?: 'meta-agent' | 'automationArchitect',
     returnToThreadId?: string
   }
   ```

2. [x] Tool nie powinien prosic LLM-a architekta o ponowne wygenerowanie workflow. Ma bezposrednio wywolac:
   - `startAutomationJob` dla dlugich prac, albo
   - `executeAutomationGoldenPath` dla synchronicznych, krotkich prac.

3. [x] Nazwa toola moze byc:
   - `system_start_automation_request`, jezeli ma byc w meta tools,
   - albo `architect_start_automation_job` wladowane do meta-agent ToolSearchProcessor.

4. [x] W `meta-agent` prompt doprecyzowac:
   - jezeli masz gotowy JSON workflow, nie deleguj go tekstowo;
   - uzyj strukturalnego toola Golden Path;
   - jezeli uzywasz delegacji, przekaz krotki brief i kaz architektowi samemu uzyc `architect_execute_automation_request`, ale nie wklejaj duzego JSON-a w prose.

5. [x] Dodac ochrone rozmiaru:
   - jezeli workflow JSON ma wiecej niz np. 20 KB, zapisac go jako artifact/file w dozwolonym katalogu i przekazac `mode=workflow_file`;
   - nie wciskac duzego JSON-a w prompt.

6. [x] Rozwazyc `workflowFilePath` jako preferowana sciezke dla duzych gotowych workflow:
   - `ARCHITECT_WORKFLOW_ROOT`,
   - `/tmp`,
   - albo `ideas/generated-workflows` tylko jako draft, bez sekretow.

### Acceptance criteria

- [x] Meta-agent moze uruchomic Golden Path z gotowym JSON-em bez posredniego promptowania automationArchitect.
- [x] W `tool_executions` widac jedno wywolanie strukturalne `system_start_automation_request`; job zapisuje `automation_jobs`.
- [x] Dla duzego JSON-a input w logach jest redacted, a preferowana sciezka to `mode=workflow_file` z dozwolonego rootu.

### Weryfikacja etapu

- `npm run check:automation-autonomy` przeszedl; test uruchamia job przez `system_start_automation_request` i sprawdza `returnToAgentId=meta-agent`.
- `npm run check:automation-golden-path` przeszedl, w tym `unsupportedVars=passed`.
- `npm run check:automation` przeszedl; runtime raportuje tylko niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `npm run build` przeszedl.

## Faza 5: ujednolicenie identyfikatorow agenta

> Status: wykonane w piatym etapie implementacji.  
> Zakres: centralne stale agent ID, canonical runtime telemetry `automationArchitect`, aliasy dla historycznego `automation-architect` w pending/job queries, regresja w `check:automation-autonomy`.

### Pliki

- `src/mastra/agents/automation-architect.ts`
- `src/mastra/services/automation-harness.ts`
- `src/mastra/services/async-delegation.ts`
- `src/mastra/services/automation-job-manager.ts`
- `src/mastra/processors/pending-updates.ts`
- `src/mastra/tools/system/check-pending-updates.ts`
- `src/mastra/tools/system/delegate-task.ts`
- `src/mastra/prompts/meta/base.md`
- `src/mastra/prompts/automation/base.md`

### Decyzja techniczna

Najmniej ryzykowny wariant: zostawic registry key `automationArchitect`, ale uzywac jednego canonical runtime id w telemetrii. Rekomendacja:

- canonical agent id w harness/pending/tool telemetry: `automationArchitect`,
- Mastra `Agent.id` tez zmienic z `automation-architect` na `automationArchitect`, jezeli nie ma zaleznosci UI/API od starego id.

Wdrozone: zachowano publiczne Mastra `Agent.id = automation-architect`, bo lokalne API/Studio wystawia endpoint architekta pod tym ID. Nowe zapisy runtime/telemetry sa kanonikalizowane do `automationArchitect`, a odczyty krytyczne szukaja rowniez po aliasie historycznym.

Jesli zmiana `Agent.id` moze zepsuc istniejace watki, dodac kompatybilny alias w miejscach query:

```ts
const AUTOMATION_AGENT_ALIASES = ['automationArchitect', 'automation-architect'];
```

### Kroki

1. [x] Zdefiniowac stale:
   - `AUTOMATION_ARCHITECT_AGENT_ID = 'automationArchitect'`,
   - `META_AGENT_ID = 'meta-agent'`,
   - `CODING_AGENT_ID = 'codingAgent'`.

2. [x] Zastapic literalne stringi w nowych sciezkach.

3. [x] Query pending updates i dashboardow powinny przez okres przejsciowy szukac po aliasach.

4. [x] Sprawdzic, czy Mastra Studio pokazuje agenta po key czy po `id`.

### Acceptance criteria

- [x] Nowe `tool_executions`, `agent_events`, `automation_jobs`, `pending_user_messages` uzywaja tego samego ID.
- [x] `checkPendingUpdates({ agentId: 'automationArchitect' })` zwraca wyniki z jobow architekta.
- [x] Stare wpisy nie znikaja z dashboardu, jesli dashboard ma okres historyczny.

### Weryfikacja etapu

- `npm run build` przeszedl.
- `npm run check:automation-autonomy` przeszedl; regresja sprawdza odczyt legacy `automation-architect` przez canonical `automationArchitect` dla `pending_user_messages` i `automation_jobs`.
- `npm run check:automation-golden-path` przeszedl.
- `npm run check:automation-patterns` przeszedl: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.

## Faza 6: poprawna klasyfikacja bledow i statusow

> Status: wykonane w szostym etapie implementacji.  
> Zakres: kolejnosc klasyfikacji tool errors, nowe klasy failure, preservation `failureClass`, diagnostyczne kompaktowanie outputu, regresja `classification-workflow-validation`.

### Pliki

- `src/mastra/services/harness-tool-envelope.ts`
- `src/mastra/services/harness-policy.ts`
- `src/mastra/services/automation-output-compaction.ts`
- `src/mastra/services/automation-failure-learning.ts`

### Kroki

1. [x] W `classifyToolError` zmienic kolejnosc:
   - najpierw `validation|invalid|required|wymagan`,
   - potem `approval`,
   - potem policy,
   - ale policy tylko, jezeli output/error zawiera realny policy marker, np. `policy`, `allowlist`, `approval required`, a nie samo slowo `blocked`.

2. [x] Dla narzedzi Golden Path nie klasyfikowac `success:false` jako thrown policy, jezeli policyDecision ma `effectiveAllow=true`.

3. [x] Dodac osobna klase:
   - `workflow_validation`,
   - `runtime_preflight`,
   - `risk_blocked`,
   - `approval_required`,
   - `tool_input_contract`.

4. [x] W `recordAutomationGoldenPathFailure` zachowac `failureClass` zgodny z realna przyczyna.

5. [x] Kompaktowany output dla modelu powinien zawierac:
   - `status`,
   - `failureClass`,
   - `failedStep`,
   - top 5 errors,
   - `recoveryStrategies`,
   - `nextAction`.

### Acceptance criteria

- [x] `Workflow validation blocked deploy` jest klasyfikowane jako `workflow_validation`, nie `policy_blocked`.
- [x] Policy block pojawia sie tylko przy realnej decyzji policy/approval.
- [x] Dashboard i memory dostaja sensowne failure classes.

### Weryfikacja etapu

- `npx tsc --noEmit` przeszedl.
- `npm run build` przeszedl.
- `npm run check:automation-autonomy` przeszedl; regresja sprawdza `Workflow validation blocked deploy -> workflow_validation`, realny marker policy oraz `tool_input_contract`.
- `npm run check:automation-golden-path` przeszedl.
- `npm run check:automation-patterns` przeszedl: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.
- `npm run check:n8n-runtime` przeszedl; pozostaje niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- CLI UI/API przez `meta-agent -> system_start_automation_request` przeszedl dla `automationId=cli-meta-structured-validation-1778807463403`:
  - odpowiedz agenta: `FailureClass: workflow_validation`;
  - `automation_events.failure_case.data.failureClass = workflow_validation`;
  - `agent_events.task_failed.metadata.failureClass = workflow_validation`;
  - `tool_executions.errorClass = workflow_validation`;
  - kompaktowany output zawiera `"failureClass":"workflow_validation"`;
  - brak `policy_blocked`.
- CLI diagnostyczny test tekstowej delegacji `meta-agent -> system_delegate_task -> automationArchitect` dla `automationId=cli-meta-delegation-validation-1778807571602` nie wykonal realnego `architect_execute_automation_request`; potwierdza, ze dla gotowego `workflow_json` sciezka akceptacyjna to `system_start_automation_request`, nie delegacja prose.

## Faza 7: async delegation i pelne wyniki

> Status: wykonane w siodmym etapie implementacji.  
> Zakres: artifact dla dlugiego `llm_output`, pelny kontrakt wyniku async delegation, metadane artifactu w `checkPendingUpdates`.

### Pliki

- `src/mastra/services/generate-with-harness.ts`
- `src/mastra/services/async-delegation.ts`
- `src/mastra/services/harness-output-compactor.ts`
- `src/mastra/services/pending-message-queue.ts`

### Kroki

1. [x] `generateWithHarness` powinien zwracac `outputArtifactId`, jezeli output zostal skompaktowany.

2. [x] `extractOutputPreview` moze dalej zwracac 1000 znakow, ale result async delegation powinien zachowac:
   - `resultPreview`,
   - `resultArtifactId`,
   - `fullResultAvailable: true`.

3. [x] `startAsyncDelegation` przy queue pending message powinien dodawac link/ID artifactu, jezeli jest.

4. [x] `checkPendingUpdates` powinien zwracac artifact ID w `updates[].metadata`, zeby meta-agent mogl pobrac szczegoly, zamiast dzialac na uciętym streszczeniu.

5. [x] Dla automation jobs preferowac juz istniejacy job manager, bo on jest bardziej deterministyczny niz delegacja tekstowa.

### Acceptance criteria

- Async result dla dlugiego automation output nie konczy sie `...` bez mozliwosci doczytania.
- Meta-agent widzi terminal status i najwazniejsze pola nawet przy dlugim wyniku.

### Weryfikacja etapu

- `npx tsc --noEmit` przeszedl.
- `npm run check:automation-autonomy` przeszedl.
- `npm run build` przeszedl.
- Nowa regresja uruchamia realna delegacje async na dlugim wyniku i sprawdza:
  - `resultPreview` pozostaje skompaktowany,
  - `resultArtifactId` jest zapisany,
  - `fullResultAvailable = true`,
  - pending update zawiera `Full result artifact`,
  - `checkPendingUpdates` zachowuje `updates[].metadata.resultArtifactId`.

## Faza 8: testy regresyjne

> Status: wykonane w osmym etapie implementacji.  
> Zakres: formalne domkniecie regresji z faz 1-7, jawne nazwy testow w checkach, automatyczna kontrola `inactiveAfterDeploy`.

### Minimalny zestaw testow

1. [x] `npm run check:automation-patterns`
   - musi pozostac bez faila dla 38 executable patterns;
   - aktualny wynik: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.

2. [x] `npm run check:automation-golden-path`
   - unsafe workflow blokowany;
   - safe workflow deploy + mock test;
   - nowy workflow pozostaje inactive (`inactiveAfterDeploy=passed`).

3. [x] Nowy test: `connection-id-normalization`
   - input: workflow z node `id` i `name`, connections po `id`;
   - expected: normalizacja do `name`, validation valid.

4. [x] Nowy test: `disconnected-graph-blocked`
   - input: trigger + 3 executable node'y bez connections;
   - expected: strict validation invalid.

5. [x] Nowy test: `meta-structured-workflow-json`
   - bez LLM, bez promptu;
   - wywoluje nowy tool strukturalny lub `startAutomationJob` z workflow object;
   - expected: nie ma bledu `workflow object is required`.

6. [x] Nowy test: `classification-workflow-validation`
   - input: output `{ success:false, message:'Workflow validation blocked deploy.' }`;
   - expected: `workflow_validation`, nie `policy_blocked`.

7. [x] `npm run build`
   - musi przejsc po kazdej fazie.

### Dodatkowe testy manualne

1. Uruchomic lokalnie:
   - `npm run check:n8n-runtime`,
   - `npm run check:automation-autonomy`,
   - `npm run check:automation-patterns`,
   - `npm run check:automation-golden-path`,
   - `npm run build`.

2. [x] Sprawdzic, ze nowo tworzony workflow jest inactive.
   - przeniesione do automatycznego `check:automation-golden-path` jako `inactiveAfterDeploy=passed`.

3. W Mongo sprawdzic:
   - `automation_requests`,
   - `automation_events`,
   - `tool_executions`,
   - `automation_jobs`.

### Weryfikacja etapu

- `npx tsc --noEmit` przeszedl.
- `npm run check:n8n-runtime` przeszedl; pozostaje niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `npm run check:automation-patterns` przeszedl: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.
- `npm run check:automation-golden-path` przeszedl:
  - `connectionIdNormalization=passed`,
  - `graphValidation=passed`,
  - `connectionRepair=passed`,
  - `unsupportedVars=passed`,
  - `inactiveAfterDeploy=passed`.
- `npm run check:automation-autonomy` przeszedl:
  - `metaStructuredWorkflowJson=passed`,
  - `classificationWorkflowValidation=passed`,
  - `asyncFullResultArtifact=passed`.
- `npm run build` przeszedl.

## Faza 9: migracja i porzadki w istniejacych workflowach

> Status: zaimplementowane; audit read-only wykonany 2026-05-15.  
> Zakres: skrypt diagnostyczny, jawny tryb `--apply`, audit dwoch wskazanych workflowow bez automatycznej mutacji legacy danych.

### Kroki

1. [x] Nie modyfikowac automatycznie legacy workflowow bez wyraznej decyzji.

2. [x] Dla Mastra-managed workflowow z 2026-05-14:
   - `XjRwjBPesto0419e`,
   - `h3fvQ0xzuZcZz0Hs`,
   wykonac tylko read-only audit:
   - czy maja `connectionCount=0`,
   - czy status w `automation_requests` odpowiada realnemu stanowi,
   - czy `lastTest.status=passed` nie jest falszywie pozytywny.

3. [x] Jesli workflow jest oznaczony jako `tested`, ale graf jest disconnected:
   - ustawic status `manual_review_required`,
   - zapisac `automation_events` z typem `graph_validation_backfill`,
   - nie aktywowac.
   - wdrozone w skrypcie tylko po jawnym `--apply`.

4. [x] Stworzyc skrypt diagnostyczny, np.:
   - `src/mastra/scripts/audit-n8n-managed-workflows.ts`.

### Wynik audytu 2026-05-15

Uruchomiono:

```bash
npm run audit:n8n-managed-workflows
```

Wynik read-only:

- `XjRwjBPesto0419e`
  - `connections=3`,
  - `strictValid=true`,
  - `disconnectedGraph=false`,
  - status mismatch: `lastTest.status=passed but status=draft_created`,
  - brak kwalifikacji do automatycznego backfillu.
- `h3fvQ0xzuZcZz0Hs`
  - `connections=0`,
  - `strictValid=false`,
  - `orphanNodes=28`,
  - `disconnectedGraph=true`,
  - `lastTestLikelyFalsePositive=true`,
  - kwalifikuje sie do backfillu `manual_review_required`, ale nie zostal zmodyfikowany bez jawnej decyzji.

### Tryb backfillu

Skrypt domyslnie jest read-only. Jawny backfill:

```bash
npm run audit:n8n-managed-workflows -- --apply
```

Zmienia tylko rekordy:

- `managedBy=mastra`,
- `status=tested`,
- strict graph validation wykrywa disconnected graph.

W takim przypadku:

- ustawia `status=manual_review_required`,
- zapisuje `automation_events.type=graph_validation_backfill`,
- nie aktywuje workflowu.

### Weryfikacja etapu

- `npx tsc --noEmit` przeszedl.
- `npm run audit:n8n-managed-workflows` przeszedl w trybie read-only.
- `npm run build` przeszedl.

## Faza 10: utwardzenie po testach UI

> Status: wykonane 2026-05-15 po testach rozmow przez UI.  
> Zakres: kontrakty tool input, ownership update, trigger detection, activation validation, status po testach manualnych, nowe regresje.

### Znalezione problemy

1. `meta-agent` potrafil wywolac `system_start_automation_request` z `mode=workflow_json`, ale bez pola `workflow`; blad byl widoczny dopiero po utworzeniu background joba.
2. Aktualizacja istniejacego workflow przez Golden Path bez jawnego `automationId` mogla utworzyc drugi rekord ownership dla tego samego `n8nWorkflowId`.
3. `risk-scoring` mial osobna, niepelna liste triggerow i falszywie oznaczal `rssFeedReadTrigger` jako `NO_TRIGGER`.
4. Node bez obiektu `parameters` przechodzil lokalna walidacje i byl odrzucany dopiero przez API n8n.
5. `activation` profile przepuszczal workflow z samym `manualTrigger`, chociaz n8n nie potrafi go realnie aktywowac.
6. Manualna sciezka `architect_test_workflow` zapisywala `lastTest.status=passed`, ale zostawiala rekord w `draft_created`.

### Zmiany

1. [x] Dodano mode-specific walidacje wejscia dla:
   - `system_start_automation_request`,
   - `architect_start_automation_job`.
   `workflow_json` wymaga obiektu `workflow`, `workflow_file` wymaga `workflowFilePath`, a `pattern` wymaga `patternId` i `spec`.

2. [x] Przy update Golden Path i job manager reuse'uje istniejacy `automationId` wlasciciela workflowu zamiast generowac nowy rekord ownership.

3. [x] Manualny `architect_deploy_automation` przy update bez jawnego `automationId` rowniez reuse'uje istniejacego ownera.

4. [x] `risk-scoring` uzywa tej samej listy `TRIGGER_TYPES`, co walidator.

5. [x] Walidator blokuje node'y bez obiektu `parameters` przed deployem do n8n.

6. [x] `activation` profile wymaga co najmniej jednego triggera innego niz `manualTrigger`.

7. [x] `architect_test_workflow` po pozytywnym tescie podnosi status do `tested`, o ile workflow nie jest juz `active`.

8. [x] Telegram pozostaje bez approval. Test scenariusza approval powinien uzywac operacji realnie wysylajacej/zapisujacej poza Telegramem, np. Gmail, Slack, MongoDB albo `HTTP POST`.

### Weryfikacja etapu

- `npx tsc --noEmit` przeszedl.
- `npm run check:automation-autonomy` przeszedl:
  - `metaStructuredWorkflowJson=passed`,
  - `classificationWorkflowValidation=passed`,
  - `structuredInputContract=passed`,
  - `asyncFullResultArtifact=passed`.
- `npm run check:automation-golden-path` przeszedl:
  - `malformedParameters=passed`,
  - `triggerConsistency=passed`,
  - `activationTriggerValidation=passed`,
  - `ownerReuse=passed`.
- `npm run check:n8n-runtime` przeszedl; pozostaje niekrytyczny warning `N8N_CREDENTIAL_HTTP_ID not set`.
- `npm run check:automation-patterns` przeszedl: `34 passed`, `4 warnings`, `0 failed`, `5 skipped`.
- `npm run check:automation` przeszedl.
- `npm run build` przeszedl.

### Stan danych po testach UI

Po wdrozeniu poprawek kodowych zostal jeden historyczny rekord wymagajacy osobnej decyzji operacyjnej:

- workflow `jfwPNZfQ1dy0mbdW` ma dwa wpisy ownership:
  - `737970bc-7e8f-47d9-89b9-e5147e4c9d05`,
  - `fd9f9b79-c82f-498d-8326-61c0d3b45f93`.

Historyczny mismatch workflowu `U942CLaJDIYKJW8Y` (`Mastra - Hacker News AI Digest to Telegram`) zostal zrekoncyliowany przez `syncAutomationStatus`:

- przed sync: `lastTest.status=passed`, `status=draft_created`,
- po sync: `status=tested`, `statusMismatch=none`.

Nowy kod nie tworzy juz duplikatu ownershipu, a przy istniejącym duplikacie wybiera deterministycznie najstarszy rekord jako kanonicznego ownera. Nie usuwa jednak automatycznie historycznych rekordow ownership.

## Kolejnosc wdrazania

1. Faza 1: normalizacja id -> name.
2. Faza 2: walidacja grafu.
3. Faza 3: repair connection errors.
4. Faza 6: klasyfikacja bledow.
5. Faza 8: testy regresyjne dla powyzszych.
6. Faza 4: strukturalny tool dla meta-agenta.
7. Faza 7: async full result artifacts.
8. Faza 5: ujednolicenie agent ID, najlepiej po testach, bo dotyka wielu query i dashboardow.
9. Faza 9: backfill/audit istniejacych workflowow.
10. Faza 10: utwardzenie po testach UI.

## Definition of Done

Implementacja jest zakonczona, gdy:

1. `Tech News Aggregator Pro v2`-style workflow z `connections` po node `id` jest normalizowany albo blokowany z jasnym komunikatem.
2. Workflow bez polaczen nie moze przejsc jako `tested`, jezeli ma wiecej niz jeden executable node.
3. Meta-agent ma bezpieczna, strukturalna sciezke uruchomienia Golden Path z gotowym JSON-em.
4. Tool telemetry pokazuje prawdziwa klase bledu.
5. Async delegation nie gubi szczegolow wyniku.
6. Wszystkie checki przechodza:
   - `npm run check:n8n-runtime`,
   - `npm run check:automation-patterns`,
   - `npm run check:automation-golden-path`,
   - `npm run check:automation-autonomy`,
   - `npm run build`.

## Ryzyka

1. Normalizacja id -> name moze ukryc bledy w recznie pisanych workflowach. Dlatego kazda normalizacja musi byc raportowana jako warning.
2. Twardsza walidacja grafu moze zaczac blokowac obecne workflowy, ktore byly falszywie oznaczane jako poprawne. To jest celowe, ale wymaga backfill/audit.
3. Zmiana `Agent.id` moze naruszyc istniejace watki Mastra Memory. Jesli nie ma pewnosci, wdrozyc aliasy zamiast natychmiastowej zmiany ID.
4. Strukturalny tool meta-agenta musi redaktowac workflow JSON w logach, bo workflow moze zawierac credential refs lub payload examples.
5. Dlugie workflowy z Code node moga byc blokowane przez risk scoring. Nie obchodzic tego automatycznie; redesign albo approval.

## Notatki operacyjne dla deva

- Nie zaczynac od prompt engineering. Najpierw naprawic deterministyczne kontrakty i walidator.
- Nie uzywac raw `n8n_update_workflow` ani aktywacji poza guardrailami.
- Przy kazdym nowym failure case zapisac `automation_events` i `system_knowledge`, ale unikac spamowania identycznymi wpisami.
- Przy testach na lokalnym n8n czyscic utworzone drafty albo nadawac im jednoznaczny prefix testowy.
- Nie ruszac niezaleznych zmian w obszarze `knowledge-agent` / NotebookLM / pricing podczas tej implementacji.
