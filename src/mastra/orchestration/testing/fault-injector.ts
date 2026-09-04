/**
 * Deterministic, parent-owned fault injector for the G0 test-owned runtime (§19.1).
 *
 * The parent derives an exact fault SCHEDULE from the run seed (bound to suite +
 * challenge), records it in signed evidence (§19.2 "seed i fault schedule"), and
 * cross-checks an authenticated fault-event log against that schedule with a
 * fail-closed LEDGER. A fault that fired without being scheduled (rogue), a
 * scheduled fault left unaccounted, or an observed disposition outside the §20.3
 * allowed set — including the three forbidden outcomes ("completed without
 * result", orphaned accepted, blind non-idempotent retry) — classifies the run
 * `ESCAPED`, exactly as the side-effect ledger classifies containment. This is
 * an independent cross-check, not a restatement of the injector's own
 * bookkeeping: the schedule is derived from the seed and the events are derived
 * from what actually happened, and the two must reconcile.
 *
 * Scope: the injectable kinds map to crash-window points the current three
 * consumers can exercise on a single-node replica set (the six Mongo-owner
 * lifecycle fault points already wired into the test runtime). Live injection
 * into every §20.3 crash-window and the storage partition/stepdown suite stay
 * deferred (G8 / remaining-suite migration).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  hashCanonicalValue,
  TEST_RUNTIME_FAULT_POINTS,
  type TestRuntimeFaultPoint,
} from './test-runtime.js';

export const FAULT_SCHEDULE_VERSION = 'g0-fault-schedule/v1' as const;
export const FAULT_LEDGER_VERSION = 'g0-fault-ledger/v1' as const;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const FAULT_ID_RE = /^flt_[a-f0-9]{32}$/;
const MAX_SCHEDULED_FAULTS = 64;

/**
 * Closed enum of injectable fault kinds. Each maps 1:1 to a real
 * `TestRuntimeFaultPoint` already wired into the Mongo owner lifecycle, so a
 * scheduled fault names an injection site that genuinely exists rather than an
 * aspirational one.
 */
export const FAULT_INJECTOR_KINDS = [
  'MONGO_OWNER_CRASH_AFTER_COLLECTION',
  'MONGO_OWNER_CRASH_BEFORE_MARKER',
  'MONGO_OWNER_CRASH_AFTER_MARKER',
  'MONGO_CLEANUP_CRASH_BEFORE_CLAIM',
  'MONGO_CLEANUP_CRASH_AFTER_CLAIM',
  'MONGO_DROP_CRASH_BEFORE_VERIFY',
] as const;
export type FaultInjectorKind = (typeof FAULT_INJECTOR_KINDS)[number];

/** Exact mapping from a fault kind to the runtime fault point it injects at. */
export const FAULT_KIND_TO_RUNTIME_POINT: Readonly<
  Record<FaultInjectorKind, TestRuntimeFaultPoint>
> = {
  MONGO_OWNER_CRASH_AFTER_COLLECTION: 'afterMongoOwnerCollection',
  MONGO_OWNER_CRASH_BEFORE_MARKER: 'beforeMongoOwnerMarker',
  MONGO_OWNER_CRASH_AFTER_MARKER: 'afterMongoOwnerMarker',
  MONGO_CLEANUP_CRASH_BEFORE_CLAIM: 'beforeMongoCleanupClaim',
  MONGO_CLEANUP_CRASH_AFTER_CLAIM: 'afterMongoCleanupClaim',
  MONGO_DROP_CRASH_BEFORE_VERIFY: 'afterMongoDropBeforeVerification',
};

/**
 * The four §20.3 outcomes that a crash-window fault may legitimately resolve to.
 * Exactly one of these is expected for every injection point.
 */
export const FAULT_DISPOSITIONS = [
  'NOT_ACCEPTED_RETRYABLE',
  'RECOVERED_BY_OWNER',
  'APPLIED_ONCE',
  'UNKNOWN_OUTCOME_RECONCILE',
] as const;
export type FaultDisposition = (typeof FAULT_DISPOSITIONS)[number];

/**
 * The three §20.3 outcomes that must never be observed. They are named so a
 * violation is representable and caught, not silently unclassifiable.
 */
export const FORBIDDEN_FAULT_DISPOSITIONS = [
  'COMPLETED_WITHOUT_RESULT',
  'ORPHANED_ACCEPTED',
  'BLIND_NONIDEMPOTENT_RETRY',
] as const;
export type ForbiddenFaultDisposition =
  (typeof FORBIDDEN_FAULT_DISPOSITIONS)[number];

/**
 * Per-kind allowed dispositions. A crash before a durable marker can only leave
 * the work un-accepted (safe retry) or recovered by a fresh owner; a crash after
 * a durable marker or after an idempotent drop may additionally be applied once.
 */
export const FAULT_KIND_ALLOWED_DISPOSITIONS: Readonly<
  Record<FaultInjectorKind, readonly FaultDisposition[]>
> = {
  MONGO_OWNER_CRASH_AFTER_COLLECTION: [
    'NOT_ACCEPTED_RETRYABLE',
    'RECOVERED_BY_OWNER',
  ],
  MONGO_OWNER_CRASH_BEFORE_MARKER: [
    'NOT_ACCEPTED_RETRYABLE',
    'RECOVERED_BY_OWNER',
  ],
  MONGO_OWNER_CRASH_AFTER_MARKER: [
    'RECOVERED_BY_OWNER',
    'UNKNOWN_OUTCOME_RECONCILE',
  ],
  MONGO_CLEANUP_CRASH_BEFORE_CLAIM: [
    'RECOVERED_BY_OWNER',
    'APPLIED_ONCE',
  ],
  MONGO_CLEANUP_CRASH_AFTER_CLAIM: [
    'RECOVERED_BY_OWNER',
    'APPLIED_ONCE',
    'UNKNOWN_OUTCOME_RECONCILE',
  ],
  MONGO_DROP_CRASH_BEFORE_VERIFY: [
    'RECOVERED_BY_OWNER',
    'APPLIED_ONCE',
  ],
};

export const scheduledFaultSchema = z.object({
  faultId: z.string().regex(FAULT_ID_RE),
  sequence: z.number().int().min(1),
  kind: z.enum(FAULT_INJECTOR_KINDS),
  expectedDisposition: z.enum(FAULT_DISPOSITIONS),
});
export type ScheduledFault = z.infer<typeof scheduledFaultSchema>;

export const faultScheduleSchema = z.object({
  schemaVersion: z.literal(FAULT_SCHEDULE_VERSION),
  seed: z.number().int().min(0).max(0xffff_ffff),
  suiteId: z.string().min(1).max(192),
  challengeHash: z.string().regex(SHA256_RE),
  scheduleHash: z.string().regex(SHA256_RE),
  faults: z.array(scheduledFaultSchema).max(MAX_SCHEDULED_FAULTS),
});
export type FaultSchedule = z.infer<typeof faultScheduleSchema>;

export const faultEventSchema = z.object({
  faultId: z.string().regex(FAULT_ID_RE),
  kind: z.enum(FAULT_INJECTOR_KINDS),
  firedSequence: z.number().int().min(1),
  observedDisposition: z.union([
    z.enum(FAULT_DISPOSITIONS),
    z.enum(FORBIDDEN_FAULT_DISPOSITIONS),
  ]),
});
export type FaultEvent = z.infer<typeof faultEventSchema>;

export type FaultLedgerEntryStatus =
  | 'MATCHED'
  | 'DEFERRED'
  | 'UNACCOUNTED'
  | 'ROGUE'
  | 'DISPOSITION_MISMATCH'
  | 'FORBIDDEN_DISPOSITION'
  | 'DUPLICATE_EVENT';

export interface FaultLedgerEntry {
  faultId: string;
  kind: FaultInjectorKind;
  status: FaultLedgerEntryStatus;
  scheduledDisposition?: FaultDisposition;
  observedDisposition?: FaultDisposition | ForbiddenFaultDisposition;
}

export interface FaultLedger {
  schemaVersion: typeof FAULT_LEDGER_VERSION;
  mode: 'PLANNED' | 'EXECUTED';
  /** Anchors the ledger to the exact schedule it reconciles against. */
  scheduleHash: `sha256:${string}`;
  /** Anchors the ledger to the exact authenticated fault-event log bytes. */
  sourceEventLogHash: `sha256:${string}`;
  entries: FaultLedgerEntry[];
  summary: {
    scheduled: number;
    fired: number;
    matched: number;
    deferred: number;
    unaccounted: number;
    rogue: number;
    dispositionMismatch: number;
    forbidden: number;
    duplicate: number;
  };
  containmentStatus: 'ACCOUNTED' | 'ESCAPED';
}

/**
 * A deterministic, allocation-free 32-bit generator (SplitMix32). Seeded from a
 * canonical hash of the run identity so the same (seed, suite, challenge) always
 * yields the same schedule, and a different one always diverges.
 */
function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e37_79b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function deriveFaultId(
  seed: number,
  suiteId: string,
  challengeHash: string,
  index: number,
): string {
  const digest = createHash('sha256')
    .update(`g0-fault/${seed}/${suiteId}/${challengeHash}/${index}`)
    .digest('hex');
  return `flt_${digest.slice(0, 32)}`;
}

export interface DeriveFaultScheduleInput {
  seed: number;
  suiteId: string;
  challengeHash: `sha256:${string}`;
  /**
   * Upper bound on how many faults this run may inject. `0` records the empty
   * observe-only schedule the live gate uses today: the injector authority and
   * its evidence are established, while actual injection into the three e2e
   * suites stays deferred.
   */
  activeBudget: number;
}

/**
 * Derive the exact fault schedule for a run. Pure and deterministic: identical
 * input yields byte-identical output, and the `scheduleHash` binds the seed,
 * suite, challenge and chosen faults together so the ledger can prove it
 * reconciled against exactly this plan.
 */
export function deriveFaultSchedule(
  input: DeriveFaultScheduleInput,
): FaultSchedule {
  if (
    !Number.isInteger(input.seed)
    || input.seed < 0
    || input.seed > 0xffff_ffff
  ) {
    throw new TypeError('fault schedule seed must be a uint32');
  }
  if (!SHA256_RE.test(input.challengeHash)) {
    throw new TypeError('fault schedule challengeHash must be a sha256 digest');
  }
  if (
    !Number.isInteger(input.activeBudget)
    || input.activeBudget < 0
    || input.activeBudget > MAX_SCHEDULED_FAULTS
  ) {
    throw new TypeError('fault schedule activeBudget is out of range');
  }
  // Seed the generator from a canonical hash of the whole run identity, not the
  // bare uint32, so the suite and challenge genuinely perturb the plan.
  const seedHash = hashCanonicalValue({
    seed: input.seed,
    suiteId: input.suiteId,
    challengeHash: input.challengeHash,
  });
  const next = splitmix32(parseInt(seedHash.slice('sha256:'.length, 8 + 'sha256:'.length), 16));
  const count = input.activeBudget === 0
    ? 0
    : 1 + (next() % input.activeBudget);
  const faults: ScheduledFault[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = FAULT_INJECTOR_KINDS[next() % FAULT_INJECTOR_KINDS.length]!;
    const allowed = FAULT_KIND_ALLOWED_DISPOSITIONS[kind];
    const expectedDisposition = allowed[next() % allowed.length]!;
    faults.push({
      faultId: deriveFaultId(input.seed, input.suiteId, input.challengeHash, index),
      sequence: index + 1,
      kind,
      expectedDisposition,
    });
  }
  const scheduleHash = hashCanonicalValue({
    version: FAULT_SCHEDULE_VERSION,
    seed: input.seed,
    suiteId: input.suiteId,
    challengeHash: input.challengeHash,
    faults,
  });
  return faultScheduleSchema.parse({
    schemaVersion: FAULT_SCHEDULE_VERSION,
    seed: input.seed,
    suiteId: input.suiteId,
    challengeHash: input.challengeHash,
    scheduleHash,
    faults,
  });
}

/** Canonical hash of the authenticated fault-event log the ledger cross-checks. */
export function hashFaultEventLog(events: readonly FaultEvent[]): `sha256:${string}` {
  return hashCanonicalValue({
    version: FAULT_LEDGER_VERSION,
    events: events.map((event) => ({
      faultId: event.faultId,
      kind: event.kind,
      firedSequence: event.firedSequence,
      observedDisposition: event.observedDisposition,
    })),
  });
}

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_FAULT_DISPOSITIONS);

export interface DeriveFaultLedgerInput {
  schedule: FaultSchedule;
  events: readonly FaultEvent[];
  /**
   * `EXECUTED` requires every scheduled fault to have fired: an un-fired fault is
   * `UNACCOUNTED` and escapes. `PLANNED` records the schedule without executing
   * it this run, so un-fired faults are `DEFERRED` (accounted) — but any event
   * that does fire is still fully validated against the schedule.
   */
  mode: 'PLANNED' | 'EXECUTED';
}

/**
 * Derive the fail-closed fault ledger. Independent of the injector's own
 * success flag: the schedule (from the seed) and the events (from what actually
 * happened) are reconciled here, and any of rogue / duplicate / unaccounted /
 * disposition-mismatch / forbidden classifies the run `ESCAPED`.
 */
export function deriveFaultLedger(input: DeriveFaultLedgerInput): FaultLedger {
  const schedule = faultScheduleSchema.parse(input.schedule);
  const events = input.events.map((event) => faultEventSchema.parse(event));
  const scheduledById = new Map<string, ScheduledFault>();
  for (const fault of schedule.faults) scheduledById.set(fault.faultId, fault);

  const entries: FaultLedgerEntry[] = [];
  const summary = {
    scheduled: schedule.faults.length,
    fired: events.length,
    matched: 0,
    deferred: 0,
    unaccounted: 0,
    rogue: 0,
    dispositionMismatch: 0,
    forbidden: 0,
    duplicate: 0,
  };
  const seenFaultIds = new Set<string>();

  for (const event of events) {
    const scheduled = scheduledById.get(event.faultId);
    if (!scheduled || scheduled.kind !== event.kind) {
      // A fault fired that this run never scheduled (or under the wrong kind):
      // the injector reached a site outside its declared plan.
      summary.rogue += 1;
      entries.push({ faultId: event.faultId, kind: event.kind, status: 'ROGUE' });
      continue;
    }
    if (seenFaultIds.has(event.faultId)) {
      // One scheduled fault produced more than one firing.
      summary.duplicate += 1;
      entries.push({
        faultId: event.faultId,
        kind: event.kind,
        status: 'DUPLICATE_EVENT',
        scheduledDisposition: scheduled.expectedDisposition,
        observedDisposition: event.observedDisposition,
      });
      continue;
    }
    seenFaultIds.add(event.faultId);
    if (FORBIDDEN_SET.has(event.observedDisposition)) {
      summary.forbidden += 1;
      entries.push({
        faultId: event.faultId,
        kind: event.kind,
        status: 'FORBIDDEN_DISPOSITION',
        scheduledDisposition: scheduled.expectedDisposition,
        observedDisposition: event.observedDisposition,
      });
      continue;
    }
    const allowed = FAULT_KIND_ALLOWED_DISPOSITIONS[scheduled.kind];
    if (!allowed.includes(event.observedDisposition as FaultDisposition)) {
      // An allowed-enum disposition, but not one this kind may legitimately
      // resolve to (e.g. APPLIED_ONCE for a crash before any durable marker).
      summary.dispositionMismatch += 1;
      entries.push({
        faultId: event.faultId,
        kind: event.kind,
        status: 'DISPOSITION_MISMATCH',
        scheduledDisposition: scheduled.expectedDisposition,
        observedDisposition: event.observedDisposition,
      });
      continue;
    }
    summary.matched += 1;
    entries.push({
      faultId: event.faultId,
      kind: event.kind,
      status: 'MATCHED',
      scheduledDisposition: scheduled.expectedDisposition,
      observedDisposition: event.observedDisposition,
    });
  }

  for (const fault of schedule.faults) {
    if (seenFaultIds.has(fault.faultId)) continue;
    if (input.mode === 'EXECUTED') {
      summary.unaccounted += 1;
      entries.push({
        faultId: fault.faultId,
        kind: fault.kind,
        status: 'UNACCOUNTED',
        scheduledDisposition: fault.expectedDisposition,
      });
    } else {
      summary.deferred += 1;
      entries.push({
        faultId: fault.faultId,
        kind: fault.kind,
        status: 'DEFERRED',
        scheduledDisposition: fault.expectedDisposition,
      });
    }
  }

  const contained = summary.rogue === 0
    && summary.duplicate === 0
    && summary.unaccounted === 0
    && summary.dispositionMismatch === 0
    && summary.forbidden === 0;

  return {
    schemaVersion: FAULT_LEDGER_VERSION,
    mode: input.mode,
    scheduleHash: schedule.scheduleHash as `sha256:${string}`,
    sourceEventLogHash: hashFaultEventLog(events),
    entries,
    summary,
    containmentStatus: contained ? 'ACCOUNTED' : 'ESCAPED',
  };
}
