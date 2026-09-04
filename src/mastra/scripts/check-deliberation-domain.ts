#!/usr/bin/env tsx
/**
 * Design Council quality closure.
 *
 * Captured V2 regressions covered here:
 *  - a HIGH-risk architecture debate ran as standard and skipped critique after
 *    apparent unanimity;
 *  - two workers returned an empty string while the tool reported success=true;
 *  - the background result exposed only decision_memo although the board promises
 *    decision_memo + action_plan.
 *
 * Run: npx tsx src/mastra/scripts/check-deliberation-domain.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isRoleAllowedForPhase,
  normalizeDeliberationWorkerOutput,
} from '../tools/deliberation/run-deliberation-worker.js';
import { validateDeliberationGate } from '../tools/deliberation/validate-deliberation-gate.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:deliberation-domain');

const agentSource = readFileSync('src/mastra/agents/deliberation-agent.ts', 'utf8');
const basePrompt = readFileSync('src/mastra/prompts/deliberation/base.md', 'utf8');
const pipeline = readFileSync('src/mastra/prompts/deliberation/pipeline.md', 'utf8');
const workerSource = readFileSync('src/mastra/tools/deliberation/run-deliberation-worker.ts', 'utf8');
const gateSource = readFileSync('src/mastra/tools/deliberation/validate-deliberation-gate.ts', 'utf8');

check('agent loads the domain pipeline and registers its deterministic gate', () => {
  assert.ok(
    agentSource.includes("combinePrompts('deliberation/base', 'deliberation/pipeline')"),
    'deliberationAgent must load base + pipeline',
  );
  for (const tool of [
    'runDeliberationWorkerTool',
    'validateDeliberationGateTool',
    'writeDebateArtifactTool',
    'artifactPutTool',
  ]) {
    assert.ok(agentSource.includes(`${tool},`), `deliberationAgent must register ${tool}`);
  }
  assert.ok(
    !agentSource.includes('requestApprovalTool'),
    'an advisory-only agent must not expose a tool that can leave a pending approval',
  );
});

check('pipeline fixes role ordering instead of counting critics as proposals', () => {
  assert.match(
    pipeline,
    /proposal roles[^\n]*red-team critique[^\n]*synthesis[^\n]*second red-team critique/i,
    'the canonical phase order must be explicit',
  );
  assert.match(pipeline, /redTeamCritic[^\n]*never an independent proposal role/i);
  assert.match(pipeline, /synthesisPlanner[^\n]*never participates in the proposal fan-out/i);
  assert.match(pipeline, /phase: proposal/);
  assert.match(pipeline, /phase: critique/);
  assert.match(pipeline, /phase: synthesis/);
  assert.match(pipeline, /phase: second_critique/);
  assert.equal(isRoleAllowedForPhase('redTeamCritic', 'proposal'), false);
  assert.equal(isRoleAllowedForPhase('synthesisPlanner', 'proposal'), false);
  assert.equal(isRoleAllowedForPhase('systemsArchitect', 'proposal'), true);
});

check('LIVE FIXTURE: high-risk unanimous output cannot skip critique or deep mode', () => {
  // Reduced from artifacts/debates/2026-08-09/monolit-vs-mikroserwisy-agent-system:
  // risk=HIGH, depth=standard, critique="skipped — unanimous consensus".
  const result = validateDeliberationGate({
    riskLevel: 'high',
    debateDepth: 'standard',
    proposalRoles: ['systemsArchitect', 'llmEngineer', 'memoryArchitect'],
    phaseSequence: ['proposals', 'synthesis'],
    redTeamCritiqueCompleted: false,
    synthesisCompleted: true,
    secondRedTeamCompleted: false,
    decisionMemo: '# Decision Memo\nChoose a modular monolith.',
    actionPlan: '# Action Plan\nImplement in phases.',
  });

  assert.equal(result.ok, false, 'captured high-risk/no-critique run must be rejected');
  assert.ok(result.violations.includes('high_risk_requires_deep'));
  assert.ok(result.violations.includes('red_team_critique_required'));
  assert.ok(result.violations.includes('second_red_team_required'));
  assert.ok(result.violations.includes('phase_order_invalid'));
});

check('deep mode requires every proposal perspective before critique', () => {
  const result = validateDeliberationGate({
    riskLevel: 'medium',
    debateDepth: 'deep',
    proposalRoles: ['systemsArchitect', 'llmEngineer', 'memoryArchitect'],
    phaseSequence: ['proposals', 'red_team_critique', 'synthesis', 'second_red_team'],
    redTeamCritiqueCompleted: true,
    synthesisCompleted: true,
    secondRedTeamCompleted: true,
    decisionMemo: '# Decision Memo\nA decision.',
    actionPlan: '# Action Plan\nA plan.',
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('deep_proposal_coverage_required'));
});

check('a complete deep ledger passes the deterministic gate', () => {
  const result = validateDeliberationGate({
    riskLevel: 'high',
    debateDepth: 'deep',
    proposalRoles: ['systemsArchitect', 'llmEngineer', 'memoryArchitect', 'creativeStrategist'],
    phaseSequence: ['proposals', 'red_team_critique', 'synthesis', 'second_red_team'],
    redTeamCritiqueCompleted: true,
    synthesisCompleted: true,
    secondRedTeamCompleted: true,
    decisionMemo: '# Decision Memo\nDecision, alternatives, critique resolution, and risks.',
    actionPlan: '# Action Plan\nOrdered execution, validation, rollback, and success criteria.',
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

check('LIVE FIXTURE: an empty provider result can never report worker success', () => {
  const empty = normalizeDeliberationWorkerOutput('', 'proposal');
  assert.equal(empty.success, false);
  assert.equal(empty.output, '');
  assert.match(String(empty.error), /empty output/i);

  const fenceOnly = normalizeDeliberationWorkerOutput('```yaml\n\n```', 'proposal');
  assert.equal(fenceOnly.success, false, 'a fence around whitespace is still empty');
  const compactFenceOnly = normalizeDeliberationWorkerOutput('```yaml\n```', 'proposal');
  assert.equal(compactFenceOnly.success, false, 'an empty compact fence is still empty');
});

check('light normalization preserves useful legacy worker output', () => {
  const normalized = normalizeDeliberationWorkerOutput(
    '```yaml\r\nrole: llmEngineer\r\nposition: Keep the boundary explicit.\r\n```',
    'proposal',
  );
  assert.equal(normalized.success, true);
  assert.match(normalized.output, /^role: llmEngineer/);
  assert.ok(normalized.warnings.includes('markdown_fence_removed'));
  assert.ok(!normalized.warnings.includes('expected_yaml_anchor_missing'));

  const usefulProse = normalizeDeliberationWorkerOutput('A useful but non-YAML critique.', 'critique');
  assert.equal(usefulProse.success, true, 'non-empty legacy prose remains backward compatible');
  assert.ok(usefulProse.warnings.includes('expected_yaml_anchor_missing'));
});

check('worker tool forwards cancellation and exposes phase/output validation', () => {
  assert.match(workerSource, /phase:\s*phaseSchema\.describe\(/);
  assert.doesNotMatch(workerSource, /phase:\s*phaseSchema\s*\.optional\(\)/);
  assert.match(workerSource, /isRoleAllowedForPhase\(input\.role, input\.phase\)/);
  assert.match(workerSource, /normalizeDeliberationWorkerOutput\(res\.text, input\.phase\)/);
  assert.match(workerSource, /adHocWorker\.generate\(systemPrompt,\s*\{\s*abortSignal,/s);
  assert.match(workerSource, /if \(abortSignal\?\.aborted \|\| err\?\.name === 'AbortError'\) throw err/);
});

check('background advisory runs finish instead of waiting for approval', () => {
  const background = pipeline.slice(pipeline.indexOf('## Background runs'));
  assert.match(background, /do \*\*not\*\* call `system_request_approval`/i);
  assert.match(background, /future approval points inside the Decision Memo and Action Plan/i);
  assert.match(background, /NEEDS_INPUT: <one consolidated question>/);
  assert.match(background, /never end with[^\n]*awaiting approval/i);
});

check('the final product contains both deliverables and is centrally selectable', () => {
  assert.match(pipeline, /# Decision Memo/);
  assert.match(pipeline, /# Action Plan/);
  assert.match(pipeline, /last tool call[^\n]*artifactPutTool/is);
  assert.match(pipeline, /one combined Decision Package containing the complete Decision Memo and complete Action Plan/i);
  assert.match(pipeline, /summary no longer than 300 characters/i);
  assert.ok(!basePrompt.includes('next_action_for_metaAgent'), 'obsolete meta-only final contract must be gone');
});

check('gate is a real registered tool, not a prompt-only assertion', () => {
  assert.match(gateSource, /id: 'deliberation_validate_debate'/);
  assert.match(gateSource, /high_risk_requires_deep/);
  assert.match(gateSource, /red_team_critique_required/);
  assert.match(gateSource, /second_red_team_required/);
  assert.match(gateSource, /deep_proposal_coverage_required/);
  assert.match(gateSource, /decision_memo_required/);
  assert.match(gateSource, /action_plan_required/);
});

if (failures > 0) {
  console.error(`\n❌ check:deliberation-domain — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:deliberation-domain — ordered critique and both deliverables are enforced');
process.exit(0);
