#!/usr/bin/env tsx
/**
 * e2e:orchestration-children — same-job child tasks / dispatch edges (§15.5,
 * ORC-DISPATCH-EDGE-01).
 *
 *  - a parent spawns child tasks (fan-out) and does not succeed until every
 *    REQUIRED child settles (fan-in);
 *  - a failed REQUIRED child fails the parent (and the job);
 *  - a failed OPTIONAL child does not fail the parent.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  planJob, spawnChildTasks, drainLane, runToQuiescence, getJobStatus,
  COLLECTIONS, type TaskDoc, type DispatchEdgeDoc, type ResultDoc, type WorkerFixture,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

// echoes the (per-task) goal; fails when the goal asks it to
const childWorker: WorkerFixture = (ctx) => ctx.goal.includes('fail')
  ? { status: 'failed', error: { code: 'child_error', message: 'boom' } }
  : { status: 'ok', data: { goal: ctx.goal } };

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-children');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_children_e2e_${Date.now()}`,
    section: 'e2e:orchestration-children',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1' };
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const edges = db.collection<DispatchEdgeDoc>(COLLECTIONS.edges);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);

  try {
    await ensureOrchestrationIndexes(db);

    await check('fan-out/fan-in: parent waits for children → all SUCCEEDED → job COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'ch_ok', goal: 'coordinate reviews', payload: {} });
      const plan = await planJob(client, db, acc.jobId);
      const { childTaskIds } = await spawnChildTasks(client, db, { jobId: acc.jobId, parentTaskId: plan!.taskId, children: [{ goal: 'review A' }, { goal: 'review B' }] });
      assert.equal(childTaskIds.length, 2);
      assert.equal((await tasks.findOne({ _id: plan!.taskId }))?.phase, 'WAITING_DEPENDENCY');

      await runToQuiescence(client, db, drainLane, childWorker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED');
      assert.equal((await tasks.findOne({ _id: plan!.taskId }))?.phase, 'SUCCEEDED', 'parent resolved SUCCEEDED');
      for (const id of childTaskIds) assert.equal((await tasks.findOne({ _id: id }))?.phase, 'SUCCEEDED');
      assert.equal(await edges.countDocuments({ parentTaskId: plan!.taskId, lifecycle: 'SETTLED' }), 2, 'edges settled');
      const goals = (await results.find({ jobId: acc.jobId, status: 'ok' }).toArray()).map((r) => (r.producer as { data?: { goal?: string } }).data?.goal).sort();
      assert.deepEqual(goals, ['review A', 'review B'], 'each child ran its own goal');
    });

    await check('a failed REQUIRED child fails the parent → job FAILED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'ch_reqfail', goal: 'x', payload: {} });
      const plan = await planJob(client, db, acc.jobId);
      await spawnChildTasks(client, db, { jobId: acc.jobId, parentTaskId: plan!.taskId, children: [{ goal: 'ok child' }, { goal: 'fail child' }] });
      await runToQuiescence(client, db, drainLane, childWorker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'FAILED');
      assert.equal((await tasks.findOne({ _id: plan!.taskId }))?.phase, 'FAILED', 'parent failed');
    });

    await check('a failed OPTIONAL child does NOT fail the parent → job COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'ch_optfail', goal: 'x', payload: {} });
      const plan = await planJob(client, db, acc.jobId);
      await spawnChildTasks(client, db, { jobId: acc.jobId, parentTaskId: plan!.taskId, children: [{ goal: 'req ok', completionMode: 'REQUIRED' }, { goal: 'opt fail', completionMode: 'OPTIONAL' }] });
      await runToQuiescence(client, db, drainLane, childWorker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED');
      assert.equal((await tasks.findOne({ _id: plan!.taskId }))?.phase, 'SUCCEEDED');
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-children — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-children — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
