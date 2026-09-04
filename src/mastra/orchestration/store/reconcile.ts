/**
 * Recovery reconciler (plan §15.4, §17.4, G4/G8) — skeleton.
 *
 * Closes the "lost wake" gap: if a process crashes after consuming a wake but
 * before finishing a lane sequence, a nonterminal job can be left with no live
 * attempt and no pending wake — stuck. `reWakeStuckJobs` detects exactly that
 * shape and emits a fresh lane wake so the orchestrator resumes it. `reconcile`
 * combines the lease reaper (worker loss) with the stuck-job re-wake, so a
 * periodic reconciler tick recovers every crash window. It never re-wakes a job
 * that still has a live attempt (the result will wake it) or a pending wake.
 */
import type { Db, MongoClient } from 'mongodb';
import type { AttemptLifecycle } from '../contracts/index.js';
import { newOutboxId } from '../contracts/index.js';
import { runTxn } from './txn.js';
import {
  COLLECTIONS,
  type JobDoc,
  type AttemptDoc,
  type OutboxDoc,
  type TimerDoc,
  type ControlRequestDoc,
  type LaneActivationDoc,
} from './collections.js';
import { expireQueuedAttempts, reapExpiredLeases } from './attempts.js';
import { reapExpiredActivations } from './activations.js';
import { fireDueTimers } from './timers.js';
import { expireStaleRequests } from './request-boundary.js';
import { drainConversation } from './conversation-writer.js';
import { findNextEligibleResultDrainInboxItem } from './result-drain.js';
import { reconcilePendingFlatTerminals } from './flat-terminal-barrier.js';
import {
  reapExpiredStopControlRecoveries,
} from './stop-control-recovery.js';

const LIVE_ATTEMPT: AttemptLifecycle[] = ['QUEUED', 'LEASED', 'RUNNING', 'STOP_REQUESTED'];
const REQUEST_WAIT_PHASES = new Set<JobDoc['phase']>([
  'AWAITING_USER',
  'AWAITING_APPROVAL',
  'AWAITING_EXTERNAL',
]);

/** Re-wake nonterminal jobs that have neither a pending wake nor a live attempt. */
export async function reWakeStuckJobs(client: MongoClient, db: Db): Promise<number> {
  const jobs = await db.collection<JobDoc>(COLLECTIONS.jobs).find({ terminalOutcome: null }).toArray();
  let rewoken = 0;
  for (const job of jobs) {
    const { value } = await runTxn(client, async (session) => {
      const current = await db.collection<JobDoc>(COLLECTIONS.jobs)
        .findOne({ _id: job._id, terminalOutcome: null }, { session });
      if (!current) return 0;
      // Waiting and manual pause intentionally release lane ownership. An expired
      // request no longer matches OPEN and may be re-woken if its expiry wake was
      // consumed before the lane committed.
      if (current.controlState !== 'NONE' || current.phase === 'PAUSED') return 0;
      if (REQUEST_WAIT_PHASES.has(current.phase)) {
        const openRequest = await db.collection<ControlRequestDoc>(COLLECTIONS.requests)
          .findOne({ jobId: current._id, state: 'OPEN' }, { session });
        if (openRequest) return 0;
      }
      const pendingWake = await db.collection<OutboxDoc>(COLLECTIONS.outbox)
        .findOne({
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          'payload.activationDispatchGeneration': current.activationDispatchGeneration,
        }, { session });
      if (pendingWake) return 0;
      const liveActivation = await db.collection<LaneActivationDoc>(COLLECTIONS.activations)
        .findOne(
          {
            jobId: job._id,
            activeSlot: true,
            lifecycle: { $in: ['PENDING', 'LEASED', 'RUNNING', 'FAILED'] },
          },
          { session, projection: { _id: 1 } },
        );
      if (liveActivation) return 0;
      const liveAttempt = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
        .findOne({ jobId: job._id, lifecycle: { $in: LIVE_ATTEMPT } }, { session });
      if (liveAttempt) return 0;
      const typedResultPhase =
        current.phase === 'AWAITING_RESULTS'
        || current.phase === 'RECONCILING';
      const resultDrainInbox = typedResultPhase
        ? await findNextEligibleResultDrainInboxItem(db, current, session)
        : null;
      if (resultDrainInbox) {
        const wakeId = [
          'obx_result_drain_reconcile',
          current._id,
          current.activationDispatchGeneration,
          current.stateVersion,
          current.resolvedInboxWatermark,
          current.inboxHighWatermark,
        ].join(':');
        const inserted = await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
          { _id: wakeId },
          {
            $setOnInsert: {
              _id: wakeId,
              aggregate: current._id,
              type: 'LaneWakeRequested',
              state: 'PENDING',
              payload: {
                jobId: current._id,
                reason: 'result_drain_reconcile',
                inboxItemId: resultDrainInbox._id,
                inboxSequence: resultDrainInbox.inboxSequence,
                activationDispatchGeneration: current.activationDispatchGeneration,
              },
              createdAt: new Date(),
            },
          },
          { session, upsert: true },
        );
        return inserted.upsertedCount;
      }
      // A typed pause/quarantine/retry gap is durable but not currently
      // actionable. Reconciliation must not turn it into a hot wake loop.
      if (typedResultPhase) return 0;
      // A PENDING timer (for example retry backoff) owns future demand. The
      // typed eligibility probe intentionally runs first so one delayed row
      // cannot hide a lost wake for a different, already-eligible row.
      const pendingTimer = await db.collection<TimerDoc>(COLLECTIONS.timers)
        .findOne({ jobId: job._id, state: 'PENDING' }, { session });
      if (pendingTimer) return 0;
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(), aggregate: job._id, type: 'LaneWakeRequested', state: 'PENDING',
        payload: {
          jobId: job._id,
          reason: 'reconcile',
          activationDispatchGeneration: current.activationDispatchGeneration,
        },
        createdAt: new Date(),
      }, { session });
      return 1;
    });
    rewoken += value;
  }
  return rewoken;
}

/**
 * One reconciler tick: fire due timers, reap lost leases, expire stale requests,
 * re-wake stuck jobs, then drain any un-projected conversation events. The last
 * step closes the C-boundary crash window: a job that terminalized or entered an
 * intentional wait but crashed before its event was projected is delivered on
 * the next tick (the projection is idempotent, so this is safe).
 */
export async function reconcile(
  client: MongoClient, db: Db, opts: { maxAttempts?: number; retryBackoffMs?: number } = {},
): Promise<{
  fired: number;
  expiredQueued: number;
  reaped: number;
  reapedActivations: number;
  reapedStopControls: number;
  rewoken: number;
  expiredRequests: number;
  terminalizedStops: number;
  projected: number;
}> {
  const fired = await fireDueTimers(client, db);
  const expiredQueued = await expireQueuedAttempts(client, db);
  const reaped = await reapExpiredLeases(client, db, opts);
  const reapedActivations = await reapExpiredActivations(client, db);
  const reapedStopControls =
    await reapExpiredStopControlRecoveries(client, db);
  const expiredRequests = await expireStaleRequests(client, db);
  // Consume settled pending stop decisions before generic wake recovery. A
  // terminal STOP_REQUESTED job must never be reintroduced into the business
  // lane, and the following C drain can project its deterministic event in this
  // same public tick.
  const terminalizedStops =
    await reconcilePendingFlatTerminals(client, db);
  const rewoken = await reWakeStuckJobs(client, db);
  const projected = await drainConversation(client, db);
  return {
    fired,
    expiredQueued,
    reaped,
    reapedActivations,
    reapedStopControls,
    rewoken,
    expiredRequests,
    terminalizedStops,
    projected,
  };
}
