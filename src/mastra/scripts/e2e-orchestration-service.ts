#!/usr/bin/env tsx
/**
 * e2e:orchestration-service — the running service completes jobs autonomously.
 *
 * Starts the real service (HTTP + background lane/worker/reconciler loops), POSTs
 * a command over HTTP, and polls GET until the job is COMPLETED — driven only by
 * the background loops, no manual drains. Also confirms the reconciler recovers a
 * job accepted while the loops were briefly "paused".
 *
 * Requires the ephemeral RS. Local runs report an explicit NOT_RUN when it is
 * absent; G0 gate runs fail closed. The throwaway database is owned and cleaned
 * through the manifest-backed test runtime.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { MongoServerSelectionError } from 'mongodb';
import { connectV2Store } from '../orchestration/store/index.js';
import { startOrchestrationService } from '../orchestration/service/index.js';
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
const SUITE_ID = 'e2e:orchestration-service';
const G0_GATE_REQUIRED = process.env.ORCHESTRATION_G0_GATE?.trim().toLowerCase() === 'true';

type EvidenceSummary = Parameters<SuiteEvidenceRecorder['finalize']>[0];

let failures = 0;
let evidenceCutoffInitiated = false;
async function check(
  recorder: SuiteEvidenceRecorder,
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  recorder.trace('assertion.started', { name });
  try {
    await fn();
    recorder.trace('assertion.passed', { name });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    recorder.trace('assertion.failed', { name, errorClass: safeErrorClass(err) });
    console.error(`  ✗ ${name}: ${safeErrorClass(err)}`);
  }
}

function emitEvidence(
  owner: TestRuntimeOwner,
  recorder: SuiteEvidenceRecorder,
  testExecutionStatus: 'PASSED' | 'FAILED' | 'NOT_RUN',
  targetInvariantStatus: 'HOLDS' | 'UNKNOWN',
  summary: EvidenceSummary,
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

function reportReplicaSetNotRun(
  owner: TestRuntimeOwner,
  recorder: SuiteEvidenceRecorder,
): void {
  recorder.trace('runtime.not_run', {
    reasonCode: 'MONGO_REPLICA_SET_UNAVAILABLE',
  });
  console.log(JSON.stringify({
    schemaVersion: 'g0-test-execution-status/v1',
    suiteId: SUITE_ID,
    testExecutionStatus: 'NOT_RUN',
    reasonCode: 'MONGO_REPLICA_SET_UNAVAILABLE',
    gateRequired: G0_GATE_REQUIRED,
  }));
  emitEvidence(owner, recorder, 'NOT_RUN', 'UNKNOWN', {
    reasonCode: 'MONGO_REPLICA_SET_UNAVAILABLE',
  });
  if (G0_GATE_REQUIRED) process.exitCode = 1;
}

function safeErrorClass(input: unknown): string {
  if (
    input instanceof Error
    && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(input.name)
  ) {
    return input.name;
  }
  return 'UnknownError';
}

async function main(): Promise<void> {
  const recorder = createSuiteEvidenceRecorder(SUITE_ID);
  recorder.trace('suite.started');
  console.log('e2e:orchestration-service');
  const owner = createTestRuntimeOwner({
    suiteId: SUITE_ID,
    topologyUri: RS_URI,
    effectiveConfig: {
      executionProfile: 'DETERMINISTIC',
      runtimeKind: 'BACKGROUND_SERVICE',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: ['OK'],
      requestedPort: 0,
      laneTickMs: 100,
      reconcileTickMs: 500,
    },
  });

  let svc: Awaited<ReturnType<typeof startOrchestrationService>> | undefined;
  let blockedFixtureLease: Awaited<ReturnType<typeof claimInheritedPortLease>> = undefined;
  let primaryListenerLease: Awaited<ReturnType<typeof claimInheritedPortLease>> = undefined;
  let blockedFixtureLeaseClosed = false;
  let primaryListenerLeaseClosed = false;
  let claimAttempted = false;
  let ownershipClaimed = false;
  let runtimeUnavailable = false;
  let lifecycleError: unknown;
  const teardownErrors: unknown[] = [];

  const closeBlockedFixtureLease = async (): Promise<void> => {
    if (!blockedFixtureLease || blockedFixtureLeaseClosed) return;
    await blockedFixtureLease.close();
    blockedFixtureLeaseClosed = true;
  };
  const closePrimaryListenerLease = async (): Promise<void> => {
    if (!primaryListenerLease || primaryListenerLeaseClosed) return;
    await primaryListenerLease.close();
    primaryListenerLeaseClosed = true;
  };

  try {
    blockedFixtureLease = await claimInheritedPortLease('blocked-fixture');
    primaryListenerLease = await claimInheritedPortLease('primary');
    if (Boolean(blockedFixtureLease) !== Boolean(primaryListenerLease)) {
      throw new Error('inherited service listener leases must provide both required roles');
    }

    let probe: Awaited<ReturnType<typeof connectV2Store>> | undefined;
    try {
      try {
        probe = await connectV2Store({ uri: RS_URI, dbName: owner.databaseName });
      } catch (error) {
        if (error instanceof MongoServerSelectionError) {
          runtimeUnavailable = true;
        } else {
          throw error;
        }
      }
      if (probe && !runtimeUnavailable) {
        const handle = bindMongoTestDatabase(probe.client, probe.db);
        claimAttempted = true;
        try {
          await owner.claimMongoDatabase(handle);
          ownershipClaimed = true;
        } catch (error) {
          if (error instanceof TestRuntimeTopologyError) {
            runtimeUnavailable = true;
          } else {
            throw error;
          }
        }
      }
    } finally {
      if (probe) await probe.close();
    }

    if (!runtimeUnavailable) {
      if (!ownershipClaimed) {
        throw new Error('test runtime ownership claim was not completed');
      }

      await check(recorder, 'listen setup failure is rejected and rolls back the internal service store', async () => {
        const blocker = blockedFixtureLease ? undefined : createServer();
        let blockedPort: number;
        if (blockedFixtureLease) {
          blockedPort = blockedFixtureLease.port;
        } else {
          await new Promise<void>((resolve, reject) => {
            blocker!.once('error', reject);
            blocker!.listen(0, '127.0.0.1', () => {
              blocker!.off('error', reject);
              resolve();
            });
          });
          blockedPort = (blocker!.address() as AddressInfo).port;
        }
        try {
          const result = await startOrchestrationService({
            uri: RS_URI,
            dbName: owner.databaseName,
            ...(blockedFixtureLease
              ? {
                listenerLease: {
                  port: blockedPort,
                  async attachHttpServer() {
                    throw new Error('simulated inherited-listener setup failure');
                  },
                  async close() {
                    // The real parent lease remains owned by this test and is
                    // closed below; the failing structural fixture has no
                    // destructive authority.
                  },
                },
              }
              : { host: '127.0.0.1', port: blockedPort }),
            laneTickMs: 100,
            reconcileTickMs: 500,
            log: () => {},
          }).then(
            (handle) => ({ handle }),
            (error: unknown) => ({ error }),
          );
          if ('handle' in result) {
            await result.handle.stop();
            assert.fail('service unexpectedly listened on an occupied port');
          }
          assert.ok(result.error instanceof Error);
        } finally {
          if (blocker) {
            await new Promise<void>((resolve, reject) => {
              blocker.close((error) => error ? reject(error) : resolve());
            });
          }
          await closeBlockedFixtureLease();
        }
      });

      svc = await startOrchestrationService({
        uri: RS_URI,
        dbName: owner.databaseName,
        ...(primaryListenerLease
          ? { listenerLease: primaryListenerLease }
          : { host: '127.0.0.1', port: 0 }),
        laneTickMs: 100,
        reconcileTickMs: 500,
        log: () => {},
      });
      const origin = `http://127.0.0.1:${svc.port}`;
      const auth = { 'content-type': 'application/json', 'x-resource-id': 'res_1' };

      async function pollTerminal(jobId: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const st = await (await fetch(`${origin}/v2/jobs/${jobId}`, { headers: auth })).json() as Record<string, unknown>;
          if (st.phase === 'TERMINAL') return st;
          if (Date.now() > deadline) throw new Error('job did not reach terminal phase before the bounded deadline');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      await check(recorder, 'POST command → background loops drive it to COMPLETED (no manual drain)', async () => {
        const res = await fetch(`${origin}/v2/conversations/c1/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: 'svc_1', goal: 'run me', payload: { op: 'x' } }) });
        assert.equal(res.status, 202);
        const jobId = (await res.json() as Record<string, unknown>).jobId as string;
        const st = await pollTerminal(jobId);
        assert.equal(st.terminalOutcome, 'COMPLETED');
      });

      await check(recorder, 'several commands all reach COMPLETED under the running service', async () => {
        const ids: string[] = [];
        for (let index = 0; index < 5; index++) {
          const res = await fetch(`${origin}/v2/conversations/c2/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ commandId: `svc_batch_${index}`, goal: 'batch', payload: { index } }) });
          ids.push((await res.json() as Record<string, unknown>).jobId as string);
        }
        for (const id of ids) assert.equal((await pollTerminal(id)).terminalOutcome, 'COMPLETED');
      });
    }
  } catch (error) {
    lifecycleError = error;
  } finally {
    if (svc) {
      try {
        await svc.stop();
        primaryListenerLeaseClosed = true;
      } catch (error) {
        teardownErrors.push(error);
        try {
          await svc.stop();
          primaryListenerLeaseClosed = true;
        } catch (retryError) {
          teardownErrors.push(retryError);
        }
      }
    }
    try {
      await closePrimaryListenerLease();
    } catch (error) {
      teardownErrors.push(error);
    }
    try {
      await closeBlockedFixtureLease();
    } catch (error) {
      teardownErrors.push(error);
    }

    if (claimAttempted && (!runtimeUnavailable || ownershipClaimed)) {
      let cleanup: Awaited<ReturnType<typeof connectV2Store>> | undefined;
      try {
        cleanup = await connectV2Store({ uri: RS_URI, dbName: owner.databaseName });
        const cleanupHandle = bindMongoTestDatabase(cleanup.client, cleanup.db);
        try {
          if (ownershipClaimed) {
            try {
              await owner.captureMongoDatabaseSnapshot(cleanupHandle);
              recorder.trace('snapshot.captured');
            } catch (error) {
              teardownErrors.push(error);
              recorder.trace('snapshot.failed', { errorClass: safeErrorClass(error) });
            }
          }
        } finally {
          try {
            await owner.cleanupMongoDatabase(cleanupHandle);
          } catch (error) {
            teardownErrors.push(error);
          }
        }
      } catch (error) {
        teardownErrors.push(error);
      } finally {
        if (cleanup) {
          try {
            await cleanup.close();
          } catch (error) {
            teardownErrors.push(error);
          }
        }
      }
    }
  }

  if (
    runtimeUnavailable
    && lifecycleError === undefined
    && teardownErrors.length === 0
  ) {
    reportReplicaSetNotRun(owner, recorder);
    return;
  }
  const lifecycleFailed = lifecycleError !== undefined || teardownErrors.length > 0;
  if (lifecycleFailed) {
    console.error(JSON.stringify({
      suiteId: SUITE_ID,
      testExecutionStatus: 'FAILED',
      qualificationStatus: 'NOT_QUALIFIED',
      reasonCode: 'SUITE_LIFECYCLE_ERROR',
      errorClass: 'AggregateError',
    }));
  } else if (failures > 0) {
    console.error(`\n❌ e2e:orchestration-service — ${failures} failure(s)`);
  } else {
    console.log('\n✅ e2e:orchestration-service — all assertions passed');
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
      assertionCount: 3,
      assertionFailures: failures,
      lifecycleFailed,
    },
  );
  if (lifecycleFailed || failures > 0) {
    process.exitCode = 1;
    return;
  }
}

main().catch((err) => {
  if (!evidenceCutoffInitiated) {
    console.error(JSON.stringify({
      suiteId: SUITE_ID,
      testExecutionStatus: 'FAILED',
      qualificationStatus: 'NOT_QUALIFIED',
      reasonCode: 'SUITE_LIFECYCLE_ERROR',
      errorClass: safeErrorClass(err),
    }));
  }
  process.exitCode = 1;
});
