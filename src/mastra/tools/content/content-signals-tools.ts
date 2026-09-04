/**
 * content_fetch_signals — fresh-signal research tool for the contentAgent.
 *
 * Wraps the deterministic freshness layer that the weekly-content workflow relies on:
 *  - searchFreshContentSignals (lib/content-signals.ts) → scored RSS signals for the
 *    week window (content_signals collection, falling back to rss_articles), already
 *    carrying hooks/bestAngles/whyItMatters.
 *  - rss_get_digests (tools/rss/rss-tools.ts) → recent editorial digests as a backdrop.
 *
 * The agent calls this in the `research` phase to ground drafts in real, dated sources
 * instead of inventing news. Signal selection / quality gating stays the agent's job
 * (it reasons over the returned list); this tool only fetches.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { searchFreshContentSignals } from '../../lib/content-signals.js';
import { rssGetDigestsTool } from '../rss/rss-tools.js';

const freshSignalHookSchema = z.object({
  hook: z.string(),
  bestFor: z.string(),
  angle: z.string(),
});

const freshSignalSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  sourceName: z.string(),
  url: z.string(),
  publishedAt: z.string(),
  summary: z.string(),
  whyItMatters: z.string(),
  language: z.string(),
  country: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  bestAngles: z.array(z.string()),
  hooks: z.array(freshSignalHookSchema),
  score: z.number(),
  confidence: z.number(),
  novelty: z.number(),
});

/** Default week anchor = today (ISO date) when the caller doesn't pass one. */
function defaultWeekDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export const contentFetchSignalsTool = createTool({
  id: 'content_fetch_signals',
  description:
    'Fetches fresh, dated content signals (scored RSS items with ready-made hooks/angles) plus recent editorial digests for the target week. Use in the RESEARCH phase to ground posts in real sources — never invent news or numbers. Returns each signal with id, title, source, url, publishedAt, summary, whyItMatters, hooks[] and scores so you can pick the strongest angles. Signal ids can later be passed to content_save_draft so used signals are marked.',
  inputSchema: z.object({
    weekDate: z
      .string()
      .optional()
      .describe('Week anchor (ISO date, e.g. 2026-06-15). Defaults to today. The search window is roughly -14d/+8d around it.'),
    language: z
      .string()
      .optional()
      .describe('Filter signals by language (e.g. "pl" or "en"). Omit to get all languages.'),
    limit: z
      .number()
      .optional()
      .default(12)
      .describe('Max signals to return (1–50, clamped). Default 12.'),
    minRelevance: z
      .number()
      .optional()
      .describe('Minimum relevance score 0–1 (default 0.6). Lower it if too few signals come back.'),
    excludeUsed: z
      .boolean()
      .optional()
      .default(true)
      .describe('Skip signals already used in a previous content run (default true).'),
    digestLimit: z
      .number()
      .optional()
      .default(3)
      .describe('How many recent RSS digests to include as editorial backdrop. Default 3.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    weekDate: z.string(),
    signalCount: z.number(),
    signals: z.array(freshSignalSchema),
    digests: z.array(z.any()),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const weekDate = context.weekDate?.trim() || defaultWeekDate();
    try {
      const signals = await searchFreshContentSignals({
        weekDate,
        language: context.language,
        limit: context.limit ?? 12,
        minRelevance: context.minRelevance,
        excludeUsed: context.excludeUsed ?? true,
      });

      // Digests are best-effort context — a failure here must not sink the whole fetch.
      let digests: unknown[] = [];
      try {
        const digestResult = (await rssGetDigestsTool.execute!(
          { limit: context.digestLimit ?? 3 } as any,
          {} as any,
        )) as { success?: boolean; digests?: unknown[] };
        if (digestResult?.success && Array.isArray(digestResult.digests)) {
          digests = digestResult.digests;
        }
      } catch {
        // ignore — signals are the primary payload
      }

      return {
        success: true,
        weekDate,
        signalCount: signals.length,
        signals,
        digests,
      };
    } catch (err: any) {
      return {
        success: false,
        weekDate,
        signalCount: 0,
        signals: [],
        digests: [],
        error: err.message,
      };
    }
  },
});
