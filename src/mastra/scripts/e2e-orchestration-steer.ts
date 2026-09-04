#!/usr/bin/env tsx
/**
 * e2e:orchestration-steer — steer_job / append_instruction (plan §8.3).
 *
 *  - append adds context the worker sees on the next attempt (no plan bump);
 *  - pre-plan steer bumps planVersion and the first task inherits that version;
 *  - post-plan steer is rejected until plan-aware authority exists;
 *  - finish_as_evidence is rejected until the A_evidence boundary exists;
 *  - both idempotent, owner-scoped; a terminal job is not steerable;
 *  - both work over HTTP.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  appendInstruction, steerJob, cancelJob, JobNotFoundError,
  UnsupportedActiveAttemptPolicyError, SteerPlanAuthorityUnavailableError,
  claimAttempt, markAttemptPayloadReady, startAttemptOperation, submitAttemptResult,
  drainLane, drainWorkers, runToQuiescence, getJobStatus, planJob,
  COLLECTIONS, type AttemptDoc, type CommandDoc, type JobDoc, type JobEventDoc,
  type OutboxDoc, type ResultDoc, type TaskDoc, type WorkerFixture,
} from '../orchestration/store/index.js';
import { createOrchestrationHttpServer } from '../orchestration/http/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

// echoes goal + instructions so we can assert they reached the worker
const echoWorker: WorkerFixture = (ctx) => ({ status: 'ok', data: { goal: ctx.goal, instructions: ctx.instructions } });

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-steer');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_steer_e2e_${Date.now()}`,
    section: 'e2e:orchestration-steer',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1' };
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const results = db.collection<ResultDoc>(COLLECTIONS.results);
  await ensureOrchestrationIndexes(db);
  const server = createOrchestrationHttpServer({ client, db });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { 'content-type': 'application/json', 'x-resource-id': 'res_1' };
  const resultInstructions = async (jobId: string): Promise<string[]> =>
    ((await results.findOne({ jobId }))?.producer as { data?: { instructions?: string[] } })?.data?.instructions ?? [];

  try {
    await check('append_instruction is visible to the worker (no plan bump)', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'st_append', goal: 'greet', payload: {} });
      const r = await appendInstruction(client, db, { resourceId: base.resourceId, commandId: 'app_1', jobId: acc.jobId, instruction: 'be very formal' });
      assert.equal(r.changed, true);
      assert.equal(r.planVersion, 1, 'append does not bump planVersion');
      await runToQuiescence(client, db, drainLane, echoWorker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED');
      assert.deepEqual(await resultInstructions(acc.jobId), ['be very formal']);
    });

    await check('pre-plan steer bumps authority; first task and worker use the new plan', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'st_steer', goal: 'summarize', payload: {} });
      const r = await steerJob(client, db, { resourceId: base.resourceId, commandId: 'steer_1', jobId: acc.jobId, instruction: 'use bullet points' });
      assert.equal(r.planVersion, 2, 'steer bumps planVersion');
      await runToQuiescence(client, db, drainLane, echoWorker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED');
      const task = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ jobId: acc.jobId });
      assert.equal(task?.planVersion, 2, 'the materialized task inherited current job.planVersion');
      assert.equal(await attempts.countDocuments({ jobId: acc.jobId }), 1, 'only the current-plan attempt ran');
      assert.deepEqual(await resultInstructions(acc.jobId), ['use bullet points']);
    });

    await check('pre-plan steer vs plan race has one coherent authority winner', async () => {
      const acc = await acceptStartCommand(client, db, {
        ...base,
        commandId: 'st_steer_plan_race',
        goal: 'race',
        payload: {},
      });
      const [steer, plan] = await Promise.allSettled([
        steerJob(client, db, {
          resourceId: base.resourceId,
          commandId: 'steer_plan_race',
          jobId: acc.jobId,
          instruction: 'new-plan instruction',
        }),
        planJob(client, db, acc.jobId),
      ]);
      assert.equal(plan.status, 'fulfilled', 'planning retries to the winning authority');

      const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: acc.jobId });
      const materialized = await db.collection<TaskDoc>(COLLECTIONS.tasks).find({ jobId: acc.jobId }).toArray();
      assert.equal(materialized.length, 1, 'exactly one plan was materialized');
      assert.equal(materialized[0]!.planVersion, job?.planVersion, 'task and job authority agree');

      if (steer.status === 'fulfilled') {
        assert.equal(steer.value.changed, true);
        assert.equal(job?.planVersion, 2);
        assert.deepEqual(job?.instructions, ['new-plan instruction']);
        assert.equal(
          await db.collection<CommandDoc>(COLLECTIONS.commands).countDocuments({
            resourceId: base.resourceId,
            commandId: 'steer_plan_race',
          }),
          1,
        );
      } else {
        assert.ok(steer.reason instanceof SteerPlanAuthorityUnavailableError);
        assert.equal(job?.planVersion, 1);
        assert.deepEqual(job?.instructions, []);
        assert.equal(
          await db.collection<CommandDoc>(COLLECTIONS.commands).countDocuments({
            resourceId: base.resourceId,
            commandId: 'steer_plan_race',
          }),
          0,
          'losing steer was not acknowledged',
        );
      }
    });

    await check('post-plan interrupt rejects the A-before-steer-before-B stale-result race', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'st_after_a', goal: 'draft', payload: {} });
      await drainLane(client, db);
      await drainWorkers(client, db, echoWorker); // A commits; B wake remains pending
      const beforeJob = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: acc.jobId });
      const beforeTask = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ jobId: acc.jobId });
      const beforeEvents = await db.collection<JobEventDoc>(COLLECTIONS.events).countDocuments({ jobId: acc.jobId });
      const beforeOutbox = await db.collection<OutboxDoc>(COLLECTIONS.outbox).countDocuments({ aggregate: acc.jobId });
      assert.equal(beforeJob?.terminalOutcome, null, 'B has not run yet');
      assert.equal(beforeTask?.phase, 'AWAITING_RESULT', 'A result is waiting for typed B');

      await assert.rejects(
        () => steerJob(client, db, {
          resourceId: base.resourceId,
          commandId: 'steer_after_a',
          jobId: acc.jobId,
          instruction: 'replace the completed plan',
        }),
        (e: unknown) => e instanceof SteerPlanAuthorityUnavailableError,
      );

      const afterJob = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: acc.jobId });
      const afterTask = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ jobId: acc.jobId });
      assert.equal(afterJob?.planVersion, beforeJob?.planVersion, 'old result did not become authority for a bumped plan');
      assert.deepEqual(afterJob?.instructions, beforeJob?.instructions, 'instruction was not appended');
      assert.equal(afterTask?.phase, beforeTask?.phase, 'task was not rewritten');
      assert.equal(await db.collection<CommandDoc>(COLLECTIONS.commands).countDocuments({
        resourceId: base.resourceId, commandId: 'steer_after_a',
      }), 0, 'rejected steer was not acknowledged');
      assert.equal(await db.collection<JobEventDoc>(COLLECTIONS.events).countDocuments({ jobId: acc.jobId }), beforeEvents);
      assert.equal(await db.collection<OutboxDoc>(COLLECTIONS.outbox).countDocuments({ aggregate: acc.jobId }), beforeOutbox);

      await drainLane(client, db);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED', 'B may finish the unchanged plan');
    });

    await check('finish_as_evidence rejects a RUNNING attempt without changing its authority', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'st_evidence', goal: 'draft', payload: {} });
      await drainLane(client, db); // plan + QUEUED attempt #1
      const queued = await attempts.findOne({ jobId: acc.jobId, attemptNumber: 1 });
      assert.ok(queued);
      const lease = await claimAttempt(client, db, { attemptId: queued._id, workerInstanceId: 'evidence-worker' });
      assert.ok(lease);
      assert.equal(await startAttemptOperation(client, db, {
        attemptId: queued._id,
        leaseOwner: 'evidence-worker',
        attemptFence: lease.attemptFence,
      }), true);
      const before = await getJobStatus(db, base.resourceId, acc.jobId);
      const beforeJob = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: acc.jobId });
      const beforeTask = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ jobId: acc.jobId });
      const beforeAttempt = await attempts.findOne({ jobId: acc.jobId, attemptNumber: 1 });
      const beforeEvents = await db.collection<JobEventDoc>(COLLECTIONS.events).countDocuments({ jobId: acc.jobId });
      const beforeOutbox = await db.collection<OutboxDoc>(COLLECTIONS.outbox).countDocuments({ aggregate: acc.jobId });
      assert.equal(beforeAttempt?.lifecycle, 'RUNNING');

      await assert.rejects(
        () => steerJob(client, db, {
          resourceId: base.resourceId,
          commandId: 'steer_evidence',
          jobId: acc.jobId,
          instruction: 'change direction',
          activeAttemptPolicy: 'finish_as_evidence',
        }),
        (e: unknown) => e instanceof UnsupportedActiveAttemptPolicyError,
      );

      const after = await getJobStatus(db, base.resourceId, acc.jobId);
      const afterJob = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: acc.jobId });
      const afterTask = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ jobId: acc.jobId });
      const afterAttempt = await attempts.findOne({ jobId: acc.jobId, attemptNumber: 1 });
      assert.equal(after?.planVersion, before?.planVersion, 'plan was not bumped');
      assert.deepEqual(afterJob?.instructions, beforeJob?.instructions, 'instruction was not appended');
      assert.equal(afterTask?.phase, beforeTask?.phase, 'task authority was not changed');
      assert.equal(afterAttempt?.lifecycle, beforeAttempt?.lifecycle, 'attempt was not reclassified');
      assert.equal(afterAttempt?.attemptFence, beforeAttempt?.attemptFence, 'attempt authority was not changed');
      assert.equal(afterAttempt?.leaseOwner, beforeAttempt?.leaseOwner, 'attempt owner was not changed');
      assert.equal(afterAttempt?.leaseExpiresAt?.getTime(), beforeAttempt?.leaseExpiresAt?.getTime(), 'lease was not changed');
      assert.equal(
        await db.collection<CommandDoc>(COLLECTIONS.commands).countDocuments({
          resourceId: base.resourceId, commandId: 'steer_evidence',
        }),
        0,
        'unsupported policy was not durably acknowledged',
      );
      assert.equal(
        await db.collection<JobEventDoc>(COLLECTIONS.events).countDocuments({ jobId: acc.jobId }),
        beforeEvents,
        'no JobSteered event was emitted',
      );
      assert.equal(
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).countDocuments({ aggregate: acc.jobId }),
        beforeOutbox,
        'no wake or projectable event was emitted',
      );

      const producer = { status: 'ok', data: { acceptedAfterRejectedSteer: true } };
      const ready = await markAttemptPayloadReady(client, db, {
        attemptId: lease.attemptId,
        leaseOwner: lease.leaseOwner,
        attemptFence: lease.attemptFence,
        producer,
      });
      assert.equal(ready.ready, true);
      const ordinary = await submitAttemptResult(client, db, {
        attemptId: lease.attemptId,
        leaseOwner: lease.leaseOwner,
        attemptFence: lease.attemptFence,
        producer,
        businessPayloadReadyGeneration: ready.generation,
      });
      assert.equal(ordinary.committed, true, 'the rejected request did not revoke the unchanged plan authority');
      await drainLane(client, db);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'COMPLETED');
    });

    await check('steer/append idempotent; terminal job not steerable; owner-scoped', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'st_idem', goal: 'x', payload: {} });
      await steerJob(client, db, { resourceId: base.resourceId, commandId: 'steer_2', jobId: acc.jobId, instruction: 'a' });
      const again = await steerJob(client, db, { resourceId: base.resourceId, commandId: 'steer_2', jobId: acc.jobId, instruction: 'a' });
      assert.equal(again.deduped, true);
      await cancelJob(client, db, { resourceId: base.resourceId, commandId: 'cx', jobId: acc.jobId });
      const afterCancel = await steerJob(client, db, { resourceId: base.resourceId, commandId: 'steer_3', jobId: acc.jobId, instruction: 'b' });
      assert.equal(afterCancel.changed, false, 'terminal job not steerable');
      await assert.rejects(
        () => steerJob(client, db, { resourceId: 'res_OTHER', commandId: 'steer_x', jobId: acc.jobId, instruction: 'b' }),
        (e: unknown) => e instanceof JobNotFoundError,
      );
    });

    await check('steer + append over HTTP', async () => {
      const acc = await (await fetch(`${origin}/v2/conversations/c1/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'st_http', goal: 'g', payload: {} }) })).json() as Record<string, unknown>;
      const jobId = acc.jobId as string;
      const steer = await fetch(`${origin}/v2/jobs/${jobId}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 's_http', type: 'steer_job', instruction: 'concise' }) });
      assert.equal(steer.status, 202);
      assert.equal((await steer.json() as Record<string, unknown>).planVersion, 2);
      const append = await fetch(`${origin}/v2/jobs/${jobId}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'a_http', type: 'append_instruction', instruction: 'polite' }) });
      assert.equal(append.status, 202);
      assert.equal((await append.json() as Record<string, unknown>).instructionCount, 2);
      await drainLane(client, db); // materialize the plan: further steer must fail closed
      const postPlan = await fetch(`${origin}/v2/jobs/${jobId}/commands`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ commandId: 'post_plan_http', type: 'steer_job', instruction: 'unsafe replan' }),
      });
      assert.equal(postPlan.status, 409);
      assert.equal((await postPlan.json() as Record<string, unknown>).error, 'steer_requires_plan_authority');
      const evidence = await fetch(`${origin}/v2/jobs/${jobId}/commands`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          commandId: 'e_http',
          type: 'steer_job',
          instruction: 'preserve old output only as evidence',
          activeAttemptPolicy: 'finish_as_evidence',
        }),
      });
      assert.equal(evidence.status, 409);
      assert.equal(
        (await evidence.json() as Record<string, unknown>).error,
        'active_attempt_policy_not_implemented',
      );
      const invalidPolicy = await fetch(`${origin}/v2/jobs/${jobId}/commands`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          commandId: 'bad_policy_http',
          type: 'steer_job',
          instruction: 'x',
          activeAttemptPolicy: 'keep_running_normally',
        }),
      });
      assert.equal(invalidPolicy.status, 400);
      const missing = await fetch(`${origin}/v2/jobs/${jobId}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'm_http', type: 'steer_job' }) });
      assert.equal(missing.status, 400, 'instruction required');
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-steer — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-steer — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
