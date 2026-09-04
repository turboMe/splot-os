#!/usr/bin/env tsx
/**
 * e2e:orchestration-http — the Meta Front v2 slice over the wire (plan §17).
 *
 * Starts the standalone HTTP server against the store and drives it with fetch:
 * durable 202 accept, idempotent replay, 409 conflict, 401 unauthenticated,
 * owner-scoped 404, status/list, then runs the autonomous loop and confirms the
 * job reports COMPLETED via GET — plus cancel over HTTP.
 *
 * Requires the ephemeral RS. An absent topology is reported as NOT_RUN (and is
 * rejected in G0 gate mode). The runtime owns and verifies throwaway DB cleanup.
 */
import assert from 'node:assert/strict';
import type { AddressInfo, Socket } from 'node:net';
import { MongoServerSelectionError } from 'mongodb';
import {
  connectV2Store, ensureOrchestrationIndexes,
  drainLane, runToQuiescence, okWorker,
} from '../orchestration/store/index.js';
import { createOrchestrationHttpServer } from '../orchestration/http/index.js';
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
import {
  claimInheritedPortLease,
} from '../orchestration/testing/runtime-resource-child.js';

const RS_URI = process.env.MONGODB_URI_SPIKE_RS ?? 'mongodb://localhost:27018/?replicaSet=rs0';
const SUITE_ID = 'e2e:orchestration-http';

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
  targetInvariantStatus: 'HOLDS' | 'UNKNOWN',
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
      runtimeKind: 'LOOPBACK_HTTP',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: ['OK'],
      requestedPort: 0,
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
  let server: ReturnType<typeof createOrchestrationHttpServer> | undefined;
  let listenerLease: Awaited<ReturnType<typeof claimInheritedPortLease>> = undefined;
  const httpConnections = new Set<Socket>();
  let runError: unknown;
  let claimAttempted = false;
  let ownershipClaimed = false;
  const cleanupErrors: unknown[] = [];

  try {
    listenerLease = await claimInheritedPortLease('primary');
    claimAttempted = true;
    await owner.claimMongoDatabase(databaseHandle);
    ownershipClaimed = true;
    await ensureOrchestrationIndexes(db);
    server = createOrchestrationHttpServer({ client, db });
    server.on('connection', (connection: Socket) => {
      httpConnections.add(connection);
      connection.once('close', () => {
        httpConnections.delete(connection);
      });
    });
    let port: number;
    if (listenerLease) {
      await listenerLease.attachHttpServer(server);
      port = listenerLease.port;
    } else {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server!.once('error', onError);
        server!.listen(0, '127.0.0.1', () => {
          server!.off('error', onError);
          resolve();
        });
      });
      port = (server.address() as AddressInfo).port;
    }
    const originUrl = `http://127.0.0.1:${port}`;

    const auth: Record<string, string> = { 'content-type': 'application/json', 'x-resource-id': 'res_1', 'x-principal-id': 'user_1' };
    const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
      fetch(`${originUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const get = (path: string, headers: Record<string, string> = auth) => fetch(`${originUrl}${path}`, { headers });

    await check('unauthenticated request → 401', async () => {
      const res = await post('/v2/conversations/c1/commands', { commandId: 'x', goal: 'g' }, { 'content-type': 'application/json' });
      assert.equal(res.status, 401);
    });

    let jobId = '';
    await check('durable start → 202 with jobId + statusUrl', async () => {
      const res = await post('/v2/conversations/c1/commands', { commandId: 'http_a', goal: 'build', payload: { op: 'x' } });
      assert.equal(res.status, 202);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.commandStatus, 'APPLIED');
      assert.ok(typeof body.jobId === 'string' && (body.jobId as string).startsWith('job_'));
      assert.equal(body.statusUrl, `/v2/jobs/${body.jobId}`);
      jobId = body.jobId as string;
    });

    await check('missing commandId → 400', async () => {
      const res = await post('/v2/conversations/c1/commands', { goal: 'no id' });
      assert.equal(res.status, 400);
    });

    await check('replay same commandId+payload → 202 deduped, same jobId', async () => {
      const res = await post('/v2/conversations/c1/commands', { commandId: 'http_a', goal: 'build', payload: { op: 'x' } });
      assert.equal(res.status, 202);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.jobId, jobId);
      assert.equal(body.deduped, true);
    });

    await check('same commandId, different payload → 409', async () => {
      const res = await post('/v2/conversations/c1/commands', { commandId: 'http_a', goal: 'build', payload: { op: 'DIFFERENT' } });
      assert.equal(res.status, 409);
    });

    await check('GET job → 200 ACCEPTED; wrong owner → 404 (no disclosure)', async () => {
      const ok = await get(`/v2/jobs/${jobId}`);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json() as Record<string, unknown>).phase, 'ACCEPTED');
      const other = await get(`/v2/jobs/${jobId}`, { 'x-resource-id': 'res_OTHER' });
      assert.equal(other.status, 404);
    });

    await check('GET list → contains the job, owner-scoped', async () => {
      const res = await get('/v2/conversations/c1/jobs');
      assert.equal(res.status, 200);
      const body = await res.json() as { jobs: Array<{ jobId: string; resourceId: string }> };
      assert.ok(body.jobs.some((j) => j.jobId === jobId));
      assert.ok(body.jobs.every((j) => j.resourceId === 'res_1'));
    });

    await check('autonomous loop → GET job reports COMPLETED over the wire', async () => {
      await runToQuiescence(client, db, drainLane, okWorker);
      const res = await get(`/v2/jobs/${jobId}`);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.phase, 'TERMINAL');
      assert.equal(body.terminalOutcome, 'COMPLETED');
    });

    await check('cancel over HTTP → 202 then GET shows CANCELLED', async () => {
      const acc = await (await post('/v2/conversations/c2/commands', { commandId: 'http_cancel', goal: 'cancel me', payload: {} })).json() as Record<string, unknown>;
      const cid = acc.jobId as string;
      const cancel = await post(`/v2/jobs/${cid}/commands`, { commandId: 'cancel_http', type: 'cancel_job' });
      assert.equal(cancel.status, 202);
      assert.equal((await cancel.json() as Record<string, unknown>).terminalOutcome, 'CANCELLED');
      const st = await (await get(`/v2/jobs/${cid}`)).json() as Record<string, unknown>;
      assert.equal(st.terminalOutcome, 'CANCELLED');
    });
  } catch (err) {
    runError = err;
  } finally {
    if (listenerLease) {
      try {
        await listenerLease.close();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    if (server) {
      try {
        const closePromise = server.listening
          ? new Promise<void>((resolve, reject) => {
              server!.close((err) => err ? reject(err) : resolve());
            })
          : undefined;
        for (const connection of httpConnections) connection.destroy();
        await closePromise;
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
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
    console.error(`\n❌ e2e:orchestration-http — ${failures} failure(s)`);
  } else {
    console.log('\n✅ e2e:orchestration-http — all assertions passed');
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
      assertionCount: 9,
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
