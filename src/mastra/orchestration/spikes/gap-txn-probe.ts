#!/usr/bin/env tsx
/**
 * GAP-TXN-01 — feasibility spike (plan §32, §15.3, §15.5).
 *
 * Questions:
 *  1. Boundary size/time — how long does a multi-document transaction that
 *     touches K documents (job + task + ancestor edges + attempt + reservation +
 *     result + outbox) take, vs Mongo's ~60 s / 16 MB limits?
 *  2. Hot-spot contention — under concurrent child-permit transactions, how bad
 *     is write contention when every child touches the single JOB authority
 *     document, and how much does moving sibling authority to a PER-TASK document
 *     help? (validates GAP-JOBDOC-01 / ADR 0007)
 *  3. `$$NOW` inside a multi-statement transaction (GAP-CLOCK-01 follow-up).
 *
 * Requires a replica set. This probe expects an EPHEMERAL one (default
 * mongodb://localhost:27018/?replicaSet=rs0) — never the production standalone.
 * Uses a throwaway DB dropped on exit.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MongoClient, type ClientSession, type Filter } from 'mongodb';

const URI = process.env.MONGODB_URI_SPIKE_RS ?? 'mongodb://localhost:27018/?replicaSet=rs0';
const DB = `orch_txn_spike_${Date.now()}`;
const CONCURRENCY = Number(process.env.SPIKE_CONCURRENCY ?? 48);

// String-keyed docs (the driver defaults `_id` to ObjectId otherwise).
interface AuthDoc { _id: string; seq: number }
interface JobDoc { _id: string; authSeq: number }
interface TaskDoc { _id: string; authSeq: number }
interface ChildDoc { _id: string; parent: string }
interface ResDoc { _id: string; payload: string }
interface ObxDoc { _id: string; ev: string }
interface ClockDoc { _id: string; state: string; deadlineAt: Date; gen: number }

/** Manual transaction runner that COUNTS TransientTransactionError retries. */
async function runTxn(client: MongoClient, fn: (s: ClientSession) => Promise<void>): Promise<number> {
  const session = client.startSession();
  let retries = 0;
  try {
    for (;;) {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      try {
        await fn(session);
        await session.commitTransaction();
        return retries;
      } catch (err) {
        try { await session.abortTransaction(); } catch { /* ignore */ }
        const e = err as { hasErrorLabel?: (l: string) => boolean };
        if (e.hasErrorLabel?.('TransientTransactionError') && retries < 100) { retries++; continue; }
        throw err;
      }
    }
  } finally {
    await session.endSession();
  }
}

async function main(): Promise<void> {
  console.log(`GAP-TXN-01 spike — uri=${URI} db=${DB} concurrency=${CONCURRENCY}`);
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(DB);

  const evidence: Record<string, unknown> = {};
  try {
    // --- 1. Boundary size/time ---------------------------------------------
    const boundary: Array<{ docs: number; commitMs: number }> = [];
    for (const K of [8, 16, 24]) {
      const authColl = db.collection<AuthDoc>(`auth_${K}`);
      const ids = Array.from({ length: K }, (_, i) => `a${i}`);
      await authColl.insertMany(ids.map((id) => ({ _id: id, seq: 0 })));
      const t0 = performance.now();
      await runTxn(client, async (s) => {
        for (const id of ids) await authColl.updateOne({ _id: id }, { $inc: { seq: 1 } }, { session: s });
        await db.collection<ResDoc>(`res_${K}`).insertOne({ _id: 'r', payload: 'x'.repeat(1024) }, { session: s });
        await db.collection<ObxDoc>(`obx_${K}`).insertOne({ _id: 'o1', ev: 'AttemptResultAvailable' }, { session: s });
        await db.collection<ObxDoc>(`obx_${K}`).insertOne({ _id: 'o2', ev: 'LaneWakeRequested' }, { session: s });
      });
      boundary.push({ docs: K + 3, commitMs: Math.round(performance.now() - t0) });
    }
    evidence.boundary = boundary;
    console.log(`  BOUNDARY  ${boundary.map((b) => `${b.docs}docs=${b.commitMs}ms`).join('  ')}`);

    // --- 2a. Hot-spot: every child touches the single JOB doc ---------------
    const jobColl = db.collection<JobDoc>('jobs_hot');
    const childHot = db.collection<ChildDoc>('children_hot');
    await jobColl.insertOne({ _id: 'job', authSeq: 0 });
    const tHot0 = performance.now();
    const hotRetries = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => runTxn(client, async (s) => {
        await jobColl.updateOne({ _id: 'job' }, { $inc: { authSeq: 1 } }, { session: s });
        await childHot.insertOne({ _id: `c${i}`, parent: 'job' }, { session: s });
      })),
    );
    const hotMs = Math.round(performance.now() - tHot0);
    const hotSeq = (await jobColl.findOne({ _id: 'job' }))?.authSeq;
    const hotRetryTotal = hotRetries.reduce((a, b) => a + b, 0);
    evidence.jobDocHotSpot = { concurrency: CONCURRENCY, totalMs: hotMs, retries: hotRetryTotal, finalSeq: hotSeq, lostUpdates: hotSeq !== CONCURRENCY };
    console.log(`  JOB-DOC   concurrency=${CONCURRENCY} totalMs=${hotMs} retries=${hotRetryTotal} finalSeq=${hotSeq} (expect ${CONCURRENCY})`);

    // --- 2b. GAP-JOBDOC-01: sibling authority on PER-TASK docs --------------
    const taskColl = db.collection<TaskDoc>('tasks_pt');
    const childPt = db.collection<ChildDoc>('children_pt');
    await taskColl.insertMany(Array.from({ length: CONCURRENCY }, (_, i) => ({ _id: `t${i}`, authSeq: 0 })));
    const tPt0 = performance.now();
    const ptRetries = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => runTxn(client, async (s) => {
        await taskColl.updateOne({ _id: `t${i}` }, { $inc: { authSeq: 1 } }, { session: s });
        await childPt.insertOne({ _id: `c${i}`, parent: `t${i}` }, { session: s });
      })),
    );
    const ptMs = Math.round(performance.now() - tPt0);
    const ptRetryTotal = ptRetries.reduce((a, b) => a + b, 0);
    evidence.perTaskDoc = { concurrency: CONCURRENCY, totalMs: ptMs, retries: ptRetryTotal };
    console.log(`  PER-TASK  concurrency=${CONCURRENCY} totalMs=${ptMs} retries=${ptRetryTotal}`);

    // --- 3. $$NOW inside a multi-statement transaction ----------------------
    const clockColl = db.collection<ClockDoc>('clock_txn');
    await clockColl.insertOne({ _id: 'd', state: 'RUNNING', deadlineAt: new Date(Date.now() + 60_000), gen: 0 });
    let nowInTxnWorks = false;
    const clockFilter = { _id: 'd', gen: 0, $expr: { $lt: ['$$NOW', '$deadlineAt'] } } as unknown as Filter<ClockDoc>;
    await runTxn(client, async (s) => {
      const r = await clockColl.findOneAndUpdate(
        clockFilter,
        { $set: { state: 'PAUSED' }, $inc: { gen: 1 } },
        { session: s, returnDocument: 'after' },
      );
      nowInTxnWorks = r?.state === 'PAUSED' && r?.gen === 1;
    });
    evidence.nowInTransaction = nowInTxnWorks;
    console.log(`  $$NOW-TXN works=${nowInTxnWorks}`);

    // --- verdict ------------------------------------------------------------
    const maxCommitMs = Math.max(...boundary.map((b) => b.commitMs));
    const noLostUpdates = hotSeq === CONCURRENCY;
    const perTaskCheaper = ptRetryTotal < hotRetryTotal; // fewer write conflicts off the hot doc
    const boundaryWellUnderLimit = maxCommitMs < 5_000; // vs ~60s Mongo limit
    const verdict = (noLostUpdates && boundaryWellUnderLimit && nowInTxnWorks)
      ? 'TXN_BOUNDARY_VIABLE'
      : 'NEEDS_REVIEW';

    Object.assign(evidence, {
      spike: 'GAP-TXN-01', at: new Date().toISOString(),
      env: { uri: URI, driver: '7.x', topology: 'ephemeral-replica-set', node: process.version },
      criteria: { noLostUpdates, boundaryWellUnderLimit, perTaskCheaper, nowInTxnWorks, maxCommitMs },
      verdict,
      findings: {
        jobDocContention: `${hotRetryTotal} retries across ${CONCURRENCY} concurrent job-doc CAS txns in ${hotMs}ms`,
        perTaskContention: `${ptRetryTotal} retries across ${CONCURRENCY} per-task CAS txns in ${ptMs}ms`,
        jobDocContentionMultiplier: ptRetryTotal > 0 ? Math.round((hotRetryTotal / ptRetryTotal) * 10) / 10 : (hotRetryTotal > 0 ? '∞ (per-task=0)' : 'both≈0'),
      },
      recommendation: 'Enforce maxBoundaryDocuments/TxnMs/OplogBytes < Mongo limits; keep sibling authority on per-task docs (GAP-JOBDOC-01) to avoid job-doc write-conflict storms; retry TransientTransactionError with bounded jitter and treat sustained hot-doc retries as a backpressure signal (§16.2).',
    });

    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = resolve(here, '../../../../docs/adr/evidence/gap-txn-01');
    const outFile = resolve(outDir, `probe-${Date.now()}.json`);
    writeFileSync(outFile, JSON.stringify(evidence, null, 2));
    console.log(`\n  VERDICT: ${verdict}`);
    console.log(`  job-doc vs per-task retries: ${hotRetryTotal} vs ${ptRetryTotal}`);
    console.log(`  evidence: ${outFile}`);
    process.exit(verdict === 'TXN_BOUNDARY_VIABLE' ? 0 : 1);
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}

main().catch((err) => { console.error(`GAP-TXN-01 spike failed: ${(err as Error).message}`); process.exit(1); });
