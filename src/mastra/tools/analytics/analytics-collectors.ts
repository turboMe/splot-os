/**
 * Deterministic, read-only analytics collectors shared by the V2 analytics tools.
 *
 * The legacy workflows mixed three concerns inside model-facing steps: reading
 * Mongo, deciding whether a metric was actually observable, and presenting it.
 * This module keeps the first two deterministic. The model only receives a
 * bounded snapshot with explicit windows, provenance and unavailable values.
 */
import { getDb, getRssDb } from '../../lib/mongo.js';
import { getOverview, type OverviewStats } from '../../services/dashboard-stats.js';

export type MetricAvailability = 'available' | 'unavailable';
export type MetricUnit = 'count' | 'percent' | 'usd' | 'pln' | 'milliseconds';

export interface AnalyticsWindow {
  from: string;
  to: string;
  days: number;
}

export interface AnalyticsWindows {
  current: AnalyticsWindow;
  previous: AnalyticsWindow;
}

export interface MetricDenominator {
  label: string;
  status: MetricAvailability;
  value: number | null;
}

export interface MetricObservation {
  status: MetricAvailability;
  value: number | null;
  unit: MetricUnit;
  source: string;
  sampleSize: number | null;
  denominator: MetricDenominator | null;
  reason: string | null;
}

export interface MetricComparison {
  metric: string;
  unit: MetricUnit;
  current: MetricObservation;
  previous: MetricObservation;
  absoluteDelta: number | null;
  percentDelta: number | null;
  percentDeltaReason: string | null;
}

export interface BreakdownComparison {
  status: MetricAvailability;
  current: Record<string, number>;
  previous: Record<string, number>;
  source: string;
  reason: string | null;
}

export interface DataProvenance {
  database: string;
  collection: string;
  fields: string[];
  windowField: string | null;
  note: string;
}

export interface AnalyticsLeadDocument {
  createdAt?: unknown;
  updatedAt?: unknown;
  status?: unknown;
  region?: unknown;
  segment?: unknown;
  history?: Array<{
    timestamp?: unknown;
    ts?: unknown;
    action?: unknown;
    status?: unknown;
    toStatus?: unknown;
    description?: unknown;
  }>;
}

export interface AnalyticsSignalDocument {
  createdAt?: unknown;
  type?: unknown;
}

export interface AnalyticsWorkflowRunDocument {
  startedAt?: unknown;
  status?: unknown;
  workflowId?: unknown;
}

export interface AnalyticsRssArticle {
  title?: unknown;
  description?: unknown;
  pubDate?: unknown;
  publishedAt?: unknown;
  _analyticsDate?: unknown;
}

export interface CrmTrendMetrics {
  newLeads: MetricComparison;
  interactions: MetricComparison;
  emailsSent: MetricComparison;
  responses: MetricComparison;
  meetings: MetricComparison;
  partnerConversions: MetricComparison;
  byRegion: BreakdownComparison;
  bySegment: BreakdownComparison;
  byStatus: BreakdownComparison;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const EMAIL_SENT_ACTION = 'email_sent';
const RESPONSE_ACTION = 'email_received';
const MEETING_ACTION = 'meeting_scheduled';
const PARTNER_STATUSES = new Set(['aktywny_partner', 'active_partner']);

const RSS_KEYWORDS = [
  'HoReCa', 'dostawca', 'restauracja', 'żywność', 'gastronomia',
  'producent', 'farm', 'lokalny', 'ekologiczny', 'import',
  'ceny', 'inflacja', 'trend', 'rynek', 'technologia',
] as const;

function round(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateWindow(window: AnalyticsWindow): { from: Date; to: Date } {
  return { from: new Date(window.from), to: new Date(window.to) };
}

function inWindow(value: unknown, window: AnalyticsWindow): boolean {
  const date = parseDate(value);
  if (!date) return false;
  const { from, to } = dateWindow(window);
  return date >= from && date < to;
}

function availableMetric(
  value: number,
  unit: MetricUnit,
  source: string,
  sampleSize: number | null,
  denominator: MetricDenominator | null = null,
): MetricObservation {
  return {
    status: 'available',
    value: round(value, unit === 'usd' ? 6 : 2),
    unit,
    source,
    sampleSize,
    denominator,
    reason: null,
  };
}

function unavailableMetric(
  unit: MetricUnit,
  source: string,
  reason: string,
  sampleSize: number | null = null,
  denominator: MetricDenominator | null = null,
): MetricObservation {
  return {
    status: 'unavailable',
    value: null,
    unit,
    source,
    sampleSize,
    denominator,
    reason,
  };
}

export function compareMetric(
  metric: string,
  current: MetricObservation,
  previous: MetricObservation,
): MetricComparison {
  if (
    current.status === 'unavailable'
    || previous.status === 'unavailable'
    || current.value === null
    || previous.value === null
  ) {
    return {
      metric,
      unit: current.unit,
      current,
      previous,
      absoluteDelta: null,
      percentDelta: null,
      percentDeltaReason: 'one_or_both_periods_unavailable',
    };
  }

  const absoluteDelta = round(current.value - previous.value);
  if (previous.value === 0) {
    return {
      metric,
      unit: current.unit,
      current,
      previous,
      absoluteDelta,
      percentDelta: null,
      percentDeltaReason: 'previous_value_is_zero',
    };
  }

  return {
    metric,
    unit: current.unit,
    current,
    previous,
    absoluteDelta,
    percentDelta: round((absoluteDelta / previous.value) * 100),
    percentDeltaReason: null,
  };
}

/** Two adjacent windows. `previous.to === current.from` is an invariant. */
export function buildEqualComparisonWindows(periodDays: number, asOf: Date = new Date()): AnalyticsWindows {
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 365) {
    throw new Error('periodDays must be an integer between 1 and 365');
  }
  if (Number.isNaN(asOf.getTime())) throw new Error('asOf must be a valid ISO date');

  const currentTo = new Date(asOf);
  const currentFrom = new Date(currentTo.getTime() - periodDays * DAY_MS);
  const previousTo = new Date(currentFrom);
  const previousFrom = new Date(previousTo.getTime() - periodDays * DAY_MS);

  return {
    current: { from: currentFrom.toISOString(), to: currentTo.toISOString(), days: periodDays },
    previous: { from: previousFrom.toISOString(), to: previousTo.toISOString(), days: periodDays },
  };
}

function leadDate(lead: AnalyticsLeadDocument): Date | null {
  return parseDate(lead.createdAt);
}

function leadsInWindow(leads: AnalyticsLeadDocument[], window: AnalyticsWindow): AnalyticsLeadDocument[] {
  return leads.filter((lead) => {
    const date = leadDate(lead);
    return date ? inWindow(date, window) : false;
  });
}

function historyEntries(leads: AnalyticsLeadDocument[]) {
  return leads.flatMap((lead) => Array.isArray(lead.history) ? lead.history : []);
}

function historyDate(entry: NonNullable<AnalyticsLeadDocument['history']>[number]): Date | null {
  return parseDate(entry.timestamp) ?? parseDate(entry.ts);
}

function actionVocabulary(leads: AnalyticsLeadDocument[]): Set<string> {
  return new Set(
    historyEntries(leads)
      .map((entry) => typeof entry.action === 'string' ? entry.action : null)
      .filter((action): action is string => action !== null),
  );
}

function countAction(leads: AnalyticsLeadDocument[], action: string, window: AnalyticsWindow): number {
  return historyEntries(leads).filter(
    (entry) => entry.action === action && inWindow(historyDate(entry), window),
  ).length;
}

function targetStatus(entry: NonNullable<AnalyticsLeadDocument['history']>[number]): string | null {
  if (typeof entry.toStatus === 'string') return entry.toStatus;
  if (typeof entry.status === 'string') return entry.status;
  if (typeof entry.description !== 'string') return null;
  return /status zmieniony na ["']([^"']+)["']/i.exec(entry.description)?.[1] ?? null;
}

function partnerTransitionVocabulary(leads: AnalyticsLeadDocument[]): Set<string> {
  return new Set(
    historyEntries(leads)
      .filter((entry) => entry.action === 'status_change')
      .map(targetStatus)
      .filter((status): status is string => status !== null),
  );
}

function countPartnerConversions(leads: AnalyticsLeadDocument[], window: AnalyticsWindow): number {
  return historyEntries(leads).filter((entry) => {
    const status = targetStatus(entry);
    return entry.action === 'status_change'
      && status !== null
      && PARTNER_STATUSES.has(status)
      && inWindow(historyDate(entry), window);
  }).length;
}

function breakdown(
  leads: AnalyticsLeadDocument[],
  windows: AnalyticsWindows,
  field: 'region' | 'segment' | 'status',
): BreakdownComparison {
  const source = `agentforge.leads.${field} (cohort by createdAt)`;
  const fieldObserved = leads.length === 0 || leads.some((lead) => typeof lead[field] === 'string');
  if (!fieldObserved) {
    return {
      status: 'unavailable',
      current: {},
      previous: {},
      source,
      reason: `field_${field}_not_observed_in_real_crm_schema`,
    };
  }

  const count = (window: AnalyticsWindow): Record<string, number> => {
    const values: Record<string, number> = {};
    for (const lead of leadsInWindow(leads, window)) {
      const value = typeof lead[field] === 'string' && lead[field].trim().length > 0
        ? lead[field].trim()
        : 'unknown';
      values[value] = (values[value] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(values).sort((a, b) => b[1] - a[1]));
  };

  return {
    status: 'available',
    current: count(windows.current),
    previous: count(windows.previous),
    source,
    reason: null,
  };
}

function eventComparison(
  leads: AnalyticsLeadDocument[],
  windows: AnalyticsWindows,
  action: string,
  metric: string,
): MetricComparison {
  const source = `agentforge.leads.history[action=${action}].(timestamp|ts)`;
  const vocabulary = actionVocabulary(leads);
  if (!vocabulary.has(action)) {
    const reason = `crm_action_${action}_not_observed; do not report zero`;
    return compareMetric(
      metric,
      unavailableMetric('count', source, reason, leads.length),
      unavailableMetric('count', source, reason, leads.length),
    );
  }
  return compareMetric(
    metric,
    availableMetric(countAction(leads, action, windows.current), 'count', source, leads.length),
    availableMetric(countAction(leads, action, windows.previous), 'count', source, leads.length),
  );
}

/** Pure function intentionally exported for the domain regression fixture. */
export function buildCrmTrendMetrics(
  leads: AnalyticsLeadDocument[],
  windows: AnalyticsWindows,
): CrmTrendMetrics {
  const source = 'agentforge.leads.createdAt';
  const parseableCreatedAt = leads.filter((lead) => leadDate(lead) !== null).length;
  const createdAtAvailable = leads.length === 0 || parseableCreatedAt > 0;

  const newLeads = createdAtAvailable
    ? compareMetric(
        'newLeads',
        availableMetric(leadsInWindow(leads, windows.current).length, 'count', source, parseableCreatedAt),
        availableMetric(leadsInWindow(leads, windows.previous).length, 'count', source, parseableCreatedAt),
      )
    : compareMetric(
        'newLeads',
        unavailableMetric('count', source, 'createdAt_not_parseable', leads.length),
        unavailableMetric('count', source, 'createdAt_not_parseable', leads.length),
      );

  const entries = historyEntries(leads);
  const timestampsObserved = entries.some((entry) => historyDate(entry) !== null);
  const interactionSource = 'agentforge.leads.history.(timestamp|ts)';
  const interactions = timestampsObserved || leads.length === 0
    ? compareMetric(
        'interactions',
        availableMetric(entries.filter((entry) => inWindow(historyDate(entry), windows.current)).length, 'count', interactionSource, entries.length),
        availableMetric(entries.filter((entry) => inWindow(historyDate(entry), windows.previous)).length, 'count', interactionSource, entries.length),
      )
    : compareMetric(
        'interactions',
        unavailableMetric('count', interactionSource, 'history_timestamp_not_observed', entries.length),
        unavailableMetric('count', interactionSource, 'history_timestamp_not_observed', entries.length),
      );

  const partnerStatuses = partnerTransitionVocabulary(leads);
  const partnerSource = 'agentforge.leads.history[action=status_change].targetStatus';
  const partnerStatusObserved = [...partnerStatuses].some((status) => PARTNER_STATUSES.has(status));
  const partnerConversions = partnerStatusObserved
    ? compareMetric(
        'partnerConversions',
        availableMetric(countPartnerConversions(leads, windows.current), 'count', partnerSource, entries.length),
        availableMetric(countPartnerConversions(leads, windows.previous), 'count', partnerSource, entries.length),
      )
    : compareMetric(
        'partnerConversions',
        unavailableMetric('count', partnerSource, 'partner_status_not_observed; do not infer conversion from another status', entries.length),
        unavailableMetric('count', partnerSource, 'partner_status_not_observed; do not infer conversion from another status', entries.length),
      );

  return {
    newLeads,
    interactions,
    emailsSent: eventComparison(leads, windows, EMAIL_SENT_ACTION, 'emailsSent'),
    responses: eventComparison(leads, windows, RESPONSE_ACTION, 'responses'),
    meetings: eventComparison(leads, windows, MEETING_ACTION, 'meetings'),
    partnerConversions,
    byRegion: breakdown(leads, windows, 'region'),
    bySegment: breakdown(leads, windows, 'segment'),
    byStatus: breakdown(leads, windows, 'status'),
  };
}

function signalComparison(signals: AnalyticsSignalDocument[], windows: AnalyticsWindows) {
  const source = 'agentforge.signals.createdAt';
  const parseableTimestamps = signals.filter((signal) => parseDate(signal.createdAt) !== null).length;
  if (signals.length > 0 && parseableTimestamps === 0) {
    const reason = 'createdAt_not_observed_in_real_signals_schema';
    const unavailable = unavailableMetric('count', source, reason, signals.length);
    return {
      total: compareMetric('signals', unavailable, unavailable),
      byType: {
        status: 'unavailable' as const,
        current: {},
        previous: {},
        source,
        reason,
      } satisfies BreakdownComparison,
    };
  }
  const currentSignals = signals.filter((signal) => inWindow(signal.createdAt, windows.current));
  const previousSignals = signals.filter((signal) => inWindow(signal.createdAt, windows.previous));
  const byType = (docs: AnalyticsSignalDocument[]) => {
    const result: Record<string, number> = {};
    for (const signal of docs) {
      const type = typeof signal.type === 'string' ? signal.type : 'unknown';
      result[type] = (result[type] ?? 0) + 1;
    }
    return result;
  };
  return {
    total: compareMetric(
      'signals',
      availableMetric(currentSignals.length, 'count', source, signals.length),
      availableMetric(previousSignals.length, 'count', source, signals.length),
    ),
    byType: {
      status: 'available' as const,
      current: byType(currentSignals),
      previous: byType(previousSignals),
      source,
      reason: null,
    } satisfies BreakdownComparison,
  };
}

function systemComparisons(current: OverviewStats, previous: OverviewStats) {
  const source = 'agentforge.agent_events.timestamp';

  const taskCount = (overview: OverviewStats) => availableMetric(
    overview.totalTasks,
    'count',
    source,
    overview.totalTasks,
  );
  const successRate = (overview: OverviewStats, windowName: string) => {
    const denominator: MetricDenominator = {
      label: 'completed_plus_failed_tasks',
      status: 'available',
      value: overview.totalTasks,
    };
    return overview.totalTasks === 0
      ? unavailableMetric(
          'percent',
          source,
          `${windowName}_has_zero_task_denominator; success rate is undefined, not 0%`,
          0,
          denominator,
        )
      : availableMetric(overview.successRate * 100, 'percent', source, overview.totalTasks, denominator);
  };
  const cost = (overview: OverviewStats, windowName: string) => {
    if (overview.totalTasks > 0 && overview.totalTokens === 0) {
      return unavailableMetric(
        'usd',
        'agentforge.agent_events.(model,tokenUsage)',
        `${windowName}_has_tasks_but_no_token_usage; cost observability unavailable`,
        overview.totalTasks,
      );
    }
    return availableMetric(
      overview.totalCostUsd,
      'usd',
      'agentforge.agent_events.(model,tokenUsage)',
      overview.totalTasks,
    );
  };
  const latency = (overview: OverviewStats, windowName: string) => {
    if (overview.totalTasks === 0 || overview.avgLatencyMs === 0) {
      return unavailableMetric(
        'milliseconds',
        'agentforge.agent_events.durationMs',
        overview.totalTasks === 0
          ? `${windowName}_has_zero_task_denominator; average latency is undefined`
          : `${windowName}_has_tasks_but_no_positive_durationMs`,
        overview.totalTasks,
      );
    }
    return availableMetric(
      overview.avgLatencyMs,
      'milliseconds',
      'agentforge.agent_events.durationMs',
      overview.totalTasks,
    );
  };

  return {
    totalTasks: compareMetric('totalTasks', taskCount(current), taskCount(previous)),
    successRate: compareMetric('successRate', successRate(current, 'current'), successRate(previous, 'previous')),
    errors: compareMetric(
      'errors',
      availableMetric(current.totalErrors, 'count', source, current.totalTasks),
      availableMetric(previous.totalErrors, 'count', source, previous.totalTasks),
    ),
    costUsd: compareMetric('costUsd', cost(current, 'current'), cost(previous, 'previous')),
    avgLatencyMs: compareMetric('avgLatencyMs', latency(current, 'current'), latency(previous, 'previous')),
  };
}

/** Pure workflow-run aggregation intentionally exported for the drift fixture. */
export function buildWorkflowComparisons(
  runs: AnalyticsWorkflowRunDocument[],
  windows: AnalyticsWindows,
) {
  const source = 'agentforge.workflow_runs.startedAt';
  const parseable = runs.filter((run) => parseDate(run.startedAt) !== null);
  if (runs.length > 0 && parseable.length === 0) {
    const unavailable = unavailableMetric('count', source, 'startedAt_not_observed_in_real_workflow_runs_schema', runs.length);
    return {
      runs: compareMetric('workflowRuns', unavailable, unavailable),
      errorRate: compareMetric(
        'workflowErrorRate',
        unavailableMetric('percent', 'agentforge.workflow_runs.status', 'startedAt_not_observed_in_real_workflow_runs_schema', runs.length),
        unavailableMetric('percent', 'agentforge.workflow_runs.status', 'startedAt_not_observed_in_real_workflow_runs_schema', runs.length),
      ),
    };
  }

  const currentRuns = parseable.filter((run) => inWindow(run.startedAt, windows.current));
  const previousRuns = parseable.filter((run) => inWindow(run.startedAt, windows.previous));
  const statusesObserved = runs.length === 0 || runs.some((run) => typeof run.status === 'string');
  const rate = (docs: AnalyticsWorkflowRunDocument[], windowName: string): MetricObservation => {
    if (!statusesObserved) {
      return unavailableMetric('percent', 'agentforge.workflow_runs.status', 'status_not_observed_in_real_workflow_runs_schema', docs.length);
    }
    if (docs.length === 0) {
      return unavailableMetric(
        'percent',
        'agentforge.workflow_runs.status',
        `${windowName}_has_zero_denominator`,
        0,
        { label: 'workflow_runs', status: 'available', value: 0 },
      );
    }
    const errors = docs.filter((run) => run.status === 'error' || run.status === 'failed').length;
    return availableMetric(
      (errors / docs.length) * 100,
      'percent',
      'agentforge.workflow_runs.status',
      docs.length,
      { label: 'workflow_runs', status: 'available', value: docs.length },
    );
  };

  return {
    runs: compareMetric(
      'workflowRuns',
      availableMetric(currentRuns.length, 'count', source, parseable.length),
      availableMetric(previousRuns.length, 'count', source, parseable.length),
    ),
    errorRate: compareMetric('workflowErrorRate', rate(currentRuns, 'current'), rate(previousRuns, 'previous')),
  };
}

/** Pure RSS aggregation; the DB-specific read is kept below. */
export function buildRssTopicComparison(
  articles: AnalyticsRssArticle[],
  windows: AnalyticsWindows,
  observability: { dateFieldObserved: boolean; collectionDocuments: number } = {
    dateFieldObserved: true,
    collectionDocuments: articles.length,
  },
) {
  const articleDate = (article: AnalyticsRssArticle) => (
    parseDate(article._analyticsDate)
    ?? parseDate(article.publishedAt)
    ?? parseDate(article.pubDate)
  );
  const counts = (window: AnalyticsWindow) => {
    const result: Record<string, number> = {};
    for (const article of articles) {
      const date = articleDate(article);
      if (!date || !inWindow(date, window)) continue;
      const text = `${String(article.title ?? '')} ${String(article.description ?? '')}`.toLowerCase();
      for (const keyword of RSS_KEYWORDS) {
        if (text.includes(keyword.toLowerCase())) result[keyword] = (result[keyword] ?? 0) + 1;
      }
    }
    return result;
  };
  if (!observability.dateFieldObserved && observability.collectionDocuments > 0) {
    const reason = 'publishedAt_and_pubDate_not_parseable_in_real_rss_schema';
    const unavailable = unavailableMetric(
      'count',
      'rss_intelligence.rss_articles.(publishedAt|pubDate)',
      reason,
      observability.collectionDocuments,
    );
    return {
      status: 'unavailable' as const,
      source: 'rss_intelligence.rss_articles.(publishedAt|pubDate)',
      sampleSize: observability.collectionDocuments,
      totalArticles: compareMetric('rssArticles', unavailable, unavailable),
      topics: [],
      reason,
    };
  }

  const currentArticles = articles.filter((article) => {
    const date = articleDate(article);
    return date ? inWindow(date, windows.current) : false;
  });
  const previousArticles = articles.filter((article) => {
    const date = articleDate(article);
    return date ? inWindow(date, windows.previous) : false;
  });
  const current = counts(windows.current);
  const previous = counts(windows.previous);
  const topics = [...new Set([...Object.keys(current), ...Object.keys(previous)])]
    .map((keyword) => {
      const currentCount = current[keyword] ?? 0;
      const previousCount = previous[keyword] ?? 0;
      return {
        keyword,
        current: currentCount,
        previous: previousCount,
        absoluteDelta: currentCount - previousCount,
        percentDelta: previousCount > 0 ? round(((currentCount - previousCount) / previousCount) * 100) : null,
        percentDeltaReason: previousCount > 0 ? null : 'previous_value_is_zero',
        denominator: {
          currentArticles: currentArticles.length,
          previousArticles: previousArticles.length,
        },
      };
    })
    .sort((a, b) => (b.current + b.previous) - (a.current + a.previous))
    .slice(0, 10);

  return {
    status: 'available' as const,
    source: 'rss_intelligence.rss_articles.(publishedAt|pubDate)',
    sampleSize: articles.length,
    totalArticles: compareMetric(
      'rssArticles',
      availableMetric(
        currentArticles.length,
        'count',
        'rss_intelligence.rss_articles.(publishedAt|pubDate)',
        currentArticles.length,
      ),
      availableMetric(
        previousArticles.length,
        'count',
        'rss_intelligence.rss_articles.(publishedAt|pubDate)',
        previousArticles.length,
      ),
    ),
    topics,
    reason: null,
  };
}

function limitationsFromComparisons(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const limitations: string[] = [];
  if (record.status === 'unavailable' && typeof record.reason === 'string') {
    limitations.push(`${prefix || 'metric'}: ${record.reason}`);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'reason') continue;
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    limitations.push(...limitationsFromComparisons(child, childPrefix));
  }
  return [...new Set(limitations)];
}

function asOfDate(raw: string | undefined): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error('asOf must be a valid ISO date');
  return parsed;
}

async function loadCoreDocuments() {
  const db = await getDb();
  const [leads, signals, workflowRuns] = await Promise.all([
    db.collection<AnalyticsLeadDocument>('leads').find({}).project({
      createdAt: 1, updatedAt: 1, status: 1, region: 1, segment: 1, history: 1,
    }).toArray(),
    db.collection<AnalyticsSignalDocument>('signals').find({}).project({ createdAt: 1, type: 1 }).toArray(),
    db.collection<AnalyticsWorkflowRunDocument>('workflow_runs').find({}).project({ startedAt: 1, status: 1, workflowId: 1 }).toArray(),
  ]);
  return {
    databaseName: db.databaseName,
    leads,
    signals,
    workflowRuns,
  };
}

async function loadRssArticles(windows: AnalyticsWindows): Promise<{
  databaseName: string;
  articles: AnalyticsRssArticle[];
  dateFieldObserved: boolean;
  collectionDocuments: number;
}> {
  const rssDb = await getRssDb();
  const fullWindow = {
    from: new Date(windows.previous.from),
    to: new Date(windows.current.to),
  };
  // Both real fields are strings today (RFC-822 `pubDate`, mostly ISO
  // `publishedAt`). Convert inside Mongo; comparing them to Date directly was the
  // legacy bug that made a database with 11k articles look empty.
  const conversionStages = [
    {
      $set: {
        _analyticsPublishedAt: {
          $convert: { input: '$publishedAt', to: 'date', onError: null, onNull: null },
        },
        _analyticsPubDate: {
          $convert: { input: '$pubDate', to: 'date', onError: null, onNull: null },
        },
      },
    },
    { $set: { _analyticsDate: { $ifNull: ['$_analyticsPublishedAt', '$_analyticsPubDate'] } } },
  ];
  const collection = rssDb.collection<AnalyticsRssArticle>('rss_articles');
  const [articles, collectionDocuments, parseableSample] = await Promise.all([
    collection.aggregate<AnalyticsRssArticle>([
      ...conversionStages,
      { $match: { _analyticsDate: { $gte: fullWindow.from, $lt: fullWindow.to } } },
      { $project: { _id: 0, title: 1, description: 1, pubDate: 1, publishedAt: 1, _analyticsDate: 1 } },
    ]).toArray(),
    collection.estimatedDocumentCount(),
    collection.aggregate<AnalyticsRssArticle>([
      ...conversionStages,
      { $match: { _analyticsDate: { $ne: null } } },
      { $limit: 1 },
      { $project: { _id: 1 } },
    ]).toArray(),
  ]);
  return {
    databaseName: rssDb.databaseName,
    articles,
    dateFieldObserved: collectionDocuments === 0 || parseableSample.length > 0,
    collectionDocuments,
  };
}

async function loadOverviewPair(windows: AnalyticsWindows): Promise<{ current: OverviewStats; previous: OverviewStats }> {
  const [current, previous] = await Promise.all([
    getOverview(dateWindow(windows.current)),
    getOverview(dateWindow(windows.previous)),
  ]);
  return { current, previous };
}

export interface CollectorInput {
  periodDays: number;
  asOf?: string;
}

export async function collectWeeklyAnalytics(input: CollectorInput) {
  const windows = buildEqualComparisonWindows(input.periodDays, asOfDate(input.asOf));
  const [core, overview] = await Promise.all([loadCoreDocuments(), loadOverviewPair(windows)]);
  const crm = buildCrmTrendMetrics(core.leads, windows);
  const signals = signalComparison(core.signals, windows);
  const system = systemComparisons(overview.current, overview.previous);
  const limitations = limitationsFromComparisons({ crm, signals, system });

  return {
    mode: 'weekly' as const,
    scope: 'read_only_analysis_report' as const,
    windows,
    crm: {
      totalLeadsSnapshot: availableMetric(
        core.leads.length,
        'count',
        `${core.databaseName}.leads`,
        core.leads.length,
      ),
      ...crm,
    },
    signals,
    system,
    provenance: [
      {
        database: core.databaseName,
        collection: 'leads',
        fields: ['createdAt', 'status', 'region', 'segment', 'history.timestamp', 'history.ts', 'history.action'],
        windowField: 'createdAt / history.(timestamp|ts)',
        note: 'Date and ISO-string timestamps are both parsed; missing event vocabulary is unavailable, never zero.',
      },
      {
        database: core.databaseName,
        collection: 'signals',
        fields: ['createdAt', 'type'],
        windowField: 'createdAt',
        note: 'Read only; this collector does not emit signals.',
      },
      {
        database: core.databaseName,
        collection: 'agent_events',
        fields: ['timestamp', 'type', 'durationMs', 'model', 'tokenUsage'],
        windowField: 'timestamp',
        note: 'System telemetry uses the existing dashboard aggregation service.',
      },
    ] satisfies DataProvenance[],
    limitations,
  };
}

function ratioObservation(
  numerator: MetricObservation,
  denominator: MetricObservation,
  metricSource: string,
  denominatorLabel: string,
): MetricObservation {
  const denominatorInfo: MetricDenominator = {
    label: denominatorLabel,
    status: denominator.status,
    value: denominator.value,
  };
  if (numerator.status === 'unavailable' || numerator.value === null) {
    return unavailableMetric('percent', metricSource, numerator.reason ?? 'numerator_unavailable', numerator.sampleSize, denominatorInfo);
  }
  if (denominator.status === 'unavailable' || denominator.value === null) {
    return unavailableMetric('percent', metricSource, denominator.reason ?? 'denominator_unavailable', denominator.sampleSize, denominatorInfo);
  }
  if (denominator.value === 0) {
    return unavailableMetric('percent', metricSource, 'zero_denominator; do not report 0%', denominator.sampleSize, denominatorInfo);
  }
  return availableMetric(
    (numerator.value / denominator.value) * 100,
    'percent',
    metricSource,
    numerator.sampleSize,
    denominatorInfo,
  );
}

function mappedObservation(
  input: MetricObservation,
  unit: MetricUnit,
  source: string,
  map: (value: number) => number,
): MetricObservation {
  if (input.status === 'unavailable' || input.value === null) {
    return unavailableMetric(unit, source, input.reason ?? 'source_metric_unavailable', input.sampleSize, input.denominator);
  }
  return availableMetric(map(input.value), unit, source, input.sampleSize, input.denominator);
}

function roiObservation(revenue: MetricObservation, cost: MetricObservation): MetricObservation {
  const source = 'derived: ((estimatedRevenuePLN - estimatedCostPLN) / estimatedCostPLN) * 100';
  const denominator: MetricDenominator = {
    label: 'estimatedCostPLN',
    status: cost.status,
    value: cost.value,
  };
  if (revenue.status === 'unavailable' || revenue.value === null) {
    return unavailableMetric('percent', source, revenue.reason ?? 'revenue_unavailable', revenue.sampleSize, denominator);
  }
  if (cost.status === 'unavailable' || cost.value === null) {
    return unavailableMetric('percent', source, cost.reason ?? 'cost_unavailable', cost.sampleSize, denominator);
  }
  if (cost.value === 0) {
    return unavailableMetric('percent', source, 'zero_cost_denominator; ROI is undefined, not 0%', cost.sampleSize, denominator);
  }
  return availableMetric(((revenue.value - cost.value) / cost.value) * 100, 'percent', source, revenue.sampleSize, denominator);
}

export interface RoiCollectorInput extends CollectorInput {
  avgDealValuePLN: number;
  exchangeRatePLNPerUSD: number;
}

export async function collectRoiAnalytics(input: RoiCollectorInput) {
  const windows = buildEqualComparisonWindows(input.periodDays, asOfDate(input.asOf));
  const [core, overview] = await Promise.all([loadCoreDocuments(), loadOverviewPair(windows)]);
  const crm = buildCrmTrendMetrics(core.leads, windows);
  const system = systemComparisons(overview.current, overview.previous);
  const workflows = buildWorkflowComparisons(core.workflowRuns, windows);

  const responseRate = compareMetric(
    'responseRate',
    ratioObservation(crm.responses.current, crm.emailsSent.current, 'derived: responses / emailsSent', 'emailsSent'),
    ratioObservation(crm.responses.previous, crm.emailsSent.previous, 'derived: responses / emailsSent', 'emailsSent'),
  );
  const conversionRate = compareMetric(
    'leadToPartnerConversionRate',
    ratioObservation(crm.partnerConversions.current, crm.newLeads.current, 'derived: partnerConversions / newLeads', 'newLeads'),
    ratioObservation(crm.partnerConversions.previous, crm.newLeads.previous, 'derived: partnerConversions / newLeads', 'newLeads'),
  );
  const costPln = compareMetric(
    'estimatedCostPLN',
    mappedObservation(system.costUsd.current, 'pln', 'derived: agent_events costUsd * exchangeRatePLNPerUSD', (v) => v * input.exchangeRatePLNPerUSD),
    mappedObservation(system.costUsd.previous, 'pln', 'derived: agent_events costUsd * exchangeRatePLNPerUSD', (v) => v * input.exchangeRatePLNPerUSD),
  );
  const revenue = compareMetric(
    'estimatedRevenuePLN',
    mappedObservation(crm.partnerConversions.current, 'pln', 'derived: partnerConversions * avgDealValuePLN', (v) => v * input.avgDealValuePLN),
    mappedObservation(crm.partnerConversions.previous, 'pln', 'derived: partnerConversions * avgDealValuePLN', (v) => v * input.avgDealValuePLN),
  );
  const roi = compareMetric(
    'roiPercent',
    roiObservation(revenue.current, costPln.current),
    roiObservation(revenue.previous, costPln.previous),
  );
  const limitations = limitationsFromComparisons({ crm, workflows, responseRate, conversionRate, roi });

  return {
    mode: 'roi' as const,
    scope: 'read_only_analysis_report' as const,
    windows,
    assumptions: {
      avgDealValuePLN: input.avgDealValuePLN,
      exchangeRatePLNPerUSD: input.exchangeRatePLNPerUSD,
    },
    funnel: {
      newLeads: crm.newLeads,
      emailsSent: crm.emailsSent,
      responses: crm.responses,
      meetings: crm.meetings,
      partnerConversions: crm.partnerConversions,
      responseRate,
      leadToPartnerConversionRate: conversionRate,
    },
    economics: {
      costUsd: system.costUsd,
      estimatedCostPLN: costPln,
      estimatedRevenuePLN: revenue,
      roiPercent: roi,
    },
    workflows,
    provenance: [
      {
        database: core.databaseName,
        collection: 'agent_events',
        fields: ['timestamp', 'model', 'tokenUsage'],
        windowField: 'timestamp',
        note: 'Costs come from observed agent events, not the empty legacy token_usage collection.',
      },
      {
        database: core.databaseName,
        collection: 'leads',
        fields: ['createdAt', 'history.timestamp', 'history.ts', 'history.action', 'history.toStatus', 'status'],
        windowField: 'createdAt / history.(timestamp|ts)',
        note: 'Revenue and ROI stay unavailable until a dated partner conversion status is genuinely observed.',
      },
      {
        database: core.databaseName,
        collection: 'workflow_runs',
        fields: ['startedAt', 'status'],
        windowField: 'startedAt',
        note: 'A collection whose existing documents lack startedAt is unavailable, not zero runs.',
      },
    ] satisfies DataProvenance[],
    limitations,
  };
}

export async function collectTrendAnalytics(input: CollectorInput) {
  const windows = buildEqualComparisonWindows(input.periodDays, asOfDate(input.asOf));
  const [core, rss, overview] = await Promise.all([
    loadCoreDocuments(),
    loadRssArticles(windows),
    loadOverviewPair(windows),
  ]);
  const crm = buildCrmTrendMetrics(core.leads, windows);
  const signals = signalComparison(core.signals, windows);
  const workflows = buildWorkflowComparisons(core.workflowRuns, windows);
  const system = systemComparisons(overview.current, overview.previous);
  const rssTopics = buildRssTopicComparison(rss.articles, windows, {
    dateFieldObserved: rss.dateFieldObserved,
    collectionDocuments: rss.collectionDocuments,
  });
  const limitations = limitationsFromComparisons({ crm, signals, workflows, system, rssTopics });

  return {
    mode: 'trends' as const,
    scope: 'read_only_analysis_report' as const,
    windows,
    crm,
    rss: rssTopics,
    workflows,
    system,
    signals,
    provenance: [
      {
        database: core.databaseName,
        collection: 'leads',
        fields: ['createdAt', 'region', 'segment', 'status', 'history.timestamp', 'history.ts', 'history.action'],
        windowField: 'createdAt / history.(timestamp|ts)',
        note: 'Breakdowns compare creation cohorts; they are not mislabeled all-time snapshots.',
      },
      {
        database: rss.databaseName,
        collection: 'rss_articles',
        fields: ['publishedAt', 'pubDate', 'title', 'description'],
        windowField: 'publishedAt / pubDate converted from string to Date',
        note: 'This is the dedicated rss_intelligence database, not agentforge.',
      },
      {
        database: core.databaseName,
        collection: 'workflow_runs',
        fields: ['startedAt', 'status'],
        windowField: 'startedAt',
        note: 'Missing runtime fields are reported as unavailable.',
      },
      {
        database: core.databaseName,
        collection: 'agent_events',
        fields: ['timestamp', 'type', 'durationMs', 'model', 'tokenUsage'],
        windowField: 'timestamp',
        note: 'System activity is compared over the same adjacent windows.',
      },
    ] satisfies DataProvenance[],
    limitations,
  };
}
