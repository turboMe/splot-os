#!/usr/bin/env tsx
/**
 * Manual E2E test for the automation architect Golden Path.
 *
 * Pattern: webhook-validate-respond — najprostszy executable pattern (low-risk,
 * brak wymaganych credentiali, samodzielnie deployowalny).
 *
 * Kroki:
 *   1. runtime_check (requiresPublicWebhook: true)
 *   2. compose_workflow
 *   3. validate_workflow (draft + strict)
 *   4. risk_score
 *   5. deploy_automation (tworzy inactive draft + Mongo audit)
 *   6. test_workflow (mock — sprawdza walidacje + plan testowy bez wykonania)
 *   7. cleanup: delete workflow + Mongo audit
 *
 * Uruchomienie:
 *   npm run e2e:webhook
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';

import { getRuntimeTopology } from '../config/runtime-topology.js';
import { getPatternById } from '../tools/architect/pattern-catalog.js';
import { validateWorkflow } from '../tools/architect/validation/workflow-validator.js';
import { analyzeWorkflow } from '../tools/architect/risk-scoring.js';
import { generateMockPayload } from '../tools/architect/testing/mock-data.js';
import { N8nService } from '../tools/architect/../n8n/client.js';
import type { AutomationSpec } from '../tools/architect/types.js';

const C = {
  step: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  fail: '\x1b[31m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
};
const log = (s: string, msg: string) => console.log(`${s} ${msg}${C.reset}`);
const stepLog = (n: number, msg: string) => log(`${C.step}[${n}]`, msg);
const okLog = (msg: string) => log(`${C.ok}  ✓`, msg);
const warnLog = (msg: string) => log(`${C.warn}  !`, msg);
const failLog = (msg: string) => log(`${C.fail}  ✗`, msg);
const dimLog = (msg: string) => log(`${C.dim}    `, `${msg}${C.reset}`);

let workflowId: string | undefined;
let automationId: string | undefined;
const exitCleanup: Array<() => Promise<void>> = [];

async function cleanup() {
  for (const fn of exitCleanup.reverse()) {
    try {
      await fn();
    } catch (e) {
      warnLog(`cleanup error: ${(e as Error).message}`);
    }
  }
}

async function main() {
  console.log(`\n${C.step}═══ E2E: webhook-validate-respond ═══${C.reset}\n`);

  // ── 1. runtime_check ────────────────────────────────────────────────────
  stepLog(1, 'runtime_check (requiresPublicWebhook=true)');
  const topology = getRuntimeTopology();
  dimLog(`mode=${topology.mode}, n8n=${topology.n8nRestBaseUrl}`);

  const n8nProbe = await fetch(`${topology.n8nRestBaseUrl}/healthz`, { signal: AbortSignal.timeout(3000) }).catch(
    () => null,
  );
  if (!n8nProbe?.ok) {
    failLog('n8n not reachable — uruchom mongo+n8n+cloudflared (npm run tunnel:up)');
    process.exit(1);
  }
  okLog(`n8n: ${n8nProbe.status}`);

  const publicUrl = topology.n8nPublicWebhookBaseUrl;
  if (!publicUrl || publicUrl.includes('replace-me') || publicUrl.includes('localhost')) {
    warnLog(`public webhook URL niewlasciwy: ${publicUrl} (test wymaga aktywnego tunelu)`);
  } else {
    okLog(`public webhook: ${publicUrl}`);
  }

  // ── 2. compose_workflow ─────────────────────────────────────────────────
  stepLog(2, 'compose_workflow (pattern=webhook-validate-respond)');
  const pattern = getPatternById('webhook-validate-respond');
  if (!pattern) {
    failLog('pattern nie znaleziony w katalogu');
    process.exit(1);
  }
  if (pattern.executable === false) {
    failLog(`pattern oznaczony jako abstract — nie powinien byc wybrany`);
    process.exit(1);
  }

  const spec: AutomationSpec = {
    id: `e2e-${Date.now()}`,
    requestId: `e2e-${Date.now()}`,
    name: 'E2E Webhook Validate Respond',
    description: 'End-to-end smoke test of the architect pipeline — receive POST, return JSON.',
    goal: 'Validate that the architect Golden Path produces a deployable inactive draft.',
    trigger: { type: 'webhook', webhook: { method: 'POST', expectedPayloadDescription: 'arbitrary JSON' } },
    inputs: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Webhook path suffix.',
        value: `e2e-test-${Date.now()}`,
        aliases: ['path'],
      },
    ],
    steps: [],
    riskLevel: 'low',
    requiresApproval: false,
  };

  const built = pattern.build(spec);
  const workflow = {
    name: `Mastra - E2E ${new Date().toISOString().slice(0, 19)}`,
    nodes: built?.nodes ?? [],
    connections: built?.connections ?? {},
    settings: built?.settings ?? { executionOrder: 'v1' },
    active: false,
  };
  okLog(`composed: nodes=${workflow.nodes.length}, connections=${Object.keys(workflow.connections).length}`);

  // ── 3. validate (draft + strict) ────────────────────────────────────────
  stepLog(3, 'validate_workflow (draft + strict)');
  const draft = validateWorkflow(workflow, 'draft');
  const strict = validateWorkflow(workflow, 'strict');
  okLog(`draft: valid=${draft.valid}, errors=${draft.errors.length}, warnings=${draft.warnings.length}`);
  okLog(
    `strict: valid=${strict.valid}, errors=${strict.errors.length}, security=${strict.securityIssues.length}, missingCreds=${strict.missingCredentials.length}`,
  );
  if (!draft.valid) {
    failLog('draft validation FAILED — pipeline nie powinien isc dalej');
    draft.errors.forEach((e) => dimLog(`error: ${e.nodeName ?? '-'} :: ${e.message}`));
    process.exit(1);
  }

  // ── 4. risk_score ───────────────────────────────────────────────────────
  stepLog(4, 'risk_score');
  const risk = analyzeWorkflow(workflow);
  const verdict = risk.score >= 80 ? 'block' : risk.score >= 20 ? 'review' : 'approve';
  okLog(`score=${risk.score}, verdict=${verdict}, findings=${risk.findings.length}`);
  if (verdict === 'block') {
    failLog('risk score block — pipeline zatrzymany');
    process.exit(1);
  }

  // ── 5. deploy_automation (manual: validate+risk+ownership+create) ──────
  stepLog(5, 'deploy_automation (inactive draft + Mongo audit)');
  const n8n = new N8nService();
  automationId = randomUUID();
  const payload = { ...workflow, name: workflow.name, active: false };
  const created = await n8n.createWorkflow(payload);
  if (!created.id) {
    failLog('n8n createWorkflow nie zwrocil workflow id');
    process.exit(1);
  }
  workflowId = created.id;
  okLog(`n8n created workflowId=${workflowId}`);
  exitCleanup.push(async () => {
    if (workflowId) {
      await n8n.deleteWorkflow(workflowId).catch(() => {});
      dimLog(`cleanup: deleted n8n workflow ${workflowId}`);
    }
  });

  // Mongo audit trail
  const mongoUri = topology.mongoUriForMastra;
  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
  await mongo.connect();
  const db = mongo.db(topology.mongoDbName);
  await db.collection('automation_requests').insertOne({
    automationId,
    n8nWorkflowId: workflowId,
    name: payload.name,
    status: 'draft_created',
    riskScore: risk.score,
    riskVerdict: verdict,
    managedBy: 'mastra',
    lastSnapshot: payload,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  okLog(`Mongo audit: automation_requests.${automationId} (managedBy=mastra)`);
  exitCleanup.push(async () => {
    await db.collection('automation_requests').deleteOne({ automationId });
    await db.collection('automation_events').deleteMany({ automationId });
    dimLog(`cleanup: deleted Mongo audit for automationId=${automationId}`);
    await mongo.close();
  });

  // ── 6. test_workflow (mock) ─────────────────────────────────────────────
  stepLog(6, 'test_workflow (mock)');
  const fetched = await n8n.getWorkflow(workflowId);
  const testValidation = validateWorkflow(fetched, 'strict');
  const mock = generateMockPayload(fetched);
  okLog(`mock plan: trigger=${mock.triggerType}`);
  mock.instructions.forEach((i) => dimLog(i));
  if (!testValidation.valid) {
    failLog(`test validation failed: ${testValidation.errors.length} errors`);
    process.exit(1);
  }
  okLog(`test passed (mock mode — workflow gotowy do real_credentials)`);

  await db.collection('automation_events').insertOne({
    automationId,
    type: 'test_run',
    data: { mode: 'mock', status: 'passed', findings: [] },
    createdAt: new Date(),
  });

  // ── 7. summary ──────────────────────────────────────────────────────────
  console.log(`\n${C.ok}═══ E2E PASSED ═══${C.reset}`);
  console.log(`  workflowId  = ${workflowId}`);
  console.log(`  automationId= ${automationId}`);
  console.log(`  risk        = ${risk.score} / ${verdict}`);
  console.log(`  status      = inactive draft (mastra-managed)`);
  console.log(`  cleanup     = uruchamia sie automatycznie\n`);
}

main()
  .catch(async (err) => {
    failLog(`E2E FAILED: ${(err as Error).message}`);
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(process.exitCode ?? 0);
  });
