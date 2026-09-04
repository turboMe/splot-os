/**
 * Canonical identifier hierarchy for the durable orchestration substrate (V2).
 *
 * Maps 1:1 onto the plan §5.1. Every identifier here is **server-minted** from a
 * trusted context. Model output, `Date.now()` and framework/model run IDs are
 * never authority (plan invariants IDN-001 / N1, and §12.5 "Zakaz bypassów":
 * `taskId` may not be used as `runtimeRunId`).
 *
 * Nominal branding gives each ID a distinct compile-time type over `string`
 * with zero runtime cost, so `jobId`, `taskId`, `attemptId` and `runtimeRunId`
 * cannot be mixed by accident — the "One intent, many attempts" invariant
 * (§3 rule 5) enforced by the type system.
 *
 * Fala 1 / PR-1 (walking-skeleton Tier-1 contract layer). No runtime wiring.
 */

declare const __brand: unique symbol;

/** Nominal newtype over a base primitive. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

// --- Identity & authorization boundary (auth/ingress owned; never model-derived) ---
export type TenantId = Brand<string, 'TenantId'>;
export type ResourceId = Brand<string, 'ResourceId'>;
export type PrincipalId = Brand<string, 'PrincipalId'>;

// --- Registry / capability ---
export type AgentProfileId = Brand<string, 'AgentProfileId'>;
export type CapabilityId = Brand<string, 'CapabilityId'>;
export type WorkerInstanceId = Brand<string, 'WorkerInstanceId'>;

// --- Conversation surface ---
export type ConversationId = Brand<string, 'ConversationId'>;
export type ConversationThreadId = Brand<string, 'ConversationThreadId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type TurnId = Brand<string, 'TurnId'>;

// --- Command surface ---
export type CommandId = Brand<string, 'CommandId'>;

// --- Job / plan / task / attempt lineage ---
export type JobId = Brand<string, 'JobId'>;
export type ParentJobId = Brand<string, 'ParentJobId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type ParentTaskId = Brand<string, 'ParentTaskId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type ParentAttemptId = Brand<string, 'ParentAttemptId'>;
export type RuntimeRunId = Brand<string, 'RuntimeRunId'>;
export type ActivationId = Brand<string, 'ActivationId'>;

// --- Dispatch edges (parent → child provenance & control) ---
export type DispatchEdgeId = Brand<string, 'DispatchEdgeId'>;
export type BranchId = Brand<string, 'BranchId'>;

// --- Events / delivery / persistence ---
export type EventId = Brand<string, 'EventId'>;
export type OutboxId = Brand<string, 'OutboxId'>;
export type DeliveryId = Brand<string, 'DeliveryId'>;
export type ResultId = Brand<string, 'ResultId'>;

// --- Budget / lease / effects / artifacts ---
export type BudgetReservationId = Brand<string, 'BudgetReservationId'>;
export type LeaseOwner = Brand<string, 'LeaseOwner'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type ArtifactDraftId = Brand<string, 'ArtifactDraftId'>;
export type EffectIntentId = Brand<string, 'EffectIntentId'>;
export type ExternalOperationId = Brand<string, 'ExternalOperationId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type DispatchPermitId = Brand<string, 'DispatchPermitId'>;

// --- Control requests (question / approval) ---
export type RequestId = Brand<string, 'RequestId'>;

/**
 * Monotonic versions & generations. Numbers, but branded so a `planVersion` is
 * never compared against a `jobStopGeneration` by mistake. These are all
 * store-authoritative (server-assigned); the plan forbids treating a model's
 * `attemptNumber` or `Date.now()`-derived value as any of these.
 */
export type PlanVersion = Brand<number, 'PlanVersion'>;
export type StateVersion = Brand<number, 'StateVersion'>;
export type ControlVersion = Brand<number, 'ControlVersion'>;
export type AttemptFence = Brand<number, 'AttemptFence'>;
export type ActivationFence = Brand<number, 'ActivationFence'>;
export type AttemptNumber = Brand<number, 'AttemptNumber'>;

/** Generation family — each scoped epoch counter is nominally distinct. */
export type Generation<B extends string> = Brand<number, `Generation:${B}`>;
export type JobStopGeneration = Generation<'jobStop'>;
export type TaskStopGeneration = Generation<'taskStop'>;
export type StopGeneration = Generation<'attemptStop'>;
export type PauseGeneration = Generation<'pause'>;
export type ActivationDispatchGeneration = Generation<'activationDispatch'>;
export type JobClockGeneration = Generation<'jobClock'>;
export type DispatchEdgeGeneration = Generation<'dispatchEdge'>;
export type RequestGeneration = Generation<'request'>;
export type EvidenceGeneration = Generation<'evidence'>;

// --- Minting -----------------------------------------------------------------

/**
 * Server-side UUID minting. `crypto.randomUUID()` only — never `Date.now()`,
 * a counter that could collide across replicas, or an ID lifted from model
 * output. Each helper carries a short, greppable prefix.
 */
function mint(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

export const newJobId = (): JobId => mint('job') as JobId;
export const newTaskId = (): TaskId => mint('task') as TaskId;
export const newAttemptId = (): AttemptId => mint('attempt') as AttemptId;
export const newRuntimeRunId = (): RuntimeRunId => mint('run') as RuntimeRunId;
export const newActivationId = (): ActivationId => mint('act') as ActivationId;
export const newDispatchEdgeId = (): DispatchEdgeId => mint('edge') as DispatchEdgeId;
export const newEventId = (): EventId => mint('evt') as EventId;
export const newOutboxId = (): OutboxId => mint('obx') as OutboxId;
export const newDeliveryId = (): DeliveryId => mint('dlv') as DeliveryId;
export const newResultId = (): ResultId => mint('res') as ResultId;
export const newTurnId = (): TurnId => mint('turn') as TurnId;
export const newBudgetReservationId = (): BudgetReservationId => mint('bres') as BudgetReservationId;
export const newExternalOperationId = (): ExternalOperationId => mint('op') as ExternalOperationId;
export const newEffectIntentId = (): EffectIntentId => mint('eff') as EffectIntentId;
export const newDispatchPermitId = (): DispatchPermitId => mint('perm') as DispatchPermitId;
export const newRequestId = (): RequestId => mint('req') as RequestId;
export const newArtifactId = (): ArtifactId => mint('art') as ArtifactId;

/**
 * Adopt an externally-supplied string as a branded ID **only** at a trusted
 * boundary (e.g. auth mapping a credential to a `resourceId`, or reading a
 * persisted record). Empty strings are rejected — a missing identity is a
 * contract error, never a silent fallback (§5.2, `META_AGENT_ID` may not be a
 * user-resource fallback).
 */
export function adoptId<B extends string>(raw: string, brand: B): Brand<string, B> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`adoptId: empty/invalid identifier for brand '${brand}'`);
  }
  return raw as Brand<string, B>;
}

/** Adopt a server-authoritative numeric version/generation from a trusted store. */
export function adoptVersion<B extends string>(raw: number, brand: B): Brand<number, B> {
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error(`adoptVersion: non-monotonic value ${raw} for brand '${brand}'`);
  }
  return raw as Brand<number, B>;
}
