#!/usr/bin/env tsx
/**
 * f8:no-split-brain — a primary that has lost the majority cannot commit, and
 * the work it thought it was doing leaves no trace.
 *
 * WHAT SPLIT-BRAIN ACTUALLY LOOKS LIKE HERE
 * -----------------------------------------
 * Not two nodes shouting "I am primary" — that is the cartoon. The dangerous
 * shape is quieter: ONE node still believes it is primary, still accepts client
 * connections, and still runs their commands, while the rest of the set has
 * stopped listening to it. A worker connected to that node is doing real work
 * against a database that no longer speaks for the cluster.
 *
 * `isolate` LOOKS like it produces that, and does not. It makes the node refuse
 * inbound `replSetHeartbeat`, so the majority marks it health=0 within ~3s — but
 * replication travels a different channel, so the node keeps replicating and a
 * `w:majority` write through it is acknowledged, legitimately. Measured here on
 * the first attempt at this test: the write committed and was then found on
 * another member. Health and reachability are not the same thing.
 *
 * The state that IS dangerous is produced by taking the OTHER two away: the
 * primary keeps serving clients, and has nobody left to acknowledge it.
 *
 * THE PROPERTY
 * ------------
 * `w:majority` is what makes that node harmless: a write it accepts can never be
 * acknowledged, because acknowledgement requires nodes that are no longer
 * listening. So:
 *
 *   1. pause BOTH secondaries — the primary is still up and still serving
 *   2. a client PINNED to it attempts a majority-committed transaction
 *   3. that transaction must NOT commit — there is nobody left to acknowledge it
 *   4. while it is cut off, the write is NOT majority-readable
 *
 * WHAT I GOT WRONG HERE, BECAUSE IT MATTERS FOR HOW THE SYSTEM IS BUILT
 * ---------------------------------------------------------------------
 * The first version asserted that the ghost write is nowhere after healing. It
 * failed, and it deserved to: a failed write concern does NOT mean the write did
 * not happen. It means it was not CONFIRMED. The primary applied it locally, the
 * majority ack timed out, and when the secondaries came back they replicated it
 * like any other oplog entry — because that primary never stepped down. Had it
 * lost the election, the same entry would have been rolled back.
 *
 * That is documented MongoDB semantics, not a defect, and it is precisely why
 * idempotency (`f8:unknown-commit-idempotent`) is the real defence rather than a
 * belt-and-braces extra: "my write failed" is never a safe thing for a worker to
 * believe. The property this file can honestly prove is the other one — that
 * nothing becomes MAJORITY-VISIBLE through a primary without a majority, so no
 * reader ever acts on it.
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:no-split-brain
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';

import { connectV2Store } from '../orchestration/store/connect.js';
import { runTxn } from '../orchestration/store/txn.js';

const HOSTS = ['localhost:27019', 'localhost:27020', 'localhost:27021'];
const URI = process.env.F8_RS3_URI ?? `mongodb://${HOSTS.join(',')}/?replicaSet=rs3f8`;
const DB = `f8_split_brain_${Date.now()}`;
const CHAOS = 'scripts/f8-mongo-chaos.sh';
const GHOST = 'the-write-that-must-never-appear';

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

function chaos(...args: string[]): string {
  return execFileSync('bash', [CHAOS, ...args], { encoding: 'utf-8', timeout: 120_000 });
}

/** Which host is PRIMARY right now, asked of the set rather than assumed. */
async function currentPrimary(): Promise<string> {
  const probe = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000 });
  try {
    await probe.connect();
    const status = await probe.db('admin').command({ replSetGetStatus: 1 }) as {
      members: Array<{ name: string; stateStr: string }>;
    };
    const primary = status.members.find((m) => m.stateStr === 'PRIMARY');
    assert.ok(primary, 'the set must have a primary before this test means anything');
    return primary!.name;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

console.log('f8:no-split-brain');

const primaryHost = await currentPrimary();
const node = { 'localhost:27019': 'a', 'localhost:27020': 'b', 'localhost:27021': 'c' }[primaryHost];
assert.ok(node, `unexpected primary host ${primaryHost}`);
console.log(`  primary before isolation: ${primaryHost} (node ${node})`);

// Pinned to that one node, so every command below goes to the stale primary and
// nowhere else. Without `directConnection` the driver would simply route around
// it — which is correct behaviour, and would test nothing.
const stale = new MongoClient(`mongodb://${primaryHost}/?directConnection=true`, {
  serverSelectionTimeoutMS: 10_000,
});

try {
  await stale.connect();
  // Take the majority away from the primary, leaving it up and reachable.
  for (const other of ['a', 'b', 'c'].filter((n) => n !== node)) chaos('partition', other);

  await check('the primary is still up and serving clients after losing its peers', async () => {
    const hello = await stale.db('admin').command({ hello: 1 }) as { isWritablePrimary?: boolean };
    // It may already have stepped down — MongoDB does that once it cannot see a
    // majority, and that IS the protection working. Either state is acceptable;
    // what matters is the write below.
    console.log(`    isWritablePrimary=${hello.isWritablePrimary ?? false}`);
  });

  await check('THE STALE PRIMARY CANNOT COMMIT a majority write', async () => {
    let committed = false;
    let refusal = '';
    try {
      await runTxn(stale, async (session) => {
        await stale.db(DB).collection('effect')
          .insertOne({ _id: GHOST } as never, { session });
        return { value: true };
      }, { maxRetries: 0, txn: { writeConcern: { w: 'majority', wtimeoutMS: 8_000 } } });
      committed = true;
    } catch (err) {
      refusal = (err as Error).message;
    }
    assert.equal(committed, false,
      'a node the majority has stopped listening to ACKNOWLEDGED a write — that is split-brain');
    console.log(`    refused: ${refusal.slice(0, 90)}`);
  });

  await check('the ghost write is NOT majority-readable while the primary is cut off', async () => {
    // The claim that survives scrutiny. `readConcern: majority` is the contract a
    // reader relies on, and it is what a stale primary cannot satisfy.
    const read = await stale.db(DB).collection('effect')
      .find({ _id: GHOST } as never, { readConcern: { level: 'majority' } })
      .maxTimeMS(8_000).toArray().catch((err: Error) => err);
    if (Array.isArray(read)) {
      assert.equal(read.length, 0,
        'a majority read returned a write the majority never acknowledged');
    } else {
      // Refusing to answer is equally correct — it cannot satisfy the read.
      console.log(`    majority read refused: ${(read as Error).message.slice(0, 70)}`);
    }
  });

  chaos('heal');

  await check('after healing the set is CONSISTENT — every member agrees', async () => {
    // Not "the ghost is gone" (see the header), but "no member disagrees with any
    // other". Divergence between members is the data loss F8 forbids; an
    // unacknowledged write that later replicates uniformly is not.
    const seen: Array<{ host: string; count: number }> = [];
    for (const host of HOSTS) {
      const direct = new MongoClient(`mongodb://${host}/?directConnection=true`, {
        serverSelectionTimeoutMS: 15_000,
      });
      try {
        await direct.connect();
        seen.push({
          host,
          count: await direct.db(DB).collection('effect').countDocuments({ _id: GHOST } as never),
        });
      } finally {
        await direct.close().catch(() => undefined);
      }
    }
    const counts = [...new Set(seen.map((s) => s.count))];
    assert.equal(counts.length, 1,
      `members disagree about the ghost write — ${JSON.stringify(seen)}. That is divergence, `
      + 'which is the split-brain damage F8 exists to forbid');
    console.log(`    all three members agree: ghost present=${counts[0]! > 0}`);
  });

  await check('the set converges on ONE primary and still commits normally', async () => {
    const after = await currentPrimary();
    console.log(`    primary after healing: ${after}`);
    const store = await connectV2Store({ uri: URI, dbName: DB });
    try {
      await runTxn(store.client, async (session) => {
        await store.db.collection('effect')
          .insertOne({ _id: 'a-write-that-should-land' } as never, { session });
        return { value: true };
      });
      assert.equal(
        await store.db.collection('effect').countDocuments({ _id: 'a-write-that-should-land' } as never),
        1,
        'the healed set must accept work again — refusing everything is not the fix');
    } finally {
      await store.db.dropDatabase().catch(() => undefined);
      await store.client.close().catch(() => undefined);
    }
  });
} finally {
  await stale.close().catch(() => undefined);
  try { chaos('heal'); } catch { /* reported by the script */ }
}

if (failures > 0) {
  console.error(`\n❌ f8:no-split-brain — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:no-split-brain — a primary without the majority cannot commit, '
  + 'nothing it wrote is majority-visible, and the members never diverge');
process.exit(0);
