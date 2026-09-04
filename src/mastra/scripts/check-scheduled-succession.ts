#!/usr/bin/env tsx
/**
 * GAP-CUTOVER-01 — an autonomous trigger fires neither zero times nor twice.
 *
 * Both failures are invisible, which is the whole reason this exists. Nobody
 * notices a recurrence that silently stopped — a thing that did not happen
 * leaves no trace — and a duplicate just looks like the schedule working harder.
 *
 * TWO REAL DEFECTS, both provable here:
 *
 *  1. **Fires twice.** `markScheduledTaskCompleted` is lease-scoped and returns
 *     null when this runner's lease had already expired and another runner took
 *     the occurrence over. The runner DISCARDED that value and created the next
 *     occurrence anyway, so one fire produced two future rows and the schedule
 *     ran twice from then on, forever.
 *  2. **Fires zero times.** Completion and successor-creation are two writes. A
 *     process that dies between them leaves the recurrence simply stopped — no
 *     error, no failed status, nothing to notice.
 *
 * And one near-miss worth keeping honest about: the first version of the
 * reconciler treated "has no successor row" as "stopped". Occurrences created
 * before this work carry no `succeedsTaskId`, so a historical chain A→B→C reads
 * as three successorless completions — that rule would have resurrected every
 * recurring schedule this system has ever run, several times over, and each one
 * FIRES. The last section pins the guard that replaced it.
 *
 * Runs against the REAL scheduled-task store and the REAL unique index; the bug
 * lives in the interaction between a lease, two writes and Mongo's uniqueness.
 *
 * Run: npx tsx src/mastra/scripts/check-scheduled-succession.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  createScheduledTask,
  findStoppedRecurrences,
  getScheduledTask,
  markScheduledTaskCompleted,
  repairStoppedRecurrence,
  SCHEDULED_TASKS_COLLECTION,
  type ScheduledTask,
} from '../services/scheduled-task-store.js';
import { getDb } from '../lib/mongo.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const TAG = `chk-succ-${Date.now()}`;
const db = await getDb();
const tasks = db.collection<ScheduledTask>(SCHEDULED_TASKS_COLLECTION);

// The unique index IS the mechanism under test, so make sure it exists rather
// than silently proving nothing on a database that never booted the server.
await tasks.createIndex(
  { succeedsTaskId: 1, succession: 1 },
  { unique: true, partialFilterExpression: { succeedsTaskId: { $exists: true } } },
);

console.log('check:scheduled-succession');

const seed = async (over: Partial<Parameters<typeof createScheduledTask>[0]> = {}) =>
  createScheduledTask({
    targetType: 'AGENT',
    targetIdentifier: `researcherAgent-${TAG}`,
    promptOrInstruction: `${TAG} recurring probe`,
    cronExpression: '0 * * * *',
    fireAt: new Date(Date.now() - 1_000),
    ttlMs: 3_600_000,
    ...over,
  } as never);

// ── 1. One occurrence has at most one successor ────────────────────────────
await check('LIVE REGRESSION: a second successor for one occurrence is refused', async () => {
  // Without the unique index, a runner whose lease expired mid-dispatch created
  // a parallel successor and the schedule doubled — permanently.
  const parent = await seed();
  const first = await createScheduledTask({
    targetType: parent.targetType,
    targetIdentifier: parent.targetIdentifier,
    promptOrInstruction: parent.promptOrInstruction,
    cronExpression: parent.schedule.cronExpression,
    chainId: parent.chainId,
    ttlMs: 3_600_000,
    succeedsTaskId: parent.taskId,
    succession: 'recurrence',
  });
  const second = await createScheduledTask({
    targetType: parent.targetType,
    targetIdentifier: parent.targetIdentifier,
    promptOrInstruction: parent.promptOrInstruction,
    cronExpression: parent.schedule.cronExpression,
    chainId: parent.chainId,
    ttlMs: 3_600_000,
    succeedsTaskId: parent.taskId,
    succession: 'recurrence',
  });
  assert.equal(second.taskId, first.taskId, 'the second attempt must converge on the winner');
  const count = await tasks.countDocuments({ succeedsTaskId: parent.taskId, succession: 'recurrence' });
  assert.equal(count, 1, 'one occurrence, one successor — this is what stops a doubled schedule');
});

await check('the two kinds of succession do not collide with each other', async () => {
  const parent = await seed();
  await createScheduledTask({
    targetType: 'AGENT', targetIdentifier: parent.targetIdentifier,
    promptOrInstruction: parent.promptOrInstruction, fireAt: new Date(Date.now() + 60_000),
    chainId: parent.chainId, ttlMs: 3_600_000,
    succeedsTaskId: parent.taskId, succession: 'next_step',
  });
  await createScheduledTask({
    targetType: 'AGENT', targetIdentifier: parent.targetIdentifier,
    promptOrInstruction: parent.promptOrInstruction, cronExpression: '0 * * * *',
    chainId: parent.chainId, ttlMs: 3_600_000,
    succeedsTaskId: parent.taskId, succession: 'recurrence',
  });
  assert.equal(await tasks.countDocuments({ succeedsTaskId: parent.taskId }), 2,
    'a chain step and a recurrence are different successions of the same occurrence');
});

await check('an ordinary task claims no succession key', async () => {
  // If they did, every unsucceeded task would collide on a missing key and the
  // whole scheduler would stop accepting work.
  const a = await seed();
  const b = await seed();
  const docs = await tasks.find({ taskId: { $in: [a.taskId, b.taskId] } }).toArray();
  assert.equal(docs.length, 2);
  for (const d of docs) assert.ok(!('succeedsTaskId' in d), 'absent, not null');
});

// ── 2. Only the runner that WON the completion may advance the schedule ────
await check('LIVE REGRESSION: a runner that lost its lease cannot complete', async () => {
  // This is the gate the runner now honours. Before, the return value was
  // discarded and the loser still wrote the next occurrence.
  //
  // The takeover is staged by writing the lease directly rather than calling
  // `leaseDueScheduledTask`, which claims ANY due task in the collection — on a
  // machine with real schedules this check would otherwise reach out and lease
  // one of the operator's, flipping a production row to `leased` to make a point
  // about locking.
  const task = await seed();
  const staleLeaseId = randomUUID();
  const freshLeaseId = randomUUID();
  const now = new Date();
  await tasks.updateOne({ taskId: task.taskId }, {
    $set: {
      status: 'running',
      lease: { leaseId: staleLeaseId, leasedAt: now, expiresAt: new Date(now.getTime() - 1), runnerId: `${TAG}-A` },
    },
  });
  // Runner B takes the expired occurrence over — the same write the lease query makes.
  await tasks.updateOne({ taskId: task.taskId }, {
    $set: {
      status: 'leased',
      lease: { leaseId: freshLeaseId, leasedAt: now, expiresAt: new Date(now.getTime() + 60_000), runnerId: `${TAG}-B` },
    },
  });

  const lost = await markScheduledTaskCompleted({ taskId: task.taskId, leaseId: staleLeaseId });
  assert.equal(lost, null, 'the loser must be told it no longer owns this occurrence');
  assert.notEqual((await getScheduledTask(task.taskId))?.status, 'completed',
    'and must not have closed it either');

  const won = await markScheduledTaskCompleted({ taskId: task.taskId, leaseId: freshLeaseId });
  assert.ok(won, 'the owner completes normally');
  assert.equal((await getScheduledTask(task.taskId))?.status, 'completed');
});

// NOT TESTED HERE, and not pretended to be: the runner acting on that null.
// Making it fire behaviourally needs a second runner to steal the lease BETWEEN
// this runner's lease and its completion, and `processOneDueScheduledTask` has
// no seam to interleave at — every version of that test is either racy or
// reaches out and leases a real operator schedule to make its point. An earlier
// draft asserted on the runner's SOURCE TEXT instead, which is the mistake this
// project already paid for once (an assertion that broke on reformatting while
// the property it defended was intact). So: the mechanism above is proven, the
// three-line guard that consumes it is reviewed, and that difference is stated
// rather than papered over.

// ── 3. A stopped recurrence is found — and a healthy one is not ────────────
await check('LIVE REGRESSION: a recurrence whose successor was never written is reported', async () => {
  const chainId = `${TAG}-stopped`;
  const task = await seed({ chainId });
  await tasks.updateOne(
    { taskId: task.taskId },
    { $set: { status: 'completed', completedAt: new Date() } },
  );
  const stopped = await findStoppedRecurrences();
  const mine = stopped.find((s) => s.chainId === chainId);
  assert.ok(mine, 'a chain with nothing pending and nothing running has stopped firing');
  assert.equal(mine!.taskId, task.taskId);
  assert.equal(mine!.cronExpression, '0 * * * *');
});

await check('a chain that still has a pending occurrence is NOT reported', async () => {
  const chainId = `${TAG}-alive`;
  const ran = await seed({ chainId });
  await tasks.updateOne({ taskId: ran.taskId }, { $set: { status: 'completed', completedAt: new Date() } });
  await seed({ chainId, fireAt: new Date(Date.now() + 3_600_000) });
  const stopped = await findStoppedRecurrences();
  assert.ok(!stopped.some((s) => s.chainId === chainId), 'the schedule is alive; there is nothing to repair');
});

await check('SECURITY: a HISTORICAL unlinked chain is not mass-resurrected', async () => {
  // The near-miss. Occurrences from before this work carry no `succeedsTaskId`,
  // so "has no successor row" would have flagged every link of every past chain
  // — and each repair FIRES. The guard is chain liveness, not linkage.
  const chainId = `${TAG}-history`;
  for (let i = 0; i < 3; i++) {
    const t = await seed({ chainId });
    await tasks.updateOne({ taskId: t.taskId }, { $set: { status: 'completed', completedAt: new Date() } });
  }
  await seed({ chainId, fireAt: new Date(Date.now() + 3_600_000) }); // the live head
  const stopped = await findStoppedRecurrences();
  assert.equal(stopped.filter((s) => s.chainId === chainId).length, 0,
    'three unlinked completed occurrences with a live head are ONE healthy schedule, not three stopped ones');
});

await check('a CANCELLED chain is a decision, not a fault', async () => {
  const chainId = `${TAG}-cancelled`;
  const ran = await seed({ chainId });
  await tasks.updateOne({ taskId: ran.taskId }, { $set: { status: 'completed', completedAt: new Date() } });
  const stoppedByUser = await seed({ chainId });
  await tasks.updateOne({ taskId: stoppedByUser.taskId }, { $set: { status: 'cancelled' } });
  const stopped = await findStoppedRecurrences();
  assert.ok(!stopped.some((s) => s.chainId === chainId), 'restarting what an operator cancelled would be worse than stopping');
});

await check('an EXPIRED chain is not resurrected', async () => {
  const chainId = `${TAG}-expired`;
  const t = await seed({ chainId, ttlMs: 60_000 });
  await tasks.updateOne(
    { taskId: t.taskId },
    { $set: { status: 'completed', completedAt: new Date(), expiresAt: new Date(Date.now() - 1_000) } },
  );
  const stopped = await findStoppedRecurrences();
  assert.ok(!stopped.some((s) => s.chainId === chainId));
});

// ── 4. Repair is explicit, and idempotent ──────────────────────────────────
await check('repair restarts a stopped recurrence exactly once', async () => {
  const chainId = `${TAG}-repair`;
  const task = await seed({ chainId });
  await tasks.updateOne({ taskId: task.taskId }, { $set: { status: 'completed', completedAt: new Date() } });

  const first = await repairStoppedRecurrence(task.taskId);
  assert.ok(first, 'a stopped schedule can be restarted');
  assert.equal(first!.succeedsTaskId, task.taskId);
  assert.equal(first!.status, 'scheduled');

  const second = await repairStoppedRecurrence(task.taskId);
  assert.equal(second?.taskId, first!.taskId, 'repairing twice restarts the schedule once');
  assert.equal(await tasks.countDocuments({ succeedsTaskId: task.taskId, succession: 'recurrence' }), 1);

  assert.ok(!(await findStoppedRecurrences()).some((s) => s.chainId === chainId),
    'and the chain stops being reported once it is alive again');
});

await check('repair refuses anything that is not a completed recurrence', async () => {
  const pending = await seed();
  assert.equal(await repairStoppedRecurrence(pending.taskId), null, 'a live occurrence needs no repair');
  assert.equal(await repairStoppedRecurrence(`${TAG}-does-not-exist`), null);

  const oneShot = await seed({ cronExpression: undefined, fireAt: new Date(Date.now() - 1_000) });
  await tasks.updateOne({ taskId: oneShot.taskId }, { $set: { status: 'completed' } });
  assert.equal(await repairStoppedRecurrence(oneShot.taskId), null, 'a one-shot task recurs by definition never');
});

await tasks.deleteMany({ $or: [
  { promptOrInstruction: { $regex: TAG } },
  { chainId: { $regex: `^${TAG}` } },
  { targetIdentifier: { $regex: TAG } },
] });

console.log(failures === 0 ? '\n✅ check:scheduled-succession passed' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
