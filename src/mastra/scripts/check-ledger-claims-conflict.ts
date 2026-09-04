#!/usr/bin/env tsx
/**
 * check:ledger-claims-conflict — Etap 5 (IDEALSYSTEMMASTERPLAN §3.3).
 *
 * Deterministic, LLM-free assertions on the claims scheduler against real Mongo:
 *   - claimsOverlap: exact, namespace isolation, glob overlap
 *   - two lanes on the SAME claim → first acquires, second conflicts (queues)
 *   - DISJOINT claims → both acquire (parallel)
 *   - release the holder → the waiter can then acquire (promotion)
 *   - waitAndAcquireClaims: blocks while held, succeeds after release
 *   - terminal lane transition releases its leases (task-ledger wiring)
 *   - glob claim (repo:src/mastra/**) conflicts with a narrower path
 *   - FEATURE_LEDGER_SCHEDULER=false disables gating
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import { openLane, transitionLane } from '../services/task-ledger.js';
import {
  acquireClaims,
  releaseClaims,
  findClaimConflicts,
  waitAndAcquireClaims,
  claimsOverlap,
  listActiveClaims,
} from '../services/task-ledger-scheduler.js';

const PREFIX = `claims-check-${Date.now()}`;
let failures = 0;

function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection('task_ledger').deleteMany({ sourceId: { $regex: `^${PREFIX}` } });
  await db.collection('claim_locks').deleteMany({ laneId: { $regex: '^lane-' } }).catch(() => undefined);
  // Only remove locks created by our test lanes — scope by claim prefix.
  await db.collection('claim_locks').deleteMany({ claim: { $regex: `${PREFIX}` } }).catch(() => undefined);
}

async function main(): Promise<void> {
  process.env.FEATURE_LEDGER_V1 = 'true';
  process.env.FEATURE_LEDGER_SCHEDULER = 'true';
  console.log('check:ledger-claims-conflict');

  // ── claimsOverlap unit ──────────────────────────────────────────────────
  await ok('claimsOverlap: exact / namespace isolation / glob', () => {
    assert.equal(claimsOverlap('n8n:workflow:X', 'n8n:workflow:X'), true);
    assert.equal(claimsOverlap('n8n:workflow:X', 'n8n:workflow:Y'), false);
    assert.equal(claimsOverlap('crm:write', 'gmail:send'), false, 'different namespaces never conflict');
    assert.equal(claimsOverlap('repo:src/mastra/**', 'repo:src/mastra/agents/x.ts'), true, 'glob covers narrower path');
    assert.equal(claimsOverlap('repo:src/mastra/**', 'repo:src/other/y.ts'), false);
    assert.equal(claimsOverlap('gpu:local', 'gpu:local'), true);
  });

  // ── Two lanes, same claim → serialize ───────────────────────────────────
  const claimW = `n8n:workflow:${PREFIX}-wfA`;
  const laneA = await openLane({ source: 'manual', sourceId: `${PREFIX}-a`, goal: 'lane A', state: 'running', claims: [claimW] });
  const laneB = await openLane({ source: 'manual', sourceId: `${PREFIX}-b`, goal: 'lane B', state: 'queued', claims: [claimW] });

  await ok('first lane acquires the claim', async () => {
    const r = await acquireClaims({ laneId: laneA.laneId, laneNo: laneA.laneNo, claims: [claimW] });
    assert.equal(r.acquired, true);
    const active = await listActiveClaims();
    assert.ok(active.some((c) => c.claim === claimW && c.laneNo === laneA.laneNo), 'lease held by lane A');
  });

  await ok('second lane on same claim conflicts (would queue)', async () => {
    const conflicts = await findClaimConflicts([claimW], laneB.laneId);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.laneNo, laneA.laneNo);
    const r = await acquireClaims({ laneId: laneB.laneId, laneNo: laneB.laneNo, claims: [claimW] });
    assert.equal(r.acquired, false);
    assert.equal((r as { conflictLaneNo: number }).conflictLaneNo, laneA.laneNo);
  });

  // ── Disjoint claims → parallel ──────────────────────────────────────────
  await ok('disjoint claims acquire in parallel', async () => {
    const laneC = await openLane({ source: 'manual', sourceId: `${PREFIX}-c`, goal: 'lane C', state: 'running', claims: [`crm:write`] });
    const laneD = await openLane({ source: 'manual', sourceId: `${PREFIX}-d`, goal: 'lane D', state: 'running', claims: [`gmail:send`] });
    const rc = await acquireClaims({ laneId: laneC.laneId, laneNo: laneC.laneNo, claims: ['crm:write'] });
    const rd = await acquireClaims({ laneId: laneD.laneId, laneNo: laneD.laneNo, claims: ['gmail:send'] });
    assert.equal(rc.acquired, true);
    assert.equal(rd.acquired, true, 'disjoint claim acquires despite another lane holding a different claim');
    await releaseClaims(laneC.laneId);
    await releaseClaims(laneD.laneId);
  });

  // ── Release → promotion ─────────────────────────────────────────────────
  await ok('releasing the holder lets the waiter acquire', async () => {
    await releaseClaims(laneA.laneId);
    const r = await acquireClaims({ laneId: laneB.laneId, laneNo: laneB.laneNo, claims: [claimW] });
    assert.equal(r.acquired, true, 'lane B acquires after lane A releases');
    await releaseClaims(laneB.laneId);
  });

  // ── waitAndAcquireClaims blocks then succeeds ───────────────────────────
  await ok('waitAndAcquireClaims waits for release then acquires', async () => {
    const claimX = `n8n:workflow:${PREFIX}-wfB`;
    const holder = await openLane({ source: 'manual', sourceId: `${PREFIX}-hold`, goal: 'holder', state: 'running', claims: [claimX] });
    const waiter = await openLane({ source: 'manual', sourceId: `${PREFIX}-wait`, goal: 'waiter', state: 'queued', claims: [claimX] });
    await acquireClaims({ laneId: holder.laneId, laneNo: holder.laneNo, claims: [claimX] });

    // release the holder after 400ms; the waiter should acquire shortly after.
    setTimeout(() => void releaseClaims(holder.laneId), 400);
    const start = Date.now();
    const res = await waitAndAcquireClaims({ laneId: waiter.laneId, laneNo: waiter.laneNo, claims: [claimX], maxWaitMs: 5_000, pollMs: 100 });
    const waited = Date.now() - start;
    assert.equal(res.acquired, true, 'waiter acquired after holder released');
    assert.ok(waited >= 300, `waiter actually waited (${waited}ms)`);
    await releaseClaims(waiter.laneId);
  });

  // ── Terminal transition releases leases ─────────────────────────────────
  await ok('terminal lane transition releases its leases', async () => {
    const claimY = `n8n:workflow:${PREFIX}-wfC`;
    const lane = await openLane({ source: 'manual', sourceId: `${PREFIX}-term`, goal: 'terminating', state: 'running', claims: [claimY] });
    await acquireClaims({ laneId: lane.laneId, laneNo: lane.laneNo, claims: [claimY] });
    let active = await listActiveClaims();
    assert.ok(active.some((c) => c.claim === claimY), 'lease held before terminal');
    await transitionLane(lane.laneId, 'done');
    await new Promise((r) => setTimeout(r, 100)); // release is fire-and-forget
    active = await listActiveClaims();
    assert.ok(!active.some((c) => c.claim === claimY), 'lease released after terminal');
  });

  // ── Flag off disables gating ────────────────────────────────────────────
  await ok('FEATURE_LEDGER_SCHEDULER=false disables acquisition gating', async () => {
    process.env.FEATURE_LEDGER_SCHEDULER = 'false';
    const claimZ = `n8n:workflow:${PREFIX}-wfD`;
    const l1 = await openLane({ source: 'manual', sourceId: `${PREFIX}-off1`, goal: 'off1', state: 'running', claims: [claimZ] });
    const l2 = await openLane({ source: 'manual', sourceId: `${PREFIX}-off2`, goal: 'off2', state: 'running', claims: [claimZ] });
    const r1 = await acquireClaims({ laneId: l1.laneId, laneNo: l1.laneNo, claims: [claimZ] });
    const r2 = await acquireClaims({ laneId: l2.laneId, laneNo: l2.laneNo, claims: [claimZ] });
    assert.equal(r1.acquired, true);
    assert.equal(r2.acquired, true, 'with scheduler off, both acquire (no gating)');
    process.env.FEATURE_LEDGER_SCHEDULER = 'true';
  });

  await cleanup();

  if (failures > 0) {
    console.error(`\n❌ check:ledger-claims-conflict — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:ledger-claims-conflict — all assertions passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ check:ledger-claims-conflict crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
