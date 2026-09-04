#!/usr/bin/env tsx
/**
 * f8:transient-retry-split — a transaction aborted mid-flight is RE-RUN and
 * leaves one effect; a transaction whose commit failed is NOT re-run.
 *
 * WHY THE SPLIT IS THE THING WORTH TESTING
 * ----------------------------------------
 * `runTxn` (txn.ts:52) treats two failures in opposite ways, and its own comment
 * says why: "Re-running the callback after an unknown commit can duplicate
 * non-idempotent decisions (notably a lease claim), so these labels must never be
 * conflated."
 *
 *   - `TransientTransactionError` → restart the whole callback. Nothing was
 *     committed, so re-deciding is safe and NOT re-deciding loses the work.
 *   - a failure at commit time     → never restart the callback. The transaction
 *     may in fact have committed; re-running the body would decide a second time.
 *
 * Conflate them in either direction and the damage is silent. Restart on a commit
 * failure and you get the duplicate effect. Refuse to restart on a transient abort
 * and every write conflict becomes a lost boundary. Both are F8 failures, and the
 * code that separates them is fifteen lines with no test standing over it.
 *
 * WHAT IT PROVES
 * --------------
 *   1. a transient abort restarts the callback, AND the writes of the abandoned
 *      attempt are gone — proven by writing before the failure and requiring the
 *      restart to write the same `_id` again without conflict;
 *   2. the retry budget is finite and says so (`BoundaryRetryExhaustedError`),
 *      leaving no effect;
 *   3. a failure AT COMMIT executes the callback exactly once — the decision is
 *      never taken twice.
 *
 * HOW 1 GETS A PARTIAL TRANSACTION, WHICH THE OBVIOUS SCRIPT CANNOT
 * -----------------------------------------------------------------
 * `fail-txn-write` fails whichever write comes first, so arming it up front means
 * every attempt dies on its FIRST write and no attempt ever gets partway. That
 * version proves the restart happens and proves nothing about atomicity. So the
 * failpoint is armed FROM INSIDE the callback, after the first write has already
 * landed in the transaction: attempt 1 writes A, arms the fault, dies on B;
 * attempt 2 must be able to write A again. If A had survived its abandoned
 * transaction, that write is a duplicate key — a hard, loud failure, which is the
 * point.
 *
 * A CORRECTION THIS FILE FORCED, TO A CLAIM ALREADY IN THE REPO
 * -------------------------------------------------------------
 * `f8-unknown-commit-idempotent.ts`'s header states that the `MongoNetworkError`
 * from a killed commit "carries NO error labels at all: not
 * `UnknownTransactionCommitResult`, not `TransientTransactionError`. Measured."
 * Measured again here, on the same fault, and printed into this scenario's own
 * output so it cannot quietly rot:
 *
 *     labels=["RetryableWriteError","ResetPool","UnknownTransactionCommitResult"]
 *
 * The label IS there. Which means `runTxn` retries the COMMIT — the branch at
 * txn.ts:88 — and never re-runs the callback. That file's ASSERTIONS are
 * unaffected (it asserts outcomes: the commit fails, no effect is left), but its
 * stated reason — "runTxn therefore retries the whole callback" — is wrong, and a
 * wrong explanation in a header is how the next person writes a test that proves
 * nothing. Corrected there too.
 *
 * This mattered immediately: the first falsification of check 3 edited the
 * fall-through path at the END of the commit loop and the check stayed GREEN,
 * because that code never runs under this fault. The falsification that works is
 * conflating the two labels at txn.ts:88 — which is exactly the mistake the
 * function's own comment warns about, and the check then fails with `ran 6`.
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 * - Not the unlabelled fall-through at the end of the commit loop. No fault
 *   available here reaches it; `fail-commit` always arrives labelled (above).
 * - Not that 50 is the right budget. Only that a budget exists, is enforced, and
 *   is reported as itself rather than as the underlying driver error.
 * - Nothing about ordering or fairness between competing writers. `f8:no-lost-outbox`
 *   covers the two-projector race.
 *
 * FALSIFIED BY (each RUN, each verified to turn ✗):
 * - `txn.ts:74` — making a transient abort rethrow instead of restarting: check 1 ✗;
 * - `txn.ts:79` — throwing the raw driver error instead of
 *   `BoundaryRetryExhaustedError`: check 2 ✗;
 * - `txn.ts:88` — making the `UnknownTransactionCommitResult` branch
 *   `continue transactionLoop` instead of retrying the commit: check 3 ✗, `ran 6`.
 *   Note the falsification that did NOT work, recorded so nobody repeats it:
 *   editing the fall-through at `txn.ts:102` left check 3 green, because that path
 *   is unreachable under this fault.
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:transient-retry-split
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { connectV2Store } from '../orchestration/store/connect.js';
import { runTxn, BoundaryRetryExhaustedError } from '../orchestration/store/txn.js';

const URI = process.env.F8_RS3_URI
  ?? 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const DB = `f8_txn_split_${Date.now()}`;
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

console.log('f8:transient-retry-split');

const store = await connectV2Store({ uri: URI, dbName: DB });
const { client, db } = store;

try {
  // ── 1. transient abort → restart, and the abandoned writes are gone ────────
  await check('a transient abort RE-RUNS the callback and leaves exactly one effect', async () => {
    const effects = db.collection('effects_transient');
    let runs = 0;

    const { retries } = await runTxn(client, async (session) => {
      runs += 1;
      // First write of the attempt. On attempt 1 this lands inside a transaction
      // that is about to be thrown away — and must therefore vanish with it.
      await effects.insertOne({ _id: 'A', run: runs } as never, { session });

      if (runs === 1) {
        // Arm the fault only now, so the transaction dies PARTWAY THROUGH rather
        // than on its first write. Synchronous on purpose: the transaction stays
        // open across it, which is exactly the state being tested.
        chaos('fail-txn-write', '1');
      }

      // On attempt 1 this is the write that aborts, transiently.
      await effects.insertOne({ _id: 'B', run: runs } as never, { session });
      return runs;
    });

    assert.equal(runs, 2,
      `the callback must run exactly twice, ran ${runs} — once means the transient abort was `
      + 'swallowed and the boundary silently lost its work');
    assert.equal(retries, 1, `runTxn must report the one retry it took, reported ${retries}`);

    // The load-bearing assertion. Attempt 2 re-inserted `_id: 'A'`; had attempt 1's
    // copy survived its abandoned transaction, that insert would have failed with a
    // duplicate key — a non-transient error that would have blown this check up
    // rather than reaching here.
    assert.equal(await effects.countDocuments({}), 2,
      'exactly two documents must exist (A and B), one each — more means the abandoned '
      + 'attempt left something behind, which is the duplicate effect F8 forbids');
    assert.equal((await effects.findOne({ _id: 'A' } as never) as { run?: number } | null)?.run, 2,
      'the surviving A must be the RETRY\'s A, not the abandoned attempt\'s');
  });

  // ── 2. the budget is finite, and named ─────────────────────────────────────
  await check('the retry budget is finite, reported as itself, and leaves no effect', async () => {
    const effects = db.collection('effects_budget');
    let runs = 0;
    let caught: unknown = null;

    chaos('fail-txn-write', 'alwaysOn');
    try {
      await runTxn(client, async (session) => {
        runs += 1;
        await effects.insertOne({ _id: `never_${runs}` } as never, { session });
        return runs;
      }, { maxRetries: 3, baseDelayMs: 1 });
    } catch (err) {
      caught = err;
    } finally {
      chaos('heal');
    }

    assert.ok(caught instanceof BoundaryRetryExhaustedError,
      `an endless transient fault must end as BoundaryRetryExhaustedError, got `
      + `${(caught as Error)?.name ?? 'no error at all'} — a raw driver error here would send the `
      + 'caller looking for a database problem instead of the contention this is');
    assert.equal((caught as BoundaryRetryExhaustedError).retries, 3,
      'and it must report the budget it actually spent');
    assert.equal(runs, 4, `the callback runs once per attempt: 1 + 3 retries, ran ${runs}`);
    assert.equal(await effects.countDocuments({}), 0,
      'a boundary that gave up must leave NOTHING behind — a half-written give-up is worse than '
      + 'the contention it was reporting');
  });

  // ── 3. a commit-time failure never re-runs the decision ────────────────────
  await check('a failure AT COMMIT executes the callback exactly once', async () => {
    // A short-lived client: `fail-commit` closes connections, and the pool it
    // poisons must not be the one anything else uses.
    const probe = await connectV2Store({ uri: URI, dbName: DB });
    let runs = 0;
    let threw = false;

    chaos('fail-commit');
    try {
      await runTxn(probe.client, async (session) => {
        runs += 1;
        await probe.db.collection('effects_commit')
          .insertOne({ _id: `decision_${runs}` } as never, { session });
        return runs;
      }, { maxRetries: 5, baseDelayMs: 1 });
    } catch (err) {
      threw = true;
      // Printed, not assumed: which branch of the commit loop actually fires
      // decides what this check is allowed to claim. See the header.
      const cause = (err as { cause?: Error }).cause ?? (err as Error);
      console.log(`    commit failed as ${(err as Error).name} / cause ${cause.name}`
        + ` labels=${JSON.stringify((cause as { errorLabels?: string[] }).errorLabels ?? [])}`);
    } finally {
      chaos('heal');
      await probe.client.close().catch(() => undefined);
    }

    assert.equal(threw, true, 'the commit fault must surface — a silent success proves nothing');
    assert.equal(runs, 1,
      `the callback must run EXACTLY ONCE, ran ${runs} — re-running a body whose commit may have `
      + 'landed is how a lease gets claimed twice and an effect committed twice');
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
  console.error(`\n❌ f8:transient-retry-split — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:transient-retry-split — an aborted transaction is re-run and leaves one effect; '
  + 'a failed commit is never re-decided');
process.exit(0);
