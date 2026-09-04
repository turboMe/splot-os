/**
 * Task Ledger — single source of truth for everything the system is doing.
 *
 * Etap 1 of ideas/IDEALSYSTEMMASTERPLAN.md (blueprint §3.2). One lane = one
 * unit of background work (async delegation, background task, automation job,
 * cron trigger). The ledger only OBSERVES: lifecycle writers report through
 * the adapter functions below; their own logic is unchanged.
 *
 * State machine:
 *   queued → running → done | failed | cancelled
 *   running ↔ blocked | awaiting_approval
 *
 * Every write is fail-safe (never throws into the caller's flow) and the
 * whole feature sits behind FEATURE_LEDGER_V1 (default ON — rollback = env
 * FEATURE_LEDGER_V1=false).
 *
 * Push: transitions into blocked | awaiting_approval | done | failed POST a
 * compact JSON to LEDGER_PUSH_WEBHOOK_URL (n8n webhook → Telegram) when set.
 */

import { randomUUID } from 'crypto';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { releaseClaims } from './task-ledger-scheduler.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type LaneState =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'awaiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled';

export type LaneSource =
  | 'async_delegation'
  | 'background_task'
  | 'automation_job'
  | 'cron'
  | 'manual';

export type LaneMilestone = { at: Date; note: string };

export type LanePlan = { v: number; status: 'active' | 'abandoned' | 'done'; why?: string };

export type LaneArtifactRef = { id: string; type?: string; summary?: string };

export type LaneRecord = {
  laneId: string;
  /** Human-friendly number for operator commands ("status #17"). */
  laneNo: number;
  source: LaneSource;
  /** Id in the writer's own collection (delegationId / bgTaskId / jobId / cron rule). */
  sourceId: string;
  goal: string;
  agentId?: string;
  threadId?: string;
  state: LaneState;
  priority: number;
  budget?: { capUsd?: number; spentUsd?: number };
  /** Declared resource claims — stored now, scheduled in Etap 5. */
  claims: string[];
  heartbeatAt: Date;
  /** running lane with heartbeat older than this is reconciled to failed(stale). */
  staleAfterMs: number;
  milestones: LaneMilestone[];
  artifacts: LaneArtifactRef[];
  plans: LanePlan[];
  parent?: string;
  children?: string[];
  error?: string;
  pauseRequested?: boolean;
  cancelRequested?: boolean;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Set by the digest reader so "recently finished" is reported exactly once. */
  digestedAt?: Date;
  /**
   * Who decides this lane's fate (F6 work item 4).
   *
   * Absent = the Ledger, as before: a writer heartbeats, and silence past
   * `staleAfterMs` is judged as failure. `'durable'` = a V2 job owns the work,
   * this lane is a PROJECTION of it, and the Ledger may only mirror what the
   * substrate reports.
   *
   * The distinction is not bookkeeping. A durable job survives restarts, is
   * retried after `WORKER_LOST` and can wait on a human — all of which look
   * exactly like silence to a heartbeat timer. `reconcileStaleLanes` would
   * therefore mark a perfectly healthy job as `failed`, and because terminal
   * lane states are absorbing, the real `done` that arrives later is silently
   * dropped. The read model would then report a failure that never happened,
   * permanently, with nothing to say it was wrong.
   */
  owner?: 'durable';
  /** The durable job this lane projects, when `owner` is `'durable'`. */
  durableJobId?: string;
  meta?: Record<string, unknown>;
};

export type OpenLaneInput = {
  source: LaneSource;
  sourceId: string;
  goal: string;
  agentId?: string;
  threadId?: string;
  state?: Extract<LaneState, 'queued' | 'running'>;
  priority?: number;
  budgetCapUsd?: number;
  claims?: string[];
  staleAfterMs?: number;
  parent?: string;
  meta?: Record<string, unknown>;
};

export type LedgerDigest = {
  enabled: boolean;
  killSwitch: boolean;
  active: LaneRecord[];
  attention: LaneRecord[];
  recentlyFinished: LaneRecord[];
  counts: { queued: number; running: number; blocked: number; awaiting_approval: number };
  text: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = 'task_ledger';
const SETTINGS_COLLECTION = 'task_ledger_settings';
const COUNTERS_COLLECTION = 'task_ledger_counters';
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const GOAL_MAX_LEN = 500;
const PUSH_STATES: LaneState[] = ['blocked', 'awaiting_approval', 'done', 'failed'];

const VALID_TRANSITIONS: Record<LaneState, LaneState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['blocked', 'awaiting_approval', 'done', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_LANE_STATES: LaneState[] = ['done', 'failed', 'cancelled'];

// ── Feature gate & index bootstrap ───────────────────────────────────────────

export function isLedgerEnabled(): boolean {
  return isHarnessFeatureEnabled('FEATURE_LEDGER_V1', true);
}

let indexesEnsured: Promise<void> | null = null;

async function ensureIndexes(): Promise<void> {
  indexesEnsured ??= (async () => {
    const db = await getDb();
    const col = db.collection<LaneRecord>(COLLECTION);
    await col.createIndex({ source: 1, sourceId: 1 }, { unique: true });
    await col.createIndex({ state: 1, heartbeatAt: 1 });
    await col.createIndex({ laneNo: 1 }, { unique: true });
    await col.createIndex({ completedAt: 1 });
  })().catch((err) => {
    indexesEnsured = null;
    console.warn('[TaskLedger] ensureIndexes failed:', (err as Error).message);
  }) as Promise<void>;
  await indexesEnsured;
}

async function nextLaneNo(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COUNTERS_COLLECTION).findOneAndUpdate(
    { _id: 'laneNo' as never },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return (res?.seq as number) ?? 1;
}

// ── Core API (throwing versions — used by tools/tests) ───────────────────────

export async function openLane(input: OpenLaneInput): Promise<LaneRecord> {
  await ensureIndexes();
  const db = await getDb();
  const now = new Date();
  const state = input.state ?? 'queued';
  const record: LaneRecord = {
    laneId: `lane-${randomUUID()}`,
    laneNo: await nextLaneNo(),
    source: input.source,
    sourceId: input.sourceId,
    goal: input.goal.slice(0, GOAL_MAX_LEN),
    agentId: input.agentId,
    threadId: input.threadId,
    state,
    priority: input.priority ?? 0,
    budget: input.budgetCapUsd !== undefined ? { capUsd: input.budgetCapUsd, spentUsd: 0 } : undefined,
    claims: input.claims ?? [],
    heartbeatAt: now,
    staleAfterMs: input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    milestones: [{ at: now, note: `lane opened (${state})` }],
    artifacts: [],
    plans: [],
    parent: input.parent,
    createdAt: now,
    ...(state === 'running' ? { startedAt: now } : {}),
    meta: input.meta,
  };
  await db.collection<LaneRecord>(COLLECTION).insertOne(record);
  return record;
}

export async function getLane(laneRef: string | number): Promise<LaneRecord | null> {
  const db = await getDb();
  const filter = typeof laneRef === 'number' || /^\d+$/.test(String(laneRef))
    ? { laneNo: Number(laneRef) }
    : { laneId: String(laneRef) };
  return db.collection<LaneRecord>(COLLECTION).findOne(filter);
}

export async function findLaneBySource(
  source: LaneSource,
  sourceId: string,
): Promise<LaneRecord | null> {
  const db = await getDb();
  return db.collection<LaneRecord>(COLLECTION).findOne({ source, sourceId });
}

/**
 * Validated state transition. Throws on an illegal move so tests catch
 * state-machine violations; adapter wrappers below swallow errors.
 */
export async function transitionLane(
  laneRef: string | number,
  to: LaneState,
  opts: { error?: string; milestone?: string; artifacts?: LaneArtifactRef[] } = {},
): Promise<LaneRecord> {
  const lane = await getLane(laneRef);
  if (!lane) throw new Error(`Lane not found: ${laneRef}`);
  if (!VALID_TRANSITIONS[lane.state].includes(to)) {
    throw new Error(`Illegal lane transition ${lane.state} → ${to} (lane #${lane.laneNo})`);
  }

  const now = new Date();
  const set: Record<string, unknown> = { state: to, heartbeatAt: now };
  if (to === 'running' && !lane.startedAt) set.startedAt = now;
  if (TERMINAL_LANE_STATES.includes(to)) set.completedAt = now;
  if (opts.error) set.error = opts.error;

  const push: Record<string, unknown> = {
    milestones: { at: now, note: opts.milestone ?? `→ ${to}` },
    ...(opts.artifacts?.length ? { artifacts: { $each: opts.artifacts } } : {}),
  };

  const db = await getDb();
  await db.collection<LaneRecord>(COLLECTION).updateOne(
    { laneId: lane.laneId },
    { $set: set, $push: push as never },
  );

  const updated = { ...lane, ...set, state: to } as LaneRecord;
  // Etap 5: a terminal lane holds no resources — release its claim leases so
  // queued lanes waiting on the same resource can proceed.
  if (TERMINAL_LANE_STATES.includes(to)) void releaseClaims(lane.laneId);
  if (PUSH_STATES.includes(to)) void pushLaneNotification(updated);
  return updated;
}

export async function touchLane(laneRef: string | number): Promise<void> {
  const db = await getDb();
  const filter = typeof laneRef === 'number' ? { laneNo: laneRef } : { laneId: String(laneRef) };
  await db.collection<LaneRecord>(COLLECTION).updateOne(
    { ...filter, state: { $in: ['queued', 'running', 'blocked', 'awaiting_approval'] } },
    { $set: { heartbeatAt: new Date() } },
  );
}

export async function addLaneMilestone(laneRef: string | number, note: string): Promise<void> {
  const lane = await getLane(laneRef);
  if (!lane) return;
  const db = await getDb();
  await db.collection<LaneRecord>(COLLECTION).updateOne(
    { laneId: lane.laneId },
    { $set: { heartbeatAt: new Date() }, $push: { milestones: { at: new Date(), note: note.slice(0, 300) } } },
  );
}

export async function setLanePriority(laneRef: string | number, priority: number): Promise<LaneRecord | null> {
  const lane = await getLane(laneRef);
  if (!lane) return null;
  const db = await getDb();
  await db.collection<LaneRecord>(COLLECTION).updateOne(
    { laneId: lane.laneId },
    { $set: { priority } },
  );
  return { ...lane, priority };
}

export async function requestLaneFlag(
  laneRef: string | number,
  flag: 'pauseRequested' | 'cancelRequested',
  value = true,
): Promise<LaneRecord | null> {
  const lane = await getLane(laneRef);
  if (!lane) return null;
  const db = await getDb();
  await db.collection<LaneRecord>(COLLECTION).updateOne(
    { laneId: lane.laneId },
    { $set: { [flag]: value } },
  );
  return { ...lane, [flag]: value };
}

export async function listLanes(
  opts: { states?: LaneState[]; limit?: number } = {},
): Promise<LaneRecord[]> {
  const db = await getDb();
  const filter = opts.states?.length ? { state: { $in: opts.states } } : {};
  return db.collection<LaneRecord>(COLLECTION)
    .find(filter)
    .sort({ priority: -1, createdAt: -1 })
    .limit(opts.limit ?? 50)
    .toArray();
}

// ── Kill switch ──────────────────────────────────────────────────────────────

export async function setKillSwitch(active: boolean): Promise<void> {
  const db = await getDb();
  await db.collection(SETTINGS_COLLECTION).updateOne(
    { _id: 'global' as never },
    { $set: { killSwitch: active, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function isKillSwitchActive(): Promise<boolean> {
  const db = await getDb();
  const doc = await db.collection(SETTINGS_COLLECTION).findOne({ _id: 'global' as never });
  return doc?.killSwitch === true;
}

// ── Stale reconciliation ─────────────────────────────────────────────────────

/**
 * Running/queued lanes whose heartbeat exceeded their staleAfterMs are closed
 * as failed(stale). Called lazily from digest reads — no extra cron needed.
 */
export async function reconcileStaleLanes(): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const candidates = await db.collection<LaneRecord>(COLLECTION)
    // Durable-owned lanes are excluded at the QUERY, not skipped in the loop:
    // this reconciler judges liveness from a heartbeat, and a durable job's
    // liveness is a fact the substrate already establishes with leases,
    // attempts and WORKER_LOST. Two authorities answering the same question is
    // how a running job ends up recorded as failed. See `LaneRecord.owner`.
    .find({ state: { $in: ['queued', 'running'] }, owner: { $ne: 'durable' } })
    .toArray();

  let reconciled = 0;
  for (const lane of candidates) {
    if (now - lane.heartbeatAt.getTime() > lane.staleAfterMs) {
      await db.collection<LaneRecord>(COLLECTION).updateOne(
        { laneId: lane.laneId, state: lane.state },
        {
          $set: {
            state: 'failed' as LaneState,
            error: `stale: no heartbeat for ${Math.round((now - lane.heartbeatAt.getTime()) / 1000)}s`,
            completedAt: new Date(),
          },
          $push: { milestones: { at: new Date(), note: 'reconciled as stale → failed' } },
        },
      );
      void releaseClaims(lane.laneId);
      reconciled += 1;
    }
  }
  return reconciled;
}

// ── Digest ───────────────────────────────────────────────────────────────────

export async function getLedgerDigest(
  opts: { finishedLimit?: number; markDigested?: boolean } = {},
): Promise<LedgerDigest> {
  if (!isLedgerEnabled()) {
    return {
      enabled: false, killSwitch: false, active: [], attention: [], recentlyFinished: [],
      counts: { queued: 0, running: 0, blocked: 0, awaiting_approval: 0 },
      text: 'Task Ledger disabled (FEATURE_LEDGER_V1=false).',
    };
  }

  await reconcileStaleLanes().catch(() => 0);

  const db = await getDb();
  const [active, attention, finished, killSwitch] = await Promise.all([
    listLanes({ states: ['queued', 'running'] }),
    listLanes({ states: ['blocked', 'awaiting_approval'] }),
    db.collection<LaneRecord>(COLLECTION)
      .find({ state: { $in: TERMINAL_LANE_STATES }, digestedAt: { $exists: false } })
      .sort({ completedAt: -1 })
      .limit(opts.finishedLimit ?? 10)
      .toArray(),
    isKillSwitchActive(),
  ]);

  if (opts.markDigested !== false && finished.length > 0) {
    await db.collection<LaneRecord>(COLLECTION).updateMany(
      { laneId: { $in: finished.map((l) => l.laneId) } },
      { $set: { digestedAt: new Date() } },
    );
  }

  const counts = {
    queued: active.filter((l) => l.state === 'queued').length,
    running: active.filter((l) => l.state === 'running').length,
    blocked: attention.filter((l) => l.state === 'blocked').length,
    awaiting_approval: attention.filter((l) => l.state === 'awaiting_approval').length,
  };

  return {
    enabled: true,
    killSwitch,
    active,
    attention,
    recentlyFinished: finished,
    counts,
    text: renderDigestText({ active, attention, finished, counts, killSwitch }),
  };
}

function laneLine(l: LaneRecord): string {
  const age = Math.round((Date.now() - l.createdAt.getTime()) / 1000);
  const dur = l.completedAt
    ? `${Math.round((l.completedAt.getTime() - l.createdAt.getTime()) / 1000)}s`
    : `${age}s ago`;
  const err = l.error ? ` — ${l.error.slice(0, 120)}` : '';
  return `#${l.laneNo} [${l.state}] ${l.source}/${l.agentId ?? '-'} · ${l.goal.slice(0, 100)} (${dur})${err}`;
}

function renderDigestText(input: {
  active: LaneRecord[]; attention: LaneRecord[]; finished: LaneRecord[];
  counts: LedgerDigest['counts']; killSwitch: boolean;
}): string {
  const lines: string[] = [];
  if (input.killSwitch) lines.push('🛑 KILL SWITCH ACTIVE — new lanes are paused. Use ledger_control(resume_all).');
  lines.push(
    `Lanes: ${input.counts.running} running, ${input.counts.queued} queued, ` +
    `${input.counts.blocked} blocked, ${input.counts.awaiting_approval} awaiting approval.`,
  );
  if (input.attention.length) {
    lines.push('NEEDS ATTENTION:');
    lines.push(...input.attention.map(laneLine));
  }
  if (input.finished.length) {
    lines.push('FINISHED SINCE LAST CHECK:');
    lines.push(...input.finished.map(laneLine));
  }
  if (input.active.length) {
    lines.push('IN PROGRESS:');
    lines.push(...input.active.map(laneLine));
  }
  if (lines.length === 1 && !input.attention.length && !input.finished.length && !input.active.length) {
    return 'No background lanes.';
  }
  return lines.join('\n');
}

// ── Push notifications (n8n webhook → Telegram) ──────────────────────────────

async function pushLaneNotification(lane: LaneRecord): Promise<void> {
  const url = process.env.LEDGER_PUSH_WEBHOOK_URL;
  if (!url || !isLedgerEnabled()) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'lane_state_change',
        laneNo: lane.laneNo,
        laneId: lane.laneId,
        state: lane.state,
        source: lane.source,
        agentId: lane.agentId,
        goal: lane.goal.slice(0, 200),
        error: lane.error,
        at: new Date().toISOString(),
        text: laneLine(lane),
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.warn('[TaskLedger] push notification failed:', (err as Error).message);
  }
}

// ── Fail-safe adapter API (used by lifecycle writers) ────────────────────────
// These never throw and no-op when the feature flag is off, so the writers'
// own logic is untouched by ledger availability.

export async function ledgerOpenLane(input: OpenLaneInput): Promise<string | undefined> {
  if (!isLedgerEnabled()) return undefined;
  try {
    const lane = await openLane(input);
    return lane.laneId;
  } catch (err) {
    console.warn('[TaskLedger] openLane failed:', (err as Error).message);
    return undefined;
  }
}

export async function ledgerTransitionBySource(
  source: LaneSource,
  sourceId: string,
  to: LaneState,
  opts: { error?: string; milestone?: string; artifacts?: LaneArtifactRef[] } = {},
): Promise<void> {
  if (!isLedgerEnabled()) return;
  try {
    const lane = await findLaneBySource(source, sourceId);
    if (!lane) return;
    if (lane.state === to || TERMINAL_LANE_STATES.includes(lane.state)) return;
    // Writers may report done/failed straight from queued (fast failure paths).
    if (lane.state === 'queued' && ['done', 'blocked', 'awaiting_approval'].includes(to)) {
      await transitionLane(lane.laneId, 'running', { milestone: 'implicit start' });
    }
    await transitionLane(lane.laneId, to, opts);
  } catch (err) {
    console.warn('[TaskLedger] transition failed:', (err as Error).message);
  }
}

/**
 * Hand this lane over to a durable job (F6 work item 4).
 *
 * After this the Ledger is a READ MODEL for that work: it mirrors what the
 * substrate reports and stops judging liveness for itself. Called by whichever
 * dispatcher accepted the job, right after it has a jobId, so there is no window
 * in which a lane is durable-backed but still being timed by a heartbeat.
 */
export async function ledgerMarkDurable(
  source: LaneSource,
  sourceId: string,
  durableJobId: string,
): Promise<void> {
  if (!isLedgerEnabled()) return;
  try {
    const db = await getDb();
    await db.collection<LaneRecord>(COLLECTION).updateOne(
      { source, sourceId },
      {
        $set: { owner: 'durable' as const, durableJobId },
        $push: { milestones: { at: new Date(), note: `durable job ${durableJobId} owns this lane` } },
      },
    );
  } catch (err) {
    console.warn('[TaskLedger] markDurable failed:', (err as Error).message);
  }
}

/**
 * Mirror a durable job's current state onto its lane.
 *
 * Deliberately narrower than `ledgerTransitionBySource`: it refuses to move a
 * lane the substrate does not own, so a projection can never be used to
 * overrule the thing it is projecting. Non-terminal states go through here;
 * terminal ones keep using the ordinary transition, because closing a lane also
 * releases its claims and fires notifications.
 */
export async function ledgerProjectDurableState(
  source: LaneSource,
  sourceId: string,
  to: Extract<LaneState, 'running' | 'awaiting_approval' | 'blocked'>,
  milestone?: string,
): Promise<void> {
  if (!isLedgerEnabled()) return;
  try {
    const lane = await findLaneBySource(source, sourceId);
    if (!lane || lane.owner !== 'durable') return;
    if (lane.state === to || TERMINAL_LANE_STATES.includes(lane.state)) return;
    await transitionLane(lane.laneId, to, { milestone: milestone ?? `durable → ${to}` });
  } catch (err) {
    console.warn('[TaskLedger] projection failed:', (err as Error).message);
  }
}

export async function ledgerTouchBySource(source: LaneSource, sourceId: string): Promise<void> {
  if (!isLedgerEnabled()) return;
  try {
    const lane = await findLaneBySource(source, sourceId);
    if (lane) await touchLane(lane.laneId);
  } catch { /* fail-safe */ }
}

/** One-shot lane for instantaneous work (cron triggers): open + close in one go. */
export async function ledgerRecordEphemeral(
  input: Omit<OpenLaneInput, 'state'> & { outcome: 'done' | 'failed'; error?: string; milestone?: string },
): Promise<void> {
  if (!isLedgerEnabled()) return;
  try {
    const lane = await openLane({ ...input, state: 'running' });
    await transitionLane(lane.laneId, input.outcome, {
      error: input.error,
      milestone: input.milestone,
    });
  } catch (err) {
    console.warn('[TaskLedger] ephemeral lane failed:', (err as Error).message);
  }
}
