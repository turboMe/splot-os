/**
 * Stable generateAutomation() gateway for Automation Architect calls.
 */

import { buildAutomationPrecontext } from './automation-precontext.js';
import { AUTOMATION_ARCHITECT_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessContextBuilderInput,
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type AutomationHarnessPhase = Extract<
  HarnessPhase,
  'discover' | 'compose' | 'validate' | 'deploy' | 'test' | 'repair' | 'activate' | 'chat'
>;

export type AutomationGenerateInput = Omit<HarnessGenerateInput, 'agentId' | 'phase'> & {
  agentId?: string;
  phase: AutomationHarnessPhase;
};

/**
 * The precontext wiring, as ONE definition with two consumers.
 *
 * `generateAutomation` (legacy) spreads it below; the V2 lane reaches for it
 * through `capability-precontext.ts`. Keeping it in a single object is the point:
 * a V2 copy of these four fields would be free to drift from the legacy ones
 * silently, and "the two ends remembered the shape differently" is exactly how
 * the artifact-reference channel stayed dead for every run ever made.
 *
 * Without this block an automation run does not know which credentials exist,
 * which patterns have worked, or which failures have already been seen — so
 * losing it on V2 would be a regression, not a difference.
 */
export const automationPrecontextFields = {
  precontextFeatureFlag: 'FEATURE_AUTOMATION_PRECONTEXT',
  precontextFeature: 'automation_precontext',
  precontextDefaultEnabled: true,
  contextBuilder: (context: HarnessContextBuilderInput) => buildAutomationPrecontext({
    taskId: context.taskId,
    subtaskId: context.subtaskId,
    agentId: context.agentId,
    threadId: context.threadId,
    userPrompt: context.userPrompt,
    maxTokens: context.maxTokens ?? 1800,
    automationId: context.automationId,
    workflowId: context.workflowId,
    patternId: context.patternId,
  }),
} as const satisfies Pick<
  HarnessGenerateInput,
  'precontextFeatureFlag' | 'precontextFeature' | 'precontextDefaultEnabled' | 'contextBuilder'
>;

export async function generateAutomation<TResponse = unknown>(
  input: AutomationGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  return generateWithHarness<TResponse>({
    ...input,
    agentId: canonicalizeRuntimeAgentId(input.agentId) ?? AUTOMATION_ARCHITECT_AGENT_ID,
    ...automationPrecontextFields,
    memoryResource: input.memoryResource ?? AUTOMATION_ARCHITECT_AGENT_ID,
  });
}
