/**
 * system.recall_worker_lessons — pull relevant past lessons from shared memory.
 *
 * Meta-agent stores lessons via pushSignalTool:
 *   type: 'lesson_learned'
 *   data: { task_pattern: string, lesson: string, preset?: string }
 *
 * This tool queries the signals collection and ranks results by cosine similarity
 * using the embedder configured in model-manifest.ts.
 *
 * Usage pattern:
 *   1. Start of a complex turn → call recall_worker_lessons to check for known pitfalls
 *   2. After a successful retry → pushSignalTool to save the lesson for future sessions
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { generateEmbedding, cosineSimilarity } from '../../lib/embedder.js';

export const recallWorkerLessonsTool = createTool({
  id: 'system_recall_worker_lessons',
  description: `Recalls relevant lessons from past worker executions stored in shared memory.
Use at the start of complex tasks to surface known pitfalls and successful patterns.
Lessons are stored via pushSignalTool with type='lesson_learned'.

Convention for storing lessons:
  pushSignalTool({
    type: 'lesson_learned',
    data: {
      task_pattern: '<15-word description of the task type>',
      lesson: 'For X tasks, prefer Y approach because Z. Avoid W.',
      preset: 'reasoning'  // optional: which preset worked
    },
    ttlHours: 720  // 30 days
  })`,

  inputSchema: z.object({
    taskPattern: z
      .string()
      .min(5)
      .describe('Short description of the current task type (used for semantic similarity matching)'),
    topK: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe('How many relevant lessons to return (default 3)'),
    minScore: z
      .number()
      .min(0)
      .max(1)
      .default(0.45)
      .describe('Minimum cosine similarity threshold (default 0.45)'),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    lessons: z.array(
      z.object({
        taskPattern: z.string(),
        lesson: z.string(),
        preset: z.string().optional(),
        score: z.number(),
        savedAt: z.string(),
      }),
    ),
    count: z.number(),
    error: z.string().optional(),
  }),

  execute: async (ctx) => {
    try {
      const db = await getDb();

      // Pull all non-expired lesson_learned signals
      const raw = await db
        .collection('signals')
        .find({
          type: 'lesson_learned',
          expiresAt: { $gt: new Date() },
          'data.task_pattern': { $exists: true },
          'data.lesson': { $exists: true },
        })
        .sort({ createdAt: -1 })
        .limit(200) // cap for performance
        .toArray();

      if (raw.length === 0) {
        return { success: true, lessons: [], count: 0 };
      }

      // Embed the query
      const queryVec = await generateEmbedding(ctx.taskPattern);

      // Embed all stored task_patterns and rank by cosine similarity
      const patterns = raw.map((r) => r.data.task_pattern as string);
      const patternVecs = await Promise.all(patterns.map((p) => generateEmbedding(p)));

      const scored = raw
        .map((r, i) => ({
          taskPattern: r.data.task_pattern as string,
          lesson: r.data.lesson as string,
          preset: r.data.preset as string | undefined,
          savedAt: r.createdAt as string,
          score: cosineSimilarity(queryVec, patternVecs[i]),
        }))
        .filter((r) => r.score >= (ctx.minScore ?? 0.45))
        .sort((a, b) => b.score - a.score)
        .slice(0, ctx.topK ?? 3);

      return {
        success: true,
        lessons: scored,
        count: scored.length,
      };
    } catch (error) {
      // Non-fatal — meta-agent should continue even if recall fails
      return {
        success: false,
        lessons: [],
        count: 0,
        error: (error as Error).message,
      };
    }
  },
});
