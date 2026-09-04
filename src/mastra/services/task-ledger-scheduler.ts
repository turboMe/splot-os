/**
 * Task Ledger Scheduler — resource claims, leases and conflict queueing
 * (Etap 5, IDEALSYSTEMMASTERPLAN §3.3).
 *
 * A lane declares the resources it will touch as `claims[]`
 * (`n8n:workflow:<id>`, `crm:write`, `gmail:send`, `gpu:local`,
 * `repo:src/mastra/**`). Before a lane starts work it acquires a lease on its
 * claims:
 *   - disjoint claims  → lanes run IN PARALLEL;
 *   - overlapping claims → the later lane WAITS (stays queued) until the
 *     holder releases (FIFO by priority).
 *
 * Leases live in Mongo `claim_locks` (unique index on `claim` — atomic
 * backstop for the common exact-match case). Glob claims (`repo:...`) are
 * matched by overlap. Leases carry a TTL so a crashed lane's locks self-expire;
 * they are also released when the lane reaches a terminal state (wired from
 * task-ledger.transitionLane) or is reconciled stale.
 *
 * Enforcement is REAL at the automation-job queued→running gate (the writer
 * that supports a wait point). For fire-and-forget writers the claims are
 * recorded and conflicts are visible; full preemption of running work lands
 * with the executor rework (documented in docs/CLAIMS-SCHEDULER.md).
 */

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';

const LOCKS_COLLECTION = 'claim_locks';
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000;
const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 1_000;

export type ClaimLock = {
  claim: string;
  laneId: string;
  laneNo: number;
  acquiredAt: Date;
  expiresAt: Date;
};

export type AcquireResult =
  | { acquired: true; held: string[] }
  | { acquired: false; conflictClaim: string; conflictLaneNo: number; myClaim: string };

export function isSchedulerEnabled(): boolean {
  return isHarnessFeatureEnabled('FEATURE_LEDGER_SCHEDULER', true);
}

let indexEnsured: Promise<void> | null = null;
async function ensureIndex(): Promise<void> {
  indexEnsured ??= (async () => {
    const db = await getDb();
    const col = db.collection<ClaimLock>(LOCKS_COLLECTION);
    await col.createIndex({ claim: 1 }, { unique: true });
    await col.createIndex({ laneId: 1 });
    await col.createIndex({ expiresAt: 1 });
  })().catch((err) => {
    indexEnsured = null;
    console.warn('[Scheduler] ensureIndex failed:', (err as Error).message);
  }) as Promise<void>;
  await indexEnsured;
}

// ── Claim overlap ─────────────────────────────────────────────────────────────

/**
 * Two claims conflict when they name the same resource. Same namespace
 * (before the first ':') is required; within it, exact match OR glob overlap.
 * Different namespaces never conflict (an n8n workflow and a CRM write are
 * independent).
 */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [nsA, ...restA] = a.split(':');
  const [nsB, ...restB] = b.split(':');
  if (nsA !== nsB) return false;
  const ra = restA.join(':');
  const rb = restB.join(':');
  if (ra === rb) return true;
  const aGlob = /[*?]/.test(ra);
  const bGlob = /[*?]/.test(rb);
  if (!aGlob && !bGlob) return false;
  return globMatch(ra, rb) || globMatch(rb, ra);
}

/** Minimal glob → regex: ** matches across '/', * within a segment, ? one char. */
function globMatch(pattern: string, value: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === value;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '.';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

// ── Lease acquire / release ───────────────────────────────────────────────────

async function cleanupExpired(): Promise<void> {
  const db = await getDb();
  await db.collection<ClaimLock>(LOCKS_COLLECTION)
    .deleteMany({ expiresAt: { $lt: new Date() } })
    .catch(() => undefined);
}

/**
 * List active leases held by OTHER lanes that overlap any of `claims`.
 */
export async function findClaimConflicts(
  claims: string[],
  excludeLaneId: string,
): Promise<Array<{ claim: string; laneNo: number; myClaim: string }>> {
  if (claims.length === 0) return [];
  await cleanupExpired();
  const db = await getDb();
  const held = await db.collection<ClaimLock>(LOCKS_COLLECTION)
    .find({ laneId: { $ne: excludeLaneId } })
    .toArray();
  const conflicts: Array<{ claim: string; laneNo: number; myClaim: string }> = [];
  for (const lock of held) {
    for (const mine of claims) {
      if (claimsOverlap(mine, lock.claim)) {
        conflicts.push({ claim: lock.claim, laneNo: lock.laneNo, myClaim: mine });
      }
    }
  }
  return conflicts;
}

/**
 * Try to acquire leases on all `claims` for a lane. All-or-nothing: on any
 * conflict nothing is held. Exact-claim races are caught by the unique index.
 */
export async function acquireClaims(input: {
  laneId: string;
  laneNo: number;
  claims: string[];
  ttlMs?: number;
}): Promise<AcquireResult> {
  if (!isSchedulerEnabled() || input.claims.length === 0) {
    return { acquired: true, held: [] };
  }
  await ensureIndex();

  const conflicts = await findClaimConflicts(input.claims, input.laneId);
  if (conflicts.length > 0) {
    const c = conflicts[0]!;
    return { acquired: false, conflictClaim: c.claim, conflictLaneNo: c.laneNo, myClaim: c.myClaim };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_LEASE_TTL_MS));
  const db = await getDb();
  const col = db.collection<ClaimLock>(LOCKS_COLLECTION);

  // Re-assert idempotently: a lane may re-acquire its own claims.
  const inserted: string[] = [];
  for (const claim of input.claims) {
    try {
      await col.updateOne(
        { claim },
        { $setOnInsert: { claim, laneId: input.laneId, laneNo: input.laneNo, acquiredAt: now }, $set: { expiresAt } },
        { upsert: true },
      );
      const lock = await col.findOne({ claim });
      if (lock && lock.laneId !== input.laneId) {
        // Lost a race — another lane grabbed this exact claim.
        await releaseClaims(input.laneId);
        return { acquired: false, conflictClaim: claim, conflictLaneNo: lock.laneNo, myClaim: claim };
      }
      inserted.push(claim);
    } catch {
      await releaseClaims(input.laneId);
      const lock = await col.findOne({ claim });
      return {
        acquired: false,
        conflictClaim: claim,
        conflictLaneNo: lock?.laneNo ?? -1,
        myClaim: claim,
      };
    }
  }
  return { acquired: true, held: inserted };
}

/**
 * Extend this lane's leases, and report whether it still holds them all.
 *
 * Both halves matter and they are the same operation on purpose.
 *
 * A lease has a TTL so a crashed holder cannot block the resource forever, and
 * `cleanupExpired` DELETES an expired lock. Nothing renewed, so any holder whose
 * work outlived the TTL silently stopped holding anything while still believing
 * it did — for `capability BUILD`, whose claim is `repo:src/mastra/**` and whose
 * final act is a git merge, that means two builds merging into one repo at once.
 *
 * Renewal alone would not be enough either: the answer to "am I still the
 * holder?" has to come from the same round trip, so a caller about to do the
 * dangerous thing can fence on a fact rather than on an assumption. Hence the
 * `$set` is scoped by `laneId` — a lane that lost its lock cannot renew its way
 * back into ownership, it just learns it is out.
 */
export async function renewClaims(input: {
  laneId: string;
  claims: string[];
  ttlMs?: number;
}): Promise<{ held: boolean; lost: string[] }> {
  if (!isSchedulerEnabled() || input.claims.length === 0) {
    return { held: true, lost: [] };
  }
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_LEASE_TTL_MS));
  const db = await getDb();
  const col = db.collection<ClaimLock>(LOCKS_COLLECTION);
  const lost: string[] = [];
  for (const claim of input.claims) {
    const res = await col.updateOne(
      // Ownership is part of the FILTER, never of the update: this can extend a
      // lease it holds and can never create or steal one.
      { claim, laneId: input.laneId },
      { $set: { expiresAt } },
    ).catch(() => null);
    if (!res || res.matchedCount === 0) lost.push(claim);
  }
  return { held: lost.length === 0, lost };
}

/** Fence: does this lane still hold every one of these claims, unexpired? */
export async function claimsStillHeld(laneId: string, claims: string[]): Promise<boolean> {
  if (!isSchedulerEnabled() || claims.length === 0) return true;
  await cleanupExpired();
  const db = await getDb();
  const held = await db.collection<ClaimLock>(LOCKS_COLLECTION)
    .find({ laneId, claim: { $in: claims } })
    .toArray()
    .catch(() => []);
  return held.length === claims.length;
}

export async function releaseClaims(laneId: string): Promise<number> {
  try {
    const db = await getDb();
    const res = await db.collection<ClaimLock>(LOCKS_COLLECTION).deleteMany({ laneId });
    return res.deletedCount;
  } catch (err) {
    console.warn('[Scheduler] releaseClaims failed:', (err as Error).message);
    return 0;
  }
}

/**
 * Poll until the lane can acquire all its claims or the wait budget expires.
 * Returns the outcome; the caller decides what to do on timeout.
 */
export async function waitAndAcquireClaims(input: {
  laneId: string;
  laneNo: number;
  claims: string[];
  maxWaitMs?: number;
  pollMs?: number;
  isCancelled?: () => boolean;
}): Promise<{ acquired: boolean; waitedMs: number; conflictClaim?: string; conflictLaneNo?: number }> {
  if (!isSchedulerEnabled() || input.claims.length === 0) {
    return { acquired: true, waitedMs: 0 };
  }
  const start = Date.now();
  const maxWait = input.maxWaitMs ?? DEFAULT_WAIT_MS;
  const poll = input.pollMs ?? DEFAULT_POLL_MS;

  for (;;) {
    if (input.isCancelled?.()) {
      return { acquired: false, waitedMs: Date.now() - start };
    }
    const res = await acquireClaims({ laneId: input.laneId, laneNo: input.laneNo, claims: input.claims });
    if (res.acquired) {
      return { acquired: true, waitedMs: Date.now() - start };
    }
    if (Date.now() - start >= maxWait) {
      return {
        acquired: false,
        waitedMs: Date.now() - start,
        conflictClaim: res.conflictClaim,
        conflictLaneNo: res.conflictLaneNo,
      };
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** Inspect currently held leases (diagnostics / digest). */
export async function listActiveClaims(): Promise<ClaimLock[]> {
  await cleanupExpired();
  const db = await getDb();
  return db.collection<ClaimLock>(LOCKS_COLLECTION).find({}).sort({ acquiredAt: 1 }).toArray();
}
