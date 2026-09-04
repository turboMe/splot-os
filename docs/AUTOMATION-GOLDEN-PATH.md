# Automation Golden Path

Automation Golden Path is the deterministic runtime gate behind
`architect_execute_automation_request`.

It accepts:

```text
mode=pattern
mode=workflow_file
mode=workflow_json
```

and runs:

```text
resolve workflow -> capability coverage -> runtime check -> draft validation -> risk -> inactive deploy -> mock test -> optional activation
```

## Semantic Coverage Gate

The coverage gate prevents a local pattern from deploying an inactive n8n
workflow that is structurally valid but semantically incomplete for the user
request.

Coverage has two sides:

```text
required        capabilities the request/spec needs
forbidden       capabilities explicitly excluded by the request
missingRequired required capabilities absent from the candidate
forbiddenActual forbidden capabilities present in the candidate
```

Important parser rules:

- inbound `POST webhook` means `trigger.webhook` and
  `operation.webhook.receive`; it does not imply outbound
  `operation.http.post`.
- outbound HTTP POST is inferred only from phrases such as "send HTTP POST to
  the CRM/API" or "HTTP Request node POST".
- negations such as `no Mongo`, `no Telegram`, `no HTTP Request node`, `bez
  Mongo` are converted into `coverage.forbidden`, not `required`.

Example blocked case:

```text
request/spec requires:
- trigger.webhook
- operation.payload.validate
- operation.mongo.insert
- sideEffect.db.write
- operation.webhook.respond

pattern webhook-validate-respond provides:
- Webhook Trigger
- Code validation
- Respond to Webhook
```

The workflow is valid n8n JSON, but it omits MongoDB insert. Golden Path blocks
it before runtime checks and before n8n deploy.

Blocked result shape:

```json
{
  "success": false,
  "status": "blocked",
  "failureClass": "pattern_coverage_gap",
  "coverage": {
    "ok": false,
    "missingRequired": ["operation.mongo.insert", "sideEffect.db.write"],
    "forbiddenActual": [],
    "recommendation": "delegate_mcp"
  }
}
```

Recovery strategies:

```text
delegate_to_n8n_mcp_engineer
select_more_specific_pattern
compose_custom_workflow_json_then_rerun_golden_path
```

## Workflow Validation Hardening

Golden Path draft validation also catches common live-test failures:

- `Respond to Webhook` with `respondWith=json` must define a non-empty
  `responseBody`; use an explicit expression such as `={{ $json }}` when the
  Code node already produced the response JSON.
- Webhook-triggered Code nodes must normalize n8n's webhook envelope before
  reading user fields. Incoming request JSON is normally under `$json.body`,
  while root `$json` also contains webhook metadata. Use the `$json.body ??
  $json` shape:

```js
const envelope = items[0]?.json || {};
const payload = envelope.body && typeof envelope.body === "object" ? envelope.body : envelope;
```
- n8n create/update payloads are sanitized before REST calls. Top-level
  read-only fields such as `id`, `active`, `tags`, `versionId`, `createdAt`,
  `updatedAt`, `triggerCount`, `shared`, and `isArchived` are stripped from the
  workflow envelope. Node ids are preserved because connections may reference
  them during validation/repair.

## Configuration

```env
AUTOMATION_COVERAGE_GATE_MODE=warn
AUTOMATION_COVERAGE_MIN_SCORE=1
KEEP_SMOKE_WORKFLOWS=false
```

Modes:

```text
off   disabled
warn  include coverage in result but do not block
block block critical capability gaps before deploy
```

Local development can use:

```env
AUTOMATION_COVERAGE_GATE_MODE=block
```

## Checks

Run deterministic checks:

```bash
npm run check:automation-coverage
npm run check:automation-patterns
npm run check:automation-golden-path
```

Optional integration smoke:

```bash
npm run check:n8n-mcp-pipeline-smoke
RUN_N8N_MCP_PIPELINE_LIVE=true npm run check:n8n-mcp-pipeline-smoke -- delegation-only
```

The default smoke mode is `coverage-block`; it does not activate workflows and
should not create a workflow because the gap is blocked before deploy.
