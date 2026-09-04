/**
 * Transaction runner for the durable orchestration substrate.
 *
 * Generalizes the GAP-TXN-01 spike learning into a reusable primitive:
 * snapshot + majority transactions, bounded retry on `TransientTransactionError`
 * with jitter, and a retry counter so the caller can surface hot-document
 * contention as a backpressure signal (§16.2), not an infinite retry.
 *
 * Requires a replica set (verified viable in `GAP-TXN-01`). Also provides a
 * canonical hash used for command idempotency (`ORC-TXN-COMMAND-01`).
 */
import { createHash } from 'node:crypto';
import type { ClientSession, MongoClient, TransactionOptions } from 'mongodb';

const DEFAULT_TXN_OPTS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

export interface TxnResult<T> {
  value: T;
  /** Body restarts + same-transaction commit retries (0 = clean). */
  retries: number;
}

export class BoundaryRetryExhaustedError extends Error {
  constructor(readonly retries: number, readonly cause: unknown) {
    super(`transaction retry budget exhausted after ${retries} transient retries`);
    this.name = 'BoundaryRetryExhaustedError';
  }
}

function hasLabel(err: unknown, label: string): boolean {
  return typeof (err as { hasErrorLabel?: (l: string) => boolean })?.hasErrorLabel === 'function'
    && (err as { hasErrorLabel: (l: string) => boolean }).hasErrorLabel(label);
}

/** A duplicate-key error is a real conflict, not a transient one — never retried. */
export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/**
 * Run `fn` inside a transaction with the MongoDB retry split:
 * - `TransientTransactionError` restarts the whole transaction callback;
 * - `UnknownTransactionCommitResult` retries commit on the SAME transaction.
 *
 * Re-running the callback after an unknown commit can duplicate non-idempotent
 * decisions (notably a lease claim), so these labels must never be conflated.
 */
export async function runTxn<T>(
  client: MongoClient,
  fn: (session: ClientSession) => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; txn?: TransactionOptions } = {},
): Promise<TxnResult<T>> {
  const maxRetries = opts.maxRetries ?? 50;
  const baseDelayMs = opts.baseDelayMs ?? 2;
  const session = client.startSession();
  let retries = 0;
  const backoff = async () => {
    const jitter = baseDelayMs * (1 + Math.random()) * Math.min(retries, 8);
    await new Promise((resolve) => setTimeout(resolve, jitter));
  };
  try {
    transactionLoop: for (;;) {
      session.startTransaction(opts.txn ?? DEFAULT_TXN_OPTS);
      let value: T;
      try {
        value = await fn(session);
      } catch (err) {
        try { await session.abortTransaction(); } catch { /* already aborted */ }
        const transient = hasLabel(err, 'TransientTransactionError');
        if (transient && retries < maxRetries) {
          retries++;
          await backoff();
          continue;
        }
        if (transient) throw new BoundaryRetryExhaustedError(retries, err);
        throw err;
      }

      for (;;) {
        try {
          await session.commitTransaction();
          return { value, retries };
        } catch (err) {
          if (hasLabel(err, 'UnknownTransactionCommitResult')) {
            if (retries >= maxRetries) throw new BoundaryRetryExhaustedError(retries, err);
            retries++;
            await backoff();
            continue;
          }

          try { await session.abortTransaction(); } catch { /* already aborted */ }
          if (hasLabel(err, 'TransientTransactionError')) {
            if (retries >= maxRetries) throw new BoundaryRetryExhaustedError(retries, err);
            retries++;
            await backoff();
            continue transactionLoop;
          }
          throw err;
        }
      }
    }
  } finally {
    await session.endSession();
  }
}

/** Deterministic stringify with sorted object keys for stable hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Canonical `sha256:...` hash of a command payload for idempotency. */
export function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}
