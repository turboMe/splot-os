#!/usr/bin/env tsx
/**
 * Mongo-free security/contract check for G0_TEST_RUNTIME_V3.
 *
 * The in-memory handle is minted inside the runtime module and cannot be
 * configured with a destructive callback. This check therefore exercises the
 * exact ownership/HMAC/CAS/drop protocol without granting access to a real DB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import {
  readLocalProcessHostIdentity,
} from '../orchestration/execution/linux-process-tree.js';
import {
  RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS,
  RAW_EVIDENCE_SNAPSHOT_VERSION,
  REQUIRED_RAW_EVIDENCE,
  captureAnonymizedMongoSnapshot,
  createParentArtifactSession,
  processOutputMatchesArtifact,
  retainRawEvidenceArtifacts,
  retainedArtifactBytes,
  validateRetainedRawEvidenceArtifact,
  type ParentArtifactSession,
  type RawEvidenceArtifactInput,
  type RetainedRawEvidenceArtifact,
} from '../orchestration/testing/raw-evidence-sink.js';
import {
  bindMongoTestDatabase,
  ForeignTestResourceError,
  TEST_RUNTIME_DB_PREFIX,
  TEST_RUNTIME_FAULT_POINTS,
  TestRuntimeCleanupLeakError,
  TestRuntimeOwnershipError,
  TestRuntimeStateError,
  TestRuntimeTopologyError,
  createMongoOwnerAllocation,
  createReclaimClaimedMongoOwnerMarker,
  createInMemoryMongoTestHarness,
  createTestRuntimeOwnerForContractCheck,
  describeMongoTopologyUri,
  hashCanonicalValue,
  mongoOwnerAllocationSchema,
  mongoTopologyFingerprintFromHello,
  TEST_EVIDENCE_BUNDLE_VERSION,
  validateTestEvidenceBundle,
  validateTestEvidenceReport,
  validateTestRuntimeManifest,
  type CreateTestRuntimeOwnerForContractCheckInput,
  type MongoTestDatabaseHandle,
  type TestEvidenceReportV2,
  type TestRuntimeManifestV2,
} from '../orchestration/testing/test-runtime.js';
import {
  TEST_RUNTIME_RESOURCE_CONTRACT_VERSION,
  type ParentGuardedRuntimeResourceContract,
} from '../orchestration/testing/runtime-resource-contract.js';
import {
  buildParentRuntimeNodePermissionArgs,
  deriveSideEffectLedger,
  PARENT_RUNTIME_AUDIT_VERSION,
  RUNTIME_SIDE_EFFECT_LEDGER_VERSION,
  type RuntimeResourceAuditEvent,
} from '../orchestration/testing/parent-runtime-resources.js';
import {
  MongoOrphanJournalStore,
  failedMongoOrphanReclaimReport,
  mongoOrphanReclaimReportSchema,
} from '../orchestration/testing/mongo-orphan-journal.js';
import {
  GATE_WORKSPACE_MARKER_NAME,
  GateWorkspaceOrphanJournalStore,
  failedGateWorkspaceOrphanReclaimReport,
  gateWorkspaceAllocationSchema,
  gateWorkspaceCleanupResultSchema,
  gateWorkspaceLimitsSchema,
  gateWorkspaceOrphanReclaimReportSchema,
  type GateWorkspaceAllocation,
  type GateWorkspaceJournalTestingPorts,
} from '../orchestration/testing/gate-workspace-orphan-journal.js';
import {
  FAULT_INJECTOR_KINDS,
  FAULT_KIND_ALLOWED_DISPOSITIONS,
  FAULT_KIND_TO_RUNTIME_POINT,
  deriveFaultLedger,
  deriveFaultSchedule,
  faultScheduleSchema,
  type FaultDisposition,
  type FaultEvent,
} from '../orchestration/testing/fault-injector.js';
import {
  FAKE_PROCESS_TREE_EVIDENCE_VERSION,
  fakeProcessTreeEvidenceSchema,
  teardownFakeProcessTree,
  verifyFakeProcessTreeShape,
  type FakeProcessTreeHandle,
} from '../orchestration/testing/fake-process-tree.js';
import {
  PROVIDER_RESPONSE_MODES,
  PROVIDER_STUB_KINDS,
  UnstubbedProviderError,
  createProviderStubRegistry,
  deriveProviderStubLedger,
  dispatchProviderStub,
  providerResponseIsFaultMode,
  type ProviderStubExchange,
} from '../orchestration/testing/provider-stubs.js';
import type { OwnedProcessTreeInspection } from '../orchestration/execution/linux-process-tree.js';
import type { AttemptProcessOwnerDoc } from '../orchestration/store/collections.js';
import { readGateDefinition, readGateSteps } from './lib/gate-steps.js';

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const CREATED_AT = new Date('2026-07-27T10:00:00.000Z');
const CHECKED_AT = new Date('2026-07-27T10:00:05.000Z');
const COMPLETED_AT = new Date('2026-07-27T10:00:10.000Z');
const SOURCE = {
  commitSha: 'a'.repeat(40),
  commitTreeSha: 'b'.repeat(40),
  worktreeState: 'CLEAN',
} as const;
const RAW_USER = 'runner-user-must-not-leak';
const RAW_PASSWORD = 'encoded-password-must-not-leak';
const QUERY_TOKEN = 'query-token-must-not-leak';
const RAW_DB = 'production-db-must-not-leak';
const HOST_A = 'private-db-a.internal';
const HOST_B = 'private-db-b.internal';
const RS_NAME = 'private-rs-name';
const TOPOLOGY_URI = `mongodb://${RAW_USER}:${encodeURIComponent(RAW_PASSWORD)}@${HOST_A}:27017,${HOST_B}:27018/${RAW_DB}`
  + `?authSource=admin&replicaSet=${RS_NAME}&tls=true&apiKey=${QUERY_TOKEN}`
  + '&tlsCertificateKeyFile=%2Fsecrets%2Fclient.pem#fragment';
const PARENT_CHALLENGE = 'd'.repeat(64);
const TOPOLOGY_HELLO = {
  isWritablePrimary: true,
  setName: RS_NAME,
  maxWireVersion: 21,
  hosts: [`${HOST_A}:27017`, `${HOST_B}:27018`],
};
const SUMMARY_BYTES = '{"assertions":16,"result":"pass"}\r\n';
const STDOUT_BYTES = 'contract stdout\r\n';
const TRACE_BYTES = [
  JSON.stringify({ sequence: 1, event: 'claim-complete' }),
  JSON.stringify({ sequence: 2, event: 'cleanup-complete' }),
  '',
].join('\r\n');
const SNAPSHOT_BYTES = `${JSON.stringify({
  schemaVersion: RAW_EVIDENCE_SNAPSHOT_VERSION,
  runIdHash: `sha256:${'1'.repeat(64)}`,
  databaseNameHash: `sha256:${'2'.repeat(64)}`,
  totalDocuments: 0,
  collections: [],
})}\r\n`;

const CONTROLLED_RUNTIME_RESOURCES: ParentGuardedRuntimeResourceContract = {
  schemaVersion: TEST_RUNTIME_RESOURCE_CONTRACT_VERSION,
  mode: 'PARENT_GUARDED_V1',
  workspaceOwnershipMode: 'PARENT_PRIVATE_DIRECTORY_V1',
  portOwnershipMode: 'PARENT_BOUND_IPC_HANDOFF_V1',
  processOwnershipMode: 'LINUX_PROCESS_GROUP_TRUSTED_V1',
  nodePermissionMode: 'NODE_PERMISSION_NO_CHILD_PROCESS_V1',
  workspaceRootHash: `sha256:${'1'.repeat(64)}`,
  processExecutionIdHash: `sha256:${'2'.repeat(64)}`,
  runtimeRunIdHash: `sha256:${'3'.repeat(64)}`,
  portLeases: [{
    role: 'primary',
    leaseIdHash: `sha256:${'4'.repeat(64)}`,
    port: 41_111,
  }],
  outbound: {
    mode: 'NODE_EGRESS_GUARD_V1',
    allowedLoopbackPorts: [27_018, 41_111],
    osDefaultDenyProven: false,
    externalRequestAbsenceProven: false,
  },
};

function completeRawEvidenceInputs(): RawEvidenceArtifactInput[] {
  return [
    {
      artifactId: 'normalized-summary',
      kind: 'normalizedSummary',
      mediaType: 'application/json',
      content: SUMMARY_BYTES,
    },
    {
      artifactId: 'stdout',
      kind: 'stdout',
      mediaType: 'text/plain; charset=utf-8',
      content: STDOUT_BYTES,
    },
    {
      artifactId: 'stderr',
      kind: 'stderr',
      mediaType: 'text/plain; charset=utf-8',
      content: '',
    },
    {
      artifactId: 'trace-event-log',
      kind: 'trace',
      mediaType: 'application/x-ndjson',
      content: TRACE_BYTES,
    },
    {
      artifactId: 'db-snapshot',
      kind: 'dbSnapshot',
      mediaType: 'application/json',
      content: SNAPSHOT_BYTES,
    },
  ];
}

function ownerRawEvidenceInputs(): RawEvidenceArtifactInput[] {
  return completeRawEvidenceInputs()
    .filter((artifact) => artifact.artifactId !== 'db-snapshot');
}

interface FakeSnapshotCursor<T> extends AsyncIterable<T> {
  limit(value: number): FakeSnapshotCursor<T>;
  batchSize(value: number): FakeSnapshotCursor<T>;
  toArray(): Promise<T[]>;
}

interface FakeSnapshotStats {
  batchSizes: number[];
  documentCount: number;
  toArrayCalls: number;
}

function fakeSnapshotDatabase(
  documentFactory: () => Iterable<Record<string, unknown>>,
): { db: Db; stats: FakeSnapshotStats } {
  const stats: FakeSnapshotStats = {
    batchSizes: [],
    documentCount: 0,
    toArrayCalls: 0,
  };

  function cursor<T>(
    valueFactory: () => Iterable<T>,
    onValue?: () => void,
  ): FakeSnapshotCursor<T> {
    let fixedLimit = Number.MAX_SAFE_INTEGER;
    const result: FakeSnapshotCursor<T> = {
      limit(value: number) {
        fixedLimit = value;
        return result;
      },
      batchSize(value: number) {
        stats.batchSizes.push(value);
        return result;
      },
      async toArray() {
        stats.toArrayCalls++;
        throw new Error('snapshot cursors must not use toArray');
      },
      async *[Symbol.asyncIterator]() {
        let emitted = 0;
        for (const value of valueFactory()) {
          if (emitted >= fixedLimit) return;
          emitted++;
          onValue?.();
          yield value;
        }
      },
    };
    return result;
  }

  const db = {
    databaseName: 'orch_g0_v1_contract_snapshot',
    listCollections: () => cursor(() => [{ name: 'orch_contract' }]),
    collection: (name: string) => {
      if (name !== 'orch_contract') throw new Error('unexpected fake collection');
      return {
        find: () => cursor(documentFactory, () => {
          stats.documentCount++;
        }),
        listIndexes: () => cursor(() => []),
      };
    },
  } as unknown as Db;
  return { db, stats };
}

async function captureFakeSnapshot(
  documentFactory: () => Iterable<Record<string, unknown>>,
): Promise<{ bytes: Buffer; stats: FakeSnapshotStats }> {
  const fixture = fakeSnapshotDatabase(documentFactory);
  const bytes = await captureAnonymizedMongoSnapshot({
    db: fixture.db,
    expectedDatabaseName: fixture.db.databaseName,
    runId: `g0run_${'c'.repeat(32)}`,
    pseudonymKey: Buffer.alloc(32, 0x5a),
    epoch: CREATED_AT,
  });
  return { bytes, stats: fixture.stats };
}

function ownerInput(
  overrides: Partial<CreateTestRuntimeOwnerForContractCheckInput> = {},
): CreateTestRuntimeOwnerForContractCheckInput {
  return {
    suiteId: 'runtime-contract',
    topologyUri: TOPOLOGY_URI,
    source: SOURCE,
    effectiveConfig: {
      executionProfile: 'DETERMINISTIC',
      runtimeKind: 'CONTRACT_CHECK',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: [],
      laneCount: 4,
      retryLimit: 3,
    },
    seed: 4_242,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function newOwner(overrides: Partial<CreateTestRuntimeOwnerForContractCheckInput> = {}) {
  return createTestRuntimeOwnerForContractCheck(ownerInput(overrides));
}

interface WorkspaceJournalFixture {
  sandbox: string;
  journalRoot: string;
  managedRoot: string;
  store: GateWorkspaceOrphanJournalStore;
  allocation: GateWorkspaceAllocation;
  root: string;
}

interface FixtureNodeSnapshot {
  relativePath: string;
  type: 'DIRECTORY' | 'FILE' | 'SYMLINK' | 'SPECIAL';
  dev: string;
  ino: string;
  uid: string;
  mode: number;
  nlink: string;
  size: string;
  contentHash?: string;
  linkTarget?: string;
}

function removePrivateFixtureTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path, { bigint: true });
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of readdirSync(path)) {
      removePrivateFixtureTree(join(path, name));
    }
    rmdirSync(path);
    return;
  }
  unlinkSync(path);
}

function fixtureTreeSnapshot(root: string): FixtureNodeSnapshot[] {
  const result: FixtureNodeSnapshot[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path, { bigint: true });
    const relativePath = relative(root, path) || '.';
    const type = stat.isDirectory()
      ? 'DIRECTORY'
      : stat.isFile()
        ? 'FILE'
        : stat.isSymbolicLink()
          ? 'SYMLINK'
          : 'SPECIAL';
    const snapshot: FixtureNodeSnapshot = {
      relativePath,
      type,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      uid: stat.uid.toString(),
      mode: Number(stat.mode & 0o7777n),
      nlink: stat.nlink.toString(),
      size: stat.size.toString(),
      ...(type === 'FILE'
        ? {
          contentHash: createHash('sha256')
            .update(readFileSync(path))
            .digest('hex'),
        }
        : {}),
      ...(type === 'SYMLINK' ? { linkTarget: readlinkSync(path) } : {}),
    };
    result.push(snapshot);
    if (type === 'DIRECTORY') {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  };
  visit(root);
  return result;
}

async function createWorkspaceJournalFixture(input: {
  limits?: Partial<{
    maxEntries: number;
    maxDepth: number;
    maxTotalFileBytes: number;
    maxTotalPathBytes: number;
    maxSessions: number;
  }>;
  testing?: GateWorkspaceJournalTestingPorts;
} = {}): Promise<WorkspaceJournalFixture> {
  const sandbox = realpathSync(
    mkdtempSync(join(tmpdir(), 'g0-workspace-journal-contract-')),
  );
  chmodSync(sandbox, 0o700);
  const journalRoot = join(sandbox, 'journal');
  const managedRoot = join(sandbox, 'managed');
  try {
    const store = new GateWorkspaceOrphanJournalStore({
      journalRoot,
      managedRoot,
      ...(input.testing ? { testing: input.testing } : {}),
    });
    const created = await store.createOwnedRoot({
      ...(input.limits ? { limits: input.limits } : {}),
    });
    return {
      sandbox,
      journalRoot,
      managedRoot,
      store,
      allocation: created.allocation,
      root: created.root,
    };
  } catch (error) {
    removePrivateFixtureTree(sandbox);
    throw error;
  }
}

async function bindWorkspaceFixtureOwner(
  fixture: WorkspaceJournalFixture,
): Promise<void> {
  const processExecutionId = 'g0-workspace-contract-execution';
  const runtimeRunId = 'g0-workspace-contract-runtime';
  const workspaceRoot = join(fixture.root, 'session-workspace');
  mkdirSync(workspaceRoot, { mode: 0o700 });
  chmodSync(workspaceRoot, 0o700);
  const session = await fixture.store.registerSession(fixture.allocation, {
    suiteId: 'workspace-contract',
    processExecutionId,
    runtimeRunId,
    workspaceRoot,
  });
  const local = await readLocalProcessHostIdentity();
  const processOwner: AttemptProcessOwnerDoc = {
    processExecutionId,
    runtimeRunId,
    workerInstanceId: 'g0-workspace-contract-worker',
    ownerGeneration: 1,
    attemptFence: 1,
    mode: 'PROCESS_GROUP',
    hostId: local.hostId,
    hostBootId: local.hostBootId,
    pidNamespaceId: local.pidNamespaceId,
    pid: 2_000_000_000,
    pgid: 2_000_000_000,
    sid: 2_000_000_000,
    processStartToken: '999999999999',
    registeredAt: CREATED_AT,
    startedAt: CREATED_AT,
  };
  await fixture.store.bindSessionOwner(
    fixture.allocation,
    session,
    processOwner,
  );
}

async function expectWorkspaceTargetRefusal(
  fixture: WorkspaceJournalFixture,
  expectedReason:
    | 'ROOT_OWNERSHIP_INVALID'
    | 'FILESYSTEM_BOUNDARY_INVALID'
    | 'INVENTORY_LIMIT',
): Promise<void> {
  const before = fixtureTreeSnapshot(fixture.root);
  const result = await fixture.store.cleanupOwned(fixture.allocation);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.verifiedAbsent, false);
  assert.equal(result.reasonCode, expectedReason);
  assert.deepEqual(
    fixtureTreeSnapshot(fixture.root),
    before,
    'a refused workspace cleanup mutated its target',
  );
}

function flipBase64urlCapability(value: string): string {
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  const final = value.at(-1)!;
  return `${value.slice(0, -1)}${final === 'A' ? 'B' : 'A'}`;
}

console.log('check:orchestration-test-runtime');

await check('128-bit run identity internally derives one exact non-reserved database', () => {
  const owner = newOwner();
  assert.match(owner.manifest.runId, /^g0run_[a-f0-9]{32}$/);
  const token = owner.manifest.runId.slice('g0run_'.length);
  assert.equal(owner.databaseName, `${TEST_RUNTIME_DB_PREFIX}${token}`);
  assert.deepEqual(owner.manifest.resources.mongoDatabases, [owner.databaseName]);
  assert.notEqual(newOwner().manifest.runId, owner.manifest.runId);
  assert.equal(validateTestRuntimeManifest(owner.manifest).ok, true);

  for (const forbidden of ['admin', 'local', 'config', 'agentforge', 'orchestration_v2']) {
    assert.throws(
      () => createInMemoryMongoTestHarness(forbidden),
      ForeignTestResourceError,
    );
  }
});

await check('parent runtime resources are exact, challenged and honest about partial isolation', () => {
  const owner = newOwner({
    parentChallenge: 'd'.repeat(64),
    runtimeResources: CONTROLLED_RUNTIME_RESOURCES,
  });
  assert.deepEqual(
    owner.manifest.resources.runtimeResources,
    CONTROLLED_RUNTIME_RESOURCES,
  );
  assert.equal(
    owner.manifest.resources.runtimeResources.outbound.osDefaultDenyProven,
    false,
  );
  assert.equal(
    owner.manifest.resources.runtimeResources.outbound.externalRequestAbsenceProven,
    false,
  );
  assert.equal(validateTestRuntimeManifest(owner.manifest).ok, true);
  assert.throws(
    () => newOwner({ runtimeResources: CONTROLLED_RUNTIME_RESOURCES }),
    /fresh parent challenge/,
  );
  assert.throws(
    () => newOwner({
      parentChallenge: 'e'.repeat(64),
      runtimeResources: {
        ...CONTROLLED_RUNTIME_RESOURCES,
        outbound: {
          ...CONTROLLED_RUNTIME_RESOURCES.outbound,
          allowedLoopbackPorts: [41_111, 27_018],
        },
      },
    }),
    /numerically sorted/,
  );
  assert.throws(
    () => newOwner({
      parentChallenge: 'e'.repeat(64),
      runtimeResources: {
        ...CONTROLLED_RUNTIME_RESOURCES,
        portLeases: [{
          ...CONTROLLED_RUNTIME_RESOURCES.portLeases[0]!,
          port: 41_112,
        }],
      },
    }),
    /absent from the exact allowlist/,
  );
});

await check('node permission args stay read-scoped and never grant child processes', () => {
  const workspaceRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'g0-permission-args-')),
  );
  const readOnlyRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'g0-permission-read-')),
  );
  try {
    const args = buildParentRuntimeNodePermissionArgs({
      workspaceRoot,
      readOnlyPaths: [readOnlyRoot],
      allowWorker: true,
    });
    assert.equal(args[0], '--permission');
    assert.ok(args.includes(`--allow-fs-read=${readOnlyRoot}`));
    // Write authority stays on the exact workspace, and child-process
    // authority is never granted — the suites are precompiled precisely so
    // the child never needs to spawn a transformer.
    assert.deepEqual(
      args.filter((arg) => arg.startsWith('--allow-fs-write=')),
      [`--allow-fs-write=${workspaceRoot}`],
    );
    assert.ok(!args.some((arg) => arg.startsWith('--allow-child-process')));
    const reads = args
      .filter((arg) => arg.startsWith('--allow-fs-read='))
      .map((arg) => arg.slice('--allow-fs-read='.length));
    assert.deepEqual(reads, [...reads].sort());
    assert.equal(new Set(reads).size, reads.length);
  } finally {
    // Both roots are freshly minted and empty; rmdir keeps this check from
    // ever owning a recursive delete.
    rmdirSync(workspaceRoot);
    rmdirSync(readOnlyRoot);
  }
});

await check('parent Mongo allocation binds suite, challenge, topology and secret proof', () => {
  const allocation = createMongoOwnerAllocation({
    suiteId: 'e2e:orchestration-contract',
    parentChallenge: PARENT_CHALLENGE,
    topologyUri: TOPOLOGY_URI,
    topologyHello: TOPOLOGY_HELLO,
    createdAt: CREATED_AT,
  });
  assert.equal(allocation.suiteId, 'e2e:orchestration-contract');
  assert.equal(
    allocation.parentChallengeHash,
    `sha256:${createHash('sha256').update(PARENT_CHALLENGE).digest('hex')}`,
  );
  assert.equal(
    allocation.topologyDescriptorHash,
    hashCanonicalValue(describeMongoTopologyUri(TOPOLOGY_URI)),
  );
  assert.equal(
    allocation.topologyFingerprint,
    mongoTopologyFingerprintFromHello(TOPOLOGY_HELLO),
  );
  assert.equal(
    allocation.runId.slice('g0run_'.length),
    allocation.dbName.slice(TEST_RUNTIME_DB_PREFIX.length),
  );
  assert.equal(mongoOwnerAllocationSchema.safeParse(allocation).success, true);
  assert.ok(!JSON.stringify(allocation).includes(RAW_USER));
  assert.ok(!JSON.stringify(allocation).includes(RAW_PASSWORD));
  assert.ok(!JSON.stringify(allocation).includes(QUERY_TOKEN));

  const wrongDatabase = {
    ...allocation,
    dbName: `${TEST_RUNTIME_DB_PREFIX}${'f'.repeat(32)}`,
  };
  assert.equal(mongoOwnerAllocationSchema.safeParse(wrongDatabase).success, false);
  assert.equal(
    mongoOwnerAllocationSchema.safeParse({ ...allocation, unexpected: true }).success,
    false,
  );

  const claimId = '9'.repeat(64);
  const claimed = createReclaimClaimedMongoOwnerMarker({
    allocation,
    collectionEpochFingerprint: `sha256:${'2'.repeat(64)}`,
    reclaimClaimId: claimId,
    reclaimFence: 1,
    reclaimClaimedAt: CHECKED_AT,
  });
  assert.equal(claimed.state, 'RECLAIM_CLAIMED');
  assert.equal(claimed.reclaimFence, 1);
  assert.equal(claimed.reclaimClaimIdHash, hashCanonicalValue(claimId));
  assert.ok(!JSON.stringify(claimed).includes(claimId));

  const tamperedTopology = {
    ...allocation,
    topologyFingerprint: `sha256:${'e'.repeat(64)}`,
  };
  assert.throws(
    () => createReclaimClaimedMongoOwnerMarker({
      allocation: tamperedTopology,
      collectionEpochFingerprint: `sha256:${'2'.repeat(64)}`,
      reclaimClaimId: claimId,
      reclaimFence: 1,
      reclaimClaimedAt: CHECKED_AT,
    }),
    TestRuntimeOwnershipError,
  );
  const tamperedCapability = {
    ...allocation,
    cleanupCapabilityBase64url:
      `${allocation.cleanupCapabilityBase64url.slice(0, -1)}`
      + `${allocation.cleanupCapabilityBase64url.endsWith('A') ? 'B' : 'A'}`,
  };
  assert.throws(
    () => createReclaimClaimedMongoOwnerMarker({
      allocation: tamperedCapability,
      collectionEpochFingerprint: `sha256:${'2'.repeat(64)}`,
      reclaimClaimId: claimId,
      reclaimFence: 1,
      reclaimClaimedAt: CHECKED_AT,
    }),
    TestRuntimeOwnershipError,
  );
});

await check('Mongo orphan journal is private, exact and rejects tampered inventory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'g0-mongo-journal-contract-')));
  const allocation = createMongoOwnerAllocation({
    suiteId: 'e2e:orchestration-journal',
    parentChallenge: PARENT_CHALLENGE,
    topologyUri: TOPOLOGY_URI,
    topologyHello: TOPOLOGY_HELLO,
    createdAt: CREATED_AT,
  });
  const processOwner: AttemptProcessOwnerDoc = {
    processExecutionId: 'g0-contract-process',
    runtimeRunId: 'g0-contract-runtime',
    workerInstanceId: 'g0-contract-worker',
    ownerGeneration: 1,
    attemptFence: 1,
    mode: 'PROCESS_GROUP',
    hostId: 'contract-host',
    hostBootId: '11111111-1111-1111-1111-111111111111',
    pidNamespaceId: 'pid:[1]',
    pid: 91_001,
    pgid: 91_001,
    sid: 91_001,
    processStartToken: '12345',
    registeredAt: CREATED_AT,
    startedAt: CREATED_AT,
  };
  const entryPath = join(root, `${allocation.runId}.json`);
  try {
    const store = new MongoOrphanJournalStore(root);
    assert.equal(Number(lstatSync(root, { bigint: true }).mode & 0o777n), 0o700);
    assert.deepEqual(store.listEntryFiles(), []);

    const entry = await store.register(allocation, processOwner);
    assert.equal(entry.allocation.suiteId, allocation.suiteId);
    assert.equal(entry.allocation.parentChallengeHash, allocation.parentChallengeHash);
    assert.equal(entry.allocation.topologyDescriptorHash, allocation.topologyDescriptorHash);
    assert.deepEqual(readdirSync(root), [`${allocation.runId}.json`]);
    const stat = lstatSync(entryPath, { bigint: true });
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1n);
    assert.equal(Number(stat.mode & 0o777n), 0o600);
    assert.equal(store.listEntryFiles().length, 1);
    assert.equal(store.read(allocation).value.entryHash, entry.entryHash);

    for (const changed of [
      { ...allocation, suiteId: 'e2e:orchestration-other' },
      { ...allocation, parentChallengeHash: `sha256:${'4'.repeat(64)}` },
      { ...allocation, topologyDescriptorHash: `sha256:${'5'.repeat(64)}` },
    ]) {
      assert.throws(() => store.read(changed));
    }
    await assert.rejects(store.register(allocation, processOwner));

    const tampered = JSON.parse(readFileSync(entryPath, 'utf8')) as {
      allocation: { suiteId: string };
    };
    tampered.allocation.suiteId = 'e2e:orchestration-tampered';
    writeFileSync(entryPath, `${JSON.stringify(tampered)}\n`);
    assert.throws(() => store.listEntryFiles());
  } finally {
    if (existsSync(entryPath)) unlinkSync(entryPath);
    rmdirSync(root);
  }
});

await check('Mongo orphan reclaim report is strict and fallback is fail-closed', () => {
  const failed = failedMongoOrphanReclaimReport();
  assert.deepEqual(mongoOrphanReclaimReportSchema.parse(failed), failed);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.scanComplete, false);
  assert.equal(failed.timedOut, false);
  assert.equal(failed.topologyVerified, false);
  assert.equal(failed.journalRootVerified, false);
  assert.equal(failed.reclaimVerified, false);
  assert.equal(failed.failedCount, 0);
  assert.deepEqual(failed.effects, []);

  assert.equal(
    mongoOrphanReclaimReportSchema.safeParse({ ...failed, unexpected: true }).success,
    false,
  );
  assert.equal(
    mongoOrphanReclaimReportSchema.safeParse({ ...failed, failedCount: -1 }).success,
    false,
  );
  assert.equal(
    mongoOrphanReclaimReportSchema.safeParse({
      ...failed,
      scannedEntries: 65,
    }).success,
    false,
  );
  assert.equal(
    mongoOrphanReclaimReportSchema.safeParse({
      ...failed,
      failedCount: 1,
    }).success,
    false,
  );
  const withoutEffects = { ...failed } as Record<string, unknown>;
  delete withoutEffects.effects;
  assert.equal(mongoOrphanReclaimReportSchema.safeParse(withoutEffects).success, false);
});

await check('gate workspace limits, cleanup and reclaim reports are strict and count-conserving', () => {
  assert.equal(gateWorkspaceLimitsSchema.safeParse({
    maxEntries: 1,
    maxDepth: 1,
    maxTotalFileBytes: 1,
    maxTotalPathBytes: 1,
    maxSessions: 1,
  }).success, true);
  for (const [field, value] of [
    ['maxEntries', 0],
    ['maxDepth', 65],
    ['maxTotalFileBytes', Number.POSITIVE_INFINITY],
    ['maxTotalPathBytes', -1],
    ['maxSessions', 65],
  ] as const) {
    assert.equal(gateWorkspaceLimitsSchema.safeParse({
      maxEntries: 1,
      maxDepth: 1,
      maxTotalFileBytes: 1,
      maxTotalPathBytes: 1,
      maxSessions: 1,
      [field]: value,
    }).success, false);
  }

  const failed = failedGateWorkspaceOrphanReclaimReport();
  assert.deepEqual(gateWorkspaceOrphanReclaimReportSchema.parse(failed), failed);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.reclaimVerified, false);
  assert.equal(failed.scanComplete, false);
  assert.equal(failed.journalRootVerified, false);
  assert.equal(failed.managedRootVerified, false);
  assert.equal(failed.timedOut, false);
  assert.deepEqual(failed.effects, []);

  for (const candidate of [
    { ...failed, unexpected: true },
    { ...failed, scannedEntries: -1 },
    { ...failed, failedCount: 1 },
    { ...failed, scanComplete: true, scannedEntries: 1 },
    {
      ...failed,
      status: 'PASSED',
      journalRootVerified: true,
      managedRootVerified: true,
      scanComplete: true,
      reclaimVerified: true,
      timedOut: true,
    },
  ]) {
    assert.equal(
      gateWorkspaceOrphanReclaimReportSchema.safeParse(candidate).success,
      false,
    );
  }
  assert.equal(
    gateWorkspaceOrphanReclaimReportSchema.safeParse({
      ...failed,
      status: 'PASSED',
      journalRootVerified: true,
      managedRootVerified: true,
      scanComplete: true,
      reclaimVerified: true,
    }).success,
    true,
    'a verified empty scan is a valid count-conserving pass',
  );
  const withoutEffects = { ...failed } as Record<string, unknown>;
  delete withoutEffects.effects;
  assert.equal(
    gateWorkspaceOrphanReclaimReportSchema.safeParse(withoutEffects).success,
    false,
  );

  const refusedCleanup = {
    schemaVersion: 'g0-gate-workspace-cleanup/v1',
    status: 'FAILED',
    verifiedAbsent: false,
    resumed: false,
    entryCount: 0,
    totalFileBytes: 0,
    maxObservedDepth: 0,
    reasonCode: 'INVENTORY_LIMIT',
  } as const;
  assert.deepEqual(
    gateWorkspaceCleanupResultSchema.parse(refusedCleanup),
    refusedCleanup,
  );
  assert.equal(
    gateWorkspaceCleanupResultSchema.safeParse({
      ...refusedCleanup,
      status: 'PASSED',
    }).success,
    false,
  );
  assert.equal(
    gateWorkspaceCleanupResultSchema.safeParse({
      ...refusedCleanup,
      reasonCode: undefined,
    }).success,
    false,
  );
});

await check('gate workspace journal roots and every published authority file stay private and exact', async () => {
  const fixture = await createWorkspaceJournalFixture();
  try {
    assert.equal(
      gateWorkspaceAllocationSchema.safeParse(fixture.allocation).success,
      true,
    );
    assert.equal(fixture.allocation.rootPath, fixture.root);
    assert.equal(realpathSync(fixture.root), fixture.root);
    for (const root of [
      fixture.sandbox,
      fixture.journalRoot,
      fixture.managedRoot,
      fixture.root,
    ]) {
      const stat = lstatSync(root, { bigint: true });
      assert.equal(stat.isDirectory(), true);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(Number(stat.mode & 0o777n), 0o700);
    }
    const markerPath = join(fixture.root, GATE_WORKSPACE_MARKER_NAME);
    const markerStat = lstatSync(markerPath, { bigint: true });
    assert.equal(markerStat.isFile(), true);
    assert.equal(markerStat.isSymbolicLink(), false);
    assert.equal(markerStat.nlink, 1n);
    assert.equal(Number(markerStat.mode & 0o777n), 0o600);

    await bindWorkspaceFixtureOwner(fixture);
    const journalNames = readdirSync(fixture.journalRoot).sort();
    assert.ok(journalNames.some((name) => name.endsWith('.entry.json')));
    assert.ok(journalNames.some((name) => name.endsWith('.binding.json')));
    assert.ok(journalNames.some((name) => name.endsWith('.session.json')));
    assert.ok(journalNames.some((name) => name.endsWith('.owner.json')));
    for (const name of journalNames) {
      const stat = lstatSync(join(fixture.journalRoot, name), { bigint: true });
      assert.equal(stat.isFile(), true, `${name} is not a regular file`);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.nlink, 1n);
      assert.equal(Number(stat.mode & 0o777n), 0o600);
    }

    const cleaned = await fixture.store.cleanupOwned(fixture.allocation);
    assert.equal(cleaned.status, 'PASSED');
    assert.equal(cleaned.verifiedAbsent, true);
    assert.equal(existsSync(fixture.root), false);
    assert.deepEqual(readdirSync(fixture.journalRoot), []);
    assert.deepEqual(readdirSync(fixture.managedRoot), []);
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('gate workspace recovery terminalizes every legal atomic-publication prefix', async () => {
  const journalPair = await createWorkspaceJournalFixture();
  try {
    const entryName = `${journalPair.allocation.workspaceId}.entry.json`;
    const entryPath = join(journalPair.journalRoot, entryName);
    const pairedTempPath = join(
      journalPair.journalRoot,
      `.${entryName}.tmp.${'a'.repeat(64)}`,
    );
    linkSync(entryPath, pairedTempPath);
    assert.equal(lstatSync(entryPath, { bigint: true }).nlink, 2n);
    assert.equal(lstatSync(pairedTempPath, { bigint: true }).nlink, 2n);
    const ownedBefore = fixtureTreeSnapshot(journalPair.root);

    const pairedReport = await journalPair.store.reclaim({
      deadlineMs: 5_000,
    });
    assert.equal(pairedReport.status, 'PASSED');
    assert.equal(pairedReport.activeCount, 1);
    assert.equal(existsSync(pairedTempPath), false);
    assert.equal(lstatSync(entryPath, { bigint: true }).nlink, 1n);
    assert.deepEqual(fixtureTreeSnapshot(journalPair.root), ownedBefore);

    // A losing no-replace publisher can die after EEXIST but before removing
    // its distinct nlink=1 temp. That temp carries no authority and is removed
    // only after the final file and managed inventory have both validated.
    const loserTempPath = join(
      journalPair.journalRoot,
      `.${entryName}.tmp.${'b'.repeat(64)}`,
    );
    writeFileSync(loserTempPath, readFileSync(entryPath), {
      mode: 0o600,
      flag: 'wx',
    });
    assert.notEqual(
      lstatSync(loserTempPath, { bigint: true }).ino,
      lstatSync(entryPath, { bigint: true }).ino,
    );
    const loserReport = await journalPair.store.reclaim({
      deadlineMs: 5_000,
    });
    assert.equal(loserReport.status, 'PASSED');
    assert.equal(loserReport.activeCount, 1);
    assert.equal(existsSync(loserTempPath), false);
    assert.deepEqual(fixtureTreeSnapshot(journalPair.root), ownedBefore);

    const cleaned = await journalPair.store.cleanupOwned(
      journalPair.allocation,
    );
    assert.equal(cleaned.status, 'PASSED');
  } finally {
    removePrivateFixtureTree(journalPair.sandbox);
  }

  const markerPair = await createWorkspaceJournalFixture();
  try {
    unlinkSync(join(
      markerPair.journalRoot,
      `${markerPair.allocation.workspaceId}.binding.json`,
    ));
    const markerPath = join(markerPair.root, GATE_WORKSPACE_MARKER_NAME);
    const markerTempPath = join(
      markerPair.root,
      `.${GATE_WORKSPACE_MARKER_NAME}.tmp.${'c'.repeat(64)}`,
    );
    linkSync(markerPath, markerTempPath);
    assert.equal(lstatSync(markerPath, { bigint: true }).nlink, 2n);
    const reclaimer = new GateWorkspaceOrphanJournalStore({
      journalRoot: markerPair.journalRoot,
      managedRoot: markerPair.managedRoot,
      testing: { processIsLive: () => false },
    });
    const report = await reclaimer.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'PASSED');
    assert.equal(report.reclaimedCount, 1);
    assert.equal(existsSync(markerPair.root), false);
    assert.deepEqual(readdirSync(markerPair.journalRoot), []);
    assert.deepEqual(readdirSync(markerPair.managedRoot), []);
  } finally {
    removePrivateFixtureTree(markerPair.sandbox);
  }

  const markerTempOnly = await createWorkspaceJournalFixture();
  try {
    unlinkSync(join(
      markerTempOnly.journalRoot,
      `${markerTempOnly.allocation.workspaceId}.binding.json`,
    ));
    const markerPath = join(
      markerTempOnly.root,
      GATE_WORKSPACE_MARKER_NAME,
    );
    const markerTempPath = join(
      markerTempOnly.root,
      `.${GATE_WORKSPACE_MARKER_NAME}.tmp.${'d'.repeat(64)}`,
    );
    renameSync(markerPath, markerTempPath);
    assert.equal(existsSync(markerPath), false);
    assert.equal(lstatSync(markerTempPath, { bigint: true }).nlink, 1n);
    const reclaimer = new GateWorkspaceOrphanJournalStore({
      journalRoot: markerTempOnly.journalRoot,
      managedRoot: markerTempOnly.managedRoot,
      testing: { processIsLive: () => false },
    });
    const report = await reclaimer.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'PASSED');
    assert.equal(report.reclaimedCount, 1);
    assert.equal(existsSync(markerTempOnly.root), false);
    assert.deepEqual(readdirSync(markerTempOnly.journalRoot), []);
    assert.deepEqual(readdirSync(markerTempOnly.managedRoot), []);
  } finally {
    removePrivateFixtureTree(markerTempOnly.sandbox);
  }
});

await check('gate workspace reclaim skips an exact live owner without an age threshold', async () => {
  const fixture = await createWorkspaceJournalFixture();
  try {
    const report = await fixture.store.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'PASSED');
    assert.equal(report.reclaimVerified, true);
    assert.equal(report.scanComplete, true);
    assert.equal(report.scannedEntries, 1);
    assert.equal(report.activeCount, 1);
    assert.equal(report.effects.length, 1);
    assert.equal(report.effects[0]?.outcome, 'ACTIVE_SKIPPED');
    assert.equal(report.effects[0]?.reasonCode, 'OWNER_ACTIVE');
    assert.equal(existsSync(fixture.root), true);

    const cleaned = await fixture.store.cleanupOwned(fixture.allocation);
    assert.equal(cleaned.status, 'PASSED');
    assert.equal(cleaned.verifiedAbsent, true);
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('gate workspace reclaim fails closed on foreign, unknown and unverifiable inventory', async () => {
  const unknownJournal = await createWorkspaceJournalFixture();
  try {
    writeFileSync(join(unknownJournal.journalRoot, 'foreign.json'), '{}\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const before = fixtureTreeSnapshot(unknownJournal.root);
    const report = await unknownJournal.store.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'FAILED');
    assert.equal(report.reclaimVerified, false);
    assert.equal(report.scanComplete, false);
    assert.deepEqual(fixtureTreeSnapshot(unknownJournal.root), before);
  } finally {
    removePrivateFixtureTree(unknownJournal.sandbox);
  }

  const foreignManaged = await createWorkspaceJournalFixture();
  try {
    const foreignRoot = join(foreignManaged.managedRoot, 'foreign-workspace');
    mkdirSync(foreignRoot, { mode: 0o700 });
    writeFileSync(join(foreignRoot, 'canary'), 'foreign\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const beforeOwned = fixtureTreeSnapshot(foreignManaged.root);
    const beforeForeign = fixtureTreeSnapshot(foreignRoot);
    const report = await foreignManaged.store.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'FAILED');
    assert.equal(report.reclaimVerified, false);
    assert.equal(report.managedRootVerified, false);
    assert.deepEqual(fixtureTreeSnapshot(foreignManaged.root), beforeOwned);
    assert.deepEqual(fixtureTreeSnapshot(foreignRoot), beforeForeign);
  } finally {
    removePrivateFixtureTree(foreignManaged.sandbox);
  }

  const unknownOwner = await createWorkspaceJournalFixture({
    testing: {
      processIsLive: () => {
        throw new Error('injected liveness uncertainty');
      },
    },
  });
  try {
    const before = fixtureTreeSnapshot(unknownOwner.root);
    const report = await unknownOwner.store.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'FAILED');
    assert.equal(report.reclaimVerified, false);
    assert.equal(report.unsafeCount, 1);
    assert.equal(report.effects[0]?.outcome, 'UNSAFE_RETAINED');
    assert.equal(
      report.effects[0]?.reasonCode,
      'OWNER_LIVENESS_UNPROVEN',
    );
    assert.deepEqual(fixtureTreeSnapshot(unknownOwner.root), before);
  } finally {
    removePrivateFixtureTree(unknownOwner.sandbox);
  }
});

await check('gate workspace cleanup refuses wrong HMAC authority and marker tamper before mutation', async () => {
  const wrongCapability = await createWorkspaceJournalFixture();
  try {
    const replacementCapability = flipBase64urlCapability(
      wrongCapability.allocation.cleanupCapability,
    );
    const forgedAllocation = {
      ...wrongCapability.allocation,
      cleanupCapability: replacementCapability,
      cleanupCapabilityHash: hashCanonicalValue(replacementCapability),
    };
    assert.equal(
      gateWorkspaceAllocationSchema.safeParse(forgedAllocation).success,
      true,
      'the wrong capability fixture must cross structural validation',
    );
    const before = fixtureTreeSnapshot(wrongCapability.root);
    const result = await wrongCapability.store.cleanupOwned(forgedAllocation);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.verifiedAbsent, false);
    assert.ok(
      result.reasonCode === 'ROOT_OWNERSHIP_INVALID'
      || result.reasonCode === 'COMMAND_FAILED',
    );
    assert.deepEqual(fixtureTreeSnapshot(wrongCapability.root), before);
  } finally {
    removePrivateFixtureTree(wrongCapability.sandbox);
  }

  const markerTamper = await createWorkspaceJournalFixture();
  try {
    const markerPath = join(markerTamper.root, GATE_WORKSPACE_MARKER_NAME);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      proof?: unknown;
    };
    assert.equal(typeof marker.proof, 'string');
    const proof = marker.proof as string;
    marker.proof = `${proof.slice(0, -1)}${proof.endsWith('0') ? '1' : '0'}`;
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
    await expectWorkspaceTargetRefusal(
      markerTamper,
      'ROOT_OWNERSHIP_INVALID',
    );
  } finally {
    removePrivateFixtureTree(markerTamper.sandbox);
  }
});

await check('gate workspace cleanup never follows a renamed or recreated root inode', async () => {
  const fixture = await createWorkspaceJournalFixture();
  try {
    const movedRoot = join(
      fixture.managedRoot,
      `${fixture.allocation.rootName}-moved`,
    );
    renameSync(fixture.root, movedRoot);
    mkdirSync(fixture.root, { mode: 0o700 });
    writeFileSync(join(fixture.root, 'foreign-canary'), 'foreign replacement\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const movedBefore = fixtureTreeSnapshot(movedRoot);
    const replacementBefore = fixtureTreeSnapshot(fixture.root);
    const result = await fixture.store.cleanupOwned(fixture.allocation);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.verifiedAbsent, false);
    assert.ok(
      result.reasonCode === 'ROOT_OWNERSHIP_INVALID'
      || result.reasonCode === 'COMMAND_FAILED',
    );
    assert.deepEqual(fixtureTreeSnapshot(movedRoot), movedBefore);
    assert.deepEqual(fixtureTreeSnapshot(fixture.root), replacementBefore);
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('gate workspace cleanup unlinks a symlink leaf without following its foreign target', async () => {
  const fixture = await createWorkspaceJournalFixture();
  try {
    const foreignTarget = join(fixture.sandbox, 'foreign-symlink-target');
    writeFileSync(foreignTarget, 'foreign target must survive\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const targetBefore = fixtureTreeSnapshot(foreignTarget);
    symlinkSync(foreignTarget, join(fixture.root, 'foreign-link'));

    const result = await fixture.store.cleanupOwned(fixture.allocation);
    assert.equal(result.status, 'PASSED');
    assert.equal(result.verifiedAbsent, true);
    assert.equal(existsSync(fixture.root), false);
    assert.deepEqual(fixtureTreeSnapshot(foreignTarget), targetBefore);
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('gate workspace cleanup refuses special nodes and hardlinks before target mutation', async () => {
  const special = await createWorkspaceJournalFixture();
  try {
    writeFileSync(join(special.root, 'ordinary-canary'), 'ordinary\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const fifoPath = join(special.root, 'special.fifo');
    execFileSync('/usr/bin/mkfifo', [fifoPath], {
      stdio: 'ignore',
      timeout: 2_000,
    });
    assert.equal(lstatSync(fifoPath).isFIFO(), true);
    await expectWorkspaceTargetRefusal(
      special,
      'FILESYSTEM_BOUNDARY_INVALID',
    );
  } finally {
    removePrivateFixtureTree(special.sandbox);
  }

  const hardlink = await createWorkspaceJournalFixture();
  try {
    const first = join(hardlink.root, 'hardlink-first');
    writeFileSync(first, 'shared inode\n', { mode: 0o600, flag: 'wx' });
    linkSync(first, join(hardlink.root, 'hardlink-second'));
    assert.equal(lstatSync(first, { bigint: true }).nlink, 2n);
    await expectWorkspaceTargetRefusal(
      hardlink,
      'FILESYSTEM_BOUNDARY_INVALID',
    );
  } finally {
    removePrivateFixtureTree(hardlink.sandbox);
  }
});

await check('gate workspace cleanup refuses an injected mount-id boundary before mutation', async () => {
  let mismatchedPath: string | undefined;
  const fixture = await createWorkspaceJournalFixture({
    testing: {
      readMountId: (fd) => {
        const openedPath = readlinkSync(`/proc/self/fd/${fd}`)
          .replace(/ \(deleted\)$/, '');
        return openedPath === mismatchedPath ? '2' : '1';
      },
    },
  });
  try {
    mismatchedPath = join(fixture.root, 'mount-boundary');
    mkdirSync(mismatchedPath, { mode: 0o700 });
    writeFileSync(join(mismatchedPath, 'canary'), 'mounted foreign data\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await expectWorkspaceTargetRefusal(
      fixture,
      'FILESYSTEM_BOUNDARY_INVALID',
    );
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('gate workspace inventory enforces bounded depth, count and bytes before mutation', async () => {
  const countBound = await createWorkspaceJournalFixture({
    limits: { maxEntries: 2 },
  });
  try {
    writeFileSync(join(countBound.root, 'count-a'), 'a', {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(join(countBound.root, 'count-b'), 'b', {
      mode: 0o600,
      flag: 'wx',
    });
    await expectWorkspaceTargetRefusal(countBound, 'INVENTORY_LIMIT');
  } finally {
    removePrivateFixtureTree(countBound.sandbox);
  }

  const depthBound = await createWorkspaceJournalFixture({
    limits: { maxDepth: 1 },
  });
  try {
    const first = join(depthBound.root, 'depth-one');
    mkdirSync(first, { mode: 0o700 });
    mkdirSync(join(first, 'depth-two'), { mode: 0o700 });
    await expectWorkspaceTargetRefusal(depthBound, 'INVENTORY_LIMIT');
  } finally {
    removePrivateFixtureTree(depthBound.sandbox);
  }

  const bytesBound = await createWorkspaceJournalFixture({
    limits: { maxTotalFileBytes: 1 },
  });
  try {
    writeFileSync(join(bytesBound.root, 'oversized'), '12', {
      mode: 0o600,
      flag: 'wx',
    });
    await expectWorkspaceTargetRefusal(bytesBound, 'INVENTORY_LIMIT');
  } finally {
    removePrivateFixtureTree(bytesBound.sandbox);
  }
});

await check('gate workspace deletion plan durably resumes from an exact missing-node subset', async () => {
  const fixture = await createWorkspaceJournalFixture();
  try {
    const nested = join(fixture.root, 'nested');
    mkdirSync(nested, { mode: 0o700 });
    writeFileSync(join(nested, 'first'), 'first\n', {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(join(nested, 'second'), 'second\n', {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(join(fixture.root, 'third'), 'third\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const originalNodeCount = fixtureTreeSnapshot(fixture.root).length;
    let crashHookCalls = 0;
    await assert.rejects(
      fixture.store.cleanupOwned(fixture.allocation, {
        afterFirstRemoval: () => {
          crashHookCalls++;
          throw new Error('injected crash after first planned removal');
        },
      }),
      /injected crash after first planned removal/,
    );
    assert.equal(crashHookCalls, 1);
    assert.equal(existsSync(fixture.root), false);
    const quarantineNames = readdirSync(fixture.managedRoot)
      .filter((name) => name.startsWith('.orch-g0-gate-quarantine-'));
    assert.equal(quarantineNames.length, 1);
    const quarantineRoot = join(fixture.managedRoot, quarantineNames[0]!);
    assert.ok(
      fixtureTreeSnapshot(quarantineRoot).length < originalNodeCount,
      'the crash window did not leave an exact partial-plan subset',
    );
    assert.ok(
      readdirSync(fixture.journalRoot).some((name) => name.endsWith('.plan.json')),
    );
    assert.ok(
      readdirSync(fixture.journalRoot).some((name) => name.endsWith('.claim.json')),
    );

    const resumedStore = new GateWorkspaceOrphanJournalStore({
      journalRoot: fixture.journalRoot,
      managedRoot: fixture.managedRoot,
      testing: { processIsLive: () => false },
    });
    const report = await resumedStore.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'PASSED');
    assert.equal(report.reclaimVerified, true);
    assert.equal(report.scannedEntries, 1);
    assert.equal(report.reclaimedCount, 1);
    assert.equal(report.effects[0]?.outcome, 'RECLAIMED');
    assert.equal(existsSync(fixture.root), false);
    assert.deepEqual(readdirSync(fixture.managedRoot), []);
    assert.deepEqual(readdirSync(fixture.journalRoot), []);
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('a reclaimer recovers its exact claim after final-link temp cleanup', async () => {
  let livenessCalls = 0;
  let publicationHookCalls = 0;
  const fixture = await createWorkspaceJournalFixture({
    testing: {
      processIsLive: () => {
        livenessCalls++;
        // The first probe is the dead workspace parent. The second validates
        // the exact current-process claim which survived final-link publication
        // while its temp name was concurrently terminalized.
        return livenessCalls === 2;
      },
      afterClaimPublicationLink: ({ tempPath }) => {
        publicationHookCalls++;
        unlinkSync(tempPath);
      },
    },
  });
  try {
    writeFileSync(join(fixture.root, 'publication-race-canary'), 'owned\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const report = await fixture.store.reclaim({ deadlineMs: 5_000 });
    assert.equal(publicationHookCalls, 1);
    assert.equal(report.status, 'PASSED');
    assert.equal(report.reclaimVerified, true);
    assert.equal(report.reclaimedCount, 1);
    assert.equal(report.claimedByLiveReclaimerCount, 0);
    assert.equal(report.effects[0]?.outcome, 'RECLAIMED');
    assert.equal(existsSync(fixture.root), false);
    assert.deepEqual(readdirSync(fixture.journalRoot), []);
    assert.deepEqual(readdirSync(fixture.managedRoot), []);
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('concurrent same-process reclaimers cannot co-own one live claim', async () => {
  let secondInvocationActive = false;
  let secondInvocationLivenessCalls = 0;
  let enteredRemoval!: () => void;
  let releaseRemoval!: () => void;
  const removalEntered = new Promise<void>((resolve) => {
    enteredRemoval = resolve;
  });
  const removalReleased = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  const fixture = await createWorkspaceJournalFixture({
    testing: {
      processIsLive: () => {
        if (!secondInvocationActive) return false;
        secondInvocationLivenessCalls++;
        // The second invocation first sees the dead workspace parent, then the
        // first invocation's exact live claim. It must report CLAIMED rather
        // than treating a shared PID as proof of claim ownership.
        return secondInvocationLivenessCalls === 2;
      },
    },
  });
  try {
    writeFileSync(join(fixture.root, 'parallel-claim-canary'), 'owned\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const first = fixture.store.reclaim({
      deadlineMs: 5_000,
      hooks: {
        afterFirstRemoval: async () => {
          enteredRemoval();
          await removalReleased;
        },
      },
    });
    await removalEntered;

    secondInvocationActive = true;
    const second = await fixture.store.reclaim({ deadlineMs: 5_000 });
    assert.equal(second.status, 'PASSED');
    assert.equal(second.reclaimVerified, true);
    assert.equal(second.reclaimedCount, 0);
    assert.equal(second.claimedByLiveReclaimerCount, 1);
    assert.equal(second.effects[0]?.outcome, 'CLAIMED_BY_LIVE_RECLAIMER');

    secondInvocationActive = false;
    releaseRemoval();
    const firstReport = await first;
    assert.equal(firstReport.status, 'PASSED');
    assert.equal(firstReport.reclaimVerified, true);
    assert.equal(firstReport.reclaimedCount, 1);
    assert.equal(firstReport.claimedByLiveReclaimerCount, 0);
    assert.equal(firstReport.effects[0]?.outcome, 'RECLAIMED');
    assert.equal(existsSync(fixture.root), false);
    assert.deepEqual(readdirSync(fixture.journalRoot), []);
    assert.deepEqual(readdirSync(fixture.managedRoot), []);
  } finally {
    releaseRemoval?.();
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('claim-only workspace authority never deletes a recreated existing target', async () => {
  const fixture = await createWorkspaceJournalFixture();
  try {
    writeFileSync(join(fixture.root, 'owned-before-cleanup'), 'owned\n', {
      mode: 0o600,
      flag: 'wx',
    });
    let terminalHookCalls = 0;
    await assert.rejects(
      fixture.store.cleanupOwned(fixture.allocation, {
        afterJournalUnlinkBeforeClaimRelease: () => {
          terminalHookCalls++;
          mkdirSync(fixture.root, { mode: 0o700 });
          chmodSync(fixture.root, 0o700);
          writeFileSync(join(fixture.root, 'foreign-recreated-canary'), 'foreign\n', {
            mode: 0o600,
            flag: 'wx',
          });
          throw new Error('injected crash in claim-only window');
        },
      }),
      /injected crash in claim-only window/,
    );
    assert.equal(terminalHookCalls, 1);
    const claimOnlyNames = readdirSync(fixture.journalRoot);
    assert.equal(claimOnlyNames.length, 1);
    assert.match(claimOnlyNames[0]!, /\.claim\.json$/);
    const before = fixtureTreeSnapshot(fixture.root);

    const resumedStore = new GateWorkspaceOrphanJournalStore({
      journalRoot: fixture.journalRoot,
      managedRoot: fixture.managedRoot,
      testing: { processIsLive: () => false },
    });
    const report = await resumedStore.reclaim({ deadlineMs: 5_000 });
    assert.equal(report.status, 'FAILED');
    assert.equal(report.reclaimVerified, false);
    assert.equal(report.scannedEntries, 1);
    assert.equal(report.unsafeCount, 1);
    assert.equal(report.effects[0]?.outcome, 'UNSAFE_RETAINED');
    assert.equal(
      report.effects[0]?.reasonCode,
      'ROOT_OWNERSHIP_INVALID',
    );
    assert.deepEqual(fixtureTreeSnapshot(fixture.root), before);
    assert.deepEqual(readdirSync(fixture.journalRoot), claimOnlyNames);
  } finally {
    removePrivateFixtureTree(fixture.sandbox);
  }
});

await check('side-effect ledger classifies containment independently of the guard verdict', () => {
  const SOURCE_AUDIT_HASH = `sha256:${'a'.repeat(64)}` as const;
  const auditEvent = (
    sequence: number,
    eventType: RuntimeResourceAuditEvent['eventType'],
    decision: 'ALLOW' | 'DENY',
    operation: string,
    details: RuntimeResourceAuditEvent['details'],
  ): RuntimeResourceAuditEvent => ({
    schemaVersion: PARENT_RUNTIME_AUDIT_VERSION,
    sequence,
    eventType,
    decision,
    operation,
    policyHash: `sha256:${'0'.repeat(64)}`,
    challengeHash: `sha256:${'1'.repeat(64)}`,
    details,
  });

  // Loopback-only run: an allowlisted connect, a denied external connect and a
  // denied child-process attempt are all contained.
  const contained = deriveSideEffectLedger(
    [
      auditEvent(1, 'BOOTSTRAP', 'ALLOW', 'runtime-resource-guard.bootstrap', {}),
      auditEvent(2, 'ACCESS_ALLOWED', 'ALLOW', 'net.Socket.connect', { hostKind: 'LOOPBACK', port: 27_018 }),
      auditEvent(3, 'ACCESS_DENIED', 'DENY', 'net.Socket.connect', { reason: 'NON_LOOPBACK_DESTINATION', hostKind: 'EXTERNAL_OR_UNRESOLVED' }),
      auditEvent(4, 'ACCESS_DENIED', 'DENY', 'child_process.spawn', { reason: 'CHILD_PROCESS_DENIED' }),
    ],
    [27_018],
    SOURCE_AUDIT_HASH,
  );
  assert.equal(contained.schemaVersion, RUNTIME_SIDE_EFFECT_LEDGER_VERSION);
  assert.equal(contained.sourceAuditHash, SOURCE_AUDIT_HASH);
  assert.equal(contained.containmentStatus, 'CONTAINED');
  assert.equal(contained.summary.externalEffectCount, 0);
  assert.equal(contained.summary.networkAllowedLoopback, 1);
  assert.equal(contained.summary.networkDenied, 1);
  assert.equal(contained.summary.deniedCapabilities, 1);
  // BOOTSTRAP is lifecycle, not a side-effect, so it is not a ledger entry.
  assert.equal(contained.entries.length, 3);

  // An ALLOWED connect to a non-allowlisted port escapes even with zero denials.
  const escapedPort = deriveSideEffectLedger(
    [auditEvent(1, 'ACCESS_ALLOWED', 'ALLOW', 'net.Socket.connect', { hostKind: 'LOOPBACK', port: 9999 })],
    [27_018],
    SOURCE_AUDIT_HASH,
  );
  assert.equal(escapedPort.containmentStatus, 'ESCAPED');
  assert.equal(escapedPort.summary.externalEffectCount, 1);

  // An ALLOWED non-loopback connect escapes.
  const escapedHost = deriveSideEffectLedger(
    [auditEvent(1, 'ACCESS_ALLOWED', 'ALLOW', 'net.Socket.connect', { hostKind: 'EXTERNAL', port: 27_018 })],
    [27_018],
    SOURCE_AUDIT_HASH,
  );
  assert.equal(escapedHost.containmentStatus, 'ESCAPED');

  // An ALLOWED capability that is neither net nor dns is anomalous → escaped.
  const escapedCapability = deriveSideEffectLedger(
    [auditEvent(1, 'ACCESS_ALLOWED', 'ALLOW', 'child_process.spawn', {})],
    [27_018],
    SOURCE_AUDIT_HASH,
  );
  assert.equal(escapedCapability.containmentStatus, 'ESCAPED');

  // Unsafe label fields are dropped so the ledger cannot smuggle raw data.
  const sanitized = deriveSideEffectLedger(
    [auditEvent(1, 'ACCESS_DENIED', 'DENY', 'net.Socket.connect', {
      reason: 'secret-host.example.com/path',
      hostKind: 'loopback',
    })],
    [27_018],
    SOURCE_AUDIT_HASH,
  );
  assert.equal(sanitized.entries[0]?.reason, undefined);
  assert.equal(sanitized.entries[0]?.hostKind, undefined);

  // An escaped ledger must fail resource validation and be retained in evidence,
  // so pin the wiring the pure derivation above cannot exercise on its own.
  const parentRuntimeSource = readFileSync(
    new URL(
      '../orchestration/testing/parent-runtime-resources.js',
      import.meta.url,
    ).pathname.replace(/\.js$/, '.ts'),
    'utf8',
  );
  assert.match(
    parentRuntimeSource,
    /sideEffectLedger\.containmentStatus === 'CONTAINED'/,
  );
  assert.match(parentRuntimeSource, /sideEffectLedger,/);
});

await check('public manifest contains descriptor hashes only and no URI/config secrets', () => {
  const owner = newOwner();
  const serialized = JSON.stringify(owner.manifest);
  for (const forbidden of [
    'mongodb://',
    RAW_USER,
    RAW_PASSWORD,
    QUERY_TOKEN,
    RAW_DB,
    HOST_A,
    HOST_B,
    RS_NAME,
    'authSource',
    'tlsCertificateKeyFile',
    '/secrets/client.pem',
  ]) {
    assert.ok(!serialized.includes(forbidden), `manifest leaked a forbidden value`);
  }
  assert.match(owner.manifest.topology.endpointSetHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(owner.manifest.topology.declaredReplicaSetHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(owner.manifest.topology.tlsMode, 'ENABLED');
});

await check('effective config is allowlisted; source and canonical hashing fail closed', () => {
  const baseConfig = ownerInput().effectiveConfig;
  for (const forbiddenKey of ['apiKey', 'token', 'auth', 'cookie', 'dsn', 'connectionString']) {
    assert.throws(
      () => newOwner({
        effectiveConfig: { ...baseConfig, [forbiddenKey]: 'do-not-hash-me' } as never,
      }),
    );
  }
  assert.throws(
    () => newOwner({ source: { ...SOURCE, commitSha: 'abc1234' } }),
  );

  const first = newOwner({ effectiveConfig: { ...baseConfig, laneCount: 4 } });
  const same = newOwner({ effectiveConfig: { ...baseConfig, laneCount: 4 } });
  const changed = newOwner({ effectiveConfig: { ...baseConfig, laneCount: 5 } });
  assert.equal(first.manifest.configHash, same.manifest.configHash);
  assert.notEqual(first.manifest.configHash, changed.manifest.configHash);

  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.throws(() => hashCanonicalValue(sparse), /sparse arrays/);
  const prototypeSensitive = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(prototypeSensitive, '__proto__', {
    value: 'forbidden',
    enumerable: true,
  });
  assert.throws(() => hashCanonicalValue(prototypeSensitive), /prototype-sensitive/);
});

await check('public manifest integrity is not mistaken for cleanup authority', async () => {
  const owner = newOwner();
  const forged = structuredClone(owner.manifest);
  forged.runId = `g0run_${'f'.repeat(32)}`;
  forged.dbName = `${TEST_RUNTIME_DB_PREFIX}${'f'.repeat(32)}`;
  forged.resources.mongoDatabases = [forged.dbName];
  const { manifestHash: _oldHash, ...unsigned } = forged;
  forged.manifestHash = hashCanonicalValue(unsigned);
  assert.equal(validateTestRuntimeManifest(forged).ok, true, 'a public hash is forgeable by design');
  assert.equal('cleanupMongoDatabase' in forged, false, 'the public document carries no capability');

  const structuralFake = Object.freeze({
    databaseName: owner.databaseName,
  }) as MongoTestDatabaseHandle;
  assert.throws(
    () => owner.claimMongoDatabase(structuralFake),
    ForeignTestResourceError,
  );

  const clientA = new MongoClient('mongodb://127.0.0.1:27018');
  const clientB = new MongoClient('mongodb://127.0.0.1:27018');
  try {
    assert.throws(
      () => bindMongoTestDatabase(clientA, clientB.db(owner.databaseName)),
      ForeignTestResourceError,
    );
  } finally {
    await Promise.all([clientA.close(), clientB.close()]);
  }
});

await check('owner marker is the first write and a pre-existing database is refused', async () => {
  const owner = newOwner();
  const harness = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  harness.seedForeignCollection();
  await assert.rejects(
    owner.claimMongoDatabase(harness.handle),
    ForeignTestResourceError,
  );
  assert.equal(harness.inspect().dropCalls, 0);
  assert.deepEqual(harness.inspect().collectionNames, ['foreign_data']);
});

await check('claim writes one HMAC-authenticated ACTIVE marker and safe receipt', async () => {
  const owner = newOwner();
  const harness = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  const [receipt, concurrentReceipt] = await Promise.all([
    owner.claimMongoDatabase(harness.handle),
    owner.claimMongoDatabase(harness.handle),
  ]);
  assert.deepEqual(concurrentReceipt, receipt);
  const state = harness.inspect();
  assert.equal(state.exists, true);
  assert.deepEqual(state.collectionNames, ['__g0_run_owner']);
  assert.equal((state.marker as Record<string, unknown>).state, 'ACTIVE');
  assert.match((state.marker as Record<string, unknown>).proof as string, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.resourceId, owner.databaseName);
  assert.equal(receipt.runId, owner.manifest.runId);
  assert.ok(!JSON.stringify(receipt).includes('hmac-sha256:'), 'receipt must not expose reusable marker proof');
});

await check('concurrent claim/cleanup cannot lend an in-flight attestation to another handle', async () => {
  const owner = newOwner();
  const primary = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  const foreignHandle = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  const claim = owner.claimMongoDatabase(primary.handle);
  assert.throws(
    () => owner.claimMongoDatabase(foreignHandle.handle),
    TestRuntimeStateError,
  );
  await claim;

  const cleanup = owner.cleanupMongoDatabase(primary.handle);
  assert.throws(
    () => owner.cleanupMongoDatabase(foreignHandle.handle),
    TestRuntimeStateError,
  );
  await cleanup;
  assert.equal(primary.inspect().dropCalls, 1);
  assert.equal(foreignHandle.inspect().dropCalls, 0);
});

await check('missing or tampered marker fails closed before drop', async () => {
  for (const mutation of ['MISSING', 'PROOF', 'RUN'] as const) {
    const owner = newOwner();
    const harness = createInMemoryMongoTestHarness(owner.databaseName, {
      setName: RS_NAME,
      members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
    });
    await owner.claimMongoDatabase(harness.handle);
    if (mutation === 'MISSING') {
      harness.replaceMarker(null);
    } else if (mutation === 'PROOF') {
      harness.mutateMarker((marker) => {
        const proof = marker.proof as string;
        marker.proof = `${proof.slice(0, -1)}${proof.endsWith('0') ? '1' : '0'}`;
      });
    } else {
      harness.mutateMarker((marker) => {
        marker.runId = `g0run_${'e'.repeat(32)}`;
      });
    }
    await assert.rejects(
      owner.cleanupMongoDatabase(harness.handle),
      TestRuntimeOwnershipError,
    );
    assert.equal(harness.inspect().dropCalls, 0);
    assert.equal(harness.inspect().exists, true);
  }
});

await check('database and topology binding reject cross-run/copy attacks', async () => {
  const ownerA = newOwner();
  const ownerB = newOwner();
  const harnessA = createInMemoryMongoTestHarness(ownerA.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  const harnessB = createInMemoryMongoTestHarness(ownerB.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await ownerA.claimMongoDatabase(harnessA.handle);
  harnessB.seedForeignCollection('__g0_run_owner');
  harnessB.replaceMarker(harnessA.inspect().marker);

  assert.throws(
    () => ownerA.cleanupMongoDatabase(harnessB.handle),
    ForeignTestResourceError,
  );
  assert.equal(harnessB.inspect().dropCalls, 0);

  const replayHarness = createInMemoryMongoTestHarness(ownerA.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  replayHarness.seedForeignCollection('__g0_run_owner');
  replayHarness.replaceMarker(harnessA.inspect().marker);
  await assert.rejects(
    ownerA.cleanupMongoDatabase(replayHarness.handle),
    TestRuntimeOwnershipError,
  );
  assert.equal(replayHarness.inspect().dropCalls, 0, 'a copied marker cannot authorize a new DB incarnation');

  harnessA.setTopology({
    setName: 'another-rs',
    members: ['other-db:27017'],
  });
  await assert.rejects(
    ownerA.cleanupMongoDatabase(harnessA.handle),
    TestRuntimeTopologyError,
  );
  assert.equal(harnessA.inspect().dropCalls, 0);
});

await check('lost cleanup CAS refuses deletion and preserves data', async () => {
  const owner = newOwner();
  const harness = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await owner.claimMongoDatabase(harness.handle);
  harness.setClaimBehavior('LOSE_CAS');
  await assert.rejects(
    owner.cleanupMongoDatabase(harness.handle),
    TestRuntimeOwnershipError,
  );
  assert.equal(harness.inspect().claimCalls, 1);
  assert.equal(harness.inspect().dropCalls, 0);
  assert.equal(harness.inspect().exists, true);

  const preclaimedOwner = newOwner();
  const preclaimedHarness = createInMemoryMongoTestHarness(preclaimedOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await preclaimedOwner.claimMongoDatabase(preclaimedHarness.handle);
  preclaimedHarness.mutateMarker((marker) => {
    marker.state = 'CLEANUP_CLAIMED';
    marker.cleanupClaimedAt = CHECKED_AT.toISOString();
  });
  await assert.rejects(
    preclaimedOwner.cleanupMongoDatabase(preclaimedHarness.handle),
    TestRuntimeOwnershipError,
  );
  assert.equal(preclaimedHarness.inspect().dropCalls, 0);
  assert.equal(preclaimedHarness.inspect().exists, true);
});

await check('two concurrent cleanups share one CAS/drop and later cleanup re-observes absence', async () => {
  const owner = newOwner();
  const harness = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await owner.claimMongoDatabase(harness.handle);
  const [left, right] = await Promise.all([
    owner.cleanupMongoDatabase(harness.handle, { now: () => CHECKED_AT }),
    owner.cleanupMongoDatabase(harness.handle, { now: () => CHECKED_AT }),
  ]);
  assert.deepEqual(left, right);
  assert.equal(left.outcome, 'CLEANED');
  assert.equal(harness.inspect().claimCalls, 1);
  assert.equal(harness.inspect().dropCalls, 1);

  const repeat = await owner.cleanupMongoDatabase(harness.handle, { now: () => CHECKED_AT });
  assert.equal(repeat.outcome, 'ALREADY_ABSENT');
  assert.equal(harness.inspect().dropCalls, 1);

  harness.seedForeignCollection('recreated_foreign_data');
  await assert.rejects(
    owner.cleanupMongoDatabase(harness.handle),
    TestRuntimeCleanupLeakError,
  );
  assert.equal(harness.inspect().dropCalls, 1, 'a stale owner must never drop a recreated DB');
});

await check('ambiguous drop is resolved by exact absence; real cleanup leak fails', async () => {
  const ambiguousOwner = newOwner();
  const ambiguousHarness = createInMemoryMongoTestHarness(ambiguousOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await ambiguousOwner.claimMongoDatabase(ambiguousHarness.handle);
  ambiguousHarness.setDropBehavior('TIMEOUT_AFTER_DROP');
  const resolved = await ambiguousOwner.cleanupMongoDatabase(ambiguousHarness.handle);
  assert.equal(resolved.outcome, 'CLEANED_AFTER_AMBIGUOUS_DROP');
  assert.equal(resolved.verifiedAbsent, true);

  const leakingOwner = newOwner();
  const leakingHarness = createInMemoryMongoTestHarness(leakingOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await leakingOwner.claimMongoDatabase(leakingHarness.handle);
  leakingHarness.setDropBehavior('NO_EFFECT');
  await assert.rejects(
    leakingOwner.cleanupMongoDatabase(leakingHarness.handle),
    TestRuntimeCleanupLeakError,
  );
  assert.equal(leakingHarness.inspect().exists, true);

  const externallyDroppedOwner = newOwner();
  const externallyDroppedHarness = createInMemoryMongoTestHarness(
    externallyDroppedOwner.databaseName,
    {
      setName: RS_NAME,
      members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
    },
  );
  await externallyDroppedOwner.claimMongoDatabase(externallyDroppedHarness.handle);
  externallyDroppedHarness.simulateExternalDrop();
  await assert.rejects(
    externallyDroppedOwner.cleanupMongoDatabase(externallyDroppedHarness.handle),
    TestRuntimeOwnershipError,
  );
  assert.equal(
    externallyDroppedHarness.inspect().dropCalls,
    0,
    'external disappearance is not misreported as owner-verified cleanup',
  );
});

await check('fault injection is a closed enum and crash-after-drop can be recovered', async () => {
  assert.deepEqual(TEST_RUNTIME_FAULT_POINTS, [
    'afterMongoOwnerCollection',
    'beforeMongoOwnerMarker',
    'afterMongoOwnerMarker',
    'beforeMongoCleanupClaim',
    'afterMongoCleanupClaim',
    'afterMongoDropBeforeVerification',
  ]);
  const collectionCrashOwner = newOwner();
  const collectionCrashHarness = createInMemoryMongoTestHarness(collectionCrashOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await assert.rejects(
    collectionCrashOwner.claimMongoDatabase(collectionCrashHarness.handle, {
      faultHooks: {
        afterMongoOwnerCollection: () => {
          throw new Error('injected after collection');
        },
      },
    }),
    /injected after collection/,
  );
  assert.equal(collectionCrashHarness.inspect().exists, true);
  assert.equal(collectionCrashHarness.inspect().marker, null);
  const collectionRecovery = await collectionCrashOwner.cleanupMongoDatabase(
    collectionCrashHarness.handle,
  );
  assert.equal(collectionRecovery.outcome, 'CLEANED');
  assert.equal(collectionCrashHarness.inspect().exists, false);

  const markerPrewriteOwner = newOwner();
  const markerPrewriteHarness = createInMemoryMongoTestHarness(markerPrewriteOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await assert.rejects(
    markerPrewriteOwner.claimMongoDatabase(markerPrewriteHarness.handle, {
      faultHooks: {
        beforeMongoOwnerMarker: () => {
          throw new Error('injected before marker write');
        },
      },
    }),
    /injected before marker write/,
  );
  assert.equal(markerPrewriteHarness.inspect().marker, null);
  const markerPrewriteRecovery = await markerPrewriteOwner.cleanupMongoDatabase(
    markerPrewriteHarness.handle,
  );
  assert.equal(markerPrewriteRecovery.outcome, 'CLEANED');
  assert.equal(markerPrewriteHarness.inspect().exists, false);

  const ambiguousCreateOwner = newOwner();
  const ambiguousCreateHarness = createInMemoryMongoTestHarness(ambiguousCreateOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  ambiguousCreateHarness.setCollectionCreateBehavior('TIMEOUT_AFTER_CREATE');
  await ambiguousCreateOwner.claimMongoDatabase(ambiguousCreateHarness.handle);
  await ambiguousCreateOwner.cleanupMongoDatabase(ambiguousCreateHarness.handle);
  assert.equal(ambiguousCreateHarness.inspect().exists, false);

  const foreignRaceOwner = newOwner();
  const foreignRaceHarness = createInMemoryMongoTestHarness(foreignRaceOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  foreignRaceHarness.setCollectionCreateBehavior('FOREIGN_NAMESPACE_EXISTS');
  await assert.rejects(
    foreignRaceOwner.claimMongoDatabase(foreignRaceHarness.handle),
    /simulated foreign NamespaceExists race/,
  );
  await assert.rejects(
    foreignRaceOwner.cleanupMongoDatabase(foreignRaceHarness.handle),
    TestRuntimeStateError,
  );
  assert.equal(foreignRaceHarness.inspect().dropCalls, 0);
  assert.equal(foreignRaceHarness.inspect().exists, true);

  const markerCrashOwner = newOwner();
  const markerCrashHarness = createInMemoryMongoTestHarness(markerCrashOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await assert.rejects(
    markerCrashOwner.claimMongoDatabase(markerCrashHarness.handle, {
      faultHooks: {
        afterMongoOwnerMarker: () => {
          throw new Error('injected after marker');
        },
      },
    }),
    /injected after marker/,
  );
  assert.equal(markerCrashHarness.inspect().exists, true);
  const recoveredOwnership = await markerCrashOwner.claimMongoDatabase(markerCrashHarness.handle);
  assert.equal(recoveredOwnership.resourceId, markerCrashOwner.databaseName);
  const markerRecovery = await markerCrashOwner.cleanupMongoDatabase(markerCrashHarness.handle);
  assert.equal(markerRecovery.outcome, 'CLEANED');
  assert.equal(markerCrashHarness.inspect().exists, false);

  const owner = newOwner();
  const harness = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await owner.claimMongoDatabase(harness.handle);
  await assert.rejects(
    owner.cleanupMongoDatabase(harness.handle, {
      faultHooks: {
        afterMongoDropBeforeVerification: () => {
          throw new Error('injected crash boundary');
        },
      },
    }),
    /injected crash boundary/,
  );
  assert.equal(harness.inspect().exists, false);
  const recovered = await owner.cleanupMongoDatabase(harness.handle, { now: () => CHECKED_AT });
  assert.equal(recovered.outcome, 'ALREADY_ABSENT');

  const otherOwner = newOwner();
  const otherHarness = createInMemoryMongoTestHarness(otherOwner.databaseName);
  assert.throws(
    () => otherOwner.claimMongoDatabase(otherHarness.handle, {
      faultHooks: { unknownHook: () => {} } as never,
    }),
    TestRuntimeStateError,
  );
  assert.equal(otherHarness.inspect().exists, false);
});

await check('raw evidence retains the actual normalized bytes for the complete fixed profile', () => {
  const inputs = completeRawEvidenceInputs();
  const retained = retainRawEvidenceArtifacts(inputs, []);
  assert.equal(retained.artifactEvidenceStatus, 'COMPLETE');
  assert.equal(retained.secretScanStatus, 'PASS');
  assert.equal(retained.artifacts.length, REQUIRED_RAW_EVIDENCE.length);

  let expectedTotalBytes = 0;
  for (const input of inputs) {
    const artifact = retained.artifacts.find((entry) => entry.artifactId === input.artifactId);
    assert.ok(artifact);
    assert.equal(artifact.retentionStatus, 'BUNDLE_RETAINED');
    assert.equal(validateRetainedRawEvidenceArtifact(artifact), true);
    const expectedBytes = Buffer.from(input.content)
      .toString('utf8')
      .replace(/\r\n?/g, '\n');
    const readBack = retainedArtifactBytes(artifact as RetainedRawEvidenceArtifact);
    assert.equal(readBack.toString('utf8'), expectedBytes);
    expectedTotalBytes += readBack.byteLength;
  }
  assert.equal(retained.totalRetainedBytes, expectedTotalBytes);

  const stderr = retained.artifacts.find((artifact) => artifact.artifactId === 'stderr');
  const stdout = retained.artifacts.find((artifact) => artifact.artifactId === 'stdout');
  const trace = retained.artifacts.find((artifact) => artifact.artifactId === 'trace-event-log');
  const snapshot = retained.artifacts.find((artifact) => artifact.artifactId === 'db-snapshot');
  assert.ok(stderr?.retentionStatus === 'BUNDLE_RETAINED');
  assert.ok(stdout?.retentionStatus === 'BUNDLE_RETAINED');
  assert.ok(trace?.retentionStatus === 'BUNDLE_RETAINED');
  assert.ok(snapshot?.retentionStatus === 'BUNDLE_RETAINED');
  assert.equal(stderr.byteSize, 0, 'empty stderr is retained as real zero-byte evidence');
  assert.equal(processOutputMatchesArtifact(Buffer.alloc(0), stderr), true);
  assert.equal(processOutputMatchesArtifact(Buffer.from(STDOUT_BYTES), stdout), true);
  assert.match(retainedArtifactBytes(trace).toString('utf8'), /"sequence":2/);
  assert.equal(
    JSON.parse(retainedArtifactBytes(snapshot).toString('utf8')).schemaVersion,
    RAW_EVIDENCE_SNAPSHOT_VERSION,
  );
});

await check('snapshot cursor pseudonymizes document strings, numbers and field names', async () => {
  const uppercaseSecret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const secretFieldName = 'field-AKIAQRSTUVWXYZ1234';
  const sensitiveNumber = 4_111_111_111_111_111;
  const { bytes, stats } = await captureFakeSnapshot(function* () {
    yield {
      status: uppercaseSecret,
      nested: {
        outcome: 'UPPERCASE_SECRET_VALUE',
      },
      [secretFieldName]: sensitiveNumber,
    };
  });
  assert.equal(stats.toArrayCalls, 0);
  assert.equal(stats.documentCount, 1);
  assert.ok(stats.batchSizes.length > 0);
  assert.ok(stats.batchSizes.every((value) => value === 1));
  assert.equal(bytes.includes(Buffer.from(uppercaseSecret)), false);
  assert.equal(bytes.includes(Buffer.from('UPPERCASE_SECRET_VALUE')), false);
  assert.equal(bytes.includes(Buffer.from(secretFieldName)), false);
  assert.equal(bytes.includes(Buffer.from(String(sensitiveNumber))), false);
  assert.equal(bytes.includes(Buffer.from('orch_contract')), false);
  assert.match(bytes.toString('utf8'), /"\$field:hmac-sha256:[a-f0-9]{64}"/);
  assert.match(bytes.toString('utf8'), /"\$numberPseudonym":"hmac-sha256:[a-f0-9]{64}"/);
  assert.match(bytes.toString('utf8'), /"namePseudonym":"hmac-sha256:[a-f0-9]{64}"/);

  const retained = retainRawEvidenceArtifacts([{
    artifactId: 'db-snapshot',
    kind: 'dbSnapshot',
    mediaType: 'application/json',
    content: bytes,
  }], []);
  assert.equal(retained.secretScanStatus, 'PASS');
  const artifact = retained.artifacts[0];
  assert.ok(artifact?.retentionStatus === 'BUNDLE_RETAINED');
  assert.equal(retainedArtifactBytes(artifact).includes(Buffer.from(uppercaseSecret)), false);
});

await check('snapshot cursor enforces source bytes, output bytes and document count before accumulation', async () => {
  const snapshotLimit = REQUIRED_RAW_EVIDENCE.find(
    (artifact) => artifact.artifactId === 'db-snapshot',
  )!.maxBytes;
  const oversized = fakeSnapshotDatabase(function* () {
    yield { payload: Buffer.alloc(snapshotLimit + 1, 0x61) };
  });
  await assert.rejects(
    captureAnonymizedMongoSnapshot({
      db: oversized.db,
      expectedDatabaseName: oversized.db.databaseName,
      runId: `g0run_${'d'.repeat(32)}`,
      pseudonymKey: Buffer.alloc(32, 0x33),
      epoch: CREATED_AT,
    }),
    /working-set byte limit/,
  );
  assert.equal(oversized.stats.toArrayCalls, 0);
  assert.equal(oversized.stats.documentCount, 1);
  assert.ok(oversized.stats.batchSizes.every((value) => value === 1));

  const outputOversized = fakeSnapshotDatabase(function* () {
    const expandingDocument: Record<string, unknown> = {};
    for (let index = 0; index < 50_000; index++) {
      expandingDocument[`field_${index}`] = 'x';
    }
    yield expandingDocument;
  });
  await assert.rejects(
    captureAnonymizedMongoSnapshot({
      db: outputOversized.db,
      expectedDatabaseName: outputOversized.db.databaseName,
      runId: `g0run_${'f'.repeat(32)}`,
      pseudonymKey: Buffer.alloc(32, 0x34),
      epoch: CREATED_AT,
    }),
    /working-set\/output byte limit/,
  );
  assert.equal(outputOversized.stats.toArrayCalls, 0);
  assert.equal(outputOversized.stats.documentCount, 1);

  const overCount = fakeSnapshotDatabase(function* () {
    for (let index = 0; index <= RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS; index++) {
      yield {};
    }
  });
  await assert.rejects(
    captureAnonymizedMongoSnapshot({
      db: overCount.db,
      expectedDatabaseName: overCount.db.databaseName,
      runId: `g0run_${'e'.repeat(32)}`,
      pseudonymKey: Buffer.alloc(32, 0x44),
      epoch: CREATED_AT,
    }),
    /document count exceeds the fixed limit/,
  );
  assert.equal(overCount.stats.toArrayCalls, 0);
  assert.equal(
    overCount.stats.documentCount,
    RAW_EVIDENCE_MAX_SNAPSHOT_DOCUMENTS + 1,
  );
  assert.ok(overCount.stats.batchSizes.every((value) => value === 1));
});

await check('retained evidence rejects tampered bytes and hash-only descriptors', () => {
  const retained = retainRawEvidenceArtifacts(completeRawEvidenceInputs(), []);
  const summary = retained.artifacts.find(
    (artifact): artifact is RetainedRawEvidenceArtifact =>
      artifact.artifactId === 'normalized-summary'
      && artifact.retentionStatus === 'BUNDLE_RETAINED',
  );
  assert.ok(summary);

  const tampered = structuredClone(summary);
  tampered.contentBase64url = Buffer.from(
    retainedArtifactBytes(summary).toString('utf8').replace('"pass"', '"fail"'),
    'utf8',
  ).toString('base64url');
  assert.equal(validateRetainedRawEvidenceArtifact(tampered), false);
  assert.throws(
    () => retainedArtifactBytes(tampered),
    /failed independent validation/,
  );

  const {
    contentBase64url: _discardedBytes,
    ...hashOnly
  } = summary;
  assert.equal(validateRetainedRawEvidenceArtifact(hashOnly), false);
  assert.throws(
    () => retainedArtifactBytes(hashOnly as RetainedRawEvidenceArtifact),
    /failed independent validation/,
  );

  const traversal = {
    ...structuredClone(summary),
    relativeName: '../normalized-summary.json',
  };
  assert.equal(
    validateRetainedRawEvidenceArtifact(traversal),
    false,
    'artifact paths are fixed by the profile and cannot traverse the parent root',
  );
});

await check('parent artifact session materializes, reads back and cleans the complete profile', () => {
  const retained = retainRawEvidenceArtifacts(completeRawEvidenceInputs(), []);
  assert.equal(retained.artifactEvidenceStatus, 'COMPLETE');
  const parentDirectory = mkdtempSync(join(tmpdir(), 'g0-artifact-parent-'));
  let session: ParentArtifactSession | undefined;
  let cleanupVerified = false;
  try {
    session = createParentArtifactSession({
      parentDirectory,
      sessionId: 'runtime-contract-readback',
    });
    const materialized = session.materialize(retained.artifacts);
    assert.equal(materialized.artifacts.length, REQUIRED_RAW_EVIDENCE.length);
    assert.equal(materialized.totalByteSize, retained.totalRetainedBytes);
    assert.match(materialized.artifactSetHash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(materialized.artifacts.every((artifact) => artifact.readBackVerified));

    const roots = readdirSync(parentDirectory);
    assert.equal(roots.length, 1);
    const artifactRoot = join(parentDirectory, roots[0]!);
    assert.deepEqual(
      readdirSync(artifactRoot).sort(),
      REQUIRED_RAW_EVIDENCE.map((artifact) => artifact.relativeName).sort(),
    );
    for (const artifact of retained.artifacts) {
      assert.equal(artifact.retentionStatus, 'BUNDLE_RETAINED');
      assert.deepEqual(
        readFileSync(join(artifactRoot, artifact.relativeName)),
        retainedArtifactBytes(artifact),
      );
    }

    const stdoutPath = join(artifactRoot, 'stdout.log');
    const originalStdout = readFileSync(stdoutPath);
    writeFileSync(stdoutPath, Buffer.alloc(originalStdout.byteLength, 0x78));
    assert.throws(
      () => session?.cleanup(),
      /cleanup refused a changed file/,
      'same-size content replacement must be detected before deletion',
    );
    writeFileSync(stdoutPath, originalStdout);

    const cleanup = session.cleanup();
    cleanupVerified = true;
    assert.equal(cleanup.verifiedAbsent, true);
    assert.equal(cleanup.artifactCount, REQUIRED_RAW_EVIDENCE.length);
    assert.equal(existsSync(artifactRoot), false);
    assert.deepEqual(session.cleanup(), cleanup, 'cleanup re-verifies the captured root absence');
  } finally {
    if (!cleanupVerified) {
      try {
        session?.cleanup();
      } catch {
        // The primary assertion reports any session failure.
      }
    }
    if (existsSync(parentDirectory) && readdirSync(parentDirectory).length === 0) {
      rmdirSync(parentDirectory);
    }
  }
});

await check('raw evidence rejects duplicates and limits while quarantining secret bytes', () => {
  const duplicate = completeRawEvidenceInputs()[0]!;
  assert.throws(
    () => retainRawEvidenceArtifacts([duplicate, duplicate], []),
    /duplicate artifact/,
  );

  const stdoutLimit = REQUIRED_RAW_EVIDENCE.find(
    (artifact) => artifact.artifactId === 'stdout',
  )!.maxBytes;
  const exactLimit = retainRawEvidenceArtifacts([{
    artifactId: 'stdout',
    kind: 'stdout',
    mediaType: 'text/plain; charset=utf-8',
    content: 'x'.repeat(stdoutLimit),
  }], []);
  assert.equal(exactLimit.totalRetainedBytes, stdoutLimit);
  assert.equal(exactLimit.artifacts[0]?.retentionStatus, 'BUNDLE_RETAINED');
  assert.throws(
    () => retainRawEvidenceArtifacts([{
      artifactId: 'stdout',
      kind: 'stdout',
      mediaType: 'text/plain; charset=utf-8',
      content: 'x'.repeat(stdoutLimit + 1),
    }], []),
    /exceeds its fixed byte limit/,
  );

  const secretInputs = completeRawEvidenceInputs();
  secretInputs.find((artifact) => artifact.artifactId === 'stderr')!.content =
    `authorization=${QUERY_TOKEN}`;
  const quarantined = retainRawEvidenceArtifacts(secretInputs, [QUERY_TOKEN]);
  assert.equal(quarantined.artifactEvidenceStatus, 'QUARANTINED');
  assert.equal(quarantined.secretScanStatus, 'FAILED');
  const secretArtifact = quarantined.artifacts.find(
    (artifact) => artifact.artifactId === 'stderr',
  );
  assert.equal(secretArtifact?.retentionStatus, 'QUARANTINED_SECRET');
  assert.ok(secretArtifact && !('contentBase64url' in secretArtifact));
  assert.ok(!JSON.stringify(quarantined).includes(QUERY_TOKEN));

  for (const authorizationLeak of [
    'Authorization: Bearer synthetic.jwt.credential-123456789',
    'authorization=Basic c3ludGhldGljOnNlY3JldA==',
    'request failed with Bearer standaloneCredential1234',
  ]) {
    const authorizationInputs = completeRawEvidenceInputs();
    authorizationInputs.find((artifact) => artifact.artifactId === 'stderr')!.content =
      authorizationLeak;
    const authorizationQuarantine = retainRawEvidenceArtifacts(authorizationInputs, []);
    assert.equal(authorizationQuarantine.artifactEvidenceStatus, 'QUARANTINED');
    assert.equal(authorizationQuarantine.secretScanStatus, 'FAILED');
    const authorizationArtifact = authorizationQuarantine.artifacts.find(
      (artifact) => artifact.artifactId === 'stderr',
    );
    assert.equal(authorizationArtifact?.retentionStatus, 'QUARANTINED_SECRET');
    assert.ok(authorizationArtifact && !('contentBase64url' in authorizationArtifact));
  }
});

let foundationReport: TestEvidenceReportV2 | undefined;
let foundationManifest: TestRuntimeManifestV2 | undefined;

await check('owner evidence is byte-retaining but incomplete without a real database snapshot', async () => {
  const owner = newOwner();
  const harness = createInMemoryMongoTestHarness(owner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  const ownership = await owner.claimMongoDatabase(harness.handle);
  await owner.cleanupMongoDatabase(harness.handle, { now: () => CHECKED_AT });
  const report = owner.createEvidenceReport({
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cases: [{
      caseId: 'G0-OWNER-NEGATIVE',
      testExecutionStatus: 'PASSED',
      targetInvariantStatus: 'HOLDS',
    }],
    artifacts: ownerRawEvidenceInputs(),
  });
  assert.equal(report.testExecutionStatus, 'PASSED');
  assert.equal(report.targetInvariantStatus, 'HOLDS');
  assert.equal(report.cleanupStatus, 'CLEANUP_VERIFIED');
  assert.equal(report.secretScanStatus, 'PASS');
  assert.equal(report.artifactEvidenceStatus, 'INCOMPLETE');
  assert.equal(report.foundationValidationStatus, 'FAIL');
  assert.equal(report.qualificationStatus, 'NOT_QUALIFIED');
  assert.equal(report.ownership[0]?.ownershipProofHash, ownership.ownershipProofHash);
  assert.deepEqual(
    report.cases[0]?.artifactIds,
    ['normalized-summary', 'stderr', 'stdout', 'trace-event-log'],
  );
  const summary = report.artifacts.find(
    (artifact): artifact is RetainedRawEvidenceArtifact =>
      artifact.artifactId === 'normalized-summary'
      && artifact.retentionStatus === 'BUNDLE_RETAINED',
  );
  assert.ok(summary);
  const normalizedSummaryBytes = Buffer.from(SUMMARY_BYTES.replace(/\r\n?/g, '\n'));
  assert.equal(summary.byteSize, normalizedSummaryBytes.byteLength);
  assert.deepEqual(retainedArtifactBytes(summary), normalizedSummaryBytes);
  assert.equal(
    summary.contentHash,
    `sha256:${(await import('node:crypto')).createHash('sha256').update(normalizedSummaryBytes).digest('hex')}`,
  );
  assert.equal(validateTestEvidenceReport(report, owner.manifest).ok, true);
  foundationReport = report;
  foundationManifest = owner.manifest;
  assert.throws(
    () => owner.createEvidenceReport({
      createdAt: CREATED_AT,
      completedAt: COMPLETED_AT,
      cases: [{
        caseId: 'SECOND-FINAL',
        testExecutionStatus: 'PASSED',
        targetInvariantStatus: 'HOLDS',
      }],
    }),
    TestRuntimeStateError,
  );
  assert.throws(
    () => owner.cleanupMongoDatabase(harness.handle),
    TestRuntimeStateError,
  );

  const notRunOwner = newOwner();
  const notRun = notRunOwner.createEvidenceReport({
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cases: [{
      caseId: 'NOT-RUN',
      testExecutionStatus: 'NOT_RUN',
      targetInvariantStatus: 'UNKNOWN',
    }],
  });
  assert.equal(notRun.testExecutionStatus, 'NOT_RUN');
  assert.equal(notRun.cleanupStatus, 'NOT_RUN');
  assert.equal(notRun.secretScanStatus, 'NOT_RUN');
  assert.equal(notRun.artifactEvidenceStatus, 'INCOMPLETE');
  assert.equal(notRun.foundationValidationStatus, 'FAIL');
  assert.equal(notRun.qualificationStatus, 'NOT_QUALIFIED');

  const forgedOwner = newOwner();
  const forgedLifecycleInput = forgedOwner.createEvidenceReport({
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cases: [{
      caseId: 'FORGED-RECEIPTS-IGNORED',
      testExecutionStatus: 'PASSED',
      targetInvariantStatus: 'HOLDS',
    }],
    artifacts: [{
      artifactId: 'normalized-summary',
      kind: 'normalizedSummary',
      mediaType: 'application/json',
      content: '{"ok":true}',
    }],
    ownership: report.ownership,
    cleanup: report.cleanup,
    secretScanStatus: 'PASS',
  } as never);
  assert.equal(forgedLifecycleInput.cleanupStatus, 'NOT_RUN');
  assert.deepEqual(forgedLifecycleInput.ownership, []);
  assert.deepEqual(forgedLifecycleInput.cleanup, []);
  assert.equal(forgedLifecycleInput.artifactEvidenceStatus, 'INCOMPLETE');
  assert.equal(forgedLifecycleInput.foundationValidationStatus, 'FAIL');
  assert.equal(forgedLifecycleInput.qualificationStatus, 'NOT_QUALIFIED');
});

await check('dirty source, cleanup failure, invariant violation and secret canary all fail foundation validation', async () => {
  const dirtyOwner = newOwner({ source: { ...SOURCE, worktreeState: 'DIRTY' } });
  const dirty = dirtyOwner.createEvidenceReport({
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cases: [{
      caseId: 'DIRTY',
      testExecutionStatus: 'PASSED',
      targetInvariantStatus: 'HOLDS',
    }],
    artifacts: [{
      artifactId: 'normalized-summary',
      kind: 'normalizedSummary',
      mediaType: 'application/json',
      content: '{"status":"safe"}',
    }],
  });
  assert.equal(dirty.foundationValidationStatus, 'FAIL');
  assert.equal(dirty.qualificationStatus, 'NOT_QUALIFIED');

  const failingOwner = newOwner();
  const failingHarness = createInMemoryMongoTestHarness(failingOwner.databaseName, {
    setName: RS_NAME,
    members: [`${HOST_A}:27017`, `${HOST_B}:27018`],
  });
  await failingOwner.claimMongoDatabase(failingHarness.handle);
  failingHarness.setDropBehavior('NO_EFFECT');
  await assert.rejects(
    failingOwner.cleanupMongoDatabase(failingHarness.handle),
    TestRuntimeCleanupLeakError,
  );
  const cleanupFailed = failingOwner.createEvidenceReport({
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cases: [{
      caseId: 'CLEANUP-FAILED',
      testExecutionStatus: 'PASSED',
      targetInvariantStatus: 'HOLDS',
    }],
    artifacts: [{
      artifactId: 'normalized-summary',
      kind: 'normalizedSummary',
      mediaType: 'application/json',
      content: '{"status":"cleanup-failed"}',
    }],
  });
  assert.equal(cleanupFailed.cleanupStatus, 'CLEANUP_FAILED');
  assert.equal(cleanupFailed.foundationValidationStatus, 'FAIL');

  const violated = newOwner({ source: { ...SOURCE, worktreeState: 'DIRTY' } })
    .createEvidenceReport({
      createdAt: CREATED_AT,
      completedAt: COMPLETED_AT,
      cases: [{
        caseId: 'KNOWN-RED-REPRODUCER',
        testExecutionStatus: 'PASSED',
        targetInvariantStatus: 'VIOLATED',
      }],
      artifacts: [{
        artifactId: 'normalized-summary',
        kind: 'normalizedSummary',
        mediaType: 'application/json',
        content: '{"status":"known-red"}',
      }],
    });
  assert.equal(violated.testExecutionStatus, 'PASSED');
  assert.equal(violated.targetInvariantStatus, 'VIOLATED');
  assert.equal(violated.foundationValidationStatus, 'FAIL');
  assert.equal(violated.qualificationStatus, 'NOT_QUALIFIED');

  const leaked = newOwner().createEvidenceReport({
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cases: [{
      caseId: 'SECRET-CANARY',
      testExecutionStatus: 'PASSED',
      targetInvariantStatus: 'HOLDS',
    }],
    artifacts: [{
      artifactId: 'stderr',
      kind: 'stderr',
      mediaType: 'text/plain; charset=utf-8',
      content: `provider failed with ${QUERY_TOKEN}`,
    }],
  });
  assert.equal(leaked.secretScanStatus, 'FAILED');
  assert.equal(leaked.artifactEvidenceStatus, 'QUARANTINED');
  assert.equal(leaked.foundationValidationStatus, 'FAIL');
  assert.ok(!JSON.stringify(leaked).includes(QUERY_TOKEN));

  const plainUri = 'mongodb://localhost:27018/?replicaSet=rs0';
  const fullUriLeak = newOwner({ topologyUri: plainUri }).createEvidenceReport({
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cases: [{
      caseId: 'FULL-URI-CANARY',
      testExecutionStatus: 'PASSED',
      targetInvariantStatus: 'HOLDS',
    }],
    artifacts: [{
      artifactId: 'stderr',
      kind: 'stderr',
      mediaType: 'text/plain; charset=utf-8',
      content: `connection failed at ${plainUri}`,
    }],
  });
  assert.equal(fullUriLeak.secretScanStatus, 'FAILED');
});

await check('evidence is URI-free and rejects tamper, broken references and orphan artifacts', () => {
  assert.ok(foundationReport);
  assert.ok(foundationManifest);
  const serialized = JSON.stringify(foundationReport);
  for (const forbidden of [
    'mongodb',
    RAW_USER,
    RAW_PASSWORD,
    QUERY_TOKEN,
    RAW_DB,
    HOST_A,
    HOST_B,
    RS_NAME,
    'hmac-sha256:',
  ]) {
    assert.ok(!serialized.includes(forbidden), 'public evidence leaked a forbidden value');
  }

  const tampered = structuredClone(foundationReport);
  const tamperedSummary = tampered.artifacts.find(
    (artifact) => artifact.artifactId === 'normalized-summary',
  );
  assert.ok(tamperedSummary?.retentionStatus === 'BUNDLE_RETAINED');
  tamperedSummary.contentBase64url = Buffer.from(
    Buffer.from(tamperedSummary.contentBase64url, 'base64url')
      .toString('utf8')
      .replace('"pass"', '"fail"'),
    'utf8',
  ).toString('base64url');
  const tamperedValidation = validateTestEvidenceReport(tampered, foundationManifest);
  assert.equal(tamperedValidation.ok, false);
  assert.ok(tamperedValidation.issues.some((issue) => issue.includes('valid read-back bytes')));
  assert.ok(tamperedValidation.issues.some((issue) => issue.includes('artifactSetHash')));
  assert.ok(tamperedValidation.issues.some((issue) => issue.includes('reportHash')));

  const brokenReference = structuredClone(foundationReport);
  brokenReference.cases[0]!.artifactIds = ['missing'];
  const referenceValidation = validateTestEvidenceReport(brokenReference, foundationManifest);
  assert.equal(referenceValidation.ok, false);
  assert.ok(referenceValidation.issues.some((issue) => issue.includes('unknown artifact')));
  assert.ok(referenceValidation.issues.some((issue) => issue.includes('reportHash')));

  const orphaned = structuredClone(foundationReport);
  orphaned.cases[0]!.artifactIds = orphaned.cases[0]!.artifactIds
    .filter((artifactId) => artifactId !== 'stderr');
  const orphanValidation = validateTestEvidenceReport(orphaned, foundationManifest);
  assert.equal(orphanValidation.ok, false);
  assert.ok(orphanValidation.issues.some((issue) => issue.includes('orphan artifact stderr')));

  const publiclyRehashed = structuredClone(foundationReport);
  publiclyRehashed.completedAt = '2026-07-27T10:00:11.000Z';
  const {
    reportHash: _oldHash,
    attestation: _oldAttestation,
    ...rehashedUnsigned
  } = publiclyRehashed;
  publiclyRehashed.reportHash = hashCanonicalValue(rehashedUnsigned);
  const rehashedValidation = validateTestEvidenceReport(publiclyRehashed, foundationManifest);
  assert.equal(rehashedValidation.ok, false);
  assert.ok(rehashedValidation.issues.some((issue) => issue.includes('signature')));

  const unboundValidation = validateTestEvidenceReport(foundationReport);
  assert.equal(unboundValidation.ok, false);
  assert.ok(unboundValidation.issues.includes('BOUND_MANIFEST_REQUIRED'));

  const otherManifest = newOwner().manifest;
  assert.equal(validateTestEvidenceReport(foundationReport, otherManifest).ok, false);

  const bundle = {
    schemaVersion: TEST_EVIDENCE_BUNDLE_VERSION,
    manifest: foundationManifest,
    report: foundationReport,
  };
  assert.equal(validateTestEvidenceBundle(bundle).ok, true);
});

await check('first migrated suites cannot regress to ad-hoc DB names, swallowed drops or false-green gates', () => {
  const suiteFiles = [
    'e2e-orchestration-autonomous.ts',
    'e2e-orchestration-http.ts',
    'e2e-orchestration-service.ts',
  ];
  for (const suiteFile of suiteFiles) {
    const source = readFileSync(new URL(`./${suiteFile}`, import.meta.url), 'utf8');
    assert.match(source, /createTestRuntimeOwner/);
    assert.match(source, /bindMongoTestDatabase/);
    assert.match(source, /claimMongoDatabase/);
    assert.match(source, /captureMongoDatabaseSnapshot/);
    assert.match(source, /cleanupMongoDatabase/);
    assert.match(source, /createSuiteEvidenceRecorder/);
    assert.match(source, /recorder\.finalize/);
    assert.match(source, /createEvidenceReport/);
    assert.match(source, /publishTestEvidenceBundle/);
    assert.match(source, /gateEvidenceFdFromEnv/);
    assert.match(source, /ORCHESTRATION_G0_GATE/);
    assert.match(source, /ORCHESTRATION_G0_EVIDENCE_FD/);
    assert.match(source, /testExecutionStatus:\s*'NOT_RUN'/);
    assert.doesNotMatch(source, /createTestRuntimeOwnerForContractCheck/);
    assert.doesNotMatch(source, /artifactIds\s*:/);
    assert.doesNotMatch(source, /dbName\s*:\s*[^\n,]*Date\.now\s*\(/);
    assert.doesNotMatch(source, /\.dropDatabase\s*\(/);
    assert.doesNotMatch(source, /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    assert.doesNotMatch(source, /process\.exit\s*\(/);
    assert.doesNotMatch(source, /\(err as Error\)\.message/);
  }

  const packageJson = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: Record<string, string> };
  for (const scriptName of [
    'check:orchestration-test-runtime',
    'gate:orchestration-test-runtime',
    'e2e:orchestration-autonomous',
    'e2e:orchestration-http',
    'e2e:orchestration-service',
  ]) {
    assert.match(
      packageJson.scripts?.[scriptName] ?? '',
      /node --import tsx/,
      `${scriptName} must use the pinned local non-IPC runner`,
    );
  }
  // The gate is `check:all`, but it is no longer a chain of `&&` in
  // package.json: it delegates to a script so it can start (and stop) the
  // replica set its durability sections need. The claim here is unchanged —
  // this suite must actually be in the gate — so ask the gate's step list.
  assert.ok(
    readGateSteps().includes('check:orchestration-test-runtime'),
    'check:all must run this suite',
  );
  // And the gate must be able to FAIL on a missing prerequisite: a durability
  // section that silently skips is the false-green case this check exists to
  // prevent, one level up.
  assert.match(readGateDefinition(), /REQUIRE_RS=1/);
  const strictGate = packageJson.scripts?.['gate:orchestration-test-runtime'] ?? '';
  assert.equal(
    strictGate,
    'bash scripts/with-node.sh node --import tsx src/mastra/scripts/gate-orchestration-test-runtime.ts',
  );
  const gateSource = readFileSync(
    new URL('./gate-orchestration-test-runtime.ts', import.meta.url),
    'utf8',
  );
  const declaredEntrypoints = [...gateSource.matchAll(/entrypoint:\s*'([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(declaredEntrypoints, [...suiteFiles].sort());
  assert.match(gateSource, /spawn\s*\(/);
  assert.match(gateSource, /process\.execPath/);
  // The suite is no longer spawned as `[--import, tsx, entrypoint]`. Suites
  // are precompiled by the parent and the child runs a fixed guarded chain —
  // permission args, the resource guard, then an inert bootstrap — with no
  // TypeScript loader at all. A loader would need child-process authority
  // (esbuild spawns its own service), which this gate must never grant.
  // The entrypoint is not an argv element either: it arrives through
  // parent-minted env and stays unimported until the IPC release handshake.
  assert.match(gateSource, /\.\.\.nodePermissionArgs,/);
  assert.doesNotMatch(gateSource, /TSX_IMPORT_URL/);
  assert.doesNotMatch(gateSource, /import\.meta\.resolve\('tsx'\)/);
  assert.match(gateSource, /'--import',\s*RESOURCE_GUARD_PATH,/);
  assert.match(gateSource, /RESOURCE_BOOTSTRAP_PATH,/);
  assert.match(gateSource, /shell:\s*false/);
  assert.doesNotMatch(gateSource, /'--allow-child-process'/);
  // Compiler settings are inherited from the project tsconfig, never restated,
  // so the built suites cannot drift from how they are type checked.
  assert.match(gateSource, /extends:\s*PROJECT_TSCONFIG/);
  assert.match(gateSource, /entrypointRoot:\s*buildOutDir/);
  // The compiled bytes are content-attested and re-verified before every spawn,
  // so a tamper of the build directory cannot slip past as an executed suite.
  assert.match(gateSource, /function hashBuildOutput\(/);
  assert.match(
    gateSource,
    /hashBuildOutput\(buildOutDir\)\.rootHash\s*===\s*buildAttestation\.rootHash/,
  );
  assert.match(gateSource, /'BUILD_ATTESTATION_MISMATCH'/);
  assert.match(gateSource, /ORCHESTRATION_G0_GATE:\s*'true'/);
  assert.match(gateSource, /ORCHESTRATION_G0_EVIDENCE_FD:\s*'3'/);
  // The guarded child gains a Node IPC channel (port-lease handoff and audit
  // ingestion) that PR-43 did not have. That is new authority, so it is
  // pinned explicitly rather than absorbed into a looser stdio match.
  assert.match(
    gateSource,
    /stdio:\s*\['ignore',\s*'pipe',\s*'pipe',\s*'pipe',\s*'ipc'\]/,
  );
  const bootstrapSource = readFileSync(
    new URL(
      '../orchestration/testing/runtime-resource-bootstrap.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  // A failed workload import must not be able to hold inherited listening
  // sockets open until the suite timeout and disguise itself as TIMEOUT.
  assert.match(bootstrapSource, /G0_WORKLOAD_IMPORT_FAILED/);
  assert.match(bootstrapSource, /abandonUnclaimedLeases/);
  assert.match(bootstrapSource, /G0_MONGO_OWNER_GRANT/);
  assert.match(bootstrapSource, /G0_MONGO_OWNER_GRANTED/);
  assert.match(
    bootstrapSource,
    /released\s*\|\|\s*mongoAllocationHash\s*===\s*undefined/,
  );
  const journalRegisterIndex = gateSource.indexOf(
    'await mongoJournalStore.register(mongoAllocation, processOwner)',
  );
  const allocationGrantIndex = gateSource.indexOf(
    'await grantMongoOwnerAllocation(child, runtimeSession, mongoAllocation)',
  );
  const workloadReleaseIndex = gateSource.indexOf(
    'await runtimeSession.releaseWorkload(child)',
  );
  assert.ok(journalRegisterIndex >= 0);
  assert.ok(allocationGrantIndex > journalRegisterIndex);
  assert.ok(workloadReleaseIndex > allocationGrantIndex);
  const gateWorkspaceSource = readFileSync(
    new URL(
      '../orchestration/testing/gate-workspace-orphan-journal.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const durableIntentIndex = gateWorkspaceSource.indexOf(
    'writePrivateFileAtomically(\n      entryPath(this.journalRoot, workspaceId)',
  );
  const ownedRootMkdirIndex = gateWorkspaceSource.indexOf(
    'mkdirSync(anchoredPath(managedFd, rootName)',
  );
  assert.ok(durableIntentIndex >= 0);
  assert.ok(
    ownedRootMkdirIndex > durableIntentIndex,
    'workspace intent must be fsynced before its root mkdir',
  );
  const startupWorkspaceReclaimIndex = gateSource.indexOf(
    'gateWorkspaceOrphanReclaim = await store.reclaim({})',
  );
  const gateRootAllocationIndex = gateSource.indexOf(
    'const owned = await gateWorkspaceStore.createOwnedRoot({})',
  );
  const buildRootMkdirIndex = gateSource.indexOf(
    "const candidate = mkdtempSync(join(gateTempDir, 'build-'))",
  );
  assert.ok(startupWorkspaceReclaimIndex >= 0);
  assert.ok(gateRootAllocationIndex > startupWorkspaceReclaimIndex);
  assert.ok(buildRootMkdirIndex > gateRootAllocationIndex);

  const runtimeSessionCreateIndex = gateSource.indexOf(
    'runtimeSession = await createParentRuntimeResourceSession({',
  );
  const workspaceSessionRegisterIndex = gateSource.indexOf(
    'gateWorkspaceSession = await gateWorkspaceJournal.store.registerSession(',
  );
  const childExecutionCallIndex = gateSource.lastIndexOf(
    'execution = await executeSuiteChild(',
  );
  assert.ok(runtimeSessionCreateIndex >= 0);
  assert.ok(workspaceSessionRegisterIndex > runtimeSessionCreateIndex);
  assert.ok(
    childExecutionCallIndex > workspaceSessionRegisterIndex,
    'workspace session must be durable before executeSuiteChild can spawn',
  );
  assert.equal(
    [...gateSource.matchAll(/executeSuiteChild\(/g)].length,
    2,
    'executeSuiteChild must have one definition and one guarded call site',
  );
  const processClaimIndex = gateSource.indexOf(
    'const processOwner = await runtimeSession.claimSpawn(child)',
  );
  const workspaceOwnerBindIndex = gateSource.indexOf(
    'await gateWorkspaceJournal.store.bindSessionOwner(',
  );
  assert.ok(processClaimIndex >= 0);
  assert.ok(workspaceOwnerBindIndex > processClaimIndex);
  assert.ok(journalRegisterIndex > workspaceOwnerBindIndex);
  assert.ok(
    workloadReleaseIndex > workspaceOwnerBindIndex,
    'exact workspace owner must be durable before workload release',
  );
  const mongoJournalSource = readFileSync(
    new URL(
      '../orchestration/testing/mongo-orphan-journal.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const terminalUnlinkIndex = mongoJournalSource.indexOf(
    'this.unlinkExact(currentFile);',
  );
  const terminalCrashHookIndex = mongoJournalSource.indexOf(
    'await input.afterJournalUnlinkBeforeClaimRelease?.();',
    terminalUnlinkIndex,
  );
  const terminalClaimReleaseIndex = mongoJournalSource.indexOf(
    'releaseOwnedClaim();',
    terminalCrashHookIndex,
  );
  assert.ok(terminalUnlinkIndex >= 0);
  assert.ok(terminalCrashHookIndex > terminalUnlinkIndex);
  assert.ok(terminalClaimReleaseIndex > terminalCrashHookIndex);
  assert.match(mongoJournalSource, /orphanClaims:\s*Array</);
  assert.match(mongoJournalSource, /claimFile\.value\.allocation\.dbName/);
  assert.match(gateSource, /child\.stdio\[3\]/);
  assert.match(gateSource, /attachBoundedDrain/);
  assert.match(gateSource, /signalChild\('SIGTERM'\)/);
  assert.match(gateSource, /signalChild\('SIGKILL'\)/);
  assert.match(gateSource, /validateTestEvidenceBundle/);
  assert.match(gateSource, /createParentArtifactSession/);
  assert.match(gateSource, /processOutputMatchesArtifact/);
  assert.match(gateSource, /artifactSession\.materialize/);
  assert.match(gateSource, /artifactSession\.cleanup/);
  assert.match(gateSource, /TEST_EVIDENCE_BUNDLE_MAX_BYTES/);
  assert.match(gateSource, /bundle\.report\.artifactEvidenceStatus\s*!==\s*'COMPLETE'/);
  assert.match(gateSource, /readGitSourceIdentity\(PROJECT_ROOT\)/);
  assert.match(gateSource, /bundle\.manifest\.configHash\s*===\s*hashCanonicalValue/);
  assert.match(gateSource, /bundle\.report\.foundationValidationStatus\s*===\s*'PASS'/);
  assert.match(gateSource, /signatureVerifiedRelativeToManifest/);
  assert.match(gateSource, /parentTrustAnchorMatched/);
  assert.match(gateSource, /parentAttestation/);
  assert.match(
    gateSource,
    /gateWorkspaceOrphanReclaim\.status\s*===\s*'PASSED'/,
  );
  assert.match(
    gateSource,
    /gateWorkspaceOrphanReclaim\.reclaimVerified/,
  );
  assert.match(
    gateSource,
    /gateWorkspaceCleanup\?\.status\s*===\s*'PASSED'/,
  );
  assert.match(gateSource, /gateWorkspaceCleanup\.verifiedAbsent/);
  assert.match(gateSource, /gateWorkspaceOrphanReclaim,/);
  assert.match(gateSource, /gateWorkspaceCleanup,/);
  assert.match(gateSource, /shell:\s*false/);
  assert.match(
    gateSource,
    /results\.push\(await runSuite\(\s*suite,\s*index,\s*gateTempDir,\s*compiledEntrypoints,\s*buildOutDir,\s*buildAttestation,\s*mongoJournal,\s*gateWorkspaceJournal,\s*\)\)/,
  );
  // The compiler runs inside the exact gate-owner process. There is no
  // pre-session compiler subprocess which could outlive a killed parent and
  // continue writing while workspace recovery inventories or deletes.
  assert.match(gateSource, /ts\.getParsedCommandLineOfConfigFile\(/);
  assert.match(gateSource, /ts\.createProgram\(/);
  assert.doesNotMatch(
    gateSource,
    /execFileSync\(process\.execPath,\s*\[TSC_PATH/,
  );
  assert.match(gateSource, /process\.exitCode\s*=\s*passed\s*\?\s*0\s*:\s*1/);
  assert.doesNotMatch(gateSource, /npm run/);
  assert.doesNotMatch(gateSource, /spawnSync\s*\(/);
  assert.doesNotMatch(gateSource, /openSync\s*\(\s*evidencePath/);
  assert.doesNotMatch(gateSource, /shell:\s*true/);
  assert.doesNotMatch(gateSource, /ORCHESTRATION_G0_EVIDENCE_PATH/);
  assert.doesNotMatch(gateSource, /HOME:\s*process\.env\.HOME/);
  assert.doesNotMatch(gateSource, /evidenceAuthenticated/);
});

await check('fault schedule derivation is deterministic, seed-bound and closed-enum', () => {
  const challengeHash =
    `sha256:${'c'.repeat(64)}` as const;
  const a = deriveFaultSchedule({ seed: 424242, suiteId: 'e2e:x', challengeHash, activeBudget: 6 });
  const b = deriveFaultSchedule({ seed: 424242, suiteId: 'e2e:x', challengeHash, activeBudget: 6 });
  const c = deriveFaultSchedule({ seed: 424243, suiteId: 'e2e:x', challengeHash, activeBudget: 6 });
  const d = deriveFaultSchedule({ seed: 424242, suiteId: 'e2e:y', challengeHash, activeBudget: 6 });
  // Same input → byte-identical plan; any perturbed field diverges.
  assert.equal(a.scheduleHash, b.scheduleHash);
  assert.deepEqual(a.faults, b.faults);
  assert.notEqual(a.scheduleHash, c.scheduleHash);
  assert.notEqual(a.scheduleHash, d.scheduleHash);
  // The hash actually binds the faults, not just the identity.
  assert.equal(a.scheduleHash, faultScheduleSchema.parse(a).scheduleHash);
  // Zero budget is the empty observe-only schedule; the schema still validates.
  const empty = deriveFaultSchedule({ seed: 1, suiteId: 'e2e:x', challengeHash, activeBudget: 0 });
  assert.equal(empty.faults.length, 0);
  faultScheduleSchema.parse(empty);
  // Every scheduled fault names a kind in the closed enum, at a legal sequence,
  // with a disposition its kind may legitimately resolve to.
  for (const [index, fault] of a.faults.entries()) {
    assert.ok(FAULT_INJECTOR_KINDS.includes(fault.kind));
    assert.equal(fault.sequence, index + 1);
    assert.ok(
      FAULT_KIND_ALLOWED_DISPOSITIONS[fault.kind].includes(fault.expectedDisposition),
    );
  }
  // Out-of-range seed/budget and a malformed challenge fail closed.
  assert.throws(() => deriveFaultSchedule({ seed: -1, suiteId: 'x', challengeHash, activeBudget: 1 }));
  assert.throws(() => deriveFaultSchedule({ seed: 0x1_0000_0000, suiteId: 'x', challengeHash, activeBudget: 1 }));
  assert.throws(() => deriveFaultSchedule({ seed: 1, suiteId: 'x', challengeHash, activeBudget: 999 }));
  assert.throws(() => deriveFaultSchedule({
    seed: 1,
    suiteId: 'x',
    challengeHash: 'not-a-hash' as `sha256:${string}`,
    activeBudget: 1,
  }));
  // Every injectable kind maps to a real, wired runtime fault point.
  for (const kind of FAULT_INJECTOR_KINDS) {
    assert.ok(
      (TEST_RUNTIME_FAULT_POINTS as readonly string[]).includes(
        FAULT_KIND_TO_RUNTIME_POINT[kind],
      ),
      `fault kind ${kind} maps to an unknown runtime point`,
    );
  }
});

await check('fault ledger is an independent, fail-closed, count-conserving cross-check', () => {
  const challengeHash = `sha256:${'d'.repeat(64)}` as const;
  const schedule = deriveFaultSchedule({ seed: 7, suiteId: 'e2e:x', challengeHash, activeBudget: 8 });
  assert.ok(schedule.faults.length >= 1);
  const firstKind = schedule.faults[0]!.kind;
  const conserves = (ledger: ReturnType<typeof deriveFaultLedger>) => {
    const s = ledger.summary;
    // Every scheduled fault lands in exactly one schedule-side bucket, and every
    // fired event lands in exactly one event-side bucket.
    assert.equal(s.matched + s.deferred + s.unaccounted, s.scheduled - s.dispositionMismatch - s.forbidden);
    assert.equal(ledger.entries.length, s.scheduled + s.rogue + s.duplicate);
    return ledger;
  };

  // PLANNED with no events: every scheduled fault is deferred and accounted.
  const planned = conserves(deriveFaultLedger({ schedule, events: [], mode: 'PLANNED' }));
  assert.equal(planned.containmentStatus, 'ACCOUNTED');
  assert.equal(planned.summary.deferred, schedule.faults.length);
  assert.equal(planned.mode, 'PLANNED');
  assert.equal(planned.scheduleHash, schedule.scheduleHash);

  // EXECUTED with no events: an un-fired scheduled fault is unaccounted → escape.
  const executedEmpty = deriveFaultLedger({ schedule, events: [], mode: 'EXECUTED' });
  assert.equal(executedEmpty.containmentStatus, 'ESCAPED');
  assert.equal(executedEmpty.summary.unaccounted, schedule.faults.length);

  // EXECUTED with every fault fired at an allowed disposition: accounted.
  const allowedEvents: FaultEvent[] = schedule.faults.map((fault) => ({
    faultId: fault.faultId,
    kind: fault.kind,
    firedSequence: fault.sequence,
    observedDisposition: fault.expectedDisposition,
  }));
  const executedOk = conserves(deriveFaultLedger({ schedule, events: allowedEvents, mode: 'EXECUTED' }));
  assert.equal(executedOk.containmentStatus, 'ACCOUNTED');
  assert.equal(executedOk.summary.matched, schedule.faults.length);

  // A fault that fired but was never scheduled is rogue → escape.
  const rogue = deriveFaultLedger({
    schedule,
    events: [{ faultId: `flt_${'a'.repeat(32)}`, kind: firstKind, firedSequence: 1, observedDisposition: 'APPLIED_ONCE' }],
    mode: 'PLANNED',
  });
  assert.equal(rogue.containmentStatus, 'ESCAPED');
  assert.equal(rogue.summary.rogue, 1);

  // A forbidden §20.3 outcome is an escape even for a scheduled fault.
  const forbidden = deriveFaultLedger({
    schedule,
    events: [{ faultId: schedule.faults[0]!.faultId, kind: firstKind, firedSequence: 1, observedDisposition: 'ORPHANED_ACCEPTED' }],
    mode: 'PLANNED',
  });
  assert.equal(forbidden.containmentStatus, 'ESCAPED');
  assert.equal(forbidden.summary.forbidden, 1);

  // An allowed-enum disposition that this kind may not legally resolve to escapes.
  const notAllowed = (['NOT_ACCEPTED_RETRYABLE', 'RECOVERED_BY_OWNER', 'APPLIED_ONCE', 'UNKNOWN_OUTCOME_RECONCILE'] as FaultDisposition[])
    .find((disposition) => !FAULT_KIND_ALLOWED_DISPOSITIONS[firstKind].includes(disposition));
  assert.ok(notAllowed, 'expected at least one disposition this kind disallows');
  const mismatch = deriveFaultLedger({
    schedule,
    events: [{ faultId: schedule.faults[0]!.faultId, kind: firstKind, firedSequence: 1, observedDisposition: notAllowed! }],
    mode: 'PLANNED',
  });
  assert.equal(mismatch.containmentStatus, 'ESCAPED');
  assert.equal(mismatch.summary.dispositionMismatch, 1);

  // One scheduled fault firing twice is a duplicate → escape.
  const duplicate = deriveFaultLedger({
    schedule,
    events: [
      { faultId: schedule.faults[0]!.faultId, kind: firstKind, firedSequence: 1, observedDisposition: schedule.faults[0]!.expectedDisposition },
      { faultId: schedule.faults[0]!.faultId, kind: firstKind, firedSequence: 2, observedDisposition: schedule.faults[0]!.expectedDisposition },
    ],
    mode: 'PLANNED',
  });
  assert.equal(duplicate.containmentStatus, 'ESCAPED');
  assert.equal(duplicate.summary.duplicate, 1);

  // The ledger is anchored to the exact event-log bytes it reconciled.
  assert.match(executedOk.sourceEventLogHash, /^sha256:[a-f0-9]{64}$/);
  const reordered = deriveFaultLedger({ schedule, events: [...allowedEvents].reverse(), mode: 'EXECUTED' });
  assert.notEqual(executedOk.sourceEventLogHash, reordered.sourceEventLogHash);
});

await check('the gate records a seed-derived fault schedule and fails closed on an escaped ledger', () => {
  const gateSource = readFileSync(
    new URL('./gate-orchestration-test-runtime.ts', import.meta.url),
    'utf8',
  );
  // The gate derives and records a per-suite schedule and its ledger.
  assert.match(gateSource, /deriveFaultSchedule\(/);
  assert.match(gateSource, /deriveFaultLedger\(/);
  assert.match(gateSource, /faultSchedule\b/);
  assert.match(gateSource, /faultLedger\b/);
  // An escaped fault ledger must be able to fail the gate, alongside the other
  // required containment checks.
  assert.match(
    gateSource,
    /faultLedger\?\.containmentStatus\s*===\s*'ACCOUNTED'/,
  );
  // The schedule/ledger are attached to the signed suite results, not printed
  // outside the attested payload.
  assert.match(gateSource, /results\.map\(attachFaultEvidence\)/);
});

await check('fake process-tree shape verifier and teardown fail closed on any deviation', async () => {
  // A minimal inspection carrying only the fields the shape verifier reads. The
  // baseline is the exact owned leader + child + grandchild.
  const groupEntry = (pid: number) => ({ stat: { pid } });
  const baseInspection = (overrides: Partial<OwnedProcessTreeInspection> = {}) => ({
    verifiable: true,
    leaderState: 'MATCH' as const,
    localIdentityMatches: true,
    escapedTokenMembers: [],
    groupMembers: [groupEntry(100), groupEntry(200), groupEntry(300)],
    reason: undefined,
    ...overrides,
  }) as unknown as OwnedProcessTreeInspection;
  const handle = { child: { pid: 200 }, grandchild: { pid: 300 } } as unknown as FakeProcessTreeHandle;

  // The exact three-member owned tree verifies.
  assert.equal(verifyFakeProcessTreeShape(baseInspection(), handle), null);
  // Every deviation is rejected with a reason and never silently accepted.
  assert.ok(verifyFakeProcessTreeShape(baseInspection({ verifiable: false }), handle));
  assert.ok(verifyFakeProcessTreeShape(baseInspection({ leaderState: 'MISSING' }), handle));
  assert.ok(verifyFakeProcessTreeShape(baseInspection({ leaderState: 'MISMATCH' }), handle));
  assert.ok(verifyFakeProcessTreeShape(baseInspection({ localIdentityMatches: false }), handle));
  assert.ok(verifyFakeProcessTreeShape(
    baseInspection({ escapedTokenMembers: [{ stat: { pid: 999 } }] as never }),
    handle,
  ));
  // A fourth member (e.g. an esbuild service that leaked into the group) fails.
  assert.ok(verifyFakeProcessTreeShape(
    baseInspection({ groupMembers: [groupEntry(100), groupEntry(200), groupEntry(300), groupEntry(400)] as never }),
    handle,
  ));
  // A missing child or grandchild fails.
  assert.ok(verifyFakeProcessTreeShape(
    baseInspection({ groupMembers: [groupEntry(100), groupEntry(300)] as never }),
    handle,
  ));
  assert.ok(verifyFakeProcessTreeShape(
    baseInspection({ groupMembers: [groupEntry(100), groupEntry(200)] as never }),
    handle,
  ));

  // The evidence schema is strict.
  const validEvidence = {
    schemaVersion: FAKE_PROCESS_TREE_EVIDENCE_VERSION,
    status: 'PASS' as const,
    shapeVerified: true,
    termIgnored: true,
    killedEmpty: true,
    childAbsent: true,
    grandchildAbsent: true,
    escapedTokenMembers: 0,
    observedGroupMembers: 3,
    signals: ['SIGTERM', 'SIGKILL'] as const,
    ownerLeaderPid: 100,
    childPid: 200,
    grandchildPid: 300,
  };
  fakeProcessTreeEvidenceSchema.parse(validEvidence);
  assert.throws(() => fakeProcessTreeEvidenceSchema.parse({ ...validEvidence, status: 'MAYBE' }));
  assert.throws(() => fakeProcessTreeEvidenceSchema.parse({ ...validEvidence, signals: ['SIGHUP'] }));
  assert.throws(() => fakeProcessTreeEvidenceSchema.parse({ ...validEvidence, schemaVersion: 'x' }));

  // Teardown fails closed on a fabricated owner whose leader is not observable:
  // no live process matches, so the exact tree cannot be verified and no signal
  // is ever sent. The high PID is not a live process, so `/proc` reports MISSING.
  const foreignOwner = {
    processExecutionId: 'g0_fake_absent_exec',
    runtimeRunId: 'g0_fake_absent_run',
    workerInstanceId: 'g0-fake-process-tree',
    ownerGeneration: 1,
    attemptFence: 1,
    mode: 'PROCESS_GROUP' as const,
    hostId: 'fake-host',
    hostBootId: 'fake-boot',
    pidNamespaceId: 'pid:[4026531999]',
    pid: 4_190_000,
    pgid: 4_190_000,
    sid: 4_190_000,
    processStartToken: '999999999',
    registeredAt: new Date(),
    startedAt: new Date(),
  };
  const foreignHandle = {
    owner: foreignOwner,
    leader: { pid: 4_190_000 },
    child: { pid: 4_190_001 },
    grandchild: { pid: 4_190_002 },
    leaderProcess: undefined,
  } as unknown as FakeProcessTreeHandle;
  const evidence = await teardownFakeProcessTree(foreignHandle);
  assert.equal(evidence.status, 'FAILED');
  assert.equal(evidence.shapeVerified, false);
  assert.deepEqual(evidence.signals, []);
  fakeProcessTreeEvidenceSchema.parse(evidence);
});

await check('provider stubs are deterministic, closed-enum and fail closed on an unstubbed provider', () => {
  // Closed enums cover exactly the §19.1 providers and the §19.3 response modes.
  assert.deepEqual([...PROVIDER_STUB_KINDS], [
    'GOOGLE', 'GMAIL', 'CALENDAR', 'N8N', 'FIRECRAWL', 'PLAYWRIGHT', 'MCP', 'MEDIA',
  ]);
  assert.deepEqual([...PROVIDER_RESPONSE_MODES], [
    'OK', 'EMPTY', 'MALFORMED', 'RATE_LIMITED', 'HUNG_CONNECT', 'HUNG_BODY', 'POLLING',
  ]);

  const registry = createProviderStubRegistry({ seed: 4242, providers: ['GMAIL', 'FIRECRAWL', 'N8N', 'MCP'] });
  // The declared set is deduplicated, ordered and hash-bound regardless of input order.
  const reordered = createProviderStubRegistry({ seed: 4242, providers: ['MCP', 'N8N', 'GMAIL', 'GMAIL', 'FIRECRAWL'] });
  assert.deepEqual(registry.declared, ['FIRECRAWL', 'GMAIL', 'MCP', 'N8N']);
  assert.equal(registry.declaredSetHash, reordered.declaredSetHash);

  // Dispatch is a pure function of (seed, provider, operation, requestId).
  const request = { provider: 'FIRECRAWL' as const, operation: 'scrape', requestId: 'req-1' };
  const first = dispatchProviderStub(registry, request);
  const again = dispatchProviderStub(registry, request);
  assert.deepEqual(first, again);
  assert.equal(first.external, false);
  // A different seed diverges the response.
  const otherSeed = createProviderStubRegistry({ seed: 4243, providers: ['FIRECRAWL'] });
  assert.notEqual(
    dispatchProviderStub(otherSeed, request).bodyHash,
    first.bodyHash,
  );

  // Fault-mode envelopes stay bounded and only fault modes carry them.
  const modes = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    const response = dispatchProviderStub(registry, { provider: 'N8N', operation: 'run', requestId: `r${i}` });
    modes.add(response.mode);
    if (response.mode === 'RATE_LIMITED') assert.ok(response.retryAfterMs >= 100 && response.retryAfterMs <= 60_000);
    else assert.equal(response.retryAfterMs, 0);
    if (response.mode === 'HUNG_CONNECT' || response.mode === 'HUNG_BODY') assert.ok(response.hungMs >= 100 && response.hungMs <= 60_000);
    else assert.equal(response.hungMs, 0);
    if (response.mode === 'POLLING') assert.ok(response.pollAttempts >= 2 && response.pollAttempts <= 16);
    else assert.equal(response.pollAttempts, 0);
    assert.equal(providerResponseIsFaultMode(response), ['RATE_LIMITED', 'HUNG_CONNECT', 'HUNG_BODY', 'POLLING'].includes(response.mode));
  }
  assert.ok(modes.size >= 5, 'expected several response modes to be exercised');

  // Fail-closed dispatch: an undeclared or unknown provider throws instead of
  // reaching a real endpoint.
  assert.throws(
    () => dispatchProviderStub(registry, { provider: 'GOOGLE', operation: 'x', requestId: 'r' }),
    UnstubbedProviderError,
  );
  assert.throws(() => dispatchProviderStub(registry, { provider: 'NOPE' as never, operation: 'x', requestId: 'r' }));
  assert.throws(() => createProviderStubRegistry({ seed: -1, providers: ['GMAIL'] }));
  assert.throws(() => createProviderStubRegistry({ seed: 1, providers: ['NOPE' as never] }));
});

await check('provider-stub ledger is an independent, fail-closed cross-check', () => {
  const registry = createProviderStubRegistry({ seed: 77, providers: ['GMAIL', 'FIRECRAWL', 'MCP'] });
  const exchange = (provider: 'GMAIL' | 'FIRECRAWL' | 'MCP', requestId: string): ProviderStubExchange => {
    const request = { provider, operation: 'op', requestId };
    return { request, response: dispatchProviderStub(registry, request) };
  };

  // Every exchange re-dispatched from the registry is contained.
  const good = deriveProviderStubLedger({
    registry,
    exchanges: [exchange('GMAIL', 'a'), exchange('FIRECRAWL', 'b'), exchange('MCP', 'c')],
  });
  assert.equal(good.containmentStatus, 'STUBBED');
  assert.equal(good.summary.stubbed, 3);
  assert.equal(good.summary.exchanges, 3);
  assert.equal(good.entries.length, 3);
  assert.equal(good.declaredSetHash, registry.declaredSetHash);
  assert.match(good.sourceExchangeLogHash, /^sha256:[a-f0-9]{64}$/);

  // A request to an undeclared provider is an unstubbed access → escape.
  const undeclared = exchange('GMAIL', 'x');
  const unstubbed = deriveProviderStubLedger({
    registry,
    exchanges: [{ request: { ...undeclared.request, provider: 'GOOGLE' }, response: { ...undeclared.response, provider: 'GOOGLE' } }],
  });
  assert.equal(unstubbed.containmentStatus, 'ESCAPED');
  assert.equal(unstubbed.summary.unstubbed, 1);

  // A response that does not match the deterministic one is nondeterministic → escape.
  const base = exchange('GMAIL', 'y');
  const nondeterministic = deriveProviderStubLedger({
    registry,
    exchanges: [{ request: base.request, response: { ...base.response, bodyHash: `sha256:${'0'.repeat(64)}` } }],
  });
  assert.equal(nondeterministic.containmentStatus, 'ESCAPED');
  assert.equal(nondeterministic.summary.nondeterministic, 1);

  // An echo whose response does not describe the request → escape.
  const mism = exchange('GMAIL', 'z');
  const mismatched = deriveProviderStubLedger({
    registry,
    exchanges: [{ request: mism.request, response: { ...mism.response, requestId: 'other' } }],
  });
  assert.equal(mismatched.containmentStatus, 'ESCAPED');
  assert.equal(mismatched.summary.mismatchedEcho, 1);

  // A response claiming a real external effect is refused even for a declared
  // provider — an owned stub is always loopback.
  const ext = exchange('GMAIL', 'e');
  const external = deriveProviderStubLedger({
    registry,
    exchanges: [{ request: ext.request, response: { ...ext.response, external: true } }],
  });
  assert.equal(external.containmentStatus, 'ESCAPED');
  assert.equal(external.summary.external, 1);

  // Count conservation across every classification.
  const s = good.summary;
  assert.equal(s.stubbed + s.unstubbed + s.nondeterministic + s.external + s.mismatchedEcho, s.exchanges);
});

if (failures > 0) {
  console.error(`\n❌ check:orchestration-test-runtime — ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\n✅ check:orchestration-test-runtime — all assertions passed');
}
