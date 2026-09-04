/**
 * Agent Performance Report Tool (Faza 7.6 — Sprint 1).
 *
 * Aggregates data from agent_events + mastra_scorers and returns a
 * structured report. Used by meta-agent and analytics-agent to answer
 * questions like:
 *   - "Which agent is slowest?"
 *   - "How much did we spend last week?"
 *   - "Which skill is used most?"
 *   - "Which model is most expensive per task?"
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  buildWindow,
  getOverview,
  getAgentSuccessRates,
  getSkillUsageStats,
  getModelBreakdown,
  getLatencyPercentiles,
  getCostBreakdown,
  getScoreStats,
} from '../../services/dashboard-stats.js';

const BREAKDOWNS = ['agents', 'skills', 'models', 'latency', 'cost', 'scores'] as const;
type Breakdown = typeof BREAKDOWNS[number];

export const agentPerformanceReportTool = createTool({
  id: 'system_agent_performance_report',
  description:
    'Generates agent performance report: success rate, model usage, USD cost, P50/P95/P99 latency, scorer scores. ' +
    'Use when the user asks "how the system is performing", "which agent is slowest", "how much did we spend", "which skill is most frequently used". ' +
    'Default window: last 7 days.',
  inputSchema: z.object({
    since: z.string().optional().describe('ISO date ("2026-05-01") or relative ("7d", "24h", "30m"). Default: 7d'),
    until: z.string().optional().describe('ISO date — end of the window. Default: now'),
    agentId: z.string().optional().describe('Filter results to this agent only (optional)'),
    includeBreakdown: z.array(z.enum(BREAKDOWNS)).optional().default(['agents', 'cost'])
      .describe('Which sections to calculate. Default: agents + cost'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    period: z.object({ from: z.string(), to: z.string() }),
    overview: z.object({
      totalTasks: z.number(),
      successRate: z.number(),
      totalErrors: z.number(),
      totalTokens: z.number(),
      totalCostUsd: z.number(),
      uniqueAgents: z.number(),
      uniqueModels: z.number(),
      avgLatencyMs: z.number(),
    }),
    breakdown: z.object({
      agents: z.array(z.unknown()).optional(),
      skills: z.array(z.unknown()).optional(),
      models: z.array(z.unknown()).optional(),
      latency: z.array(z.unknown()).optional(),
      cost: z.unknown().optional(),
      scores: z.array(z.unknown()).optional(),
    }),
    summary: z.string().describe('Short text summary ready for presentation to the user'),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const window = buildWindow(context.since, context.until);
      const include: Breakdown[] = (context.includeBreakdown ?? ['agents', 'cost']) as Breakdown[];

      const overview = await getOverview(window);

      // Run requested breakdowns in parallel
      const tasks: Array<Promise<{ key: Breakdown; data: unknown }>> = [];
      for (const b of include) {
        if (b === 'agents') tasks.push(getAgentSuccessRates(window).then(d => ({ key: b, data: d })));
        if (b === 'skills') tasks.push(getSkillUsageStats(window).then(d => ({ key: b, data: d })));
        if (b === 'models') tasks.push(getModelBreakdown(window).then(d => ({ key: b, data: d })));
        if (b === 'latency') tasks.push(getLatencyPercentiles(window).then(d => ({ key: b, data: d })));
        if (b === 'cost') tasks.push(getCostBreakdown(window).then(d => ({ key: b, data: d })));
        if (b === 'scores') tasks.push(getScoreStats(window).then(d => ({ key: b, data: d })));
      }

      const results = await Promise.allSettled(tasks);
      const breakdown: Record<string, unknown> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') breakdown[r.value.key] = r.value.data;
      }

      // Apply agentId filter if provided (in-memory — keep tool simple)
      if (context.agentId) {
        if (Array.isArray(breakdown.agents)) {
          breakdown.agents = (breakdown.agents as Array<{ agentId: string }>).filter(a => a.agentId === context.agentId);
        }
        if (Array.isArray(breakdown.latency)) {
          breakdown.latency = (breakdown.latency as Array<{ agentId: string }>).filter(a => a.agentId === context.agentId);
        }
      }

      const summary = buildSummary(overview, breakdown, context.agentId);

      return {
        success: true,
        period: overview.window,
        overview: {
          totalTasks: overview.totalTasks,
          successRate: Math.round(overview.successRate * 1000) / 1000,
          totalErrors: overview.totalErrors,
          totalTokens: overview.totalTokens,
          totalCostUsd: overview.totalCostUsd,
          uniqueAgents: overview.uniqueAgents,
          uniqueModels: overview.uniqueModels,
          avgLatencyMs: overview.avgLatencyMs,
        },
        breakdown,
        summary,
      };
    } catch (error) {
      return {
        success: false,
        period: { from: '', to: '' },
        overview: {
          totalTasks: 0, successRate: 0, totalErrors: 0, totalTokens: 0,
          totalCostUsd: 0, uniqueAgents: 0, uniqueModels: 0, avgLatencyMs: 0,
        },
        breakdown: {},
        summary: '',
        error: (error as Error).message,
      };
    }
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildSummary(
  overview: { totalTasks: number; successRate: number; totalCostUsd: number; avgLatencyMs: number; uniqueAgents: number; window: { from: string; to: string } },
  breakdown: Record<string, unknown>,
  agentId?: string,
 ): string {
  const lines: string[] = [];
  const period = `${overview.window.from.slice(0, 10)} → ${overview.window.to.slice(0, 10)}`;
  lines.push(`📊 **Performance report** ${agentId ? `(agent: ${agentId})` : ''} — ${period}`);

  if (overview.totalTasks === 0) {
    lines.push('No data available for this period.');
    return lines.join('\n');
  }

  lines.push(
    `Tasks: **${overview.totalTasks}** | Success: **${(overview.successRate * 100).toFixed(1)}%** | ` +
    `Cost: **$${overview.totalCostUsd.toFixed(4)}** | Avg latency: **${overview.avgLatencyMs}ms** | Agents: ${overview.uniqueAgents}`,
  );

  // Top agent
  const agents = breakdown.agents as Array<{ agentId: string; totalTasks: number; successRate: number; costUsd: number }> | undefined;
  if (agents && agents.length > 0) {
    const top = agents.slice(0, 3).map(a =>
      `  • ${a.agentId}: ${a.totalTasks} tasks, ${(a.successRate * 100).toFixed(0)}% success, $${a.costUsd.toFixed(4)}`
    );
    lines.push('**Top agents (by activity):**');
    lines.push(...top);
  }

  // Top models
  const models = breakdown.models as Array<{ model: string; invocations: number; costUsd: number }> | undefined;
  if (models && models.length > 0) {
    const top = models.slice(0, 3).map(m =>
      `  • ${m.model}: ${m.invocations}× — $${m.costUsd.toFixed(4)}`
    );
    lines.push('**Top models:**');
    lines.push(...top);
  }

  // Latency
  const latency = breakdown.latency as Array<{ agentId: string; p95: number; p99: number; count: number }> | undefined;
  if (latency && latency.length > 0) {
    const slowest = [...latency].sort((a, b) => b.p95 - a.p95)[0];
    if (slowest) {
      lines.push(`**Slowest agent (P95):** ${slowest.agentId} — ${slowest.p95}ms (P99: ${slowest.p99}ms, n=${slowest.count})`);
    }
  }

  // Cost
  const cost = breakdown.cost as { totalUsd: number; byAgent: Array<{ agentId: string; usd: number }> } | undefined;
  if (cost && cost.byAgent.length > 0) {
    const top = cost.byAgent[0]!;
    lines.push(`**Most expensive agent:** ${top.agentId} — $${top.usd.toFixed(4)}`);
  }

  // Scores
  const scores = breakdown.scores as Array<{ scorerId: string; avgScore: number; passRate: number; totalEvaluations: number }> | undefined;
  if (scores && scores.length > 0) {
    lines.push('**Scorer averages:**');
    for (const s of scores.slice(0, 5)) {
      lines.push(`  • ${s.scorerId}: avg ${s.avgScore.toFixed(2)} (pass rate ${(s.passRate * 100).toFixed(0)}%, n=${s.totalEvaluations})`);
    }
  }

  return lines.join('\n');
}
