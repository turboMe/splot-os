/**
 * content_search_exemplars / content_add_exemplar — the contentAgent's curated
 * gold library (differentiator; analog of the chef's recipe-library search).
 *
 * The agent SEARCHES exemplars during strategy/draft work to anchor on proven
 * patterns (external swipe file) and on Patryk's own voice corpus. It may ADD new
 * exemplars when it spots a strong external pattern — but qualityScore is a manual
 * judgement and source:'proven' is reserved for the human import/approval path, so
 * the library never degrades from auto-ingested model output.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { addExemplar, searchExemplars } from './content-exemplar-service.js';

export const contentSearchExemplarsTool = createTool({
  id: 'content_search_exemplars',
  description:
    'Searches the curated exemplar library — best-in-class external posts (swipe file) and Patryk\'s own voice corpus — for patterns to imitate. Use BEFORE drafting to anchor on proven hooks/structures and on the founder voice. Each hit carries whyItWorks (the curator\'s note on the mechanic) and a manual qualityScore. Adapt patterns, never copy verbatim.',
  inputSchema: z.object({
    query: z.string().min(1).describe('What you want examples of, e.g. "contrarian LinkedIn hook about supplier chaos".'),
    platform: z
      .enum(['linkedin', 'instagram', 'tiktok', 'general'])
      .optional()
      .describe('Restrict to one platform. Omit for all.'),
    source: z
      .enum(['swipe', 'voice', 'proven'])
      .optional()
      .describe('Restrict to a source: swipe (external patterns), voice (Patryk\'s own posts), proven (engagement-vetted).'),
    limit: z.number().int().min(1).max(25).optional().default(5),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    exemplars: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const exemplars = await searchExemplars(context.query, {
        platform: context.platform,
        source: context.source,
        limit: context.limit ?? 5,
      });
      return { success: true, count: exemplars.length, exemplars };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const contentAddExemplarTool = createTool({
  id: 'content_add_exemplar',
  description:
    'Adds a curated exemplar to the library: a strong EXTERNAL pattern (source="swipe") or one of Patryk\'s own posts (source="voice"), annotated with whyItWorks. Use this only for genuinely high-quality, hand-judged material — qualityScore is a manual call, not a metric. Note: source="proven" cannot be set here; engagement-vetted "proven" status is granted only through the human import/approval path, so model output never silently becomes gold.',
  inputSchema: z.object({
    content: z.string().min(1).describe('The post text / snippet.'),
    source: z
      .enum(['swipe', 'voice'])
      .describe('swipe = external best-in-class pattern; voice = Patryk\'s own published post.'),
    platform: z.enum(['linkedin', 'instagram', 'tiktok', 'general']).describe('Where this exemplar is from / for.'),
    whyItWorks: z.string().optional().describe('The curator note: WHY it works (hook, structure, trigger, framework).'),
    topic: z.string().optional().describe('Short topic/title label.'),
    tags: z.array(z.string()).optional().describe('Structural tags: hook type, format, framework (AIDA/PAS), theme.'),
    qualityScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Manual quality 0–1 (default 0.8). Reserve >0.9 for truly exceptional pieces.'),
    addedBy: z.string().optional().describe('Who curated it (e.g. "contentAgent" or a person).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    source: z.string().optional(),
    platform: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const exemplar = await addExemplar({
        content: context.content,
        source: context.source,
        platform: context.platform,
        whyItWorks: context.whyItWorks,
        topic: context.topic,
        tags: context.tags,
        qualityScore: context.qualityScore,
        addedBy: context.addedBy ?? 'content-agent',
      });
      return { success: true, id: exemplar.id, source: exemplar.source, platform: exemplar.platform };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});
