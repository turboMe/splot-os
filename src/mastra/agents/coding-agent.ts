import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { Memory } from '@mastra/memory';
import { createTokenLimiter } from '../lib/token-limiter.js';
import { createUnifiedCapabilityShelfProcessor } from '../processors/unified-capability-shelf.js';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';
import { mcpClient } from '../mcp.js';
import {
  createCodeTaskArtifactTool,
  getCodeTaskArtifactTool,
  updateCodeTaskArtifactTool,
  runTestCommandTool,
} from '../tools/dev/code-task-artifacts.js';
import {
  acceptAllChangesTool,
  acceptFileChangeTool,
  recordAfterChangeTool,
  recordBeforeChangeTool,
  rejectAllChangesTool,
  rejectFileChangeTool,
  writeFileTrackedTool,
} from '../tools/dev/code-change-ledger.js';
import {
  initWorktreeTool,
  removeWorktreeTool,
  applyWorktreePatchTool,
} from '../tools/dev/code-worktree.js';
import {
  createExternalProjectTool,
  listExternalProjectsTool,
  writeExternalProjectFileTool,
  runExternalProjectCommandTool,
  delegateToReviewerTool,
} from '../tools/dev/external-projects-tools.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';

import { repoMapTool, repoStatsTool, repoReindexTool } from '../tools/dev/repo-map-tools.js';
import { codeSearchTool, codeEmbedStatsTool } from '../tools/dev/code-search-tools.js';
import { graphifyAffectedTool, graphifyExplainTool, graphifyGodNodesTool } from '../tools/dev/graphify-tools.js';
import { codeOutlineTool } from '../tools/dev/code-outline-tool.js';
import { bgTaskTool } from '../tools/dev/background-task-tool.js';
import { wrapPlaywrightToolsWithPolicy } from '../services/browser-tool-policy-wrapper.js';

// ── MCP toolsets (Context7 docs, Playwright browser) — defensive, won't block startup ──
let context7Tools: Record<string, any> = {};
let playwrightTools: Record<string, any> = {};
try {
  const mcpToolsets = await mcpClient.listToolsets();
  context7Tools = mcpToolsets['context7'] ?? {};
  // Wrapped BEFORE it ever reaches `tools:` — raw MCP tools bypass
  // withToolEnvelope entirely, so gating happens here or not at all.
  playwrightTools = wrapPlaywrightToolsWithPolicy(mcpToolsets['playwright'] ?? {});
} catch (err) {
  console.warn('[coding-agent] MCP listToolsets failed — starting without Context7/Playwright:', (err as Error).message);
}
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

export const codingAgent: Agent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: withAnthropicSystemCache(
    `${await loadPrompt('coding/base')}\n\n${await loadPrompt('shared/skill-shelf')}\n\nRespond concisely and to the point, especially when asked about task status.`,
  ),
  model: resolveModelId(agentModels.codingAgent),
  workspace: codeWorkspace,
  defaultOptions: { maxSteps: 40, providerOptions: getThinkingProviderOptions('medium') },
  defaultGenerateOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('medium') },
  defaultStreamOptionsLegacy: { maxSteps: 40, providerOptions: getThinkingProviderOptions('medium') },
  defaultNetworkOptions: { maxSteps: 40 },
  // KEYS ARE THE NAMES THE MODEL SEES — Mastra reports the object key, never
  // `createTool({ id })`. Written as the registered ids so the prompt, the docs,
  // `pipeline-phase-tools.ts` and the tool registry all say the same word.
  // Measured before this change: `coding/base.md` instructed the agent to call
  // `coding_init_worktree`, `coding_apply_patch`, `coding_run_test`, `bg_task`,
  // `repo_map`, `code_search` and `system_memory_*` — nine names, none of which
  // the runtime offered. Pinned by `check:prompt-tool-names`.
  tools: {
    // Artifact Store (Etap 3) — exchange documents by ref, not by paste
    artifact_put: artifactPutTool,
    artifact_get: artifactGetTool,
    artifact_list: artifactListTool,
    coding_create_artifact: createCodeTaskArtifactTool,
    coding_update_artifact: updateCodeTaskArtifactTool,
    coding_get_artifact: getCodeTaskArtifactTool,
    coding_run_test: runTestCommandTool,
    coding_init_worktree: initWorktreeTool,
    coding_remove_worktree: removeWorktreeTool,
    coding_apply_patch: applyWorktreePatchTool,
    coding_record_before_change: recordBeforeChangeTool,
    coding_record_after_change: recordAfterChangeTool,
    coding_reject_file: rejectFileChangeTool,
    coding_reject_all: rejectAllChangesTool,
    coding_accept_file: acceptFileChangeTool,
    coding_accept_all: acceptAllChangesTool,
    coding_write_file_tracked: writeFileTrackedTool,
    createExternalProject: createExternalProjectTool,
    listExternalProjects: listExternalProjectsTool,
    writeExternalProjectFile: writeExternalProjectFileTool,
    runExternalProjectCommand: runExternalProjectCommandTool,
    delegateToReviewer: delegateToReviewerTool,
    // Helpers and specialists. `coding/base.md` has instructed the agent to use
    // `system_run_worker` and `system_request_approval` since it was written, and
    // neither was ever registered — dead instructions the model could only fail
    // to follow. Measured by `check:prompt-tool-names`, which reports them as
    // references to tools this agent does not hold.
    //
    // `system_run_worker` is also the V2 shape of the legacy parallel dispatch:
    // several calls in ONE step run concurrently (the AI SDK executes a step's
    // tool calls through `Promise.all`), but a worker is text-in/text-out with no
    // tools, so it analyses and reviews while the agent itself does the writing.
    // `system_delegate_task` is the other half the owner asked for: reaching the
    // researcher or the deliberation council when the task needs them.
    system_run_worker: runWorkerTool,
    system_run_worker_batch: runWorkerBatchTool,
    system_delegate_task: delegateTaskTool,
    system_request_approval: requestApprovalTool,
    // System knowledge (Phase 1.4)
    system_memory_recall: memoryRecallTool,
    system_memory_write_observation: memoryWriteTool,

    // Repo Indexing (Phase 5 — Structural Code Navigation)
    repo_map: repoMapTool,
    repo_stats: repoStatsTool,
    repo_reindex: repoReindexTool,
    code_outline: codeOutlineTool,
    // Semantic Code Search (Phase 5 — Embedding-based)
    code_search: codeSearchTool,
    code_embed_stats: codeEmbedStatsTool,
    // Impact analysis (Etap 8 — Graphify): what depends on a symbol, before editing it
    graphify_affected: graphifyAffectedTool,
    graphify_explain: graphifyExplainTool,
    graphify_god_nodes: graphifyGodNodesTool,
    // Background Tasks (Sprint 5 — Harness Etap 6)
    bg_task: bgTaskTool,
    // Context7 — up-to-date library docs (for external projects with unfamiliar stacks)
    ...context7Tools,
    // Playwright MCP — browser automation & verification
    ...playwrightTools,
  },
  memory: new Memory({
    options: {
      lastMessages: 30,
      // ObservationalMemory (scope:'thread') DISABLED for the coding agent.
      //
      // As a thread-scoped input processor it throws "requires a threadId, but
      // none was found in RequestContext or MessageList" on every generate where
      // Mastra fails to surface the thread into RequestContext — which happens
      // non-deterministically once the model manager falls back past the first
      // model (the fallback attempt loses the memory context). Each throw is
      // counted as a failed model attempt, so the whole call ends "Exhausted all
      // fallback models. Last error: ...ObservationalMemory..." and the agent
      // writes nothing. Observed identically in dev and in the production build
      // (4 exhausted / 14 OM errors each); in dev it occasionally slipped a write
      // through, in the slot-based build it wrote 0 — which is what stalled the
      // autoheal repair loop before staging/promote.
      //
      // We pass memory correctly (`memory:{thread,resource}`, the non-deprecated
      // API), so the root cause is in Mastra's OM/fallback interaction, not here.
      // The coding agent keeps lastMessages:30 for in-task context; cross-subtask
      // OM was a nice-to-have not worth trading the repair loop's reliability for.
      // Other agents keep their OM. Revisit if a Mastra release fixes the
      // fallback→memory propagation.
      generateTitle: true,
    },
  }),
  // Phase 5 — Context window protection (prevents overflow in long autonomous sessions)
  inputProcessors: [
    createUnifiedCapabilityShelfProcessor({ agentId: 'coding-agent' }),
    // Effective limit for Gemini 2.5 Flash (actual: 1M, but perf degrades after ~120K).
    // special tokens disabled so <|endoftext|> literals in code/web content don't crash it.
    createTokenLimiter(120_000),
  ],
});
