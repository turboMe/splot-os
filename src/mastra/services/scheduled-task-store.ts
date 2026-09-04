import { randomUUID } from 'crypto';
import type { WithId } from 'mongodb';

import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';

export const SCHEDULED_TASKS_COLLECTION = 'scheduled_tasks';
export const SCHEDULED_TASK_DISPATCHES_COLLECTION = 'scheduled_task_dispatches';

export const SCHEDULED_TARGET_TYPES = [
  'AGENT',
  'N8N_WEBHOOK',
  'MASTRA_WORKFLOW',
  'WORKER_COMMAND',
] as const;

export type ScheduledTargetType = typeof SCHEDULED_TARGET_TYPES[number];

export type ScheduledTaskStatus =
  | 'scheduled'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

export type ScheduledTaskRetry = {
  maxAttempts: number;
  attempt: number;
  backoffMs: number;
};

export type ScheduledTaskLease = {
  leaseId: string;
  leasedAt: Date;
  expiresAt: Date;
  runnerId: string;
};

export type ScheduledTaskWake = {
  targetAgentId: string;
  threadId?: string;
};

export type ScheduledTaskDispatchStatus = 'running' | 'completed' | 'failed';

export type ScheduledTaskDispatch = {
  idempotencyKey: string;
  taskId: string;
  targetType: ScheduledTargetType;
  targetIdentifier: string;
  status: ScheduledTaskDispatchStatus;
  attempt: number;
  startedAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  resultPreview?: string;
  result?: unknown;
  error?: string;
  expiresAt: Date;
};

export type ScheduledTaskNextStepInput = {
  fireAt?: string | Date;
  cronExpression?: string;
  /**
   * How long after the PREVIOUS step completes this one fires. The natural way
   * to say "and then do this", and until it existed a chain step could only be
   * given an absolute `fireAt` (a fixed timestamp, already in the past on every
   * later recurrence) or its own `cronExpression` (which makes the step recur
   * independently, so from day two the chain fires it twice). Both are wrong
   * answers to the same question, and the schema demanded one of them.
   *
   * Ignored when `fireAt` or `cronExpression` is given. 0 means "as soon as the
   * runner next polls".
   */
  delayMs?: number;
  timezone?: string;
  targetType: ScheduledTargetType;
  targetIdentifier: string;
  promptOrInstruction: string;
  payload?: Record<string, unknown>;
  chainId?: string;
  chainName?: string;
  stepName?: string;
  cycleId?: string;
  inputArtifactIds?: string[];
  parentThreadId?: string;
  resourceId?: string;
  nextStep?: ScheduledTaskNextStepInput;
  retry?: Partial<ScheduledTaskRetry>;
  wake?: boolean | ScheduledTaskWake;
  idempotencyKey?: string;
  ttlMs?: number;
};

/** How one occurrence follows another — see `ScheduledTask.succeedsTaskId`. */
export type ScheduledTaskSuccession = 'next_step' | 'recurrence';

export type CreateScheduledTaskInput = ScheduledTaskNextStepInput & {
  taskId?: string;
  succeedsTaskId?: string;
  succession?: ScheduledTaskSuccession;
};

export type ScheduledTaskSchedule = {
  fireAt?: Date;
  cronExpression?: string;
  timezone?: string;
};

export type ScheduledTask = {
  taskId: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskSchedule;
  targetType: ScheduledTargetType;
  targetIdentifier: string;
  promptOrInstruction: string;
  payload?: Record<string, unknown>;
  chainId?: string;
  chainName?: string;
  stepName?: string;
  cycleId?: string;
  inputArtifactIds?: string[];
  parentThreadId?: string;
  resourceId?: string;
  nextStep?: ScheduledTaskNextStepInput;
  idempotencyKey?: string;
  retry: ScheduledTaskRetry;
  lease?: ScheduledTaskLease;
  wake?: ScheduledTaskWake;
  lastError?: string;
  resultPreview?: string;
  /**
   * Which occurrence this one succeeds, and how (GAP-CUTOVER-01).
   *
   * An autonomous trigger has exactly one dangerous property: it must fire
   * neither zero times nor twice, and both failures are invisible. Nobody
   * notices a recurrence that silently stopped, and a duplicate looks like the
   * schedule "working harder".
   *
   * Before this, the successor was created by a plain `createScheduledTask` with
   * a fresh random id, so nothing linked an occurrence to the one it came from
   * and nothing stopped two runners creating two successors for one occurrence.
   * With `succeedsTaskId` + `succession` under a unique index, a second attempt
   * is a duplicate key — a no-op instead of a permanently doubled schedule — and
   * a MISSING successor becomes a question the reconciler can actually ask.
   */
  succeedsTaskId?: string;
  succession?: ScheduledTaskSuccession;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;
};

export type LeaseScheduledTaskInput = {
  runnerId: string;
  now?: Date;
  leaseMs?: number;
};

export type ScheduledTaskCompletionInput = {
  taskId: string;
  leaseId?: string;
  resultPreview?: string;
};

export type ScheduledTaskFailureInput = {
  taskId: string;
  leaseId?: string;
  error: string;
  now?: Date;
};

export type ListScheduledTasksInput = {
  status?: ScheduledTaskStatus;
  chainId?: string;
  targetType?: ScheduledTargetType;
  limit?: number;
};

export type RescheduleScheduledTaskInput = {
  taskId: string;
  fireAt?: string | Date;
  cronExpression?: string;
  timezone?: string;
  resetRetry?: boolean;
};

export type BeginScheduledTaskDispatchResult =
  | { shouldDispatch: true; idempotencyKey: string }
  | { shouldDispatch: false; idempotencyKey: string; dispatch: ScheduledTaskDispatch };

export const DEFAULT_TIMEZONE = 'Atlantic/Reykjavik';

const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MAX_PROMPT_CHARS = 20000;
const MAX_PREVIEW_CHARS = 4000;

export async function createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
  const now = new Date();
  const task = buildScheduledTask(input, now);
  const db = await getDb();
  try {
    await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).insertOne(task);
  } catch (error) {
    // A successor already exists for this occurrence. That is not an error: it
    // is the unique index doing the one job it was added for — two runners (or
    // one runner retried) must not leave a schedule firing twice forever. Return
    // the row that won, so the caller reports the real successor rather than a
    // task that was never inserted.
    if ((error as { code?: number }).code === 11000 && task.succeedsTaskId) {
      const winner = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOne({
        succeedsTaskId: task.succeedsTaskId,
        succession: task.succession,
      });
      if (winner) return stripMongoId(winner)!;
    }
    throw error;
  }
  return task;
}

export async function leaseDueScheduledTask(
  input: LeaseScheduledTaskInput,
): Promise<ScheduledTask | null> {
  const now = input.now ?? new Date();
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS));
  const db = await getDb();

  const result = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOneAndUpdate(
    {
      $or: [
        { status: 'scheduled', 'schedule.fireAt': { $lte: now } },
        { status: 'leased', 'lease.expiresAt': { $lte: now } },
        { status: 'running', 'lease.expiresAt': { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'leased' as ScheduledTaskStatus,
        lease: {
          leaseId,
          leasedAt: now,
          expiresAt: leaseExpiresAt,
          runnerId: input.runnerId,
        },
        updatedAt: now,
      },
      $inc: { 'retry.attempt': 1 },
    },
    {
      sort: { 'schedule.fireAt': 1, createdAt: 1 },
      returnDocument: 'after',
    },
  );

  return stripMongoId(result);
}

export async function markScheduledTaskRunning(
  taskId: string,
  leaseId?: string,
): Promise<ScheduledTask | null> {
  const now = new Date();
  const db = await getDb();
  const result = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOneAndUpdate(
    buildLeaseScopedQuery(taskId, leaseId),
    {
      $set: {
        status: 'running' as ScheduledTaskStatus,
        startedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  return stripMongoId(result);
}

export async function markScheduledTaskCompleted(
  input: ScheduledTaskCompletionInput,
): Promise<ScheduledTask | null> {
  const now = new Date();
  const db = await getDb();
  const result = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOneAndUpdate(
    buildLeaseScopedQuery(input.taskId, input.leaseId),
    {
      $set: {
        status: 'completed' as ScheduledTaskStatus,
        completedAt: now,
        updatedAt: now,
        ...(input.resultPreview ? { resultPreview: sanitizePreview(input.resultPreview) } : {}),
      },
      $unset: { lease: '' },
    },
    { returnDocument: 'after' },
  );
  return stripMongoId(result);
}

export async function markScheduledTaskFailed(
  input: ScheduledTaskFailureInput,
): Promise<{ task: ScheduledTask | null; retryScheduled: boolean }> {
  const now = input.now ?? new Date();
  const db = await getDb();
  const existing = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOne(
    buildLeaseScopedQuery(input.taskId, input.leaseId),
  );
  if (!existing) return { task: null, retryScheduled: false };

  const retryScheduled = existing.retry.attempt < existing.retry.maxAttempts;
  const status: ScheduledTaskStatus = retryScheduled ? 'scheduled' : 'failed';
  const nextFireAt = retryScheduled
    ? new Date(now.getTime() + existing.retry.backoffMs * Math.max(1, existing.retry.attempt))
    : existing.schedule.fireAt;

  const result = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOneAndUpdate(
    buildLeaseScopedQuery(input.taskId, input.leaseId),
    {
      $set: {
        status,
        lastError: sanitizePreview(input.error),
        updatedAt: now,
        ...(retryScheduled ? { 'schedule.fireAt': nextFireAt } : { completedAt: now }),
      },
      $unset: { lease: '' },
    },
    { returnDocument: 'after' },
  );

  return { task: stripMongoId(result), retryScheduled };
}

/**
 * GAP-CUTOVER-01 — repair recurring schedules that lost their successor.
 *
 * The other half of "neither zero nor twice". Completion and successor-creation
 * are two writes: if the process dies between them, the recurrence simply STOPS.
 * Nothing errors, nothing is marked failed, and nobody notices — a thing that
 * did not happen leaves no trace. That is the worst failure mode an autonomous
 * trigger has, and it is why this reconciler exists rather than a comment saying
 * the window is small.
 *
 * Safe to run repeatedly and from more than one process: the successor carries
 * `succeedsTaskId` under a unique index, so a race produces one row and a
 * duplicate-key no-op. It only ever repairs COMPLETED recurring occurrences —
 * never a failed one (whose retry policy owns the decision) and never one that
 * already has a successor.
 */
export interface StoppedRecurrence {
  chainId: string;
  /** The last occurrence that ran — the one whose successor was never written. */
  taskId: string;
  targetType: ScheduledTargetType;
  targetIdentifier: string;
  cronExpression: string;
  completedAt?: Date;
}

/**
 * REPORT ONLY. Repair is `repairStoppedRecurrence`, one chain at a time.
 *
 * "Has no successor row" is NOT the test, and getting that wrong would have been
 * catastrophic. Occurrences created before this change carry no `succeedsTaskId`,
 * so a whole historical chain A→B→C reads as three successorless completions —
 * repairing on that rule would have resurrected every recurring schedule this
 * system has ever run, several times over, and each one FIRES.
 *
 * The honest question is "is this schedule stopped?", and its answer is per
 * CHAIN: a recurrence is alive while any occurrence of its chain is still
 * scheduled, leased or running. Only a chain with none of those, whose newest
 * occurrence completed rather than being cancelled, has actually stopped.
 */
export async function findStoppedRecurrences(
  opts: { limit?: number; now?: Date } = {},
): Promise<StoppedRecurrence[]> {
  const now = opts.now ?? new Date();
  const db = await getDb();
  const tasks = db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION);
  const completed = await tasks
    .find({
      status: 'completed',
      'schedule.cronExpression': { $exists: true, $nin: [null, ''] },
      expiresAt: { $gt: now },
    })
    .sort({ completedAt: -1 })
    .limit(opts.limit ?? 500)
    .toArray();

  const seenChains = new Set<string>();
  const stopped: StoppedRecurrence[] = [];
  for (const raw of completed) {
    const task = stripMongoId(raw)!;
    const chainId = task.chainId;
    if (!chainId || seenChains.has(chainId)) continue;
    seenChains.add(chainId);
    // Alive if ANY occurrence of this chain is still pending or in flight.
    const live = await tasks.countDocuments({
      chainId,
      status: { $in: ['scheduled', 'leased', 'running'] },
    });
    if (live > 0) continue;
    // A cancelled chain is a decision, not a fault.
    const cancelled = await tasks.countDocuments({ chainId, status: 'cancelled' });
    if (cancelled > 0) continue;
    stopped.push({
      chainId,
      taskId: task.taskId,
      targetType: task.targetType,
      targetIdentifier: task.targetIdentifier,
      cronExpression: task.schedule.cronExpression!,
      completedAt: task.completedAt,
    });
  }
  return stopped;
}

/**
 * Restart one stopped recurrence, writing exactly the row the runner would have.
 *
 * Deliberately per-chain and explicitly invoked. Creating a scheduled task is
 * not a bookkeeping fix — the row FIRES, and firing may run an agent or an n8n
 * workflow. A sweeper that quietly restarted every schedule it thought had
 * stopped would be making that call on the operator's behalf, in bulk, on live
 * data. `findStoppedRecurrences` reports; a human (or a tool they invoke)
 * decides.
 *
 * Idempotent regardless: the successor is keyed by `succeedsTaskId` under a
 * unique index, so calling this twice restarts the schedule once.
 */
export async function repairStoppedRecurrence(
  taskId: string,
  opts: { now?: Date } = {},
): Promise<ScheduledTask | null> {
  const task = await getScheduledTask(taskId);
  if (!task || !task.schedule.cronExpression || task.status !== 'completed') return null;
  const ttlMs = task.expiresAt.getTime() - (opts.now ?? new Date()).getTime();
  if (ttlMs <= 0) return null;
  return createScheduledTask({
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    promptOrInstruction: task.promptOrInstruction,
    payload: task.payload,
    chainId: task.chainId,
    chainName: task.chainName,
    stepName: task.stepName,
    parentThreadId: task.parentThreadId,
    resourceId: task.resourceId,
    nextStep: task.nextStep,
    retry: { maxAttempts: task.retry.maxAttempts, backoffMs: task.retry.backoffMs },
    wake: task.wake,
    cronExpression: task.schedule.cronExpression,
    timezone: task.schedule.timezone,
    ttlMs: Math.max(60_000, ttlMs),
    succeedsTaskId: task.taskId,
    succession: 'recurrence',
  });
}

export async function getScheduledTask(taskId: string): Promise<ScheduledTask | null> {
  const db = await getDb();
  const doc = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOne({ taskId });
  return stripMongoId(doc);
}

export async function listScheduledTasks(
  input: ListScheduledTasksInput = {},
): Promise<ScheduledTask[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};
  if (input.status) query.status = input.status;
  if (input.chainId) query.chainId = input.chainId;
  if (input.targetType) query.targetType = input.targetType;

  const docs = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION)
    .find(query)
    .sort({ createdAt: -1 })
    .limit(input.limit ?? 20)
    .toArray();
  return docs.map(stripMongoId).filter((task): task is ScheduledTask => Boolean(task));
}

export async function cancelScheduledTask(taskId: string): Promise<boolean> {
  const now = new Date();
  const db = await getDb();
  const result = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).updateOne(
    { taskId, status: { $in: ['scheduled', 'leased', 'running'] } },
    {
      $set: {
        status: 'cancelled' as ScheduledTaskStatus,
        completedAt: now,
        updatedAt: now,
      },
      $unset: { lease: '' },
    },
  );
  return result.modifiedCount > 0;
}

export async function rescheduleScheduledTask(
  input: RescheduleScheduledTaskInput,
): Promise<ScheduledTask | null> {
  if (!input.fireAt && !input.cronExpression) {
    throw new Error('Either fireAt or cronExpression is required.');
  }

  const now = new Date();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const fireAt = input.fireAt
    ? parseDateInput(input.fireAt, 'fireAt')
    : computeNextCronFireAt(input.cronExpression!, now, timezone);
  const db = await getDb();
  const set: Record<string, unknown> = {
    status: 'scheduled' as ScheduledTaskStatus,
    'schedule.fireAt': fireAt,
    'schedule.timezone': timezone,
    updatedAt: now,
    ...(input.resetRetry ?? true ? { 'retry.attempt': 0 } : {}),
  };
  // Values must stay '' (not plain string) — the driver's UpdateFilter types
  // $unset as Record<string, true | '' | 1>.
  const unset: Record<string, ''> = {
    lease: '',
    completedAt: '',
    startedAt: '',
    lastError: '',
    resultPreview: '',
  };
  if (input.cronExpression) {
    set['schedule.cronExpression'] = input.cronExpression;
  } else {
    unset['schedule.cronExpression'] = '';
  }

  const result = await db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION).findOneAndUpdate(
    {
      taskId: input.taskId,
      status: { $in: ['scheduled', 'leased', 'failed', 'cancelled', 'stale'] },
    },
    {
      $set: set,
      $unset: unset,
    },
    { returnDocument: 'after' },
  );
  return stripMongoId(result);
}

export function getScheduledTaskIdempotencyKey(task: ScheduledTask): string | undefined {
  if (task.targetType === 'WORKER_COMMAND') return undefined;
  return task.idempotencyKey ?? `${task.targetType}:${task.targetIdentifier}:${task.taskId}`;
}

export async function beginScheduledTaskDispatch(
  task: ScheduledTask,
): Promise<BeginScheduledTaskDispatchResult> {
  const idempotencyKey = getScheduledTaskIdempotencyKey(task);
  if (!idempotencyKey) {
    return { shouldDispatch: true, idempotencyKey: task.taskId };
  }

  const now = new Date();
  const dispatch: ScheduledTaskDispatch = {
    idempotencyKey,
    taskId: task.taskId,
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    status: 'running',
    attempt: task.retry.attempt,
    startedAt: now,
    updatedAt: now,
    expiresAt: task.expiresAt,
  };
  const db = await getDb();
  const collection = db.collection<ScheduledTaskDispatch>(SCHEDULED_TASK_DISPATCHES_COLLECTION);

  try {
    await collection.insertOne(dispatch);
    return { shouldDispatch: true, idempotencyKey };
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 11000) throw error;
  }

  const existing = await collection.findOne({ idempotencyKey });
  if (!existing) {
    throw new Error(`Dispatch idempotency conflict without record: ${idempotencyKey}`);
  }
  if (existing.status === 'completed') {
    return { shouldDispatch: false, idempotencyKey, dispatch: stripMongoId(existing)! };
  }
  if (existing.status === 'running' && existing.taskId !== task.taskId && existing.expiresAt > now) {
    throw new Error(`Dispatch already running for idempotencyKey ${idempotencyKey}.`);
  }

  const result = await collection.findOneAndUpdate(
    { idempotencyKey, status: { $in: ['failed', 'running'] } },
    {
      $set: {
        taskId: task.taskId,
        targetType: task.targetType,
        targetIdentifier: task.targetIdentifier,
        status: 'running' as ScheduledTaskDispatchStatus,
        attempt: task.retry.attempt,
        startedAt: now,
        updatedAt: now,
        expiresAt: task.expiresAt,
      },
      $unset: {
        completedAt: '',
        resultPreview: '',
        result: '',
        error: '',
      },
    },
    { returnDocument: 'after' },
  );
  const refreshed = stripMongoId(result);
  if (!refreshed) {
    throw new Error(`Unable to acquire dispatch idempotencyKey ${idempotencyKey}.`);
  }
  return { shouldDispatch: true, idempotencyKey };
}

export async function completeScheduledTaskDispatch(input: {
  idempotencyKey: string;
  result?: unknown;
  resultPreview?: string;
}): Promise<void> {
  if (!input.idempotencyKey) return;
  const now = new Date();
  const db = await getDb();
  const set: Record<string, unknown> = {
    status: 'completed' as ScheduledTaskDispatchStatus,
    completedAt: now,
    updatedAt: now,
  };
  if (input.resultPreview) set.resultPreview = sanitizePreview(input.resultPreview);
  const storedResult = sanitizeStoredResult(input.result);
  if (storedResult !== undefined) set.result = storedResult;

  await db.collection<ScheduledTaskDispatch>(SCHEDULED_TASK_DISPATCHES_COLLECTION).updateOne(
    { idempotencyKey: input.idempotencyKey },
    {
      $set: set,
      $unset: { error: '' },
    },
  );
}

export async function failScheduledTaskDispatch(input: {
  idempotencyKey: string;
  error: string;
}): Promise<void> {
  if (!input.idempotencyKey) return;
  const now = new Date();
  const db = await getDb();
  await db.collection<ScheduledTaskDispatch>(SCHEDULED_TASK_DISPATCHES_COLLECTION).updateOne(
    { idempotencyKey: input.idempotencyKey },
    {
      $set: {
        status: 'failed' as ScheduledTaskDispatchStatus,
        error: sanitizePreview(input.error),
        updatedAt: now,
      },
    },
  );
}

export function buildScheduledTask(
  input: CreateScheduledTaskInput,
  now: Date = new Date(),
): ScheduledTask {
  if (!SCHEDULED_TARGET_TYPES.includes(input.targetType)) {
    throw new Error(`Unsupported scheduled target type: ${input.targetType}`);
  }
  if (!input.fireAt && !input.cronExpression) {
    throw new Error('Either fireAt or cronExpression is required.');
  }
  if (!input.targetIdentifier.trim()) {
    throw new Error('targetIdentifier is required.');
  }
  if (!input.promptOrInstruction.trim()) {
    throw new Error('promptOrInstruction is required.');
  }

  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const fireAt = input.fireAt
    ? parseDateInput(input.fireAt, 'fireAt')
    : computeNextCronFireAt(input.cronExpression!, now, timezone);
  const chainId = input.chainId || randomUUID();
  const retry = normalizeRetry(input.retry);
  const wake = normalizeWake(input.wake);

  return {
    taskId: input.taskId ?? randomUUID(),
    status: 'scheduled',
    schedule: {
      fireAt,
      cronExpression: input.cronExpression,
      timezone,
    },
    targetType: input.targetType,
    targetIdentifier: input.targetIdentifier.trim(),
    promptOrInstruction: input.promptOrInstruction.trim().slice(0, MAX_PROMPT_CHARS),
    payload: input.payload,
    chainId,
    chainName: input.chainName,
    stepName: input.stepName,
    ...(input.cycleId ? { cycleId: input.cycleId } : {}),
    ...(input.inputArtifactIds && input.inputArtifactIds.length > 0 ? { inputArtifactIds: input.inputArtifactIds } : {}),
    parentThreadId: input.parentThreadId,
    resourceId: input.resourceId,
    nextStep: input.nextStep ? normalizeNextStep(input.nextStep, chainId, input.chainName, input.cycleId) : undefined,
    idempotencyKey: input.idempotencyKey,
    // Omitted rather than set to undefined: a task nobody succeeded must not
    // acquire a null key, or every such row would collide on the unique index.
    ...(input.succeedsTaskId ? { succeedsTaskId: input.succeedsTaskId } : {}),
    ...(input.succession ? { succession: input.succession } : {}),
    retry,
    wake,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
  };
}

/**
 * Materialise the successor of a completed occurrence.
 *
 * A chain step is normally described by WHAT it does, not by when — "and then
 * hand this to the marketing agent". `buildScheduledTask` needs a fire time,
 * though, so a step carrying neither `fireAt` nor `cronExpression` used to
 * throw here, one write after the parent had already been marked completed. The
 * successor was never created, the recurrence that ran next was never created
 * either, and the parent stayed green: a daily chain that ran exactly once and
 * said nothing. `delayMs` (default: immediately) is the missing default.
 */
export function buildNextScheduledTaskInput(
  parent: ScheduledTask,
  now: Date = new Date(),
): CreateScheduledTaskInput | null {
  if (!parent.nextStep) return null;
  const step = parent.nextStep;
  const hasOwnSchedule = Boolean(step.fireAt || step.cronExpression);
  return {
    ...step,
    ...(hasOwnSchedule
      ? {}
      : { fireAt: new Date(now.getTime() + Math.max(0, step.delayMs ?? 0)) }),
    chainId: step.chainId ?? parent.chainId,
    chainName: step.chainName ?? parent.chainName,
    cycleId: step.cycleId ?? parent.cycleId,
    ...(step.inputArtifactIds && step.inputArtifactIds.length > 0 ? { inputArtifactIds: step.inputArtifactIds } : {}),
    parentThreadId: step.parentThreadId ?? parent.parentThreadId,
    resourceId: step.resourceId ?? parent.resourceId,
    wake: step.wake ?? parent.wake,
  };
}

function normalizeNextStep(
  input: ScheduledTaskNextStepInput,
  chainId: string,
  chainName?: string,
  cycleId?: string,
): ScheduledTaskNextStepInput {
  return {
    ...input,
    chainId: input.chainId ?? chainId,
    chainName: input.chainName ?? chainName,
    ...(input.cycleId || cycleId ? { cycleId: input.cycleId ?? cycleId } : {}),
    ...(input.inputArtifactIds && input.inputArtifactIds.length > 0 ? { inputArtifactIds: input.inputArtifactIds } : {}),
    nextStep: input.nextStep ? normalizeNextStep(input.nextStep, input.chainId ?? chainId, input.chainName ?? chainName, input.cycleId ?? cycleId) : undefined,
  };
}

function normalizeRetry(retry: Partial<ScheduledTaskRetry> | undefined): ScheduledTaskRetry {
  const maxAttempts = clampInt(retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 10);
  return {
    maxAttempts,
    attempt: clampInt(retry?.attempt ?? 0, 0, maxAttempts),
    backoffMs: clampInt(retry?.backoffMs ?? DEFAULT_BACKOFF_MS, 1000, 24 * 3600 * 1000),
  };
}

function normalizeWake(wake: boolean | ScheduledTaskWake | undefined): ScheduledTaskWake | undefined {
  if (!wake) return undefined;
  if (wake === true) return { targetAgentId: 'meta-agent' };
  return wake;
}

function parseDateInput(value: string | Date, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid ISO 8601 date.`);
  }
  return date;
}

export function computeNextCronFireAt(
  cronExpression: string,
  now: Date,
  timezone: string = DEFAULT_TIMEZONE,
): Date {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('cronExpression must use five fields: minute hour day-of-month month day-of-week.');
  }

  const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;
  const start = new Date(now.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    const partsFormatted = formatter.formatToParts(candidate);
    const map: Record<string, string> = {};
    for (const p of partsFormatted) {
      map[p.type] = p.value;
    }
    const minute = Number(map.minute);
    const hour = Number(map.hour);
    const day = Number(map.day);
    const month = Number(map.month);
    const dayOfWeek = weekdayMap[map.weekday] ?? 0;

    if (
      cronFieldMatches(minuteExpr, minute, 0, 59) &&
      cronFieldMatches(hourExpr, hour, 0, 23) &&
      cronFieldMatches(domExpr, day, 1, 31) &&
      cronFieldMatches(monthExpr, month, 1, 12) &&
      cronFieldMatches(dowExpr, dayOfWeek, 0, 7)
    ) {
      return candidate;
    }
  }

  throw new Error('Unable to compute next cron fire time within one year.');
}

function cronFieldMatches(expr: string, value: number, min: number, max: number): boolean {
  if (expr === '*') return true;
  return expr.split(',').some((part) => cronPartMatches(part, value, min, max));
}

function cronPartMatches(part: string, value: number, min: number, max: number): boolean {
  const [rangePart, stepPart] = part.split('/');
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isInteger(step) || step <= 0) return false;

  let start: number;
  let end: number;
  if (rangePart === '*') {
    start = min;
    end = max;
  } else if (rangePart.includes('-')) {
    const [rawStart, rawEnd] = rangePart.split('-').map(Number);
    start = rawStart;
    end = rawEnd;
  } else {
    start = Number(rangePart);
    end = start;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  const normalizedValue = value === 0 && max === 7 && start === 7 ? 7 : value;
  if (normalizedValue < start || normalizedValue > end) return false;
  return (normalizedValue - start) % step === 0;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function buildLeaseScopedQuery(taskId: string, leaseId?: string): Record<string, unknown> {
  return {
    taskId,
    ...(leaseId ? { 'lease.leaseId': leaseId } : {}),
  };
}

function stripMongoId<T extends object>(doc: WithId<T> | T | null): T | null {
  if (!doc) return null;
  const { _id: _ignored, ...rest } = doc as WithId<T>;
  return rest as T;
}

function sanitizePreview(value: string): string {
  return redactSecrets(value).text.slice(0, MAX_PREVIEW_CHARS);
}

function sanitizeStoredResult(result: unknown): unknown {
  if (result == null) return undefined;
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  const redacted = redactSecrets(text).text.slice(0, MAX_PREVIEW_CHARS);
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
}
