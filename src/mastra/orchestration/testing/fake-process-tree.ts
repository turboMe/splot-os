/**
 * Owned fake child/grandchild process fixture for the G0 test-owned runtime
 * (§19.1 "fake process tworzący child i grandchild", §19.3 "proces z wnukiem i
 * kontrolowanym TERM/KILL").
 *
 * A single detached leader forks a child which forks a grandchild, so a suite
 * that needs a non-trivial, non-cooperative process tree gets an exact, owned
 * one instead of an ad-hoc spawn. Every member is bound to the run's execution
 * and runtime tokens and ignores SIGTERM, so teardown must prove ownership and
 * escalate to SIGKILL. Teardown is fail-closed and uses only owned-group,
 * token-verified signalling — never a bare-PID fallback — and it refuses a
 * leader whose exact identity it cannot re-observe.
 *
 * The reporter runs as loader-free plain JavaScript (`fake-process-tree-
 * reporter.mjs`, `execArgv: []`): a `--import tsx` child would make esbuild
 * spawn a service process into the owned group and break the exact three-member
 * invariant. This module reads every identity from `/proc` itself, so the
 * reporter only builds the fork chain and relays descendant PIDs.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  PROCESS_EXECUTION_ID_ENV,
  PROCESS_RUNTIME_RUN_ID_ENV,
  inspectOwnedProcessTree,
  readLinuxProcessIdentity,
  readLocalProcessHostIdentity,
  signalOwnedProcessGroup,
  waitForOwnedProcessTreeEmpty,
  type LinuxProcessIdentity,
  type OwnedProcessTreeInspection,
} from '../execution/linux-process-tree.js';
import { attemptProcessOwnerDocFromLinuxClaim } from './parent-runtime-resources.js';
import type { AttemptProcessOwnerDoc } from '../store/collections.js';

export const FAKE_PROCESS_TREE_EVIDENCE_VERSION =
  'g0-fake-process-tree-evidence/v1' as const;

const REPORTER_PATH = fileURLToPath(
  new URL('./fake-process-tree-reporter.mjs', import.meta.url),
);
const LEADER_MODE = '--fake-process-tree-leader';

const DEFAULT_IDENTITY_TIMEOUT_MS = 5_000;
const DEFAULT_TERM_GRACE_MS = 300;
const DEFAULT_KILL_TIMEOUT_MS = 3_000;

export interface FakeProcessTreeMemberIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  processStartToken: string;
}

export interface FakeProcessTreeHandle {
  /** The detached leader, an exact PID===PGID===SID group/session leader. */
  owner: AttemptProcessOwnerDoc;
  leader: FakeProcessTreeMemberIdentity;
  child: FakeProcessTreeMemberIdentity;
  grandchild: FakeProcessTreeMemberIdentity;
  leaderProcess: ChildProcess;
}

export const fakeProcessTreeEvidenceSchema = z.object({
  schemaVersion: z.literal(FAKE_PROCESS_TREE_EVIDENCE_VERSION),
  status: z.enum(['PASS', 'FAILED']),
  shapeVerified: z.boolean(),
  /** SIGTERM was delivered to the owned group and the tree stayed alive. */
  termIgnored: z.boolean(),
  /** SIGKILL emptied the exact owned tree. */
  killedEmpty: z.boolean(),
  childAbsent: z.boolean(),
  grandchildAbsent: z.boolean(),
  escapedTokenMembers: z.number().int().min(0),
  observedGroupMembers: z.number().int().min(0),
  signals: z.array(z.enum(['SIGTERM', 'SIGKILL'])),
  ownerLeaderPid: z.number().int().min(2),
  childPid: z.number().int().min(2),
  grandchildPid: z.number().int().min(2),
  reason: z.string().optional(),
});
export type FakeProcessTreeEvidence = z.infer<typeof fakeProcessTreeEvidenceSchema>;

export interface SpawnFakeProcessTreeInput {
  processExecutionId: string;
  runtimeRunId: string;
  workerInstanceId?: string;
  identityTimeoutMs?: number;
}

export interface TeardownFakeProcessTreeInput {
  termGraceMs?: number;
  killTimeoutMs?: number;
}

interface LeaderReport {
  childPid: number;
  grandchildPid: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMemberIdentity(identity: LinuxProcessIdentity): FakeProcessTreeMemberIdentity {
  return {
    pid: identity.pid,
    ppid: identity.ppid,
    pgid: identity.pgid,
    sid: identity.sid,
    processStartToken: identity.processStartToken,
  };
}

function positivePid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 2
    ? value
    : undefined;
}

async function readIdentityWithTimeout(
  pid: number,
  timeoutMs: number,
): Promise<LinuxProcessIdentity> {
  const deadline = Date.now() + timeoutMs;
  let identity = await readLinuxProcessIdentity(pid);
  while (!identity && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    identity = await readLinuxProcessIdentity(pid);
  }
  if (!identity) throw new Error('fake process-tree member identity never appeared');
  return identity;
}

function waitForLeaderReport(
  leader: ChildProcess,
  timeoutMs: number,
): Promise<LeaderReport> {
  return new Promise<LeaderReport>((resolveReport, rejectReport) => {
    let settled = false;
    const finish = (error?: Error, value?: LeaderReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      leader.off('message', onMessage);
      leader.off('error', onError);
      leader.off('exit', onExit);
      if (error) rejectReport(error);
      else resolveReport(value!);
    };
    const onMessage = (message: unknown) => {
      if (isRecord(message) && message.type === 'FAKE_TREE_FAILED') {
        finish(new Error(`fake tree reporter failed: ${String(message.stage ?? 'unknown')}`));
        return;
      }
      if (!isRecord(message) || message.type !== 'LEADER_READY') return;
      const childPid = positivePid(message.childPid);
      const grandchildPid = positivePid(message.grandchildPid);
      if (childPid === undefined || grandchildPid === undefined) {
        finish(new Error('fake tree leader reported an invalid descendant PID'));
        return;
      }
      finish(undefined, { childPid, grandchildPid });
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`fake tree leader exited before readiness (${code ?? signal ?? 'unknown'})`));
    const timer = setTimeout(() => finish(new Error('fake tree readiness timed out')), timeoutMs);
    leader.on('message', onMessage);
    leader.once('error', onError);
    leader.once('exit', onExit);
  });
}

/**
 * Spawn the exact leader → child → grandchild tree and bind it to a
 * PROCESS_GROUP owner. Rejects (after killing anything it started) unless every
 * member is present, correctly parented, and confined to the leader's group and
 * session.
 */
export async function spawnFakeProcessTree(
  input: SpawnFakeProcessTreeInput,
): Promise<FakeProcessTreeHandle> {
  if (process.platform !== 'linux') {
    throw new Error('fake process-tree fixture requires Linux');
  }
  if (!input.processExecutionId || !input.runtimeRunId) {
    throw new TypeError('fake process-tree requires execution and runtime tokens');
  }
  const identityTimeoutMs = input.identityTimeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
  const leaderProcess = fork(REPORTER_PATH, [LEADER_MODE], {
    detached: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      [PROCESS_EXECUTION_ID_ENV]: input.processExecutionId,
      [PROCESS_RUNTIME_RUN_ID_ENV]: input.runtimeRunId,
    },
  });
  const killLeaderGroup = () => {
    if (typeof leaderProcess.pid === 'number') {
      try { process.kill(-leaderProcess.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  };
  try {
    if (!leaderProcess.pid || leaderProcess.pid < 2) {
      throw new Error('fake process-tree leader did not receive a PID');
    }
    const leaderIdentity = await readIdentityWithTimeout(leaderProcess.pid, identityTimeoutMs);
    if (leaderIdentity.pid !== leaderIdentity.pgid || leaderIdentity.pid !== leaderIdentity.sid) {
      throw new Error('detached fake leader is not its exact group/session leader');
    }
    const local = await readLocalProcessHostIdentity();
    const boundAt = new Date();
    const owner = attemptProcessOwnerDocFromLinuxClaim({
      processExecutionId: input.processExecutionId,
      runtimeRunId: input.runtimeRunId,
      workerInstanceId: input.workerInstanceId ?? 'g0-fake-process-tree',
      ownerGeneration: 1,
      attemptFence: 1,
      localIdentity: local,
      processIdentity: leaderIdentity,
      registeredAt: boundAt,
      startedAt: boundAt,
    });
    const report = await waitForLeaderReport(leaderProcess, identityTimeoutMs);
    // Read the descendant identities from /proc ourselves rather than trusting a
    // reporter-computed token, then require exact parenting and confinement to
    // the leader's group and session — no member reparented or escaped early.
    const childIdentity = await readIdentityWithTimeout(report.childPid, identityTimeoutMs);
    const grandchildIdentity = await readIdentityWithTimeout(report.grandchildPid, identityTimeoutMs);
    if (childIdentity.ppid !== leaderIdentity.pid) {
      throw new Error('fake child is not parented by the leader');
    }
    if (grandchildIdentity.ppid !== childIdentity.pid) {
      throw new Error('fake grandchild is not parented by the child');
    }
    for (const member of [childIdentity, grandchildIdentity]) {
      if (member.pgid !== leaderIdentity.pid || member.sid !== leaderIdentity.pid) {
        throw new Error('fake tree member escaped the leader group/session');
      }
    }
    return {
      owner,
      leader: toMemberIdentity(leaderIdentity),
      child: toMemberIdentity(childIdentity),
      grandchild: toMemberIdentity(grandchildIdentity),
      leaderProcess,
    };
  } catch (error) {
    killLeaderGroup();
    throw error;
  }
}

function failedEvidence(
  handle: Pick<FakeProcessTreeHandle, 'owner' | 'child' | 'grandchild'>,
  reason: string,
  partial: Partial<FakeProcessTreeEvidence> = {},
): FakeProcessTreeEvidence {
  return fakeProcessTreeEvidenceSchema.parse({
    schemaVersion: FAKE_PROCESS_TREE_EVIDENCE_VERSION,
    status: 'FAILED',
    shapeVerified: false,
    termIgnored: false,
    killedEmpty: false,
    childAbsent: false,
    grandchildAbsent: false,
    escapedTokenMembers: 0,
    observedGroupMembers: 0,
    signals: [],
    ownerLeaderPid: handle.owner.pid,
    childPid: handle.child.pid,
    grandchildPid: handle.grandchild.pid,
    reason,
    ...partial,
  });
}

/**
 * Assert an inspection is exactly the owned leader + child + grandchild, all
 * carrying the owner tokens with nothing escaped. Returns the reason on failure.
 */
export function verifyFakeProcessTreeShape(
  inspection: OwnedProcessTreeInspection,
  handle: Pick<FakeProcessTreeHandle, 'child' | 'grandchild'>,
): string | null {
  if (!inspection.verifiable) return inspection.reason ?? 'tree inspection is not verifiable';
  if (inspection.leaderState !== 'MATCH') return `leader is ${inspection.leaderState}`;
  if (!inspection.localIdentityMatches) return 'local host identity does not match the owner';
  if (inspection.escapedTokenMembers.length > 0) return 'a token member escaped the owned group';
  const memberPids = new Set(inspection.groupMembers.map((entry) => entry.stat.pid));
  if (!memberPids.has(handle.child.pid)) return 'owned child is missing from the group';
  if (!memberPids.has(handle.grandchild.pid)) return 'owned grandchild is missing from the group';
  if (inspection.groupMembers.length !== 3) {
    return `owned group holds ${inspection.groupMembers.length} members, expected exactly 3`;
  }
  return null;
}

/**
 * Fail-closed teardown: prove the exact tree, deliver SIGTERM (ignored by the
 * non-cooperative members), then SIGKILL the owned group and prove the exact
 * tree empty. Only owned-group, token-verified signalling is used.
 */
export async function teardownFakeProcessTree(
  handle: FakeProcessTreeHandle,
  input: TeardownFakeProcessTreeInput = {},
): Promise<FakeProcessTreeEvidence> {
  const termGraceMs = input.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killTimeoutMs = input.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];

  const initial = await inspectOwnedProcessTree(handle.owner);
  const shapeReason = verifyFakeProcessTreeShape(initial, handle);
  if (shapeReason) return failedEvidence(handle, shapeReason);
  if (!initial.signalSafe) {
    return failedEvidence(handle, 'owned tree is not safe to signal', {
      shapeVerified: true,
      observedGroupMembers: initial.groupMembers.length,
    });
  }

  const term = await signalOwnedProcessGroup(handle.owner, 'SIGTERM');
  if (!term.sent && !term.alreadyEmpty) {
    return failedEvidence(handle, term.reason ?? 'SIGTERM was refused for the owned group', {
      shapeVerified: true,
      observedGroupMembers: initial.groupMembers.length,
    });
  }
  signals.push('SIGTERM');
  // The members ignore SIGTERM, so a brief wait must NOT empty the tree.
  const afterTerm = await waitForOwnedProcessTreeEmpty(handle.owner, {
    timeoutMs: termGraceMs,
    pollMs: 10,
  });
  const termIgnored = !afterTerm.empty;

  const kill = await signalOwnedProcessGroup(handle.owner, 'SIGKILL');
  if (!kill.sent && !kill.alreadyEmpty) {
    return failedEvidence(handle, kill.reason ?? 'SIGKILL was refused for the owned group', {
      shapeVerified: true,
      termIgnored,
      signals,
      observedGroupMembers: initial.groupMembers.length,
    });
  }
  signals.push('SIGKILL');
  const afterKill = await waitForOwnedProcessTreeEmpty(handle.owner, {
    timeoutMs: killTimeoutMs,
    pollMs: 10,
  });
  const finalInspection = afterKill.inspection;
  const remainingPids = new Set(finalInspection.groupMembers.map((entry) => entry.stat.pid));
  const childAbsent = !remainingPids.has(handle.child.pid);
  const grandchildAbsent = !remainingPids.has(handle.grandchild.pid);
  const status: 'PASS' | 'FAILED' =
    afterKill.empty
    && finalInspection.treeEmpty
    && finalInspection.tokenMembers.length === 0
    && finalInspection.escapedTokenMembers.length === 0
    && childAbsent
    && grandchildAbsent
      ? 'PASS'
      : 'FAILED';

  return fakeProcessTreeEvidenceSchema.parse({
    schemaVersion: FAKE_PROCESS_TREE_EVIDENCE_VERSION,
    status,
    shapeVerified: true,
    termIgnored,
    killedEmpty: afterKill.empty && finalInspection.treeEmpty,
    childAbsent,
    grandchildAbsent,
    escapedTokenMembers: finalInspection.escapedTokenMembers.length,
    observedGroupMembers: initial.groupMembers.length,
    signals,
    ownerLeaderPid: handle.owner.pid,
    childPid: handle.child.pid,
    grandchildPid: handle.grandchild.pid,
    ...(status === 'PASS' ? {} : { reason: finalInspection.reason ?? 'owned tree did not become empty' }),
  });
}
