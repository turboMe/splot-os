/**
 * Skill Stats + Curator (Etap 6, IDEALSYSTEMMASTERPLAN §5).
 *
 * Mongo `skill_stats` holds richer per-skill counters than the in-file
 * rolling average (registry.reportResult keeps that): views, uses, successes,
 * last_used. The Curator uses them to keep the skill pool healthy:
 *   - not used for 30 days      → mark stale
 *   - stale for 90 days total   → archive (moved out of the searchable pool)
 *   - low success rate          → queue a repair task for the reflector
 *
 * "Archive" moves the file to _skills/archive/ which the registry skips.
 */

import { rename, mkdir } from 'fs/promises';
import { resolve, basename } from 'path';
import { getDb } from '../lib/mongo.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

const STATS_COLLECTION = 'skill_stats';
const REPAIR_COLLECTION = 'skill_repair_tasks';
const ARCHIVE_DIR = resolve(AGENTIC_AGENTS_REPO, 'src', 'mastra', '_skills', 'archive');

const STALE_AFTER_DAYS = 30;
const ARCHIVE_AFTER_DAYS = 90;
const LOW_SUCCESS_THRESHOLD = 0.5;
const MIN_USES_FOR_SUCCESS_JUDGEMENT = 4;

export type SkillStat = {
  name: string;
  views: number;
  uses: number;
  successes: number;
  successRate: number | null;
  lifecycle: 'active' | 'stale' | 'archived';
  createdAt: Date;
  lastUsedAt?: Date;
  lastViewedAt?: Date;
  updatedAt: Date;
};

async function statsCol() {
  const db = await getDb();
  return db.collection<SkillStat>(STATS_COLLECTION);
}

// ── Counters ───────────────────────────────────────────────────────────────────

export async function recordSkillView(name: string): Promise<void> {
  try {
    const col = await statsCol();
    const now = new Date();
    await col.updateOne(
      { name },
      { $inc: { views: 1 }, $set: { lastViewedAt: now, updatedAt: now }, $setOnInsert: { name, uses: 0, successes: 0, successRate: null, lifecycle: 'active', createdAt: now } },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[SkillStats] recordView failed:', (err as Error).message);
  }
}

export async function recordSkillUse(name: string, success: boolean): Promise<void> {
  try {
    const col = await statsCol();
    const now = new Date();
    await col.updateOne(
      { name },
      {
        $inc: { uses: 1, successes: success ? 1 : 0 },
        $set: { lastUsedAt: now, updatedAt: now, lifecycle: 'active' },
        $setOnInsert: { name, views: 0, successRate: null, createdAt: now },
      },
      { upsert: true },
    );
    // Recompute rolling success rate.
    const doc = await col.findOne({ name });
    if (doc && doc.uses > 0) {
      await col.updateOne({ name }, { $set: { successRate: Math.round((doc.successes / doc.uses) * 100) / 100 } });
    }
  } catch (err) {
    console.warn('[SkillStats] recordUse failed:', (err as Error).message);
  }
}

export async function getSkillStat(name: string): Promise<SkillStat | null> {
  const col = await statsCol();
  return col.findOne({ name });
}

// ── Curator ─────────────────────────────────────────────────────────────────

export type CuratorReport = {
  markedStale: string[];
  archived: string[];
  repairQueued: string[];
};

/**
 * Weekly curation pass. Deterministic given `now` (injectable for tests).
 */
export async function runCurator(opts: { now?: Date; skillFilePathResolver?: (name: string) => string | undefined } = {}): Promise<CuratorReport> {
  const now = opts.now ?? new Date();
  const col = await statsCol();
  const report: CuratorReport = { markedStale: [], archived: [], repairQueued: [] };

  const all = await col.find({ lifecycle: { $ne: 'archived' } }).toArray();
  for (const stat of all) {
    const lastActivity = stat.lastUsedAt ?? stat.createdAt;
    const ageDays = (now.getTime() - lastActivity.getTime()) / 86_400_000;

    // Low success → repair task (independent of staleness).
    if (stat.successRate !== null && stat.uses >= MIN_USES_FOR_SUCCESS_JUDGEMENT && stat.successRate < LOW_SUCCESS_THRESHOLD) {
      await queueRepairTask(stat.name, `low success rate ${stat.successRate} over ${stat.uses} uses`);
      report.repairQueued.push(stat.name);
    }

    if (ageDays >= ARCHIVE_AFTER_DAYS) {
      await col.updateOne({ name: stat.name }, { $set: { lifecycle: 'archived', updatedAt: now } });
      const filePath = opts.skillFilePathResolver?.(stat.name);
      if (filePath) await archiveSkillFile(filePath).catch(() => undefined);
      report.archived.push(stat.name);
    } else if (ageDays >= STALE_AFTER_DAYS && stat.lifecycle !== 'stale') {
      await col.updateOne({ name: stat.name }, { $set: { lifecycle: 'stale', updatedAt: now } });
      report.markedStale.push(stat.name);
    }
  }
  return report;
}

async function queueRepairTask(skillName: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.collection(REPAIR_COLLECTION).updateOne(
    { skillName, status: 'open' },
    { $set: { skillName, reason, status: 'open', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}

export async function listOpenRepairTasks(): Promise<Array<{ skillName: string; reason: string }>> {
  const db = await getDb();
  const docs = await db.collection(REPAIR_COLLECTION).find({ status: 'open' }).toArray();
  return docs.map((d) => ({ skillName: d.skillName as string, reason: d.reason as string }));
}

async function archiveSkillFile(filePath: string): Promise<void> {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await rename(filePath, resolve(ARCHIVE_DIR, basename(filePath)));
}

export { STATS_COLLECTION, REPAIR_COLLECTION, ARCHIVE_DIR, STALE_AFTER_DAYS, ARCHIVE_AFTER_DAYS };
