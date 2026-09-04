/**
 * Typed RESULT_DRAIN activation — bounded A→B watermark/handoff slice.
 *
 * This reducer deliberately admits one business shape only: one root SERIAL
 * task in RESULT_DRAIN_V1 mode and at most one immutable validated result.
 * Around it, a finite batch may resolve clearly stale ordered inbox records.
 * A batch may commit without terminalizing the job when a durable tail remains;
 * the same transaction then writes a deterministic successor wake.
 *
 * Unsupported poison records are durably quarantined and may be promoted by an
 * idempotent, owner-scoped operator redrive once the running consumer supports
 * their unchanged envelope. Supported records whose A-side authority is
 * temporarily incomplete move through a bounded, store-time retry timer before
 * deterministic exhaustion quarantine. Speculative attempts, dispatch-edge
 * fan-in, budgets/effects/artifacts and general multi-result policies remain
 * outside this slice.
 */
import type { ClientSession, Db, Filter, MongoClient } from 'mongodb';
import type { JobTerminalOutcome, TaskPhase } from '../contracts/index.js';
import {
  deriveAttemptDeadlines,
  newActivationId,
  newOutboxId,
} from '../contracts/index.js';
import { canonicalHash, runTxn } from './txn.js';
import {
  COLLECTIONS,
  type AttemptDoc,
  type JobDoc,
  type JobEventDoc,
  type JobInboxDoc,
  type LaneActivationDoc,
  type OutboxDoc,
  type ResultDoc,
  type TaskDoc,
  type TimerDoc,
} from './collections.js';

const DEFAULT_ACTIVATION_LEASE_TTL_MS = 10_000;
const DEFAULT_ACTIVATION_CAP_MS = 30_000;
const DEFAULT_FINALIZE_RESERVE_MS = 2_000;
const DEFAULT_REDUCER_COMMIT_RESERVE_MS = 2_000;
const DEFAULT_MAX_BATCH_ITEMS = 8;
const MAX_BATCH_ITEMS = 32;
const INBOX_RETRY_POLICY_VERSION = 1;
const MAX_AUTO_REDRIVE_ATTEMPTS = 3;
const INBOX_RETRY_BASE_MS = 500;
const MAX_TYPED_TIMER_TRANSITIONS_PER_TICK = 64;
const ACTIVE_ACTIVATION_LIFECYCLES: LaneActivationDoc['lifecycle'][] = [
  'PENDING',
  'LEASED',
  'RUNNING',
  'FAILED',
];

type SupportedResultStatus = 'ok' | 'partial' | 'failed';
type InboxRetryReasonCode =
  | 'result_missing'
  | 'attempt_missing'
  | 'attempt_not_finished'
  | 'attempt_a_commit_incomplete';

const RESULT_TRANSITIONS: Record<
  SupportedResultStatus,
  {
    attemptOutcome: AttemptDoc['outcome'];
    taskPhase: TaskPhase;
    terminalOutcome: JobTerminalOutcome;
  }
> = {
  ok: {
    attemptOutcome: 'OK',
    taskPhase: 'SUCCEEDED',
    terminalOutcome: 'COMPLETED',
  },
  partial: {
    attemptOutcome: 'PARTIAL',
    taskPhase: 'PARTIAL',
    terminalOutcome: 'PARTIAL',
  },
  failed: {
    attemptOutcome: 'FAILED',
    taskPhase: 'FAILED',
    terminalOutcome: 'FAILED',
  },
};

export interface ApplyAttemptResultDecisionV1 extends Record<string, unknown> {
  kind: 'APPLY_ATTEMPT_RESULT_V1';
  jobId: string;
  taskId: string;
  attemptId: string;
  resultId: string;
  inboxItemId: string;
  inboxSequence: number;
  planVersion: number;
  attemptFence: number;
  payloadHash: string;
  resultStatus: SupportedResultStatus;
  finishCurrentPauseGenerationAtA: number | null;
  /** Missing only on an offline-migrated PR-33 activation (defaults RECEIVED/0). */
  sourceState?: 'RECEIVED' | 'PENDING_REDRIVE';
  redriveAttempt?: number;
  /** Missing only on a pre-PR-35 frozen activation (defaults 0/0). */
  retryAttempt?: number;
  retryTimerGeneration?: number;
}

export interface RejectStaleInboxDecisionV1 extends Record<string, unknown> {
  kind: 'REJECT_STALE_INBOX_V1';
  jobId: string;
  inboxItemId: string;
  inboxSequence: number;
  taskId: string;
  attemptId: string;
  resultId: string;
  planVersion: number;
  attemptFence: number;
  payloadHash: string;
  consumerVersion: number;
  resolutionCode: 'stale_plan' | 'stale_task_result';
  /** Missing only on an offline-migrated PR-33 activation (defaults RECEIVED/0). */
  sourceState?: 'RECEIVED' | 'PENDING_REDRIVE';
  redriveAttempt?: number;
  /** Missing only on a pre-PR-35 frozen activation (defaults 0/0). */
  retryAttempt?: number;
  retryTimerGeneration?: number;
}

export interface QuarantineUnsupportedInboxDecisionV1
  extends Record<string, unknown> {
  kind: 'QUARANTINE_UNSUPPORTED_INBOX_V1';
  jobId: string;
  inboxItemId: string;
  inboxSequence: number;
  taskId: string;
  attemptId: string;
  resultId: string;
  planVersion: number;
  attemptFence: number;
  payloadHash: string;
  inboxKind: string;
  consumerVersion: number;
  redriveAttempt: number;
  sourceState: 'RECEIVED' | 'PENDING_REDRIVE';
  resolutionCode:
    | 'unsupported_inbox_kind'
    | 'unsupported_consumer_version';
}

export interface RetryTransientInboxDecisionV1
  extends Record<string, unknown> {
  kind: 'RETRY_TRANSIENT_INBOX_V1';
  jobId: string;
  inboxItemId: string;
  inboxSequence: number;
  taskId: string;
  attemptId: string;
  resultId: string;
  planVersion: number;
  attemptFence: number;
  payloadHash: string;
  inboxKind: 'ATTEMPT_RESULT_V1';
  consumerVersion: 1;
  redriveAttempt: number;
  retryAttempt: number;
  retryTimerGeneration: number;
  sourceState: 'RECEIVED' | 'PENDING_REDRIVE';
  retryReasonCode: InboxRetryReasonCode;
  retryPolicyVersion: 1;
  maxAutoRedriveAttempts: number;
  retryDelayMs: number;
}

export interface QuarantineRetryExhaustedInboxDecisionV1
  extends Record<string, unknown> {
  kind: 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1';
  jobId: string;
  inboxItemId: string;
  inboxSequence: number;
  taskId: string;
  attemptId: string;
  resultId: string;
  planVersion: number;
  attemptFence: number;
  payloadHash: string;
  inboxKind: 'ATTEMPT_RESULT_V1';
  consumerVersion: 1;
  redriveAttempt: number;
  retryAttempt: number;
  retryTimerGeneration: number;
  sourceState: 'RECEIVED' | 'PENDING_REDRIVE';
  retryReasonCode: InboxRetryReasonCode;
  retryPolicyVersion: 1;
  maxAutoRedriveAttempts: number;
  resolutionCode: 'transient_retry_exhausted';
}

export type ResultDrainBatchDecisionV1 =
  | ApplyAttemptResultDecisionV1
  | RejectStaleInboxDecisionV1
  | QuarantineUnsupportedInboxDecisionV1
  | RetryTransientInboxDecisionV1
  | QuarantineRetryExhaustedInboxDecisionV1;

export interface ResultDrainReducerPayloadV1 extends Record<string, unknown> {
  kind: 'DRAIN_RESULT_INBOX_BATCH_V1';
  jobId: string;
  planVersion: number;
  batchThroughWatermark: number;
  decisions: ResultDrainBatchDecisionV1[];
}

export interface ResultDrainActivationOptions {
  activationId?: string;
  sourceWakeId?: string | null;
  activationCapMs?: number;
  reserveForFinalizeMs?: number;
  reducerCommitReserveMs?: number;
  maxBatchItems?: number;
}

export interface ResultDrainLeaseHandle {
  activationId: string;
  jobId: string;
  kind: 'RESULT_DRAIN';
  leaseOwner: string;
  activationFence: number;
  leaseExpiresAt: Date;
  businessOperationCutoffAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
}

export interface ResultDrainCommitResult {
  activationId: string;
  jobId: string;
  taskId: string | null;
  attemptId: string | null;
  resultId: string | null;
  inboxItemId: string | null;
  batchInboxItemIds: string[];
  appliedInboxWatermark: number;
  resolvedInboxWatermark: number;
  successorWakeId: string | null;
  outcome: JobTerminalOutcome | null;
  deduped: boolean;
}

export interface InboxRedriveInput {
  resourceId: string;
  jobId: string;
  inboxItemId: string;
  redriveRequestId: string;
  expectedConsumerVersion: number;
}

export interface InboxRedriveResult {
  jobId: string;
  inboxItemId: string;
  redriveAttempt: number;
  wakeId: string;
  deduped: boolean;
}

export class InboxRedriveConflictError extends Error {
  constructor(
    readonly inboxItemId: string,
    readonly reason:
      | 'consumer_version_changed'
      | 'not_quarantined'
      | 'active_activation',
  ) {
    super(`inbox redrive conflict for ${inboxItemId}: ${reason}`);
    this.name = 'InboxRedriveConflictError';
  }
}

export class InboxRedriveUnavailableError extends Error {
  constructor(readonly inboxItemId: string) {
    super(`the current binary does not support inbox item ${inboxItemId}`);
    this.name = 'InboxRedriveUnavailableError';
  }
}

interface EligibleResultSlice {
  task: TaskDoc;
  attempt: AttemptDoc;
  result: ResultDoc;
  inbox: JobInboxDoc;
  status: SupportedResultStatus;
}

type ResultReadinessInspection =
  | { kind: 'ELIGIBLE'; slice: EligibleResultSlice }
  | { kind: 'TRANSIENT'; reasonCode: InboxRetryReasonCode }
  | { kind: 'DEFER' };

interface ResultDrainBatchPlan {
  task: TaskDoc;
  decisions: ResultDrainBatchDecisionV1[];
  inboxItems: JobInboxDoc[];
  applySlice: EligibleResultSlice | null;
  batchThroughWatermark: number;
}

class ResultDrainAuthorityLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultDrainAuthorityLostError';
  }
}

function isSupportedResultStatus(value: unknown): value is SupportedResultStatus {
  return value === 'ok' || value === 'partial' || value === 'failed';
}

function resultDrainControlIsCurrent(
  job: JobDoc,
  attempt: AttemptDoc,
  inbox: JobInboxDoc,
): boolean {
  if (job.controlState === 'NONE') return true;
  return job.controlState === 'PAUSE_REQUESTED'
    && attempt.finishCurrentPauseGeneration === job.pauseGeneration
    && inbox.finishCurrentPauseGenerationAtA === job.pauseGeneration;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function parseApplyDecision(value: unknown): ApplyAttemptResultDecisionV1 | null {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return null;
  const decision = value as Record<string, unknown>;
  if (
    decision.kind !== 'APPLY_ATTEMPT_RESULT_V1'
    || !isNonEmptyString(decision.jobId)
    || !isNonEmptyString(decision.taskId)
    || !isNonEmptyString(decision.attemptId)
    || !isNonEmptyString(decision.resultId)
    || !isNonEmptyString(decision.inboxItemId)
    || !isNonNegativeInteger(decision.planVersion)
    || !isNonNegativeInteger(decision.attemptFence)
    || !isNonEmptyString(decision.payloadHash)
    || !isSupportedResultStatus(decision.resultStatus)
    || (
      decision.finishCurrentPauseGenerationAtA !== null
      && !isNonNegativeInteger(decision.finishCurrentPauseGenerationAtA)
    )
    || (
      decision.sourceState !== undefined
      && decision.sourceState !== 'RECEIVED'
      && decision.sourceState !== 'PENDING_REDRIVE'
    )
    || (
      decision.redriveAttempt !== undefined
      && !isNonNegativeInteger(decision.redriveAttempt)
    )
    || (
      decision.retryAttempt !== undefined
      && !isNonNegativeInteger(decision.retryAttempt)
    )
    || (
      decision.retryTimerGeneration !== undefined
      && !isNonNegativeInteger(decision.retryTimerGeneration)
    )
  ) return null;
  return decision as ApplyAttemptResultDecisionV1;
}

function parseRejectDecision(value: unknown): RejectStaleInboxDecisionV1 | null {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return null;
  const decision = value as Record<string, unknown>;
  if (
    decision.kind !== 'REJECT_STALE_INBOX_V1'
    || !isNonEmptyString(decision.jobId)
    || !isNonEmptyString(decision.inboxItemId)
    || !isNonNegativeInteger(decision.inboxSequence)
    || decision.inboxSequence === 0
    || !isNonEmptyString(decision.taskId)
    || !isNonEmptyString(decision.attemptId)
    || !isNonEmptyString(decision.resultId)
    || !isNonNegativeInteger(decision.planVersion)
    || !isNonNegativeInteger(decision.attemptFence)
    || !isNonEmptyString(decision.payloadHash)
    || !isNonNegativeInteger(decision.consumerVersion)
    || (
      decision.resolutionCode !== 'stale_plan'
      && decision.resolutionCode !== 'stale_task_result'
    )
    || (
      decision.sourceState !== undefined
      && decision.sourceState !== 'RECEIVED'
      && decision.sourceState !== 'PENDING_REDRIVE'
    )
    || (
      decision.redriveAttempt !== undefined
      && !isNonNegativeInteger(decision.redriveAttempt)
    )
    || (
      decision.retryAttempt !== undefined
      && !isNonNegativeInteger(decision.retryAttempt)
    )
    || (
      decision.retryTimerGeneration !== undefined
      && !isNonNegativeInteger(decision.retryTimerGeneration)
    )
  ) return null;
  return decision as RejectStaleInboxDecisionV1;
}

function parseQuarantineDecision(
  value: unknown,
): QuarantineUnsupportedInboxDecisionV1 | null {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return null;
  const decision = value as Record<string, unknown>;
  if (
    decision.kind !== 'QUARANTINE_UNSUPPORTED_INBOX_V1'
    || !isNonEmptyString(decision.jobId)
    || !isNonEmptyString(decision.inboxItemId)
    || !isNonNegativeInteger(decision.inboxSequence)
    || decision.inboxSequence === 0
    || !isNonEmptyString(decision.taskId)
    || !isNonEmptyString(decision.attemptId)
    || !isNonEmptyString(decision.resultId)
    || !isNonNegativeInteger(decision.planVersion)
    || !isNonNegativeInteger(decision.attemptFence)
    || !isNonEmptyString(decision.payloadHash)
    || !isNonEmptyString(decision.inboxKind)
    || !isNonNegativeInteger(decision.consumerVersion)
    || !isNonNegativeInteger(decision.redriveAttempt)
    || (
      decision.sourceState !== 'RECEIVED'
      && decision.sourceState !== 'PENDING_REDRIVE'
    )
    || (
      decision.resolutionCode !== 'unsupported_inbox_kind'
      && decision.resolutionCode !== 'unsupported_consumer_version'
    )
  ) return null;
  return decision as QuarantineUnsupportedInboxDecisionV1;
}

function isInboxRetryReasonCode(value: unknown): value is InboxRetryReasonCode {
  return value === 'result_missing'
    || value === 'attempt_missing'
    || value === 'attempt_not_finished'
    || value === 'attempt_a_commit_incomplete';
}

function parseRetryDecision(
  value: unknown,
): RetryTransientInboxDecisionV1 | null {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return null;
  const decision = value as Record<string, unknown>;
  if (
    decision.kind !== 'RETRY_TRANSIENT_INBOX_V1'
    || !isNonEmptyString(decision.jobId)
    || !isNonEmptyString(decision.inboxItemId)
    || !isNonNegativeInteger(decision.inboxSequence)
    || decision.inboxSequence === 0
    || !isNonEmptyString(decision.taskId)
    || !isNonEmptyString(decision.attemptId)
    || !isNonEmptyString(decision.resultId)
    || !isNonNegativeInteger(decision.planVersion)
    || !isNonNegativeInteger(decision.attemptFence)
    || !isNonEmptyString(decision.payloadHash)
    || decision.inboxKind !== 'ATTEMPT_RESULT_V1'
    || decision.consumerVersion !== 1
    || !isNonNegativeInteger(decision.redriveAttempt)
    || !isNonNegativeInteger(decision.retryAttempt)
    || !isNonNegativeInteger(decision.retryTimerGeneration)
    || (
      decision.sourceState !== 'RECEIVED'
      && decision.sourceState !== 'PENDING_REDRIVE'
    )
    || !isInboxRetryReasonCode(decision.retryReasonCode)
    || decision.retryPolicyVersion !== INBOX_RETRY_POLICY_VERSION
    || decision.maxAutoRedriveAttempts !== MAX_AUTO_REDRIVE_ATTEMPTS
    || !isNonNegativeInteger(decision.retryDelayMs)
    || decision.retryDelayMs <= 0
  ) return null;
  return decision as RetryTransientInboxDecisionV1;
}

function parseRetryExhaustedDecision(
  value: unknown,
): QuarantineRetryExhaustedInboxDecisionV1 | null {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return null;
  const decision = value as Record<string, unknown>;
  if (
    decision.kind !== 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
    || !isNonEmptyString(decision.jobId)
    || !isNonEmptyString(decision.inboxItemId)
    || !isNonNegativeInteger(decision.inboxSequence)
    || decision.inboxSequence === 0
    || !isNonEmptyString(decision.taskId)
    || !isNonEmptyString(decision.attemptId)
    || !isNonEmptyString(decision.resultId)
    || !isNonNegativeInteger(decision.planVersion)
    || !isNonNegativeInteger(decision.attemptFence)
    || !isNonEmptyString(decision.payloadHash)
    || decision.inboxKind !== 'ATTEMPT_RESULT_V1'
    || decision.consumerVersion !== 1
    || !isNonNegativeInteger(decision.redriveAttempt)
    || !isNonNegativeInteger(decision.retryAttempt)
    || decision.retryAttempt < MAX_AUTO_REDRIVE_ATTEMPTS
    || !isNonNegativeInteger(decision.retryTimerGeneration)
    || (
      decision.sourceState !== 'RECEIVED'
      && decision.sourceState !== 'PENDING_REDRIVE'
    )
    || !isInboxRetryReasonCode(decision.retryReasonCode)
    || decision.retryPolicyVersion !== INBOX_RETRY_POLICY_VERSION
    || decision.maxAutoRedriveAttempts !== MAX_AUTO_REDRIVE_ATTEMPTS
    || decision.resolutionCode !== 'transient_retry_exhausted'
  ) return null;
  return decision as QuarantineRetryExhaustedInboxDecisionV1;
}

function parseReducerPayload(
  value: Record<string, unknown> | null,
): ResultDrainReducerPayloadV1 | null {
  if (
    !value
    || value.kind !== 'DRAIN_RESULT_INBOX_BATCH_V1'
    || !isNonEmptyString(value.jobId)
    || !isNonNegativeInteger(value.planVersion)
    || !isNonNegativeInteger(value.batchThroughWatermark)
    || !Array.isArray(value.decisions)
    || value.decisions.length === 0
    || value.decisions.length > MAX_BATCH_ITEMS
  ) return null;
  const decisions: ResultDrainBatchDecisionV1[] = [];
  let applyCount = 0;
  let previousSequence = 0;
  for (const rawDecision of value.decisions) {
    const apply = parseApplyDecision(rawDecision);
    const reject = apply ? null : parseRejectDecision(rawDecision);
    const quarantine = apply || reject
      ? null
      : parseQuarantineDecision(rawDecision);
    const retry = apply || reject || quarantine
      ? null
      : parseRetryDecision(rawDecision);
    const exhausted = apply || reject || quarantine || retry
      ? null
      : parseRetryExhaustedDecision(rawDecision);
    const decision = apply ?? reject ?? quarantine ?? retry ?? exhausted;
    if (!decision) return null;
    const sequence = decision.inboxSequence;
    // PR-32 apply payloads did not carry a sequence. PR-33 requires it.
    if (!isNonNegativeInteger(sequence) || sequence === 0 || sequence <= previousSequence) {
      return null;
    }
    previousSequence = sequence;
    if (apply) applyCount++;
    decisions.push(decision);
  }
  if (
    applyCount > 1
    || previousSequence !== value.batchThroughWatermark
  ) return null;
  return {
    kind: 'DRAIN_RESULT_INBOX_BATCH_V1',
    jobId: value.jobId,
    planVersion: value.planVersion,
    batchThroughWatermark: value.batchThroughWatermark,
    decisions,
  };
}

function applyDecisionForSlice(
  job: JobDoc,
  slice: EligibleResultSlice,
): ApplyAttemptResultDecisionV1 {
  return {
    kind: 'APPLY_ATTEMPT_RESULT_V1',
    jobId: job._id,
    taskId: slice.task._id,
    attemptId: slice.attempt._id,
    resultId: slice.result._id,
    inboxItemId: slice.inbox._id,
    inboxSequence: slice.inbox.inboxSequence,
    planVersion: slice.result.planVersion,
    attemptFence: slice.result.attemptFence,
    payloadHash: slice.result.payloadHash,
    resultStatus: slice.status,
    finishCurrentPauseGenerationAtA: slice.inbox.finishCurrentPauseGenerationAtA,
    sourceState: slice.inbox.state,
    redriveAttempt: slice.inbox.redriveAttempt,
    retryAttempt: slice.inbox.retryAttempt,
    retryTimerGeneration: slice.inbox.retryTimerGeneration,
  } as ApplyAttemptResultDecisionV1;
}

function quarantineDecisionForItem(
  job: JobDoc,
  item: JobInboxDoc,
): QuarantineUnsupportedInboxDecisionV1 | null {
  if (
    !Number.isInteger(item.inboxSequence)
    || item.inboxSequence <= 0
    || (
      item.state !== 'RECEIVED'
      && item.state !== 'PENDING_REDRIVE'
    )
  ) return null;
  const resolutionCode =
    item.kind !== 'ATTEMPT_RESULT_V1'
      ? 'unsupported_inbox_kind'
      : item.consumerVersion !== 1
        ? 'unsupported_consumer_version'
        : null;
  if (!resolutionCode) return null;
  return {
    kind: 'QUARANTINE_UNSUPPORTED_INBOX_V1',
    jobId: job._id,
    inboxItemId: item._id,
    inboxSequence: item.inboxSequence,
    taskId: item.taskId,
    attemptId: item.attemptId,
    resultId: item.resultId,
    planVersion: item.planVersion,
    attemptFence: item.attemptFence,
    payloadHash: item.payloadHash,
    inboxKind: item.kind,
    consumerVersion: item.consumerVersion,
    redriveAttempt: item.redriveAttempt,
    sourceState: item.state,
    resolutionCode,
  };
}

function rejectDecisionForItem(
  job: JobDoc,
  task: TaskDoc,
  item: JobInboxDoc,
): RejectStaleInboxDecisionV1 | null {
  if (
    item.kind !== 'ATTEMPT_RESULT_V1'
    || item.consumerVersion !== 1
    || (
      item.state !== 'RECEIVED'
      && item.state !== 'PENDING_REDRIVE'
    )
    || !Number.isInteger(item.inboxSequence)
    || item.inboxSequence <= 0
  ) return null;
  const stalePlan = item.planVersion !== job.planVersion;
  const expectedResultId = task.pendingResultId ?? task.appliedResultId ?? null;
  const staleTaskResult =
    item.taskId !== task._id
    || (expectedResultId !== null && item.resultId !== expectedResultId);
  if (!stalePlan && !staleTaskResult) return null;
  return {
    kind: 'REJECT_STALE_INBOX_V1',
    jobId: job._id,
    inboxItemId: item._id,
    inboxSequence: item.inboxSequence,
    taskId: item.taskId,
    attemptId: item.attemptId,
    resultId: item.resultId,
    planVersion: item.planVersion,
    attemptFence: item.attemptFence,
    payloadHash: item.payloadHash,
    consumerVersion: item.consumerVersion,
    resolutionCode: stalePlan ? 'stale_plan' : 'stale_task_result',
    sourceState: item.state,
    redriveAttempt: item.redriveAttempt,
    retryAttempt: item.retryAttempt,
    retryTimerGeneration: item.retryTimerGeneration,
  };
}

/**
 * PR-33 activations may lack the redrive snapshot and PR-34 activations may
 * lack the retry snapshot. Offline migration gives both generations their only
 * safe legacy value (zero); newly frozen work always matches all exact epochs.
 */
function decisionMatchesFrozen(
  current: ResultDrainBatchDecisionV1,
  frozen: ResultDrainBatchDecisionV1,
): boolean {
  if (canonicalHash(current) === canonicalHash(frozen)) return true;
  if (
    (current.kind !== 'APPLY_ATTEMPT_RESULT_V1'
      && current.kind !== 'REJECT_STALE_INBOX_V1')
    || current.kind !== frozen.kind
  ) {
    return false;
  }
  const normalized = { ...current };
  if (
    frozen.sourceState === undefined
    && frozen.redriveAttempt === undefined
  ) {
    if (
      current.sourceState !== 'RECEIVED'
      || current.redriveAttempt !== 0
    ) return false;
    delete normalized.sourceState;
    delete normalized.redriveAttempt;
  }
  if (
    frozen.retryAttempt === undefined
    && frozen.retryTimerGeneration === undefined
  ) {
    if (
      current.retryAttempt !== 0
      || current.retryTimerGeneration !== 0
    ) return false;
    delete normalized.retryAttempt;
    delete normalized.retryTimerGeneration;
  }
  return canonicalHash(normalized) === canonicalHash(frozen);
}

function deriveActivationWindow(opts: ResultDrainActivationOptions): {
  businessOperationCutoffAt: Date;
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
  now: Date;
} {
  const now = new Date();
  const activationCapMs = opts.activationCapMs ?? DEFAULT_ACTIVATION_CAP_MS;
  const reserveForFinalizeMs = opts.reserveForFinalizeMs ?? DEFAULT_FINALIZE_RESERVE_MS;
  const reducerCommitReserveMs =
    opts.reducerCommitReserveMs ?? DEFAULT_REDUCER_COMMIT_RESERVE_MS;
  if (
    activationCapMs <= 0
    || reserveForFinalizeMs < 0
    || reducerCommitReserveMs < 0
    || reserveForFinalizeMs + reducerCommitReserveMs >= activationCapMs
  ) {
    throw new Error('invalid result-drain activation deadline reserves');
  }
  const hardDeadlineAt = new Date(now.getTime() + activationCapMs);
  const deadlines = deriveAttemptDeadlines({
    hardDeadlineAt: hardDeadlineAt.getTime(),
    reserveForFinalizeMs,
    resultCommitReserveMs: reducerCommitReserveMs,
  });
  if (deadlines.workDeadlineAt <= now.getTime()) {
    throw new Error('result-drain activation reserves leave no reducer window');
  }
  const workDeadlineAt = new Date(deadlines.workDeadlineAt);
  return {
    now,
    // RESULT_DRAIN has no business/model/tool phase and no payload-ready marker.
    // Keep the generic activation reaper from treating marker=0 as expired
    // before the reducer's actual work deadline.
    businessOperationCutoffAt: workDeadlineAt,
    workDeadlineAt,
    hardDeadlineAt,
  };
}

const TERMINAL_RESULT_TASK_PHASES = new Set<TaskPhase>([
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
]);

async function loadRootResultTask(
  db: Db,
  job: JobDoc,
  session: ClientSession,
): Promise<TaskDoc | null> {
  if (
    job.terminalOutcome !== null
    || (
      job.phase !== 'AWAITING_RESULTS'
      && job.phase !== 'RECONCILING'
    )
    || (job.controlState !== 'NONE' && job.controlState !== 'PAUSE_REQUESTED')
  ) {
    return null;
  }

  const tasks = await db.collection<TaskDoc>(COLLECTIONS.tasks)
    .find({ jobId: job._id }, { session })
    .limit(2)
    .toArray();
  if (tasks.length !== 1) return null;
  const task = tasks[0]!;
  if (
    task.attemptMode !== 'SERIAL'
    || task.resultApplyMode !== 'RESULT_DRAIN_V1'
    || task.controlState !== 'NONE'
    || task.planVersion !== job.planVersion
    || task.activeAttemptId !== null
    || !(
      (
        task.phase === 'AWAITING_RESULT'
        && isNonEmptyString(task.pendingResultId)
        && task.appliedResultId === null
      )
      || (
        TERMINAL_RESULT_TASK_PHASES.has(task.phase)
        && task.pendingResultId === null
        && isNonEmptyString(task.appliedResultId)
      )
    )
  ) {
    return null;
  }

  const edge = await db.collection(COLLECTIONS.edges)
    .findOne({ jobId: job._id }, { session, projection: { _id: 1 } });
  if (edge) return null;
  return task;
}

async function loadEligibleResultSliceForItem(
  db: Db,
  job: JobDoc,
  task: TaskDoc,
  session: ClientSession,
  inbox: JobInboxDoc,
): Promise<EligibleResultSlice | null> {
  const inspection = await inspectResultReadinessForItem(
    db,
    job,
    task,
    session,
    inbox,
  );
  return inspection.kind === 'ELIGIBLE' ? inspection.slice : null;
}

async function inspectResultReadinessForItem(
  db: Db,
  job: JobDoc,
  task: TaskDoc,
  session: ClientSession,
  inbox: JobInboxDoc,
): Promise<ResultReadinessInspection> {
  if (
    task.phase !== 'AWAITING_RESULT'
    || !isNonEmptyString(task.pendingResultId)
    || task.appliedResultId !== null
    || inbox.jobId !== job._id
    || (
      inbox.state !== 'RECEIVED'
      && inbox.state !== 'PENDING_REDRIVE'
    )
    || inbox.kind !== 'ATTEMPT_RESULT_V1'
    || inbox.consumerVersion !== 1
    || !Number.isInteger(inbox.inboxSequence)
    || inbox.inboxSequence <= 0
    || inbox.taskId !== task._id
    || inbox.resultId !== task.pendingResultId
    || inbox.planVersion !== task.planVersion
    || inbox.appliedByActivationId !== null
    || inbox.resolvedAt !== null
  ) {
    return { kind: 'DEFER' };
  }

  const [result, attempt] = await Promise.all([
    db.collection<ResultDoc>(COLLECTIONS.results)
      .findOne({ _id: inbox.resultId }, { session }),
    db.collection<AttemptDoc>(COLLECTIONS.attempts)
      .findOne({ _id: inbox.attemptId }, { session }),
  ]);
  if (!result) {
    // During finish-current pause, the persisted attempt membership is part of
    // the authority intersection. A missing attempt cannot prove membership.
    if (
      job.controlState === 'PAUSE_REQUESTED'
      && (
        !attempt
        || !resultDrainControlIsCurrent(job, attempt, inbox)
      )
    ) return { kind: 'DEFER' };
    return { kind: 'TRANSIENT', reasonCode: 'result_missing' };
  }
  if (!attempt) {
    return job.controlState === 'PAUSE_REQUESTED'
      ? { kind: 'DEFER' }
      : { kind: 'TRANSIENT', reasonCode: 'attempt_missing' };
  }
  if (
    !isSupportedResultStatus(result.status)
    || result.producer.status !== result.status
    || result.jobId !== job._id
    || result.taskId !== task._id
    || result.attemptId !== attempt._id
    || result.planVersion !== job.planVersion
    || result.attemptFence !== inbox.attemptFence
    || result.payloadHash !== inbox.payloadHash
    || attempt.jobId !== job._id
    || attempt.taskId !== task._id
    || attempt.planVersion !== job.planVersion
    || attempt.attemptFence !== result.attemptFence
    || !resultDrainControlIsCurrent(job, attempt, inbox)
  ) {
    // Immutable authority/schema mismatches are neither retried nor applied by
    // this bounded flat slice. The general classifier remains a later gate.
    return { kind: 'DEFER' };
  }
  if (attempt.lifecycle !== 'FINISHED') {
    return { kind: 'TRANSIENT', reasonCode: 'attempt_not_finished' };
  }
  if (
    attempt.resultId !== result._id
    || attempt.outcome !== RESULT_TRANSITIONS[result.status].attemptOutcome
    || attempt.leaseOwnerAtCommit !== result.leaseOwnerAtCommit
    || attempt.committedPayloadHash !== result.payloadHash
    || !(attempt.ACommittedAt instanceof Date)
    || !(result.ACommittedAt instanceof Date)
    || attempt.ACommittedAt.getTime() !== result.ACommittedAt.getTime()
  ) {
    return {
      kind: 'TRANSIENT',
      reasonCode: 'attempt_a_commit_incomplete',
    };
  }

  return {
    kind: 'ELIGIBLE',
    slice: { task, attempt, result, inbox, status: result.status },
  };
}

function transientDecisionForItem(
  job: JobDoc,
  item: JobInboxDoc,
  reasonCode: InboxRetryReasonCode,
): RetryTransientInboxDecisionV1 | QuarantineRetryExhaustedInboxDecisionV1 | null {
  if (
    item.kind !== 'ATTEMPT_RESULT_V1'
    || item.consumerVersion !== 1
    || (
      item.state !== 'RECEIVED'
      && item.state !== 'PENDING_REDRIVE'
    )
    || !Number.isInteger(item.inboxSequence)
    || item.inboxSequence <= 0
    || !isNonNegativeInteger(item.redriveAttempt)
    || !isNonNegativeInteger(item.retryAttempt)
    || !isNonNegativeInteger(item.retryTimerGeneration)
    || item.retryTimerId !== null
    || item.nextEligibleAt !== null
  ) return null;
  const common = {
    jobId: job._id,
    inboxItemId: item._id,
    inboxSequence: item.inboxSequence,
    taskId: item.taskId,
    attemptId: item.attemptId,
    resultId: item.resultId,
    planVersion: item.planVersion,
    attemptFence: item.attemptFence,
    payloadHash: item.payloadHash,
    inboxKind: 'ATTEMPT_RESULT_V1' as const,
    consumerVersion: 1 as const,
    redriveAttempt: item.redriveAttempt,
    retryAttempt: item.retryAttempt,
    retryTimerGeneration: item.retryTimerGeneration,
    sourceState: item.state,
    retryReasonCode: reasonCode,
    retryPolicyVersion: INBOX_RETRY_POLICY_VERSION as 1,
    maxAutoRedriveAttempts: MAX_AUTO_REDRIVE_ATTEMPTS,
  };
  if (item.retryAttempt >= MAX_AUTO_REDRIVE_ATTEMPTS) {
    return {
      kind: 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1',
      ...common,
      resolutionCode: 'transient_retry_exhausted',
    };
  }
  return {
    kind: 'RETRY_TRANSIENT_INBOX_V1',
    ...common,
    retryDelayMs:
      INBOX_RETRY_BASE_MS * 2 ** item.retryAttempt,
  };
}

function decisionSequence(decision: ResultDrainBatchDecisionV1): number {
  return decision.inboxSequence;
}

function decisionAttemptId(decision: ResultDrainBatchDecisionV1): string {
  return decision.attemptId;
}

function orderedPurposeAttemptIds(
  decisions: ResultDrainBatchDecisionV1[],
): string[] {
  return [...new Set(decisions.map(decisionAttemptId))];
}

function normalizedMaxBatchItems(opts: ResultDrainActivationOptions): number {
  const value = opts.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_BATCH_ITEMS) {
    throw new Error(`result-drain maxBatchItems must be within 1..${MAX_BATCH_ITEMS}`);
  }
  return value;
}

async function buildResultDrainBatchPlan(
  db: Db,
  job: JobDoc,
  session: ClientSession,
  opts: ResultDrainActivationOptions = {},
): Promise<ResultDrainBatchPlan | null> {
  const task = await loadRootResultTask(db, job, session);
  if (!task) return null;
  const maxBatchItems = normalizedMaxBatchItems(opts);
  const candidateFilter: Filter<JobInboxDoc> = {
    jobId: job._id,
    state: { $in: ['RECEIVED', 'PENDING_REDRIVE'] },
    $and: [
      { inboxSequence: { $lte: job.inboxHighWatermark } },
      {
        $or: [
          { inboxSequence: { $gt: job.resolvedInboxWatermark } },
          { state: 'PENDING_REDRIVE' },
        ],
      },
    ],
    ...(job.controlState === 'PAUSE_REQUESTED'
      ? { finishCurrentPauseGenerationAtA: job.pauseGeneration }
      : {}),
  };
  const candidates = await db.collection<JobInboxDoc>(COLLECTIONS.inbox)
    .find(candidateFilter, { session })
    .sort({ inboxSequence: 1 })
    .limit(MAX_BATCH_ITEMS * 4)
    .toArray();

  const decisions: ResultDrainBatchDecisionV1[] = [];
  const batchItems: JobInboxDoc[] = [];
  let applySlice: EligibleResultSlice | null = null;
  for (const item of candidates) {
    if (decisions.length >= maxBatchItems) break;

    const quarantine = quarantineDecisionForItem(job, item);
    if (quarantine) {
      decisions.push(quarantine);
      batchItems.push(item);
      continue;
    }

    // Under pause, the query admitted only the persisted finish-current
    // intersection. Every other stale/unsupported/deferred row stays untouched
    // until resume.
    if (job.controlState === 'PAUSE_REQUESTED') {
      const inspection = await inspectResultReadinessForItem(
        db,
        job,
        task,
        session,
        item,
      );
      if (inspection.kind === 'ELIGIBLE') {
        // The one-APPLY batch cap is a planner constraint, never a reason to
        // misclassify a second otherwise-valid row as transient.
        if (applySlice) continue;
        decisions.push(applyDecisionForSlice(job, inspection.slice));
        batchItems.push(item);
        applySlice = inspection.slice;
      } else if (inspection.kind === 'TRANSIENT') {
        const decision = transientDecisionForItem(
          job,
          item,
          inspection.reasonCode,
        );
        if (decision) {
          decisions.push(decision);
          batchItems.push(item);
        }
      }
      continue;
    }

    const rejected = rejectDecisionForItem(job, task, item);
    if (rejected) {
      decisions.push(rejected);
      batchItems.push(item);
      continue;
    }
    const inspection = await inspectResultReadinessForItem(
      db,
      job,
      task,
      session,
      item,
    );
    if (inspection.kind === 'ELIGIBLE') {
      if (!applySlice) {
        decisions.push(applyDecisionForSlice(job, inspection.slice));
        batchItems.push(item);
        applySlice = inspection.slice;
      }
      continue;
    }
    if (inspection.kind === 'TRANSIENT') {
      const decision = transientDecisionForItem(
        job,
        item,
        inspection.reasonCode,
      );
      if (decision) {
        decisions.push(decision);
        batchItems.push(item);
      }
    }
  }
  if (decisions.length === 0) return null;
  return {
    task,
    decisions,
    inboxItems: batchItems,
    applySlice,
    batchThroughWatermark: decisionSequence(decisions[decisions.length - 1]!),
  };
}

/** Read-only eligibility probe shared by B handoff and recovery. */
export async function findNextEligibleResultDrainInboxItem(
  db: Db,
  job: JobDoc,
  session: ClientSession,
): Promise<JobInboxDoc | null> {
  const plan = await buildResultDrainBatchPlan(db, job, session, { maxBatchItems: 1 });
  return plan?.inboxItems[0] ?? null;
}

async function loadFrozenBatchPlan(
  db: Db,
  job: JobDoc,
  activation: LaneActivationDoc,
  session: ClientSession,
): Promise<ResultDrainBatchPlan | null> {
  const payload = parseReducerPayload(activation.reducerPayload);
  if (
    !payload
    || payload.jobId !== job._id
    || payload.planVersion !== job.planVersion
    || payload.batchThroughWatermark !== activation.batchThroughWatermark
    || activation.batchInboxItemIds.length !== payload.decisions.length
    || activation.batchInboxItemIds.some(
      (id, index) => id !== payload.decisions[index]!.inboxItemId,
    )
    || canonicalHash(orderedPurposeAttemptIds(payload.decisions))
      !== canonicalHash(activation.purposeAttemptIds)
  ) return null;

  const task = await loadRootResultTask(db, job, session);
  if (!task) return null;
  const rows = await db.collection<JobInboxDoc>(COLLECTIONS.inbox)
    .find(
      {
        jobId: job._id,
        _id: { $in: activation.batchInboxItemIds },
        state: { $in: ['RECEIVED', 'PENDING_REDRIVE'] },
      },
      { session },
    )
    .toArray();
  const byId = new Map(rows.map((row) => [row._id, row]));
  const inboxItems: JobInboxDoc[] = [];
  let applySlice: EligibleResultSlice | null = null;
  for (const decision of payload.decisions) {
    const item = byId.get(decision.inboxItemId);
    if (!item || item.inboxSequence !== decision.inboxSequence) return null;
    if (decision.kind === 'REJECT_STALE_INBOX_V1') {
      const current = rejectDecisionForItem(job, task, item);
      if (!current || !decisionMatchesFrozen(current, decision)) return null;
    } else if (decision.kind === 'QUARANTINE_UNSUPPORTED_INBOX_V1') {
      const current = quarantineDecisionForItem(job, item);
      if (!current || canonicalHash(current) !== canonicalHash(decision)) return null;
    } else if (
      decision.kind === 'RETRY_TRANSIENT_INBOX_V1'
      || decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
    ) {
      const inspection = await inspectResultReadinessForItem(
        db,
        job,
        task,
        session,
        item,
      );
      if (inspection.kind !== 'TRANSIENT') return null;
      const current = transientDecisionForItem(
        job,
        item,
        inspection.reasonCode,
      );
      if (!current || canonicalHash(current) !== canonicalHash(decision)) return null;
    } else if (decision.kind === 'APPLY_ATTEMPT_RESULT_V1') {
      if (applySlice) return null;
      const slice = await loadEligibleResultSliceForItem(db, job, task, session, item);
      if (
        !slice
        || !decisionMatchesFrozen(applyDecisionForSlice(job, slice), decision)
      ) return null;
      applySlice = slice;
    } else {
      return null;
    }
    inboxItems.push(item);
  }
  return {
    task,
    decisions: payload.decisions,
    inboxItems,
    applySlice,
    batchThroughWatermark: payload.batchThroughWatermark,
  };
}

function activationMatchesBatch(
  activation: LaneActivationDoc,
  job: JobDoc,
  batch: ResultDrainBatchPlan,
): boolean {
  return activation.kind === 'RESULT_DRAIN'
    && activation.jobId === job._id
    && activation.batchThroughWatermark === batch.batchThroughWatermark
    && canonicalHash(activation.batchInboxItemIds)
      === canonicalHash(batch.inboxItems.map((item) => item._id))
    && canonicalHash(activation.purposeAttemptIds)
      === canonicalHash(orderedPurposeAttemptIds(batch.decisions));
}

async function nextEventSeq(
  db: Db,
  jobId: string,
  session: ClientSession,
): Promise<number> {
  const last = await db.collection<JobEventDoc>(COLLECTIONS.events)
    .find({ jobId }, { session })
    .sort({ sequence: -1 })
    .limit(1)
    .next();
  return (last?.sequence ?? -1) + 1;
}

function currentJobFilter(
  activation: LaneActivationDoc,
): Filter<JobDoc> {
  return {
    _id: activation.jobId,
    activeActivationId: activation._id,
    terminalOutcome: null,
    phase: { $in: ['AWAITING_RESULTS', 'RECONCILING'] },
    planVersion: activation.planVersionAtClaim,
    jobStopGeneration: activation.jobStopGenerationAtClaim,
    activationDispatchGeneration: activation.activationDispatchGenerationAtClaim,
    controlState: { $in: ['NONE', 'PAUSE_REQUESTED'] },
  };
}

/**
 * Freeze one bounded, sequence-ordered durable inbox batch behind the job's
 * unique active-activation slot. A wake's item identity is only a demand hint;
 * selection always comes from the current durable job/inbox authority.
 * A wake claimer calls this variant in the same transaction that publishes the
 * wake, so no consumed wake can exist without either a durable activation or an
 * intentionally ineligible result.
 */
export async function materializeResultDrainActivationInSession(
  db: Db,
  job: JobDoc,
  session: ClientSession,
  opts: ResultDrainActivationOptions = {},
): Promise<LaneActivationDoc | null> {
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  if (job.activeActivationId !== null) {
    return activations.findOne(
      {
        _id: job.activeActivationId,
        jobId: job._id,
        kind: 'RESULT_DRAIN',
        lifecycle: { $in: ACTIVE_ACTIVATION_LIFECYCLES },
        activeSlot: true,
      },
      { session },
    );
  }

  const batch = await buildResultDrainBatchPlan(db, job, session, opts);
  if (!batch) return null;
  const activationId = opts.activationId ?? newActivationId();
  const window = deriveActivationWindow(opts);
  const reducerPayload: ResultDrainReducerPayloadV1 = {
    kind: 'DRAIN_RESULT_INBOX_BATCH_V1',
    jobId: job._id,
    planVersion: job.planVersion,
    batchThroughWatermark: batch.batchThroughWatermark,
    decisions: batch.decisions,
  };
  const activation: LaneActivationDoc = {
    _id: activationId,
    sourceWakeId: opts.sourceWakeId ?? null,
    jobId: job._id,
    kind: 'RESULT_DRAIN',
    lifecycle: 'PENDING',
    activeSlot: true,
    activationDispatchGenerationAtClaim: job.activationDispatchGeneration,
    planVersionAtClaim: job.planVersion,
    jobStopGenerationAtClaim: job.jobStopGeneration,
    leaseOwner: null,
    leaseExpiresAt: null,
    activationFence: 0,
    operationStartedAt: null,
    businessOperationCutoffAt: window.businessOperationCutoffAt,
    workDeadlineAt: window.workDeadlineAt,
    hardDeadlineAt: window.hardDeadlineAt,
    purposeAttemptIds: orderedPurposeAttemptIds(batch.decisions),
    batchInboxItemIds: batch.inboxItems.map((item) => item._id),
    batchThroughWatermark: batch.batchThroughWatermark,
    inboxHighWatermarkAtClaim: job.inboxHighWatermark,
    appliedInboxWatermarkAtClaim: job.appliedInboxWatermark,
    resolvedInboxWatermarkAtClaim: job.resolvedInboxWatermark,
    businessPayloadReadyGeneration: 0,
    businessPayloadReadyHash: null,
    businessPayloadReadyAt: null,
    reducerPayload,
    committedPayloadHash: null,
    committedAppliedInboxWatermark: null,
    committedResolvedInboxWatermark: null,
    successorWakeId: null,
    committedAt: null,
    outcome: null,
    reasonCode: null,
    createdAt: window.now,
    updatedAt: window.now,
  };

  const jobCas = await db.collection<JobDoc>(COLLECTIONS.jobs).updateOne(
    {
      _id: job._id,
      stateVersion: job.stateVersion,
      terminalOutcome: null,
      phase: job.phase,
      controlState: job.controlState,
      pauseGeneration: job.pauseGeneration,
      planVersion: job.planVersion,
      jobStopGeneration: job.jobStopGeneration,
      activationDispatchGeneration: job.activationDispatchGeneration,
      activeActivationId: null,
    },
    {
      $set: {
        activeActivationId: activationId,
        updatedAt: window.now,
      },
      $inc: { stateVersion: 1 },
    },
    { session },
  );
  if (jobCas.modifiedCount !== 1) {
    throw new ResultDrainAuthorityLostError('result-drain activation slot CAS lost');
  }
  await activations.insertOne(activation, { session });
  return activation;
}

/** Direct/test entrypoint; production wake claim uses the in-session variant. */
export async function materializeResultDrainActivation(
  client: MongoClient,
  db: Db,
  jobId: string,
  opts: ResultDrainActivationOptions = {},
): Promise<LaneActivationDoc | null> {
  try {
    const { value } = await runTxn(client, async (session) => {
      const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
        .findOne({ _id: jobId }, { session });
      if (!job) return null;
      return materializeResultDrainActivationInSession(db, job, session, opts);
    });
    return value;
  } catch (err) {
    if (err instanceof ResultDrainAuthorityLostError) return null;
    throw err;
  }
}

/** PENDING → LEASED; mint the job-scoped activation fence atomically. */
export async function claimResultDrainActivation(
  client: MongoClient,
  db: Db,
  input: { activationId: string; leaseOwner: string; leaseTtlMs?: number },
): Promise<ResultDrainLeaseHandle | null> {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_ACTIVATION_LEASE_TTL_MS;
  if (leaseTtlMs <= 0) throw new Error('result-drain activation lease TTL must be positive');
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne(
        {
          _id: input.activationId,
          kind: 'RESULT_DRAIN',
          activeSlot: true,
        },
        { session },
      );
      if (!activation) return null;

      const job = await jobs.findOne(currentJobFilter(activation), { session });
      if (!job) return null;
      if (
        activation.lifecycle !== 'PENDING'
        && job.activationFence !== activation.activationFence
      ) {
        return null;
      }
      const batch = await loadFrozenBatchPlan(db, job, activation, session);
      if (!batch || !activationMatchesBatch(activation, job, batch)) return null;

      if (
        (activation.lifecycle === 'LEASED' || activation.lifecycle === 'RUNNING')
        && activation.leaseOwner === input.leaseOwner
      ) {
        const replay = await activations.findOneAndUpdate(
          {
            _id: activation._id,
            kind: 'RESULT_DRAIN',
            lifecycle: { $in: ['LEASED', 'RUNNING'] },
            activeSlot: true,
            leaseOwner: input.leaseOwner,
            activationFence: activation.activationFence,
            $expr: {
              $and: [
                { $gt: ['$leaseExpiresAt', '$$NOW'] },
                { $gt: ['$workDeadlineAt', '$$NOW'] },
                { $gt: ['$hardDeadlineAt', '$$NOW'] },
              ],
            },
          } as unknown as Filter<LaneActivationDoc>,
          [{ $set: { updatedAt: '$$NOW' } }],
          { session, returnDocument: 'after' },
        );
        if (!replay?.leaseExpiresAt) return null;
        return {
          activationId: replay._id,
          jobId: replay.jobId,
          kind: 'RESULT_DRAIN',
          leaseOwner: input.leaseOwner,
          activationFence: replay.activationFence,
          leaseExpiresAt: replay.leaseExpiresAt,
          businessOperationCutoffAt: replay.businessOperationCutoffAt,
          workDeadlineAt: replay.workDeadlineAt,
          hardDeadlineAt: replay.hardDeadlineAt,
        } satisfies ResultDrainLeaseHandle;
      }
      if (activation.lifecycle !== 'PENDING') return null;

      const fencedJob = await jobs.findOneAndUpdate(
        {
          ...currentJobFilter(activation),
          stateVersion: job.stateVersion,
          pauseGeneration: job.pauseGeneration,
          activationFence: job.activationFence,
        },
        {
          $set: { updatedAt: new Date() },
          $inc: { stateVersion: 1, activationFence: 1 },
        },
        { session, returnDocument: 'after' },
      );
      if (!fencedJob) {
        throw new ResultDrainAuthorityLostError('result-drain activation fence CAS lost');
      }

      const claimed = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'RESULT_DRAIN',
          lifecycle: 'PENDING',
          activeSlot: true,
          activationFence: 0,
          $expr: {
            $and: [
              { $gt: ['$workDeadlineAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<LaneActivationDoc>,
        [{
          $set: {
            lifecycle: 'LEASED',
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: {
              $min: [
                {
                  $dateAdd: {
                    startDate: '$$NOW',
                    unit: 'millisecond',
                    amount: leaseTtlMs,
                  },
                },
                '$workDeadlineAt',
                '$hardDeadlineAt',
              ],
            },
            activationFence: fencedJob.activationFence,
            planVersionAtClaim: fencedJob.planVersion,
            jobStopGenerationAtClaim: fencedJob.jobStopGeneration,
            activationDispatchGenerationAtClaim: fencedJob.activationDispatchGeneration,
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!claimed?.leaseExpiresAt) {
        throw new ResultDrainAuthorityLostError('result-drain claim deadline CAS lost');
      }
      return {
        activationId: claimed._id,
        jobId: claimed.jobId,
        kind: 'RESULT_DRAIN',
        leaseOwner: input.leaseOwner,
        activationFence: claimed.activationFence,
        leaseExpiresAt: claimed.leaseExpiresAt,
        businessOperationCutoffAt: claimed.businessOperationCutoffAt,
        workDeadlineAt: claimed.workDeadlineAt,
        hardDeadlineAt: claimed.hardDeadlineAt,
      } satisfies ResultDrainLeaseHandle;
    });
    return value;
  } catch (err) {
    if (err instanceof ResultDrainAuthorityLostError) return null;
    throw err;
  }
}

/** LEASED → RUNNING; no business/model/tool operation occurs in this activation. */
export async function startResultDrainActivation(
  client: MongoClient,
  db: Db,
  input: { activationId: string; leaseOwner: string; activationFence: number },
): Promise<boolean> {
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne(
        {
          _id: input.activationId,
          kind: 'RESULT_DRAIN',
          activationFence: input.activationFence,
        },
        { session },
      );
      if (!activation) return false;
      const alreadyRunning = activation.lifecycle === 'RUNNING'
        && activation.leaseOwner === input.leaseOwner
        && activation.operationStartedAt !== null;
      if (
        !alreadyRunning
        && (activation.lifecycle !== 'LEASED' || activation.leaseOwner !== input.leaseOwner)
      ) {
        return false;
      }

      const job = await jobs.findOne(currentJobFilter(activation), { session });
      if (!job || job.activationFence !== activation.activationFence) return false;
      const batch = await loadFrozenBatchPlan(db, job, activation, session);
      if (!batch || !activationMatchesBatch(activation, job, batch)) return false;

      if (alreadyRunning) {
        const replay = await activations.findOneAndUpdate(
          {
            _id: activation._id,
            kind: 'RESULT_DRAIN',
            lifecycle: 'RUNNING',
            activeSlot: true,
            leaseOwner: input.leaseOwner,
            activationFence: input.activationFence,
            $expr: {
              $and: [
                { $gt: ['$leaseExpiresAt', '$$NOW'] },
                { $gt: ['$workDeadlineAt', '$$NOW'] },
                { $gt: ['$hardDeadlineAt', '$$NOW'] },
              ],
            },
          } as unknown as Filter<LaneActivationDoc>,
          [{ $set: { updatedAt: '$$NOW' } }],
          { session, returnDocument: 'after' },
        );
        return replay !== null;
      }

      const started = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'RESULT_DRAIN',
          lifecycle: 'LEASED',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$workDeadlineAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<LaneActivationDoc>,
        [{
          $set: {
            lifecycle: 'RUNNING',
            operationStartedAt: '$$NOW',
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!started) return false;
      const jobTouch = await jobs.updateOne(
        {
          ...currentJobFilter(activation),
          stateVersion: job.stateVersion,
          pauseGeneration: job.pauseGeneration,
          activationFence: input.activationFence,
        },
        {
          $set: { updatedAt: started.updatedAt },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      if (jobTouch.modifiedCount !== 1) {
        throw new ResultDrainAuthorityLostError('result-drain start job touch lost');
      }
      return true;
    });
    return value;
  } catch (err) {
    if (err instanceof ResultDrainAuthorityLostError) return false;
    throw err;
  }
}

async function replayCommittedResult(
  db: Db,
  activation: LaneActivationDoc,
  session: ClientSession,
): Promise<ResultDrainCommitResult | null> {
  const payload = parseReducerPayload(activation.reducerPayload);
  if (
    !payload
    || activation.lifecycle !== 'COMMITTED'
    || activation.activeSlot
    || activation.committedAt === null
    || activation.committedPayloadHash !== canonicalHash(payload)
    || activation.committedAppliedInboxWatermark === null
    || activation.committedResolvedInboxWatermark === null
  ) {
    return null;
  }
  const rows = await db.collection<JobInboxDoc>(COLLECTIONS.inbox)
    .find(
      { jobId: activation.jobId, _id: { $in: activation.batchInboxItemIds } },
      { session },
    )
    .toArray();
  const byId = new Map(rows.map((row) => [row._id, row]));
  for (const decision of payload.decisions) {
    const row = byId.get(decision.inboxItemId);
    if (!row || row.inboxSequence !== decision.inboxSequence) {
      return null;
    }
    if (decision.kind === 'APPLY_ATTEMPT_RESULT_V1') {
      if (
        row.state !== 'APPLIED'
        || row.appliedByActivationId !== activation._id
        || row.resolvedAt === null
      ) return null;
    } else if (decision.kind === 'REJECT_STALE_INBOX_V1') {
      if (
        row.state !== 'REJECTED_STALE'
        || row.resolvedByActivationId !== activation._id
        || row.resolvedAt === null
      ) return null;
    } else if (decision.kind === 'RETRY_TRANSIENT_INBOX_V1') {
      const scheduledGeneration = decision.retryTimerGeneration + 1;
      const timerId = inboxRetryTimerIdFor(
        decision.inboxItemId,
        scheduledGeneration,
      );
      const [event, timer] = await Promise.all([
        db.collection<JobEventDoc>(COLLECTIONS.events).findOne(
          {
            jobId: activation.jobId,
            type: 'JobInboxRetryScheduled',
            'payload.inboxItemId': decision.inboxItemId,
            'payload.activationId': activation._id,
            'payload.timerId': timerId,
            'payload.retryTimerGeneration': scheduledGeneration,
            'payload.retryAttempt': decision.retryAttempt,
            'payload.redriveAttempt': decision.redriveAttempt,
            'payload.retryReasonCode': decision.retryReasonCode,
          },
          { session },
        ),
        db.collection<TimerDoc>(COLLECTIONS.timers).findOne(
          {
            _id: timerId,
            kind: 'inbox_result_retry',
            jobId: activation.jobId,
            entityId: decision.inboxItemId,
            generation: scheduledGeneration,
            sourceRedriveAttempt: decision.redriveAttempt,
          },
          { session },
        ),
      ]);
      if (
        !event
        || !timer
        || !(timer.fireAt instanceof Date)
        || !(event.payload.nextEligibleAt instanceof Date)
        || timer.fireAt.getTime() !== event.payload.nextEligibleAt.getTime()
        || row.retryTimerGeneration < scheduledGeneration
        || row.retryAttempt < decision.retryAttempt
        || row.redriveAttempt < decision.redriveAttempt
      ) return null;
    } else if (
      decision.kind === 'QUARANTINE_UNSUPPORTED_INBOX_V1'
      || decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
    ) {
      const currentQuarantine =
        row.state === 'QUARANTINED_UNSUPPORTED'
        && row.resolvedByActivationId === activation._id
        && row.operatorAlertId === quarantineAlertIdFor(
          decision.inboxItemId,
          decision.redriveAttempt,
        )
        && (
          decision.kind !== 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
          || (
            row.retryAttempt === decision.retryAttempt
            && row.retryTimerGeneration === decision.retryTimerGeneration
            && row.retryReasonCode === decision.retryReasonCode
          )
        )
        && row.resolvedAt !== null;
      const historicalQuarantine = row.redriveAttempt > decision.redriveAttempt
        && await db.collection<JobEventDoc>(COLLECTIONS.events).findOne(
          {
            jobId: activation.jobId,
            type: 'JobInboxQuarantined',
            'payload.inboxItemId': decision.inboxItemId,
            'payload.activationId': activation._id,
            'payload.redriveAttempt': decision.redriveAttempt,
            'payload.resolutionCode': decision.resolutionCode,
            ...(decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
              ? {
                  'payload.retryAttempt': decision.retryAttempt,
                  'payload.retryTimerGeneration':
                    decision.retryTimerGeneration,
                  'payload.retryReasonCode': decision.retryReasonCode,
                }
              : {}),
          },
          { session, projection: { _id: 1 } },
        ) !== null
        && await db.collection<OutboxDoc>(COLLECTIONS.outbox).findOne(
          {
            _id: quarantineAlertIdFor(
              decision.inboxItemId,
              decision.redriveAttempt,
            ),
            aggregate: activation.jobId,
            type: 'OperatorAlertRequested',
          },
          { session, projection: { _id: 1 } },
        ) !== null;
      if (!currentQuarantine && !historicalQuarantine) return null;
    } else {
      return null;
    }
  }
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs)
    .findOne({ _id: activation.jobId }, { session });
  if (
    !job
    || job.appliedInboxWatermark < activation.committedAppliedInboxWatermark
    || job.resolvedInboxWatermark < activation.committedResolvedInboxWatermark
  ) return null;
  const applied = payload.decisions.find(
    (decision): decision is ApplyAttemptResultDecisionV1 =>
      decision.kind === 'APPLY_ATTEMPT_RESULT_V1',
  ) ?? null;
  const terminalOutcome =
    activation.outcome === 'COMPLETED'
    || activation.outcome === 'PARTIAL'
    || activation.outcome === 'FAILED'
      ? activation.outcome
      : null;
  return {
    activationId: activation._id,
    jobId: activation.jobId,
    taskId: applied?.taskId ?? null,
    attemptId: applied?.attemptId ?? null,
    resultId: applied?.resultId ?? null,
    inboxItemId: applied?.inboxItemId ?? null,
    batchInboxItemIds: [...activation.batchInboxItemIds],
    appliedInboxWatermark: activation.committedAppliedInboxWatermark,
    resolvedInboxWatermark: activation.committedResolvedInboxWatermark,
    successorWakeId: activation.successorWakeId,
    outcome: terminalOutcome,
    deduped: true,
  };
}

async function contiguousResolvedWatermark(
  db: Db,
  job: JobDoc,
  session: ClientSession,
): Promise<number> {
  const firstUnresolved = await db.collection<JobInboxDoc>(COLLECTIONS.inbox)
    .findOne(
      {
        jobId: job._id,
        inboxSequence: {
          $gt: job.resolvedInboxWatermark,
          $lte: job.inboxHighWatermark,
        },
        $nor: [
          {
            state: 'APPLIED',
            appliedByActivationId: { $type: 'string' },
            resolvedByActivationId: { $type: 'string' },
            resolvedAt: { $ne: null },
            resolutionCode: 'applied_result',
          },
          {
            state: 'REJECTED_STALE',
            resolvedByActivationId: { $type: 'string' },
            resolvedAt: { $ne: null },
            resolutionCode: { $in: ['stale_plan', 'stale_task_result'] },
          },
          {
            state: 'QUARANTINED_UNSUPPORTED',
            resolvedByActivationId: { $type: 'string' },
            operatorAlertId: { $type: 'string' },
            resolvedAt: { $ne: null },
            resolutionCode: {
              $in: [
                'unsupported_inbox_kind',
                'unsupported_consumer_version',
                'transient_retry_exhausted',
              ],
            },
          },
        ],
      },
      { session, sort: { inboxSequence: 1 }, projection: { inboxSequence: 1 } },
    );
  return firstUnresolved
    ? firstUnresolved.inboxSequence - 1
    : job.inboxHighWatermark;
}

function transitionForTerminalTask(
  task: TaskDoc,
): { taskPhase: TaskPhase; terminalOutcome: JobTerminalOutcome } | null {
  if (task.phase === 'SUCCEEDED') {
    return { taskPhase: task.phase, terminalOutcome: 'COMPLETED' };
  }
  if (task.phase === 'PARTIAL') {
    return { taskPhase: task.phase, terminalOutcome: 'PARTIAL' };
  }
  if (task.phase === 'FAILED') {
    return { taskPhase: task.phase, terminalOutcome: 'FAILED' };
  }
  return null;
}

function successorWakeIdFor(activationId: string): string {
  return `obx_result_drain_handoff:${activationId}`;
}

function quarantineAlertIdFor(
  inboxItemId: string,
  redriveAttempt: number,
): string {
  return `obx_inbox_quarantine:${inboxItemId}:${redriveAttempt}`;
}

function redriveWakeIdFor(
  inboxItemId: string,
  redriveAttempt: number,
): string {
  return `obx_inbox_redrive:${inboxItemId}:${redriveAttempt}`;
}

function inboxRetryTimerIdFor(
  inboxItemId: string,
  generation: number,
): string {
  return `tmr_inbox_result_retry:${inboxItemId}:${generation}`;
}

function currentBinarySupportsInboxItem(item: JobInboxDoc): boolean {
  return item.kind === 'ATTEMPT_RESULT_V1' && item.consumerVersion === 1;
}

function parseHistoricalRedrive(
  event: JobEventDoc | null,
): InboxRedriveResult | null {
  if (!event) return null;
  const payload = event.payload;
  if (
    !isNonEmptyString(payload.inboxItemId)
    || !isNonNegativeInteger(payload.redriveAttempt)
    || !isNonEmptyString(payload.wakeId)
  ) return null;
  return {
    jobId: event.jobId,
    inboxItemId: payload.inboxItemId,
    redriveAttempt: payload.redriveAttempt,
    wakeId: payload.wakeId,
    deduped: true,
  };
}

/**
 * Operator/upgrade boundary for one durable poison record.
 *
 * The envelope identity, kind, consumerVersion, sequence and payload hash stay
 * immutable. A caller may promote the quarantine only after this binary
 * actually recognises that exact kind/version. The transaction increments the
 * redrive epoch, preserves monotonic watermarks, records an audit event and
 * creates/adopts exactly one current-generation wake. Replaying the same
 * request id reads the committed event even after the item later applies,
 * re-quarantines or the job terminalizes.
 */
export async function requestInboxRedrive(
  client: MongoClient,
  db: Db,
  input: InboxRedriveInput,
): Promise<InboxRedriveResult | null> {
  if (
    !isNonEmptyString(input.resourceId)
    || !isNonEmptyString(input.jobId)
    || !isNonEmptyString(input.inboxItemId)
    || !isNonEmptyString(input.redriveRequestId)
    || !isNonNegativeInteger(input.expectedConsumerVersion)
  ) {
    throw new Error('invalid inbox redrive input');
  }

  try {
    const { value } = await runTxn(client, async (session) => {
      const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
      const inboxItems = db.collection<JobInboxDoc>(COLLECTIONS.inbox);
      const events = db.collection<JobEventDoc>(COLLECTIONS.events);
      const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
      const job = await jobs.findOne(
        { _id: input.jobId, resourceId: input.resourceId },
        { session },
      );
      if (!job) return null;
      if (job.controlState === 'STOP_REQUESTED') return null;

      const historical = parseHistoricalRedrive(await events.findOne(
        {
          jobId: job._id,
          type: 'JobInboxRedriveRequested',
          'payload.inboxItemId': input.inboxItemId,
          'payload.redriveRequestId': input.redriveRequestId,
        },
        { session },
      ));
      if (historical) return historical;
      if (job.terminalOutcome !== null) return null;

      const item = await inboxItems.findOne(
        { _id: input.inboxItemId, jobId: job._id },
        { session },
      );
      if (!item) return null;
      if (item.consumerVersion !== input.expectedConsumerVersion) {
        throw new InboxRedriveConflictError(
          item._id,
          'consumer_version_changed',
        );
      }
      if (!currentBinarySupportsInboxItem(item)) {
        throw new InboxRedriveUnavailableError(item._id);
      }
      const quarantined =
        item.state === 'QUARANTINED_UNSUPPORTED'
        && item.resolvedAt !== null
        && isNonEmptyString(item.resolvedByActivationId)
        && isNonEmptyString(item.operatorAlertId)
        && (
          item.resolutionCode === 'unsupported_inbox_kind'
          || item.resolutionCode === 'unsupported_consumer_version'
          || item.resolutionCode === 'transient_retry_exhausted'
        );
      const failedRetryable =
        item.state === 'FAILED_RETRYABLE'
        && item.resolvedAt === null
        && item.resolvedByActivationId === null
        && item.operatorAlertId === null
        && isNonEmptyString(item.retryTimerId)
        && item.nextEligibleAt instanceof Date
        && isInboxRetryReasonCode(item.retryReasonCode)
        && isNonNegativeInteger(item.retryTimerGeneration)
        && item.retryTimerGeneration > 0;
      if (
        (!quarantined && !failedRetryable)
        || !isNonNegativeInteger(item.redriveAttempt)
        || !isNonNegativeInteger(item.retryAttempt)
        || !Number.isInteger(item.inboxSequence)
        || item.inboxSequence <= 0
        || item.inboxSequence > job.inboxHighWatermark
      ) {
        throw new InboxRedriveConflictError(item._id, 'not_quarantined');
      }
      if (job.activeActivationId !== null) {
        throw new InboxRedriveConflictError(item._id, 'active_activation');
      }

      const redriveAttempt = item.redriveAttempt + 1;
      const pendingItem: JobInboxDoc = {
        ...item,
        state: 'PENDING_REDRIVE',
        redriveAttempt,
        operatorAlertId: null,
        resolvedByActivationId: null,
        resolutionCode: null,
        retryTimerId: null,
        nextEligibleAt: null,
        retryReasonCode: null,
        resolvedAt: null,
      };
      const rootTask = await loadRootResultTask(db, job, session);
      const rejected = rootTask
        ? rejectDecisionForItem(job, rootTask, pendingItem)
        : null;
      const inspection = rootTask && !rejected
        ? await inspectResultReadinessForItem(
            db,
            job,
            rootTask,
            session,
            pendingItem,
          )
        : null;
      // A quarantine redrive is an operator assertion that the underlying
      // envelope has been repaired/upgraded, so require an immediately final
      // APPLY/STALE disposition. A FAILED_RETRYABLE redrive may intentionally
      // force an early probe; B will either apply or schedule the next bounded
      // timer without a hot loop.
      if (
        !rootTask
        || (
          quarantined
          && !rejected
          && inspection?.kind !== 'ELIGIBLE'
        )
        || (
          failedRetryable
          && !rejected
          && inspection?.kind !== 'ELIGIBLE'
          && inspection?.kind !== 'TRANSIENT'
        )
      ) {
        throw new InboxRedriveUnavailableError(item._id);
      }
      const deterministicWakeId = redriveWakeIdFor(
        item._id,
        redriveAttempt,
      );
      const pendingWake = await outbox.findOne(
        {
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          'payload.activationDispatchGeneration':
            job.activationDispatchGeneration,
        },
        { session, sort: { createdAt: 1, _id: 1 } },
      );
      const wakeId = pendingWake?._id ?? deterministicWakeId;
      const now = new Date();

      if (failedRetryable) {
        const timerCas = await db.collection<TimerDoc>(COLLECTIONS.timers).updateOne(
          {
            _id: item.retryTimerId!,
            kind: 'inbox_result_retry',
            jobId: job._id,
            entityId: item._id,
            generation: item.retryTimerGeneration,
            sourceRedriveAttempt: item.redriveAttempt,
            fireAt: item.nextEligibleAt!,
            state: 'PENDING',
          },
          { $set: { state: 'CANCELLED' } },
          { session },
        );
        if (timerCas.modifiedCount !== 1) {
          throw new ResultDrainAuthorityLostError('inbox redrive timer CAS lost');
        }
      }

      const itemCas = await inboxItems.updateOne(
        {
          _id: item._id,
          jobId: job._id,
          state: item.state,
          kind: item.kind,
          consumerVersion: input.expectedConsumerVersion,
          inboxSequence: item.inboxSequence,
          planVersion: item.planVersion,
          attemptFence: item.attemptFence,
          payloadHash: item.payloadHash,
          redriveAttempt: item.redriveAttempt,
          lastRedriveRequestId: item.lastRedriveRequestId,
          operatorAlertId: item.operatorAlertId,
          retryTimerGeneration: item.retryTimerGeneration,
          retryAttempt: item.retryAttempt,
          retryTimerId: item.retryTimerId,
          nextEligibleAt: item.nextEligibleAt,
          retryReasonCode: item.retryReasonCode,
          resolvedByActivationId: item.resolvedByActivationId,
          resolutionCode: item.resolutionCode,
          resolvedAt: item.resolvedAt,
          appliedByActivationId: null,
        },
        {
          $set: {
            state: 'PENDING_REDRIVE',
            redriveAttempt,
            lastRedriveRequestId: input.redriveRequestId,
            operatorAlertId: null,
            resolvedByActivationId: null,
            resolutionCode: null,
            retryTimerId: null,
            nextEligibleAt: null,
            retryReasonCode: null,
            resolvedAt: null,
          },
        },
        { session },
      );
      if (itemCas.modifiedCount !== 1) {
        throw new ResultDrainAuthorityLostError('inbox redrive item CAS lost');
      }

      const jobCas = await jobs.updateOne(
        {
          _id: job._id,
          resourceId: input.resourceId,
          stateVersion: job.stateVersion,
          terminalOutcome: null,
          controlState: { $ne: 'STOP_REQUESTED' },
          phase: { $in: ['AWAITING_RESULTS', 'RECONCILING'] },
          activeActivationId: null,
          activationDispatchGeneration: job.activationDispatchGeneration,
          jobStopGeneration: job.jobStopGeneration,
        },
        {
          $set: {
            phase: 'RECONCILING',
            updatedAt: now,
          },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      if (jobCas.modifiedCount !== 1) {
        throw new ResultDrainAuthorityLostError('inbox redrive job CAS lost');
      }

      const wakePayload = {
        jobId: job._id,
        reason: 'inbox_redrive',
        inboxItemId: item._id,
        inboxSequence: item.inboxSequence,
        redriveAttempt,
        redriveRequestId: input.redriveRequestId,
        activationDispatchGeneration: job.activationDispatchGeneration,
      };
      if (pendingWake) {
        const adopted = await outbox.updateOne(
          {
            _id: pendingWake._id,
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            'payload.activationDispatchGeneration':
              job.activationDispatchGeneration,
          },
          { $set: { payload: wakePayload } },
          { session },
        );
        if (adopted.modifiedCount !== 1) {
          throw new ResultDrainAuthorityLostError('inbox redrive wake adoption lost');
        }
        await outbox.updateMany(
          {
            _id: { $ne: pendingWake._id },
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            'payload.activationDispatchGeneration':
              job.activationDispatchGeneration,
          },
          { $set: { state: 'PUBLISHED' } },
          { session },
        );
      } else {
        await outbox.insertOne({
          _id: deterministicWakeId,
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          payload: wakePayload,
          createdAt: now,
        }, { session });
      }

      const sequence = await nextEventSeq(db, job._id, session);
      await events.insertOne({
        _id: `${job._id}:${sequence}`,
        jobId: job._id,
        sequence,
        type: 'JobInboxRedriveRequested',
        payload: {
          resourceId: input.resourceId,
          inboxItemId: item._id,
          inboxSequence: item.inboxSequence,
          redriveRequestId: input.redriveRequestId,
          consumerVersion: item.consumerVersion,
          sourceState: item.state,
          cancelledRetryTimerId: failedRetryable ? item.retryTimerId : null,
          retryAttempt: item.retryAttempt,
          retryTimerGeneration: item.retryTimerGeneration,
          redriveAttempt,
          wakeId,
        },
        createdAt: now,
      }, { session });

      return {
        jobId: job._id,
        inboxItemId: item._id,
        redriveAttempt,
        wakeId,
        deduped: false,
      } satisfies InboxRedriveResult;
    });
    return value;
  } catch (err) {
    if (err instanceof ResultDrainAuthorityLostError) return null;
    throw err;
  }
}

async function fireOneInboxResultRetryTimer(
  client: MongoClient,
  db: Db,
  timerId: string,
): Promise<number> {
  try {
    const { value } = await runTxn(client, async (session) => {
      const timers = db.collection<TimerDoc>(COLLECTIONS.timers);
      const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
      const inboxItems = db.collection<JobInboxDoc>(COLLECTIONS.inbox);
      const outbox = db.collection<OutboxDoc>(COLLECTIONS.outbox);
      const timer = await timers.findOne(
        {
          _id: timerId,
          kind: 'inbox_result_retry',
          state: 'PENDING',
          $expr: { $lte: ['$fireAt', '$$NOW'] },
        } as unknown as Filter<TimerDoc>,
        { session },
      );
      if (!timer) return 0;

      const [job, item] = await Promise.all([
        jobs.findOne({ _id: timer.jobId }, { session }),
        inboxItems.findOne(
          { _id: timer.entityId, jobId: timer.jobId },
          { session },
        ),
      ]);
      const terminalOrStale =
        !job
        || job.terminalOutcome !== null
        || !item
        || item.state !== 'FAILED_RETRYABLE'
        || item.retryTimerId !== timer._id
        || item.retryTimerGeneration !== timer.generation
        || !isNonNegativeInteger(item.retryTimerGeneration)
        || item.retryTimerGeneration <= 0
        || !isNonNegativeInteger(item.retryAttempt)
        || item.retryAttempt >= MAX_AUTO_REDRIVE_ATTEMPTS
        || !isNonNegativeInteger(item.redriveAttempt)
        || item.redriveAttempt !== timer.sourceRedriveAttempt
        || !(item.nextEligibleAt instanceof Date)
        || item.nextEligibleAt.getTime() !== timer.fireAt.getTime()
        || !isInboxRetryReasonCode(item.retryReasonCode);
      if (terminalOrStale) {
        await timers.updateOne(
          {
            _id: timer._id,
            kind: 'inbox_result_retry',
            state: 'PENDING',
            generation: timer.generation,
            sourceRedriveAttempt: timer.sourceRedriveAttempt,
          },
          { $set: { state: 'CANCELLED' } },
          { session },
        );
        return 0;
      }
      if (
        job.activeActivationId !== null
        || (
          job.phase !== 'AWAITING_RESULTS'
          && job.phase !== 'RECONCILING'
        )
        || (
          job.controlState !== 'NONE'
          && job.controlState !== 'PAUSE_REQUESTED'
        )
        || (
          job.controlState === 'PAUSE_REQUESTED'
          && item.finishCurrentPauseGenerationAtA !== job.pauseGeneration
        )
      ) {
        // A due timer is durable demand, not permission to race a live
        // activation or bypass pause. Leave it PENDING for a later tick.
        return 0;
      }

      const redriveAttempt = item.redriveAttempt + 1;
      const retryAttempt = item.retryAttempt + 1;
      const deterministicWakeId = redriveWakeIdFor(item._id, redriveAttempt);
      const pendingWake = await outbox.findOne(
        {
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          'payload.activationDispatchGeneration':
            job.activationDispatchGeneration,
        },
        { session, sort: { createdAt: 1, _id: 1 } },
      );
      const wakeId = pendingWake?._id ?? deterministicWakeId;
      const fired = await timers.findOneAndUpdate(
        {
          _id: timer._id,
          kind: 'inbox_result_retry',
          jobId: job._id,
          entityId: item._id,
          generation: item.retryTimerGeneration,
          sourceRedriveAttempt: item.redriveAttempt,
          fireAt: item.nextEligibleAt,
          state: 'PENDING',
          $expr: { $lte: ['$fireAt', '$$NOW'] },
        } as unknown as Filter<TimerDoc>,
        [{
          $set: {
            state: 'FIRED',
            firedAt: '$$NOW',
            wakeId,
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!fired?.firedAt) {
        throw new ResultDrainAuthorityLostError(
          'inbox retry timer claim CAS lost',
        );
      }

      const itemCas = await inboxItems.updateOne(
        {
          _id: item._id,
          jobId: job._id,
          state: 'FAILED_RETRYABLE',
          kind: item.kind,
          consumerVersion: item.consumerVersion,
          inboxSequence: item.inboxSequence,
          planVersion: item.planVersion,
          attemptFence: item.attemptFence,
          payloadHash: item.payloadHash,
          redriveAttempt: item.redriveAttempt,
          retryAttempt: item.retryAttempt,
          retryTimerGeneration: item.retryTimerGeneration,
          retryTimerId: timer._id,
          nextEligibleAt: timer.fireAt,
          retryReasonCode: item.retryReasonCode,
          appliedByActivationId: null,
          resolvedByActivationId: null,
          resolvedAt: null,
        },
        {
          $set: {
            state: 'PENDING_REDRIVE',
            redriveAttempt,
            retryAttempt,
            lastRedriveRequestId: timer._id,
            retryTimerId: null,
            nextEligibleAt: null,
            retryReasonCode: null,
            operatorAlertId: null,
            resolutionCode: null,
          },
        },
        { session },
      );
      if (itemCas.modifiedCount !== 1) {
        throw new ResultDrainAuthorityLostError(
          'inbox retry promotion item CAS lost',
        );
      }

      const jobCas = await jobs.updateOne(
        {
          _id: job._id,
          stateVersion: job.stateVersion,
          terminalOutcome: null,
          phase: job.phase,
          controlState: job.controlState,
          pauseGeneration: job.pauseGeneration,
          activeActivationId: null,
          activationDispatchGeneration: job.activationDispatchGeneration,
          jobStopGeneration: job.jobStopGeneration,
        },
        {
          $set: {
            phase: 'RECONCILING',
            updatedAt: fired.firedAt,
          },
          $inc: { stateVersion: 1 },
        },
        { session },
      );
      if (jobCas.modifiedCount !== 1) {
        throw new ResultDrainAuthorityLostError(
          'inbox retry promotion job CAS lost',
        );
      }

      const wakePayload = {
        jobId: job._id,
        reason: 'inbox_retry_timer',
        inboxItemId: item._id,
        inboxSequence: item.inboxSequence,
        retryTimerId: timer._id,
        retryTimerGeneration: timer.generation,
        retryAttempt,
        redriveAttempt,
        activationDispatchGeneration: job.activationDispatchGeneration,
      };
      if (pendingWake) {
        const adopted = await outbox.updateOne(
          {
            _id: pendingWake._id,
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            'payload.activationDispatchGeneration':
              job.activationDispatchGeneration,
          },
          { $set: { payload: wakePayload } },
          { session },
        );
        if (adopted.modifiedCount !== 1) {
          throw new ResultDrainAuthorityLostError(
            'inbox retry wake adoption CAS lost',
          );
        }
        await outbox.updateMany(
          {
            _id: { $ne: pendingWake._id },
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            'payload.activationDispatchGeneration':
              job.activationDispatchGeneration,
          },
          { $set: { state: 'PUBLISHED' } },
          { session },
        );
      } else {
        await outbox.insertOne({
          _id: deterministicWakeId,
          aggregate: job._id,
          type: 'LaneWakeRequested',
          state: 'PENDING',
          payload: wakePayload,
          createdAt: fired.firedAt,
        }, { session });
      }

      const sequence = await nextEventSeq(db, job._id, session);
      await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
        _id: `${job._id}:${sequence}`,
        jobId: job._id,
        sequence,
        type: 'JobInboxRetryPromoted',
        payload: {
          inboxItemId: item._id,
          inboxSequence: item.inboxSequence,
          retryTimerId: timer._id,
          retryTimerGeneration: timer.generation,
          retryReasonCode: item.retryReasonCode,
          retryAttempt,
          redriveAttempt,
          wakeId,
        },
        createdAt: fired.firedAt,
      }, { session });
      return 1;
    });
    return value;
  } catch (err) {
    if (err instanceof ResultDrainAuthorityLostError) return 0;
    throw err;
  }
}

/**
 * Typed due reducer for inbox retry timers. Each candidate is processed in its
 * own transaction. The aggregate prefilter skips active/non-finish-current jobs
 * before applying a per-tick cap, so an ineligible oldest prefix cannot starve
 * later eligible timers.
 */
export async function fireDueInboxResultRetryTimers(
  client: MongoClient,
  db: Db,
): Promise<number> {
  const timers = db.collection<TimerDoc>(COLLECTIONS.timers);
  let promoted = 0;
  const candidates = await timers.aggregate<{ _id: string }>([
    {
      $match: {
        kind: 'inbox_result_retry',
        state: 'PENDING',
        $expr: { $lte: ['$fireAt', '$$NOW'] },
      },
    },
    {
      $lookup: {
        from: COLLECTIONS.jobs,
        localField: 'jobId',
        foreignField: '_id',
        as: 'retryJob',
      },
    },
    {
      $lookup: {
        from: COLLECTIONS.inbox,
        localField: 'entityId',
        foreignField: '_id',
        as: 'retryItem',
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            { $eq: [{ $size: '$retryJob' }, 0] },
            { $eq: [{ $size: '$retryItem' }, 0] },
            {
              $ne: [
                { $arrayElemAt: ['$retryJob.terminalOutcome', 0] },
                null,
              ],
            },
            {
              $and: [
                { $eq: [{ $size: '$retryJob' }, 1] },
                { $eq: [{ $size: '$retryItem' }, 1] },
                {
                  $eq: [
                    { $arrayElemAt: ['$retryJob.terminalOutcome', 0] },
                    null,
                  ],
                },
                {
                  $eq: [
                    { $arrayElemAt: ['$retryJob.activeActivationId', 0] },
                    null,
                  ],
                },
                {
                  $in: [
                    { $arrayElemAt: ['$retryJob.phase', 0] },
                    ['AWAITING_RESULTS', 'RECONCILING'],
                  ],
                },
                {
                  $or: [
                    {
                      $eq: [
                        { $arrayElemAt: ['$retryJob.controlState', 0] },
                        'NONE',
                      ],
                    },
                    {
                      $and: [
                        {
                          $eq: [
                            { $arrayElemAt: ['$retryJob.controlState', 0] },
                            'PAUSE_REQUESTED',
                          ],
                        },
                        {
                          $eq: [
                            {
                              $arrayElemAt: [
                                '$retryItem.finishCurrentPauseGenerationAtA',
                                0,
                              ],
                            },
                            {
                              $arrayElemAt: [
                                '$retryJob.pauseGeneration',
                                0,
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    { $sort: { fireAt: 1, _id: 1 } },
    { $limit: MAX_TYPED_TIMER_TRANSITIONS_PER_TICK },
    { $project: { _id: 1 } },
  ]).toArray();
  for (const candidate of candidates) {
    promoted += await fireOneInboxResultRetryTimer(
      client,
      db,
      candidate._id,
    );
  }
  return promoted;
}

/**
 * Apply bounded B atomically: resolve the immutable batch, move diagnostic and
 * contiguous watermarks, settle the activation/slot, and either terminalize or
 * persist one deterministic successor wake for an eligible tail.
 */
export async function commitResultDrainActivation(
  client: MongoClient,
  db: Db,
  input: {
    activationId: string;
    leaseOwner: string;
    activationFence: number;
    /**
     * F5B: hand the TERMINAL call to a FINAL_DECISION activation instead of
     * finishing here. Off by default — the drain terminalizes exactly as before.
     */
    deferTerminalDecision?: boolean;
  },
): Promise<ResultDrainCommitResult | null> {
  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const tasks = db.collection<TaskDoc>(COLLECTIONS.tasks);
  const inboxItems = db.collection<JobInboxDoc>(COLLECTIONS.inbox);

  try {
    const { value } = await runTxn(client, async (session) => {
      const activation = await activations.findOne(
        {
          _id: input.activationId,
          kind: 'RESULT_DRAIN',
          activationFence: input.activationFence,
        },
        { session },
      );
      if (!activation) return null;
      if (activation.lifecycle === 'COMMITTED') {
        return replayCommittedResult(db, activation, session);
      }
      if (
        activation.lifecycle !== 'RUNNING'
        || activation.leaseOwner !== input.leaseOwner
        || !activation.activeSlot
      ) {
        return null;
      }

      const job = await jobs.findOne(currentJobFilter(activation), { session });
      if (!job || job.activationFence !== activation.activationFence) return null;
      const batch = await loadFrozenBatchPlan(db, job, activation, session);
      if (!batch || !activationMatchesBatch(activation, job, batch)) return null;
      const payload = parseReducerPayload(activation.reducerPayload);
      if (!payload) return null;
      const payloadHash = canonicalHash(payload);
      const applyDecision = payload.decisions.find(
        (decision): decision is ApplyAttemptResultDecisionV1 =>
          decision.kind === 'APPLY_ATTEMPT_RESULT_V1',
      ) ?? null;
      const applySlice = batch.applySlice;
      if ((applyDecision === null) !== (applySlice === null)) return null;
      const applyTransition = applySlice ? RESULT_TRANSITIONS[applySlice.status] : null;

      const committed = await activations.findOneAndUpdate(
        {
          _id: activation._id,
          kind: 'RESULT_DRAIN',
          lifecycle: 'RUNNING',
          activeSlot: true,
          leaseOwner: input.leaseOwner,
          activationFence: input.activationFence,
          batchInboxItemIds: activation.batchInboxItemIds,
          purposeAttemptIds: activation.purposeAttemptIds,
          batchThroughWatermark: activation.batchThroughWatermark,
          $expr: {
            $and: [
              { $gt: ['$leaseExpiresAt', '$$NOW'] },
              { $gt: ['$workDeadlineAt', '$$NOW'] },
              { $gt: ['$hardDeadlineAt', '$$NOW'] },
            ],
          },
        } as unknown as Filter<LaneActivationDoc>,
        [{
          $set: {
            lifecycle: 'COMMITTED',
            activeSlot: false,
            leaseOwner: null,
            leaseExpiresAt: null,
            committedPayloadHash: payloadHash,
            committedAt: '$$NOW',
            outcome: 'BATCH_DRAINED',
            updatedAt: '$$NOW',
          },
        }],
        { session, returnDocument: 'after' },
      );
      if (!committed?.committedAt) return null;
      const committedAt = committed.committedAt;

      for (const decision of payload.decisions) {
        let itemCas;
        if (decision.kind === 'APPLY_ATTEMPT_RESULT_V1') {
          itemCas = await inboxItems.updateOne(
              {
                _id: decision.inboxItemId,
                jobId: job._id,
                taskId: decision.taskId,
                attemptId: decision.attemptId,
                resultId: decision.resultId,
                inboxSequence: decision.inboxSequence,
                kind: 'ATTEMPT_RESULT_V1',
                consumerVersion: 1,
                state: decision.sourceState ?? 'RECEIVED',
                redriveAttempt: decision.redriveAttempt ?? 0,
                planVersion: decision.planVersion,
                attemptFence: decision.attemptFence,
                payloadHash: decision.payloadHash,
                retryAttempt: decision.retryAttempt ?? 0,
                retryTimerGeneration: decision.retryTimerGeneration ?? 0,
                retryTimerId: null,
                nextEligibleAt: null,
                appliedByActivationId: null,
                resolvedByActivationId: null,
                resolvedAt: null,
              },
              {
                $set: {
                  state: 'APPLIED',
                  appliedByActivationId: activation._id,
                  resolvedByActivationId: activation._id,
                  resolutionCode: 'applied_result',
                  operatorAlertId: null,
                  retryTimerId: null,
                  nextEligibleAt: null,
                  retryReasonCode: null,
                  resolvedAt: committedAt,
                },
              },
              { session },
            );
        } else if (decision.kind === 'REJECT_STALE_INBOX_V1') {
          itemCas = await inboxItems.updateOne(
              {
                _id: decision.inboxItemId,
                jobId: job._id,
                taskId: decision.taskId,
                attemptId: decision.attemptId,
                resultId: decision.resultId,
                inboxSequence: decision.inboxSequence,
                kind: 'ATTEMPT_RESULT_V1',
                consumerVersion: decision.consumerVersion,
                state: decision.sourceState ?? 'RECEIVED',
                redriveAttempt: decision.redriveAttempt ?? 0,
                planVersion: decision.planVersion,
                attemptFence: decision.attemptFence,
                payloadHash: decision.payloadHash,
                retryAttempt: decision.retryAttempt ?? 0,
                retryTimerGeneration: decision.retryTimerGeneration ?? 0,
                retryTimerId: null,
                nextEligibleAt: null,
                appliedByActivationId: null,
                resolvedByActivationId: null,
                resolvedAt: null,
              },
              {
                $set: {
                  state: 'REJECTED_STALE',
                  resolvedByActivationId: activation._id,
                  resolutionCode: decision.resolutionCode,
                  operatorAlertId: null,
                  retryTimerId: null,
                  nextEligibleAt: null,
                  retryReasonCode: null,
                  resolvedAt: committedAt,
                },
              },
              { session },
            );
        } else if (decision.kind === 'RETRY_TRANSIENT_INBOX_V1') {
          const retryTimerGeneration = decision.retryTimerGeneration + 1;
          const retryTimerId = inboxRetryTimerIdFor(
            decision.inboxItemId,
            retryTimerGeneration,
          );
          const nextEligibleAt = new Date(
            committedAt.getTime() + decision.retryDelayMs,
          );
          itemCas = await inboxItems.updateOne(
            {
              _id: decision.inboxItemId,
              jobId: job._id,
              taskId: decision.taskId,
              attemptId: decision.attemptId,
              resultId: decision.resultId,
              inboxSequence: decision.inboxSequence,
              kind: decision.inboxKind,
              consumerVersion: decision.consumerVersion,
              redriveAttempt: decision.redriveAttempt,
              retryAttempt: decision.retryAttempt,
              retryTimerGeneration: decision.retryTimerGeneration,
              retryTimerId: null,
              nextEligibleAt: null,
              state: decision.sourceState,
              planVersion: decision.planVersion,
              attemptFence: decision.attemptFence,
              payloadHash: decision.payloadHash,
              appliedByActivationId: null,
              resolvedByActivationId: null,
              resolvedAt: null,
            },
            {
              $set: {
                state: 'FAILED_RETRYABLE',
                retryTimerGeneration,
                retryTimerId,
                nextEligibleAt,
                retryReasonCode: decision.retryReasonCode,
                operatorAlertId: null,
                resolutionCode: null,
              },
            },
            { session },
          );
          await db.collection<TimerDoc>(COLLECTIONS.timers).insertOne({
            _id: retryTimerId,
            kind: 'inbox_result_retry',
            jobId: job._id,
            entityId: decision.inboxItemId,
            generation: retryTimerGeneration,
            sourceRedriveAttempt: decision.redriveAttempt,
            fireAt: nextEligibleAt,
            state: 'PENDING',
            firedAt: null,
            wakeId: null,
            createdAt: committedAt,
          }, { session });
          const sequence = await nextEventSeq(db, job._id, session);
          await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
            _id: `${job._id}:${sequence}`,
            jobId: job._id,
            sequence,
            type: 'JobInboxRetryScheduled',
            payload: {
              inboxItemId: decision.inboxItemId,
              inboxSequence: decision.inboxSequence,
              taskId: decision.taskId,
              attemptId: decision.attemptId,
              resultId: decision.resultId,
              retryTimerId,
              timerId: retryTimerId,
              retryTimerGeneration,
              retryAttempt: decision.retryAttempt,
              redriveAttempt: decision.redriveAttempt,
              retryReasonCode: decision.retryReasonCode,
              retryPolicyVersion: decision.retryPolicyVersion,
              maxAutoRedriveAttempts: decision.maxAutoRedriveAttempts,
              retryDelayMs: decision.retryDelayMs,
              nextEligibleAt,
              activationId: activation._id,
            },
            createdAt: committedAt,
          }, { session });
        } else if (
          decision.kind === 'QUARANTINE_UNSUPPORTED_INBOX_V1'
          || decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
        ) {
          const operatorAlertId = quarantineAlertIdFor(
            decision.inboxItemId,
            decision.redriveAttempt,
          );
          itemCas = await inboxItems.updateOne(
            {
              _id: decision.inboxItemId,
              jobId: job._id,
              taskId: decision.taskId,
              attemptId: decision.attemptId,
              resultId: decision.resultId,
              inboxSequence: decision.inboxSequence,
              kind: decision.inboxKind,
              consumerVersion: decision.consumerVersion,
              redriveAttempt: decision.redriveAttempt,
              ...(decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
                ? {
                    retryAttempt: decision.retryAttempt,
                    retryTimerGeneration: decision.retryTimerGeneration,
                    retryTimerId: null,
                    nextEligibleAt: null,
                  }
                : {}),
              state: decision.sourceState,
              planVersion: decision.planVersion,
              attemptFence: decision.attemptFence,
              payloadHash: decision.payloadHash,
              appliedByActivationId: null,
              resolvedByActivationId: null,
              resolvedAt: null,
            },
            {
              $set: {
                state: 'QUARANTINED_UNSUPPORTED',
                resolvedByActivationId: activation._id,
                resolutionCode: decision.resolutionCode,
                operatorAlertId,
                retryTimerId: null,
                nextEligibleAt: null,
                retryReasonCode:
                  decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
                    ? decision.retryReasonCode
                    : null,
                resolvedAt: committedAt,
              },
            },
            { session },
          );
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
            _id: operatorAlertId,
            aggregate: job._id,
            type: 'OperatorAlertRequested',
            state: 'PENDING',
            payload: {
              alertType:
                decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
                  ? 'inbox_transient_retry_exhausted'
                  : 'inbox_quarantined_unsupported',
              resourceId: job.resourceId,
              conversationId: job.conversationId,
              jobId: job._id,
              inboxItemId: decision.inboxItemId,
              inboxSequence: decision.inboxSequence,
              taskId: decision.taskId,
              attemptId: decision.attemptId,
              resultId: decision.resultId,
              inboxKind: decision.inboxKind,
              consumerVersion: decision.consumerVersion,
              payloadHash: decision.payloadHash,
              redriveAttempt: decision.redriveAttempt,
              ...(decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
                ? {
                    retryAttempt: decision.retryAttempt,
                    retryTimerGeneration: decision.retryTimerGeneration,
                    retryReasonCode: decision.retryReasonCode,
                    retryPolicyVersion: decision.retryPolicyVersion,
                    maxAutoRedriveAttempts: decision.maxAutoRedriveAttempts,
                  }
                : {}),
              resolutionCode: decision.resolutionCode,
              activationId: activation._id,
            },
            createdAt: committedAt,
          }, { session });
          const sequence = await nextEventSeq(db, job._id, session);
          await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
            _id: `${job._id}:${sequence}`,
            jobId: job._id,
            sequence,
            type: 'JobInboxQuarantined',
            payload: {
              inboxItemId: decision.inboxItemId,
              inboxSequence: decision.inboxSequence,
              taskId: decision.taskId,
              attemptId: decision.attemptId,
              resultId: decision.resultId,
              inboxKind: decision.inboxKind,
              consumerVersion: decision.consumerVersion,
              redriveAttempt: decision.redriveAttempt,
              ...(decision.kind === 'QUARANTINE_RETRY_EXHAUSTED_INBOX_V1'
                ? {
                    retryAttempt: decision.retryAttempt,
                    retryTimerGeneration: decision.retryTimerGeneration,
                    retryReasonCode: decision.retryReasonCode,
                    retryPolicyVersion: decision.retryPolicyVersion,
                    maxAutoRedriveAttempts: decision.maxAutoRedriveAttempts,
                  }
                : {}),
              resolutionCode: decision.resolutionCode,
              operatorAlertId,
              activationId: activation._id,
            },
            createdAt: committedAt,
          }, { session });
        } else {
          throw new ResultDrainAuthorityLostError(
            'result-drain decision kind became unsupported',
          );
        }
        if (itemCas.modifiedCount !== 1) {
          throw new ResultDrainAuthorityLostError('result-drain inbox item CAS lost');
        }
      }

      if (applySlice && applyTransition) {
        const taskCas = await tasks.updateOne(
          {
            _id: applySlice.task._id,
            jobId: job._id,
            phase: 'AWAITING_RESULT',
            controlState: 'NONE',
            attemptMode: 'SERIAL',
            planVersion: job.planVersion,
            resultApplyMode: 'RESULT_DRAIN_V1',
            activeAttemptId: null,
            pendingResultId: applySlice.result._id,
            appliedResultId: null,
          },
          {
            $set: {
              phase: applyTransition.taskPhase,
              pendingResultId: null,
              appliedResultId: applySlice.result._id,
              updatedAt: committedAt,
            },
          },
          { session },
        );
        if (taskCas.modifiedCount !== 1) {
          throw new ResultDrainAuthorityLostError('result-drain task CAS lost');
        }
      }

      const highestApplied = payload.decisions.reduce(
        (maximum, decision) => decision.kind === 'APPLY_ATTEMPT_RESULT_V1'
          ? Math.max(maximum, decision.inboxSequence)
          : maximum,
        job.appliedInboxWatermark,
      );
      const resolvedWatermark = await contiguousResolvedWatermark(db, job, session);
      const currentTask = await tasks.findOne(
        { _id: batch.task._id, jobId: job._id },
        { session },
      );
      if (!currentTask) {
        throw new ResultDrainAuthorityLostError('result-drain task disappeared');
      }
      const reconciliationBlocker = await inboxItems.findOne(
        {
          jobId: job._id,
          state: {
            $in: [
              'QUARANTINED_UNSUPPORTED',
              'FAILED_RETRYABLE',
              'PENDING_REDRIVE',
            ],
          },
        },
        { session, projection: { _id: 1 } },
      );
      const terminalTransition = transitionForTerminalTask(currentTask);
      const wouldTerminalize =
        resolvedWatermark === job.inboxHighWatermark
        && reconciliationBlocker === null
        && terminalTransition !== null;
      // F5B/FINAL_DECISION: when a lane judge is configured, the drain applies the
      // result but hands the TERMINAL call to a FINAL_DECISION activation, which
      // may replan instead of finishing. Terminal is monotonic, so this is the
      // only point where that choice can still be made — once the drain
      // terminalizes, nothing can reopen the job.
      //
      // The plan is explicit that the drain itself may not judge: "RESULT_DRAIN
      // nie uruchamia modelu/toola". It only defers here; the judging happens in
      // its own activation.
      const deferTerminal = wouldTerminalize && input.deferTerminalDecision === true;
      const terminalize = wouldTerminalize && !deferTerminal;

      const postBatchJob: JobDoc = {
        ...job,
        phase: reconciliationBlocker ? 'RECONCILING' : 'AWAITING_RESULTS',
        activeActivationId: null,
        appliedInboxWatermark: highestApplied,
        resolvedInboxWatermark: resolvedWatermark,
      };
      const successorPlan = terminalize
        ? null
        : await buildResultDrainBatchPlan(db, postBatchJob, session, {
            maxBatchItems: 1,
          });
      // A deferred terminal has no further inbox work, so `buildResultDrainBatchPlan`
      // returns nothing and no successor wake would be written — leaving the job
      // parked with nobody to run the decision. Wake it explicitly.
      const deferredDecisionWakeId = deferTerminal && !successorPlan
        ? `obx_final_decision_wake:${activation._id}`
        : null;
      const pendingSuccessorWake = successorPlan
        ? await db.collection<OutboxDoc>(COLLECTIONS.outbox).findOne(
            {
              aggregate: job._id,
              type: 'LaneWakeRequested',
              state: 'PENDING',
              'payload.activationDispatchGeneration':
                job.activationDispatchGeneration,
            },
            { session, sort: { createdAt: 1, _id: 1 } },
          )
        : null;
      const successorWakeId = successorPlan
        ? pendingSuccessorWake?._id ?? successorWakeIdFor(activation._id)
        : null;

      const jobCas = await jobs.updateOne(
        {
          ...currentJobFilter(activation),
          stateVersion: job.stateVersion,
          pauseGeneration: job.pauseGeneration,
          activationFence: input.activationFence,
          controlState: job.controlState,
        },
        {
          $set: {
            phase: terminalize
              ? 'TERMINAL'
              : reconciliationBlocker
                ? 'RECONCILING'
                : 'AWAITING_RESULTS',
            terminalOutcome: terminalize ? terminalTransition!.terminalOutcome : null,
            activeActivationId: null,
            activationRecoveryAttempt: 0,
            activationRecoveryRootId: null,
            activationRecoveryRootKind: null,
            appliedInboxWatermark: highestApplied,
            resolvedInboxWatermark: resolvedWatermark,
            updatedAt: committedAt,
          },
          $inc: {
            stateVersion: 1,
            ...(terminalize
              ? {
                  activationDispatchGeneration: 1,
                  jobStopGeneration: 1,
                }
              : {}),
          },
        },
        { session },
      );
      if (jobCas.modifiedCount !== 1) {
        throw new ResultDrainAuthorityLostError('result-drain reducer CAS lost');
      }

      if (deferredDecisionWakeId) {
        // Idempotent by construction: one wake per deferring activation, so a
        // retried commit cannot queue a second decision for the same result.
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
          { _id: deferredDecisionWakeId },
          {
            $setOnInsert: {
              aggregate: job._id,
              type: 'LaneWakeRequested',
              state: 'PENDING',
              payload: {
                jobId: job._id,
                reason: 'final_decision',
                activationDispatchGeneration: job.activationDispatchGeneration,
              },
              createdAt: new Date(),
            },
          },
          { session, upsert: true },
        );
      }

      if (successorWakeId && successorPlan) {
        const successorPayload = {
          jobId: job._id,
          reason: 'result_drain_handoff',
          predecessorActivationId: activation._id,
          inboxItemId: successorPlan.inboxItems[0]!._id,
          inboxSequence: successorPlan.inboxItems[0]!.inboxSequence,
          activationDispatchGeneration: job.activationDispatchGeneration,
        };
        if (pendingSuccessorWake) {
          const adopted = await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
            {
              _id: pendingSuccessorWake._id,
              aggregate: job._id,
              type: 'LaneWakeRequested',
              state: 'PENDING',
              'payload.activationDispatchGeneration':
                job.activationDispatchGeneration,
            },
            { $set: { payload: successorPayload } },
            { session },
          );
          if (adopted.modifiedCount !== 1) {
            throw new ResultDrainAuthorityLostError('result-drain wake adoption CAS lost');
          }
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateMany(
            {
              _id: { $ne: pendingSuccessorWake._id },
              aggregate: job._id,
              type: 'LaneWakeRequested',
              state: 'PENDING',
              'payload.activationDispatchGeneration':
                job.activationDispatchGeneration,
            },
            { $set: { state: 'PUBLISHED' } },
            { session },
          );
        } else {
          await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
            _id: successorWakeId,
            aggregate: job._id,
            type: 'LaneWakeRequested',
            state: 'PENDING',
            payload: successorPayload,
            createdAt: committedAt,
          }, { session });
        }
      }
      if (terminalize) {
        const appliedResult = applyDecision
          ? {
              attemptId: applyDecision.attemptId,
              resultId: applyDecision.resultId,
            }
          : currentTask.appliedResultId
            ? await db.collection<ResultDoc>(COLLECTIONS.results).findOne(
                {
                  _id: currentTask.appliedResultId,
                  jobId: job._id,
                  taskId: currentTask._id,
                },
                {
                  session,
                  projection: { _id: 1, attemptId: 1 },
                },
              )
            : null;
        const sequence = await nextEventSeq(db, job._id, session);
        await db.collection<JobEventDoc>(COLLECTIONS.events).insertOne({
          _id: `${job._id}:${sequence}`,
          jobId: job._id,
          sequence,
          type: 'JobTerminalized',
          payload: {
            terminalOutcome: terminalTransition!.terminalOutcome,
            taskId: currentTask._id,
            ...(appliedResult
              ? {
                  attemptId: appliedResult.attemptId,
                  resultId: '_id' in appliedResult
                    ? appliedResult._id
                    : appliedResult.resultId,
                }
              : {}),
            activationId: activation._id,
          },
          createdAt: committedAt,
        }, { session });
        await db.collection<OutboxDoc>(COLLECTIONS.outbox).insertOne({
          _id: newOutboxId(),
          aggregate: job._id,
          type: 'JobTerminal',
          state: 'PENDING',
          payload: {
            jobId: job._id,
            terminalOutcome: terminalTransition!.terminalOutcome,
          },
          createdAt: committedAt,
        }, { session });
      }

      const activationSnapshot = await activations.updateOne(
        {
          _id: activation._id,
          kind: 'RESULT_DRAIN',
          lifecycle: 'COMMITTED',
          activeSlot: false,
          committedPayloadHash: payloadHash,
          committedAt,
        },
        {
          $set: {
            committedAppliedInboxWatermark: highestApplied,
            committedResolvedInboxWatermark: resolvedWatermark,
            successorWakeId,
            outcome: terminalize
              ? terminalTransition!.terminalOutcome
              : 'BATCH_DRAINED',
          },
        },
        { session },
      );
      if (activationSnapshot.modifiedCount !== 1) {
        throw new ResultDrainAuthorityLostError('result-drain commit snapshot CAS lost');
      }

      return {
        activationId: activation._id,
        jobId: job._id,
        taskId: applyDecision?.taskId ?? null,
        attemptId: applyDecision?.attemptId ?? null,
        resultId: applyDecision?.resultId ?? null,
        inboxItemId: applyDecision?.inboxItemId ?? null,
        batchInboxItemIds: [...activation.batchInboxItemIds],
        appliedInboxWatermark: highestApplied,
        resolvedInboxWatermark: resolvedWatermark,
        successorWakeId,
        outcome: terminalize ? terminalTransition!.terminalOutcome : null,
        deduped: false,
      } satisfies ResultDrainCommitResult;
    });
    return value;
  } catch (err) {
    if (err instanceof ResultDrainAuthorityLostError) return null;
    throw err;
  }
}

/** Convenience path; every state mutation still uses the fenced primitives above. */
export async function runResultDrainActivation(
  client: MongoClient,
  db: Db,
  jobId: string,
  opts: ResultDrainActivationOptions & {
    leaseOwner?: string;
    leaseTtlMs?: number;
    /**
     * When supplied by a claimed wake, continue exactly that activation.
     * `null` means the wake had no RESULT_DRAIN activation and may not create one.
     */
    requiredActivationId?: string | null;
    /** F5B: defer the terminal call to a FINAL_DECISION activation. */
    deferTerminalDecision?: boolean;
  } = {},
): Promise<ResultDrainCommitResult | null> {
  const activation = opts.requiredActivationId === undefined
    ? await materializeResultDrainActivation(client, db, jobId, opts)
    : opts.requiredActivationId === null
      ? null
      : await db.collection<LaneActivationDoc>(COLLECTIONS.activations).findOne({
        _id: opts.requiredActivationId,
        jobId,
        kind: 'RESULT_DRAIN',
        activeSlot: true,
        lifecycle: { $in: ACTIVE_ACTIVATION_LIFECYCLES },
      });
  if (!activation) return null;

  const leaseOwner =
    opts.leaseOwner ?? `lane-result-drain:${globalThis.crypto.randomUUID()}`;
  const lease = await claimResultDrainActivation(client, db, {
    activationId: activation._id,
    leaseOwner,
    leaseTtlMs: opts.leaseTtlMs,
  });
  if (!lease) return null;
  if (!await startResultDrainActivation(client, db, {
    activationId: activation._id,
    leaseOwner,
    activationFence: lease.activationFence,
  })) {
    return null;
  }
  return commitResultDrainActivation(client, db, {
    activationId: activation._id,
    leaseOwner,
    activationFence: lease.activationFence,
    deferTerminalDecision: opts.deferTerminalDecision,
  });
}
