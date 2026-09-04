# n8n MCP Engineer

`n8nMcpEngineer` is a narrow read-only/design-only subagent for `automationArchitect`.
It gives Automation Architect access to `n8n-mcp` node documentation, templates,
examples, and validation without creating a second mutation path into n8n.

## MVP Boundary

The MVP boundary is intentionally strict:

- `automationArchitect` owns requirements, Golden Path, risk scoring, deployment,
  testing, audit trail, and activation.
- `n8nMcpEngineer` only performs MCP research and validation.
- `metaAgent` and other agents cannot call `n8nMcpEngineer` directly through
  `system_delegate_task`; the delegation tool blocks callers other than
  `automationArchitect`.
- `N8N_API_KEY` is not passed to `n8n-mcp` while `N8N_MCP_MODE=readonly`.

Allowed MCP tools:

```text
tools_documentation
search_nodes
get_node
search_templates
get_template
validate_node
validate_workflow
```

Forbidden in MVP:

```text
n8n_create_workflow
n8n_update_full_workflow
n8n_update_partial_workflow
n8n_delete_workflow
n8n_activate_workflow
n8n_deploy_template
n8n_manage_credentials
n8n_autofix_workflow
n8n_test_workflow
n8n_executions
```

## Configuration

Enable the MCP server only when needed:

```env
FEATURE_N8N_MCP=true
N8N_MCP_ENABLED=true
N8N_MCP_MODE=readonly
N8N_MCP_LOG_LEVEL=error
N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS=20
N8N_MCP_VALIDATE_WORKFLOW_MODE=advisory
```

`src/mastra/mcp.ts` starts:

```text
npx -y n8n-mcp
```

with:

```text
MCP_MODE=stdio
LOG_LEVEL=error
DISABLE_CONSOLE_OUTPUT=true
```

In `readonly` mode, Mastra does not pass `N8N_API_KEY` to the MCP process. The
subagent also allowlists only the non-mutating tools above, so the safety model
does not depend only on process environment.

For live tests against a built Mastra artifact, start the server with env preload:

```bash
npm run start:built
```

This runs `node --import dotenv/config .mastra/output/index.mjs`. Starting the
built file directly with plain `node .mastra/output/index.mjs` does not load
`.env`, so cloud model gateway keys and feature flags may be missing.

Known local topology is included in the agent prompt:

```text
Mastra Studio/API: http://localhost:4111
n8n REST/UI: http://localhost:5678
Ollama: http://localhost:11434
MongoDB: localhost:27017/agentforge
```

## Delegation Flow

Normal flow:

```text
user/metaAgent
  -> automationArchitect
      -> system_delegate_task(targetAgent="n8nMcpEngineer", callerAgentId="automationArchitect")
          -> search_templates / get_template / search_nodes / get_node / validate_node / validate_workflow
      -> architect_validate_workflow
      -> architect_risk_score
      -> architect_deploy_automation
      -> architect_test_workflow
      -> architect_activate_automation
```

Direct flow is blocked:

```text
metaAgent -> n8nMcpEngineer
```

The delegation guard lives in `src/mastra/tools/system/delegate-task.ts` and
returns `n8n_mcp_engineer_caller_not_allowed` for non-architect callers.

`system_delegate_task` is recorded through the standard tool envelope, so
delegation attempts appear in tool execution telemetry with `toolId:
system_delegate_task`.

For `targetAgent="n8nMcpEngineer"`, the delegation result is contract-checked.
The result must be read-only and include usable node/template/validation
evidence such as `search_nodes`, `get_node`, `validate_workflow`,
`typeVersion`, `nodePlan`, `validation findings`, or `readyForGoldenPath`.
Empty handoffs, mutation claims, or missing evidence return `success:false`
with an `n8n_mcp_handoff_*` error.

Delegations to `n8nMcpEngineer` use
`N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS` (default `20`, hard ceiling `24`) to
keep synchronous MCP handoffs under the HTTP wrapper budget while leaving
enough room to validate several instances of one unfamiliar node type in a
single handoff (raised from `8` on 2026-08-25 after it measured 6/8 empty
handoffs on a task validating 7 `htmlExtract` instances). The agent's direct
default can remain higher for interactive Studio use.

`validate_workflow` is wrapped defensively. By default
`N8N_MCP_VALIDATE_WORKFLOW_MODE=advisory`, so the tool returns an immediate
read-only advisory and Automation Architect's own Golden Path validator remains
the deployment gate. Set `N8N_MCP_VALIDATE_WORKFLOW_MODE=live` only after the
installed `n8n-mcp` version no longer emits non-string `errors[].details`
values that violate its declared MCP schema. In live mode, that specific schema
exception is still converted into
`n8n_mcp_validate_workflow_schema_mismatch`.

## Automation Architect Contract

Automation Architect should delegate to `n8nMcpEngineer` when:

- no local Pattern RAG match is strong enough,
- Pattern RAG, Composer, or Golden Path reports `coverage.ok=false` or
  `pattern_coverage_gap`,
- a node/operation/typeVersion is uncertain,
- an n8n.io template may exist,
- validation errors are hard to interpret,
- the workflow uses Gmail, Google Sheets, Slack, Telegram, MongoDB, HTTP Request,
  Webhook, Code node, AI Agent, binary data, or complex expressions.

Recommended delegation brief:

```json
{
  "goal": "Find templates/nodes and validate a workflow candidate for this automation.",
	  "context": {
	    "userRequest": "...",
	    "missingCapabilities": ["operation.mongo.insert", "sideEffect.db.write"],
	    "localServices": {
      "mastra": "http://localhost:4111",
      "n8n": "http://localhost:5678",
      "ollama": "http://localhost:11434",
      "mongo": "localhost:27017/agentforge"
    },
    "knownCredentials": ["telegram", "mongo", "gmail", "n8nApi"]
  },
  "constraints": [
    "Read-only/design-only",
    "No deployment",
    "No activation",
    "No credential changes",
    "Return JSON handoff for Automation Architect Golden Path"
  ]
}
```

Expected handoff:

```json
{
	  "summary": "short result",
	  "missingCapabilities": [],
	  "coverageNotes": [],
	  "templateCandidates": [],
  "selectedTemplate": null,
  "nodePlan": [],
  "validatedNodeConfigs": [],
  "workflowCandidate": null,
  "validation": null,
  "requiredCredentials": [],
  "topologyAssumptions": [],
  "openQuestions": [],
  "handoff": {
    "readyForGoldenPath": false,
    "reason": "what Automation Architect should do next"
  }
}
```

The returned workflow is a candidate only. Automation Architect must still run
its own Golden Path gates.

For `pattern_coverage_gap`, the expected handoff should explain which missing
capabilities are addressed by the proposed node plan. `n8nMcpEngineer` may
validate node configs and a candidate workflow, but it must not create, update,
activate, delete, test-run, or manage credentials in n8n.

If an MCP handoff is mandatory and `system_delegate_task` returns `success:false`,
Automation Architect must stop and report `blocked` with
`failureClass: "mcp_handoff_failed"`. It must not compose, deploy, test, or
activate a workflow after a failed mandatory handoff.

## Memory

`n8nMcpEngineer` has scoped Mastra Memory:

- `lastMessages: 24`
- thread-scoped observational memory
- working memory for runtime topology, node lessons, template lessons, handoff
  state, and safety notes

It does not receive `system_memory_write` in MVP. It should not store secret
values, credential IDs, API keys, tokens, passwords, or live customer payloads.

## Verification

Run:

```bash
npm run check:n8n-mcp-engineer
```

This static check verifies:

- agent ids and Mastra registration,
- readonly MCP configuration,
- allowed MCP tool names,
- forbidden mutation tool names are not allowlisted,
- `system_delegate_task` caller and async guards,
- `system_delegate_task` tool-envelope logging,
- n8n MCP handoff contract markers,
- `validate_workflow` schema-mismatch wrapper,
- `N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS`,
- `N8N_MCP_VALIDATE_WORKFLOW_MODE`,
- Automation Architect prompt instructions,
- `.env.example` feature flags.

For full regression coverage after related edits, also run:

```bash
npm run check:automation-delegation-contract
npm run check:automation-coverage
npm run check:n8n-mcp-pipeline-smoke
npm run check:automation-golden-path
npm run build
```

For a controlled live create/activate test of Automation Architect plus
`n8nMcpEngineer`, run:

```bash
npm run check:automation-live-safe-webhook
```

This direct harness creates a safe `Webhook -> Code -> Respond to Webhook`
workflow, verifies the node allowlist, inserts an approved activation token only
after that verification, activates through `architect_activate_automation`, and
POSTs to the webhook. Stop any built Mastra runtime first, because the direct
harness imports the Mastra instance and needs exclusive access to
`mastra.duckdb`.

## Post-MVP Options

These are intentionally outside MVP and should be enabled only after explicit
review:

1. Post-deploy read-only MCP validation: Automation Architect can ask MCP to
   validate a Mastra-managed deployed workflow by ID, without allowing mutation.
2. Partial update advisor: the subagent may propose
   `n8n_update_partial_workflow` operations as a JSON diff, but not execute them.
3. Dev-only mutation mode: `N8N_MCP_MODE=management` in a separate development
   n8n instance, never production, to test MCP create/update behavior.
4. Template ingestion into Pattern RAG: manually approved templates discovered by
   MCP can become local reusable patterns.
5. Workflow diff reviewer: compare current workflow JSON with a proposed
   candidate and report risk, node changes, credential impact, and trigger
   changes.
6. Credential-aware planner: expose credential types and availability, never
   secret values, so node configs can reference credentials more accurately.
7. Autofix advisor: allow MCP autofix only as a proposed patch source, with
   Automation Architect still owning validation, risk, deployment, and audit.
8. Async discovery: if template/node discovery becomes slow, add async
   delegation and pending updates for `n8nMcpEngineer`.
