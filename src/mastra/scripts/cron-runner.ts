#!/usr/bin/env tsx
/**
 * Script: cron-runner
 * Uruchamia workflowy GastroBridge na podstawie harmonogramów.
 *
 * Uruchamiaj równolegle z `mastra dev` lub `mastra start`:
 *   npx tsx src/mastra/scripts/cron-runner.ts
 *
 * Alternatywnie zdefiniuj systemowy crontab / n8n schedule workflow,
 * który wywoła POST na endpoint Mastra:
 *   POST http://localhost:4111/api/workflows/{workflowId}/start
 *
 * Harmonogram:
 *   - morning-briefing:   codziennie 08:00
 *   - automated-followup: codziennie 10:00
 *   - sync-crm:           co 4h (8, 12, 16, 20)
 *   - inbox-monitor:      co 2h (8..22)
 *   - weekly-report:      poniedziałek 09:00
 *   - trend-analysis:     poniedziałek 10:00
 *   - roi-calculator:     pierwszy dzień miesiąca 07:00
 *   - DuckDB retention:   codziennie 02:10
 */

import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { ledgerRecordEphemeral } from '../services/task-ledger.js';
import {
  isObservabilityRetentionEnabled,
  OBSERVABILITY_RETENTION_ROUTE,
  type ObservabilityRetentionResult,
} from '../services/observability-retention.js';

const MASTRA_BASE_URL = process.env.MASTRA_URL ?? 'http://localhost:4111';

// ── HTTP helper ────────────────────────────────────────────────────────────
async function triggerWorkflow(
  workflowId: string,
  inputData: Record<string, unknown> = {},
): Promise<void> {
  const laneBase = {
    source: 'cron' as const,
    sourceId: `${workflowId}-${Date.now()}`,
    goal: `cron trigger: ${workflowId}`,
  };

  try {
    // Try start-async endpoint first (direct start without separate create-run step)
    const startAsyncUrl = `${MASTRA_BASE_URL}/api/workflows/${workflowId}/start-async`;
    const startAsyncRes = await fetch(startAsyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputData }),
    });

    if (startAsyncRes.ok) {
      const resJson = (await startAsyncRes.json().catch(() => ({}))) as { runId?: string };
      const runId = resJson.runId ?? 'async';
      console.log(`[cron] ✅ ${workflowId} started async — runId=${runId}`);
      void ledgerRecordEphemeral({
        ...laneBase,
        outcome: 'done',
        milestone: `workflow triggered async (runId=${runId})`,
      });
      return;
    }

    // Fallback: create-run with explicit runId then start
    const generatedRunId = randomUUID();
    const createRunUrl = `${MASTRA_BASE_URL}/api/workflows/${workflowId}/create-run?runId=${encodeURIComponent(generatedRunId)}`;
    const createRunRes = await fetch(createRunUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!createRunRes.ok) {
      const text = await createRunRes.text();
      console.error(`[cron] ❌ ${workflowId} create-run HTTP ${createRunRes.status}: ${text.slice(0, 200)}`);
      void ledgerRecordEphemeral({
        ...laneBase,
        outcome: 'failed',
        error: `create-run HTTP ${createRunRes.status}: ${text.slice(0, 200)}`,
      });
      return;
    }

    const runJson = (await createRunRes.json().catch(() => ({}))) as { runId?: string };
    const runId = runJson.runId || generatedRunId;

    // Step 2: Start workflow with runId and inputData
    const startUrl = `${MASTRA_BASE_URL}/api/workflows/${workflowId}/start?runId=${encodeURIComponent(runId)}`;
    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputData }),
    });

    if (!startRes.ok) {
      const text = await startRes.text();
      console.error(`[cron] ❌ ${workflowId} start HTTP ${startRes.status}: ${text.slice(0, 200)}`);
      void ledgerRecordEphemeral({
        ...laneBase,
        outcome: 'failed',
        error: `start HTTP ${startRes.status}: ${text.slice(0, 200)}`,
      });
    } else {
      console.log(`[cron] ✅ ${workflowId} started — runId=${runId}`);
      void ledgerRecordEphemeral({
        ...laneBase,
        outcome: 'done',
        milestone: `workflow triggered (runId=${runId})`,
      });
    }
  } catch (err) {
    console.error(`[cron] ❌ ${workflowId} fetch error:`, (err as Error).message);
    void ledgerRecordEphemeral({
      ...laneBase,
      outcome: 'failed',
      error: `cron trigger fetch error: ${(err as Error).message}`,
    });
  }
}

async function triggerObservabilityRetention(): Promise<void> {
  const url = `${MASTRA_BASE_URL}${OBSERVABILITY_RETENTION_ROUTE}`;
  const token = process.env.OBSERVABILITY_RETENTION_TOKEN?.trim();
  const sourceId = `observability-retention-${Date.now()}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[cron] ❌ observability retention HTTP ${res.status}: ${text.slice(0, 500)}`);
      void ledgerRecordEphemeral({
        source: 'cron',
        sourceId,
        goal: 'DuckDB observability retention',
        outcome: 'failed',
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      });
      return;
    }

    const result = JSON.parse(text) as ObservabilityRetentionResult;
    console.log(
      `[cron] ✅ observability retention completed — cutoff=${result.cutoff} ` +
      `deleted=${result.deletedTotal} checkpoint=${result.checkpointDurationMs}ms`,
    );
    void ledgerRecordEphemeral({
      source: 'cron',
      sourceId,
      goal: 'DuckDB observability retention',
      outcome: 'done',
      milestone: `deleted ${result.deletedTotal} events; cutoff=${result.cutoff}`,
    });
  } catch (err) {
    console.error('[cron] ❌ observability retention fetch error:', (err as Error).message);
    void ledgerRecordEphemeral({
      source: 'cron',
      sourceId,
      goal: 'DuckDB observability retention',
      outcome: 'failed',
      error: (err as Error).message,
    });
  }
}

// ── Schedule definitions ───────────────────────────────────────────────────
interface ScheduleRule {
  /** Human-readable name for logging */
  name: string;
  /** workflowId as registered in index.ts */
  workflowId: string;
  /** Input data passed to the workflow */
  input?: Record<string, unknown>;
  /** Return true when this rule should fire (checked every minute) */
  matches: (now: Date) => boolean;
}

const SCHEDULES: ScheduleRule[] = [
  // Daily briefing — 08:00
  {
    name: 'morning-briefing',
    workflowId: 'morning-briefing',
    input: { maxArticles: 10, includeCrm: true },
    matches: (d) => d.getHours() === 8 && d.getMinutes() === 0,
  },
  // Automated follow-up drafts — 10:00 daily
  {
    name: 'automated-followup',
    workflowId: 'automated-followup',
    input: { daysWithoutResponse: 7, maxLeads: 10, status: 'sent' },
    matches: (d) => d.getHours() === 10 && d.getMinutes() === 0,
  },
  // Inbox monitor — every 2h (8, 10, 12, 14, 16, 18, 20, 22)
  {
    name: 'inbox-monitor',
    workflowId: 'inbox-monitor',
    input: { hoursBack: 2, maxResults: 20 },
    matches: (d) => d.getHours() % 2 === 0 && d.getMinutes() === 30,
  },
  // Sync Gmail → CRM — every 4h (8, 12, 16, 20)
  {
    name: 'sync-crm',
    workflowId: 'sync-crm',
    input: { hoursBack: 4, maxEmails: 50 },
    matches: (d) => d.getHours() % 4 === 0 && d.getMinutes() === 15,
  },
  // Weekly report — Monday 09:00
  {
    name: 'weekly-report',
    workflowId: 'weekly-report',
    input: { periodDays: 7 },
    matches: (d) => d.getDay() === 1 && d.getHours() === 9 && d.getMinutes() === 0,
  },
  // Trend analysis — Monday 10:00
  {
    name: 'trend-analysis',
    workflowId: 'trend-analysis',
    input: { periodDays: 14, comparisonPeriodDays: 14 },
    matches: (d) => d.getDay() === 1 && d.getHours() === 10 && d.getMinutes() === 0,
  },
  // ROI calculator — 1st day of month 07:00
  {
    name: 'roi-calculator',
    workflowId: 'roi-calculator',
    input: { periodDays: 30, costPerMillionTokens: 0.15, avgDealValuePLN: 5000 },
    matches: (d) => d.getDate() === 1 && d.getHours() === 7 && d.getMinutes() === 0,
  },
];

// ── Tick every minute ──────────────────────────────────────────────────────
let lastTickMinute = -1;

function tick() {
  const now = new Date();
  const minuteKey = now.getHours() * 60 + now.getMinutes();

  // Prevent double-firing within the same minute
  if (minuteKey === lastTickMinute) return;
  lastTickMinute = minuteKey;

  for (const rule of SCHEDULES) {
    if (rule.matches(now)) {
      const ts = now.toISOString().slice(11, 16);
      console.log(`[cron] 🕐 ${ts} → triggering ${rule.name}`);
      void triggerWorkflow(rule.workflowId, rule.input ?? {});
    }
  }

  // The external cron process only sends the trigger. The destructive SQL is
  // deliberately executed inside Mastra through its already-open DuckDB
  // instance, avoiding a second-process writer lock conflict.
  if (
    isObservabilityRetentionEnabled()
    && now.getHours() === 2
    && now.getMinutes() === 10
  ) {
    if (!process.env.OBSERVABILITY_RETENTION_TOKEN?.trim()) {
      console.error('[cron] ❌ observability retention skipped — OBSERVABILITY_RETENTION_TOKEN is missing');
    } else {
      console.log('[cron] 🧽 daily DuckDB observability retention');
      void triggerObservabilityRetention();
    }
  }

  // Agent Board refresh (Etap 2) — Monday 07:30, runs in-process (no workflow).
  if (now.getDay() === 1 && now.getHours() === 7 && now.getMinutes() === 30) {
    console.log('[cron] 🗂️ weekly Agent Board refresh');
    void import('./build-agent-board.js')
      .then(({ buildAgentBoard }) => buildAgentBoard())
      .then(({ mongoOk }) => console.log(`[cron] ✅ agent board refreshed (mongo=${mongoOk})`))
      .catch((err) => console.error('[cron] ❌ agent board refresh failed:', (err as Error).message));
  }

  // Nightly skill distillation (Etap 6) — 03:00 daily, on the local model (~$0).
  if (now.getHours() === 3 && now.getMinutes() === 0) {
    console.log('[cron] 🌙 nightly skill distillation');
    void import('./skill-nightly-cycle.js')
      .then(({ runNightlySkillCycle }) => runNightlySkillCycle())
      .catch((err) => console.error('[cron] ❌ nightly distillation failed:', (err as Error).message));
  }

  // Weekly skill curator (Etap 6) — Sunday 04:00 (stale/archive/repair).
  if (now.getDay() === 0 && now.getHours() === 4 && now.getMinutes() === 0) {
    console.log('[cron] 🧹 weekly skill curator');
    void import('./skill-nightly-cycle.js')
      .then(({ runWeeklyCurator }) => runWeeklyCurator())
      .catch((err) => console.error('[cron] ❌ skill curator failed:', (err as Error).message));
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`[cron] 🚀 GastroBridge cron runner started`);
console.log(`[cron] 🔗 Mastra URL: ${MASTRA_BASE_URL}`);
console.log(`[cron] 📅 ${SCHEDULES.length} schedules active:\n`);
for (const s of SCHEDULES) {
  console.log(`  • ${s.name}`);
}
const retentionScheduleStatus = !isObservabilityRetentionEnabled()
  ? 'disabled'
  : process.env.OBSERVABILITY_RETENTION_TOKEN?.trim()
    ? 'daily 02:10'
    : 'blocked: missing OBSERVABILITY_RETENTION_TOKEN';
console.log(`  • observability-retention (${retentionScheduleStatus})`);
console.log();

// First tick immediately so we pick up any jobs that should run at startup
tick();

// Then every 30s (two checks per minute to avoid drift)
setInterval(tick, 30_000);

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n[cron] 👋 Shutting down...');
  process.exit(0);
});
