#!/usr/bin/env tsx
/**
 * Fail-complete strict gate for the first G0 test-runtime consumers.
 *
 * Every suite runs even when an earlier suite fails or reports NOT_RUN. The
 * parent accepts only one owner-signed evidence bundle per fixed suite and never
 * treats the partial Mongo foundation as full G0 qualification.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { MongoClient } from 'mongodb';
import ts from 'typescript';
import {
  PROCESS_EXECUTION_ID_ENV,
  PROCESS_RUNTIME_RUN_ID_ENV,
} from '../orchestration/execution/linux-process-tree.js';
import {
  createMongoOwnerAllocation,
  describeMongoTopologyUri,
  hashCanonicalValue,
  readGitSourceIdentity,
  TEST_EVIDENCE_BUNDLE_MAX_BYTES,
  validateTestEvidenceBundle,
  type MongoOwnerAllocationV1,
  type TestEvidenceBundleV3,
} from '../orchestration/testing/test-runtime.js';
import {
  MongoOrphanJournalStore,
  failedMongoOrphanReclaimReport,
  openMongoOrphanJournalClient,
  type MongoOrphanReclaimReport,
} from '../orchestration/testing/mongo-orphan-journal.js';
import {
  GateWorkspaceOrphanJournalStore,
  failedGateWorkspaceOrphanReclaimReport,
  type GateWorkspaceAllocation,
  type GateWorkspaceCleanupResult,
  type GateWorkspaceOrphanReclaimReport,
  type GateWorkspaceSession,
} from '../orchestration/testing/gate-workspace-orphan-journal.js';
import {
  createParentArtifactSession,
  processOutputMatchesArtifact,
  type MaterializedArtifactSet,
  type ParentArtifactSession,
  type RetainedRawEvidenceArtifact,
} from '../orchestration/testing/raw-evidence-sink.js';
import {
  createParentRuntimeResourceSession,
  type ParentRuntimeResourceEvidence,
  type ParentRuntimeResourceSession,
} from '../orchestration/testing/parent-runtime-resources.js';
import type {
  ParentGuardedRuntimeResourceContract,
} from '../orchestration/testing/runtime-resource-contract.js';
import {
  deriveFaultLedger,
  deriveFaultSchedule,
  type FaultLedger,
  type FaultSchedule,
} from '../orchestration/testing/fault-injector.js';

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESOURCE_GUARD_PATH = fileURLToPath(new URL(
  '../orchestration/testing/runtime-resource-guard.mjs',
  import.meta.url,
));
const RESOURCE_BOOTSTRAP_PATH = fileURLToPath(new URL(
  '../orchestration/testing/runtime-resource-bootstrap.mjs',
  import.meta.url,
));
const PROJECT_TSCONFIG = join(PROJECT_ROOT, 'tsconfig.json');
const SUITE_SOURCE_DIR = fileURLToPath(new URL('./', import.meta.url));

/**
 * In-process parent-side build of every suite into plain JavaScript.
 *
 * The child runs under `--permission` without child-process authority, and a
 * TypeScript loader cannot survive that: tsx transforms through esbuild, which
 * spawns its own service binary. Compiling here keeps the no-child-process
 * contract intact and removes transformation from the child entirely: the
 * child only ever loads bytes this parent produced into a root it owns, and
 * those bytes are content-attested (see `hashBuildOutput`) and re-verified
 * before every spawn.
 *
 * Compiler settings are inherited from the project tsconfig rather than
 * restated, so the gate cannot silently drift from how the suites are type
 * checked. `typeRoots` is absolute because this config lives outside the tree.
 * The compiler API runs in the gate owner process itself: there is no
 * pre-session compiler subprocess that could survive a killed parent and race
 * the workspace reclaimer while it inventories or deletes the build tree.
 *
 * The emitted bytes are attested here (`hashBuildOutput`) and re-verified
 * immediately before every spawn, so the child provably loads exactly what was
 * compiled. The session's entrypoint hash still binds only the path.
 */
interface BuildAttestation {
  rootHash: `sha256:${string}`;
  fileCount: number;
  totalBytes: number;
}

/**
 * Content attestation of the compiled suite output.
 *
 * Every emitted regular file contributes its exact bytes to one deterministic
 * root hash, so a tamper of the build directory between compilation and the
 * child's read is detected. The `node_modules` symlink is deliberately not
 * followed: it resolves into the already source-attested project root.
 */
function hashBuildOutput(outDir: string): BuildAttestation {
  const files: Array<{ path: string; hash: string; bytes: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error('build output has an unexpected entry type');
      }
      const bytes = readFileSync(absolute);
      files.push({
        path: relative(outDir, absolute).split(sep).join('/'),
        hash: sha256Bytes(bytes),
        bytes: bytes.byteLength,
      });
    }
  };
  walk(outDir);
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    rootHash: sha256Text(JSON.stringify(files.map((file) => [file.path, file.hash]))),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function compileSuites(
  buildRoot: string,
): { entrypoints: ReadonlyMap<string, string>; attestation: BuildAttestation } {
  const outDir = join(buildRoot, 'out');
  mkdirSync(outDir, { recursive: false });
  const configPath = join(buildRoot, 'tsconfig.build.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      extends: PROJECT_TSCONFIG,
      compilerOptions: {
        noEmit: false,
        declaration: false,
        sourceMap: false,
        types: ['node'],
        typeRoots: [join(PROJECT_ROOT, 'node_modules', '@types')],
        outDir,
        rootDir: PROJECT_ROOT,
      },
      // The inherited `include` would compile the whole tree; the suites and
      // their reachable graph are the exact build surface.
      include: [],
      files: SUITES.map((suite) => join(SUITE_SOURCE_DIR, suite.entrypoint)),
    }),
    { mode: 0o600 },
  );
  const configDiagnostics: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      configDiagnostics.push(diagnostic);
    },
  });
  const configurationErrors = [
    ...configDiagnostics,
    ...(parsed?.errors ?? []),
  ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (!parsed || configurationErrors.length > 0) {
    throw new Error(
      `suite compiler configuration failed (${configurationErrors.length})`,
    );
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const preEmitErrors = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (preEmitErrors.length > 0) {
    throw new Error(`suite compiler typecheck failed (${preEmitErrors.length})`);
  }
  const emitted = program.emit();
  const emitErrors = emitted.diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (emitted.emitSkipped || emitErrors.length > 0) {
    throw new Error(`suite compiler emit failed (${emitErrors.length})`);
  }
  // Bare specifiers in the emitted graph must resolve to the project's exact
  // installed packages. Node realpaths this link, so the child loads them from
  // the already read-authorized project root rather than a second copy.
  symlinkSync(
    join(PROJECT_ROOT, 'node_modules'),
    join(outDir, 'node_modules'),
    'dir',
  );
  const attestation = hashBuildOutput(outDir);
  if (attestation.fileCount === 0) {
    throw new Error('compiled build output is empty');
  }
  return {
    entrypoints: new Map(SUITES.map((suite) => [
      suite.suiteId,
      join(
        outDir,
        'src',
        'mastra',
        'scripts',
        suite.entrypoint.replace(/\.ts$/, '.js'),
      ),
    ])),
    attestation,
  };
}
const SUITE_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_SETTLE_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TOPOLOGY_URI = process.env.MONGODB_URI_SPIKE_RS
  ?? 'mongodb://localhost:27018/?replicaSet=rs0';
const PARENT_SOURCE = readGitSourceIdentity(PROJECT_ROOT);
const PARENT_TOPOLOGY = describeMongoTopologyUri(TOPOLOGY_URI);
interface GateMongoJournalContext {
  client: MongoClient;
  hello: unknown;
  store: MongoOrphanJournalStore;
}
interface GateWorkspaceJournalContext {
  allocation: GateWorkspaceAllocation;
  store: GateWorkspaceOrphanJournalStore;
}
const SUITES = [
  {
    suiteId: 'e2e:orchestration-autonomous',
    entrypoint: 'e2e-orchestration-autonomous.ts',
    portRoles: [],
    effectiveConfig: {
      executionProfile: 'DETERMINISTIC',
      runtimeKind: 'DIRECT',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: ['OK', 'INVALID_OUTPUT'],
    },
  },
  {
    suiteId: 'e2e:orchestration-http',
    entrypoint: 'e2e-orchestration-http.ts',
    portRoles: ['primary'],
    effectiveConfig: {
      executionProfile: 'DETERMINISTIC',
      runtimeKind: 'LOOPBACK_HTTP',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: ['OK'],
      requestedPort: 0,
    },
  },
  {
    suiteId: 'e2e:orchestration-service',
    entrypoint: 'e2e-orchestration-service.ts',
    portRoles: ['blocked-fixture', 'primary'],
    effectiveConfig: {
      executionProfile: 'DETERMINISTIC',
      runtimeKind: 'BACKGROUND_SERVICE',
      storeKind: 'MONGODB_REPLICA_SET',
      workerFixtureIds: ['OK'],
      requestedPort: 0,
      laneTickMs: 100,
      reconcileTickMs: 500,
    },
  },
] as const;

type GateReasonCode =
  | 'PASSED'
  | 'CHILD_FAILED'
  | 'CHILD_SIGNALLED'
  | 'TIMEOUT'
  | 'SPAWN_FAILED'
  | 'BUILD_ATTESTATION_MISMATCH'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_STATUS_REJECTED'
  | 'EVIDENCE_SUITE_MISMATCH'
  | 'EVIDENCE_PARENT_ANCHOR_MISMATCH'
  | 'ARTIFACT_INCOMPLETE'
  | 'ARTIFACT_TAMPERED'
  | 'STDIO_MISMATCH'
  | 'ARTIFACT_CLEANUP_FAILED'
  | 'RUNTIME_RESOURCE_SETUP_FAILED'
  | 'RUNTIME_RESOURCE_LIFECYCLE_FAILED'
  | 'RUNTIME_RESOURCE_VALIDATION_FAILED'
  | 'MONGO_JOURNAL_FINALIZATION_FAILED'
  | 'GATE_WORKSPACE_CLEANUP_FAILED';

interface GateSuiteResult {
  suiteId: string;
  status: 'PASSED' | 'FAILED';
  reasonCode: GateReasonCode;
  signatureVerifiedRelativeToManifest: boolean;
  parentTrustAnchorMatched: boolean;
  foundationValidationStatus: 'PASS' | 'FAIL' | 'NOT_AVAILABLE';
  buildAttestationVerified: boolean;
  materializedArtifactSet?: MaterializedArtifactSet;
  retainedArtifacts?: RetainedRawEvidenceArtifact[];
  artifactCleanupVerified: boolean;
  runtimeResourceValidationStatus: 'PASS' | 'FAILED' | 'NOT_AVAILABLE';
  runtimeResourceEvidence?: ParentRuntimeResourceEvidence;
  faultSchedule?: FaultSchedule;
  faultLedger?: FaultLedger;
}

/**
 * §19.1/§19.2 fault injector. The gate derives a deterministic, seed-bound fault
 * SCHEDULE per suite and records it in the signed evidence, then cross-checks a
 * fault-event log against it with a fail-closed LEDGER. Live injection into the
 * three e2e crash-windows is deferred, so the observed event log is empty and
 * every scheduled fault is accounted as `PLANNED`/deferred — but any fault that
 * actually fired outside the schedule (rogue) would classify the suite ESCAPED,
 * and an escaped fault ledger fails the gate exactly like an escaped side-effect
 * ledger. The deterministic contract check and the live proof exercise the real
 * firing and every escape direction.
 */
const GATE_FAULT_ACTIVE_BUDGET = 3;

function suiteFaultSeed(suiteId: string): number {
  const digest = hashCanonicalValue({
    commit: PARENT_SOURCE.commitSha,
    suiteId,
  });
  return parseInt(digest.slice('sha256:'.length, 'sha256:'.length + 8), 16) >>> 0;
}

function attachFaultEvidence(result: GateSuiteResult): GateSuiteResult {
  const challengeHash = result.runtimeResourceEvidence?.challengeHash
    ?? sha256Text(`gate-fault-challenge:${result.suiteId}`);
  const schedule = deriveFaultSchedule({
    seed: suiteFaultSeed(result.suiteId),
    suiteId: result.suiteId,
    challengeHash,
    activeBudget: GATE_FAULT_ACTIVE_BUDGET,
  });
  // Injection into live e2e suites is deferred: no fault fired this run, so the
  // ledger is derived over an empty authenticated event log in PLANNED mode.
  const ledger = deriveFaultLedger({ schedule, events: [], mode: 'PLANNED' });
  return { ...result, faultSchedule: schedule, faultLedger: ledger };
}

interface EvidenceReview {
  reasonCode: GateReasonCode;
  signatureVerifiedRelativeToManifest: boolean;
  parentTrustAnchorMatched: boolean;
  foundationValidationStatus: GateSuiteResult['foundationValidationStatus'];
  materializedArtifactSet?: MaterializedArtifactSet;
  retainedArtifacts?: RetainedRawEvidenceArtifact[];
  artifactCleanupVerified: boolean;
}

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * The Node-level egress guard can only authorize exact loopback ports. Refuse
 * SRV discovery, non-loopback hosts and ambiguous authorities instead of
 * pretending that a hostname hash is an enforceable network policy.
 */
function exactMongoLoopbackPorts(rawUri: string): readonly number[] {
  const scheme = /^(mongodb):\/\//i.exec(rawUri.trim());
  if (!scheme) {
    throw new TypeError('strict G0 requires a non-SRV Mongo loopback URI');
  }
  const remainder = rawUri.trim().slice(scheme[0].length);
  const authorityEnd = [remainder.indexOf('/'), remainder.indexOf('?'), remainder.indexOf('#')]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), remainder.length);
  const authority = remainder.slice(0, authorityEnd);
  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',');
  if (hosts.length < 1 || hosts.some((host) => host.length === 0)) {
    throw new TypeError('strict G0 Mongo authority is empty');
  }
  const ports = hosts.map((rawHost) => {
    const host = rawHost.toLowerCase();
    if (host.startsWith('[')) {
      const ipv6 = /^\[([^\]]+)\](?::([0-9]{1,5}))?$/.exec(host);
      if (!ipv6 || ipv6[1] !== '::1') {
        throw new TypeError('strict G0 Mongo host must be loopback');
      }
      return Number(ipv6[2] ?? '27017');
    }
    const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(host);
    if (!match || (match[1] !== 'localhost' && match[1] !== '127.0.0.1')) {
      throw new TypeError('strict G0 Mongo host must be loopback');
    }
    return Number(match[2] ?? '27017');
  });
  if (
    ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new TypeError('strict G0 Mongo port is invalid');
  }
  return Object.freeze([...new Set(ports)].sort((left, right) => left - right));
}

function evidenceRejection(
  suite: typeof SUITES[number],
  serializedEvidence: Buffer,
  parentChallenge: string,
  parentRuntimeContract: ParentGuardedRuntimeResourceContract,
  parentStdout: Buffer,
  parentStderr: Buffer,
  gateTempDir: string,
  suiteIndex: number,
): EvidenceReview {
  const rejected = (
    reasonCode: GateReasonCode,
    input: Partial<EvidenceReview> = {},
  ): EvidenceReview => ({
    reasonCode,
    signatureVerifiedRelativeToManifest: false,
    parentTrustAnchorMatched: false,
    foundationValidationStatus: 'NOT_AVAILABLE' as const,
    artifactCleanupVerified: false,
    ...input,
  });
  if (serializedEvidence.byteLength === 0) return rejected('EVIDENCE_MISSING');
  if (serializedEvidence.byteLength > TEST_EVIDENCE_BUNDLE_MAX_BYTES) {
    return rejected('EVIDENCE_INVALID');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(serializedEvidence.toString('utf8'));
  } catch {
    candidate = undefined;
  }
  const validation = validateTestEvidenceBundle(candidate);
  if (!validation.ok || !validation.value) {
    return rejected('EVIDENCE_INVALID');
  }
  const bundle: TestEvidenceBundleV3 = validation.value;
  const suiteMatches = bundle.manifest.suiteId === suite.suiteId
    && bundle.report.cases.length === 1
    && bundle.report.cases[0]?.caseId === suite.suiteId;
  if (!suiteMatches) {
    return rejected('EVIDENCE_SUITE_MISMATCH', {
      signatureVerifiedRelativeToManifest: true,
      foundationValidationStatus: bundle.report.foundationValidationStatus,
    });
  }
  const parentTrustAnchorMatched = hashCanonicalValue(bundle.manifest.source)
      === hashCanonicalValue(PARENT_SOURCE)
    && hashCanonicalValue(bundle.manifest.topology)
      === hashCanonicalValue(PARENT_TOPOLOGY)
    && bundle.manifest.configHash === hashCanonicalValue(suite.effectiveConfig)
    && hashCanonicalValue(bundle.manifest.effectiveConfig)
      === hashCanonicalValue(suite.effectiveConfig)
    && bundle.manifest.parentChallengeHash === sha256Text(parentChallenge)
    && hashCanonicalValue(bundle.manifest.resources.runtimeResources)
      === hashCanonicalValue(parentRuntimeContract);
  if (!parentTrustAnchorMatched) {
    return rejected('EVIDENCE_PARENT_ANCHOR_MISMATCH', {
      signatureVerifiedRelativeToManifest: true,
      foundationValidationStatus: bundle.report.foundationValidationStatus,
    });
  }
  if (
    bundle.report.artifactEvidenceStatus !== 'COMPLETE'
    || bundle.report.artifacts.length !== 5
    || bundle.report.artifacts.some((artifact) =>
      artifact.retentionStatus !== 'BUNDLE_RETAINED')
  ) {
    return rejected('ARTIFACT_INCOMPLETE', {
      signatureVerifiedRelativeToManifest: true,
      parentTrustAnchorMatched: true,
      foundationValidationStatus: bundle.report.foundationValidationStatus,
    });
  }
  const retainedArtifacts =
    bundle.report.artifacts as unknown as RetainedRawEvidenceArtifact[];
  const stdoutArtifact = retainedArtifacts.find((artifact) => artifact.kind === 'stdout');
  const stderrArtifact = retainedArtifacts.find((artifact) => artifact.kind === 'stderr');
  if (
    !stdoutArtifact
    || !stderrArtifact
    || !processOutputMatchesArtifact(parentStdout, stdoutArtifact)
    || !processOutputMatchesArtifact(parentStderr, stderrArtifact)
  ) {
    return rejected('STDIO_MISMATCH', {
      signatureVerifiedRelativeToManifest: true,
      parentTrustAnchorMatched: true,
      foundationValidationStatus: bundle.report.foundationValidationStatus,
    });
  }

  let artifactSession: ParentArtifactSession;
  try {
    artifactSession = createParentArtifactSession({
      parentDirectory: gateTempDir,
      sessionId: `suite-${suiteIndex}`,
    });
  } catch {
    return rejected('ARTIFACT_TAMPERED', {
      signatureVerifiedRelativeToManifest: true,
      parentTrustAnchorMatched: true,
      foundationValidationStatus: bundle.report.foundationValidationStatus,
    });
  }
  let materializedArtifactSet: MaterializedArtifactSet;
  try {
    materializedArtifactSet = artifactSession.materialize(retainedArtifacts);
  } catch {
    try {
      artifactSession.cleanup();
    } catch {
      return rejected('ARTIFACT_CLEANUP_FAILED', {
        signatureVerifiedRelativeToManifest: true,
        parentTrustAnchorMatched: true,
        foundationValidationStatus: bundle.report.foundationValidationStatus,
      });
    }
    return rejected('ARTIFACT_TAMPERED', {
      signatureVerifiedRelativeToManifest: true,
      parentTrustAnchorMatched: true,
      foundationValidationStatus: bundle.report.foundationValidationStatus,
    });
  }
  try {
    artifactSession.cleanup();
  } catch {
    return rejected('ARTIFACT_CLEANUP_FAILED', {
      signatureVerifiedRelativeToManifest: true,
      parentTrustAnchorMatched: true,
      foundationValidationStatus: bundle.report.foundationValidationStatus,
      materializedArtifactSet,
    });
  }

  const statusAccepted = bundle.report.testExecutionStatus === 'PASSED'
    && bundle.report.targetInvariantStatus === 'HOLDS'
    && bundle.report.cleanupStatus === 'CLEANUP_VERIFIED'
    && bundle.report.secretScanStatus === 'PASS'
    && bundle.report.artifactEvidenceStatus === 'COMPLETE'
    && bundle.report.foundationValidationStatus === 'PASS';
  return {
    reasonCode: statusAccepted ? 'PASSED' : 'EVIDENCE_STATUS_REJECTED',
    signatureVerifiedRelativeToManifest: true,
    parentTrustAnchorMatched: true,
    foundationValidationStatus: bundle.report.foundationValidationStatus,
    materializedArtifactSet,
    retainedArtifacts: statusAccepted ? retainedArtifacts : undefined,
    artifactCleanupVerified: true,
  };
}

interface ChildExecutionResult {
  stdout: Buffer;
  stderr: Buffer;
  evidence: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnFailed: boolean;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  streamDrainIncomplete: boolean;
  runtimeLifecycleFailed: boolean;
  runtimeResourceEvidence?: ParentRuntimeResourceEvidence;
}

interface BoundedDrain {
  bytes(): Buffer;
}

function failedSuiteResult(
  suite: typeof SUITES[number],
  reasonCode: GateReasonCode = 'SPAWN_FAILED',
): GateSuiteResult {
  return {
    suiteId: suite.suiteId,
    status: 'FAILED',
    reasonCode,
    signatureVerifiedRelativeToManifest: false,
    parentTrustAnchorMatched: false,
    foundationValidationStatus: 'NOT_AVAILABLE',
    buildAttestationVerified: false,
    artifactCleanupVerified: false,
    runtimeResourceValidationStatus: 'NOT_AVAILABLE',
  };
}

function attachBoundedDrain(
  stream: Readable,
  maxBytes: number,
  onLimit: () => void,
  onError: () => void,
): BoundedDrain {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let exceeded = false;
  stream.on('data', (chunk: unknown) => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : ArrayBuffer.isView(chunk)
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(String(chunk), 'utf8');
    if (exceeded) return;
    if (retainedBytes + bytes.byteLength > maxBytes) {
      exceeded = true;
      onLimit();
      return;
    }
    chunks.push(Buffer.from(bytes));
    retainedBytes += bytes.byteLength;
  });
  stream.on('error', onError);
  return {
    bytes: () => Buffer.concat(chunks, retainedBytes),
  };
}

async function grantMongoOwnerAllocation(
  child: ChildProcess,
  runtimeSession: ParentRuntimeResourceSession,
  allocation: MongoOwnerAllocationV1,
): Promise<void> {
  if (!child.connected || typeof child.send !== 'function') {
    throw new Error('Mongo owner allocation requires a live child IPC channel');
  }
  const serialized = JSON.stringify(allocation);
  const allocationHash = sha256Text(serialized);
  await new Promise<void>((resolveGrant, rejectGrant) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      if (error) rejectGrant(error);
      else resolveGrant();
    };
    const onMessage = (message: unknown) => {
      if (
        !message
        || typeof message !== 'object'
        || (message as { type?: unknown }).type !== 'G0_MONGO_OWNER_GRANTED'
      ) return;
      const record = message as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',')
          !== 'allocationHash,challengeHash,type'
        || record.challengeHash !== runtimeSession.challengeHash
        || record.allocationHash !== allocationHash
      ) {
        finish(new Error('child rejected or altered the Mongo owner allocation'));
        return;
      }
      finish();
    };
    const timer = setTimeout(() => {
      finish(new Error('Mongo owner allocation grant timed out'));
    }, 2_000);
    child.on('message', onMessage);
    child.send({
      type: 'G0_MONGO_OWNER_GRANT',
      challengeHash: runtimeSession.challengeHash,
      allocationHash,
      allocation,
    }, (error) => {
      if (error) finish(error);
    });
  });
}

async function executeSuiteChild(
  childEnv: NodeJS.ProcessEnv,
  runtimeSession: ParentRuntimeResourceSession,
  buildOutDir: string,
  mongoAllocation: MongoOwnerAllocationV1,
  mongoJournalStore: MongoOrphanJournalStore,
  gateWorkspaceJournal: GateWorkspaceJournalContext,
  gateWorkspaceSession: GateWorkspaceSession,
): Promise<ChildExecutionResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const nodePermissionArgs = runtimeSession.nodePermissionArgs({
        readOnlyPaths: [PROJECT_ROOT, buildOutDir],
        allowWorker: true,
      });
      // No TypeScript loader: the suites are already plain JavaScript, so the
      // child needs neither a transformer nor child-process authority.
      child = spawn(
        process.execPath,
        [
          ...nodePermissionArgs,
          '--no-warnings',
          '--import',
          RESOURCE_GUARD_PATH,
          RESOURCE_BOOTSTRAP_PATH,
        ],
        {
          cwd: runtimeSession.spawnContext.cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
        },
      );
    } catch {
      void runtimeSession.finalize()
        .then((runtimeResourceEvidence) => {
          resolve({
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            evidence: Buffer.alloc(0),
            exitCode: null,
            signal: null,
            spawnFailed: true,
            timedOut: false,
            outputLimitExceeded: false,
            streamDrainIncomplete: false,
            runtimeLifecycleFailed: true,
            runtimeResourceEvidence,
          });
        })
        .catch(() => {
          resolve({
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            evidence: Buffer.alloc(0),
            exitCode: null,
            signal: null,
            spawnFailed: true,
            timedOut: false,
            outputLimitExceeded: false,
            streamDrainIncomplete: false,
            runtimeLifecycleFailed: true,
          });
        });
      return;
    }

    let settled = false;
    let terminating = false;
    let spawnFailed = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let streamDrainIncomplete = false;
    let runtimeLifecycleFailed = false;
    let workloadReleaseAuthorized = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let suiteTimer: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    let exitDrainTimer: NodeJS.Timeout | undefined;

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const evidenceStream = child.stdio[3] as Readable | null | undefined;
    let stdoutDrain: BoundedDrain = { bytes: () => Buffer.alloc(0) };
    let stderrDrain: BoundedDrain = { bytes: () => Buffer.alloc(0) };
    let evidenceDrain: BoundedDrain = { bytes: () => Buffer.alloc(0) };

    const signalChild = async (signal: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
      if (child.pid === undefined) return;
      if (workloadReleaseAuthorized) {
        try {
          const result = await runtimeSession.signalOwned(signal);
          if (!result.sent && !result.alreadyEmpty) runtimeLifecycleFailed = true;
        } catch {
          runtimeLifecycleFailed = true;
        }
        return;
      }
      // Before workload release the exact child can only execute the fixed
      // guard/bootstrap chain; no suite code or descendant authority exists.
      try {
        child.kill(signal);
      } catch {
        // A concurrent exit is already an acceptable terminal condition.
      }
    };

    const clearTimers = (): void => {
      if (suiteTimer) clearTimeout(suiteTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
    };

    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimers();
      stdoutStream?.destroy();
      stderrStream?.destroy();
      evidenceStream?.destroy();
      let runtimeResourceEvidence: ParentRuntimeResourceEvidence | undefined;
      try {
        runtimeResourceEvidence = await runtimeSession.finalize();
      } catch {
        runtimeLifecycleFailed = true;
      }
      resolve({
        stdout: stdoutDrain.bytes(),
        stderr: stderrDrain.bytes(),
        evidence: evidenceDrain.bytes(),
        exitCode,
        signal: exitSignal,
        spawnFailed,
        timedOut,
        outputLimitExceeded,
        streamDrainIncomplete,
        runtimeLifecycleFailed,
        ...(runtimeResourceEvidence ? { runtimeResourceEvidence } : {}),
      });
    };

    const beginTermination = (): void => {
      if (terminating || settled) return;
      terminating = true;
      void signalChild('SIGTERM');
      terminationTimer = setTimeout(() => {
        void signalChild('SIGKILL');
        forceSettleTimer = setTimeout(() => {
          streamDrainIncomplete = true;
          void settle();
        }, FORCE_SETTLE_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };

    const onLimit = (): void => {
      outputLimitExceeded = true;
      beginTermination();
    };
    const onStreamError = (): void => {
      if (settled) return;
      streamDrainIncomplete = true;
      beginTermination();
    };

    try {
      if (!stdoutStream || !stderrStream || !evidenceStream) {
        spawnFailed = true;
        beginTermination();
      } else {
        stdoutDrain = attachBoundedDrain(
          stdoutStream,
          MAX_OUTPUT_BYTES,
          onLimit,
          onStreamError,
        );
        stderrDrain = attachBoundedDrain(
          stderrStream,
          MAX_OUTPUT_BYTES,
          onLimit,
          onStreamError,
        );
        evidenceDrain = attachBoundedDrain(
          evidenceStream,
          TEST_EVIDENCE_BUNDLE_MAX_BYTES,
          onLimit,
          onStreamError,
        );
      }
    } catch {
      spawnFailed = true;
      beginTermination();
    }

    suiteTimer = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, SUITE_TIMEOUT_MS);

    child.once('error', () => {
      spawnFailed = true;
      void settle();
    });
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      exitDrainTimer = setTimeout(() => {
        streamDrainIncomplete = true;
        void signalChild('SIGKILL');
        void settle();
      }, FORCE_SETTLE_GRACE_MS);
    });
    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      void settle();
    });

    void (async () => {
      try {
        const processOwner = await runtimeSession.claimSpawn(child);
        // The gate-wide directory journal already exists before this spawn.
        // Persist the exact process owner before either Mongo authority or
        // workload code can be released, so a killed parent never leaves an
        // unowned writer racing the crash-resumable deletion plan.
        await gateWorkspaceJournal.store.bindSessionOwner(
          gateWorkspaceJournal.allocation,
          gateWorkspaceSession,
          processOwner,
        );
        // This fsynced parent-only record is visible before workload release,
        // so every possible first Mongo write has a crash-persistent owner.
        await mongoJournalStore.register(mongoAllocation, processOwner);
        await runtimeSession.waitForPolicyActive();
        await runtimeSession.handoffAllPortLeases(child);
        await runtimeSession.waitForPortLeasesReceived();
        await runtimeSession.waitForBootstrapReady();
        await grantMongoOwnerAllocation(child, runtimeSession, mongoAllocation);
        await runtimeSession.releaseWorkload(child);
        workloadReleaseAuthorized = true;
        await runtimeSession.waitForWorkloadReleased();
      } catch {
        runtimeLifecycleFailed = true;
        beginTermination();
      }
    })();
  });
}

async function runSuite(
  suite: typeof SUITES[number],
  suiteIndex: number,
  gateTempDir: string | undefined,
  compiledEntrypoints: ReadonlyMap<string, string> | undefined,
  buildOutDir: string | undefined,
  buildAttestation: BuildAttestation | undefined,
  mongoJournal: GateMongoJournalContext | undefined,
  gateWorkspaceJournal: GateWorkspaceJournalContext | undefined,
): Promise<GateSuiteResult> {
  const entrypoint = compiledEntrypoints?.get(suite.suiteId);
  if (
    !gateTempDir
    || !entrypoint
    || !buildOutDir
    || !buildAttestation
    || !mongoJournal
    || !gateWorkspaceJournal
  ) {
    return failedSuiteResult(suite, 'RUNTIME_RESOURCE_SETUP_FAILED');
  }
  // Re-verify the compiled bytes match what was attested at build time, closing
  // the compile→spawn tamper window before any resource is set up for this run.
  let buildAttestationVerified = false;
  try {
    buildAttestationVerified =
      hashBuildOutput(buildOutDir).rootHash === buildAttestation.rootHash;
  } catch {
    buildAttestationVerified = false;
  }
  if (!buildAttestationVerified) {
    return failedSuiteResult(suite, 'BUILD_ATTESTATION_MISMATCH');
  }
  const parentChallenge = randomBytes(32).toString('hex');
  let runtimeSession: ParentRuntimeResourceSession<typeof PARENT_SOURCE>;
  try {
    runtimeSession = await createParentRuntimeResourceSession({
      parentDirectory: gateTempDir,
      parentChallenge,
      entrypoint,
      entrypointRoot: buildOutDir,
      sourceRoot: PROJECT_ROOT,
      parentSourceIdentity: PARENT_SOURCE,
      readPostRunSourceIdentity: () => readGitSourceIdentity(PROJECT_ROOT),
      sourceIdentityEquals: (before, after) =>
        hashCanonicalValue(before) === hashCanonicalValue(after),
      portRoles: suite.portRoles,
      allowedLoopbackPorts: exactMongoLoopbackPorts(TOPOLOGY_URI),
    });
  } catch {
    return failedSuiteResult(suite, 'RUNTIME_RESOURCE_SETUP_FAILED');
  }
  let gateWorkspaceSession: GateWorkspaceSession;
  try {
    const processExecutionId =
      runtimeSession.spawnContext.env[PROCESS_EXECUTION_ID_ENV];
    const runtimeRunId =
      runtimeSession.spawnContext.env[PROCESS_RUNTIME_RUN_ID_ENV];
    if (!processExecutionId || !runtimeRunId) {
      throw new Error('runtime session omitted its exact process tokens');
    }
    // This intent is fsynced before executeSuiteChild can spawn. If the parent
    // dies before claimSpawn publishes the owner sidecar, startup recovery can
    // still prove the exact token set empty without trusting a path scan.
    gateWorkspaceSession = await gateWorkspaceJournal.store.registerSession(
      gateWorkspaceJournal.allocation,
      {
        suiteId: suite.suiteId,
        processExecutionId,
        runtimeRunId,
        workspaceRoot: runtimeSession.spawnContext.cwd,
      },
    );
  } catch {
    const runtimeResourceEvidence = await runtimeSession.finalize().catch(() => undefined);
    return {
      ...failedSuiteResult(suite, 'RUNTIME_RESOURCE_SETUP_FAILED'),
      ...(runtimeResourceEvidence ? { runtimeResourceEvidence } : {}),
    };
  }
  let mongoAllocation: MongoOwnerAllocationV1;
  try {
    mongoAllocation = createMongoOwnerAllocation({
      suiteId: suite.suiteId,
      parentChallenge,
      topologyUri: TOPOLOGY_URI,
      topologyHello: mongoJournal.hello,
    });
  } catch {
    const runtimeResourceEvidence = await runtimeSession.finalize().catch(() => undefined);
    return {
      ...failedSuiteResult(suite, 'RUNTIME_RESOURCE_SETUP_FAILED'),
      ...(runtimeResourceEvidence ? { runtimeResourceEvidence } : {}),
    };
  }
  const inheritedSafeEnv = Object.fromEntries(
    ['LANG', 'LC_ALL', 'TZ', 'CI']
      .flatMap((name) => process.env[name] === undefined
        ? []
        : [[name, process.env[name]!]]),
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...runtimeSession.spawnContext.env,
    ...inheritedSafeEnv,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    MONGODB_URI_SPIKE_RS: TOPOLOGY_URI,
    ORCHESTRATION_G0_GATE: 'true',
    ORCHESTRATION_G0_EVIDENCE_FD: '3',
    NODE_OPTIONS: '',
  };

  let execution: ChildExecutionResult;
  try {
    execution = await executeSuiteChild(
      childEnv,
      runtimeSession,
      buildOutDir,
      mongoAllocation,
      mongoJournal.store,
      gateWorkspaceJournal,
      gateWorkspaceSession,
    );
  } catch {
    const runtimeResourceEvidence = await runtimeSession.finalize().catch(() => undefined);
    return {
      ...failedSuiteResult(suite, 'RUNTIME_RESOURCE_LIFECYCLE_FAILED'),
      buildAttestationVerified: true,
      runtimeResourceValidationStatus:
        runtimeResourceEvidence?.resourceValidationStatus ?? 'FAILED',
      ...(runtimeResourceEvidence ? { runtimeResourceEvidence } : {}),
    };
  }

  let evidence: EvidenceReview;
  try {
    evidence = evidenceRejection(
      suite,
      execution.evidence,
      parentChallenge,
      runtimeSession.contract,
      execution.stdout,
      execution.stderr,
      gateTempDir,
      suiteIndex,
    );
  } catch {
    evidence = {
      reasonCode: 'EVIDENCE_INVALID',
      signatureVerifiedRelativeToManifest: false,
      parentTrustAnchorMatched: false,
      foundationValidationStatus: 'NOT_AVAILABLE',
      artifactCleanupVerified: false,
    };
  }

  let reasonCode = evidence.reasonCode;
  if (execution.outputLimitExceeded) reasonCode = 'OUTPUT_LIMIT_EXCEEDED';
  else if (execution.timedOut) reasonCode = 'TIMEOUT';
  else if (execution.spawnFailed || execution.streamDrainIncomplete) reasonCode = 'SPAWN_FAILED';
  else if (execution.signal) reasonCode = 'CHILD_SIGNALLED';
  else if (execution.exitCode !== 0) reasonCode = 'CHILD_FAILED';
  else if (execution.runtimeLifecycleFailed) {
    reasonCode = 'RUNTIME_RESOURCE_LIFECYCLE_FAILED';
  } else if (
    execution.runtimeResourceEvidence?.resourceValidationStatus !== 'PASS'
  ) {
    reasonCode = 'RUNTIME_RESOURCE_VALIDATION_FAILED';
  }

  let passed = execution.exitCode === 0
    && execution.signal === null
    && !execution.spawnFailed
    && !execution.timedOut
    && !execution.outputLimitExceeded
    && !execution.streamDrainIncomplete
    && !execution.runtimeLifecycleFailed
    && execution.runtimeResourceEvidence?.resourceValidationStatus === 'PASS'
    && evidence.reasonCode === 'PASSED';
  if (passed) {
    try {
      await mongoJournal.store.completeVerifiedAbsent(
        mongoJournal.client,
        mongoAllocation,
      );
    } catch {
      passed = false;
      reasonCode = 'MONGO_JOURNAL_FINALIZATION_FAILED';
    }
  }
  return {
    suiteId: suite.suiteId,
    status: passed ? 'PASSED' : 'FAILED',
    reasonCode: passed ? 'PASSED' : reasonCode,
    signatureVerifiedRelativeToManifest: evidence.signatureVerifiedRelativeToManifest,
    parentTrustAnchorMatched: evidence.parentTrustAnchorMatched,
    foundationValidationStatus: evidence.foundationValidationStatus,
    buildAttestationVerified: true,
    ...(evidence.materializedArtifactSet
      ? { materializedArtifactSet: evidence.materializedArtifactSet }
      : {}),
    ...(passed && evidence.retainedArtifacts
      ? { retainedArtifacts: evidence.retainedArtifacts }
      : {}),
    artifactCleanupVerified: evidence.artifactCleanupVerified,
    runtimeResourceValidationStatus:
      execution.runtimeResourceEvidence?.resourceValidationStatus ?? 'FAILED',
    ...(execution.runtimeResourceEvidence
      ? { runtimeResourceEvidence: execution.runtimeResourceEvidence }
      : {}),
  };
}

function publishGateResult(
  results: readonly GateSuiteResult[],
  buildAttestation: BuildAttestation | undefined,
  mongoOrphanReclaim: MongoOrphanReclaimReport,
  gateWorkspaceOrphanReclaim: GateWorkspaceOrphanReclaimReport,
  gateWorkspaceCleanup: GateWorkspaceCleanupResult | undefined,
): void {
  const passed = results.every((result) => result.status === 'PASSED')
    && results.every(
      (result) => result.faultLedger?.containmentStatus === 'ACCOUNTED',
    )
    && mongoOrphanReclaim.status === 'PASSED'
    && mongoOrphanReclaim.reclaimVerified
    && gateWorkspaceOrphanReclaim.status === 'PASSED'
    && gateWorkspaceOrphanReclaim.reclaimVerified
    && gateWorkspaceCleanup?.status === 'PASSED'
    && gateWorkspaceCleanup.verifiedAbsent;
  const unsignedGateEvidence = {
    schemaVersion: 'g0-test-runtime-gate/v6',
    gateStatus: passed ? 'PASSED' : 'FAILED',
    qualificationStatus: 'NOT_QUALIFIED',
    parentSource: PARENT_SOURCE,
    parentTopology: PARENT_TOPOLOGY,
    ...(buildAttestation ? { buildAttestation } : {}),
    mongoOrphanReclaim,
    gateWorkspaceOrphanReclaim,
    ...(gateWorkspaceCleanup ? { gateWorkspaceCleanup } : {}),
    suites: results,
  } as const;
  const parentKeyPair = generateKeyPairSync('ed25519');
  const parentPayloadHash = hashCanonicalValue(unsignedGateEvidence);
  const parentSignature = sign(
    null,
    Buffer.from(JSON.stringify({
      domain: 'G0_PARENT_VERIFIED_RUNTIME_RESOURCE_GATE_V5',
      payloadHash: parentPayloadHash,
    }), 'utf8'),
    parentKeyPair.privateKey,
  );
  const parentPublicKey = parentKeyPair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(parentPublicKey)) throw new Error('parent evidence key export failed');
  console.log(JSON.stringify({
    ...unsignedGateEvidence,
    parentAttestation: {
      schemaVersion: 'g0-parent-runtime-resource-attestation/v5',
      algorithm: 'Ed25519',
      payloadHash: parentPayloadHash,
      keyId: sha256Bytes(parentPublicKey),
      publicKeySpkiDerBase64url: parentPublicKey.toString('base64url'),
      signatureBase64url: parentSignature.toString('base64url'),
    },
  }));
  process.exitCode = passed ? 0 : 1;
}

function invalidateForRootCleanup(result: GateSuiteResult): GateSuiteResult {
  const {
    retainedArtifacts: _retainedArtifacts,
    ...withoutRetainedArtifacts
  } = result;
  return {
    ...withoutRetainedArtifacts,
    status: 'FAILED',
    reasonCode: result.status === 'PASSED'
      ? 'GATE_WORKSPACE_CLEANUP_FAILED'
      : result.reasonCode,
    artifactCleanupVerified: false,
    runtimeResourceValidationStatus: 'FAILED',
  };
}

async function main(): Promise<void> {
  let mongoOrphanReclaim = failedMongoOrphanReclaimReport();
  let mongoJournal: GateMongoJournalContext | undefined;
  let mongoClientToClose: MongoClient | undefined;
  try {
    const opened = await openMongoOrphanJournalClient(TOPOLOGY_URI);
    mongoClientToClose = opened.client;
    const store = new MongoOrphanJournalStore();
    mongoOrphanReclaim = await store.reclaim({
      client: opened.client,
      topologyDescriptorHash: hashCanonicalValue(PARENT_TOPOLOGY),
      topologyHello: opened.hello,
    });
    if (
      mongoOrphanReclaim.status === 'PASSED'
      && mongoOrphanReclaim.reclaimVerified
    ) {
      mongoJournal = {
        client: opened.client,
        hello: opened.hello,
        store,
      };
    }
  } catch {
    mongoOrphanReclaim = failedMongoOrphanReclaimReport();
  }

  let gateWorkspaceOrphanReclaim =
    failedGateWorkspaceOrphanReclaimReport();
  let gateWorkspaceStore: GateWorkspaceOrphanJournalStore | undefined;
  try {
    const store = new GateWorkspaceOrphanJournalStore();
    gateWorkspaceOrphanReclaim = await store.reclaim({});
    if (
      gateWorkspaceOrphanReclaim.status === 'PASSED'
      && gateWorkspaceOrphanReclaim.reclaimVerified
    ) {
      gateWorkspaceStore = store;
    }
  } catch {
    gateWorkspaceOrphanReclaim =
      failedGateWorkspaceOrphanReclaimReport();
  }

  let gateTempDir: string | undefined;
  let gateWorkspaceJournal: GateWorkspaceJournalContext | undefined;
  if (mongoJournal && gateWorkspaceStore) {
    try {
      // The PREPARED authority is fsynced before the exact root is created.
      // createOwnedRoot returns only after the HMAC marker and root binding are
      // durable, so build/session code never observes an unjournaled directory.
      const owned = await gateWorkspaceStore.createOwnedRoot({});
      gateTempDir = owned.root;
      gateWorkspaceJournal = {
        allocation: owned.allocation,
        store: gateWorkspaceStore,
      };
    } catch {
      // Each suite still runs and receives its own failed setup result below.
    }
  }

  let buildOutDir: string | undefined;
  let compiledEntrypoints: ReadonlyMap<string, string> | undefined;
  let buildAttestation: BuildAttestation | undefined;
  if (gateTempDir) {
    try {
      const candidate = mkdtempSync(join(gateTempDir, 'build-'));
      chmodSync(candidate, 0o700);
      const compiled = compileSuites(candidate);
      compiledEntrypoints = compiled.entrypoints;
      buildAttestation = compiled.attestation;
      buildOutDir = join(candidate, 'out');
    } catch {
      // Every suite reports its own setup failure below; the gate never
      // silently runs a stale or partial build.
      compiledEntrypoints = undefined;
      buildAttestation = undefined;
    }
  }

  let results: GateSuiteResult[] = [];
  for (let index = 0; index < SUITES.length; index++) {
    const suite = SUITES[index]!;
    try {
      results.push(await runSuite(
        suite,
        index,
        gateTempDir,
        compiledEntrypoints,
        buildOutDir,
        buildAttestation,
        mongoJournal,
        gateWorkspaceJournal,
      ));
    } catch {
      results.push(failedSuiteResult(suite));
    }
  }

  let gateWorkspaceCleanup: GateWorkspaceCleanupResult | undefined;
  if (gateWorkspaceJournal) {
    try {
      gateWorkspaceCleanup =
        await gateWorkspaceJournal.store.cleanupOwned(
          gateWorkspaceJournal.allocation,
        );
    } catch {
      gateWorkspaceCleanup = undefined;
    }
    if (
      gateWorkspaceCleanup?.status !== 'PASSED'
      || !gateWorkspaceCleanup.verifiedAbsent
    ) {
      results = results.map(invalidateForRootCleanup);
    }
  }
  await mongoClientToClose?.close().catch(() => {});
  // Record the seed-derived fault schedule and its fail-closed ledger for every
  // suite (§19.2) as the final evidence step, after any cleanup invalidation.
  publishGateResult(
    results.map(attachFaultEvidence),
    buildAttestation,
    mongoOrphanReclaim,
    gateWorkspaceOrphanReclaim,
    gateWorkspaceCleanup,
  );
}

void main().catch(() => {
  const fallback = SUITES.map((suite) => attachFaultEvidence(failedSuiteResult(suite)));
  try {
    publishGateResult(
      fallback,
      undefined,
      failedMongoOrphanReclaimReport(),
      failedGateWorkspaceOrphanReclaimReport(),
      undefined,
    );
  } catch {
    process.exitCode = 1;
  }
});
