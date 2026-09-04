#!/usr/bin/env tsx
import 'dotenv/config';
import assert from 'node:assert/strict';

import {
  synthesizeN8nWorkflow,
  normalizeNodeParameters,
  type WorkflowGraphSpec,
} from '../tools/architect/composer/graph-synthesizer.js';
import { validateWorkflow } from '../tools/architect/validation/workflow-validator.js';
import { applyRepairs } from '../tools/architect/testing/repair-workflow.js';

async function main() {
  console.log('Testing n8n Node Contracts, Fan-Out Normalization, and Auto-Repair...\n');

  testValidatorEnforcesContracts();
  console.log('  ✓ testValidatorEnforcesContracts passed');

  testSynthesizerNormalizesGmailAndMongo();
  console.log('  ✓ testSynthesizerNormalizesGmailAndMongo passed');

  testSynthesizerEnforcesFanOutTopology();
  console.log('  ✓ testSynthesizerEnforcesFanOutTopology passed');

  testRepairWorkflowFixesBrokenParameters();
  console.log('  ✓ testRepairWorkflowFixesBrokenParameters passed');

  console.log('\nAll Node Contract & Fan-Out tests passed successfully! 🎉');
  process.exit(0);
}

function testValidatorEnforcesContracts() {
  // 1. Broken Gmail: missing subject and object in message
  const brokenWorkflow: any = {
    name: 'Broken Gmail Test',
    nodes: [
      {
        id: '1',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [240, 300],
        parameters: {},
      },
      {
        id: '2',
        name: 'Create Draft',
        type: 'n8n-nodes-base.gmail',
        typeVersion: 2.1,
        position: [500, 300],
        parameters: {
          resource: 'draft',
          operation: 'create',
          message: {
            to: 'test@example.com',
            body: 'Hello world',
          },
        },
      },
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Create Draft', type: 'main', index: 0 }]],
      },
    },
  };

  const validation = validateWorkflow(brokenWorkflow, 'draft');
  assert.strictEqual(validation.valid, false, 'Validator must reject broken Gmail node');
  
  const hasSubjectError = validation.errors.some((e) => e.message.includes('missing required parameter "subject"'));
  assert.strictEqual(hasSubjectError, true, 'Validator must flag missing subject');

  const hasObjectMessageError = validation.errors.some((e) => e.message.includes('invalid nested object in "message" parameter'));
  assert.strictEqual(hasObjectMessageError, true, 'Validator must flag nested object in message');

  // 2. Broken Telegram and MongoDB
  const brokenOther: any = {
    name: 'Broken Other Test',
    nodes: [
      {
        id: '1',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [240, 300],
        parameters: {},
      },
      {
        id: '2',
        name: 'Telegram Node',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.1,
        position: [500, 300],
        parameters: { chatId: '' }, // missing text and empty chatId
      },
      {
        id: '3',
        name: 'Mongo Node',
        type: 'n8n-nodes-base.mongoDb',
        typeVersion: 1.1,
        position: [760, 300],
        parameters: {}, // missing collection and operation
      },
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Telegram Node', type: 'main', index: 0 }]],
      },
      'Telegram Node': {
        main: [[{ node: 'Mongo Node', type: 'main', index: 0 }]],
      },
    },
  };

  const valOther = validateWorkflow(brokenOther, 'draft');
  assert.strictEqual(valOther.valid, false);
  assert(valOther.errors.some((e) => e.message.includes('Telegram node "Telegram Node" is missing required parameter "chatId"')));
  assert(valOther.errors.some((e) => e.message.includes('Telegram node "Telegram Node" is missing required parameter "text"')));
  assert(valOther.errors.some((e) => e.message.includes('MongoDB node "Mongo Node" is missing required parameter "collection"')));
  assert(valOther.errors.some((e) => e.message.includes('MongoDB node "Mongo Node" is missing required parameter "operation"')));
}

function testSynthesizerNormalizesGmailAndMongo() {
  const normalizedGmail = normalizeNodeParameters('n8n-nodes-base.gmail', {
    resource: 'draft',
    operation: 'create',
    message: {
      to: 'patryk@flowmint.ai',
      emailType: 'html',
      body: '<p>Audit results</p>',
    },
  });

  assert.strictEqual(typeof normalizedGmail.message, 'string');
  assert.strictEqual(normalizedGmail.message, '<p>Audit results</p>');
  assert.strictEqual(normalizedGmail.emailType, 'html');
  assert.strictEqual(normalizedGmail.options?.sendTo, 'patryk@flowmint.ai');
  assert(typeof normalizedGmail.subject === 'string' && normalizedGmail.subject.length > 0);

  const normalizedMongo = normalizeNodeParameters('n8n-nodes-base.mongoDb', {});
  assert.strictEqual(normalizedMongo.operation, 'insert');
  assert.strictEqual(normalizedMongo.database, 'agentforge');
  assert.strictEqual(normalizedMongo.fieldsToSend, 'all');
}

function testSynthesizerEnforcesFanOutTopology() {
  // Spec with faulty sequential chaining:
  // Trigger -> AI Auditor (Code) -> Create Draft (Gmail) -> MongoDB CRM Log -> Telegram Alert
  // where MongoDB and Telegram read lead attributes ($json.companyName, $json.email)
  const spec: WorkflowGraphSpec = {
    name: 'Lead Hunter Pipeline',
    nodes: [
      {
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
      },
      {
        name: 'AI Auditor',
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'return [{ json: { companyName: "Acme", email: "lead@acme.com" } }];' },
      },
      {
        name: 'Create Draft',
        type: 'n8n-nodes-base.gmail',
        parameters: {
          resource: 'draft',
          operation: 'create',
          message: {
            to: '={{ $json.email }}',
            body: 'Hello {{ $json.companyName }}',
          },
        },
      },
      {
        name: 'MongoDB CRM Log',
        type: 'n8n-nodes-base.mongoDb',
        parameters: {
          collection: 'leads',
          operation: 'insert',
          fieldsToSend: 'all',
          // Notice reference to lead companyName:
          leadCompany: '={{ $json.companyName }}',
        },
      },
      {
        name: 'Telegram Alert',
        type: 'n8n-nodes-base.telegram',
        parameters: {
          text: 'New lead: {{ $json.companyName }}',
        },
      },
    ],
    // Model specified sequential connection: AI Auditor -> Create Draft -> MongoDB -> Telegram
    connections: [
      { from: 'Schedule Trigger', to: 'AI Auditor' },
      { from: 'AI Auditor', to: 'Create Draft' },
      { from: 'Create Draft', to: 'MongoDB CRM Log' },
      { from: 'Create Draft', to: 'Telegram Alert' },
    ],
  };

  const synthesized = synthesizeN8nWorkflow(spec);

  // Synthesizer must automatically rewire MongoDB CRM Log and Telegram Alert to Fan-Out from AI Auditor!
  const aiAuditorOutputs = synthesized.connections['AI Auditor']?.main?.[0] || [];
  const targetNodeNames = aiAuditorOutputs.map((o) => o.node);

  assert(targetNodeNames.includes('Create Draft'), 'AI Auditor must connect to Create Draft');
  assert(targetNodeNames.includes('MongoDB CRM Log'), 'MongoDB CRM Log must be rewired to fan out from AI Auditor');
  assert(targetNodeNames.includes('Telegram Alert'), 'Telegram Alert must be rewired to fan out from AI Auditor');

  // And Create Draft must have its parameters normalized!
  const draftNode = synthesized.nodes.find((n) => n.name === 'Create Draft');
  assert(draftNode);
  assert.strictEqual(typeof draftNode.parameters.message, 'string');
  assert.strictEqual(draftNode.parameters.options?.sendTo, '={{ $json.email }}');
  assert(draftNode.parameters.subject.includes('$json.subject'));

  // And the whole workflow must validate cleanly with ZERO errors!
  const validation = validateWorkflow(synthesized, 'strict');
  assert.strictEqual(validation.valid, true, `Synthesized workflow must be 100% valid. Errors: ${JSON.stringify(validation.errors)}`);
}

function testRepairWorkflowFixesBrokenParameters() {
  const broken = {
    name: 'Repair Test',
    nodes: [
      {
        id: '1',
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1,
        position: [240, 300],
        parameters: {},
      },
      {
        id: '2',
        name: 'Create Draft',
        type: 'n8n-nodes-base.gmail',
        typeVersion: 2.1,
        position: [500, 300],
        parameters: {
          resource: 'draft',
          operation: 'create',
          message: {
            to: 'lead@flowmint.ai',
            body: 'Draft body',
          },
        },
      },
      {
        id: '3',
        name: 'MongoDB Log',
        type: 'n8n-nodes-base.mongoDb',
        typeVersion: 1.1,
        position: [760, 300],
        parameters: {
          collection: 'leads',
          // missing operation and database
        },
      },
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Create Draft', type: 'main', index: 0 }]],
      },
      'Create Draft': {
        main: [[{ node: 'MongoDB Log', type: 'main', index: 0 }]],
      },
    },
  };

  const initialVal = validateWorkflow(broken, 'draft');
  assert.strictEqual(initialVal.valid, false);

  const repairRes = applyRepairs(broken, initialVal.errors);
  assert.strictEqual(repairRes.success, true, 'applyRepairs must succeed');
  assert(repairRes.patchedWorkflow, 'Must return patched workflow');

  const postVal = validateWorkflow(repairRes.patchedWorkflow, 'draft');
  assert.strictEqual(postVal.valid, true, `Patched workflow must pass validation! Errors: ${JSON.stringify(postVal.errors)}`);

  const repairedDraft = repairRes.patchedWorkflow.nodes.find((n: any) => n.name === 'Create Draft');
  assert.strictEqual(typeof repairedDraft.parameters.message, 'string');
  assert(repairedDraft.parameters.subject);

  const repairedMongo = repairRes.patchedWorkflow.nodes.find((n: any) => n.name === 'MongoDB Log');
  assert.strictEqual(repairedMongo.parameters.operation, 'insert');
  assert.strictEqual(repairedMongo.parameters.database, 'agentforge');
}

main().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
