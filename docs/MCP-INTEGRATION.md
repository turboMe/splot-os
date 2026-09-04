# Integracje MCP w Mastra

System Jarvis wykorzystywał RAG oparty o dedykowany proces i API NotebookLM, co wiązało się z ręcznym przygotowywaniem schematów, promptów i zarządzaniem cyklem życia pamięci. 

W nowym środowisku Mastra przeszliśmy na **Model Context Protocol (MCP)**, co znacząco redukuje ilość własnego kodu ("boilerplate") potrzebnego do zintegrowania tego samego silnika.

## Architektura i Konfiguracja

1. W pliku `src/mastra/index.ts` inicjalizowany jest `MCPClient`.
2. Do tego klienta podłączamy `notebooklm-mcp` za pośrednictwem lokalnej komendy `uvx notebooklm-mcp` (działającej jako zewnętrzny serwer dostarczający gotowe narzędzia wiedzy).
3. Następnie wszystkie ujawnione z tego serwera narzędzia ładujemy bezpośrednio w obiekcie Mastra do konfiguracji `mcpServers`.

### Kod (src/mastra/index.ts)

```typescript
import { MCPClient } from '@mastra/mcp';

// 1. Zdefiniowanie Połączenia do serwera MCP
const mcpClient = new MCPClient({
  servers: {
    'notebooklm': {
      command: 'uvx',
      args: ['notebooklm-mcp'],
    },
  },
});

// 2. Przekazanie Proxies do Głównego obiektu Mastra
export const mastra = new Mastra({
  // ...
  mcpServers: {
    ...(await mcpClient.toMCPServerProxies()),
  },
  // ...
});
```

## Korzyści

Dzięki temu podejściu, narzędzia takie jak przeszukiwanie NotebookLM czy tworzenie podsumowań stają się natywnymi funkcjami dostępnymi dla każdego Agenta w systemie (lub dla Mastra Studio), bez potrzeby definiowania ich ręcznie poprzez własne pliki `createTool()`. Jeśli NotebookLM wyda nowe funkcje poprzez MCP, nasz system otrzyma je automatycznie przy kolejnym restarcie, ograniczając dług technologiczny.

## n8n MCP Engineer

`n8n-mcp` jest podłączany opcjonalnie w `src/mastra/mcp.ts` przez:

```text
FEATURE_N8N_MCP=true
N8N_MCP_ENABLED=true
N8N_MCP_MODE=readonly
N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS=20
N8N_MCP_VALIDATE_WORKFLOW_MODE=advisory
```

MVP używa go wyłącznie przez subagenta `n8nMcpEngineer`, który jest dostępny
tylko dla `automationArchitect`. Ten subagent ma allowlistę read-only:

```text
tools_documentation
search_nodes
get_node
search_templates
get_template
validate_node
validate_workflow
```

Nie przekazujemy `N8N_API_KEY` do procesu MCP w trybie `readonly`; deployment,
update, testy real-credential i aktywacja nadal przechodzą przez narzędzia
`architect_*` oraz Golden Path architekta.

Szczegółowy kontrakt, polityka bezpieczeństwa i plan post-MVP są w
[`N8N-MCP-ENGINEER.md`](N8N-MCP-ENGINEER.md).

## Automation Coverage Gate

Automation Architect uses a semantic coverage gate before Golden Path deploy.
If a local pattern is similar but incomplete, the runtime returns
`pattern_coverage_gap` and includes `coverage.missingRequired`, for example:

```text
operation.mongo.insert
sideEffect.db.write
```

In that case Automation Architect should delegate read-only discovery and
validation to `n8nMcpEngineer`, or compose a complete custom `workflow_json`,
then rerun Golden Path. Deployment, update, testing against real credentials,
and activation still remain outside MCP and go through the `architect_*`
runtime gates.

The coverage parser distinguishes inbound webhook methods from outbound HTTP
side effects. `POST webhook` does not require `operation.http.post`; only
phrases such as "send HTTP POST to API/CRM" do. Negated constraints such as
`no Mongo`, `no Telegram`, or `no HTTP Request node` become
`coverage.forbidden` and block only when the candidate includes
`coverage.forbiddenActual`.

Mandatory MCP handoffs are fail-closed. If `n8nMcpEngineer` cannot return a
usable read-only handoff with node/template/validation evidence,
`system_delegate_task` returns `success:false`, and Automation Architect must
stop with `mcp_handoff_failed` instead of deploying from a manual fallback.

Live tests against a built Mastra artifact should use:

```bash
npm run start:built
```

This preloads `.env` with `dotenv/config`. Do not shell-source `.env`; some
values contain spaces and are not safe shell assignments.

The `validate_workflow` MCP tool is wrapped for a known schema compatibility
case where `n8n-mcp` emits non-string `errors[].details`. The default
`N8N_MCP_VALIDATE_WORKFLOW_MODE=advisory` returns immediately and leaves final
workflow validation to Automation Architect's Golden Path. `live` mode can be
re-enabled after the installed MCP server schema is compatible; even then, the
wrapper converts the known schema exception into a controlled
`n8n_mcp_validate_workflow_schema_mismatch` result.

Config:

```env
AUTOMATION_COVERAGE_GATE_MODE=warn
AUTOMATION_COVERAGE_MIN_SCORE=1
KEEP_SMOKE_WORKFLOWS=false
```

More details: [`AUTOMATION-GOLDEN-PATH.md`](AUTOMATION-GOLDEN-PATH.md).
