#!/usr/bin/env tsx
/**
 * check:ledger-lifecycle — Etap 1 (IDEALSYSTEMMASTERPLAN).
 *
 * Deterministic, LLM-free assertions on the Task Ledger state machine against
 * real Mongo:
 *   - openLane / laneNo increments / unique (source, sourceId)
 *   - legal transitions land, illegal transitions throw
 *   - fast-failure path (queued → done via implicit start)
 *   - heartbeat + stale reconciliation closes overdue lanes
 *   - digest: counts, attention section, finished-once semantics (digestedAt)
 *   - control: priority, pause/resume on queued, cancel flags
 *   - kill switch set/read/clear
 *
 * All test lanes use source 'manual' with a unique test prefix and are removed
 * afterwards.
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import {
  openLane,
  getLane,
  findLaneBySource,
  transitionLane,
  touchLane,
  setLanePriority,
  requestLaneFlag,
  reconcileStaleLanes,
  getLedgerDigest,
  setKillSwitch,
  isKillSwitchActive,
  ledgerTransitionBySource,
  ledgerRecordEphemeral,
} from '../services/task-ledger.js';

const PREFIX = `ledger-check-${Date.now()}`;
let failures = 0;

function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failures += 1;
      console.error(`  ✗ ${name}: ${(err as Error).message}`);
    });
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection('task_ledger').deleteMany({ sourceId: { $regex: `^${PREFIX}` } });
  await setKillSwitch(false);
}

async function main(): Promise<void> {
  process.env.FEATURE_LEDGER_V1 = 'true';
  console.log('check:ledger-lifecycle');

  // ── 1. Open + identity ─────────────────────────────────────────────────────
  const laneA = await openLane({
    source: 'manual', sourceId: `${PREFIX}-a`, goal: 'test lane A', agentId: 'testAgent',
  });
  const laneB = await openLane({
    source: 'manual', sourceId: `${PREFIX}-b`, goal: 'test lane B', state: 'running',
  });

  await ok('laneNo increments', () => {
    assert.ok(laneB.laneNo > laneA.laneNo, `laneNo ${laneB.laneNo} should be > ${laneA.laneNo}`);
  });

  await ok('openLane defaults to queued, explicit running honored', () => {
    assert.equal(laneA.state, 'queued');
    assert.equal(laneB.state, 'running');
    assert.ok(laneB.startedAt, 'running lane has startedAt');
  });

  await ok('unique (source, sourceId) enforced', async () => {
    await assert.rejects(
      openLane({ source: 'manual', sourceId: `${PREFIX}-a`, goal: 'dup' }),
      /duplicate key/i,
    );
  });

  await ok('findLaneBySource + getLane by laneNo and laneId', async () => {
    const bySource = await findLaneBySource('manual', `${PREFIX}-a`);
    assert.equal(bySource?.laneId, laneA.laneId);
    const byNo = await getLane(laneA.laneNo);
    assert.equal(byNo?.laneId, laneA.laneId);
    const byId = await getLane(laneA.laneId);
    assert.equal(byId?.laneNo, laneA.laneNo);
  });

  // ── 2. Transitions ─────────────────────────────────────────────────────────
  await ok('queued → running → awaiting_approval → running → done', async () => {
    await transitionLane(laneA.laneId, 'running');
    await transitionLane(laneA.laneId, 'awaiting_approval', { milestone: 'needs approval' });
    await transitionLane(laneA.laneId, 'running', { milestone: 'approved' });
    const done = await transitionLane(laneA.laneId, 'done', {
      artifacts: [{ id: 'artifact-1', type: 'test' }],
    });
    assert.equal(done.state, 'done');
    const fresh = await getLane(laneA.laneId);
    assert.equal(fresh?.state, 'done');
    assert.ok(fresh?.completedAt, 'terminal lane has completedAt');
    assert.ok(fresh!.milestones.length >= 4, 'milestones recorded');
    assert.equal(fresh?.artifacts[0]?.id, 'artifact-1');
  });

  await ok('illegal transition throws (done → running)', async () => {
    await assert.rejects(transitionLane(laneA.laneId, 'running'), /Illegal lane transition/);
  });

  await ok('fail-safe adapter: queued → done via implicit start', async () => {
    const laneC = await openLane({ source: 'manual', sourceId: `${PREFIX}-c`, goal: 'fast fail path' });
    await ledgerTransitionBySource('manual', `${PREFIX}-c`, 'done');
    const fresh = await getLane(laneC.laneId);
    assert.equal(fresh?.state, 'done');
  });

  await ok('fail-safe adapter: no-op on terminal lane and unknown source', async () => {
    await ledgerTransitionBySource('manual', `${PREFIX}-c`, 'failed'); // already done — must not throw
    await ledgerTransitionBySource('manual', `${PREFIX}-does-not-exist`, 'done');
    const fresh = await findLaneBySource('manual', `${PREFIX}-c`);
    assert.equal(fresh?.state, 'done', 'terminal state unchanged');
  });

  await ok('ephemeral lane records open+close in one go', async () => {
    await ledgerRecordEphemeral({
      source: 'manual', sourceId: `${PREFIX}-eph`, goal: 'cron-style trigger', outcome: 'failed', error: 'HTTP 500',
    });
    const fresh = await findLaneBySource('manual', `${PREFIX}-eph`);
    assert.equal(fresh?.state, 'failed');
    assert.equal(fresh?.error, 'HTTP 500');
  });

  // ── 3. Heartbeat + stale reconciliation ────────────────────────────────────
  await ok('touchLane updates heartbeat; stale lane reconciles to failed', async () => {
    const laneD = await openLane({
      source: 'manual', sourceId: `${PREFIX}-d`, goal: 'stale candidate',
      state: 'running', staleAfterMs: 50,
    });
    await touchLane(laneD.laneId);
    const touched = await getLane(laneD.laneId);
    assert.ok(touched!.heartbeatAt >= laneD.heartbeatAt);

    await new Promise((r) => setTimeout(r, 120));
    const reconciled = await reconcileStaleLanes();
    assert.ok(reconciled >= 1, `expected ≥1 reconciled, got ${reconciled}`);
    const fresh = await getLane(laneD.laneId);
    assert.equal(fresh?.state, 'failed');
    assert.match(fresh?.error ?? '', /stale/);
  });

  // ── 4. Digest ──────────────────────────────────────────────────────────────
  await ok('digest counts + finished-once semantics', async () => {
    const laneE = await openLane({
      source: 'manual', sourceId: `${PREFIX}-e`, goal: 'digest running', state: 'running',
    });
    const laneF = await openLane({
      source: 'manual', sourceId: `${PREFIX}-f`, goal: 'digest blocked', state: 'running',
    });
    await transitionLane(laneF.laneId, 'awaiting_approval');

    const digest1 = await getLedgerDigest();
    assert.ok(digest1.enabled);
    assert.ok(digest1.counts.running >= 1, 'at least one running');
    assert.ok(digest1.counts.awaiting_approval >= 1, 'at least one awaiting approval');
    assert.match(digest1.text, /NEEDS ATTENTION/);
    assert.match(digest1.text, new RegExp(`#${laneF.laneNo} `));

    // finish laneE → first digest reports it, second does not
    await transitionLane(laneE.laneId, 'done');
    const digest2 = await getLedgerDigest();
    assert.ok(digest2.recentlyFinished.some((l) => l.laneId === laneE.laneId), 'finished lane reported once');
    const digest3 = await getLedgerDigest();
    assert.ok(!digest3.recentlyFinished.some((l) => l.laneId === laneE.laneId), 'finished lane not re-reported');

    await transitionLane(laneF.laneId, 'cancelled');
  });

  // ── 5. Controls ────────────────────────────────────────────────────────────
  await ok('priority + pause/resume flags', async () => {
    const laneG = await openLane({ source: 'manual', sourceId: `${PREFIX}-g`, goal: 'controls' });
    await setLanePriority(laneG.laneId, 7);
    await requestLaneFlag(laneG.laneId, 'pauseRequested');
    let fresh = await getLane(laneG.laneId);
    assert.equal(fresh?.priority, 7);
    assert.equal(fresh?.pauseRequested, true);
    await transitionLane(laneG.laneId, 'cancelled');
    fresh = await getLane(laneG.laneId);
    assert.equal(fresh?.state, 'cancelled');
  });

  await ok('kill switch set/read/clear', async () => {
    await setKillSwitch(true);
    assert.equal(await isKillSwitchActive(), true);
    const digest = await getLedgerDigest();
    assert.ok(digest.killSwitch, 'digest reflects kill switch');
    assert.match(digest.text, /KILL SWITCH/);
    await setKillSwitch(false);
    assert.equal(await isKillSwitchActive(), false);
  });

  // ── 6. Flag off → digest disabled ──────────────────────────────────────────
  await ok('FEATURE_LEDGER_V1=false disables digest', async () => {
    process.env.FEATURE_LEDGER_V1 = 'false';
    const digest = await getLedgerDigest();
    assert.equal(digest.enabled, false);
    process.env.FEATURE_LEDGER_V1 = 'true';
  });

  await cleanup();

  if (failures > 0) {
    console.error(`\n❌ check:ledger-lifecycle — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:ledger-lifecycle — all assertions passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ check:ledger-lifecycle crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
