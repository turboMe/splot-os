import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { Agent } from '@mastra/core/agent';
import {
  weeklyContentCopyAgent,
  weeklyContentCopyRepairAgent,
  weeklyContentJsonRepairAgent,
  weeklyContentResearchAgent,
  weeklyContentTranslationAgent,
} from '../agents/marketing-agent';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { format, addDays, isValid, parseISO, startOfWeek } from 'date-fns';
import { knowledgeQueryMultiTool, knowledgeResearchStartTool } from '../tools/knowledge/knowledge-tools.js';
import { CalendarService } from '../tools/google/calendar.js';
import { getDraftsStore } from '../lib/drafts-store.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import {
  markFreshContentSignalsUsed,
  saveResearchRun,
  searchFreshContentSignals,
  updateResearchRunStatus,
  type FreshContentSignal,
  type ResearchRunQuality,
} from '../lib/content-signals.js';

// ── Schemas ─────────────────────────────────────────────────────────────────
const newsHookSchema = z.object({
  topic: z.string(),
  hook: z.string(),
  data: z.string(),
  source: z.string(),
  bestFor: z.string(),
});

const competitorMoveSchema = z.object({
  competitor: z.string(),
  move: z.string(),
  ourAngle: z.string(),
});

const contentHistoryItemSchema = z.object({
  topic: z.string(),
  type: z.string(),
  language: z.string(),
  weekStarting: z.string().optional(),
  scheduledFor: z.string().optional(),
  rationale: z.string().optional(),
});

const freshSignalHookSchema = z.object({
  hook: z.string(),
  bestFor: z.string(),
  angle: z.string(),
});

const freshContentSignalSchema = z.object({
  id: z.string(),
  guid: z.string(),
  title: z.string(),
  source: z.string(),
  sourceName: z.string(),
  url: z.string(),
  publishedAt: z.string(),
  summary: z.string(),
  whyItMatters: z.string(),
  language: z.string(),
  country: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  bestAngles: z.array(z.string()),
  hooks: z.array(freshSignalHookSchema),
  score: z.number(),
  confidence: z.number(),
  novelty: z.number(),
});

const researchQualitySchema = z.object({
  passed: z.boolean(),
  score: z.number(),
  reasons: z.array(z.string()),
});

const researchResultSchema = z.object({
  newsHooks: z.array(newsHookSchema),
  competitorMoves: z.array(competitorMoveSchema),
  sourceCitations: z.array(z.string()).optional(),
});

const liPostSchema = z.object({
  account: z.string(),
  topic: z.string(),
  post: z.string(),
  hashtags: z.array(z.string()),
  char_count: z.number(),
  rationale: z.string(),
  suggestedDay: z.string(),
  suggestedTime: z.string(),
  needsImage: z.boolean(),
  imagePrompt: z.string(),
});

const igPostSchema = z.object({
  type: z.string(),
  topic: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
  char_count: z.number(),
  rationale: z.string(),
  suggestedDay: z.string(),
  suggestedTime: z.string(),
  imagePrompt: z.string(),
  slideCount: z.number(),
});

const enPostSchema = z.object({
  originalTopic: z.string(),
  post: z.string(),
  hashtags: z.array(z.string()),
  char_count: z.number(),
  adaptationNotes: z.string(),
});

const copyPlResultSchema = z.object({
  linkedin: z.array(liPostSchema),
  instagram: z.array(igPostSchema),
});

const copyEnResultSchema = z.object({
  translations: z.array(enPostSchema),
});

const extractJsonText = (text: string): string => {
  const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (match) return match[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
};

const tryParseJson = <T = unknown>(text: string): T | null => {
  try {
    return JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
};

const tryParseLooseJson = <T = unknown>(text: string): T | null => {
  try {
    const repaired = extractJsonText(text)
      .replace(/([{\[,]\s*)_([A-Za-z][A-Za-z0-9_]*)"\s*:/g, '$1"$2":')
      .replace(/([{\[,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/"hashtations"\s*:/g, '"hashtags":')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(repaired);
  } catch {
    return null;
  }
};

const normalizeCount = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
};

const CORE_RESEARCH_NOTEBOOKS = ['rynek', 'rhd', 'konkurencja', 'founder'] as const;
type ResearchNotebook = typeof CORE_RESEARCH_NOTEBOOKS[number];
type NotebookAnswer = { answer: string; citations: string[]; error?: string };
type ContentHistoryItem = z.infer<typeof contentHistoryItemSchema>;
type ResearchResult = z.infer<typeof researchResultSchema>;
type LiPost = z.infer<typeof liPostSchema>;
type IgPost = z.infer<typeof igPostSchema>;
type CopyPlResult = z.infer<typeof copyPlResultSchema>;

const NO_SOURCE_NOTE = 'Brak wiarygodnych danych z NotebookLM. Nie wymyślaj nowych faktów ani liczb; jeśli trzeba, wybierz evergreen angle bez danych liczbowych.';
const LOW_SIGNAL_PATTERNS = [
  /brak danych/i,
  /brak .*informacji/i,
  /nie znaleziono/i,
  /nie mam/i,
  /niedostęp/i,
  /no data/i,
  /not found/i,
  /unavailable/i,
  /cannot/i,
  /can't/i,
];

function emptyNotebookAnswer(error?: string): NotebookAnswer {
  return { answer: NO_SOURCE_NOTE, citations: [], error };
}

function normalizeNotebookResults(results: unknown): Record<ResearchNotebook, NotebookAnswer> {
  const rawResults = results && typeof results === 'object' ? results as Record<string, any> : {};
  return Object.fromEntries(CORE_RESEARCH_NOTEBOOKS.map((notebook) => {
    const raw = rawResults[notebook];
    if (!raw || raw.error) {
      return [notebook, emptyNotebookAnswer(raw?.error)];
    }
    return [notebook, {
      answer: typeof raw.answer === 'string' && raw.answer.trim() ? raw.answer : NO_SOURCE_NOTE,
      citations: Array.isArray(raw.citations) ? raw.citations.filter((v: unknown): v is string => typeof v === 'string') : [],
    }];
  })) as Record<ResearchNotebook, NotebookAnswer>;
}

function buildCoreResearchQuestion(weekDate: string): string {
  return `Przygotuj research do tygodniowego contentu GastroBridge dla tygodnia ${weekDate}.

Rozbij odpowiedź na obszary zgodne z notebookiem:
- rynek: najważniejsze aktualne sygnały z polskiej HoReCa, rolnictwa, cen, dostaw i lokalnych producentów.
- rhd: praktyczne wnioski z RHD/PKE/regulacji dla producentów żywności i restauratorów.
- konkurencja: Choco, Proky, Rekki i inne platformy dostawcze; konkretne ruchy, pozycjonowanie, feature'y.
- founder: głos Patryka, historia Head Chefa, doświadczenie kuchni, argumenty bez marketingowej waty.

Podawaj tylko fakty obecne w źródłach notebooka. Jeśli notebook nie ma aktualnych danych, napisz to jawnie zamiast zgadywać. Zachowaj cytowalne źródła.`;
}

function buildFreshResearchQuery(notebook: ResearchNotebook, weekDate: string): string {
  const queries: Record<ResearchNotebook, string> = {
    rynek: `Aktualne wydarzenia z tygodnia ${weekDate} na polskim rynku HoReCa, lokalni producenci żywności, ceny, dostawy, restauracje, marketplace B2B.`,
    rhd: `Aktualne informacje z tygodnia ${weekDate} o RHD, PKE, lokalnych producentach żywności i sprzedaży do gastronomii w Polsce.`,
    konkurencja: `Aktualne ruchy konkurencji z tygodnia ${weekDate}: Choco, Proky, Rekki, platformy zakupowe dla HoReCa i dostawców żywności.`,
    founder: `Kontekst founder voice GastroBridge: Patryk jako były Head Chef, doświadczenia kuchni, ton komunikacji dla HoReCa.`,
  };
  return queries[notebook];
}

function isWeakFreshnessSignal(result: NotebookAnswer): boolean {
  const answer = result.answer.trim();
  if (!answer || answer === NO_SOURCE_NOTE || answer.length < 220) return true;
  if (result.citations.length < 2) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(answer));
}

function getWeakFreshResearchNotebooks(results: Record<ResearchNotebook, NotebookAnswer>): ResearchNotebook[] {
  return (['rynek', 'rhd', 'konkurencja'] as ResearchNotebook[])
    .filter((notebook) => isWeakFreshnessSignal(results[notebook]));
}

function resolveFreshResearchMode(): 'fast' | 'deep' {
  return process.env.WEEKLY_CONTENT_FRESH_RESEARCH_MODE === 'deep' ? 'deep' : 'fast';
}

async function queryCoreNotebooks(taskId: string, weekDate: string): Promise<Record<ResearchNotebook, NotebookAnswer>> {
  try {
    const result = await knowledgeQueryMultiTool.execute!({
      notebooks: [...CORE_RESEARCH_NOTEBOOKS],
      question: buildCoreResearchQuestion(weekDate),
    }, {} as any);
    if (result && 'success' in result && result.success) {
      return normalizeNotebookResults((result as any).results);
    }
    console.warn(`[weekly-content:${taskId}] knowledge.query_multi returned no usable results`);
  } catch (err) {
    console.warn(`[weekly-content:${taskId}] knowledge.query_multi fail:`, (err as Error).message);
  }
  return normalizeNotebookResults({});
}

async function refreshWeakNotebookSources(
  taskId: string,
  weekDate: string,
  notebookResults: Record<ResearchNotebook, NotebookAnswer>,
): Promise<string[]> {
  const configuredMaxResearchStarts = Number(process.env.WEEKLY_CONTENT_MAX_FRESH_RESEARCH ?? 2);
  const maxResearchStarts = Number.isFinite(configuredMaxResearchStarts) ? Math.max(0, configuredMaxResearchStarts) : 2;
  const weakNotebooks = getWeakFreshResearchNotebooks(notebookResults).slice(0, maxResearchStarts);
  const notes: string[] = [];
  if (weakNotebooks.length === 0) return notes;

  for (const notebook of weakNotebooks) {
    try {
      const result = await knowledgeResearchStartTool.execute!({
        query: buildFreshResearchQuery(notebook, weekDate),
        notebookId: notebook,
        mode: resolveFreshResearchMode(),
        autoImport: true,
      }, {} as any);
      if (result && 'success' in result && result.success) {
        notes.push(`knowledge.research_start:${notebook}:${(result as any).taskId || 'started'}`);
      } else {
        notes.push(`knowledge.research_start:${notebook}:failed:${(result as any)?.error ?? 'unknown error'}`);
      }
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[weekly-content:${taskId}] research_start ${notebook} fail:`, message);
      notes.push(`knowledge.research_start:${notebook}:failed:${message}`);
    }
  }
  return notes;
}

function formatNotebookSection(title: string, result: NotebookAnswer): string {
  return `${title}:
${result.answer}
Cytaty: ${result.citations.join('\n') || 'Brak cytatów.'}${result.error ? `\nBłąd: ${compactDiagnostic(result.error)}` : ''}`;
}

function formatContentHistory(history: ContentHistoryItem[]): string {
  if (history.length === 0) {
    return 'Brak ostatnich draftów w historii. Nadal unikaj generycznych tematów i pilnuj unikalności angle.';
  }
  return history
    .map((item, index) => `${index + 1}. ${item.topic} | ${item.type} | ${item.language}${item.weekStarting ? ` | tydz. ${item.weekStarting}` : ''}${item.rationale ? ` | angle: ${item.rationale}` : ''}`)
    .join('\n');
}

async function loadRecentContentHistory(limit: number = 24): Promise<ContentHistoryItem[]> {
  const store = getDraftsStore();
  const metadata = await store.listRecentMetadata(limit * 3);
  const seen = new Set<string>();
  const result: ContentHistoryItem[] = [];

  for (const item of metadata) {
    if (item.agentId !== 'marketing-agent') continue;
    if (!['linkedin-post', 'instagram-caption'].includes(item.type)) continue;
    if (!item.topic) continue;

    const key = `${item.type}:${item.language}:${item.topic.toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      topic: item.topic,
      type: item.type,
      language: item.language,
      weekStarting: item.weekStarting,
      scheduledFor: item.scheduledFor,
      rationale: item.rationale,
    });
    if (result.length >= limit) break;
  }

  return result;
}

function collectCitations(
  notebookResults: Record<ResearchNotebook, NotebookAnswer>,
): string[] {
  return Array.from(new Set([
    ...CORE_RESEARCH_NOTEBOOKS.flatMap((notebook) => notebookResults[notebook].citations),
  ].filter(isUsableCitation)));
}

function compactDiagnostic(note: string): string {
  const compact = note
    .replace(/\s*Available: [\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
}

function collectResearchDiagnostics(
  notebookResults: Record<ResearchNotebook, NotebookAnswer>,
  freshnessNotes: string[],
): string[] {
  const queryErrors = CORE_RESEARCH_NOTEBOOKS.flatMap((notebook) => (
    notebookResults[notebook].error
      ? [`knowledge.query_multi:${notebook}:failed:${notebookResults[notebook].error}`]
      : []
  ));
  return Array.from(new Set([...queryErrors, ...freshnessNotes].map(compactDiagnostic).filter(Boolean)));
}

function resolveNumberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isStrictResearchGateEnabled(): boolean {
  return process.env.WEEKLY_CONTENT_REQUIRE_RICH_RESEARCH !== 'false';
}

function isUsableCitation(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const citation = value.trim();
  if (!citation) return false;
  if (/^(no-current-source|llm fallback)$/i.test(citation)) return false;
  if (/^knowledge\./i.test(citation)) return false;
  if (/notebook\s+".*"\s+not found/i.test(citation)) return false;
  if (/\bavailable:\s+/i.test(citation)) return false;
  return true;
}

function getFreshSignalDate(signal: FreshContentSignal): Date | null {
  const parsed = new Date(signal.publishedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecentFreshSignal(signal: FreshContentSignal, weekDate: string, days: number): boolean {
  const date = getFreshSignalDate(signal);
  if (!date) return false;
  const anchor = new Date(`${weekDate}T00:00:00.000Z`);
  const safeAnchor = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
  return date.getTime() >= safeAnchor.getTime() - days * 24 * 60 * 60 * 1000;
}

function freshSignalSourceKey(signal: FreshContentSignal): string {
  return (signal.sourceName || signal.source || 'unknown-source').toLowerCase().trim();
}

function selectDiverseFreshSignals(signals: FreshContentSignal[], maxCount: number): FreshContentSignal[] {
  const sorted = [...signals].sort((a, b) => {
    const languageScore = (b.language === 'pl' ? 1 : 0) - (a.language === 'pl' ? 1 : 0);
    if (languageScore !== 0) return languageScore;
    return b.score - a.score;
  });

  const selected: FreshContentSignal[] = [];
  const perSource = new Map<string, number>();

  for (const signal of sorted) {
    const sourceKey = freshSignalSourceKey(signal);
    const used = perSource.get(sourceKey) ?? 0;
    if (used >= 2) continue;
    selected.push(signal);
    perSource.set(sourceKey, used + 1);
    if (selected.length >= maxCount) return selected;
  }

  for (const signal of sorted) {
    if (selected.some((item) => item.id === signal.id || item.url === signal.url)) continue;
    selected.push(signal);
    if (selected.length >= maxCount) break;
  }

  return selected;
}

function collectFreshSignalCitations(signals: FreshContentSignal[]): string[] {
  return Array.from(new Set(signals.map((signal) => signal.url).filter(isUsableCitation)));
}

function formatFreshSignalSection(signals: FreshContentSignal[]): string {
  if (signals.length === 0) {
    return 'Brak zweryfikowanych freshSignals z rss_intelligence. Nie wymyślaj aktualnych newsów ani liczb.';
  }

  return signals.map((signal, index) => {
    const hooks = signal.hooks
      .slice(0, 3)
      .map((hook) => `- ${hook.bestFor}: ${hook.hook} (${hook.angle})`)
      .join('\n');
    return `${index + 1}. ${signal.title}
Źródło: ${signal.sourceName} | ${signal.url}
Data: ${signal.publishedAt}
Język/kategoria: ${signal.language}/${signal.category}
Score: ${signal.score.toFixed(2)} | confidence: ${signal.confidence.toFixed(2)}
Streszczenie: ${signal.summary || 'Brak streszczenia.'}
Dlaczego ważne: ${signal.whyItMatters || 'Brak oceny.'}
Proponowane hooki:
${hooks || '- brak gotowych hooków'}`;
  }).join('\n\n');
}

function buildNewsHookFromSignal(signal: FreshContentSignal, index: number): z.infer<typeof newsHookSchema> {
  const preferredHook = signal.hooks.find((hook) => hook.bestFor !== 'instagram') ?? signal.hooks[0];
  const hook = preferredHook?.hook || signal.summary || signal.title;
  return {
    topic: signal.title || `fresh signal ${index + 1}`,
    hook: cleanGeneratedText(hook),
    data: cleanGeneratedText(signal.whyItMatters || signal.summary || ''),
    source: signal.url,
    bestFor: normalizeBestFor(preferredHook?.bestFor ?? 'linkedin-company'),
  };
}

function mergeFreshSignalHooksIntoResearch(research: ResearchResult, signals: FreshContentSignal[]): ResearchResult {
  if (signals.length === 0) return research;

  const usableHooks = research.newsHooks.filter((hook) => isUsableCitation(hook.source));
  const needed = Math.max(0, 3 - usableHooks.length);
  const signalHooks = signals
    .slice(0, Math.max(needed, 3))
    .map((signal, index) => buildNewsHookFromSignal(signal, index));

  const merged = [
    ...usableHooks,
    ...signalHooks.filter((hook) => !usableHooks.some((existing) => existing.source === hook.source || existing.topic.toLowerCase() === hook.topic.toLowerCase())),
  ].slice(0, 3);

  return {
    ...research,
    newsHooks: merged.length > 0 ? merged : research.newsHooks,
    sourceCitations: Array.from(new Set([
      ...(research.sourceCitations ?? []),
      ...collectFreshSignalCitations(signals),
    ].filter(isUsableCitation))),
  };
}

function getSourceCoverage(signals: FreshContentSignal[]): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const signal of signals) {
    const key = signal.sourceName || signal.source || 'unknown-source';
    coverage[key] = (coverage[key] ?? 0) + 1;
  }
  return coverage;
}

function evaluateResearchQuality(
  weekDate: string,
  research: ResearchResult,
  signals: FreshContentSignal[],
  diagnostics: string[],
): ResearchRunQuality {
  const minSignals = resolveNumberEnv('WEEKLY_CONTENT_MIN_FRESH_SIGNALS', 6);
  const minPolishSignals = resolveNumberEnv('WEEKLY_CONTENT_MIN_PL_SIGNALS', 4);
  const minDistinctSources = resolveNumberEnv('WEEKLY_CONTENT_MIN_DISTINCT_SOURCES', 3);
  const minRecentSignals = resolveNumberEnv('WEEKLY_CONTENT_MIN_RECENT_SIGNALS', 3);
  const minCitations = resolveNumberEnv('WEEKLY_CONTENT_MIN_CITATIONS', 3);
  const reasons: string[] = [];

  const citations = Array.from(new Set([
    ...(research.sourceCitations ?? []),
    ...collectFreshSignalCitations(signals),
  ].filter(isUsableCitation)));
  const polishSignals = signals.filter((signal) => signal.language === 'pl').length;
  const distinctSources = new Set(signals.map(freshSignalSourceKey).filter(Boolean)).size;
  const recentSignals = signals.filter((signal) => isRecentFreshSignal(signal, weekDate, 14)).length;
  const sourcedHooks = research.newsHooks.filter((hook) => isUsableCitation(hook.source)).length;
  const hasPendingNotebookImport = diagnostics.some((note) => /sources not yet imported|niezaimport/i.test(note));

  if (signals.length < minSignals) reasons.push(`freshSignals:${signals.length}/${minSignals}`);
  if (polishSignals < minPolishSignals) reasons.push(`polishSignals:${polishSignals}/${minPolishSignals}`);
  if (distinctSources < minDistinctSources) reasons.push(`distinctSources:${distinctSources}/${minDistinctSources}`);
  if (recentSignals < minRecentSignals) reasons.push(`recentSignals14d:${recentSignals}/${minRecentSignals}`);
  if (citations.length < minCitations) reasons.push(`citations:${citations.length}/${minCitations}`);
  if (research.newsHooks.length === 0) reasons.push('newsHooks:0');
  if (sourcedHooks < research.newsHooks.length) reasons.push(`sourcedHooks:${sourcedHooks}/${research.newsHooks.length}`);
  if (hasPendingNotebookImport && signals.length < minSignals) reasons.push('notebookImportPendingWithoutDbBackup');

  const checks = 7;
  const failed = reasons.length;
  return {
    passed: failed === 0,
    score: Math.max(0, Math.round(((checks - Math.min(failed, checks)) / checks) * 100) / 100),
    reasons,
  };
}

async function loadFreshSignalsForWeek(taskId: string, weekDate: string): Promise<{ signals: FreshContentSignal[]; diagnostics: string[] }> {
  try {
    const fetched = await searchFreshContentSignals({
      weekDate,
      limit: resolveNumberEnv('WEEKLY_CONTENT_FRESH_SIGNAL_LIMIT', 18),
      minRelevance: resolveNumberEnv('WEEKLY_CONTENT_MIN_SIGNAL_RELEVANCE', 0.6),
      excludeUsed: process.env.WEEKLY_CONTENT_REUSE_SIGNALS === 'true' ? false : true,
    });
    const selected = selectDiverseFreshSignals(fetched, resolveNumberEnv('WEEKLY_CONTENT_SELECTED_SIGNAL_LIMIT', 10));
    return {
      signals: selected,
      diagnostics: [`content.signals.search:ok:${selected.length}/${fetched.length}`],
    };
  } catch (err) {
    const message = compactDiagnostic((err as Error).message);
    console.warn(`[weekly-content:${taskId}] content.signals.search fail:`, message);
    return { signals: [], diagnostics: [`content.signals.search:failed:${message}`] };
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function asArray(value: unknown): Record<string, any>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, any> => Boolean(asRecord(item))) : [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractHashtags(text: string): string[] {
  return Array.from(new Set(text.match(/#[\p{L}\p{N}_-]+/gu) ?? []));
}

function cleanGeneratedText(value: string): string {
  return value.replace(/[–—]/g, '-').trim();
}

function normalizeHashtags(value: unknown, fallbackText: string, maxCount: number): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const fromFields = rawValues
    .filter((tag): tag is string => typeof tag === 'string')
    .flatMap((tag) => tag.split(/[\s,]+/));
  const tags = [...fromFields, ...extractHashtags(fallbackText)]
    .map((tag) => tag.trim())
    .filter((tag) => /^#[\p{L}\p{N}_-]+$/u.test(tag));
  return Array.from(new Set(tags)).slice(0, maxCount);
}

function parseSchedule(schedule: unknown, fallbackDay: string, fallbackTime: string): { day: string; time: string } {
  const value = typeof schedule === 'string' ? schedule : '';
  const time = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)?.[0] ?? fallbackTime;
  const normalized = value.toLowerCase();
  const dayMap: Array<[RegExp, string]> = [
    [/\b(mon|monday|poniedzialek|poniedziałek)\b/, 'Monday'],
    [/\b(tue|tuesday|wtorek)\b/, 'Tuesday'],
    [/\b(wed|wednesday|sroda|środa)\b/, 'Wednesday'],
    [/\b(thu|thursday|czwartek)\b/, 'Thursday'],
    [/\b(fri|friday|piatek|piątek)\b/, 'Friday'],
    [/\b(sat|saturday|sobota)\b/, 'Saturday'],
    [/\b(sun|sunday|niedziela)\b/, 'Sunday'],
  ];
  const day = dayMap.find(([pattern]) => pattern.test(normalized))?.[1] ?? fallbackDay;
  return { day, time };
}

function inferTopic(item: Record<string, any>, fallback: string): string {
  const explicit = firstString(item.topic, item.title, item.angle);
  if (explicit) return explicit;
  const text = firstString(item.post, item.content, item.caption);
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.replace(/^slide\s*\d+:\s*/i, '') ?? fallback;
}

function normalizeBestFor(value: unknown): string {
  const raw = firstString(value).toLowerCase();
  if (raw.includes('instagram')) return 'instagram';
  if (raw.includes('personal') || raw.includes('patryk') || raw.includes('osob')) return 'linkedin-personal';
  if (raw.includes('company') || raw.includes('firm')) return 'linkedin-company';
  if (raw.includes('linkedin')) return 'linkedin-company';
  return 'linkedin-company';
}

function normalizeResearchOutput(parsed: unknown): ResearchResult | null {
  const raw = asRecord(parsed);
  if (!raw) return null;

  const rawNewsHooks: Record<string, any>[] = [
    ...asArray(raw.newsHooks),
    ...asArray(raw.news_hooks),
    ...asArray(raw.hooks),
    ...asArray(raw.news),
  ];
  const rawCompetitorMoves: Record<string, any>[] = [
    ...asArray(raw.competitorMoves),
    ...asArray(raw.competitor_moves),
    ...asArray(raw.competitors),
    ...asArray(raw.moves),
  ];

  if (rawNewsHooks.length === 0 && rawCompetitorMoves.length === 0) return null;

  const sourceCitations = [
    ...(
      Array.isArray(raw.sourceCitations)
        ? raw.sourceCitations
        : Array.isArray(raw.source_citations)
          ? raw.source_citations
          : Array.isArray(raw.citations)
            ? raw.citations
            : []
    ),
  ].filter((citation): citation is string => typeof citation === 'string' && citation.trim().length > 0);

  const newsHooks = rawNewsHooks.map((item, index) => ({
    topic: firstString(item.topic, item.title, item.angle, `research hook ${index + 1}`),
    hook: firstString(item.hook, item.headline, item.summary, item.angle),
    data: firstString(item.data, item.fact, item.metric, item.number),
    source: firstString(item.source, item.citation, item.url, item.link, 'no-current-source'),
    bestFor: normalizeBestFor(item.bestFor ?? item.best_for ?? item.platform ?? item.channel),
  }));

  const competitorMoves = rawCompetitorMoves.map((item) => ({
    competitor: firstString(item.competitor, item.name, item.company, 'unknown-competitor'),
    move: firstString(item.move, item.action, item.activity, item.summary),
    ourAngle: firstString(item.ourAngle, item.our_angle, item.impact, item.angle, item.response),
  }));

  const normalized = { newsHooks, competitorMoves, sourceCitations };
  const validated = researchResultSchema.safeParse(normalized);
  return validated.success ? validated.data : null;
}

function normalizeResearchSource(source: string, data: string): string {
  const cleanSource = cleanGeneratedText(source);
  if (!cleanSource) return 'no-current-source';
  if (!data && /^(analiza|trendy|sygnaly|sygnały|obserwacje)\b/i.test(cleanSource)) return 'no-current-source';
  if (!data && /\b(oparte na sygnalach|oparte na sygnałach|trend(?:y|ow|ów)?|technologiczne|rynkowe)\b/i.test(cleanSource)) return 'no-current-source';
  if (/^(brak|none|null)$/i.test(cleanSource)) return 'no-current-source';
  return cleanSource;
}

function sanitizeResearchResult(result: ResearchResult, notebookCitations: string[]): ResearchResult {
  const newsHooks = result.newsHooks.map((item, index) => {
    const topic = cleanGeneratedText(firstString(item.topic, `research hook ${index + 1}`));
    const data = cleanGeneratedText(item.data);
    return {
      topic,
      hook: cleanGeneratedText(firstString(item.hook, topic)),
      data,
      source: normalizeResearchSource(item.source, data),
      bestFor: normalizeBestFor(item.bestFor),
    };
  });

  const competitorMoves = result.competitorMoves
    .map((item) => ({
      competitor: cleanGeneratedText(firstString(item.competitor, 'unknown-competitor')),
      move: cleanGeneratedText(item.move),
      ourAngle: cleanGeneratedText(item.ourAngle),
    }))
    .filter((item) => item.competitor !== 'unknown-competitor' && item.move && item.ourAngle);

  const sourceCitations = Array.from(new Set([
    ...(result.sourceCitations ?? []),
    ...notebookCitations,
  ].filter(isUsableCitation).map((citation) => citation.trim())));

  return { newsHooks, competitorMoves, sourceCitations };
}

function normalizeCopyPlOutput(parsed: unknown, liCount: number, igCount: number): CopyPlResult | null {
  const raw = asRecord(parsed);
  if (!raw) return null;

  const rawLinkedin: Record<string, any>[] = [
    ...asArray(raw.linkedin),
    ...asArray(raw.liPosts),
    ...asArray(raw.linkedin_personal).map((item) => ({ ...item, account: item.account ?? 'personal' })),
    ...asArray(raw.linkedin_company).map((item) => ({ ...item, account: item.account ?? 'company' })),
  ];
  const rawInstagram: Record<string, any>[] = [
    ...asArray(raw.instagram),
    ...asArray(raw.igPosts),
    ...asArray(raw.instagram_posts),
  ];

  if (rawLinkedin.length === 0 && rawInstagram.length === 0) return null;

  const linkedin = rawLinkedin.slice(0, liCount).map((item, index) => {
    const post = cleanGeneratedText(firstString(item.post, item.content, item.body, item.text));
    const topic = cleanGeneratedText(inferTopic(item, `LinkedIn post ${index + 1}`));
    const platform = firstString(item.platform, item.account).toLowerCase();
    const account = platform.includes('company') || platform.includes('firm') || item.account === 'company'
      ? 'company'
      : 'personal';
    const { day, time } = parseSchedule(
      item.schedule ?? `${firstString(item.suggestedDay, item.day)} ${firstString(item.suggestedTime, item.time)}`,
      account === 'personal' ? 'Tuesday' : 'Monday',
      account === 'personal' ? '10:00' : '10:00',
    );
    const hashtagsInput = item.hashtags ?? item.tags ?? item.hashtations;
    return {
      account,
      topic,
      post,
      hashtags: normalizeHashtags(hashtagsInput, post, 8),
      char_count: post.length,
      rationale: cleanGeneratedText(firstString(item.rationale, item.angle, account === 'personal' ? 'Perspektywa foundera i building in public.' : 'Edukacyjny angle dla rynku HoReCa.')),
      suggestedDay: day,
      suggestedTime: time,
      needsImage: typeof item.needsImage === 'boolean' ? item.needsImage : true,
      imagePrompt: cleanGeneratedText(firstString(item.imagePrompt, `Realistyczny obraz HoReCa dla tematu: ${topic}`)),
    };
  });

  const instagram = rawInstagram.slice(0, igCount).map((item, index) => {
    const caption = cleanGeneratedText(firstString(item.caption, item.content, item.post, item.text));
    const topic = cleanGeneratedText(inferTopic(item, `Instagram post ${index + 1}`));
    const platformOrType = firstString(item.type, item.platform).toLowerCase();
    const type = platformOrType.includes('carousel') || platformOrType.includes('karuzel')
      ? 'carousel'
      : platformOrType.includes('story')
        ? 'story'
        : platformOrType.includes('reel')
          ? 'reel'
          : 'post';
    const { day, time } = parseSchedule(
      item.schedule ?? `${firstString(item.suggestedDay, item.day)} ${firstString(item.suggestedTime, item.time)}`,
      index === 0 ? 'Wednesday' : 'Friday',
      '18:00',
    );
    const hashtagsInput = item.hashtags ?? item.tags ?? item.hashtations;
    return {
      type,
      topic,
      caption,
      hashtags: normalizeHashtags(hashtagsInput, caption, 15),
      char_count: caption.length,
      rationale: cleanGeneratedText(firstString(item.rationale, item.angle, 'Format dopasowany do Instagram i wybranego angle.')),
      suggestedDay: day,
      suggestedTime: time,
      imagePrompt: cleanGeneratedText(firstString(item.imagePrompt, `Instagramowy kadr HoReCa dla tematu: ${topic}`)),
      slideCount: typeof item.slideCount === 'number' ? item.slideCount : type === 'carousel' ? 5 : 1,
    };
  });

  const normalized = { linkedin, instagram };
  const validated = copyPlResultSchema.safeParse(normalized);
  return validated.success ? validated.data : null;
}

function sanitizeCopyPlResult(result: CopyPlResult): CopyPlResult {
  return {
    linkedin: result.linkedin.map((post) => {
      const cleanPost = cleanGeneratedText(post.post);
      const cleanTopic = cleanGeneratedText(post.topic);
      return {
        ...post,
        topic: cleanTopic,
        post: cleanPost,
        hashtags: normalizeHashtags(post.hashtags, cleanPost, 8),
        char_count: cleanPost.length,
        rationale: cleanGeneratedText(post.rationale),
        imagePrompt: cleanGeneratedText(post.imagePrompt),
      };
    }),
    instagram: result.instagram.map((post) => {
      const cleanCaption = cleanGeneratedText(post.caption);
      const cleanTopic = cleanGeneratedText(post.topic);
      return {
        ...post,
        topic: cleanTopic,
        caption: cleanCaption,
        hashtags: normalizeHashtags(post.hashtags, cleanCaption, 15),
        char_count: cleanCaption.length,
        rationale: cleanGeneratedText(post.rationale),
        imagePrompt: cleanGeneratedText(post.imagePrompt),
      };
    }),
  };
}

function assertCopyCounts(result: CopyPlResult, liCount: number, igCount: number, taskId: string): void {
  if (result.linkedin.length !== liCount || result.instagram.length !== igCount) {
    throw new Error(`[weekly-content:${taskId}] generate-pl returned LI:${result.linkedin.length}/IG:${result.instagram.length}, expected LI:${liCount}/IG:${igCount}`);
  }
}

function getLinkedInLengthIssues(result: CopyPlResult): string[] {
  const minChars = resolveNumberEnv('WEEKLY_CONTENT_MIN_LINKEDIN_CHARS', 1000);
  const maxChars = resolveNumberEnv('WEEKLY_CONTENT_MAX_LINKEDIN_CHARS', 2200);
  return result.linkedin.flatMap((post, index) => {
    const length = post.post.length;
    if (length < minChars) return [`linkedin[${index}] ${length}<${minChars}`];
    if (length > maxChars) return [`linkedin[${index}] ${length}>${maxChars}`];
    return [];
  });
}

async function ensureLinkedInLengthQuality({
  taskId,
  weekDate,
  research,
  current,
  liCount,
  igCount,
  systemPrompt,
}: {
  taskId: string;
  weekDate: string;
  research: unknown;
  current: CopyPlResult;
  liCount: number;
  igCount: number;
  systemPrompt: string;
}): Promise<CopyPlResult> {
  const initialIssues = getLinkedInLengthIssues(current);
  if (initialIssues.length === 0) return current;

  const minChars = resolveNumberEnv('WEEKLY_CONTENT_MIN_LINKEDIN_CHARS', 1000);
  const maxChars = resolveNumberEnv('WEEKLY_CONTENT_MAX_LINKEDIN_CHARS', 2200);
  console.warn(`[weekly-content:${taskId}] generate-pl LI length issues: ${initialIssues.join(', ')}, attempting expansion`);

  const repairPrompt = `Poprzednia odpowiedź ma za krótkie albo za długie posty LinkedIn.
Przepisz wynik do pełnego JSON-a z dokładnie ${liCount} postami LinkedIn i ${igCount} treściami Instagram.

Wymagania bez wyjątków:
- każdy LinkedIn post musi mieć od ${minChars} do ${maxChars} znaków w polu "post";
- rozwiń LinkedIn do 5-8 krótkich akapitów: hook, kontekst, konkret ze źródła, konsekwencja dla HoReCa, perspektywa GastroBridge, CTA;
- zachowaj prawdziwe źródła z researchu, nie dopowiadaj liczb;
- Instagram może zostać krótszy, ale ma pozostać w tablicy;
- zwróć tylko JSON z top-level keys "linkedin" i "instagram".

Tydzień: ${weekDate}

RESEARCH:
${JSON.stringify(research, null, 2)}

OBECNY WYNIK:
${JSON.stringify(current, null, 2)}

Problemy do naprawy:
${initialIssues.join('\n')}`;

  const repaired = sanitizeCopyPlResult(await generateJsonWithRepair({
    agent: weeklyContentCopyRepairAgent,
    taskId,
    stepId: 'generate-pl-length-repair',
    userPrompt: repairPrompt,
    systemPrompt,
    schema: copyPlResultSchema,
    modelSettings: { temperature: 0.3, maxOutputTokens: 12000 },
    normalizeBeforeRepair: (parsed) => normalizeCopyPlOutput(parsed, liCount, igCount),
  }));
  assertCopyCounts(repaired, liCount, igCount, taskId);

  const remainingIssues = getLinkedInLengthIssues(repaired);
  if (remainingIssues.length > 0) {
    throw new Error(`[weekly-content:${taskId}] LinkedIn quality gate failed after repair: ${remainingIssues.join(', ')}`);
  }
  return repaired;
}

function mergeUniqueBy<T>(primary: T[], secondary: T[], maxCount: number, getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...primary, ...secondary]) {
    const key = getKey(item).toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= maxCount) break;
  }
  return merged;
}

function getResearchHooksForFallback(research: unknown): Array<{ topic: string; hook: string; data: string; source: string }> {
  const raw = asRecord(research);
  const hooks = asArray(raw?.newsHooks);
  if (hooks.length === 0) {
    return [{
      topic: 'Zaopatrzenie restauracji bez chaosu',
      hook: 'Zaopatrzenie restauracji nie powinno opierać się na dziesiątkach telefonów i zgadywaniu dostępności.',
      data: '',
      source: 'no-current-source',
    }];
  }
  return hooks.map((item, index) => {
    const topic = cleanGeneratedText(firstString(item.topic, `Temat HoReCa ${index + 1}`));
    return {
      topic,
      hook: cleanGeneratedText(firstString(item.hook, topic)),
      data: cleanGeneratedText(firstString(item.data)),
      source: normalizeResearchSource(firstString(item.source, 'no-current-source'), firstString(item.data)),
    };
  });
}

function buildFallbackLiPost(index: number, research: unknown): LiPost {
  const hook = getResearchHooksForFallback(research)[index % getResearchHooksForFallback(research).length];
  const account = index % 2 === 0 ? 'personal' : 'company';
  const sourceLine = hook.data && hook.source !== 'no-current-source'
    ? `\n\nDane wejściowe do tego angle: ${hook.data}. Źródło: ${hook.source}.`
    : '\n\nNie dokładam tutaj liczb bez źródła. To bezpieczny angle operacyjny do rozwinięcia na bazie doświadczenia kuchni.';
  const post = cleanGeneratedText(`${hook.hook}

W gastronomii takie tematy szybko schodzą z poziomu "trend" do poziomu codziennej pracy: zamówienia, dostępność produktu, zmiana ceny, kontakt z dostawcą.

GastroBridge ma pomagać właśnie w tej warstwie - mniej zgadywania, więcej porównywalnych informacji w jednym miejscu.${sourceLine}

Co dziś najbardziej utrudnia zaopatrzenie w Twojej kuchni?`);
  return {
    account,
    topic: hook.topic,
    post,
    hashtags: normalizeHashtags(['#GastroBridge', '#HoReCa', '#gastronomia', '#foodtech', '#dostawcy'], post, 8),
    char_count: post.length,
    rationale: 'Techniczny fallback po niepełnej odpowiedzi modelu; bez nowych faktów i liczb.',
    suggestedDay: account === 'personal' ? 'Tuesday' : 'Monday',
    suggestedTime: '10:00',
    needsImage: true,
    imagePrompt: `Realistyczny obraz HoReCa dla tematu: ${hook.topic}`,
  };
}

function buildFallbackIgPost(index: number, research: unknown): IgPost {
  const hook = getResearchHooksForFallback(research)[index % getResearchHooksForFallback(research).length];
  const type = index % 3 === 0 ? 'carousel' : index % 3 === 1 ? 'reel' : 'post';
  const caption = cleanGeneratedText(type === 'carousel'
    ? `Slide 1: ${hook.topic}
Slide 2: Problem: zaopatrzenie restauracji jest często rozproszone między telefonami, mailami i wiadomościami.
Slide 3: Skutek: trudniej porównać dostępność, ceny i alternatywnych dostawców.
Slide 4: Lepszy kierunek: jedno miejsce do porównania dostawców i produktów.
Slide 5: GastroBridge buduje taki system dla HoReCa.`
    : `${hook.topic}

Mniej chaosu w zamówieniach. Więcej kontroli nad dostawami. Bez dopowiadania liczb, jeśli nie mamy źródła.

Tak chcemy budować GastroBridge - praktycznie, od kuchni.`);
  return {
    type,
    topic: hook.topic,
    caption,
    hashtags: normalizeHashtags(['#GastroBridge', '#HoReCa', '#gastronomia', '#restauracja', '#foodtech', '#dostawcy', '#lokalneprodukty'], caption, 15),
    char_count: caption.length,
    rationale: 'Techniczny fallback po niepełnej odpowiedzi modelu; format Instagram bez nowych faktów i liczb.',
    suggestedDay: index === 0 ? 'Wednesday' : 'Friday',
    suggestedTime: index === 0 ? '18:00' : '12:30',
    imagePrompt: `Instagramowy kadr HoReCa dla tematu: ${hook.topic}`,
    slideCount: type === 'carousel' ? 5 : 1,
  };
}

function fillMissingCopyDeterministically(result: CopyPlResult, research: unknown, liCount: number, igCount: number): CopyPlResult {
  const linkedin = [...result.linkedin];
  const instagram = [...result.instagram];
  while (linkedin.length < liCount) linkedin.push(buildFallbackLiPost(linkedin.length, research));
  while (instagram.length < igCount) instagram.push(buildFallbackIgPost(instagram.length, research));
  return sanitizeCopyPlResult({
    linkedin: linkedin.slice(0, liCount),
    instagram: instagram.slice(0, igCount),
  });
}

async function completeCopyCounts({
  taskId,
  weekDate,
  research,
  current,
  liCount,
  igCount,
  systemPrompt,
}: {
  taskId: string;
  weekDate: string;
  research: unknown;
  current: CopyPlResult;
  liCount: number;
  igCount: number;
  systemPrompt: string;
}): Promise<CopyPlResult> {
  const initial = sanitizeCopyPlResult({
    linkedin: current.linkedin.slice(0, liCount),
    instagram: current.instagram.slice(0, igCount),
  });
  if (initial.linkedin.length === liCount && initial.instagram.length === igCount) return initial;

  console.warn(`[weekly-content:${taskId}] generate-pl incomplete LI:${initial.linkedin.length}/IG:${initial.instagram.length}, attempting count top-up`);
  const topUpPrompt = `Poprzednia odpowiedź kroku generate-pl była niepełna.
Masz zwrócić pełny obiekt JSON z dokładnie ${liCount} postami LinkedIn i dokładnie ${igCount} treściami Instagram.

Zachowaj istniejące poprawne posty, ale dodaj brakujące elementy. Szczególnie pilnuj tablicy "instagram" - nie może być pusta.

Tydzień: ${weekDate}

RESEARCH:
${JSON.stringify(research, null, 2)}

OBECNY NIEPEŁNY WYNIK:
${JSON.stringify(initial, null, 2)}

Wymagania:
- top-level keys: "linkedin" i "instagram";
- dokładnie ${liCount} elementów w "linkedin";
- dokładnie ${igCount} elementów w "instagram";
- tematy po polsku;
- hashtagi jako osobne elementy tablicy;
- jeśli brak źródła, nie dodawaj liczb ani nowych faktów.

Zwróć tylko JSON.`;

  try {
    const regenerated = sanitizeCopyPlResult(await generateJsonWithRepair({
      agent: weeklyContentCopyRepairAgent,
      taskId,
      stepId: 'generate-pl-count-topup',
      userPrompt: topUpPrompt,
      systemPrompt,
      schema: copyPlResultSchema,
      modelSettings: { temperature: 0.35, maxOutputTokens: 8192 },
      normalizeBeforeRepair: (parsed) => normalizeCopyPlOutput(parsed, liCount, igCount),
    }));
    const merged = sanitizeCopyPlResult({
      linkedin: mergeUniqueBy(initial.linkedin, regenerated.linkedin, liCount, (post) => `${post.account}:${post.topic}`),
      instagram: mergeUniqueBy(initial.instagram, regenerated.instagram, igCount, (post) => `${post.type}:${post.topic}`),
    });
    if (merged.linkedin.length === liCount && merged.instagram.length === igCount) return merged;
    console.warn(`[weekly-content:${taskId}] generate-pl count top-up incomplete LI:${merged.linkedin.length}/IG:${merged.instagram.length}, using deterministic fallback for missing slots`);
    return fillMissingCopyDeterministically(merged, research, liCount, igCount);
  } catch (err) {
    console.warn(`[weekly-content:${taskId}] generate-pl count top-up failed:`, (err as Error).message);
    return fillMissingCopyDeterministically(initial, research, liCount, igCount);
  }
}

async function generateJsonWithRepair<T extends {}>({
  agent,
  repairAgent = weeklyContentJsonRepairAgent,
  taskId,
  stepId,
  userPrompt,
  systemPrompt,
  schema,
  modelSettings,
  normalizeBeforeRepair,
}: {
  agent: Agent;
  repairAgent?: Agent;
  taskId: string;
  stepId: string;
  userPrompt: string;
  systemPrompt: string;
  schema: z.ZodType<T, T>;
  modelSettings?: { temperature?: number; maxOutputTokens?: number };
  normalizeBeforeRepair?: (parsed: unknown) => T | null;
}): Promise<T> {
  const res = await agent.generate(userPrompt, {
    system: systemPrompt,
    modelSettings,
    toolChoice: 'none',
    maxSteps: 1,
  });
  const parsed = tryParseJson<T>(res.text) ?? tryParseLooseJson<T>(res.text);
  const validated = schema.safeParse(parsed);
  if (validated.success) return validated.data;
  const normalized = normalizeBeforeRepair?.(parsed);
  if (normalized) {
    const normalizedValidated = schema.safeParse(normalized);
    if (normalizedValidated.success) {
      console.warn(`[weekly-content:${taskId}] ${stepId} normalized legacy JSON shape before repair`);
      return normalizedValidated.data;
    }
    console.warn(`[weekly-content:${taskId}] ${stepId} legacy JSON normalization failed schema, attempting structured repair`);
  }

  console.warn(`[weekly-content:${taskId}] ${stepId} invalid JSON, attempting structured repair`);
  const repairPrompt = `Napraw poniższą odpowiedź modelu do poprawnego obiektu JSON zgodnego ze schematem kroku "${stepId}".
Zwróć tylko dane, bez komentarza i bez markdown.

ORYGINALNA ODPOWIEDŹ:
${res.text}`;

  const repaired = await repairAgent.generate<T>(repairPrompt, {
    system: 'Jesteś deterministycznym parserem JSON. Zachowaj sens danych wejściowych, usuń tekst poza JSON i nie dopowiadaj faktów.',
    structuredOutput: {
      schema,
      jsonPromptInjection: true,
      instructions: 'Return only the validated structured object required by the schema.',
    },
    modelSettings: { temperature: 0 },
    toolChoice: 'none',
    maxSteps: 1,
  });

  if (!repaired.object) {
    throw new Error(`[weekly-content:${taskId}] ${stepId} structured repair returned no object`);
  }
  return repaired.object;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveWeekStarting(date?: string): string {
  if (!date) {
    return format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
  }
  const parsed = parseISO(date);
  if (!isValid(parsed)) return format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(parsed, 'yyyy-MM-dd');
}

function getPublishingDate(weekStarting: string, suggestedDay: string, suggestedTime: string): Date {
  const dayOffsets: Record<string, number> = {
    monday: 0, poniedzialek: 0, tuesday: 1, wtorek: 1, wednesday: 2, sroda: 2,
    thursday: 3, czwartek: 3, friday: 4, piatek: 4, saturday: 5, sobota: 5, sunday: 6, niedziela: 6
  };
  const normalizedDay = suggestedDay.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\|.*$/, '').trim();
  const date = addDays(parseISO(`${weekStarting}T00:00:00`), dayOffsets[normalizedDay] ?? 0);
  const timeMatch = (suggestedTime ?? '10:00').match(/^(\d{1,2}):(\d{2})/);
  date.setHours(Math.min(Number(timeMatch?.[1] ?? 10), 23), Math.min(Number(timeMatch?.[2] ?? 0), 59), 0, 0);
  return date;
}

// ── Step 01: research-week ──────────────────────────────────────────────────
const researchWeekStep = createStep({
  id: 'research-week',
  description: 'Zbiera newsy i ruchy konkurencji z NotebookLM.',
  inputSchema: z.object({
    weekDate: z.string().optional(),
    liCount: z.number().default(5),
    igCount: z.number().default(3),
    linkedinCount: z.number().optional(),
    instagramCount: z.number().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    liCount: z.number(),
    igCount: z.number(),
    research: z.object({
      newsHooks: z.array(newsHookSchema),
      competitorMoves: z.array(competitorMoveSchema),
      sourceCitations: z.array(z.string()).optional(),
      recentContentTopics: z.array(contentHistoryItemSchema).optional(),
      researchDiagnostics: z.array(z.string()).optional(),
      freshSignals: z.array(freshContentSignalSchema).optional(),
      researchQuality: researchQualitySchema.optional(),
      selectedSignalIds: z.array(z.string()).optional(),
    }),
  }),
  execute: async (context) => {
    const taskId = `weekly-content-${randomUUID().slice(0, 8)}`;
    const weekDate = resolveWeekStarting(context.inputData.weekDate);
    const initData = context.getInitData<{
      liCount?: number;
      igCount?: number;
      linkedinCount?: number;
      instagramCount?: number;
    }>();
    const liCount = normalizeCount(initData.linkedinCount ?? initData.liCount ?? context.inputData.liCount, 5);
    const igCount = normalizeCount(initData.instagramCount ?? initData.igCount ?? context.inputData.igCount, 3);
    console.log(`[weekly-content:${taskId}] research-week date=${weekDate}`);

    const recentContentTopics = await loadRecentContentHistory();
    const freshSignalResult = await loadFreshSignalsForWeek(taskId, weekDate);
    const freshSignals = freshSignalResult.signals;
    let notebookResults = await queryCoreNotebooks(taskId, weekDate);
    const freshnessNotes = await refreshWeakNotebookSources(taskId, weekDate, notebookResults);
    if (freshnessNotes.some((note) => !note.includes(':failed:'))) {
      notebookResults = await queryCoreNotebooks(taskId, weekDate);
    }
    const sourceCitations = collectCitations(notebookResults);
    const researchDiagnostics = [
      ...freshSignalResult.diagnostics,
      ...collectResearchDiagnostics(notebookResults, freshnessNotes),
    ];

    // Wczytanie profesjonalnego promptu (jak w Jarvis)
    const systemPrompt = await loadPrompt('marketing/research');

    const userPrompt = `
DANE Z NOTEBOOKLM DO ANALIZY:

# FreshSignals z rss_intelligence - użyj jako głównego źródła aktualnych tematów
${formatFreshSignalSection(freshSignals)}

# PL-Market-Intelligence (Rynek)
${formatNotebookSection('Rynek', notebookResults.rynek)}

# RHD / regulacje / producenci
${formatNotebookSection('RHD', notebookResults.rhd)}

# Competitor-Tracking (Konkurencja)
${formatNotebookSection('Konkurencja', notebookResults.konkurencja)}

# Founder Voice (Patryk)
${formatNotebookSection('Founder', notebookResults.founder)}

# Historia ostatniego contentu - unikaj powtarzania tematów i angle
${formatContentHistory(recentContentTopics)}

# Diagnostyka świeżości źródeł
${researchDiagnostics.join('\n') || 'Nie uruchamiano knowledge.research_start, bo query_multi zwróciło wystarczający sygnał.'}

Tydzień: ${weekDate}

Wybierz 3 najlepsze news hooks i ruchy konkurencji. Preferuj FreshSignals z URL-em jako źródłem. Jeśli brakuje danych źródłowych, nie zgaduj liczb ani newsów: użyj ostrożnego evergreen angle i ustaw puste "data". Zwróć JSON.

Ważne: użyj dokładnie pól "newsHooks", "competitorMoves", "sourceCitations", "source", "bestFor" i "ourAngle". Nie używaj snake_case: "news_hooks", "competitor_moves", "best_for", "our_angle". Nie zwracaj pól "angle" ani "impact" zamiast wymaganych pól.`;

    const generatedResearch = sanitizeResearchResult(await generateJsonWithRepair({
      agent: weeklyContentResearchAgent,
      taskId,
      stepId: 'research-week',
      userPrompt,
      systemPrompt,
      schema: researchResultSchema,
      modelSettings: { temperature: 0.5 },
      normalizeBeforeRepair: normalizeResearchOutput,
    }), [...sourceCitations, ...collectFreshSignalCitations(freshSignals)]);
    const research = mergeFreshSignalHooksIntoResearch(generatedResearch, freshSignals);
    if (research.newsHooks.length === 0) {
      research.newsHooks.push({
        topic: 'research-fallback',
        hook: 'Brak wystarczających danych źródłowych z NotebookLM. Przygotuj ostrożny angle edukacyjny bez nowych liczb.',
        data: '',
        source: 'LLM fallback',
        bestFor: 'linkedin-company',
      });
    }
    const researchQuality = evaluateResearchQuality(weekDate, research, freshSignals, researchDiagnostics);
    const selectedSignalIds = freshSignals.map((signal) => signal.id);
    await saveResearchRun({
      taskId,
      weekDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      selectedSignalIds,
      rejectedSignalIds: [],
      sourceCoverage: getSourceCoverage(freshSignals),
      diagnostics: researchDiagnostics,
      quality: researchQuality,
      status: researchQuality.passed ? 'research_ready' : 'needs_research',
    });
    if (!researchQuality.passed && isStrictResearchGateEnabled()) {
      throw new Error(`[weekly-content:${taskId}] rich research gate failed: ${researchQuality.reasons.join(', ')}`);
    }
    return {
      taskId,
      weekDate,
      liCount,
      igCount,
      research: {
        newsHooks: research.newsHooks,
        competitorMoves: research.competitorMoves,
        sourceCitations: research.sourceCitations,
        recentContentTopics,
        researchDiagnostics,
        freshSignals,
        researchQuality,
        selectedSignalIds,
      },
    };
  },
});

// ── Step 02: generate-pl ────────────────────────────────────────────────────
const generatePlStep = createStep({
  id: 'generate-pl',
  description: 'Generuje posty LinkedIn i Instagram w języku polskim.',
  inputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    research: z.any(),
    liCount: z.number().default(5),
    igCount: z.number().default(3),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    research: z.any().optional(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
  }),
  execute: async (context) => {
    const { taskId, weekDate, research, liCount, igCount } = context.inputData;
    console.log(`[weekly-content:${taskId}] generate-pl (LI:${liCount}, IG:${igCount})`);

    // Wczytanie profesjonalnego promptu copy (PL)
    const systemPrompt = await loadPrompt('marketing/copy-pl');

    const userPrompt = `Wygeneruj ${liCount} postów LinkedIn i ${igCount} treści Instagram dla GastroBridge.
Tydzień: ${weekDate}
RESEARCH DATA (użyj tych faktów i liczb):
${JSON.stringify(research, null, 2)}

Ważne:
- LinkedIn ma być mixem konta osobistego Patryka i konta firmowego GastroBridge.
- Instagram ma rotować formaty: post, karuzela, story lub reel.
- Rotuj angle: data insight, story from kitchen, building in public, customer spotlight.
- LinkedIn osobiste preferuj wtorek/czwartek 10:00.
- LinkedIn firmowe preferuj poniedziałek/środa/piątek 10:00.
- Instagram feed preferuj 12:00-13:00 albo 18:00-20:00.
- Każdy post MUSI mieć unikalny temat.
- Nie powtarzaj tematów ani angle z research.recentContentTopics.
- Zwróć dokładnie ${liCount} elementów w "linkedin" i dokładnie ${igCount} elementów w "instagram".
- Zwróć dokładnie top-level keys: "linkedin" i "instagram". Nie używaj "linkedin_personal", "linkedin_company", "content", "tags" ani "schedule".
- Tematy "topic" zwracaj po polsku. Hashtagi zwracaj jako osobne elementy tablicy, nie jako jeden string z wieloma tagami.

Zwróć JSON zgodnie ze strukturą opisaną w system prompcie.`;

    const counted = await completeCopyCounts({
      taskId,
      weekDate,
      research,
      current: sanitizeCopyPlResult(await generateJsonWithRepair({
        agent: weeklyContentCopyAgent,
        taskId,
        stepId: 'generate-pl',
        userPrompt,
        systemPrompt,
        schema: copyPlResultSchema,
        modelSettings: { temperature: 0.4, maxOutputTokens: 8192 },
        normalizeBeforeRepair: (parsed) => normalizeCopyPlOutput(parsed, liCount, igCount),
      })),
      liCount,
      igCount,
      systemPrompt,
    });
    const parsed = await ensureLinkedInLengthQuality({
      taskId,
      weekDate,
      research,
      current: counted,
      liCount,
      igCount,
      systemPrompt,
    });
    assertCopyCounts(parsed, liCount, igCount, taskId);
    if (parsed.linkedin.length === 0 && parsed.instagram.length === 0) {
      throw new Error(`[weekly-content:${taskId}] generate-pl returned zero drafts after JSON repair`);
    }
    return { taskId, weekDate, research, liPosts: parsed.linkedin, igPosts: parsed.instagram };
  },
});

// ── Step 03: translate-en ───────────────────────────────────────────────────
const translateEnStep = createStep({
  id: 'translate-en',
  description: 'Tłumaczy wybrane posty LinkedIn na język angielski.',
  inputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    research: z.any().optional(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    research: z.any().optional(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
    enPosts: z.array(enPostSchema),
  }),
  execute: async (context) => {
    const { taskId, weekDate, liPosts } = context.inputData;
    const topPosts = liPosts.slice(0, 2);
    if (topPosts.length === 0) return { ...context.inputData, enPosts: [] };

    // Wczytanie profesjonalnego promptu adaptacji (EN)
    const systemPrompt = await loadPrompt('marketing/copy-en');

    const userPrompt = `Translate and adapt these Polish LinkedIn posts to English:
${topPosts.map((p, i) => `### Post ${i + 1}: ${p.topic}\n${p.post}\nHashtags: ${p.hashtags.join(' ')}`).join('\n\n---\n\n')}

Zwróć JSON zgodnie ze strukturą opisaną w system prompcie.`;

    const parsed = await generateJsonWithRepair({
      agent: weeklyContentTranslationAgent,
      taskId,
      stepId: 'translate-en',
      userPrompt,
      systemPrompt,
      schema: copyEnResultSchema,
      modelSettings: { temperature: 0.5 },
    });
    return { taskId, weekDate, research: context.inputData.research, liPosts, igPosts: context.inputData.igPosts, enPosts: parsed.translations };
  },
});

// ── Step 04: save-drafts ────────────────────────────────────────────────────
const saveDraftsStep = createStep({
  id: 'save-drafts',
  description: 'Zapisuje wszystkie drafty do Filesystemu i Gmaila.',
  inputSchema: z.object({
    taskId: z.string(),
    weekDate: z.string(),
    research: z.any().optional(),
    liPosts: z.array(liPostSchema),
    igPosts: z.array(igPostSchema),
    enPosts: z.array(enPostSchema),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    draftCount: z.number(),
    calendarReminders: z.array(z.object({ title: z.string(), date: z.string() })),
  }),
  execute: async (context) => {
    const { taskId, weekDate, research, liPosts, igPosts, enPosts } = context.inputData;
    const store = getDraftsStore();
    await store.ensureBaseDir();
    let count = 0;
    const reminders: Array<{ title: string; date: string }> = [];

    // LI PL
    for (const p of liPosts) {
      const draftId = `li-pl-${randomUUID().slice(0, 6)}`;
      const date = getPublishingDate(weekDate, p.suggestedDay, p.suggestedTime);
      await store.save({
        taskId, draftId,
        content: `# ${p.topic}\n\n${p.post}\n\n---\n${p.hashtags.join(' ')}`,
        metadata: { draftId, taskId, type: 'linkedin-post', language: 'pl', topic: p.topic, hashtags: p.hashtags, charCount: p.char_count, rationale: p.rationale, imagePrompt: p.imagePrompt, scheduledFor: date.toISOString(), weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
      });
      reminders.push({ title: `LinkedIn: ${p.topic}`, date: date.toISOString() });
      count++;
    }

    // IG PL
    for (const p of igPosts) {
      const draftId = `ig-pl-${randomUUID().slice(0, 6)}`;
      const date = getPublishingDate(weekDate, p.suggestedDay, p.suggestedTime);
      await store.save({
        taskId, draftId,
        content: `# ${p.topic} (${p.type})\n\n${p.caption}\n\n---\n${p.hashtags.join(' ')}`,
        metadata: { draftId, taskId, type: 'instagram-caption', language: 'pl', topic: p.topic, hashtags: p.hashtags, charCount: p.char_count, rationale: p.rationale, imagePrompt: p.imagePrompt, scheduledFor: date.toISOString(), weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
      });
      reminders.push({ title: `Instagram: ${p.topic}`, date: date.toISOString() });
      count++;
    }

    // EN LI
    for (const p of enPosts) {
      const draftId = `li-en-${randomUUID().slice(0, 6)}`;
      await store.save({
        taskId, draftId,
        content: `# ${p.originalTopic} (EN)\n\n${p.post}\n\n---\n${p.hashtags.join(' ')}`,
        metadata: { draftId, taskId, type: 'linkedin-post', language: 'en', topic: p.originalTopic, hashtags: p.hashtags, charCount: p.char_count, rationale: p.adaptationNotes, weekStarting: weekDate, createdAt: new Date().toISOString(), agentId: 'marketing-agent', llm: { provider: 'mastra', model: 'gemma', costUsd: 0 } }
      });
      count++;
    }

    const selectedSignalIds = Array.isArray(research?.selectedSignalIds)
      ? research.selectedSignalIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    if (selectedSignalIds.length > 0) {
      await markFreshContentSignalsUsed(taskId, selectedSignalIds);
    }
    await updateResearchRunStatus(taskId, 'drafts_saved');

    return { taskId, draftCount: count, calendarReminders: reminders };
  },
});

// ── Step 05: create-reminders ───────────────────────────────────────────────
const createRemindersStep = createStep({
  id: 'create-reminders',
  description: 'Tworzy wydarzenia w Google Calendar.',
  inputSchema: z.object({
    taskId: z.string(),
    calendarReminders: z.array(z.object({ title: z.string(), date: z.string() })),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    remindersCount: z.number(),
  }),
  execute: async (context) => {
    const { taskId, calendarReminders } = context.inputData;
    let count = 0;
    for (const r of calendarReminders) {
      try {
        const calendar = await CalendarService.create();
        await calendar.createEvent({
          title: `[PUBLIKACJA] ${r.title}`,
          description: `Przypomnienie o publikacji posta dla tygodnia ${r.date}. TaskId: ${taskId}`,
          start: new Date(r.date),
        });
        count++;
      } catch (err) {
        console.warn(`[weekly-content:${taskId}] calendar fail:`, (err as Error).message);
      }
    }
    return { taskId, remindersCount: count };
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────
export const weeklyContentWorkflow = createWorkflow({
  id: 'weekly-content',
  description: 'Generuje cotygodniowy content (LI, IG) w PL i EN + Calendar reminders.',
  inputSchema: z.object({
    weekDate: z.string().optional().describe('Data poniedziałku (YYYY-MM-DD). Domyślnie obecny tydzień.'),
    liCount: z.number().default(5).describe('Liczba postów LinkedIn'),
    igCount: z.number().default(3).describe('Liczba postów Instagram'),
    linkedinCount: z.number().optional().describe('Legacy alias liczby postów LinkedIn'),
    instagramCount: z.number().optional().describe('Legacy alias liczby postów Instagram'),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    draftCount: z.number(),
    remindersCount: z.number(),
  })
})
  .then(researchWeekStep)
  .then(generatePlStep)
  .then(translateEnStep)
  .then(saveDraftsStep)
  .then(createRemindersStep);

weeklyContentWorkflow.commit();
