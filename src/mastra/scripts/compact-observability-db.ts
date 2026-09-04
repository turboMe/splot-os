import { DuckDBStore } from '@mastra/duckdb';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = path.resolve('storage/mastra-observability.duckdb');
const COMPACT_PATH = path.resolve('storage/mastra-observability.compact.duckdb');
const WAL_PATH = path.resolve('storage/mastra-observability.duckdb.wal');

async function compact() {
  console.log(`[compact-db] Starting compaction of ${DB_PATH}...`);
  const initialStat = fs.statSync(DB_PATH);
  console.log(`[compact-db] Original size: ${(initialStat.size / (1024 * 1024 * 1024)).toFixed(2)} GB`);

  if (fs.existsSync(COMPACT_PATH)) {
    fs.unlinkSync(COMPACT_PATH);
  }

  const store = new DuckDBStore({ path: DB_PATH });
  const conn = await store.db.getConnection();

  try {
    console.log('[compact-db] Attaching new compact database...');
    await conn.run(`ATTACH '${COMPACT_PATH}' AS compact_db;`);

    console.log('[compact-db] Copying metric_events...');
    await conn.run('CREATE TABLE compact_db.metric_events AS SELECT * FROM metric_events;');

    console.log('[compact-db] Copying log_events...');
    await conn.run('CREATE TABLE compact_db.log_events AS SELECT * FROM log_events;');

    console.log('[compact-db] Copying feedback_events...');
    await conn.run('CREATE TABLE compact_db.feedback_events AS SELECT * FROM feedback_events;');

    console.log('[compact-db] Copying score_events...');
    await conn.run('CREATE TABLE compact_db.score_events AS SELECT * FROM score_events;');

    console.log('[compact-db] Copying recent span_events (last 3 days) with truncated bulky payloads...');
    // Keep traces from last 3 days, truncate input/output if > 4096 chars to eliminate 670KB dumps
    await conn.run(`
      CREATE TABLE compact_db.span_events AS
      SELECT
        eventType,
        timestamp,
        traceId,
        spanId,
        parentSpanId,
        experimentId,
        entityType,
        entityId,
        entityName,
        entityVersionId,
        userId,
        organizationId,
        resourceId,
        runId,
        sessionId,
        threadId,
        requestId,
        environment,
        source,
        serviceName,
        requestContext,
        name,
        spanType,
        isEvent,
        endedAt,
        attributes,
        metadata,
        tags,
        scope,
        links,
        CASE
          WHEN length(input::VARCHAR) > 4096
          THEN ('"TRUNCATED_DURING_COMPACTION (' || length(input::VARCHAR) || ' bytes)"')::JSON
          ELSE input
        END AS input,
        CASE
          WHEN length(output::VARCHAR) > 4096
          THEN ('"TRUNCATED_DURING_COMPACTION (' || length(output::VARCHAR) || ' bytes)"')::JSON
          ELSE output
        END AS output,
        error
      FROM span_events
      WHERE timestamp >= (now() - INTERVAL '3 days');
    `);

    console.log('[compact-db] Detaching compact database...');
    await conn.run('DETACH compact_db;');

    conn.closeSync();
  } catch (err) {
    conn.closeSync();
    if (fs.existsSync(COMPACT_PATH)) {
      fs.unlinkSync(COMPACT_PATH);
    }
    throw err;
  }

  const newStat = fs.statSync(COMPACT_PATH);
  console.log(`[compact-db] Compacted size: ${(newStat.size / (1024 * 1024)).toFixed(2)} MB`);

  // Atomic swap
  const backupPath = `${DB_PATH}.bak`;
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
  fs.renameSync(DB_PATH, backupPath);
  fs.renameSync(COMPACT_PATH, DB_PATH);
  if (fs.existsSync(WAL_PATH)) {
    fs.unlinkSync(WAL_PATH);
  }
  // Remove backup to free disk space
  fs.unlinkSync(backupPath);

  console.log(`[compact-db] Compaction complete! Freed ${((initialStat.size - newStat.size) / (1024 * 1024 * 1024)).toFixed(2)} GB!`);

  console.log('[compact-db] Ensuring primary keys exist on signal tables via migrateSpans...');
  const verifyStore = new DuckDBStore({ path: DB_PATH });
  const verifyObsStore = await verifyStore.getStore('observability');
  await (verifyObsStore as any).migrateSpans?.();
  console.log('[compact-db] Signal tables verified.');
}

compact().catch((err) => {
  console.error('[compact-db] Compaction failed:', err);
  process.exit(1);
});
