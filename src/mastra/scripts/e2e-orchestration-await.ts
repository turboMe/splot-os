#!/usr/bin/env tsx
/**
 * e2e:orchestration-await — AWAITING_USER + answer_job_request (§8.8/§8.9).
 *
 *  - a `blocked:user` result parks the job in AWAITING_USER with an open request
 *    (no re-dispatch, no terminalization);
 *  - answer_job_request re-opens the task; a fresh attempt runs with the answer
 *    and the job completes;
 *  - an unanswered request past its deadline expires → job TIMED_OUT;
 *  - answering a closed request / wrong owner is rejected;
 *  - it all works over HTTP.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  answerJobRequest, expireStaleRequests, RequestNotOpenError, JobNotFoundError,
  drainLane, runToQuiescence, getJobStatus,
  COLLECTIONS, type ControlRequestDoc, type ResultDoc, type WorkerFixture,
} from '../orchestration/store/index.js';
import { createOrchestrationHttpServer } from '../orchestration/http/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

// asks the user on attempt #1, then completes using the answer (instructions)
const askThenAnswer: WorkerFixture = (ctx) => ctx.attemptNumber === 1
  ? { status: 'blocked', blocked: { kind: 'user', action: 'Which city?', expiresAt: null } }
  : { status: 'ok', data: { instructions: ctx.instructions } };
const alwaysAsk: WorkerFixture = () => ({ status: 'blocked', blocked: { kind: 'user', action: 'Which city?', expiresAt: null } });

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-await');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_await_e2e_${Date.now()}`,
    section: 'e2e:orchestration-await',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1' };
  const requests = db.collection<ControlRequestDoc>(COLLECTIONS.requests);
  await ensureOrchestrationIndexes(db);
  const server = createOrchestrationHttpServer({ client, db });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { 'content-type': 'application/json', 'x-resource-id': 'res_1' };

  try {
    await check('blocked:user parks the job in AWAITING_USER with an open request', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'aw_block', goal: 'weather?', payload: {} });
      await runToQuiescence(client, db, drainLane, askThenAnswer);
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.phase, 'AWAITING_USER');
      assert.equal(st?.terminalOutcome, null, 'not terminalized');
      assert.equal(st?.openRequest?.kind, 'user');
      assert.equal(st?.openRequest?.action, 'Which city?');
    });

    await check('answer re-opens the task; a fresh attempt uses the answer → COMPLETED', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'aw_answer', goal: 'weather?', payload: {} });
      await runToQuiescence(client, db, drainLane, askThenAnswer);
      const req = (await getJobStatus(db, base.resourceId, acc.jobId))!.openRequest!;
      const r = await answerJobRequest(client, db, { resourceId: base.resourceId, commandId: 'ans_1', jobId: acc.jobId, requestId: req.requestId, answer: 'London' });
      assert.equal(r.applied, true);
      await runToQuiescence(client, db, drainLane, askThenAnswer);
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.terminalOutcome, 'COMPLETED');
      const result = await db.collection<ResultDoc>(COLLECTIONS.results).findOne({ jobId: acc.jobId, status: 'ok' });
      const instr = (result?.producer as { data?: { instructions?: string[] } })?.data?.instructions ?? [];
      assert.ok(instr.some((i) => i.includes('London')), `answer reached the worker: ${JSON.stringify(instr)}`);
    });

    await check('an unanswered request past its deadline expires → job TIMED_OUT', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'aw_expire', goal: 'x', payload: {} });
      await runToQuiescence(client, db, drainLane, alwaysAsk);
      // force the request past its deadline, then expire it
      await requests.updateOne({ jobId: acc.jobId, state: 'OPEN' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      assert.ok(await expireStaleRequests(client, db) >= 1);
      await runToQuiescence(client, db, drainLane, alwaysAsk);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'TIMED_OUT');
    });

    await check('answering a closed/expired request or wrong owner is rejected', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'aw_reject', goal: 'x', payload: {} });
      await runToQuiescence(client, db, drainLane, alwaysAsk);
      const req = (await getJobStatus(db, base.resourceId, acc.jobId))!.openRequest!;
      await requests.updateOne({ _id: req.requestId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await expireStaleRequests(client, db); // now EXPIRED
      await assert.rejects(
        () => answerJobRequest(client, db, { resourceId: base.resourceId, commandId: 'ans_2', jobId: acc.jobId, requestId: req.requestId, answer: 'x' }),
        (e: unknown) => e instanceof RequestNotOpenError,
      );
      await assert.rejects(
        () => answerJobRequest(client, db, { resourceId: 'res_OTHER', commandId: 'ans_3', jobId: acc.jobId, requestId: req.requestId, answer: 'x' }),
        (e: unknown) => e instanceof JobNotFoundError,
      );
    });

    await check('await + answer over HTTP', async () => {
      const acc = await (await fetch(`${origin}/v2/conversations/c1/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'aw_http', goal: 'weather?', payload: {} }) })).json() as Record<string, unknown>;
      const jobId = acc.jobId as string;
      await runToQuiescence(client, db, drainLane, askThenAnswer);
      const st = await (await fetch(`${origin}/v2/jobs/${jobId}`, { headers: auth })).json() as { openRequest?: { requestId: string } };
      assert.ok(st.openRequest?.requestId, 'GET shows the open request');
      const ans = await fetch(`${origin}/v2/jobs/${jobId}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'a_http', type: 'answer_job_request', requestId: st.openRequest!.requestId, answer: 'Paris' }) });
      assert.equal(ans.status, 202);
      await runToQuiescence(client, db, drainLane, askThenAnswer);
      const done = await (await fetch(`${origin}/v2/jobs/${jobId}`, { headers: auth })).json() as Record<string, unknown>;
      assert.equal(done.terminalOutcome, 'COMPLETED');
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-await — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-await — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
