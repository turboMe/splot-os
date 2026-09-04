import assert from 'node:assert/strict';

import {
  classifyAutomationArchitectDelegationMode,
  evaluateAutomationArchitectDelegationContract,
  shouldUseDelegationLlmPlan,
} from '../tools/system/delegate-task.js';

const dryRunBrief = `
GOAL: Perform a read-only risk analysis and validation audit for deploying production workflows in n8n that contain credentials.
CONTEXT: Dry-run safety audit. There is no active deployment happening.
OUTPUT FORMAT: Markdown report outlining key risk scoring parameters, validation blockers, and approval conditions.
CONSTRAINTS: Do not deploy, do not activate workflows, do not change credentials.
`;

const readOnlyReport = `
# Risk and Validation Audit

This is a read-only analysis of the safety gates for n8n workflows with credentials.
It describes risk scoring, validation blockers, credential mapping checks, and approval conditions.
No deployment, activation, credential change, or production mutation is performed.
`;

const deployBrief = `
GOAL: Deploy and test the workflow "Mastra - Demo".
CONTEXT: The workflow JSON is ready and should go through the Automation Golden Path.
OUTPUT FORMAT: Return terminal status with automationId and workflowId.
CONSTRAINTS: Use the deployment guardrails.
`;

assert.equal(classifyAutomationArchitectDelegationMode(dryRunBrief), 'read_only_analysis');
assert.equal(classifyAutomationArchitectDelegationMode('Check current n8n credential status and report issues.'), 'read_only_analysis');
assert.equal(classifyAutomationArchitectDelegationMode(deployBrief), 'golden_path');

const dryRunResult = evaluateAutomationArchitectDelegationContract(dryRunBrief, readOnlyReport);
assert.equal(dryRunResult.ok, true);
assert.equal(dryRunResult.mode, 'read_only_analysis');

const readOnlyEmpty = evaluateAutomationArchitectDelegationContract(dryRunBrief, '[undefined] "" [undefined] ""');
assert.equal(readOnlyEmpty.ok, false);
assert.equal(readOnlyEmpty.failureClass, 'automation_read_only_response_incomplete');

const readOnlyMutationClaim = evaluateAutomationArchitectDelegationContract(
  dryRunBrief,
  'I have deployed and activated the workflow in production.',
);
assert.equal(readOnlyMutationClaim.ok, false);
assert.equal(readOnlyMutationClaim.failureClass, 'automation_read_only_response_incomplete');

const blockedGoldenPath = evaluateAutomationArchitectDelegationContract(
  deployBrief,
  'blocked: risk score 100. Manual redesign is required before deployment.',
);
assert.equal(blockedGoldenPath.ok, true);

const successfulGoldenPath = evaluateAutomationArchitectDelegationContract(
  deployBrief,
  'draft_created. automationId=abc-123 workflowId=wf-456. Ready for manual activation.',
);
assert.equal(successfulGoldenPath.ok, true);

const missingGoldenPathContract = evaluateAutomationArchitectDelegationContract(
  deployBrief,
  '# Report\nThis is only an analysis and does not include a terminal status.',
);
assert.equal(missingGoldenPathContract.ok, false);
assert.equal(missingGoldenPathContract.failureClass, 'automation_contract_missing');

const previousPlannerFlag = process.env.FEATURE_DELEGATION_LLM_PLAN;
process.env.FEATURE_DELEGATION_LLM_PLAN = 'true';
assert.equal(shouldUseDelegationLlmPlan('automationArchitect'), false, 'automationArchitect must bypass the delegation planner');
assert.equal(shouldUseDelegationLlmPlan('codingAgent'), true, 'other agents retain the configured delegation planner');
if (previousPlannerFlag === undefined) delete process.env.FEATURE_DELEGATION_LLM_PLAN;
else process.env.FEATURE_DELEGATION_LLM_PLAN = previousPlannerFlag;

console.log('Automation delegation contract checks passed.');
process.exit(0);
