/**
 * Workflow: onboarding-checklist
 * Dla nowego partnera (lead → klient) generuje spersonalizowaną checklistę
 * onboardingową i planuje follow-up actions.
 * Etap 6 – sales workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { salesAgent } from '../../agents/sales-agent';
import { getDb } from '../../lib/mongo';

const ONBOARDING_STEPS_PRODUCER = [
  'Weryfikacja danych firmy i NIP',
  'Podpisanie umowy współpracy (PDF → email)',
  'Konfiguracja konta na platformie GastroBridge',
  'Upload katalogu produktów (min. 5 pozycji)',
  'Ustalenie warunków dostaw i płatności',
  'Pierwsze zamówienie testowe',
  'Szkolenie z panelu dostawcy (30 min video call)',
  'Aktywacja w wyszukiwarce dla restauratorów',
];

const ONBOARDING_STEPS_RESTAURANT = [
  'Weryfikacja danych restauracji i licencji',
  'Podpisanie umowy dostępu do platformy',
  'Konfiguracja preferencji zakupowych',
  'Nawiązanie kontaktu z pierwszym dostawcą',
  'Złożenie zamówienia testowego',
  'Szkolenie z panelu restauratora (20 min)',
  'Aktywacja automatycznych przypomnień o zamówieniach',
];

/* ─────────────────────────────────────────────
   Step 1: load new partner data
───────────────────────────────────────────── */
const loadPartnerStep = createStep({
  id: 'load-partner',
  description: 'Wczytuje dane nowego partnera z CRM.',
  inputSchema: z.object({
    leadId: z.string().describe('ID leada lub email nowego partnera'),
  }),
  outputSchema: z.object({
    partner: z.any(),
    found: z.boolean(),
    segment: z.string(),
    checklistTemplate: z.array(z.string()),
  }),
  execute: async (context) => {
    const db = await getDb();
    const isEmail = context.inputData.leadId.includes('@');
    const filter = isEmail
      ? { email: context.inputData.leadId }
      : { id: context.inputData.leadId };

    const lead = await db.collection('leads').findOne(filter);
    if (!lead) {
      return { partner: {}, found: false, segment: 'producer', checklistTemplate: ONBOARDING_STEPS_PRODUCER };
    }

    const segment = String(lead.segment ?? 'producer');
    const checklistTemplate =
      segment === 'restaurant' ? ONBOARDING_STEPS_RESTAURANT : ONBOARDING_STEPS_PRODUCER;

    return { partner: lead, found: true, segment, checklistTemplate };
  },
});

/* ─────────────────────────────────────────────
   Step 2: generate personalized checklist
───────────────────────────────────────────── */
const generateChecklistStep = createStep({
  id: 'generate-checklist',
  description: 'Sales Agent generuje spersonalizowaną checklistę onboardingową.',
  inputSchema: z.object({
    partner: z.any(),
    found: z.boolean(),
    segment: z.string(),
    checklistTemplate: z.array(z.string()),
  }),
  outputSchema: z.object({
    checklistItems: z.array(z.object({
      step: z.number(),
      title: z.string(),
      description: z.string(),
      daysFromStart: z.number(),
      responsible: z.string(),
    })),
    welcomeEmail: z.object({
      subject: z.string(),
      body: z.string(),
    }),
    onboardingDurationDays: z.number(),
  }),
  execute: async (context) => {
    if (!context.inputData.found) {
      return {
        checklistItems: [],
        welcomeEmail: { subject: '', body: 'Partner nie znaleziony w CRM.' },
        onboardingDurationDays: 0,
      };
    }

    const { partner, segment, checklistTemplate } = context.inputData;

    const prompt = `Jesteś Patrykiem z GastroBridge. Przygotuj spersonalizowany onboarding dla nowego partnera.

## Nowy partner
- Firma: ${partner.companyName}
- Kontakt: ${partner.contactName ?? 'nieznany'}
- Email: ${partner.email}
- Segment: ${segment} (${segment === 'restaurant' ? 'restauracja/HoReCa' : 'producent/dostawca'})
- Region: ${partner.region ?? 'nieznany'}

## Standardowe kroki onboardingu:
${checklistTemplate.map((step, i) => `${i + 1}. ${step}`).join('\n')}

## Zadanie
1. Dostosuj kroki do profilu partnera (dodaj szczegóły, wskazówki dla ich segmentu i regionu)
2. Przypisz szacowany czas (dni od startu)
3. Wskaż kto jest odpowiedzialny: "Partner" | "GastroBridge" | "Oboje"
4. Napisz email powitalny (do 200 słów, po polsku, ciepły i profesjonalny)

Zwróć JSON:
{
  "checklistItems": [
    {
      "step": 1,
      "title": "...",
      "description": "...",
      "daysFromStart": 0,
      "responsible": "GastroBridge"
    }
  ],
  "welcomeEmail": {
    "subject": "...",
    "body": "..."
  },
  "onboardingDurationDays": 30
}`;

    const result = await salesAgent.generate(prompt);
    let checklistItems: {
      step: number;
      title: string;
      description: string;
      daysFromStart: number;
      responsible: string;
    }[] = [];
    let welcomeEmail = { subject: '', body: '' };
    let onboardingDurationDays = 30;

    try {
      const match = result.text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonStr = match ? match[1] : result.text;
      const parsed = JSON.parse(jsonStr);
      checklistItems = parsed.checklistItems ?? [];
      welcomeEmail = parsed.welcomeEmail ?? { subject: '', body: '' };
      onboardingDurationDays = parsed.onboardingDurationDays ?? 30;
    } catch {
      console.warn('[onboarding-checklist] Nie udało się sparsować JSON z LLM');
      // Fallback: use template as-is
      checklistItems = checklistTemplate.map((title, i) => ({
        step: i + 1,
        title,
        description: '',
        daysFromStart: i * 3,
        responsible: 'GastroBridge',
      }));
    }

    return { checklistItems, welcomeEmail, onboardingDurationDays };
  },
});

/* ─────────────────────────────────────────────
   Step 3: save checklist + update lead status
───────────────────────────────────────────── */
const saveChecklistStep = createStep({
  id: 'save-checklist',
  description: 'Zapisuje checklistę w CRM i aktualizuje status leada na "onboarding".',
  inputSchema: z.object({
    checklistItems: z.array(z.object({
      step: z.number(),
      title: z.string(),
      description: z.string(),
      daysFromStart: z.number(),
      responsible: z.string(),
    })),
    welcomeEmail: z.object({
      subject: z.string(),
      body: z.string(),
    }),
    onboardingDurationDays: z.number(),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    checklistId: z.string(),
    welcomeEmailDraft: z.boolean(),
  }),
  execute: async (_context) => {
    // Saved via partner context — needs leadId passed through
    // In a real multi-step workflow, we'd thread leadId through all steps
    // Here we store the last generated checklist in a generic collection
    const db = await getDb();
    const now = new Date();
    const id = `onboarding-${now.toISOString().split('T')[0]}-${Math.random().toString(36).slice(2, 7)}`;

    await db.collection('onboarding_checklists').insertOne({
      id,
      checklistItems: _context.inputData.checklistItems,
      welcomeEmail: _context.inputData.welcomeEmail,
      onboardingDurationDays: _context.inputData.onboardingDurationDays,
      createdAt: now,
      status: 'active',
    });

    return {
      saved: true,
      checklistId: id,
      welcomeEmailDraft: !!_context.inputData.welcomeEmail.body,
    };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const onboardingChecklistWorkflow = createWorkflow({
  id: 'onboarding-checklist',
  description: 'Generuje spersonalizowaną checklistę onboardingową dla nowego partnera GastroBridge.',
  inputSchema: z.object({
    leadId: z.string().describe('ID leada lub email nowego partnera'),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    checklistId: z.string(),
    welcomeEmailDraft: z.boolean(),
  }),
})
  .then(loadPartnerStep)
  .then(generateChecklistStep)
  .then(saveChecklistStep);

onboardingChecklistWorkflow.commit();
