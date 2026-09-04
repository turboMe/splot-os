/**
 * Skill Distiller — the "success brain" (Etap 6, IDEALSYSTEMMASTERPLAN §5).
 *
 * The failure brain (error-collector / auto_healing_tickets) already learns
 * what to AVOID. This is its symmetric half: after a SUCCESSFUL task worth
 * remembering, a cheap model distills the trajectory into a reusable
 * `SKILL.md` — same format the existing skill-registry + skillSearchTool
 * already load, so zero loader changes.
 *
 * Pipeline (Hermes-Agent pattern):
 *   1. TRIGGER  — a done task with ≥5 tool calls, a recovery, or a user
 *      correction records a candidate (distillation_candidates).
 *   2. EXTRACT  — a cheap model turns the candidate into SKILL.md
 *      (secrets redacted). The model call is an INJECTABLE writer so tests are
 *      deterministic and the real path uses the local/cheap model.
 *   3. EVAL     — a mini-eval gates activation: valid frontmatter (name +
 *      description), non-trivial body, no residual secrets, parseable.
 *   4. ACTIVATE — pass → src/mastra/_skills/auto/<name>.md (registry picks it
 *      up on refresh); fail → _skills/quarantine/<name>.md (never searched).
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets, containsSecrets } from '../lib/secrets-redactor.js';
import { parseFrontmatter } from '../lib/yaml-frontmatter.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type DistillationTrigger = 'tool_calls' | 'recovery' | 'user_correction';

export type DistillationCandidate = {
  candidateId: string;
  taskId?: string;
  agentId?: string;
  goal: string;
  trigger: DistillationTrigger;
  toolCallCount?: number;
  lessons: string[];
  resultSummary?: string;
  status: 'pending' | 'distilled' | 'skipped' | 'failed';
  skillName?: string;
  createdAt: Date;
  processedAt?: Date;
};

export type DistilledSkill = {
  name: string;
  description: string;
  category: string;
  keywords: string[];
  body: string;
};

/** The model call is injected so tests are deterministic and the runtime path
 *  uses the cheap/local model. */
export type SkillWriter = (candidate: DistillationCandidate) => Promise<DistilledSkill>;

export type MiniEvalResult = { pass: boolean; reasons: string[] };

// ── Constants ────────────────────────────────────────────────────────────────

const CANDIDATES_COLLECTION = 'distillation_candidates';
const MIN_TOOL_CALLS = 5;
const AUTO_SKILLS_DIR = resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', '_skills', 'auto');
const QUARANTINE_DIR = resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', '_skills', 'quarantine');
const MIN_BODY_CHARS = 120;

export function isDistillationEnabled(): boolean {
  return isHarnessFeatureEnabled('FEATURE_SKILL_DISTILLATION', true);
}

/**
 * Compact skill-writing rubric distilled from the repo's `skill-creator` skill
 * (_skills/meta/skill-creator.md → "Skill Writing Guide"). Injected into the
 * distiller's writer prompt so the small local model follows a proven recipe
 * for GOOD skills instead of raw guessing — the weakest link of autonomous
 * distillation. Kept tight on purpose (local models have small context).
 */
export const SKILL_WRITING_RUBRIC = [
  'HOW TO WRITE A GOOD SKILL (follow this):',
  '- DESCRIPTION is the trigger: one sharp paragraph naming WHEN to use it, with concrete',
  '  trigger phrases the future agent would think ("when deploying an n8n webhook…", "after a',
  '  failed X…"). This is what gets matched — make it specific, not generic.',
  '- BODY uses the IMPERATIVE form ("Validate the nodes", not "You should validate"). Numbered',
  '  steps for the workflow, then a short "## Pitfalls" section with the traps you actually hit.',
  '- Explain WHY a step matters in one clause instead of shouting MUST — the model follows',
  '  reasons better than commands.',
  '- Generalize: capture the reusable procedure, not the one-off specifics of this exact run',
  '  (drop instance ids, concrete names, transient values).',
  '- Keep it tight and skimmable; a skill is a recipe, not a transcript. No fluff, no restating',
  '  the goal back.',
  '- NEVER include secrets, tokens, credentials, or private data.',
].join('\n');

// ── Trigger predicate ─────────────────────────────────────────────────────────

/**
 * Does this completed task deserve a distilled skill? (Hermes triggers.)
 */
export function shouldDistill(input: {
  toolCallCount?: number;
  recovered?: boolean;
  userCorrected?: boolean;
  lessons?: string[];
}): { distill: boolean; trigger?: DistillationTrigger } {
  if (input.userCorrected) return { distill: true, trigger: 'user_correction' };
  if (input.recovered) return { distill: true, trigger: 'recovery' };
  if ((input.toolCallCount ?? 0) >= MIN_TOOL_CALLS) return { distill: true, trigger: 'tool_calls' };
  return { distill: false };
}

// ── 1. Record candidate ───────────────────────────────────────────────────────

export async function recordDistillationCandidate(input: {
  taskId?: string;
  agentId?: string;
  goal: string;
  toolCallCount?: number;
  recovered?: boolean;
  userCorrected?: boolean;
  lessons?: string[];
  resultSummary?: string;
}): Promise<string | undefined> {
  if (!isDistillationEnabled()) return undefined;
  const decision = shouldDistill(input);
  if (!decision.distill) return undefined;

  try {
    const db = await getDb();
    const candidate: DistillationCandidate = {
      candidateId: `distill-${randomUUID()}`,
      taskId: input.taskId,
      agentId: input.agentId,
      goal: input.goal.slice(0, 500),
      trigger: decision.trigger!,
      toolCallCount: input.toolCallCount,
      lessons: (input.lessons ?? []).map((l) => redactSecrets(l).text).slice(0, 20),
      resultSummary: input.resultSummary ? redactSecrets(input.resultSummary).text.slice(0, 2000) : undefined,
      status: 'pending',
      createdAt: new Date(),
    };
    await db.collection<DistillationCandidate>(CANDIDATES_COLLECTION).insertOne(candidate);
    return candidate.candidateId;
  } catch (err) {
    console.warn('[SkillDistiller] recordCandidate failed:', (err as Error).message);
    return undefined;
  }
}

export async function listPendingCandidates(limit = 20): Promise<DistillationCandidate[]> {
  const db = await getDb();
  return db.collection<DistillationCandidate>(CANDIDATES_COLLECTION)
    .find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}

// ── 3. Mini-eval ───────────────────────────────────────────────────────────────

/**
 * Gate a distilled skill before activation. A skill that fails is quarantined,
 * never searched — this is the guard against garbage/leaky skills.
 */
export function miniEvalSkill(skill: DistilledSkill): MiniEvalResult {
  const reasons: string[] = [];
  if (!skill.name || !/^[a-z0-9][a-z0-9-]{2,}$/.test(skill.name)) {
    reasons.push('invalid name (kebab-case, ≥3 chars required)');
  }
  if (!skill.description || skill.description.trim().length < 20) {
    reasons.push('description too short (≥20 chars)');
  }
  if (!skill.body || skill.body.trim().length < MIN_BODY_CHARS) {
    reasons.push(`body too short (≥${MIN_BODY_CHARS} chars)`);
  }
  if (containsSecrets(`${skill.description}\n${skill.body}\n${skill.keywords.join(' ')}`)) {
    reasons.push('residual secrets detected');
  }
  // Must not be a trivial restatement — require at least one step-like line.
  if (skill.body && !/\n\s*(?:[-*\d.]|#)/.test(skill.body)) {
    reasons.push('body has no steps/structure');
  }
  return { pass: reasons.length === 0, reasons };
}

// ── SKILL.md rendering ─────────────────────────────────────────────────────────

export function renderSkillMarkdown(skill: DistilledSkill, meta: { candidateId: string; trigger: string }): string {
  const safe = {
    name: skill.name,
    description: redactSecrets(skill.description).text,
    body: redactSecrets(skill.body).text,
    keywords: skill.keywords.map((k) => redactSecrets(k).text),
  };
  const frontmatter = [
    '---',
    `name: ${safe.name}`,
    `category: ${skill.category || 'auto'}`,
    `description: >-`,
    `  ${safe.description.replace(/\n/g, ' ').trim()}`,
    `keywords: [${safe.keywords.join(', ')}]`,
    `tags: [auto-distilled, ${skill.category || 'auto'}]`,
    `version: 1`,
    `success_rate: null`,
    `total_uses: 0`,
    `last_used: null`,
    `author: skill-distiller`,
    `source_candidate: ${meta.candidateId}`,
    `distill_trigger: ${meta.trigger}`,
    '---',
    '',
    safe.body.trim(),
    '',
  ].join('\n');
  return frontmatter;
}

// ── 2+4. Distill + evaluate + activate ─────────────────────────────────────────

export async function distillCandidate(
  candidate: DistillationCandidate,
  writer: SkillWriter,
): Promise<{ activated: boolean; skillName?: string; filePath?: string; eval: MiniEvalResult }> {
  const skill = await writer(candidate);
  const evalResult = miniEvalSkill(skill);
  const markdown = renderSkillMarkdown(skill, { candidateId: candidate.candidateId, trigger: candidate.trigger });

  const dir = evalResult.pass ? AUTO_SKILLS_DIR : QUARANTINE_DIR;
  await mkdir(dir, { recursive: true });
  const filePath = resolve(dir, `${skill.name}.md`);
  await writeFile(filePath, markdown, 'utf8');

  // Sanity: the file we wrote must parse back into valid frontmatter.
  try {
    const written = await readFile(filePath, 'utf8');
    const { metadata } = parseFrontmatter(written);
    if (!metadata.name || !metadata.description) {
      evalResult.pass = false;
      evalResult.reasons.push('written file failed frontmatter re-parse');
    }
  } catch {
    evalResult.pass = false;
    evalResult.reasons.push('written file unreadable');
  }

  await markCandidateProcessed(candidate.candidateId, evalResult.pass ? 'distilled' : 'failed', skill.name);
  return { activated: evalResult.pass, skillName: skill.name, filePath, eval: evalResult };
}

async function markCandidateProcessed(
  candidateId: string,
  status: DistillationCandidate['status'],
  skillName?: string,
): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<DistillationCandidate>(CANDIDATES_COLLECTION).updateOne(
      { candidateId },
      { $set: { status, skillName, processedAt: new Date() } },
    );
  } catch { /* fail-safe */ }
}

// ── Runtime writer (cheap/local model) ─────────────────────────────────────────

/**
 * The default writer used by the nightly cycle: a cheap/local model turns the
 * candidate into a SKILL.md. Kept separate from distillCandidate so tests
 * inject a deterministic writer instead.
 */
export function buildModelSkillWriter(generate: (prompt: string) => Promise<string>): SkillWriter {
  return async (candidate: DistillationCandidate): Promise<DistilledSkill> => {
    const prompt = [
      'You are the skill distiller. Turn this SUCCESSFUL task trajectory into a reusable SKILL',
      'that a future agent can follow to do the same kind of task faster.',
      '',
      SKILL_WRITING_RUBRIC,
      '',
      'Output STRICT JSON ONLY (no prose around it):',
      '{ "name": kebab-case-id, "description": "one paragraph WITH trigger phrases",',
      '  "category": short-slug, "keywords": ["..."], "body": "markdown: ## Steps (numbered, imperative) + ## Pitfalls" }',
      '',
      `GOAL: ${candidate.goal}`,
      `TRIGGER: ${candidate.trigger} (${candidate.toolCallCount ?? 0} tool calls)`,
      candidate.lessons.length ? `LESSONS:\n${candidate.lessons.map((l) => `- ${l}`).join('\n')}` : '',
      candidate.resultSummary ? `RESULT SUMMARY:\n${candidate.resultSummary}` : '',
    ].filter(Boolean).join('\n');

    const raw = await generate(prompt);
    const json = extractJson(raw);
    return {
      name: String(json.name ?? `auto-skill-${candidate.candidateId.slice(-8)}`).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      description: String(json.description ?? candidate.goal),
      category: String(json.category ?? candidate.agentId ?? 'auto').toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      keywords: Array.isArray(json.keywords) ? json.keywords.map(String) : [],
      body: String(json.body ?? ''),
    };
  };
}

/**
 * Process pending candidates into skills. `generate` is injected (the nightly
 * cron passes a local-model Agent; tests pass a deterministic function).
 */
export async function runDistillationCycle(
  generate: (prompt: string) => Promise<string>,
  opts: { limit?: number } = {},
): Promise<{ processed: number; activated: number; quarantined: number; skills: string[] }> {
  if (!isDistillationEnabled()) return { processed: 0, activated: 0, quarantined: 0, skills: [] };
  const candidates = await listPendingCandidates(opts.limit ?? 20);
  const writer = buildModelSkillWriter(generate);
  let activated = 0;
  let quarantined = 0;
  const skills: string[] = [];
  for (const candidate of candidates) {
    try {
      const res = await distillCandidate(candidate, writer);
      if (res.activated) { activated += 1; if (res.skillName) skills.push(res.skillName); }
      else quarantined += 1;
    } catch (err) {
      console.warn('[SkillDistiller] cycle item failed:', (err as Error).message);
      await markCandidateProcessed(candidate.candidateId, 'failed');
    }
  }
  return { processed: candidates.length, activated, quarantined, skills };
}

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return {};
  }
}

export { AUTO_SKILLS_DIR, QUARANTINE_DIR, CANDIDATES_COLLECTION };
