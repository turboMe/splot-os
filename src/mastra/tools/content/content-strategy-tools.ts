/**
 * content_query_strategy — thin, opinionated wrapper over knowledge_query that is
 * pinned to the `content-strategy` NotebookLM notebook (the curated library of
 * articles on virality / copywriting / per-platform best practices).
 *
 * Why a dedicated tool instead of reusing knowledge_query directly: the agent must
 * NOT have to remember the notebook name or risk querying the wrong one. This tool
 * always routes to content-strategy and frames it for "HOW to write well" questions,
 * keeping the docs notebook (WHAT is true about the business) cleanly separate.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { knowledgeQueryTool } from '../knowledge/knowledge-tools.js';

const CONTENT_STRATEGY_NOTEBOOK = 'content-strategy';

export const contentQueryStrategyTool = createTool({
  id: 'content_query_strategy',
  description:
    'Asks the curated "content-strategy" knowledge base HOW to write high-performing social content: virality mechanics (STEPPS), hook patterns, copywriting frameworks (AIDA/PAS/BAB), and per-platform best practices for LinkedIn / Instagram / TikTok. Use this for craft/technique questions. (For facts about the business or about Patryk, query the "docs" notebook via knowledge_query instead.)',
  inputSchema: z.object({
    question: z
      .string()
      .describe('A craft question, e.g. "What hook structures work best for LinkedIn thought-leadership posts?"'),
    timeout: z
      .number()
      .optional()
      .default(120)
      .describe('Timeout in seconds (default 120).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    answer: z.string().optional(),
    citations: z.array(z.string()).optional(),
    notebook: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    return (await knowledgeQueryTool.execute!(
      {
        notebook: CONTENT_STRATEGY_NOTEBOOK,
        question: context.question,
        timeout: context.timeout ?? 120,
      } as any,
      {} as any,
    )) as {
      success: boolean;
      answer?: string;
      citations?: string[];
      notebook: string;
      error?: string;
    };
  },
});
