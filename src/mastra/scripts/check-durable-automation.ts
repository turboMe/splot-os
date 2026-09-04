#!/usr/bin/env tsx
/**
 * F6 work item 2 — the Automation Golden Path on durable jobs.
 *
 * This mechanism has the widest blast radius in the system: it DEPLOYS to n8n.
 * So the assertions are about the three defects being actually gone, not about
 * the new code path existing:
 *
 *  1. **Cancel must cancel.** Before this, `liveJobs` was a process-local Map
 *     read at three points, none of them inside the pipeline. A cancel during a
 *     build set the row to `cancelled` and let the deploy/test/repair loop carry
 *     on — the operator's stop suppressed the REPORT, not the work. The tests
 *     drive a real Golden Path run and assert it stops at a step boundary, and
 *     that it reports whether n8n was touched before it stopped.
 *  2. **The input must be durable.** It used to live only in the closure of
 *     `void executeAutomationJob(...)`, so a surviving row described work nobody
 *     could re-run. A row without it must FAIL VISIBLY rather than guess.
 *  3. **Progress must be observable.** `lastHeartbeatAt` proves a process is
 *     alive and says nothing about whether the run is at `risk_score` or three
 *     repairs deep.
 *
 * Plus the native-capability seam itself, which is new machinery: a capability
 * may now name a FUNCTION, and the map it selects from must be closed.
 *
 * Nothing here deploys anything. The Golden Path runs are driven to an EARLY
 * blocked/cancelled boundary — every assertion below sits before
 * `deploy_inactive`, which is the first step that writes to n8n.
 *
 * Run: npx tsx src/mastra/scripts/check-durable-automation.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  nativeCapabilityWorker,
  isNativeCapability,
  type NativeCapabilityExecutor,
} from '../orchestration/execution/native-worker.js';
import type { WorkerContext } from '../orchestration/store/worker.js';
import {
  AUTOMATION_GOLDEN_PATH_ATTEMPT_CAP_MS,
  AUTOMATION_GOLDEN_PATH_CAPABILITY,
  configureDurableAutomationJobs,
  dispatchDurableAutomationJob,
  durableAutomationJobsEnabled,
  runAutomationCompletionBridge,
  __resetDurableAutomationJobs,
} from '../services/durable-automation-jobs.js';
import { skipSectionOrFail } from './lib/replica-set.js';
import {
  executeAutomationGoldenPath,
  AutomationGoldenPathCancelled,
} from '../services/automation-golden-path.js';

// The `canary` Golden Path runs below deliberately hit the real blocked/failed
// path, which logs to `agent_events` via automation-failure-learning.ts — the
// same collection the dashboard reads for automationArchitect health. Nothing
// in this file ever cleaned that up, so every run left permanent "failed"
// entries a real user never caused. Scoped by time + the `canary` marker so
// we never touch a genuine run.
const testStartedAt = new Date();

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

function withFlags<T>(flags: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(flags).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(flags)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const ON = { FEATURE_ORCHESTRATION_V2: 'true', FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS: 'true' };
const OFF = { FEATURE_ORCHESTRATION_V2: 'true', FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS: undefined };

function workerCtx(over: Partial<WorkerContext> = {}): WorkerContext {
  return {
    attemptId: 'att_1', taskId: 'tsk_1', jobId: 'job_1', attemptNumber: 1,
    businessOperationCutoffAt: new Date(Date.now() + 10_000),
    workDeadlineAt: new Date(Date.now() + 20_000),
    hardDeadlineAt: new Date(Date.now() + 30_000),
    goal: 'build an automation', instructions: [],
    ...over,
  };
}

console.log('check:durable-automation');

// ── 1. The native-capability seam ──────────────────────────────────────────
await check('a capability naming a FUNCTION runs it instead of an agent', async () => {
  const seen: string[] = [];
  const worker = nativeCapabilityWorker({
    executors: { native_thing: async (ctx) => { seen.push(ctx.jobId); return { status: 'ok', data: { ran: true } }; } },
    fallback: async () => ({ status: 'ok', data: { fellBack: true } }),
  });
  const r = await worker(workerCtx({ capability: 'native_thing' })) as { data: Record<string, unknown> };
  assert.deepEqual(r.data, { ran: true });
  assert.deepEqual(seen, ['job_1'], 'the executor gets the real worker context, not a synthetic one');
});

await check('everything else still reaches the agent worker, unchanged', async () => {
  const worker = nativeCapabilityWorker({
    executors: { native_thing: async () => ({ status: 'ok', data: { ran: true } }) },
    fallback: async () => ({ status: 'ok', data: { fellBack: true } }),
  });
  for (const capability of ['chefAgent', undefined, null]) {
    const r = await worker(workerCtx({ capability: capability as never })) as { data: Record<string, unknown> };
    assert.deepEqual(r.data, { fellBack: true }, `capability=${String(capability)} must not be native`);
  }
});

await check('SECURITY: a capability cannot select something off the prototype chain', async () => {
  // The name reaching here came through a plan a model influenced. With a plain
  // `in`/property read, `toString` or `constructor` would resolve to a function
  // and get invoked as an executor.
  const worker = nativeCapabilityWorker({
    executors: {},
    fallback: async () => ({ status: 'ok', data: { fellBack: true } }),
  });
  for (const junk of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = await worker(workerCtx({ capability: junk })) as { data: Record<string, unknown> };
    assert.deepEqual(r.data, { fellBack: true }, `${junk} must not resolve to an executor`);
  }
  assert.equal(isNativeCapability({}, 'toString'), false);
});

await check('a throwing executor is a FAILED attempt, not a dead worker loop', async () => {
  const worker = nativeCapabilityWorker({
    executors: { boom: async () => { throw new Error('n8n unreachable'); } },
    fallback: async () => ({ status: 'ok', data: {} }),
  });
  const r = await worker(workerCtx({ capability: 'boom' })) as { status: string; error: { code: string; message: string } };
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'native_executor_failed');
  assert.match(r.error.message, /n8n unreachable/);
});

// ── 2. Cancel actually cancels ─────────────────────────────────────────────
await check('LIVE REGRESSION: an aborted Golden Path STOPS at a step boundary', async () => {
  // The defect: cancellation used to suppress the result while the pipeline kept
  // deploying and repairing. Abort before the first step and the run must come
  // back cancelled, with nothing deployed.
  const controller = new AbortController();
  controller.abort();
  const result = await executeAutomationGoldenPath(
    { mode: 'workflow_json', workflow: { name: 'canary', nodes: [], connections: {} }, workflowName: 'canary' },
    { signal: controller.signal },
  );
  assert.equal(result.success, false);
  assert.equal(result.failureClass, 'cancelled', 'a stop is not a build failure');
  assert.equal(result.workflowId, undefined, 'stopping before deploy must leave n8n untouched');
  assert.match(result.message, /nothing was deployed/);
  assert.ok(result.steps.some((s) => s.name === 'cancelled'), 'the trail must record the stop');
});

await check('a cancellation reports WHETHER n8n was already touched', async () => {
  // Stopping before `deploy_inactive` leaves nothing; stopping after it leaves an
  // inactive draft somebody has to look at. Telling the operator which one
  // happened is the whole value of the message.
  const cancelled = new AutomationGoldenPathCancelled('risk_score');
  assert.match(cancelled.message, /risk_score/);
  assert.equal(cancelled.name, 'AutomationGoldenPathCancelled');
});

await check('every completed step is checkpointed BEFORE the stop is honoured', async () => {
  // Ordering matters: the step that just finished is a fact, and a stop arriving
  // now must not erase the record of it — especially when "here" is already past
  // a deploy.
  const steps: string[] = [];
  const controller = new AbortController();
  const result = await executeAutomationGoldenPath(
    { mode: 'workflow_json', workflow: { name: 'canary', nodes: [], connections: {} }, workflowName: 'canary' },
    {
      onStep: (step) => {
        steps.push(step.name);
        // Stop as soon as the pipeline reports its first real step.
        controller.abort();
      },
      signal: controller.signal,
    },
  );
  assert.ok(steps.length >= 1, 'at least one step must have been observed');
  assert.equal(steps[0], 'resolve_workflow', 'the observed step is the one that actually ran');
  assert.equal(result.failureClass, 'cancelled');
  assert.equal(result.steps[0].name, 'resolve_workflow', 'and it survives into the result');
});

await check('an observer that throws cannot break the build it is watching', async () => {
  const result = await executeAutomationGoldenPath(
    { mode: 'workflow_json', workflow: { name: 'canary', nodes: [], connections: {} }, workflowName: 'canary' },
    { onStep: () => { throw new Error('mongo down'); } },
  );
  assert.ok(result.steps.length > 0, 'the pipeline must keep running past a failed checkpoint write');
  assert.notEqual(result.failureClass, 'cancelled');
});

// ── 3. Dispatch: fail-open and pinned ──────────────────────────────────────
function recordingConfig() {
  const accepted: Array<Record<string, unknown>> = [];
  const cancelled: Array<Record<string, unknown>> = [];
  return {
    accepted,
    cancelled,
    cfg: {
      getStore: async () => ({ client: {} as never, db: {} as never }),
      accept: async (_c: never, _d: never, input: Record<string, unknown>) => {
        accepted.push(input);
        return { jobId: `job_${accepted.length}` };
      },
      cancel: async (_c: never, _d: never, input: Record<string, unknown>) => { cancelled.push(input); return {}; },
      readStatus: async () => null,
      readResult: async () => null,
    } as never,
  };
}

await check('the flag off means the legacy lane, untouched', async () => {
  const { cfg, accepted } = recordingConfig();
  configureDurableAutomationJobs(cfg);
  const r = await withFlags(OFF, () => dispatchDurableAutomationJob({
    jobId: 'aj_1', goal: 'build', ownerAgentId: 'automationArchitect', conversationId: 'conv',
  }));
  assert.equal(r, null);
  assert.equal(accepted.length, 0);
});

await check('no composition root means the legacy lane, not a crash', async () => {
  __resetDurableAutomationJobs();
  const r = await withFlags(ON, () => dispatchDurableAutomationJob({
    jobId: 'aj_1', goal: 'build', ownerAgentId: 'automationArchitect', conversationId: 'conv',
  }));
  assert.equal(r, null);
});

await check('a store that will not answer falls back instead of throwing', async () => {
  const broken = recordingConfig();
  configureDurableAutomationJobs({
    ...(broken.cfg as unknown as Record<string, unknown>),
    getStore: async () => { throw new Error('mongo unreachable'); },
  } as never);
  const r = await withFlags(ON, () => dispatchDurableAutomationJob({
    jobId: 'aj_1', goal: 'build', ownerAgentId: 'automationArchitect', conversationId: 'conv',
  }));
  assert.equal(r, null, 'a build always has a lane that exists');
});

await check('a dispatched job is PINNED to the native capability, keyed by its own id', async () => {
  const { cfg, accepted } = recordingConfig();
  configureDurableAutomationJobs(cfg);
  const r = await withFlags(ON, () => dispatchDurableAutomationJob({
    jobId: 'aj_42', goal: 'build a telegram bot', ownerAgentId: 'automationArchitect', conversationId: 'conv_7',
  }));
  assert.ok(r);
  assert.equal(accepted[0].capability, AUTOMATION_GOLDEN_PATH_CAPABILITY);
  assert.equal(accepted[0].resourceId, 'agent:automationArchitect');
  assert.equal(accepted[0].conversationId, 'conv_7');
  // A retried start must resume the same build, not deploy a second workflow for
  // one request.
  assert.equal(accepted[0].commandId, 'automation:aj_42');
});

await check('the Golden Path keeps its OWN 20-minute window, not the store default', async () => {
  // The store default is 300s — a third of what a deploy/test/repair cycle has
  // always had. Inheriting it silently would cut builds mid-repair and look like
  // the pipeline got worse rather than like the budget changed.
  assert.ok(AUTOMATION_GOLDEN_PATH_ATTEMPT_CAP_MS >= 1_200_000,
    `expected >= 20 minutes, got ${AUTOMATION_GOLDEN_PATH_ATTEMPT_CAP_MS}ms`);
});

await check('durableAutomationJobsEnabled needs BOTH flags', () => {
  assert.equal(withFlags(ON, durableAutomationJobsEnabled), true);
  assert.equal(withFlags(OFF, durableAutomationJobsEnabled), false);
  assert.equal(
    withFlags({ FEATURE_ORCHESTRATION_V2: undefined, FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS: 'true' }, durableAutomationJobsEnabled),
    false,
    'the cutover must not outlive the substrate it depends on',
  );
});

// ── 4. The executor and the bridge, against the main database ──────────────
const { getDb } = await import('../lib/mongo.js');
let main: Awaited<ReturnType<typeof getDb>> | undefined;
try {
  main = await getDb();
  await main.command({ ping: 1 });
} catch (error) {
  skipSectionOrFail(
    'check:durable-automation database section',
    `the main database is unavailable (${(error as Error).message})`,
    'start it with `npm run mongo:up`',
  );
  main = undefined;
}

if (main) {
  const MARK = `chk_autodur_${Date.now()}`;
  const rows = main.collection('automation_jobs');
  const messages = main.collection('pending_user_messages');
  const { automationGoldenPathExecutor } = await import('../services/durable-automation-jobs.js');

  const seed = async (over: Record<string, unknown> = {}): Promise<{ jobId: string; v2JobId: string }> => {
    const jobId = `${MARK}_${randomUUID()}`;
    const v2JobId = `job_${jobId}`;
    await rows.insertOne({
      jobId,
      automationId: `auto_${jobId}`,
      targetAgentId: 'automation-architect',
      returnToAgentId: 'automation-architect',
      returnToThreadId: `${MARK}_thread`,
      status: 'queued',
      dispatch: 'durable',
      inputPreview: '{"mode":"workflow_json"}',
      goldenPathInput: { mode: 'workflow_json', workflow: { name: 'canary', nodes: [], connections: {} }, workflowName: 'canary' },
      progress: [],
      startedAt: new Date(Date.now() - 3_000),
      lastHeartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      v2JobId,
      v2ResourceId: 'agent:automationArchitect',
      ...over,
    });
    return { jobId, v2JobId };
  };
  const bridgeWith = (status: unknown, result: unknown) => configureDurableAutomationJobs({
    getStore: async () => ({ client: {} as never, db: {} as never }),
    accept: async () => ({ jobId: 'unused' }),
    cancel: async () => ({}),
    readStatus: async () => status,
    readResult: async () => result,
  } as never);
  const messagesFor = (jobId: string) => messages.find({ 'metadata.jobId': jobId }).toArray();

  await check('LIVE REGRESSION: the executor returns a VALID producer envelope', async () => {
    // The bug this exists for: `summarizeForResult` set absent fields to
    // `undefined`, the envelope validator rejects any value JSON cannot round-trip,
    // and the attempt came back `invalid_result` → job FAILED with no result at
    // all. A Golden Path that ran correctly for five steps reported as a crash.
    //
    // It survived every test above because they validated the bridge against a
    // FAKE readResult. So this one runs the executor and hands its output to the
    // REAL validator the A boundary uses — the only thing whose opinion counts.
    const { validateProducerResult } = await import('../orchestration/contracts/result-envelope.js');
    const { v2JobId } = await seed();
    const out = await automationGoldenPathExecutor(workerCtx({
      jobId: v2JobId, capability: AUTOMATION_GOLDEN_PATH_CAPABILITY,
    }));
    const validation = validateProducerResult(out);
    assert.ok(validation.ok, `the A boundary rejected the envelope: ${JSON.stringify(validation)}`);
    // The blocked canary exercises the absent-field path that actually broke.
    const data = (out as { data: Record<string, unknown> }).data;
    assert.ok(!('workflowId' in data), 'an absent field must be OMITTED, not present-and-undefined');
    assert.equal(data.status, 'blocked');
  });

  await check('a cancelled run also returns a valid envelope', async () => {
    const { validateProducerResult } = await import('../orchestration/contracts/result-envelope.js');
    const { v2JobId } = await seed();
    const controller = new AbortController();
    controller.abort();
    const out = await automationGoldenPathExecutor(workerCtx({
      jobId: v2JobId, capability: AUTOMATION_GOLDEN_PATH_CAPABILITY, signal: controller.signal,
    }));
    assert.ok(validateProducerResult(out).ok, 'the cancellation path has its own field set — validate it too');
  });

  await check('the executor finds its input through the LINK, not a copied payload', async () => {
    // Duplicating a workflow spec into the orchestration store would create two
    // copies that can disagree about what is being built.
    const { jobId, v2JobId } = await seed();
    const controller = new AbortController();
    controller.abort();
    const out = await automationGoldenPathExecutor(workerCtx({
      jobId: v2JobId, capability: AUTOMATION_GOLDEN_PATH_CAPABILITY, signal: controller.signal,
    })) as { status: string; data: Record<string, unknown> };
    assert.equal(out.status, 'ok');
    assert.equal(out.data.failureClass, 'cancelled', 'the attempt signal reaches the pipeline');
    const row = await rows.findOne({ jobId });
    assert.equal(row?.status, 'running', 'the executor claims the row it found');
  });

  await check('a row with no durable input FAILS VISIBLY instead of guessing', async () => {
    // Re-running a build from a redacted preview would be guessing at what to
    // deploy. Rows written before F6 have exactly this shape.
    const { v2JobId } = await seed({ goldenPathInput: undefined });
    await rows.updateOne({ v2JobId }, { $unset: { goldenPathInput: '' } });
    const out = await automationGoldenPathExecutor(workerCtx({
      jobId: v2JobId, capability: AUTOMATION_GOLDEN_PATH_CAPABILITY,
    })) as { status: string; error: { code: string } };
    assert.equal(out.status, 'failed');
    assert.equal(out.error.code, 'automation_input_missing');
  });

  await check('an unlinked durable job fails rather than running something arbitrary', async () => {
    const out = await automationGoldenPathExecutor(workerCtx({
      jobId: 'job_does_not_exist', capability: AUTOMATION_GOLDEN_PATH_CAPABILITY,
    })) as { status: string; error: { code: string } };
    assert.equal(out.status, 'failed');
    assert.equal(out.error.code, 'automation_row_missing');
  });

  await check('progress is checkpointed IN ORDER while the pipeline runs', async () => {
    // Order is the point. The first version fired each `$push` concurrently and
    // the trail came back scrambled (`coverage_check` before `resolve_workflow`),
    // which answers "which steps ran" but not "where did it get to" — the only
    // question anyone asks a progress trail. Caught by this assertion, not by
    // reasoning about it.
    const { jobId, v2JobId } = await seed();
    await automationGoldenPathExecutor(workerCtx({
      jobId: v2JobId, capability: AUTOMATION_GOLDEN_PATH_CAPABILITY,
    }));
    // The writes are deliberately fire-and-forget, so give the chain a tick.
    await new Promise((r) => setTimeout(r, 500));
    const row = await rows.findOne({ jobId });
    const progress = (row?.progress ?? []) as Array<{ seq: number; step: string; status: string }>;
    assert.ok(progress.length >= 5, 'lastHeartbeatAt proves a process is alive; this says where the run got to');
    assert.equal(progress[0].step, 'resolve_workflow', 'the trail must start where the pipeline started');
    assert.ok(
      progress.some((p) => p.step === 'runtime_check' && p.status === 'blocked'),
      'and must end at the step that actually stopped it',
    );
    assert.deepEqual(
      progress.map((p) => p.seq),
      progress.map((_, i) => i),
      'sequence numbers must be contiguous and ordered',
    );
  });

  await check('a BLOCKED build is a completed job, not a failed one', async () => {
    // A policy violation or a risk verdict is the system working. Reporting it as
    // a failed job would make every correct block look like an outage — and the
    // lane would retry a refusal that will refuse again.
    const { jobId, v2JobId } = await seed();
    bridgeWith(
      { phase: 'TERMINAL', terminalOutcome: 'COMPLETED' },
      { status: 'ok', data: { success: false, status: 'blocked', message: 'Risk verdict block', repairAttempts: 0 } },
    );
    void v2JobId;
    await runAutomationCompletionBridge();
    const row = await rows.findOne({ jobId });
    assert.equal(row?.status, 'completed', 'the ATTEMPT finished — that is what the row status means');
    const queued = await messagesFor(jobId);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].metadata.success, false, 'and the BUILD did not succeed — a separate question');
    assert.match(String(queued[0].content), /Risk verdict block/);
    assert.equal(queued[0].urgent, true, 'a build that did not land should interrupt');
  });

  await check('a successful build reports success', async () => {
    const { jobId } = await seed();
    bridgeWith(
      { phase: 'TERMINAL', terminalOutcome: 'COMPLETED' },
      { status: 'ok', data: { success: true, status: 'tested', workflowId: 'wf_1', message: 'deployed + tested', repairAttempts: 1 } },
    );
    await runAutomationCompletionBridge();
    const row = await rows.findOne({ jobId });
    assert.equal(row?.status, 'completed');
    const queued = await messagesFor(jobId);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].metadata.success, true);
    assert.equal(queued[0].metadata.workflowId, 'wf_1');
    assert.match(String(queued[0].content), /Automation Job Result/);
  });

  await check('the bridge is idempotent — a second pass adds nothing', async () => {
    const { jobId } = await seed();
    bridgeWith(
      { phase: 'TERMINAL', terminalOutcome: 'COMPLETED' },
      { status: 'ok', data: { success: true, status: 'tested', workflowId: 'wf_2', message: 'ok', repairAttempts: 0 } },
    );
    await runAutomationCompletionBridge();
    await rows.updateOne({ jobId }, { $set: { status: 'running' } });
    await runAutomationCompletionBridge();
    assert.equal((await messagesFor(jobId)).length, 1,
      'a redelivered terminal must collapse, not queue a second build report');
  });

  await check('a job still building is left alone', async () => {
    const { jobId } = await seed();
    bridgeWith({ phase: 'DISPATCHING', terminalOutcome: null }, null);
    assert.equal(await runAutomationCompletionBridge(), 0);
    assert.equal((await rows.findOne({ jobId }))?.status, 'queued');
    assert.equal((await messagesFor(jobId)).length, 0);
  });

  await check('a LEGACY-dispatched job is not touched by the bridge', async () => {
    const { jobId } = await seed({ dispatch: 'legacy' });
    await rows.updateOne({ jobId }, { $unset: { v2JobId: '' } });
    bridgeWith({ phase: 'TERMINAL', terminalOutcome: 'COMPLETED' }, { status: 'ok', data: { success: true } });
    await runAutomationCompletionBridge();
    assert.equal((await rows.findOne({ jobId }))?.status, 'queued', 'the legacy lane owns its own completion');
    assert.equal((await messagesFor(jobId)).length, 0);
  });

  await rows.deleteMany({ jobId: { $regex: `^${MARK}` } });
  await messages.deleteMany({ threadId: `${MARK}_thread` });
  await main.collection('agent_events').deleteMany({
    agentId: 'automationArchitect',
    toolId: 'architect_execute_automation_request',
    input: { $regex: '"workflowName":"canary"' },
    timestamp: { $gte: testStartedAt },
  });
}

__resetDurableAutomationJobs();

console.log(failures === 0 ? '\n✅ check:durable-automation passed' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
