#!/usr/bin/env tsx
/**
 * e2e:ledger-three-lanes — Etap 1 (IDEALSYSTEMMASTERPLAN).
 *
 * Deterministic, LLM-free end-to-end: three REAL background lanes run in
 * parallel through the actual lifecycle writer (background-task-manager
 * spawns real processes), while the ledger digest is read "mid-conversation"
 * — exactly what meta's turn protocol does.
 *
 * Asserts:
 *   1. 3 lanes appear as running in one digest while work is in flight
 *      (parallel lanes visible from ONE cheap query — no agent interruption);
 *   2. digest reads stay fast (<1.5s) while lanes run — "chat stays fluid";
 *   3. after completion: 2 done + 1 failed with the exit-code error preserved;
 *   4. checkPendingUpdates tool surfaces laneDigest (meta turn integration);
 *   5. finished lanes are reported exactly once (digestedAt semantics).
 *
 * Scope note: async-delegation lanes are covered at the adapter level by
 * check:ledger-lifecycle; a full 3×LLM async-delegation run is a live test,
 * not CI (cost) — the writer→ledger path exercised here is identical.
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import { startBackgroundTask } from '../services/background-task-manager.js';
import { findLaneBySource, getLedgerDigest } from '../services/task-ledger.js';
import { checkPendingUpdatesTool } from '../tools/system/check-pending-updates.js';

const RUN_TAG = `e2e-three-lanes-${Date.now()}`;

async function cleanup(taskIds: string[]): Promise<void> {
  const db = await getDb();
  await db.collection('task_ledger').deleteMany({ sourceId: { $in: taskIds } });
  await db.collection('background_tasks').deleteMany({ taskId: { $in: taskIds } });
}

async function main(): Promise<void> {
  process.env.FEATURE_LEDGER_V1 = 'true';
  process.env.FEATURE_BACKGROUND_TASKS = 'true';
  console.log('e2e:ledger-three-lanes');

  // ── Start 3 real background lanes (2 succeed, 1 fails) ────────────────────
  const t0 = Date.now();
  const [taskA, taskB, taskC] = await Promise.all([
    startBackgroundTask({ command: `sleep 2 && echo "${RUN_TAG}-A done"`, cwd: process.cwd(), agentId: 'e2eAgentA' }),
    startBackgroundTask({ command: `sleep 3 && echo "${RUN_TAG}-B done"`, cwd: process.cwd(), agentId: 'e2eAgentB' }),
    startBackgroundTask({ command: `sleep 2 && echo "${RUN_TAG}-C failing" && exit 3`, cwd: process.cwd(), agentId: 'e2eAgentC' }),
  ]);
  const taskIds = [taskA.taskId, taskB.taskId, taskC.taskId];
  console.log(`  started 3 background tasks in ${Date.now() - t0}ms`);

  try {
    // Give the fire-and-forget ledger writes a moment to land.
    await new Promise((r) => setTimeout(r, 500));

    // ── 1+2. Mid-flight digest: all 3 running, read is fast ─────────────────
    const dt0 = Date.now();
    const midFlight = await getLedgerDigest({ markDigested: false });
    const digestMs = Date.now() - dt0;

    const ourActive = midFlight.active.filter((l) => taskIds.includes(l.sourceId));
    assert.equal(ourActive.length, 3, `expected 3 running lanes, saw ${ourActive.length}`);
    assert.ok(ourActive.every((l) => l.state === 'running'), 'all three lanes are running');
    console.log(`  ✓ 3 parallel lanes visible in one digest (read took ${digestMs}ms)`);
    assert.ok(digestMs < 1500, `digest read should stay cheap while lanes run (took ${digestMs}ms)`);
    console.log('  ✓ digest read stays fast while lanes run');

    // ── Wait for completion (poll the ledger, not the processes) ────────────
    const deadline = Date.now() + 30_000;
    let done = 0;
    while (Date.now() < deadline) {
      const lanes = await Promise.all(taskIds.map((id) => findLaneBySource('background_task', id)));
      done = lanes.filter((l) => l && ['done', 'failed', 'cancelled'].includes(l.state)).length;
      if (done === 3) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(done, 3, `expected 3 terminal lanes within 30s, saw ${done}`);

    // ── 3. Outcomes: 2 done + 1 failed with preserved error ─────────────────
    const laneA = await findLaneBySource('background_task', taskA.taskId);
    const laneB = await findLaneBySource('background_task', taskB.taskId);
    const laneC = await findLaneBySource('background_task', taskC.taskId);
    assert.equal(laneA?.state, 'done', 'lane A done');
    assert.equal(laneB?.state, 'done', 'lane B done');
    assert.equal(laneC?.state, 'failed', 'lane C failed');
    assert.match(laneC?.error ?? '', /exit code 3/, 'exit code preserved in lane error');
    console.log('  ✓ outcomes recorded: 2 done + 1 failed (exit code 3)');

    // ── 4. Meta turn integration: checkPendingUpdates carries laneDigest ────
    const toolResult = await (checkPendingUpdatesTool as unknown as {
      execute: (
        input: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => Promise<{ laneDigest?: string }>;
    }).execute(
      {},
      {
        agent: {
          agentId: 'meta-agent',
          threadId: `ledger-three-lanes-${RUN_TAG}`,
          resourceId: `ledger-three-lanes-owner-${RUN_TAG}`,
        },
        requestContext: {
          get: (key: string) => {
            if (key === 'mastra__threadId') return `ledger-three-lanes-${RUN_TAG}`;
            if (key === 'mastra__resourceId') return `ledger-three-lanes-owner-${RUN_TAG}`;
            return undefined;
          },
        },
      },
    );
    assert.ok(toolResult.laneDigest, 'checkPendingUpdates returns laneDigest');
    assert.match(toolResult.laneDigest!, /FINISHED SINCE LAST CHECK/, 'digest lists finished lanes');
    assert.match(toolResult.laneDigest!, new RegExp(`#${laneC!.laneNo} \\[failed\\]`), 'failed lane visible in digest');
    console.log('  ✓ checkPendingUpdates surfaces laneDigest with finished lanes');

    // ── 5. Finished-once semantics across digest reads ──────────────────────
    const digestAgain = await getLedgerDigest();
    const reReported = digestAgain.recentlyFinished.filter((l) => taskIds.includes(l.sourceId));
    assert.equal(reReported.length, 0, 'finished lanes are not re-reported after consumption');
    console.log('  ✓ finished lanes reported exactly once');

    console.log('\n✅ e2e:ledger-three-lanes — PASSED');
  } finally {
    await cleanup(taskIds).catch(() => undefined);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ e2e:ledger-three-lanes failed:', err);
  process.exit(1);
});
