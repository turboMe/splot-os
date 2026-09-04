/**
 * MongoDB tools with readonly-first policy (Faza 4.1).
 *
 * db.query  — readonly: find, aggregate, count, distinct. Always allowed.
 * db.write  — mutating: insertOne, updateOne, updateMany, deleteOne, deleteMany.
 *             Requires explicit { confirm: true } — agent must ask user before passing true.
 *             Every write is logged to agent_events collection.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

// ── Allowed readonly operations ───────────────────────────────────────────────

const READONLY_OPS = ['find', 'aggregate', 'count', 'distinct', 'findOne'] as const;
type ReadonlyOp = typeof READONLY_OPS[number];

// ── Allowed write operations ──────────────────────────────────────────────────

const WRITE_OPS = ['insertOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne'] as const;
type WriteOp = typeof WRITE_OPS[number];

// Internal delivery/control collections must only be accessed through their
// scoped service APIs. A generic model-facing query/write would bypass owner
// checks and atomic claim semantics.
const PROTECTED_INTERNAL_COLLECTIONS = new Set([
  'pending_user_messages',
]);

const WRITE_AGGREGATION_STAGES = new Set([
  '$merge',
  '$out',
]);

function protectedCollectionReference(
  stage: string,
  value: unknown,
): string | undefined {
  let collection: unknown;
  if (stage === '$lookup' || stage === '$graphLookup') {
    collection = value && typeof value === 'object'
      ? (value as Record<string, unknown>).from
      : undefined;
  } else if (stage === '$unionWith') {
    collection = typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>).coll
        : undefined;
  }
  if (collection && typeof collection === 'object') {
    collection = (collection as Record<string, unknown>).coll;
  }
  return typeof collection === 'string'
    && PROTECTED_INTERNAL_COLLECTIONS.has(collection.trim())
    ? stage
    : undefined;
}

function findForbiddenAggregationStage(
  value: unknown,
  visited = new WeakSet<object>(),
): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (visited.has(value)) return 'cyclic_pipeline';
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const forbidden = findForbiddenAggregationStage(item, visited);
      if (forbidden) return forbidden;
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (WRITE_AGGREGATION_STAGES.has(key)) return key;
    const protectedReference = protectedCollectionReference(key, nested);
    if (protectedReference) return protectedReference;
    const forbidden = findForbiddenAggregationStage(nested, visited);
    if (forbidden) return forbidden;
  }
  return undefined;
}

// ── Audit logger ─────────────────────────────────────────────────────────────

async function logWriteEvent(params: {
  operation: WriteOp;
  collection: string;
  filter?: unknown;
  update?: unknown;
  result: unknown;
}): Promise<void> {
  try {
    const db = await getDb();
    await db.collection('agent_events').insertOne({
      type: 'db_write',
      timestamp: new Date(),
      collection: params.collection,
      operation: params.operation,
      filter: JSON.stringify(params.filter ?? {}),
      update: JSON.stringify(params.update ?? {}),
      result: JSON.stringify(params.result),
      source: 'db.write tool',
    });
  } catch {
    // Non-critical: audit log failure must not block the write
  }
}

// ────────────────────────────────────────────────────────────────────────────
// db.query — READONLY
// ────────────────────────────────────────────────────────────────────────────

export const mongoQueryTool = createTool({
  id: 'db_query',
  description:
    'Readonly MongoDB query tool. Supports find, findOne, aggregate, count, distinct. ' +
    'Use for inspecting collections without any risk of data modification. ' +
    'For writes (insert, update, delete) use db.write with confirm: true.',
  inputSchema: z.object({
    collection: z.string().describe('MongoDB collection name'),
    operation: z.enum(READONLY_OPS).describe('Readonly operation to perform'),
    filter: z.record(z.string(), z.unknown()).optional().default({}).describe('MongoDB query filter (JSON)'),
    projection: z.record(z.string(), z.unknown()).optional().describe('Fields to include/exclude'),
    pipeline: z.array(z.record(z.string(), z.unknown())).optional().describe('Aggregation pipeline stages (for aggregate)'),
    field: z.string().optional().describe('Field name (for distinct operation)'),
    sort: z.record(z.string(), z.unknown()).optional().describe('Sort order'),
    limit: z.number().optional().default(20).describe('Max documents returned (default 20, max 100)'),
    skip: z.number().optional().default(0).describe('Documents to skip (pagination)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    operation: z.string(),
    collection: z.string(),
    count: z.number().optional(),
    results: z.array(z.record(z.string(), z.unknown())).optional(),
    value: z.unknown().optional().describe('Result for count/distinct/findOne'),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { collection, operation, filter, projection, pipeline, field, sort, limit, skip } = context;
    const maxLimit = Math.min(limit ?? 20, 100);
    if (PROTECTED_INTERNAL_COLLECTIONS.has(collection.trim())) {
      return {
        success: false,
        operation,
        collection,
        error: 'Protected internal collection; use its scoped service API.',
      };
    }
    const forbiddenStage = operation === 'aggregate'
      ? findForbiddenAggregationStage(pipeline)
      : undefined;
    if (forbiddenStage) {
      return {
        success: false,
        operation,
        collection,
        error: 'Protected collection references and write aggregation stages are not allowed.',
      };
    }

    try {
      const db = await getDb();
      const col = db.collection(collection);

      switch (operation as ReadonlyOp) {
        case 'find': {
          const docs = await col
            .find(filter ?? {}, { projection })
            .sort((sort ?? {}) as any)
            .skip(skip ?? 0)
            .limit(maxLimit)
            .toArray();
          return { success: true, operation, collection, count: docs.length, results: docs as any };
        }

        case 'findOne': {
          const doc = await col.findOne(filter ?? {}, { projection });
          return { success: true, operation, collection, value: doc, results: doc ? [doc as any] : [] };
        }

        case 'count': {
          const n = await col.countDocuments(filter ?? {});
          return { success: true, operation, collection, value: n, count: n, results: [] };
        }

        case 'distinct': {
          if (!field) throw new Error('field is required for distinct operation');
          const values = await col.distinct(field, filter ?? {});
          return { success: true, operation, collection, value: values, count: values.length, results: [] };
        }

        case 'aggregate': {
          if (!pipeline) throw new Error('pipeline is required for aggregate operation');
          const docs = await col.aggregate(pipeline).limit(maxLimit).toArray();
          return { success: true, operation, collection, count: docs.length, results: docs as any };
        }

        default:
          return { success: false, operation, collection, error: `Unknown operation: ${operation}` };
      }
    } catch (error) {
      return { success: false, operation, collection, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// db.write — MUTATING (requires confirm: true)
// ────────────────────────────────────────────────────────────────────────────

export const mongoWriteTool = createTool({
  id: 'db_write',
  description:
    'MUTATING MongoDB tool. Supports insertOne, updateOne, updateMany, deleteOne, deleteMany, replaceOne. ' +
    'ALWAYS requires confirm: true — you MUST inform the user what data will be modified and get their approval ' +
    'before passing confirm: true. Every write is permanently logged to agent_events. ' +
    'For safe reads use db.query instead.',
  inputSchema: z.object({
    collection: z.string().describe('MongoDB collection name'),
    operation: z.enum(WRITE_OPS).describe('Write operation to perform'),
    confirm: z.boolean().describe('Must be true — confirms user approved this write operation'),
    document: z.record(z.string(), z.unknown()).optional().describe('Document to insert (for insertOne/replaceOne)'),
    filter: z.record(z.string(), z.unknown()).optional().describe('Filter for update/delete operations'),
    update: z.record(z.string(), z.unknown()).optional().describe('Update document or operators (for updateOne/Many)'),
    upsert: z.boolean().optional().default(false).describe('Insert if not found (update operations only)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    operation: z.string(),
    collection: z.string(),
    matchedCount: z.number().optional(),
    modifiedCount: z.number().optional(),
    insertedId: z.string().optional(),
    deletedCount: z.number().optional(),
    blocked: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { collection, operation, confirm, document, filter, update, upsert } = context;

    if (PROTECTED_INTERNAL_COLLECTIONS.has(collection.trim())) {
      return {
        success: false,
        operation,
        collection,
        blocked: true,
        error: 'Protected internal collection; use its scoped service API.',
      };
    }

    // Safety gate — must be explicitly confirmed
    if (!confirm) {
      return {
        success: false,
        operation,
        collection,
        blocked: true,
        error:
          'BLOCKED: confirm must be true. Inform the user exactly what will be modified, ' +
          'get their approval, then call again with confirm: true.',
      };
    }

    try {
      const db = await getDb();
      const col = db.collection(collection);

      let result: unknown;

      switch (operation as WriteOp) {
        case 'insertOne': {
          if (!document) throw new Error('document is required for insertOne');
          const r = await col.insertOne({ ...document, createdAt: new Date() });
          result = { insertedId: r.insertedId.toString() };
          await logWriteEvent({ operation, collection, update: document, result });
          return { success: true, operation, collection, insertedId: r.insertedId.toString() };
        }

        case 'updateOne': {
          if (!filter || !update) throw new Error('filter and update are required for updateOne');
          const r = await col.updateOne(filter, update, { upsert: upsert ?? false });
          result = { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
          await logWriteEvent({ operation, collection, filter, update, result });
          return { success: true, operation, collection, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
        }

        case 'updateMany': {
          if (!filter || !update) throw new Error('filter and update are required for updateMany');
          const r = await col.updateMany(filter, update, { upsert: upsert ?? false });
          result = { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
          await logWriteEvent({ operation, collection, filter, update, result });
          return { success: true, operation, collection, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
        }

        case 'deleteOne': {
          if (!filter) throw new Error('filter is required for deleteOne');
          const r = await col.deleteOne(filter);
          result = { deletedCount: r.deletedCount };
          await logWriteEvent({ operation, collection, filter, result });
          return { success: true, operation, collection, deletedCount: r.deletedCount };
        }

        case 'deleteMany': {
          if (!filter) throw new Error('filter is required for deleteMany');
          const r = await col.deleteMany(filter);
          result = { deletedCount: r.deletedCount };
          await logWriteEvent({ operation, collection, filter, result });
          return { success: true, operation, collection, deletedCount: r.deletedCount };
        }

        case 'replaceOne': {
          if (!filter || !document) throw new Error('filter and document are required for replaceOne');
          const r = await col.replaceOne(filter, document, { upsert: upsert ?? false });
          result = { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
          await logWriteEvent({ operation, collection, filter, update: document, result });
          return { success: true, operation, collection, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
        }

        default:
          return { success: false, operation, collection, error: `Unknown write operation: ${operation}` };
      }
    } catch (error) {
      return { success: false, operation, collection, error: (error as Error).message };
    }
  },
});
