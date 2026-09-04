#!/usr/bin/env tsx
/**
 * Deterministic contract check for the in-process DuckDB retention job.
 * Uses only a fresh in-memory database; it never opens production or staging.
 */
import assert from 'node:assert/strict';

import { DuckDBStore } from '@mastra/duckdb';

import {
  getObservabilityRetentionDays,
  isObservabilityRetentionEnabled,
  ObservabilityRetentionService,
  resolveObservabilityDuckDBPath,
} from '../services/observability-retention.js';
import { checkObservabilityRetentionAuth } from '../services/observability-retention-route.js';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const OLD = new Date('2026-08-20T12:00:00.000Z');
const RECENT = new Date('2026-08-23T12:00:00.000Z');

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

async function rows<T extends Record<string, unknown>>(
  store: DuckDBStore,
  sql: string,
): Promise<T[]> {
  return store.db.query<T>(sql);
}

async function seed(store: DuckDBStore): Promise<void> {
  // An entirely expired trace: removed.
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId) VALUES (?, ?, ?, ?)',
    ['start', OLD, 'expired-trace', 'expired-span'],
  );

  // A trace crossing the cutoff: both its old start and recent end survive.
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId, endedAt) VALUES (?, ?, ?, ?, ?)',
    ['start', OLD, 'crossing-trace', 'crossing-span', null],
  );
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId, endedAt) VALUES (?, ?, ?, ?, ?)',
    ['end', RECENT, 'crossing-trace', 'crossing-span', RECENT],
  );

  // Legacy/imported row: only endedAt crosses the cutoff. This independently
  // proves the endedAt branch without a second recent event for the trace.
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId, endedAt) VALUES (?, ?, ?, ?, ?)',
    ['end', OLD, 'ended-only-trace', 'ended-only-span', RECENT],
  );

  // A recent non-span signal also protects the full, older span history.
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId) VALUES (?, ?, ?, ?)',
    ['start', OLD, 'metric-protected-trace', 'metric-protected-span'],
  );

  // scoreTraceId is a second trace linkage and must protect that trace too.
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId) VALUES (?, ?, ?, ?)',
    ['start', OLD, 'scoring-trace', 'scoring-span'],
  );
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId) VALUES (?, ?, ?, ?)',
    ['start', OLD, 'bridge-middle-trace', 'bridge-middle-span'],
  );
  await store.db.execute(
    'INSERT INTO span_events (eventType, timestamp, traceId, spanId) VALUES (?, ?, ?, ?)',
    ['start', OLD, 'bridge-tail-trace', 'bridge-tail-span'],
  );

  await store.db.execute(
    'INSERT INTO metric_events (timestamp, metricId, traceId, name, value) VALUES (?, ?, ?, ?, ?)',
    [OLD, 'metric-expired', null, 'tokens', 1],
  );
  await store.db.execute(
    'INSERT INTO metric_events (timestamp, metricId, traceId, name, value) VALUES (?, ?, ?, ?, ?)',
    [RECENT, 'metric-recent', null, 'tokens', 2],
  );
  await store.db.execute(
    'INSERT INTO metric_events (timestamp, metricId, traceId, name, value) VALUES (?, ?, ?, ?, ?)',
    [OLD, 'metric-crossing-old', 'crossing-trace', 'tokens', 3],
  );
  await store.db.execute(
    'INSERT INTO metric_events (timestamp, metricId, traceId, name, value) VALUES (?, ?, ?, ?, ?)',
    [RECENT, 'metric-protector', 'metric-protected-trace', 'tokens', 4],
  );

  await store.db.execute(
    'INSERT INTO log_events (timestamp, logId, traceId, level, message) VALUES (?, ?, ?, ?, ?)',
    [OLD, 'log-expired', null, 'info', 'expired'],
  );
  await store.db.execute(
    'INSERT INTO log_events (timestamp, logId, traceId, level, message) VALUES (?, ?, ?, ?, ?)',
    [RECENT, 'log-recent', null, 'info', 'recent'],
  );
  await store.db.execute(
    'INSERT INTO log_events (timestamp, logId, traceId, level, message) VALUES (?, ?, ?, ?, ?)',
    [OLD, 'log-crossing-old', 'crossing-trace', 'info', 'linked'],
  );

  await store.db.execute(
    'INSERT INTO score_events (timestamp, scoreId, traceId, scoreTraceId, scorerId, score) VALUES (?, ?, ?, ?, ?, ?)',
    [OLD, 'score-expired', null, null, 'quality', 0.1],
  );
  await store.db.execute(
    'INSERT INTO score_events (timestamp, scoreId, traceId, scoreTraceId, scorerId, score) VALUES (?, ?, ?, ?, ?, ?)',
    [RECENT, 'score-recent', 'crossing-trace', 'scoring-trace', 'quality', 0.9],
  );
  await store.db.execute(
    'INSERT INTO score_events (timestamp, scoreId, traceId, scorerId, score) VALUES (?, ?, ?, ?, ?)',
    [OLD, 'score-crossing-old', 'crossing-trace', 'quality', 0.5],
  );
  // Two old score edges form a transitive bridge. The second edge is oriented
  // in the opposite direction to prove closure through both score columns.
  await store.db.execute(
    'INSERT INTO score_events (timestamp, scoreId, traceId, scoreTraceId, scorerId, score) VALUES (?, ?, ?, ?, ?, ?)',
    [OLD, 'score-bridge-middle', 'crossing-trace', 'bridge-middle-trace', 'quality', 0.6],
  );
  await store.db.execute(
    'INSERT INTO score_events (timestamp, scoreId, traceId, scoreTraceId, scorerId, score) VALUES (?, ?, ?, ?, ?, ?)',
    [OLD, 'score-bridge-tail', 'bridge-tail-trace', 'bridge-middle-trace', 'quality', 0.7],
  );

  await store.db.execute(
    'INSERT INTO feedback_events (timestamp, feedbackId, traceId, feedbackSource, feedbackType, value) VALUES (?, ?, ?, ?, ?, ?)',
    [OLD, 'feedback-expired', null, 'user', 'thumb', 'down'],
  );
  await store.db.execute(
    'INSERT INTO feedback_events (timestamp, feedbackId, traceId, feedbackSource, feedbackType, value) VALUES (?, ?, ?, ?, ?, ?)',
    [RECENT, 'feedback-recent', null, 'user', 'thumb', 'up'],
  );
  await store.db.execute(
    'INSERT INTO feedback_events (timestamp, feedbackId, traceId, feedbackSource, feedbackType, value) VALUES (?, ?, ?, ?, ?, ?)',
    [OLD, 'feedback-crossing-old', 'crossing-trace', 'user', 'thumb', 'up'],
  );
}

console.log('check:observability-retention');

await check('configuration defaults to 72 hours and has an explicit kill switch', () => {
  assert.equal(getObservabilityRetentionDays({}), 3);
  assert.equal(getObservabilityRetentionDays({ OBSERVABILITY_RETENTION_DAYS: '7' }), 7);
  assert.throws(
    () => getObservabilityRetentionDays({ OBSERVABILITY_RETENTION_DAYS: '0' }),
    /between 1 and 365/,
  );
  assert.equal(isObservabilityRetentionEnabled({}), true);
  assert.equal(isObservabilityRetentionEnabled({ OBSERVABILITY_RETENTION_ENABLED: 'false' }), false);
});

await check('the :memory: sentinel is preserved while filesystem paths are resolved', () => {
  assert.equal(resolveObservabilityDuckDBPath('/repo', { MASTRA_DUCKDB_PATH: ':memory:' }), ':memory:');
  assert.equal(
    resolveObservabilityDuckDBPath('/repo', {}),
    '/repo/storage/mastra-observability.duckdb',
  );
  assert.ok(resolveObservabilityDuckDBPath('/repo', { MASTRA_DUCKDB_PATH: './relative.duckdb' }).endsWith('/relative.duckdb'));
});

await check('maintenance auth fails closed and only accepts the configured Bearer token', () => {
  assert.equal(checkObservabilityRetentionAuth(undefined, {}), false);
  const env = { OBSERVABILITY_RETENTION_TOKEN: 'retention-secret' };
  assert.equal(checkObservabilityRetentionAuth(undefined, env), false);
  assert.equal(checkObservabilityRetentionAuth('Bearer wrong', env), false);
  assert.equal(checkObservabilityRetentionAuth('Bearer retention-secret', env), true);
});

await check('one transaction covers all five tables and preserves complete protected traces', async () => {
  const store = new DuckDBStore({ path: ':memory:' });
  const silentLogger = { info: () => undefined, error: () => undefined };
  try {
    await store.init();
    await seed(store);

    const retention = new ObservabilityRetentionService(store.db, {
      retentionDays: 3,
      logger: silentLogger,
    });

    const firstPromise = retention.run(NOW);
    const joinedPromise = retention.run(NOW);
    assert.strictEqual(joinedPromise, firstPromise, 'concurrent callers must join one in-flight cleanup');
    const first = await firstPromise;

    assert.deepEqual(first.deleted, {
      span_events: 1,
      metric_events: 1,
      log_events: 1,
      score_events: 1,
      feedback_events: 1,
    });
    assert.equal(first.deletedTotal, 5);
    assert.equal(first.cutoff, '2026-08-21T12:00:00.000Z');
    assert.equal(first.protectedTraceCount, 6);

    assert.deepEqual(
      (await rows<{ traceId: string }>(store, 'SELECT traceId FROM span_events ORDER BY traceId, timestamp'))
        .map((row) => row.traceId),
      [
        'bridge-middle-trace',
        'bridge-tail-trace',
        'crossing-trace',
        'crossing-trace',
        'ended-only-trace',
        'metric-protected-trace',
        'scoring-trace',
      ],
    );
    assert.deepEqual(
      (await rows<{ metricId: string }>(store, 'SELECT metricId FROM metric_events ORDER BY metricId'))
        .map((row) => row.metricId),
      ['metric-crossing-old', 'metric-protector', 'metric-recent'],
    );
    assert.deepEqual(
      (await rows<{ logId: string }>(store, 'SELECT logId FROM log_events ORDER BY logId'))
        .map((row) => row.logId),
      ['log-crossing-old', 'log-recent'],
    );
    assert.deepEqual(
      (await rows<{ scoreId: string }>(store, 'SELECT scoreId FROM score_events ORDER BY scoreId'))
        .map((row) => row.scoreId),
      ['score-bridge-middle', 'score-bridge-tail', 'score-crossing-old', 'score-recent'],
    );
    assert.deepEqual(
      (await rows<{ feedbackId: string }>(store, 'SELECT feedbackId FROM feedback_events ORDER BY feedbackId'))
        .map((row) => row.feedbackId),
      ['feedback-crossing-old', 'feedback-recent'],
    );

    const second = await retention.run(NOW);
    assert.equal(second.deletedTotal, 0, 'an immediate replay must be idempotent');
    assert.deepEqual(second.deleted, {
      span_events: 0,
      metric_events: 0,
      log_events: 0,
      score_events: 0,
      feedback_events: 0,
    });
  } finally {
    await store.db.close();
  }
});

await check('a mid-cleanup SQL failure rolls back earlier table deletions', async () => {
  const store = new DuckDBStore({ path: ':memory:' });
  const silentLogger = { info: () => undefined, error: () => undefined };
  try {
    await store.init();
    await store.db.execute(
      'INSERT INTO span_events (eventType, timestamp, traceId, spanId) VALUES (?, ?, ?, ?)',
      ['start', OLD, 'rollback-trace', 'rollback-span'],
    );
    await store.db.execute(
      'INSERT INTO metric_events (timestamp, metricId, name, value) VALUES (?, ?, ?, ?)',
      [OLD, 'rollback-metric', 'tokens', 1],
    );
    await store.db.execute(
      'INSERT INTO log_events (timestamp, logId, level, message) VALUES (?, ?, ?, ?)',
      [OLD, 'rollback-log', 'info', 'must survive rollback'],
    );

    // The protected-ID SELECT can read this shape, but DELETE against a view
    // fails only after span/metric/log DELETEs have already run.
    await store.db.execute('DROP TABLE score_events');
    await store.db.execute(`
      CREATE VIEW score_events AS
      SELECT
        NULL::TIMESTAMP AS timestamp,
        NULL::VARCHAR AS traceId,
        NULL::VARCHAR AS scoreTraceId
      WHERE false
    `);

    const retention = new ObservabilityRetentionService(store.db, {
      retentionDays: 3,
      logger: silentLogger,
    });
    await assert.rejects(() => retention.run(NOW));

    assert.equal((await rows<{ count: number }>(store, 'SELECT count(*) AS count FROM span_events'))[0]?.count, 1);
    assert.equal((await rows<{ count: number }>(store, 'SELECT count(*) AS count FROM metric_events'))[0]?.count, 1);
    assert.equal((await rows<{ count: number }>(store, 'SELECT count(*) AS count FROM log_events'))[0]?.count, 1);
  } finally {
    await store.db.close();
  }
});

if (failures > 0) {
  console.error(`\n${failures} observability-retention check(s) failed.`);
  process.exit(1);
}

console.log('\nAll observability-retention checks passed.');
