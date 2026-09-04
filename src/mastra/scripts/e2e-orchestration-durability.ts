#!/usr/bin/env tsx
/**
 * e2e:orchestration-durability — crash-window recovery matrix (plan §20.3, G4).
 *
 * For each point where a process could crash mid-flight, we leave the job in that
 * partial state, then run a "restarted process" = reconcile + run-to-quiescence,
 * and assert the job always reaches COMPLETED EXACTLY ONCE — one result, a clean
 * contiguous event log, no duplicate attempts. This is the direct evidence that
 * the refactor is crash-safe, not "broken until the end".
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  claimNextWake, laneStep, drainLane, drainWorkers, runToQuiescence, okWorker,
  reconcile, getJobStatus,
  COLLECTIONS, type AttemptDoc, type ResultDoc, type JobEventDoc,
} from '../orchestration/store/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-durability');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_dur_e2e_${Date.now()}`,
    section: 'e2e:orchestration-durability',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1', goal: 'crash-safe work' };

  /** After any partial state: a restarted process reconciles + runs to quiescence. */
  async function restartAndAssertCompleted(jobId: string): Promise<void> {
    await reconcile(client, db);
    await runToQuiescence(client, db, drainLane, okWorker);
    const st = await getJobStatus(db, base.resourceId, jobId);
    assert.equal(st?.terminalOutcome, 'COMPLETED', `job ${jobId} completed`);
    // exactly one result, one succeeded attempt worth of provenance
    assert.equal(await db.collection<ResultDoc>(COLLECTIONS.results).countDocuments({ jobId }), 1, 'exactly one result');
    // contiguous event log, no gaps or duplicate sequences
    const evs = await db.collection<JobEventDoc>(COLLECTIONS.events).find({ jobId }).sort({ sequence: 1 }).toArray();
    evs.forEach((e, i) => assert.equal(e.sequence, i, 'contiguous event sequence'));
    assert.equal(evs[evs.length - 1]?.type, 'JobTerminalized');
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('crash after accept (wake pending, nothing else) → resume → COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'dur_accept', payload: { op: '1' } });
      await restartAndAssertCompleted(acc.jobId); // never manually planned/dispatched
    });

    await check('crash after plan, before dispatch (wake consumed, no attempt) → reconciler re-wakes → COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'dur_plan', payload: { op: '2' } });
      const handle = await claimNextWake(client, db); // materialize the activation
      assert.equal(handle?.jobId, acc.jobId);
      const step = await laneStep(client, db, acc.jobId, {
        activationDispatchGeneration: handle!.activationDispatchGeneration,
        planningActivationId: handle!.planningActivationId,
      }); // commit the plan, then "crash"
      assert.equal(step.action, 'planned');
      // The durable successor wake lets a restarted lane continue dispatch.
      await restartAndAssertCompleted(acc.jobId);
    });

    await check('crash after dispatch, before worker (attempt QUEUED) → worker resumes → COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'dur_dispatch', payload: { op: '3' } });
      await drainLane(client, db); // plan + dispatch; attempt QUEUED, no worker ran
      assert.equal(await db.collection<AttemptDoc>(COLLECTIONS.attempts).countDocuments({ jobId: acc.jobId, lifecycle: 'QUEUED' }), 1);
      await restartAndAssertCompleted(acc.jobId);
    });

    await check('crash after A result, before B reduction (result wake pending) → resume → COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'dur_result', payload: { op: '4' } });
      await drainLane(client, db);         // plan + dispatch
      await drainWorkers(client, db, okWorker); // worker submits → result wake pending, lane NOT run
      // job still DISPATCHING; a result wake is pending
      assert.notEqual((await getJobStatus(db, base.resourceId, acc.jobId))?.phase, 'TERMINAL');
      await restartAndAssertCompleted(acc.jobId);
    });

    await check('repeated reconcile ticks are idempotent (no duplicate work)', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'dur_idem', payload: { op: '5' } });
      // hammer reconcile before, during and after — must not duplicate anything
      for (let i = 0; i < 3; i++) await reconcile(client, db);
      await drainLane(client, db);
      for (let i = 0; i < 3; i++) await reconcile(client, db);
      await restartAndAssertCompleted(acc.jobId);
      for (let i = 0; i < 3; i++) await reconcile(client, db); // post-terminal reconcile is a no-op
      assert.equal(await db.collection<AttemptDoc>(COLLECTIONS.attempts).countDocuments({ jobId: acc.jobId }), 1, 'exactly one attempt');
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-durability — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-durability — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
