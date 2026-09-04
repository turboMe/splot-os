#!/usr/bin/env tsx
/**
 * Backfill system_knowledge searchText/searchTextHash and embeddings.
 *
 * Use after changing the semantic memory search text contract.
 */

import { closeDb, getDb } from '../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding } from '../lib/embedder.js';
import {
  buildSystemKnowledgeSearchText,
  hashSystemKnowledgeSearchText,
  type SystemKnowledge,
} from '../services/memory-extractor.js';

type BackfillKnowledgeDoc = Pick<
  SystemKnowledge,
  | 'knowledgeId'
  | 'type'
  | 'title'
  | 'content'
  | 'tags'
  | 'sourceAgent'
  | 'projectId'
  | 'searchTextHash'
  | 'embedding'
  | 'embeddingModel'
>;

async function main(): Promise<void> {
  const db = await getDb();
  const col = db.collection<SystemKnowledge>('system_knowledge');
  const docs = await col
    .find({ title: { $type: 'string' }, expiresAt: { $gt: new Date() } })
    .project({
      knowledgeId: 1,
      type: 1,
      title: 1,
      content: 1,
      tags: 1,
      sourceAgent: 1,
      projectId: 1,
      searchTextHash: 1,
      embedding: 1,
      embeddingModel: 1,
    })
    .toArray() as unknown as BackfillKnowledgeDoc[];

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`[backfill-system-knowledge-embeddings] model=${EMBEDDING_MODEL_ID}`);

  for (const doc of docs) {
    scanned++;
    const searchText = buildSystemKnowledgeSearchText(doc);
    const searchTextHash = hashSystemKnowledgeSearchText(searchText);
    const hasCurrentEmbedding =
      doc.embeddingModel === EMBEDDING_MODEL_ID &&
      Array.isArray(doc.embedding) &&
      doc.embedding.length > 0;

    if (doc.searchTextHash === searchTextHash && hasCurrentEmbedding) {
      skipped++;
      continue;
    }

    try {
      const embedding = await generateEmbedding(searchText);
      await col.updateOne(
        { knowledgeId: doc.knowledgeId },
        {
          $set: {
            searchText,
            searchTextHash,
            embedding,
            embeddingModel: EMBEDDING_MODEL_ID,
            updatedAt: new Date(),
          },
        },
      );
      updated++;
    } catch (error) {
      failed++;
      console.warn(
        `[backfill-system-knowledge-embeddings] failed knowledgeId=${doc.knowledgeId}: ${(error as Error).message}`,
      );
    }
  }

  console.log(
    `[backfill-system-knowledge-embeddings] scanned=${scanned} updated=${updated} skipped=${skipped} failed=${failed}`,
  );
}

main()
  .catch((error) => {
    console.error('[backfill-system-knowledge-embeddings] failed:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
