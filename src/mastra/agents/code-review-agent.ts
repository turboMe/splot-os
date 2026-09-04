import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { workflowModels } from '../config/workflow-models.js';
import { infrastructure, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { getCodeTaskArtifactTool, submitReviewTool } from '../tools/dev/code-task-artifacts.js';
import { listWorktreeFilesTool, readWorktreeFileTool, worktreeDiffTool } from '../tools/dev/code-worktree.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { codeSearchTool } from '../tools/dev/code-search-tools.js';
import { graphifyAffectedTool } from '../tools/dev/graphify-tools.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const codeReviewAgent: Agent = new Agent({
  id: 'code-review-agent',
  name: 'Code Review Agent',
  instructions: `${await loadPrompt('coding/review')}\n\n${await loadPrompt('shared/skill-shelf')}`,
  model: workflowModels.coding.review,
  workspace: codeWorkspace,
  // Mastra cuts an agent at FIVE steps when it declares nothing, and outside the
  // harness that default is the only ceiling there is. A review is: fetch the
  // diff, triage, load a methodology skill, read two or three files, check the
  // blast radius, submit — comfortably past five. Measured before this: all three
  // reviewers declared no ceiling at all.
  defaultOptions: { maxSteps: 25, providerOptions: getThinkingProviderOptions('deep') },
  defaultGenerateOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('deep') },
  defaultStreamOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('deep') },
  defaultNetworkOptions: { maxSteps: 25 },
  inputProcessors: [createUnifiedCapabilityShelfProcessor({ agentId: 'code-review-agent' })],
  // KEYS ARE THE NAMES THE MODEL SEES — Mastra reports the key, never
  // `createTool({ id })`. Written as the registered ids so the prompt, the docs
  // and the tool registry all say the same word. Measured before this change:
  // the prompt opened with "`coding_worktree_diff` — Use this first" and the
  // runtime offered `worktreeDiffTool`; six of eleven references named nothing
  // that existed. Pinned by `check:prompt-tool-names`.
  tools: {
    coding_get_artifact: getCodeTaskArtifactTool,
    coding_submit_review: submitReviewTool,
    coding_list_worktree_files: listWorktreeFilesTool,
    coding_read_worktree_file: readWorktreeFileTool,
    coding_worktree_diff: worktreeDiffTool,
    // Blast radius: without these the reviewer can only judge the diff in
    // isolation — it can read a file it can name, but has no way to discover
    // who calls the changed symbol, which is the question a review exists to
    // answer. Both are read-only, so they widen sight, not privilege.
    graphify_affected: graphifyAffectedTool,
    code_search: codeSearchTool,
    // The prompt has told this agent to "delegate to securityReviewAgent" for
    // auth/crypto changes and to `performanceReviewAgent` for hot paths since
    // those agents were written. It had no delegation tool, and neither target
    // had an Agent Board card, so the instruction named a channel that did not
    // exist at either end. Both ends now do.
    system_delegate_task: delegateTaskTool,
    system_run_worker_batch: runWorkerBatchTool,
    system_memory_recall: memoryRecallTool,
    system_memory_write_observation: memoryWriteTool,
  },
  memory: new Memory({
    options: {
      lastMessages: 30,
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread',
        temporalMarkers: true,
        observation: {
          messageTokens: 50000,
          threadTitle: true,
          providerOptions: {
            google: {
              thinkingConfig: {
                thinkingBudget: 1024,
              },
            },
          },
        },
        reflection: {
          observationTokens: 60000,
        },
      },
      generateTitle: true,
    },
  }),
});
