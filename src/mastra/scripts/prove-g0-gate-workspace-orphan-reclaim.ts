/**
 * Live, destructive proof for the crash-persistent G0 gate-workspace reclaimer.
 *
 * Safety envelope:
 * - Linux only;
 * - all mutable proof state lives below one fresh private tmp directory;
 * - the reclaimer can address only the dedicated private managed root;
 * - foreign canaries are siblings of, never children of, the managed root;
 * - the proof root is removed only after every reclaim and canary assertion has
 *   passed and its exact inode plus fixed child inventory have been rechecked.
 *
 * The proof kills three real processes:
 * 1. the authentic gate parent after it durably binds a detached process group
 *    containing a non-cooperative child and grandchild;
 * 2. reclaimer A after its first planned removal;
 * 3. reclaimer B after journal-entry unlink but before claim release.
 *
 * Reclaimer C must finish the resulting claim-only state as ALREADY_ABSENT.
 */
import assert from 'node:assert/strict';
import {
  fork,
  type ChildProcess,
} from 'node:child_process';
import {
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROCESS_EXECUTION_ID_ENV,
  PROCESS_RUNTIME_RUN_ID_ENV,
  inspectOwnedProcessTree,
  readLinuxProcessIdentity,
  readLocalProcessHostIdentity,
  signalOwnedProcessGroup,
  waitForOwnedProcessTreeEmpty,
} from '../orchestration/execution/linux-process-tree.js';
import {
  attemptProcessOwnerDocFromLinuxClaim,
} from '../orchestration/testing/parent-runtime-resources.js';
import {
  GateWorkspaceOrphanJournalStore,
  gateWorkspaceAllocationSchema,
  gateWorkspaceOrphanReclaimReportSchema,
} from '../orchestration/testing/gate-workspace-orphan-journal.js';
import type {
  GateWorkspaceAllocation,
  GateWorkspaceOrphanReclaimReport,
} from '../orchestration/testing/gate-workspace-orphan-journal.js';
import type { AttemptProcessOwnerDoc } from '../orchestration/store/collections.js';

const PROOF_VERSION = 'g0-gate-workspace-orphan-reclaim-live-proof/v1';
const OWNER_PARENT_MODE = '--owner-parent';
const WORKLOAD_MODE = '--workload';
const GRANDCHILD_MODE = '--grandchild';
const FIRST_RECLAIMER_MODE = '--first-reclaimer';
const TERMINAL_RECLAIMER_MODE = '--terminal-reclaimer';
const SUITE_ID = 'proof:g0-gate-workspace-orphan-reclaim';
const IPC_TIMEOUT_MS = 20_000;
const RECLAIM_DEADLINE_MS = 20_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX_IMPORT = import.meta.resolve('tsx');

const PROOF_ROOT_ENV = 'ORCHESTRATION_G0_WORKSPACE_PROOF_ROOT';
const JOURNAL_ROOT_ENV = 'ORCHESTRATION_G0_WORKSPACE_PROOF_JOURNAL_ROOT';
const MANAGED_ROOT_ENV = 'ORCHESTRATION_G0_WORKSPACE_PROOF_MANAGED_ROOT';

interface SerializedProcessOwner {
  processExecutionId: string;
  runtimeRunId: string;
  workerInstanceId: string;
  ownerGeneration: number;
  attemptFence: number;
  mode: 'PROCESS_GROUP';
  hostId: string;
  hostBootId: string;
  pidNamespaceId: string;
  pid: number;
  pgid: number;
  sid: number;
  processStartToken: string;
  registeredAt: string;
  startedAt: string;
}

interface OwnerReadyMessage {
  type: 'OWNER_READY';
  allocation: GateWorkspaceAllocation;
  root: string;
  processOwner: SerializedProcessOwner;
  childPid: number;
  childProcessStartToken: string;
  grandchildPid: number;
  grandchildProcessStartToken: string;
}

interface GrandchildReadyMessage {
  type: 'GRANDCHILD_READY';
  pid: number;
  processStartToken: string;
  pgid: number;
  sid: number;
}

interface WorkloadReadyMessage {
  type: 'WORKLOAD_READY';
  childPid: number;
  childProcessStartToken: string;
  grandchildPid: number;
  grandchildProcessStartToken: string;
  pgid: number;
  sid: number;
}

interface HookReadyMessage {
  type: 'FIRST_REMOVAL' | 'TERMINAL_WINDOW';
}

interface CanarySnapshot {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  contentHash: string;
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
  type:
    | 'OWNER_FAILED'
    | 'WORKLOAD_FAILED'
    | 'GRANDCHILD_FAILED'
    | 'RECLAIMER_FAILED',
  error: unknown,
): void {
  process.send?.({ type, errorClass: errorClass(error) });
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = candidate.slice(root.length);
  return candidate === root
    || (
      candidate.startsWith(`${root}${sep}`)
      && relative !== ''
    );
}

function assertProofLayout(): {
  proofRoot: string;
  journalRoot: string;
  managedRoot: string;
} {
  const proofRoot = realpathSync(requiredEnv(PROOF_ROOT_ENV));
  const journalRoot = realpathSync(requiredEnv(JOURNAL_ROOT_ENV));
  const managedRoot = realpathSync(requiredEnv(MANAGED_ROOT_ENV));
  assert.match(
    basename(proofRoot),
    /^orch-g0-gate-workspace-reclaim-proof-[A-Za-z0-9_-]{6,}$/,
    'proof root does not have its fixed private family name',
  );
  assert.equal(
    dirname(proofRoot),
    realpathSync(tmpdir()),
    'proof root is outside the exact local tmp directory',
  );
  assert.equal(dirname(journalRoot), proofRoot);
  assert.equal(dirname(managedRoot), proofRoot);
  assert.notEqual(journalRoot, managedRoot);
  for (const [label, path] of [
    ['proof', proofRoot],
    ['journal', journalRoot],
    ['managed', managedRoot],
  ] as const) {
    const stat = lstatSync(path, { bigint: true });
    assert.equal(stat.isDirectory(), true, `${label} root is not a directory`);
    assert.equal(stat.isSymbolicLink(), false, `${label} root is a symlink`);
    assert.equal(Number(stat.mode & 0o777n), 0o700, `${label} root is not private`);
  }
  return { proofRoot, journalRoot, managedRoot };
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

function proofChildEnv(
  layout: { proofRoot: string; journalRoot: string; managedRoot: string },
): NodeJS.ProcessEnv {
  return {
    ...safeBaseEnv(),
    [PROOF_ROOT_ENV]: layout.proofRoot,
    [JOURNAL_ROOT_ENV]: layout.journalRoot,
    [MANAGED_ROOT_ENV]: layout.managedRoot,
  };
}

function forkSelf(
  mode:
    | typeof OWNER_PARENT_MODE
    | typeof WORKLOAD_MODE
    | typeof GRANDCHILD_MODE
    | typeof FIRST_RECLAIMER_MODE
    | typeof TERMINAL_RECLAIMER_MODE,
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
      if (
        isRecord(message)
        && [
          'OWNER_FAILED',
          'WORKLOAD_FAILED',
          'GRANDCHILD_FAILED',
          'RECLAIMER_FAILED',
        ].includes(String(message.type))
      ) {
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
    const timer = setTimeout(() => finish(new Error('proof IPC readiness timed out')), timeoutMs);
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
    const timer = setTimeout(() => finish(new Error('proof child exit timed out')), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function parsePositiveInteger(value: unknown, label: string): number {
  assert.ok(Number.isSafeInteger(value) && Number(value) >= 2, `${label} is invalid`);
  return Number(value);
}

function parseProcessStartToken(value: unknown, label: string): string {
  assert.match(String(value), /^[0-9]+$/, `${label} is invalid`);
  return String(value);
}

function parseSerializedOwner(value: unknown): SerializedProcessOwner {
  assert.ok(isRecord(value), 'process owner is not an object');
  assert.equal(value.mode, 'PROCESS_GROUP');
  const owner: SerializedProcessOwner = {
    processExecutionId: String(value.processExecutionId),
    runtimeRunId: String(value.runtimeRunId),
    workerInstanceId: String(value.workerInstanceId),
    ownerGeneration: Number(value.ownerGeneration),
    attemptFence: Number(value.attemptFence),
    mode: 'PROCESS_GROUP',
    hostId: String(value.hostId),
    hostBootId: String(value.hostBootId),
    pidNamespaceId: String(value.pidNamespaceId),
    pid: parsePositiveInteger(value.pid, 'owner PID'),
    pgid: parsePositiveInteger(value.pgid, 'owner PGID'),
    sid: parsePositiveInteger(value.sid, 'owner SID'),
    processStartToken: parseProcessStartToken(
      value.processStartToken,
      'owner process start token',
    ),
    registeredAt: String(value.registeredAt),
    startedAt: String(value.startedAt),
  };
  assert.ok(Number.isSafeInteger(owner.ownerGeneration) && owner.ownerGeneration >= 0);
  assert.ok(Number.isSafeInteger(owner.attemptFence) && owner.attemptFence >= 0);
  assert.equal(Number.isFinite(new Date(owner.registeredAt).getTime()), true);
  assert.equal(Number.isFinite(new Date(owner.startedAt).getTime()), true);
  return owner;
}

function serializeProcessOwner(owner: AttemptProcessOwnerDoc): SerializedProcessOwner {
  assert.equal(owner.mode, 'PROCESS_GROUP');
  assert.ok(owner.pidNamespaceId);
  assert.ok(owner.sid);
  return {
    processExecutionId: owner.processExecutionId,
    runtimeRunId: owner.runtimeRunId,
    workerInstanceId: owner.workerInstanceId,
    ownerGeneration: owner.ownerGeneration,
    attemptFence: owner.attemptFence,
    mode: 'PROCESS_GROUP',
    hostId: owner.hostId,
    hostBootId: owner.hostBootId,
    pidNamespaceId: owner.pidNamespaceId,
    pid: owner.pid,
    pgid: owner.pgid,
    sid: owner.sid,
    processStartToken: owner.processStartToken,
    registeredAt: owner.registeredAt.toISOString(),
    startedAt: owner.startedAt.toISOString(),
  };
}

function deserializeProcessOwner(owner: SerializedProcessOwner): AttemptProcessOwnerDoc {
  return {
    ...owner,
    registeredAt: new Date(owner.registeredAt),
    startedAt: new Date(owner.startedAt),
  };
}

function parseOwnerReady(message: unknown): OwnerReadyMessage | undefined {
  if (!isRecord(message) || message.type !== 'OWNER_READY') return undefined;
  assert.equal(typeof message.root, 'string');
  return {
    type: 'OWNER_READY',
    allocation: gateWorkspaceAllocationSchema.parse(message.allocation),
    root: String(message.root),
    processOwner: parseSerializedOwner(message.processOwner),
    childPid: parsePositiveInteger(message.childPid, 'child PID'),
    childProcessStartToken: parseProcessStartToken(
      message.childProcessStartToken,
      'child process start token',
    ),
    grandchildPid: parsePositiveInteger(message.grandchildPid, 'grandchild PID'),
    grandchildProcessStartToken: parseProcessStartToken(
      message.grandchildProcessStartToken,
      'grandchild process start token',
    ),
  };
}

function parseGrandchildReady(message: unknown): GrandchildReadyMessage | undefined {
  if (!isRecord(message) || message.type !== 'GRANDCHILD_READY') return undefined;
  return {
    type: 'GRANDCHILD_READY',
    pid: parsePositiveInteger(message.pid, 'grandchild PID'),
    processStartToken: parseProcessStartToken(
      message.processStartToken,
      'grandchild process start token',
    ),
    pgid: parsePositiveInteger(message.pgid, 'grandchild PGID'),
    sid: parsePositiveInteger(message.sid, 'grandchild SID'),
  };
}

function parseWorkloadReady(message: unknown): WorkloadReadyMessage | undefined {
  if (!isRecord(message) || message.type !== 'WORKLOAD_READY') return undefined;
  return {
    type: 'WORKLOAD_READY',
    childPid: parsePositiveInteger(message.childPid, 'child PID'),
    childProcessStartToken: parseProcessStartToken(
      message.childProcessStartToken,
      'child process start token',
    ),
    grandchildPid: parsePositiveInteger(message.grandchildPid, 'grandchild PID'),
    grandchildProcessStartToken: parseProcessStartToken(
      message.grandchildProcessStartToken,
      'grandchild process start token',
    ),
    pgid: parsePositiveInteger(message.pgid, 'workload PGID'),
    sid: parsePositiveInteger(message.sid, 'workload SID'),
  };
}

function parseHookReady(
  expected: HookReadyMessage['type'],
): (message: unknown) => HookReadyMessage | undefined {
  return (message) => {
    if (
      !isRecord(message)
      || message.type !== expected
      || Object.keys(message).join(',') !== 'type'
    ) return undefined;
    return { type: expected };
  };
}

function waitForStart(): Promise<void> {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      if (error) rejectStart(error);
      else resolveStart();
    };
    const onMessage = (message: unknown) => {
      if (
        isRecord(message)
        && message.type === 'START_WORKLOAD'
        && Object.keys(message).join(',') === 'type'
      ) finish();
    };
    const onDisconnect = () => finish(new Error('proof owner disconnected before start'));
    const timer = setTimeout(
      () => finish(new Error('proof workload start timed out')),
      IPC_TIMEOUT_MS,
    );
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function writeDurablePrivateFile(path: string, bytes: Buffer): void {
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
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  const stat = lstatSync(path, { bigint: true });
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(Number(stat.mode & 0o777n), 0o700);
}

function materializeGateTree(root: string, foreignTarget: string): void {
  const build = join(root, 'build');
  const out = join(build, 'out');
  const runtime = join(root, 'runtime');
  const runtimeHome = join(runtime, 'home');
  const runtimeTmp = join(runtime, 'tmp');
  const artifacts = join(root, 'artifacts');
  for (const directory of [
    build,
    out,
    runtime,
    runtimeHome,
    runtimeTmp,
    artifacts,
  ]) createPrivateDirectory(directory);

  writeDurablePrivateFile(
    join(out, 'suite.js'),
    Buffer.from('export const proof = "owned-build";\n', 'utf8'),
  );
  writeDurablePrivateFile(
    join(runtimeHome, 'config.json'),
    Buffer.from('{"fixture":"owned-runtime"}\n', 'utf8'),
  );
  writeDurablePrivateFile(
    join(runtimeTmp, 'worker.tmp'),
    Buffer.from('owned-runtime-temp\n', 'utf8'),
  );
  writeDurablePrivateFile(
    join(artifacts, 'stdout.log'),
    Buffer.from('owned-artifact-output\n', 'utf8'),
  );
  symlinkSync(foreignTarget, join(build, 'node_modules'), 'dir');
}

function snapshotCanary(path: string): CanarySnapshot {
  const stat = lstatSync(path, { bigint: true });
  assert.equal(stat.isFile(), true, 'foreign canary is not a regular file');
  assert.equal(stat.isSymbolicLink(), false, 'foreign canary is a symlink');
  const bytes = readFileSync(path);
  assert.equal(BigInt(bytes.byteLength), stat.size);
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o7777n,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
  };
}

function assertCanaryUnchanged(expected: CanarySnapshot): void {
  const actual = snapshotCanary(expected.path);
  assert.deepEqual(actual, expected, `foreign canary changed: ${basename(expected.path)}`);
}

function sameDirectoryIdentity(path: string, expected: BigIntStats): boolean {
  try {
    const actual = lstatSync(path, { bigint: true });
    return actual.isDirectory()
      && !actual.isSymbolicLink()
      && actual.dev === expected.dev
      && actual.ino === expected.ino
      && actual.uid === expected.uid
      && (actual.mode & 0o7777n) === (expected.mode & 0o7777n);
  } catch {
    return false;
  }
}

async function exactPidGone(pid: number, startToken: string): Promise<boolean> {
  const current = await readLinuxProcessIdentity(pid);
  return current === null || current.processStartToken !== startToken;
}

async function assertWorkloadTreeEmpty(ready: OwnerReadyMessage): Promise<void> {
  assert.equal(
    await exactPidGone(ready.childPid, ready.childProcessStartToken),
    true,
    'owned child survived workspace reclaim',
  );
  assert.equal(
    await exactPidGone(ready.grandchildPid, ready.grandchildProcessStartToken),
    true,
    'owned grandchild survived workspace reclaim',
  );
  const inspection = await inspectOwnedProcessTree(
    deserializeProcessOwner(ready.processOwner),
  );
  assert.equal(inspection.treeEmpty, true, inspection.reason);
  assert.equal(inspection.groupMembers.length, 0);
  assert.equal(inspection.tokenMembers.length, 0);
}

async function stopProofWorkloadTree(ready: OwnerReadyMessage): Promise<void> {
  const owner = deserializeProcessOwner(ready.processOwner);
  let inspection = await inspectOwnedProcessTree(owner);
  if (inspection.treeEmpty) return;
  const term = await signalOwnedProcessGroup(owner, 'SIGTERM');
  if (!term.sent && !term.alreadyEmpty) {
    throw new Error(term.reason ?? 'proof workload refused exact SIGTERM');
  }
  let waited = await waitForOwnedProcessTreeEmpty(owner, {
    timeoutMs: 250,
    pollMs: 10,
  });
  if (!waited.empty) {
    const kill = await signalOwnedProcessGroup(owner, 'SIGKILL');
    if (!kill.sent && !kill.alreadyEmpty) {
      throw new Error(kill.reason ?? 'proof workload refused exact SIGKILL');
    }
    waited = await waitForOwnedProcessTreeEmpty(owner, {
      timeoutMs: 2_000,
      pollMs: 10,
    });
  }
  inspection = waited.inspection;
  if (!waited.empty || !inspection.treeEmpty) {
    throw new Error(inspection.reason ?? 'proof workload tree did not become empty');
  }
}

function assertCountConservingReport(
  reportInput: unknown,
  expectedScanned: number,
  expectedOutcome?: string,
  expectedReasonCode?: string,
): GateWorkspaceOrphanReclaimReport {
  const report = gateWorkspaceOrphanReclaimReportSchema.parse(reportInput);
  assert.equal(report.status, 'PASSED');
  assert.equal(report.reclaimVerified, true);
  assert.equal(report.journalRootVerified, true);
  assert.equal(report.managedRootVerified, true);
  assert.equal(report.scanComplete, true);
  assert.equal(report.timedOut, false);
  const effects = report.effects;
  assert.equal(
    report.scannedEntries,
    expectedScanned,
    'workspace reclaim scanned count differs',
  );
  assert.equal(effects.length, expectedScanned, 'workspace reclaim lost an effect');

  const counts = [
    report.activeCount,
    report.claimedByLiveReclaimerCount,
    report.reclaimedCount,
    report.alreadyAbsentCount,
    report.unsafeCount,
    report.failedCount,
  ];
  assert.equal(
    counts.reduce((sum, value) => sum + value, 0),
    effects.length,
    'workspace reclaim counters do not conserve effects',
  );
  if (expectedOutcome !== undefined) {
    assert.equal(effects[0]?.outcome, expectedOutcome);
  }
  if (expectedReasonCode !== undefined) {
    assert.equal(effects[0]?.reasonCode, expectedReasonCode);
  }
  const serialized = JSON.stringify(report);
  assert.equal(typeof serialized, 'string');
  assert.deepEqual(JSON.parse(serialized), report);
  return report;
}

async function runGrandchild(): Promise<void> {
  try {
    process.on('SIGTERM', () => {});
    const identity = await readLinuxProcessIdentity(process.pid);
    assert.ok(identity, 'grandchild process identity is unavailable');
    process.send?.({
      type: 'GRANDCHILD_READY',
      pid: identity.pid,
      processStartToken: identity.processStartToken,
      pgid: identity.pgid,
      sid: identity.sid,
    });
    await new Promise<never>(() => {});
  } catch (error) {
    sendFailure('GRANDCHILD_FAILED', error);
    process.exitCode = 1;
    throw error;
  }
}

async function runWorkload(): Promise<void> {
  let grandchild: ChildProcess | undefined;
  try {
    await waitForStart();
    process.on('SIGTERM', () => {});
    const executionId = requiredEnv(PROCESS_EXECUTION_ID_ENV);
    const runtimeRunId = requiredEnv(PROCESS_RUNTIME_RUN_ID_ENV);
    grandchild = forkSelf(GRANDCHILD_MODE, {
      cwd: process.cwd(),
      env: {
        ...safeBaseEnv(),
        [PROCESS_EXECUTION_ID_ENV]: executionId,
        [PROCESS_RUNTIME_RUN_ID_ENV]: runtimeRunId,
      },
    });
    const grandchildReady = await waitForMessage(
      grandchild,
      parseGrandchildReady,
    );
    const identity = await readLinuxProcessIdentity(process.pid);
    assert.ok(identity, 'workload process identity is unavailable');
    assert.equal(grandchildReady.pgid, identity.pgid);
    assert.equal(grandchildReady.sid, identity.sid);
    process.send?.({
      type: 'WORKLOAD_READY',
      childPid: identity.pid,
      childProcessStartToken: identity.processStartToken,
      grandchildPid: grandchildReady.pid,
      grandchildProcessStartToken: grandchildReady.processStartToken,
      pgid: identity.pgid,
      sid: identity.sid,
    });
    await new Promise<never>(() => {});
  } catch (error) {
    sendFailure('WORKLOAD_FAILED', error);
    if (
      grandchild
      && grandchild.exitCode === null
      && grandchild.signalCode === null
    ) grandchild.kill('SIGKILL');
    process.exitCode = 1;
    throw error;
  }
}

async function runOwnerParent(): Promise<void> {
  let workload: ChildProcess | undefined;
  let claimedOwner: AttemptProcessOwnerDoc | undefined;
  try {
    const layout = assertProofLayout();
    const store = new GateWorkspaceOrphanJournalStore({
      journalRoot: layout.journalRoot,
      managedRoot: layout.managedRoot,
    });
    const created = await store.createOwnedRoot({});
    const root = realpathSync(created.root);
    assert.equal(dirname(root), layout.managedRoot);
    const foreignTarget = realpathSync(join(layout.proofRoot, 'foreign-target'));
    materializeGateTree(root, foreignTarget);

    const processExecutionId = `proof_exec_${randomBytes(24).toString('hex')}`;
    const runtimeRunId = `proof_run_${randomBytes(24).toString('hex')}`;
    const session = await store.registerSession(created.allocation, {
      suiteId: SUITE_ID,
      processExecutionId,
      runtimeRunId,
      workspaceRoot: join(root, 'runtime'),
    });

    workload = forkSelf(WORKLOAD_MODE, {
      cwd: root,
      detached: true,
      env: {
        ...safeBaseEnv(),
        [PROCESS_EXECUTION_ID_ENV]: processExecutionId,
        [PROCESS_RUNTIME_RUN_ID_ENV]: runtimeRunId,
      },
    });
    assert.ok(workload.pid && workload.pid >= 2, 'workload did not receive a PID');
    let identity = await readLinuxProcessIdentity(workload.pid);
    const identityDeadline = Date.now() + IPC_TIMEOUT_MS;
    while (!identity && Date.now() < identityDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      identity = await readLinuxProcessIdentity(workload.pid);
    }
    assert.ok(identity, 'workload identity disappeared before binding');
    assert.equal(
      identity.pgid,
      identity.pid,
      'detached workload is not its exact process-group leader',
    );
    assert.equal(
      identity.sid,
      identity.pid,
      'detached workload is not its exact session leader',
    );
    const local = await readLocalProcessHostIdentity();
    const boundAt = new Date();
    const processOwner = attemptProcessOwnerDocFromLinuxClaim({
      processExecutionId,
      runtimeRunId,
      workerInstanceId: 'g0-workspace-proof',
      ownerGeneration: 1,
      attemptFence: 1,
      localIdentity: local,
      processIdentity: identity,
      registeredAt: boundAt,
      startedAt: boundAt,
    });
    claimedOwner = processOwner;
    await store.bindSessionOwner(created.allocation, session, processOwner);

    const readyPromise = waitForMessage(workload, parseWorkloadReady);
    workload.send?.({ type: 'START_WORKLOAD' });
    const ready = await readyPromise;
    assert.equal(ready.childPid, processOwner.pid);
    assert.equal(ready.childProcessStartToken, processOwner.processStartToken);
    assert.equal(ready.pgid, processOwner.pgid);
    assert.equal(ready.sid, processOwner.sid);

    process.send?.({
      type: 'OWNER_READY',
      allocation: created.allocation,
      root,
      processOwner: serializeProcessOwner(processOwner),
      childPid: ready.childPid,
      childProcessStartToken: ready.childProcessStartToken,
      grandchildPid: ready.grandchildPid,
      grandchildProcessStartToken: ready.grandchildProcessStartToken,
    });
    await new Promise<never>(() => {});
  } catch (error) {
    sendFailure('OWNER_FAILED', error);
    if (claimedOwner) {
      await signalOwnedProcessGroup(claimedOwner, 'SIGKILL').catch(() => undefined);
      await waitForOwnedProcessTreeEmpty(claimedOwner, {
        timeoutMs: 2_000,
        pollMs: 10,
      }).catch(() => undefined);
    } else if (
      workload
      && workload.exitCode === null
      && workload.signalCode === null
    ) workload.kill('SIGKILL');
    process.exitCode = 1;
    throw error;
  }
}

/**
 * Suspend at a crash hook until the controller delivers SIGKILL.
 *
 * A bare `new Promise<never>` does not hold the event loop open: once the
 * reclaim is parked here and nothing else is pending, Node empties the loop and
 * exits on its own with code 13 (unsettled top-level await) instead of hanging
 * for the exact SIGKILL the proof injects at this crash point. Unlike the
 * non-cooperative workload (which incidentally stays alive via its ignored
 * SIGTERM handler), a reclaimer registers no such handle, so it must ref a timer
 * itself. The proof SIGKILLs this process within seconds, so the interval never
 * meaningfully fires.
 */
function hangUntilKilled(): Promise<never> {
  return new Promise<never>(() => {
    // A ref'd timer keeps the event loop alive; never cleared or unref'd.
    setInterval(() => {}, 60_000);
  });
}

async function runReclaimer(
  kind: 'FIRST_REMOVAL' | 'TERMINAL_WINDOW',
): Promise<void> {
  try {
    const layout = assertProofLayout();
    const store = new GateWorkspaceOrphanJournalStore({
      journalRoot: layout.journalRoot,
      managedRoot: layout.managedRoot,
    });
    await store.reclaim({
      deadlineMs: RECLAIM_DEADLINE_MS,
      hooks: kind === 'FIRST_REMOVAL'
        ? {
          afterFirstRemoval: async () => {
            process.send?.({ type: 'FIRST_REMOVAL' });
            await hangUntilKilled();
          },
        }
        : {
          afterJournalUnlinkBeforeClaimRelease: async () => {
            process.send?.({ type: 'TERMINAL_WINDOW' });
            await hangUntilKilled();
          },
        },
    });
    throw new Error(`live proof reclaimer unexpectedly crossed ${kind}`);
  } catch (error) {
    sendFailure('RECLAIMER_FAILED', error);
    process.exitCode = 1;
    throw error;
  }
}

async function terminateIfLive(child: ChildProcess | undefined): Promise<void> {
  if (
    !child
    || child.exitCode !== null
    || child.signalCode !== null
  ) return;
  const exiting = waitForExit(child).catch(() => undefined);
  child.kill('SIGKILL');
  await exiting;
}

async function runController(): Promise<void> {
  assert.equal(process.platform, 'linux', 'workspace reclaim proof requires Linux');
  const createdProofRoot = mkdtempSync(
    join(tmpdir(), 'orch-g0-gate-workspace-reclaim-proof-'),
  );
  chmodSync(createdProofRoot, 0o700);
  const proofRoot = realpathSync(createdProofRoot);
  const proofRootStat = lstatSync(proofRoot, { bigint: true });
  const journalRoot = join(proofRoot, 'journal');
  const managedRoot = join(proofRoot, 'managed');
  const foreignTarget = join(proofRoot, 'foreign-target');
  createPrivateDirectory(journalRoot);
  createPrivateDirectory(managedRoot);
  createPrivateDirectory(foreignTarget);
  const journalRootStat = lstatSync(journalRoot, { bigint: true });
  const managedRootStat = lstatSync(managedRoot, { bigint: true });
  const foreignTargetStat = lstatSync(foreignTarget, { bigint: true });
  const foreignSiblingPath = join(proofRoot, 'foreign-sibling.canary');
  const foreignTargetPath = join(foreignTarget, 'symlink-target.canary');
  writeDurablePrivateFile(
    foreignSiblingPath,
    Buffer.from(`foreign-sibling:${randomBytes(32).toString('hex')}\n`, 'utf8'),
  );
  writeDurablePrivateFile(
    foreignTargetPath,
    Buffer.from(`foreign-target:${randomBytes(32).toString('hex')}\n`, 'utf8'),
  );
  const canaries = [
    snapshotCanary(foreignSiblingPath),
    snapshotCanary(foreignTargetPath),
  ];
  const layout = { proofRoot, journalRoot, managedRoot };
  const env = proofChildEnv(layout);

  let ownerParent: ChildProcess | undefined;
  let firstReclaimer: ChildProcess | undefined;
  let terminalReclaimer: ChildProcess | undefined;
  let ready: OwnerReadyMessage | undefined;
  let quarantinePath: string | undefined;
  let proofComplete = false;
  try {
    ownerParent = forkSelf(OWNER_PARENT_MODE, {
      cwd: PROJECT_ROOT,
      env,
    });
    ready = await waitForMessage(ownerParent, parseOwnerReady);
    const workspaceId = ready.allocation.workspaceId;
    assert.equal(realpathSync(ready.root), ready.root);
    assert.equal(ready.root, ready.allocation.rootPath);
    assert.equal(basename(ready.root), ready.allocation.rootName);
    assert.equal(dirname(ready.root), managedRoot);
    assert.equal(pathIsWithin(managedRoot, ready.root), true);
    const readyJournalNames = readdirSync(journalRoot).sort();
    assert.equal(
      readyJournalNames.length,
      4,
      'owner readiness did not publish one complete session authority',
    );
    assert.deepEqual(
      readyJournalNames.filter((name) =>
        name === `${workspaceId}.entry.json`
        || name === `${workspaceId}.binding.json`),
      [
        `${workspaceId}.binding.json`,
        `${workspaceId}.entry.json`,
      ],
      'owner readiness is missing its durable entry or root binding',
    );
    assert.equal(
      readyJournalNames.filter((name) =>
        new RegExp(
          `^${workspaceId}\\.g0session_[a-f0-9]{32}\\.session\\.json$`,
        ).test(name)).length,
      1,
      'owner readiness is missing its registered session',
    );
    assert.equal(
      readyJournalNames.filter((name) =>
        new RegExp(
          `^${workspaceId}\\.g0session_[a-f0-9]{32}\\.owner\\.json$`,
        ).test(name)).length,
      1,
      'owner readiness is missing its exact process-owner binding',
    );
    assert.equal(
      lstatSync(join(ready.root, 'build', 'node_modules')).isSymbolicLink(),
      true,
      'owned build leaf symlink was not materialized',
    );
    for (const canary of canaries) assertCanaryUnchanged(canary);

    const ownerExit = waitForExit(ownerParent);
    assert.equal(ownerParent.kill('SIGKILL'), true, 'owner parent refused SIGKILL');
    const ownerTerminated = await ownerExit;
    assert.equal(ownerTerminated.signal, 'SIGKILL', 'owner parent did not die by SIGKILL');

    firstReclaimer = forkSelf(FIRST_RECLAIMER_MODE, {
      cwd: PROJECT_ROOT,
      env,
    });
    await waitForMessage(firstReclaimer, parseHookReady('FIRST_REMOVAL'));
    await assertWorkloadTreeEmpty(ready);
    assert.equal(
      existsSync(ready.root),
      false,
      'original root still exists after quarantine and first removal',
    );
    const afterFirstRemoval = readdirSync(managedRoot).sort();
    assert.equal(
      afterFirstRemoval.length,
      1,
      'first removal did not leave one exact resumable quarantine root',
    );
    quarantinePath = join(managedRoot, afterFirstRemoval[0]!);
    assert.match(
      basename(quarantinePath),
      new RegExp(
        `^\\.orch-g0-gate-quarantine-${
          ready.allocation.workspaceId.slice('g0ws_'.length)
        }-[a-f0-9]{32}$`,
      ),
      'first removal retained a non-authoritative managed-root sibling',
    );
    const quarantineStat = lstatSync(quarantinePath, { bigint: true });
    assert.equal(quarantineStat.isDirectory(), true);
    assert.equal(quarantineStat.isSymbolicLink(), false);
    assert.ok(readdirSync(journalRoot).length > 0, 'first crash point lost journal authority');
    for (const canary of canaries) assertCanaryUnchanged(canary);

    const firstExit = waitForExit(firstReclaimer);
    assert.equal(
      firstReclaimer.kill('SIGKILL'),
      true,
      'first-removal reclaimer refused SIGKILL',
    );
    const firstTerminated = await firstExit;
    assert.equal(
      firstTerminated.signal,
      'SIGKILL',
      'first-removal reclaimer did not die by SIGKILL',
    );

    terminalReclaimer = forkSelf(TERMINAL_RECLAIMER_MODE, {
      cwd: PROJECT_ROOT,
      env,
    });
    await waitForMessage(
      terminalReclaimer,
      parseHookReady('TERMINAL_WINDOW'),
    );
    assert.equal(existsSync(ready.root), false, 'original root returned at terminal window');
    assert.equal(
      existsSync(quarantinePath),
      false,
      'quarantine root survived terminal deletion',
    );
    assert.deepEqual(readdirSync(managedRoot), [], 'managed root is not empty');
    const terminalJournalNames = readdirSync(journalRoot).sort();
    assert.equal(
      terminalJournalNames.length,
      1,
      'terminal window must retain exactly one claim-only authority',
    );
    assert.match(
      terminalJournalNames[0]!,
      /\.claim\.json$/,
      'terminal window retained something other than the exact claim',
    );
    await assertWorkloadTreeEmpty(ready);
    for (const canary of canaries) assertCanaryUnchanged(canary);

    const terminalExit = waitForExit(terminalReclaimer);
    assert.equal(
      terminalReclaimer.kill('SIGKILL'),
      true,
      'terminal-window reclaimer refused SIGKILL',
    );
    const terminalTerminated = await terminalExit;
    assert.equal(
      terminalTerminated.signal,
      'SIGKILL',
      'terminal-window reclaimer did not die by SIGKILL',
    );

    const store = new GateWorkspaceOrphanJournalStore({
      journalRoot,
      managedRoot,
    });
    const claimOnlyReport = await store.reclaim({
      deadlineMs: RECLAIM_DEADLINE_MS,
    });
    const strictClaimOnlyReport = assertCountConservingReport(
      claimOnlyReport,
      1,
      'ALREADY_ABSENT',
      'ROOT_ALREADY_ABSENT',
    );
    assert.equal(existsSync(ready.root), false);
    assert.equal(existsSync(quarantinePath), false);
    assert.deepEqual(readdirSync(managedRoot), []);
    assert.deepEqual(readdirSync(journalRoot), []);
    await assertWorkloadTreeEmpty(ready);
    for (const canary of canaries) assertCanaryUnchanged(canary);

    const emptyReport = await store.reclaim({
      deadlineMs: RECLAIM_DEADLINE_MS,
    });
    const strictEmptyReport = assertCountConservingReport(emptyReport, 0);
    assert.deepEqual(readdirSync(managedRoot), []);
    assert.deepEqual(readdirSync(journalRoot), []);
    for (const canary of canaries) assertCanaryUnchanged(canary);

    assert.equal(sameDirectoryIdentity(proofRoot, proofRootStat), true);
    assert.equal(sameDirectoryIdentity(journalRoot, journalRootStat), true);
    assert.equal(sameDirectoryIdentity(managedRoot, managedRootStat), true);
    assert.equal(sameDirectoryIdentity(foreignTarget, foreignTargetStat), true);
    assert.deepEqual(
      readdirSync(proofRoot).sort(),
      ['foreign-sibling.canary', 'foreign-target', 'journal', 'managed'],
      'proof root contains an unexpected deletion target',
    );
    proofComplete = true;
    rmSync(proofRoot, { recursive: true });
    assert.equal(existsSync(proofRoot), false, 'completed proof root was not removed');

    console.log(JSON.stringify({
      schemaVersion: PROOF_VERSION,
      status: 'PASSED',
      crash: {
        ownerSignal: 'SIGKILL',
        firstRemovalReclaimerSignal: 'SIGKILL',
        terminalWindowReclaimerSignal: 'SIGKILL',
      },
      tree: {
        childExactAbsent: true,
        grandchildExactAbsent: true,
        processTreeEmpty: true,
      },
      workspace: {
        originalAbsent: true,
        quarantineAbsent: true,
        managedRootEmpty: true,
        leafSymlinkWasNotFollowed: true,
      },
      journal: {
        claimOnlyRecovered: true,
        empty: true,
      },
      canaries: {
        count: canaries.length,
        inodeHashNlinkMtimeUnchanged: true,
      },
      reclaim: strictClaimOnlyReport,
      emptySweep: strictEmptyReport,
      proofRootCleaned: true,
    }));
  } finally {
    await terminateIfLive(ownerParent);
    await terminateIfLive(firstReclaimer);
    await terminateIfLive(terminalReclaimer);
    // A failed proof deliberately retains its private root and foreign canaries
    // for inspection. It must still stop the detached workload tree, and a
    // failure to do so is itself surfaced rather than hidden behind the proof's
    // original assertion failure.
    if (!proofComplete && ready) {
      await stopProofWorkloadTree(ready);
    }
  }
}

const mode = process.argv[2];
if (mode === GRANDCHILD_MODE) {
  await runGrandchild();
} else if (mode === WORKLOAD_MODE) {
  await runWorkload();
} else if (mode === OWNER_PARENT_MODE) {
  await runOwnerParent();
} else if (mode === FIRST_RECLAIMER_MODE) {
  await runReclaimer('FIRST_REMOVAL');
} else if (mode === TERMINAL_RECLAIMER_MODE) {
  await runReclaimer('TERMINAL_WINDOW');
} else {
  await runController();
}
