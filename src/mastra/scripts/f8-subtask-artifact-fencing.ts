#!/usr/bin/env tsx
/**
 * f8:subtask-artifact-fencing — a superseded parallel subtask must not append
 * to code_task_artifacts, while an owner nobody replaced must still finish.
 *
 * WHY BOTH ARMS MATTER
 * --------------------
 * Rejecting every worker after a network hiccup is safe and useless. Expiry is
 * therefore permission for a replacement to claim; it is not itself a write
 * fence. ARM 1 pins the production artifact tool to the current primary,
 * partitions that node longer than the lease, then proves the same owner can
 * update an additive report list after healing because nobody advanced its fence.
 *
 * ARM 2 uses the same pinned-worker framing but holds the partition long enough
 * for a real election. A normally routed replacement claims the expired slot,
 * advances the fence and adds its marker. The original identity then calls the REAL
 * coding_update_artifact tool and is refused by the Mongo update predicate;
 * exactly the replacement's marker remains.
 *
 * PRE-FIX FALSIFICATION
 * ---------------------
 * Before J2 step 6, the deterministic stale-owner assertion reported success
 * and replaced filesChanged even though the document already held fence 2.
 * Measured red output: "the stale production tool call reported success — true
 * !== false". The final gate retains the same real tool assertion before the
 * two fault arms.
 *
 * The gate uses only its throwaway database and always heals rs3f8 in finally.
 * It never stops the set and never purges its volumes.
 *
 * Run: npm run f8:subtask-artifact-fencing
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { MongoClient, type Db } from 'mongodb';

import { closeDb, getDb } from '../lib/mongo.js';
import {
  runWithHarnessExecutionContext,
  type SubtaskArtifactLeaseIdentity,
} from '../services/harness-execution-context.js';
import {
  claimSubtaskArtifactLease,
  yieldSubtaskArtifactLease,
} from '../services/subtask-artifact-fence.js';

const HOSTS = ['localhost:27019', 'localhost:27020', 'localhost:27021'];
const URI = process.env.F8_RS3_URI ?? `mongodb://${HOSTS.join(',')}/?replicaSet=rs3f8`;
const DB = `f8_j2_artifact_${Date.now()}`;
const CHAOS = 'scripts/f8-mongo-chaos.sh';

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

function chaos(...args: string[]): void {
  execFileSync('bash', [CHAOS, ...args], { stdio: 'inherit', timeout: 120_000 });
}

function routedDbUri(): string {
  return `mongodb://${HOSTS.join(',')}/${DB}?replicaSet=rs3f8`;
}

function pinnedDbUri(host: string): string {
  return `mongodb://${host}/${DB}?directConnection=true`;
}

function portOf(host: string): string {
  return host.split(':')[1]!;
}

async function currentPrimary(): Promise<string> {
  const probe = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000 });
  try {
    await probe.connect();
    const status = await probe.db('admin').command({ replSetGetStatus: 1 }) as {
      members: Array<{ name: string; stateStr: string }>;
    };
    const primary = status.members.find((member) => member.stateStr === 'PRIMARY');
    assert.ok(primary, 'rs3f8 has no primary');
    return primary!.name;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

async function useAppUri(uri: string): Promise<Db> {
  await closeDb();
  process.env.MONGODB_URI = uri;
  return getDb();
}

async function freshArtifact(db: Db, name: string): Promise<string> {
  const taskId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await db.collection('code_task_artifacts').insertOne({
    taskId,
    status: 'editing',
    agentId: 'codingAgent',
    userRequest: 'J2 step 6 fencing probe',
    plan: [],
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    approvalsRequested: [],
    diffSummary: '',
    rollbackAvailable: false,
    createdAt: now,
    updatedAt: now,
  });
  return taskId;
}

let updateTool: { execute: (input: unknown) => Promise<unknown> };
async function updateAs(
  lease: SubtaskArtifactLeaseIdentity,
  plan: string[],
): Promise<{ success: boolean; message: string }> {
  const result = await runWithHarnessExecutionContext({
    taskId: lease.taskId,
    subtaskId: lease.subtaskId,
    artifactLease: lease,
  }, () => updateTool.execute({ taskId: lease.taskId, plan }));
  return result as { success: boolean; message: string };
}

console.log('f8:subtask-artifact-fencing');

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000 });
await client.connect();
const db = client.db(DB);
process.env.MONGODB_URI = routedDbUri();
updateTool = (await import('../tools/dev/code-task-artifacts.js')).updateCodeTaskArtifactTool as any;

try {
  await check('preflight — an unexpired owner cannot be taken over', async () => {
    const taskId = await freshArtifact(db, 'held');
    const first = await claimSubtaskArtifactLease(db, {
      taskId,
      subtaskId: 'subtask-held',
      ownerId: 'owner-held-A',
      leaseTtlMs: 60_000,
    });
    assert.ok(first, 'first owner must claim the empty slot');
    const second = await claimSubtaskArtifactLease(db, {
      taskId,
      subtaskId: 'subtask-held',
      ownerId: 'owner-held-B',
      leaseTtlMs: 60_000,
    });
    assert.equal(second, null, 'a rival stole an unexpired lease');
  });

  await check('preflight — the real tool refuses a stale fence after takeover', async () => {
    const taskId = await freshArtifact(db, 'stale');
    const stale = await claimSubtaskArtifactLease(db, {
      taskId,
      subtaskId: 'subtask-stale',
      ownerId: 'owner-stale-A',
      leaseTtlMs: 60_000,
    });
    assert.ok(stale);
    assert.equal(await yieldSubtaskArtifactLease(db, stale!), true);
    const fresh = await claimSubtaskArtifactLease(db, {
      taskId,
      subtaskId: 'subtask-stale',
      ownerId: 'owner-stale-B',
      leaseTtlMs: 60_000,
    });
    assert.ok(fresh);
    assert.ok(fresh!.fence > stale!.fence, 'takeover did not advance the fence');

    await useAppUri(routedDbUri());
    const staleResult = await updateAs(stale!, ['stale-owner']);
    assert.equal(staleResult.success, false, 'the stale production tool call reported success');
    assert.match(staleResult.message, /stale fence|lost artifact ownership/i);
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
    assert.deepEqual(artifact?.plan, [], 'the stale report-list update landed');
  });

  await check('the real coding harness carries the stale identity into Mastra tool dispatch', async () => {
    const taskId = await freshArtifact(db, 'harness-stale');
    const stale = await claimSubtaskArtifactLease(db, {
      taskId,
      subtaskId: 'subtask-harness-stale',
      ownerId: 'owner-harness-A',
      leaseTtlMs: 60_000,
    });
    assert.ok(stale);
    assert.equal(await yieldSubtaskArtifactLease(db, stale!), true);
    const fresh = await claimSubtaskArtifactLease(db, {
      taskId,
      subtaskId: stale!.subtaskId,
      ownerId: 'owner-harness-B',
      leaseTtlMs: 60_000,
    });
    assert.ok(fresh);

    await useAppUri(routedDbUri());
    const [{ generateCoding }, { Agent }, { MockLanguageModelV3 }] = await Promise.all([
      import('../services/coding-harness.js'),
      import('@mastra/core/agent'),
      import('ai/test'),
    ]);
    let modelStep = 0;
    const model = new MockLanguageModelV3({
      modelId: 'mock-j2-stale-harness',
      doGenerate: (async () => {
        modelStep += 1;
        if (modelStep === 1) {
          return {
            content: [{
              type: 'tool-call' as const,
              toolCallId: 'stale-artifact-update',
              toolName: 'coding_update_artifact',
              input: JSON.stringify({
                taskId,
                plan: ['harness-stale'],
              }),
            }],
            finishReason: 'tool-calls' as const,
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
            warnings: [],
          };
        }
        return {
          content: [{ type: 'text' as const, text: 'The scripted update was attempted.' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          warnings: [],
        };
      }) as any,
    });
    const agent = new Agent({
      id: 'j2-stale-fence-agent',
      name: 'j2-stale-fence-agent',
      instructions: 'Execute the scripted artifact update.',
      model: model as any,
      tools: { coding_update_artifact: updateTool as any },
    });

    await generateCoding({
      agent,
      agentId: 'codingAgent',
      prompt: 'Attempt the stale artifact update.',
      taskId,
      subtaskId: stale!.subtaskId,
      threadId: `${taskId}::${stale!.subtaskId}`,
      artifactLease: stale!,
      phase: 'subtask',
      timeoutMs: 30_000,
      generateOptions: { activeTools: ['coding_update_artifact'] },
      contextPolicy: {
        includeMemory: false,
        includeSkills: false,
        includeRepoMap: false,
        includeCheckpoint: false,
        maxTokens: 256,
      },
    });

    assert.ok(modelStep >= 2, 'Mastra did not execute the scripted tool step');
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
    assert.deepEqual(
      artifact?.plan,
      [],
      'generateCoding dropped the stale lease before the real artifact tool ran',
    );
  });

  // Expire during a real outage, but do not replace: the same identity remains
  // valid. This is the liveness half a fence implementation can easily break.
  await check('ARM 1 — expiry plus a short partition, without takeover, still finishes', async () => {
    const node = await currentPrimary();
    const appDb = await useAppUri(pinnedDbUri(node));
    const taskId = await freshArtifact(db, 'survivor');
    const lease = await claimSubtaskArtifactLease(appDb, {
      taskId,
      subtaskId: 'subtask-survivor',
      ownerId: 'owner-survivor',
      leaseTtlMs: 3_000,
    });
    assert.ok(lease, 'the pinned worker must claim before the partition');

    chaos('partition', portOf(node), '6');

    const result = await updateAs(lease!, ['survivor']);
    assert.equal(
      result.success,
      true,
      `an expired owner nobody replaced was discarded: ${result.message}`,
    );
    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
    assert.deepEqual(artifact?.plan, ['survivor']);
    const stored = artifact?.subtaskLeases?.[lease!.leaseKey];
    assert.equal(stored?.ownerId, lease!.ownerId);
    assert.equal(stored?.fence, lease!.fence, 'the short outage invented a takeover');
  });

  // A long partition must elect another primary. Once B claims there, A's old
  // owner/fence pair no longer matches the artifact mutation predicate.
  await check('ARM 2 — real election and takeover fence out the old subtask', async () => {
    const oldPrimary = await currentPrimary();
    const appDb = await useAppUri(pinnedDbUri(oldPrimary));
    const taskId = await freshArtifact(db, 'takeover');
    const stale = await claimSubtaskArtifactLease(appDb, {
      taskId,
      subtaskId: 'subtask-takeover',
      ownerId: 'owner-takeover-A',
      leaseTtlMs: 5_000,
    });
    assert.ok(stale, 'owner A must claim before the partition');
    console.log(`  owner A fence=${stale!.fence}, pinned=${oldPrimary}`);

    chaos('partition', portOf(oldPrimary), '25');

    const elected = await currentPrimary();
    assert.notEqual(
      elected,
      oldPrimary,
      'the long partition did not elect a different primary, so the takeover proves nothing',
    );
    const routedDb = await useAppUri(routedDbUri());
    const fresh = await claimSubtaskArtifactLease(routedDb, {
      taskId,
      subtaskId: stale!.subtaskId,
      ownerId: 'owner-takeover-B',
      leaseTtlMs: 60_000,
    });
    assert.ok(fresh, 'owner B could not claim the expired slot after election');
    assert.ok(fresh!.fence > stale!.fence, 'owner B did not advance the fence');

    const freshResult = await updateAs(fresh!, ['takeover-B']);
    assert.equal(freshResult.success, true, `owner B could not update: ${freshResult.message}`);
    const staleResult = await updateAs(stale!, ['stale-A']);
    assert.equal(staleResult.success, false, 'owner A updated after owner B advanced the fence');
    assert.match(staleResult.message, /stale fence|lost artifact ownership/i);

    const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
    assert.deepEqual(
      artifact?.plan,
      ['takeover-B'],
      'exactly the takeover owner marker must remain in plan',
    );
    console.log(`  owner A fence=${stale!.fence} refused; owner B fence=${fresh!.fence} committed`);
  });

  await check('the lease identity reaches the real harness and every subtask artifact writer', () => {
    const executor = readFileSync('src/mastra/services/subtask-executor.ts', 'utf8');
    assert.match(executor, /claimSubtaskArtifactLease\(/);
    assert.match(executor, /artifactLease,/);
    assert.match(executor, /yieldSubtaskArtifactLease\(/);

    const harness = readFileSync('src/mastra/services/generate-with-harness.ts', 'utf8');
    assert.match(harness, /artifactLease:\s*input\.artifactLease/);

    const artifactTools = readFileSync('src/mastra/tools/dev/code-task-artifacts.ts', 'utf8');
    assert.match(artifactTools, /findOneAndUpdate\(\s*subtaskArtifactMutationFilter\(context\.taskId\)/);
    assert.match(artifactTools, /append test result/);

    const ledger = readFileSync('src/mastra/tools/dev/code-change-ledger.ts', 'utf8');
    assert.match(ledger, /const mutationFilter = subtaskArtifactMutationFilter\(snapshot\.taskId\)/);
    assert.match(ledger, /append tracked-write filesRead/);
    assert.match(ledger, /append file change/);
  });
} catch (error) {
  failures += 1;
  console.error(`\n  UNCAUGHT: ${(error as Error).message}`);
} finally {
  try { chaos('heal'); } catch { /* the chaos script reports recovery details */ }
  await closeDb().catch(() => undefined);
  await db.dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
}

if (failures > 0) {
  console.error(`\nFAILED: f8:subtask-artifact-fencing — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nPASSED: an unopposed subtask finishes; a superseded subtask cannot append');
process.exit(0);
