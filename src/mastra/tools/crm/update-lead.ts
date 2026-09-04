/**
 * CRM: Update lead fields (real MongoDB).
 * Updates arbitrary lead fields, validates status, appends to history.
 * Throws if lead does not exist.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { CRM_STATUSES } from './search-leads.js';

export const updateLeadTool = createTool({
  id: 'crm_update_lead',
  description:
    'Updates arbitrary fields of an existing lead (companyName, segment, region, contactPerson, phone, status, metadata, etc.) and adds a history entry. Use when new information about a lead is obtained.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('Lead ID (UUID) or contact email'),
    updates: z
      .record(z.string(), z.unknown())
      .describe('Fields to overwrite, e.g., { contactPerson: "Anna", region: "Mazowsze" }'),
    reason: z.string().describe('Reason for the change (added to history)'),
    agentId: z.string().optional().default('meta-agent'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    updatedFields: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context: any) => {
    try {
      const input = (context && typeof context === 'object' && 'context' in context && context.context) ? context.context : context;
      const { idOrEmail, updates, reason, agentId } = input;
      if (Object.keys(updates).length === 0) {
        return { success: false, updatedFields: [], message: 'Empty updates set.' };
      }
      if (typeof updates.status === 'string' && !CRM_STATUSES.includes(updates.status as any)) {
        return {
          success: false,
          updatedFields: [],
          message: `Invalid status: ${updates.status}. Allowed: ${CRM_STATUSES.join(', ')}`,
        };
      }
      const db = await getDb();
      const col = db.collection('leads');
      const filter = idOrEmail.includes('@') ? { email: idOrEmail } : { id: idOrEmail };
      const existing = await col.findOne(filter);
      if (!existing) {
        return { success: false, updatedFields: [], message: `Lead not found: ${idOrEmail}` };
      }

      const now = new Date();
      const historyEntry = {
        timestamp: now,
        action: typeof updates.status === 'string' ? 'status_changed' : 'lead_updated',
        description: reason,
        agentId: agentId ?? 'meta-agent',
      };

      await col.updateOne(filter, {
        $set: { ...updates, updatedAt: now, lastInteractionAt: now },
        $push: { history: historyEntry as any },
      });

      return {
        success: true,
        updatedFields: Object.keys(updates),
        message: `Updated ${Object.keys(updates).length} fields for ${idOrEmail}`,
      };
    } catch (error) {
      return {
        success: false,
        updatedFields: [],
        message: 'Error updating lead',
        error: (error as Error).message,
      };
    }
  },
});
