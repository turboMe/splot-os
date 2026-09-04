/**
 * File activity ledger for coding tools.
 *
 * The ledger is a soft-warning system: failures here must never block file
 * reads, writes, tests, or merges. It helps parallel subtasks notice when they
 * are touching the same file before conflicts show up in git.
 */

import { randomUUID } from 'crypto';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { logHarnessEvent } from './harness-events.js';
import { queuePendingMessage } from './pending-message-queue.js';

export type FileActivityOp = 'read' | 'write' | 'edit' | 'patch' | 'delete' | 'test';

export type FileActivityInput = {
  taskId: string;
  subtaskId?: string;
  agentId?: string;
  threadId?: string;
  file?: string;
  op: FileActivityOp;
  lineStart?: number;
  lineEnd?: number;
  summary?: string;
  diffPreview?: string;
};

export type FileActivity = Required<Pick<FileActivityInput, 'taskId' | 'agentId' | 'op'>> & {
  id: string;
  subtaskId?: string;
  threadId?: string;
  file?: string;
  actorKey: string;
  lineStart?: number;
  lineEnd?: number;
  summary?: string;
  diffPreview?: string;
  createdAt: Date;
  expiresAt: Date;
};

export type FileOverlapKind = 'overlapping_lines' | 'same_file_non_overlapping' | 'same_file';

const COLLECTION = 'file_activity';
const ACTIVITY_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_PEER_WINDOW_MS = 2 * 3600 * 1000;
const WRITE_OPS = new Set<FileActivityOp>(['write', 'edit', 'patch', 'delete']);

export async function recordFileActivity(input: FileActivityInput): Promise<void> {
  if (!isHarnessFeatureEnabled('FEATURE_FILE_ACTIVITY_LEDGER', false)) return;

  try {
    const db = await getDb();
    const now = new Date();
    const agentId = input.agentId ?? 'codingAgent';
    const doc: FileActivity = {
      id: randomUUID(),
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      agentId,
      threadId: input.threadId,
      file: normalizeFile(input.file),
      actorKey: actorKey(agentId, input.subtaskId),
      op: input.op,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      summary: input.summary,
      diffPreview: input.diffPreview ? truncate(input.diffPreview, 2000) : undefined,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ACTIVITY_TTL_MS),
    };

    await db.collection<FileActivity>(COLLECTION).insertOne(doc);
    await logHarnessEvent({
      type: 'file_touch',
      agentId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'file_activity_ledger',
      status: 'success',
      toolId: `file_activity:${input.op}`,
      data: {
        file: doc.file,
        op: doc.op,
        lineStart: doc.lineStart,
        lineEnd: doc.lineEnd,
        summary: doc.summary,
      },
    });
  } catch (error) {
    console.warn('[FileActivity] record failed:', (error as Error).message);
  }
}

export async function findPeerTouches(input: {
  taskId: string;
  file: string;
  currentAgentId?: string;
  currentSubtaskId?: string;
  sinceMs?: number;
  includeReads?: boolean;
}): Promise<FileActivity[]> {
  if (!isHarnessFeatureEnabled('FEATURE_FILE_ACTIVITY_LEDGER', false)) return [];

  try {
    const db = await getDb();
    const file = normalizeFile(input.file);
    if (!file) return [];

    const since = new Date(Date.now() - (input.sinceMs ?? DEFAULT_PEER_WINDOW_MS));
    const currentActorKey = input.currentAgentId
      ? actorKey(input.currentAgentId, input.currentSubtaskId)
      : undefined;

    const query: Record<string, unknown> = {
      taskId: input.taskId,
      file,
      createdAt: { $gte: since },
      expiresAt: { $gt: new Date() },
    };
    if (!input.includeReads) {
      query.op = { $in: [...WRITE_OPS] };
    }
    if (currentActorKey) {
      query.actorKey = { $ne: currentActorKey };
    }

    return await db
      .collection<FileActivity>(COLLECTION)
      .find(query)
      .sort({ createdAt: -1 })
      .limit(8)
      .toArray();
  } catch (error) {
    console.warn('[FileActivity] peer lookup failed:', (error as Error).message);
    return [];
  }
}

export function detectLineOverlap(
  current: Pick<FileActivityInput, 'lineStart' | 'lineEnd'>,
  peer: Pick<FileActivity, 'lineStart' | 'lineEnd'>,
): FileOverlapKind {
  const currentHasLines = typeof current.lineStart === 'number' && typeof current.lineEnd === 'number';
  const peerHasLines = typeof peer.lineStart === 'number' && typeof peer.lineEnd === 'number';
  if (!currentHasLines || !peerHasLines) return 'same_file';

  const aStart = Math.min(current.lineStart!, current.lineEnd!);
  const aEnd = Math.max(current.lineStart!, current.lineEnd!);
  const bStart = Math.min(peer.lineStart!, peer.lineEnd!);
  const bEnd = Math.max(peer.lineStart!, peer.lineEnd!);
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd)
    ? 'overlapping_lines'
    : 'same_file_non_overlapping';
}

export function formatFileConflictWarning(
  current: FileActivityInput,
  peers: FileActivity[],
): string {
  if (peers.length === 0) return '';

  const file = normalizeFile(current.file) ?? current.file ?? '(unknown file)';
  const lines = peers.slice(0, 5).map((peer) => {
    const overlap = detectLineOverlap(current, peer);
    const actor = peer.subtaskId
      ? `subtask ${peer.subtaskId}`
      : `agent ${peer.agentId}`;
    const lineScope = peer.lineStart && peer.lineEnd
      ? ` lines ${peer.lineStart}-${peer.lineEnd}`
      : '';
    const age = formatAge(Date.now() - new Date(peer.createdAt).getTime());
    const summary = peer.summary ? `: ${peer.summary}` : '';
    return `- \`${file}\` had ${peer.op}${lineScope} by ${actor} ${age} ago (${overlap})${summary}`;
  });

  return [
    'File activity warning:',
    ...lines,
    'Review the latest file contents before continuing.',
  ].join('\n');
}

export async function getFileActivityWarning(input: FileActivityInput): Promise<string> {
  const file = normalizeFile(input.file);
  if (!file || !WRITE_OPS.has(input.op)) return '';

  const peers = await findPeerTouches({
    taskId: input.taskId,
    file,
    currentAgentId: input.agentId,
    currentSubtaskId: input.subtaskId,
  });
  const warning = formatFileConflictWarning({ ...input, file }, peers);
  if (warning) {
    await logHarnessEvent({
      type: 'file_conflict_warning',
      agentId: input.agentId ?? 'codingAgent',
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'file_activity_ledger',
      status: 'success',
      output: warning,
      data: {
        file,
        op: input.op,
        peerCount: peers.length,
        peerIds: peers.map((peer) => peer.id),
      },
    });
    await queuePendingMessage({
      taskId: input.taskId,
      threadId: input.threadId,
      targetAgentId: input.agentId ?? 'codingAgent',
      source: 'file_activity',
      content: warning,
      urgent: false,
      metadata: {
        file,
        op: input.op,
        peerCount: peers.length,
        peerIds: peers.map((peer) => peer.id),
      },
    });
  }
  return warning;
}

function actorKey(agentId: string, subtaskId?: string): string {
  return subtaskId ? `${agentId}:${subtaskId}` : agentId;
}

function normalizeFile(file: string | undefined): string | undefined {
  const normalized = file?.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized || undefined;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'moments';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'moments';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
