# Automation Architect dla AgentForge - pełny plan implementacji

## 1. Decyzja architektoniczna

Rekomendowany wariant:

```text
Automation Architect jako osobny moduł w tym samym repo AgentForge
+
własna kolejka / worker
+
własne endpointy API
+
własny risk engine i storage
+
Meta Agent dostaje do niego kontrolowany tool / endpoint
```

Nie budujemy tego jako kodu wrzuconego bezpośrednio do Meta Agenta.  
Nie budujemy też na tym etapie jako całkowicie osobnej aplikacji z osobnym repo, osobnym auth, osobną bazą i osobnym dashboardem.

Najlepszy model na teraz:

```text
Modular monolith + osobny worker
```

Czyli:

```text
/projekty/jarvis-dashboard-agent
  packages/
    automation-architect/
  workers/
    automation-architect-worker.ts
  api/
    automations/*
```

## 2. Dlaczego tak

### 2.1. Dlaczego nie wbudowywać tego bezpośrednio w Meta Agenta

Meta Agent powinien być koordynatorem, a nie systemem, który bezpośrednio:

```text
- generuje n8n JSON
- aktywuje workflow
- przechowuje N8N_API_KEY
- testuje execution logs
- zarządza approval flow
- klasyfikuje ryzyko samym promptem
- modyfikuje automatyzacje produkcyjne
```

Gdyby wszystko wrzucić do Meta Agenta, powstanie monolit logiczny trudny do testowania i niebezpieczny operacyjnie.

Ryzyka:

```text
- większa powierzchnia błędów
- trudniejsze debugowanie
- większy prompt
- większa szansa halucynacji
- trudniejsza walidacja
- trudniejsze testy jednostkowe
- ryzyko, że agent ominie approval
- trudniejsze późniejsze wydzielenie modułu jako produktu
```

### 2.2. Dlaczego nie robić osobnej aplikacji od razu

Masz już działającą infrastrukturę:

```text
- Dashboard: http://localhost:3000
- n8n: http://localhost:5678
- Redis / BullMQ
- MongoDB
- Agent Worker
- Ollama
- Cloudflare tunnel
```

Osobna aplikacja wymusiłaby duplikację:

```text
- osobny auth
- osobny storage
- osobny dashboard
- osobny logging
- osobne kolejki
- osobne deployment scripts
- osobne permissiony
```

To byłoby za wcześnie.

## 3. Cel końcowy

Użytkownik wpisuje w AgentForge:

```text
Zbuduj automatyzację, która codziennie rano sprawdza blog konkurencji i jeśli znajdzie słowo GastroBridge, wysyła mi alert na Telegram.
```

System robi:

```text
User request
  ↓
Meta Agent
  ↓
Automation Architect tool
  ↓
AutomationSpec
  ↓
RiskReport
  ↓
WorkflowPlan
  ↓
n8n workflow draft
  ↓
Validation
  ↓
Create inactive workflow in local n8n
  ↓
Test
  ↓
Execution analysis
  ↓
Approval
  ↓
Activation
  ↓
Monitoring
```

Efekt końcowy:

```text
Meta Agent potrafi zlecić budowę automatyzacji,
ale nie ma bezpośredniego prawa do tworzenia i aktywowania dowolnych workflow.
```

## 4. Podział odpowiedzialności

### 4.1. Meta Agent

Meta Agent robi:

```text
- rozpoznaje, że request dotyczy automatyzacji
- przekazuje request do Automation Architecta
- tłumaczy użytkownikowi wynik
- pyta użytkownika o approval
- koordynuje inne agenty
```

Meta Agent nie robi:

```text
- nie generuje raw n8n JSON
- nie trzyma N8N_API_KEY
- nie aktywuje workflow bezpośrednio
- nie omija risk engine
- nie modyfikuje workflow produkcyjnych bez approval
```

### 4.2. Automation Architect

Automation Architect robi:

```text
- buduje AutomationSpec
- wybiera pattern
- liczy risk score
- generuje workflow n8n
- waliduje workflow
- tworzy inactive draft w n8n
- uruchamia testy
- czyta execution logs
- proponuje poprawki
- wymusza approval
- aktywuje workflow dopiero po zgodzie
- monitoruje execution errors
```

### 4.3. Dashboard

Dashboard robi:

```text
- pokazuje request użytkownika
- pokazuje AutomationSpec
- pokazuje RiskReport
- pokazuje WorkflowPlan
- pokazuje status draftu n8n
- pokazuje testy
- pokazuje błędy
- obsługuje Approve / Reject
```

### 4.4. n8n

n8n robi:

```text
- przechowuje workflow
- przechowuje credentials
- wykonuje workflow
- zapisuje executions
- obsługuje webhooki
```

n8n nie jest mózgiem. Jest execution engine.

## 5. Architektura docelowa

```text
AgentForge Dashboard
  ↓
Meta Agent
  ↓
Automation Architect Tool/API
  ↓
Automation Architect Worker
  ├── Intent Parser
  ├── AutomationSpec Builder
  ├── Risk Engine
  ├── Pattern Library
  ├── Workflow Generator
  ├── Workflow Validator
  ├── Approval Gate
  ├── Test Runner
  └── Execution Monitor
        ↓
      n8n Client
        ↓
      Local n8n API
```

## 6. Struktura katalogów

Dodać nowy pakiet:

```text
/projekty/jarvis-dashboard-agent/packages/automation-architect
```

Proponowana struktura:

```text
packages/automation-architect/
  package.json
  tsconfig.json
  src/
    index.ts
    service.ts

    types/
      AutomationRequest.ts
      AutomationSpec.ts
      WorkflowPlan.ts
      RiskReport.ts
      Approval.ts
      N8nWorkflow.ts
      TestRun.ts
      ExecutionSnapshot.ts

    core/
      normalizeUserRequest.ts
      classifyAutomationIntent.ts
      buildAutomationSpec.ts
      selectAutomationPattern.ts
      buildWorkflowPlan.ts
      generateWorkflow.ts
      validateGeneratedWorkflow.ts
      createDraftWorkflow.ts
      activateAutomationWorkflow.ts

    risk/
      scoreRisk.ts
      scoreRiskFromWorkflow.ts
      riskRules.ts
      forbiddenNodes.ts
      approvalPolicy.ts

    patterns/
      index.ts
      patternSchema.ts
      scheduleHttpIfTelegram.ts
      rssToTelegram.ts
      webhookToGoogleSheet.ts
      gmailReadToDraft.ts
      telegramCommandToQueue.ts
      competitorMonitoring.ts

    n8n/
      n8nClient.ts
      n8nRestClient.ts
      n8nMcpClient.ts
      n8nTypes.ts
      n8nWorkflowMapper.ts
      n8nExecutionParser.ts
      n8nCredentialPolicy.ts

    testing/
      createMockData.ts
      runWorkflowTest.ts
      analyzeExecution.ts
      proposeFixes.ts

    approvals/
      createApprovalRequest.ts
      resolveApproval.ts
      approvalStore.ts

    storage/
      automationStore.ts
      mongoAutomationStore.ts

    prompts/
      automationArchitect.system.ts
      automationSpec.prompt.ts
      workflowPlan.prompt.ts
      executionDebug.prompt.ts

    utils/
      ids.ts
      logger.ts
      safeJson.ts
      redactSecrets.ts

  patterns/
    rss-to-telegram.json
    schedule-http-if-telegram.json
    webhook-to-google-sheet.json
    lead-research-to-crm-draft.json

  tests/
    buildAutomationSpec.test.ts
    scoreRisk.test.ts
    selectPattern.test.ts
    generateWorkflow.test.ts
    validateGeneratedWorkflow.test.ts
    n8nRestClient.test.ts
```

## 7. Environment variables

Dodać do `.env`:

```env
N8N_BASE_URL=http://localhost:5678
N8N_API_KEY=replace_me
N8N_PUBLIC_WEBHOOK_BASE_URL=https://replace-me.trycloudflare.com

AUTOMATION_ARCHITECT_ENABLED=true
AUTOMATION_ARCHITECT_DRY_RUN_DEFAULT=true
AUTOMATION_ARCHITECT_REQUIRE_APPROVAL=true

AUTOMATION_ALLOW_MCP=false
N8N_MCP_URL=http://localhost:5678/mcp
N8N_MCP_TOKEN=replace_me_optional

AUTOMATION_MAX_FIX_ATTEMPTS=3
AUTOMATION_DEFAULT_TIMEZONE=Atlantic/Reykjavik

AUTOMATION_BLOCK_EXECUTE_COMMAND=true
AUTOMATION_BLOCK_FILE_SYSTEM=true
AUTOMATION_BLOCK_SSH=true
AUTOMATION_BLOCK_PRODUCTION_DB_WRITES=true
AUTOMATION_BLOCK_MASS_EMAIL=true
```

Zasady:

```text
- N8N_API_KEY nigdy nie trafia do prompta LLM
- tokeny nie mogą być logowane
- raw secrets nie mogą być przechowywane w AutomationSpec
- credentials powinny być trzymane w n8n
```

## 8. Audyt lokalnego n8n przed implementacją

Dev zaczyna od sprawdzenia środowiska.

### 8.1. Wersja n8n

```bash
docker exec -it af-n8n n8n --version
```

Zapisać wynik w:

```text
docs/automation-architect/n8n-local-audit.md
```

### 8.2. Persistent volume

```bash
docker inspect af-n8n | grep -A 30 Mounts
```

Sprawdzić, czy istnieje mount:

```text
/home/node/.n8n
```

Jeżeli nie ma, trzeba poprawić docker-compose. Bez persistent volume można stracić workflow, credentials albo encryption key.

### 8.3. API access

W n8n utworzyć API key:

```text
Settings → n8n API → Create API key
```

Test:

```bash
curl -sS \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_BASE_URL/api/v1/workflows" \
  | python3 -m json.tool
```

Jeżeli to nie działa, nie zaczynać generatora workflow.

## 9. Główne typy danych

### 9.1. AutomationRequest

```ts
export type AutomationRequest = {
  id: string;
  userId?: string;
  source: "dashboard" | "cli" | "telegram" | "api";
  rawText: string;
  createdAt: string;
  timezone?: string;
  context?: {
    project?: string;
    existingWorkflowId?: string;
    preferredServices?: string[];
    forbiddenServices?: string[];
  };
};
```

### 9.2. AutomationSpec

```ts
export type AutomationSpec = {
  id: string;
  name: string;
  description: string;
  goal: string;

  trigger: {
    type: "manual" | "schedule" | "webhook" | "email" | "external_event";
    schedule?: {
      frequency: "once" | "hourly" | "daily" | "weekly" | "monthly";
      time?: string;
      timezone: string;
      cron?: string;
    };
    webhook?: {
      method: "GET" | "POST";
      expectedPayloadDescription: string;
    };
  };

  inputs: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "url" | "secret" | "json";
    required: boolean;
    description: string;
  }>;

  steps: Array<{
    id: string;
    name: string;
    purpose: string;
    actionType:
      | "read"
      | "transform"
      | "condition"
      | "notify"
      | "write"
      | "send"
      | "delete"
      | "execute";
    expectedInput: string;
    expectedOutput: string;
    failureBehavior: "stop" | "continue" | "retry" | "notify_user";
  }>;

  externalServices: string[];

  credentialsNeeded: Array<{
    service: string;
    credentialName?: string;
    required: boolean;
    notes?: string;
  }>;

  dataPolicy: {
    readsExternalData: boolean;
    writesExternalData: boolean;
    sendsMessages: boolean;
    touchesCustomerData: boolean;
    touchesProductionDb: boolean;
    usesPaidApi: boolean;
    usesFileSystem: boolean;
    usesShellCommand: boolean;
  };

  successCriteria: string[];

  riskLevel: "low" | "medium" | "high" | "critical";
  requiresApproval: boolean;
};
```

### 9.3. RiskReport

```ts
export type RiskReport = {
  automationSpecId: string;
  level: "low" | "medium" | "high" | "critical";
  score: number;
  reasons: string[];
  blocked: boolean;
  requiredApprovals: Array<
    | "create_draft"
    | "test_with_mock_data"
    | "test_with_real_credentials"
    | "activate_workflow"
    | "send_external_message"
    | "write_production_data"
  >;
  forbiddenActionsDetected: string[];
};
```

### 9.4. WorkflowPlan

```ts
export type WorkflowPlan = {
  id: string;
  automationSpecId: string;
  selectedPatternId?: string;
  n8nNodes: Array<{
    id: string;
    type: string;
    displayName: string;
    purpose: string;
    credentialsRequired?: string[];
    riskTags?: string[];
  }>;
  connections: Array<{
    from: string;
    to: string;
    condition?: string;
  }>;
  missingConfig: Array<{
    key: string;
    description: string;
    required: boolean;
  }>;
};
```

### 9.5. BuildResult

```ts
export type BuildResult = {
  workflowId?: string;
  workflowName: string;
  status: "draft_created" | "validation_failed" | "blocked" | "error";
  n8nWorkflowJson?: unknown;
  validationErrors?: string[];
  warnings?: string[];
};
```

### 9.6. TestRun

```ts
export type TestRun = {
  id: string;
  workflowId: string;
  mode: "mock" | "manual" | "real_credentials";
  status: "pending" | "running" | "success" | "failed";
  executionId?: string;
  startedAt: string;
  finishedAt?: string;
  errorSummary?: string;
  nodeResults?: Array<{
    nodeName: string;
    status: "success" | "failed" | "skipped";
    error?: string;
  }>;
};
```

## 10. Risk engine

Risk engine musi być deterministyczny. Nie może zależeć wyłącznie od LLM.

### 10.1. Low risk

```text
- public RSS read
- public website read
- data transform
- local draft
- manual trigger
- mock test
```

### 10.2. Medium risk

```text
- Telegram notification do właściciela
- Slack/Discord notification do właściciela
- Google Sheet update w testowym arkuszu
- Notion update
- internal webhook
- Gmail read
```

### 10.3. High risk

```text
- wysyłanie emaili
- publikacja postów
- zapis do CRM
- update danych klientów
- płatne API
- real credentials test
- HTTP request do produkcyjnego API
```

### 10.4. Critical risk

```text
- Execute Command
- SSH
- filesystem read/write
- kasowanie danych
- modyfikacja produkcyjnej bazy
- masowa wysyłka emaili
- płatności
- faktury
- credentials management
```

### 10.5. Forbidden nodes na MVP

```ts
export const FORBIDDEN_NODE_TYPES = [
  "n8n-nodes-base.executeCommand",
  "n8n-nodes-base.ssh",
  "n8n-nodes-base.ftp",
  "n8n-nodes-base.readWriteFile",
  "n8n-nodes-base.microsoftSql",
  "n8n-nodes-base.postgres",
  "n8n-nodes-base.mySql",
  "n8n-nodes-base.mongoDb",
];
```

Na MVP blokujemy też:

```text
- masową wysyłkę emaili
- direct production DB writes
- faktury
- płatności
- public social posting
```

### 10.6. Approval policy

```ts
export const APPROVAL_POLICY = {
  low: ["create_draft"],
  medium: ["create_draft", "activate_workflow"],
  high: [
    "create_draft",
    "test_with_real_credentials",
    "activate_workflow",
  ],
  critical: ["manual_review_required"],
};
```

Critical domyślnie:

```ts
blocked: true
```

## 11. Pattern library

Agent nie powinien budować automatyzacji od zera, jeśli istnieje wzorzec.

### 11.1. Pattern schema

```ts
export type AutomationPattern = {
  id: string;
  name: string;
  description: string;
  useCases: string[];
  riskLevel: "low" | "medium" | "high" | "critical";

  requiredInputs: Array<{
    key: string;
    type: string;
    description: string;
    required: boolean;
  }>;

  requiredCredentials: string[];

  nodes: Array<{
    logicalName: string;
    n8nType: string;
    purpose: string;
    configurableFields: string[];
  }>;

  connections: Array<{
    from: string;
    to: string;
  }>;

  commonFailures: string[];

  testStrategy: string[];

  blockedUnlessApproved: boolean;
};
```

### 11.2. MVP patterns

#### Pattern 1: Schedule → HTTP → IF → Telegram

Use case:

```text
monitoring strony, API albo bloga i alert, jeśli warunek jest spełniony
```

#### Pattern 2: RSS → Filter → Telegram

Use case:

```text
monitoring blogów, newsów, changelogów, konkurencji
```

#### Pattern 3: Webhook → Normalize → Google Sheet

Use case:

```text
przyjmowanie leadów albo formularzy i zapis do tabeli
```

#### Pattern 4: Gmail Read → LLM classify → Draft response

Use case:

```text
triage maili, ale bez automatycznego wysyłania
```

#### Pattern 5: Telegram Command → AgentForge Queue

Use case:

```text
wysyłasz wiadomość do bota Telegram, a on wrzuca zadanie do BullMQ
```

#### Pattern 6: Competitor Monitor

Use case:

```text
monitoring wybranych URL/RSS pod kątem keywordów i wysyłanie raportu
```

## 12. n8n client

### 12.1. Interfejs

```ts
export interface N8nClient {
  healthCheck(): Promise<boolean>;

  listWorkflows(): Promise<N8nWorkflowSummary[]>;

  getWorkflow(workflowId: string): Promise<N8nWorkflow>;

  createWorkflow(input: {
    name: string;
    nodes: unknown[];
    connections: unknown;
    active?: boolean;
    tags?: string[];
  }): Promise<{ workflowId: string }>;

  updateWorkflow(input: {
    workflowId: string;
    patch: unknown;
  }): Promise<void>;

  activateWorkflow(workflowId: string): Promise<void>;

  deactivateWorkflow(workflowId: string): Promise<void>;

  listExecutions(input: {
    workflowId?: string;
    limit?: number;
    status?: "success" | "error" | "waiting";
  }): Promise<N8nExecutionSummary[]>;

  getExecution(executionId: string): Promise<N8nExecutionDetails>;
}
```

### 12.2. REST client

Plik:

```text
src/n8n/n8nRestClient.ts
```

Zasady:

```text
- używać N8N_BASE_URL
- używać X-N8N-API-KEY
- timeout dla każdego requestu
- retry tylko dla 5xx albo network error
- nigdy nie logować API key
- wszystkie odpowiedzi mapować na własne typy
```

### 12.3. MCP client jako opcja później

MCP może zostać dodane później jako enhancement:

```text
- search_nodes
- get_node_types
- validate_workflow
- create_workflow_from_code
- test_workflow
```

Ale MVP nie powinno zależeć od MCP.

## 13. Workflow generation

### 13.1. Zasada główna

Nie generujemy bezpośrednio workflow z tekstu użytkownika.

Prawidłowy flow:

```text
User request
  ↓
AutomationSpec
  ↓
RiskReport
  ↓
Pattern selection
  ↓
WorkflowPlan
  ↓
Generated n8n workflow
  ↓
Static validation
  ↓
Risk validation from generated workflow
  ↓
Create inactive draft
```

### 13.2. Generator MVP

Na start obsłużyć tylko jeden wzorzec:

```text
schedule-http-if-telegram
```

Nie próbować od razu obsługiwać całego n8n.

Pierwszy generator ma umieć:

```text
- Schedule Trigger
- HTTP Request albo RSS Read
- IF / Code filter
- Telegram notification
```

### 13.3. Zawsze tworzyć inactive workflow

```ts
active: false
```

To ma być wymuszone w backendzie, nie tylko w promptach.

### 13.4. Naming convention

Draft:

```text
AF Draft - <name>
```

Active:

```text
AF Active - <name>
```

Tagi:

```text
agentforge
automation-architect
risk-low / risk-medium / risk-high
created-by-meta-agent
```

## 14. Walidacja workflow

### 14.1. Static validation

Sprawdzać:

```text
- workflow ma minimum 2 node’y
- workflow ma trigger
- każdy node ma unikalną nazwę
- connections wskazują istniejące node’y
- nie ma forbidden node types
- workflow.active === false przy tworzeniu
- nie ma raw secrets
- URL-e nie są puste
- Telegram node nie ma pustego chatId
- Schedule ma timezone
```

### 14.2. Risk validation po wygenerowaniu

Po wygenerowaniu workflow liczymy risk jeszcze raz na podstawie realnych node’ów.

```ts
const specRisk = scoreRisk(spec);
const workflowRisk = scoreRiskFromWorkflow(workflow);

if (workflowRisk.level > specRisk.level) {
  requireNewApproval();
}
```

## 15. Approval system

### 15.1. ApprovalRequest

```ts
export type ApprovalRequest = {
  id: string;
  automationSpecId: string;
  workflowId?: string;
  action:
    | "create_draft"
    | "test_with_mock_data"
    | "test_with_real_credentials"
    | "activate_workflow"
    | "send_external_message"
    | "write_production_data";
  riskLevel: RiskLevel;
  summary: string;
  details: unknown;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
};
```

### 15.2. Approval musi być wymuszony w backendzie

Nie wystarczy przycisk w UI.

```ts
if (!approvalStore.hasApproved(workflowId, "activate_workflow")) {
  throw new Error("Activation requires explicit approval.");
}
```

### 15.3. Approval card w UI

Pokazać:

```text
- nazwa automatyzacji
- trigger
- node’y
- credentials
- risk level
- co zostanie wykonane po kliknięciu Approve
- czego workflow nie zrobi
- przyciski Approve / Reject / Edit Request
```

Przykład tekstu:

```text
Action:
Activate workflow

Risk:
Medium

This will:
- run every day at 08:00
- fetch public RSS URL
- send Telegram message to your private chat if match is found

This will not:
- send emails
- write to production database
- contact customers
- execute shell commands
```

## 16. Testowanie workflow

### 16.1. Tryby testu

#### Mock test

```text
- bez realnych credentiali
- z fake input data
- bez realnej wysyłki
```

#### Manual test

```text
- workflow inactive
- uruchomiony kontrolowanie
- execution log czytany po teście
```

#### Real credentials test

```text
- tylko po approval
- Telegram może wysłać wiadomość testową do prywatnego chatu właściciela
- Gmail może tworzyć draft, ale nie wysyłać maila
- Google Sheet może pisać tylko do testowego arkusza
```

### 16.2. Test runner

```ts
export async function runWorkflowTest(input: {
  workflowId: string;
  mode: "mock" | "manual" | "real_credentials";
  mockData?: Record<string, unknown>;
}): Promise<TestRun>;
```

### 16.3. Execution analyzer

Po teście pobrać execution log i wyciągnąć:

```text
- status
- failed node
- error message
- likely cause
- suggested fix
```

Typ:

```ts
export type ExecutionAnalysis = {
  success: boolean;
  failedNode?: string;
  errorMessage?: string;
  likelyCause?: string;
  suggestedFix?: string;
  rawExecutionId: string;
};
```

## 17. Debug loop

Agent może poprawiać workflow po błędzie, ale z limitem.

```env
AUTOMATION_MAX_FIX_ATTEMPTS=3
```

Flow:

```text
test failed
  ↓
execution analysis
  ↓
LLM proposes fix
  ↓
static validation
  ↓
risk validation
  ↓
update inactive workflow
  ↓
test again
```

Po 3 nieudanych próbach:

```text
- stop
- pokaż błąd użytkownikowi
- nie próbuj dalej automatycznie
```

## 18. Credential policy

Zasady:

```text
- LLM nigdy nie widzi sekretów
- N8N_API_KEY istnieje tylko w backendzie
- credentials n8n tworzone ręcznie przez użytkownika w n8n
- agent może poprosić o nazwę credential, ale nie o token
- logi muszą redagować tokeny, URL-e z sekretami, bearer tokens
```

Credential aliases:

```ts
export const CREDENTIAL_ALIASES = {
  telegram_personal_bot: {
    service: "Telegram",
    n8nCredentialName: "AgentForge Telegram Bot",
    allowedUse: ["notify_owner"],
  },
  google_sheets_test: {
    service: "Google Sheets",
    n8nCredentialName: "AgentForge Google Sheets Test",
    allowedUse: ["test_write"],
  },
};
```

Jeżeli brakuje credentiali:

```text
- utworzyć workflow draft bez aktywacji
- oznaczyć missing credentials
- pokazać instrukcję dla użytkownika
- nie pytać o token w czacie
```

## 19. BullMQ

Dodać nową kolejkę:

```text
agent-tasks-automation-architect
```

Typy tasków:

```ts
type AutomationArchitectTask =
  | { type: "automation.build_spec"; payload: AutomationRequest }
  | { type: "automation.create_draft"; payload: { automationId: string } }
  | { type: "automation.test"; payload: { workflowId: string } }
  | { type: "automation.activate"; payload: { workflowId: string } }
  | { type: "automation.monitor"; payload: { workflowId: string } };
```

Dlaczego osobna kolejka:

```text
- build/test workflow może trwać długo
- nie blokuje Meta Agenta
- łatwiejszy retry
- łatwiejsze monitorowanie
- łatwiejsze skalowanie później
```

## 20. MongoDB storage

Dodać kolekcje:

```text
automation_requests
automation_specs
automation_workflow_plans
automation_builds
automation_approvals
automation_test_runs
automation_execution_snapshots
automation_events
```

### 20.1. automation_requests

```json
{
  "_id": "auto_req_001",
  "rawText": "Zbuduj workflow...",
  "source": "dashboard",
  "status": "received",
  "createdAt": "2026-04-30T00:00:00.000Z"
}
```

### 20.2. automation_specs

```json
{
  "_id": "auto_spec_001",
  "requestId": "auto_req_001",
  "name": "Competitor RSS Monitor",
  "riskLevel": "medium",
  "requiresApproval": true,
  "spec": {}
}
```

### 20.3. automation_builds

```json
{
  "_id": "auto_build_001",
  "specId": "auto_spec_001",
  "n8nWorkflowId": "abc123",
  "status": "draft_created",
  "createdAt": "2026-04-30T00:00:00.000Z"
}
```

### 20.4. automation_approvals

```json
{
  "_id": "approval_001",
  "workflowId": "abc123",
  "action": "activate_workflow",
  "status": "pending",
  "riskLevel": "medium",
  "createdAt": "2026-04-30T00:00:00.000Z"
}
```

## 21. Dashboard UI

Dodać sekcję:

```text
AgentForge Dashboard → Automations
```

### 21.1. Lista automatyzacji

Tabela:

```text
Name | Status | Risk | n8n Workflow | Created | Actions
```

Statusy:

```text
received
spec_created
awaiting_approval
draft_created
testing
test_failed
test_passed
active
blocked
rejected
```

### 21.2. Szczegóły automatyzacji

Sekcje:

```text
1. User request
2. AutomationSpec
3. RiskReport
4. WorkflowPlan
5. n8n draft link
6. Missing credentials
7. Test runs
8. Execution logs
9. Approval actions
```

### 21.3. Akcje UI

```text
- Build Spec
- Create Draft
- Run Mock Test
- Run Real Test
- Approve Activation
- Reject
- Activate
- Deactivate
- View in n8n
```

## 22. Endpointy API

Dodać:

```text
POST   /api/automations/request
GET    /api/automations
GET    /api/automations/:id
POST   /api/automations/:id/build-spec
POST   /api/automations/:id/create-draft
POST   /api/automations/:id/test
POST   /api/automations/:id/approve
POST   /api/automations/:id/reject
POST   /api/automations/:id/activate
POST   /api/automations/:id/deactivate
GET    /api/automations/:id/executions
```

Przykład requestu:

```json
{
  "rawText": "Zbuduj workflow, który codziennie rano sprawdza blog konkurencji i wysyła alert na Telegram jeśli pojawi się GastroBridge.",
  "timezone": "Atlantic/Reykjavik"
}
```

## 23. Tool dla Meta Agenta

Meta Agent powinien dostać jeden kontrolowany tool:

```ts
type AutomationArchitectToolInput = {
  action:
    | "create_spec"
    | "score_risk"
    | "create_draft"
    | "test"
    | "activate"
    | "status";
  payload: unknown;
};
```

Meta Agent nie dostaje bezpośrednio:

```text
- N8N_API_KEY
- n8n.createWorkflow(rawJson)
- n8n.activateWorkflow()
- n8n.updateWorkflow(rawJson)
```

Dostaje tylko bezpieczny interfejs:

```text
automationArchitectTool(...)
```

## 24. Prompt systemowy Automation Architecta

Plik:

```text
src/prompts/automationArchitect.system.ts
```

Treść:

```text
You are Automation Architect Agent inside AgentForge.

Your job is to design safe, testable, local n8n automations.

You must never create a workflow directly from the user request.

Required process:
1. Convert the user request into AutomationSpec.
2. Identify trigger, steps, external services, credentials, data flow and failure modes.
3. Score risk using the deterministic risk policy.
4. Select an approved automation pattern when possible.
5. If using n8n MCP, fetch node definitions before generating workflow code.
6. If MCP is unavailable, use the local pattern library.
7. Generate workflow as inactive draft only.
8. Validate workflow before creating or updating it.
9. Never activate a workflow without explicit approval.
10. Never send emails, post publicly, write production data, delete data, execute shell commands, use SSH or file system access without explicit high-risk approval.
11. Never ask the user for raw secrets in chat.
12. If credentials are missing, produce setup instructions instead of asking for tokens.
13. After test failure, inspect execution logs and propose a minimal fix.
14. Stop after maximum allowed fix attempts.
```

## 25. CLI dla deva

Dodać komendy pomocnicze:

```bash
pnpm automation:health
pnpm automation:spec -- "Zbuduj workflow..."
pnpm automation:risk --spec ./tmp/spec.json
pnpm automation:generate --spec ./tmp/spec.json
pnpm automation:create-draft --workflow ./tmp/workflow.json
pnpm automation:test --workflowId abc123
```

To pozwala testować moduł bez klikania w UI.

## 26. Logowanie i audyt

Każda akcja powinna tworzyć event.

```ts
export type AutomationEvent = {
  id: string;
  automationId: string;
  type:
    | "request_received"
    | "spec_created"
    | "risk_scored"
    | "pattern_selected"
    | "workflow_generated"
    | "validation_failed"
    | "draft_created"
    | "approval_requested"
    | "approval_approved"
    | "approval_rejected"
    | "test_started"
    | "test_failed"
    | "test_passed"
    | "workflow_activated"
    | "workflow_deactivated";
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};
```

Logi nie mogą zawierać:

```text
- API keys
- bearer tokens
- raw credentials
- OAuth tokens
- prywatnych danych użytkowników
```

## 27. Fazy implementacji

### Phase 0 - Local n8n audit

Zadania:

```text
1. Sprawdzić wersję n8n.
2. Sprawdzić persistent volume.
3. Sprawdzić REST API.
4. Sprawdzić public webhook URL.
5. Zapisać wyniki w docs/automation-architect/n8n-local-audit.md.
```

Acceptance criteria:

```text
- wiadomo, jaka jest wersja n8n
- wiadomo, czy API działa
- wiadomo, czy dane n8n są persistent
- wiadomo, czy Cloudflare tunnel działa dla webhooków
```

### Phase 1 - n8n REST client

Zadania:

```text
1. Dodać package @af/automation-architect.
2. Dodać n8nRestClient.ts.
3. Zaimplementować healthCheck().
4. Zaimplementować listWorkflows().
5. Zaimplementować getWorkflow().
6. Zaimplementować createWorkflow().
7. Zaimplementować updateWorkflow().
8. Zaimplementować activateWorkflow().
9. Zaimplementować deactivateWorkflow().
10. Zaimplementować listExecutions().
11. Zaimplementować getExecution().
```

Acceptance criteria:

```text
- można pobrać listę workflow
- można stworzyć inactive test workflow
- można pobrać szczegóły workflow
- można pobrać executions
- API key nie pojawia się w logach
```

### Phase 2 - AutomationSpec

Zadania:

```text
1. Dodać typy AutomationRequest i AutomationSpec.
2. Dodać Zod schema.
3. Dodać buildAutomationSpec.ts.
4. Dodać prompt do generowania speca.
5. Dodać walidację outputu LLM.
6. Dodać fallback dla błędnego JSON.
```

Acceptance criteria:

```text
- request tekstowy tworzy poprawny AutomationSpec
- invalid JSON jest odrzucany
- spec zawiera trigger, steps, credentialsNeeded, dataPolicy, successCriteria
```

### Phase 3 - Risk engine

Zadania:

```text
1. Dodać riskRules.ts.
2. Dodać forbiddenNodes.ts.
3. Dodać scoreRisk.ts.
4. Dodać scoreRiskFromWorkflow.ts.
5. Dodać approvalPolicy.ts.
6. Dodać unit testy.
```

Acceptance criteria:

```text
- public RSS read = low
- Telegram notify owner = medium
- Gmail send = high
- Execute Command = critical blocked
- DB write = high albo critical
```

### Phase 4 - Pattern library

Zadania:

```text
1. Dodać patternSchema.ts.
2. Dodać minimum 6 patternów.
3. Dodać selectAutomationPattern.ts.
4. Dodać testy dopasowania.
```

Acceptance criteria:

```text
- request o RSS wybiera rss-to-telegram
- request o blog monitoring wybiera competitor-monitoring
- request o formularz wybiera webhook-to-google-sheet
- jeśli brak patternu, system nie generuje workflow
```

### Phase 5 - WorkflowPlan

Zadania:

```text
1. Dodać buildWorkflowPlan.ts.
2. Mapować AutomationSpec na node candidates.
3. Wykrywać missing config.
4. Wykrywać missing credentials.
5. Zapisywać plan w MongoDB.
```

Acceptance criteria:

```text
- plan pokazuje node’y
- plan pokazuje connections
- plan pokazuje brakujące dane
- plan pokazuje potrzebne credentials
```

### Phase 6 - Workflow generator

Zadania:

```text
1. Dodać generateWorkflow.ts.
2. Obsłużyć pattern schedule-http-if-telegram.
3. Obsłużyć Schedule Trigger.
4. Obsłużyć HTTP Request.
5. Obsłużyć IF albo Code filter.
6. Obsłużyć Telegram.
7. Dodać connections builder.
```

Acceptance criteria:

```text
- generated workflow ma active=false
- ma poprawne nodes
- ma poprawne connections
- nie ma raw secrets
- przechodzi validation
```

### Phase 7 - Create inactive draft

Zadania:

```text
1. Dodać createDraftWorkflow().
2. Wymusić active=false.
3. Dodać tagi.
4. Zapisać workflowId w MongoDB.
5. Pokazać link do n8n w dashboardzie.
```

Acceptance criteria:

```text
- workflow pojawia się w n8n UI
- jest inactive
- ma prefix AF Draft
- workflowId jest zapisane
```

### Phase 8 - Approval gate

Zadania:

```text
1. Dodać ApprovalRequest.
2. Dodać approvalStore.
3. Dodać endpoint approve/reject.
4. Dodać UI approval card.
5. Wymusić approval w backendzie.
```

Acceptance criteria:

```text
- medium wymaga approval przed activation
- high wymaga approval przed real credentials test i activation
- critical jest blocked
- aktywacja bez approval failuje
```

### Phase 9 - Test runner

Zadania:

```text
1. Dodać runWorkflowTest.ts.
2. Dodać createMockData.ts.
3. Dodać polling execution.
4. Dodać analyzeExecution.ts.
5. Dodać TestRun collection.
```

Acceptance criteria:

```text
- można uruchomić test
- system pobiera execution
- system wykrywa failed node
- system pokazuje błąd użytkownikowi
```

### Phase 10 - Debug loop

Zadania:

```text
1. Dodać executionDebug.prompt.ts.
2. Dodać proposeFixes.ts.
3. Dodać max 3 próby.
4. Dodać updateWorkflow po poprawce.
5. Dodać audit log zmian.
```

Acceptance criteria:

```text
- agent proponuje konkretną poprawkę
- update przechodzi validation
- risk jest liczony ponownie
- po 3 błędach system zatrzymuje się
```

### Phase 11 - Activation

Zadania:

```text
1. Dodać activateAutomationWorkflow().
2. Sprawdzić approval.
3. Sprawdzić ostatni test.
4. Aktywować przez n8n API.
5. Zmienić status w MongoDB.
6. Zmienić nazwę/tag z Draft na Active, jeśli API pozwala.
```

Acceptance criteria:

```text
- bez approval aktywacja failuje
- po approval workflow staje się active
- status w dashboardzie zmienia się na active
```

### Phase 12 - Monitoring

Zadania:

```text
1. Dodać scheduled monitor w workerze.
2. Pobierać executions dla workflow tworzonych przez AgentForge.
3. Wykrywać failed executions.
4. Tworzyć alert w dashboardzie.
5. Opcjonalnie wysłać Telegram alert do właściciela.
```

Acceptance criteria:

```text
- failed execution pokazuje się w dashboardzie
- system zna failed node
- system pokazuje error summary
```

### Phase 13 - MCP optional integration

Dodać później, nie w MVP.

Zadania:

```text
1. Dodać n8nMcpClient.ts.
2. Dodać feature flag AUTOMATION_ALLOW_MCP.
3. Dodać search_nodes, get_node_types, validate_workflow, test_workflow, jeśli dostępne.
4. Dodać fallback do REST + patterns.
```

Acceptance criteria:

```text
- jeżeli MCP działa, system może użyć node definitions
- jeżeli MCP nie działa, system dalej działa przez REST + patterns
```

## 28. MVP

Najmniejsza sensowna wersja:

```text
Jeden działający pattern:
Schedule/RSS/HTTP → filter keyword → Telegram alert
```

Obsługiwane node’y:

```text
- Schedule Trigger
- RSS Read albo HTTP Request
- IF albo Code
- Telegram
```

Obsługiwane ryzyko:

```text
- low
- medium
```

Zablokowane:

```text
- Gmail send
- database writes
- file system
- shell command
- SSH
- public posting
- payments
- invoices
```

MVP jest gotowe, gdy:

```text
1. User wpisuje request.
2. System tworzy AutomationSpec.
3. System pokazuje RiskReport.
4. System wybiera pattern.
5. System tworzy inactive draft w n8n.
6. User widzi workflow w n8n.
7. System potrafi uruchomić test.
8. System potrafi pobrać execution result.
9. System wymaga approval przed activation.
10. Po approval aktywuje workflow.
11. Failed execution pojawia się w dashboardzie.
```

## 29. Kolejność pracy dla deva

Najbardziej praktyczna kolejność:

```text
1. n8n local audit
2. n8nRestClient
3. AutomationSpec schema
4. Risk engine
5. Pattern library
6. WorkflowPlan
7. Generator dla jednego patternu
8. Static validation
9. Create inactive draft
10. Mongo storage
11. Approval backend
12. Dashboard view
13. Test runner
14. Execution parser
15. Activation flow
16. Monitoring
17. Debug loop
18. MCP optional integration
```

## 30. Kryteria ukończenia całego projektu

Projekt uznajemy za gotowy, jeśli:

```text
- Meta Agent nie tworzy workflow bez AutomationSpec.
- Każdy workflow ma RiskReport.
- Każdy workflow jest tworzony jako inactive.
- System ma pattern library.
- System nie używa raw secrets w promptach.
- System blokuje critical nodes.
- System wymaga approval przed activation.
- System zapisuje request/spec/build/test/approval w MongoDB.
- System potrafi pobrać execution logs z n8n.
- System pokazuje błędy w dashboardzie.
- System ma minimum jeden działający end-to-end pattern.
```

## 31. Finalny obraz systemu

Docelowo AgentForge ma mieć moduł:

```text
Automation Architect
```

Jego kompetencje:

```text
- rozumie request automatyzacyjny
- tworzy AutomationSpec
- wybiera pattern
- liczy ryzyko
- generuje workflow
- waliduje workflow
- tworzy draft w n8n
- testuje
- czyta execution logs
- poprawia błędy
- prosi o approval
- aktywuje dopiero po zgodzie
- monitoruje błędy produkcyjne
```

Najważniejsza zasada:

```text
Meta Agent może poprosić o automatyzację.
Automation Architect decyduje, jak ją bezpiecznie zbudować.
Approval system decyduje, czy wolno ją aktywować.
n8n tylko wykonuje workflow.
```

## 32. Rekomendacja końcowa

Zaimplementować jako:

```text
- osobny package w monorepo
- osobny worker
- osobna kolejka
- własne endpointy API
- własne kolekcje MongoDB
- własny deterministic risk engine
- integracja z dashboardem
- bezpośredni dostęp Meta Agenta tylko przez kontrolowany tool
```

Nie robić:

```text
- nie dawać Meta Agentowi N8N_API_KEY
- nie pozwalać mu tworzyć raw workflow JSON bez walidacji
- nie pozwalać mu aktywować workflow bez approval
- nie zaczynać od pełnego microservice’u
- nie opierać MVP na MCP
- nie próbować obsłużyć wszystkich node’ów n8n od razu
```

Wersja MVP ma być mała, kontrolowana i działająca end-to-end. Dopiero potem rozszerzać patterny i integracje.
