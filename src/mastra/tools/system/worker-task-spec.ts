/**
 * WorkerTaskSpec — a structured contract for delegating work to a worker or
 * expert sub-agent.
 *
 * WS1 of ideas/orchestration-upgrade-plan.md. Generalizes the structured-handoff
 * idea already proven by `AutomationSpec` (tools/architect/types.ts) — explicit
 * scope, success criteria and an output contract — so that EVERY delegation path
 * (`run_worker`, `delegate_task`) can use it, not just the n8n Golden Path.
 *
 * Why this matters: the bottleneck in multi-agent quality is the quality of the
 * task description, not the worker model. A vague brief makes workers duplicate
 * work or leave gaps; an explicit scope + success contract removes that ambiguity.
 *
 * This module is a pure helper (schema + renderer). It is imported by the
 * delegation tools — it does NOT register a tool of its own.
 *
 * The brief itself is always written in ENGLISH. `constraints.language` refers to
 * the language of the DELIVERABLE the worker must produce (e.g. Polish social copy
 * vs. an English internal analysis), not the language of this brief.
 */
import { z } from 'zod';
import { ARTIFACT_TYPES } from '../../config/artifact-types.js';

export const workerTaskSpecSchema = z.object({
  /** One-sentence, measurable outcome. */
  goal: z.string().min(10).describe('One sentence, measurable: what success looks like.'),

  /** Facts the worker needs but cannot infer from the goal alone. */
  context: z
    .string()
    .optional()
    .describe('Background the worker cannot infer: names, history, prior decisions, constraints.'),

  /** Concrete inputs to operate on, with provenance. */
  inputs: z
    .array(
      z.object({
        name: z.string(),
        value: z.unknown().optional().describe('The actual data, verbatim (string or JSON). Omit when artifactId is set.'),
        artifactId: z.string().optional()
          .describe('TaskBrief v2 (Etap 3): reference an Artifact Store id INSTEAD of pasting content — the brief renders summary + id, the worker fetches full content via artifact_get only if needed.'),
        source: z
          .enum(['user', 'derived', 'memory', 'runtime', 'artifact'])
          .default('derived')
          .describe('Where this input came from.'),
      }),
    )
    .default([])
    .describe('The data to process. Small values verbatim; LARGE content ALWAYS as artifactId ref (never paste).'),

  /** What shape the result must take. Replaces free-prose "OUTPUT FORMAT". */
  outputContract: z
    .object({
      format: z
        .enum(['prose', 'json', 'markdown_table', 'code', 'list'])
        .describe('The structural form of the deliverable.'),
      artifactType: z.enum(ARTIFACT_TYPES).optional()
        .describe('TaskBrief v2 (Etap 3): the artifact TYPE this task must produce (saved via artifact_put). Name it for every substantial deliverable.'),
      schema: z.string().optional().describe('Field-by-field spec or JSON schema of the expected output.'),
      example: z.string().optional().describe('A short example of a correct result.'),
    })
    .describe('Strict contract for the result. The caller relies on this to consume the output.'),

  /** Explicit boundaries — the single biggest lever against duplicated/over-scoped work. */
  scope: z
    .object({
      inScope: z.array(z.string()).default([]).describe('What the worker SHOULD do.'),
      outOfScope: z
        .array(z.string())
        .default([])
        .describe('What the worker MUST NOT do — prevents scope creep and duplication.'),
    })
    .optional()
    .describe('Task boundaries. Fill for multi-step or delegated work; omit for trivial one-shot tasks.'),

  /** Verifiable conditions the result must satisfy. Required — this is the quality gate. */
  successCriteria: z
    .array(z.string())
    .min(1)
    .describe('Checkable conditions the result must meet. At least one. This is the quality gate.'),

  constraints: z
    .object({
      language: z
        .string()
        .optional()
        .describe('Language of the DELIVERABLE (not this brief). e.g. "pl" for Polish copy, "en" for analysis.'),
      tone: z.string().optional(),
      maxLength: z.string().optional().describe('e.g. "under 200 words", "max 5 bullets".'),
      budgetUsd: z.number().optional().describe('TaskBrief v2: soft cost cap for this task (USD).'),
      deadline: z.string().optional().describe('TaskBrief v2: ISO date/time or relative ("2h") the result is needed by.'),
      avoid: z.array(z.string()).default([]).describe('Things to avoid: phrasings, placeholders, edge cases.'),
    })
    .default({ avoid: [] })
    .describe('Output constraints: language, tone, length, budget, deadline, what to avoid.'),

  /** TaskBrief v2 (Etap 3): correlation with the Task Ledger lane. */
  laneId: z.string().optional().describe('Task Ledger lane id for correlation (artifacts inherit it).'),

  /**
   * Optional durable domain correlation. Unlike free-form context, this is a
   * machine-readable binding used to issue provenance receipts for specialist
   * reviews (for example Writer critic/reader/polisher passes).
   */
  correlation: z.object({
    domain: z.string().min(1),
    entityId: z.string().min(1),
    action: z.string().min(1),
    subjectId: z.string().min(1).optional(),
    contractRevision: z.number().int().nonnegative().optional(),
    requestId: z.string().min(1).optional(),
  }).optional(),

  /** TaskBrief v2 (Etap 3, scheduled in Etap 5): resources this task will touch. */
  claims: z.array(z.string()).default([])
    .describe('Resource claims, e.g. "repo:src/mastra/agents/*", "n8n:workflow:<id>", "crm:write", "gmail:send", "gpu:local".'),

  /** Tools/sources the worker should reference (informational for text-only workers). */
  tools: z.array(z.string()).default([]).describe('Tools or sources the worker should use.'),

  /** Scales worker effort to task complexity. */
  effort: z
    .enum(['quick', 'medium', 'thorough'])
    .default('medium')
    .describe('How much depth the task warrants. Scale to complexity.'),
});

export type WorkerTaskSpec = z.infer<typeof workerTaskSpecSchema>;
export type WorkerTaskSpecInput = z.input<typeof workerTaskSpecSchema>;

/**
 * Receipt-bound Writer reviews authorize the exact taskSpec only. Reject any
 * outer run_worker fields that would append unreviewed instructions after the
 * prepared request hash was issued.
 */
export function writerReviewPromptModifierError(input: {
  taskSpec?: WorkerTaskSpecInput;
  skills?: string[];
  allowedTools?: string[];
  previousAttempt?: { output: string; criticism: string };
}): string | null {
  if (input.taskSpec?.correlation?.domain !== 'writer') return null;
  if (
    (input.skills?.length ?? 0) > 0
    || (input.allowedTools?.length ?? 0) > 0
    || input.previousAttempt !== undefined
  ) {
    return (
      'Prepared Writer reviews do not allow skills, allowedTools, or previousAttempt prompt modifiers. ' +
      'Put retry findings into a newly prepared exact taskSpec instead.'
    );
  }
  return null;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Render a WorkerTaskSpec into a deterministic English brief.
 *
 * Output follows the familiar GOAL / CONTEXT / INPUTS / ... block layout that the
 * existing prompt guidance already teaches, so small local models stay on familiar
 * ground. Empty sections are omitted to keep the prompt tight.
 *
 * Accepts the schema INPUT type and parses internally so Zod defaults (inputs,
 * constraints, effort, …) are always applied — the caller can pass the raw tool
 * argument without pre-parsing.
 */
export function renderWorkerBrief(input: WorkerTaskSpecInput): string {
  const spec = workerTaskSpecSchema.parse(input);
  const blocks: string[] = [];

  blocks.push(`GOAL: ${spec.goal}`);

  if (spec.context && spec.context.trim()) {
    blocks.push(`CONTEXT:\n${spec.context.trim()}`);
  }

  if (spec.inputs.length > 0) {
    const lines = spec.inputs.map((i) => {
      if (i.artifactId) {
        // Sync render fallback — the async renderWorkerBriefWithArtifacts
        // replaces this line with summary + ref before delegation.
        return `- ${i.name} (artifact): id ${i.artifactId} → fetch via artifact_get("${i.artifactId}")`;
      }
      return `- ${i.name} (${i.source}): ${renderValue(i.value)}`;
    });
    blocks.push(`INPUTS:\n${lines.join('\n')}`);
  }

  if (spec.scope && (spec.scope.inScope.length > 0 || spec.scope.outOfScope.length > 0)) {
    const parts: string[] = [];
    if (spec.scope.inScope.length > 0) {
      parts.push(`In scope:\n${spec.scope.inScope.map((s) => `  - ${s}`).join('\n')}`);
    }
    if (spec.scope.outOfScope.length > 0) {
      parts.push(`Out of scope (DO NOT do these):\n${spec.scope.outOfScope.map((s) => `  - ${s}`).join('\n')}`);
    }
    blocks.push(`SCOPE:\n${parts.join('\n')}`);
  }

  const outParts: string[] = [`Format: ${spec.outputContract.format}`];
  if (spec.outputContract.artifactType) {
    outParts.push(`Artifact type: ${spec.outputContract.artifactType} — save the deliverable via artifact_put and return the reference.`);
    // P3 (delegation-depth-hardening) — checkpoint rule: a run killed by
    // timeout must not take all its work with it. The live failure lost ~226s
    // of research because the single artifact_put was planned for the very end.
    outParts.push(
      `Checkpointing: after EACH completed research/build phase, persist partial results via artifact_put ` +
      `(type: "partial_${spec.outputContract.artifactType}"). Do NOT hold all results until the end — ` +
      `a timeout must never destroy finished work.`,
    );
  }
  if (spec.outputContract.schema) outParts.push(`Schema: ${spec.outputContract.schema}`);
  if (spec.outputContract.example) outParts.push(`Example: ${spec.outputContract.example}`);
  blocks.push(`OUTPUT:\n${outParts.map((p) => `  ${p}`).join('\n')}`);

  blocks.push(`SUCCESS CRITERIA:\n${spec.successCriteria.map((c) => `  - ${c}`).join('\n')}`);

  const c = spec.constraints;
  const conLines: string[] = [];
  if (c.language) conLines.push(`Language: ${c.language}`);
  if (c.tone) conLines.push(`Tone: ${c.tone}`);
  if (c.maxLength) conLines.push(`Max length: ${c.maxLength}`);
  if (c.budgetUsd !== undefined) conLines.push(`Budget: $${c.budgetUsd}`);
  if (c.deadline) conLines.push(`Deadline: ${c.deadline}`);
  if (c.avoid.length > 0) conLines.push(`Avoid: ${c.avoid.join('; ')}`);
  if (conLines.length > 0) {
    blocks.push(`CONSTRAINTS:\n${conLines.map((l) => `  ${l}`).join('\n')}`);
  }

  if (spec.tools.length > 0) {
    blocks.push(`TOOLS (use these): ${spec.tools.join(', ')}`);
  }

  blocks.push(`EFFORT: ${spec.effort}`);

  if (spec.laneId) blocks.push(`LANE: ${spec.laneId}`);
  if (spec.correlation) {
    blocks.push(
      `CORRELATION: domain=${spec.correlation.domain}; entity=${spec.correlation.entityId}; action=${spec.correlation.action}`,
    );
  }

  return blocks.join('\n\n');
}

/**
 * TaskBrief v2 (Etap 3): async renderer that resolves artifact-ref inputs to
 * `summary (≤300 chars) + id` lines via the Artifact Store. Full content NEVER
 * travels in the brief — the worker fetches it with artifact_get on demand.
 * Falls back to the sync renderer when no artifact inputs are present.
 */
export async function renderWorkerBriefWithArtifacts(input: WorkerTaskSpecInput): Promise<string> {
  const spec = workerTaskSpecSchema.parse(input);
  const artifactInputs = spec.inputs.filter((i) => i.artifactId);
  if (artifactInputs.length === 0) return renderWorkerBrief(input);

  const { renderArtifactRefsForBrief } = await import('../../services/artifact-store.js');
  const resolved = await renderArtifactRefsForBrief(
    artifactInputs.map((i) => ({ artifactId: i.artifactId!, name: i.name })),
  );

  let brief = renderWorkerBrief(input);
  artifactInputs.forEach((i, idx) => {
    const placeholder = `- ${i.name} (artifact): id ${i.artifactId} → fetch via artifact_get("${i.artifactId}")`;
    if (resolved[idx]) brief = brief.replace(placeholder, resolved[idx]!);
  });
  return brief;
}
