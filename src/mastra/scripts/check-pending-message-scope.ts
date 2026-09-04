#!/usr/bin/env tsx
/**
 * Deterministic SEC-001 containment check for the legacy pending-message queue.
 *
 * This intentionally targets the legacy adapter. It proves fail-closed scope
 * selection and atomic at-most-once claims while the V2 inbox/delivery cutover
 * remains a later migration step.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context';

import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  META_AGENT_ID,
} from '../config/agent-ids.js';
import {
  closeDb,
  getDb,
} from '../lib/mongo.js';
import {
  ensurePendingMessageClaimIndexes,
  PENDING_MESSAGE_CLAIM_INDEXES,
} from '../lib/pending-message-indexes.js';
import { PendingUpdatesProcessor } from '../processors/pending-updates.js';
import {
  ackPendingMessages,
  collectAtomicClaims,
  queuePendingMessage,
  reclaimExpiredClaims,
  takePendingMessages,
  type PendingMessage,
  type PendingMessageCollectionLike,
} from '../services/pending-message-queue.js';
import { checkPendingUpdatesTool } from '../tools/system/check-pending-updates.js';
import {
  mongoQueryTool,
  mongoWriteTool,
} from '../tools/system/mongo-tools.js';

const TAG = `pending-scope-${Date.now()}-${randomUUID()}`;
const COLLECTION = 'pending_user_messages';
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const TEST_DATABASE = `pm_scope_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
let isolatedDatabaseActive = false;
let failures = 0;

function withDatabaseName(uri: string, databaseName: string): string {
  const queryStart = uri.indexOf('?');
  const base = queryStart === -1 ? uri : uri.slice(0, queryStart);
  const query = queryStart === -1 ? '' : uri.slice(queryStart);
  const authorityStart = base.indexOf('://') + 3;
  if (authorityStart < 3) throw new Error('MONGODB_URI must include a scheme');
  const databaseStart = base.indexOf('/', authorityStart);
  const authority = databaseStart === -1 ? base : base.slice(0, databaseStart);
  return `${authority}/${databaseName}${query}`;
}

function restoreMongoUri(): void {
  if (ORIGINAL_MONGODB_URI === undefined) {
    delete process.env.MONGODB_URI;
  } else {
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
  }
}

async function check(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

function scope(label: string): string {
  return `${TAG}:${label}`;
}

async function insertRaw(
  input: Partial<PendingMessage> & {
    omitTarget?: boolean;
  } = {},
): Promise<string> {
  const db = await getDb();
  const now = new Date();
  const id = input.id ?? `${TAG}:${randomUUID()}`;
  const doc: Record<string, unknown> = {
    id,
    threadId: input.threadId ?? scope('default-thread'),
    source: input.source ?? 'background_task',
    content: input.content ?? `message:${id}`,
    urgent: input.urgent ?? false,
    status: input.status ?? 'pending',
    createdAt: input.createdAt ?? now,
    expiresAt: input.expiresAt ?? new Date(now.getTime() + 60_000),
    metadata: {
      securityTestRunId: TAG,
      ...(input.metadata ?? {}),
    },
  };
  if (input.taskId !== undefined) doc.taskId = input.taskId;
  if (!input.omitTarget) {
    doc.targetAgentId = input.targetAgentId === undefined
      ? META_AGENT_ID
      : input.targetAgentId;
  }
  await db.collection(COLLECTION).insertOne(doc);
  return id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const db = await getDb();
  const doc = await db.collection(COLLECTION).findOne({ id });
  return typeof doc?.status === 'string' ? doc.status : undefined;
}

function toolContext(
  agentId: string,
  threadId: string,
  options: {
    resourceId?: string;
    reservedThreadId?: string;
    reservedResourceId?: string;
  } = {},
): Record<string, unknown> {
  return {
    agent: {
      agentId,
      threadId,
      resourceId: options.resourceId,
    },
    requestContext: {
      get: (key: string) => {
        if (key === MASTRA_THREAD_ID_KEY) return options.reservedThreadId;
        if (key === 'mastra__resourceId') return options.reservedResourceId;
        return undefined;
      },
    },
  };
}

async function cleanup(): Promise<void> {
  if (!isolatedDatabaseActive) return;
  const db = await getDb();
  assert.equal(
    db.databaseName,
    TEST_DATABASE,
    'refusing to drop a database outside the isolated test scope',
  );
  await db.dropDatabase();
  isolatedDatabaseActive = false;
}

async function main(): Promise<void> {
  process.env.MONGODB_URI = withDatabaseName(
    ORIGINAL_MONGODB_URI ?? 'mongodb://localhost:27017/agentforge',
    TEST_DATABASE,
  );
  isolatedDatabaseActive = true;
  process.env.FEATURE_SOFT_INTERRUPTS = 'true';
  process.env.FEATURE_LEDGER_V1 = 'false';
  console.log('check:pending-message-scope');

  await check('enqueue and no-scope paths fail closed', async () => {
    assert.equal(await queuePendingMessage({
      targetAgentId: META_AGENT_ID,
      source: 'user',
      content: 'missing scope',
    }), undefined);
    assert.equal(await queuePendingMessage({
      threadId: scope('invalid-target'),
      targetAgentId: '   ',
      source: 'user',
      content: 'missing target',
    }), undefined);
    assert.equal(await queuePendingMessage({
      threadId: scope('invalid-ttl'),
      targetAgentId: META_AGENT_ID,
      source: 'user',
      content: 'invalid ttl',
      ttlMs: Number.NaN,
    }), undefined);

    const id = await insertRaw({ threadId: scope('no-scope') });
    assert.deepEqual(
      await takePendingMessages({ agentId: META_AGENT_ID, limit: 10 }),
      [],
    );
    assert.equal(await statusOf(id), 'pending');
  });

  await check('thread scope cannot cross into another conversation', async () => {
    const threadA = scope('cross-thread-a');
    const threadB = scope('cross-thread-b');
    const id = await insertRaw({ threadId: threadA });
    assert.deepEqual(await takePendingMessages({
      threadId: threadB,
      agentId: META_AGENT_ID,
      limit: 10,
    }), []);
    assert.equal(await statusOf(id), 'pending');
    assert.deepEqual(
      (await takePendingMessages({
        threadId: threadA,
        agentId: META_AGENT_ID,
        limit: 10,
      })).map((message) => message.id),
      [id],
    );
  });

  await check('task plus thread uses exact AND semantics', async () => {
    const taskA = scope('task-a');
    const taskB = scope('task-b');
    const threadA = scope('and-thread-a');
    const threadB = scope('and-thread-b');
    const id = await insertRaw({ taskId: taskA, threadId: threadA });

    assert.deepEqual(await takePendingMessages({
      taskId: taskA,
      threadId: threadB,
      agentId: META_AGENT_ID,
    }), []);
    assert.deepEqual(await takePendingMessages({
      taskId: taskB,
      threadId: threadA,
      agentId: META_AGENT_ID,
    }), []);
    assert.equal(await statusOf(id), 'pending');
    assert.deepEqual(
      (await takePendingMessages({
        taskId: taskA,
        threadId: threadA,
        agentId: META_AGENT_ID,
      })).map((message) => message.id),
      [id],
    );
  });

  await check('target is exact, alias-compatible, and never wildcard', async () => {
    const threadId = scope('target');
    const legacyId = await insertRaw({
      threadId,
      targetAgentId: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
    });
    const foreignId = await insertRaw({
      threadId,
      targetAgentId: META_AGENT_ID,
    });
    const nullId = await insertRaw({
      threadId,
      targetAgentId: null,
    });
    const missingId = await insertRaw({
      threadId,
      omitTarget: true,
    });

    const claimed = await takePendingMessages({
      threadId,
      agentId: AUTOMATION_ARCHITECT_AGENT_ID,
      limit: 10,
    });
    assert.deepEqual(claimed.map((message) => message.id), [legacyId]);
    assert.equal(await statusOf(foreignId), 'pending');
    assert.equal(await statusOf(nullId), 'pending');
    assert.equal(await statusOf(missingId), 'pending');

    const reverseThread = scope('target-reverse');
    const canonicalizedId = await queuePendingMessage({
      threadId: reverseThread,
      targetAgentId: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
      source: 'background_task',
      content: 'legacy producer target',
      metadata: { securityTestRunId: TAG },
    });
    assert.ok(canonicalizedId);
    const reverse = await takePendingMessages({
      threadId: reverseThread,
      agentId: AUTOMATION_ARCHITECT_MASTRA_AGENT_ID,
    });
    assert.deepEqual(reverse.map((message) => message.id), [canonicalizedId]);
  });

  await check('concurrent consumers claim every record at most once', async () => {
    const threadId = scope('concurrent');
    const expected = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      expected.add(await insertRaw({
        threadId,
        createdAt: new Date(Date.now() + index),
        urgent: index % 3 === 0,
      }));
    }
    const batches = await Promise.all(
      Array.from({ length: 4 }, () => takePendingMessages({
        threadId,
        agentId: META_AGENT_ID,
        limit: 12,
      })),
    );
    const claimed = batches.flat().map((message) => message.id);
    assert.equal(claimed.length, expected.size);
    assert.equal(new Set(claimed).size, claimed.length);
    assert.deepEqual(new Set(claimed), expected);
  });

  await check('partial claim failure preserves the records already claimed', async () => {
    let calls = 0;
    const first = { id: scope('partial-first') };
    const batch = await collectAtomicClaims(3, async () => {
      calls += 1;
      if (calls === 1) return first;
      throw new Error('injected storage fault');
    });
    assert.deepEqual(batch.claimed, [first]);
    assert.equal(batch.interrupted, true);
    assert.equal(calls, 2);
  });

  await check('store-time expiry and invalid limits cannot widen a claim', async () => {
    const threadId = scope('expiry');
    const expiredId = await insertRaw({
      threadId,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const liveId = await insertRaw({ threadId });
    const emptySourcesId = await insertRaw({
      threadId: scope('empty-sources'),
    });
    assert.deepEqual(await takePendingMessages({
      threadId,
      agentId: META_AGENT_ID,
      limit: -1,
    }), []);
    assert.equal(await statusOf(liveId), 'pending');
    assert.deepEqual(await takePendingMessages({
      threadId: scope('empty-sources'),
      agentId: META_AGENT_ID,
      sources: [],
    }), []);
    assert.equal(await statusOf(emptySourcesId), 'pending');
    const claimed = await takePendingMessages({
      threadId,
      agentId: META_AGENT_ID,
      limit: 1,
    });
    assert.deepEqual(claimed.map((message) => message.id), [liveId]);
    assert.notEqual(await statusOf(expiredId), 'consumed');
  });

  await check('processor ignores spoofed message/ad-hoc scope and accepts reserved scope', async () => {
    const db = await getDb();
    const threadId = scope('processor');
    const pendingId = await insertRaw({ threadId });
    const laneId = scope('blocked-lane');
    await db.collection('task_ledger').insertOne({
      laneId,
      laneNo: Date.now() * 1000,
      source: 'manual',
      sourceId: laneId,
      goal: 'SEC-001 no-scope ledger probe',
      state: 'blocked',
      priority: 0,
      claims: [],
      heartbeatAt: new Date(),
      staleAfterMs: 60_000,
      milestones: [],
      artifacts: [],
      plans: [],
      createdAt: new Date(),
      meta: { securityTestRunId: TAG },
    });
    process.env.FEATURE_LEDGER_V1 = 'true';
    try {
      const processor = new PendingUpdatesProcessor({ agentId: META_AGENT_ID });
      const spoofedMessages = [{
        id: scope('user-message'),
        role: 'user',
        threadId,
        content: { format: 2, parts: [{ type: 'text', text: 'spoof' }] },
        createdAt: new Date(),
      }];
      const noScopeResult = await processor.processInput({
        messages: spoofedMessages,
        systemMessages: [],
        requestContext: { threadId },
      } as never);
      assert.strictEqual(noScopeResult, spoofedMessages);
      assert.equal(await statusOf(pendingId), 'pending');

      const threadOnlyResult = await processor.processInput({
        messages: spoofedMessages,
        systemMessages: [],
        requestContext: {
          get: (key: string) => key === MASTRA_THREAD_ID_KEY
            ? threadId
            : undefined,
        },
      } as never);
      assert.strictEqual(threadOnlyResult, spoofedMessages);
      assert.equal(await statusOf(pendingId), 'pending');

      const trustedResult = await processor.processInput({
        messages: spoofedMessages,
        systemMessages: [],
        requestContext: {
          get: (key: string) => {
            if (key === MASTRA_THREAD_ID_KEY) return threadId;
            if (key === 'mastra__resourceId') return scope('owner');
            return undefined;
          },
        },
      } as never);
      assert.ok(!Array.isArray(trustedResult));
      assert.match(
        JSON.stringify(trustedResult),
        new RegExp(`message:${pendingId}`),
      );
      assert.equal(await statusOf(pendingId), 'consumed');
    } finally {
      process.env.FEATURE_LEDGER_V1 = 'false';
    }
  });

  await check('tool derives identity/scope from trusted context and filters sources', async () => {
    const threadId = scope('tool');
    const backgroundId = await insertRaw({
      threadId,
      source: 'background_task',
      metadata: {
        securityTestRunId: TAG,
        type: 'security_probe',
      },
    });
    const userId = await insertRaw({
      threadId,
      source: 'user',
    });

    const noScope = await (checkPendingUpdatesTool as any).execute({
      agentId: META_AGENT_ID,
      threadId,
    }, {});
    assert.equal(noScope.hasUpdates, false);
    assert.equal(await statusOf(backgroundId), 'pending');

    const agentContextOnly = await (checkPendingUpdatesTool as any).execute(
      {},
      toolContext(META_AGENT_ID, threadId),
    );
    assert.equal(agentContextOnly.hasUpdates, false);
    assert.equal(await statusOf(backgroundId), 'pending');

    const mismatch = await (checkPendingUpdatesTool as any).execute(
      {},
      toolContext(META_AGENT_ID, threadId, {
        reservedThreadId: scope('other-thread'),
      }),
    );
    assert.equal(mismatch.hasUpdates, false);
    assert.equal(await statusOf(backgroundId), 'pending');

    const unregistered = await (checkPendingUpdatesTool as any).execute(
      {},
      toolContext(KNOWLEDGE_AGENT_ID, threadId),
    );
    assert.equal(unregistered.hasUpdates, false);
    assert.equal(await statusOf(backgroundId), 'pending');

    const result = await (checkPendingUpdatesTool as any).execute(
      {},
      toolContext(META_AGENT_ID, threadId, {
        resourceId: scope('tool-owner'),
        reservedThreadId: threadId,
        reservedResourceId: scope('tool-owner'),
      }),
    );
    assert.equal(result.hasUpdates, true);
    assert.equal(result.updates.length, 1);
    assert.equal(result.updates[0]?.type, 'security_probe');
    assert.equal(await statusOf(backgroundId), 'consumed');
    assert.equal(await statusOf(userId), 'pending');
  });

  await check('generic Mongo tools cannot bypass the queue service', async () => {
    const queryResult = await (mongoQueryTool as any).execute({
      collection: COLLECTION,
      operation: 'find',
      filter: {},
      limit: 100,
      skip: 0,
    });
    assert.equal(queryResult.success, false);
    assert.match(queryResult.error, /Protected internal collection/);

    for (const pipeline of [
      [{
        $unionWith: {
          coll: COLLECTION,
          pipeline: [{ $match: {} }],
        },
      }],
      [{
        $facet: {
          nested: [{
            $lookup: {
              from: COLLECTION,
              localField: 'id',
              foreignField: 'id',
              as: 'pending',
            },
          }],
        },
      }],
      [{ $merge: { into: COLLECTION } }],
      [{ $out: COLLECTION }],
    ]) {
      const aggregateResult = await (mongoQueryTool as any).execute({
        collection: 'agent_events',
        operation: 'aggregate',
        pipeline,
        limit: 100,
        skip: 0,
      });
      assert.equal(aggregateResult.success, false);
      assert.match(
        aggregateResult.error,
        /aggregation stages are not allowed/,
      );
    }
    const safeAggregate = await (mongoQueryTool as any).execute({
      collection: 'agent_events',
      operation: 'aggregate',
      pipeline: [
        { $match: { _id: null } },
        {
          $lookup: {
            from: 'safe_join_fixture',
            localField: '_id',
            foreignField: '_id',
            as: 'safe',
          },
        },
        { $limit: 1 },
      ],
      limit: 1,
      skip: 0,
    });
    assert.equal(safeAggregate.success, true);

    const bypassId = scope('mongo-bypass');
    const writeResult = await (mongoWriteTool as any).execute({
      collection: COLLECTION,
      operation: 'insertOne',
      confirm: true,
      document: {
        id: bypassId,
        status: 'pending',
        content: 'bypass',
      },
      upsert: false,
    });
    assert.equal(writeResult.success, false);
    assert.equal(writeResult.blocked, true);
    const db = await getDb();
    assert.equal(await db.collection(COLLECTION).countDocuments({ id: bypassId }), 0);
  });

  await check('all runtime paths share the three scoped claim indexes', async () => {
    const db = await getDb();
    await ensurePendingMessageClaimIndexes(db);
    const indexes = await db.collection(COLLECTION).listIndexes().toArray();
    const byName = new Map(indexes.map((index) => [index.name, index]));
    for (const expected of PENDING_MESSAGE_CLAIM_INDEXES) {
      const actual = byName.get(expected.name!);
      assert.ok(actual, `missing index ${expected.name}`);
      assert.deepEqual(actual.key, expected.key);
    }
  });

  // ── SEC-001 (F2): a claim is a LEASE, not a consume ────────────────────────
  await check('a crashed consumer redelivers its message instead of losing it', async () => {
    const threadId = `thr-lease-${randomUUID()}`;
    await queuePendingMessage({
      threadId,
      targetAgentId: 'codingAgent',
      source: 'user',
      content: 'stop and reconsider',
    });

    // Claim leaves the record LEASED — not consumed. This is the whole point:
    // before SEC-001 the same call wrote `consumed`, so a crash here lost the
    // user's interrupt permanently.
    const claimed = await takePendingMessages({ threadId, agentId: 'codingAgent', limit: 5 });
    assert.equal(claimed.length, 1, 'expected exactly one claimed message');
    assert.equal(claimed[0]!.status, 'claimed', 'claim must lease, never consume');
    assert.ok(claimed[0]!.leaseExpiresAt instanceof Date, 'lease must carry a deadline');

    // Simulate the crash: no ACK, and the lease has expired.
    const collection = (await getDb()).collection<PendingMessage>('pending_user_messages');
    await collection.updateOne(
      { id: claimed[0]!.id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );

    // The next claim reclaims it first, so the interrupt is delivered again.
    const redelivered = await takePendingMessages({ threadId, agentId: 'codingAgent', limit: 5 });
    assert.equal(redelivered.length, 1, 'an expired lease must be redelivered');
    assert.equal(redelivered[0]!.id, claimed[0]!.id, 'the SAME message comes back');
    assert.equal(redelivered[0]!.redeliveryCount, 1, 'redelivery is counted');
  });

  await check('an acknowledged message is consumed exactly once', async () => {
    const threadId = `thr-ack-${randomUUID()}`;
    await queuePendingMessage({
      threadId,
      targetAgentId: 'codingAgent',
      source: 'user',
      content: 'ack me',
    });
    const claimed = await takePendingMessages({ threadId, agentId: 'codingAgent', limit: 5 });
    assert.equal(claimed.length, 1);

    const acked = await ackPendingMessages({ messages: claimed, agentId: 'codingAgent' });
    assert.equal(acked, 1, 'ACK must settle the lease');

    const collection = (await getDb()).collection<PendingMessage>('pending_user_messages');
    const after = await collection.findOne({ id: claimed[0]!.id });
    assert.equal(after?.status, 'consumed');
    assert.equal(after?.leaseExpiresAt, undefined, 'a settled record holds no lease');

    // Even an expired-looking record is never redelivered once acknowledged.
    const again = await takePendingMessages({ threadId, agentId: 'codingAgent', limit: 5 });
    assert.equal(again.length, 0, 'a consumed message must not come back');
  });

  await check('ACK is fenced on the exact lease owner', async () => {
    const threadId = `thr-fence-${randomUUID()}`;
    await queuePendingMessage({
      threadId,
      targetAgentId: 'codingAgent',
      source: 'user',
      content: 'fenced',
    });
    const claimed = await takePendingMessages({
      threadId,
      agentId: 'codingAgent',
      subtaskId: 'owner-a',
      limit: 5,
    });
    assert.equal(claimed.length, 1);

    // A different lease owner (different subtask) must not be able to settle it —
    // otherwise a consumer that already lost the record could erase the redelivery.
    const foreign = await ackPendingMessages({
      messages: claimed,
      agentId: 'codingAgent',
      subtaskId: 'owner-b',
    });
    assert.equal(foreign, 0, 'a foreign owner cannot acknowledge the lease');

    const rightful = await ackPendingMessages({
      messages: claimed,
      agentId: 'codingAgent',
      subtaskId: 'owner-a',
    });
    assert.equal(rightful, 1, 'the exact lease owner settles it');
  });

  await check('redelivery is bounded and a poison record is parked as stale', async () => {
    // Drive reclaim directly against a fake collection: the ceiling must park
    // the record instead of cycling it forever.
    const calls: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const fake: PendingMessageCollectionLike = {
      updateMany: async (filter, update) => {
        calls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    };
    const affected = await reclaimExpiredClaims({
      threadId: 'thr-bounded',
      agentId: 'codingAgent',
      collection: fake,
    });
    assert.equal(affected, 2, 'both the park and the release branch report');
    assert.equal(calls.length, 2);

    const parked = calls[0]!;
    const released = calls[1]!;
    // Park branch: at/above the ceiling → stale, lease cleared.
    assert.deepEqual((parked.filter as any).redeliveryCount, { $gte: 3 });
    assert.equal(((parked.update as any).$set).status, 'stale');
    // Release branch: below the ceiling → back to pending, counter incremented.
    assert.equal(((released.update as any).$set).status, 'pending');
    assert.deepEqual((released.update as any).$inc, { redeliveryCount: 1 });
    // Both branches only ever touch EXPIRED leases of this exact scope.
    for (const call of calls) {
      assert.equal((call.filter as any).status, 'claimed');
      assert.deepEqual((call.filter as any).$expr, { $lte: ['$leaseExpiresAt', '$$NOW'] });
    }
  });

  await cleanup();
  await closeDb();
  restoreMongoUri();
  if (failures > 0) {
    console.error(`\n❌ check:pending-message-scope — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:pending-message-scope — 15/15 passed');
}

main().catch(async (error) => {
  console.error('❌ check:pending-message-scope crashed:', error);
  await cleanup().catch(() => undefined);
  await closeDb().catch(() => undefined);
  restoreMongoUri();
  process.exit(1);
});
