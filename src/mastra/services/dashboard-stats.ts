/**
 * Dashboard Stats — aggregation service for agent performance metrics.
 *
 * Reads from two MongoDB collections:
 *   - agent_events     (own log via lib/agent-event-log.ts)
 *   - mastra_scorers   (Mastra-managed scorer results)
 *
 * Each function returns structured data ready for API endpoints / agent tools.
 * All time windows can be passed as { from, to } Date objects.
 */
import { getDb } from '../lib/mongo.js';
import { calculateCost, getModelPricing } from '../lib/model-pricing.js';

// ── Time window helpers ──────────────────────────────────────────────────────

export interface TimeWindow {
  from: Date;
  to: Date;
}

/**
 * Parse a relative duration string ("7d", "24h", "30m") OR ISO date,
 * returning a Date in the past (for `from`).
 */
export function parseSince(input: string | undefined, defaultDays = 7): Date {
  if (!input) return new Date(Date.now() - defaultDays * 24 * 3600 * 1000);

  // ISO date check
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) {
    const d = new Date(input);
    if (!isNaN(d.getTime())) return d;
  }

  // Relative duration: <number><unit>
  const match = input.match(/^(\d+)\s*(m|h|d|w)$/i);
  if (match) {
    const n = parseInt(match[1]!, 10);
    const unit = match[2]!.toLowerCase();
    const ms = unit === 'm' ? n * 60_000
      : unit === 'h' ? n * 3_600_000
      : unit === 'd' ? n * 86_400_000
      : /* w */         n * 604_800_000;
    return new Date(Date.now() - ms);
  }

  return new Date(Date.now() - defaultDays * 24 * 3600 * 1000);
}

export function buildWindow(since?: string, until?: string): TimeWindow {
  return { from: parseSince(since, 7), to: until ? new Date(until) : new Date() };
}

// ── Utility: token usage extraction ──────────────────────────────────────────

interface TokenUsageDoc {
  prompt?: number;
  completion?: number;
}

function tokensOf(doc: { tokenUsage?: TokenUsageDoc }): { prompt: number; completion: number } {
  const t = doc.tokenUsage ?? {};
  return { prompt: t.prompt ?? 0, completion: t.completion ?? 0 };
}

// ── 1. Overview ──────────────────────────────────────────────────────────────

export interface OverviewStats {
  window: { from: string; to: string };
  totalTasks: number;
  successRate: number;          // 0..1
  totalErrors: number;
  totalToolCalls: number;
  toolErrorRate: number;        // 0..1
  totalTokens: number;
  totalCostUsd: number;
  uniqueAgents: number;
  uniqueModels: number;
  avgLatencyMs: number;
}

export async function getOverview(window: TimeWindow): Promise<OverviewStats> {
  const db = await getDb();
  const events = db.collection('agent_events');

  const [aggResult, agentsCount, modelsCount] = await Promise.all([
    events.aggregate([
      { $match: { timestamp: { $gte: window.from, $lt: window.to }, taskId: { $not: /^(?:check|test)-/ } } },
      { $group: {
        _id: null,
        completed: { $sum: { $cond: [{ $eq: ['$type', 'task_completed'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$type', 'task_failed'] }, 1, 0] } },
        toolCalls: { $sum: { $cond: [{ $eq: ['$type', 'tool_called'] }, 1, 0] } },
        toolErrors: { $sum: { $cond: [{ $eq: ['$type', 'tool_error'] }, 1, 0] } },
        totalDuration: { $sum: { $ifNull: ['$durationMs', 0] } },
        durationCount: { $sum: { $cond: [{ $gt: ['$durationMs', 0] }, 1, 0] } },
        events: { $push: {
          model: '$model',
          tokenUsage: '$tokenUsage',
        }},
      }},
    ]).toArray(),
    events.distinct('agentId', { timestamp: { $gte: window.from, $lt: window.to } }),
    events.distinct('model', {
      timestamp: { $gte: window.from, $lt: window.to },
      model: { $ne: null, $exists: true },
    }),
  ]);

  const a = aggResult[0] ?? { completed: 0, failed: 0, toolCalls: 0, toolErrors: 0, totalDuration: 0, durationCount: 0, events: [] };
  const totalTasks = a.completed + a.failed;

  // Cost calculation
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const e of (a.events ?? []) as Array<{ model?: string; tokenUsage?: TokenUsageDoc }>) {
    if (!e.model || !e.tokenUsage) continue;
    const { prompt, completion } = tokensOf(e);
    totalTokens += prompt + completion;
    totalCostUsd += calculateCost(e.model, prompt, completion);
  }

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    totalTasks,
    successRate: totalTasks > 0 ? a.completed / totalTasks : 0,
    totalErrors: a.failed + a.toolErrors,
    totalToolCalls: a.toolCalls,
    toolErrorRate: a.toolCalls > 0 ? a.toolErrors / a.toolCalls : 0,
    totalTokens,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    uniqueAgents: agentsCount.filter(Boolean).length,
    uniqueModels: modelsCount.filter(Boolean).length,
    avgLatencyMs: a.durationCount > 0 ? Math.round(a.totalDuration / a.durationCount) : 0,
  };
}

// ── 2. Per-agent success rates ──────────────────────────────────────────────

export interface AgentStats {
  agentId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  successRate: number;
  toolCalls: number;
  toolErrors: number;
  retries: number;
  delegations: number;
  tokensUsed: number;
  costUsd: number;
  avgLatencyMs: number;
}

export async function getAgentSuccessRates(window: TimeWindow): Promise<AgentStats[]> {
  const db = await getDb();
  const events = db.collection('agent_events');

  const rows = await events.aggregate([
    { $match: { timestamp: { $gte: window.from, $lt: window.to }, agentId: { $ne: null }, taskId: { $not: /^(?:check|test)-/ } } },
    { $group: {
      _id: '$agentId',
      completed: { $sum: { $cond: [{ $eq: ['$type', 'task_completed'] }, 1, 0] } },
      failed: { $sum: { $cond: [{ $eq: ['$type', 'task_failed'] }, 1, 0] } },
      toolCalls: { $sum: { $cond: [{ $eq: ['$type', 'tool_called'] }, 1, 0] } },
      toolErrors: { $sum: { $cond: [{ $eq: ['$type', 'tool_error'] }, 1, 0] } },
      retries: { $sum: { $cond: [{ $or: [{ $eq: ['$type', 'retry_success'] }, { $eq: ['$type', 'retry_failed'] }] }, 1, 0] } },
      delegations: { $sum: { $cond: [{ $eq: ['$type', 'delegation'] }, 1, 0] } },
      totalDuration: { $sum: { $ifNull: ['$durationMs', 0] } },
      durationCount: { $sum: { $cond: [{ $gt: ['$durationMs', 0] }, 1, 0] } },
      tokenEvents: { $push: { model: '$model', tokenUsage: '$tokenUsage' } },
    }},
    { $sort: { completed: -1 } },
  ]).toArray();

  return rows.map(r => {
    let tokens = 0;
    let cost = 0;
    for (const e of (r.tokenEvents ?? []) as Array<{ model?: string; tokenUsage?: TokenUsageDoc }>) {
      if (!e.model || !e.tokenUsage) continue;
      const { prompt, completion } = tokensOf(e);
      tokens += prompt + completion;
      cost += calculateCost(e.model, prompt, completion);
    }
    const total = r.completed + r.failed;

    return {
      agentId: r._id as string,
      totalTasks: total,
      completed: r.completed,
      failed: r.failed,
      successRate: total > 0 ? r.completed / total : 0,
      toolCalls: r.toolCalls,
      toolErrors: r.toolErrors,
      retries: r.retries,
      delegations: r.delegations,
      tokensUsed: tokens,
      costUsd: Math.round(cost * 1_000_000) / 1_000_000,
      avgLatencyMs: r.durationCount > 0 ? Math.round(r.totalDuration / r.durationCount) : 0,
    };
  });
}

// ── 3. Skill usage stats ─────────────────────────────────────────────────────

export interface SkillStats {
  skillId: string;
  uses: number;
  agents: string[];
  avgDurationMs: number;
}

export async function getSkillUsageStats(window: TimeWindow): Promise<SkillStats[]> {
  const db = await getDb();
  const events = db.collection('agent_events');

  const rows = await events.aggregate([
    { $match: {
      type: 'skill_used',
      timestamp: { $gte: window.from, $lt: window.to },
    }},
    { $group: {
      _id: { $ifNull: ['$toolId', { $ifNull: ['$metadata.skillId', 'unknown'] }] },
      uses: { $sum: 1 },
      agents: { $addToSet: '$agentId' },
      totalDuration: { $sum: { $ifNull: ['$durationMs', 0] } },
      durationCount: { $sum: { $cond: [{ $gt: ['$durationMs', 0] }, 1, 0] } },
    }},
    { $sort: { uses: -1 } },
    { $limit: 50 },
  ]).toArray();

  return rows.map(r => ({
    skillId: r._id as string,
    uses: r.uses,
    agents: (r.agents ?? []).filter(Boolean) as string[],
    avgDurationMs: r.durationCount > 0 ? Math.round(r.totalDuration / r.durationCount) : 0,
  }));
}

// ── 4. Model breakdown ──────────────────────────────────────────────────────

export interface ModelStats {
  model: string;
  provider: string;
  invocations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  agents: string[];
}

export async function getModelBreakdown(window: TimeWindow): Promise<ModelStats[]> {
  const db = await getDb();
  const events = db.collection('agent_events');

  const rows = await events.aggregate([
    { $match: {
      timestamp: { $gte: window.from, $lt: window.to },
      model: { $exists: true, $ne: null },
    }},
    { $group: {
      _id: '$model',
      invocations: { $sum: 1 },
      promptTokens: { $sum: { $ifNull: ['$tokenUsage.prompt', 0] } },
      completionTokens: { $sum: { $ifNull: ['$tokenUsage.completion', 0] } },
      agents: { $addToSet: '$agentId' },
    }},
    { $sort: { invocations: -1 } },
  ]).toArray();

  return rows.map(r => {
    const cost = calculateCost(r._id as string, r.promptTokens, r.completionTokens);
    return {
      model: r._id as string,
      provider: getModelPricing(r._id as string).provider,
      invocations: r.invocations,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.promptTokens + r.completionTokens,
      costUsd: Math.round(cost * 1_000_000) / 1_000_000,
      agents: (r.agents ?? []).filter(Boolean) as string[],
    };
  });
}

// ── 5. Latency percentiles ──────────────────────────────────────────────────

export interface LatencyStats {
  agentId: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

export async function getLatencyPercentiles(window: TimeWindow): Promise<LatencyStats[]> {
  const db = await getDb();
  const events = db.collection('agent_events');

  // MongoDB 7.0+ supports $percentile
  const rows = await events.aggregate([
    { $match: {
      type: 'task_completed',
      timestamp: { $gte: window.from, $lt: window.to },
      durationMs: { $gt: 0 },
    }},
    { $group: {
      _id: '$agentId',
      latencies: { $push: '$durationMs' },
      count: { $sum: 1 },
      avg: { $avg: '$durationMs' },
      min: { $min: '$durationMs' },
      max: { $max: '$durationMs' },
    }},
    { $project: {
      _id: 1,
      count: 1,
      avg: { $round: ['$avg', 0] },
      min: 1,
      max: 1,
      percentiles: {
        $percentile: {
          input: '$latencies',
          p: [0.5, 0.95, 0.99],
          method: 'approximate',
        },
      },
    }},
    { $sort: { count: -1 } },
  ]).toArray();

  return rows.map(r => ({
    agentId: r._id as string,
    count: r.count,
    p50: Math.round((r.percentiles?.[0] ?? 0) as number),
    p95: Math.round((r.percentiles?.[1] ?? 0) as number),
    p99: Math.round((r.percentiles?.[2] ?? 0) as number),
    min: r.min,
    max: r.max,
    avg: r.avg,
  }));
}

// ── 6. Cost breakdown ──────────────────────────────────────────────────────

export interface CostBreakdown {
  totalUsd: number;
  byAgent: Array<{ agentId: string; usd: number; tokens: number }>;
  byModel: Array<{ model: string; usd: number; tokens: number; invocations: number }>;
  byDay: Array<{ date: string; usd: number; tokens: number }>;
}

export async function getCostBreakdown(window: TimeWindow): Promise<CostBreakdown> {
  const db = await getDb();
  const events = db.collection('agent_events');

  const docs = await events.find({
    timestamp: { $gte: window.from, $lt: window.to },
    model: { $exists: true, $ne: null },
    tokenUsage: { $exists: true },
  }, {
    projection: { agentId: 1, model: 1, tokenUsage: 1, timestamp: 1 },
  }).toArray();

  const byAgentMap = new Map<string, { usd: number; tokens: number }>();
  const byModelMap = new Map<string, { usd: number; tokens: number; invocations: number }>();
  const byDayMap = new Map<string, { usd: number; tokens: number }>();
  let total = 0;

  for (const d of docs as Array<{ agentId?: string; model?: string; tokenUsage?: TokenUsageDoc; timestamp?: Date }>) {
    if (!d.model) continue;
    const { prompt, completion } = tokensOf(d);
    const tokens = prompt + completion;
    const cost = calculateCost(d.model, prompt, completion);
    total += cost;

    if (d.agentId) {
      const a = byAgentMap.get(d.agentId) ?? { usd: 0, tokens: 0 };
      a.usd += cost; a.tokens += tokens;
      byAgentMap.set(d.agentId, a);
    }

    const m = byModelMap.get(d.model) ?? { usd: 0, tokens: 0, invocations: 0 };
    m.usd += cost; m.tokens += tokens; m.invocations += 1;
    byModelMap.set(d.model, m);

    if (d.timestamp) {
      const day = d.timestamp.toISOString().slice(0, 10);
      const dd = byDayMap.get(day) ?? { usd: 0, tokens: 0 };
      dd.usd += cost; dd.tokens += tokens;
      byDayMap.set(day, dd);
    }
  }

  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

  return {
    totalUsd: round(total),
    byAgent: Array.from(byAgentMap.entries())
      .map(([agentId, v]) => ({ agentId, usd: round(v.usd), tokens: v.tokens }))
      .sort((a, b) => b.usd - a.usd),
    byModel: Array.from(byModelMap.entries())
      .map(([model, v]) => ({ model, usd: round(v.usd), tokens: v.tokens, invocations: v.invocations }))
      .sort((a, b) => b.usd - a.usd),
    byDay: Array.from(byDayMap.entries())
      .map(([date, v]) => ({ date, usd: round(v.usd), tokens: v.tokens }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ── 7. Score stats (from mastra_scorers) ────────────────────────────────────

export interface ScoreStats {
  scorerId: string;
  totalEvaluations: number;
  avgScore: number;
  passRate: number;        // fraction with score >= 0.7
  byEntity: Array<{ entityId: string; entityType: string; count: number; avgScore: number }>;
  scoreDistribution: { '0-0.3': number; '0.3-0.7': number; '0.7-1.0': number };
}

export async function getScoreStats(window: TimeWindow): Promise<ScoreStats[]> {
  const db = await getDb();
  const scorers = db.collection('mastra_scorers');

  const rows = await scorers.aggregate([
    { $match: { createdAt: { $gte: window.from, $lt: window.to } } },
    { $group: {
      _id: '$scorerId',
      totalEvaluations: { $sum: 1 },
      avgScore: { $avg: '$score' },
      passes: { $sum: { $cond: [{ $gte: ['$score', 0.7] }, 1, 0] } },
      lowBucket: { $sum: { $cond: [{ $lt: ['$score', 0.3] }, 1, 0] } },
      midBucket: { $sum: { $cond: [{ $and: [{ $gte: ['$score', 0.3] }, { $lt: ['$score', 0.7] }] }, 1, 0] } },
      highBucket: { $sum: { $cond: [{ $gte: ['$score', 0.7] }, 1, 0] } },
      byEntityRaw: { $push: { entityId: '$entityId', entityType: '$entityType', score: '$score' } },
    }},
    { $sort: { totalEvaluations: -1 } },
  ]).toArray();

  return rows.map(r => {
    // Group byEntityRaw on the fly
    const entityMap = new Map<string, { entityType: string; scores: number[] }>();
    for (const e of (r.byEntityRaw ?? []) as Array<{ entityId?: string; entityType?: string; score: number }>) {
      if (!e.entityId) continue;
      const existing = entityMap.get(e.entityId) ?? { entityType: e.entityType ?? 'unknown', scores: [] };
      existing.scores.push(e.score);
      entityMap.set(e.entityId, existing);
    }

    const byEntity = Array.from(entityMap.entries()).map(([entityId, v]) => ({
      entityId,
      entityType: v.entityType,
      count: v.scores.length,
      avgScore: Math.round((v.scores.reduce((a, b) => a + b, 0) / v.scores.length) * 1000) / 1000,
    })).sort((a, b) => b.count - a.count);

    return {
      scorerId: r._id as string,
      totalEvaluations: r.totalEvaluations,
      avgScore: Math.round((r.avgScore ?? 0) * 1000) / 1000,
      passRate: r.totalEvaluations > 0 ? r.passes / r.totalEvaluations : 0,
      byEntity,
      scoreDistribution: {
        '0-0.3': r.lowBucket,
        '0.3-0.7': r.midBucket,
        '0.7-1.0': r.highBucket,
      },
    };
  });
}

// ── 8. Timeline (events bucketed by hour or day) ────────────────────────────

export interface TimelinePoint {
  bucket: string;            // ISO string for the bucket start
  taskStarted: number;
  taskCompleted: number;
  taskFailed: number;
  toolCalled: number;
  toolError: number;
}

export async function getTimeline(
  window: TimeWindow,
  granularity: 'hour' | 'day' = 'hour',
): Promise<TimelinePoint[]> {
  const db = await getDb();
  const events = db.collection('agent_events');

  const dateFormat = granularity === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%dT00:00:00Z';

  const rows = await events.aggregate([
    { $match: { timestamp: { $gte: window.from, $lt: window.to } } },
    { $group: {
      _id: { $dateToString: { format: dateFormat, date: '$timestamp' } },
      taskStarted: { $sum: { $cond: [{ $eq: ['$type', 'task_started'] }, 1, 0] } },
      taskCompleted: { $sum: { $cond: [{ $eq: ['$type', 'task_completed'] }, 1, 0] } },
      taskFailed: { $sum: { $cond: [{ $eq: ['$type', 'task_failed'] }, 1, 0] } },
      toolCalled: { $sum: { $cond: [{ $eq: ['$type', 'tool_called'] }, 1, 0] } },
      toolError: { $sum: { $cond: [{ $eq: ['$type', 'tool_error'] }, 1, 0] } },
    }},
    { $sort: { _id: 1 } },
  ]).toArray();

  return rows.map(r => ({
    bucket: r._id as string,
    taskStarted: r.taskStarted,
    taskCompleted: r.taskCompleted,
    taskFailed: r.taskFailed,
    toolCalled: r.toolCalled,
    toolError: r.toolError,
  }));
}
