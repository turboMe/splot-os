/**
 * CRM: Create/upsert lead tool (real MongoDB implementation).
 * Upserts on email (if provided) or companyName+website.
 * Replaces stub that returned mock data.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { CRM_STATUSES, CRM_SEGMENTS } from './search-leads.js';
import { crmStatusLabel, isEngagedCrmStatus } from '../../config/crm-statuses.js';
import { randomUUID } from 'crypto';

export const createLeadTool = createTool({
  id: 'crm_create_lead',
  description: 'Creates or updates a lead in the CRM (upsert by email or company). Use to add new producers/suppliers, import contacts from Gmail, or record outreach leads.',
  inputSchema: z.object({
    companyName: z.string().min(1).describe('Company name (required)'),
    email: z.string().email().optional().describe('Contact email (used as upsert key)'),
    contactName: z.string().optional(),
    phone: z.string().optional(),
    segment: z.string().optional().default('supplier_gb').describe(`Lead segment: ${CRM_SEGMENTS.join(' | ')}`),
    subsegment: z.string().optional().describe('Subsegment / subcategory within segment, e.g. "kuchnia", "sala", "bar", "marketing_gastro", "menu_food_cost"'),
    region: z.string().optional(),
    website: z.string().optional(),
    linkedIn: z.string().optional(),
    tags: z.array(z.string()).optional().default([]),
    status: z.enum(CRM_STATUSES).optional().default('research_needed'),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    skipIfEngaged: z.boolean().optional().default(false).describe(
      'When true, do nothing if a lead for this email already has a draft or has been contacted, '
      + 'and report action="skipped" with its current status. Use this for bulk outreach so the '
      + 'same company is not written to twice — check the result before generating a draft.',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    leadId: z.string().optional(),
    action: z.enum(['created', 'updated', 'skipped']).optional(),
    /** Status of the lead that caused a skip — so the caller can explain itself. */
    existingStatus: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context: any) => {
    try {
      const input = (context && typeof context === 'object' && 'context' in context && context.context) ? context.context : context;
      const db = await getDb();
      const col = db.collection('leads');
      const now = new Date();

      // Match on email (preferred) or companyName
      const matchFilter = input.email
        ? { email: input.email }
        : { companyName: { $regex: `^${input.companyName}$`, $options: 'i' } };

      const existing = await col.findOne(matchFilter);

      // Dedupe gate for bulk outreach.
      //
      // The upsert below is keyed on email, so re-running a batch never
      // DUPLICATED a lead — which made the pipeline look safe while it was not.
      // Nothing downstream was keyed on anything: the Gmail draft was created
      // again regardless, so a company already holding an unsent draft, or one
      // that was emailed yesterday, got another one today. The CRM is the only
      // record of "we already wrote to these people", so this is where the
      // question belongs, and it is answered before any draft is generated.
      if (existing && input.skipIfEngaged && isEngagedCrmStatus(existing.status as string)) {
        return {
          success: true,
          leadId: existing.id as string,
          action: 'skipped' as const,
          existingStatus: existing.status as string,
          message:
            `Pominięto ${input.companyName}: lead już istnieje ze statusem `
            + `"${crmStatusLabel(existing.status as string)}" — nie twórz kolejnego draftu.`,
        };
      }

      if (existing) {
        // Update existing
        await col.updateOne(matchFilter, {
          $set: {
            companyName: input.companyName,
            ...(input.email && { email: input.email }),
            ...(input.contactName && { contactName: input.contactName }),
            ...(input.phone && { phone: input.phone }),
            ...(input.segment && { segment: input.segment }),
            ...(input.subsegment && { subsegment: input.subsegment }),
            ...(input.region && { region: input.region }),
            ...(input.website && { website: input.website }),
            ...(input.linkedIn && { linkedIn: input.linkedIn }),
            ...(input.metadata && { metadata: { ...existing.metadata, ...input.metadata, ...(input.subsegment && { subsegment: input.subsegment }) } }),
            // Status is normally left alone: a plain upsert must not knock a
            // lead back down the funnel. Under `skipIfEngaged` it is different —
            // getting here PROVES the lead is still in a research state, and a
            // draft is about to be written for it. Leaving it at
            // `research_needed` would make tomorrow's run judge it untouched and
            // generate a second draft, which is the exact duplicate this flag
            // exists to prevent.
            ...(input.skipIfEngaged && input.status ? { status: input.status } : {}),
            updatedAt: now,
          },
          $addToSet: { tags: { $each: input.tags ?? [] } },
        });
        return {
          success: true,
          leadId: existing.id as string,
          action: 'updated' as const,
          existingStatus: (input.skipIfEngaged && input.status)
            ? input.status
            : (existing.status as string | undefined),
          message: `Lead updated: ${input.companyName}`,
        };
      }

      // Create new
      const id = randomUUID();
      await col.insertOne({
        id,
        companyName: input.companyName,
        email: input.email ?? null,
        contactName: input.contactName ?? null,
        phone: input.phone ?? null,
        segment: input.segment ?? 'supplier_gb',
        subsegment: input.subsegment ?? null,
        region: input.region ?? null,
        website: input.website ?? null,
        linkedIn: input.linkedIn ?? null,
        tags: input.tags ?? [],
        status: input.status ?? 'research_needed',
        metadata: {
          ...(input.metadata ?? {}),
          ...(input.subsegment ? { subsegment: input.subsegment } : {}),
        },
        history: [],
        createdAt: now,
        updatedAt: now,
        lastInteractionAt: now,
      });

      return { success: true, leadId: id, action: 'created' as const, message: `Lead created: ${input.companyName}` };
    } catch (error) {
      return { success: false, message: 'Error saving lead', error: (error as Error).message };
    }
  },
});
