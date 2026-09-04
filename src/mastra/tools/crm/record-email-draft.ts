/**
 * CRM: Record email draft in lead metadata (real MongoDB).
 * Sets status to 'draft_gotowy', stores draft (subject + body + ids) in metadata.draft,
 * does NOT overwrite enrichment data in metadata. Appends to history.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

export const recordEmailDraftTool = createTool({
  id: 'crm_record_email_draft',
  description:
    'Saves the current email draft to the lead (metadata.draft) without overwriting other metadata. Sets status to "draft_gotowy" and adds an entry to history.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('Lead ID (UUID) or contact email'),
    draft: z.object({
      subject: z.string(),
      body: z.string(),
      draftId: z.string().optional().describe('Local draft identifier (e.g., from DraftsStore)'),
      gmailDraftId: z.string().optional().describe('Identifier from Gmail API'),
      sourceDraftId: z.string().optional().describe('Parent draft identifier if this is a variant'),
    }),
    reason: z.string().describe('Reason (added to history)'),
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
      const filter = input.idOrEmail.includes('@')
        ? { email: input.idOrEmail }
        : { id: input.idOrEmail };

      const historyEntry = {
        timestamp: now,
        action: 'draft_recorded',
        description: input.reason,
        agentId: input.agentId ?? 'meta-agent',
      };

      const result = await col.updateOne(filter, {
        $set: {
          status: 'draft_gotowy',
          'metadata.draft': { ...input.draft, updatedAt: now },
          updatedAt: now,
          lastInteractionAt: now,
        },
        $push: { history: historyEntry as any },
      });

      if (result.matchedCount === 0) {
        return { success: false, message: `Lead not found: ${input.idOrEmail}` };
      }

      return { success: true, message: `Draft recorded for ${input.idOrEmail}` };
    } catch (error) {
      return {
        success: false,
        message: 'Error saving draft',
        error: (error as Error).message,
      };
    }
  },
});
