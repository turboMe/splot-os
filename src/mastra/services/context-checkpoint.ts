/**
 * Context Checkpoint Service (Phase 5 — Context Management)
 *
 * Persists task execution state between sessions to prevent context loss
 * during long-running autonomous operations. Integrates with the subtask
 * executor to auto-save/restore progress.
 *
 * Storage: MongoDB `context_checkpoints` collection (aligns with existing patterns).
 *
 * Lifecycle:
 *   1. Auto-save after each subtask group completes
 *   2. Auto-save before context compaction events
 *   3. Auto-restore when a task resumes after session break
 *   4. TTL: 7 days (auto-cleanup of stale checkpoints)
 */

import { getDb } from '../lib/mongo.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TaskCheckpoint {
  taskId: string;
  goal: string;
  /** Linked GoalContract, if this checkpoint has persisted goal tracking */
  goalContractId?: string;
  /** Key decisions made during execution */
  decisionsLog: string[];
  /** Files that have been modified */
  filesModified: string[];
  /** Known issues discovered during execution */
  knownIssues: string[];
  /** What should be done next */
  nextSteps: string[];
  /** Subtask completion status */
  subtaskProgress: Record<string, 'done' | 'pending' | 'failed' | 'skipped'>;
  /** Current execution phase/stage */
  currentPhase?: string;
  /** Accumulated errors for diagnostics */
  errors: string[];
  /** Metadata */
  savedAt: string;
  version: number;
  /** TTL — auto-cleanup after 7 days */
  expiresAt: Date;
}

// ── Collection name ──────────────────────────────────────────────────────────

const COLLECTION = 'context_checkpoints';
const CHECKPOINT_TTL_DAYS = 7;

// ── Singleton ────────────────────────────────────────────────────────────────

let _initialized = false;

async function ensureIndexes(): Promise<void> {
  if (_initialized) return;
  try {
    const db = await getDb();
    await Promise.all([
      db.collection(COLLECTION).createIndex({ taskId: 1 }, { unique: true }),
      db.collection(COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection(COLLECTION).createIndex({ savedAt: -1 }),
    ]);
    _initialized = true;
  } catch {
    // Indexes may already exist
    _initialized = true;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a checkpoint for a task. Upserts — creates or updates.
 */
export async function saveCheckpoint(checkpoint: Omit<TaskCheckpoint, 'savedAt' | 'version' | 'expiresAt'>): Promise<void> {
  await ensureIndexes();
  const db = await getDb();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHECKPOINT_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.collection(COLLECTION).updateOne(
    { taskId: checkpoint.taskId },
    {
      $set: {
        ...checkpoint,
        savedAt: now.toISOString(),
        expiresAt,
      },
      $inc: { version: 1 },
      $setOnInsert: { createdAt: now.toISOString() },
    },
    { upsert: true },
  );

  console.log(`[Checkpoint] Saved for task ${checkpoint.taskId} (${checkpoint.subtaskProgress ? Object.keys(checkpoint.subtaskProgress).length : 0} subtasks tracked)`);
}

/**
 * Load the latest checkpoint for a task. Returns null if none exists.
 */
export async function loadCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
  await ensureIndexes();
  const db = await getDb();

  const doc = await db.collection(COLLECTION).findOne({ taskId });
  if (!doc) return null;

  return {
    taskId: doc.taskId,
    goal: doc.goal ?? '',
    goalContractId: doc.goalContractId,
    decisionsLog: doc.decisionsLog ?? [],
    filesModified: doc.filesModified ?? [],
    knownIssues: doc.knownIssues ?? [],
    nextSteps: doc.nextSteps ?? [],
    subtaskProgress: doc.subtaskProgress ?? {},
    currentPhase: doc.currentPhase,
    errors: doc.errors ?? [],
    savedAt: doc.savedAt,
    version: doc.version ?? 1,
    expiresAt: doc.expiresAt,
  };
}

/**
 * Delete a checkpoint (e.g., after task completion).
 */
export async function deleteCheckpoint(taskId: string): Promise<void> {
  await ensureIndexes();
  const db = await getDb();
  await db.collection(COLLECTION).deleteOne({ taskId });
}

/**
 * Quick update — append a decision, modified file, or issue without full rewrite.
 */
export async function appendToCheckpoint(
  taskId: string,
  updates: {
    decision?: string;
    fileModified?: string;
    issue?: string;
    error?: string;
    subtaskStatus?: { id: string; status: 'done' | 'pending' | 'failed' | 'skipped' };
    nextStep?: string;
    currentPhase?: string;
    goalContractId?: string;
  },
): Promise<void> {
  await ensureIndexes();
  const db = await getDb();

  const $push: Record<string, any> = {};
  const $set: Record<string, any> = {
    savedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CHECKPOINT_TTL_DAYS * 24 * 60 * 60 * 1000),
  };

  if (updates.decision) $push['decisionsLog'] = updates.decision;
  if (updates.fileModified) $push['filesModified'] = updates.fileModified;
  if (updates.issue) $push['knownIssues'] = updates.issue;
  if (updates.error) $push['errors'] = updates.error;
  if (updates.nextStep) $push['nextSteps'] = updates.nextStep;
  if (updates.subtaskStatus) {
    $set[`subtaskProgress.${updates.subtaskStatus.id}`] = updates.subtaskStatus.status;
  }
  if (updates.currentPhase) $set['currentPhase'] = updates.currentPhase;
  if (updates.goalContractId) $set['goalContractId'] = updates.goalContractId;

  const updateOp: Record<string, any> = { $set, $inc: { version: 1 } };
  if (Object.keys($push).length > 0) updateOp['$push'] = $push;

  // `upsert`, because nothing ever creates the document.
  //
  // `saveCheckpoint` is the only writer that upserts, and it has ZERO callers
  // outside this module. Both real callers — `subtask-executor` and
  // `generate-with-harness` — use this function, so every append matched no
  // document and did nothing: no error, no warning, no row. The reader
  // (`context-assembler` → `loadCheckpoint`) then found nothing, every time.
  //
  // Measured: after `appendToCheckpoint(task, { decision, fileModified,
  // nextStep })`, `context_checkpoints` held 0 documents. A checkpoint that
  // records the first decision of a task is exactly the one worth having.
  await db.collection(COLLECTION).updateOne({ taskId }, updateOp, { upsert: true });
}

/**
 * Format checkpoint as a compact context string for prompt injection.
 * Token-efficient — only includes non-empty sections.
 */
export function formatCheckpointForPrompt(checkpoint: TaskCheckpoint): string {
  const sections: string[] = [];

  sections.push(`## Session Resume — Task Checkpoint (v${checkpoint.version})`);
  sections.push(`**Goal:** ${checkpoint.goal}`);
  sections.push(`**Last saved:** ${checkpoint.savedAt}`);
  if (checkpoint.goalContractId) {
    sections.push(`**GoalContract:** ${checkpoint.goalContractId}`);
  }

  if (checkpoint.currentPhase) {
    sections.push(`**Current phase:** ${checkpoint.currentPhase}`);
  }

  if (checkpoint.decisionsLog.length > 0) {
    // Only last 5 decisions to save tokens
    const recent = checkpoint.decisionsLog.slice(-5);
    sections.push(`\n### Key Decisions (last ${recent.length}):`);
    recent.forEach((d) => sections.push(`- ${d}`));
  }

  if (checkpoint.filesModified.length > 0) {
    const unique = [...new Set(checkpoint.filesModified)];
    sections.push(`\n### Files Modified (${unique.length}):`);
    unique.forEach((f) => sections.push(`- ${f}`));
  }

  if (checkpoint.knownIssues.length > 0) {
    sections.push(`\n### Known Issues:`);
    checkpoint.knownIssues.forEach((i) => sections.push(`- ⚠️ ${i}`));
  }

  const subtaskEntries = Object.entries(checkpoint.subtaskProgress);
  if (subtaskEntries.length > 0) {
    const done = subtaskEntries.filter(([, s]) => s === 'done').length;
    const total = subtaskEntries.length;
    sections.push(`\n### Subtask Progress: ${done}/${total} complete`);
    subtaskEntries.forEach(([id, status]) => {
      const icon = status === 'done' ? '✅' : status === 'failed' ? '❌' : status === 'skipped' ? '⏭️' : '⏳';
      sections.push(`- ${icon} ${id}: ${status}`);
    });
  }

  if (checkpoint.nextSteps.length > 0) {
    sections.push(`\n### Next Steps:`);
    checkpoint.nextSteps.slice(-3).forEach((s, i) => sections.push(`${i + 1}. ${s}`));
  }

  return sections.join('\n');
}

/**
 * List all active checkpoints (for diagnostics).
 */
export async function listCheckpoints(): Promise<Array<{ taskId: string; goal: string; savedAt: string; version: number }>> {
  await ensureIndexes();
  const db = await getDb();

  const docs = await db.collection(COLLECTION)
    .find({}, { projection: { taskId: 1, goal: 1, savedAt: 1, version: 1 } })
    .sort({ savedAt: -1 })
    .limit(20)
    .toArray();

  return docs.map((d) => ({
    taskId: d.taskId,
    goal: d.goal ?? '',
    savedAt: d.savedAt ?? '',
    version: d.version ?? 1,
  }));
}
