#!/usr/bin/env tsx
/**
 * F5 — the operator READ view over durable orchestration V2 jobs.
 *
 * A durable job you cannot observe is a durable job you cannot trust, so this
 * covers the reader against a REAL replica-set database (throwaway, dropped on
 * exit), plus the two states that are easy to get wrong and would mislead an
 * operator rather than merely fail:
 *
 *  1. FLAG OFF must be reported as `enabled: false`, NOT as an empty board.
 *     "The substrate is not running" and "it is running with no work" look
 *     identical on a naive dashboard, and today production is the former.
 *  2. COUNTS describe the whole filtered board, not the returned page —
 *     otherwise a `limit` silently understates how much work exists.
 *
 * It also pins the read-only property: rendering the board must not create,
 * wake or mutate anything.
 *
 * Run: npx tsx src/mastra/scripts/check-dashboard-orchestration.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { replicaSetUriOrSkip } from './lib/replica-set.js';

const TEST_DATABASE = `dob_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

// Resolved before anything is wired up: a mount pointed at a dead server would
// fail every assertion below for the wrong reason.
const resolvedRsUri = await replicaSetUriOrSkip('check:dashboard-orchestration');
if (!resolvedRsUri) process.exit(0);
const RS_URI: string = resolvedRsUri;

const { configureV2Mount, __closeV2Store } = await import('../orchestration/http/mastra-routes.js');
configureV2Mount({ uri: RS_URI, dbName: TEST_DATABASE, startBackground: false });

const dashboard = await import('../services/dashboard-orchestration.js');
const { connectV2Store, acceptStartCommand, cancelJob } = await import('../orchestration/store/index.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log('check:dashboard-orchestration');

  await check('flag OFF reports DISABLED, not an empty board (production today)', async () => {
    delete process.env.FEATURE_ORCHESTRATION_V2;
    const summary = await dashboard.getOrchestrationDashboardSummary();
    assert.equal(summary.enabled, false, 'the UI must be able to say "disabled" rather than "no jobs"');
    assert.equal(summary.jobs.length, 0);
    assert.equal(summary.counts.total, 0);

    const detail = await dashboard.getOrchestrationDashboardJob('job_whatever');
    assert.equal(detail, null, 'detail must not reach for a store that is switched off');
  });

  process.env.FEATURE_ORCHESTRATION_V2 = 'true';

  const store = await connectV2Store({ uri: RS_URI, dbName: TEST_DATABASE });
  const conversationA = `conv_${randomUUID()}`;
  const conversationB = `conv_${randomUUID()}`;
  const owner = 'agent:metaAgent';
  const jobIds: string[] = [];

  for (let index = 0; index < 3; index++) {
    const accepted = await acceptStartCommand(store.client, store.db, {
      resourceId: owner,
      conversationId: index === 2 ? conversationB : conversationA,
      goal: index === 0 ? 'x'.repeat(400) : `dashboard probe ${index}`,
      commandId: `cmd_${randomUUID()}`,
      payload: { goal: `probe ${index}` },
    });
    jobIds.push(accepted.jobId);
  }

  await check('an empty-ish board reports enabled with real counts', async () => {
    const summary = await dashboard.getOrchestrationDashboardSummary();
    assert.equal(summary.enabled, true);
    assert.equal(summary.counts.total, 3);
    assert.equal(summary.counts.terminal, 0);
    assert.equal(summary.counts.running, 3, 'nothing is terminal yet, so all three are outstanding');
    assert.equal(summary.jobs.length, 3);
  });

  await check('a long goal is truncated in the list but intact in the detail view', async () => {
    const summary = await dashboard.getOrchestrationDashboardSummary();
    const long = summary.jobs.find((j) => j.jobId === jobIds[0]);
    assert.ok(long, 'the job must be listed');
    assert.equal(long.goalTruncated, true);
    assert.ok(long.goal.length < 400, 'the list view must not dump the whole goal');

    const detail = await dashboard.getOrchestrationDashboardJob(jobIds[0]!);
    assert.ok(detail);
    assert.equal(detail.fullGoal.length, 400, 'the detail view must carry the untruncated goal');
  });

  await check('filtering by conversation narrows both the rows AND the counts', async () => {
    const summary = await dashboard.getOrchestrationDashboardSummary({ conversationId: conversationB });
    assert.equal(summary.jobs.length, 1);
    assert.equal(summary.counts.total, 1, 'counts must respect the filter, not report the whole board');
    assert.equal(summary.jobs[0]!.conversationId, conversationB);
  });

  await check('counts describe the whole board even when the page is limited', async () => {
    const summary = await dashboard.getOrchestrationDashboardSummary({ limit: 1 });
    assert.equal(summary.jobs.length, 1, 'the page is limited');
    assert.equal(summary.counts.total, 3, 'but the count must still report every job, or the operator is misled');
  });

  await check('a cancelled job is reflected in the outcome counts', async () => {
    await cancelJob(store.client, store.db, {
      resourceId: owner,
      commandId: `cancel_${randomUUID()}`,
      jobId: jobIds[1]!,
    });
    const summary = await dashboard.getOrchestrationDashboardSummary();
    assert.equal(summary.counts.cancelled, 1, 'the cancelled job must show up as cancelled');
    const row = summary.jobs.find((j) => j.jobId === jobIds[1]);
    assert.ok(row);
    assert.ok(
      row.terminalOutcome === 'CANCELLED' || row.pendingTerminalOutcome === 'CANCELLED',
      `expected the row to show the cancellation, got ${JSON.stringify(row)}`,
    );
  });

  await check('an unknown job is a clean null, not an error', async () => {
    assert.equal(await dashboard.getOrchestrationDashboardJob(`job_${randomUUID()}`), null);
  });

  await check('READ-ONLY: rendering the board mutates nothing', async () => {
    const before = await store.db.collection('orch_jobs')
      .find({}, { projection: { _id: 1, stateVersion: 1, phase: 1 } }).sort({ _id: 1 }).toArray();
    const eventsBefore = await store.db.collection('orch_job_events').countDocuments();

    await dashboard.getOrchestrationDashboardSummary();
    await dashboard.getOrchestrationDashboardJob(jobIds[0]!);

    const after = await store.db.collection('orch_jobs')
      .find({}, { projection: { _id: 1, stateVersion: 1, phase: 1 } }).sort({ _id: 1 }).toArray();
    const eventsAfter = await store.db.collection('orch_job_events').countDocuments();

    assert.deepEqual(after, before, 'reading the dashboard must not change any job');
    assert.equal(eventsAfter, eventsBefore, 'reading the dashboard must not emit events (no wake)');
  });

  await store.close();
  await __closeV2Store().catch(() => undefined);
  const cleanup = await connectV2Store({ uri: RS_URI, dbName: TEST_DATABASE });
  await cleanup.db.dropDatabase().catch(() => undefined);
  await cleanup.close();

  if (failures > 0) {
    console.error(`\n❌ check:dashboard-orchestration — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:dashboard-orchestration — the operator can see V2 jobs, and "switched off" is distinguishable from "no work"');
  process.exit(0);
}

main().catch((error) => { console.error(`check failed: ${(error as Error).message}`); process.exit(1); });
