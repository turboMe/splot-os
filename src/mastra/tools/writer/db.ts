/**
 * Writer DB helper — delegates to the shared Mongo singleton.
 * Kept separate so writer-service.ts mirrors the existing domain service layout.
 */
import type { Db } from 'mongodb';
import { getDb as getSharedDb } from '../../lib/mongo';

export async function getDb(): Promise<Db> {
  return getSharedDb();
}

export async function ensureWriterIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('writer_projects').createIndex({ id: 1 }, { unique: true }),
    db.collection('writer_projects').createIndex({ status: 1 }),
    db.collection('writer_projects').createIndex({ type: 1 }),
    db.collection('writer_projects').createIndex({ updatedAt: -1 }),

    db.collection('writer_sections').createIndex({ id: 1 }, { unique: true }),
    db.collection('writer_sections').createIndex({ projectId: 1, order: 1 }),
    db.collection('writer_sections').createIndex({ projectId: 1, kind: 1 }),

    db.collection('writer_manuscripts').createIndex({ id: 1 }, { unique: true }),
    db.collection('writer_manuscripts').createIndex({ projectId: 1, version: -1 }),
    db.collection('writer_manuscripts').createIndex(
      { projectId: 1, version: 1 },
      {
        name: 'writer_project_version_unique',
        unique: true,
      },
    ),
    db.collection('writer_manuscripts').createIndex({ projectId: 1, isCurrent: 1 }),

    db.collection('writer_continuity').createIndex({ projectId: 1 }, { unique: true }),

    db.collection('writer_sources').createIndex({ id: 1 }, { unique: true }),
    db.collection('writer_sources').createIndex({ projectId: 1 }),
    db.collection('writer_sources').createIndex({ url: 1 }),
    db.collection('writer_sources').createIndex({ reliability: 1 }),

    db.collection('writer_claims').createIndex({ id: 1 }, { unique: true }),
    db.collection('writer_claims').createIndex({ projectId: 1 }),
    db.collection('writer_claims').createIndex({ status: 1 }),
    db.collection('writer_claims').createIndex({ sourceIds: 1 }),

    db.collection('writer_audits').createIndex({ id: 1 }, { unique: true }),
    db.collection('writer_audits').createIndex({ projectId: 1, createdAt: -1 }),
    db.collection('writer_audits').createIndex({ projectId: 1, auditRevision: -1 }),
    db.collection('writer_audits').createIndex({ manuscriptId: 1 }),
    db.collection('writer_audits').createIndex({ workerRunId: 1 }, { sparse: true }),

    db.collection('worker_run_receipts').createIndex({ workerRunId: 1 }, { unique: true }),
    db.collection('worker_run_receipts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('worker_review_requests').createIndex({ requestId: 1 }, { unique: true }),
    db.collection('worker_review_requests').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    db.collection('writer_notes').createIndex({ type: 1, topic: 1 }),
    db.collection('writer_notes').createIndex({ projectId: 1 }),
    db.collection('writer_notes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true }),
  ]);
}
