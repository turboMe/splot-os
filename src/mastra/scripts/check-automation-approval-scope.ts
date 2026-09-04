#!/usr/bin/env tsx
/**
 * Regression for the 2026-08-24 Automation Architect approval deadlock.
 *
 * An approved dashboard token never reached the tool body because critical
 * depth blocked the high-risk envelope first. Durable jobs made the separate
 * dashboard queue worse: nobody was present to notice or resume it. Architect
 * authorization now comes from trusted runtime identity plus the exact current
 * request; every deterministic workflow guard remains intact.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  META_AGENT_ID,
} from '../config/agent-ids.js';
import { classifyComplexity } from '../services/depth-controller.js';

const read = (path: string): string => readFileSync(path, 'utf8');

const architectDepth = classifyComplexity({
  prompt: 'Aktywuj produkcyjny workflow i wykonaj test z real credentials.',
  agentId: AUTOMATION_ARCHITECT_AGENT_ID,
  phase: 'activate',
});
assert.equal(architectDepth.level, 'critical', 'the risky task must still classify as critical');
assert.equal(
  architectDepth.profile.requireApproval,
  false,
  'critical Automation Architect work must not enter the generic dashboard approval gate',
);

const metaDepth = classifyComplexity({
  prompt: 'Aktywuj produkcyjny workflow i wykonaj test z real credentials.',
  agentId: META_AGENT_ID,
  phase: 'activate',
});
assert.equal(metaDepth.level, 'critical');
assert.equal(
  metaDepth.profile.requireApproval,
  true,
  'the exception must not silently disable critical approval for other agents',
);

const agentSource = read('src/mastra/agents/automation-architect.ts');
assert.doesNotMatch(agentSource, /requestApprovalTool|system_request_approval/);

const phaseSource = read('src/mastra/config/pipeline-phase-tools.ts');
const architectPhase = phaseSource.slice(
  phaseSource.indexOf('// ── Automation Architect'),
  phaseSource.indexOf('\n};', phaseSource.indexOf('// ── Automation Architect')),
);
assert.doesNotMatch(
  architectPhase,
  /system_request_approval/,
  'Automation Architect phase shelves must not rediscover the removed dashboard tool',
);
assert.match(
  phaseSource.slice(0, phaseSource.indexOf('// ── Automation Architect')),
  /system_request_approval/,
  'shared approval tooling for other agents must remain registered',
);

const promptSource = read('src/mastra/prompts/automation/base.md');
assert.doesNotMatch(promptSource, /requestApprovalTool/);
assert.match(promptSource, /Do not call `system_request_approval`/);
assert.match(promptSource, /does not use the dashboard approval queue/i);
assert.match(promptSource, /risk verdict `block` remain hard stops/i);

for (const path of [
  'src/mastra/tools/architect/activate.ts',
  'src/mastra/tools/architect/deploy.ts',
  'src/mastra/tools/architect/testing/test-workflow.ts',
]) {
  const source = read(path);
  assert.doesNotMatch(source, /collection\(['"]approvals['"]\)/, `${path} still reads dashboard approvals`);
  assert.doesNotMatch(source, /Invalid or unapproved approvalToken|requires approvalToken|requires approval:/i);
  assert.match(source, /managedBy|risk|validation/i, `${path} lost its deterministic safety checks`);
}

const goldenPath = read('src/mastra/services/automation-golden-path.ts');
assert.match(goldenPath, /canonicalizeRuntimeAgentId\(control\.actorAgentId\)/);
assert.match(goldenPath, /dashboardApprovalExempt/);
assert.match(goldenPath, /risk\.verdict === 'block'/, 'risk=block must remain a hard stop');
assert.match(goldenPath, /FORBIDDEN_NODE_TYPES/, 'forbidden-node policy must remain active');

for (const path of [
  'src/mastra/tools/architect/execute-request.ts',
  'src/mastra/tools/architect/automation-jobs.ts',
  'src/mastra/tools/system/start-automation-request.ts',
]) {
  const source = read(path);
  assert.doesNotMatch(
    source,
    /dashboardApprovalExempt\s*:/,
    `${path} exposes the trusted approval bypass as model input`,
  );
  assert.doesNotMatch(
    source,
    /approvalActorAgentId:\s*(?:context|input|parsedContext)\./,
    `${path} derives trusted approval authority from model input`,
  );
}

assert.match(
  read('src/mastra/services/automation-job-manager.ts'),
  /actorAgentId: routing\.approvalActorAgentId/,
  'legacy jobs must carry trusted Architect identity into Golden Path',
);
assert.match(
  read('src/mastra/services/durable-automation-jobs.ts'),
  /actorAgentId: row\.approvalActorAgentId/,
  'durable jobs must carry trusted Architect identity into Golden Path',
);

console.log('Automation Architect approval scope checks passed.');
