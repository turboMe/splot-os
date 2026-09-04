/**
 * Workflow: meeting-scheduler
 * Dla gorących leadów (status: odpowiedział) proponuje termin spotkania
 * i tworzy event w Google Calendar z draft zaproszeniem.
 * Etap 6 – sales workflows.
 * Etap 7B – approval gate (suspend/resume) przed zaplanowaniem spotkań.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { salesAgent } from '../../agents/sales-agent';
import { getDb } from '../../lib/mongo';

/* ─────────────────────────────────────────────
   Step 1: find hot leads ready for a meeting
───────────────────────────────────────────── */
const findHotLeadsStep = createStep({
  id: 'find-hot-leads',
  description: 'Wyszukuje leady ze statusem "odpowiedział" bez zaplanowanego spotkania.',
  inputSchema: z.object({
    maxLeads: z.number().default(5),
    preferredHour: z.number().default(10),  // preferred meeting start hour (0-23)
  }),
  outputSchema: z.object({
    hotLeads: z.array(z.object({
      id: z.string(),
      companyName: z.string(),
      contactName: z.string(),
      email: z.string(),
      region: z.string(),
      segment: z.string(),
      lastInteractionAt: z.string(),
    })),
    count: z.number(),
    preferredHour: z.number(),
  }),
  execute: async (context) => {
    const db = await getDb();

    const leads = await db.collection('leads')
      .find({
        status: 'odpowiedział',
        'metadata.meetingScheduled': { $ne: true },
        email: { $exists: true, $ne: null },
      })
      .sort({ lastInteractionAt: 1 })  // oldest first = highest priority
      .limit(context.inputData.maxLeads)
      .toArray();

    const hotLeads = leads.map((l) => ({
      id: String(l.id ?? l._id),
      companyName: String(l.companyName ?? ''),
      contactName: String(l.contactName ?? 'nieznany'),
      email: String(l.email ?? ''),
      region: String(l.region ?? 'nieznany'),
      segment: String(l.segment ?? 'producer'),
      lastInteractionAt: l.lastInteractionAt
        ? new Date(l.lastInteractionAt).toISOString()
        : '',
    }));

    return {
      hotLeads,
      count: hotLeads.length,
      preferredHour: context.inputData.preferredHour,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 2: generate meeting proposals
───────────────────────────────────────────── */
const generateMeetingProposalsStep = createStep({
  id: 'generate-meeting-proposals',
  description: 'Sales Agent generuje propozycje spotkań z tematami i agendą.',
  inputSchema: z.object({
    hotLeads: z.array(z.object({
      id: z.string(),
      companyName: z.string(),
      contactName: z.string(),
      email: z.string(),
      region: z.string(),
      segment: z.string(),
      lastInteractionAt: z.string(),
    })),
    count: z.number(),
    preferredHour: z.number(),
  }),
  outputSchema: z.object({
    proposals: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      companyName: z.string(),
      meetingTitle: z.string(),
      agenda: z.string(),
      suggestedDuration: z.number(),  // minutes
      inviteBody: z.string(),
    })),
  }),
  execute: async (context) => {
    if (context.inputData.count === 0) {
      return { proposals: [] };
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });

    const prompt = `Jesteś Patrykiem z GastroBridge. Zaplanuj spotkania demo z ${context.inputData.count} gorącymi leadami.

## Leady gotowe na spotkanie:
${context.inputData.hotLeads.map((l) => `
- **${l.companyName}** | ${l.contactName} (${l.email})
  - Segment: ${l.segment}, Region: ${l.region}
  - Ostatni kontakt: ${l.lastInteractionAt || 'nieznany'}
`).join('')}

## Wytyczne:
- Spotkania: 30-45 minut, preferowana godzina ${context.inputData.preferredHour}:00
- Demo GastroBridge: platforma B2B łącząca producentów z restauratorami
- Agenda: krótkie intro → demo platformy → Q&A → next steps
- Język: polski, ton: profesjonalny ale ciepły

## Zadanie
Dla każdego leada stwórz:
1. Tytuł spotkania
2. Krótką agendę (3-4 punkty)
3. Czas trwania (minuty)
4. Treść zaproszenia email (2-3 zdania)

Zwróć JSON:
{
  "proposals": [
    {
      "leadId": "...",
      "email": "...",
      "companyName": "...",
      "meetingTitle": "...",
      "agenda": "...",
      "suggestedDuration": 45,
      "inviteBody": "..."
    }
  ]
}`;

    const result = await salesAgent.generate(prompt);
    let proposals: {
      leadId: string;
      email: string;
      companyName: string;
      meetingTitle: string;
      agenda: string;
      suggestedDuration: number;
      inviteBody: string;
    }[] = [];

    try {
      const match = result.text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonStr = match ? match[1] : result.text;
      const parsed = JSON.parse(jsonStr);
      proposals = parsed.proposals ?? [];

      // Ensure emails are filled from leads map
      const emailMap = Object.fromEntries(context.inputData.hotLeads.map((l) => [l.id, l]));
      proposals = proposals.map((p) => ({
        ...p,
        email: p.email || emailMap[p.leadId]?.email || '',
        companyName: p.companyName || emailMap[p.leadId]?.companyName || '',
      }));
    } catch {
      console.warn('[meeting-scheduler] Nie udało się sparsować JSON z LLM');
    }

    return { proposals };
  },
});

/* ─────────────────────────────────────────────
   Step 3: human approval gate (SUSPEND / RESUME)
   Pokazuje wygenerowane propozycje spotkań
   i czeka na zatwierdzenie przed zapisem do CRM.
───────────────────────────────────────────── */
const meetingApprovalGateStep = createStep({
  id: 'meeting-approval-gate',
  description: 'Wstrzymuje workflow i czeka na zatwierdzenie planu spotkań przez użytkownika.',
  inputSchema: z.object({
    proposals: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      companyName: z.string(),
      meetingTitle: z.string(),
      agenda: z.string(),
      suggestedDuration: z.number(),
      inviteBody: z.string(),
    })),
  }),
  suspendSchema: z.object({
    proposals: z.array(z.object({
      leadId: z.string(),
      companyName: z.string(),
      meetingTitle: z.string(),
      agenda: z.string(),
      suggestedDuration: z.number(),
    })),
    message: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    approvedLeadIds: z.array(z.string()).optional().describe('Jeśli puste — zatwierdza wszystkie propozycje'),
    feedback: z.string().optional(),
  }),
  outputSchema: z.object({
    proposals: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      companyName: z.string(),
      meetingTitle: z.string(),
      agenda: z.string(),
      suggestedDuration: z.number(),
      inviteBody: z.string(),
    })),
    approved: z.boolean(),
  }),
  execute: async (context) => {
    const { proposals } = context.inputData;

    // ── Resume path ────────────────────────────────────────────────────────
    if (context.resumeData) {
      const { approved, approvedLeadIds } = context.resumeData;

      if (!approved) {
        return { proposals: [], approved: false };
      }

      // Filter to only approved leads (if specific ones were chosen)
      const filteredProposals =
        approvedLeadIds && approvedLeadIds.length > 0
          ? proposals.filter((p) => approvedLeadIds.includes(p.leadId))
          : proposals;

      return { proposals: filteredProposals, approved: true };
    }

    // ── No proposals — skip gate ───────────────────────────────────────────
    if (proposals.length === 0) {
      return { proposals: [], approved: false };
    }

    // ── First run — suspend ────────────────────────────────────────────────
    return context.suspend(
      {
        proposals: proposals.map((p) => ({
          leadId: p.leadId,
          companyName: p.companyName,
          meetingTitle: p.meetingTitle,
          agenda: p.agenda,
          suggestedDuration: p.suggestedDuration,
        })),
        message: `Proszę zatwierdź plan spotkań dla ${proposals.length} leadów. Możesz zatwierdzić wszystkie lub wybrać konkretne (podaj approvedLeadIds).`,
      },
      { resumeLabel: 'Zatwierdź plan spotkań' },
    );
  },
});

/* ─────────────────────────────────────────────
   Step 4: create calendar events + update CRM
───────────────────────────────────────────── */
const scheduleAndUpdateStep = createStep({
  id: 'schedule-and-update',
  description: 'Tworzy eventy w kalendarzu i aktualizuje CRM.',
  inputSchema: z.object({
    proposals: z.array(z.object({
      leadId: z.string(),
      email: z.string(),
      companyName: z.string(),
      meetingTitle: z.string(),
      agenda: z.string(),
      suggestedDuration: z.number(),
      inviteBody: z.string(),
    })),
    approved: z.boolean(),
  }),
  outputSchema: z.object({
    scheduledCount: z.number(),
    scheduledLeadIds: z.array(z.string()),
  }),
  execute: async (context) => {
    // Skip if not approved
    if (!context.inputData.approved) {
      return { scheduledCount: 0, scheduledLeadIds: [] };
    }
    const db = await getDb();
    const now = new Date();
    let scheduledCount = 0;
    const scheduledLeadIds: string[] = [];

    // Schedule starting tomorrow at preferredHour, spacing meetings by 1h
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() + 1);
    baseDate.setHours(10, 0, 0, 0);

    for (let i = 0; i < context.inputData.proposals.length; i++) {
      const proposal = context.inputData.proposals[i];
      if (!proposal.leadId) continue;

      const startTime = new Date(baseDate.getTime() + i * 60 * 60 * 1000);
      const endTime = new Date(startTime.getTime() + (proposal.suggestedDuration ?? 45) * 60 * 1000);

      // Save meeting event to calendar_events collection (for later Google Calendar sync)
      await db.collection('calendar_events').insertOne({
        leadId: proposal.leadId,
        title: proposal.meetingTitle,
        description: `${proposal.agenda}\n\n${proposal.inviteBody}`,
        attendeeEmail: proposal.email,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        status: 'pending_confirmation',
        createdAt: now,
      });

      // Mark lead as meeting scheduled
      await db.collection('leads').updateOne(
        { id: proposal.leadId },
        {
          $set: {
            status: 'spotkanie_umówione',
            'metadata.meetingScheduled': true,
            'metadata.meetingTime': startTime.toISOString(),
            updatedAt: now,
            lastInteractionAt: now,
          },
          $push: {
            history: {
              timestamp: now,
              action: 'meeting_scheduled',
              description: `Zaplanowano spotkanie: "${proposal.meetingTitle}" na ${startTime.toLocaleString('pl-PL')}`,
              agentId: 'meeting-scheduler-workflow',
            } as any,
          },
        },
      );

      scheduledCount++;
      scheduledLeadIds.push(proposal.leadId);
    }

    return { scheduledCount, scheduledLeadIds };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const meetingSchedulerWorkflow = createWorkflow({
  id: 'meeting-scheduler',
  description: 'Dla gorących leadów generuje propozycje spotkań demo. Zatrzymuje się na zatwierdzenie (suspend/resume), potem tworzy eventy w kalendarzu.',
  inputSchema: z.object({
    maxLeads: z.number().default(5),
    preferredHour: z.number().default(10),
  }),
  outputSchema: z.object({
    scheduledCount: z.number(),
    scheduledLeadIds: z.array(z.string()),
  }),
})
  .then(findHotLeadsStep)
  .then(generateMeetingProposalsStep)
  .then(meetingApprovalGateStep)
  .then(scheduleAndUpdateStep);

meetingSchedulerWorkflow.commit();
