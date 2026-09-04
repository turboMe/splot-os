/**
 * Idempotency — dedup for tools with side effects (Etap 5, §3.3).
 *
 * A retry of the same operation (same tool + same input, or an explicit key)
 * must NOT execute the side effect twice — no duplicate n8n webhook trigger,
 * no duplicate Gmail draft, no duplicate lead. The first successful run's
 * result is cached in Mongo `idempotency_keys` and replayed on repeat.
 *
 * Key = explicit `key` (e.g. laneId+step) OR sha256(toolId + canonical input).
 * Records carry a TTL; a stale/in-progress record does not block forever.
 * Fail-open: any store error runs the operation normally (never blocks work).
 */

import { createHash } from 'crypto';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';

const COLLECTION = 'idempotency_keys';
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
/** An in-progress record older than this is treated as abandoned. */
const INFLIGHT_STALE_MS = 5 * 60 * 1000;

type IdempotencyRecord = {
  key: string;
  toolId: string;
  status: 'in_progress' | 'done';
  result?: unknown;
  startedAt: Date;
  completedAt?: Date;
  expiresAt: Date;
};

export function isIdempotencyEnabled(): boolean {
  return isHarnessFeatureEnabled('FEATURE_IDEMPOTENCY', true);
}

let indexEnsured: Promise<void> | null = null;
async function ensureIndex(): Promise<void> {
  indexEnsured ??= (async () => {
    const db = await getDb();
    const col = db.collection<IdempotencyRecord>(COLLECTION);
    await col.createIndex({ key: 1 }, { unique: true });
    await col.createIndex({ expiresAt: 1 });
  })().catch((err) => {
    indexEnsured = null;
    console.warn('[Idempotency] ensureIndex failed:', (err as Error).message);
  }) as Promise<void>;
  await indexEnsured;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function computeIdempotencyKey(toolId: string, input: unknown, explicit?: string): string {
  if (explicit) return `${toolId}:${explicit}`;
  return `${toolId}:${createHash('sha256').update(canonical(input)).digest('hex').slice(0, 32)}`;
}

export type IdempotentOutcome<T> = { result: T; replayed: boolean };

/**
 * Run `fn` at most once per key. On a repeat call with a cached 'done' record,
 * returns the stored result WITHOUT running `fn` again. Concurrent duplicates
 * short-circuit only after the first completes; an in-progress record older
 * than INFLIGHT_STALE_MS is taken over.
 *
 * Only successful results are cached. If `isSuccess(result)` is false, the
 * record is cleared so a genuine retry can run — a failed webhook should be
 * retryable, only a SUCCESSFUL side effect must not repeat.
 */
export async function withIdempotency<T>(
  input: {
    toolId: string;
    input: unknown;
    explicitKey?: string;
    ttlMs?: number;
    isSuccess?: (result: T) => boolean;
  },
  fn: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  if (!isIdempotencyEnabled()) {
    return { result: await fn(), replayed: false };
  }

  const key = computeIdempotencyKey(input.toolId, input.input, input.explicitKey);
  let db;
  try {
    await ensureIndex();
    db = await getDb();
  } catch {
    return { result: await fn(), replayed: false }; // fail-open
  }
  const col = db.collection<IdempotencyRecord>(COLLECTION);
  const now = new Date();

  // Fast path — cached success.
  const existing = await col.findOne({ key }).catch(() => null);
  if (existing?.status === 'done') {
    return { result: existing.result as T, replayed: true };
  }

  // Try to claim the key. Upsert a fresh in_progress record unless a recent
  // in-progress one already exists.
  const inflightCutoff = new Date(now.getTime() - INFLIGHT_STALE_MS);
  try {
    const claim = await col.findOneAndUpdate(
      { key, $or: [{ status: { $ne: 'in_progress' } }, { startedAt: { $lt: inflightCutoff } }] },
      {
        $set: { toolId: input.toolId, status: 'in_progress', startedAt: now, expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)) },
        $unset: { result: '', completedAt: '' },
      },
      { upsert: true, returnDocument: 'after' },
    );
    void claim;
  } catch {
    // Another caller holds a fresh in-progress claim — re-check for its result.
    const done = await col.findOne({ key }).catch(() => null);
    if (done?.status === 'done') return { result: done.result as T, replayed: true };
    // Still in progress and we cannot dedup safely → fail-open (run once).
    return { result: await fn(), replayed: false };
  }

  // We hold the claim — run the side effect.
  const result = await fn();
  const success = input.isSuccess ? input.isSuccess(result) : defaultIsSuccess(result);
  if (success) {
    await col.updateOne({ key }, { $set: { status: 'done', result, completedAt: new Date() } }).catch(() => undefined);
  } else {
    await col.deleteOne({ key }).catch(() => undefined); // allow genuine retry
  }
  return { result, replayed: false };
}

function defaultIsSuccess(result: unknown): boolean {
  if (result && typeof result === 'object' && 'success' in result) {
    return (result as { success: unknown }).success === true;
  }
  return true;
}
