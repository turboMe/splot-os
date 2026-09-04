import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';

export const TASK_CHAINS_COLLECTION = 'task_chains';

export type TaskChainStatus = 'completed' | 'failed';

export type TaskChainArtifact = {
  id: string;
  type: string;
  summary?: string;
};

export type TaskChainEntry = {
  chainId: string;
  cycleId?: string;
  stepName: string;
  taskId: string;
  status: TaskChainStatus;
  completedAt: Date;
  resultPreview?: string;
  result?: unknown;
  artifacts?: TaskChainArtifact[];
  error?: string;
  metadata: Record<string, unknown>;
  expiresAt: Date;
};

export type SaveTaskChainResultInput = {
  chainId: string;
  cycleId?: string;
  stepName: string;
  taskId: string;
  status: TaskChainStatus;
  result?: unknown;
  artifacts?: TaskChainArtifact[];
  error?: string;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
};

export type GetTaskChainContextInput = {
  chainId: string;
  cycleId?: string;
  limit?: number;
};

const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_RESULT_PREVIEW_CHARS = 4000;
const MAX_STORED_RESULT_CHARS = 20000;

/**
 * One step's outcome, written under the step's own taskId.
 *
 * A step is saved MORE THAN ONCE: the runner records the successful dispatch,
 * and anything that throws afterwards (scheduling the successor, for one)
 * records a failure for the same taskId. The first version of this wrote the
 * whole entry with `$set` every time, so that second call — which carries an
 * error and no result — overwrote the work the step had just finished with an
 * empty string. The chain's own output, gone from the only place the NEXT step
 * reads it, while the task row still looked fine.
 *
 * So: a result is written only when the caller actually has one. A failure
 * stamps status and error and leaves the payload alone.
 */
export async function saveTaskChainResult(input: SaveTaskChainResultInput): Promise<TaskChainEntry> {
  const now = new Date();
  const hasResult = input.result !== undefined;
  const redactedResultText = hasResult
    ? redactSecrets(stringifyResult(input.result)).text
    : '';
  const error = input.error ? redactSecrets(input.error).text : undefined;
  const entry: TaskChainEntry = {
    chainId: input.chainId,
    ...(input.cycleId ? { cycleId: input.cycleId } : {}),
    stepName: input.stepName || input.taskId,
    taskId: input.taskId,
    status: input.status,
    completedAt: now,
    ...(hasResult
      ? {
        resultPreview: redactedResultText.slice(0, MAX_RESULT_PREVIEW_CHARS),
        result: toStoredResult(redactedResultText),
      }
      : {}),
    ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
    error,
    metadata: input.metadata ?? {},
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
  };

  const db = await getDb();
  await db.collection<TaskChainEntry>(TASK_CHAINS_COLLECTION).updateOne(
    { taskId: input.taskId },
    { $set: entry },
    { upsert: true },
  );
  return entry;
}

export async function getTaskChainContext(
  input: GetTaskChainContextInput,
): Promise<TaskChainEntry[]> {
  const db = await getDb();
  if (input.cycleId) {
    const entries = await db.collection<TaskChainEntry>(TASK_CHAINS_COLLECTION)
      .find({ chainId: input.chainId, cycleId: input.cycleId })
      .sort({ completedAt: 1 })
      .limit(input.limit ?? 20)
      .toArray();

    if (entries.length > 0) {
      return entries;
    }

    // Fallback only for legacy entries that were saved without cycleId
    return db.collection<TaskChainEntry>(TASK_CHAINS_COLLECTION)
      .find({ chainId: input.chainId, cycleId: { $exists: false } })
      .sort({ completedAt: 1 })
      .limit(input.limit ?? 20)
      .toArray();
  }

  return db.collection<TaskChainEntry>(TASK_CHAINS_COLLECTION)
    .find({ chainId: input.chainId })
    .sort({ completedAt: 1 })
    .limit(input.limit ?? 20)
    .toArray();
}

export async function getLatestTaskChainResult(chainId: string): Promise<TaskChainEntry | null> {
  const db = await getDb();
  return db.collection<TaskChainEntry>(TASK_CHAINS_COLLECTION)
    .find({ chainId })
    .sort({ completedAt: -1 })
    .limit(1)
    .next();
}

/**
 * The full stored result, not the preview.
 *
 * `resultPreview` is a 4k display string; `result` holds up to 20k. This text
 * is what the NEXT step in a chain actually reads, and a step that hands over a
 * structured payload (a JSON block of qualified leads, say) had it cut mid-token
 * at 4k — the successor received JSON that does not parse and improvised the
 * rest. Preview is for humans reading a dashboard; a handoff gets the payload.
 */
function renderChainResult(entry: TaskChainEntry): string | undefined {
  if (entry.result === undefined || entry.result === null) return entry.resultPreview;
  const text = typeof entry.result === 'string' ? entry.result : stringifyResult(entry.result);
  return text || entry.resultPreview;
}

export function formatTaskChainContext(entries: TaskChainEntry[]): string {
  if (entries.length === 0) return 'No chain context found.';
  return entries.map((entry, index) => {
    const result = renderChainResult(entry);
    const lines = [
      `## Step ${index + 1}: ${entry.stepName}`,
      `taskId: ${entry.taskId}`,
      `status: ${entry.status}`,
      `completedAt: ${entry.completedAt instanceof Date ? entry.completedAt.toISOString() : String(entry.completedAt)}`,
      entry.error ? `error: ${entry.error}` : '',
      result ? `result:\n${result}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');
}

function stringifyResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function toStoredResult(text: string): unknown {
  const sliced = text.slice(0, MAX_STORED_RESULT_CHARS);
  if (!sliced) return undefined;
  try {
    return JSON.parse(sliced);
  } catch {
    return sliced;
  }
}
