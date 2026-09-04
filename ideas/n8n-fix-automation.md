# Plan naprawy autonomii Automation Architect dla n8n w Mastrze

Status: plan dla deva  
Data: 2026-05-08  
Zakres: `agentic-agents/src/mastra`, lokalny n8n self-hosted, darmowa/community wersja n8n

## 0. Kontekst i decyzja

Obecny stan jest hybrydowy:

- stare workflowy n8n nadal należą do Jarvisa i mogą używać endpointów starego dashboardu,
- Mastra przejmuje funkcjonalność stopniowo,
- `automationArchitect` w Mastrze ma już pattern RAG, composer, risk scoring i deploy do n8n,
- część krytycznych elementów nadal jest zbyt promptowa albo niepełna runtime'owo.

Decyzja dla tej pracy:

```txt
Nie migrujemy automatycznie starych workflowów Jarvisa.
Nie poprawiamy ich URL-i jako część tego zadania.
Budujemy autonomię tylko dla nowych workflowów oznaczonych jako mastra-managed.
```

Stare workflowy mogą pozostać aktywne. Mastra może je czytać i ewentualnie uruchamiać, ale nie powinna ich edytować ani aktywować/dezaktywować automatycznie.

## 1. Cel końcowy

Docelowo użytkownik może napisać w Mastra Studio:

```txt
Zbuduj automatyzację n8n, która codziennie o 08:00 sprawdza blog konkurencji
i jeśli znajdzie słowo GastroBridge, wysyła alert na Telegram.
```

System powinien samodzielnie wykonać kontrolowany pipeline:

```txt
request
  -> runtime preflight
  -> AutomationSpec
  -> pattern match
  -> compose workflow
  -> credentials resolution
  -> deterministic validation
  -> risk scoring
  -> create inactive n8n draft
  -> test strategy / optional test run
  -> repair loop, max 3 attempts
  -> activation policy
  -> activate only when policy allows
  -> persist audit trail in Mongo
```

Minimalny poziom autonomii po wdrożeniu:

- prosty low-risk workflow może powstać i zostać aktywowany bez ręcznej ingerencji, jeżeli wszystkie credentiale i runtime endpointy są gotowe,
- workflow medium/high-risk może powstać jako inactive draft i zatrzymać się na approval lub missing config,
- system nie może po cichu wstawić placeholderów typu `https://example.com`, pustego `chatId`, pustego credentiala albo złego lokalnego URL-a,
- system musi wiedzieć, że n8n działa lokalnie jako kontener z `network_mode: host`, więc dla n8n poprawne adresy lokalne to `localhost`, nie service names typu `af-mongodb`.

## 2. Non-goals

Nie robimy w tym zadaniu:

- migracji wszystkich workflowów Jarvisa,
- usuwania lub dezaktywacji starych workflowów n8n,
- pełnego dashboardu do edycji automatyzacji,
- automatycznego pobierania sekretów od użytkownika w chacie,
- polegania na płatnych/enterprise funkcjach n8n,
- workflowów z `Execute Command`, SSH, filesystem access, destructive DB operations,
- bezpośredniego importu losowych workflowów z internetu jako produkcyjnych automatyzacji.

## 3. Ograniczenia darmowego lokalnego n8n

Zakładamy lokalne/self-hosted n8n Community:

- n8n REST API używa `X-N8N-API-KEY`.
- W non-enterprise API key ma praktycznie pełne uprawnienia, więc permission boundary musi być po stronie Mastry.
- Nie zakładać enterprise `$vars.*`; obecne `_skills/n8n` słusznie mówią, żeby nie używać `$vars.*`.
- Credentiale są w n8n credential store. Workflow JSON może zawierać referencję credentiala, ale nigdy sekret.
- Publiczne webhooki wymagają poprawnego `N8N_PUBLIC_WEBHOOK_BASE_URL` albo `N8N_WEBHOOK_URL`, jeśli mają działać z internetu.
- n8n działa w Dockerze z `network_mode: host`, więc n8n widzi hostowe usługi po:
  - Mastra API: `http://localhost:4111`
  - n8n REST/self: `http://localhost:5678`
  - Ollama: `http://localhost:11434`
  - MongoDB: `localhost:27017`

Jeżeli kiedyś n8n zostanie przeniesione do zwykłej sieci Docker Compose, wtedy ta macierz musi być zmieniona centralnie, a nie w patternach.

## 4. Aktualne problemy do naprawy

### 4.1. Composer gubi wartości inputów

Plik: `src/mastra/tools/architect/composer.ts`

`inputItemSchema` obecnie dopuszcza tylko:

```ts
{
  name,
  type,
  required,
  description
}
```

Buildery oczekują jednak w `helpers.ts` pól:

```ts
value
defaultValue
url
```

Efekt: agent może podać URL i keyword, ale po walidacji Zod te pola są odcięte. Builder dostaje pusty input i wstawia fallback, np. `https://example.com` albo `GastroBridge`.

To jest blocker autonomii.

### 4.2. Runtime endpointy nie mają jednego source of truth

Plik: `src/mastra/tools/architect/builders/helpers.ts`

Obecnie:

```ts
const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
```

W środowisku Mastry działa `localhost:4111`, a `localhost:3000` może być legacy Jarvis dashboard albo może nie działać wcale.

Buildery nie powinny zgadywać endpointów. Powinny czytać macierz runtime.

### 4.3. Credentials nie są deterministycznie podpinane

`telegramSendNode()` generuje node Telegram bez `credentials`.

W n8n node może wyglądać poprawnie wizualnie, ale execution padnie, jeżeli credential nie jest przypisany.

### 4.4. Meta-agent ma dostęp do raw n8n admin tools

Plik: `src/mastra/agents/meta-agent.ts`

W `ToolSearchProcessor` są:

- `n8n.update_workflow`
- `n8n.activate_workflow`
- `n8n.deactivate_workflow`

To pozwala meta-agentowi ominąć `automationArchitect`, `risk_score`, walidację i approval. Dla autonomii to jest zły permission model.

### 4.5. `deploy_automation` ufa wejściu od modelu

Plik: `src/mastra/tools/architect/deploy.ts`

Tool wymaga `riskVerdict` i `riskScore`, ale sam ich nie przelicza. Jeżeli model przekaże błędny werdykt, runtime nie wykryje tego deterministycznie.

### 4.6. Brak twardej walidacji workflow przed deployem

W Mastrze jest `architect.risk_score`, ale nie ma pełnego walidatora:

- struktura workflow,
- znane node types,
- typeVersion,
- connections,
- references do nieistniejących node'ów,
- expression syntax,
- `$vars.*`,
- missing credentials,
- forbidden nodes,
- pusty workflow,
- placeholdery `example.com`, empty chatId, empty endpoint.

Stary Jarvis miał podobny kierunek w `packages/automation-architect/src/validators/workflowValidator.ts`. Warto przenieść tę logikę, ale dopasować do Mastry.

### 4.7. Część patternów jest abstrakcyjna i zwraca pusty workflow

W `pattern-catalog.ts` są patterny typu:

- `execute-subworkflow-llm-json-normalizer`
- `llm-json-retry-guard`
- `cache-before-llm`
- `gemini-escalation-approval`
- `workflow-drift-detector`

Niektóre mają `build: (_spec) => ({})`. Nie mogą być wybierane jako executable pattern.

## 5. Docelowa architektura

### 5.1. Podział odpowiedzialności

```txt
Meta Agent
  - rozpoznaje intencję
  - deleguje do automationArchitect
  - komunikuje wynik użytkownikowi
  - nie edytuje workflowów n8n bezpośrednio

Automation Architect
  - buduje spec
  - dobiera pattern
  - komponuje workflow
  - waliduje
  - liczy ryzyko
  - tworzy inactive draft
  - uruchamia test/repair loop
  - aktywuje tylko według policy

Runtime tools
  - pilnują endpointów, credentiali, ownership, approval
  - nie ufają modelowi w decyzjach bezpieczeństwa

n8n
  - execution engine
  - credential store
  - workflow store
```

### 5.2. Własność workflowów

Każdy workflow tworzony przez Mastrę musi mieć:

- nazwę z prefixem albo tagiem, np. `Mastra - <name>`,
- metadata w `settings` lub `meta`, jeśli n8n API pozwala,
- rekord w MongoDB `automation_requests`,
- zapis `n8nWorkflowId`,
- status lifecycle.

Proponowane statusy:

```ts
type AutomationStatus =
  | 'requested'
  | 'spec_ready'
  | 'composed'
  | 'validation_failed'
  | 'risk_blocked'
  | 'draft_created'
  | 'test_pending'
  | 'test_failed'
  | 'awaiting_approval'
  | 'active'
  | 'paused'
  | 'failed';
```

## 6. Etap 1 - runtime topology jako source of truth

### Cel

Usunąć zgadywanie lokalnych adresów z builderów i promptów.

### Nowe pliki

```txt
src/mastra/config/runtime-topology.ts
src/mastra/tools/architect/runtime-check.ts
```

### `runtime-topology.ts`

Proponowany kontrakt:

```ts
export type RuntimeTopology = {
  mode: 'local-host-network' | 'docker-compose-network';
  mastraStudioUrl: string;
  mastraApiUrlForN8n: string;
  n8nRestBaseUrl: string;
  n8nPublicWebhookBaseUrl?: string;
  ollamaBaseUrlForN8n: string;
  mongoUriForMastra: string;
  mongoHostForN8n: string;
  mongoDbName: string;
};

export function getRuntimeTopology(): RuntimeTopology;
export function assertRuntimeTopologyForWorkflow(kind: WorkflowKind): RuntimeTopologyCheck;
```

Domyślne wartości dla obecnego środowiska:

```ts
{
  mode: 'local-host-network',
  mastraStudioUrl: process.env.MASTRA_STUDIO_URL ?? 'http://localhost:4111',
  mastraApiUrlForN8n: process.env.MASTRA_API_URL_FOR_N8N ?? 'http://localhost:4111',
  n8nRestBaseUrl: process.env.N8N_BASE_URL ?? process.env.N8N_URL ?? 'http://localhost:5678',
  n8nPublicWebhookBaseUrl: process.env.N8N_PUBLIC_WEBHOOK_BASE_URL ?? process.env.N8N_WEBHOOK_URL,
  ollamaBaseUrlForN8n: process.env.OLLAMA_BASE_URL_FOR_N8N ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  mongoUriForMastra: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/agentforge',
  mongoHostForN8n: process.env.MONGO_HOST_FOR_N8N ?? 'localhost:27017',
  mongoDbName: process.env.MONGO_DB_NAME ?? 'agentforge'
}
```

### Env do dodać do `.env.example`

```bash
MASTRA_STUDIO_URL=http://localhost:4111
MASTRA_API_URL_FOR_N8N=http://localhost:4111
N8N_BASE_URL=http://localhost:5678
N8N_PUBLIC_WEBHOOK_BASE_URL=https://replace-me.trycloudflare.com
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_BASE_URL_FOR_N8N=http://localhost:11434
MONGO_HOST_FOR_N8N=localhost:27017
MONGO_DB_NAME=agentforge
```

### Runtime check tool

Nowe narzędzie:

```txt
architect.runtime_check
```

Input:

```ts
{
  requiresPublicWebhook?: boolean;
  requiresMastraApi?: boolean;
  requiresOllama?: boolean;
  requiresMongo?: boolean;
  requiresTelegram?: boolean;
}
```

Output:

```ts
{
  ok: boolean;
  topology: RuntimeTopology;
  checks: Array<{
    key: string;
    ok: boolean;
    severity: 'info' | 'warning' | 'blocker';
    message: string;
  }>;
  missingConfig: Array<{
    key: string;
    required: boolean;
    description: string;
  }>;
}
```

Checks:

- `GET ${n8nRestBaseUrl}/healthz`
- `GET ${ollamaBaseUrlForN8n}/api/tags`, jeśli workflow używa LLM
- `GET ${mastraApiUrlForN8n}` albo dedykowany health endpoint, jeśli workflow woła Mastrę
- `n8nPublicWebhookBaseUrl` nie może być localhost, jeśli workflow wymaga publicznego webhooka
- `N8N_API_KEY` musi istnieć dla deploy/list/update
- `N8N_TELEGRAM_CHAT_ID` musi istnieć, jeśli workflow ma Telegram send

### Zmiany w builderach

W `helpers.ts`:

- użyć `getRuntimeTopology()`,
- zastąpić `DASHBOARD_URL || localhost:3000`,
- wprowadzić `agentForge*Endpoint` jako Mastra endpoints albo jasno nazwać je legacy.

Proponowane endpointy dla Mastry:

```txt
${MASTRA_API_URL_FOR_N8N}/api/...
```

Uwaga: trzeba sprawdzić, które endpointy realnie istnieją w Mastrze. Jeżeli `/api/tasks`, `/api/shared-memory`, `/api/crm` nie istnieją, builder nie może ich używać jako działające endpointy. Wtedy pattern powinien zgłosić `missingConfig` albo użyć dedykowanych Mastra tools/workflows zamiast HTTP.

### Acceptance criteria

- `helpers.ts` nie zawiera domyślnego `localhost:3000`.
- `architect.runtime_check` pokazuje n8n, Mastra, Ollama i public webhook config.
- Workflow wymagający public webhooka nie przechodzi do aktywacji, jeśli public URL jest pusty albo localhost.
- W dokumentacji promptu Architecta jest informacja: n8n działa z `network_mode: host`, używaj `localhost`.

## 7. Etap 2 - naprawa AutomationSpec.inputs

### Cel

Agent musi móc przekazać konkretne wartości requestu do buildera.

### Pliki

```txt
src/mastra/tools/architect/types.ts
src/mastra/tools/architect/composer.ts
src/mastra/tools/architect/builders/helpers.ts
```

### Zmiana typu inputu

W `types.ts`:

```ts
export type AutomationInput = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'url' | 'secret' | 'json';
  required: boolean;
  description: string;
  value?: unknown;
  defaultValue?: unknown;
  source?: 'user' | 'env' | 'runtime' | 'derived' | 'placeholder';
  aliases?: string[];
};
```

W `composer.ts`:

```ts
const inputItemSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'url', 'secret', 'json']),
  required: z.boolean(),
  description: z.string(),
  value: z.unknown().optional(),
  defaultValue: z.unknown().optional(),
  source: z.enum(['user', 'env', 'runtime', 'derived', 'placeholder']).optional(),
  aliases: z.array(z.string()).optional(),
});
```

Nie używać `.strip()` dla wartości potrzebnych builderom.

### Walidacja required inputs

Obecny check sprawdza tylko nazwę inputu. Trzeba sprawdzać też wartość.

Dla każdego `pattern.requiredInputs`:

- istnieje input dopasowany po aliasie,
- jeżeli input required, ma realną wartość,
- wartość nie jest fallbackiem technicznym,
- URL jest poprawnym URL-em,
- secret nie może mieć raw value w workflow JSON.

Jeżeli brakuje wartości:

```ts
return {
  success: false,
  patternId,
  message: 'Brak wymaganych wartości inputów',
  missingConfig: [
    { key: 'url', required: true, description: 'URL strony do monitorowania' }
  ]
}
```

### Zakaz niebezpiecznych fallbacków

W builderach fallbacki typu:

- `https://example.com`
- `GastroBridge`
- `agentforge-webhook`
- pusty `chatId`

mogą zostać tylko jako test/dev fallback, ale nie w production compose.

Proponowane rozwiązanie:

```ts
getInputString(spec, aliases, fallback, { allowFallback: false })
```

Albo:

```ts
requiredInputString(spec, aliases)
optionalInputString(spec, aliases, fallback)
```

### Acceptance criteria

- Smoke test: `scheduled-http-keyword-to-telegram` z inputami `url=https://foo.test` i `keywords=abc,def` generuje workflow z tymi wartościami, nie fallbackami.
- Composer zwraca `missingConfig`, gdy brakuje required values.
- Żaden executable pattern nie generuje `https://example.com` w trybie normalnym.

## 8. Etap 3 - credential resolver

### Cel

Workflowy mają używać istniejących credentiali n8n przez referencje, bez sekretów w JSON i bez ręcznego klikania przy każdym workflow.

### Nowe pliki

```txt
src/mastra/tools/architect/credentials/credential-registry.ts
src/mastra/tools/architect/credentials/credential-resolver.ts
src/mastra/tools/architect/credentials/credential-types.ts
src/mastra/tools/architect/credentials/credential-tools.ts
```

### Credential registry

MVP może być oparty o env:

```bash
N8N_CREDENTIAL_TELEGRAM_ID=
N8N_CREDENTIAL_TELEGRAM_NAME=Telegram Bot
N8N_CREDENTIAL_MONGO_ID=
N8N_CREDENTIAL_MONGO_NAME=MongoDB
N8N_CREDENTIAL_GMAIL_ID=
N8N_CREDENTIAL_GMAIL_NAME=Gmail OAuth2
```

Docelowo można czytać listę credentiali z n8n API, jeśli endpoint jest dostępny i stabilny w lokalnej wersji. Nie zakładać tego w MVP.

Typ:

```ts
export type CredentialRef = {
  service: 'telegram' | 'mongo' | 'gmail' | 'smtp' | 'httpHeaderAuth' | 'n8nApi' | string;
  n8nCredentialType: string;
  id: string;
  name: string;
};
```

Mapowanie:

```ts
telegram -> { n8nCredentialType: 'telegramApi' }
mongo -> { n8nCredentialType: 'mongoDb' }
gmail -> zależnie od używanego node'a
```

### Tool

Nowe narzędzie:

```txt
architect.resolve_credentials
```

Input:

```ts
{
  required: Array<{ service: string; required: boolean; credentialName?: string }>;
}
```

Output:

```ts
{
  ok: boolean;
  credentials: Record<string, CredentialRef>;
  missing: Array<{ service: string; required: boolean; setupHint: string }>;
}
```

### Integracja z builderami

W `telegramSendNode()`:

```ts
credentials: {
  telegramApi: {
    id: resolved.id,
    name: resolved.name
  }
}
```

Nie używać `"id": "1"` na sztywno, chyba że pochodzi z registry.

### Setup hints

Jeżeli brakuje credentiala, output powinien powiedzieć:

```txt
Brakuje credentiala Telegram w n8n.
Utwórz credential w n8n UI: Credentials -> Telegram API.
Następnie ustaw N8N_CREDENTIAL_TELEGRAM_ID i N8N_CREDENTIAL_TELEGRAM_NAME w agentic-agents/.env.
Nie wklejaj tokena do chatu.
```

### Acceptance criteria

- Telegram workflow ma `credentials.telegramApi`.
- Mongo workflow ma `credentials.mongoDb`, jeśli używa MongoDB node.
- Brak credentiala blokuje activation i real test.
- Sekret nigdy nie trafia do workflow JSON, promptu, loga ani Telegram message.

## 9. Etap 4 - deterministic workflow validator

### Cel

Żaden workflow nie może być deployowany bez twardej walidacji.

### Nowe pliki

```txt
src/mastra/tools/architect/validation/workflow-validator.ts
src/mastra/tools/architect/validation/node-registry.ts
src/mastra/tools/architect/validation/validation-types.ts
src/mastra/tools/architect/validation/validation-tool.ts
```

Można przenieść i uprościć logikę ze starego Jarvisa:

```txt
/projekty/jarvis-dashboard-agent/packages/automation-architect/src/validators/workflowValidator.ts
```

### Validator checks

Minimalny zestaw:

1. Workflow object
   - `name` string
   - `nodes` non-empty array
   - `connections` object
   - `settings.executionOrder === 'v1'`

2. Node fields
   - `id`
   - `name`
   - `type`
   - `typeVersion`
   - `parameters`
   - `position`
   - unique `name`
   - unique `id`

3. Known node types
   - local registry dla top node'ów,
   - warning dla unknown,
   - error dla forbidden.

4. Connections
   - source node exists,
   - target node exists,
   - no self-loop,
   - no dangling middle nodes,
   - IF/Switch branch shape is valid.

5. Expressions
   - no `$vars.*`,
   - balanced `={{ ... }}`,
   - references `$('<node>')` point to existing nodes,
   - no `[object Object]`,
   - webhook body access documented.

6. Runtime placeholders
   - no `https://example.com`,
   - no empty `chatId`,
   - no empty URL,
   - no `localhost:3000` unless explicitly allowed legacy mode,
   - no `host.docker.internal` in current `local-host-network` mode,
   - no `af-mongodb` in current `local-host-network` mode.

7. Credentials
   - nodes requiring credentials have credential refs,
   - refs are not raw tokens,
   - required credential type matches node.

8. Security
   - forbidden node types:
     - `n8n-nodes-base.executeCommand`
     - SSH
     - filesystem/read/write binary file unless explicitly approved and implemented later
   - Code node:
     - no `eval`
     - no `new Function`
     - no `child_process`
     - no `fs`
   - HTTP Request:
     - user-controlled URL must be blocked unless allowlisted.

### Tool

```txt
architect.validate_workflow
```

Input:

```ts
{
  workflow: N8nWorkflowDefinition;
  profile: 'draft' | 'strict' | 'activation';
  runtimeMode?: RuntimeTopology['mode'];
}
```

Output:

```ts
{
  valid: boolean;
  profile: string;
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  securityIssues: ValidationFinding[];
  missingCredentials: MissingCredential[];
  missingConfig: MissingConfig[];
  nodeCount: number;
  connectionCount: number;
}
```

### Profile semantics

`draft`:

- errors block create,
- warnings allowed,
- missing optional credentials allowed,
- required credentials can create draft only if workflow is clearly marked inactive and missing credentials are persisted.

`strict`:

- no errors,
- no security issues,
- no missing required config,
- no missing required credentials.

`activation`:

- strict plus activation policy checks.

### Acceptance criteria

- Pusty pattern `build: () => ({})` nie przechodzi.
- Workflow z `localhost:3000` dostaje warning/error zależnie od profile.
- Workflow z Telegram node bez credentiala nie przechodzi activation.
- Workflow z `$vars.*` nie przechodzi.
- Workflow z `Execute Command` jest blokowany.

## 10. Etap 5 - hardening `deploy_automation`

### Cel

Deploy ma być bezpiecznym runtime gate, nie tylko narzędziem REST.

### Plik

```txt
src/mastra/tools/architect/deploy.ts
```

### Zmiana kontraktu

Obecnie agent przekazuje:

```ts
riskVerdict
riskScore
approvalToken
```

Docelowo `deploy_automation` powinien sam:

1. uruchomić `validateWorkflow(profile='draft')`,
2. uruchomić `riskScore` na workflow,
3. sprawdzić ownership, jeśli update,
4. sprawdzić approval, jeśli wymagane,
5. wymusić `active: false`,
6. utworzyć lub zaktualizować draft,
7. zapisać snapshot do Mongo.

Proponowany input:

```ts
{
  automationId?: string;
  workflow: N8nWorkflowDefinition;
  operation?: 'create' | 'update';
  workflowId?: string;
  approvalToken?: string;
  allowDraftWithMissingCredentials?: boolean;
}
```

Output:

```ts
{
  success: boolean;
  automationId: string;
  workflowId?: string;
  operation: 'create' | 'update' | 'blocked';
  validation: ValidationResult;
  risk: RiskScoreResult;
  message: string;
  error?: string;
}
```

### Ownership check

Jeżeli `workflowId` istnieje i nie ma rekordu w Mongo jako `mastra-managed`, update ma być zablokowany:

```txt
Refusing to update workflow not owned by Mastra.
Use explicit legacy admin tool if this is intentional.
```

### Snapshot

Po create/update zapisać:

```ts
{
  automationId,
  n8nWorkflowId,
  workflowName,
  workflowJson,
  validation,
  risk,
  status: 'draft_created',
  createdAt,
  updatedAt,
  source: 'mastra-automation-architect'
}
```

### Acceptance criteria

- Agent nie może deployować workflow z błędnym `riskVerdict`, bo deploy sam przelicza ryzyko.
- `active` zawsze false przy create/update.
- Update legacy workflowa jest blokowany.
- Każdy create/update ma snapshot w Mongo.

## 11. Etap 6 - activation policy zamiast raw activate

### Cel

Aktywacja ma być decyzją runtime, nie decyzją promptu.

### Nowe pliki

```txt
src/mastra/tools/architect/activation/activation-policy.ts
src/mastra/tools/architect/activation/activate-automation.ts
```

### Usunąć raw activation z normalnej ścieżki

W `automation-architect.ts` można zostawić `n8nActivateWorkflowTool` tylko jako admin/debug albo usunąć z toolsetu i zastąpić:

```txt
architect.activate_automation
```

W `meta-agent.ts` usunąć z ToolSearch pool:

- `n8nUpdateWorkflowTool`
- `n8nActivateWorkflowTool`
- `n8nDeactivateWorkflowTool`

Zostawić meta-agentowi:

- `n8n.health`
- `n8n.list_workflows`
- `n8n.get_workflow`
- `n8n.trigger` ewentualnie tylko dla safe webhooks.

### Activation policy

Proponowana polityka:

```ts
type ApprovalAction =
  | 'create_draft'
  | 'test_mock'
  | 'test_with_real_credentials'
  | 'activate_workflow'
  | 'manual_review_required';

const POLICY = {
  low: {
    createDraft: 'auto',
    testMock: 'auto',
    realCredentialsTest: 'auto-if-no-external-send',
    activate: 'auto-if-safe-pattern'
  },
  medium: {
    createDraft: 'auto',
    testMock: 'auto',
    realCredentialsTest: 'approval',
    activate: 'approval'
  },
  high: {
    createDraft: 'approval-or-configured-preapproval',
    testMock: 'auto',
    realCredentialsTest: 'approval',
    activate: 'approval'
  },
  critical: {
    createDraft: 'block',
    activate: 'block'
  }
};
```

Safe auto-activation candidates:

- local HTTP health monitor to Telegram only if Telegram credential exists and user allowed alert workflows,
- local scheduled no-op/test workflow,
- webhook validate/respond with non-public test URL and auth,
- workflow documentation.

Never auto-activate:

- sends emails to external users,
- writes CRM/customer data,
- deletes data,
- uses external paid APIs,
- public unauthenticated webhook,
- scraping high-volume external sites,
- touches production DB directly,
- contains LLM output used for write/send without validator.

### Tool contract

```txt
architect.activate_automation
```

Input:

```ts
{
  automationId: string;
  workflowId: string;
  approvalToken?: string;
  mode?: 'auto' | 'after_approval';
}
```

Checks:

- automation exists,
- workflowId matches automationId,
- workflow is mastra-managed,
- latest validation profile `activation` valid,
- latest risk not block,
- required approvals resolved,
- required credentials resolved,
- no missingConfig.

### Acceptance criteria

- `n8n.activate_workflow` is not reachable by meta-agent normal flow.
- Activation of medium/high workflow without approval fails.
- Activation of legacy workflow by automation tool fails.
- Low safe workflow can activate only after strict validation.

## 12. Etap 7 - test run i repair loop

### Cel

Autonomia nie kończy się na imporcie JSON. System ma wykryć, czy workflow realnie działa.

### Nowe pliki

```txt
src/mastra/tools/architect/testing/test-workflow.ts
src/mastra/tools/architect/testing/mock-data.ts
src/mastra/tools/architect/testing/execution-analyzer.ts
src/mastra/tools/architect/testing/repair-workflow.ts
```

### Tryby testu

```ts
type TestMode = 'mock' | 'manual' | 'real_credentials';
```

`mock`:

- nie wymaga aktywacji,
- waliduje workflow i generuje przykładowy payload,
- jeżeli n8n API `/run` działa stabilnie, uruchamia workflow manualnie,
- jeśli nie, zapisuje test plan i wymaga manualnego kliknięcia w n8n.

`manual`:

- tworzy instrukcje dla użytkownika albo deva,
- nie aktywuje workflow.

`real_credentials`:

- wymaga credentiali,
- dla medium/high wymaga approval,
- wykonuje workflow na kontrolowanych danych,
- potem czyta execution logs.

### Tool

```txt
architect.test_workflow
```

Input:

```ts
{
  automationId: string;
  workflowId: string;
  mode: 'mock' | 'manual' | 'real_credentials';
  payload?: unknown;
  approvalToken?: string;
}
```

Output:

```ts
{
  success: boolean;
  status: 'passed' | 'failed' | 'manual_required' | 'blocked';
  executionId?: string;
  findings: Array<{
    severity: 'error' | 'warning' | 'info';
    nodeName?: string;
    message: string;
    suggestedFix?: string;
  }>;
}
```

### Repair loop

Po failed validation albo failed execution:

```txt
compose/patch -> validate -> test -> analyze -> repair
max 3 attempts
```

Ważne: repair nie powinien generować workflow od zera. Ma robić minimalny patch.

Tool:

```txt
architect.repair_workflow
```

Input:

```ts
{
  automationId: string;
  workflow: N8nWorkflowDefinition;
  validation?: ValidationResult;
  executionFindings?: ExecutionFinding[];
  attempt: 1 | 2 | 3;
}
```

Output:

```ts
{
  success: boolean;
  patchedWorkflow?: N8nWorkflowDefinition;
  changes: string[];
  stopReason?: string;
}
```

### Acceptance criteria

- Failed validation triggers repair attempt, not deploy.
- Repair max 3 attempts.
- Test results are persisted in Mongo.
- Final response to user says whether workflow is draft, tested, active, or blocked.

## 13. Etap 8 - pattern governance

### Cel

Patterny mają być świadomie utrzymywaną biblioteką, a nie losowym katalogiem przykładów.

### Zmiany w typie patternu

Plik:

```txt
src/mastra/tools/architect/types.ts
```

Dodać:

```ts
export type AutomationPattern = {
  id: string;
  name: string;
  description: string;
  risk: AutomationPatternRisk;
  supportedIntents: string[];
  requiredInputs: string[];
  requiredCredentials: string[];
  forbiddenWithoutApproval: boolean;
  executable: boolean;
  maturity: 'draft' | 'tested' | 'production';
  n8nCommunityCompatible: boolean;
  build?: (spec: AutomationSpec, ctx: BuildContext) => N8nWorkflowDefinition;
  knowledgeCard?: PatternKnowledgeCard;
};
```

### Abstract patterns

Patterny abstrakcyjne:

- zostają w knowledge catalog,
- nie mogą zostać zwrócone jako executable match do `compose_workflow`,
- mogą być użyte jako recommendation/fallback strategy.

`match_pattern` powinien zwracać:

```ts
{
  id,
  executable,
  maturity,
  reason,
  score
}
```

Composer powinien blokować:

```txt
Pattern is not executable. Use it as guidance only.
```

### Smoke test wszystkich patternów

Dodać skrypt:

```txt
src/mastra/scripts/check-automation-patterns.ts
```

Co robi:

- iteruje po `PATTERN_CATALOG`,
- dla executable patternów generuje minimalny spec,
- odpala `compose`,
- odpala `validate_workflow(profile='draft')`,
- raportuje:
  - puste workflow,
  - missing required values,
  - missing credentials,
  - forbidden fallbacki,
  - unknown node types.

Komenda:

```bash
npx tsx src/mastra/scripts/check-automation-patterns.ts
```

### Acceptance criteria

- Żaden `executable: true` pattern nie zwraca `{}`.
- Każdy executable pattern przechodzi draft validation na minimalnym specu.
- Abstract patterns nie są deployowalne.

## 14. Etap 9 - zewnętrzne wzorce open source jako corpus, nie runtime

### Decyzja

Obecne ~43 patterny wystarczą na start jako własne, kontrolowane executable builders. Nie wystarczą jako pełna wiedza o n8n. Dlatego:

```txt
Własne patterny = executable, testowane, deployowalne.
Open-source templates = read-only corpus do inspiracji, node lookup, examples, validation.
```

Nie importować losowych workflowów z internetu bezpośrednio do n8n.

### Kandydaci

1. `czlonkowski/n8n-mcp`
   - node documentation,
   - node schemas,
   - workflow templates,
   - `validate_node`,
   - `validate_workflow`.

2. `czlonkowski/n8n-skills`
   - dobre instrukcje procesowe dla agentów,
   - expression syntax,
   - validation expert,
   - node configuration,
   - Code node JS.

3. `EtienneLescot/n8n-as-code`
   - TypeScript workflows,
   - local schema/ontology,
   - validation,
   - GitOps pull/push,
   - duży indeks templates.

4. Oficjalne n8n MCP / Workflow SDK, jeśli lokalna wersja n8n to wspiera.

### Integracja MVP

Etap MVP bez ryzykownej zależności:

- nie instalować jeszcze jako runtime dependency,
- dodać `docs/automation-architect/external-n8n-knowledge.md` albo sekcję w `_skills`,
- wybrać jedno źródło do eksperymentu: `n8n-mcp` albo `n8n-as-code`,
- dodać adapter za feature flagą:

```bash
N8N_EXTERNAL_KNOWLEDGE_PROVIDER=none|n8n-mcp|n8n-as-code
```

### Integracja docelowa

Dodać tool:

```txt
architect.lookup_node_schema
```

Kolejność:

1. lokalny `node-registry.ts`,
2. n8n-mcp / n8n-as-code, jeśli włączone,
3. fallback do `_skills/n8n-node-catalog.md`.

Dodać tool:

```txt
architect.search_template_examples
```

Zwraca tylko przykłady i reasoning context, nie workflow do deploya.

### Acceptance criteria

- Agent może sprawdzić schema node'a zamiast zgadywać.
- Zewnętrzny template nie jest deployowany bez przejścia przez własny validator.
- System działa bez internetu i bez zewnętrznego providera, używając lokalnych patternów.

## 15. Etap 10 - prompt update

### Pliki

```txt
src/mastra/prompts/automation/base.md
src/mastra/prompts/meta/base.md
```

### Automation prompt

Dodać zasady:

- Zawsze zacznij od `architect.runtime_check`.
- Legacy workflowy Jarvisa są read-only, chyba że użytkownik jawnie poprosi o admin migration.
- Nie używaj raw `n8n.update_workflow` ani raw `n8n.activate_workflow`.
- Workflow tworzony przez Architecta musi być `mastra-managed`.
- Nie używaj `localhost:3000` w nowych workflowach Mastry.
- Przy obecnym n8n `network_mode: host` używaj:
  - Mastra API: `http://localhost:4111`
  - Ollama: `http://localhost:11434`
  - Mongo: `localhost:27017`
- Brak required input/credential/runtime config zatrzymuje pipeline jako `missingConfig`, nie generuje placeholdera.
- Nie aktywuj workflowów public webhook / write / send bez activation policy.

### Meta prompt

Dodać:

- Automatyzacje n8n deleguj do `automationArchitect`.
- Do statusu legacy workflowów używaj tylko read tools.
- Nie próbuj tworzyć raw n8n JSON w odpowiedzi.

### Acceptance criteria

- Prompt opisuje aktualną architekturę Mastry, nie starego dashboardu.
- Prompt nie sugeruje `localhost:3000`.
- Meta-agent ma wyraźny zakaz samodzielnego raw update/activate.

## 16. Etap 11 - storage i audit trail

### Kolekcje Mongo

#### `automation_requests`

```ts
{
  id: string;
  userRequest: string;
  status: AutomationStatus;
  spec?: AutomationSpec;
  selectedPatternId?: string;
  n8nWorkflowId?: string;
  workflowName?: string;
  risk?: RiskScoreResult;
  validation?: ValidationResult;
  missingConfig?: MissingConfig[];
  missingCredentials?: MissingCredential[];
  createdAt: string;
  updatedAt: string;
}
```

#### `automation_events`

```ts
{
  id: string;
  automationId: string;
  type:
    | 'requested'
    | 'runtime_checked'
    | 'pattern_matched'
    | 'composed'
    | 'validated'
    | 'risk_scored'
    | 'draft_created'
    | 'test_run'
    | 'repair_attempt'
    | 'approval_requested'
    | 'activated'
    | 'blocked';
  data: unknown;
  createdAt: string;
}
```

#### `automation_workflow_snapshots`

```ts
{
  id: string;
  automationId: string;
  n8nWorkflowId?: string;
  version: number;
  workflowJson: unknown;
  validation: ValidationResult;
  risk: RiskScoreResult;
  createdAt: string;
}
```

### Init DB

Zaktualizować:

```txt
src/mastra/scripts/init-db.ts
```

Indeksy:

```ts
automation_requests: { id: 1 } unique, { status: 1 }, { n8nWorkflowId: 1 }
automation_events: { automationId: 1, createdAt: -1 }
automation_workflow_snapshots: { automationId: 1, version: -1 }
```

### Acceptance criteria

- Każdy draft ma `automationId`.
- Każdy deploy ma snapshot.
- Każdy block ma event z powodem.

## 17. Etap 12 - testy i skrypty weryfikacyjne

Projekt nie ma obecnie normalnego test runnera. Na start wystarczą skrypty `tsx`, potem można dodać Vitest.

### Skrypty

Dodać do `package.json`:

```json
{
  "scripts": {
    "check:automation-patterns": "npx tsx src/mastra/scripts/check-automation-patterns.ts",
    "check:n8n-runtime": "npx tsx src/mastra/scripts/check-n8n-runtime.ts",
    "check:automation": "npm run check:n8n-runtime && npm run check:automation-patterns"
  }
}
```

### `check-n8n-runtime.ts`

Sprawdza:

- n8n health,
- Mongo ping,
- Ollama tags,
- Mastra API reachable,
- public webhook URL configuration,
- credential env registry.

Nie wypisuje sekretów.

### `check-automation-patterns.ts`

Sprawdza wszystkie executable patterny.

### Manual E2E

Przypadek 1 - low risk:

```txt
Zbuduj testowy webhook n8n, który przyjmuje POST, waliduje pole "message"
i zwraca JSON { ok: true }.
```

Oczekiwane:

- runtime ok,
- pattern `webhook-validate-respond`,
- draft created inactive,
- validation ok,
- no missing credentials,
- activation może wymagać policy zależnie od public webhook.

Przypadek 2 - Telegram:

```txt
Zbuduj automatyzację, która raz dziennie wysyła mi testowy status na Telegram.
```

Oczekiwane:

- wykrywa required Telegram credential,
- jeśli credential configured: draft ok,
- jeśli credential missing: missing credentials, bez activation.

Przypadek 3 - unsafe:

```txt
Zbuduj workflow, który wykonuje komendę shell na serwerze.
```

Oczekiwane:

- block,
- no draft,
- event `risk_blocked`.

Przypadek 4 - missing URL:

```txt
Zbuduj monitor strony konkurencji.
```

Oczekiwane:

- system pyta o URL albo zwraca missingConfig,
- nie używa `https://example.com`.

### Acceptance criteria całości

- `npm run build` przechodzi.
- `npm run check:automation` przechodzi.
- Co najmniej 3 executable patterny przechodzą pełny draft path.
- Żaden workflow bez required credentiali nie przechodzi activation.
- Meta-agent nie może raw aktywować workflowa przez ToolSearch.

## 18. Kolejność implementacji

### Sprint 1 - fundament bezpieczeństwa

1. `runtime-topology.ts`
2. `architect.runtime_check`
3. usunięcie `localhost:3000` z builder defaults
4. naprawa `AutomationSpec.inputs`
5. smoke test inputów

Efekt: agent przestaje generować martwe endpointy i fallbacki.

### Sprint 2 - credentials i validator

1. credential registry/resolver
2. `telegramSendNode` z credentials
3. `architect.validate_workflow`
4. przeniesienie podstawowego validatora ze starego Jarvisa
5. skrypt `check-automation-patterns`

Efekt: workflow JSON jest importowalny i ma komplet podstawowych zależności.

### Sprint 3 - deploy i ownership

1. hardening `deploy_automation`
2. Mongo `automation_requests/events/snapshots`
3. ownership check
4. block update legacy workflowów
5. usunięcie raw update/activate z meta-agent pool

Efekt: Mastra nie psuje legacy workflowów i nie omija guardraili.

### Sprint 4 - activation i test loop

1. `architect.activate_automation`
2. activation policy
3. `architect.test_workflow`
4. execution analyzer
5. repair loop max 3

Efekt: system potrafi przejść od draftu do aktywnego workflowa, jeśli policy pozwala.

### Sprint 5 - external knowledge

1. ocena `n8n-mcp` vs `n8n-as-code` na lokalnym środowisku,
2. feature flag dla zewnętrznego providera,
3. `architect.lookup_node_schema`,
4. `architect.search_template_examples`,
5. aktualizacja `_skills/n8n`.

Efekt: agent ma dużo większą wiedzę o node'ach bez ryzyka deployowania losowych templatek.

## 19. Szczegóły refaktoru plików

### `src/mastra/agents/meta-agent.ts`

Zmiana:

- usunąć z ToolSearch pool:
  - `n8nUpdateWorkflowTool`
  - `n8nActivateWorkflowTool`
  - `n8nDeactivateWorkflowTool`
- zostawić:
  - `n8nHealthTool`
  - `n8nListWorkflowsTool`
  - `n8nGetWorkflowTool`
  - opcjonalnie `n8nTriggerWebhookTool`

### `src/mastra/agents/automation-architect.ts`

Dodać tools:

- `runtimeCheckTool`
- `validateWorkflowTool`
- `resolveCredentialsTool`
- `activateAutomationTool`
- `testWorkflowTool`

Rozważyć usunięcie raw:

- `n8nUpdateWorkflowTool`
- `n8nActivateWorkflowTool`
- `n8nDeactivateWorkflowTool`

Jeżeli zostają, opisać je jako admin-only i nie pokazywać w prompt Golden Path.

### `src/mastra/tools/architect/composer.ts`

Zmiany:

- zachować `value/defaultValue/source/aliases`,
- required values validation,
- blokada non-executable patterns,
- zwracanie `missingConfig`.

### `src/mastra/tools/architect/builders/helpers.ts`

Zmiany:

- użycie `getRuntimeTopology()`,
- credential resolver context,
- brak `localhost:3000`,
- required input helpers,
- utility do bezpiecznych URL-i.

### `src/mastra/tools/architect/deploy.ts`

Zmiany:

- samodzielne validation + risk,
- ownership check,
- snapshot,
- active false,
- no trust in model-provided risk.

### `src/mastra/prompts/automation/base.md`

Zmiany:

- nowy Golden Path z runtime_check, validate, credentials, activation_policy,
- legacy read-only,
- lokalna topologia.

## 20. Proponowany nowy Golden Path w promptcie

```txt
1. architect.runtime_check
2. n8n.health + n8n.list_workflows, tylko read-only
3. architect.match_pattern
4. architect.skills_search / architect.lookup_node_schema, jeśli pattern niepewny
5. przygotuj AutomationSpec z realnymi values albo missingConfig
6. architect.resolve_credentials
7. architect.compose_workflow
8. architect.validate_workflow(profile='draft')
9. architect.risk_score
10. architect.deploy_automation, tworzy inactive draft i snapshot
11. architect.test_workflow, jeśli możliwe
12. architect.activate_automation tylko jeśli activation policy pozwala
13. odpowiedz użytkownikowi: draft/test/active/missingConfig/blocked
```

## 21. Ryzyka i decyzje techniczne

### Ryzyko: za dużo patternów zewnętrznych obniży jakość

Nie zwiększać liczby executable patternów masowo. Każdy executable pattern musi mieć:

- builder,
- smoke test,
- validation pass,
- credential declaration,
- risk classification,
- testing strategy.

Duże repo z templates wykorzystać tylko jako corpus.

### Ryzyko: n8n API/wersja się zmienia

Trzymać node schema lokalnie i testować na aktualnie zainstalowanym n8n. Jeżeli dodamy n8n-mcp lub n8n-as-code, wersję zablokować w package managerze.

### Ryzyko: public webhook URL tunelu się zmienia

Nie utrwalać Cloudflare URL w patternach. Czytać z env/runtime check przy każdym compose/deploy.

### Ryzyko: lokalne modele źle planują

Nie przenosić `automationArchitect` na lokalny model na tym etapie. Krytyczny planning/deploy zostaje na Gemini Pro. Lokalne modele mogą pomagać w:

- klasyfikacji,
- streszczaniu execution logs,
- code node repair draft,
- ale validator i policy muszą być deterministyczne.

## 22. Definicja ukończenia

System można uznać za dojrzały w tej części, gdy:

1. Nowy workflow Mastry nigdy nie używa `localhost:3000`, `example.com`, pustych credentiali ani `$vars.*`.
2. Każdy workflow przechodzi `runtime_check`, `validate_workflow`, `risk_score`.
3. Deploy sam przelicza validation/risk i nie ufa modelowi.
4. Legacy workflowy nie są edytowane przez Architecta.
5. Meta-agent nie ma raw n8n admin tools w normalnej puli.
6. Activation przechodzi tylko przez `architect.activate_automation`.
7. Brak inputu/credentiala/runtime config daje `missingConfig`, a nie ciche fallbacki.
8. Są skrypty:
   - `check:n8n-runtime`
   - `check:automation-patterns`
   - `check:automation`
9. Co najmniej 3 workflowy testowe przechodzą end-to-end:
   - webhook validate/respond,
   - scheduled health monitor,
   - scheduled Telegram status.
10. Unsafe workflow z shell/SSH/filesystem jest blokowany przed draftem.

## 23. Źródła i inspiracje

Te źródła nie są runtime dependency w MVP. Służą jako uzasadnienie kierunku:

- `czlonkowski/n8n-mcp` - MCP z node docs, schema, examples, templates i walidacją: https://github.com/czlonkowski/n8n-mcp
- dokumentacja walidacji `n8n-mcp`: https://www.n8n-mcp.com/docs/validation
- `czlonkowski/n8n-skills` - skill pack procesowy dla budowania workflowów n8n: https://github.com/czlonkowski/n8n-skills
- `EtienneLescot/n8n-as-code` - schema/ontology, TypeScript workflows, GitOps i walidacja: https://github.com/EtienneLescot/n8n-as-code
- oficjalne n8n REST API i auth: https://docs.n8n.io/api/ oraz https://docs.n8n.io/api/authentication/
- oficjalne n8n MCP tools reference: https://docs.n8n.io/advanced-ai/mcp/mcp_tools_reference/
