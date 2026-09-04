#!/usr/bin/env tsx
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getDb } from '../lib/mongo.js';
import { mastra } from '../index.js';
import { activateAutomationTool } from '../tools/architect/activate.js';
import { N8nService } from '../tools/n8n/client.js';

const allowedNodeTypes = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.code',
  'n8n-nodes-base.respondToWebhook',
]);

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});

async function main(): Promise<void> {
const timestamp = Date.now();
const workflowName = `Mastra Live Safe Echo ${timestamp}`;
const workflowPath = `mastra-live-safe-echo-${timestamp}`;
const thread = `live-safe-webhook-${timestamp}`;
const resource = 'live-safe-automation-webhook';

const prompt = [
  'Live safe automation test. You are Automation Architect.',
  'First call system_delegate_task with targetAgent "n8nMcpEngineer" and callerAgentId "automationArchitect".',
  'After the MCP handoff, create an inactive n8n workflow through the normal Architect/Golden Path tools.',
  `Workflow name: ${workflowName}`,
  `Webhook path: ${workflowPath}`,
  'Workflow shape must be exactly Webhook -> Code -> Respond to Webhook.',
  'Use only these n8n node types: n8n-nodes-base.webhook, n8n-nodes-base.code, n8n-nodes-base.respondToWebhook.',
  'Do not use MongoDB, Telegram, Gmail, Google Sheets, HTTP Request, credentials, external APIs, file system, shell, or any other side-effect node.',
  'Webhook must accept POST JSON with email and message.',
  'Code node must return JSON containing ok, email, message, receivedAt, and workflowPath.',
  'Respond to Webhook must use respondWith=json and an explicit non-empty responseBody expression such as ={{ $json }}.',
  'Deploy inactive only. Do not activate. If activation requires approval, stop after inactive deploy and return automationId, workflowId, workflowName, and webhookPath.',
].join('\n');

const automationArchitect = mastra.getAgent('automationArchitect');
const response = await automationArchitect.generate(prompt, {
  maxSteps: 30,
  memory: {
    thread,
    resource,
  },
} as any);

const text = response?.text ?? '';
const steps = Array.isArray((response as any)?.steps) ? (response as any).steps : [];
assert.ok(hasN8nMcpDelegation(steps), `expected n8nMcpEngineer delegation; observed tools=${summarizeToolNames(steps)}`);

const db = await getDb();
const n8n = new N8nService();
const automation = await findAutomationRecord(db, workflowName, workflowPath);
assert.ok(automation, `automation record not found for ${workflowName}`);

const automationId = String(automation.automationId);
const workflowId = String(automation.n8nWorkflowId);
const workflow = await n8n.getWorkflow(workflowId);

assert.equal(workflow.active, false, 'workflow should be inactive before approval activation');
assert.ok(String(workflow.name ?? '').includes(workflowName), `unexpected workflow name: ${workflow.name}`);
assertSafeWorkflowShape(workflow, workflowPath);

const approvalId = `live-safe-${randomUUID()}`;
await db.collection('approvals').insertOne({
  id: approvalId,
  agentId: 'codex-live-safe-webhook',
  taskId: thread,
  tool: 'architect_activate_automation',
  action: `Activate verified safe workflow ${workflowId}`,
  args: { automationId, workflowId, mode: 'after_approval' },
  status: 'approved',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
  approvedBy: 'codex-live-safe-webhook',
});

const activation = await (activateAutomationTool as any).execute({
  automationId,
  workflowId,
  approvalToken: approvalId,
  mode: 'after_approval',
});
assert.equal(activation.success, true, `activation failed: ${JSON.stringify(activation).slice(0, 1000)}`);

const activated = await n8n.getWorkflow(workflowId);
assert.equal(activated.active, true, 'workflow should be active after approval activation');

const webhookResult = await n8n.triggerWebhook(workflowPath, {
  email: 'live.safe@example.com',
  message: 'hello from Mastra live safe test',
});
assert.equal(webhookResult?.ok, true, `unexpected webhook response: ${JSON.stringify(webhookResult)}`);
assert.equal(webhookResult?.email, 'live.safe@example.com', 'webhook response should echo email');
assert.equal(webhookResult?.workflowPath, workflowPath, 'webhook response should include workflowPath');

console.log(JSON.stringify({
  status: 'passed',
  thread,
  automationId,
  workflowId,
  workflowName: activated.name,
  webhookPath: workflowPath,
  nodeTypes: activated.nodes.map((node: any) => node.type),
  active: activated.active,
  webhookResult,
  finishReason: response?.finishReason,
  responseTextPreview: text.slice(0, 500),
}, null, 2));
process.exit(0);
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

function summarizeToolNames(steps: unknown[]): string {
  return [...new Set(collectRecords(steps)
    .map((record) => stringValue(record.toolName) ?? stringValue(record.name))
    .filter(Boolean))]
    .join(', ');
}

async function findAutomationRecord(db: Awaited<ReturnType<typeof getDb>>, name: string, path: string): Promise<any> {
  const byName = await db.collection('automation_requests').findOne(
    {
      $or: [
        { name: `Mastra - ${name}` },
        { name },
        { 'lastSnapshot.name': name },
        { 'lastSnapshot.name': `Mastra - ${name}` },
      ],
    },
    { sort: { updatedAt: -1 } },
  );
  if (byName) return byName;

  return db.collection('automation_requests').findOne(
    { 'lastSnapshot.nodes.parameters.path': path },
    { sort: { updatedAt: -1 } },
  );
}

function assertSafeWorkflowShape(workflow: any, expectedPath: string): void {
  assert.ok(Array.isArray(workflow.nodes), 'workflow nodes must be an array');
  assert.equal(workflow.nodes.length, 3, `expected exactly 3 nodes, got ${workflow.nodes.length}`);

  for (const node of workflow.nodes) {
    assert.ok(allowedNodeTypes.has(node.type), `unexpected node type: ${node.type}`);
    assert.ok(!node.credentials || Object.keys(node.credentials).length === 0, `node ${node.name} should not use credentials`);
  }

  const webhook = workflow.nodes.find((node: any) => node.type === 'n8n-nodes-base.webhook');
  const respond = workflow.nodes.find((node: any) => node.type === 'n8n-nodes-base.respondToWebhook');
  assert.equal(webhook?.parameters?.path, expectedPath, 'webhook path mismatch');
  assert.equal(String(webhook?.parameters?.httpMethod ?? '').toUpperCase(), 'POST', 'webhook must use POST');
  assert.equal(respond?.parameters?.respondWith, 'json', 'Respond to Webhook must use JSON');
  assert.ok(String(respond?.parameters?.responseBody ?? '').trim(), 'Respond to Webhook responseBody must be non-empty');
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
