/**
 * Async Delegation Service
 *
 * Enables fire-and-forget delegation from meta-agent to coding-agent.
 * The coding-agent runs in the background, and results are queued as
 * pending messages for the meta-agent to pick up on the next user turn.
 *
 * Flow:
 *   meta-agent → delegateTask(async: true) → startAsyncDelegation()
 *   → coding-agent runs in background (via generateCoding)
 *   → result queued to pending_user_messages (scoped to meta-agent's threadId)
 *   → meta-agent's PendingUpdatesProcessor picks it up on next turn
 */

import { randomUUID } from 'crypto';
import type { Agent } from '@mastra/core/agent';

import { getDb } from '../lib/mongo.js';
import { logAgentEvent } from '../lib/agent-event-log.js';
import { ledgerMarkDurable, ledgerOpenLane, ledgerTransitionBySource } from './task-ledger.js';
import { generateCoding } from './coding-harness.js';
import { generateAutomation } from './automation-harness.js';
import { generateKnowledge } from './knowledge-harness.js';
import { generatePipelineWithReflection } from './generate-pipeline-with-reflection.js';
import { isPipelineAgent } from '../config/pipeline-phase-tools.js';
import { queuePendingMessage } from './pending-message-queue.js';
import { dispatchDurableDelegation } from './durable-delegation.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { completeGoalContract, evaluateCompletion, recordEvidence } from './goal-tracker.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  CODING_AGENT_ID,
  KNOWLEDGE_AGENT_ID,
  META_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../config/agent-ids.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type DelegationStatus = 'running' | 'completed' | 'failed';

export type DelegationRecord = {
  delegationId: string;
  targetAgent: string;
  taskDescription: string;
  /** Thread used by the coding-agent internally */
  agentThreadId: string;
  /** Thread of the meta-agent caller — results are delivered here */
  callerThreadId: string;
  /** Agent that should consume the pending result */
  callerAgentId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetAgentId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  taskId?: string;
  goalContractId?: string;
  status: DelegationStatus;
  /**
   * Which lane actually runs this delegation. `legacy` = the in-process
   * `void executeDelegation` below; `durable` = a V2 job (F6 cutover), in which
   * case `v2JobId` is the handle and the completion bridge writes the result
   * back into this record.
   */
  dispatch?: 'legacy' | 'durable';
  v2JobId?: string;
  v2ResourceId?: string;
  v2TerminalOutcome?: string;
  result?: string;
  resultPreview?: string;
  resultArtifactId?: string;
  fullResultAvailable?: boolean;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
};

export type StartAsyncDelegationInput = {
  agent: Agent;
  agentId: string;
  prompt: string;
  /** Thread of the meta-agent — where to deliver results */
  callerThreadId: string;
  /** Agent that should consume pending results; defaults to meta-agent for backward compatibility */
  callerAgentId?: string;
  originAgentId?: string;
  originThreadId?: string;
  targetAgentId?: string;
  targetThreadId?: string;
  returnToAgentId?: string;
  returnToThreadId?: string;
  taskId?: string;
  goalContractId?: string;
  repoPath?: string;
  timeoutMs?: number;
};

// ── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = 'async_delegations';
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start an async delegation. Returns immediately with a delegationId.
 * The actual agent work happens in the background.
 */
export async function startAsyncDelegation(
  input: StartAsyncDelegationInput,
): Promise<{ delegationId: string }> {
  const delegationId = randomUUID();
  const agentThreadId = input.targetThreadId ?? `async-delegation-${delegationId}`;
  const now = new Date();
  const agentId = canonicalizeRuntimeAgentId(input.agentId) ?? input.agentId;
  const callerAgentId = canonicalizeRuntimeAgentId(input.callerAgentId) ?? META_AGENT_ID;
  const originAgentId = canonicalizeRuntimeAgentId(input.originAgentId ?? input.callerAgentId) ?? META_AGENT_ID;
  const targetAgentId = canonicalizeRuntimeAgentId(input.targetAgentId ?? input.agentId) ?? agentId;
  const returnToAgentId = canonicalizeRuntimeAgentId(input.returnToAgentId ?? input.callerAgentId) ?? META_AGENT_ID;
  const returnToThreadId = input.returnToThreadId ?? input.callerThreadId;

  const record: DelegationRecord = {
    delegationId,
    targetAgent: agentId,
    taskDescription: input.prompt.slice(0, 2000),
    agentThreadId,
    callerThreadId: input.callerThreadId,
    callerAgentId,
    originAgentId,
    originThreadId: input.originThreadId ?? input.callerThreadId,
    targetAgentId,
    targetThreadId: agentThreadId,
    returnToAgentId,
    returnToThreadId,
    taskId: input.taskId,
    goalContractId: input.goalContractId,
    status: 'running',
    startedAt: now,
  };

  // Persist initial record to Mongo
  const db = await getDb();
  await db.collection<DelegationRecord>(COLLECTION).insertOne(record);

  logAgentEvent({
    type: 'delegation',
    agentId,
    status: 'pending',
    input: `[ASYNC] ${input.prompt.slice(0, 500)}`,
    metadata: { delegationId, async: true, goalContractId: input.goalContractId },
  });

  // Task Ledger (Etap 1): mirror this delegation as a lane. No heartbeat loop
  // here — staleness is bounded by the harness timeout plus a buffer.
  void ledgerOpenLane({
    source: 'async_delegation',
    sourceId: delegationId,
    goal: input.prompt,
    agentId,
    threadId: input.callerThreadId,
    state: 'running',
    staleAfterMs: (input.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 120_000,
    meta: { goalContractId: input.goalContractId, taskId: input.taskId },
  });

  // ── F6 cutover: durable dispatch, with the legacy lane as the fallback ──
  //
  // Tried AFTER the record and the ledger lane exist, so a delegation is
  // observable whichever lane runs it, and the durable job can be linked to a row
  // that is already there. `dispatchDurableDelegation` returns null for anything
  // it cannot serve (flag off, capability not routable, store down) and never
  // throws — the delegation then takes exactly the path it took before.
  const durable = await dispatchDurableDelegation({
    delegationId,
    agentId,
    prompt: input.prompt,
    callerAgentId,
    callerThreadId: input.callerThreadId,
  });
  if (durable) {
    await db.collection<DelegationRecord>(COLLECTION).updateOne(
      { delegationId },
      { $set: { dispatch: 'durable', v2JobId: durable.jobId, v2ResourceId: durable.resourceId } },
    );
    // F6 work item 4: the durable job owns this work now, so the Ledger lane
    // becomes a projection of it. Without this the stale reconciler would judge
    // the lane by a heartbeat nobody sends any more and record a running job as
    // failed — permanently, since terminal lane states are absorbing.
    await ledgerMarkDurable('async_delegation', delegationId, durable.jobId);
    console.log(`[AsyncDelegation] → durable job ${durable.jobId} for ${delegationId} (${agentId})`);
    return { delegationId };
  }

  // Fire-and-forget — run target agent in background
  await db.collection<DelegationRecord>(COLLECTION).updateOne(
    { delegationId },
    { $set: { dispatch: 'legacy' } },
  );
  void executeDelegation(delegationId, agentThreadId, input);

  return { delegationId };
}

/**
 * Check the status of an async delegation.
 */
export async function getAsyncDelegation(
  delegationId: string,
): Promise<DelegationRecord | null> {
  const db = await getDb();
  return db.collection<DelegationRecord>(COLLECTION).findOne({ delegationId });
}

/**
 * List recent async delegations.
 */
export async function listAsyncDelegations(
  opts: { callerThreadId?: string; status?: DelegationStatus; limit?: number } = {},
): Promise<DelegationRecord[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = {};
  if (opts.callerThreadId) filter.callerThreadId = opts.callerThreadId;
  if (opts.status) filter.status = opts.status;

  return db.collection<DelegationRecord>(COLLECTION)
    .find(filter)
    .sort({ startedAt: -1 })
    .limit(opts.limit ?? 10)
    .toArray();
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function executeDelegation(
  delegationId: string,
  agentThreadId: string,
  input: StartAsyncDelegationInput,
): Promise<void> {
  const start = Date.now();
  const db = await getDb();
  const agentId = canonicalizeRuntimeAgentId(input.agentId) ?? input.agentId;
  const originAgentId = canonicalizeRuntimeAgentId(input.originAgentId ?? input.callerAgentId) ?? META_AGENT_ID;
  const targetAgentId = canonicalizeRuntimeAgentId(input.targetAgentId ?? input.agentId) ?? agentId;
  const returnToAgentId = canonicalizeRuntimeAgentId(input.returnToAgentId ?? input.callerAgentId) ?? META_AGENT_ID;

  try {
    const delegatedPrompt = buildDelegatedPrompt(input);
    const harnessResult = agentId === AUTOMATION_ARCHITECT_AGENT_ID
        ? await generateAutomation({
            agent: input.agent,
            prompt: delegatedPrompt,
            taskId: input.taskId,
            goalContractId: input.goalContractId,
            threadId: agentThreadId,
            phase: 'chat',
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
      : agentId === KNOWLEDGE_AGENT_ID
        ? await generateKnowledge({
            agent: input.agent,
            prompt: delegatedPrompt,
            taskId: input.taskId,
            goalContractId: input.goalContractId,
            threadId: agentThreadId,
            phase: 'chat',
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          })
      : agentId === CODING_AGENT_ID
        ? await generateCoding({
            agent: input.agent,
            agentId: CODING_AGENT_ID,
            prompt: delegatedPrompt,
            taskId: input.taskId,
            goalContractId: input.goalContractId,
            threadId: agentThreadId,
            phase: 'chat',
            repoPath: input.repoPath ?? AGENTIC_AGENTS_REPO,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          })
        : // HRN-002 — pipeline agents (chef/content/hunt/writer/filmmaker/musician)
        // going through the ASYNC lane must not silently drop the reflector +
        // liveness protection CAN-002 gave the SYNC lane. Before this fix they
        // fell straight into `generateGenericAsync` below — a bare `agent.generate`
        // with only a flat timeout and zero loop/scope-creep detection, a
        // completely different (and weaker) profile than the same agent gets
        // when called synchronously. Routed through the real pipeline gateway
        // instead, under the same abortable-timeout shape `generateGenericAsync`
        // already used, so the existing bound is not weakened either.
        //
        // NOT solved here: there is still no way to CANCEL an in-flight async
        // delegation from the outside (`void executeDelegation(...)` below is
        // fire-and-forget with no stored controller) — that is the persistent,
        // cancellable dispatch work of Wave 5 (plan-dziecko F6), not this slice.
        isPipelineAgent(agentId)
          ? await generatePipelineAsync({
              agent: input.agent,
              agentKey: agentId,
              agentId,
              prompt: delegatedPrompt,
              threadId: agentThreadId,
              resourceId: originAgentId ?? META_AGENT_ID,
              taskId: input.taskId,
              goalContractId: input.goalContractId,
              timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              targetAgent: agentId,
            })
          // P2 (delegation-depth-hardening) — remaining generic agents
          // (researcher, design, …) get a plain abortable generate. Previously
          // every non-automation/non-knowledge agent fell through to the CODING
          // harness (repo precontext + repoPath), which is wrong for them. No
          // current caller relied on that fallback — delegate-task only routed
          // the three harness agents here before this change.
          : await generateGenericAsync({
              agent: input.agent,
              prompt: delegatedPrompt,
              agentThreadId,
              resourceId: originAgentId ?? META_AGENT_ID,
              timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              targetAgent: agentId,
            });

    const responseText = harnessResult.outputPreview ?? '';
    const resultArtifactId = harnessResult.outputArtifactId;
    const fullResultAvailable = Boolean(resultArtifactId);
    const durationMs = Date.now() - start;

    // Update delegation record
    await db.collection<DelegationRecord>(COLLECTION).updateOne(
      { delegationId },
      {
        $set: {
          status: 'completed' as DelegationStatus,
          result: responseText.slice(0, 5000),
          resultPreview: responseText,
          resultArtifactId,
          fullResultAvailable,
          completedAt: new Date(),
          durationMs,
        },
      },
    );

    // Queue result as pending message for meta-agent's thread
    await queuePendingMessage({
      threadId: input.returnToThreadId ?? input.callerThreadId,
      targetAgentId: returnToAgentId,
      source: 'background_task',
      content: [
        `## Async Delegation Result`,
        `**Agent:** ${agentId}`,
        `**Task:** ${input.prompt.slice(0, 200)}${input.prompt.length > 200 ? '...' : ''}`,
        `**Status:** ✅ completed (${(durationMs / 1000).toFixed(1)}s)`,
        resultArtifactId ? `**Full result artifact:** ${resultArtifactId}` : '',
        `**Result:**`,
        responseText,
      ].filter(Boolean).join('\n'),
      urgent: false,
      metadata: {
        delegationId,
        agentId,
        durationMs,
        resultPreview: responseText,
        resultArtifactId,
        fullResultAvailable,
        goalContractId: input.goalContractId,
        type: 'async_delegation_result',
        originAgentId,
        originThreadId: input.originThreadId ?? input.callerThreadId,
        targetAgentId,
        targetThreadId: agentThreadId,
        returnToAgentId,
        returnToThreadId: input.returnToThreadId ?? input.callerThreadId,
      },
    });

    logAgentEvent({
      type: 'delegation',
      agentId,
      status: 'success',
      input: `[ASYNC COMPLETE] ${input.prompt.slice(0, 500)}`,
      output: responseText.slice(0, 500),
      durationMs,
      metadata: { delegationId, async: true, resultArtifactId, fullResultAvailable, goalContractId: input.goalContractId },
    });

    await completeAsyncGoalSuccess(input.goalContractId, responseText);

    void ledgerTransitionBySource('async_delegation', delegationId, 'done', {
      milestone: `completed in ${(durationMs / 1000).toFixed(1)}s`,
      artifacts: resultArtifactId ? [{ id: resultArtifactId, type: 'harness_output' }] : undefined,
    });

    console.log(`[AsyncDelegation] ✅ ${delegationId} completed in ${(durationMs / 1000).toFixed(1)}s`);
  } catch (error) {
    const durationMs = Date.now() - start;
    const err = error as Error;

    // Update delegation record
    await db.collection<DelegationRecord>(COLLECTION).updateOne(
      { delegationId },
      {
        $set: {
          status: 'failed' as DelegationStatus,
          error: err.message,
          completedAt: new Date(),
          durationMs,
        },
      },
    );

    // Queue error as pending message for meta-agent's thread
    await queuePendingMessage({
      threadId: input.returnToThreadId ?? input.callerThreadId,
      targetAgentId: returnToAgentId,
      source: 'background_task',
      content: [
        `## Async Delegation Failed`,
        `**Agent:** ${agentId}`,
        `**Task:** ${input.prompt.slice(0, 200)}${input.prompt.length > 200 ? '...' : ''}`,
        `**Status:** ❌ failed (${(durationMs / 1000).toFixed(1)}s)`,
        `**Error:** ${err.message}`,
      ].join('\n'),
      urgent: true,
      metadata: {
        delegationId,
        agentId,
        durationMs,
        error: err.message,
        goalContractId: input.goalContractId,
        type: 'async_delegation_result',
        originAgentId,
        originThreadId: input.originThreadId ?? input.callerThreadId,
        targetAgentId,
        targetThreadId: agentThreadId,
        returnToAgentId,
        returnToThreadId: input.returnToThreadId ?? input.callerThreadId,
      },
    });

    logAgentEvent({
      type: 'delegation',
      agentId,
      status: 'error',
      input: `[ASYNC FAILED] ${input.prompt.slice(0, 500)}`,
      errorMessage: err.message,
      durationMs,
      metadata: { delegationId, async: true, goalContractId: input.goalContractId },
    });

    await completeAsyncGoalFailure(input.goalContractId, err.message);

    void ledgerTransitionBySource('async_delegation', delegationId, 'failed', {
      error: err.message,
    });

    console.warn(`[AsyncDelegation] ❌ ${delegationId} failed after ${(durationMs / 1000).toFixed(1)}s: ${err.message}`);
  }
}

async function completeAsyncGoalSuccess(
  goalContractId: string | undefined,
  responseText: string,
): Promise<void> {
  if (!goalContractId) return;
  const summary = summarizeAsyncGoalEvidence(responseText);
  try {
    await recordEvidence(goalContractId, {
      stepId: 'step-2',
      type: 'for',
      description: summary,
      stepStatus: 'done',
    });
    await recordEvidence(goalContractId, {
      stepId: 'step-3',
      type: 'for',
      description: 'Async delegated agent returned a result to the caller.',
      stepStatus: 'done',
    });
    await completeGoalContract(goalContractId, 'completed', summary);
    await evaluateCompletion(goalContractId);
  } catch (error) {
    console.warn('[AsyncDelegation] GoalContract completion failed:', (error as Error).message);
  }
}

async function completeAsyncGoalFailure(
  goalContractId: string | undefined,
  errorMessage: string,
): Promise<void> {
  if (!goalContractId) return;
  try {
    await recordEvidence(goalContractId, {
      stepId: 'step-2',
      type: 'against',
      description: `Async delegation failed: ${errorMessage}`,
      stepStatus: 'failed',
    });
    await recordEvidence(goalContractId, {
      stepId: 'step-3',
      type: 'against',
      description: 'Async delegated agent did not return an acceptable result.',
      stepStatus: 'failed',
    });
    await completeGoalContract(goalContractId, 'failed', errorMessage);
    await evaluateCompletion(goalContractId);
  } catch (error) {
    console.warn('[AsyncDelegation] GoalContract failure update failed:', (error as Error).message);
  }
}

function summarizeAsyncGoalEvidence(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Async delegation returned an empty response.';
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

/**
 * HRN-002 — background run for pipeline agents (chef/content/hunt/writer/
 * filmmaker/musician) going through the ASYNC lane. Same abortable-timeout
 * shape as `generateGenericAsync` below (the timeout aborts the work, not just
 * the wait), but the work itself goes through the REAL pipeline gateway
 * (`generatePipelineWithReflection`) instead of a bare `agent.generate` — so an
 * async pipeline delegation gets the same reflector (loop/scope-creep
 * detection) and liveness protection CAN-002 already gave the sync lane,
 * rather than a silently weaker, unguarded third path.
 */
async function generatePipelineAsync(args: {
  agent: Agent;
  agentKey: string;
  agentId: string;
  prompt: string;
  threadId: string;
  resourceId: string;
  taskId?: string;
  goalContractId?: string;
  timeoutMs: number;
  targetAgent: string;
}): Promise<{ outputPreview: string; outputArtifactId?: string }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      generatePipelineWithReflection({
        agent: args.agent,
        agentKey: args.agentKey,
        agentId: args.agentId,
        prompt: args.prompt,
        threadId: args.threadId,
        resourceId: args.resourceId,
        taskId: args.taskId,
        goalContractId: args.goalContractId,
        abortSignal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          try {
            controller.abort(new Error('async_pipeline_delegation_timeout'));
          } catch {
            // best-effort abort; never mask the timeout rejection
          }
          reject(new Error(`Async pipeline delegation to ${args.targetAgent} timed out after ${Math.round(args.timeoutMs / 1000)}s`));
        }, args.timeoutMs);
      }),
    ]);
    return { outputPreview: response.text };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * P2 (delegation-depth-hardening) — background run for agents that have no
 * dedicated harness (researcher, design, writer, film, …). Plain
 * `agent.generate` with the agent's own memory thread, under an ABORTABLE
 * timeout (WS-A style: the timeout aborts the work, not just the wait, so a
 * timed-out background delegation cannot linger as a zombie). Returns the
 * same `{ outputPreview }` shape the harness paths produce.
 */
async function generateGenericAsync(args: {
  agent: Agent;
  prompt: string;
  agentThreadId: string;
  resourceId: string;
  timeoutMs: number;
  targetAgent: string;
}): Promise<{ outputPreview: string; outputArtifactId?: string }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (args.agent as any).generate(args.prompt, { // @harness-exempt — generic async delegation path (no dedicated harness)
        memory: {
          thread: args.agentThreadId,
          resource: args.resourceId,
        },
        abortSignal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          try {
            controller.abort(new Error('async_delegation_timeout'));
          } catch {
            // best-effort abort; never mask the timeout rejection
          }
          reject(new Error(`Async delegation to ${args.targetAgent} timed out after ${Math.round(args.timeoutMs / 1000)}s`));
        }, args.timeoutMs);
      }),
    ]);
    return { outputPreview: (response as any)?.text ?? '' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildDelegatedPrompt(input: StartAsyncDelegationInput): string {
  const callerAgentId = canonicalizeRuntimeAgentId(input.callerAgentId) ?? META_AGENT_ID;
  const returnToAgentId = canonicalizeRuntimeAgentId(input.returnToAgentId ?? callerAgentId) ?? callerAgentId;
  const originAgentId = canonicalizeRuntimeAgentId(input.originAgentId ?? callerAgentId) ?? callerAgentId;
  const targetAgentId = canonicalizeRuntimeAgentId(input.targetAgentId ?? input.agentId) ?? input.agentId;
  const returnToThreadId = input.returnToThreadId ?? input.callerThreadId;
  return [
    `SYSTEM DELEGATION CONTEXT: This task was delegated asynchronously by ${callerAgentId}.`,
    `originAgentId: ${originAgentId}`,
    `originThreadId: ${input.originThreadId ?? input.callerThreadId}`,
    `targetAgentId: ${targetAgentId}`,
    `targetThreadId: ${input.targetThreadId ?? '(assigned by delegation service)'}`,
    `returnToAgentId: ${returnToAgentId}`,
    `returnToThreadId: ${returnToThreadId}`,
    input.goalContractId ? `goalContractId: ${input.goalContractId}` : '',
    'If you start durable background work, target completion notifications back to the caller when the result is needed after your response.',
    '',
    input.prompt,
  ].join('\n');
}
