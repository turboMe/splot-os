import type { MongoClient, Db } from 'mongodb';
import { runWorkerOnce, type WorkerFixture, type WorkerRunOptions, okWorker } from './worker.js';

export interface WorkerPoolConfig {
  /** Number of concurrent worker slots. Defaults to process.env.ORCHESTRATION_WORKER_CONCURRENCY or 12. */
  concurrency?: number;
  /** Polling interval when no tasks are available (ms). Default 250ms. */
  idleWaitMs?: number;
  /** Lease TTL per claimed attempt (ms). Default 30,000ms. */
  leaseTtlMs?: number;
  /** Optional operator pause check (stops claiming new work). */
  pauseDispatch?: () => Promise<boolean>;
}

export interface WorkerSlotStatus {
  slotIndex: number;
  workerInstanceId: string;
  state: 'idle' | 'busy' | 'stopped';
  lastClaimedAt?: Date;
  completedCount: number;
}

export interface WorkerPoolStatus {
  running: boolean;
  concurrency: number;
  activeCount: number;
  idleCount: number;
  slots: WorkerSlotStatus[];
}

/**
 * WorkerPool manages N concurrent worker slots executing V2 orchestration attempts.
 *
 * Architecture:
 * - Each slot runs an independent async loop claiming attempts via `runWorkerOnce`
 *   with a distinct `workerInstanceId: worker-slot-${i}`.
 * - MongoDB transactions and atomicity (`findOneAndUpdate` on attempt + `attemptFence`)
 *   guarantee that two slots never conflict or claim the same attempt.
 * - Decoupled from the `drainLane` (decider/planner) loop, so long-running agent
 *   executions (e.g. 10m Writer or 15m Automation) do NOT starve the orchestrator.
 */
export class WorkerPool {
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly fixture: WorkerFixture;
  private readonly concurrency: number;
  private readonly idleWaitMs: number;
  private readonly leaseTtlMs: number;
  private readonly pauseDispatch?: () => Promise<boolean>;

  private running = false;
  private shutdownController = new AbortController();
  private slotLoops: Promise<void>[] = [];
  private slotStatuses: WorkerSlotStatus[] = [];

  constructor(
    client: MongoClient,
    db: Db,
    fixture: WorkerFixture = okWorker,
    config: WorkerPoolConfig = {},
  ) {
    this.client = client;
    this.db = db;
    this.fixture = fixture;
    this.concurrency = config.concurrency
      ?? (Number(process.env.ORCHESTRATION_WORKER_CONCURRENCY) || 12);
    this.idleWaitMs = config.idleWaitMs ?? 250;
    this.leaseTtlMs = config.leaseTtlMs ?? 30_000;
    this.pauseDispatch = config.pauseDispatch;

    this.slotStatuses = Array.from({ length: this.concurrency }, (_, i) => ({
      slotIndex: i,
      workerInstanceId: `worker-slot-${i + 1}`,
      state: 'stopped',
      completedCount: 0,
    }));
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.shutdownController = new AbortController();

    this.slotLoops = this.slotStatuses.map((slot) => this.runSlotLoop(slot));
  }

  public async stop(timeoutMs = 10_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.shutdownController.abort('worker_pool_stopped');

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([
      Promise.all(this.slotLoops).catch(() => undefined),
      timeout,
    ]);

    for (const slot of this.slotStatuses) {
      slot.state = 'stopped';
    }
  }

  public getStatus(): WorkerPoolStatus {
    const activeCount = this.slotStatuses.filter((s) => s.state === 'busy').length;
    const idleCount = this.slotStatuses.filter((s) => s.state === 'idle').length;

    return {
      running: this.running,
      concurrency: this.concurrency,
      activeCount,
      idleCount,
      slots: this.slotStatuses.map((s) => ({ ...s })),
    };
  }

  private async runSlotLoop(slot: WorkerSlotStatus): Promise<void> {
    const opts: WorkerRunOptions = {
      workerInstanceId: slot.workerInstanceId,
      leaseTtlMs: this.leaseTtlMs,
    };

    while (this.running && !this.shutdownController.signal.aborted) {
      try {
        if (this.pauseDispatch) {
          const paused = await this.pauseDispatch().catch(() => false);
          if (paused) {
            slot.state = 'idle';
            await this.sleep(this.idleWaitMs);
            continue;
          }
        }

        slot.state = 'idle';
        const didWork = await runWorkerOnce(this.client, this.db, this.fixture, opts);

        if (didWork) {
          slot.state = 'busy';
          slot.lastClaimedAt = new Date();
          slot.completedCount++;
          // Loop immediately without delay to pick up the next task
          continue;
        }

        slot.state = 'idle';
        await this.sleep(this.idleWaitMs);
      } catch (err) {
        if (this.shutdownController.signal.aborted) break;
        console.warn(`[orch-v2-worker-pool] ${slot.workerInstanceId} error: ${(err as Error).message}`);
        await this.sleep(this.idleWaitMs);
      }
    }
    slot.state = 'stopped';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.shutdownController.signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      this.shutdownController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
