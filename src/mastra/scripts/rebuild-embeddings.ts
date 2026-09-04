/**
 * Rebuild persisted embeddings after changing infrastructure.embedding.model.
 *
 * Runtime consumers filter by EMBEDDING_MODEL_ID, so stale embeddings are
 * ignored. This script refreshes critical persisted stores so RAG and memory
 * recall keep returning semantic results after a model switch.
 */
import { closeDb, getDb } from '../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding } from '../lib/embedder.js';
import { PATTERN_CATALOG, type StoredAutomationPattern } from '../tools/architect/pattern-catalog.js';
import {
  buildSystemKnowledgeSearchText,
  hashSystemKnowledgeSearchText,
  type SystemKnowledge,
} from '../services/memory-extractor.js';

const PATTERN_COLLECTION = 'automation_patterns';
const KNOWLEDGE_COLLECTION = 'system_knowledge';

async function rebuildAutomationPatterns(): Promise<{ synced: number; embedded: number }> {
  const db = await getDb();
  const col = db.collection<StoredAutomationPattern>(PATTERN_COLLECTION);

  let synced = 0;
  let embedded = 0;

  for (const p of PATTERN_CATALOG) {
    const existing = await col.findOne({ id: p.id });
    const text = `${p.name}: ${p.description} (Intents: ${p.supportedIntents.join(', ')})`;
    const embedding = await generateEmbedding(text);

    const stored: StoredAutomationPattern = {
      id: p.id,
      name: p.name,
      description: p.description,
      risk: p.risk,
      supportedIntents: p.supportedIntents,
      requiredInputs: p.requiredInputs,
      requiredCredentials: p.requiredCredentials,
      forbiddenWithoutApproval: p.forbiddenWithoutApproval,
      executable: p.executable !== false,
      maturity: p.maturity,
      n8nCommunityCompatible: p.n8nCommunityCompatible,
      builderId: p.id,
      embedding,
      embeddingModel: EMBEDDING_MODEL_ID,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };

    await col.updateOne({ id: p.id }, { $set: stored }, { upsert: true });
    synced++;
    embedded++;
  }

  return { synced, embedded };
}

async function rebuildSystemKnowledge(): Promise<{ scanned: number; embedded: number }> {
  const db = await getDb();
  const col = db.collection<SystemKnowledge>(KNOWLEDGE_COLLECTION);
  const docs = await col
    .find({ title: { $type: 'string' }, expiresAt: { $gt: new Date() } })
    .project({ knowledgeId: 1, type: 1, title: 1, content: 1, tags: 1, sourceAgent: 1, projectId: 1 })
    .toArray() as unknown as Array<Pick<SystemKnowledge, 'knowledgeId' | 'type' | 'title' | 'content' | 'tags' | 'sourceAgent' | 'projectId'>>;

  let embedded = 0;

  for (const doc of docs) {
    const searchText = buildSystemKnowledgeSearchText(doc);
    const searchTextHash = hashSystemKnowledgeSearchText(searchText);
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
    embedded++;
  }

  return { scanned: docs.length, embedded };
}

async function main() {
  console.log(`[rebuild-embeddings] model=${EMBEDDING_MODEL_ID}`);

  const patterns = await rebuildAutomationPatterns();
  console.log(
    `[rebuild-embeddings] automation_patterns synced=${patterns.synced} embedded=${patterns.embedded}`,
  );

  const knowledge = await rebuildSystemKnowledge();
  console.log(
    `[rebuild-embeddings] system_knowledge scanned=${knowledge.scanned} embedded=${knowledge.embedded}`,
  );
}

main()
  .catch((err) => {
    console.error('[rebuild-embeddings] failed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
