#!/usr/bin/env tsx
/**
 * check:idempotency-replay — Etap 5 (IDEALSYSTEMMASTERPLAN §3.3).
 *
 * Deterministic assertions on withIdempotency against real Mongo:
 *   - first call runs the effect; a replay with the SAME input returns the
 *     cached result WITHOUT running the effect again (retry never doubles);
 *   - a FAILED result (success:false) is NOT cached → a genuine retry runs;
 *   - different inputs get different keys → both run;
 *   - an explicit key dedups regardless of input;
 *   - FEATURE_IDEMPOTENCY=false → always runs (no dedup).
 *
 * The "effect" is a counter increment — the analogue of "send a draft / trigger
 * a webhook / append an interaction". If the counter goes up twice for one
 * logical operation, the side effect duplicated.
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import { withIdempotency, computeIdempotencyKey } from '../services/idempotency.js';

const TAG = `idem-check-${Date.now()}`;
let failures = 0;

function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection('idempotency_keys').deleteMany({ key: { $regex: TAG } }).catch(() => undefined);
}

async function main(): Promise<void> {
  process.env.FEATURE_IDEMPOTENCY = 'true';
  console.log('check:idempotency-replay');

  await ok('retry with same input does NOT run the effect twice', async () => {
    let effect = 0;
    const input = { toolId: `${TAG}:draft`, input: { to: 'x@y.z', body: 'hello' } };
    const run = () => withIdempotency(input, async () => { effect += 1; return { success: true, draftId: `d${effect}` }; });

    const first = await run();
    const second = await run();
    assert.equal(effect, 1, `effect must run once, ran ${effect} times`);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true, 'second call replayed from cache');
    assert.deepEqual(second.result, first.result, 'replay returns the original result');
  });

  await ok('failed result is not cached → genuine retry runs again', async () => {
    let effect = 0;
    const input = { toolId: `${TAG}:fail`, input: { id: 1 } };
    const run = (succeed: boolean) => withIdempotency(input, async () => { effect += 1; return { success: succeed }; });

    const first = await run(false); // fails
    assert.equal(first.replayed, false);
    const second = await run(true); // retry succeeds — must actually run
    assert.equal(effect, 2, 'failed op is retryable (effect ran twice across a fail then success)');
    assert.equal(second.replayed, false);

    const third = await run(true); // now cached
    assert.equal(effect, 2, 'after success, further retries are deduped');
    assert.equal(third.replayed, true);
  });

  await ok('different inputs get different keys → both run', async () => {
    let effect = 0;
    const mk = (body: string) => withIdempotency(
      { toolId: `${TAG}:multi`, input: { body } },
      async () => { effect += 1; return { success: true }; },
    );
    await mk('a');
    await mk('b');
    assert.equal(effect, 2, 'distinct inputs are not deduped');
  });

  await ok('explicit key dedups regardless of input', async () => {
    let effect = 0;
    const mk = (body: string) => withIdempotency(
      { toolId: `${TAG}:explicit`, input: { body }, explicitKey: 'lane-7-step-2' },
      async () => { effect += 1; return { success: true }; },
    );
    await mk('first body');
    const second = await mk('DIFFERENT body'); // same explicit key → deduped
    assert.equal(effect, 1, 'explicit key dedups even when input differs');
    assert.equal(second.replayed, true);
  });

  await ok('computeIdempotencyKey is stable + order-independent', () => {
    const k1 = computeIdempotencyKey('t', { a: 1, b: 2 });
    const k2 = computeIdempotencyKey('t', { b: 2, a: 1 });
    assert.equal(k1, k2, 'key is canonical (field order independent)');
    const k3 = computeIdempotencyKey('t', { a: 1, b: 3 });
    assert.notEqual(k1, k3);
  });

  await ok('FEATURE_IDEMPOTENCY=false → always runs', async () => {
    process.env.FEATURE_IDEMPOTENCY = 'false';
    let effect = 0;
    const input = { toolId: `${TAG}:off`, input: { x: 1 } };
    await withIdempotency(input, async () => { effect += 1; return { success: true }; });
    await withIdempotency(input, async () => { effect += 1; return { success: true }; });
    assert.equal(effect, 2, 'with idempotency off, every call runs');
    process.env.FEATURE_IDEMPOTENCY = 'true';
  });

  await cleanup();

  if (failures > 0) {
    console.error(`\n❌ check:idempotency-replay — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:idempotency-replay — all assertions passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ check:idempotency-replay crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
