import { canonicalizeRuntimeAgentId } from '../config/agent-ids.js';
import { getDb } from '../lib/mongo.js';
import { calculateCost, getModelPricing } from '../lib/model-pricing.js';
import type { TimeWindow } from './dashboard-stats.js';
import { readGraphTrendEntries, type GraphTrendEntry } from './graphify-trend.js';

type TokenUsageDoc = {
  prompt?: number;
  completion?: number;
};

type EventDoc = {
  eventId?: string;
  type?: string;
  timestamp?: Date;
  agentId?: string | null;
  runId?: string;
  turnId?: string;
  threadId?: string;
  taskId?: string;
  model?: string | null;
  status?: string;
  durationMs?: number;
  tokenUsage?: TokenUsageDoc;
  errorMessage?: string;
  toolId?: string;
  data?: Record<string, any>;
  metadata?: Record<string, any>;
};

type AgentEntityKind = 'agent' | 'worker' | 'plan' | 'system' | 'unknown';
type PricingStatus = 'priced' | 'missing_pricing' | 'zero_tokens' | 'alias';
type TimelineGranularity = 'hour' | 'day';

const DASHBOARD_V2_CACHE_TTL_MS = parseEnvInt('DASHBOARD_V2_CACHE_TTL_MS', 15_000);
const DASHBOARD_V2_CACHE_MAX_ENTRIES = parseEnvInt('DASHBOARD_V2_CACHE_MAX_ENTRIES', 250);

type DashboardV2CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const dashboardV2Cache = new Map<string, DashboardV2CacheEntry<unknown>>();

export type DashboardV2Filters = {
  agentId?: string;
  model?: string;
  toolCategory?: string;
  toolRisk?: string;
  toolStatus?: string;
};

export type DashboardV2Alert = {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
  metric?: number;
};

export type DashboardV2MetricDelta = {
  current: number;
  previous: number;
  absolute: number;
  relative: number;
  direction: 'up' | 'down' | 'flat';
};

export type DashboardV2AgentRollup = {
  canonicalAgentId: string;
  displayName: string;
  entityKind: AgentEntityKind;
  rawAgentIds: string[];
  totalEvents: number;
  totalTasks: number;
  completed: number;
  failed: number;
  successRate: number;
  runsCompleted: number;
  runsFailed: number;
  toolCalls: number;
  toolFailures: number;
  toolFailureRate: number;
  tokensUsed: number;
  costUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p75LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  p99ToP50Ratio: number;
  lastError?: string;
};

export type DashboardV2ModelRollup = {
  model: string;
  displayName: string;
  provider: string;
  rawAliases: string[];
  invocations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  costPerInvocationUsd: number;
  costPer1kTokensUsd: number;
  costShare: number;
  tokenShare: number;
  zeroTokenInvocations: number;
  errorEvents: number;
  errorRate: number;
  agents: string[];
  pricingStatus: PricingStatus;
  avgLatencyMs: number;
  p95LatencyMs: number;
};

export type DashboardV2ToolStats = {
  totalExecutions: number;
  byStatus: Array<{ status: string; count: number }>;
  byCategory: Array<{ category: string; count: number; failed: number; blocked: number; avgDurationMs: number }>;
  byRisk: Array<{ risk: string; count: number; failed: number; blocked: number }>;
  topTools: Array<{
    toolId: string;
    count: number;
    failed: number;
    blocked: number;
    failureRate: number;
    avgDurationMs: number;
    categories: string[];
    risks: string[];
  }>;
  topFailures: Array<{ toolId: string; errorClass: string; count: number; lastError?: string }>;
  policy: {
    blocked: number;
    requiresApproval: number;
    highRiskBlocked: number;
  };
  hangingStarted: Array<{ id: string; toolId: string; agentId?: string; ageMs: number; createdAt?: string; runId?: string; taskId?: string; threadId?: string }>;
};

export type DashboardV2SkillStats = {
  totalOperations: number;
  byOperation: Array<{ operation: string; count: number; failed: number; blocked: number; avgDurationMs: number }>;
  topSkillTools: Array<{ toolId: string; count: number; failed: number; blocked: number; failureRate: number; avgDurationMs: number }>;
  legacySkillUsed: Array<{ skillId: string; uses: number; agents: string[] }>;
};

export type DashboardV2Summary = {
  window: { from: string; to: string };
  totals: {
    tasks: number;
    completed: number;
    failed: number;
    runsCompleted: number;
    runsFailed: number;
    events: number;
    agents: number;
    models: number;
    toolExecutions: number;
    tokens: number;
    costUsd: number;
    scorerEvaluations: number;
  };
  rates: {
    successRate: number;
    taskFailureRate: number;
    toolFailureRate: number;
    scorerCoverage: number;
  };
  latency: {
    avgMs: number;
    p95Ms: number;
  };
  compare?: {
    previousWindow: { from: string; to: string };
    deltas: {
      tasks: DashboardV2MetricDelta;
      successRate: DashboardV2MetricDelta;
      costUsd: DashboardV2MetricDelta;
      tokens: DashboardV2MetricDelta;
      toolFailureRate: DashboardV2MetricDelta;
      scorerCoverage: DashboardV2MetricDelta;
      p95LatencyMs: DashboardV2MetricDelta;
    };
  };
  alerts: DashboardV2Alert[];
};

export type DashboardV2LatencyStats = {
  overall: {
    samples: number;
    avgMs: number;
    p50Ms: number;
    p75Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    p99ToP50Ratio: number;
  };
  byAgent: Array<{
    canonicalAgentId: string;
    displayName: string;
    entityKind: AgentEntityKind;
    samples: number;
    avgMs: number;
    p50Ms: number;
    p75Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    p99ToP50Ratio: number;
  }>;
  slowest: Array<{
    eventId: string;
    type: string;
    agentId: string;
    model?: string;
    durationMs: number;
    timestamp?: string;
    runId?: string;
    taskId?: string;
    threadId?: string;
    turnId?: string;
    errorMessage?: string;
  }>;
};

export type DashboardV2TimelineStats = {
  granularity: TimelineGranularity;
  buckets: Array<{
    bucket: string;
    events: number;
    taskStarted: number;
    taskCompleted: number;
    taskFailed: number;
    runsCompleted: number;
    runsFailed: number;
    toolFailed: number;
    toolBlocked: number;
    highRiskBlocked: number;
    policyBlocked: number;
    approvalGates: number;
    workerAlerts: number;
    reflectorInterventions: number;
    reflectionRepairs: number;
    autohealEvents: number;
    outputScores: number;
    tokens: number;
    costUsd: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  }>;
  annotations: Array<{
    bucket: string;
    type: string;
    severity: 'info' | 'warning' | 'critical';
    label: string;
    count: number;
    sample?: string;
    traceId?: string;
  }>;
};

export type DashboardV2QualityStats = {
  totals: {
    tasks: number;
    scoredTasks: number;
    nativeScorerRecords: number;
    outputScoreEvents: number;
    goalEvaluations: number;
  };
  coverage: {
    taskCoverage: number;
    nativeScorerCoverage: number;
    outputScoreCoverage: number;
    goalEvaluationCoverage: number;
  };
  outcome: {
    avgScore: number;
    passRate: number;
    passed: number;
    failed: number;
    evaluated: number;
  };
  distribution: Array<{ bucket: string; count: number }>;
  scorerSummaries: Array<{
    scorerId: string;
    source: 'mastra_scorers' | 'goal_completion' | 'output_score';
    totalEvaluations: number;
    avgScore: number;
    passRate: number;
    low: number;
    mid: number;
    high: number;
  }>;
  byAgent: Array<{
    agentId: string;
    tasks: number;
    scoredTasks: number;
    coverage: number;
    avgScore: number;
    passRate: number;
    failed: number;
  }>;
  recentFailures: Array<{
    source: 'mastra_scorers' | 'goal_completion' | 'output_score';
    scorerId?: string;
    agentId?: string;
    taskId?: string;
    score?: number;
    passed: boolean;
    timestamp?: string;
    reason?: string;
  }>;
  coverageGaps: Array<{
    agentId: string;
    tasks: number;
    scoredTasks: number;
    coverage: number;
  }>;
  trend?: {
    previousWindow: { from: string; to: string };
    taskCoverage: DashboardV2MetricDelta;
    passRate: DashboardV2MetricDelta;
    avgScore: DashboardV2MetricDelta;
    evaluated: DashboardV2MetricDelta;
  };
};

export type DashboardV2TraceParams = DashboardV2Filters & {
  status?: string;
  runId?: string;
  taskId?: string;
  threadId?: string;
  limit: number;
};

export type DashboardV2TraceSummary = {
  traceId: string;
  status: 'completed' | 'failed' | 'running' | 'unknown';
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  agentId: string;
  model?: string;
  runId?: string;
  taskId?: string;
  threadId?: string;
  turnId?: string;
  eventCount: number;
  toolExecutions: number;
  scorerEvaluations: number;
  tokens: number;
  costUsd: number;
  latencyMs: number;
  firstError?: string;
  eventTypes: string[];
};

export type DashboardV2TraceList = {
  traces: DashboardV2TraceSummary[];
  limit: number;
  hasMore: boolean;
};

export type DashboardV2TraceEvent = {
  eventId: string;
  type: string;
  timestamp?: string;
  agentId: string;
  rawAgentId?: string;
  model?: string;
  status?: string;
  durationMs?: number;
  runId?: string;
  taskId?: string;
  threadId?: string;
  turnId?: string;
  toolId?: string;
  errorMessage?: string;
};

export type DashboardV2TraceTool = {
  id: string;
  toolId: string;
  status: string;
  category: string;
  risk: string;
  agentId?: string;
  runId?: string;
  taskId?: string;
  threadId?: string;
  turnId?: string;
  durationMs?: number;
  createdAt?: string;
  completedAt?: string;
  errorClass?: string;
  errorMessage?: string;
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
};

export type DashboardV2TraceScore = {
  source: 'mastra_scorers' | 'goal_completion' | 'output_score';
  scorerId: string;
  agentId?: string;
  taskId?: string;
  score?: number;
  passed: boolean;
  timestamp?: string;
  reason?: string;
};

export type DashboardV2TraceDetail = {
  summary: DashboardV2TraceSummary;
  events: DashboardV2TraceEvent[];
  tools: DashboardV2TraceTool[];
  scores: DashboardV2TraceScore[];
};

type ToolExecutionDoc = {
  id?: string;
  toolId?: string;
  category?: string;
  risk?: string;
  status?: string;
  policyDecision?: unknown;
  runId?: string;
  taskId?: string;
  subtaskId?: string;
  threadId?: string;
  turnId?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
  inputPreview?: string;
  outputPreview?: string;
  outputArtifactId?: string;
  agentId?: string;
  createdAt?: Date;
  completedAt?: Date;
};

type ScorerDoc = {
  scorerId?: string;
  score?: number;
  entityId?: string;
  entityType?: string;
  agentId?: string;
  taskId?: string;
  createdAt?: Date;
  reason?: string;
  metadata?: Record<string, any>;
};

type DashboardV2TimelineBucketMutable = DashboardV2TimelineStats['buckets'][number] & {
  latencies: number[];
};

type QualitySource = DashboardV2QualityStats['recentFailures'][number]['source'];

type QualityScoreRecord = {
  source: QualitySource;
  scorerId: string;
  agentId?: string;
  taskId?: string;
  score: number;
  passed: boolean;
  timestamp?: Date;
  reason?: string;
};

type TraceAccumulator = {
  traceId: string;
  agentCounts: Map<string, number>;
  models: Set<string>;
  eventTypes: Set<string>;
  eventCount: number;
  toolExecutions: number;
  scorerEvaluations: number;
  tokens: number;
  costUsd: number;
  latencies: number[];
  failed: boolean;
  completed: boolean;
  running: boolean;
  startedAt?: Date;
  endedAt?: Date;
  updatedAt?: Date;
  firstError?: string;
  runId?: string;
  taskId?: string;
  threadId?: string;
  turnId?: string;
};

export function parseDashboardV2Filters(params: URLSearchParams): DashboardV2Filters {
  return {
    agentId: cleanFilterParam(params.get('agentId')),
    model: cleanFilterParam(params.get('model')),
    toolCategory: cleanFilterParam(params.get('toolCategory')),
    toolRisk: cleanFilterParam(params.get('toolRisk')),
    toolStatus: cleanFilterParam(params.get('toolStatus')),
  };
}

export function parseDashboardV2TraceParams(params: URLSearchParams): DashboardV2TraceParams {
  return {
    ...parseDashboardV2Filters(params),
    status: cleanFilterParam(params.get('status')),
    runId: cleanFilterParam(params.get('runId')),
    taskId: cleanFilterParam(params.get('taskId')),
    threadId: cleanFilterParam(params.get('threadId')),
    limit: clampLimit(Number(params.get('limit') ?? 25), 5, 100),
  };
}

export async function getDashboardV2Summary(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2Summary> {
  return cachedDashboardV2(['summary', cacheWindow(window), filters], async () => {
    const [current, previous] = await Promise.all([
      getDashboardV2SummaryCore(window, filters),
      getDashboardV2SummaryCore(previousTimeWindow(window), filters),
    ]);
    const previousWindow = previousTimeWindow(window);

    return {
      ...current,
      compare: {
        previousWindow: toWindowDto(previousWindow),
        deltas: {
          tasks: metricDelta(current.totals.tasks, previous.totals.tasks),
          successRate: metricDelta(current.rates.successRate, previous.rates.successRate),
          costUsd: metricDelta(current.totals.costUsd, previous.totals.costUsd),
          tokens: metricDelta(current.totals.tokens, previous.totals.tokens),
          toolFailureRate: metricDelta(current.rates.toolFailureRate, previous.rates.toolFailureRate),
          scorerCoverage: metricDelta(current.rates.scorerCoverage, previous.rates.scorerCoverage),
          p95LatencyMs: metricDelta(current.latency.p95Ms, previous.latency.p95Ms),
        },
      },
    };
  });
}

async function getDashboardV2SummaryCore(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2Summary> {
  const db = await getDb();
  const events = db.collection<EventDoc>('agent_events');

  const [eventDocs, agents, models, tools, quality] = await Promise.all([
    events.find(eventWindowQuery(window), {
      projection: {
        _id: 0,
        type: 1,
        agentId: 1,
        model: 1,
        durationMs: 1,
      },
    }).toArray().then((docs) => filterEventDocs(docs, filters)),
    getDashboardV2Agents(window, filters),
    getDashboardV2Models(window, filters),
    getDashboardV2Tools(window, filters),
    getDashboardV2QualityCoreCached(window, filters),
  ]);

  const completed = eventDocs.filter((doc) => doc.type === 'task_completed').length;
  const failed = eventDocs.filter((doc) => doc.type === 'task_failed').length;
  const runsCompleted = eventDocs.filter((doc) => doc.type === 'run_completed').length;
  const runsFailed = eventDocs.filter((doc) => doc.type === 'run_failed').length;
  const latencies = eventDocs
    .map((doc) => doc.durationMs ?? 0)
    .filter((n) => typeof n === 'number' && n > 0);
  const totalTasks = completed + failed;
  const totalTokens = models.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCostUsd = models.reduce((sum, row) => sum + row.costUsd, 0);
  const toolFailures = tools.byStatus
    .filter((row) => row.status === 'failed' || row.status === 'blocked')
    .reduce((sum, row) => sum + row.count, 0);
  const successRate = totalTasks > 0 ? completed / totalTasks : 0;
  const toolFailureRate = tools.totalExecutions > 0 ? toolFailures / tools.totalExecutions : 0;

  return {
    window: toWindowDto(window),
    totals: {
      tasks: totalTasks,
      completed,
      failed,
      runsCompleted,
      runsFailed,
      events: eventDocs.length,
      agents: agents.filter((row) => row.entityKind === 'agent').length,
      models: models.length,
      toolExecutions: tools.totalExecutions,
      tokens: totalTokens,
      costUsd: roundMoney(totalCostUsd),
      scorerEvaluations: quality.outcome.evaluated,
    },
    rates: {
      successRate,
      taskFailureRate: totalTasks > 0 ? failed / totalTasks : 0,
      toolFailureRate,
      scorerCoverage: quality.coverage.taskCoverage,
    },
    latency: {
      avgMs: average(latencies),
      p95Ms: percentile(latencies, 0.95),
    },
    alerts: buildSummaryAlerts({
      successRate,
      toolFailureRate,
      scorerCoverage: quality.coverage.taskCoverage,
      hangingTools: tools.hangingStarted.length,
      highRiskBlocked: tools.policy.highRiskBlocked,
      missingPricingModels: models.filter((row) => row.pricingStatus === 'missing_pricing').length,
      zeroTokenModels: models.filter((row) => row.pricingStatus === 'zero_tokens').length,
    }),
  };
}

export async function getDashboardV2Agents(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2AgentRollup[]> {
  return cachedDashboardV2(['agents', cacheWindow(window), filters], () => getDashboardV2AgentsUncached(window, filters));
}

async function getDashboardV2AgentsUncached(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2AgentRollup[]> {
  const db = await getDb();
  const docs = filterEventDocs(await db.collection<EventDoc>('agent_events')
    .find(eventWindowQuery(window), {
      projection: {
        _id: 0,
        type: 1,
        agentId: 1,
        model: 1,
        tokenUsage: 1,
        durationMs: 1,
        errorMessage: 1,
      },
    })
    .toArray(), filters);

  const map = new Map<string, {
    displayName: string;
    entityKind: AgentEntityKind;
    rawAgentIds: Set<string>;
    totalEvents: number;
    completed: number;
    failed: number;
    runsCompleted: number;
    runsFailed: number;
    toolCalls: number;
    toolFailures: number;
    tokensUsed: number;
    costUsd: number;
    latencies: number[];
    lastError?: string;
  }>();

  for (const doc of docs) {
    const agent = classifyAgentId(doc.agentId);
    const row = map.get(agent.canonicalAgentId) ?? {
      displayName: agent.displayName,
      entityKind: agent.entityKind,
      rawAgentIds: new Set<string>(),
      totalEvents: 0,
      completed: 0,
      failed: 0,
      runsCompleted: 0,
      runsFailed: 0,
      toolCalls: 0,
      toolFailures: 0,
      tokensUsed: 0,
      costUsd: 0,
      latencies: [],
    };

    row.totalEvents += 1;
    if (doc.agentId) row.rawAgentIds.add(doc.agentId);
    if (doc.type === 'task_completed') row.completed += 1;
    if (doc.type === 'task_failed') {
      row.failed += 1;
      if (doc.errorMessage) row.lastError = doc.errorMessage;
    }
    if (doc.type === 'run_completed') row.runsCompleted += 1;
    if (doc.type === 'run_failed') {
      row.runsFailed += 1;
      if (doc.errorMessage) row.lastError = doc.errorMessage;
    }
    if (doc.type === 'tool_called' || doc.type === 'tool_call_completed') row.toolCalls += 1;
    if (doc.type === 'tool_error' || doc.type === 'tool_call_failed') {
      row.toolFailures += 1;
      if (doc.errorMessage) row.lastError = doc.errorMessage;
    }
    if (doc.durationMs && doc.durationMs > 0) row.latencies.push(doc.durationMs);
    if (doc.model && doc.tokenUsage) {
      const tokens = tokensOf(doc.tokenUsage);
      row.tokensUsed += tokens.total;
      row.costUsd += calculateCost(normalizeModelId(doc.model).model, tokens.prompt, tokens.completion);
    }

    map.set(agent.canonicalAgentId, row);
  }

  return Array.from(map.entries())
    .map(([canonicalAgentId, row]) => {
      const totalTasks = row.completed + row.failed;
      return {
        canonicalAgentId,
        displayName: row.displayName,
        entityKind: row.entityKind,
        rawAgentIds: Array.from(row.rawAgentIds).sort(),
        totalEvents: row.totalEvents,
        totalTasks,
        completed: row.completed,
        failed: row.failed,
        successRate: totalTasks > 0 ? row.completed / totalTasks : 0,
        runsCompleted: row.runsCompleted,
        runsFailed: row.runsFailed,
        toolCalls: row.toolCalls,
        toolFailures: row.toolFailures,
        toolFailureRate: row.toolCalls > 0 ? row.toolFailures / row.toolCalls : 0,
        tokensUsed: row.tokensUsed,
        costUsd: roundMoney(row.costUsd),
        avgLatencyMs: average(row.latencies),
        p50LatencyMs: percentile(row.latencies, 0.5),
        p75LatencyMs: percentile(row.latencies, 0.75),
        p95LatencyMs: percentile(row.latencies, 0.95),
        p99LatencyMs: percentile(row.latencies, 0.99),
        maxLatencyMs: max(row.latencies),
        p99ToP50Ratio: ratio(percentile(row.latencies, 0.99), percentile(row.latencies, 0.5)),
        lastError: row.lastError,
      };
    })
    .sort((a, b) => b.totalTasks - a.totalTasks || b.totalEvents - a.totalEvents || b.costUsd - a.costUsd);
}

export async function getDashboardV2Models(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2ModelRollup[]> {
  return cachedDashboardV2(['models', cacheWindow(window), filters], () => getDashboardV2ModelsUncached(window, filters));
}

async function getDashboardV2ModelsUncached(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2ModelRollup[]> {
  const db = await getDb();
  const docs = filterEventDocs(await db.collection<EventDoc>('agent_events')
    .find({
      ...eventWindowQuery(window),
      model: { $exists: true, $ne: null },
    }, {
      projection: {
        _id: 0,
        type: 1,
        agentId: 1,
        model: 1,
        status: 1,
        tokenUsage: 1,
        durationMs: 1,
        errorMessage: 1,
      },
    })
    .toArray(), filters);

  const map = new Map<string, {
    displayName: string;
    rawAliases: Set<string>;
    invocations: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    agents: Set<string>;
    latencies: number[];
    zeroTokenInvocations: number;
    errorEvents: number;
  }>();

  for (const doc of docs) {
    if (!doc.model) continue;
    const normalized = normalizeModelId(doc.model);
    const row = map.get(normalized.model) ?? {
      displayName: normalized.displayName,
      rawAliases: new Set<string>(),
      invocations: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      agents: new Set<string>(),
      latencies: [],
      zeroTokenInvocations: 0,
      errorEvents: 0,
    };
    const tokens = tokensOf(doc.tokenUsage);
    row.rawAliases.add(doc.model);
    row.invocations += 1;
    row.promptTokens += tokens.prompt;
    row.completionTokens += tokens.completion;
    if (tokens.total === 0) row.zeroTokenInvocations += 1;
    if (isErrorEvent(doc)) row.errorEvents += 1;
    row.costUsd += calculateCost(normalized.model, tokens.prompt, tokens.completion);
    if (doc.agentId) row.agents.add(classifyAgentId(doc.agentId).canonicalAgentId);
    if (doc.durationMs && doc.durationMs > 0) row.latencies.push(doc.durationMs);
    map.set(normalized.model, row);
  }

  const rawRows = Array.from(map.entries())
    .map(([model, row]) => {
      const pricing = getModelPricing(model);
      const totalTokens = row.promptTokens + row.completionTokens;
      const rawAliases = Array.from(row.rawAliases).sort();
      return {
        model,
        displayName: row.displayName,
        provider: pricing.provider,
        rawAliases,
        invocations: row.invocations,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens,
        costUsd: roundMoney(row.costUsd),
        costPerInvocationUsd: row.invocations > 0 ? roundMoney(row.costUsd / row.invocations) : 0,
        costPer1kTokensUsd: totalTokens > 0 ? roundMoney((row.costUsd / totalTokens) * 1000) : 0,
        costShare: 0,
        tokenShare: 0,
        zeroTokenInvocations: row.zeroTokenInvocations,
        errorEvents: row.errorEvents,
        errorRate: row.invocations > 0 ? row.errorEvents / row.invocations : 0,
        agents: Array.from(row.agents).sort(),
        pricingStatus: modelPricingStatus({
          provider: pricing.provider,
          totalTokens,
          rawAliases,
          model,
        }),
        avgLatencyMs: average(row.latencies),
        p95LatencyMs: percentile(row.latencies, 0.95),
      };
    });
  const totalCostUsd = rawRows.reduce((sum, row) => sum + row.costUsd, 0);
  const totalTokens = rawRows.reduce((sum, row) => sum + row.totalTokens, 0);

  return rawRows
    .map((row) => ({
      ...row,
      costShare: totalCostUsd > 0 ? row.costUsd / totalCostUsd : 0,
      tokenShare: totalTokens > 0 ? row.totalTokens / totalTokens : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.invocations - a.invocations);
}

export async function getDashboardV2Latency(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2LatencyStats> {
  return cachedDashboardV2(['latency', cacheWindow(window), filters], () => getDashboardV2LatencyUncached(window, filters));
}

async function getDashboardV2LatencyUncached(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2LatencyStats> {
  const db = await getDb();
  const docs = filterEventDocs(await db.collection<EventDoc>('agent_events')
    .find({
      ...eventWindowQuery(window),
      durationMs: { $gt: 0 },
    }, {
      projection: {
        _id: 0,
        eventId: 1,
        type: 1,
        timestamp: 1,
        agentId: 1,
        runId: 1,
        turnId: 1,
        threadId: 1,
        taskId: 1,
        model: 1,
        durationMs: 1,
        errorMessage: 1,
      },
    })
    .toArray(), filters);

  const allLatencies = docs
    .map((doc) => doc.durationMs ?? 0)
    .filter((value) => value > 0);
  const byAgent = new Map<string, {
    displayName: string;
    entityKind: AgentEntityKind;
    latencies: number[];
  }>();

  for (const doc of docs) {
    if (!doc.durationMs || doc.durationMs <= 0) continue;
    const agent = classifyAgentId(doc.agentId);
    const row = byAgent.get(agent.canonicalAgentId) ?? {
      displayName: agent.displayName,
      entityKind: agent.entityKind,
      latencies: [],
    };
    row.latencies.push(doc.durationMs);
    byAgent.set(agent.canonicalAgentId, row);
  }

  return {
    overall: latencySummary(allLatencies),
    byAgent: Array.from(byAgent.entries())
      .map(([canonicalAgentId, row]) => ({
        canonicalAgentId,
        displayName: row.displayName,
        entityKind: row.entityKind,
        ...latencySummary(row.latencies),
      }))
      .sort((a, b) => b.p99Ms - a.p99Ms || b.p95Ms - a.p95Ms)
      .slice(0, 25),
    slowest: docs
      .filter((doc) => Boolean(doc.durationMs && doc.durationMs > 0))
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 25)
      .map((doc) => ({
        eventId: doc.eventId ?? `${doc.type ?? 'event'}:${doc.timestamp?.toISOString() ?? ''}`,
        type: doc.type ?? 'unknown',
        agentId: classifyAgentId(doc.agentId).canonicalAgentId,
        model: doc.model ? normalizeModelId(doc.model).model : undefined,
        durationMs: doc.durationMs ?? 0,
        timestamp: doc.timestamp?.toISOString(),
        runId: doc.runId,
        taskId: doc.taskId,
        threadId: doc.threadId,
        turnId: doc.turnId,
        errorMessage: doc.errorMessage,
      })),
  };
}

export async function getDashboardV2Timeline(
  window: TimeWindow,
  granularity: TimelineGranularity = 'day',
  filters: DashboardV2Filters = {},
): Promise<DashboardV2TimelineStats> {
  return cachedDashboardV2(['timeline', cacheWindow(window), granularity, filters], () => getDashboardV2TimelineUncached(window, granularity, filters));
}

async function getDashboardV2TimelineUncached(
  window: TimeWindow,
  granularity: TimelineGranularity = 'day',
  filters: DashboardV2Filters = {},
): Promise<DashboardV2TimelineStats> {
  const db = await getDb();
  const [rawEventDocs, rawToolDocs] = await Promise.all([
    db.collection<EventDoc>('agent_events')
      .find(eventWindowQuery(window), {
        projection: {
          _id: 0,
          type: 1,
          timestamp: 1,
          agentId: 1,
          model: 1,
          tokenUsage: 1,
          durationMs: 1,
          errorMessage: 1,
          runId: 1,
          taskId: 1,
          threadId: 1,
          turnId: 1,
        },
      })
      .toArray(),
    db.collection<ToolExecutionDoc>('tool_executions')
      .find(toolWindowQuery(window), {
        projection: {
          _id: 0,
          id: 1,
          toolId: 1,
          status: 1,
          risk: 1,
          policyDecision: 1,
          createdAt: 1,
          completedAt: 1,
          errorClass: 1,
          errorMessage: 1,
          agentId: 1,
          category: 1,
          runId: 1,
          taskId: 1,
          threadId: 1,
          turnId: 1,
        },
      })
      .toArray(),
  ]);
  const eventDocs = filterEventDocs(rawEventDocs, filters);
  const toolDocs = filterToolDocs(rawToolDocs, filters);

  const buckets = initializeTimelineBuckets(window, granularity);
  const annotationMap = new Map<string, DashboardV2TimelineStats['annotations'][number]>();

  for (const doc of eventDocs) {
    if (!doc.timestamp) continue;
    const bucket = bucketKey(doc.timestamp, granularity);
    const row = ensureTimelineBucket(buckets, bucket);
    const type = doc.type ?? 'unknown';

    row.events += 1;
    if (type === 'task_started') row.taskStarted += 1;
    if (type === 'task_completed') row.taskCompleted += 1;
    if (type === 'task_failed') {
      row.taskFailed += 1;
      addTimelineAnnotation(annotationMap, bucket, 'task_failed', 'warning', 'Task failures', doc.errorMessage ?? doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'run_completed') row.runsCompleted += 1;
    if (type === 'run_failed') {
      row.runsFailed += 1;
      addTimelineAnnotation(annotationMap, bucket, 'run_failed', 'critical', 'Run failures', doc.errorMessage ?? doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'tool_error' || type === 'tool_call_failed') {
      row.toolFailed += 1;
      addTimelineAnnotation(annotationMap, bucket, 'tool_failed', 'warning', 'Tool failures', doc.errorMessage ?? doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'policy_blocked') {
      row.policyBlocked += 1;
      addTimelineAnnotation(annotationMap, bucket, 'policy_blocked', 'warning', 'Policy blocks', doc.errorMessage ?? doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    // `policy_flagged` is an un-enforced (log_only) verdict: the call RAN, so it
    // must not inflate `policyBlocked` the way it did while both shared the
    // `policy_blocked` type. Surfaced separately so the advisory signal stays
    // visible without being mistaken for a guardrail that held.
    if (type === 'policy_flagged') {
      addTimelineAnnotation(annotationMap, bucket, 'policy_flagged', 'info', 'Policy flags (not enforced)', doc.errorMessage ?? doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'approval_requested' || type === 'approval_gate_started') {
      row.approvalGates += 1;
      addTimelineAnnotation(annotationMap, bucket, 'approval_gate', 'info', 'Approval gates', doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'worker_alert') {
      row.workerAlerts += 1;
      addTimelineAnnotation(annotationMap, bucket, 'worker_alert', 'warning', 'Worker alerts', doc.errorMessage ?? doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'reflector_intervention' || type === 'pipeline_reflector_intervention') {
      row.reflectorInterventions += 1;
      addTimelineAnnotation(annotationMap, bucket, 'reflector_intervention', 'info', 'Reflector interventions', doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'reflection_repair_started' || type === 'reflection_repair_completed' || type === 'reflection_repair_failed') {
      row.reflectionRepairs += 1;
      addTimelineAnnotation(annotationMap, bucket, 'reflection_repair', type.endsWith('_failed') ? 'critical' : 'info', 'Reflection repairs', doc.errorMessage ?? doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'autoheal_triggered' || type === 'autoheal_resolved') {
      row.autohealEvents += 1;
      addTimelineAnnotation(annotationMap, bucket, 'autoheal', type === 'autoheal_triggered' ? 'warning' : 'info', 'Autoheal events', doc.agentId ?? undefined, traceKeyFromEvent(doc));
    }
    if (type === 'output_score' || type === 'goal_completion_evaluated') row.outputScores += 1;

    if (doc.durationMs && doc.durationMs > 0) row.latencies.push(doc.durationMs);
    if (doc.model && doc.tokenUsage) {
      const tokens = tokensOf(doc.tokenUsage);
      row.tokens += tokens.total;
      row.costUsd += calculateCost(normalizeModelId(doc.model).model, tokens.prompt, tokens.completion);
    }
  }

  for (const doc of toolDocs) {
    const date = doc.completedAt ?? doc.createdAt;
    if (!date) continue;
    const bucket = bucketKey(date, granularity);
    const row = ensureTimelineBucket(buckets, bucket);
    const status = doc.status ?? 'unknown';
    const decisions = flattenPolicyDecision(doc.policyDecision);

    if (status === 'failed') {
      row.toolFailed += 1;
      addTimelineAnnotation(annotationMap, bucket, 'tool_failed', 'warning', 'Tool envelope failures', doc.errorMessage ?? doc.errorClass ?? doc.toolId, traceKeyFromTool(doc));
    }
    if (status === 'blocked') {
      row.toolBlocked += 1;
      addTimelineAnnotation(annotationMap, bucket, 'tool_blocked', doc.risk === 'high' ? 'critical' : 'warning', 'Tool envelope blocks', doc.errorMessage ?? doc.errorClass ?? doc.toolId, traceKeyFromTool(doc));
      if (doc.risk === 'high') row.highRiskBlocked += 1;
    }
    if (decisions.some((entry) => entry.effectiveAllow === false)) {
      row.policyBlocked += 1;
      addTimelineAnnotation(annotationMap, bucket, 'policy_blocked', 'warning', 'Policy blocks', doc.toolId, traceKeyFromTool(doc));
    }
    if (decisions.some((entry) => entry.requiresApproval === true)) {
      row.approvalGates += 1;
      addTimelineAnnotation(annotationMap, bucket, 'approval_gate', 'info', 'Approval gates', doc.toolId, traceKeyFromTool(doc));
    }
  }

  return {
    granularity,
    buckets: Array.from(buckets.values())
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((row) => ({
        bucket: row.bucket,
        events: row.events,
        taskStarted: row.taskStarted,
        taskCompleted: row.taskCompleted,
        taskFailed: row.taskFailed,
        runsCompleted: row.runsCompleted,
        runsFailed: row.runsFailed,
        toolFailed: row.toolFailed,
        toolBlocked: row.toolBlocked,
        highRiskBlocked: row.highRiskBlocked,
        policyBlocked: row.policyBlocked,
        approvalGates: row.approvalGates,
        workerAlerts: row.workerAlerts,
        reflectorInterventions: row.reflectorInterventions,
        reflectionRepairs: row.reflectionRepairs,
        autohealEvents: row.autohealEvents,
        outputScores: row.outputScores,
        tokens: row.tokens,
        costUsd: roundMoney(row.costUsd),
        avgLatencyMs: average(row.latencies),
        p95LatencyMs: percentile(row.latencies, 0.95),
      })),
    annotations: Array.from(annotationMap.values())
      .sort((a, b) => a.bucket.localeCompare(b.bucket) || severityRank(b.severity) - severityRank(a.severity) || b.count - a.count),
  };
}

export async function getDashboardV2Quality(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2QualityStats> {
  return cachedDashboardV2(['quality', cacheWindow(window), filters], () => getDashboardV2QualityUncached(window, filters));
}

async function getDashboardV2QualityUncached(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2QualityStats> {
  const [current, previous] = await Promise.all([
    getDashboardV2QualityCoreCached(window, filters),
    getDashboardV2QualityCoreCached(previousTimeWindow(window), filters),
  ]);
  const previousWindow = previousTimeWindow(window);

  return {
    ...current,
    trend: {
      previousWindow: toWindowDto(previousWindow),
      taskCoverage: metricDelta(current.coverage.taskCoverage, previous.coverage.taskCoverage),
      passRate: metricDelta(current.outcome.passRate, previous.outcome.passRate),
      avgScore: metricDelta(current.outcome.avgScore, previous.outcome.avgScore),
      evaluated: metricDelta(current.outcome.evaluated, previous.outcome.evaluated),
    },
  };
}

async function getDashboardV2QualityCoreCached(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2QualityStats> {
  return cachedDashboardV2(['quality-core', cacheWindow(window), filters], () => getDashboardV2QualityCore(window, filters));
}

export async function getDashboardV2Traces(
  window: TimeWindow,
  params: DashboardV2TraceParams,
): Promise<DashboardV2TraceList> {
  return cachedDashboardV2(['traces', cacheWindow(window), params], () => getDashboardV2TracesUncached(window, params));
}

async function getDashboardV2TracesUncached(
  window: TimeWindow,
  params: DashboardV2TraceParams,
): Promise<DashboardV2TraceList> {
  const db = await getDb();
  const [rawEvents, rawTools, rawNativeScorers] = await Promise.all([
    db.collection<EventDoc>('agent_events')
      .find(traceEventQuery(window, params), {
        projection: {
          _id: 0,
          eventId: 1,
          type: 1,
          timestamp: 1,
          agentId: 1,
          runId: 1,
          turnId: 1,
          threadId: 1,
          taskId: 1,
          model: 1,
          status: 1,
          durationMs: 1,
          tokenUsage: 1,
          errorMessage: 1,
          toolId: 1,
          data: 1,
          metadata: 1,
        },
      })
      .sort({ timestamp: -1 })
      .limit(Math.max(params.limit * 80, 1000))
      .toArray(),
    db.collection<ToolExecutionDoc>('tool_executions')
      .find(traceToolQuery(window, params), {
        projection: {
          _id: 0,
          id: 1,
          toolId: 1,
          status: 1,
          category: 1,
          risk: 1,
          durationMs: 1,
          errorClass: 1,
          errorMessage: 1,
          agentId: 1,
          runId: 1,
          taskId: 1,
          threadId: 1,
          turnId: 1,
          createdAt: 1,
          completedAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(Math.max(params.limit * 20, 250))
      .toArray(),
    db.collection<ScorerDoc>('mastra_scorers')
      .find(traceNativeScorerQuery(window, params), {
        projection: {
          _id: 0,
          scorerId: 1,
          score: 1,
          entityId: 1,
          agentId: 1,
          taskId: 1,
          createdAt: 1,
          metadata: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(Math.max(params.limit * 10, 100))
      .toArray(),
  ]);

  const events = filterEventDocs(rawEvents, params);
  const tools = filterToolDocs(rawTools, params);
  const nativeScorers = rawNativeScorers.filter((doc) => scorerMatchesFilters(doc, params));
  const accumulators = buildTraceAccumulators(events, tools, nativeScorers);
  const summaries = Array.from(accumulators.values())
    .map(traceSummaryFromAccumulator)
    .filter((summary) => !params.status || summary.status === params.status)
    .sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));

  return {
    traces: summaries.slice(0, params.limit),
    limit: params.limit,
    hasMore: summaries.length > params.limit,
  };
}

export async function getDashboardV2TraceDetail(
  window: TimeWindow,
  traceId: string,
  params: DashboardV2TraceParams,
): Promise<DashboardV2TraceDetail | null> {
  return cachedDashboardV2(['trace-detail', cacheWindow(window), traceId, params], () => getDashboardV2TraceDetailUncached(window, traceId, params));
}

async function getDashboardV2TraceDetailUncached(
  window: TimeWindow,
  traceId: string,
  params: DashboardV2TraceParams,
): Promise<DashboardV2TraceDetail | null> {
  const db = await getDb();
  const seedEvents = await db.collection<EventDoc>('agent_events')
    .find({
      $and: [
        eventWindowQuery(window),
        { $or: traceIdClauses(traceId) },
      ],
    }, {
      projection: {
        _id: 0,
        eventId: 1,
        type: 1,
        timestamp: 1,
        agentId: 1,
        runId: 1,
        turnId: 1,
        threadId: 1,
        taskId: 1,
        model: 1,
        status: 1,
        durationMs: 1,
        tokenUsage: 1,
        errorMessage: 1,
        toolId: 1,
        data: 1,
        metadata: 1,
      },
    })
    .sort({ timestamp: 1 })
    .limit(500)
    .toArray();

  const idSet = traceScopeIds(seedEvents, traceId);
  const [rawEvents, rawTools, rawNativeScorers] = await Promise.all([
    db.collection<EventDoc>('agent_events')
      .find({
        $and: [
          eventWindowQuery(window),
          { $or: traceIdClausesFromSet(idSet) },
        ],
      }, {
        projection: {
          _id: 0,
          eventId: 1,
          type: 1,
          timestamp: 1,
          agentId: 1,
          runId: 1,
          turnId: 1,
          threadId: 1,
          taskId: 1,
          model: 1,
          status: 1,
          durationMs: 1,
          tokenUsage: 1,
          errorMessage: 1,
          toolId: 1,
          data: 1,
          metadata: 1,
        },
      })
      .sort({ timestamp: 1 })
      .limit(500)
      .toArray(),
    db.collection<ToolExecutionDoc>('tool_executions')
      .find({
        $and: [
          toolWindowQuery(window),
          { $or: traceToolIdClausesFromSet(idSet) },
        ],
      }, {
        projection: {
          _id: 0,
          id: 1,
          toolId: 1,
          status: 1,
          category: 1,
          risk: 1,
          durationMs: 1,
          errorClass: 1,
          errorMessage: 1,
          inputPreview: 1,
          outputPreview: 1,
          outputArtifactId: 1,
          agentId: 1,
          runId: 1,
          taskId: 1,
          threadId: 1,
          turnId: 1,
          createdAt: 1,
          completedAt: 1,
        },
      })
      .sort({ createdAt: 1 })
      .limit(250)
      .toArray(),
    db.collection<ScorerDoc>('mastra_scorers')
      .find({
        createdAt: { $gte: window.from, $lt: window.to },
        $or: [
          { taskId: { $in: Array.from(idSet) } },
          { entityId: { $in: Array.from(idSet) } },
        ],
      }, {
        projection: {
          _id: 0,
          scorerId: 1,
          score: 1,
          entityId: 1,
          agentId: 1,
          taskId: 1,
          createdAt: 1,
          reason: 1,
          metadata: 1,
        },
      })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray(),
  ]);

  const events = filterEventDocs(rawEvents, params);
  const tools = filterToolDocs(rawTools, params);
  const nativeScorers = rawNativeScorers.filter((doc) => scorerMatchesFilters(doc, params));

  if (!events.length && !tools.length && !nativeScorers.length) return null;

  const accumulators = buildTraceAccumulators(events, tools, nativeScorers, true);
  const summary = traceSummaryFromAccumulator(
    accumulators.get(traceId)
      ?? Array.from(accumulators.values())[0]
      ?? buildTraceAccumulator(traceId),
  );

  return {
    summary,
    events: events
      .sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0))
      .map(toTraceEvent),
    tools: tools
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
      .map(toTraceTool),
    scores: traceScores(events, nativeScorers),
  };
}

async function getDashboardV2QualityCore(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2QualityStats> {
  const db = await getDb();
  const [rawTaskDocs, rawNativeScorers, rawOutputScores, rawGoalEvaluations] = await Promise.all([
    db.collection<EventDoc>('agent_events')
      .find({
        ...eventWindowQuery(window),
        type: { $in: ['task_completed', 'task_failed'] },
      }, {
        projection: {
          _id: 0,
          eventId: 1,
          type: 1,
          timestamp: 1,
          agentId: 1,
          runId: 1,
          threadId: 1,
          taskId: 1,
          model: 1,
        },
      })
      .toArray(),
    db.collection<ScorerDoc>('mastra_scorers')
      .find({
        createdAt: { $gte: window.from, $lt: window.to },
      }, {
        projection: {
          _id: 0,
          scorerId: 1,
          score: 1,
          entityId: 1,
          entityType: 1,
          agentId: 1,
          taskId: 1,
          createdAt: 1,
          reason: 1,
          metadata: 1,
        },
      })
      .toArray(),
    db.collection<EventDoc>('agent_events')
      .find({
        ...eventWindowQuery(window),
        type: 'output_score',
      }, {
        projection: {
          _id: 0,
          timestamp: 1,
          agentId: 1,
          taskId: 1,
          runId: 1,
          threadId: 1,
          model: 1,
          data: 1,
          metadata: 1,
        },
      })
      .toArray(),
    db.collection<EventDoc>('agent_events')
      .find({
        ...eventWindowQuery(window),
        type: 'goal_completion_evaluated',
      }, {
        projection: {
          _id: 0,
          timestamp: 1,
          agentId: 1,
          taskId: 1,
          runId: 1,
          threadId: 1,
          model: 1,
          data: 1,
          metadata: 1,
        },
      })
      .toArray(),
  ]);
  const taskDocs = filterEventDocs(rawTaskDocs, filters);
  const nativeScorers = rawNativeScorers.filter((doc) => scorerMatchesFilters(doc, filters));
  const outputScores = filterEventDocs(rawOutputScores, filters);
  const goalEvaluations = rawGoalEvaluations.filter((doc) => goalEvaluationMatchesFilters(doc, filters));

  const taskAgentMap = new Map<string, string>();
  const taskKeysByAgent = new Map<string, Set<string>>();

  for (const doc of taskDocs) {
    const agentId = classifyAgentId(doc.agentId).canonicalAgentId;
    const key = qualityTaskKey(doc);
    if (!key) continue;
    taskAgentMap.set(key, agentId);
    const set = taskKeysByAgent.get(agentId) ?? new Set<string>();
    set.add(key);
    taskKeysByAgent.set(agentId, set);
  }

  const records: QualityScoreRecord[] = [];
  const nativeScoredTasks = new Set<string>();
  const outputScoredTasks = new Set<string>();
  const goalScoredTasks = new Set<string>();

  for (const doc of nativeScorers) {
    const score = normalizeScore(doc.score);
    if (score === undefined) continue;
    const taskId = doc.taskId ?? doc.entityId;
    if (taskId) nativeScoredTasks.add(taskId);
    const agentId = classifyAgentId(doc.agentId ?? (taskId ? taskAgentMap.get(taskId) : undefined)).canonicalAgentId;
    records.push({
      source: 'mastra_scorers',
      scorerId: doc.scorerId ?? doc.metadata?.scorerId ?? 'native_scorer',
      agentId,
      taskId,
      score,
      passed: score >= 0.7,
      timestamp: doc.createdAt,
      reason: qualityReason(doc.reason, doc.metadata),
    });
  }

  for (const doc of outputScores) {
    const taskId = qualityTaskKey(doc);
    if (taskId) outputScoredTasks.add(taskId);
    const complete = doc.data?.complete;
    const score = typeof complete === 'boolean' ? (complete ? 1 : 0) : normalizeScore(doc.data?.score) ?? 0;
    records.push({
      source: 'output_score',
      scorerId: 'Goal output completion',
      agentId: classifyAgentId(doc.agentId ?? (taskId ? taskAgentMap.get(taskId) : undefined)).canonicalAgentId,
      taskId,
      score,
      passed: typeof complete === 'boolean' ? complete : score >= 0.7,
      timestamp: doc.timestamp,
      reason: qualityReason(doc.data?.completionReason, doc.data),
    });
  }

  for (const doc of goalEvaluations) {
    const taskId = stringValue(doc.data?.taskId) ?? qualityTaskKey(doc) ?? stringValue(doc.data?.contractId);
    if (taskId) goalScoredTasks.add(taskId);
    const numericScore = normalizeScore(doc.data?.score);
    const passed = typeof doc.data?.passed === 'boolean' ? doc.data.passed : (numericScore ?? 0) >= 0.7;
    const score = numericScore ?? (passed ? 1 : 0);
    const targetAgent = stringValue(doc.data?.targetAgent);
    records.push({
      source: 'goal_completion',
      scorerId: 'Goal completion gate',
      agentId: classifyAgentId(targetAgent ?? doc.agentId ?? (taskId ? taskAgentMap.get(taskId) : undefined)).canonicalAgentId,
      taskId,
      score,
      passed,
      timestamp: doc.timestamp,
      reason: goalQualityReason(doc.data),
    });
  }

  const allScoredTasks = new Set<string>([
    ...nativeScoredTasks,
    ...outputScoredTasks,
    ...goalScoredTasks,
  ]);
  const totalTasks = taskDocs.length;
  const scoredTasks = Math.min(allScoredTasks.size, totalTasks);

  const distribution = buildScoreDistribution(records);
  const scorerSummaries = buildScorerSummaries(records);
  const byAgent = buildQualityByAgent(taskKeysByAgent, records, taskAgentMap);
  const recentFailures = records
    .filter((record) => !record.passed)
    .sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0))
    .slice(0, 25)
    .map((record) => ({
      source: record.source,
      scorerId: record.scorerId,
      agentId: record.agentId,
      taskId: record.taskId,
      score: roundScore(record.score),
      passed: record.passed,
      timestamp: record.timestamp?.toISOString(),
      reason: record.reason ? truncateSample(record.reason) : undefined,
    }));

  return {
    totals: {
      tasks: totalTasks,
      scoredTasks,
      nativeScorerRecords: nativeScorers.length,
      outputScoreEvents: outputScores.length,
      goalEvaluations: goalEvaluations.length,
    },
    coverage: {
      taskCoverage: totalTasks > 0 ? scoredTasks / totalTasks : 0,
      nativeScorerCoverage: totalTasks > 0 ? Math.min(nativeScoredTasks.size, totalTasks) / totalTasks : 0,
      outputScoreCoverage: totalTasks > 0 ? Math.min(outputScoredTasks.size, totalTasks) / totalTasks : 0,
      goalEvaluationCoverage: totalTasks > 0 ? Math.min(goalScoredTasks.size, totalTasks) / totalTasks : 0,
    },
    outcome: {
      avgScore: averageScore(records),
      passRate: records.length > 0 ? records.filter((record) => record.passed).length / records.length : 0,
      passed: records.filter((record) => record.passed).length,
      failed: records.filter((record) => !record.passed).length,
      evaluated: records.length,
    },
    distribution,
    scorerSummaries,
    byAgent,
    recentFailures,
    coverageGaps: byAgent
      .filter((row) => row.tasks > 0 && row.coverage < 0.2)
      .sort((a, b) => b.tasks - a.tasks || a.coverage - b.coverage)
      .slice(0, 15)
      .map((row) => ({
        agentId: row.agentId,
        tasks: row.tasks,
        scoredTasks: row.scoredTasks,
        coverage: row.coverage,
      })),
  };
}

export async function getDashboardV2Tools(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2ToolStats> {
  return cachedDashboardV2(['tools', cacheWindow(window), filters], () => getDashboardV2ToolsUncached(window, filters));
}

async function getDashboardV2ToolsUncached(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2ToolStats> {
  const db = await getDb();
  const docs = filterToolDocs(await db.collection<ToolExecutionDoc>('tool_executions')
    .find(toolWindowQuery(window), {
      projection: {
        _id: 0,
        id: 1,
        toolId: 1,
        category: 1,
        risk: 1,
        status: 1,
        policyDecision: 1,
        durationMs: 1,
        errorClass: 1,
        errorMessage: 1,
        agentId: 1,
        createdAt: 1,
        completedAt: 1,
        runId: 1,
        taskId: 1,
        threadId: 1,
      },
    })
    .toArray(), filters);

  const byStatus = new Map<string, number>();
  const byCategory = new Map<string, { count: number; failed: number; blocked: number; durations: number[] }>();
  const byRisk = new Map<string, { count: number; failed: number; blocked: number }>();
  const byTool = new Map<string, {
    count: number;
    failed: number;
    blocked: number;
    durations: number[];
    categories: Set<string>;
    risks: Set<string>;
  }>();
  const byFailure = new Map<string, { toolId: string; errorClass: string; count: number; lastError?: string }>();
  const hangingStarted: DashboardV2ToolStats['hangingStarted'] = [];

  let policyBlocked = 0;
  let requiresApproval = 0;
  let highRiskBlocked = 0;
  const now = Date.now();

  for (const doc of docs) {
    const toolId = doc.toolId ?? 'unknown';
    const status = doc.status ?? 'unknown';
    const category = doc.category ?? 'other';
    const risk = doc.risk ?? 'unknown';
    const failed = status === 'failed';
    const blocked = status === 'blocked';
    const duration = doc.durationMs && doc.durationMs > 0 ? doc.durationMs : undefined;

    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

    const categoryRow = byCategory.get(category) ?? { count: 0, failed: 0, blocked: 0, durations: [] };
    categoryRow.count += 1;
    if (failed) categoryRow.failed += 1;
    if (blocked) categoryRow.blocked += 1;
    if (duration) categoryRow.durations.push(duration);
    byCategory.set(category, categoryRow);

    const riskRow = byRisk.get(risk) ?? { count: 0, failed: 0, blocked: 0 };
    riskRow.count += 1;
    if (failed) riskRow.failed += 1;
    if (blocked) riskRow.blocked += 1;
    byRisk.set(risk, riskRow);

    const toolRow = byTool.get(toolId) ?? {
      count: 0,
      failed: 0,
      blocked: 0,
      durations: [],
      categories: new Set<string>(),
      risks: new Set<string>(),
    };
    toolRow.count += 1;
    if (failed) toolRow.failed += 1;
    if (blocked) toolRow.blocked += 1;
    if (duration) toolRow.durations.push(duration);
    toolRow.categories.add(category);
    toolRow.risks.add(risk);
    byTool.set(toolId, toolRow);

    const decisions = flattenPolicyDecision(doc.policyDecision);
    if (decisions.some((entry) => entry.effectiveAllow === false)) policyBlocked += 1;
    if (decisions.some((entry) => entry.requiresApproval === true)) requiresApproval += 1;
    if (blocked && risk === 'high') highRiskBlocked += 1;

    if ((failed || blocked) && doc.errorClass) {
      const key = `${toolId}:${doc.errorClass}`;
      const failure = byFailure.get(key) ?? { toolId, errorClass: doc.errorClass, count: 0 };
      failure.count += 1;
      if (doc.errorMessage) failure.lastError = doc.errorMessage;
      byFailure.set(key, failure);
    }

    if (status === 'started' && doc.createdAt) {
      const ageMs = now - doc.createdAt.getTime();
      if (ageMs > 5 * 60_000) {
        hangingStarted.push({
          id: doc.id ?? toolId,
          toolId,
          agentId: doc.agentId,
          ageMs,
          createdAt: doc.createdAt.toISOString(),
          runId: doc.runId,
          taskId: doc.taskId,
          threadId: doc.threadId,
        });
      }
    }
  }

  return {
    totalExecutions: docs.length,
    byStatus: Array.from(byStatus.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    byCategory: Array.from(byCategory.entries())
      .map(([category, row]) => ({
        category,
        count: row.count,
        failed: row.failed,
        blocked: row.blocked,
        avgDurationMs: average(row.durations),
      }))
      .sort((a, b) => b.count - a.count),
    byRisk: Array.from(byRisk.entries())
      .map(([risk, row]) => ({ risk, count: row.count, failed: row.failed, blocked: row.blocked }))
      .sort((a, b) => b.count - a.count),
    topTools: Array.from(byTool.entries())
      .map(([toolId, row]) => ({
        toolId,
        count: row.count,
        failed: row.failed,
        blocked: row.blocked,
        failureRate: row.count > 0 ? (row.failed + row.blocked) / row.count : 0,
        avgDurationMs: average(row.durations),
        categories: Array.from(row.categories).sort(),
        risks: Array.from(row.risks).sort(),
      }))
      .sort((a, b) => (b.failed + b.blocked) - (a.failed + a.blocked) || b.count - a.count)
      .slice(0, 25),
    topFailures: Array.from(byFailure.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    policy: {
      blocked: policyBlocked,
      requiresApproval,
      highRiskBlocked,
    },
    hangingStarted: hangingStarted.sort((a, b) => b.ageMs - a.ageMs).slice(0, 25),
  };
}

export async function getDashboardV2Skills(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2SkillStats> {
  return cachedDashboardV2(['skills', cacheWindow(window), filters], () => getDashboardV2SkillsUncached(window, filters));
}

async function getDashboardV2SkillsUncached(
  window: TimeWindow,
  filters: DashboardV2Filters = {},
): Promise<DashboardV2SkillStats> {
  const db = await getDb();
  const [rawToolDocs, legacyEvents] = await Promise.all([
    db.collection<ToolExecutionDoc>('tool_executions')
      .find({
        ...toolWindowQuery(window),
        toolId: { $regex: /^skill_/ },
      }, {
        projection: {
          _id: 0,
          toolId: 1,
          status: 1,
          category: 1,
          risk: 1,
          agentId: 1,
          durationMs: 1,
        },
      })
      .toArray(),
    db.collection<EventDoc>('agent_events').find({
        type: 'skill_used',
        timestamp: { $gte: window.from, $lt: window.to },
      }, {
        projection: {
          _id: 0,
          toolId: 1,
          metadata: 1,
          agentId: 1,
          model: 1,
        },
      }).toArray(),
  ]);
  const toolDocs = filterToolDocs(rawToolDocs, filters);
  const legacyRows = aggregateLegacySkillEvents(filterEventDocs(legacyEvents, filters));

  const byOperation = new Map<string, { count: number; failed: number; blocked: number; durations: number[] }>();
  const byTool = new Map<string, { count: number; failed: number; blocked: number; durations: number[] }>();

  for (const doc of toolDocs) {
    const toolId = doc.toolId ?? 'skill_unknown';
    const operation = toolId.replace(/^skill_/, '') || 'unknown';
    const failed = doc.status === 'failed';
    const blocked = doc.status === 'blocked';
    const duration = doc.durationMs && doc.durationMs > 0 ? doc.durationMs : undefined;

    const operationRow = byOperation.get(operation) ?? { count: 0, failed: 0, blocked: 0, durations: [] };
    operationRow.count += 1;
    if (failed) operationRow.failed += 1;
    if (blocked) operationRow.blocked += 1;
    if (duration) operationRow.durations.push(duration);
    byOperation.set(operation, operationRow);

    const toolRow = byTool.get(toolId) ?? { count: 0, failed: 0, blocked: 0, durations: [] };
    toolRow.count += 1;
    if (failed) toolRow.failed += 1;
    if (blocked) toolRow.blocked += 1;
    if (duration) toolRow.durations.push(duration);
    byTool.set(toolId, toolRow);
  }

  return {
    totalOperations: toolDocs.length,
    byOperation: Array.from(byOperation.entries())
      .map(([operation, row]) => ({
        operation,
        count: row.count,
        failed: row.failed,
        blocked: row.blocked,
        avgDurationMs: average(row.durations),
      }))
      .sort((a, b) => b.count - a.count),
    topSkillTools: Array.from(byTool.entries())
      .map(([toolId, row]) => ({
        toolId,
        count: row.count,
        failed: row.failed,
        blocked: row.blocked,
        failureRate: row.count > 0 ? (row.failed + row.blocked) / row.count : 0,
        avgDurationMs: average(row.durations),
      }))
      .sort((a, b) => b.count - a.count),
    legacySkillUsed: legacyRows.map((row) => ({
      skillId: row._id as string,
      uses: row.uses as number,
      agents: ((row.agents ?? []) as string[]).filter(Boolean),
    })),
  };
}

function eventWindowQuery(window: TimeWindow): Record<string, unknown> {
  return {
    timestamp: { $gte: window.from, $lt: window.to },
    ...EXCLUDE_CHECK_HARNESS_TASKS,
  };
}

// `check:*` scripts (the check:all gate) exercise real agent code paths —
// including deliberately unsafe/incomplete inputs meant to be blocked — and
// their events land in this same collection. Every `check:all` run recorded
// its negative-path assertions as `task_failed`, which is the check passing,
// not the agent breaking; the dashboard has no way to tell the two apart
// without this. Gate scripts namespace their taskId/automationId with
// `check-` for exactly this reason (see e.g. check-automation-golden-path.ts,
// check-automation-autonomy.ts, check-n8n-mcp-pipeline-smoke.ts); no
// production caller ever sets that prefix.
const EXCLUDE_CHECK_HARNESS_TASKS: Record<string, unknown> = {
  taskId: { $not: /^check-/ },
};

function initializeTimelineBuckets(window: TimeWindow, granularity: TimelineGranularity): Map<string, DashboardV2TimelineBucketMutable> {
  const buckets = new Map<string, DashboardV2TimelineBucketMutable>();
  const cursor = truncateDate(window.from, granularity);
  const end = truncateDate(window.to, granularity);
  const stepMs = granularity === 'hour' ? 3_600_000 : 86_400_000;

  for (let time = cursor.getTime(); time <= end.getTime(); time += stepMs) {
    const bucket = new Date(time).toISOString();
    buckets.set(bucket, emptyTimelineBucket(bucket));
  }

  return buckets;
}

function ensureTimelineBucket(
  buckets: Map<string, DashboardV2TimelineBucketMutable>,
  bucket: string,
): DashboardV2TimelineBucketMutable {
  const existing = buckets.get(bucket);
  if (existing) return existing;
  const row = emptyTimelineBucket(bucket);
  buckets.set(bucket, row);
  return row;
}

function emptyTimelineBucket(bucket: string): DashboardV2TimelineBucketMutable {
  return {
    bucket,
    events: 0,
    taskStarted: 0,
    taskCompleted: 0,
    taskFailed: 0,
    runsCompleted: 0,
    runsFailed: 0,
    toolFailed: 0,
    toolBlocked: 0,
    highRiskBlocked: 0,
    policyBlocked: 0,
    approvalGates: 0,
    workerAlerts: 0,
    reflectorInterventions: 0,
    reflectionRepairs: 0,
    autohealEvents: 0,
    outputScores: 0,
    tokens: 0,
    costUsd: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    latencies: [],
  };
}

function bucketKey(date: Date, granularity: TimelineGranularity): string {
  return truncateDate(date, granularity).toISOString();
}

function truncateDate(date: Date, granularity: TimelineGranularity): Date {
  return granularity === 'hour'
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()))
    : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addTimelineAnnotation(
  annotations: Map<string, DashboardV2TimelineStats['annotations'][number]>,
  bucket: string,
  type: string,
  severity: DashboardV2TimelineStats['annotations'][number]['severity'],
  label: string,
  sample?: string,
  traceId?: string,
): void {
  const key = `${bucket}:${type}`;
  const existing = annotations.get(key);
  if (existing) {
    existing.count += 1;
    if (!existing.sample && sample) existing.sample = truncateSample(sample);
    if (!existing.traceId && traceId) existing.traceId = traceId;
    if (severityRank(severity) > severityRank(existing.severity)) existing.severity = severity;
    return;
  }

  annotations.set(key, {
    bucket,
    type,
    severity,
    label,
    count: 1,
    sample: sample ? truncateSample(sample) : undefined,
    traceId: traceId || undefined,
  });
}

function truncateSample(value: string, maxLength = 220): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function cachedDashboardV2<T>(parts: unknown[], loader: () => Promise<T>): Promise<T> {
  if (DASHBOARD_V2_CACHE_TTL_MS <= 0) return loader();
  const key = parts.map(stableCacheStringify).join('|');
  const now = Date.now();
  const existing = dashboardV2Cache.get(key) as DashboardV2CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = loader().catch((err) => {
    const current = dashboardV2Cache.get(key);
    if (current?.promise === promise) dashboardV2Cache.delete(key);
    throw err;
  });
  dashboardV2Cache.set(key, { expiresAt: now + DASHBOARD_V2_CACHE_TTL_MS, promise });
  pruneDashboardV2Cache(now);
  return promise;
}

function pruneDashboardV2Cache(now = Date.now()): void {
  for (const [key, entry] of dashboardV2Cache.entries()) {
    if (entry.expiresAt <= now) dashboardV2Cache.delete(key);
  }
  while (dashboardV2Cache.size > DASHBOARD_V2_CACHE_MAX_ENTRIES) {
    const oldestKey = dashboardV2Cache.keys().next().value;
    if (!oldestKey) break;
    dashboardV2Cache.delete(oldestKey);
  }
}

function stableCacheStringify(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(stableCacheStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${key}:${stableCacheStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cacheWindow(window: TimeWindow): Record<string, string> {
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
  };
}

function parseEnvInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function traceEventQuery(window: TimeWindow, params: DashboardV2TraceParams): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [eventWindowQuery(window)];
  const idClauses = traceParamClauses(params);
  if (idClauses.length) clauses.push({ $or: idClauses });
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

function traceToolQuery(window: TimeWindow, params: DashboardV2TraceParams): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [toolWindowQuery(window)];
  const idClauses = traceToolParamClauses(params);
  if (idClauses.length) clauses.push({ $or: idClauses });
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

function traceNativeScorerQuery(window: TimeWindow, params: DashboardV2TraceParams): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [{ createdAt: { $gte: window.from, $lt: window.to } }];
  if (params.taskId) {
    clauses.push({ $or: [{ taskId: params.taskId }, { entityId: params.taskId }] });
  }
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

function traceParamClauses(params: DashboardV2TraceParams): Array<Record<string, string>> {
  const clauses: Array<Record<string, string>> = [];
  if (params.runId) clauses.push({ runId: params.runId });
  if (params.taskId) clauses.push({ taskId: params.taskId });
  if (params.threadId) clauses.push({ threadId: params.threadId });
  return clauses;
}

function traceToolParamClauses(params: DashboardV2TraceParams): Array<Record<string, string>> {
  const clauses: Array<Record<string, string>> = [];
  if (params.runId) clauses.push({ runId: params.runId });
  if (params.taskId) clauses.push({ taskId: params.taskId });
  if (params.threadId) clauses.push({ threadId: params.threadId });
  return clauses;
}

function traceIdClauses(traceId: string): Array<Record<string, string>> {
  return [
    { eventId: traceId },
    { runId: traceId },
    { taskId: traceId },
    { threadId: traceId },
    { turnId: traceId },
  ];
}

function traceIdClausesFromSet(ids: Set<string>): Array<Record<string, { $in: string[] }>> {
  const values = Array.from(ids);
  return [
    { eventId: { $in: values } },
    { runId: { $in: values } },
    { taskId: { $in: values } },
    { threadId: { $in: values } },
    { turnId: { $in: values } },
  ];
}

function traceToolIdClausesFromSet(ids: Set<string>): Array<Record<string, { $in: string[] }>> {
  const values = Array.from(ids);
  return [
    { id: { $in: values } },
    { runId: { $in: values } },
    { taskId: { $in: values } },
    { threadId: { $in: values } },
    { turnId: { $in: values } },
  ];
}

function traceScopeIds(seedEvents: EventDoc[], traceId: string): Set<string> {
  const ids = new Set<string>([traceId]);
  for (const doc of seedEvents) {
    for (const value of [doc.eventId, doc.runId, doc.taskId, doc.threadId, doc.turnId]) {
      if (value) ids.add(value);
    }
  }
  return ids;
}

function buildTraceAccumulators(
  events: EventDoc[],
  tools: ToolExecutionDoc[],
  nativeScorers: ScorerDoc[],
  includeLooseIds = false,
): Map<string, TraceAccumulator> {
  const map = new Map<string, TraceAccumulator>();

  for (const doc of events) {
    const key = traceKeyFromEvent(doc, includeLooseIds);
    if (!key) continue;
    const row = map.get(key) ?? buildTraceAccumulator(key);
    addEventToTrace(row, doc);
    map.set(key, row);
  }

  for (const doc of tools) {
    const key = traceKeyFromTool(doc, includeLooseIds);
    if (!key) continue;
    const row = map.get(key) ?? buildTraceAccumulator(key);
    addToolToTrace(row, doc);
    map.set(key, row);
  }

  for (const doc of nativeScorers) {
    const key = doc.taskId ?? doc.entityId;
    if (!key) continue;
    const row = map.get(key) ?? buildTraceAccumulator(key);
    row.scorerEvaluations += 1;
    if (doc.agentId) bumpTraceAgent(row, classifyAgentId(doc.agentId).canonicalAgentId);
    updateTraceDate(row, doc.createdAt);
    map.set(key, row);
  }

  return map;
}

function buildTraceAccumulator(traceId: string): TraceAccumulator {
  return {
    traceId,
    agentCounts: new Map<string, number>(),
    models: new Set<string>(),
    eventTypes: new Set<string>(),
    eventCount: 0,
    toolExecutions: 0,
    scorerEvaluations: 0,
    tokens: 0,
    costUsd: 0,
    latencies: [],
    failed: false,
    completed: false,
    running: false,
  };
}

function addEventToTrace(row: TraceAccumulator, doc: EventDoc): void {
  row.eventCount += 1;
  const type = doc.type ?? 'unknown';
  row.eventTypes.add(type);
  if (doc.agentId) bumpTraceAgent(row, classifyAgentId(doc.agentId).canonicalAgentId);
  if (doc.model) {
    const model = normalizeModelId(doc.model).model;
    row.models.add(model);
    if (doc.tokenUsage) {
      const tokens = tokensOf(doc.tokenUsage);
      row.tokens += tokens.total;
      row.costUsd += calculateCost(model, tokens.prompt, tokens.completion);
    }
  }
  if (doc.durationMs && doc.durationMs > 0) row.latencies.push(doc.durationMs);
  if (isErrorEvent(doc)) row.failed = true;
  if (type.includes('completed') || type === 'output_score' || type === 'goal_completion_evaluated') row.completed = true;
  if (type.includes('started') || doc.status === 'started') row.running = true;
  if ((type === 'output_score' || type === 'goal_completion_evaluated')) row.scorerEvaluations += 1;
  if (!row.firstError && doc.errorMessage) row.firstError = truncateSample(doc.errorMessage);
  row.runId ??= doc.runId;
  row.taskId ??= doc.taskId;
  row.threadId ??= doc.threadId;
  row.turnId ??= doc.turnId;
  updateTraceDate(row, doc.timestamp);
}

function addToolToTrace(row: TraceAccumulator, doc: ToolExecutionDoc): void {
  row.toolExecutions += 1;
  if (doc.agentId) bumpTraceAgent(row, classifyAgentId(doc.agentId).canonicalAgentId);
  if (doc.status === 'failed' || doc.status === 'blocked') row.failed = true;
  if (doc.status === 'completed') row.completed = true;
  if (doc.status === 'started') row.running = true;
  if (doc.durationMs && doc.durationMs > 0) row.latencies.push(doc.durationMs);
  if (!row.firstError && (doc.errorMessage || doc.errorClass)) row.firstError = truncateSample(doc.errorMessage ?? doc.errorClass ?? '');
  row.runId ??= doc.runId;
  row.taskId ??= doc.taskId;
  row.threadId ??= doc.threadId;
  row.turnId ??= doc.turnId;
  updateTraceDate(row, doc.createdAt);
  updateTraceDate(row, doc.completedAt);
}

function traceSummaryFromAccumulator(row: TraceAccumulator): DashboardV2TraceSummary {
  return {
    traceId: row.traceId,
    status: traceStatus(row),
    startedAt: row.startedAt?.toISOString(),
    endedAt: row.endedAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
    agentId: tracePrimaryAgent(row),
    model: Array.from(row.models).sort()[0],
    runId: row.runId,
    taskId: row.taskId,
    threadId: row.threadId,
    turnId: row.turnId,
    eventCount: row.eventCount,
    toolExecutions: row.toolExecutions,
    scorerEvaluations: row.scorerEvaluations,
    tokens: row.tokens,
    costUsd: roundMoney(row.costUsd),
    latencyMs: max(row.latencies),
    firstError: row.firstError,
    eventTypes: Array.from(row.eventTypes).sort().slice(0, 10),
  };
}

function traceStatus(row: TraceAccumulator): DashboardV2TraceSummary['status'] {
  if (row.failed) return 'failed';
  if (row.completed) return 'completed';
  if (row.running) return 'running';
  return 'unknown';
}

function tracePrimaryAgent(row: TraceAccumulator): string {
  const [agent] = Array.from(row.agentCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return agent ?? 'unknown';
}

function updateTraceDate(row: TraceAccumulator, date: Date | undefined): void {
  if (!date) return;
  if (!row.startedAt || date.getTime() < row.startedAt.getTime()) row.startedAt = date;
  if (!row.updatedAt || date.getTime() > row.updatedAt.getTime()) row.updatedAt = date;
  if (!row.endedAt || date.getTime() > row.endedAt.getTime()) row.endedAt = date;
}

function bumpTraceAgent(row: TraceAccumulator, agentId: string): void {
  row.agentCounts.set(agentId, (row.agentCounts.get(agentId) ?? 0) + 1);
}

function traceKeyFromEvent(doc: EventDoc, includeEventId = false): string | undefined {
  return doc.taskId ?? doc.runId ?? doc.threadId ?? doc.turnId ?? (includeEventId ? doc.eventId : undefined);
}

function traceKeyFromTool(doc: ToolExecutionDoc, includeToolId = false): string | undefined {
  return doc.taskId ?? doc.runId ?? doc.threadId ?? doc.turnId ?? (includeToolId ? doc.id : undefined);
}

function toTraceEvent(doc: EventDoc): DashboardV2TraceEvent {
  return {
    eventId: doc.eventId ?? `${doc.type ?? 'event'}:${doc.timestamp?.toISOString() ?? ''}`,
    type: doc.type ?? 'unknown',
    timestamp: doc.timestamp?.toISOString(),
    agentId: classifyAgentId(doc.agentId).canonicalAgentId,
    rawAgentId: doc.agentId ?? undefined,
    model: doc.model ? normalizeModelId(doc.model).model : undefined,
    status: doc.status,
    durationMs: doc.durationMs,
    runId: doc.runId,
    taskId: doc.taskId,
    threadId: doc.threadId,
    turnId: doc.turnId,
    toolId: doc.toolId,
    errorMessage: doc.errorMessage ? truncateSample(doc.errorMessage) : undefined,
  };
}

function toTraceTool(doc: ToolExecutionDoc): DashboardV2TraceTool {
  return {
    id: doc.id ?? doc.toolId ?? 'unknown',
    toolId: doc.toolId ?? 'unknown',
    status: doc.status ?? 'unknown',
    category: doc.category ?? 'other',
    risk: doc.risk ?? 'unknown',
    agentId: doc.agentId ? classifyAgentId(doc.agentId).canonicalAgentId : undefined,
    runId: doc.runId,
    taskId: doc.taskId,
    threadId: doc.threadId,
    turnId: doc.turnId,
    durationMs: doc.durationMs,
    createdAt: doc.createdAt?.toISOString(),
    completedAt: doc.completedAt?.toISOString(),
    errorClass: doc.errorClass,
    errorMessage: doc.errorMessage ? truncateSample(doc.errorMessage) : undefined,
    inputPreview: doc.inputPreview ? truncateSample(doc.inputPreview, 400) : undefined,
    outputPreview: doc.outputPreview ? truncateSample(doc.outputPreview, 400) : undefined,
    outputArtifactId: doc.outputArtifactId,
  };
}

function traceScores(events: EventDoc[], nativeScorers: ScorerDoc[]): DashboardV2TraceScore[] {
  const scores: DashboardV2TraceScore[] = [];

  for (const doc of events) {
    if (doc.type === 'output_score') {
      const complete = doc.data?.complete;
      const score = typeof complete === 'boolean' ? (complete ? 1 : 0) : normalizeScore(doc.data?.score);
      scores.push({
        source: 'output_score',
        scorerId: 'Goal output completion',
        agentId: classifyAgentId(doc.agentId).canonicalAgentId,
        taskId: qualityTaskKey(doc),
        score: score === undefined ? undefined : roundScore(score),
        passed: typeof complete === 'boolean' ? complete : (score ?? 0) >= 0.7,
        timestamp: doc.timestamp?.toISOString(),
        reason: qualityReason(doc.data?.completionReason, doc.data),
      });
    }

    if (doc.type === 'goal_completion_evaluated') {
      const numericScore = normalizeScore(doc.data?.score);
      const passed = typeof doc.data?.passed === 'boolean' ? doc.data.passed : (numericScore ?? 0) >= 0.7;
      scores.push({
        source: 'goal_completion',
        scorerId: 'Goal completion gate',
        agentId: classifyAgentId(stringValue(doc.data?.targetAgent) ?? doc.agentId).canonicalAgentId,
        taskId: stringValue(doc.data?.taskId) ?? qualityTaskKey(doc) ?? stringValue(doc.data?.contractId),
        score: numericScore === undefined ? undefined : roundScore(numericScore),
        passed,
        timestamp: doc.timestamp?.toISOString(),
        reason: goalQualityReason(doc.data),
      });
    }
  }

  for (const doc of nativeScorers) {
    const score = normalizeScore(doc.score);
    if (score === undefined) continue;
    scores.push({
      source: 'mastra_scorers',
      scorerId: doc.scorerId ?? doc.metadata?.scorerId ?? 'native_scorer',
      agentId: doc.agentId ? classifyAgentId(doc.agentId).canonicalAgentId : undefined,
      taskId: doc.taskId ?? doc.entityId,
      score: roundScore(score),
      passed: score >= 0.7,
      timestamp: doc.createdAt?.toISOString(),
      reason: qualityReason(doc.reason, doc.metadata),
    });
  }

  return scores.sort((a, b) => (Date.parse(a.timestamp ?? '') || 0) - (Date.parse(b.timestamp ?? '') || 0));
}

function severityRank(severity: DashboardV2TimelineStats['annotations'][number]['severity']): number {
  if (severity === 'critical') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function toolWindowQuery(window: TimeWindow): Record<string, unknown> {
  return {
    $or: [
      { createdAt: { $gte: window.from, $lt: window.to } },
      { completedAt: { $gte: window.from, $lt: window.to } },
    ],
    ...EXCLUDE_CHECK_HARNESS_TASKS,
  };
}

function classifyAgentId(rawAgentId: string | null | undefined): {
  canonicalAgentId: string;
  displayName: string;
  entityKind: AgentEntityKind;
} {
  if (!rawAgentId || rawAgentId === 'unknown') {
    return { canonicalAgentId: 'unknown', displayName: 'Unknown', entityKind: 'unknown' };
  }

  if (rawAgentId.startsWith('plan-task-') || rawAgentId.startsWith('plan:task-')) {
    return { canonicalAgentId: 'planTasks', displayName: 'Plan tasks', entityKind: 'plan' };
  }

  if (
    rawAgentId.startsWith('run-worker-') ||
    rawAgentId.startsWith('worker:') ||
    rawAgentId.includes('-worker-')
  ) {
    return { canonicalAgentId: 'workers', displayName: 'Workers', entityKind: 'worker' };
  }

  const canonical = canonicalizeRuntimeAgentId(rawAgentId) ?? rawAgentId;
  return {
    canonicalAgentId: canonical,
    displayName: canonical,
    entityKind: canonical === 'system' ? 'system' : 'agent',
  };
}

function normalizeModelId(rawModel: string): { model: string; displayName: string } {
  const trimmed = rawModel.trim();
  const parts = trimmed.split('/').filter(Boolean);

  if (parts.length >= 3 && parts[0] === parts[1]) {
    const model = parts[parts.length - 1]!;
    return { model, displayName: model };
  }

  if (parts[0] === 'ollama' && parts[1] === 'local' && parts.length > 2) {
    const model = `ollama/${parts.slice(2).join('/')}`;
    return { model, displayName: model };
  }

  return { model: trimmed, displayName: trimmed };
}

function modelPricingStatus(input: {
  provider: string;
  totalTokens: number;
  rawAliases: string[];
  model: string;
}): PricingStatus {
  if (input.totalTokens === 0) return 'zero_tokens';
  if (input.provider === 'unknown') return 'missing_pricing';
  if (input.rawAliases.length > 1 || input.rawAliases.some((alias) => normalizeModelId(alias).model !== input.model)) {
    return 'alias';
  }
  return 'priced';
}

function isErrorEvent(doc: Pick<EventDoc, 'type' | 'status' | 'errorMessage'>): boolean {
  if (doc.status === 'error') return true;
  if (doc.errorMessage) return true;
  return [
    'task_failed',
    'run_failed',
    'llm_call_failed',
    'tool_error',
    'tool_call_failed',
    'worker_run_failed',
    'plan_task_failed',
  ].includes(doc.type ?? '');
}

function tokensOf(tokenUsage: TokenUsageDoc | undefined): { prompt: number; completion: number; total: number } {
  const prompt = tokenUsage?.prompt ?? 0;
  const completion = tokenUsage?.completion ?? 0;
  return { prompt, completion, total: prompt + completion };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function max(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(Math.max(...values));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[index] ?? 0);
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10) / 10;
}

function latencySummary(values: number[]): DashboardV2LatencyStats['overall'] {
  return {
    samples: values.length,
    avgMs: average(values),
    p50Ms: percentile(values, 0.5),
    p75Ms: percentile(values, 0.75),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: max(values),
    p99ToP50Ratio: ratio(percentile(values, 0.99), percentile(values, 0.5)),
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toWindowDto(window: TimeWindow): { from: string; to: string } {
  return { from: window.from.toISOString(), to: window.to.toISOString() };
}

function previousTimeWindow(window: TimeWindow): TimeWindow {
  const durationMs = Math.max(1, window.to.getTime() - window.from.getTime());
  return {
    from: new Date(window.from.getTime() - durationMs),
    to: new Date(window.from.getTime()),
  };
}

function metricDelta(current: number, previous: number): DashboardV2MetricDelta {
  const absolute = roundDelta(current - previous);
  return {
    current,
    previous,
    absolute,
    relative: previous !== 0 ? roundDelta(absolute / Math.abs(previous)) : current === 0 ? 0 : 1,
    direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat',
  };
}

function roundDelta(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clampLimit(value: number, min: number, maxValue: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(maxValue, Math.max(min, Math.round(value)));
}

function flattenPolicyDecision(value: unknown): Array<Record<string, any>> {
  if (!value) return [];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, any> => Boolean(entry && typeof entry === 'object'))
    : typeof value === 'object'
      ? [value as Record<string, any>]
      : [];
}

function cleanFilterParam(value: string | null): string | undefined {
  const text = value?.trim();
  if (!text || text === 'all') return undefined;
  return text;
}

function filterEventDocs<T extends EventDoc>(docs: T[], filters: DashboardV2Filters): T[] {
  if (!filters.agentId && !filters.model) return docs;
  return docs.filter((doc) => eventMatchesFilters(doc, filters));
}

function filterToolDocs<T extends ToolExecutionDoc>(docs: T[], filters: DashboardV2Filters): T[] {
  if (!filters.agentId && !filters.toolCategory && !filters.toolRisk && !filters.toolStatus) return docs;
  return docs.filter((doc) => toolMatchesFilters(doc, filters));
}

function eventMatchesFilters(doc: EventDoc, filters: DashboardV2Filters): boolean {
  if (filters.agentId && !agentMatchesFilter(doc.agentId, filters.agentId)) return false;
  if (filters.model && !modelMatchesFilter(doc.model, filters.model)) return false;
  return true;
}

function toolMatchesFilters(doc: ToolExecutionDoc, filters: DashboardV2Filters): boolean {
  if (filters.agentId && !agentMatchesFilter(doc.agentId, filters.agentId)) return false;
  if (filters.toolCategory && !textMatchesFilter(doc.category ?? 'other', filters.toolCategory)) return false;
  if (filters.toolRisk && !textMatchesFilter(doc.risk ?? 'unknown', filters.toolRisk)) return false;
  if (filters.toolStatus && !textMatchesFilter(doc.status ?? 'unknown', filters.toolStatus)) return false;
  return true;
}

function scorerMatchesFilters(doc: ScorerDoc, filters: DashboardV2Filters): boolean {
  if (filters.agentId && !agentMatchesFilter(doc.agentId ?? stringValue(doc.metadata?.targetAgent), filters.agentId)) return false;
  if (filters.model) {
    const model = stringValue(doc.metadata?.model) ?? stringValue(doc.metadata?.modelId);
    if (!modelMatchesFilter(model, filters.model)) return false;
  }
  return true;
}

function goalEvaluationMatchesFilters(doc: EventDoc, filters: DashboardV2Filters): boolean {
  if (filters.agentId) {
    const targetAgent = stringValue(doc.data?.targetAgent);
    if (!agentMatchesFilter(targetAgent ?? doc.agentId, filters.agentId)) return false;
  }
  if (filters.model && !modelMatchesFilter(doc.model, filters.model)) return false;
  return true;
}

function agentMatchesFilter(rawAgentId: string | null | undefined, filter: string): boolean {
  const classified = classifyAgentId(rawAgentId);
  return [
    rawAgentId,
    classified.canonicalAgentId,
    classified.displayName,
  ].some((value) => textMatchesFilter(value, filter));
}

function modelMatchesFilter(rawModel: string | null | undefined, filter: string): boolean {
  if (!rawModel) return false;
  const normalized = normalizeModelId(rawModel);
  return [
    rawModel,
    normalized.model,
    normalized.displayName,
  ].some((value) => textMatchesFilter(value, filter));
}

function textMatchesFilter(value: string | null | undefined, filter: string): boolean {
  if (!value) return false;
  return value.toLowerCase().includes(filter.toLowerCase());
}

function aggregateLegacySkillEvents(docs: EventDoc[]): Array<{ _id: string; uses: number; agents: string[] }> {
  const map = new Map<string, { _id: string; uses: number; agents: Set<string> }>();
  for (const doc of docs) {
    const skillId = doc.toolId ?? stringValue(doc.metadata?.skillId) ?? 'unknown';
    const row = map.get(skillId) ?? { _id: skillId, uses: 0, agents: new Set<string>() };
    row.uses += 1;
    if (doc.agentId) row.agents.add(doc.agentId);
    map.set(skillId, row);
  }
  return Array.from(map.values())
    .map((row) => ({ _id: row._id, uses: row.uses, agents: Array.from(row.agents).sort() }))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 25);
}

function qualityTaskKey(doc: Pick<EventDoc, 'taskId' | 'runId' | 'threadId' | 'eventId'>): string | undefined {
  return doc.taskId ?? doc.runId ?? doc.threadId ?? doc.eventId;
}

function normalizeScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = value > 1 && value <= 100 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function averageScore(records: QualityScoreRecord[]): number {
  return averageRawScore(records.map((record) => record.score));
}

function averageRawScore(scores: number[]): number {
  if (!scores.length) return 0;
  return roundScore(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function qualityReason(value: unknown, fallback?: Record<string, any>): string | undefined {
  const primary = stringValue(value);
  if (primary) return primary;
  return stringValue(fallback?.reason) ?? stringValue(fallback?.recommendation) ?? stringValue(fallback?.completionReason);
}

function goalQualityReason(data: Record<string, any> | undefined): string | undefined {
  if (!data) return undefined;
  const parts = [
    stringValue(data.recommendation),
    stringValue(data.reason),
  ].filter(Boolean);
  const missing = Array.isArray(data.missingCriteria)
    ? data.missingCriteria.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (missing.length > 0) parts.push(`missing: ${missing.slice(0, 5).join(', ')}`);
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

function scoreBucket(score: number): '0-0.3' | '0.3-0.7' | '0.7-1.0' {
  if (score < 0.3) return '0-0.3';
  if (score < 0.7) return '0.3-0.7';
  return '0.7-1.0';
}

function buildScoreDistribution(records: QualityScoreRecord[]): DashboardV2QualityStats['distribution'] {
  const counts = new Map<string, number>([
    ['0-0.3', 0],
    ['0.3-0.7', 0],
    ['0.7-1.0', 0],
  ]);
  for (const record of records) {
    const bucket = scoreBucket(record.score);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([bucket, count]) => ({ bucket, count }));
}

function buildScorerSummaries(records: QualityScoreRecord[]): DashboardV2QualityStats['scorerSummaries'] {
  const map = new Map<string, {
    scorerId: string;
    source: QualitySource;
    scores: number[];
    passed: number;
    low: number;
    mid: number;
    high: number;
  }>();

  for (const record of records) {
    const key = `${record.source}:${record.scorerId}`;
    const row = map.get(key) ?? {
      scorerId: record.scorerId,
      source: record.source,
      scores: [],
      passed: 0,
      low: 0,
      mid: 0,
      high: 0,
    };
    row.scores.push(record.score);
    if (record.passed) row.passed += 1;
    const bucket = scoreBucket(record.score);
    if (bucket === '0-0.3') row.low += 1;
    if (bucket === '0.3-0.7') row.mid += 1;
    if (bucket === '0.7-1.0') row.high += 1;
    map.set(key, row);
  }

  return Array.from(map.values())
    .map((row) => ({
      scorerId: row.scorerId,
      source: row.source,
      totalEvaluations: row.scores.length,
      avgScore: averageRawScore(row.scores),
      passRate: row.scores.length > 0 ? row.passed / row.scores.length : 0,
      low: row.low,
      mid: row.mid,
      high: row.high,
    }))
    .sort((a, b) => b.totalEvaluations - a.totalEvaluations || a.scorerId.localeCompare(b.scorerId));
}

function buildQualityByAgent(
  taskKeysByAgent: Map<string, Set<string>>,
  records: QualityScoreRecord[],
  taskAgentMap: Map<string, string>,
): DashboardV2QualityStats['byAgent'] {
  const map = new Map<string, {
    taskKeys: Set<string>;
    scoredTaskKeys: Set<string>;
    scores: number[];
    passed: number;
    failed: number;
  }>();

  for (const [agentId, taskKeys] of taskKeysByAgent.entries()) {
    map.set(agentId, {
      taskKeys: new Set(taskKeys),
      scoredTaskKeys: new Set<string>(),
      scores: [],
      passed: 0,
      failed: 0,
    });
  }

  for (const record of records) {
    const agentId = record.agentId ?? (record.taskId ? taskAgentMap.get(record.taskId) : undefined) ?? 'unknown';
    const row = map.get(agentId) ?? {
      taskKeys: new Set<string>(),
      scoredTaskKeys: new Set<string>(),
      scores: [],
      passed: 0,
      failed: 0,
    };
    if (record.taskId) row.scoredTaskKeys.add(record.taskId);
    row.scores.push(record.score);
    if (record.passed) row.passed += 1;
    else row.failed += 1;
    map.set(agentId, row);
  }

  return Array.from(map.entries())
    .map(([agentId, row]) => {
      const tasks = row.taskKeys.size;
      const scoredTasks = Math.min(row.scoredTaskKeys.size, tasks);
      return {
        agentId,
        tasks,
        scoredTasks,
        coverage: tasks > 0 ? scoredTasks / tasks : 0,
        avgScore: row.scores.length > 0 ? roundScore(row.scores.reduce((sum, score) => sum + score, 0) / row.scores.length) : 0,
        passRate: row.scores.length > 0 ? row.passed / row.scores.length : 0,
        failed: row.failed,
      };
    })
    .sort((a, b) => b.tasks - a.tasks || b.failed - a.failed || a.agentId.localeCompare(b.agentId));
}

function buildSummaryAlerts(input: {
  successRate: number;
  toolFailureRate: number;
  scorerCoverage: number;
  hangingTools: number;
  highRiskBlocked: number;
  missingPricingModels: number;
  zeroTokenModels: number;
}): DashboardV2Alert[] {
  const alerts: DashboardV2Alert[] = [];

  if (input.successRate > 0 && input.successRate < 0.85) {
    alerts.push({
      severity: 'critical',
      code: 'low_success_rate',
      message: 'Task success rate is below 85%.',
      metric: input.successRate,
    });
  }

  if (input.toolFailureRate > 0.05) {
    alerts.push({
      severity: input.toolFailureRate > 0.1 ? 'critical' : 'warning',
      code: 'high_tool_failure_rate',
      message: 'Tool envelope failure rate is above the 5% warning threshold.',
      metric: input.toolFailureRate,
    });
  }

  if (input.scorerCoverage < 0.1) {
    alerts.push({
      severity: 'warning',
      code: 'low_scorer_coverage',
      message: 'Scorer coverage is low; quality metrics may be misleading.',
      metric: input.scorerCoverage,
    });
  }

  if (input.hangingTools > 0) {
    alerts.push({
      severity: 'warning',
      code: 'hanging_tool_executions',
      message: 'There are tool executions stuck in started state.',
      metric: input.hangingTools,
    });
  }

  if (input.highRiskBlocked > 0) {
    alerts.push({
      severity: 'info',
      code: 'high_risk_tools_blocked',
      message: 'High-risk tool executions were blocked by policy or guardrails.',
      metric: input.highRiskBlocked,
    });
  }

  if (input.missingPricingModels > 0) {
    alerts.push({
      severity: 'warning',
      code: 'missing_model_pricing',
      message: 'Some models have unknown pricing and may under-report cost.',
      metric: input.missingPricingModels,
    });
  }

  if (input.zeroTokenModels > 0) {
    alerts.push({
      severity: 'info',
      code: 'zero_token_models',
      message: 'Some model invocations have zero token usage.',
      metric: input.zeroTokenModels,
    });
  }

  return alerts;
}

// ── Code Graph Trend (Graphify Phase 2, Stream C) ───────────────────────────
//
// Source is a flat append-only file (src/mastra/graphify-out/trend.jsonl), not
// Mongo, so this has no time window or filters — it is whatever history the
// git-hook-driven graph refresh has accumulated. No caching either: the file
// is tiny (a few KB) and read once per dashboard load, not per event.

export interface DashboardV2CodeGraphHub {
  label: string;
  edgesNow: number;
  edgesBefore: number;
  delta: number;
}

export interface DashboardV2CodeGraphStats {
  entries: GraphTrendEntry[];
  latest: GraphTrendEntry | null;
  earliest: GraphTrendEntry | null;
  fastestGrowingHubs: DashboardV2CodeGraphHub[];
}

export async function getDashboardV2CodeGraph(): Promise<DashboardV2CodeGraphStats> {
  const entries = readGraphTrendEntries();
  const latest = entries.length > 0 ? entries[entries.length - 1]! : null;
  const earliest = entries.length > 0 ? entries[0]! : null;

  return {
    entries,
    latest,
    earliest,
    fastestGrowingHubs: computeFastestGrowingHubs(earliest, latest),
  };
}

/**
 * Compares the latest snapshot's top hubs against their edge count in the
 * earliest tracked snapshot (0 if the hub did not appear there at all), so
 * the dashboard can answer "which file is accumulating dependents fastest"
 * rather than only "which file has the most today" (the god-nodes list on
 * its own answers only the latter).
 */
function computeFastestGrowingHubs(
  earliest: GraphTrendEntry | null,
  latest: GraphTrendEntry | null,
): DashboardV2CodeGraphHub[] {
  if (!latest || latest.top_god_nodes.length === 0) return [];
  const earliestByLabel = new Map((earliest?.top_god_nodes ?? []).map((n) => [n.label, n.edges]));

  return latest.top_god_nodes
    .map((n) => {
      const edgesBefore = earliestByLabel.get(n.label) ?? 0;
      return { label: n.label, edgesNow: n.edges, edgesBefore, delta: n.edges - edgesBefore };
    })
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10);
}
