/**
 * Periodic Worker Manager (P2 — adapted from Ruflo's worker framework)
 *
 * Cyclic background workers for health monitoring, model availability, cache
 * cleanup, telemetry aggregation and memory consolidation. Mastra previously
 * only had ONE-SHOT background tasks (background-task-manager.ts) — this adds
 * the missing recurring-timer layer.
 *
 * Design goals (borrowed from Ruflo, re-implemented natively for Mastra):
 *   - zero new dependencies (Node `os`/`fs` + setInterval)
 *   - in-memory ring buffer of recent runs per worker
 *   - alert thresholds → harness events + console.warn
 *   - each run persisted to the `worker_metrics` collection (TTL-pruned)
 *   - additive & non-blocking: a worker failure never crashes the host process
 */

import os from 'os';
import { statfs } from 'fs/promises';
import { getDb } from '../lib/mongo.js';
import { logHarnessEvent } from './harness-events.js';
import { getGpuGuard } from './gpu-guard.js';
import { verifyAllModels } from './model-availability.js';
import { cleanupBackgroundTasks } from './background-task-manager.js';
import { extractKnowledge } from './memory-extractor.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkerHealthStatus = 'healthy' | 'warning' | 'critical';

export interface WorkerResult {
  status: WorkerHealthStatus;
  metrics: Record<string, number | string>;
  message?: string;
}

export interface PeriodicWorker {
  id: string;
  name: string;
  intervalMs: number;
  enabled: boolean;
  handler: () => Promise<WorkerResult>;
}

export interface WorkerRunRecord {
  timestamp: Date;
  status: WorkerHealthStatus | 'error';
  durationMs: number;
  metrics: Record<string, number | string>;
  message?: string;
}

export interface WorkerState {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  totalRuns: number;
  consecutiveFailures: number;
  lastRunAt: Date | null;
  lastStatus: WorkerHealthStatus | 'error' | 'never';
  lastDurationMs: number | null;
  lastMessage?: string;
  lastMetrics: Record<string, number | string> | null;
  recent: WorkerRunRecord[];
}

// ── Alert thresholds ─────────────────────────────────────────────────────────

export const ALERT_THRESHOLDS = {
  ramUsagePercent: { warn: 80, critical: 95 },
  diskUsagePercent: { warn: 85, critical: 95 },
  errorRate1h: { warn: 0.3, critical: 0.5 },
} as const;

function classify(value: number, t: { warn: number; critical: number }): WorkerHealthStatus {
  if (value >= t.critical) return 'critical';
  if (value >= t.warn) return 'warning';
  return 'healthy';
}

function worst(...statuses: WorkerHealthStatus[]): WorkerHealthStatus {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'healthy';
}

const RING_BUFFER_SIZE = 20;
const METRICS_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

// ── Manager ──────────────────────────────────────────────────────────────────

class PeriodicWorkerManager {
  private workers = new Map<string, PeriodicWorker>();
  private states = new Map<string, WorkerState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private started = false;

  registerWorker(w: PeriodicWorker): void {
    this.workers.set(w.id, w);
    if (!this.states.has(w.id)) {
      this.states.set(w.id, {
        id: w.id,
        name: w.name,
        enabled: w.enabled,
        intervalMs: w.intervalMs,
        running: false,
        totalRuns: 0,
        consecutiveFailures: 0,
        lastRunAt: null,
        lastStatus: 'never',
        lastDurationMs: null,
        lastMetrics: null,
        recent: [],
      });
    }
  }

  /** Start all enabled workers on their interval. Called once at boot. */
  startAll(): void {
    if (this.started) return;
    this.started = true;
    for (const w of this.workers.values()) {
      if (!w.enabled) continue;
      // Stagger first runs slightly so boot doesn't fire everything at once.
      const jitter = Math.floor(Math.random() * 5000);
      const timer = setInterval(() => void this.runWorker(w.id), w.intervalMs);
      // setInterval keeps the event loop alive; allow process to exit if needed.
      timer.unref?.();
      this.timers.set(w.id, timer);
      setTimeout(() => void this.runWorker(w.id), jitter).unref?.();
    }
    console.log(`[PeriodicWorkerManager] Started ${this.timers.size} worker(s).`);
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.started = false;
  }

  getWorkerStatus(): WorkerState[] {
    return [...this.states.values()].map((s) => ({ ...s, recent: [...s.recent] }));
  }

  /** Run a single worker by id immediately (used by interval + manual trigger). */
  async runWorker(id: string): Promise<WorkerResult | null> {
    const worker = this.workers.get(id);
    const state = this.states.get(id);
    if (!worker || !state) return null;
    if (state.running) return null; // skip overlapping runs

    state.running = true;
    const startedAt = Date.now();
    await logHarnessEvent({ type: 'worker_run_started', agentId: `worker:${id}`, status: 'pending' });

    try {
      const result = await worker.handler();
      const durationMs = Date.now() - startedAt;
      this.recordRun(state, {
        timestamp: new Date(),
        status: result.status,
        durationMs,
        metrics: result.metrics,
        message: result.message,
      });
      state.consecutiveFailures = 0;

      await logHarnessEvent({
        type: 'worker_run_completed',
        agentId: `worker:${id}`,
        status: 'success',
        durationMs,
        data: { status: result.status, metrics: result.metrics, message: result.message },
      });

      if (result.status !== 'healthy') {
        await this.raiseAlert(worker, result);
      }
      await this.persist(worker, result, durationMs);
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = (err as Error).message;
      state.consecutiveFailures += 1;
      this.recordRun(state, {
        timestamp: new Date(),
        status: 'error',
        durationMs,
        metrics: {},
        message,
      });
      await logHarnessEvent({
        type: 'worker_run_failed',
        agentId: `worker:${id}`,
        status: 'error',
        durationMs,
        errorMessage: message,
        data: { consecutiveFailures: state.consecutiveFailures },
      });
      console.warn(`[PeriodicWorkerManager] Worker "${id}" failed: ${message}`);
      return null;
    } finally {
      state.running = false;
    }
  }

  private recordRun(state: WorkerState, record: WorkerRunRecord): void {
    state.totalRuns += 1;
    state.lastRunAt = record.timestamp;
    state.lastStatus = record.status;
    state.lastDurationMs = record.durationMs;
    state.lastMessage = record.message;
    state.lastMetrics = record.metrics;
    state.recent.push(record);
    if (state.recent.length > RING_BUFFER_SIZE) state.recent.shift();
  }

  private async raiseAlert(worker: PeriodicWorker, result: WorkerResult): Promise<void> {
    console.warn(
      `[PeriodicWorkerManager] ALERT (${result.status}) from "${worker.id}": ${result.message ?? ''}`,
    );
    await logHarnessEvent({
      type: 'worker_alert',
      agentId: `worker:${worker.id}`,
      status: result.status === 'critical' ? 'error' : 'pending',
      errorMessage: result.message,
      data: { status: result.status, metrics: result.metrics },
    });
  }

  private async persist(worker: PeriodicWorker, result: WorkerResult, durationMs: number): Promise<void> {
    try {
      const db = await getDb();
      const now = new Date();
      await db.collection('worker_metrics').insertOne({
        workerId: worker.id,
        workerName: worker.name,
        status: result.status,
        metrics: result.metrics,
        message: result.message ?? null,
        durationMs,
        timestamp: now,
        expiresAt: new Date(now.getTime() + METRICS_TTL_MS),
      });
    } catch (err) {
      // Telemetry persistence is best-effort; never break the worker loop.
      console.warn(`[PeriodicWorkerManager] persist failed for "${worker.id}": ${(err as Error).message}`);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let singleton: PeriodicWorkerManager | null = null;

export function getPeriodicWorkerManager(): PeriodicWorkerManager {
  if (!singleton) {
    singleton = new PeriodicWorkerManager();
    registerBuiltinWorkers(singleton);
  }
  return singleton;
}

export function registerWorker(w: PeriodicWorker): void {
  getPeriodicWorkerManager().registerWorker(w);
}
export function startAll(): void {
  getPeriodicWorkerManager().startAll();
}
export function stopAll(): void {
  getPeriodicWorkerManager().stopAll();
}
export function getWorkerStatus(): WorkerState[] {
  return getPeriodicWorkerManager().getWorkerStatus();
}

// ── Built-in workers (wired to existing infrastructure) ──────────────────────

function registerBuiltinWorkers(mgr: PeriodicWorkerManager): void {
  // health — RAM/disk/uptime every 5 min (RAM via os, VRAM via gpu-guard).
  mgr.registerWorker({
    id: 'health',
    name: 'System Health',
    intervalMs: 5 * 60 * 1000,
    enabled: true,
    handler: async () => {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const ramUsagePercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

      let diskUsagePercent: number | null = null;
      try {
        const fsStat = await statfs('/');
        const total = fsStat.blocks * fsStat.bsize;
        const available = fsStat.bavail * fsStat.bsize;
        if (total > 0) diskUsagePercent = Math.round(((total - available) / total) * 100);
      } catch {
        diskUsagePercent = null; // statfs unsupported on this runtime — omit metric
      }

      const gpu = getGpuGuard().getSnapshot();
      const ramStatus = classify(ramUsagePercent, ALERT_THRESHOLDS.ramUsagePercent);
      const diskStatus = diskUsagePercent === null
        ? 'healthy'
        : classify(diskUsagePercent, ALERT_THRESHOLDS.diskUsagePercent);

      const metrics: Record<string, number | string> = {
        ramUsagePercent,
        freeMemMb: Math.round(freeMem / 1024 / 1024),
        uptimeSec: Math.round(os.uptime()),
        loadAvg1m: Number(os.loadavg()[0].toFixed(2)),
        vramFreeMb: gpu.freeMb,
        gpuAvailable: gpu.gpuAvailable ? 1 : 0,
      };
      if (diskUsagePercent !== null) metrics.diskUsagePercent = diskUsagePercent;

      const status = worst(ramStatus, diskStatus);
      return {
        status,
        metrics,
        message: status === 'healthy'
          ? undefined
          : `RAM ${ramUsagePercent}%${diskUsagePercent !== null ? `, disk ${diskUsagePercent}%` : ''}`,
      };
    },
  });

  // models — Ollama/cloud availability every 10 min.
  mgr.registerWorker({
    id: 'models',
    name: 'Model Availability',
    intervalMs: 10 * 60 * 1000,
    enabled: true,
    handler: async () => {
      const summary = await verifyAllModels();
      const localDown = summary.localUnavailable;
      const cloudDown = summary.cloudUnavailable;
      const status: WorkerHealthStatus = localDown > 0 || cloudDown > 0 ? 'warning' : 'healthy';
      return {
        status,
        metrics: {
          localAvailable: summary.localAvailable,
          localUnavailable: localDown,
          cloudAvailable: summary.cloudAvailable,
          cloudUnavailable: cloudDown,
          totalChecked: summary.totalChecked,
        },
        message: status === 'healthy'
          ? undefined
          : `${localDown} local + ${cloudDown} cloud model(s) unavailable`,
      };
    },
  });

  // cache — prune finished background tasks hourly.
  mgr.registerWorker({
    id: 'cache',
    name: 'Cache Cleanup',
    intervalMs: 60 * 60 * 1000,
    enabled: true,
    handler: async () => {
      const result = await cleanupBackgroundTasks();
      const status: WorkerHealthStatus = result.errors.length > 0 ? 'warning' : 'healthy';
      return {
        status,
        metrics: { removedBackgroundTasks: result.removed, errors: result.errors.length },
        message: result.errors.length > 0 ? result.errors[0] : undefined,
      };
    },
  });

  // telemetry — aggregate 1h error rate from agent_events every 30 min.
  mgr.registerWorker({
    id: 'telemetry',
    name: 'Telemetry Aggregation',
    intervalMs: 30 * 60 * 1000,
    enabled: true,
    handler: async () => {
      const db = await getDb();
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const events = db.collection('agent_events');
      const [total, errors] = await Promise.all([
        events.countDocuments({ timestamp: { $gte: since } }),
        events.countDocuments({ timestamp: { $gte: since }, status: 'error' }),
      ]);
      const errorRate1h = total > 0 ? errors / total : 0;
      const status = classify(errorRate1h, ALERT_THRESHOLDS.errorRate1h);
      return {
        status,
        metrics: {
          eventsLastHour: total,
          errorsLastHour: errors,
          errorRate1h: Number(errorRate1h.toFixed(3)),
        },
        message: status === 'healthy'
          ? undefined
          : `1h error rate ${(errorRate1h * 100).toFixed(1)}% over ${total} events`,
      };
    },
  });

  // memory — consolidate recurring agent_events into system_knowledge every 15 min.
  mgr.registerWorker({
    id: 'memory',
    name: 'Memory Consolidation',
    intervalMs: 15 * 60 * 1000,
    enabled: true,
    handler: async () => {
      const extracted = await extractKnowledge();
      return {
        status: 'healthy',
        metrics: { knowledgeExtracted: extracted },
        message: extracted > 0 ? `Consolidated ${extracted} knowledge entr(ies)` : undefined,
      };
    },
  });

  // capability builds — close out builds whose process died (F6 work item 3).
  //
  // Registered HERE rather than left as an agent tool, because a sweep that only
  // runs when somebody asks for it does not sweep: `void runCapabilityBuild(...)`
  // is fire-and-forget, so a restart leaves rows `running` for a process that no
  // longer exists, and nobody thinks to ask about a build they have forgotten.
  // `warning`, not `healthy`, when it finds one — a build that vanished mid
  // flight is worth a look even though the repo was never touched.
  mgr.registerWorker({
    id: 'capability-builds',
    name: 'Capability Build Sweeper',
    intervalMs: 5 * 60 * 1000,
    enabled: true,
    handler: async () => {
      const { markStaleCapabilityBuilds } = await import('./capability-build.js');
      const swept = await markStaleCapabilityBuilds();
      return {
        status: swept > 0 ? 'warning' as const : 'healthy' as const,
        metrics: { staleBuildsClosed: swept },
        message: swept > 0
          ? `${swept} build(s) stopped reporting and were closed as failed (no merge or promote happened)`
          : undefined,
      };
    },
  });

  // scheduled chains — a recurring trigger that quietly stopped.
  //
  // `findStoppedRecurrences` was written for exactly this, is careful about the
  // difference between "stopped" and "cancelled", and was reachable only from a
  // manual audit script and a test. It sat there while two daily job-hunter
  // chains had been dead for a day: correct detector, no caller. Detection that
  // has to be asked for is not detection, which is the same lesson the sweeper
  // above records.
  //
  // Reports, never repairs. Restarting a schedule is not bookkeeping — the row
  // FIRES, and firing here means an agent sending email on somebody's behalf.
  // That decision stays with the operator; `repairStoppedRecurrence` is one
  // command away once they have looked.
  mgr.registerWorker({
    id: 'scheduled-chains',
    name: 'Scheduled Chain Liveness',
    intervalMs: 60 * 60 * 1000,
    enabled: true,
    handler: async () => {
      const { findStoppedRecurrences } = await import('./scheduled-task-store.js');
      const stopped = await findStoppedRecurrences();
      if (stopped.length === 0) {
        alertedStoppedChains.clear();
        return { status: 'healthy' as const, metrics: { stoppedRecurrences: 0, newlyDetected: 0 } };
      }

      // Hourly, forever, about the same dead chain is noise that trains you to
      // ignore the channel. Alert once per chain; the warning status persists.
      const fresh = stopped.filter((s) => !alertedStoppedChains.has(s.chainId));
      for (const chain of stopped) alertedStoppedChains.add(chain.chainId);

      if (fresh.length > 0) {
        const { sendTelegramAlert } = await import('../tools/communication/telegram.js');
        await sendTelegramAlert({
          title: 'Harmonogram przestał się odpalać',
          details: [
            `Zatrzymane łańcuchy: ${fresh.length}`,
            '',
            ...fresh.map((c) =>
              `• ${c.targetType}:${c.targetIdentifier} (cron "${c.cronExpression}")\n`
              + `  ostatni przebieg: ${c.completedAt?.toISOString() ?? 'nieznany'}\n`
              + `  taskId: ${c.taskId}`),
            '',
            'Nie utworzono kolejnego wystąpienia — to zadanie samo już nie ruszy.',
            'Naprawa (świadoma, bo wskrzeszone zadanie natychmiast się wykonuje):',
            'repairStoppedRecurrence(<taskId>)',
          ].join('\n'),
          severity: 'critical',
          source: 'scheduled-chains worker',
        });
      }

      return {
        status: 'warning' as const,
        metrics: { stoppedRecurrences: stopped.length, newlyDetected: fresh.length },
        message:
          `${stopped.length} harmonogram(ów) nie ma kolejnego wystąpienia: `
          + stopped.map((c) => `${c.targetIdentifier} (${c.cronExpression})`).join(', '),
      };
    },
  });
}

/** Chains already reported, so an hourly sweep does not repeat itself. */
const alertedStoppedChains = new Set<string>();
