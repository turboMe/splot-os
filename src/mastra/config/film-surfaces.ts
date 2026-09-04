import { filmGenerationModeSchema } from '../lib/film-schemas.js';
import { z } from 'zod';

export type FilmProvider = 'seedance' | 'veo';
export type FilmSurfaceName = 'fal' | 'runway' | 'volcengine' | 'google';
export type FilmGenerationMode = z.infer<typeof filmGenerationModeSchema>;

export interface FilmSurfaceCapabilities {
  modes: FilmGenerationMode[];
  durationSec: { min: number; max: number };
  aspectRatios: string[];
  resolutions: string[];
  maxReferences: number;
  supportsLastFrame: boolean;
  supportsAudio: boolean;
}

export interface FilmSurfaceConfig {
  provider: FilmProvider;
  surface: FilmSurfaceName;
  modelId: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  defaultBaseUrl?: string;
  submitPathEnv?: string;
  pollIntervalMsEnv?: string;
  pollTimeoutMsEnv?: string;
  capabilities: FilmSurfaceCapabilities;
}

const seedanceCommonCapabilities: FilmSurfaceCapabilities = {
  modes: ['T2V', 'I2V', 'V2V', 'R2V', 'FLF2V'],
  durationSec: { min: 4, max: 15 },
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  resolutions: ['480p', '720p', '1080p'],
  maxReferences: 4,
  supportsLastFrame: true,
  supportsAudio: true,
};

export const FILM_SURFACES: Record<FilmSurfaceName, FilmSurfaceConfig> = {
  fal: {
    provider: 'seedance',
    surface: 'fal',
    modelId: process.env.FILM_FAL_MODEL_ID || 'bytedance/seedance-2.0/text-to-video',
    baseUrlEnv: 'FAL_BASE_URL',
    apiKeyEnv: 'FAL_KEY',
    defaultBaseUrl: 'https://queue.fal.run',
    submitPathEnv: 'FILM_FAL_SUBMIT_PATH',
    pollIntervalMsEnv: 'FILM_POLL_INTERVAL_MS',
    pollTimeoutMsEnv: 'FILM_POLL_TIMEOUT_MS',
    capabilities: {
      ...seedanceCommonCapabilities,
      modes: ['T2V', 'I2V', 'V2V', 'R2V', 'FLF2V'],
    },
  },
  runway: {
    provider: 'seedance',
    surface: 'runway',
    modelId: process.env.FILM_RUNWAY_MODEL_ID || 'seedance2',
    baseUrlEnv: 'RUNWAY_BASE_URL',
    apiKeyEnv: 'RUNWAY_API_KEY',
    capabilities: seedanceCommonCapabilities,
  },
  volcengine: {
    provider: 'seedance',
    surface: 'volcengine',
    modelId: process.env.FILM_ARK_MODEL_ID || 'doubao-seedance-2-0',
    baseUrlEnv: 'ARK_BASE_URL',
    apiKeyEnv: 'ARK_API_KEY',
    capabilities: {
      ...seedanceCommonCapabilities,
      modes: ['T2V', 'I2V', 'V2V', 'R2V', 'FLF2V', 'edit', 'extend'],
    },
  },
  google: {
    provider: 'veo',
    surface: 'google',
    modelId: 'veo-3.1',
    baseUrlEnv: 'GOOGLE_GENERATIVE_AI_BASE_URL',
    apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    capabilities: {
      modes: ['T2V', 'I2V'],
      durationSec: { min: 4, max: 8 },
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      maxReferences: 3,
      supportsLastFrame: false,
      supportsAudio: true,
    },
  },
};

export const DEFAULT_FILM_SURFACE: FilmSurfaceConfig = FILM_SURFACES.fal;

export function resolveFilmSurface(input?: {
  provider?: FilmProvider;
  surface?: FilmSurfaceName | string;
}): FilmSurfaceConfig {
  if (input?.provider === 'veo' || input?.surface === 'google') {
    return FILM_SURFACES.google;
  }
  const envSurface = process.env.FILM_SURFACE?.trim() as FilmSurfaceName | undefined;
  const requested = (input?.surface || envSurface || DEFAULT_FILM_SURFACE.surface) as FilmSurfaceName;
  return FILM_SURFACES[requested] ?? DEFAULT_FILM_SURFACE;
}

// Modes that drive generation from an input image/video reference rather than
// from text alone. These MUST submit to an image-to-video endpoint; a
// text-to-video endpoint silently ignores image_url/references and produces a
// clip that does not match the supplied photo.
const IMAGE_DRIVEN_MODES: ReadonlySet<FilmGenerationMode> = new Set([
  'I2V',
  'V2V',
  'R2V',
  'FLF2V',
]);

// Resolve the actual remote model/endpoint for a (surface, mode) pair. The
// static surfaceConfig.modelId is the text-to-video default; image-driven modes
// must route to the image-to-video endpoint instead. Both are env-overridable.
export function resolveFilmModelId(
  surfaceConfig: FilmSurfaceConfig,
  mode: FilmGenerationMode,
): string {
  if (surfaceConfig.surface !== 'fal') return surfaceConfig.modelId;
  if (IMAGE_DRIVEN_MODES.has(mode)) {
    return process.env.FILM_FAL_IMAGE_MODEL_ID || 'bytedance/seedance-2.0/image-to-video';
  }
  return surfaceConfig.modelId;
}

export function validateFilmSurfaceRequest(input: {
  surfaceConfig: FilmSurfaceConfig;
  mode: FilmGenerationMode;
  durationSec?: number;
  aspectRatio?: string;
  resolution?: string;
  referenceCount?: number;
}): string[] {
  const errors: string[] = [];
  const caps = input.surfaceConfig.capabilities;
  if (!caps.modes.includes(input.mode)) {
    errors.push(`${input.surfaceConfig.surface} does not support mode ${input.mode}`);
  }
  if (typeof input.durationSec === 'number') {
    if (input.durationSec < caps.durationSec.min || input.durationSec > caps.durationSec.max) {
      errors.push(
        `${input.surfaceConfig.surface} duration must be ${caps.durationSec.min}-${caps.durationSec.max}s`,
      );
    }
  }
  if (input.aspectRatio && !caps.aspectRatios.includes(input.aspectRatio)) {
    errors.push(`${input.surfaceConfig.surface} does not support aspect ratio ${input.aspectRatio}`);
  }
  if (input.resolution && !caps.resolutions.includes(input.resolution)) {
    errors.push(`${input.surfaceConfig.surface} does not support resolution ${input.resolution}`);
  }
  if ((input.referenceCount ?? 0) > caps.maxReferences) {
    errors.push(`${input.surfaceConfig.surface} supports at most ${caps.maxReferences} references`);
  }
  return errors;
}
