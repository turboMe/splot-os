import type { DuckDBConnection } from '@mastra/duckdb';
import { resolve } from 'node:path';

export const DEFAULT_OBSERVABILITY_RETENTION_DAYS = 3;
export const OBSERVABILITY_RETENTION_ROUTE = '/internal/observability/retention';

export const OBSERVABILITY_SIGNAL_TABLES = [
  'span_events',
  'metric_events',
  'log_events',
  'score_events',
  'feedback_events',
] as const;

export type ObservabilitySignalTable = (typeof OBSERVABILITY_SIGNAL_TABLES)[number];

export type ObservabilityRetentionCounts = Record<ObservabilitySignalTable, number>;

export interface ObservabilityRetentionResult {
  status: 'completed';
  retentionDays: number;
  cutoff: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  checkpointDurationMs: number;
  protectedTraceCount: number;
  deleted: ObservabilityRetentionCounts;
  deletedTotal: number;
}

export interface ObservabilityRetentionLogger {
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface ObservabilityRetentionOptions {
  retentionDays?: number;
  logger?: ObservabilityRetentionLogger;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const TEMP_PROTECTED_TRACES = 'observability_retention_protected_traces';

function emptyCounts(): ObservabilityRetentionCounts {
  return {
    span_events: 0,
    metric_events: 0,
    log_events: 0,
    score_events: 0,
    feedback_events: 0,
  };
}

function parsePositiveInteger(raw: string, variableName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new Error(`${variableName} must be an integer between 1 and 365 (received ${JSON.stringify(raw)}).`);
  }
  return value;
}

/** Read the rolling observability window. Unset means the approved 72-hour default. */
export function getObservabilityRetentionDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.OBSERVABILITY_RETENTION_DAYS?.trim();
  return raw
    ? parsePositiveInteger(raw, 'OBSERVABILITY_RETENTION_DAYS')
    : DEFAULT_OBSERVABILITY_RETENTION_DAYS;
}

/** Retention is on by default; an explicit false/0/no is the emergency kill switch. */
export function isObservabilityRetentionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OBSERVABILITY_RETENTION_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/** Preserve DuckDB's sentinel instead of accidentally resolving it as a file. */
export function resolveObservabilityDuckDBPath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.MASTRA_DUCKDB_PATH?.trim();
  if (configured === ':memory:') return configured;
  return configured
    ? resolve(configured)
    : resolve(repoRoot, 'storage', 'mastra-observability.duckdb');
}

function toSafeCount(value: unknown, label: string): number {
  const count = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`DuckDB returned an invalid ${label}: ${String(value)}.`);
  }
  return count;
}

type NativeDuckDBConnection = Awaited<ReturnType<DuckDBConnection['getConnection']>>;

async function queryCount(
  connection: NativeDuckDBConnection,
  sql: string,
  label: string,
): Promise<number> {
  const result = await connection.run(sql);
  const rows = await result.getRows();
  return toSafeCount(rows[0]?.[0], label);
}

function closeConnection(connection: NativeDuckDBConnection): void {
  connection.closeSync();
}

/**
 * Deletes expired observability events through the exact DuckDB instance used
 * by Mastra's DefaultExporter. A single native connection owns the whole
 * transaction; no second process tries to open the embedded database.
 *
 * A trace becomes protected when any of its five signal streams has an event
 * inside the retention window. Every older event linked to that trace is then
 * kept, so a trace whose start precedes the cutoff is never reconstructed from
 * an orphaned tail. Standalone signals are retained by their own timestamp.
 */
export class ObservabilityRetentionService {
  private readonly retentionDays: number;
  private readonly logger: ObservabilityRetentionLogger;
  private activeRun: Promise<ObservabilityRetentionResult> | null = null;

  constructor(
    private readonly db: DuckDBConnection,
    options: ObservabilityRetentionOptions = {},
  ) {
    const retentionDays = options.retentionDays ?? DEFAULT_OBSERVABILITY_RETENTION_DAYS;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      throw new Error('retentionDays must be an integer between 1 and 365.');
    }
    this.retentionDays = retentionDays;
    this.logger = options.logger ?? console;
  }

  /** Concurrent callers join one promise; a completed run is safe to repeat. */
  run(now: Date = new Date()): Promise<ObservabilityRetentionResult> {
    if (this.activeRun) return this.activeRun;

    const operation = this.runOnce(now);
    this.activeRun = operation;
    operation.then(
      () => {
        if (this.activeRun === operation) this.activeRun = null;
      },
      () => {
        if (this.activeRun === operation) this.activeRun = null;
      },
    );
    return operation;
  }

  private async runOnce(now: Date): Promise<ObservabilityRetentionResult> {
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Observability retention requires a valid current time.');
    }

    const startedAtDate = new Date();
    const cutoffDate = new Date(now.getTime() - this.retentionDays * DAY_MS);
    // The value is produced from a Date, not request input. Keeping one literal
    // makes every statement in the transaction use the exact same UTC cutoff.
    const cutoffSql = `'${cutoffDate.toISOString().replace(/'/g, "''")}'::TIMESTAMP`;
    const connection = await this.db.getConnection();
    const deleted = emptyCounts();
    let protectedTraceCount = 0;
    let transactionOpen = false;
    let transactionCommitted = false;
    let phase = 'begin';

    try {
      await connection.run('BEGIN TRANSACTION');
      transactionOpen = true;

      phase = 'select-protected-traces';
      await connection.run(`
        CREATE TEMP TABLE ${TEMP_PROTECTED_TRACES} AS
        WITH RECURSIVE
        recent_trace_ids(traceId) AS (
            SELECT traceId
            FROM span_events
            WHERE timestamp >= ${cutoffSql} OR endedAt >= ${cutoffSql}
          UNION ALL
            SELECT traceId FROM metric_events WHERE timestamp >= ${cutoffSql}
          UNION ALL
            SELECT traceId FROM log_events WHERE timestamp >= ${cutoffSql}
          UNION ALL
            SELECT traceId FROM score_events WHERE timestamp >= ${cutoffSql}
          UNION ALL
            SELECT scoreTraceId AS traceId FROM score_events WHERE timestamp >= ${cutoffSql}
          UNION ALL
            SELECT traceId FROM feedback_events WHERE timestamp >= ${cutoffSql}
        ),
        protected_trace_ids(traceId) AS (
          SELECT DISTINCT traceId
          FROM recent_trace_ids
          WHERE traceId IS NOT NULL AND traceId <> ''

          UNION

          SELECT CASE
            WHEN score.traceId = protected.traceId THEN score.scoreTraceId
            ELSE score.traceId
          END AS traceId
          FROM protected_trace_ids AS protected
          JOIN score_events AS score
            ON protected.traceId = score.traceId
            OR protected.traceId = score.scoreTraceId
          WHERE CASE
            WHEN score.traceId = protected.traceId THEN score.scoreTraceId
            ELSE score.traceId
          END IS NOT NULL
          AND CASE
            WHEN score.traceId = protected.traceId THEN score.scoreTraceId
            ELSE score.traceId
          END <> ''
        )
        SELECT DISTINCT traceId
        FROM protected_trace_ids
        WHERE traceId IS NOT NULL AND traceId <> ''
      `);
      protectedTraceCount = await queryCount(
        connection,
        `SELECT count(*) FROM ${TEMP_PROTECTED_TRACES}`,
        'protected trace count',
      );

      phase = 'delete-span-events';
      deleted.span_events = toSafeCount((await connection.run(`
        DELETE FROM span_events AS event
        WHERE event.timestamp < ${cutoffSql}
          AND NOT EXISTS (
            SELECT 1 FROM ${TEMP_PROTECTED_TRACES} AS protected
            WHERE protected.traceId = event.traceId
          )
      `)).rowsChanged, 'deleted span_events count');

      phase = 'delete-metric-events';
      deleted.metric_events = toSafeCount((await connection.run(`
        DELETE FROM metric_events AS event
        WHERE event.timestamp < ${cutoffSql}
          AND NOT EXISTS (
            SELECT 1 FROM ${TEMP_PROTECTED_TRACES} AS protected
            WHERE protected.traceId = event.traceId
          )
      `)).rowsChanged, 'deleted metric_events count');

      phase = 'delete-log-events';
      deleted.log_events = toSafeCount((await connection.run(`
        DELETE FROM log_events AS event
        WHERE event.timestamp < ${cutoffSql}
          AND NOT EXISTS (
            SELECT 1 FROM ${TEMP_PROTECTED_TRACES} AS protected
            WHERE protected.traceId = event.traceId
          )
      `)).rowsChanged, 'deleted log_events count');

      phase = 'delete-score-events';
      deleted.score_events = toSafeCount((await connection.run(`
        DELETE FROM score_events AS event
        WHERE event.timestamp < ${cutoffSql}
          AND NOT EXISTS (
            SELECT 1 FROM ${TEMP_PROTECTED_TRACES} AS protected
            WHERE protected.traceId = event.traceId
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${TEMP_PROTECTED_TRACES} AS protected
            WHERE protected.traceId = event.scoreTraceId
          )
      `)).rowsChanged, 'deleted score_events count');

      phase = 'delete-feedback-events';
      deleted.feedback_events = toSafeCount((await connection.run(`
        DELETE FROM feedback_events AS event
        WHERE event.timestamp < ${cutoffSql}
          AND NOT EXISTS (
            SELECT 1 FROM ${TEMP_PROTECTED_TRACES} AS protected
            WHERE protected.traceId = event.traceId
          )
      `)).rowsChanged, 'deleted feedback_events count');

      phase = 'drop-temporary-table';
      await connection.run(`DROP TABLE ${TEMP_PROTECTED_TRACES}`);

      phase = 'commit';
      await connection.run('COMMIT');
      transactionOpen = false;
      transactionCommitted = true;

      phase = 'checkpoint';
      const checkpointStartedAt = Date.now();
      await connection.run('CHECKPOINT');
      try {
        await connection.run('VACUUM');
      } catch (vacuumErr) {
        this.logger.error('[observability-retention] vacuum warning', {
          error: vacuumErr instanceof Error ? vacuumErr.message : String(vacuumErr),
        });
      }
      const checkpointDurationMs = Date.now() - checkpointStartedAt;

      const finishedAtDate = new Date();
      const deletedTotal = OBSERVABILITY_SIGNAL_TABLES.reduce(
        (sum, table) => sum + deleted[table],
        0,
      );
      const result: ObservabilityRetentionResult = {
        status: 'completed',
        retentionDays: this.retentionDays,
        cutoff: cutoffDate.toISOString(),
        startedAt: startedAtDate.toISOString(),
        finishedAt: finishedAtDate.toISOString(),
        durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
        checkpointDurationMs,
        protectedTraceCount,
        deleted,
        deletedTotal,
      };
      this.logger.info('[observability-retention] completed', result);
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          await connection.run('ROLLBACK');
          transactionOpen = false;
        } catch (rollbackError) {
          this.logger.error('[observability-retention] rollback failed', {
            phase,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
      }
      this.logger.error('[observability-retention] failed', {
        phase,
        transactionCommitted,
        cutoff: cutoffDate.toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      closeConnection(connection);
    }
  }
}
