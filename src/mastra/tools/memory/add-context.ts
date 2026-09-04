/**
 * Shared memory tools (cross-agent signals & context).
 * Replaces: SharedMemoryService from jarvis core/shared-memory.ts.
 * Collections: shared_memory (context items), signals (typed broadcasts).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { randomUUID } from 'crypto';

// ────────────────────────────────────────────────────────────────────────────
// addContextTool – save a note/context for other agents to read
// ────────────────────────────────────────────────────────────────────────────
export const addContextTool = createTool({
  id: 'shared_memory_add_context',
  description: 'Saves a note/context in the shared memory that other agents can read. Use to store key insights, decisions, or alerts between sessions.',
  inputSchema: z.object({
    content: z.string().describe('Content of the context/note'),
    type: z.enum(['insight', 'alert', 'decision', 'signal', 'note']).optional().default('note'),
    key: z.string().optional().describe('Unique key (to overwrite an existing entry)'),
    sourceAgent: z.string().optional().default('meta-agent'),
    ttlHours: z.number().optional().default(48).describe('Time-to-live in hours (default 48h)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    contextId: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + (context.ttlHours ?? 48) * 3600 * 1000);

      const doc = {
        id,
        sourceAgent: context.sourceAgent ?? 'meta-agent',
        type: context.type ?? 'note',
        key: context.key ?? null,
        content: context.content,
        ttlHours: context.ttlHours ?? 48,
        expiresAt,
        createdAt: new Date().toISOString(),
      };

      if (context.key) {
        await db.collection('shared_memory').updateOne(
          { key: context.key },
          { $set: doc },
          { upsert: true }
        );
      } else {
        await db.collection('shared_memory').insertOne(doc);
      }

      return { success: true, contextId: id, message: `Context saved (expires in ${context.ttlHours ?? 48}h)` };
    } catch (error) {
      return { success: false, message: 'Error saving context', error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// listContextTool – read active shared memory
// ────────────────────────────────────────────────────────────────────────────
export const listContextTool = createTool({
  id: 'shared_memory_list_context',
  description: 'Reads active (not yet expired) entries from the shared memory. Use at the beginning of a session to know what other agents have saved.',
  inputSchema: z.object({
    type: z.enum(['insight', 'alert', 'decision', 'signal', 'note']).optional().describe('Filter by type'),
    limit: z.number().optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    items: z.array(z.object({
      id: z.string(),
      type: z.string(),
      key: z.string().nullable().optional(),
      content: z.string(),
      sourceAgent: z.string(),
      createdAt: z.string(),
    })),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const filter: Record<string, unknown> = { expiresAt: { $gt: new Date() } };
      if (context.type) filter.type = context.type;

      const items = await db.collection('shared_memory')
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(context.limit ?? 10)
        .toArray();

      return {
        success: true,
        count: items.length,
        items: items.map(i => ({
          id: i.id ?? String(i._id),
          type: i.type,
          key: i.key ?? null,
          content: i.content,
          sourceAgent: i.sourceAgent,
          createdAt: i.createdAt,
        })),
      };
    } catch (error) {
      return { success: false, count: 0, items: [], error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// pushSignalTool – broadcast a typed system signal
// ────────────────────────────────────────────────────────────────────────────
export const pushSignalTool = createTool({
  id: 'shared_memory_push_signal',
  description: `Broadcasts a typed system signal to other agents.
Signals are short-lived (default 12h) but can be extended (ttlHours: 720 = 30 days).

SPECIAL: type='lesson_learned' — saves a worker/delegation lesson for future recall via system.recall_worker_lessons.
Convention for lesson data:
  {
    task_pattern: '<15-word description of the task type, precise enough for semantic search>',
    lesson: 'For X tasks, use Y approach because Z. Avoid W.',
    preset: 'reasoning'  // optional: which run_worker preset worked
  }

Other common types: 'HIGH_FAILURE_RATE', 'HOT_LEAD', 'LEADS_STAGNATION', 'DEPLOY_SUCCESS', 'ANOMALY_DETECTED'`,
  inputSchema: z.object({
    type: z.string().describe('Signal type, e.g. "HIGH_FAILURE_RATE", "HOT_LEAD", "LEADS_STAGNATION"'),
    data: z.record(z.string(), z.unknown()).optional().default({}).describe('Signal data (JSON)'),
    sourceAgent: z.string().optional().default('meta-agent'),
    ttlHours: z.number().optional().default(12),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    signalId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const signalId = randomUUID();
      await db.collection('signals').insertOne({
        id: signalId,
        type: context.type,
        sourceAgent: context.sourceAgent ?? 'meta-agent',
        data: context.data ?? {},
        expiresAt: new Date(Date.now() + (context.ttlHours ?? 12) * 3600 * 1000),
        createdAt: new Date().toISOString(),
      });
      return { success: true, signalId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});
