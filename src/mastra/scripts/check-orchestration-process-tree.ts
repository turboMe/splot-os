#!/usr/bin/env tsx
/**
 * Mongo-free Linux proof for the OS half of PROCESS_SUPERVISOR_V1.
 *
 * Durable attempt/fence/stop authority is covered by the replica-set suites.
 * This check keeps the safety-critical `/proc` identity, missing-leader,
 * escaped-descendant and inert-wrapper behavior executable in restricted CI.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AttemptProcessOwnerDoc } from '../orchestration/store/index.js';
import {
  PROCESS_EXECUTION_ID_ENV,
  PROCESS_RUNTIME_RUN_ID_ENV,
  inspectOwnedProcessTree,
  prepareSupervisedProcess,
  readLinuxProcessIdentity,
  readLocalProcessHostIdentity,
  signalOwnedProcessGroup,
  waitForOwnedProcessTreeEmpty,
} from '../orchestration/execution/index.js';

const TARGET_FIXTURE = fileURLToPath(new URL(
  './fixtures/orchestration-process-target.mjs',
  import.meta.url,
));

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

async function spawnOwnedFixture(
  mode: string,
  extraArgs: string[] = [],
): Promise<AttemptProcessOwnerDoc> {
  const local = await readLocalProcessHostIdentity();
  const processExecutionId = `pex_check_${randomUUID()}`;
  const runtimeRunId = `run_check_${randomUUID()}`;
  const child = spawn(
    process.execPath,
    [TARGET_FIXTURE, mode, ...extraArgs],
    {
      detached: true,
      shell: false,
      env: {
        ...process.env,
        [PROCESS_EXECUTION_ID_ENV]: processExecutionId,
        [PROCESS_RUNTIME_RUN_ID_ENV]: runtimeRunId,
        ORCH_FIXTURE_HARD_TTL_MS: '5000',
        ORCH_FIXTURE_ESCAPE_ROOT_DELAY_MS: '150',
      },
      stdio: 'ignore',
    },
  );
  assert.ok(child.pid);

  let identity = await readLinuxProcessIdentity(child.pid);
  for (let retry = 0; !identity && retry < 30; retry++) {
    await sleep(5);
    identity = await readLinuxProcessIdentity(child.pid);
  }
  assert.ok(identity, `${mode} leader identity disappeared before registration`);
  assert.equal(identity.pid, child.pid);
  assert.equal(identity.pgid, child.pid);
  assert.equal(identity.sid, child.pid);
  assert.equal(identity.pidNamespaceId, local.pidNamespaceId);
  const registeredAt = new Date();
  return {
    processExecutionId,
    runtimeRunId,
    workerInstanceId: 'process-tree-check',
    ownerGeneration: 1,
    attemptFence: 1,
    mode: 'PROCESS_GROUP',
    hostId: local.hostId,
    hostBootId: local.hostBootId,
    pidNamespaceId: local.pidNamespaceId,
    pid: identity.pid,
    pgid: identity.pgid,
    sid: identity.sid,
    processStartToken: identity.processStartToken,
    registeredAt,
    startedAt: registeredAt,
  };
}

async function forceExactCleanup(owner: AttemptProcessOwnerDoc): Promise<void> {
  const inspection = await inspectOwnedProcessTree(owner);
  if (inspection.signalSafe) {
    await signalOwnedProcessGroup(owner, 'SIGKILL');
  }
  await waitForOwnedProcessTreeEmpty(owner, {
    timeoutMs: 5_500,
    pollMs: 20,
  });
}

async function main(): Promise<void> {
  console.log('check:orchestration-process-tree');
  if (process.platform !== 'linux') {
    console.log('  ⚠ SKIP — PROCESS_GROUP proof requires Linux');
    return;
  }

  const tracked: AttemptProcessOwnerDoc[] = [];
  try {
    await check(
      'inert wrapper startup timeout exits without starting or group-signalling work',
      async () => {
        const handle = await prepareSupervisedProcess({
          workerInstanceId: 'process-tree-check',
          startupTimeoutMs: 250,
          wrapperHardTtlMs: 700,
        });
        const registeredAt = new Date();
        const owner: AttemptProcessOwnerDoc = {
          ...handle.registration,
          attemptFence: 1,
          registeredAt,
          startedAt: registeredAt,
        };
        tracked.push(owner);
        assert.equal((await inspectOwnedProcessTree(owner)).members.length, 1);
        await assert.rejects(
          handle.completion,
          /supervised wrapper exited before target result \(code=72, signal=null\)/,
        );
        await handle.cleanup();
        const empty = await waitForOwnedProcessTreeEmpty(owner, {
          timeoutMs: 1_000,
          pollMs: 20,
        });
        assert.equal(empty.empty, true);
      },
    );

    await check(
      'missing session leader still permits exact signal of token-owned descendants',
      async () => {
        const owner = await spawnOwnedFixture('term-root-child-survives');
        tracked.push(owner);
        await waitUntil(async () => (
          await inspectOwnedProcessTree(owner)
        ).members.length >= 2, 'owned child did not join the process group');
        // Membership can become visible just before the descendant installs its
        // SIGTERM handler; let the fixture publish that local readiness.
        await sleep(100);
        assert.equal((await signalOwnedProcessGroup(owner, 'SIGTERM')).sent, true);
        await waitUntil(async () => {
          const inspection = await inspectOwnedProcessTree(owner);
          return inspection.leaderState === 'MISSING'
            && inspection.members.length >= 1
            && inspection.signalSafe;
        }, 'leader did not exit while its owned child remained');
        assert.equal((await signalOwnedProcessGroup(owner, 'SIGKILL')).sent, true);
        assert.equal((await waitForOwnedProcessTreeEmpty(owner, {
          timeoutMs: 1_500,
          pollMs: 20,
        })).empty, true);
      },
    );

    await check(
      'escaped token descendant blocks both empty proof and unsafe PGID fallback',
      async () => {
        const owner = await spawnOwnedFixture('escaped-root', ['700']);
        tracked.push(owner);
        await waitUntil(async () => {
          const inspection = await inspectOwnedProcessTree(owner);
          return inspection.leaderState === 'MISSING'
            && inspection.escapedExecutionPids.length > 0;
        }, 'escaped descendant was not detected');
        const inspection = await inspectOwnedProcessTree(owner);
        assert.equal(inspection.empty, false);
        assert.equal(inspection.verifiable, false);
        const signal = await signalOwnedProcessGroup(owner, 'SIGTERM');
        assert.equal(signal.sent, false);
        assert.equal(signal.alreadyEmpty, false);
        assert.equal((await waitForOwnedProcessTreeEmpty(owner, {
          timeoutMs: 2_000,
          pollMs: 20,
        })).empty, true);
      },
    );

    await check(
      'start-token mismatch sends zero signals to a live group',
      async () => {
        const owner = await spawnOwnedFixture('term');
        tracked.push(owner);
        await waitUntil(async () => (
          await inspectOwnedProcessTree(owner)
        ).members.length >= 1, 'term fixture did not become inspectable');
        const wrongOwner = {
          ...owner,
          processStartToken: `${owner.processStartToken}:wrong`,
        };
        assert.equal(
          (await signalOwnedProcessGroup(wrongOwner, 'SIGTERM')).sent,
          false,
        );
        assert.ok((await inspectOwnedProcessTree(owner)).members.length >= 1);
        assert.equal((await signalOwnedProcessGroup(owner, 'SIGTERM')).sent, true);
        assert.equal((await waitForOwnedProcessTreeEmpty(owner, {
          timeoutMs: 1_500,
          pollMs: 20,
        })).empty, true);
      },
    );
  } finally {
    for (const owner of tracked) {
      await forceExactCleanup(owner).catch(() => {});
    }
  }

  if (failures > 0) {
    throw new Error(
      `check:orchestration-process-tree — ${failures} failure(s)`,
    );
  }
  console.log('\n✅ check:orchestration-process-tree — all assertions passed');
}

main().catch((error) => {
  console.error((error as Error).stack ?? (error as Error).message);
  process.exit(1);
});
