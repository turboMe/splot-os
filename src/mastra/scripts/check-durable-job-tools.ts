#!/usr/bin/env tsx
/**
 * F5 — the durable-job tools, the first agent-facing consumer of the V2 substrate.
 *
 * Covers the whole loop against a REAL replica-set database (throwaway, dropped
 * on exit) plus the two properties that would be dangerous to get wrong:
 *
 *  1. OWNERSHIP CANNOT BE SPOOFED. `resourceId`/`conversationId` come from the
 *     harness execution context, never from tool input. A run belonging to one
 *     agent must not be able to read, list or cancel another agent's job — and an
 *     unowned job must look exactly like a missing one (no existence oracle).
 *  2. FAIL-CLOSED WITHOUT IDENTITY. Called outside a harness run there is no
 *     owner, so the tools must refuse rather than invent one.
 *
 * The lane/worker loops are NOT started here: this checks the consumer surface
 * (accept → read → list → control), not job execution, which
 * live-verify:f5-mastra-routes already proves end to end.
 *
 * One regression is worth naming: `applyControl` hashes only {type, jobId}, so a
 * fixed per-job commandId would make a SECOND pause dedupe to the first and
 * silently leave the job running. The pause→resume→pause case pins that.
 *
 * Run: npx tsx src/mastra/scripts/check-durable-job-tools.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { replicaSetUriOrSkip } from './lib/replica-set.js';

const TEST_DATABASE = `djt_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

process.env.FEATURE_ORCHESTRATION_V2 = 'true';
process.env.FEATURE_ORCHESTRATION_V2_AGENT_TOOLS = 'true';

// Resolved before anything is wired up: a mount pointed at a dead server would
// fail every assertion below for the wrong reason.
const resolvedRsUri = await replicaSetUriOrSkip('check:durable-job-tools');
if (!resolvedRsUri) process.exit(0);
const RS_URI: string = resolvedRsUri;

const { configureV2Mount, __closeV2Store } = await import('../orchestration/http/mastra-routes.js');
// No background loops: this exercises the consumer surface, not execution.
configureV2Mount({ uri: RS_URI, dbName: TEST_DATABASE, startBackground: false });

const { runWithHarnessExecutionContext } = await import('../services/harness-execution-context.js');
const {
  startDurableJobTool, getDurableJobTool, listDurableJobsTool, cancelDurableJobTool,
  pauseDurableJobTool, resumeDurableJobTool, appendJobInstructionTool,
  steerDurableJobTool, forkDurableJobTool, answerDurableJobTool,
} = await import('../tools/system/orchestration-job-tools.js');
const { connectV2Store } = await import('../orchestration/store/index.js');

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

/** Tools read identity from the ambient run, so every call is wrapped in one. */
function asAgent<T>(agentId: string, threadId: string, fn: () => Promise<T>): Promise<T> {
  return runWithHarnessExecutionContext({ agentId, threadId }, fn);
}

type ToolResult = Record<string, unknown>;
/** `Tool.execute` is optional in the type; every tool here defines it. */
const run = async (tool: { execute?: unknown }, input: unknown): Promise<ToolResult> => {
  const execute = tool.execute as (i: unknown) => Promise<unknown>;
  return await execute(input) as ToolResult;
};

/**
 * Call a tool the way an ORDINARY agent call does: no harness run, identity
 * arriving as Mastra's second argument. Shaped from a runtime dump of the real
 * invocation, not from the type — the type was the thing that was wrong.
 */
const runRt = async (
  tool: { execute?: unknown },
  input: unknown,
  runtime: unknown,
): Promise<ToolResult> => {
  const execute = tool.execute as (i: unknown, rt: unknown) => Promise<unknown>;
  return await execute(input, runtime) as ToolResult;
};

async function main(): Promise<void> {
  console.log('check:durable-job-tools');

  const threadA = `thread_${randomUUID()}`;
  let jobA = '';
  const threadStudio = `thread_${randomUUID()}`;
  let jobStudio = '';

  await check('start returns a durable jobId immediately, without waiting for the job', async () => {
    const out = await asAgent('metaAgent', threadA, () =>
      run(startDurableJobTool, { goal: 'summarize the Q3 report' }));
    assert.equal(out.success, true, `expected success, got ${JSON.stringify(out)}`);
    assert.ok(typeof out.jobId === 'string' && (out.jobId as string).startsWith('job_'), 'a jobId must come back');
    assert.equal(out.deduped, false);
    jobA = out.jobId as string;
  });

  await check('the same idempotencyKey returns the SAME job instead of starting a second one', async () => {
    const key = `idem_${randomUUID()}`;
    const first = await asAgent('metaAgent', threadA, () =>
      run(startDurableJobTool, { goal: 'idempotent goal', idempotencyKey: key }));
    const replay = await asAgent('metaAgent', threadA, () =>
      run(startDurableJobTool, { goal: 'idempotent goal', idempotencyKey: key }));
    assert.equal(first.success, true);
    assert.equal(replay.success, true);
    assert.equal(replay.jobId, first.jobId, 'a retry must not create a second durable job');
    assert.equal(replay.deduped, true);
  });

  await check('the same key with a DIFFERENT goal is refused, not silently applied', async () => {
    const key = `idem_${randomUUID()}`;
    await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'goal one', idempotencyKey: key }));
    const conflict = await asAgent('metaAgent', threadA, () =>
      run(startDurableJobTool, { goal: 'COMPLETELY DIFFERENT goal', idempotencyKey: key }));
    assert.equal(conflict.success, false);
    assert.match(String(conflict.error), /different goal/i);
  });

  await check('reading back a job returns its status and reports it as unfinished', async () => {
    const out = await asAgent('metaAgent', threadA, () => run(getDurableJobTool, { jobId: jobA }));
    assert.equal(out.success, true, `expected success, got ${JSON.stringify(out)}`);
    assert.equal(out.jobId, jobA);
    assert.equal(out.finished, false, 'nothing has executed it — it must not claim to be finished');
    assert.equal(out.terminalOutcome, null);
    assert.equal(out.goal, 'summarize the Q3 report');
    assert.ok(!('result' in out), 'an unfinished job must not carry a result');
  });

  await check('listing is scoped to this conversation', async () => {
    const otherThread = `thread_${randomUUID()}`;
    await asAgent('metaAgent', otherThread, () => run(startDurableJobTool, { goal: 'job in another conversation' }));

    const here = await asAgent('metaAgent', threadA, () => run(listDurableJobsTool, {}));
    assert.equal(here.success, true);
    const goals = (here.jobs as Array<{ goal: string }>).map((j) => j.goal);
    assert.ok(goals.includes('summarize the Q3 report'), 'this conversation\'s job must be listed');
    assert.ok(
      !goals.includes('job in another conversation'),
      'a job from a different conversation must not leak into this list',
    );
  });

  await check('SECURITY: another agent cannot read this job — and it looks missing, not forbidden', async () => {
    const out = await asAgent('intruderAgent', `thread_${randomUUID()}`, () =>
      run(getDurableJobTool, { jobId: jobA }));
    assert.equal(out.success, false, 'a foreign owner must not read the job');
    assert.match(String(out.error), /No such job/i,
      'the error must not reveal that the job exists (no existence oracle)');
  });

  await check('SECURITY: another agent cannot cancel this job', async () => {
    const out = await asAgent('intruderAgent', `thread_${randomUUID()}`, () =>
      run(cancelDurableJobTool, { jobId: jobA }));
    assert.equal(out.success, false, 'a foreign owner must not cancel the job');
    assert.match(String(out.error), /No such job/i);

    // …and the job is genuinely untouched, not merely reported as untouched.
    const owner = await asAgent('metaAgent', threadA, () => run(getDurableJobTool, { jobId: jobA }));
    assert.equal(owner.success, true);
    assert.equal(owner.terminalOutcome, null, 'the foreign cancel must not have taken effect');
  });

  await check('SECURITY: identity cannot be injected through tool input', async () => {
    // Passing owner-ish fields as arguments must change nothing: the schema drops
    // them and identity still comes from the ambient run.
    const out = await asAgent('intruderAgent', `thread_${randomUUID()}`, () =>
      run(getDurableJobTool, { jobId: jobA, resourceId: 'agent:metaAgent', conversationId: threadA }));
    assert.equal(out.success, false, 'model-supplied identity must never grant access');
    assert.match(String(out.error), /No such job/i);
  });

  await check('fail-closed with no run identity at all', async () => {
    const out = await run(startDurableJobTool, { goal: 'no context' });
    assert.equal(out.success, false);
    assert.match(String(out.error), /no run identity/i);
  });

  // ── The OTHER door: an ordinary agent call (Mastra Studio) ─────────────────
  // Every check above wraps its call in a harness run, so all of them passed
  // while the ordinary-agent path was completely broken: the runtime interface
  // declared `agentId`/`threadId` at the top level, Mastra nests them under
  // `agent`, and so every Studio-side call answered "no run identity". The front
  // could hold a conversation but could not queue a single job — found by asking
  // it to, not by any test. These two run WITHOUT a harness context on purpose.
  await check('STUDIO DOOR: an ordinary agent call carries identity and can queue work', async () => {
    const out = await runRt(
      startDurableJobTool,
      { goal: 'queued from an ordinary agent call' },
      { agent: { agentId: 'meta-front', threadId: threadStudio, resourceId: 'user:test' } },
    );
    assert.equal(out.success, true,
      `the ordinary agent path must queue work, got ${JSON.stringify(out)}`);
    jobStudio = out.jobId as string;
    assert.ok(jobStudio, 'a jobId must come back');
  });

  await check('STUDIO DOOR: both spellings land in ONE owner space', async () => {
    // The dedicated front endpoint stamps `metaFrontAgent`; Studio supplies
    // Mastra's `meta-front`. Uncanonicalized these are two owners, and owner
    // scoping reports another owner's job as "No such job" — so the front would
    // lose sight of its own work depending on which door started it, with no
    // error to explain why.
    const viaHarness = await asAgent('metaFrontAgent', threadStudio, () =>
      run(getDurableJobTool, { jobId: jobStudio }));
    assert.equal(viaHarness.success, true,
      `a job queued via Studio must be readable as metaFrontAgent, got ${JSON.stringify(viaHarness)}`);
  });

  await check('cancel crosses the durable stop barrier and the owner can observe it', async () => {
    const started = await asAgent('metaAgent', threadA, () =>
      run(startDurableJobTool, { goal: 'job to cancel' }));
    const jobId = started.jobId as string;

    const cancelled = await asAgent('metaAgent', threadA, () => run(cancelDurableJobTool, { jobId }));
    assert.equal(cancelled.success, true, `expected cancel to be accepted, got ${JSON.stringify(cancelled)}`);

    const after = await asAgent('metaAgent', threadA, () => run(getDurableJobTool, { jobId }));
    assert.equal(after.success, true);
    assert.ok(
      after.terminalOutcome === 'CANCELLED' || after.phase === 'RECONCILING' || after.phase === 'TERMINAL',
      `cancel must move the job toward a terminal state, got phase=${after.phase} outcome=${after.terminalOutcome}`,
    );
  });

  await check('pause → resume → pause again actually pauses BOTH times', async () => {
    // The regression this guards: `applyControl` hashes only {type, jobId}, so a
    // fixed per-job commandId would make the SECOND pause dedupe to the first and
    // return changed:false — the job would silently keep running. Each call must
    // therefore mint a fresh commandId unless one is explicitly supplied.
    const started = await asAgent('metaAgent', threadA, () =>
      run(startDurableJobTool, { goal: 'pause cycle' }));
    const jobId = started.jobId as string;

    const firstPause = await asAgent('metaAgent', threadA, () => run(pauseDurableJobTool, { jobId }));
    assert.equal(firstPause.success, true, `first pause failed: ${JSON.stringify(firstPause)}`);
    assert.equal(firstPause.changed, true, 'the first pause must actually take effect');

    const resumed = await asAgent('metaAgent', threadA, () => run(resumeDurableJobTool, { jobId }));
    assert.equal(resumed.success, true, `resume failed: ${JSON.stringify(resumed)}`);
    assert.equal(resumed.controlState, 'NONE');

    const secondPause = await asAgent('metaAgent', threadA, () => run(pauseDurableJobTool, { jobId }));
    assert.equal(secondPause.success, true);
    assert.equal(
      secondPause.changed,
      true,
      'the SECOND pause must also take effect — a reused commandId would silently no-op here',
    );
  });

  await check('an explicit idempotencyKey still makes a retry of one pause safe', async () => {
    const started = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'pause retry' }));
    const jobId = started.jobId as string;
    const key = `pause_${randomUUID()}`;
    const first = await asAgent('metaAgent', threadA, () => run(pauseDurableJobTool, { jobId, idempotencyKey: key }));
    const retry = await asAgent('metaAgent', threadA, () => run(pauseDurableJobTool, { jobId, idempotencyKey: key }));
    assert.equal(first.changed, true);
    assert.equal(retry.success, true);
    assert.equal(retry.changed, false, 'the retry must be recognized as the same command, not a second pause');
  });

  await check('append adds context without bumping the plan', async () => {
    const started = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'append target' }));
    const jobId = started.jobId as string;
    const before = await asAgent('metaAgent', threadA, () => run(getDurableJobTool, { jobId }));
    const appended = await asAgent('metaAgent', threadA, () =>
      run(appendJobInstructionTool, { jobId, instruction: 'Also mention the deadline.' }));
    assert.equal(appended.success, true, `append failed: ${JSON.stringify(appended)}`);
    assert.equal(appended.instructionCount, 1);
    assert.equal(appended.planVersion, (before as { planVersion?: number }).planVersion ?? 1,
      'append must NOT bump planVersion — that is what steer is for');
  });

  await check('steer works BEFORE any work is materialized', async () => {
    const started = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'steer target' }));
    const steered = await asAgent('metaAgent', threadA, () =>
      run(steerDurableJobTool, { jobId: started.jobId as string, instruction: 'Focus on cost instead.' }));
    assert.equal(steered.success, true, `pre-plan steer should work: ${JSON.stringify(steered)}`);
    assert.equal(steered.planVersion, 2, 'steer must bump the plan');
  });

  await check('steer is refused WITH GUIDANCE once a task exists', async () => {
    // Separate job: the store only admits a task under fresh planning authority,
    // so this must not reuse the steered job above.
    const started = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'steer too late' }));
    const jobId = started.jobId as string;

    const { createTask } = await import('../orchestration/store/index.js');
    const store = await connectV2Store({ uri: RS_URI, dbName: TEST_DATABASE });
    await createTask(store.client, store.db, jobId);
    await store.close();

    const late = await asAgent('metaAgent', threadA, () =>
      run(steerDurableJobTool, { jobId, instruction: 'Change direction now.' }));
    assert.equal(late.success, false, 'post-plan steer must be refused, not silently applied');
    assert.match(String(late.error), /append_instruction|cancel/i,
      'the refusal must tell the caller what to do instead, not just fail');
  });

  await check('fork creates a NEW job and leaves the parent alone', async () => {
    const started = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'fork parent' }));
    const parentId = started.jobId as string;
    const forked = await asAgent('metaAgent', threadA, () =>
      run(forkDurableJobTool, { jobId: parentId, goal: 'fork child goal' }));
    assert.equal(forked.success, true, `fork failed: ${JSON.stringify(forked)}`);
    assert.notEqual(forked.jobId, parentId, 'a fork must be a distinct job');
    assert.equal(forked.parentJobId, parentId);

    const parent = await asAgent('metaAgent', threadA, () => run(getDurableJobTool, { jobId: parentId }));
    assert.equal(parent.success, true);
    assert.equal(parent.terminalOutcome, null, 'forking must not disturb the parent');
  });

  await check('answering a question that is not open is refused with guidance', async () => {
    const started = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'answer target' }));
    const jobId = started.jobId as string;
    const answered = await asAgent('metaAgent', threadA, () =>
      run(answerDurableJobTool, { jobId, requestId: `req_${randomUUID()}`, answer: 'yes' }));
    assert.equal(answered.success, false, 'there is no open request, so this must not report success');
    assert.match(String(answered.error), /no longer open|already answered|expired/i);
  });

  await check('SECURITY: every control command is owner-scoped, not just the reads', async () => {
    const started = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'guarded job' }));
    const jobId = started.jobId as string;
    const intruder = `thread_${randomUUID()}`;

    for (const [name, tool, input] of [
      ['pause', pauseDurableJobTool, { jobId }],
      ['resume', resumeDurableJobTool, { jobId }],
      ['append', appendJobInstructionTool, { jobId, instruction: 'x' }],
      ['steer', steerDurableJobTool, { jobId, instruction: 'x' }],
      ['fork', forkDurableJobTool, { jobId }],
      ['answer', answerDurableJobTool, { jobId, requestId: 'r', answer: 'a' }],
    ] as const) {
      const out = await asAgent('intruderAgent', intruder, () => run(tool, input));
      assert.equal(out.success, false, `${name} must refuse a foreign owner`);
      assert.match(String(out.error), /No such job/i, `${name} must not reveal that the job exists`);
    }

    const owner = await asAgent('metaAgent', threadA, () => run(getDurableJobTool, { jobId }));
    assert.equal(owner.success, true);
    assert.equal(owner.terminalOutcome, null, 'none of the foreign commands may have taken effect');
  });

  await check('the tools refuse cleanly when the feature flag is off', async () => {
    process.env.FEATURE_ORCHESTRATION_V2_AGENT_TOOLS = 'false';
    try {
      const out = await asAgent('metaAgent', threadA, () => run(startDurableJobTool, { goal: 'flagged off' }));
      assert.equal(out.success, false);
      assert.match(String(out.error), /unavailable/i);
    } finally {
      process.env.FEATURE_ORCHESTRATION_V2_AGENT_TOOLS = 'true';
    }
  });

  await __closeV2Store().catch(() => undefined);
  const cleanup = await connectV2Store({ uri: RS_URI, dbName: TEST_DATABASE });
  await cleanup.db.dropDatabase().catch(() => undefined);
  await cleanup.close();

  if (failures > 0) {
    console.error(`\n❌ check:durable-job-tools — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:durable-job-tools — the full command surface (start/get/list/cancel/pause/resume/append/steer/fork/answer) works and ownership cannot be spoofed');
  process.exit(0);
}

main().catch((error) => { console.error(`check failed: ${(error as Error).message}`); process.exit(1); });
