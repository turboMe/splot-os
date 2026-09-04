/**
 * Stable generateReview() gateway for Code Review Agent calls.
 */

import { CODE_REVIEW_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { buildReviewPrecontext } from './review-precontext.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessContextBuilderInput,
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type ReviewHarnessPhase = Extract<HarnessPhase, 'review'>;

export type ReviewGenerateInput = Omit<HarnessGenerateInput, 'agentId' | 'phase'> & {
  agentId?: string;
  phase?: ReviewHarnessPhase;
  reviewIteration?: number;
};


/**
 * The same precontext, in the shape V2's capability registry consumes.
 *
 * `generateReview` below is the LEGACY entry point, and V2 does not call it: the
 * durable worker goes through `generateWithHarness` directly, so a reviewer
 * running as a V2 job got no review precontext at all — no diff, no changed
 * files, no verification signals, no previous review notes. It reviewed from the
 * brief alone and nothing said so.
 *
 * Declared here rather than in the registry so the two paths cannot drift: this
 * object IS what `generateReview` spreads.
 */
export const reviewPrecontextFields = {
  precontextFeatureFlag: 'FEATURE_REVIEW_PRECONTEXT',
  precontextFeature: 'review_precontext',
  precontextDefaultEnabled: true,
  contextBuilder: (context: HarnessContextBuilderInput) => buildReviewPrecontext({
    taskId: context.taskId,
    subtaskId: context.subtaskId,
    agentId: canonicalizeRuntimeAgentId(context.agentId) ?? CODE_REVIEW_AGENT_ID,
    threadId: context.threadId,
    userPrompt: context.userPrompt,
    maxTokens: context.maxTokens ?? 1800,
  }),
} as const;

export async function generateReview<TResponse = unknown>(
  input: ReviewGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  const { agentId, phase: _phase, reviewIteration, ...rest } = input;
  const runtimeAgentId = canonicalizeRuntimeAgentId(agentId) ?? CODE_REVIEW_AGENT_ID;

  return generateWithHarness<TResponse>({
    ...rest,
    agentId: runtimeAgentId,
    phase: 'review',
    ...reviewPrecontextFields,
    memoryResource: rest.memoryResource ?? CODE_REVIEW_AGENT_ID,
    // Legacy also knows WHICH review iteration this is; V2 has no such loop yet.
    contextBuilder: (context) => buildReviewPrecontext({
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: runtimeAgentId,
      threadId: context.threadId,
      userPrompt: context.userPrompt,
      maxTokens: context.maxTokens ?? 1800,
      reviewIteration,
    }),
  });
}
