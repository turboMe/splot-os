/**
 * skill.report_result — Feedback loop for skills (Phase 2.3)
 *
 * Agents report whether a skill execution was successful.
 * This updates the skill's success_rate in the YAML frontmatter,
 * creating a continuous improvement loop.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSkillRegistry } from '../../services/skill-registry.js';
import { recordSkillUse } from '../../services/skill-stats.js';

export const skillReportTool = createTool({
  id: 'skill_report_result',
  description: `Report the result of executing a skill. Updates the skill's success rate.
Call this after completing a skill procedure to provide feedback.
This helps the system learn which skills are reliable.`,

  inputSchema: z.object({
    skillName: z.string().describe('Skill name that was executed'),
    success: z.boolean().describe('Whether the skill procedure achieved its goal'),
    notes: z.string().optional().describe('Optional notes about what worked or failed'),
  }),

  outputSchema: z.object({
    updated: z.boolean(),
    newSuccessRate: z.number().nullable(),
    message: z.string(),
  }),

  execute: async (ctx) => {
    try {
      const registry = getSkillRegistry();
      const result = await registry.reportResult(ctx.skillName, ctx.success, ctx.notes);

      // Etap 6: mirror the outcome into skill_stats (richer counters + curator).
      void recordSkillUse(ctx.skillName, ctx.success).catch(() => undefined);

      if (!result.updated) {
        return {
          updated: false,
          newSuccessRate: null,
          message: `Skill "${ctx.skillName}" not found in registry.`,
        };
      }

      return {
        updated: true,
        newSuccessRate: result.newSuccessRate,
        message: `Skill "${ctx.skillName}" ${ctx.success ? '✅ succeeded' : '❌ failed'}. New success rate: ${result.newSuccessRate !== null ? Math.round(result.newSuccessRate * 100) + '%' : 'N/A'}`,
      };
    } catch (error) {
      return {
        updated: false,
        newSuccessRate: null,
        message: (error as Error).message,
      };
    }
  },
});
