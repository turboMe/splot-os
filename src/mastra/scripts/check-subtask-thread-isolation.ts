#!/usr/bin/env tsx
/**
 * check:subtask-thread-isolation — parallel subtasks of one task must not share
 * a conversation thread (J2 step 5).
 *
 * The task remains the shared unit for checkpoints and aggregation. The thread
 * does not: it owns conversational memory, pending-memory dedupe and inherited
 * depth. Two parallel subtasks observing one thread can therefore consume or
 * influence state that belongs to the other subtask.
 *
 * This gate checks both halves of the claim. First, the real executeSubtask
 * call site must derive `${taskId}::${subtask.id}` rather than relying on the
 * harness fallback to taskId. Second, two real generateCoding calls for one
 * task write completed-call events under disjoint thread ids. Only the external
 * model is scripted; Agent, the coding gateway, harness and Mongo event log are
 * production implementations.
 *
 * Run: npx tsx src/mastra/scripts/check-subtask-thread-isolation.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

console.log('check:subtask-thread-isolation');

const RS3_URI = 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const FALLBACK_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0';

async function connect(): Promise<{ client: MongoClient; label: string; uri: string }> {
  try {
    const client = new MongoClient(RS3_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { client, label: 'rs3f8 (three-node F8 set)', uri: RS3_URI };
  } catch {
    const client = new MongoClient(FALLBACK_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    return { client, label: 'MONGODB_URI fallback', uri: FALLBACK_URI };
  }
}

function uriForDatabase(uri: string, database: string): string {
  const queryAt = uri.indexOf('?');
  const base = queryAt >= 0 ? uri.slice(0, queryAt) : uri;
  const query = queryAt >= 0 ? uri.slice(queryAt) : '';
  const authorityStart = base.indexOf('://') + 3;
  const pathAt = base.indexOf('/', authorityStart);
  const authority = pathAt >= 0 ? base.slice(0, pathAt) : base;
  return `${authority}/${database}${query}`;
}

const executorSource = readFileSync('src/mastra/services/subtask-executor.ts', 'utf8');
const generateAt = executorSource.indexOf('const harnessResult = await generateCoding({');
const generateCall = executorSource.slice(generateAt, executorSource.indexOf('\n    });', generateAt));

await check('executeSubtask derives a stable thread id from task and subtask', () => {
  assert.ok(generateAt >= 0, 'could not locate executeSubtask -> generateCoding');
  assert.match(
    generateCall,
    /threadId:\s*`\$\{taskId\}::\$\{subtask\.id\}`/,
    'executeSubtask still lets the harness fall back to the task-wide thread',
  );
});

await check('depth inheritance is independent for two subtask threads', async () => {
  const { _resetThreadDepths, getThreadDepth, recordThreadDepth } = await import('../services/depth-controller.js');
  _resetThreadDepths();
  recordThreadDepth('task::subtask-A', 'critical');
  recordThreadDepth('task::subtask-B', 'fast');
  assert.equal(getThreadDepth('task::subtask-A'), 'critical');
  assert.equal(getThreadDepth('task::subtask-B'), 'fast');
  _resetThreadDepths();
});

await check('precontext keeps thread state separate while checkpoint stays task-scoped', () => {
  const harnessSource = readFileSync('src/mastra/services/coding-harness.ts', 'utf8');
  assert.match(harnessSource, /taskId:\s*context\.taskId/);
  assert.match(harnessSource, /threadId:\s*context\.threadId/);

  const assemblerSource = readFileSync('src/mastra/services/context-assembler.ts', 'utf8');
  assert.match(
    assemblerSource,
    /loadCheckpoint\(taskId\)/,
    'checkpoint lookup must remain shared by taskId',
  );
});

const { client, label, uri } = await connect();
console.log(`  · connected to ${label}`);
const dbName = `j2_thread_check_${Date.now()}`;
const db = client.db(dbName);
process.env.MONGODB_URI = uriForDatabase(uri, dbName);

try {
  await check('two real subtask calls write no cross-thread completed events', async () => {
    const [{ generateCoding }, { Agent }, { MockLanguageModelV3 }] = await Promise.all([
      import('../services/coding-harness.js'),
      import('@mastra/core/agent'),
      import('ai/test'),
    ]);

    const taskId = `j2-thread-task-${Date.now()}`;
    const cases = [
      { subtaskId: 'subtask-A', threadId: `${taskId}::subtask-A` },
      { subtaskId: 'subtask-B', threadId: `${taskId}::subtask-B` },
    ];

    const run = async ({ subtaskId, threadId }: (typeof cases)[number]) => {
      const model = new MockLanguageModelV3({
        modelId: `mock-j2-thread-${subtaskId}`,
        doGenerate: (async () => ({
          content: [{ type: 'text' as const, text: `completed ${subtaskId}` }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          warnings: [],
        })) as any,
      });
      const agent = new Agent({
        id: `j2-thread-agent-${subtaskId}`,
        name: `j2-thread-agent-${subtaskId}`,
        instructions: 'Return the scripted completion.',
        model: model as any,
      });
      await generateCoding({
        agent,
        agentId: 'codingAgent',
        prompt: `Complete ${subtaskId}.`,
        taskId,
        subtaskId,
        threadId,
        phase: 'subtask',
        timeoutMs: 30_000,
        contextPolicy: {
          includeMemory: false,
          includeSkills: false,
          includeRepoMap: false,
          includeCheckpoint: false,
          maxTokens: 256,
        },
      });
    };

    await Promise.all(cases.map(run));

    const events = await db.collection('agent_events')
      .find({ taskId, type: 'llm_call_completed' })
      .toArray();
    assert.equal(events.length, 2, `expected two completed-call events, got ${events.length}`);

    for (const expected of cases) {
      const own = events.filter((event) => event.threadId === expected.threadId);
      assert.equal(own.length, 1, `${expected.threadId} should own exactly one completion event`);
      assert.equal(own[0]!.subtaskId, expected.subtaskId);
      assert.ok(
        events.every((event) => event.threadId !== expected.threadId || event.subtaskId === expected.subtaskId),
        `${expected.threadId} contains another subtask's event`,
      );
    }
  });
} finally {
  await db.dropDatabase().catch(() => undefined);
  await client.close();
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('\nPASSED: every parallel subtask owns a separate conversation thread');
  process.exit(0);
}
