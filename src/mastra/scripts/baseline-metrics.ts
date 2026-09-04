#!/usr/bin/env tsx
/**
 * baseline:metrics — Etap 0 planu IDEALSYSTEMMASTERPLAN.md.
 *
 * Snapshot of the system's current behaviour so every later stage can be
 * measured against a number, not an opinion (Część C2.4 of the master plan).
 *
 * Reads durable telemetry only (Mongo `agent_events` + `mastra_scorers` via
 * services/dashboard-stats.ts). The in-memory budget-tracker is intentionally
 * NOT a source — it resets on restart; costs here come from tokenUsage ×
 * lib/model-pricing.ts, same as the performance-report tool.
 *
 * Metrics per window (7d and 30d):
 *   - overview            — tasks, success rate, tokens, cost, latency
 *   - metaTurns           — tokens/turn of meta-agent (task_completed events)
 *   - delegations         — count, success rate, duration percentiles per target agent
 *   - agents / models     — per-agent and per-model breakdowns
 *   - scorers             — scorer averages
 *
 * Output: reports/baseline/baseline-metrics-<YYYY-MM-DD>.json + stdout summary.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../lib/mongo.js';
import { calculateCost } from '../lib/model-pricing.js';
import {
  buildWindow,
  getOverview,
  getAgentSuccessRates,
  getModelBreakdown,
  getLatencyPercentiles,
  getCostBreakdown,
  getScoreStats,
  type TimeWindow,
} from '../services/dashboard-stats.js';

const META_AGENT_ID = 'meta-agent';
const WINDOWS = ['7d', '30d'] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: sorted.length ? Math.round(sum / sorted.length) : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

// ── Meta tokens/turn ─────────────────────────────────────────────────────────
// One task_completed/task_failed event per meta turn carries the cumulative
// tokenUsage of that turn (verified against live data: llm_call_completed
// events do NOT carry tokenUsage — task-level events do).

async function getMetaTurnStats(window: TimeWindow) {
  const db = await getDb();
  const docs = await db.collection('agent_events')
    .find({
      agentId: META_AGENT_ID,
      type: { $in: ['task_completed', 'task_failed'] },
      timestamp: { $gte: window.from, $lt: window.to },
    })
    .project({ tokenUsage: 1, durationMs: 1, model: 1, type: 1 })
    .toArray();

  const prompt: number[] = [];
  const completion: number[] = [];
  const duration: number[] = [];
  let costUsd = 0;
  let completed = 0;

  for (const d of docs) {
    if (d.type === 'task_completed') completed += 1;
    const p = d.tokenUsage?.prompt ?? 0;
    const c = d.tokenUsage?.completion ?? 0;
    if (p > 0 || c > 0) {
      prompt.push(p);
      completion.push(c);
      if (d.model) costUsd += calculateCost(d.model, p, c);
    }
    if (typeof d.durationMs === 'number' && d.durationMs > 0) duration.push(d.durationMs);
  }

  return {
    turns: docs.length,
    completed,
    failed: docs.length - completed,
    promptTokensPerTurn: stats(prompt),
    completionTokensPerTurn: stats(completion),
    durationMsPerTurn: stats(duration),
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };
}

// ── Delegation timings ───────────────────────────────────────────────────────
// `delegation` events are logged by delegate-task with agentId = TARGET agent
// and durationMs = wall time of the whole delegation.

async function getDelegationStats(window: TimeWindow) {
  const db = await getDb();
  const docs = await db.collection('agent_events')
    .find({ type: 'delegation', timestamp: { $gte: window.from, $lt: window.to } })
    .project({ agentId: 1, status: 1, durationMs: 1 })
    .toArray();

  const byTarget = new Map<string, { durations: number[]; ok: number; total: number }>();
  for (const d of docs) {
    const key = d.agentId ?? 'unknown';
    const entry = byTarget.get(key) ?? { durations: [], ok: 0, total: 0 };
    entry.total += 1;
    if (d.status === 'success') entry.ok += 1;
    if (typeof d.durationMs === 'number' && d.durationMs > 0) entry.durations.push(d.durationMs);
    byTarget.set(key, entry);
  }

  const perTarget = [...byTarget.entries()]
    .map(([agentId, e]) => ({
      agentId,
      total: e.total,
      successRate: e.total ? Math.round((e.ok / e.total) * 1000) / 1000 : 0,
      durationMs: stats(e.durations),
    }))
    .sort((a, b) => b.total - a.total);

  const allDurations = docs
    .map(d => d.durationMs)
    .filter((v): v is number => typeof v === 'number' && v > 0);

  return {
    total: docs.length,
    successRate: docs.length
      ? Math.round((docs.filter(d => d.status === 'success').length / docs.length) * 1000) / 1000
      : 0,
    durationMs: stats(allDurations),
    perTarget,
  };
}

// ── Snapshot per window ──────────────────────────────────────────────────────

async function snapshotWindow(since: string) {
  const window = buildWindow(since);
  const [overview, metaTurns, delegations, agents, models, latency, cost, scores] = await Promise.all([
    getOverview(window),
    getMetaTurnStats(window),
    getDelegationStats(window),
    getAgentSuccessRates(window),
    getModelBreakdown(window),
    getLatencyPercentiles(window),
    getCostBreakdown(window),
    getScoreStats(window),
  ]);

  const costPerTask = overview.totalTasks > 0
    ? Math.round((overview.totalCostUsd / overview.totalTasks) * 1_000_000) / 1_000_000
    : 0;

  return { window: overview.window, overview, costPerTask, metaTurns, delegations, agents, models, latency, cost, scores };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { /* not fatal — baseline still valid without commit hash */ }

  const result: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    gitCommit,
    notes: [
      'Etap 0 baseline (IDEALSYSTEMMASTERPLAN.md). Source: Mongo agent_events + mastra_scorers.',
      'agent_events has a 30-day TTL — the 30d window is the maximum usable horizon.',
      'budget-tracker is in-memory (resets on restart) and is not used here.',
    ],
    windows: {} as Record<string, unknown>,
  };

  for (const w of WINDOWS) {
    (result.windows as Record<string, unknown>)[w] = await snapshotWindow(w);
  }

  const outDir = path.resolve('reports/baseline');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `baseline-metrics-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2));

  const w30 = (result.windows as Record<string, any>)['30d'];
  console.log(`✅ Baseline written to ${outFile}`);
  console.log(`   [30d] tasks=${w30.overview.totalTasks} successRate=${(w30.overview.successRate * 100).toFixed(1)}% ` +
    `costUsd=${w30.overview.totalCostUsd} costPerTask=${w30.costPerTask}`);
  console.log(`   [30d] meta: ${w30.metaTurns.turns} turns, avg prompt ${w30.metaTurns.promptTokensPerTurn.avg} tok/turn ` +
    `(p95 ${w30.metaTurns.promptTokensPerTurn.p95}), avg completion ${w30.metaTurns.completionTokensPerTurn.avg} tok/turn`);
  console.log(`   [30d] delegations: ${w30.delegations.total} total, ${(w30.delegations.successRate * 100).toFixed(1)}% ok, ` +
    `avg ${Math.round(w30.delegations.durationMs.avg / 1000)}s, p95 ${Math.round(w30.delegations.durationMs.p95 / 1000)}s`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ baseline-metrics failed:', err);
  process.exit(1);
});
