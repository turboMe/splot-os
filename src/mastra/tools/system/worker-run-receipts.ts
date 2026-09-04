import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';

import { getDb } from '../../lib/mongo.js';
import { workerTaskSpecSchema, type WorkerTaskSpecInput } from './worker-task-spec.js';

export type WorkerRunCorrelation = {
  domain: string;
  entityId: string;
  action: string;
  subjectId?: string;
  contractRevision?: number;
  requestId?: string;
};

type WorkerReviewRequest = {
  requestId: string;
  preset: string;
  correlation: WorkerRunCorrelation & { requestId: string };
  taskSpecHash: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt?: Date;
  claimedBy?: string;
};

type WorkerRunReceipt = {
  workerRunId: string;
  preset: string;
  correlation: WorkerRunCorrelation;
  trustedRequestId?: string;
  outputHash: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  consumedBy?: string;
};

const COLLECTION = 'worker_run_receipts';
const REQUEST_COLLECTION = 'worker_review_requests';
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 60 * 60 * 1000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function workerTaskSpecHash(taskSpec: WorkerTaskSpecInput): string {
  const normalized = workerTaskSpecSchema.parse(taskSpec);
  return createHash('sha256').update(JSON.stringify(stableValue(normalized))).digest('hex');
}

export function workerOutputHash(output: string): string {
  return createHash('sha256').update(output).digest('hex');
}

export async function issueWorkerReviewRequest(params: {
  preset: string;
  correlation: Omit<WorkerRunCorrelation, 'requestId'>;
  taskSpec: WorkerTaskSpecInput;
}): Promise<{ requestId: string; taskSpec: WorkerTaskSpecInput }> {
  const db = await getDb();
  const now = new Date();
  const requestId = randomUUID();
  const correlation = { ...params.correlation, requestId };
  const taskSpec = workerTaskSpecSchema.parse({ ...params.taskSpec, correlation });
  const request: WorkerReviewRequest = {
    requestId,
    preset: params.preset,
    correlation,
    taskSpecHash: workerTaskSpecHash(taskSpec),
    createdAt: now,
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
  };
  await db.collection<WorkerReviewRequest>(REQUEST_COLLECTION).insertOne(request);
  return { requestId, taskSpec };
}

export async function claimWorkerReviewRequest(params: {
  workerRunId: string;
  preset: string;
  correlation: WorkerRunCorrelation;
  taskSpec: WorkerTaskSpecInput;
}): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const requestId = params.correlation.requestId;
  if (!requestId) {
    return { ok: false, error: 'Writer worker review is missing its prepared requestId.' };
  }
  const db = await getDb();
  const now = new Date();
  const claimed = await db.collection<WorkerReviewRequest>(REQUEST_COLLECTION).findOneAndUpdate(
    {
      requestId,
      preset: params.preset,
      'correlation.domain': params.correlation.domain,
      'correlation.entityId': params.correlation.entityId,
      'correlation.action': params.correlation.action,
      ...(params.correlation.subjectId
        ? { 'correlation.subjectId': params.correlation.subjectId }
        : {}),
      ...(params.correlation.contractRevision !== undefined
        ? { 'correlation.contractRevision': params.correlation.contractRevision }
        : {}),
      taskSpecHash: workerTaskSpecHash(params.taskSpec),
      claimedAt: { $exists: false },
      expiresAt: { $gt: now },
    },
    { $set: { claimedAt: now, claimedBy: params.workerRunId } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    return {
      ok: false,
      error: 'Writer worker task does not match a live, unclaimed writer_prepare_worker_review request.',
    };
  }
  return { ok: true, requestId };
}

export async function recordSuccessfulWorkerRunReceipt(params: {
  workerRunId: string;
  preset: string;
  correlation: WorkerRunCorrelation;
  output: string;
  trustedRequestId?: string;
}): Promise<{ outputHash: string }> {
  const db = await getDb();
  const now = new Date();
  if (params.trustedRequestId) {
    const trustedRequest = await db.collection<WorkerReviewRequest>(REQUEST_COLLECTION).findOne({
      requestId: params.trustedRequestId,
      preset: params.preset,
      'correlation.domain': params.correlation.domain,
      'correlation.entityId': params.correlation.entityId,
      'correlation.action': params.correlation.action,
      ...(params.correlation.subjectId
        ? { 'correlation.subjectId': params.correlation.subjectId }
        : {}),
      ...(params.correlation.contractRevision !== undefined
        ? { 'correlation.contractRevision': params.correlation.contractRevision }
        : {}),
      claimedBy: params.workerRunId,
      claimedAt: { $type: 'date' },
      expiresAt: { $gt: now },
    });
    if (!trustedRequest) {
      throw new Error('trustedRequestId does not belong to this claimed worker review request.');
    }
  }
  const outputHash = workerOutputHash(params.output);
  const receipt: WorkerRunReceipt = {
    workerRunId: params.workerRunId,
    preset: params.preset,
    correlation: params.correlation,
    trustedRequestId: params.trustedRequestId,
    outputHash,
    createdAt: now,
    expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS),
  };
  await db.collection<WorkerRunReceipt>(COLLECTION).updateOne(
    { workerRunId: params.workerRunId },
    { $setOnInsert: receipt },
    { upsert: true },
  );
  return { outputHash };
}

/**
 * Atomically consumes one successful worker result for exactly one domain
 * audit. The caller must present the original output, so a parent cannot attach
 * a passing verdict to a different or hand-written response.
 */
export async function claimSuccessfulWorkerRunReceipt(params: {
  workerRunId: string;
  preset: string;
  correlation: WorkerRunCorrelation;
  output: string;
  consumedBy: string;
  session?: ClientSession;
}): Promise<{ ok: true; outputHash: string; subjectId?: string } | { ok: false; error: string }> {
  const db = await getDb();
  const now = new Date();
  const outputHash = workerOutputHash(params.output);
  const claimed = await db.collection<WorkerRunReceipt>(COLLECTION).findOneAndUpdate(
    {
      workerRunId: params.workerRunId,
      preset: params.preset,
      'correlation.domain': params.correlation.domain,
      'correlation.entityId': params.correlation.entityId,
      'correlation.action': params.correlation.action,
      ...(params.correlation.subjectId
        ? { 'correlation.subjectId': params.correlation.subjectId }
        : {}),
      ...(params.correlation.contractRevision !== undefined
        ? { 'correlation.contractRevision': params.correlation.contractRevision }
        : {}),
      trustedRequestId: { $type: 'string' },
      outputHash,
      consumedAt: { $exists: false },
      expiresAt: { $gt: now },
    },
    { $set: { consumedAt: now, consumedBy: params.consumedBy } },
    { returnDocument: 'after', session: params.session },
  );
  if (!claimed) {
    return {
      ok: false,
      error: 'No live, unconsumed worker receipt matches this project, role, preset and exact output.',
    };
  }
  return { ok: true, outputHash, subjectId: claimed.correlation.subjectId };
}
