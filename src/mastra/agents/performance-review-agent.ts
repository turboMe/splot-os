import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { workflowModels } from '../config/workflow-models.js';
import { infrastructure, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { getCodeTaskArtifactTool, submitReviewTool } from '../tools/dev/code-task-artifacts.js';
import { listWorktreeFilesTool, readWorktreeFileTool, worktreeDiffTool } from '../tools/dev/code-worktree.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { graphifyAffectedTool } from '../tools/dev/graphify-tools.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';

import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const performanceReviewAgent: Agent = new Agent({
  id: 'performance-review-agent',
  name: 'Performance Review Agent',
  instructions: `${await loadPrompt('coding/performance-review')}\n\n${await loadPrompt('shared/skill-shelf')}`,
  model: workflowModels.coding.review,
  workspace: codeWorkspace,
  // Mastra cuts an agent at FIVE steps when it declares nothing, and outside the
  // harness that default is the only ceiling there is. A review is: fetch the
  // diff, triage, load a methodology skill, read two or three files, check the
  // blast radius, submit — comfortably past five. Measured before this: all three
  // reviewers declared no ceiling at all.
  defaultOptions: { maxSteps: 25, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 25, providerOptions: getThinkingProviderOptions('medium') },
  defaultNetworkOptions: { maxSteps: 25 },
  inputProcessors: [createUnifiedCapabilityShelfProcessor({ agentId: 'performance-review-agent' })],
  // Keys are the names the model sees — see the note in `code-review-agent.ts`.
  // Pinned by `check:prompt-tool-names`.
  tools: {
    coding_get_artifact: getCodeTaskArtifactTool,
    coding_submit_review: submitReviewTool,
    coding_list_worktree_files: listWorktreeFilesTool,
    coding_read_worktree_file: readWorktreeFileTool,
    coding_worktree_diff: worktreeDiffTool,
    graphify_affected: graphifyAffectedTool,
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
