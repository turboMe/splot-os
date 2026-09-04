/**
 * F6 cutover — durable dispatch for async delegation.
 *
 * WHAT THIS REPLACES
 * ------------------
 * `startAsyncDelegation` ends in `void executeDelegation(...)`: a floating
 * promise in this process. It has three properties nobody chose, they were just
 * what a bare `void` gives you — the work is lost on restart, there is no handle
 * to cancel it, and the only record that it ever existed is a Mongo row that
 * says `running` forever once the process dies. The V2 substrate already fixes
 * all three; until now nothing routed real traffic into it.
 *
 * THE SEAM IS THE SERVICE, NOT THE CALL SITES
 * -------------------------------------------
 * `delegate_task` calls `startAsyncDelegation` from four places with the same
 * shape. Cutting over inside the service moves all four at once and leaves the
 * tool untouched, so the rollback is one flag rather than four reverts.
 *
 * FAIL-OPEN, DELIBERATELY
 * -----------------------
 * `dispatchDurableDelegation` returns `null` for anything it cannot serve —
 * flag off, no composition root, unknown capability, store unreachable — and the
 * caller falls straight back to the legacy path. A durable substrate that
 * silently swallowed delegations it could not route would be strictly worse than
 * the fire-and-forget it replaces.
 *
 * WHO MAY BE ROUTED
 * -----------------
 * Only a capability the composition root can resolve (`config/capability-routing.ts`,
 * operator allowlist). This is the same gate the lane router uses, consulted here
 * BEFORE accepting — because the router's own fallback is "use the default
 * agent", and for a pinned delegation that would mean legacy asked for
 * `chefAgent` and got `researcherAgent` without anyone saying so.
 *
 * THE RESULT STILL COMES BACK THE OLD WAY
 * ---------------------------------------
 * Legacy's contract is not "a jobId" — it is a pending message landing in the
 * caller's thread and an `async_delegations` row reaching a terminal status. The
 * bridge below keeps that contract while the execution moves, so nothing
 * downstream (meta-agent pending updates, Task Ledger, GoalContract) has to know
 * a cutover happened. The two stores are separate databases, so this is a
 * cross-boundary projection with an idempotency key, not a transaction.
 */
import type { Db, MongoClient } from 'mongodb';

import { getDb } from '../lib/mongo.js';
import { queuePendingMessage } from './pending-message-queue.js';
import { ledgerProjectDurableState, ledgerTransitionBySource } from './task-ledger.js';
import { completeGoalContract, evaluateCompletion, recordEvidence } from './goal-tracker.js';

const FLAG = 'FEATURE_ORCHESTRATION_V2_DELEGATION';

/** Mirrors the fields this module needs from `services/async-delegation.ts`. */
export interface DurableDelegationRequest {
  delegationId: string;
  /** Registry id of the agent legacy wants to run. Must resolve to a capability. */
  agentId: string;
  /** The prompt, already assembled by the caller. Becomes the job goal. */
  prompt: string;
  /** Owner of the work — the agent that will consume the result. */
  callerAgentId: string;
  /** Conversation the result belongs to. */
  callerThreadId: string;
}

export interface DurableDelegationDispatch {
  jobId: string;
  resourceId: string;
  conversationId: string;
}

/**
 * The composition root's half. Registered from `index.ts`, where the capability
 * registry and the V2 store singleton already live, so this service keeps no
 * dependency on the agent roster or on the mount's connection lifecycle.
 */
export interface DurableDelegationConfig {
  /** Resolve a registry agent id to a routable capability, or `null`. */
  resolveCapability: (agentId: string) => string | null;
  /** The mount's own store — never a second connection. */
  getStore: () => Promise<{ client: MongoClient; db: Db }>;
  /** Injected for tests; production passes the real command boundary. */
  accept: (
    client: MongoClient,
    db: Db,
    input: {
      resourceId: string;
      conversationId: string;
      commandId: string;
      payload: Record<string, unknown>;
      goal: string;
      capability: string;
    },
  ) => Promise<{ jobId: string }>;
  /** Read a job's phase/outcome/open question. */
  readStatus: (
    db: Db,
    resourceId: string,
    jobId: string,
  ) => Promise<DurableJobSnapshot | null>;
  /** Read a terminal job's committed result payload. */
  readResult: (db: Db, resourceId: string, jobId: string) => Promise<DurableJobResult | null>;
}

/**
 * The two read shapes, copied from what `store/queries.ts` actually returns —
 * NOT from what a result "should" look like. `error` is a structured
 * `{code, message}`, not a string; `summary` is nullable. Guessing either of
 * those produces a bridge that compiles, passes a test written from the same
 * guess, and posts `[object Object]` into the caller's thread.
 */
export interface DurableJobSnapshot {
  jobId: string;
  phase: string;
  terminalOutcome?: string | null;
  goal?: string;
  openRequest?: { requestId: string; kind?: string; action?: string; expiresAt?: Date } | null;
}

export interface DurableJobResult {
  status?: string;
  data?: unknown;
  summary?: string | null;
  error?: { code?: string; message?: string } | null;
}

let config: DurableDelegationConfig | null = null;

/** Wire the durable path. Called once, from the composition root. */
export function configureDurableDelegation(cfg: DurableDelegationConfig): void {
  config = cfg;
}

/** For tests: forget the composition. */
export function __resetDurableDelegation(): void {
  config = null;
}

export function durableDelegationEnabled(): boolean {
  return process.env[FLAG] === 'true' && process.env.FEATURE_ORCHESTRATION_V2 === 'true';
}

/**
 * Owner identity for a durable job, from the agent that owns the work.
 *
 * THE ONE definition, imported by both producers: the durable-job tools an agent
 * calls directly, and the delegation cutover below. It has to be one function
 * rather than two matching string templates, because the consequence of drift is
 * silent — a delegated job keyed differently from what `orchestration_get_job`
 * derives is not an error anywhere, it is simply a job the caller can never see
 * or answer. Owner scoping deliberately makes "not yours" and "does not exist"
 * the same answer, which is exactly what would hide the mistake.
 *
 * Keyed to the AGENT, not the end user: this system is single-tenant, and one
 * owner space per agent keeps both invocation paths consistent. Per-user
 * ownership is a separate decision that arrives with real multi-tenancy.
 */
export function durableJobOwner(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * Try to hand a delegation to the durable substrate.
 *
 * Returns the accepted job, or `null` when this delegation must stay on the
 * legacy path. Never throws: a failure to route is a fallback, not an error the
 * delegating agent should see.
 */
export async function dispatchDurableDelegation(
  request: DurableDelegationRequest,
): Promise<DurableDelegationDispatch | null> {
  if (!durableDelegationEnabled() || !config) return null;

  const capability = config.resolveCapability(request.agentId);
  if (!capability) return null;

  const resourceId = durableJobOwner(request.callerAgentId);
  const conversationId = request.callerThreadId;
  try {
    const { client, db } = await config.getStore();
    // The delegationId IS the idempotency key. A retry of the same delegation
    // therefore returns the same job instead of starting a second run of work
    // that may already be halfway through.
    const accepted = await config.accept(client, db, {
      resourceId,
      conversationId,
      commandId: `delegation:${request.delegationId}`,
      payload: { delegationId: request.delegationId, agentId: request.agentId, goal: request.prompt },
      goal: request.prompt,
      capability,
    });
    return { jobId: accepted.jobId, resourceId, conversationId };
  } catch (error) {
    console.warn(
      `[durable-delegation] falling back to legacy for ${request.delegationId}: ${(error as Error).message}`,
    );
    return null;
  }
}

// ── The completion bridge ────────────────────────────────────────────────────

const DELEGATIONS = 'async_delegations';
/** Keep the pending message small — the agent re-reads it on its next turn. */
const MAX_RESULT_CHARS = 8_000;

/** Row shape this bridge reads/writes. Deliberately narrower than DelegationRecord. */
interface BridgeRow {
  delegationId: string;
  targetAgent: string;
  taskDescription: string;
  callerThreadId: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  goalContractId?: string;
  startedAt: Date;
  v2JobId?: string;
  v2ResourceId?: string;
  /** requestIds already surfaced to the caller, so a question is asked once. */
  v2AskedRequestIds?: string[];
}

function renderResult(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  try { return JSON.stringify(data); } catch { return ''; }
}

function truncate(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${text.length} chars total)`;
}

/**
 * One pass of the bridge: for every delegation still `running` on a durable job,
 * check whether the job has settled (or is blocked on a human) and honour the
 * legacy contract if so.
 *
 * Ordering is deliberate. The pending message is queued BEFORE the row is moved
 * off `running`, because the two failures are not symmetric: a duplicate message
 * is visible noise, a lost one means the caller never learns its work finished.
 * The message carries a deterministic id derived from the delegation, so the
 * duplicate is collapsed by the queue rather than merely tolerated.
 */
export async function runDelegationCompletionBridge(): Promise<number> {
  if (!config) return 0;
  const main = await getDb();
  const rows = await main.collection<BridgeRow>(DELEGATIONS)
    .find({ status: 'running', v2JobId: { $exists: true } })
    .limit(50)
    .toArray();
  if (rows.length === 0) return 0;

  const { db } = await config.getStore();
  let settled = 0;
  for (const row of rows) {
    try {
      if (await bridgeOne(main, db, row)) settled++;
    } catch (error) {
      console.warn(`[durable-delegation] bridge ${row.delegationId}: ${(error as Error).message}`);
    }
  }
  return settled;
}

async function bridgeOne(main: Db, v2: Db, row: BridgeRow): Promise<boolean> {
  const cfg = config;
  if (!cfg || !row.v2JobId || !row.v2ResourceId) return false;
  const status = await cfg.readStatus(v2, row.v2ResourceId, row.v2JobId);
  if (!status) return false;

  const returnToThreadId = row.returnToThreadId ?? row.callerThreadId;
  const returnToAgentId = row.returnToAgentId ?? 'metaAgent';

  // A job blocked on a human is NOT a result, and it must not be reported as
  // one. Surface the question to the caller — which is an agent holding the
  // durable-job tools, so it can actually answer — and leave the row running.
  if (status.phase === 'AWAITING_USER' && status.openRequest) {
    const requestId = status.openRequest.requestId;
    // Project the wait onto the lane every pass — cheap, idempotent, and it is
    // what makes the Ledger digest say "waiting for you" instead of "running"
    // for a job that is not going to move on its own.
    await ledgerProjectDurableState(
      'async_delegation', row.delegationId, 'awaiting_approval',
      `durable job is waiting for an answer (${requestId})`,
    );
    if ((row.v2AskedRequestIds ?? []).includes(requestId)) return false;
    await queuePendingMessage({
      messageId: `delegation-question:${row.delegationId}:${requestId}`,
      threadId: returnToThreadId,
      targetAgentId: returnToAgentId,
      source: 'background_task',
      content: [
        '## Durable Delegation Needs An Answer',
        `**Agent:** ${row.targetAgent}`,
        `**Job:** ${row.v2JobId}`,
        `**Request:** ${requestId}`,
        `**Question:** ${status.openRequest.action ?? '(no text)'}`,
        '',
        'Answer with orchestration_answer_job_request; the job stays parked until then.',
      ].join('\n'),
      urgent: true,
      metadata: {
        delegationId: row.delegationId,
        type: 'durable_delegation_question',
        jobId: row.v2JobId,
        requestId,
      },
    });
    await main.collection<BridgeRow>(DELEGATIONS).updateOne(
      { delegationId: row.delegationId },
      { $addToSet: { v2AskedRequestIds: requestId } },
    );
    return false;
  }

  if (status.phase !== 'TERMINAL') {
    // Anything else the substrate is doing — dispatching, running, retrying
    // after a lost worker — is simply "running" as far as the read model is
    // concerned. Projecting it keeps a lane that came back from AWAITING_USER
    // honest rather than frozen on the last thing anyone wrote by hand.
    await ledgerProjectDurableState('async_delegation', row.delegationId, 'running');
    return false;
  }

  const result = await cfg.readResult(v2, row.v2ResourceId, row.v2JobId);
  const outcome = status.terminalOutcome ?? 'UNKNOWN_OUTCOME';
  const ok = outcome === 'COMPLETED' || outcome === 'PARTIAL';
  const text = truncate(renderResult(result?.data) || result?.summary || '');
  const durationMs = Date.now() - new Date(row.startedAt).getTime();
  const errorText = result?.error?.message
    ?? result?.error?.code
    ?? `durable job ended ${outcome}`;

  await queuePendingMessage({
    messageId: `delegation-result:${row.delegationId}`,
    threadId: returnToThreadId,
    targetAgentId: returnToAgentId,
    source: 'background_task',
    content: ok
      ? [
        '## Async Delegation Result',
        `**Agent:** ${row.targetAgent}`,
        `**Task:** ${row.taskDescription.slice(0, 200)}${row.taskDescription.length > 200 ? '...' : ''}`,
        `**Status:** ✅ ${outcome.toLowerCase()} (${(durationMs / 1000).toFixed(1)}s, durable job ${row.v2JobId})`,
        '**Result:**',
        text,
      ].join('\n')
      : [
        '## Async Delegation Failed',
        `**Agent:** ${row.targetAgent}`,
        `**Task:** ${row.taskDescription.slice(0, 200)}${row.taskDescription.length > 200 ? '...' : ''}`,
        `**Status:** ❌ ${outcome.toLowerCase()} (${(durationMs / 1000).toFixed(1)}s, durable job ${row.v2JobId})`,
        `**Error:** ${errorText}`,
      ].join('\n'),
    urgent: !ok,
    metadata: {
      delegationId: row.delegationId,
      agentId: row.targetAgent,
      durationMs,
      resultPreview: ok ? text : undefined,
      error: ok ? undefined : errorText,
      goalContractId: row.goalContractId,
      type: 'async_delegation_result',
      dispatch: 'durable',
      jobId: row.v2JobId,
      terminalOutcome: outcome,
    },
  });

  // CAS off `running`: whichever process wins does the ledger/contract work once.
  const claimed = await main.collection<BridgeRow & { status: string }>(DELEGATIONS).updateOne(
    { delegationId: row.delegationId, status: 'running' },
    {
      $set: {
        status: ok ? 'completed' : 'failed',
        ...(ok ? { result: text.slice(0, 5000), resultPreview: text } : { error: errorText }),
        completedAt: new Date(),
        durationMs,
        v2TerminalOutcome: outcome,
      },
    },
  );
  if (claimed.modifiedCount !== 1) return false;

  void ledgerTransitionBySource('async_delegation', row.delegationId, ok ? 'done' : 'failed', {
    ...(ok ? { milestone: `durable job ${row.v2JobId} ${outcome}` } : { error: errorText }),
  });
  await settleGoalContract(row.goalContractId, ok, ok ? text : errorText);
  console.log(
    `[durable-delegation] ${ok ? '✅' : '❌'} ${row.delegationId} ← job ${row.v2JobId} ${outcome}`
    + ` in ${(durationMs / 1000).toFixed(1)}s`,
  );
  return true;
}

/**
 * Close the delegation's GoalContract the same way the legacy path does. Kept
 * here rather than imported from `async-delegation.ts` because the dependency
 * runs the other way (that module calls this one), and best-effort either way:
 * a contract bookkeeping failure must not strand a delivered result.
 */
async function settleGoalContract(
  goalContractId: string | undefined,
  ok: boolean,
  detail: string,
): Promise<void> {
  if (!goalContractId) return;
  const summary = detail.replace(/\s+/g, ' ').trim().slice(0, 500)
    || (ok ? 'Durable delegation returned an empty response.' : 'Durable delegation failed.');
  try {
    await recordEvidence(goalContractId, {
      stepId: 'step-2',
      type: ok ? 'for' : 'against',
      description: summary,
      stepStatus: ok ? 'done' : 'failed',
    });
    await recordEvidence(goalContractId, {
      stepId: 'step-3',
      type: ok ? 'for' : 'against',
      description: ok
        ? 'Durable delegated job returned a result to the caller.'
        : 'Durable delegated job did not return an acceptable result.',
      stepStatus: ok ? 'done' : 'failed',
    });
    await completeGoalContract(goalContractId, ok ? 'completed' : 'failed', summary);
    await evaluateCompletion(goalContractId);
  } catch (error) {
    console.warn('[durable-delegation] GoalContract update failed:', (error as Error).message);
  }
}
