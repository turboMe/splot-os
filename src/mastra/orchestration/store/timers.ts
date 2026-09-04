/**
 * Durable timers (plan §10, §7.6) — skeleton.
 *
 * A timer is a durable WAKEUP, not authority: firing it emits a lane wake for the
 * job, and the lane re-checks the entity (task/attempt) before acting, so a stale
 * or superseded timer is harmless. `fireDueTimers` scans only due PENDING timers
 * via the `(state, fireAt)` index — no full-collection scan — using the `$$NOW`
 * store-time guard (GAP-CLOCK-01) inside the claim.
 */
import type { Db, MongoClient, Filter } from 'mongodb';
import { newOutboxId } from '../contracts/index.js';
import { runTxn } from './txn.js';
import { COLLECTIONS, type TimerDoc, type TimerKind, type JobDoc, type OutboxDoc } from './collections.js';
import { fireDueInboxResultRetryTimers } from './result-drain.js';
import { fireDueAttemptStopTimers } from './attempt-stop.js';

type GenericWakeTimerKind = Exclude<
  TimerKind,
  'inbox_result_retry' | 'attempt_stop_grace'
>;
const MAX_GENERIC_TIMERS_PER_TICK = 128;

export async function armTimer(
  db: Db,
  params: {
    kind: GenericWakeTimerKind;
    jobId: string;
    entityId: string;
    fireAt: Date;
  },
): Promise<string> {
  const timerId = `tmr_${globalThis.crypto.randomUUID()}`;
  await db.collection<TimerDoc>(COLLECTIONS.timers).insertOne({
    _id: timerId, kind: params.kind, jobId: params.jobId, entityId: params.entityId,
    generation: 0, sourceRedriveAttempt: null,
    fireAt: params.fireAt, state: 'PENDING', firedAt: null, wakeId: null,
    createdAt: new Date(),
  });
  return timerId;
}

/**
 * Fire one bounded tick of due timers. Attempt-stop grace has priority; generic
 * wakes and business inbox retries are separately bounded so a large retry
 * backlog cannot starve control safety work.
 */
export async function fireDueTimers(client: MongoClient, db: Db): Promise<number> {
  const timers = db.collection<TimerDoc>(COLLECTIONS.timers);
  let fired = await fireDueAttemptStopTimers(client, db);
  for (let scanned = 0; scanned < MAX_GENERIC_TIMERS_PER_TICK; scanned++) {
    const { value } = await runTxn(client, async (session) => {
      const due = await timers.findOneAndUpdate(
        {
          kind: { $nin: ['inbox_result_retry', 'attempt_stop_grace'] },
          state: 'PENDING',
          $expr: { $lte: ['$fireAt', '$$NOW'] },
        } as unknown as Filter<TimerDoc>,
        [{ $set: { state: 'FIRED', firedAt: '$$NOW' } }],
        { session, sort: { fireAt: 1, _id: 1 }, returnDocument: 'after' },
      );
      if (!due) return 0;

      const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: due.jobId }, { session });
      if (job && job.terminalOutcome === null) {
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
          _id: newOutboxId(), aggregate: due.jobId, type: 'LaneWakeRequested', state: 'PENDING',
          payload: {
            jobId: due.jobId,
            reason: `timer:${due.kind}`,
            activationDispatchGeneration: job.activationDispatchGeneration,
          },
          createdAt: due.firedAt ?? new Date(),
        }, { session });
      }
      return 1;
    });
    if (value === 0) break;
    fired += value;
  }
  // Typed inbox retries are bounded per tick and run after control/generic
  // safety timers.
  fired += await fireDueInboxResultRetryTimers(client, db);
  return fired;
}

/** Cancel any PENDING timers for an entity (e.g., on lease renewal / settlement). */
export async function cancelTimers(
  db: Db,
  entityId: string,
  kind?: GenericWakeTimerKind,
): Promise<number> {
  const filter: Record<string, unknown> = {
    entityId,
    state: 'PENDING',
    kind: { $nin: ['inbox_result_retry', 'attempt_stop_grace'] },
  };
  if (kind) filter.kind = kind;
  const res = await db.collection<TimerDoc>(COLLECTIONS.timers).updateMany(filter, { $set: { state: 'CANCELLED' } });
  return res.modifiedCount;
}

/** Exponential retry backoff with a cap (ms). */
export function retryBackoffMs(attemptCount: number, base = 500, cap = 30_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attemptCount - 1));
}
