/**
 * CRM: Update lead status (real MongoDB).
 * Appends to history[], updates lastInteractionAt.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { CRM_STATUSES } from './search-leads.js';

export const updateStatusTool = createTool({
  id: 'crm_update_status',
  description: 'Changes the status of a lead in the CRM and records the reason in the interaction history. Use when a lead responds, moves to the next stage, or opts out.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('Lead ID (UUID) or contact email'),
    status: z.enum(CRM_STATUSES).describe('New CRM status'),
    reason: z.string().describe('Reason for changing the status (will appear in history)'),
    agentId: z.string().optional().default('meta-agent'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context: any) => {
    try {
      const input = (context && typeof context === 'object' && 'context' in context && context.context) ? context.context : context;
      const db = await getDb();
      const col = db.collection('leads');
      const now = new Date();

      const isEmail = input.idOrEmail.includes('@');
      const filter = isEmail ? { email: input.idOrEmail } : { id: input.idOrEmail };

      const historyEntry = {
        timestamp: now,
        action: 'status_change',
        description: `Status changed to "${input.status}". Reason: ${input.reason}`,
        agentId: input.agentId ?? 'meta-agent',
      };

      const result = await col.updateOne(filter, {
        $set: { status: input.status, updatedAt: now, lastInteractionAt: now },
        $push: { history: historyEntry as any },
      });

      if (result.matchedCount === 0) {
        return { success: false, message: `Lead not found: ${context.idOrEmail}` };
      }

      return { success: true, message: `Status changed to "${context.status}" for ${context.idOrEmail}` };
    } catch (error) {
      return { success: false, message: 'Error updating status', error: (error as Error).message };
    }
  },
});
