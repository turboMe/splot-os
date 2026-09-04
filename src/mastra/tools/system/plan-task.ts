/**
 * system.plan_task — generate an explicit, LLM-authored execution plan.
 *
 * WS2 of ideas/orchestration-upgrade-plan.md (Plan-and-Execute + replanning).
 *
 * Why this exists: `buildDelegationPlan` (delegate-task.ts) used to return the
 * SAME three static generic steps for every task. A static plan cannot drive
 * execution and cannot be revised. This tool produces a real plan with explicit
 * `assumptions` — the assumptions are the trigger for replanning: when a step
 * result contradicts an assumption, the Reflektor re-plans the remaining steps.
 *
 * The plan is intentionally NOT one-shot. It is stored in `GoalContract.plannedSteps`
 * (a living contract, like Claude Code's TodoWrite) and rewritten via
 * `recordPlanRevision` when an assumption breaks.
 *
 * This module is a thin wrapper: `planSchema` (the contract), `generatePlan` (a
 * reusable helper that delegation code calls directly), and `planTaskTool` (the
 * meta-agent-facing tool). The brief is always written in ENGLISH; only the
 * deliverable language is controlled elsewhere.
 */
import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { workerPresets, resolveModelId, resolveTestForcedModelId } from '../../config/model-manifest.js';
import { ensureDefaultGateways } from '../../lib/gateway-registry.js';
import { ARTIFACT_TYPES } from '../../config/artifact-types.js';
import { logAgentEvent } from '../../lib/agent-event-log.js';

export const planStepSchema = z.object({
  id: z.string().describe('Stable short id, e.g. "step-1".'),
  intent: z.string().describe('What this step is trying to achieve (one sentence).'),
  toolOrAgent: z
    .string()
    .optional()
    .describe('The tool or expert agent best suited for this step, if known.'),
  dependsOn: z
    .array(z.string())
    .default([])
    .describe('IDs of prerequisite steps that must complete before this step can execute (DAG dependencies). Independent steps have empty dependsOn: [].'),
  executionType: z
    .enum(['single_agent', 'batch_workers', 'workflow'])
    .default('single_agent')
    .describe('Execution strategy: single_agent for domain delegation, batch_workers for parallel text sub-workers, workflow for predefined pipelines.'),
  resourceProfile: z
    .object({
      needsGpu: z.boolean().default(false).describe('True if this step uses ComfyUI or VoiceStudio (GPU Mutex).'),
      exclusiveFiles: z.array(z.string()).default([]).describe('Repository file paths modified in this step (RWLock write).'),
    })
    .optional(),
  // P4a (delegation-depth-hardening): optional with default — planner LLMs
  // notoriously drop this field, and a missing string used to abort the WHOLE
  // plan (observed live: 3-step plan rejected, meta degraded to inline
  // planning at `critical` depth). A backfill from `intent` happens before
  // parse so GoalContracts still get non-empty criteria.
  expectedOutput: z.string().optional().default('').describe('The artifact this step should produce.'),
  out: z.enum(ARTIFACT_TYPES).optional()
    .describe('Etap 3: the artifact TYPE this step should produce (handoffs name their artifact type).'),
  successCheck: z.string().describe('How you will know this step actually succeeded — a checkable condition.'),
});

export const planSchema = z.object({
  goal: z.string().describe('One measurable sentence: what done looks like.'),
  /** The assumptions are the replanning trigger — when one breaks, re-plan. */
  assumptions: z
    .array(z.string())
    .min(1)
    .describe('Facts taken as true. Replanning fires when a step result contradicts one of these. Never empty.'),
  steps: z.array(planStepSchema).min(1).describe('Ordered steps, each with its own successCheck.'),
  checkpoints: z
    .array(z.string())
    .default([])
    .describe('After which step(s) to re-verify the assumptions before continuing.'),
});

export type Plan = z.infer<typeof planSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;

const DEFAULT_PLAN_MODEL = resolveModelId('deepseek-v4-flash' as any);
const DEFAULT_PLAN_TIMEOUT_MS = 45_000;

function getPlanModel(): string {
  return resolveTestForcedModelId() ?? DEFAULT_PLAN_MODEL;
}

function getPlanTimeoutMs(): number {
  const raw = Number(process.env.PLAN_TASK_TIMEOUT_MS ?? DEFAULT_PLAN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PLAN_TIMEOUT_MS;
}

/**
 * Extract a JSON object from a model response that may be fenced or chatty.
 * Mirrors the tolerant parsing already used in tools/architect/composer.ts.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  // Fall back to the first {...} span if there is leading/trailing prose.
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  const slice = firstBrace >= 0 && lastBrace > firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
  return JSON.parse(slice);
}

const PLAN_SYSTEM_INSTRUCTION =
  'You are a concurrency-aware DAG planning module for a multi-agent system with a 12-slot WorkerPool. ' +
  'Given a goal and context, produce a concise, executable plan as STRICT JSON — no prose, no markdown fences. ' +
  'The plan MUST contain non-empty "assumptions" (facts you take as true; these trigger replanning if broken) ' +
  'and structured "steps". Each step MUST specify "dependsOn" (array of prerequisite step IDs; use empty [] for independent steps that can run concurrently in parallel slots), ' +
  '"executionType" ("single_agent" for domain specialist delegation, "batch_workers" for parallel text sub-workers via system_run_worker_batch, "workflow" for predefined pipelines), ' +
  'and optional "resourceProfile" (set needsGpu: true if step uses ComfyUI or VoiceStudio; specify exclusiveFiles: string[] if modifying repo files to obey RWLock). ' +
  'Keep the plan minimal: only steps the goal actually requires. Never invent destructive side effects unless explicitly requested.';

export interface GeneratePlanArgs {
  goal: string;
  context?: string;
  /** Optional hint about which tools/agents are available, to ground `toolOrAgent`. */
  availableTools?: string[];
  mastra?: unknown;
}

/**
 * Generate a Plan from a goal + context. Reusable by delegation code so the
 * plan that lands in a GoalContract is LLM-authored, not static.
 *
 * Throws if the model cannot produce a schema-valid plan (the caller decides
 * whether to fall back to a degraded static plan).
 */
export async function generatePlan(args: GeneratePlanArgs): Promise<Plan> {
  ensureDefaultGateways();
  const { goal, context, availableTools, mastra } = args;
  const model = getPlanModel();

  const promptParts: string[] = [`GOAL: ${goal}`];
  if (context && context.trim()) promptParts.push(`CONTEXT:\n${context.trim()}`);
  if (availableTools && availableTools.length > 0) {
    promptParts.push(`AVAILABLE TOOLS/AGENTS (prefer these for toolOrAgent):\n${availableTools.map((t) => `- ${t}`).join('\n')}`);
  }
  promptParts.push(
    'Return JSON matching: { "goal": string, "assumptions": string[] (>=1), ' +
      '"steps": [{ "id": string, "intent": string, "toolOrAgent"?: string, "dependsOn": string[], "executionType": "single_agent"|"batch_workers"|"workflow", "resourceProfile"?: { "needsGpu"?: boolean, "exclusiveFiles"?: string[] }, "expectedOutput": string, "successCheck": string }] (>=1), ' +
      '"checkpoints": string[] }',
  );

  const planner = new Agent({
    id: `plan-task-${Date.now()}`,
    name: 'Planner',
    instructions: PLAN_SYSTEM_INSTRUCTION,
    model,
    mastra: mastra as any,
  });

  const prompt = promptParts.join('\n\n');
  // One retry on empty output: the planner model is a cloud model, and a single
  // empty response is usually transient (gateway saturation / reasoning-only
  // turn with no final text). A bare throw aborts replanning unnecessarily.
  let text = '';
  for (let attempt = 0; attempt < 2 && !text; attempt += 1) {
    const result = await withTimeout(
      planner.generate(prompt, { // @harness-exempt — bounded no-tool single-step planner with its own timeout
        maxSteps: 1,
        toolChoice: 'none',
      } as any),
      getPlanTimeoutMs(),
      `Planner LLM call timed out after ${Math.round(getPlanTimeoutMs() / 1000)}s`,
    );
    text = (result.text ?? '').trim();
  }
  if (!text) {
    throw new Error('Planner returned empty output (after retry).');
  }

  const parsed = extractJsonObject(text);
  // Ensure goal is preserved even if the model omits it.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !(parsed as Record<string, unknown>).goal) {
    (parsed as Record<string, unknown>).goal = goal;
  }
  // P4a — backfill missing/empty expectedOutput from intent so downstream
  // GoalContract criteria stay non-empty even when the planner drops the field.
  // Backfill dependsOn and executionType if omitted by simpler models.
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).steps)) {
    for (const step of (parsed as { steps: unknown[] }).steps) {
      if (step && typeof step === 'object') {
        const s = step as Record<string, unknown>;
        if (typeof s.expectedOutput !== 'string' || s.expectedOutput.trim() === '') {
          s.expectedOutput = typeof s.intent === 'string' ? s.intent : '';
        }
        if (!Array.isArray(s.dependsOn)) {
          s.dependsOn = [];
        }
        if (!s.executionType || typeof s.executionType !== 'string') {
          s.executionType = 'single_agent';
        }
      }
    }
  }
  return planSchema.parse(parsed);
}

export const planTaskTool = createTool({
  id: 'system_plan_task',
  description: `Generates an explicit, executable plan for a complex task BEFORE acting.

Use when the task has >=3 steps, has side effects (deploy/send/write), or spans >1 agent.
Skip for simple one-shot lookups — planning is a cost.

 Returns a Plan with explicit "assumptions" (the replanning trigger: when a step result
contradicts an assumption, re-plan the remaining steps) and per-step "successCheck".
Plan model ← config/model-manifest.ts workerPresets.reasoning (${DEFAULT_PLAN_MODEL}); TEST_FORCE_MODEL can override in E2E.`,

  inputSchema: z.object({
    goal: z.string().min(10).describe('One measurable sentence: what success looks like.'),
    context: z
      .string()
      .optional()
      .describe('Background the planner cannot infer: prior decisions, constraints, names, history.'),
    availableTools: z
      .array(z.string())
      .optional()
      .describe('Tools or expert agents available, so the plan can ground each step in a concrete tool/agent.'),
  }),

  outputSchema: z.object({
    plan: planSchema.optional(),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async (input, { mastra }) => {
    const start = Date.now();
    const runId = `plan:task-${start}`;
    const model = getPlanModel();
    void logAgentEvent({
      type: 'plan_task_started',
      agentId: runId,
      status: 'pending',
      model,
      input: input.goal.slice(0, 200),
      metadata: { kind: 'plan_task', callerAgent: 'metaAgent' },
    });

    try {
      const plan = await generatePlan({
        goal: input.goal,
        context: input.context,
        availableTools: input.availableTools,
        mastra,
      });

      void logAgentEvent({
        type: 'plan_task_completed',
        agentId: runId,
        status: 'success',
        model,
        durationMs: Date.now() - start,
        output: `${plan.steps.length} steps, ${plan.assumptions.length} assumptions`,
        metadata: { kind: 'plan_task' },
      });

      return { plan, success: true };
    } catch (error) {
      void logAgentEvent({
        type: 'plan_task_failed',
        agentId: runId,
        status: 'error',
        model,
        durationMs: Date.now() - start,
        errorMessage: (error as Error).message,
        metadata: { kind: 'plan_task' },
      });
      return {
        success: false,
        error: `Planning failed: ${(error as Error).message}`,
      };
    }
  },
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
