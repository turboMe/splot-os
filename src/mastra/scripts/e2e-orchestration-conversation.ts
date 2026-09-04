#!/usr/bin/env tsx
/**
 * e2e:orchestration-conversation — the C boundary (§4.4/§7.5, ORC-TXN-C-01):
 * the Conversation Writer drains terminal and awaiting-input job events into the
 * user's conversation.
 *
 *  - a terminal job produces exactly one durable projection + one PENDING delivery;
 *  - re-draining is an idempotent no-op (exactly-once *logically*);
 *  - projections take a monotonic per-conversation sequence, independent per convo;
 *  - a transport ACK flips the delivery PENDING→DELIVERED (idempotent);
 *  - a FAILED job is projected too (writer is outcome-agnostic).
 *  - an AWAITING_USER request is projected once, without re-waking the lane, and
 *    is followed by the terminal result after the answer.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  planJob, drainLane, runToQuiescence, getJobStatus,
  drainConversation, getConversationProjections, markDelivered, reconcile,
  answerJobRequest,
  COLLECTIONS, type ProjectionDoc, type DeliveryDoc, type OutboxDoc, type WorkerFixture,
} from '../orchestration/store/index.js';
import { createOrchestrationApi } from '../orchestration/http/handlers.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const okWorker: WorkerFixture = () => ({ status: 'ok', data: { done: true } });
const failWorker: WorkerFixture = () => ({ status: 'failed', error: { code: 'boom', message: 'nope' } });
const askThenAnswer: WorkerFixture = (ctx) => ctx.attemptNumber === 1
  ? { status: 'blocked', blocked: { kind: 'user', action: 'Which city?', expiresAt: null } }
  : { status: 'ok', data: { instructions: ctx.instructions } };

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-conversation');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_conv_e2e_${Date.now()}`,
    section: 'e2e:orchestration-conversation',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const projections = db.collection<ProjectionDoc>(COLLECTIONS.projections);
  const deliveries = db.collection<DeliveryDoc>(COLLECTIONS.deliveries);

  /** Accept + plan + run a job to terminal in conversation `conv`. */
  async function runJob(commandId: string, conv: string, goal: string, worker: WorkerFixture): Promise<string> {
    const acc = await acceptStartCommand(client, db, { resourceId: 'res_1', conversationId: conv, commandId, goal, payload: {} });
    await planJob(client, db, acc.jobId);
    await runToQuiescence(client, db, drainLane, worker);
    return acc.jobId;
  }

  try {
    await ensureOrchestrationIndexes(db);

    await check('terminal job → one projection + one PENDING delivery carrying the outcome', async () => {
      const jobId = await runJob('c_ok', 'conv_ok', 'zbadaj pogodę', okWorker);
      assert.equal((await getJobStatus(db, 'res_1', jobId))?.terminalOutcome, 'COMPLETED');

      const n = await drainConversation(client, db);
      assert.equal(n, 1, 'exactly one event projected');

      const projs = await getConversationProjections(db, 'conv_ok');
      assert.equal(projs.length, 1);
      assert.equal(projs[0]!.jobId, jobId);
      assert.equal(projs[0]!.sequence, 1, 'first projection in a conversation is sequence 1');
      assert.equal((projs[0]!.payload as { terminalOutcome?: string }).terminalOutcome, 'COMPLETED');
      assert.equal((projs[0]!.payload as { goal?: string }).goal, 'zbadaj pogodę');

      const dlv = await deliveries.find({ conversationId: 'conv_ok' }).toArray();
      assert.equal(dlv.length, 1, 'exactly one delivery');
      assert.equal(dlv[0]!.state, 'PENDING', 'delivery starts PENDING (transport ACKs later)');
    });

    await check('re-draining is an idempotent no-op (exactly-once logically)', async () => {
      const before = await projections.countDocuments({ conversationId: 'conv_ok' });
      const beforeDlv = await deliveries.countDocuments({ conversationId: 'conv_ok' });
      const n = await drainConversation(client, db);
      assert.equal(n, 0, 'nothing new projected on re-drain');
      assert.equal(await projections.countDocuments({ conversationId: 'conv_ok' }), before, 'no duplicate projection');
      assert.equal(await deliveries.countDocuments({ conversationId: 'conv_ok' }), beforeDlv, 'no duplicate delivery');
    });

    await check('sequence is monotonic within a conversation, independent across conversations', async () => {
      // second job in the SAME conversation → sequence 2
      await runJob('c_ok2', 'conv_ok', 'druga sprawa', okWorker);
      await drainConversation(client, db);
      const projs = await getConversationProjections(db, 'conv_ok');
      assert.deepEqual(projs.map((p) => p.sequence), [1, 2], 'ordered 1,2 in the same conversation');

      // a different conversation restarts at 1
      await runJob('c_other', 'conv_other', 'inna rozmowa', okWorker);
      await drainConversation(client, db);
      const other = await getConversationProjections(db, 'conv_other');
      assert.equal(other.length, 1);
      assert.equal(other[0]!.sequence, 1, 'independent conversation restarts at 1');

      // cursor read: after sequence 1, only the second projection remains
      const tail = await getConversationProjections(db, 'conv_ok', 1);
      assert.deepEqual(tail.map((p) => p.sequence), [2], 'afterSequence cursor works');
    });

    await check('transport ACK flips delivery PENDING→DELIVERED and is idempotent', async () => {
      const dlv = (await deliveries.find({ conversationId: 'conv_other' }).toArray())[0]!;
      assert.equal(dlv.state, 'PENDING');
      assert.equal(await markDelivered(client, db, dlv._id), true, 'first ACK applies');
      assert.equal((await deliveries.findOne({ _id: dlv._id }))?.state, 'DELIVERED');
      assert.equal(await markDelivered(client, db, dlv._id), false, 'second ACK is a no-op');
    });

    await check('HTTP read model is ordered, cursored, and owner-scoped (§5.2 fail-closed)', async () => {
      const api = createOrchestrationApi(client, db);
      const owner = { resourceId: 'res_1', principalId: 'res_1' };
      const foreign = { resourceId: 'res_OTHER', principalId: 'res_OTHER' };

      const r = await api.getConversation(owner, 'conv_ok', 0);
      assert.equal(r.status, 200);
      assert.deepEqual((r.body.messages as Array<{ sequence: number }>).map((m) => m.sequence), [1, 2], 'owner sees ordered projections');
      assert.equal(r.body.nextCursor, 2, 'nextCursor = last sequence');

      const tail = await api.getConversation(owner, 'conv_ok', 1);
      assert.deepEqual((tail.body.messages as Array<{ sequence: number }>).map((m) => m.sequence), [2], 'cursor after=1 → only seq 2');

      const denied = await api.getConversation(foreign, 'conv_ok', 0);
      assert.equal(denied.status, 200);
      assert.equal((denied.body.messages as unknown[]).length, 0, 'foreign resource sees nothing (no disclosure)');
    });

    await check('a FAILED job is projected too (writer is outcome-agnostic)', async () => {
      const jobId = await runJob('c_fail', 'conv_fail', 'zadanie które padnie', failWorker);
      assert.equal((await getJobStatus(db, 'res_1', jobId))?.terminalOutcome, 'FAILED');
      await drainConversation(client, db);
      const projs = await getConversationProjections(db, 'conv_fail');
      assert.equal(projs.length, 1);
      assert.equal((projs[0]!.payload as { terminalOutcome?: string }).terminalOutcome, 'FAILED');
    });

    await check('AWAITING_USER is projected once, releases the lane, then terminal follows the answer', async () => {
      const jobId = await runJob('c_await', 'conv_await', 'sprawdź pogodę', askThenAnswer);
      const waiting = await getJobStatus(db, 'res_1', jobId);
      assert.equal(waiting?.phase, 'AWAITING_USER');
      assert.equal(waiting?.terminalOutcome, null);
      assert.ok(waiting?.openRequest, 'request is durable and visible in the job read model');

      const firstTick = await reconcile(client, db);
      assert.equal(firstTick.projected, 1, 'reconciler projects the question');
      assert.equal(firstTick.rewoken, 0, 'intentional wait does not get a lane wake');
      assert.equal(
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).countDocuments({
          aggregate: jobId, type: 'LaneWakeRequested', state: 'PENDING',
        }),
        0,
        'waiting releases lane compute ownership',
      );
      assert.equal(
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).countDocuments({
          aggregate: jobId, type: 'JobAwaitingInput', state: 'DELIVERED',
        }),
        1,
        'the source event is settled by the C boundary',
      );
      assert.equal((await getJobStatus(db, 'res_1', jobId))?.phase, 'AWAITING_USER');

      const first = await getConversationProjections(db, 'conv_await');
      assert.equal(first.length, 1);
      assert.equal(first[0]!.sequence, 1);
      const question = first[0]!.payload as {
        kind?: string;
        requestId?: string;
        requestKind?: string;
        action?: string;
        expiresAt?: string;
      };
      assert.equal(question.kind, 'job_awaiting_input');
      assert.equal(question.requestId, waiting!.openRequest!.requestId);
      assert.equal(question.requestKind, 'user');
      assert.equal(question.action, 'Which city?');
      assert.equal(question.expiresAt, waiting!.openRequest!.expiresAt.toISOString());
      assert.equal(
        await deliveries.countDocuments({ conversationId: 'conv_await', state: 'PENDING' }),
        1,
        'question has one pending transport delivery',
      );

      const secondTick = await reconcile(client, db);
      assert.equal(secondTick.projected, 0, 'second tick does not duplicate the question');
      assert.equal(secondTick.rewoken, 0, 'second tick remains a full wait no-op');

      await answerJobRequest(client, db, {
        resourceId: 'res_1',
        commandId: 'c_await_answer',
        jobId,
        requestId: waiting!.openRequest!.requestId,
        answer: 'Reykjavík',
      });
      await runToQuiescence(client, db, drainLane, askThenAnswer);
      assert.equal((await getJobStatus(db, 'res_1', jobId))?.terminalOutcome, 'COMPLETED');
      assert.equal((await reconcile(client, db)).projected, 1, 'terminal event is projected after the answer');

      const completed = await getConversationProjections(db, 'conv_await');
      assert.deepEqual(completed.map((p) => p.sequence), [1, 2]);
      assert.deepEqual(
        completed.map((p) => (p.payload as { kind?: string }).kind),
        ['job_awaiting_input', 'job_terminal'],
      );
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-conversation — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-conversation — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
