/**
 * ExecutionBudget contract for the durable orchestration substrate (§10).
 *
 * A budget separates three protected absolute deadlines of a single attempt and
 * the reserves between them, so that the result-commit window and the stop/clean
 * window are never spent doing new business work (plan §10.1). This module is the
 * pure contract + derivation math; AbortSignal composition and store timers are
 * wired later (Fala 2 / Fala 3). No runtime side effects here.
 */

/** Which timing domain an operation belongs to (§10). Informational + policy. */
export const OPERATION_TYPES = [
  'front_request', 'accept_enqueue', 'orchestration_activation',
  'attempt_work', 'operation', 'model_call', 'tool_call', 'poll', 'process',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

/** Step/progress policy (§10.1). `maxStepsWithoutProgress` must leave a recovery reserve. */
export interface StepProgressPolicy {
  readonly maxSteps: number;
  readonly maxStepsWithoutProgress: number;
  readonly recoveryReserveSteps: number;
}

/**
 * A bounded attempt window that may grow only after durable progress.
 *
 * The policy is frozen with the task plan. The model never supplies these
 * values, and a retry/restart therefore uses the same limits as the first try.
 */
export interface ProgressiveAttemptPolicy {
  /** Initially available wall-clock window, including the normal A/cleanup reserves. */
  readonly initialWindowMs: number;
  /** Amount added to all three earned deadlines by one accepted milestone. */
  readonly extensionMs: number;
  /** Only milestones this close to the business cutoff may earn time. */
  readonly extensionLeadMs: number;
  /** Immutable absolute ceiling, including every extension and reserve. */
  readonly maxCapMs: number;
  /** Independent bound on accepted milestone receipts. */
  readonly maxExtensions: number;
}

/** Stable evidence identity produced by a trusted tool-result classifier. */
export interface AttemptProgressMilestone {
  readonly fingerprint: string;
  readonly kind: string;
}

export type AttemptProgressRejectReason =
  | 'disabled'
  | 'closed'
  | 'stale_authority_or_cutoff'
  | 'too_early'
  | 'duplicate'
  | 'control_frozen'
  | 'extension_limit'
  | 'absolute_cap';

/** Authoritative store response used to re-arm process-local watchdogs. */
export interface AttemptProgressDecision {
  readonly accepted: boolean;
  readonly businessOperationCutoffAt: number;
  readonly workDeadlineAt: number;
  readonly hardDeadlineAt: number;
  readonly absoluteHardDeadlineAt: number;
  readonly extensionCount: number;
  readonly reason?: AttemptProgressRejectReason;
}

/** Strict validation shared by plan admission and attempt dispatch. */
export function isProgressiveAttemptPolicy(
  value: unknown,
  maxCapLimitMs = 3_600_000,
): value is ProgressiveAttemptPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Partial<ProgressiveAttemptPolicy>;
  const integers = [
    policy.initialWindowMs,
    policy.extensionMs,
    policy.extensionLeadMs,
    policy.maxCapMs,
    policy.maxExtensions,
  ];
  if (integers.some((entry) => !Number.isInteger(entry))) return false;
  const initial = policy.initialWindowMs!;
  const extension = policy.extensionMs!;
  const lead = policy.extensionLeadMs!;
  const max = policy.maxCapMs!;
  const count = policy.maxExtensions!;
  return initial > 0
    && extension > 0
    && lead > 0
    && lead >= extension
    && max >= initial
    && max <= maxCapLimitMs
    && count >= 0
    && count <= 100
    && initial + extension * count >= max;
}

/**
 * Immutable execution budget handed to every active operation (§10.1).
 * `AbortSignal` is modelled optionally so the pure contract compiles without a
 * runtime; the gateway supplies a real composed signal in Fala 2.
 */
export interface ExecutionBudget {
  readonly budgetId: string;
  readonly operationType: OperationType;
  readonly startedAt: number;

  /** Three protected absolute deadlines (epoch ms), business ⊆ work ⊆ hard. */
  readonly businessOperationCutoffAt: number;
  readonly workDeadlineAt: number;
  readonly hardDeadlineAt: number;

  /** Reserves carved out of the hard deadline. */
  readonly reserveForFinalizeMs: number;
  readonly resultCommitReserveMs: number;

  readonly parentBudgetId: string | null;
  readonly stepProgress: StepProgressPolicy;

  /** Caps (0 = unset/inherit). */
  readonly maxToolCalls: number;
  readonly maxRetries: number;
  readonly maxFanOut: number;
  readonly maxItems: number;
  readonly maxCostUsd: number;

  readonly signal?: AbortSignal;
}

/** Remaining ms against each deadline, measured from a monotonic-derived `now`. */
export function remainingBusinessMs(b: ExecutionBudget, now: number): number {
  return b.businessOperationCutoffAt - now;
}
export function remainingWorkMs(b: ExecutionBudget, now: number): number {
  return b.workDeadlineAt - now;
}
export function remainingHardMs(b: ExecutionBudget, now: number): number {
  return b.hardDeadlineAt - now;
}

/**
 * Derive the two inner deadlines from the single absolute `hardDeadlineAt` and
 * the two reserves (§10.1):
 *   workDeadlineAt              = hardDeadlineAt - reserveForFinalizeMs
 *   businessOperationCutoffAt   = workDeadlineAt - resultCommitReserveMs
 */
export function deriveAttemptDeadlines(params: {
  hardDeadlineAt: number;
  reserveForFinalizeMs: number;
  resultCommitReserveMs: number;
}): { workDeadlineAt: number; businessOperationCutoffAt: number } {
  const workDeadlineAt = params.hardDeadlineAt - params.reserveForFinalizeMs;
  const businessOperationCutoffAt = workDeadlineAt - params.resultCommitReserveMs;
  return { workDeadlineAt, businessOperationCutoffAt };
}

/**
 * Child deadline rule (§10.1):
 *   childDeadline = min(parentBusinessOperationCutoff, now + operationPolicyCap)
 * A child can never outlive the parent's business window minus its own cap. The
 * clamp is the enforcement point for K2–K4 ("child longer than parent").
 */
export function deriveChildDeadline(params: {
  parentBusinessOperationCutoffAt: number;
  now: number;
  operationPolicyCapMs: number;
}): number {
  return Math.min(
    params.parentBusinessOperationCutoffAt,
    params.now + params.operationPolicyCapMs,
  );
}

export type BudgetInvariantError =
  | 'reserves_negative'
  | 'work_after_hard'
  | 'business_after_work'
  | 'ordering_violated'
  | 'progress_threshold_starves_recovery';

/**
 * Validate the structural invariants of a budget + its step policy. Returns the
 * list of violations (empty = valid). Catches the dead 25/25 no-progress config
 * (K8): `maxStepsWithoutProgress <= maxSteps - recoveryReserveSteps`.
 */
export function validateBudgetInvariants(b: {
  businessOperationCutoffAt: number;
  workDeadlineAt: number;
  hardDeadlineAt: number;
  reserveForFinalizeMs: number;
  resultCommitReserveMs: number;
  stepProgress: StepProgressPolicy;
}): BudgetInvariantError[] {
  const errors: BudgetInvariantError[] = [];

  if (b.reserveForFinalizeMs < 0 || b.resultCommitReserveMs < 0) errors.push('reserves_negative');
  if (b.workDeadlineAt > b.hardDeadlineAt) errors.push('work_after_hard');
  if (b.businessOperationCutoffAt > b.workDeadlineAt) errors.push('business_after_work');
  if (!(b.businessOperationCutoffAt <= b.workDeadlineAt && b.workDeadlineAt <= b.hardDeadlineAt)) {
    errors.push('ordering_violated');
  }

  const { maxSteps, maxStepsWithoutProgress, recoveryReserveSteps } = b.stepProgress;
  if (maxStepsWithoutProgress > maxSteps - recoveryReserveSteps) {
    errors.push('progress_threshold_starves_recovery');
  }

  return errors;
}
