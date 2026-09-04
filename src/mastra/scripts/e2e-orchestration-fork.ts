#!/usr/bin/env tsx
/**
 * e2e:orchestration-fork — fork_job (plan §8.7).
 *
 *  - fork creates a new, independent DETACHED job; the source is unchanged;
 *  - the fork snapshots the source goal + instructions;
 *  - fork is idempotent and owner-scoped;
 *  - fork works over HTTP and the new job runs to completion on its own.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  cancelJob, appendInstruction, forkJob, JobNotFoundError,
  drainLane, runToQuiescence, getJobStatus,
  COLLECTIONS, type ResultDoc, type JobDoc, type WorkerFixture,
} from '../orchestration/store/index.js';
import { createOrchestrationHttpServer } from '../orchestration/http/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const echoWorker: WorkerFixture = (ctx) => ({ status: 'ok', data: { goal: ctx.goal, instructions: ctx.instructions } });

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-fork');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_fork_e2e_${Date.now()}`,
    section: 'e2e:orchestration-fork',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1' };
  await ensureOrchestrationIndexes(db);
  const server = createOrchestrationHttpServer({ client, db });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { 'content-type': 'application/json', 'x-resource-id': 'res_1' };

  try {
    await check('fork a cancelled job → new DETACHED job runs; source unchanged', async () => {
      const src = await acceptStartCommand(client, db, { ...base, commandId: 'fk_src', goal: 'first attempt', payload: {} });
      await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'fk_cancel', jobId: src.jobId });
      const fork = await forkJob(client, db, { resourceId: base.resourceId, commandId: 'fk_fork', parentJobId: src.jobId });
      assert.notEqual(fork.jobId, src.jobId);
      const forked = await getJobStatus(db, base.resourceId, fork.jobId);
      assert.equal(forked?.parentJobId, src.jobId);
      // source unchanged
      assert.equal((await getJobStatus(db, base.resourceId, src.jobId))?.terminalOutcome, 'CANCELLED');
      // forked job runs independently
      await runToQuiescence(client, db, drainLane, echoWorker);
      assert.equal((await getJobStatus(db, base.resourceId, fork.jobId))?.terminalOutcome, 'COMPLETED');
      const jdoc = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: fork.jobId });
      assert.equal(jdoc?.jobRelationMode, 'DETACHED');
    });

    await check('fork snapshots the source goal + instructions', async () => {
      const src = await acceptStartCommand(client, db, { ...base, commandId: 'fk_src2', goal: 'do the thing', payload: {} });
      await appendInstruction(client, db, { resourceId: base.resourceId, commandId: 'fk_app', jobId: src.jobId, instruction: 'be brief' });
      const fork = await forkJob(client, db, { resourceId: base.resourceId, commandId: 'fk_fork2', parentJobId: src.jobId });
      await runToQuiescence(client, db, drainLane, echoWorker);
      const result = await db.collection<ResultDoc>(COLLECTIONS.results).findOne({ jobId: fork.jobId });
      const data = (result?.producer as { data?: { goal?: string; instructions?: string[] } })?.data;
      assert.equal(data?.goal, 'do the thing', 'goal snapshotted');
      assert.deepEqual(data?.instructions, ['be brief'], 'instructions snapshotted');
    });

    await check('fork idempotent + owner-scoped', async () => {
      const src = await acceptStartCommand(client, db, { ...base, commandId: 'fk_src3', goal: 'x', payload: {} });
      const f1 = await forkJob(client, db, { resourceId: base.resourceId, commandId: 'fk_idem', parentJobId: src.jobId });
      const f2 = await forkJob(client, db, { resourceId: base.resourceId, commandId: 'fk_idem', parentJobId: src.jobId });
      assert.equal(f2.jobId, f1.jobId, 'same commandId → same forked job');
      assert.equal(f2.deduped, true);
      await assert.rejects(
        () => forkJob(client, db, { resourceId: 'res_OTHER', commandId: 'fk_x', parentJobId: src.jobId }),
        (e: unknown) => e instanceof JobNotFoundError,
      );
    });

    await check('fork over HTTP → 202 with new jobId + parentJobId', async () => {
      const src = await (await fetch(`${origin}/v2/conversations/c1/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'fk_http_src', goal: 'g', payload: {} }) })).json() as Record<string, unknown>;
      const parentId = src.jobId as string;
      const res = await fetch(`${origin}/v2/jobs/${parentId}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'fk_http', type: 'fork_job', goal: 'retry it' }) });
      assert.equal(res.status, 202);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.parentJobId, parentId);
      assert.notEqual(body.jobId, parentId);
      const forked = await (await fetch(`${origin}/v2/jobs/${body.jobId}`, { headers: auth })).json() as Record<string, unknown>;
      assert.equal(forked.parentJobId, parentId);
      assert.equal(forked.goal, 'retry it');
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-fork — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-fork — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
