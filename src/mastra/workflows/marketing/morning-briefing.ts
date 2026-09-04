/**
 * Workflow: morning-briefing
 * Codziennie rano: pobiera RSS + sygnały + digest dla meta-agenta.
 * Etap 6 – marketing workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { marketingAgent } from '../../agents/marketing-agent';
import { analyticsAgent } from '../../agents/analytics-agent';
import { getDb } from '../../lib/mongo';

const gatherDataStep = createStep({
  id: 'gather-briefing-data',
  description: 'Pobiera artykuły RSS, sygnały z shared memory i statusy CRM.',
  inputSchema: z.object({
    maxArticles: z.number().default(10),
    includeCrm: z.boolean().default(true),
  }),
  outputSchema: z.object({
    articles: z.array(z.object({ title: z.string(), content: z.string(), url: z.string() })),
    signals: z.array(z.object({ type: z.string(), content: z.string() })),
    crmStats: z.object({
      totalLeads: z.number(),
      hotLeads: z.number(),
      pendingDrafts: z.number(),
    }),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();

    // RSS articles (last 24h)
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const articles = await db.collection('rss_articles')
      .find({ pubDate: { $gte: cutoff } })
      .sort({ pubDate: -1 })
      .limit(context.inputData.maxArticles)
      .toArray();

    // Active signals
    const signals = await db.collection('signals')
      .find({ expiresAt: { $gt: now } })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    // CRM stats
    let crmStats = { totalLeads: 0, hotLeads: 0, pendingDrafts: 0 };
    if (context.inputData.includeCrm) {
      const [total, hot, drafts] = await Promise.all([
        db.collection('leads').countDocuments({}),
        db.collection('leads').countDocuments({ status: { $in: ['odpowiedział', 'spotkanie_umówione'] } }),
        db.collection('leads').countDocuments({ status: 'draft_gotowy' }),
      ]);
      crmStats = { totalLeads: total, hotLeads: hot, pendingDrafts: drafts };
    }

    return {
      articles: articles.map(a => ({ title: a.title ?? '', content: (a.description ?? a.content ?? '').slice(0, 400), url: a.link ?? '' })),
      signals: signals.map(s => ({ type: s.type ?? '', content: typeof s.data === 'string' ? s.data : JSON.stringify(s.data ?? {}) })),
      crmStats,
    };
  },
});

const generateBriefingStep = createStep({
  id: 'generate-briefing',
  description: 'Marketing Agent generuje spersonalizowany briefing dzienny.',
  inputSchema: z.object({
    articles: z.array(z.object({ title: z.string(), content: z.string(), url: z.string() })),
    signals: z.array(z.object({ type: z.string(), content: z.string() })),
    crmStats: z.object({ totalLeads: z.number(), hotLeads: z.number(), pendingDrafts: z.number() }),
  }),
  outputSchema: z.object({
    briefing: z.string(),
    keyActions: z.array(z.string()),
  }),
  execute: async (context) => {
    const { articles, signals, crmStats } = context.inputData;

    const prompt = `Wygeneruj dzienny briefing dla GastroBridge (${new Date().toLocaleDateString('pl-PL')}).

## Dane wejściowe

### Artykuły RSS (${articles.length}):
${articles.slice(0, 5).map(a => `- **${a.title}**: ${a.content}`).join('\n')}

### Sygnały systemowe (${signals.length}):
${signals.map(s => `- [${s.type}] ${s.content}`).join('\n') || '- Brak aktywnych sygnałów'}

### Status CRM:
- Łącznie leadów: ${crmStats.totalLeads}
- Gorące leady (wymagają działania): ${crmStats.hotLeads}
- Gotowe drafty do wysyłki: ${crmStats.pendingDrafts}

## Zadanie
Wygeneruj:
1. Krótkie podsumowanie branży HoReCa (max 3 zdania)
2. Top 3 artykuły warte uwagi (tytuł + 1 zdanie dlaczego)
3. Lista pilnych działań na dziś (max 5 punktorów)
4. Sygnały wymagające reakcji (jeśli są)

Format: czytelny Markdown, po polsku.`;

    const result = await marketingAgent.generate(prompt);

    // Extract key actions (lines starting with - or *)
    const lines = result.text.split('\n');
    const keyActions = lines
      .filter(l => /^[-*]\s/.test(l.trim()))
      .map(l => l.replace(/^[-*]\s+/, '').trim())
      .slice(0, 5);

    return { briefing: result.text, keyActions };
  },
});

const saveBriefingStep = createStep({
  id: 'save-briefing',
  description: 'Zapisuje briefing w shared_memory dla innych agentów.',
  inputSchema: z.object({
    briefing: z.string(),
    keyActions: z.array(z.string()),
  }),
  outputSchema: z.object({
    savedId: z.string(),
    date: z.string(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const date = new Date().toISOString().split('T')[0];
    const id = `morning-briefing-${date}`;

    await db.collection('shared_memory').updateOne(
      { key: id },
      {
        $set: {
          id,
          key: id,
          type: 'decision',
          sourceAgent: 'morning-briefing-workflow',
          content: context.inputData.briefing,
          metadata: { keyActions: context.inputData.keyActions },
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
        },
      },
      { upsert: true },
    );

    return { savedId: id, date };
  },
});

export const morningBriefingWorkflow = createWorkflow({
  id: 'morning-briefing',
  description: 'Codzienny briefing: RSS + sygnały + CRM stats → krótki digest dla agentów.',
  inputSchema: z.object({
    maxArticles: z.number().default(10),
    includeCrm: z.boolean().default(true),
  }),
  outputSchema: z.object({
    savedId: z.string(),
    date: z.string(),
  }),
})
  .then(gatherDataStep)
  .then(generateBriefingStep)
  .then(saveBriefingStep);

morningBriefingWorkflow.commit();
