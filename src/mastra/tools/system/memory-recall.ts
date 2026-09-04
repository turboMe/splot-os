/**
 * system.memory_recall — Semantic search over system_knowledge (Phase 1.4)
 *
 * Retrieves relevant knowledge items by embedding the query and comparing
 * against stored knowledge vectors via cosine similarity.
 *
 * Follows the same pattern as recallWorkerLessonsTool but searches
 * system_knowledge (extracted by Memory Extractor) instead of signals.
 *
 * Also renews TTL on recalled items — useful knowledge stays alive.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding, cosineSimilarity } from '../../lib/embedder.js';
import type { SystemKnowledge } from '../../services/memory-extractor.js';
import { KNOWLEDGE_TYPES, renewKnowledgeTTL } from '../../services/memory-extractor.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

export const memoryRecallTool = createTool({
  id: 'system_memory_recall',
  description: `Search system knowledge for relevant past patterns, failures, and lessons.
Use at the start of complex tasks to check for known pitfalls, proven strategies, and architectural decisions.

Knowledge categories:
- failure_case — past errors and how they were resolved
- coding_pattern — successful orchestration/coding strategies
- autoheal_recipe — self-healing patterns that worked
- tool_contract — tool usage rules discovered from repeated errors
- prompt_rule — prompt optimization insights
- user_preference — observed user preferences and habits
- project_fact — project-specific facts and constraints
- architecture_decision — past architectural choices and rationale
- system_diagnostic — diagnostic findings about the running system
- workflow_result — outcomes of executed workflows/pipelines
- operational_note — operational observations and runbook notes
- env_config — environment/configuration facts

Returns results ranked by semantic similarity. Recalled items get their TTL renewed automatically.`,

  inputSchema: z.object({
    query: z.string().min(3).describe(
      'Describe what you\'re looking for — task type, error pattern, tool name, etc.',
    ),
    type: z.enum([...KNOWLEDGE_TYPES] as [string, ...string[]]).optional().describe(
      'Optional: filter by knowledge category',
    ),
    topK: z.number().int().min(1).max(15).default(5).describe(
      'Max results to return (default 5)',
    ),
    minScore: z.number().min(0).max(1).default(0.4).describe(
      'Minimum similarity threshold (default 0.4)',
    ),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    items: z.array(z.object({
      knowledgeId: z.string(),
      type: z.string(),
      title: z.string(),
      content: z.string(),
      confidence: z.number(),
      score: z.number(),
      createdAt: z.string(),
    })),
    count: z.number(),
    error: z.string().optional(),
  }),

  execute: withToolEnvelope({
    toolId: 'system_memory_recall',
    category: 'memory',
    risk: 'low',
    outputPreviewMaxChars: 4000,
    execute: async (ctx) => {
    try {
      const db = await getDb();

      // Build query filter
      const filter: Record<string, unknown> = {
        expiresAt: { $gt: new Date() },
      };
      if (ctx.type) filter.type = ctx.type;

      // Fetch candidates
      const candidates = await db
        .collection<SystemKnowledge>('system_knowledge')
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(300) // cap for performance
        .toArray() as unknown as SystemKnowledge[];

      if (candidates.length === 0) {
        return { success: true, items: [], count: 0 };
      }

      // Filter to items that have embeddings
      const withEmbeddings = candidates.filter(
        c =>
          Array.isArray(c.embedding) &&
          c.embedding.length > 0 &&
          c.embeddingModel === EMBEDDING_MODEL_ID,
      );

      if (withEmbeddings.length === 0) {
        // Fall back to returning most recent items without scoring
        const fallback = candidates.slice(0, ctx.topK ?? 5).map(c => ({
          knowledgeId: c.knowledgeId,
          type: c.type,
          title: c.title,
          content: c.content,
          confidence: c.confidence,
          score: 0,
          createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
        }));
        return { success: true, items: fallback, count: fallback.length };
      }

      // Embed query
      const queryVec = await generateEmbedding(ctx.query);

      // Rank by cosine similarity
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
        .filter(r => r.score >= (ctx.minScore ?? 0.4))
        .sort((a, b) => b.score - a.score)
        .slice(0, ctx.topK ?? 5);

      // Renew TTL on recalled items (fire-and-forget)
      for (const item of scored) {
        renewKnowledgeTTL(item.knowledgeId).catch(() => {});
      }

      return {
        success: true,
        items: scored,
        count: scored.length,
      };
    } catch (error) {
      return {
        success: false,
        items: [],
        count: 0,
        error: (error as Error).message,
      };
    }
    },
  }),
});
