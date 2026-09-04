import type { Db } from 'mongodb';
import { getRssDb } from './mongo.js';

export type FreshSignalHook = {
  hook: string;
  bestFor: 'linkedin-personal' | 'linkedin-company' | 'instagram';
  angle: string;
};

export type FreshContentSignal = {
  id: string;
  guid: string;
  title: string;
  source: string;
  sourceName: string;
  url: string;
  publishedAt: string;
  summary: string;
  whyItMatters: string;
  language: string;
  country: string;
  category: string;
  tags: string[];
  bestAngles: string[];
  hooks: FreshSignalHook[];
  score: number;
  confidence: number;
  novelty: number;
};

export type ResearchRunQuality = {
  passed: boolean;
  score: number;
  reasons: string[];
};

export type ResearchRunRecord = {
  taskId: string;
  weekDate: string;
  createdAt: string;
  updatedAt: string;
  selectedSignalIds: string[];
  rejectedSignalIds: string[];
  sourceCoverage: Record<string, number>;
  diagnostics: string[];
  quality: ResearchRunQuality;
  status: 'needs_research' | 'research_ready' | 'drafts_saved';
};

type SearchFreshSignalsOptions = {
  weekDate: string;
  language?: string;
  limit?: number;
  minRelevance?: number;
  excludeUsed?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
let indexesEnsured = false;

function toIsoDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return value.trim();
  }
  return new Date().toISOString();
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeScore(value: unknown, fallback = 0): number {
  const parsed = toNumber(value, fallback);
  if (parsed > 1) return Math.max(0, Math.min(parsed / 10, 1));
  return Math.max(0, Math.min(parsed, 1));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeBestFor(value: unknown): FreshSignalHook['bestFor'] {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw.includes('instagram')) return 'instagram';
  if (raw.includes('personal') || raw.includes('patryk') || raw.includes('founder')) return 'linkedin-personal';
  return 'linkedin-company';
}

function normalizeHooks(value: unknown, title: string, summary: string): FreshSignalHook[] {
  if (Array.isArray(value)) {
    const hooks = value
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const raw = item as Record<string, unknown>;
        const hook = typeof raw.hook === 'string' && raw.hook.trim()
          ? raw.hook.trim()
          : '';
        if (!hook) return null;
        return {
          hook,
          bestFor: normalizeBestFor(raw.bestFor ?? raw.best_for),
          angle: typeof raw.angle === 'string' && raw.angle.trim() ? raw.angle.trim() : hook,
        };
      })
      .filter((item): item is FreshSignalHook => Boolean(item));
    if (hooks.length > 0) return hooks.slice(0, 4);
  }

  const fallbackHook = summary
    ? `${title}: ${summary}`.slice(0, 420)
    : title;
  return [{ hook: fallbackHook, bestFor: 'linkedin-company', angle: title }];
}

function signalFromContentSignal(doc: Record<string, any>): FreshContentSignal | null {
  const url = typeof doc.canonicalUrl === 'string' && doc.canonicalUrl.trim()
    ? doc.canonicalUrl.trim()
    : typeof doc.url === 'string' ? doc.url.trim() : '';
  const title = typeof doc.title === 'string' ? doc.title.trim() : '';
  if (!url || !title) return null;

  const scores = doc.scores && typeof doc.scores === 'object' ? doc.scores as Record<string, unknown> : {};
  const summary = typeof doc.summary === 'string' ? doc.summary.trim() : '';
  return {
    id: typeof doc.signalId === 'string' ? doc.signalId : `sig_${doc.guid ?? url}`,
    guid: typeof doc.guid === 'string' ? doc.guid : '',
    title,
    source: typeof doc.source === 'string' ? doc.source : '',
    sourceName: typeof doc.sourceName === 'string' ? doc.sourceName : typeof doc.source === 'string' ? doc.source : 'unknown-source',
    url,
    publishedAt: toIsoDate(doc.publishedAt),
    summary,
    whyItMatters: typeof doc.whyItMatters === 'string' ? doc.whyItMatters.trim() : '',
    language: typeof doc.language === 'string' ? doc.language : 'pl',
    country: typeof doc.country === 'string' ? doc.country : 'PL',
    category: typeof doc.category === 'string' ? doc.category : 'unknown',
    tags: asStringArray(doc.tags),
    bestAngles: asStringArray(doc.contentAngles),
    hooks: normalizeHooks(doc.hooks, title, summary),
    score: normalizeScore(scores.relevance),
    confidence: normalizeScore(scores.confidence),
    novelty: normalizeScore(scores.novelty),
  };
}

function signalFromArticle(doc: Record<string, any>): FreshContentSignal | null {
  const url = typeof doc.canonicalUrl === 'string' && doc.canonicalUrl.trim()
    ? doc.canonicalUrl.trim()
    : typeof doc.link === 'string' ? doc.link.trim() : '';
  const title = typeof doc.title === 'string' ? doc.title.trim() : '';
  if (!url || !title) return null;

  const summary = typeof doc.summary_ai === 'string' && doc.summary_ai.trim()
    ? doc.summary_ai.trim()
    : typeof doc.description === 'string' ? doc.description.trim() : '';
  const whyItMatters = typeof doc.why_it_matters === 'string'
    ? doc.why_it_matters.trim()
    : typeof doc.linkedin_angle === 'string' ? doc.linkedin_angle.trim() : '';

  return {
    id: `article_${doc.guid ?? url}`,
    guid: typeof doc.guid === 'string' ? doc.guid : '',
    title,
    source: typeof doc.source === 'string' ? doc.source : '',
    sourceName: typeof doc.sourceName === 'string' ? doc.sourceName : typeof doc.source === 'string' ? doc.source : 'unknown-source',
    url,
    publishedAt: toIsoDate(doc.publishedAt ?? doc.pubDate),
    summary,
    whyItMatters,
    language: typeof doc.language === 'string' ? doc.language : 'pl',
    country: typeof doc.country === 'string' ? doc.country : 'PL',
    category: typeof doc.category === 'string' ? doc.category : 'unknown',
    tags: asStringArray(doc.tags_ai ?? doc.tags),
    bestAngles: asStringArray(doc.linkedin_angles),
    hooks: normalizeHooks(doc.suggested_hooks, title, summary || whyItMatters),
    score: normalizeScore(doc.relevance_score),
    confidence: normalizeScore(doc.confidence_score, 0.6),
    novelty: normalizeScore(doc.novelty_score, 0.5),
  };
}

async function ensureRssIndexes(db: Db): Promise<void> {
  if (indexesEnsured) return;
  await Promise.all([
    db.collection('rss_articles').createIndex({ guid: 1 }, { unique: true }),
    db.collection('rss_articles').createIndex({ canonicalUrl: 1 }),
    db.collection('rss_articles').createIndex({ processed: 1, sourcePriority: -1, publishedAt: -1 }),
    db.collection('rss_articles').createIndex({ source: 1, publishedAt: -1 }),
    db.collection('content_signals').createIndex({ signalId: 1 }, { unique: true }),
    db.collection('content_signals').createIndex({ 'scores.relevance': -1, publishedAt: -1 }),
    db.collection('content_signals').createIndex({ language: 1, country: 1, publishedAt: -1 }),
    db.collection('content_signals').createIndex({ usedInTasks: 1 }),
    db.collection('content_signals').createIndex({ source: 1, publishedAt: -1 }),
    db.collection('research_runs').createIndex({ taskId: 1 }, { unique: true }),
    db.collection('research_runs').createIndex({ weekDate: -1 }),
  ]);
  indexesEnsured = true;
}

function buildFreshDateFilter(weekDate: string): Record<string, any> {
  const parsed = new Date(`${weekDate}T00:00:00.000Z`);
  const anchor = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const since = new Date(anchor.getTime() - 14 * DAY_MS);
  const until = new Date(anchor.getTime() + 8 * DAY_MS);
  return {
    $or: [
      { publishedAt: { $gte: since.toISOString(), $lte: until.toISOString() } },
      { publishedAt: { $gte: since, $lte: until } },
    ],
  };
}

function buildFreshArticleDateFilter(weekDate: string): Record<string, any> {
  const parsed = new Date(`${weekDate}T00:00:00.000Z`);
  const anchor = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const since = new Date(anchor.getTime() - 14 * DAY_MS);
  const until = new Date(anchor.getTime() + 8 * DAY_MS);
  return {
    $or: [
      { publishedAt: { $gte: since.toISOString(), $lte: until.toISOString() } },
      { publishedAt: { $gte: since, $lte: until } },
      { pubDate: { $gte: since.toISOString(), $lte: until.toISOString() } },
      { pubDate: { $gte: since, $lte: until } },
    ],
  };
}

function isSignalInWeekWindow(signal: FreshContentSignal, weekDate: string): boolean {
  const parsed = new Date(`${weekDate}T00:00:00.000Z`);
  const anchor = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const since = new Date(anchor.getTime() - 14 * DAY_MS);
  const until = new Date(anchor.getTime() + 8 * DAY_MS);
  const signalDate = new Date(signal.publishedAt);
  if (Number.isNaN(signalDate.getTime())) return false;
  return signalDate >= since && signalDate <= until;
}

function buildUnusedFilter(excludeUsed: boolean): Record<string, any> {
  if (!excludeUsed) return {};
  return {
    $or: [
      { usedInTasks: { $exists: false } },
      { usedInTasks: { $size: 0 } },
    ],
  };
}

export async function searchFreshContentSignals(options: SearchFreshSignalsOptions): Promise<FreshContentSignal[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
  const minRelevance = options.minRelevance ?? 0.6;
  const db = await getRssDb();
  await ensureRssIndexes(db);

  const dateFilter = buildFreshDateFilter(options.weekDate);
  const languageFilter = options.language ? { language: options.language } : {};
  const unusedFilter = buildUnusedFilter(options.excludeUsed ?? true);

  const signalDocs = await db.collection('content_signals')
    .find({
      ...dateFilter,
      ...languageFilter,
      ...unusedFilter,
      'scores.relevance': { $gte: minRelevance },
    })
    .sort({ 'scores.relevance': -1, publishedAt: -1 })
    .limit(limit * 3)
    .toArray();

  const signals = signalDocs
    .map((doc) => signalFromContentSignal(doc as Record<string, any>))
    .filter((item): item is FreshContentSignal => Boolean(item));

  if (signals.length >= limit) return signals.slice(0, limit);

  const seenUrls = new Set(signals.map((signal) => signal.url));
  const articleDocs = await db.collection('rss_articles')
    .find({
      processed: true,
      relevance_score: { $gte: minRelevance * 10 },
    })
    .sort({ relevance_score: -1, sourcePriority: -1, publishedAt: -1, pubDate: -1 })
    .limit(300)
    .toArray();

  const fallbackSignals = articleDocs
    .map((doc) => signalFromArticle(doc as Record<string, any>))
    .filter((item): item is FreshContentSignal => Boolean(item))
    .filter((signal) => isSignalInWeekWindow(signal, options.weekDate))
    .filter((signal) => {
      if (seenUrls.has(signal.url)) return false;
      seenUrls.add(signal.url);
      return true;
    });

  return [...signals, ...fallbackSignals].slice(0, limit);
}

export async function markFreshContentSignalsUsed(taskId: string, signalIds: string[]): Promise<void> {
  const ids = Array.from(new Set(signalIds.filter(Boolean)));
  if (ids.length === 0) return;
  const db = await getRssDb();
  await db.collection('content_signals').updateMany(
    { signalId: { $in: ids } },
    {
      $addToSet: { usedInTasks: taskId },
      $set: { updatedAt: new Date().toISOString() },
    },
  );
}

export async function saveResearchRun(record: ResearchRunRecord): Promise<void> {
  const db = await getRssDb();
  await ensureRssIndexes(db);
  const { createdAt, ...updateFields } = record;
  await db.collection('research_runs').updateOne(
    { taskId: record.taskId },
    { $set: { ...updateFields, updatedAt: new Date().toISOString() }, $setOnInsert: { createdAt } },
    { upsert: true },
  );
}

export async function updateResearchRunStatus(taskId: string, status: ResearchRunRecord['status']): Promise<void> {
  const db = await getRssDb();
  await db.collection('research_runs').updateOne(
    { taskId },
    { $set: { status, updatedAt: new Date().toISOString() } },
  );
}
