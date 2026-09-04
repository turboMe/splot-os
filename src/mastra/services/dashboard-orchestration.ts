/**
 * Dashboard reader for durable orchestration V2 jobs.
 *
 * The operator counterpart to the agent-facing durable-job tools: until now the
 * only way to see what the V2 substrate was doing was to curl `/v2/...` with a
 * hand-built `x-resource-id` header, or read Mongo directly. A durable job you
 * cannot observe is a durable job you cannot trust.
 *
 * NAMING WARNING: this is orchestration V2. The existing `/dashboard/v2/*`
 * endpoints are the ANALYTICS dashboard v2 (`dashboard-analytics-v2.ts`) and are
 * a completely unrelated thing that merely shares the digit. These routes live
 * under `/dashboard/orchestration/*` on purpose.
 *
 * READ-ONLY. Nothing here starts, wakes, cancels or mutates a job — a status
 * read must never be a side effect (§8.2). Operator control actions, if they are
 * ever wanted, belong behind real auth, not on this surface.
 *
 * SCOPE / EXPOSURE: this is an operator console for a single-tenant system, so it
 * reads ACROSS owners rather than binding one `resourceId` from auth the way the
 * agent tools and `/v2` handlers do. That is a deliberate difference and the
 * reason it must stay behind the dashboard's existing (local, unauthenticated)
 * posture — do not expose it publicly. Goals are truncated in the list view and
 * the result payload is only returned for an explicitly requested job.
 */
import { COLLECTIONS, type JobDoc } from '../orchestration/store/collections.js';
import { getJobResult } from '../orchestration/store/queries.js';
import { getV2Store } from '../orchestration/http/mastra-routes.js';

/** Enough to recognize a job in a list without dumping user content. */
const MAX_GOAL_CHARS = 160;

export interface OrchestrationDashboardJob {
  jobId: string;
  resourceId: string;
  conversationId: string;
  phase: string;
  controlState: string;
  terminalOutcome: string | null;
  pendingTerminalOutcome: string | null;
  goal: string;
  goalTruncated: boolean;
  parentJobId: string | null;
  planVersion: number;
  stateVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrchestrationDashboardSummary {
  /** False when the feature flag is off — the UI should say "disabled", not "empty". */
  enabled: boolean;
  /** Set when the store is configured but unreachable, so the UI can distinguish it. */
  unavailable?: string;
  counts: {
    total: number;
    running: number;
    terminal: number;
    completed: number;
    failed: number;
    cancelled: number;
    awaitingUser: number;
  };
  jobs: OrchestrationDashboardJob[];
}

export interface OrchestrationDashboardFilters {
  resourceId?: string;
  conversationId?: string;
  phase?: string;
  limit?: number;
}

function v2Enabled(): boolean {
  return process.env.FEATURE_ORCHESTRATION_V2 === 'true';
}

/**
 * Flag off is a legitimate state, not an error: the substrate genuinely is not
 * running, and the caller must be able to tell that apart from "running with
 * nothing in it".
 */
function disabledSummary(): OrchestrationDashboardSummary {
  return {
    enabled: false,
    counts: { total: 0, running: 0, terminal: 0, completed: 0, failed: 0, cancelled: 0, awaitingUser: 0 },
    jobs: [],
  };
}

function toDashboardJob(job: JobDoc): OrchestrationDashboardJob {
  const goal = job.goal ?? '';
  return {
    jobId: job._id,
    resourceId: job.resourceId,
    conversationId: job.conversationId,
    phase: job.phase,
    controlState: job.controlState,
    terminalOutcome: job.terminalOutcome ?? null,
    pendingTerminalOutcome: job.pendingTerminalOutcome ?? null,
    goal: goal.length > MAX_GOAL_CHARS ? `${goal.slice(0, MAX_GOAL_CHARS)}…` : goal,
    goalTruncated: goal.length > MAX_GOAL_CHARS,
    parentJobId: job.parentJobId ?? null,
    planVersion: job.planVersion,
    stateVersion: job.stateVersion,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function getOrchestrationDashboardSummary(
  filters: OrchestrationDashboardFilters = {},
): Promise<OrchestrationDashboardSummary> {
  if (!v2Enabled()) return disabledSummary();

  let db;
  try {
    ({ db } = await getV2Store());
  } catch (error) {
    // Configured but unreachable (e.g. no replica set): report it instead of
    // presenting an empty board that looks like "no work".
    return { ...disabledSummary(), enabled: true, unavailable: (error as Error).message };
  }

  const filter: Record<string, unknown> = {};
  if (filters.resourceId) filter.resourceId = filters.resourceId;
  if (filters.conversationId) filter.conversationId = filters.conversationId;
  if (filters.phase) filter.phase = filters.phase;

  const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const docs = await jobs.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();

  // Counts describe the whole (filtered) board, not just the returned page —
  // otherwise a limit would silently understate how much work exists.
  const [total, terminal, completed, failed, cancelled, awaitingUser] = await Promise.all([
    jobs.countDocuments(filter),
    jobs.countDocuments({ ...filter, phase: 'TERMINAL' }),
    jobs.countDocuments({ ...filter, terminalOutcome: 'COMPLETED' }),
    jobs.countDocuments({ ...filter, terminalOutcome: 'FAILED' }),
    jobs.countDocuments({ ...filter, terminalOutcome: 'CANCELLED' }),
    jobs.countDocuments({ ...filter, phase: 'AWAITING_USER' }),
  ]);

  return {
    enabled: true,
    counts: { total, running: Math.max(0, total - terminal), terminal, completed, failed, cancelled, awaitingUser },
    jobs: docs.map(toDashboardJob),
  };
}

export interface OrchestrationDashboardJobDetail extends OrchestrationDashboardJob {
  /** Full, untruncated goal — the list view truncates it. */
  fullGoal: string;
  result: {
    status: string;
    data: unknown;
    summary: string | null;
    error: { code?: string; message?: string } | null;
    committedAt: Date;
  } | null;
}

/**
 * One job with its committed result. Returns null when the job does not exist,
 * so the route can answer 404 without leaking anything else.
 */
export async function getOrchestrationDashboardJob(
  jobId: string,
): Promise<OrchestrationDashboardJobDetail | null> {
  if (!v2Enabled()) return null;
  const { db } = await getV2Store();
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOne({ _id: jobId });
  if (!job) return null;

  // The operator view reads across owners, so the result is fetched under the
  // job's OWN resourceId rather than an ambient one.
  const result = await getJobResult(db, job.resourceId, jobId);

  return {
    ...toDashboardJob(job),
    fullGoal: job.goal ?? '',
    result: result
      ? {
          status: result.status,
          data: result.data,
          summary: result.summary,
          error: result.error,
          committedAt: result.committedAt,
        }
      : null,
  };
}
