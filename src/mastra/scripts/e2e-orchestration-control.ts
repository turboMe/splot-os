#!/usr/bin/env tsx
/**
 * e2e:orchestration-control — pause / resume control plane (plan §8.4).
 *
 *  - pause before work stops new dispatch (no task/attempt created while paused);
 *  - resume re-wakes and the job completes;
 *  - pause/resume are idempotent; resume is a no-op when not paused;
 *  - cancel wins over a pause (stop is terminal);
 *  - pause/resume work over HTTP.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  pauseJob, resumeJob, cancelJob,
  drainLane, drainWorkers, runToQuiescence, okWorker, getJobStatus,
  COLLECTIONS, type AttemptDoc, type TaskDoc,
} from '../orchestration/store/index.js';
import { createOrchestrationHttpServer } from '../orchestration/http/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-control');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_control_e2e_${Date.now()}`,
    section: 'e2e:orchestration-control',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1', goal: 'controllable work' };
  await ensureOrchestrationIndexes(db);
  const server = createOrchestrationHttpServer({ client, db });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { 'content-type': 'application/json', 'x-resource-id': 'res_1' };

  try {
    await check('pause before work stops new dispatch; resume → COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'ctl_pause', payload: { op: 'p' } });
      const p = await pauseJob(client, db, { resourceId: base.resourceId, commandId: 'pause_1', jobId: acc.jobId });
      assert.equal(p.controlState, 'PAUSE_REQUESTED');
      assert.equal(p.changed, true);
      // lane + workers must NOT create any task/attempt while paused
      await drainLane(client, db);
      await drainWorkers(client, db, okWorker);
      assert.equal(await db.collection<TaskDoc>(COLLECTIONS.tasks).countDocuments({ jobId: acc.jobId }), 0, 'no task while paused');
      assert.equal(await db.collection<AttemptDoc>(COLLECTIONS.attempts).countDocuments({ jobId: acc.jobId }), 0, 'no attempt while paused');
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.controlState, 'PAUSE_REQUESTED');

      const r = await resumeJob(client, db, { resourceId: base.resourceId, commandId: 'resume_1', jobId: acc.jobId });
      assert.equal(r.controlState, 'NONE');
      await runToQuiescence(client, db, drainLane, okWorker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED');
    });

    await check('pause/resume idempotent; resume no-op when not paused', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'ctl_idem', payload: { op: 'i' } });
      await pauseJob(client, db, { resourceId: base.resourceId, commandId: 'pause_2', jobId: acc.jobId });
      const again = await pauseJob(client, db, { resourceId: base.resourceId, commandId: 'pause_2', jobId: acc.jobId });
      assert.equal(again.deduped, true);
      await resumeJob(client, db, { resourceId: base.resourceId, commandId: 'resume_2', jobId: acc.jobId });
      const noop = await resumeJob(client, db, { resourceId: base.resourceId, commandId: 'resume_2b', jobId: acc.jobId });
      assert.equal(noop.changed, false, 'resume on a non-paused job is a no-op');
    });

    await check('cancel wins over pause (stop is terminal)', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'ctl_cancel', payload: { op: 'c' } });
      await pauseJob(client, db, { resourceId: base.resourceId, commandId: 'pause_3', jobId: acc.jobId });
      const cancelled = await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cancel_3', jobId: acc.jobId });
      assert.equal(cancelled.terminalOutcome, 'CANCELLED');
      // a resume after cancel must not revive it
      const r = await resumeJob(client, db, { resourceId: base.resourceId, commandId: 'resume_3', jobId: acc.jobId });
      assert.equal(r.changed, false);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'CANCELLED');
    });

    await check('pause + resume over HTTP', async () => {
      const acc = await (await fetch(`${origin}/v2/conversations/c1/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'ctl_http', goal: 'http', payload: {} }) })).json() as Record<string, unknown>;
      const jobId = acc.jobId as string;
      const pause = await fetch(`${origin}/v2/jobs/${jobId}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'p_http', type: 'pause_job' }) });
      assert.equal(pause.status, 202);
      assert.equal((await pause.json() as Record<string, unknown>).controlState, 'PAUSE_REQUESTED');
      const resume = await fetch(`${origin}/v2/jobs/${jobId}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'r_http', type: 'resume_job' }) });
      assert.equal(resume.status, 202);
      assert.equal((await resume.json() as Record<string, unknown>).controlState, 'NONE');
      await runToQuiescence(client, db, drainLane, okWorker);
      const st = await (await fetch(`${origin}/v2/jobs/${jobId}`, { headers: auth })).json() as Record<string, unknown>;
      assert.equal(st.terminalOutcome, 'COMPLETED');
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-control — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-control — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
