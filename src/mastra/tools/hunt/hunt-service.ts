/**
 * HuntService — state-machine persistence for the lead-hunting pipeline.
 * Mirrors ContentService / chef-service: persists hunt runs + status transitions to the
 * `hunt_runs` Mongo collection via the shared getDb() singleton, so a run is resumable and
 * auditable across turns and context compaction.
 *
 * Scope (Phase 2): runs + status transitions only. The Hunt Report (external-memory document)
 * lives on disk via hunt-document-tools.ts; CRM is the persistent backing store for lead records.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { getDb } from '../../lib/mongo.js';

// ─── Pipeline state machine ───────────────────────────────────────
// Canonical run statuses driving the Hunt pipeline (see prompts/hunt/pipeline.md). Each phase
// transition is recorded so the run is resumable and auditable. `checkpoint_review` is the
// human-in-the-loop gate before anything ships.
export const HUNT_PIPELINE_STATUSES = [
  'intake',
  'discover',
  'score',
  'enrich',
  'extract_email',
  'draft',
  'assemble',
  'checkpoint_review',
  'ship',
  'done',
] as const;
export type HuntPipelineStatus = typeof HUNT_PIPELINE_STATUSES[number];

// ─── Types ────────────────────────────────────────────────────────

export interface HuntRun {
  id: string;
  name: string;
  /** Free-text brief: the original free-form intent for this hunt. */
  brief: string;
  /** What we are hunting. Phase 1–2: 'supplier'. 'restaurant' arrives in Phase 3. */
  targetKind: 'supplier' | 'restaurant';
  /** Target region for scoring, e.g. "Dolnośląskie". */
  region?: string;
  /** Market locale (Market Pack). Default 'pl'. */
  market: string;
  /** Email/output language. Default the market's language. */
  outputLanguage: string;
  /** How many qualified, drafted leads to deliver. */
  count?: number;
  /** Whether the active market pack is degraded (best-effort) — surfaced in the Hunt Report. */
  marketDegraded?: boolean;
  status: HuntPipelineStatus;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

// ─── Service ──────────────────────────────────────────────────────

export class HuntService {
  private db: Db | null = null;
  private static indexesEnsured = false;

  private async getDb(): Promise<Db> {
    if (!this.db) {
      this.db = await getDb();
      if (!HuntService.indexesEnsured) {
        await this.ensureIndexes(this.db).catch((err) =>
          console.warn('[HuntService] Index creation skipped:', err.message),
        );
        HuntService.indexesEnsured = true;
      }
    }
    return this.db;
  }

  private async ensureIndexes(db: Db): Promise<void> {
    await Promise.all([
      db.collection('hunt_runs').createIndex({ id: 1 }, { unique: true }),
      db.collection('hunt_runs').createIndex({ status: 1 }),
      db.collection('hunt_runs').createIndex({ updatedAt: -1 }),
    ]);
  }

  async createRun(params: {
    name: string;
    brief: string;
    targetKind?: 'supplier' | 'restaurant';
    region?: string;
    market?: string;
    outputLanguage?: string;
    count?: number;
    marketDegraded?: boolean;
    createdBy?: string;
  }): Promise<HuntRun> {
    const db = await this.getDb();
    const now = new Date();
    const market = (params.market ?? 'pl').toLowerCase();

    const run: HuntRun = {
      id: randomUUID(),
      name: params.name,
      brief: params.brief,
      targetKind: params.targetKind ?? 'supplier',
      region: params.region,
      market,
      outputLanguage: (params.outputLanguage ?? market).toLowerCase(),
      count: params.count,
      marketDegraded: params.marketDegraded ?? false,
      status: 'intake',
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    };

    await db.collection('hunt_runs').insertOne(run);
    return run;
  }

  async getRun(runId: string): Promise<HuntRun | null> {
    const db = await this.getDb();
    return db.collection<HuntRun>('hunt_runs').findOne({ id: runId });
  }

  async listRuns(filter?: { status?: HuntPipelineStatus }, limit = 10): Promise<HuntRun[]> {
    const db = await this.getDb();
    const query: any = {};
    if (filter?.status) query.status = filter.status;
    return db
      .collection<HuntRun>('hunt_runs')
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async updateRunStatus(runId: string, status: HuntPipelineStatus): Promise<void> {
    const db = await this.getDb();
    await db.collection('hunt_runs').updateOne(
      { id: runId },
      { $set: { status, updatedAt: new Date() } },
    );
  }
}
