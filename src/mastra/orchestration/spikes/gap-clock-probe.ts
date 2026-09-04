#!/usr/bin/env tsx
/**
 * GAP-CLOCK-01 — feasibility spike (plan §32, §15.5, §10).
 *
 * Question: can `storeNow < deadline` be evaluated as part of the CONDITIONAL
 * WRITE (not a read-only snapshot), so the time predicate races atomically with
 * the CAS? If yes, the pause-vs-due / claim-vs-cutoff / answer-vs-expiry races
 * (ORC-TIME-01) are implementable on Mongo without a separate read.
 *
 * This is a SINGLE-DOCUMENT concern, so it runs against the existing standalone
 * Mongo using a throwaway DB that is dropped on exit — no replica set, no touch
 * of `agentforge`. (The multi-document transaction budget is GAP-TXN-01, which
 * does need a replica set.)
 *
 * Tests two candidate mechanisms + the race:
 *   M1  pipeline update with `$$NOW` guard (`$cond` decides whether fields change)
 *   M2  `$expr` + `$$NOW` in the query filter (time guard AND generation CAS in
 *       one conditional write)
 *   RACE two concurrent generation-CAS pauses ⇒ exactly one wins
 *   BOUNDARY pause vs due at the deadline ⇒ never both apply
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MongoClient, type Collection } from 'mongodb';

const URI = process.env.MONGODB_URI_SPIKE ?? 'mongodb://localhost:27017';
const DB = `orchestration_clock_spike_${Date.now()}`;

interface Doc {
  _id: string;
  state: string;
  deadlineAt: Date;
  clockGen: number;
  guardFired?: boolean;
  pausedAt?: Date | null;
}

let failures = 0;
const results: Record<string, { pass: boolean; detail?: unknown }> = {};
function check(name: string, cond: boolean, detail?: unknown): boolean {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}: ${JSON.stringify(detail)}`); }
  results[name] = { pass: cond, detail };
  return cond;
}

/** M1: pipeline update — `$$NOW` guard decides whether the transition applies. */
async function pauseViaPipeline(coll: Collection<Doc>, id: string, expectedGen: number) {
  return coll.findOneAndUpdate(
    { _id: id, clockGen: expectedGen },
    [
      { $set: { guardFired: { $lt: ['$$NOW', '$deadlineAt'] } } },
      { $set: {
          state: { $cond: ['$guardFired', 'PAUSED', '$state'] },
          clockGen: { $cond: ['$guardFired', { $add: ['$clockGen', 1] }, '$clockGen'] },
          pausedAt: { $cond: ['$guardFired', '$$NOW', '$pausedAt'] },
      } },
    ],
    { returnDocument: 'after' },
  );
}

/** M2: `$expr` + `$$NOW` in the filter — time guard AND generation CAS atomic. */
async function pauseViaExprFilter(coll: Collection<Doc>, id: string, expectedGen: number) {
  return coll.findOneAndUpdate(
    { _id: id, clockGen: expectedGen, $expr: { $lt: ['$$NOW', '$deadlineAt'] } },
    { $set: { state: 'PAUSED', pausedAt: new Date() }, $inc: { clockGen: 1 } },
    { returnDocument: 'after' },
  );
}

async function main(): Promise<void> {
  console.log(`GAP-CLOCK-01 spike — uri=${URI} db=${DB}`);
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const coll = client.db(DB).collection<Doc>('jobs');

  try {
    const future = () => new Date(Date.now() + 60_000);
    const past = () => new Date(Date.now() - 60_000);

    // --- M1 pipeline guard ---------------------------------------------------
    await coll.insertOne({ _id: 'm1-future', state: 'RUNNING', deadlineAt: future(), clockGen: 0, pausedAt: null });
    const m1f = await pauseViaPipeline(coll, 'm1-future', 0);
    const m1a = check('M1 pipeline: guard fires when now<deadline → PAUSED, gen++', m1f?.state === 'PAUSED' && m1f?.clockGen === 1, { state: m1f?.state, gen: m1f?.clockGen });

    await coll.insertOne({ _id: 'm1-past', state: 'RUNNING', deadlineAt: past(), clockGen: 0, pausedAt: null });
    const m1p = await pauseViaPipeline(coll, 'm1-past', 0);
    const m1b = check('M1 pipeline: guard blocks when now>=deadline → unchanged, gen stays', m1p?.state === 'RUNNING' && m1p?.clockGen === 0, { state: m1p?.state, gen: m1p?.clockGen });

    // --- M2 $expr + $$NOW filter --------------------------------------------
    await coll.insertOne({ _id: 'm2-future', state: 'RUNNING', deadlineAt: future(), clockGen: 0, pausedAt: null });
    const m2f = await pauseViaExprFilter(coll, 'm2-future', 0);
    const m2a = check('M2 $expr: fires when now<deadline → matched & PAUSED', m2f?.state === 'PAUSED' && m2f?.clockGen === 1, { doc: m2f });

    await coll.insertOne({ _id: 'm2-past', state: 'RUNNING', deadlineAt: past(), clockGen: 0, pausedAt: null });
    const m2p = await pauseViaExprFilter(coll, 'm2-past', 0);
    const m2pDoc = await coll.findOne({ _id: 'm2-past' });
    const m2b = check('M2 $expr: no match when now>=deadline → not paused', m2p === null && m2pDoc?.state === 'RUNNING' && m2pDoc?.clockGen === 0, { matched: m2p, doc: m2pDoc });

    // --- RACE: two concurrent generation-CAS pauses → exactly one wins -------
    await coll.insertOne({ _id: 'race', state: 'RUNNING', deadlineAt: future(), clockGen: 0, pausedAt: null });
    const [r1, r2] = await Promise.all([pauseViaExprFilter(coll, 'race', 0), pauseViaExprFilter(coll, 'race', 0)]);
    const winners = [r1, r2].filter((r) => r !== null).length;
    const raceDoc = await coll.findOne({ _id: 'race' });
    check('RACE: exactly one concurrent CAS pause wins, gen=1', winners === 1 && raceDoc?.clockGen === 1, { winners, gen: raceDoc?.clockGen });

    // --- BOUNDARY: pause vs due at the deadline → never both apply -----------
    // deadline ~150ms out; fire a pause (needs now<deadline) and a "due"
    // (needs now>=deadline) concurrently after the boundary passes.
    await coll.insertOne({ _id: 'boundary', state: 'RUNNING', deadlineAt: new Date(Date.now() + 150), clockGen: 0, pausedAt: null });
    await new Promise((r) => setTimeout(r, 200)); // let the deadline pass
    const dueViaExpr = () => coll.findOneAndUpdate(
      { _id: 'boundary', clockGen: 0, $expr: { $gte: ['$$NOW', '$deadlineAt'] } },
      { $set: { state: 'TIMED_OUT' }, $inc: { clockGen: 1 } },
      { returnDocument: 'after' },
    );
    const [pauseRes, dueRes] = await Promise.all([pauseViaExprFilter(coll, 'boundary', 0), dueViaExpr()]);
    const bDoc = await coll.findOne({ _id: 'boundary' });
    const exactlyOne = ([pauseRes, dueRes].filter((r) => r !== null).length === 1);
    // after the deadline, due must win and pause must fail its time guard
    check('BOUNDARY: past deadline → due wins, pause fails guard, gen=1', exactlyOne && bDoc?.state === 'TIMED_OUT' && bDoc?.clockGen === 1, { pause: pauseRes?.state ?? null, due: dueRes?.state ?? null, doc: bDoc });

    // --- verdict -------------------------------------------------------------
    const m1Works = m1a && m1b;
    const m2Works = m2a && m2b;
    const verdict = failures === 0 ? 'STORE_TIME_IN_CAS_WORKS' : 'PARTIAL_OR_FAILED';

    const evidence = {
      spike: 'GAP-CLOCK-01', at: new Date().toISOString(),
      env: { uri: URI.replace(/\/\/[^@]*@/, '//'), driver: '7.x', topology: 'standalone', node: process.version },
      mechanisms: { M1_pipeline_$$NOW_guard: !!m1Works, M2_$expr_$$NOW_filter: !!m2Works },
      results, verdict,
      recommendation: m2Works
        ? 'Use $expr + $$NOW in the query filter: time predicate AND generation CAS in one conditional write (single-document authority). Pipeline-form ($$NOW guard) also works as a fallback. Multi-document boundaries (A/B) still need GAP-TXN-01 on a replica set.'
        : 'Pipeline-form $$NOW guard works; $expr filter form needs review.',
      note: 'Single-document store-time authority. $$NOW is server time; app-provided Date is avoided in the guard so process clock skew is not authority.',
    };

    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = resolve(here, '../../../../docs/adr/evidence/gap-clock-01');
    const outFile = resolve(outDir, `probe-${Date.now()}.json`);
    writeFileSync(outFile, JSON.stringify(evidence, null, 2));
    console.log(`\n  VERDICT: ${verdict}`);
    console.log(`  evidence: ${outFile}`);
  } finally {
    await client.db(DB).dropDatabase().catch(() => {});
    await client.close();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`GAP-CLOCK-01 spike failed: ${(err as Error).message}`); process.exit(1); });
