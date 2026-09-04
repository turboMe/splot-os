/**
 * Read-side projections for the durable substrate (plan §8.2).
 *
 * `get_job_status` / `list_jobs` are read-only: they return a projection and the
 * `stateVersion`, never mutate, never claim a lease, and never wake a job.
 * Ownership is enforced by the caller binding `resourceId` from auth — a query
 * must scope by the authenticated resource (a `threadId` never authorizes, §5.3).
 */
import type { Db } from 'mongodb';
import type { JobPhase, JobControlState, JobTerminalOutcome } from '../contracts/index.js';
import { COLLECTIONS, type JobDoc, type JobEventDoc, type ControlRequestDoc, type ResultDoc } from './collections.js';

export interface JobStatus {
  jobId: string;
  resourceId: string;
  conversationId: string;
  phase: JobPhase;
  controlState: JobControlState;
  terminalOutcome: JobTerminalOutcome | null;
  /** Durable requested outcome while a stop barrier is still open. */
  pendingTerminalOutcome: JobTerminalOutcome | null;
  /** First stop cause; secondary diagnostics remain available on the job doc. */
  primaryJobStopCause: JobDoc['primaryJobStopCause'];
  stopGraceDueAt: Date | null;
  stateVersion: number;
  planVersion: number;
  parentJobId: string | null;
  goal: string;
  lastEvent: { sequence: number; type: string } | null;
  openRequest: { requestId: string; kind: string; action: string; expiresAt: Date } | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A committed producer payload as READABLE TEXT.
 *
 * One implementation because there were three, and two of them were wrong in
 * exactly the same way. A `bounded_text` producer commits `{ text }`, so
 * `JSON.stringify(data)` hands back `{"text":"```json\n{\n \"status\"…` — the
 * answer wrapped in an envelope, with every newline and quote escaped. That is
 * what the next step of a plan was reading as its predecessor's output, and what
 * `orchestration_get_job` was handing the Meta Front to show the user.
 * `final-decision.ts` had already fixed its own copy (the escaping hid the
 * NEEDS_INPUT marker from the judge); the other two never learned.
 *
 * Lives here, on the read side, because "how a stored result reads" is a
 * projection concern and every consumer already imports this module.
 */
export function renderProducerText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  if (typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
    return (data as { text: string }).text;
  }
  try { return JSON.stringify(data); } catch { return ''; }
}

function toStatus(job: JobDoc, lastEvent: JobEventDoc | null, openRequest: JobStatus['openRequest'] = null): JobStatus {
  return {
    jobId: job._id,
    resourceId: job.resourceId,
    conversationId: job.conversationId,
    phase: job.phase,
    controlState: job.controlState,
    terminalOutcome: job.terminalOutcome,
    pendingTerminalOutcome: job.pendingTerminalOutcome ?? null,
    primaryJobStopCause: job.primaryJobStopCause ?? null,
    stopGraceDueAt: job.stopGraceDueAt ?? null,
    stateVersion: job.stateVersion,
    planVersion: job.planVersion,
    parentJobId: job.parentJobId,
    goal: job.goal,
    lastEvent: lastEvent ? { sequence: lastEvent.sequence, type: lastEvent.type } : null,
    openRequest,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** Read one job's status, scoped to its owner. Returns null if not owned/found. */
export async function getJobStatus(db: Db, resourceId: string, jobId: string): Promise<JobStatus | null> {
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: jobId, resourceId });
  if (!job) return null;
  const lastEvent = await db.collection<JobEventDoc>(COLLECTIONS.events)
    .find({ jobId }).sort({ sequence: -1 }).limit(1).next();
  const req = await db.collection<ControlRequestDoc>(COLLECTIONS.requests).findOne({ jobId, state: 'OPEN' });
  const openRequest = req ? { requestId: req._id, kind: req.kind, action: req.action, expiresAt: req.expiresAt } : null;
  return toStatus(job, lastEvent, openRequest);
}

export interface JobResult {
  jobId: string;
  taskId: string;
  attemptId: string;
  /** Producer envelope status: ok / partial / failed / timed_out / cancelled … */
  status: string;
  /** The deliverable itself, when the producer carried one. */
  data: unknown;
  summary: string | null;
  error: { code?: string; message?: string } | null;
  committedAt: Date;
}

/**
 * Read a job's committed result, scoped to its owner.
 *
 * `getJobStatus` deliberately returns status/outcome only — the terminal
 * conversation projection carries no payload either (see ORC-TXN-C-01's "not the
 * agent's result payload" note). Without this, a caller can observe COMPLETED and
 * still have no way to read what the job produced, which makes the whole surface
 * unusable as an actual work channel.
 *
 * Owner scoping is enforced against the RESULT row's own `resourceId`, not via
 * the job — a `threadId`/`jobId` never authorizes on its own (§5.3), so an
 * unowned or unknown job is indistinguishable from a missing one (null).
 *
 * Returns the most recently committed result: with retries a job can hold
 * several, and the newest committed one is the live answer.
 */
export async function getJobResult(db: Db, resourceId: string, jobId: string): Promise<JobResult | null> {
  const doc = await db.collection<ResultDoc>(COLLECTIONS.results)
    .find({ jobId, resourceId }).sort({ ACommittedAt: -1 }).limit(1).next();
  if (!doc) return null;
  const producer = (doc.producer ?? {}) as Record<string, unknown>;
  const rawError = producer.error as Record<string, unknown> | null | undefined;
  return {
    jobId: doc.jobId,
    taskId: doc.taskId,
    attemptId: doc.attemptId,
    status: typeof producer.status === 'string' ? producer.status : doc.status,
    data: producer.data ?? null,
    summary: typeof producer.summary === 'string' && producer.summary.length > 0 ? producer.summary : null,
    error: rawError && typeof rawError === 'object'
      ? {
          code: typeof rawError.code === 'string' ? rawError.code : undefined,
          message: typeof rawError.message === 'string' ? rawError.message : undefined,
        }
      : null,
    committedAt: doc.ACommittedAt,
  };
}

/** List a resource's jobs, newest first. Read-only, owner-scoped, bounded. */
export async function listJobs(
  db: Db,
  resourceId: string,
  opts: { conversationId?: string; limit?: number } = {},
): Promise<JobStatus[]> {
  const filter: Record<string, unknown> = { resourceId };
  if (opts.conversationId) filter.conversationId = opts.conversationId;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200); // server clamps (§17.2)
  const docs = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();
  return docs.map((j) => toStatus(j, null));
}
