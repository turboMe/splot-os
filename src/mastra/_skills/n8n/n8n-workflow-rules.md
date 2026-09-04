---
name: n8n-workflow-rules
category: n8n
description: Hard rules for building valid n8n workflows - node IDs, connections, expressions, settings
keywords: [n8n, workflow, rules, validation, build, json, nodes, connections]
recommendedTier: balanced
handoffCapable: true
---
# n8n Workflow Rules (Hard Constraints)

These rules are MANDATORY when constructing or modifying n8n workflow JSON.

## 1. Workflow Structure

Every workflow JSON must contain:
```json
{
  "name": "Workflow Name",
  "nodes": [...],
  "connections": {...},
  "settings": { "executionOrder": "v1" }
}
```

- `nodes` is an array of node objects
- `connections` maps source node names to arrays of destination connections
- `settings.executionOrder` must be `"v1"` for modern n8n

## 2. Node Object Requirements

Every node MUST have:
- `id` — unique lowercase string (e.g., `"webhook_trigger"`)
- `name` — human-readable display name (MUST be unique within the workflow)
- `type` — fully qualified node type (e.g., `"n8n-nodes-base.webhook"`)
- `typeVersion` — integer matching the installed n8n version
- `position` — `[x, y]` array for canvas placement (increment x by 250-300 per step)
- `parameters` — object with node-specific configuration

## 3. Connection Format

```json
{
  "connections": {
    "Source Node Name": {
      "main": [
        [{ "node": "Target Node Name", "type": "main", "index": 0 }]
      ]
    }
  }
}
```

- Keys are **node names** (not IDs)
- `main` contains an array of output arrays
- Output index 0 = default output
- Output index 1 = second output (e.g., IF node false branch)

## 4. IF Node Connections

IF nodes have TWO outputs:
- `main[0]` = TRUE branch
- `main[1]` = FALSE branch

```json
"IF Condition": {
  "main": [
    [{ "node": "True Handler", "type": "main", "index": 0 }],
    [{ "node": "False Handler", "type": "main", "index": 0 }]
  ]
}
```

## 5. Expression Syntax

n8n uses `={{ }}` for expressions:
- `={{ $json.fieldName }}` — access current item field
- `={{ $('Node Name').item.json.field }}` — access another node's output
- `={{ $input.all() }}` — all items from previous node
- `={{ $now.toISO() }}` — current timestamp

## 6. Runtime Values (Mastra Environment)

**Do NOT use `$vars.*`** — n8n Community Edition does not support global variables ($vars is an Enterprise feature).

Environment values are **injected automatically** when the system generates the workflow:
- `telegramChatId` — from `N8N_TELEGRAM_CHAT_ID` in .env
- `ollamaBaseUrl` — from `OLLAMA_BASE_URL_FOR_N8N` or `OLLAMA_BASE_URL` (default `http://localhost:11434`)
- `defaultLocalModel` — from `OLLAMA_DEFAULT_MODEL` (default `gemma4:26b`)
- `reasoningLocalModel` — from `OLLAMA_REASONING_MODEL`
- `agentForgeTaskEndpoint` — from `AGENTFORGE_TASK_ENDPOINT` or `MASTRA_API_URL_FOR_N8N/api/tasks`
- `agentForgeMemoryEndpoint` — from `AGENTFORGE_MEMORY_ENDPOINT` or `MASTRA_API_URL_FOR_N8N/api/shared-memory`
- `agentForgeCrmEndpoint` — from `AGENTFORGE_CRM_ENDPOINT` or `MASTRA_API_URL_FOR_N8N/api/crm`
- `agentForgeApprovalEndpoint` — from `AGENTFORGE_APPROVAL_ENDPOINT` or `MASTRA_API_URL_FOR_N8N/api/approvals`
- `geminiGatewayEndpoint` — from `GEMINI_GATEWAY_ENDPOINT` or `MASTRA_API_URL_FOR_N8N/api/agents/gemini`

Do not use `DASHBOARD_URL` or `localhost:3000` for new Mastra workflows.

In the generated workflow these values are hardcoded as literals (not expressions).

## 7. Credential References

Never hardcode credentials. Use n8n credential references:
```json
"credentials": {
  "telegramApi": { "id": "1", "name": "Telegram Bot" }
}
```

## 8. Common Mistakes to Avoid

- Do NOT set `"active": true` in workflow creation (n8n API rejects it)
- Do NOT duplicate node names within a workflow
- Do NOT use `typeVersion` higher than what's installed
- Do NOT create circular connections
- Do NOT leave dangling nodes without connections (except the last node)
- Always start with a trigger node (webhook, schedule, or manual)
