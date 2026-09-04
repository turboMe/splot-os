#!/usr/bin/env tsx
/**
 * F8 topology proof: the APPLICATION's own connector reaches the three-node
 * replica set and commits a multi-document transaction on it.
 *
 * This deliberately goes through `connectV2Store` — the function the
 * orchestration store itself uses — rather than opening a raw `MongoClient`.
 * A raw driver connecting proves that MongoDB is up; it does not prove that
 * the code which will actually run against this topology can reach it. The
 * connection string is the thing most likely to break when a single node
 * becomes three (members are addressed by whatever `rs.conf()` recorded, not
 * by the port a client dialled), so the proof has to exercise the real path.
 *
 * Nothing here touches production: the URI is the F8 set on 27019-27021, the
 * database is a throwaway dropped in `finally`, and the script refuses to run
 * against anything that is not a replica set of at least three members.
 *
 *   npm run infra:rs3:prove
 */
import { connectV2Store } from '../orchestration/store/connect.js';

const URI = process.env.MONGODB_URI_F8_RS3
  ?? 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const DB = `f8_rs3_proof_${Date.now()}`;
/** Minimum members that make the F8 failure scenarios possible at all. */
const MIN_MEMBERS = 3;

interface Job { _id: string; state: string; seq: number }
interface Task { _id: string; jobId: string; state: string }
interface Outbox { _id: string; jobId: string; event: string }

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log(`prove:f8-rs3-transaction — uri=${URI} db=${DB}`);

  const store = await connectV2Store({ uri: URI, dbName: DB });
  const { client, db } = store;

  try {
    // --- A. the topology the application actually sees ----------------------
    // Asked through the driver, not through mongosh: the question is what the
    // application's client discovered, which is the only view that matters for
    // whether its transactions can find a primary.
    const hello = await db.admin().command({ hello: 1 }) as {
      setName?: string; hosts?: string[]; primary?: string;
    };
    const status = await db.admin().command({ replSetGetStatus: 1 }) as {
      set: string; term: number; members: Array<{ name: string; stateStr: string; health: number }>;
    };
    const healthy = status.members.filter((m) => m.health === 1);
    const primaries = status.members.filter((m) => m.stateStr === 'PRIMARY');

    console.log(`\n  topology: set=${status.set} term=${status.term}`);
    for (const m of status.members) {
      console.log(`    ${m.name.padEnd(20)}${m.stateStr.padEnd(12)}health=${m.health}`);
    }
    console.log('');

    check('the application connector reached a replica set', Boolean(hello.setName),
      `setName=${hello.setName ?? 'NONE — this is a standalone, transactions cannot work'}`);
    check(`the set has at least ${MIN_MEMBERS} members`, status.members.length >= MIN_MEMBERS,
      `${status.members.length} members`);
    check(`at least ${MIN_MEMBERS} members are healthy`, healthy.length >= MIN_MEMBERS,
      `${healthy.length} healthy`);
    check('exactly one primary', primaries.length === 1,
      primaries.length === 1 ? primaries[0].name : `${primaries.length} primaries — SPLIT BRAIN`);
    check('the driver discovered every member', (hello.hosts?.length ?? 0) >= MIN_MEMBERS,
      `driver sees ${hello.hosts?.length ?? 0}: ${(hello.hosts ?? []).join(', ')}`);

    // --- B. a committed multi-document transaction --------------------------
    // Three collections in one transaction, at the same boundary the
    // orchestration store uses: snapshot reads, majority writes. On a
    // standalone this throws; on a replica set it must commit atomically.
    console.log('\n  multi-document transaction (3 collections, snapshot + w:majority)');
    const jobs = db.collection<Job>('jobs');
    const tasks = db.collection<Task>('tasks');
    const outbox = db.collection<Outbox>('outbox');

    await jobs.insertOne({ _id: 'job-1', state: 'PENDING', seq: 0 });

    const session = client.startSession();
    let committed = false;
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      await jobs.updateOne({ _id: 'job-1' }, { $set: { state: 'RUNNING' }, $inc: { seq: 1 } }, { session });
      await tasks.insertOne({ _id: 'task-1', jobId: 'job-1', state: 'CLAIMED' }, { session });
      await outbox.insertOne({ _id: 'obx-1', jobId: 'job-1', event: 'JobStarted' }, { session });
      await session.commitTransaction();
      committed = true;
    } finally {
      await session.endSession();
    }

    check('the transaction committed', committed);
    const job = await jobs.findOne({ _id: 'job-1' });
    check('job document reflects the committed write', job?.state === 'RUNNING' && job?.seq === 1,
      `state=${job?.state} seq=${job?.seq}`);
    check('task document committed in the same transaction', (await tasks.countDocuments({})) === 1);
    check('outbox document committed in the same transaction', (await outbox.countDocuments({})) === 1);

    // --- C. an aborted transaction leaves nothing behind --------------------
    // Without this, section B proves very little: if the writes were silently
    // applied outside a transaction, B would pass exactly the same way. The
    // rollback is what shows the boundary is real.
    console.log('\n  aborted transaction (the boundary must roll back)');
    const abortSession = client.startSession();
    try {
      abortSession.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      await jobs.updateOne({ _id: 'job-1' }, { $set: { state: 'SHOULD_NOT_PERSIST' } }, { session: abortSession });
      await outbox.insertOne({ _id: 'obx-ghost', jobId: 'job-1', event: 'ShouldNotPersist' }, { session: abortSession });
      await abortSession.abortTransaction();
    } finally {
      await abortSession.endSession();
    }

    const afterAbort = await jobs.findOne({ _id: 'job-1' });
    check('the aborted update did not persist', afterAbort?.state === 'RUNNING',
      `state=${afterAbort?.state}`);
    check('the aborted insert did not persist', (await outbox.countDocuments({ _id: 'obx-ghost' })) === 0);

    // --- D. the write actually reached a majority of nodes ------------------
    // `w: majority` acknowledged means a majority persisted it. Read it back
    // from a secondary to show the data is on more than the node that took it —
    // the whole reason three nodes exist.
    console.log('\n  durability across members');
    const fromSecondary = await db.collection<Job>('jobs')
      .findOne({ _id: 'job-1' }, { readPreference: 'secondary', readConcern: { level: 'majority' } });
    check('a secondary serves the majority-committed job', fromSecondary?.state === 'RUNNING',
      `secondary read state=${fromSecondary?.state}`);

    console.log('');
    if (failures > 0) {
      console.error(`prove:f8-rs3-transaction FAILED — ${failures} assertion(s) did not hold`);
      process.exit(1);
    }
    console.log('prove:f8-rs3-transaction PASSED — the application commits multi-document');
    console.log('transactions on the three-node set, and the boundary rolls back when aborted.');
  } finally {
    await db.dropDatabase().catch(() => undefined);
    await store.close();
  }
}

main().catch((error) => {
  console.error(`prove:f8-rs3-transaction failed: ${(error as Error).message}`);
  process.exit(1);
});
