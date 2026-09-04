#!/usr/bin/env tsx
/**
 * check:orchestration-store — pure-unit coverage for the durable store logic
 * that needs NO database (so it can run in check:all; the transactional e2e
 * `e2e:orchestration-command-boundary` needs a replica set and runs separately).
 *
 * Covers: canonical command hashing (idempotency key stability), the skeleton
 * reducer decisions, and error classifiers.
 */
import assert from 'node:assert/strict';
import type { ClientSession, MongoClient } from 'mongodb';
import { canonicalHash, isDuplicateKeyError, runTxn } from '../orchestration/store/index.js';
import { readyReducer } from '../orchestration/store/lane.js';
import type { JobDoc } from '../orchestration/store/index.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).stack ?? (err as Error).message}`); }
}

console.log('check:orchestration-store');

check('canonicalHash is stable across key order (idempotency key)', () => {
  const a = canonicalHash({ op: 'x', nested: { b: 1, a: 2 }, list: [1, 2] });
  const b = canonicalHash({ list: [1, 2], nested: { a: 2, b: 1 }, op: 'x' });
  assert.equal(a, b);
  assert.ok(a.startsWith('sha256:'));
});

check('canonicalHash differs on value change and on array order', () => {
  assert.notEqual(canonicalHash({ op: 'x' }), canonicalHash({ op: 'y' }));
  assert.notEqual(canonicalHash({ l: [1, 2] }), canonicalHash({ l: [2, 1] }));
});

check('readyReducer: ACCEPTED → READY/JobReady, else null', () => {
  const base = { _id: 'job_1', resourceId: 'r', conversationId: 'c', controlState: 'NONE', terminalOutcome: null, stateVersion: 0, goal: 'g', createdAt: new Date(), updatedAt: new Date() } as const;
  const accepted = readyReducer({ ...base, phase: 'ACCEPTED' } as JobDoc);
  assert.equal(accepted?.nextPhase, 'READY');
  assert.equal(accepted?.eventType, 'JobReady');
  assert.equal(readyReducer({ ...base, phase: 'READY' } as JobDoc), null);
  assert.equal(readyReducer({ ...base, phase: 'TERMINAL' } as JobDoc), null);
});

check('isDuplicateKeyError classifies E11000 only', () => {
  assert.equal(isDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isDuplicateKeyError({ code: 112 }), false); // WriteConflict
  assert.equal(isDuplicateKeyError(new Error('nope')), false);
  assert.equal(isDuplicateKeyError(null), false);
});

function labelledError(label: string): Error & { hasErrorLabel: (candidate: string) => boolean } {
  return Object.assign(new Error(label), {
    hasErrorLabel: (candidate: string) => candidate === label,
  });
}

async function main(): Promise<void> {
  await checkAsync('runTxn retries unknown commit on the same transaction without rerunning the body', async () => {
    let starts = 0;
    let bodies = 0;
    let commits = 0;
    let aborts = 0;
    let ended = 0;
    const session = {
      startTransaction: () => { starts++; },
      commitTransaction: async () => {
        commits++;
        if (commits === 1) throw labelledError('UnknownTransactionCommitResult');
      },
      abortTransaction: async () => { aborts++; },
      endSession: async () => { ended++; },
    } as unknown as ClientSession;
    const client = {
      startSession: () => session,
    } as unknown as MongoClient;

    const result = await runTxn(
      client,
      async (seenSession) => {
        bodies++;
        assert.equal(seenSession, session);
        return 'committed';
      },
      { maxRetries: 2, baseDelayMs: 0 },
    );
    assert.equal(result.value, 'committed');
    assert.equal(result.retries, 1);
    assert.equal(starts, 1);
    assert.equal(bodies, 1);
    assert.equal(commits, 2);
    assert.equal(aborts, 0);
    assert.equal(ended, 1);
  });

  await checkAsync('runTxn restarts the body only for a transient transaction error', async () => {
    let starts = 0;
    let bodies = 0;
    let commits = 0;
    let aborts = 0;
    const session = {
      startTransaction: () => { starts++; },
      commitTransaction: async () => { commits++; },
      abortTransaction: async () => { aborts++; },
      endSession: async () => {},
    } as unknown as ClientSession;
    const client = {
      startSession: () => session,
    } as unknown as MongoClient;

    const result = await runTxn(
      client,
      async () => {
        bodies++;
        if (bodies === 1) throw labelledError('TransientTransactionError');
        return 42;
      },
      { maxRetries: 2, baseDelayMs: 0 },
    );
    assert.equal(result.value, 42);
    assert.equal(result.retries, 1);
    assert.equal(starts, 2);
    assert.equal(bodies, 2);
    assert.equal(commits, 1);
    assert.equal(aborts, 1);
  });

  if (failures > 0) {
    console.error(`\n❌ check:orchestration-store — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:orchestration-store — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(`check failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
