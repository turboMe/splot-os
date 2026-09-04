/**
 * Crash-persistent ownership and cleanup for the complete G0 gate workspace.
 *
 * One authority covers the outer gate root, including compiled build output,
 * per-suite runtime workspaces, and raw evidence artifacts.  The workload is
 * Node-guarded and receives neither the private journal path nor the cleanup
 * capability.  This does not claim to contain a hostile same-UID native
 * process, cgroup escape, or fork race outside that guard.
 */
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
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
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';
import {
  inspectOwnedProcessTree,
  readLinuxProcessIdentity,
  readLocalProcessHostIdentity,
  scanNumericProc,
  signalOwnedProcessGroup,
  waitForOwnedProcessTreeEmpty,
} from '../execution/linux-process-tree.js';
import type { AttemptProcessOwnerDoc } from '../store/collections.js';
import { hashCanonicalValue } from './test-runtime.js';

export const GATE_WORKSPACE_ALLOCATION_VERSION =
  'g0-gate-workspace-allocation/v1' as const;
export const GATE_WORKSPACE_JOURNAL_ENTRY_VERSION =
  'g0-gate-workspace-journal-entry/v1' as const;
export const GATE_WORKSPACE_MARKER_VERSION =
  'g0-gate-workspace-marker/v1' as const;
export const GATE_WORKSPACE_BINDING_VERSION =
  'g0-gate-workspace-ready-binding/v1' as const;
export const GATE_WORKSPACE_SESSION_VERSION =
  'g0-gate-workspace-session/v1' as const;
export const GATE_WORKSPACE_SESSION_OWNER_VERSION =
  'g0-gate-workspace-session-owner/v1' as const;
export const GATE_WORKSPACE_DELETION_PLAN_VERSION =
  'g0-gate-workspace-deletion-plan/v1' as const;
export const GATE_WORKSPACE_CLAIM_VERSION =
  'g0-gate-workspace-claim/v1' as const;
export const GATE_WORKSPACE_ADMISSION_VERSION =
  'g0-gate-workspace-admission/v1' as const;
export const GATE_WORKSPACE_CLEANUP_VERSION =
  'g0-gate-workspace-cleanup/v1' as const;
export const GATE_WORKSPACE_ORPHAN_RECLAIM_VERSION =
  'g0-gate-workspace-orphan-reclaim/v1' as const;
export const GATE_WORKSPACE_MARKER_NAME =
  '.g0-gate-workspace-owner.json' as const;

const JOURNAL_DIRECTORY_VERSION = 'v1';
const MANAGED_DIRECTORY_VERSION = 'v1';
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const HMAC_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const WORKSPACE_ID_RE = /^g0ws_[a-f0-9]{32}$/;
const ROOT_NAME_RE = /^orch-g0-gate-[a-f0-9]{32}$/;
const SESSION_ID_RE = /^g0session_[a-f0-9]{32}$/;
const SAFE_SUITE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/;
const BOOT_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PID_NAMESPACE_RE = /^pid:\[[1-9][0-9]*\]$/;
const PROCESS_START_RE = /^[0-9]+$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const MOUNT_ID_RE = /^[1-9][0-9]*$/;
const ENTRY_RE = /^(g0ws_[a-f0-9]{32})\.entry\.json$/;
const BINDING_RE = /^(g0ws_[a-f0-9]{32})\.binding\.json$/;
const PLAN_RE = /^(g0ws_[a-f0-9]{32})\.plan\.json$/;
const CLAIM_RE = /^(g0ws_[a-f0-9]{32})\.claim\.json$/;
const SESSION_RE =
  /^(g0ws_[a-f0-9]{32})\.(g0session_[a-f0-9]{32})\.session\.json$/;
const OWNER_RE =
  /^(g0ws_[a-f0-9]{32})\.(g0session_[a-f0-9]{32})\.owner\.json$/;
const ADMISSION_FILE_NAME = '.gate-workspace-admission.json';
const TEMP_RE =
  /^\.(g0ws_[a-f0-9]{32}\.(?:entry|binding|plan|claim)\.json|g0ws_[a-f0-9]{32}\.g0session_[a-f0-9]{32}\.(?:session|owner)\.json|\.gate-workspace-admission\.json)\.tmp\.[a-f0-9]{64}$/;
const MARKER_TEMP_RE =
  /^\.\.g0-gate-workspace-owner\.json\.tmp\.[a-f0-9]{64}$/;
const MAX_AUTHORITIES = 64;
const MAX_SESSIONS = 64;
// Every authority may leave one authenticated atomic-publication temp behind,
// while admission itself may simultaneously exist as a final+temp pair.
const AUTHORITY_PUBLICATION_DIRENT_SLACK = MAX_AUTHORITIES;
const ADMISSION_PUBLICATION_DIRENT_SLACK = 2;
const MAX_JOURNAL_DIRENTS =
  MAX_AUTHORITIES * (4 + (MAX_SESSIONS * 2))
  + AUTHORITY_PUBLICATION_DIRENT_SLACK
  + ADMISSION_PUBLICATION_DIRENT_SLACK;
const MAX_SMALL_JOURNAL_BYTES = 64 * 1024;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECLAIM_DEADLINE_MS = 30_000;
const MAX_RECLAIM_DEADLINE_MS = 120_000;
const LINUX_O_PATH = 0x20_0000;

export const gateWorkspaceLimitsSchema = z.object({
  maxEntries: z.number().int().min(1).max(16_384),
  maxDepth: z.number().int().min(1).max(64),
  maxTotalFileBytes: z.number().int().min(1).max(512 * 1024 * 1024),
  maxTotalPathBytes: z.number().int().min(1).max(8 * 1024 * 1024),
  maxSessions: z.number().int().min(1).max(MAX_SESSIONS),
}).strict();
export type GateWorkspaceLimits = z.infer<typeof gateWorkspaceLimitsSchema>;

const DEFAULT_LIMITS: GateWorkspaceLimits = Object.freeze({
  maxEntries: 4_096,
  maxDepth: 32,
  maxTotalFileBytes: 128 * 1024 * 1024,
  maxTotalPathBytes: 1024 * 1024,
  maxSessions: MAX_SESSIONS,
});

const fsIdentitySchema = z.object({
  dev: z.string().regex(DECIMAL_RE),
  ino: z.string().regex(DECIMAL_RE),
  uid: z.string().regex(DECIMAL_RE),
  mode: z.number().int().nonnegative().max(0o7777),
}).strict();
export type GateWorkspaceFsIdentity = z.infer<typeof fsIdentitySchema>;

const localProcessIdentitySchema = z.object({
  hostId: z.string().min(1).max(255),
  hostBootId: z.string().regex(BOOT_ID_RE),
  pidNamespaceId: z.string().regex(PID_NAMESPACE_RE),
  pid: z.number().int().min(2),
  processStartToken: z.string().regex(PROCESS_START_RE),
}).strict();
export type GateWorkspaceLocalProcessIdentity =
  z.infer<typeof localProcessIdentitySchema>;

const unsignedAdmissionSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_ADMISSION_VERSION),
  admissionId: z.string().regex(/^[a-f0-9]{64}$/),
  claimantProcess: localProcessIdentitySchema,
  claimedAt: z.string().datetime(),
}).strict();
const admissionSchema = unsignedAdmissionSchema.extend({
  admissionHash: z.string().regex(SHA256_RE),
}).strict().superRefine((admission, context) => {
  const { admissionHash: _admissionHash, ...unsigned } = admission;
  if (admission.admissionHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['admissionHash'],
      message: 'Gate workspace admission hash does not match',
    });
  }
});
type GateWorkspaceAdmission = z.infer<typeof admissionSchema>;

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
type GateWorkspaceJournalProcessOwner =
  z.infer<typeof journalProcessOwnerSchema>;

export const gateWorkspaceAllocationSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_ALLOCATION_VERSION),
  workspaceId: z.string().regex(WORKSPACE_ID_RE),
  rootName: z.string().regex(ROOT_NAME_RE),
  rootPath: z.string().min(1).max(4_096),
  managedRootHash: z.string().regex(SHA256_RE),
  cleanupCapability: z.string().regex(CAPABILITY_RE),
  cleanupCapabilityHash: z.string().regex(SHA256_RE),
  limits: gateWorkspaceLimitsSchema,
  allocatedAt: z.string().datetime(),
}).strict().superRefine((allocation, context) => {
  if (
    allocation.cleanupCapabilityHash
    !== hashCanonicalValue(allocation.cleanupCapability)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['cleanupCapabilityHash'],
      message: 'Gate workspace cleanup capability hash does not match',
    });
  }
  if (
    allocation.rootName
    !== `orch-g0-gate-${allocation.workspaceId.slice('g0ws_'.length)}`
  ) {
    context.addIssue({
      code: 'custom',
      path: ['rootName'],
      message: 'Gate workspace root name does not match its workspace id',
    });
  }
});
export type GateWorkspaceAllocation =
  z.infer<typeof gateWorkspaceAllocationSchema>;

const unsignedEntrySchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_JOURNAL_ENTRY_VERSION),
  allocation: gateWorkspaceAllocationSchema,
  parentProcess: localProcessIdentitySchema,
  preparedAt: z.string().datetime(),
}).strict();
const journalEntrySchema = unsignedEntrySchema.extend({
  entryHash: z.string().regex(SHA256_RE),
}).strict().superRefine((entry, context) => {
  const { entryHash: _entryHash, ...unsigned } = entry;
  if (entry.entryHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['entryHash'],
      message: 'Gate workspace journal entry hash does not match',
    });
  }
});
type GateWorkspaceJournalEntry = z.infer<typeof journalEntrySchema>;

const unsignedMarkerSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_MARKER_VERSION),
  workspaceId: z.string().regex(WORKSPACE_ID_RE),
  entryHash: z.string().regex(SHA256_RE),
  allocationHash: z.string().regex(SHA256_RE),
  rootPathHash: z.string().regex(SHA256_RE),
  rootIdentity: fsIdentitySchema,
  rootMountId: z.string().regex(MOUNT_ID_RE),
  createdAt: z.string().datetime(),
}).strict();
const markerSchema = unsignedMarkerSchema.extend({
  proof: z.string().regex(HMAC_RE),
}).strict();
type GateWorkspaceMarker = z.infer<typeof markerSchema>;

const unsignedBindingSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_BINDING_VERSION),
  workspaceId: z.string().regex(WORKSPACE_ID_RE),
  entryHash: z.string().regex(SHA256_RE),
  allocationHash: z.string().regex(SHA256_RE),
  rootIdentity: fsIdentitySchema,
  rootMountId: z.string().regex(MOUNT_ID_RE),
  markerIdentity: fsIdentitySchema,
  markerHash: z.string().regex(SHA256_RE),
  readyAt: z.string().datetime(),
}).strict();
const bindingSchema = unsignedBindingSchema.extend({
  bindingHash: z.string().regex(SHA256_RE),
  proof: z.string().regex(HMAC_RE),
}).strict().superRefine((binding, context) => {
  const {
    bindingHash: _bindingHash,
    proof: _proof,
    ...unsigned
  } = binding;
  if (binding.bindingHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['bindingHash'],
      message: 'Gate workspace binding hash does not match',
    });
  }
});
type GateWorkspaceBinding = z.infer<typeof bindingSchema>;

const unsignedSessionSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_SESSION_VERSION),
  workspaceId: z.string().regex(WORKSPACE_ID_RE),
  entryHash: z.string().regex(SHA256_RE),
  sessionId: z.string().regex(SESSION_ID_RE),
  suiteId: z.string().regex(SAFE_SUITE_ID_RE),
  processExecutionId: z.string().min(1).max(255),
  runtimeRunId: z.string().min(1).max(255),
  workspaceRelativePath: z.string().min(1).max(4_096),
  workspaceRootHash: z.string().regex(SHA256_RE),
  registeredAt: z.string().datetime(),
}).strict();
const sessionSchema = unsignedSessionSchema.extend({
  sessionHash: z.string().regex(SHA256_RE),
  proof: z.string().regex(HMAC_RE),
}).strict().superRefine((session, context) => {
  const { sessionHash: _sessionHash, proof: _proof, ...unsigned } = session;
  if (session.sessionHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['sessionHash'],
      message: 'Gate workspace session hash does not match',
    });
  }
});
export type GateWorkspaceSession = z.infer<typeof sessionSchema>;

const unsignedSessionOwnerSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_SESSION_OWNER_VERSION),
  workspaceId: z.string().regex(WORKSPACE_ID_RE),
  sessionId: z.string().regex(SESSION_ID_RE),
  sessionHash: z.string().regex(SHA256_RE),
  owner: journalProcessOwnerSchema,
  boundAt: z.string().datetime(),
}).strict();
const sessionOwnerSchema = unsignedSessionOwnerSchema.extend({
  ownerHash: z.string().regex(SHA256_RE),
  proof: z.string().regex(HMAC_RE),
}).strict().superRefine((owner, context) => {
  const { ownerHash: _ownerHash, proof: _proof, ...unsigned } = owner;
  if (owner.ownerHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['ownerHash'],
      message: 'Gate workspace session owner hash does not match',
    });
  }
});
type GateWorkspaceSessionOwner = z.infer<typeof sessionOwnerSchema>;

const plannedNodeSchema = z.object({
  relativePath: z.string().min(1).max(4_096),
  depth: z.number().int().min(1).max(64),
  type: z.enum(['DIRECTORY', 'FILE', 'SYMLINK']),
  identity: fsIdentitySchema,
  mountId: z.string().regex(MOUNT_ID_RE),
  nlink: z.string().regex(DECIMAL_RE),
  size: z.string().regex(DECIMAL_RE),
}).strict();
type GateWorkspacePlannedNode = z.infer<typeof plannedNodeSchema>;

const unsignedPlanSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_DELETION_PLAN_VERSION),
  workspaceId: z.string().regex(WORKSPACE_ID_RE),
  entryHash: z.string().regex(SHA256_RE),
  bindingHash: z.string().regex(SHA256_RE),
  originalRootName: z.string().regex(ROOT_NAME_RE),
  quarantineName: z.string().regex(
    /^\.orch-g0-gate-quarantine-[a-f0-9]{32}-[a-f0-9]{32}$/,
  ),
  rootIdentity: fsIdentitySchema,
  rootMountId: z.string().regex(MOUNT_ID_RE),
  markerRelativePath: z.literal(GATE_WORKSPACE_MARKER_NAME),
  nodes: z.array(plannedNodeSchema).max(16_384),
  entryCount: z.number().int().min(1).max(16_384),
  totalFileBytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
  totalPathBytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
  maxObservedDepth: z.number().int().min(1).max(64),
  plannedAt: z.string().datetime(),
}).strict().superRefine((plan, context) => {
  if (plan.nodes.length !== plan.entryCount) {
    context.addIssue({
      code: 'custom',
      path: ['entryCount'],
      message: 'Gate workspace plan entry count does not match its nodes',
    });
  }
  if (
    plan.nodes.length < 1
    || plan.nodes.at(-1)?.relativePath !== GATE_WORKSPACE_MARKER_NAME
  ) {
    context.addIssue({
      code: 'custom',
      path: ['nodes'],
      message: 'Gate workspace marker must be the last planned removal',
    });
  }
  if (new Set(plan.nodes.map((node) => node.relativePath)).size !== plan.nodes.length) {
    context.addIssue({
      code: 'custom',
      path: ['nodes'],
      message: 'Gate workspace plan contains duplicate relative paths',
    });
  }
});
const deletionPlanSchema = unsignedPlanSchema.extend({
  planHash: z.string().regex(SHA256_RE),
  proof: z.string().regex(HMAC_RE),
}).strict().superRefine((plan, context) => {
  const { planHash: _planHash, proof: _proof, ...unsigned } = plan;
  if (plan.planHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['planHash'],
      message: 'Gate workspace deletion plan hash does not match',
    });
  }
});
type GateWorkspaceDeletionPlan = z.infer<typeof deletionPlanSchema>;

const unsignedClaimSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_CLAIM_VERSION),
  workspaceId: z.string().regex(WORKSPACE_ID_RE),
  entryHash: z.string().regex(SHA256_RE),
  allocation: gateWorkspaceAllocationSchema,
  originalRootName: z.string().regex(ROOT_NAME_RE),
  quarantineName: z.string().regex(
    /^\.orch-g0-gate-quarantine-[a-f0-9]{32}-[a-f0-9]{32}$/,
  ),
  claimId: z.string().regex(/^[a-f0-9]{64}$/),
  claimantProcess: localProcessIdentitySchema,
  cleanupMode: z.enum(['OWNER', 'RECLAIMER']),
  claimedAt: z.string().datetime(),
}).strict();
const claimSchema = unsignedClaimSchema.extend({
  claimHash: z.string().regex(SHA256_RE),
  proof: z.string().regex(HMAC_RE),
}).strict().superRefine((claim, context) => {
  const { claimHash: _claimHash, proof: _proof, ...unsigned } = claim;
  if (claim.claimHash !== hashCanonicalValue(unsigned)) {
    context.addIssue({
      code: 'custom',
      path: ['claimHash'],
      message: 'Gate workspace claim hash does not match',
    });
  }
  if (
    claim.workspaceId !== claim.allocation.workspaceId
    || claim.originalRootName !== claim.allocation.rootName
  ) {
    context.addIssue({
      code: 'custom',
      path: ['allocation'],
      message: 'Gate workspace claim does not match its allocation',
    });
  }
});
type GateWorkspaceClaim = z.infer<typeof claimSchema>;

const cleanupReasonSchema = z.enum([
  'OWNER_LIVENESS_UNPROVEN',
  'SESSION_LIVENESS_UNPROVEN',
  'ROOT_OWNERSHIP_INVALID',
  'FILESYSTEM_BOUNDARY_INVALID',
  'INVENTORY_LIMIT',
  'PLAN_MISMATCH',
  'COMMAND_FAILED',
]);
export type GateWorkspaceCleanupReason = z.infer<typeof cleanupReasonSchema>;

export const gateWorkspaceCleanupResultSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_CLEANUP_VERSION),
  status: z.enum(['PASSED', 'FAILED']),
  verifiedAbsent: z.boolean(),
  resumed: z.boolean(),
  entryCount: z.number().int().nonnegative().max(16_384),
  totalFileBytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
  maxObservedDepth: z.number().int().nonnegative().max(64),
  reasonCode: cleanupReasonSchema.optional(),
}).strict().superRefine((result, context) => {
  if (
    (result.status === 'PASSED')
    !== (result.verifiedAbsent && result.reasonCode === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Gate workspace cleanup pass requires verified absence',
    });
  }
  if (result.status === 'FAILED' && result.reasonCode === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['reasonCode'],
      message: 'Failed gate workspace cleanup requires a reason',
    });
  }
});
export type GateWorkspaceCleanupResult =
  z.infer<typeof gateWorkspaceCleanupResultSchema>;

const reclaimEffectSchema = z.object({
  entryHash: z.string().regex(SHA256_RE),
  resourceHash: z.string().regex(SHA256_RE),
  outcome: z.enum([
    'ACTIVE_SKIPPED',
    'CLAIMED_BY_LIVE_RECLAIMER',
    'ALREADY_ABSENT',
    'RECLAIMED',
    'UNSAFE_RETAINED',
    'FAILED_RETAINED',
  ]),
  reasonCode: z.enum([
    'OWNER_ACTIVE',
    'RECLAIMER_ACTIVE',
    'ROOT_ALREADY_ABSENT',
    'ROOT_RECLAIMED',
    'JOURNAL_INVALID',
    'OWNER_LIVENESS_UNPROVEN',
    'SESSION_LIVENESS_UNPROVEN',
    'ROOT_OWNERSHIP_INVALID',
    'FILESYSTEM_BOUNDARY_INVALID',
    'INVENTORY_LIMIT',
    'PLAN_MISMATCH',
    'COMMAND_FAILED',
  ]),
}).strict().superRefine((effect, context) => {
  const fixedReason: Partial<Record<typeof effect.outcome, typeof effect.reasonCode>> = {
    ACTIVE_SKIPPED: 'OWNER_ACTIVE',
    CLAIMED_BY_LIVE_RECLAIMER: 'RECLAIMER_ACTIVE',
    ALREADY_ABSENT: 'ROOT_ALREADY_ABSENT',
    RECLAIMED: 'ROOT_RECLAIMED',
  };
  const expected = fixedReason[effect.outcome];
  if (expected !== undefined && effect.reasonCode !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['reasonCode'],
      message: 'Gate workspace reclaim outcome and reason do not match',
    });
  }
});
export type GateWorkspaceOrphanReclaimEffect =
  z.infer<typeof reclaimEffectSchema>;

export const gateWorkspaceOrphanReclaimReportSchema = z.object({
  schemaVersion: z.literal(GATE_WORKSPACE_ORPHAN_RECLAIM_VERSION),
  status: z.enum(['PASSED', 'FAILED']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  deadlineMs: z.number().int().min(1).max(MAX_RECLAIM_DEADLINE_MS),
  timedOut: z.boolean(),
  journalRootVerified: z.boolean(),
  managedRootVerified: z.boolean(),
  scanComplete: z.boolean(),
  scannedEntries: z.number().int().nonnegative().max(MAX_AUTHORITIES),
  activeCount: z.number().int().nonnegative().max(MAX_AUTHORITIES),
  claimedByLiveReclaimerCount: z.number().int().nonnegative().max(MAX_AUTHORITIES),
  reclaimedCount: z.number().int().nonnegative().max(MAX_AUTHORITIES),
  alreadyAbsentCount: z.number().int().nonnegative().max(MAX_AUTHORITIES),
  unsafeCount: z.number().int().nonnegative().max(MAX_AUTHORITIES),
  failedCount: z.number().int().nonnegative().max(MAX_AUTHORITIES),
  reclaimVerified: z.boolean(),
  effects: z.array(reclaimEffectSchema).max(MAX_AUTHORITIES),
}).strict().superRefine((report, context) => {
  const expected = {
    activeCount: report.effects.filter(
      (effect) => effect.outcome === 'ACTIVE_SKIPPED',
    ).length,
    claimedByLiveReclaimerCount: report.effects.filter(
      (effect) => effect.outcome === 'CLAIMED_BY_LIVE_RECLAIMER',
    ).length,
    reclaimedCount: report.effects.filter(
      (effect) => effect.outcome === 'RECLAIMED',
    ).length,
    alreadyAbsentCount: report.effects.filter(
      (effect) => effect.outcome === 'ALREADY_ABSENT',
    ).length,
    unsafeCount: report.effects.filter(
      (effect) => effect.outcome === 'UNSAFE_RETAINED',
    ).length,
    failedCount: report.effects.filter(
      (effect) => effect.outcome === 'FAILED_RETAINED',
    ).length,
  };
  for (const [field, count] of Object.entries(expected)) {
    if (report[field as keyof typeof expected] !== count) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: 'Gate workspace reclaim counters do not match effects',
      });
    }
  }
  const conserved = Object.values(expected).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (
    report.scanComplete
    && (
      report.effects.length !== report.scannedEntries
      || conserved !== report.scannedEntries
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['scannedEntries'],
      message: 'Gate workspace reclaim does not conserve entry outcomes',
    });
  }
  if (
    report.status === 'PASSED'
    && (
      !report.journalRootVerified
      || !report.managedRootVerified
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
      message: 'Gate workspace reclaim cannot pass without complete verification',
    });
  }
  if (report.reclaimVerified && report.status !== 'PASSED') {
    context.addIssue({
      code: 'custom',
      path: ['reclaimVerified'],
      message: 'Failed gate workspace reclaim cannot be verified',
    });
  }
});
export type GateWorkspaceOrphanReclaimReport =
  z.infer<typeof gateWorkspaceOrphanReclaimReportSchema>;

export interface GateWorkspaceCleanupHooks {
  /** @internal Crash-proof hook; production callers must omit it. */
  afterFirstRemoval?: () => void | Promise<void>;
  /** @internal Crash-proof hook; production callers must omit it. */
  afterJournalUnlinkBeforeClaimRelease?: () => void | Promise<void>;
}

export interface GateWorkspaceJournalTestingPorts {
  processIsLive?: (
    owner: GateWorkspaceLocalProcessIdentity,
  ) => boolean | Promise<boolean>;
  readMountId?: (fd: number) => string | number;
  /**
   * @internal Exact atomic-publication race hook. A contract test may unlink
   * tempPath to model a scanner reconciling the final+temp hardlink prefix.
   */
  afterClaimPublicationLink?: (publication: {
    claimPath: string;
    tempPath: string;
    claimHash: string;
  }) => void;
}

export interface GateWorkspaceOrphanJournalStoreOptions {
  journalRoot?: string;
  managedRoot?: string;
  /** @internal Deterministic contract-test ports. */
  testing?: GateWorkspaceJournalTestingPorts;
}

interface JournalFile<T> {
  path: string;
  stat: BigIntStats;
  value: T;
}

interface AuthorityFiles {
  entry: JournalFile<GateWorkspaceJournalEntry>;
  binding: JournalFile<GateWorkspaceBinding> | null;
  plan: JournalFile<GateWorkspaceDeletionPlan> | null;
  claim: JournalFile<GateWorkspaceClaim> | null;
  sessions: Array<JournalFile<GateWorkspaceSession>>;
  owners: Array<JournalFile<GateWorkspaceSessionOwner>>;
}

interface JournalInventory {
  authorities: AuthorityFiles[];
  orphanClaims: Array<JournalFile<GateWorkspaceClaim>>;
  admission: JournalFile<GateWorkspaceAdmission> | null;
}

class WorkspaceSafetyError extends Error {
  constructor(
    readonly reasonCode: GateWorkspaceCleanupReason,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSafetyError';
  }
}

class ManagedRootPhaseError extends Error {
  constructor(
    readonly violations: Array<{
      entryHash: string;
      allocation: GateWorkspaceAllocation;
    }>,
    readonly scannedEntries: number,
  ) {
    super('Gate workspace managed names do not match legal journal phases');
    this.name = 'ManagedRootPhaseError';
  }
}

class InjectedCrashError extends Error {
  constructor(readonly causeValue: unknown) {
    super('Gate workspace crash-proof hook interrupted cleanup');
    this.name = 'InjectedCrashError';
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, 'utf8');
}

function capabilityProof(capability: string, value: unknown): string {
  return `hmac-sha256:${
    createHmac('sha256', Buffer.from(capability, 'base64url'))
      .update(canonicalBytes(value))
      .digest('hex')
  }`;
}

function proofMatches(
  capability: string,
  value: unknown,
  proof: string,
): boolean {
  const expected = Buffer.from(capabilityProof(capability, value), 'utf8');
  const observed = Buffer.from(proof, 'utf8');
  return expected.byteLength === observed.byteLength
    && timingSafeEqual(expected, observed);
}

function fsIdentity(stat: BigIntStats): GateWorkspaceFsIdentity {
  return fsIdentitySchema.parse({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: stat.uid.toString(),
    mode: Number(stat.mode & 0o7777n),
  });
}

function stableIdentityMatches(
  stat: BigIntStats,
  identity: GateWorkspaceFsIdentity,
): boolean {
  return stat.dev.toString() === identity.dev
    && stat.ino.toString() === identity.ino
    && stat.uid.toString() === identity.uid
    && Number(stat.mode & 0o7777n) === identity.mode;
}

function journalFileIdentityMatches(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && (left.mode & 0o7777n) === (right.mode & 0o7777n);
}

function expectedUid(stat: BigIntStats): bigint {
  return typeof process.getuid === 'function'
    ? BigInt(process.getuid())
    : stat.uid;
}

function fsyncDirectoryFd(fd: number): void {
  fsyncSync(fd);
}

function fsyncDirectoryPath(path: string): void {
  const fd = openSync(
    path,
    fsConstants.O_RDONLY
      | fsConstants.O_DIRECTORY
      | fsConstants.O_NOFOLLOW,
  );
  try {
    fsyncDirectoryFd(fd);
  } finally {
    closeSync(fd);
  }
}

function createOrVerifyPrivateRoot(path: string, label: string): {
  path: string;
  stat: BigIntStats;
} {
  const resolved = resolve(path);
  let created = false;
  try {
    mkdirSync(resolved, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created) {
    chmodSync(resolved, 0o700);
    fsyncDirectoryPath(dirname(resolved));
  }
  const actual = realpathSync(resolved);
  if (actual !== resolved) throw new Error(`${label} root is redirected`);
  const stat = lstatSync(actual, { bigint: true });
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid(stat)
    || (stat.mode & 0o777n) !== 0o700n
  ) {
    throw new Error(`${label} root is not a private owned directory`);
  }
  return { path: actual, stat };
}

function assertPrivateRootIdentity(
  path: string,
  expected: BigIntStats,
  label: string,
): void {
  const actual = realpathSync(resolve(path));
  if (actual !== path) throw new Error(`${label} root is redirected`);
  const stat = lstatSync(actual, { bigint: true });
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid(stat)
    || (stat.mode & 0o777n) !== 0o700n
    || stat.dev !== expected.dev
    || stat.ino !== expected.ino
    || stat.uid !== expected.uid
  ) {
    throw new Error(`${label} root identity changed`);
  }
}

function writePrivateFileAtomically(
  path: string,
  value: unknown,
  maxBytes = MAX_SMALL_JOURNAL_BYTES,
  afterLinkBeforeTempUnlink?: (tempPath: string) => void,
): BigIntStats {
  const parent = resolve(dirname(path));
  const temp = join(
    parent,
    `.${basename(path)}.tmp.${randomBytes(32).toString('hex')}`,
  );
  const bytes = canonicalBytes(value);
  if (bytes.byteLength < 2 || bytes.byteLength > maxBytes) {
    throw new RangeError('Gate workspace journal file exceeds its byte limit');
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
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== expectedUid(stat)
      || stat.nlink !== 1n
      || (stat.mode & 0o777n) !== 0o600n
      || stat.size !== BigInt(bytes.byteLength)
    ) {
      throw new Error('Gate workspace temp journal file is not exact');
    }
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
  afterLinkBeforeTempUnlink?.(temp);
  unlinkSync(temp);
  fsyncDirectoryPath(parent);
  const result = lstatSync(path, { bigint: true });
  if (
    !result.isFile()
    || result.isSymbolicLink()
    || result.uid !== expectedUid(result)
    || result.nlink !== 1n
    || (result.mode & 0o777n) !== 0o600n
  ) {
    throw new Error('Gate workspace journal file changed after publication');
  }
  return result;
}

function readPrivateJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes = MAX_SMALL_JOURNAL_BYTES,
  pairedPublicationTemp?: BigIntStats,
): JournalFile<T> {
  const before = lstatSync(path, { bigint: true });
  const expectedNlink = pairedPublicationTemp ? 2n : 1n;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== expectedUid(before)
    || before.nlink !== expectedNlink
    || (before.mode & 0o777n) !== 0o600n
    || before.size < 2n
    || before.size > BigInt(maxBytes)
    || (
      pairedPublicationTemp !== undefined
      && (
        before.dev !== pairedPublicationTemp.dev
        || before.ino !== pairedPublicationTemp.ino
        || before.uid !== pairedPublicationTemp.uid
        || before.size !== pairedPublicationTemp.size
        || (before.mode & 0o7777n)
          !== (pairedPublicationTemp.mode & 0o7777n)
        || pairedPublicationTemp.nlink !== 2n
      )
    )
  ) {
    throw new Error('Gate workspace journal file is not private and exact');
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (
    !journalFileIdentityMatches(before, after)
    || bytes.byteLength !== Number(before.size)
  ) {
    throw new Error('Gate workspace journal file changed while being read');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Gate workspace journal file is not valid JSON');
  }
  return { path, stat: after, value: schema.parse(value) };
}

function unlinkPrivateFileExact(
  file: JournalFile<unknown>,
  journalRoot: string,
): void {
  const current = lstatSync(file.path, { bigint: true });
  if (!journalFileIdentityMatches(current, file.stat)) {
    throw new Error('Gate workspace journal file changed before unlink');
  }
  unlinkSync(file.path);
  fsyncDirectoryPath(journalRoot);
}

function readBoundedDirectoryNames(path: string, max: number): string[] {
  const names: string[] = [];
  const directory = opendirSync(path);
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > max) {
        throw new Error('Gate workspace directory exceeds its inventory limit');
      }
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function entryPath(root: string, workspaceId: string): string {
  return join(root, `${workspaceId}.entry.json`);
}

function bindingPath(root: string, workspaceId: string): string {
  return join(root, `${workspaceId}.binding.json`);
}

function planPath(root: string, workspaceId: string): string {
  return join(root, `${workspaceId}.plan.json`);
}

function claimPath(root: string, workspaceId: string): string {
  return join(root, `${workspaceId}.claim.json`);
}

function sessionPath(
  root: string,
  workspaceId: string,
  sessionId: string,
): string {
  return join(root, `${workspaceId}.${sessionId}.session.json`);
}

function ownerPath(
  root: string,
  workspaceId: string,
  sessionId: string,
): string {
  return join(root, `${workspaceId}.${sessionId}.owner.json`);
}

function anchoredPath(fd: number, relativePath?: string): string {
  const root = `/proc/self/fd/${fd}`;
  return relativePath === undefined ? root : join(root, relativePath);
}

function defaultReadMountId(fd: number): string {
  const bytes = readFileSync(`/proc/self/fdinfo/${fd}`);
  if (bytes.byteLength > 16 * 1024) {
    throw new Error('Linux fdinfo exceeds its fixed byte limit');
  }
  const match = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(bytes.toString('utf8'));
  if (!match) throw new Error('Linux fdinfo does not expose mnt_id');
  return match[1]!;
}

function normalizeMountId(value: string | number): string {
  const normalized = String(value);
  if (!MOUNT_ID_RE.test(normalized)) {
    throw new Error('Gate workspace mount id is invalid');
  }
  return normalized;
}

function openDirectoryNoFollow(path: string): number {
  return openSync(
    path,
    fsConstants.O_RDONLY
      | fsConstants.O_DIRECTORY
      | fsConstants.O_NOFOLLOW,
  );
}

async function currentLocalProcessIdentity():
Promise<GateWorkspaceLocalProcessIdentity> {
  const [host, processIdentity] = await Promise.all([
    readLocalProcessHostIdentity(),
    readLinuxProcessIdentity(process.pid),
  ]);
  if (!processIdentity) {
    throw new Error('Current gate workspace process identity is unavailable');
  }
  return localProcessIdentitySchema.parse({
    hostId: host.hostId,
    hostBootId: host.hostBootId,
    pidNamespaceId: processIdentity.pidNamespaceId,
    pid: processIdentity.pid,
    processStartToken: processIdentity.processStartToken,
  });
}

function sameLocalProcess(
  left: GateWorkspaceLocalProcessIdentity,
  right: GateWorkspaceLocalProcessIdentity,
): boolean {
  return left.hostId === right.hostId
    && left.hostBootId === right.hostBootId
    && left.pidNamespaceId === right.pidNamespaceId
    && left.pid === right.pid
    && left.processStartToken === right.processStartToken;
}

function ownerFromProcessClaim(
  owner: AttemptProcessOwnerDoc,
): GateWorkspaceJournalProcessOwner {
  if (
    owner.mode !== 'PROCESS_GROUP'
    || owner.pidNamespaceId === undefined
    || owner.sid === undefined
    || owner.pid !== owner.pgid
    || owner.pid !== owner.sid
  ) {
    throw new Error('Gate workspace requires an exact PROCESS_GROUP owner');
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

function processOwnerDoc(
  owner: GateWorkspaceJournalProcessOwner,
): AttemptProcessOwnerDoc {
  return {
    ...owner,
    registeredAt: new Date(owner.registeredAt),
    startedAt: new Date(owner.startedAt),
  };
}

function resolvedLimits(
  input: Partial<GateWorkspaceLimits> | undefined,
): GateWorkspaceLimits {
  return gateWorkspaceLimitsSchema.parse({
    ...DEFAULT_LIMITS,
    ...input,
  });
}

function quarantineName(allocation: GateWorkspaceAllocation): string {
  const suffix = createHmac(
    'sha256',
    Buffer.from(allocation.cleanupCapability, 'base64url'),
  ).update(`quarantine:${allocation.workspaceId}`).digest('hex').slice(0, 32);
  return `.orch-g0-gate-quarantine-${
    allocation.workspaceId.slice('g0ws_'.length)
  }-${suffix}`;
}

export function defaultGateWorkspaceOrphanJournalRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(
    tmpdir(),
    `orch-g0-gate-workspace-journal-${JOURNAL_DIRECTORY_VERSION}-${uid}`,
  );
}

export function defaultGateWorkspaceManagedRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(
    tmpdir(),
    `orch-g0-gate-workspaces-${MANAGED_DIRECTORY_VERSION}-${uid}`,
  );
}

export class GateWorkspaceOrphanJournalStore {
  readonly journalRoot: string;
  readonly managedRoot: string;

  private readonly journalRootStat: BigIntStats;
  private readonly managedRootStat: BigIntStats;
  private readonly testing: GateWorkspaceJournalTestingPorts;

  constructor(options: GateWorkspaceOrphanJournalStoreOptions = {}) {
    if (process.platform !== 'linux') {
      throw new Error('Gate workspace orphan recovery requires Linux');
    }
    const journal = createOrVerifyPrivateRoot(
      options.journalRoot ?? defaultGateWorkspaceOrphanJournalRoot(),
      'Gate workspace journal',
    );
    const managed = createOrVerifyPrivateRoot(
      options.managedRoot ?? defaultGateWorkspaceManagedRoot(),
      'Gate workspace managed',
    );
    if (
      journal.path === managed.path
      || (journal.stat.dev === managed.stat.dev
        && journal.stat.ino === managed.stat.ino)
    ) {
      throw new Error('Gate workspace journal and managed roots must be distinct');
    }
    this.journalRoot = journal.path;
    this.managedRoot = managed.path;
    this.journalRootStat = journal.stat;
    this.managedRootStat = managed.stat;
    this.testing = options.testing ?? {};
  }

  private assertRoots(): void {
    assertPrivateRootIdentity(
      this.journalRoot,
      this.journalRootStat,
      'Gate workspace journal',
    );
    assertPrivateRootIdentity(
      this.managedRoot,
      this.managedRootStat,
      'Gate workspace managed',
    );
  }

  private mountId(fd: number): string {
    return normalizeMountId(
      this.testing.readMountId?.(fd) ?? defaultReadMountId(fd),
    );
  }

  private async processIsLive(
    owner: GateWorkspaceLocalProcessIdentity,
  ): Promise<boolean> {
    if (this.testing.processIsLive) {
      return await this.testing.processIsLive(owner);
    }
    const local = await readLocalProcessHostIdentity();
    if (owner.hostId !== local.hostId) {
      throw new Error('Gate workspace process host cannot be reconciled');
    }
    if (owner.hostBootId !== local.hostBootId) return false;
    if (owner.pidNamespaceId !== local.pidNamespaceId) {
      throw new Error(
        'Gate workspace PID namespace changed without a host reboot',
      );
    }
    const current = await readLinuxProcessIdentity(owner.pid);
    return current !== null
      && current.pidNamespaceId === owner.pidNamespaceId
      && current.processStartToken === owner.processStartToken;
  }

  private assertAllocation(
    input: GateWorkspaceAllocation,
  ): GateWorkspaceAllocation {
    const allocation = gateWorkspaceAllocationSchema.parse(input);
    if (
      allocation.managedRootHash !== hashCanonicalValue(this.managedRoot)
      || allocation.rootPath !== join(this.managedRoot, allocation.rootName)
      || !isAbsolute(allocation.rootPath)
      || dirname(allocation.rootPath) !== this.managedRoot
    ) {
      throw new WorkspaceSafetyError(
        'ROOT_OWNERSHIP_INVALID',
        'Gate workspace allocation belongs to another managed root',
      );
    }
    return allocation;
  }

  private unlinkExact(file: JournalFile<unknown>): void {
    this.assertRoots();
    unlinkPrivateFileExact(file, this.journalRoot);
    this.assertRoots();
  }

  private verifyEntry(
    file: JournalFile<GateWorkspaceJournalEntry>,
  ): void {
    this.assertAllocation(file.value.allocation);
    if (
      basename(file.path) !== `${file.value.allocation.workspaceId}.entry.json`
    ) {
      throw new Error('Gate workspace entry filename does not match');
    }
  }

  private verifyBinding(
    binding: GateWorkspaceBinding,
    entry: GateWorkspaceJournalEntry,
  ): void {
    const { proof: _proof, ...unsignedWithHash } = binding;
    if (
      binding.workspaceId !== entry.allocation.workspaceId
      || binding.entryHash !== entry.entryHash
      || binding.allocationHash !== hashCanonicalValue(entry.allocation)
      || !proofMatches(
        entry.allocation.cleanupCapability,
        unsignedWithHash,
        binding.proof,
      )
    ) {
      throw new Error('Gate workspace binding authority is invalid');
    }
  }

  private verifySession(
    session: GateWorkspaceSession,
    entry: GateWorkspaceJournalEntry,
  ): void {
    const { proof: _proof, ...unsignedWithHash } = session;
    if (
      session.workspaceId !== entry.allocation.workspaceId
      || session.entryHash !== entry.entryHash
      || !proofMatches(
        entry.allocation.cleanupCapability,
        unsignedWithHash,
        session.proof,
      )
    ) {
      throw new Error('Gate workspace session authority is invalid');
    }
  }

  private verifySessionOwner(
    owner: GateWorkspaceSessionOwner,
    session: GateWorkspaceSession,
    entry: GateWorkspaceJournalEntry,
  ): void {
    const { proof: _proof, ...unsignedWithHash } = owner;
    if (
      owner.workspaceId !== entry.allocation.workspaceId
      || owner.sessionId !== session.sessionId
      || owner.sessionHash !== session.sessionHash
      || owner.owner.processExecutionId !== session.processExecutionId
      || owner.owner.runtimeRunId !== session.runtimeRunId
      || !proofMatches(
        entry.allocation.cleanupCapability,
        unsignedWithHash,
        owner.proof,
      )
    ) {
      throw new Error('Gate workspace session owner authority is invalid');
    }
  }

  private verifyPlan(
    plan: GateWorkspaceDeletionPlan,
    entry: GateWorkspaceJournalEntry,
    binding: GateWorkspaceBinding,
  ): void {
    const { proof: _proof, ...unsignedWithHash } = plan;
    if (
      plan.workspaceId !== entry.allocation.workspaceId
      || plan.entryHash !== entry.entryHash
      || plan.bindingHash !== binding.bindingHash
      || plan.originalRootName !== entry.allocation.rootName
      || plan.quarantineName !== quarantineName(entry.allocation)
      || plan.entryCount > entry.allocation.limits.maxEntries
      || plan.totalFileBytes > entry.allocation.limits.maxTotalFileBytes
      || plan.totalPathBytes > entry.allocation.limits.maxTotalPathBytes
      || plan.maxObservedDepth > entry.allocation.limits.maxDepth
      || !proofMatches(
        entry.allocation.cleanupCapability,
        unsignedWithHash,
        plan.proof,
      )
    ) {
      throw new Error('Gate workspace deletion plan authority is invalid');
    }
  }

  private verifyClaim(
    claim: GateWorkspaceClaim,
    entry?: GateWorkspaceJournalEntry,
  ): void {
    const { proof: _proof, ...unsignedWithHash } = claim;
    if (
      (entry !== undefined
        && (
          claim.entryHash !== entry.entryHash
          || hashCanonicalValue(claim.allocation)
            !== hashCanonicalValue(entry.allocation)
        ))
      || claim.quarantineName !== quarantineName(claim.allocation)
      || !proofMatches(
        claim.allocation.cleanupCapability,
        unsignedWithHash,
        claim.proof,
      )
    ) {
      throw new Error('Gate workspace claim authority is invalid');
    }
    this.assertAllocation(claim.allocation);
  }

  private inspectRecognizedTemps(
    names: readonly string[],
  ): {
    files: Array<JournalFile<undefined>>;
    pairedByFinalName: Map<string, BigIntStats>;
  } {
    const files: Array<JournalFile<undefined>> = [];
    const pairedByFinalName = new Map<string, BigIntStats>();
    const namesSet = new Set(names);
    for (const name of names) {
      const match = TEMP_RE.exec(name);
      if (!match) continue;
      const path = join(this.journalRoot, name);
      const stat = lstatSync(path, { bigint: true });
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.uid !== expectedUid(stat)
        || (stat.mode & 0o777n) !== 0o600n
        || (stat.nlink !== 1n && stat.nlink !== 2n)
        || stat.size > BigInt(MAX_PLAN_BYTES)
      ) {
        throw new Error('Gate workspace journal temp is not private and exact');
      }
      const finalName = match[1]!;
      const finalExists = namesSet.has(finalName);
      if (stat.nlink === 2n) {
        if (pairedByFinalName.has(finalName) || !finalExists) {
          throw new Error(
            'Gate workspace journal paired publication is ambiguous',
          );
        }
        const finalStat = lstatSync(
          join(this.journalRoot, finalName),
          { bigint: true },
        );
        if (
          !journalFileIdentityMatches(stat, finalStat)
          || !finalStat.isFile()
          || finalStat.isSymbolicLink()
          || finalStat.uid !== expectedUid(finalStat)
          || (finalStat.mode & 0o777n) !== 0o600n
        ) {
          throw new Error(
            'Gate workspace journal temp/final publication pair is not exact',
          );
        }
        pairedByFinalName.set(finalName, stat);
      }
      files.push({ path, stat, value: undefined });
    }
    return { files, pairedByFinalName };
  }

  private assertManagedRootInventory(
    authorities: readonly AuthorityFiles[],
    orphanClaims: readonly JournalFile<GateWorkspaceClaim>[],
  ): void {
    const allowed = new Set<string>();
    for (const authority of authorities) {
      const allocation = authority.entry.value.allocation;
      allowed.add(allocation.rootName);
      allowed.add(quarantineName(allocation));
    }
    for (const claim of orphanClaims) {
      allowed.add(claim.value.originalRootName);
      allowed.add(claim.value.quarantineName);
    }
    const names = readBoundedDirectoryNames(
      this.managedRoot,
      MAX_AUTHORITIES * 2,
    );
    const present = new Set(names);
    const phaseViolations: Array<{
      entryHash: string;
      allocation: GateWorkspaceAllocation;
    }> = [];
    for (const authority of authorities) {
      const allocation = authority.entry.value.allocation;
      const originalPresent = present.has(allocation.rootName);
      const quarantinePresent = present.has(quarantineName(allocation));
      if (
        (originalPresent && quarantinePresent)
        || (
          quarantinePresent
          && (!authority.binding || !authority.plan)
        )
      ) {
        phaseViolations.push({
          entryHash: authority.entry.value.entryHash,
          allocation,
        });
      }
    }
    for (const claim of orphanClaims) {
      if (
        present.has(claim.value.originalRootName)
        || present.has(claim.value.quarantineName)
      ) {
        phaseViolations.push({
          entryHash: claim.value.entryHash,
          allocation: claim.value.allocation,
        });
      }
    }
    const managedFd = openDirectoryNoFollow(this.managedRoot);
    try {
      const managedMountId = this.mountId(managedFd);
      for (const name of names) {
        if (!allowed.has(name)) {
          throw new Error(
            'Gate workspace managed root contains an unknown child',
          );
        }
        const path = anchoredPath(managedFd, name);
        const stat = lstatSync(path, { bigint: true });
        if (
          !stat.isDirectory()
          || stat.isSymbolicLink()
          || stat.uid !== expectedUid(stat)
          || (stat.mode & 0o777n) !== 0o700n
        ) {
          throw new Error(
            'Gate workspace managed root child is not an exact private directory',
          );
        }
        const childFd = openDirectoryNoFollow(path);
        try {
          const confirmed = fstatSync(childFd, { bigint: true });
          if (
            !stableIdentityMatches(confirmed, fsIdentity(stat))
            || this.mountId(childFd) !== managedMountId
          ) {
            throw new Error(
              'Gate workspace managed child identity or mount differs',
            );
          }
        } finally {
          closeSync(childFd);
        }
      }
    } finally {
      closeSync(managedFd);
    }
    if (phaseViolations.length > 0) {
      throw new ManagedRootPhaseError(
        phaseViolations,
        authorities.length + orphanClaims.length,
      );
    }
  }

  private readInventory(allowTempRecovery = true): JournalInventory {
    this.assertRoots();
    const names = readBoundedDirectoryNames(
      this.journalRoot,
      MAX_JOURNAL_DIRENTS,
    );
    if (names.some((name) =>
      !ENTRY_RE.test(name)
      && !BINDING_RE.test(name)
      && !PLAN_RE.test(name)
      && !CLAIM_RE.test(name)
      && !SESSION_RE.test(name)
      && !OWNER_RE.test(name)
      && name !== ADMISSION_FILE_NAME
      && !TEMP_RE.test(name))) {
      throw new Error('Gate workspace journal contains an unrecognized entry');
    }
    const temps = this.inspectRecognizedTemps(names);
    if (!allowTempRecovery && temps.files.length > 0) {
      throw new Error(
        'Gate workspace journal temp survived publication recovery',
      );
    }
    const persistentNames = names.filter((name) => !TEMP_RE.test(name));
    const readJournalJson = <T>(
      name: string,
      schema: z.ZodType<T>,
      maxBytes = MAX_SMALL_JOURNAL_BYTES,
    ): JournalFile<T> => readPrivateJson(
      join(this.journalRoot, name),
      schema,
      maxBytes,
      temps.pairedByFinalName.get(name),
    );
    const admission = persistentNames.includes(ADMISSION_FILE_NAME)
      ? readJournalJson(ADMISSION_FILE_NAME, admissionSchema)
      : null;

    const entries = persistentNames
      .filter((name) => ENTRY_RE.test(name))
      .map((name) => readJournalJson(name, journalEntrySchema));
    if (entries.length > MAX_AUTHORITIES) {
      throw new Error('Gate workspace journal exceeds its authority limit');
    }
    entries.forEach((entry) => this.verifyEntry(entry));

    const bindings = new Map<string, JournalFile<GateWorkspaceBinding>>();
    const plans = new Map<string, JournalFile<GateWorkspaceDeletionPlan>>();
    const claims = new Map<string, JournalFile<GateWorkspaceClaim>>();
    const sessions = new Map<
      string,
      Array<JournalFile<GateWorkspaceSession>>
    >();
    const owners = new Map<
      string,
      Array<JournalFile<GateWorkspaceSessionOwner>>
    >();

    for (const name of persistentNames.filter((item) => BINDING_RE.test(item))) {
      const match = BINDING_RE.exec(name)!;
      const file = readJournalJson(name, bindingSchema);
      if (file.value.workspaceId !== match[1]) {
        throw new Error('Gate workspace binding filename does not match');
      }
      if (bindings.has(match[1]!)) {
        throw new Error('Gate workspace has duplicate bindings');
      }
      bindings.set(match[1]!, file);
    }
    for (const name of persistentNames.filter((item) => PLAN_RE.test(item))) {
      const match = PLAN_RE.exec(name)!;
      const file = readJournalJson(name, deletionPlanSchema, MAX_PLAN_BYTES);
      if (file.value.workspaceId !== match[1]) {
        throw new Error('Gate workspace plan filename does not match');
      }
      if (plans.has(match[1]!)) {
        throw new Error('Gate workspace has duplicate plans');
      }
      plans.set(match[1]!, file);
    }
    for (const name of persistentNames.filter((item) => CLAIM_RE.test(item))) {
      const match = CLAIM_RE.exec(name)!;
      const file = readJournalJson(name, claimSchema);
      if (file.value.workspaceId !== match[1]) {
        throw new Error('Gate workspace claim filename does not match');
      }
      if (claims.has(match[1]!)) {
        throw new Error('Gate workspace has duplicate claims');
      }
      claims.set(match[1]!, file);
    }
    for (const name of persistentNames.filter((item) => SESSION_RE.test(item))) {
      const match = SESSION_RE.exec(name)!;
      const file = readJournalJson(name, sessionSchema);
      if (
        file.value.workspaceId !== match[1]
        || file.value.sessionId !== match[2]
      ) {
        throw new Error('Gate workspace session filename does not match');
      }
      const bucket = sessions.get(match[1]!) ?? [];
      bucket.push(file);
      sessions.set(match[1]!, bucket);
    }
    for (const name of persistentNames.filter((item) => OWNER_RE.test(item))) {
      const match = OWNER_RE.exec(name)!;
      const file = readJournalJson(name, sessionOwnerSchema);
      if (
        file.value.workspaceId !== match[1]
        || file.value.sessionId !== match[2]
      ) {
        throw new Error('Gate workspace owner filename does not match');
      }
      const bucket = owners.get(match[1]!) ?? [];
      bucket.push(file);
      owners.set(match[1]!, bucket);
    }

    const authorities: AuthorityFiles[] = [];
    for (const entry of entries) {
      const workspaceId = entry.value.allocation.workspaceId;
      const binding = bindings.get(workspaceId) ?? null;
      const plan = plans.get(workspaceId) ?? null;
      const claim = claims.get(workspaceId) ?? null;
      const authoritySessions = sessions.get(workspaceId) ?? [];
      const authorityOwners = owners.get(workspaceId) ?? [];
      if (authoritySessions.length > entry.value.allocation.limits.maxSessions) {
        throw new Error('Gate workspace exceeds its session limit');
      }
      if (binding) this.verifyBinding(binding.value, entry.value);
      if (claim) this.verifyClaim(claim.value, entry.value);
      for (const session of authoritySessions) {
        this.verifySession(session.value, entry.value);
      }
      const sessionsById = new Map(
        authoritySessions.map((session) =>
          [session.value.sessionId, session] as const),
      );
      for (const owner of authorityOwners) {
        const session = sessionsById.get(owner.value.sessionId);
        if (!session) {
          throw new Error('Gate workspace owner has no session intent');
        }
        this.verifySessionOwner(owner.value, session.value, entry.value);
      }
      if (
        new Set(authorityOwners.map((owner) => owner.value.sessionId)).size
        !== authorityOwners.length
      ) {
        throw new Error('Gate workspace has duplicate session owners');
      }
      if (plan) {
        if (!binding) {
          throw new Error('Gate workspace plan has no ready binding');
        }
        this.verifyPlan(plan.value, entry.value, binding.value);
      }
      authorities.push({
        entry,
        binding,
        plan,
        claim,
        sessions: authoritySessions,
        owners: authorityOwners,
      });
      bindings.delete(workspaceId);
      plans.delete(workspaceId);
      claims.delete(workspaceId);
      sessions.delete(workspaceId);
      owners.delete(workspaceId);
    }

    if (
      bindings.size > 0
      || plans.size > 0
      || sessions.size > 0
      || owners.size > 0
    ) {
      throw new Error('Gate workspace journal has authority without an entry');
    }
    const orphanClaims = [...claims.values()];
    for (const claim of orphanClaims) this.verifyClaim(claim.value);
    if (authorities.length + orphanClaims.length > MAX_AUTHORITIES) {
      throw new Error('Gate workspace journal exceeds its authority limit');
    }
    // No mutation is permitted before both authority sets and the complete
    // managed-root inventory have passed their bounded, typed checks.
    this.assertManagedRootInventory(authorities, orphanClaims);
    for (const temp of temps.files) this.unlinkExact(temp);
    const afterTempCleanup = readBoundedDirectoryNames(
      this.journalRoot,
      MAX_JOURNAL_DIRENTS,
    );
    if (
      afterTempCleanup.length !== persistentNames.length
      || afterTempCleanup.some((name, index) => name !== persistentNames[index])
    ) {
      throw new Error(
        'Gate workspace journal changed during temp terminalization',
      );
    }
    this.assertRoots();
    if (temps.files.length > 0) {
      // Refresh every JournalFile stat after nlink=2 pair terminalization and
      // repeat the complete typed scan with no recovery mutation permitted.
      return this.readInventory(false);
    }
    return { authorities, orphanClaims, admission };
  }

  private readAuthority(
    allocationInput: GateWorkspaceAllocation,
  ): AuthorityFiles {
    const allocation = this.assertAllocation(allocationInput);
    const inventory = this.readInventory();
    const authority = inventory.authorities.find(
      (item) =>
        item.entry.value.allocation.workspaceId === allocation.workspaceId,
    );
    if (
      !authority
      || hashCanonicalValue(authority.entry.value.allocation)
        !== hashCanonicalValue(allocation)
    ) {
      throw new Error('Gate workspace journal entry does not match allocation');
    }
    return authority;
  }

  private async acquireAdmission():
  Promise<JournalFile<GateWorkspaceAdmission>> {
    const path = join(this.journalRoot, ADMISSION_FILE_NAME);
    for (let attempt = 0; attempt < 4; attempt++) {
      const inventory = this.readInventory();
      if (inventory.admission) {
        let live: boolean;
        try {
          live = await this.processIsLive(
            inventory.admission.value.claimantProcess,
          );
        } catch {
          throw new WorkspaceSafetyError(
            'OWNER_LIVENESS_UNPROVEN',
            'Gate workspace admission claimant liveness is unknown',
          );
        }
        if (live) {
          throw new WorkspaceSafetyError(
            'COMMAND_FAILED',
            'Gate workspace admission is held by a live creator',
          );
        }
        // Inventory has already authenticated every authority and checked the
        // managed root.  Removing a dead admission mutates no managed target.
        this.unlinkExact(inventory.admission);
        continue;
      }
      const unsigned = unsignedAdmissionSchema.parse({
        schemaVersion: GATE_WORKSPACE_ADMISSION_VERSION,
        admissionId: randomBytes(32).toString('hex'),
        claimantProcess: await currentLocalProcessIdentity(),
        claimedAt: new Date().toISOString(),
      });
      const admission = admissionSchema.parse({
        ...unsigned,
        admissionHash: hashCanonicalValue(unsigned),
      });
      try {
        const stat = writePrivateFileAtomically(path, admission);
        return { path, stat, value: admission };
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST'
          && !existsSync(path)
        ) {
          throw error;
        }
        // A scanner may have reconciled this writer's link-success temp before
        // unlinkSync(temp) returned.  Recover the exact same admission rather
        // than misclassifying the current creator as a live peer.
        const afterRace = this.readInventory().admission;
        if (
          afterRace
          && afterRace.value.admissionHash === admission.admissionHash
          && sameLocalProcess(
            afterRace.value.claimantProcess,
            admission.claimantProcess,
          )
        ) {
          return afterRace;
        }
        // A concurrent creator won the fixed-name filesystem CAS.  Re-read
        // and classify its exact admission rather than using a stale count.
      }
    }
    throw new WorkspaceSafetyError(
      'COMMAND_FAILED',
      'Gate workspace admission did not converge',
    );
  }

  private releaseAdmission(
    admission: JournalFile<GateWorkspaceAdmission>,
  ): void {
    if (!existsSync(admission.path)) {
      throw new Error('Gate workspace admission disappeared before release');
    }
    const current = readPrivateJson(admission.path, admissionSchema);
    if (
      current.value.admissionHash !== admission.value.admissionHash
      || !journalFileIdentityMatches(current.stat, admission.stat)
    ) {
      throw new Error('Gate workspace admission changed before release');
    }
    this.unlinkExact(current);
  }

  async createOwnedRoot(input: {
    limits?: Partial<GateWorkspaceLimits>;
  } = {}): Promise<{ allocation: GateWorkspaceAllocation; root: string }> {
    this.assertRoots();
    const workspaceId = `g0ws_${randomBytes(16).toString('hex')}`;
    const rootName = `orch-g0-gate-${workspaceId.slice('g0ws_'.length)}`;
    const rootPath = join(this.managedRoot, rootName);
    if (existsSync(rootPath)) {
      throw new Error('Fresh gate workspace root unexpectedly exists');
    }
    const cleanupCapability = randomBytes(32).toString('base64url');
    const allocation = gateWorkspaceAllocationSchema.parse({
      schemaVersion: GATE_WORKSPACE_ALLOCATION_VERSION,
      workspaceId,
      rootName,
      rootPath,
      managedRootHash: hashCanonicalValue(this.managedRoot),
      cleanupCapability,
      cleanupCapabilityHash: hashCanonicalValue(cleanupCapability),
      limits: resolvedLimits(input.limits),
      allocatedAt: new Date().toISOString(),
    });
    const admission = await this.acquireAdmission();
    let entry: GateWorkspaceJournalEntry;
    try {
      const inventory = this.readInventory();
      if (
        !inventory.admission
        || inventory.admission.value.admissionHash
          !== admission.value.admissionHash
      ) {
        throw new Error('Gate workspace admission changed before entry publish');
      }
      if (
        inventory.authorities.length + inventory.orphanClaims.length
        >= MAX_AUTHORITIES
      ) {
        throw new Error('Gate workspace journal authority limit is exhausted');
      }
      const unsignedEntry = unsignedEntrySchema.parse({
        schemaVersion: GATE_WORKSPACE_JOURNAL_ENTRY_VERSION,
        allocation,
        parentProcess: admission.value.claimantProcess,
        preparedAt: new Date().toISOString(),
      });
      entry = journalEntrySchema.parse({
        ...unsignedEntry,
        entryHash: hashCanonicalValue(unsignedEntry),
      });

      // The durable intent is visible before mkdir. Recovery can therefore
      // distinguish an unmaterialized allocation from an unowned /tmp path.
      writePrivateFileAtomically(
      entryPath(this.journalRoot, workspaceId),
        entry,
      );
    } finally {
      this.releaseAdmission(admission);
    }

    const managedFd = openDirectoryNoFollow(this.managedRoot);
    let rootFd: number | null = null;
    try {
      const managedMountId = this.mountId(managedFd);
      mkdirSync(anchoredPath(managedFd, rootName), { mode: 0o700 });
      chmodSync(anchoredPath(managedFd, rootName), 0o700);
      fsyncDirectoryFd(managedFd);
      rootFd = openDirectoryNoFollow(anchoredPath(managedFd, rootName));
      const rootStat = fstatSync(rootFd, { bigint: true });
      const rootMountId = this.mountId(rootFd);
      if (
        !rootStat.isDirectory()
        || rootStat.isSymbolicLink()
        || rootStat.uid !== expectedUid(rootStat)
        || (rootStat.mode & 0o777n) !== 0o700n
        || rootMountId !== managedMountId
      ) {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Fresh gate workspace root is not an exact private directory',
        );
      }
      const unsignedMarker = unsignedMarkerSchema.parse({
        schemaVersion: GATE_WORKSPACE_MARKER_VERSION,
        workspaceId,
        entryHash: entry.entryHash,
        allocationHash: hashCanonicalValue(allocation),
        rootPathHash: hashCanonicalValue(rootPath),
        rootIdentity: fsIdentity(rootStat),
        rootMountId,
        createdAt: new Date().toISOString(),
      });
      const marker = markerSchema.parse({
        ...unsignedMarker,
        proof: capabilityProof(cleanupCapability, unsignedMarker),
      });
      const markerPath = join(rootPath, GATE_WORKSPACE_MARKER_NAME);
      const markerStat = writePrivateFileAtomically(markerPath, marker);
      fsyncDirectoryFd(rootFd);
      const unsignedBinding = unsignedBindingSchema.parse({
        schemaVersion: GATE_WORKSPACE_BINDING_VERSION,
        workspaceId,
        entryHash: entry.entryHash,
        allocationHash: hashCanonicalValue(allocation),
        rootIdentity: fsIdentity(rootStat),
        rootMountId,
        markerIdentity: fsIdentity(markerStat),
        markerHash: hashCanonicalValue(marker),
        readyAt: new Date().toISOString(),
      });
      const bindingHash = hashCanonicalValue(unsignedBinding);
      const binding = bindingSchema.parse({
        ...unsignedBinding,
        bindingHash,
        proof: capabilityProof(
          cleanupCapability,
          { ...unsignedBinding, bindingHash },
        ),
      });
      writePrivateFileAtomically(
        bindingPath(this.journalRoot, workspaceId),
        binding,
      );
      this.assertRoots();
      return { allocation, root: rootPath };
    } finally {
      if (rootFd !== null) closeSync(rootFd);
      closeSync(managedFd);
    }
  }

  registerSession(
    allocationInput: GateWorkspaceAllocation,
    input: {
      suiteId: string;
      processExecutionId: string;
      runtimeRunId: string;
      workspaceRoot: string;
    },
  ): GateWorkspaceSession {
    const allocation = this.assertAllocation(allocationInput);
    const authority = this.readAuthority(allocation);
    if (!authority.binding) {
      throw new Error('Gate workspace is not ready for a session');
    }
    if (authority.sessions.length >= allocation.limits.maxSessions) {
      throw new Error('Gate workspace session limit is exhausted');
    }
    if (!isAbsolute(input.workspaceRoot) || input.workspaceRoot.includes('\0')) {
      throw new TypeError('Gate workspace session root must be absolute');
    }
    const workspaceRoot = realpathSync(resolve(input.workspaceRoot));
    const relativePath = relative(allocation.rootPath, workspaceRoot);
    if (
      relativePath === ''
      || relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new WorkspaceSafetyError(
        'ROOT_OWNERSHIP_INVALID',
        'Session workspace is not a descendant of the gate root',
      );
    }
    const workspaceStat = lstatSync(workspaceRoot, { bigint: true });
    if (
      !workspaceStat.isDirectory()
      || workspaceStat.isSymbolicLink()
      || workspaceStat.uid !== expectedUid(workspaceStat)
    ) {
      throw new Error('Session workspace is not an owned directory');
    }
    const unsigned = unsignedSessionSchema.parse({
      schemaVersion: GATE_WORKSPACE_SESSION_VERSION,
      workspaceId: allocation.workspaceId,
      entryHash: authority.entry.value.entryHash,
      sessionId: `g0session_${randomBytes(16).toString('hex')}`,
      suiteId: input.suiteId,
      processExecutionId: input.processExecutionId,
      runtimeRunId: input.runtimeRunId,
      workspaceRelativePath: relativePath,
      workspaceRootHash: hashCanonicalValue(workspaceRoot),
      registeredAt: new Date().toISOString(),
    });
    const sessionHash = hashCanonicalValue(unsigned);
    const session = sessionSchema.parse({
      ...unsigned,
      sessionHash,
      proof: capabilityProof(
        allocation.cleanupCapability,
        { ...unsigned, sessionHash },
      ),
    });
    writePrivateFileAtomically(
      sessionPath(
        this.journalRoot,
        allocation.workspaceId,
        session.sessionId,
      ),
      session,
    );
    return session;
  }

  bindSessionOwner(
    allocationInput: GateWorkspaceAllocation,
    sessionInput: GateWorkspaceSession,
    ownerInput: AttemptProcessOwnerDoc,
  ): void {
    const allocation = this.assertAllocation(allocationInput);
    const authority = this.readAuthority(allocation);
    const session = sessionSchema.parse(sessionInput);
    const persisted = authority.sessions.find(
      (item) => item.value.sessionId === session.sessionId,
    );
    if (
      !persisted
      || hashCanonicalValue(persisted.value) !== hashCanonicalValue(session)
    ) {
      throw new Error('Gate workspace session intent is not persisted');
    }
    const owner = ownerFromProcessClaim(ownerInput);
    if (
      owner.processExecutionId !== session.processExecutionId
      || owner.runtimeRunId !== session.runtimeRunId
    ) {
      throw new Error('Gate workspace owner tokens do not match session');
    }
    const unsigned = unsignedSessionOwnerSchema.parse({
      schemaVersion: GATE_WORKSPACE_SESSION_OWNER_VERSION,
      workspaceId: allocation.workspaceId,
      sessionId: session.sessionId,
      sessionHash: session.sessionHash,
      owner,
      boundAt: new Date().toISOString(),
    });
    const ownerHash = hashCanonicalValue(unsigned);
    const record = sessionOwnerSchema.parse({
      ...unsigned,
      ownerHash,
      proof: capabilityProof(
        allocation.cleanupCapability,
        { ...unsigned, ownerHash },
      ),
    });
    writePrivateFileAtomically(
      ownerPath(
        this.journalRoot,
        allocation.workspaceId,
        session.sessionId,
      ),
      record,
    );
  }

  private remainingMs(deadline: number): number {
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining < 1) {
      throw new WorkspaceSafetyError(
        'COMMAND_FAILED',
        'Gate workspace cleanup exceeded its deadline',
      );
    }
    return Math.max(1, Math.floor(remaining));
  }

  private async stopAndVerifyOwner(
    ownerInput: GateWorkspaceJournalProcessOwner,
    deadline: number,
  ): Promise<void> {
    const local = await readLocalProcessHostIdentity();
    if (ownerInput.hostId !== local.hostId) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload belongs to another host',
      );
    }
    if (ownerInput.hostBootId !== local.hostBootId) return;
    if (ownerInput.pidNamespaceId !== local.pidNamespaceId) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload PID namespace changed on the same boot',
      );
    }
    const owner = processOwnerDoc(ownerInput);
    let inspection = await inspectOwnedProcessTree(owner);
    if (!inspection.verifiable && !inspection.treeEmpty) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload tree is not verifiable',
      );
    }
    if (inspection.treeEmpty) return;
    const term = await signalOwnedProcessGroup(owner, 'SIGTERM');
    if (!term.sent && !term.alreadyEmpty) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload refused SIGTERM',
      );
    }
    let waited = await waitForOwnedProcessTreeEmpty(owner, {
      timeoutMs: Math.min(500, this.remainingMs(deadline)),
      pollMs: 10,
    });
    if (waited.empty) return;
    const kill = await signalOwnedProcessGroup(owner, 'SIGKILL');
    if (!kill.sent && !kill.alreadyEmpty) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload refused SIGKILL',
      );
    }
    waited = await waitForOwnedProcessTreeEmpty(owner, {
      timeoutMs: Math.min(1_000, this.remainingMs(deadline)),
      pollMs: 10,
    });
    inspection = waited.inspection;
    if (!waited.empty || !inspection.treeEmpty) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload tree did not become empty',
      );
    }
  }

  private async verifyOwnerEmpty(
    ownerInput: GateWorkspaceJournalProcessOwner,
  ): Promise<void> {
    const local = await readLocalProcessHostIdentity();
    if (ownerInput.hostId !== local.hostId) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload belongs to another host',
      );
    }
    if (ownerInput.hostBootId !== local.hostBootId) return;
    if (ownerInput.pidNamespaceId !== local.pidNamespaceId) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload PID namespace changed on the same boot',
      );
    }
    const inspection = await inspectOwnedProcessTree(
      processOwnerDoc(ownerInput),
    );
    if (!inspection.treeEmpty) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Gate workspace workload tree is not proven empty',
      );
    }
  }

  private async verifyUnownedSessionEmpty(
    session: GateWorkspaceSession,
  ): Promise<void> {
    const scan = await scanNumericProc();
    if (!scan.completeForCurrentUid) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Same-UID process token scan is incomplete',
      );
    }
    const matches = scan.entries.filter(
      (entry) =>
        entry.environmentReadable
        && entry.executionId === session.processExecutionId
        && entry.runtimeRunId === session.runtimeRunId,
    );
    if (matches.length > 0) {
      throw new WorkspaceSafetyError(
        'SESSION_LIVENESS_UNPROVEN',
        'Unowned gate workspace session still has token-bearing processes',
      );
    }
  }

  private async ensureSessionsEmpty(
    authority: AuthorityFiles,
    input: { stopOwned: boolean; deadline: number },
  ): Promise<void> {
    const owners = new Map(
      authority.owners.map((owner) =>
        [owner.value.sessionId, owner.value] as const),
    );
    for (const session of authority.sessions) {
      const owner = owners.get(session.value.sessionId);
      if (owner) {
        if (input.stopOwned) {
          await this.stopAndVerifyOwner(owner.owner, input.deadline);
        } else {
          await this.verifyOwnerEmpty(owner.owner);
        }
      } else {
        await this.verifyUnownedSessionEmpty(session.value);
      }
    }
  }

  private rootLocation(
    managedFd: number,
    allocation: GateWorkspaceAllocation,
  ): 'ORIGINAL' | 'QUARANTINE' | 'ABSENT' {
    const original = this.childExists(managedFd, allocation.rootName);
    const quarantine = this.childExists(
      managedFd,
      quarantineName(allocation),
    );
    if (original && quarantine) {
      throw new WorkspaceSafetyError(
        'ROOT_OWNERSHIP_INVALID',
        'Original and quarantine gate workspace roots both exist',
      );
    }
    return original ? 'ORIGINAL' : quarantine ? 'QUARANTINE' : 'ABSENT';
  }

  private childExists(parentFd: number, name: string): boolean {
    try {
      lstatSync(anchoredPath(parentFd, name), { bigint: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private openVerifiedRoot(
    managedFd: number,
    name: string,
    binding: GateWorkspaceBinding,
  ): number {
    const managedMountId = this.mountId(managedFd);
    const fd = openDirectoryNoFollow(anchoredPath(managedFd, name));
    try {
      const stat = fstatSync(fd, { bigint: true });
      const mountId = this.mountId(fd);
      if (
        !stat.isDirectory()
        || stat.isSymbolicLink()
        || stat.uid !== expectedUid(stat)
        || (stat.mode & 0o777n) !== 0o700n
        || !stableIdentityMatches(stat, binding.rootIdentity)
        || mountId !== binding.rootMountId
        || mountId !== managedMountId
      ) {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Gate workspace root identity or mount changed',
        );
      }
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private readVerifiedMarker(
    rootFd: number,
    entry: GateWorkspaceJournalEntry,
    binding: GateWorkspaceBinding,
  ): JournalFile<GateWorkspaceMarker> {
    const marker = readPrivateJson(
      anchoredPath(rootFd, GATE_WORKSPACE_MARKER_NAME),
      markerSchema,
    );
    const { proof: _proof, ...unsigned } = marker.value;
    if (
      marker.value.workspaceId !== entry.allocation.workspaceId
      || marker.value.entryHash !== entry.entryHash
      || marker.value.allocationHash !== hashCanonicalValue(entry.allocation)
      || marker.value.rootPathHash !== hashCanonicalValue(
        entry.allocation.rootPath,
      )
      || !stableIdentityMatches(
        fstatSync(rootFd, { bigint: true }),
        marker.value.rootIdentity,
      )
      || marker.value.rootMountId !== this.mountId(rootFd)
      || !stableIdentityMatches(marker.stat, binding.markerIdentity)
      || hashCanonicalValue(marker.value) !== binding.markerHash
      || !proofMatches(
        entry.allocation.cleanupCapability,
        unsigned,
        marker.value.proof,
      )
    ) {
      throw new WorkspaceSafetyError(
        'ROOT_OWNERSHIP_INVALID',
        'Gate workspace marker ownership is invalid',
      );
    }
    return marker;
  }

  private inspectNode(
    parentFd: number,
    name: string,
    relativePath: string,
    depth: number,
    rootMountId: string,
  ): { node: GateWorkspacePlannedNode; fd: number } {
    const fd = openSync(
      anchoredPath(parentFd, name),
      LINUX_O_PATH | fsConstants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(fd, { bigint: true });
      const mountId = this.mountId(fd);
      if (mountId !== rootMountId) {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Gate workspace contains a nested mount boundary',
        );
      }
      if (
        stat.uid !== expectedUid(stat)
        || stat.dev.toString()
          !== fstatSync(parentFd, { bigint: true }).dev.toString()
      ) {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Gate workspace node ownership or device differs',
        );
      }
      let type: GateWorkspacePlannedNode['type'];
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        type = 'DIRECTORY';
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        type = 'FILE';
      } else if (stat.isSymbolicLink()) {
        type = 'SYMLINK';
      } else {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Gate workspace contains a special filesystem node',
        );
      }
      if (type !== 'DIRECTORY' && stat.nlink !== 1n) {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Gate workspace contains a hardlinked leaf',
        );
      }
      return {
        node: plannedNodeSchema.parse({
          relativePath,
          depth,
          type,
          identity: fsIdentity(stat),
          mountId,
          nlink: stat.nlink.toString(),
          size: stat.size.toString(),
        }),
        fd,
      };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private inventoryTree(
    rootFd: number,
    limits: GateWorkspaceLimits,
    rootMountId: string,
    requireMarker: boolean,
  ): {
    nodes: GateWorkspacePlannedNode[];
    entryCount: number;
    totalFileBytes: number;
    totalPathBytes: number;
    maxObservedDepth: number;
  } {
    const nodes: GateWorkspacePlannedNode[] = [];
    let totalFileBytes = 0;
    let totalPathBytes = 0;
    let maxObservedDepth = 0;

    const walk = (directoryFd: number, prefix: string, depth: number): void => {
      const directory = opendirSync(anchoredPath(directoryFd));
      try {
        while (true) {
          const dirent = directory.readSync();
          if (dirent === null) break;
          if (
            dirent.name === '.'
            || dirent.name === '..'
            || dirent.name.includes('/')
            || dirent.name.includes('\0')
          ) {
            throw new WorkspaceSafetyError(
              'FILESYSTEM_BOUNDARY_INVALID',
              'Gate workspace contains an invalid path segment',
            );
          }
          const relativePath = prefix === ''
            ? dirent.name
            : join(prefix, dirent.name);
          const nodeDepth = depth + 1;
          if (nodeDepth > limits.maxDepth) {
            throw new WorkspaceSafetyError(
              'INVENTORY_LIMIT',
              'Gate workspace exceeds its depth limit',
            );
          }
          totalPathBytes += Buffer.byteLength(relativePath, 'utf8');
          if (totalPathBytes > limits.maxTotalPathBytes) {
            throw new WorkspaceSafetyError(
              'INVENTORY_LIMIT',
              'Gate workspace exceeds its path-byte limit',
            );
          }
          const inspected = this.inspectNode(
            directoryFd,
            dirent.name,
            relativePath,
            nodeDepth,
            rootMountId,
          );
          nodes.push(inspected.node);
          if (nodes.length > limits.maxEntries) {
            closeSync(inspected.fd);
            throw new WorkspaceSafetyError(
              'INVENTORY_LIMIT',
              'Gate workspace exceeds its entry limit',
            );
          }
          maxObservedDepth = Math.max(maxObservedDepth, nodeDepth);
          if (inspected.node.type === 'FILE') {
            const size = Number(inspected.node.size);
            if (!Number.isSafeInteger(size)) {
              closeSync(inspected.fd);
              throw new WorkspaceSafetyError(
                'INVENTORY_LIMIT',
                'Gate workspace file size is not safely representable',
              );
            }
            totalFileBytes += size;
            if (totalFileBytes > limits.maxTotalFileBytes) {
              closeSync(inspected.fd);
              throw new WorkspaceSafetyError(
                'INVENTORY_LIMIT',
                'Gate workspace exceeds its file-byte limit',
              );
            }
          }
          if (inspected.node.type === 'DIRECTORY') {
            const childFd = openDirectoryNoFollow(
              anchoredPath(directoryFd, dirent.name),
            );
            try {
              const childStat = fstatSync(childFd, { bigint: true });
              if (
                !stableIdentityMatches(childStat, inspected.node.identity)
                || this.mountId(childFd) !== inspected.node.mountId
              ) {
                throw new WorkspaceSafetyError(
                  'FILESYSTEM_BOUNDARY_INVALID',
                  'Gate workspace directory changed before traversal',
                );
              }
              walk(childFd, relativePath, nodeDepth);
            } finally {
              closeSync(childFd);
              closeSync(inspected.fd);
            }
          } else {
            closeSync(inspected.fd);
          }
        }
      } finally {
        directory.closeSync();
      }
    };

    walk(rootFd, '', 0);
    const marker = nodes.find(
      (node) => node.relativePath === GATE_WORKSPACE_MARKER_NAME,
    );
    if (
      requireMarker
      && (
        !marker
        || marker.type !== 'FILE'
        || marker.depth !== 1
      )
    ) {
      throw new WorkspaceSafetyError(
        'ROOT_OWNERSHIP_INVALID',
        'Gate workspace marker is missing from inventory',
      );
    }
    return {
      nodes,
      entryCount: nodes.length,
      totalFileBytes,
      totalPathBytes,
      maxObservedDepth,
    };
  }

  private nodeMatchesPlan(
    observed: GateWorkspacePlannedNode,
    planned: GateWorkspacePlannedNode,
  ): boolean {
    return observed.relativePath === planned.relativePath
      && observed.depth === planned.depth
      && observed.type === planned.type
      && observed.mountId === planned.mountId
      && hashCanonicalValue(observed.identity)
        === hashCanonicalValue(planned.identity)
      && (
        observed.type === 'DIRECTORY'
        || (
          observed.nlink === planned.nlink
          && observed.size === planned.size
        )
      );
  }

  private assertPlanSubset(
    observed: readonly GateWorkspacePlannedNode[],
    plan: GateWorkspaceDeletionPlan,
    requireExact: boolean,
  ): void {
    const plannedByPath = new Map(
      plan.nodes.map((node) => [node.relativePath, node] as const),
    );
    for (const node of observed) {
      const expected = plannedByPath.get(node.relativePath);
      if (!expected || !this.nodeMatchesPlan(node, expected)) {
        throw new WorkspaceSafetyError(
          'PLAN_MISMATCH',
          'Gate workspace remaining tree differs from its durable plan',
        );
      }
    }
    if (requireExact && observed.length !== plan.nodes.length) {
      throw new WorkspaceSafetyError(
        'PLAN_MISMATCH',
        'Original gate workspace changed after plan publication',
      );
    }
    const markerPresent = observed.some(
      (node) => node.relativePath === GATE_WORKSPACE_MARKER_NAME,
    );
    if (!markerPresent && observed.length > 0) {
      throw new WorkspaceSafetyError(
        'PLAN_MISMATCH',
        'Gate workspace marker disappeared before planned leaves',
      );
    }
  }

  private createPlan(
    authority: AuthorityFiles,
    rootFd: number,
  ): GateWorkspaceDeletionPlan {
    if (!authority.binding) {
      throw new WorkspaceSafetyError(
        'ROOT_OWNERSHIP_INVALID',
        'Gate workspace has no ready binding',
      );
    }
    this.readVerifiedMarker(
      rootFd,
      authority.entry.value,
      authority.binding.value,
    );
    const inventory = this.inventoryTree(
      rootFd,
      authority.entry.value.allocation.limits,
      authority.binding.value.rootMountId,
      true,
    );
    const marker = inventory.nodes.find(
      (node) => node.relativePath === GATE_WORKSPACE_MARKER_NAME,
    )!;
    const ordered = inventory.nodes
      .filter((node) => node.relativePath !== GATE_WORKSPACE_MARKER_NAME)
      .sort((left, right) =>
        right.depth - left.depth
        || left.relativePath.localeCompare(right.relativePath));
    ordered.push(marker);
    const unsigned = unsignedPlanSchema.parse({
      schemaVersion: GATE_WORKSPACE_DELETION_PLAN_VERSION,
      workspaceId: authority.entry.value.allocation.workspaceId,
      entryHash: authority.entry.value.entryHash,
      bindingHash: authority.binding.value.bindingHash,
      originalRootName: authority.entry.value.allocation.rootName,
      quarantineName: quarantineName(authority.entry.value.allocation),
      rootIdentity: authority.binding.value.rootIdentity,
      rootMountId: authority.binding.value.rootMountId,
      markerRelativePath: GATE_WORKSPACE_MARKER_NAME,
      nodes: ordered,
      entryCount: inventory.entryCount,
      totalFileBytes: inventory.totalFileBytes,
      totalPathBytes: inventory.totalPathBytes,
      maxObservedDepth: inventory.maxObservedDepth,
      plannedAt: new Date().toISOString(),
    });
    const planHash = hashCanonicalValue(unsigned);
    return deletionPlanSchema.parse({
      ...unsigned,
      planHash,
      proof: capabilityProof(
        authority.entry.value.allocation.cleanupCapability,
        { ...unsigned, planHash },
      ),
    });
  }

  private async acquireClaim(
    authority: AuthorityFiles,
    cleanupMode: GateWorkspaceClaim['cleanupMode'],
  ): Promise<
    | { acquired: true; file: JournalFile<GateWorkspaceClaim> }
    | { acquired: false }
  > {
    const entry = authority.entry.value;
    const path = claimPath(
      this.journalRoot,
      entry.allocation.workspaceId,
    );
    const claimantProcess = await currentLocalProcessIdentity();
    const inspectExisting = async (
      existing: JournalFile<GateWorkspaceClaim>,
      expectedSelfClaimHash?: string,
    ): Promise<
      | { acquired: true; file: JournalFile<GateWorkspaceClaim> }
      | { acquired: false }
      | null
    > => {
      this.verifyClaim(existing.value, entry);
      let live: boolean;
      try {
        live = await this.processIsLive(existing.value.claimantProcess);
      } catch {
        throw new WorkspaceSafetyError(
          'OWNER_LIVENESS_UNPROVEN',
          'Gate workspace cleanup claimant liveness is unknown',
        );
      }
      if (live) {
        const sameClaimantAndMode =
          existing.value.cleanupMode === cleanupMode
          && sameLocalProcess(
            existing.value.claimantProcess,
            claimantProcess,
          );
        if (
          sameClaimantAndMode
          && (
            cleanupMode === 'OWNER'
            || (
              existing.value.claimHash === expectedSelfClaimHash
            )
          )
        ) {
          return { acquired: true, file: existing };
        }
        return { acquired: false };
      }
      this.unlinkExact(existing);
      return null;
    };

    if (existsSync(path)) {
      const result = await inspectExisting(
        readPrivateJson(path, claimSchema),
      );
      if (result) return result;
    }

    const unsigned = unsignedClaimSchema.parse({
      schemaVersion: GATE_WORKSPACE_CLAIM_VERSION,
      workspaceId: entry.allocation.workspaceId,
      entryHash: entry.entryHash,
      allocation: entry.allocation,
      originalRootName: entry.allocation.rootName,
      quarantineName: quarantineName(entry.allocation),
      claimId: randomBytes(32).toString('hex'),
      claimantProcess,
      cleanupMode,
      claimedAt: new Date().toISOString(),
    });
    const claimHash = hashCanonicalValue(unsigned);
    const claim = claimSchema.parse({
      ...unsigned,
      claimHash,
      proof: capabilityProof(
        entry.allocation.cleanupCapability,
        { ...unsigned, claimHash },
      ),
    });
    try {
      const stat = writePrivateFileAtomically(
        path,
        claim,
        MAX_SMALL_JOURNAL_BYTES,
        (tempPath) => this.testing.afterClaimPublicationLink?.({
          claimPath: path,
          tempPath,
          claimHash,
        }),
      );
      return { acquired: true, file: { path, stat, value: claim } };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
        && !existsSync(path)
      ) {
        throw error;
      }
      const peer = readPrivateJson(path, claimSchema);
      const result = await inspectExisting(peer, claimHash);
      if (result) return result;
      throw new WorkspaceSafetyError(
        'COMMAND_FAILED',
        'Dead competing claim disappeared during filesystem CAS',
      );
    }
  }

  private releaseClaim(file: JournalFile<GateWorkspaceClaim>): void {
    if (!existsSync(file.path)) {
      throw new Error('Gate workspace cleanup claim disappeared');
    }
    this.unlinkExact(file);
  }

  private openPlannedParent(
    rootFd: number,
    relativePath: string,
    plan: GateWorkspaceDeletionPlan,
  ): { fd: number; owned: boolean; name: string } {
    const segments = relativePath.split(sep);
    const name = segments.pop();
    if (!name || segments.some((segment) => !segment || segment === '..')) {
      throw new WorkspaceSafetyError(
        'PLAN_MISMATCH',
        'Gate workspace plan contains an invalid path',
      );
    }
    const plannedByPath = new Map(
      plan.nodes.map((node) => [node.relativePath, node] as const),
    );
    let currentFd = rootFd;
    let owned = false;
    let prefix = '';
    try {
      for (const segment of segments) {
        prefix = prefix === '' ? segment : join(prefix, segment);
        const planned = plannedByPath.get(prefix);
        if (!planned || planned.type !== 'DIRECTORY') {
          throw new WorkspaceSafetyError(
            'PLAN_MISMATCH',
            'Gate workspace planned parent is not a directory',
          );
        }
        const nextFd = openDirectoryNoFollow(anchoredPath(currentFd, segment));
        try {
          const stat = fstatSync(nextFd, { bigint: true });
          if (
            !stableIdentityMatches(stat, planned.identity)
            || this.mountId(nextFd) !== planned.mountId
          ) {
            throw new WorkspaceSafetyError(
              'PLAN_MISMATCH',
              'Gate workspace planned parent identity changed',
            );
          }
        } catch (error) {
          closeSync(nextFd);
          throw error;
        }
        if (owned) closeSync(currentFd);
        currentFd = nextFd;
        owned = true;
      }
      return { fd: currentFd, owned, name };
    } catch (error) {
      if (owned) closeSync(currentFd);
      throw error;
    }
  }

  private removePlannedNode(
    rootFd: number,
    node: GateWorkspacePlannedNode,
    plan: GateWorkspaceDeletionPlan,
  ): boolean {
    let parent: { fd: number; owned: boolean; name: string };
    try {
      parent = this.openPlannedParent(rootFd, node.relativePath, plan);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    try {
      if (!this.childExists(parent.fd, parent.name)) return false;
      const observed = this.inspectNode(
        parent.fd,
        parent.name,
        node.relativePath,
        node.depth,
        plan.rootMountId,
      );
      try {
        if (!this.nodeMatchesPlan(observed.node, node)) {
          throw new WorkspaceSafetyError(
            'PLAN_MISMATCH',
            'Gate workspace node changed before removal',
          );
        }
      } finally {
        closeSync(observed.fd);
      }
      if (node.type === 'DIRECTORY') {
        const directoryFd = openDirectoryNoFollow(
          anchoredPath(parent.fd, parent.name),
        );
        try {
          const stat = fstatSync(directoryFd, { bigint: true });
          if (
            !stableIdentityMatches(stat, node.identity)
            || this.mountId(directoryFd) !== node.mountId
          ) {
            throw new WorkspaceSafetyError(
              'PLAN_MISMATCH',
              'Gate workspace directory changed before removal',
            );
          }
          const directory = opendirSync(anchoredPath(directoryFd));
          try {
            if (directory.readSync() !== null) {
              throw new WorkspaceSafetyError(
                'PLAN_MISMATCH',
                'Gate workspace directory has an unplanned remaining child',
              );
            }
          } finally {
            directory.closeSync();
          }
        } finally {
          closeSync(directoryFd);
        }
        rmdirSync(anchoredPath(parent.fd, parent.name));
      } else {
        // O_PATH|O_NOFOLLOW bound the exact leaf above.  unlink removes a
        // symlink itself and never traverses its foreign target.
        unlinkSync(anchoredPath(parent.fd, parent.name));
      }
      fsyncDirectoryFd(parent.fd);
      return true;
    } finally {
      if (parent.owned) closeSync(parent.fd);
    }
  }

  private async invokeCrashHook(
    hook: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    if (!hook) return;
    try {
      await hook();
    } catch (error) {
      throw new InjectedCrashError(error);
    }
  }

  private async executeDurableDelete(
    authorityInput: AuthorityFiles,
    hooks: GateWorkspaceCleanupHooks,
    deadline: number,
    beforeMutation: () => Promise<void>,
  ): Promise<{
    result: GateWorkspaceCleanupResult;
    initiallyAbsent: boolean;
  }> {
    let authority = authorityInput;
    if (!authority.binding) {
      return await this.cleanupUnboundRoot(
        authority,
        hooks,
        beforeMutation,
      );
    }
    const allocation = authority.entry.value.allocation;
    const managedFd = openDirectoryNoFollow(this.managedRoot);
    let rootFd: number | null = null;
    try {
      let location = this.rootLocation(managedFd, allocation);
      if (location === 'ABSENT') {
        const plan = authority.plan?.value;
        return {
          initiallyAbsent: true,
          result: gateWorkspaceCleanupResultSchema.parse({
            schemaVersion: GATE_WORKSPACE_CLEANUP_VERSION,
            status: 'PASSED',
            verifiedAbsent: true,
            resumed: plan !== undefined,
            entryCount: plan?.entryCount ?? 0,
            totalFileBytes: plan?.totalFileBytes ?? 0,
            maxObservedDepth: plan?.maxObservedDepth ?? 0,
          }),
        };
      }
      if (!authority.plan) {
        if (location !== 'ORIGINAL') {
          throw new WorkspaceSafetyError(
            'PLAN_MISMATCH',
            'Quarantined gate workspace has no durable deletion plan',
          );
        }
        rootFd = this.openVerifiedRoot(
          managedFd,
          allocation.rootName,
          authority.binding.value,
        );
        const plan = this.createPlan(authority, rootFd);
        writePrivateFileAtomically(
          planPath(this.journalRoot, allocation.workspaceId),
          plan,
          MAX_PLAN_BYTES,
        );
        closeSync(rootFd);
        rootFd = null;
        authority = this.readAuthority(allocation);
      }
      const plan = authority.plan!.value;
      const binding = authority.binding;
      if (!binding) {
        throw new WorkspaceSafetyError(
          'ROOT_OWNERSHIP_INVALID',
          'Gate workspace binding disappeared after plan publication',
        );
      }
      const resumed = authorityInput.plan !== null;

      await this.ensureSessionsEmpty(authority, {
        stopOwned: false,
        deadline,
      });
      await beforeMutation();
      location = this.rootLocation(managedFd, allocation);
      if (location === 'ABSENT') {
        return {
          initiallyAbsent: true,
          result: gateWorkspaceCleanupResultSchema.parse({
            schemaVersion: GATE_WORKSPACE_CLEANUP_VERSION,
            status: 'PASSED',
            verifiedAbsent: true,
            resumed: true,
            entryCount: plan.entryCount,
            totalFileBytes: plan.totalFileBytes,
            maxObservedDepth: plan.maxObservedDepth,
          }),
        };
      }
      const rootName = location === 'ORIGINAL'
        ? allocation.rootName
        : plan.quarantineName;
      rootFd = this.openVerifiedRoot(
        managedFd,
        rootName,
        binding.value,
      );
      const observed = this.inventoryTree(
        rootFd,
        allocation.limits,
        plan.rootMountId,
        false,
      );
      this.assertPlanSubset(
        observed.nodes,
        plan,
        location === 'ORIGINAL',
      );
      if (location === 'ORIGINAL') {
        this.readVerifiedMarker(
          rootFd,
          authority.entry.value,
          binding.value,
        );
        if (this.childExists(managedFd, plan.quarantineName)) {
          throw new WorkspaceSafetyError(
            'ROOT_OWNERSHIP_INVALID',
            'Gate workspace quarantine target already exists',
          );
        }
        renameSync(
          anchoredPath(managedFd, allocation.rootName),
          anchoredPath(managedFd, plan.quarantineName),
        );
        fsyncDirectoryFd(managedFd);
        const movedStat = fstatSync(rootFd, { bigint: true });
        if (
          !stableIdentityMatches(movedStat, plan.rootIdentity)
          || this.mountId(rootFd) !== plan.rootMountId
          || this.childExists(managedFd, allocation.rootName)
          || !this.childExists(managedFd, plan.quarantineName)
        ) {
          throw new WorkspaceSafetyError(
            'ROOT_OWNERSHIP_INVALID',
            'Gate workspace quarantine rename was not exact',
          );
        }
      }

      let firstRemoval = true;
      for (const node of plan.nodes) {
        if (node.relativePath === GATE_WORKSPACE_MARKER_NAME) {
          const beforeMarker = this.inventoryTree(
            rootFd,
            allocation.limits,
            plan.rootMountId,
            false,
          );
          if (
            beforeMarker.nodes.length > 0
            && (
              beforeMarker.nodes.length !== 1
              || beforeMarker.nodes[0]?.relativePath
                !== GATE_WORKSPACE_MARKER_NAME
              || !this.nodeMatchesPlan(beforeMarker.nodes[0], node)
            )
          ) {
            throw new WorkspaceSafetyError(
              'PLAN_MISMATCH',
              'Gate workspace marker is not the last remaining node',
            );
          }
        }
        if (this.removePlannedNode(rootFd, node, plan) && firstRemoval) {
          firstRemoval = false;
          await this.invokeCrashHook(hooks.afterFirstRemoval);
        }
      }
      const empty = this.inventoryTree(
        rootFd,
        allocation.limits,
        plan.rootMountId,
        false,
      );
      if (empty.nodes.length !== 0) {
        throw new WorkspaceSafetyError(
          'PLAN_MISMATCH',
          'Gate workspace quarantine is not empty after its plan',
        );
      }
      if (
        !stableIdentityMatches(
          fstatSync(rootFd, { bigint: true }),
          plan.rootIdentity,
        )
        || this.mountId(rootFd) !== plan.rootMountId
      ) {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Gate workspace root changed before final rmdir',
        );
      }
      rmdirSync(anchoredPath(managedFd, plan.quarantineName));
      fsyncDirectoryFd(managedFd);
      if (
        this.childExists(managedFd, allocation.rootName)
        || this.childExists(managedFd, plan.quarantineName)
      ) {
        throw new WorkspaceSafetyError(
          'ROOT_OWNERSHIP_INVALID',
          'Gate workspace root absence is not proven',
        );
      }
      return {
        initiallyAbsent: false,
        result: gateWorkspaceCleanupResultSchema.parse({
          schemaVersion: GATE_WORKSPACE_CLEANUP_VERSION,
          status: 'PASSED',
          verifiedAbsent: true,
          resumed,
          entryCount: plan.entryCount,
          totalFileBytes: plan.totalFileBytes,
          maxObservedDepth: plan.maxObservedDepth,
        }),
      };
    } finally {
      if (rootFd !== null) closeSync(rootFd);
      closeSync(managedFd);
    }
  }

  private async cleanupUnboundRoot(
    authority: AuthorityFiles,
    hooks: GateWorkspaceCleanupHooks,
    beforeMutation: () => Promise<void>,
  ): Promise<{
    result: GateWorkspaceCleanupResult;
    initiallyAbsent: boolean;
  }> {
    if (
      authority.plan
      || authority.sessions.length > 0
      || authority.owners.length > 0
    ) {
      throw new WorkspaceSafetyError(
        'ROOT_OWNERSHIP_INVALID',
        'Unbound gate workspace has post-ready authority records',
      );
    }
    const entry = authority.entry.value;
    const allocation = entry.allocation;
    const managedFd = openDirectoryNoFollow(this.managedRoot);
    let rootFd: number | null = null;
    try {
      const location = this.rootLocation(managedFd, allocation);
      if (location === 'ABSENT') {
        return {
          initiallyAbsent: true,
          result: gateWorkspaceCleanupResultSchema.parse({
            schemaVersion: GATE_WORKSPACE_CLEANUP_VERSION,
            status: 'PASSED',
            verifiedAbsent: true,
            resumed: false,
            entryCount: 0,
            totalFileBytes: 0,
            maxObservedDepth: 0,
          }),
        };
      }
      if (location !== 'ORIGINAL') {
        throw new WorkspaceSafetyError(
          'ROOT_OWNERSHIP_INVALID',
          'Unbound gate workspace unexpectedly has a quarantine root',
        );
      }
      rootFd = openDirectoryNoFollow(
        anchoredPath(managedFd, allocation.rootName),
      );
      const rootStat = fstatSync(rootFd, { bigint: true });
      const rootMountId = this.mountId(rootFd);
      if (
        !rootStat.isDirectory()
        || rootStat.isSymbolicLink()
        || rootStat.uid !== expectedUid(rootStat)
        || (rootStat.mode & 0o777n) !== 0o700n
        || rootMountId !== this.mountId(managedFd)
      ) {
        throw new WorkspaceSafetyError(
          'FILESYSTEM_BOUNDARY_INVALID',
          'Unbound gate workspace root is not exact',
        );
      }
      const names = readBoundedDirectoryNames(anchoredPath(rootFd), 2);
      const markerPresent = names.includes(GATE_WORKSPACE_MARKER_NAME);
      const markerTempNames = names.filter((name) => MARKER_TEMP_RE.test(name));
      if (
        markerTempNames.length > 1
        || names.some((name) =>
          name !== GATE_WORKSPACE_MARKER_NAME
          && !MARKER_TEMP_RE.test(name))
      ) {
        throw new WorkspaceSafetyError(
          'ROOT_OWNERSHIP_INVALID',
          'Unbound gate workspace contains data beyond its marker',
        );
      }
      const verifyMarker = (
        marker: JournalFile<GateWorkspaceMarker>,
      ): void => {
        const { proof: _proof, ...unsigned } = marker.value;
        if (
          marker.value.workspaceId !== allocation.workspaceId
          || marker.value.entryHash !== entry.entryHash
          || marker.value.allocationHash !== hashCanonicalValue(allocation)
          || marker.value.rootPathHash !== hashCanonicalValue(allocation.rootPath)
          || !stableIdentityMatches(rootStat, marker.value.rootIdentity)
          || marker.value.rootMountId !== rootMountId
          || !proofMatches(
            allocation.cleanupCapability,
            unsigned,
            marker.value.proof,
          )
        ) {
          throw new WorkspaceSafetyError(
            'ROOT_OWNERSHIP_INVALID',
            'Unbound gate workspace marker is invalid',
          );
        }
      };

      let markerTemp: JournalFile<undefined> | null = null;
      let markerBeforeMutation: JournalFile<GateWorkspaceMarker> | null = null;
      if (markerTempNames.length === 1) {
        const name = markerTempNames[0]!;
        const path = anchoredPath(rootFd, name);
        const stat = lstatSync(path, { bigint: true });
        if (
          !stat.isFile()
          || stat.isSymbolicLink()
          || stat.uid !== expectedUid(stat)
          || (stat.mode & 0o777n) !== 0o600n
          || (stat.nlink !== 1n && stat.nlink !== 2n)
          || stat.size > BigInt(MAX_SMALL_JOURNAL_BYTES)
        ) {
          throw new WorkspaceSafetyError(
            'ROOT_OWNERSHIP_INVALID',
            'Unbound gate workspace marker temp is not exact',
          );
        }
        if (
          (stat.nlink === 1n && markerPresent)
          || (stat.nlink === 2n && !markerPresent)
        ) {
          throw new WorkspaceSafetyError(
            'ROOT_OWNERSHIP_INVALID',
            'Unbound marker publication prefix is ambiguous',
          );
        }
        markerTemp = { path, stat, value: undefined };
        if (stat.nlink === 2n) {
          const markerStat = lstatSync(
            anchoredPath(rootFd, GATE_WORKSPACE_MARKER_NAME),
            { bigint: true },
          );
          if (!journalFileIdentityMatches(stat, markerStat)) {
            throw new WorkspaceSafetyError(
              'ROOT_OWNERSHIP_INVALID',
              'Unbound marker temp/final pair is not one inode',
            );
          }
          markerBeforeMutation = readPrivateJson(
            anchoredPath(rootFd, GATE_WORKSPACE_MARKER_NAME),
            markerSchema,
            MAX_SMALL_JOURNAL_BYTES,
            stat,
          );
          verifyMarker(markerBeforeMutation);
        }
      } else if (markerPresent) {
        markerBeforeMutation = readPrivateJson(
          anchoredPath(rootFd, GATE_WORKSPACE_MARKER_NAME),
          markerSchema,
        );
        verifyMarker(markerBeforeMutation);
      }

      await beforeMutation();
      let firstRemovalObserved = false;
      const entryCount =
        (markerPresent ? 1 : 0) + (markerTemp ? 1 : 0);
      const markerBytes =
        (markerBeforeMutation ? Number(markerBeforeMutation.stat.size) : 0)
        + (markerTemp ? Number(markerTemp.stat.size) : 0);
      if (markerTemp) {
        const current = lstatSync(markerTemp.path, { bigint: true });
        if (!journalFileIdentityMatches(current, markerTemp.stat)) {
          throw new WorkspaceSafetyError(
            'ROOT_OWNERSHIP_INVALID',
            'Unbound marker temp changed before terminalization',
          );
        }
        unlinkSync(markerTemp.path);
        fsyncDirectoryFd(rootFd);
        firstRemovalObserved = true;
        await this.invokeCrashHook(hooks.afterFirstRemoval);
      }
      if (markerPresent) {
        const marker = readPrivateJson(
          anchoredPath(rootFd, GATE_WORKSPACE_MARKER_NAME),
          markerSchema,
        );
        verifyMarker(marker);
        unlinkSync(anchoredPath(rootFd, GATE_WORKSPACE_MARKER_NAME));
        fsyncDirectoryFd(rootFd);
        if (!firstRemovalObserved) {
          firstRemovalObserved = true;
          await this.invokeCrashHook(hooks.afterFirstRemoval);
        }
      }
      if (
        readBoundedDirectoryNames(anchoredPath(rootFd), 1).length !== 0
      ) {
        throw new WorkspaceSafetyError(
          'ROOT_OWNERSHIP_INVALID',
          'Unbound gate workspace did not become empty',
        );
      }
      rmdirSync(anchoredPath(managedFd, allocation.rootName));
      fsyncDirectoryFd(managedFd);
      if (this.rootLocation(managedFd, allocation) !== 'ABSENT') {
        throw new WorkspaceSafetyError(
          'ROOT_OWNERSHIP_INVALID',
          'Unbound gate workspace absence is not proven',
        );
      }
      if (!firstRemovalObserved) {
        await this.invokeCrashHook(hooks.afterFirstRemoval);
      }
      return {
        initiallyAbsent: false,
        result: gateWorkspaceCleanupResultSchema.parse({
          schemaVersion: GATE_WORKSPACE_CLEANUP_VERSION,
          status: 'PASSED',
          verifiedAbsent: true,
          resumed: false,
          entryCount,
          totalFileBytes: markerBytes,
          maxObservedDepth: entryCount > 0 ? 1 : 0,
        }),
      };
    } finally {
      if (rootFd !== null) closeSync(rootFd);
      closeSync(managedFd);
    }
  }

  private assertManagedRootsAbsent(
    allocation: GateWorkspaceAllocation,
  ): void {
    const managedFd = openDirectoryNoFollow(this.managedRoot);
    try {
      if (this.rootLocation(managedFd, allocation) !== 'ABSENT') {
        throw new WorkspaceSafetyError(
          'ROOT_OWNERSHIP_INVALID',
          'Gate workspace root still exists at terminalization',
        );
      }
    } finally {
      closeSync(managedFd);
    }
  }

  private async finalizeAuthority(
    allocation: GateWorkspaceAllocation,
    claim: JournalFile<GateWorkspaceClaim>,
    hooks: GateWorkspaceCleanupHooks,
  ): Promise<void> {
    this.assertManagedRootsAbsent(allocation);
    const authority = this.readAuthority(allocation);
    if (
      !authority.claim
      || authority.claim.value.claimHash !== claim.value.claimHash
    ) {
      throw new Error('Gate workspace terminal claim changed');
    }
    for (const owner of authority.owners) this.unlinkExact(owner);
    for (const session of authority.sessions) this.unlinkExact(session);
    // Plan first: a crash may leave binding-without-plan, which is a valid
    // root-absent terminal state.  Plan-without-binding would be ambiguous and
    // is deliberately rejected by inventory.
    if (authority.plan) this.unlinkExact(authority.plan);
    if (authority.binding) this.unlinkExact(authority.binding);
    this.unlinkExact(authority.entry);
    await this.invokeCrashHook(
      hooks.afterJournalUnlinkBeforeClaimRelease,
    );
    this.releaseClaim(authority.claim);
  }

  private failedCleanup(
    error: unknown,
    partial?: Partial<GateWorkspaceCleanupResult>,
  ): GateWorkspaceCleanupResult {
    const reasonCode = error instanceof WorkspaceSafetyError
      ? error.reasonCode
      : 'COMMAND_FAILED';
    return gateWorkspaceCleanupResultSchema.parse({
      schemaVersion: GATE_WORKSPACE_CLEANUP_VERSION,
      status: 'FAILED',
      verifiedAbsent: false,
      resumed: partial?.resumed ?? false,
      entryCount: partial?.entryCount ?? 0,
      totalFileBytes: partial?.totalFileBytes ?? 0,
      maxObservedDepth: partial?.maxObservedDepth ?? 0,
      reasonCode,
    });
  }

  async cleanupOwned(
    allocationInput: GateWorkspaceAllocation,
    hooks: GateWorkspaceCleanupHooks = {},
  ): Promise<GateWorkspaceCleanupResult> {
    let claim: JournalFile<GateWorkspaceClaim> | null = null;
    let terminalized = false;
    try {
      const allocation = this.assertAllocation(allocationInput);
      let authority = this.readAuthority(allocation);
      const current = await currentLocalProcessIdentity();
      if (!sameLocalProcess(current, authority.entry.value.parentProcess)) {
        throw new WorkspaceSafetyError(
          'OWNER_LIVENESS_UNPROVEN',
          'Only the exact gate owner may run normal cleanup',
        );
      }
      const acquired = await this.acquireClaim(authority, 'OWNER');
      if (!acquired.acquired) {
        throw new WorkspaceSafetyError(
          'OWNER_LIVENESS_UNPROVEN',
          'Gate workspace is claimed by another live cleaner',
        );
      }
      claim = acquired.file;
      authority = this.readAuthority(allocation);
      const deadline = Date.now() + DEFAULT_RECLAIM_DEADLINE_MS;
      await this.ensureSessionsEmpty(authority, {
        stopOwned: true,
        deadline,
      });
      const cleaned = await this.executeDurableDelete(
        authority,
        hooks,
        deadline,
        async () => {
          const refreshed = await currentLocalProcessIdentity();
          if (!sameLocalProcess(refreshed, authority.entry.value.parentProcess)) {
            throw new WorkspaceSafetyError(
              'OWNER_LIVENESS_UNPROVEN',
              'Gate workspace owner changed before mutation',
            );
          }
        },
      );
      await this.finalizeAuthority(allocation, claim, hooks);
      terminalized = true;
      return cleaned.result;
    } catch (error) {
      if (error instanceof InjectedCrashError) throw error.causeValue;
      if (claim && !terminalized && existsSync(claim.path)) {
        try {
          this.releaseClaim(readPrivateJson(claim.path, claimSchema));
        } catch {
          return this.failedCleanup(new Error('Gate workspace claim release failed'));
        }
      }
      return this.failedCleanup(error);
    }
  }

  private reclaimEffect(
    authority: {
      entryHash: string;
      allocation: GateWorkspaceAllocation;
    },
    outcome: GateWorkspaceOrphanReclaimEffect['outcome'],
    reasonCode: GateWorkspaceOrphanReclaimEffect['reasonCode'],
  ): GateWorkspaceOrphanReclaimEffect {
    return reclaimEffectSchema.parse({
      entryHash: authority.entryHash,
      resourceHash: hashCanonicalValue(authority.allocation.rootPath),
      outcome,
      reasonCode,
    });
  }

  async reclaim(input: {
    deadlineMs?: number;
    hooks?: GateWorkspaceCleanupHooks;
  } = {}): Promise<GateWorkspaceOrphanReclaimReport> {
    const deadlineMs = input.deadlineMs ?? DEFAULT_RECLAIM_DEADLINE_MS;
    if (
      !Number.isSafeInteger(deadlineMs)
      || deadlineMs < 1
      || deadlineMs > MAX_RECLAIM_DEADLINE_MS
    ) {
      throw new TypeError('Gate workspace reclaim deadline is invalid');
    }
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const deadline = startedAtMs + deadlineMs;
    const effects: GateWorkspaceOrphanReclaimEffect[] = [];
    const incompleteReport = (rootsVerified: boolean):
    GateWorkspaceOrphanReclaimReport =>
      gateWorkspaceOrphanReclaimReportSchema.parse({
        schemaVersion: GATE_WORKSPACE_ORPHAN_RECLAIM_VERSION,
        status: 'FAILED',
        startedAt,
        finishedAt: new Date().toISOString(),
        deadlineMs,
        timedOut: Date.now() >= deadline,
        journalRootVerified: rootsVerified,
        managedRootVerified: rootsVerified,
        scanComplete: false,
        scannedEntries: 0,
        activeCount: 0,
        claimedByLiveReclaimerCount: 0,
        reclaimedCount: 0,
        alreadyAbsentCount: 0,
        unsafeCount: 0,
        failedCount: 0,
        reclaimVerified: false,
        effects: [],
      });
    const phaseViolationReport = (
      error: ManagedRootPhaseError,
    ): GateWorkspaceOrphanReclaimReport => {
      const violationEffects = error.violations.map((authority) =>
        this.reclaimEffect(
          authority,
          'UNSAFE_RETAINED',
          'ROOT_OWNERSHIP_INVALID',
        ));
      return gateWorkspaceOrphanReclaimReportSchema.parse({
        schemaVersion: GATE_WORKSPACE_ORPHAN_RECLAIM_VERSION,
        status: 'FAILED',
        startedAt,
        finishedAt: new Date().toISOString(),
        deadlineMs,
        timedOut: Date.now() >= deadline,
        journalRootVerified: true,
        managedRootVerified: false,
        scanComplete: false,
        scannedEntries: error.scannedEntries,
        activeCount: 0,
        claimedByLiveReclaimerCount: 0,
        reclaimedCount: 0,
        alreadyAbsentCount: 0,
        unsafeCount: violationEffects.length,
        failedCount: 0,
        reclaimVerified: false,
        effects: violationEffects,
      });
    };
    let scanAdmission: JournalFile<GateWorkspaceAdmission>;
    try {
      scanAdmission = await this.acquireAdmission();
    } catch (error) {
      if (error instanceof ManagedRootPhaseError) {
        return phaseViolationReport(error);
      }
      return incompleteReport(error instanceof WorkspaceSafetyError);
    }
    let inventory: JournalInventory;
    try {
      inventory = this.readInventory();
      if (
        !inventory.admission
        || inventory.admission.value.admissionHash
          !== scanAdmission.value.admissionHash
      ) {
        throw new Error('Gate workspace scan admission changed');
      }
      // This is the inventory linearization point.  No creator can publish a
      // new entry while the fixed admission is held.  Release it before
      // resource mutation so terminal crash hooks retain only cleanup claim
      // authority; entries published later are post-snapshot work.
      this.releaseAdmission(scanAdmission);
    } catch {
      if (existsSync(scanAdmission.path)) {
        try {
          this.releaseAdmission(scanAdmission);
        } catch {
          // The incomplete report below remains fail-closed.
        }
      }
      return incompleteReport(false);
    }

    for (const orphanClaim of inventory.orphanClaims) {
      const authority = {
        entryHash: orphanClaim.value.entryHash,
        allocation: orphanClaim.value.allocation,
      };
      if (Date.now() >= deadline) {
        effects.push(this.reclaimEffect(
          authority,
          'FAILED_RETAINED',
          'COMMAND_FAILED',
        ));
        continue;
      }
      let claimantLive: boolean;
      try {
        claimantLive = await this.processIsLive(
          orphanClaim.value.claimantProcess,
        );
      } catch {
        effects.push(this.reclaimEffect(
          authority,
          'UNSAFE_RETAINED',
          'OWNER_LIVENESS_UNPROVEN',
        ));
        continue;
      }
      if (claimantLive) {
        effects.push(this.reclaimEffect(
          authority,
          'CLAIMED_BY_LIVE_RECLAIMER',
          'RECLAIMER_ACTIVE',
        ));
        continue;
      }
      try {
        // Claim-only authority is terminal-only: it can prove both possible
        // names absent and unlink itself, but can never authorize deletion.
        this.assertManagedRootsAbsent(orphanClaim.value.allocation);
        this.unlinkExact(orphanClaim);
        effects.push(this.reclaimEffect(
          authority,
          'ALREADY_ABSENT',
          'ROOT_ALREADY_ABSENT',
        ));
      } catch (error) {
        effects.push(this.reclaimEffect(
          authority,
          error instanceof WorkspaceSafetyError
            ? 'UNSAFE_RETAINED'
            : 'FAILED_RETAINED',
          error instanceof WorkspaceSafetyError
            ? error.reasonCode
            : 'COMMAND_FAILED',
        ));
      }
    }

    for (const initial of inventory.authorities) {
      const entry = initial.entry.value;
      const effectAuthority = {
        entryHash: entry.entryHash,
        allocation: entry.allocation,
      };
      if (Date.now() >= deadline) {
        effects.push(this.reclaimEffect(
          effectAuthority,
          'FAILED_RETAINED',
          'COMMAND_FAILED',
        ));
        continue;
      }
      let ownerLive: boolean;
      try {
        ownerLive = await this.processIsLive(entry.parentProcess);
      } catch {
        effects.push(this.reclaimEffect(
          effectAuthority,
          'UNSAFE_RETAINED',
          'OWNER_LIVENESS_UNPROVEN',
        ));
        continue;
      }
      if (ownerLive) {
        effects.push(this.reclaimEffect(
          effectAuthority,
          'ACTIVE_SKIPPED',
          'OWNER_ACTIVE',
        ));
        continue;
      }

      let claim: JournalFile<GateWorkspaceClaim> | null = null;
      let terminalized = false;
      try {
        const acquired = await this.acquireClaim(initial, 'RECLAIMER');
        if (!acquired.acquired) {
          effects.push(this.reclaimEffect(
            effectAuthority,
            'CLAIMED_BY_LIVE_RECLAIMER',
            'RECLAIMER_ACTIVE',
          ));
          continue;
        }
        claim = acquired.file;
        const authority = this.readAuthority(entry.allocation);
        if (await this.processIsLive(authority.entry.value.parentProcess)) {
          throw new WorkspaceSafetyError(
            'OWNER_LIVENESS_UNPROVEN',
            'Gate workspace owner revived after reclaim claim',
          );
        }
        await this.ensureSessionsEmpty(authority, {
          stopOwned: true,
          deadline,
        });
        const cleaned = await this.executeDurableDelete(
          authority,
          input.hooks ?? {},
          deadline,
          async () => {
            const refreshed = this.readAuthority(entry.allocation);
            if (await this.processIsLive(refreshed.entry.value.parentProcess)) {
              throw new WorkspaceSafetyError(
                'OWNER_LIVENESS_UNPROVEN',
                'Gate workspace owner became live before mutation',
              );
            }
          },
        );
        await this.finalizeAuthority(
          entry.allocation,
          claim,
          input.hooks ?? {},
        );
        terminalized = true;
        effects.push(this.reclaimEffect(
          effectAuthority,
          cleaned.initiallyAbsent ? 'ALREADY_ABSENT' : 'RECLAIMED',
          cleaned.initiallyAbsent
            ? 'ROOT_ALREADY_ABSENT'
            : 'ROOT_RECLAIMED',
        ));
      } catch (error) {
        if (error instanceof InjectedCrashError) throw error.causeValue;
        let releaseFailed = false;
        if (claim && !terminalized && existsSync(claim.path)) {
          try {
            this.releaseClaim(readPrivateJson(claim.path, claimSchema));
          } catch {
            releaseFailed = true;
          }
        }
        const safety = error instanceof WorkspaceSafetyError
          && error.reasonCode !== 'COMMAND_FAILED'
          && !releaseFailed;
        effects.push(this.reclaimEffect(
          effectAuthority,
          safety ? 'UNSAFE_RETAINED' : 'FAILED_RETAINED',
          safety ? error.reasonCode : 'COMMAND_FAILED',
        ));
      }
    }

    const counted = {
      activeCount: effects.filter(
        (effect) => effect.outcome === 'ACTIVE_SKIPPED',
      ).length,
      claimedByLiveReclaimerCount: effects.filter(
        (effect) => effect.outcome === 'CLAIMED_BY_LIVE_RECLAIMER',
      ).length,
      reclaimedCount: effects.filter(
        (effect) => effect.outcome === 'RECLAIMED',
      ).length,
      alreadyAbsentCount: effects.filter(
        (effect) => effect.outcome === 'ALREADY_ABSENT',
      ).length,
      unsafeCount: effects.filter(
        (effect) => effect.outcome === 'UNSAFE_RETAINED',
      ).length,
      failedCount: effects.filter(
        (effect) => effect.outcome === 'FAILED_RETAINED',
      ).length,
    };
    const finishedAtMs = Date.now();
    const timedOut = finishedAtMs >= deadline;
    const scannedEntries =
      inventory.authorities.length + inventory.orphanClaims.length;
    const passed = effects.length === scannedEntries
      && counted.unsafeCount === 0
      && counted.failedCount === 0
      && !timedOut;
    return gateWorkspaceOrphanReclaimReportSchema.parse({
      schemaVersion: GATE_WORKSPACE_ORPHAN_RECLAIM_VERSION,
      status: passed ? 'PASSED' : 'FAILED',
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      deadlineMs,
      timedOut,
      journalRootVerified: true,
      managedRootVerified: true,
      scanComplete: true,
      scannedEntries,
      ...counted,
      reclaimVerified: passed,
      effects,
    });
  }
}

export function failedGateWorkspaceOrphanReclaimReport():
GateWorkspaceOrphanReclaimReport {
  const now = new Date().toISOString();
  return gateWorkspaceOrphanReclaimReportSchema.parse({
    schemaVersion: GATE_WORKSPACE_ORPHAN_RECLAIM_VERSION,
    status: 'FAILED',
    startedAt: now,
    finishedAt: now,
    deadlineMs: DEFAULT_RECLAIM_DEADLINE_MS,
    timedOut: false,
    journalRootVerified: false,
    managedRootVerified: false,
    scanComplete: false,
    scannedEntries: 0,
    activeCount: 0,
    claimedByLiveReclaimerCount: 0,
    reclaimedCount: 0,
    alreadyAbsentCount: 0,
    unsafeCount: 0,
    failedCount: 0,
    reclaimVerified: false,
    effects: [],
  });
}
