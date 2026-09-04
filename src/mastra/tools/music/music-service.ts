import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { getDb } from '../../lib/mongo.js';
import {
  musicGenerationRunSchema,
  musicLyricsDraftSchema,
  musicPromptSpecSchema,
  musicStyleDraftSchema,
  musicTakeReviewSchema,
  musicTrackSchema,
  type MusicBrief,
  type MusicGenerationRun,
  type MusicLyricsDraft,
  type MusicProjectState,
  type MusicPromptSpec,
  type MusicStyleDraft,
  type MusicTakeReview,
  type MusicTrack,
} from '../../lib/music-schemas.js';

export const MUSIC_PIPELINE_STATUSES = [
  'intake',
  'brief',
  'source_gate',
  'lyric_write',
  'style_compile',
  'safety_gate',
  'generate',
  'review',
  'repair',
  'deliver',
  'done',
] as const;
export type MusicPipelineStatus = typeof MUSIC_PIPELINE_STATUSES[number];

export interface MusicProjectRecord {
  id: string;
  name: string;
  status: MusicPipelineStatus;
  state: MusicProjectState;
  paidGenerationApproved: boolean;
  approvalToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StartMusicProjectInput {
  projectId?: string;
  name: string;
  projectMode?: MusicProjectState['project_mode'];
  objective: string;
  genres?: string[];
  mood?: string;
  bpm?: number | null;
  language?: string;
  vocalType?: MusicBrief['vocal_type'];
  structure?: string[];
  targetLengthMs?: number | null;
  surface?: Record<string, unknown>;
  promptBudget?: number | null;
}

export interface SetBriefInput {
  projectId: string;
  trackId?: string;
  objective?: string;
  genres?: string[];
  mood?: string;
  bpm?: number | null;
  language?: string;
  vocalType?: MusicBrief['vocal_type'];
  structure?: string[];
  targetLengthMs?: number | null;
  references?: unknown[];
  title?: string;
  generationMode?: string;
}

export interface WriteLyricsInput {
  projectId: string;
  trackId?: string;
  version?: string;
  language?: string;
  structure?: string[];
  text: string;
  notes?: string;
}

export interface CompilePromptSpecInput {
  projectId: string;
  trackId: string;
  stylePrompt?: string;
  tags?: string[];
  lyricsVersion?: string;
  styleVersion?: string;
  lengthMs?: number | null;
  outputFormat?: string;
  referenceAudio?: unknown[];
}

export interface UpsertTrackInput {
  projectId: string;
  trackId?: string;
  title?: string;
  status?: MusicTrack['status'];
  generationMode?: string;
  objective?: string;
  genres?: string[];
  mood?: string;
  bpm?: number | null;
  language?: string;
  vocalType?: MusicBrief['vocal_type'];
  structure?: string[];
  targetLengthMs?: number | null;
}

export async function ensureMusicIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('music_projects').createIndex({ id: 1 }, { unique: true }),
    db.collection('music_projects').createIndex({ status: 1 }),
    db.collection('music_projects').createIndex({ updatedAt: -1 }),
    db.collection('music_generation_runs').createIndex({ run_id: 1 }, { unique: true }),
    db.collection('music_generation_runs').createIndex({ project_id: 1, track_id: 1 }),
    db.collection('music_generation_runs').createIndex({ created_at: -1 }),
  ]);
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultBrief(input: StartMusicProjectInput | UpsertTrackInput): MusicBrief {
  return {
    objective: input.objective ?? '',
    genres: input.genres ?? [],
    mood: input.mood ?? '',
    bpm: input.bpm ?? null,
    language: input.language ?? 'en',
    vocal_type: input.vocalType ?? 'any',
    structure: input.structure ?? [],
    target_length_ms: input.targetLengthMs ?? null,
    references: [],
  };
}

function defaultTrack(input: StartMusicProjectInput | UpsertTrackInput, trackId: string): MusicTrack {
  const title =
    ('title' in input && input.title) ||
    ('name' in input && input.name) ||
    'Untitled';
  const generationMode = ('generationMode' in input && input.generationMode) || 'lyrics2song';
  return musicTrackSchema.parse({
    track_id: trackId,
    title,
    status: 'planned',
    generation_mode: generationMode,
    brief: defaultBrief(input),
    lyrics_drafts: [],
    style_drafts: [],
    accepted_lyrics_version: null,
    accepted_style_version: null,
    accepted_audio_path: null,
  });
}

function buildProjectState(input: StartMusicProjectInput): MusicProjectState {
  const projectId = input.projectId ?? `music-${randomUUID()}`;
  const firstTrackId = 'track-01';
  const firstTrack = defaultTrack(input, firstTrackId);
  return {
    schema_version: '1.0.0',
    state_revision: 1,
    project_id: projectId,
    project_mode: input.projectMode ?? 'single_track',
    surface: input.surface ?? { provider: 'fal', surface: 'fal' },
    prompt_budget: input.promptBudget ?? null,
    tracks: [firstTrack],
    take_history: [],
    current_track_id: firstTrackId,
    updated_at: nowIso(),
  };
}

function nextVersion(existing: { version: string }[]): string {
  return `v${existing.length + 1}`;
}

function defaultStylePrompt(track: MusicTrack): string {
  const b = track.brief;
  return [
    b.genres.length ? `Genre: ${b.genres.join(', ')}.` : '',
    b.mood ? `Mood: ${b.mood}.` : '',
    typeof b.bpm === 'number' ? `Tempo: ${b.bpm} BPM.` : '',
    b.vocal_type && b.vocal_type !== 'any' ? `Vocals: ${b.vocal_type}.` : '',
    b.structure.length ? `Structure: ${b.structure.join(' / ')}.` : '',
    'Clean professional production. Do not output JSON.',
  ].filter(Boolean).join(' ');
}

export class MusicService {
  private async db(): Promise<Db> {
    const db = await getDb();
    await ensureMusicIndexes(db);
    return db;
  }

  async startProject(input: StartMusicProjectInput): Promise<MusicProjectRecord> {
    const db = await this.db();
    const state = buildProjectState(input);
    const now = new Date();
    const record: MusicProjectRecord = {
      id: state.project_id,
      name: input.name,
      status: 'intake',
      state,
      paidGenerationApproved: false,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection<MusicProjectRecord>('music_projects').insertOne(record);
    return record;
  }

  async getProject(projectId: string): Promise<MusicProjectRecord | null> {
    const db = await this.db();
    return db.collection<MusicProjectRecord>('music_projects').findOne({ id: projectId });
  }

  async listProjects(filter: { status?: MusicPipelineStatus } = {}, limit = 20): Promise<MusicProjectRecord[]> {
    const db = await this.db();
    return db.collection<MusicProjectRecord>('music_projects')
      .find(filter.status ? { status: filter.status } : {})
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async setProjectStatus(projectId: string, status: MusicPipelineStatus): Promise<MusicProjectRecord> {
    const db = await this.db();
    await db.collection<MusicProjectRecord>('music_projects').updateOne(
      { id: projectId },
      { $set: { status, updatedAt: new Date(), 'state.updated_at': nowIso() } },
    );
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`Music project not found: ${projectId}`);
    return project;
  }

  private async writeState(projectId: string, state: MusicProjectState): Promise<MusicProjectRecord> {
    const db = await this.db();
    await db.collection<MusicProjectRecord>('music_projects').updateOne(
      { id: projectId },
      { $set: { state, updatedAt: new Date() } },
    );
    const updated = await this.getProject(projectId);
    if (!updated) throw new Error(`Music project not found after update: ${projectId}`);
    return updated;
  }

  private resolveTrack(project: MusicProjectRecord, trackId?: string): { track: MusicTrack; index: number } {
    const id = trackId ?? project.state.current_track_id;
    const index = project.state.tracks.findIndex((t) => t.track_id === id);
    if (index < 0) throw new Error(`Music track not found: ${id}`);
    return { track: project.state.tracks[index], index };
  }

  async setBrief(input: SetBriefInput): Promise<{ project: MusicProjectRecord; track: MusicTrack }> {
    const project = await this.getProject(input.projectId);
    if (!project) throw new Error(`Music project not found: ${input.projectId}`);
    const { track, index } = this.resolveTrack(project, input.trackId);

    const references = input.references
      ? musicTrackSchema.shape.brief.shape.references.parse(input.references)
      : track.brief.references;

    const updatedTrack: MusicTrack = musicTrackSchema.parse({
      ...track,
      title: input.title ?? track.title,
      generation_mode: input.generationMode ?? track.generation_mode,
      brief: {
        objective: input.objective ?? track.brief.objective,
        genres: input.genres ?? track.brief.genres,
        mood: input.mood ?? track.brief.mood,
        bpm: input.bpm ?? track.brief.bpm,
        language: input.language ?? track.brief.language,
        vocal_type: input.vocalType ?? track.brief.vocal_type,
        structure: input.structure ?? track.brief.structure,
        target_length_ms: input.targetLengthMs ?? track.brief.target_length_ms,
        references,
      },
    });

    const tracks = [...project.state.tracks];
    tracks[index] = updatedTrack;
    const state: MusicProjectState = {
      ...project.state,
      tracks,
      current_track_id: updatedTrack.track_id,
      state_revision: project.state.state_revision + 1,
      updated_at: nowIso(),
    };
    const updated = await this.writeState(input.projectId, state);
    return { project: updated, track: updatedTrack };
  }

  async writeLyrics(input: WriteLyricsInput): Promise<{ project: MusicProjectRecord; track: MusicTrack; draft: MusicLyricsDraft }> {
    const project = await this.getProject(input.projectId);
    if (!project) throw new Error(`Music project not found: ${input.projectId}`);
    const { track, index } = this.resolveTrack(project, input.trackId);

    const draft: MusicLyricsDraft = musicLyricsDraftSchema.parse({
      version: input.version ?? nextVersion(track.lyrics_drafts),
      language: input.language ?? track.brief.language,
      structure: input.structure ?? track.brief.structure,
      text: input.text,
      notes: input.notes,
    });

    const updatedTrack: MusicTrack = musicTrackSchema.parse({
      ...track,
      status: track.status === 'planned' ? 'lyrics_drafted' : track.status,
      lyrics_drafts: [...track.lyrics_drafts, draft],
    });

    const tracks = [...project.state.tracks];
    tracks[index] = updatedTrack;
    const state: MusicProjectState = {
      ...project.state,
      tracks,
      current_track_id: updatedTrack.track_id,
      state_revision: project.state.state_revision + 1,
      updated_at: nowIso(),
    };
    const updated = await this.writeState(input.projectId, state);
    return { project: updated, track: updatedTrack, draft };
  }

  async upsertTrack(input: UpsertTrackInput): Promise<{ project: MusicProjectRecord; track: MusicTrack }> {
    const project = await this.getProject(input.projectId);
    if (!project) throw new Error(`Music project not found: ${input.projectId}`);
    const trackId = input.trackId ?? `track-${randomUUID().slice(0, 8)}`;
    const existingIndex = project.state.tracks.findIndex((t) => t.track_id === trackId);
    const base = existingIndex >= 0 ? project.state.tracks[existingIndex] : defaultTrack(input, trackId);

    const updatedTrack: MusicTrack = musicTrackSchema.parse({
      ...base,
      title: input.title ?? base.title,
      status: input.status ?? base.status,
      generation_mode: input.generationMode ?? base.generation_mode,
      brief: {
        ...base.brief,
        objective: input.objective ?? base.brief.objective,
        genres: input.genres ?? base.brief.genres,
        mood: input.mood ?? base.brief.mood,
        bpm: input.bpm ?? base.brief.bpm,
        language: input.language ?? base.brief.language,
        vocal_type: input.vocalType ?? base.brief.vocal_type,
        structure: input.structure ?? base.brief.structure,
        target_length_ms: input.targetLengthMs ?? base.brief.target_length_ms,
      },
    });

    const tracks = [...project.state.tracks];
    if (existingIndex >= 0) tracks[existingIndex] = updatedTrack;
    else tracks.push(updatedTrack);

    const state: MusicProjectState = {
      ...project.state,
      tracks,
      current_track_id: updatedTrack.track_id,
      project_mode: tracks.length > 1 ? 'album' : project.state.project_mode,
      state_revision: project.state.state_revision + 1,
      updated_at: nowIso(),
    };
    const updated = await this.writeState(input.projectId, state);
    return { project: updated, track: updatedTrack };
  }

  async compilePromptSpec(input: CompilePromptSpecInput): Promise<{
    project: MusicProjectRecord;
    track: MusicTrack;
    spec: MusicPromptSpec;
    markdown: string;
  }> {
    const project = await this.getProject(input.projectId);
    if (!project) throw new Error(`Music project not found: ${input.projectId}`);
    const { track, index } = this.resolveTrack(project, input.trackId);

    const lyricsDraft = input.lyricsVersion
      ? track.lyrics_drafts.find((d) => d.version === input.lyricsVersion)
      : track.lyrics_drafts.at(-1);
    const existingStyle = input.styleVersion
      ? track.style_drafts.find((d) => d.version === input.styleVersion)
      : track.style_drafts.at(-1);

    // Compile (and persist) a style draft when an explicit prompt/tags are supplied
    // or none exists yet, so the spec always references a stored, versioned style.
    let styleDraft: MusicStyleDraft | undefined = existingStyle;
    let styleDrafts = track.style_drafts;
    if (input.stylePrompt || input.tags || !styleDraft) {
      styleDraft = musicStyleDraftSchema.parse({
        version: nextVersion(track.style_drafts),
        style_prompt: input.stylePrompt ?? defaultStylePrompt(track),
        tags: input.tags ?? track.brief.genres,
      });
      styleDrafts = [...track.style_drafts, styleDraft];
    }

    const isInstrumental = String(track.generation_mode) === 'instrumental' || track.brief.vocal_type === 'instrumental';
    const spec: MusicPromptSpec = musicPromptSpecSchema.parse({
      project_id: project.id,
      track_id: track.track_id,
      prompt_version: styleDraft.version,
      generation_mode: track.generation_mode,
      language: track.brief.language,
      vocal_type: track.brief.vocal_type,
      style_prompt: styleDraft.style_prompt,
      lyrics: isInstrumental ? '' : (lyricsDraft?.text ?? ''),
      structure: lyricsDraft?.structure ?? track.brief.structure,
      length_ms: input.lengthMs ?? track.brief.target_length_ms,
      output_format: input.outputFormat ?? 'mp3',
      reference_audio: input.referenceAudio
        ? musicPromptSpecSchema.shape.reference_audio.parse(input.referenceAudio)
        : track.brief.references,
    });

    const updatedTrack: MusicTrack = musicTrackSchema.parse({
      ...track,
      status: 'style_drafted',
      style_drafts: styleDrafts,
    });
    const tracks = [...project.state.tracks];
    tracks[index] = updatedTrack;
    const state: MusicProjectState = {
      ...project.state,
      tracks,
      current_track_id: updatedTrack.track_id,
      state_revision: project.state.state_revision + 1,
      updated_at: nowIso(),
    };
    const updated = await this.writeState(input.projectId, state);

    const markdown = [
      '## Source Brief',
      track.brief.objective || project.name,
      '',
      '## Internal Prompt Specification',
      '```json',
      JSON.stringify(spec, null, 2),
      '```',
      '',
      '## Compiled Style Prompt',
      spec.style_prompt,
      '',
      '## Lyrics',
      spec.lyrics || '(instrumental — no lyrics)',
      '',
      '## Lint Result',
      'lint: pending',
      '',
    ].join('\n');

    return { project: updated, track: updatedTrack, spec, markdown };
  }

  async recordTake(reviewInput: MusicTakeReview): Promise<{ project: MusicProjectRecord; review: MusicTakeReview }> {
    const review = musicTakeReviewSchema.parse(reviewInput);
    const project = await this.getProject(review.project_id);
    if (!project) throw new Error(`Music project not found: ${review.project_id}`);

    const accepted = review.verdict === 'accept' || review.verdict === 'accept_with_notes';
    const tracks = project.state.tracks.map((track) => {
      if (track.track_id !== review.track_id) return track;
      const nextStatus: MusicTrack['status'] =
        review.verdict === 'accept'
          ? 'accepted'
          : review.verdict === 'accept_with_notes'
            ? 'accepted_with_notes'
            : review.verdict === 'repair'
              ? 'repair'
              : 'rejected';
      return musicTrackSchema.parse({
        ...track,
        status: nextStatus,
        accepted_lyrics_version: accepted ? (track.lyrics_drafts.at(-1)?.version ?? track.accepted_lyrics_version) : track.accepted_lyrics_version,
        accepted_style_version: accepted ? (track.style_drafts.at(-1)?.version ?? track.accepted_style_version) : track.accepted_style_version,
        // A rejected take cannot become the deliverable; only accepted takes set the audio path.
        accepted_audio_path: accepted ? review.audio_path : track.accepted_audio_path,
      });
    });

    const state: MusicProjectState = {
      ...project.state,
      tracks,
      take_history: [...project.state.take_history, review],
      state_revision: project.state.state_revision + 1,
      updated_at: nowIso(),
    };
    const updated = await this.writeState(review.project_id, state);
    return { project: updated, review };
  }

  async appendGenerationRun(runInput: MusicGenerationRun): Promise<MusicGenerationRun> {
    const run = musicGenerationRunSchema.parse(runInput);
    const { created_at: createdAt, ...updatableRun } = run;
    const db = await this.db();
    await db.collection<MusicGenerationRun>('music_generation_runs').updateOne(
      { run_id: run.run_id },
      {
        $set: { ...updatableRun, updated_at: nowIso() },
        $setOnInsert: { created_at: createdAt ?? nowIso() },
      },
      { upsert: true },
    );
    return run;
  }

  async listGenerationRuns(projectId: string, limit = 20): Promise<MusicGenerationRun[]> {
    const db = await this.db();
    return db.collection<MusicGenerationRun>('music_generation_runs')
      .find({ project_id: projectId })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Count paid generation attempts for a project (optionally a single track).
   * music_generate only writes a run row once it is committed to a paid call, so
   * this count is the basis for the env-configurable spend cap that stops
   * repair/retry loops. Enforced in the tool, so it protects every caller.
   */
  async countGenerationAttempts(projectId: string, trackId?: string): Promise<number> {
    const db = await this.db();
    const filter: Record<string, unknown> = { project_id: projectId };
    if (trackId) filter.track_id = trackId;
    return db.collection<MusicGenerationRun>('music_generation_runs').countDocuments(filter);
  }

  /**
   * Resolve the live status of an approval token WITHOUT throwing, so the three
   * terminal cases (pending vs denied/missing vs approved) stay distinct — the
   * same fix that stopped the filmmaker approval-retry loop.
   */
  async getApprovalStatus(approvalToken: string): Promise<'approved' | 'pending' | 'denied' | 'missing'> {
    const approval = await this.getApprovalRecord(approvalToken);
    if (!approval) return 'missing';
    if (approval.status === 'approved') return 'approved';
    if (approval.status === 'pending') return 'pending';
    return 'denied';
  }

  async getApprovalRecord(approvalToken: string): Promise<Record<string, unknown> | null> {
    const db = await this.db();
    return db.collection<Record<string, unknown>>('approvals').findOne({ id: approvalToken });
  }

  async approvePaidGeneration(projectId: string, approvalToken: string): Promise<void> {
    const db = await this.db();
    const approval = await db.collection('approvals').findOne({ id: approvalToken });
    if (!approval || approval.status !== 'approved') {
      throw new Error(`Invalid or unapproved approvalToken: ${approvalToken}`);
    }
    await db.collection<MusicProjectRecord>('music_projects').updateOne(
      { id: projectId },
      { $set: { paidGenerationApproved: true, approvalToken, updatedAt: new Date() } },
    );
  }
}
