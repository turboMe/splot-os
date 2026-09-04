/**
 * Pending message queue for safe soft interrupts.
 *
 * Messages are only consumed at safe points: before a subtask/group, retry, or
 * escalation. Nothing here attempts to inject into an active provider stream.
 */

import { randomUUID } from 'crypto';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import {
  agentIdFieldFilter,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';

export type PendingMessageSource = 'user' | 'system' | 'file_activity' | 'background_task' | 'automation_job';
/**
 * `claimed` is the lease state introduced by SEC-001 (F2). Before it, a claim
 * wrote `consumed` in the same atomic update that fetched the record, so a crash
 * between fetching a message and actually showing it to the agent lost that
 * message permanently — the user's interrupt simply vanished.
 *
 * Now a claim only leases the record; `consumed` is written on acknowledgement,
 * after the content has reached the prompt. A lease that expires without an ACK
 * is reclaimed back to `pending`, so a crash costs a redelivery instead of the
 * message. That makes delivery at-least-once under crash and exactly-once in the
 * normal path — the correct trade for a user-visible interrupt.
 */
export type PendingMessageStatus = 'pending' | 'claimed' | 'consumed' | 'cancelled' | 'stale';

export type PendingMessage = {
  id: string;
  taskId?: string;
  threadId?: string;
  targetAgentId?: string | null;
  source: PendingMessageSource;
  content: string;
  urgent: boolean;
  status: PendingMessageStatus;
  createdAt: Date;
  consumedAt?: Date;
  consumedBy?: string;
  /** Lease owner, set at claim time and required to acknowledge. */
  claimedBy?: string;
  claimedAt?: Date;
  /** Lease deadline; a `claimed` record past it is reclaimable. */
  leaseExpiresAt?: Date;
  /** How many times this record was reclaimed after an unacknowledged lease. */
  redeliveryCount?: number;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
};

export type QueuePendingMessageInput = {
  taskId?: string;
  threadId?: string;
  targetAgentId: string;
  source: PendingMessageSource;
  content: string;
  urgent?: boolean;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
  /**
   * Deterministic id, making the queue call idempotent.
   *
   * For a producer that can legitimately re-run — a durable-job bridge polling a
   * terminal job, a redelivered outbox row — at-least-once is the only honest
   * delivery guarantee available, and the cost of the "at least" is a duplicate
   * result landing in the agent's next turn. Passing a key derived from the
   * source event turns that duplicate into a no-op instead. Omit it and the id
   * is random, exactly as before.
   */
  messageId?: string;
};

export type TakePendingMessagesInput = {
  taskId?: string;
  threadId?: string;
  agentId: string;
  subtaskId?: string;
  limit?: number;
  sources?: readonly PendingMessageSource[];
};

const COLLECTION = 'pending_user_messages';
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const MAX_TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;
/**
 * Lease window for a claimed-but-unacknowledged message. Long enough that a
 * healthy consumer always acknowledges inside it (the gap between claiming and
 * formatting the prompt is milliseconds), short enough that a crashed consumer
 * releases the message quickly rather than stranding a user interrupt.
 */
const CLAIM_LEASE_MS = 120_000;
/**
 * Redelivery ceiling. A message that keeps being claimed and never acknowledged
 * points at a consumer that cannot process it; after this many attempts it is
 * parked as `stale` instead of cycling forever.
 */
const MAX_REDELIVERIES = 3;

function normalizedValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizedTtlMs(value: number | undefined): number | undefined {
  if (value === undefined) return DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TTL_MS) {
    return undefined;
  }
  return value;
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, MAX_LIMIT);
}

/**
 * Claims a bounded batch without losing already-claimed records when a later
 * storage operation fails. Exported so the partial-failure contract can be
 * exercised without making a real MongoDB connection fail mid-batch.
 */
export async function collectAtomicClaims<T>(
  limit: number,
  claimOne: () => Promise<T | null>,
): Promise<{ claimed: T[]; interrupted: boolean }> {
  const claimed: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    try {
      const record = await claimOne();
      if (!record) return { claimed, interrupted: false };
      claimed.push(record);
    } catch {
      return { claimed, interrupted: true };
    }
  }
  return { claimed, interrupted: false };
}

export async function queuePendingMessage(input: QueuePendingMessageInput): Promise<string | undefined> {
  if (!isHarnessFeatureEnabled('FEATURE_SOFT_INTERRUPTS', true)) return undefined;
  const taskId = normalizedValue(input.taskId);
  const threadId = normalizedValue(input.threadId);
  const targetAgentId = canonicalizeRuntimeAgentId(normalizedValue(input.targetAgentId));
  const ttlMs = normalizedTtlMs(input.ttlMs);
  if ((!taskId && !threadId) || !targetAgentId || ttlMs === undefined) {
    return undefined;
  }

  const content = redactSecrets(input.content.trim()).text;
  if (!content) return undefined;

  const id = normalizedValue(input.messageId) ?? randomUUID();
  const now = new Date();
  const doc: PendingMessage = {
    id,
    taskId,
    threadId,
    targetAgentId,
    source: input.source,
    content,
    urgent: Boolean(input.urgent),
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    metadata: input.metadata,
  };

  try {
    const db = await getDb();
    if (input.messageId !== undefined) {
      // `_id` carries the caller's key, so a redelivered source event collides
      // instead of queueing a second copy. `$setOnInsert` keeps the FIRST
      // version of the message — a re-run must not rewrite content the agent may
      // already have claimed. Nothing reads `_id` on this collection; the `id`
      // field stays the identity every consumer uses.
      const upserted = await db.collection<PendingMessage & { _id: string }>(COLLECTION).updateOne(
        { _id: id },
        { $setOnInsert: doc as PendingMessage & { _id: string } },
        { upsert: true },
      );
      if (upserted.upsertedCount !== 1) return id;
    } else {
      await db.collection<PendingMessage>(COLLECTION).insertOne(doc);
    }
    await logHarnessEvent({
      type: 'soft_interrupt_queued',
      agentId: targetAgentId,
      threadId,
      taskId,
      feature: 'pending_message_queue',
      status: 'success',
      output: content,
      data: {
        messageId: id,
        source: doc.source,
        urgent: doc.urgent,
        metadata: input.metadata,
      },
    });
    return id;
  } catch {
    console.warn('[PendingMessageQueue] queue_failed');
    return undefined;
  }
}

export async function takePendingMessages(input: TakePendingMessagesInput): Promise<PendingMessage[]> {
  if (!isHarnessFeatureEnabled('FEATURE_SOFT_INTERRUPTS', true)) return [];
  const taskId = normalizedValue(input.taskId);
  const threadId = normalizedValue(input.threadId);
  const agentId = canonicalizeRuntimeAgentId(normalizedValue(input.agentId));
  const limit = normalizedLimit(input.limit);
  if (
    (!taskId && !threadId)
    || !agentId
    || limit === 0
    || (input.sources !== undefined && input.sources.length === 0)
  ) {
    return [];
  }

  try {
    const db = await getDb();
    const collection = db.collection<PendingMessage>(COLLECTION);
    const consumedBy = [
      agentId,
      input.subtaskId,
    ].filter(Boolean).join(':');

    // SEC-001 — reclaim first: a lease that expired without an ACK belongs to a
    // consumer that died holding the message. Returning it to `pending` before
    // this claim means the crashed interrupt is redelivered now, not lost.
    await reclaimExpiredClaims({ taskId, threadId, agentId, collection });

    const batch = await collectAtomicClaims(limit, () =>
      collection.findOneAndUpdate(
        {
          ...scopedTargetQuery({ taskId, threadId, agentId }),
          status: 'pending',
          ...(input.sources
            ? { source: { $in: [...new Set(input.sources)] } }
            : {}),
          expiresAt: { $type: 'date' },
          $expr: { $gt: ['$expiresAt', '$$NOW'] },
        },
        {
          // Lease, not consume: the record is only acknowledged once its content
          // has actually reached the agent (see `ackPendingMessages`).
          $set: {
            status: 'claimed',
            claimedBy: consumedBy,
            leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
          },
          $currentDate: { claimedAt: true },
        },
        {
          sort: { urgent: -1, createdAt: 1, id: 1 },
          returnDocument: 'after',
        },
      ),
    );
    if (batch.interrupted) {
      console.warn('[PendingMessageQueue] take_incomplete');
    }

    for (const message of batch.claimed) {
      await logHarnessEvent({
        type: 'soft_interrupt_consumed',
        agentId,
        threadId: message.threadId ?? threadId,
        taskId: message.taskId ?? taskId,
        subtaskId: input.subtaskId,
        feature: 'pending_message_queue',
        status: 'success',
        output: message.content,
        data: {
          messageId: message.id,
          source: message.source,
          urgent: message.urgent,
        },
      }).catch(() => {
        console.warn('[PendingMessageQueue] consumed_event_log_failed');
      });
    }

    return batch.claimed;
  } catch {
    console.warn('[PendingMessageQueue] take_failed');
    return [];
  }
}

/**
 * The slice of the Mongo collection API that reclaim needs. Narrowing it here
 * lets the contract check drive the state machine without a live database,
 * which is the only way to exercise a crashed lease deterministically.
 */
export interface PendingMessageCollectionLike {
  updateMany: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<{ modifiedCount?: number }>;
}

/**
 * Return leases that expired without an acknowledgement to `pending` (SEC-001).
 *
 * Scoped to the same task/thread/agent the caller is about to claim from, so one
 * consumer can never disturb another's in-flight leases. A record that has been
 * redelivered `MAX_REDELIVERIES` times is parked as `stale` rather than cycling
 * forever — a consumer that never acknowledges will not be fixed by trying again.
 *
 * Exported for the contract check; callers normally get this via `takePendingMessages`.
 */
export async function reclaimExpiredClaims(input: {
  taskId?: string;
  threadId?: string;
  agentId: string;
  collection?: PendingMessageCollectionLike;
}): Promise<number> {
  const collection: PendingMessageCollectionLike = input.collection
    ?? ((await getDb()).collection<PendingMessage>(COLLECTION) as unknown as PendingMessageCollectionLike);
  const scope = {
    ...scopedTargetQuery({
      taskId: input.taskId,
      threadId: input.threadId,
      agentId: input.agentId,
    }),
    status: 'claimed',
    leaseExpiresAt: { $type: 'date' },
    $expr: { $lte: ['$leaseExpiresAt', '$$NOW'] },
  };

  // Past the ceiling the record is parked, not retried.
  const parked = await collection.updateMany(
    { ...scope, redeliveryCount: { $gte: MAX_REDELIVERIES } },
    {
      $set: { status: 'stale' },
      $unset: { claimedBy: '', claimedAt: '', leaseExpiresAt: '' },
    },
  );

  const released = await collection.updateMany(
    { ...scope, $or: [{ redeliveryCount: { $lt: MAX_REDELIVERIES } }, { redeliveryCount: { $exists: false } }] },
    {
      $set: { status: 'pending' },
      $inc: { redeliveryCount: 1 },
      $unset: { claimedBy: '', claimedAt: '', leaseExpiresAt: '' },
    },
  );

  return (released.modifiedCount ?? 0) + (parked.modifiedCount ?? 0);
}

/**
 * Acknowledge claimed messages: `claimed → consumed` (SEC-001).
 *
 * Called once the content has reached the agent, so a crash before this point
 * leaves the message reclaimable instead of silently consumed. The update is
 * fenced on the exact lease owner, so a redelivered record cannot be
 * acknowledged by the consumer that previously lost it.
 *
 * Best-effort by design: failing to acknowledge costs a redelivery, never the
 * message, so it must not break the caller's main path.
 */
export async function ackPendingMessages(input: {
  messages: readonly PendingMessage[];
  agentId: string;
  subtaskId?: string;
}): Promise<number> {
  const agentId = canonicalizeRuntimeAgentId(normalizedValue(input.agentId));
  if (!agentId || input.messages.length === 0) return 0;
  const claimedBy = [agentId, input.subtaskId].filter(Boolean).join(':');
  const ids = input.messages
    .filter((message) => message.status === 'claimed')
    .map((message) => message.id);
  if (ids.length === 0) return 0;

  try {
    const db = await getDb();
    const result = await db.collection<PendingMessage>(COLLECTION).updateMany(
      { id: { $in: ids }, status: 'claimed', claimedBy },
      {
        $set: { status: 'consumed', consumedBy: claimedBy },
        $currentDate: { consumedAt: true },
        $unset: { leaseExpiresAt: '' },
      },
    );
    return result.modifiedCount ?? 0;
  } catch {
    console.warn('[PendingMessageQueue] ack_failed');
    return 0;
  }
}

export async function hasUrgentInterrupt(
  input: Pick<
    TakePendingMessagesInput,
    'taskId' | 'threadId' | 'agentId'
  >,
): Promise<boolean> {
  if (!isHarnessFeatureEnabled('FEATURE_SOFT_INTERRUPTS', true)) return false;
  const taskId = normalizedValue(input.taskId);
  const threadId = normalizedValue(input.threadId);
  const agentId = canonicalizeRuntimeAgentId(normalizedValue(input.agentId));
  if ((!taskId && !threadId) || !agentId) return false;

  try {
    const db = await getDb();
    const found = await db.collection<PendingMessage>(COLLECTION).findOne({
      ...scopedTargetQuery({ taskId, threadId, agentId }),
      status: 'pending',
      urgent: true,
      expiresAt: { $type: 'date' },
      $expr: { $gt: ['$expiresAt', '$$NOW'] },
    });
    return Boolean(found);
  } catch {
    console.warn('[PendingMessageQueue] urgent_lookup_failed');
    return false;
  }
}

export function formatPendingMessagesForPrompt(messages: PendingMessage[]): string {
  if (messages.length === 0) return '';

  const urgent = messages.some((message) => message.urgent);
  const header = urgent
    ? '## User/System Interrupt\nUrgent instruction received at a safe interrupt point:'
    : '## User/System Interrupt\nPending instruction received at a safe interrupt point:';

  const body = messages.map((message, index) => {
    const label = message.urgent ? 'URGENT' : message.source;
    return `${index + 1}. [${label}] ${message.content}`;
  });

  return [
    header,
    ...body,
    urgent
      ? 'Re-evaluate the remaining plan before continuing. Do not ignore this instruction.'
      : 'Apply this instruction if it is relevant to the current subtask.',
  ].join('\n');
}

function scopeQuery(input: Pick<TakePendingMessagesInput, 'taskId' | 'threadId'>): Record<string, unknown> {
  return {
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
}

function targetAgentQuery(agentId: string): Record<string, unknown> {
  const targetFilter = agentIdFieldFilter(agentId);
  return { targetAgentId: targetFilter ?? '__invalid_agent__' };
}

function scopedTargetQuery(input: TakePendingMessagesInput): Record<string, unknown> {
  return {
    ...scopeQuery(input),
    ...targetAgentQuery(input.agentId),
  };
}
