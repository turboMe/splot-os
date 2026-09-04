/**
 * Deterministic domain-worker loop (plan §4.3) — skeleton.
 *
 * A worker claims a QUEUED attempt into LEASED, heartbeats context loading,
 * atomically starts RUNNING, freezes the returned producer payload before the
 * business cutoff, and submits that exact generation through A. The fixture
 * stands in for a real agent run; per GAP-WORKER-ISO-01 a real cooperative model
 * call may run in-process, while non-cooperative/CPU work is offloaded to a
 * killable process — that isolation is layered on later without changing this
 * claim/submit contract.
 */
import type { Db, MongoClient } from 'mongodb';
import { COLLECTIONS, type AttemptDoc, type JobDoc, type ResultDoc, type TaskDoc } from './collections.js';
import { renderProducerText } from './queries.js';
import {
  claimAttempt,
  markAttemptPayloadReady,
  recordAttemptProgressAndExtend,
  renewLease,
  startAttemptOperation,
  submitAttemptResult,
} from './attempts.js';
import type {
  AttemptProgressDecision,
  AttemptProgressMilestone,
  ProgressiveAttemptPolicy,
} from '../contracts/execution-budget.js';

/** One finished predecessor, as the next step sees it. */
export interface UpstreamStepResult {
  taskId: string;
  /** Which specialist produced it — a step should know whose output this is. */
  capability?: string | null;
  /** What that step was asked to do. */
  goal?: string | null;
  status: string;
  summary?: string | null;
  /** Ids of anything it stored; the way to read the full deliverable. */
  artifacts: string[];
  /** Bounded excerpt of the payload. Never the whole thing — see `upstream`. */
  preview?: string;
}

/** Cap on the excerpt handed forward. Long enough for an answer, short enough
 * that a step's own budget is not spent re-reading its predecessor. */
const UPSTREAM_PREVIEW_CHARS = 2_000;

export interface WorkerContext {
  attemptId: string;
  taskId: string;
  jobId: string;
  attemptNumber: number;
  /** New business/model/tool work must stop here. */
  businessOperationCutoffAt: Date;
  /** A may only validate/commit the frozen payload until here. */
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
  /** Immutable absolute ceiling; equal to hardDeadlineAt for fixed attempts. */
  absoluteBusinessOperationCutoffAt?: Date;
  absoluteWorkDeadlineAt?: Date;
  absoluteHardDeadlineAt?: Date;
  /** Frozen policy; missing/null keeps the historical fixed window. */
  progressiveAttempt?: ProgressiveAttemptPolicy | null;
  /** Aborts cooperative model/tool work immediately after lease authority is lost. */
  signal?: AbortSignal;
  /** Store-authoritative earned-time reporter, present only for progressive attempts. */
  reportProgress?: (
    milestone: AttemptProgressMilestone,
  ) => Promise<AttemptProgressDecision>;
  /** Current task focus. Kept stable for existing WorkerFixture consumers. */
  goal: string;
  /** Full immutable job brief, rendered ahead of the current task focus. */
  jobGoal?: string;
  /** Explicit alias for the current task focus used by registry prompt rendering. */
  taskGoal?: string | null;
  instructions: string[];
  /**
   * What the previous step of an ordered plan produced (F6B).
   *
   * A sequence is only useful if step 2 can see step 1's output, and until this
   * existed a worker received the job goal, the task goal and instructions —
   * nothing else. `resolveParentTask` reads child PHASES, never their results, so
   * there was no path by which one step's work could reach the next.
   *
   * REFERENCES PLUS A BOUNDED EXCERPT, not the payload. A finished step may have
   * produced a 30 KB document; pasting it into the next step's prompt would spend
   * the budget the step needs for its own work, and the full thing is already
   * addressable — by artifact id, or by reading the result row. The excerpt
   * exists so a short answer (a decision, a list, a URL) needs no second lookup.
   *
   * Only the DIRECT predecessor: a linear pipeline hands work forward one link at
   * a time (the illustrator wants the article, not the research behind it), and
   * an unbounded transitive chain would grow the prompt with every step.
   */
  upstream?: UpstreamStepResult[];
  /**
   * True when this task is one step of an ordered plan, so OTHER steps cover the
   * rest of the job goal.
   *
   * The prompt renderer needs exactly this and used to infer it from "the task
   * goal differs from the job goal", which is a different question with the same
   * answer most of the time. When the lane returned a single `dispatch` carrying
   * a sharpened `taskGoal`, a one-task job was told "this is the only thing you
   * deliver … later steps cover the rest" — with no later steps, and with the
   * user's own wording demoted to background. Measured on a live chefAgent job.
   */
  planStep?: boolean;
  /**
   * The specialist frozen into this task's plan, if the lane named one. The
   * substrate does not interpret it; it only guarantees the worker sees the same
   * value every attempt, restart and retry.
   */
  capability?: string | null;
}
/** Returns a producer envelope (or any value — invalid ones become FAILED). May be async (real model call). */
export type WorkerFixture = (ctx: WorkerContext) => unknown | Promise<unknown>;

/** Default fixture: a valid, empty success. */
export const okWorker: WorkerFixture = () => ({ status: 'ok', data: {} });

export interface WorkerRunOptions {
  workerInstanceId?: string;
  leaseTtlMs?: number;
  heartbeatEveryMs?: number;
}

/**
 * Select only attempts that are claimable under the current job/task authority.
 * The joins keep stale paused/replanned/terminal QUEUED rows from becoming a
 * poison prefix that starves later work.
 */
export async function findClaimableQueuedAttempt(db: Db): Promise<AttemptDoc | null> {
  return db.collection<AttemptDoc>(COLLECTIONS.attempts).aggregate<AttemptDoc>([
    {
      $match: {
        lifecycle: 'QUEUED',
        $expr: { $gt: ['$businessOperationCutoffAt', '$$NOW'] },
      },
    },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $lookup: {
        from: COLLECTIONS.jobs,
        let: {
          jobId: '$jobId',
          planVersion: '$planVersion',
          pauseGeneration: '$pauseGenerationAtDispatch',
        },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ['$_id', '$$jobId'] },
                { $eq: ['$terminalOutcome', null] },
                { $eq: ['$controlState', 'NONE'] },
                { $eq: ['$planVersion', '$$planVersion'] },
                { $eq: ['$pauseGeneration', '$$pauseGeneration'] },
              ],
            },
          },
        }],
        as: 'claimableJob',
      },
    },
    { $match: { 'claimableJob.0': { $exists: true } } },
    {
      $lookup: {
        from: COLLECTIONS.tasks,
        let: {
          taskId: '$taskId',
          jobId: '$jobId',
          planVersion: '$planVersion',
        },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ['$_id', '$$taskId'] },
                { $eq: ['$jobId', '$$jobId'] },
                { $eq: ['$phase', 'DISPATCHED'] },
                { $eq: ['$controlState', 'NONE'] },
                { $eq: ['$planVersion', '$$planVersion'] },
                { $eq: [{ $ifNull: ['$activeAttemptId', null] }, null] },
              ],
            },
          },
        }],
        as: 'claimableTask',
      },
    },
    { $match: { 'claimableTask.0': { $exists: true } } },
    { $project: { claimableJob: 0, claimableTask: 0 } },
    { $limit: 1 },
  ]).next();
}

/** Claim and run at most one QUEUED attempt. Returns true if it did work. */
export async function runWorkerOnce(
  client: MongoClient, db: Db, fixture: WorkerFixture,
  opts: WorkerRunOptions = {},
): Promise<boolean> {
  const workerInstanceId = opts.workerInstanceId ?? 'worker-1';
  const leaseTtlMs = opts.leaseTtlMs ?? 30_000;
  const heartbeatEveryMs = opts.heartbeatEveryMs
    ?? Math.max(50, Math.min(10_000, Math.floor(leaseTtlMs / 3)));
  if (heartbeatEveryMs <= 0 || heartbeatEveryMs >= leaseTtlMs) {
    throw new Error('heartbeat interval must be positive and shorter than the lease TTL');
  }

  let claimed: {
    attempt: AttemptDoc;
    lease: NonNullable<Awaited<ReturnType<typeof claimAttempt>>>;
  } | null = null;
  for (;;) {
    const candidate = await findClaimableQueuedAttempt(db);
    if (!candidate) return false;
    const lease = await claimAttempt(client, db, {
      attemptId: candidate._id,
      workerInstanceId,
      leaseTtlMs,
    });
    if (lease) {
      claimed = { attempt: candidate, lease };
      break;
    }
  }
  const { attempt, lease } = claimed;

  let heartbeatLost = false;
  const workAbort = new AbortController();
  let heartbeatInFlight: Promise<void> | null = null;
  const renewHeartbeat = async (): Promise<boolean> => {
    if (heartbeatLost) return false;
    if (heartbeatInFlight) {
      await heartbeatInFlight;
      return !heartbeatLost;
    }
    const current = (async () => {
      try {
        const renewed = await renewLease(db, {
          attemptId: attempt._id,
          leaseOwner: workerInstanceId,
          attemptFence: lease.attemptFence,
          leaseTtlMs,
        });
        if (!renewed) {
          heartbeatLost = true;
          workAbort.abort(new Error('attempt_lease_lost'));
        }
      } catch {
        heartbeatLost = true;
        workAbort.abort(new Error('attempt_lease_lost'));
      }
    })();
    heartbeatInFlight = current;
    try {
      await current;
    } finally {
      if (heartbeatInFlight === current) heartbeatInFlight = null;
    }
    return !heartbeatLost;
  };
  const heartbeat = setInterval(() => {
    void renewHeartbeat();
  }, heartbeatEveryMs);

  try {
    // Context reads are not free: keep the LEASED admission alive while they
    // run, then make LEASED→RUNNING compete transactionally with pause/cancel.
    const [job, task] = await Promise.all([
      db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: attempt.jobId }),
      db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ _id: attempt.taskId }),
    ]);
    if (
      heartbeatLost
      || !await startAttemptOperation(client, db, {
        attemptId: attempt._id,
        leaseOwner: workerInstanceId,
        attemptFence: lease.attemptFence,
      })
    ) {
      return true;
    }

    const producer = await fixture({
      attemptId: attempt._id,
      taskId: attempt.taskId,
      jobId: attempt.jobId,
      attemptNumber: attempt.attemptNumber,
      businessOperationCutoffAt: attempt.businessOperationCutoffAt,
      workDeadlineAt: attempt.workDeadlineAt,
      hardDeadlineAt: attempt.hardDeadlineAt,
      absoluteBusinessOperationCutoffAt:
        attempt.absoluteBusinessOperationCutoffAt ?? attempt.businessOperationCutoffAt,
      absoluteWorkDeadlineAt: attempt.absoluteWorkDeadlineAt ?? attempt.workDeadlineAt,
      absoluteHardDeadlineAt: attempt.absoluteHardDeadlineAt ?? attempt.hardDeadlineAt,
      progressiveAttempt: attempt.progressiveAttempt ?? null,
      signal: workAbort.signal,
      ...(attempt.progressiveAttempt
        ? {
            reportProgress: (milestone: AttemptProgressMilestone) => (
              recordAttemptProgressAndExtend(client, db, {
                attemptId: attempt._id,
                leaseOwner: workerInstanceId,
                attemptFence: lease.attemptFence,
                leaseTtlMs,
                milestone,
              })
            ),
          }
        : {}),
      goal: task?.goal ?? job?.goal ?? '',
      jobGoal: job?.goal ?? '',
      taskGoal: task?.goal ?? null,
      instructions: job?.instructions ?? [],
      capability: task?.capability ?? null,
      planStep: task?.parentTaskId != null,
      ...(task?.awaitsTaskId
        ? { upstream: await readUpstreamResults(db, task.awaitsTaskId) }
        : {}),
    });
    if (heartbeatLost) return true;

    const ready = await markAttemptPayloadReady(client, db, {
      attemptId: attempt._id,
      leaseOwner: workerInstanceId,
      attemptFence: lease.attemptFence,
      producer,
    });
    // A late/changed/stale business payload must not enter ordinary A. Recovery
    // owns the still-running attempt and will fence/retry it when the lease expires.
    if (!ready.ready || heartbeatLost) return true;
    await submitAttemptResult(client, db, {
      attemptId: attempt._id,
      leaseOwner: workerInstanceId,
      attemptFence: lease.attemptFence,
      producer,
      ...(ready.required ? { businessPayloadReadyGeneration: ready.generation } : {}),
    });
    return true;
  } finally {
    // The lease covers fixture execution, marker creation, and A itself. Clearing
    // it before A creates a short-TTL gap where a valid frozen result is reaped.
    clearInterval(heartbeat);
    await heartbeatInFlight;
  }
}

/** Run all currently-QUEUED attempts to completion. */
/**
 * What the predecessor step produced, as a reference plus a bounded excerpt.
 *
 * Reads the most recently committed result for that task — a step may have been
 * retried, and the newest commit is the one that counts. Returns an empty list
 * rather than throwing when there is nothing: a step whose predecessor produced
 * no payload still has a job goal and a task goal to work from, and failing the
 * attempt over a missing excerpt would turn a thin result into a broken plan.
 */
export async function readUpstreamResults(
  db: Db,
  predecessorTaskId: string,
): Promise<UpstreamStepResult[]> {
  const [task, result] = await Promise.all([
    db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ _id: predecessorTaskId }),
    db.collection<ResultDoc>(COLLECTIONS.results)
      .find({ taskId: predecessorTaskId }).sort({ ACommittedAt: -1 }).limit(1).next(),
  ]);
  if (!task) return [];

  const producer = (result?.producer ?? {}) as Record<string, unknown>;
  const summary = typeof producer.summary === 'string' && producer.summary.length > 0
    ? producer.summary
    : null;
  // `artifactId`, NOT `id` — that is what `artifactRefSchema` has always called
  // it. This read looked for `id` and therefore discarded every reference it was
  // given; it stayed invisible because no producer filled the array until the
  // caller was taught to. Same mistake as `findArtifactIds` matching a tool id
  // the runtime never emits: a shape recalled from memory instead of the contract.
  const artifacts = Array.isArray(producer.artifacts)
    ? producer.artifacts
      .map((a) => (a && typeof a === 'object' ? (a as { artifactId?: unknown }).artifactId : undefined))
      .filter((id): id is string => typeof id === 'string')
    : [];

  // The excerpt used to be `JSON.stringify(producer.data)`, so a step read its
  // predecessor's answer as `{"text":"```json\n{\n \"status\"…` — escaped, and
  // 15 characters of envelope shorter for every 2000 of content.
  const rendered = renderProducerText(producer.data);
  let preview: string | undefined = rendered.length > 0 ? rendered : undefined;
  if (preview !== undefined && preview.length > UPSTREAM_PREVIEW_CHARS) {
    // Only promise a full copy when there is actually somewhere to get one. The
    // old message said "pełny wynik po id" unconditionally, and the artifact
    // line above it is omitted when the producer stored nothing — so a truncated
    // step pointed at ids that were never printed.
    preview = `${preview.slice(0, UPSTREAM_PREVIEW_CHARS)}\n… (ucięte, ${preview.length} zn.${
      artifacts.length > 0 ? '; pełny wynik pod artefaktem powyżej' : '; dalszego ciągu nie da się już odczytać'
    })`;
  }

  return [{
    taskId: predecessorTaskId,
    capability: task.capability ?? null,
    goal: task.goal ?? null,
    status: result?.status ?? task.phase,
    summary,
    artifacts,
    ...(preview ? { preview } : {}),
  }];
}

export async function drainWorkers(
  client: MongoClient, db: Db, fixture: WorkerFixture = okWorker,
  opts: WorkerRunOptions = {},
): Promise<number> {
  let processed = 0;
  for (;;) {
    const did = await runWorkerOnce(client, db, fixture, opts);
    if (!did) break;
    processed++;
  }
  return processed;
}

/**
 * Drive lane + workers alternately until nothing more happens (quiescence). This
 * is the deterministic test harness for the autonomous loop; production runs the
 * lane and worker pools as independent, wake-driven processes.
 */
export async function runToQuiescence(
  client: MongoClient, db: Db,
  drainLane: (c: MongoClient, d: Db) => Promise<number>,
  fixture: WorkerFixture = okWorker,
  opts: WorkerRunOptions & { maxRounds?: number } = {},
): Promise<number> {
  const maxRounds = opts.maxRounds ?? 50;
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const lane = await drainLane(client, db);
    const work = await drainWorkers(client, db, fixture, opts);
    if (lane === 0 && work === 0) break;
  }
  return rounds;
}
