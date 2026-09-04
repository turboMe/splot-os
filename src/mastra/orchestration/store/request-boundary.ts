/**
 * Control-request boundary: `answer_job_request` + expiry (plan §8.8, §8.9).
 *
 * A `blocked` attempt (A boundary) opens an OPEN control request and parks the job
 * in AWAITING_*. `answerJobRequest` closes it, records the answer as an
 * instruction, re-opens the task and wakes the lane so a fresh attempt runs with
 * the answer. `expireStaleRequests` (run by the reconciler) fails an unanswered
 * request past its deadline. All owner-scoped and idempotent; store-time (`$$NOW`)
 * gates answer-vs-expiry inside the write (GAP-CLOCK-01).
 */
import type { Db, MongoClient, Filter } from 'mongodb';
import { newOutboxId } from '../contracts/index.js';
import { runTxn, canonicalHash, isDuplicateKeyError } from './txn.js';
import { COLLECTIONS, type CommandDoc, type JobDoc, type TaskDoc, type JobEventDoc, type OutboxDoc, type ControlRequestDoc } from './collections.js';
import { CommandConflictError } from './command-boundary.js';
import { JobNotFoundError } from './control-boundary.js';

export class RequestNotOpenError extends Error {
  constructor(readonly requestId: string) {
    super(`control request ${requestId} is not open (already answered, expired, or unknown)`);
    this.name = 'RequestNotOpenError';
  }
}

export interface AnswerRequestInput {
  resourceId: string;
  commandId: string;
  jobId: string;
  requestId: string;
  answer: string;
}
export interface AnswerRequestResult { jobId: string; requestId: string; applied: boolean; deduped: boolean }

export async function answerJobRequest(client: MongoClient, db: Db, input: AnswerRequestInput): Promise<AnswerRequestResult> {
  const key = `${input.resourceId}:${input.commandId}`;
  const payloadHash = canonicalHash({ type: 'answer_job_request', jobId: input.jobId, requestId: input.requestId, answer: input.answer });
  const commands = db.collection<CommandDoc>(COLLECTIONS.commands);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const requests = db.collection<ControlRequestDoc>(COLLECTIONS.requests);

  const existing = await commands.findOne({ _id: key });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new CommandConflictError(input.resourceId, input.commandId);
    return { jobId: input.jobId, requestId: input.requestId, applied: false, deduped: true };
  }

  try {
    const { value } = await runTxn(client, async (session) => {
      const job = await jobs.findOne({ _id: input.jobId, resourceId: input.resourceId }, { session });
      if (!job) throw new JobNotFoundError(input.jobId);
      if (job.terminalOutcome !== null || job.controlState === 'STOP_REQUESTED') {
        throw new RequestNotOpenError(input.requestId);
      }
      await commands.insertOne({
        _id: key, resourceId: input.resourceId, conversationId: job.conversationId, commandId: input.commandId,
        type: 'answer_job_request', payloadHash, jobId: input.jobId, state: 'APPLIED', createdAt: new Date(),
      }, { session });

      // Close the request only if still OPEN and not past its deadline (store-time).
      const now = new Date();
      const closed = await requests.findOneAndUpdate(
        { _id: input.requestId, jobId: input.jobId, state: 'OPEN', $expr: { $gt: ['$expiresAt', '$$NOW'] } } as unknown as Filter<ControlRequestDoc>,
        { $set: { state: 'ANSWERED', answer: input.answer } },
        { session, returnDocument: 'after' },
      );
      if (!closed) throw new RequestNotOpenError(input.requestId);

      // Re-open the task and clear the wait; record the answer as an instruction.
      // A LANE-originated question (§4.2) was asked while planning, before any
      // task existed, so there is nothing to re-open — answering it simply
      // returns the job to READY and the lane plans again with the answer in
      // hand. Requiring a task here is what previously made such a question
      // unanswerable.
      const taskCas = closed.taskId === null
        ? { modifiedCount: 1 }
        : await db.collection<TaskDoc>(COLLECTIONS.tasks).updateOne(
          {
            _id: closed.taskId,
            jobId: job._id,
            phase: { $in: ['WAITING_INPUT', 'WAITING_DEPENDENCY'] },
            controlState: 'NONE',
          },
          { $set: { phase: 'RETRY_PENDING', retryNotBefore: null, updatedAt: now } },
          { session },
        );
      const jobCas = await jobs.updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          terminalOutcome: null,
          controlState: { $ne: 'STOP_REQUESTED' },
        },
        { $push: { instructions: `User answer: ${input.answer}` }, $set: { phase: 'READY', updatedAt: now }, $inc: { stateVersion: 1 } }, { session });
      if (taskCas.modifiedCount !== 1 || jobCas.modifiedCount !== 1) {
        throw new RequestNotOpenError(input.requestId);
      }

      const seq = (await db.collection<JobEventDoc>(COLLECTIONS.events).find({ jobId: job._id }, { session }).sort({ sequence: -1 }).limit(1).next())?.sequence ?? -1;
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${seq + 1}`, jobId: job._id, sequence: seq + 1, type: 'JobAnswered', payload: { requestId: input.requestId }, createdAt: now,
      }, { session });
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(),
        aggregate: job._id,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: {
          jobId: job._id,
          reason: 'answer',
          activationDispatchGeneration: job.activationDispatchGeneration,
        },
        createdAt: now,
      }, { session });

      return { jobId: job._id, requestId: input.requestId, applied: true, deduped: false } as AnswerRequestResult;
    });
    return value;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const winner = await commands.findOne({ _id: key });
      if (winner && winner.payloadHash === payloadHash) return { jobId: input.jobId, requestId: input.requestId, applied: false, deduped: true };
      throw new CommandConflictError(input.resourceId, input.commandId);
    }
    throw err;
  }
}

/**
 * Expire OPEN requests past their deadline (§8.9): mark EXPIRED, fail the waiting
 * task (input/approval timeout), and wake the lane to terminalize. Never grants
 * an implicit approval. Returns the number expired.
 */
export async function expireStaleRequests(client: MongoClient, db: Db): Promise<number> {
  const requests = db.collection<ControlRequestDoc>(COLLECTIONS.requests);
  let expired = 0;
  const skippedRequestIds = new Set<string>();
  for (;;) {
    const { value } = await runTxn(client, async (session) => {
      const req = await requests.findOne(
        {
          state: 'OPEN',
          ...(skippedRequestIds.size > 0
            ? { _id: { $nin: [...skippedRequestIds] } }
            : {}),
          $expr: { $lte: ['$expiresAt', '$$NOW'] },
        } as unknown as Filter<ControlRequestDoc>,
        { session, sort: { expiresAt: 1 } },
      );
      if (!req) return { kind: 'done' } as const;
      const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
        {
          _id: req.jobId,
          terminalOutcome: null,
          controlState: { $ne: 'STOP_REQUESTED' },
        },
        { session },
      );
      const task = req.taskId === null
        ? null
        : await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne(
          {
            _id: req.taskId,
            jobId: req.jobId,
            phase: { $in: ['WAITING_INPUT', 'WAITING_DEPENDENCY'] },
            controlState: 'NONE',
          },
          { session },
        );
      // Cancellation owns closure policy for this request. Expiry must leave a
      // STOP_REQUESTED aggregate untouched and continue scanning other jobs.
      //
      // A LANE-originated question has no task by design, so "no task" may not
      // mean "skip" for it — that would leave the question OPEN forever and the
      // job blocked on an answer that can never expire.
      if (!job || (req.taskId !== null && !task)) {
        return { kind: 'skipped', requestId: req._id } as const;
      }

      const closed = await requests.findOneAndUpdate(
        {
          _id: req._id,
          jobId: req.jobId,
          state: 'OPEN',
          $expr: { $lte: ['$expiresAt', '$$NOW'] },
        } as unknown as Filter<ControlRequestDoc>,
        { $set: { state: 'EXPIRED' } },
        { session, returnDocument: 'after' },
      );
      if (!closed) {
        return { kind: 'skipped', requestId: req._id } as const;
      }
      const now = new Date();
      const taskCas = task === null
        ? { modifiedCount: 1 }
        : await db.collection<TaskDoc>(COLLECTIONS.tasks).updateOne(
          {
            _id: task._id,
            jobId: req.jobId,
            phase: task.phase,
            controlState: 'NONE',
          },
          { $set: { phase: 'TIMED_OUT', updatedAt: now } },
          { session },
        );
      const jobCas = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          terminalOutcome: null,
          controlState: { $ne: 'STOP_REQUESTED' },
        },
        { $set: { updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (taskCas.modifiedCount !== 1 || jobCas.modifiedCount !== 1) {
        throw new RequestNotOpenError(req._id);
      }
      await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
        _id: newOutboxId(),
        aggregate: req.jobId,
        type: 'LaneWakeRequested',
        state: 'PENDING',
        payload: {
          jobId: req.jobId,
          reason: 'request_expired',
          activationDispatchGeneration: job.activationDispatchGeneration,
        },
        createdAt: now,
      }, { session });
      return { kind: 'expired' } as const;
    });
    if (value.kind === 'done') break;
    if (value.kind === 'skipped') {
      skippedRequestIds.add(value.requestId);
      continue;
    }
    expired++;
  }
  return expired;
}

/**
 * Open a LANE-originated question (F5B increment 4, plan §4.2: the Lane
 * Orchestrator may "formulate a question for the user").
 *
 * Unlike the `blocked` producer path in the A boundary, this happens while
 * PLANNING — before any task or attempt exists — so the request is bound to the
 * job alone (`taskId: null`). Answering it returns the job to READY and the lane
 * plans again with the answer recorded as an instruction.
 *
 * Idempotent by construction: at most one OPEN request per job. A lane that asks
 * twice (a retried activation, a duplicated wake) reuses the first question
 * rather than stacking questions the user would have to answer one by one.
 */
export async function openLaneUserRequest(
  client: MongoClient,
  db: Db,
  input: { jobId: string; question: string; ttlMs?: number },
): Promise<{ requestId: string; opened: boolean } | null> {
  const requests = db.collection<ControlRequestDoc>(COLLECTIONS.requests);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  const { value } = await runTxn(client, async (session) => {
    const job = await jobs.findOne(
      { _id: input.jobId, terminalOutcome: null, controlState: 'NONE' },
      { session },
    );
    if (!job) return null;

    const existing = await requests.findOne({ jobId: input.jobId, state: 'OPEN' }, { session });
    if (existing) return { requestId: existing._id, opened: false };

    const now = new Date();
    const requestId = `req_${globalThis.crypto.randomUUID()}`;
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 3_600_000));
    await requests.insertOne({
      _id: requestId,
      jobId: input.jobId,
      taskId: null,
      attemptId: null,
      kind: 'user',
      action: input.question,
      state: 'OPEN',
      expiresAt,
      answer: null,
      createdAt: now,
    }, { session });

    const jobCas = await jobs.updateOne(
      {
        _id: input.jobId,
        stateVersion: job.stateVersion,
        terminalOutcome: null,
        controlState: 'NONE',
      },
      { $set: { phase: 'AWAITING_USER', updatedAt: now }, $inc: { stateVersion: 1 } },
      { session },
    );
    if (jobCas.modifiedCount !== 1) throw new RequestNotOpenError(requestId);

    // Projectable question, not a lane wake — the job is now waiting on a human,
    // so waking the lane would only spin it.
    const seq = (await db.collection<JobEventDoc>(COLLECTIONS.events)
      .find({ jobId: input.jobId }, { session })
      .sort({ sequence: -1 }).limit(1).next())?.sequence ?? -1;
    await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
      _id: `${input.jobId}:${seq + 1}`,
      jobId: input.jobId,
      sequence: seq + 1,
      type: 'JobAwaitingInput',
      payload: {
        jobId: input.jobId,
        requestId,
        kind: 'user',
        action: input.question,
        expiresAt: expiresAt.toISOString(),
      },
      createdAt: now,
    }, { session });

    return { requestId, opened: true };
  });
  return value;
}

/** Open request for a job (for the read model), if any. */
export async function getOpenRequest(db: Db, jobId: string): Promise<{ requestId: string; kind: string; action: string; expiresAt: Date } | null> {
  const r = await db.collection<ControlRequestDoc>(COLLECTIONS.requests).findOne({ jobId, state: 'OPEN' });
  return r ? { requestId: r._id, kind: r.kind, action: r.action, expiresAt: r.expiresAt } : null;
}
