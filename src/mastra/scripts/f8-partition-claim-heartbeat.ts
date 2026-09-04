#!/usr/bin/env tsx
/**
 * f8:partition-claim-heartbeat — a worker cut off from Mongo mid-work is refused
 * ONLY if something else moved on without it. If nothing did, it must finish.
 *
 * THE PLAN'S OWN WARNING ABOUT THIS SCENARIO
 * -------------------------------------------
 * "Ta druga połowa jest ważniejsza i łatwiejsza do przeoczenia: system, który po
 * każdej czkawce sieciowej wyrzuca pracę, jest bezpieczny i bezużyteczny." A
 * store that fences out every worker who blinked would trivially satisfy "no
 * duplicate effect" by never finishing anything. So this file leads with the
 * half that is easy to get right by accident and easy to break by being
 * over-cautious, THEN proves the refusal half separately.
 *
 * FAULT MECHANISM: PIN, THEN PARTITION
 * -------------------------------------
 * `partition <node>` freezes a whole Mongo container (`docker pause`) — it
 * cuts the NODE off, not a particular client. To make that equal "this ONE
 * worker lost its path to Mongo" without partitioning the whole set, the
 * worker's connection is pinned with `directConnection` to the node being
 * partitioned (the plan's own suggested shortcut over a 3-way partition or
 * client-side iptables). The pin is only a fault-injection device for the
 * OUTAGE window — see each arm for why it is or is not still valid afterward.
 *
 * WHAT IT PROVES, THREE ARMS
 * --------------------------
 * ARM 1 (must finish): claim → start → PARTITION the primary for 6s (well
 * under the ~15s election timeout — measured in `f8-mongo-chaos.sh`'s own
 * header — so no failover happens) → once healed, the SAME pinned client
 * freezes its payload and submits. All succeed. Nothing reaped it; nothing
 * outraced it; the lease's own clock never lapsed. This is pure LAZY
 * enforcement: no active reaper runs anywhere in this arm.
 *
 * ARM 2 (the boundary, same mechanism, sign flipped): identical to ARM 1 —
 * same partition, same node, same outage length — with ONE number changed:
 * the lease ttl is shorter than the outage. Nothing reaps it here either, and
 * nothing takes it over. It is refused anyway, purely because
 * `markAttemptPayloadReady`'s own commit filter requires
 * `leaseExpiresAt > $$NOW` at the moment it is called (attempts.ts:1345) — a
 * check with no reaper and no rival attempt behind it. Arm 1 and arm 2 are the
 * same code path with one input changed; the fact that changing it flips the
 * outcome IS the falsification — a check that passes regardless of the ttl
 * would mean neither arm proves anything about timing at all.
 *
 * ARM 3 (fenced out — the OTHER half the plan names, "lease... wygasł I ZOSTAŁ
 * PRZEJĘTY"): claim → PARTITION the primary for 25s, long enough to force a
 * REAL election (unlike arm 1/2, `partition` here, not `kill` — the point is
 * to exercise the verb the plan calls out for this scenario, distinct from
 * `f8:no-duplicate-effect`'s `kill`). After healing, reap the now-expired
 * lease, dispatch and claim a replacement, let it finish — then the ORIGINAL
 * worker's stale identity is refused, and specifically for the FENCE, not the
 * clock: by the time it tries, both conditions hold, but only the fence is
 * exclusive to "someone else moved on" rather than "time passed."
 *
 * WHY ARM 3'S FINAL CALL DOES NOT REUSE THE PINNED CLIENT
 * ---------------------------------------------------------
 * A 25s outage is long enough that the OTHER two nodes elect a replacement;
 * when the partitioned node heals it rejoins as SECONDARY (measured in
 * `f8-mongo-chaos.sh`'s header). A client still pinned to it would fail at the
 * DRIVER level (not writable primary) — true, but uninteresting, and it would
 * hide whether the STORE's fence check works at all. A real worker's driver
 * does not stay wired to one dead node forever; once its network heals it
 * rediscovers the current primary like any client does (proven directly in
 * `f8:stepdown-lease-renewal`). So arm 3's belated submit uses a normally
 * routed client — the same one every other F8 scenario uses — landing
 * cleanly on the business-level refusal instead of a topology error.
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 * - Not `f8:no-duplicate-effect`'s territory again: arm 3's REFUSAL mechanism
 *   (fence check in `submitAttemptResult`) is the SAME one proven and
 *   falsified there. What is new here is the FAULT VERB (`partition`, not
 *   `kill`) and the worker-side pinned-connection framing the plan asks for.
 * - Not what happens if the worker is disconnected from the WHOLE set (all
 *   three nodes, or client-side iptables) rather than one pinned node. The
 *   plan names that as the more faithful but more expensive alternative;
 *   pinning to the node being partitioned is its documented shortcut.
 * - Not `renewLease` specifically (`f8:stepdown-lease-renewal` covers that
 *   call). This file exercises the LIFECYCLE transitions
 *   (start/payload-ready/submit) that a worker mid-operation actually makes.
 *
 * ARM 3'S REFUSAL IS FOUR-LAYERED, AND NO SINGLE LINE FALSIFIES IT ALONE
 * -------------------------------------------------------------------------
 * The first attempt at falsifying arm 3 removed just the top fence comparison
 * (`attempts.ts:1558`) and the check stayed GREEN — measured, not assumed away.
 * Tracing it live (each layer disabled one at a time, printing the actual
 * refusal reason) found FOUR independent barriers stacked in
 * `submitAttemptResult`, each catching what the one before it would have missed:
 *
 *   1. `attempts.ts:1558` — the top fence comparison, refuses first;
 *   2. `attempts.ts:1562` — `leaseOwnerAtCommit !== input.leaseOwner`, inside the
 *      `lifecycle === 'FINISHED'` branch;
 *   3. `attempts.ts:1565` — `committedPayloadHash !== prepared.payloadHash`;
 *   4. `attempts.ts:1587` — the unconditional fall-through at the end of that
 *      branch: a FINISHED attempt is refused by DEFAULT unless one of a narrow
 *      set of exact-idempotent-resubmit shapes matches.
 *
 * Disabling any one, two, or three of these left the check GREEN — the next
 * layer simply caught it, sometimes with a DIFFERENT reason string (this is
 * how `payload_hash_mismatch` surfaced instead of `stale_fence_or_lease`
 * partway through). Only disabling all four together produced the true
 * unguarded outcome: `committed:true`, the takeover's protection erased. This
 * is a stronger, more precise version of the trap `f8-no-duplicate-effect`
 * already names (fence vs. lifecycle) — here it is four deep, not two, and the
 * honest conclusion is the same shape: this file proves the OVERALL property
 * (a fenced-out, superseded worker cannot commit) is real and over-determined,
 * not that any ONE of these four lines is individually load-bearing for THIS
 * scenario. Each is presumably load-bearing for some OTHER call shape this file
 * does not construct.
 *
 * FALSIFIED BY (RUN, verified to turn ✗ — and the three partial attempts that
 * did NOT, verified too, because each one matters for the next reader):
 * - arm 2 IS arm 1's falsification: the only input that changes is the ttl,
 *   and it flips "all succeed" into "refused, stale_fence_or_lease_or_cutoff".
 * - arm 3: disabling all four layers above TOGETHER — not any subset —
 *   turns it ✗: "the stale worker's belated submit COMMITTED".
 *
 * REQUIRES the three-node set: `npm run infra:rs3:up`.
 * Run: npm run f8:partition-claim-heartbeat
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
  startAttemptOperation,
  markAttemptPayloadReady,
  submitAttemptResult,
  reapExpiredLeases,
} from '../orchestration/store/attempts.js';
import {
  COLLECTIONS,
  ensureOrchestrationIndexes,
  type AttemptDoc,
  type TaskDoc,
} from '../orchestration/store/collections.js';

const HOSTS = ['localhost:27019', 'localhost:27020', 'localhost:27021'];
const URI = process.env.F8_RS3_URI ?? `mongodb://${HOSTS.join(',')}/?replicaSet=rs3f8`;
const DB = `f8_partition_${Date.now()}`;
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

/** `f8-mongo-chaos.sh` addresses nodes by bare port, not `host:port`. */
function portOf(hostPort: string): string {
  return hostPort.split(':')[1]!;
}

async function pinned(host: string): Promise<MongoClient> {
  const c = new MongoClient(`mongodb://${host}/?directConnection=true`, {
    serverSelectionTimeoutMS: 8_000, socketTimeoutMS: 8_000,
  });
  await c.connect();
  return c;
}

console.log('f8:partition-claim-heartbeat');

const store = await connectV2Store({ uri: URI, dbName: DB });
const { client, db } = store;

/** One fresh job+task+attempt, dispatched and ready to claim. */
async function freshAttempt(
  commandId: string, goal: string,
): Promise<{ jobId: string; taskId: string; attemptId: string }> {
  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_f8p', conversationId: `conv_f8p_${commandId}`, goal, commandId, payload: {},
  });
  const taskId = await createTask(client, db, accepted.jobId);
  const { attemptId } = await dispatchAttempt(client, db, { jobId: accepted.jobId, taskId });
  return { jobId: accepted.jobId, taskId, attemptId };
}

try {
  await ensureOrchestrationIndexes(db);

  // ── ARM 1: a short outage well within the lease — must finish ─────────────
  await check('ARM 1 — a worker cut off for less time than its lease finishes normally', async () => {
    const node = await currentPrimary();
    const worker = await pinned(node);
    try {
      const { taskId, attemptId } = await freshAttempt('cmd_f8p_1', 'work that outlasts a short outage');
      const lease = await claimAttempt(worker, worker.db(DB), {
        attemptId, workerInstanceId: 'worker-1', leaseTtlMs: 20_000,
      });
      assert.ok(lease, 'the worker must get the lease');
      const fence = lease!.attemptFence;
      assert.equal(await startAttemptOperation(worker, worker.db(DB), {
        attemptId, leaseOwner: 'worker-1', attemptFence: fence,
      }), true, 'starting the operation must succeed before the outage');

      chaos('partition', portOf(node), '6'); // blocks ~9s (6s paused + 3s settle), auto-heals

      const producer = { status: 'ok', data: { text: 'worker-1 finished after a short outage' } };
      const ready = await markAttemptPayloadReady(worker, worker.db(DB), {
        attemptId, leaseOwner: 'worker-1', attemptFence: fence, producer,
      });
      assert.equal(ready.ready, true,
        `freezing the payload must succeed — the lease never actually lapsed, got: ${JSON.stringify(ready.reason)}`);
      const submitted = await submitAttemptResult(worker, worker.db(DB), {
        attemptId, leaseOwner: 'worker-1', attemptFence: fence, producer,
        businessPayloadReadyGeneration: ready.generation,
      });
      assert.equal(submitted.committed, true,
        `the submit must commit, got: ${JSON.stringify(submitted.reason)} — refusing a worker that `
        + 'never lost its lease just because it had a network hiccup makes every hiccup a lost job');

      const task = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ _id: taskId });
      assert.equal(task?.phase, 'SUCCEEDED');
    } finally {
      await worker.close().catch(() => undefined);
    }
  });

  // ── ARM 2: the SAME outage, a lease too short to survive it — refused ─────
  await check('ARM 2 — the boundary: same outage, a shorter ttl is refused by the clock alone', async () => {
    const node = await currentPrimary();
    const worker = await pinned(node);
    try {
      const { attemptId } = await freshAttempt('cmd_f8p_2', 'work whose lease cannot outlast the outage');
      // The ONLY difference from arm 1: this ttl is shorter than the 6s outage
      // below. No reaper runs in this arm, and nothing else claims this attempt
      // — if this is refused, it is the lease clock alone doing it.
      const lease = await claimAttempt(worker, worker.db(DB), {
        attemptId, workerInstanceId: 'worker-2', leaseTtlMs: 3_000,
      });
      assert.ok(lease, 'the worker must get the lease');
      const fence = lease!.attemptFence;
      assert.equal(await startAttemptOperation(worker, worker.db(DB), {
        attemptId, leaseOwner: 'worker-2', attemptFence: fence,
      }), true, 'starting the operation must succeed before the outage');

      chaos('partition', portOf(node), '6'); // same outage as arm 1 — only the ttl above differs

      const producer = { status: 'ok', data: { text: 'worker-2 should never land' } };
      const ready = await markAttemptPayloadReady(worker, worker.db(DB), {
        attemptId, leaseOwner: 'worker-2', attemptFence: fence, producer,
      });
      assert.equal(ready.ready, false,
        'freezing the payload must be REFUSED once the lease has lapsed — succeeding here means the '
        + 'clock check in markAttemptPayloadReady is not actually enforced');
      assert.match(String(ready.reason ?? ''), /stale|fence|lease|cutoff/i,
        `the refusal must name the reason, got: ${JSON.stringify(ready.reason)}`);

      // Nobody reaped this attempt and nobody else claimed it — confirm the
      // refusal was the CLOCK, not a phantom takeover.
      const att = await db.collection<AttemptDoc>(COLLECTIONS.attempts).findOne({ _id: attemptId });
      assert.notEqual(att?.outcome, 'WORKER_LOST', 'the attempt must not have been reaped — nothing ran the reaper in this arm');
      assert.equal(att?.lifecycle, 'RUNNING', 'the attempt is still RUNNING — only the NEXT transition is refused, lazily');
    } finally {
      await worker.close().catch(() => undefined);
    }
  });

  // ── ARM 3: a long outage forces a real takeover — the old worker is fenced ─
  let survivorTaskId = '';
  let survivorAttemptId = '';
  await check('ARM 3 — a real election during a long partition: the takeover claims the fence', async () => {
    const node = await currentPrimary();
    const worker = await pinned(node);
    const { jobId, taskId, attemptId } = await freshAttempt('cmd_f8p_3', 'work that must happen exactly once');
    survivorTaskId = taskId;
    let staleFence = 0;
    try {
      const lease = await claimAttempt(worker, worker.db(DB), {
        attemptId, workerInstanceId: 'worker-3a', leaseTtlMs: 5_000,
      });
      assert.ok(lease, 'worker-3a must get the lease');
      staleFence = lease!.attemptFence;
      console.log(`  worker-3a holds the lease, fence=${staleFence}, node=${node}`);

      chaos('partition', portOf(node), '25'); // long enough to force an election
    } finally {
      await worker.close().catch(() => undefined);
    }

    const start = Date.now();
    let elected = false;
    while (Date.now() - start < 30_000) {
      try {
        const p = await currentPrimary();
        if (p !== node) { elected = true; break; }
      } catch { /* mid-election */ }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    assert.ok(elected, 'the set must elect a DIFFERENT primary within 30s — otherwise nothing below is real');

    const reaped = await reapExpiredLeases(client, db);
    assert.ok(reaped >= 1, `the expired lease must be reaped, got ${reaped}`);
    const lost = await db.collection<AttemptDoc>(COLLECTIONS.attempts).findOne({ _id: attemptId });
    assert.equal(lost?.outcome, 'WORKER_LOST');
    assert.ok((lost?.attemptFence ?? 0) > staleFence, 'the fence must have advanced past what worker-3a holds');

    const next = await dispatchAttempt(client, db, { jobId, taskId });
    const leaseB = await claimAttempt(client, db, { attemptId: next.attemptId, workerInstanceId: 'worker-3b', leaseTtlMs: 60_000 });
    assert.ok(leaseB, 'worker-3b must claim the takeover');
    survivorAttemptId = next.attemptId;
    const fenceB = leaseB!.attemptFence;

    const producer = { status: 'ok', data: { text: 'worker-3b finished after the takeover' } };
    assert.equal(await startAttemptOperation(client, db, { attemptId: next.attemptId, leaseOwner: 'worker-3b', attemptFence: fenceB }), true);
    const ready = await markAttemptPayloadReady(client, db, { attemptId: next.attemptId, leaseOwner: 'worker-3b', attemptFence: fenceB, producer });
    assert.equal(ready.ready, true, 'the takeover worker must be able to freeze its payload');
    const fresh = await submitAttemptResult(client, db, {
      attemptId: next.attemptId, leaseOwner: 'worker-3b', attemptFence: fenceB, producer,
      businessPayloadReadyGeneration: ready.generation,
    });
    assert.equal(fresh.committed, true, `the takeover must commit, got: ${JSON.stringify(fresh.reason)}`);

    // ── the stale identity, reconnected normally, is refused for the FENCE ──
    const stale = await submitAttemptResult(client, db, {
      attemptId, leaseOwner: 'worker-3a', attemptFence: staleFence,
      producer: { status: 'ok', data: { text: 'worker-3a should never land — it was cut off and replaced' } },
    });
    assert.equal(stale.committed, false,
      'the stale worker\'s belated submit COMMITTED — the takeover did not protect the work at all');
    assert.match(String(stale.reason ?? ''), /stale|fence|lease|cutoff/i,
      `the refusal must name the reason, got: ${JSON.stringify(stale.reason)}`);
    console.log(`  worker-3a refused: ${stale.reason}`);
  });

  await check('ARM 3 — exactly ONE result exists for the task, and it is the takeover\'s', async () => {
    const results = await db.collection(COLLECTIONS.results).find({ taskId: survivorTaskId } as never).toArray();
    assert.equal(results.length, 1, `exactly one result, found ${results.length}`);
    assert.match(JSON.stringify(results[0]), /worker-3b finished/);
    const survivor = await db.collection<AttemptDoc>(COLLECTIONS.attempts).findOne({ _id: survivorAttemptId });
    assert.equal(survivor?.lifecycle, 'FINISHED');
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
  console.error(`\n❌ f8:partition-claim-heartbeat — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ f8:partition-claim-heartbeat — a worker that never lost its lease finishes; '
  + 'one that did, and was replaced, is refused');
process.exit(0);
