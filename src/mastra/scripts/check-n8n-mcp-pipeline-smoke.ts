#!/usr/bin/env tsx
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { executeAutomationGoldenPath } from '../services/automation-golden-path.js';
import { N8nService } from '../tools/n8n/client.js';
import { getDb } from '../lib/mongo.js';
import type { AutomationSpec } from '../tools/architect/types.js';

type SmokeMode = 'coverage-block' | 'delegation-only' | 'all';

const mode = (process.argv[2] ?? 'coverage-block') as SmokeMode;

if (!['coverage-block', 'delegation-only', 'all'].includes(mode)) {
  throw new Error(`Unknown smoke mode: ${mode}. Use coverage-block, delegation-only, or all.`);
}

const results: string[] = [];

if (mode === 'coverage-block' || mode === 'all') {
  await runCoverageBlock();
  results.push('coverage-block=passed');
}

if (mode === 'delegation-only' || mode === 'all') {
  const liveEnabled = /^(true|1|yes|on)$/i.test(process.env.RUN_N8N_MCP_PIPELINE_LIVE ?? '');
  if (mode === 'all' && !liveEnabled) {
    results.push('delegation-only=skipped (set RUN_N8N_MCP_PIPELINE_LIVE=true)');
  } else {
    await runDelegationOnly();
    results.push('delegation-only=passed');
  }
}

console.log('n8n MCP pipeline smoke completed');
for (const result of results) console.log(result);
process.exit(0);

async function runCoverageBlock(): Promise<void> {
  const previousMode = process.env.AUTOMATION_COVERAGE_GATE_MODE;
  const automationId = `check-mcp-smoke-${Date.now()}`;
  process.env.AUTOMATION_COVERAGE_GATE_MODE = 'block';

  try {
    const result = await executeAutomationGoldenPath({
      mode: 'pattern',
      automationId,
      patternId: 'webhook-validate-respond',
      request: 'Webhook przyjmuje lead, waliduje email i message, zapisuje lead do MongoDB agentforge.leads, zwraca JSON { ok: true }. Nie aktywuj workflow.',
      spec: buildWebhookMongoSpec(),
      workflowName: `Mastra Smoke Coverage ${randomUUID().slice(0, 8)}`,
      activate: false,
      allowDraftWithMissingCredentials: true,
    });

    assert.equal(result.success, false, 'coverage-block must not succeed');
    assert.equal(result.status, 'blocked', 'coverage-block must return blocked');
    assert.equal(result.failureClass, 'pattern_coverage_gap', 'coverage-block must return pattern_coverage_gap');
    assert.equal(result.workflowId, undefined, 'coverage-block must happen before n8n deploy');
    assert.ok(result.coverage?.missingRequired.includes('operation.mongo.insert'), 'missing operation.mongo.insert');
    assert.ok(result.coverage?.missingRequired.includes('sideEffect.db.write'), 'missing sideEffect.db.write');
  } finally {
    await cleanupAutomation(automationId);
    if (previousMode === undefined) {
      delete process.env.AUTOMATION_COVERAGE_GATE_MODE;
    } else {
      process.env.AUTOMATION_COVERAGE_GATE_MODE = previousMode;
    }
  }
}

async function cleanupAutomation(automationId: string): Promise<void> {
  const db = await getDb();
  await db.collection('automation_requests').deleteMany({ automationId }).catch(() => undefined);
  await db.collection('automation_events').deleteMany({ automationId }).catch(() => undefined);
  await db.collection('automation_workflow_snapshots').deleteMany({ automationId }).catch(() => undefined);
}

async function runDelegationOnly(): Promise<void> {
  if (!/^(true|1|yes|on)$/i.test(process.env.FEATURE_N8N_MCP ?? process.env.N8N_MCP_ENABLED ?? '')) {
    throw new Error('delegation-only requires FEATURE_N8N_MCP=true or N8N_MCP_ENABLED=true.');
  }

  const before = await safeWorkflowCount();
  const thread = `n8n-mcp-smoke-${Date.now()}`;
  const resource = 'n8n-mcp-pipeline-smoke';
  const prompt = [
    'Design-only smoke test. Do not deploy, do not activate, do not call architect_execute_automation_request.',
    'We need a workflow: Webhook receives lead JSON, validates email/message, inserts into MongoDB agentforge.leads, returns JSON { ok: true }.',
    'Use system_delegate_task with targetAgent "n8nMcpEngineer" and callerAgentId "automationArchitect" to inspect/validate the MongoDB node or template plan.',
    'Return a concise summary only after the delegation result. No n8n mutation tools are allowed.',
  ].join('\n');

  const response = await generateViaAutomationArchitectWrapper({
    prompt,
    thread,
    resource,
    maxSteps: 12,
  });

  const steps = Array.isArray(response?.steps) ? response.steps : [];
  const delegation = hasN8nMcpDelegation(steps);
  assert.ok(delegation, `expected delegation to n8nMcpEngineer; observed tools=${summarizeToolNames(steps)}`);
  assert.ok(
    hasN8nMcpDiscoverySignal(steps, response?.text),
    'expected at least one n8n MCP discovery/validation signal in steps or handoff text',
  );
  assert.ok(!hasForbiddenMutationTool(steps), `forbidden mutation tool observed: ${summarizeToolNames(steps)}`);

  const after = await safeWorkflowCount();
  if (before !== null && after !== null) {
    assert.equal(after, before, 'delegation-only must not change n8n workflow count');
  }
}

async function generateViaAutomationArchitectWrapper(input: {
  prompt: string;
  thread: string;
  resource: string;
  maxSteps: number;
}): Promise<any> {
  const baseUrl = (process.env.MASTRA_STUDIO_URL || 'http://localhost:4111').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/deploy/automation-architect/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      threadId: input.thread,
      resourceId: input.resource,
      maxSteps: input.maxSteps,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await response.json().catch(() => ({}));
  assert.ok(response.ok, `automationArchitect wrapper failed ${response.status}: ${JSON.stringify(json).slice(0, 1000)}`);
  return json;
}

function hasN8nMcpDelegation(steps: unknown[]): boolean {
  return collectRecords(steps).some((record) => {
    const toolName = stringValue(record.toolName) ?? stringValue(record.name) ?? '';
    const args = recordValue(record.args) ?? recordValue(record.input);
    const result = recordValue(record.result) ?? recordValue(record.output);
    return (
      /delegateTaskTool|system_delegate_task/.test(toolName) &&
      (
        stringValue(args?.targetAgent) === 'n8nMcpEngineer' ||
        stringValue(result?.agentUsed) === 'n8nMcpEngineer' ||
        stringValue(result?.targetAgent) === 'n8nMcpEngineer'
      )
    );
  });
}

function hasN8nMcpDiscoverySignal(steps: unknown[], text?: string): boolean {
  const serialized = JSON.stringify(steps) + '\n' + String(text ?? '');
  return /search_nodes|get_node|search_templates|get_template|validate_node|validate_workflow|missingCapabilities|n8nMcpHandoff/.test(serialized);
}

function hasForbiddenMutationTool(steps: unknown[]): boolean {
  return collectRecords(steps).some((record) => {
    const toolName = stringValue(record.toolName) ?? stringValue(record.name) ?? '';
    return /architect_deploy_automation|architect_activate_automation|architect_execute_automation_request|architect_start_automation_job|n8n_create_workflow|n8n_update|n8n_activate|n8n_delete/.test(toolName);
  });
}

function summarizeToolNames(steps: unknown[]): string {
  return [...new Set(collectRecords(steps)
    .map((record) => stringValue(record.toolName) ?? stringValue(record.name))
    .filter(Boolean))]
    .join(', ');
}

async function safeWorkflowCount(): Promise<number | null> {
  if (!process.env.N8N_API_KEY) return null;
  try {
    return (await new N8nService().listWorkflows()).length;
  } catch {
    return null;
  }
}

function buildWebhookMongoSpec(): AutomationSpec {
  return {
    id: 'smoke-webhook-mongo',
    requestId: 'smoke-webhook-mongo',
    name: 'Smoke Webhook Mongo Lead',
    description: 'Webhook receives a lead, validates email and message, saves the lead to MongoDB, and responds JSON.',
    goal: 'Receive lead payload, validate required fields, insert the lead into MongoDB agentforge.leads, return { ok: true }.',
    trigger: {
      type: 'webhook',
      webhook: {
        method: 'POST',
        expectedPayloadDescription: 'Lead JSON with email and message.',
      },
    },
    inputs: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Webhook path',
        value: 'smoke-coverage-lead',
        aliases: ['path'],
      },
    ],
    steps: [
      {
        id: 'validate',
        name: 'Validate lead payload',
        purpose: 'Validate email and message fields.',
        actionType: 'transform',
        expectedOutput: 'Payload is valid or an error response is produced.',
      },
      {
        id: 'save',
        name: 'Insert lead into MongoDB',
        purpose: 'Save lead to MongoDB collection agentforge.leads.',
        actionType: 'write',
        expectedOutput: 'MongoDB insert succeeds.',
      },
      {
        id: 'respond',
        name: 'Respond to webhook',
        purpose: 'Return JSON { ok: true } to the webhook caller.',
        actionType: 'send',
        expectedOutput: 'HTTP JSON response.',
      },
    ],
    externalServices: ['MongoDB'],
    credentialsNeeded: [{ service: 'mongo', required: true }],
    dataPolicy: {
      writesExternalData: true,
      touchesCustomerData: true,
    },
    riskLevel: 'medium',
    requiresApproval: false,
  };
}

function collectRecords(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, out);
    return out;
  }

  const record = value as Record<string, unknown>;
  out.push(record);
  for (const item of Object.values(record)) collectRecords(item, out);
  return out;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
