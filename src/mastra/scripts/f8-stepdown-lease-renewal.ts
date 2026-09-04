#!/usr/bin/env tsx
/**
 * f8:stepdown-lease-renewal — an orderly primary handover mid-lease costs the
 * live worker nothing. It does not get fenced out, and it finishes the work.
 *
 * WHY THIS IS A DIFFERENT FAULT FROM `f8:no-duplicate-effect`
 * -------------------------------------------------------------
 * That scenario KILLS the primary: the process dies, connections are refused,
 * and the correct outcome is that the abandoned worker CANNOT come back — its
 * lease is reaped and its fence advances. `rs.stepDown()` is the opposite shape:
 * the node does not die. It keeps running, keeps its data, and keeps answering
 * as a SECONDARY. Nothing here should be fenced, reaped, or refused — the worker
 * that was already leased is still doing legitimate work, and the only thing
 * that changed is which node the driver should talk to for writes. The plan
 * names this precisely: "Sterownik ma wtedy przekierować, a nie zawieść" — the
 * driver must reroute, not fail.
 *
 * WHAT IT PROVES
 * --------------
 *   1. a REAL `rs.stepDown()` actually elects a DIFFERENT node (the old primary
 *      is barred from reclaiming the role for the stepdown window, so a rerun of
 *      this scenario cannot pass by accident on a primary that never moved);
 *   2. the SAME client — connected via the full seed list, never pinned — keeps
 *      renewing the lease through the handover, with no need to reconnect or
 *      re-authenticate. `leaseExpiresAt` advances in the store;
 *   3. the full worker sequence (start → payload ready → submit) commits through
 *      the same handover on the SAME client, and produces exactly one result;
 *   4. contrast, so 2 and 3 are not vacuous: a client wrongly PINNED to the
 *      stepped-down node (via `directConnection`, the same technique
 *      `f8-no-split-brain` uses to reach the dangerous case) cannot itself
 *      complete a write — because it never has anywhere else to go.
 *
 * A GUESS THIS FILE MEASURED AND THREW OUT
 * -----------------------------------------
 * The first version of this scenario assumed the natural falsification was
 * disabling `runTxn`'s transient-restart branch (`txn.ts:74`, the same edit
 * `f8:transient-retry-split` uses) — on the theory that check 3's transactional
 * calls would hit a `TransientTransactionError` mid-handover the same way the
 * synthetic fault does. Measured instead, with a tight loop of 8874 transactions
 * hammered continuously THROUGH a real `rs.stepDown()`: zero retries, zero
 * errors, all 8874 committed. The falsification edit changed NOTHING — check 3
 * stayed green with the retry branch disabled, because that branch never fires.
 * A real orderly stepdown is invisible to `runTxn` end to end: the driver's own
 * topology monitoring and single-shot retryable-write retry absorb it before an
 * error ever reaches application code. That is a stronger property than "we
 * retry correctly" — it is "there is nothing here to retry" — and it would have
 * been reported as false confidence had the edit not been run and checked.
 *
 * WHY CHECK 4 IS THE REAL FALSIFICATION FOR 2 AND 3
 * ---------------------------------------------------
 * Neither guarantee comes from a line of this repo's code — `renewLease`
 * (attempts.ts:855) is a plain `updateOne`, and check 3's `runTxn` calls never
 * even reach their own retry branch (above). Both are owed entirely to the
 * MongoDB driver's topology awareness and default `retryWrites`. So the only
 * honest way to prove checks 2 and 3 are not vacuously true is to show the ONE
 * thing that actually defeats that guarantee: a client that cannot SEE any other
 * node. VERIFIED by running it, not assumed: swapping the shared client for a
 * `directConnection`-pinned one (check 4's technique, `f8-no-split-brain`'s
 * pattern) inside checks 2 and 3 turns them ✗ —
 *
 *     ✗ the SAME client renews the lease [...]: not primary
 *     ✗ start → payload ready → submit [...]: transaction retry budget exhausted
 *     ✗ exactly ONE result exists [...]: exactly one result, found 0
 *
 * — reverted after confirming. That is the real risk this scenario guards
 * against: a future connection helper copy-pasting the pinned pattern (which
 * exists on purpose in this repo's OWN chaos scenarios) into a normal code path.
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 * - Not that ANY of this repo's retry code participates in surviving a stepdown.
 *   Measured above to be false — the whole property rests on the MongoDB driver,
 *   not on `runTxn`. `f8:transient-retry-split` is where that code is exercised
 *   and falsified, against synthetic faults chosen because they DO reach it.
 * - Not `isolate` (the one-way, no-failover partition) and not `kill` (the
 *   election case). Both are different faults with their own scenarios.
 * - Not what happens if the lease is SHORT enough to expire during the handover
 *   — that is `f8:no-duplicate-effect`'s territory (a lease that expires gets
 *   reaped, and the old worker must be refused). This scenario uses a lease long
 *   enough that it never comes close to expiring, on purpose: the property here
 *   is about a topology change, not a race against the clock.
 *
 * FALSIFIED BY (RUN, verified to turn ✗ — see above for what did NOT work):
 * - swapping the shared client for one pinned to the stepped-down node in
 *   checks 2 and 3 — both fail, with the exact messages quoted above.
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:stepdown-lease-renewal
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';

import { connectV2Store } from '../orchestration/store/connect.js';
import { acceptStartCommand } from '../orchestration/store/command-boundary.js';
import {
  createTask,
  dispatchAttempt,
  claimAttempt,
  renewLease,
  startAttemptOperation,
  markAttemptPayloadReady,
  submitAttemptResult,
} from '../orchestration/store/attempts.js';
import {
  COLLECTIONS,
  ensureOrchestrationIndexes,
  type AttemptDoc,
  type TaskDoc,
} from '../orchestration/store/collections.js';

const HOSTS = ['localhost:27019', 'localhost:27020', 'localhost:27021'];
const URI = process.env.F8_RS3_URI ?? `mongodb://${HOSTS.join(',')}/?replicaSet=rs3f8`;
const DB = `f8_stepdown_${Date.now()}`;
const CHAOS = 'scripts/f8-mongo-chaos.sh';
const STEPDOWN_SECS = 20;

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

function chaos(...args: string[]): void {
  execFileSync('bash', [CHAOS, ...args], { stdio: 'inherit', timeout: 120_000 });
}

async function currentPrimary(): Promise<string> {
  const probe = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000 });
  try {
    await probe.connect();
    const status = await probe.db('admin').command({ replSetGetStatus: 1 }) as {
      members: Array<{ name: string; stateStr: string }>;
    };
    const primary = status.members.find((m) => m.stateStr === 'PRIMARY');
    assert.ok(primary, 'the set must have a primary before this scenario means anything');
    return primary!.name;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

console.log('f8:stepdown-lease-renewal');

const store = await connectV2Store({ uri: URI, dbName: DB });
const { client, db } = store;
const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

try {
  await ensureOrchestrationIndexes(db);

  const primaryBefore = await currentPrimary();
  console.log(`  primary before stepdown: ${primaryBefore}`);

  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_f8s', conversationId: 'conv_f8s', goal: 'work that survives an orderly handover',
    commandId: `cmd_f8s_${Date.now()}`, payload: { op: 'f8s' },
  });
  const taskId = await createTask(client, db, accepted.jobId);
  const { attemptId } = await dispatchAttempt(client, db, { jobId: accepted.jobId, taskId });

  // Long enough that the stepdown window (20s) plus the checks below cannot
  // brush against expiry — the property under test is the handover, not a race
  // against the lease clock. That race is `f8:no-duplicate-effect`'s job.
  const lease = await claimAttempt(client, db, {
    attemptId, workerInstanceId: 'worker-S', leaseTtlMs: 120_000,
  });
  assert.ok(lease, 'the worker must get the lease');
  const fence = lease!.attemptFence;
  console.log(`  worker-S holds the lease, fence=${fence}`);

  // ── 1. a REAL handover to a DIFFERENT node ──────────────────────────────────
  await check('rs.stepDown() hands the role to a DIFFERENT node, not back to itself', async () => {
    chaos('stepdown', String(STEPDOWN_SECS));
    const start = Date.now();
    let after = '';
    while (Date.now() - start < 30_000) {
      try {
        after = await currentPrimary();
        if (after !== primaryBefore) break;
      } catch { /* mid-election: keep asking */ }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    assert.notEqual(after, primaryBefore,
      `the primary must move to a different node — stayed on ${primaryBefore}, meaning the barred `
      + 'old primary reclaimed the role and this scenario tested nothing');
    assert.notEqual(after, '', 'the set must elect SOME primary within 30s');
    console.log(`    new primary: ${after} (was ${primaryBefore}), after `
      + `${Math.round((Date.now() - start) / 1000)}s`);
  });

  // ── 2. the same, unpinned client keeps renewing the lease ──────────────────
  await check('the SAME client renews the lease through the handover, no reconnect needed', async () => {
    const before = (await attempts.findOne({ _id: attemptId }))?.leaseExpiresAt?.getTime() ?? 0;
    // The SAME ttl as the original claim — a real worker renews on a steady
    // cadence with a stable ttl, well before its previous deadline lapses.
    // Renewing with the library default (30s) here, ~15s after a 120s claim,
    // would legitimately SHRINK the deadline — that is correct store behaviour,
    // not the property under test, and asserting on it would blame the store
    // for a mismatched test.
    const renewed = await renewLease(db, {
      attemptId, leaseOwner: 'worker-S', attemptFence: fence, leaseTtlMs: 120_000,
    });
    assert.equal(renewed, true,
      'a live worker\'s lease renewal must succeed across a handover — refusing it here would fence '
      + 'out a worker that never did anything wrong');
    const after = (await attempts.findOne({ _id: attemptId }))?.leaseExpiresAt?.getTime() ?? 0;
    assert.ok(after > before, `leaseExpiresAt must have advanced (was ${before}, is ${after})`);
  });

  // ── 3. the transactional sequence commits through the same handover ────────
  await check('start → payload ready → submit all commit on the SAME client', async () => {
    assert.equal(await startAttemptOperation(client, db, {
      attemptId, leaseOwner: 'worker-S', attemptFence: fence,
    }), true, 'starting the operation must succeed post-handover');

    const producer = { status: 'ok', data: { text: 'worker-S finished across the handover' } };
    const ready = await markAttemptPayloadReady(client, db, {
      attemptId, leaseOwner: 'worker-S', attemptFence: fence, producer,
    });
    assert.equal(ready.ready, true, 'freezing the payload must succeed post-handover');

    const submitted = await submitAttemptResult(client, db, {
      attemptId, leaseOwner: 'worker-S', attemptFence: fence, producer,
      businessPayloadReadyGeneration: ready.generation,
    });
    assert.equal(submitted.committed, true,
      `the submit must commit, got: ${JSON.stringify(submitted.reason)} — a live worker refused `
      + 'because the primary moved is the driver failing instead of rerouting');
    assert.equal(submitted.outcome, 'OK');
  });

  await check('exactly ONE result exists, and the task reached ONE terminal state', async () => {
    const results = await db.collection(COLLECTIONS.results)
      .find({ attemptId } as never).toArray();
    assert.equal(results.length, 1, `exactly one result, found ${results.length}`);
    const att = await attempts.findOne({ _id: attemptId });
    assert.equal(att?.lifecycle, 'FINISHED');
    assert.equal(att?.leaseOwner, null, 'the lease must be released, once');
    const task = await tasks.findOne({ _id: taskId });
    assert.equal(task?.phase, 'SUCCEEDED');
  });

  // ── 4. contrast — the failing case, so 2 and 3 are not vacuous ─────────────
  await check('a client PINNED to the (now-secondary) old primary cannot itself finish work', async () => {
    // The one way this guarantee actually breaks: some future code builds a
    // client with `directConnection`, the same shape `f8-no-split-brain` uses on
    // purpose to reach its dangerous case, and loses the ability to reroute.
    const pinned = new MongoClient(`mongodb://${primaryBefore}/?directConnection=true`, {
      serverSelectionTimeoutMS: 10_000,
    });
    try {
      await pinned.connect();
      const hello = await pinned.db('admin').command({ hello: 1 }) as { isWritablePrimary?: boolean };
      assert.equal(hello.isWritablePrimary ?? false, false,
        'the old primary must no longer be writable — otherwise this contrast proves nothing');

      let threw = false;
      try {
        await pinned.db(DB).collection('effect').insertOne({ _id: 'should-never-land' } as never);
      } catch {
        threw = true;
      }
      assert.equal(threw, true,
        'a client wired to talk ONLY to the stepped-down node must fail to write — if it succeeded, '
        + 'checks 2 and 3 above proved nothing about rerouting because there was nothing to reroute FROM');
    } finally {
      await pinned.close().catch(() => undefined);
    }
  });
} finally {
  try { chaos('heal'); } catch { /* reported by the script */ }
  await db.dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
}

if (failures > 0) {
  console.error(`\n❌ f8:stepdown-lease-renewal — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:stepdown-lease-renewal — an orderly handover reroutes the live worker, it never fails it');
process.exit(0);
