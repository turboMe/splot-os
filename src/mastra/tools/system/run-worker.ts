/**
 * system.run_worker — spawn a blank LLM executor with a custom brief.
 *
 * Unlike delegate_task (expert agents with personality + tools),
 * run_worker creates an ad-hoc model with NO extra prompt and NO tools.
 * Meta-agent writes the full brief including role, context, format.
 *
 * Phase 3.3: Now supports `skills` param — loads skill procedures from
 * the SkillRegistry and injects them into the worker's prompt.
 * Also supports `allowedTools` — a whitelist description for the worker
 * (informational only — workers are still text-in/text-out).
 *
 * Preset → model mapping is the SINGLE SOURCE OF TRUTH in
 * config/model-manifest.ts (`workerPresets`). The tool description below is
 * generated from it at module load so it can never drift from the manifest.
 *
 * Preset roles (what each tier is meant for):
 *   fast      → quick classification / JSON extraction / reformatting
 *   default   → Polish copy, summaries, generic generation
 *   reasoning → analysis, math, code, structured planning
 *   powerful  → long-form, creative, difficult reasoning
 *   cloud     → legacy high-capability alias (not guaranteed cross-provider)
 *   design    → frontend/design variation generation
 *   film      → Seedance prompt variants, take critique, repair planning
 *   writer_*  → specialist writing critique, reader simulation, ideation, continuity, polish
 */
import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSkillRegistry } from '../../services/skill-registry.js';
import { workerPresets, resolveModelId, resolveTestForcedModelId } from '../../config/model-manifest.js';
import { resolveExecutionModel } from '../../config/model-capabilities.js';
import { getArtifact } from '../../services/artifact-store.js';
import { getThinkingProviderOptions, type ThinkingTier } from '../../config/thinking-budget.js';
import { logAgentEvent } from '../../lib/agent-event-log.js';
import {
  workerTaskSpecSchema,
  renderWorkerBrief,
  writerReviewPromptModifierError,
} from './worker-task-spec.js';
import {
  claimWorkerReviewRequest,
  recordSuccessfulWorkerRunReceipt,
} from './worker-run-receipts.js';

type WorkerPresetName = keyof typeof workerPresets;
const PRESET_TO_MODEL = Object.fromEntries(
  Object.entries(workerPresets).map(([k, v]) => [k, resolveModelId(v)]),
) as Record<WorkerPresetName, string>;
const WORKER_PRESET_NAMES = Object.keys(workerPresets) as [WorkerPresetName, ...WorkerPresetName[]];

/**
 * Maximum character budget for injected skill procedures in a single ad-hoc worker (~4 000 tokens).
 * Prevents prompt bloat and context degradation in fast/small models.
 */
export const MAX_WORKER_SKILL_CHARS = 16000;

// Per-preset role hints (what each tier is meant for). Model names are NOT
// hardcoded here — they are pulled from the manifest below so the description
// can never drift from the actual runtime config.
const PRESET_ROLES = {
  'fast': 'classification, JSON extraction, reformatting',
  'default': 'Polish copy, summaries, general generation',
  'reasoning': 'analysis, math, code, structured plans',
  'powerful': 'long-form, creative, difficult reasoning',
  'cloud': 'legacy high-capability alias; not a guaranteed cross-provider fallback',
  'design': 'frontend/design variation generation',
  'film': 'Seedance prompt variants, take critique, repair planning',
  'music': 'Lyric/style prompt variants, hook A/B, per-track album drafts',
  'writer_critic': 'deep critique of prose, structure, continuity, factual integrity',
  'writer_reader': 'reader simulation, engagement, flow, confusion, payoff',
  'writer_muse': 'creative alternatives, angles, structures, twists',
  'writer_chronicler': 'canon and continuity extraction from written text',
  'writer_polisher': 'final style polish and anti-slop revision suggestions',
} satisfies Record<WorkerPresetName, string>;

const PRESET_DESCRIPTION = WORKER_PRESET_NAMES
  .map((preset) => `- ${preset.padEnd(9)} → ${PRESET_TO_MODEL[preset]} (${PRESET_ROLES[preset]})`)
  .join('\n');

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error(String(reason ?? 'worker_parent_aborted'));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export const runWorkerTool = createTool({
  id: 'system_run_worker',
  description: `Spawns a blank LLM worker with a custom brief written by meta-agent.
No built-in personality, no tools — pure text-in-text-out generation.
Use for ad-hoc tasks that do not fit any registered expert (delegate_task).
CAN be called multiple times in parallel for independent sub-tasks.

Phase 3.3: Supports 'skills' param — loads skill procedures and injects them into the worker prompt.

Presets (model ← config/model-manifest.ts workerPresets):
${PRESET_DESCRIPTION}`,

  inputSchema: z.object({
    preset: z
      .enum(WORKER_PRESET_NAMES)
      .describe('Model size or specialist preset. Choose based on task complexity and domain role.'),

    taskSpec: workerTaskSpecSchema
      .optional()
      .describe(
        'PREFERRED: structured task contract (goal, scope, outputContract, successCriteria). ' +
          'When provided, it is rendered into the worker brief and takes precedence over taskBrief.',
      ),

    taskBrief: z
      .string()
      .min(10)
      .optional()
      .describe(
        'Fallback free-form brief IN ENGLISH when taskSpec is not used. Must contain: ' +
          'GOAL, CONTEXT, INPUT, OUTPUT FORMAT, CONSTRAINTS. Be ruthlessly explicit — ' +
          'small models have no background knowledge. Prefer taskSpec.',
      ),

    modelTier: z
      .enum(['auto', 'fast', 'balanced', 'pro', 'private'])
      .default('auto')
      .optional()
      .describe('Execution model tier. "fast" uses fast LPU/flash cloud model for skilled SOPs; "balanced" uses mid cloud model; "pro" uses deep reasoning cloud model; "private" uses strictly local Ollama.'),

    inputArtifactIds: z
      .array(z.string())
      .optional()
      .describe('List of artifact IDs from upstream agents to inject into context (handoff/sequential chaining).'),

    skills: z
      .array(z.string())
      .optional()
      .describe('List of skill names to load from the Skill Registry. Their procedures will be injected into the worker prompt.'),

    allowedTools: z
      .array(z.string())
      .optional()
      .describe('Informational whitelist of tools the worker should reference in its output (workers are text-only — this is for prompt context).'),

    attemptNumber: z.number().int().min(1).max(3).default(1).describe('Attempt counter (1–3). Pass 2 or 3 on retries.'),

    previousAttempt: z
      .object({
        output: z.string().describe('The bad output from the previous attempt'),
        criticism: z.string().describe('Why it was wrong / what to fix'),
      })
      .optional()
      .describe('On retry: pass the previous bad output and your diagnosis. ' + 'The worker will see what NOT to do.'),
  }),

  outputSchema: z.object({
    output: z.string(),
    model: z.string(),
    attemptNumber: z.number(),
    success: z.boolean(),
    workerRunId: z.string().optional(),
    outputHash: z.string().optional(),
    skillsLoaded: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),

  execute: async (input, { mastra, abortSignal }) => {
    // Fail before any model, skill-registry, telemetry or filesystem work if the
    // parent run has already lost its authority/deadline.
    throwIfAborted(abortSignal);

    // ── Resolve the brief: structured taskSpec (preferred) → rendered, else taskBrief ──
    const baseBrief = input.taskSpec ? renderWorkerBrief(input.taskSpec) : input.taskBrief;
    if (!baseBrief) {
      const fallbackModel = resolveTestForcedModelId() ?? PRESET_TO_MODEL[input.preset] ?? PRESET_TO_MODEL.default;
      return {
        output: '',
        model: fallbackModel,
        attemptNumber: input.attemptNumber ?? 1,
        success: false,
        error: 'Underspecified task: provide either taskSpec (preferred) or taskBrief.',
      };
    }

    // The prepared request hashes the exact taskSpec. Prompt fragments outside
    // it would otherwise let the caller steer a receipt-bound "independent"
    // review after authorization (for example by injecting a desired verdict
    // through previousAttempt.criticism). Writer reviews therefore use only the
    // prepared taskSpec; retries must prepare a new request.
    const writerModifierError = writerReviewPromptModifierError(input);
    if (writerModifierError) {
      const fallbackModel = resolveTestForcedModelId() ?? PRESET_TO_MODEL[input.preset] ?? PRESET_TO_MODEL.default;
      return {
        output: '',
        model: fallbackModel,
        attemptNumber: input.attemptNumber ?? 1,
        success: false,
        error: writerModifierError,
      };
    }

    // Build the full system prompt: brief + optional skill procedures + retry context
    let systemPrompt = baseBrief;
    const loadedSkillNames: string[] = [];
    const loadedSkillsMeta: any[] = [];

    // ── Upstream Artifact Inputs (Handoff / Chaining) ──
    if (input.inputArtifactIds && input.inputArtifactIds.length > 0) {
      try {
        const artifactSections: string[] = [];
        for (const artId of input.inputArtifactIds) {
          const art = await getArtifact(artId, { includeContent: true });
          if (art) {
            artifactSections.push(`\n---\n## Input Artifact: ${art.id} (${art.type})\n${art.content || art.summary || '(Empty content)'}`);
          }
        }
        if (artifactSections.length > 0) {
          systemPrompt = artifactSections.join('\n') + '\n\n' + systemPrompt;
        }
      } catch (err) {
        console.warn('[RunWorker] Artifact loading failed:', (err as Error).message);
      }
    }

    // ── Phase 3.3: Load skill procedures with Attention Budget Clamping ──
    if (input.skills && input.skills.length > 0) {
      try {
        const registry = getSkillRegistry();
        const skillSections: string[] = [];
        let totalSkillChars = 0;
        const observedOutputFormats = new Set<string>();

        for (const skillName of input.skills) {
          const skill = await registry.load(skillName);
          if (skill) {
            let procedure = skill.procedure;
            const entryHeader = `\n---\n## Skill: ${skill.metadata.name}\n> ${skill.metadata.description}\n\n`;
            const entryLen = entryHeader.length + procedure.length;

            if (totalSkillChars + entryLen > MAX_WORKER_SKILL_CHARS) {
              const remainingBudget = Math.max(0, MAX_WORKER_SKILL_CHARS - totalSkillChars - entryHeader.length - 80);
              console.warn(
                `[RunWorker] Warning: Skill '${skillName}' exceeds attention budget (${totalSkillChars + entryLen} > ${MAX_WORKER_SKILL_CHARS}). Clamping procedure.`,
              );
              if (remainingBudget > 200) {
                procedure = procedure.slice(0, remainingBudget) + '\n\n... [Skill procedure clamped due to attention budget limit]';
                skillSections.push(entryHeader + procedure);
                totalSkillChars += entryHeader.length + procedure.length;
              } else {
                console.warn(`[RunWorker] Skill '${skillName}' omitted completely due to exhausted attention budget.`);
                continue;
              }
            } else {
              skillSections.push(entryHeader + procedure);
              totalSkillChars += entryLen;
            }

            if (skill.metadata.outputFormat) {
              observedOutputFormats.add(skill.metadata.outputFormat);
            }
            loadedSkillNames.push(skillName);
            loadedSkillsMeta.push(skill.metadata);
          } else {
            console.warn(`[RunWorker] Skill not found: ${skillName}`);
          }
        }

        if (observedOutputFormats.size > 1) {
          console.warn(
            `[RunWorker] Notice: Multi-skill composition detected multiple output formats: [${Array.from(observedOutputFormats).join(', ')}]. Strictest format rules apply.`,
          );
        }

        if (skillSections.length > 0) {
          systemPrompt += '\n\n' + skillSections.join('\n');
        }
      } catch (err) {
        console.warn('[RunWorker] Skill loading failed:', (err as Error).message);
      }
    }

    // Resolve final execution model based on requested modelTier and skill metadata
    const defaultPresetModelId = PRESET_TO_MODEL[input.preset] ?? PRESET_TO_MODEL.default;
    const resolvedTierModelId = resolveExecutionModel({
      requestedTier: input.modelTier,
      skills: loadedSkillsMeta,
      agentDefaultModelId: defaultPresetModelId,
      preferLocal: false,
    });
    const modelId = resolveTestForcedModelId() ?? resolvedTierModelId ?? defaultPresetModelId;

    // ── Dashboard telemetry: announce this ad-hoc worker spawn ──
    // agentId uses the "worker:" prefix so the Command Center topology renders
    // it as a worker node with a live beam from the meta orchestrator.
    const workerStart = Date.now();
    const workerRunId = `worker:run-${input.preset}-${randomUUID()}`;
    void logAgentEvent({
      type: 'worker_run_started',
      agentId: workerRunId,
      status: 'pending',
      model: modelId,
      input: baseBrief.slice(0, 200),
      metadata: { preset: input.preset, kind: 'run_worker', callerAgent: 'metaAgent' },
    });

    let trustedRequestId: string | undefined;
    if (input.taskSpec?.correlation?.domain === 'writer') {
      throwIfAborted(abortSignal);
      const request = await claimWorkerReviewRequest({
        workerRunId,
        preset: input.preset,
        correlation: input.taskSpec.correlation,
        taskSpec: input.taskSpec,
      });
      throwIfAborted(abortSignal);
      if (!request.ok) {
        void logAgentEvent({
          type: 'worker_run_failed',
          agentId: workerRunId,
          status: 'error',
          model: modelId,
          durationMs: Date.now() - workerStart,
          errorMessage: request.error,
          metadata: { preset: input.preset, kind: 'run_worker' },
        });
        return {
          output: '',
          model: modelId,
          attemptNumber: input.attemptNumber ?? 1,
          success: false,
          workerRunId,
          error: request.error,
        };
      }
      trustedRequestId = request.requestId;
    }

    // ── Allowed tools context (informational) ──
    if (input.allowedTools && input.allowedTools.length > 0) {
      systemPrompt +=
        '\n\n## Available tools (reference only)\n' +
        input.allowedTools.map((t: string) => `- ${t}`).join('\n');
    }

    if (input.previousAttempt) {
      systemPrompt +=
        '\n\n---\n' +
        '## ⚠️ Previous attempt (DO NOT REPEAT THIS)\n\n' +
        input.previousAttempt.output +
        '\n\n## Why it was wrong\n\n' +
        input.previousAttempt.criticism +
        '\n\n## Your task now\n\n' +
        'Produce a corrected output that directly addresses the criticism above. ' +
        'Do not explain what you changed — just deliver the correct result.';
    }

    try {
      // Create an actually text-only ad-hoc agent. Passing `mastra` normally
      // inherits the global Workspace and silently injects list/read/write tools;
      // an explicit workspace resolver prevents that inheritance while keeping
      // the registered model provider available.
      const workerThinkingTier: ThinkingTier =
        input.preset === 'reasoning' || input.preset === 'powerful' || input.preset === 'writer_polisher'
          ? 'medium'
          : 'none';

      const worker = new Agent({
        id: `run-worker-${input.preset}-${Date.now()}`,
        name: `Worker [${input.preset} / attempt ${input.attemptNumber}]`,
        // Minimal base instruction — the taskBrief carries all the specifics
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
        mastra: mastra as any,
        workspace: async () => undefined,
      });

      const result = await worker.generate(systemPrompt, { abortSignal } as any);
      throwIfAborted(abortSignal);
      const text = (result.text ?? '').trim();

      // ── Empty-output guard ──
      // An empty result is NOT a success. With DeepSeek v4 thinking mode this
      // happens when the reasoning_content round-trip is broken on a multi-turn
      // tool loop (the model "thinks" but emits no final answer). Surface it as
      // a failure so meta-agent can retry (e.g. with the 'cloud' preset) instead
      // of silently propagating an empty string as if it were a real result.
      if (text.length === 0) {
        if (loadedSkillNames.length > 0) {
          try {
            throwIfAborted(abortSignal);
            const registry = getSkillRegistry();
            for (const name of loadedSkillNames) {
              throwIfAborted(abortSignal);
              await registry.reportResult(name, false, 'Worker returned empty output');
            }
          } catch { /* non-critical */ }
        }
        throwIfAborted(abortSignal);
        void logAgentEvent({
          type: 'worker_run_failed',
          agentId: workerRunId,
          status: 'error',
          model: modelId,
          durationMs: Date.now() - workerStart,
          errorMessage: 'Worker returned empty output',
          metadata: { preset: input.preset, kind: 'run_worker' },
        });
        return {
          output: '',
          model: modelId,
          attemptNumber: input.attemptNumber ?? 1,
          success: false,
          workerRunId,
          skillsLoaded: loadedSkillNames.length > 0 ? loadedSkillNames : undefined,
          error: 'Worker returned empty output (no text). The model may have produced only reasoning with no final answer.',
        };
      }

      let outputHash: string | undefined;
      if (input.taskSpec?.correlation) {
        throwIfAborted(abortSignal);
        const receipt = await recordSuccessfulWorkerRunReceipt({
          workerRunId,
          preset: input.preset,
          correlation: input.taskSpec.correlation,
          output: text,
          trustedRequestId,
        });
        throwIfAborted(abortSignal);
        outputHash = receipt.outputHash;
      }

      // ── Phase 3.4: Report skill usage results ──
      if (loadedSkillNames.length > 0) {
        try {
          throwIfAborted(abortSignal);
          const registry = getSkillRegistry();
          for (const name of loadedSkillNames) {
            throwIfAborted(abortSignal);
            await registry.reportResult(name, true, 'Worker completed successfully');
          }
        } catch { /* non-critical */ }
      }

      throwIfAborted(abortSignal);
      void logAgentEvent({
        type: 'worker_run_completed',
        agentId: workerRunId,
        status: 'success',
        model: modelId,
        durationMs: Date.now() - workerStart,
        output: text.slice(0, 200),
        metadata: { preset: input.preset, kind: 'run_worker' },
      });

      return {
        output: text,
        model: modelId,
        attemptNumber: input.attemptNumber ?? 1,
        success: true,
        workerRunId,
        outputHash,
        skillsLoaded: loadedSkillNames.length > 0 ? loadedSkillNames : undefined,
      };
    } catch (error) {
      // Cancellation is an authority boundary. Do this before skill telemetry
      // or worker events so an already-terminal parent cannot trigger writes.
      if (abortSignal?.aborted) throw abortReason(abortSignal);

      // Report skill failure
      if (loadedSkillNames.length > 0) {
        try {
          const registry = getSkillRegistry();
          for (const name of loadedSkillNames) {
            await registry.reportResult(name, false, (error as Error).message);
          }
        } catch { /* non-critical */ }
      }

      void logAgentEvent({
        type: 'worker_run_failed',
        agentId: workerRunId,
        status: 'error',
        model: modelId,
        durationMs: Date.now() - workerStart,
        errorMessage: (error as Error).message,
        metadata: { preset: input.preset, kind: 'run_worker' },
      });

      // Surface a clean provider error so meta can retry with corrected context,
      // a different capability tier, or a registered expert as appropriate.
      return {
        output: '',
        model: modelId,
        attemptNumber: input.attemptNumber ?? 1,
        success: false,
        workerRunId,
        skillsLoaded: loadedSkillNames.length > 0 ? loadedSkillNames : undefined,
        error: (error as Error).message,
      };
    }
  },
});
