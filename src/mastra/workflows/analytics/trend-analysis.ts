/**
 * Workflow: trend-analysis
 * Analizuje trendy w CRM (statusy, regiony, segmenty), sygnały rynkowe z RSS
 * oraz aktywność agentów — identyfikuje wzorce i anomalie.
 * Etap 6 – analytics workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { analyticsAgent } from '../../agents/analytics-agent';
import { getDb } from '../../lib/mongo';

/* ─────────────────────────────────────────────
   Step 1: collect trend data from all sources
───────────────────────────────────────────── */
const collectTrendDataStep = createStep({
  id: 'collect-trend-data',
  description: 'Zbiera dane trendów: CRM velocity, RSS tematy, aktywność agentów.',
  inputSchema: z.object({
    periodDays: z.number().default(14),
    comparisonPeriodDays: z.number().default(14),
  }),
  outputSchema: z.object({
    currentPeriod: z.object({
      from: z.string(),
      to: z.string(),
    }),
    previousPeriod: z.object({
      from: z.string(),
      to: z.string(),
    }),
    crmTrends: z.object({
      newLeads: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      emailsSent: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      responses: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      meetings: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      byRegion: z.record(z.string(), z.number()),
      bySegment: z.record(z.string(), z.number()),
      statusVelocity: z.record(z.string(), z.number()),
    }),
    rssTopics: z.array(z.object({
      keyword: z.string(),
      count: z.number(),
    })),
    agentActivity: z.object({
      totalWorkflowRuns: z.number(),
      errorRate: z.number(),
      topWorkflows: z.array(z.object({ workflowId: z.string(), runs: z.number() })),
    }),
    signals: z.array(z.object({
      type: z.string(),
      count: z.number(),
      latestContent: z.string(),
    })),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();

    const currentFrom = new Date(now.getTime() - context.inputData.periodDays * 24 * 3600 * 1000);
    const previousFrom = new Date(
      currentFrom.getTime() - context.inputData.comparisonPeriodDays * 24 * 3600 * 1000,
    );

    // CRM data
    const allLeads = await db.collection('leads')
      .find({})
      .project({ status: 1, region: 1, segment: 1, createdAt: 1, history: 1 })
      .toArray();

    const countInPeriod = (
      leads: typeof allLeads,
      action: string,
      from: Date,
      to: Date,
    ) =>
      leads.reduce((acc, l) => {
        const hits = ((l.history ?? []) as Array<{ timestamp: any; action: string }>).filter(
          (h) => h.action === action && new Date(h.timestamp) >= from && new Date(h.timestamp) < to,
        ).length;
        return acc + hits;
      }, 0);

    const newLeadsCurrent = allLeads.filter(
      (l) => l.createdAt && new Date(l.createdAt) >= currentFrom && new Date(l.createdAt) < now,
    ).length;
    const newLeadsPrevious = allLeads.filter(
      (l) =>
        l.createdAt &&
        new Date(l.createdAt) >= previousFrom &&
        new Date(l.createdAt) < currentFrom,
    ).length;

    const emailsCurrent = countInPeriod(allLeads, 'email_sent', currentFrom, now);
    const emailsPrevious = countInPeriod(allLeads, 'email_sent', previousFrom, currentFrom);
    const responsesCurrent = countInPeriod(allLeads, 'email_received', currentFrom, now);
    const responsesPrevious = countInPeriod(allLeads, 'email_received', previousFrom, currentFrom);
    const meetingsCurrent = countInPeriod(allLeads, 'meeting_scheduled', currentFrom, now);
    const meetingsPrevious = countInPeriod(allLeads, 'meeting_scheduled', previousFrom, currentFrom);

    // Regional distribution
    const byRegion: Record<string, number> = {};
    const bySegment: Record<string, number> = {};
    const statusVelocity: Record<string, number> = {};
    for (const lead of allLeads) {
      if (lead.region) byRegion[lead.region] = (byRegion[lead.region] ?? 0) + 1;
      if (lead.segment) bySegment[lead.segment] = (bySegment[lead.segment] ?? 0) + 1;
      const s = lead.status ?? 'unknown';
      statusVelocity[s] = (statusVelocity[s] ?? 0) + 1;
    }

    // RSS topic extraction (simple keyword frequency)
    const recentArticles = await db.collection('rss_articles')
      .find({ pubDate: { $gte: currentFrom } })
      .project({ title: 1, description: 1 })
      .limit(100)
      .toArray();

    const keywords = [
      'HoReCa', 'dostawca', 'restauracja', 'żywność', 'gastronomia',
      'producent', 'farm', 'lokalny', 'ekologiczny', 'import',
      'ceny', 'inflacja', 'trend', 'rynek', 'technologia',
    ];
    const keywordCounts: Record<string, number> = {};
    for (const article of recentArticles) {
      const text = `${article.title} ${article.description}`.toLowerCase();
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          keywordCounts[kw] = (keywordCounts[kw] ?? 0) + 1;
        }
      }
    }
    const rssTopics = Object.entries(keywordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([keyword, count]) => ({ keyword, count }));

    // Agent activity
    const [totalRuns, errorRuns] = await Promise.all([
      db.collection('workflow_runs').countDocuments({ startedAt: { $gte: currentFrom } }),
      db.collection('workflow_runs').countDocuments({
        startedAt: { $gte: currentFrom },
        status: 'error',
      }),
    ]);

    const topWorkflowsRaw = await db.collection('workflow_runs')
      .aggregate([
        { $match: { startedAt: { $gte: currentFrom } } },
        { $group: { _id: '$workflowId', runs: { $sum: 1 } } },
        { $sort: { runs: -1 } },
        { $limit: 5 },
      ])
      .toArray();
    const topWorkflows = topWorkflowsRaw.map((w) => ({
      workflowId: String(w._id),
      runs: w.runs as number,
    }));

    // Signals
    const signalDocs = await db.collection('signals')
      .find({ createdAt: { $gte: currentFrom.toISOString() } })
      .toArray();
    const signalMap: Record<string, { count: number; content: string }> = {};
    for (const s of signalDocs) {
      const type = String(s.type ?? 'unknown');
      if (!signalMap[type]) signalMap[type] = { count: 0, content: '' };
      signalMap[type].count++;
      signalMap[type].content = typeof s.data === 'string' ? s.data : JSON.stringify(s.data ?? {});
    }
    const signals = Object.entries(signalMap).map(([type, { count, content }]) => ({
      type,
      count,
      latestContent: content.slice(0, 100),
    }));

    return {
      currentPeriod: { from: currentFrom.toISOString(), to: now.toISOString() },
      previousPeriod: { from: previousFrom.toISOString(), to: currentFrom.toISOString() },
      crmTrends: {
        newLeads: {
          current: newLeadsCurrent,
          previous: newLeadsPrevious,
          delta: newLeadsCurrent - newLeadsPrevious,
        },
        emailsSent: {
          current: emailsCurrent,
          previous: emailsPrevious,
          delta: emailsCurrent - emailsPrevious,
        },
        responses: {
          current: responsesCurrent,
          previous: responsesPrevious,
          delta: responsesCurrent - responsesPrevious,
        },
        meetings: {
          current: meetingsCurrent,
          previous: meetingsPrevious,
          delta: meetingsCurrent - meetingsPrevious,
        },
        byRegion,
        bySegment,
        statusVelocity,
      },
      rssTopics,
      agentActivity: {
        totalWorkflowRuns: totalRuns,
        errorRate: totalRuns > 0 ? Math.round((errorRuns / totalRuns) * 100) : 0,
        topWorkflows,
      },
      signals,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 2: analytics agent generates insights
───────────────────────────────────────────── */
const generateInsightsStep = createStep({
  id: 'generate-insights',
  description: 'Analytics Agent identyfikuje trendy, anomalie i rekomenduje działania.',
  inputSchema: z.object({
    currentPeriod: z.object({ from: z.string(), to: z.string() }),
    previousPeriod: z.object({ from: z.string(), to: z.string() }),
    crmTrends: z.object({
      newLeads: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      emailsSent: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      responses: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      meetings: z.object({ current: z.number(), previous: z.number(), delta: z.number() }),
      byRegion: z.record(z.string(), z.number()),
      bySegment: z.record(z.string(), z.number()),
      statusVelocity: z.record(z.string(), z.number()),
    }),
    rssTopics: z.array(z.object({ keyword: z.string(), count: z.number() })),
    agentActivity: z.object({
      totalWorkflowRuns: z.number(),
      errorRate: z.number(),
      topWorkflows: z.array(z.object({ workflowId: z.string(), runs: z.number() })),
    }),
    signals: z.array(z.object({ type: z.string(), count: z.number(), latestContent: z.string() })),
  }),
  outputSchema: z.object({
    trendReport: z.string(),
    anomalies: z.array(z.string()),
    growthAreas: z.array(z.string()),
    recommendations: z.array(z.string()),
  }),
  execute: async (context) => {
    const { crmTrends, rssTopics, agentActivity, signals } = context.inputData;
    const fmt = (n: number) => n > 0 ? `+${n}` : String(n);

    const prompt = `Jesteś Agentem Analityki GastroBridge. Przeprowadź analizę trendów za ostatnie ${
      Math.round(
        (new Date(context.inputData.currentPeriod.to).getTime() -
          new Date(context.inputData.currentPeriod.from).getTime()) /
          (24 * 3600 * 1000),
      )
    } dni.

## Trendy CRM (vs. poprzedni okres)
| Metryka | Bieżący | Poprzedni | Zmiana |
|---------|---------|-----------|--------|
| Nowe leady | ${crmTrends.newLeads.current} | ${crmTrends.newLeads.previous} | ${fmt(crmTrends.newLeads.delta)} |
| Emaile wysłane | ${crmTrends.emailsSent.current} | ${crmTrends.emailsSent.previous} | ${fmt(crmTrends.emailsSent.delta)} |
| Odpowiedzi | ${crmTrends.responses.current} | ${crmTrends.responses.previous} | ${fmt(crmTrends.responses.delta)} |
| Spotkania | ${crmTrends.meetings.current} | ${crmTrends.meetings.previous} | ${fmt(crmTrends.meetings.delta)} |

### Dystrybucja regionalna:
${Object.entries(crmTrends.byRegion)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([r, n]) => `- ${r}: ${n} leadów`)
  .join('\n') || '- Brak danych'}

### Status leadów:
${Object.entries(crmTrends.statusVelocity)
  .map(([s, n]) => `- ${s}: ${n}`)
  .join('\n')}

## Tematy RSS (top 10):
${rssTopics.map((t) => `- "${t.keyword}": ${t.count}x`).join('\n') || '- Brak danych'}

## Aktywność agentów:
- Uruchomienia workflowów: ${agentActivity.totalWorkflowRuns}
- Stopa błędów: ${agentActivity.errorRate}%
- Top workflowy: ${agentActivity.topWorkflows.map((w) => `${w.workflowId} (${w.runs}x)`).join(', ')}

## Sygnały systemowe:
${signals.map((s) => `- [${s.type}] (${s.count}x): ${s.latestContent}`).join('\n') || '- Brak sygnałów'}

## Zadanie
1. Zidentyfikuj 3 główne trendy (rosnące i malejące)
2. Wykryj anomalie (np. gwałtowny spadek, nieoczekiwany wzrost)
3. Wskaż obszary wzrostu (regiony, segmenty, tematy RSS)
4. Zaproponuj 5 rekomendacji działań
5. Napisz executive summary (3-4 zdania)

Format: Markdown, język: polski.`;

    const result = await analyticsAgent.generate(prompt);

    const lines = result.text.split('\n');
    const bullets = lines
      .filter((l) => /^[-*]\s/.test(l.trim()))
      .map((l) => l.replace(/^[-*]\s+/, '').trim())
      .filter((l) => l.length > 10);

    const anomalies = bullets.filter(
      (l) =>
        l.toLowerCase().includes('anomal') ||
        l.toLowerCase().includes('alert') ||
        l.toLowerCase().includes('spadek') ||
        l.toLowerCase().includes('problem'),
    ).slice(0, 3);

    const growthAreas = bullets.filter(
      (l) =>
        l.toLowerCase().includes('wzrost') ||
        l.toLowerCase().includes('rośnie') ||
        l.toLowerCase().includes('potencjał') ||
        l.toLowerCase().includes('okazj'),
    ).slice(0, 3);

    const recommendations = bullets
      .filter((l) => !anomalies.includes(l) && !growthAreas.includes(l))
      .slice(0, 5);

    return {
      trendReport: result.text,
      anomalies,
      growthAreas,
      recommendations,
    };
  },
});

/* ─────────────────────────────────────────────
   Step 3: save trend report + push anomaly signals
───────────────────────────────────────────── */
const saveTrendReportStep = createStep({
  id: 'save-trend-report',
  description: 'Zapisuje raport trendów i emituje sygnały dla anomalii.',
  inputSchema: z.object({
    trendReport: z.string(),
    anomalies: z.array(z.string()),
    growthAreas: z.array(z.string()),
    recommendations: z.array(z.string()),
  }),
  outputSchema: z.object({
    reportId: z.string(),
    anomalySignalsEmitted: z.number(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();
    const reportId = `trend-${now.toISOString().split('T')[0]}`;

    await db.collection('reports').insertOne({
      id: reportId,
      type: 'trend',
      content: context.inputData.trendReport,
      anomalies: context.inputData.anomalies,
      growthAreas: context.inputData.growthAreas,
      recommendations: context.inputData.recommendations,
      generatedAt: now,
    });

    // Emit anomaly signals for other agents to react
    let anomalySignalsEmitted = 0;
    for (const anomaly of context.inputData.anomalies) {
      await db.collection('signals').insertOne({
        type: 'anomaly_detected',
        data: anomaly,
        sourceAgent: 'trend-analysis-workflow',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 48 * 3600 * 1000).toISOString(),
      });
      anomalySignalsEmitted++;
    }

    return { reportId, anomalySignalsEmitted };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const trendAnalysisWorkflow = createWorkflow({
  id: 'trend-analysis',
  description: 'Analizuje trendy CRM + RSS + agentów, wykrywa anomalie i emituje sygnały.',
  inputSchema: z.object({
    periodDays: z.number().default(14),
    comparisonPeriodDays: z.number().default(14),
  }),
  outputSchema: z.object({
    reportId: z.string(),
    anomalySignalsEmitted: z.number(),
  }),
})
  .then(collectTrendDataStep)
  .then(generateInsightsStep)
  .then(saveTrendReportStep);

trendAnalysisWorkflow.commit();
