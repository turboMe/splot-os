import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { getDb } from '../../lib/mongo.js';
import {
  filmClipSchema,
  filmGenerationRunSchema,
  filmPromptSpecSchema,
  filmReferenceSchema,
  filmTakeReviewSchema,
  type FilmBeat,
  type FilmClip,
  type FilmGenerationRun,
  type FilmPromptSpec,
  type FilmProjectState,
  type FilmReference,
  type FilmTakeReview,
} from '../../lib/film-schemas.js';

export const FILM_PIPELINE_STATUSES = [
  'intake',
  'source_gate',
  'mode_select',
  'reference_map',
  'prompt_build',
  'generate',
  'take_review',
  'repair',
  'deliver',
  'done',
] as const;
export type FilmPipelineStatus = typeof FILM_PIPELINE_STATUSES[number];

export interface FilmProjectRecord {
  id: string;
  name: string;
  status: FilmPipelineStatus;
  state: FilmProjectState;
  paidGenerationApproved: boolean;
  approvalToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StartFilmProjectInput {
  projectId?: string;
  name: string;
  projectMode: FilmProjectState['project_mode'];
  storyObjective: string;
  logline?: string;
  storyPromise?: string;
  initialCondition?: string;
  finalOutcome?: string;
  targetDurationSec?: number | null;
  tone?: string;
  medium?: string;
  surface?: Record<string, unknown>;
  clipBudgetSec?: number | null;
  promptBudget?: number | null;
}

export interface UpsertFilmClipInput {
  projectId: string;
  clipId?: string;
  parentClipId?: string | null;
  sequenceIndex?: number;
  promptVersion?: string;
  generationMode?: string;
  sourceClipTag?: string | null;
  status?: FilmClip['status'];
  narrativeJob: string;
  alreadyHappened?: string[];
  thisClipOnly?: string[];
  reservedForLater?: string[];
  plannedStartState?: Record<string, unknown>;
  plannedEndState?: Record<string, unknown>;
  observedStartState?: Record<string, unknown> | null;
  observedEndState?: Record<string, unknown> | null;
  continuityLocks?: unknown[];
  allowedChanges?: unknown[];
  continuityBreaks?: unknown[];
  acceptedDeviations?: unknown[];
  transitionIn?: string;
  transitionOut?: string;
  openMotionVectors?: unknown[];
  handoffRequirements?: unknown[];
  extensionDepth?: number;
  referenceRoles?: unknown[];
}

export interface CompilePromptSpecInput {
  projectId: string;
  clipId: string;
  sequenceRelation?: FilmPromptSpec['sequence_relation'];
  openingStateSource?: FilmPromptSpec['opening_state_source'];
  currentClipAction?: string;
  endpoint?: string;
  naturalLanguagePrompt?: string;
  referenceRoles?: unknown[];
}

export async function ensureFilmIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('film_projects').createIndex({ id: 1 }, { unique: true }),
    db.collection('film_projects').createIndex({ status: 1 }),
    db.collection('film_projects').createIndex({ updatedAt: -1 }),
    db.collection('film_generation_runs').createIndex({ run_id: 1 }, { unique: true }),
    db.collection('film_generation_runs').createIndex({ project_id: 1, clip_id: 1 }),
    db.collection('film_generation_runs').createIndex({ created_at: -1 }),
  ]);
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultBeatFromClip(clipId: string, narrativeJob: string): FilmBeat {
  return {
    beat_id: `${clipId}-beat-1`,
    description: narrativeJob,
    narrative_function: 'current clip narrative job',
    status: 'current',
    assigned_clip_id: clipId,
    dependencies: [],
  };
}

function defaultFilmClip(input: UpsertFilmClipInput, existing?: FilmClip): FilmClip {
  const clipId = input.clipId ?? existing?.clip_id ?? `clip-${randomUUID().slice(0, 8)}`;
  return filmClipSchema.parse({
    clip_id: clipId,
    parent_clip_id: input.parentClipId ?? existing?.parent_clip_id ?? null,
    sequence_index: input.sequenceIndex ?? existing?.sequence_index ?? 1,
    prompt_version: input.promptVersion ?? existing?.prompt_version ?? 'v1',
    generation_mode: input.generationMode ?? existing?.generation_mode ?? 'T2V',
    source_clip_tag: input.sourceClipTag ?? existing?.source_clip_tag ?? null,
    status: input.status ?? existing?.status ?? 'planned',
    narrative_job: input.narrativeJob ?? existing?.narrative_job ?? '',
    already_happened: input.alreadyHappened ?? existing?.already_happened ?? [],
    this_clip_only: input.thisClipOnly ?? existing?.this_clip_only ?? [],
    reserved_for_later: input.reservedForLater ?? existing?.reserved_for_later ?? [],
    planned_start_state: input.plannedStartState ?? existing?.planned_start_state ?? {},
    planned_end_state: input.plannedEndState ?? existing?.planned_end_state ?? {},
    observed_start_state: input.observedStartState ?? existing?.observed_start_state ?? null,
    observed_end_state: input.observedEndState ?? existing?.observed_end_state ?? null,
    continuity_locks: input.continuityLocks ?? existing?.continuity_locks ?? [],
    allowed_changes: input.allowedChanges ?? existing?.allowed_changes ?? [],
    continuity_breaks: input.continuityBreaks ?? existing?.continuity_breaks ?? [],
    accepted_deviations: input.acceptedDeviations ?? existing?.accepted_deviations ?? [],
    transition_in: input.transitionIn ?? existing?.transition_in ?? '',
    transition_out: input.transitionOut ?? existing?.transition_out ?? '',
    open_motion_vectors: input.openMotionVectors ?? existing?.open_motion_vectors ?? [],
    handoff_requirements: input.handoffRequirements ?? existing?.handoff_requirements ?? [],
    extension_depth: input.extensionDepth ?? existing?.extension_depth ?? 0,
  });
}

/**
 * Parse caller-supplied reference roles into validated registry entries and merge
 * them into the existing registry by tag (last write wins). The `preserve_exact_tag`
 * invariant is enforced by defaulting it to true when the caller omits it — the tag
 * must survive unchanged across clips, so a reference always carries the flag.
 */
function mergeReferenceRegistry(
  existing: FilmReference[],
  incoming: unknown[] | undefined,
): FilmReference[] {
  if (!incoming || incoming.length === 0) return existing;
  const byTag = new Map<string, FilmReference>(existing.map((ref) => [ref.tag, ref]));
  for (const raw of incoming) {
    const candidate = (raw && typeof raw === 'object')
      ? { preserve_exact_tag: true as const, ...(raw as Record<string, unknown>) }
      : raw;
    const parsed = filmReferenceSchema.parse(candidate);
    byTag.set(parsed.tag, parsed);
  }
  return [...byTag.values()];
}

function buildProjectState(input: StartFilmProjectInput): FilmProjectState {
  const projectId = input.projectId ?? `film-${randomUUID()}`;
  const firstClipId = 'clip-01';
  const firstClip = defaultFilmClip({
    projectId,
    clipId: firstClipId,
    sequenceIndex: 1,
    promptVersion: 'v1',
    generationMode: 'T2V',
    status: 'planned',
    narrativeJob: input.storyObjective,
    plannedStartState: { description: input.initialCondition ?? input.storyObjective },
    plannedEndState: { description: input.finalOutcome ?? '' },
  });

  return {
    schema_version: '1.0.0',
    state_revision: 1,
    project_id: projectId,
    project_mode: input.projectMode,
    surface: input.surface ?? { provider: 'seedance', surface: 'fal' },
    clip_budget_sec: input.clipBudgetSec ?? null,
    prompt_budget: input.promptBudget ?? null,
    story: {
      logline: input.logline ?? input.name,
      story_promise: input.storyPromise ?? input.storyObjective,
      objective: input.storyObjective,
      initial_condition: input.initialCondition ?? input.storyObjective,
      final_outcome: input.finalOutcome ?? '',
      target_duration_sec: input.targetDurationSec ?? null,
      tone: input.tone ?? 'cinematic',
      medium: input.medium ?? 'video',
    },
    world_bible: {},
    reference_registry: [],
    beats: [defaultBeatFromClip(firstClipId, input.storyObjective)],
    clips: [firstClip],
    take_history: [],
    current_clip_id: firstClipId,
    canon_revision: 1,
    updated_at: nowIso(),
  };
}

function generationModeForPrompt(mode: string): FilmPromptSpec['generation_mode'] {
  return mode as FilmPromptSpec['generation_mode'];
}

function defaultNaturalLanguagePrompt(project: FilmProjectRecord, clip: FilmClip): string {
  const already = clip.already_happened.length
    ? `Do not replay completed beats: ${clip.already_happened.join('; ')}. `
    : '';
  const reserved = clip.reserved_for_later.length
    ? `Do not include reserved future beats: ${clip.reserved_for_later.join('; ')}. `
    : '';
  const continuity = clip.continuity_locks.length
    ? `Preserve continuity locks exactly: ${JSON.stringify(clip.continuity_locks)}. `
    : '';
  return [
    project.state.story.tone,
    'Seedance video prompt.',
    `Current clip job: ${clip.narrative_job}.`,
    `Start from: ${JSON.stringify(clip.planned_start_state)}.`,
    `End at: ${JSON.stringify(clip.planned_end_state)}.`,
    already,
    reserved,
    continuity,
    'Use visible action, physical camera language, and concise natural language. Do not output JSON.',
  ].filter(Boolean).join(' ');
}

export class FilmService {
  private async db(): Promise<Db> {
    const db = await getDb();
    await ensureFilmIndexes(db);
    return db;
  }

  async startProject(input: StartFilmProjectInput): Promise<FilmProjectRecord> {
    const db = await this.db();
    const state = buildProjectState(input);
    const now = new Date();
    const record: FilmProjectRecord = {
      id: state.project_id,
      name: input.name,
      status: 'intake',
      state,
      paidGenerationApproved: false,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection<FilmProjectRecord>('film_projects').insertOne(record);
    return record;
  }

  async getProject(projectId: string): Promise<FilmProjectRecord | null> {
    const db = await this.db();
    return db.collection<FilmProjectRecord>('film_projects').findOne({ id: projectId });
  }

  async listProjects(filter: { status?: FilmPipelineStatus } = {}, limit = 20): Promise<FilmProjectRecord[]> {
    const db = await this.db();
    return db.collection<FilmProjectRecord>('film_projects')
      .find(filter.status ? { status: filter.status } : {})
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async setProjectStatus(projectId: string, status: FilmPipelineStatus): Promise<FilmProjectRecord> {
    const db = await this.db();
    await db.collection<FilmProjectRecord>('film_projects').updateOne(
      { id: projectId },
      { $set: { status, updatedAt: new Date(), 'state.updated_at': nowIso() } },
    );
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`Film project not found: ${projectId}`);
    return project;
  }

  async upsertClip(input: UpsertFilmClipInput): Promise<{ project: FilmProjectRecord; clip: FilmClip }> {
    const project = await this.getProject(input.projectId);
    if (!project) throw new Error(`Film project not found: ${input.projectId}`);

    const existingIndex = project.state.clips.findIndex((clip) => clip.clip_id === input.clipId);
    const existing = existingIndex >= 0 ? project.state.clips[existingIndex] : undefined;
    const clip = defaultFilmClip(input, existing);
    const clips = [...project.state.clips];
    if (existingIndex >= 0) clips[existingIndex] = clip;
    else clips.push(clip);

    const beats = project.state.beats.some((beat) => beat.assigned_clip_id === clip.clip_id)
      ? project.state.beats
      : [...project.state.beats, defaultBeatFromClip(clip.clip_id, clip.narrative_job)];

    const reference_registry = mergeReferenceRegistry(project.state.reference_registry, input.referenceRoles);

    const state: FilmProjectState = {
      ...project.state,
      clips,
      beats,
      reference_registry,
      current_clip_id: clip.clip_id,
      state_revision: project.state.state_revision + 1,
      updated_at: nowIso(),
    };

    const db = await this.db();
    await db.collection<FilmProjectRecord>('film_projects').updateOne(
      { id: input.projectId },
      { $set: { state, updatedAt: new Date() } },
    );
    const updated = await this.getProject(input.projectId);
    if (!updated) throw new Error(`Film project not found after update: ${input.projectId}`);
    return { project: updated, clip };
  }

  async recordTake(reviewInput: FilmTakeReview): Promise<{ project: FilmProjectRecord; review: FilmTakeReview }> {
    const review = filmTakeReviewSchema.parse(reviewInput);
    const project = await this.getProject(review.project_id);
    if (!project) throw new Error(`Film project not found: ${review.project_id}`);

    const clips = project.state.clips.map((clip) => {
      if (clip.clip_id !== review.clip_id) return clip;
      const accepted = review.verdict === 'accept' || review.verdict === 'accept_with_deviation';
      const nextStatus: FilmClip['status'] =
        review.verdict === 'accept'
          ? 'accepted'
          : review.verdict === 'accept_with_deviation'
            ? 'accepted_with_deviation'
            : review.verdict === 'repair'
              ? 'repair'
              : 'rejected';
      return {
        ...clip,
        status: nextStatus,
        observed_start_state: review.observed_start_state,
        observed_end_state: accepted ? review.observed_end_state : null,
        continuity_breaks: review.continuity_breaks,
        accepted_deviations: accepted ? review.accepted_deviations : [],
      };
    });

    const beats = project.state.beats.map((beat) => {
      if (review.completed_beats.includes(beat.beat_id)) return { ...beat, status: 'completed' as const };
      if (review.unexpected_completed_beats.includes(beat.beat_id)) return { ...beat, status: 'completed' as const };
      return beat;
    });

    const accepted = review.verdict === 'accept' || review.verdict === 'accept_with_deviation';
    const state: FilmProjectState = {
      ...project.state,
      clips,
      beats,
      take_history: [...project.state.take_history, review],
      canon_revision: accepted ? project.state.canon_revision + 1 : project.state.canon_revision,
      state_revision: project.state.state_revision + 1,
      updated_at: nowIso(),
    };

    const db = await this.db();
    await db.collection<FilmProjectRecord>('film_projects').updateOne(
      { id: review.project_id },
      { $set: { state, updatedAt: new Date() } },
    );
    const updated = await this.getProject(review.project_id);
    if (!updated) throw new Error(`Film project not found after take review: ${review.project_id}`);
    return { project: updated, review };
  }

  async getCanon(projectId: string): Promise<{
    projectId: string;
    canonRevision: number;
    acceptedClips: FilmClip[];
    lastAcceptedClip: FilmClip | null;
    referenceRegistry: FilmProjectState['reference_registry'];
  }> {
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`Film project not found: ${projectId}`);
    const acceptedClips = project.state.clips
      .filter((clip) => clip.status === 'accepted' || clip.status === 'accepted_with_deviation')
      .sort((a, b) => a.sequence_index - b.sequence_index);
    return {
      projectId,
      canonRevision: project.state.canon_revision,
      acceptedClips,
      lastAcceptedClip: acceptedClips.at(-1) ?? null,
      referenceRegistry: project.state.reference_registry,
    };
  }

  async compilePromptSpec(input: CompilePromptSpecInput): Promise<{
    project: FilmProjectRecord;
    clip: FilmClip;
    spec: FilmPromptSpec;
    markdown: string;
  }> {
    const project = await this.getProject(input.projectId);
    if (!project) throw new Error(`Film project not found: ${input.projectId}`);
    const clip = project.state.clips.find((item) => item.clip_id === input.clipId);
    if (!clip) throw new Error(`Film clip not found: ${input.clipId}`);

    const spec = filmPromptSpecSchema.parse({
      project_id: project.id,
      clip_id: clip.clip_id,
      prompt_version: clip.prompt_version,
      sequence_relation: input.sequenceRelation ?? (clip.sequence_index === 1 ? 'sequence_first_clip' : 'seamless_continuation'),
      generation_mode: generationModeForPrompt(String(clip.generation_mode)),
      reference_roles: input.referenceRoles ?? project.state.reference_registry,
      opening_state_source: input.openingStateSource ?? (clip.sequence_index === 1 ? 'planned_start_state' : 'observed_end_state'),
      current_clip_action: input.currentClipAction ?? clip.narrative_job,
      endpoint: input.endpoint ?? JSON.stringify(clip.planned_end_state),
      completed_beat_exclusions: clip.already_happened,
      reserved_future_exclusions: clip.reserved_for_later,
      natural_language_prompt: input.naturalLanguagePrompt ?? defaultNaturalLanguagePrompt(project, clip),
    });

    const markdown = [
      '## Source Brief',
      project.state.story.objective,
      '',
      '## Internal Prompt Specification',
      '```json',
      JSON.stringify(spec, null, 2),
      '```',
      '',
      '## Compiled Natural-Language Prompt',
      spec.natural_language_prompt,
      '',
      '## Lint Result',
      'lint: pending',
      '',
      '## Control-Critical Sentences',
      'why this remains: it preserves current clip action, continuity, completed beat exclusions, and reserved future exclusions.',
      '',
    ].join('\n');

    return { project, clip, spec, markdown };
  }

  async appendGenerationRun(runInput: FilmGenerationRun): Promise<FilmGenerationRun> {
    const run = filmGenerationRunSchema.parse(runInput);
    const { created_at: createdAt, ...updatableRun } = run;
    const db = await this.db();
    await db.collection<FilmGenerationRun>('film_generation_runs').updateOne(
      { run_id: run.run_id },
      {
        $set: { ...updatableRun, updated_at: nowIso() },
        $setOnInsert: { created_at: createdAt ?? nowIso() },
      },
      { upsert: true },
    );
    return run;
  }

  async listGenerationRuns(projectId: string, limit = 20): Promise<FilmGenerationRun[]> {
    const db = await this.db();
    return db.collection<FilmGenerationRun>('film_generation_runs')
      .find({ project_id: projectId })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Count paid generation attempts already recorded for a project (optionally a
   * single clip). film_generate only writes a generation-run row once it is
   * committed to a remote/paid call, so this count is the number of paid attempts
   * — the basis for the env-configurable spend cap that stops repair/retry loops
   * (a content-policy rejection re-submitting the same clip forever). Enforced in
   * the tool, so it protects every caller (meta, filmmaker, workers) identically.
   */
  async countGenerationAttempts(projectId: string, clipId?: string): Promise<number> {
    const db = await this.db();
    const filter: Record<string, unknown> = { project_id: projectId };
    if (clipId) filter.clip_id = clipId;
    return db.collection<FilmGenerationRun>('film_generation_runs').countDocuments(filter);
  }

  /**
   * Resolve the live status of an approval token WITHOUT throwing. film_generate
   * uses this to tell apart three terminal cases (pending vs denied/missing vs
   * approved) instead of collapsing them into one "Invalid or unapproved" throw.
   * Collapsing them is what drove the approval-retry loop: a still-pending token
   * threw, the throw was logged as a 'rejected' run, and the models read 'rejected'
   * as retryable → mint a new token → repeat.
   */
  async getApprovalStatus(approvalToken: string): Promise<'approved' | 'pending' | 'denied' | 'missing'> {
    const db = await this.db();
    const approval = await db.collection('approvals').findOne({ id: approvalToken });
    if (!approval) return 'missing';
    if (approval.status === 'approved') return 'approved';
    if (approval.status === 'pending') return 'pending';
    return 'denied';
  }

  async approvePaidGeneration(projectId: string, approvalToken: string): Promise<void> {
    const db = await this.db();
    const approval = await db.collection('approvals').findOne({ id: approvalToken });
    if (!approval || approval.status !== 'approved') {
      throw new Error(`Invalid or unapproved approvalToken: ${approvalToken}`);
    }
    await db.collection<FilmProjectRecord>('film_projects').updateOne(
      { id: projectId },
      {
        $set: {
          paidGenerationApproved: true,
          approvalToken,
          updatedAt: new Date(),
        },
      },
    );
  }
}
