import { exec } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import {
  getWorkspacePath,
  getWorkspacePathForWrite,
  acquireWorkspaceFileWriteLock,
  releaseWorkspaceFileLock,
} from '../../workspaces/code-workspace.js';
import { getFileActivityWarning, recordFileActivity } from '../../services/file-activity.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import {
  requireCodingTaskId,
  normalizeCodingScope,
  appendScopeNote,
} from './coding-task-scope.js';
import {
  assertSubtaskArtifactMutationMatched,
  currentSubtaskArtifactLease,
  subtaskArtifactMutationFilter,
} from '../../services/subtask-artifact-fence.js';

const execAsync = promisify(exec);

const SNAPSHOT_STATUSES = ['open', 'accepted', 'rejected', 'conflict'] as const;
const MISSING_HASH = 'missing';
const MAX_SNAPSHOT_BYTES = 2_000_000;
const TRACKED_WRITE_TSC_TIMEOUT_MS = 60_000;

const snapshotOutputSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  path: z.string(),
  beforeHash: z.string(),
  afterHash: z.string().optional(),
  status: z.enum(SNAPSHOT_STATUSES),
  summary: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type SnapshotDoc = {
  id: string;
  taskId: string;
  path: string;
  beforeHash: string;
  beforeContent: string;
  beforeExists: boolean;
  afterHash?: string;
  afterContent?: string;
  afterExists?: boolean;
  status: (typeof SNAPSHOT_STATUSES)[number];
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

type FileState = {
  exists: boolean;
  content: string;
  hash: string;
  bytes: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRepoPath(inputPath: string, workspacePath: string): { absolutePath: string; relativePath: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error('Path is required.');

  const relativeCandidate = isAbsolute(trimmed)
    ? relative(workspacePath, trimmed)
    : trimmed;

  const relativePath = normalize(relativeCandidate).replace(/\\/g, '/');
  if (
    relativePath === '.' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Path is outside coding workspace: ${inputPath}`);
  }

  const blockedRoots = ['.git', 'node_modules'];
  if (
    blockedRoots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`)) ||
    relativePath === '.env' ||
    relativePath.startsWith('.env.')
  ) {
    throw new Error(`Path is blocked for coding ledger: ${relativePath}`);
  }

  const absolutePath = resolve(workspacePath, relativePath);
  const repoWithSep = workspacePath.endsWith(sep) ? workspacePath : `${workspacePath}${sep}`;
  if (absolutePath !== workspacePath && !absolutePath.startsWith(repoWithSep)) {
    throw new Error(`Path is outside coding workspace: ${inputPath}`);
  }

  return { absolutePath, relativePath };
}

async function readFileState(absolutePath: string): Promise<FileState> {
  try {
    const content = await readFile(absolutePath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`File is too large for ledger snapshot (${bytes} bytes).`);
    }
    return {
      exists: true,
      content,
      hash: hashContent(content),
      bytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        exists: false,
        content: '',
        hash: MISSING_HASH,
        bytes: 0,
      };
    }
    throw error;
  }
}

function toSnapshotOutput(snapshot: SnapshotDoc) {
  return {
    id: snapshot.id,
    taskId: snapshot.taskId,
    path: snapshot.path,
    beforeHash: snapshot.beforeHash,
    afterHash: snapshot.afterHash,
    status: snapshot.status,
    summary: snapshot.summary,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

/**
 * Record one file change on the task artifact — atomically, and attributed to
 * the subtask that made it (J2 step 1).
 *
 * WHY NOT THE OBVIOUS READ-MODIFY-WRITE
 * -------------------------------------
 * This used to `findOne` the artifact, rebuild `filesChanged` in memory, and
 * `$set` THE WHOLE ARRAY back. That is a lost-update race, and subtasks in one
 * parallel group hit it by construction: `parallel-dispatch.ts` runs a group
 * through `Promise.allSettled`, so two `file-editor`s writing different files
 * both read the same array and both overwrite it — last writer wins, and the
 * other subtask's file silently vanishes from the record.
 *
 * Measured 2026-08-23 on the rs3f8 set with a verbatim copy of the old body:
 * 8 concurrent writers to 8 DIFFERENT paths left **1** entry. 7 lost, 3/3 runs.
 * (Saturated worst case — real writes are spaced by model latency — but the
 * window is real and widens with fan-out.)
 *
 * `$pull` + `$push` touch only the element at stake, so writers to different
 * paths never interfere. Two ops rather than one because MongoDB refuses both
 * operators on the same field in a single update; the gap between them can only
 * ever affect the ONE path being rewritten, never a peer's.
 *
 * WHY `subtaskId` IS RECORDED HERE
 * --------------------------------
 * The caller already knows it — it passes `context.subtaskId` to
 * `recordFileActivity` a few lines below, so `file_activity` has always had the
 * attribution. `artifact.filesChanged` is the array the quality gate
 * (`validateSubtaskQuality`) and the conflict detector (`aggregateResults`)
 * actually read, and it was the one place that threw the attribution away.
 * Without it, `collectSubtaskResult` cannot tell a subtask's own work from its
 * neighbour's, so `no_files_changed` never fires once ANY peer wrote something.
 *
 * Optional: entries written before this change have no `subtaskId`, and
 * single-agent (non-dispatch) writes legitimately have none.
 */
async function upsertArtifactFileChange(
  snapshot: SnapshotDoc,
  afterHash: string,
  summary: string,
  subtaskId?: string,
): Promise<void> {
  const db = await getDb();
  const artifacts = db.collection('code_task_artifacts');
  const mutationFilter = subtaskArtifactMutationFilter(snapshot.taskId);

  // Drop any previous entry for THIS path only. `matchedCount` also stands in
  // for the old `findOne`/`if (!artifact) return` existence check, without
  // reading the document.
  const pulled = await artifacts.updateOne(
    mutationFilter,
    { $pull: { filesChanged: { path: snapshot.path } } as never },
  );
  if (pulled.matchedCount === 0) {
    assertSubtaskArtifactMutationMatched(snapshot.taskId, 0, 'replace file change');
    return;
  }

  const pushed = await artifacts.updateOne(
    mutationFilter,
    {
      $push: {
        filesChanged: {
          path: snapshot.path,
          beforeHash: snapshot.beforeHash,
          afterHash,
          summary,
          ...(subtaskId ? { subtaskId } : {}),
        },
      } as never,
      $set: {
        rollbackAvailable: true,
        updatedAt: nowIso(),
      },
    },
  );
  assertSubtaskArtifactMutationMatched(
    snapshot.taskId,
    pushed.matchedCount,
    'append file change',
  );
}

async function rejectSnapshot(snapshot: SnapshotDoc) {
  const db = await getDb();
  const workspacePath = await getWorkspacePath(snapshot.taskId);
  const { absolutePath } = normalizeRepoPath(snapshot.path, workspacePath);
  const current = await readFileState(absolutePath);

  if (!snapshot.afterHash) {
    await db.collection('code_change_snapshots').updateOne(
      { id: snapshot.id },
      { $set: { status: 'rejected', updatedAt: nowIso() } },
    );
    return { path: snapshot.path, status: 'rejected' as const, message: 'Snapshot did not have afterHash; marked as rejected.' };
  }

  if (current.hash !== snapshot.afterHash) {
    await db.collection('code_change_snapshots').updateOne(
      { id: snapshot.id },
      { $set: { status: 'conflict', updatedAt: nowIso(), conflictHash: current.hash } },
    );
    return {
      path: snapshot.path,
      status: 'conflict' as const,
      message: 'File changed after agent work; rollback did not overwrite changes.',
    };
  }

  if (snapshot.beforeExists) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, snapshot.beforeContent, 'utf8');
  } else if (current.exists) {
    await unlink(absolutePath);
  }

  await db.collection('code_change_snapshots').updateOne(
    { id: snapshot.id },
    { $set: { status: 'rejected', rejectedAt: nowIso(), updatedAt: nowIso() } },
  );

  return { path: snapshot.path, status: 'rejected' as const, message: 'Agent change reverted.' };
}

async function acceptSnapshot(snapshot: SnapshotDoc) {
  const db = await getDb();
  const workspacePath = await getWorkspacePath(snapshot.taskId);
  const { absolutePath } = normalizeRepoPath(snapshot.path, workspacePath);
  const current = await readFileState(absolutePath);

  if (snapshot.afterHash && current.hash !== snapshot.afterHash) {
    await db.collection('code_change_snapshots').updateOne(
      { id: snapshot.id },
      { $set: { status: 'conflict', updatedAt: nowIso(), conflictHash: current.hash } },
    );
    return {
      path: snapshot.path,
      status: 'conflict' as const,
      message: 'File changed after agent work; accept_file did not mark snapshot as accepted.',
    };
  }

  await db.collection('code_change_snapshots').updateOne(
    { id: snapshot.id },
    { $set: { status: 'accepted', acceptedAt: nowIso(), updatedAt: nowIso() } },
  );

  return { path: snapshot.path, status: 'accepted' as const, message: 'Change marked as accepted.' };
}

export const recordBeforeChangeTool = createTool({
  id: 'coding_record_before_change',
  description:
    'Saves file snapshot before editing. Call before each write_file, after reading the file with view.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    path: z.string().describe('Path relative to repo or absolute path inside repo.'),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    snapshot: snapshotOutputSchema.optional(),
    message: z.string(),
    fileActivityWarning: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_record_before_change',
    category: 'file',
    risk: 'low',
    normalizeInput: normalizeCodingScope,
    // Tell the MODEL when the run overruled the id it named — see `scopeOverrideNote`.
    modelOutput: appendScopeNote,
    policy: (context, metadata) => ({
      action: 'read_file',
      target: context.path,
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (raw) => {
    // `normalizeInput` already took the scope from the run; resolving again
    // is idempotent and lets the type say what is actually true here.
    const context = { ...raw, taskId: requireCodingTaskId(raw.taskId) };
    try {
      const db = await getDb();
      const workspacePath = await getWorkspacePath(context.taskId);
      const { absolutePath, relativePath } = normalizeRepoPath(context.path, workspacePath);
      await recordFileActivity({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        file: relativePath,
        op: 'read',
        lineStart: context.lineStart,
        lineEnd: context.lineEnd,
        summary: 'Snapshot before change',
      });
      const existing = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (existing) {
        return {
          success: true,
          snapshot: toSnapshotOutput(existing),
          message: `Snapshot before edit already exists for ${relativePath}.`,
        };
      }

      const before = await readFileState(absolutePath);
      const timestamp = nowIso();
      const snapshot: SnapshotDoc = {
        id: randomUUID(),
        taskId: context.taskId,
        path: relativePath,
        beforeHash: before.hash,
        beforeContent: before.content,
        beforeExists: before.exists,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await db.collection('code_change_snapshots').insertOne(snapshot);
      const artifactUpdate = await db.collection('code_task_artifacts').updateOne(
        subtaskArtifactMutationFilter(context.taskId),
        {
          $addToSet: { filesRead: relativePath },
          $set: { updatedAt: timestamp },
        },
      );
      assertSubtaskArtifactMutationMatched(
        context.taskId,
        artifactUpdate.matchedCount,
        'append filesRead snapshot',
      );

      return {
        success: true,
        snapshot: toSnapshotOutput(snapshot),
        message: `Snapshot before edit saved for ${relativePath}.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to save snapshot before edit.',
        error: (error as Error).message,
      };
    }
    },
  }),
});

export const recordAfterChangeTool = createTool({
  id: 'coding_record_after_change',
  description:
    'Saves hash and content after file edit and updates artifact filesChanged. Call after write_file.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    path: z.string(),
    summary: z.string().min(1).describe('Short description of the change in this file.'),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    snapshot: snapshotOutputSchema.optional(),
    message: z.string(),
    fileActivityWarning: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_record_after_change',
    category: 'file',
    risk: 'medium',
    normalizeInput: normalizeCodingScope,
    // Tell the MODEL when the run overruled the id it named — see `scopeOverrideNote`.
    modelOutput: appendScopeNote,
    policy: (context, metadata) => ({
      action: 'write_file',
      target: context.path,
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (raw) => {
    // `normalizeInput` already took the scope from the run; resolving again
    // is idempotent and lets the type say what is actually true here.
    const context = { ...raw, taskId: requireCodingTaskId(raw.taskId) };
    try {
      const db = await getDb();
      const workspacePath = await getWorkspacePathForWrite(context.taskId);
      const { absolutePath, relativePath } = normalizeRepoPath(context.path, workspacePath);
      await acquireWorkspaceFileWriteLock(context.taskId, relativePath, context.agentId);
      const fileActivityWarning = await getFileActivityWarning({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        file: relativePath,
        op: 'edit',
        lineStart: context.lineStart,
        lineEnd: context.lineEnd,
        summary: context.summary,
      });
      const snapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (!snapshot) {
        return {
          success: false,
          message: `Missing before snapshot for ${relativePath}. Call coding.record_before_change first.`,
        };
      }

      const after = await readFileState(absolutePath);
      const updatedSnapshot: SnapshotDoc = {
        ...snapshot,
        afterHash: after.hash,
        afterContent: after.content,
        afterExists: after.exists,
        summary: context.summary,
        status: 'open',
        updatedAt: nowIso(),
      };

      await db.collection('code_change_snapshots').updateOne(
        { id: snapshot.id },
        {
          $set: {
            afterHash: updatedSnapshot.afterHash,
            afterContent: updatedSnapshot.afterContent,
            afterExists: updatedSnapshot.afterExists,
            summary: updatedSnapshot.summary,
            status: updatedSnapshot.status,
            updatedAt: updatedSnapshot.updatedAt,
          },
        },
      );
      await upsertArtifactFileChange(updatedSnapshot, after.hash, context.summary, context.subtaskId);
      await recordFileActivity({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        file: relativePath,
        op: 'edit',
        lineStart: context.lineStart,
        lineEnd: context.lineEnd,
        summary: context.summary,
      });

      return {
        success: true,
        snapshot: toSnapshotOutput(updatedSnapshot),
        message: [
          `Snapshot after edit saved for ${relativePath}.`,
          fileActivityWarning,
        ].filter(Boolean).join('\n\n'),
        fileActivityWarning: fileActivityWarning || undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to save snapshot after edit.',
        error: (error as Error).message,
      };
    }
    },
  }),
});

export const rejectFileChangeTool = createTool({
  id: 'coding_reject_file',
  description:
    'Reverts agent change for a single file, but only if the current file hash still matches the snapshot afterHash.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    path: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    path: z.string(),
    status: z.enum(SNAPSHOT_STATUSES).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const workspacePath = await getWorkspacePath(context.taskId);
      const { relativePath } = normalizeRepoPath(context.path, workspacePath);
      const snapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (!snapshot) {
        return {
          success: false,
          taskId: context.taskId,
          path: relativePath,
          message: `Snapshot for ${relativePath} does not exist.`,
        };
      }

      const result = await rejectSnapshot(snapshot);
      await releaseWorkspaceFileLock(context.taskId, relativePath).catch(() => false);
      return {
        success: result.status === 'rejected',
        taskId: context.taskId,
        path: relativePath,
        status: result.status,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        path: context.path,
        message: 'Failed to revert file change.',
        error: (error as Error).message,
      };
    }
  },
});

export const rejectAllChangesTool = createTool({
  id: 'coding_reject_all',
  description:
    'Reverts all open agent changes for taskId. Each file is reverted only when the current hash matches afterHash.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    rejected: z.number(),
    conflicts: z.number(),
    results: z.array(z.object({
      path: z.string(),
      status: z.enum(['rejected', 'conflict']),
      message: z.string(),
    })),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const snapshots = await db.collection<SnapshotDoc>('code_change_snapshots')
        .find({ taskId: context.taskId, status: 'open' })
        .sort({ updatedAt: -1 })
        .toArray();

      const results = [];
      for (const snapshot of snapshots) {
        results.push(await rejectSnapshot(snapshot));
        await releaseWorkspaceFileLock(context.taskId, snapshot.path).catch(() => false);
      }

      const rejected = results.filter((result) => result.status === 'rejected').length;
      const conflicts = results.filter((result) => result.status === 'conflict').length;

      return {
        success: conflicts === 0,
        taskId: context.taskId,
        rejected,
        conflicts,
        results,
        message: conflicts === 0
          ? `Reverted ${rejected} changes for ${context.taskId}.`
          : `Reverted ${rejected} changes, ${conflicts} files require manual decision.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        rejected: 0,
        conflicts: 0,
        results: [],
        message: 'Failed to revert task changes.',
        error: (error as Error).message,
      };
    }
  },
});

export const acceptFileChangeTool = createTool({
  id: 'coding_accept_file',
  description:
    'Marks a single agent change as accepted, if the current hash still matches afterHash.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    path: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    path: z.string(),
    status: z.enum(SNAPSHOT_STATUSES).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const workspacePath = await getWorkspacePath(context.taskId);
      const { relativePath } = normalizeRepoPath(context.path, workspacePath);
      const snapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (!snapshot) {
        return {
          success: false,
          taskId: context.taskId,
          path: relativePath,
          message: `Snapshot for ${relativePath} does not exist.`,
        };
      }

      const result = await acceptSnapshot(snapshot);
      await releaseWorkspaceFileLock(context.taskId, relativePath).catch(() => false);
      return {
        success: result.status === 'accepted',
        taskId: context.taskId,
        path: relativePath,
        status: result.status,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        path: context.path,
        message: 'Failed to accept file change.',
        error: (error as Error).message,
      };
    }
  },
});

export const acceptAllChangesTool = createTool({
  id: 'coding_accept_all',
  description:
    'Marks all open agent changes for taskId as accepted, if file hashes still match afterHash.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    accepted: z.number(),
    conflicts: z.number(),
    results: z.array(z.object({
      path: z.string(),
      status: z.enum(['accepted', 'conflict']),
      message: z.string(),
    })),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (rawContext) => {
    const context = { ...rawContext, taskId: requireCodingTaskId(rawContext.taskId) };
    try {
      const db = await getDb();
      const snapshots = await db.collection<SnapshotDoc>('code_change_snapshots')
        .find({ taskId: context.taskId, status: 'open' })
        .sort({ updatedAt: -1 })
        .toArray();

      const results = [];
      for (const snapshot of snapshots) {
        results.push(await acceptSnapshot(snapshot));
        await releaseWorkspaceFileLock(context.taskId, snapshot.path).catch(() => false);
      }

      const accepted = results.filter((result) => result.status === 'accepted').length;
      const conflicts = results.filter((result) => result.status === 'conflict').length;

      return {
        success: conflicts === 0,
        taskId: context.taskId,
        accepted,
        conflicts,
        results,
        message: conflicts === 0
          ? `Accepted ${accepted} changes for ${context.taskId}.`
          : `Accepted ${accepted} changes, ${conflicts} files require manual decision.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        accepted: 0,
        conflicts: 0,
        results: [],
        message: 'Failed to accept task changes.',
        error: (error as Error).message,
      };
    }
  },
});

export const writeFileTrackedTool = createTool({
  id: 'coding_write_file_tracked',
  description:
    'Writes file after verifying artifact and automatically adds before/after snapshots for full tracking and rollback capability. Main agent editing tool.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Optional — the RUN owns which task this is. A value supplied here is ignored.'),
    path: z.string().describe('Path relative to repo or absolute path inside repo.'),
    content: z.string().describe('Nowa zawartosc pliku.'),
    summary: z.string().min(1).describe('Short description of the change in this file.'),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    snapshot: snapshotOutputSchema.optional(),
    message: z.string(),
    fileActivityWarning: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_write_file_tracked',
    category: 'file',
    risk: 'medium',
    normalizeInput: normalizeCodingScope,
    // Tell the MODEL when the run overruled the id it named — see `scopeOverrideNote`.
    modelOutput: appendScopeNote,
    redactInputFields: ['content'],
    policy: (context, metadata) => ({
      action: 'write_file',
      target: context.path,
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (raw) => {
    // `normalizeInput` already took the scope from the run; resolving again
    // is idempotent and lets the type say what is actually true here.
    const context = { ...raw, taskId: requireCodingTaskId(raw.taskId) };
    try {
      const db = await getDb();
      
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });
      if (!artifact) {
        return {
          success: false,
          message: `Artifact for task ${context.taskId} does not exist. Create it first via coding.create_artifact.`,
        };
      }

      const workspacePath = await getWorkspacePathForWrite(context.taskId);
      const { absolutePath, relativePath } = normalizeRepoPath(context.path, workspacePath);
      await acquireWorkspaceFileWriteLock(context.taskId, relativePath, context.agentId);
      const fileActivityWarning = await getFileActivityWarning({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        file: relativePath,
        op: 'write',
        lineStart: context.lineStart,
        lineEnd: context.lineEnd,
        summary: context.summary,
      });

      const existingSnapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
        status: 'open',
      });

      const timestamp = nowIso();
      let currentSnapshot: SnapshotDoc;

      if (!existingSnapshot) {
        const before = await readFileState(absolutePath);
        currentSnapshot = {
          id: randomUUID(),
          taskId: context.taskId,
          path: relativePath,
          beforeHash: before.hash,
          beforeContent: before.content,
          beforeExists: before.exists,
          status: 'open',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await db.collection('code_change_snapshots').insertOne(currentSnapshot);
        const artifactUpdate = await db.collection('code_task_artifacts').updateOne(
          subtaskArtifactMutationFilter(context.taskId),
          {
            $addToSet: { filesRead: relativePath },
            $set: { updatedAt: timestamp },
          },
        );
        assertSubtaskArtifactMutationMatched(
          context.taskId,
          artifactUpdate.matchedCount,
          'append tracked-write filesRead',
        );
      } else {
        const { _id, ...rest } = existingSnapshot as any;
        currentSnapshot = rest;
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, context.content, 'utf8');

      const after = await readFileState(absolutePath);
      
      const updatedSnapshot: SnapshotDoc = {
        ...currentSnapshot,
        afterHash: after.hash,
        afterContent: after.content,
        afterExists: after.exists,
        summary: context.summary,
        status: 'open',
        updatedAt: nowIso(),
      };

      await db.collection('code_change_snapshots').updateOne(
        { id: currentSnapshot.id },
        {
          $set: {
            afterHash: updatedSnapshot.afterHash,
            afterContent: updatedSnapshot.afterContent,
            afterExists: updatedSnapshot.afterExists,
            summary: updatedSnapshot.summary,
            status: updatedSnapshot.status,
            updatedAt: updatedSnapshot.updatedAt,
          },
        },
      );
      await upsertArtifactFileChange(updatedSnapshot, after.hash, context.summary, context.subtaskId);
      await recordFileActivity({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        file: relativePath,
        op: 'write',
        lineStart: context.lineStart,
        lineEnd: context.lineEnd,
        summary: context.summary,
      });

      let checkMessage = '';
      const hasSubtaskLease = Boolean(currentSubtaskArtifactLease(context.taskId));
      // A subtask writes into a worktree shared with the rest of its dispatch
      // group. A full-project compiler run here would inspect neighbours' work,
      // multiply the same CPU load per writer and return a task-wide answer to
      // a file-scoped actor. The terminal/qa role verifies after the group.
      if (!hasSubtaskLease && (relativePath.endsWith('.ts') || relativePath.endsWith('.tsx'))) {
        try {
          await execAsync('npx tsc --noEmit', {
            cwd: workspacePath,
            timeout: TRACKED_WRITE_TSC_TIMEOUT_MS,
          });
          checkMessage = ' (tsc passed)';
        } catch (execError: any) {
          const output = [execError.stdout, execError.stderr].filter(Boolean).join('\n');
          const lines = output.split('\n');
          const fileErrors = lines.filter((l: string) => l.includes(relativePath));
          const verificationTimedOut = execError.killed === true
            || execError.signal === 'SIGTERM'
            || execError.code === 'ETIMEDOUT'
            // GNU timeout and deterministic process probes use this status.
            || execError.code === 124;
          if (verificationTimedOut) {
            checkMessage = '\nWARNING: TypeScript verification did not finish before the 60 second timeout; project compilation status is unknown.';
          } else if (fileErrors.length > 0) {
            checkMessage = `\nWARNING: Compilation errors introduced in this file:\n${fileErrors.slice(0, 5).join('\n')}`;
          } else if (output.trim()) {
            checkMessage = '\nWARNING: TypeScript verification found diagnostics outside this file.';
          } else {
            checkMessage = '\nWARNING: TypeScript verification did not finish with a result; project compilation status is unknown.';
          }
        }
      }

      return {
        success: true,
        snapshot: toSnapshotOutput(updatedSnapshot),
        message: [
          `File ${relativePath} was successfully saved and locked in the ledger.${checkMessage}`,
          fileActivityWarning,
        ].filter(Boolean).join('\n\n'),
        fileActivityWarning: fileActivityWarning || undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to write file through tracked write.',
        error: (error as Error).message,
      };
    }
    },
  }),
});
