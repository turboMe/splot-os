#!/usr/bin/env tsx
/**
 * check:curator-lifecycle — Etap 6 (IDEALSYSTEMMASTERPLAN §5).
 *
 * Deterministic assertions on skill_stats counters + the weekly curator,
 * using an injected `now` so time-based transitions are exact:
 *   - recordSkillView / recordSkillUse increment counters + successRate
 *   - fresh skill stays active
 *   - idle ≥30d → stale
 *   - idle ≥90d → archived
 *   - low success rate (≥4 uses, <0.5) → repair task queued
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import {
  recordSkillView,
  recordSkillUse,
  getSkillStat,
  runCurator,
  listOpenRepairTasks,
  STATS_COLLECTION,
  REPAIR_COLLECTION,
} from '../services/skill-stats.js';

const TAG = `curator-check-${Date.now()}`;
const FRESH = `${TAG}-fresh`;
const STALE = `${TAG}-stale`;
const ARCH = `${TAG}-archived`;
const LOWSUCC = `${TAG}-lowsucc`;
let failures = 0;

function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

async function seedStat(name: string, patch: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  await db.collection(STATS_COLLECTION).updateOne(
    { name },
    { $set: { name, views: 0, uses: 0, successes: 0, successRate: null, lifecycle: 'active', createdAt: new Date(), updatedAt: new Date(), ...patch } },
    { upsert: true },
  );
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection(STATS_COLLECTION).deleteMany({ name: { $regex: TAG } }).catch(() => undefined);
  await db.collection(REPAIR_COLLECTION).deleteMany({ skillName: { $regex: TAG } }).catch(() => undefined);
}

async function main(): Promise<void> {
  console.log('check:curator-lifecycle');
  const now = new Date('2026-07-20T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  await ok('recordSkillView / recordSkillUse increment counters + successRate', async () => {
    await recordSkillView(`${TAG}-counters`);
    await recordSkillUse(`${TAG}-counters`, true);
    await recordSkillUse(`${TAG}-counters`, false);
    const stat = await getSkillStat(`${TAG}-counters`);
    assert.equal(stat?.views, 1);
    assert.equal(stat?.uses, 2);
    assert.equal(stat?.successes, 1);
    assert.equal(stat?.successRate, 0.5);
  });

  await ok('fresh skill stays active; ≥30d idle → stale; ≥90d idle → archived', async () => {
    await seedStat(FRESH, { lastUsedAt: daysAgo(3), createdAt: daysAgo(3) });
    await seedStat(STALE, { lastUsedAt: daysAgo(45), createdAt: daysAgo(60) });
    await seedStat(ARCH, { lastUsedAt: daysAgo(120), createdAt: daysAgo(200) });

    const report = await runCurator({ now });
    assert.ok(!report.markedStale.includes(FRESH) && !report.archived.includes(FRESH), 'fresh stays active');
    assert.ok(report.markedStale.includes(STALE), 'idle 45d → stale');
    assert.ok(report.archived.includes(ARCH), 'idle 120d → archived');

    assert.equal((await getSkillStat(FRESH))?.lifecycle, 'active');
    assert.equal((await getSkillStat(STALE))?.lifecycle, 'stale');
    assert.equal((await getSkillStat(ARCH))?.lifecycle, 'archived');
  });

  await ok('low success rate (≥4 uses, <0.5) → repair task queued', async () => {
    await seedStat(LOWSUCC, { uses: 6, successes: 2, successRate: 0.33, lastUsedAt: daysAgo(2), createdAt: daysAgo(10) });
    const report = await runCurator({ now });
    assert.ok(report.repairQueued.includes(LOWSUCC), 'low-success skill queued for repair');
    const repairs = await listOpenRepairTasks();
    assert.ok(repairs.some((r) => r.skillName === LOWSUCC), 'repair task listed as open');
  });

  await ok('archived skills are not re-processed', async () => {
    const report = await runCurator({ now });
    assert.ok(!report.archived.includes(ARCH), 'already-archived skill not re-archived');
  });

  await cleanup();

  if (failures > 0) {
    console.error(`\n❌ check:curator-lifecycle — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:curator-lifecycle — all assertions passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ check:curator-lifecycle crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
