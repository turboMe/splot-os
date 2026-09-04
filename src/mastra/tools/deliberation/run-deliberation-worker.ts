/**
 * run_deliberation_worker — spawn a role-specific LLM executor for Design Council debates.
 *
 * This tool replaces the generic runWorkerTool for deliberationAgent,
 * mapping strict roles to specific models defined in model-manifest.ts.
 *
 * It prevents hallucinations where the agent guesses preset names and
 * ensures strict architectural control over which model plays which role.
 */
import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { deliberationAssignments, resolveModelId } from '../../config/model-manifest.js';

export const DELIBERATION_WORKER_ROLES = [
  'systemsArchitect',
  'llmEngineer',
  'redTeamCritic',
  'creativeStrategist',
  'memoryArchitect',
  'synthesisPlanner',
] as const;

export const DELIBERATION_WORKER_PHASES = [
  'proposal',
  'critique',
  'synthesis',
  'second_critique',
] as const;

export type DeliberationWorkerRole = typeof DELIBERATION_WORKER_ROLES[number];
export type DeliberationWorkerPhase = typeof DELIBERATION_WORKER_PHASES[number];

const roleSchema = z.enum(DELIBERATION_WORKER_ROLES);
const phaseSchema = z.enum(DELIBERATION_WORKER_PHASES);

const ROLE_TO_MODEL: Record<string, string> = Object.fromEntries(
  Object.entries(deliberationAssignments).map(([k, v]) => [k, resolveModelId(v)]),
);

const ROLE_ALLOWED_PHASES: Record<DeliberationWorkerRole, readonly DeliberationWorkerPhase[]> = {
  systemsArchitect: ['proposal'],
  llmEngineer: ['proposal'],
  creativeStrategist: ['proposal'],
  memoryArchitect: ['proposal'],
  redTeamCritic: ['critique', 'second_critique'],
  synthesisPlanner: ['synthesis'],
};

export function isRoleAllowedForPhase(
  role: DeliberationWorkerRole,
  phase: DeliberationWorkerPhase,
): boolean {
  return ROLE_ALLOWED_PHASES[role].includes(phase);
}

export type NormalizedDeliberationWorkerOutput = {
  output: string;
  success: boolean;
  error?: string;
  warnings: string[];
};

/**
 * Normalize harmless provider variation without pretending malformed content is
 * valid. Empty/fence-only output is a hard failure; a missing YAML anchor is a
 * warning so existing useful workers are not broken by a stricter parser.
 */
export function normalizeDeliberationWorkerOutput(
  rawOutput: string | null | undefined,
  phase: DeliberationWorkerPhase,
): NormalizedDeliberationWorkerOutput {
  const normalized = String(rawOutput ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const fenced = /^```(?:ya?ml)?[ \t]*\n([\s\S]*?)```[ \t]*$/i.exec(normalized);
  const output = (fenced?.[1] ?? normalized).replace(/\n$/, '').trim();
  const warnings: string[] = [];

  if (fenced) warnings.push('markdown_fence_removed');
  if (output.length === 0) {
    return {
      output: '',
      success: false,
      error: 'Worker returned empty output.',
      warnings,
    };
  }

  const expectedAnchor = phase === 'critique' || phase === 'second_critique'
    ? /^critic\s*:/im
    : phase === 'synthesis'
      ? /^(?:decision_type|recommended_direction|decision)\s*:/im
      : /^role\s*:/im;
  if (!expectedAnchor.test(output)) warnings.push('expected_yaml_anchor_missing');

  return { output, success: true, warnings };
}

export const runDeliberationWorkerTool = createTool({
  id: 'run_deliberation_worker',
  description: `Spawns an LLM worker bound to a specific Design Council role.
The model for each role is pre-configured by the system architecture.
Use this instead of delegating to full expert agents.
CAN be called multiple times in parallel for independent sub-tasks or multiple roles.`,

  inputSchema: z.object({
    role: roleSchema.describe('The specific Design Council role to execute.'),

    phase: phaseSchema.describe(
      'Required debate phase. It prevents proposal, critique, and synthesis roles from being mixed.',
    ),

    taskBrief: z
      .string()
      .min(50)
      .describe(
        'Full worker brief IN ENGLISH. Must contain: GOAL, CONTEXT, INPUT, OUTPUT FORMAT, CONSTRAINTS. ' +
          'Be ruthlessly explicit — small models have no background knowledge.',
      ),

    attemptNumber: z.number().int().min(1).max(3).default(1).describe('Attempt counter (1–3). Pass 2 or 3 on retries.'),

    previousAttempt: z
      .object({
        output: z.string().describe('The bad output from the previous attempt'),
        criticism: z.string().describe('Why it was wrong / what to fix'),
      })
      .optional()
      .describe('On retry: pass the previous bad output and your diagnosis. The worker will see what NOT to do.'),
  }),

  outputSchema: z.object({
    output: z.string(),
    model: z.string(),
    role: z.string(),
    phase: phaseSchema,
    attemptNumber: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),

  execute: async (input, { mastra, abortSignal }) => {
    // If somehow the role is wrong, fallback to synthesisPlanner model.
    const modelId = ROLE_TO_MODEL[input.role] ?? ROLE_TO_MODEL.synthesisPlanner;
    const attemptNumber = input.attemptNumber ?? 1;

    if (!isRoleAllowedForPhase(input.role, input.phase)) {
      return {
        output: '',
        model: modelId,
        role: input.role,
        phase: input.phase,
        attemptNumber,
        success: false,
        error: `Role ${input.role} is not allowed in phase ${input.phase}.`,
      };
    }

    let systemPrompt = input.taskBrief;

    // Optional retry context injection
    if (input.previousAttempt && attemptNumber > 1) {
      systemPrompt += `\n\n---
[RETRY CONTEXT - ATTEMPT ${attemptNumber}]
You previously generated an output that was rejected.

PREVIOUS BAD OUTPUT:
"""
${input.previousAttempt.output}
"""

CRITICISM / REASON FOR REJECTION:
"""
${input.previousAttempt.criticism}
"""

Please fix the mistakes and try again.`;
    }

    try {
      const adHocWorker = new Agent({
        id: `deliberation-worker-${input.role}-${Date.now()}`,
        name: `Ad-Hoc Deliberation Worker (${input.role})`,
        mastra: mastra as any,
        instructions:
          `You are an AI executing the role of ${input.role} in a Design Council debate.\n` +
          'You are a pure text-in-text-out function. No tools, no memory.\n' +
          'Follow the task brief EXACTLY. Do not invent facts. Return ONLY the requested format.',
        model: modelId as any,
      });

      // Execute worker
      const res = await adHocWorker.generate(systemPrompt, { abortSignal, }); // @harness-exempt — no-tool text-only debate worker

      const normalized = normalizeDeliberationWorkerOutput(res.text, input.phase);

      return {
        output: normalized.output,
        model: modelId,
        role: input.role,
        phase: input.phase,
        attemptNumber,
        success: normalized.success,
        error: normalized.error,
        warnings: normalized.warnings.length > 0 ? normalized.warnings : undefined,
      };
    } catch (err: any) {
      if (abortSignal?.aborted || err?.name === 'AbortError') throw err;
      console.error(`[runDeliberationWorkerTool] Error running ${input.role} on ${modelId}:`, err);
      return {
        output: '',
        model: modelId,
        role: input.role,
        phase: input.phase,
        attemptNumber,
        success: false,
        error: err?.message || String(err),
      };
    }
  },
});
