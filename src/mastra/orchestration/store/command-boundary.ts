/**
 * The command boundary: durable `start_job` accept (plan §8.1, §15.5).
 *
 * Implements invariant #1 "Durable before ACK": the `accepted` response may only
 * exist after the command, the minimal job, its first event and the wake outbox
 * are committed atomically. One transaction, one linearization point.
 *
 * Idempotency (`ORC-TXN-COMMAND-01`): the same `(resourceId, commandId)` with the
 * same payload hash returns the previously created `jobId` without re-applying;
 * the same id with a different hash is a conflict. Concurrent identical commands
 * resolve to exactly one job via the unique index.
 */
import type { Db, MongoClient } from 'mongodb';
import { newJobId, newOutboxId, type JobId } from '../contracts/index.js';
import { runTxn, canonicalHash, isDuplicateKeyError } from './txn.js';
import {
  COLLECTIONS,
  CONTROL_BUDGET_POLICY_V1,
  type CommandDoc,
  type JobDoc,
  type JobEventDoc,
  type OutboxDoc,
} from './collections.js';

export class CommandConflictError extends Error {
  constructor(readonly resourceId: string, readonly commandId: string) {
    super(`command ${commandId} for resource ${resourceId} already exists with a different payload`);
    this.name = 'CommandConflictError';
  }
}

export interface StartJobInput {
  resourceId: string;
  conversationId: string;
  commandId: string;
  /** Operation payload — hashed canonically for idempotency. */
  payload: Record<string, unknown>;
  /** Short human goal for the job. */
  goal: string;
  /**
   * Pin the job to one specialist instead of letting the lane choose (§F6
   * cutover — see `JobDoc.requestedCapability`).
   *
   * Producer-supplied, never model-supplied: this comes from a caller that
   * already named its target (legacy `delegate_task`), and the caller is
   * responsible for having resolved the name against the capability registry
   * BEFORE accepting. The substrate validates the shape only; it cannot know
   * whether `chefAgent` exists in this process.
   */
  capability?: string;
}

/** Same shape rule as `PlanningProposalV1.capability` — one syntax, one owner. */
const CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface StartJobResult {
  jobId: JobId;
  /** True when this call returned an already-accepted job (replay). */
  deduped: boolean;
  /** Retry count of the accept transaction (contention signal). */
  retries: number;
}

function commandKey(resourceId: string, commandId: string): string {
  return `${resourceId}:${commandId}`;
}

/**
 * Accept a long/mutating operation as a durable job. Returns the `jobId` after
 * the accept is committed. Safe to call repeatedly with the same `commandId`.
 */
export async function acceptStartCommand(
  client: MongoClient,
  db: Db,
  input: StartJobInput,
): Promise<StartJobResult> {
  // Reject a malformed pin HERE rather than at plan time: a bad name frozen into
  // an accepted job would fail every attempt forever, and the accept is the last
  // moment the caller is still holding the error.
  if (input.capability !== undefined && !CAPABILITY_NAME.test(input.capability)) {
    throw new Error(`invalid capability pin: ${input.capability}`);
  }
  const key = commandKey(input.resourceId, input.commandId);
  const payloadHash = canonicalHash(input.payload);
  const commands = db.collection<CommandDoc>(COLLECTIONS.commands);

  // Fast path: an already-recorded command replays without a transaction.
  const existing = await commands.findOne({ _id: key });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new CommandConflictError(input.resourceId, input.commandId);
    return { jobId: existing.jobId as JobId, deduped: true, retries: 0 };
  }

  const jobId = newJobId();
  const now = new Date();

  try {
    const { retries } = await runTxn(client, async (session) => {
      await commands.insertOne({
        _id: key,
        resourceId: input.resourceId,
        conversationId: input.conversationId,
        commandId: input.commandId,
        type: 'start_job',
        payloadHash,
        jobId,
        state: 'APPLIED',
        createdAt: now,
      }, { session });

      await db.collection<JobDoc>(COLLECTIONS.jobs).insertOne({
        _id: jobId,
        resourceId: input.resourceId,
        conversationId: input.conversationId,
        phase: 'ACCEPTED',
        controlState: 'NONE',
        terminalOutcome: null,
        stateVersion: 0,
        planVersion: 1,
        pauseGeneration: 0,
        activationDispatchGeneration: 0,
        jobStopGeneration: 0,
        pendingTerminalOutcome: null,
        primaryJobStopCause: null,
        secondaryJobStopCauses: [],
        stopGraceDueAt: null,
        terminalBarrierMode: null,
        terminalBarrierBlocker: null,
        terminalBarrierNextCheckAt: null,
        terminalBarrierProbeAttempt: 0,
        controlVersion: 0,
        activationFence: 0,
        activeActivationId: null,
        activationRecoveryAttempt: 0,
        activationRecoveryRootId: null,
        activationRecoveryRootKind: null,
        controlBudgetPolicyVersion: CONTROL_BUDGET_POLICY_V1.version,
        jobControlRecoveryReserveMs:
          CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs,
        jobControlRecoveryReservedMs: 0,
        jobControlRecoveryConsumedMs: 0,
        stopControlRecoveryAttempt: 0,
        stopControlRecoveryState: 'IDLE',
        inboxHighWatermark: 0,
        appliedInboxWatermark: 0,
        resolvedInboxWatermark: 0,
        inboxSchemaVersion: 3,
        instructions: [],
        parentJobId: null,
        jobRelationMode: null,
        goal: input.goal,
        // Omitted, not null, when absent: an unpinned job's document stays
        // byte-identical to what this boundary wrote before pins existed.
        ...(input.capability !== undefined ? { requestedCapability: input.capability } : {}),
        createdAt: now,
        updatedAt: now,
      }, { session });

      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${jobId}:0`,
        jobId,
        sequence: 0,
        type: 'JobAccepted',
        payload: {
          commandId: input.commandId,
          goal: input.goal,
          ...(input.capability !== undefined ? { requestedCapability: input.capability } : {}),
        },
        createdAt: now,
      }, { session });

      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(),
        aggregate: jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: { jobId, reason: 'accepted', activationDispatchGeneration: 0 },
        createdAt: now,
      }, { session });
    });
    return { jobId, deduped: false, retries };
  } catch (err) {
    // Lost a concurrent race on the unique command index → return the winner.
    if (isDuplicateKeyError(err)) {
      const winner = await commands.findOne({ _id: key });
      if (winner) {
        if (winner.payloadHash !== payloadHash) throw new CommandConflictError(input.resourceId, input.commandId);
        return { jobId: winner.jobId as JobId, deduped: true, retries: 0 };
      }
    }
    throw err;
  }
}
