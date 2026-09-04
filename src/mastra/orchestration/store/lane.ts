/**
 * Minimal autonomous-wake reducer (plan §9.2, `EVT-001`) — skeleton B boundary.
 *
 * A PENDING wake outbox drives a single atomic transaction that: claims the wake
 * (PENDING→PUBLISHED), loads the job, runs a reducer, and — if it decides a
 * transition — advances the job phase under a `stateVersion` CAS and appends the
 * next ordered event. All in one transaction, so a re-delivered wake cannot
 * double-apply (once PUBLISHED it is no longer selectable) and a concurrent
 * writer loses the CAS (snapshot isolation → TransientTransactionError → retry).
 *
 * This is the retired walking-skeleton reducer retained only by its historical
 * boundary test. Production callers use the typed lane orchestrator.
 */
import type { Db, MongoClient } from 'mongodb';
import type { JobPhase } from '../contracts/index.js';
import { runTxn } from './txn.js';
import { COLLECTIONS, type JobDoc, type JobEventDoc, type OutboxDoc } from './collections.js';

export interface ReducerDecision {
  nextPhase: JobPhase;
  eventType: string;
  eventPayload?: Record<string, unknown>;
}

/** A pure decision function over the current job. `null` = no transition. */
export type JobReducer = (job: JobDoc) => ReducerDecision | null;

/** Default skeleton reducer: an accepted job becomes ready to plan. */
export const readyReducer: JobReducer = (job) =>
  job.phase === 'ACCEPTED' ? { nextPhase: 'READY', eventType: 'JobReady' } : null;

export interface WakeOutcome {
  claimed: boolean;
  applied?: boolean;
  jobId?: string;
  phase?: JobPhase;
  retries?: number;
}

/**
 * Claim the oldest PENDING wake and reduce its job in one transaction.
 * Returns `{ claimed: false }` when no wake is pending (autonomous idle).
 */
export async function claimAndReduceNextWake(
  client: MongoClient,
  db: Db,
  reducer: JobReducer = readyReducer,
): Promise<WakeOutcome> {
  const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const events = db.collection<JobEventDoc>(COLLECTIONS.events);

  const { value, retries } = await runTxn(client, async (session) => {
    const wake = await outbox.findOneAndUpdate(
      { type: 'LaneWakeRequested', state: 'PENDING' },
      { $set: { state: 'PUBLISHED' } },
      { session, sort: { createdAt: 1 }, returnDocument: 'after' },
    );
    if (!wake) return { claimed: false } as WakeOutcome;

    const job = await jobs.findOne({ _id: wake.aggregate }, { session });
    if (!job) return { claimed: true, applied: false, jobId: wake.aggregate } as WakeOutcome;

    const rawPayload = wake.payload as unknown;
    const wakeGeneration =
      rawPayload !== null && typeof rawPayload === 'object'
        ? (rawPayload as Record<string, unknown>).activationDispatchGeneration
        : undefined;
    if (
      typeof wakeGeneration !== 'number'
      || !Number.isInteger(wakeGeneration)
      || wakeGeneration !== job.activationDispatchGeneration
      || job.terminalOutcome !== null
      || job.controlState !== 'NONE'
    ) {
      return { claimed: true, applied: false, jobId: job._id, phase: job.phase } as WakeOutcome;
    }

    const decision = reducer(job);
    if (!decision) return { claimed: true, applied: false, jobId: job._id, phase: job.phase } as WakeOutcome;

    // Next event sequence = current max + 1 (event 0 is JobAccepted).
    const last = await events.find({ jobId: job._id }, { session }).sort({ sequence: -1 }).limit(1).next();
    const sequence = (last?.sequence ?? -1) + 1;

    const cas = await jobs.updateOne(
      {
        _id: job._id,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: 'NONE',
        activationDispatchGeneration: wakeGeneration,
      },
      { $set: { phase: decision.nextPhase, updatedAt: new Date() }, $inc: { stateVersion: 1 } },
      { session },
    );
    if (cas.modifiedCount !== 1) throw new Error('stateVersion CAS lost — concurrent writer');

    await events.insertOne({
      _id: `${job._id}:${sequence}`,
      jobId: job._id,
      sequence,
      type: decision.eventType,
      payload: decision.eventPayload ?? {},
      createdAt: new Date(),
    }, { session });

    return { claimed: true, applied: true, jobId: job._id, phase: decision.nextPhase } as WakeOutcome;
  });

  return { ...value, retries };
}
