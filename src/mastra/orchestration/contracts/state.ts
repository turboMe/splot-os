/**
 * Canonical state models for the durable orchestration substrate (V2).
 *
 * Maps 1:1 onto plan §7. The design deliberately splits the overloaded legacy
 * `status` field into orthogonal axes: business `phase`, control `intent`,
 * terminal `outcome`, and short lease/activation lifecycle. A lease-level
 * `RUNNING` is never persisted as a business status of the whole job (§7.1).
 *
 * Pure `as const` tuples + derived union types — no zod, so this module is cheap
 * to import everywhere. The schema layer (result-envelope.ts) builds zod enums
 * from these tuples.
 */

// --- Job -------------------------------------------------------------------

export const JOB_PHASES = [
  'ACCEPTED', 'READY', 'PLANNING', 'DISPATCHING', 'AWAITING_RESULTS',
  'REVIEWING', 'WAITING_RETRY', 'REPLANNING', 'AWAITING_USER',
  'AWAITING_APPROVAL', 'AWAITING_EXTERNAL', 'RECONCILING', 'SYNTHESIZING',
  'PAUSED', 'TERMINAL',
] as const;
export type JobPhase = (typeof JOB_PHASES)[number];

export const JOB_CONTROL_STATES = ['NONE', 'PAUSE_REQUESTED', 'STOP_REQUESTED'] as const;
export type JobControlState = (typeof JOB_CONTROL_STATES)[number];

export const JOB_TERMINAL_OUTCOMES = [
  'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED',
  'TIMED_OUT', 'CANCELLED', 'UNKNOWN_OUTCOME',
] as const;
export type JobTerminalOutcome = (typeof JOB_TERMINAL_OUTCOMES)[number];

/** The single terminal barrier cause that wins the first stop CAS (§7.1). */
export const PRIMARY_JOB_STOP_CAUSES = [
  'user_cancel', 'job_deadline', 'active_budget_exhausted', 'operator_stop',
  'goal_satisfied', 'partial_accepted', 'terminal_failure', 'terminal_blocked',
  'reconciliation_exhausted', 'unknown_outcome_accepted',
] as const;
export type PrimaryJobStopCause = (typeof PRIMARY_JOB_STOP_CAUSES)[number];

/** Typed suspension reasons — manual pause and awaits can overlap (§7.1). */
export const SUSPENSION_KINDS = [
  'MANUAL_PAUSE', 'AWAITING_USER', 'AWAITING_APPROVAL', 'AWAITING_EXTERNAL',
] as const;
export type SuspensionKind = (typeof SUSPENSION_KINDS)[number];

// --- Task ------------------------------------------------------------------

export const TASK_PHASES = [
  'PLANNED', 'READY', 'DISPATCHED', 'AWAITING_RESULT', 'DRAINING_SPECULATION',
  'SUCCEEDED', 'PARTIAL', 'WAITING_INPUT', 'WAITING_DEPENDENCY', 'RECONCILING',
  'RETRY_PENDING', 'SUPERSEDED', 'FAILED', 'BLOCKED', 'TIMED_OUT', 'CANCELLED',
  'UNKNOWN_OUTCOME',
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const TASK_CONTROL_STATES = ['NONE', 'STOP_REQUESTED'] as const;
export type TaskControlState = (typeof TASK_CONTROL_STATES)[number];

export const ATTEMPT_MODES = ['SERIAL', 'SPECULATIVE'] as const;
export type AttemptMode = (typeof ATTEMPT_MODES)[number];

// --- Attempt & lease -------------------------------------------------------

export const ATTEMPT_LIFECYCLES = [
  'CREATED', 'QUEUED', 'LEASED', 'RUNNING', 'STOP_REQUESTED',
  'EVIDENCE_ONLY', 'FINISHED',
] as const;
export type AttemptLifecycle = (typeof ATTEMPT_LIFECYCLES)[number];

export const ATTEMPT_OUTCOMES = [
  'OK', 'PARTIAL', 'BLOCKED', 'FAILED', 'TIMED_OUT', 'CANCELLED',
  'UNKNOWN_OUTCOME', 'WORKER_LOST',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Discriminated union of attempt stop causes (§7.3). Normative mapping table. */
export const PRIMARY_ATTEMPT_STOP_CAUSES = [
  'completed', 'attempt_deadline', 'task_deadline', 'job_deadline',
  'active_budget_exhausted', 'queue_expired', 'capacity_expired', 'user_cancel',
  'pause_interrupt', 'manual_interrupt', 'operator_stop', 'plan_superseded',
  'speculation_lost', 'job_terminalizing', 'lease_lost', 'worker_shutdown',
  'provider_error',
] as const;
export type PrimaryAttemptStopCause = (typeof PRIMARY_ATTEMPT_STOP_CAUSES)[number];

// --- Command ---------------------------------------------------------------

export const COMMAND_STATES = ['RECEIVED', 'VALIDATED', 'APPLIED', 'REJECTED', 'PENDING_APPLY'] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

// --- Event / inbox / outbox / delivery -------------------------------------

export const INBOX_STATES = [
  'RECEIVED', 'DEDUPED', 'APPLIED', 'REJECTED_STALE',
  'QUARANTINED_UNSUPPORTED', 'FAILED_RETRYABLE', 'PENDING_REDRIVE',
] as const;
export type InboxState = (typeof INBOX_STATES)[number];

// PUBLISHED = an internal wake was consumed; DELIVERED = a projectable domain
// event was applied to a conversation by the C boundary (Conversation Writer).
export const OUTBOX_STATES = ['PENDING', 'CLAIMED', 'PUBLISHED', 'DELIVERED'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export const DELIVERY_STATES = ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'EXPIRED'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

// --- Lane activation -------------------------------------------------------

export const ACTIVATION_LIFECYCLES = [
  'PENDING', 'LEASED', 'RUNNING', 'COMMITTED', 'FAILED', 'ABANDONED',
] as const;
export type ActivationLifecycle = (typeof ACTIVATION_LIFECYCLES)[number];

export const ACTIVATION_KINDS = ['BUSINESS', 'RESULT_DRAIN', 'FINAL_DECISION', 'CONTROL_RECOVERY'] as const;
export type ActivationKind = (typeof ACTIVATION_KINDS)[number];

// --- Dispatch edge ---------------------------------------------------------

export const EDGE_LIFECYCLES = [
  'PROPOSED', 'ACCEPTED', 'ACTIVE', 'CANCEL_REQUESTED',
  'TERMINAL_CONFIRMED', 'SETTLED', 'ABORTED', 'UNKNOWN',
] as const;
export type EdgeLifecycle = (typeof EDGE_LIFECYCLES)[number];

export const EDGE_CONTROL_STATES = ['NONE', 'PAUSE_REQUESTED', 'PAUSED', 'STOP_REQUESTED'] as const;
export type EdgeControlState = (typeof EDGE_CONTROL_STATES)[number];

export const JOB_RELATION_MODES = ['ATTACHED', 'DETACHED'] as const;
export type JobRelationMode = (typeof JOB_RELATION_MODES)[number];

export const EDGE_COMPLETION_MODES = ['REQUIRED', 'OPTIONAL_SPECULATIVE'] as const;
export type EdgeCompletionMode = (typeof EDGE_COMPLETION_MODES)[number];

// --- Side-effect ledger ----------------------------------------------------

export const EFFECT_STATES = [
  'RESERVED', 'DISPATCHING', 'COMMITTED', 'ABORTED', 'UNKNOWN',
  'RECONCILING', 'RESOLVED_COMMITTED', 'RESOLVED_NOT_COMMITTED', 'MANUAL',
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

export const EFFECT_CLASSES = [
  'pure', 'read', 'idempotent_write', 'non_idempotent_write', 'destructive',
] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

// --- Execution routing (§13.1) --------------------------------------------

export const EXECUTION_CLASSES = [
  'front_only', 'bounded_query', 'background_job', 'hybrid',
  'lane_internal', 'maintenance',
] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];
