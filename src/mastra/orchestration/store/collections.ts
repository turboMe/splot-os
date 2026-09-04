/**
 * Collection names, document shapes and index setup for the durable
 * orchestration substrate (V2). Walking-skeleton scope (plan §15.4, §15.7.1):
 * the flat command → job → event → outbox spine. More collections
 * (job_tasks, job_attempts, dispatch_edges, …) are added in later waves.
 *
 * All collections are prefixed `orch_` and live in their own database so the V2
 * substrate never collides with the existing `agentforge` collections. Indexes
 * encode the plan's uniqueness invariants.
 */
import type { Db } from 'mongodb';
import {
  JOB_TERMINAL_OUTCOMES,
  PRIMARY_JOB_STOP_CAUSES,
  type JobTerminalOutcome,
  type PrimaryJobStopCause,
} from '../contracts/index.js';
import type {
  JobPhase, JobControlState, JobRelationMode, CommandState, OutboxState,
  TaskPhase, TaskControlState, AttemptMode, AttemptLifecycle, AttemptOutcome,
  ActivationKind, ActivationLifecycle, InboxState, PrimaryAttemptStopCause,
} from '../contracts/index.js';
import type { ProgressiveAttemptPolicy } from '../contracts/execution-budget.js';
import { canonicalHash } from './txn.js';

export const COLLECTIONS = {
  commands: 'orch_conversation_commands',
  jobs: 'orch_jobs',
  events: 'orch_job_events',
  outbox: 'orch_outbox',
  tasks: 'orch_job_tasks',
  attempts: 'orch_job_attempts',
  activations: 'orch_lane_activations',
  budgetReservations: 'orch_budget_reservations',
  results: 'orch_execution_results',
  inbox: 'orch_job_inbox',
  timers: 'orch_timers',
  requests: 'orch_control_requests',
  edges: 'orch_dispatch_edges',
  // C boundary (§4.4, §7.5) — conversation projection & delivery.
  mailbox: 'orch_conversation_mailbox',
  projections: 'orch_conversation_projections',
  deliveries: 'orch_deliveries',
  convCursor: 'orch_conversation_cursor',
} as const;

export const EDGE_COMPLETION = ['REQUIRED', 'OPTIONAL'] as const;
export type EdgeCompletion = (typeof EDGE_COMPLETION)[number];
export const EDGE_LIFECYCLE = ['ACTIVE', 'SETTLED'] as const;
export type EdgeLifecycleSkeleton = (typeof EDGE_LIFECYCLE)[number];

export const TERMINAL_BARRIER_MODES = [
  'FLAT_STOP_V1',
  'BLOCKED_UNSUPPORTED',
] as const;
export type TerminalBarrierMode = (typeof TERMINAL_BARRIER_MODES)[number];

/**
 * PR-40 pins the first durable control-budget policy per job. This is a narrow
 * job-local slice: ordinary worker/orchestration/final-decision pools and the
 * global control-plane capacity pool remain separate later contracts.
 */
export const CONTROL_BUDGET_POLICY_V1 = {
  version: 1,
  jobControlRecoveryReserveMs: 90_000,
  activationAllotmentMs: 30_000,
  activationLeaseTtlMs: 10_000,
  activationCommitReserveMs: 2_000,
  maxRecoveryAttempts: 3,
} as const;

export const STOP_CONTROL_RECOVERY_STATES = [
  'IDLE',
  'PENDING',
  'ACTIVE',
  'WAITING',
  'EXHAUSTED',
] as const;
export type StopControlRecoveryState =
  (typeof STOP_CONTROL_RECOVERY_STATES)[number];

export const BUDGET_RESERVATION_STATES = [
  'RESERVED',
  'ACTIVE',
  'SETTLED',
  'EXPIRED',
] as const;
export type BudgetReservationState =
  (typeof BUDGET_RESERVATION_STATES)[number];

export const BUDGET_SETTLEMENT_REASONS = [
  'COMMITTED',
  'ABANDONED',
  'FAILED',
  'EXPIRED',
] as const;
export type BudgetSettlementReason =
  (typeof BUDGET_SETTLEMENT_REASONS)[number];

/**
 * `orch_dispatch_edges` — same-job parent→child task edge (§5.1, §15.5). Skeleton
 * subset: ACTIVE→SETTLED; a REQUIRED child must settle before the parent succeeds.
 */
export interface DispatchEdgeDoc {
  _id: string; // edgeId
  jobId: string;
  parentTaskId: string;
  childTaskId: string;
  completionMode: EdgeCompletion;
  lifecycle: EdgeLifecycleSkeleton;
  createdAt: Date;
}

export const REQUEST_KINDS = ['user', 'approval', 'external', 'dependency'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATES = ['OPEN', 'ANSWERED', 'EXPIRED', 'CANCELLED'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** `orch_control_requests` — a pending user/approval/external ask (§8.8, §15.4). */
export interface ControlRequestDoc {
  _id: string; // requestId
  jobId: string;
  /**
   * Null for a LANE-originated question (§4.2: the Lane Orchestrator may
   * "formulate a question for the user"). Such a question is asked while
   * planning, before any task or attempt exists, so it is bound to the job
   * alone. Every consumer must handle null rather than assume a task.
   */
  taskId: string | null;
  attemptId: string | null;
  kind: RequestKind;
  action: string;
  state: RequestState;
  expiresAt: Date;
  answer: string | null;
  createdAt: Date;
}

export const TIMER_KINDS = [
  'retry',
  'lease_expiry',
  'job_deadline',
  'attempt_stop_grace',
  'inbox_result_retry',
] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export const TIMER_STATES = ['PENDING', 'FIRED', 'CANCELLED'] as const;
export type TimerState = (typeof TIMER_STATES)[number];

/**
 * `orch_timers` — durable wakeups (§10, §7.6). A timer is only a reminder: when
 * it fires, the reducer re-checks the entity (which is the authority) and acts,
 * so a stale/superseded timer is harmless.
 */
export interface TimerDoc {
  _id: string; // timerId
  kind: TimerKind;
  jobId: string;
  entityId: string; // attemptId / taskId / jobId depending on kind
  /** Scoped owner epoch; zero for legacy/generic wake-only timers. */
  generation: number;
  /** Inbox redrive epoch observed when a typed retry timer was scheduled. */
  sourceRedriveAttempt: number | null;
  fireAt: Date;
  state: TimerState;
  firedAt: Date | null;
  /** Wake adopted/created by a typed firing; null for generic wake-only timers. */
  wakeId: string | null;
  createdAt: Date;
}

/** `orch_conversation_commands` — idempotent command log (§7.4, §15.4). */
export interface CommandDoc {
  /** `${resourceId}:${commandId}` — natural idempotency key. */
  _id: string;
  resourceId: string;
  conversationId: string;
  commandId: string;
  type: string;
  payloadHash: string;
  jobId: string;
  state: CommandState;
  createdAt: Date;
}

/** `orch_jobs` — the durable job aggregate (skeleton subset of §15.4). */
export interface JobDoc {
  _id: string; // jobId
  resourceId: string;
  conversationId: string;
  phase: JobPhase;
  controlState: JobControlState;
  terminalOutcome: JobTerminalOutcome | null;
  stateVersion: number;
  planVersion: number;
  /** Invalidates payload-ready markers across a pause/resume cycle. */
  pauseGeneration: number;
  /** Invalidates pending/running lane activations across control/terminal epochs. */
  activationDispatchGeneration: number;
  /** First terminal stop/reducer generation; activation commits snapshot it. */
  jobStopGeneration: number;
  /**
   * Requested outcome is durable before the terminal barrier is complete.
   * Optional only for additive PR<=36 BSON compatibility.
   */
  pendingTerminalOutcome?: JobTerminalOutcome | null;
  primaryJobStopCause?: PrimaryJobStopCause | null;
  secondaryJobStopCauses?: PrimaryJobStopCause[];
  stopGraceDueAt?: Date | null;
  /**
   * PR-39 terminal-stop reducer scope. `BLOCKED_UNSUPPORTED` is durable and
   * intentionally excluded from the reconciler scan so deferred child/effect
   * barriers cannot become a hot loop or be mistaken for settled flat work.
   */
  terminalBarrierMode?: TerminalBarrierMode | null;
  terminalBarrierBlocker?: string | null;
  terminalBarrierNextCheckAt?: Date | null;
  terminalBarrierProbeAttempt?: number;
  /** Audit/order version; unlike jobStopGeneration it is not execution authority. */
  controlVersion?: number;
  /** Monotonic fence minted when a lane activation is claimed. */
  activationFence: number;
  /** At most one PENDING/LEASED/RUNNING activation owns this job. */
  activeActivationId: string | null;
  /**
   * Bounded consecutive lost-activation recoveries. It resets when an ordinary
   * BUSINESS/RESULT_DRAIN activation commits, or when a generation-changing
   * control command intentionally abandons the recovery chain. Optional solely
   * for additive PR<=35 BSON compatibility (missing = 0).
   */
  activationRecoveryAttempt?: number;
  /** Root authority retained across CONTROL_RECOVERY → ordinary retry cycles. */
  activationRecoveryRootId?: string | null;
  /** Root kind retained with `activationRecoveryRootId`; both reset on success. */
  activationRecoveryRootKind?: 'BUSINESS' | 'RESULT_DRAIN' | null;
  /** Pinned job-local STOP/control budget policy (PR-40 partial ORC-BUDGET-01). */
  controlBudgetPolicyVersion: number;
  /** Untouchable by BUSINESS/RESULT_DRAIN; only typed stop recovery reserves it. */
  jobControlRecoveryReserveMs: number;
  /** Sum of allotments held by unsettled JOB_CONTROL_RECOVERY reservations. */
  jobControlRecoveryReservedMs: number;
  /** Exactly-once charged store-time elapsed from settled control reservations. */
  jobControlRecoveryConsumedMs: number;
  /** Consecutive lost STOP_CONTROL_RECOVERY owners in the current stop epoch. */
  stopControlRecoveryAttempt: number;
  /** Durable owner/admission state for the current stop epoch. */
  stopControlRecoveryState: StopControlRecoveryState;
  /** Highest 1-based inbox sequence allocated atomically with ingress. */
  inboxHighWatermark: number;
  /** Diagnostic maximum sequence whose business result was actually APPLIED. */
  appliedInboxWatermark: number;
  /** Highest contiguous sequence in a durable resolved state. */
  resolvedInboxWatermark: number;
  /** One-way offline schema marker; written only after inbox migration completes. */
  inboxSchemaVersion: number;
  /** User steer/append instructions, applied to subsequent attempts (§8.3). */
  instructions: string[];
  /** Fork provenance (§8.7): the source job and its typed relation. */
  parentJobId: string | null;
  jobRelationMode: JobRelationMode | null;
  goal: string;
  /**
   * A specialist named by the PRODUCER at the command boundary, not by a model.
   *
   * Exists for cutover: legacy delegation already knows which agent it wants
   * (`delegate_task(targetAgent: 'chefAgent')`), so re-deriving that with a
   * planning model would be both a wasted call and a chance to pick someone
   * else. When present, planning skips the decider and freezes exactly this name
   * into the plan.
   *
   * Opaque to the substrate, same as `TaskDoc.capability` — the worker's router
   * owns what the name means. Null/absent = the lane decides, as before.
   */
  requestedCapability?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `orch_job_events` — ordered domain events per job (§9.1, §15.4). */
export interface JobEventDoc {
  _id: string; // `${jobId}:${sequence}`
  jobId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** `orch_outbox` — transactional outbox for at-least-once publish (§9.2). */
export interface OutboxDoc {
  _id: string; // outboxId
  aggregate: string; // jobId
  type: string;
  state: OutboxState;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** `orch_job_tasks` — a logical plan step (§7.2). Skeleton: SERIAL only. */
export interface TaskDoc {
  _id: string; // taskId
  jobId: string;
  phase: TaskPhase;
  controlState: TaskControlState;
  attemptMode: AttemptMode;
  planVersion: number;
  /** Attempt/task stop epoch. Full task barrier semantics remain deferred. */
  stopGeneration?: number;
  /** Earliest a RETRY_PENDING task may be re-dispatched (retry backoff). */
  retryNotBefore?: Date | null;
  /** Per-task input (child tasks carry their own; falls back to the job goal). */
  goal?: string | null;
  /**
   * Which specialist the lane assigned, frozen at plan time (see
   * `PlanningProposalV1.capability`). Opaque to the substrate — the worker's
   * router owns what the name means. Null/absent = the worker's default.
   */
  capability?: string | null;
  /**
   * Attempt window frozen at plan time, derived from the chosen capability. Null
   * = the store default. Frozen rather than looked up so a retry or a restarted
   * process runs under the same budget as the first attempt.
   */
  attemptCapMs?: number | null;
  /**
   * Code-owned earned-time policy, frozen in the same hashed proposal as the
   * capability and absolute attempt cap. Missing/null preserves fixed budgets.
   */
  progressiveAttempt?: ProgressiveAttemptPolicy | null;
  /** Content receipts survive attempt retries and are inherited by replans. */
  durableProgressFingerprints?: string[];
  /**
   * The sibling this step waits for (F6B — multi-step plans).
   *
   * Dispatch edges model parent→child, so siblings have no order and all of them
   * come up READY at once. A domain sequence needs "research, THEN write", and
   * nesting cannot express it: in `spawnChildTasks` the parent is an aggregation
   * node that never executes, so a chain of parents would leave the LAST link as
   * the only real work, in reverse order.
   *
   * So a step may name a predecessor. With one set it starts in
   * `WAITING_DEPENDENCY` instead of `READY`, and `promoteSequencedSteps` releases
   * it once that predecessor SUCCEEDED. `WAITING_DEPENDENCY` is reused rather
   * than inventing a phase because the control boundary, request boundary,
   * attempt mapping and stop reducer already know it — a new phase would have to
   * be taught to five places that each fail closed on an unknown state.
   */
  awaitsTaskId?: string | null;
  /**
   * The plan parent this task is a step of (F6B), or absent for a single task.
   *
   * Recorded at the moment the step is created rather than recovered later from
   * `orch_dispatch_edges`, because the fact has exactly one consumer and one
   * moment at which it is certain — the same reason `services/run-artifacts.ts`
   * notes an artifact when it is written instead of scanning for it afterwards.
   *
   * `awaitsTaskId` cannot answer this: step 1 of a plan waits for nothing and is
   * indistinguishable from a single task by that field alone, yet it is the step
   * most in need of the distinction (it is the one whose successors cover the
   * rest of the job goal).
   */
  parentTaskId?: string | null;
  /** Why a sequenced step will never run. Set with `BLOCKED`, read by operators. */
  blockedReason?: string | null;
  /**
   * The ordered plan this task aggregates, frozen at plan time (F6B).
   *
   * Present only on a PARENT committed by a `plan_steps` decision. The steps are
   * materialized into real tasks by an idempotent lane move; keeping the list on
   * the parent is what makes that move recoverable — a crash between committing
   * the plan and creating its steps leaves everything needed to finish the job.
   */
  plannedSteps?: Array<{
    goal: string;
    capability?: string;
    attemptCapMs?: number;
    progressiveAttempt?: ProgressiveAttemptPolicy;
  }> | null;
  /**
   * The task this one REPLACES, when the lane replanned after a failure.
   *
   * Written so the job's outcome can distinguish "this work failed" from "an
   * earlier attempt at this work failed and was retried". Without it the outcome
   * rule saw only `[FAILED, SUCCEEDED]` and reported FAILED for a job that had
   * delivered a finished 16 KB prototype — see `commitFinalTerminal`.
   */
  supersedesTaskId?: string | null;
  /** The sole LEASED/RUNNING attempt admitted for this SERIAL task. */
  activeAttemptId?: string | null;
  /** Flat-SERIAL payload-ready authority currently pinned to this attempt. */
  businessPayloadReadyAttemptId?: string | null;
  businessPayloadReadyGeneration?: number;
  /**
   * Additive PR-32 opt-in. Missing/LEGACY_FUSED records keep the pre-inbox A+B
   * path; RESULT_DRAIN_V1 is admitted only for one root SERIAL task.
   */
  resultApplyMode?: 'LEGACY_FUSED' | 'RESULT_DRAIN_V1';
  /** Immutable A output waiting for the typed RESULT_DRAIN reducer. */
  pendingResultId?: string | null;
  /** Result identity atomically applied by RESULT_DRAIN. */
  appliedResultId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ATTEMPT_PROCESS_STATES = [
  'NONE',
  'OWNED',
  'STOP_REQUESTED',
  'EXITED',
  'UNKNOWN',
] as const;
export type AttemptProcessState = (typeof ATTEMPT_PROCESS_STATES)[number];

/**
 * Durable identity of one supervised execution run. `workerInstanceId`, PID and
 * PGID are observational; receipt authority is the complete tuple including
 * runtime/process IDs, owner generation, attempt fence, boot ID and start token.
 */
export interface AttemptProcessOwnerDoc {
  processExecutionId: string;
  runtimeRunId: string;
  workerInstanceId: string;
  ownerGeneration: number;
  attemptFence: number;
  mode: 'IN_PROCESS' | 'PROCESS_GROUP' | 'FAKE_SUPERVISOR';
  hostId: string;
  hostBootId: string;
  /** Linux PID namespace inode, required for PROCESS_GROUP ownership. */
  pidNamespaceId?: string;
  pid: number;
  pgid: number;
  /** POSIX session id, required for PROCESS_GROUP ownership. */
  sid?: number;
  processStartToken: string;
  registeredAt: Date;
  startedAt: Date;
}

/** Immutable trusted-supervisor acknowledgement for one attempt stop epoch. */
export interface AttemptStopReceiptDoc {
  receiptId: string;
  receiptHash: string;
  stopGeneration: number;
  processExecutionId: string;
  runtimeRunId: string;
  workerInstanceId: string;
  processOwnerGeneration: number;
  attemptFence: number;
  hostId: string;
  hostBootId: string;
  pidNamespaceId?: string;
  pid: number;
  pgid: number;
  sid?: number;
  processStartToken: string;
  confirmationKind: 'PROCESS_TREE_EMPTY';
  terminationConfirmed: true;
  processTreeEmpty: true;
  exitCode: number | null;
  signal: string | null;
  observedAt: Date;
  treeEmptyAt: Date;
}

/** Immutable normal-exit proof, distinct from a stop-generation receipt. */
export interface AttemptProcessExitReceiptDoc {
  receiptId: string;
  receiptHash: string;
  processExecutionId: string;
  runtimeRunId: string;
  workerInstanceId: string;
  processOwnerGeneration: number;
  attemptFence: number;
  /** Present only for POST_STOP_UNKNOWN_TREE_EMPTY; absent on normal exit. */
  stopGeneration?: number;
  hostId: string;
  hostBootId: string;
  pidNamespaceId?: string;
  pid: number;
  pgid: number;
  sid?: number;
  processStartToken: string;
  confirmationKind:
    | 'NORMAL_PROCESS_TREE_EMPTY'
    | 'POST_STOP_UNKNOWN_TREE_EMPTY';
  terminationConfirmed: true;
  processTreeEmpty: true;
  exitCode: number | null;
  signal: string | null;
  observedAt: Date;
  treeEmptyAt: Date;
}

export const PROCESS_SIGNAL_STAGES = [
  'NONE',
  'OBSERVED',
  'ABORT_SENT',
  'TERM_SENT',
  'KILL_SENT',
  'TREE_EMPTY',
] as const;
export type ProcessSignalStage = (typeof PROCESS_SIGNAL_STAGES)[number];

/**
 * `orch_job_attempts` — a concrete server-side try of a task, with the
 * lease/fence/heartbeat lifecycle (§7.3). `attemptFence` rises on every claim and
 * is checked on renew/result/effect so a stale worker has no authority (inv. #8).
 */
export interface AttemptDoc {
  _id: string; // attemptId
  jobId: string;
  taskId: string;
  /** Trusted snapshot: this attempt may only publish into this plan. */
  planVersion: number;
  /** Terminal-stop epoch observed when the attempt was dispatched. */
  jobStopGenerationAtDispatch?: number;
  /** Task-stop epoch observed when the attempt was dispatched. */
  taskStopGenerationAtDispatch?: number;
  /** Pause epoch captured at dispatch (resume explicitly refreshes QUEUED work). */
  pauseGenerationAtDispatch: number;
  /** Pause epoch that atomically captured this RUNNING attempt as finish-current. */
  finishCurrentPauseGeneration: number | null;
  attemptNumber: number;
  lifecycle: AttemptLifecycle;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  attemptFence: number;
  /** Current first-stop epoch and immutable cause for PROCESS_STOP_V1. */
  stopGeneration?: number;
  primaryAttemptStopCause?: PrimaryAttemptStopCause | null;
  secondaryAttemptStopCauses?: PrimaryAttemptStopCause[];
  attemptStopGraceDueAt?: Date | null;
  attemptStopTimerGeneration?: number;
  /** Job stop epoch that authorized this attempt stop, or null for local stop. */
  jobStopGenerationAtStop?: number | null;
  /** Exact supervised process owner; null/UNKNOWN means stop cannot be confirmed. */
  processOwner?: AttemptProcessOwnerDoc | null;
  processState?: AttemptProcessState;
  /** Null until confirmed stop or fail-closed grace resolution. */
  terminationConfirmed?: boolean | null;
  /** Embedded immutable receipt: one process group per attempt in this slice. */
  stopReceipt?: AttemptStopReceiptDoc | null;
  /** Normal process completion proof; never rewrites the business outcome. */
  processExitReceipt?: AttemptProcessExitReceiptDoc | null;
  /** Inert PROCESS_GROUP workload is released only after a second authority CAS. */
  processWorkloadReleasedAt?: Date | null;
  /** Monotonic, diagnostic signal progress for restart-safe escalation. */
  processSignalStage?: ProcessSignalStage;
  processStopObservedAt?: Date | null;
  processAbortSentAt?: Date | null;
  processTermSentAt?: Date | null;
  processKillSentAt?: Date | null;
  processTreeEmptyAt?: Date | null;
  /** Durable bounded supervisor probe state for unresolved FINISHED lineage. */
  processReconcileNextAt?: Date | null;
  processReconcileProbeAttempt?: number;
  /** Trusted store time of the LEASED→RUNNING operation-start CAS. */
  operationStartedAt: Date | null;
  /** No new business/model/tool work at or after this cutoff. */
  businessOperationCutoffAt: Date;
  /** Ordinary A must commit before this deadline. */
  workDeadlineAt: Date;
  hardDeadlineAt: Date;
  /**
   * Immutable maximums for a progressive attempt. The three ordinary deadline
   * fields above are the currently earned window and move together. Older and
   * fixed-budget rows may omit these; their current hard deadline is absolute.
   */
  absoluteBusinessOperationCutoffAt?: Date;
  absoluteWorkDeadlineAt?: Date;
  absoluteHardDeadlineAt?: Date;
  progressiveAttempt?: ProgressiveAttemptPolicy | null;
  progressExtensionCount?: number;
  progressFingerprints?: string[];
  lastDurableProgressAt?: Date | null;
  lastDurableProgressKind?: string | null;
  /** Flat-SERIAL slice of ORC-RESULT-READY-01 (0 = no marker). */
  businessPayloadReadyGeneration: number;
  businessPayloadReadyHash: string | null;
  businessPayloadReadyAt: Date | null;
  /** Pause generation captured by the marker and required by ordinary A. */
  businessPayloadReadyPauseGeneration: number | null;
  /** Immutable identity of an authoritative A commit (including typed failure). */
  leaseOwnerAtCommit: string | null;
  committedPayloadHash: string | null;
  ACommittedAt: Date | null;
  outcome: AttemptOutcome | null;
  resultId: string | null;
  reasonCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `orch_lane_activations` — a short fenced reducer lease (§7.6, §15.5).
 *
 * PR-31 wires a flat BUSINESS planning reducer with a central proposal marker;
 * PR-32 adds a one-item flat SERIAL RESULT_DRAIN; PR-33 adds a bounded
 * watermark/handoff spine around that same root-SERIAL consumer. Protected
 * budget pools and the remaining activation kinds are later slices.
 */
export interface LaneActivationDoc {
  _id: string; // activationId
  /** Wake that durably materialized this activation; null for direct store calls. */
  sourceWakeId: string | null;
  jobId: string;
  kind: ActivationKind;
  lifecycle: ActivationLifecycle;
  /** Unique-active-slot guard; false once COMMITTED/ABANDONED. */
  activeSlot: boolean;
  activationDispatchGenerationAtClaim: number;
  planVersionAtClaim: number;
  jobStopGenerationAtClaim: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  activationFence: number;
  operationStartedAt: Date | null;
  /** No new BUSINESS work after this point; planning marker must precede it. */
  businessOperationCutoffAt: Date;
  /** Typed reducer commit must linearize before this point. */
  workDeadlineAt: Date;
  /** After this point only control recovery may mutate the activation. */
  hardDeadlineAt: Date;
  purposeAttemptIds: string[];
  /** Exact bounded durable inbox batch frozen when the activation is created. */
  batchInboxItemIds: string[];
  /** Inclusive sequence boundary of the immutable batch. */
  batchThroughWatermark: number;
  /** Diagnostic inbox snapshots taken before the batch owns the job slot. */
  inboxHighWatermarkAtClaim: number;
  appliedInboxWatermarkAtClaim: number;
  resolvedInboxWatermarkAtClaim: number;
  /** Immutable planning proposal marker generation (0 before, 1 when ready). */
  businessPayloadReadyGeneration: number;
  businessPayloadReadyHash: string | null;
  businessPayloadReadyAt: Date | null;
  /** Bounded, control-plane-generated proposal frozen by the marker. */
  reducerPayload: Record<string, unknown> | null;
  /** Stable routing envelope for CONTROL_RECOVERY subtypes (payload may corrupt). */
  controlSubtype?: 'STOP_TERMINAL' | null;
  /** Immutable canonical hash of a typed reducer payload when the subtype uses it. */
  reducerPayloadHash?: string | null;
  /** Optional for PR<=39 BSON; mandatory as a complete triplet for STOP control. */
  budgetReservationId?: string | null;
  budgetPool?: 'JOB_CONTROL_RECOVERY' | null;
  activationActiveAllotmentMs?: number | null;
  committedPayloadHash: string | null;
  committedAppliedInboxWatermark: number | null;
  committedResolvedInboxWatermark: number | null;
  /** Deterministic handoff written in the same B transaction, when required. */
  successorWakeId: string | null;
  committedAt: Date | null;
  outcome: string | null;
  reasonCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Durable reserve → activate → settle accounting for one execution owner.
 * PR-40 implements only the protected job-local STOP/control pool.
 */
export interface BudgetReservationDoc {
  _id: string; // budgetReservationId
  jobId: string;
  jobStopGeneration: number;
  activationDispatchGeneration: number;
  pool: 'JOB_CONTROL_RECOVERY';
  ownerKind: 'ACTIVATION';
  ownerId: string;
  policyVersion: number;
  state: BudgetReservationState;
  allotmentMs: number;
  reservedAt: Date;
  expiresAt: Date;
  activatedAt: Date | null;
  settledAt: Date | null;
  chargedActiveMs: number;
  refundedMs: number;
  settlementReason: BudgetSettlementReason | null;
}

/**
 * Terminal control reservations are charged from store-stamped elapsed active
 * time, capped by the reserved allotment. Conservation alone is insufficient:
 * a tampered charge/refund split must not become authoritative on replay.
 */
export function hasExactBudgetReservationSettlement(
  reservation: BudgetReservationDoc,
): boolean {
  if (
    !(reservation.settledAt instanceof Date)
    || !Number.isInteger(reservation.allotmentMs)
    || reservation.allotmentMs < 0
    || !Number.isInteger(reservation.chargedActiveMs)
    || reservation.chargedActiveMs < 0
    || !Number.isInteger(reservation.refundedMs)
    || reservation.refundedMs < 0
  ) return false;
  const expectedCharge = reservation.activatedAt instanceof Date
    ? Math.min(
        reservation.allotmentMs,
        Math.max(
          0,
          reservation.settledAt.getTime()
            - reservation.activatedAt.getTime(),
        ),
      )
    : reservation.activatedAt === null
      ? 0
      : null;
  return expectedCharge !== null
    && reservation.chargedActiveMs === expectedCharge
    && reservation.refundedMs
      === reservation.allotmentMs - expectedCharge;
}

/** `orch_execution_results` — immutable validated result envelope (§9.1). */
export interface ResultDoc {
  _id: string; // resultId
  resourceId: string;
  attemptId: string;
  jobId: string;
  taskId: string;
  planVersion: number;
  /** Trusted worker identity that owned the lease when A committed. */
  leaseOwnerAtCommit: string;
  attemptFence: number;
  /** Hash of the normalized producer candidate committed by A. */
  payloadHash: string;
  businessPayloadReadyGeneration: number;
  businessPayloadReadyHash: string | null;
  status: string;
  producer: Record<string, unknown>;
  ACommittedAt: Date;
  createdAt: Date;
}

/**
 * `orch_job_inbox` — durable A→B handoff. PR-33 assigns a per-job 1-based
 * sequence and supports bounded stale-tail resolution around one validated
 * root-SERIAL result. PR-34 adds durable unsupported quarantine plus an
 * idempotent operator/upgrade redrive epoch. PR-35 adds a bounded automatic
 * transient retry timer/generation; the general classifier remains deferred.
 */
export interface JobInboxDoc {
  _id: string; // `${jobId}:${resultId}`
  jobId: string;
  taskId: string;
  attemptId: string;
  resultId: string;
  /** 1-based and unique within a job; allocated by the job CAS in A. */
  inboxSequence: number;
  kind: string;
  consumerVersion: number;
  state: InboxState;
  planVersion: number;
  attemptFence: number;
  payloadHash: string;
  /** Null for ordinary A; current pause generation for captured finish-current. */
  finishCurrentPauseGenerationAtA: number | null;
  appliedByActivationId: string | null;
  resolvedByActivationId: string | null;
  resolutionCode: string | null;
  /** Number of accepted operator/automatic redrive promotions. */
  redriveAttempt: number;
  /** Idempotency key of the last accepted operator/policy redrive. */
  lastRedriveRequestId: string | null;
  /** Deterministic durable operator alert for the current quarantine epoch. */
  operatorAlertId: string | null;
  /** Monotonic generation of the last scheduled inbox retry timer. */
  retryTimerGeneration: number;
  /** Number of automatic due-timer promotions already accepted. */
  retryAttempt: number;
  /** Exact current scoped timer, only while FAILED_RETRYABLE. */
  retryTimerId: string | null;
  /** Store-authoritative retry eligibility, only while FAILED_RETRYABLE. */
  nextEligibleAt: Date | null;
  /** Bounded typed reason for the current/last transient failure. */
  retryReasonCode: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/**
 * C boundary (§4.4, §7.5). The Conversation Writer drains projectable domain
 * events (JobTerminal…) from the outbox and applies them exactly-once *logically*
 * to a conversation. Idempotency is enforced by a deterministic composite `_id`
 * `${conversationId}:${logicalEventId}:${target}` shared by the mailbox slot and
 * the durable projection — a redelivered event dup-keys instead of producing a
 * second message. Transport (SSE/poll) is at-least-once and dedups on `deliveryId`.
 */
export interface MailboxDoc {
  _id: string; // `${conversationId}:${logicalEventId}:${target}`
  conversationId: string;
  logicalEventId: string; // the source outbox entry _id
  target: string;
  jobId: string;
  status: 'APPLIED';
  appliedAt: Date;
}

/** `orch_conversation_projections` — the durable, once-written user-facing message. */
export interface ProjectionDoc {
  _id: string; // same composite as the mailbox slot
  conversationId: string;
  resourceId: string; // owner — reads are fail-closed scoped to it (§5.2)
  logicalEventId: string;
  target: string;
  jobId: string;
  sequence: number; // per-conversation, CAS-assigned
  projectionPolicyVersion: number; // pinned; NOT part of the identity key
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** `orch_deliveries` — a per-channel send record (`PENDING → DELIVERED`). */
export interface DeliveryDoc {
  _id: string; // deliveryId
  projectionId: string;
  conversationId: string;
  target: string;
  channel: string;
  sequence: number;
  state: 'PENDING' | 'DELIVERED';
  createdAt: Date;
  updatedAt: Date;
}

/** `orch_conversation_cursor` — per-conversation monotonic projection sequence. */
export interface ConversationCursorDoc {
  _id: string; // conversationId
  sequence: number;
}

interface StopBudgetPayloadEnvelope {
  jobId: string;
  planVersion: number;
  jobStopGeneration: number;
  activationDispatchGeneration: number;
  recoveryAttempt: number;
  budgetReservationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStopBudgetPayloadEnvelope(
  value: LaneActivationDoc['reducerPayload'],
): StopBudgetPayloadEnvelope | null {
  if (
    !isRecord(value)
    || value.kind !== 'STOP_CONTROL_RECOVERY_V1'
    || typeof value.jobId !== 'string'
    || value.jobId.length === 0
    || !Number.isInteger(value.planVersion)
    || (value.planVersion as number) < 0
    || !Number.isInteger(value.jobStopGeneration)
    || (value.jobStopGeneration as number) <= 0
    || !Number.isInteger(value.activationDispatchGeneration)
    || (value.activationDispatchGeneration as number) < 0
    || !JOB_TERMINAL_OUTCOMES.includes(
      value.pendingTerminalOutcome as JobTerminalOutcome,
    )
    || !PRIMARY_JOB_STOP_CAUSES.includes(
      value.primaryJobStopCause as PrimaryJobStopCause,
    )
    || value.terminalBarrierMode !== 'FLAT_STOP_V1'
    || !Number.isInteger(value.barrierProbeAttempt)
    || (value.barrierProbeAttempt as number) < 0
    || !Number.isInteger(value.recoveryAttempt)
    || (value.recoveryAttempt as number) < 1
    || (value.recoveryAttempt as number)
      > CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    || value.recoveryMaxAttempts
      !== CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
    || typeof value.budgetReservationId !== 'string'
    || value.budgetReservationId.length === 0
  ) return null;
  return value as unknown as StopBudgetPayloadEnvelope;
}

/**
 * Offline/single-version PR-40 bootstrap. A completely absent tuple is a known
 * PR<=39 record and receives the pinned V1 pool. A partial/invalid tuple is not
 * repaired by guessing because zeroing one counter could mint fresh budget.
 */
export async function backfillControlBudgetSchema(
  db: Db,
): Promise<{ jobsBackfilled: number; activationsBackfilled: number }> {
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const jobBudgetFields = [
    'controlBudgetPolicyVersion',
    'jobControlRecoveryReserveMs',
    'jobControlRecoveryReservedMs',
    'jobControlRecoveryConsumedMs',
    'stopControlRecoveryAttempt',
    'stopControlRecoveryState',
  ] as const;
  const jobsWithAnyBudgetField = jobs.find({
    $or: jobBudgetFields.map((field) => ({ [field]: { $exists: true } })),
  });
  for await (const job of jobsWithAnyBudgetField) {
    const values = jobBudgetFields.map((field) => job[field]);
    if (values.some((value) => value === undefined)) {
      throw new Error(`partial control-budget tuple for job ${job._id}`);
    }
    const valid =
      job.controlBudgetPolicyVersion === CONTROL_BUDGET_POLICY_V1.version
      && Number.isInteger(job.jobControlRecoveryReserveMs)
      && job.jobControlRecoveryReserveMs
        === CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs
      && Number.isInteger(job.jobControlRecoveryReservedMs)
      && job.jobControlRecoveryReservedMs >= 0
      && Number.isInteger(job.jobControlRecoveryConsumedMs)
      && job.jobControlRecoveryConsumedMs >= 0
      && job.jobControlRecoveryReservedMs
        + job.jobControlRecoveryConsumedMs
        <= job.jobControlRecoveryReserveMs
      && Number.isInteger(job.stopControlRecoveryAttempt)
      && job.stopControlRecoveryAttempt >= 0
      && job.stopControlRecoveryAttempt
        <= CONTROL_BUDGET_POLICY_V1.maxRecoveryAttempts
      && STOP_CONTROL_RECOVERY_STATES.includes(job.stopControlRecoveryState);
    if (!valid) {
      throw new Error(`invalid control-budget tuple for job ${job._id}`);
    }
  }
  const budgetJobResult = await jobs.updateMany(
    {
      $and: jobBudgetFields.map((field) => ({ [field]: { $exists: false } })),
    },
    {
      $set: {
        controlBudgetPolicyVersion: CONTROL_BUDGET_POLICY_V1.version,
        jobControlRecoveryReserveMs:
          CONTROL_BUDGET_POLICY_V1.jobControlRecoveryReserveMs,
        jobControlRecoveryReservedMs: 0,
        jobControlRecoveryConsumedMs: 0,
        stopControlRecoveryAttempt: 0,
        stopControlRecoveryState: 'IDLE',
      },
    },
  );

  const activations =
    db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const activationBudgetFields = [
    'budgetReservationId',
    'budgetPool',
    'activationActiveAllotmentMs',
  ] as const;
  const activationRows = activations.find(
    {},
    {
      projection: {
        _id: 1,
        jobId: 1,
        kind: 1,
        lifecycle: 1,
        activeSlot: 1,
        activationFence: 1,
        planVersionAtClaim: 1,
        jobStopGenerationAtClaim: 1,
        activationDispatchGenerationAtClaim: 1,
        workDeadlineAt: 1,
        hardDeadlineAt: 1,
        reducerPayload: 1,
        controlSubtype: 1,
        reducerPayloadHash: 1,
        budgetReservationId: 1,
        budgetPool: 1,
        activationActiveAllotmentMs: 1,
      },
    },
  );
  const activationIdsToBackfill: string[] = [];
  const stopBudgetOwners = new Map<string, {
    activation: LaneActivationDoc;
    payload: StopBudgetPayloadEnvelope;
  }>();
  for await (const activation of activationRows) {
    const tuple = activationBudgetFields.map((field) => activation[field]);
    const allAbsent = tuple.every((value) => value === undefined);
    const allNull = tuple.every((value) => value === null);
    const stopPayload = parseStopBudgetPayloadEnvelope(
      activation.reducerPayload,
    );
    const exactStopEnvelope =
      activation.kind === 'CONTROL_RECOVERY'
      && stopPayload !== null
      && stopPayload.jobId === activation.jobId
      && stopPayload.planVersion === activation.planVersionAtClaim
      && stopPayload.jobStopGeneration
        === activation.jobStopGenerationAtClaim
      && stopPayload.activationDispatchGeneration
        === activation.activationDispatchGenerationAtClaim
      && activation.workDeadlineAt instanceof Date
      && activation.hardDeadlineAt instanceof Date
      && typeof activation.budgetReservationId === 'string'
      && activation.budgetReservationId.length > 0
      && stopPayload.budgetReservationId === activation.budgetReservationId
      && activation.budgetPool === 'JOB_CONTROL_RECOVERY'
      && activation.activationActiveAllotmentMs
        === CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
      && activation.controlSubtype === 'STOP_TERMINAL'
      && typeof activation.reducerPayloadHash === 'string'
      && activation.reducerPayloadHash.length > 0
      && activation.reducerPayload !== null
      && canonicalHash(activation.reducerPayload)
        === activation.reducerPayloadHash;
    const legacyEnvelope =
      (allAbsent || allNull)
      && stopPayload === null
      && (
        !isRecord(activation.reducerPayload)
        || activation.reducerPayload.kind !== 'STOP_CONTROL_RECOVERY_V1'
      )
      && (
        activation.controlSubtype === undefined
        || activation.controlSubtype === null
      )
      && (
        activation.reducerPayloadHash === undefined
        || activation.reducerPayloadHash === null
      );
    if (!legacyEnvelope && !exactStopEnvelope) {
      throw new Error(
        `partial/invalid activation budget envelope for ${activation._id}`,
      );
    }
    if (exactStopEnvelope) {
      stopBudgetOwners.set(activation._id, {
        activation,
        payload: stopPayload,
      });
    }
    if (
      legacyEnvelope
      && (
        allAbsent
      || activation.reducerPayloadHash === undefined
      || activation.controlSubtype === undefined
      )
    ) {
      activationIdsToBackfill.push(activation._id);
    }
  }
  if (activationIdsToBackfill.length > 0) {
    await activations.updateMany(
      { _id: { $in: activationIdsToBackfill } },
      [{
        $set: {
          reducerPayloadHash: {
            $cond: [
              { $eq: [{ $type: '$reducerPayloadHash' }, 'missing'] },
              null,
              '$reducerPayloadHash',
            ],
          },
          controlSubtype: {
            $cond: [
              { $eq: [{ $type: '$controlSubtype' }, 'missing'] },
              null,
              '$controlSubtype',
            ],
          },
          budgetReservationId: {
            $cond: [
              { $eq: [{ $type: '$budgetReservationId' }, 'missing'] },
              null,
              '$budgetReservationId',
            ],
          },
          budgetPool: {
            $cond: [
              { $eq: [{ $type: '$budgetPool' }, 'missing'] },
              null,
              '$budgetPool',
            ],
          },
          activationActiveAllotmentMs: {
            $cond: [
              {
                $eq: [
                  { $type: '$activationActiveAllotmentMs' },
                  'missing',
                ],
              },
              null,
              '$activationActiveAllotmentMs',
            ],
          },
        },
      }],
    );
  }

  const reservations =
    db.collection<BudgetReservationDoc>(COLLECTIONS.budgetReservations);
  const reservedByJob = new Map<string, number>();
  const consumedByJob = new Map<string, number>();
  const liveReservationOwnerByJob = new Map<string, {
    ownerId: string;
    reservationState: 'RESERVED' | 'ACTIVE';
    activation: LaneActivationDoc;
    payload: StopBudgetPayloadEnvelope;
  }>();
  const retainedFailedOwnerByJob = new Map<string, {
    ownerId: string;
    activation: LaneActivationDoc;
    payload: StopBudgetPayloadEnvelope;
  }>();
  const matchedStopOwnerIds = new Set<string>();
  const reservationJobIds = new Set<string>();
  const storeClock = await db.command({ hello: 1 }) as {
    localTime?: unknown;
  };
  if (!(storeClock.localTime instanceof Date)) {
    throw new Error('Mongo hello response is missing localTime');
  }
  const validationNow = storeClock.localTime.getTime();
  for await (const reservation of reservations.find({})) {
    const terminal = reservation.state === 'SETTLED'
      || reservation.state === 'EXPIRED';
    const commonValid =
      typeof reservation._id === 'string'
      && reservation._id.length > 0
      && typeof reservation.jobId === 'string'
      && reservation.jobId.length > 0
      && Number.isInteger(reservation.jobStopGeneration)
      && reservation.jobStopGeneration > 0
      && Number.isInteger(reservation.activationDispatchGeneration)
      && reservation.activationDispatchGeneration >= 0
      && reservation.pool === 'JOB_CONTROL_RECOVERY'
      && reservation.ownerKind === 'ACTIVATION'
      && typeof reservation.ownerId === 'string'
      && reservation.ownerId.length > 0
      && reservation.policyVersion === CONTROL_BUDGET_POLICY_V1.version
      && BUDGET_RESERVATION_STATES.includes(reservation.state)
      && reservation.allotmentMs
        === CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
      && Number.isInteger(reservation.chargedActiveMs)
      && reservation.chargedActiveMs >= 0
      && Number.isInteger(reservation.refundedMs)
      && reservation.refundedMs >= 0
      && reservation.reservedAt instanceof Date
      && reservation.expiresAt instanceof Date
      && reservation.reservedAt.getTime() <= validationNow
      && reservation.reservedAt.getTime()
        < reservation.expiresAt.getTime();
    const validState = reservation.state === 'RESERVED'
      ? reservation.activatedAt === null
        && reservation.settledAt === null
        && reservation.settlementReason === null
        && reservation.chargedActiveMs === 0
        && reservation.refundedMs === 0
        : reservation.state === 'ACTIVE'
        ? reservation.reservedAt instanceof Date
          && reservation.activatedAt instanceof Date
          && reservation.activatedAt.getTime()
            >= reservation.reservedAt.getTime()
          && reservation.activatedAt.getTime()
            < reservation.expiresAt.getTime()
          && reservation.activatedAt.getTime() <= validationNow
          && reservation.settledAt === null
          && reservation.settlementReason === null
          && reservation.chargedActiveMs === 0
          && reservation.refundedMs === 0
        : reservation.state === 'SETTLED'
          ? reservation.reservedAt instanceof Date
            && reservation.settledAt instanceof Date
            && ['COMMITTED', 'ABANDONED', 'FAILED'].includes(
              reservation.settlementReason ?? '',
            )
            && reservation.settledAt.getTime()
              >= reservation.reservedAt.getTime()
            && (
              reservation.activatedAt instanceof Date
                ? reservation.activatedAt.getTime()
                    >= reservation.reservedAt.getTime()
                  && reservation.activatedAt.getTime()
                    < reservation.expiresAt.getTime()
                  && reservation.settledAt.getTime()
                    >= reservation.activatedAt.getTime()
                : reservation.activatedAt === null
                  && reservation.settlementReason === 'FAILED'
                  && reservation.chargedActiveMs === 0
            )
            && (
              reservation.settlementReason !== 'COMMITTED'
              || reservation.settledAt.getTime()
                < reservation.expiresAt.getTime()
            )
            && reservation.settledAt.getTime() <= validationNow
          : reservation.state === 'EXPIRED'
            ? reservation.reservedAt instanceof Date
              && reservation.activatedAt === null
              && reservation.settledAt instanceof Date
              && reservation.settlementReason === 'EXPIRED'
              && reservation.settledAt.getTime()
                >= reservation.reservedAt.getTime()
              && reservation.settledAt.getTime() <= validationNow
            : false;
    const valid =
      commonValid
      && validState
      && (
        terminal
          ? hasExactBudgetReservationSettlement(reservation)
          : reservation.chargedActiveMs === 0
            && reservation.refundedMs === 0
      );
    if (!valid) {
      throw new Error(`invalid control reservation ${reservation._id}`);
    }
    const ownerEntry = stopBudgetOwners.get(reservation.ownerId);
    if (
      !ownerEntry
      || matchedStopOwnerIds.has(reservation.ownerId)
      || ownerEntry.activation.jobId !== reservation.jobId
      || ownerEntry.activation.jobStopGenerationAtClaim
        !== reservation.jobStopGeneration
      || ownerEntry.activation.activationDispatchGenerationAtClaim
        !== reservation.activationDispatchGeneration
      || ownerEntry.activation.budgetReservationId !== reservation._id
      || ownerEntry.activation.hardDeadlineAt.getTime()
        !== reservation.expiresAt.getTime()
      || ownerEntry.activation.hardDeadlineAt.getTime()
        - ownerEntry.activation.workDeadlineAt.getTime()
        !== CONTROL_BUDGET_POLICY_V1.activationCommitReserveMs
      || reservation.expiresAt.getTime()
        - reservation.reservedAt.getTime()
        !== CONTROL_BUDGET_POLICY_V1.activationAllotmentMs
      || (
        reservation.state === 'EXPIRED'
        && (
          !(reservation.settledAt instanceof Date)
          || reservation.settledAt.getTime()
            < ownerEntry.activation.workDeadlineAt.getTime()
        )
      )
      || ownerEntry.payload.jobId !== reservation.jobId
      || ownerEntry.payload.jobStopGeneration
        !== reservation.jobStopGeneration
      || ownerEntry.payload.activationDispatchGeneration
        !== reservation.activationDispatchGeneration
      || ownerEntry.payload.budgetReservationId !== reservation._id
    ) {
      throw new Error(
        `invalid control reservation owner ${reservation._id}`,
      );
    }
    const owner = ownerEntry.activation;
    const ownerLifecycleValid = reservation.state === 'RESERVED'
      ? owner.lifecycle === 'PENDING' && owner.activeSlot
      : reservation.state === 'ACTIVE'
        ? (
            (owner.lifecycle === 'LEASED' || owner.lifecycle === 'RUNNING')
            && owner.activeSlot
          )
        : reservation.state === 'SETTLED'
          ? reservation.settlementReason === 'COMMITTED'
            ? owner.lifecycle === 'COMMITTED' && !owner.activeSlot
            : reservation.settlementReason === 'FAILED'
              ? owner.lifecycle === 'FAILED' && owner.activeSlot
              : (
                  (owner.lifecycle === 'ABANDONED' && !owner.activeSlot)
                  || (owner.lifecycle === 'FAILED' && owner.activeSlot)
                )
          : (
              (owner.lifecycle === 'ABANDONED' && !owner.activeSlot)
              || (owner.lifecycle === 'FAILED' && owner.activeSlot)
            );
    if (!ownerLifecycleValid) {
      throw new Error(
        `control reservation lifecycle mismatch ${reservation._id}`,
      );
    }
    matchedStopOwnerIds.add(reservation.ownerId);
    reservationJobIds.add(reservation.jobId);
    if (terminal) {
      consumedByJob.set(
        reservation.jobId,
        (consumedByJob.get(reservation.jobId) ?? 0)
          + reservation.chargedActiveMs,
      );
      if (owner.lifecycle === 'FAILED') {
        if (retainedFailedOwnerByJob.has(reservation.jobId)) {
          throw new Error(
            `multiple retained stop owners for job ${reservation.jobId}`,
          );
        }
        retainedFailedOwnerByJob.set(reservation.jobId, {
          ownerId: owner._id,
          activation: owner,
          payload: ownerEntry.payload,
        });
      }
    } else {
      if (
        liveReservationOwnerByJob.has(reservation.jobId)
      ) {
        throw new Error(
          `invalid live control reservation owner ${reservation._id}`,
        );
      }
      liveReservationOwnerByJob.set(reservation.jobId, {
        ownerId: owner._id,
        reservationState:
          reservation.state === 'RESERVED' ? 'RESERVED' : 'ACTIVE',
        activation: owner,
        payload: ownerEntry.payload,
      });
      reservedByJob.set(
        reservation.jobId,
        (reservedByJob.get(reservation.jobId) ?? 0)
          + reservation.allotmentMs,
      );
    }
  }
  for (const ownerId of stopBudgetOwners.keys()) {
    if (!matchedStopOwnerIds.has(ownerId)) {
      throw new Error(`stop control owner missing reservation ${ownerId}`);
    }
  }
  for await (const job of jobs.find(
    {},
    {
      projection: {
        _id: 1,
        activeActivationId: 1,
        activationFence: 1,
        planVersion: 1,
        jobStopGeneration: 1,
        activationDispatchGeneration: 1,
        jobControlRecoveryReservedMs: 1,
        jobControlRecoveryConsumedMs: 1,
        stopControlRecoveryAttempt: 1,
        stopControlRecoveryState: 1,
      },
    },
  )) {
    reservationJobIds.delete(job._id);
    if (
      job.jobControlRecoveryReservedMs
        !== (reservedByJob.get(job._id) ?? 0)
      || job.jobControlRecoveryConsumedMs
        !== (consumedByJob.get(job._id) ?? 0)
    ) {
      throw new Error(
        `control-budget reservation accounting mismatch for job ${job._id}`,
      );
    }
    const liveOwner = liveReservationOwnerByJob.get(job._id);
    if (
      job.jobControlRecoveryReservedMs > 0
      && (
        !liveOwner
        || job.activeActivationId !== liveOwner.ownerId
        || job.stopControlRecoveryState !== (
          liveOwner.reservationState === 'RESERVED' ? 'PENDING' : 'ACTIVE'
        )
        || job.stopControlRecoveryAttempt
          !== liveOwner.payload.recoveryAttempt
        || job.planVersion !== liveOwner.payload.planVersion
        || job.jobStopGeneration
          !== liveOwner.payload.jobStopGeneration
        || job.activationDispatchGeneration
          !== liveOwner.payload.activationDispatchGeneration
        || (
          liveOwner.reservationState === 'ACTIVE'
          && job.activationFence
            !== liveOwner.activation.activationFence
        )
      )
    ) {
      throw new Error(
        `control-budget active owner mismatch for job ${job._id}`,
      );
    }
    if (
      job.jobControlRecoveryReservedMs === 0
      && liveOwner !== undefined
    ) {
      throw new Error(
        `control-budget unexpected live owner for job ${job._id}`,
      );
    }
    if (
      liveOwner === undefined
      && (
        job.stopControlRecoveryState === 'PENDING'
        || job.stopControlRecoveryState === 'ACTIVE'
      )
    ) {
      throw new Error(
        `control-budget job state missing live owner for job ${job._id}`,
      );
    }
    const retainedFailedOwner = retainedFailedOwnerByJob.get(job._id);
    if (
      retainedFailedOwner
      && (
        liveOwner !== undefined
        || job.activeActivationId !== retainedFailedOwner.ownerId
        || job.stopControlRecoveryState !== 'EXHAUSTED'
        || job.stopControlRecoveryAttempt
          !== retainedFailedOwner.payload.recoveryAttempt
        || job.planVersion !== retainedFailedOwner.payload.planVersion
        || job.jobStopGeneration
          !== retainedFailedOwner.payload.jobStopGeneration
        || job.activationDispatchGeneration
          !== retainedFailedOwner.payload.activationDispatchGeneration
      )
    ) {
      throw new Error(
        `retained stop owner mismatch for job ${job._id}`,
      );
    }
    if (
      liveOwner === undefined
      && retainedFailedOwner === undefined
      && typeof job.activeActivationId === 'string'
      && stopBudgetOwners.has(job.activeActivationId)
    ) {
      throw new Error(
        `terminal stop owner remains active for job ${job._id}`,
      );
    }
  }
  if (reservationJobIds.size > 0) {
    throw new Error(
      `control reservation references missing job ${
        [...reservationJobIds].sort()[0]
      }`,
    );
  }

  return {
    jobsBackfilled: budgetJobResult.modifiedCount,
    activationsBackfilled: activationIdsToBackfill.length,
  };
}

/**
 * One-way bootstrap compatibility for durable PR<=36 records. This makes an
 * offline/single-version upgrade safe; a mixed N/N-1 rolling protocol remains
 * a separate rollout gate because an old writer can still create legacy BSON
 * after this pass completes.
 */
export async function backfillActivationAuthoritySchema(
  db: Db,
): Promise<{ jobsBackfilled: number; wakesBackfilled: number }> {
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const inboxItems = db.collection<JobInboxDoc>(COLLECTIONS.inbox);
  const legacyWatermarkJobs = await jobs.find(
    { inboxSchemaVersion: { $ne: 3 } },
    { projection: { _id: 1 } },
  ).toArray();
  const legacyInboxJobIds = await inboxItems.distinct('jobId', {
    $or: [
      { inboxSequence: { $exists: false } },
      { consumerVersion: { $exists: false } },
      { resolvedByActivationId: { $exists: false } },
      { resolutionCode: { $exists: false } },
      { redriveAttempt: { $exists: false } },
      { lastRedriveRequestId: { $exists: false } },
      { operatorAlertId: { $exists: false } },
      { retryTimerGeneration: { $exists: false } },
      { retryAttempt: { $exists: false } },
      { retryTimerId: { $exists: false } },
      { nextEligibleAt: { $exists: false } },
      { retryReasonCode: { $exists: false } },
    ],
  });
  const inboxJobsToMigrate = [...new Set([
    ...legacyWatermarkJobs.map((job) => job._id),
    ...legacyInboxJobIds,
  ])];
  const jobResult = await jobs.updateMany(
    {
      $or: [
        { activationDispatchGeneration: { $exists: false } },
        { jobStopGeneration: { $exists: false } },
        { pendingTerminalOutcome: { $exists: false } },
        { primaryJobStopCause: { $exists: false } },
        { secondaryJobStopCauses: { $exists: false } },
        { stopGraceDueAt: { $exists: false } },
        { controlVersion: { $exists: false } },
        { activationFence: { $exists: false } },
        { activeActivationId: { $exists: false } },
        { activationRecoveryAttempt: { $exists: false } },
        { activationRecoveryRootId: { $exists: false } },
        { activationRecoveryRootKind: { $exists: false } },
        { inboxHighWatermark: { $exists: false } },
        { appliedInboxWatermark: { $exists: false } },
        { resolvedInboxWatermark: { $exists: false } },
        { inboxSchemaVersion: { $exists: false } },
      ],
    },
    [{
      $set: {
        activationDispatchGeneration: {
          $cond: [{ $isNumber: '$activationDispatchGeneration' }, '$activationDispatchGeneration', 0],
        },
        jobStopGeneration: {
          $cond: [{ $isNumber: '$jobStopGeneration' }, '$jobStopGeneration', 0],
        },
        pendingTerminalOutcome: {
          $cond: [
            {
              $in: [
                '$pendingTerminalOutcome',
                ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNKNOWN_OUTCOME'],
              ],
            },
            '$pendingTerminalOutcome',
            null,
          ],
        },
        primaryJobStopCause: {
          $cond: [
            {
              $in: [
                '$primaryJobStopCause',
                [
                  'user_cancel', 'job_deadline', 'active_budget_exhausted',
                  'operator_stop', 'goal_satisfied', 'partial_accepted',
                  'terminal_failure', 'terminal_blocked',
                  'reconciliation_exhausted', 'unknown_outcome_accepted',
                ],
              ],
            },
            '$primaryJobStopCause',
            null,
          ],
        },
        secondaryJobStopCauses: {
          $cond: [{ $isArray: '$secondaryJobStopCauses' }, '$secondaryJobStopCauses', []],
        },
        stopGraceDueAt: {
          $cond: [{ $eq: [{ $type: '$stopGraceDueAt' }, 'date'] }, '$stopGraceDueAt', null],
        },
        controlVersion: {
          $cond: [{ $isNumber: '$controlVersion' }, '$controlVersion', 0],
        },
        activationFence: {
          $cond: [{ $isNumber: '$activationFence' }, '$activationFence', 0],
        },
        activeActivationId: {
          $cond: [{ $eq: [{ $type: '$activeActivationId' }, 'string'] }, '$activeActivationId', null],
        },
        activationRecoveryAttempt: {
          $cond: [
            { $in: ['$activationRecoveryAttempt', [0, 1, 2, 3]] },
            '$activationRecoveryAttempt',
            0,
          ],
        },
        activationRecoveryRootId: {
          $cond: [
            {
              $and: [
                { $eq: [{ $type: '$activationRecoveryRootId' }, 'string'] },
                { $ne: ['$activationRecoveryRootId', ''] },
              ],
            },
            '$activationRecoveryRootId',
            null,
          ],
        },
        activationRecoveryRootKind: {
          $cond: [
            { $in: ['$activationRecoveryRootKind', ['BUSINESS', 'RESULT_DRAIN']] },
            '$activationRecoveryRootKind',
            null,
          ],
        },
        inboxHighWatermark: {
          $cond: [{ $isNumber: '$inboxHighWatermark' }, '$inboxHighWatermark', 0],
        },
        appliedInboxWatermark: {
          $cond: [{ $isNumber: '$appliedInboxWatermark' }, '$appliedInboxWatermark', 0],
        },
        resolvedInboxWatermark: {
          $cond: [{ $isNumber: '$resolvedInboxWatermark' }, '$resolvedInboxWatermark', 0],
        },
        // `inboxSchemaVersion` is intentionally NOT set here. It is the durable
        // completion marker written only after legacy rows and job watermarks
        // are consistent; a crash anywhere earlier makes the next startup retry.
      },
    }],
  );

  // PR-32 inbox rows had no sequence. The bootstrap is explicitly an offline,
  // single-version migration: deterministically resequence legacy rows before
  // creating the unique `(jobId, inboxSequence)` index. Mixed N/N-1 writers
  // remain a rollout gate and must not run concurrently with this pass.
  for (const jobId of inboxJobsToMigrate) {
    const currentJob = await jobs.findOne({ _id: jobId });
    const rows = await inboxItems.find({ jobId }).sort({ createdAt: 1, _id: 1 }).toArray();
    const sortedSequences = rows
      .map((row) => row.inboxSequence)
      .filter((sequence): sequence is number => Number.isInteger(sequence))
      .sort((left, right) => left - right);
    const denseAndUnique =
      sortedSequences.length === rows.length
      && sortedSequences.every(
      (sequence, index) => Number.isInteger(sequence) && sequence === index + 1,
    );
    const legacyRetry = rows.find((row) => row.state === 'FAILED_RETRYABLE');
    if (legacyRetry) {
      // PR<=34 never emitted FAILED_RETRYABLE. Silently stamping a legacy row
      // (even one that merely looks complete locally) cannot prove the matching
      // timer authority and could create an unrecoverable watermark gap.
      throw new Error(
        `legacy FAILED_RETRYABLE inbox row ${legacyRetry._id} requires explicit repair`,
      );
    }
    if (rows.length > 0) {
      await inboxItems.bulkWrite(rows.map((row, index) => {
        const inboxSequence = denseAndUnique ? row.inboxSequence : index + 1;
        const resolvedByActivationId =
          row.resolvedByActivationId
          ?? row.appliedByActivationId
          ?? (
            (row.state === 'APPLIED' || row.state === 'REJECTED_STALE')
            && row.resolvedAt !== null
              ? 'migration:pr33'
              : null
          );
        const resolutionCode =
          row.resolutionCode
          ?? (row.state === 'APPLIED'
            ? 'applied_result'
            : row.state === 'REJECTED_STALE' && row.resolvedAt !== null
              ? 'legacy_rejected_stale'
              : null);
        const rawConsumerVersion = row.consumerVersion as unknown;
        if (
          rawConsumerVersion !== undefined
          && (
            !Number.isInteger(rawConsumerVersion)
            || (rawConsumerVersion as number) < 0
          )
        ) {
          throw new Error(`invalid legacy consumerVersion for inbox row ${row._id}`);
        }
        const consumerVersion = rawConsumerVersion === undefined
          ? 1
          : rawConsumerVersion as number;
        const rawRedriveAttempt = row.redriveAttempt as unknown;
        if (
          rawRedriveAttempt !== undefined
          && (
            !Number.isInteger(rawRedriveAttempt)
            || (rawRedriveAttempt as number) < 0
          )
        ) {
          throw new Error(`invalid legacy redriveAttempt for inbox row ${row._id}`);
        }
        const redriveAttempt = rawRedriveAttempt === undefined
          ? 0
          : rawRedriveAttempt as number;
        const lastRedriveRequestId =
          typeof row.lastRedriveRequestId === 'string'
            ? row.lastRedriveRequestId
            : null;
        const operatorAlertId =
          typeof row.operatorAlertId === 'string'
            ? row.operatorAlertId
            : null;
        const rawRetryTimerGeneration = row.retryTimerGeneration as unknown;
        if (
          rawRetryTimerGeneration !== undefined
          && (
            !Number.isInteger(rawRetryTimerGeneration)
            || (rawRetryTimerGeneration as number) < 0
          )
        ) {
          throw new Error(`invalid legacy retryTimerGeneration for inbox row ${row._id}`);
        }
        const retryTimerGeneration = rawRetryTimerGeneration === undefined
          ? 0
          : rawRetryTimerGeneration as number;
        const rawRetryAttempt = row.retryAttempt as unknown;
        if (
          rawRetryAttempt !== undefined
          && (
            !Number.isInteger(rawRetryAttempt)
            || (rawRetryAttempt as number) < 0
          )
        ) {
          throw new Error(`invalid legacy retryAttempt for inbox row ${row._id}`);
        }
        const retryAttempt = rawRetryAttempt === undefined
          ? 0
          : rawRetryAttempt as number;
        const retryTimerId =
          typeof row.retryTimerId === 'string'
            ? row.retryTimerId
            : null;
        const nextEligibleAt =
          row.nextEligibleAt instanceof Date
            ? row.nextEligibleAt
            : null;
        const retryReasonCode =
          typeof row.retryReasonCode === 'string'
            ? row.retryReasonCode
            : null;
        row.inboxSequence = inboxSequence;
        row.consumerVersion = consumerVersion;
        row.resolvedByActivationId = resolvedByActivationId;
        row.resolutionCode = resolutionCode;
        row.redriveAttempt = redriveAttempt;
        row.lastRedriveRequestId = lastRedriveRequestId;
        row.operatorAlertId = operatorAlertId;
        row.retryTimerGeneration = retryTimerGeneration;
        row.retryAttempt = retryAttempt;
        row.retryTimerId = retryTimerId;
        row.nextEligibleAt = nextEligibleAt;
        row.retryReasonCode = retryReasonCode;
        return {
        updateOne: {
          filter: { _id: row._id, jobId },
          update: {
            $set: {
              inboxSequence,
              consumerVersion,
              resolvedByActivationId,
              resolutionCode,
              redriveAttempt,
              lastRedriveRequestId,
              operatorAlertId,
              retryTimerGeneration,
              retryAttempt,
              retryTimerId,
              nextEligibleAt,
              retryReasonCode,
            },
          },
        },
      };
      }));
    }

    const highestSequence = rows.reduce(
      (maximum, row) => Math.max(maximum, row.inboxSequence ?? 0),
      0,
    );
    const high = denseAndUnique
      ? Math.max(currentJob?.inboxHighWatermark ?? 0, highestSequence)
      : rows.length;
    let appliedFromRows = 0;
    let resolvedFromRows = 0;
    const rowsBySequence = [...rows].sort(
      (left, right) => left.inboxSequence - right.inboxSequence,
    );
    for (const row of rowsBySequence) {
      if (row.state === 'APPLIED') {
        appliedFromRows = Math.max(appliedFromRows, row.inboxSequence);
      }
      if (
        row.inboxSequence === resolvedFromRows + 1
        && (
          (
            row.state === 'APPLIED'
            && row.resolvedAt !== null
            && row.appliedByActivationId !== null
            && row.resolvedByActivationId !== null
            && row.resolutionCode === 'applied_result'
          )
          || (
            row.state === 'REJECTED_STALE'
            && row.resolvedAt !== null
            && row.resolvedByActivationId !== null
            && (
              row.resolutionCode === 'stale_plan'
              || row.resolutionCode === 'stale_task_result'
              || row.resolutionCode === 'legacy_rejected_stale'
              || row.resolutionCode === 'job_cancelled'
            )
          )
          || (
            row.state === 'QUARANTINED_UNSUPPORTED'
            && row.resolvedAt !== null
            && row.resolvedByActivationId !== null
            && row.operatorAlertId !== null
            && (
              row.resolutionCode === 'unsupported_inbox_kind'
              || row.resolutionCode === 'unsupported_consumer_version'
              || row.resolutionCode === 'transient_retry_exhausted'
            )
          )
        )
      ) {
        resolvedFromRows = row.inboxSequence;
      }
    }
    const applied = Math.min(
      high,
      Math.max(currentJob?.appliedInboxWatermark ?? 0, appliedFromRows),
    );
    const resolved = Math.min(
      high,
      denseAndUnique
        ? Math.max(currentJob?.resolvedInboxWatermark ?? 0, resolvedFromRows)
        : resolvedFromRows,
    );
    const migrated = await jobs.updateOne(
      {
        _id: jobId,
        stateVersion: currentJob?.stateVersion,
        inboxHighWatermark: currentJob?.inboxHighWatermark ?? 0,
        appliedInboxWatermark: currentJob?.appliedInboxWatermark ?? 0,
        resolvedInboxWatermark: currentJob?.resolvedInboxWatermark ?? 0,
      },
      {
        $set: {
          inboxHighWatermark: high,
          appliedInboxWatermark: applied,
          resolvedInboxWatermark: resolved,
          inboxSchemaVersion: 3,
        },
      },
    );
    if (currentJob && migrated.modifiedCount !== 1 && migrated.matchedCount !== 1) {
      throw new Error(`offline inbox watermark migration raced a writer for job ${jobId}`);
    }
  }

  const timers = db.collection<TimerDoc>(COLLECTIONS.timers);
  await timers.updateMany(
    {
      $or: [
        { generation: { $exists: false } },
        { sourceRedriveAttempt: { $exists: false } },
        { firedAt: { $exists: false } },
        { wakeId: { $exists: false } },
      ],
    },
    [{
      $set: {
        generation: {
          $cond: [{ $isNumber: '$generation' }, '$generation', 0],
        },
        sourceRedriveAttempt: {
          $cond: [{ $isNumber: '$sourceRedriveAttempt' }, '$sourceRedriveAttempt', null],
        },
        firedAt: {
          $cond: [{ $eq: [{ $type: '$firedAt' }, 'date'] }, '$firedAt', null],
        },
        wakeId: {
          $cond: [{ $eq: [{ $type: '$wakeId' }, 'string'] }, '$wakeId', null],
        },
      },
    }],
  );

  const activations = db.collection<LaneActivationDoc>(COLLECTIONS.activations);
  const legacyActivations = activations.find({
    $or: [
      { batchInboxItemIds: { $exists: false } },
      { batchThroughWatermark: { $exists: false } },
      { inboxHighWatermarkAtClaim: { $exists: false } },
      { appliedInboxWatermarkAtClaim: { $exists: false } },
      { resolvedInboxWatermarkAtClaim: { $exists: false } },
      { committedAppliedInboxWatermark: { $exists: false } },
      { committedResolvedInboxWatermark: { $exists: false } },
      { successorWakeId: { $exists: false } },
    ],
  });
  for await (const activation of legacyActivations) {
    const legacyPayload = activation.reducerPayload;
    const legacyInboxItemId =
      legacyPayload?.kind === 'APPLY_ATTEMPT_RESULT_V1'
      && typeof legacyPayload.inboxItemId === 'string'
        ? legacyPayload.inboxItemId
        : null;
    // Recover the immutable one-item identity from the legacy reducer payload
    // when a partially backfilled PR-32 record lacks its explicit batch array.
    // This must happen before loading the row so payload translation can resume.
    const batchIds =
      Array.isArray(activation.batchInboxItemIds)
      && activation.batchInboxItemIds.length > 0
        ? activation.batchInboxItemIds
        : legacyInboxItemId
          ? [legacyInboxItemId]
          : [];
    const [job, batch] = await Promise.all([
      jobs.findOne({ _id: activation.jobId }),
      batchIds.length === 0
        ? Promise.resolve([])
        : inboxItems.find({ _id: { $in: batchIds }, jobId: activation.jobId }).toArray(),
    ]);
    const batchThroughWatermark = batch.reduce(
      (maximum, item) => Math.max(maximum, item.inboxSequence ?? 0),
      0,
    );
    const committed = activation.lifecycle === 'COMMITTED';
    const legacyInboxItem = legacyInboxItemId
      ? batch.find((item) => item._id === legacyInboxItemId)
      : null;
    const translatedPayload =
      legacyPayload?.kind === 'APPLY_ATTEMPT_RESULT_V1'
      && legacyInboxItem
      && typeof legacyPayload.jobId === 'string'
      && typeof legacyPayload.planVersion === 'number'
        ? {
            kind: 'DRAIN_RESULT_INBOX_BATCH_V1',
            jobId: legacyPayload.jobId,
            planVersion: legacyPayload.planVersion,
            batchThroughWatermark: legacyInboxItem.inboxSequence,
            decisions: [{
              ...legacyPayload,
              inboxSequence: legacyInboxItem.inboxSequence,
            }],
          }
        : null;
    await activations.updateOne(
      { _id: activation._id },
      {
        $set: {
          batchInboxItemIds: batchIds,
          batchThroughWatermark,
          // Never snapshot ingress beyond the immutable legacy batch.
          inboxHighWatermarkAtClaim: batchThroughWatermark,
          appliedInboxWatermarkAtClaim: Math.min(
            job?.appliedInboxWatermark ?? 0,
            batchThroughWatermark,
          ),
          resolvedInboxWatermarkAtClaim: Math.min(
            job?.resolvedInboxWatermark ?? 0,
            batchThroughWatermark,
          ),
          committedAppliedInboxWatermark: committed
            ? Math.min(job?.appliedInboxWatermark ?? 0, batchThroughWatermark)
            : null,
          committedResolvedInboxWatermark: committed
            ? Math.min(job?.resolvedInboxWatermark ?? 0, batchThroughWatermark)
            : null,
          successorWakeId: null,
          ...(translatedPayload
            ? {
                reducerPayload: translatedPayload,
                ...(committed
                  ? { committedPayloadHash: canonicalHash(translatedPayload) }
                  : {}),
              }
            : {}),
        },
      },
    );
  }

  let wakesBackfilled = 0;
  const wakes = db.collection<OutboxDoc>(COLLECTIONS.outbox).find({
    type: 'LaneWakeRequested',
    state: 'PENDING',
  });
  for await (const wake of wakes) {
    const rawPayload = wake.payload as unknown;
    const existingGeneration =
      rawPayload !== null && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>).activationDispatchGeneration
        : undefined;
    if (typeof existingGeneration === 'number' && Number.isInteger(existingGeneration)) {
      continue;
    }

    const safePayload =
      rawPayload !== null && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        ? rawPayload as Record<string, unknown>
        : {};
    const repaired = await db.collection<OutboxDoc>(COLLECTIONS.outbox).updateOne(
      {
        _id: wake._id,
        state: 'PENDING',
        $or: [
          { 'payload.activationDispatchGeneration': { $exists: false } },
          { 'payload.activationDispatchGeneration': { $not: { $type: 'number' } } },
        ],
      },
      {
        $set: {
          payload: {
            ...safePayload,
            // Legacy writers had no generation. Their only sound authority is
            // generation zero; copying a later job generation here could
            // promote a stale wake during concurrent startup/control.
            activationDispatchGeneration: 0,
          },
        },
      },
    );
    wakesBackfilled += repaired.modifiedCount;
  }

  await db.collection<TaskDoc>(COLLECTIONS.tasks).updateMany(
    { stopGeneration: { $exists: false } },
    { $set: { stopGeneration: 0 } },
  );
  await db.collection<AttemptDoc>(COLLECTIONS.attempts).updateMany(
    {
      $or: [
        { jobStopGenerationAtDispatch: { $exists: false } },
        { taskStopGenerationAtDispatch: { $exists: false } },
        { stopGeneration: { $exists: false } },
        { primaryAttemptStopCause: { $exists: false } },
        { secondaryAttemptStopCauses: { $exists: false } },
        { attemptStopGraceDueAt: { $exists: false } },
        { attemptStopTimerGeneration: { $exists: false } },
        { jobStopGenerationAtStop: { $exists: false } },
        { processOwner: { $exists: false } },
        { processState: { $exists: false } },
        { terminationConfirmed: { $exists: false } },
        { stopReceipt: { $exists: false } },
        { processExitReceipt: { $exists: false } },
        { processWorkloadReleasedAt: { $exists: false } },
        { processSignalStage: { $exists: false } },
        { processStopObservedAt: { $exists: false } },
        { processAbortSentAt: { $exists: false } },
        { processTermSentAt: { $exists: false } },
        { processKillSentAt: { $exists: false } },
        { processTreeEmptyAt: { $exists: false } },
      ],
    },
    [{
      $set: {
        jobStopGenerationAtDispatch: {
          $cond: [{ $isNumber: '$jobStopGenerationAtDispatch' }, '$jobStopGenerationAtDispatch', 0],
        },
        taskStopGenerationAtDispatch: {
          $cond: [{ $isNumber: '$taskStopGenerationAtDispatch' }, '$taskStopGenerationAtDispatch', 0],
        },
        stopGeneration: {
          $cond: [{ $isNumber: '$stopGeneration' }, '$stopGeneration', 0],
        },
        primaryAttemptStopCause: {
          $cond: [
            { $eq: [{ $type: '$primaryAttemptStopCause' }, 'string'] },
            '$primaryAttemptStopCause',
            null,
          ],
        },
        secondaryAttemptStopCauses: {
          $cond: [{ $isArray: '$secondaryAttemptStopCauses' }, '$secondaryAttemptStopCauses', []],
        },
        attemptStopGraceDueAt: {
          $cond: [
            { $eq: [{ $type: '$attemptStopGraceDueAt' }, 'date'] },
            '$attemptStopGraceDueAt',
            null,
          ],
        },
        attemptStopTimerGeneration: {
          $cond: [{ $isNumber: '$attemptStopTimerGeneration' }, '$attemptStopTimerGeneration', 0],
        },
        jobStopGenerationAtStop: {
          $cond: [{ $isNumber: '$jobStopGenerationAtStop' }, '$jobStopGenerationAtStop', null],
        },
        processOwner: {
          $cond: [{ $eq: [{ $type: '$processOwner' }, 'object'] }, '$processOwner', null],
        },
        processState: {
          $cond: [
            { $in: ['$processState', ['NONE', 'OWNED', 'STOP_REQUESTED', 'EXITED', 'UNKNOWN']] },
            '$processState',
            {
              $cond: [
                { $eq: ['$lifecycle', 'FINISHED'] },
                'EXITED',
                { $cond: [{ $eq: ['$lifecycle', 'RUNNING'] }, 'UNKNOWN', 'NONE'] },
              ],
            },
          ],
        },
        terminationConfirmed: {
          $cond: [
            { $eq: [{ $type: '$terminationConfirmed' }, 'bool'] },
            '$terminationConfirmed',
            null,
          ],
        },
        stopReceipt: {
          $cond: [{ $eq: [{ $type: '$stopReceipt' }, 'object'] }, '$stopReceipt', null],
        },
        processExitReceipt: {
          $cond: [
            { $eq: [{ $type: '$processExitReceipt' }, 'object'] },
            '$processExitReceipt',
            null,
          ],
        },
        processWorkloadReleasedAt: {
          $cond: [
            { $eq: [{ $type: '$processWorkloadReleasedAt' }, 'date'] },
            '$processWorkloadReleasedAt',
            null,
          ],
        },
        processSignalStage: {
          $cond: [
            {
              $in: [
                '$processSignalStage',
                ['NONE', 'OBSERVED', 'ABORT_SENT', 'TERM_SENT', 'KILL_SENT', 'TREE_EMPTY'],
              ],
            },
            '$processSignalStage',
            'NONE',
          ],
        },
        processStopObservedAt: {
          $cond: [
            { $eq: [{ $type: '$processStopObservedAt' }, 'date'] },
            '$processStopObservedAt',
            null,
          ],
        },
        processAbortSentAt: {
          $cond: [
            { $eq: [{ $type: '$processAbortSentAt' }, 'date'] },
            '$processAbortSentAt',
            null,
          ],
        },
        processTermSentAt: {
          $cond: [
            { $eq: [{ $type: '$processTermSentAt' }, 'date'] },
            '$processTermSentAt',
            null,
          ],
        },
        processKillSentAt: {
          $cond: [
            { $eq: [{ $type: '$processKillSentAt' }, 'date'] },
            '$processKillSentAt',
            null,
          ],
        },
        processTreeEmptyAt: {
          $cond: [
            { $eq: [{ $type: '$processTreeEmptyAt' }, 'date'] },
            '$processTreeEmptyAt',
            null,
          ],
        },
      },
    }],
  );

  return { jobsBackfilled: jobResult.modifiedCount, wakesBackfilled };
}

/**
 * Bootstrap the additive schema, then create its unique indexes. Idempotent
 * (Mongo no-ops when both records and indexes are already current).
 */
export async function ensureOrchestrationIndexes(db: Db): Promise<void> {
  await backfillControlBudgetSchema(db);
  await backfillActivationAuthoritySchema(db);
  await Promise.all([
    db.collection(COLLECTIONS.commands).createIndex({ resourceId: 1, commandId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.jobs).createIndex({ resourceId: 1, updatedAt: -1 }),
    db.collection(COLLECTIONS.jobs).createIndex({ conversationId: 1, updatedAt: -1 }),
    db.collection(COLLECTIONS.jobs).createIndex({
      terminalOutcome: 1,
      controlState: 1,
      terminalBarrierMode: 1,
      terminalBarrierNextCheckAt: 1,
      updatedAt: 1,
    }),
    db.collection(COLLECTIONS.jobs).createIndex({
      terminalOutcome: 1,
      controlState: 1,
      stopControlRecoveryState: 1,
      terminalBarrierNextCheckAt: 1,
      updatedAt: 1,
      _id: 1,
    }),
    db.collection(COLLECTIONS.events).createIndex({ jobId: 1, sequence: 1 }, { unique: true }),
    db.collection(COLLECTIONS.outbox).createIndex({ state: 1, createdAt: 1 }),
    db.collection(COLLECTIONS.outbox).createIndex({ aggregate: 1, createdAt: 1 }),
    db.collection(COLLECTIONS.tasks).createIndex({ jobId: 1 }),
    db.collection(COLLECTIONS.attempts).createIndex({ taskId: 1, lifecycle: 1 }),
    db.collection(COLLECTIONS.attempts).createIndex({ jobId: 1 }),
    // worker selection: ordered QUEUED candidates before authority lookups
    db.collection(COLLECTIONS.attempts).createIndex({ lifecycle: 1, createdAt: 1, _id: 1 }),
    // recovery reducer: QUEUED attempts whose business admission expired
    db.collection(COLLECTIONS.attempts).createIndex({ lifecycle: 1, businessOperationCutoffAt: 1 }),
    // reaper scan: active attempts by lease expiry
    db.collection(COLLECTIONS.attempts).createIndex({ lifecycle: 1, leaseExpiresAt: 1 }),
    // PROCESS_STOP_V1: exact supervised run identity and bounded grace scan.
    db.collection(COLLECTIONS.attempts).createIndex(
      { 'processOwner.processExecutionId': 1 },
      {
        unique: true,
        partialFilterExpression: { 'processOwner.processExecutionId': { $type: 'string' } },
      },
    ),
    db.collection(COLLECTIONS.attempts).createIndex(
      { lifecycle: 1, attemptStopGraceDueAt: 1, attemptStopTimerGeneration: 1 },
    ),
    // PROCESS_SUPERVISOR_V1 startup/recovery scan.
    db.collection(COLLECTIONS.attempts).createIndex({
      'processOwner.mode': 1,
      terminationConfirmed: 1,
      lifecycle: 1,
      processReconcileNextAt: 1,
      updatedAt: 1,
    }),
    db.collection(COLLECTIONS.activations).createIndex(
      { jobId: 1, activeSlot: 1 },
      { unique: true, partialFilterExpression: { activeSlot: true } },
    ),
    db.collection(COLLECTIONS.activations).createIndex({ lifecycle: 1, leaseExpiresAt: 1, hardDeadlineAt: 1 }),
    db.collection(COLLECTIONS.activations).createIndex({ jobId: 1, createdAt: 1 }),
    db.collection(COLLECTIONS.activations).createIndex(
      { sourceWakeId: 1 },
      { unique: true, partialFilterExpression: { sourceWakeId: { $type: 'string' } } },
    ),
    db.collection(COLLECTIONS.activations).createIndex(
      { budgetReservationId: 1 },
      {
        unique: true,
        partialFilterExpression: { budgetReservationId: { $type: 'string' } },
      },
    ),
    db.collection(COLLECTIONS.budgetReservations).createIndex(
      { ownerKind: 1, ownerId: 1, pool: 1 },
      { unique: true },
    ),
    db.collection(COLLECTIONS.budgetReservations).createIndex(
      { jobId: 1, jobStopGeneration: 1, pool: 1, state: 1 },
    ),
    db.collection(COLLECTIONS.budgetReservations).createIndex(
      { state: 1, expiresAt: 1, _id: 1 },
    ),
    db.collection(COLLECTIONS.results).createIndex({ attemptId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.inbox).createIndex({ jobId: 1, state: 1, inboxSequence: 1 }),
    db.collection(COLLECTIONS.inbox).createIndex({ jobId: 1, inboxSequence: 1 }, { unique: true }),
    db.collection(COLLECTIONS.inbox).createIndex({ jobId: 1, resultId: 1 }, { unique: true }),
    // timer scan: due PENDING timers by fire time
    db.collection(COLLECTIONS.timers).createIndex({ state: 1, fireAt: 1 }),
    db.collection(COLLECTIONS.timers).createIndex({ kind: 1, state: 1, fireAt: 1, _id: 1 }),
    db.collection(COLLECTIONS.timers).createIndex({ entityId: 1, kind: 1 }),
    db.collection(COLLECTIONS.timers).createIndex(
      { kind: 1, entityId: 1, generation: 1 },
      {
        unique: true,
        partialFilterExpression: { kind: 'inbox_result_retry' },
      },
    ),
    db.collection(COLLECTIONS.requests).createIndex({ jobId: 1, state: 1 }),
    // expiry scan: open requests by deadline
    db.collection(COLLECTIONS.requests).createIndex({ state: 1, expiresAt: 1 }),
    db.collection(COLLECTIONS.edges).createIndex({ parentTaskId: 1 }),
    db.collection(COLLECTIONS.edges).createIndex({ jobId: 1 }),
    // C boundary: read model by conversation order + transport scan.
    db.collection(COLLECTIONS.projections).createIndex({ conversationId: 1, sequence: 1 }, { unique: true }),
    db.collection(COLLECTIONS.deliveries).createIndex({ state: 1, createdAt: 1 }),
    db.collection(COLLECTIONS.deliveries).createIndex({ conversationId: 1, sequence: 1 }),
  ]);
}
