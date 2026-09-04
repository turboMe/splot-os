import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

import type { Agent } from '@mastra/core/agent';
import { META_AGENT_ID } from '../config/agent-ids.js';
import { logHarnessEvent } from '../services/harness-events.js';
import { queuePendingMessage } from '../services/pending-message-queue.js';
import { parseResultEnvelope } from '../services/result-envelope.js';
import { getArtifact } from '../services/artifact-store.js';
import { generateWithHarness } from '../services/generate-with-harness.js';
import {
  beginScheduledTaskDispatch,
  buildNextScheduledTaskInput,
  completeScheduledTaskDispatch,
  createScheduledTask,
  failScheduledTaskDispatch,
  getScheduledTaskIdempotencyKey,
  leaseDueScheduledTask,
  markScheduledTaskCompleted,
  markScheduledTaskFailed,
  markScheduledTaskRunning,
  type CreateScheduledTaskInput,
  type ScheduledTask,
} from '../services/scheduled-task-store.js';
import {
  formatTaskChainContext,
  getTaskChainContext,
  saveTaskChainResult,
} from '../services/task-chain-store.js';
import { sendTelegramAlert } from '../tools/communication/telegram.js';
import { N8nService } from '../tools/n8n/client.js';

type MastraLike = {
  getAgent: (id: string) => any;
  getWorkflow: (id: string) => any;
};

export type ScheduledDispatchResult = {
  success: boolean;
  status: string;
  targetType: ScheduledTask['targetType'];
  targetIdentifier: string;
  output?: unknown;
  text?: string;
  runId?: string;
  error?: string;
};

export type ProcessScheduledTaskResult = {
  processed: boolean;
  taskId?: string;
  chainId?: string;
  status: 'idle' | 'completed' | 'retry_scheduled' | 'failed';
  dispatch?: ScheduledDispatchResult;
  nextTaskId?: string;
  recurringTaskId?: string;
  pendingMessageId?: string;
  /** Successors that could not be created. Empty is the normal case. */
  successorErrors?: string[];
  error?: string;
};

export type ScheduledTaskRunnerOptions = {
  runnerId?: string;
  mastra?: MastraLike;
  intervalMs?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  once?: boolean;
};

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

export async function processOneDueScheduledTask(input: {
  runnerId?: string;
  mastra?: MastraLike;
  now?: Date;
  leaseMs?: number;
} = {}): Promise<ProcessScheduledTaskResult> {
  const runnerId = input.runnerId ?? defaultRunnerId();
  const task = await leaseDueScheduledTask({
    runnerId,
    now: input.now,
    leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
  });

  if (!task) {
    return { processed: false, status: 'idle' };
  }

  const leaseId = task.lease?.leaseId;
  const startedAt = Date.now();
  const effectiveCycleId = task.cycleId
    ?? (task.schedule.cronExpression ? `${task.chainId ?? task.taskId}:${new Date(startedAt).toISOString().slice(0, 10)}` : task.chainId);
  if (task.chainId && !task.cycleId) {
    task.cycleId = effectiveCycleId;
  }

  await logScheduledTaskStarted(task, runnerId);

  try {
    const runningTask = await markScheduledTaskRunning(task.taskId, leaseId);
    if (!runningTask) {
      throw new Error(`Scheduled task ${task.taskId} lease could not be promoted to running.`);
    }

    const dispatch = await dispatchScheduledTask(task, input.mastra);
    if (!dispatch.success) {
      throw new Error(dispatch.error ?? `Scheduled task ${task.taskId} dispatch returned success=false.`);
    }

    let extractedArtifacts: Array<{ id: string; type: string; summary?: string }> = [];
    if (dispatch.text) {
      try {
        const envelope = parseResultEnvelope(dispatch.text);
        if (envelope.artifacts && envelope.artifacts.length > 0) {
          extractedArtifacts = envelope.artifacts.map(a => ({
            id: a.id,
            type: a.type,
            summary: a.summary,
          }));
        }
      } catch (err) {
        console.warn(`[scheduled-task-runner] Failed to parse result envelope for task ${task.taskId}:`, err);
      }
    }

    const resultPreview = previewDispatch(dispatch);
    if (task.chainId) {
      await saveTaskChainResult({
        chainId: task.chainId,
        cycleId: task.cycleId,
        stepName: task.stepName ?? task.targetIdentifier,
        taskId: task.taskId,
        status: 'completed',
        result: dispatch,
        artifacts: extractedArtifacts,
        metadata: {
          targetType: task.targetType,
          targetIdentifier: task.targetIdentifier,
          runnerId,
        },
      });
    }

    const completed = await markScheduledTaskCompleted({
      taskId: task.taskId,
      leaseId,
      resultPreview,
    });
    if (!completed) {
      await logHarnessEvent({
        type: 'bg_task_completed',
        agentId: META_AGENT_ID,
        taskId: task.taskId,
        threadId: task.parentThreadId,
        feature: 'scheduled_task_runner',
        status: 'error',
        errorMessage: 'lease lost before completion; another runner owns this occurrence',
        output: 'schedule NOT advanced by this runner',
        data: { runnerId, chainId: task.chainId, leaseLost: true },
      });
      return {
        processed: true,
        taskId: task.taskId,
        chainId: task.chainId,
        status: 'completed',
        dispatch,
      };
    }

    // Two independent successors, and the order is load-bearing.
    //
    // These used to be two bare awaits with the chain step first, inside the
    // method's single try/catch. A `nextStep` that failed to validate therefore
    // threw past the recurrence, so the DAILY SCHEDULE stopped — punished for a
    // fault in tomorrow's second step. Worse, the throw landed in a catch whose
    // `markScheduledTaskFailed` is lease-scoped, and the lease was already gone
    // with the completion: the update matched nothing and the occurrence stayed
    // `completed`. A dead schedule that reads as a healthy one.
    //
    // The recurrence is what keeps the trigger alive, so it goes first, and
    // neither can reach the other's failure.
    const recurrence = await createSuccessor('recurrence', task, () => scheduleRecurringTask(task));
    const next = await createSuccessor('next_step', task, () => scheduleNextStep(task));
    const successorErrors = [recurrence.error, next.error].filter(Boolean) as string[];

    const nextTask = next.task;
    const recurringTask = recurrence.task;
    const pendingMessageId = await queueTaskWake(task, {
      status: 'completed',
      dispatch,
      nextTaskId: nextTask?.taskId,
      recurringTaskId: recurringTask?.taskId,
    });

    await logScheduledTaskCompleted(task, {
      durationMs: Date.now() - startedAt,
      dispatch,
      nextTaskId: nextTask?.taskId,
      recurringTaskId: recurringTask?.taskId,
      pendingMessageId,
    });

    return {
      processed: true,
      taskId: task.taskId,
      chainId: task.chainId,
      status: 'completed',
      dispatch,
      nextTaskId: nextTask?.taskId,
      recurringTaskId: recurringTask?.taskId,
      pendingMessageId,
      ...(successorErrors.length ? { successorErrors } : {}),
    };
  } catch (error) {
    const err = error as Error;
    if (task.chainId) {
      await saveTaskChainResult({
        chainId: task.chainId,
        cycleId: task.cycleId,
        stepName: task.stepName ?? task.targetIdentifier,
        taskId: task.taskId,
        status: 'failed',
        error: err.message,
        metadata: {
          targetType: task.targetType,
          targetIdentifier: task.targetIdentifier,
          runnerId,
        },
      });
    }

    const failure = await markScheduledTaskFailed({
      taskId: task.taskId,
      leaseId,
      error: err.message,
      now: input.now,
    });

    const pendingMessageId = failure.retryScheduled
      ? undefined
      : await queueTaskWake(task, {
        status: 'failed',
        error: err.message,
      });

    await logScheduledTaskFailed(task, {
      durationMs: Date.now() - startedAt,
      error: err.message,
      retryScheduled: failure.retryScheduled,
      pendingMessageId,
    });

    return {
      processed: true,
      taskId: task.taskId,
      chainId: task.chainId,
      status: failure.retryScheduled ? 'retry_scheduled' : 'failed',
      pendingMessageId,
      error: err.message,
    };
  }
}

export async function dispatchScheduledTask(
  task: ScheduledTask,
  mastra?: MastraLike,
): Promise<ScheduledDispatchResult> {
  const idempotencyKey = getScheduledTaskIdempotencyKey(task);
  if (idempotencyKey) {
    const gate = await beginScheduledTaskDispatch(task);
    if (!gate.shouldDispatch) {
      return {
        success: true,
        status: 'idempotent_replay',
        targetType: task.targetType,
        targetIdentifier: task.targetIdentifier,
        output: gate.dispatch.result ?? gate.dispatch.resultPreview ?? null,
      };
    }

    try {
      const dispatch = await dispatchScheduledTaskUnchecked(task, mastra);
      await completeScheduledTaskDispatch({
        idempotencyKey,
        result: dispatch,
        resultPreview: previewDispatch(dispatch),
      });
      return dispatch;
    } catch (error) {
      await failScheduledTaskDispatch({
        idempotencyKey,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  return dispatchScheduledTaskUnchecked(task, mastra);
}

async function dispatchScheduledTaskUnchecked(
  task: ScheduledTask,
  mastra?: MastraLike,
): Promise<ScheduledDispatchResult> {
  switch (task.targetType) {
    case 'WORKER_COMMAND':
      return runWorkerCommand(task);
    case 'N8N_WEBHOOK':
      return triggerN8nWebhook(task);
    case 'MASTRA_WORKFLOW':
      return triggerMastraWorkflow(task, mastra);
    case 'AGENT':
      return runAgentTask(task, mastra);
    default:
      return {
        success: false,
        status: 'unsupported_target',
        targetType: task.targetType,
        targetIdentifier: task.targetIdentifier,
        error: `Unsupported scheduled target type: ${task.targetType}`,
      };
  }
}

let inProcessRunning = false;
let inProcessStopping = false;

export function startScheduledTaskRunnerInProcess(mastraInstance: MastraLike): void {
  if (inProcessRunning) return;
  inProcessRunning = true;
  inProcessStopping = false;
  void runScheduledTaskRunner({
    mastra: mastraInstance,
  }).catch((err) => {
    console.error('[scheduled-task-runner] in-process runner error:', (err as Error).message);
    inProcessRunning = false;
  });
}

export function stopScheduledTaskRunnerInProcess(): void {
  inProcessStopping = true;
  inProcessRunning = false;
}

export async function runScheduledTaskRunner(options: ScheduledTaskRunnerOptions = {}): Promise<void> {
  const runnerId = options.runnerId ?? process.env.SCHEDULED_TASK_RUNNER_ID ?? defaultRunnerId();
  const intervalMs = options.intervalMs ?? numberEnv('SCHEDULED_TASK_RUNNER_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  const batchSize = options.batchSize ?? numberEnv('SCHEDULED_TASK_RUNNER_BATCH', DEFAULT_BATCH_SIZE);
  const once = options.once ?? process.env.SCHEDULED_TASK_RUNNER_ONCE === '1';
  let stopping = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopping = true;
    });
  }

  console.log(`[scheduled-task-runner] started runnerId=${runnerId} intervalMs=${intervalMs} batchSize=${batchSize} once=${once}`);

  do {
    if (stopping || inProcessStopping) break;

    let processedThisTick = 0;
    for (let index = 0; index < batchSize; index += 1) {
      if (stopping || inProcessStopping) break;
      const result = await processOneDueScheduledTask({
        runnerId,
        mastra: options.mastra,
      });
      if (!result.processed) break;
      processedThisTick += 1;
      console.log(`[scheduled-task-runner] ${result.status} task=${result.taskId ?? 'unknown'} chain=${result.chainId ?? 'none'}`);
    }

    if (once) return;
    if (!stopping && !inProcessStopping) {
      await delay(processedThisTick > 0 ? 250 : intervalMs);
    }
  } while (!stopping && !inProcessStopping);

  console.log(`[scheduled-task-runner] stopped runnerId=${runnerId}`);
}

function runWorkerCommand(task: ScheduledTask): ScheduledDispatchResult {
  const command = task.targetIdentifier.trim();
  if (command === 'noop') {
    return {
      success: true,
      status: 'completed',
      targetType: task.targetType,
      targetIdentifier: task.targetIdentifier,
      output: { message: 'noop completed', payload: task.payload ?? null },
    };
  }
  if (command === 'echo_payload') {
    return {
      success: true,
      status: 'completed',
      targetType: task.targetType,
      targetIdentifier: task.targetIdentifier,
      output: task.payload ?? {},
    };
  }
  if (command === 'fail') {
    return {
      success: false,
      status: 'failed',
      targetType: task.targetType,
      targetIdentifier: task.targetIdentifier,
      error: 'WORKER_COMMAND fail requested.',
    };
  }

  return {
    success: false,
    status: 'unsupported_worker_command',
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    error: `Unsupported WORKER_COMMAND alias: ${command}. Allowed: noop, echo_payload, fail.`,
  };
}

async function triggerN8nWebhook(task: ScheduledTask): Promise<ScheduledDispatchResult> {
  const output = await new N8nService().triggerWebhook(task.targetIdentifier, buildTargetPayload(task));
  return {
    success: true,
    status: 'completed',
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    output,
  };
}

async function triggerMastraWorkflow(
  task: ScheduledTask,
  mastra?: MastraLike,
): Promise<ScheduledDispatchResult> {
  if (!mastra) throw new Error('Mastra instance is required for MASTRA_WORKFLOW scheduled tasks.');
  const workflow = mastra.getWorkflow(task.targetIdentifier);
  if (!workflow) throw new Error(`Workflow not found: ${task.targetIdentifier}`);

  const run = await workflow.createRun();
  const result = await run.start({ inputData: buildTargetPayload(task) });
  const status = (result as any)?.status ?? 'completed';
  return {
    success: status !== 'failed',
    status,
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    runId: run.runId as string | undefined,
    output: result,
  };
}

async function runAgentTask(
  task: ScheduledTask,
  mastra?: MastraLike,
): Promise<ScheduledDispatchResult> {
  if (!mastra) throw new Error('Mastra instance is required for AGENT scheduled tasks.');
  const agent = mastra.getAgent(task.targetIdentifier);
  if (!agent) throw new Error(`Agent not found in Mastra registry: ${task.targetIdentifier}`);

  const chainEntries = task.chainId
    ? await getTaskChainContext({ chainId: task.chainId, cycleId: task.cycleId, limit: 20 })
    : [];
  const chainContext = chainEntries.length > 0
    ? formatTaskChainContext(chainEntries)
    : 'No chain context.';

  const candidateArtifactIds = new Set<string>(task.inputArtifactIds ?? []);
  for (const entry of chainEntries) {
    if (entry.artifacts && Array.isArray(entry.artifacts)) {
      for (const art of entry.artifacts) {
        if (art.id) candidateArtifactIds.add(art.id);
      }
    }
  }

  const artifactSummaries: string[] = [];
  if (candidateArtifactIds.size > 0) {
    try {
      for (const artId of candidateArtifactIds) {
        const art = await getArtifact(artId, { includeContent: false });
        if (art) {
          artifactSummaries.push(`- **Artifact ID \`${art.id}\`** (${art.type}, ${art.bytes ?? 0} bytes): ${art.summary || art.title || 'No summary'} (use \`artifact_get\` to fetch full content if needed)`);
        }
      }
    } catch (err) {
      console.warn(`[scheduled-task-runner] Failed to load artifact summaries for agent task ${task.taskId}:`, err);
    }
  }

  const upstreamArtifactsBlock = artifactSummaries.length > 0
    ? `## Upstream Input Artifacts (Handoff from previous steps):\n${artifactSummaries.join('\n')}`
    : '';

  const prompt = renderAgentPrompt(task, chainContext, upstreamArtifactsBlock);
  const runId = `scheduled-${task.taskId}-${Date.now()}`;
  const threadId = `scheduled-task-${task.taskId}`;

  const harnessResult = await generateWithHarness({
    agent: agent as unknown as Agent,
    agentId: task.targetIdentifier,
    prompt,
    taskId: task.taskId,
    runId,
    threadId,
    phase: 'chat',
    headless: true,
    memoryResource: task.resourceId ?? META_AGENT_ID,
  });

  const result: any = harnessResult.response;
  const text = typeof result?.text === 'string' && result.text.trim().length > 0
    ? result.text
    : (harnessResult.deliverableText || safeStringify(result));

  return {
    success: true,
    status: result?.finishReason ?? 'completed',
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    text,
    runId,
    output: {
      text,
      finishReason: result?.finishReason,
    },
  };
}

function renderAgentPrompt(
  task: ScheduledTask,
  chainContext: string,
  upstreamArtifactsBlock?: string,
): string {
  return [
    'You are executing a durable scheduled task.',
    '',
    `taskId: ${task.taskId}`,
    task.chainId ? `chainId: ${task.chainId}` : '',
    task.cycleId ? `cycleId: ${task.cycleId}` : '',
    task.chainName ? `chainName: ${task.chainName}` : '',
    task.stepName ? `stepName: ${task.stepName}` : '',
    task.parentThreadId ? `parentThreadId: ${task.parentThreadId}` : '',
    task.resourceId ? `resourceId: ${task.resourceId}` : '',
    '',
    upstreamArtifactsBlock ? `${upstreamArtifactsBlock}\n` : '',
    'Instruction:',
    task.promptOrInstruction,
    '',
    'Payload:',
    safeStringify(task.payload ?? {}),
    '',
    'Previous chain context:',
    chainContext,
    '',
    'Return the concrete result of this scheduled step. If you created deliverables, store them with artifact_put and end with a result_envelope block listing your artifacts. If you need parent-thread context and have get_thread_context available, use it with parentThreadId before finalizing.',
  ].filter(Boolean).join('\n');
}

function buildTargetPayload(task: ScheduledTask): Record<string, unknown> {
  return {
    taskId: task.taskId,
    idempotencyKey: getScheduledTaskIdempotencyKey(task),
    chainId: task.chainId,
    chainName: task.chainName,
    stepName: task.stepName,
    parentThreadId: task.parentThreadId,
    resourceId: task.resourceId,
    instruction: task.promptOrInstruction,
    payload: task.payload ?? {},
  };
}

type SuccessorKind = 'recurrence' | 'next_step';

/**
 * Create one successor, and make its failure loud instead of fatal.
 *
 * A successor that cannot be created is the one fault this system has no other
 * way to notice: the occurrence that just ran is already completed, so nothing
 * is left to retry, mark failed, or point at. It does not look like an error —
 * it looks like a schedule that quietly has no future. So the failure is
 * contained (the sibling successor still gets its turn), written to the harness
 * log against this task, and pushed to Telegram, because by definition nobody
 * is in a conversation waiting to be told.
 */
async function createSuccessor(
  kind: SuccessorKind,
  task: ScheduledTask,
  create: () => Promise<ScheduledTask | null>,
): Promise<{ task: ScheduledTask | null; error?: string }> {
  try {
    return { task: await create() };
  } catch (error) {
    const message = (error as Error).message;
    const label = kind === 'recurrence'
      ? 'next recurrence'
      : `chain step "${task.nextStep?.stepName ?? task.nextStep?.targetIdentifier ?? 'next'}"`;

    await logHarnessEvent({
      type: 'bg_task_completed',
      agentId: META_AGENT_ID,
      taskId: task.taskId,
      threadId: task.parentThreadId,
      feature: 'scheduled_task_runner',
      status: 'error',
      errorMessage: `successor not created (${kind}): ${message}`,
      output: kind === 'recurrence'
        ? 'SCHEDULE STOPPED — no future occurrence exists'
        : 'chain broken — the following step will not run',
      data: {
        chainId: task.chainId,
        chainName: task.chainName,
        successorKind: kind,
        targetIdentifier: task.targetIdentifier,
      },
    }).catch(() => {});

    await sendTelegramAlert({
      title: kind === 'recurrence' ? 'Harmonogram zatrzymany' : 'Łańcuch zadań przerwany',
      details: [
        `Zadanie: ${task.chainName ?? task.chainId ?? task.taskId}`,
        `Krok: ${task.stepName ?? task.targetIdentifier}`,
        `Nie udało się utworzyć: ${label}`,
        `Powód: ${message}`,
        kind === 'recurrence'
          ? 'Skutek: to zadanie nie odpali się więcej, dopóki nie zostanie naprawione.'
          : 'Skutek: krok 1 wykonał się, kolejny nie wystartuje.',
      ].join('\n'),
      severity: 'critical',
      source: 'scheduled-task-runner',
    }).catch(() => {});

    return { task: null, error: `${kind}: ${message}` };
  }
}

async function scheduleNextStep(task: ScheduledTask): Promise<ScheduledTask | null> {
  const nextInput = buildNextScheduledTaskInput(task);
  if (!nextInput) return null;
  // Linked to the occurrence it follows, so a second attempt converges on the
  // row that already exists instead of forking the chain.
  return createScheduledTask({ ...nextInput, succeedsTaskId: task.taskId, succession: 'next_step' });
}

async function scheduleRecurringTask(task: ScheduledTask): Promise<ScheduledTask | null> {
  if (!task.schedule.cronExpression) return null;

  const ttlMs = task.expiresAt.getTime() - Date.now();
  const input: CreateScheduledTaskInput = {
    targetType: task.targetType,
    targetIdentifier: task.targetIdentifier,
    promptOrInstruction: task.promptOrInstruction,
    payload: task.payload,
    chainId: task.chainId,
    chainName: task.chainName,
    stepName: task.stepName,
    parentThreadId: task.parentThreadId,
    resourceId: task.resourceId,
    nextStep: task.nextStep,
    retry: {
      maxAttempts: task.retry.maxAttempts,
      backoffMs: task.retry.backoffMs,
    },
    wake: task.wake,
    cronExpression: task.schedule.cronExpression,
    timezone: task.schedule.timezone,
    ttlMs: Math.max(60_000, ttlMs),
    succeedsTaskId: task.taskId,
    succession: 'recurrence',
  };
  return createScheduledTask(input);
}

async function queueTaskWake(
  task: ScheduledTask,
  input: {
    status: 'completed' | 'failed';
    dispatch?: ScheduledDispatchResult;
    error?: string;
    nextTaskId?: string;
    recurringTaskId?: string;
  },
): Promise<string | undefined> {
  if (!task.wake) return undefined;
  const threadId = task.wake.threadId ?? task.parentThreadId;
  if (!threadId) return undefined;

  const content = [
    `Scheduled task ${task.taskId} (${task.stepName ?? task.targetIdentifier}) ${input.status}.`,
    task.chainId ? `Chain: ${task.chainId}` : '',
    input.nextTaskId ? `Next step scheduled: ${input.nextTaskId}` : '',
    input.recurringTaskId ? `Next recurrence scheduled: ${input.recurringTaskId}` : '',
    input.error ? `Error: ${input.error}` : '',
    input.dispatch ? `Result: ${previewDispatch(input.dispatch)}` : '',
  ].filter(Boolean).join('\n');

  return queuePendingMessage({
    taskId: task.taskId,
    threadId,
    targetAgentId: task.wake.targetAgentId,
    source: 'background_task',
    content,
    urgent: false,
    metadata: {
      type: 'scheduled_task_result',
      scheduledTaskId: task.taskId,
      chainId: task.chainId,
      status: input.status,
      nextTaskId: input.nextTaskId,
      recurringTaskId: input.recurringTaskId,
    },
  });
}

async function logScheduledTaskStarted(task: ScheduledTask, runnerId: string): Promise<void> {
  await logHarnessEvent({
    type: 'bg_task_started',
    agentId: META_AGENT_ID,
    taskId: task.taskId,
    threadId: task.parentThreadId,
    feature: 'scheduled_task_runner',
    status: 'pending',
    input: task.promptOrInstruction,
    data: {
      runnerId,
      chainId: task.chainId,
      targetType: task.targetType,
      targetIdentifier: task.targetIdentifier,
      stepName: task.stepName,
    },
  });
}

async function logScheduledTaskCompleted(
  task: ScheduledTask,
  input: {
    durationMs: number;
    dispatch: ScheduledDispatchResult;
    nextTaskId?: string;
    recurringTaskId?: string;
    pendingMessageId?: string;
  },
): Promise<void> {
  await logHarnessEvent({
    type: 'bg_task_completed',
    agentId: META_AGENT_ID,
    taskId: task.taskId,
    threadId: task.parentThreadId,
    feature: 'scheduled_task_runner',
    status: 'success',
    output: previewDispatch(input.dispatch),
    durationMs: input.durationMs,
    data: {
      chainId: task.chainId,
      targetType: task.targetType,
      targetIdentifier: task.targetIdentifier,
      nextTaskId: input.nextTaskId,
      recurringTaskId: input.recurringTaskId,
      pendingMessageId: input.pendingMessageId,
    },
  });
}

async function logScheduledTaskFailed(
  task: ScheduledTask,
  input: {
    durationMs: number;
    error: string;
    retryScheduled: boolean;
    pendingMessageId?: string;
  },
): Promise<void> {
  await logHarnessEvent({
    type: 'bg_task_completed',
    agentId: META_AGENT_ID,
    taskId: task.taskId,
    threadId: task.parentThreadId,
    feature: 'scheduled_task_runner',
    status: 'error',
    errorMessage: input.error,
    durationMs: input.durationMs,
    data: {
      chainId: task.chainId,
      targetType: task.targetType,
      targetIdentifier: task.targetIdentifier,
      retryScheduled: input.retryScheduled,
      pendingMessageId: input.pendingMessageId,
    },
  });
}

function previewDispatch(dispatch: ScheduledDispatchResult): string {
  return safeStringify({
    status: dispatch.status,
    targetType: dispatch.targetType,
    targetIdentifier: dispatch.targetIdentifier,
    runId: dispatch.runId,
    text: dispatch.text,
    output: dispatch.output,
  }).slice(0, 4000);
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function defaultRunnerId(): string {
  return `scheduled-task-runner:${process.pid}:${randomUUID().slice(0, 8)}`;
}

async function main(): Promise<void> {
  const { mastra } = await import('../index.js');
  await runScheduledTaskRunner({ mastra });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('[scheduled-task-runner] fatal:', error);
    process.exit(1);
  });
}
