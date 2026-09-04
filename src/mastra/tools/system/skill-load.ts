/**
 * skill.load — Load full skill procedure (Phase 2.3)
 *
 * Agents use this to get the complete procedure for a discovered skill.
 * Returns the full markdown body + metadata + allowed tools.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSkillRegistry } from '../../services/skill-registry.js';
import { recordSkillView } from '../../services/skill-stats.js';

export const skillLoadTool = createTool({
  id: 'skill_load',
  description: `Load the full procedure for a skill by name.
Call this after skill.search finds a relevant skill.
Returns the complete markdown procedure, allowed tools, and metadata.

The procedure contains step-by-step instructions for executing the skill.
Follow the procedure closely for best results.`,

  inputSchema: z.object({
    skillName: z.string().describe('Exact skill name from skill.search results'),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    procedure: z.string().describe('Full markdown procedure to follow'),
    metadata: z.object({
      name: z.string(),
      description: z.string(),
      category: z.string(),
      allowedTools: z.array(z.string()),
      minComplexity: z.string().optional(),
      estimatedTokens: z.number().optional(),
      successRate: z.number().nullable(),
      totalUses: z.number(),
    }),
    error: z.string().optional(),
  }),

  execute: async (ctx) => {
    try {
      const registry = getSkillRegistry();
      const skill = await registry.load(ctx.skillName);

      // Etap 6: count the view (skill_stats) — feeds the curator's staleness.
      if (skill) void recordSkillView(ctx.skillName).catch(() => undefined);

      if (!skill) {
        return {
          success: false,
          procedure: '',
          metadata: {
            name: ctx.skillName,
            description: 'Not found',
            category: 'unknown',
            allowedTools: [],
            successRate: null,
            totalUses: 0,
          },
          error: `Skill "${ctx.skillName}" not found in registry. Use skill.search to find available skills.`,
        };
      }

      return {
        success: true,
        procedure: skill.procedure,
        metadata: {
          name: skill.metadata.name,
          description: skill.metadata.description,
          category: skill.metadata.category || 'general',
          allowedTools: skill.metadata.allowedTools || [],
          minComplexity: skill.metadata.minComplexity,
          estimatedTokens: skill.metadata.estimatedTokens,
          successRate: skill.metadata.successRate ?? null,
          totalUses: skill.metadata.totalUses || 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        procedure: '',
        metadata: {
          name: ctx.skillName,
          description: 'Error',
          category: 'unknown',
          allowedTools: [],
          successRate: null,
          totalUses: 0,
        },
        error: (error as Error).message,
      };
    }
  },
});
