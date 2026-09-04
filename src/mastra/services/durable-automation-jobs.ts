/**
 * F6 cutover, work item 2 — the Automation Golden Path on durable jobs.
 *
 * WHAT WAS WRONG
 * --------------
 * `startAutomationJob` ended in `void executeAutomationJob(...)` — the same
 * fire-and-forget shape the delegation cutover just removed, but with a worse
 * blast radius, because this pipeline DEPLOYS to n8n. Three concrete defects:
 *
 *  1. **The input existed only in a closure.** The `automation_jobs` row survived
 *     a restart; the work it described could not be re-run by anybody, so the row
 *     was a receipt for something that no longer existed. Nothing can have
 *     durable attempts without the input being durable first.
 *  2. **Cancel did not cancel.** `liveJobs` was a process-local `Map`, and the
 *     flag was only read at three points, none of them inside the Golden Path.
 *     A cancel during a build set the row to `cancelled` and then let the
 *     pipeline keep deploying and repairing — the operator's stop suppressed the
 *     REPORT, not the work.
 *  3. **No progress.** `lastHeartbeatAt` proves a process is alive; it says
 *     nothing about whether the run is at `risk_score` or three repairs deep.
 *
 * WHAT THIS ADDS
 * --------------
 * A durable job pinned to the native capability `automation_golden_path`
 * (`orchestration/execution/native-worker.ts`), so the pipeline gets the same
 * lease, fence, attempt lifecycle and stop barrier as every other V2 task —
 * without pretending to be a conversation.
 *
 * THE INPUT IS NOT COPIED INTO THE ORCHESTRATION STORE. The executor reads it
 * back from the `automation_jobs` row via `v2JobId`. Duplicating a workflow spec
 * (with its approval token) into a second database would create two copies that
 * can disagree about what is being built, and the row is already the thing every
 * existing tool reads.
 *
 * Fail-open, like the delegation cutover: anything this path cannot serve
 * returns `null` and the job runs on the legacy lane exactly as before.
 */
import type { Db, MongoClient } from 'mongodb';

import { getDb } from '../lib/mongo.js';
import { durableJobOwner } from './durable-delegation.js';
import { queuePendingMessage } from './pending-message-queue.js';
import { ledgerProjectDurableState, ledgerTransitionBySource } from './task-ledger.js';
import {
  executeAutomationGoldenPath,
  type AutomationGoldenPathInput,
  type AutomationGoldenPathResult,
} from './automation-golden-path.js';
import type { WorkerContext } from '../orchestration/store/worker.js';

const FLAG = 'FEATURE_ORCHESTRATION_V2_AUTOMATION_JOBS';
const COLLECTION = 'automation_jobs';

/** The capability name a durable automation job is pinned to. */
export const AUTOMATION_GOLDEN_PATH_CAPABILITY = 'automation_golden_path';

/**
 * Attempt window for one Golden Path build.
 *
 * Deliberately the SAME 20 minutes the legacy async automation lane already
 * used (`DEFAULT_AUTOMATION_DELEGATION_TIMEOUT_MS`), because a cutover must not
 * quietly change what the work is allowed to do. The V2 store's default is 300s
 * — a third of what a deploy/test/repair cycle has always been given — and
 * inheriting that silently would cut builds in the middle of a repair and look
 * like the pipeline got worse, not like the budget changed.
 */
export const AUTOMATION_GOLDEN_PATH_ATTEMPT_CAP_MS = Math.max(
  Number(process.env.DELEGATION_AUTOMATION_TIMEOUT_MS) || 0,
  1_200_000,
);

/** Bound on the checkpoint trail — mirrors the legacy lane's own cap. */
const MAX_PROGRESS_STEPS = 40;

/**
 * Build the checkpoint writer for one job. Used by BOTH lanes, so the trail
 * means the same thing whichever one ran the build.
 *
 * WRITES ARE SERIALIZED, and that is the whole reason this is a factory rather
 * than a one-line `updateOne`. The first version fired each `$push` concurrently
 * and the trail came back out of order — `coverage_check` before
 * `resolve_workflow` — because nothing sequences independent updates. An
 * unordered trail answers "which steps ran" but not "where did it get to", which
 * is the only question anyone asks it; worse, `$slice` would then trim by
 * arrival rather than by age. `seq` makes the order checkable on read even if a
 * write is retried.
 *
 * Still fire-and-forget from the caller's side: a durable note about where the
 * pipeline got to must never slow down or fail the pipeline it describes.
 */
export function createProgressRecorder(
  rows: { updateOne: (filter: unknown, update: unknown) => Promise<unknown> },
  jobId: string,
): (step: { name: string; status: string; message: string }) => void {
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return (step) => {
    const entry = {
      seq: seq++,
      step: step.name,
      status: step.status,
      message: step.message.slice(0, 500),
      at: new Date(),
    };
    chain = chain
      .then(() => rows.updateOne(
        { jobId },
        { $push: { progress: { $each: [entry], $slice: -MAX_PROGRESS_STEPS } } },
      ))
      .catch(() => undefined);
  };
}

export interface DurableAutomationConfig {
  getStore: () => Promise<{ client: MongoClient; db: Db }>;
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
  cancel: (
    client: MongoClient,
    db: Db,
    input: { resourceId: string; commandId: string; jobId: string },
  ) => Promise<unknown>;
  readStatus: (
    db: Db,
    resourceId: string,
    jobId: string,
  ) => Promise<{ phase: string; terminalOutcome?: string | null } | null>;
  readResult: (
    db: Db,
    resourceId: string,
    jobId: string,
  ) => Promise<{ status?: string; data?: unknown; summary?: string | null; error?: { code?: string; message?: string } | null } | null>;
}

let config: DurableAutomationConfig | null = null;

export function configureDurableAutomationJobs(cfg: DurableAutomationConfig): void {
  config = cfg;
}

export function __resetDurableAutomationJobs(): void {
  config = null;
}

export function durableAutomationJobsEnabled(): boolean {
  return process.env[FLAG] === 'true' && process.env.FEATURE_ORCHESTRATION_V2 === 'true';
}

/** Row shape this module reads/writes; narrower than `AutomationJobRecord`. */
interface AutomationRow {
  jobId: string;
  automationId: string;
  targetAgentId: string;
  approvalActorAgentId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  status: string;
  inputPreview: string;
  goldenPathInput?: AutomationGoldenPathInput;
  startedAt: Date;
  v2JobId?: string;
  v2ResourceId?: string;
  runId?: string;
  turnId?: string;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export interface DurableAutomationDispatch {
  v2JobId: string;
  resourceId: string;
  conversationId: string;
}

/**
 * Hand an automation job to the durable substrate. Returns `null` whenever the
 * legacy lane must keep it — never throws, for the same reason the delegation
 * cutover never throws: a build has a lane that always exists.
 */
export async function dispatchDurableAutomationJob(input: {
  jobId: string;
  goal: string;
  ownerAgentId: string;
  conversationId: string;
}): Promise<DurableAutomationDispatch | null> {
  if (!durableAutomationJobsEnabled() || !config) return null;
  const resourceId = durableJobOwner(input.ownerAgentId);
  try {
    const { client, db } = await config.getStore();
    const accepted = await config.accept(client, db, {
      resourceId,
      conversationId: input.conversationId,
      // The automation jobId IS the idempotency key: a retried start resumes the
      // same build instead of deploying a second workflow for one request.
      commandId: `automation:${input.jobId}`,
      payload: { automationJobId: input.jobId },
      goal: input.goal,
      capability: AUTOMATION_GOLDEN_PATH_CAPABILITY,
    });
    return { v2JobId: accepted.jobId, resourceId, conversationId: input.conversationId };
  } catch (error) {
    console.warn(
      `[durable-automation] falling back to legacy for ${input.jobId}: ${(error as Error).message}`,
    );
    return null;
  }
}

/** Cross the V2 stop barrier for a durably-dispatched automation job. */
export async function cancelDurableAutomationJob(row: {
  jobId: string;
  v2JobId?: string;
  v2ResourceId?: string;
}): Promise<void> {
  if (!config || !row.v2JobId || !row.v2ResourceId) return;
  const { client, db } = await config.getStore();
  await config.cancel(client, db, {
    resourceId: row.v2ResourceId,
    commandId: `cancel:${row.v2JobId}`,
    jobId: row.v2JobId,
  });
}

// ── The native executor ─────────────────────────────────────────────────────

/**
 * Run one attempt of the Golden Path inside a durable V2 attempt.
 *
 * `ctx.signal` is the whole point: the substrate aborts it when the lease is
 * lost, when the attempt's window closes, and when a stop command crosses the
 * barrier — so cancellation now reaches the pipeline itself rather than merely
 * changing what the row says about it.
 */
export async function automationGoldenPathExecutor(ctx: WorkerContext): Promise<unknown> {
  const main = await getDb();
  const rows = main.collection<AutomationRow>(COLLECTION);
  const row = await rows.findOne({ v2JobId: ctx.jobId });
  if (!row) {
    return {
      status: 'failed',
      error: { code: 'automation_row_missing', message: `no automation job linked to ${ctx.jobId}` },
    };
  }
  if (!row.goldenPathInput) {
    // A row written before F6 has no durable input. Failing visibly is the only
    // honest answer: re-running a build from a redacted preview would be
    // guessing at what to deploy.
    return {
      status: 'failed',
      error: {
        code: 'automation_input_missing',
        message: `automation job ${row.jobId} predates durable inputs and cannot be re-run`,
      },
    };
  }

  await rows.updateOne(
    { jobId: row.jobId, status: 'queued' },
    { $set: { status: 'running', lastHeartbeatAt: new Date() } },
  );
  void ledgerTransitionBySource('automation_job', row.jobId, 'running');

  const result = await executeAutomationGoldenPath(row.goldenPathInput, {
    actorAgentId: row.approvalActorAgentId,
    signal: ctx.signal,
    onStep: createProgressRecorder(rows as never, row.jobId),
  });

  // A build that ends `blocked` is a REAL, correct outcome of this pipeline — a
  // policy violation or a risk verdict is the system working — so it comes back
  // as a result the attempt succeeded in producing, not as a failed attempt that
  // the lane would retry. Retrying a blocked build re-runs the same refusal.
  return {
    status: 'ok',
    data: summarizeForResult(result),
    summary: `${result.status} (success=${result.success}) ${result.message}`.slice(0, 500),
  };
}

/**
 * What travels into the durable result. The full Golden Path result carries the
 * whole workflow JSON and every validator finding; the row already holds the
 * detail, so the durable copy stays a summary a human can read in a job view.
 *
 * KEYS ARE OMITTED, NEVER SET TO `undefined`. The producer envelope crosses a
 * durable JSON boundary and its validator rejects any value whose identity
 * would be lost by JSON/canonical hashing — `undefined` among them. A single
 * `failureClass: undefined` made the whole attempt `invalid_result`, the job
 * FAILED, and nothing was committed: a Golden Path that ran correctly for five
 * steps reported as a crash. Found live; invisible to a test that validated the
 * bridge against its own fake instead of the real schema.
 */
function summarizeForResult(result: AutomationGoldenPathResult): Record<string, unknown> {
  return compact({
    success: result.success,
    status: result.status,
    failureClass: result.failureClass,
    automationId: result.automationId,
    workflowId: result.workflowId,
    workflowName: result.workflowName,
    operation: result.operation,
    message: result.message,
    repairAttempts: result.repairAttempts,
    risk: result.risk ? { verdict: result.risk.verdict, score: result.risk.score } : undefined,
    lastTest: result.lastTest ? { status: result.lastTest.status } : undefined,
    steps: result.steps.map((s) => compact({ name: s.name, status: s.status })),
  });
}

/** Drop `undefined` members — see `summarizeForResult` for why this is load-bearing. */
function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

// ── The completion bridge ───────────────────────────────────────────────────

/**
 * Copy settled durable jobs back into the legacy automation contract: a terminal
 * row plus a pending message for the agent that asked for the build. Same shape
 * and same reasoning as the delegation bridge — different databases, so a polled
 * projection with an idempotency key rather than a transaction, and the message
 * is queued before the row leaves `running`.
 */
export async function runAutomationCompletionBridge(): Promise<number> {
  if (!config) return 0;
  const main = await getDb();
  const rows = main.collection<AutomationRow>(COLLECTION);
  const pending = await rows
    .find({ status: { $in: ['queued', 'running'] }, v2JobId: { $exists: true } })
    .limit(25)
    .toArray();
  if (pending.length === 0) return 0;

  const { db } = await config.getStore();
  let settled = 0;
  for (const row of pending) {
    try {
      if (await bridgeOne(main, db, row)) settled++;
    } catch (error) {
      console.warn(`[durable-automation] bridge ${row.jobId}: ${(error as Error).message}`);
    }
  }
  return settled;
}

async function bridgeOne(main: Db, v2: Db, row: AutomationRow): Promise<boolean> {
  const cfg = config;
  if (!cfg || !row.v2JobId || !row.v2ResourceId) return false;
  const status = await cfg.readStatus(v2, row.v2ResourceId, row.v2JobId);
  if (!status) return false;
  if (status.phase !== 'TERMINAL') {
    // The lane mirrors the substrate rather than being written by hand at the
    // two ends of the build — see `ledgerProjectDurableState`.
    await ledgerProjectDurableState('automation_job', row.jobId, 'running');
    return false;
  }

  const result = await cfg.readResult(v2, row.v2ResourceId, row.v2JobId);
  const outcome = status.terminalOutcome ?? 'UNKNOWN_OUTCOME';
  const payload = (result?.data ?? null) as Record<string, unknown> | null;
  // Two different questions, deliberately not collapsed: did the ATTEMPT finish
  // (`outcome`), and did the BUILD succeed (`payload.success`). A blocked
  // workflow is a COMPLETED job that produced a refusal — reporting that as a
  // failed job would make every correct policy block look like an outage.
  const attemptOk = outcome === 'COMPLETED' || outcome === 'PARTIAL';
  const buildOk = attemptOk && payload?.success === true;
  const errorText = result?.error?.message
    ?? result?.error?.code
    ?? (attemptOk ? undefined : `durable job ended ${outcome}`);
  const durationMs = Date.now() - new Date(row.startedAt).getTime();
  const preview = renderPreview(payload, outcome, errorText);
  const returnToThreadId = row.returnToThreadId;
  const returnToAgentId = row.returnToAgentId ?? row.targetAgentId;

  if (returnToThreadId) {
    await queuePendingMessage({
      messageId: `automation-result:${row.jobId}`,
      taskId: row.jobId,
      threadId: returnToThreadId,
      targetAgentId: returnToAgentId,
      source: 'automation_job',
      urgent: !buildOk,
      content: [
        buildOk ? '## Automation Job Result' : '## Automation Job Did Not Succeed',
        `Job ID: ${row.jobId}`,
        `Automation ID: ${row.automationId}`,
        `Durable job: ${row.v2JobId} (${outcome})`,
        preview,
      ].join('\n'),
      metadata: {
        type: 'automation_job_result',
        jobId: row.jobId,
        automationId: row.automationId,
        workflowId: payload?.workflowId,
        status: payload?.status,
        success: buildOk,
        dispatch: 'durable',
        terminalOutcome: outcome,
        ...(errorText ? { error: errorText } : {}),
      },
    });
  }

  const claimed = await main.collection<AutomationRow>(COLLECTION).updateOne(
    { jobId: row.jobId, status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status: attemptOk ? 'completed' : 'failed',
        ...(errorText ? { error: errorText } : {}),
        resultPreview: preview.slice(0, 5000),
        completedAt: new Date(),
        lastHeartbeatAt: new Date(),
        v2TerminalOutcome: outcome,
      },
    } as never,
  );
  if (claimed.modifiedCount !== 1) return false;

  void ledgerTransitionBySource('automation_job', row.jobId, buildOk ? 'done' : 'failed', {
    ...(buildOk
      ? { milestone: `durable job ${row.v2JobId} ${outcome}` }
      : { error: errorText ?? 'build did not succeed' }),
  });
  console.log(
    `[durable-automation] ${buildOk ? '✅' : '⚠'} ${row.jobId} ← job ${row.v2JobId} ${outcome}`
    + ` in ${(durationMs / 1000).toFixed(1)}s`,
  );
  return true;
}

function renderPreview(
  payload: Record<string, unknown> | null,
  outcome: string,
  errorText: string | undefined,
): string {
  if (!payload) {
    return `No result payload was committed (job ended ${outcome}).${errorText ? ` ${errorText}` : ''}`;
  }
  return [
    `Golden Path status: ${payload.status}`,
    `Success: ${payload.success}`,
    payload.workflowId ? `Workflow ID: ${payload.workflowId}` : '',
    payload.workflowName ? `Workflow: ${payload.workflowName}` : '',
    payload.failureClass ? `Failure class: ${payload.failureClass}` : '',
    `Repair attempts: ${payload.repairAttempts ?? 0}`,
    `Message: ${payload.message}`,
    errorText ? `Error: ${errorText}` : '',
  ].filter(Boolean).join('\n');
}
