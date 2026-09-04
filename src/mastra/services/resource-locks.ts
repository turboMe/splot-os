import type { Collection, Db } from 'mongodb';
import { getDb } from '../lib/mongo.js';

export type LockMode = 'read' | 'write';

export interface ResourceLockEntry {
  _id?: string;
  resource: string;
  holderId: string;
  taskId?: string;
  agentId?: string;
  mode: LockMode;
  acquiredAt: Date;
  expiresAt: Date;
  metadata?: {
    filePath?: string;
    description?: string;
  };
}

export interface AcquireLockOptions {
  resource: string;
  holderId: string;
  mode: LockMode;
  ttlMs?: number;
  taskId?: string;
  agentId?: string;
  metadata?: {
    filePath?: string;
    description?: string;
  };
}

export interface AcquireLockResult {
  acquired: boolean;
  lock?: ResourceLockEntry;
  activeWriter?: ResourceLockEntry;
  activeReaders?: ResourceLockEntry[];
  warning?: string;
  error?: string;
}

export interface ResourceInspection {
  resource: string;
  hasActiveWriter: boolean;
  activeWriter?: ResourceLockEntry;
  readersCount: number;
  activeReaders: ResourceLockEntry[];
  isLockedForWrite: boolean;
}

const COLLECTION_NAME = 'orchestration_v2_resource_locks';

/**
 * ResourceLockService provides Reader-Writer Locking (RWLock) for files, tasks,
 * and project domains across concurrent agents and worker slots.
 *
 * Rules:
 * 1. Single Exclusive Writer:
 *    - Only ONE agent/worker may hold a WRITE lock on a specific resource (e.g. `file:src/index.ts`).
 *    - Any other worker attempting to write must wait in queue until the writer finishes.
 * 2. Concurrent Shared Readers:
 *    - Multiple agents/workers may hold READ locks on the same file simultaneously.
 *    - If an active writer is working on the file, readers are permitted to inspect it,
 *      but receive a dirty-read notification informing them that the file is currently
 *      being modified and changes may land soon.
 * 3. Instance Isolation:
 *    - Multiple instances of the same domain agent (e.g. 2 coding agents) cannot
 *      mutate the same target simultaneously.
 */
export class ResourceLockService {
  private static instance: ResourceLockService | null = null;
  private inMemoryLocks = new Map<string, ResourceLockEntry>();

  public static getInstance(): ResourceLockService {
    if (!ResourceLockService.instance) {
      ResourceLockService.instance = new ResourceLockService();
    }
    return ResourceLockService.instance;
  }

  private async getCollection(): Promise<Collection<ResourceLockEntry> | null> {
    try {
      const db: Db = await getDb();
      return db.collection<ResourceLockEntry>(COLLECTION_NAME);
    } catch {
      return null;
    }
  }

  /**
   * Acquire a read or write lock for a resource.
   */
  public async acquireLock(opts: AcquireLockOptions): Promise<AcquireLockResult> {
    const now = new Date();
    const ttlMs = opts.ttlMs ?? 60_000;
    const expiresAt = new Date(now.getTime() + ttlMs);
    const col = await this.getCollection();

    const entry: ResourceLockEntry = {
      resource: opts.resource,
      holderId: opts.holderId,
      taskId: opts.taskId,
      agentId: opts.agentId,
      mode: opts.mode,
      acquiredAt: now,
      expiresAt,
      metadata: opts.metadata,
    };

    if (!col) {
      // In-memory fallback
      return this.acquireInMemory(entry, now);
    }

    // Clean expired locks for this resource
    await col.deleteMany({
      resource: opts.resource,
      expiresAt: { $lt: now },
    });

    const activeLocks = await col.find({ resource: opts.resource }).toArray();
    const activeWriter = activeLocks.find(
      (l) => l.mode === 'write' && l.holderId !== opts.holderId,
    );
    const activeReaders = activeLocks.filter(
      (l) => l.mode === 'read' && l.holderId !== opts.holderId,
    );

    if (opts.mode === 'write') {
      if (activeWriter) {
        return {
          acquired: false,
          activeWriter,
          error: `Plik lub zasób "${opts.resource}" jest obecnie zablokowany do zapisu przez zadanie ${activeWriter.taskId ?? activeWriter.holderId} (agent: ${activeWriter.agentId ?? 'nieznany'}). Oczekaj na zwolnienie blokady.`,
        };
      }

      if (activeReaders.length > 0) {
        return {
          acquired: false,
          activeReaders,
          error: `Plik lub zasób "${opts.resource}" jest obecnie czytany przez ${activeReaders.length} proces(ów). Zapis wstrzymany do czasu zakończenia odczytu.`,
        };
      }

      // Upsert writer lock
      await col.updateOne(
        { resource: opts.resource, holderId: opts.holderId },
        { $set: entry },
        { upsert: true },
      );

      return { acquired: true, lock: entry };
    }

    // mode === 'read'
    let warning: string | undefined;
    if (activeWriter) {
      warning = `⚠️ UWAGA: Plik lub zasób "${opts.resource}" jest obecnie modyfikowany przez zadanie ${activeWriter.taskId ?? activeWriter.holderId} (agent: ${activeWriter.agentId ?? 'nieznany'}). Odczytujesz stan bieżący, który po zakończeniu pracy ulegnie zmianie.`;
    }

    // Upsert reader lock
    await col.updateOne(
      { resource: opts.resource, holderId: opts.holderId },
      { $set: entry },
      { upsert: true },
    );

    return {
      acquired: true,
      lock: entry,
      activeWriter,
      warning,
    };
  }

  /**
   * Release a previously acquired lock.
   */
  public async releaseLock(resource: string, holderId: string): Promise<boolean> {
    const col = await this.getCollection();
    if (!col) {
      const key = `${resource}::${holderId}`;
      return this.inMemoryLocks.delete(key);
    }

    const res = await col.deleteOne({ resource, holderId });
    return (res.deletedCount ?? 0) > 0;
  }

  /**
   * Release all locks acquired by a given task.
   */
  public async releaseAllForTask(taskId: string): Promise<number> {
    const col = await this.getCollection();
    if (!col) {
      let count = 0;
      for (const [key, lock] of this.inMemoryLocks.entries()) {
        if (lock.taskId === taskId) {
          this.inMemoryLocks.delete(key);
          count++;
        }
      }
      return count;
    }

    const res = await col.deleteMany({ taskId });
    return res.deletedCount ?? 0;
  }

  /**
   * Inspect current lock status of a resource (who is writing, who is reading).
   */
  public async inspectResource(resource: string): Promise<ResourceInspection> {
    const now = new Date();
    const col = await this.getCollection();

    if (!col) {
      const active: ResourceLockEntry[] = [];
      for (const lock of this.inMemoryLocks.values()) {
        if (lock.resource === resource && lock.expiresAt > now) {
          active.push(lock);
        }
      }
      const writer = active.find((l) => l.mode === 'write');
      const readers = active.filter((l) => l.mode === 'read');
      return {
        resource,
        hasActiveWriter: Boolean(writer),
        activeWriter: writer,
        readersCount: readers.length,
        activeReaders: readers,
        isLockedForWrite: Boolean(writer) || readers.length > 0,
      };
    }

    await col.deleteMany({ resource, expiresAt: { $lt: now } });
    const locks = await col.find({ resource }).toArray();

    const activeWriter = locks.find((l) => l.mode === 'write');
    const activeReaders = locks.filter((l) => l.mode === 'read');

    return {
      resource,
      hasActiveWriter: Boolean(activeWriter),
      activeWriter,
      readersCount: activeReaders.length,
      activeReaders,
      isLockedForWrite: Boolean(activeWriter) || activeReaders.length > 0,
    };
  }

  /**
   * Safe execution wrapper with automatic lock acquisition and release.
   */
  public async withLock<T>(
    opts: AcquireLockOptions,
    fn: (lockResult: AcquireLockResult) => Promise<T>,
  ): Promise<T> {
    const lockResult = await this.acquireLock(opts);
    if (!lockResult.acquired) {
      throw new Error(lockResult.error ?? `Nie udało się uzyskać blokady dla "${opts.resource}"`);
    }

    try {
      return await fn(lockResult);
    } finally {
      await this.releaseLock(opts.resource, opts.holderId).catch(() => undefined);
    }
  }

  private acquireInMemory(entry: ResourceLockEntry, now: Date): AcquireLockResult {
    // Purge expired
    for (const [key, lock] of this.inMemoryLocks.entries()) {
      if (lock.expiresAt <= now) this.inMemoryLocks.delete(key);
    }

    const activeLocks = Array.from(this.inMemoryLocks.values()).filter(
      (l) => l.resource === entry.resource,
    );
    const activeWriter = activeLocks.find(
      (l) => l.mode === 'write' && l.holderId !== entry.holderId,
    );
    const activeReaders = activeLocks.filter(
      (l) => l.mode === 'read' && l.holderId !== entry.holderId,
    );

    if (entry.mode === 'write') {
      if (activeWriter) {
        return {
          acquired: false,
          activeWriter,
          error: `Plik lub zasób "${entry.resource}" jest obecnie zablokowany do zapisu przez ${activeWriter.taskId ?? activeWriter.holderId}`,
        };
      }
      if (activeReaders.length > 0) {
        return {
          acquired: false,
          activeReaders,
          error: `Plik lub zasób "${entry.resource}" jest obecnie czytany przez ${activeReaders.length} proces(ów)`,
        };
      }
      this.inMemoryLocks.set(`${entry.resource}::${entry.holderId}`, entry);
      return { acquired: true, lock: entry };
    }

    let warning: string | undefined;
    if (activeWriter) {
      warning = `⚠️ UWAGA: Plik "${entry.resource}" jest obecnie modyfikowany przez zadanie ${activeWriter.taskId ?? activeWriter.holderId}`;
    }

    this.inMemoryLocks.set(`${entry.resource}::${entry.holderId}`, entry);
    return { acquired: true, lock: entry, activeWriter, warning };
  }
}

export function getResourceLockService(): ResourceLockService {
  return ResourceLockService.getInstance();
}
