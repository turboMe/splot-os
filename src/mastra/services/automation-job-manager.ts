/**
 * Durable Automation Golden Path jobs.
 *
 * This runs Golden Path in the Mastra process instead of shelling out through
 * bg_task. It persists state, stores a compact result preview, and wakes the
 * right agent/thread when the job completes.
 */

import { randomUUID } from 'crypto';

import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  agentIdFieldFilter,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';
import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { logHarnessEvent } from './harness-events.js';
import { compactHarnessOutput } from './harness-output-compactor.js';
import { queuePendingMessage } from './pending-message-queue.js';
import { findLaneBySource, isKillSwitchActive, ledgerMarkDurable, ledgerOpenLane, ledgerTouchBySource, ledgerTransitionBySource } from './task-ledger.js';
import { releaseClaims, waitAndAcquireClaims } from './task-ledger-scheduler.js';
import {
  executeAutomationGoldenPath,
  type AutomationGoldenPathInput,
  type AutomationGoldenPathResult,
} from './automation-golden-path.js';
import {
  cancelDurableAutomationJob,
  createProgressRecorder,
  dispatchDurableAutomationJob,
} from './durable-automation-jobs.js';

export type AutomationJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

/** One durable checkpoint from a running Golden Path (F6). */
export type AutomationJobProgress = {
  step: string;
  status: string;
  message: string;
  at: Date;
};

export type AutomationJobRecord = {
  jobId: string;
  automationId: string;
  targetAgentId: string;
  /** Trusted envelope identity; never sourced from model-visible job input. */
  approvalActorAgentId?: string;
  callerAgentId?: string;
  callerThreadId?: string;
  architectThreadId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  status: AutomationJobStatus;
  inputPreview: string;
  /**
   * The FULL Golden Path input, durably.
   *
   * Until F6 this lived only in the closure of `void executeAutomationJob(...)`,
   * which meant the row could survive a restart while the thing it describes
   * could not be re-run by anyone — the record was a receipt for work that no
   * longer existed. Nothing can have durable attempts without this.
   *
   * `inputPreview` stays redacted and is what humans and dashboards read; this
   * field is the machine copy. Legacy jobs may carry `approvalToken`; Architect
   * jobs derive authority from their trusted runtime identity and ignore it,
   * while non-Architect direct callers still use the revocable approvals row.
   */
  goldenPathInput?: AutomationGoldenPathInput;
  /** Bounded checkpoint trail: where the pipeline actually got to. */
  progress?: AutomationJobProgress[];
  /** When a stop was requested. Set even if the work had already finished. */
  cancelRequestedAt?: Date;
  /** Which lane ran this job — see `services/durable-delegation.ts` for the pattern. */
  dispatch?: 'legacy' | 'durable';
  v2JobId?: string;
  v2ResourceId?: string;
  v2TerminalOutcome?: string;
  resultPreview?: string;
  resultArtifactId?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeatAt: Date;
  expiresAt: Date;
  runId?: string;
  turnId?: string;
};

export type StartAutomationJobInput = {
  input: AutomationGoldenPathInput;
  automationId?: string;
  /** Internal runtime identity from the calling tool envelope. */
  approvalActorAgentId?: string;
  targetAgentId?: string;
  callerAgentId?: string;
  callerThreadId?: string;
  architectThreadId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  wake?: boolean;
  ttlMs?: number;
  runId?: string;
  turnId?: string;
  /** Etap 5: resource claims to lease before running (serializes conflicts). */
  claims?: string[];
};

export type ListAutomationJobsFilter = {
  automationId?: string;
  targetAgentId?: string;
  returnToAgentId?: string;
  status?: AutomationJobStatus;
  limit?: number;
};

const COLLECTION = 'automation_jobs';
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 15 * 60 * 1000;

const liveJobs = new Map<string, { cancelled: boolean; heartbeat?: ReturnType<typeof setInterval> }>();

export async function startAutomationJob(
  input: StartAutomationJobInput,
): Promise<AutomationJobRecord> {
  if (!isHarnessFeatureEnabled('FEATURE_BACKGROUND_TASKS', true)) {
    throw new Error('Automation jobs are disabled because FEATURE_BACKGROUND_TASKS=false');
  }

  const jobId = randomUUID();
  const automationId = input.automationId ?? input.input.automationId ?? await resolveExistingAutomationId(input.input) ?? randomUUID();
  const now = new Date();
  const goldenPathInput: AutomationGoldenPathInput = {
    ...input.input,
    automationId,
  };
  const returnToAgentId = canonicalizeRuntimeAgentId(input.returnToAgentId ?? input.targetAgentId) ?? AUTOMATION_ARCHITECT_AGENT_ID;
  const targetAgentId = canonicalizeRuntimeAgentId(input.targetAgentId ?? returnToAgentId) ?? AUTOMATION_ARCHITECT_AGENT_ID;

  const record: AutomationJobRecord = {
    jobId,
    automationId,
    targetAgentId,
    approvalActorAgentId: canonicalizeRuntimeAgentId(input.approvalActorAgentId),
    callerAgentId: canonicalizeRuntimeAgentId(input.callerAgentId),
    callerThreadId: input.callerThreadId,
    architectThreadId: input.architectThreadId,
    originAgentId: canonicalizeRuntimeAgentId(input.originAgentId ?? input.callerAgentId),
    originThreadId: input.originThreadId ?? input.callerThreadId,
    targetThreadId: input.targetThreadId ?? input.architectThreadId,
    returnToAgentId,
    returnToThreadId: input.returnToThreadId ?? input.callerThreadId ?? input.architectThreadId,
    status: 'queued',
    inputPreview: previewAutomationInput(goldenPathInput),
    goldenPathInput,
    progress: [],
    startedAt: now,
    lastHeartbeatAt: now,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
    runId: input.runId,
    turnId: input.turnId,
  };

  const db = await getDb();
  await db.collection<AutomationJobRecord>(COLLECTION).insertOne(record);

  await logHarnessEvent({
    type: 'bg_task_started',
    agentId: targetAgentId,
    runId: input.runId,
    turnId: input.turnId,
    threadId: record.returnToThreadId,
    taskId: jobId,
    feature: 'automation_jobs',
    status: 'success',
    output: `Automation job started: ${jobId}`,
    data: {
      jobId,
      automationId,
      targetAgentId,
      returnToAgentId,
      returnToThreadId: record.returnToThreadId,
    },
  });

  // Task Ledger (Etap 1): automation jobs heartbeat every 5s, so a tight
  // stale window is safe.
  void ledgerOpenLane({
    source: 'automation_job',
    sourceId: jobId,
    goal: record.inputPreview,
    agentId: targetAgentId,
    threadId: record.returnToThreadId,
    state: 'queued',
    claims: input.claims ?? deriveAutomationClaims(goldenPathInput),
    staleAfterMs: STALE_AFTER_MS,
    meta: { automationId, runId: input.runId },
  });

  // ── F6 work item 2: durable dispatch, legacy lane as the fallback ──
  //
  // Tried AFTER the row and the ledger lane exist, so the build is observable
  // whichever lane runs it and the durable job links to a row that is already
  // there — the native executor finds its input by exactly that link.
  const durable = await dispatchDurableAutomationJob({
    jobId,
    goal: record.inputPreview,
    ownerAgentId: targetAgentId,
    conversationId: record.returnToThreadId ?? `automation-${jobId}`,
  });
  if (durable) {
    await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId },
      { $set: { dispatch: 'durable', v2JobId: durable.v2JobId, v2ResourceId: durable.resourceId } },
    );
    // F6 work item 4 — the lane becomes a projection of the durable job; the
    // Ledger stops timing it by a heartbeat nobody sends any more.
    await ledgerMarkDurable('automation_job', jobId, durable.v2JobId);
    console.log(`[AutomationJob] → durable job ${durable.v2JobId} for ${jobId} (${automationId})`);
    return { ...record, dispatch: 'durable', v2JobId: durable.v2JobId, v2ResourceId: durable.resourceId };
  }

  await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
    { jobId },
    { $set: { dispatch: 'legacy' } },
  );
  void executeAutomationJob(jobId, goldenPathInput, { ...record, wake: input.wake ?? true });

  return { ...record, dispatch: 'legacy' };
}

export async function getAutomationJob(jobId: string): Promise<AutomationJobRecord | null> {
  const db = await getDb();
  return db.collection<AutomationJobRecord>(COLLECTION).findOne({ jobId });
}

export async function listAutomationJobs(
  filter: ListAutomationJobsFilter = {},
): Promise<AutomationJobRecord[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};
  if (filter.automationId) query.automationId = filter.automationId;
  if (filter.targetAgentId) query.targetAgentId = agentIdFieldFilter(filter.targetAgentId);
  if (filter.returnToAgentId) query.returnToAgentId = agentIdFieldFilter(filter.returnToAgentId);
  if (filter.status) query.status = filter.status;

  return db.collection<AutomationJobRecord>(COLLECTION)
    .find(query)
    .sort({ startedAt: -1 })
    .limit(filter.limit ?? 20)
    .toArray();
}

export async function cancelAutomationJob(jobId: string): Promise<boolean> {
  const db = await getDb();
  const record = await getAutomationJob(jobId);
  if (!record || !['queued', 'running'].includes(record.status)) return false;

  // The in-memory flag is now the FAST path, not the mechanism. Before F6 it was
  // the only one, which made cancel process-local in a system that restarts and
  // may run more than one process: a cancel issued anywhere else set the row to
  // `cancelled` while the pipeline kept deploying to n8n, and the only visible
  // effect was that nobody was told what it had done. The durable signal is the
  // row itself, which the running job re-reads on its own heartbeat (see
  // `executeAutomationJob`), so a stop crosses processes and restarts.
  const live = liveJobs.get(jobId);
  if (live) live.cancelled = true;

  const now = new Date();
  await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
    { jobId, status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status: 'cancelled' as AutomationJobStatus,
        cancelRequestedAt: now,
        completedAt: now,
        lastHeartbeatAt: now,
      },
    },
  );

  // A durably-dispatched job also has to cross the V2 stop barrier — the row
  // alone would stop the checkpoint writes but not the attempt.
  if (record.dispatch === 'durable' && record.v2JobId) {
    await cancelDurableAutomationJob(record).catch((error) => {
      console.warn(`[AutomationJob] durable cancel ${jobId}: ${(error as Error).message}`);
    });
  }

  await logHarnessEvent({
    type: 'bg_task_completed',
    agentId: record.targetAgentId,
    runId: record.runId,
    turnId: record.turnId,
    threadId: record.returnToThreadId,
    taskId: jobId,
    feature: 'automation_jobs',
    status: 'success',
    output: `Automation job cancelled: ${jobId}`,
    data: { jobId, automationId: record.automationId, status: 'cancelled' },
  });

  void ledgerTransitionBySource('automation_job', jobId, 'cancelled', {
    milestone: 'cancelled by operator',
  });

  return true;
}

export async function markStaleAutomationJobs(
  opts: { staleAfterMs?: number } = {},
): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - (opts.staleAfterMs ?? STALE_AFTER_MS));
  const result = await db.collection<AutomationJobRecord>(COLLECTION).updateMany(
    {
      status: { $in: ['queued', 'running'] },
      lastHeartbeatAt: { $lt: cutoff },
    },
    {
      $set: {
        status: 'stale' as AutomationJobStatus,
        completedAt: new Date(),
      },
    },
  );
  return result.modifiedCount;
}

async function executeAutomationJob(
  jobId: string,
  input: AutomationGoldenPathInput,
  routing: AutomationJobRecord & { wake: boolean },
): Promise<void> {
  const db = await getDb();
  const live = { cancelled: false, heartbeat: undefined as ReturnType<typeof setInterval> | undefined };
  liveJobs.set(jobId, live);

  // One controller, two sources: this process's own flag and the durable row.
  const stop = new AbortController();
  const requestStop = (): void => {
    live.cancelled = true;
    if (!stop.signal.aborted) stop.abort(new Error('automation_job_cancelled'));
  };

  // The heartbeat already ran every 5s to prove liveness; it now also READS the
  // row back, so the same tick that says "I am alive" is the one that notices
  // "you were told to stop". A cancel from another process, or a row the
  // staleness sweep already gave up on, therefore reaches the running pipeline
  // instead of only changing what the record says about it. No second timer.
  const heartbeat = async () => {
    const beat = await db.collection<AutomationJobRecord>(COLLECTION).findOneAndUpdate(
      { jobId },
      { $set: { lastHeartbeatAt: new Date() } },
      { returnDocument: 'after', projection: { status: 1 } },
    ).catch(() => null);
    if (beat && beat.status !== 'running') requestStop();
    await ledgerTouchBySource('automation_job', jobId);
  };

  // Checkpoints. Same writer both lanes use, so the trail means the same thing
  // whether the build ran here or as a durable job.
  const recordStep = createProgressRecorder(
    db.collection<AutomationJobRecord>(COLLECTION) as never,
    jobId,
  );

  try {
    // ── Etap 5: claims gate (queued→running) ──────────────────────────────
    // Hold the start while the kill switch is active, then serialize on the
    // lane's resource claims. Two jobs on the same n8n workflow run one-at-a-time;
    // disjoint claims proceed in parallel. The lane stays 'queued' while waiting.
    const lane = await findLaneBySource('automation_job', jobId);
    while ((await isKillSwitchActive().catch(() => false)) && !live.cancelled) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (lane && lane.claims.length > 0 && !live.cancelled) {
      const acq = await waitAndAcquireClaims({
        laneId: lane.laneId,
        laneNo: lane.laneNo,
        claims: lane.claims,
        isCancelled: () => live.cancelled,
      });
      if (!acq.acquired) {
        const reason = acq.conflictClaim
          ? `claim wait timed out on ${acq.conflictClaim} (held by lane #${acq.conflictLaneNo})`
          : 'cancelled while waiting for resource claims';
        const now = new Date();
        await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
          { jobId, status: { $in: ['queued', 'running'] } },
          { $set: { status: 'failed' as AutomationJobStatus, error: reason, completedAt: now, lastHeartbeatAt: now } },
        );
        void ledgerTransitionBySource('automation_job', jobId, 'failed', { error: reason });
        return;
      }
    }
    if (live.cancelled) return;

    const runningUpdate = await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId, status: 'queued' },
      {
        $set: {
          status: 'running' as AutomationJobStatus,
          lastHeartbeatAt: new Date(),
        },
      },
    );
    if (runningUpdate.matchedCount === 0) {
      if (lane) void releaseClaims(lane.laneId);
      return;
    }
    void ledgerTransitionBySource('automation_job', jobId, 'running');
    live.heartbeat = setInterval(() => void heartbeat(), HEARTBEAT_MS);

    if (live.cancelled) return;

    const result = await executeAutomationGoldenPath(input, {
      actorAgentId: routing.approvalActorAgentId,
      signal: stop.signal,
      onStep: recordStep,
    });
    const current = await getAutomationJob(jobId);
    // A cancelled job still gets its checkpoints and its row; what it does NOT
    // get is a result message claiming the build finished. The Golden Path
    // returns a `cancelled` failureClass rather than throwing, so the caller can
    // tell "operator stopped it" from "it broke", and the trail says whether an
    // inactive draft was left behind in n8n.
    if (live.cancelled || current?.status === 'cancelled') return;

    const compacted = await compactHarnessOutput({
      text: JSON.stringify(result, null, 2),
      kind: 'tool_output',
      runId: routing.runId,
      turnId: routing.turnId,
      threadId: routing.returnToThreadId,
      taskId: jobId,
      agentId: routing.targetAgentId,
      toolId: 'automation_job_manager',
      previewBytes: 4000,
      metadata: {
        scope: 'automation_job_result',
        jobId,
        automationId: result.automationId,
        workflowId: result.workflowId,
      },
    });
    const resultPreview = buildResultPreview(result, compacted.preview);
    const now = new Date();

    await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId },
      {
        $set: {
          status: 'completed' as AutomationJobStatus,
          resultPreview,
          resultArtifactId: compacted.fullTextArtifactId,
          completedAt: now,
          lastHeartbeatAt: now,
        },
      },
    );

    void ledgerTransitionBySource('automation_job', jobId, result.success ? 'done' : 'failed', {
      milestone: `golden path ${result.status} (success=${result.success})`,
      ...(result.success ? {} : { error: result.message?.slice(0, 300) }),
      artifacts: compacted.fullTextArtifactId
        ? [{ id: compacted.fullTextArtifactId, type: 'automation_job_result' }]
        : undefined,
    });

    if (routing.wake) {
      await queueAutomationJobResult({
        routing,
        jobId,
        result,
        resultPreview,
        artifactId: compacted.fullTextArtifactId,
      });
    }

    await logHarnessEvent({
      type: 'bg_task_completed',
      agentId: routing.targetAgentId,
      runId: routing.runId,
      turnId: routing.turnId,
      threadId: routing.returnToThreadId,
      taskId: jobId,
      feature: 'automation_jobs',
      status: result.success ? 'success' : 'error',
      output: resultPreview,
      data: {
        jobId,
        automationId: result.automationId,
        workflowId: result.workflowId,
        goldenPathStatus: result.status,
        success: result.success,
      },
    });
  } catch (error) {
    const err = error as Error;
    const current = await getAutomationJob(jobId);
    if (current?.status === 'cancelled') return;

    const now = new Date();
    await db.collection<AutomationJobRecord>(COLLECTION).updateOne(
      { jobId },
      {
        $set: {
          status: 'failed' as AutomationJobStatus,
          error: err.message,
          completedAt: now,
          lastHeartbeatAt: now,
        },
      },
    );

    void ledgerTransitionBySource('automation_job', jobId, 'failed', { error: err.message });

    if (routing.wake) {
      await queuePendingMessage({
        taskId: jobId,
        threadId: routing.returnToThreadId,
        targetAgentId: routing.returnToAgentId ?? routing.targetAgentId,
        source: 'automation_job',
        urgent: true,
        content: [
          '## Automation Job Failed',
          `Job ID: ${jobId}`,
          `Automation ID: ${routing.automationId}`,
          `Error: ${err.message}`,
        ].join('\n'),
        metadata: {
          type: 'automation_job_result',
          jobId,
          automationId: routing.automationId,
          status: 'failed',
          error: err.message,
          returnToAgentId: routing.returnToAgentId,
          returnToThreadId: routing.returnToThreadId,
        },
      });
    }

    await logHarnessEvent({
      type: 'bg_task_completed',
      agentId: routing.targetAgentId,
      runId: routing.runId,
      turnId: routing.turnId,
      threadId: routing.returnToThreadId,
      taskId: jobId,
      feature: 'automation_jobs',
      status: 'error',
      errorMessage: err.message,
      output: `Automation job failed: ${jobId}`,
      data: { jobId, automationId: routing.automationId },
    });
  } finally {
    if (live.heartbeat) clearInterval(live.heartbeat);
    liveJobs.delete(jobId);
  }
}

async function queueAutomationJobResult(input: {
  routing: AutomationJobRecord;
  jobId: string;
  result: AutomationGoldenPathResult;
  resultPreview: string;
  artifactId?: string;
}): Promise<void> {
  const { routing, jobId, result, resultPreview, artifactId } = input;
  await queuePendingMessage({
    taskId: jobId,
    threadId: routing.returnToThreadId,
    targetAgentId: routing.returnToAgentId ?? routing.targetAgentId,
    source: 'automation_job',
    urgent: !result.success,
    content: [
      '## Automation Job Result',
      `Job ID: ${jobId}`,
      `Automation ID: ${result.automationId}`,
      result.workflowId ? `Workflow ID: ${result.workflowId}` : '',
      result.workflowName ? `Workflow: ${result.workflowName}` : '',
      `Golden Path status: ${result.status}`,
      `Success: ${result.success}`,
      `Message: ${result.message}`,
      result.risk ? `Risk: ${result.risk.verdict} (${result.risk.score})` : '',
      result.lastTest ? `Last test: ${result.lastTest.status}` : '',
      `Repair attempts: ${result.repairAttempts}`,
      artifactId ? `Full result artifact: ${artifactId}` : '',
      '',
      resultPreview,
    ].filter(Boolean).join('\n'),
    metadata: {
      type: 'automation_job_result',
      jobId,
      automationId: result.automationId,
      workflowId: result.workflowId,
      status: result.status,
      success: result.success,
      resultArtifactId: artifactId,
      originAgentId: routing.originAgentId,
      originThreadId: routing.originThreadId,
      returnToAgentId: routing.returnToAgentId,
      returnToThreadId: routing.returnToThreadId,
    },
  });
}

/**
 * Etap 5: derive resource claims from a golden-path input so two jobs touching
 * the SAME n8n workflow serialize. When no specific workflow is targeted yet
 * (fresh build), claim the shared n8n deploy lane so concurrent deploys queue.
 */
function deriveAutomationClaims(input: AutomationGoldenPathInput): string[] {
  const claims: string[] = [];
  if (input.workflowId) {
    claims.push(`n8n:workflow:${input.workflowId}`);
  } else {
    claims.push('n8n:deploy');
  }
  return claims;
}

function previewAutomationInput(input: AutomationGoldenPathInput): string {
  return redactSecrets(JSON.stringify({
    mode: input.mode,
    request: input.request,
    patternId: input.patternId,
    workflowName: input.workflowName,
    workflowId: input.workflowId,
    automationId: input.automationId,
    activate: input.activate,
    allowDraftWithMissingCredentials: input.allowDraftWithMissingCredentials,
    requiresPublicWebhook: input.requiresPublicWebhook,
    spec: input.spec ? {
      id: input.spec.id,
      requestId: input.spec.requestId,
      name: input.spec.name,
      triggerType: input.spec.trigger?.type,
      externalServices: input.spec.externalServices,
      credentialsNeeded: input.spec.credentialsNeeded?.map((credential) => ({
        service: credential.service,
        required: credential.required,
      })),
      riskLevel: input.spec.riskLevel,
    } : undefined,
    workflow: input.workflow ? summarizeWorkflow(input.workflow) : undefined,
    workflowFilePath: input.workflowFilePath,
    approvalToken: input.approvalToken ? '[REDACTED]' : undefined,
  }, null, 2)).text.slice(0, 2000);
}

async function resolveExistingAutomationId(input: AutomationGoldenPathInput): Promise<string | undefined> {
  if (!input.workflowId) return undefined;
  const db = await getDb();
  const owner = await db.collection('automation_requests').findOne(
    {
      n8nWorkflowId: input.workflowId,
      managedBy: 'mastra',
    },
    { sort: { createdAt: 1 } },
  );
  return typeof owner?.automationId === 'string' ? owner.automationId : undefined;
}

function buildResultPreview(result: AutomationGoldenPathResult, compactedPreview: string): string {
  const summary = [
    `status=${result.status}`,
    `success=${result.success}`,
    `automationId=${result.automationId}`,
    result.workflowId ? `workflowId=${result.workflowId}` : '',
    result.workflowName ? `workflowName=${result.workflowName}` : '',
    result.risk ? `risk=${result.risk.verdict}:${result.risk.score}` : '',
    result.lastTest ? `lastTest=${result.lastTest.status}` : '',
    `repairAttempts=${result.repairAttempts}`,
    `message=${result.message}`,
  ].filter(Boolean).join('\n');
  return [summary, '', compactedPreview].join('\n').slice(0, 5000);
}

function summarizeWorkflow(workflow: unknown): Record<string, unknown> {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return { type: typeof workflow };
  }
  const record = workflow as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  return {
    name: record.name,
    active: record.active,
    nodeCount: nodes.length,
    connectionCount: record.connections && typeof record.connections === 'object'
      ? Object.keys(record.connections as Record<string, unknown>).length
      : 0,
    nodeTypes: nodes
      .map((node) => node && typeof node === 'object' ? (node as Record<string, unknown>).type : undefined)
      .filter(Boolean)
      .slice(0, 12),
  };
}
