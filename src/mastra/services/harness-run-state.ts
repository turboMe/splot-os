/**
 * Persistent run state for the Mastra Harness Layer.
 *
 * This is intentionally best-effort: telemetry/state failures must not block
 * agent execution. The canonical live action still happens through Mastra.
 */

import { randomUUID } from 'crypto';

import { getDb } from '../lib/mongo.js';
import { logHarnessEvent } from './harness-events.js';

export type AgentRunStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type AgentRun = {
  runId: string;
  threadId?: string;
  taskId?: string;
  agentId: string;
  status: AgentRunStatus;
  phase: string;
  currentSubtaskId?: string;
  repoPath?: string;
  model?: string;
  safeInterruptPoint: boolean;
  lastPromptHash?: string;
  lastContextHash?: string;
  lastProviderCallAt?: Date;
  turnCount: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  errorClass?: string;
  errorMessage?: string;
};

export type AgentRunEvent = {
  id: string;
  runId: string;
  turnId?: string;
  taskId?: string;
  subtaskId?: string;
  agentId: string;
  type: string;
  phase?: string;
  timestamp: Date;
  durationMs?: number;
  data?: Record<string, unknown>;
  preview?: string;
  artifactId?: string;
  expiresAt: Date;
};

export type BeginHarnessTurnInput = {
  runId: string;
  turnId: string;
  agentId: string;
  taskId?: string;
  subtaskId?: string;
  threadId?: string;
  phase: string;
  repoPath?: string;
  model?: string;
  promptHash?: string;
  contextHash?: string;
};

export type CompleteHarnessTurnInput = BeginHarnessTurnInput & {
  durationMs: number;
  outputPreview?: string;
  outputArtifactId?: string;
};

export type FailHarnessTurnInput = BeginHarnessTurnInput & {
  durationMs: number;
  errorClass?: string;
  errorMessage: string;
};

const RUNS_COLLECTION = 'agent_runs';
const EVENTS_COLLECTION = 'agent_run_events';
const RUN_EVENT_TTL_MS = 30 * 24 * 3600 * 1000;

export async function beginHarnessTurn(input: BeginHarnessTurnInput): Promise<void> {
  try {
    const db = await getDb();
    const now = new Date();
    const existing = await db.collection<AgentRun>(RUNS_COLLECTION).findOne({ runId: input.runId });
    const set: Partial<AgentRun> = compactObject({
      threadId: input.threadId,
      taskId: input.taskId,
      agentId: input.agentId,
      status: 'active' as const,
      phase: input.phase,
      currentSubtaskId: input.subtaskId,
      repoPath: input.repoPath,
      model: input.model,
      safeInterruptPoint: false,
      lastPromptHash: input.promptHash,
      lastContextHash: input.contextHash,
      lastProviderCallAt: now,
      updatedAt: now,
    });

    await db.collection<AgentRun>(RUNS_COLLECTION).updateOne(
      { runId: input.runId },
      {
        $setOnInsert: {
          runId: input.runId,
          createdAt: now,
        },
        $set: set,
        $unset: {
          completedAt: '',
          errorClass: '',
          errorMessage: '',
        },
        $inc: { turnCount: 1 },
      },
      { upsert: true },
    );

    if (!existing) {
      await appendRunEvent({
        ...input,
        type: 'run_started',
        data: {
          repoPath: input.repoPath,
          model: input.model,
          promptHash: input.promptHash,
          contextHash: input.contextHash,
        },
      });
      await logHarnessEvent({
        type: 'run_started',
        agentId: input.agentId,
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        feature: 'harness_run_state',
        model: input.model,
        status: 'success',
        data: { phase: input.phase, repoPath: input.repoPath },
      });
    } else if (existing.phase !== input.phase) {
      await appendRunEvent({
        ...input,
        type: 'run_phase_changed',
        data: { from: existing.phase, to: input.phase },
      });
      await logHarnessEvent({
        type: 'run_phase_changed',
        agentId: input.agentId,
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        feature: 'harness_run_state',
        model: input.model,
        status: 'success',
        data: { from: existing.phase, to: input.phase },
      });
    }

    await appendRunEvent({
      ...input,
      type: 'llm_call_started',
      data: {
        promptHash: input.promptHash,
        contextHash: input.contextHash,
      },
    });
  } catch (error) {
    console.warn('[HarnessRunState] begin failed:', (error as Error).message);
  }
}

export async function completeHarnessTurn(input: CompleteHarnessTurnInput): Promise<void> {
  try {
    const db = await getDb();
    const now = new Date();
    await db.collection<AgentRun>(RUNS_COLLECTION).updateOne(
      { runId: input.runId },
      {
        $set: compactObject({
          status: 'completed' as const,
          phase: input.phase,
          currentSubtaskId: input.subtaskId,
          repoPath: input.repoPath,
          model: input.model,
          safeInterruptPoint: true,
          lastPromptHash: input.promptHash,
          lastContextHash: input.contextHash,
          updatedAt: now,
          completedAt: now,
        }),
        $unset: {
          errorClass: '',
          errorMessage: '',
        },
      },
      { upsert: false },
    );

    await appendRunEvent({
      ...input,
      type: 'llm_call_completed',
      durationMs: input.durationMs,
      preview: input.outputPreview,
      artifactId: input.outputArtifactId,
      data: {
        promptHash: input.promptHash,
        contextHash: input.contextHash,
        outputArtifactId: input.outputArtifactId,
      },
    });
    await appendRunEvent({
      ...input,
      type: 'run_completed',
      durationMs: input.durationMs,
      preview: input.outputPreview,
      artifactId: input.outputArtifactId,
      data: {
        phase: input.phase,
        outputArtifactId: input.outputArtifactId,
      },
    });
    await logHarnessEvent({
      type: 'run_completed',
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'harness_run_state',
      model: input.model,
      status: 'success',
      durationMs: input.durationMs,
      output: input.outputPreview,
      data: {
        phase: input.phase,
        outputArtifactId: input.outputArtifactId,
      },
    });
  } catch (error) {
    console.warn('[HarnessRunState] complete failed:', (error as Error).message);
  }
}

export async function failHarnessTurn(input: FailHarnessTurnInput): Promise<void> {
  try {
    const db = await getDb();
    const now = new Date();
    await db.collection<AgentRun>(RUNS_COLLECTION).updateOne(
      { runId: input.runId },
      {
        $set: compactObject({
          status: 'failed' as const,
          phase: input.phase,
          currentSubtaskId: input.subtaskId,
          repoPath: input.repoPath,
          model: input.model,
          safeInterruptPoint: true,
          lastPromptHash: input.promptHash,
          lastContextHash: input.contextHash,
          updatedAt: now,
          completedAt: now,
          errorClass: input.errorClass,
          errorMessage: input.errorMessage,
        }),
      },
      { upsert: false },
    );

    await appendRunEvent({
      ...input,
      type: 'llm_call_failed',
      durationMs: input.durationMs,
      data: {
        promptHash: input.promptHash,
        contextHash: input.contextHash,
        errorClass: input.errorClass,
        errorMessage: input.errorMessage,
      },
    });
    await appendRunEvent({
      ...input,
      type: 'run_failed',
      durationMs: input.durationMs,
      data: {
        errorClass: input.errorClass,
        errorMessage: input.errorMessage,
      },
    });
    await logHarnessEvent({
      type: 'run_failed',
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      threadId: input.threadId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      feature: 'harness_run_state',
      model: input.model,
      status: 'error',
      durationMs: input.durationMs,
      errorMessage: input.errorMessage,
      data: { phase: input.phase, errorClass: input.errorClass },
    });
  } catch (error) {
    console.warn('[HarnessRunState] fail failed:', (error as Error).message);
  }
}

export async function appendRunEvent(input: Omit<AgentRunEvent, 'id' | 'timestamp' | 'expiresAt'>): Promise<void> {
  const db = await getDb();
  await db.collection<AgentRunEvent>(EVENTS_COLLECTION).insertOne({
    ...input,
    id: randomUUID(),
    timestamp: new Date(),
    expiresAt: new Date(Date.now() + RUN_EVENT_TTL_MS),
  });
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
