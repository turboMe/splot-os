#!/usr/bin/env tsx
/**
 * F5B/FINAL_DECISION — the lane judges finished work before the job closes.
 *
 * This is the increment where a model gains the power to make a job run LONGER,
 * inside the transaction chain that owns terminalization. So the tests are
 * mostly about that power being bounded and every failure resolving toward
 * FINISHING:
 *
 *  1. WITHOUT a judge, nothing changes — the drain terminalizes exactly as
 *     before. This is the shipped default, so it is asserted first.
 *  2. A judge can genuinely order another attempt (retry/replan).
 *  3. THE BOUND HOLDS. A judge that always retries is stopped by the Service,
 *     with an operator alert — otherwise one confused model turns a job into an
 *     unbounded token burn.
 *  4. Every unsafe path finishes: a throwing judge, an invalid decision, a
 *     paused job. None may leave the job alive forever.
 *  5. Terminal outcome still comes from TASK STATE, never from what the model
 *     said — a judge claiming COMPLETED cannot whitewash a failed task.
 *
 * Runs against a REAL replica set with the lane driven manually.
 *
 * Run: npx tsx src/mastra/scripts/check-final-decision.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const TEST_DATABASE = `fdc_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const {
  ensureOrchestrationIndexes, acceptStartCommand,
  runLaneForJob, drainWorkers, okWorker, pauseJob, COLLECTIONS,
  getOpenRequest, answerJobRequest,
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

async function main(): Promise<void> {
  console.log('check:final-decision');

  const store = await connectReplicaSetOrSkip({ dbName: TEST_DATABASE, section: 'check:final-decision' });
  if (!store) process.exit(0);
  const { client, db } = store;
  await ensureOrchestrationIndexes(db);

  let seq = 0;
  async function newJob(goal: string): Promise<string> {
    seq++;
    const accepted = await acceptStartCommand(client, db, {
      resourceId: 'res_final', conversationId: `conv_${seq}`, goal,
      commandId: `cmd_${randomUUID()}`, payload: { goal },
    });
    return accepted.jobId;
  }

  /** Drive lane + worker to quiescence. */
  async function drive(jobId: string, decide?: unknown, turns = 14): Promise<void> {
    for (let i = 0; i < turns; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, decide ? { decide } as never : undefined);
      await drainWorkers(client, db, okWorker);
    }
  }

  const tasksOf = (jobId: string) => db.collection(COLLECTIONS.tasks).countDocuments({ jobId });
  const jobOf = (jobId: string) => db
    .collection<{ _id: string; terminalOutcome: string | null; phase: string }>(COLLECTIONS.jobs)
    .findOne({ _id: jobId });

  /** Plan first, then answer the evaluate question with `evaluation`. */
  function judge(evaluation: (ctx?: { instructions?: string[]; questionsAsked?: number }) => unknown) {
    return (async (ctx: { reason?: string; instructions?: string[]; questionsAsked?: number }) =>
      ctx.reason === 'evaluate' ? evaluation(ctx) : { kind: 'dispatch', attemptMode: 'SERIAL' }) as never;
  }

  await check('DEFAULT: with no judge the job terminalizes exactly as before', async () => {
    const jobId = await newJob('baseline');
    await drive(jobId);
    assert.equal(await tasksOf(jobId), 1);
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED', 'the shipped default must be untouched');
  });

  await check('a judge that accepts the work lets it finish', async () => {
    const jobId = await newJob('accepting judge');
    await drive(jobId, judge(() => ({ kind: 'terminalize', outcome: 'COMPLETED' })));
    assert.equal(await tasksOf(jobId), 1);
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED');
  });

  await check('a judge that rejects the work orders another attempt', async () => {
    let evaluations = 0;
    const decide = judge(() => {
      evaluations++;
      return evaluations === 1
        ? { kind: 'dispatch', attemptMode: 'SERIAL' }
        : { kind: 'terminalize', outcome: 'COMPLETED' };
    });
    const jobId = await newJob('replanning judge');
    await drive(jobId, decide);
    assert.equal(await tasksOf(jobId), 2, 'the rejected result must produce a second attempt');
    assert.ok(evaluations >= 2, 'the judge must have been asked again after the retry');
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED');
  });

  await check('LIVE REGRESSION: a replan keeps the specialist and its budget', async () => {
    // The canary's second task carried NO capability, so the retry of a chef job
    // would have been routed to the DEFAULT agent: the job silently changes
    // expert halfway through and nobody sees it.
    const jobId = await newJob('routed work that needs a retry');
    let evaluations = 0;
    const decide = (async (ctx: { reason?: string }) => {
      if (ctx.reason !== 'evaluate') {
        return { kind: 'dispatch', attemptMode: 'SERIAL', capability: 'chefAgent' };
      }
      evaluations++;
      return evaluations === 1
        ? { kind: 'dispatch', attemptMode: 'SERIAL' }
        : { kind: 'terminalize', outcome: 'COMPLETED' };
    }) as never;
    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide,
        attemptCapFor: () => 900_000,
      } as never);
      await drainWorkers(client, db, okWorker);
    }
    const tasks = await db.collection<{ capability?: string | null; attemptCapMs?: number | null }>(COLLECTIONS.tasks)
      .find({ jobId } as never).toArray();
    assert.equal(tasks.length, 2, 'the retry must exist');
    for (const task of tasks) {
      assert.equal(task.capability, 'chefAgent', 'every attempt at this job belongs to the same specialist');
      assert.equal(task.attemptCapMs, 900_000, 'and runs under the same window');
    }
  });

  await check('BOUND: a judge that always retries is stopped by the Service', async () => {
    const jobId = await newJob('always retry');
    await drive(jobId, judge(() => ({ kind: 'dispatch', attemptMode: 'SERIAL' })), 24);
    const tasks = await tasksOf(jobId);
    assert.ok(tasks <= 3, `the replan bound must cap task creation, got ${tasks}`);
    assert.ok((await jobOf(jobId))?.terminalOutcome !== null, 'and the job must still finish');
  });

  await check('hitting the bound raises an operator alert, it is not silent', async () => {
    const alerts = await db.collection(COLLECTIONS.outbox).countDocuments({
      type: 'OperatorAlertRequested',
      'payload.alertType': 'lane_replan_exhausted',
    });
    assert.ok(alerts >= 1, 'a job that stops because it ran out of retries must say so');
  });

  await check('a throwing judge finishes the job and alerts', async () => {
    const jobId = await newJob('throwing judge');
    await drive(jobId, judge(() => { throw new Error('judge exploded'); }));
    assert.equal(await tasksOf(jobId), 1, 'a broken judge must not create work');
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED', 'nor stall the job');
    const alerts = await db.collection(COLLECTIONS.outbox).countDocuments({
      type: 'OperatorAlertRequested',
      'payload.alertType': 'final_decision_fallback',
    });
    assert.ok(alerts >= 1, 'the degrade must be visible');
  });

  await check('an invalid judgement finishes the job, never loops', async () => {
    const jobId = await newJob('invalid judgement');
    await drive(jobId, judge(() => ({ kind: 'dispatch', attemptMode: 'PARALLEL' })));
    assert.equal(await tasksOf(jobId), 1);
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED');
  });

  await check('no judging behind a pause (§8.4: pause stops NEW work)', async () => {
    const alwaysRetry = judge(() => ({ kind: 'dispatch', attemptMode: 'SERIAL' }));
    const jobId = await newJob('paused judge');
    await runLaneForJob(client, db, jobId, 50, undefined, { decide: alwaysRetry } as never);
    await drainWorkers(client, db, okWorker);
    await pauseJob(client, db, { resourceId: 'res_final', commandId: `p_${randomUUID()}`, jobId });
    const before = await tasksOf(jobId);
    await drive(jobId, alwaysRetry, 6);
    assert.equal(await tasksOf(jobId), before, 'a paused job must not gain work from the judge');
  });

  await check('the terminal outcome comes from TASK STATE, not from the model', async () => {
    // A judge claiming COMPLETED must not be able to whitewash a failed task:
    // the outcome is still derived by the same reducer the drain would have used.
    const jobId = await newJob('failing work');
    const failing = (async () => ({ status: 'failed', error: { code: 'x', message: 'nope' } })) as never;
    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide: judge(() => ({ kind: 'terminalize', outcome: 'COMPLETED' })),
      } as never);
      await drainWorkers(client, db, failing);
    }
    const job = await jobOf(jobId);
    assert.notEqual(
      job?.terminalOutcome,
      'COMPLETED',
      `a model claiming COMPLETED must not override a failed task, got ${job?.terminalOutcome}`,
    );
  });

  await check('LIVE REGRESSION: a failure the replan RETRIED does not fail the job', async () => {
    // The design canary, exactly: attempt 1 timed out at 894s, the lane replanned,
    // the retry finished in about a minute and committed a 16 KB HTML prototype —
    // and the job was reported FAILED because one task in the list said FAILED.
    // Telling a user their finished deliverable failed is worse than a plain
    // failure: the work is there, and the label hides it.
    const jobId = await newJob('fails once, then delivers');
    let firstAttempt = true;
    const failsThenSucceeds = (async (ctx: unknown) => {
      if (firstAttempt) {
        firstAttempt = false;
        return { status: 'failed', error: { code: 'provider_error', message: 'timed out' } };
      }
      return (okWorker as (c: unknown) => Promise<unknown>)(ctx);
    }) as never;

    // Judge: retry once (dispatch), then accept whatever comes back.
    let evaluations = 0;
    const retryOnce = (async (ctx: { reason?: string }) => {
      if (ctx.reason !== 'evaluate') return { kind: 'dispatch', attemptMode: 'SERIAL' };
      evaluations++;
      return evaluations === 1
        ? { kind: 'dispatch', attemptMode: 'SERIAL' }
        : { kind: 'terminalize', outcome: 'COMPLETED' };
    }) as never;

    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, { decide: retryOnce } as never);
      await drainWorkers(client, db, failsThenSucceeds);
    }

    const tasks = await db.collection<{ _id: string; phase: string; supersedesTaskId?: string | null }>(COLLECTIONS.tasks)
      .find({ jobId }).toArray();
    assert.ok(tasks.length >= 2, `the replan must create a second task, got ${tasks.length}`);
    assert.ok(
      tasks.some((t) => typeof t.supersedesTaskId === 'string' && t.supersedesTaskId.length > 0),
      'the retry must RECORD which task it supersedes — the outcome rule reads that link, not position',
    );
    assert.ok(tasks.some((t) => t.phase === 'FAILED'), 'the first attempt really did fail');
    assert.ok(tasks.some((t) => t.phase === 'SUCCEEDED'), 'and the retry really did succeed');

    assert.equal(
      (await jobOf(jobId))?.terminalOutcome,
      'COMPLETED',
      'a job whose retry delivered must report COMPLETED, not FAILED',
    );
  });

  await check('LIVE REGRESSION: a progress report is not a deliverable', async () => {
    // chefAgent finished COMPLETED holding 581 chars of "Projekt utworzony.
    // Uzupełniam profil — pracuję autonomicznie…" and no menu at all. Worse than
    // a failure: it looks like success, so nobody goes looking.
    const jobId = await newJob('menu that never gets written');
    // A worker that answers with prose — `fromArtifact` absent.
    const proseOnly = (async () => ({
      status: 'ok', data: { text: 'Projekt utworzony. Uzupełniam profil…' }, summary: 'progress',
    })) as never;
    let judged = 0;
    const judge = (async (ctx: { reason?: string }) => {
      if (ctx.reason === 'evaluate') judged++;
      return { kind: 'dispatch', attemptMode: 'SERIAL' };
    }) as never;

    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide: judge,
        expectsArtifact: () => true,
      } as never);
      await drainWorkers(client, db, proseOnly);
    }

    const job = await jobOf(jobId);
    assert.notEqual(job?.terminalOutcome, 'COMPLETED',
      `prose must not pass as a stored document, got ${job?.terminalOutcome}`);
    assert.equal(judged, 0, 'the model must not be asked — this is a fact, not a judgement');
    const alerts = await db.collection(COLLECTIONS.outbox).countDocuments({
      type: 'OperatorAlertRequested',
      'payload.alertType': 'lane_deliverable_missing',
      'payload.jobId': jobId,
    });
    assert.ok(alerts >= 1, 'running out of retries without a document must be visible, not silent');
  });

  await check('a result that IS the stored artifact passes', async () => {
    // The guard must not fire when the run did what it was asked.
    const jobId = await newJob('menu that gets written');
    const wroteArtifact = (async () => ({
      status: 'ok', data: { text: '# Menu Book\n\n## Danie 1…', fromArtifact: true }, summary: 'book',
    })) as never;
    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide: judge(() => ({ kind: 'terminalize', outcome: 'COMPLETED' })),
        expectsArtifact: () => true,
      } as never);
      await drainWorkers(client, db, wroteArtifact);
    }
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED',
      'a stored document must satisfy the rule');
    assert.equal(await tasksOf(jobId), 1, 'and must not be retried');
  });

  await check('a PROSE capability is untouched by the rule', async () => {
    // crmAgent legitimately answers in 69 characters. A length or phrasing
    // heuristic would reject that; this rule asks only what the capability
    // DECLARED it produces, so a prose capability never trips it.
    const jobId = await newJob('does this lead exist');
    const shortProse = (async () => ({
      status: 'ok', data: { text: 'Nie odnaleziono leada o tej nazwie.' }, summary: 'no lead',
    })) as never;
    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide: judge(() => ({ kind: 'terminalize', outcome: 'COMPLETED' })),
        expectsArtifact: () => false,
      } as never);
      await drainWorkers(client, db, shortProse);
    }
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED',
      'a short prose answer is a valid deliverable for a prose capability');
  });

  await check('LIVE REGRESSION: hitting the ceiling on a job that DELIVERED does not alert', async () => {
    // chef ran [FAILED, FAILED, SUCCEEDED], committed a 39 KB Menu Book, and
    // `lane_replan_exhausted` fired anyway. The ceiling never held that job back.
    // An alert that cries wolf on delivered work teaches the operator to ignore
    // the one that matters.
    const before = await db.collection(COLLECTIONS.outbox).countDocuments({
      type: 'OperatorAlertRequested', 'payload.alertType': 'lane_replan_exhausted',
    });
    const jobId = await newJob('fails twice then delivers at the ceiling');
    let attempt = 0;
    const failsTwice = (async (ctx: unknown) => {
      attempt++;
      if (attempt <= 2) return { status: 'failed', error: { code: 'x', message: 'nope' } };
      return (okWorker as (c: unknown) => Promise<unknown>)(ctx);
    }) as never;
    // A judge that always retries, so the run reaches the ceiling.
    for (let i = 0; i < 20; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide: judge(() => ({ kind: 'dispatch', attemptMode: 'SERIAL' })),
      } as never);
      await drainWorkers(client, db, failsTwice);
    }
    const job = await jobOf(jobId);
    assert.equal(job?.terminalOutcome, 'COMPLETED', 'the delivered work must close the job');
    const after = await db.collection(COLLECTIONS.outbox).countDocuments({
      type: 'OperatorAlertRequested',
      'payload.alertType': 'lane_replan_exhausted',
      'payload.jobId': jobId,
    });
    assert.equal(after, 0, 'a job that delivered must not raise the exhausted alert');
    void before;
  });

  await check('a failure with NO retry still fails the job', async () => {
    // The exclusion must be narrow: only a task some other task supersedes is
    // discounted. Otherwise this "fix" would hide real failures.
    const jobId = await newJob('fails for good');
    const failing = (async () => ({ status: 'failed', error: { code: 'x', message: 'nope' } })) as never;
    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide: judge(() => ({ kind: 'terminalize', outcome: 'FAILED' })),
      } as never);
      await drainWorkers(client, db, failing);
    }
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'FAILED', 'a genuine failure must still read FAILED');
  });

  // ── request_user at evaluate time ────────────────────────────────────────
  // The canary case: chefAgent answered "which cuisine? any dietary limits?" and
  // the job closed as COMPLETED with a question as its result. Retrying would
  // have asked again; only the user can unblock it.

  await check('work that comes back ASKING sends the job to the user, not to terminal', async () => {
    const jobId = await newJob('design a tasting menu');
    await drive(jobId, judge(() => ({ kind: 'request_user', question: 'Which cuisine?' })));
    const job = await jobOf(jobId);
    assert.equal(job?.terminalOutcome, null, 'a job waiting on a human must not be finished');
    assert.equal(job?.phase, 'AWAITING_USER');
    const open = await getOpenRequest(db, jobId);
    assert.equal(open?.action, 'Which cuisine?', 'the question must be durably readable');
  });

  await check('the open question survives every later lane tick', async () => {
    // The hole this closes: with all tasks SUCCEEDED, the terminal-advance
    // branch would have closed the job on the very next tick — nothing else
    // there objects to a job whose work is done.
    const jobId = await newJob('another asking job');
    await drive(jobId, judge(() => ({ kind: 'request_user', question: 'Which cuisine?' })));
    await drive(jobId, judge(() => ({ kind: 'terminalize', outcome: 'COMPLETED' })), 8);
    const job = await jobOf(jobId);
    assert.equal(job?.terminalOutcome, null, 'nothing may close a job with an open question');
    assert.equal((await getOpenRequest(db, jobId))?.action, 'Which cuisine?');
  });

  await check('answering it gets the work REDONE, with the answer in hand', async () => {
    // The whole point of the loop: the specialist that asked "which cuisine?"
    // must run again and this time SEE "Polish, seasonal". An answer that only
    // satisfies the judge, without reaching the work, would be theatre.
    const jobId = await newJob('menu needing input');
    let asked = 0;
    let retried = 0;
    const decide = judge((ctx?: { instructions?: string[] }) => {
      const answered = (ctx?.instructions ?? []).some((i) => i.startsWith('User answer:'));
      if (!answered) { asked++; return { kind: 'request_user', question: 'Which cuisine?' }; }
      if (retried === 0) { retried++; return { kind: 'dispatch', attemptMode: 'SERIAL' }; }
      return { kind: 'terminalize', outcome: 'COMPLETED' };
    });
    await drive(jobId, decide);
    const request = await getOpenRequest(db, jobId);
    assert.ok(request, 'the job must be waiting');
    await answerJobRequest(client, db, {
      resourceId: 'res_final', commandId: `ans_${randomUUID()}`,
      jobId, requestId: request.requestId, answer: 'Polish, seasonal',
    });

    const seenByWorker: string[][] = [];
    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, { decide } as never);
      await drainWorkers(client, db, ((ctx: { instructions: string[] }) => {
        seenByWorker.push(ctx.instructions);
        return { status: 'ok', data: {} };
      }) as never);
    }

    assert.equal(asked, 1, 'the judge must not re-ask what it already had answered');
    assert.equal(await tasksOf(jobId), 2, 'the answer must produce a second attempt');
    assert.ok(
      seenByWorker.some((ins) => ins.some((i) => i.includes('Polish, seasonal'))),
      `the agent must see the answer on the retry, got ${JSON.stringify(seenByWorker)}`,
    );
    assert.equal((await jobOf(jobId))?.terminalOutcome, 'COMPLETED');
  });

  await check('a run that declares NEEDS_INPUT reaches the user WITHOUT asking the judge', async () => {
    // The deterministic half of step 3b. Asking a model "is this a deliverable
    // or a question?" is precisely what failed the first time, so a specialist
    // that used its structural escape hatch does not get re-litigated.
    const jobId = await newJob('menu with no cuisine given');
    let judgeCalls = 0;
    const decide = (async (ctx: { reason?: string }) => {
      if (ctx.reason === 'evaluate') judgeCalls++;
      return { kind: 'dispatch', attemptMode: 'SERIAL' };
    }) as never;
    const blockedWorker = (async () => ({
      status: 'ok',
      data: { text: 'NEEDS_INPUT: Which cuisine, and any dietary limits?' },
    })) as never;
    for (let i = 0; i < 14; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, { decide } as never);
      await drainWorkers(client, db, blockedWorker);
    }
    const job = await jobOf(jobId);
    assert.equal(job?.terminalOutcome, null, 'a blocked job must not be closed as finished');
    assert.equal(job?.phase, 'AWAITING_USER');
    assert.equal(
      (await getOpenRequest(db, jobId))?.action,
      'Which cuisine, and any dietary limits?',
      'the specialist\'s own question must be the one the user sees',
    );
    assert.equal(judgeCalls, 0, 'no model may be consulted about a declared blocker');
  });

  await check('BOUND: a judge that only ever asks stops interrogating the user', async () => {
    const jobId = await newJob('endless questions');
    const alwaysAsk = judge(() => ({ kind: 'request_user', question: 'And what else?' }));
    for (let round = 0; round < 6; round++) {
      await drive(jobId, alwaysAsk, 6);
      const open = await getOpenRequest(db, jobId);
      if (!open) break;
      await answerJobRequest(client, db, {
        resourceId: 'res_final', commandId: `ans_${randomUUID()}`,
        jobId, requestId: open.requestId, answer: 'nothing else',
      }).catch(() => undefined);
    }
    const questions = await db.collection(COLLECTIONS.requests).countDocuments({ jobId, kind: 'user' });
    assert.ok(questions <= 2, `the question bound must hold, asked ${questions} times`);
    assert.ok((await jobOf(jobId))?.terminalOutcome !== null, 'and the job must still finish');
    const alerts = await db.collection(COLLECTIONS.outbox).countDocuments({
      type: 'OperatorAlertRequested',
      'payload.alertType': 'lane_questions_exhausted',
    });
    assert.ok(alerts >= 1, 'running out of questions must be visible, not silent');
  });

  await db.dropDatabase().catch(() => undefined);
  await store.close();

  if (failures > 0) {
    console.error(`\n❌ check:final-decision — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:final-decision — the lane judges finished work, bounded, and every unsafe path ends in "finish"');
  process.exit(0);
}

main().catch((error) => { console.error(`check failed: ${(error as Error).message}`); process.exit(1); });
