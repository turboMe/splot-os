/**
 * skill.search — Semantic search over Skill Registry (Phase 2.3)
 *
 * Agents use this to discover available skills for a given task.
 * Returns skills ranked by relevance with metadata summary.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSkillRegistry } from '../../services/skill-registry.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

export const skillSearchTool = createTool({
  id: 'skill_search',
  description: `Search the Skill Registry for skills relevant to a task.
Returns ranked results with name, description, category, and similarity score.

Use this before starting a complex task to check if a proven procedure exists.
Example queries: "fix typescript error", "edit file safely", "run verification"`,

  inputSchema: z.object({
    query: z.string().min(3).describe('Describe the task or problem you need a skill for'),
    category: z.string().optional().describe('Filter by category (e.g., "coding", "terminal", "n8n")'),
    topK: z.number().int().min(1).max(10).default(5).describe('Max results (default 5)'),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      name: z.string(),
      description: z.string(),
      category: z.string(),
      score: z.number(),
      keywords: z.array(z.string()),
      successRate: z.number().nullable(),
      totalUses: z.number(),
    })),
    count: z.number(),
    totalSkills: z.number(),
    categories: z.record(z.string(), z.number()),
  }),

  execute: withToolEnvelope({
    toolId: 'skill_search',
    category: 'search',
    risk: 'low',
    outputPreviewMaxChars: 4000,
    execute: async (ctx) => {
    try {
      const registry = getSkillRegistry();
      const results = await registry.search(ctx.query, {
        category: ctx.category,
        topK: ctx.topK ?? 5,
      });

      return {
        success: true,
        results: results.map(r => ({
          name: r.metadata.name,
          description: r.metadata.description,
          category: r.metadata.category || 'general',
          score: Math.round(r.score * 100) / 100,
          keywords: r.metadata.keywords || [],
          successRate: r.metadata.successRate ?? null,
          totalUses: r.metadata.totalUses || 0,
        })),
        count: results.length,
        totalSkills: registry.list().length,
        categories: registry.categories(),
      };
    } catch (error) {
      return {
        success: false,
        results: [],
        count: 0,
        totalSkills: 0,
        categories: {},
      };
    }
    },
  }),
});
