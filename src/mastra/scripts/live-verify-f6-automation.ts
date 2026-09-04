#!/usr/bin/env tsx
/**
 * Live verification for F6 work item 2 — the Automation Golden Path as a durable
 * job, driven end to end against a REAL replica set and the REAL pipeline.
 *
 * WHY THIS SHAPE, AND WHAT IT DELIBERATELY DOES NOT DO
 * ----------------------------------------------------
 * The obvious canary — ask `automationArchitect` to start a build — would put a
 * model in charge of what gets deployed to the user's live n8n. A model that
 * drifts from the requested payload could create a real workflow there, and that
 * is an outward side effect nobody authorized for a test.
 *
 * So this drives `startAutomationJob` directly, with a workflow that is KNOWN to
 * stop at `runtime_check` — five steps in, and `deploy_inactive` is the sixth.
 * Everything upstream of the deploy is real: the real dispatch, the real command
 * boundary, the real lane, the real native worker, the real Golden Path, the
 * real bridge. Nothing reaches n8n.
 *
 * What this does NOT prove, and must not be claimed to: a cancel arriving in the
 * middle of a build that has already deployed. That needs a run that deploys.
 *
 * Run (needs a replica set):
 *   MONGODB_URI_V2=... MONGODB_DB_V2=orchestration_v2_f6_automation \
 *     npx tsx src/mastra/scripts/live-verify-f6-automation.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.FEATURE_ORCHESTRATION_V2 = 'true';
process.env.FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS = 'true';

const {
  connectV2Store, ensureOrchestrationIndexes, acceptStartCommand, cancelJob,
  getJobStatus, getJobResult, runLaneForJob, drainWorkers, COLLECTIONS,
} = await import('../orchestration/store/index.js');
const { nativeCapabilityWorker } = await import('../orchestration/execution/native-worker.js');
const {
  AUTOMATION_GOLDEN_PATH_CAPABILITY,
  automationGoldenPathExecutor,
  configureDurableAutomationJobs,
  runAutomationCompletionBridge,
} = await import('../services/durable-automation-jobs.js');
const { startAutomationJob, getAutomationJob } = await import('../services/automation-job-manager.js');
const { getDb } = await import('../lib/mongo.js');

const RS_URI = process.env.MONGODB_URI_V2 ?? 'mongodb://localhost:27017/?replicaSet=rs0';
const DB_NAME = process.env.MONGODB_DB_V2 ?? `orchestration_v2_f6_live_${Date.now()}`;

console.log(`live-verify:f6-automation  (store=${DB_NAME})`);

const store = await connectV2Store({ uri: RS_URI, dbName: DB_NAME });
await ensureOrchestrationIndexes(store.db);
const { client, db } = store;

configureDurableAutomationJobs({
  getStore: async () => ({ client, db }),
  accept: (c, d, input) => acceptStartCommand(c, d, input),
  cancel: (c, d, input) => cancelJob(c, d, input),
  readStatus: (d, resourceId, jobId) => getJobStatus(d, resourceId, jobId) as never,
  readResult: (d, resourceId, jobId) => getJobResult(d, resourceId, jobId) as never,
});

const worker = nativeCapabilityWorker({
  executors: { [AUTOMATION_GOLDEN_PATH_CAPABILITY]: automationGoldenPathExecutor },
  fallback: async () => ({ status: 'failed', error: { code: 'no_route', message: 'not a native capability' } }),
});

const thread = `f6-auto-live-${Date.now()}`;
const record = await startAutomationJob({
  input: {
    mode: 'workflow_json',
    // Empty node list: blocked by `runtime_check` long before any deploy.
    workflow: { name: `F6 canary ${randomUUID().slice(0, 8)}`, nodes: [], connections: {} },
    workflowName: 'F6 canary',
  },
  targetAgentId: 'automationArchitect',
  returnToAgentId: 'automationArchitect',
  returnToThreadId: thread,
  wake: true,
});

console.log(`  job=${record.jobId} dispatch=${record.dispatch} v2JobId=${record.v2JobId ?? '(none)'}`);
assert.equal(record.dispatch, 'durable', 'the job must have taken the durable lane');
assert.ok(record.v2JobId, 'and must be linked to a durable job');

const jobDoc = await db.collection(COLLECTIONS.jobs).findOne({ _id: record.v2JobId } as never);
assert.equal(
  (jobDoc as unknown as { requestedCapability?: string })?.requestedCapability,
  AUTOMATION_GOLDEN_PATH_CAPABILITY,
  'the capability must be pinned at the command boundary',
);

// Plan, then dispatch, then run — a planning activation commits one proposal and
// ends, so one lane call never reaches a worker.
for (let i = 0; i < 3; i++) {
  await runLaneForJob(client, db, record.v2JobId!, 50, undefined, {
    attemptCapFor: () => 1_200_000,
  } as never);
  await drainWorkers(client, db, worker as never);
}
await runLaneForJob(client, db, record.v2JobId!, 50, undefined, {} as never);

const task = await db.collection(COLLECTIONS.tasks).findOne({ jobId: record.v2JobId } as never);
const attempts = await db.collection(COLLECTIONS.attempts).find({ jobId: record.v2JobId } as never).toArray();
const status = await getJobStatus(db, record.v2ResourceId!, record.v2JobId!);
const result = await getJobResult(db, record.v2ResourceId!, record.v2JobId!);

console.log(`  task.capability=${(task as unknown as { capability?: string })?.capability}`
  + ` phase=${(task as unknown as { phase?: string })?.phase}`
  + ` attempts=${attempts.length}`
  + ` job.phase=${status?.phase} outcome=${status?.terminalOutcome}`);

assert.equal((task as unknown as { capability?: string })?.capability, AUTOMATION_GOLDEN_PATH_CAPABILITY);
assert.equal(status?.phase, 'TERMINAL', 'the durable job must settle');
assert.ok(result, 'and must commit a result');

const payload = result!.data as Record<string, unknown>;
console.log(`  golden path: status=${payload.status} success=${payload.success}`
  + ` workflowId=${payload.workflowId ?? '(none — nothing deployed)'}`);
assert.equal(payload.success, false, 'the canary workflow is expected to be blocked');
assert.equal(payload.status, 'blocked');
assert.equal(payload.workflowId, undefined, 'SAFETY: nothing may have been deployed to n8n');

await runAutomationCompletionBridge();

const row = await getAutomationJob(record.jobId);
const main = await getDb();
const messages = await main.collection('pending_user_messages')
  .find({ 'metadata.jobId': record.jobId }).toArray();
const progress = (row?.progress ?? []) as Array<{ step: string; status: string }>;

console.log(`  row.status=${row?.status} v2Outcome=${row?.v2TerminalOutcome}`
  + ` progress=[${progress.map((p) => `${p.step}:${p.status}`).join(', ')}]`
  + ` messages=${messages.length}`);

assert.equal(row?.status, 'completed', 'the ATTEMPT finished; the build being blocked is a separate fact');
assert.ok(progress.length >= 5, 'the checkpoint trail must show where the pipeline actually got to');
assert.equal(progress[0].step, 'resolve_workflow');
assert.ok(progress.some((p) => p.step === 'runtime_check' && p.status === 'blocked'));
assert.equal(messages.length, 1, 'the legacy contract is a pending message, and it must arrive');
assert.equal(messages[0].metadata.success, false);
assert.equal(messages[0].metadata.dispatch, 'durable');

// Clean up the row and message this verification created; the V2 database is
// disposable and named per run.
await main.collection('automation_jobs').deleteMany({ jobId: record.jobId });
await main.collection('pending_user_messages').deleteMany({ threadId: thread });
await client.db(DB_NAME).dropDatabase();
await store.close();

console.log('\n✅ live-verify:f6-automation — durable dispatch → pinned native capability → real Golden Path'
  + ' → durable result → legacy contract restored. Nothing was deployed.');
process.exit(0);
