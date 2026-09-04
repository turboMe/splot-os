#!/usr/bin/env tsx
/**
 * f8:no-duplicate-effect — a worker that lost its lease during a REAL failover
 * cannot write a result, and the takeover produces exactly one.
 *
 * WHY THIS IS NOT ALREADY COVERED
 * -------------------------------
 * `e2e:orchestration-attempt-lifecycle` proves the same fencing rule on a
 * single-node replica set: the logic is right. What it cannot show is whether
 * the rule survives the events F8 exists for — an election, a primary that
 * stops being one mid-transaction, a driver retrying a commit whose outcome it
 * never learned.
 *
 * That distinction is the whole reason F8 is a rollout blocker (ADR 0006): it is
 * about **losing data in production**, not about test fidelity. A fence check
 * that holds in-process and fails across a failover would be invisible until the
 * day it mattered.
 *
 * WHAT IT PROVES
 * --------------
 * The dangerous shape, in order:
 *
 *   1. worker A claims attempt #1            → fence 1
 *   2. the PRIMARY IS KILLED, the set elects a new one
 *   3. A's lease expires and is reaped       → #1 WORKER_LOST, fence advanced to 2
 *   4. the task dispatches attempt #2, worker B claims it
 *   5. A comes back and submits against #1   → MUST be refused (stale fence)
 *   6. B submits against #2                  → committed
 *
 * Step 5 is the one that matters: A did real work in the world before it was
 * fenced out. If its result lands, the job commits an effect twice — the
 * "duplicate effect" F8's definition of done forbids.
 *
 * WHAT IS AND IS NOT ISOLATED HERE
 * -------------------------------
 * Recovery does two things at once: it finishes the attempt as WORKER_LOST and
 * it raises the fence. Both would independently stop A, and this scenario cannot
 * separate them — with the attempt terminal, the lifecycle guard answers first.
 * Verified by removing the fence check from `submitAttemptResult` and then from
 * `renewLease`: both assertions stayed green.
 *
 * So the falsifiable claims here are: the fence DOES advance on recovery, the
 * task ends with exactly ONE committed result, and the abandoned attempt is
 * never re-outcomed. Isolating the fence needs a scenario where the attempt is
 * still live — which this recovery path never produces.
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:no-duplicate-effect
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

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
  reapExpiredLeases,
} from '../orchestration/store/attempts.js';
import {
  COLLECTIONS,
  ensureOrchestrationIndexes,
  type AttemptDoc,
} from '../orchestration/store/collections.js';

const URI = process.env.F8_RS3_URI
  ?? 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const DB = `f8_dup_effect_${Date.now()}`;
const CHAOS = 'scripts/f8-mongo-chaos.sh';

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

/** Run a chaos verb, letting its output through so the evidence is in the log. */
function chaos(...args: string[]): void {
  execFileSync('bash', [CHAOS, ...args], { stdio: 'inherit', timeout: 120_000 });
}

console.log('f8:no-duplicate-effect');
console.log(`  set: ${URI.replace(/^mongodb:\/\//, '')}`);

const store = await connectV2Store({ uri: URI, dbName: DB });
const { client, db } = store;
const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);

try {
  await ensureOrchestrationIndexes(db);

  // ── Set up one real attempt through the real boundary ──────────────────────
  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_f8', conversationId: 'conv_f8', goal: 'work that must happen once',
    commandId: `cmd_f8_${Date.now()}`, payload: { op: 'f8' },
  });
  const taskId = await createTask(client, db, accepted.jobId);
  const { attemptId } = await dispatchAttempt(client, db, { jobId: accepted.jobId, taskId });

  // A short TTL so the reap is a real expiry, not a forced state edit.
  const leaseA = await claimAttempt(client, db, {
    attemptId, workerInstanceId: 'worker-A', leaseTtlMs: 2_000,
  });
  assert.ok(leaseA, 'worker A must get the lease');
  assert.equal(leaseA!.attemptFence, 1, 'first claim raises the fence to 1');
  console.log(`  worker A holds the lease, fence=${leaseA!.attemptFence}`);

  // ── The failover this whole gate exists for ────────────────────────────────
  await check('a real election happens while the attempt is leased', async () => {
    chaos('kill', 'primary');
    // The set must elect a new primary on its own. Any command that requires a
    // writable primary is the proof — connect through the driver, not a shell.
    const start = Date.now();
    let elected = false;
    while (Date.now() - start < 60_000) {
      try {
        await db.admin().command({ hello: 1 });
        const status = await db.admin().command({ replSetGetStatus: 1 }) as {
          members: Array<{ stateStr: string }>;
        };
        if (status.members.some((m) => m.stateStr === 'PRIMARY')) { elected = true; break; }
      } catch { /* mid-election: keep asking */ }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    assert.ok(elected, 'the set must elect a new primary within 60s — otherwise nothing below means anything');
    console.log(`    new primary elected after ${Math.round((Date.now() - start) / 1000)}s`);
  });

  // ── The takeover ───────────────────────────────────────────────────────────
  let attemptB = '';
  let fenceB = 0;
  await check('reaping FENCES the lost worker out and the task retries on a new attempt', async () => {
    // Recovery does not hand the same attempt back: it finishes #1 as WORKER_LOST
    // and RAISES ITS FENCE, which is precisely what invalidates anything A still
    // holds. The retry is a separate attempt record.
    const reaped = await reapExpiredLeases(client, db);
    assert.ok(reaped >= 1, `the expired lease must be reaped, got ${reaped}`);

    const lost = await attempts.findOne({ _id: attemptId });
    assert.equal(lost?.outcome, 'WORKER_LOST', 'the abandoned attempt must be recorded as lost');
    assert.ok((lost?.attemptFence ?? 0) > leaseA!.attemptFence,
      `the fence must RISE on recovery (was ${leaseA!.attemptFence}, is ${lost?.attemptFence}) — `
      + 'an unchanged fence would leave the old worker able to commit');

    const next = await dispatchAttempt(client, db, { jobId: accepted.jobId, taskId });
    assert.ok(next.attemptNumber > 1, 'the retry must be a NEW attempt, not the old one reopened');
    attemptB = next.attemptId;

    const leaseB = await claimAttempt(client, db, {
      attemptId: attemptB, workerInstanceId: 'worker-B', leaseTtlMs: 60_000,
    });
    assert.ok(leaseB, 'worker B must be able to claim the retry');
    fenceB = leaseB!.attemptFence;
  });

  // ── The property F8 is about ───────────────────────────────────────────────
  await check('the old worker is refused on EVERY path it could still try', async () => {
    // What this does and does not prove, stated because I got it wrong first.
    //
    // Recovery makes the attempt terminal (WORKER_LOST) AND raises its fence.
    // Two independent barriers now stand between A and a second effect — and
    // this scenario cannot isolate them: with the attempt already FINISHED, the
    // lifecycle guard refuses A first, whichever path it takes.
    //
    // Measured while writing this: removing the fence check from
    // `submitAttemptResult` ENTIRELY, and then from `renewLease`, left both
    // assertions green. So the fence is NOT what these two lines test. What they
    // test is that a fenced-out worker has no way back in — which is the
    // property F8 names — and the fence itself is asserted separately above,
    // where it IS falsifiable (removing the advance fails that check loudly).
    const renewed = await renewLease(db, {
      attemptId, leaseOwner: 'worker-A', attemptFence: leaseA!.attemptFence,
    });
    assert.equal(renewed, false,
      'a worker whose attempt was recovered must not be able to extend its lease');

    const stale = await submitAttemptResult(client, db, {
      attemptId,
      leaseOwner: 'worker-A',
      attemptFence: leaseA!.attemptFence,
      producer: { status: 'ok', data: { text: 'A did this work before it was fenced out' } },
    });
    assert.equal(stale.committed, false,
      'the fenced-out worker\'s result was COMMITTED — this is the duplicate effect F8 forbids');
    assert.match(String(stale.reason ?? ''), /stale|fence|lease|cutoff/i,
      `the refusal must name the reason, got: ${JSON.stringify(stale.reason)}`);
    console.log(`    A refused: ${stale.reason}`);
  });

  await check('the CURRENT owner still commits normally', async () => {
    // The full sequence the worker really runs: LEASED → RUNNING → payload frozen
    // → submit. Skipping a step is refused with the same `stale_fence_or_lease`
    // as a fenced-out worker, which is worth knowing: that reason covers "you are
    // not the owner" AND "you are not where you claim to be in the lifecycle".
    const producer = { status: 'ok', data: { text: 'B finished the work' } };
    assert.equal(await startAttemptOperation(client, db, {
      attemptId: attemptB, leaseOwner: 'worker-B', attemptFence: fenceB,
    }), true, 'B must be able to start its operation');
    const ready = await markAttemptPayloadReady(client, db, {
      attemptId: attemptB, leaseOwner: 'worker-B', attemptFence: fenceB, producer,
    });
    assert.equal(ready.ready, true, 'B must be able to freeze its payload');
    const fresh = await submitAttemptResult(client, db, {
      attemptId: attemptB, leaseOwner: 'worker-B', attemptFence: fenceB, producer,
      businessPayloadReadyGeneration: ready.generation,
    });
    assert.equal(fresh.committed, true,
      `the live owner must be able to finish, got: ${JSON.stringify(fresh.reason)}`);
    assert.equal(fresh.outcome, 'OK');
  });

  await check('EXACTLY ONE result exists, and it is the survivor\'s', async () => {
    // Counted per TASK, not per attempt: the whole point is that ONE unit of
    // work produced ONE committed result, however many attempts it took.
    const results = await db.collection(COLLECTIONS.results)
      .find({ taskId } as never).toArray();
    assert.equal(results.length, 1,
      `exactly one result must exist for the task, found ${results.length}`);
    const text = JSON.stringify(results[0]);
    assert.match(text, /B finished the work/, 'the surviving result must be B\'s');
    assert.ok(!/before it was fenced out/.test(text),
      'the fenced-out worker\'s payload must not be anywhere in the committed result');
  });

  await check('the abandoned attempt stays lost — recovery did not resurrect it', async () => {
    const lost = await attempts.findOne({ _id: attemptId });
    assert.equal(lost?.outcome, 'WORKER_LOST',
      'the abandoned attempt must remain WORKER_LOST, never quietly re-outcomed as OK');
    const survivor = await attempts.findOne({ _id: attemptB });
    assert.equal(survivor?.lifecycle, 'FINISHED', 'the retry must be finished');
  });
} finally {
  // Bring the killed node back. `kill primary` resolved WHICH node at kill time,
  // so rather than guess, revive all three — `docker start` on a running
  // container is a no-op, and leaving the set degraded would silently weaken
  // every later run against it.
  for (const node of ['a', 'b', 'c']) {
    try { chaos('revive', node); } catch { /* reported by the script itself */ }
  }
  await db.dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
}

if (failures > 0) {
  console.error(`\n❌ f8:no-duplicate-effect — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:no-duplicate-effect — a fenced-out worker cannot commit, across a real election');
process.exit(0);
