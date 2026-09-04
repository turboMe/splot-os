import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  musicGenerationRunSchema,
  musicPromptSpecSchema,
  type MusicPromptSpec,
} from '../../lib/music-schemas.js';

// All music validators are pure TypeScript: the borrowed Suno prompt repos ship
// no validator scripts (unlike seedance-2.0), so there is no Python to call.
// They run pre-send (lint + safety) and post-record (generation-run) and feed
// the same { ok, errors, warnings } envelope the filmmaker validators use.

// ElevenLabs Music accepts 3_000..600_000 ms; treat that as the global bound so a
// spec is portable across surfaces. fal models accept shorter clips, so the lower
// bound is a warning, not an error.
const MIN_LENGTH_MS = 3_000;
const MAX_LENGTH_MS = 600_000;

const INSTRUMENTAL_MODES = new Set(['instrumental']);

// Phrases that almost always indicate an attempt to clone a real, identifiable
// artist or reproduce copyrighted lyrics — the surfaces reject these as content
// policy, so we catch them before spending a paid generation.
const STYLE_IMPERSONATION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(in the style of|sounds? like|clone of|imitat\w*|soundalike)\b/i, label: 'explicit artist-imitation phrasing' },
  { pattern: /\b(taylor swift|drake|beyonce|the beatles|kanye|eminem|rihanna|adele|ariana grande|billie eilish|kendrick|bad bunny)\b/i, label: 'named real recording artist' },
];

const SAFETY_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(kill|murder|rape|behead|massacre)\b/i, label: 'graphic violence' },
  { pattern: /\b(n[i1]gg\w+|f[a@]gg\w+)\b/i, label: 'slur / hate speech' },
  { pattern: /\b(child|minor|underage)\b.{0,20}\b(sex|nude|explicit)\b/i, label: 'CSAM-adjacent content' },
];

export function lintMusicPromptSpec(spec: MusicPromptSpec): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const style = spec.style_prompt.trim();
  if (!style) {
    errors.push('style_prompt is empty — every generation mode needs a style description.');
  }
  if (/^\s*[[{]/.test(style) || /"\w+"\s*:/.test(style)) {
    errors.push('style_prompt looks like JSON — send a natural-language style description, not a serialized object.');
  }
  if (style.length > 1_000) {
    warnings.push(`style_prompt is very long (${style.length} chars); most surfaces truncate well below this.`);
  }

  const isInstrumental = INSTRUMENTAL_MODES.has(String(spec.generation_mode)) || spec.vocal_type === 'instrumental';
  if (isInstrumental) {
    if (spec.lyrics.trim()) {
      warnings.push('lyrics supplied for an instrumental track — they will be ignored by the surface.');
    }
  } else if (spec.generation_mode === 'lyrics2song' && !spec.lyrics.trim()) {
    errors.push('lyrics2song requires non-empty lyrics, but lyrics is empty.');
  } else if (!spec.lyrics.trim()) {
    warnings.push('no lyrics provided for a vocal track — the model will improvise words.');
  }

  if (typeof spec.length_ms === 'number') {
    if (spec.length_ms > MAX_LENGTH_MS) {
      errors.push(`length_ms ${spec.length_ms} exceeds the ${MAX_LENGTH_MS} ms ceiling.`);
    } else if (spec.length_ms < MIN_LENGTH_MS) {
      warnings.push(`length_ms ${spec.length_ms} is below ${MIN_LENGTH_MS} ms; not all surfaces accept clips this short.`);
    }
  } else {
    warnings.push('length_ms is null — the surface default length will be used.');
  }

  if ((spec.generation_mode === 'audio2audio' || spec.generation_mode === 'extend') && spec.reference_audio.length === 0) {
    errors.push(`${spec.generation_mode} requires at least one reference_audio entry, but none was provided.`);
  }

  return { errors, warnings };
}

export const musicLintPromptTool = createTool({
  id: 'music_lint_prompt',
  description:
    'Lints a compiled music prompt-spec before generation: style prompt present and not JSON, lyrics consistent with the generation mode, length within surface bounds, reference audio present for audio2audio/extend. Pure TS, no Python.',
  inputSchema: z.object({
    spec: musicPromptSpecSchema,
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  execute: async (context) => {
    try {
      const { errors, warnings } = lintMusicPromptSpec(context.spec);
      return { ok: errors.length === 0, errors, warnings };
    } catch (error) {
      return { ok: false, errors: [(error as Error).message], warnings: [] };
    }
  },
});

export function checkMusicSafety(stylePrompt: string, lyrics: string): {
  blocked: boolean;
  issues: string[];
  warnings: string[];
} {
  const issues: string[] = [];
  const warnings: string[] = [];
  const combined = `${stylePrompt}\n${lyrics}`;

  for (const { pattern, label } of SAFETY_PATTERNS) {
    if (pattern.test(combined)) issues.push(`Prohibited content: ${label}.`);
  }
  for (const { pattern, label } of STYLE_IMPERSONATION_PATTERNS) {
    if (pattern.test(stylePrompt)) {
      warnings.push(`Possible artist impersonation (${label}) — rephrase as descriptive genre/era/instrumentation; surfaces may refuse.`);
    }
  }

  return { blocked: issues.length > 0, issues, warnings };
}

export const musicCheckSafetyTool = createTool({
  id: 'music_check_safety',
  description:
    'Scans the style prompt + lyrics for content the music surfaces reject (artist impersonation, copyrighted-lyric reproduction, hate speech, graphic violence, CSAM-adjacent content). Returns issues and whether user confirmation is required before a paid generation.',
  inputSchema: z.object({
    stylePrompt: z.string().default(''),
    lyrics: z.string().default(''),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    blocked: z.boolean(),
    requiresUserConfirmation: z.boolean(),
    issues: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  execute: async (context) => {
    const { blocked, issues, warnings } = checkMusicSafety(context.stylePrompt ?? '', context.lyrics ?? '');
    return {
      ok: !blocked,
      blocked,
      requiresUserConfirmation: warnings.length > 0,
      issues,
      warnings,
    };
  },
});

export const musicCheckGenerationRunTool = createTool({
  id: 'music_check_generation_run',
  description:
    'Validates a music generation-run ledger row against the schema and cross-field invariants (synthetic fixtures must not claim an output URL; generated/accepted runs must carry an audio path or URL). Pure TS, no Python.',
  inputSchema: z.object({
    run: z.unknown(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  execute: async (context) => {
    const parsed = musicGenerationRunSchema.safeParse(context.run);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        warnings: [],
      };
    }

    const run = parsed.data;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (run.is_synthetic_fixture) {
      if (run.result_status !== 'not_run_fixture') {
        errors.push(`synthetic fixture must have result_status 'not_run_fixture', got '${run.result_status}'.`);
      }
      if (run.output_url || run.audio_path) {
        errors.push('synthetic fixture must not carry a real output_url or audio_path.');
      }
    } else if (run.result_status === 'generated' || run.result_status === 'accepted') {
      if (!run.audio_path && !run.output_url) {
        errors.push(`run with status '${run.result_status}' must carry an audio_path or output_url.`);
      }
    }

    if (run.result_status === 'rejected' && !run.error) {
      warnings.push('rejected run has no error string — record why it failed for the repair loop.');
    }

    return { ok: errors.length === 0, errors, warnings };
  },
});
