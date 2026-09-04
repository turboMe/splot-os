import { z } from 'zod';

// A music track is usually ONE generation, not a dependent chain of clips, so the
// musician domain carries far lighter state than the filmmaker domain: no
// clip-lineage / continuity-lock / canon-revision machinery. A project holds a
// brief + lyrics/style drafts + takes + a run ledger, optionally several
// independent tracks (album mode).

export const musicProjectModeSchema = z.enum(['single_track', 'album']);

// text2music: style-only prompt → track (may be instrumental or sung by the model)
// lyrics2song: supplied lyrics + style → sung track
// instrumental: style-only, no vocals
// audio2audio: restyle/remix a supplied reference audio
// extend:      continue/lengthen a supplied audio
export const musicGenerationModeSchema = z.enum([
  'text2music',
  'lyrics2song',
  'instrumental',
  'audio2audio',
  'extend',
]);

export const musicVocalTypeSchema = z.enum(['instrumental', 'male', 'female', 'duet', 'choir', 'any']);

export const musicTrackStatusSchema = z.enum([
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
]);

export const musicTakeVerdictSchema = z.enum(['accept', 'accept_with_notes', 'repair', 'reject']);

export const musicGenerationResultStatusSchema = z.enum([
  'not_run_fixture',
  'submitted',
  'generated',
  'reviewed',
  'accepted',
  'rejected',
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const musicReferenceAudioSchema = z.object({
  tag: z.string().min(1),
  role: z.string().min(1), // e.g. 'melody', 'restyle_source', 'extend_source', 'voice_sample'
  url: z.string().optional(),
  path: z.string().optional(),
  notes: z.string().optional(),
});
export type MusicReferenceAudio = z.infer<typeof musicReferenceAudioSchema>;

export const musicLyricsDraftSchema = z.object({
  version: z.string(),
  language: z.string(),
  structure: z.array(z.string()), // e.g. ['verse','chorus','verse','chorus','bridge','chorus']
  text: z.string(),
  notes: z.string().optional(),
});
export type MusicLyricsDraft = z.infer<typeof musicLyricsDraftSchema>;

export const musicStyleDraftSchema = z.object({
  version: z.string(),
  style_prompt: z.string(),
  tags: z.array(z.string()),
  notes: z.string().optional(),
});
export type MusicStyleDraft = z.infer<typeof musicStyleDraftSchema>;

export const musicBriefSchema = z.object({
  objective: z.string(),
  genres: z.array(z.string()),
  mood: z.string(),
  bpm: z.number().int().nullable(),
  language: z.string(),
  vocal_type: musicVocalTypeSchema,
  structure: z.array(z.string()),
  target_length_ms: z.number().int().nullable(),
  references: z.array(musicReferenceAudioSchema),
});
export type MusicBrief = z.infer<typeof musicBriefSchema>;

export const musicTrackSchema = z.object({
  track_id: z.string().min(1),
  title: z.string(),
  status: musicTrackStatusSchema,
  generation_mode: musicGenerationModeSchema.or(z.string().min(1)),
  brief: musicBriefSchema,
  lyrics_drafts: z.array(musicLyricsDraftSchema),
  style_drafts: z.array(musicStyleDraftSchema),
  accepted_lyrics_version: z.string().nullable(),
  accepted_style_version: z.string().nullable(),
  accepted_audio_path: z.string().nullable(),
});
export type MusicTrack = z.infer<typeof musicTrackSchema>;

export const musicProjectStateSchema = z.object({
  schema_version: z.string(),
  state_revision: z.number().int().min(1),
  project_id: z.string().min(1),
  project_mode: musicProjectModeSchema,
  surface: jsonObjectSchema,
  prompt_budget: z.number().int().nullable(),
  tracks: z.array(musicTrackSchema),
  take_history: z.array(z.unknown()),
  current_track_id: z.string(),
  updated_at: z.string(),
});
export type MusicProjectState = z.infer<typeof musicProjectStateSchema>;

export const musicPromptSpecSchema = z.object({
  project_id: z.string(),
  track_id: z.string(),
  prompt_version: z.string(),
  generation_mode: musicGenerationModeSchema.or(z.string().min(1)),
  language: z.string(),
  vocal_type: musicVocalTypeSchema,
  style_prompt: z.string().min(1),
  lyrics: z.string(),
  structure: z.array(z.string()),
  length_ms: z.number().int().nullable(),
  output_format: z.string(),
  reference_audio: z.array(musicReferenceAudioSchema),
});
export type MusicPromptSpec = z.infer<typeof musicPromptSpecSchema>;

export const musicTakeReviewSchema = z.object({
  project_id: z.string(),
  track_id: z.string(),
  take_id: z.string(),
  source_status: musicTrackStatusSchema.exclude(['planned', 'lyrics_drafted', 'style_drafted', 'ready']),
  verdict: musicTakeVerdictSchema,
  audio_path: z.string().nullable(),
  observed_notes: z.string(),
  matched_brief: z.boolean(),
  issues: z.array(z.string()),
  requires_user_confirmation: z.boolean(),
});
export type MusicTakeReview = z.infer<typeof musicTakeReviewSchema>;

export const musicGenerationRunSchema = z.object({
  run_id: z.string(),
  project_id: z.string(),
  track_id: z.string(),
  surface: z.string(),
  prompt_version: z.string(),
  input_mode: z.string(),
  reference_tags: z.array(z.string()),
  prompt: z.string(),
  result_status: musicGenerationResultStatusSchema,
  is_synthetic_fixture: z.boolean(),
  task_id: z.string().optional(),
  provider: z.string().optional(),
  model_id: z.string().optional(),
  length_ms: z.number().optional(),
  audio_path: z.string().optional(),
  output_url: z.string().optional(),
  error: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type MusicGenerationRun = z.infer<typeof musicGenerationRunSchema>;

export function validateMusicProjectState(input: unknown): MusicProjectState {
  return musicProjectStateSchema.parse(input);
}

export function validateMusicBrief(input: unknown): MusicBrief {
  return musicBriefSchema.parse(input);
}

export function validateMusicPromptSpec(input: unknown): MusicPromptSpec {
  return musicPromptSpecSchema.parse(input);
}

export function validateMusicTakeReview(input: unknown): MusicTakeReview {
  return musicTakeReviewSchema.parse(input);
}

export function validateMusicGenerationRun(input: unknown): MusicGenerationRun {
  return musicGenerationRunSchema.parse(input);
}
