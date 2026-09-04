# Automation MCP Pattern Fix - pelny plan naprawy

Data planu: 2026-06-20

Status: plan implementacyjny, bez zmian runtime w tym pliku.

Cel: uszczelnic pipeline Automation Architect + n8n MCP Engineer tak, zeby lokalne patterny nie mogly przepchnac technicznie poprawnego, ale semantycznie niepelnego workflow. Szczegolnie chodzi o przypadek z testu: request wymagal webhooka, walidacji, zapisu do MongoDB i odpowiedzi HTTP, a Golden Path dopuscil inactive workflow zlozony tylko z Webhook Trigger, Code i Respond to Webhook.

## 0. Status implementacji

- [x] Etap 1 - capability coverage library i `check:automation-coverage`.
- [x] Etap 2 - metadane patternow i Pattern RAG coverage.
- [x] Etap 3 - Golden Path coverage gate.
- [x] Etap 4 - Composer coverage gate.
- [x] Etap 5 - prompty i kontrakt delegacji.
- [x] Etap 6 - smoke scripts.
- [x] Etap 7 - HTTP thread wrapper/test.
- [x] Etap 8 - dokumentacja i env.
- [x] Weryfikacja - `check:automation`, MCP/static checks, smoke coverage-block, memory-thread static check, build.
- [x] Etap 9 - post-live hardening: inbound POST vs outbound HTTP POST, negacje jako forbidden capabilities, puste Respond to Webhook body, n8n read-only payload sanitization, MCP handoff fail-closed.
- [x] Weryfikacja post-live - `check:automation`, `check:n8n-mcp-engineer`, `check:n8n-mcp-pipeline-smoke`, `check:agent-generate-memory-thread`, `check:automation-delegation-contract`, `npm run build`, `git diff --check`.

## 0.1. Post-live test findings i poprawki

Live test z 2026-06-21 wykazal, ze MVP dziala czesciowo, ale wymaga dodatkowego hardeningu:

- [x] `POST webhook` byl mylony z outbound `operation.http.post`. Poprawka: `operation.http.post` jest wymagane tylko dla outbound HTTP/API call, nie dla metody triggera webhook.
- [x] Frazy negujace typu `no Mongo`, `no Telegram`, `no HTTP Request node` byly interpretowane jako wymagania. Poprawka: negacje trafiaja do `coverage.forbidden` i blokuja tylko wtedy, gdy workflow/pattern faktycznie zawiera `forbiddenActual`.
- [x] Workflow z pustym `Respond to Webhook.responseBody` mogl przejsc draft validation i zwracac tylko `{ ok: true }`. Poprawka: validator blokuje `respondWith=json` z pustym body; uzywac np. `={{ $json }}`.
- [x] Workflow JSON skopiowany z n8n mogl zawierac top-level `versionId` i inne pola read-only. Poprawka: `N8nService` usuwa read-only envelope fields przed create/update, zostawiajac node ids.
- [x] Nieudany MCP handoff mogl byc potraktowany przez model jako miekkie ostrzezenie. Poprawka: `system_delegate_task` ma tool envelope logging i kontrakt `n8n_mcp_handoff`; prompt wymusza `blocked/mcp_handoff_failed` po `success:false`.
- [x] Live activation public webhook bez auth poprawnie wymaga approval. Pozostaje to celowym guardrailem; testy powinny uzywac jawnego approval path, nie omijac `architect_activate_automation`.

## 0.2. Live test log - 2026-06-21

Test command:

`npm run check:n8n-mcp-pipeline-smoke -- delegation-only`

Runtime:

- Mastra rebuilt with `npm run build`.
- `node .mastra/output/index.mjs` without env preload returned 500 from `/deploy/automation-architect/generate`, because model API keys from `.env` were not loaded.
- Retest used `node --import dotenv/config .mastra/output/index.mjs`.

Observed result:

- `automationArchitect` reached `system_delegate_task` and created delegation contract `goal-delegation-c23bb45c-3437-40a6-b7dd-c2e85b69ed7c-1a746b6a`.
- `n8nMcpEngineer` was invoked and the contract later completed successfully.
- `n8n-mcp` `validate_workflow` emitted an MCP schema error: structured `errors[].details` did not match the declared string schema.
- HTTP wrapper `/deploy/automation-architect/generate` returned 504 before the completed delegation result reached the smoke script.
- n8n workflow list had no new workflows after the test start, so the design-only test did not mutate n8n.
- Safe create/activate live test was not run, because the MCP handoff smoke is still the prerequisite gate.

Things to fix before next live activation test:

- [x] Add a supported runtime start path for built Mastra that loads `.env` via `dotenv/config` or an app-level env loader. Do not rely on shell `source .env`.
- [x] Normalize or wrap `n8n-mcp` `validate_workflow` results so object/array `errors[].details` cannot violate the MCP output schema.
- [x] Make `n8nMcpEngineer` recover explicitly when `validate_workflow` fails with schema mismatch: preserve `search_nodes` / `get_node` evidence and report the validation limitation instead of spending the whole wrapper budget.
- [ ] Adjust `/deploy/automation-architect/generate` live wrapper timeout/async handling for MCP handoff. Delegation took about 176.7s and completed after the HTTP request timed out.
- [ ] Add smoke evidence for "delegation completed after wrapper timeout" so this regression is visible without manual Mongo/log inspection.
- [ ] Re-run `delegation-only`; only if it passes, run the safe create/activate webhook test.

Second run after wrapper hardening:

- `n8nMcpEngineer` still called `validate_workflow` twice and the synchronous delegation took about 169.1s; HTTP wrapper still returned 504.
- Follow-up hardening: default `N8N_MCP_VALIDATE_WORKFLOW_MODE=advisory`, default `N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS=8`, and docs/env/start script updated.

Final live smoke after advisory mode:

- `npm run check:n8n-mcp-pipeline-smoke -- delegation-only` passed.

Safe create/activate live test:

- Added repeatable harness: `npm run check:automation-live-safe-webhook`.
- Direct harness cannot run while built Mastra runtime holds `mastra.duckdb`; stop runtime first or use the HTTP wrapper path.
- First successful create/activate path exposed another semantic issue: n8n Webhook payload is under `$json.body`, while the generated Code node read `email/message` from root `$json`.
- Fix: local Webhook builders normalize `body ?? root`, Automation Architect prompt documents the envelope, and `architect_validate_workflow` blocks direct Webhook -> Code root payload reads without body normalization.
- Regression coverage: `check:automation-golden-path` now includes `webhookPayloadEnvelope=passed`.
- Final passing workflow:
  - automationId: `2e6930d0-38b6-4378-a027-2cb84af35a43`
  - workflowId: `Pa1CnAXUmi8XqSo5`
  - name: `Mastra - Mastra Live Safe Echo 1782052368813`
  - path: `mastra-live-safe-echo-1782052368813`
  - active: `true`
  - webhook response included `ok`, `email`, `message`, `receivedAt`, and `workflowPath`.
- Failed active live-safe workflows from this run were deactivated: `9W6Kg7lcD1LwUUaO`, `vhqmJD7gu4HpOMG3`.

## 1. Zakres przejrzanego kodu

Przejrzany zakres obejmuje runtime Automation Architect, n8n MCP Engineer, Golden Path, Pattern RAG, buildery patternow, walidatory, ryzyko, deploy, test workflow, harnessy i obecne skrypty kontrolne.

Najwazniejsze punkty kodu:

- `src/mastra/agents/automation-architect.ts` - rejestracja narzedzi architekta, pamiec, prompt i procesory.
- `src/mastra/agents/n8n-mcp-engineer.ts` - osobny agent MCP z allowlista read-only.
- `src/mastra/mcp.ts` - konfiguracja n8n MCP, flaga `FEATURE_N8N_MCP` / `N8N_MCP_ENABLED`, domyslny tryb `readonly`.
- `src/mastra/services/automation-golden-path.ts:107` - glowna funkcja Golden Path.
- `src/mastra/services/automation-golden-path.ts:504` - `resolveWorkflowInput`, czyli miejsce, gdzie `mode: "pattern"` buduje workflow bez kontroli pokrycia semantycznego.
- `src/mastra/services/automation-golden-path.ts:603` - `inferRuntimeRequirements`, obecnie inferuje wymagania glownie z wygenerowanego workflow, przez co nie wykrywa wymagan pominietych przez pattern.
- `src/mastra/tools/architect/types.ts:80` - `AutomationPattern`, obecnie bez jawnych capability/coverage.
- `src/mastra/tools/architect/pattern-rag.ts:112` - `architect_match_pattern`, obecnie ranking oparty glownie o embedding/semantic score i metadane patternu.
- `src/mastra/tools/architect/pattern-catalog.ts:109` - `webhook-validate-respond`, pattern z testu, ktory nie ma Mongo.
- `src/mastra/tools/architect/pattern-catalog.ts:120` - `webhook-lead-to-agentforge-crm`, pattern bliski domenie leadow, ale tez nie jest generic Mongo insert.
- `src/mastra/tools/architect/builders/webhookValidateRespond.ts:4` - builder generuje Webhook -> Code -> Respond.
- `src/mastra/tools/architect/builders/webhookLeadToAgentForgeCrm.ts:4` - builder generuje Webhook -> Code -> HTTP CRM -> Telegram -> Respond.
- `src/mastra/tools/architect/composer.ts:127` - `architect_compose_workflow`, obecnie sprawdza required inputs i strukture, ale nie pokrycie requestu.
- `src/mastra/tools/architect/execute-request.ts:7` - wrapper na Golden Path.
- `src/mastra/tools/architect/validation/workflow-validator.ts:405` - walidacja workflow; poprawna dla struktury, bezpieczenstwa i topologii, ale nie dla semantyki celu.
- `src/mastra/tools/system/delegate-task.ts` - kontrakt delegacji, guard `n8nMcpEngineer` tylko dla `automationArchitect`.
- `src/mastra/processors/pending-updates.ts:28` - ekstrakcja `threadId`; wazne dla znanego problemu HTTP `/generate`.
- `src/mastra/scripts/check-automation-patterns.ts` - obecny smoke wszystkich executable patternow.
- `src/mastra/scripts/check-automation-golden-path.ts` - obecny smoke Golden Path.
- `src/mastra/scripts/check-n8n-mcp-engineer.ts` - statyczny kontrakt MCP Engineer.

Wniosek z kodu: problem nie wynika z braku promptu. Prompt juz mowi architektowi, kiedy ma delegowac do `n8nMcpEngineer`, ale runtime nie egzekwuje tej decyzji. Brakuje warstwy "semantic coverage gate" pomiedzy wyborem patternu a deployem inactive.

## 2. Potwierdzone problemy

### 2.1. Pattern moze byc poprawny technicznie, ale niepelny wzgledem celu

Obecny pipeline:

1. `architect_match_pattern` znajduje podobny pattern.
2. `architect_execute_automation_request` w trybie `pattern` buduje workflow przez `pattern.build(spec)`.
3. Golden Path waliduje workflow strukturalnie.
4. Jesli workflow jest bezpieczny i deployowalny, zostaje utworzony inactive w n8n.

Brakujacy warunek:

Workflow musi pokrywac wymagane operacje z requestu. Jesli request wymaga "insert do MongoDB", a workflow nie ma node typu `n8n-nodes-base.mongoDb` albo rownowaznej operacji zapisu, pipeline powinien zatrzymac deploy lub wymusic MCP handoff.

### 2.2. `inferRuntimeRequirements` patrzy za pozno

`inferRuntimeRequirements(workflow, input)` wykrywa potrzeby runtime na bazie wygenerowanego workflow i tekstu. Jesli pattern pominie Mongo, workflow nie zawiera Mongo, wiec wymaganie moze nie zostac wykryte jako krytyczne.

Poprawna kolejnosc:

1. Wyciagnij wymagane capability z `AutomationSpec` i requestu.
2. Wyciagnij faktyczne capability z workflow.
3. Porownaj.
4. Dopiero potem runtime check, walidacja, risk score i deploy.

### 2.3. `n8nMcpEngineer` dziala, ale nie jest wymuszany

Subagent ma poprawnie ograniczona allowliste:

- `tools_documentation`
- `search_nodes`
- `get_node`
- `search_templates`
- `get_template`
- `validate_node`
- `validate_workflow`

Delegacja dziala, gdy architekt zostanie do niej jasno poproszony. Nie dziala jako gwarancja, gdy lokalny pattern wydaje sie dobry, ale jest niepelny.

### 2.4. Smoke test musi rozpoznawac wrappery tooli, nie tylko gole ID

W obserwacji runtime delegacja byla widoczna jako wrapper toola, np. `delegateTaskTool`, mimo ze wewnetrzny tool ID to `system_delegate_task`. Skrypt detekcyjny musi sprawdzac:

- nazwe wrappera toola,
- `toolName`,
- `toolCallId`,
- argument `targetAgent: "n8nMcpEngineer"`,
- wynik `agentUsed`.

### 2.5. HTTP `/api/agents/:id/generate` i `threadId`

W standardowym endpointcie Mastra top-level `threadId` nie trafil do miejsca, z ktorego korzysta Observational Memory. Skutek: blad typu "ObservationalMemory requires threadId".

Wniosek: testy agentow z pamiecia powinny uzywac albo:

- bezposredniego `agent.generate(..., { memory: { thread, resource } })`, albo
- lokalnego wrapper endpointu, ktory jawnie mapuje `threadId`/`resourceId` do `memory`.

### 2.6. `.env` nie powinien byc shell-sourcowany

W poprzednim smoke wartosci z `.env` zawierajace spacje powodowaly bledy typu `account`, `OAuth2`, `Header` jako komendy shella. Skrypty musza ladowac env przez `dotenv/config`, parser `.env` albo kontrolowany odczyt pojedynczych kluczy. Nie uzywac `source .env` w smoke.

## 3. Docelowe zachowanie MVP

MVP ma osiagnac piec rzeczy:

1. Architekt nie deployuje inactive workflow, ktory nie pokrywa krytycznych wymagan requestu.
2. Jesli lokalny pattern nie pokrywa wymagan, architekt dostaje jednoznaczny wynik: `pattern_coverage_gap`.
3. Wynik wskazuje, czego brakuje, np. `operation.mongo.insert`, `service.mongo`, `sideEffect.db.write`.
4. W takim przypadku naturalna nastepna akcja to delegacja do `n8nMcpEngineer` albo reczne zlozenie `workflow_json`, ale nadal przez Golden Path.
5. Smoke pipeline potrafi udowodnic dwie sciezki:
   - local pattern zostal zatrzymany przed deployem, gdy jest niepelny,
   - delegacja do `n8nMcpEngineer` jest wykrywana, bez aktywacji workflow.

## 4. Zasady projektowe

- To nie moze byc tylko prompt fix. Prompt zostaje poprawiony, ale krytyczne zabezpieczenie musi byc w runtime.
- Golden Path pozostaje jedynym wlascicielem deploy/update/test/activate dla workflow budowanych przez Mastra.
- `n8nMcpEngineer` pozostaje read-only. Nie dajemy mu create/update/delete/activate/test-run/credential management.
- Coverage gate ma byc addytywny i wstecznie kompatybilny dla istniejacych patternow.
- Najpierw tryb `warn` lub test-only, potem `block` dla krytycznych brakow.
- Nie blokujemy patternow za brak credentiali w unit smoke. Credentiale to stan srodowiska, niekoniecznie blad buildera.
- Dla requestow bez jasnego wymogu side-effect nie wymuszamy MCP.
- Aktywacja workflow pozostaje poza zakresem testow MVP.

## 5. Proponowana architektura: semantic capability coverage

Dodac wspolna warstwe czystych funkcji, np.:

`src/mastra/tools/architect/capability-coverage.ts`

### 5.1. Nowe pojecia

`AutomationCapability` jako string literal. Proponowany start:

- `trigger.manual`
- `trigger.webhook`
- `trigger.schedule`
- `trigger.telegram`
- `trigger.gmail`
- `node.code`
- `node.respondToWebhook`
- `node.httpRequest`
- `node.mongoDb`
- `node.telegram`
- `node.gmail`
- `node.googleSheets`
- `service.mastraApi`
- `service.ollama`
- `service.mongo`
- `service.telegram`
- `service.gmail`
- `service.googleSheets`
- `operation.webhook.receive`
- `operation.webhook.respond`
- `operation.payload.validate`
- `operation.mongo.insert`
- `operation.mongo.find`
- `operation.mongo.update`
- `operation.http.post`
- `operation.telegram.send`
- `operation.gmail.send`
- `operation.googleSheets.append`
- `sideEffect.db.write`
- `sideEffect.message.send`
- `sideEffect.email.send`
- `runtime.publicWebhook`
- `runtime.localMongo`
- `runtime.localMastraApi`
- `runtime.localOllama`

Nie trzeba od razu pokrywac calego n8n. MVP powinien obsluzyc uslugi, ktore sa juz w promptach i testach: Webhook, Code, Respond, MongoDB, HTTP Request, Telegram, Gmail, Google Sheets, Ollama/Mastra API.

### 5.2. Typy

Proponowany typ:

```ts
export type AutomationCapability =
  | 'trigger.webhook'
  | 'operation.mongo.insert'
  | 'sideEffect.db.write'
  // ...
```

Proponowany `CapabilitySet`:

```ts
export type CapabilityEvidence = {
  capability: AutomationCapability;
  source: 'spec' | 'request' | 'pattern' | 'workflow' | 'node' | 'credential';
  detail?: string;
};

export type CapabilityCoverageResult = {
  ok: boolean;
  score: number;
  required: AutomationCapability[];
  actual: AutomationCapability[];
  missingRequired: AutomationCapability[];
  warnings: string[];
  recommendation: 'use_pattern' | 'delegate_mcp' | 'compose_workflow_json' | 'block';
  evidence: CapabilityEvidence[];
};
```

### 5.3. Funkcje

Minimalny zestaw funkcji:

```ts
export function deriveSpecCapabilities(spec: AutomationSpec, request?: string): CapabilityEvidence[];
export function derivePatternCapabilities(pattern: AutomationPattern): CapabilityEvidence[];
export function deriveWorkflowCapabilities(workflow: any): CapabilityEvidence[];
export function evaluateCapabilityCoverage(required: CapabilityEvidence[], actual: CapabilityEvidence[]): CapabilityCoverageResult;
export function formatCoverageForModel(result: CapabilityCoverageResult): string;
```

### 5.4. Zrodla capability

Z `AutomationSpec`:

- `trigger.type === "webhook"` -> `trigger.webhook`, `operation.webhook.receive`.
- `trigger.type === "manual"` -> `trigger.manual`.
- `steps[].type`, `steps[].action`, `steps[].description` -> operacje.
- `externalServices` -> `service.*`.
- `credentialsNeeded` -> uslugi i wymagania credentiali.
- `dataPolicy` -> side effects.
- `goal` i `description` -> fallback slow kluczowych, np. `mongo`, `mongodb`, `insert`, `save`, `store`, `database`, `lead`.

Z workflow:

- node type `n8n-nodes-base.webhook` -> `trigger.webhook`, `operation.webhook.receive`.
- node type `n8n-nodes-base.respondToWebhook` -> `operation.webhook.respond`.
- node type `n8n-nodes-base.code` -> `node.code`; dodatkowo heurystyka `payload validate` z nazwy/parametrow.
- node type `n8n-nodes-base.mongoDb` -> `service.mongo`, `node.mongoDb`; operacja z parametrow `operation`.
- node type `n8n-nodes-base.httpRequest` -> `node.httpRequest`, `operation.http.post` jesli method POST.
- node type `n8n-nodes-base.telegram` -> `service.telegram`, `operation.telegram.send`.
- node type Gmail -> `service.gmail`, `operation.gmail.send`.
- node type Google Sheets -> `service.googleSheets`, `operation.googleSheets.append`.

Z patternu:

- jawne `capabilities` po dodaniu metadanych,
- fallback z `knowledgeCard.nodes`,
- fallback z `requiredCredentials`,
- fallback przez zbudowanie minimalnego workflow i `deriveWorkflowCapabilities`.

## 6. Zmiany w typach patternow

W `src/mastra/tools/architect/types.ts` rozszerzyc `AutomationPattern` addytywnie:

```ts
export type AutomationPattern = {
  // existing fields
  capabilities?: {
    supported: AutomationCapability[];
    excluded?: AutomationCapability[];
    requiredForSuccess?: AutomationCapability[];
    notes?: string[];
  };
};
```

Alternatywa mniej inwazyjna:

```ts
supportedCapabilities?: AutomationCapability[];
excludedCapabilities?: AutomationCapability[];
```

Rekomendacja: uzyc obiektu `capabilities`, bo bedzie czytelniejszy przy rozbudowie.

Wazne: to musi byc opcjonalne. Istniejace patterny nie powinny przestac sie kompilowac.

## 7. Zmiany w katalogu patternow

### 7.1. `webhook-validate-respond`

Dopisac:

```ts
capabilities: {
  supported: [
    'trigger.webhook',
    'operation.webhook.receive',
    'operation.payload.validate',
    'operation.webhook.respond',
    'node.code',
    'node.respondToWebhook'
  ],
  excluded: [
    'operation.mongo.insert',
    'operation.mongo.update',
    'sideEffect.db.write'
  ]
}
```

Efekt: request "webhook + Mongo insert" nie moze byc uznany za kompletnie pokryty przez ten pattern.

### 7.2. `webhook-lead-to-agentforge-crm`

Dopisac capability HTTP/CRM/Telegram, ale nie udawac Mongo:

```ts
supported: [
  'trigger.webhook',
  'operation.webhook.receive',
  'operation.payload.validate',
  'operation.http.post',
  'service.mastraApi',
  'operation.telegram.send',
  'operation.webhook.respond'
]
```

Jesli builder nie zapisuje do Mongo bezposrednio, nie dodawac `operation.mongo.insert`.

### 7.3. Pozostale patterny

MVP:

- dodac metadane tylko dla patternow w obszarze smoke i popularnych integracji,
- dla reszty polegac na fallback inference z workflow.

Post-MVP:

- uzupelnic wszystkie executable patterny,
- dodac check, ktory wykrywa rozjazd `capabilities.supported` vs faktyczne node types wygenerowanego workflow.

## 8. Zmiany w Pattern RAG

Plik: `src/mastra/tools/architect/pattern-rag.ts`

### 8.1. Obecne zachowanie

`architect_match_pattern` zwraca dopasowania oparte glownie o semantic similarity i podstawowe metadane patternu.

### 8.2. Docelowe zachowanie

Dla kazdego matcha dodac:

```ts
coverage: {
  ok: boolean;
  score: number;
  missingRequired: AutomationCapability[];
  recommendation: 'use_pattern' | 'delegate_mcp' | 'compose_workflow_json' | 'block';
}
semanticScore: number;
coverageScore: number;
finalScore: number;
```

Nie usuwac starego `score`, bo model i testy moga go juz oczekiwac. `score` moze zostac final score albo semantic score, ale musi byc opisane w output description.

### 8.3. Ranking

Proponowany ranking:

- `semanticScore` - obecna wartosc embedding/rag.
- `coverageScore` - `1 - missingCritical / requiredCritical`.
- `finalScore = semanticScore * 0.55 + coverageScore * 0.45`.

Regula twarda:

Jesli `missingRequired` zawiera side effect lub operacje storage/message/email wymagana przez request, `coverage.ok = false`, nawet gdy semantic score jest wysoki.

### 8.4. Output dla modelu

Przy `coverage.ok = false` match powinien jasno powiedziec:

- pattern jest podobny, ale nie wystarcza,
- czego brakuje,
- czy nalezy delegowac do `n8nMcpEngineer`.

Przyklad:

```json
{
  "id": "webhook-validate-respond",
  "score": 0.82,
  "coverage": {
    "ok": false,
    "missingRequired": ["operation.mongo.insert", "sideEffect.db.write"],
    "recommendation": "delegate_mcp"
  }
}
```

## 9. Golden Path coverage gate

Plik: `src/mastra/services/automation-golden-path.ts`

### 9.1. Miejsce w pipeline

Dodac krok po `resolveWorkflowInput(input)`, przed:

- `inferRuntimeRequirements`,
- `validateWorkflow`,
- `analyzeWorkflow`,
- `deployWorkflow`.

Kolejnosc:

```ts
const workflow = await resolveWorkflowInput(input);
const coverage = evaluateResolvedWorkflowCoverage(input, workflow);
steps.push({ id: 'coverage_check', status: coverage.ok ? 'passed' : 'blocked', ... });
if (!coverage.ok && shouldBlockCoverage(input, coverage)) {
  return blockedResult('pattern_coverage_gap', coverage);
}
```

### 9.2. Kiedy blokowac

MVP:

- Blokowac dla `mode: "pattern"`, gdy brakuje krytycznej capability.
- Dla `mode: "workflow_json"` najpierw `warn`, chyba ze request/spec jawnie przekazany razem z JSON wymaga operacji, ktorej workflow nie ma.
- Dla `mode: "file"` traktowac jak `workflow_json`.

Krytyczne capability:

- `sideEffect.db.write`
- `operation.mongo.insert`
- `operation.mongo.update`
- `sideEffect.message.send`
- `sideEffect.email.send`
- `operation.http.post`, jesli request wymaga wysylki do API
- `operation.webhook.respond`, jesli trigger webhook ma zwracac odpowiedz

### 9.3. Failure class

Dodac failure class:

`pattern_coverage_gap`

Wynik powinien zawierac:

```ts
{
  status: 'blocked',
  success: false,
  failureClass: 'pattern_coverage_gap',
  coverage,
  recoveryStrategies: [
    'delegate_to_n8n_mcp_engineer',
    'select_more_specific_pattern',
    'compose_custom_workflow_json_then_rerun_golden_path'
  ]
}
```

### 9.4. Interaction z runtime check

`inferRuntimeRequirements` powinien dostac takze required capabilities:

```ts
const runtimeRequirements = inferRuntimeRequirements(workflow, input, coverage.required);
```

Dzieki temu request wymagajacy Mongo uruchomi `requiresMongo`, nawet jesli workflow jeszcze nie zawiera node Mongo.

### 9.5. Feature flag

Dodac:

```env
AUTOMATION_COVERAGE_GATE_MODE=warn
AUTOMATION_COVERAGE_MIN_SCORE=1
```

Tryby:

- `off` - tylko testy lokalne.
- `warn` - dodaje `coverage` do wyniku, nie blokuje deployu.
- `block` - blokuje krytyczne braki.

Rekomendacja rollout:

1. Unit tests + local static checks.
2. `warn` w `.env.example`.
3. `block` w lokalnym `.env`, gdy smoke przejdzie.

Jesli chcemy mniej flag, MVP moze uzyc jednej:

```env
FEATURE_AUTOMATION_COVERAGE_GATE=true
```

Ale `MODE=warn|block` jest bezpieczniejsze regresyjnie.

## 10. Composer coverage check

Plik: `src/mastra/tools/architect/composer.ts`

`architect_compose_workflow` powinien uzyc tej samej funkcji coverage po `pattern.build(spec)`.

Docelowe zachowanie:

- Jesli pattern nie pokrywa speca, tool zwraca `success: false`.
- Nie zwraca gotowego workflow jako "OK".
- Zwraca `coverage` i rekomendacje.

Przyklad:

```json
{
  "success": false,
  "reason": "pattern_coverage_gap",
  "coverage": {
    "missingRequired": ["operation.mongo.insert", "sideEffect.db.write"],
    "recommendation": "delegate_mcp"
  }
}
```

To zabezpiecza manualna sciezke promptowa, gdy architekt nie uzyje jednego `architect_execute_automation_request`.

## 11. Delegacja do n8n MCP Engineer

### 11.1. Nie dawac MCP Engineer deploy rights

Pozostawiamy:

- read-only discovery,
- node inspection,
- template inspection,
- node validation,
- candidate workflow validation.

Nie dodajemy:

- create workflow,
- update workflow,
- delete workflow,
- activate/deactivate,
- test execution,
- credential management.

### 11.2. Prompt Automation Architect

Plik: `src/mastra/prompts/automation/base.md`

Dopisac twarda instrukcje:

Jesli `architect_match_pattern`, `architect_compose_workflow` albo `architect_execute_automation_request` zwroci `pattern_coverage_gap` lub `coverage.ok=false`, architekt ma:

1. Nie deployowac tego patternu.
2. Delegowac do `n8nMcpEngineer`, jezeli brakujace capability dotycza n8n node/operation/template.
3. Wrocic z candidate workflow do Golden Path.

### 11.3. Prompt n8n MCP Engineer

Plik: `src/mastra/prompts/automation/n8n-mcp-engineer.md`

Dopisac, ze przy coverage gap output ma zawierac:

- `missingCapabilities`,
- `nodePlan`,
- `validatedNodeConfigs`,
- `workflowCandidate` albo `null`,
- `handoff.readyForGoldenPath`.

Aktualny kontrakt `n8nMcpHandoff` juz jest dobry. Trzeba go tylko rozszerzyc addytywnie:

```json
{
  "missingCapabilities": [],
  "coverageNotes": []
}
```

### 11.4. Delegation contract test

Rozszerzyc `src/mastra/scripts/check-n8n-mcp-engineer.ts`:

- prompt architekta zawiera `pattern_coverage_gap`,
- prompt architekta zawiera reakcje na `coverage.ok=false`,
- prompt MCP Engineer zawiera `missingCapabilities`,
- allowlista nadal nie zawiera management tools.

## 12. Nowy pattern Mongo - decyzja MVP vs post-MVP

### 12.1. Minimalne MVP bez nowego patternu

Mozna naprawic regresje bez dodawania nowego patternu. Wtedy request "Webhook -> Mongo insert -> Respond" zostanie zatrzymany jako `pattern_coverage_gap`, a architekt bedzie musial delegowac do MCP albo zlozyc custom workflow JSON.

Plus:

- mniejszy zakres,
- mniejsze ryzyko zlego parametryzowania node MongoDB.

Minus:

- pipeline jeszcze nie wygeneruje automatycznie gotowego workflow dla popularnego przypadku Mongo.

### 12.2. Rekomendowany MVP+

Dodac pattern:

`webhook-validate-mongo-insert-respond`

Builder:

`src/mastra/tools/architect/builders/webhookValidateMongoInsertRespond.ts`

Workflow:

1. `Webhook Trigger`
2. `Validate Payload Code`
3. `MongoDB Insert`
4. `Respond to Webhook`

Capability:

```ts
supported: [
  'trigger.webhook',
  'operation.webhook.receive',
  'operation.payload.validate',
  'service.mongo',
  'node.mongoDb',
  'operation.mongo.insert',
  'sideEffect.db.write',
  'operation.webhook.respond'
]
```

Wazne: przed zakodowaniem parametrow Mongo warto uzyc `n8nMcpEngineer` do potwierdzenia:

- aktualnego node type,
- typeVersion,
- pola `operation`,
- pola collection/database,
- oczekiwanego formatu dokumentu,
- poprawnej walidacji `validate_node`.

Jesli MCP nie jest dostepny, lepiej zostawic to jako post-MVP niz zgadywac parametry.

### 12.3. Post-MVP

Dodac generator custom workflow z capability, ktory sklada proste liniowe workflow z klockow:

- trigger,
- validate,
- transform,
- one side effect,
- respond.

Nie musi zastapic Pattern RAG. Ma byc fallbackiem, gdy Pattern RAG nie ma kompletnego patternu, ale capability sa proste i znane.

## 13. HTTP threadId fix

### 13.1. Problem

Top-level `threadId` wyslany do standardowego `/api/agents/automation-architect/generate` nie zostal zmapowany do `memory.thread`. Observational Memory wymaga threadId, wiec endpoint moze failowac mimo poprawnego promptu.

### 13.2. Najpierw test poprawnego ksztaltu body

Sprawdzic, czy Mastra standard endpoint akceptuje:

```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "memory": {
    "thread": "smoke-thread",
    "resource": "local-user"
  }
}
```

Jesli dziala, dokumentujemy i skrypty uzywaja tego ksztaltu.

### 13.3. Jesli nie dziala: wrapper endpoint

Dodac lokalny endpoint w `src/mastra/index.ts`, np.:

`POST /deploy/agents/:agentId/generate`

Albo bardziej wasko:

`POST /deploy/automation-architect/generate`

Wrapper:

- waliduje `agentId` po allowliscie,
- wymaga `threadId`,
- wymaga `resourceId`,
- buduje `memory: { thread, resource }`,
- wywoluje `agent.generate`,
- zwraca tekst, kroki i tool calls w kontrolowanym ksztalcie.

Nie robic ogolnego proxy do dowolnego agenta bez allowlisty.

### 13.4. Test

Nowy skrypt:

`src/mastra/scripts/check-agent-generate-memory-thread.ts`

Sprawdza:

- wywolanie minimalnego promptu z threadId,
- brak bledu Observational Memory,
- pending-updates processor nadal widzi thread z `requestContext` albo memory options.

## 14. Smoke pipeline po naprawie

Dodac skrypt:

`src/mastra/scripts/check-n8n-mcp-pipeline-smoke.ts`

### 14.1. Tryb `coverage-block`

Cel: udowodnic, ze stary blad nie przechodzi.

Input:

Request/spec: "Webhook przyjmuje lead, waliduje email i message, zapisuje lead do MongoDB `agentforge.leads`, zwraca JSON `{ ok: true }`. Nie aktywuj workflow."

Oczekiwane:

- Golden Path z patternem `webhook-validate-respond` nie deployuje workflow.
- Wynik zawiera `failureClass: "pattern_coverage_gap"`.
- `missingRequired` zawiera `operation.mongo.insert` i `sideEffect.db.write`.
- n8n nie ma nowego workflow z prefixem smoke albo cleanup usuwa go natychmiast, jesli test uzywa trybu warn.

### 14.2. Tryb `delegation-only`

Cel: udowodnic, ze architekt umie delegowac do MCP bez mutacji n8n.

Prompt:

Poprosic architekta o design-only dla workflow z Mongo i jasno wymagac uzycia n8n MCP Engineer do sprawdzenia node MongoDB.

Oczekiwane:

- tool event zawiera delegacje do `n8nMcpEngineer`,
- subagent uzywa co najmniej jednego z:
  - `search_nodes`,
  - `get_node`,
  - `validate_node`,
  - `validate_workflow`,
  - `search_templates`,
  - `get_template`,
- brak `architect_deploy_automation`,
- brak `architect_activate_automation`,
- n8n workflow count bez zmian.

### 14.3. Tryb `inactive-golden-path`

Cel: udowodnic, ze kompletne workflow nadal przechodzi deploy inactive i mock test.

Opcje:

- uzyc safe manual workflow jak w `check-automation-golden-path.ts`,
- albo jesli dodamy Mongo pattern, uzyc go w inactive mode, bez aktywacji.

Oczekiwane:

- workflow created/updated inactive,
- `active:false`,
- mock test passed,
- cleanup po `workflowId`, chyba ze `KEEP_SMOKE_WORKFLOWS=true`.

### 14.4. Detekcja tool calls

Nie zakladac jednej nazwy. Detektor sprawdza:

- `delegateTaskTool`,
- `system_delegate_task`,
- `toolName`,
- `args.targetAgent`,
- `result.agentUsed`,
- zagnieżdzone `steps[].toolResults[]`.

### 14.5. Env loading

Skrypt:

- importuje `dotenv/config`,
- nie robi `source .env`,
- dla n8n API key uzywa `process.env.N8N_API_KEY`,
- w raportach redaktuje sekrety.

## 15. Testy jednostkowe i statyczne

### 15.1. Nowy skrypt `check:automation-coverage`

Dopisac do `package.json`:

```json
"check:automation-coverage": "bash scripts/with-node.sh npx tsx src/mastra/scripts/check-automation-coverage.ts"
```

Testy w skrypcie:

1. `deriveSpecCapabilities` dla speca Webhook+Mongo:
   - zawiera `trigger.webhook`,
   - zawiera `operation.mongo.insert`,
   - zawiera `sideEffect.db.write`,
   - zawiera `operation.webhook.respond`.
2. `deriveWorkflowCapabilities` dla workflow z `webhook-validate-respond`:
   - zawiera webhook/respond,
   - nie zawiera Mongo insert.
3. `evaluateCapabilityCoverage`:
   - `ok=false`,
   - `missingRequired` zawiera Mongo insert.
4. Pattern `webhook-validate-respond`:
   - `coverage.ok=false` dla Mongo spec.
5. Pattern Mongo, jesli dodany:
   - `coverage.ok=true` dla Mongo spec.
6. `architect_match_pattern`:
   - zwraca `coverage` addytywnie,
   - nie usuwa starego `score`.

### 15.2. Rozszerzyc `check:automation-patterns`

Dodac opcjonalny coverage sanity:

- dla kazdego executable patternu z `capabilities.supported`, zbudowac workflow,
- porownac capability z deklaracja,
- ostrzec, jesli deklaracja mowi `node.mongoDb`, a workflow nie ma node MongoDB.

Nie failowac od razu dla wszystkich brakow, bo stare patterny moga nie miec metadanych. Failowac tylko jawne sprzecznosci w patternach MVP.

### 15.3. Rozszerzyc `check:automation-golden-path`

Dodac test:

- `mode: "pattern"`,
- pattern `webhook-validate-respond`,
- spec wymagajacy Mongo,
- oczekiwany status `blocked`,
- oczekiwany brak deployu do n8n.

Jesli `AUTOMATION_COVERAGE_GATE_MODE=warn`, test powinien wymusic block przez param testowy albo env:

```env
AUTOMATION_COVERAGE_GATE_MODE=block
```

w procesie testu.

### 15.4. Rozszerzyc `check:n8n-mcp-engineer`

Dodac asercje:

- Automation prompt zawiera `pattern_coverage_gap`,
- Automation prompt zawiera `coverage.ok=false`,
- MCP Engineer prompt zawiera `missingCapabilities`,
- allowlista read-only zostaje bez management tools.

### 15.5. Opcjonalny integration smoke

Dopisac do `package.json`:

```json
"check:n8n-mcp-pipeline-smoke": "bash scripts/with-node.sh npx tsx src/mastra/scripts/check-n8n-mcp-pipeline-smoke.ts"
```

Ten test powinien byc osobny, bo wymaga:

- dzialajacego Mastra API,
- dzialajacego n8n,
- opcjonalnie wlaczonego MCP,
- modeli w Ollama.

Nie dodawac go do `npm run check:automation` domyslnie, dopoki nie bedzie stabilny czasowo.

## 16. Dokumentacja

Po implementacji uzupelnic:

- `docs/N8N-MCP-ENGINEER.md` - rola subagenta, allowlista, kiedy architekt deleguje.
- `docs/MCP-INTEGRATION.md` - flaga MCP, readonly vs management, porty lokalne.
- `docs/AUTOMATION-GOLDEN-PATH.md` albo analogiczny dokument, jesli istnieje - coverage gate i failure class.
- `.env.example` - nowe flagi coverage i smoke cleanup.
- `.env` lokalnie - analogiczne brakujace flagi, bez sekretow w commitach.

Uwaga: jezeli `docs/` jest ignorowane przez git, nadal warto zaktualizowac lokalna dokumentacje, ale w raporcie trzeba jasno powiedziec, czy pliki sa tracked czy ignored.

## 17. Zmiany w `.env` i `.env.example`

Dodac do `.env.example`:

```env
# Automation semantic coverage gate.
# off = disabled, warn = report only, block = block critical pattern gaps before deploy.
AUTOMATION_COVERAGE_GATE_MODE=warn
AUTOMATION_COVERAGE_MIN_SCORE=1

# Smoke test cleanup. false deletes temporary smoke workflows after checks.
KEEP_SMOKE_WORKFLOWS=false
```

Dodac do lokalnego `.env`:

```env
AUTOMATION_COVERAGE_GATE_MODE=block
AUTOMATION_COVERAGE_MIN_SCORE=1
KEEP_SMOKE_WORKFLOWS=false
```

Nie zmieniac sekretow. Nie przepisywac credential IDs bez potrzeby.

## 18. Kolejnosc implementacji MVP

### Etap 0 - baseline i fixtures

Czas: 1-2 h.

Prace:

1. Dodac fixture speca Webhook+Mongo+Respond w skrypcie coverage.
2. Dodac fixture workflow `webhook-validate-respond`.
3. Dodac fixture helperow bez n8n live.
4. Upewnic sie, ze obecny blad jest odtwarzalny na poziomie funkcji pure: required Mongo vs actual no Mongo.

Efekt:

- Mamy test, ktory dzisiaj failuje logicznie, zanim ruszymy runtime.

### Etap 1 - capability coverage library

Czas: 3-5 h.

Prace:

1. Dodac `capability-coverage.ts`.
2. Dodac typy capability.
3. Zaimplementowac `deriveSpecCapabilities`.
4. Zaimplementowac `deriveWorkflowCapabilities`.
5. Zaimplementowac `evaluateCapabilityCoverage`.
6. Dodac `check-automation-coverage.ts`.

Efekt:

- Pure tests bez n8n i bez modelu przechodza.

### Etap 2 - metadane patternow i Pattern RAG

Czas: 3-5 h.

Prace:

1. Rozszerzyc `AutomationPattern`.
2. Dodac capability do patternow MVP.
3. Rozszerzyc `StoredAutomationPattern`, jesli sync do Mongo serializuje patterny.
4. Rozszerzyc `matchPatternTool` o `coverage`.
5. Zachowac stare pola outputu.
6. Dodac testy ranking/coverage.

Efekt:

- `architect_match_pattern` pokazuje, ze pattern jest podobny, ale niekompletny.

### Etap 3 - Golden Path gate

Czas: 3-6 h.

Prace:

1. Dodac gate po `resolveWorkflowInput`.
2. Dodac step `coverage_check`.
3. Dodac failure class `pattern_coverage_gap`.
4. Dodac recovery strategies.
5. Podlaczyc `inferRuntimeRequirements` do required capabilities.
6. Rozszerzyc `check-automation-golden-path`.

Efekt:

- Nie da sie przypadkiem deployowac niepelnego patternu dla Mongo requestu.

### Etap 4 - Composer gate

Czas: 1-3 h.

Prace:

1. Dodac coverage check do `architect_compose_workflow`.
2. Dostosowac output schema.
3. Upewnic sie, ze model widzi `recommendation: delegate_mcp`.

Efekt:

- Manualna sciezka promptowa tez jest zabezpieczona.

### Etap 5 - prompty i kontrakt delegacji

Czas: 1-2 h.

Prace:

1. Dopisac reakcje architekta na `pattern_coverage_gap`.
2. Rozszerzyc `n8nMcpHandoff` o `missingCapabilities`.
3. Rozszerzyc `check-n8n-mcp-engineer.ts`.

Efekt:

- Model ma jasna instrukcje, a static check pilnuje, ze instrukcja nie zniknie.

### Etap 6 - smoke scripts

Czas: 3-5 h.

Prace:

1. Dodac `check-n8n-mcp-pipeline-smoke.ts`.
2. Dodac robust parser tool calls.
3. Dodac tryb `coverage-block`.
4. Dodac tryb `delegation-only`.
5. Dodac cleanup inactive smoke workflow po ID/name prefix.
6. Nie uzywac `source .env`.

Efekt:

- Da sie powtorzyc test, o ktory prosil uzytkownik: zlecic workflow architektowi, obserwowac delegacje do MCP, bez aktywacji.

### Etap 7 - HTTP thread wrapper

Czas: 2-4 h.

Prace:

1. Najpierw sprawdzic poprawny body shape standardowego endpointu.
2. Jesli nie dziala, dodac waski endpoint wrapper.
3. Dodac test memory/thread.
4. Udokumentowac sposob wolania.

Efekt:

- Testy przez HTTP nie wpadaja w blad Observational Memory.

### Etap 8 - dokumentacja i env

Czas: 1-2 h.

Prace:

1. Zaktualizowac docs.
2. Zaktualizowac `.env.example`.
3. Zaktualizowac lokalne `.env`.
4. Sprawdzic, czy nie wypisano sekretow.

Efekt:

- Kontrakt jest jasny dla kolejnych zmian i dla agenta architekta.

## 19. Szacowany czas

Minimalne MVP bez nowego Mongo patternu:

- 1 dzien roboczy przy dobrym stanie builda,
- realistycznie 1.5 dnia z testami i drobnymi poprawkami typow.

MVP rekomendowane:

- capability coverage,
- Pattern RAG coverage,
- Golden Path gate,
- Composer gate,
- prompt/static checks,
- smoke delegation,
- env/docs.

Szacunek: 1.5-2.5 dnia.

MVP+ z nowym patternem Mongo:

- dodatkowe 0.5-1 dnia,
- zalezy od potwierdzenia parametrow MongoDB node przez MCP i walidacje.

Pelne dopracowanie wszystkich patternow:

- 3-5 dni,
- glownie przez metadane capability, testy sanity i mozliwe rozjazdy builderow.

## 20. Ryzyko regresji

### 20.1. False positive coverage block

Ryzyko: gate zablokuje workflow, ktory faktycznie realizuje wymaganie w niestandardowy sposob, np. HTTP API zapisuje do CRM/Mongo po stronie Mastra.

Mitigacja:

- start od `warn`,
- block tylko dla krytycznych capability,
- evidence w wyniku,
- mozliwosc oznaczenia patternu jako wspierajacego capability przez `service.mastraApi` + `operation.http.post`, ale nie udawac bezposredniego Mongo.

### 20.2. False negative coverage

Ryzyko: heurystyka nie wykryje wymogu Mongo w request/spec.

Mitigacja:

- preferowac strukturalne pola `externalServices`, `credentialsNeeded`, `steps`,
- slowa kluczowe tylko jako fallback,
- w promptach architekta wymagac jawnego speca dla side effects,
- testy dla typowych fraz PL/EN: "zapisz do Mongo", "insert lead", "store in database".

### 20.3. Rozjazd metadanych patternu z builderem

Ryzyko: pattern deklaruje capability, ktorego workflow nie ma.

Mitigacja:

- `check:automation-patterns` porownuje deklaracje z `deriveWorkflowCapabilities`.
- Fail dla patternow MVP, warn dla reszty.

### 20.4. Zmiana output schema narzedzi

Ryzyko: model albo testy oczekuja starych pol `score`, `matches`, `success`.

Mitigacja:

- tylko pola addytywne,
- nie usuwac `score`,
- nie zmieniac nazw istniejacych pol bez migracji.

### 20.5. Flaky MCP/live model tests

Ryzyko: smoke zalezy od n8n, MCP, Ollama i modeli.

Mitigacja:

- pure checks jako wymagane,
- live smoke jako osobny script, nie w domyslnym `check:automation`,
- timeouty i jasne skip reason, gdy MCP disabled.

### 20.6. Cleanup workflow

Ryzyko: smoke usunie cudzy workflow.

Mitigacja:

- usuwac tylko workflow utworzony w tym runie i zapisany po `workflowId`,
- dodatkowo wymagac name prefix `Mastra Smoke Coverage`,
- domyslnie nie ruszac workflow bez owner record albo bez exact ID z wyniku,
- `KEEP_SMOKE_WORKFLOWS=true` jako escape hatch.

### 20.7. HTTP wrapper security

Ryzyko: lokalny wrapper generate stanie sie zbyt szerokim proxy.

Mitigacja:

- allowlista agentow,
- wymagane `threadId` i `resourceId`,
- brak dostepu do credential values,
- limit rozmiaru promptu,
- brak endpointu aktywujacego workflow.

## 21. Acceptance criteria

MVP jest gotowe, gdy:

1. `npm run check:automation-coverage` przechodzi.
2. `npm run check:automation-patterns` przechodzi albo daje tylko zaakceptowane warny credentialowe.
3. `npm run check:automation-golden-path` przechodzi.
4. `npm run check:n8n-mcp-engineer` przechodzi.
5. Request Webhook+Mongo+Respond nie deployuje `webhook-validate-respond`.
6. Wynik blokady zawiera `pattern_coverage_gap`.
7. Wynik blokady wskazuje `operation.mongo.insert` i `sideEffect.db.write`.
8. Architekt ma promptowa instrukcje, zeby po coverage gap delegowac do `n8nMcpEngineer`.
9. Smoke `delegation-only` wykrywa delegacje do `n8nMcpEngineer`.
10. Smoke nie aktywuje workflow.
11. Jezeli smoke tworzy workflow, jest on `active:false`.
12. `.env` i `.env.example` zawieraja nowe flagi.
13. Dokumentacja w `docs/` opisuje role coverage gate i MCP Engineer.

## 22. Post-MVP rozszerzenia

### 22.1. Pelna biblioteka capability dla n8n

Rozszerzyc capability mapping na wiecej node types:

- Slack,
- Discord,
- Postgres,
- MySQL,
- Redis,
- Notion,
- Airtable,
- Google Drive,
- binary/file flows,
- AI Agent / LangChain nodes.

### 22.2. Automatyczny pattern composer

Zbudowac deterministyczny composer:

- wejscie: required capabilities,
- wyjscie: workflow skeleton,
- node configs walidowane przez MCP Engineer,
- deploy nadal tylko przez Golden Path.

### 22.3. Template-assisted generation

Workflow:

1. `n8nMcpEngineer.search_templates`
2. `get_template`
3. mapowanie template na lokalne topology/env/credentials,
4. `validate_workflow`,
5. Golden Path deploy inactive.

### 22.4. Capability memory

Zapisywac do system memory:

- ktory pattern nie pokryl jakiego requestu,
- ktore node configs dla Mongo/Gmail/Sheets przeszly walidacje,
- failure cases dla `pattern_coverage_gap`.

Pamiec dla `n8nMcpEngineer` moze zostac thread-scoped read-only. Nie dawac mu system memory write w MVP, chyba ze pojawi sie silna potrzeba zapisywania walidowanych node configs. Jesli wlaczymy zapis, to tylko z typem `tool_contract` / `n8n_node_pattern` i bez sekretow.

### 22.5. Coverage-aware planner

Dodac do planowania architekta jawny checkpoint:

- required capabilities,
- candidate pattern,
- missing capabilities,
- MCP handoff required?,
- Golden Path allowed?

To moze byc czesc Strategy Reflector albo osobny tool `architect_plan_automation_capabilities`.

### 22.6. UI/Studio observability

Pokazywac w Mastra Studio/API:

- coverage result,
- missing capabilities,
- reason for block,
- MCP delegation summary,
- link do inactive workflow, jesli powstal.

## 23. Rekomendowana decyzja

Rekomenduje wdrozyc MVP w tej kolejnosci:

1. Capability coverage library.
2. Golden Path block dla krytycznych brakow w `mode: "pattern"`.
3. Pattern RAG coverage fields.
4. Composer coverage fields.
5. Prompt/static checks.
6. Smoke delegation-only i coverage-block.
7. Dopiero potem nowy Mongo pattern, po potwierdzeniu node config przez MCP.

Najwazniejsze: najpierw zatrzymac falszywie poprawne deploye. Dopiero potem rozszerzac automatyczne budowanie workflow.
