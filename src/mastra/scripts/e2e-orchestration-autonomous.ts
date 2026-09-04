#!/usr/bin/env tsx
/**
 * e2e:orchestration-autonomous — the autonomous loop (plan §9.2, ORCH-AUTONOMOUS-WAKE).
 *
 * After `accept`, NOTHING is driven by hand: the lane orchestrator consumes wakes
 * (plan → dispatch → terminalize) and the worker loop claims + submits attempts,
 * until the job reaches a terminal outcome on its own. Also runs two independent
 * jobs to quiescence in the same store (ORCH-PARALLEL-JOBS skeleton).
 *
 * Requires the ephemeral RS. An absent topology is reported as NOT_RUN (and is
 * rejected in G0 gate mode). The runtime owns and verifies throwaway DB cleanup.
 */
import assert from 'node:assert/strict';
import { MongoServerSelectionError } from 'mongodb';
import {
  connectV2Store, ensureOrchestrationIndexes, acceptStartCommand,
  drainLane, runToQuiescence, okWorker, getJobStatus,
  COLLECTIONS, type AttemptDoc, type TaskDoc, type JobEventDoc,
  type WorkerFixture,
} from '../orchestration/store/index.js';
import {
  bindMongoTestDatabase,
  createTestRuntimeOwner,
  publishTestEvidenceBundle,
  TEST_EVIDENCE_BUNDLE_VERSION,
  TestRuntimeTopologyError,
  type TestRuntimeOwner,
} from '../orchestration/testing/test-runtime.js';
import {
  gateEvidenceFdFromEnv,
} from '../orchestration/testing/raw-evidence-sink.js';
import {
  createSuiteEvidenceRecorder,
  type SuiteEvidenceRecorder,
} from '../orchestration/testing/suite-evidence-recorder.js';

const RS_URI = process.env.MONGODB_URI_SPIKE_RS ?? 'mongodb://localhost:27018/?replicaSet=rs0';
const SUITE_ID = 'e2e:orchestration-autonomous';
const proseWorker: WorkerFixture = () => 'trust me, it all worked out fine';

let failures = 0;
let evidenceCutoffInitiated = false;
let activeRecorder: SuiteEvidenceRecorder | undefined;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  activeRecorder?.trace('assertion.started', { name });
  try {
    await fn();
    activeRecorder?.trace('assertion.passed', { name });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    activeRecorder?.trace('assertion.failed', { name, errorClass: safeErrorClass(err) });
    console.error(`  ✗ ${name}: ${safeErrorClass(err)}`);
  }
}

function safeErrorClass(input: unknown): string {
  return input instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(input.name)
    ? input.name
    : 'UnknownError';
}

function emitEvidence(
  owner: TestRuntimeOwner,
  recorder: SuiteEvidenceRecorder,
  testExecutionStatus: 'PASSED' | 'FAILED' | 'NOT_RUN',
  targetInvariantStatus: 'HOLDS' | 'VIOLATED' | 'UNKNOWN',
  summary: Record<string, string | number | boolean | null>,
): void {
  evidenceCutoffInitiated = true;
  const report = owner.createEvidenceReport({
    createdAt: new Date(owner.manifest.createdAt),
    completedAt: new Date(),
    cases: [{
      caseId: SUITE_ID,
      testExecutionStatus,
      targetInvariantStatus,
    }],
    artifacts: recorder.finalize(summary),
  });
  publishTestEvidenceBundle(
    {
      schemaVersion: TEST_EVIDENCE_BUNDLE_VERSION,
      manifest: owner.manifest,
      report,
    },
    gateEvidenceFdFromEnv(process.env.ORCHESTRATION_G0_EVIDENCE_FD),
  );
}

function reportNotRun(owner: TestRuntimeOwner, recorder: SuiteEvidenceRecorder): void {
  const gateRequired = process.env.ORCHESTRATION_G0_GATE === 'true';
  console.log(JSON.stringify({
    schemaVersion: 'g0-test-execution-status/v1',
    suiteId: SUITE_ID,
    testExecutionStatus: 'NOT_RUN',
    reasonCode: 'REPLICA_SET_UNAVAILABLE',
    gateRequired,
  }));
  emitEvidence(owner, recorder, 'NOT_RUN', 'UNKNOWN', {
    reasonCode: 'REPLICA_SET_UNAVAILABLE',
  });
  if (gateRequired) process.exitCode = 1;
}

async function main(): Promise<void> {
  const recorder = createSuiteEvidenceRecorder(SUITE_ID);
  activeRecorder = recorder;
  console.log(SUITE_ID);
  recorder.trace('suite.started');
  const owner = createTestRuntimeOwner({
    suiteId: SUITE_ID,
    topologyUri: RS_URI,
    effectiveConfig: {
      executionProfile: 'DETERMINISTIC',
      runtimeKind: 'DIRECT',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: ['OK', 'INVALID_OUTPUT'],
    },
  });
  let store;
  try {
    store = await connectV2Store({ uri: RS_URI, dbName: owner.databaseName });
  } catch (error) {
    if (error instanceof MongoServerSelectionError) {
      recorder.trace('runtime.not_run', { reasonCode: 'REPLICA_SET_UNAVAILABLE' });
      reportNotRun(owner, recorder);
    } else {
      recorder.trace('runtime.connect_failed', { errorClass: safeErrorClass(error) });
      emitEvidence(owner, recorder, 'FAILED', 'UNKNOWN', {
        reasonCode: 'CONNECT_FAILED',
        errorClass: safeErrorClass(error),
      });
      process.exitCode = 1;
    }
    return;
  }

  const { client, db } = store;
  const databaseHandle = bindMongoTestDatabase(client, db);
  const base = { resourceId: 'res_1', conversationId: 'conv_1', goal: 'autonomous work' };
  let runError: unknown;
  let claimAttempted = false;
  let ownershipClaimed = false;
  const cleanupErrors: unknown[] = [];

  try {
    claimAttempted = true;
    await owner.claimMongoDatabase(databaseHandle);
    ownershipClaimed = true;
    await ensureOrchestrationIndexes(db);

    await check('accept then run-to-quiescence → job COMPLETED with no manual steps', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'auto_ok', payload: { op: 'ok' } });
      const rounds = await runToQuiescence(client, db, drainLane, okWorker);
      assert.ok(rounds >= 1 && rounds < 50, `converged in ${rounds} rounds`);
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.phase, 'TERMINAL');
      assert.equal(st?.terminalOutcome, 'COMPLETED');
      // the whole chain happened autonomously
      const task = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ jobId: acc.jobId });
      assert.equal(task?.phase, 'SUCCEEDED');
      const attempt = await db.collection<AttemptDoc>(COLLECTIONS.attempts).findOne({ jobId: acc.jobId });
      assert.equal(attempt?.lifecycle, 'FINISHED');
      assert.equal(attempt?.outcome, 'OK');
      const types = (await db.collection<JobEventDoc>(COLLECTIONS.events).find({ jobId: acc.jobId }).sort({ sequence: 1 }).toArray()).map((e) => e.type);
      assert.deepEqual(types, ['JobAccepted', 'JobPlanned', 'AttemptResultAvailable', 'JobTerminalized']);
    });

    await check('autonomous failure path → job FAILED (invalid worker output)', async () => {
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'auto_fail', payload: { op: 'fail' } });
      await runToQuiescence(client, db, drainLane, proseWorker);
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.phase, 'TERMINAL');
      assert.equal(st?.terminalOutcome, 'FAILED');
    });

    await check('two independent jobs both reach COMPLETED autonomously', async () => {
      const a = await acceptStartCommand(client, db, { ...base, conversationId: 'conv_A', commandId: 'auto_p1', payload: { op: '1' } });
      const b = await acceptStartCommand(client, db, { resourceId: 'res_2', conversationId: 'conv_B', goal: 'other', commandId: 'auto_p2', payload: { op: '2' } });
      await runToQuiescence(client, db, drainLane, okWorker);
      assert.equal((await getJobStatus(db, base.resourceId, a.jobId))?.terminalOutcome, 'COMPLETED');
      assert.equal((await getJobStatus(db, 'res_2', b.jobId))?.terminalOutcome, 'COMPLETED');
      // isolation: job A's owner cannot see job B
      assert.equal(await getJobStatus(db, base.resourceId, b.jobId), null);
    });

    await check('quiescence is stable — a second run does nothing', async () => {
      const rounds = await runToQuiescence(client, db, drainLane, okWorker);
      assert.equal(rounds, 0, 'no pending wakes or queued attempts remain');
    });
  } catch (err) {
    runError = err;
  } finally {
    const topologyUnavailable = !ownershipClaimed && runError instanceof TestRuntimeTopologyError;
    if (ownershipClaimed) {
      try {
        await owner.captureMongoDatabaseSnapshot(databaseHandle);
        recorder.trace('snapshot.captured');
      } catch (err) {
        recorder.trace('snapshot.failed', { errorClass: safeErrorClass(err) });
        cleanupErrors.push(err);
      }
    }
    if (claimAttempted && !topologyUnavailable) {
      try {
        await owner.cleanupMongoDatabase(databaseHandle);
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await client.close();
    } catch (err) {
      cleanupErrors.push(err);
    }
  }

  if (
    !ownershipClaimed
    && runError instanceof TestRuntimeTopologyError
    && cleanupErrors.length === 0
  ) {
    recorder.trace('runtime.not_run', { reasonCode: 'TOPOLOGY_UNAVAILABLE' });
    reportNotRun(owner, recorder);
    return;
  }
  const lifecycleFailed = runError !== undefined || cleanupErrors.length > 0;
  if (lifecycleFailed) {
    console.error(JSON.stringify({
      schemaVersion: 'g0-test-execution-status/v1',
      suiteId: SUITE_ID,
      testExecutionStatus: 'FAILED',
      reasonCode: 'RUN_OR_CLEANUP_FAILED',
    }));
  } else if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-autonomous — ${failures} failure(s)`);
  } else {
    console.log('\n✅ e2e:orchestration-autonomous — all assertions passed');
  }
  recorder.trace('suite.completed', {
    assertionFailures: failures,
    lifecycleFailed,
  });
  emitEvidence(
    owner,
    recorder,
    lifecycleFailed || failures > 0 ? 'FAILED' : 'PASSED',
    lifecycleFailed || failures > 0 ? 'UNKNOWN' : 'HOLDS',
    {
      assertionCount: 4,
      assertionFailures: failures,
      lifecycleFailed,
    },
  );
  if (lifecycleFailed) {
    process.exitCode = 1;
    return;
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
}

main().catch((err) => {
  if (!evidenceCutoffInitiated) {
    console.error(JSON.stringify({
      schemaVersion: 'g0-test-execution-status/v1',
      suiteId: SUITE_ID,
      testExecutionStatus: 'FAILED',
      reasonCode: err instanceof AggregateError
        ? 'RUN_OR_CLEANUP_FAILED'
        : 'UNEXPECTED_TEST_FAILURE',
    }));
  }
  process.exitCode = 1;
});
