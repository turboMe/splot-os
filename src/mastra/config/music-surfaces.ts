import { musicGenerationModeSchema } from '../lib/music-schemas.js';
import { z } from 'zod';

export type MusicProvider = 'fal' | 'elevenlabs' | 'suno';
export type MusicSurfaceName =
  | 'fal'
  | 'fal-ace-step'
  | 'fal-stable-audio'
  | 'fal-minimax-reference'
  | 'elevenlabs'
  | 'suno-gateway';
export type MusicGenerationMode = z.infer<typeof musicGenerationModeSchema>;

// The one real transport difference from filmmaker: fal is an async queue
// (submit → poll status → fetch result), while ElevenLabs POST /v1/music is
// synchronous and returns the audio bytes in the response body. music-generate.ts
// branches on responseMode so each surface keeps its native protocol.
export type MusicResponseMode = 'async-poll' | 'sync-bytes';

export interface MusicSurfaceCapabilities {
  modes: MusicGenerationMode[];
  lengthMs: { min: number; max: number };
  outputFormats: string[];
  maxReferences: number;
  minReferences?: number;
  supportsLyrics: boolean;
  supportsInstrumental: boolean;
}

export interface MusicSurfaceConfig {
  provider: MusicProvider;
  surface: MusicSurfaceName;
  modelId: string;
  responseMode: MusicResponseMode;
  baseUrlEnv: string;
  apiKeyEnv: string;
  defaultBaseUrl?: string;
  submitPathEnv?: string;
  pollIntervalMsEnv?: string;
  pollTimeoutMsEnv?: string;
  // Whether the surface is wired for real generation. The Suno gateway is a
  // config-only seam (no official public API in 2026) and stays disabled until an
  // env-provided, ToS-compliant gateway URL is set — never a scraper.
  enabled: boolean;
}

export const MUSIC_SURFACES: Record<MusicSurfaceName, MusicSurfaceConfig> = {
  fal: {
    provider: 'fal',
    surface: 'fal',
    modelId: process.env.MUSIC_FAL_MODEL_ID || 'fal-ai/ace-step',
    responseMode: 'async-poll',
    baseUrlEnv: 'FAL_BASE_URL',
    apiKeyEnv: 'FAL_KEY',
    defaultBaseUrl: 'https://queue.fal.run',
    submitPathEnv: 'MUSIC_FAL_SUBMIT_PATH',
    pollIntervalMsEnv: 'MUSIC_POLL_INTERVAL_MS',
    pollTimeoutMsEnv: 'MUSIC_POLL_TIMEOUT_MS',
    enabled: true,
  },
  'fal-ace-step': {
    provider: 'fal',
    surface: 'fal-ace-step',
    modelId: process.env.MUSIC_FAL_ACE_STEP_MODEL_ID || 'fal-ai/ace-step',
    responseMode: 'async-poll',
    baseUrlEnv: 'FAL_BASE_URL',
    apiKeyEnv: 'FAL_KEY',
    defaultBaseUrl: 'https://queue.fal.run',
    submitPathEnv: 'MUSIC_FAL_ACE_STEP_SUBMIT_PATH',
    pollIntervalMsEnv: 'MUSIC_POLL_INTERVAL_MS',
    pollTimeoutMsEnv: 'MUSIC_POLL_TIMEOUT_MS',
    enabled: true,
  },
  'fal-stable-audio': {
    provider: 'fal',
    surface: 'fal-stable-audio',
    modelId: process.env.MUSIC_FAL_STABLE_AUDIO_MODEL_ID || 'fal-ai/stable-audio',
    responseMode: 'async-poll',
    baseUrlEnv: 'FAL_BASE_URL',
    apiKeyEnv: 'FAL_KEY',
    defaultBaseUrl: 'https://queue.fal.run',
    submitPathEnv: 'MUSIC_FAL_STABLE_AUDIO_SUBMIT_PATH',
    pollIntervalMsEnv: 'MUSIC_POLL_INTERVAL_MS',
    pollTimeoutMsEnv: 'MUSIC_POLL_TIMEOUT_MS',
    enabled: true,
  },
  'fal-minimax-reference': {
    provider: 'fal',
    surface: 'fal-minimax-reference',
    modelId: process.env.MUSIC_FAL_MINIMAX_MODEL_ID || 'fal-ai/minimax-music',
    responseMode: 'async-poll',
    baseUrlEnv: 'FAL_BASE_URL',
    apiKeyEnv: 'FAL_KEY',
    defaultBaseUrl: 'https://queue.fal.run',
    submitPathEnv: 'MUSIC_FAL_MINIMAX_SUBMIT_PATH',
    pollIntervalMsEnv: 'MUSIC_POLL_INTERVAL_MS',
    pollTimeoutMsEnv: 'MUSIC_POLL_TIMEOUT_MS',
    enabled: true,
  },
  elevenlabs: {
    provider: 'elevenlabs',
    surface: 'elevenlabs',
    modelId: process.env.MUSIC_ELEVENLABS_MODEL_ID || 'music_v1',
    responseMode: 'sync-bytes',
    baseUrlEnv: 'ELEVENLABS_BASE_URL',
    apiKeyEnv: 'ELEVENLABS_API_KEY',
    defaultBaseUrl: 'https://api.elevenlabs.io',
    submitPathEnv: 'MUSIC_ELEVENLABS_SUBMIT_PATH',
    enabled: true,
  },
  'suno-gateway': {
    provider: 'suno',
    surface: 'suno-gateway',
    modelId: process.env.MUSIC_SUNO_MODEL_ID || 'suno-v5',
    responseMode: 'async-poll',
    baseUrlEnv: 'SUNO_GATEWAY_BASE_URL',
    apiKeyEnv: 'SUNO_GATEWAY_API_KEY',
    submitPathEnv: 'MUSIC_SUNO_SUBMIT_PATH',
    pollIntervalMsEnv: 'MUSIC_POLL_INTERVAL_MS',
    pollTimeoutMsEnv: 'MUSIC_POLL_TIMEOUT_MS',
    // Disabled unless an env-provided gateway is configured; ToS-compliant only.
    enabled: Boolean(process.env.SUNO_GATEWAY_BASE_URL),
  },
};

const FAL_ACE_STEP_CAPABILITIES: MusicSurfaceCapabilities = {
  modes: ['text2music', 'lyrics2song', 'instrumental'],
  lengthMs: { min: 3_000, max: 300_000 },
  outputFormats: ['mp3', 'wav'],
  maxReferences: 0,
  supportsLyrics: true,
  supportsInstrumental: true,
};

const FAL_STABLE_AUDIO_CAPABILITIES: MusicSurfaceCapabilities = {
  modes: ['text2music', 'instrumental'],
  lengthMs: { min: 3_000, max: 300_000 },
  outputFormats: ['mp3', 'wav'],
  maxReferences: 0,
  supportsLyrics: false,
  supportsInstrumental: true,
};

const FAL_MINIMAX_REFERENCE_CAPABILITIES: MusicSurfaceCapabilities = {
  modes: ['lyrics2song', 'audio2audio', 'extend'],
  lengthMs: { min: 3_000, max: 300_000 },
  outputFormats: ['mp3', 'wav'],
  maxReferences: 1,
  minReferences: 1,
  supportsLyrics: true,
  supportsInstrumental: false,
};

const ELEVENLABS_CAPABILITIES: MusicSurfaceCapabilities = {
  modes: ['text2music', 'lyrics2song', 'instrumental'],
  lengthMs: { min: 3_000, max: 600_000 },
  outputFormats: ['mp3', 'wav', 'pcm'],
  maxReferences: 0,
  supportsLyrics: true,
  supportsInstrumental: true,
};

const SUNO_CAPABILITIES: MusicSurfaceCapabilities = {
  modes: ['text2music', 'lyrics2song', 'instrumental', 'extend'],
  lengthMs: { min: 3_000, max: 480_000 },
  outputFormats: ['mp3'],
  maxReferences: 1,
  supportsLyrics: true,
  supportsInstrumental: true,
};

export const MUSIC_SURFACE_CAPABILITIES: Record<MusicSurfaceName, MusicSurfaceCapabilities> = {
  fal: FAL_ACE_STEP_CAPABILITIES,
  'fal-ace-step': FAL_ACE_STEP_CAPABILITIES,
  'fal-stable-audio': FAL_STABLE_AUDIO_CAPABILITIES,
  'fal-minimax-reference': FAL_MINIMAX_REFERENCE_CAPABILITIES,
  elevenlabs: ELEVENLABS_CAPABILITIES,
  'suno-gateway': SUNO_CAPABILITIES,
};

export const DEFAULT_MUSIC_SURFACE: MusicSurfaceConfig = MUSIC_SURFACES.fal;

export function resolveMusicSurface(input?: {
  provider?: MusicProvider;
  surface?: MusicSurfaceName | string;
}): MusicSurfaceConfig {
  const requestedSurface = input?.surface?.trim().toLowerCase();
  if (input?.provider === 'elevenlabs' || requestedSurface === 'elevenlabs') {
    return MUSIC_SURFACES.elevenlabs;
  }
  if (input?.provider === 'suno' || requestedSurface === 'suno-gateway') {
    return MUSIC_SURFACES['suno-gateway'];
  }
  if (requestedSurface === 'ace-step' || requestedSurface === 'fal-ace-step') {
    return MUSIC_SURFACES['fal-ace-step'];
  }
  if (requestedSurface === 'stable-audio' || requestedSurface === 'fal-stable-audio') {
    return MUSIC_SURFACES['fal-stable-audio'];
  }
  if (
    requestedSurface === 'minimax'
    || requestedSurface === 'minimax-music'
    || requestedSurface === 'fal-minimax'
    || requestedSurface === 'fal-minimax-reference'
  ) {
    return MUSIC_SURFACES['fal-minimax-reference'];
  }
  const envSurface = process.env.MUSIC_SURFACE?.trim() as MusicSurfaceName | undefined;
  const requested = (requestedSurface || envSurface || DEFAULT_MUSIC_SURFACE.surface) as MusicSurfaceName;
  return MUSIC_SURFACES[requested] ?? DEFAULT_MUSIC_SURFACE;
}

export function validateMusicSurfaceRequest(input: {
  surfaceConfig: MusicSurfaceConfig;
  mode: MusicGenerationMode | string;
  lengthMs?: number | null;
  outputFormat?: string;
  referenceCount?: number;
}): string[] {
  const errors: string[] = [];
  const caps = MUSIC_SURFACE_CAPABILITIES[input.surfaceConfig.surface];

  if (!input.surfaceConfig.enabled) {
    errors.push(`${input.surfaceConfig.surface} surface is not enabled — set ${input.surfaceConfig.baseUrlEnv} to configure it.`);
  }
  if (!caps.modes.includes(input.mode as MusicGenerationMode)) {
    errors.push(`${input.surfaceConfig.surface} does not support generation mode ${input.mode}`);
  }
  if (typeof input.lengthMs === 'number') {
    if (input.lengthMs < caps.lengthMs.min || input.lengthMs > caps.lengthMs.max) {
      errors.push(`${input.surfaceConfig.surface} length must be ${caps.lengthMs.min}-${caps.lengthMs.max} ms`);
    }
  }
  if (input.outputFormat && !caps.outputFormats.includes(input.outputFormat)) {
    errors.push(`${input.surfaceConfig.surface} does not support output format ${input.outputFormat}`);
  }
  if ((input.referenceCount ?? 0) > caps.maxReferences) {
    errors.push(`${input.surfaceConfig.surface} supports at most ${caps.maxReferences} reference audio inputs`);
  }
  if ((input.referenceCount ?? 0) < (caps.minReferences ?? 0)) {
    errors.push(`${input.surfaceConfig.surface} requires at least ${caps.minReferences} reference audio input(s)`);
  }
  return errors;
}
