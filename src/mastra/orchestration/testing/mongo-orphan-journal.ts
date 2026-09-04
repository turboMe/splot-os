/**
 * Parent-only crash journal and reclaimer for G0 Mongo test databases.
 *
 * The journal is the trust anchor that survives a killed suite. It is written
 * by the parent after the exact child process has been claimed and before the
 * fixed bootstrap releases any workload code. A later gate can therefore prove
 * both that the original owner process is gone and that the live Mongo
 * namespace still matches the secret-backed allocation before it performs a
 * destructive drop.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  MongoClient,
  type Db,
  type Filter,
} from 'mongodb';
import { z } from 'zod';
import {
  inspectOwnedProcessTree,
  readLinuxProcessIdentity,
  readLocalProcessHostIdentity,
  signalOwnedProcessGroup,
  waitForOwnedProcessTreeEmpty,
} from '../execution/linux-process-tree.js';
import type { AttemptProcessOwnerDoc } from '../store/collections.js';
import {
  TEST_RUNTIME_OWNER_COLLECTION,
  createReclaimClaimedMongoOwnerMarker,
  hashCanonicalValue,
  mongoOwnerAllocationSchema,
  mongoOwnerCollectionEpochFingerprint,
  mongoTopologyFingerprintFromHello,
  verifyMongoOwnerMarkerForAllocation,
  type MongoOwnerAllocationV1,
  type MongoOwnerMarker,
} from './test-runtime.js';

export const MONGO_ORPHAN_JOURNAL_ENTRY_VERSION =
  'g0-mongo-orphan-journal-entry/v1' as const;
export const MONGO_ORPHAN_JOURNAL_CLAIM_VERSION =
  'g0-mongo-orphan-journal-claim/v1' as const;
export const MONGO_ORPHAN_RECLAIM_VERSION =
  'g0-mongo-orphan-reclaim/v2' as const;

const JOURNAL_DIRECTORY_VERSION = 'v1';
const JOURNAL_ENTRY_RE = /^g0run_[a-f0-9]{32}\.json$/;
const JOURNAL_CLAIM_RE = /^g0run_[a-f0-9]{32}\.json\.claim$/;
const JOURNAL_TEMP_RE =
  /^\.(g0run_[a-f0-9]{32}\.json(?:\.claim)?)\.tmp\.[a-f0-9]{64}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const CLAIM_ID_RE = /^[a-f0-9]{64}$/;
const BOOT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PID_NAMESPACE_RE = /^pid:\[[1-9][0-9]*\]$/;
const PROCESS_START_RE = /^[0-9]+$/;
const MAX_JOURNAL_ENTRIES = 64;
const MAX_JOURNAL_DIRECTORY_ENTRIES = MAX_JOURNAL_ENTRIES * 3;
const MAX_JOURNAL_FILE_BYTES = 16 * 1024;
const DEFAULT_RECLAIM_DEADLINE_MS = 20_000;
const MAX_COMMAND_TIMEOUT_MS = 3_000;

const localProcessIdentitySchema = z.object({
  hostId: z.string().min(1).max(255),
  hostBootId: z.string().regex(BOOT_ID_RE),
  pidNamespaceId: z.string().regex(PID_NAMESPACE_RE),
  pid: z.number().int().min(2),
  processStartToken: z.string().regex(PROCESS_START_RE),
}).strict();
type LocalProcessIdentity = z.infer<typeof localProcessIdentitySchema>;

const journalProcessOwnerSchema = localProcessIdentitySchema.extend({
  processExecutionId: z.string().min(1).max(255),
  runtimeRunId: z.string().min(1).max(255),
  workerInstanceId: z.string().min(1).max(255),
  ownerGeneration: z.number().int().nonnegative(),
  attemptFence: z.number().int().nonnegative(),
  mode: z.literal('PROCESS_GROUP'),
  pgid: z.number().int().min(2),
  sid: z.number().int().min(2),
  registeredAt: z.string().datetime(),
  startedAt: z.string().datetime(),
}).strict();
export type MongoJournalProcessOwner = z.infer<typeof journalProcessOwnerSchema>;

const unsignedJournalEntrySchema = z.object({
  schemaVersion: z.literal(MONGO_ORPHAN_JOURNAL_ENTRY_VERSION),
  allocation: mongoOwnerAllocationSchema,
  parentProcess: localProcessIdentitySchema,
  workloadProcessOwner: journalProcessOwnerSchema,
  registeredAt: z.string().datetime(),
}).strict();

const journalEntrySchema = unsignedJournalEntrySchema.extend({
  entryHash: z.string().regex(SHA256_RE),
}).strict().superRefine((entry, context) => {
  const { entryHash: _entryHash, ...unsigned } = entry;
  if (entry.entryHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['entryHash'],
      message: 'Mongo orphan journal entry hash does not match',
    });
  }
});
export type MongoOrphanJournalEntry = z.infer<typeof journalEntrySchema>;

const unsignedJournalClaimSchema = z.object({
  schemaVersion: z.literal(MONGO_ORPHAN_JOURNAL_CLAIM_VERSION),
  runId: z.string().regex(/^g0run_[a-f0-9]{32}$/),
  entryHash: z.string().regex(SHA256_RE),
  allocation: mongoOwnerAllocationSchema,
  claimId: z.string().regex(CLAIM_ID_RE),
  claimantProcess: localProcessIdentitySchema,
  claimedAt: z.string().datetime(),
}).strict().superRefine((claim, context) => {
  if (claim.runId !== claim.allocation.runId) {
    context.addIssue({
      code: 'custom',
      path: ['allocation', 'runId'],
      message: 'Mongo orphan journal claim allocation does not match its run',
    });
  }
});

const journalClaimSchema = unsignedJournalClaimSchema.extend({
  claimHash: z.string().regex(SHA256_RE),
}).strict().superRefine((claim, context) => {
  const { claimHash: _claimHash, ...unsigned } = claim;
  if (claim.claimHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['claimHash'],
      message: 'Mongo orphan journal claim hash does not match',
    });
  }
});
type MongoOrphanJournalClaim = z.infer<typeof journalClaimSchema>;

const reclaimEffectSchema = z.object({
  entryHash: z.string().regex(SHA256_RE),
  resourceHash: z.string().regex(SHA256_RE),
  outcome: z.enum([
    'ACTIVE_SKIPPED',
    'OTHER_TOPOLOGY_SKIPPED',
    'CLAIMED_BY_LIVE_RECLAIMER',
    'ALREADY_ABSENT',
    'RECLAIMED',
    'UNSAFE_RETAINED',
    'FAILED_RETAINED',
  ]),
  reasonCode: z.enum([
    'OWNER_ACTIVE',
    'OTHER_TOPOLOGY',
    'RECLAIMER_ACTIVE',
    'DATABASE_ALREADY_ABSENT',
    'DATABASE_RECLAIMED',
    'JOURNAL_INVALID',
    'OWNER_LIVENESS_UNPROVEN',
    'COLLECTION_OWNERSHIP_INVALID',
    'MARKER_OWNERSHIP_INVALID',
    'RECLAIM_CAS_LOST',
    'DATABASE_ABSENCE_UNPROVEN',
    'COMMAND_FAILED',
  ]),
  ambiguousDropResolved: z.boolean(),
}).strict().superRefine((item, context) => {
  const expectedReasons: Record<string, string> = {
    ACTIVE_SKIPPED: 'OWNER_ACTIVE',
    OTHER_TOPOLOGY_SKIPPED: 'OTHER_TOPOLOGY',
    CLAIMED_BY_LIVE_RECLAIMER: 'RECLAIMER_ACTIVE',
    ALREADY_ABSENT: 'DATABASE_ALREADY_ABSENT',
    RECLAIMED: 'DATABASE_RECLAIMED',
    UNSAFE_RETAINED: item.reasonCode,
    FAILED_RETAINED: item.reasonCode,
  };
  if (item.reasonCode !== expectedReasons[item.outcome]) {
    context.addIssue({
      code: 'custom',
      path: ['reasonCode'],
      message: 'Mongo orphan reclaim outcome and reason do not match',
    });
  }
  if (item.ambiguousDropResolved && item.outcome !== 'RECLAIMED') {
    context.addIssue({
      code: 'custom',
      path: ['ambiguousDropResolved'],
      message: 'Only a verified reclaim can resolve an ambiguous drop',
    });
  }
});
export type MongoOrphanReclaimEffect = z.infer<typeof reclaimEffectSchema>;

export const mongoOrphanReclaimReportSchema = z.object({
  schemaVersion: z.literal(MONGO_ORPHAN_RECLAIM_VERSION),
  status: z.enum(['PASSED', 'FAILED']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  deadlineMs: z.number().int().min(1).max(120_000),
  timedOut: z.boolean(),
  topologyVerified: z.boolean(),
  journalRootVerified: z.boolean(),
  scanComplete: z.boolean(),
  scannedEntries: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  activeCount: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  otherTopologyCount: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  claimedByLiveReclaimerCount: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  reclaimedCount: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  alreadyAbsentCount: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  unsafeCount: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  failedCount: z.number().int().nonnegative().max(MAX_JOURNAL_ENTRIES),
  reclaimVerified: z.boolean(),
  effects: z.array(reclaimEffectSchema).max(MAX_JOURNAL_ENTRIES),
}).strict().superRefine((report, context) => {
  const expectedCounts = {
    activeCount: report.effects.filter(
      (item) => item.outcome === 'ACTIVE_SKIPPED',
    ).length,
    otherTopologyCount: report.effects.filter(
      (item) => item.outcome === 'OTHER_TOPOLOGY_SKIPPED',
    ).length,
    claimedByLiveReclaimerCount: report.effects.filter(
      (item) => item.outcome === 'CLAIMED_BY_LIVE_RECLAIMER',
    ).length,
    reclaimedCount: report.effects.filter(
      (item) => item.outcome === 'RECLAIMED',
    ).length,
    alreadyAbsentCount: report.effects.filter(
      (item) => item.outcome === 'ALREADY_ABSENT',
    ).length,
    unsafeCount: report.effects.filter(
      (item) => item.outcome === 'UNSAFE_RETAINED',
    ).length,
    failedCount: report.effects.filter(
      (item) => item.outcome === 'FAILED_RETAINED',
    ).length,
  };
  for (const [field, expected] of Object.entries(expectedCounts)) {
    if (report[field as keyof typeof expectedCounts] !== expected) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: 'Mongo orphan reclaim counters do not match bounded effects',
      });
    }
  }
  if (
    report.scanComplete
    && (
      report.effects.length !== report.scannedEntries
      || Object.values(expectedCounts).reduce((sum, value) => sum + value, 0)
        !== report.scannedEntries
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['scannedEntries'],
      message: 'Mongo orphan reclaim scan does not conserve entry outcomes',
    });
  }
  if (
    report.status === 'PASSED'
    && (
      !report.topologyVerified
      || !report.journalRootVerified
      || !report.scanComplete
      || report.timedOut
      || report.unsafeCount !== 0
      || report.failedCount !== 0
      || !report.reclaimVerified
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Mongo orphan reclaim cannot pass without complete verification',
    });
  }
  if (report.reclaimVerified && report.status !== 'PASSED') {
    context.addIssue({
      code: 'custom',
      path: ['reclaimVerified'],
      message: 'Failed Mongo orphan reclaim cannot be verified',
    });
  }
});
export type MongoOrphanReclaimReport = z.infer<typeof mongoOrphanReclaimReportSchema>;

interface JournalFile<T> {
  path: string;
  stat: BigIntStats;
  value: T;
}

interface MongoOrphanJournalInventory {
  entries: Array<JournalFile<MongoOrphanJournalEntry>>;
  orphanClaims: Array<JournalFile<MongoOrphanJournalClaim>>;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && (left.mode & 0o7777n) === (right.mode & 0o7777n);
}

function assertPrivateRoot(root: string): BigIntStats {
  const resolved = resolve(root);
  const actual = realpathSync(resolved);
  if (actual !== resolved) throw new Error('Mongo orphan journal root is redirected');
  const stat = lstatSync(actual, { bigint: true });
  const expectedUid = typeof process.getuid === 'function'
    ? BigInt(process.getuid())
    : stat.uid;
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid
    || (stat.mode & 0o777n) !== 0o700n
  ) {
    throw new Error('Mongo orphan journal root is not a private owned directory');
  }
  return stat;
}

function fsyncDirectory(root: string): void {
  const fd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writePrivateFileAtomically(path: string, value: unknown): BigIntStats {
  const parent = resolve(join(path, '..'));
  const temp = join(
    parent,
    `.${basename(path)}.tmp.${randomBytes(32).toString('hex')}`,
  );
  const bytes = canonicalBytes(value);
  if (bytes.byteLength > MAX_JOURNAL_FILE_BYTES) {
    throw new RangeError('Mongo orphan journal file exceeds its fixed byte limit');
  }
  const fd = openSync(
    temp,
    fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_WRONLY
      | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    const expectedUid = typeof process.getuid === 'function'
      ? BigInt(process.getuid())
      : stat.uid;
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== expectedUid
      || stat.nlink !== 1n
      || (stat.mode & 0o777n) !== 0o600n
      || stat.size !== BigInt(bytes.byteLength)
    ) {
      throw new Error('Mongo orphan journal temp file is not private and exact');
    }
  } finally {
    closeSync(fd);
  }
  try {
    // Publishing with a hard link is an atomic no-replace operation: the
    // completely fsynced temp inode becomes visible only if the final name did
    // not already exist. This is also the reclaimers' filesystem CAS.
    linkSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
  unlinkSync(temp);
  fsyncDirectory(parent);
  const result = lstatSync(path, { bigint: true });
  if (
    !result.isFile()
    || result.isSymbolicLink()
    || result.nlink !== 1n
    || (result.mode & 0o777n) !== 0o600n
  ) {
    throw new Error('Mongo orphan journal entry was replaced after publication');
  }
  return result;
}

function readPrivateJson<T>(
  path: string,
  schema: z.ZodType<T>,
): JournalFile<T> {
  const before = lstatSync(path, { bigint: true });
  const expectedUid = typeof process.getuid === 'function'
    ? BigInt(process.getuid())
    : before.uid;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== expectedUid
    || before.nlink !== 1n
    || (before.mode & 0o777n) !== 0o600n
    || before.size < 2n
    || before.size > BigInt(MAX_JOURNAL_FILE_BYTES)
  ) {
    throw new Error('Mongo orphan journal file is not a private regular file');
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (
    !sameFileIdentity(before, after)
    || after.size !== before.size
    || bytes.byteLength !== Number(before.size)
  ) {
    throw new Error('Mongo orphan journal file changed while being read');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Mongo orphan journal file is not valid JSON');
  }
  return { path, stat: after, value: schema.parse(candidate) };
}

function unlinkPrivateFileExact(file: JournalFile<unknown>, root: string): void {
  const current = lstatSync(file.path, { bigint: true });
  if (!sameFileIdentity(current, file.stat)) {
    throw new Error('Mongo orphan journal file changed before unlink');
  }
  unlinkSync(file.path);
  fsyncDirectory(root);
}

async function currentLocalProcessIdentity(): Promise<LocalProcessIdentity> {
  const [local, processIdentity] = await Promise.all([
    readLocalProcessHostIdentity(),
    readLinuxProcessIdentity(process.pid),
  ]);
  if (!processIdentity) throw new Error('current reclaimer process identity is unavailable');
  return localProcessIdentitySchema.parse({
    hostId: local.hostId,
    hostBootId: local.hostBootId,
    pidNamespaceId: processIdentity.pidNamespaceId,
    pid: processIdentity.pid,
    processStartToken: processIdentity.processStartToken,
  });
}

async function localProcessIdentityIsLive(
  owner: LocalProcessIdentity,
): Promise<boolean> {
  const local = await readLocalProcessHostIdentity();
  if (owner.hostId !== local.hostId) {
    throw new Error('journal process host identity cannot be reconciled locally');
  }
  if (owner.hostBootId !== local.hostBootId) return false;
  if (owner.pidNamespaceId !== local.pidNamespaceId) {
    throw new Error('journal PID namespace changed without a host reboot');
  }
  const current = await readLinuxProcessIdentity(owner.pid);
  return current !== null
    && current.pidNamespaceId === owner.pidNamespaceId
    && current.processStartToken === owner.processStartToken;
}

function processOwnerDoc(
  owner: MongoJournalProcessOwner,
): AttemptProcessOwnerDoc {
  return {
    ...owner,
    registeredAt: new Date(owner.registeredAt),
    startedAt: new Date(owner.startedAt),
  };
}

async function stopAndVerifyWorkloadTreeEmpty(
  ownerInput: MongoJournalProcessOwner,
): Promise<void> {
  const local = await readLocalProcessHostIdentity();
  if (ownerInput.hostId !== local.hostId) {
    throw new Error('orphan workload belongs to another host');
  }
  if (ownerInput.hostBootId !== local.hostBootId) {
    // A Linux boot ID change is a stronger empty-tree proof than PID probing:
    // no process from the recorded boot can still exist on this host.
    return;
  }
  if (ownerInput.pidNamespaceId !== local.pidNamespaceId) {
    throw new Error('orphan workload PID namespace changed on the same boot');
  }
  const owner = processOwnerDoc(ownerInput);
  let inspection = await inspectOwnedProcessTree(owner);
  if (!inspection.verifiable && !inspection.treeEmpty) {
    throw new Error('orphan workload process tree is not verifiable');
  }
  if (inspection.treeEmpty) return;
  const term = await signalOwnedProcessGroup(owner, 'SIGTERM');
  if (!term.sent && !term.alreadyEmpty) {
    throw new Error('orphan workload process tree refused SIGTERM');
  }
  let waited = await waitForOwnedProcessTreeEmpty(owner, {
    timeoutMs: 500,
    pollMs: 10,
  });
  if (waited.empty) return;
  const kill = await signalOwnedProcessGroup(owner, 'SIGKILL');
  if (!kill.sent && !kill.alreadyEmpty) {
    throw new Error('orphan workload process tree refused SIGKILL');
  }
  waited = await waitForOwnedProcessTreeEmpty(owner, {
    timeoutMs: 1_000,
    pollMs: 10,
  });
  inspection = waited.inspection;
  if (!waited.empty || !inspection.treeEmpty) {
    throw new Error('orphan workload process tree did not become empty');
  }
}

function ownerFromProcessClaim(owner: AttemptProcessOwnerDoc): MongoJournalProcessOwner {
  if (
    owner.mode !== 'PROCESS_GROUP'
    || owner.pidNamespaceId === undefined
    || owner.sid === undefined
  ) {
    throw new Error('Mongo orphan journal requires an exact PROCESS_GROUP owner');
  }
  return journalProcessOwnerSchema.parse({
    hostId: owner.hostId,
    hostBootId: owner.hostBootId,
    pidNamespaceId: owner.pidNamespaceId,
    pid: owner.pid,
    processExecutionId: owner.processExecutionId,
    runtimeRunId: owner.runtimeRunId,
    workerInstanceId: owner.workerInstanceId,
    ownerGeneration: owner.ownerGeneration,
    attemptFence: owner.attemptFence,
    mode: owner.mode,
    pgid: owner.pgid,
    sid: owner.sid,
    processStartToken: owner.processStartToken,
    registeredAt: owner.registeredAt.toISOString(),
    startedAt: owner.startedAt.toISOString(),
  });
}

function unsignedEntry(
  allocation: MongoOwnerAllocationV1,
  parentProcess: LocalProcessIdentity,
  workloadProcessOwner: MongoJournalProcessOwner,
): z.infer<typeof unsignedJournalEntrySchema> {
  return unsignedJournalEntrySchema.parse({
    schemaVersion: MONGO_ORPHAN_JOURNAL_ENTRY_VERSION,
    allocation,
    parentProcess,
    workloadProcessOwner,
    registeredAt: new Date().toISOString(),
  });
}

function entryPath(root: string, runId: string): string {
  return join(root, `${runId}.json`);
}

function claimPath(root: string, runId: string): string {
  return join(root, `${runId}.json.claim`);
}

function strictDatabaseNames(result: unknown): string[] {
  if (!result || typeof result !== 'object') {
    throw new Error('Mongo listDatabases result is not an object');
  }
  const databases = (result as { databases?: unknown }).databases;
  if (
    !Array.isArray(databases)
    || databases.some((entry) =>
      !entry
      || typeof entry !== 'object'
      || typeof (entry as { name?: unknown }).name !== 'string')
  ) {
    throw new Error('Mongo listDatabases result is malformed');
  }
  return databases.map((entry) => (entry as { name: string }).name);
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining < 1) {
    throw new Error('Mongo orphan reclaim exceeded its global deadline');
  }
  return Math.max(1, Math.min(MAX_COMMAND_TIMEOUT_MS, Math.floor(remaining)));
}

async function databaseExists(
  client: MongoClient,
  dbName: string,
  deadline: number,
): Promise<boolean> {
  const result = await client.db('admin').command({
    listDatabases: 1,
    nameOnly: true,
    filter: { name: dbName },
  }, { timeoutMS: remainingTimeout(deadline) });
  return strictDatabaseNames(result).includes(dbName);
}

async function ownerCollectionInfos(
  db: Db,
  deadline: number,
): Promise<unknown[]> {
  // The exact-name filter can match at most one namespace in MongoDB and keeps
  // a hostile database with many business collections from inflating memory.
  return db.listCollections(
    { name: TEST_RUNTIME_OWNER_COLLECTION },
    {
      nameOnly: false,
      batchSize: 2,
      timeoutMS: remainingTimeout(deadline),
    },
  ).toArray();
}

async function databaseContainsOnlyOwnerCollection(
  db: Db,
  deadline: number,
): Promise<boolean> {
  // Marker absence is valid only in the createCollection→insert marker crash
  // window. Read at most two names: one exact owner namespace passes, any
  // second namespace proves that business work began without an authenticated
  // marker and must be retained.
  const cursor = db.listCollections(
    {},
    {
      nameOnly: true,
      batchSize: 2,
      timeoutMS: remainingTimeout(deadline),
    },
  );
  const names: string[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const row = await cursor.tryNext();
      if (row === null) break;
      if (!row || typeof row.name !== 'string') {
        throw new Error('Mongo listCollections result is malformed');
      }
      names.push(row.name);
    }
  } finally {
    await cursor.close().catch(() => {});
  }
  return names.length === 1 && names[0] === TEST_RUNTIME_OWNER_COLLECTION;
}

function effect(
  authority: Pick<MongoOrphanJournalEntry, 'entryHash' | 'allocation'>,
  outcome: MongoOrphanReclaimEffect['outcome'],
  reasonCode: MongoOrphanReclaimEffect['reasonCode'],
  ambiguousDropResolved = false,
): MongoOrphanReclaimEffect {
  return reclaimEffectSchema.parse({
    entryHash: authority.entryHash,
    resourceHash: hashCanonicalValue(authority.allocation.dbName),
    outcome,
    reasonCode,
    ambiguousDropResolved,
  });
}

function exactMarkerCasFilter(marker: MongoOwnerMarker): Filter<MongoOwnerMarker> {
  return {
    _id: marker._id,
    schemaVersion: marker.schemaVersion,
    runId: marker.runId,
    dbName: marker.dbName,
    topologyFingerprint: marker.topologyFingerprint,
    collectionEpochFingerprint: marker.collectionEpochFingerprint,
    createdAt: marker.createdAt,
    proof: marker.proof,
    state: marker.state,
    cleanupClaimedAt: marker.cleanupClaimedAt
      ?? ({ $exists: false } as never),
    reclaimClaimIdHash: marker.reclaimClaimIdHash
      ?? ({ $exists: false } as never),
    reclaimFence: marker.reclaimFence
      ?? ({ $exists: false } as never),
    reclaimClaimedAt: marker.reclaimClaimedAt
      ?? ({ $exists: false } as never),
  };
}

export class MongoOrphanJournalStore {
  readonly root: string;
  readonly rootStat: BigIntStats;

  constructor(root = defaultMongoOrphanJournalRoot()) {
    const resolved = resolve(root);
    let created = false;
    try {
      mkdirSync(resolved, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Never chmod a pre-existing predictable /tmp path before proving what it
    // is. A newly-created directory may be narrower than 0700 because of
    // umask, so only that inode is normalized here.
    if (created) chmodSync(resolved, 0o700);
    this.root = realpathSync(resolved);
    this.rootStat = assertPrivateRoot(this.root);
  }

  private assertRootIdentity(): void {
    const current = assertPrivateRoot(this.root);
    if (
      current.dev !== this.rootStat.dev
      || current.ino !== this.rootStat.ino
      || current.uid !== this.rootStat.uid
      || (current.mode & 0o7777n) !== (this.rootStat.mode & 0o7777n)
    ) {
      throw new Error('Mongo orphan journal root identity changed');
    }
  }

  private unlinkExact(file: JournalFile<unknown>): void {
    this.assertRootIdentity();
    unlinkPrivateFileExact(file, this.root);
    this.assertRootIdentity();
  }

  private readBoundedDirectoryNames(): string[] {
    this.assertRootIdentity();
    const names: string[] = [];
    const directory = opendirSync(this.root);
    try {
      while (true) {
        const entry = directory.readSync();
        if (entry === null) break;
        names.push(entry.name);
        if (names.length > MAX_JOURNAL_DIRECTORY_ENTRIES) {
          throw new Error('Mongo orphan journal directory exceeds its fixed inventory limit');
        }
      }
    } finally {
      directory.closeSync();
    }
    this.assertRootIdentity();
    return names.sort();
  }

  private removeRecognizedTemps(names: readonly string[]): void {
    for (const name of names) {
      if (!JOURNAL_TEMP_RE.test(name)) continue;
      const path = join(this.root, name);
      const stat = lstatSync(path, { bigint: true });
      const expectedUid = typeof process.getuid === 'function'
        ? BigInt(process.getuid())
        : stat.uid;
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.uid !== expectedUid
        || (stat.mode & 0o777n) !== 0o600n
        || (stat.nlink !== 1n && stat.nlink !== 2n)
        || stat.size > BigInt(MAX_JOURNAL_FILE_BYTES)
      ) {
        throw new Error('Mongo orphan journal temp file is not private and exact');
      }
      this.unlinkExact({ path, stat, value: undefined });
    }
  }

  async register(
    allocationInput: MongoOwnerAllocationV1,
    processOwner: AttemptProcessOwnerDoc,
  ): Promise<MongoOrphanJournalEntry> {
    this.assertRootIdentity();
    const allocation = mongoOwnerAllocationSchema.parse(allocationInput);
    const unsigned = unsignedEntry(
      allocation,
      await currentLocalProcessIdentity(),
      ownerFromProcessClaim(processOwner),
    );
    const entry = journalEntrySchema.parse({
      ...unsigned,
      entryHash: hashCanonicalValue(unsigned),
    });
    writePrivateFileAtomically(entryPath(this.root, allocation.runId), entry);
    return entry;
  }

  read(allocationInput: MongoOwnerAllocationV1): JournalFile<MongoOrphanJournalEntry> {
    this.assertRootIdentity();
    const allocation = mongoOwnerAllocationSchema.parse(allocationInput);
    const file = readPrivateJson(
      entryPath(this.root, allocation.runId),
      journalEntrySchema,
    );
    if (
      hashCanonicalValue(file.value.allocation) !== hashCanonicalValue(allocation)
    ) {
      throw new Error('Mongo orphan journal entry does not match its allocation');
    }
    return file;
  }

  async completeVerifiedAbsent(
    client: MongoClient,
    allocationInput: MongoOwnerAllocationV1,
    deadlineMs = MAX_COMMAND_TIMEOUT_MS,
  ): Promise<void> {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new TypeError('Mongo journal completion deadline must be positive');
    }
    const allocation = mongoOwnerAllocationSchema.parse(allocationInput);
    const file = this.read(allocation);
    if (await databaseExists(client, allocation.dbName, Date.now() + deadlineMs)) {
      throw new Error('Mongo journal cannot complete while its database exists');
    }
    this.unlinkExact(file);
  }

  private readInventory(): MongoOrphanJournalInventory {
    const initialNames = this.readBoundedDirectoryNames();
    this.removeRecognizedTemps(initialNames);
    const names = this.readBoundedDirectoryNames();
    if (names.some((name) =>
      !JOURNAL_ENTRY_RE.test(name) && !JOURNAL_CLAIM_RE.test(name))) {
      throw new Error('Mongo orphan journal contains an unrecognized entry');
    }
    const entryNames = names.filter((name) => JOURNAL_ENTRY_RE.test(name));
    const claimNames = names.filter((name) => JOURNAL_CLAIM_RE.test(name));
    if (
      entryNames.length > MAX_JOURNAL_ENTRIES
      || claimNames.length > MAX_JOURNAL_ENTRIES
    ) {
      throw new Error('Mongo orphan journal exceeds its fixed entry limit');
    }
    const entries = entryNames.map((name) => {
      const file = readPrivateJson(join(this.root, name), journalEntrySchema);
      if (name !== `${file.value.allocation.runId}.json`) {
        throw new Error('Mongo orphan journal filename does not match its allocation');
      }
      return file;
    });
    const entriesByRunId = new Map(
      entries.map((file) => [file.value.allocation.runId, file] as const),
    );
    const orphanClaims: Array<JournalFile<MongoOrphanJournalClaim>> = [];
    for (const name of claimNames) {
      const claim = readPrivateJson(join(this.root, name), journalClaimSchema);
      if (name !== `${claim.value.runId}.json.claim`) {
        throw new Error('Mongo orphan journal claim filename does not match its run');
      }
      const entry = entriesByRunId.get(claim.value.runId);
      if (entry) {
        if (
          claim.value.entryHash !== entry.value.entryHash
          || hashCanonicalValue(claim.value.allocation)
            !== hashCanonicalValue(entry.value.allocation)
        ) {
          throw new Error('Mongo orphan journal claim does not match its entry');
        }
      } else {
        orphanClaims.push(claim);
      }
    }
    if (entries.length + orphanClaims.length > MAX_JOURNAL_ENTRIES) {
      throw new Error('Mongo orphan journal exceeds its fixed authority limit');
    }
    return { entries, orphanClaims };
  }

  listEntryFiles(): Array<JournalFile<MongoOrphanJournalEntry>> {
    return this.readInventory().entries;
  }

  private async acquireClaim(
    entry: MongoOrphanJournalEntry,
  ): Promise<
    | { acquired: true; file: JournalFile<MongoOrphanJournalClaim> }
    | { acquired: false }
  > {
    const path = claimPath(this.root, entry.allocation.runId);
    if (existsSync(path)) {
      const existing = readPrivateJson(path, journalClaimSchema);
      if (
        existing.value.entryHash !== entry.entryHash
        || hashCanonicalValue(existing.value.allocation)
          !== hashCanonicalValue(entry.allocation)
      ) {
        throw new Error('Mongo orphan journal claim does not match its entry');
      }
      if (await localProcessIdentityIsLive(existing.value.claimantProcess)) {
        return { acquired: false };
      }
      this.unlinkExact(existing);
    }
    const claimantProcess = await currentLocalProcessIdentity();
    const unsigned = unsignedJournalClaimSchema.parse({
      schemaVersion: MONGO_ORPHAN_JOURNAL_CLAIM_VERSION,
      runId: entry.allocation.runId,
      entryHash: entry.entryHash,
      allocation: entry.allocation,
      claimId: randomBytes(32).toString('hex'),
      claimantProcess,
      claimedAt: new Date().toISOString(),
    });
    const claim = journalClaimSchema.parse({
      ...unsigned,
      claimHash: hashCanonicalValue(unsigned),
    });
    try {
      const stat = writePrivateFileAtomically(path, claim);
      return { acquired: true, file: { path, stat, value: claim } };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'EEXIST'
        || existsSync(path)
      ) {
        const peer = readPrivateJson(path, journalClaimSchema);
        if (
          peer.value.entryHash !== entry.entryHash
          || hashCanonicalValue(peer.value.allocation)
            !== hashCanonicalValue(entry.allocation)
          || !await localProcessIdentityIsLive(peer.value.claimantProcess)
        ) {
          throw new Error('competing Mongo orphan journal claim is not live and exact');
        }
        return { acquired: false };
      }
      throw error;
    }
  }

  private releaseClaim(file: JournalFile<MongoOrphanJournalClaim>): void {
    if (!existsSync(file.path)) {
      throw new Error('Mongo orphan journal claim disappeared before release');
    }
    this.unlinkExact(file);
  }

  async reclaim(input: {
    client: MongoClient;
    topologyDescriptorHash: `sha256:${string}`;
    topologyHello: unknown;
    deadlineMs?: number;
    /** @internal Live crash-proof hook; production callers must omit it. */
    afterJournalUnlinkBeforeClaimRelease?: () => void | Promise<void>;
  }): Promise<MongoOrphanReclaimReport> {
    const deadlineMs = input.deadlineMs ?? DEFAULT_RECLAIM_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) {
      throw new TypeError('Mongo orphan reclaim deadline is invalid');
    }
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const deadline = startedAtMs + deadlineMs;
    const liveTopologyFingerprint = mongoTopologyFingerprintFromHello(
      input.topologyHello,
    );
    const effects: MongoOrphanReclaimEffect[] = [];
    let activeCount = 0;
    let otherTopologyCount = 0;
    let claimedByLiveReclaimerCount = 0;
    let reclaimedCount = 0;
    let alreadyAbsentCount = 0;
    let unsafeCount = 0;
    let failedCount = 0;
    let allDropsVerified = true;
    let inventory: MongoOrphanJournalInventory;
    try {
      inventory = this.readInventory();
    } catch {
      return mongoOrphanReclaimReportSchema.parse({
        schemaVersion: MONGO_ORPHAN_RECLAIM_VERSION,
        status: 'FAILED',
        startedAt,
        finishedAt: new Date().toISOString(),
        deadlineMs,
        timedOut: Date.now() >= deadline,
        topologyVerified: true,
        journalRootVerified: false,
        scanComplete: false,
        scannedEntries: 0,
        activeCount,
        otherTopologyCount,
        claimedByLiveReclaimerCount,
        reclaimedCount,
        alreadyAbsentCount,
        unsafeCount,
        failedCount: 0,
        reclaimVerified: false,
        effects,
      });
    }

    for (const claimFile of inventory.orphanClaims) {
      const authority = {
        entryHash: claimFile.value.entryHash,
        allocation: claimFile.value.allocation,
      };
      if (
        claimFile.value.allocation.topologyDescriptorHash
        !== input.topologyDescriptorHash
      ) {
        effects.push(effect(
          authority,
          'OTHER_TOPOLOGY_SKIPPED',
          'OTHER_TOPOLOGY',
        ));
        continue;
      }
      if (
        claimFile.value.allocation.topologyFingerprint
        !== liveTopologyFingerprint
      ) {
        effects.push(effect(
          authority,
          'UNSAFE_RETAINED',
          'COLLECTION_OWNERSHIP_INVALID',
        ));
        continue;
      }
      let claimantLive: boolean;
      try {
        claimantLive = await localProcessIdentityIsLive(
          claimFile.value.claimantProcess,
        );
      } catch {
        effects.push(effect(
          authority,
          'UNSAFE_RETAINED',
          'OWNER_LIVENESS_UNPROVEN',
        ));
        continue;
      }
      if (claimantLive) {
        effects.push(effect(
          authority,
          'CLAIMED_BY_LIVE_RECLAIMER',
          'RECLAIMER_ACTIVE',
        ));
        continue;
      }
      try {
        if (await databaseExists(
          input.client,
          claimFile.value.allocation.dbName,
          deadline,
        )) {
          effects.push(effect(
            authority,
            'UNSAFE_RETAINED',
            'DATABASE_ABSENCE_UNPROVEN',
          ));
          continue;
        }
        this.unlinkExact(claimFile);
        effects.push(effect(
          authority,
          'ALREADY_ABSENT',
          'DATABASE_ALREADY_ABSENT',
        ));
      } catch {
        effects.push(effect(authority, 'FAILED_RETAINED', 'COMMAND_FAILED'));
      }
    }

    const entries = inventory.entries;
    for (const initialFile of entries) {
      const entry = initialFile.value;
      if (entry.allocation.topologyDescriptorHash !== input.topologyDescriptorHash) {
        otherTopologyCount += 1;
        effects.push(effect(entry, 'OTHER_TOPOLOGY_SKIPPED', 'OTHER_TOPOLOGY'));
        continue;
      }
      if (entry.allocation.topologyFingerprint !== liveTopologyFingerprint) {
        unsafeCount += 1;
        effects.push(effect(entry, 'UNSAFE_RETAINED', 'COLLECTION_OWNERSHIP_INVALID'));
        continue;
      }

      let ownerLive: boolean;
      try {
        ownerLive = await localProcessIdentityIsLive(entry.parentProcess);
      } catch {
        unsafeCount += 1;
        effects.push(effect(entry, 'UNSAFE_RETAINED', 'OWNER_LIVENESS_UNPROVEN'));
        continue;
      }
      if (ownerLive) {
        activeCount += 1;
        effects.push(effect(entry, 'ACTIVE_SKIPPED', 'OWNER_ACTIVE'));
        continue;
      }

      let claim:
        | { acquired: true; file: JournalFile<MongoOrphanJournalClaim> }
        | { acquired: false };
      try {
        claim = await this.acquireClaim(entry);
      } catch {
        failedCount += 1;
        effects.push(effect(entry, 'FAILED_RETAINED', 'COMMAND_FAILED'));
        continue;
      }
      if (!claim.acquired) {
        claimedByLiveReclaimerCount += 1;
        effects.push(effect(
          entry,
          'CLAIMED_BY_LIVE_RECLAIMER',
          'RECLAIMER_ACTIVE',
        ));
        continue;
      }

      const claimedEffectStart = effects.length;
      let claimReleased = false;
      const releaseOwnedClaim = (): void => {
        this.releaseClaim(claim.file);
        claimReleased = true;
      };
      try {
        const currentFile = this.read(entry.allocation);
        if (
          currentFile.value.entryHash !== entry.entryHash
          || await localProcessIdentityIsLive(currentFile.value.parentProcess)
        ) {
          unsafeCount += 1;
          effects.push(effect(
            entry,
            'UNSAFE_RETAINED',
            'OWNER_LIVENESS_UNPROVEN',
          ));
          continue;
        }
        await stopAndVerifyWorkloadTreeEmpty(
          currentFile.value.workloadProcessOwner,
        );

        if (!await databaseExists(
          input.client,
          entry.allocation.dbName,
          deadline,
        )) {
          this.unlinkExact(currentFile);
          await input.afterJournalUnlinkBeforeClaimRelease?.();
          releaseOwnedClaim();
          alreadyAbsentCount += 1;
          effects.push(effect(
            entry,
            'ALREADY_ABSENT',
            'DATABASE_ALREADY_ABSENT',
          ));
          continue;
        }

        const db = input.client.db(entry.allocation.dbName);
        const ownerCollections = await ownerCollectionInfos(db, deadline);
        if (
          ownerCollections.length !== 1
        ) {
          unsafeCount += 1;
          effects.push(effect(
            entry,
            'UNSAFE_RETAINED',
            'COLLECTION_OWNERSHIP_INVALID',
          ));
          continue;
        }
        let epoch: `sha256:${string}`;
        try {
          epoch = mongoOwnerCollectionEpochFingerprint(
            ownerCollections[0],
            entry.allocation.collectionProof,
          );
        } catch {
          unsafeCount += 1;
          effects.push(effect(
            entry,
            'UNSAFE_RETAINED',
            'COLLECTION_OWNERSHIP_INVALID',
          ));
          continue;
        }

        const collection = db.collection<MongoOwnerMarker>(
          TEST_RUNTIME_OWNER_COLLECTION,
        );
        const rawMarker = await collection.findOne(
          { _id: 'owner' },
          { timeoutMS: remainingTimeout(deadline) },
        );
        if (
          rawMarker === null
          && !await databaseContainsOnlyOwnerCollection(db, deadline)
        ) {
          unsafeCount += 1;
          effects.push(effect(
            entry,
            'UNSAFE_RETAINED',
            'COLLECTION_OWNERSHIP_INVALID',
          ));
          continue;
        }
        let observedMarker: MongoOwnerMarker | null = null;
        if (rawMarker !== null) {
          try {
            observedMarker = verifyMongoOwnerMarkerForAllocation({
              marker: rawMarker,
              allocation: entry.allocation,
              collectionEpochFingerprint: epoch,
            });
          } catch {
            unsafeCount += 1;
            effects.push(effect(
              entry,
              'UNSAFE_RETAINED',
              'MARKER_OWNERSHIP_INVALID',
            ));
            continue;
          }
        }

        const claimedMarker = createReclaimClaimedMongoOwnerMarker({
          allocation: entry.allocation,
          collectionEpochFingerprint: epoch,
          reclaimClaimId: claim.file.value.claimId,
          reclaimFence: observedMarker?.state === 'RECLAIM_CLAIMED'
            ? observedMarker.reclaimFence! + 1
            : 1,
          reclaimClaimedAt: new Date(),
        });
        // Both commands can commit and then report a timeout. Their response is
        // therefore advisory; only an exact authenticated read-back decides
        // whether this claimant won.
        if (observedMarker === null) {
          try {
            await collection.insertOne(claimedMarker, {
              writeConcern: {
                w: 'majority',
                wtimeoutMS: remainingTimeout(deadline),
              },
              timeoutMS: remainingTimeout(deadline),
            });
          } catch {
            // Resolved by the exact read-back below.
          }
        } else {
          try {
            await collection.replaceOne(
              exactMarkerCasFilter(observedMarker),
              claimedMarker,
              {
                writeConcern: {
                  w: 'majority',
                  wtimeoutMS: remainingTimeout(deadline),
                },
                timeoutMS: remainingTimeout(deadline),
              },
            );
          } catch {
            // Resolved by the exact read-back below.
          }
        }
        let claimedMarkerReadBack: MongoOwnerMarker;
        try {
          claimedMarkerReadBack = verifyMongoOwnerMarkerForAllocation({
            marker: await collection.findOne(
              { _id: 'owner' },
              { timeoutMS: remainingTimeout(deadline) },
            ),
            allocation: entry.allocation,
            collectionEpochFingerprint: epoch,
          });
        } catch {
          failedCount += 1;
          effects.push(effect(entry, 'FAILED_RETAINED', 'RECLAIM_CAS_LOST'));
          continue;
        }
        if (
          claimedMarkerReadBack.state !== 'RECLAIM_CLAIMED'
          || claimedMarkerReadBack.reclaimClaimIdHash
            !== hashCanonicalValue(claim.file.value.claimId)
          || claimedMarkerReadBack.reclaimFence !== claimedMarker.reclaimFence
          || claimedMarkerReadBack.reclaimClaimedAt !== claimedMarker.reclaimClaimedAt
        ) {
          failedCount += 1;
          effects.push(effect(entry, 'FAILED_RETAINED', 'RECLAIM_CAS_LOST'));
          continue;
        }

        const postOwnerCollections = await ownerCollectionInfos(db, deadline);
        if (
          postOwnerCollections.length !== 1
          || mongoOwnerCollectionEpochFingerprint(
            postOwnerCollections[0]!,
            entry.allocation.collectionProof,
          ) !== epoch
        ) {
          unsafeCount += 1;
          effects.push(effect(
            entry,
            'UNSAFE_RETAINED',
            'COLLECTION_OWNERSHIP_INVALID',
          ));
          continue;
        }
        const postMarker = verifyMongoOwnerMarkerForAllocation({
          marker: await collection.findOne(
            { _id: 'owner' },
            { timeoutMS: remainingTimeout(deadline) },
          ),
          allocation: entry.allocation,
          collectionEpochFingerprint: epoch,
        });
        if (
          postMarker.state !== 'RECLAIM_CLAIMED'
          || postMarker.reclaimClaimIdHash
            !== hashCanonicalValue(claim.file.value.claimId)
          || postMarker.reclaimFence !== claimedMarker.reclaimFence
        ) {
          failedCount += 1;
          effects.push(effect(entry, 'FAILED_RETAINED', 'RECLAIM_CAS_LOST'));
          continue;
        }
        if (await localProcessIdentityIsLive(entry.parentProcess)) {
          unsafeCount += 1;
          effects.push(effect(
            entry,
            'UNSAFE_RETAINED',
            'OWNER_LIVENESS_UNPROVEN',
          ));
          continue;
        }
        await stopAndVerifyWorkloadTreeEmpty(entry.workloadProcessOwner);

        let dropThrew = false;
        try {
          await db.dropDatabase({
            writeConcern: {
              w: 'majority',
              wtimeoutMS: remainingTimeout(deadline),
            },
            timeoutMS: remainingTimeout(deadline),
          });
        } catch {
          dropThrew = true;
        }
        if (await databaseExists(
          input.client,
          entry.allocation.dbName,
          deadline,
        )) {
          allDropsVerified = false;
          failedCount += 1;
          effects.push(effect(
            entry,
            'FAILED_RETAINED',
            'DATABASE_ABSENCE_UNPROVEN',
          ));
          continue;
        }
        this.unlinkExact(currentFile);
        await input.afterJournalUnlinkBeforeClaimRelease?.();
        releaseOwnedClaim();
        reclaimedCount += 1;
        effects.push(effect(
          entry,
          'RECLAIMED',
          'DATABASE_RECLAIMED',
          dropThrew,
        ));
      } catch {
        failedCount += 1;
        effects.push(effect(entry, 'FAILED_RETAINED', 'COMMAND_FAILED'));
      } finally {
        if (!claimReleased) {
          try {
            releaseOwnedClaim();
          } catch {
            // Replace this entry's provisional outcome with the final
            // fail-closed outcome. Counts are derived from effects below.
            effects.splice(
              claimedEffectStart,
              effects.length - claimedEffectStart,
              effect(entry, 'FAILED_RETAINED', 'COMMAND_FAILED'),
            );
            allDropsVerified = false;
          }
        }
      }
    }

    const counted = {
      activeCount: effects.filter((item) => item.outcome === 'ACTIVE_SKIPPED').length,
      otherTopologyCount: effects.filter(
        (item) => item.outcome === 'OTHER_TOPOLOGY_SKIPPED',
      ).length,
      claimedByLiveReclaimerCount: effects.filter(
        (item) => item.outcome === 'CLAIMED_BY_LIVE_RECLAIMER',
      ).length,
      reclaimedCount: effects.filter((item) => item.outcome === 'RECLAIMED').length,
      alreadyAbsentCount: effects.filter(
        (item) => item.outcome === 'ALREADY_ABSENT',
      ).length,
      unsafeCount: effects.filter((item) => item.outcome === 'UNSAFE_RETAINED').length,
      failedCount: effects.filter((item) => item.outcome === 'FAILED_RETAINED').length,
    };
    const finishedAtMs = Date.now();
    const timedOut = finishedAtMs >= deadline;
    const scannedEntries = entries.length + inventory.orphanClaims.length;
    const passed = counted.unsafeCount === 0
      && counted.failedCount === 0
      && effects.length === scannedEntries
      && !timedOut;
    return mongoOrphanReclaimReportSchema.parse({
      schemaVersion: MONGO_ORPHAN_RECLAIM_VERSION,
      status: passed ? 'PASSED' : 'FAILED',
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      deadlineMs,
      timedOut,
      topologyVerified: true,
      journalRootVerified: true,
      scanComplete: true,
      scannedEntries,
      ...counted,
      reclaimVerified: passed && allDropsVerified,
      effects,
    });
  }
}

export function defaultMongoOrphanJournalRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(
    tmpdir(),
    `orch-g0-mongo-journal-${JOURNAL_DIRECTORY_VERSION}-${uid}`,
  );
}

export function failedMongoOrphanReclaimReport(): MongoOrphanReclaimReport {
  const now = new Date().toISOString();
  return mongoOrphanReclaimReportSchema.parse({
    schemaVersion: MONGO_ORPHAN_RECLAIM_VERSION,
    status: 'FAILED',
    startedAt: now,
    finishedAt: now,
    deadlineMs: DEFAULT_RECLAIM_DEADLINE_MS,
    timedOut: false,
    topologyVerified: false,
    journalRootVerified: false,
    scanComplete: false,
    scannedEntries: 0,
    activeCount: 0,
    otherTopologyCount: 0,
    claimedByLiveReclaimerCount: 0,
    reclaimedCount: 0,
    alreadyAbsentCount: 0,
    unsafeCount: 0,
    failedCount: 0,
    reclaimVerified: false,
    effects: [],
  });
}

export async function openMongoOrphanJournalClient(
  uri: string,
): Promise<{ client: MongoClient; hello: unknown }> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: MAX_COMMAND_TIMEOUT_MS,
    connectTimeoutMS: MAX_COMMAND_TIMEOUT_MS,
    socketTimeoutMS: MAX_COMMAND_TIMEOUT_MS,
    timeoutMS: MAX_COMMAND_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const hello = await client.db('admin').command(
      { hello: 1 },
      { timeoutMS: MAX_COMMAND_TIMEOUT_MS },
    );
    mongoTopologyFingerprintFromHello(hello);
    return { client, hello };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
