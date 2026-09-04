import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workerPresets, resolveModelId, resolveTestForcedModelId } from '../../config/model-manifest.js';
import { resolveExecutionModel } from '../../config/model-capabilities.js';
import { getThinkingProviderOptions, type ThinkingTier } from '../../config/thinking-budget.js';
import { logAgentEvent } from '../../lib/agent-event-log.js';
import { getSkillRegistry } from '../../services/skill-registry.js';

const MAX_WORKER_SKILL_CHARS = 16_000;

type WorkerPresetName = keyof typeof workerPresets;
const WORKER_PRESET_NAMES = Object.keys(workerPresets) as [WorkerPresetName, ...WorkerPresetName[]];
const PRESET_TO_MODEL = Object.fromEntries(
  Object.entries(workerPresets).map(([k, v]) => [k, resolveModelId(v)]),
) as Record<WorkerPresetName, string>;

const batchItemSchema = z.object({
  id: z.string().optional().describe('Unique identifier for this sub-task (e.g. "critique", "muse", "formatter")'),
  preset: z.enum(WORKER_PRESET_NAMES).describe('Model preset (fast, default, reasoning, powerful, writer_critic, etc.)'),
  taskBrief: z.string().min(10).describe('Instruction/prompt for this sub-worker'),
  modelTier: z.enum(['auto', 'fast', 'balanced', 'pro', 'private']).default('auto').optional(),
  skills: z.array(z.string()).optional().describe('List of skill names from SkillRegistry to inject into worker prompt'),
});

const batchResultItemSchema = z.object({
  id: z.string(),
  preset: z.string(),
  model: z.string(),
  success: z.boolean(),
  output: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
});

/**
 * system_run_worker_batch — Spawns multiple ad-hoc LLM workers in parallel.
 *
 * Use cases:
 * - Simultaneous multi-angle critique (e.g. writer_critic + writer_reader + writer_muse).
 * - Parallel extraction / JSON formatting of multiple independent sections.
 * - Multi-variant generation (e.g. 3 different intros or email copies).
 * - Fast fan-out: executes concurrently via Promise.all instead of sequential blocking.
 */
export const runWorkerBatchTool = createTool({
  id: 'system_run_worker_batch',
  description:
    'Runs multiple ad-hoc text-only workers in PARALLEL via Promise.all. ' +
    'Significantly faster than calling system_run_worker multiple times sequentially. ' +
    'Ideal for multi-critic reviews, multi-variant generation, or parallel chunk summarization.',
  inputSchema: z.object({
    tasks: z.array(batchItemSchema).min(1).max(10).describe('Array of 1 to 10 independent sub-tasks to run in parallel'),
    batchDescription: z.string().optional().describe('Optional context describing the batch goal'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    totalTasks: z.number(),
    successfulTasks: z.number(),
    failedTasks: z.number(),
    totalDurationMs: z.number(),
    results: z.array(batchResultItemSchema),
  }),
  execute: async ({ tasks, batchDescription }, executionContext) => {
    const batchStart = Date.now();
    const abortSignal = executionContext?.abortSignal;
    const mastraInstance = (executionContext as any)?.mastra;

    console.log(`[runWorkerBatch] Starting parallel batch with ${tasks.length} sub-workers (${batchDescription ?? 'ad-hoc'})`);

    const executionPromises = tasks.map(async (task, index) => {
      const taskStart = Date.now();
      const taskId = task.id || `task_${index + 1}_${task.preset}`;
      const workerRunId = `worker-batch-${randomUUID()}`;

      // Load skill procedures with Attention Budget Clamping
      let workerPrompt = task.taskBrief;
      const loadedSkillNames: string[] = [];
      const loadedSkillsMeta: any[] = [];

      if (task.skills && task.skills.length > 0) {
        try {
          const registry = getSkillRegistry();
          const skillSections: string[] = [];
          let totalSkillChars = 0;

          for (const skillName of task.skills) {
            const skill = await registry.load(skillName);
            if (skill) {
              let procedure = skill.procedure;
              const entryHeader = `\n---\n## Skill: ${skill.metadata.name}\n> ${skill.metadata.description}\n\n`;
              const entryLen = entryHeader.length + procedure.length;

              if (totalSkillChars + entryLen > MAX_WORKER_SKILL_CHARS) {
                const remainingBudget = Math.max(0, MAX_WORKER_SKILL_CHARS - totalSkillChars - entryHeader.length - 80);
                if (remainingBudget > 200) {
                  procedure = procedure.slice(0, remainingBudget) + '\n\n... [Skill procedure clamped due to attention budget limit]';
                  skillSections.push(entryHeader + procedure);
                  totalSkillChars += entryHeader.length + procedure.length;
                }
              } else {
                skillSections.push(entryHeader + procedure);
                totalSkillChars += entryLen;
              }
              loadedSkillNames.push(skillName);
              loadedSkillsMeta.push(skill.metadata);
            } else {
              console.warn(`[runWorkerBatch] Skill not found: ${skillName}`);
            }
          }

          if (skillSections.length > 0) {
            workerPrompt += '\n\n## SOP Procedures (Loaded Skills):\n' + skillSections.join('\n');
          }
        } catch (err) {
          console.warn('[runWorkerBatch] Skill loading failed:', (err as Error).message);
        }
      }

      // Resolve model
      const defaultPresetModelId = PRESET_TO_MODEL[task.preset] ?? PRESET_TO_MODEL.default;
      const resolvedTierModelId = resolveExecutionModel({
        requestedTier: task.modelTier,
        skills: loadedSkillsMeta,
        agentDefaultModelId: defaultPresetModelId,
        preferLocal: false,
      });
      const modelId = resolveTestForcedModelId() ?? resolvedTierModelId ?? defaultPresetModelId;

      const workerThinkingTier: ThinkingTier =
        task.preset === 'reasoning' || task.preset === 'powerful' || task.preset === 'writer_polisher'
          ? 'medium'
          : 'none';

      void logAgentEvent({
        type: 'worker_run_started',
        agentId: workerRunId,
        status: 'pending',
        model: modelId,
        input: task.taskBrief.slice(0, 200),
        metadata: { preset: task.preset, kind: 'run_worker_batch', batchTaskId: taskId },
      });

      try {
        if (abortSignal?.aborted) {
          throw new Error('Batch operation aborted by caller');
        }

        const worker = new Agent({
          id: `worker-${taskId}-${Date.now()}`,
          name: `BatchWorker [${taskId} / ${task.preset}]`,
          instructions: 'You are a focused executor. Follow the task brief exactly. Return only what is requested — nothing more.',
          model: modelId,
          defaultOptions: {
            maxSteps: 5,
            providerOptions: getThinkingProviderOptions(workerThinkingTier),
          },
          defaultGenerateOptionsLegacy: {
            maxSteps: 5,
            providerOptions: getThinkingProviderOptions(workerThinkingTier),
          },
          mastra: mastraInstance as any,
          workspace: async () => undefined,
        });

        const result = await worker.generate(workerPrompt, { abortSignal } as any);
        const text = (result.text ?? '').trim();
        const durationMs = Date.now() - taskStart;

        if (text.length === 0) {
          if (loadedSkillNames.length > 0) {
            try {
              const registry = getSkillRegistry();
              for (const name of loadedSkillNames) {
                await registry.reportResult(name, false, 'Worker returned empty output');
              }
            } catch { /* non-critical */ }
          }
          return {
            id: taskId,
            preset: task.preset,
            model: modelId,
            success: false,
            output: '',
            durationMs,
            error: 'Worker returned empty output',
          };
        }

        if (loadedSkillNames.length > 0) {
          try {
            const registry = getSkillRegistry();
            for (const name of loadedSkillNames) {
              await registry.reportResult(name, true);
            }
          } catch { /* non-critical */ }
        }

        void logAgentEvent({
          type: 'worker_run_completed',
          agentId: workerRunId,
          status: 'success',
          model: modelId,
          durationMs,
          output: text.slice(0, 200),
          metadata: { preset: task.preset, kind: 'run_worker_batch', batchTaskId: taskId },
        });

        return {
          id: taskId,
          preset: task.preset,
          model: modelId,
          success: true,
          output: text,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - taskStart;
        const errorMessage = (err as Error).message || String(err);

        void logAgentEvent({
          type: 'worker_run_failed',
          agentId: workerRunId,
          status: 'error',
          model: modelId,
          durationMs,
          errorMessage,
          metadata: { preset: task.preset, kind: 'run_worker_batch', batchTaskId: taskId },
        });

        return {
          id: taskId,
          preset: task.preset,
          model: modelId,
          success: false,
          output: '',
          durationMs,
          error: errorMessage,
        };
      }
    });

    const results = await Promise.all(executionPromises);
    const totalDurationMs = Date.now() - batchStart;
    const successfulTasks = results.filter((r) => r.success).length;
    const failedTasks = results.filter((r) => !r.success).length;

    console.log(`[runWorkerBatch] Completed batch in ${totalDurationMs}ms (${successfulTasks}/${tasks.length} succeeded)`);

    return {
      success: failedTasks === 0,
      totalTasks: tasks.length,
      successfulTasks,
      failedTasks,
      totalDurationMs,
      results,
    };
  },
});
