import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import {
  getScheduledTask,
  listScheduledTasks,
  SCHEDULED_TASKS_COLLECTION,
  type ListScheduledTasksInput,
  type ScheduledTask,
  type ScheduledTaskStatus,
} from './scheduled-task-store.js';

export type SerializedScheduledTask = {
  taskId: string;
  status: ScheduledTaskStatus;
  schedule: {
    fireAt?: string;
    cronExpression?: string;
    timezone?: string;
  };
  targetType: ScheduledTask['targetType'];
  targetIdentifier: string;
  chainId?: string;
  chainName?: string;
  stepName?: string;
  parentThreadId?: string;
  resourceId?: string;
  idempotencyKey?: string;
  retry: ScheduledTask['retry'];
  wake?: ScheduledTask['wake'];
  hasNextStep: boolean;
  promptPreview: string;
  payloadPreview?: string;
  lastError?: string;
  resultPreview?: string;
  lease?: {
    leaseId: string;
    runnerId: string;
    leasedAt: string;
    expiresAt: string;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: string;
};

export type ScheduledTaskDashboardSummary = {
  data: SerializedScheduledTask[];
  counts: Record<string, number>;
  count: number;
  timestamp: string;
};

export async function getScheduledTaskDashboardSummary(
  input: ListScheduledTasksInput = {},
): Promise<ScheduledTaskDashboardSummary> {
  const [tasks, counts] = await Promise.all([
    listScheduledTasks(input),
    getScheduledTaskStatusCounts(),
  ]);
  return {
    data: tasks.map(serializeScheduledTask),
    counts,
    count: tasks.length,
    timestamp: new Date().toISOString(),
  };
}

export async function getSerializedScheduledTask(
  taskId: string,
): Promise<SerializedScheduledTask | null> {
  const task = await getScheduledTask(taskId);
  return task ? serializeScheduledTask(task) : null;
}

export function serializeScheduledTask(task: ScheduledTask): SerializedScheduledTask {
  return {
    taskId: task.taskId,
    status: task.status,
    schedule: {
      fireAt: toIso(task.schedule.fireAt),
      cronExpression: task.schedule.cronExpression,
      timezone: task.schedule.timezone,
    },
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    chainId: task.chainId,
    chainName: task.chainName,
    stepName: task.stepName,
    parentThreadId: task.parentThreadId,
    resourceId: task.resourceId,
    idempotencyKey: task.idempotencyKey,
    retry: task.retry,
    wake: task.wake,
    hasNextStep: Boolean(task.nextStep),
    promptPreview: redactSecrets(task.promptOrInstruction).text.slice(0, 600),
    payloadPreview: preview(task.payload),
    lastError: task.lastError,
    resultPreview: task.resultPreview,
    lease: task.lease ? {
      leaseId: task.lease.leaseId,
      runnerId: task.lease.runnerId,
      leasedAt: toIso(task.lease.leasedAt)!,
      expiresAt: toIso(task.lease.expiresAt)!,
    } : undefined,
    createdAt: toIso(task.createdAt)!,
    updatedAt: toIso(task.updatedAt)!,
    startedAt: toIso(task.startedAt),
    completedAt: toIso(task.completedAt),
    expiresAt: toIso(task.expiresAt)!,
  };
}

async function getScheduledTaskStatusCounts(): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.collection(SCHEDULED_TASKS_COLLECTION).aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [String(row._id), Number(row.count)]));
}

function toIso(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function preview(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    return redactSecrets(JSON.stringify(value)).text.slice(0, 800);
  } catch {
    return redactSecrets(String(value)).text.slice(0, 800);
  }
}
