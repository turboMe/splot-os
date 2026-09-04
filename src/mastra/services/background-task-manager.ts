/**
 * Background Task Manager — Durable background tasks for the Mastra Harness.
 *
 * Long-running tests, builds, scrapers and external jobs live outside the
 * tool-call timeout.  Output is streamed to `.mastra/background/<taskId>.out`
 * and status is persisted in Mongo `background_tasks`.
 *
 * When `wake=true`, the completion is queued as a pending message so the
 * agent is notified at the next safe interrupt point.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createReadStream } from 'fs';
import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { createInterface } from 'readline';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { logHarnessEvent } from './harness-events.js';
import { queuePendingMessage } from './pending-message-queue.js';
import { ledgerOpenLane, ledgerTransitionBySource } from './task-ledger.js';
import { requiresCodeCommandApproval } from '../workspaces/code-workspace.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type BackgroundTaskRecord = {
  taskId: string;
  ownerTaskId?: string;
  threadId?: string;
  agentId: string;
  command: string;
  cwd: string;
  status: BackgroundTaskStatus;
  pid?: number;
  outputFile: string;
  statusFile: string;
  exitCode?: number;
  error?: string;
  notify: boolean;
  wake: boolean;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeatAt?: Date;
  expiresAt: Date;
};

export type BackgroundTaskWaitResult = {
  taskId: string;
  status: BackgroundTaskStatus;
  exitCode?: number;
  error?: string;
  outputTail?: string;
  durationMs: number;
};

export type CleanupResult = {
  removed: number;
  errors: string[];
};

export type StartTaskInput = {
  command: string;
  cwd: string;
  ownerTaskId?: string;
  threadId?: string;
  agentId?: string;
  notify?: boolean;
  wake?: boolean;
  ttlMs?: number;
  env?: Record<string, string>;
};

// ── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = 'background_tasks';
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const BG_DIR_BASE = process.env.MASTRA_BACKGROUND_DIR
  || resolve(process.cwd(), '.mastra/background');
const DEFAULT_TAIL_LINES = 50;
const MAX_WAIT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;

/** In-memory map to track spawned child processes within this runtime. */
const liveProcesses = new Map<string, ChildProcess>();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a background task.  The command is spawned detached with stdout/stderr
 * redirected to a file.  Returns immediately with a task record.
 */
export async function startBackgroundTask(
  input: StartTaskInput,
): Promise<BackgroundTaskRecord> {
  if (!isHarnessFeatureEnabled('FEATURE_BACKGROUND_TASKS', true)) {
    throw new Error('Background tasks are disabled (FEATURE_BACKGROUND_TASKS=false)');
  }

  const taskId = randomUUID();
  const now = new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const outputFile = resolve(BG_DIR_BASE, `${taskId}.out`);
  const statusFile = resolve(BG_DIR_BASE, `${taskId}.status.json`);

  await mkdir(BG_DIR_BASE, { recursive: true });

  // Spawn detached process with output redirected to file
  const child = spawn('bash', ['-c', input.command], {
    cwd: input.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(input.env ?? {}) },
  });

  // Set up output file writing
  const { createWriteStream } = await import('fs');
  const outStream = createWriteStream(outputFile, { flags: 'w' });
  child.stdout?.pipe(outStream);
  child.stderr?.pipe(outStream);

  const record: BackgroundTaskRecord = {
    taskId,
    ownerTaskId: input.ownerTaskId,
    threadId: input.threadId,
    agentId: input.agentId ?? 'codingAgent',
    command: input.command,
    cwd: input.cwd,
    status: 'running',
    pid: child.pid,
    outputFile,
    statusFile,
    notify: input.notify ?? false,
    wake: input.wake ?? false,
    startedAt: now,
    lastHeartbeatAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };

  // Persist to Mongo
  const db = await getDb();
  await db.collection<BackgroundTaskRecord>(COLLECTION).insertOne(record);

  // Track in-memory
  if (child.pid) liveProcesses.set(taskId, child);

  // Unref so the parent can exit if needed
  child.unref();

  // Handle exit
  child.on('exit', (code, signal) => {
    void handleTaskExit(taskId, code, signal, record);
  });

  child.on('error', (err) => {
    void handleTaskError(taskId, err.message, record);
  });

  await logHarnessEvent({
    type: 'bg_task_started',
    agentId: record.agentId,
    threadId: record.threadId,
    taskId: input.ownerTaskId,
    feature: 'background_tasks',
    status: 'success',
    output: `Background task started: ${taskId}`,
    data: {
      bgTaskId: taskId,
      command: input.command,
      cwd: input.cwd,
      pid: child.pid,
      wake: record.wake,
      notify: record.notify,
    },
  });

  // Task Ledger (Etap 1): no heartbeat loop for detached processes — staleness
  // is bounded by the task TTL.
  void ledgerOpenLane({
    source: 'background_task',
    sourceId: taskId,
    goal: input.command,
    agentId: record.agentId,
    threadId: record.threadId,
    state: 'running',
    staleAfterMs: ttlMs,
    meta: { ownerTaskId: input.ownerTaskId, cwd: input.cwd, pid: child.pid },
  });

  return record;
}

/**
 * Get the current status of a background task.
 */
export async function getBackgroundTask(
  taskId: string,
): Promise<BackgroundTaskRecord | null> {
  const db = await getDb();
  const record = await db.collection<BackgroundTaskRecord>(COLLECTION)
    .findOne({ taskId });

  if (!record) return null;

  // If status is 'running', check if the process is actually still alive
  if (record.status === 'running') {
    const alive = isProcessAlive(record.pid);
    if (!alive) {
      // Try to recover status from the status file
      const recovered = await recoverStatusFromFile(taskId, record.statusFile);
      if (recovered) return recovered;

      // Mark as unknown if we can't determine the status
      await db.collection<BackgroundTaskRecord>(COLLECTION).updateOne(
        { taskId },
        { $set: { status: 'unknown' as BackgroundTaskStatus, lastHeartbeatAt: new Date() } },
      );
      return { ...record, status: 'unknown' };
    }
  }

  return record;
}

/**
 * Wait for a background task to complete.
 * Polls until the task is done or the timeout is reached.
 */
export async function waitBackgroundTask(
  taskId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BackgroundTaskWaitResult> {
  const start = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
  const pollMs = opts.pollMs ?? POLL_INTERVAL_MS;

  while (Date.now() - start < timeoutMs) {
    const record = await getBackgroundTask(taskId);
    if (!record) {
      return {
        taskId,
        status: 'unknown',
        error: 'Task not found',
        durationMs: Date.now() - start,
      };
    }

    if (record.status !== 'running') {
      const tail = await tailBackgroundTask(taskId, 30);
      return {
        taskId,
        status: record.status,
        exitCode: record.exitCode,
        error: record.error,
        outputTail: tail || undefined,
        durationMs: Date.now() - start,
      };
    }

    await sleep(pollMs);
  }

  return {
    taskId,
    status: 'running',
    error: 'Wait timed out',
    durationMs: Date.now() - start,
  };
}

/**
 * Get the last N lines of a background task's output.
 */
export async function tailBackgroundTask(
  taskId: string,
  lines: number = DEFAULT_TAIL_LINES,
): Promise<string> {
  const record = await getRecordDirect(taskId);
  if (!record) return '';

  try {
    const stats = await stat(record.outputFile).catch(() => null);
    if (!stats || stats.size === 0) return '';

    return await readLastLines(record.outputFile, lines);
  } catch {
    return '';
  }
}

/**
 * Get the full output of a completed background task.
 */
export async function getBackgroundTaskOutput(
  taskId: string,
): Promise<string> {
  const record = await getRecordDirect(taskId);
  if (!record) return '';

  try {
    return await readFile(record.outputFile, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Cancel a running background task.
 */
export async function cancelBackgroundTask(
  taskId: string,
): Promise<boolean> {
  const record = await getRecordDirect(taskId);
  if (!record || record.status !== 'running') return false;

  // Try to kill the process
  const child = liveProcesses.get(taskId);
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
  } else if (record.pid) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      // Process may have already exited
    }
  }

  liveProcesses.delete(taskId);

  const now = new Date();
  const db = await getDb();
  await db.collection<BackgroundTaskRecord>(COLLECTION).updateOne(
    { taskId },
    {
      $set: {
        status: 'cancelled' as BackgroundTaskStatus,
        completedAt: now,
        lastHeartbeatAt: now,
      },
    },
  );

  await writeStatusFile(record.statusFile, {
    status: 'cancelled',
    completedAt: now.toISOString(),
  });

  void ledgerTransitionBySource('background_task', taskId, 'cancelled', {
    milestone: 'cancelled by operator',
  });

  await logHarnessEvent({
    type: 'bg_task_completed',
    agentId: record.agentId,
    threadId: record.threadId,
    taskId: record.ownerTaskId,
    feature: 'background_tasks',
    status: 'success',
    output: `Background task cancelled: ${taskId}`,
    data: {
      bgTaskId: taskId,
      status: 'cancelled',
    },
  });

  return true;
}

/**
 * Clean up completed/failed/cancelled tasks older than maxAgeMs.
 */
export async function cleanupBackgroundTasks(
  opts: { maxAgeMs?: number; statuses?: BackgroundTaskStatus[] } = {},
): Promise<CleanupResult> {
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000;
  const statuses = opts.statuses ?? ['completed', 'failed', 'cancelled', 'unknown'];
  const cutoff = new Date(Date.now() - maxAgeMs);

  const db = await getDb();
  const result = await db.collection<BackgroundTaskRecord>(COLLECTION).deleteMany({
    status: { $in: statuses },
    completedAt: { $lt: cutoff },
  });

  return {
    removed: result.deletedCount,
    errors: [],
  };
}

/**
 * List background tasks matching filters.
 */
export async function listBackgroundTasks(
  opts: { ownerTaskId?: string; status?: BackgroundTaskStatus; limit?: number } = {},
): Promise<BackgroundTaskRecord[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = {};
  if (opts.ownerTaskId) filter.ownerTaskId = opts.ownerTaskId;
  if (opts.status) filter.status = opts.status;

  return db.collection<BackgroundTaskRecord>(COLLECTION)
    .find(filter)
    .sort({ startedAt: -1 })
    .limit(opts.limit ?? 20)
    .toArray();
}

/**
 * Check if a command requires approval before background execution.
 */
export function requiresBackgroundApproval(command: string): boolean {
  return requiresCodeCommandApproval(command);
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

async function handleTaskExit(
  taskId: string,
  code: number | null,
  signal: string | null,
  record: BackgroundTaskRecord,
): Promise<void> {
  liveProcesses.delete(taskId);
  const now = new Date();
  const exitCode = code ?? (signal ? 128 : 1);
  const status: BackgroundTaskStatus = exitCode === 0 ? 'completed' : 'failed';

  try {
    const db = await getDb();
    await db.collection<BackgroundTaskRecord>(COLLECTION).updateOne(
      { taskId },
      {
        $set: {
          status,
          exitCode,
          completedAt: now,
          lastHeartbeatAt: now,
          ...(signal ? { error: `Killed by signal: ${signal}` } : {}),
        },
      },
    );

    await writeStatusFile(record.statusFile, {
      status,
      exitCode,
      signal: signal ?? undefined,
      completedAt: now.toISOString(),
    });

    void ledgerTransitionBySource(
      'background_task',
      taskId,
      status === 'completed' ? 'done' : 'failed',
      {
        milestone: `exit code ${exitCode}${signal ? ` (signal ${signal})` : ''}`,
        ...(status === 'failed' ? { error: signal ? `killed by ${signal}` : `exit code ${exitCode}` } : {}),
      },
    );

    await logHarnessEvent({
      type: 'bg_task_completed',
      agentId: record.agentId,
      threadId: record.threadId,
      taskId: record.ownerTaskId,
      feature: 'background_tasks',
      status: status === 'completed' ? 'success' : 'error',
      output: `Background task ${status}: ${taskId} (exit code: ${exitCode})`,
      data: {
        bgTaskId: taskId,
        command: record.command,
        status,
        exitCode,
        signal,
        durationMs: now.getTime() - record.startedAt.getTime(),
      },
    });

    // Queue pending message if wake=true
    if (record.wake) {
      const tail = await readLastLines(record.outputFile, 15).catch(() => '');
      const statusLabel = exitCode === 0 ? '✅ completed' : '❌ failed';
      const content = [
        `Background task ${statusLabel}: \`${record.command}\``,
        `Task ID: ${taskId}`,
        `Exit code: ${exitCode}`,
        tail ? `Last output:\n\`\`\`\n${tail}\n\`\`\`` : '',
      ].filter(Boolean).join('\n');

      await queuePendingMessage({
        taskId: record.ownerTaskId,
        threadId: record.threadId,
        targetAgentId: record.agentId,
        source: 'background_task',
        content,
        urgent: exitCode !== 0,
        metadata: {
          bgTaskId: taskId,
          exitCode,
          status,
        },
      });
    }
  } catch (error) {
    console.warn('[BackgroundTaskManager] handleTaskExit error:', (error as Error).message);
  }
}

async function handleTaskError(
  taskId: string,
  errorMessage: string,
  record: BackgroundTaskRecord,
): Promise<void> {
  liveProcesses.delete(taskId);
  const now = new Date();

  try {
    const db = await getDb();
    await db.collection<BackgroundTaskRecord>(COLLECTION).updateOne(
      { taskId },
      {
        $set: {
          status: 'failed' as BackgroundTaskStatus,
          error: errorMessage,
          completedAt: now,
          lastHeartbeatAt: now,
        },
      },
    );

    await writeStatusFile(record.statusFile, {
      status: 'failed',
      error: errorMessage,
      completedAt: now.toISOString(),
    });

    void ledgerTransitionBySource('background_task', taskId, 'failed', { error: errorMessage });

    if (record.wake) {
      await queuePendingMessage({
        taskId: record.ownerTaskId,
        threadId: record.threadId,
        targetAgentId: record.agentId,
        source: 'background_task',
        content: `Background task ❌ failed to start: \`${record.command}\`\nError: ${errorMessage}`,
        urgent: true,
        metadata: { bgTaskId: taskId, error: errorMessage },
      });
    }
  } catch (error) {
    console.warn('[BackgroundTaskManager] handleTaskError error:', (error as Error).message);
  }
}

async function getRecordDirect(
  taskId: string,
): Promise<BackgroundTaskRecord | null> {
  const db = await getDb();
  return db.collection<BackgroundTaskRecord>(COLLECTION).findOne({ taskId });
}

async function recoverStatusFromFile(
  taskId: string,
  statusFile: string,
): Promise<BackgroundTaskRecord | null> {
  try {
    const content = await readFile(statusFile, 'utf8');
    const data = JSON.parse(content) as {
      status: BackgroundTaskStatus;
      exitCode?: number;
      error?: string;
      completedAt?: string;
    };

    const db = await getDb();
    const update: Record<string, unknown> = {
      status: data.status,
      lastHeartbeatAt: new Date(),
    };
    if (data.exitCode !== undefined) update.exitCode = data.exitCode;
    if (data.error) update.error = data.error;
    if (data.completedAt) update.completedAt = new Date(data.completedAt);

    await db.collection<BackgroundTaskRecord>(COLLECTION).updateOne(
      { taskId },
      { $set: update },
    );

    const record = await db.collection<BackgroundTaskRecord>(COLLECTION).findOne({ taskId });
    return record;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeStatusFile(
  statusFile: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await writeFile(statusFile, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Non-critical — Mongo is the source of truth
  }
}

async function readLastLines(filePath: string, n: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const lines: string[] = [];
    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        lines.push(line);
        if (lines.length > n) lines.shift();
      });

      rl.on('close', () => {
        resolve(lines.join('\n'));
      });

      rl.on('error', () => {
        resolve(lines.join('\n'));
      });
    } catch {
      resolve('');
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
