#!/usr/bin/env tsx
/**
 * f8:unknown-commit-idempotent — when a commit's outcome is UNKNOWABLE, the
 * retry must not produce a second effect, and must not lose the first.
 *
 * WHY THIS SCENARIO IS THE DANGEROUS ONE
 * --------------------------------------
 * Every other failure has a knowable answer: the write happened or it did not.
 * `UnknownTransactionCommitResult` is the one where the client genuinely cannot
 * tell — the connection died between "commit" and the acknowledgement. Whatever
 * the worker does next is a guess:
 *
 *   - assume it failed and retry  → duplicate effect, if it had committed
 *   - assume it worked and move on → lost work, if it had not
 *
 * F8's definition of done forbids both ("brak lost outbox i duplicate effect"),
 * so the only acceptable behaviour is a retry that is INDIFFERENT to which
 * happened. That is what this proves.
 *
 * WHAT IT DOES, AND WHY IT IS SPLIT IN TWO
 * ----------------------------------------
 * The obvious script — fail the commit, heal, retry the same call — does not
 * work, and the reason is worth recording. `fail-commit` closes the connection
 * during `commitTransaction`; `runTxn` cannot get through the still-armed
 * failpoint however many times it tries, and exhausts its budget of 50 — and
 * after healing, that same client's pool is still full of the fifty connections
 * the failpoint killed.
 *
 * CORRECTION (measured later, by `f8:transient-retry-split`, which prints the
 * labels into its own output): this header used to say the resulting
 * `MongoNetworkError` "carries NO error labels at all". That is WRONG. It carries
 *
 *     ["RetryableWriteError","ResetPool","UnknownTransactionCommitResult"]
 *
 * so what `runTxn` retries here is the COMMIT (txn.ts:88), not the callback. The
 * assertions below are unaffected — they were always about outcomes, not routes —
 * but the reasoning was, and a wrong explanation in a header is how the next
 * person writes a test that proves nothing. It cost one dead falsification
 * attempt in the file that found it.
 *
 * So the two facts are proven separately, because they ARE separate:
 *
 *   A. the commit genuinely fails under the failpoint — a fresh client, one
 *      transaction, no retries available to hide it;
 *   B. issuing THE SAME submit twice produces one effect — which is exactly what
 *      a worker does when it cannot tell whether its commit landed. It does not
 *      matter whether the uncertainty came from a network error or a crash: the
 *      worker's only honest move is to repeat itself, and the system must absorb
 *      that.
 *
 * B is the property F8 names. A is the evidence that the situation B describes is
 * reachable at all.
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:unknown-commit-idempotent
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { connectV2Store } from '../orchestration/store/connect.js';
import { runTxn } from '../orchestration/store/txn.js';
import { acceptStartCommand } from '../orchestration/store/command-boundary.js';
import {
  createTask,
  dispatchAttempt,
  claimAttempt,
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

const URI = process.env.F8_RS3_URI
  ?? 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const DB = `f8_unknown_commit_${Date.now()}`;
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

function chaos(...args: string[]): void {
  execFileSync('bash', [CHAOS, ...args], { stdio: 'inherit', timeout: 120_000 });
}

console.log('f8:unknown-commit-idempotent');

const store = await connectV2Store({ uri: URI, dbName: DB });
const { client, db } = store;
const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

try {
  await ensureOrchestrationIndexes(db);

  // ── A. the commit genuinely fails under the failpoint ─────────────────────
  await check('A: under the failpoint a commit does NOT silently succeed', async () => {
    // A separate, short-lived client so the fifty killed connections never touch
    // the pool the rest of this file depends on.
    const probe = await connectV2Store({ uri: URI, dbName: `${DB}_probe` });
    chaos('fail-commit');
    try {
      let threw = false;
      try {
        await runTxn(probe.client, async (session) => {
          await probe.db.collection('effect').insertOne({ _id: 'once' } as never, { session });
          return { value: true };
        });
      } catch (err) {
        threw = true;
        const cause = (err as { cause?: Error }).cause;
        console.log(`    commit failed as expected: ${(cause ?? err as Error).message.slice(0, 60)}`);
      }
      assert.equal(threw, true,
        'the failpoint must make the commit fail — otherwise scenario B tests nothing real');
      assert.equal(await probe.db.collection('effect').countDocuments({}), 0,
        'and a failed commit must leave NO effect behind');
    } finally {
      chaos('heal');
      await probe.db.dropDatabase().catch(() => undefined);
      await probe.client.close().catch(() => undefined);
    }
  });

  // The attempt is created AFTER the chaos above, on purpose: a claim carries a
  // work deadline, and scenario A takes long enough to spend it. The first
  // version set everything up first and B failed with
  // `work_deadline_or_authority` — a real guard, firing for a reason that had
  // nothing to do with what was being tested.
  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_f8u', conversationId: 'conv_f8u', goal: 'work that must land exactly once',
    commandId: `cmd_f8u_${Date.now()}`, payload: { op: 'f8u' },
  });
  const taskId = await createTask(client, db, accepted.jobId);
  const { attemptId } = await dispatchAttempt(client, db, { jobId: accepted.jobId, taskId });

  const lease = await claimAttempt(client, db, { attemptId, workerInstanceId: 'worker-U' });
  assert.ok(lease, 'the worker must get the lease');
  const fence = lease!.attemptFence;

  assert.equal(await startAttemptOperation(client, db, {
    attemptId, leaseOwner: 'worker-U', attemptFence: fence,
  }), true);

  // The payload is frozen BEFORE the failure, exactly as a real worker does —
  // that freeze is what makes the retry comparable byte for byte.
  const producer = { status: 'ok', data: { text: 'the one and only effect' } };
  const ready = await markAttemptPayloadReady(client, db, {
    attemptId, leaseOwner: 'worker-U', attemptFence: fence, producer,
  });
  assert.equal(ready.ready, true, 'the payload must be frozen before the commit is attempted');


  // ── B. the property F8 names ───────────────────────────────────────────────
  await check('B: the SAME submit issued twice produces ONE effect', async () => {
    // What a worker does when it cannot tell whether its commit landed: repeat
    // itself, byte for byte.
    const first = await submitAttemptResult(client, db, {
      attemptId, leaseOwner: 'worker-U', attemptFence: fence, producer,
      businessPayloadReadyGeneration: ready.generation,
    });
    assert.equal(first.committed, true,
      `the first submit must commit, got: ${JSON.stringify(first.reason)}`);
    assert.notEqual(first.deduped, true, 'the FIRST submit is not a duplicate of anything');

    const second = await submitAttemptResult(client, db, {
      attemptId, leaseOwner: 'worker-U', attemptFence: fence, producer,
      businessPayloadReadyGeneration: ready.generation,
    });
    assert.equal(second.committed, true,
      'a repeat must resolve as committed — telling the worker "failed" would make it retry forever');
    assert.equal(second.deduped, true,
      'and it must be reported as DEDUPED — writing again is the duplicate effect F8 forbids');
    assert.equal(second.outcome, first.outcome, 'both calls must agree on the outcome');
    console.log(`    first: committed deduped=${first.deduped ?? false} | repeat: deduped=${second.deduped}`);
  });

  await check('EXACTLY ONE result exists — no duplicate, and nothing lost', async () => {
    const results = await db.collection(COLLECTIONS.results)
      .find({ attemptId } as never).toArray();
    assert.equal(results.length, 1,
      `exactly one result must exist, found ${results.length} — more than one is a duplicate `
      + 'effect, none is lost work');
    assert.match(JSON.stringify(results[0]), /the one and only effect/,
      'and it must be the payload the worker actually froze');
  });

  await check('the attempt and task reached ONE terminal state', async () => {
    const att = await attempts.findOne({ _id: attemptId });
    assert.equal(att?.lifecycle, 'FINISHED');
    assert.equal(att?.outcome, 'OK', 'an unknown commit outcome must not leave a wrong verdict');
    assert.equal(att?.leaseOwner, null, 'the lease must be released exactly once');
    const task = await tasks.findOne({ _id: taskId });
    assert.equal(task?.phase, 'SUCCEEDED', 'the task must succeed, once');
  });

  await check('a DIFFERENT payload on the same attempt is refused, not silently accepted', async () => {
    // The dedup path keys on the payload hash. If it did not, a retry carrying
    // different content would overwrite a committed result — a quieter, worse
    // version of the same defect.
    const tampered = await submitAttemptResult(client, db, {
      attemptId, leaseOwner: 'worker-U', attemptFence: fence,
      producer: { status: 'ok', data: { text: 'something else entirely' } },
      businessPayloadReadyGeneration: ready.generation,
    });
    assert.equal(tampered.committed, false,
      'a retry with a different payload must NOT be treated as the same effect');
    assert.match(String(tampered.reason ?? ''), /payload/i,
      `the refusal must name the payload, got: ${JSON.stringify(tampered.reason)}`);
  });
} catch (err) {
  const cause = (err as { cause?: unknown }).cause;
  console.error(`\n  UNCAUGHT: ${(err as Error).message}`);
  if (cause) console.error(`  cause: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause)).slice(0, 400)}`);
  failures += 1;
} finally {
  try { chaos('heal'); } catch { /* reported by the script */ }
  await db.dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
}

if (failures > 0) {
  console.error(`\n❌ f8:unknown-commit-idempotent — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:unknown-commit-idempotent — an unknowable commit outcome costs neither a duplicate nor the work');
process.exit(0);
