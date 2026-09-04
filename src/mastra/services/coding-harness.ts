/**
 * Stable generateCoding() gateway for coding LLM calls.
 *
 * The shared harness core lives in generate-with-harness.ts; this file keeps
 * the public coding-agent contract unchanged.
 */

import { buildCodingPrecontext } from './coding-precontext.js';
import { CODING_AGENT_ID, canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { generateWithHarness } from './generate-with-harness.js';
import type {
  HarnessContextBuilderInput,
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
} from './generate-with-harness.js';

export type {
  HarnessGenerateInput,
  HarnessGenerateResult,
  HarnessPhase,
};

/**
 * The precontext half of a coding call, as one object both engines spread.
 *
 * Extracted so V2 can hand `codingAgent` exactly what legacy hands it, from the
 * same place — the pattern `automationPrecontextFields` already established. Two
 * copies of "what context does this agent need" is the shape that let the V2 path
 * run four dedicated-harness agents with no precontext at all for months.
 *
 * `repoPath` travels WITH it, and that is not cosmetic: without a repo path
 * `buildCodingPrecontext` records `repoPath_missing` and silently drops the
 * repository map and the task checkpoint — two of the four sections. Every legacy
 * call site passes `AGENTIC_AGENTS_REPO` explicitly; V2 has no call site to do
 * that, so the default belongs here.
 */
export const codingPrecontextFields = {
  precontextFeatureFlag: 'FEATURE_CODING_PRECONTEXT',
  precontextFeature: 'coding_precontext',
  precontextDefaultEnabled: false,
  repoPath: AGENTIC_AGENTS_REPO,
  contextBuilder: (context: HarnessContextBuilderInput) => buildCodingPrecontext({
    taskId: context.taskId,
    subtaskId: context.subtaskId,
    agentId: context.agentId,
    threadId: context.threadId,
    goalContractId: context.goalContractId,
    userPrompt: context.userPrompt,
    // The caller's repo wins when it has one (an external project, a worktree);
    // the agent's own repository is the fallback, not an override.
    repoPath: context.repoPath ?? AGENTIC_AGENTS_REPO,
    targetFiles: context.targetFiles,
    maxTokens: context.maxTokens ?? 2048,
    includeMemory: context.includeMemory,
    includeSkills: context.includeSkills,
    includeRepoMap: context.includeRepoMap,
    includeCheckpoint: context.includeCheckpoint,
  }),
} as const satisfies Pick<
  HarnessGenerateInput,
  'precontextFeatureFlag' | 'precontextFeature' | 'precontextDefaultEnabled' | 'contextBuilder' | 'repoPath'
>;

export async function generateCoding<TResponse = unknown>(
  input: HarnessGenerateInput,
): Promise<HarnessGenerateResult<TResponse>> {
  return generateWithHarness<TResponse>({
    ...codingPrecontextFields,
    ...input,
    // `input` may legitimately override `repoPath` (subtask executor points it at
    // the task worktree), but never the precontext wiring itself.
    precontextFeatureFlag: codingPrecontextFields.precontextFeatureFlag,
    precontextFeature: codingPrecontextFields.precontextFeature,
    precontextDefaultEnabled: codingPrecontextFields.precontextDefaultEnabled,
    contextBuilder: codingPrecontextFields.contextBuilder,
    repoPath: input.repoPath ?? codingPrecontextFields.repoPath,
    memoryResource: input.memoryResource ?? canonicalizeRuntimeAgentId(input.agentId) ?? CODING_AGENT_ID,
  });
}
