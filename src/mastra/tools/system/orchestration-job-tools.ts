/**
 * Durable-job tools — the FIRST real consumer of the V2 orchestration surface.
 *
 * Until now the V2 substrate existed but nothing called it: no agent, no
 * dashboard. These tools let an agent hand work to the durable substrate instead
 * of `void executeDelegation` (fire-and-forget, process-local, lost on restart),
 * and read it back afterwards.
 *
 * WHY IN-PROCESS, NOT OVER HTTP
 * -----------------------------
 * The V2 API is also mounted at `/v2/...`, but an agent calling its own server
 * over HTTP would inherit the invisible 180s `@mastra/deployer` request wall for
 * no benefit. These tools use the framework-agnostic store functions directly,
 * through the SAME store singleton the mount uses (`getV2Store`), so there is one
 * connection and one set of background loops.
 *
 * IDENTITY IS NOT A TOOL ARGUMENT (§5.2 fail-closed)
 * --------------------------------------------------
 * `resourceId` (the owner) and `conversationId` are derived from the RUN — the
 * harness execution context when there is one, otherwise Mastra's own tool
 * execution context — and can NEVER be supplied by the model. If the model could pass `resourceId`, it could read or
 * cancel another owner's jobs simply by asking. Every query below is owner-scoped
 * with that derived value, so an unowned job is indistinguishable from a missing
 * one.
 *
 * SCOPE (honest)
 * --------------
 * Routing is still `singleAgentRoute`: every V2 job goes to
 * ORCHESTRATION_V2_DEFAULT_AGENT, so this is a canary channel to ONE capability,
 * not general capability routing (that is Fala 6-8).
 *
 * The command surface is now complete against what the store actually supports:
 * start / get / list / cancel / pause / resume / append / steer / fork / answer.
 * Two deliberate omissions: `activeAttemptPolicy: finish_as_evidence` is not
 * exposed because it is fail-closed until `ORC-TXN-A-EVIDENCE-01` exists (a
 * switch that always errors is worse than no switch), and post-plan `steer` is
 * refused by the store itself — the tool explains the alternative rather than
 * surfacing a raw 409.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { getHarnessExecutionContext } from '../../services/harness-execution-context.js';
import { canonicalizeRuntimeAgentId } from '../../config/agent-ids.js';
import { durableJobOwner } from '../../services/durable-delegation.js';
import { getV2Store } from '../../orchestration/http/mastra-routes.js';
import {
  acceptStartCommand,
  cancelJob,
  pauseJob,
  resumeJob,
  steerJob,
  appendInstruction,
  forkJob,
  answerJobRequest,
  getJobStatus,
  getJobResult,
  renderProducerText,
  listJobs,
  CommandConflictError,
  JobNotFoundError,
  PauseInProgressError,
  RequestNotOpenError,
  SteerPlanAuthorityUnavailableError,
  UnsupportedActiveAttemptPolicyError,
} from '../../orchestration/store/index.js';

const FEATURE_FLAG = 'FEATURE_ORCHESTRATION_V2_AGENT_TOOLS';

/** Keep tool output small: an agent re-reads this on every poll. */
const MAX_RESULT_CHARS = 8_000;

function toolsEnabled(): boolean {
  return process.env[FEATURE_FLAG] === 'true' && process.env.FEATURE_ORCHESTRATION_V2 === 'true';
}

interface CallerIdentity { resourceId: string; conversationId: string; agentId: string }

/**
 * Runtime-supplied execution context. Mastra passes this as the SECOND argument
 * to `execute`; it is part of the invocation envelope, not the model's output.
 */
interface ToolRuntimeContext {
  /**
   * Mastra nests the agent-call identity HERE, not at the top level.
   *
   * This interface previously declared `agentId`/`threadId`/`resourceId` as its
   * own fields — a shape Mastra never passes. Every read returned `undefined`,
   * so the "ordinary agent API" fallback below could not work at all: the front
   * could hold a conversation but every attempt to queue work answered "no run
   * identity". Confirmed from a runtime dump, not from the type: the second
   * argument carries `mastra, memory, runId, requestContext, …, agent`, and the
   * identity lives on `agent` (`AgentToolExecutionContext` in @mastra/core).
   */
  agent?: { agentId?: string; threadId?: string; resourceId?: string };
}

/**
 * Owner identity for this call.
 *
 * Two sources, in order, and NEITHER is a tool argument (see the header note on
 * why the model must never supply this):
 *
 *  1. the harness execution context — present when the call happens inside a
 *     delegation/harness run (e.g. `metaAgent` mid-task);
 *  2. Mastra's own tool execution context — present when the agent is invoked
 *     through the ordinary agent API, which opens no harness run.
 *
 * The second source is what makes these tools usable by the Meta Front at all:
 * a conversational agent reached over the ordinary agent generate endpoint has
 * no harness context, so before this fallback existed every `start_job` from the
 * front failed with "no run identity" — found the first time the front was
 * actually asked to queue work.
 */
function callerIdentity(runtime?: ToolRuntimeContext): CallerIdentity | null {
  const harness = getHarnessExecutionContext();
  const rawAgentId = harness?.agentId ?? runtime?.agent?.agentId;
  const conversationId = harness?.threadId ?? harness?.taskId ?? runtime?.agent?.threadId;
  // Canonicalized so BOTH doors land in one owner space: the dedicated front
  // endpoint stamps `metaFrontAgent`, an ordinary Studio chat supplies Mastra's
  // `meta-front`. Keyed raw, a job started through one door is invisible through
  // the other — and owner scoping reports that as "does not exist".
  const agentId = canonicalizeRuntimeAgentId(rawAgentId);
  if (!agentId || !conversationId) return null;
  // Owner stays keyed to the AGENT rather than `runtime.resourceId` (the end
  // user) — see `durableJobOwner`, which is now the single definition shared with
  // the F6 delegation cutover so the two producers cannot drift apart.
  return { resourceId: durableJobOwner(agentId), conversationId, agentId };
}

function disabled(): { success: false; error: string } {
  return {
    success: false,
    error: `Durable jobs are unavailable: set ${FEATURE_FLAG}=true and FEATURE_ORCHESTRATION_V2=true.`,
  };
}

function noIdentity(): { success: false; error: string } {
  return {
    success: false,
    error: 'No run identity (owner + conversation) is available for this call. Durable jobs derive identity from the run, never from an argument.',
  };
}

function truncate(value: string): string {
  return value.length <= MAX_RESULT_CHARS
    ? value
    : `${value.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${value.length} chars total)`;
}

/**
 * What the Meta Front shows the user when a job finishes.
 *
 * This stringified the producer envelope, so a finished job read back as
 * `{"text":"# Odświeżone menu…"}` with every newline escaped — the deliverable,
 * wrapped in machinery, for the one reader who only wants the deliverable.
 * Shared with the judge and the plan-step renderer now (`renderProducerText`).
 */
function renderResultData(data: unknown): string | null {
  const text = renderProducerText(data);
  return text.length > 0 ? truncate(text) : null;
}

export const startDurableJobTool = createTool({
  id: 'orchestration_start_job',
  description:
    'Hand a goal to the DURABLE orchestration substrate and get a jobId back immediately. '
    + 'Unlike ordinary delegation, the job survives a restart of this process and can be polled '
    + 'later with orchestration_get_job. Use for work that must not be lost. '
    + 'Returns immediately — it does NOT wait for the job to finish.',
  inputSchema: z.object({
    goal: z.string().min(1).describe('What the job should accomplish. This becomes the worker prompt.'),
    idempotencyKey: z.string().optional()
      .describe('Optional. Reuse the same key to make a retry return the SAME job instead of starting a second one.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();

    try {
      const { client, db } = await getV2Store();
      const accepted = await acceptStartCommand(client, db, {
        resourceId: identity.resourceId,
        conversationId: identity.conversationId,
        goal: context.goal,
        commandId: context.idempotencyKey ?? randomUUID(),
        // The goal MUST go in `payload`, even though it is also passed above:
        // `acceptStartCommand` builds its dedupe hash from `payload` alone. With
        // an empty payload, reusing one key with a DIFFERENT goal would hash
        // identically and silently hand back the FIRST job — the caller would
        // believe its new goal was accepted when nothing was queued. Including it
        // turns that into an explicit conflict.
        payload: { goal: context.goal },
      });
      return {
        success: true,
        jobId: accepted.jobId,
        deduped: accepted.deduped,
        note: accepted.deduped
          ? 'This idempotencyKey was already used — returning the existing job, no second job was started.'
          : 'Job accepted and durable. Poll orchestration_get_job for the outcome; it is NOT finished yet.',
      };
    } catch (error) {
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'That idempotencyKey was already used with a DIFFERENT goal. Use a new key.' };
      }
      return { success: false, error: `Could not start durable job: ${(error as Error).message}` };
    }
  },
});

export const getDurableJobTool = createTool({
  id: 'orchestration_get_job',
  description:
    'Read the status of a durable job started with orchestration_start_job, including its result once finished. '
    + 'Read-only: polling never wakes, restarts or extends the job.',
  inputSchema: z.object({
    jobId: z.string().min(1).describe('The jobId returned by orchestration_start_job.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();

    try {
      const { db } = await getV2Store();
      const status = await getJobStatus(db, identity.resourceId, context.jobId);
      // Owner mismatch and "no such job" are deliberately the same answer.
      if (!status) return { success: false, error: `No such job: ${context.jobId}` };

      const finished = status.phase === 'TERMINAL';
      const result = finished ? await getJobResult(db, identity.resourceId, context.jobId) : null;

      return {
        success: true,
        jobId: status.jobId,
        phase: status.phase,
        finished,
        terminalOutcome: status.terminalOutcome,
        goal: status.goal,
        ...(status.openRequest ? { awaitingAnswer: status.openRequest } : {}),
        ...(result
          ? {
              result: {
                status: result.status,
                text: renderResultData(result.data),
                summary: result.summary,
                error: result.error,
              },
            }
          : {}),
        ...(finished && !result
          ? { note: 'The job is terminal but committed no result payload (e.g. cancelled before producing one).' }
          : {}),
      };
    } catch (error) {
      return { success: false, error: `Could not read durable job: ${(error as Error).message}` };
    }
  },
});

export const listDurableJobsTool = createTool({
  id: 'orchestration_list_jobs',
  description:
    'List durable jobs started in THIS conversation, newest first. Read-only.',
  inputSchema: z.object({
    limit: z.number().int().positive().max(50).optional().describe('How many to return (default 10, max 50).'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();

    try {
      const { db } = await getV2Store();
      const jobs = await listJobs(db, identity.resourceId, {
        conversationId: identity.conversationId,
        limit: context.limit ?? 10,
      });
      return {
        success: true,
        count: jobs.length,
        jobs: jobs.map((j) => ({
          jobId: j.jobId,
          phase: j.phase,
          terminalOutcome: j.terminalOutcome,
          goal: j.goal,
          updatedAt: j.updatedAt,
        })),
      };
    } catch (error) {
      return { success: false, error: `Could not list durable jobs: ${(error as Error).message}` };
    }
  },
});

export const cancelDurableJobTool = createTool({
  id: 'orchestration_cancel_job',
  description:
    'Request cancellation of a durable job. The job crosses a durable stop barrier — '
    + 'it may settle as CANCELLED or, if its work was already committed, as its real outcome. '
    + 'Poll orchestration_get_job afterwards to see how it actually settled.',
  inputSchema: z.object({
    jobId: z.string().min(1).describe('The jobId to cancel.'),
    reason: z.string().optional().describe('Optional human-readable reason, recorded with the command.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();

    try {
      const { client, db } = await getV2Store();
      // Owner-scope first: cancelJob throws JobNotFoundError for a foreign job,
      // but checking here keeps the "unowned looks missing" answer uniform.
      const status = await getJobStatus(db, identity.resourceId, context.jobId);
      if (!status) return { success: false, error: `No such job: ${context.jobId}` };

      const outcome = await cancelJob(client, db, {
        resourceId: identity.resourceId,
        commandId: `cancel:${context.jobId}`,
        jobId: context.jobId,
      });
      return {
        success: true,
        jobId: context.jobId,
        controlState: outcome.controlState,
        terminalOutcome: outcome.terminalOutcome,
        pendingTerminalOutcome: outcome.pendingTerminalOutcome,
        note: outcome.terminalOutcome
          ? 'The job is already terminal.'
          : 'Stop requested. The job settles once its open work reaches the barrier — poll orchestration_get_job.',
        ...(context.reason ? { reason: context.reason } : {}),
      };
    } catch (error) {
      if (error instanceof JobNotFoundError) return { success: false, error: `No such job: ${context.jobId}` };
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'A different cancel command for this job is already recorded.' };
      }
      return { success: false, error: `Could not cancel durable job: ${(error as Error).message}` };
    }
  },
});

/**
 * Control commands (pause/resume/steer/append/fork/answer) each need a FRESH
 * commandId by default.
 *
 * `applyControl` hashes only `{type, jobId}`, so reusing one key for a second
 * pause on the same job finds the recorded command, dedupes, and returns
 * `changed: false` with the CURRENT state — the pause simply does not happen.
 * A pause→resume→pause cycle with a fixed key would therefore silently leave the
 * job running. Callers get a random key unless they deliberately pass one to
 * make a retry safe.
 */
function commandIdFor(idempotencyKey?: string): string {
  return idempotencyKey ?? randomUUID();
}

export const pauseDurableJobTool = createTool({
  id: 'orchestration_pause_job',
  description:
    'Pause a durable job. Work already in flight finishes and settles first (pause is a barrier, not a kill). '
    + 'Use orchestration_resume_job to continue. To stop permanently use orchestration_cancel_job instead.',
  inputSchema: z.object({
    jobId: z.string().min(1),
    idempotencyKey: z.string().optional()
      .describe('Optional. Only for making a retry of THIS pause safe — do not reuse across separate pauses.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();
    try {
      const { client, db } = await getV2Store();
      if (!await getJobStatus(db, identity.resourceId, context.jobId)) {
        return { success: false, error: `No such job: ${context.jobId}` };
      }
      const result = await pauseJob(client, db, {
        resourceId: identity.resourceId,
        commandId: commandIdFor(context.idempotencyKey),
        jobId: context.jobId,
      });
      return {
        success: true,
        jobId: context.jobId,
        controlState: result.controlState,
        changed: result.changed,
        note: result.changed
          ? 'Pause requested. In-flight work settles at the barrier before the job stops.'
          : 'Nothing changed — the job was not in a pausable state.',
      };
    } catch (error) {
      if (error instanceof JobNotFoundError) return { success: false, error: `No such job: ${context.jobId}` };
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'That idempotencyKey is already recorded for a different command.' };
      }
      return { success: false, error: `Could not pause job: ${(error as Error).message}` };
    }
  },
});

export const resumeDurableJobTool = createTool({
  id: 'orchestration_resume_job',
  description:
    'Resume a paused durable job. If work is still settling inside the pause barrier this is refused — '
    + 'wait and retry rather than treating it as an error.',
  inputSchema: z.object({
    jobId: z.string().min(1),
    idempotencyKey: z.string().optional().describe('Optional. Only for making a retry of THIS resume safe.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();
    try {
      const { client, db } = await getV2Store();
      if (!await getJobStatus(db, identity.resourceId, context.jobId)) {
        return { success: false, error: `No such job: ${context.jobId}` };
      }
      const result = await resumeJob(client, db, {
        resourceId: identity.resourceId,
        commandId: commandIdFor(context.idempotencyKey),
        jobId: context.jobId,
      });
      return { success: true, jobId: context.jobId, controlState: result.controlState, changed: result.changed };
    } catch (error) {
      if (error instanceof JobNotFoundError) return { success: false, error: `No such job: ${context.jobId}` };
      if (error instanceof PauseInProgressError) {
        return {
          success: false,
          retryable: true,
          error: 'The pause barrier has not settled yet — in-flight work is still finishing. Wait a moment and retry.',
        };
      }
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'That idempotencyKey is already recorded for a different command.' };
      }
      return { success: false, error: `Could not resume job: ${(error as Error).message}` };
    }
  },
});

export const appendJobInstructionTool = createTool({
  id: 'orchestration_append_instruction',
  description:
    'Add context to a running durable job WITHOUT changing its plan or interrupting current work. '
    + 'Later attempts see the instruction. Use this for "also keep in mind X"; '
    + 'use orchestration_steer_job to actually change the plan.',
  inputSchema: z.object({
    jobId: z.string().min(1),
    instruction: z.string().min(1).describe('Extra context for the job.'),
    idempotencyKey: z.string().optional().describe('Optional. Reuse to make a retry of THIS append safe.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();
    try {
      const { client, db } = await getV2Store();
      if (!await getJobStatus(db, identity.resourceId, context.jobId)) {
        return { success: false, error: `No such job: ${context.jobId}` };
      }
      const result = await appendInstruction(client, db, {
        resourceId: identity.resourceId,
        commandId: commandIdFor(context.idempotencyKey),
        jobId: context.jobId,
        instruction: context.instruction,
      });
      return {
        success: true,
        jobId: context.jobId,
        planVersion: result.planVersion,
        instructionCount: result.instructionCount,
        deduped: result.deduped,
      };
    } catch (error) {
      if (error instanceof JobNotFoundError) return { success: false, error: `No such job: ${context.jobId}` };
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'That idempotencyKey was already used with a different instruction. Use a new key.' };
      }
      return { success: false, error: `Could not append instruction: ${(error as Error).message}` };
    }
  },
});

export const steerDurableJobTool = createTool({
  id: 'orchestration_steer_job',
  description:
    'Change a durable job\'s plan before any work has been materialized. '
    + 'Only valid BEFORE the job has produced its first task — after that it is refused, '
    + 'because an old-plan result could otherwise terminalize the new plan. '
    + 'For a job already underway, use orchestration_append_instruction (add context) '
    + 'or orchestration_cancel_job + a fresh start instead.',
  inputSchema: z.object({
    jobId: z.string().min(1),
    instruction: z.string().min(1).describe('The new direction for the job.'),
    idempotencyKey: z.string().optional().describe('Optional. Reuse to make a retry of THIS steer safe.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();
    try {
      const { client, db } = await getV2Store();
      if (!await getJobStatus(db, identity.resourceId, context.jobId)) {
        return { success: false, error: `No such job: ${context.jobId}` };
      }
      // `activeAttemptPolicy` is deliberately NOT exposed: the only other value,
      // `finish_as_evidence`, is fail-closed until ORC-TXN-A-EVIDENCE-01 exists,
      // so offering it would be offering a switch that always errors.
      const result = await steerJob(client, db, {
        resourceId: identity.resourceId,
        commandId: commandIdFor(context.idempotencyKey),
        jobId: context.jobId,
        instruction: context.instruction,
      });
      return {
        success: true,
        jobId: context.jobId,
        planVersion: result.planVersion,
        instructionCount: result.instructionCount,
        deduped: result.deduped,
      };
    } catch (error) {
      if (error instanceof JobNotFoundError) return { success: false, error: `No such job: ${context.jobId}` };
      if (error instanceof SteerPlanAuthorityUnavailableError) {
        return {
          success: false,
          error: 'This job already has materialized work, so its plan cannot be changed safely. '
            + 'Use orchestration_append_instruction to add context, or cancel it and start a new job.',
        };
      }
      if (error instanceof UnsupportedActiveAttemptPolicyError) {
        return { success: false, error: `Active-attempt policy not implemented: ${error.policy}` };
      }
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'That idempotencyKey was already used with a different instruction. Use a new key.' };
      }
      return { success: false, error: `Could not steer job: ${(error as Error).message}` };
    }
  },
});

export const forkDurableJobTool = createTool({
  id: 'orchestration_fork_job',
  description:
    'Create a NEW durable job from an existing one, optionally with a different goal. '
    + 'The fork is detached: it gets its own identity and snapshot, and the parent is unaffected. '
    + 'Use to explore a variation without disturbing work already running.',
  inputSchema: z.object({
    jobId: z.string().min(1).describe('The parent job to fork from.'),
    goal: z.string().optional().describe('Goal for the fork. Omit to inherit the parent\'s goal.'),
    idempotencyKey: z.string().optional().describe('Optional. Reuse to make a retry return the same fork.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();
    try {
      const { client, db } = await getV2Store();
      if (!await getJobStatus(db, identity.resourceId, context.jobId)) {
        return { success: false, error: `No such job: ${context.jobId}` };
      }
      const result = await forkJob(client, db, {
        resourceId: identity.resourceId,
        commandId: commandIdFor(context.idempotencyKey),
        parentJobId: context.jobId,
        goal: context.goal,
      });
      return {
        success: true,
        jobId: result.jobId,
        parentJobId: result.parentJobId,
        note: 'Forked into a NEW job — poll this new jobId, not the parent.',
      };
    } catch (error) {
      if (error instanceof JobNotFoundError) return { success: false, error: `No such job: ${context.jobId}` };
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'That idempotencyKey was already used with a different fork goal. Use a new key.' };
      }
      return { success: false, error: `Could not fork job: ${(error as Error).message}` };
    }
  },
});

export const answerDurableJobTool = createTool({
  id: 'orchestration_answer_job_request',
  description:
    'Answer a question a durable job is waiting on. '
    + 'orchestration_get_job reports the open question under `awaitingAnswer` (with its requestId) '
    + 'when the job is blocked on one.',
  inputSchema: z.object({
    jobId: z.string().min(1),
    requestId: z.string().min(1).describe('From `awaitingAnswer.requestId` in orchestration_get_job.'),
    answer: z.string().min(1),
    idempotencyKey: z.string().optional().describe('Optional. Reuse to make a retry of THIS answer safe.'),
  }),
  execute: async (context, runtime) => {
    if (!toolsEnabled()) return disabled();
    const identity = callerIdentity(runtime as ToolRuntimeContext | undefined);
    if (!identity) return noIdentity();
    try {
      const { client, db } = await getV2Store();
      if (!await getJobStatus(db, identity.resourceId, context.jobId)) {
        return { success: false, error: `No such job: ${context.jobId}` };
      }
      const result = await answerJobRequest(client, db, {
        resourceId: identity.resourceId,
        commandId: commandIdFor(context.idempotencyKey),
        jobId: context.jobId,
        requestId: context.requestId,
        answer: context.answer,
      });
      return { success: true, jobId: context.jobId, requestId: context.requestId, applied: result.applied };
    } catch (error) {
      if (error instanceof JobNotFoundError) return { success: false, error: `No such job: ${context.jobId}` };
      if (error instanceof RequestNotOpenError) {
        return {
          success: false,
          error: 'That question is no longer open — it was already answered or it expired. '
            + 'Re-read the job with orchestration_get_job.',
        };
      }
      if (error instanceof CommandConflictError) {
        return { success: false, error: 'That idempotencyKey was already used with a different answer. Use a new key.' };
      }
      return { success: false, error: `Could not answer job request: ${(error as Error).message}` };
    }
  },
});

/** All durable-job tools, for conditional registration on an agent. */
export const durableJobTools = {
  startDurableJobTool,
  getDurableJobTool,
  listDurableJobsTool,
  cancelDurableJobTool,
  pauseDurableJobTool,
  resumeDurableJobTool,
  appendJobInstructionTool,
  steerDurableJobTool,
  forkDurableJobTool,
  answerDurableJobTool,
};
