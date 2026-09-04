/**
 * Workflow: roi-calculator
 * Oblicza ROI kampanii outreach: koszt tokenów, czas agentów,
 * vs. wartość pozyskanych leadów/partnerów.
 * Etap 6 – analytics workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { analyticsAgent } from '../../agents/analytics-agent';
import { getDb } from '../../lib/mongo';

/* ─────────────────────────────────────────────
   Step 1: collect cost & conversion data
───────────────────────────────────────────── */
const collectRoiDataStep = createStep({
  id: 'collect-roi-data',
  description: 'Zbiera dane o kosztach (tokeny, czas) i konwersjach za podany okres.',
  inputSchema: z.object({
    periodDays: z.number().default(30),
    costPerMillionTokens: z.number().default(0.15),  // USD, Gemini Flash pricing
    avgDealValuePLN: z.number().default(5000),        // estimated avg partner value
  }),
  outputSchema: z.object({
    period: z.object({ from: z.string(), to: z.string(), days: z.number() }),
    costs: z.object({
      totalTokensUsed: z.number(),
      estimatedCostUSD: z.number(),
      estimatedCostPLN: z.number(),
      workflowRuns: z.number(),
    }),
    conversions: z.object({
      leadsCreated: z.number(),
      emailsSent: z.number(),
      responses: z.number(),
      meetings: z.number(),
      partners: z.number(),
      responseRate: z.number(),
      conversionRate: z.number(),
    }),
    estimatedRevenue: z.number(),
    avgDealValuePLN: z.number(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();
    const from = new Date(now.getTime() - context.inputData.periodDays * 24 * 3600 * 1000);

    // Token usage from observability / logs collection
    const tokenLogs = await db.collection('token_usage')
      .find({ timestamp: { $gte: from } })
      .toArray();
    const totalTokensUsed = tokenLogs.reduce((sum, l) => sum + (l.totalTokens ?? 0), 0);
    const estimatedCostUSD = (totalTokensUsed / 1_000_000) * context.inputData.costPerMillionTokens;
    const estimatedCostPLN = estimatedCostUSD * 4.0;  // approximate EUR/PLN

    // Workflow run count
    const workflowRuns = await db.collection('workflow_runs')
      .countDocuments({ startedAt: { $gte: from } });

    // CRM conversion funnel
    const allLeads = await db.collection('leads')
      .find({})
      .project({ status: 1, createdAt: 1, lastInteractionAt: 1, history: 1 })
      .toArray();

    const leadsCreated = allLeads.filter(
      (l) => l.createdAt && new Date(l.createdAt) >= from,
    ).length;

    // Count emails sent this period (from history)
    let emailsSent = 0;
    let responses = 0;
    for (const lead of allLeads) {
      const history = (lead.history ?? []) as Array<{ timestamp: any; action: string }>;
      emailsSent += history.filter(
        (h) => h.action === 'email_sent' && new Date(h.timestamp) >= from,
      ).length;
      responses += history.filter(
        (h) => h.action === 'email_received' && new Date(h.timestamp) >= from,
      ).length;
    }

    const meetings = allLeads.filter(
      (l) => l.status === 'spotkanie_umówione' || l.status === 'onboarding',
    ).length;
    const partners = allLeads.filter((l) => l.status === 'aktywny_partner').length;

    const responseRate = emailsSent > 0 ? (responses / emailsSent) * 100 : 0;
    const conversionRate = leadsCreated > 0 ? (partners / leadsCreated) * 100 : 0;
    const estimatedRevenue = partners * context.inputData.avgDealValuePLN;

    return {
      period: { from: from.toISOString(), to: now.toISOString(), days: context.inputData.periodDays },
      costs: { totalTokensUsed, estimatedCostUSD, estimatedCostPLN, workflowRuns },
      conversions: {
        leadsCreated,
        emailsSent,
        responses,
        meetings,
        partners,
        responseRate: Math.round(responseRate * 10) / 10,
        conversionRate: Math.round(conversionRate * 10) / 10,
      },
      estimatedRevenue,
      avgDealValuePLN: context.inputData.avgDealValuePLN,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 2: analytics agent interprets ROI
───────────────────────────────────────────── */
const analyzeRoiStep = createStep({
  id: 'analyze-roi',
  description: 'Analytics Agent interpretuje dane ROI i generuje rekomendacje.',
  inputSchema: z.object({
    period: z.object({ from: z.string(), to: z.string(), days: z.number() }),
    costs: z.object({
      totalTokensUsed: z.number(),
      estimatedCostUSD: z.number(),
      estimatedCostPLN: z.number(),
      workflowRuns: z.number(),
    }),
    conversions: z.object({
      leadsCreated: z.number(),
      emailsSent: z.number(),
      responses: z.number(),
      meetings: z.number(),
      partners: z.number(),
      responseRate: z.number(),
      conversionRate: z.number(),
    }),
    estimatedRevenue: z.number(),
    avgDealValuePLN: z.number(),
  }),
  outputSchema: z.object({
    roiPercent: z.number(),
    roiReport: z.string(),
    recommendations: z.array(z.string()),
    kpis: z.record(z.string(), z.string()),
  }),
  execute: async (context) => {
    const { period, costs, conversions, estimatedRevenue } = context.inputData;
    const roiPercent = costs.estimatedCostPLN > 0
      ? Math.round(((estimatedRevenue - costs.estimatedCostPLN) / costs.estimatedCostPLN) * 100)
      : 0;

    const prompt = `Jesteś Agentem Analityki GastroBridge. Oceń ROI kampanii AI-driven outreach.

## Okres: ${new Date(period.from).toLocaleDateString('pl-PL')} – ${new Date(period.to).toLocaleDateString('pl-PL')} (${period.days} dni)

## Koszty operacyjne
- Tokeny LLM: ${costs.totalTokensUsed.toLocaleString('pl-PL')}
- Szacowany koszt: $${costs.estimatedCostUSD.toFixed(2)} (~${costs.estimatedCostPLN.toFixed(0)} PLN)
- Uruchomienia workflowów: ${costs.workflowRuns}

## Lejek konwersji
- Nowe leady: ${conversions.leadsCreated}
- Emaile wysłane: ${conversions.emailsSent}
- Odpowiedzi: ${conversions.responses} (response rate: ${conversions.responseRate}%)
- Spotkania: ${conversions.meetings}
- Nowi partnerzy: ${conversions.partners}
- Konwersja lead→partner: ${conversions.conversionRate}%

## Finanse
- Szacowana wartość pozyskanych partnerów: ${estimatedRevenue.toLocaleString('pl-PL')} PLN
  (przy założeniu ${context.inputData.avgDealValuePLN.toLocaleString('pl-PL')} PLN/partner)
- **ROI: ${roiPercent}%**

## Zadanie
1. Oceń wyniki (co jest dobre, co wymaga poprawy)
2. Porównaj response rate z benchmarkami branżowymi (cold email: 2-5%, AI-personalized: 8-15%)
3. Zaproponuj 3-5 konkretnych akcji optymalizacyjnych
4. Napisz executive summary (3 zdania)

Format: Markdown, język: polski.`;

    const result = await analyticsAgent.generate(prompt);

    const kpis: Record<string, string> = {
      'ROI': `${roiPercent}%`,
      'Response Rate': `${conversions.responseRate}%`,
      'Konwersja': `${conversions.conversionRate}%`,
      'Koszt LLM (PLN)': costs.estimatedCostPLN.toFixed(0),
      'Nowi partnerzy': String(conversions.partners),
      'Przychód szac. (PLN)': estimatedRevenue.toLocaleString('pl-PL'),
    };

    // Extract bullet recommendations
    const lines = result.text.split('\n');
    const recommendations = lines
      .filter((l) => /^[-*\d]\s/.test(l.trim()))
      .map((l) => l.replace(/^[-*\d.]\s+/, '').trim())
      .filter((l) => l.length > 10)
      .slice(0, 5);

    return {
      roiPercent,
      roiReport: result.text,
      recommendations,
      kpis,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 3: persist ROI report
───────────────────────────────────────────── */
const persistRoiReportStep = createStep({
  id: 'persist-roi-report',
  description: 'Zapisuje raport ROI do bazy danych.',
  inputSchema: z.object({
    roiPercent: z.number(),
    roiReport: z.string(),
    recommendations: z.array(z.string()),
    kpis: z.record(z.string(), z.string()),
  }),
  outputSchema: z.object({
    reportId: z.string(),
    roiPercent: z.number(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();
    const reportId = `roi-${now.toISOString().split('T')[0]}`;

    await db.collection('reports').insertOne({
      id: reportId,
      type: 'roi',
      content: context.inputData.roiReport,
      kpis: context.inputData.kpis,
      recommendations: context.inputData.recommendations,
      roiPercent: context.inputData.roiPercent,
      generatedAt: now,
    });

    return { reportId, roiPercent: context.inputData.roiPercent };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const roiCalculatorWorkflow = createWorkflow({
  id: 'roi-calculator',
  description: 'Oblicza ROI kampanii outreach: koszty LLM vs. wartość pozyskanych partnerów.',
  inputSchema: z.object({
    periodDays: z.number().default(30),
    costPerMillionTokens: z.number().default(0.15),
    avgDealValuePLN: z.number().default(5000),
  }),
  outputSchema: z.object({
    reportId: z.string(),
    roiPercent: z.number(),
  }),
})
  .then(collectRoiDataStep)
  .then(analyzeRoiStep)
  .then(persistRoiReportStep);

roiCalculatorWorkflow.commit();
