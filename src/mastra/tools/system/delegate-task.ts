/**
 * System tool: delegate task to a specialized sub-agent.
 * Supports all registered agents by name + optional threadId for memory continuity.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { logAgentEvent } from '../../lib/agent-event-log.js';
import { workerTaskSpecSchema, renderWorkerBriefWithArtifacts } from './worker-task-spec.js';
import { parseResultEnvelope } from '../../services/result-envelope.js';
import { recordDistillationCandidate } from '../../services/skill-distiller.js';
import { loadPrompt } from '../../lib/prompt-loader.js';
import { AGENT_BOARD_IDS } from '../../config/agent-board.js';
import { generatePlan, type Plan } from './plan-task.js';
import { generateCoding } from '../../services/coding-harness.js';
import { generateAutomation } from '../../services/automation-harness.js';
import { generateKnowledge } from '../../services/knowledge-harness.js';
import { generatePipelineWithReflection } from '../../services/generate-pipeline-with-reflection.js';
import { startAsyncDelegation } from '../../services/async-delegation.js';
import { getCurrentRunRemainingBudgetMs } from '../../services/run-budget.js';
import {
  getCurrentRunAbortSignal, getHarnessExecutionContext,
} from '../../services/harness-execution-context.js';
import { markMcpHandoffFailed, clearMcpHandoffFailed, markMcpHandoffSucceeded } from '../../services/mcp-handoff-state.js';
import { isHarnessFeatureEnabled } from '../../config/harness-flags.js';
import { isPipelineAgent } from '../../config/pipeline-phase-tools.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';

/**
 * Mode selection for codingAgent is prompt-only (`coding/base.md` §1) — nothing
 * upstream routes on it, so this delegation call site cannot know in advance
 * whether the model will work in its own repo or scaffold/edit an external one
 * under `/projekty/agent-projects/<name>`. Every call here used to pass
 * `AGENTIC_AGENTS_REPO` unconditionally, so an external-project brief still
 * handed the model a repo map and checkpoint for a codebase the task never
 * touches — wasted context budget and a misleading "here is the repository"
 * frame on a task that isn't about this repository at all.
 *
 * Deliberately narrow and one-directional: this can only SUPPRESS the default,
 * never invent a different one, and it only fires on an unambiguous signal
 * (the actual external-projects path, or the exact upstream contract name from
 * the prompt). A brief that merely mentions "external" or "new project" in
 * passing — plausible for capability-build work too — still gets the own-repo
 * default, which is today's behaviour, not a regression.
 *
 * `''` rather than `undefined`: `generateCoding`/`codingPrecontextFields` both
 * fall back to `AGENTIC_AGENTS_REPO` with `??`, which treats `undefined` as
 * "caller didn't say" and refills it — exactly the default V2's own callers
 * rely on (Z6). `??` does not treat `''` as nullish, so an explicit empty
 * string survives both fallback layers and reaches `buildCodingPrecontext`,
 * which already has a graceful path for it (`suppressedReasons: ['repoPath_missing']`).
 */
const EXTERNAL_PROJECT_TASK_SIGNAL = /\/projekty\/agent-projects\/|createExternalProject\(/;

export function repoPathForCodingDelegation(taskDescription: string): string {
  return EXTERNAL_PROJECT_TASK_SIGNAL.test(taskDescription) ? '' : AGENTIC_AGENTS_REPO;
}
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import {
  completeGoalContract,
  createGoalContract,
  evaluateCompletion,
  recordEvidence,
  recordPlanRevision,
  type GoalContract,
} from '../../services/goal-tracker.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  CAPABILITY_SMITH_AGENT_ID,
  CODING_AGENT_ID,
  CODE_REVIEW_AGENT_ID,
  DELIBERATION_AGENT_ID,
  DELEGATION_CALLER_AGENT_IDS,
  DELEGATION_RETURN_AGENT_IDS,
  DESIGN_AGENT_ID,
  FILMMAKER_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  META_AGENT_ID,
  MUSICIAN_AGENT_ID,
  N8N_MCP_ENGINEER_AGENT_ID,
  WRITER_AGENT_ID,
  canonicalizeRuntimeAgentId,
  isSelfDelegation,
} from '../../config/agent-ids.js';

// Lazy-loaded to avoid circular: delegate-task → index → meta-agent → delegate-task
let _mastra: any = null;
async function getMastra() {
  if (!_mastra) {
    const mod = await import('../../index.js');
    _mastra = mod.mastra;
  }
  return _mastra;
}

import {
  AGENT_SOURCE_REGISTRY,
  type AgentRegistryKey,
} from '../../config/agent-source-registry.js';

// Mastra registry keys — must match the property names in `new Mastra({ agents: { ... } })`
// Sourced directly from AGENT_SOURCE_REGISTRY single source of truth (including n8nMcpEngineer: N8N_MCP_ENGINEER_AGENT_ID).
const AGENT_IDS: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_SOURCE_REGISTRY).map(([key, def]) => [key, def.registryKey]),
);

type AgentKey = AgentRegistryKey;

type AutomationDelegationMode = 'read_only_analysis' | 'golden_path';

const DEFAULT_DIRECT_DELEGATION_TIMEOUT_MS = 900_000;
// Filmmaker runs the full reflection pipeline plus remote video generation (submit +
// poll + MP4 download). Keep its timeout independently env-overridable even though
// its current default matches the generic budget, so generation can be tuned alone.
const DEFAULT_FILMMAKER_DELEGATION_TIMEOUT_MS = 900_000;
// WS-D — automation builds (compose + deploy + mock test + bounded repair) can
// legitimately exceed the generic 900s budget. The old hard 300s caused real
// builds to report `failed` on timeout even after producing a deployed+tested
// inactive workflow. Give it a dedicated, env-overridable budget with headroom
// for complex builds (MCP handoff + many nodes + repair). WS-A aborts cleanly if
// it ever fires, so a generous default is safe (no zombie).
const DEFAULT_AUTOMATION_DELEGATION_TIMEOUT_MS = 1_200_000;
// Raised 8 -> 20 (2026-08-25): validating a candidate workflow with several
// instances of one unfamiliar node type (e.g. 7x htmlExtract across different
// sources) needs search_nodes + get_node + validate_node per instance plus a
// final validate_workflow and synthesis. 8 steps measured 6/8 handoffs
// returning empty (ran out of steps before writing the final JSON) on exactly
// that shape of task; see project_architect_e2e_audit_20260824 memory. Hard
// ceiling stays 24 (see getN8nMcpEngineerDelegationMaxSteps below).
const DEFAULT_N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS = 20;
// P2 (delegation-depth-hardening) — budget coordination with the parent run.
// A sync child must finish BEFORE the parent's own wall-clock budget expires,
// or its result has nobody to return to (observed live: parent died at 300s,
// child timed out 47s later). The margin reserves time for the parent to
// receive the result, narrate, and persist state after the child returns.
//
// Raised 20s → 120s on 2026-08-24. Twenty seconds covered "receive and persist"
// but NOT the parent's own closing LLM call, so a child was allowed to eat the
// entire parent budget and the finished work died with nobody to report it.
// Measured to the second on a meta→automationArchitect run:
//   14:35:12  meta starts, 1200s budget           → hard deadline 14:55:12
//   14:49:31  re-delegates, 341s remain           → child gets 341−20 = 320.867s
//   14:54:54  child times out                     → 18s left for meta to answer
//   14:55:12  meta run_failed on the wall clock   → caller got HTTP 504, empty body
// The n8n workflow the child had ALREADY built at 14:47 was correct and live;
// the user just never saw it. The reserve must therefore cover one closing model
// step PLUS the post-run harness work that follows it — `auto_review` alone
// measured 40s at `critical` depth on that same run.
//
// Sizing this UP is the safe direction: a child that no longer fits is either
// capped shorter (and still returns something the parent can report) or fails
// the viability gate and routes to the async lane, which returns immediately and
// leaves the parent its full remaining time. Both beat losing the run.
const DEFAULT_DELEGATION_SYNC_SAFETY_MARGIN_MS = 120_000;
// Below this budget a sync delegation is pointless — auto-route to async.
const DEFAULT_DELEGATION_MIN_VIABLE_SYNC_MS = 60_000;

type AutomationDelegationContractResult = {
  ok: boolean;
  mode: AutomationDelegationMode;
  failureClass?: 'automation_contract_missing' | 'automation_read_only_response_incomplete';
  message?: string;
};


/**
 * WHO is delegating — taken from the RUN, not from what the model typed.
 *
 * `callerAgentId` arrives as a tool argument with `default(META_AGENT_ID)`, and
 * two things depend on it: the recursion guards, and the gate that keeps
 * `n8nMcpEngineer` available to `automationArchitect` alone. Deciding either from
 * a field the model fills in fails in both directions at once:
 *
 *  - FORGOTTEN: the architect's prompt tells it to set
 *    `callerAgentId: "automationArchitect"`, and if the model omits it the handoff
 *    returns `n8n_mcp_engineer_caller_not_allowed`. Per its own instructions the
 *    architect must then stop and report `mcp_handoff_failed` — so a whole
 *    workflow build dies of a missing field rather than of anything about the work.
 *  - CLAIMED: any agent could type `callerAgentId: "automationArchitect"` and
 *    reach the internal helper. This is the class of field the result envelope
 *    already refuses to read from model content: identity is stamped by the
 *    runtime from trusted context, never asserted by the thing being identified.
 *
 * The harness execution context knows the answer — the same AsyncLocalStorage
 * that carries the abort signal into tools. Outside a run (scripts, legacy direct
 * calls) there is no context and the declared value stands, so nothing that
 * worked before changes.
 *
 * Exported so the rule can be TESTED without executing a delegation: the tool
 * itself pulls the whole agent graph and would start real work.
 */
export function resolveDelegationCaller(declared: string | undefined): string {
  const claimed = canonicalizeRuntimeAgentId(declared) ?? META_AGENT_ID;
  const fromRun = canonicalizeRuntimeAgentId(getHarnessExecutionContext()?.agentId ?? '');
  if (fromRun && fromRun !== claimed) {
    console.warn(
      `[delegate-task] caller identity taken from the run: ${fromRun} (the call declared ${claimed})`,
    );
  }
  return fromRun ?? claimed;
}

export const delegateTaskTool = createTool({
  id: 'system_delegate_task',
  description: `Hand off a task to a domain EXPERT agent that has its own identity, tools, and memory.
Use when the task needs the expert's TOOL STACK or domain pipeline; for pure text generation use system_run_worker.

The agent roster lives on the Agent Board (single source of truth):
- agent_board_list → one-line overview of every agent (delegation mode, cost, track record)
- agent_board_get(agentId) → full card: when to use / NOT use, input contract, example briefs, hard rules
Consult the board BEFORE any non-obvious delegation — choose by data, not memory.

Briefing: PREFER structured taskSpec (goal, context, outputContract, scope with outOfScope, successCriteria, constraints).
Free-form taskDescription (GOAL + CONTEXT + OUTPUT FORMAT + CONSTRAINTS, in English) is the fallback.
Independent tasks CAN be delegated in parallel in one turn.
n8n builds: prefer system_start_automation_request when structured Golden Path input exists; otherwise delegate the goal to automationArchitect (never raw workflow JSON as text, never directly to n8nMcpEngineer).`,
  inputSchema: z.object({
    targetAgent: z.enum(AGENT_BOARD_IDS)
      .describe('Name of the sub-agent to whom we delegate the task'),
    taskSpec: workerTaskSpecSchema
      .optional()
      .describe('PREFERRED: structured task contract (goal, scope, outputContract, successCriteria). When provided, it is rendered into the brief and takes precedence over taskDescription.'),
    taskDescription: z.string().min(10).optional().describe('Fallback free-form brief IN ENGLISH when taskSpec is not used: GOAL + CONTEXT + OUTPUT FORMAT + CONSTRAINTS. Prefer taskSpec.'),
    taskBrief: z.string().min(10).optional().describe('Concise brief/instructions (fallback when taskSpec/taskDescription is omitted).'),
    skills: z.array(z.string()).optional().describe('List of skill names from SkillRegistry to inject as standard operating procedures (SOPs).'),
    modelTier: z.enum(['auto', 'fast', 'balanced', 'pro', 'private']).default('auto').optional().describe('Execution model tier. "fast" uses fast LPU/flash cloud model when a deterministic skill SOP exists; "balanced" uses standard domain model; "pro" uses deep reasoning; "private" uses local Ollama.'),
    inputArtifactIds: z.array(z.string()).optional().describe('Artifact IDs produced by upstream agents for sequential pipelining/handoff.'),
    taskSpecArtifactId: z.string().optional().describe(
      'P4d: id of an artifact (saved via artifact_put) holding the FULL brief. ' +
      'Use for LONG briefs (>2k tokens): save the brief as an artifact first, then pass only its id here — ' +
      'a huge inline argument risks truncation on small context budgets. Ignored when taskSpec/taskDescription is provided.',
    ),
    threadId: z.string().optional().describe('ThreadId from Mastra Memory — pass it when you want to maintain conversation continuity with the sub-agent'),
    resourceId: z.string().optional().describe('ResourceId (e.g. userId) for memory segregation'),
    async: z.boolean().optional().default(false).describe(
      'If true, delegate in background and return immediately. Use for long-running tasks like builds, tests, deploys, scrapers, or design work. ' +
      'The result will be delivered automatically on the next user interaction. ' +
      'Supported for all agents except n8nMcpEngineer and deliberationAgent. ' +
      'Note: when the current turn has too little time left for a sync delegation, the system auto-switches to async on its own.',
    ),
    callerThreadId: z.string().optional().describe(
      'Optional threadId for delivering async results. If omitted, the runtime binds the current conversation thread automatically from execution context.',
    ),
    callerAgentId: z.enum(DELEGATION_CALLER_AGENT_IDS).optional().default(META_AGENT_ID).describe(
      'Agent that should receive async pending results. Use automationArchitect when the architect delegates subtasks.',
    ),
    originAgentId: z.string().optional().describe('Original agent that initiated the delegation chain.'),
    originThreadId: z.string().optional().describe('Original thread that initiated the delegation chain.'),
    returnToAgentId: z.enum(DELEGATION_RETURN_AGENT_IDS).optional().describe(
      'Agent that should receive async results. Defaults to callerAgentId.',
    ),
    returnToThreadId: z.string().optional().describe('Thread that should receive async results. Defaults to callerThreadId.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.string(),
    agentUsed: z.string(),
    error: z.string().optional(),
    goalContractId: z.string().optional(),
    envelope: z.object({
      status: z.enum(['ok', 'partial', 'failed', 'blocked_needs_approval']),
      artifacts: z.array(z.object({
        id: z.string(), type: z.string(), summary: z.string().optional(), content: z.string().optional(),
      })),
      lessons: z.array(z.string()),
      followup: z.string().optional(),
      parsed: z.boolean().describe('true = expert returned a structured envelope; false = prose fallback'),
    }).optional().describe('Etap 3: structured result contract. Read status + artifacts from here; partial/failed → retry loop, blocked_needs_approval → ask the user.'),
    salvage: z.object({
      delegationThreadId: z.string(),
      hint: z.string(),
    }).optional().describe('P3: present on timeout — pointer to the delegation thread holding the child\'s partial work. Recover it via system_delegation_salvage instead of redoing the task.'),
  }),
  execute: withToolEnvelope({
    toolId: 'system_delegate_task',
    category: 'other',
    risk: 'medium',
    defaultAgentId: META_AGENT_ID,
    redactInputFields: ['taskDescription', 'taskSpec'],
    metadata: (input: any) => ({
      // The RESOLVED caller, not the declared one.
      //
      // `callerAgentId` defaults to META_AGENT_ID when the model omits it, and
      // `resolveDelegationCaller` (used by `execute` below) already prefers the
      // run's own identity over that default. This block did not, so execution
      // and telemetry disagreed: measured on a V2 canary, `codingAgent` delegated
      // to `researcherAgent`, the run logged
      // `caller identity taken from the run: codingAgent (the call declared
      // meta-agent)` — and `tool_executions` filed it under `meta-agent`.
      //
      // The cost is the same as Z11's: nothing fails, and every later diagnosis
      // reads a record of who did what that is wrong. It cost an investigation in
      // this very session, which briefly read the mis-attribution as the agent
      // fabricating a delegation it never made.
      agentId: resolveDelegationCaller(input.callerAgentId),
      threadId: input.threadId ?? input.callerThreadId,
    }),
    execute: wrapWithResultEnvelope(async (context: any) => {
    // ── Resolve the brief: structured taskSpec (preferred) → rendered, else taskDescription / taskBrief ──
    // Etap 3: artifact-ref inputs render as summary + id (never full content),
    // and the shared result-envelope instruction is appended to the brief.
    let taskDescription = context.taskSpec
      ? await renderWorkerBriefWithArtifacts(context.taskSpec)
      : (context.taskDescription || context.taskBrief);

    // ── Upstream Artifact Inputs (Handoff / Sequential Pipeline) ──
    if (context.inputArtifactIds && context.inputArtifactIds.length > 0) {
      try {
        const { getArtifact } = await import('../../services/artifact-store.js');
        const artifactSummaries: string[] = [];
        for (const artId of context.inputArtifactIds) {
          const art = await getArtifact(artId, { includeContent: false });
          if (art) {
            artifactSummaries.push(`- **Artifact ID \`${art.id}\`** (${art.type}, ${art.bytes ?? 0} bytes): ${art.summary || art.title || 'No summary'} (use \`artifact_get\` to fetch full content if needed)`);
          }
        }
        if (artifactSummaries.length > 0) {
          const artHeader = `## Upstream Input Artifacts (Handoff / Pipelining):\n${artifactSummaries.join('\n')}\n\n`;
          taskDescription = taskDescription ? artHeader + taskDescription : artHeader;
        }
      } catch (err) {
        console.warn('[delegate-task] Failed to load upstream artifact summaries:', err);
      }
    }

    // ── Skill SOP Injection ──
    if (context.skills && context.skills.length > 0) {
      try {
        const { getSkillRegistry } = await import('../../services/skill-registry.js');
        const registry = getSkillRegistry();
        const skillSections: string[] = [];
        for (const skillName of context.skills) {
          const skill = await registry.load(skillName);
          if (skill) {
            skillSections.push(
              `\n---\n## Standard Operating Procedure (SOP): ${skill.metadata.name}\n` +
              `> ${skill.metadata.description}\n\n` +
              skill.procedure,
            );
          } else {
            console.warn(`[delegate-task] Skill not found: ${skillName}`);
          }
        }
        if (skillSections.length > 0) {
          taskDescription = `${taskDescription || ''}\n\n${skillSections.join('\n')}`;
        }
      } catch (err) {
        console.warn('[delegate-task] Failed to load skill procedures:', err);
      }
    }
    // P4d (delegation-depth-hardening) — brief-by-artifact: long briefs travel
    // as an artifact reference instead of an inline tool argument (a huge
    // inline arg emitted at a small context budget is how the live failure
    // produced `delegateTaskTool args={}`).
    if (!taskDescription && context.taskSpecArtifactId) {
      try {
        const { getArtifact } = await import('../../services/artifact-store.js');
        const artifact = await getArtifact(context.taskSpecArtifactId, { includeContent: true });
        if (artifact?.content && artifact.content.trim().length >= 20) {
          taskDescription = artifact.content;
        } else {
          return {
            success: false,
            result: `Artifact "${context.taskSpecArtifactId}" not found or has no usable content — cannot build the brief from it.`,
            agentUsed: context.targetAgent,
            error: 'task_spec_artifact_unusable',
          };
        }
      } catch (error) {
        return {
          success: false,
          result: `Failed to load brief artifact "${context.taskSpecArtifactId}": ${(error as Error).message}`,
          agentUsed: context.targetAgent,
          error: 'task_spec_artifact_load_failed',
        };
      }
    }
    if (taskDescription && isHarnessFeatureEnabled('FEATURE_COMM_CONTRACTS', true)) {
      try {
        const envelopeInstruction = await loadPrompt('shared/result-envelope');
        taskDescription = `${taskDescription}\n\n---\n${envelopeInstruction}`;
      } catch { /* snippet missing — brief still valid */ }
    }
    if (!taskDescription) {
      return {
        success: false,
        result: 'Underspecified task: provide either taskSpec (preferred) or taskDescription.',
        agentUsed: context.targetAgent,
        error: 'underspecified_task',
      };
    }

    const agentId = AGENT_IDS[context.targetAgent as AgentKey];

    if (!agentId) {
      return {
        success: false,
        result: `Agent "${context.targetAgent}" does not exist.`,
        agentUsed: context.targetAgent,
        error: `Available agents: ${Object.keys(AGENT_IDS).join(', ')}`,
      };
    }

    const m = await getMastra();
    const agent = m.getAgent(agentId);
    if (!agent) {
      return {
        success: false,
        result: `Agent "${agentId}" not found in Mastra registry.`,
        agentUsed: context.targetAgent,
        error: `Agent registered but not resolved. Check mastra.agents config.`,
      };
    }

    let goalContract: GoalContract | null = null;
    // P3 — hoisted so the catch block can attach a salvage pointer to the
    // delegation thread when a timeout discards otherwise-recoverable work.
    const delegationThreadId = context.threadId || `delegation-${randomUUID()}`;

    try {
      const start = Date.now();
      const delegationResourceId = context.resourceId || META_AGENT_ID;
      const callerAgentId = resolveDelegationCaller(context.callerAgentId);
      const callerThread = context.callerThreadId || context.threadId || getHarnessExecutionContext()?.threadId || `meta-${randomUUID()}`;
      const returnToAgentId = canonicalizeRuntimeAgentId(context.returnToAgentId ?? callerAgentId) ?? callerAgentId;
      const returnToThreadId = context.returnToThreadId ?? callerThread;
      const originAgentId = canonicalizeRuntimeAgentId(context.originAgentId ?? callerAgentId) ?? callerAgentId;
      const originThreadId = context.originThreadId ?? returnToThreadId;

      // ONE self-delegation rule, not one per agent.
      //
      // This was six identical `if` blocks naming six agents, which is a list
      // that grows only when someone remembers — `codingAgent` was about to
      // become the seventh. An agent handing its own task back to itself is a
      // loop in every case, so the rule belongs to the relation, not to the
      // roster: canonicalized on both sides, because the caller arrives as a
      // runtime id and the target as a board id and those spellings differ.
      if (isSelfDelegation(callerAgentId, context.targetAgent)) {
        return {
          success: false,
          result: `${context.targetAgent} cannot delegate recursively to itself.`,
          agentUsed: context.targetAgent,
          error: 'recursive_delegation_blocked',
        };
      }

      if (context.targetAgent === 'n8nMcpEngineer') {
        if (callerAgentId !== AUTOMATION_ARCHITECT_AGENT_ID) {
          return {
            success: false,
            result: 'n8nMcpEngineer is an internal read-only helper available only to automationArchitect.',
            agentUsed: context.targetAgent,
            error: 'n8n_mcp_engineer_caller_not_allowed',
          };
        }
        if (context.async) {
          return {
            success: false,
            result: 'Async delegation to n8nMcpEngineer is not supported in the MVP. Use synchronous read-only discovery/validation.',
            agentUsed: context.targetAgent,
            error: 'n8n_mcp_engineer_async_not_supported',
          };
        }
      }

      goalContract = await createDelegationGoalContract({
        taskId: delegationThreadId,
        targetAgent: context.targetAgent,
        taskDescription,
        mastra: m,
      });
      await recordDelegationGoalEvidence(goalContract, {
        stepId: 'step-1',
        type: 'for',
        description: `Delegation routed to ${context.targetAgent}.`,
        stepStatus: 'done',
      });

      // ── Route codingAgent through harness for telemetry + precontext ──
      if (context.targetAgent === 'codingAgent') {
        const codingBudget = resolveDelegationBudget(CODING_AGENT_ID);
        const forcedCodingAsync = !codingBudget.viable
          && isHarnessFeatureEnabled('FEATURE_DELEGATION_BUDGET_COORDINATION', true);
        // ── Async delegation: fire-and-forget for long-running tasks ──
        if (context.async || forcedCodingAsync) {
          const callerThread = context.callerThreadId || context.threadId || `meta-${randomUUID()}`;
          const { delegationId } = await startAsyncDelegation({
            agent,
            agentId: CODING_AGENT_ID,
            prompt: taskDescription,
            taskId: delegationThreadId,
            goalContractId: goalContract?.contractId,
            callerThreadId: callerThread,
            callerAgentId,
            originAgentId,
            originThreadId,
            targetAgentId: CODING_AGENT_ID,
            targetThreadId: `async-delegation-${randomUUID()}`,
            returnToAgentId,
            returnToThreadId: returnToThreadId ?? callerThread,
            repoPath: repoPathForCodingDelegation(taskDescription),
            // ASYNC lane: the parent deliberately does NOT await this, and the
            // result returns through its own channel, so outliving the parent is
            // the intent — not the K3/K4 orphan pathology. Left uncapped on purpose.
            timeoutMs: 900_000,
          });
          await recordDelegationGoalEvidence(goalContract, {
            stepId: 'step-2',
            type: 'for',
            description: `Async delegation started: ${delegationId}.`,
            stepStatus: 'in_progress',
          });

          return {
            success: true,
            result: `Async delegation started. delegationId: ${delegationId}. ` +
              `The coding agent is working in the background. ` +
              `Results will be delivered automatically on the next user interaction.`,
            agentUsed: context.targetAgent,
            goalContractId: goalContract?.contractId,
          };
        }

        // ── Synchronous delegation (default): blocking await ──
        // K4 — this used a hardcoded 300s that bypassed budget coordination, so a
        // `fast` (60s) parent could start a child outliving it: the parent died,
        // the child kept running and mutating, and its result had nobody to
        // return to. A SYNC child must never outlive the parent awaiting it.
        const codingSyncBudget = resolveDelegationBudget(CODING_AGENT_ID);
        const harnessResult = await generateCoding({
          // F3 — aborting the parent must stop this child, not just abandon the wait.
          abortSignal: getCurrentRunAbortSignal(),
          agent,
          agentId: CODING_AGENT_ID,
          prompt: taskDescription,
          taskId: delegationThreadId,
          goalContractId: goalContract?.contractId,
          threadId: delegationThreadId,
          phase: 'chat',
          repoPath: repoPathForCodingDelegation(taskDescription),
          timeoutMs: codingSyncBudget.timeoutMs,
        });

        const responseText = harnessResult.outputPreview ?? '';
        await completeDelegationGoalSuccess(goalContract, responseText);

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: 'success',
          taskId: goalContract?.contractId,
          input: taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
          data: goalContract ? {
            goalContractId: goalContract.contractId,
            goalTaskId: goalContract.taskId,
          } : undefined,
        });

        return {
          success: true,
          result: responseText,
          agentUsed: context.targetAgent,
          goalContractId: goalContract?.contractId,
        };
      }

      // ── Route automationArchitect through harness for telemetry + memory ──
      if (context.targetAgent === 'automationArchitect') {
        // WS-B — builds (golden_path mode) may run async-by-default so meta is not
        // blocked and a long build is never reported as a false "failed". Gated by
        // FEATURE_AUTOMATION_ASYNC_DEFAULT (off by default — with WS-C the sync path
        // returns the result fast). Read-only analysis ALWAYS stays synchronous.
        // K3 — the sync path used a flat 20-minute budget that bypassed budget
        // coordination entirely: a parent capped at 300s died while the child kept
        // building for up to twenty minutes, mutating n8n and Mongo with nobody left
        // to return the result to. Capping alone would be wrong too — a golden-path
        // build genuinely needs longer than the parent's window — so the honest
        // answer is to route it to the ASYNC lane instead of starting a sync call
        // that provably cannot finish.
        const automationBudget = resolveDelegationBudget('automationArchitect');
        const automationAsync = context.async
          || (isHarnessFeatureEnabled('FEATURE_AUTOMATION_ASYNC_DEFAULT', true)
            && classifyAutomationArchitectDelegationMode(taskDescription) === 'golden_path')
          || !automationBudget.viable;
        // ── Async delegation: fire-and-forget for long-running automation builds ──
        if (automationAsync) {
          const callerThread = context.callerThreadId || context.threadId || `meta-${randomUUID()}`;
          const { delegationId } = await startAsyncDelegation({
            agent,
            agentId: AUTOMATION_ARCHITECT_AGENT_ID,
            prompt: taskDescription,
            taskId: delegationThreadId,
            goalContractId: goalContract?.contractId,
            callerThreadId: callerThread,
            callerAgentId,
            originAgentId,
            originThreadId,
            targetAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
            targetThreadId: `async-delegation-${randomUUID()}`,
            returnToAgentId,
            returnToThreadId: returnToThreadId ?? callerThread,
            timeoutMs: getAutomationDelegationTimeoutMs(),
          });
          await recordDelegationGoalEvidence(goalContract, {
            stepId: 'step-2',
            type: 'for',
            description: `Async automation delegation started: ${delegationId}.`,
            stepStatus: 'in_progress',
          });

          return {
            success: true,
            result: `Async automation delegation started. delegationId: ${delegationId}. ` +
              `The automation architect is working in the background. ` +
              `Results will be delivered automatically on the next user interaction.`,
            agentUsed: context.targetAgent,
            goalContractId: goalContract?.contractId,
          };
        }

        // ── Synchronous delegation: blocking await through harness ──
        // Reached only when the parent window is viable (see K3 note above), so the
        // child is bounded by what the awaiting parent can actually survive.
        const harnessResult = await generateAutomation({
          // F3 — see the coding sync path: the parent's abort must reach the child.
          abortSignal: getCurrentRunAbortSignal(),
          agent,
          prompt: taskDescription,
          taskId: delegationThreadId,
          goalContractId: goalContract?.contractId,
          threadId: delegationThreadId,
          phase: 'chat',
          timeoutMs: automationBudget.timeoutMs,
        });

        const responseText = harnessResult.outputPreview ?? '';
        const automationContract = evaluateAutomationArchitectDelegationContract(
          taskDescription,
          responseText,
        );
        const automationContractOk = automationContract.ok;

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: automationContractOk ? 'success' : 'error',
          taskId: goalContract?.contractId,
          input: taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
          data: goalContract ? {
            goalContractId: goalContract.contractId,
            goalTaskId: goalContract.taskId,
            delegationMode: automationContract.mode,
          } : undefined,
          ...(automationContractOk
            ? {}
            : {
                errorMessage: automationContract.failureClass ?? 'automation_contract_missing',
                metadata: {
                  contract: automationContract.mode,
                  reason: automationContract.message,
                },
              }),
        });

        if (!automationContractOk) {
          const failureClass = automationContract.failureClass ?? 'automation_contract_missing';
          await completeDelegationGoalFailure(goalContract, failureClass, responseText, {
            targetAgent: context.targetAgent,
            taskDescription,
            mastra: m,
          });
          return {
            success: false,
            result: responseText,
            agentUsed: context.targetAgent,
            error: formatAutomationDelegationContractError(automationContract),
            goalContractId: goalContract?.contractId,
          };
        }

        await completeDelegationGoalSuccess(goalContract, responseText);

        return {
          success: true,
          // When the child ran on a clock shortened by the parent, say so IN the
          // result. An architect report legitimately ends with a "next step"
          // (e.g. "run the real-credentials test"), and the caller reads that as
          // an instruction and delegates again — which is right when there is
          // budget and fatal when there is not. On 2026-08-24 meta re-delegated
          // with 341s left, the round could not finish, and the caller got HTTP
          // 504 with an empty body while the finished workflow sat in n8n
          // unmentioned. The reserve above now guarantees the parent survives to
          // answer; this line tells it to SPEND that time answering rather than
          // opening a round it cannot close.
          result: automationBudget.cappedByParent
            ? `${responseText}\n\n---\n[delegation budget] This delegation ran on a shortened clock `
              + `(${Math.round(automationBudget.timeoutMs / 1000)}s, capped by your own remaining budget). `
              + 'There is NOT enough budget left for another delegation round. Report what was achieved '
              + 'and name any remaining step as a recommendation for the user — do NOT delegate again.'
            : responseText,
          agentUsed: context.targetAgent,
          goalContractId: goalContract?.contractId,
        };
      }

      // ── Route knowledgeAgent through harness for NotebookLM precontext + memory ──
      if (context.targetAgent === 'knowledgeAgent') {
        if (context.async) {
          const callerThread = context.callerThreadId || context.threadId || `meta-${randomUUID()}`;
          const { delegationId } = await startAsyncDelegation({
            agent,
            agentId: KNOWLEDGE_AGENT_ID,
            prompt: taskDescription,
            taskId: delegationThreadId,
            goalContractId: goalContract?.contractId,
            callerThreadId: callerThread,
            callerAgentId,
            originAgentId,
            originThreadId,
            targetAgentId: KNOWLEDGE_AGENT_ID,
            targetThreadId: `async-delegation-${randomUUID()}`,
            returnToAgentId,
            returnToThreadId: returnToThreadId ?? callerThread,
            // ASYNC lane — uncapped on purpose (see the coding async note above).
            timeoutMs: 900_000,
          });
          await recordDelegationGoalEvidence(goalContract, {
            stepId: 'step-2',
            type: 'for',
            description: `Async NotebookLM delegation started: ${delegationId}.`,
            stepStatus: 'in_progress',
          });

          return {
            success: true,
            result: `Async NotebookLM delegation started. delegationId: ${delegationId}. ` +
              `The knowledge agent is working in the background. ` +
              `Results will be delivered automatically on the next user interaction.`,
            agentUsed: context.targetAgent,
            goalContractId: goalContract?.contractId,
          };
        }

        // K4 — same hardcoded-budget bypass as the coding sync path above.
        const knowledgeSyncBudget = resolveDelegationBudget(KNOWLEDGE_AGENT_ID);
        const harnessResult = await generateKnowledge({
          // F3 — see the coding sync path: the parent's abort must reach the child.
          abortSignal: getCurrentRunAbortSignal(),
          agent,
          prompt: taskDescription,
          taskId: delegationThreadId,
          goalContractId: goalContract?.contractId,
          threadId: delegationThreadId,
          phase: 'chat',
          timeoutMs: knowledgeSyncBudget.timeoutMs,
        });

        const responseText = harnessResult.outputPreview ?? '';
        await completeDelegationGoalSuccess(goalContract, responseText);

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: 'success',
          taskId: goalContract?.contractId,
          input: taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
          data: goalContract ? {
            goalContractId: goalContract.contractId,
            goalTaskId: goalContract.taskId,
          } : undefined,
        });

        return {
          success: true,
          result: responseText,
          agentUsed: context.targetAgent,
          goalContractId: goalContract?.contractId,
        };
      }

      // ── Route deliberationAgent: direct generate (no harness needed) ──
      if (context.targetAgent === 'n8nMcpEngineer') {
        const response = await generateWithAbortableTimeout(
          agent,
          taskDescription,
          {
            maxSteps: getN8nMcpEngineerDelegationMaxSteps(),
            memory: {
              thread: delegationThreadId,
              resource: delegationResourceId,
            },
          },
          context.targetAgent,
          // P2 — sync-only helper: cap to the parent's remaining budget so a
          // timeout fires while the parent is still alive to handle it.
          resolveDelegationBudget(context.targetAgent).timeoutMs,
        );

        const responseText = response.text ?? '';
        const calledTools = extractCalledToolNames(response);
        const contract = evaluateN8nMcpEngineerDelegationContract(responseText, calledTools);
        const ok = contract.ok;
        if (!ok) {
          // Say WHY, from the response itself.
          //
          // A rejected handoff makes the architect abandon the whole build, and
          // `no_real_tool_use` has two indistinguishable causes from outside: the
          // engineer really called nothing, or it called tools this extraction
          // cannot see. Reading a fact about a run off an object the framework
          // may reshape is how `findArtifactIds` failed twice for two unrelated
          // reasons, so this path states its own evidence rather than leaving the
          // next person to guess between them.
          console.warn(
            `[n8n-mcp-handoff] REJECTED ${contract.error} — ${describeDelegationToolUse(response)}`,
          );
        }

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: ok ? 'success' : 'error',
          taskId: goalContract?.contractId,
          input: taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
          data: goalContract ? {
            goalContractId: goalContract.contractId,
            goalTaskId: goalContract.taskId,
            contract: 'n8n_mcp_handoff',
            n8nMcpToolsCalled: calledTools,
          } : { contract: 'n8n_mcp_handoff', n8nMcpToolsCalled: calledTools },
          ...(ok
            ? {}
            : {
                errorMessage: contract.error,
                metadata: {
                  reason: contract.message,
                },
              }),
        });

        if (!ok) {
          // WS-G — a failed (mandatory) MCP handoff marks this architect run so the
          // Golden Path deploy refuses until a successful handoff clears it.
          markMcpHandoffFailed();
          await completeDelegationGoalFailure(goalContract, contract.error, responseText, {
            targetAgent: context.targetAgent,
            taskDescription,
            mastra: m,
          });
          return {
            success: false,
            result: responseText,
            agentUsed: context.targetAgent,
            error: `${contract.error}: ${contract.message}`,
            goalContractId: goalContract?.contractId,
          };
        }

        // WS-G — a real, validated handoff clears any prior MCP-failure flag for
        // this run so the architect can proceed to deploy.
        clearMcpHandoffFailed();
        // WS-J — record the successful, real (WS-F verified) MCP handoff so the
        // Golden Path node-validation gate lets non-core nodes through.
        markMcpHandoffSucceeded();
        await completeDelegationGoalSuccess(goalContract, responseText);

        return {
          success: true,
          result: responseText,
          agentUsed: context.targetAgent,
          goalContractId: goalContract?.contractId,
        };
      }

      // ── Route deliberationAgent: direct generate (no harness needed) ──
      if (context.targetAgent === 'deliberationAgent') {
        const response = await generateWithAbortableTimeout(
          agent,
          taskDescription,
          {
            // deliberationAgent has its own debate tools and is not a harness flow
            memory: {
              thread: delegationThreadId,
              resource: delegationResourceId,
            },
          },
          context.targetAgent,
          // P2 — sync-only path: cap to the parent's remaining budget.
          resolveDelegationBudget(context.targetAgent).timeoutMs,
        );

        const responseText = response.text ?? '';
        await completeDelegationGoalSuccess(goalContract, responseText);

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: 'success',
          taskId: goalContract?.contractId,
          input: taskDescription.slice(0, 500),
          output: responseText.slice(0, 500),
          durationMs: Date.now() - start,
          data: goalContract ? {
            goalContractId: goalContract.contractId,
            goalTaskId: goalContract.taskId,
          } : undefined,
        });

        return {
          success: true,
          result: responseText,
          agentUsed: context.targetAgent,
          goalContractId: goalContract?.contractId,
        };
      }

      // ── P2: budget coordination for the sync-only delegation paths below ──
      // (harness-routed coding/automation/knowledge agents above manage their
      // own budgets and async modes — unchanged.)
      const delegationBudget = resolveDelegationBudget(context.targetAgent);
      const supportsGenericAsync =
        context.targetAgent !== 'n8nMcpEngineer' && context.targetAgent !== 'deliberationAgent';
      const wantsAsync = Boolean(context.async) && supportsGenericAsync;
      // Auto-switch: when the parent's remaining budget cannot fit a sync
      // child (the live Finnsson failure: fast parent 60s vs child 240s),
      // a sync call is mathematically doomed — route it to the async path,
      // where the child gets its full static budget and the result comes
      // back as a pending update on the next turn.
      const forcedAsync = !delegationBudget.viable && supportsGenericAsync
        && isHarnessFeatureEnabled('FEATURE_DELEGATION_BUDGET_COORDINATION', true);

      if (wantsAsync || forcedAsync) {
        const callerThread = context.callerThreadId || context.threadId || `meta-${randomUUID()}`;
        const { delegationId } = await startAsyncDelegation({
          agent,
          agentId,
          prompt: taskDescription,
          taskId: delegationThreadId,
          goalContractId: goalContract?.contractId,
          callerThreadId: callerThread,
          callerAgentId,
          originAgentId,
          originThreadId,
          targetAgentId: agentId,
          targetThreadId: `async-delegation-${randomUUID()}`,
          returnToAgentId,
          returnToThreadId: returnToThreadId ?? callerThread,
          // async child is no longer bound by the parent — full static budget
          timeoutMs: getDelegationTimeoutMsFor(context.targetAgent),
        });
        await recordDelegationGoalEvidence(goalContract, {
          stepId: 'step-2',
          type: 'for',
          description: `Async delegation started: ${delegationId}${forcedAsync ? ' (auto: sync budget insufficient)' : ''}.`,
          stepStatus: 'in_progress',
        });

        const reason = forcedAsync
          ? `Sync budget insufficient (${Math.round((delegationBudget.remainingParentMs ?? 0) / 1000)}s left in this turn) — delegation auto-routed to ASYNC. `
          : '';
        return {
          success: true,
          result: `${reason}Async delegation started. delegationId: ${delegationId}. ` +
            `${context.targetAgent} is working in the background. ` +
            `The result will be delivered automatically as a pending update on the next user interaction.`,
          agentUsed: context.targetAgent,
          goalContractId: goalContract?.contractId,
        };
      }

      // ── Route pipeline agents through the lightweight pipeline wrapper ──
      // Reflektor Part 3 §3.2: in-flight reflection + per-phase tool channeling
      // around the agent's own 150-step `defaultOptions` — NO full harness.
      if (
        isPipelineAgent(context.targetAgent) &&
        isHarnessFeatureEnabled('FEATURE_PIPELINE_REFLECTOR', true)
      ) {
        const pipelineResult = await withDelegationTimeout(
          (signal) => generatePipelineWithReflection({
            agent,
            agentKey: context.targetAgent,
            agentId: agentId,
            prompt: taskDescription,
            threadId: delegationThreadId,
            resourceId: delegationResourceId,
            taskId: goalContract?.contractId,
            goalContractId: goalContract?.contractId,
            // CAN-002 — a timed-out or cancelled pipeline now actually stops.
            abortSignal: signal,
          }),
          context.targetAgent,
          delegationBudget.timeoutMs,
        );

        const pipelineText = pipelineResult.text;
        await completeDelegationGoalSuccess(goalContract, pipelineText);

        logAgentEvent({
          type: 'delegation',
          agentId: context.targetAgent,
          status: 'success',
          taskId: goalContract?.contractId,
          input: taskDescription.slice(0, 500),
          output: pipelineText.slice(0, 500),
          durationMs: Date.now() - start,
          data: goalContract ? {
            goalContractId: goalContract.contractId,
            goalTaskId: goalContract.taskId,
            pipelineRunId: pipelineResult.runId,
          } : undefined,
        });

        return {
          success: true,
          result: pipelineText,
          agentUsed: context.targetAgent,
          goalContractId: goalContract?.contractId,
        };
      }

      // ── All other agents: direct generate ──
      const response = await generateWithAbortableTimeout(
        agent,
        taskDescription,
        {
          // non-coding/non-automation agents don't use the harness
          memory: {
            thread: delegationThreadId,
            resource: delegationResourceId,
          },
        },
        context.targetAgent,
        // P2 — capped to the parent's remaining budget (viability already
        // gated above: a too-small window was auto-routed to async).
        delegationBudget.timeoutMs,
      );

      const responseText = response.text ?? '';
      await completeDelegationGoalSuccess(goalContract, responseText);

      logAgentEvent({
        type: 'delegation',
        agentId: context.targetAgent,
        status: 'success',
        taskId: goalContract?.contractId,
        input: taskDescription.slice(0, 500),
        output: responseText.slice(0, 500),
        durationMs: Date.now() - start,
        data: goalContract ? {
          goalContractId: goalContract.contractId,
          goalTaskId: goalContract.taskId,
        } : undefined,
      });

      return {
        success: true,
        result: responseText,
        agentUsed: context.targetAgent,
        goalContractId: goalContract?.contractId,
      };
    } catch (error) {
      await completeDelegationGoalFailure(goalContract, (error as Error).message, undefined, {
        targetAgent: context.targetAgent,
        taskDescription,
        mastra: m,
      });

      // P3 (delegation-depth-hardening) — a timed-out child usually left real
      // work behind in its delegation thread (the live case: ~226s of scraping
      // discarded seconds before artifact_put). Attach a salvage pointer so
      // the caller can recover it via system_delegation_salvage instead of
      // redoing the work from scratch.
      const isTimeout = /timed out/i.test((error as Error).message);
      const salvage = isTimeout && isHarnessFeatureEnabled('FEATURE_DELEGATION_TIMEOUT_SALVAGE', true)
        ? {
            delegationThreadId,
            hint: `Partial work from ${context.targetAgent} may be recoverable. ` +
              `Call system_delegation_salvage with threadId "${delegationThreadId}" to get a digest of its tool results ` +
              `— then compile the result yourself or re-delegate WITH the digest as context (do not redo the work).`,
          }
        : undefined;

      logAgentEvent({
        type: 'delegation',
        agentId: context.targetAgent,
        status: 'error',
        taskId: goalContract?.contractId,
        input: taskDescription.slice(0, 500),
        errorMessage: (error as Error).message,
        data: goalContract ? {
          goalContractId: goalContract.contractId,
          goalTaskId: goalContract.taskId,
          ...(salvage ? { salvageThreadId: salvage.delegationThreadId } : {}),
        } : (salvage ? { salvageThreadId: salvage.delegationThreadId } : undefined),
      });

      return {
        success: false,
        result: `Sub-agent reported an error: ${(error as Error).message}` +
          (salvage ? `\n\nSALVAGE: ${salvage.hint}` : ''),
        agentUsed: context.targetAgent,
        error: (error as Error).message,
        goalContractId: goalContract?.contractId,
        ...(salvage ? { salvage } : {}),
      };
    }
    }),
  }),
});

/**
 * Etap 3 (communication contracts): parse every delegation reply into a
 * ResultEnvelope. Prose replies fall back to { status: ok, artifacts: [], raw }
 * so legacy agents keep working; a parsed 'failed'/'blocked_needs_approval'
 * status downgrades success so meta's retry/approval loops fire on structured
 * signals, not string matching.
 */
function wrapWithResultEnvelope(
  core: (context: any) => Promise<any>,
): (context: any) => Promise<any> {
  return async (context: any) => {
    const out = await core(context);
    if (!isHarnessFeatureEnabled('FEATURE_COMM_CONTRACTS', true)) return out;
    if (!out || typeof out.result !== 'string' || out.result.length === 0) return out;
    try {
      const envelope = parseResultEnvelope(out.result);
      const success = out.success === true
        && envelope.status !== 'failed'
        && envelope.status !== 'blocked_needs_approval';

      // Etap 6: a successful delegation that taught a lesson is a skill
      // distillation candidate. The trigger predicate (≥5 tool calls / recovery
      // / correction) is re-checked inside recordDistillationCandidate; here we
      // supply the lessons + goal. Fire-and-forget, never blocks the reply.
      if (success && envelope.lessons.length > 0) {
        void recordDistillationCandidate({
          taskId: out.goalContractId,
          agentId: context.targetAgent,
          goal: context.taskSpec?.goal ?? String(context.taskDescription ?? '').slice(0, 500),
          lessons: envelope.lessons,
          resultSummary: envelope.raw?.slice(0, 2000),
          // A delegation reaching a usable envelope with lessons is treated as a
          // recovery-grade signal even without an explicit tool-call count here.
          recovered: true,
        }).catch(() => undefined);
      }

      return {
        ...out,
        success,
        envelope: {
          status: envelope.status,
          artifacts: envelope.artifacts,
          lessons: envelope.lessons,
          followup: envelope.followup,
          parsed: envelope.parsed,
        },
        ...(success !== out.success
          ? { error: out.error ?? `envelope status: ${envelope.status}` }
          : {}),
      };
    } catch {
      return out;
    }
  };
}

export function evaluateAutomationArchitectDelegationContract(
  taskDescription: string,
  responseText: string,
): AutomationDelegationContractResult {
  const mode = classifyAutomationArchitectDelegationMode(taskDescription);
  if (mode === 'read_only_analysis') {
    if (isUsableReadOnlyAutomationResponse(responseText)) {
      return { ok: true, mode };
    }
    return {
      ok: false,
      mode,
      failureClass: 'automation_read_only_response_incomplete',
      message: 'automationArchitect read-only analysis must return a non-empty usable report.',
    };
  }

  if (isAutomationArchitectContractComplete(responseText)) {
    return { ok: true, mode };
  }

  return {
    ok: false,
    mode,
    failureClass: 'automation_contract_missing',
    message: 'automationArchitect must return a terminal Golden Path status and automationId/workflowId when deploy/test succeeds.',
  };
}

export function classifyAutomationArchitectDelegationMode(taskDescription: string): AutomationDelegationMode {
  const lower = taskDescription.toLowerCase();
  const explicitReadOnly = /\b(read[-\s]?only|dry[-\s]?run|analysis only|only analysis|audit only|review only|report only|no active deployment|do not deploy|do not activate|do not update|do not create|do not delete|do not mutate|no deploy|no activation|no mutation|bez deploy|bez wdro|nie wdra|nie aktyw|nie zmien|nie usuw|tylko analiz|wylacznie analiz|wyłącznie analiz|bez zmian)\b/i.test(lower);
  if (explicitReadOnly) return 'read_only_analysis';

  const analysisIntent = /\b(audit|analysis|analyze|analyse|assess|risk|review|validate|validation|status|check|report|describe|explain|ocen|audyt|analiz|sprawdz|sprawd|raport|walidac|ryzyk)\b/i.test(lower);
  const mutatingIntent = /\b(deploy|activate|activation|create|update|delete|implement|build|test workflow|run workflow|start automation|workflow_json|wdroz|wdroż|aktyw|utworz|utwórz|stworz|stwórz|zaktualizuj|usun|usuń|uruchom)\b/i.test(lower);

  if (analysisIntent && !mutatingIntent) return 'read_only_analysis';
  return 'golden_path';
}

export function isAutomationArchitectContractComplete(text: string): boolean {
  const lower = text.toLowerCase();
  const hasTerminalStatus = /\b(blocked|draft_created|tested|active|manual_review_required)\b/i.test(text);
  if (!hasTerminalStatus) return false;

  const blocked = /\b(blocked|manual_review_required)\b/i.test(text);
  if (blocked) return true;

  return lower.includes('automationid') && lower.includes('workflowid');
}

function isUsableReadOnlyAutomationResponse(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 40) return false;
  if (/^(?:\[undefined\]\s*""\s*)+$/i.test(normalized)) return false;
  if (/^(?:undefined|null|n\/a)$/i.test(normalized)) return false;
  return !claimsCompletedReadOnlyMutation(normalized);
}

function claimsCompletedReadOnlyMutation(text: string): boolean {
  return /\b(i have|i've|we have|completed|done|wykonalem|wykonałem|utworzylem|utworzyłem|wdrozylem|wdrożyłem|aktywowalem|aktywowałem|zaktualizowalem|zaktualizowałem|usunalem|usunąłem)\b.{0,140}\b(deploy|deployed|activated|created|updated|deleted|wdro|aktyw|utworz|utwórz|zaktualiz|usun|usuń)\b/i.test(text);
}

function formatAutomationDelegationContractError(result: AutomationDelegationContractResult): string {
  if (result.failureClass === 'automation_read_only_response_incomplete') {
    return 'automation_read_only_response_incomplete: automationArchitect read-only analysis must return a non-empty usable report without claiming mutation.';
  }
  return 'automation_contract_missing: automationArchitect must return a terminal status and automationId/workflowId when deploy/test succeeds.';
}

// WS-F — the real n8n MCP discovery/validation tools the engineer must actually
// CALL (not merely mention) for a handoff to be trustworthy.
const N8N_MCP_REAL_TOOLS = /^(tools_documentation|search_nodes|get_node|search_templates|get_template|validate_node|validate_workflow)$/;

function n8nMcpFeatureEnabled(): boolean {
  return process.env.FEATURE_N8N_MCP === 'true' || process.env.N8N_MCP_ENABLED === 'true';
}

function evaluateN8nMcpEngineerDelegationContract(responseText: string, calledToolNames: string[] = []): {
  ok: boolean;
  error: 'n8n_mcp_handoff_empty' | 'n8n_mcp_handoff_mutation_claim' | 'n8n_mcp_handoff_missing_evidence' | 'n8n_mcp_handoff_no_real_tool_use';
  message: string;
} {
  const normalized = responseText.replace(/\s+/g, ' ').trim();

  if (normalized.length < 80 || /^(?:undefined|null|n\/a)$/i.test(normalized)) {
    return {
      ok: false,
      error: 'n8n_mcp_handoff_empty',
      message: 'n8nMcpEngineer returned an empty or unusably short handoff.',
    };
  }

  if (claimsCompletedReadOnlyMutation(normalized)) {
    return {
      ok: false,
      error: 'n8n_mcp_handoff_mutation_claim',
      message: 'n8nMcpEngineer must not claim deploy/update/activation/deletion or other n8n mutation.',
    };
  }

  // WS-F — when n8n MCP is enabled, the engineer MUST have actually invoked a real
  // n8n MCP tool. A handoff with zero real tool calls is fabricated from model
  // knowledge (the failure mode that shipped a stale googleSheets typeVersion);
  // the text-keyword check below is not enough to catch it. Reject loudly so the
  // architect treats it as a failed MCP handoff, not a validated one.
  if (n8nMcpFeatureEnabled() && !calledToolNames.some((name) => N8N_MCP_REAL_TOOLS.test(name))) {
    return {
      ok: false,
      error: 'n8n_mcp_handoff_no_real_tool_use',
      message: 'n8nMcpEngineer produced a handoff WITHOUT calling any real n8n MCP tool '
        + '(search_nodes/get_node/validate_node/validate_workflow/search_templates/get_template). '
        + 'Treat node types and typeVersions as UNVALIDATED. Likely cause: n8n MCP tools failed to load.',
    };
  }

  if (!hasN8nMcpHandoffEvidence(normalized)) {
    return {
      ok: false,
      error: 'n8n_mcp_handoff_missing_evidence',
      message: 'n8nMcpEngineer handoff must mention node/template discovery, typeVersions, validation findings, or readyForGoldenPath.',
    };
  }

  return {
    ok: true,
    error: 'n8n_mcp_handoff_missing_evidence',
    message: 'n8n MCP handoff is usable.',
  };
}

function hasN8nMcpHandoffEvidence(text: string): boolean {
  return /\b(search_nodes|get_node|search_templates|get_template|validate_node|validate_workflow|typeversion|node plan|template candidates|validation findings|required credentials|readyforgoldenpath|ready for golden path)\b/i.test(text);
}

/**
 * WS-F — extract the tool names the agent ACTUALLY called from a generate()
 * response, across the shapes Mastra/AI-SDK may use (aggregated toolCalls,
 * per-step toolCalls, and `tool-call` content parts in step/response messages).
 */
/**
 * What the response looks like where tool calls SHOULD be — for the failure path.
 *
 * `extractCalledToolNames` reads four places (top-level `toolCalls`, per-step
 * `toolCalls`, `content` parts of type `tool-call`, and the messages inside each
 * step's response). When it finds nothing, the interesting question is which of
 * those four were present and empty versus absent entirely: the first says the
 * engineer called nothing, the second says this extraction is looking in the
 * wrong place for the shape this framework version emits.
 */
function describeDelegationToolUse(response: any): string {
  const steps = Array.isArray(response?.steps) ? response.steps : null;
  const parts = [
    `text=${typeof response?.text === 'string' ? `${response.text.length}ch` : 'absent'}`,
    `finishReason=${response?.finishReason ?? 'absent'}`,
    `toolCalls=${Array.isArray(response?.toolCalls) ? response.toolCalls.length : 'absent'}`,
    `steps=${steps ? steps.length : 'absent'}`,
  ];
  if (steps) {
    parts.push(`stepShapes=[${steps.map((s: any) => {
      const tc = Array.isArray(s?.toolCalls) ? `tc:${s.toolCalls.length}` : 'tc:absent';
      const content = Array.isArray(s?.content)
        ? `content:${s.content.map((c: any) => c?.type ?? '?').join('/') || 'empty'}`
        : 'content:absent';
      const msgs = Array.isArray(s?.response?.messages) ? `msgs:${s.response.messages.length}` : 'msgs:absent';
      return `{${tc},${content},${msgs}}`;
    }).join(',')}]`);
  }
  parts.push(`responseKeys=${Object.keys(response ?? {}).slice(0, 14).join('|')}`);
  return parts.join(' ');
}

function extractCalledToolNames(response: any): string[] {
  const names = new Set<string>();
  const add = (n: unknown) => { if (typeof n === 'string' && n) names.add(n); };
  const fromCalls = (calls: any) => {
    if (Array.isArray(calls)) for (const c of calls) { add(c?.toolName); add(c?.name); }
  };
  const fromContent = (content: any) => {
    if (Array.isArray(content)) for (const part of content) {
      if (part?.type === 'tool-call') { add(part?.toolName); add(part?.name); }
    }
  };

  fromCalls(response?.toolCalls);
  const steps = Array.isArray(response?.steps) ? response.steps : [];
  for (const step of steps) {
    fromCalls(step?.toolCalls);
    fromContent(step?.content);
    const msgs = Array.isArray(step?.response?.messages) ? step.response.messages : [];
    for (const m of msgs) fromContent(m?.content);
  }
  return [...names];
}

async function createDelegationGoalContract(input: {
  taskId: string;
  targetAgent: string;
  taskDescription: string;
  mastra?: unknown;
}): Promise<GoalContract | null> {
  try {
    // WS2 — prefer an LLM-authored plan (explicit assumptions + per-step
    // successCheck) when FEATURE_DELEGATION_LLM_PLAN is on. The static plan is
    // the fallback so a planner failure never blocks delegation.
    let plannedSteps = buildDelegationPlan(input.targetAgent);
    let assumptions: string[] | undefined;

    if (shouldUseDelegationLlmPlan(input.targetAgent)) {
      const plan = await tryGenerateDelegationPlan(input);
      if (plan) {
        plannedSteps = planToDelegationSteps(plan, input.targetAgent);
        assumptions = plan.assumptions;
      }
    }

    return await createGoalContract({
      taskId: input.taskId,
      agentId: input.targetAgent,
      originalGoal: input.taskDescription,
      plannedSteps,
      assumptions,
      successCriteria: buildDelegationSuccessCriteria(input.targetAgent, input.taskDescription),
    });
  } catch (error) {
    console.warn('[DelegateTask] GoalContract creation failed:', (error as Error).message);
    return null;
  }
}

/**
 * WS2 — generate an LLM plan for a delegation, swallowing any planner error so
 * delegation always proceeds (caller falls back to the static plan).
 */
async function tryGenerateDelegationPlan(input: {
  targetAgent: string;
  taskDescription: string;
  mastra?: unknown;
}): Promise<Plan | null> {
  try {
    return await generatePlan({
      goal: input.taskDescription,
      context: `Delegated to expert agent "${input.targetAgent}". Plan the steps that agent should take.`,
      availableTools: [input.targetAgent],
      mastra: input.mastra,
    });
  } catch (error) {
    console.warn('[DelegateTask] LLM plan generation failed, using static plan:', (error as Error).message);
    return null;
  }
}

function planToDelegationSteps(plan: Plan, targetAgent: string): Array<{ description: string; targetAgent: string }> {
  return plan.steps.map((s) => ({
    description: `${s.intent} — success: ${s.successCheck}`,
    targetAgent: s.toolOrAgent ?? targetAgent,
  }));
}

/**
 * WS2 — replan a delegation contract when the attempt failed (an assumption the
 * plan relied on — "agent X can complete this as planned" — was contradicted).
 * Regenerates the remaining plan and records a measurable revision + against-
 * evidence on the GoalContract. No-op unless the LLM-plan flag is on.
 */
async function replanDelegationContract(
  contract: GoalContract | null,
  input: { targetAgent: string; taskDescription: string; failureReason: string; mastra?: unknown },
): Promise<void> {
  if (!contract) return;
  if (!shouldUseDelegationLlmPlan(input.targetAgent)) return;
  try {
    const plan = await generatePlan({
      goal: input.taskDescription,
      context:
        `Previous attempt by "${input.targetAgent}" failed: ${truncate(input.failureReason, 400)}. ` +
        'Replan the remaining work, revising any assumptions the failure contradicted.',
      availableTools: [input.targetAgent],
      mastra: input.mastra,
    });
    await recordPlanRevision(
      contract.contractId,
      planToDelegationSteps(plan, input.targetAgent),
      `Assumption broken — delegation to ${input.targetAgent} failed: ${truncate(input.failureReason, 160)}`,
      plan.assumptions,
    );
  } catch (error) {
    console.warn('[DelegateTask] Replan failed:', (error as Error).message);
  }
}

/**
 * Automation Architect already owns a deterministic Golden Path plan. Running
 * a separate planner before it adds latency without improving execution, and
 * replanning after an automation failure repeats the same cost.
 */
export function shouldUseDelegationLlmPlan(targetAgent: string): boolean {
  return targetAgent !== AUTOMATION_ARCHITECT_AGENT_ID
    && isHarnessFeatureEnabled('FEATURE_DELEGATION_LLM_PLAN');
}

async function recordDelegationGoalEvidence(
  contract: GoalContract | null,
  evidence: {
    stepId: string;
    type: 'for' | 'against';
    description: string;
    stepStatus: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  },
): Promise<void> {
  if (!contract) return;
  try {
    await recordEvidence(contract.contractId, evidence);
  } catch (error) {
    console.warn('[DelegateTask] GoalContract evidence update failed:', (error as Error).message);
  }
}

async function completeDelegationGoalSuccess(
  contract: GoalContract | null,
  responseText: string,
): Promise<void> {
  if (!contract) return;
  const summary = summarizeDelegationResult(responseText);
  await recordDelegationGoalEvidence(contract, {
    stepId: 'step-2',
    type: 'for',
    description: summary,
    stepStatus: 'done',
  });
  await recordDelegationGoalEvidence(contract, {
    stepId: 'step-3',
    type: 'for',
    description: 'Delegated agent returned a result to the caller.',
    stepStatus: 'done',
  });
  try {
    await completeGoalContract(contract.contractId, 'completed', summary);
    await evaluateCompletion(contract.contractId);
  } catch (error) {
    console.warn('[DelegateTask] GoalContract completion failed:', (error as Error).message);
  }
}

async function completeDelegationGoalFailure(
  contract: GoalContract | null,
  errorMessage: string,
  responseText?: string,
  /** WS2 — when present (and the LLM-plan flag is on), record a plan revision before failing. */
  replanContext?: { targetAgent: string; taskDescription: string; mastra?: unknown },
): Promise<void> {
  if (!contract) return;
  const evidence = summarizeDelegationResult(responseText || errorMessage);
  await recordDelegationGoalEvidence(contract, {
    stepId: 'step-2',
    type: 'against',
    description: evidence,
    stepStatus: 'failed',
  });
  await recordDelegationGoalEvidence(contract, {
    stepId: 'step-3',
    type: 'against',
    description: `Delegation failed before producing an acceptable result: ${errorMessage}`,
    stepStatus: 'failed',
  });
  // WS2 — the failure contradicts the plan's assumption that this agent could
  // complete the task as planned. Record a measurable plan revision so the
  // broken assumption + revised approach are observable on the GoalContract.
  if (replanContext) {
    await replanDelegationContract(contract, {
      targetAgent: replanContext.targetAgent,
      taskDescription: replanContext.taskDescription,
      failureReason: errorMessage,
      mastra: replanContext.mastra,
    });
  }
  try {
    await completeGoalContract(contract.contractId, 'failed', errorMessage);
    await evaluateCompletion(contract.contractId);
  } catch (error) {
    console.warn('[DelegateTask] GoalContract failure completion failed:', (error as Error).message);
  }
}

function buildDelegationPlan(targetAgent: string): Array<{ description: string; targetAgent: string }> {
  return [
    {
      description: 'Receive and interpret the delegated task brief, including output format and constraints.',
      targetAgent,
    },
    {
      description: 'Execute the delegated analysis or work using the target agent domain tools and memory.',
      targetAgent,
    },
    {
      description: 'Return a result that satisfies the requested output contract and can be used by the caller.',
      targetAgent,
    },
  ];
}

function getDirectDelegationTimeoutMs(): number {
  const raw = Number(process.env.DELEGATION_DIRECT_TIMEOUT_MS ?? DEFAULT_DIRECT_DELEGATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DIRECT_DELEGATION_TIMEOUT_MS;
}

function getFilmmakerDelegationTimeoutMs(): number {
  const raw = Number(process.env.DELEGATION_FILMMAKER_TIMEOUT_MS ?? DEFAULT_FILMMAKER_DELEGATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FILMMAKER_DELEGATION_TIMEOUT_MS;
}

// WS-D — env-overridable budget for automationArchitect builds (sync + async).
function getAutomationDelegationTimeoutMs(): number {
  const raw = Number(process.env.DELEGATION_AUTOMATION_TIMEOUT_MS ?? DEFAULT_AUTOMATION_DELEGATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTOMATION_DELEGATION_TIMEOUT_MS;
}

function getDelegationTimeoutMsFor(targetAgent: string): number {
  // Filmmaker and musician both run the reflection pipeline plus remote paid
  // generation (submit + poll/sync + download), which exceeds the generic budget.
  return targetAgent === 'filmmakerAgent' || targetAgent === 'musicianAgent'
    ? getFilmmakerDelegationTimeoutMs()
    : getDirectDelegationTimeoutMs();
}

const FAST_DELEGATION_AGENTS = new Set([
  'crmAgent',
  'crm-agent',
  'knowledgeAgent',
  'weatherAgent',
]);

const FAST_DELEGATION_SYNC_SAFETY_MARGIN_MS = 10_000;
const FAST_DELEGATION_MIN_VIABLE_SYNC_MS = 5_000;

function getDelegationSyncSafetyMarginMs(targetAgent?: string): number {
  if (targetAgent && FAST_DELEGATION_AGENTS.has(targetAgent)) {
    const rawFast = Number(process.env.DELEGATION_FAST_SYNC_SAFETY_MARGIN_MS ?? FAST_DELEGATION_SYNC_SAFETY_MARGIN_MS);
    return Number.isFinite(rawFast) && rawFast >= 0 ? rawFast : FAST_DELEGATION_SYNC_SAFETY_MARGIN_MS;
  }
  const raw = Number(process.env.DELEGATION_SYNC_SAFETY_MARGIN_MS ?? DEFAULT_DELEGATION_SYNC_SAFETY_MARGIN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DELEGATION_SYNC_SAFETY_MARGIN_MS;
}

function getDelegationMinViableSyncMs(targetAgent?: string): number {
  if (targetAgent && FAST_DELEGATION_AGENTS.has(targetAgent)) {
    const rawFast = Number(process.env.DELEGATION_FAST_MIN_VIABLE_SYNC_MS ?? FAST_DELEGATION_MIN_VIABLE_SYNC_MS);
    return Number.isFinite(rawFast) && rawFast > 0 ? rawFast : FAST_DELEGATION_MIN_VIABLE_SYNC_MS;
  }
  const raw = Number(process.env.DELEGATION_MIN_VIABLE_SYNC_MS ?? DEFAULT_DELEGATION_MIN_VIABLE_SYNC_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DELEGATION_MIN_VIABLE_SYNC_MS;
}

export type DelegationBudget = {
  /** Timeout the sync child should actually run with. */
  timeoutMs: number;
  /** True when the parent's remaining budget capped the static default. */
  cappedByParent: boolean;
  /** Parent's remaining wall-clock budget when known (harness runs only). */
  remainingParentMs?: number;
  /** False when the capped window is too small for a sync delegation to make sense. */
  viable: boolean;
};

/**
 * Resolve the effective sync timeout for a delegation: the static per-agent
 * default, capped to the parent run's remaining budget (read via the harness
 * execution context — does not rely on the model passing caller ids).
 * Outside a harness run, or with the flag off, this returns the static
 * default unchanged (zero behavior change).
 */
export function resolveDelegationBudget(targetAgent: string): DelegationBudget {
  const base = getDelegationTimeoutMsFor(targetAgent);
  if (!isHarnessFeatureEnabled('FEATURE_DELEGATION_BUDGET_COORDINATION', true)) {
    return { timeoutMs: base, cappedByParent: false, viable: true };
  }
  const remaining = getCurrentRunRemainingBudgetMs();
  if (remaining === undefined) {
    return { timeoutMs: base, cappedByParent: false, viable: true };
  }
  const safetyMargin = getDelegationSyncSafetyMarginMs(targetAgent);
  const minViable = getDelegationMinViableSyncMs(targetAgent);
  const window = Math.max(0, remaining - safetyMargin);
  const timeoutMs = Math.min(base, window);
  return {
    timeoutMs,
    cappedByParent: timeoutMs < base,
    remainingParentMs: remaining,
    viable: timeoutMs >= minViable,
  };
}

function getN8nMcpEngineerDelegationMaxSteps(): number {
  const raw = Number(process.env.N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS ?? DEFAULT_N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS);
  return Number.isFinite(raw) && raw > 0
    ? Math.max(1, Math.min(24, Math.floor(raw)))
    : DEFAULT_N8N_MCP_ENGINEER_DELEGATION_MAX_STEPS;
}

/**
 * CAN-002 — bound a delegation that owns its own cancellation.
 *
 * This used to be a bare `Promise.race`: on timeout it rejected the CALLER's
 * wait while the delegated work kept running, kept calling tools and kept
 * mutating state — the pipeline profile had no other bound, so a timed-out chef
 * or filmmaker run simply carried on unobserved.
 *
 * `onAbort` now receives a signal composed from this timeout AND the parent run,
 * so the callee can stop for real. Callers that cannot accept a signal keep the
 * old reject-only behaviour, which is still strictly better than nothing.
 */
async function withDelegationTimeout<T>(
  makePromise: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  targetAgent: string,
  timeoutMsOverride?: number,
): Promise<T> {
  const timeoutMs = timeoutMsOverride ?? getDelegationTimeoutMsFor(targetAgent);
  const controller = new AbortController();
  const parentSignal = getCurrentRunAbortSignal();
  const signal = parentSignal
    ? AbortSignal.any([controller.signal, parentSignal])
    : controller.signal;
  const promise = typeof makePromise === 'function' ? makePromise(signal) : makePromise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          try {
            // Stop the WORK, not just the wait.
            controller.abort(new Error('delegation_timeout'));
          } catch {
            // best-effort abort; never mask the timeout rejection
          }
          reject(new Error(`Delegation to ${targetAgent} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * WS-A — run a direct `agent.generate` under an abortable timeout. Like the
 * harness fix, the timeout ABORTS the underlying generation instead of only
 * losing a `Promise.race`, so a timed-out delegation cannot leave an orphaned
 * ("zombie") run that keeps burning compute and mutating state. Use this for the
 * non-harness direct-generate delegation paths.
 */
async function generateWithAbortableTimeout(
  agent: any,
  prompt: string,
  options: Record<string, any>,
  targetAgent: string,
  timeoutMsOverride?: number,
): Promise<any> {
  const timeoutMs = timeoutMsOverride ?? getDelegationTimeoutMsFor(targetAgent);
  const controller = new AbortController();
  // F3 signal composition — compose the PARENT's signal too. Previously only the
  // local timeout could abort this call, so cancelling or timing out the parent
  // abandoned the wait while the child kept running: the exact "cancel DB is not
  // an actual stop" gap G3-core names.
  const parentSignal = getCurrentRunAbortSignal();
  const externalSignals = [options.abortSignal, parentSignal].filter(Boolean) as AbortSignal[];
  const generateOptions = {
    ...options,
    abortSignal: externalSignals.length > 0
      ? AbortSignal.any([controller.signal, ...externalSignals])
      : controller.signal,
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      agent.generate(prompt, generateOptions), // @harness-exempt — direct generate for non-harness delegation paths
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          try {
            controller.abort(new Error('delegation_timeout'));
          } catch {
            // best-effort abort; never mask the timeout rejection
          }
          reject(new Error(`Delegation to ${targetAgent} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildDelegationSuccessCriteria(targetAgent: string, taskDescription = ''): string[] {
  const common = [
    'The delegated agent returns a usable result that directly addresses the task brief.',
    'The result follows the requested output format and constraints.',
  ];

  switch (targetAgent) {
    case 'codingAgent':
      return [
        ...common,
        'The result names changed files or clearly states that the task was read-only.',
        'Verification commands are run or skipped with an explicit reason.',
      ];
    case 'automationArchitect':
      if (classifyAutomationArchitectDelegationMode(taskDescription) === 'read_only_analysis') {
        return [
          ...common,
          'The result is a read-only analysis or audit report.',
          'The result does not claim deployment, activation, credential changes, or production mutation.',
        ];
      }
      return [
        ...common,
        'The result includes a terminal Golden Path status.',
        'automationId and workflowId are included when deployment or testing succeeds.',
      ];
    case 'n8nMcpEngineer':
      return [
        ...common,
        'The result is read-only and does not claim any n8n deployment, update, activation, deletion, test execution, auto-fix, or credential mutation.',
        'The result includes a structured handoff with template candidates, node plan, validation findings, required credentials, topology assumptions, open questions, and readyForGoldenPath.',
      ];
    case 'knowledgeAgent':
      return [
        ...common,
        'The result is grounded in NotebookLM sources or explicitly states missing source coverage.',
      ];
    case 'deliberationAgent':
      return [
        ...common,
        'The result includes trade-offs, recommendation, risks, and open questions when relevant.',
      ];
    case 'designAgent':
      return [
        ...common,
        'The result identifies the produced design deliverable paths or explicitly states why generation/export was not possible.',
        'Brand/fact-bearing claims are grounded through asset tools or researcher delegation when relevant.',
        'Visual QA or export validation is run, or skipped with an explicit reason.',
      ];
    case 'filmmakerAgent':
      return [
        ...common,
        'The result identifies the film project id, clip ids, generated MP4 paths or explicitly states why generation was not possible.',
        'Prompt specs are linted and continuity/source checks are run, or skipped with an explicit reason.',
        'Paid remote video generation is gated by approval and recorded in the generation-run ledger.',
      ];
    case 'musicianAgent':
      return [
        ...common,
        'The result identifies the music project id, track id(s), generated audio path(s) or explicitly states why generation was not possible.',
        'Prompt specs are linted and safety-checked, or skipped with an explicit reason.',
        'Paid remote audio generation is gated by approval and recorded in the generation-run ledger.',
      ];
    default:
      return common;
  }
}

function truncate(text: string, max: number): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function summarizeDelegationResult(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Delegation returned an empty response.';
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}
