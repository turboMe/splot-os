#!/usr/bin/env tsx
import 'dotenv/config';
import assert from 'node:assert/strict';

import {
  deriveForbiddenCapabilities,
  deriveRequestCapabilities,
  deriveSpecCapabilities,
  deriveWorkflowCapabilities,
  evaluateCapabilityCoverage,
  evaluatePatternCoverage,
} from '../tools/architect/capability-coverage.js';
import { getPatternById } from '../tools/architect/pattern-catalog.js';
import type { AutomationSpec } from '../tools/architect/types.js';

const webhookMongoSpec: AutomationSpec = {
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

const webhookValidateRespond = getPatternById('webhook-validate-respond');
assert.ok(webhookValidateRespond, 'webhook-validate-respond pattern must exist');
const built = webhookValidateRespond.build(webhookMongoSpec);
const workflow = {
  name: webhookMongoSpec.name,
  nodes: built.nodes ?? [],
  connections: built.connections ?? {},
  settings: built.settings ?? { executionOrder: 'v1' },
  active: false,
};

const required = deriveSpecCapabilities(
  webhookMongoSpec,
  'Webhook przyjmuje lead, waliduje email i message, zapisuje lead do MongoDB agentforge.leads, zwraca JSON { ok: true }.',
);
const requiredCaps = new Set(required.map((item) => item.capability));

assert.ok(requiredCaps.has('trigger.webhook'), 'spec should require trigger.webhook');
assert.ok(requiredCaps.has('operation.webhook.receive'), 'spec should require webhook receive');
assert.ok(requiredCaps.has('operation.payload.validate'), 'spec should require payload validation');
assert.ok(requiredCaps.has('operation.mongo.insert'), 'spec should require Mongo insert');
assert.ok(requiredCaps.has('sideEffect.db.write'), 'spec should require DB write');
assert.ok(requiredCaps.has('operation.webhook.respond'), 'spec should require webhook response');

const actual = deriveWorkflowCapabilities(workflow);
const actualCaps = new Set(actual.map((item) => item.capability));

assert.ok(actualCaps.has('trigger.webhook'), 'workflow should include webhook trigger');
assert.ok(actualCaps.has('operation.webhook.respond'), 'workflow should include webhook response');
assert.ok(actualCaps.has('operation.payload.validate'), 'workflow should include validation code');
assert.ok(!actualCaps.has('operation.mongo.insert'), 'webhook-validate-respond workflow must not claim Mongo insert');
assert.ok(!actualCaps.has('sideEffect.db.write'), 'webhook-validate-respond workflow must not claim DB write');

const coverage = evaluateCapabilityCoverage(required, actual);
assert.equal(coverage.ok, false, 'coverage should fail when Mongo write is missing');
assert.ok(coverage.missingRequired.includes('operation.mongo.insert'), 'coverage should report operation.mongo.insert');
assert.ok(coverage.missingRequired.includes('sideEffect.db.write'), 'coverage should report sideEffect.db.write');
assert.equal(coverage.recommendation, 'delegate_mcp', 'critical gaps should recommend MCP delegation');

const patternCoverage = evaluatePatternCoverage({
  pattern: webhookValidateRespond,
  spec: webhookMongoSpec,
});
assert.equal(patternCoverage.ok, false, 'pattern metadata should not cover Mongo spec');
assert.ok(patternCoverage.missingRequired.includes('operation.mongo.insert'), 'pattern coverage should report Mongo insert');

const leadCrmPattern = getPatternById('webhook-lead-to-agentforge-crm');
assert.ok(leadCrmPattern, 'webhook-lead-to-agentforge-crm pattern must exist');
const crmCoverage = evaluatePatternCoverage({
  pattern: leadCrmPattern,
  spec: webhookMongoSpec,
});
assert.ok(crmCoverage.actual.includes('operation.http.post'), 'CRM pattern should advertise HTTP POST');
assert.ok(!crmCoverage.actual.includes('operation.mongo.insert'), 'CRM pattern must not advertise direct Mongo insert');

const echoRequest = [
  'Build a disposable POST webhook echo/healthcheck.',
  'No credentials, no external services, no Telegram, no Mongo, no HTTP Request node.',
  'Use only Webhook, Code, and Respond to Webhook.',
].join(' ');
const echoRequired = deriveRequestCapabilities(echoRequest).map((item) => item.capability);
const echoForbidden = deriveForbiddenCapabilities(echoRequest).map((item) => item.capability);
assert.ok(echoRequired.includes('trigger.webhook'), 'POST webhook should require webhook trigger');
assert.ok(echoRequired.includes('operation.webhook.receive'), 'POST webhook should require webhook receive');
assert.ok(!echoRequired.includes('operation.http.post'), 'inbound POST webhook must not require outbound HTTP POST');
assert.ok(!echoRequired.includes('service.mongo'), 'negated Mongo must not become a required service');
assert.ok(!echoRequired.includes('service.telegram'), 'negated Telegram must not become a required service');
assert.ok(echoForbidden.includes('service.mongo'), 'negated Mongo should become forbidden');
assert.ok(echoForbidden.includes('service.telegram'), 'negated Telegram should become forbidden');
assert.ok(echoForbidden.includes('node.httpRequest'), 'negated HTTP Request node should become forbidden');

const outboundHttpRequired = deriveRequestCapabilities(
  'Receive a webhook, validate payload, then send an HTTP POST to the CRM API.',
).map((item) => item.capability);
assert.ok(outboundHttpRequired.includes('operation.http.post'), 'outbound HTTP POST to API should require operation.http.post');

const forbiddenCoverage = evaluateCapabilityCoverage(
  deriveRequestCapabilities('POST webhook, no Telegram.'),
  deriveWorkflowCapabilities({
    name: 'Forbidden Telegram',
    active: false,
    nodes: [
      {
        id: 'webhook',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        parameters: { httpMethod: 'POST', path: 'forbidden-telegram' },
      },
      {
        id: 'telegram',
        name: 'Telegram',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1,
        parameters: { operation: 'sendMessage', text: 'hello' },
      },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Telegram', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  }),
  deriveForbiddenCapabilities('POST webhook, no Telegram.'),
);
assert.equal(forbiddenCoverage.ok, false, 'coverage should fail when forbidden capability is present');
assert.equal(forbiddenCoverage.recommendation, 'block', 'forbidden capabilities should block the candidate');
assert.ok(forbiddenCoverage.forbiddenActual.includes('service.telegram'), 'forbidden Telegram service should be reported');

console.log('automation coverage check passed');
console.log(`required=${coverage.required.join(',')}`);
console.log(`actual=${coverage.actual.join(',')}`);
console.log(`missing=${coverage.missingRequired.join(',')}`);
