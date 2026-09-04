/**
 * C boundary — Conversation Writer (plan §4.4, §7.5, §7 "granica C", ORC-TXN-C-01).
 *
 * The A boundary finalizes an attempt+result; the B boundary reduces a job from
 * its tasks and emits a `JobTerminal` outbox event. This is the third, separate
 * atomic boundary: the Conversation Writer drains projectable domain events and
 * delivers them back into the user's conversation.
 *
 * Invariants (skeleton scope):
 *  - **exactly-once logically**: a projection is keyed by a deterministic
 *    composite `${conversationId}:${logicalEventId}:${target}`; a redelivered
 *    source event finds that mailbox slot already claimed and produces no second
 *    message (read-then-insert — see the comment at the guard for why catching the
 *    duplicate key instead could not work);
 *  - **ordered read model**: each applied projection takes the next per-conversation
 *    `sequence` via a CAS `$inc` on the conversation cursor;
 *  - **at-least-once transport**: a `PENDING` delivery is created per projection;
 *    the transport flips it to `DELIVERED` and the client dedups on `deliveryId`.
 *
 * The source of truth stays the structured job state/result — the projection is a
 * derived, re-deliverable view. `defaultSynth` renders it deterministically; a real
 * synthesis policy replaces it without changing the boundary.
 *
 * Not yet built (deferred): natural-synthesis via a projection *task*, general
 * progress projection, multi-channel delivery, transport ACK/EXPIRED, and
 * read-model gap reconciliation.
 */
import type { Db, MongoClient } from 'mongodb';
import { runTxn, isDuplicateKeyError } from './txn.js';
import {
  COLLECTIONS,
  type JobDoc, type OutboxDoc, type MailboxDoc, type ProjectionDoc,
  type DeliveryDoc, type ConversationCursorDoc,
} from './collections.js';

/**
 * Outbox domain-event types the Conversation Writer projects:
 *  - `JobTerminal`      — the job finished (terminal outcome);
 *  - `JobAwaitingInput` — the job paused and needs the user (question/approval).
 * Progress events can be added here without touching the boundary.
 */
export const PROJECTABLE_TYPES = ['JobTerminal', 'JobAwaitingInput'] as const;
export const PROJECTION_POLICY_VERSION = 1;
const TARGET = 'conversation';

/** Renders the durable, user-facing projection payload from structured state. */
export type ProjectionSynth = (input: { job: JobDoc; event: OutboxDoc }) => Record<string, unknown>;

export const defaultSynth: ProjectionSynth = ({ job, event }) => {
  if (event.type === 'JobAwaitingInput') {
    const p = event.payload as {
      requestId?: string;
      kind?: 'user' | 'approval' | 'external' | 'dependency';
      action?: string;
      expiresAt?: string | Date;
    };
    const requestKind = p.kind ?? 'user';
    const action = p.action ?? '';
    const lead = requestKind === 'user'
      ? 'czeka na Twoją odpowiedź'
      : requestKind === 'approval'
        ? 'wymaga Twojej decyzji'
        : requestKind === 'external'
          ? 'czeka na zdarzenie zewnętrzne'
          : 'czeka na zależność';
    return {
      kind: 'job_awaiting_input',
      jobId: job._id,
      goal: job.goal,
      requestId: p.requestId,
      requestKind,
      action,
      expiresAt: p.expiresAt instanceof Date ? p.expiresAt.toISOString() : (p.expiresAt ?? null),
      text: `Zadanie „${job.goal}" ${lead}: ${action}`.trim(),
    };
  }
  const terminalOutcome = (event.payload as { terminalOutcome?: string }).terminalOutcome ?? job.terminalOutcome;
  return {
    kind: 'job_terminal',
    jobId: job._id,
    goal: job.goal,
    terminalOutcome,
    text: `Zadanie „${job.goal}" zakończone: ${terminalOutcome}.`,
  };
};

export interface ProjectOnceResult {
  applied: boolean; // false = the event was a duplicate (already projected)
  jobId: string;
  projectionId?: string;
  deliveryId?: string;
  sequence?: number;
}

/**
 * Claim and apply the oldest PENDING projectable event in one atomic C boundary.
 * Returns `null` when nothing is pending. `applied:false` means the event had
 * already been projected (idempotent no-op) and was settled.
 */
export async function projectConversationOnce(
  client: MongoClient, db: Db, synth: ProjectionSynth = defaultSynth,
): Promise<ProjectOnceResult | null> {
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const mailbox = db.collection<MailboxDoc>(COLLECTIONS.mailbox);
  const projections = db.collection<ProjectionDoc>(COLLECTIONS.projections);
  const deliveries = db.collection<DeliveryDoc>(COLLECTIONS.deliveries);
  const cursor = db.collection<ConversationCursorDoc>(COLLECTIONS.convCursor);

  const { value } = await runTxn(client, async (session) => {
    const event = await outbox.findOne(
      { type: { $in: [...PROJECTABLE_TYPES] }, state: 'PENDING' },
      { session, sort: { createdAt: 1 } },
    );
    if (!event) return null;

    const job = await jobs.findOne({ _id: event.aggregate }, { session });
    // The job is the source of truth; if it vanished, settle the event and move on.
    if (!job) {
      await outbox.updateOne({ _id: event._id, state: 'PENDING' }, { $set: { state: 'DELIVERED' } }, { session });
      return { applied: false, jobId: event.aggregate } satisfies ProjectOnceResult;
    }

    const conversationId = job.conversationId;
    const logicalEventId = event._id;
    const composite = `${conversationId}:${logicalEventId}:${TARGET}`;
    const now = new Date();

    // Idempotency guard: claim the mailbox slot. An existing slot = already applied.
    //
    // The READ has to come first, and this is not a style preference. A duplicate-key
    // error inside a transaction makes the SERVER abort that transaction: the next
    // write returns code 251 `Transaction ... has been aborted`, labelled
    // `TransientTransactionError`. Measured under `f8:no-lost-outbox`. So catching
    // 11000 here and settling the event in the same transaction cannot work — the
    // settle aborts, `runTxn` reads the transient label, restarts the callback, hits
    // the same duplicate, and burns all 50 retries. A redelivered event would then be
    // undrainable forever, and because this writer always claims the OLDEST pending
    // event, one such event blocks EVERY conversation behind it.
    //
    // Every other boundary in this store recovers from a duplicate key OUTSIDE
    // `runTxn` for exactly this reason (`command-boundary.ts:184`,
    // `control-boundary.ts:408/972/1164/1253`). This one is the odd one out.
    const claimed = await mailbox.findOne({ _id: composite }, { session });
    if (claimed) {
      await outbox.updateOne({ _id: event._id, state: 'PENDING' }, { $set: { state: 'DELIVERED' } }, { session });
      return { applied: false, jobId: job._id } satisfies ProjectOnceResult;
    }
    try {
      await mailbox.insertOne({
        _id: composite, conversationId, logicalEventId, target: TARGET,
        jobId: job._id, status: 'APPLIED', appliedAt: now,
      }, { session });
    } catch (err) {
      // Under snapshot isolation a concurrent projector loses on a WRITE CONFLICT,
      // not a duplicate key (measured), so this branch should be unreachable — which
      // is precisely why it must not pretend to handle anything. The transaction is
      // already dead; nothing more can be written here. Surface it and let the next
      // drain take the read branch above, which settles it cleanly.
      if (isDuplicateKeyError(err)) {
        throw new Error(
          `conversation projection ${composite} lost the mailbox slot after reading it as free; `
          + 'the transaction is aborted — the next drain settles it', { cause: err },
        );
      }
      throw err;
    }

    // Assign the next per-conversation sequence via CAS $inc (upsert on first use).
    const cur = await cursor.findOneAndUpdate(
      { _id: conversationId }, { $inc: { sequence: 1 } },
      { upsert: true, returnDocument: 'after', session },
    );
    const sequence = cur!.sequence;

    await projections.insertOne({
      _id: composite, conversationId, resourceId: job.resourceId, logicalEventId, target: TARGET, jobId: job._id,
      sequence, projectionPolicyVersion: PROJECTION_POLICY_VERSION,
      payload: synth({ job, event }), createdAt: now,
    }, { session });

    const deliveryId = `dlv_${globalThis.crypto.randomUUID()}`;
    await deliveries.insertOne({
      _id: deliveryId, projectionId: composite, conversationId, target: TARGET,
      channel: 'default', sequence, state: 'PENDING', createdAt: now, updatedAt: now,
    }, { session });

    await outbox.updateOne({ _id: event._id, state: 'PENDING' }, { $set: { state: 'DELIVERED' } }, { session });
    return { applied: true, jobId: job._id, projectionId: composite, deliveryId, sequence } satisfies ProjectOnceResult;
  });

  return value;
}

/** Drain every pending projectable event. Returns the count actually projected. */
export async function drainConversation(
  client: MongoClient, db: Db, synth: ProjectionSynth = defaultSynth,
): Promise<number> {
  let projected = 0;
  for (;;) {
    const r = await projectConversationOnce(client, db, synth);
    if (r === null) break;
    if (r.applied) projected++;
  }
  return projected;
}

/** Transport ACK: flip a delivery `PENDING → DELIVERED`. Idempotent. */
export async function markDelivered(client: MongoClient, db: Db, deliveryId: string): Promise<boolean> {
  const { value } = await runTxn(client, async (session) => {
    const res = await db.collection<DeliveryDoc>(COLLECTIONS.deliveries).updateOne(
      { _id: deliveryId, state: 'PENDING' }, { $set: { state: 'DELIVERED', updatedAt: new Date() } }, { session },
    );
    return res.modifiedCount === 1;
  });
  return value;
}

/**
 * Read model: durable projections for a conversation, ordered, after a cursor.
 * When `resourceId` is given the read is fail-closed scoped to that owner (§5.2) —
 * a foreign resource simply sees an empty list, never another owner's messages.
 */
export async function getConversationProjections(
  db: Db, conversationId: string, afterSequence = 0, resourceId?: string,
): Promise<ProjectionDoc[]> {
  const filter: Record<string, unknown> = { conversationId, sequence: { $gt: afterSequence } };
  if (resourceId !== undefined) filter.resourceId = resourceId;
  return db.collection<ProjectionDoc>(COLLECTIONS.projections)
    .find(filter).sort({ sequence: 1 }).toArray();
}
