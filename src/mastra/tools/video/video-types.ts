import { z } from 'zod';

export const videoEngineModeSchema = z.enum(['local_whisper', 'openai_whisper', 'assemblyai']);
export type VideoEngineMode = z.infer<typeof videoEngineModeSchema>;

export const audioCleanMethodSchema = z.enum(['rnnoise', 'eleven']);
export type AudioCleanMethod = z.infer<typeof audioCleanMethodSchema>;

export const imageModelProviderSchema = z.enum(['openai_dalle', 'google_imagen', 'auto']);
export type ImageModelProvider = z.infer<typeof imageModelProviderSchema>;

export const transcriptWordSchema = z.object({
  word: z.string().optional(),
  text: z.string().optional(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
  emoji: z.string().optional(),
});
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;

export const cutSegmentSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  label: z.string().optional(),
  reason: z.string().optional(),
});
export type CutSegment = z.infer<typeof cutSegmentSchema>;

export const videoChapterSchema = z.object({
  title: z.string(),
  startSeconds: z.number(),
  formattedTimestamp: z.string(), // e.g. "01:23"
});
export type VideoChapter = z.infer<typeof videoChapterSchema>;

export const faceCamLayoutSchema = z.enum([
  'fullscreen',
  'pip_bottom_right',
  'pip_bottom_left',
  'pip_top_right',
  'split_left',
  'split_right',
  'floating_badge',
  'hidden',
]);
export type FaceCamLayout = z.infer<typeof faceCamLayoutSchema>;

export const storyboardOverlaySchema = z.object({
  type: z.enum([
    'lower_third',
    'notification_toast',
    'stat_counter',
    'callout_card',
    'terminal_shot',
    'code_editor_shot',
    'agent_graph_shot',
    'image_broll',
  ]),
  startSec: z.number(),
  durationSec: z.number(),
  props: z.record(z.string(), z.any()).default({}),
});
export type StoryboardOverlay = z.infer<typeof storyboardOverlaySchema>;

export const storyboardSfxSchema = z.object({
  name: z.string(),
  atSec: z.number(),
  volume: z.number().default(1.0),
});
export type StoryboardSfx = z.infer<typeof storyboardSfxSchema>;

export const storyboardSegmentSchema = z.object({
  id: z.string(),
  timeRange: z.object({
    startSec: z.number(),
    endSec: z.number(),
  }),
  faceCam: z
    .object({
      layout: faceCamLayoutSchema.default('fullscreen'),
      zoom: z.number().default(1.0),
      punchPunchSec: z.array(z.number()).optional(),
    })
    .optional(),
  captions: z
    .object({
      enabled: z.boolean().default(true),
      style: z.enum(['kinetic_pill', 'cyber_glow', 'minimal_clean', 'bold_karaoke']).default('kinetic_pill'),
      emphasisWords: z.array(z.string()).optional(),
    })
    .optional(),
  overlays: z.array(storyboardOverlaySchema).default([]),
  sfx: z.array(storyboardSfxSchema).default([]),
});
export type StoryboardSegment = z.infer<typeof storyboardSegmentSchema>;

export const storyboardSchema = z.object({
  projectId: z.string(),
  language: z.enum(['pl', 'en']).default('pl'),
  aspectRatio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  fps: z.number().default(60),
  theme: z.string().default('splot_dark'),
  global: z
    .object({
      musicTrack: z.string().optional(),
      musicVolume: z.number().default(0.12),
      duckingDb: z.number().default(-18),
    })
    .default({ musicVolume: 0.12, duckingDb: -18 }),
  segments: z.array(storyboardSegmentSchema),
});
export type Storyboard = z.infer<typeof storyboardSchema>;

export function okResult<T extends Record<string, unknown>>(payload: T): T & { success: true } {
  return { success: true, ...payload };
}

export function errorResult(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}
