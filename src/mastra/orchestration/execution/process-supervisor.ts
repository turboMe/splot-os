/**
 * Linux PROCESS_SUPERVISOR_V1.
 *
 * The supervisor owns OS-process truth only. It launches an inert wrapper in a
 * fresh session/process group, persists the exact owner through the attempt
 * operation CAS, performs a second workload-release CAS, and only then sends
 * START over IPC. Stop acknowledgement is written only after `/proc` proves the
 * complete execution scope empty.
 *
 * This first production slice deliberately supports trusted, non-daemonizing
 * subprocesses on the same Linux host. An inherited execution token detects a
 * descendant that escaped the process group; without a writable cgroup such an
 * escape is fail-closed and cannot produce a receipt.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Db, Filter, MongoClient } from 'mongodb';
import {
  authorizeAttemptProcessRelease,
  startAttemptOperation,
  type AttemptProcessOwnerRegistration,
} from '../store/attempts.js';
import {
  observeAttemptStopRequest,
  recordAttemptStopReceipt,
  requestAttemptStop,
} from '../store/attempt-stop.js';
import {
  attemptProcessOwnerFilter,
  recordAttemptProcessExitReceipt,
  recordAttemptProcessSignalStage,
  recordPostStopUnknownProcessExitReceipt,
  sameAttemptProcessOwner,
} from '../store/process-supervision.js';
import {
  COLLECTIONS,
  type AttemptDoc,
  type AttemptProcessOwnerDoc,
  type JobDoc,
} from '../store/collections.js';
import {
  inspectOwnedProcessTree,
  readLinuxProcessIdentity,
  readLocalProcessHostIdentity,
  signalOwnedProcessGroup,
  waitForOwnedProcessTreeEmpty,
  type OwnedProcessTreeInspection,
} from './linux-process-tree.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_WRAPPER_HARD_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_STOP_POLL_MS = 20;
const DEFAULT_ABORT_GRACE_MS = 150;
const DEFAULT_TERM_GRACE_MS = 500;
const DEFAULT_KILL_CONFIRM_MS = 1_000;
const DEFAULT_RECOVERY_STOP_GRACE_MS = 3_000;
const PROCESS_RECONCILE_BASE_MS = 1_000;
const PROCESS_RECONCILE_CAP_MS = 60_000;

/**
 * The target specification is data, not a closure. `shell:false` is mandatory;
 * capability adapters decide which executable/arguments are admitted.
 */
export interface SupervisedProcessSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
}

export interface SupervisedProcessCompletion {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  targetPid: number | null;
  observedAt: Date;
}

export interface PrepareSupervisedProcessInput {
  workerInstanceId: string;
  ownerGeneration?: number;
  processExecutionId?: string;
  runtimeRunId?: string;
  startupTimeoutMs?: number;
  wrapperHardTtlMs?: number;
}

export interface StartSupervisedProcessInput {
  client: MongoClient;
  db: Db;
  attemptId: string;
  leaseOwner: string;
  attemptFence: number;
  spec: SupervisedProcessSpec;
  /**
   * Deterministic coordination seam for the register→release race proof.
   * It runs while the wrapper is still inert and must never start business work.
   */
  beforeWorkloadRelease?: (processOwner: AttemptProcessOwnerDoc) => Promise<void>;
}

export interface StartSupervisedProcessResult {
  released: boolean;
  workloadStarted: boolean;
  processOwner: AttemptProcessOwnerDoc | null;
}

export interface StopSupervisedAttemptInput {
  attemptId: string;
  processOwner: AttemptProcessOwnerDoc;
  handle?: SupervisedProcessHandle;
  abortGraceMs?: number;
  termGraceMs?: number;
  killConfirmMs?: number;
  pollMs?: number;
}

export interface StopSupervisedAttemptResult {
  authorityObserved: boolean;
  processTreeEmpty: boolean;
  signal: string | null;
  receiptRecorded: boolean;
  receiptDeduped: boolean;
}

export interface ReconcileSupervisedProcessesOptions {
  limit?: number;
  stopGraceMs?: number;
  abortGraceMs?: number;
  termGraceMs?: number;
  killConfirmMs?: number;
  pollMs?: number;
}

export interface ReconcileSupervisedProcessesResult {
  scanned: number;
  stopRequested: number;
  stopped: number;
  normalExitReceipts: number;
  unverifiable: number;
}

type WrapperMessage =
  | { type: 'READY' }
  | { type: 'TARGET_STARTED'; pid: number }
  | {
      type: 'RESULT';
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
      targetPid: number | null;
    }
  | { type: 'WRAPPER_ERROR'; message: string }
  | { type: 'TARGET_MESSAGE'; message: unknown };

const WRAPPER_BOOTSTRAP = String.raw`
const { spawn } = require('node:child_process');

const startupTimeoutMs = Math.max(100, Number(process.env.ORCH_WRAPPER_STARTUP_TIMEOUT_MS || 5000));
const hardTtlMs = Math.max(startupTimeoutMs, Number(process.env.ORCH_WRAPPER_HARD_TTL_MS || 600000));
let target = null;
let started = false;
let stopRequested = false;
let finalizeRequested = false;
let resultSent = false;
let targetPid = null;
let stdout = [];
let stderr = [];
let stdoutBytes = 0;
let stderrBytes = 0;
let truncated = false;
let maxOutputBytes = 262144;

function send(message) {
  if (typeof process.send === 'function' && process.connected) {
    try { process.send(message); } catch {}
  }
}

function append(chunks, chunk, currentBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = Math.max(0, maxOutputBytes - currentBytes);
  if (remaining <= 0) {
    truncated = true;
    return currentBytes;
  }
  if (buffer.length > remaining) {
    chunks.push(buffer.subarray(0, remaining));
    truncated = true;
    return maxOutputBytes;
  }
  chunks.push(buffer);
  return currentBytes + buffer.length;
}

function exitWrapper(code) {
  try { if (process.connected) process.disconnect(); } catch {}
  setImmediate(() => process.exit(code));
}

function finishTarget(exitCode, signal, errorMessage) {
  if (resultSent) return;
  resultSent = true;
  if (errorMessage) {
    stderrBytes = append(stderr, Buffer.from(errorMessage), stderrBytes);
  }
  send({
    type: 'RESULT',
    exitCode,
    signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    truncated,
    targetPid,
  });
  if (stopRequested || finalizeRequested || !process.connected) {
    exitWrapper(exitCode === null ? 70 : 0);
  }
}

function validSpec(spec) {
  return spec
    && typeof spec === 'object'
    && typeof spec.command === 'string'
    && spec.command.length > 0
    && (spec.args === undefined || (
      Array.isArray(spec.args)
      && spec.args.every((arg) => typeof arg === 'string')
    ))
    && (spec.cwd === undefined || typeof spec.cwd === 'string')
    && (spec.env === undefined || (
      spec.env
      && typeof spec.env === 'object'
      && Object.values(spec.env).every((value) => typeof value === 'string')
    ));
}

function startTarget(spec) {
  if (started || !validSpec(spec)) {
    send({ type: 'WRAPPER_ERROR', message: started ? 'duplicate START' : 'invalid process spec' });
    if (!started) exitWrapper(64);
    return;
  }
  started = true;
  clearTimeout(startupTimer);
  maxOutputBytes = Math.max(1024, Math.min(1048576, Number(spec.maxOutputBytes || 262144)));
  const protectedEnv = {
    ORCH_PROCESS_EXECUTION_ID: process.env.ORCH_PROCESS_EXECUTION_ID,
    ORCH_RUNTIME_RUN_ID: process.env.ORCH_RUNTIME_RUN_ID,
  };
  try {
    target = spawn(spec.command, spec.args || [], {
      cwd: spec.cwd,
      detached: false,
      shell: false,
      env: { ...process.env, ...(spec.env || {}), ...protectedEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    targetPid = target.pid || null;
    send({ type: 'TARGET_STARTED', pid: targetPid });
    target.stdout.on('data', (chunk) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    target.stderr.on('data', (chunk) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });
    target.on('message', (message) => send({ type: 'TARGET_MESSAGE', message }));
    target.once('error', (error) => finishTarget(null, null, String(error && error.message || error)));
    target.once('close', (code, signal) => finishTarget(code, signal, null));
  } catch (error) {
    finishTarget(null, null, String(error && error.message || error));
  }
}

const startupTimer = setTimeout(() => exitWrapper(72), startupTimeoutMs);
const hardTimer = setTimeout(() => {
  // A local wall-clock timer is not durable stop authority. Escalation is
  // performed only by the external supervisor after it has persisted and
  // re-observed the exact attempt/fence/owner/stop generation.
  send({
    type: 'WRAPPER_ERROR',
    message: 'wrapper hard TTL elapsed; durable supervisor stop required',
  });
  if (!started) exitWrapper(75);
}, hardTtlMs);
hardTimer.unref();

// The wrapper remains alive while its target handles group TERM, then exits as
// soon as that target closes. A TERM-ignoring target keeps the wrapper/group
// present so the external supervisor can safely escalate to SIGKILL.
process.on('SIGTERM', () => {
  stopRequested = true;
  if (!target) exitWrapper(0);
});
process.on('SIGINT', () => {});
process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'START') {
    startTarget(message.spec);
    return;
  }
  if (message.type === 'ABORT') {
    stopRequested = true;
    if (target && target.connected) {
      try { target.send({ type: 'ABORT' }); } catch {}
    } else if (!target) {
      exitWrapper(0);
    }
    return;
  }
  if (message.type === 'FINALIZE') {
    finalizeRequested = true;
    if (resultSent || !target) exitWrapper(0);
  }
});
process.on('disconnect', () => {
  if (!started) exitWrapper(73);
});
send({ type: 'READY' });
`;

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function validateProcessSpec(spec: SupervisedProcessSpec): void {
  if (!spec.command) throw new Error('supervised process command must be non-empty');
  if (spec.args && !spec.args.every((value) => typeof value === 'string')) {
    throw new Error('supervised process args must be strings');
  }
  if (
    spec.env
    && Object.values(spec.env).some((value) => typeof value !== 'string')
  ) {
    throw new Error('supervised process env values must be strings');
  }
  if (
    spec.maxOutputBytes !== undefined
    && (
      !Number.isInteger(spec.maxOutputBytes)
      || spec.maxOutputBytes < 1_024
      || spec.maxOutputBytes > 1024 * 1024
    )
  ) {
    throw new Error('supervised process maxOutputBytes must be within 1KiB..1MiB');
  }
}

function sendIpc(child: ChildProcess, message: object): Promise<boolean> {
  if (!child.connected) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      child.send(message, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clampedDeadline(now: number, requestedMs: number, hardAt: Date): Date {
  return new Date(Math.min(now + Math.max(0, requestedMs), hardAt.getTime()));
}

function isWrapperMessage(value: unknown): value is WrapperMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string';
}

export class SupervisedProcessHandle {
  readonly registration: AttemptProcessOwnerRegistration;
  readonly completion: Promise<SupervisedProcessCompletion>;
  readonly wrapperPid: number;

  private persistedOwner: AttemptProcessOwnerDoc | null = null;
  private workloadReleaseAuthorized = false;
  private startDeliveryAttempted = false;
  private workloadStarted = false;
  private result: SupervisedProcessCompletion | null = null;
  private wrapperClosed = false;
  private readonly wrapperClose: Promise<void>;

  constructor(
    private readonly child: ChildProcess,
    registration: AttemptProcessOwnerRegistration,
    completion: Promise<SupervisedProcessCompletion>,
    wrapperClose: Promise<void>,
  ) {
    this.registration = registration;
    const trackedCompletion = completion.then((result) => {
      this.result = result;
      return result;
    });
    void trackedCompletion.catch(() => {});
    this.completion = trackedCompletion;
    this.wrapperClose = wrapperClose.then(() => {
      this.wrapperClosed = true;
    });
    this.wrapperPid = registration.pid;
  }

  get processOwner(): AttemptProcessOwnerDoc | null {
    return this.persistedOwner;
  }

  get observedCompletion(): SupervisedProcessCompletion | null {
    return this.result;
  }

  async start(
    input: StartSupervisedProcessInput,
  ): Promise<StartSupervisedProcessResult> {
    validateProcessSpec(input.spec);
    if (
      input.leaseOwner !== this.registration.workerInstanceId
      || input.attemptFence < 0
    ) {
      return { released: false, workloadStarted: false, processOwner: null };
    }
    const registered = await startAttemptOperation(input.client, input.db, {
      attemptId: input.attemptId,
      leaseOwner: input.leaseOwner,
      attemptFence: input.attemptFence,
      processOwner: this.registration,
    });
    if (!registered) {
      return { released: false, workloadStarted: false, processOwner: null };
    }
    const attempt = await input.db.collection<AttemptDoc>(COLLECTIONS.attempts)
      .findOne({
        _id: input.attemptId,
        lifecycle: 'RUNNING',
        leaseOwner: input.leaseOwner,
        attemptFence: input.attemptFence,
        'processOwner.processExecutionId':
          this.registration.processExecutionId,
      });
    const owner = attempt?.processOwner ?? null;
    this.persistedOwner = owner;
    if (!owner) {
      return { released: false, workloadStarted: false, processOwner: null };
    }
    await input.beforeWorkloadRelease?.(owner);
    const release = await authorizeAttemptProcessRelease(input.client, input.db, {
      attemptId: input.attemptId,
      leaseOwner: input.leaseOwner,
      attemptFence: input.attemptFence,
      processOwner: owner,
    });
    if (!release) {
      return { released: false, workloadStarted: false, processOwner: owner };
    }
    this.workloadReleaseAuthorized = true;
    // A stop committed after release remains authoritative; avoiding START here
    // narrows that race, while a stop immediately after this read is handled by
    // the regular targeted observation/escalation path.
    const stop = await observeAttemptStopRequest(input.db, {
      attemptId: input.attemptId,
      processOwner: owner,
    });
    if (stop) {
      return { released: true, workloadStarted: false, processOwner: owner };
    }
    this.startDeliveryAttempted = true;
    const sent = await sendIpc(this.child, { type: 'START', spec: input.spec });
    this.workloadStarted = sent;
    return {
      released: true,
      workloadStarted: sent,
      processOwner: owner,
    };
  }

  async cooperativeAbort(): Promise<boolean> {
    return sendIpc(this.child, { type: 'ABORT' });
  }

  async finalize(): Promise<boolean> {
    return sendIpc(this.child, { type: 'FINALIZE' });
  }

  /**
   * Cleanup is intentionally conservative after START: it finalizes/reaps a
   * completed wrapper but never invents signal authority. Active business work
   * is signalled only by `stopSupervisedAttempt`.
   */
  async cleanup(): Promise<void> {
    if (this.wrapperClosed) return;
    if (!this.workloadReleaseAuthorized || !this.startDeliveryAttempted) {
      // START was definitely never attempted. The wrapper is inert, so only
      // its ChildProcess handle may be closed without durable stop authority.
      await this.cooperativeAbort();
      await this.finalize();
      if (!this.wrapperClosed) {
        try { this.child.kill('SIGKILL'); } catch {}
      }
    } else if (!this.workloadStarted) {
      // A failed IPC callback after the release CAS is ambiguous: START may
      // already have reached the wrapper. Never signal from cleanup; the caller
      // must persist a stop epoch and recovery will finish it if the caller dies.
    } else if (this.result) {
      await this.finalize();
    }
    await Promise.race([this.wrapperClose, delay(500)]);
  }

  async close(): Promise<void> {
    await this.cleanup();
  }
}

export async function prepareSupervisedProcess(
  input: PrepareSupervisedProcessInput,
): Promise<SupervisedProcessHandle> {
  if (process.platform !== 'linux') {
    throw new Error('PROCESS_GROUP supervision currently requires Linux');
  }
  if (!input.workerInstanceId) {
    throw new Error('workerInstanceId must be non-empty');
  }
  const ownerGeneration = positiveInteger(
    input.ownerGeneration,
    1,
    'process owner generation',
  );
  const startupTimeoutMs = positiveInteger(
    input.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    'wrapper startup timeout',
  );
  const wrapperHardTtlMs = positiveInteger(
    input.wrapperHardTtlMs,
    DEFAULT_WRAPPER_HARD_TTL_MS,
    'wrapper hard TTL',
  );
  if (wrapperHardTtlMs <= startupTimeoutMs) {
    throw new Error('wrapper hard TTL must exceed startup timeout');
  }

  const local = await readLocalProcessHostIdentity();
  const processExecutionId =
    input.processExecutionId ?? `pex_${randomUUID()}`;
  const runtimeRunId = input.runtimeRunId ?? `run_${randomUUID()}`;
  const child = spawn(
    process.execPath,
    ['-e', WRAPPER_BOOTSTRAP],
    {
      detached: true,
      shell: false,
      env: {
        ...process.env,
        ORCH_PROCESS_EXECUTION_ID: processExecutionId,
        ORCH_RUNTIME_RUN_ID: runtimeRunId,
        ORCH_WRAPPER_STARTUP_TIMEOUT_MS: String(startupTimeoutMs),
        ORCH_WRAPPER_HARD_TTL_MS: String(wrapperHardTtlMs),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  if (!child.pid) throw new Error('supervised wrapper did not receive a PID');

  let resolveCompletion!: (value: SupervisedProcessCompletion) => void;
  let rejectCompletion!: (reason: Error) => void;
  const completion = new Promise<SupervisedProcessCompletion>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A caller may intentionally exercise only the inert launch half. Avoid an
  // unhandled rejection if that wrapper is then cleaned before START.
  void completion.catch(() => {});

  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resultReceived = false;
  let targetPid: number | null = null;
  child.on('message', (message: unknown) => {
    if (!isWrapperMessage(message)) return;
    if (message.type === 'READY') {
      resolveReady();
      return;
    }
    if (message.type === 'TARGET_STARTED') {
      targetPid = message.pid;
      return;
    }
    if (message.type === 'RESULT') {
      resultReceived = true;
      resolveCompletion({
        exitCode: message.exitCode,
        signal: message.signal,
        stdout: message.stdout,
        stderr: message.stderr,
        truncated: message.truncated,
        targetPid: message.targetPid ?? targetPid,
        observedAt: new Date(),
      });
      return;
    }
    if (message.type === 'WRAPPER_ERROR') {
      rejectCompletion(new Error(message.message));
    }
  });
  child.once('error', (error) => {
    rejectReady(error);
    if (!resultReceived) rejectCompletion(error);
  });
  const wrapperClose = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      if (!resultReceived) {
        rejectCompletion(new Error(
          `supervised wrapper exited before target result (code=${code}, signal=${signal})`,
        ));
      }
      resolve();
    });
  });

  const startupTimer = setTimeout(
    () => rejectReady(new Error('supervised wrapper READY timeout')),
    startupTimeoutMs,
  );
  try {
    await ready;
  } catch (error) {
    // START has not been sent, so killing only the ChildProcess handle cannot
    // terminate business work or an unrelated reused process group.
    try { child.kill('SIGKILL'); } catch {}
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }

  let identity = await readLinuxProcessIdentity(child.pid);
  for (let retries = 0; !identity && retries < 20; retries++) {
    await delay(5);
    identity = await readLinuxProcessIdentity(child.pid);
  }
  if (
    !identity
    || identity.pid !== child.pid
    || identity.pgid !== child.pid
    || identity.sid !== child.pid
    || identity.pidNamespaceId !== local.pidNamespaceId
  ) {
    // The wrapper is still inert here; never use an unverified negative PGID.
    try { child.kill('SIGKILL'); } catch {}
    throw new Error('wrapper did not enter the expected isolated PID/PGID/SID scope');
  }

  const registration: AttemptProcessOwnerRegistration = {
    processExecutionId,
    runtimeRunId,
    workerInstanceId: input.workerInstanceId,
    ownerGeneration,
    mode: 'PROCESS_GROUP',
    hostId: local.hostId,
    hostBootId: local.hostBootId,
    pidNamespaceId: local.pidNamespaceId,
    pid: identity.pid,
    pgid: identity.pgid,
    sid: identity.sid,
    processStartToken: identity.processStartToken,
  };
  return new SupervisedProcessHandle(
    child,
    registration,
    completion,
    wrapperClose,
  );
}

async function recordTreeEmptyStopReceipt(
  client: MongoClient,
  db: Db,
  input: StopSupervisedAttemptInput,
  observedAt: Date,
  treeEmptyAt: Date,
  signal: string | null,
): Promise<StopSupervisedAttemptResult> {
  const request = await observeAttemptStopRequest(db, {
    attemptId: input.attemptId,
    processOwner: input.processOwner,
  });
  if (!request) {
    return {
      authorityObserved: false,
      processTreeEmpty: true,
      signal,
      receiptRecorded: false,
      receiptDeduped: false,
    };
  }
  const completion = input.handle?.observedCompletion ?? null;
  const receipt = await recordAttemptStopReceipt(client, db, {
    attemptId: input.attemptId,
    stopGeneration: request.stopGeneration,
    attemptFence: request.attemptFence,
    processOwner: input.processOwner,
    receiptId: [
      'process-stop',
      input.processOwner.processExecutionId,
      request.stopGeneration,
    ].join(':'),
    terminationConfirmed: true,
    processTreeEmpty: true,
    exitCode: completion?.exitCode ?? null,
    signal: signal ?? completion?.signal ?? null,
    observedAt,
    treeEmptyAt,
  });
  return {
    authorityObserved: true,
    processTreeEmpty: true,
    signal,
    receiptRecorded: receipt?.recorded ?? false,
    receiptDeduped: receipt?.deduped ?? false,
  };
}

async function waitWithinStopGrace(
  owner: AttemptProcessOwnerDoc,
  stopDueAt: Date,
  requestedMs: number,
  pollMs: number,
): Promise<{ empty: boolean; treeEmptyAt: Date | null }> {
  const deadlineAt = clampedDeadline(Date.now(), requestedMs, stopDueAt);
  const result = await waitForOwnedProcessTreeEmpty(owner, {
    deadlineAt,
    pollMs,
  });
  return { empty: result.empty, treeEmptyAt: result.treeEmptyAt };
}

/**
 * Observe exact durable stop authority before every signal. Signal helpers then
 * repeat the OS owner check, so a stale fence/owner or PID reuse sends nothing.
 */
export async function stopSupervisedAttempt(
  client: MongoClient,
  db: Db,
  input: StopSupervisedAttemptInput,
): Promise<StopSupervisedAttemptResult> {
  const pollMs = positiveInteger(input.pollMs, DEFAULT_STOP_POLL_MS, 'stop poll');
  const abortGraceMs = positiveInteger(
    input.abortGraceMs,
    DEFAULT_ABORT_GRACE_MS,
    'abort grace',
  );
  const termGraceMs = positiveInteger(
    input.termGraceMs,
    DEFAULT_TERM_GRACE_MS,
    'TERM grace',
  );
  const killConfirmMs = positiveInteger(
    input.killConfirmMs,
    DEFAULT_KILL_CONFIRM_MS,
    'KILL confirmation',
  );
  const observedAt = new Date();
  let request = await observeAttemptStopRequest(db, {
    attemptId: input.attemptId,
    processOwner: input.processOwner,
  });
  if (!request) {
    return {
      authorityObserved: false,
      processTreeEmpty: false,
      signal: null,
      receiptRecorded: false,
      receiptDeduped: false,
    };
  }
  await recordAttemptProcessSignalStage(client, db, {
    attemptId: input.attemptId,
    attemptFence: request.attemptFence,
    stopGeneration: request.stopGeneration,
    processOwner: input.processOwner,
    stage: 'OBSERVED',
  });

  let inspection = await inspectOwnedProcessTree(input.processOwner);
  if (inspection.verifiable && inspection.empty) {
    return recordTreeEmptyStopReceipt(
      client,
      db,
      input,
      observedAt,
      new Date(),
      null,
    );
  }
  if (!inspection.verifiable && !inspection.signalSafe) {
    return {
      authorityObserved: true,
      processTreeEmpty: false,
      signal: null,
      receiptRecorded: false,
      receiptDeduped: false,
    };
  }

  if (input.handle) {
    // Re-read authority immediately before the IPC abort just as for POSIX
    // signals. The handle is accepted only for this exact persisted owner.
    request = await observeAttemptStopRequest(db, {
      attemptId: input.attemptId,
      processOwner: input.processOwner,
    });
    if (
      !request
      || !sameAttemptProcessOwner(
        input.handle.processOwner,
        input.processOwner,
      )
    ) {
      return {
        authorityObserved: false,
        processTreeEmpty: false,
        signal: null,
        receiptRecorded: false,
        receiptDeduped: false,
      };
    }
    if (await input.handle.cooperativeAbort()) {
      await recordAttemptProcessSignalStage(client, db, {
        attemptId: input.attemptId,
        attemptFence: request.attemptFence,
        stopGeneration: request.stopGeneration,
        processOwner: input.processOwner,
        stage: 'ABORT_SENT',
      });
      const waited = await waitWithinStopGrace(
        input.processOwner,
        request.attemptStopGraceDueAt,
        abortGraceMs,
        pollMs,
      );
      if (waited.empty && waited.treeEmptyAt) {
        return recordTreeEmptyStopReceipt(
          client,
          db,
          input,
          observedAt,
          waited.treeEmptyAt,
          null,
        );
      }
    }
  }

  request = await observeAttemptStopRequest(db, {
    attemptId: input.attemptId,
    processOwner: input.processOwner,
  });
  if (!request) {
    return {
      authorityObserved: false,
      processTreeEmpty: false,
      signal: null,
      receiptRecorded: false,
      receiptDeduped: false,
    };
  }
  const term = await signalOwnedProcessGroup(input.processOwner, 'SIGTERM');
  if (term.alreadyEmpty) {
    return recordTreeEmptyStopReceipt(
      client,
      db,
      input,
      observedAt,
      new Date(),
      null,
    );
  }
  if (!term.sent) {
    return {
      authorityObserved: true,
      processTreeEmpty: false,
      signal: null,
      receiptRecorded: false,
      receiptDeduped: false,
    };
  }
  await recordAttemptProcessSignalStage(client, db, {
    attemptId: input.attemptId,
    attemptFence: request.attemptFence,
    stopGeneration: request.stopGeneration,
    processOwner: input.processOwner,
    stage: 'TERM_SENT',
  });
  let waited = await waitWithinStopGrace(
    input.processOwner,
    request.attemptStopGraceDueAt,
    termGraceMs,
    pollMs,
  );
  if (waited.empty && waited.treeEmptyAt) {
    return recordTreeEmptyStopReceipt(
      client,
      db,
      input,
      observedAt,
      waited.treeEmptyAt,
      'SIGTERM',
    );
  }

  request = await observeAttemptStopRequest(db, {
    attemptId: input.attemptId,
    processOwner: input.processOwner,
  });
  if (!request) {
    return {
      authorityObserved: false,
      processTreeEmpty: false,
      signal: 'SIGTERM',
      receiptRecorded: false,
      receiptDeduped: false,
    };
  }
  const killed = await signalOwnedProcessGroup(input.processOwner, 'SIGKILL');
  if (killed.alreadyEmpty) {
    return recordTreeEmptyStopReceipt(
      client,
      db,
      input,
      observedAt,
      new Date(),
      'SIGTERM',
    );
  }
  if (!killed.sent) {
    return {
      authorityObserved: true,
      processTreeEmpty: false,
      signal: 'SIGTERM',
      receiptRecorded: false,
      receiptDeduped: false,
    };
  }
  await recordAttemptProcessSignalStage(client, db, {
    attemptId: input.attemptId,
    attemptFence: request.attemptFence,
    stopGeneration: request.stopGeneration,
    processOwner: input.processOwner,
    stage: 'KILL_SENT',
  });
  waited = await waitWithinStopGrace(
    input.processOwner,
    request.attemptStopGraceDueAt,
    killConfirmMs,
    pollMs,
  );
  if (waited.empty && waited.treeEmptyAt) {
    return recordTreeEmptyStopReceipt(
      client,
      db,
      input,
      observedAt,
      waited.treeEmptyAt,
      'SIGKILL',
    );
  }
  return {
    authorityObserved: true,
    processTreeEmpty: false,
    signal: 'SIGKILL',
    receiptRecorded: false,
    receiptDeduped: false,
  };
}

async function recordNormalTreeEmpty(
  client: MongoClient,
  db: Db,
  attempt: AttemptDoc,
  treeEmptyAt: Date,
): Promise<boolean> {
  const owner = attempt.processOwner;
  if (!owner) return false;
  // A stop-grace UNKNOWN increments the attempt fence but retains the exact old
  // owner. Its late tree-empty proof closes liveness only; business UNKNOWN is
  // immutable and the terminal reducer can only observe, never upgrade it.
  if (
    attempt.lifecycle === 'FINISHED'
    && attempt.outcome === 'UNKNOWN_OUTCOME'
    && attempt.processState === 'UNKNOWN'
    && attempt.terminationConfirmed === false
    && attempt.attemptFence === owner.attemptFence + 1
    && (attempt.stopGeneration ?? 0) > 0
    && attempt.stopReceipt === null
  ) {
    const result = await recordPostStopUnknownProcessExitReceipt(client, db, {
      attemptId: attempt._id,
      attemptFence: owner.attemptFence,
      stopGeneration: attempt.stopGeneration!,
      processOwner: owner,
      receiptId: [
        'post-stop-process-exit',
        owner.processExecutionId,
        owner.ownerGeneration,
        attempt.stopGeneration,
      ].join(':'),
      terminationConfirmed: true,
      processTreeEmpty: true,
      exitCode: null,
      signal: null,
      observedAt: treeEmptyAt,
      treeEmptyAt,
    });
    return Boolean(result?.recorded);
  }
  if (
    owner.attemptFence !== attempt.attemptFence
    || (attempt.stopGeneration ?? 0) !== 0
    || attempt.stopReceipt !== null
  ) return false;
  const result = await recordAttemptProcessExitReceipt(client, db, {
    attemptId: attempt._id,
    attemptFence: attempt.attemptFence,
    processOwner: owner,
    receiptId: [
      'process-exit',
      owner.processExecutionId,
      owner.ownerGeneration,
    ].join(':'),
    terminationConfirmed: true,
    processTreeEmpty: true,
    exitCode: null,
    signal: null,
    observedAt: treeEmptyAt,
    treeEmptyAt,
  });
  return Boolean(result?.recorded);
}

async function scheduleFinishedProcessProbe(
  db: Db,
  attempt: AttemptDoc,
): Promise<void> {
  const owner = attempt.processOwner;
  if (!owner) return;
  const probeAttempt = Math.max(0, attempt.processReconcileProbeAttempt ?? 0);
  const delayMs = Math.min(
    PROCESS_RECONCILE_CAP_MS,
    PROCESS_RECONCILE_BASE_MS * 2 ** Math.min(probeAttempt, 6),
  );
  await db.collection<AttemptDoc>(COLLECTIONS.attempts).updateOne(
    {
      _id: attempt._id,
      lifecycle: 'FINISHED',
      attemptFence: attempt.attemptFence,
      terminationConfirmed: { $ne: true },
      ...attemptProcessOwnerFilter(owner),
    } as unknown as Filter<AttemptDoc>,
    [{
      $set: {
        processReconcileNextAt: {
          $dateAdd: {
            startDate: '$$NOW',
            unit: 'millisecond',
            amount: delayMs,
          },
        },
        processReconcileProbeAttempt: { $add: [probeAttempt, 1] },
      },
    }],
  );
}

/**
 * At-least-once startup/tick recovery. It intentionally precedes the generic
 * lease reaper. An expired RUNNING owner with a live tree is first moved through
 * a durable `lease_lost` stop epoch, preserving signal/receipt authority.
 */
export async function reconcileSupervisedProcesses(
  client: MongoClient,
  db: Db,
  opts: ReconcileSupervisedProcessesOptions = {},
): Promise<ReconcileSupervisedProcessesResult> {
  const limit = positiveInteger(opts.limit, 128, 'supervisor scan limit');
  const stopGraceMs = positiveInteger(
    opts.stopGraceMs,
    DEFAULT_RECOVERY_STOP_GRACE_MS,
    'recovery stop grace',
  );
  const attempts = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
    .find({
      'processOwner.mode': 'PROCESS_GROUP',
      terminationConfirmed: { $ne: true },
      $or: [
        { lifecycle: { $in: ['RUNNING', 'STOP_REQUESTED'] } },
        {
          lifecycle: 'FINISHED',
          $expr: {
            $lte: [
              { $ifNull: ['$processReconcileNextAt', new Date(0)] },
              '$$NOW',
            ],
          },
        },
      ],
    })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .toArray();
  const counts: ReconcileSupervisedProcessesResult = {
    scanned: 0,
    stopRequested: 0,
    stopped: 0,
    normalExitReceipts: 0,
    unverifiable: 0,
  };

  for (const attempt of attempts) {
    const owner = attempt.processOwner;
    if (!owner) continue;
    counts.scanned++;
    const inspection: OwnedProcessTreeInspection =
      await inspectOwnedProcessTree(owner);
    if (attempt.lifecycle === 'STOP_REQUESTED') {
      if (!inspection.verifiable && !inspection.signalSafe) {
        counts.unverifiable++;
        continue;
      }
      const stopped = await stopSupervisedAttempt(client, db, {
        attemptId: attempt._id,
        processOwner: owner,
        abortGraceMs: opts.abortGraceMs,
        termGraceMs: opts.termGraceMs,
        killConfirmMs: opts.killConfirmMs,
        pollMs: opts.pollMs,
      });
      if (stopped.receiptRecorded || stopped.receiptDeduped) counts.stopped++;
      continue;
    }
    if (inspection.empty) {
      if (await recordNormalTreeEmpty(client, db, attempt, new Date())) {
        counts.normalExitReceipts++;
      } else if (attempt.lifecycle === 'FINISHED') {
        // Corrupt/unsupported FINISHED shapes must not become a tight oldest-row
        // scan even though no receipt boundary accepted them.
        counts.unverifiable++;
        await scheduleFinishedProcessProbe(db, attempt);
      }
      continue;
    }
    if (attempt.lifecycle === 'FINISHED') {
      if (!inspection.verifiable) counts.unverifiable++;
      await scheduleFinishedProcessProbe(db, attempt);
      continue;
    }
    if (attempt.lifecycle === 'RUNNING') {
      // Use Mongo's store clock, not the supervisor clock. This probe runs
      // before generic recovery and turns an expired live PROCESS_GROUP into a
      // durable stop epoch while its original fence can still authorize kill.
      const storeExpired = await db.collection<AttemptDoc>(COLLECTIONS.attempts)
        .findOne({
          _id: attempt._id,
          lifecycle: 'RUNNING',
          attemptFence: attempt.attemptFence,
          terminationConfirmed: { $ne: true },
          $expr: { $lte: ['$leaseExpiresAt', '$$NOW'] },
        } as unknown as Filter<AttemptDoc>);
      if (!storeExpired) {
        if (!inspection.verifiable) counts.unverifiable++;
        continue;
      }
      const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne(
        { _id: attempt.jobId },
        { projection: { jobStopGeneration: 1 } },
      );
      const requested = await requestAttemptStop(client, db, {
        attemptId: attempt._id,
        cause: 'lease_lost',
        graceMs: stopGraceMs,
        jobStopGenerationAtStop:
          job?.jobStopGeneration ?? attempt.jobStopGenerationAtDispatch ?? 0,
      });
      if (!requested) continue;
      counts.stopRequested++;
      if (!inspection.verifiable && !inspection.signalSafe) {
        counts.unverifiable++;
        continue;
      }
      const stopped = await stopSupervisedAttempt(client, db, {
        attemptId: attempt._id,
        processOwner: owner,
        abortGraceMs: opts.abortGraceMs,
        termGraceMs: opts.termGraceMs,
        killConfirmMs: opts.killConfirmMs,
        pollMs: opts.pollMs,
      });
      if (stopped.receiptRecorded || stopped.receiptDeduped) counts.stopped++;
    }
  }
  return counts;
}
