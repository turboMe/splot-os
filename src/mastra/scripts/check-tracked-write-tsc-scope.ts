#!/usr/bin/env tsx
/**
 * check:tracked-write-tsc-scope — a tracked TypeScript write must not turn a
 * shared-worktree verification into per-subtask work or an unsupported claim.
 *
 * This uses the real Mastra tool, harness AsyncLocalStorage, filesystem and
 * MongoDB. Only `npx` is a deterministic probe placed first on PATH: one mode
 * records that a compiler process was launched, the other returns the
 * conventional timeout status 124 without printing compiler diagnostics.
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';

const RS3_URI = 'mongodb://localhost:27019,localhost:27020,localhost:27021/?replicaSet=rs3f8';
const FALLBACK_URIS = [
  process.env.MONGODB_URI_SPIKE_RS,
  process.env.MONGODB_URI,
  'mongodb://localhost:27017/?replicaSet=rs0',
].filter((value): value is string => Boolean(value));

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

async function connect(): Promise<{ client: MongoClient; uri: string; label: string }> {
  const candidates = [RS3_URI, ...FALLBACK_URIS];
  const reasons: string[] = [];
  for (const uri of candidates) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      return {
        client,
        uri,
        label: uri === RS3_URI ? 'rs3f8' : 'fallback replica set',
      };
    } catch (error) {
      reasons.push((error as Error).message);
      await client.close().catch(() => undefined);
    }
  }
  throw new Error(`No MongoDB candidate answered: ${reasons.join(' | ')}`);
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

console.log('check:tracked-write-tsc-scope');

const { client, uri, label } = await connect();
console.log(`  · connected to ${label}`);
const dbName = `j2_tsc_scope_${Date.now()}`;
const db = client.db(dbName);
const worktree = await mkdtemp(join(tmpdir(), 'j2-tsc-scope-'));
const shimDir = await mkdtemp(join(tmpdir(), 'j2-tsc-npx-'));
const marker = join(shimDir, 'tsc-launched');
const originalPath = process.env.PATH;

try {
  const npxShim = join(shimDir, 'npx');
  await writeFile(
    npxShim,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${J2_TSC_PROBE_MODE:-record}" = "timeout" ]; then',
      '  exit 124',
      'fi',
      ': > "${J2_TSC_PROBE_MARKER:?missing marker path}"',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(npxShim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
  process.env.J2_TSC_PROBE_MARKER = marker;
  process.env.MONGODB_URI = uriForDatabase(uri, dbName);
  process.env.FEATURE_FILE_ACTIVITY_LEDGER = 'true';

  const [
    { writeFileTrackedTool },
    { claimSubtaskArtifactLease },
    { closeDb },
    { runWithHarnessExecutionContext },
  ] = await Promise.all([
    import('../tools/dev/code-change-ledger.js'),
    import('../services/subtask-artifact-fence.js'),
    import('../lib/mongo.js'),
    import('../services/harness-execution-context.js'),
  ]);

  const createArtifact = async (taskId: string): Promise<void> => {
    await db.collection('code_task_artifacts').insertOne({
      taskId,
      worktreePath: worktree,
      filesChanged: [],
      filesRead: [],
      commandsRun: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };
  const writeTracked = async (input: { taskId: string; path: string; content: string; summary: string }) => {
    return (writeFileTrackedTool.execute as any)(input, {});
  };

  await check('a .ts write under a real subtask lease launches no tsc process', async () => {
    const taskId = `leased-${Date.now()}`;
    await createArtifact(taskId);
    const lease = await claimSubtaskArtifactLease(db, { taskId, subtaskId: 'subtask-A' });
    assert.ok(lease, 'could not claim the probe lease');
    process.env.J2_TSC_PROBE_MODE = 'record';

    const result = await runWithHarnessExecutionContext(
      { taskId, subtaskId: 'subtask-A', artifactLease: lease },
      () => writeTracked({
        taskId,
        path: 'leased-probe.ts',
        content: 'export const leasedProbe = true;\n',
        summary: 'Probe lease-aware tracked write verification',
      }),
    );

    assert.equal(result.success, true, result.error ?? result.message);
    assert.equal(await readFile(join(worktree, 'leased-probe.ts'), 'utf8'), 'export const leasedProbe = true;\n');
    assert.equal(
      await exists(marker),
      false,
      'the tracked writer launched npx tsc even though the harness run held a subtask lease',
    );
  });

  await check('a timed-out solo verification never claims that the project does not compile', async () => {
    const taskId = `solo-${Date.now()}`;
    await createArtifact(taskId);
    process.env.J2_TSC_PROBE_MODE = 'timeout';

    const result = await runWithHarnessExecutionContext(
      { taskId },
      () => writeTracked({
        taskId,
        path: 'solo-probe.ts',
        content: 'export const soloProbe = true;\n',
        summary: 'Probe truthful tracked write timeout reporting',
      }),
    );

    assert.equal(result.success, true, result.error ?? result.message);
    assert.doesNotMatch(result.message, /project does not compile/i);
    assert.match(
      result.message,
      /TypeScript verification did not finish/i,
      `the tool did not tell the model that verification was incomplete: ${result.message}`,
    );
  });

  await check('the production tracked-write timeout is at least 60 seconds', async () => {
    const source = await readFile('src/mastra/tools/dev/code-change-ledger.ts', 'utf8');
    const match = source.match(/TRACKED_WRITE_TSC_TIMEOUT_MS\s*=\s*([\d_]+)/);
    assert.ok(match, 'could not find the named tracked-write tsc timeout');
    const timeoutMs = Number(match[1]!.replaceAll('_', ''));
    assert.ok(timeoutMs >= 60_000, `tracked-write timeout is ${timeoutMs} ms, expected at least 60000 ms`);
  });

  await closeDb();
} finally {
  process.env.PATH = originalPath;
  delete process.env.J2_TSC_PROBE_MARKER;
  delete process.env.J2_TSC_PROBE_MODE;
  await db.dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
  await rm(worktree, { recursive: true, force: true });
  await rm(shimDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncheck:tracked-write-tsc-scope FAILED — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\ncheck:tracked-write-tsc-scope PASSED — dispatch writes skip tsc and solo timeouts stay truthful.');
process.exit(0);
