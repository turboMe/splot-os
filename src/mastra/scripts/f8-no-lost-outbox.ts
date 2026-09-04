#!/usr/bin/env tsx
/**
 * f8:no-lost-outbox — an event that was going to reach the user never disappears
 * without a projection, however the commit dies.
 *
 * WHY THIS ONE FIRST, AHEAD OF THE TOPOLOGY SCENARIOS
 * ---------------------------------------------------
 * F8's definition of done names three properties: no split-brain, no duplicate
 * effect, no LOST OUTBOX. The first two are covered. The third was untouched, and
 * it is the only one of the three that does not need three nodes to happen:
 * production runs on a SINGLE-node set today (measured: `rs.status()` → members=1),
 * where an election is physically impossible but a connection dying inside
 * `projectConversationOnce` is not.
 *
 * So this is the one gap that describes a failure reachable on today's production,
 * and the damage is the quiet kind: the job really finished, the outbox event is
 * marked settled, and the user is simply never told. Nothing errors. Nothing
 * retries. The work is done and invisible.
 *
 * THE PROPERTY
 * ------------
 * `projectConversationOnce` (conversation-writer.ts:98) does five things — claim
 * the mailbox slot, take the next sequence, write the projection, create the
 * delivery, flip the outbox event to DELIVERED — and does them in ONE `runTxn`.
 * The flip being inside that transaction is the whole safety property, and it is
 * one forgotten `{ session }` away from being false. So:
 *
 *   A. commit killed mid-projection → the event is still PENDING, and NOTHING
 *      partial exists: no mailbox slot, no projection, no delivery, no advanced
 *      sequence;
 *   B. after healing, the same event projects EXACTLY ONCE;
 *   C. two projectors racing on one event produce ONE projection, and neither
 *      blows up;
 *   D. a REDELIVERED event (at-least-once transport, the normal case) dup-keys
 *      the mailbox slot and settles as `applied:false` — no second message, and
 *      the conversation sequence does not move.
 *
 * A is the lost-outbox property. C and D are its mirror: the repair must not
 * become the duplicate.
 *
 * TWO THINGS THIS FOUND THAT WERE NOT IN THE PLAN
 * -----------------------------------------------
 * 1. **A killed commit leaves a GHOST that wedges the next projector.** The
 *    abandoned transaction is still open on the server, still holding its write
 *    locks (`$currentOp` shows it). Every retry write-conflicts, every conflict is
 *    labelled `TransientTransactionError`, and `runTxn` burns all 50 retries in
 *    about a second — `BoundaryRetryExhaustedError`, which reads like a defect and
 *    is not one. The lock clears when MongoDB reaps the transaction
 *    (`transactionLifetimeLimitSeconds`, 60 s). Measured recovery: 67–87 s. The
 *    event is never LOST, but any caller that treats one `BoundaryRetryExhausted`
 *    as permanent strands work that was only ever waiting.
 *
 * 2. **The mailbox idempotency guard could not work, and this file is how that
 *    surfaced.** It caught duplicate-key 11000 and then settled the event in the
 *    SAME transaction — but a duplicate key inside a transaction makes the server
 *    abort it, so that settle returned code 251 with a transient label, `runTxn`
 *    restarted, and the loop ran until the budget was gone. Not reachable in
 *    production today (nothing re-arms a `DELIVERED` event), but latent and sharp:
 *    this writer always claims the OLDEST pending event, so one poisoned event
 *    would block every conversation behind it, permanently. Fixed by reading the
 *    slot before inserting — the pattern every other boundary in the store already
 *    uses. Assertion D is what holds that fixed.
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 * - Not that the projection CONTENT is right — `e2e:orchestration-conversation`
 *   owns that. Here the payload is only checked for identity, to tell one
 *   projection from another.
 * - **The composite key is NOT what makes the RACE (C) safe**, though it looks
 *   like it. Measured: with the mailbox `_id` made non-deterministic, the race
 *   still produced exactly one projection. What the two projectors actually
 *   contend on is the OUTBOX DOCUMENT — both must flip it to `DELIVERED`, the
 *   loser write-conflicts, restarts, and finds nothing pending. The composite key
 *   is what protects REDELIVERY (D), a different failure on a different path, and
 *   the two are asserted separately because they are separately breakable.
 * - Not the `applied:false` shape of the race loser. Measured: the loser returns
 *   `null` (restarted, found nothing pending), not a duplicate-key settle.
 * - Not that the user receives anything. This boundary ends at a `PENDING`
 *   delivery row; whether transport then loses it is a different gate with a
 *   different failure mode. "DELIVERED" in the assertions below is the OUTBOX
 *   event's state, not the user's inbox.
 * - Not that a half-applied transaction gets repaired. `fail-commit` closes the
 *   connection at `commitTransaction`, so the server never applies anything and
 *   what is proven is atomic ROLLBACK. MongoDB's transaction guarantee is what
 *   makes that true; this file proves the boundary actually USES it, which is the
 *   part that can regress.
 * - `nothing projectable is left behind` is NOT a lost-outbox check and must not
 *   be read as one: an event that was wrongly settled also leaves nothing pending.
 *   Verified — it stayed green under the falsification that broke A. It catches
 *   the opposite failure, an event nobody can drain.
 *
 * FALSIFIED BY (each RUN, each verified to turn ✗ — none assumed):
 * - dropping `{ session }` from the final `state:'DELIVERED'` update — A fails
 *   with "is DELIVERED", which IS the lost outbox: the event settles while the
 *   projection rolls back. C fails too, on the same edit: the racing pair lose
 *   the shared document they were contending on and exhaust the retry budget.
 * - making the mailbox `_id` non-deterministic — D fails: the redelivery applies
 *   a second time and reports `applied:true`.
 * - the original insert-then-catch guard (the bug this scenario found) — D fails
 *   with the retry budget exhausted, forever.
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:no-lost-outbox
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { connectV2Store } from '../orchestration/store/connect.js';
import { acceptStartCommand } from '../orchestration/store/command-boundary.js';
import { planJob } from '../orchestration/store/job-advance.js';
import { drainLane } from '../orchestration/store/lane-orchestrator.js';
import { runToQuiescence, type WorkerFixture } from '../orchestration/store/worker.js';
import {
  projectConversationOnce,
  PROJECTABLE_TYPES,
} from '../orchestration/store/conversation-writer.js';
import {
  COLLECTIONS,
  ensureOrchestrationIndexes,
  type OutboxDoc,
  type MailboxDoc,
  type ProjectionDoc,
  type DeliveryDoc,
  type ConversationCursorDoc,
} from '../orchestration/store/collections.js';

const URI = process.env.F8_RS3_URI
  ?? 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const DB = `f8_lost_outbox_${Date.now()}`;
const CHAOS = 'scripts/f8-mongo-chaos.sh';
const CONV = 'conv_f8_outbox';

const okWorker: WorkerFixture = () => ({ status: 'ok', data: { done: true } });

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

console.log('f8:no-lost-outbox');

const store = await connectV2Store({ uri: URI, dbName: DB });
const { client, db } = store;
const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
const mailbox = db.collection<MailboxDoc>(COLLECTIONS.mailbox);
const projections = db.collection<ProjectionDoc>(COLLECTIONS.projections);
const deliveries = db.collection<DeliveryDoc>(COLLECTIONS.deliveries);
const cursors = db.collection<ConversationCursorDoc>(COLLECTIONS.convCursor);

/** Run a job to its terminal state, leaving ONE PENDING projectable event. */
async function terminalJob(commandId: string, goal: string): Promise<string> {
  const acc = await acceptStartCommand(client, db, {
    resourceId: 'res_f8o', conversationId: CONV, commandId, goal, payload: {},
  });
  await planJob(client, db, acc.jobId);
  await runToQuiescence(client, db, drainLane, okWorker);
  return acc.jobId;
}

/** Transactions the SERVER still considers open — the ghosts a wedge queues behind. */
async function openTransactions(): Promise<string> {
  try {
    const res = await db.admin().command({
      aggregate: 1, cursor: {},
      pipeline: [{ $currentOp: { idleSessions: true } }, { $match: { transaction: { $exists: true } } }],
    }) as { cursor?: { firstBatch?: Array<{ transaction?: { parameters?: { txnNumber?: number } }; secs_running?: number }> } };
    const batch = res.cursor?.firstBatch ?? [];
    return batch.length === 0 ? 'none'
      : batch.map((op) => `txn#${op.transaction?.parameters?.txnNumber} running ${op.secs_running ?? '?'}s`).join(', ');
  } catch (err) {
    return `unreadable: ${(err as Error).message.slice(0, 60)}`;
  }
}

/**
 * Project, tolerating the WEDGE a killed commit leaves behind.
 *
 * MEASURED, and it changed this file: after `fail-commit` closes the connection,
 * the transaction is not finished — it is ABANDONED, still open on the server,
 * still holding its write locks on the outbox document. The driver never got to
 * abort it (the commit threw, unlabeled, so `runTxn` rethrows without an abort)
 * and `endSession` will not abort a transaction it believes is committing.
 *
 * So the next projector does not fail because the event is broken. It fails
 * because it is QUEUED BEHIND A GHOST: every attempt write-conflicts, every
 * conflict is labelled `TransientTransactionError`, and `runTxn` burns its budget
 * of 50 retries in about a second — `BoundaryRetryExhaustedError`, which reads
 * like a defect and is not one.
 *
 * The lock clears when MongoDB reaps the abandoned transaction
 * (`transactionLifetimeLimitSeconds`, 60 s by default). That is the honest shape
 * of the property: the event is never LOST, but recovery is not instant, and any
 * caller that treats one `BoundaryRetryExhaustedError` as permanent will strand
 * work that was only ever waiting. In production `reconcile` re-drains on a
 * schedule, which is exactly this loop.
 */
async function projectRetrying(
  c: typeof client, d: typeof db, who: string, deadlineMs = 150_000,
): ReturnType<typeof projectConversationOnce> {
  const start = Date.now();
  let attempts = 0;
  let last = '';
  for (;;) {
    attempts += 1;
    try {
      const r = await projectConversationOnce(c, d);
      console.log(`    ${who} projected after ${Math.round((Date.now() - start) / 1000)}s / ${attempts} attempt(s)`);
      return r;
    } catch (err) {
      last = (err as Error).message;
      if (attempts === 1) console.log(`    ${who} wedged (${last}); open txns: ${await openTransactions()}`);
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `${who} never got through in ${Math.round(deadlineMs / 1000)}s (${attempts} attempts, last: ${last}) — `
          + 'an event nobody can ever project is a lost event, however PENDING it looks',
        );
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

/** The oldest PENDING projectable event — the one the writer would claim next. */
async function pendingEvent(): Promise<OutboxDoc | null> {
  return outbox.findOne(
    { type: { $in: [...PROJECTABLE_TYPES] }, state: 'PENDING' },
    { sort: { createdAt: 1 } },
  );
}

try {
  await ensureOrchestrationIndexes(db);

  const jobId = await terminalJob('cmd_f8o_1', 'praca, o której użytkownik musi się dowiedzieć');
  const event = await pendingEvent();
  assert.ok(event, 'the terminal job must leave a PENDING projectable event — nothing below works without one');
  assert.equal(event!.aggregate, jobId);
  console.log(`  event ${event!._id} (${event!.type}) is PENDING for job ${jobId}`);

  // ── A. the lost-outbox property ────────────────────────────────────────────
  await check('a commit killed mid-projection leaves the event PENDING and NOTHING partial', async () => {
    // A separate, short-lived client: `fail-commit` closes connections, and the
    // pool it poisons must not be the one every assertion below reads through.
    const probe = await connectV2Store({ uri: URI, dbName: DB });
    let threw = false;
    let message = '';
    chaos('fail-commit');
    try {
      await projectConversationOnce(probe.client, probe.db);
    } catch (err) {
      threw = true;
      const cause = (err as { cause?: Error }).cause;
      message = ((cause ?? err) as Error).message;
    } finally {
      chaos('heal');
      await probe.client.close().catch(() => undefined);
    }

    assert.equal(threw, true,
      'the projection must NOT report success when its commit could not land — a silent success here '
      + 'is exactly how an event gets settled without ever reaching the user');
    console.log(`    commit died as expected: ${message.slice(0, 70)}`);

    // The event survives, untouched.
    const after = await outbox.findOne({ _id: event!._id });
    assert.ok(after, 'the event must still EXIST — a deleted event is unrecoverable work');
    assert.equal(after!.state, 'PENDING',
      `the event must still be PENDING, is ${after!.state} — a settled event with no projection IS `
      + 'the lost outbox: the job finished, the user is never told, and nothing ever retries');

    // And nothing partial survives alongside it.
    assert.equal(await mailbox.countDocuments({ logicalEventId: event!._id }), 0,
      'a mailbox slot survived the rolled-back commit — it would block the retry forever');
    assert.equal(await projections.countDocuments({ conversationId: CONV }), 0,
      'a projection survived a commit that never landed');
    assert.equal(await deliveries.countDocuments({ conversationId: CONV }), 0,
      'a delivery survived a commit that never landed');
    assert.equal(await cursors.countDocuments({ _id: CONV }), 0,
      'the conversation sequence advanced for a projection that does not exist — the read model '
      + 'would show a permanent gap');
  });

  // ── B. the retry that must follow ──────────────────────────────────────────
  await check('after healing, the SAME event projects exactly once', async () => {
    const first = await projectRetrying(client, db, 'the healed writer');
    assert.ok(first, 'the healed writer must find the event still waiting');
    assert.equal(first!.applied, true,
      `the surviving event must actually be projected, got ${JSON.stringify(first)}`);
    assert.equal(first!.sequence, 1, 'it takes the first sequence in the conversation');

    assert.equal((await outbox.findOne({ _id: event!._id }))?.state, 'DELIVERED',
      'and only NOW may the event be settled');
    assert.equal(await projections.countDocuments({ conversationId: CONV }), 1,
      'exactly one projection — the failed attempt must not have left a second');
    assert.equal(await deliveries.countDocuments({ conversationId: CONV }), 1,
      'exactly one delivery');

    const proj = await projections.findOne({ conversationId: CONV });
    assert.equal(proj?.jobId, jobId, 'the projection must belong to the job whose event it was');
  });

  await check('nothing projectable is left behind', async () => {
    assert.equal(await pendingEvent(), null,
      'a PENDING projectable event remains after a full drain — that is work still owed to the user');
  });

  // ── C. two projectors, one event ───────────────────────────────────────────
  await check('two projectors racing on ONE event produce ONE projection, and neither dies', async () => {
    // The real deployment shape: more than one writer process, no coordination
    // between them beyond the store. What makes it safe is that BOTH must flip the
    // same outbox document to DELIVERED inside their transaction — the loser
    // write-conflicts there, restarts, and finds nothing pending. (Not the mailbox
    // key: see the header. That protects redelivery, which is check D.)
    const raceJob = await terminalJob('cmd_f8o_2', 'praca dla dwóch projektorów naraz');
    const target = await pendingEvent();
    assert.ok(target, 'the second job must leave its own PENDING event');

    const a = await connectV2Store({ uri: URI, dbName: DB });
    const b = await connectV2Store({ uri: URI, dbName: DB });
    try {
      const [ra, rb] = await Promise.all([
        projectConversationOnce(a.client, a.db),
        projectConversationOnce(b.client, b.db),
      ]);
      // Neither may throw — `Promise.all` above would have rejected and failed
      // this check, which is the point: a projector that crashes on contention
      // is a projector that stops draining.
      const applied = [ra, rb].filter((r) => r?.applied === true);
      assert.equal(applied.length, 1,
        `exactly one of the two must apply, got ${JSON.stringify([ra, rb])} — two is the duplicate `
        + 'message, zero is the lost one');
      console.log(`    winner sequence=${applied[0]!.sequence}, loser=${JSON.stringify([ra, rb].find((r) => r?.applied !== true))}`);

      const projs = await projections.find({ logicalEventId: target!._id }).toArray();
      assert.equal(projs.length, 1, 'exactly one projection for the contested event');
      // Looked up BY the projection rather than by a reconstructed key: keying the
      // assertion on the composite's string format made it fail for a reason that
      // had nothing to do with the property, the moment the format was perturbed.
      assert.equal(await deliveries.countDocuments({ projectionId: projs[0]!._id }), 1,
        'exactly one delivery for the contested event');
      assert.equal((await outbox.findOne({ _id: target!._id }))?.state, 'DELIVERED',
        'the contested event must end settled, not stuck PENDING because both projectors backed off');
      assert.equal(await cursors.findOne({ _id: CONV }).then((c) => c?.sequence), 2,
        'the conversation sequence advanced exactly once for the contested event');
      assert.equal(raceJob, (await projections.findOne({ logicalEventId: target!._id }))?.jobId);
    } finally {
      await a.client.close().catch(() => undefined);
      await b.client.close().catch(() => undefined);
    }
  });

  // ── D. redelivery, the normal case ─────────────────────────────────────────
  await check('a REDELIVERED event settles as applied:false without a second message', async () => {
    // At-least-once transport means the same source event can legitimately come
    // back. Property A above makes the writer retry-safe; this is the other half —
    // retry-safe must not mean project-twice.
    const reset = await outbox.updateOne({ _id: event!._id }, { $set: { state: 'PENDING' } });
    assert.equal(reset.modifiedCount, 1, 'the redelivery must actually re-arm the event');

    const seqBefore = (await cursors.findOne({ _id: CONV }))?.sequence;
    const again = await projectRetrying(client, db, 'the redelivery');
    assert.ok(again, 'the writer must pick the redelivered event up');
    assert.equal(again!.applied, false,
      `a redelivered event must settle as applied:false, got ${JSON.stringify(again)} — applying it `
      + 'again is a duplicate message to the user');

    const projs = await projections.find({ logicalEventId: event!._id }).toArray();
    assert.equal(projs.length, 1,
      'the redelivery created a SECOND projection — the mailbox guard is what must prevent this');
    assert.equal(await deliveries.countDocuments({ projectionId: projs[0]!._id }), 1,
      'the redelivery created a second delivery');
    assert.equal((await cursors.findOne({ _id: CONV }))?.sequence, seqBefore,
      'the conversation sequence moved for a projection that was never written — every later '
      + 'projection would then sit behind a permanent gap');
    assert.equal((await outbox.findOne({ _id: event!._id }))?.state, 'DELIVERED',
      'and the redelivered event must be settled again, not left to loop forever');
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
  console.error(`\n❌ f8:no-lost-outbox — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:no-lost-outbox — a dead commit costs the user nothing: the event waits, '
  + 'and is projected exactly once when the writer comes back');
process.exit(0);
