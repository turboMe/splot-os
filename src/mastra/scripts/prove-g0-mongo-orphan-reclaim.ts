/**
 * Live, destructive proof for the journal-backed G0 Mongo orphan reclaimer.
 *
 * Safety envelope:
 * - accepts only the local single-node rs0 fixture on localhost:27018;
 * - mints a fresh random test database and an isolated private journal root;
 * - registers the exact workload process before allowing its first Mongo write;
 * - SIGKILLs the journal owner while leaving the detached workload alive;
 * - SIGKILLs the first reclaimer after journal unlink but before claim release;
 * - runs a second startup sweep and proves claim-only recovery and exact absence.
 *
 * Run after `npm run spike:mongo-rs:up`:
 *   node --import tsx src/mastra/scripts/prove-g0-mongo-orphan-reclaim.ts
 */
import assert from 'node:assert/strict';
import {
  fork,
  type ChildProcess,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLinuxProcessIdentity,
} from '../orchestration/execution/linux-process-tree.js';
import {
  MongoOrphanJournalStore,
  openMongoOrphanJournalClient,
} from '../orchestration/testing/mongo-orphan-journal.js';
import {
  createParentRuntimeResourceSession,
} from '../orchestration/testing/parent-runtime-resources.js';
import {
  TEST_RUNTIME_MONGO_OWNER_ALLOCATION_SYMBOL,
  TEST_RUNTIME_OWNER_COLLECTION,
  bindMongoTestDatabase,
  createMongoOwnerAllocation,
  createTestRuntimeOwner,
  describeMongoTopologyUri,
  hashCanonicalValue,
  mongoOwnerAllocationSchema,
  readGitSourceIdentity,
  type MongoOwnerAllocationV1,
} from '../orchestration/testing/test-runtime.js';

const PROOF_VERSION = 'g0-mongo-orphan-reclaim-live-proof/v1';
const OWNER_PARENT_MODE = '--owner-parent';
const WORKLOAD_MODE = '--workload';
const RECLAIMER_MODE = '--reclaimer';
const SUITE_ID = 'proof:g0-mongo-orphan-reclaim';
const BUSINESS_COLLECTION = 'proof_business';
const DEFAULT_MONGO_URI = 'mongodb://localhost:27018/?replicaSet=rs0';
const LOCAL_RS_PORT = 27018;
const IPC_TIMEOUT_MS = 20_000;
const RECLAIM_DEADLINE_MS = 20_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX_IMPORT = import.meta.resolve('tsx');

const PROOF_URI_ENV = 'ORCHESTRATION_G0_RECLAIM_PROOF_URI';
const PROOF_ROOT_ENV = 'ORCHESTRATION_G0_RECLAIM_PROOF_ROOT';
const PROOF_JOURNAL_ROOT_ENV = 'ORCHESTRATION_G0_RECLAIM_PROOF_JOURNAL_ROOT';
const PROOF_RUNTIME_ROOT_ENV = 'ORCHESTRATION_G0_RECLAIM_PROOF_RUNTIME_ROOT';
const PROOF_ALLOCATION_ENV = 'ORCHESTRATION_G0_RECLAIM_PROOF_ALLOCATION';

interface OwnerReadyMessage {
  type: 'OWNER_READY';
  allocation: MongoOwnerAllocationV1;
  workloadPid: number;
  workloadProcessStartToken: string;
}

interface WorkloadReadyMessage {
  type: 'WORKLOAD_READY';
  dbName: string;
}

interface ReclaimerTerminalWindowMessage {
  type: 'RECLAIMER_TERMINAL_WINDOW';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing proof environment: ${name}`);
  return value;
}

function errorClass(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : 'UnknownError';
}

function sendFailure(
  type: 'OWNER_FAILED' | 'WORKLOAD_FAILED' | 'RECLAIMER_FAILED',
  error: unknown,
): void {
  process.send?.({ type, errorClass: errorClass(error) });
}

function assertLocalFixtureUri(uri: string): {
  port: number;
  replicaSet: string;
} {
  assert.ok(uri.length <= 2_048, 'Mongo proof URI is unexpectedly long');
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'mongodb:', 'proof requires a mongodb:// URI');
  assert.equal(parsed.username, '', 'proof refuses Mongo credentials');
  assert.equal(parsed.password, '', 'proof refuses Mongo credentials');
  assert.ok(
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1',
    'proof accepts only an exact loopback Mongo host',
  );
  const port = parsed.port === '' ? 27_017 : Number(parsed.port);
  assert.equal(port, LOCAL_RS_PORT, `proof accepts only the ephemeral port ${LOCAL_RS_PORT}`);
  assert.ok(!parsed.host.includes(','), 'proof accepts only one Mongo seed');
  assert.ok(parsed.pathname === '/' || parsed.pathname === '', 'proof refuses a named database URI');
  const replicaSet = parsed.searchParams.get('replicaSet') ?? '';
  assert.equal(replicaSet, 'rs0', 'proof accepts only replicaSet=rs0');
  for (const key of parsed.searchParams.keys()) {
    assert.equal(key.toLowerCase(), 'replicaset', 'proof refuses extra Mongo URI options');
  }
  return { port, replicaSet };
}

function assertSingleNodeLocalHello(hello: unknown, replicaSet: string): void {
  assert.ok(isRecord(hello), 'Mongo hello result is not an object');
  assert.equal(hello.isWritablePrimary, true, 'Mongo fixture is not writable primary');
  assert.equal(hello.setName, replicaSet, 'Mongo fixture replica-set name differs');
  assert.ok(Array.isArray(hello.hosts), 'Mongo hello lacks replica-set hosts');
  assert.deepEqual(hello.passives ?? [], [], 'proof requires no passive members');
  assert.deepEqual(hello.arbiters ?? [], [], 'proof requires no arbiters');
  assert.equal(hello.hosts.length, 1, 'proof requires a single-node replica set');
  assert.match(
    String(hello.hosts[0]),
    /^(?:localhost|127\.0\.0\.1):27018$/i,
    'proof requires the local ephemeral rs0 member',
  );
}

function safeBaseEnv(): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    NODE_OPTIONS: '',
  };
}

function forkSelf(
  mode:
    | typeof OWNER_PARENT_MODE
    | typeof WORKLOAD_MODE
    | typeof RECLAIMER_MODE,
  input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached?: boolean;
  },
): ChildProcess {
  return fork(SCRIPT_PATH, [mode], {
    cwd: input.cwd,
    env: input.env,
    execArgv: ['--import', TSX_IMPORT],
    detached: input.detached ?? false,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

function waitForMessage<T>(
  child: ChildProcess,
  parse: (message: unknown) => T | undefined,
  timeoutMs = IPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolveWait, rejectWait) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) rejectWait(error);
      else resolveWait(value!);
    };
    const onMessage = (message: unknown) => {
      if (isRecord(message) && (
        message.type === 'OWNER_FAILED'
        || message.type === 'WORKLOAD_FAILED'
        || message.type === 'RECLAIMER_FAILED'
      )) {
        finish(new Error(`${String(message.type)}:${String(message.errorClass)}`));
        return;
      }
      let parsed: T | undefined;
      try {
        parsed = parse(message);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('invalid proof IPC message'));
        return;
      }
      if (parsed !== undefined) finish(undefined, parsed);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`proof child exited before readiness (${code ?? signal ?? 'unknown'})`));
    };
    const timer = setTimeout(() => {
      finish(new Error('proof IPC readiness timed out'));
    }, timeoutMs);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = IPC_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    let settled = false;
    const finish = (
      error?: Error,
      result?: { code: number | null; signal: NodeJS.Signals | null },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) rejectExit(error);
      else resolveExit(result!);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(undefined, { code, signal });
    };
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => {
      finish(new Error('proof child exit timed out'));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function parseOwnerReady(message: unknown): OwnerReadyMessage | undefined {
  if (!isRecord(message) || message.type !== 'OWNER_READY') return undefined;
  const allocation = mongoOwnerAllocationSchema.parse(message.allocation);
  assert.ok(
    Number.isInteger(message.workloadPid) && Number(message.workloadPid) >= 2,
    'owner reported an invalid workload PID',
  );
  assert.match(
    String(message.workloadProcessStartToken),
    /^[0-9]+$/,
    'owner reported an invalid workload start token',
  );
  return {
    type: 'OWNER_READY',
    allocation,
    workloadPid: Number(message.workloadPid),
    workloadProcessStartToken: String(message.workloadProcessStartToken),
  };
}

function parseWorkloadReady(message: unknown): WorkloadReadyMessage | undefined {
  if (!isRecord(message) || message.type !== 'WORKLOAD_READY') return undefined;
  assert.equal(typeof message.dbName, 'string', 'workload reported an invalid database name');
  return { type: 'WORKLOAD_READY', dbName: String(message.dbName) };
}

function parseReclaimerTerminalWindow(
  message: unknown,
): ReclaimerTerminalWindowMessage | undefined {
  if (
    !isRecord(message)
    || message.type !== 'RECLAIMER_TERMINAL_WINDOW'
    || Object.keys(message).join(',') !== 'type'
  ) return undefined;
  return { type: 'RECLAIMER_TERMINAL_WINDOW' };
}

function waitForRelease(): Promise<void> {
  return new Promise((resolveRelease, rejectRelease) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      if (error) rejectRelease(error);
      else resolveRelease();
    };
    const onMessage = (message: unknown) => {
      if (isRecord(message) && message.type === 'RELEASE_WORKLOAD') finish();
    };
    const onDisconnect = () => finish(new Error('proof parent disconnected before release'));
    const timer = setTimeout(() => {
      finish(new Error('proof workload release timed out'));
    }, IPC_TIMEOUT_MS);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

async function runWorkload(): Promise<void> {
  try {
    await waitForRelease();
    const uri = requiredEnv(PROOF_URI_ENV);
    assertLocalFixtureUri(uri);
    const allocation = mongoOwnerAllocationSchema.parse(
      JSON.parse(requiredEnv(PROOF_ALLOCATION_ENV)),
    );
    let available: MongoOwnerAllocationV1 | undefined = allocation;
    Object.defineProperty(
      globalThis,
      Symbol.for(TEST_RUNTIME_MONGO_OWNER_ALLOCATION_SYMBOL),
      {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => {
          if (!available) throw new Error('proof Mongo allocation was already consumed');
          const result = available;
          available = undefined;
          return result;
        },
      },
    );
    const owner = createTestRuntimeOwner({
      suiteId: SUITE_ID,
      topologyUri: uri,
      effectiveConfig: {
        executionProfile: 'DETERMINISTIC',
        runtimeKind: 'DIRECT',
        storeKind: 'MONGODB_REPLICA_SET',
        workerFixtureIds: ['OK'],
      },
    });
    assert.equal(owner.databaseName, allocation.dbName);
    const opened = await openMongoOrphanJournalClient(uri);
    const db = opened.client.db(owner.databaseName);
    await owner.claimMongoDatabase(bindMongoTestDatabase(opened.client, db));
    await db.collection<{ _id: string; ownerState: string }>(
      BUSINESS_COLLECTION,
    ).insertOne(
      {
        _id: 'live-proof',
        ownerState: 'ACTIVE',
      },
      {
        writeConcern: { w: 'majority', wtimeoutMS: 3_000 },
        timeoutMS: 3_000,
      },
    );
    // Stay deliberately non-cooperative so the startup reclaimer must escalate
    // from TERM to KILL after the controller kills the journal-owning parent.
    process.on('SIGTERM', () => {});
    process.send?.({
      type: 'WORKLOAD_READY',
      dbName: owner.databaseName,
    });
    await new Promise<never>(() => {});
  } catch (error) {
    sendFailure('WORKLOAD_FAILED', error);
    process.exitCode = 1;
    throw error;
  }
}

async function runOwnerParent(): Promise<void> {
  try {
    const uri = requiredEnv(PROOF_URI_ENV);
    const proofRoot = realpathSync(requiredEnv(PROOF_ROOT_ENV));
    const journalRoot = realpathSync(requiredEnv(PROOF_JOURNAL_ROOT_ENV));
    const runtimeRoot = realpathSync(requiredEnv(PROOF_RUNTIME_ROOT_ENV));
    const endpoint = assertLocalFixtureUri(uri);
    const opened = await openMongoOrphanJournalClient(uri);
    assertSingleNodeLocalHello(opened.hello, endpoint.replicaSet);
    const parentChallenge = randomBytes(32).toString('hex');
    const allocation = createMongoOwnerAllocation({
      suiteId: SUITE_ID,
      parentChallenge,
      topologyUri: uri,
      topologyHello: opened.hello,
    });
    const source = readGitSourceIdentity(PROJECT_ROOT);
    const runtimeSession = await createParentRuntimeResourceSession({
      parentDirectory: runtimeRoot,
      parentChallenge,
      entrypoint: SCRIPT_PATH,
      entrypointRoot: PROJECT_ROOT,
      sourceRoot: PROJECT_ROOT,
      parentSourceIdentity: source,
      readPostRunSourceIdentity: () => readGitSourceIdentity(PROJECT_ROOT),
      sourceIdentityEquals: (before, after) =>
        hashCanonicalValue(before) === hashCanonicalValue(after),
      portRoles: [],
      allowedLoopbackPorts: [endpoint.port],
    });
    const workload = forkSelf(WORKLOAD_MODE, {
      cwd: runtimeSession.spawnContext.cwd,
      detached: true,
      env: {
        ...runtimeSession.spawnContext.env,
        ORCHESTRATION_G0_GATE: 'true',
        [PROOF_URI_ENV]: uri,
        [PROOF_ROOT_ENV]: proofRoot,
        [PROOF_ALLOCATION_ENV]: JSON.stringify(allocation),
        NODE_OPTIONS: '',
      },
    });
    const processOwner = await runtimeSession.claimSpawn(workload);
    assert.equal(processOwner.pid, workload.pid);
    const store = new MongoOrphanJournalStore(journalRoot);
    await store.register(allocation, processOwner);
    const workloadReadyPromise = waitForMessage(workload, parseWorkloadReady);
    workload.send?.({ type: 'RELEASE_WORKLOAD' });
    const ready = await workloadReadyPromise;
    assert.equal(ready.dbName, allocation.dbName);
    process.send?.({
      type: 'OWNER_READY',
      allocation,
      workloadPid: processOwner.pid,
      workloadProcessStartToken: processOwner.processStartToken,
    });
    await new Promise<never>(() => {});
  } catch (error) {
    sendFailure('OWNER_FAILED', error);
    process.exitCode = 1;
    throw error;
  }
}

async function runReclaimer(): Promise<void> {
  try {
    const uri = requiredEnv(PROOF_URI_ENV);
    const journalRoot = realpathSync(requiredEnv(PROOF_JOURNAL_ROOT_ENV));
    const endpoint = assertLocalFixtureUri(uri);
    const opened = await openMongoOrphanJournalClient(uri);
    assertSingleNodeLocalHello(opened.hello, endpoint.replicaSet);
    const store = new MongoOrphanJournalStore(journalRoot);
    await store.reclaim({
      client: opened.client,
      topologyDescriptorHash: hashCanonicalValue(describeMongoTopologyUri(uri)),
      topologyHello: opened.hello,
      deadlineMs: RECLAIM_DEADLINE_MS,
      afterJournalUnlinkBeforeClaimRelease: async () => {
        process.send?.({ type: 'RECLAIMER_TERMINAL_WINDOW' });
        // IPC plus the pending hook pins this process at the exact crash point
        // until the controller delivers a real SIGKILL.
        await new Promise<never>(() => {});
      },
    });
    throw new Error('live proof reclaimer unexpectedly crossed its crash point');
  } catch (error) {
    sendFailure('RECLAIMER_FAILED', error);
    process.exitCode = 1;
    throw error;
  }
}

async function databaseExists(client: Awaited<
  ReturnType<typeof openMongoOrphanJournalClient>
>['client'], dbName: string): Promise<boolean> {
  const result = await client.db('admin').command(
    {
      listDatabases: 1,
      nameOnly: true,
      filter: { name: dbName },
    },
    { timeoutMS: 3_000 },
  );
  assert.ok(isRecord(result) && Array.isArray(result.databases));
  return result.databases.some(
    (entry) => isRecord(entry) && entry.name === dbName,
  );
}

function proofRootStillExact(root: string, original: BigIntStats): boolean {
  try {
    const current = lstatSync(root, { bigint: true });
    return realpathSync(root) === root
      && current.isDirectory()
      && !current.isSymbolicLink()
      && current.dev === original.dev
      && current.ino === original.ino
      && current.uid === original.uid
      && (current.mode & 0o777n) === 0o700n;
  } catch {
    return false;
  }
}

async function runController(): Promise<void> {
  assert.equal(process.platform, 'linux', 'live reclaim proof requires Linux process identities');
  const uri = process.env.MONGODB_URI_SPIKE_RS ?? DEFAULT_MONGO_URI;
  const endpoint = assertLocalFixtureUri(uri);
  const opened = await openMongoOrphanJournalClient(uri);
  assertSingleNodeLocalHello(opened.hello, endpoint.replicaSet);

  const createdRoot = mkdtempSync(join(tmpdir(), 'orch-g0-mongo-reclaim-proof-'));
  chmodSync(createdRoot, 0o700);
  const proofRoot = realpathSync(createdRoot);
  const proofRootStat = lstatSync(proofRoot, { bigint: true });
  const journalRoot = join(proofRoot, 'journal');
  const runtimeRoot = join(proofRoot, 'runtime');
  mkdirSync(journalRoot, { mode: 0o700 });
  chmodSync(journalRoot, 0o700);
  mkdirSync(runtimeRoot, { mode: 0o700 });
  chmodSync(runtimeRoot, 0o700);

  const store = new MongoOrphanJournalStore(journalRoot);
  let ownerParent: ChildProcess | undefined;
  let crashReclaimer: ChildProcess | undefined;
  let ready: OwnerReadyMessage | undefined;
  let databaseAbsenceProven = false;
  let journalEmpty = false;
  try {
    ownerParent = forkSelf(OWNER_PARENT_MODE, {
      cwd: PROJECT_ROOT,
      env: {
        ...safeBaseEnv(),
        [PROOF_URI_ENV]: uri,
        [PROOF_ROOT_ENV]: proofRoot,
        [PROOF_JOURNAL_ROOT_ENV]: journalRoot,
        [PROOF_RUNTIME_ROOT_ENV]: runtimeRoot,
      },
    });
    ready = await waitForMessage(ownerParent, parseOwnerReady);

    const db = opened.client.db(ready.allocation.dbName);
    const marker = await db
      .collection<{ _id: string; state: string }>(TEST_RUNTIME_OWNER_COLLECTION)
      .findOne({ _id: 'owner' }, { timeoutMS: 3_000 });
    assert.ok(isRecord(marker), 'owner marker is absent before crash');
    assert.equal(marker.state, 'ACTIVE', 'owner marker is not ACTIVE before crash');
    assert.equal(
      await db.collection<{ _id: string }>(BUSINESS_COLLECTION).countDocuments(
        { _id: 'live-proof' },
        { timeoutMS: 3_000 },
      ),
      1,
      'business collection was not materialized before crash',
    );
    assert.equal(store.listEntryFiles().length, 1, 'journal was not durable before workload write');

    const ownerExit = waitForExit(ownerParent);
    assert.equal(ownerParent.kill('SIGKILL'), true, 'owner parent refused SIGKILL');
    const terminated = await ownerExit;
    assert.equal(terminated.signal, 'SIGKILL', 'owner parent did not die by SIGKILL');

    crashReclaimer = forkSelf(RECLAIMER_MODE, {
      cwd: PROJECT_ROOT,
      env: {
        ...safeBaseEnv(),
        [PROOF_URI_ENV]: uri,
        [PROOF_JOURNAL_ROOT_ENV]: journalRoot,
      },
    });
    await waitForMessage(
      crashReclaimer,
      parseReclaimerTerminalWindow,
    );
    assert.deepEqual(
      readdirSync(journalRoot),
      [`${ready.allocation.runId}.json.claim`],
      'terminal crash point must retain only the recoverable claim',
    );
    assert.equal(
      await databaseExists(opened.client, ready.allocation.dbName),
      false,
      'terminal crash point was reached before exact database absence',
    );
    const reclaimerExit = waitForExit(crashReclaimer);
    assert.equal(
      crashReclaimer.kill('SIGKILL'),
      true,
      'terminal-window reclaimer refused SIGKILL',
    );
    const reclaimerTerminated = await reclaimerExit;
    assert.equal(
      reclaimerTerminated.signal,
      'SIGKILL',
      'terminal-window reclaimer did not die by SIGKILL',
    );

    const report = await store.reclaim({
      client: opened.client,
      topologyDescriptorHash: hashCanonicalValue(describeMongoTopologyUri(uri)),
      topologyHello: opened.hello,
      deadlineMs: RECLAIM_DEADLINE_MS,
    });
    assert.equal(report.status, 'PASSED');
    assert.equal(report.reclaimVerified, true);
    assert.equal(report.scannedEntries, 1);
    assert.equal(report.reclaimedCount, 0);
    assert.equal(report.alreadyAbsentCount, 1);
    assert.equal(report.unsafeCount, 0);
    assert.equal(report.failedCount, 0);
    assert.equal(report.effects.length, 1);
    assert.equal(report.effects[0]?.outcome, 'ALREADY_ABSENT');
    assert.equal(report.effects[0]?.reasonCode, 'DATABASE_ALREADY_ABSENT');

    databaseAbsenceProven = !await databaseExists(
      opened.client,
      ready.allocation.dbName,
    );
    assert.equal(databaseAbsenceProven, true, 'reclaimed database is still present');
    const currentWorkload = await readLinuxProcessIdentity(ready.workloadPid);
    assert.ok(
      currentWorkload === null
      || currentWorkload.processStartToken !== ready.workloadProcessStartToken,
      'orphan workload process survived startup reclaim',
    );
    journalEmpty = readdirSync(journalRoot).length === 0;
    assert.equal(journalEmpty, true, 'journal was not completed after verified absence');

    console.log(JSON.stringify({
      schemaVersion: PROOF_VERSION,
      status: 'PASSED',
      topology: {
        replicaSet: endpoint.replicaSet,
        memberCount: 1,
        port: endpoint.port,
      },
      crash: {
        ownerSignal: 'SIGKILL',
        terminalWindowReclaimerSignal: 'SIGKILL',
        activeMarkerObserved: true,
        businessDocumentObserved: true,
        recoverableClaimOnlyObserved: true,
      },
      reclaim: report,
      databaseAbsenceProven,
      workloadTreeEmptyProven: true,
      journalEmpty,
    }));
  } finally {
    if (
      ownerParent
      && ownerParent.exitCode === null
      && ownerParent.signalCode === null
    ) {
      const exiting = waitForExit(ownerParent).catch(() => undefined);
      ownerParent.kill('SIGKILL');
      await exiting;
    }
    if (
      crashReclaimer
      && crashReclaimer.exitCode === null
      && crashReclaimer.signalCode === null
    ) {
      const exiting = waitForExit(crashReclaimer).catch(() => undefined);
      crashReclaimer.kill('SIGKILL');
      await exiting;
    }
    // If an assertion failed after registration, exercise the same journal
    // recovery once more rather than deleting the only remaining authority.
    if (!journalEmpty) {
      try {
        const cleanupReport = await store.reclaim({
          client: opened.client,
          topologyDescriptorHash: hashCanonicalValue(describeMongoTopologyUri(uri)),
          topologyHello: opened.hello,
          deadlineMs: RECLAIM_DEADLINE_MS,
        });
        journalEmpty = cleanupReport.reclaimVerified
          && readdirSync(journalRoot).length === 0;
      } catch {
        journalEmpty = false;
      }
    }
    if (ready) {
      databaseAbsenceProven = !await databaseExists(
        opened.client,
        ready.allocation.dbName,
      ).catch(() => false);
    }
    await opened.client.close().catch(() => {});
    if (
      journalEmpty
      && (ready === undefined || databaseAbsenceProven)
      && proofRootStillExact(proofRoot, proofRootStat)
    ) {
      rmSync(proofRoot, { recursive: true });
    }
  }
}

const mode = process.argv[2];
if (mode === WORKLOAD_MODE) {
  await runWorkload();
} else if (mode === OWNER_PARENT_MODE) {
  await runOwnerParent();
} else if (mode === RECLAIMER_MODE) {
  await runReclaimer();
} else {
  await runController();
}
