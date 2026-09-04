/**
 * system.memory_write_observation — Manually save knowledge (Phase 1.4)
 *
 * Agents can explicitly save observations, patterns, architectural decisions,
 * and user preferences to system_knowledge for future recall.
 *
 * Complements the automatic Memory Extractor (Phase 1.3) — this tool lets
 * agents proactively write knowledge without waiting for pattern detection.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getDb } from '../../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding } from '../../lib/embedder.js';
import {
  buildSystemKnowledgeSearchText,
  hashSystemKnowledgeSearchText,
  KNOWLEDGE_TYPES,
} from '../../services/memory-extractor.js';

const KNOWLEDGE_TTL_DAYS = 90;
// Hard cap actually persisted (execute truncates to this). The input schema
// accepts more and we truncate gracefully, rather than hard-rejecting an
// over-long write (which previously forced the agent into a retry loop).
const MAX_STORED_CONTENT = 2000;

export const memoryWriteTool = createTool({
  id: 'system_memory_write_observation',
  description: `Save an observation, pattern, or decision to system knowledge for future recall.

Use this to persist:
- Coding patterns that worked well (decomposition strategies, model choices)
- User preferences discovered during interaction
- Architectural decisions and their rationale
- Tool usage contracts discovered from experience
- Project-specific facts and constraints

Knowledge is stored with semantic embeddings for similarity search,
has a 90-day TTL (renewed on recall), and deduplicates by title.

When to write:
- After completing a complex task (3+ subtasks) — save the orchestration pattern
- After discovering a non-obvious workaround or user preference
- After resolving a hard debugging problem — save the root cause pattern
- When a specific model/tool combination proves effective for a task type`,

  inputSchema: z.object({
    type: z.enum([...KNOWLEDGE_TYPES] as [string, ...string[]]).describe(
      'Category of knowledge being saved',
    ),
    title: z.string().min(5).max(200).describe(
      'Short, searchable title (used for embedding and deduplication)',
    ),
    content: z.string().min(10).max(8000).describe(
      'Full knowledge content — what happened, why it matters, what to do next time. ' +
      'Stored content is truncated to 2000 chars; keep it concise.',
    ),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    knowledgeId: z.string(),
    deduplicated: z.boolean().describe('True if existing knowledge was updated instead of creating new'),
    error: z.string().optional(),
  }),

  execute: async (ctx) => {
    try {
      const db = await getDb();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + KNOWLEDGE_TTL_DAYS * 24 * 3600 * 1000);
      const storedContent = ctx.content.slice(0, MAX_STORED_CONTENT);
      const searchText = buildSystemKnowledgeSearchText({
        type: ctx.type,
        title: ctx.title,
        content: storedContent,
      });
      const searchTextHash = hashSystemKnowledgeSearchText(searchText);

      // Generate embedding for semantic search
      let embedding: number[] = [];
      try {
        embedding = await generateEmbedding(searchText);
      } catch (err) {
        console.warn('[MemoryWrite] Embedding failed, saving without vector:', (err as Error).message);
      }

      // Check for existing knowledge with same type + title (deduplication)
      const existing = await db.collection('system_knowledge').findOne({
        type: ctx.type,
        title: ctx.title,
      });

      if (existing) {
        // Update existing — refresh content, TTL, and confidence
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

        return {
          success: true,
          knowledgeId: existing.knowledgeId as string,
          deduplicated: true,
        };
      }

      // Create new knowledge item
      const knowledgeId = randomUUID();
      await db.collection('system_knowledge').insertOne({
        knowledgeId,
        type: ctx.type,
        title: ctx.title,
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

      return {
        success: true,
        knowledgeId,
        deduplicated: false,
      };
    } catch (error) {
      return {
        success: false,
        knowledgeId: '',
        deduplicated: false,
        error: (error as Error).message,
      };
    }
  },
});
