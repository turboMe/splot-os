/**
 * Content exemplar library — the contentAgent's differentiator (analog of the
 * chef's recipe-library), but cold-started from CURATED GOLD, not metrics.
 *
 * Two seed sources of gold (see ideas/contentAgent.md Q5):
 *   - 'swipe' : external best-in-class patterns (a swipe file) annotated with WHY they work.
 *   - 'voice' : Patryk's own published posts — the voice corpus the agent imitates.
 * A third source is ADDITIVE and arrives later:
 *   - 'proven': engagement-vetted posts, admitted ONLY via human approval (CSV import →
 *               approval → source:'proven'). The agent's own output NEVER auto-enters the
 *               library, so it can never lower the bar. content_add_exemplar therefore
 *               refuses to write source:'proven' (reserved for the import/approval path).
 *
 * qualityScore is MANUAL (a human curator's judgement, 0–1), NOT derived from metrics —
 * the whole point is that a small hand-picked set beats a large noisy one.
 *
 * Retrieval mirrors chef-service.searchNotes (Mongo Community has no $vectorSearch):
 * app-side cosine when the embedder is up, regex fallback otherwise, reranked × quality.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { getDb } from '../../lib/mongo.js';
import { generateEmbedding, cosineSimilarity } from '../../lib/embedder.js';

const COLLECTION = 'content_exemplars';

/** Cosine floor for the vector leg — same threshold the notes search uses. */
const RELEVANCE_FLOOR = 0.35;

export type ExemplarSource = 'swipe' | 'voice' | 'proven';
export type ExemplarPlatform = 'linkedin' | 'instagram' | 'tiktok' | 'general';

export interface ContentExemplar {
  id: string;
  /** swipe = external pattern, voice = Patryk's own post, proven = engagement-vetted (import only). */
  source: ExemplarSource;
  platform: ExemplarPlatform;
  /** The post text / snippet itself. */
  content: string;
  /** Short title/topic label. */
  topic?: string;
  /** The gold: a curator's note on WHY this works (hook, structure, emotional trigger…). */
  whyItWorks?: string;
  /** Optional structural tags: hook type, format, framework (AIDA/PAS…), theme. */
  tags: string[];
  /** Manual curator quality 0–1 (NOT from metrics). */
  qualityScore: number;
  embedding?: number[];
  createdAt: Date;
  addedBy?: string;
}

export interface ExemplarSearchOptions {
  platform?: ExemplarPlatform;
  source?: ExemplarSource;
  limit?: number;
}

export interface ExemplarHit {
  id: string;
  source: ExemplarSource;
  platform: ExemplarPlatform;
  content: string;
  topic?: string;
  whyItWorks?: string;
  tags: string[];
  qualityScore: number;
  score: number;
}

let indexesEnsured = false;

async function ensureIndexes(db: Db): Promise<void> {
  if (indexesEnsured) return;
  await Promise.all([
    db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true }),
    db.collection(COLLECTION).createIndex({ source: 1 }),
    db.collection(COLLECTION).createIndex({ platform: 1 }),
    db.collection(COLLECTION).createIndex({ qualityScore: -1 }),
  ]).catch((err) => console.warn('[content-exemplars] index creation skipped:', err.message));
  indexesEnsured = true;
}

/**
 * Adds a curated exemplar. Guardrail: source:'proven' is rejected here — proven
 * status is granted only through the import/approval path, never by a tool call,
 * so agent-generated content can never silently become a "proven" exemplar.
 */
export async function addExemplar(params: {
  content: string;
  source: 'swipe' | 'voice';
  platform: ExemplarPlatform;
  whyItWorks?: string;
  topic?: string;
  tags?: string[];
  qualityScore?: number;
  addedBy?: string;
}): Promise<ContentExemplar> {
  // Defensive: the type already forbids 'proven', but guard at runtime too.
  if ((params.source as ExemplarSource) === 'proven') {
    throw new Error("source:'proven' is reserved for the human-approved import path and cannot be set via this tool.");
  }
  const db = await getDb();
  await ensureIndexes(db);

  let embedding: number[] | undefined;
  try {
    const textToEmbed = `${params.topic ? params.topic + ': ' : ''}${params.whyItWorks ? params.whyItWorks + '\n' : ''}${params.content}`;
    embedding = await generateEmbedding(textToEmbed);
  } catch {
    // Embedding optional — regex search still works.
  }

  const exemplar: ContentExemplar = {
    id: randomUUID(),
    source: params.source,
    platform: params.platform,
    content: params.content,
    topic: params.topic,
    whyItWorks: params.whyItWorks,
    tags: params.tags ?? [],
    // Clamp manual score into [0,1]; default 0.8 for hand-added gold.
    qualityScore: Math.min(1, Math.max(0, params.qualityScore ?? 0.8)),
    embedding,
    createdAt: new Date(),
    addedBy: params.addedBy,
  };
  await db.collection(COLLECTION).insertOne(exemplar);
  return exemplar;
}

function toHit(e: ContentExemplar, score: number): ExemplarHit {
  return {
    id: e.id,
    source: e.source,
    platform: e.platform,
    content: e.content,
    topic: e.topic,
    whyItWorks: e.whyItWorks,
    tags: e.tags ?? [],
    qualityScore: typeof e.qualityScore === 'number' ? e.qualityScore : 0.8,
    score: Math.round(score * 1e6) / 1e6,
  };
}

/**
 * Hybrid retrieval over the curated library. Vector leg (cosine × qualityScore)
 * when the embedder is up; regex fallback (sorted by qualityScore) otherwise.
 */
export async function searchExemplars(
  query: string,
  opts: ExemplarSearchOptions = {},
): Promise<ExemplarHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 25));
  const db = await getDb();
  await ensureIndexes(db);

  const baseFilter: Record<string, unknown> = {};
  if (opts.platform) baseFilter.platform = opts.platform;
  if (opts.source) baseFilter.source = opts.source;

  // ── Vector leg ──
  try {
    const qVec = await generateEmbedding(query);
    const candidates = await db
      .collection<ContentExemplar>(COLLECTION)
      .find({ ...baseFilter, embedding: { $exists: true } })
      .toArray();

    const scored = candidates
      .map((e) => {
        const cosine = cosineSimilarity(qVec, e.embedding!);
        const quality = typeof e.qualityScore === 'number' ? e.qualityScore : 0.8;
        return { e, cosine, score: cosine * quality };
      })
      .filter((s) => s.cosine >= RELEVANCE_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length > 0) return scored.map((s) => toHit(s.e, s.score));
  } catch {
    // Embedder down — fall through to regex.
  }

  // ── Regex fallback (rank by manual qualityScore) ──
  const regexFilter: Record<string, unknown> = {
    ...baseFilter,
    $or: [
      { content: { $regex: query, $options: 'i' } },
      { topic: { $regex: query, $options: 'i' } },
      { whyItWorks: { $regex: query, $options: 'i' } },
      { tags: { $regex: query, $options: 'i' } },
    ],
  };
  const docs = await db
    .collection<ContentExemplar>(COLLECTION)
    .find(regexFilter)
    .sort({ qualityScore: -1, createdAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map((e) => toHit(e, e.qualityScore ?? 0.8));
}
