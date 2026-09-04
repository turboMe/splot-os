import { Agent } from '@mastra/core/agent';
import { artifactPutTool, artifactGetTool, artifactListTool } from '../tools/system/artifact-tools.js';
import { agentModels, infrastructure, resolveModelId } from '../config/model-manifest.js';
import { Memory } from '@mastra/memory';
import { delegateTaskTool } from '../tools/system/delegate-task.js';
import { delegationSalvageTool } from '../tools/system/delegation-salvage.js';
import { startAutomationRequestTool } from '../tools/system/start-automation-request.js';
import { triggerWorkflowTool } from '../tools/system/trigger-workflow.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { runWorkerTool } from '../tools/system/run-worker.js';
import { runWorkerBatchTool } from '../tools/system/run-worker-batch.js';
import { planTaskTool } from '../tools/system/plan-task.js';
import { recallWorkerLessonsTool } from '../tools/system/recall-worker-lessons.js';
import { memoryRecallTool } from '../tools/system/memory-recall.js';
import { memoryWriteTool } from '../tools/system/memory-write.js';
import { knowledgeLookupTool } from '../tools/knowledge/knowledge-lookup-tool.js';
import { specialistBuildTool } from '../tools/system/specialist-build.js';
import { skillSaveTool } from '../tools/system/skill-save.js';

import { checkPendingUpdatesTool } from '../tools/system/check-pending-updates.js';
import { ledgerStatusTool, ledgerControlTool } from '../tools/system/ledger-tools.js';
import { agentBoardListTool, agentBoardGetTool } from '../tools/system/agent-board-tools.js';
import { scheduleTaskTool } from '../tools/system/schedule-task.js';
import {
  cancelScheduledTaskTool,
  getScheduledTaskTool,
  listScheduledTasksTool,
  rescheduleScheduledTaskTool,
} from '../tools/system/scheduled-task-management.js';
import { getChainContextTool, saveChainResultTool } from '../tools/system/task-chain-tools.js';
import { getThreadContextTool } from '../tools/system/get-thread-context.js';
import { combinePrompts } from '../lib/prompt-loader.js';
import { withAnthropicSystemCache } from '../lib/anthropic-cache.js';
import { sharedMemoryOutputProcessor } from '../processors/shared-memory-output.js';
import { pendingUpdatesProcessor } from '../processors/pending-updates.js';
import { attachmentPersistProcessor } from '../processors/attachment-persist.js';
import { installMetaAgentHarness } from '../services/meta-harness.js';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getThinkingProviderOptions } from '../config/thinking-budget.js';

async function buildInstructions(): Promise<string> {
  const useTieredPrompt = isHarnessFeatureEnabled('FEATURE_META_TIERED_PROMPT', true);
  if (useTieredPrompt) {
    return await combinePrompts('meta/base-core');
  }

  // Fallback to legacy monolithic base prompt
  const basePrompt = await combinePrompts('meta/base');
  
  // Inject async-first orchestration awareness
  const asyncDelegationRule = `
## ASYNC-FIRST ORCHESTRATION (Patryk's Core Paradigm)
As Meta Agent, your primary goal is to remain IMMEDIATELY AVAILABLE for Patryk to assign further tasks without blocking on heavy operations or multi-step execution.
1. **Default to Asynchronous Execution:**
   - Any multi-agent sequence, heavy content generation, culinary menu engineering, deep research, coding, or complex workflow MUST be dispatched asynchronously (via \`delegateTaskTool\` with \`async: true\` or via \`schedule_task\` with nested \`nextStep\` and \`delayMs: 0\`).
   - Immediately acknowledge the dispatch to the user (e.g. "Przyjąłem zadanie, uruchomiłem łańcuch w tle i jestem gotowy na kolejne polecenia.") and return control immediately.
2. **Synchronous Execution is an Exception:**
   - Execute synchronously ONLY if the task strictly cannot be done asynchronously (e.g. immediate 1-turn conversation, direct short factual memory/thread recall, or tool status verification).
   - If you must execute a domain delegation synchronously, you MUST explicitly inform the user why it must run synchronously before proceeding.

## Background Task Updates
Background task results and async delegations are automatically checked and injected into your system context.
If pending updates are present, acknowledge them clearly in your reply.
You do NOT need to call \`checkPendingUpdates\` alone in a separate step before acting — you may call it in parallel or proceed directly.

## Durable Scheduled & Sequential Chains
Use \`schedule_task\` when the user asks for multi-step pipelines (e.g. Menu -> Content -> Article), delayed, or recurring work.
For multi-step pipelines, construct the full chain in a SINGLE \`schedule_task\` call using nested \`nextStep\` with \`delayMs: 0\`.
Every scheduled chain must include a clear \`chainName\`, \`stepName\`, success criteria in \`promptOrInstruction\`, and \`wake\` when the user should be notified in the originating thread.
Use \`list_scheduled_tasks\` / \`get_scheduled_task\` to inspect planned work, \`cancel_scheduled_task\` to stop obsolete work, and \`reschedule_scheduled_task\` to move a scheduled or failed task to a new time.
Do not schedule side effects such as email sending, deployment, purchases, destructive database writes, or public posts unless the user has already approved that exact action and scope.

## HIGH-CONCURRENCY WORKER POOL & PARALLEL EXECUTION (12 Slots)
1. **Parallel Execution Enabled:**
   - The runtime runs an asynchronous 12-slot worker pool. You can launch multiple background tasks or domain delegations simultaneously without blocking the queue.
   - For parallel text sub-tasks (multi-angle review, generating multiple variants, parallel analysis/extraction), use \`runWorkerBatchTool\` (\`system_run_worker_batch\`) to execute up to 10 sub-workers concurrently via Promise.all.
2. **Resource Boundaries & Mutex Awareness:**
   - **GPU Mutex (RTX 5060 Ti):** ComfyUI image generation and VoiceStudio audio rendering share a strict hardware mutex (\`concurrency = 1\` with automatic VRAM flush). The system queues them cleanly, but avoid bombarding the GPU with simultaneous requests.
   - **File Locking (RWLock):** Multiple workers/agents may read files concurrently (\`mode: 'read'\`), but only ONE worker can write to a specific file at a time (\`mode: 'write'\`). Never dispatch two workers to mutate the exact same file simultaneously.
   - **Domain State Isolation:** Do not dispatch two concurrent instances of the same domain agent to mutate the exact same project/manuscript state.
`;
  
  return basePrompt + '\n' + asyncDelegationRule;
}

export const metaAgent: Agent = installMetaAgentHarness(new Agent({
  id: 'meta-agent',
  name: 'Meta Agent',
  instructions: withAnthropicSystemCache(await buildInstructions()),
  model: resolveModelId(agentModels.metaAgent),
  defaultOptions: { maxSteps: 60, providerOptions: getThinkingProviderOptions('light') },
  defaultGenerateOptionsLegacy: { maxSteps: 60, providerOptions: getThinkingProviderOptions('light') },
  defaultStreamOptionsLegacy: { maxSteps: 60, providerOptions: getThinkingProviderOptions('light') },
  defaultNetworkOptions: { maxSteps: 60 },

  memory: new Memory({
    options: {
      // 30 messages — enough to see full retry loops and parallel call traces in context
      lastMessages: 30,
      // Phase 1.1 — Observational Memory: compresses long conversations into structured observations
      observationalMemory: {
        model: resolveModelId(infrastructure.observationalMemory),
        scope: 'thread',  // Zmiana z 'resource' na 'thread' aby izolować kontekst między czatami
        temporalMarkers: true,
        observation: {
          messageTokens: 50000,
          threadTitle: true, // OM auto-generates descriptive thread titles
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
      // Working Memory — persistent scratchpad surviving across sessions
      workingMemory: {
        enabled: true,
        template: `# Meta Agent Working Memory

## User Preferences
- **Communication style**:
- **Language**: Polish
- **Decision authority**: high autonomy

## Active Project Context
- **Current phase**:
- **Key decisions**:
- **Blockers**:

## Learned Patterns
- **Effective strategies**:
- **Known pitfalls**:
`,
      },
      // Auto-generate thread titles for Studio readability
      generateTitle: true,
    },
  }),

  // Persist key decisions to shared_memory after each response
  outputProcessors: [sharedMemoryOutputProcessor],

  // ── Supervisor essentials — always in the prompt context ──────────────────
  // Keep this list lean: only tools meta needs in EVERY turn.
  // Everything else lives in the transient tool shelf pool below.
  tools: {
    // Artifact Store (Etap 3) — exchange documents by ref, not by paste
    artifactPutTool,
    artifactGetTool,
    artifactListTool,
    // Orchestration & Delegation
    delegateTaskTool,
    // P3 (delegation-depth-hardening) — recover partial work of a timed-out delegation
    delegationSalvageTool,
    planTaskTool,
    startAutomationRequestTool,
    triggerWorkflowTool,
    requestApprovalTool,
    scheduleTaskTool,
    listScheduledTasksTool,
    getScheduledTaskTool,
    cancelScheduledTaskTool,
    rescheduleScheduledTaskTool,
    getChainContextTool,
    saveChainResultTool,
    getThreadContextTool,
    // Ad-hoc workers (blank text-only executors; tier/model resolved dynamically)
    runWorkerTool,
    runWorkerBatchTool,
    recallWorkerLessonsTool,
    // System knowledge & Grounding Facts (src/mastra/knowledge/)
    memoryRecallTool,
    memoryWriteTool,
    knowledgeLookupTool,
    // Specialist Builder & Self-Expansion
    specialistBuildTool,
    skillSaveTool,
    // Background task results (async delegation + bg_task completions)
    checkPendingUpdatesTool,
    // Task Ledger (Etap 1) — lane digest + operator controls (status/pauza/anuluj)
    ledgerStatusTool,
    ledgerControlTool,
    // Agent Board (Etap 2) — full card + track record before non-obvious delegation
    agentBoardListTool,
    agentBoardGetTool,
  },

  inputProcessors: [
    // Persist user-attached images to disk and expose their paths (filmmaker delegation, etc.)
    attachmentPersistProcessor,
    // Check for async delegation results & background task completions
    pendingUpdatesProcessor,
  ],
}));
