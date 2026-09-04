---
name: n8n-node-catalog
category: n8n
description: Top 50 n8n node types with correct typeVersion and required parameters
keywords: [n8n, nodes, catalog, types, parameters, typeVersion, reference]
recommendedTier: balanced
handoffCapable: true
---
# n8n Node Catalog (Top 50)

## Triggers

### n8n-nodes-base.webhook (typeVersion: 2)
- Required: `path`, `httpMethod` (GET/POST/PUT/DELETE)
- Optional: `authentication`, `responseMode`, `responseData`
- Notes: Use `responseMode: "responseNode"` for custom responses

### n8n-nodes-base.scheduleTrigger (typeVersion: 1.2)
- Required: `rule` object with `interval` array
- Example: `{ "rule": { "interval": [{ "field": "minutes", "minutesInterval": 30 }] } }`
- Notes: Use for periodic polling workflows

### n8n-nodes-base.manualTrigger (typeVersion: 1)
- Required: none
- Notes: For testing or manually-triggered workflows

### n8n-nodes-base.errorTrigger (typeVersion: 1)
- Required: none
- Notes: Trigger when another workflow fails (set in error workflow settings)

## Core Processing

### n8n-nodes-base.code (typeVersion: 2)
- Required: `jsCode` (string of JavaScript)
- Optional: `mode` ("runOnceForAllItems" | "runOnceForEachItem")
- Notes: Default mode processes all items at once. Access items via `$input.all()`

### n8n-nodes-base.if (typeVersion: 2)
- Required: `conditions` with `options` array
- Example: `{ "conditions": { "options": { "conditions": [{ "leftValue": "={{ $json.type }}", "rightValue": "alert", "operator": { "type": "string", "operation": "equals" } }] } } }`
- Notes: Two outputs — index 0 (true), index 1 (false)

### n8n-nodes-base.switch (typeVersion: 3)
- Required: `rules` with routing conditions
- Notes: Multiple named outputs for routing

### n8n-nodes-base.set (typeVersion: 3.4)
- Required: `assignments` array
- Example: `{ "assignments": { "assignments": [{ "name": "field", "value": "={{ $json.original }}", "type": "string" }] } }`

### n8n-nodes-base.merge (typeVersion: 3)
- Required: `mode` ("combine" | "append" | "chooseBranch")
- Notes: Combines data from two input branches

### n8n-nodes-base.splitInBatches (typeVersion: 3)
- Required: `batchSize` (number)
- Notes: Process items in batches, useful for rate limiting

### n8n-nodes-base.filter (typeVersion: 2)
- Required: `conditions` with filter logic
- Notes: Keeps items that match, discards others

### n8n-nodes-base.removeDuplicates (typeVersion: 1)
- Required: `fieldsToCompare` (which fields define uniqueness)
- Notes: Removes duplicate items based on field comparison

## HTTP & APIs

### n8n-nodes-base.httpRequest (typeVersion: 4.2)
- Required: `url`, `method` (GET/POST/PUT/DELETE/PATCH)
- Optional: `sendBody`, `contentType`, `specifyBody`, `jsonBody`, `authentication`, `options`
- Notes: Most versatile node. Use for Ollama, AgentForge API, any REST call

### n8n-nodes-base.respondToWebhook (typeVersion: 1.1)
- Required: `respondWith` ("text" | "json" | "noData")
- Optional: `responseBody`, `responseCode`
- Notes: Must be connected to a Webhook trigger node

## Communication

### n8n-nodes-base.telegram (typeVersion: 1)
- Required: `chatId`, `text`
- Optional: `additionalFields.parse_mode` ("Markdown" | "HTML")
- Credentials: `telegramApi`
- Notes: Chat ID is injected at generation time from N8N_TELEGRAM_CHAT_ID env var. Do NOT use $vars.

### n8n-nodes-base.emailSend (typeVersion: 2.1)
- Required: `fromEmail`, `toEmail`, `subject`, `text`
- Credentials: `smtp`

### n8n-nodes-base.slack (typeVersion: 2.2)
- Required: `channel`, `text`
- Credentials: `slackApi`

## Database

### n8n-nodes-base.mongoDb (typeVersion: 1)
- Required: `operation` ("find" | "insert" | "update" | "delete"), `collection`
- Credentials: `mongoDb`
- Notes: Prefer AgentForge API over direct MongoDB when possible

### n8n-nodes-base.postgres (typeVersion: 2.5)
- Required: `operation`, `query` (for raw queries)
- Credentials: `postgres`

## Data Sources

### n8n-nodes-base.rssFeedRead (typeVersion: 1)
- Required: `url` (RSS feed URL)
- Notes: Returns items with title, description, link, pubDate

### n8n-nodes-base.readWriteFile (typeVersion: 1)
- Required: `operation` ("read" | "write"), `fileName`

## Utility

### n8n-nodes-base.dateTime (typeVersion: 2)
- Required: `action` ("format" | "calculate")
- Notes: Date formatting and arithmetic

### n8n-nodes-base.crypto (typeVersion: 1)
- Required: `action` ("hash" | "hmac" | "sign" | "encrypt" | "decrypt")
- Notes: Useful for webhook signature verification

### n8n-nodes-base.wait (typeVersion: 1.1)
- Required: `amount`, `unit`
- Notes: Pause execution for specified duration

### n8n-nodes-base.noOp (typeVersion: 1)
- Required: none
- Notes: Pass-through node, useful for merge points

### n8n-nodes-base.stickyNote (typeVersion: 1)
- Required: `content`
- Notes: Visual annotation, no execution effect

## AI / LLM Integration (via HTTP Request)

For Ollama integration, use `n8n-nodes-base.httpRequest` with hardcoded URLs (injected at generation time):
```json
{
  "method": "POST",
  "url": "http://localhost:11434/api/chat",
  "sendBody": true,
  "contentType": "json",
  "specifyBody": "json",
  "jsonBody": "={{ JSON.stringify({ model: 'gemma4:26b', stream: false, messages: [{role:'user', content: $json.text}] }) }}"
}
```

Note: URL and model are baked in at workflow generation time from OLLAMA_BASE_URL / OLLAMA_DEFAULT_MODEL env vars.
Do NOT use `$vars.*` — it is not available in n8n Community Edition.
