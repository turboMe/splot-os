/**
 * Workflow: automated-followup
 * Sprawdza leady bez odpowiedzi od X dni, generuje follow-up drafty.
 * Etap 6 – marketing workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { marketingAgent } from '../../agents/marketing-agent';
import { getDb } from '../../lib/mongo';

const findStaleLeadsStep = createStep({
  id: 'find-stale-leads',
  description: 'Wyszukuje leady, które nie odpowiedziały od podanej liczby dni (z pominięciem opt-out).',
  inputSchema: z.object({
    daysWithoutResponse: z.number().default(7),
    maxLeads: z.number().default(10),
    status: z.string().default('sent'),
  }),
  outputSchema: z.object({
    staleLeads: z.array(z.object({
      id: z.string(),
      companyName: z.string(),
      email: z.string(),
      segment: z.string().optional(),
      contactName: z.string().optional(),
      lastInteractionAt: z.string(),
      daysStale: z.number(),
      metadata: z.any(),
    })),
    count: z.number(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const cutoff = new Date(Date.now() - context.inputData.daysWithoutResponse * 24 * 3600 * 1000);

    const leads = await db.collection('leads')
      .find({
        status: context.inputData.status,
        lastInteractionAt: { $lt: cutoff },
        email: { $exists: true, $ne: null },
        'metadata.doNotContact': { $ne: true },
      })
      .sort({ lastInteractionAt: 1 })
      .limit(context.inputData.maxLeads)
      .toArray();

    const staleLeads = leads.map(l => ({
      id: l.id ?? String(l._id),
      companyName: l.companyName ?? '',
      email: l.email ?? '',
      segment: l.segment ?? 'supplier_gb',
      contactName: l.contactName,
      lastInteractionAt: l.lastInteractionAt?.toISOString() ?? '',
      daysStale: Math.floor((Date.now() - new Date(l.lastInteractionAt ?? 0).getTime()) / (24 * 3600 * 1000)),
      metadata: l.metadata ?? {},
    }));

    return { staleLeads, count: staleLeads.length };
  },
});

const generateFollowupDraftsStep = createStep({
  id: 'generate-followup-drafts',
  description: 'Marketing Agent generuje personalizowane follow-up drafty zgodne z RODO i Permission Outreach.',
  inputSchema: z.object({
    staleLeads: z.array(z.object({
      id: z.string(),
      companyName: z.string(),
      email: z.string(),
      segment: z.string().optional(),
      contactName: z.string().optional(),
      lastInteractionAt: z.string(),
      daysStale: z.number(),
      metadata: z.any(),
    })),
    count: z.number(),
  }),
  outputSchema: z.object({
    drafts: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      account: z.enum(['gastrobridge', 'personal']),
      subject: z.string(),
      body: z.string(),
    })),
    generatedCount: z.number(),
  }),
  execute: async (context) => {
    if (context.inputData.count === 0) {
      return { drafts: [], generatedCount: 0 };
    }

    const prompt = `Jesteś Patrykiem (GastroBridge / Automation & AI / Web Dev / Career). Wygeneruj follow-up emaile dla ${context.inputData.count} leadów, którzy nie odpowiedzieli na poprzednią wiadomość.

## Leady bez odpowiedzi:
${context.inputData.staleLeads.map(l =>
  `- **${l.companyName}** (${l.email}) [Segment: ${l.segment ?? 'supplier_gb'}] — ${l.daysStale} dni bez odpowiedzi. ${l.contactName ? `Kontakt: ${l.contactName}.` : ''} ${l.metadata?.lastEmailSent?.subject ? `Poprzedni temat: "${l.metadata.lastEmailSent.subject}"` : ''}`
).join('\n')}

## Zasady tonu i prawa:
1. Bardzo krótki (2-3 zdania), naturalny, nienatarczywy follow-up.
2. Odwołaj się do poprzedniego maila (np. nawiązanie do lokalnych restauracji / marży na produktach / platformy / automatyzacji procesów).
3. Zero korpomowy, zero emoji.
4. Zakończ jasnym, niewymuszonym pytaniem o zgodę na rozmowę lub informacją, że jeśli temat nie jest aktualny, wystarczy jedno słowo, a nie ponowimy kontaktu.

Zwróć JSON: { "drafts": [{ "leadId": "...", "email": "...", "subject": "...", "body": "..." }] }`;

    const result = await marketingAgent.generate(prompt);
    let rawDrafts: Array<{ leadId: string; email: string; subject: string; body: string }> = [];

    try {
      const match = result.text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonStr = match ? match[1] : result.text;
      const parsed = JSON.parse(jsonStr);
      rawDrafts = parsed.drafts ?? [];
    } catch {
      console.warn('[automated-followup] Nie udało się sparsować JSON z LLM');
    }

    // Inject emails and account from leads map
    const leadMap = new Map(context.inputData.staleLeads.map(l => [l.id, l]));
    const drafts = rawDrafts.map(d => {
      const lead = leadMap.get(d.leadId);
      const email = d.email || lead?.email || '';
      const segment = lead?.segment ?? 'supplier_gb';
      const isPersonal = segment.startsWith('career_') || segment === 'automation' || segment === 'web_dev';
      const account: 'gastrobridge' | 'personal' = lead?.metadata?.accountUsed ?? (isPersonal ? 'personal' : 'gastrobridge');
      return {
        leadId: d.leadId,
        email,
        account,
        subject: d.subject,
        body: d.body,
      };
    });

    return { drafts, generatedCount: drafts.length };
  },
});

const saveDraftsStep = createStep({
  id: 'save-followup-drafts',
  description: 'Zapisuje wygenerowane follow-up drafty w Gmailu i metadata leadów.',
  inputSchema: z.object({
    drafts: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      account: z.enum(['gastrobridge', 'personal']),
      subject: z.string(),
      body: z.string(),
    })),
    generatedCount: z.number(),
  }),
  outputSchema: z.object({
    savedCount: z.number(),
    leadIds: z.array(z.string()),
  }),
  execute: async (context) => {
    const db = await getDb();
    let savedCount = 0;
    const leadIds: string[] = [];
    const now = new Date();

    for (const draft of context.inputData.drafts) {
      const queryOr: any[] = [{ id: draft.leadId }];
      if (ObjectId.isValid(draft.leadId)) {
        queryOr.push({ _id: new ObjectId(draft.leadId) });
      }
      if (draft.email) {
        queryOr.push({ email: draft.email });
      }

      const updateRes = await db.collection('leads').updateOne(
        { $or: queryOr },
        {
          $set: {
            status: 'draft_gotowy',
            'metadata.accountUsed': draft.account,
            'metadata.followup_draft': {
              subject: draft.subject,
              body: draft.body,
              account: draft.account,
              createdAt: now.toISOString(),
            },
            updatedAt: now,
            lastInteractionAt: now,
          },
          $push: {
            history: {
              timestamp: now,
              action: 'followup_draft_created',
              description: `Follow-up draft przygotowany dla skrzynki [${draft.account}]: "${draft.subject}"`,
              agentId: 'automated-followup-workflow',
              metadata: { account: draft.account },
            } as any,
          },
        },
      );
      if (updateRes.matchedCount > 0) {
        savedCount++;
        leadIds.push(draft.leadId);
      }
    }

    return { savedCount, leadIds };
  },
});

export const automatedFollowupWorkflow = createWorkflow({
  id: 'automated-followup',
  description: 'Wyszukuje leady bez odpowiedzi i generuje personalizowane follow-up drafty.',
  inputSchema: z.object({
    daysWithoutResponse: z.number().default(7),
    maxLeads: z.number().default(10),
    status: z.string().default('sent'),
  }),
  outputSchema: z.object({
    savedCount: z.number(),
    leadIds: z.array(z.string()),
  }),
})
  .then(findStaleLeadsStep)
  .then(generateFollowupDraftsStep)
  .then(saveDraftsStep);

automatedFollowupWorkflow.commit();
