import { z } from 'zod';

export const filmProjectModeSchema = z.enum(['standalone_clip', 'sequence_project']);
export const filmSequenceRelationSchema = z.enum([
  'standalone',
  'sequence_first_clip',
  'seamless_continuation',
  'intentional_next_shot',
  'bridge_between_known_states',
  'repair_tail',
  'reanchor_after_drift',
]);
export const filmOpeningStateSourceSchema = z.enum([
  'planned_start_state',
  'observed_end_state',
  'user_supplied_final_frame',
  'source_clip',
]);
export const filmGenerationModeSchema = z.enum(['T2V', 'I2V', 'V2V', 'R2V', 'FLF2V', 'edit', 'extend']);
export const filmClipStatusSchema = z.enum([
  'planned',
  'ready',
  'generated',
  'reviewed',
  'accepted',
  'accepted_with_deviation',
  'repair',
  'rejected',
]);
export const filmShotStructureSchema = z.enum([
  'compact_single_take',
  'phased_single_take',
  'dense_multishot',
  'first_last_frame_transition',
  'video_edit_contract',
]);
export const filmTakeVerdictSchema = z.enum(['accept', 'accept_with_deviation', 'repair', 'reject']);
export const filmObservationConfidenceSchema = z.enum(['low', 'medium', 'high']);
export const filmGenerationResultStatusSchema = z.enum([
  'not_run_fixture',
  'submitted',
  'generated',
  'reviewed',
  'accepted',
  'rejected',
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const filmReferenceSchema = z.object({
  tag: z.string().min(1),
  role: z.string().min(1),
  preserve_exact_tag: z.literal(true),
  url: z.string().optional(),
  path: z.string().optional(),
  notes: z.string().optional(),
});
export type FilmReference = z.infer<typeof filmReferenceSchema>;

export const filmBeatSchema = z.object({
  beat_id: z.string().min(1),
  description: z.string(),
  narrative_function: z.string(),
  status: z.enum(['planned', 'current', 'completed', 'omitted', 'replaced']),
  assigned_clip_id: z.string().nullable(),
  dependencies: z.array(z.string()),
});
export type FilmBeat = z.infer<typeof filmBeatSchema>;

export const filmClipSchema = z.object({
  clip_id: z.string().min(1),
  parent_clip_id: z.string().nullable(),
  sequence_index: z.number().int().min(1),
  prompt_version: z.string(),
  generation_mode: filmGenerationModeSchema.or(z.string().min(1)),
  source_clip_tag: z.string().nullable().optional(),
  status: filmClipStatusSchema,
  narrative_job: z.string(),
  already_happened: z.array(z.string()),
  this_clip_only: z.array(z.string()),
  reserved_for_later: z.array(z.string()),
  planned_start_state: jsonObjectSchema,
  planned_end_state: jsonObjectSchema,
  observed_start_state: jsonObjectSchema.nullable(),
  observed_end_state: jsonObjectSchema.nullable(),
  continuity_locks: z.array(z.unknown()),
  allowed_changes: z.array(z.unknown()),
  continuity_breaks: z.array(z.unknown()),
  accepted_deviations: z.array(z.unknown()),
  transition_in: z.string(),
  transition_out: z.string(),
  open_motion_vectors: z.array(z.unknown()),
  handoff_requirements: z.array(z.unknown()),
  extension_depth: z.number().int().min(0),
});
export type FilmClip = z.infer<typeof filmClipSchema>;

export const filmStorySchema = z.object({
  logline: z.string(),
  story_promise: z.string(),
  objective: z.string(),
  initial_condition: z.string(),
  final_outcome: z.string(),
  target_duration_sec: z.number().nullable(),
  tone: z.string(),
  medium: z.string(),
});
export type FilmStory = z.infer<typeof filmStorySchema>;

export const filmProjectStateSchema = z.object({
  schema_version: z.string(),
  state_revision: z.number().int().min(1),
  project_id: z.string().min(1),
  project_mode: filmProjectModeSchema,
  surface: jsonObjectSchema,
  clip_budget_sec: z.number().nullable(),
  prompt_budget: z.number().int().nullable(),
  story: filmStorySchema,
  world_bible: jsonObjectSchema,
  reference_registry: z.array(filmReferenceSchema),
  beats: z.array(filmBeatSchema),
  clips: z.array(filmClipSchema),
  take_history: z.array(z.unknown()),
  current_clip_id: z.string(),
  canon_revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type FilmProjectState = z.infer<typeof filmProjectStateSchema>;

export const filmClipContractSchema = z.object({
  project_id: z.string(),
  clip_id: z.string(),
  parent_clip_id: z.string().nullable(),
  sequence_index: z.number().int().min(1),
  narrative_job: z.string(),
  target_duration_sec: z.number().nullable(),
  generation_mode: filmGenerationModeSchema.or(z.string().min(1)),
  shot_structure: filmShotStructureSchema,
  already_happened: z.array(z.string()),
  this_clip_only: z.array(z.string()),
  reserved_for_later: z.array(z.string()),
  planned_start_state: jsonObjectSchema,
  planned_end_state: jsonObjectSchema,
  continuity_locks: z.array(z.unknown()),
  allowed_changes: z.array(z.unknown()),
  status: filmClipStatusSchema,
});
export type FilmClipContract = z.infer<typeof filmClipContractSchema>;

export const filmPromptSpecSchema = z.object({
  project_id: z.string(),
  clip_id: z.string(),
  prompt_version: z.string(),
  sequence_relation: filmSequenceRelationSchema,
  generation_mode: filmGenerationModeSchema.or(z.string().min(1)),
  reference_roles: z.array(z.unknown()),
  opening_state_source: filmOpeningStateSourceSchema,
  current_clip_action: z.string(),
  endpoint: z.string(),
  completed_beat_exclusions: z.array(z.string()),
  reserved_future_exclusions: z.array(z.string()),
  natural_language_prompt: z.string().min(1),
});
export type FilmPromptSpec = z.infer<typeof filmPromptSpecSchema>;

export const filmTakeReviewSchema = z.object({
  project_id: z.string(),
  clip_id: z.string(),
  take_id: z.string(),
  source_status: filmClipStatusSchema.exclude(['planned', 'ready']),
  verdict: filmTakeVerdictSchema,
  observed_start_state: jsonObjectSchema,
  observed_end_state: jsonObjectSchema,
  completed_beats: z.array(z.string()),
  incomplete_beats: z.array(z.string()),
  unexpected_completed_beats: z.array(z.string()),
  continuity_breaks: z.array(z.unknown()),
  accepted_deviations: z.array(z.unknown()),
  observation_confidence: filmObservationConfidenceSchema,
  uncertainties: z.array(z.string()),
  requires_user_confirmation: z.boolean(),
});
export type FilmTakeReview = z.infer<typeof filmTakeReviewSchema>;

export const filmGenerationRunSchema = z.object({
  run_id: z.string(),
  project_id: z.string(),
  clip_id: z.string(),
  surface: z.string(),
  prompt_version: z.string(),
  input_mode: z.string(),
  reference_tags: z.array(z.string()),
  prompt: z.string(),
  result_status: filmGenerationResultStatusSchema,
  is_synthetic_fixture: z.boolean(),
  task_id: z.string().optional(),
  provider: z.string().optional(),
  model_id: z.string().optional(),
  video_path: z.string().optional(),
  last_frame_path: z.string().optional(),
  output_url: z.string().optional(),
  error: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type FilmGenerationRun = z.infer<typeof filmGenerationRunSchema>;

export function validateFilmProjectState(input: unknown): FilmProjectState {
  return filmProjectStateSchema.parse(input);
}

export function validateFilmClipContract(input: unknown): FilmClipContract {
  return filmClipContractSchema.parse(input);
}

export function validateFilmPromptSpec(input: unknown): FilmPromptSpec {
  return filmPromptSpecSchema.parse(input);
}

export function validateFilmTakeReview(input: unknown): FilmTakeReview {
  return filmTakeReviewSchema.parse(input);
}

export function validateFilmGenerationRun(input: unknown): FilmGenerationRun {
  return filmGenerationRunSchema.parse(input);
}
