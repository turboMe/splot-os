/**
 * Workflow: inbox-monitor
 * Skanuje Gmail w poszukiwaniu odpowiedzi od leadów, kategoryzuje je
 * i generuje draft odpowiedzi lub aktualizuje CRM.
 * Etap 6 – marketing workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { marketingAgent } from '../../agents/marketing-agent';
import { getDb } from '../../lib/mongo';
import { syncAllMailboxes } from '../../tools/google/gmail.js';

/* ─────────────────────────────────────────────
   Step 1: scan Gmail for lead replies across all mailboxes
───────────────────────────────────────────── */
const scanInboxStep = createStep({
  id: 'scan-inbox',
  description: 'Przeszukuje skrzynki Gmail (GastroBridge & Personal) w poszukiwaniu odpowiedzi od leadów z ostatnich N godzin.',
  inputSchema: z.object({
    hoursBack: z.number().default(24),
    maxResults: z.number().default(50),
  }),
  outputSchema: z.object({
    emails: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      to: z.string().optional(),
      account: z.string().optional(),
      subject: z.string(),
      snippet: z.string(),
      receivedAt: z.string(),
    })),
    emailCount: z.number(),
    knownLeadEmails: z.array(z.string()),
  }),
  execute: async (context) => {
    const db = await getDb();
    const cutoff = new Date(Date.now() - context.inputData.hoursBack * 3600 * 1000);

    // 1. Sync live messages from all configured mailboxes
    await syncAllMailboxes({ hoursBack: context.inputData.hoursBack, maxResults: context.inputData.maxResults });

    // 2. Get all known lead emails for filtering
    const leads = await db.collection('leads')
      .find({ email: { $exists: true, $ne: null } })
      .project({ email: 1 })
      .toArray();
    const knownLeadEmails = leads.map((l) => (l.email as string).toLowerCase());

    // 3. Fetch recent inbound messages
    const recentEmails = await db.collection('gmail_messages')
      .find({
        receivedAt: { $gte: cutoff.toISOString() },
        direction: 'inbound',
      })
      .sort({ receivedAt: -1 })
      .limit(context.inputData.maxResults)
      .toArray();

    const emails = recentEmails.map((m) => ({
      messageId: String(m.messageId ?? m._id),
      from: String(m.from ?? ''),
      to: m.to ? String(m.to) : undefined,
      account: m.account ? String(m.account) : undefined,
      subject: String(m.subject ?? '(bez tematu)'),
      snippet: String((m.snippet ?? m.body ?? '').slice(0, 300)),
      receivedAt: String(m.receivedAt ?? ''),
    }));

    return { emails, emailCount: emails.length, knownLeadEmails };
  },
});

/* ─────────────────────────────────────────────
   Step 2: categorize & generate draft responses
───────────────────────────────────────────── */
/* ─────────────────────────────────────────────
   Step 2: categorize & generate draft responses
───────────────────────────────────────────── */
const categoryEnum = z.enum([
  'positive',
  'negative',
  'question',
  'meeting_request',
  'timing_delay',
  'opt_out',
  'other',
]);

const categorizeAndDraftStep = createStep({
  id: 'categorize-and-draft',
  description: 'Marketing Agent kategoryzuje emaile i generuje draft odpowiedzi z poszanowaniem RODO.',
  inputSchema: z.object({
    emails: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      to: z.string().optional(),
      account: z.string().optional(),
      subject: z.string(),
      snippet: z.string(),
      receivedAt: z.string(),
    })),
    emailCount: z.number(),
    knownLeadEmails: z.array(z.string()),
  }),
  outputSchema: z.object({
    categorized: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      account: z.string().optional(),
      subject: z.string(),
      category: categoryEnum,
      isKnownLead: z.boolean(),
      snoozeUntil: z.string().optional(),
      draftReply: z.string().optional(),
      action: z.string(),
    })),
    summary: z.string(),
  }),
  execute: async (context) => {
    if (context.inputData.emailCount === 0) {
      return {
        categorized: [],
        summary: 'Brak nowych wiadomości do przeanalizowania.',
      };
    }

    const knownSet = new Set(context.inputData.knownLeadEmails);
    const emailAccountMap = new Map<string, string>();
    for (const e of context.inputData.emails) {
      if (e.account) emailAccountMap.set(e.messageId, e.account);
    }

    const prompt = `Jesteś Agentem Marketingu GastroBridge. Przeanalizuj ${context.inputData.emailCount} wiadomości emailowych.

## Wiadomości do kategoryzacji:
${context.inputData.emails.map((e, i) => `
### Email ${i + 1}
- ID: ${e.messageId}
- Od: ${e.from}
- Skrzynka docelowa: ${e.account ?? 'gastrobridge'}
- Temat: ${e.subject}
- Treść (fragment): ${e.snippet}
- Otrzymano: ${e.receivedAt}
- Znany lead: ${knownSet.has(e.from.toLowerCase()) ? 'TAK' : 'NIE'}
`).join('\n')}

## Zadanie
Dla KAŻDEGO emaila:
1. Przypisz dokładnie 1 kategorię:
   - positive: zainteresowanie ofertą / chęć rejestracji lub współpracy
   - meeting_request: prośba o rozmowę / demo / spotkanie
   - question: pytanie o szczegóły, cennik, działanie, integracje
   - timing_delay: prośba o kontakt w późniejszym terminie (np. "odezwijcie się po sezonie / za 2 miesiące")
   - negative: standardowa odmowa ("nie dziękuję", "nie jesteśmy zainteresowani")
   - opt_out: żądanie usunięcia adresu / RODO / zakaz dalszego kontaktu ("proszę usunąć z bazy", "nie pisać więcej", "wypisać")
   - other: autoprzypomnienie, newsletter, spam
2. Jeśli timing_delay — wskaż szacowaną datę lub okres wznowienia w polu snoozeUntil (np. "2026-10-01").
3. Jeśli positive / meeting_request / question — napisz krótki (2-3 zdania), naturalny draft odpowiedzi po polsku w głosie Patryka (konkretny, partnerski, bez zbędnej waty).
4. Jeśli negative lub opt_out — NIE twórz draftu odpowiedzi (draftReply = null).
5. Określ recommended action (np. "zaplanuj demo w kalendarzu", "oznacz RODO opt-out w CRM", "uśpij do kolejnego kwartału", "odpisz na pytanie").

Zwróć JSON:
{
  "results": [
    {
      "messageId": "...",
      "from": "...",
      "subject": "...",
      "category": "positive|negative|question|meeting_request|timing_delay|opt_out|other",
      "isKnownLead": true/false,
      "snoozeUntil": "YYYY-MM-DD (opcjonalnie)",
      "draftReply": "...",
      "action": "..."
    }
  ],
  "summary": "Krótkie podsumowanie skanu (1-2 zdania)"
}`;

    const result = await marketingAgent.generate(prompt);
    let categorized: {
      messageId: string;
      from: string;
      account?: string;
      subject: string;
      category: 'positive' | 'negative' | 'question' | 'meeting_request' | 'timing_delay' | 'opt_out' | 'other';
      isKnownLead: boolean;
      snoozeUntil?: string;
      draftReply?: string;
      action: string;
    }[] = [];
    let summary = '';

    try {
      const match = result.text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonStr = match ? match[1] : result.text;
      const parsed = JSON.parse(jsonStr);
      categorized = (parsed.results ?? []).map((r: any) => ({
        messageId: String(r.messageId ?? ''),
        from: String(r.from ?? ''),
        account: emailAccountMap.get(String(r.messageId ?? '')) ?? 'gastrobridge',
        subject: String(r.subject ?? ''),
        category: (['positive', 'negative', 'question', 'meeting_request', 'timing_delay', 'opt_out', 'other'].includes(r.category)
          ? r.category
          : 'other') as any,
        isKnownLead: knownSet.has((r.from ?? '').toLowerCase()),
        snoozeUntil: r.snoozeUntil ? String(r.snoozeUntil) : undefined,
        draftReply: r.draftReply ? String(r.draftReply) : undefined,
        action: String(r.action ?? ''),
      }));
      summary = String(parsed.summary ?? '');
    } catch {
      summary = 'Nie udało się sparsować odpowiedzi agenta.';
    }

    return { categorized, summary };
  },
});

/* ─────────────────────────────────────────────
   Step 3: update CRM + save drafts
───────────────────────────────────────────── */
const applyActionsStep = createStep({
  id: 'apply-actions',
  description: 'Aktualizuje CRM i zapisuje draft odpowiedzi w bazie z obsługą RODO/Opt-Out.',
  inputSchema: z.object({
    categorized: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      account: z.string().optional(),
      subject: z.string(),
      category: categoryEnum,
      isKnownLead: z.boolean(),
      snoozeUntil: z.string().optional(),
      draftReply: z.string().optional(),
      action: z.string(),
    })),
    summary: z.string(),
  }),
  outputSchema: z.object({
    updatedLeads: z.number(),
    savedDrafts: z.number(),
    optOutsCount: z.number(),
    summary: z.string(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();
    let updatedLeads = 0;
    let savedDrafts = 0;
    let optOutsCount = 0;

    for (const item of context.inputData.categorized) {
      // Extract exact email from "Name <email@domain.com>" or clean email
      const fromMatch = item.from.match(/<(.+?)>/) ?? [null, item.from];
      const fromEmail = (fromMatch[1] ?? item.from).toLowerCase().trim();

      if (item.isKnownLead || fromEmail) {
        let newStatus: string | undefined;
        const update: Record<string, any> = {
          lastInteractionAt: now,
          updatedAt: now,
          'metadata.lastMailboxAccount': item.account ?? 'gastrobridge',
        };

        if (item.category === 'opt_out') {
          newStatus = 'odrzucony';
          update['metadata.doNotContact'] = true;
          update['metadata.optOutDate'] = now.toISOString();
          update['metadata.optOutReason'] = 'inbox_reply_opt_out';
          optOutsCount++;
        } else if (item.category === 'negative') {
          newStatus = 'odrzucony';
        } else if (item.category === 'timing_delay') {
          newStatus = 'uśpiony';
          if (item.snoozeUntil) {
            update['metadata.snoozeUntil'] = item.snoozeUntil;
          }
        } else if (item.category === 'positive' || item.category === 'meeting_request' || item.category === 'question') {
          newStatus = 'odpowiedział';
        }

        if (newStatus) update.status = newStatus;

        // Strict case-insensitive full email match
        const escapedEmail = fromEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const updateRes = await db.collection('leads').updateOne(
          { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
          {
            $set: update,
            $push: {
              history: {
                timestamp: now,
                action: item.category === 'opt_out' ? 'lead_opt_out' : 'email_received',
                description: `Otrzymano odpowiedź (${item.category}) na skrzynkę [${item.account ?? 'gastrobridge'}]: ${item.subject}`,
                agentId: 'inbox-monitor-workflow',
              } as any,
            },
          },
        );

        if (updateRes.matchedCount > 0) {
          updatedLeads++;
        }
      }

      // Save draft reply if generated and not opted-out
      if (item.draftReply && item.category !== 'opt_out') {
        await db.collection('inbox_drafts').insertOne({
          messageId: item.messageId,
          from: item.from,
          account: item.account ?? 'gastrobridge',
          subject: item.subject,
          category: item.category,
          draftReply: item.draftReply,
          action: item.action,
          createdAt: now,
          status: 'pending',
        });
        savedDrafts++;
      }
    }

    // Store summary in shared memory
    if (context.inputData.summary) {
      await db.collection('shared_memory').updateOne(
        { key: `inbox-monitor-${now.toISOString().split('T')[0]}` },
        {
          $set: {
            key: `inbox-monitor-${now.toISOString().split('T')[0]}`,
            type: 'signal',
            sourceAgent: 'inbox-monitor-workflow',
            content: context.inputData.summary,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
          },
        },
        { upsert: true },
      );
    }

    return { updatedLeads, savedDrafts, optOutsCount, summary: context.inputData.summary };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const inboxMonitorWorkflow = createWorkflow({
  id: 'inbox-monitor',
  description: 'Skanuje Gmail, kategoryzuje odpowiedzi od leadów i generuje draft replik.',
  inputSchema: z.object({
    hoursBack: z.number().default(24),
    maxResults: z.number().default(20),
  }),
  outputSchema: z.object({
    updatedLeads: z.number(),
    savedDrafts: z.number(),
    optOutsCount: z.number(),
    summary: z.string(),
  }),
})
  .then(scanInboxStep)
  .then(categorizeAndDraftStep)
  .then(applyActionsStep);

inboxMonitorWorkflow.commit();
