/**
 * Failure Brain — programmatic memory access (Phase 2.1)
 *
 * Direct functions for recall and write operations on system_knowledge,
 * bypassing the Mastra tool execution context. Used by internal services
 * (ErrorCollector, workflows) that don't have a tool context.
 */

import { getDb } from '../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding, cosineSimilarity } from '../lib/embedder.js';
import {
  buildSystemKnowledgeSearchText,
  hashSystemKnowledgeSearchText,
  renewKnowledgeTTL,
} from '../services/memory-extractor.js';
import type { SystemKnowledge, KnowledgeType } from '../services/memory-extractor.js';
import { randomUUID } from 'crypto';

const KNOWLEDGE_TTL_DAYS = 90;

export interface RecallResult {
  knowledgeId: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  score: number;
  createdAt: string;
}

/**
 * Programmatic recall — same logic as memoryRecallTool but without tool context.
 */
export async function recallKnowledge(
  query: string,
  opts: { type?: KnowledgeType; topK?: number; minScore?: number } = {},
): Promise<RecallResult[]> {
  const { type, topK = 5, minScore = 0.4 } = opts;
  const db = await getDb();

  const filter: Record<string, unknown> = { expiresAt: { $gt: new Date() } };
  if (type) filter.type = type;

  const candidates = await db
    .collection<SystemKnowledge>('system_knowledge')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(300)
    .toArray() as unknown as SystemKnowledge[];

  if (candidates.length === 0) return [];

  const withEmbeddings = candidates.filter(
    c =>
      Array.isArray(c.embedding) &&
      c.embedding.length > 0 &&
      c.embeddingModel === EMBEDDING_MODEL_ID,
  );

  if (withEmbeddings.length === 0) {
    return candidates.slice(0, topK).map(c => ({
      knowledgeId: c.knowledgeId,
      type: c.type,
      title: c.title,
      content: c.content,
      confidence: c.confidence,
      score: 0,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
    }));
  }

  const queryVec = await generateEmbedding(query);

  const scored = withEmbeddings
    .map(c => ({
      knowledgeId: c.knowledgeId,
      type: c.type,
      title: c.title,
      content: c.content,
      confidence: c.confidence,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
      score: cosineSimilarity(queryVec, c.embedding),
    }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Renew TTL on recalled items
  for (const item of scored) {
    renewKnowledgeTTL(item.knowledgeId).catch(() => {});
  }

  return scored;
}

/**
 * Programmatic write — same logic as memoryWriteTool but without tool context.
 */
export async function writeKnowledge(
  type: KnowledgeType,
  title: string,
  content: string,
): Promise<{ knowledgeId: string; deduplicated: boolean }> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000);
  const storedContent = content.slice(0, 2000);
  const searchText = buildSystemKnowledgeSearchText({ type, title, content: storedContent });
  const searchTextHash = hashSystemKnowledgeSearchText(searchText);

  let embedding: number[] = [];
  try {
    embedding = await generateEmbedding(searchText);
  } catch {
    // Save without vector
  }

  const existing = await db.collection('system_knowledge').findOne({ type, title });

  if (existing) {
    await db.collection('system_knowledge').updateOne(
      { knowledgeId: existing.knowledgeId },
      {
        $set: {
          content: storedContent,
          searchText,
          searchTextHash,
          embedding,
          embeddingModel: embedding.length > 0 ? EMBEDDING_MODEL_ID : undefined,
          updatedAt: now,
          expiresAt,
          confidence: Math.min(1, (existing.confidence ?? 0.5) + 0.1),
        },
      },
    );
    return { knowledgeId: existing.knowledgeId as string, deduplicated: true };
  }

  const knowledgeId = randomUUID();
  await db.collection('system_knowledge').insertOne({
    knowledgeId,
    type,
    title,
    content: storedContent,
    searchText,
    searchTextHash,
    embedding,
    embeddingModel: embedding.length > 0 ? EMBEDDING_MODEL_ID : undefined,
    sourceEventIds: [],
    confidence: 0.7,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  });

  return { knowledgeId, deduplicated: false };
}
