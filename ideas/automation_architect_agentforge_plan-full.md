# Automation Architect dla AgentForge - plan dopasowany do obecnego repo

Ten dokument jest praktycznym planem implementacji Automation Architecta w repo `/projekty/jarvis-dashboard-agent`. Nie jest przepisaniem starego planu jeden do jednego. Uwzględnia realną strukturę kodu, istniejący dashboard, worker, BullMQ, MongoDB, `@af/n8n`, approval pipeline, SSE event bus i Meta Agenta.

## 0. Najważniejsza decyzja

W tym repo najlepszy wariant to:

```text
@af/automation-architect jako osobny pakiet domenowy
+
AutomationArchitectAgent jako nowy agent w istniejącym workerze
+
osobna kolejka BullMQ agent-tasks-automation-architect
+
dedykowane API Next.js pod /api/automations/*
+
dashboard Automations rozszerzony o widok Architecta
+
Meta Agent dostaje tylko kontrolowane narzędzia automation.*
```

Nie tworzyć na start osobnego procesu `workers/automation-architect-worker.ts`. Obecny `apps/workers/src/index.ts` już uruchamia osobnego BullMQ Workera dla każdego zarejestrowanego agenta. Wystarczy dodać agenta `automation-architect` do `plugin-loader` i `AGENT_WORKFLOW_REGISTRY`.

Nie wkładać logiki Automation Architecta bezpośrednio do Meta Agenta. Meta Agent ma rozpoznawać intencję i zlecać pracę. Nie ma generować raw n8n JSON, aktywować workflow ani przechowywać sekretów.

## 1. Co już istnieje w repo

### 1.1. Monorepo

Repo używa pnpm workspaces:

```text
apps/*
packages/*
```

Istotne moduły:

```text
apps/dashboard                 Next.js dashboard
apps/workers                   proces workerów BullMQ i agentów
packages/shared                typy, schemas, agentConfig, JSON repair
packages/n8n                   obecny N8nService
packages/llm                   LLM router i providerzy
packages/crm                   CRM i MemoryService
packages/google                Gmail/Calendar
```

### 1.2. Obecny n8n integration

Plik:

```text
packages/n8n/src/client.ts
```

Obecnie `N8nService` ma:

```text
- triggerWebhook()
- listWorkflows()
- getWorkflow()
- createWorkflow()
- updateWorkflow()
- deleteWorkflow()
- getExecutions()
- executeWorkflow()
- getHealth()
```

To jest dobry fundament, ale do Automation Architecta trzeba go utwardzić:

```text
- dodać activateWorkflow()
- dodać deactivateWorkflow()
- dodać getExecution()
- ujednolicić env N8N_URL / N8N_BASE_URL
- typować odpowiedzi
- redagować błędy, żeby nie wypływały sekrety
- wymuszać active=false przy tworzeniu draftu z Architecta
```

### 1.3. Obecny dashboard Automations

Pliki:

```text
apps/dashboard/src/app/automations/page.tsx
apps/dashboard/src/app/automations/N8nTemplates.tsx
apps/dashboard/src/app/automations/N8nExecutions.tsx
apps/dashboard/src/app/automations/WorkflowActions.tsx
apps/dashboard/src/app/automations/AutomationTest.tsx
apps/dashboard/src/app/api/automations/route.ts
```

Ten widok jest teraz bardziej "n8n admin" niż "Automation Architect". Pokazuje workflows, executions, test webhooka, import/export/delete.

Planowana zmiana:

```text
1. Przenieść obecny raw n8n proxy do /api/n8n/*
2. Zostawić n8n admin jako pomocniczą sekcję lub zakładkę
3. Oddać /api/automations/* i główny /automations dla Automation Architecta
```

Dlaczego: obecne `POST /api/automations?action=import`, `PUT /api/automations?id=...` i `DELETE /api/automations?id=...` operują raw workflow JSON. To nie może być główny interfejs do architektury, która ma wymuszać spec, risk, validation i approval.

### 1.4. Obecny Meta Agent i tool registry

Istotne pliki:

```text
apps/workers/src/agents/meta-agent/index.ts
apps/workers/src/agents/meta-agent/tool-definitions.ts
apps/workers/src/agents/meta-agent/tool-registry.ts
apps/workers/src/agents/meta-agent/react-loop.ts
apps/workers/src/agents/meta-agent/tools.ts
```

Meta Agent ma już:

```text
- intent router
- ReAct loop
- zod validation tool args
- approval gate dla ryzykownych narzędzi
- pending approvals w chat UI
- capability summary generowane z registry
```

Ryzyko do naprawienia przed pełnym Architectem:

```text
tool n8n.update_workflow pozwala aktualizować raw workflow JSON po approvalu
globalna autonomia system_autonomy może ominąć approval dla narzędzi Meta Agenta
```

Docelowo Meta Agent powinien dostać narzędzia:

```text
automation.request
automation.status
automation.next_action
```

Nie powinien domyślnie widzieć:

```text
n8n.update_workflow
n8n.create_workflow raw
n8n.delete_workflow raw
n8n.activate_workflow raw
```

### 1.5. Obecny approval pipeline

Istotne pliki:

```text
apps/workers/src/core/approval-manager.ts
packages/shared/src/schemas.ts
apps/dashboard/src/app/api/approvals/execute/route.ts
apps/dashboard/src/lib/approval-flow.ts
apps/dashboard/src/components/ApprovalActions.tsx
apps/dashboard/src/components/ApprovalPreview.tsx
apps/dashboard/src/app/approvals/page.tsx
```

Nie budować drugiego niezależnego approval systemu. Użyć istniejącej kolekcji `approvals`, ale dodać metadata:

```ts
metadata: {
  domain: "automation-architect",
  automationId: "...",
  workflowId: "...",
  riskLevel: "medium",
  action: "activate_workflow"
}
```

Automation Architect może mieć własne dokumenty statusowe i eventy, ale decyzja approve/reject powinna płynąć przez istniejący mechanizm, bo dashboard i chat już go obsługują.

### 1.6. Obecny worker i queue

Istotne pliki:

```text
apps/workers/src/index.ts
apps/workers/src/core/queue.ts
apps/workers/src/core/plugin-loader.ts
packages/shared/src/agentConfig.ts
```

Obecny wzorzec:

```text
agentId => queue agent-tasks-<agentId>
plugin-loader tworzy instancje agentów
apps/workers/src/index.ts startuje BullMQ Worker dla każdego agenta
```

Dlatego `automation-architect` powinien być kolejnym agentem.

### 1.7. Lokalny runtime i kontenery

Ten projekt działa hybrydowo:

```text
Docker:
- af-mongodb
- af-n8n
- af-cloudflared-n8n

Host machine:
- Redis
- Ollama
- Agent Worker
- Next.js Dashboard
```

Source of truth dla uruchamiania:

```text
scripts/start.sh
scripts/stop.sh
docker-compose.yml
.env
```

Aktualny startup robi:

```text
1. docker compose up -d
2. czeka na af-mongodb
3. uruchamia cloudflare/cloudflared:latest jako af-cloudflared-n8n
4. pobiera dynamiczny URL *.trycloudflare.com z logów kontenera
5. zapisuje do .env:
   - N8N_HOST
   - N8N_PROTOCOL=https
   - N8N_WEBHOOK_URL=<dynamiczny tunnel URL>
   - N8N_PROXY_HOPS=1
6. recreatuje n8n, żeby n8n dostał nowy publiczny webhook URL
7. sprawdza Redis na localhost:6379
8. buduje workspace packages
9. startuje worker przez pnpm dev:workers
10. startuje dashboard przez pnpm dev:dashboard
```

To znaczy, że Automation Architect musi rozróżniać dwa adresy n8n:

```text
N8N_BASE_URL / N8N_URL
  lokalny REST API URL dla dashboardu i workera:
  http://localhost:5678

N8N_WEBHOOK_URL / N8N_PUBLIC_WEBHOOK_BASE_URL
  publiczny HTTPS URL dla webhooków z internetu:
  https://....trycloudflare.com
```

Nie wolno utrwalać tunnel URL w patternach ani promptach. Ten URL może zmienić się przy każdym starcie. Architect ma czytać bieżącą wartość z env albo z runtime health.

### 1.8. Macierz połączeń lokalnych

W obecnej konfiguracji `docker-compose.yml` n8n działa z:

```text
network_mode: host
```

To zmienia adresy używane wewnątrz n8n. Przy tym trybie n8n widzi usługi hosta przez `localhost`.

| Komponent | Gdzie działa | Adres dla dashboard/workera | Adres dla n8n | Uwagi |
| --- | --- | --- | --- | --- |
| Dashboard | host | `http://localhost:3000` | `http://localhost:3000` | n8n może wołać API dashboardu lokalnie, bo ma `network_mode: host`. |
| Worker | host | brak HTTP, przez Redis/Mongo | brak HTTP | Worker słucha kolejek BullMQ. |
| MongoDB | Docker `af-mongodb` | `mongodb://localhost:27017/agentforge` | `mongodb://localhost:27017/agentforge` | Przy `network_mode: host` nie używać `af-mongodb` w n8n credentials. |
| Redis | host service | `redis://localhost:6379` | `redis://localhost:6379` | BullMQ działa po stronie dashboard/workera. |
| n8n REST API | Docker `af-n8n`, host network | `http://localhost:5678/api/v1/*` | `http://localhost:5678` | REST API wymaga `N8N_API_KEY`. |
| n8n public webhook | Cloudflare tunnel | `N8N_WEBHOOK_URL` | generowane przez n8n | Dla Telegrama i zewnętrznych webhooków. |
| Ollama | host | `http://localhost:11434` | `http://localhost:11434` | Przy host network nie trzeba `host.docker.internal`. |

Jeżeli kiedyś n8n zostanie przełączone z `network_mode: host` na zwykłą sieć Docker Compose, wtedy adresy w n8n credentials zmieniają się:

```text
MongoDB: af-mongodb:27017 albo mongodb:27017
Ollama: host.docker.internal:11434 albo osobny kontener Ollama
Dashboard: host.docker.internal:3000 albo service name, jeśli dashboard też będzie w Dockerze
```

Na obecnym etapie plan zakłada tryb lokalny z terminala:

```text
Dashboard:  http://localhost:3000
Worker log: .logs/worker.log
Dash log:   .logs/dashboard.log
MongoDB:    localhost:27017
n8n:        http://localhost:5678
n8n public: https://....trycloudflare.com
Redis:      localhost:6379
Ollama:     localhost:11434
```

Automation Architect musi używać tej macierzy przy:

```text
- generowaniu instrukcji credentials dla n8n
- budowaniu node HTTP Request, jeśli n8n ma wołać AgentForge API
- budowaniu webhooków publicznych
- testach healthcheck
- dokumentacji brakującej konfiguracji
```

### 1.9. Zmiany wymagane w scripts/start.sh

Po dodaniu Automation Architecta trzeba zaktualizować `scripts/start.sh`.

Build packages powinien obejmować także:

```text
@af/n8n
@af/automation-architect
```

Rekomendowana kolejność buildów:

```text
@af/shared
@af/llm
@af/n8n
@af/automation-architect
@af/google
@af/notebooklm
@af/drafts
@af/crm
@af/search
```

Po uruchomieniu tunelu ustawiać nie tylko `N8N_WEBHOOK_URL`, ale też:

```text
N8N_PUBLIC_WEBHOOK_BASE_URL=<dynamiczny tunnel URL>
N8N_BASE_URL=http://localhost:5678
AUTOMATION_ARCHITECT_ENABLED=true
```

`N8N_BASE_URL` ma zostać lokalny. Nie ustawiać go na Cloudflare URL, bo worker i dashboard powinny rozmawiać z n8n po lokalnym REST API.

Sekcja Redis i summary powinny pokazywać pełny zestaw kolejek po dodaniu agenta:

```text
agent-tasks-meta-agent
agent-tasks-marketing-agent
agent-tasks-sales-agent
agent-tasks-analytics-agent
agent-tasks-automation-architect
```

Weryfikacja worker startu powinna sprawdzać log:

```bash
grep -q "automation-architect" .logs/worker.log
```

albo przynajmniej wypisać instrukcję:

```bash
tail -f /projekty/jarvis-dashboard-agent/.logs/worker.log
```

## 2. Docelowy obraz systemu

```text
User
  |
  v
Dashboard / Meta Agent chat
  |
  v
/api/automations/request albo tool automation.request
  |
  v
Mongo: automation_requests
  |
  v
BullMQ: agent-tasks-automation-architect
  |
  v
AutomationArchitectAgent
  |
  v
@af/automation-architect
  |-- buildAutomationSpec()
  |-- scoreRisk()
  |-- selectPattern()
  |-- buildWorkflowPlan()
  |-- generateWorkflow()
  |-- validateGeneratedWorkflow()
  |-- createDraftWorkflow()
  |-- runWorkflowTest()
  |-- analyzeExecution()
  |-- activateAutomationWorkflow()
  |
  v
@af/n8n -> local n8n REST API
```

Zasada:

```text
Meta Agent prosi o automatyzację.
Automation Architect projektuje, waliduje i egzekwuje guardrails.
Approval system decyduje, czy wolno wykonać akcję ryzykowną.
n8n tylko przechowuje i wykonuje workflow.
```

## 3. Zasady nienegocjowalne

1. Żaden workflow tworzony przez Automation Architecta nie może być aktywny przy utworzeniu.
2. Każdy workflow musi mieć `AutomationSpec`.
3. Każdy workflow musi mieć deterministyczny `RiskReport`.
4. Risk engine nie może zależeć wyłącznie od LLM.
5. Meta Agent nie dostaje `N8N_API_KEY`.
6. LLM nigdy nie widzi raw sekretów.
7. Brakujące credentials są opisywane instrukcją, nie prośbą o token w czacie.
8. Critical risk jest blokowany w MVP.
9. Approval aktywacji musi być sprawdzany w backendzie, nie tylko w UI.
10. Globalna autonomia `system_autonomy` nie może automatycznie aktywować workflow z Automation Architecta.
11. Raw n8n update/import/delete nie są ścieżką Automation Architecta.
12. Każda akcja zapisuje event audytowy.

## 4. Struktura katalogów po wdrożeniu

Dodać:

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
      BuildResult.ts
      TestRun.ts
      ExecutionSnapshot.ts
      AutomationEvent.ts
    schemas/
      automationRequestSchema.ts
      automationSpecSchema.ts
      workflowPlanSchema.ts
      riskReportSchema.ts
      testRunSchema.ts
    core/
      normalizeUserRequest.ts
      buildAutomationSpec.ts
      selectAutomationPattern.ts
      buildWorkflowPlan.ts
      generateWorkflow.ts
      validateGeneratedWorkflow.ts
      createDraftWorkflow.ts
      activateAutomationWorkflow.ts
    risk/
      riskTypes.ts
      riskRules.ts
      forbiddenNodes.ts
      approvalPolicy.ts
      scoreRisk.ts
      scoreRiskFromWorkflow.ts
    patterns/
      patternSchema.ts
      index.ts
      scheduleHttpIfTelegram.ts
      rssToTelegram.ts
      webhookToGoogleSheet.ts
      gmailReadToDraft.ts
      telegramCommandToQueue.ts
      competitorMonitoring.ts
    n8n/
      n8nWorkflowMapper.ts
      n8nExecutionParser.ts
      n8nCredentialPolicy.ts
      n8nNodeTypes.ts
    testing/
      createMockData.ts
      runWorkflowTest.ts
      analyzeExecution.ts
      proposeFixes.ts
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
      redactSecrets.ts
      safeJson.ts
      clock.ts
  tests/
    risk.test.ts
    pattern-selection.test.ts
    workflow-validation.test.ts
    schedule-http-if-telegram.test.ts
    mongo-store-contract.test.ts

apps/workers/src/agents/automation-architect/
  index.ts

apps/dashboard/src/app/api/n8n/
  route.ts

apps/dashboard/src/app/api/automations/
  route.ts
  request/route.ts
  [id]/route.ts
  [id]/build-spec/route.ts
  [id]/create-draft/route.ts
  [id]/test/route.ts
  [id]/approve/route.ts
  [id]/reject/route.ts
  [id]/activate/route.ts
  [id]/deactivate/route.ts
  [id]/executions/route.ts

apps/dashboard/src/app/automations/
  page.tsx
  AutomationRequestForm.tsx
  AutomationList.tsx
  AutomationDetail.tsx
  AutomationActions.tsx
  RiskBadge.tsx
  WorkflowPlanView.tsx
  AutomationTimeline.tsx
  MissingCredentials.tsx
  N8nAdminPanel.tsx
```

Zmienić:

```text
packages/n8n/src/client.ts
packages/n8n/src/index.ts
packages/shared/src/agentConfig.ts
packages/shared/src/constants.ts
apps/workers/src/core/plugin-loader.ts
apps/workers/src/core/env-health.ts
apps/workers/src/agents/meta-agent/tool-definitions.ts
apps/workers/src/agents/meta-agent/tool-registry.ts
apps/dashboard/src/lib/runtime-health.ts
apps/dashboard/src/components/ApprovalPreview.tsx
.env.example
package.json
```

## 5. Model danych

### 5.1. Status automatyzacji

Dodać typ:

```ts
export type AutomationStatus =
  | "received"
  | "spec_building"
  | "spec_created"
  | "risk_scored"
  | "pattern_selected"
  | "plan_created"
  | "validation_failed"
  | "awaiting_approval"
  | "draft_creating"
  | "draft_created"
  | "testing"
  | "test_failed"
  | "test_passed"
  | "activation_pending"
  | "active"
  | "inactive"
  | "blocked"
  | "rejected"
  | "failed";
```

Nie dodawać tych statusów do globalnego `TASK_STATUSES`, chyba że są używane jako task status. Dla Automation Architecta trzymać je w kolekcjach automation.

### 5.2. Kolekcje MongoDB

Użyć następujących kolekcji:

```text
automation_requests
automation_specs
automation_workflow_plans
automation_builds
automation_test_runs
automation_execution_snapshots
automation_events
approvals
```

Nie tworzyć `automation_approvals` w MVP. Wykorzystać istniejące `approvals`.

### 5.3. automation_requests

```ts
type AutomationRequestDocument = {
  _id: string;
  id: string;
  source: "dashboard" | "meta-agent" | "telegram" | "api";
  rawText: string;
  userId?: string;
  threadId?: string;
  taskId?: string;
  status: AutomationStatus;
  timezone: string;
  context?: {
    project?: string;
    existingWorkflowId?: string;
    preferredServices?: string[];
    forbiddenServices?: string[];
  };
  currentSpecId?: string;
  currentPlanId?: string;
  currentBuildId?: string;
  n8nWorkflowId?: string;
  riskLevel?: RiskLevel;
  createdAt: Date;
  updatedAt: Date;
};
```

### 5.4. automation_specs

```ts
type AutomationSpecDocument = {
  _id: string;
  id: string;
  requestId: string;
  spec: AutomationSpec;
  riskReport?: RiskReport;
  createdAt: Date;
  updatedAt: Date;
};
```

### 5.5. automation_builds

```ts
type AutomationBuildDocument = {
  _id: string;
  id: string;
  requestId: string;
  specId: string;
  planId: string;
  status: "generated" | "validation_failed" | "draft_created" | "blocked" | "error";
  workflowName: string;
  n8nWorkflowId?: string;
  n8nWorkflowJson?: unknown;
  validationErrors: string[];
  warnings: string[];
  createdAt: Date;
  updatedAt: Date;
};
```

### 5.6. approvals metadata

Przykład dokumentu w istniejącej kolekcji `approvals`:

```ts
{
  id: "uuid",
  agentId: "automation-architect",
  taskId: "auto-task-...",
  tool: "automation.activate",
  action: "activate_workflow",
  args: {
    automationId: "auto_...",
    workflowId: "..."
  },
  description: "Aktywacja workflow: AF Draft - Competitor Monitor",
  status: "pending",
  metadata: {
    domain: "automation-architect",
    automationId: "auto_...",
    workflowId: "...",
    riskLevel: "medium",
    requiredApproval: "activate_workflow"
  },
  createdAt: "..."
}
```

### 5.7. Indexy

Dodać helper `ensureAutomationIndexes(db)` i wywołać go przy starcie `AutomationArchitectAgent`.

Indexy:

```text
automation_requests: id unique
automation_requests: status, updatedAt
automation_requests: n8nWorkflowId
automation_specs: id unique
automation_specs: requestId
automation_workflow_plans: id unique
automation_workflow_plans: requestId
automation_builds: id unique
automation_builds: requestId
automation_builds: n8nWorkflowId
automation_test_runs: id unique
automation_test_runs: requestId, workflowId
automation_execution_snapshots: workflowId, createdAt
automation_events: automationId, createdAt
approvals: metadata.domain, metadata.automationId, status
```

## 6. Typy domenowe

### 6.1. RiskLevel

```ts
export type RiskLevel = "low" | "medium" | "high" | "critical";
```

### 6.2. AutomationRequest

```ts
export type AutomationRequest = {
  id: string;
  source: "dashboard" | "meta-agent" | "telegram" | "api";
  rawText: string;
  createdAt: string;
  userId?: string;
  timezone?: string;
  threadId?: string;
  taskId?: string;
  context?: {
    project?: string;
    existingWorkflowId?: string;
    preferredServices?: string[];
    forbiddenServices?: string[];
  };
};
```

### 6.3. AutomationSpec

Użyć typu z planu źródłowego, ale dodać pola potrzebne obecnemu UI:

```ts
export type AutomationSpec = {
  id: string;
  requestId: string;
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
    actionType: "read" | "transform" | "condition" | "notify" | "write" | "send" | "delete" | "execute";
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
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  missingConfig?: Array<{
    key: string;
    description: string;
    required: boolean;
  }>;
};
```

### 6.4. RiskReport

```ts
export type ApprovalAction =
  | "create_draft"
  | "test_with_mock_data"
  | "test_with_real_credentials"
  | "activate_workflow"
  | "send_external_message"
  | "write_production_data"
  | "manual_review_required";

export type RiskReport = {
  automationSpecId: string;
  level: RiskLevel;
  score: number;
  reasons: string[];
  blocked: boolean;
  requiredApprovals: ApprovalAction[];
  forbiddenActionsDetected: string[];
};
```

### 6.5. WorkflowPlan

```ts
export type WorkflowPlan = {
  id: string;
  requestId: string;
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
  missingCredentials: Array<{
    service: string;
    credentialName?: string;
    instructions: string;
  }>;
};
```

## 7. Etapy implementacji

### Etap 0 - Audyt lokalnego n8n i stanu repo

Cel: zanim powstanie generator, upewnić się, że lokalne n8n jest stabilne i API działa.

Kroki:

1. Utwórz katalog:

```text
docs/automation-architect/
```

2. Sprawdź wersję n8n:

```bash
docker exec af-n8n n8n --version
```

3. Sprawdź persistent volume:

```bash
docker inspect af-n8n
```

W `docker-compose.yml` już jest:

```text
n8n_data:/home/node/.n8n
```

Zapisać to jako potwierdzone w audycie.

4. Sprawdź API:

```bash
curl -sS -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows"
```

5. Sprawdź executions:

```bash
curl -sS -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/executions?limit=5"
```

6. Zapisz wynik w:

```text
docs/automation-architect/n8n-local-audit.md
```

7. Dopisz w audycie aktualny lokalny sposób uruchamiania z `scripts/start.sh`:

```text
Dashboard: http://localhost:3000
Worker log: /projekty/jarvis-dashboard-agent/.logs/worker.log
Dashboard log: /projekty/jarvis-dashboard-agent/.logs/dashboard.log
MongoDB: localhost:27017
n8n REST: http://localhost:5678
n8n public: bieżący URL z N8N_WEBHOOK_URL
Redis: localhost:6379
Ollama: localhost:11434
```

8. Zweryfikuj, że n8n działa w `network_mode: host`. Jeśli tak, instrukcje credentials dla n8n mają używać:

```text
MongoDB host: localhost
MongoDB port: 27017
Ollama base URL: http://localhost:11434
AgentForge dashboard/API: http://localhost:3000
```

Nie wpisywać w tych instrukcjach `af-mongodb`, dopóki n8n działa z `network_mode: host`.

Acceptance criteria:

```text
- znana wersja n8n
- potwierdzony persistent volume
- potwierdzony N8N_API_KEY
- wiadomo, czy /api/v1/workflows działa
- wiadomo, czy /api/v1/executions działa
- wiadomo, czy N8N_WEBHOOK_URL wskazuje lokalny URL lub Cloudflare tunnel
- wiadomo, których adresów n8n ma używać do Mongo/Ollama/Dashboard przy network_mode: host
```

Nie iść dalej, jeśli API n8n nie działa.

### Etap 1 - Pakiet @af/automation-architect

Cel: dodać domenowy pakiet bez podłączania go jeszcze do UI i workera.

Kroki:

1. Utwórz:

```text
packages/automation-architect/package.json
packages/automation-architect/tsconfig.json
packages/automation-architect/src/index.ts
```

2. `package.json`:

```json
{
  "name": "@af/automation-architect",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test tests/**/*.test.ts"
  },
  "dependencies": {
    "@af/shared": "workspace:*",
    "@af/n8n": "workspace:*",
    "@af/llm": "workspace:*",
    "mongodb": "^6.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

3. `tsconfig.json` wzorować na `packages/shared/tsconfig.json`.

4. Dodać pakiet do zależności:

```text
apps/workers/package.json
apps/dashboard/package.json
```

5. Uruchomić:

```bash
pnpm --filter @af/automation-architect typecheck
pnpm -r typecheck
```

Acceptance criteria:

```text
- nowy pakiet buduje się bez logiki runtime
- package export działa
- worker i dashboard mogą zaimportować typy z @af/automation-architect
```

### Etap 2 - Env i runtime health

Cel: dodać konfigurację bez sekretów w promptach.

Kroki:

1. W `.env.example` dodać:

```env
# === LOCAL RUNTIME ===
MONGODB_URI=mongodb://localhost:27017/agentforge
REDIS_URL=redis://localhost:6379
DASHBOARD_URL=http://localhost:3000
OLLAMA_BASE_URL=http://localhost:11434

# === N8N LOCAL REST API ===
# Local URL used by dashboard and worker for REST API calls.
N8N_BASE_URL=http://localhost:5678
N8N_URL=http://localhost:5678
N8N_API_KEY=

# === N8N PUBLIC WEBHOOKS ===
# scripts/start.sh overwrites these with the current Cloudflare tunnel URL.
N8N_WEBHOOK_URL=http://localhost:5678/
N8N_PUBLIC_WEBHOOK_BASE_URL=http://localhost:5678/

# === AUTOMATION ARCHITECT ===
AUTOMATION_ARCHITECT_ENABLED=true
AUTOMATION_ARCHITECT_DRY_RUN_DEFAULT=true
AUTOMATION_ARCHITECT_REQUIRE_APPROVAL=true
AUTOMATION_MAX_FIX_ATTEMPTS=3
AUTOMATION_DEFAULT_TIMEZONE=Atlantic/Reykjavik

AUTOMATION_BLOCK_EXECUTE_COMMAND=true
AUTOMATION_BLOCK_FILE_SYSTEM=true
AUTOMATION_BLOCK_SSH=true
AUTOMATION_BLOCK_PRODUCTION_DB_WRITES=true
AUTOMATION_BLOCK_MASS_EMAIL=true
AUTOMATION_BLOCK_PUBLIC_POSTING=true

# Optional. Keep disabled for MVP.
AUTOMATION_ALLOW_MCP=false
```

2. Zostawić `N8N_URL` dla obecnego kodu.

3. W `scripts/start.sh` po wykryciu Cloudflare tunnel URL dopisać:

```bash
set_env_var "N8N_PUBLIC_WEBHOOK_BASE_URL" "$TUNNEL_URL"
set_env_var "N8N_BASE_URL" "http://localhost:5678"
set_env_var "AUTOMATION_ARCHITECT_ENABLED" "true"
```

4. W `packages/n8n/src/client.ts` odczytywać:

```ts
process.env.N8N_BASE_URL ?? process.env.N8N_URL ?? "http://localhost:5678"
```

5. W generatorach workflow publiczny adres webhooków czytać z:

```ts
process.env.N8N_PUBLIC_WEBHOOK_BASE_URL ?? process.env.N8N_WEBHOOK_URL
```

Lokalne REST API n8n czytać tylko z `N8N_BASE_URL`/`N8N_URL`.

6. W `apps/workers/src/core/env-health.ts` dodać warningi dla:

```text
AUTOMATION_ARCHITECT_ENABLED
N8N_API_KEY
N8N_BASE_URL albo N8N_URL
N8N_PUBLIC_WEBHOOK_BASE_URL albo N8N_WEBHOOK_URL
AUTOMATION_DEFAULT_TIMEZONE
```

7. W `apps/dashboard/src/lib/runtime-health.ts` dodać nowe env do `ENV_META`.

Acceptance criteria:

```text
- Settings runtime pokazuje nowe env
- worker loguje brakujące ustawienia, ale nie wypisuje sekretów
- stary kod nadal działa z N8N_URL
- start.sh ustawia aktualny publiczny URL dla n8n webhooków
- Architect nie używa Cloudflare URL do REST API n8n
```

### Etap 3 - Utwardzenie @af/n8n

Cel: nie duplikować klienta n8n w nowym pakiecie. Rozszerzyć istniejący `N8nService`.

Kroki:

1. Dodać typy:

```text
packages/n8n/src/types.ts
```

2. Typy minimalne:

```ts
export type N8nWorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type N8nExecutionSummary = {
  id: string;
  workflowId?: string;
  status?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
};
```

3. Dodać metody:

```ts
activateWorkflow(workflowId: string): Promise<void>
deactivateWorkflow(workflowId: string): Promise<void>
getExecution(executionId: string): Promise<any>
```

4. Sprawdzić realny endpoint aktywacji dla wersji n8n z Etapu 0. Jeśli n8n API nie ma dedykowanego activate endpointu, implementować przez pobranie workflow, zmianę `active`, update workflow.

5. Dodać `redactN8nError(text: string)` i używać w błędach.

6. Dodać `createInactiveWorkflow(workflowData)` albo wymuszać `active: false` w Automation Architect wrapperze.

7. W `packages/n8n/src/index.ts` eksportować typy.

Acceptance criteria:

```text
- @af/n8n typecheck przechodzi
- list/get/create/update/activate/deactivate/executions działają ręcznie z lokalnym n8n
- błędy nie logują X-N8N-API-KEY ani bearer tokenów
```

### Etap 4 - Schematy i walidacja AutomationSpec

Cel: wszystkie dane wychodzące z LLM są walidowane Zodem.

Kroki:

1. Dodać typy w:

```text
packages/automation-architect/src/types/*
```

2. Dodać Zod schemas w:

```text
packages/automation-architect/src/schemas/*
```

3. `AutomationSpecSchema` ma być `.strict()` na poziomach, gdzie nie chcemy halucynowanych pól.

4. Dodać helper:

```text
packages/automation-architect/src/utils/safeJson.ts
```

Używać `repairJSON` z `@af/shared`, ale po naprawie zawsze walidować Zodem.

5. Dodać testy walidacji:

```text
packages/automation-architect/tests/automation-spec-schema.test.ts
```

Testy:

```text
- poprawny spec przechodzi
- brak triggera failuje
- actionType spoza enum failuje
- secret jako zwykły string w inputs nie przechodzi, jeśli narusza politykę
- dataPolicy musi mieć wszystkie pola boolean
```

Acceptance criteria:

```text
- LLM output nigdy nie jest używany bez schema parse
- invalid JSON/spec daje kontrolowany błąd
- testy spec schema przechodzą
```

### Etap 5 - Deterministyczny risk engine

Cel: ryzyko ma wynikać z danych, nie z opinii LLM.

Pliki:

```text
packages/automation-architect/src/risk/riskTypes.ts
packages/automation-architect/src/risk/riskRules.ts
packages/automation-architect/src/risk/forbiddenNodes.ts
packages/automation-architect/src/risk/approvalPolicy.ts
packages/automation-architect/src/risk/scoreRisk.ts
packages/automation-architect/src/risk/scoreRiskFromWorkflow.ts
```

Reguły MVP:

```text
low:
- public RSS read
- public HTTP read
- transform data
- local draft
- mock test

medium:
- Telegram notification do właściciela
- internal webhook
- Gmail read
- Google Sheet test write

high:
- email send
- CRM write
- customer data update
- paid API
- production HTTP write
- real credentials test

critical:
- execute command
- SSH
- filesystem read/write
- direct DB writes
- delete data
- public posting
- payments
- invoices
- credential management
```

Forbidden nodes:

```ts
export const FORBIDDEN_NODE_TYPES = [
  "n8n-nodes-base.executeCommand",
  "n8n-nodes-base.ssh",
  "n8n-nodes-base.ftp",
  "n8n-nodes-base.readWriteFile",
  "n8n-nodes-base.microsoftSql",
  "n8n-nodes-base.postgres",
  "n8n-nodes-base.mySql",
  "n8n-nodes-base.mongoDb"
];
```

Approval policy:

```ts
export const APPROVAL_POLICY = {
  low: ["create_draft"],
  medium: ["create_draft", "activate_workflow"],
  high: ["create_draft", "test_with_real_credentials", "activate_workflow"],
  critical: ["manual_review_required"]
} as const;
```

W MVP:

```text
critical => blocked: true
high => można zaprojektować, ale nie aktywować automatycznie; manual review
low/medium => pełny happy path
```

Testy:

```text
packages/automation-architect/tests/risk.test.ts
```

Acceptance criteria:

```text
- RSS monitor bez wysyłki = low
- RSS/HTTP + Telegram do właściciela = medium
- Gmail send = high
- Execute Command node = critical blocked
- workflowRisk większy od specRisk wymaga nowego approvalu
```

### Etap 6 - Pattern library

Cel: MVP nie generuje całego n8n od zera. Wybiera ze znanych wzorców.

Pliki:

```text
packages/automation-architect/src/patterns/patternSchema.ts
packages/automation-architect/src/patterns/index.ts
packages/automation-architect/src/patterns/scheduleHttpIfTelegram.ts
packages/automation-architect/src/patterns/rssToTelegram.ts
packages/automation-architect/src/patterns/webhookToGoogleSheet.ts
packages/automation-architect/src/patterns/gmailReadToDraft.ts
packages/automation-architect/src/patterns/telegramCommandToQueue.ts
packages/automation-architect/src/patterns/competitorMonitoring.ts
```

Na start implementować realnie tylko:

```text
schedule-http-if-telegram
rss-to-telegram
```

Pozostałe patterny mogą istnieć jako definicje bez generatora, ze statusem:

```ts
implementationStatus: "planned"
```

Pattern schema:

```ts
export type AutomationPattern = {
  id: string;
  name: string;
  description: string;
  useCases: string[];
  riskLevel: RiskLevel;
  implementationStatus: "implemented" | "planned";
  requiredInputs: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "url" | "secret" | "json";
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
  connections: Array<{ from: string; to: string }>;
  commonFailures: string[];
  testStrategy: string[];
  blockedUnlessApproved: boolean;
};
```

Selection rules:

```text
- RSS/blog/feed/konkurencja/changelog/news -> rss-to-telegram albo competitor-monitoring
- strona/API + słowo kluczowe + Telegram -> schedule-http-if-telegram
- formularz/webhook + sheet -> webhook-to-google-sheet, ale planned
- Gmail read/classify/draft -> gmail-read-to-draft, ale planned
- Telegram command -> queue -> telegram-command-to-queue, ale planned
```

Acceptance criteria:

```text
- request "sprawdzaj RSS i wyślij Telegram" wybiera rss-to-telegram
- request "sprawdzaj blog konkurencji pod keyword" wybiera schedule-http-if-telegram albo competitor-monitoring
- brak implemented patternu zatrzymuje flow z czytelnym komunikatem
```

### Etap 7 - Build AutomationSpec z LLM

Cel: LLM zamienia request w strukturę, ale nie decyduje sam o bezpieczeństwie.

Pliki:

```text
packages/automation-architect/src/prompts/automationArchitect.system.ts
packages/automation-architect/src/prompts/automationSpec.prompt.ts
packages/automation-architect/src/core/normalizeUserRequest.ts
packages/automation-architect/src/core/buildAutomationSpec.ts
```

Implementacja:

```ts
export async function buildAutomationSpec(input: {
  request: AutomationRequest;
  llmCall: (params: { systemPrompt: string; userPrompt: string; jsonMode: boolean }) => Promise<string>;
}): Promise<AutomationSpec>;
```

Nie importować bezpośrednio singletona `llmRouter` do każdej funkcji core. Lepiej wstrzyknąć funkcję `llmCall`, a w `AutomationArchitectAgent` użyć `this.callLLM(...)`. To ułatwi testy.

Prompt ma wymuszać:

```text
- brak raw n8n JSON
- brak sekretów
- jawne inputs
- jawne credentialsNeeded
- jawne failureBehavior
- jawne dataPolicy
- jeśli czegoś brakuje, dodać missingConfig zamiast zgadywać
```

Po LLM:

```text
repairJSON -> AutomationSpecSchema.safeParse -> normalize -> scoreRisk
```

Acceptance criteria:

```text
- request użytkownika tworzy spec
- spec ma trigger, steps, credentialsNeeded, dataPolicy, successCriteria
- brak URL/feed/keyword trafia do missingConfig
- LLM nie zwraca workflow JSON
```

### Etap 8 - WorkflowPlan

Cel: przed generacją pokazać plan node’ów, connections i brakujących danych.

Pliki:

```text
packages/automation-architect/src/core/buildWorkflowPlan.ts
packages/automation-architect/src/schemas/workflowPlanSchema.ts
```

Flow:

```text
AutomationSpec
  -> RiskReport
  -> selectAutomationPattern()
  -> buildWorkflowPlan()
  -> WorkflowPlanSchema.parse()
```

WorkflowPlan ma zawierać:

```text
- selectedPatternId
- logical n8n nodes
- connections
- credentials required
- missing config
- missing credentials
- risk tags
```

Acceptance criteria:

```text
- dashboard może pokazać plan bez tworzenia workflow w n8n
- brak chatId/credential/URL zatrzymuje create draft albo tworzy draft z oznaczeniem missing credentials, zależnie od pola
- plan jest zapisany w automation_workflow_plans
```

### Etap 9 - Generator i walidator workflow

Cel: pierwszy end-to-end pattern.

Pliki:

```text
packages/automation-architect/src/core/generateWorkflow.ts
packages/automation-architect/src/core/validateGeneratedWorkflow.ts
packages/automation-architect/src/n8n/n8nWorkflowMapper.ts
packages/automation-architect/src/n8n/n8nNodeTypes.ts
packages/automation-architect/tests/workflow-validation.test.ts
packages/automation-architect/tests/schedule-http-if-telegram.test.ts
```

Pierwsze obsługiwane node’y:

```text
n8n-nodes-base.scheduleTrigger
n8n-nodes-base.httpRequest
n8n-nodes-base.rssFeedRead
n8n-nodes-base.if albo n8n-nodes-base.code
n8n-nodes-base.telegram
```

Polityka adresów w generowanych workflow:

```text
- n8n REST API nie pojawia się w workflow; używa go tylko backend @af/n8n.
- publiczne webhooki z internetu mają bazować na N8N_PUBLIC_WEBHOOK_BASE_URL albo N8N_WEBHOOK_URL.
- jeśli workflow w n8n ma wołać AgentForge API, używa DASHBOARD_URL=http://localhost:3000.
- jeśli workflow w n8n ma używać lokalnego Ollama, używa http://localhost:11434.
- jeśli workflow w n8n ma używać MongoDB przy obecnym network_mode: host, credentials/instrukcje używają localhost:27017.
- jeśli request wymaga zewnętrznego webhooka, a N8N_WEBHOOK_URL nadal jest localhost, workflow może powstać jako draft, ale status powinien zawierać missingConfig/publicWebhookUrl.
```

W generatorze dodać helper:

```ts
export function getRuntimeConnectionHints(env = process.env) {
  return {
    n8nRestBaseUrl: env.N8N_BASE_URL ?? env.N8N_URL ?? "http://localhost:5678",
    n8nPublicWebhookBaseUrl: env.N8N_PUBLIC_WEBHOOK_BASE_URL ?? env.N8N_WEBHOOK_URL,
    dashboardUrl: env.DASHBOARD_URL ?? "http://localhost:3000",
    mongoUriForN8n: "mongodb://localhost:27017/agentforge",
    ollamaBaseUrlForN8n: env.OLLAMA_BASE_URL ?? "http://localhost:11434"
  };
}
```

Nie dodawać do workflow żadnych tokenów z env. Workflow może odnosić się do nazwy credentiala w n8n, ale nie może zawierać sekretu.

Generator musi zawsze ustawić:

```ts
active: false
name: `AF Draft - ${safeName}`
tags: ["agentforge", "automation-architect", `risk-${riskLevel}`]
```

Static validation:

```text
- workflow ma minimum 2 node’y
- workflow ma trigger
- każdy node ma unikalną nazwę
- connections wskazują istniejące node’y
- active === false
- nie ma forbidden node types
- nie ma raw secrets
- URL nie jest pusty
- Telegram chatId nie jest pusty, jeśli node ma wysyłać realnie
- Schedule ma timezone
- node credentials nie zawierają tokenów
```

Secret detection:

```text
- bearer token
- api_key
- access_token
- refresh_token
- x-n8n-api-key
- telegram bot token pattern
- URL z token= lub key=
```

Acceptance criteria:

```text
- generator tworzy poprawny JSON dla schedule-http-if-telegram
- walidator blokuje active=true
- walidator blokuje Execute Command
- walidator blokuje raw secret w node parameters
- scoreRiskFromWorkflow działa na wygenerowanym workflow
```

### Etap 10 - Mongo store i AutomationArchitectService

Cel: jeden service używany przez worker i API.

Pliki:

```text
packages/automation-architect/src/storage/automationStore.ts
packages/automation-architect/src/storage/mongoAutomationStore.ts
packages/automation-architect/src/service.ts
```

Interfejs:

```ts
export interface AutomationStore {
  createRequest(input: AutomationRequest): Promise<AutomationRequestDocument>;
  getRequest(id: string): Promise<AutomationRequestDocument | null>;
  listRequests(input?: { limit?: number; status?: string }): Promise<AutomationRequestDocument[]>;
  updateRequestStatus(id: string, status: AutomationStatus, patch?: Record<string, unknown>): Promise<void>;
  saveSpec(input: { requestId: string; spec: AutomationSpec; riskReport: RiskReport }): Promise<string>;
  savePlan(input: { requestId: string; plan: WorkflowPlan }): Promise<string>;
  saveBuild(input: AutomationBuildDocument): Promise<void>;
  saveTestRun(input: TestRun): Promise<void>;
  appendEvent(input: AutomationEvent): Promise<void>;
}
```

Service:

```ts
export class AutomationArchitectService {
  submitRequest(...)
  buildSpec(...)
  createDraft(...)
  runTest(...)
  requestActivationApproval(...)
  activate(...)
  deactivate(...)
  refreshExecutions(...)
}
```

Service powinien mieć preflight lokalnego runtime:

```ts
preflightRuntime(): Promise<{
  ok: boolean;
  checks: Array<{
    key: "n8n_rest" | "n8n_api_key" | "n8n_public_webhook" | "mongo" | "redis" | "dashboard_url";
    ok: boolean;
    detail: string;
  }>;
}>
```

Preflight sprawdza:

```text
- n8n REST health przez N8N_BASE_URL/N8N_URL
- obecność N8N_API_KEY dla create/update/list workflow
- czy N8N_PUBLIC_WEBHOOK_BASE_URL/N8N_WEBHOOK_URL nie jest localhost, jeśli workflow wymaga public webhooka
- Mongo connection przez MONGODB_URI
- Redis connection przez REDIS_URL, jeśli request będzie queueowany
- DASHBOARD_URL, jeśli workflow ma wołać AgentForge API z n8n
```

Ten preflight ma być widoczny w dashboardzie przy automatyzacji jako "Runtime wiring".

Wstrzykiwać zależności:

```ts
{
  store,
  n8n,
  llmCall,
  now,
  publishEvent?
}
```

Acceptance criteria:

```text
- service da się testować bez Mongo/n8n przez mock store i mock n8n
- wszystkie zmiany statusu zapisują automation_event
- API i worker używają tego samego service, a nie kopiują logiki
```

### Etap 11 - Create inactive draft w n8n

Cel: bezpiecznie utworzyć workflow draft w lokalnym n8n.

Implementacja:

```text
createDraftWorkflow()
  -> get request/spec/plan
  -> generateWorkflow()
  -> validateGeneratedWorkflow()
  -> scoreRiskFromWorkflow()
  -> if critical blocked, stop
  -> if create_draft approval required and not approved, create pending approval
  -> n8n.createWorkflow({ ...workflow, active: false })
  -> save build with n8nWorkflowId
  -> request status draft_created
```

W MVP można potraktować `create_draft` dla low/medium jako dozwolone po potwierdzeniu w UI "Create Draft", bez osobnego approvala w globalnym `approvals`, bo workflow jest inactive. Aktywacja zawsze wymaga approvala.

Jeśli chcesz maksymalnie rygorystycznie:

```text
low: create draft z kliknięcia w UI bez global approval
medium: create draft z kliknięcia w UI bez global approval, activation z approval
high: create draft wymaga approval
critical: blocked
```

Acceptance criteria:

```text
- workflow pojawia się w n8n UI jako inactive
- workflow ma prefix AF Draft
- workflowId jest zapisane w automation_requests i automation_builds
- przy błędzie n8n status przechodzi na failed albo validation_failed
```

### Etap 12 - AutomationArchitectAgent w workerze

Cel: osobna kolejka i background processing bez nowego procesu.

Pliki:

```text
apps/workers/src/agents/automation-architect/index.ts
packages/shared/src/agentConfig.ts
apps/workers/src/core/plugin-loader.ts
```

1. Dodać config:

```ts
export const AUTOMATION_ARCHITECT_CONFIG = {
  agentId: "automation-architect",
  name: "Automation Architect",
  role: "Safe n8n automation designer and operator",
  llmConfig: {
    primary: "openai:gpt-5.4-mini",
    fallback: "gemini-3-flash-preview",
    perStep: {
      "automation-spec": ["openai:gpt-5.4-mini", "gemini-3-flash-preview", "ollama:gemma4:26b"],
      "workflow-plan": ["openai:gpt-5.4-mini", "gemini-3-flash-preview"],
      "execution-debug": ["openai:gpt-5.4-mini", "gemini-3-flash-preview"]
    }
  },
  capabilities: [
    "automation_spec",
    "risk_scoring",
    "n8n_draft_generation",
    "workflow_testing",
    "execution_monitoring"
  ],
  schedules: [
    {
      workflow: "monitor-automations",
      cron: "*/15 * * * *",
      enabled: false
    }
  ]
} as const;
```

2. Dodać do `AGENT_WORKFLOW_REGISTRY`:

```text
build-spec
create-draft
run-test
request-activation
activate
deactivate
monitor-automations
```

3. Dodać klasę:

```ts
export class AutomationArchitectAgent extends BaseAgent {
  id = "automation-architect";
  name = "Automation Architect";
  description = "Designs, validates, tests and activates safe n8n workflows";
  capabilities = [...]
  tools = [];

  async run(input) {
    switch (input.workflow) {
      case "build-spec": ...
      case "create-draft": ...
      case "run-test": ...
      case "request-activation": ...
      case "activate": ...
      case "monitor-automations": ...
    }
  }
}
```

4. W `plugin-loader.ts` zarejestrować:

```ts
const automationArchitect = new AutomationArchitectAgent(AUTOMATION_ARCHITECT_CONFIG)
this.plugins.set(automationArchitect.id, automationArchitect)
```

5. W `scripts/start.sh` zaktualizować build i summary:

```text
- dodać @af/n8n do listy buildów, jeśli nie jest już budowany wcześniej
- dodać @af/automation-architect do listy buildów
- w linii "Redis ready for BullMQ queues" dopisać agent-tasks-automation-architect
- w końcowym summary dopisać agent-tasks-sales-agent, agent-tasks-analytics-agent i agent-tasks-automation-architect
```

Po wdrożeniu startup powinien komunikować przynajmniej:

```text
@af/n8n... ✓
@af/automation-architect... ✓
Queues: agent-tasks-meta-agent, agent-tasks-marketing-agent, agent-tasks-sales-agent, agent-tasks-analytics-agent, agent-tasks-automation-architect
```

Acceptance criteria:

```text
- worker startuje z automation-architect
- powstaje kolejka agent-tasks-automation-architect
- można ręcznie dodać job przez /api/tasks/trigger
- taski automation-architect zapisują statusy i logi
- scripts/start.sh buduje nowy pakiet przed startem workera
- summary startowe pokazuje kolejkę automation-architect
```

### Etap 13 - API Next.js

Cel: dashboard i Meta Agent mogą tworzyć i sterować automatyzacjami przez kontrolowane endpointy.

Najpierw przenieść raw n8n:

1. Utworzyć:

```text
apps/dashboard/src/app/api/n8n/route.ts
```

2. Przenieść obecną zawartość:

```text
apps/dashboard/src/app/api/automations/route.ts -> apps/dashboard/src/app/api/n8n/route.ts
```

3. Zaktualizować:

```text
WorkflowActions.tsx
N8nExecutions.tsx
AutomationTest.tsx
N8nAdminPanel.tsx
```

żeby używały `/api/n8n`.

Następnie dodać Automation Architect API:

```text
POST /api/automations/request
GET  /api/automations
GET  /api/automations/[id]
POST /api/automations/[id]/build-spec
POST /api/automations/[id]/create-draft
POST /api/automations/[id]/test
POST /api/automations/[id]/approve
POST /api/automations/[id]/reject
POST /api/automations/[id]/activate
POST /api/automations/[id]/deactivate
GET  /api/automations/[id]/executions
```

Endpointy akcji powinny:

```text
- walidować body Zodem
- tworzyć lub aktualizować Mongo doc
- queueować job do agent-tasks-automation-architect przez apps/dashboard/src/lib/queue.ts
- nie wykonywać ciężkiej logiki w request thread, jeśli operacja może trwać długo
```

Przykład `POST /api/automations/request`:

```ts
{
  rawText: string;
  timezone?: string;
  source?: "dashboard" | "api";
}
```

Zwraca:

```ts
{
  automationId: string;
  taskId: string;
  status: "queued";
}
```

Acceptance criteria:

```text
- request tworzy automation_request i job build-spec
- GET /api/automations listuje automatyzacje
- GET /api/automations/[id] zwraca request, spec, risk, plan, build, tests, events, approvals
- create-draft/test/activate nie przyjmują raw n8n JSON z UI
```

### Etap 14 - Dashboard UI

Cel: użytkownik może iść przez cały proces bez wchodzenia w Mongo.

`apps/dashboard/src/app/automations/page.tsx` podzielić na sekcje:

```text
1. Automation Architect
2. Existing n8n workflows / admin panel
```

Komponenty:

```text
AutomationRequestForm.tsx
AutomationList.tsx
AutomationDetail.tsx
AutomationActions.tsx
RiskBadge.tsx
WorkflowPlanView.tsx
AutomationTimeline.tsx
MissingCredentials.tsx
N8nAdminPanel.tsx
```

Widok listy:

```text
Name | Status | Risk | Pattern | n8n Workflow | Updated | Actions
```

Widok szczegółów:

```text
- User request
- AutomationSpec
- RiskReport
- WorkflowPlan
- Missing config
- Missing credentials
- n8n draft link
- Test runs
- Execution snapshots
- Approval status
- Event timeline
```

Akcje:

```text
- Build spec
- Create draft
- Run mock test
- Run real credentials test
- Request activation approval
- Activate after approval
- Deactivate
- View in n8n
```

Nie pokazywać raw sekretów ani całego workflow JSON domyślnie. Jeśli potrzebny debug JSON, schować pod `<details>` i redagować.

Acceptance criteria:

```text
- formularz tworzy request
- lista odświeża status
- detail pokazuje spec/risk/plan
- user widzi, dlaczego workflow jest blocked albo awaiting approval
- approval card dla automation ma czytelny preview
```

### Etap 15 - Approval gate dla aktywacji

Cel: aktywacja jest niemożliwa bez explicit approval w backendzie.

Pliki:

```text
packages/automation-architect/src/core/activateAutomationWorkflow.ts
apps/workers/src/core/approval-manager.ts
apps/dashboard/src/components/ApprovalPreview.tsx
```

Flow:

```text
User clicks "Request activation"
  -> AutomationArchitectService.requestActivationApproval()
  -> ApprovalManager.createPending(...)
  -> request status activation_pending
  -> UI /approvals albo automation detail pokazuje approval
  -> user approves
  -> existing approval pipeline queues execute-approval
  -> Meta Agent currently executes approvals for tools
```

Dla Automation Architecta lepszy wariant:

```text
Approval approve nie powinien wykonywać Meta Agent tool.
Powinien queueować automation-architect workflow "activate".
```

Są dwa sposoby:

Opcja A - szybka, zgodna z obecnym pipeline:

```text
tool: automation.activate
handler w Meta Agent tool-registry queueuje automation-architect/activate
po approve istniejący execute-approval uruchamia handler
```

Opcja B - docelowa:

```text
apps/dashboard/src/lib/approval-flow.ts rozpoznaje metadata.domain === "automation-architect"
i tworzy task dla agentId automation-architect, workflow activate
```

Rekomendacja: Opcja B, bo aktywacja nie jest narzędziem Meta Agenta. Meta Agent nie powinien być pośrednikiem w egzekucji approvali Automation Architecta.

Backend check w `activateAutomationWorkflow()`:

```ts
const approval = await store.findApprovedApproval({
  automationId,
  workflowId,
  action: "activate_workflow"
});

if (!approval) {
  throw new Error("Activation requires explicit approval.");
}
```

Nie sprawdzać tylko statusu w UI.

Acceptance criteria:

```text
- activate bez approvala failuje
- approve w dashboardzie tworzy job automation-architect/activate
- activation sprawdza ostatni risk i ostatni test
- medium workflow aktywuje się dopiero po approvalu
- globalna autonomia nie omija tego checka
```

### Etap 16 - Test runner i execution parser

Cel: po utworzeniu draftu można go przetestować i odczytać błędy.

Pliki:

```text
packages/automation-architect/src/testing/createMockData.ts
packages/automation-architect/src/testing/runWorkflowTest.ts
packages/automation-architect/src/testing/analyzeExecution.ts
packages/automation-architect/src/n8n/n8nExecutionParser.ts
```

Tryby:

```text
mock:
- bez credentiali
- bez realnej wysyłki
- test generatora i planu

manual:
- workflow inactive
- kontrolowane uruchomienie w n8n, jeśli API pozwala

real_credentials:
- tylko po approval
- Telegram może wysłać test do owner chat
- Gmail tylko draft, bez send
- Google Sheet tylko test sheet
```

MVP:

```text
mock + manual
```

Jeśli endpoint `/workflows/{id}/run` w Twojej wersji n8n nie działa stabilnie, w MVP test może oznaczać:

```text
- static validation
- dry-run payload generation
- optional manual instruction "Run in n8n UI"
- potem fetch latest executions
```

ExecutionAnalysis:

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

Acceptance criteria:

```text
- test run zapisuje automation_test_runs
- dashboard pokazuje status testu
- failed execution pokazuje failed node i error summary
- test_with_real_credentials wymaga approval
```

### Etap 17 - Meta Agent integration

Cel: Meta Agent rozpoznaje automatyzację, ale używa tylko kontrolowanego interfejsu.

Pliki:

```text
apps/workers/src/agents/meta-agent/tool-definitions.ts
apps/workers/src/agents/meta-agent/tool-registry.ts
apps/workers/src/agents/meta-agent/index.ts
apps/workers/src/agents/meta-agent/prompts/react.md
scripts/generate-meta-agent-tool-docs.ts
apps/workers/src/agents/meta-agent/prompts/tools.md
```

Dodać narzędzia:

```ts
{
  name: "automation.request",
  description: "Tworzy request Automation Architecta i zleca zbudowanie speca. Nie tworzy ani nie aktywuje workflow bez dalszych etapów.",
  risk: "write",
  requiresApproval: false,
  category: "automation",
  argsSchema: z.object({
    rawText: nonEmptyString("rawText"),
    timezone: z.string().optional(),
    context: z.record(z.any()).optional().default({})
  })
}

{
  name: "automation.status",
  description: "Pobiera status automatyzacji po ID.",
  risk: "read",
  category: "automation",
  argsSchema: z.object({
    automationId: nonEmptyString("automationId")
  })
}
```

Handler `automation.request`:

```text
- tworzy automation_request
- dodaje job do queue agent-tasks-automation-architect workflow build-spec
- zwraca automationId, taskId, link /automations?automationId=...
```

Zaktualizować `fallbackIntent()` w Meta Agencie:

```text
/(zbuduj|stwórz|utwórz|dodaj).*(automatyzac|workflow|n8n|webhook)/i -> tool_request
```

Ograniczyć raw n8n tools:

```text
n8n.health -> zostaje
n8n.list_workflows -> zostaje read
n8n.get_workflow -> zostaje read
n8n.get_executions -> zostaje read
n8n.trigger -> zostaje external approval
n8n.update_workflow -> domyślnie ukryć albo zablokować feature flagą N8N_RAW_ADMIN_TOOLS_ENABLED
```

Ważne:

```text
N8N_RAW_ADMIN_TOOLS_ENABLED=false domyślnie
```

Acceptance criteria:

```text
- "Zbuduj automatyzację..." w chacie tworzy automation_request
- Meta Agent nie generuje n8n JSON w odpowiedzi
- użytkownik dostaje link/status
- raw n8n.update_workflow nie jest normalną ścieżką ReAct
```

### Etap 18 - Monitoring

Cel: wykrywać błędy aktywnych workflow zbudowanych przez Architecta.

Pliki:

```text
packages/automation-architect/src/core/monitorAutomations.ts
apps/workers/src/agents/automation-architect/index.ts
apps/dashboard/src/app/automations/AutomationTimeline.tsx
```

Flow:

```text
monitor-automations schedule
  -> find automation_requests status active
  -> for each n8nWorkflowId listExecutions(limit 10)
  -> save new execution snapshots
  -> if failed, append event execution_failed
  -> publish SSE event automation:execution_failed
```

Nie wysyłać Telegram alertów w MVP bez osobnego approvala. Najpierw dashboard alert.

Acceptance criteria:

```text
- failed execution pojawia się w detail automatyzacji
- event trafia do automation_events
- dashboard może pokazać alert
```

### Etap 19 - Debug loop

Cel: automatyczne poprawki po failed test, ale z limitem.

Pliki:

```text
packages/automation-architect/src/prompts/executionDebug.prompt.ts
packages/automation-architect/src/testing/proposeFixes.ts
packages/automation-architect/src/core/applyWorkflowFix.ts
```

Flow:

```text
test failed
  -> analyzeExecution()
  -> proposeFixes()
  -> apply minimal patch to inactive workflow JSON
  -> validateGeneratedWorkflow()
  -> scoreRiskFromWorkflow()
  -> if risk increased, require new approval
  -> update inactive workflow
  -> rerun test
```

Limit:

```text
AUTOMATION_MAX_FIX_ATTEMPTS=3
```

W MVP debug loop może być manualny:

```text
- system pokazuje suggestedFix
- user klika "Apply suggested fix"
```

Acceptance criteria:

```text
- po 3 próbach system zatrzymuje się
- patch nie może wprowadzić forbidden node
- patch nie może ustawić active=true
- każde update workflow ma audit event
```

### Etap 20 - Hardening i testy end-to-end

Cel: zamknąć ryzyka przed rozszerzaniem patternów.

Testy minimalne:

```text
pnpm --filter @af/automation-architect test
pnpm --filter @af/automation-architect typecheck
pnpm --filter @af/n8n typecheck
pnpm --filter @af/workers typecheck
pnpm -r typecheck
```

Testy kontraktowe:

```text
- automation.request -> Mongo request + queue payload
- build-spec -> spec + risk + event
- create-draft -> generated active=false + n8n.createWorkflow called
- activate without approval -> throws
- approve activation -> queue automation-architect/activate
- forbidden node -> blocked
- raw secret in workflow -> validation_failed
```

Manual E2E:

```text
1. Uruchom cały lokalny runtime przez ~/Pulpit/agentforge-start.sh albo scripts/start.sh.
2. Sprawdź startup summary:
   - Dashboard: http://localhost:3000
   - n8n: http://localhost:5678
   - n8n public: https://....trycloudflare.com
   - MongoDB: localhost:27017
   - Redis: localhost:6379
   - Ollama: localhost:11434
   - Queues zawiera agent-tasks-automation-architect
3. Sprawdź .logs/worker.log, czy worker załadował automation-architect.
4. Wejdź /automations.
5. Wpisz:
   Zbuduj automatyzację, która codziennie o 08:00 sprawdza blog konkurencji i jeśli znajdzie słowo GastroBridge, wysyła mi alert na Telegram.
6. Sprawdź, że powstał AutomationSpec.
7. Sprawdź RiskReport medium.
8. Sprawdź WorkflowPlan.
9. Kliknij Create draft.
10. Otwórz n8n i potwierdź inactive workflow.
11. Uruchom test.
12. Request activation approval.
13. Zatwierdź.
14. Sprawdź active=true w n8n.
15. Sprawdź event timeline.
```

Acceptance criteria:

```text
- MVP działa end-to-end dla jednego patternu
- aktywacja bez approvala jest niemożliwa
- n8n raw JSON nie jest ścieżką Meta Agenta
- sekrety nie pojawiają się w logach, DB eventach ani promptach
- workflow używa lokalnego n8n REST URL do operacji backendowych i publicznego Cloudflare URL tylko do webhooków
```

### Etap 21 - MCP optional, nie MVP

MCP dodać dopiero po działającym REST + patterns MVP.

Pliki później:

```text
packages/automation-architect/src/n8n/n8nMcpClient.ts
```

Feature flag:

```env
AUTOMATION_ALLOW_MCP=false
```

MCP może pomóc w:

```text
- search_nodes
- get_node_types
- validate_workflow
- test_workflow
```

Zasada:

```text
Jeśli MCP nie działa, system dalej działa przez REST + pattern library.
```

## 8. Kolejność pracy krok po kroku

Najbardziej praktyczna kolejność:

```text
1. Etap 0: n8n local audit
2. Etap 1: utwórz @af/automation-architect
3. Etap 2: env i healthchecki
4. Etap 3: rozszerz @af/n8n
5. Etap 4: typy i Zod schemas
6. Etap 5: risk engine
7. Etap 6: pattern library
8. Etap 7: buildAutomationSpec
9. Etap 8: WorkflowPlan
10. Etap 9: generator + validator dla schedule-http-if-telegram
11. Etap 10: Mongo store + service
12. Etap 11: create inactive draft
13. Etap 12: AutomationArchitectAgent + queue
14. Etap 13: API Next.js
15. Etap 14: dashboard UI
16. Etap 15: activation approval
17. Etap 16: test runner + execution parser
18. Etap 17: Meta Agent tool automation.request/status
19. Etap 18: monitoring
20. Etap 19: debug loop
21. Etap 20: hardening
22. Etap 21: MCP optional
```

Nie robić dashboardu przed core risk/generator validation. UI bez backend guardrails da fałszywe poczucie bezpieczeństwa.

## 9. MVP scope

MVP ma obsłużyć:

```text
Schedule/RSS/HTTP -> keyword filter -> Telegram alert
```

Obsługiwane:

```text
- dashboard request form
- Meta Agent automation.request
- AutomationSpec
- RiskReport low/medium
- Pattern selection
- WorkflowPlan
- generate inactive n8n draft
- static validation
- activation approval
- activate after approval
- basic execution listing
```

Nieobsługiwane w MVP:

```text
- Gmail send
- public posting
- production DB writes
- filesystem
- shell command
- SSH
- payments
- invoices
- full MCP
- arbitrary n8n node generation
- fully automatic debug loop
```

MVP jest gotowe, gdy:

```text
1. User wpisuje request w /automations albo Meta Agent chat.
2. System tworzy AutomationSpec.
3. System pokazuje RiskReport.
4. System wybiera pattern.
5. System pokazuje WorkflowPlan.
6. System tworzy inactive draft w n8n.
7. User widzi workflow w n8n.
8. System wymaga approval przed activation.
9. Po approval aktywuje workflow.
10. Execution errors są widoczne w dashboardzie.
```

## 10. Miejsca szczególnie ryzykowne w obecnym kodzie

### 10.1. Raw n8n update tool

Obecny tool:

```text
n8n.update_workflow
```

jest za szeroki dla docelowego modelu. Nawet jeśli wymaga approvala, pozwala Meta Agentowi przepchnąć raw JSON. Wprowadzić flagę:

```env
N8N_RAW_ADMIN_TOOLS_ENABLED=false
```

Jeśli false:

```text
- nie renderować n8n.update_workflow w ReAct prompt
- handler zwraca controlled error
- używać automation.request zamiast tego
```

### 10.2. Global autonomy

Obecny `executeMetaAgentTool()` omija approval, jeśli `system_autonomy` jest true.

Automation Architect activation nie może polegać tylko na tym mechanizmie. `activateAutomationWorkflow()` musi sam sprawdzić approved approval dla konkretnego `automationId`, `workflowId` i `action`.

### 10.3. Dashboard raw import/delete

Obecne `/api/automations?action=import` i `DELETE /api/automations?id=...` powinny zostać przeniesione do `/api/n8n` i opisane jako admin-only local tooling. Nie używać ich w flow Architecta.

### 10.4. Secrets in helper scripts

`scripts/n8n-prep-info.ts` wypisuje sekrety z `.env`. Nie używać tego wzorca w Automation Architect. Nowe logi i UI pokazują tylko:

```text
- configured / missing
- credential name
- setup instructions
```

Nigdy token.

### 10.5. Adresy w instrukcjach n8n credentials

Obecny `scripts/n8n-prep-info.ts` sugeruje miejscami adresy typowe dla kontenerów w jednej sieci Docker, np. `af-mongodb` albo `host.docker.internal`. Przy aktualnym `docker-compose.yml` n8n ma `network_mode: host`, więc dla n8n poprawne adresy lokalne to:

```text
MongoDB: localhost:27017
Ollama: http://localhost:11434
Dashboard/API: http://localhost:3000
```

Automation Architect nie powinien kopiować bezrefleksyjnie `scripts/n8n-prep-info.ts`. Ma brać adresy z macierzy runtime i z bieżącego `docker-compose.yml`.

## 11. Dokumentacja, którą dopisać

Po implementacji dodawać i aktualizować:

```text
docs/automation-architect/n8n-local-audit.md
docs/automation-architect/patterns.md
docs/automation-architect/risk-policy.md
docs/automation-architect/credential-policy.md
docs/automation-architect/manual-e2e.md
docs/project-documentation.md
docs/improvement-plan.md
```

W `docs/improvement-plan.md` dodać etap:

```text
## Etap 13 - Automation Architect
- [ ] @af/automation-architect package
- [ ] risk engine
- [ ] pattern library
- [ ] inactive n8n draft
- [ ] activation approval
- [ ] Meta Agent automation.request
```

## 12. Finalna checklista bezpieczeństwa

Przed uznaniem projektu za gotowy:

```text
- [ ] Każdy workflow ma AutomationSpec.
- [ ] Każdy workflow ma RiskReport.
- [ ] Workflow draft zawsze ma active=false.
- [ ] Forbidden node types są blokowane.
- [ ] Raw secrets są wykrywane i blokowane.
- [ ] Critical risk jest blocked.
- [ ] Medium/high wymagają approval przed activation.
- [ ] Activation bez approvala failuje w backendzie.
- [ ] Global autonomy nie omija activation approval.
- [ ] Meta Agent nie ma domyślnego raw n8n.update_workflow.
- [ ] Dashboard nie używa raw n8n import jako flow Architecta.
- [ ] Mongo zapisuje request/spec/plan/build/test/event.
- [ ] n8nWorkflowId jest powiązany z automationId.
- [ ] Execution errors są widoczne w dashboardzie.
- [ ] scripts/start.sh buduje @af/n8n i @af/automation-architect.
- [ ] Startup summary pokazuje agent-tasks-automation-architect.
- [ ] N8N_BASE_URL pozostaje lokalne: http://localhost:5678.
- [ ] N8N_PUBLIC_WEBHOOK_BASE_URL/N8N_WEBHOOK_URL wskazuje bieżący Cloudflare tunnel, gdy workflow wymaga public webhooka.
- [ ] Instrukcje credentials dla n8n używają localhost:27017 i localhost:11434 przy obecnym network_mode: host.
- [ ] Testy risk/generator/validator przechodzą.
- [ ] pnpm -r typecheck przechodzi.
```

## 13. Rekomendacja końcowa

Implementuj od małego, pionowego MVP:

```text
request -> spec -> risk -> pattern -> plan -> inactive n8n draft -> approval -> activation
```

Dopiero potem rozszerzaj:

```text
- więcej patternów
- real credentials tests
- debug loop
- monitoring alerty Telegram
- MCP
- bardziej rozbudowany edytor workflow planu
```

Najważniejsza korekta względem pierwotnego planu:

```text
W tym repo Automation Architect powinien być nowym agentem w istniejącym systemie workerów,
a nie osobnym workerem pisanym od zera.
```

Najważniejsza korekta względem obecnego kodu:

```text
Obecne raw n8n narzędzia i endpointy mogą zostać jako admin utilities,
ale nie mogą być ścieżką budowania automatyzacji przez Meta Agenta.
```
