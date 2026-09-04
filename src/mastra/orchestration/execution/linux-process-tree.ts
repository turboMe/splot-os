/**
 * Linux `/proc` process-tree authority for PROCESS_GROUP attempts.
 *
 * PID/PGID alone are never sufficient authority: before a group signal this
 * module verifies the same host boot, PID namespace, exact session leader start
 * token, PGID/SID shape, and inherited execution/runtime tokens. A mismatch is
 * fail-closed and never falls back to signalling a bare PID.
 */
import { hostname } from 'node:os';
import {
  readFile,
  readdir,
  readlink,
} from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { AttemptProcessOwnerDoc } from '../store/collections.js';

export const PROCESS_EXECUTION_ID_ENV = 'ORCH_PROCESS_EXECUTION_ID';
export const PROCESS_RUNTIME_RUN_ID_ENV = 'ORCH_RUNTIME_RUN_ID';

const PROC_ROOT = '/proc';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const PID_NAMESPACE_PATH = '/proc/self/ns/pid';
const NUMERIC_PID = /^[1-9][0-9]*$/;

export interface LocalLinuxProcessIdentity {
  hostId: string;
  hostBootId: string;
  pidNamespaceId: string;
}

export interface LinuxProcStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  pgid: number;
  sid: number;
  /** Linux `/proc/<pid>/stat` field 22, in clock ticks after boot. */
  startTimeTicks: string;
  /** Canonical value persisted as `processOwner.processStartToken`. */
  processStartToken: string;
}

export interface LinuxProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  processStartToken: string;
  pidNamespaceId: string;
  state: string;
}

export interface LinuxProcEntry {
  stat: LinuxProcStat;
  realUid: number | null;
  executionId: string | null;
  runtimeRunId: string | null;
  environmentReadable: boolean;
}

export interface NumericProcScan {
  entries: LinuxProcEntry[];
  /**
   * Same-UID processes whose environment could not be inspected. Their presence
   * means an escaped execution-token descendant cannot be disproved.
   */
  unreadableSameUidPids: number[];
  completeForCurrentUid: boolean;
}

export type OwnedLeaderState = 'MATCH' | 'MISSING' | 'MISMATCH';

export interface OwnedProcessTreeInspection {
  verifiable: boolean;
  empty: boolean;
  leaderMatches: boolean;
  members: Array<{
    pid: number;
    pgid: number;
    sid: number;
    state: string;
  }>;
  escapedExecutionPids: number[];
  reason?: string;
  owner: AttemptProcessOwnerDoc;
  localIdentity: LocalLinuxProcessIdentity | null;
  localIdentityMatches: boolean;
  leaderState: OwnedLeaderState;
  leader: LinuxProcEntry | null;
  groupMembers: LinuxProcEntry[];
  tokenMembers: LinuxProcEntry[];
  escapedTokenMembers: LinuxProcEntry[];
  untrustedGroupMembers: LinuxProcEntry[];
  unreadableSameUidPids: number[];
  scanComplete: boolean;
  treeEmpty: boolean;
  signalSafe: boolean;
}

export interface WaitForOwnedProcessTreeEmptyOptions {
  deadlineAt?: Date | number;
  pollMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WaitForOwnedProcessTreeEmptyResult {
  empty: boolean;
  treeEmptyAt: Date | null;
  waitedMs: number;
  inspection: OwnedProcessTreeInspection;
}

export interface SignalOwnedProcessGroupResult {
  sent: boolean;
  alreadyEmpty: boolean;
  signaled: boolean;
  signal: NodeJS.Signals;
  inspection: OwnedProcessTreeInspection;
  reason?: string;
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${field} in Linux proc stat`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${field} in Linux proc stat`);
  }
  return parsed;
}

/**
 * Parse `/proc/<pid>/stat` without splitting the parenthesized command name.
 * `comm` may contain spaces and `)`, therefore the final `)` is authoritative.
 */
export function parseLinuxProcStat(raw: string): LinuxProcStat {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open <= 0 || close <= open || close + 2 >= raw.length) {
    throw new Error('malformed Linux proc stat');
  }
  const pid = positiveInteger(raw.slice(0, open).trim(), 'pid');
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  // Tail starts at stat field 3 (`state`), so field 22 is tail index 19.
  if (fields.length <= 19) throw new Error('truncated Linux proc stat');
  const startTimeTicks = fields[19]!;
  if (!/^[0-9]+$/.test(startTimeTicks)) {
    throw new Error('invalid process start time in Linux proc stat');
  }
  return {
    pid,
    comm: raw.slice(open + 1, close),
    state: fields[0]!,
    ppid: nonNegativeInteger(fields[1]!, 'ppid'),
    pgid: nonNegativeInteger(fields[2]!, 'pgid'),
    sid: nonNegativeInteger(fields[3]!, 'sid'),
    startTimeTicks,
    processStartToken: startTimeTicks,
  };
}

export async function readLocalProcessHostIdentity(
  hostId = hostname(),
): Promise<LocalLinuxProcessIdentity> {
  if (process.platform !== 'linux') {
    throw new Error('PROCESS_GROUP supervision requires Linux');
  }
  const [hostBootId, pidNamespaceId] = await Promise.all([
    readFile(BOOT_ID_PATH, 'utf8').then((value) => value.trim()),
    readlink(PID_NAMESPACE_PATH),
  ]);
  if (!hostId || !hostBootId || !pidNamespaceId) {
    throw new Error('incomplete local Linux process identity');
  }
  return { hostId, hostBootId, pidNamespaceId };
}

/** Backwards-compatible descriptive alias used by lower-level callers. */
export const readLocalLinuxProcessIdentity = readLocalProcessHostIdentity;

export async function readLinuxProcStat(
  pid: number,
): Promise<LinuxProcStat | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const raw = await readFile(`${PROC_ROOT}/${pid}/stat`, 'utf8');
    const stat = parseLinuxProcStat(raw);
    return stat.pid === pid ? stat : null;
  } catch (error) {
    if (isTransientProcError(error)) return null;
    throw error;
  }
}

function isTransientProcError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ESRCH' || code === 'ENOTDIR';
}

async function readPidNamespaceId(pid: number): Promise<string | null> {
  try {
    return await readlink(`${PROC_ROOT}/${pid}/ns/pid`);
  } catch (error) {
    if (isTransientProcError(error)) return null;
    throw error;
  }
}

export async function readLinuxProcessIdentity(
  pid: number,
): Promise<LinuxProcessIdentity | null> {
  const before = await readLinuxProcStat(pid);
  if (!before) return null;
  const pidNamespaceId = await readPidNamespaceId(pid);
  if (!pidNamespaceId) return null;
  const after = await readLinuxProcStat(pid);
  if (
    !after
    || after.processStartToken !== before.processStartToken
  ) return null;
  return {
    pid: after.pid,
    ppid: after.ppid,
    pgid: after.pgid,
    sid: after.sid,
    processStartToken: after.processStartToken,
    pidNamespaceId,
    state: after.state,
  };
}

async function readRealUid(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`${PROC_ROOT}/${pid}/status`, 'utf8');
    const match = /^Uid:\s+([0-9]+)/m.exec(status);
    if (!match) return null;
    const uid = Number(match[1]);
    return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
  } catch (error) {
    if (isTransientProcError(error)) return null;
    throw error;
  }
}

function parseExecutionEnvironment(buffer: Buffer): {
  executionId: string | null;
  runtimeRunId: string | null;
} {
  let executionId: string | null = null;
  let runtimeRunId: string | null = null;
  for (const field of buffer.toString('utf8').split('\0')) {
    if (field.startsWith(`${PROCESS_EXECUTION_ID_ENV}=`)) {
      executionId = field.slice(PROCESS_EXECUTION_ID_ENV.length + 1);
    } else if (field.startsWith(`${PROCESS_RUNTIME_RUN_ID_ENV}=`)) {
      runtimeRunId = field.slice(PROCESS_RUNTIME_RUN_ID_ENV.length + 1);
    }
  }
  return { executionId, runtimeRunId };
}

async function readProcEntry(
  pid: number,
  currentUid: number | null,
): Promise<{
  entry: LinuxProcEntry | null;
  unreadableSameUid: boolean;
}> {
  const stat = await readLinuxProcStat(pid);
  if (!stat) return { entry: null, unreadableSameUid: false };
  const realUid = await readRealUid(pid);
  let environmentReadable = false;
  let executionId: string | null = null;
  let runtimeRunId: string | null = null;
  try {
    const environment = await readFile(`${PROC_ROOT}/${pid}/environ`);
    ({ executionId, runtimeRunId } = parseExecutionEnvironment(environment));
    environmentReadable = true;
  } catch (error) {
    if (isTransientProcError(error)) {
      return { entry: null, unreadableSameUid: false };
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
  }
  const confirmedStat = await readLinuxProcStat(pid);
  if (
    !confirmedStat
    || confirmedStat.processStartToken !== stat.processStartToken
  ) {
    return { entry: null, unreadableSameUid: false };
  }
  return {
    entry: {
      stat: confirmedStat,
      realUid,
      executionId,
      runtimeRunId,
      environmentReadable,
    },
    unreadableSameUid:
      !environmentReadable
      && currentUid !== null
      && realUid === currentUid,
  };
}

/** Snapshot all numeric `/proc` entries and inherited execution tokens. */
export async function scanNumericProc(): Promise<NumericProcScan> {
  if (process.platform !== 'linux') {
    throw new Error('numeric proc scanning requires Linux');
  }
  const currentUid = typeof process.getuid === 'function'
    ? process.getuid()
    : null;
  const dirents = await readdir(PROC_ROOT, { withFileTypes: true });
  const pids = dirents
    .filter((entry) => entry.isDirectory() && NUMERIC_PID.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);
  const settled = await Promise.all(
    pids.map((pid) => readProcEntry(pid, currentUid)),
  );
  const entries: LinuxProcEntry[] = [];
  const unreadableSameUidPids: number[] = [];
  for (const item of settled) {
    if (item.entry) entries.push(item.entry);
    if (item.unreadableSameUid && item.entry) {
      unreadableSameUidPids.push(item.entry.stat.pid);
    }
  }
  return {
    entries,
    unreadableSameUidPids,
    completeForCurrentUid: unreadableSameUidPids.length === 0,
  };
}

function entryHasOwnerTokens(
  entry: LinuxProcEntry,
  owner: AttemptProcessOwnerDoc,
): boolean {
  return entry.environmentReadable
    && entry.executionId === owner.processExecutionId
    && entry.runtimeRunId === owner.runtimeRunId;
}

function exactLeaderMatches(
  entry: LinuxProcEntry,
  owner: AttemptProcessOwnerDoc,
): boolean {
  return entry.stat.pid === owner.pid
    && entry.stat.pgid === owner.pgid
    && entry.stat.sid === owner.sid
    && entry.stat.processStartToken === owner.processStartToken
    && entryHasOwnerTokens(entry, owner);
}

function invalidOwnerReason(owner: AttemptProcessOwnerDoc): string | null {
  if (owner.mode !== 'PROCESS_GROUP') return 'owner mode is not PROCESS_GROUP';
  if (!owner.pidNamespaceId) return 'owner PID namespace is missing';
  if (!Number.isSafeInteger(owner.sid) || owner.sid! < 2) {
    return 'owner session id is invalid';
  }
  if (
    !Number.isSafeInteger(owner.pid)
    || !Number.isSafeInteger(owner.pgid)
    || owner.pid < 2
    || owner.pgid < 2
  ) return 'owner PID/PGID is invalid';
  if (owner.pid !== owner.pgid || owner.pid !== owner.sid) {
    return 'PROCESS_GROUP owner must have pid=pgid=sid';
  }
  if (!owner.processExecutionId || !owner.runtimeRunId) {
    return 'owner execution tokens are missing';
  }
  if (!/^[0-9]+$/.test(owner.processStartToken)) {
    return 'owner process start token is invalid';
  }
  return null;
}

/**
 * Inspect the exact owner group plus token-bearing descendants which escaped
 * that PGID/SID. Escaped or temporarily unreadable descendants block an empty
 * proof. They do not make a signal to an otherwise exact owned group unsafe:
 * the group can still be stopped, while the receipt remains fail-closed.
 */
export async function inspectOwnedProcessTree(
  owner: AttemptProcessOwnerDoc,
): Promise<OwnedProcessTreeInspection> {
  let localIdentity: LocalLinuxProcessIdentity | null = null;
  let scan: NumericProcScan = {
    entries: [],
    unreadableSameUidPids: [],
    completeForCurrentUid: false,
  };
  let setupError: string | null = invalidOwnerReason(owner);
  try {
    [localIdentity, scan] = await Promise.all([
      readLocalLinuxProcessIdentity(),
      scanNumericProc(),
    ]);
  } catch (error) {
    setupError ??= (error as Error).message;
  }

  const localIdentityMatches = Boolean(
    localIdentity
      && owner.hostId === localIdentity.hostId
      && owner.hostBootId === localIdentity.hostBootId
      && owner.pidNamespaceId === localIdentity.pidNamespaceId,
  );
  const leader = scan.entries.find((entry) => entry.stat.pid === owner.pid)
    ?? null;
  const leaderState: OwnedLeaderState = !leader
    ? 'MISSING'
    : exactLeaderMatches(leader, owner)
      ? 'MATCH'
      : 'MISMATCH';
  const groupMembers = scan.entries.filter(
    (entry) =>
      entry.stat.pgid === owner.pgid
      && entry.stat.sid === owner.sid,
  );
  const tokenMembers = scan.entries.filter(
    (entry) => entryHasOwnerTokens(entry, owner),
  );
  const escapedTokenMembers = tokenMembers.filter(
    (entry) =>
      entry.stat.pgid !== owner.pgid
      || entry.stat.sid !== owner.sid,
  );
  const untrustedGroupMembers = groupMembers.filter(
    (entry) => !entryHasOwnerTokens(entry, owner),
  );
  const selfStat = scan.entries.find((entry) => entry.stat.pid === process.pid)
    ?.stat ?? null;
  const targetsCurrentRuntime = Boolean(
    selfStat
      && (
        owner.pid === process.pid
        || owner.pgid === selfStat.pgid
        || owner.sid === selfStat.sid
      ),
  );
  // A process that existed before the owned session leader cannot be its
  // descendant. Ignore such pre-existing same-UID `/proc/*/environ` denials;
  // only unreadable processes born at/after this execution keep escaped-child
  // proof ambiguous. This preserves fail-closed behavior without letting
  // unrelated long-lived host daemons permanently disable every receipt.
  const ownerStartTicks = /^[0-9]+$/.test(owner.processStartToken)
    ? BigInt(owner.processStartToken)
    : null;
  const unreadablePidSet = new Set(scan.unreadableSameUidPids);
  const ambiguousUnreadableSameUidPids = scan.entries
    .filter(
      (entry) =>
        unreadablePidSet.has(entry.stat.pid)
        && (
          ownerStartTicks === null
          || BigInt(entry.stat.startTimeTicks) >= ownerStartTicks
        ),
    )
    .map((entry) => entry.stat.pid);
  const scanComplete = ambiguousUnreadableSameUidPids.length === 0;
  const treeEmpty = Boolean(
    !setupError
      && localIdentityMatches
      && scanComplete
      && leaderState === 'MISSING'
      && groupMembers.length === 0
      && tokenMembers.length === 0,
  );
  const signalSafe = Boolean(
    !setupError
      && localIdentityMatches
      && !targetsCurrentRuntime
      && leaderState !== 'MISMATCH'
      && groupMembers.length > 0
      && untrustedGroupMembers.length === 0,
  );
  const verifiable = Boolean(
    !setupError
      && localIdentityMatches
      && scanComplete
      && !targetsCurrentRuntime
      && untrustedGroupMembers.length === 0
      && escapedTokenMembers.length === 0
      && leaderState !== 'MISMATCH'
      && (groupMembers.length > 0 || treeEmpty),
  );

  let reason = setupError;
  if (!reason && !localIdentityMatches) reason = 'owner is not on this host boot/PID namespace';
  if (!reason && !scanComplete) reason = 'same-UID process environment scan is incomplete';
  if (!reason && targetsCurrentRuntime) reason = 'owner targets the current runtime group/session';
  if (!reason && leaderState === 'MISMATCH') reason = 'session leader identity does not match owner';
  if (!reason && untrustedGroupMembers.length > 0) reason = 'process group contains an untrusted member';
  if (!reason && escapedTokenMembers.length > 0) reason = 'execution has descendants outside the owned group/session';
  if (!reason && leaderState === 'MISSING' && !treeEmpty && !signalSafe) {
    reason = 'session leader is missing while process tree remains';
  }
  if (!reason && !signalSafe && !treeEmpty) reason = 'owned process group is not signal-safe';

  return {
    verifiable,
    empty: treeEmpty,
    leaderMatches: leaderState === 'MATCH',
    members: groupMembers.map(({ stat }) => ({
      pid: stat.pid,
      pgid: stat.pgid,
      sid: stat.sid,
      state: stat.state,
    })),
    escapedExecutionPids: escapedTokenMembers.map(({ stat }) => stat.pid),
    ...(reason ? { reason } : {}),
    owner,
    localIdentity,
    localIdentityMatches,
    leaderState,
    leader,
    groupMembers,
    tokenMembers,
    escapedTokenMembers,
    untrustedGroupMembers,
    unreadableSameUidPids: ambiguousUnreadableSameUidPids,
    scanComplete,
    treeEmpty,
    signalSafe,
  };
}

export async function waitForOwnedProcessTreeEmpty(
  owner: AttemptProcessOwnerDoc,
  options: WaitForOwnedProcessTreeEmptyOptions = {},
): Promise<WaitForOwnedProcessTreeEmptyResult> {
  const deadlineMs = options.deadlineAt instanceof Date
    ? options.deadlineAt.getTime()
    : options.deadlineAt;
  if (
    deadlineMs !== undefined
    && (!Number.isFinite(deadlineMs) || deadlineMs < 0)
  ) {
    throw new Error('process-tree deadline must be a valid timestamp');
  }
  const timeoutMs = deadlineMs === undefined
    ? options.timeoutMs ?? 1_000
    : Math.max(0, deadlineMs - Date.now());
  const pollIntervalMs = options.pollMs
    ?? options.pollIntervalMs
    ?? 20;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('process-tree wait timeout must be non-negative');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('process-tree poll interval must be positive');
  }
  const startedAt = performance.now();
  let inspection = await inspectOwnedProcessTree(owner);
  while (!inspection.treeEmpty) {
    const elapsed = performance.now() - startedAt;
    if (elapsed >= timeoutMs) break;
    await delay(
      Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsed)),
      undefined,
      options.signal ? { signal: options.signal } : undefined,
    );
    inspection = await inspectOwnedProcessTree(owner);
  }
  return {
    empty: inspection.treeEmpty,
    treeEmptyAt: inspection.treeEmpty ? new Date() : null,
    waitedMs: performance.now() - startedAt,
    inspection,
  };
}

/**
 * Signal only the exact, verified process group. There is intentionally no
 * leader-PID fallback: any mismatch leaves process truth unresolved.
 */
export async function signalOwnedProcessGroup(
  owner: AttemptProcessOwnerDoc,
  signal: NodeJS.Signals,
): Promise<SignalOwnedProcessGroupResult> {
  const inspection = await inspectOwnedProcessTree(owner);
  if (inspection.treeEmpty) {
    return {
      sent: false,
      alreadyEmpty: true,
      signaled: false,
      signal,
      inspection,
    };
  }
  if (!inspection.signalSafe) {
    return {
      sent: false,
      alreadyEmpty: false,
      signaled: false,
      signal,
      inspection,
      reason: inspection.reason ?? 'owned process group is not signal-safe',
    };
  }

  // Minimize the inspect→signal reuse window with a complete second snapshot.
  // The original leader may already be gone while verified group descendants
  // remain; authority then comes from their exact PGID/SID + execution tokens.
  const preflight = await inspectOwnedProcessTree(owner);
  if (preflight.treeEmpty) {
    return {
      sent: false,
      alreadyEmpty: true,
      signaled: false,
      signal,
      inspection: preflight,
    };
  }
  if (!preflight.signalSafe) {
    return {
      sent: false,
      alreadyEmpty: false,
      signaled: false,
      signal,
      inspection: preflight,
      reason: preflight.reason ?? 'owned process group changed before signal',
    };
  }

  try {
    process.kill(-owner.pgid, signal);
    return {
      sent: true,
      alreadyEmpty: false,
      signaled: true,
      signal,
      inspection: preflight,
    };
  } catch (error) {
    const refreshed = await inspectOwnedProcessTree(owner);
    return {
      sent: false,
      alreadyEmpty: refreshed.treeEmpty,
      signaled: false,
      signal,
      inspection: refreshed,
      ...(refreshed.treeEmpty
        ? {}
        : {
          reason: `${
            (error as NodeJS.ErrnoException).code ?? 'signal_error'
          }: ${(error as Error).message}`,
        }),
    };
  }
}
