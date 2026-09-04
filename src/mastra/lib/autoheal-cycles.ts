/**
 * Autoheal Cycle Store (Etap 1) — grupowanie problemów po sygnaturze.
 *
 * Zamiast luźnych ticketów `heal-<sig>-<ts>` (każdy = nowy worktree),
 * jedna sygnatura błędu = jeden CYKL. Kolejne wystąpienia tej samej
 * sygnatury dopisują OBSERWACJĘ do istniejącego, aktywnego cyklu —
 * bez tworzenia nowego worktree.
 *
 * Model wg ideas/autoheal-update.md (Phase 2: Dedup & Cycle Grouping).
 *
 * Ten moduł jest WARSTWĄ DIAGNOSTYCZNĄ (Mongo). Rollback/runtime NIGDY
 * nie zależą od tych kolekcji — krytyczny stan żyje w `.deploy/autoheal-state.json`.
 */

import { execSync } from 'child_process';
import { getDb } from './mongo.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type AutohealCycleStatus =
  | 'observed'
  | 'diagnosing'
  | 'repairing'
  | 'candidate_building'
  | 'candidate_running'
  | 'canary'
  | 'promoted'
  | 'rolled_back'
  | 'retrying'
  | 'failed_needs_human';

/** Stany terminalne — cykl o takim statusie NIE jest już aktywny. */
export const TERMINAL_CYCLE_STATUSES: AutohealCycleStatus[] = ['promoted', 'failed_needs_human'];

export interface AutohealCycle {
  cycleId: string;
  signature: string;
  status: AutohealCycleStatus;
  /** Commit, z którego działał healthy runtime w chwili otwarcia cyklu. */
  stableCommit: string;
  repairBranch: 'autoheal/repair';
  currentCandidateCommit?: string;
  /** Liczba zaobserwowanych wystąpień tej sygnatury w ramach cyklu. */
  observationCount: number;
  /** Ticket auto_healing_tickets powiązany z pierwszym triggerem (Etap 7 most). */
  ticketId?: string;
  createdAt: string;
  updatedAt: string;
  lastObservedAt: string;
}

export interface AutohealObservation {
  source: string;
  origin?: string;
  errorMessage: string;
  stackHint?: string;
  metadata?: Record<string, unknown>;
}

export interface AutohealRuntimeEvent extends AutohealObservation {
  cycleId: string;
  signature: string;
  createdAt: string;
}

export interface AutohealAttempt {
  attemptId: string;
  cycleId: string;
  signature: string;
  status: 'repairing' | 'candidate_building' | 'candidate_running' | 'canary' | 'promoted' | 'rolled_back' | 'failed';
  candidateCommit?: string;
  failureReason?: string;
  logs?: string;
  healthTrace?: string;
  exitCode?: number;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Krótki SHA aktualnego HEAD source repo. Best-effort — nie wywala cyklu. */
function currentStableCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: AGENTIC_AGENTS_REPO,
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Store ──────────────────────────────────────────────────────────────────

/**
 * Znajdź aktywny cykl dla sygnatury i dopisz obserwację, albo utwórz nowy cykl.
 *
 * Aktywny = status NIE jest terminalny (promoted/failed_needs_human).
 * Zwraca cykl oraz flagę `created` (true gdy powstał nowy cykl).
 */
export async function getOrCreateCycle(
  signature: string,
  observation: AutohealObservation,
): Promise<{ cycle: AutohealCycle; created: boolean }> {
  const db = await getDb();
  const cycles = db.collection<AutohealCycle>('autoheal_cycles');
  const ts = nowIso();

  const active = await cycles.findOne({
    signature,
    status: { $nin: TERMINAL_CYCLE_STATUSES },
  });

  if (active) {
    await cycles.updateOne(
      { cycleId: active.cycleId },
      { $inc: { observationCount: 1 }, $set: { updatedAt: ts, lastObservedAt: ts } },
    );
    await recordRuntimeEvent(active.cycleId, signature, observation);
    return {
      cycle: { ...active, observationCount: active.observationCount + 1, updatedAt: ts, lastObservedAt: ts },
      created: false,
    };
  }

  const cycle: AutohealCycle = {
    cycleId: `cycle-${signature}-${Date.now()}`,
    signature,
    status: 'observed',
    stableCommit: currentStableCommit(),
    repairBranch: 'autoheal/repair',
    observationCount: 1,
    createdAt: ts,
    updatedAt: ts,
    lastObservedAt: ts,
  };
  await cycles.insertOne(cycle as any);
  await recordRuntimeEvent(cycle.cycleId, signature, observation);
  return { cycle, created: true };
}

/** Dopisuje surową obserwację runtime do `autoheal_runtime_events`. */
export async function recordRuntimeEvent(
  cycleId: string,
  signature: string,
  observation: AutohealObservation,
): Promise<void> {
  const db = await getDb();
  const event: AutohealRuntimeEvent = {
    cycleId,
    signature,
    source: observation.source,
    origin: observation.origin,
    errorMessage: observation.errorMessage.slice(0, 2000),
    stackHint: observation.stackHint?.slice(0, 2000),
    metadata: observation.metadata,
    createdAt: nowIso(),
  };
  await db.collection<AutohealRuntimeEvent>('autoheal_runtime_events').insertOne(event as any);
}

/** Powiązuje ticket auto_healing_tickets z cyklem (most do Etapu 7). */
export async function linkTicketToCycle(cycleId: string, ticketId: string): Promise<void> {
  const db = await getDb();
  await db.collection<AutohealCycle>('autoheal_cycles').updateOne(
    { cycleId },
    { $set: { ticketId, updatedAt: nowIso() } },
  );
}

/** Aktualizuje status cyklu (+ opcjonalny patch pól). */
export async function updateCycleStatus(
  cycleId: string,
  status: AutohealCycleStatus,
  patch: Partial<AutohealCycle> = {},
): Promise<void> {
  const db = await getDb();
  await db.collection<AutohealCycle>('autoheal_cycles').updateOne(
    { cycleId },
    { $set: { ...patch, status, updatedAt: nowIso() } },
  );
}

/** Dodaje próbę naprawy (attempt) do cyklu. */
export async function addAttempt(
  cycleId: string,
  signature: string,
  attempt: Partial<AutohealAttempt> & { status: AutohealAttempt['status'] },
): Promise<AutohealAttempt> {
  const db = await getDb();
  const ts = nowIso();
  const doc: AutohealAttempt = {
    attemptId: attempt.attemptId ?? `attempt-${signature}-${Date.now()}`,
    cycleId,
    signature,
    status: attempt.status,
    candidateCommit: attempt.candidateCommit,
    failureReason: attempt.failureReason,
    logs: attempt.logs,
    healthTrace: attempt.healthTrace,
    exitCode: attempt.exitCode,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.collection<AutohealAttempt>('autoheal_attempts').insertOne(doc as any);
  return doc;
}

// ── Read-only (diagnostyka) ──────────────────────────────────────────────────

export async function getCycle(cycleId: string): Promise<AutohealCycle | null> {
  const db = await getDb();
  return db.collection<AutohealCycle>('autoheal_cycles').findOne({ cycleId }) as Promise<AutohealCycle | null>;
}

export async function listCycles(limit = 50): Promise<AutohealCycle[]> {
  const db = await getDb();
  return db.collection<AutohealCycle>('autoheal_cycles')
    .find({})
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray() as unknown as Promise<AutohealCycle[]>;
}

export async function listAttempts(cycleId: string, limit = 50): Promise<AutohealAttempt[]> {
  const db = await getDb();
  return db.collection<AutohealAttempt>('autoheal_attempts')
    .find({ cycleId })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray() as unknown as Promise<AutohealAttempt[]>;
}

export async function listRuntimeEvents(cycleId: string, limit = 100): Promise<AutohealRuntimeEvent[]> {
  const db = await getDb();
  return db.collection<AutohealRuntimeEvent>('autoheal_runtime_events')
    .find({ cycleId })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray() as unknown as Promise<AutohealRuntimeEvent[]>;
}
