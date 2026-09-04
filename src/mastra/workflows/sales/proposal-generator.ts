/**
 * Workflow: proposal-generator
 * Generuje propozycję współpracy dla konkretnego leada.
 * Etap 6 – sales workflows.
 * Etap 7B – approval gate (suspend/resume) przed zapisem.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { salesAgent } from '../../agents/sales-agent';
import { getDb } from '../../lib/mongo';

/* ─────────────────────────────────────────────
   Step 1: load lead from CRM
───────────────────────────────────────────── */
const loadLeadStep = createStep({
  id: 'load-lead',
  description: 'Wczytuje dane leada z CRM.',
  inputSchema: z.object({
    leadId: z.string().describe('UUID leada lub email'),
    additionalContext: z.string().optional().describe('Dodatkowy kontekst (np. notatki ze spotkania)'),
  }),
  outputSchema: z.object({
    lead: z.any(),
    additionalContext: z.string(),
    found: z.boolean(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const isEmail = context.inputData.leadId.includes('@');
    const filter = isEmail ? { email: context.inputData.leadId } : { id: context.inputData.leadId };

    const lead = await db.collection('leads').findOne(filter);
    return {
      lead: lead ?? {},
      additionalContext: context.inputData.additionalContext ?? '',
      found: !!lead,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 2: generate proposal with LLM
───────────────────────────────────────────── */
const generateProposalStep = createStep({
  id: 'generate-proposal',
  description: 'Sales Agent generuje propozycję współpracy.',
  inputSchema: z.object({
    lead: z.any(),
    additionalContext: z.string(),
    found: z.boolean(),
  }),
  outputSchema: z.object({
    proposalSubject: z.string(),
    proposalBody: z.string(),
    proposalSummary: z.string(),
    leadId: z.string(),
    companyName: z.string(),
    found: z.boolean(),
  }),
  execute: async (context) => {
    const { lead, additionalContext, found } = context.inputData;

    if (!found) {
      return {
        proposalSubject: '',
        proposalBody: 'Nie znaleziono leada w CRM.',
        proposalSummary: 'Lead nie znaleziony.',
        leadId: '',
        companyName: '',
        found: false,
      };
    }

    const prompt = `Wygeneruj profesjonalną propozycję współpracy z GastroBridge dla:

## Lead
- Firma: ${lead.companyName}
- Kontakt: ${lead.contactName ?? 'nieznany'}
- Email: ${lead.email}
- Segment: ${lead.segment ?? 'producer'}
- Region: ${lead.region ?? 'nieznany'}
- Status: ${lead.status}

## Historia interakcji:
${(lead.history ?? []).slice(-3).map((h: any) => `- ${h.action}: ${h.description}`).join('\n') || '- Brak historii'}

## Dodatkowy kontekst:
${additionalContext || '- Brak dodatkowego kontekstu'}

## Zadanie
Napisz:
1. Propozycję współpracy (email, 200-300 słów) — konkretna, z korzyściami dla producenta
2. Temat emaila
3. Jednozdaniowe podsumowanie propozycji

Zwróć JSON: { "subject": "...", "body": "...", "summary": "..." }`;

    const result = await salesAgent.generate(prompt);
    let subject = '', body = '', summary = '';

    try {
      const match = result.text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonStr = match ? match[1] : result.text;
      const parsed = JSON.parse(jsonStr);
      subject = parsed.subject ?? '';
      body = parsed.body ?? '';
      summary = parsed.summary ?? '';
    } catch {
      body = result.text;
      subject = `Propozycja współpracy: ${lead.companyName} × GastroBridge`;
      summary = `Propozycja wygenerowana dla ${lead.companyName}`;
    }

    return {
      proposalSubject: subject,
      proposalBody: body,
      proposalSummary: summary,
      leadId: lead.id ?? '',
      companyName: lead.companyName ?? '',
      found: true,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 3: human approval gate (SUSPEND / RESUME)
   Zatrzymuje workflow i czeka na zatwierdzenie
   propozycji przez użytkownika w dashboardzie.
───────────────────────────────────────────── */
const proposalApprovalGateStep = createStep({
  id: 'proposal-approval-gate',
  description: 'Wstrzymuje workflow i czeka na zatwierdzenie propozycji przez użytkownika.',
  inputSchema: z.object({
    proposalSubject: z.string(),
    proposalBody: z.string(),
    proposalSummary: z.string(),
    leadId: z.string(),
    companyName: z.string(),
    found: z.boolean(),
  }),
  // What the dashboard shows while suspended
  suspendSchema: z.object({
    proposalSubject: z.string(),
    proposalBody: z.string(),
    proposalSummary: z.string(),
    leadId: z.string(),
    companyName: z.string(),
    message: z.string(),
  }),
  // What the human sends back on resume
  resumeSchema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional().describe('Opcjonalne uwagi (zostaną dodane do historii)'),
  }),
  outputSchema: z.object({
    proposalSubject: z.string(),
    proposalBody: z.string(),
    proposalSummary: z.string(),
    leadId: z.string(),
    approved: z.boolean(),
    feedback: z.string(),
  }),
  execute: async (context) => {
    const { proposalSubject, proposalBody, proposalSummary, leadId, companyName, found } =
      context.inputData;

    // ── Resume path: human has responded ──────────────────────────────────
    if (context.resumeData) {
      const { approved, feedback } = context.resumeData;
      return {
        proposalSubject,
        proposalBody,
        proposalSummary,
        leadId,
        approved,
        feedback: feedback ?? '',
      };
    }

    // ── Not found — skip approval, pass through ────────────────────────────
    if (!found || !leadId) {
      return {
        proposalSubject,
        proposalBody,
        proposalSummary,
        leadId,
        approved: false,
        feedback: 'Lead nie znaleziony — workflow pominął approval gate.',
      };
    }

    // ── First run — suspend and show proposal to the user ─────────────────
    return context.suspend(
      {
        proposalSubject,
        proposalBody,
        proposalSummary,
        leadId,
        companyName,
        message: `Proszę zatwierdź lub odrzuć propozycję dla ${companyName}. Temat: "${proposalSubject}"`,
      },
      { resumeLabel: 'Zatwierdź propozycję' },
    );
  },
});

/* ─────────────────────────────────────────────
   Step 4: save approved proposal to CRM
───────────────────────────────────────────── */
const saveProposalStep = createStep({
  id: 'save-proposal',
  description: 'Zapisuje zatwierdzoną propozycję jako draft i aktualizuje status leada.',
  inputSchema: z.object({
    proposalSubject: z.string(),
    proposalBody: z.string(),
    proposalSummary: z.string(),
    leadId: z.string(),
    approved: z.boolean(),
    feedback: z.string(),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    leadId: z.string(),
    draftSaved: z.boolean(),
  }),
  execute: async (context) => {
    const { leadId, approved, feedback, proposalSubject, proposalBody, proposalSummary } =
      context.inputData;

    // Skip save if not approved or no lead
    if (!approved || !leadId) {
      return { saved: false, leadId: leadId ?? '', draftSaved: false };
    }

    const db = await getDb();
    const now = new Date();

    await db.collection('leads').updateOne(
      { id: leadId },
      {
        $set: {
          status: 'draft_gotowy',
          'metadata.proposal': {
            subject: proposalSubject,
            body: proposalBody,
            summary: proposalSummary,
          },
          updatedAt: now,
          lastInteractionAt: now,
        },
        $push: {
          history: {
            timestamp: now,
            action: 'proposal_approved',
            description: `${proposalSummary}${feedback ? ` — Uwagi: ${feedback}` : ''}`,
            agentId: 'proposal-generator-workflow',
          } as any,
        },
      },
    );

    return { saved: true, leadId, draftSaved: true };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const proposalGeneratorWorkflow = createWorkflow({
  id: 'proposal-generator',
  description: 'Generuje personalizowaną propozycję współpracy dla leada z CRM. Zatrzymuje się do zatwierdzenia przed zapisem (suspend/resume).',
  inputSchema: z.object({
    leadId: z.string().describe('UUID leada lub email'),
    additionalContext: z.string().optional().describe('Dodatkowy kontekst (notatki ze spotkania itp.)'),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    leadId: z.string(),
    draftSaved: z.boolean(),
  }),
})
  .then(loadLeadStep)
  .then(generateProposalStep)
  .then(proposalApprovalGateStep)
  .then(saveProposalStep);

proposalGeneratorWorkflow.commit();
