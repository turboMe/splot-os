/**
 * Workflow: weekly-report
 * Co tydzień: zbiera dane CRM + n8n + sygnały → raport operacyjny.
 * Etap 6 – analytics workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { analyticsAgent } from '../../agents/analytics-agent';
import { getDb } from '../../lib/mongo';

const collectMetricsStep = createStep({
  id: 'collect-metrics',
  description: 'Zbiera metryki z CRM, signals i shared_memory za ostatni tydzień.',
  inputSchema: z.object({
    periodDays: z.number().default(7),
  }),
  outputSchema: z.object({
    period: z.object({ from: z.string(), to: z.string() }),
    crm: z.object({
      total: z.number(),
      byStatus: z.record(z.string(), z.number()),
      newThisWeek: z.number(),
      interactionsThisWeek: z.number(),
    }),
    signals: z.array(z.object({ type: z.string(), count: z.number() })),
    topRegions: z.array(z.object({ region: z.string(), count: z.number() })),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();
    const from = new Date(now.getTime() - context.inputData.periodDays * 24 * 3600 * 1000);

    const [total, newLeads, allLeads] = await Promise.all([
      db.collection('leads').countDocuments({}),
      db.collection('leads').countDocuments({ createdAt: { $gte: from } }),
      db.collection('leads').find({}).project({ status: 1, region: 1, history: 1 }).toArray(),
    ]);

    // Status breakdown
    const byStatus: Record<string, number> = {};
    for (const lead of allLeads) {
      const s = lead.status ?? 'unknown';
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }

    // Interactions this week (history entries)
    const interactionsThisWeek = allLeads.reduce((acc, lead) => {
      const thisWeek = (lead.history ?? []).filter((h: any) => new Date(h.timestamp) >= from).length;
      return acc + thisWeek;
    }, 0);

    // Top regions
    const regionCounts: Record<string, number> = {};
    for (const lead of allLeads) {
      if (lead.region) regionCounts[lead.region] = (regionCounts[lead.region] ?? 0) + 1;
    }
    const topRegions = Object.entries(regionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([region, count]) => ({ region, count }));

    // Signal types this week
    const signals = await db.collection('signals')
      .find({ createdAt: { $gte: from.toISOString() } })
      .toArray();
    const signalCounts: Record<string, number> = {};
    for (const s of signals) signalCounts[s.type] = (signalCounts[s.type] ?? 0) + 1;
    const signalsSummary = Object.entries(signalCounts).map(([type, count]) => ({ type, count }));

    return {
      period: { from: from.toISOString(), to: now.toISOString() },
      crm: { total, byStatus, newThisWeek: newLeads, interactionsThisWeek },
      signals: signalsSummary,
      topRegions,
    };
  },
});

const generateReportStep = createStep({
  id: 'generate-report',
  description: 'Analytics Agent generuje raport tygodniowy na podstawie metryk.',
  inputSchema: z.object({
    period: z.object({ from: z.string(), to: z.string() }),
    crm: z.object({
      total: z.number(),
      byStatus: z.record(z.string(), z.number()),
      newThisWeek: z.number(),
      interactionsThisWeek: z.number(),
    }),
    signals: z.array(z.object({ type: z.string(), count: z.number() })),
    topRegions: z.array(z.object({ region: z.string(), count: z.number() })),
  }),
  outputSchema: z.object({
    report: z.string(),
    summary: z.string(),
    kpis: z.record(z.string(), z.string()),
  }),
  execute: async (context) => {
    const { period, crm, signals, topRegions } = context.inputData;
    const fromDate = new Date(period.from).toLocaleDateString('pl-PL');
    const toDate = new Date(period.to).toLocaleDateString('pl-PL');

    const prompt = `Wygeneruj tygodniowy raport operacyjny GastroBridge za okres ${fromDate} – ${toDate}.

## Metryki CRM
- Łącznie leadów: ${crm.total}
- Nowe w tym tygodniu: ${crm.newThisWeek}
- Interakcje w tym tygodniu: ${crm.interactionsThisWeek}

### Status leadów:
${Object.entries(crm.byStatus).map(([s, n]) => `- ${s}: ${n}`).join('\n')}

### Top regiony:
${topRegions.map(r => `- ${r.region}: ${r.count} leadów`).join('\n') || '- Brak danych'}

## Sygnały systemowe:
${signals.map(s => `- ${s.type}: ${s.count}x`).join('\n') || '- Brak sygnałów'}

## Zadanie
Napisz raport zawierający:
1. Executive summary (3 zdania)
2. Tabela kluczowych KPI (Markdown)
3. Trendy (co rośnie, co spada)
4. Top 3 priorytety na następny tydzień
5. Alerty / problemy do rozwiązania

Język: polski. Format: Markdown.`;

    const result = await analyticsAgent.generate(prompt);

    // Extract first paragraph as summary
    const lines = result.text.split('\n').filter(l => l.trim());
    const summary = lines.find(l => !l.startsWith('#') && l.length > 30) ?? lines[0] ?? '';

    // Extract basic KPIs
    const kpis: Record<string, string> = {
      'Łączne leady': String(crm.total),
      'Nowe leady (tydzień)': String(crm.newThisWeek),
      'Interakcje (tydzień)': String(crm.interactionsThisWeek),
    };
    if (crm.byStatus['odpowiedział']) kpis['Odpowiedzi'] = String(crm.byStatus['odpowiedział']);
    if (crm.byStatus['sent']) kpis['Wysłane maile'] = String(crm.byStatus['sent']);

    return { report: result.text, summary, kpis };
  },
});

const persistReportStep = createStep({
  id: 'persist-report',
  description: 'Zapisuje raport do shared_memory i kolekcji reports.',
  inputSchema: z.object({
    report: z.string(),
    summary: z.string(),
    kpis: z.record(z.string(), z.string()),
  }),
  outputSchema: z.object({
    reportId: z.string(),
    savedAt: z.string(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();
    const weekId = `weekly-report-${now.toISOString().split('T')[0]}`;

    await db.collection('reports').insertOne({
      id: weekId,
      type: 'weekly',
      content: context.inputData.report,
      summary: context.inputData.summary,
      kpis: context.inputData.kpis,
      generatedAt: now,
    });

    // Also pin to shared memory for agents
    await db.collection('shared_memory').updateOne(
      { key: weekId },
      {
        $set: {
          id: weekId,
          key: weekId,
          type: 'decision',
          sourceAgent: 'weekly-report-workflow',
          content: `Raport tygodniowy:\n${context.inputData.summary}`,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 8 * 24 * 3600 * 1000),
        },
      },
      { upsert: true },
    );

    return { reportId: weekId, savedAt: now.toISOString() };
  },
});

export const weeklyReportWorkflow = createWorkflow({
  id: 'weekly-report',
  description: 'Tygodniowy raport operacyjny: metryki CRM + sygnały → raport Markdown zapisany w DB.',
  inputSchema: z.object({
    periodDays: z.number().default(7),
  }),
  outputSchema: z.object({
    reportId: z.string(),
    savedAt: z.string(),
  }),
})
  .then(collectMetricsStep)
  .then(generateReportStep)
  .then(persistReportStep);

weeklyReportWorkflow.commit();
