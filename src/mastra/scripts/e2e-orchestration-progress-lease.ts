#!/usr/bin/env tsx
/**
 * Durable earned-time lease: owner/fence/control/cutoff/dedupe and deadline math.
 * Uses a throwaway replica-set database. Skips without a replica set — or FAILS
 * under REQUIRE_RS=1, which the gate sets.
 */
import assert from 'node:assert/strict';

import {
  acceptStartCommand,
  claimAttempt,
  COLLECTIONS,
  createTask,
  dispatchAttempt,
  ensureOrchestrationIndexes,
  recordAttemptProgressAndExtend,
  startAttemptOperation,
  type AttemptDoc,
  type JobDoc,
  type TaskDoc,
} from '../orchestration/store/index.js';
import type { ProgressiveAttemptPolicy } from '../orchestration/contracts/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const POLICY: ProgressiveAttemptPolicy = {
  initialWindowMs: 900_000,
  extensionMs: 300_000,
  extensionLeadMs: 480_000,
  maxCapMs: 2_700_000,
  maxExtensions: 6,
};

const hash = (char: string) => `writer-content:${char.repeat(64)}`;

async function main(): Promise<void> {
  console.log('e2e:orchestration-progress-lease');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_progress_e2e_${Date.now()}`,
    section: 'e2e:orchestration-progress-lease',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const attempts = db.collection<AttemptDoc>(COLLECTIONS.attempts);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);

  try {
    await ensureOrchestrationIndexes(db);
    const accepted = await acceptStartCommand(client, db, {
      resourceId: 'res-progress',
      conversationId: 'conv-progress',
      goal: 'Write a five chapter story and complete its review loop.',
      commandId: 'cmd-progress',
      payload: { kind: 'progress-check' },
    });
    const taskId = await createTask(client, db, accepted.jobId, 1, {
      capability: 'writerAgent',
      attemptCapMs: POLICY.maxCapMs,
      progressiveAttempt: POLICY,
    });
    assert.deepEqual((await tasks.findOne({ _id: taskId }))?.progressiveAttempt, POLICY);

    const { attemptId } = await dispatchAttempt(client, db, {
      jobId: accepted.jobId,
      taskId,
    });
    const dispatched = await attempts.findOne({ _id: attemptId });
    assert.ok(dispatched);
    assert.deepEqual(dispatched.progressiveAttempt, POLICY);
    assert.ok(dispatched.absoluteHardDeadlineAt);
    assert.ok(
      Math.abs(
        dispatched.hardDeadlineAt.getTime()
        - dispatched.createdAt.getTime()
        - POLICY.initialWindowMs,
      ) < 25,
      'the attempt initially owns only 15 minutes',
    );
    assert.ok(
      Math.abs(
        dispatched.absoluteHardDeadlineAt!.getTime()
        - dispatched.createdAt.getTime()
        - POLICY.maxCapMs,
      ) < 25,
      'the separate immutable ceiling is 45 minutes',
    );

    const lease = await claimAttempt(client, db, {
      attemptId,
      workerInstanceId: 'writer-worker',
    });
    assert.ok(lease);
    assert.equal(await startAttemptOperation(client, db, {
      attemptId,
      leaseOwner: 'writer-worker',
      attemptFence: lease!.attemptFence,
    }), true);

    const report = (fingerprint: string, fence = lease!.attemptFence) => (
      recordAttemptProgressAndExtend(client, db, {
        attemptId,
        leaseOwner: 'writer-worker',
        attemptFence: fence,
        leaseTtlMs: 30_000,
        milestone: { kind: 'writer_snapshot_saved', fingerprint },
      })
    );

    const early = await report(hash('0'));
    assert.equal(early.accepted, false);
    assert.equal(early.reason, 'too_early', 'progress cannot bank time early');

    // Represent the captured canary state: real durable work lands inside the
    // final eight minutes of the current earned window.
    const nearCutoff = Date.now() + 15_000;
    await attempts.updateOne({ _id: attemptId }, {
      $set: {
        businessOperationCutoffAt: new Date(nearCutoff),
        workDeadlineAt: new Date(nearCutoff + 2_000),
        hardDeadlineAt: new Date(nearCutoff + 4_000),
        leaseExpiresAt: new Date(nearCutoff + 4_000),
      },
    });
    const before = await attempts.findOne({ _id: attemptId });
    const first = await report(hash('a'));
    assert.equal(first.accepted, true);
    assert.equal(first.extensionCount, 1);
    const after = await attempts.findOne({ _id: attemptId });
    assert.equal(
      after!.businessOperationCutoffAt.getTime() - before!.businessOperationCutoffAt.getTime(),
      POLICY.extensionMs,
    );
    assert.equal(after!.workDeadlineAt.getTime() - before!.workDeadlineAt.getTime(), POLICY.extensionMs);
    assert.equal(after!.hardDeadlineAt.getTime() - before!.hardDeadlineAt.getTime(), POLICY.extensionMs);
    assert.ok(
      after!.leaseExpiresAt!.getTime() > before!.hardDeadlineAt.getTime(),
      'an old hard-cap-clipped lease survives long enough for the heartbeat to renew it',
    );
    assert.equal(after!.absoluteHardDeadlineAt!.getTime(), before!.absoluteHardDeadlineAt!.getTime());
    assert.equal(after!.progressFingerprints?.length, 1);
    assert.deepEqual(
      (await tasks.findOne({ _id: taskId }))?.durableProgressFingerprints,
      [hash('a')],
      'the receipt survives a retry of the same durable task',
    );

    const duplicate = await report(hash('a'));
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.reason, 'duplicate');
    assert.equal(
      duplicate.businessOperationCutoffAt,
      first.businessOperationCutoffAt,
      'an idempotent replay returns the already-earned authoritative cutoff',
    );
    assert.equal((await attempts.findOne({ _id: attemptId }))?.progressExtensionCount, 1);

    const stale = await report(hash('b'), lease!.attemptFence - 1);
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, 'stale_authority_or_cutoff');

    await tasks.updateOne({ _id: taskId }, { $set: { controlState: 'STOP_REQUESTED' } });
    const controlled = await report(hash('b'));
    assert.equal(controlled.accepted, false, 'task control wins against progress');
    assert.equal(controlled.reason, 'stale_authority_or_cutoff');
    await tasks.updateOne({ _id: taskId }, { $set: { controlState: 'NONE' } });

    await jobs.updateOne({ _id: accepted.jobId }, {
      $set: { controlState: 'PAUSE_REQUESTED', pauseGeneration: 1 },
    });
    await attempts.updateOne({ _id: attemptId }, {
      $set: { finishCurrentPauseGeneration: 1 },
    });
    const paused = await report(hash('b'));
    assert.equal(paused.accepted, false);
    assert.equal(paused.reason, 'control_frozen', 'finish-current pause freezes time without aborting authority');
    await jobs.updateOne({ _id: accepted.jobId }, {
      $set: { controlState: 'NONE', pauseGeneration: 0 },
    });
    await attempts.updateOne({ _id: attemptId }, {
      $set: { finishCurrentPauseGeneration: null },
    });

    const second = await report(hash('b'));
    assert.equal(second.accepted, true, 'a new content hash inside the lead window earns once');
    assert.equal(second.extensionCount, 2);

    await attempts.updateOne({ _id: attemptId }, { $set: { progressExtensionCount: 6 } });
    const limited = await report(hash('c'));
    assert.equal(limited.accepted, false);
    assert.equal(limited.reason, 'extension_limit');

    const current = await attempts.findOne({ _id: attemptId });
    await attempts.updateOne({ _id: attemptId }, {
      $set: {
        progressExtensionCount: 2,
        hardDeadlineAt: current!.absoluteHardDeadlineAt,
      },
    });
    const capped = await report(hash('c'));
    assert.equal(capped.accepted, false);
    assert.equal(capped.reason, 'absolute_cap');

    await attempts.updateOne({ _id: attemptId }, {
      $set: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    const expiredDuplicate = await report(hash('a'));
    assert.equal(expiredDuplicate.accepted, false);
    assert.equal(
      expiredDuplicate.reason,
      'stale_authority_or_cutoff',
      'a replay must not disguise an expired lease as a harmless duplicate',
    );

    await attempts.updateOne({ _id: attemptId }, {
      $set: {
        leaseExpiresAt: new Date(Date.now() + 30_000),
        hardDeadlineAt: new Date(Date.now() + 60_000),
        workDeadlineAt: new Date(Date.now() + 58_000),
        businessOperationCutoffAt: new Date(Date.now() - 1),
      },
    });
    const expired = await report(hash('d'));
    assert.equal(expired.accepted, false, 'an expired business cutoff cannot be resurrected');
    assert.equal(expired.reason, 'stale_authority_or_cutoff');

    console.log('  ✓ durable progress policy, CAS, dedupe, authority and cutoff');
  } finally {
    await db.dropDatabase().catch(() => undefined);
    await client.close();
  }

  console.log('✅ e2e:orchestration-progress-lease — all assertions passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(`e2e failed: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(1);
});
