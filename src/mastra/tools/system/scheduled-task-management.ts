import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { META_AGENT_ID } from '../../config/agent-ids.js';
import {
  cancelScheduledTask,
  getScheduledTask,
  rescheduleScheduledTask,
  SCHEDULED_TARGET_TYPES,
  type ScheduledTargetType,
} from '../../services/scheduled-task-store.js';
import {
  getScheduledTaskDashboardSummary,
  getSerializedScheduledTask,
} from '../../services/scheduled-task-dashboard.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

const statusSchema = z.enum([
  'scheduled',
  'leased',
  'running',
  'completed',
  'failed',
  'cancelled',
  'stale',
]);

const targetTypeSchema = z.enum(
  SCHEDULED_TARGET_TYPES as unknown as [ScheduledTargetType, ...ScheduledTargetType[]],
);

export const listScheduledTasksTool = createTool({
  id: 'list_scheduled_tasks',
  description:
    'Lists durable scheduled tasks with status/counts. Use to inspect pending, running, failed, completed, or chained scheduled work.',
  inputSchema: z.object({
    status: statusSchema.optional(),
    chainId: z.string().min(1).optional(),
    targetType: targetTypeSchema.optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'list_scheduled_tasks',
    category: 'memory',
    risk: 'low',
    defaultAgentId: META_AGENT_ID,
    execute: async (input) => getScheduledTaskDashboardSummary(input),
  }),
});

export const getScheduledTaskTool = createTool({
  id: 'get_scheduled_task',
  description:
    'Reads one durable scheduled task by taskId, including schedule, status, retry counters, lease, and result previews.',
  inputSchema: z.object({
    taskId: z.string().min(1),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'get_scheduled_task',
    category: 'memory',
    risk: 'low',
    defaultAgentId: META_AGENT_ID,
    execute: async (input: { taskId: string }) => {
      const task = await getSerializedScheduledTask(input.taskId);
      return task
        ? { success: true, task }
        : { success: false, error: `Scheduled task not found: ${input.taskId}` };
    },
  }),
});

export const cancelScheduledTaskTool = createTool({
  id: 'cancel_scheduled_task',
  description:
    'Cancels a scheduled task that is scheduled, leased, or running. Use only when the user asks to stop/cancel planned work or a plan becomes obsolete.',
  inputSchema: z.object({
    taskId: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    status: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'cancel_scheduled_task',
    category: 'other',
    risk: 'medium',
    defaultAgentId: META_AGENT_ID,
    execute: async (input: { taskId: string; reason?: string }) => {
      const before = await getScheduledTask(input.taskId);
      if (!before) {
        return {
          success: false,
          taskId: input.taskId,
          message: 'Scheduled task not found.',
          error: `Scheduled task not found: ${input.taskId}`,
        };
      }
      const cancelled = await cancelScheduledTask(input.taskId);
      const after = await getScheduledTask(input.taskId);
      return {
        success: cancelled,
        taskId: input.taskId,
        status: after?.status ?? before.status,
        message: cancelled
          ? `Scheduled task ${input.taskId} cancelled.`
          : `Scheduled task ${input.taskId} could not be cancelled from status ${before.status}.`,
      };
    },
  }),
});

export const rescheduleScheduledTaskTool = createTool({
  id: 'reschedule_scheduled_task',
  description:
    'Moves a scheduled task to a new fireAt time or cronExpression. Does not reschedule already completed or currently running tasks.',
  inputSchema: z.object({
    taskId: z.string().min(1),
    fireAt: z.string().min(1).optional(),
    cronExpression: z.string().min(1).optional(),
    timezone: z.string().min(1).optional().default('Atlantic/Reykjavik'),
    resetRetry: z.boolean().optional().default(true),
  }).superRefine((value, ctx) => {
    if (!value.fireAt && !value.cronExpression) {
      ctx.addIssue({
        code: 'custom',
        path: ['fireAt'],
        message: 'Either fireAt or cronExpression is required.',
      });
    }
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'reschedule_scheduled_task',
    category: 'other',
    risk: 'medium',
    defaultAgentId: META_AGENT_ID,
    execute: async (input: {
      taskId: string;
      fireAt?: string;
      cronExpression?: string;
      timezone?: string;
      resetRetry?: boolean;
    }) => {
      try {
        const task = await rescheduleScheduledTask(input);
        return task
          ? { success: true, task: await getSerializedScheduledTask(task.taskId) }
          : {
            success: false,
            error: `Scheduled task ${input.taskId} could not be rescheduled. It may be running, completed, or missing.`,
          };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  }),
});
