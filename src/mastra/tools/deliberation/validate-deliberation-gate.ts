import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  DELIBERATION_WORKER_ROLES,
  type DeliberationWorkerRole,
} from './run-deliberation-worker.js';

export const DELIBERATION_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const DELIBERATION_DEPTHS = ['light', 'standard', 'deep'] as const;
export const DELIBERATION_PHASES = [
  'proposals',
  'red_team_critique',
  'synthesis',
  'second_red_team',
] as const;

export type DeliberationRiskLevel = typeof DELIBERATION_RISK_LEVELS[number];
export type DeliberationDepth = typeof DELIBERATION_DEPTHS[number];
export type DeliberationPhase = typeof DELIBERATION_PHASES[number];

export type DeliberationGateInput = {
  riskLevel: DeliberationRiskLevel;
  debateDepth: DeliberationDepth;
  proposalRoles: DeliberationWorkerRole[];
  phaseSequence: DeliberationPhase[];
  redTeamCritiqueCompleted: boolean;
  synthesisCompleted: boolean;
  secondRedTeamCompleted: boolean;
  decisionMemo: string;
  actionPlan: string;
};

export type DeliberationGateResult = {
  ok: boolean;
  violations: string[];
};

const PROPOSAL_ROLES = new Set<DeliberationWorkerRole>([
  'systemsArchitect',
  'llmEngineer',
  'memoryArchitect',
  'creativeStrategist',
]);
const STANDARD_PROPOSAL_ROLES = [
  'systemsArchitect',
  'llmEngineer',
  'memoryArchitect',
] as const satisfies readonly DeliberationWorkerRole[];

function matchesExactPhaseSequence(
  actual: readonly DeliberationPhase[],
  expected: readonly DeliberationPhase[],
): boolean {
  return actual.length === expected.length
    && actual.every((phase, index) => phase === expected[index]);
}

/**
 * Pure quality gate shared by the runtime tool and the captured-regression
 * check. It validates the declared execution ledger; it never asks an LLM to
 * judge whether its own process was complete.
 */
export function validateDeliberationGate(input: DeliberationGateInput): DeliberationGateResult {
  const violations: string[] = [];
  const highRisk = input.riskLevel === 'high' || input.riskLevel === 'critical';
  const needsSecondRedTeam = highRisk || input.debateDepth === 'deep';

  if (highRisk && input.debateDepth !== 'deep') {
    violations.push('high_risk_requires_deep');
  }
  if (input.proposalRoles.length === 0) {
    violations.push('proposal_role_required');
  }
  if (new Set(input.proposalRoles).size !== input.proposalRoles.length) {
    violations.push('proposal_roles_must_be_unique');
  }
  if (input.proposalRoles.some((role) => !PROPOSAL_ROLES.has(role))) {
    violations.push('critic_or_synthesizer_used_as_proposal');
  }
  const proposalRoleSet = new Set(input.proposalRoles);
  if (
    input.debateDepth === 'standard'
    && !STANDARD_PROPOSAL_ROLES.every((role) => proposalRoleSet.has(role))
  ) {
    violations.push('standard_proposal_coverage_required');
  }
  if (
    input.debateDepth === 'deep'
    && [...PROPOSAL_ROLES].some((role) => !proposalRoleSet.has(role))
  ) {
    violations.push('deep_proposal_coverage_required');
  }
  if (!input.redTeamCritiqueCompleted) {
    violations.push('red_team_critique_required');
  }
  if (!input.synthesisCompleted) {
    violations.push('synthesis_required');
  }
  if (needsSecondRedTeam && !input.secondRedTeamCompleted) {
    violations.push('second_red_team_required');
  }

  const expectedSequence: DeliberationPhase[] = [
    'proposals',
    'red_team_critique',
    'synthesis',
    ...(needsSecondRedTeam || input.secondRedTeamCompleted ? ['second_red_team' as const] : []),
  ];
  if (!matchesExactPhaseSequence(input.phaseSequence, expectedSequence)) {
    violations.push('phase_order_invalid');
  }
  if (input.decisionMemo.trim().length === 0) {
    violations.push('decision_memo_required');
  }
  if (input.actionPlan.trim().length === 0) {
    violations.push('action_plan_required');
  }

  return { ok: violations.length === 0, violations };
}

const gateInputSchema = z.object({
  riskLevel: z.enum(DELIBERATION_RISK_LEVELS),
  debateDepth: z.enum(DELIBERATION_DEPTHS),
  proposalRoles: z.array(z.enum(DELIBERATION_WORKER_ROLES)),
  phaseSequence: z.array(z.enum(DELIBERATION_PHASES)),
  redTeamCritiqueCompleted: z.boolean(),
  synthesisCompleted: z.boolean(),
  secondRedTeamCompleted: z.boolean(),
  decisionMemo: z.string(),
  actionPlan: z.string(),
});

export const validateDeliberationGateTool = createTool({
  id: 'deliberation_validate_debate',
  description:
    'Deterministically validates the Design Council phase ledger and the presence of both final deliverables. ' +
    'Call it after synthesis (and the second red-team pass when required) and before writing final artifacts. ' +
    'Do not finalize while ok=false.',
  inputSchema: gateInputSchema,
  outputSchema: z.object({
    ok: z.boolean(),
    violations: z.array(z.string()),
  }),
  execute: async (input) => validateDeliberationGate(input),
});
