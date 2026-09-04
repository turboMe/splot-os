/**
 * ContentService — state-machine persistence for the content pipeline.
 * Clone of the chef-service projects layer (chef-service.ts) for the contentAgent.
 * Persists to the `content_projects` Mongo collection via the shared getDb() singleton.
 *
 * Scope (Phase 0): projects + status transitions only. Content Pack (external
 * memory document) and content_notes (learning loop) arrive in later phases.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from 'mongodb'
import { getDb } from '../../lib/mongo'
import { generateEmbedding, cosineSimilarity } from '../../lib/embedder'

// Adapter over lib/embedder (mirrors chef-service): notes embed semantically, and
// on any failure the callers fall back to regex search (try/catch already in place).
const embeddingService = {
  async generate(text: string): Promise<{ embedding: number[] }> {
    return { embedding: await generateEmbedding(text) }
  },
  cosineSimilarity,
}

// ─── Pipeline state machine ───────────────────────────────────────
// Canonical project statuses driving the Content Pack pipeline. Mirrors the
// chef pipeline pattern: each phase transition is recorded so the run is
// resumable and auditable. Checkpoint states are the human-in-the-loop gates.
export const CONTENT_PIPELINE_STATUSES = [
  'intake',
  'research',
  'strategy',
  'checkpoint_strategy',
  'draft',
  'critique',
  'art_direction',
  'assemble',
  'checkpoint_review',
  'ship',
  'done',
] as const
export type ContentPipelineStatus = typeof CONTENT_PIPELINE_STATUSES[number]

// ─── Types ────────────────────────────────────────────────────────

/** Which channels this content project targets. */
export interface ContentTargets {
  linkedin?: boolean
  instagram?: boolean
  tiktok?: boolean
}

export interface ContentProject {
  id: string
  name: string
  /** Free-text brief: theme/angle/occasion for this batch. */
  brief: string
  targets: ContentTargets
  /** ISO week anchor (e.g. "2026-W25") or a plain date the batch is for. */
  weekDate?: string
  status: ContentPipelineStatus
  createdAt: Date
  updatedAt: Date
  createdBy?: string
}

/**
 * ContentNote — the learning loop. Reusable working knowledge the agent
 * accumulates across projects: what hooks/voice landed, platform quirks, human
 * feedback. Clone of ChefNote. Embedded for semantic recall (regex fallback).
 */
export interface ContentNote {
  id: string
  projectId?: string
  type: 'voice' | 'hook' | 'performance' | 'platform' | 'feedback' | 'general'
  topic?: string
  content: string
  embedding?: number[]
  createdAt: Date
}

// ─── Service ──────────────────────────────────────────────────────

export class ContentService {
  private db: Db | null = null
  private static indexesEnsured = false

  private async getDb(): Promise<Db> {
    if (!this.db) {
      this.db = await getDb()
      if (!ContentService.indexesEnsured) {
        await this.ensureIndexes(this.db).catch(err =>
          console.warn('[ContentService] Index creation skipped:', err.message)
        )
        ContentService.indexesEnsured = true
      }
    }
    return this.db
  }

  private async ensureIndexes(db: Db): Promise<void> {
    await Promise.all([
      db.collection('content_projects').createIndex({ id: 1 }, { unique: true }),
      db.collection('content_projects').createIndex({ status: 1 }),
      db.collection('content_projects').createIndex({ updatedAt: -1 }),
      db.collection('content_notes').createIndex({ id: 1 }, { unique: true }),
      db.collection('content_notes').createIndex({ projectId: 1 }),
      db.collection('content_notes').createIndex({ type: 1 }),
      db.collection('content_notes').createIndex({ createdAt: -1 }),
    ])
  }

  async createProject(params: {
    name: string
    brief: string
    targets?: ContentTargets
    weekDate?: string
    createdBy?: string
  }): Promise<ContentProject> {
    const db = await this.getDb()
    const now = new Date()

    const project: ContentProject = {
      id: randomUUID(),
      name: params.name,
      brief: params.brief,
      targets: params.targets ?? { linkedin: true, instagram: true, tiktok: true },
      weekDate: params.weekDate,
      status: 'intake',
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    }

    await db.collection('content_projects').insertOne(project)
    return project
  }

  async getProject(projectId: string): Promise<ContentProject | null> {
    const db = await this.getDb()
    return db.collection<ContentProject>('content_projects').findOne({ id: projectId })
  }

  async listProjects(filter?: { status?: ContentPipelineStatus }, limit = 10): Promise<ContentProject[]> {
    const db = await this.getDb()
    const query: any = {}
    if (filter?.status) query.status = filter.status
    return db.collection<ContentProject>('content_projects')
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray()
  }

  async updateProjectStatus(projectId: string, status: ContentPipelineStatus): Promise<void> {
    const db = await this.getDb()
    await db.collection('content_projects').updateOne(
      { id: projectId },
      { $set: { status, updatedAt: new Date() } }
    )
  }

  // ── Notes (learning loop) ──

  async addNote(params: {
    content: string
    type?: ContentNote['type']
    topic?: string
    projectId?: string
  }): Promise<ContentNote> {
    const db = await this.getDb()

    let embedding: number[] | undefined
    try {
      const textToEmbed = `${params.topic ? params.topic + ': ' : ''}${params.content}`
      const result = await embeddingService.generate(textToEmbed)
      embedding = result.embedding
    } catch {
      // Embedding optional — continue without it
    }

    const note: ContentNote = {
      id: randomUUID(),
      projectId: params.projectId,
      type: params.type ?? 'general',
      topic: params.topic,
      content: params.content,
      embedding,
      createdAt: new Date(),
    }
    await db.collection('content_notes').insertOne(note)
    return note
  }

  async searchNotes(query: string, projectId?: string, limit = 5): Promise<ContentNote[]> {
    const db = await this.getDb()

    // Try vector search first, fallback to regex.
    try {
      const result = await embeddingService.generate(query)
      const queryEmbedding = result.embedding

      const filter: any = { embedding: { $exists: true } }
      if (projectId) filter.projectId = projectId

      const allNotes = await db.collection<ContentNote>('content_notes').find(filter).toArray()

      const scored = allNotes
        .map(note => ({
          note,
          score: embeddingService.cosineSimilarity(queryEmbedding, note.embedding!),
        }))
        .filter(s => s.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      if (scored.length > 0) return scored.map(s => s.note)
    } catch {
      // Embedding unavailable — fall through to regex.
    }

    // Regex fallback.
    const filter: any = {
      $or: [
        { content: { $regex: query, $options: 'i' } },
        { topic: { $regex: query, $options: 'i' } },
      ],
    }
    if (projectId) filter.projectId = projectId
    return db.collection<ContentNote>('content_notes')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  }
}
