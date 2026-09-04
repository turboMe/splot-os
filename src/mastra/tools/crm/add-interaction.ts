/**
 * CRM: Add interaction/note to lead history (real MongoDB).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { withIdempotency } from '../../services/idempotency.js';

export const addInteractionTool = createTool({
  id: 'crm_add_interaction',
  description: 'Adds a note or interaction record to a lead\'s history (meeting, email, phone call, draft). Does not change the status — use crm.update_status if the status is also changing.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('Lead ID (UUID) or contact email'),
    action: z.string().optional().default('note').describe('Action type: note, call, meeting, email, draft_created, draft_sent'),
    description: z.string().describe('Interaction description (will appear in lead history)'),
    agentId: z.string().optional().default('meta-agent'),
    idempotencyKey: z.string().optional().describe('Optional dedup key (e.g. laneId+step). Defaults to a hash of the interaction so retries do not append twice.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context: any) => {
    try {
      const input = (context && typeof context === 'object' && 'context' in context && context.context) ? context.context : context;
      // Etap 5: crm_add_interaction appends via $push — a retry would duplicate
      // the history entry. Dedup on (lead + action + description).
      const { result } = await withIdempotency(
        {
          toolId: 'crm_add_interaction',
          input: { idOrEmail: input.idOrEmail, action: input.action, description: input.description },
          explicitKey: (input as { idempotencyKey?: string }).idempotencyKey,
        },
        async () => {
          const db = await getDb();
          const col = db.collection('leads');
          const now = new Date();

          const isEmail = input.idOrEmail.includes('@');
          const filter = isEmail ? { email: input.idOrEmail } : { id: input.idOrEmail };

          const historyEntry = {
            timestamp: now,
            action: input.action ?? 'note',
            description: input.description,
            agentId: input.agentId ?? 'meta-agent',
          };

          const res = await col.updateOne(filter, {
            $push: { history: historyEntry as any },
            $set: { lastInteractionAt: now, updatedAt: now },
          });

          if (res.matchedCount === 0) {
            return { success: false as const, message: `Lead not found: ${input.idOrEmail}` };
          }
          return { success: true as const, message: `Interaction added to ${input.idOrEmail}: ${input.action}` };
        },
      );
      return result;
    } catch (error) {
      return { success: false, message: 'Error saving interaction', error: (error as Error).message };
    }
  },
});
