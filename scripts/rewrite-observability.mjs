#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [sourceArg, destinationArg, cutoffArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg || !cutoffArg) {
  throw new Error('usage: rewrite-observability.mjs SOURCE DESTINATION CUTOFF_ISO_UTC');
}

const source = path.resolve(sourceArg);
const destination = path.resolve(destinationArg);
const cutoffDate = new Date(cutoffArg);
if (!Number.isFinite(cutoffDate.getTime()) || !cutoffArg.endsWith('Z')) {
  throw new Error(`cutoff must be a valid UTC ISO timestamp ending in Z: ${cutoffArg}`);
}
if (!fs.statSync(source).isFile()) throw new Error(`source is not a file: ${source}`);
if (source === destination) throw new Error('source and destination must differ');
for (const candidate of [destination, `${destination}.wal`]) {
  if (fs.existsSync(candidate)) throw new Error(`refusing to overwrite: ${candidate}`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRequire = createRequire(path.join(repoRoot, 'package.json'));
const importFromRepo = async packageName => {
  const entry = repoRequire.resolve(packageName);
  return import(pathToFileURL(entry).href);
};
const [{ DuckDBStore }, { DuckDBInstance }] = await Promise.all([
  importFromRepo('@mastra/duckdb'),
  importFromRepo('@duckdb/node-api'),
]);

const sqlString = value => `'${value.replaceAll("'", "''")}'`;
const sourceSql = sqlString(source);
const cutoffIso = cutoffDate.toISOString();
const cutoffSql = `TIMESTAMP ${sqlString(cutoffIso.replace('T', ' ').replace('Z', ''))}`;
const tables = ['span_events', 'metric_events', 'log_events', 'score_events', 'feedback_events'];
const jsonReplacer = (_key, value) => typeof value === 'bigint' ? value.toString() : value;
const startedAt = Date.now();

const store = new DuckDBStore({ id: 'observability-retention-rewrite', path: destination });
await store.observability.init();
const connection = await store.db.getConnection();
let attached = false;

const queryObjects = async sql => {
  const result = await connection.run(sql);
  return result.getRowObjects();
};

try {
  await connection.run(`ATTACH ${sourceSql} AS source_db (READ_ONLY)`);
  attached = true;
  const databases = await queryObjects('SELECT database_name FROM duckdb_databases()');
  const targetDatabase = databases
    .map(row => row.database_name)
    .find(name => name !== 'source_db' && name !== 'system' && name !== 'temp');
  if (!targetDatabase) throw new Error('cannot identify destination database');

  for (const table of tables) {
    const columns = await queryObjects(`
      SELECT database_name, column_index, column_name, data_type, is_nullable
      FROM duckdb_columns()
      WHERE schema_name = 'main' AND table_name = ${sqlString(table)}
        AND database_name IN (${sqlString(targetDatabase)}, 'source_db')
      ORDER BY database_name, column_index
    `);
    const normalizeColumns = databaseName => columns
      .filter(row => row.database_name === databaseName)
      .map(({ column_index, column_name, data_type, is_nullable }) => ({
        column_index: Number(column_index), column_name, data_type, is_nullable,
      }));
    const targetColumns = normalizeColumns(targetDatabase);
    const sourceColumns = normalizeColumns('source_db');
    if (!targetColumns.length || JSON.stringify(targetColumns) !== JSON.stringify(sourceColumns)) {
      throw new Error(`column schema mismatch in ${table}: ${JSON.stringify({ targetColumns, sourceColumns })}`);
    }

    const constraints = await queryObjects(`
      SELECT database_name, constraint_type,
             CAST(constraint_column_names AS VARCHAR) AS constraint_columns,
             constraint_text
      FROM duckdb_constraints()
      WHERE schema_name = 'main' AND table_name = ${sqlString(table)}
        AND database_name IN (${sqlString(targetDatabase)}, 'source_db')
      ORDER BY database_name, constraint_type, constraint_columns, constraint_text
    `);
    const normalizeConstraints = databaseName => constraints
      .filter(row => row.database_name === databaseName)
      .map(({ constraint_type, constraint_columns, constraint_text }) => ({
        constraint_type, constraint_columns, constraint_text,
      }));
    if (JSON.stringify(normalizeConstraints(targetDatabase)) !==
        JSON.stringify(normalizeConstraints('source_db'))) {
      throw new Error(`constraint mismatch in ${table}`);
    }
  }

  await connection.run('BEGIN TRANSACTION');
  try {
    await connection.run(`
      CREATE TEMP TABLE retained_trace_ids AS
      WITH RECURSIVE trace_closure(traceId) AS (
        SELECT traceId
        FROM (
          SELECT traceId
          FROM source_db.span_events
          WHERE timestamp >= ${cutoffSql} OR endedAt >= ${cutoffSql}
          UNION ALL SELECT traceId FROM source_db.metric_events WHERE timestamp >= ${cutoffSql}
          UNION ALL SELECT traceId FROM source_db.log_events WHERE timestamp >= ${cutoffSql}
          UNION ALL SELECT traceId FROM source_db.score_events WHERE timestamp >= ${cutoffSql}
          UNION ALL SELECT scoreTraceId AS traceId FROM source_db.score_events WHERE timestamp >= ${cutoffSql}
          UNION ALL SELECT traceId FROM source_db.feedback_events WHERE timestamp >= ${cutoffSql}
        ) recent
        WHERE traceId IS NOT NULL AND traceId <> ''

        UNION

        SELECT CASE
                 WHEN score.traceId = closure.traceId THEN score.scoreTraceId
                 ELSE score.traceId
               END AS traceId
        FROM source_db.score_events AS score
        JOIN trace_closure AS closure
          ON score.traceId = closure.traceId
          OR score.scoreTraceId = closure.traceId
        WHERE CASE
                WHEN score.traceId = closure.traceId THEN score.scoreTraceId
                ELSE score.traceId
              END IS NOT NULL
          AND CASE
                WHEN score.traceId = closure.traceId THEN score.scoreTraceId
                ELSE score.traceId
              END <> ''
      )
      SELECT DISTINCT traceId FROM trace_closure
    `);
    await connection.run(`
      INSERT INTO main.span_events
      SELECT * FROM source_db.span_events
      WHERE traceId IN (SELECT traceId FROM retained_trace_ids)
    `);
    for (const table of ['metric_events', 'log_events', 'feedback_events']) {
      await connection.run(`
        INSERT INTO main.${table}
        SELECT * FROM source_db.${table}
        WHERE timestamp >= ${cutoffSql}
           OR traceId IN (SELECT traceId FROM retained_trace_ids)
      `);
    }
    await connection.run(`
      INSERT INTO main.score_events
      SELECT * FROM source_db.score_events
      WHERE timestamp >= ${cutoffSql}
         OR traceId IN (SELECT traceId FROM retained_trace_ids)
         OR scoreTraceId IN (SELECT traceId FROM retained_trace_ids)
    `);
    await connection.run('COMMIT');
  } catch (error) {
    await connection.run('ROLLBACK');
    throw error;
  }

  const predicates = {
    span_events: 'traceId IN (SELECT traceId FROM retained_trace_ids)',
    metric_events: `timestamp >= ${cutoffSql} OR traceId IN (SELECT traceId FROM retained_trace_ids)`,
    log_events: `timestamp >= ${cutoffSql} OR traceId IN (SELECT traceId FROM retained_trace_ids)`,
    score_events: `timestamp >= ${cutoffSql} OR traceId IN (SELECT traceId FROM retained_trace_ids) OR scoreTraceId IN (SELECT traceId FROM retained_trace_ids)`,
    feedback_events: `timestamp >= ${cutoffSql} OR traceId IN (SELECT traceId FROM retained_trace_ids)`,
  };
  const validation = {};
  for (const table of tables) {
    const [counts] = await queryObjects(`
      SELECT (SELECT count(*) FROM main.${table}) AS retained_count,
             (SELECT count(*) FROM source_db.${table}) AS source_count,
             (SELECT count(*) FROM source_db.${table} WHERE ${predicates[table]}) AS expected_count,
             (SELECT min(timestamp) FROM main.${table}) AS retained_min,
             (SELECT max(timestamp) FROM main.${table}) AS retained_max
    `);
    const [diff] = await queryObjects(`
      SELECT count(*) AS difference_count
      FROM (
        (SELECT * FROM main.${table}
         EXCEPT ALL
         SELECT * FROM source_db.${table} WHERE ${predicates[table]})
        UNION ALL
        (SELECT * FROM source_db.${table} WHERE ${predicates[table]}
         EXCEPT ALL
         SELECT * FROM main.${table})
      ) differences
    `);
    if (counts.retained_count !== counts.expected_count || diff.difference_count !== 0n) {
      throw new Error(`validation failed for ${table}: ${JSON.stringify({ counts, diff }, jsonReplacer)}`);
    }
    validation[table] = { ...counts, ...diff };
  }

  await connection.run('DETACH source_db');
  attached = false;
  await connection.run('CHECKPOINT');
  console.log(JSON.stringify({ source, destination, cutoff: cutoffIso, validation }, jsonReplacer, 2));
} finally {
  if (attached) {
    try { await connection.run('DETACH source_db'); } catch { /* close below */ }
  }
  connection.closeSync();
  await store.db.close();
}

const fd = fs.openSync(destination, 'r');
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

const verifyInstance = await DuckDBInstance.create(destination, { access_mode: 'READ_ONLY' });
const verifyConnection = await verifyInstance.connect();
try {
  for (const table of tables) await verifyConnection.run(`SELECT count(*) FROM ${table}`);
  const sizeResult = await verifyConnection.run('PRAGMA database_size');
  const [databaseSize] = await sizeResult.getRowObjects();
  const bytes = fs.statSync(destination).size;
  console.log(JSON.stringify({ bytes, databaseSize, elapsedSeconds: (Date.now() - startedAt) / 1000 }, jsonReplacer));
} finally {
  verifyConnection.closeSync();
  verifyInstance.closeSync();
}
