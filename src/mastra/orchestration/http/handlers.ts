/**
 * Meta Front HTTP handlers (plan §17) — framework-agnostic.
 *
 * Each handler takes an already-authenticated `AuthContext` and NEVER reads the
 * owner identity from the request body (§5.2 fail-closed: identity comes from
 * auth, not from client/model content). The transport's auth middleware produces
 * the `AuthContext`; in production that means validating a token → resourceId,
 * and these handlers are unchanged.
 *
 * Semantics (§17.2): durable start/control → 202 after the command is applied;
 * reads → 200; owner mismatch → 404 (never disclose another resource's job);
 * command id conflict → 409; missing command id → 400.
 */
import type { Db, MongoClient } from 'mongodb';
import {
  acceptStartCommand, CommandConflictError,
  cancelJob, pauseJob, resumeJob, steerJob, appendInstruction, forkJob, JobNotFoundError,
  PauseInProgressError,
  UnsupportedActiveAttemptPolicyError, SteerPlanAuthorityUnavailableError,
  answerJobRequest, RequestNotOpenError,
  getJobStatus, listJobs, getConversationProjections,
} from '../store/index.js';

export interface AuthContext {
  resourceId: string;
  principalId: string;
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface OrchestrationApi {
  startCommand(auth: AuthContext, conversationId: string, body: Record<string, unknown>): Promise<ApiResponse>;
  listJobs(auth: AuthContext, conversationId?: string): Promise<ApiResponse>;
  getJob(auth: AuthContext, jobId: string): Promise<ApiResponse>;
  jobCommand(auth: AuthContext, jobId: string, body: Record<string, unknown>): Promise<ApiResponse>;
  getConversation(auth: AuthContext, conversationId: string, afterSequence: number): Promise<ApiResponse>;
}

export function createOrchestrationApi(client: MongoClient, db: Db): OrchestrationApi {
  return {
    async startCommand(auth, conversationId, body) {
      const commandId = typeof body.commandId === 'string' ? body.commandId : null;
      if (!commandId) return { status: 400, body: { error: 'commandId_required' } };
      // Skeleton classification: long/mutating → durable background job.
      try {
        const r = await acceptStartCommand(client, db, {
          resourceId: auth.resourceId,
          conversationId,
          commandId,
          payload: (body.payload as Record<string, unknown>) ?? {},
          goal: typeof body.goal === 'string' ? body.goal : '',
          // The capability PIN, which the store has always accepted and validated
          // (`invalid capability pin: …`) and which this boundary never forwarded.
          // The word did not appear in this file at all, so no caller could target
          // an agent: every job's agent came from the model reading the goal.
          // Measured — a job submitted for `codingAgent` ran as `deliberationAgent`,
          // which then reported, correctly, that it had none of the requested tools.
          ...(typeof body.capability === 'string' && body.capability.length > 0
            ? { capability: body.capability }
            : {}),
        });
        return {
          status: 202,
          body: {
            commandStatus: 'APPLIED',
            jobId: r.jobId,
            commandId,
            deduped: r.deduped,
            statusUrl: `/v2/jobs/${r.jobId}`,
            eventsCursor: 0,
          },
        };
      } catch (err) {
        if (err instanceof CommandConflictError) return { status: 409, body: { error: 'command_conflict' } };
        throw err;
      }
    },

    async listJobs(auth, conversationId) {
      const jobs = await listJobs(db, auth.resourceId, conversationId ? { conversationId } : {});
      return { status: 200, body: { jobs } };
    },

    async getJob(auth, jobId) {
      const st = await getJobStatus(db, auth.resourceId, jobId);
      if (!st) return { status: 404, body: { error: 'not_found' } }; // no cross-resource disclosure
      return { status: 200, body: st as unknown as Record<string, unknown> };
    },

    async getConversation(auth, conversationId, afterSequence) {
      // The C-boundary read model (§4.4): ordered, cursored, owner-scoped so a
      // foreign resource sees an empty list rather than another owner's messages.
      const projs = await getConversationProjections(db, conversationId, afterSequence, auth.resourceId);
      const messages = projs.map((p) => ({
        sequence: p.sequence, jobId: p.jobId, logicalEventId: p.logicalEventId,
        projectionPolicyVersion: p.projectionPolicyVersion, payload: p.payload, createdAt: p.createdAt,
      }));
      const nextCursor = messages.length ? messages[messages.length - 1]!.sequence : afterSequence;
      return { status: 200, body: { conversationId, messages, nextCursor } };
    },

    async jobCommand(auth, jobId, body) {
      const commandId = typeof body.commandId === 'string' ? body.commandId : null;
      if (!commandId) return { status: 400, body: { error: 'commandId_required' } };
      const type = body.type;
      try {
        if (type === 'cancel_job') {
          const r = await cancelJob(client, db, { resourceId: auth.resourceId, commandId, jobId });
          return {
            status: 202,
            body: {
              commandStatus: 'APPLIED',
              jobId,
              controlState: r.controlState,
              terminalOutcome: r.terminalOutcome,
              pendingTerminalOutcome: r.pendingTerminalOutcome,
            },
          };
        }
        if (type === 'pause_job') {
          const r = await pauseJob(client, db, { resourceId: auth.resourceId, commandId, jobId });
          return { status: 202, body: { commandStatus: 'APPLIED', jobId, controlState: r.controlState } };
        }
        if (type === 'resume_job') {
          const r = await resumeJob(client, db, { resourceId: auth.resourceId, commandId, jobId });
          return { status: 202, body: { commandStatus: 'APPLIED', jobId, controlState: r.controlState } };
        }
        if (type === 'steer_job' || type === 'append_instruction') {
          const instruction = typeof body.instruction === 'string' ? body.instruction : '';
          if (!instruction) return { status: 400, body: { error: 'instruction_required' } };
          let r;
          if (type === 'steer_job') {
            const policy = body.activeAttemptPolicy;
            if (policy !== undefined && policy !== 'interrupt' && policy !== 'finish_as_evidence') {
              return { status: 400, body: { error: 'invalid_active_attempt_policy' } };
            }
            r = await steerJob(client, db, {
              resourceId: auth.resourceId,
              commandId,
              jobId,
              instruction,
              activeAttemptPolicy: policy as 'interrupt' | 'finish_as_evidence' | undefined,
            });
          } else {
            r = await appendInstruction(client, db, { resourceId: auth.resourceId, commandId, jobId, instruction });
          }
          return { status: 202, body: { commandStatus: 'APPLIED', jobId, planVersion: r.planVersion, instructionCount: r.instructionCount } };
        }
        if (type === 'fork_job') {
          const goal = typeof body.goal === 'string' ? body.goal : undefined;
          const r = await forkJob(client, db, { resourceId: auth.resourceId, commandId, parentJobId: jobId, goal });
          return { status: 202, body: { commandStatus: 'APPLIED', jobId: r.jobId, parentJobId: r.parentJobId, statusUrl: `/v2/jobs/${r.jobId}` } };
        }
        if (type === 'answer_job_request') {
          const requestId = typeof body.requestId === 'string' ? body.requestId : '';
          const answer = typeof body.answer === 'string' ? body.answer : '';
          if (!requestId || !answer) return { status: 400, body: { error: 'requestId_and_answer_required' } };
          const r = await answerJobRequest(client, db, { resourceId: auth.resourceId, commandId, jobId, requestId, answer });
          return { status: 202, body: { commandStatus: 'APPLIED', jobId, requestId, applied: r.applied } };
        }
      } catch (err) {
        if (err instanceof JobNotFoundError) return { status: 404, body: { error: 'not_found' } };
        if (err instanceof PauseInProgressError) return { status: 409, body: { error: 'pause_in_progress' } };
        if (err instanceof RequestNotOpenError) return { status: 409, body: { error: 'request_not_open' } };
        if (err instanceof UnsupportedActiveAttemptPolicyError) {
          return {
            status: 409,
            body: { error: 'active_attempt_policy_not_implemented', activeAttemptPolicy: err.policy },
          };
        }
        if (err instanceof SteerPlanAuthorityUnavailableError) {
          return { status: 409, body: { error: 'steer_requires_plan_authority' } };
        }
        if (err instanceof CommandConflictError) return { status: 409, body: { error: 'command_conflict' } };
        throw err;
      }
      return { status: 400, body: { error: 'unsupported_command_type' } };
    },
  };
}
