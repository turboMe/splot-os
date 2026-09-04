/**
 * content_quality_check — deterministic quality gate for a single piece of copy.
 *
 * Ports the "gold" deterministic logic that lived inside weekly-content.ts so the
 * contentAgent can call it on demand in the `critique` phase, WITHOUT touching the
 * workflow (the workflow keeps its own copies). Re-implemented here:
 *   - LinkedIn length gate (min/max chars, env-configurable — same env knobs as the workflow)
 *   - hashtag normalization (split, validate, dedupe, cap per platform)
 *   - founder-voice anti-phrase + em/en-dash detection
 *   - anti-repetition against recent draft history (drafts-store metadata)
 *
 * This tool is advisory + deterministic: it returns issues and normalized values so
 * the agent can decide whether to revise. It does NOT mutate or save anything.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDraftsStore } from '../../lib/drafts-store.js';

// ─── Env-configurable length knobs (mirror weekly-content.ts defaults) ─────────
function resolveNumberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type PlatformKey = 'linkedin' | 'instagram' | 'tiktok';

interface PlatformGate {
  minChars: number;
  maxChars: number;
  maxHashtags: number;
}

function gateFor(platform: PlatformKey): PlatformGate {
  switch (platform) {
    case 'linkedin':
      return {
        minChars: resolveNumberEnv('WEEKLY_CONTENT_MIN_LINKEDIN_CHARS', 1000),
        maxChars: resolveNumberEnv('WEEKLY_CONTENT_MAX_LINKEDIN_CHARS', 2200),
        maxHashtags: 8,
      };
    case 'instagram':
      // IG caption hard cap is 2200; a usable caption should be at least a couple lines.
      return { minChars: 125, maxChars: 2200, maxHashtags: 15 };
    case 'tiktok':
      // TikTok caption cap (~2200). The script/shot-list live in their own Content Pack section.
      return { minChars: 50, maxChars: 2200, maxHashtags: 8 };
  }
}

// ─── Hashtag normalization (ported from weekly-content.ts) ─────────────────────
function extractHashtags(text: string): string[] {
  return Array.from(new Set(text.match(/#[\p{L}\p{N}_-]+/gu) ?? []));
}

function normalizeHashtags(value: unknown, fallbackText: string, maxCount: number): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const fromFields = rawValues
    .filter((tag): tag is string => typeof tag === 'string')
    .flatMap((tag) => tag.split(/[\s,]+/));
  const tags = [...fromFields, ...extractHashtags(fallbackText)]
    .map((tag) => tag.trim())
    .filter((tag) => /^#[\p{L}\p{N}_-]+$/u.test(tag));
  return Array.from(new Set(tags)).slice(0, maxCount);
}

// ─── Founder-voice anti-phrases (from prompts/content/domain.md) ───────────────
// Lowercased substrings that signal hype / jargon / clichés the founder voice bans.
const ANTI_PHRASES = [
  'rewolucja',
  'rewolucyjny',
  'game-changer',
  'game changer',
  'gamechanger',
  'przełomowy',
  'synergia',
  'synergii',
  'disruptive',
  'disrupt',
  'unlock',
  'unleash',
  'leverage',
  'dążymy do doskonałości',
  'lider rynku',
  'najlepszy na rynku',
  'rocket',
  'skyrocket',
  'cutting-edge',
  'cutting edge',
  'next-level',
  'next level',
  'must-have',
];

function findAntiPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return ANTI_PHRASES.filter((phrase) => lower.includes(phrase));
}

/** Detects typographic em/en dashes the founder voice replaces with a plain hyphen. */
function hasFancyDashes(text: string): boolean {
  return /[–—]/.test(text);
}

// ─── Anti-repetition vs recent draft history ───────────────────────────────────
function repetitionKey(type: string, language: string, topic: string): string {
  return `${type}:${language}:${topic}`.toLowerCase().trim();
}

export const contentQualityCheckTool = createTool({
  id: 'content_quality_check',
  description:
    'Deterministic quality gate for ONE piece of copy. Checks length bounds (LinkedIn 1000–2200 chars by default), normalizes/caps hashtags, flags founder-voice anti-phrases (hype/jargon/clichés) and typographic em/en dashes, and detects repetition against recently saved drafts (same type+language+topic). Advisory only — returns issues + normalized hashtags so you can revise before assembling. Call in the CRITIQUE phase for each post.',
  inputSchema: z.object({
    platform: z
      .enum(['linkedin', 'instagram', 'tiktok'])
      .describe('Target platform — sets the length/hashtag bounds.'),
    text: z.string().describe('The post body / caption to evaluate (the main copy, not the hashtag line).'),
    language: z.enum(['pl', 'en']).default('pl').describe('Copy language (used for anti-repetition keying).'),
    topic: z.string().optional().describe('Short topic label (used for anti-repetition keying).'),
    type: z
      .string()
      .optional()
      .describe('Draft type label, e.g. "linkedin-post", "instagram-caption", "tiktok-script". Defaults from platform.'),
    hashtags: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe('Proposed hashtags (array or space/comma-separated string). Will be normalized + capped.'),
    checkRepetition: z
      .boolean()
      .optional()
      .default(true)
      .describe('Compare against recent saved drafts to catch repeated topics (default true).'),
  }),
  outputSchema: z.object({
    passed: z.boolean().describe('true = no blocking issues (length within bounds, no duplicate).'),
    charCount: z.number(),
    bounds: z.object({ minChars: z.number(), maxChars: z.number(), maxHashtags: z.number() }),
    issues: z.array(z.string()).describe('Blocking issues (length out of bounds, duplicate topic).'),
    warnings: z.array(z.string()).describe('Non-blocking issues (anti-phrases, fancy dashes).'),
    normalizedHashtags: z.array(z.string()),
    antiPhraseHits: z.array(z.string()),
    duplicateOf: z.string().optional().describe('Repetition key of a recent draft this duplicates, if any.'),
  }),
  execute: async (context) => {
    const platform = context.platform as PlatformKey;
    const gate = gateFor(platform);
    const text = context.text ?? '';
    const charCount = text.length;
    const language = context.language ?? 'pl';
    const topic = (context.topic ?? '').trim();
    const type = context.type?.trim() || `${platform}-post`;

    const issues: string[] = [];
    const warnings: string[] = [];

    // Length gate
    if (charCount < gate.minChars) issues.push(`length:${charCount}<${gate.minChars}`);
    if (charCount > gate.maxChars) issues.push(`length:${charCount}>${gate.maxChars}`);

    // Hashtags
    const normalizedHashtags = normalizeHashtags(context.hashtags, text, gate.maxHashtags);

    // Founder voice
    const antiPhraseHits = findAntiPhrases(text);
    if (antiPhraseHits.length > 0) {
      warnings.push(`anti-phrases:${antiPhraseHits.join(',')}`);
    }
    if (hasFancyDashes(text)) {
      warnings.push('fancy-dashes: replace – or — with a plain hyphen');
    }

    // Anti-repetition
    let duplicateOf: string | undefined;
    if ((context.checkRepetition ?? true) && topic) {
      try {
        const store = getDraftsStore();
        const recent = await store.listRecentMetadata(60);
        const candidateKey = repetitionKey(type, language, topic);
        const seen = new Set(
          recent
            .filter((m) => typeof m.topic === 'string' && m.topic.trim().length > 0)
            .map((m) => repetitionKey(m.type, m.language, m.topic as string)),
        );
        if (seen.has(candidateKey)) {
          duplicateOf = candidateKey;
          issues.push(`duplicate:${candidateKey}`);
        }
      } catch {
        // history unavailable — skip repetition check rather than block
      }
    }

    return {
      passed: issues.length === 0,
      charCount,
      bounds: gate,
      issues,
      warnings,
      normalizedHashtags,
      antiPhraseHits,
      duplicateOf,
    };
  },
});
