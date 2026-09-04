#!/usr/bin/env tsx
/**
 * check:subtask-file-attribution — a parallel group's file changes must all
 * survive, and each must say which subtask made it (J2 step 1).
 *
 * WHY THIS IS A GATE AND NOT A CODE REVIEW NOTE
 * ----------------------------------------------
 * `parallel-dispatch.ts:169` runs the subtasks of one group through
 * `Promise.allSettled` — this is not a future plan, it is what the self-healing
 * loop does on production today (`repo-maintenance.ts:180`, PATH A). Every one
 * of those subtasks records its file writes through
 * `upsertArtifactFileChange` in `code-change-ledger.ts`.
 *
 * That function used to `findOne` the artifact, rebuild `filesChanged` in
 * memory, and `$set` THE WHOLE ARRAY back — a textbook lost update. Measured
 * 2026-08-23 against the rs3f8 set with a verbatim copy of the old body:
 *
 *     concurrent writers: 8
 *     entries surviving in artifact.filesChanged: 1
 *     LOST: 7                                          (3/3 runs)
 *
 * Eight subtasks writing eight DIFFERENT files, and the artifact remembered
 * one. That array is not decoration: `collectSubtaskResult` reads it to decide
 * `no_files_changed` / `target_files_missed`, which drives retry and escalation
 * onto the expensive pinned repair model, and `aggregateResults` reads it to
 * report conflicting files. A near-empty record makes good work look failed.
 *
 * The second half is attribution. The write tool ALREADY knows the subtask —
 * it passes `context.subtaskId` to `recordFileActivity` a few lines below, so
 * the `file_activity` ledger has always had it. `artifact.filesChanged` was the
 * one place that dropped it, which is why `collectSubtaskResult(taskId,
 * subtaskId)` could only ever return the whole task's changes and had its
 * `subtaskId` parameter sitting unused.
 *
 * THE RULE: concurrent writers to distinct paths all survive, a rewrite of the
 * same path replaces rather than duplicates, and an entry written on behalf of
 * a subtask carries that subtask's id.
 *
 * WHY A REAL MONGO AND NOT A FAKE
 * -------------------------------
 * The claim is "these two writers do not clobber each other", which is a claim
 * about MongoDB's update operators. A fake would be asserting my own model of
 * `$pull`/`$push` — exactly the mistake that kept `findArtifactIds` green while
 * it never worked. This talks to a real server and interleaves real writers.
 *
 * Uses the F8 three-node set (rs3f8, ports 27019-27021) when it is up, so the
 * concurrency is exercised against the same topology J2 will eventually need;
 * falls back to whatever `MONGODB_URI` points at. It writes ONLY to its own
 * throwaway database (`j2_check_<timestamp>`) and drops it at the end — never
 * `agentforge`, never a collection anything else reads.
 *
 * Run: npx tsx src/mastra/scripts/check-subtask-file-attribution.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:subtask-file-attribution');

const RS3_URI = 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const FALLBACK_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0';

/** Prefer the F8 topology; fall back so the gate still runs without it. */
async function connect(): Promise<{ client: MongoClient; label: string; uri: string }> {
  try {
    const client = new MongoClient(RS3_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { client, label: 'rs3f8 (three-node F8 set)', uri: RS3_URI };
  } catch {
    const client = new MongoClient(FALLBACK_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    return { client, label: 'MONGODB_URI fallback (single node)', uri: FALLBACK_URI };
  }
}

/** Point production imports at this gate's throwaway database, never agentforge. */
function uriForDatabase(uri: string, database: string): string {
  const queryAt = uri.indexOf('?');
  const base = queryAt >= 0 ? uri.slice(0, queryAt) : uri;
  const query = queryAt >= 0 ? uri.slice(queryAt) : '';
  const authorityStart = base.indexOf('://') + 3;
  const pathAt = base.indexOf('/', authorityStart);
  const authority = pathAt >= 0 ? base.slice(0, pathAt) : base;
  return `${authority}/${database}${query}`;
}

/**
 * The production write path, reduced to the artifact-array handling that
 * `upsertArtifactFileChange` performs. Kept in lockstep with
 * `code-change-ledger.ts` deliberately: this asserts the OPERATORS behave,
 * which is what the fix relies on.
 */
async function recordChange(
  db: Db,
  taskId: string,
  path: string,
  summary: string,
  subtaskId?: string,
): Promise<void> {
  const artifacts = db.collection('code_task_artifacts');
  const pulled = await artifacts.updateOne(
    { taskId },
    { $pull: { filesChanged: { path } } as never },
  );
  if (pulled.matchedCount === 0) return;
  await artifacts.updateOne(
    { taskId },
    {
      $push: {
        filesChanged: { path, beforeHash: 'b', afterHash: 'a', summary, ...(subtaskId ? { subtaskId } : {}) },
      } as never,
      $set: { rollbackAvailable: true, updatedAt: new Date().toISOString() },
    },
  );
}

/** The OLD body, verbatim — kept so the gate can prove it still fails. */
async function recordChangeLegacy(db: Db, taskId: string, path: string, summary: string): Promise<void> {
  const artifacts = db.collection('code_task_artifacts');
  const artifact = await artifacts.findOne({ taskId });
  if (!artifact) return;
  const filesChanged = Array.isArray(artifact.filesChanged) ? artifact.filesChanged : [];
  const nextFilesChanged = [
    ...filesChanged.filter((entry: { path?: string }) => entry?.path !== path),
    { path, beforeHash: 'b', afterHash: 'a', summary },
  ];
  await artifacts.updateOne({ taskId }, { $set: { filesChanged: nextFilesChanged } });
}

type Entry = { path: string; subtaskId?: string; summary: string };
async function readEntries(db: Db, taskId: string): Promise<Entry[]> {
  const doc = await db.collection('code_task_artifacts').findOne({ taskId });
  return (doc?.filesChanged ?? []) as Entry[];
}

async function freshTask(db: Db, name: string): Promise<string> {
  const taskId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.collection('code_task_artifacts').insertOne({ taskId, filesChanged: [] });
  return taskId;
}

const { client, label, uri } = await connect();
console.log(`  · connected to ${label}`);
const dbName = `j2_check_${Date.now()}`;
const db = client.db(dbName);
// `getDb()` is a singleton resolved on first use. Set the URI before importing
// the real harness/tool modules so their writes land in the same disposable DB.
process.env.MONGODB_URI = uriForDatabase(uri, dbName);
// The ledger is feature-gated in production; turn it on here because step 2a
// promises the run-owned subtask reaches every write-side attribution sink.
process.env.FEATURE_FILE_ACTIVITY_LEDGER = 'true';

const N = 8;

// ── 1. Falsification: the OLD implementation must still lose writes ──────────
// Without this the gate could pass for the wrong reason — e.g. if the writers
// never actually overlapped, both implementations would look fine.
await check(`the old read-modify-write really does lose concurrent writes (${N} writers)`, async () => {
  const taskId = await freshTask(db, 'legacy');
  await Promise.all(
    Array.from({ length: N }, (_, i) => recordChangeLegacy(db, taskId, `src/legacy-${i}.ts`, `sub-${i}`)),
  );
  const entries = await readEntries(db, taskId);
  assert.ok(
    entries.length < N,
    `expected the legacy path to lose entries, but all ${N} survived — the writers did not overlap, so this run proves nothing`,
  );
});

// ── 2. The fix: every concurrent writer to a distinct path survives ──────────
await check(`all ${N} concurrent writers to distinct paths survive`, async () => {
  const taskId = await freshTask(db, 'concurrent');
  await Promise.all(
    Array.from({ length: N }, (_, i) => recordChange(db, taskId, `src/file-${i}.ts`, `sub-${i}`, `subtask-${i}`)),
  );
  const entries = await readEntries(db, taskId);
  assert.equal(entries.length, N, `expected ${N} entries, got ${entries.length}`);
  const paths = new Set(entries.map((e) => e.path));
  assert.equal(paths.size, N, 'every path should appear exactly once');
});

// ── 3. Attribution: each entry names the subtask that wrote it ───────────────
await check('each entry carries the subtaskId of the subtask that wrote it', async () => {
  const taskId = await freshTask(db, 'attribution');
  await Promise.all(
    Array.from({ length: N }, (_, i) => recordChange(db, taskId, `src/file-${i}.ts`, `sub-${i}`, `subtask-${i}`)),
  );
  const entries = await readEntries(db, taskId);
  for (const entry of entries) {
    const index = entry.path.match(/file-(\d+)\.ts$/)?.[1];
    assert.ok(index !== undefined, `unexpected path ${entry.path}`);
    assert.equal(
      entry.subtaskId,
      `subtask-${index}`,
      `${entry.path} attributed to ${entry.subtaskId ?? '(none)'}, expected subtask-${index}`,
    );
  }
});

// ── 4. Filtering by subtaskId gives a subtask ONLY its own work ──────────────
// This is what `collectSubtaskResult` must be able to do (J2 step 2). Asserted
// on the stored shape now, so step 2 is wiring rather than a schema change.
await check('filtering by subtaskId returns only that subtask\'s files', async () => {
  const taskId = await freshTask(db, 'filter');
  await Promise.all([
    recordChange(db, taskId, 'src/a.ts', 'a', 'subtask-A'),
    recordChange(db, taskId, 'src/b.ts', 'b', 'subtask-B'),
    recordChange(db, taskId, 'src/c.ts', 'c', 'subtask-A'),
  ]);
  const entries = await readEntries(db, taskId);
  const forA = entries.filter((e) => e.subtaskId === 'subtask-A').map((e) => e.path).sort();
  const forB = entries.filter((e) => e.subtaskId === 'subtask-B').map((e) => e.path).sort();
  assert.deepEqual(forA, ['src/a.ts', 'src/c.ts']);
  assert.deepEqual(forB, ['src/b.ts']);
});

// ── 5. Run-owned attribution: the model may omit subtaskId ───────────────────
// This is J2 step 2a's load-bearing path. Only the external model is scripted;
// Agent, generateCoding, Mastra's tool dispatch/schema validation, the harness
// AsyncLocalStorage, coding_write_file_tracked, filesystem and MongoDB are the
// real implementations. Before step 2a the tools succeed but one entry has no
// subtaskId and the other trusts a wrong one supplied by the model.
const harnessWorktree = await mkdtemp(join(tmpdir(), 'j2-2a-attribution-'));
await check('a real tool call with no subtaskId inherits it from the harness run', async () => {
  const taskId = await freshTask(db, 'harness-attribution');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    { $set: { worktreePath: harnessWorktree, updatedAt: new Date().toISOString() } },
  );

  const [{ generateCoding }, { writeFileTrackedTool }, { Agent }, { MockLanguageModelV3 }] = await Promise.all([
    import('../services/coding-harness.js'),
    import('../tools/dev/code-change-ledger.js'),
    import('@mastra/core/agent'),
    import('ai/test'),
  ]);
  const calls = [
    {
      path: 'probe-omitted.txt',
      content: 'the model omitted subtaskId\n',
      summary: 'J2 step 2a omitted attribution probe',
    },
    {
      path: 'probe-wrong.txt',
      content: 'the model supplied the wrong subtaskId\n',
      summary: 'J2 step 2a wrong attribution probe',
      subtaskId: 'model-invented-subtask',
    },
  ];
  assert.ok(calls.every((call) => !('taskId' in call)), 'the model fixture must not know the task id');
  assert.ok(!('subtaskId' in calls[0]!), 'the load-bearing call must omit subtaskId entirely');

  let modelStep = 0;
  const model = new MockLanguageModelV3({
    modelId: 'mock-j2-subtask-attribution',
    doGenerate: (async (options: any) => {
      const offered = Array.isArray(options.tools)
        ? options.tools.map((tool: { name?: string }) => tool.name)
        : [];
      assert.ok(
        offered.includes('coding_write_file_tracked'),
        `the production gateway did not offer the tracked writer: ${offered.join(', ')}`,
      );
      const current = calls[modelStep];
      modelStep += 1;
      if (current) {
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: `j2-write-${modelStep}`,
            toolName: 'coding_write_file_tracked',
            input: JSON.stringify(current),
          }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text' as const, text: 'Completed both tracked writes.' }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    }) as any,
  });
  const agent = new Agent({
    id: 'j2-subtask-attribution-agent',
    name: 'j2-subtask-attribution-agent',
    instructions: 'Execute the scripted tracked writes.',
    model: model as any,
    tools: { coding_write_file_tracked: writeFileTrackedTool },
  });

  await generateCoding({
    agent,
    agentId: 'codingAgent',
    prompt: 'Execute both attribution probes.',
    taskId,
    subtaskId: 'subtask-from-harness',
    phase: 'subtask',
    timeoutMs: 30_000,
    generateOptions: { activeTools: ['coding_write_file_tracked'] },
  });

  assert.ok(modelStep >= 3, `Mastra did not complete both tool steps (model steps: ${modelStep})`);
  assert.equal(await readFile(join(harnessWorktree, calls[0]!.path), 'utf8'), calls[0]!.content);
  assert.equal(await readFile(join(harnessWorktree, calls[1]!.path), 'utf8'), calls[1]!.content);

  const entries = (await readEntries(db, taskId)).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(entries.length, 2, `expected two real tool entries, got ${entries.length}`);
  for (const entry of entries) {
    assert.equal(
      entry.subtaskId,
      'subtask-from-harness',
      `${entry.path}: the run knew the subtask, but the tool body trusted or required the model argument`,
    );
  }

  const activity = await db.collection('file_activity').find({ taskId, op: 'write' }).toArray();
  assert.equal(activity.length, 2, `expected two real file-activity entries, got ${activity.length}`);
  assert.ok(
    activity.every((entry) => entry.subtaskId === 'subtask-from-harness'),
    'file_activity must receive the same run-owned attribution as the artifact',
  );
  const executions = await db.collection('tool_executions')
    .find({ taskId, toolId: 'coding_write_file_tracked' })
    .toArray();
  assert.equal(executions.length, 2, `expected two real tool executions, got ${executions.length}`);
  assert.ok(
    executions.every((entry) => entry.status === 'completed' && entry.subtaskId === 'subtask-from-harness'),
    'the harness must know the subtask and both real tool executions must complete',
  );
});

await check('the model argument is only a fallback when no harness run exists', async () => {
  const [{ resolveCodingSubtaskId }, { runWithHarnessExecutionContext }] = await Promise.all([
    import('../tools/dev/coding-task-scope.js'),
    import('../services/harness-execution-context.js'),
  ]);
  assert.equal(resolveCodingSubtaskId('direct-tool-subtask'), 'direct-tool-subtask');
  assert.equal(resolveCodingSubtaskId(), undefined);
  await runWithHarnessExecutionContext({ subtaskId: 'run-subtask' }, async () => {
    assert.equal(resolveCodingSubtaskId(), 'run-subtask', 'omission must inherit from the run');
    assert.equal(
      resolveCodingSubtaskId('model-invented-subtask'),
      'run-subtask',
      'a model argument must never override the run',
    );
  });
});

// Commands are attribution-sensitive for the same reason as files: one
// subtask's failed compiler run must not make a clean neighbour retry on the
// pinned repair model. This follows a real model tool call all the way through
// Mastra and the harness instead of calling the normalizer in isolation.
await check('a real coding_run_test call stores the subtask owned by the harness run', async () => {
  const taskId = await freshTask(db, 'harness-command-attribution');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    { $set: { worktreePath: harnessWorktree, updatedAt: new Date().toISOString() } },
  );

  const [{ generateCoding }, { runTestCommandTool }, { Agent }, { MockLanguageModelV3 }] = await Promise.all([
    import('../services/coding-harness.js'),
    import('../tools/dev/code-task-artifacts.js'),
    import('@mastra/core/agent'),
    import('ai/test'),
  ]);
  const calls = [
    {
      command: 'pwd',
      summary: 'J2 command attribution probe with omitted subtask id',
    },
    {
      command: 'pwd',
      summary: 'J2 command attribution probe with wrong subtask id',
      subtaskId: 'model-invented-subtask',
    },
  ];
  assert.ok(calls.every((call) => !('taskId' in call)), 'the model fixture must not know the task id');
  assert.ok(!('subtaskId' in calls[0]!), 'the load-bearing command call must omit subtaskId entirely');

  let modelStep = 0;
  const model = new MockLanguageModelV3({
    modelId: 'mock-j2-command-attribution',
    doGenerate: (async (options: any) => {
      const offered = Array.isArray(options.tools)
        ? options.tools.map((tool: { name?: string }) => tool.name)
        : [];
      assert.ok(
        offered.includes('coding_run_test'),
        `the production gateway did not offer coding_run_test: ${offered.join(', ')}`,
      );
      const current = calls[modelStep];
      modelStep += 1;
      if (current) {
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: `j2-command-${modelStep}`,
            toolName: 'coding_run_test',
            input: JSON.stringify(current),
          }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text' as const, text: 'Completed both command attribution probes.' }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    }) as any,
  });
  const agent = new Agent({
    id: 'j2-command-attribution-agent',
    name: 'j2-command-attribution-agent',
    instructions: 'Execute the scripted verification commands.',
    model: model as any,
    tools: { coding_run_test: runTestCommandTool },
  });

  await generateCoding({
    agent,
    agentId: 'codingAgent',
    prompt: 'Execute both command attribution probes.',
    taskId,
    subtaskId: 'subtask-from-harness',
    phase: 'subtask',
    timeoutMs: 30_000,
    generateOptions: { activeTools: ['coding_run_test'] },
  });

  assert.ok(modelStep >= 3, `Mastra did not complete both command steps (model steps: ${modelStep})`);
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  assert.equal(artifact?.commandsRun?.length, 2, `expected two command entries, got ${artifact?.commandsRun?.length ?? 0}`);
  assert.ok(
    artifact?.commandsRun?.every((entry: { subtaskId?: string }) => entry.subtaskId === 'subtask-from-harness'),
    'commandsRun trusted an omitted or invented model argument instead of the harness run',
  );

  const activity = await db.collection('file_activity').find({ taskId, op: 'test' }).toArray();
  assert.equal(activity.length, 2, `expected two real command activity entries, got ${activity.length}`);
  assert.ok(
    activity.every((entry) => entry.subtaskId === 'subtask-from-harness'),
    'file_activity must receive the same run-owned command attribution as the artifact',
  );
  const executions = await db.collection('tool_executions')
    .find({ taskId, toolId: 'coding_run_test' })
    .toArray();
  assert.equal(executions.length, 2, `expected two real command tool executions, got ${executions.length}`);
  assert.ok(
    executions.every((entry) => entry.status === 'completed' && entry.subtaskId === 'subtask-from-harness'),
    'the harness must attribute both completed command tool executions',
  );
});

// ── 6. Rewriting the same path replaces, never duplicates ───────────────────
// The old code got this right via its in-memory filter; `$pull` before `$push`
// must keep the same guarantee, or a subtask editing one file twice would
// double-count it in the conflict detector.
await check('rewriting the same path replaces the entry instead of duplicating it', async () => {
  const taskId = await freshTask(db, 'rewrite');
  await recordChange(db, taskId, 'src/same.ts', 'first', 'subtask-A');
  await recordChange(db, taskId, 'src/same.ts', 'second', 'subtask-A');
  const entries = await readEntries(db, taskId);
  assert.equal(entries.length, 1, `expected 1 entry, got ${entries.length}`);
  assert.equal(entries[0].summary, 'second', 'the later write should win');
});

// ── 7. A missing artifact is still a no-op ──────────────────────────────────
// The old body returned early on `!artifact`. `matchedCount` replaces that
// check; if it were wrong, an upsert would fabricate artifacts for unknown tasks.
await check('a write for an unknown task creates nothing', async () => {
  await recordChange(db, 'task-that-does-not-exist', 'src/x.ts', 'x', 'subtask-A');
  const doc = await db.collection('code_task_artifacts').findOne({ taskId: 'task-that-does-not-exist' });
  assert.equal(doc, null, 'no artifact should have been created');
});

// ── 8. Single-agent writes stay unattributed, not mislabelled ───────────────
await check('a write with no subtask records no subtaskId', async () => {
  const taskId = await freshTask(db, 'solo');
  await recordChange(db, taskId, 'src/solo.ts', 'solo');
  const entries = await readEntries(db, taskId);
  assert.equal(entries.length, 1);
  assert.ok(!('subtaskId' in entries[0]), 'subtaskId should be absent, not null or empty');
});

// ── 9. The wiring itself: the REAL function must use these operators ────────
// The reduced-write checks exercise a copy of `upsertArtifactFileChange`, because the
// real one is module-private and binds `getDb()` to the production connection.
// That copy proves the OPERATORS behave; it cannot notice if production drifts
// back to a read-modify-write. This section reads the actual source so the two
// cannot silently disagree — the same "the wiring itself" section
// `check-subagent-roles-enforced.ts` uses for the same reason.
const ledgerSource = readFileSync('src/mastra/tools/dev/code-change-ledger.ts', 'utf8');
const upsertBody = ledgerSource.slice(
  ledgerSource.indexOf('async function upsertArtifactFileChange'),
  ledgerSource.indexOf('async function rejectSnapshot'),
);

await check('upsertArtifactFileChange exists and was located in the source', () => {
  assert.ok(upsertBody.length > 0, 'could not locate upsertArtifactFileChange — did it get renamed?');
});

await check('the real writer uses $pull/$push, not a whole-array $set', () => {
  assert.match(upsertBody, /\$pull:\s*\{\s*filesChanged/, 'expected a $pull scoped to filesChanged');
  assert.match(upsertBody, /\$push:\s*\{\s*[\s\S]*?filesChanged/, 'expected a $push onto filesChanged');
  assert.ok(
    !/\$set:\s*\{[\s\S]*?\bfilesChanged\s*:/.test(upsertBody),
    'filesChanged is being $set wholesale again — that is the lost update this gate exists to prevent',
  );
});

await check('the real writer accepts and stores subtaskId', () => {
  assert.match(upsertBody, /subtaskId\?:\s*string/, 'expected an optional subtaskId parameter');
  assert.match(upsertBody, /subtaskId\s*\?\s*\{\s*subtaskId\s*\}/, 'expected subtaskId to be written onto the entry');
});

await check('both call sites pass their subtaskId through', () => {
  const callSites = ledgerSource.match(/await upsertArtifactFileChange\([^)]*\)/g) ?? [];
  assert.equal(callSites.length, 2, `expected 2 call sites, found ${callSites.length}`);
  for (const site of callSites) {
    assert.match(site, /context\.subtaskId/, `call site drops attribution: ${site}`);
  }
});

await check('both artifact-writing tools normalize scope before policy and execution', () => {
  for (const toolId of ['coding_record_after_change', 'coding_write_file_tracked']) {
    const start = ledgerSource.indexOf(`id: '${toolId}'`);
    assert.ok(start >= 0, `could not locate ${toolId}`);
    const next = ledgerSource.indexOf('\nexport const ', start);
    const body = ledgerSource.slice(start, next >= 0 ? next : ledgerSource.length);
    assert.match(
      body,
      /normalizeInput:\s*normalizeCodingScope/,
      `${toolId} bypasses the run-owned scope normalizer`,
    );
  }
});

await check('executeSubtask passes subtaskId into the harness, which publishes it to tools', () => {
  const executorSource = readFileSync('src/mastra/services/subtask-executor.ts', 'utf8');
  const generateAt = executorSource.indexOf('const harnessResult = await generateCoding({');
  const generateCall = executorSource.slice(generateAt, executorSource.indexOf('\n    });', generateAt));
  assert.ok(generateAt >= 0, 'could not locate executeSubtask -> generateCoding');
  assert.match(
    generateCall,
    /subtaskId:\s*subtask\.id/,
    'executeSubtask knows the subtask but does not pass it to generateCoding',
  );

  const harnessSource = readFileSync('src/mastra/services/generate-with-harness.ts', 'utf8');
  const contextAt = harnessSource.indexOf('return runWithHarnessExecutionContext(');
  const contextCall = harnessSource.slice(contextAt, harnessSource.indexOf('async () => {', contextAt));
  assert.ok(contextAt >= 0, 'could not locate the harness execution-context boundary');
  assert.match(
    contextCall,
    /subtaskId:\s*input\.subtaskId/,
    'generateWithHarness does not publish its subtaskId to tool execution',
  );
});

// ── 10. The real consumer: each subtask sees only its own work ───────────────
await check('the real reader isolates two subtasks and the real aggregate reports no conflicts', async () => {
  const [{ collectSubtaskResult }, { aggregateResults }] = await Promise.all([
    import('../services/subtask-executor.js'),
    import('../services/parallel-dispatch.js'),
  ]);
  const taskId = await freshTask(db, 'reader-isolation');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        filesChanged: [
          { path: 'src/a.ts', beforeHash: 'b', afterHash: 'a', summary: 'A1', subtaskId: 'subtask-A' },
          { path: 'src/b.ts', beforeHash: 'b', afterHash: 'a', summary: 'B1', subtaskId: 'subtask-B' },
          { path: 'src/c.ts', beforeHash: 'b', afterHash: 'a', summary: 'A2', subtaskId: 'subtask-A' },
        ],
        commandsRun: [],
      },
    },
  );

  const [forA, forB] = await Promise.all([
    collectSubtaskResult(taskId, 'subtask-A'),
    collectSubtaskResult(taskId, 'subtask-B'),
  ]);
  assert.deepEqual(forA.filesChanged.map((entry) => entry.path).sort(), ['src/a.ts', 'src/c.ts']);
  assert.deepEqual(forB.filesChanged.map((entry) => entry.path), ['src/b.ts']);

  const asResult = (subtaskId: string, collected: typeof forA) => ({
    subtaskId,
    status: 'success' as const,
    assignedModel: 'gate-model',
    filesChanged: collected.filesChanged,
    commandsRun: collected.commandsRun,
    diagnostics: 'Real reader result',
    errors: collected.errors,
    durationMs: 1,
  });
  const aggregated = aggregateResults([{
    groupIndex: 0,
    subtaskResults: [asResult('subtask-A', forA), asResult('subtask-B', forB)],
    groupStatus: 'success',
    durationMs: 2,
  }]);
  assert.deepEqual(
    aggregated.conflictingFiles,
    [],
    `isolated files cannot conflict, got: ${aggregated.conflictingFiles.join(', ')}`,
  );
});

await check('an all-legacy artifact falls back to today\'s behavior and warns with taskId', async () => {
  const { collectSubtaskResult } = await import('../services/subtask-executor.js');
  const taskId = await freshTask(db, 'reader-legacy');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        filesChanged: [
          { path: 'src/legacy-a.ts', beforeHash: 'b', afterHash: 'a', summary: 'old A' },
          { path: 'src/legacy-b.ts', beforeHash: 'b', afterHash: 'a', summary: 'old B' },
        ],
        commandsRun: [],
      },
    },
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  let collected: Awaited<ReturnType<typeof collectSubtaskResult>>;
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    collected = await collectSubtaskResult(taskId, 'subtask-A');
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(
    collected.filesChanged.map((entry) => entry.path).sort(),
    ['src/legacy-a.ts', 'src/legacy-b.ts'],
    'the safety valve must preserve today\'s task-wide result for wholly legacy data',
  );
  assert.ok(
    warnings.some((warning) => warning.includes(taskId)),
    `the safety valve must be loud and name ${taskId}; warnings=${JSON.stringify(warnings)}`,
  );
});

await check('mixed data does not trigger the legacy valve; unattributed entries belong to nobody', async () => {
  const { collectSubtaskResult } = await import('../services/subtask-executor.js');
  const taskId = await freshTask(db, 'reader-mixed');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        filesChanged: [
          { path: 'src/a.ts', beforeHash: 'b', afterHash: 'a', summary: 'A', subtaskId: 'subtask-A' },
          { path: 'src/legacy.ts', beforeHash: 'b', afterHash: 'a', summary: 'legacy' },
          { path: 'src/b.ts', beforeHash: 'b', afterHash: 'a', summary: 'B', subtaskId: 'subtask-B' },
        ],
        commandsRun: [],
      },
    },
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  let collected: Awaited<ReturnType<typeof collectSubtaskResult>>;
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    collected = await collectSubtaskResult(taskId, 'subtask-A');
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(collected.filesChanged.map((entry) => entry.path), ['src/a.ts']);
  assert.deepEqual(warnings, [], 'mixed data has working attribution and must not degrade task-wide');
});

// ── 11. Commands use the same run-owned scope and legacy safety valve ───────
await check('a failed tsc from A does not poison clean subtask B', async () => {
  const [{ collectSubtaskResult, validateSubtaskQuality }] = await Promise.all([
    import('../services/subtask-executor.js'),
  ]);
  const taskId = await freshTask(db, 'command-reader-isolation');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        filesChanged: [
          { path: 'src/a.ts', beforeHash: 'b', afterHash: 'a', summary: 'A', subtaskId: 'subtask-A' },
          { path: 'src/b.ts', beforeHash: 'b', afterHash: 'a', summary: 'B', subtaskId: 'subtask-B' },
        ],
        commandsRun: [
          { command: 'npx tsc --noEmit', exitCode: 2, summary: 'A failed', subtaskId: 'subtask-A' },
          { command: 'npx tsc --noEmit', exitCode: 0, summary: 'B passed', subtaskId: 'subtask-B' },
        ],
      },
    },
  );

  const [forA, forB] = await Promise.all([
    collectSubtaskResult(taskId, 'subtask-A'),
    collectSubtaskResult(taskId, 'subtask-B'),
  ]);
  assert.deepEqual(forA.commandsRun.map((entry) => entry.summary), ['A failed']);
  assert.deepEqual(forB.commandsRun.map((entry) => entry.summary), ['B passed']);
  assert.equal(forA.hasErrors, true, 'A owns the failed compiler run');
  assert.equal(forB.hasErrors, false, 'B must not inherit A\'s failed compiler run');

  const quality = async (subtaskId: string, file: string, collected: typeof forA) => validateSubtaskQuality(
    { id: subtaskId, type: 'fix', dependencies: [], targetFiles: [file] } as any,
    {
      subtaskId,
      status: collected.hasErrors ? 'partial' : 'success',
      assignedModel: 'gate-model',
      filesChanged: collected.filesChanged,
      commandsRun: collected.commandsRun,
      diagnostics: 'The assigned file was changed and verified.',
      errors: collected.errors,
      durationMs: 1,
    },
  );
  const [qualityA, qualityB] = await Promise.all([
    quality('subtask-A', 'src/a.ts', forA),
    quality('subtask-B', 'src/b.ts', forB),
  ]);
  assert.ok(qualityA.signals.includes('tsc_errors'), 'A must retain its own red tsc signal');
  assert.equal(qualityB.passed, true, `B was poisoned by A: ${qualityB.signals.join(', ')}`);
});

await check('a later passing tsc supersedes an earlier failure in the same subtask', async () => {
  const { collectSubtaskResult, validateSubtaskQuality } = await import('../services/subtask-executor.js');
  const taskId = await freshTask(db, 'command-reader-latest');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        filesChanged: [
          { path: 'src/a.ts', beforeHash: 'b', afterHash: 'a', summary: 'A', subtaskId: 'subtask-A' },
        ],
        commandsRun: [
          { command: 'npx tsc --noEmit', exitCode: 2, summary: 'first failed', subtaskId: 'subtask-A' },
          { command: 'npx tsc --noEmit', exitCode: 0, summary: 'then passed', subtaskId: 'subtask-A' },
        ],
      },
    },
  );
  const collected = await collectSubtaskResult(taskId, 'subtask-A');
  assert.equal(collected.hasErrors, false, 'the collector kept a superseded tsc failure alive');
  assert.deepEqual(collected.errors, []);
  const quality = await validateSubtaskQuality(
    { id: 'subtask-A', type: 'fix', dependencies: [], targetFiles: ['src/a.ts'] } as any,
    {
      subtaskId: 'subtask-A',
      status: 'success',
      assignedModel: 'gate-model',
      filesChanged: collected.filesChanged,
      commandsRun: collected.commandsRun,
      diagnostics: 'The assigned file was changed and verified.',
      errors: collected.errors,
      durationMs: 1,
    },
  );
  assert.ok(!quality.signals.includes('tsc_errors'), 'quality validation used the first tsc instead of the latest');
});

await check('an all-legacy commandsRun list falls back task-wide and warns with taskId', async () => {
  const { collectSubtaskResult } = await import('../services/subtask-executor.js');
  const taskId = await freshTask(db, 'command-reader-legacy');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        filesChanged: [
          { path: 'src/a.ts', beforeHash: 'b', afterHash: 'a', summary: 'A', subtaskId: 'subtask-A' },
        ],
        commandsRun: [
          { command: 'npx tsc --noEmit', exitCode: 2, summary: 'legacy red' },
          { command: 'npm test', exitCode: 0, summary: 'legacy green' },
        ],
      },
    },
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  let collected: Awaited<ReturnType<typeof collectSubtaskResult>>;
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    collected = await collectSubtaskResult(taskId, 'subtask-A');
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(collected.commandsRun.map((entry) => entry.summary), ['legacy red', 'legacy green']);
  assert.ok(
    warnings.some((warning) => warning.includes(taskId) && /command attribution unavailable/i.test(warning)),
    `the command legacy valve must be loud and name ${taskId}; warnings=${JSON.stringify(warnings)}`,
  );
});

await check('mixed commands do not trigger the legacy valve; unattributed entries belong to nobody', async () => {
  const { collectSubtaskResult } = await import('../services/subtask-executor.js');
  const taskId = await freshTask(db, 'command-reader-mixed');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        filesChanged: [
          { path: 'src/a.ts', beforeHash: 'b', afterHash: 'a', summary: 'A', subtaskId: 'subtask-A' },
        ],
        commandsRun: [
          { command: 'npm test', exitCode: 0, summary: 'A', subtaskId: 'subtask-A' },
          { command: 'npx tsc --noEmit', exitCode: 2, summary: 'legacy red' },
          { command: 'npm test', exitCode: 0, summary: 'B', subtaskId: 'subtask-B' },
        ],
      },
    },
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  let collected: Awaited<ReturnType<typeof collectSubtaskResult>>;
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    collected = await collectSubtaskResult(taskId, 'subtask-A');
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(collected.commandsRun.map((entry) => entry.summary), ['A']);
  assert.equal(collected.hasErrors, false, 'an unattributed red tsc in mixed data belongs to nobody');
  assert.deepEqual(warnings, [], 'mixed command data has attribution and must not degrade task-wide');
});

// ── 12. The model-facing bulk updater cannot rewrite factual registries ─────
await check('two valid leases preserve factual registries and add their report lists atomically', async () => {
  const [
    { updateCodeTaskArtifactTool },
    { claimSubtaskArtifactLease },
    { runWithHarnessExecutionContext },
  ] = await Promise.all([
    import('../tools/dev/code-task-artifacts.js'),
    import('../services/subtask-artifact-fence.js'),
    import('../services/harness-execution-context.js'),
  ]);
  const taskId = await freshTask(db, 'leased-bulk-update');
  const factualFiles = [
    { path: 'src/a.ts', beforeHash: 'b', afterHash: 'a', summary: 'real A', subtaskId: 'subtask-A' },
    { path: 'src/b.ts', beforeHash: 'b', afterHash: 'a', summary: 'real B', subtaskId: 'subtask-B' },
  ];
  const factualCommands = [
    { command: 'npm test', approvalRequired: false, exitCode: 0, summary: 'real A', subtaskId: 'subtask-A' },
    { command: 'npx tsc --noEmit', approvalRequired: false, exitCode: 0, summary: 'real B', subtaskId: 'subtask-B' },
  ];
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        status: 'editing',
        agentId: 'codingAgent',
        userRequest: 'Lease-aware bulk update probe',
        plan: ['base plan'],
        filesRead: ['src/base.ts'],
        filesChanged: factualFiles,
        commandsRun: factualCommands,
        approvalsRequested: [{ approvalId: 'base', reason: 'base approval', status: 'pending' }],
      },
    },
  );
  const [leaseA, leaseB] = await Promise.all([
    claimSubtaskArtifactLease(db, { taskId, subtaskId: 'subtask-A' }),
    claimSubtaskArtifactLease(db, { taskId, subtaskId: 'subtask-B' }),
  ]);
  assert.ok(leaseA && leaseB, 'both distinct subtasks must own independent leases');

  const warnings: string[] = [];
  const originalWarn = console.warn;
  let results: Array<{ success: boolean; message: string }>;
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    results = await Promise.all([
      runWithHarnessExecutionContext(
        { taskId, subtaskId: leaseA!.subtaskId, artifactLease: leaseA! },
        () => (updateCodeTaskArtifactTool.execute as any)({
          taskId,
          filesChanged: [{
            path: 'src/model-A.ts', beforeHash: 'x', afterHash: 'y', summary: 'model A', subtaskId: 'subtask-A',
          }],
          commandsRun: [{
            command: 'false', approvalRequired: false, exitCode: 1, summary: 'model A', subtaskId: 'subtask-A',
          }],
          plan: ['plan A'],
          filesRead: ['src/read-A.ts'],
          approvalsRequested: [{ approvalId: 'approval-A', reason: 'A', status: 'pending' }],
        }, {}),
      ),
      runWithHarnessExecutionContext(
        { taskId, subtaskId: leaseB!.subtaskId, artifactLease: leaseB! },
        () => (updateCodeTaskArtifactTool.execute as any)({
          taskId,
          filesChanged: [{
            path: 'src/model-B.ts', beforeHash: 'x', afterHash: 'y', summary: 'model B', subtaskId: 'subtask-B',
          }],
          commandsRun: [{
            command: 'false', approvalRequired: false, exitCode: 1, summary: 'model B', subtaskId: 'subtask-B',
          }],
          plan: ['plan B'],
          filesRead: ['src/read-B.ts'],
          approvalsRequested: [{ approvalId: 'approval-B', reason: 'B', status: 'pending' }],
        }, {}),
      ),
    ]) as Array<{ success: boolean; message: string }>;
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(results.every((result) => result.success), results.map((result) => result.message).join(' | '));

  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  assert.deepEqual(artifact?.filesChanged, factualFiles, 'model input replaced the tool-owned filesChanged registry');
  assert.deepEqual(artifact?.commandsRun, factualCommands, 'model input replaced the tool-owned commandsRun registry');
  assert.deepEqual([...artifact!.plan].sort(), ['base plan', 'plan A', 'plan B']);
  assert.deepEqual([...artifact!.filesRead].sort(), ['src/base.ts', 'src/read-A.ts', 'src/read-B.ts']);
  assert.deepEqual(
    artifact?.approvalsRequested.map((entry: { approvalId: string }) => entry.approvalId).sort(),
    ['approval-A', 'approval-B', 'base'],
  );
  for (const subtaskId of ['subtask-A', 'subtask-B']) {
    assert.ok(
      warnings.some((warning) => warning.includes(taskId)
        && warning.includes(subtaskId)
        && warning.includes('filesChanged')
        && warning.includes('commandsRun')),
      `ignored registry fields were not logged for ${subtaskId}: ${JSON.stringify(warnings)}`,
    );
  }
});

await check('without a lease coding_update_artifact keeps whole-list replacement semantics', async () => {
  const [{ updateCodeTaskArtifactTool }, { runWithHarnessExecutionContext }] = await Promise.all([
    import('../tools/dev/code-task-artifacts.js'),
    import('../services/harness-execution-context.js'),
  ]);
  const taskId = await freshTask(db, 'solo-bulk-update');
  await db.collection('code_task_artifacts').updateOne(
    { taskId },
    {
      $set: {
        status: 'editing',
        agentId: 'codingAgent',
        userRequest: 'Solo bulk update compatibility probe',
        plan: ['old plan'],
        filesRead: ['src/old.ts'],
        filesChanged: [{ path: 'src/old.ts', beforeHash: 'b', afterHash: 'a', summary: 'old' }],
        commandsRun: [{ command: 'npm test', approvalRequired: false, exitCode: 1, summary: 'old' }],
        approvalsRequested: [{ approvalId: 'old', reason: 'old', status: 'pending' }],
      },
    },
  );
  const replacement = {
    plan: ['new plan'],
    filesRead: ['src/new.ts'],
    filesChanged: [{ path: 'src/new.ts', beforeHash: 'x', afterHash: 'y', summary: 'new' }],
    commandsRun: [{ command: 'npx tsc --noEmit', approvalRequired: false, exitCode: 0, summary: 'new' }],
    approvalsRequested: [{ approvalId: 'new', reason: 'new', status: 'approved' as const }],
  };
  const result = await runWithHarnessExecutionContext(
    { taskId, subtaskId: 'context-without-a-lease' },
    () => (updateCodeTaskArtifactTool.execute as any)({ taskId, ...replacement }, {}),
  ) as { success: boolean; message: string };
  assert.equal(result.success, true, result.message);
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  for (const [field, expected] of Object.entries(replacement)) {
    assert.deepEqual(artifact?.[field], expected, `${field} no longer uses solo replacement semantics`);
  }
});

await check('coding_update_artifact describes its lease-aware list semantics to the model', async () => {
  const { updateCodeTaskArtifactTool } = await import('../tools/dev/code-task-artifacts.js');
  const description = updateCodeTaskArtifactTool.description ?? '';
  assert.match(description, /lease[\s\S]*filesChanged[\s\S]*commandsRun[\s\S]*ignored/i);
  assert.match(description, /plan[\s\S]*filesRead[\s\S]*approvalsRequested[\s\S]*add/i);
  assert.match(description, /without a lease[\s\S]*replace/i);
});

const { closeDb } = await import('../lib/mongo.js');
await closeDb();
await rm(harnessWorktree, { recursive: true, force: true });
await db.dropDatabase();
await client.close();

if (failures > 0) {
  console.error(`\ncheck:subtask-file-attribution FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log('\ncheck:subtask-file-attribution PASSED — a parallel group\'s file changes all survive, each attributed to its subtask.');
process.exit(0);
