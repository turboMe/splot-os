/**
 * Workflow: sync-crm
 * Synchronizuje wysłane emaile z Gmaila do CRM — aktualizuje
 * historię interakcji i statusy leadów.
 * Etap 6 – marketing workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { getDb } from '../../lib/mongo';
import { syncAllMailboxes } from '../../tools/google/gmail.js';

/* ─────────────────────────────────────────────
   Step 1: fetch sent emails from gmail_messages
───────────────────────────────────────────── */
const fetchSentEmailsStep = createStep({
  id: 'fetch-sent-emails',
  description: 'Pobiera wysłane wiadomości z kolekcji gmail_messages od ostatniej synchronizacji ze wszystkich skrzynek.',
  inputSchema: z.object({
    hoursBack: z.number().default(24),
    maxEmails: z.number().default(50),
  }),
  outputSchema: z.object({
    sentEmails: z.array(z.object({
      messageId: z.string(),
      account: z.string().optional(),
      to: z.string(),
      subject: z.string(),
      snippet: z.string(),
      sentAt: z.string(),
      threadId: z.string(),
    })),
    count: z.number(),
    lastSyncAt: z.string(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const cutoff = new Date(Date.now() - context.inputData.hoursBack * 3600 * 1000);

    // 1. Sync live messages from all configured mailboxes
    await syncAllMailboxes({ hoursBack: context.inputData.hoursBack, maxResults: context.inputData.maxEmails });

    // 2. Check last sync timestamp
    const syncMeta = await db.collection('sync_meta').findOne({ key: 'crm-gmail-sync' });
    const lastSyncAt = syncMeta?.lastSyncAt ?? cutoff.toISOString();
    const since = new Date(lastSyncAt);

    const emails = await db.collection('gmail_messages')
      .find({
        direction: 'outbound',
        sentAt: { $gte: since.toISOString() },
      })
      .sort({ sentAt: -1 })
      .limit(context.inputData.maxEmails)
      .toArray();

    const sentEmails = emails.map((m) => ({
      messageId: String(m.messageId ?? m._id),
      account: m.account ? String(m.account) : undefined,
      to: String(m.to ?? ''),
      subject: String(m.subject ?? ''),
      snippet: String((m.snippet ?? m.body ?? '').slice(0, 200)),
      sentAt: String(m.sentAt ?? ''),
      threadId: String(m.threadId ?? ''),
    }));

    return {
      sentEmails,
      count: sentEmails.length,
      lastSyncAt,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 2: match emails to leads & update CRM
───────────────────────────────────────────── */
const matchAndSyncStep = createStep({
  id: 'match-and-sync',
  description: 'Dopasowuje emaile do leadów w CRM i aktualizuje historię interakcji.',
  inputSchema: z.object({
    sentEmails: z.array(z.object({
      messageId: z.string(),
      account: z.string().optional(),
      to: z.string(),
      subject: z.string(),
      snippet: z.string(),
      sentAt: z.string(),
      threadId: z.string(),
    })),
    count: z.number(),
    lastSyncAt: z.string(),
  }),
  outputSchema: z.object({
    matched: z.number(),
    unmatched: z.number(),
    updatedLeadIds: z.array(z.string()),
    newSyncAt: z.string(),
  }),
  execute: async (context) => {
    if (context.inputData.count === 0) {
      return {
        matched: 0,
        unmatched: 0,
        updatedLeadIds: [],
        newSyncAt: new Date().toISOString(),
      };
    }

    const db = await getDb();
    const now = new Date();
    let matched = 0;
    let unmatched = 0;
    const updatedLeadIds: string[] = [];

    for (const email of context.inputData.sentEmails) {
      // Extract the email address from "Name <email>" format
      const toMatch = email.to.match(/<(.+?)>/) ?? [null, email.to];
      const toEmail = (toMatch[1] ?? email.to).toLowerCase().trim();

      const escapedTo = toEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lead = await db.collection('leads').findOne({
        email: { $regex: new RegExp(`^${escapedTo}$`, 'i') },
      });

      if (!lead) {
        unmatched++;
        continue;
      }

      // Update lead: set status to 'sent' if it was 'nowy', log interaction
      const wasNew = lead.status === 'nowy';
      const updatePayload: Record<string, any> = {
        lastInteractionAt: now,
        updatedAt: now,
        'metadata.accountUsed': email.account ?? 'gastrobridge',
        'metadata.lastEmailSent': {
          subject: email.subject,
          sentAt: email.sentAt,
          messageId: email.messageId,
          account: email.account ?? 'gastrobridge',
        },
      };
      if (wasNew) updatePayload.status = 'sent';

      await db.collection('leads').updateOne(
        { _id: lead._id },
        {
          $set: updatePayload,
          $push: {
            history: {
              timestamp: now,
              action: 'email_sent',
              description: `Email wysłany ze skrzynki [${email.account ?? 'gastrobridge'}]: "${email.subject}"`,
              agentId: 'sync-crm-workflow',
              metadata: { messageId: email.messageId, threadId: email.threadId, account: email.account ?? 'gastrobridge' },
            } as any,
          },
        },
      );

      matched++;
      updatedLeadIds.push(lead.id ?? String(lead._id));
    }

    // Update sync metadata
    await db.collection('sync_meta').updateOne(
      { key: 'crm-gmail-sync' },
      {
        $set: {
          key: 'crm-gmail-sync',
          lastSyncAt: now.toISOString(),
          lastRun: { matched, unmatched, emailsProcessed: context.inputData.count },
        },
      },
      { upsert: true },
    );

    return {
      matched,
      unmatched,
      updatedLeadIds,
      newSyncAt: now.toISOString(),
    };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const syncCrmWorkflow = createWorkflow({
  id: 'sync-crm',
  description: 'Synchronizuje wysłane emaile z Gmaila do historii interakcji w CRM.',
  inputSchema: z.object({
    hoursBack: z.number().default(24),
    maxEmails: z.number().default(50),
  }),
  outputSchema: z.object({
    matched: z.number(),
    unmatched: z.number(),
    updatedLeadIds: z.array(z.string()),
    newSyncAt: z.string(),
  }),
})
  .then(fetchSentEmailsStep)
  .then(matchAndSyncStep);

syncCrmWorkflow.commit();
