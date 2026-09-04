import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  MUSIC_PIPELINE_STATUSES,
  MusicService,
  type MusicPipelineStatus,
} from './music-service.js';
import {
  musicGenerationModeSchema,
  musicProjectModeSchema,
  musicReferenceAudioSchema,
  musicTakeReviewSchema,
  musicVocalTypeSchema,
} from '../../lib/music-schemas.js';

const musicPipelineStatusSchema = z.enum(MUSIC_PIPELINE_STATUSES);

function okResult<T extends Record<string, unknown>>(payload: T): T & { success: true } {
  return { success: true, ...payload };
}

function errorResult(error: unknown): { success: false; error: string } {
  return { success: false, error: (error as Error).message };
}

export const musicStartProjectTool = createTool({
  id: 'music_start_project',
  description:
    'Creates a music project state capsule with a first track skeleton. Use before drafting lyrics/style or generating audio. Defaults to single_track; switches to album when more tracks are added.',
  inputSchema: z.object({
    projectId: z.string().optional(),
    name: z.string().min(1),
    projectMode: musicProjectModeSchema.default('single_track'),
    objective: z.string().min(1),
    genres: z.array(z.string()).optional(),
    mood: z.string().optional(),
    bpm: z.number().int().positive().nullable().optional(),
    language: z.string().optional(),
    vocalType: musicVocalTypeSchema.optional(),
    structure: z.array(z.string()).optional(),
    targetLengthMs: z.number().int().positive().nullable().optional(),
    surface: z.record(z.string(), z.unknown()).optional(),
    promptBudget: z.number().int().positive().nullable().optional(),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const project = await music.startProject({
        ...context,
        projectMode: context.projectMode ?? 'single_track',
      });
      return okResult({ project });
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicGetProjectTool = createTool({
  id: 'music_get_project',
  description: 'Gets a music project state capsule by project id.',
  inputSchema: z.object({
    projectId: z.string().min(1),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const project = await music.getProject(context.projectId);
      return project ? okResult({ project }) : { success: false, error: `Music project not found: ${context.projectId}` };
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicListProjectsTool = createTool({
  id: 'music_list_projects',
  description: 'Lists recent music projects, optionally filtered by pipeline status.',
  inputSchema: z.object({
    status: musicPipelineStatusSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const projects = await music.listProjects({ status: context.status as MusicPipelineStatus | undefined }, context.limit);
      return okResult({ projects });
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicSetProjectStatusTool = createTool({
  id: 'music_set_project_status',
  description:
    'Sets the musician pipeline status. Call on every phase transition so the reflector can channel tools. Allowed statuses: intake, brief, source_gate, lyric_write, style_compile, safety_gate, generate, review, repair, deliver, done.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    status: musicPipelineStatusSchema,
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const project = await music.setProjectStatus(context.projectId, context.status);
      return okResult({ projectId: project.id, status: project.status, project });
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicSetBriefTool = createTool({
  id: 'music_set_brief',
  description:
    'Sets or updates the creative brief (objective, genres, mood, bpm, language, vocal type, structure, target length, reference audio) for a track. Defaults to the current track when trackId is omitted.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    trackId: z.string().optional(),
    title: z.string().optional(),
    generationMode: musicGenerationModeSchema.or(z.string().min(1)).optional(),
    objective: z.string().optional(),
    genres: z.array(z.string()).optional(),
    mood: z.string().optional(),
    bpm: z.number().int().positive().nullable().optional(),
    language: z.string().optional(),
    vocalType: musicVocalTypeSchema.optional(),
    structure: z.array(z.string()).optional(),
    targetLengthMs: z.number().int().positive().nullable().optional(),
    references: z.array(musicReferenceAudioSchema).optional(),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const result = await music.setBrief(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicWriteLyricsTool = createTool({
  id: 'music_write_lyrics',
  description:
    'Appends a versioned lyrics draft to a track. Versions auto-increment (v1, v2, ...) unless an explicit version is supplied. Defaults to the current track.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    trackId: z.string().optional(),
    version: z.string().optional(),
    language: z.string().optional(),
    structure: z.array(z.string()).optional(),
    text: z.string().min(1),
    notes: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const result = await music.writeLyrics(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicUpsertTrackTool = createTool({
  id: 'music_upsert_track',
  description:
    'Creates or updates a track inside a music project. Adding a second track promotes the project to album mode.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    trackId: z.string().optional(),
    title: z.string().optional(),
    status: z.enum([
      'planned',
      'lyrics_drafted',
      'style_drafted',
      'ready',
      'generated',
      'reviewed',
      'accepted',
      'accepted_with_notes',
      'repair',
      'rejected',
    ]).optional(),
    generationMode: musicGenerationModeSchema.or(z.string().min(1)).optional(),
    objective: z.string().optional(),
    genres: z.array(z.string()).optional(),
    mood: z.string().optional(),
    bpm: z.number().int().positive().nullable().optional(),
    language: z.string().optional(),
    vocalType: musicVocalTypeSchema.optional(),
    structure: z.array(z.string()).optional(),
    targetLengthMs: z.number().int().positive().nullable().optional(),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const result = await music.upsertTrack(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicCompilePromptSpecTool = createTool({
  id: 'music_compile_prompt_spec',
  description:
    'Assembles the internal music prompt-spec (style prompt + lyrics + structure + reference audio) and a golden markdown prompt from project state and the track. Persists a versioned style draft.',
  inputSchema: z.object({
    projectId: z.string().min(1),
    trackId: z.string().min(1),
    stylePrompt: z.string().optional(),
    tags: z.array(z.string()).optional(),
    lyricsVersion: z.string().optional(),
    styleVersion: z.string().optional(),
    lengthMs: z.number().int().positive().nullable().optional(),
    outputFormat: z.string().optional(),
    referenceAudio: z.array(musicReferenceAudioSchema).optional(),
  }),
  execute: async (context) => {
    try {
      const music = new MusicService();
      const result = await music.compilePromptSpec(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});

export const musicRecordTakeTool = createTool({
  id: 'music_record_take',
  description:
    'Records a generated take review. Accepted takes set the deliverable audio path and accepted lyric/style versions; rejected takes cannot become the deliverable.',
  inputSchema: musicTakeReviewSchema,
  execute: async (context) => {
    try {
      const music = new MusicService();
      const result = await music.recordTake(context);
      return okResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
});
