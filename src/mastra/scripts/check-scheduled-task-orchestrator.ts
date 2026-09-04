import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDb, getDb } from '../lib/mongo.js';
import {
  buildScheduledTask,
  completeScheduledTaskDispatch,
  getScheduledTask,
  SCHEDULED_TASK_DISPATCHES_COLLECTION,
  SCHEDULED_TASKS_COLLECTION,
} from '../services/scheduled-task-store.js';
import { TASK_CHAINS_COLLECTION } from '../services/task-chain-store.js';
import { getThreadContextTool } from '../tools/system/get-thread-context.js';
import { scheduleTaskTool } from '../tools/system/schedule-task.js';
import {
  cancelScheduledTaskTool,
  listScheduledTasksTool,
  rescheduleScheduledTaskTool,
} from '../tools/system/scheduled-task-management.js';
import { getChainContextTool } from '../tools/system/task-chain-tools.js';
import { dispatchScheduledTask, processOneDueScheduledTask } from './scheduled-task-runner.js';

const suffix = randomUUID().slice(0, 8);
const chainId = `check-scheduled-chain-${suffix}`;
const runnerId = `check-scheduled-runner-${suffix}`;
const threadId = `check-thread-${suffix}`;
const resourceId = `check-resource-${suffix}`;
let scheduledTaskId: string | undefined;
const cleanupTaskIds = new Set<string>();
const cleanupChainIds = new Set<string>([chainId]);
const cleanupIdempotencyKeys = new Set<string>();

try {
  const db = await getDb();
  await ensureScheduledTaskIndexes(db);

  await db.collection('mastra_threads').insertOne({
    id: threadId,
    resourceId,
    title: 'Scheduled task smoke test',
    metadata: { check: 'scheduled-task-orchestrator', suffix },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.collection('mastra_messages').insertOne({
    id: `check-message-${suffix}`,
    thread_id: threadId,
    resourceId,
    role: 'user',
    content: JSON.stringify({ text: `Remember smoke marker ${suffix}.` }),
    createdAt: new Date(),
  });

  const scheduleResult = await (scheduleTaskTool as any).execute({
    fireAt: new Date(Date.now() - 1000).toISOString(),
    targetType: 'WORKER_COMMAND',
    targetIdentifier: 'echo_payload',
    promptOrInstruction: 'Smoke test scheduled task. Success means the runner echoes the payload and records a chain result.',
    payload: { marker: suffix, ok: true },
    chainId,
    chainName: 'check-scheduled-task-orchestrator',
    stepName: 'echo-payload',
    parentThreadId: threadId,
    resourceId,
    retry: { maxAttempts: 1, backoffMs: 1000 },
    wake: false,
  });

  assert.equal(scheduleResult.success, true, `schedule_task failed: ${scheduleResult.error ?? 'unknown'}`);
  scheduledTaskId = scheduleResult.taskId;
  assert.ok(scheduledTaskId, 'schedule_task did not return taskId');
  cleanupTaskIds.add(scheduledTaskId);

  const runResult = await processOneDueScheduledTask({ runnerId, leaseMs: 60_000 });
  assert.equal(runResult.processed, true, 'runner did not process a due task');
  assert.equal(runResult.status, 'completed', `runner did not complete task: ${runResult.error ?? 'unknown'}`);
  assert.equal(runResult.taskId, scheduledTaskId, 'runner processed a different task');

  const storedTask = await getScheduledTask(scheduledTaskId);
  assert.equal(storedTask?.status, 'completed', 'scheduled task was not marked completed');
  assert.equal(storedTask?.chainId, chainId, 'scheduled task chainId changed');

  const chainContext = await (getChainContextTool as any).execute({ chainId, limit: 5 });
  assert.equal(chainContext.success, true, `get_chain_context failed: ${chainContext.error ?? 'unknown'}`);
  assert.equal(chainContext.count, 1, 'chain context did not contain one completed step');
  assert.match(chainContext.context, new RegExp(suffix), 'chain context does not include echoed marker');

  const threadContext = await (getThreadContextTool as any).execute({
    parentThreadId: threadId,
    resourceId,
    query: suffix,
    lastMessages: 5,
  });
  assert.equal(threadContext.success, true, `get_thread_context failed: ${threadContext.error ?? 'unknown'}`);
  assert.equal(threadContext.threadFound, true, 'test thread was not found');
  assert.equal(threadContext.semanticSearchUsed, false, 'thread context should use deterministic fallback');
  assert.match(threadContext.context, new RegExp(suffix), 'thread context does not include test marker');

  const managementChainId = `check-management-chain-${suffix}`;
  cleanupChainIds.add(managementChainId);
  const managementTask = await (scheduleTaskTool as any).execute({
    fireAt: new Date(Date.now() + 3600_000).toISOString(),
    targetType: 'WORKER_COMMAND',
    targetIdentifier: 'noop',
    promptOrInstruction: 'Management tools smoke task.',
    chainId: managementChainId,
    stepName: 'manage-me',
    retry: { maxAttempts: 1, backoffMs: 1000 },
    wake: false,
  });
  assert.equal(managementTask.success, true, `management schedule failed: ${managementTask.error ?? 'unknown'}`);
  cleanupTaskIds.add(managementTask.taskId);
  const listed = await (listScheduledTasksTool as any).execute({ chainId: managementChainId, limit: 5 });
  assert.equal(listed.count, 1, 'list_scheduled_tasks did not return management task');
  const rescheduled = await (rescheduleScheduledTaskTool as any).execute({
    taskId: managementTask.taskId,
    fireAt: new Date(Date.now() + 7200_000).toISOString(),
  });
  assert.equal(rescheduled.success, true, `reschedule_scheduled_task failed: ${rescheduled.error ?? 'unknown'}`);
  const cancelled = await (cancelScheduledTaskTool as any).execute({ taskId: managementTask.taskId });
  assert.equal(cancelled.success, true, `cancel_scheduled_task failed: ${cancelled.error ?? 'unknown'}`);

  const retryChainId = `check-retry-chain-${suffix}`;
  cleanupChainIds.add(retryChainId);
  const retryTask = await (scheduleTaskTool as any).execute({
    fireAt: new Date(Date.now() - 1000).toISOString(),
    targetType: 'WORKER_COMMAND',
    targetIdentifier: 'fail',
    promptOrInstruction: 'Smoke test retry. This task intentionally fails once and should be rescheduled by retry policy.',
    chainId: retryChainId,
    stepName: 'intentional-fail',
    retry: { maxAttempts: 2, backoffMs: 1000 },
    wake: false,
  });
  assert.equal(retryTask.success, true, `retry schedule failed: ${retryTask.error ?? 'unknown'}`);
  cleanupTaskIds.add(retryTask.taskId);
  const retryResult = await processOneDueScheduledTask({ runnerId, leaseMs: 60_000 });
  assert.equal(retryResult.taskId, retryTask.taskId, 'runner did not process retry test task');
  assert.equal(retryResult.status, 'retry_scheduled', 'failed task was not rescheduled for retry');
  const retryStored = await getScheduledTask(retryTask.taskId);
  assert.equal(retryStored?.status, 'scheduled', 'retry task was not returned to scheduled state');
  assert.equal(retryStored?.retry.attempt, 1, 'retry attempt counter was not incremented');

  const nextChainId = `check-next-chain-${suffix}`;
  cleanupChainIds.add(nextChainId);
  const nextTask = await (scheduleTaskTool as any).execute({
    fireAt: new Date(Date.now() - 1000).toISOString(),
    targetType: 'WORKER_COMMAND',
    targetIdentifier: 'echo_payload',
    promptOrInstruction: 'First nextStep test task.',
    payload: { step: 1, marker: suffix },
    chainId: nextChainId,
    stepName: 'first',
    retry: { maxAttempts: 1, backoffMs: 1000 },
    wake: false,
    nextStep: {
      fireAt: new Date(Date.now() - 1000).toISOString(),
      targetType: 'WORKER_COMMAND',
      targetIdentifier: 'echo_payload',
      promptOrInstruction: 'Second nextStep test task.',
      payload: { step: 2, marker: suffix },
      stepName: 'second',
      retry: { maxAttempts: 1, backoffMs: 1000 },
      wake: false,
    },
  });
  assert.equal(nextTask.success, true, `nextStep schedule failed: ${nextTask.error ?? 'unknown'}`);
  cleanupTaskIds.add(nextTask.taskId);
  const firstNextResult = await processOneDueScheduledTask({ runnerId, leaseMs: 60_000 });
  assert.equal(firstNextResult.taskId, nextTask.taskId, 'runner did not process first nextStep task');
  assert.equal(firstNextResult.status, 'completed', 'first nextStep task did not complete');
  assert.ok(firstNextResult.nextTaskId, 'first nextStep task did not create a next task');
  cleanupTaskIds.add(firstNextResult.nextTaskId!);
  const secondNextResult = await processOneDueScheduledTask({ runnerId, leaseMs: 60_000 });
  assert.equal(secondNextResult.taskId, firstNextResult.nextTaskId, 'runner did not process generated nextStep task');
  assert.equal(secondNextResult.status, 'completed', 'generated nextStep task did not complete');

  const fakeAgentTask = buildScheduledTask({
    taskId: `check-agent-task-${suffix}`,
    fireAt: new Date(Date.now() - 1000),
    targetType: 'AGENT',
    targetIdentifier: 'fakeAgent',
    promptOrInstruction: 'Fake agent dispatch smoke.',
    chainId: `check-agent-chain-${suffix}`,
    idempotencyKey: `check-agent-idempotency-${suffix}`,
  });
  cleanupIdempotencyKeys.add(fakeAgentTask.idempotencyKey!);
  let fakeAgentCalls = 0;
  const fakeMastra = {
    getAgent: (id: string) => {
      assert.equal(id, 'fakeAgent');
      return {
        generate: async () => {
          fakeAgentCalls += 1;
          return { text: `fake agent ok ${suffix}`, finishReason: 'stop' };
        },
      };
    },
    getWorkflow: (id: string) => {
      assert.equal(id, 'fakeWorkflow');
      return {
        createRun: async () => ({
          runId: `fake-run-${suffix}`,
          start: async ({ inputData }: any) => ({ status: 'success', inputData }),
        }),
      };
    },
  };
  const firstAgentDispatch = await dispatchScheduledTask(fakeAgentTask, fakeMastra);
  assert.equal(firstAgentDispatch.success, true, 'fake AGENT dispatch failed');
  const replayAgentDispatch = await dispatchScheduledTask(fakeAgentTask, fakeMastra);
  assert.equal(replayAgentDispatch.status, 'idempotent_replay', 'second AGENT dispatch did not use idempotency replay');
  assert.equal(fakeAgentCalls, 1, 'idempotency replay called fake agent twice');

  const fakeWorkflowTask = buildScheduledTask({
    taskId: `check-workflow-task-${suffix}`,
    fireAt: new Date(Date.now() - 1000),
    targetType: 'MASTRA_WORKFLOW',
    targetIdentifier: 'fakeWorkflow',
    promptOrInstruction: 'Fake workflow dispatch smoke.',
    chainId: `check-workflow-chain-${suffix}`,
    idempotencyKey: `check-workflow-idempotency-${suffix}`,
  });
  cleanupIdempotencyKeys.add(fakeWorkflowTask.idempotencyKey!);
  const workflowDispatch = await dispatchScheduledTask(fakeWorkflowTask, fakeMastra);
  assert.equal(workflowDispatch.success, true, 'fake MASTRA_WORKFLOW dispatch failed');
  assert.equal(workflowDispatch.runId, `fake-run-${suffix}`, 'fake workflow runId was not returned');

  const completedDispatchKey = `check-completed-dispatch-${suffix}`;
  cleanupIdempotencyKeys.add(completedDispatchKey);
  const completedTask = buildScheduledTask({
    taskId: `check-completed-dispatch-task-${suffix}`,
    fireAt: new Date(Date.now() - 1000),
    targetType: 'AGENT',
    targetIdentifier: 'fakeAgent',
    promptOrInstruction: 'Completed dispatch replay smoke.',
    idempotencyKey: completedDispatchKey,
  });
  await dispatchScheduledTask(completedTask, fakeMastra);
  await completeScheduledTaskDispatch({
    idempotencyKey: completedDispatchKey,
    result: { ok: true, marker: suffix },
    resultPreview: `completed ${suffix}`,
  });
  const completedReplay = await dispatchScheduledTask(completedTask, fakeMastra);
  assert.equal(completedReplay.status, 'idempotent_replay', 'completed dispatch was not replayed');

  const n8nWebhookPath = process.env.CHECK_SCHEDULED_TASK_N8N_WEBHOOK_PATH;
  if (n8nWebhookPath) {
    const n8nChainId = `check-n8n-chain-${suffix}`;
    cleanupChainIds.add(n8nChainId);
    const n8nTask = await (scheduleTaskTool as any).execute({
      fireAt: new Date(Date.now() - 1000).toISOString(),
      targetType: 'N8N_WEBHOOK',
      targetIdentifier: n8nWebhookPath,
      promptOrInstruction: 'Optional live N8N webhook scheduled-task smoke.',
      payload: { marker: suffix },
      chainId: n8nChainId,
      idempotencyKey: `check-n8n-idempotency-${suffix}`,
      retry: { maxAttempts: 1, backoffMs: 1000 },
      wake: false,
    });
    assert.equal(n8nTask.success, true, `n8n schedule failed: ${n8nTask.error ?? 'unknown'}`);
    cleanupTaskIds.add(n8nTask.taskId);
    cleanupIdempotencyKeys.add(`check-n8n-idempotency-${suffix}`);
    const n8nResult = await processOneDueScheduledTask({ runnerId, leaseMs: 60_000 });
    assert.equal(n8nResult.taskId, n8nTask.taskId, 'runner did not process optional n8n task');
    assert.equal(n8nResult.status, 'completed', `optional n8n task failed: ${n8nResult.error ?? 'unknown'}`);
  } else {
    console.log('Optional N8N webhook smoke skipped; set CHECK_SCHEDULED_TASK_N8N_WEBHOOK_PATH to enable.');
  }

  console.log('Scheduled task orchestrator checks passed.');
} finally {
  const db = await getDb().catch(() => null);
  if (db) {
    const eventCleanupClauses: Record<string, unknown>[] = [...cleanupChainIds].map((id) => ({ 'data.chainId': id }));
    if (scheduledTaskId) eventCleanupClauses.push({ taskId: scheduledTaskId });
    const cleanupPromises: Promise<unknown>[] = [
      db.collection(SCHEDULED_TASKS_COLLECTION).deleteMany({
        $or: [
          { taskId: { $in: [...cleanupTaskIds] } },
          { chainId: { $in: [...cleanupChainIds] } },
        ],
      }),
      db.collection(TASK_CHAINS_COLLECTION).deleteMany({ chainId: { $in: [...cleanupChainIds] } }),
      db.collection(SCHEDULED_TASK_DISPATCHES_COLLECTION).deleteMany({
        idempotencyKey: { $in: [...cleanupIdempotencyKeys] },
      }),
      db.collection('mastra_threads').deleteMany({ id: threadId }),
      db.collection('mastra_messages').deleteMany({ thread_id: threadId }),
      db.collection('agent_events').deleteMany({ $or: eventCleanupClauses }),
    ];
    if (scheduledTaskId) {
      cleanupPromises.push(db.collection('tool_executions').deleteMany({ runId: scheduledTaskId }));
    }
    await Promise.all(cleanupPromises);
  }
  await closeDb();
}

async function ensureScheduledTaskIndexes(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  await Promise.all([
    db.collection(SCHEDULED_TASKS_COLLECTION).createIndex({ taskId: 1 }, { unique: true }),
    db.collection(SCHEDULED_TASKS_COLLECTION).createIndex({ status: 1, 'schedule.fireAt': 1 }),
    db.collection(SCHEDULED_TASKS_COLLECTION).createIndex({ chainId: 1, createdAt: 1 }),
    db.collection(SCHEDULED_TASKS_COLLECTION).createIndex({ 'lease.expiresAt': 1 }),
    db.collection(SCHEDULED_TASKS_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection(TASK_CHAINS_COLLECTION).createIndex({ chainId: 1, completedAt: 1 }),
    db.collection(TASK_CHAINS_COLLECTION).createIndex({ taskId: 1 }, { unique: true, sparse: true }),
    db.collection(TASK_CHAINS_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection(SCHEDULED_TASK_DISPATCHES_COLLECTION).createIndex({ idempotencyKey: 1 }, { unique: true }),
    db.collection(SCHEDULED_TASK_DISPATCHES_COLLECTION).createIndex({ taskId: 1, status: 1 }),
    db.collection(SCHEDULED_TASK_DISPATCHES_COLLECTION).createIndex({ status: 1, startedAt: -1 }),
    db.collection(SCHEDULED_TASK_DISPATCHES_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}
