#!/usr/bin/env tsx
/**
 * F6B — a job may carry a SEQUENCE of domain specialists, not just one.
 *
 * Before this, a job ran exactly one agent end to end. A request spanning three
 * specialists became delegation *inside* one agent's run, which the substrate
 * could not see and could not resume: a restart repeated everything instead of
 * continuing from step 2.
 *
 * The fan-out/fan-in machinery already existed and the lane already drove it —
 * `spawnChildTasks` is a complete transactional fan-out and `laneStep` calls
 * `resolveParentTask` every tick. Three things were missing, and each is a
 * section below:
 *
 *  1. **Steps had no specialist.** A child carried `goal` alone, so every step
 *     of a plan would have routed to the DEFAULT agent — the same defect already
 *     fixed once for replans.
 *  2. **Siblings had no order.** All children came up READY at once, so a
 *     "research then write" plan would have run both immediately, in whatever
 *     order the lane happened to pick.
 *  3. **Nothing released the next step.** Ordering is only real if something
 *     promotes step 2 when step 1 succeeds — and blocks it when step 1 does not.
 *
 * Runs against a real replica set: the promotion is a CAS inside a transaction,
 * and the thing being proven is that two ticks racing on one step release it
 * once. A fake store would only re-test the idea.
 *
 * Run: npx tsx src/mastra/scripts/check-multi-step-plan.ts
 */
import assert from 'node:assert/strict';

import { connectReplicaSetOrSkip } from './lib/replica-set.js';

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

console.log('check:multi-step-plan');

const store = await connectReplicaSetOrSkip({
  dbName: `multistep_${Date.now()}`,
  section: 'multi-step plan',
});
if (!store) process.exit(failures === 0 ? 0 : 1);

const { client, db } = store;
const {
  ensureOrchestrationIndexes, acceptStartCommand, planJob, spawnChildTasks,
  promoteSequencedSteps, drainLane, runToQuiescence, cancelJob, reconcile,
  getJobStatus, COLLECTIONS,
} = await import('../orchestration/store/index.js');
await ensureOrchestrationIndexes(db);

type Task = {
  _id: string; phase: string; goal?: string | null; capability?: string | null;
  attemptCapMs?: number | null; awaitsTaskId?: string | null; blockedReason?: string | null;
};
/**
 * Tasks by id, NOT sorted by `createdAt`.
 *
 * Every child of one spawn is inserted in a single transaction with the same
 * timestamp, so ordering by `createdAt` is arbitrary — an earlier version of
 * this check did exactly that and read the steps in the wrong order, which
 * looked like a bug in the promotion logic. Plan order comes from
 * `spawnChildTasks`, which returns the ids in spec order.
 */
const tasksById = async (jobId: string): Promise<Map<string, Task>> => {
  const rows = await db.collection<Task>(COLLECTIONS.tasks).find({ jobId } as never).toArray();
  return new Map(rows.map((t) => [t._id, t]));
};
const stepsOf = async (jobId: string, ids: string[]): Promise<Task[]> => {
  const byId = await tasksById(jobId);
  return ids.map((id) => byId.get(id)!);
};

let seq = 0;
async function jobWithPlan(goal: string): Promise<{ jobId: string; parentTaskId: string }> {
  seq++;
  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_multistep', conversationId: `conv_${seq}`, goal,
    commandId: `cmd_${Date.now()}_${seq}`, payload: { goal },
  });
  const planned = await planJob(client, db, accepted.jobId);
  return { jobId: accepted.jobId, parentTaskId: planned!.taskId };
}

/** The plan the whole stage exists for: research → write → illustrate. */
const THREE_STEPS = [
  { goal: 'zbierz źródła', capability: 'researcherAgent', attemptCapMs: 300_000 },
  { goal: 'napisz artykuł', capability: 'writerAgent', attemptCapMs: 900_000, after: 0 },
  { goal: 'dorób grafikę', capability: 'designAgent', attemptCapMs: 900_000, after: 1 },
];

// ── 1. Steps carry their own specialist and budget ─────────────────────────
await check('LIVE REGRESSION: each step freezes its OWN capability and window', async () => {
  // Without this every step routes to the default agent, and a three-specialist
  // plan silently becomes three runs of the same one.
  const { jobId, parentTaskId } = await jobWithPlan('research → artykuł → grafika');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });
  const steps = await stepsOf(jobId, childTaskIds);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.capability), ['researcherAgent', 'writerAgent', 'designAgent']);
  assert.deepEqual(steps.map((s) => s.attemptCapMs), [300_000, 900_000, 900_000]);
  assert.deepEqual(steps.map((s) => s.goal), ['zbierz źródła', 'napisz artykuł', 'dorób grafikę']);
});

await check('only the FIRST step is dispatchable; the rest wait', async () => {
  const { jobId, parentTaskId } = await jobWithPlan('kolejność');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });
  const steps = await stepsOf(jobId, childTaskIds);
  assert.deepEqual(steps.map((s) => s.phase), ['READY', 'WAITING_DEPENDENCY', 'WAITING_DEPENDENCY'],
    'coming up READY together would run the whole plan at once, in arbitrary order');
  assert.equal(steps[0].awaitsTaskId ?? null, null);
  assert.equal(steps[1].awaitsTaskId, steps[0]._id, 'each step names the one it follows');
  assert.equal(steps[2].awaitsTaskId, steps[1]._id);
});

await check('SECURITY: a forward or self reference is refused, not deadlocked', async () => {
  // A cycle would be a job that never moves and never fails — the worst shape.
  const { jobId, parentTaskId } = await jobWithPlan('cykl');
  for (const bad of [0, 1, 2, -1, 1.5]) {
    await assert.rejects(
      () => spawnChildTasks(client, db, {
        jobId, parentTaskId,
        children: [{ goal: 'a', after: bad as number }, { goal: 'b' }],
      }),
      /EARLIER sibling/,
      `after=${bad} must be refused`,
    );
  }
});

// ── 2. The sequence actually moves ─────────────────────────────────────────
await check('a SUCCEEDED predecessor releases exactly the next step', async () => {
  const { jobId, parentTaskId } = await jobWithPlan('promocja');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });
  const [first, second, third] = childTaskIds;

  await db.collection(COLLECTIONS.tasks).updateOne({ _id: first } as never, { $set: { phase: 'SUCCEEDED' } });
  const moved = await promoteSequencedSteps(client, db, jobId);
  assert.deepEqual(moved.released, [second], 'step 2 becomes runnable');
  assert.deepEqual(moved.blocked, []);

  const after = await tasksById(jobId);
  assert.equal(after.get(second)?.phase, 'READY');
  assert.equal(after.get(third)?.phase, 'WAITING_DEPENDENCY',
    'step 3 must NOT jump the queue when step 1 succeeds');
});

await check('promotion is idempotent — a second tick releases nothing', async () => {
  const { jobId, parentTaskId } = await jobWithPlan('idempotencja');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });
  await db.collection(COLLECTIONS.tasks).updateOne({ _id: childTaskIds[0] } as never, { $set: { phase: 'SUCCEEDED' } });

  const a = await promoteSequencedSteps(client, db, jobId);
  const b = await promoteSequencedSteps(client, db, jobId);
  assert.equal(a.released.length, 1);
  assert.deepEqual(b.released, [], 'two lane ticks must not release one step twice');
});

await check('a failed predecessor blocks the WHOLE remaining tail, in one pass', async () => {
  // Left WAITING they would hang the job forever; released they would build on
  // nothing. Blocked is terminal, so fan-in can settle the parent.
  //
  // The cascade is deliberate: if step 2 can never run then step 3 can never run
  // either, and collapsing the tail in one pass beats blocking one step per tick
  // and leaving the job looking half-alive in between.
  const { jobId, parentTaskId } = await jobWithPlan('porażka poprzednika');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });
  const [first, second, third] = childTaskIds;
  await db.collection(COLLECTIONS.tasks).updateOne({ _id: first } as never, { $set: { phase: 'FAILED' } });

  const moved = await promoteSequencedSteps(client, db, jobId);
  assert.deepEqual(moved.blocked, [second, third], 'the tail collapses together');
  const after = await tasksById(jobId);
  assert.equal(after.get(second)?.phase, 'BLOCKED');
  assert.equal(after.get(third)?.phase, 'BLOCKED');
  assert.match(String(after.get(second)?.blockedReason), /ended FAILED/);
  assert.match(String(after.get(third)?.blockedReason), /ended BLOCKED/,
    'and each step says which predecessor stopped it, not just that something did');
});

await check('a PARTIAL predecessor does NOT release the next step', async () => {
  // Deliberate: a step consumes its predecessor's output, and continuing on an
  // incomplete one produces a plausible answer from wrong input.
  const { jobId, parentTaskId } = await jobWithPlan('partial');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });
  const [first, second] = childTaskIds;
  await db.collection(COLLECTIONS.tasks).updateOne({ _id: first } as never, { $set: { phase: 'PARTIAL' } });

  const moved = await promoteSequencedSteps(client, db, jobId);
  assert.deepEqual(moved.released, [], 'PARTIAL is not a green light');
  assert.equal(moved.blocked[0], second, 'and it is not a hang either — it is a visible stop');
  assert.match(String((await tasksById(jobId)).get(second)?.blockedReason), /ended PARTIAL/);
});

await check('a still-running predecessor decides nothing yet', async () => {
  const { jobId, parentTaskId } = await jobWithPlan('w toku');
  await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });
  const moved = await promoteSequencedSteps(client, db, jobId);
  assert.deepEqual(moved, { released: [], blocked: [] });
});

// ── 3. End to end through the real lane and worker ─────────────────────────
await check('LIVE: the lane runs three steps IN ORDER, each as its own attempt', async () => {
  const { jobId, parentTaskId } = await jobWithPlan('pełny przebieg');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });

  // Scoped to THIS job: `runToQuiescence` drains the whole lane, so earlier
  // tests' jobs run through the same fixture and would otherwise appear here.
  const ran: Array<string | null | undefined> = [];
  await runToQuiescence(client, db, drainLane, ((ctx: { capability?: string | null; jobId: string }) => {
    if (ctx.jobId === jobId) ran.push(ctx.capability);
    return { status: 'ok', data: {} };
  }) as never);

  assert.deepEqual(ran, ['researcherAgent', 'writerAgent', 'designAgent'],
    'the plan must execute in the order it was written, one specialist at a time');
  const steps = await stepsOf(jobId, childTaskIds);
  assert.deepEqual(steps.map((s) => s.phase), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  assert.equal((await tasksById(jobId)).get(parentTaskId)?.phase, 'SUCCEEDED',
    'fan-in settles the parent once every REQUIRED step is in');
});

await check('LIVE: a failing step stops the sequence instead of running the rest', async () => {
  const { jobId, parentTaskId } = await jobWithPlan('przerwana sekwencja');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });

  const ran: Array<string | null | undefined> = [];
  await runToQuiescence(client, db, drainLane, ((ctx: { capability?: string | null; jobId: string }) => {
    if (ctx.jobId === jobId) ran.push(ctx.capability);
    return ctx.capability === 'writerAgent' && ctx.jobId === jobId
      ? { status: 'failed', error: { code: 'boom', message: 'writer failed' } }
      : { status: 'ok', data: {} };
  }) as never);

  assert.ok(!ran.includes('designAgent'),
    'designAgent must never run on the output of a step that failed');
  const steps = await stepsOf(jobId, childTaskIds);
  assert.equal(steps[2].phase, 'BLOCKED');
  assert.match(String(steps[2].blockedReason), /ended/);
});

// ── 4. Step 2 can actually SEE what step 1 produced ────────────────────────
await check('LIVE: the next step receives its predecessor\'s result', async () => {
  // The whole point of a sequence. Before this the worker got the job goal, the
  // task goal and instructions — and nothing else — so step 2 had no way to
  // build on step 1. Proven from the ACTUAL context handed to the worker.
  const { jobId, parentTaskId } = await jobWithPlan('przekazanie wyniku');
  const { childTaskIds } = await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });

  const seen = new Map<string, unknown>();
  await runToQuiescence(client, db, drainLane, ((ctx: {
    capability?: string | null; jobId: string; upstream?: unknown;
  }) => {
    if (ctx.jobId === jobId) seen.set(ctx.capability ?? 'none', ctx.upstream);
    return { status: 'ok', data: { wrote: ctx.capability }, summary: `zrobione przez ${ctx.capability}` };
  }) as never);

  assert.equal(seen.get('researcherAgent'), undefined, 'the first step has no predecessor to receive');
  const forWriter = seen.get('writerAgent') as Array<Record<string, unknown>> | undefined;
  assert.ok(forWriter && forWriter.length === 1, 'the writer must receive exactly one predecessor');
  assert.equal(forWriter[0].capability, 'researcherAgent', 'and must know WHOSE output it is');
  assert.equal(forWriter[0].taskId, childTaskIds[0]);
  assert.match(String(forWriter[0].summary), /researcherAgent/);
  assert.match(String(forWriter[0].preview), /researcherAgent/, 'the payload travels as a bounded excerpt');

  const forDesigner = seen.get('designAgent') as Array<Record<string, unknown>> | undefined;
  assert.equal(forDesigner?.[0].capability, 'writerAgent',
    'a linear pipeline hands work forward one link — the designer gets the article, not the research');
});

await check('the predecessor result reaches the PROMPT, not just the context', async () => {
  // A context field nothing renders is a field the agent never sees. Asserted on
  // the real router that builds the prompt.
  const { capabilityRoute } = await import('../orchestration/execution/registry-worker.js');
  const route = capabilityRoute({ resolve: (n) => n, defaultAgentId: 'researcherAgent' });
  const decision = route({
    attemptId: 'a', taskId: 't', jobId: 'j', attemptNumber: 1,
    businessOperationCutoffAt: new Date(), workDeadlineAt: new Date(), hardDeadlineAt: new Date(),
    goal: 'napisz artykuł', jobGoal: 'research → artykuł', taskGoal: 'napisz artykuł',
    instructions: [], capability: 'writerAgent',
    upstream: [{
      taskId: 'prev', capability: 'researcherAgent', goal: 'zbierz źródła',
      status: 'ok', summary: 'pięć źródeł', artifacts: ['art-1'], preview: 'treść researchu',
    }],
  } as never);
  assert.ok(decision, 'the route must resolve');
  assert.match(decision!.prompt, /WYNIK POPRZEDNIEGO KROKU \(researcherAgent\)/);
  assert.match(decision!.prompt, /treść researchu/);
  assert.match(decision!.prompt, /art-1/, 'artifact ids must be named — the excerpt is bounded');
  assert.ok(!decision!.classificationPrompt?.includes('WYNIK POPRZEDNIEGO'),
    'upstream context must not contaminate the semantic classification prompt');
});

await check('W3: in a plan the TASK is the mandate and the job goal is only background', async () => {
  // Measured, not imagined. A research step briefed "fetch and analyse the
  // CURRENT menu of this restaurant" fetched the real pages and then delivered a
  // NEW menu with suggested prices, because the job goal asked for one and the
  // framing called its own brief a mere refinement ("refines but never replaces
  // the full goal"). The real menu it had in hand never reached the chef step
  // that needed it. The split was right, the briefs were precise, and the
  // wrapper around them overrode both.
  const { capabilityRoute } = await import('../orchestration/execution/registry-worker.js');
  const route = capabilityRoute({ resolve: (n) => n, defaultAgentId: 'researcherAgent' });
  const base = {
    attemptId: 'a', taskId: 't', jobId: 'j', attemptNumber: 1,
    businessOperationCutoffAt: new Date(), workDeadlineAt: new Date(), hardDeadlineAt: new Date(),
    instructions: [], upstream: [],
    // `planStep` is what selects this framing now. It used to be selected by
    // "the task goal differs from the job goal", which is a different question:
    // a SINGLE-task job whose lane supplied a sharpened goal got the plan-step
    // wrapper too, and was told "later steps cover the rest" with none to come.
    // See the companion check below.
    planStep: true,
  };
  const step = route({
    ...base,
    goal: 'Pobierz i przeanalizuj AKTUALNE menu restauracji ze strony',
    jobGoal: 'Stwórz nowe, kompletne menu z sugerowanymi cenami w ISK',
    taskGoal: 'Pobierz i przeanalizuj AKTUALNE menu restauracji ze strony',
    capability: 'researcherAgent',
  } as never);
  assert.ok(step, 'the route must resolve');
  const p = step!.prompt;

  assert.ok(
    p.indexOf('Pobierz i przeanalizuj') < p.indexOf('Stwórz nowe'),
    'the task must come FIRST — what you deliver cannot be introduced as a footnote '
    + 'to somebody else\'s deliverable',
  );
  assert.ok(
    !/refines but never replaces/i.test(p),
    'the framing that produced the defect must be gone for a plan step',
  );
  assert.match(p, /only thing you deliver/i,
    'the step must be told its task is the whole of its output');
  assert.match(p, /Background/,
    'the job goal must be labelled as context, not as the mandate');
  assert.match(p, /report them as you found them/i,
    'a gathering step must be told to hand over findings intact — the price drift '
    + 'came from re-imagining fetched data into the finished product');

  // A SINGLE-task job must be untouched: no second step to confuse it with, so
  // rewording it would be a change with no defect behind it.
  const solo = route({
    ...base,
    planStep: false,
    goal: 'Stwórz menu', jobGoal: 'Stwórz menu', taskGoal: 'Stwórz menu',
    capability: 'chefAgent',
  } as never);
  assert.ok(!/YOUR TASK/.test(solo!.prompt),
    'a single-task job keeps the shape it always had');
  assert.ok(!/Background/.test(solo!.prompt),
    'and gains no framing it does not need');

  // …and that must hold when the lane SHARPENS the goal, which is the case the
  // old condition got wrong. Measured on live job task_827b8697 (chefAgent, one
  // task, no plan): the run was told a rewritten goal was "the only thing you
  // deliver", that "later steps cover the rest" — there were none — and that the
  // user's own sentence was "NOT a description of what to hand back". Anything
  // the rewrite dropped (a URL, a venue name) was demoted with it, and chef's
  // recon branch is entered only "when we have a URL/name".
  const sharpened = route({
    ...base,
    planStep: false,
    goal: 'Zaprojektuj menu w ISK',
    jobGoal: 'potrzebuje nowe menu dla restauracji https://www.apotek.is/',
    taskGoal: 'Zaprojektuj menu w ISK',
    capability: 'chefAgent',
  } as never);
  const sp = sharpened!.prompt;
  assert.ok(!/only thing you deliver/i.test(sp),
    'a one-task job must not be told its rewritten goal is the whole of its output');
  assert.ok(!/Later steps cover the rest/i.test(sp),
    'and must not be told about steps that do not exist');
  assert.ok(!/NOT a description of what to hand back/i.test(sp),
    'the user\'s own words must never be demoted to background on a one-task job');
  assert.ok(
    sp.indexOf('https://www.apotek.is/') < sp.indexOf('Zaprojektuj menu w ISK'),
    'the job goal leads — everything the user wrote survives, in front of the refinement',
  );
  assert.match(sp, /Zaprojektuj menu w ISK/,
    'and the lane\'s refinement is kept rather than silently discarded');
});

// ── 5. A multi-step plan can be STOPPED ────────────────────────────────────
await check('LIVE REGRESSION: cancelling a multi-step plan closes the job', async () => {
  // Measured before the fix: cancel reached every task (no orphan work), but the
  // job then sat in RECONCILING forever with BLOCKED_UNSUPPORTED /
  // dispatch_edge_present and an operator alert. The barrier refused to pretend
  // it had settled edges — right — but nothing ever reconsidered, because the
  // recovery scan only looks at FLAT_STOP_V1 jobs and `cancelJob` had already
  // latched this one at the one moment a live plan cannot qualify.
  const { jobId, parentTaskId } = await jobWithPlan('do anulowania');
  await spawnChildTasks(client, db, { jobId, parentTaskId, children: THREE_STEPS });

  await cancelJob(client, db, { resourceId: 'res_multistep', commandId: `cancel_${jobId}`, jobId });
  const atCancel = await db.collection(COLLECTIONS.jobs).findOne({ _id: jobId } as never) as never as
    { terminalBarrierMode: string | null; terminalBarrierBlocker: string | null };
  assert.equal(atCancel.terminalBarrierMode, 'FLAT_STOP_V1',
    'a live plan must NOT be latched as unsupported at cancel time');
  assert.equal(atCancel.terminalBarrierBlocker, null);

  const deadline = Date.now() + 20_000;
  let status = await getJobStatus(db, 'res_multistep', jobId);
  while (Date.now() < deadline && status?.terminalOutcome === null) {
    await drainLane(client, db);
    await reconcile(client, db);
    await new Promise((r) => setTimeout(r, 150));
    status = await getJobStatus(db, 'res_multistep', jobId);
  }
  assert.equal(status?.terminalOutcome, 'CANCELLED', 'the job must actually close');
  assert.equal(status?.phase, 'TERMINAL');

  const steps = await stepsOf(jobId, (await tasksById(jobId)).size ? [...(await tasksById(jobId)).keys()] : []);
  assert.ok(steps.every((t) => t.phase === 'CANCELLED'), 'every task stops — no orphan work');
  const edges = await db.collection(COLLECTIONS.edges).find({ jobId } as never).toArray() as never as
    Array<{ lifecycle: string }>;
  assert.ok(edges.length > 0 && edges.every((e) => e.lifecycle === 'SETTLED'),
    'an ACTIVE edge beside a terminal job is an obligation nobody would discharge');
});

await check('SECURITY: a DANGLING edge still blocks — it is broken, not unfinished', async () => {
  // The distinction the whole fix rests on. An edge naming a child that does not
  // exist can never settle, so treating it as "not yet" would swap a loud block
  // for an infinite wait. Two existing stop e2e cases construct this shape.
  const { jobId, parentTaskId } = await jobWithPlan('wisząca krawędź');
  await db.collection(COLLECTIONS.edges).insertOne({
    _id: `edge_dangling_${jobId}`, jobId, parentTaskId,
    childTaskId: `does-not-exist:${jobId}`,
    completionMode: 'REQUIRED', lifecycle: 'ACTIVE', createdAt: new Date(),
  } as never);
  await cancelJob(client, db, { resourceId: 'res_multistep', commandId: `cancel_dangling_${jobId}`, jobId });
  const job = await db.collection(COLLECTIONS.jobs).findOne({ _id: jobId } as never) as never as
    { terminalBarrierMode: string | null; terminalBarrierBlocker: string | null };
  assert.equal(job.terminalBarrierMode, 'BLOCKED_UNSUPPORTED');
  assert.equal(job.terminalBarrierBlocker, 'dispatch_edge_present',
    'an incoherent topology must still stop for a human');
});

// ── 6. A MODEL can produce the plan — the whole point of the stage ─────────
await check('LIVE: a plan_steps decision becomes three real tasks, in order', async () => {
  // Until this, a multi-step plan could only be created from code, so no real
  // request could ever produce one. This is the piece that makes the sequence
  // reachable from a user's message.
  const accepted = await acceptStartCommand(client, db, {
    resourceId: 'res_multistep', conversationId: 'conv_planner',
    goal: 'zrób research, napisz artykuł, dorób grafikę',
    commandId: `cmd_planner_${Date.now()}`, payload: {},
  });
  const planner = (async (ctx: { reason?: string }) => (
    ctx.reason === 'evaluate'
      ? { kind: 'terminalize', outcome: 'COMPLETED' }
      : {
        kind: 'plan_steps',
        steps: [
          { goal: 'zbierz źródła', capability: 'researcherAgent' },
          { goal: 'napisz artykuł', capability: 'writerAgent' },
          { goal: 'dorób grafikę', capability: 'designAgent' },
        ],
      }
  )) as never;

  const ran: Array<string | null | undefined> = [];
  await runToQuiescence(client, db, (c, d) => drainLane(c, d, {
    decide: planner,
    attemptCapFor: (name: string | null) => (name === 'writerAgent' ? 900_000 : 300_000),
  } as never), ((ctx: { capability?: string | null; jobId: string }) => {
    if (ctx.jobId === accepted.jobId) ran.push(ctx.capability);
    return { status: 'ok', data: {} };
  }) as never);

  assert.deepEqual(ran, ['researcherAgent', 'writerAgent', 'designAgent'],
    'the model named three specialists and all three ran, in that order');
  const byId = await tasksById(accepted.jobId);
  const steps = [...byId.values()].filter((t) => t.awaitsTaskId !== undefined || t.capability);
  assert.equal(steps.filter((t) => t.capability).length, 3);
  assert.equal([...byId.values()].find((t) => t.capability === 'writerAgent')?.attemptCapMs, 900_000,
    'the budget is computed by CODE from the capability, not taken from the model');
});

await check('SECURITY: the plan size is bounded and steps may not claim authority', async () => {
  const { assertLaneDecision, InvalidLaneDecisionError } =
    await import('../orchestration/contracts/lane-decision.js');
  const step = { goal: 'x'.repeat(10), capability: 'writerAgent' };
  // One step is a dispatch, not a sequence; a hundred is a runaway.
  for (const count of [0, 1, 9, 50]) {
    assert.throws(
      () => assertLaneDecision({ kind: 'plan_steps', steps: Array.from({ length: count }, () => step) }),
      (e: unknown) => e instanceof InvalidLaneDecisionError,
      `${count} steps must be refused`,
    );
  }
  // A step must not carry ids, budgets or anything else the Service owns.
  for (const junk of [
    { goal: 'a'.repeat(10), taskId: 't' },
    { goal: 'a'.repeat(10), attemptCapMs: 999 },
    { goal: 'a'.repeat(10), capability: 'not a name' },
    { goal: '' },
  ]) {
    assert.throws(
      () => assertLaneDecision({ kind: 'plan_steps', steps: [junk, step] }),
      (e: unknown) => e instanceof InvalidLaneDecisionError,
      `${JSON.stringify(junk)} must be refused`,
    );
  }
  assert.doesNotThrow(() => assertLaneDecision({ kind: 'plan_steps', steps: [step, step] }));
});

// ── 7. The unordered case still behaves as before ──────────────────────────
await check('children with no predecessor keep the old fan-out behaviour', async () => {
  // Ordering is opt-in; a plain fan-out must not silently become a sequence.
  const { jobId, parentTaskId } = await jobWithPlan('równoległe rodzeństwo');
  const { childTaskIds } = await spawnChildTasks(client, db, {
    jobId, parentTaskId,
    children: [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }],
  });
  const steps = await stepsOf(jobId, childTaskIds);
  assert.deepEqual(steps.map((s) => s.phase), ['READY', 'READY', 'READY']);
  assert.deepEqual(steps.map((s) => s.awaitsTaskId ?? null), [null, null, null]);
});

await client.db(db.databaseName).dropDatabase();
await store.close();

console.log(failures === 0 ? '\n✅ check:multi-step-plan passed' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
