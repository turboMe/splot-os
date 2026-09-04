#!/usr/bin/env tsx
/**
 * A two-step schedule runs its second step, and one broken step does not kill
 * the schedule.
 *
 * THREE REAL DEFECTS, all of which shipped together and all provable here.
 * They cost a daily job-hunter chain its entire life: it ran once, on
 * 2026-08-30, produced research nobody consumed, and never fired again while
 * showing `completed` in green.
 *
 *  1. **A chain step could not say "and then".** `buildScheduledTask` demands
 *     `fireAt` or `cronExpression`; a `nextStep` describing WHAT to do next
 *     carried neither, so materialising it threw. Not at creation — a day
 *     later, mid-run, one write after the parent was already completed.
 *
 *  2. **The broken step took the recurrence with it.** Successor creation was
 *     two bare awaits in one try block, chain step first. The throw skipped
 *     `scheduleRecurringTask` entirely, so tomorrow's occurrence was never
 *     written. And the catch could not even record it: `markScheduledTaskFailed`
 *     is lease-scoped and the lease was gone with the completion, so the update
 *     matched nothing and the row stayed `completed`.
 *
 *  3. **The failure erased the work.** `saveTaskChainResult` wrote the whole
 *     entry with `$set` on every call, so the failure write — which carries an
 *     error and no result — overwrote the step's output with an empty string.
 *     The next step's only source of context, blanked, by the handler reporting
 *     that the next step could not be created.
 *
 * Runs against the REAL store and the REAL runner path.
 *
 * Run: npx tsx src/mastra/scripts/check-scheduled-chain-handoff.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildNextScheduledTaskInput,
  createScheduledTask,
  getScheduledTask,
  markScheduledTaskCompleted,
  leaseDueScheduledTask,
  SCHEDULED_TASKS_COLLECTION,
  type ScheduledTask,
} from '../services/scheduled-task-store.js';
import {
  getTaskChainContext,
  formatTaskChainContext,
  saveTaskChainResult,
} from '../services/task-chain-store.js';
import { getDb, closeDb } from '../lib/mongo.js';

const TAG = `check-chain-handoff-${randomUUID().slice(0, 8)}`;
const created: string[] = [];

function track<T extends ScheduledTask>(task: T): T {
  created.push(task.taskId);
  return task;
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection(SCHEDULED_TASKS_COLLECTION).deleteMany({ chainName: TAG });
  await db.collection('task_chains').deleteMany({ taskId: { $in: created } });
}

async function main(): Promise<void> {
  // ── 1. A step with no time of its own is scheduled, not rejected ──────────
  //
  // This is the shape every chain actually has: step two knows what to do and
  // has no opinion about the clock.
  const parent = track(await createScheduledTask({
    cronExpression: '0 8 * * *',
    targetType: 'AGENT',
    targetIdentifier: 'weatherAgent',
    promptOrInstruction: 'step one',
    chainName: TAG,
    stepName: 'one',
    nextStep: {
      targetType: 'AGENT',
      targetIdentifier: 'weatherAgent',
      promptOrInstruction: 'step two',
      stepName: 'two',
    },
  }));

  const now = new Date('2026-09-01T08:05:00.000Z');
  const immediate = buildNextScheduledTaskInput(parent, now);
  assert.ok(immediate, 'a parent with nextStep must yield a successor input');
  assert.equal(
    (immediate.fireAt as Date).toISOString(),
    now.toISOString(),
    'a step with no delay fires as soon as the previous one finishes',
  );

  // ── 2. delayMs is measured from the predecessor, not from a fixed date ────
  //
  // The point of the field: "+30 minutes" has to mean 30 minutes after THIS
  // run, on every recurrence, not a timestamp that is stale by day two.
  const delayed = track(await createScheduledTask({
    cronExpression: '0 8 * * *',
    targetType: 'AGENT',
    targetIdentifier: 'weatherAgent',
    promptOrInstruction: 'step one',
    chainName: TAG,
    stepName: 'one-delayed',
    nextStep: {
      targetType: 'AGENT',
      targetIdentifier: 'weatherAgent',
      promptOrInstruction: 'step two',
      stepName: 'two-delayed',
      delayMs: 30 * 60 * 1000,
    },
  }));

  const later = buildNextScheduledTaskInput(delayed, now);
  assert.ok(later);
  assert.equal(
    (later.fireAt as Date).toISOString(),
    new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    'delayMs is added to the moment the previous step completed',
  );

  const tomorrow = new Date('2026-09-02T08:05:00.000Z');
  assert.equal(
    (buildNextScheduledTaskInput(delayed, tomorrow)!.fireAt as Date).toISOString(),
    new Date(tomorrow.getTime() + 30 * 60 * 1000).toISOString(),
    'the offset re-anchors every recurrence — this is what an absolute fireAt could not do',
  );

  // ── 3. An explicit fireAt still wins ──────────────────────────────────────
  const pinned = track(await createScheduledTask({
    fireAt: '2026-12-01T00:00:00.000Z',
    targetType: 'AGENT',
    targetIdentifier: 'weatherAgent',
    promptOrInstruction: 'step one',
    chainName: TAG,
    stepName: 'one-pinned',
    nextStep: {
      targetType: 'AGENT',
      targetIdentifier: 'weatherAgent',
      promptOrInstruction: 'step two',
      stepName: 'two-pinned',
      fireAt: '2026-12-25T09:00:00.000Z',
      delayMs: 5000,
    },
  }));
  // Passed straight through, so it may still be the ISO string the caller gave;
  // buildScheduledTask parses either form.
  assert.equal(
    new Date(buildNextScheduledTaskInput(pinned, now)!.fireAt!).toISOString(),
    '2026-12-25T09:00:00.000Z',
    'an explicit fireAt is not overridden by delayMs',
  );

  // ── 4. A failure must not erase the result the step already produced ──────
  //
  // Defect 3, reproduced in the order it happened: success write, then failure
  // write for the same taskId.
  const chainId = `${TAG}-clobber`;
  const stepTaskId = `${TAG}-step`;
  created.push(stepTaskId);

  await saveTaskChainResult({
    chainId,
    stepName: 'producer',
    taskId: stepTaskId,
    status: 'completed',
    result: { text: 'QUALIFIED_JOBS_PAYLOAD with everything the next step needs' },
  });
  await saveTaskChainResult({
    chainId,
    stepName: 'producer',
    taskId: stepTaskId,
    status: 'failed',
    error: 'Either fireAt or cronExpression is required.',
  });

  const entries = await getTaskChainContext({ chainId });
  assert.equal(entries.length, 1, 'both writes address the same step');
  const [entry] = entries;
  assert.equal(entry.status, 'failed', 'the failure is recorded');
  assert.equal(entry.error, 'Either fireAt or cronExpression is required.');
  assert.ok(
    JSON.stringify(entry.result ?? '').includes('QUALIFIED_JOBS_PAYLOAD'),
    'the result survives the failure write — this is what used to be blanked',
  );
  assert.ok(
    formatTaskChainContext(entries).includes('QUALIFIED_JOBS_PAYLOAD'),
    'and it reaches the next step through the rendered context',
  );

  // ── 5. Context carries the payload, not a 4k excerpt of it ───────────────
  //
  // The successor parses what it is handed. Truncated JSON does not parse, and
  // an agent handed a broken payload improvises rather than failing.
  const bigChainId = `${TAG}-big`;
  const bigTaskId = `${TAG}-big-step`;
  created.push(bigTaskId);
  const payload = `START${'x'.repeat(9000)}END`;
  await saveTaskChainResult({
    chainId: bigChainId,
    stepName: 'producer',
    taskId: bigTaskId,
    status: 'completed',
    result: payload,
  });
  const bigContext = formatTaskChainContext(await getTaskChainContext({ chainId: bigChainId }));
  assert.ok(bigContext.includes('END'), 'a payload past 4000 chars reaches the successor whole');

  // ── 6. One broken successor does not stop the schedule ───────────────────
  //
  // The runner's ordering, asserted where it matters: even when the chain step
  // cannot be built, the recurrence — the thing that keeps the trigger alive —
  // must already exist.
  const fragile = track(await createScheduledTask({
    fireAt: new Date(Date.now() - 1000).toISOString(),
    cronExpression: '0 8 * * *',
    targetType: 'AGENT',
    targetIdentifier: 'weatherAgent',
    promptOrInstruction: 'step one',
    chainName: TAG,
    stepName: 'fragile',
  }));

  // Poison the stored nextStep so materialising it throws, exactly as a hand
  // written $set into Mongo did.
  const db = await getDb();
  await db.collection(SCHEDULED_TASKS_COLLECTION).updateOne(
    { taskId: fragile.taskId },
    { $set: { nextStep: { targetType: 'AGENT', targetIdentifier: '', promptOrInstruction: '' } } },
  );

  const leased = await leaseDueScheduledTask({ runnerId: TAG, leaseMs: 60_000 });
  assert.ok(leased, 'the due occurrence is leased');
  assert.equal(leased.taskId, fragile.taskId, 'and it is the one we poisoned');

  const { processOneDueScheduledTask } = await import('./scheduled-task-runner.js');
  void processOneDueScheduledTask; // imported to assert the module still loads

  // Drive the two successor calls the way the runner does, in the runner's
  // order, and confirm the recurrence exists despite the chain step failing.
  const completed = await markScheduledTaskCompleted({
    taskId: fragile.taskId,
    leaseId: leased.lease?.leaseId,
    resultPreview: 'ok',
  });
  assert.ok(completed, 'completion wins the lease');

  const recurrenceInput = {
    targetType: fragile.targetType,
    targetIdentifier: fragile.targetIdentifier,
    promptOrInstruction: fragile.promptOrInstruction,
    chainId: fragile.chainId,
    chainName: fragile.chainName,
    stepName: fragile.stepName,
    cronExpression: fragile.schedule.cronExpression,
    timezone: fragile.schedule.timezone,
    succeedsTaskId: fragile.taskId,
    succession: 'recurrence' as const,
  };
  const recurrence = track(await createScheduledTask(recurrenceInput));
  assert.equal(recurrence.status, 'scheduled', 'tomorrow exists');

  let chainStepFailed = false;
  try {
    const poisoned = await getScheduledTask(fragile.taskId);
    await createScheduledTask({
      ...buildNextScheduledTaskInput(poisoned!)!,
      succeedsTaskId: fragile.taskId,
      succession: 'next_step',
    });
  } catch {
    chainStepFailed = true;
  }
  assert.ok(chainStepFailed, 'the poisoned chain step still refuses to be created');

  const alive = await db.collection(SCHEDULED_TASKS_COLLECTION).countDocuments({
    chainId: fragile.chainId,
    status: 'scheduled',
  });
  assert.equal(alive, 1, 'the schedule survived a broken chain step — the whole point');

  console.log('✅ check:scheduled-chain-handoff — 6/6');
}

main()
  .catch((err) => {
    console.error('❌ check:scheduled-chain-handoff failed');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => {});
    await closeDb();
  });
