#!/usr/bin/env tsx
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  synthesizeN8nWorkflow,
  validateGraphSpec,
  computeNodePositions,
  type WorkflowGraphSpec,
} from '../tools/architect/composer/graph-synthesizer.js';
import {
  registerKnownNodeType,
  isKnownNodeType,
  getKnownTypeVersions,
} from '../tools/architect/validation/node-registry.js';
import { executeAutomationGoldenPath } from '../services/automation-golden-path.js';
import { N8nService } from '../tools/n8n/client.js';

async function main() {
  console.log('Testing GraphSynthesizer and graph_spec integration...\n');

  testValidation();
  console.log('  ✓ testValidation passed');

  testTopologicalLayout();
  console.log('  ✓ testTopologicalLayout passed');

  testCanonicalSynthesis();
  console.log('  ✓ testCanonicalSynthesis passed');

  testDynamicNodeRegistry();
  console.log('  ✓ testDynamicNodeRegistry passed');

  await testGoldenPathGraphSpecIntegration();
  console.log('  ✓ testGoldenPathGraphSpecIntegration passed');

  console.log('\nAll GraphSynthesizer tests passed successfully! 🎉');
  process.exit(0);
}

function testValidation() {
  // Missing name
  const invalid1: any = { nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp' }], connections: [] };
  const res1 = validateGraphSpec(invalid1);
  assert.strictEqual(res1.valid, false);
  assert(res1.errors.some((e) => e.includes('Workflow name is required')));

  // Duplicate node names
  const invalid2: WorkflowGraphSpec = {
    name: 'Duplicate Test',
    nodes: [
      { name: 'SameName', type: 'n8n-nodes-base.manualTrigger' },
      { name: 'SameName', type: 'n8n-nodes-base.noOp' },
    ],
    connections: [],
  };
  const res2 = validateGraphSpec(invalid2);
  assert.strictEqual(res2.valid, false);
  assert(res2.errors.some((e) => e.includes('Duplicate node name')));

  // Non-existent connection nodes
  const invalid3: WorkflowGraphSpec = {
    name: 'NonExistent Node Conn',
    nodes: [{ name: 'A', type: 'n8n-nodes-base.noOp' }],
    connections: [
      { from: 'A', to: 'MissingNode' },
      { from: 'NonExistentSource', to: 'A' },
      { from: 'A', to: 'A', fromOutputIndex: -1 },
    ],
  };
  const resInvalid3 = validateGraphSpec(invalid3);
  assert.strictEqual(resInvalid3.valid, false);
  assert(resInvalid3.errors.some((e) => e.includes('Connection target "MissingNode"')));
  assert(resInvalid3.errors.some((e) => e.includes('Connection source "NonExistentSource"')));
  assert(resInvalid3.errors.some((e) => e.includes('invalid negative fromOutputIndex')));

  // Valid spec
  const validSpec: WorkflowGraphSpec = {
    name: 'Valid Spec',
    nodes: [
      { name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' },
      { name: 'Action', type: 'n8n-nodes-base.noOp' },
    ],
    connections: [{ from: 'Trigger', to: 'Action' }],
  };
  const res3 = validateGraphSpec(validSpec);
  assert.strictEqual(res3.valid, true);
  assert.strictEqual(res3.errors.length, 0);
}

function testTopologicalLayout() {
  const nodes = [
    { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
    { name: 'Filter', type: 'n8n-nodes-base.if' },
    { name: 'BranchTrue', type: 'n8n-nodes-base.code' },
    { name: 'BranchFalse', type: 'n8n-nodes-base.noOp' },
  ];
  const connections = [
    { from: 'Trigger', to: 'Filter' },
    { from: 'Filter', to: 'BranchTrue', fromOutputIndex: 0 },
    { from: 'Filter', to: 'BranchFalse', fromOutputIndex: 1 },
  ];

  const positions = computeNodePositions(nodes, connections, (id) => id);

  const posTrigger = positions.get('Trigger')!;
  const posFilter = positions.get('Filter')!;
  const posTrue = positions.get('BranchTrue')!;
  const posFalse = positions.get('BranchFalse')!;

  assert(posTrigger && posFilter && posTrue && posFalse, 'All nodes must have positions');

  // Trigger -> Filter -> Branches (increasing X)
  assert(posFilter[0] > posTrigger[0], 'Filter must be right of Trigger');
  assert(posTrue[0] > posFilter[0], 'BranchTrue must be right of Filter');
  assert.strictEqual(posTrue[0], posFalse[0], 'BranchTrue and BranchFalse should be in the same column');

  // Branches must not overlap vertically
  assert.notStrictEqual(posTrue[1], posFalse[1], 'BranchTrue and BranchFalse must not have the same Y coordinate');
}

function testCanonicalSynthesis() {
  const spec: WorkflowGraphSpec = {
    name: 'Multi-Branch Test Workflow',
    nodes: [
      {
        name: 'Webhook Inbound',
        type: 'n8n-nodes-base.webhook',
        parameters: { path: 'custom-hook', httpMethod: 'POST' },
      },
      {
        name: 'Transform Code',
        type: 'n8n-nodes-base.code',
        parameters: {
          jsCode: 'const p = $json.body && typeof $json.body === "object" ? $json.body : $json; return [{ json: { ok: true, data: p } }];',
        },
      },
      {
        name: 'Conditional Router',
        type: 'n8n-nodes-base.if',
        parameters: {},
      },
      {
        name: 'Success Response',
        type: 'n8n-nodes-base.respondToWebhook',
        parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}' },
      },
      {
        name: 'Fallback Log',
        type: 'n8n-nodes-base.noOp',
        parameters: {},
      },
    ],
    connections: [
      { from: 'Webhook Inbound', to: 'Transform Code' },
      { from: 'Transform Code', to: 'Conditional Router' },
      { from: 'Conditional Router', to: 'Success Response', fromOutputIndex: 0 },
      { from: 'Conditional Router', to: 'Fallback Log', fromOutputIndex: 1 },
    ],
  };

  const synthesized = synthesizeN8nWorkflow(spec);

  assert.strictEqual(synthesized.name, 'Multi-Branch Test Workflow');
  assert.strictEqual(synthesized.active, false);
  assert.strictEqual(synthesized.settings.executionOrder, 'v1');
  assert.strictEqual(synthesized.nodes.length, 5);

  // Check typeVersions resolved automatically
  const webhookNode = synthesized.nodes.find((n) => n.name === 'Webhook Inbound')!;
  assert(webhookNode.typeVersion >= 1, 'Webhook node must have a resolved typeVersion');

  // Check n8n connection structure
  const connRouter = synthesized.connections['Conditional Router'];
  assert(connRouter && connRouter.main, 'Conditional Router must have main connections');
  assert.strictEqual(connRouter.main.length, 2, 'Router should have 2 output branches');

  // Branch 0 -> Success Response
  assert.strictEqual(connRouter.main[0][0].node, 'Success Response');
  assert.strictEqual(connRouter.main[0][0].type, 'main');
  assert.strictEqual(connRouter.main[0][0].index, 0);

  // Branch 1 -> Fallback Log
  assert.strictEqual(connRouter.main[1][0].node, 'Fallback Log');
  assert.strictEqual(connRouter.main[1][0].type, 'main');
  assert.strictEqual(connRouter.main[1][0].index, 0);
}

function testDynamicNodeRegistry() {
  const customType = 'n8n-nodes-base.mockCustomIntegrationTest';
  assert.strictEqual(isKnownNodeType(customType), false);

  registerKnownNodeType(customType, [1, 2, 2.5]);
  assert.strictEqual(isKnownNodeType(customType), true);

  const versions = getKnownTypeVersions(customType);
  assert.deepStrictEqual(versions, [1, 2, 2.5]);

  // Synthesis resolves highest known version (2.5)
  const spec: WorkflowGraphSpec = {
    name: 'Dynamic Node Test',
    nodes: [
      { name: 'Custom Node', type: customType },
    ],
    connections: [],
  };
  const synthesized = synthesizeN8nWorkflow(spec);
  assert.strictEqual(synthesized.nodes[0].typeVersion, 2.5);
}

async function testGoldenPathGraphSpecIntegration() {
  const n8n = new N8nService();
  const testRunId = randomUUID().slice(0, 8);
  const workflowName = `Test GraphSpec Inactive ${testRunId}`;
  let createdWorkflowId: string | null = null;

  try {
    const result = await executeAutomationGoldenPath({
      mode: 'graph_spec',
      workflowName,
      graphSpec: {
        name: workflowName,
        nodes: [
          {
            name: 'Manual Trigger',
            type: 'n8n-nodes-base.manualTrigger',
            typeVersion: 1,
            parameters: {},
          },
          {
            name: 'Process Data',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            parameters: {
              jsCode: 'return [{ json: { processed: true, runId: "' + testRunId + '" } }];',
            },
          },
          {
            name: 'Pass Through',
            type: 'n8n-nodes-base.noOp',
            parameters: {},
          },
        ],
        connections: [
          { from: 'Manual Trigger', to: 'Process Data' },
          { from: 'Process Data', to: 'Pass Through' },
        ],
      },
    });

    assert.strictEqual(result.success, true, `Golden Path graph_spec execution failed: ${JSON.stringify(result.error || result)}`);
    assert(result.workflowId, 'Result must contain deployed workflowId');
    createdWorkflowId = result.workflowId;

    // Verify workflow state in live n8n
    const liveWorkflow = await n8n.getWorkflow(createdWorkflowId);
    assert(liveWorkflow.name.includes(testRunId), `Workflow name should contain testRunId: ${liveWorkflow.name}`);
    assert(liveWorkflow.name.startsWith('Mastra - '), 'Golden Path must enforce "Mastra - " prefix');
    assert.strictEqual(liveWorkflow.active, false, 'Must be deployed inactive');
    assert.strictEqual(liveWorkflow.nodes.length, 3);

    // Verify connections preserved in n8n
    assert(liveWorkflow.connections['Manual Trigger']);
    assert(liveWorkflow.connections['Process Data']);
  } finally {
    if (createdWorkflowId) {
      try {
        await n8n.deleteWorkflow(createdWorkflowId);
      } catch (err) {
        console.warn(`Failed to clean up test workflow ${createdWorkflowId}:`, err);
      }
    }
  }
}

main().catch((err) => {
  console.error('❌ Check failed:', err);
  process.exit(1);
});
