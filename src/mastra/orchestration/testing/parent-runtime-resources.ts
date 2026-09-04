/**
 * Parent-only ownership for the strict G0 test runtime.
 *
 * Public declarations contain hashes and ports only. Raw process tokens,
 * listener capabilities and the workspace path remain captured by this
 * closure and are never accepted back from child evidence as authority.
 */
import type { ChildProcess } from 'node:child_process';
import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
  type BigIntStats,
} from 'node:fs';
import {
  createServer,
  type AddressInfo,
  type Server,
} from 'node:net';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PROCESS_EXECUTION_ID_ENV,
  PROCESS_RUNTIME_RUN_ID_ENV,
  inspectOwnedProcessTree,
  readLinuxProcessIdentity,
  readLocalProcessHostIdentity,
  signalOwnedProcessGroup,
  waitForOwnedProcessTreeEmpty,
  type LinuxProcessIdentity,
  type LocalLinuxProcessIdentity,
  type SignalOwnedProcessGroupResult,
  type WaitForOwnedProcessTreeEmptyResult,
} from '../execution/linux-process-tree.js';
import type { AttemptProcessOwnerDoc } from '../store/collections.js';
import {
  TEST_RUNTIME_ENTRYPOINT_ENV,
  TEST_RUNTIME_PARENT_SOURCE_ENV,
  TEST_RUNTIME_RESOURCE_CONTRACT_ENV,
  TEST_RUNTIME_RESOURCE_CONTRACT_VERSION,
  TEST_RUNTIME_SOURCE_ROOT_ENV,
  TEST_RUNTIME_WORKSPACE_ENV,
  hashRuntimeResourceContract,
  testRuntimeResourceContractSchema,
  type ParentGuardedRuntimeResourceContract,
} from './runtime-resource-contract.js';

export const PARENT_RUNTIME_WORKSPACE_MARKER_VERSION =
  'g0-parent-runtime-workspace-marker/v1' as const;
export const PARENT_RUNTIME_AUDIT_VERSION =
  'g0-runtime-resource-audit/v1' as const;
export const PARENT_RUNTIME_RESOURCE_EVIDENCE_VERSION =
  'g0-parent-runtime-resource-evidence/v1' as const;
export const PARENT_RUNTIME_WORKSPACE_CLEANUP_VERSION =
  'g0-parent-runtime-workspace-cleanup/v1' as const;
export const PARENT_RUNTIME_RESOURCE_CONTRACT_HASH_ENV =
  'ORCHESTRATION_G0_RUNTIME_RESOURCE_POLICY_HASH' as const;
export const PARENT_RUNTIME_PARENT_CHALLENGE_ENV =
  'ORCHESTRATION_G0_PARENT_CHALLENGE' as const;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const CHALLENGE_RE = /^[a-f0-9]{64}$/;
const SAFE_ROLE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const SAFE_AUDIT_OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/;
const WORKSPACE_MARKER_NAME = '.g0-parent-runtime-owner.json';

export const PARENT_RUNTIME_AUDIT_MAX_EVENTS = 4_096;
export const PARENT_RUNTIME_AUDIT_MAX_EVENT_BYTES = 16 * 1024;
export const PARENT_RUNTIME_AUDIT_MAX_BYTES = 512 * 1024;

export interface ParentWorkspaceLimits {
  maxEntries: number;
  maxDepth: number;
  maxTotalFileBytes: number;
}

export const DEFAULT_PARENT_WORKSPACE_LIMITS: Readonly<ParentWorkspaceLimits> =
  Object.freeze({
    maxEntries: 4_096,
    maxDepth: 32,
    maxTotalFileBytes: 128 * 1024 * 1024,
  });

export type RuntimeResourceAuditEventType =
  | 'BOOTSTRAP'
  | 'POLICY_ACTIVE'
  | 'ACCESS_ALLOWED'
  | 'ACCESS_DENIED'
  | 'PORT_LEASE_RECEIVED'
  | 'PORT_LEASE_ADOPTED'
  | 'PORT_LEASE_RELEASED'
  | 'FINAL';

export interface RuntimeResourceAuditEvent {
  schemaVersion: typeof PARENT_RUNTIME_AUDIT_VERSION;
  sequence: number;
  eventType: RuntimeResourceAuditEventType;
  decision: 'ALLOW' | 'DENY';
  operation: string;
  policyHash: `sha256:${string}`;
  challengeHash: `sha256:${string}`;
  details: CanonicalJson;
}

export interface ParentRetainedRuntimeAudit {
  mediaType: 'application/x-ndjson';
  byteSize: number;
  eventCount: number;
  contentHash: `sha256:${string}`;
  contentBase64: string;
  contiguous: boolean;
  bytes: Uint8Array;
}

export interface ParentRuntimeSpawnContext {
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface ParentRuntimeNodePermissionOptions {
  readOnlyPaths: readonly string[];
  allowWorker?: true;
}

export interface ParentProcessClaimOptions {
  workerInstanceId?: string;
  ownerGeneration?: number;
  attemptFence?: number;
  timeoutMs?: number;
  pollMs?: number;
  startedAt?: Date;
}

export interface ParentRuntimeResourceLimits {
  workspace?: Partial<ParentWorkspaceLimits>;
  auditMaxEvents?: number;
  auditMaxEventBytes?: number;
  auditMaxBytes?: number;
}

export interface CreateParentRuntimeResourceSessionInput<TSource = unknown> {
  parentDirectory: string;
  parentChallenge: string;
  entrypoint: string;
  sourceRoot: string;
  /**
   * Root the entrypoint must live inside. Defaults to `sourceRoot`; a parent
   * that compiles suites before spawning passes its own build root here so the
   * executable artifact can sit outside the repository.
   */
  entrypointRoot?: string;
  parentSourceIdentity: TSource;
  readPostRunSourceIdentity: () => TSource | Promise<TSource>;
  sourceIdentityEquals?: (before: TSource, after: TSource) => boolean;
  portRoles?: readonly string[];
  /**
   * Exact pre-existing loopback ports needed by the suite (for example the
   * ephemeral Mongo replica set). Parent-minted lease ports are added here.
   */
  allowedLoopbackPorts: readonly number[];
  limits?: ParentRuntimeResourceLimits;
}

export interface AttemptProcessOwnerAdapterInput {
  processExecutionId: string;
  runtimeRunId: string;
  workerInstanceId: string;
  ownerGeneration: number;
  attemptFence: number;
  localIdentity: LocalLinuxProcessIdentity;
  processIdentity: LinuxProcessIdentity;
  registeredAt: Date;
  startedAt: Date;
}

export type PortLeasePhase =
  | 'BOUND'
  | 'HANDOFF_SENT'
  | 'RECEIVED'
  /** Taken over by the workload. */
  | 'ADOPTED'
  /** Closed after adoption — the only phase that satisfies the lease contract. */
  | 'RELEASED'
  /**
   * Closed without ever being adopted, so the child could exit instead of
   * holding a listening socket until the suite timeout. Deliberately distinct
   * from `RELEASED`: an abandoned lease must never satisfy the contract.
   */
  | 'ABANDONED';

export interface ParentPortLeaseEvidence {
  role: string;
  leaseIdHash: `sha256:${string}`;
  port: number;
  phase: PortLeasePhase;
  parentHandleClosed: boolean;
  exactPortAbsence: 'PASS' | 'FAILED' | 'NOT_RUN';
}

export interface ParentWorkspaceCleanupEvidence {
  schemaVersion: typeof PARENT_RUNTIME_WORKSPACE_CLEANUP_VERSION;
  status:
    | 'PASS'
    | 'FAILED'
    | 'REFUSED_PROCESS_TREE_NOT_EMPTY'
    | 'NOT_RUN';
  verifiedAbsent: boolean;
  entryCount: number;
  totalFileBytes: number;
  maxObservedDepth: number;
  reason?: string;
}

export interface ParentRuntimeResourceEvidence {
  schemaVersion: typeof PARENT_RUNTIME_RESOURCE_EVIDENCE_VERSION;
  contractHash: `sha256:${string}`;
  challengeHash: `sha256:${string}`;
  workspaceRootHash: `sha256:${string}`;
  workspaceRootIdentityHash: `sha256:${string}`;
  workspaceMarkerHash: `sha256:${string}`;
  processExecutionIdHash: `sha256:${string}`;
  runtimeRunIdHash: `sha256:${string}`;
  processOwnershipMode: 'LINUX_PROCESS_GROUP_TRUSTED_V1';
  processClaimStatus: 'PASS' | 'FAILED' | 'NOT_RUN';
  workloadReleaseStatus: 'PASS' | 'FAILED' | 'NOT_RUN';
  processTreeEmptyStatus: 'PASS' | 'FAILED' | 'NOT_RUN';
  sourceEqualityStatus: 'PASS' | 'FAILED' | 'NOT_RUN';
  nodeEgressGuardStatus: 'PASS' | 'FAILED' | 'INCOMPLETE';
  osDefaultDenyProven: false;
  externalRequestAbsenceProven: false;
  resourceValidationStatus: 'PASS' | 'FAILED';
  portLeases: ParentPortLeaseEvidence[];
  audit: Omit<ParentRetainedRuntimeAudit, 'bytes'>;
  sideEffectLedger: RuntimeSideEffectLedger;
  cleanup: ParentWorkspaceCleanupEvidence;
  issues: string[];
}

export interface FinalizeParentRuntimeResourceOptions {
  processTreeTimeoutMs?: number;
  processTreePollMs?: number;
  portProbeTimeoutMs?: number;
}

export interface ParentRuntimeResourceSession<TSource = unknown> {
  readonly contract: ParentGuardedRuntimeResourceContract;
  readonly contractJson: string;
  readonly policyHash: `sha256:${string}`;
  readonly challengeHash: `sha256:${string}`;
  readonly entrypointHash: `sha256:${string}`;
  readonly spawnContext: ParentRuntimeSpawnContext;
  nodePermissionArgs(
    options: ParentRuntimeNodePermissionOptions,
  ): readonly string[];
  ingestIpcMessage(message: unknown): ParentIpcIngestionResult;
  claimSpawn(
    child: ChildProcess,
    options?: ParentProcessClaimOptions,
  ): Promise<AttemptProcessOwnerDoc>;
  waitForPolicyActive(timeoutMs?: number): Promise<void>;
  waitForBootstrapReady(timeoutMs?: number): Promise<void>;
  handoffPortLease(child: ChildProcess, role: string): Promise<void>;
  handoffAllPortLeases(child: ChildProcess): Promise<void>;
  waitForPortLeasesReceived(timeoutMs?: number): Promise<void>;
  releaseWorkload(child: ChildProcess): Promise<void>;
  waitForWorkloadReleased(timeoutMs?: number): Promise<void>;
  signalOwned(
    signal: 'SIGTERM' | 'SIGKILL',
  ): Promise<SignalOwnedProcessGroupResult>;
  waitForProcessTreeEmpty(
    timeoutMs?: number,
    pollMs?: number,
  ): Promise<WaitForOwnedProcessTreeEmptyResult>;
  retainAuditEvidence(): ParentRetainedRuntimeAudit;
  finalize(
    options?: FinalizeParentRuntimeResourceOptions,
  ): Promise<ParentRuntimeResourceEvidence>;
}

export type ParentIpcIngestionResult =
  | { handled: false }
  | { handled: true; accepted: true; kind: string }
  | { handled: true; accepted: false; kind: string; reason: string };

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

interface WorkspaceIdentity {
  root: string;
  rootStat: BigIntStats;
  rootIdentityHash: `sha256:${string}`;
  markerPath: string;
  markerStat: BigIntStats;
  markerBytes: Buffer;
  markerHash: `sha256:${string}`;
  fixedDirectories: Map<string, BigIntStats>;
  limits: ParentWorkspaceLimits;
}

interface PortLeaseState {
  role: string;
  leaseId: string;
  leaseIdHash: `sha256:${string}`;
  port: number;
  server: Server;
  phase: PortLeasePhase;
  handoffSent: boolean;
  parentHandleClosed: boolean;
  parentClosePromise: Promise<void> | null;
  unexpectedConnections: number;
  exactPortAbsence: ParentPortLeaseEvidence['exactPortAbsence'];
}

interface AuditState {
  lines: Buffer[];
  events: RuntimeResourceAuditEvent[];
  failed: boolean;
  finalSeen: boolean;
  policyActive: boolean;
  deniedCount: number;
  issues: string[];
}

interface WorkspaceInventoryNode {
  path: string;
  relativePath: string;
  depth: number;
  type: 'directory' | 'file' | 'symlink';
  stat: BigIntStats;
}

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return candidate;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (
      pathFromRoot !== '..'
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    );
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.get
      || descriptor.set
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) return null;
  }
  return value as Record<string, unknown>;
}

function canonicalize(
  value: unknown,
  state = { nodes: 0 },
  depth = 0,
  seen = new Set<object>(),
): CanonicalJson {
  if (depth > 16) throw new TypeError('canonical JSON exceeds its depth limit');
  state.nodes += 1;
  if (state.nodes > 2_048) throw new TypeError('canonical JSON exceeds its node limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 8 * 1024) {
      throw new TypeError('canonical JSON string exceeds its byte limit');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError('canonical JSON rejects cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 256) throw new TypeError('canonical JSON array is too large');
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('canonical JSON rejects sparse arrays');
        }
      }
      return value.map((item) => canonicalize(item, state, depth + 1, seen));
    }
    const record = asPlainRecord(value);
    if (!record) throw new TypeError('canonical JSON accepts plain objects only');
    const keys = Object.keys(record).sort();
    if (keys.length > 64) throw new TypeError('canonical JSON object is too large');
    const output = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of keys) {
      if (
        key === '__proto__'
        || key === 'constructor'
        || key === 'prototype'
      ) throw new TypeError('canonical JSON rejects prototype-sensitive keys');
      output[key] = canonicalize(record[key], state, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function statsIdentity(stat: BigIntStats): Record<string, string | number> {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: Number(stat.mode & 0o7777n),
    uid: stat.uid.toString(),
  };
}

function sameIdentity(
  left: BigIntStats,
  right: BigIntStats,
  includeMode = true,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && (!includeMode || (left.mode & 0o7777n) === (right.mode & 0o7777n));
}

function assertPrivateDirectory(stat: BigIntStats, label: string): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077n) !== 0n
  ) throw new Error(`${label} is not a private directory`);
}

function createPrivateDirectory(path: string): BigIntStats {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  const stat = lstatSync(path, { bigint: true });
  assertPrivateDirectory(stat, 'workspace subdirectory');
  return stat;
}

function writePrivateMarker(path: string, bytes: Buffer): BigIntStats {
  const fd = openSync(
    path,
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
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1n
      || (stat.mode & 0o077n) !== 0n
      || stat.size !== BigInt(bytes.byteLength)
    ) throw new Error('workspace owner marker is not a private regular file');
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return lstatSync(path, { bigint: true });
}

function removeSetupWorkspace(
  root: string,
  rootStat: BigIntStats,
  created: readonly { path: string; stat: BigIntStats }[],
  marker?: { path: string; stat: BigIntStats },
): void {
  const currentRoot = lstatSync(root, { bigint: true });
  if (!sameIdentity(currentRoot, rootStat) || !currentRoot.isDirectory()) return;
  if (marker && existsSync(marker.path)) {
    const current = lstatSync(marker.path, { bigint: true });
    if (sameIdentity(current, marker.stat) && current.isFile()) unlinkSync(marker.path);
  }
  for (const entry of [...created].reverse()) {
    if (!existsSync(entry.path)) continue;
    const current = lstatSync(entry.path, { bigint: true });
    if (sameIdentity(current, entry.stat) && current.isDirectory()) rmdirSync(entry.path);
  }
  if (readdirSync(root).length === 0) rmdirSync(root);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function bindPortLease(role: string): Promise<PortLeaseState> {
  const leaseId = `lease_${randomBytes(32).toString('hex')}`;
  let unexpectedConnections = 0;
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    unexpectedConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
  const address = server.address() as AddressInfo | null;
  if (
    !address
    || address.address !== '127.0.0.1'
    || address.port < 1
    || address.family !== 'IPv4'
  ) {
    await closeServer(server);
    throw new Error(`port lease ${role} did not bind exact IPv4 loopback`);
  }
  const state: PortLeaseState = {
    role,
    leaseId,
    leaseIdHash: sha256(leaseId),
    port: address.port,
    server,
    phase: 'BOUND',
    handoffSent: false,
    parentHandleClosed: false,
    parentClosePromise: null,
    unexpectedConnections,
    exactPortAbsence: 'NOT_RUN',
  };
  Object.defineProperty(state, 'unexpectedConnections', {
    configurable: false,
    enumerable: true,
    get: () => unexpectedConnections,
  });
  return state;
}

function workspaceLimits(
  input: ParentRuntimeResourceLimits | undefined,
): ParentWorkspaceLimits {
  return {
    maxEntries: positiveInteger(
      input?.workspace?.maxEntries,
      DEFAULT_PARENT_WORKSPACE_LIMITS.maxEntries,
      'workspace maxEntries',
    ),
    maxDepth: positiveInteger(
      input?.workspace?.maxDepth,
      DEFAULT_PARENT_WORKSPACE_LIMITS.maxDepth,
      'workspace maxDepth',
    ),
    maxTotalFileBytes: positiveInteger(
      input?.workspace?.maxTotalFileBytes,
      DEFAULT_PARENT_WORKSPACE_LIMITS.maxTotalFileBytes,
      'workspace maxTotalFileBytes',
    ),
  };
}

function validatePort(port: number, field: string): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`${field} must be an exact TCP port`);
  }
  return port;
}

function assertRootIdentity(workspace: WorkspaceIdentity): BigIntStats {
  const current = lstatSync(workspace.root, { bigint: true });
  if (
    !sameIdentity(current, workspace.rootStat)
    || !current.isDirectory()
    || current.isSymbolicLink()
    || (current.mode & 0o777n) !== 0o700n
  ) throw new Error('workspace root identity changed');
  return current;
}

function inventoryWorkspace(workspace: WorkspaceIdentity): {
  nodes: WorkspaceInventoryNode[];
  entryCount: number;
  totalFileBytes: number;
  maxObservedDepth: number;
} {
  assertRootIdentity(workspace);
  const nodes: WorkspaceInventoryNode[] = [];
  let totalFileBytes = 0;
  let maxObservedDepth = 0;

  const visit = (directoryPath: string, relativeDirectory: string, depth: number) => {
    if (depth > workspace.limits.maxDepth) {
      throw new Error('workspace cleanup refused excessive depth');
    }
    maxObservedDepth = Math.max(maxObservedDepth, depth);
    const entries = readdirSync(directoryPath).sort();
    for (const name of entries) {
      if (
        !name
        || name === '.'
        || name === '..'
        || basename(name) !== name
        || name.includes('/')
        || name.includes('\\')
      ) throw new Error('workspace contains an unsafe directory entry');
      const path = join(directoryPath, name);
      const relativePath = relativeDirectory ? join(relativeDirectory, name) : name;
      const stat = lstatSync(path, { bigint: true });
      let type: WorkspaceInventoryNode['type'];
      if (stat.isDirectory() && !stat.isSymbolicLink()) type = 'directory';
      else if (stat.isFile() && !stat.isSymbolicLink()) type = 'file';
      else if (stat.isSymbolicLink()) type = 'symlink';
      else throw new Error('workspace cleanup refused a special filesystem node');
      nodes.push({ path, relativePath, depth: depth + 1, type, stat });
      if (nodes.length > workspace.limits.maxEntries) {
        throw new Error('workspace cleanup refused excessive entry count');
      }
      if (type === 'file' || type === 'symlink') {
        if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('workspace entry size cannot be represented safely');
        }
        totalFileBytes += Number(stat.size);
        if (totalFileBytes > workspace.limits.maxTotalFileBytes) {
          throw new Error('workspace cleanup refused excessive file bytes');
        }
      }
      if (type === 'directory') visit(path, relativePath, depth + 1);
    }
  };
  visit(workspace.root, '', 0);

  const marker = nodes.find((node) => node.relativePath === WORKSPACE_MARKER_NAME);
  if (
    !marker
    || marker.type !== 'file'
    || !sameIdentity(marker.stat, workspace.markerStat)
    || marker.stat.nlink !== 1n
    || (marker.stat.mode & 0o077n) !== 0n
  ) throw new Error('workspace owner marker identity changed');
  const markerFd = openSync(
    workspace.markerPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let markerBytes: Buffer;
  let markerOpenStat: BigIntStats;
  try {
    markerOpenStat = fstatSync(markerFd, { bigint: true });
    markerBytes = readFileSync(markerFd);
  } finally {
    closeSync(markerFd);
  }
  if (
    !sameIdentity(markerOpenStat, workspace.markerStat)
    || sha256(markerBytes) !== workspace.markerHash
  ) throw new Error('workspace owner marker content changed');

  for (const [relativePath, expected] of workspace.fixedDirectories) {
    const node = nodes.find((candidate) => candidate.relativePath === relativePath);
    if (
      !node
      || node.type !== 'directory'
      || !sameIdentity(node.stat, expected)
      || (node.stat.mode & 0o777n) !== 0o700n
    ) throw new Error(`workspace fixed directory ${relativePath} changed`);
  }

  return {
    nodes,
    entryCount: nodes.length,
    totalFileBytes,
    maxObservedDepth,
  };
}

function cleanupWorkspace(workspace: WorkspaceIdentity): ParentWorkspaceCleanupEvidence {
  let inventory: ReturnType<typeof inventoryWorkspace> | undefined;
  try {
    inventory = inventoryWorkspace(workspace);
    const deepestFirst = [...inventory.nodes].sort((left, right) =>
      right.depth - left.depth
      || right.relativePath.localeCompare(left.relativePath));
    for (const node of deepestFirst) {
      assertRootIdentity(workspace);
      const current = lstatSync(node.path, { bigint: true });
      if (
        !sameIdentity(current, node.stat)
        || (
          node.type === 'directory'
            ? !current.isDirectory() || current.isSymbolicLink()
            : node.type === 'file'
              ? !current.isFile() || current.isSymbolicLink()
              : !current.isSymbolicLink()
        )
      ) throw new Error('workspace entry changed during cleanup');
      if (node.type === 'directory') {
        if (readdirSync(node.path).length !== 0) {
          throw new Error('workspace directory changed during cleanup');
        }
        rmdirSync(node.path);
      } else {
        unlinkSync(node.path);
      }
    }
    assertRootIdentity(workspace);
    if (readdirSync(workspace.root).length !== 0) {
      throw new Error('workspace root changed during cleanup');
    }
    rmdirSync(workspace.root);
    if (existsSync(workspace.root)) {
      throw new Error('workspace cleanup absence was not verified');
    }
    return {
      schemaVersion: PARENT_RUNTIME_WORKSPACE_CLEANUP_VERSION,
      status: 'PASS',
      verifiedAbsent: true,
      entryCount: inventory.entryCount,
      totalFileBytes: inventory.totalFileBytes,
      maxObservedDepth: inventory.maxObservedDepth,
    };
  } catch (error) {
    return {
      schemaVersion: PARENT_RUNTIME_WORKSPACE_CLEANUP_VERSION,
      status: 'FAILED',
      verifiedAbsent: false,
      entryCount: inventory?.entryCount ?? 0,
      totalFileBytes: inventory?.totalFileBytes ?? 0,
      maxObservedDepth: inventory?.maxObservedDepth ?? 0,
      reason: error instanceof Error ? error.message : 'unknown workspace cleanup failure',
    };
  }
}

/**
 * Convert a verified Linux session-leader identity into the store-compatible
 * owner tuple used by the exact process-tree signal helpers.
 */
export function attemptProcessOwnerDocFromLinuxClaim(
  input: AttemptProcessOwnerAdapterInput,
): AttemptProcessOwnerDoc {
  const identity = input.processIdentity;
  if (
    identity.pid < 2
    || identity.pid !== identity.pgid
    || identity.pid !== identity.sid
    || identity.pidNamespaceId !== input.localIdentity.pidNamespaceId
  ) throw new Error('claimed process is not an isolated PID/PGID/SID leader');
  if (
    !input.processExecutionId
    || !input.runtimeRunId
    || !SAFE_WORKER_ID_RE.test(input.workerInstanceId)
  ) throw new TypeError('process owner tokens are invalid');
  for (const [field, value] of [
    ['ownerGeneration', input.ownerGeneration],
    ['attemptFence', input.attemptFence],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${field} must be a positive safe integer`);
    }
  }
  return {
    processExecutionId: input.processExecutionId,
    runtimeRunId: input.runtimeRunId,
    workerInstanceId: input.workerInstanceId,
    ownerGeneration: input.ownerGeneration,
    attemptFence: input.attemptFence,
    mode: 'PROCESS_GROUP',
    hostId: input.localIdentity.hostId,
    hostBootId: input.localIdentity.hostBootId,
    pidNamespaceId: input.localIdentity.pidNamespaceId,
    pid: identity.pid,
    pgid: identity.pgid,
    sid: identity.sid,
    processStartToken: identity.processStartToken,
    registeredAt: new Date(input.registeredAt),
    startedAt: new Date(input.startedAt),
  };
}

export function buildParentRuntimeNodePermissionArgs(input: {
  workspaceRoot: string;
  readOnlyPaths: readonly string[];
  allowWorker?: true;
}): readonly string[] {
  const workspace = realpathSync(resolve(input.workspaceRoot));
  const workspaceStat = lstatSync(workspace, { bigint: true });
  assertPrivateDirectory(workspaceStat, 'permission workspace');
  const reads = new Set<string>([workspace]);
  for (const rawPath of input.readOnlyPaths) {
    if (!rawPath || rawPath.includes('\0')) {
      throw new TypeError('Node permission read path is invalid');
    }
    reads.add(realpathSync(resolve(rawPath)));
  }
  const args = [
    '--permission',
    ...[...reads].sort().map((path) => `--allow-fs-read=${path}`),
    `--allow-fs-write=${workspace}`,
    '--allow-worker',
  ];
  // Deliberately no --allow-child-process: the public contract promises this.
  return Object.freeze(args);
}

function parseAuditEvent(
  candidate: unknown,
  expectedSequence: number,
  challengeHash: `sha256:${string}`,
  policyHash: `sha256:${string}`,
): RuntimeResourceAuditEvent {
  const event = asPlainRecord(candidate);
  if (
    !event
    || !exactKeys(event, [
      'schemaVersion',
      'sequence',
      'eventType',
      'decision',
      'operation',
      'policyHash',
      'challengeHash',
      'details',
    ])
    || event.schemaVersion !== PARENT_RUNTIME_AUDIT_VERSION
    || event.sequence !== expectedSequence
    || ![
      'BOOTSTRAP',
      'POLICY_ACTIVE',
      'ACCESS_ALLOWED',
      'ACCESS_DENIED',
      'PORT_LEASE_RECEIVED',
      'PORT_LEASE_ADOPTED',
      'PORT_LEASE_RELEASED',
      'FINAL',
    ].includes(String(event.eventType))
    || (event.decision !== 'ALLOW' && event.decision !== 'DENY')
    || typeof event.operation !== 'string'
    || !SAFE_AUDIT_OPERATION_RE.test(event.operation)
    || event.policyHash !== policyHash
    || event.challengeHash !== challengeHash
  ) throw new TypeError('runtime resource audit event violates the strict protocol');
  return {
    schemaVersion: PARENT_RUNTIME_AUDIT_VERSION,
    sequence: event.sequence as number,
    eventType: event.eventType as RuntimeResourceAuditEventType,
    decision: event.decision,
    operation: event.operation,
    policyHash,
    challengeHash,
    details: canonicalize(event.details),
  };
}

export const RUNTIME_SIDE_EFFECT_LEDGER_VERSION =
  'g0-runtime-side-effect-ledger/v1' as const;

export type SideEffectCategory =
  | 'NETWORK_CONNECT'
  | 'DNS_LOOKUP'
  | 'DENIED_CAPABILITY'
  | 'PORT_LEASE';

export interface SideEffectLedgerEntry {
  sequence: number;
  category: SideEffectCategory;
  decision: 'ALLOW' | 'DENY';
  operation: string;
  port?: number;
  hostKind?: string;
  reason?: string;
  role?: string;
}

export interface RuntimeSideEffectLedger {
  schemaVersion: typeof RUNTIME_SIDE_EFFECT_LEDGER_VERSION;
  /** Anchors the ledger to the exact retained audit bytes it is derived from. */
  sourceAuditHash: `sha256:${string}`;
  entries: SideEffectLedgerEntry[];
  summary: {
    networkAllowedLoopback: number;
    networkDenied: number;
    dnsLookups: number;
    deniedCapabilities: number;
    portLeaseOps: number;
    /** ALLOWED effects that are not provably contained to loopback authority. */
    externalEffectCount: number;
  };
  containmentStatus: 'CONTAINED' | 'ESCAPED';
}

const SAFE_LEDGER_LABEL_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function safeLedgerLabel(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_LEDGER_LABEL_RE.test(value)
    ? value
    : undefined;
}

/**
 * Derive the §19.4 side-effect ledger from the already-authenticated guard
 * audit. This is an independent parent-side containment cross-check, not a
 * restatement of the guard's own PASS: every ALLOWED effect must be provably
 * loopback-to-an-allowlisted-port, so a guard bug that admitted an external
 * effect (or a malformed allow) is classified `ESCAPED` even when the guard
 * reported zero denials. Node-level only — OS-level egress stays unproven.
 */
export function deriveSideEffectLedger(
  events: readonly RuntimeResourceAuditEvent[],
  allowedLoopbackPorts: readonly number[],
  sourceAuditHash: `sha256:${string}`,
): RuntimeSideEffectLedger {
  const allowed = new Set(allowedLoopbackPorts);
  const entries: SideEffectLedgerEntry[] = [];
  const summary = {
    networkAllowedLoopback: 0,
    networkDenied: 0,
    dnsLookups: 0,
    deniedCapabilities: 0,
    portLeaseOps: 0,
    externalEffectCount: 0,
  };
  for (const event of events) {
    if (
      event.eventType !== 'ACCESS_ALLOWED'
      && event.eventType !== 'ACCESS_DENIED'
      && !event.eventType.startsWith('PORT_LEASE_')
    ) continue;
    const details = asPlainRecord(event.details) ?? {};
    const port = typeof details.port === 'number'
      && Number.isInteger(details.port)
      && details.port >= 1
      && details.port <= 65_535
      ? details.port
      : undefined;
    const hostKind = safeLedgerLabel(details.hostKind);
    const reason = safeLedgerLabel(details.reason);
    const role = typeof details.role === 'string' && SAFE_ROLE_RE.test(details.role)
      ? details.role
      : undefined;
    // The label is informational; containment is decided by the guard's own
    // criterion, not the operation name (net.connect, fetch, http.request and
    // dns.lookup all funnel through the same loopback+allowlist check).
    const category: SideEffectCategory = event.eventType.startsWith('PORT_LEASE_')
      ? 'PORT_LEASE'
      : event.operation.startsWith('dns.')
        ? 'DNS_LOOKUP'
        : (event.operation.startsWith('net.')
          || event.operation === 'fetch'
          || event.operation.startsWith('http')
          || port !== undefined)
          ? 'NETWORK_CONNECT'
          : 'DENIED_CAPABILITY';
    if (category === 'PORT_LEASE') {
      summary.portLeaseOps += 1;
    } else if (event.decision === 'DENY') {
      // A denied attempt was blocked, so it is contained regardless of target.
      if (category === 'NETWORK_CONNECT') summary.networkDenied += 1;
      else summary.deniedCapabilities += 1;
    } else {
      // An ALLOWED effect is contained only if the guard proved it loopback and
      // (for a destination with a port) to an allowlisted port. Anything else —
      // a non-loopback host, a non-allowlisted port, or an allowed capability
      // with no loopback proof — is an escape, fail-closed.
      const contained = hostKind === 'LOOPBACK'
        && (port === undefined || allowed.has(port));
      if (!contained) summary.externalEffectCount += 1;
      else if (category === 'DNS_LOOKUP') summary.dnsLookups += 1;
      else summary.networkAllowedLoopback += 1;
    }
    entries.push({
      sequence: event.sequence,
      category,
      decision: event.decision,
      operation: event.operation,
      ...(port === undefined ? {} : { port }),
      ...(hostKind === undefined ? {} : { hostKind }),
      ...(reason === undefined ? {} : { reason }),
      ...(role === undefined ? {} : { role }),
    });
  }
  return {
    schemaVersion: RUNTIME_SIDE_EFFECT_LEDGER_VERSION,
    sourceAuditHash,
    entries,
    summary,
    containmentStatus: summary.externalEffectCount === 0 ? 'CONTAINED' : 'ESCAPED',
  };
}

function auditPortDetails(
  event: RuntimeResourceAuditEvent,
): { role: string; leaseIdHash: string; port: number; claimed?: boolean } {
  const details = asPlainRecord(event.details);
  if (
    !details
    || typeof details.role !== 'string'
    || !SAFE_ROLE_RE.test(details.role)
    || typeof details.leaseIdHash !== 'string'
    || !SHA256_RE.test(details.leaseIdHash)
    || typeof details.port !== 'number'
    || (details.claimed !== undefined && typeof details.claimed !== 'boolean')
  ) throw new TypeError('port lease audit details are incomplete');
  return {
    role: details.role,
    leaseIdHash: details.leaseIdHash,
    port: validatePort(details.port, 'audit port'),
    ...(details.claimed === undefined ? {} : { claimed: details.claimed }),
  };
}

async function probeExactLoopbackPortAbsent(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const probe = createServer();
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolveProbe, rejectProbe) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        probe.removeAllListeners('error');
        if (error) rejectProbe(error);
        else resolveProbe();
      };
      probe.once('error', finish);
      probe.listen(
        { host: '127.0.0.1', port, exclusive: true },
        () => finish(),
      );
      timer = setTimeout(
        () => finish(new Error('exact-port absence probe timed out')),
        timeoutMs,
      );
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return false;
    throw error;
  } finally {
    await closeServer(probe).catch(() => {});
  }
}

function sendChildMessage(
  child: ChildProcess,
  message: object,
  handle?: Server,
): Promise<void> {
  if (!child.connected || typeof child.send !== 'function') {
    return Promise.reject(new Error('child IPC channel is not connected'));
  }
  return new Promise<void>((resolveSend, rejectSend) => {
    const callback = (error: Error | null) => {
      if (error) rejectSend(error);
      else resolveSend();
    };
    if (handle) {
      child.send(message, handle, { keepOpen: true }, callback);
    } else {
      child.send(message, callback);
    }
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  failure: () => string | null,
  label: string,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(`${label} timeout must be positive`);
  }
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const reason = failure();
    if (reason) throw new Error(reason);
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Create the opaque parent capability. The function is asynchronous because
 * every declared listener is already bound when the public contract is minted.
 */
export async function createParentRuntimeResourceSession<TSource>(
  input: CreateParentRuntimeResourceSessionInput<TSource>,
): Promise<ParentRuntimeResourceSession<TSource>> {
  if (!CHALLENGE_RE.test(input.parentChallenge)) {
    throw new TypeError('parent challenge must be 256-bit lowercase hex');
  }
  if (!isAbsolute(input.entrypoint) || input.entrypoint.includes('\0')) {
    throw new TypeError('suite entrypoint must be an absolute path');
  }
  if (!isAbsolute(input.sourceRoot) || input.sourceRoot.includes('\0')) {
    throw new TypeError('suite source root must be an absolute path');
  }
  const sourceRoot = realpathSync(resolve(input.sourceRoot));
  const sourceRootStat = lstatSync(sourceRoot, { bigint: true });
  if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) {
    throw new Error('suite source root is not a real directory');
  }
  // The executable entrypoint does not have to be the source tree. When the
  // parent compiles suites ahead of the spawn, it owns a separate build root
  // and pins that instead; source identity keeps tracking the real repository.
  if (
    input.entrypointRoot !== undefined
    && (!isAbsolute(input.entrypointRoot) || input.entrypointRoot.includes('\0'))
  ) throw new TypeError('suite entrypoint root must be an absolute path');
  const entrypointRoot = input.entrypointRoot === undefined
    ? sourceRoot
    : realpathSync(resolve(input.entrypointRoot));
  const entrypointRootStat = lstatSync(entrypointRoot, { bigint: true });
  if (!entrypointRootStat.isDirectory() || entrypointRootStat.isSymbolicLink()) {
    throw new Error('suite entrypoint root is not a real directory');
  }
  const entrypoint = realpathSync(resolve(input.entrypoint));
  const entrypointStat = lstatSync(entrypoint, { bigint: true });
  if (
    !entrypointStat.isFile()
    || entrypointStat.isSymbolicLink()
    || !pathIsWithin(entrypointRoot, entrypoint)
  ) throw new Error('suite entrypoint is not a regular file inside its declared root');
  const entrypointHash = sha256(entrypoint);
  const challengeHash = sha256(input.parentChallenge);
  const processExecutionId = `pex_${randomUUID()}`;
  const runtimeRunId = `run_${randomUUID()}`;
  const processExecutionIdHash = sha256(processExecutionId);
  const runtimeRunIdHash = sha256(runtimeRunId);
  const limits = workspaceLimits(input.limits);

  const roles = [...(input.portRoles ?? [])].sort();
  if (
    roles.length > 8
    || roles.some((role) => !SAFE_ROLE_RE.test(role))
    || new Set(roles).size !== roles.length
  ) throw new TypeError('port lease roles must be unique safe identifiers');
  const fixedAllowedPorts = input.allowedLoopbackPorts
    .map((port) => validatePort(port, 'allowed loopback port'));
  if (new Set(fixedAllowedPorts).size !== fixedAllowedPorts.length) {
    throw new TypeError('allowed loopback ports must be unique');
  }

  const parent = realpathSync(resolve(input.parentDirectory));
  const parentStat = lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('workspace parent is not a real directory');
  }
  const root = mkdtempSync(join(parent, 'g0-runtime-'));
  chmodSync(root, 0o700);
  const rootRealpath = realpathSync(root);
  if (dirname(rootRealpath) !== parent) {
    throw new Error('workspace root escaped its supplied parent');
  }
  const rootStat = lstatSync(rootRealpath, { bigint: true });
  assertPrivateDirectory(rootStat, 'workspace root');
  if (
    pathIsWithin(sourceRoot, rootRealpath)
    || pathIsWithin(rootRealpath, sourceRoot)
  ) {
    rmdirSync(rootRealpath);
    throw new Error('workspace and source roots must be disjoint');
  }
  const rootIdentityHash = sha256(canonicalJson(statsIdentity(rootStat)));
  const workspaceRootHash = sha256(rootRealpath);

  const fixedDirectories = new Map<string, BigIntStats>();
  const createdDirectories: Array<{ path: string; stat: BigIntStats }> = [];
  const createFixed = (relativePath: string) => {
    const path = join(rootRealpath, relativePath);
    const stat = createPrivateDirectory(path);
    fixedDirectories.set(relativePath, stat);
    createdDirectories.push({ path, stat });
    return path;
  };
  let marker:
    | { path: string; stat: BigIntStats; bytes: Buffer; hash: `sha256:${string}` }
    | undefined;
  const leases: PortLeaseState[] = [];

  try {
    const home = createFixed('home');
    const tmp = createFixed('tmp');
    const xdgRoot = createFixed('xdg');
    const xdgCache = createFixed(join('xdg', 'cache'));
    const xdgConfig = createFixed(join('xdg', 'config'));
    const xdgData = createFixed(join('xdg', 'data'));
    const xdgState = createFixed(join('xdg', 'state'));

    for (const role of roles) leases.push(await bindPortLease(role));
    const allAllowedPorts = [
      ...new Set([
        ...fixedAllowedPorts,
        ...leases.map((lease) => lease.port),
      ]),
    ].sort((left, right) => left - right);
    if (allAllowedPorts.length < 1 || allAllowedPorts.length > 16) {
      throw new TypeError('exact outbound allowlist must contain 1..16 ports');
    }

    const contract = testRuntimeResourceContractSchema.parse({
      schemaVersion: TEST_RUNTIME_RESOURCE_CONTRACT_VERSION,
      mode: 'PARENT_GUARDED_V1',
      workspaceOwnershipMode: 'PARENT_PRIVATE_DIRECTORY_V1',
      portOwnershipMode: 'PARENT_BOUND_IPC_HANDOFF_V1',
      processOwnershipMode: 'LINUX_PROCESS_GROUP_TRUSTED_V1',
      nodePermissionMode: 'NODE_PERMISSION_NO_CHILD_PROCESS_V1',
      workspaceRootHash,
      processExecutionIdHash,
      runtimeRunIdHash,
      portLeases: leases.map((lease) => ({
        role: lease.role,
        leaseIdHash: lease.leaseIdHash,
        port: lease.port,
      })),
      outbound: {
        mode: 'NODE_EGRESS_GUARD_V1',
        allowedLoopbackPorts: allAllowedPorts,
        osDefaultDenyProven: false,
        externalRequestAbsenceProven: false,
      },
    }) as ParentGuardedRuntimeResourceContract;
    const contractJson = JSON.stringify(contract);
    const policyHash = hashRuntimeResourceContract(contract);

    const markerPath = join(rootRealpath, WORKSPACE_MARKER_NAME);
    const markerBytes = Buffer.from(`${canonicalJson({
      schemaVersion: PARENT_RUNTIME_WORKSPACE_MARKER_VERSION,
      workspaceRootHash,
      workspaceRootIdentityHash: rootIdentityHash,
      processExecutionIdHash,
      runtimeRunIdHash,
      challengeHash,
      policyHash,
    })}\n`, 'utf8');
    const markerStat = writePrivateMarker(markerPath, markerBytes);
    marker = {
      path: markerPath,
      stat: markerStat,
      bytes: markerBytes,
      hash: sha256(markerBytes),
    };
    const workspace: WorkspaceIdentity = {
      root: rootRealpath,
      rootStat,
      rootIdentityHash,
      markerPath,
      markerStat,
      markerBytes,
      markerHash: marker.hash,
      fixedDirectories,
      limits,
    };

    const sourceJson = canonicalJson(input.parentSourceIdentity);
    const spawnEnv: Record<string, string> = {
      [PROCESS_EXECUTION_ID_ENV]: processExecutionId,
      [PROCESS_RUNTIME_RUN_ID_ENV]: runtimeRunId,
      [PARENT_RUNTIME_PARENT_CHALLENGE_ENV]: input.parentChallenge,
      [PARENT_RUNTIME_RESOURCE_CONTRACT_HASH_ENV]: policyHash,
      [TEST_RUNTIME_RESOURCE_CONTRACT_ENV]: contractJson,
      [TEST_RUNTIME_PARENT_SOURCE_ENV]: sourceJson,
      [TEST_RUNTIME_ENTRYPOINT_ENV]: entrypoint,
      [TEST_RUNTIME_SOURCE_ROOT_ENV]: sourceRoot,
      [TEST_RUNTIME_WORKSPACE_ENV]: rootRealpath,
      PWD: rootRealpath,
      HOME: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    };

    const auditLimits = {
      maxEvents: positiveInteger(
        input.limits?.auditMaxEvents,
        PARENT_RUNTIME_AUDIT_MAX_EVENTS,
        'audit maxEvents',
      ),
      maxEventBytes: positiveInteger(
        input.limits?.auditMaxEventBytes,
        PARENT_RUNTIME_AUDIT_MAX_EVENT_BYTES,
        'audit maxEventBytes',
      ),
      maxBytes: positiveInteger(
        input.limits?.auditMaxBytes,
        PARENT_RUNTIME_AUDIT_MAX_BYTES,
        'audit maxBytes',
      ),
    };
    if (auditLimits.maxEventBytes > auditLimits.maxBytes) {
      throw new TypeError('audit event limit cannot exceed aggregate limit');
    }
    const audit: AuditState = {
      lines: [],
      events: [],
      failed: false,
      finalSeen: false,
      policyActive: false,
      deniedCount: 0,
      issues: [],
    };
    const lifecycleIssues: string[] = [];
    let registeredChild: ChildProcess | null = null;
    let childClosed = false;
    let childCloseDescription: string | null = null;
    let processOwner: AttemptProcessOwnerDoc | null = null;
    let claimFailed = false;
    let bootstrapReady = false;
    let workloadReleaseSent = false;
    let workloadReleased = false;
    let processTreeResult: WaitForOwnedProcessTreeEmptyResult | null = null;
    let finalizedEvidence: ParentRuntimeResourceEvidence | null = null;
    let cleanupEvidence: ParentWorkspaceCleanupEvidence = {
      schemaVersion: PARENT_RUNTIME_WORKSPACE_CLEANUP_VERSION,
      status: 'NOT_RUN',
      verifiedAbsent: false,
      entryCount: 0,
      totalFileBytes: 0,
      maxObservedDepth: 0,
    };

    const secretCanaries = [
      rootRealpath,
      processExecutionId,
      runtimeRunId,
      input.parentChallenge,
      ...leases.map((lease) => lease.leaseId),
    ].map((value) => Buffer.from(value, 'utf8'));

    const recordIssue = (message: string) => {
      if (!lifecycleIssues.includes(message)) lifecycleIssues.push(message);
    };

    const closeParentLeaseHandle = (lease: PortLeaseState): Promise<void> => {
      if (lease.parentHandleClosed) return Promise.resolve();
      if (lease.parentClosePromise) return lease.parentClosePromise;
      lease.parentClosePromise = closeServer(lease.server)
        .then(() => {
          lease.parentHandleClosed = true;
        })
        .catch((error) => {
          recordIssue(
            `parent listener close failed for ${lease.role}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
          throw error;
        });
      return lease.parentClosePromise;
    };

    const rejectIpc = (kind: string, reason: string): ParentIpcIngestionResult => {
      audit.failed = true;
      if (!audit.issues.includes(reason)) audit.issues.push(reason);
      return { handled: true, accepted: false, kind, reason };
    };

    const ingestIpcMessage = (message: unknown): ParentIpcIngestionResult => {
      const outer = asPlainRecord(message);
      if (!outer || typeof outer.type !== 'string') return { handled: false };

      if (outer.type === 'G0_BOOTSTRAP_READY') {
        if (
          !exactKeys(outer, [
            'type',
            'challengeHash',
            'entrypointHash',
            'pid',
          ])
          || outer.challengeHash !== challengeHash
          || outer.entrypointHash !== entrypointHash
          || typeof outer.pid !== 'number'
          || !Number.isSafeInteger(outer.pid)
          || outer.pid !== registeredChild?.pid
          || bootstrapReady
        ) return rejectIpc('G0_BOOTSTRAP_READY', 'invalid or duplicate bootstrap READY');
        bootstrapReady = true;
        return { handled: true, accepted: true, kind: outer.type };
      }

      if (outer.type === 'G0_WORKLOAD_RELEASED') {
        if (
          !exactKeys(outer, ['type', 'challengeHash', 'entrypointHash'])
          || outer.challengeHash !== challengeHash
          || outer.entrypointHash !== entrypointHash
          || !workloadReleaseSent
          || workloadReleased
        ) return rejectIpc('G0_WORKLOAD_RELEASED', 'invalid or premature workload release ACK');
        workloadReleased = true;
        return { handled: true, accepted: true, kind: outer.type };
      }

      if (outer.type === 'G0_WORKLOAD_IMPORT_FAILED') {
        if (
          !exactKeys(outer, ['type', 'challengeHash', 'errorClass'])
          || outer.challengeHash !== challengeHash
          || typeof outer.errorClass !== 'string'
        ) return rejectIpc('G0_WORKLOAD_IMPORT_FAILED', 'invalid workload import failure message');
        recordIssue(`workload import failed: ${outer.errorClass}`);
        return { handled: true, accepted: true, kind: outer.type };
      }

      if (outer.type !== 'G0_RUNTIME_RESOURCE_AUDIT') return { handled: false };
      if (!exactKeys(outer, ['type', 'event'])) {
        return rejectIpc(outer.type, 'runtime resource audit envelope is not strict');
      }
      if (audit.finalSeen) {
        return rejectIpc(outer.type, 'runtime resource audit continued after FINAL');
      }
      let event: RuntimeResourceAuditEvent;
      try {
        event = parseAuditEvent(
          outer.event,
          audit.events.length + 1,
          challengeHash,
          policyHash,
        );
        const line = Buffer.from(`${canonicalJson(event)}\n`, 'utf8');
        if (line.byteLength > auditLimits.maxEventBytes) {
          throw new RangeError('runtime resource audit event exceeds its byte limit');
        }
        if (audit.events.length + 1 > auditLimits.maxEvents) {
          throw new RangeError('runtime resource audit exceeds its event limit');
        }
        const currentBytes = audit.lines.reduce(
          (total, item) => total + item.byteLength,
          0,
        );
        if (currentBytes + line.byteLength > auditLimits.maxBytes) {
          throw new RangeError('runtime resource audit exceeds its aggregate byte limit');
        }
        if (secretCanaries.some((canary) => line.includes(canary))) {
          throw new Error('runtime resource audit contains a parent-only capability');
        }

        if (event.eventType === 'BOOTSTRAP') {
          if (audit.events.length !== 0 || event.decision !== 'ALLOW') {
            throw new Error('audit BOOTSTRAP must be the first successful event');
          }
        } else if (audit.events.length === 0) {
          throw new Error('runtime resource audit is missing BOOTSTRAP');
        }
        if (event.eventType === 'POLICY_ACTIVE') {
          if (audit.policyActive || event.decision !== 'ALLOW') {
            throw new Error('audit policy activation is invalid or duplicate');
          }
          audit.policyActive = true;
        }
        if (
          (
            event.eventType === 'ACCESS_ALLOWED'
            || event.eventType === 'ACCESS_DENIED'
            || event.eventType.startsWith('PORT_LEASE_')
          )
          && !audit.policyActive
        ) throw new Error('audit operation occurred before policy activation');
        if (event.eventType === 'ACCESS_DENIED' || event.decision === 'DENY') {
          audit.deniedCount += 1;
        }
        if (event.eventType.startsWith('PORT_LEASE_')) {
          const details = auditPortDetails(event);
          const lease = leases.find((candidate) => candidate.role === details.role);
          if (
            !lease
            || lease.leaseIdHash !== details.leaseIdHash
            || lease.port !== details.port
          ) throw new Error('port lease audit does not match parent authority');
          if (event.eventType === 'PORT_LEASE_RECEIVED') {
            if (!lease.handoffSent || lease.phase !== 'HANDOFF_SENT') {
              throw new Error('port lease RECEIVED is premature or duplicate');
            }
            lease.phase = 'RECEIVED';
            void closeParentLeaseHandle(lease);
          } else if (event.eventType === 'PORT_LEASE_ADOPTED') {
            if (lease.phase !== 'RECEIVED') {
              throw new Error('port lease ADOPTED is out of order');
            }
            lease.phase = 'ADOPTED';
          } else if (lease.phase === 'ADOPTED') {
            lease.phase = 'RELEASED';
          } else if (lease.phase === 'RECEIVED') {
            // Claimed and closed without adoption is a complete lifecycle: the
            // workload took the lease and gave it back (a suite may claim one
            // purely to prove a listener setup failure). Only a lease the
            // workload never claimed is abandoned, and abandonment must never
            // count as a satisfied lease contract.
            lease.phase = details.claimed === true ? 'RELEASED' : 'ABANDONED';
          } else {
            throw new Error('port lease RELEASED is out of order');
          }
        }
        if (event.eventType === 'FINAL') {
          audit.finalSeen = true;
        }
        audit.lines.push(line);
        audit.events.push(event);
        return { handled: true, accepted: true, kind: event.eventType };
      } catch (error) {
        return rejectIpc(
          outer.type,
          error instanceof Error ? error.message : 'invalid runtime resource audit',
        );
      }
    };

    const attachChild = (child: ChildProcess) => {
      if (registeredChild && registeredChild !== child) {
        throw new Error('runtime resource session already owns another child');
      }
      if (!registeredChild) {
        registeredChild = child;
        child.on('message', ingestIpcMessage);
        child.once('close', (code, signal) => {
          childClosed = true;
          childCloseDescription = `code=${String(code)},signal=${String(signal)}`;
        });
        child.once('error', (error) => {
          recordIssue(`owned child error: ${error.message}`);
        });
      }
    };

    const session: ParentRuntimeResourceSession<TSource> = {
      contract,
      contractJson,
      policyHash,
      challengeHash,
      entrypointHash,
      spawnContext: Object.freeze({
        cwd: rootRealpath,
        env: Object.freeze({ ...spawnEnv }),
      }),

      nodePermissionArgs(options) {
        return buildParentRuntimeNodePermissionArgs({
          workspaceRoot: rootRealpath,
          readOnlyPaths: [sourceRoot, ...options.readOnlyPaths],
          allowWorker: options.allowWorker,
        });
      },

      ingestIpcMessage,

      async claimSpawn(child, options = {}) {
        if (finalizedEvidence) throw new Error('runtime resource session is finalized');
        if (processOwner) throw new Error('owned child is already claimed');
        attachChild(child);
        if (!child.pid || child.pid < 2) {
          claimFailed = true;
          throw new Error('spawned child has no claimable PID');
        }
        const timeoutMs = positiveInteger(
          options.timeoutMs,
          2_000,
          'process claim timeout',
        );
        const pollMs = positiveInteger(options.pollMs, 5, 'process claim poll');
        const deadline = Date.now() + timeoutMs;
        let identity: LinuxProcessIdentity | null = null;
        while (!identity && Date.now() < deadline) {
          identity = await readLinuxProcessIdentity(child.pid);
          if (!identity) await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        }
        try {
          if (!identity) throw new Error('spawned child identity disappeared before claim');
          const local = await readLocalProcessHostIdentity();
          const now = new Date();
          const owner = attemptProcessOwnerDocFromLinuxClaim({
            processExecutionId,
            runtimeRunId,
            workerInstanceId:
              options.workerInstanceId
              ?? `g0-parent:${processExecutionIdHash.slice('sha256:'.length, 22)}`,
            ownerGeneration: options.ownerGeneration ?? 1,
            attemptFence: options.attemptFence ?? 1,
            localIdentity: local,
            processIdentity: identity,
            registeredAt: now,
            startedAt: options.startedAt ?? now,
          });
          const inspection = await inspectOwnedProcessTree(owner);
          if (
            !inspection.verifiable
            || !inspection.signalSafe
            || !inspection.leaderMatches
            || inspection.escapedExecutionPids.length > 0
          ) {
            throw new Error(
              inspection.reason ?? 'spawned child process ownership is not verifiable',
            );
          }
          processOwner = owner;
          return owner;
        } catch (error) {
          claimFailed = true;
          throw error;
        }
      },

      async waitForBootstrapReady(timeoutMs = 5_000) {
        await waitUntil(
          () => bootstrapReady,
          timeoutMs,
          () => childClosed
            ? `child closed before bootstrap READY (${childCloseDescription})`
            : audit.failed
              ? audit.issues.at(-1) ?? 'IPC validation failed'
              : null,
          'bootstrap READY',
        );
      },

      async waitForPolicyActive(timeoutMs = 5_000) {
        await waitUntil(
          () => audit.policyActive,
          timeoutMs,
          () => childClosed
            ? `child closed before policy activation (${childCloseDescription})`
            : audit.failed
              ? audit.issues.at(-1) ?? 'audit validation failed'
              : null,
          'runtime resource policy activation',
        );
      },

      async handoffPortLease(child, role) {
        if (!processOwner) throw new Error('port handoff requires a verified process claim');
        if (!audit.policyActive) throw new Error('port handoff requires active egress policy');
        if (registeredChild !== child || child.pid !== processOwner.pid) {
          throw new Error('port handoff child does not match the process claim');
        }
        const lease = leases.find((candidate) => candidate.role === role);
        if (!lease) throw new Error(`unknown parent port lease role: ${role}`);
        if (lease.handoffSent || lease.phase !== 'BOUND') {
          throw new Error(`port lease ${role} was already handed off`);
        }
        lease.handoffSent = true;
        lease.phase = 'HANDOFF_SENT';
        try {
          await sendChildMessage(child, {
            type: 'G0_PORT_LEASE',
            role: lease.role,
            leaseId: lease.leaseId,
            port: lease.port,
          }, lease.server);
        } catch (error) {
          lease.handoffSent = false;
          lease.phase = 'BOUND';
          throw error;
        }
      },

      async handoffAllPortLeases(child) {
        for (const lease of leases) {
          await session.handoffPortLease(child, lease.role);
        }
      },

      async waitForPortLeasesReceived(timeoutMs = 5_000) {
        await waitUntil(
          () => leases.every(
            (lease) =>
              ['RECEIVED', 'ADOPTED', 'RELEASED', 'ABANDONED'].includes(lease.phase)
              && lease.parentHandleClosed,
          ),
          timeoutMs,
          () => childClosed
            ? `child closed before port handoff ACK (${childCloseDescription})`
            : audit.failed
              ? audit.issues.at(-1) ?? 'audit validation failed'
              : lifecycleIssues.find((issue) => issue.includes('listener close')) ?? null,
          'port lease receipt',
        );
      },

      async releaseWorkload(child) {
        if (!processOwner) throw new Error('workload release requires a verified process claim');
        if (registeredChild !== child || child.pid !== processOwner.pid) {
          throw new Error('workload release child does not match the process claim');
        }
        if (!bootstrapReady || !audit.policyActive) {
          throw new Error('workload release requires bootstrap and active policy proofs');
        }
        if (
          !leases.every(
            (lease) =>
              ['RECEIVED', 'ADOPTED', 'RELEASED', 'ABANDONED'].includes(lease.phase)
              && lease.parentHandleClosed,
          )
        ) throw new Error('workload release requires every port lease receipt');
        if (workloadReleaseSent) throw new Error('workload release is one-shot');
        await sendChildMessage(child, {
          type: 'G0_RELEASE_WORKLOAD',
          challengeHash,
          entrypointHash,
        });
        workloadReleaseSent = true;
      },

      async waitForWorkloadReleased(timeoutMs = 5_000) {
        await waitUntil(
          () => workloadReleased,
          timeoutMs,
          () => childClosed
            ? `child closed before workload release ACK (${childCloseDescription})`
            : audit.failed
              ? audit.issues.at(-1) ?? 'IPC validation failed'
              : null,
          'workload release ACK',
        );
      },

      async signalOwned(signal) {
        if (!workloadReleased) {
          throw new Error('owned process signals are forbidden before workload release');
        }
        if (!processOwner) throw new Error('owned process has not been claimed');
        return signalOwnedProcessGroup(processOwner, signal);
      },

      async waitForProcessTreeEmpty(timeoutMs = 2_000, pollMs = 20) {
        if (!processOwner) throw new Error('owned process has not been claimed');
        processTreeResult = await waitForOwnedProcessTreeEmpty(processOwner, {
          timeoutMs,
          pollMs,
        });
        return processTreeResult;
      },

      retainAuditEvidence() {
        const bytes = Buffer.concat(audit.lines);
        return {
          mediaType: 'application/x-ndjson',
          byteSize: bytes.byteLength,
          eventCount: audit.events.length,
          contentHash: sha256(bytes),
          contentBase64: bytes.toString('base64'),
          contiguous: !audit.failed
            && audit.events.every((event, index) => event.sequence === index + 1),
          bytes: Buffer.from(bytes),
        };
      },

      async finalize(options = {}) {
        if (finalizedEvidence) return finalizedEvidence;
        for (const lease of leases) {
          if (!lease.parentHandleClosed) {
            await closeParentLeaseHandle(lease).catch(() => {});
          }
        }

        let groupEmpty = registeredChild === null;
        if (processOwner) {
          try {
            processTreeResult = await waitForOwnedProcessTreeEmpty(processOwner, {
              timeoutMs: positiveInteger(
                options.processTreeTimeoutMs,
                2_000,
                'final process-tree timeout',
              ),
              pollMs: positiveInteger(
                options.processTreePollMs,
                20,
                'final process-tree poll',
              ),
            });
            groupEmpty = processTreeResult.empty;
            if (!groupEmpty) {
              recordIssue(
                processTreeResult.inspection.reason
                ?? 'owned process tree is not empty',
              );
            }
          } catch (error) {
            recordIssue(
              `process-tree verification failed: ${
                error instanceof Error ? error.message : 'unknown error'
              }`,
            );
          }
        } else if (registeredChild) {
          recordIssue('spawned child was never bound to a verified process claim');
        }

        if (groupEmpty) {
          const probeTimeoutMs = positiveInteger(
            options.portProbeTimeoutMs,
            1_000,
            'port probe timeout',
          );
          for (const lease of leases) {
            try {
              lease.exactPortAbsence = await probeExactLoopbackPortAbsent(
                lease.port,
                probeTimeoutMs,
              ) ? 'PASS' : 'FAILED';
              if (lease.exactPortAbsence === 'FAILED') {
                recordIssue(`exact port ${lease.port} remains occupied after owned exit`);
              }
            } catch (error) {
              lease.exactPortAbsence = 'FAILED';
              recordIssue(
                `exact port absence probe failed for ${lease.role}: ${
                  error instanceof Error ? error.message : 'unknown error'
                }`,
              );
            }
          }
        }

        let sourceEqualityStatus:
          ParentRuntimeResourceEvidence['sourceEqualityStatus'] = 'NOT_RUN';
        if (groupEmpty) {
          try {
            const after = await input.readPostRunSourceIdentity();
            const equal = input.sourceIdentityEquals
              ? input.sourceIdentityEquals(input.parentSourceIdentity, after)
              : canonicalJson(input.parentSourceIdentity) === canonicalJson(after);
            sourceEqualityStatus = equal ? 'PASS' : 'FAILED';
            if (!equal) recordIssue('post-run source identity changed');
          } catch (error) {
            sourceEqualityStatus = 'FAILED';
            recordIssue(
              `post-run source verification failed: ${
                error instanceof Error ? error.message : 'unknown error'
              }`,
            );
          }
        }

        if (groupEmpty) {
          cleanupEvidence = cleanupWorkspace(workspace);
          if (cleanupEvidence.status !== 'PASS') {
            recordIssue(cleanupEvidence.reason ?? 'workspace cleanup failed');
          }
        } else {
          cleanupEvidence = {
            schemaVersion: PARENT_RUNTIME_WORKSPACE_CLEANUP_VERSION,
            status: 'REFUSED_PROCESS_TREE_NOT_EMPTY',
            verifiedAbsent: false,
            entryCount: 0,
            totalFileBytes: 0,
            maxObservedDepth: 0,
            reason: 'workspace cleanup requires an empty exact process tree',
          };
        }

        const retained = session.retainAuditEvidence();
        const sideEffectLedger = deriveSideEffectLedger(
          audit.events,
          contract.outbound.allowedLoopbackPorts,
          retained.contentHash,
        );
        const finalAudit = audit.events.find((event) => event.eventType === 'FINAL');
        const finalDetails = finalAudit ? asPlainRecord(finalAudit.details) : null;
        const nodeEgressGuardStatus:
          ParentRuntimeResourceEvidence['nodeEgressGuardStatus'] =
          !audit.failed
          && audit.policyActive
          && audit.deniedCount === 0
          && finalAudit?.decision === 'ALLOW'
          && finalDetails?.nodeEgressGuardStatus === 'PASS'
            ? 'PASS'
            : audit.failed
              || audit.deniedCount > 0
              || finalAudit?.decision === 'DENY'
              || finalDetails?.nodeEgressGuardStatus === 'FAILED'
                ? 'FAILED'
                : 'INCOMPLETE';
        const portEvidence: ParentPortLeaseEvidence[] = leases.map((lease) => ({
          role: lease.role,
          leaseIdHash: lease.leaseIdHash,
          port: lease.port,
          phase: lease.phase,
          parentHandleClosed: lease.parentHandleClosed,
          exactPortAbsence: lease.exactPortAbsence,
        }));
        const allResourcesPass = Boolean(
          processOwner
          && !claimFailed
          && workloadReleased
          && groupEmpty
          && sourceEqualityStatus === 'PASS'
          && nodeEgressGuardStatus === 'PASS'
          && sideEffectLedger.containmentStatus === 'CONTAINED'
          && cleanupEvidence.status === 'PASS'
          && portEvidence.every(
            (lease) =>
              lease.phase === 'RELEASED'
              && lease.parentHandleClosed
              && lease.exactPortAbsence === 'PASS',
          )
          && lifecycleIssues.length === 0
          && audit.issues.length === 0,
        );
        const { bytes: _bytes, ...auditDescriptor } = retained;
        finalizedEvidence = Object.freeze({
          schemaVersion: PARENT_RUNTIME_RESOURCE_EVIDENCE_VERSION,
          contractHash: policyHash,
          challengeHash,
          workspaceRootHash,
          workspaceRootIdentityHash: workspace.rootIdentityHash,
          workspaceMarkerHash: workspace.markerHash,
          processExecutionIdHash,
          runtimeRunIdHash,
          processOwnershipMode: 'LINUX_PROCESS_GROUP_TRUSTED_V1',
          processClaimStatus: processOwner && !claimFailed ? 'PASS' : claimFailed ? 'FAILED' : 'NOT_RUN',
          workloadReleaseStatus: workloadReleased
            ? 'PASS'
            : workloadReleaseSent
              ? 'FAILED'
              : 'NOT_RUN',
          processTreeEmptyStatus: processOwner
            ? groupEmpty ? 'PASS' : 'FAILED'
            : 'NOT_RUN',
          sourceEqualityStatus,
          nodeEgressGuardStatus,
          osDefaultDenyProven: false,
          externalRequestAbsenceProven: false,
          resourceValidationStatus: allResourcesPass ? 'PASS' : 'FAILED',
          portLeases: portEvidence,
          audit: auditDescriptor,
          sideEffectLedger,
          cleanup: cleanupEvidence,
          issues: [...new Set([...audit.issues, ...lifecycleIssues])],
        });
        if (registeredChild) registeredChild.off('message', ingestIpcMessage);
        return finalizedEvidence;
      },
    };

    return Object.freeze(session);
  } catch (error) {
    await Promise.allSettled(leases.map((lease) => closeServer(lease.server)));
    removeSetupWorkspace(
      rootRealpath,
      rootStat,
      createdDirectories,
      marker ? { path: marker.path, stat: marker.stat } : undefined,
    );
    throw error;
  }
}
