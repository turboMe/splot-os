/**
 * Strict result envelope V2 for the durable orchestration substrate.
 *
 * Implements plan §9.1 and invariant §3.6 ("No false success"): empty output,
 * plain prose, malformed JSON, an unknown status or a non-envelope JSON object
 * all become `invalid_result` — never a fallback `ok`. This is the contract-level
 * fix for `RES-001`; it deliberately does NOT reuse the legacy
 * `services/result-envelope.ts`, whose prose fallback maps to `status: 'ok'`.
 *
 * Trust boundary (§9.1): a worker/model may only assert the *producer* portion
 * (status + payload/evidence/side-effects/retry hints). Identity and version
 * fields (`tenantId`, `jobId`, `planVersion`, `attemptFence`, stop generations,
 * `runtimeRunId`, …) are stamped by the runtime from a trusted context and are
 * never read from model content. `sealResultEnvelope` composes the two.
 */

import { z } from 'zod';

// --- Producer surface (what a worker/model may assert) ---------------------

export const PRODUCER_STATUSES = [
  'ok', 'partial', 'blocked', 'failed', 'cancelled', 'timed_out', 'unknown_outcome',
] as const;
export type ProducerStatus = (typeof PRODUCER_STATUSES)[number];

const artifactRefSchema = z.object({
  artifactId: z.string().min(1),
  type: z.string().min(1),
  summary: z.string().default(''),
  hash: z.string().optional(),
});

/**
 * The ONE shape of an artifact reference on the producer surface.
 *
 * Exported because both ends were reading this shape from memory and one of them
 * remembered it wrong: the successor reader looked for `.id` while the contract
 * has always said `artifactId`, so every reference would have been dropped. That
 * stayed invisible for as long as nothing filled the array — the same failure
 * mode as `findArtifactIds` matching an id the runtime never emits. A shared type
 * makes the next disagreement a compile error instead of an empty list.
 */
export type ProducerArtifactRef = z.infer<typeof artifactRefSchema>;

const evidenceRefSchema = z.object({
  evidenceId: z.string().min(1),
  kind: z.string().min(1),
  ref: z.string().optional(),
});

const sideEffectSchema = z.object({
  externalOperationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  state: z.enum(['reserved', 'dispatching', 'committed', 'aborted', 'unknown']),
  externalRef: z.string().optional(),
});

const retrySchema = z.object({
  retryable: z.boolean(),
  reasonCode: z.string().nullable().default(null),
  suggestedDelayMs: z.number().int().nonnegative().nullable().default(null),
});

const blockedSchema = z.object({
  kind: z.enum(['user', 'approval', 'external', 'dependency']),
  action: z.string().min(1),
  expiresAt: z.string().datetime().nullable().default(null),
});

const errorSchema = z.object({
  code: z.string().min(1),
  message: z.string().default(''),
});

/**
 * Discriminated by `status`. Per-status required shapes enforce §9.1:
 * `blocked` requires a typed `blocked`, `failed`/`timed_out`/`cancelled`/
 * `unknown_outcome` require a typed `error`, and `ok`/`partial` require a
 * non-null `data` payload (the domain validator adds task-type specifics).
 */
const baseProducerFields = {
  summary: z.string().default(''),
  artifacts: z.array(artifactRefSchema).default([]),
  evidence: z.array(evidenceRefSchema).default([]),
  warnings: z.array(z.string()).default([]),
  sideEffects: z.array(sideEffectSchema).default([]),
  retry: retrySchema.default({ retryable: false, reasonCode: null, suggestedDelayMs: null }),
  metrics: z.record(z.string(), z.unknown()).default({}),
};

export const producerResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), data: z.record(z.string(), z.unknown()), blocked: z.null().default(null), error: z.null().default(null), ...baseProducerFields }),
  z.object({ status: z.literal('partial'), data: z.record(z.string(), z.unknown()), blocked: z.null().default(null), error: z.null().default(null), ...baseProducerFields }),
  z.object({ status: z.literal('blocked'), data: z.record(z.string(), z.unknown()).default({}), blocked: blockedSchema, error: z.null().default(null), ...baseProducerFields }),
  z.object({ status: z.literal('failed'), data: z.record(z.string(), z.unknown()).default({}), blocked: z.null().default(null), error: errorSchema, ...baseProducerFields }),
  z.object({ status: z.literal('timed_out'), data: z.record(z.string(), z.unknown()).default({}), blocked: z.null().default(null), error: errorSchema, ...baseProducerFields }),
  z.object({ status: z.literal('cancelled'), data: z.record(z.string(), z.unknown()).default({}), blocked: z.null().default(null), error: errorSchema, ...baseProducerFields }),
  z.object({ status: z.literal('unknown_outcome'), data: z.record(z.string(), z.unknown()).default({}), blocked: z.null().default(null), error: errorSchema, ...baseProducerFields }),
]);

export type ProducerResult = z.infer<typeof producerResultSchema>;

/** Why a producer payload was rejected. `invalid_result` is never `ok`. */
export type ProducerRejectReason =
  | 'empty'
  | 'not_json'
  | 'not_object'
  | 'missing_status'
  | 'unknown_status'
  | 'schema_invalid';

export type ProducerValidation =
  | { ok: true; value: ProducerResult }
  | { ok: false; reason: ProducerRejectReason; detail?: string };

/**
 * Producer payloads cross a durable JSON boundary. Reject values whose identity
 * would be lost or changed by JSON/canonical hashing (Date, BigInt, Map,
 * accessors, sparse arrays, cycles, non-finite numbers, excessive nesting).
 */
function jsonCompatibilityError(input: unknown): string | null {
  const active = new WeakSet<object>();
  let visited = 0;
  const MAX_DEPTH = 64;
  const MAX_NODES = 100_000;

  const visit = (value: unknown, path: string, depth: number): string | null => {
    visited++;
    if (visited > MAX_NODES) return 'JSON payload exceeds the node limit';
    if (depth > MAX_DEPTH) return `JSON payload exceeds the depth limit at ${path}`;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? null : `non-finite number at ${path}`;
    }
    if (typeof value !== 'object') return `non-JSON ${typeof value} at ${path}`;

    const object = value as object;
    if (active.has(object)) return `cyclic value at ${path}`;
    active.add(object);
    try {
      if (Array.isArray(value)) {
        const ownKeys = Reflect.ownKeys(value);
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor) return `sparse array at ${path}[${i}]`;
          if (!descriptor.enumerable || !('value' in descriptor)) {
            return `non-data array element at ${path}[${i}]`;
          }
          const issue = visit(descriptor.value, `${path}[${i}]`, depth + 1);
          if (issue) return issue;
        }
        const unexpected = ownKeys.find((key) => {
          if (key === 'length') return false;
          if (typeof key !== 'string') return true;
          const index = Number(key);
          return !Number.isInteger(index)
            || index < 0
            || index >= value.length
            || String(index) !== key;
        });
        return unexpected === undefined ? null : `non-JSON array property at ${path}`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return `non-plain object at ${path}`;
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return `symbol property at ${path}`;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          return `non-data property at ${path}.${key}`;
        }
        const issue = visit(descriptor.value, `${path}.${key}`, depth + 1);
        if (issue) return issue;
      }
      return null;
    } finally {
      active.delete(object);
    }
  };

  try {
    return visit(input, '$', 0);
  } catch (err) {
    return `unreadable JSON payload: ${(err as Error).message}`;
  }
}

/**
 * Validate a producer's asserted result. Accepts either a parsed object or a
 * raw string (which must be a JSON object — prose is rejected, not coerced).
 * Returns a typed rejection instead of ever inventing a success.
 */
export function validateProducerResult(input: unknown): ProducerValidation {
  let obj: unknown = input;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return { ok: false, reason: 'empty' };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: 'not_json' };
    }
  }

  if (obj === null || obj === undefined) return { ok: false, reason: 'empty' };
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not_object' };

  const jsonIssue = jsonCompatibilityError(obj);
  if (jsonIssue) return { ok: false, reason: 'schema_invalid', detail: jsonIssue };

  const status = (obj as Record<string, unknown>).status;
  if (status === undefined || status === null) return { ok: false, reason: 'missing_status' };
  if (typeof status !== 'string' || !(PRODUCER_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, reason: 'unknown_status', detail: String(status) };
  }

  const parsed = producerResultSchema.safeParse(obj);
  if (!parsed.success) {
    return { ok: false, reason: 'schema_invalid', detail: parsed.error.issues[0]?.message };
  }
  return { ok: true, value: parsed.data };
}

// --- Sealed envelope (producer + trusted runtime binding) ------------------

/**
 * Trusted fields the runtime stamps from context — never from model output.
 * All identifiers are opaque strings at this layer to avoid a hard dependency
 * on the branded id module here; the gateway constructs them from branded ids.
 */
export interface RuntimeBinding {
  readonly schemaVersion: 'execution-result/v1';
  readonly resultId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly planVersion: number;
  readonly controlVersionAtDispatch: number;
  readonly jobStopGenerationAtDispatch: number;
  readonly taskId: string;
  readonly taskStopGenerationAtDispatch: number;
  readonly attemptId: string;
  readonly dispatchEdgeId: string | null;
  readonly dispatchEdgeGenerationAtDispatch: number;
  readonly dispatchAncestorSnapshotHash: string;
  readonly finishCurrentPauseGeneration: number | null;
  readonly stopGeneration: number;
  readonly runtimeRunId: string;
  readonly attemptFence: number;
  readonly businessPayloadReadyGeneration: number;
  readonly businessPayloadReadyHash: string;
  readonly ACommittedAt: string;
  readonly finishedAt: string;
}

export interface SealedResultEnvelope extends RuntimeBinding {
  readonly producer: ProducerResult;
}

/**
 * Compose a trusted, immutable envelope from a validated producer result and a
 * runtime binding. The producer can never influence the identity/version block;
 * that is the whole point of the split (§9.1, "identity pochodzą z zaufanego
 * kontekstu runtime, a nie z treści modelu").
 */
export function sealResultEnvelope(
  producer: ProducerResult,
  binding: RuntimeBinding,
): SealedResultEnvelope {
  return { ...binding, producer };
}
