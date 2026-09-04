/**
 * Stable generateKnowledge() gateway for NotebookLM Knowledge Agent calls.
 */

import { buildKnowledgePrecontext } from './knowledge-precontext.js';
import { KNOWLEDGE_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessContextBuilderInput,
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type KnowledgeHarnessPhase = Extract<
  HarnessPhase,
  'chat' | 'list' | 'source' | 'query' | 'research' | 'studio'
>;

export type KnowledgeGenerateInput = Omit<HarnessGenerateInput, 'agentId' | 'phase'> & {
  agentId?: string;
  phase: KnowledgeHarnessPhase;
};

/**
 * The precontext wiring, as ONE definition with two consumers.
 *
 * `generateKnowledge` spreads it below; the V2 lane reaches for it through
 * `capability-precontext.ts`. Same reasoning as the automation entry: a V2 copy of
 * these four fields would be free to drift from the legacy ones silently, and
 * "the two ends remembered the shape differently" is how the artifact-reference
 * channel stayed dead for every run ever made.
 */
export const knowledgePrecontextFields = {
  precontextFeatureFlag: 'FEATURE_KNOWLEDGE_PRECONTEXT',
  precontextFeature: 'knowledge_precontext',
  precontextDefaultEnabled: true,
  contextBuilder: (context: HarnessContextBuilderInput) => buildKnowledgePrecontext({
    taskId: context.taskId,
    subtaskId: context.subtaskId,
    agentId: context.agentId,
    threadId: context.threadId,
    userPrompt: context.userPrompt,
    maxTokens: context.maxTokens ?? 1400,
  }),
} as const satisfies Pick<
  HarnessGenerateInput,
  'precontextFeatureFlag' | 'precontextFeature' | 'precontextDefaultEnabled' | 'contextBuilder'
>;

export async function generateKnowledge<TResponse = unknown>(
  input: KnowledgeGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  return generateWithHarness<TResponse>({
    ...input,
    agentId: canonicalizeRuntimeAgentId(input.agentId) ?? KNOWLEDGE_AGENT_ID,
    ...knowledgePrecontextFields,
    memoryResource: input.memoryResource ?? KNOWLEDGE_AGENT_ID,
  });
}
