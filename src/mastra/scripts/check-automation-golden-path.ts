#!/usr/bin/env tsx
import 'dotenv/config';
import { randomUUID } from 'crypto';

import { executeAutomationGoldenPath } from '../services/automation-golden-path.js';
import { N8nService } from '../tools/n8n/client.js';
import { getDb } from '../lib/mongo.js';
import { normalizeConnectionKeys, validateWorkflow } from '../tools/architect/validation/workflow-validator.js';
import { applyRepairs } from '../tools/architect/testing/repair-workflow.js';
import { analyzeWorkflow } from '../tools/architect/risk-scoring.js';
import type { AutomationSpec } from '../tools/architect/types.js';
import { preserveExistingNodeCredentials } from '../tools/architect/workflow-write-helpers.js';

const unsafeWorkflow = {
  name: 'Unsafe Code Workflow',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'manual',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'unsafe',
      name: 'Unsafe Code',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 0],
      parameters: {
        jsCode: "return [{ json: { out: $helpers.executeCommandSync('cat /etc/passwd').toString() } }];",
      },
    },
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Unsafe Code', type: 'main', index: 0 }]],
    },
  },
};

async function main() {
  const connectionNormalization = checkConnectionIdNormalization();
  const graphValidation = checkGraphValidation();
  const errorBranchGraphValidation = checkErrorBranchGraphValidation();
  const connectionRepair = checkConnectionRepair();
  const credentialPreservation = checkCredentialPreservation();
  const unsupportedVars = checkUnsupportedVarsHandling();
  const malformedParameters = checkMalformedParameters();
  const triggerConsistency = checkTriggerConsistency();
  const activationTriggerValidation = checkActivationTriggerValidation();
  const respondBodyValidation = checkRespondToWebhookResponseBody();
  const webhookPayloadEnvelope = checkWebhookPayloadEnvelopeValidation();
  const googleSheetsOptionalConfig = checkGoogleSheetsOptionalConfig();
  const n8nPayloadSanitization = await checkN8nPayloadSanitization();
  const coverageBlock = await checkPatternCoverageBlock();
  const forbiddenNodeBlock = await checkForbiddenNodeBlock();

  const unsafeResult = await executeAutomationGoldenPath({
    mode: 'workflow_json',
    workflow: unsafeWorkflow,
    automationId: `check-unsafe-${Date.now()}`,
  });

  const securityCount = unsafeResult.validation?.securityIssues.length ?? 0;
  if (unsafeResult.status !== 'blocked' || securityCount === 0) {
    console.error(JSON.stringify(unsafeResult, null, 2));
    throw new Error('Unsafe workflow was not blocked by Golden Path validation.');
  }

  const automationId = `check-safe-${Date.now()}`;
  const safeWorkflow = {
    name: `Golden Path Check ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };
  const safeResult = await executeAutomationGoldenPath({
    mode: 'workflow_json',
    automationId,
    workflow: safeWorkflow,
  });

  try {
    if (!safeResult.success || safeResult.status !== 'tested' || !safeResult.workflowId) {
      console.error(JSON.stringify(safeResult, null, 2));
      throw new Error('Safe workflow did not complete deploy + mock test.');
    }

    const deployedWorkflow = await new N8nService().getWorkflow(safeResult.workflowId);
    if (deployedWorkflow.active) {
      console.error(JSON.stringify({ workflowId: safeResult.workflowId, active: deployedWorkflow.active }, null, 2));
      throw new Error('Safe workflow was not left inactive after deploy + mock test.');
    }
    const persistedAutomation = await (await getDb()).collection('automation_requests').findOne({ automationId });
    if (persistedAutomation?.n8nWorkflowId !== safeResult.workflowId) {
      console.error(JSON.stringify({ safeResult, persistedAutomation }, null, 2));
      throw new Error('automation_requests did not persist the canonical n8nWorkflowId.');
    }

    // The deploy must leave a FETCHABLE product behind, recorded where the write
    // happens rather than by asking the model to save it afterwards.
    //
    // Measured on the automationArchitect canary: the run deployed a real
    // workflow, reported it well, and `producer.artifacts` was still empty — the
    // agent calls this path once and never holds the JSON, so there was nothing
    // for it to save even when instructed to. A run whose product only exists in
    // n8n cannot hand it to the next step of a sequence.
    const deployedArtifact = await (await getDb()).collection('artifacts')
      .findOne({ 'metadata.workflowId': safeResult.workflowId });
    if (!deployedArtifact) {
      throw new Error(
        `deploy left no artifact for workflow ${safeResult.workflowId} — the run has no product `
        + 'the orchestrator can read or a successor can fetch',
      );
    }
    if (deployedArtifact.type !== 'automation_workflow') {
      throw new Error(`deployed artifact has type ${deployedArtifact.type}, expected automation_workflow`);
    }
    if (!String(deployedArtifact.content ?? '').includes('"nodes"')) {
      throw new Error('the recorded artifact does not contain the workflow definition');
    }

    const ownerReuseResult = await executeAutomationGoldenPath({
      mode: 'workflow_json',
      workflowId: safeResult.workflowId,
      workflow: safeWorkflow,
    });
    if (!ownerReuseResult.success || ownerReuseResult.automationId !== automationId) {
      console.error(JSON.stringify({ safeResult, ownerReuseResult }, null, 2));
      throw new Error('Golden Path update did not reuse existing workflow ownership.');
    }
    const duplicateOwners = await (await getDb()).collection('automation_requests').countDocuments({
      n8nWorkflowId: safeResult.workflowId,
    });
    if (duplicateOwners !== 1) {
      console.error(JSON.stringify({ safeResult, ownerReuseResult, duplicateOwners }, null, 2));
      throw new Error('Golden Path update created duplicate automation ownership records.');
    }
  } finally {
    await cleanup(automationId, safeResult.workflowId);
  }

  console.log('automation-golden-path check passed');
  console.log(`connectionIdNormalization=${connectionNormalization}`);
  console.log(`graphValidation=${graphValidation}`);
  console.log(`errorBranchGraphValidation=${errorBranchGraphValidation}`);
  console.log(`connectionRepair=${connectionRepair}`);
  console.log(`credentialPreservation=${credentialPreservation}`);
  console.log(`unsupportedVars=${unsupportedVars}`);
  console.log(`malformedParameters=${malformedParameters}`);
  console.log(`triggerConsistency=${triggerConsistency}`);
  console.log(`activationTriggerValidation=${activationTriggerValidation}`);
  console.log(`respondBodyValidation=${respondBodyValidation}`);
  console.log(`webhookPayloadEnvelope=${webhookPayloadEnvelope}`);
  console.log(`googleSheetsOptionalConfig=${googleSheetsOptionalConfig}`);
  console.log(`n8nPayloadSanitization=${n8nPayloadSanitization}`);
  console.log(`coverageBlock=${coverageBlock}`);
  console.log(`forbiddenNodeBlock=${forbiddenNodeBlock}`);
  console.log('canonicalN8nWorkflowId=passed');
  console.log('inactiveAfterDeploy=passed');
  console.log('ownerReuse=passed');
  console.log(`unsafeStatus=${unsafeResult.status}, securityIssues=${securityCount}`);
  console.log(`safeStatus=${safeResult.status}, workflowId=${safeResult.workflowId}`);
  process.exit(0);
}

async function checkForbiddenNodeBlock(): Promise<string> {
  const previousMode = process.env.FORBIDDEN_NODE_GATE_MODE;
  const automationId = `check-forbidden-${Date.now()}`;
  process.env.FORBIDDEN_NODE_GATE_MODE = 'block';

  try {
    const result = await executeAutomationGoldenPath({
      mode: 'workflow_json',
      automationId,
      workflow: {
        name: 'Forbidden Node Check',
        active: false,
        settings: { executionOrder: 'v1' },
        nodes: [
          {
            id: 'forbidden',
            name: 'Execute Command',
            type: 'n8n-nodes-base.executeCommand',
            typeVersion: 1,
            position: [0, 0],
            parameters: { command: 'echo forbidden' },
          },
        ],
        connections: {},
      },
    });

    if (result.status !== 'blocked' || result.failureClass !== 'forbidden_nodes') {
      console.error(JSON.stringify(result, null, 2));
      throw new Error('Golden Path did not classify a forbidden node before node validation.');
    }
    if (result.workflowId) {
      throw new Error('Forbidden-node block must happen before n8n deploy.');
    }
    if (result.steps.some((step) => step.name === 'node_validation')) {
      throw new Error('Forbidden nodes must not reach the MCP-backed node-validation gate.');
    }
    if (!result.recoveryStrategies?.some((strategy) => strategy.name === 'replace_forbidden_nodes')) {
      throw new Error('Forbidden-node block did not provide replacement recovery guidance.');
    }
    return 'passed';
  } finally {
    await cleanup(automationId);
    if (previousMode === undefined) delete process.env.FORBIDDEN_NODE_GATE_MODE;
    else process.env.FORBIDDEN_NODE_GATE_MODE = previousMode;
  }
}

async function checkPatternCoverageBlock(): Promise<string> {
  const previousMode = process.env.AUTOMATION_COVERAGE_GATE_MODE;
  const automationId = `check-coverage-${Date.now()}`;
  process.env.AUTOMATION_COVERAGE_GATE_MODE = 'block';

  try {
    const result = await executeAutomationGoldenPath({
      mode: 'pattern',
      automationId,
      patternId: 'webhook-validate-respond',
      request: 'Webhook przyjmuje lead, waliduje email i message, zapisuje lead do MongoDB agentforge.leads, zwraca JSON { ok: true }. Nie aktywuj workflow.',
      spec: buildWebhookMongoSpec(),
      workflowName: `Coverage Gap Check ${randomUUID().slice(0, 8)}`,
      activate: false,
      allowDraftWithMissingCredentials: true,
    });

    if (result.status !== 'blocked' || result.failureClass !== 'pattern_coverage_gap') {
      console.error(JSON.stringify(result, null, 2));
      throw new Error('Golden Path did not block incomplete pattern coverage.');
    }
    if (result.workflowId) {
      console.error(JSON.stringify(result, null, 2));
      throw new Error('Coverage block should happen before n8n deploy and must not return workflowId.');
    }
    const missing = result.coverage?.missingRequired ?? [];
    if (!missing.includes('operation.mongo.insert') || !missing.includes('sideEffect.db.write')) {
      console.error(JSON.stringify(result, null, 2));
      throw new Error('Coverage block did not report Mongo insert and DB write gaps.');
    }

    return 'passed';
  } finally {
    await cleanup(automationId);
    if (previousMode === undefined) {
      delete process.env.AUTOMATION_COVERAGE_GATE_MODE;
    } else {
      process.env.AUTOMATION_COVERAGE_GATE_MODE = previousMode;
    }
  }
}

function buildWebhookMongoSpec(): AutomationSpec {
  return {
    id: 'coverage-webhook-mongo',
    requestId: 'coverage-webhook-mongo',
    name: 'Webhook lead to MongoDB',
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
        value: 'coverage-lead',
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

function checkConnectionIdNormalization(): string {
  const workflow: any = {
    name: `Connection ID Normalization ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual_trigger_01',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'noop_01',
        name: 'No Operation',
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position: [220, 0],
        parameters: {},
      },
    ],
    connections: {
      manual_trigger_01: {
        main: [[{ node: 'noop_01', type: 'main', index: 0 }]],
      },
    },
  };

  const warnings = normalizeConnectionKeys(workflow);
  const validation = validateWorkflow(workflow, 'strict');

  if (!validation.valid) {
    console.error(JSON.stringify({ warnings, validation, workflow }, null, 2));
    throw new Error('Connection id normalization did not produce a valid workflow.');
  }
  if (!workflow.connections['Manual Trigger'] || workflow.connections.manual_trigger_01) {
    console.error(JSON.stringify({ warnings, workflow }, null, 2));
    throw new Error('Connection source id was not normalized to node name.');
  }
  const target = workflow.connections['Manual Trigger'].main?.[0]?.[0]?.node;
  if (target !== 'No Operation') {
    console.error(JSON.stringify({ warnings, workflow }, null, 2));
    throw new Error('Connection target id was not normalized to node name.');
  }
  if (warnings.length < 2) {
    console.error(JSON.stringify({ warnings, workflow }, null, 2));
    throw new Error('Connection normalization did not report source and target warnings.');
  }

  return 'passed';
}

function checkGraphValidation(): string {
  const disconnectedWorkflow: any = {
    name: `Disconnected Graph ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'transform_a',
        name: 'Transform A',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {},
      },
      {
        id: 'transform_b',
        name: 'Transform B',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [440, 0],
        parameters: {},
      },
      {
        id: 'respond',
        name: 'Respond',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [660, 0],
        parameters: {},
      },
    ],
    connections: {},
  };

  const disconnectedDraft = validateWorkflow(disconnectedWorkflow, 'draft');
  const disconnectedStrict = validateWorkflow(disconnectedWorkflow, 'strict');
  if (disconnectedDraft.valid || disconnectedStrict.valid || disconnectedStrict.orphanNodeCount !== 3) {
    console.error(JSON.stringify({ disconnectedDraft, disconnectedStrict }, null, 2));
    throw new Error('Disconnected executable graph was not blocked by validation.');
  }

  const linearWorkflow: any = {
    ...disconnectedWorkflow,
    name: `Linear Graph ${randomUUID().slice(0, 8)}`,
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Transform A', type: 'main', index: 0 }]],
      },
      'Transform A': {
        main: [[{ node: 'Transform B', type: 'main', index: 0 }]],
      },
      'Transform B': {
        main: [[{ node: 'Respond', type: 'main', index: 0 }]],
      },
    },
  };

  const linearStrict = validateWorkflow(linearWorkflow, 'strict');
  if (!linearStrict.valid || linearStrict.orphanNodeCount !== 0 || linearStrict.reachableNodeCount !== 4) {
    console.error(JSON.stringify({ linearStrict }, null, 2));
    throw new Error('Linear trigger-to-executable graph did not pass validation.');
  }

  return 'passed';
}

function checkErrorBranchGraphValidation(): string {
  const workflow: any = {
    name: `Error Branch Graph ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'write',
        name: 'Write Record',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {},
      },
      {
        id: 'error_log',
        name: 'Error Log',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [440, 160],
        parameters: {},
      },
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Write Record', type: 'main', index: 0 }]],
      },
      'Write Record': {
        error: [[{ node: 'Error Log', type: 'main', index: 0 }]],
      },
    },
  };

  const beforeNormalize = validateWorkflow(JSON.parse(JSON.stringify(workflow)), 'strict');
  if (!beforeNormalize.valid || beforeNormalize.orphanNodeCount !== 0 || beforeNormalize.reachableNodeCount !== 3) {
    console.error(JSON.stringify({ beforeNormalize, workflow }, null, 2));
    throw new Error('Validator did not treat non-standard error output as reachable.');
  }

  const warnings = normalizeConnectionKeys(workflow);
  const normalizedErrorTarget = workflow.connections['Write Record']?.main?.[1]?.[0]?.node;
  if (normalizedErrorTarget !== 'Error Log' || workflow.connections['Write Record']?.error) {
    console.error(JSON.stringify({ warnings, workflow }, null, 2));
    throw new Error('Connection normalization did not move non-standard error output to main[1].');
  }

  const afterNormalize = validateWorkflow(workflow, 'strict');
  if (!afterNormalize.valid || afterNormalize.orphanNodeCount !== 0) {
    console.error(JSON.stringify({ warnings, afterNormalize, workflow }, null, 2));
    throw new Error('Normalized error branch graph did not pass validation.');
  }

  return 'passed';
}

function checkCredentialPreservation(): string {
  const existingWorkflow = {
    nodes: [
      {
        id: 'mongo_1',
        name: 'Save Lead',
        credentials: { mongoDb: { id: 'mongo-live', name: 'Mongo Live' } },
      },
      {
        id: 'gmail_1',
        name: 'Draft Email',
        credentials: { googleGmailOAuth2Api: { id: 'gmail-live', name: 'Gmail Live' } },
      },
      {
        id: 'telegram_1',
        name: 'Telegram Alert',
        credentials: { telegramApi: { id: 'telegram-live', name: 'Telegram Live' } },
      },
    ],
  };
  const patchedWorkflow = {
    nodes: [
      { id: 'mongo_1', name: 'Save Lead', parameters: {} },
      { id: 'gmail_1', name: 'Draft Email', credentials: {}, parameters: {} },
      {
        id: 'telegram_1',
        name: 'Telegram Alert',
        credentials: { telegramApi: { id: 'telegram-new', name: 'Telegram New' } },
        parameters: {},
      },
    ],
  };

  const merged = preserveExistingNodeCredentials(patchedWorkflow, existingWorkflow) as any;
  if (merged.nodes[0].credentials?.mongoDb?.id !== 'mongo-live') {
    console.error(JSON.stringify({ merged }, null, 2));
    throw new Error('Credential preservation did not restore missing Mongo credentials.');
  }
  if (merged.nodes[1].credentials?.googleGmailOAuth2Api?.id !== 'gmail-live') {
    console.error(JSON.stringify({ merged }, null, 2));
    throw new Error('Credential preservation did not merge missing Gmail credentials.');
  }
  if (merged.nodes[2].credentials?.telegramApi?.id !== 'telegram-new') {
    console.error(JSON.stringify({ merged }, null, 2));
    throw new Error('Credential preservation overwrote explicitly supplied credentials.');
  }
  if ((patchedWorkflow.nodes[0] as any).credentials) {
    console.error(JSON.stringify({ patchedWorkflow, merged }, null, 2));
    throw new Error('Credential preservation mutated the input workflow.');
  }

  return 'passed';
}

function checkConnectionRepair(): string {
  const repairableWorkflow: any = {
    name: `Connection Repair ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual_trigger_01',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'transform_payload_01',
        name: 'Transform Payload',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {},
      },
    ],
    connections: {
      manual_trigger_01: {
        main: [[{ node: 'transform_payload_01', type: 'main', index: 0 }]],
      },
    },
  };

  const beforeRepairValidation = validateWorkflow(repairableWorkflow, 'strict');
  const repair = applyRepairs(
    repairableWorkflow,
    beforeRepairValidation.errors.map((error) => ({
      severity: 'error',
      nodeName: error.nodeName,
      message: error.message,
    })),
  );
  const repairedValidation = validateWorkflow(repair.patchedWorkflow, 'strict');
  if (!repair.success || !repairedValidation.valid || !repair.changes.some((change) => change.reason.includes('connection_id_to_name_repair'))) {
    console.error(JSON.stringify({ repair, repairedValidation }, null, 2));
    throw new Error('Connection id/name repair did not produce a valid workflow.');
  }

  const manualWorkflow: any = {
    ...repairableWorkflow,
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Missing Target', type: 'main', index: 0 }]],
      },
    },
  };
  const manualValidation = validateWorkflow(manualWorkflow, 'strict');
  const manualRepair = applyRepairs(
    manualWorkflow,
    manualValidation.errors.map((error) => ({ severity: 'error', nodeName: error.nodeName, message: error.message })),
  );
  if (manualRepair.stopReason !== 'manual_connection_mapping_required' || manualRepair.remainingIssues.length === 0) {
    console.error(JSON.stringify({ manualValidation, manualRepair }, null, 2));
    throw new Error('Unknown connection target did not produce manual_connection_mapping_required.');
  }

  return 'passed';
}

function checkUnsupportedVarsHandling(): string {
  const workflow: any = {
    name: `Unsupported Vars ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'set_value',
        name: 'Set Value',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {
          assignments: {
            assignments: [
              {
                id: 'base-url',
                name: 'baseUrl',
                value: '={{ $vars.MASTRA_API_URL }}',
                type: 'string',
              },
            ],
          },
        },
      },
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Set Value', type: 'main', index: 0 }]],
      },
    },
  };

  const validation = validateWorkflow(workflow, 'strict');
  const repair = applyRepairs(
    workflow,
    validation.errors.map((error) => ({ severity: 'error', nodeName: error.nodeName, message: error.message })),
  );
  if (validation.valid || repair.stopReason !== 'unsupported_n8n_vars' || !repair.remainingIssues.some((issue) => issue.message.includes('unsupported_n8n_vars'))) {
    console.error(JSON.stringify({ validation, repair }, null, 2));
    throw new Error('$vars.* did not produce unsupported_n8n_vars.');
  }

  return 'passed';
}

function checkMalformedParameters(): string {
  const workflow: any = {
    name: `Malformed Parameters ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
      },
    ],
    connections: {},
  };

  const validation = validateWorkflow(workflow, 'draft');
  if (validation.valid || !validation.errors.some((error) => error.message.includes('"parameters" as an object'))) {
    console.error(JSON.stringify({ validation }, null, 2));
    throw new Error('Malformed node parameters were not blocked before deploy.');
  }

  return 'passed';
}

function checkTriggerConsistency(): string {
  const workflow: any = {
    name: `RSS Trigger Risk ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'rss-trigger',
        name: 'RSS Trigger',
        type: 'n8n-nodes-base.rssFeedReadTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };

  const validation = validateWorkflow(workflow, 'strict');
  const risk = analyzeWorkflow(workflow);
  if (!validation.valid || risk.findings.some((finding) => finding.code === 'NO_TRIGGER')) {
    console.error(JSON.stringify({ validation, risk }, null, 2));
    throw new Error('Trigger detection is inconsistent for rssFeedReadTrigger.');
  }

  return 'passed';
}

function checkActivationTriggerValidation(): string {
  const manualWorkflow: any = {
    name: `Manual Activation ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };
  const scheduleWorkflow: any = {
    ...manualWorkflow,
    name: `Scheduled Activation ${randomUUID().slice(0, 8)}`,
    nodes: [
      {
        ...manualWorkflow.nodes[0],
        id: 'schedule',
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
      },
    ],
  };

  const manualValidation = validateWorkflow(manualWorkflow, 'activation');
  const scheduleValidation = validateWorkflow(scheduleWorkflow, 'activation');
  if (
    manualValidation.valid ||
    !manualValidation.errors.some((error) => error.message.includes('non-manual trigger')) ||
    !scheduleValidation.valid
  ) {
    console.error(JSON.stringify({ manualValidation, scheduleValidation }, null, 2));
    throw new Error('Activation validation did not distinguish manual-only workflows.');
  }

  return 'passed';
}

function checkRespondToWebhookResponseBody(): string {
  const workflow: any = {
    name: `Empty Respond Body ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'webhook',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        parameters: { httpMethod: 'POST', path: 'empty-respond-body', responseMode: 'responseNode' },
      },
      {
        id: 'respond',
        name: 'Respond',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [220, 0],
        parameters: { respondWith: 'json', responseBody: '' },
      },
    ],
    connections: {
      Webhook: {
        main: [[{ node: 'Respond', type: 'main', index: 0 }]],
      },
    },
  };

  const invalid = validateWorkflow(workflow, 'draft');
  if (invalid.valid || !invalid.errors.some((error) => error.message.includes('responseBody is empty'))) {
    console.error(JSON.stringify({ invalid }, null, 2));
    throw new Error('Empty Respond to Webhook JSON responseBody was not blocked.');
  }

  workflow.nodes[1].parameters.responseBody = '={{ $json }}';
  const valid = validateWorkflow(workflow, 'draft');
  if (!valid.valid || valid.errors.some((error) => error.message.includes('responseBody is empty'))) {
    console.error(JSON.stringify({ valid }, null, 2));
    throw new Error('Explicit Respond to Webhook JSON responseBody did not pass validation.');
  }

  return 'passed';
}

function checkWebhookPayloadEnvelopeValidation(): string {
  const workflow: any = {
    name: `Webhook Payload Envelope ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'webhook',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        parameters: { httpMethod: 'POST', path: 'webhook-payload-envelope', responseMode: 'responseNode' },
      },
      {
        id: 'code',
        name: 'Code',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [220, 0],
        parameters: {
          jsCode: [
            'const input = $input.item.json;',
            'return [{ json: { ok: true, email: input.email, message: input.message } }];',
          ].join('\n'),
        },
      },
      {
        id: 'respond',
        name: 'Respond',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [440, 0],
        parameters: { respondWith: 'json', responseBody: '={{ $json }}' },
      },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
      Code: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] },
    },
  };

  const invalid = validateWorkflow(workflow, 'draft');
  if (invalid.valid || !invalid.errors.some((error) => error.message.includes('without normalizing the n8n webhook envelope'))) {
    console.error(JSON.stringify({ invalid }, null, 2));
    throw new Error('Webhook root payload read was not blocked.');
  }

  workflow.nodes[1].parameters.jsCode = [
    'const envelope = $input.item.json;',
    'const payload = envelope.body && typeof envelope.body === "object" ? envelope.body : envelope;',
    'return [{ json: { ok: true, email: payload.email, message: payload.message } }];',
  ].join('\n');

  const valid = validateWorkflow(workflow, 'draft');
  if (!valid.valid || valid.errors.some((error) => error.message.includes('without normalizing the n8n webhook envelope'))) {
    console.error(JSON.stringify({ valid }, null, 2));
    throw new Error('Webhook body payload normalization did not pass validation.');
  }

  return 'passed';
}

function checkGoogleSheetsOptionalConfig(): string {
  const workflow: any = {
    name: `Google Sheets Optional Config ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'sheets',
        name: 'Google Sheets Append',
        type: 'n8n-nodes-base.googleSheets',
        typeVersion: 4.7,
        position: [220, 0],
        parameters: {
          operation: 'append',
          documentId: 'PLACEHOLDER_SPREADSHEET_ID',
          sheetName: 'Arkusz1',
        },
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Google Sheets Append', type: 'main', index: 0 }]] },
    },
  };

  const validation = validateWorkflow(workflow, 'strict');
  if (!validation.valid) {
    console.error(JSON.stringify({ validation }, null, 2));
    throw new Error('Optional Google Sheets missing config should not fail inactive draft mock validation.');
  }
  if (!validation.missingConfig.some((item) => item.key === 'GOOGLE_SHEETS_DOCUMENT_ID' && item.required === false)) {
    console.error(JSON.stringify({ validation }, null, 2));
    throw new Error('Google Sheets placeholder documentId was not reported as optional missing config.');
  }
  if (!validation.missingCredentials.some((item) => item.service === 'googleSheets' && item.required === false)) {
    console.error(JSON.stringify({ validation }, null, 2));
    throw new Error('Google Sheets missing credentials were not reported as optional missing credentials.');
  }

  return 'passed';
}

async function checkN8nPayloadSanitization(): Promise<string> {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      id: 'sanitized-workflow',
      name: 'Sanitized Workflow',
      active: false,
      nodes: [],
      connections: {},
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const n8n = new N8nService({ baseUrl: 'http://n8n.test', apiKey: 'test-api-key' });
    const workflow = {
      id: 'readonly-id',
      versionId: 'readonly-version',
      activeVersionId: 'readonly-active-version',
      versionCounter: 7,
      activeVersion: { id: 'readonly-active-version' },
      active: true,
      tags: [{ name: 'readonly-tag' }],
      staticData: { node: 'runtime-only' },
      meta: { templateCredsSetupCompleted: true },
      pinData: { 'Manual Trigger': [{ json: { pinned: true } }] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      triggerCount: 1,
      shared: [],
      isArchived: false,
      usedCredentials: [],
      scopes: ['workflow:read'],
      homeProject: { id: 'project' },
      name: 'Sanitized Workflow',
      nodes: [
        {
          id: 'node-id-must-stay',
          name: 'Manual Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
          credentials: { telegramApi: { id: 'credential-id-must-stay', name: 'Telegram Credential' } },
          webhookId: 'readonly-webhook-id',
          onError: 'continueErrorOutput',
          continueErrorOutput: true,
          alwaysOutputData: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          issues: { parameters: [] },
        },
      ],
      connections: {},
      settings: { executionOrder: 'v1' },
    };

    await n8n.createWorkflow(workflow as any);
    await n8n.updateWorkflow('sanitized-workflow', workflow as any);

    for (const body of bodies) {
      for (const readonlyKey of [
        'id',
        'versionId',
        'activeVersionId',
        'versionCounter',
        'activeVersion',
        'active',
        'tags',
        'staticData',
        'meta',
        'pinData',
        'createdAt',
        'updatedAt',
        'triggerCount',
        'shared',
        'isArchived',
        'usedCredentials',
        'scopes',
        'homeProject',
      ]) {
        if (readonlyKey in body) {
          console.error(JSON.stringify({ readonlyKey, body }, null, 2));
          throw new Error(`n8n payload still contains read-only field: ${readonlyKey}`);
        }
      }
      const nodeId = ((body.nodes as any[])?.[0])?.id;
      if (nodeId !== 'node-id-must-stay') {
        console.error(JSON.stringify({ body }, null, 2));
        throw new Error('n8n payload sanitization removed node.id, which must remain for connections.');
      }
      const node = (body.nodes as any[])?.[0] ?? {};
      for (const readonlyNodeKey of ['webhookId', 'onError', 'continueErrorOutput', 'alwaysOutputData', 'createdAt', 'updatedAt', 'issues']) {
        if (readonlyNodeKey in node) {
          console.error(JSON.stringify({ readonlyNodeKey, node, body }, null, 2));
          throw new Error(`n8n node payload still contains unsupported field: ${readonlyNodeKey}`);
        }
      }
      if (node.credentials?.telegramApi?.id !== 'credential-id-must-stay') {
        console.error(JSON.stringify({ node, body }, null, 2));
        throw new Error('n8n payload sanitization removed node credentials.');
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  return 'passed';
}

async function cleanup(automationId: string, workflowId?: string) {
  if (workflowId) {
    const n8n = new N8nService();
    await n8n.deleteWorkflow(workflowId).catch(() => undefined);
  }

  const db = await getDb();
  await db.collection('automation_requests').deleteMany({
    $or: [
      { automationId },
      ...(workflowId ? [{ n8nWorkflowId: workflowId }] : []),
    ],
  }).catch(() => undefined);
  await db.collection('automation_events').deleteMany({ automationId }).catch(() => undefined);
  await db.collection('automation_workflow_snapshots').deleteMany({
    $or: [
      { automationId },
      ...(workflowId ? [{ n8nWorkflowId: workflowId }] : []),
    ],
  }).catch(() => undefined);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
