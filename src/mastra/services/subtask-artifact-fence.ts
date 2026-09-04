/**
 * Narrow J2 fencing for parallel-subtask writes to code_task_artifacts.
 *
 * A lease expiring does NOT by itself invalidate the owner. It only makes the
 * slot claimable. The old owner is fenced out after a replacement atomically
 * advances the counter. This distinction is deliberate: a worker that merely
 * lost Mongo for a while must still finish when nobody moved on without it.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db, Document, Filter } from 'mongodb';

import {
  getHarnessExecutionContext,
  type SubtaskArtifactLeaseIdentity,
} from './harness-execution-context.js';

export const SUBTASK_ARTIFACT_LEASE_TTL_MS = 30_000;
const SUBTASK_ARTIFACT_HEARTBEAT_MS = 10_000;

function leaseKeyFor(subtaskId: string): string {
  return `s_${createHash('sha256').update(subtaskId).digest('hex').slice(0, 32)}`;
}

function leasePath(leaseKey: string): string {
  return `subtaskLeases.${leaseKey}`;
}

function leaseFromDocument(
  doc: Document | null,
  leaseKey: string,
): Record<string, unknown> | undefined {
  const leases = doc?.subtaskLeases;
  if (!leases || typeof leases !== 'object') return undefined;
  const lease = (leases as Record<string, unknown>)[leaseKey];
  return lease && typeof lease === 'object' ? lease as Record<string, unknown> : undefined;
}

/**
 * Claim an absent/expired slot and advance its monotonic fence atomically.
 * Returns null when another unexpired owner still holds the subtask.
 */
export async function claimSubtaskArtifactLease(
  db: Db,
  input: {
    taskId: string;
    subtaskId: string;
    ownerId?: string;
    leaseTtlMs?: number;
  },
): Promise<SubtaskArtifactLeaseIdentity | null> {
  const ownerId = input.ownerId ?? randomUUID();
  const leaseTtlMs = Math.max(1, Math.floor(input.leaseTtlMs ?? SUBTASK_ARTIFACT_LEASE_TTL_MS));
  const leaseKey = leaseKeyFor(input.subtaskId);
  const path = leasePath(leaseKey);
  const expiresPath = `$${path}.leaseExpiresAt`;
  const fencePath = `$${path}.fence`;

  const claimed = await db.collection('code_task_artifacts').findOneAndUpdate(
    {
      taskId: input.taskId,
      $or: [
        { [path]: { $exists: false } },
        {
          $expr: {
            $lte: [
              { $ifNull: [expiresPath, new Date(0)] },
              '$$NOW',
            ],
          },
        },
      ],
    },
    [{
      $set: {
        [path]: {
          subtaskId: input.subtaskId,
          ownerId,
          fence: { $add: [{ $ifNull: [fencePath, 0] }, 1] },
          claimedAt: '$$NOW',
          leaseExpiresAt: {
            $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: leaseTtlMs },
          },
        },
      },
    }],
    { returnDocument: 'after', projection: { taskId: 1, [path]: 1 } },
  );

  const stored = leaseFromDocument(claimed, leaseKey);
  if (!stored || stored.ownerId !== ownerId || typeof stored.fence !== 'number') return null;
  return {
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    leaseKey,
    ownerId,
    fence: stored.fence,
    leaseTtlMs,
  };
}

/** Renew even after expiry, provided nobody advanced the fence meanwhile. */
export async function renewSubtaskArtifactLease(
  db: Db,
  lease: SubtaskArtifactLeaseIdentity,
  leaseTtlMs = lease.leaseTtlMs ?? SUBTASK_ARTIFACT_LEASE_TTL_MS,
): Promise<boolean> {
  const path = leasePath(lease.leaseKey);
  const result = await db.collection('code_task_artifacts').updateOne(
    {
      taskId: lease.taskId,
      [`${path}.ownerId`]: lease.ownerId,
      [`${path}.fence`]: lease.fence,
    },
    [{
      $set: {
        [`${path}.leaseExpiresAt`]: {
          $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: leaseTtlMs },
        },
        [`${path}.renewedAt`]: '$$NOW',
      },
    }],
  );
  return result.matchedCount === 1;
}

/** Make a completed attempt immediately claimable without erasing its fence. */
export async function yieldSubtaskArtifactLease(
  db: Db,
  lease: SubtaskArtifactLeaseIdentity,
): Promise<boolean> {
  const path = leasePath(lease.leaseKey);
  const result = await db.collection('code_task_artifacts').updateOne(
    {
      taskId: lease.taskId,
      [`${path}.ownerId`]: lease.ownerId,
      [`${path}.fence`]: lease.fence,
    },
    [{
      $set: {
        [`${path}.leaseExpiresAt`]: '$$NOW',
        [`${path}.yieldedAt`]: '$$NOW',
      },
    }],
  );
  return result.matchedCount === 1;
}

export function currentSubtaskArtifactLease(
  taskId: string,
): SubtaskArtifactLeaseIdentity | undefined {
  const lease = getHarnessExecutionContext()?.artifactLease;
  if (!lease) return undefined;
  if (lease.taskId !== taskId) {
    throw new Error(
      `Subtask artifact lease belongs to task ${lease.taskId}, not requested task ${taskId}.`,
    );
  }
  return lease;
}

/**
 * The predicate that makes an artifact mutation fenced. With no parallel-run
 * lease, preserve the existing single-agent/workflow behavior.
 */
export function subtaskArtifactMutationFilter(
  taskId: string,
  explicitLease?: SubtaskArtifactLeaseIdentity,
): Filter<Document> {
  const lease = explicitLease ?? currentSubtaskArtifactLease(taskId);
  if (!lease) return { taskId };
  if (lease.taskId !== taskId) {
    throw new Error(`Artifact mutation for ${taskId} used lease from ${lease.taskId}.`);
  }
  const path = leasePath(lease.leaseKey);
  return {
    taskId,
    [`${path}.ownerId`]: lease.ownerId,
    [`${path}.fence`]: lease.fence,
  };
}

export function staleSubtaskArtifactMessage(taskId: string): string {
  const lease = currentSubtaskArtifactLease(taskId);
  return lease
    ? `Subtask ${lease.subtaskId} lost artifact ownership (stale fence ${lease.fence}); write refused.`
    : `Artifact ${taskId} does not exist.`;
}

export function assertSubtaskArtifactMutationMatched(
  taskId: string,
  matchedCount: number,
  operation: string,
): void {
  if (matchedCount > 0) return;
  const lease = currentSubtaskArtifactLease(taskId);
  if (lease) {
    throw new Error(`${staleSubtaskArtifactMessage(taskId)} Operation: ${operation}.`);
  }
}

/** Start best-effort renewal for the lifetime of one executeSubtask call. */
export function startSubtaskArtifactHeartbeat(
  db: Db,
  lease: SubtaskArtifactLeaseIdentity,
  intervalMs = Math.min(
    SUBTASK_ARTIFACT_HEARTBEAT_MS,
    Math.max(1, Math.floor((lease.leaseTtlMs ?? SUBTASK_ARTIFACT_LEASE_TTL_MS) / 3)),
  ),
): () => Promise<void> {
  let stopped = false;
  let warned = false;
  let inFlight: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = renewSubtaskArtifactLease(db, lease)
      .then((held) => {
        if (!held && !warned) {
          warned = true;
          console.warn(
            `[SubtaskArtifactFence] ${lease.taskId}/${lease.subtaskId} lost fence ${lease.fence}.`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[SubtaskArtifactFence] heartbeat failed for ${lease.taskId}/${lease.subtaskId}: `
          + (error as Error).message,
        );
      })
      .finally(() => { inFlight = undefined; });
  }, intervalMs);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
