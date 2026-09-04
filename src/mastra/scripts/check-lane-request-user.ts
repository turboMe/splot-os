#!/usr/bin/env tsx
/**
 * F5B increment 4 — the lane can ask the user a question (§4.2: the Lane
 * Orchestrator may "formulate a question for the user").
 *
 * A lane question is asked while PLANNING, before any task or attempt exists, so
 * it is bound to the job alone (`taskId: null`). That is a real difference from
 * the existing `blocked`-producer request, and it is where the bugs live: two
 * consumers previously assumed a task and would have made such a question
 * permanently unanswerable or permanently un-expirable.
 *
 * What this pins:
 *  1. The loop CLOSES: lane asks → job waits → answer → job plans again with the
 *     answer as an instruction. An unanswerable question is worse than no
 *     question, because the job blocks forever.
 *  2. Expiry works. Without it a lane question that nobody answers would hang
 *     the job for good — the task-bound path skips requests whose task is
 *     missing, which for a lane question is always.
 *  3. One open question at a time, so a retried activation cannot stack
 *     questions the user must answer one by one.
 *
 * Runs against a REAL replica-set database.
 *
 * Run: npx tsx src/mastra/scripts/check-lane-request-user.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const TEST_DATABASE = `lru_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const {
  ensureOrchestrationIndexes, acceptStartCommand,
  runLaneForJob, answerJobRequest, expireStaleRequests, getOpenRequest,
  getJobStatus, COLLECTIONS,
} = await import('../orchestration/store/index.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

/** A decider that asks once, then plans normally. */
function askingDecider(question: string) {
  let asked = false;
  return (async () => {
    if (!asked) { asked = true; return { kind: 'request_user', question }; }
    return { kind: 'dispatch', attemptMode: 'SERIAL' };
  }) as never;
}

async function main(): Promise<void> {
  console.log('check:lane-request-user');

  const store = await connectReplicaSetOrSkip({ dbName: TEST_DATABASE, section: 'check:lane-request-user' });
  if (!store) process.exit(0);
  const { client, db } = store;
  await ensureOrchestrationIndexes(db);

  const RESOURCE = 'res_lane_request';
  let seq = 0;
  async function newJob(goal: string): Promise<string> {
    seq++;
    const accepted = await acceptStartCommand(client, db, {
      resourceId: RESOURCE,
      conversationId: `conv_${seq}`,
      goal,
      commandId: `cmd_${randomUUID()}`,
      payload: { goal },
    });
    return accepted.jobId;
  }

  await check('the lane asks: the job waits on a durable question, and no task is created', async () => {
    const jobId = await newJob('needs clarification');
    await runLaneForJob(client, db, jobId, 10, undefined, { decide: askingDecider('Which quarter?') } as never);

    const status = await getJobStatus(db, RESOURCE, jobId);
    assert.equal(status?.phase, 'AWAITING_USER', 'the job must be waiting on the human');
    assert.ok(status?.openRequest, 'the question must be durable and visible');
    assert.equal(status.openRequest.action, 'Which quarter?');
    assert.equal(
      await db.collection(COLLECTIONS.tasks).countDocuments({ jobId }),
      0,
      'asking is not planning — no work may be created before the answer',
    );
  });

  await check('THE LOOP CLOSES: answering resumes the job and records the answer', async () => {
    const jobId = await newJob('answerable job');
    await runLaneForJob(client, db, jobId, 10, undefined, { decide: askingDecider('Which environment?') } as never);
    const open = await getOpenRequest(db, jobId);
    assert.ok(open, 'a question must be open');

    const answered = await answerJobRequest(client, db, {
      resourceId: RESOURCE,
      commandId: `answer_${randomUUID()}`,
      jobId,
      requestId: open.requestId,
      answer: 'production',
    });
    assert.equal(answered.applied, true, 'a lane question must be answerable — the whole point of asking');

    const status = await getJobStatus(db, RESOURCE, jobId);
    assert.equal(status?.phase, 'READY', 'answering returns the job to the lane');
    assert.equal(status?.openRequest, null);
    const job = await db.collection<{ _id: string; instructions: string[] }>(COLLECTIONS.jobs)
      .findOne({ _id: jobId });
    assert.ok(
      job?.instructions.some((i) => i.includes('production')),
      'the answer must reach the next plan as an instruction, or asking achieved nothing',
    );
  });

  await check('after the answer the lane plans normally', async () => {
    const jobId = await newJob('plan after answer');
    const decide = askingDecider('Ready to proceed?');
    await runLaneForJob(client, db, jobId, 10, undefined, { decide } as never);
    const open = await getOpenRequest(db, jobId);
    assert.ok(open);
    await answerJobRequest(client, db, {
      resourceId: RESOURCE, commandId: `answer_${randomUUID()}`, jobId,
      requestId: open.requestId, answer: 'yes',
    });
    await runLaneForJob(client, db, jobId, 10, undefined, { decide } as never);
    assert.equal(
      await db.collection(COLLECTIONS.tasks).countDocuments({ jobId }),
      1,
      'the second activation must plan the work it was waiting to clarify',
    );
  });

  await check('an unanswered question EXPIRES rather than blocking the job forever', async () => {
    const jobId = await newJob('expiring question');
    await runLaneForJob(client, db, jobId, 10, undefined, { decide: askingDecider('Anyone there?') } as never);
    const open = await getOpenRequest(db, jobId);
    assert.ok(open);

    // Force the deadline into the past, then run the reconciler's expiry pass.
    await db.collection<{ _id: string; expiresAt: Date }>(COLLECTIONS.requests)
      .updateOne({ _id: open.requestId }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
    const expired = await expireStaleRequests(client, db);
    assert.ok(expired >= 1, 'a lane question must be expirable — it has no task, and the old path skipped those');
    assert.equal(await getOpenRequest(db, jobId), null, 'the question must no longer be open');
  });

  await check('only one question at a time — a retried activation does not stack them', async () => {
    const jobId = await newJob('repeat asker');
    // A decider that asks every time, as a looping/retrying lane would.
    const alwaysAsk = (async () => ({ kind: 'request_user', question: 'Again?' })) as never;
    await runLaneForJob(client, db, jobId, 10, undefined, { decide: alwaysAsk } as never);
    await runLaneForJob(client, db, jobId, 10, undefined, { decide: alwaysAsk } as never);
    const openCount = await db.collection(COLLECTIONS.requests).countDocuments({ jobId, state: 'OPEN' });
    assert.equal(openCount, 1, 'the user must not be handed a queue of duplicate questions');
  });

  await check('the existing task-bound request path is untouched', async () => {
    // The nullable taskId must not have loosened the normal `blocked`-producer
    // path, which still binds its request to a real task and attempt.
    const jobId = await newJob('normal planning');
    await runLaneForJob(client, db, jobId, 10, undefined, undefined);
    assert.equal(
      await db.collection(COLLECTIONS.tasks).countDocuments({ jobId }),
      1,
      'planning without a decider must behave exactly as before',
    );
    assert.equal(await getOpenRequest(db, jobId), null, 'and must open no question');
  });

  await db.dropDatabase().catch(() => undefined);
  await store.close();

  if (failures > 0) {
    console.error(`\n❌ check:lane-request-user — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:lane-request-user — the lane can ask, the user can answer, and an ignored question expires');
  process.exit(0);
}

main().catch((error) => { console.error(`check failed: ${(error as Error).message}`); process.exit(1); });
