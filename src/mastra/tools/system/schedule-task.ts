import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { META_AGENT_ID } from '../../config/agent-ids.js';
import {
  createScheduledTask,
  SCHEDULED_TARGET_TYPES,
  type ScheduledTargetType,
  type ScheduledTaskNextStepInput,
} from '../../services/scheduled-task-store.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';

const scheduledTargetTypeSchema = z.enum(
  SCHEDULED_TARGET_TYPES as unknown as [ScheduledTargetType, ...ScheduledTargetType[]],
);

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffMs: z.number().int().min(1000).max(24 * 3600 * 1000).optional(),
});

const wakeSchema = z.union([
  z.boolean(),
  z.object({
    targetAgentId: z.string().min(1),
    threadId: z.string().min(1).optional(),
  }),
]);

// Annotated with the store's own type: z.lazy needs an explicit annotation to
// break the recursion, and z.ZodTypeAny would infer `unknown`, which then fails
// to satisfy CreateScheduledTaskInput.nextStep at the call site.
const scheduledStepSchema: z.ZodType<ScheduledTaskNextStepInput> = z.lazy(() => z.object({
  fireAt: z.string().min(1).optional(),
  cronExpression: z.string().min(1).optional(),
  delayMs: z.number().int().min(0).max(24 * 3600 * 1000).optional()
    .describe(
      'How long after the previous step finishes this one runs, in ms. The normal way to '
      + 'schedule a chain step — omit fireAt and cronExpression and just say how long to wait '
      + '(e.g. 1800000 for 30 minutes). Defaults to 0, meaning right after the previous step. '
      + 'Do NOT give a chain step its own cronExpression: it would then recur on its own and '
      + 'the chain would fire it twice a day.',
    ),
  // No .default() — buildScheduledTask already falls back to 'Atlantic/Reykjavik', and a zod
  // default here would make the parsed type diverge from what Mastra passes in.
  timezone: z.string().min(1).optional(),
  targetType: scheduledTargetTypeSchema,
  targetIdentifier: z.string().min(1),
  promptOrInstruction: z.string().min(1).max(20_000),
  payload: z.record(z.string(), z.unknown()).optional(),
  chainId: z.string().min(1).optional(),
  chainName: z.string().min(1).optional(),
  stepName: z.string().min(1).optional(),
  cycleId: z.string().min(1).optional(),
  inputArtifactIds: z.array(z.string().min(1)).optional().describe('IDs of artifacts to provide as upstream handoff context to this step.'),
  parentThreadId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  nextStep: scheduledStepSchema.optional(),
  retry: retrySchema.optional(),
  wake: wakeSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  ttlMs: z.number().int().min(60_000).max(90 * 24 * 3600 * 1000).optional(),
}).superRefine((value, ctx) => {
  // A chain step needs no time of its own — `delayMs` (or nothing, meaning
  // immediately) is measured from the moment its predecessor completes, which
  // is the only sensible anchor for something that runs "and then". What IS
  // worth refusing is a per-step cronExpression: the step would acquire its own
  // recurrence on top of being created by the chain, and fire twice.
  if (value.cronExpression) {
    ctx.addIssue({
      code: 'custom',
      path: ['cronExpression'],
      message:
        'A chain step must not carry its own cronExpression — it would recur independently and '
        + 'run twice per cycle. Use delayMs (ms after the previous step) instead.',
    });
  }
}));

const scheduleTaskInputSchema = z.object({
  scheduledTaskId: z.string().min(1).optional(),
  fireAt: z.string().min(1).optional(),
  cronExpression: z.string().min(1).optional(),
  // See the note on scheduledStepSchema — the store owns the 'Atlantic/Reykjavik' fallback.
  timezone: z.string().min(1).optional(),
  targetType: scheduledTargetTypeSchema,
  targetIdentifier: z.string().min(1),
  promptOrInstruction: z.string().min(1).max(20_000),
  payload: z.record(z.string(), z.unknown()).optional(),
  chainId: z.string().min(1).optional(),
  chainName: z.string().min(1).optional(),
  stepName: z.string().min(1).optional(),
  cycleId: z.string().min(1).optional(),
  inputArtifactIds: z.array(z.string().min(1)).optional().describe('IDs of artifacts to provide as upstream handoff context to this task.'),
  parentThreadId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  nextStep: scheduledStepSchema.optional(),
  retry: retrySchema.optional(),
  wake: wakeSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  ttlMs: z.number().int().min(60_000).max(90 * 24 * 3600 * 1000).optional(),
}).superRefine((value, ctx) => {
  if (!value.fireAt && !value.cronExpression) {
    ctx.addIssue({
      code: 'custom',
      path: ['fireAt'],
      message: 'Either fireAt or cronExpression is required.',
    });
  }
  // A wake is delivered into a thread's mailbox. Asked for without one, it was
  // silently dropped at completion time — the caller believed they had asked to
  // be told and heard nothing, which is indistinguishable from the task never
  // running. Refuse it here, where the mistake is still fixable.
  const wantsWake = value.wake === true || (typeof value.wake === 'object' && value.wake !== null);
  const wakeThreadId = typeof value.wake === 'object' && value.wake !== null
    ? value.wake.threadId
    : undefined;
  if (wantsWake && !wakeThreadId && !value.parentThreadId) {
    ctx.addIssue({
      code: 'custom',
      path: ['wake'],
      message:
        'wake needs somewhere to deliver: pass parentThreadId (the thread to report back into) '
        + 'or wake.threadId. Without either, the notification would be discarded silently. '
        + 'Omit wake entirely if the task should run unattended.',
    });
  }
});

// Mastra derives the tool's runtime input type from the schema's JSON-schema
// shape, where the recursive nextStep collapses to `unknown`. Mirror that here
// so the execute signature matches, then re-validate the field below.
type ScheduleTaskToolInput = Omit<z.infer<typeof scheduleTaskInputSchema>, 'nextStep'> & {
  nextStep?: unknown;
};

export const scheduleTaskTool = createTool({
  id: 'schedule_task',
  description:
    'Schedules a durable future or recurring task in MongoDB. Use for delayed, multi-step, or overnight work. ' +
    'Targets can be AGENT, MASTRA_WORKFLOW, N8N_WEBHOOK, or safe internal WORKER_COMMAND. ' +
    'For side-effecting targets, obtain any required user approval before scheduling.',
  inputSchema: scheduleTaskInputSchema,
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string().optional(),
    chainId: z.string().optional(),
    status: z.string().optional(),
    fireAt: z.string().optional(),
    targetType: z.string().optional(),
    targetIdentifier: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'schedule_task',
    category: 'other',
    risk: 'medium',
    defaultAgentId: META_AGENT_ID,
    redactInputFields: ['promptOrInstruction', 'payload', 'nextStep'],
    execute: async (input: ScheduleTaskToolInput) => {
      try {
        const { scheduledTaskId, nextStep, ...taskInput } = input;
        const task = await createScheduledTask({
          ...taskInput,
          // Parsed rather than cast: this is the only place the recursive
          // chain payload is checked before it reaches the store.
          nextStep: nextStep === undefined ? undefined : scheduledStepSchema.parse(nextStep),
          taskId: scheduledTaskId,
        });

        return {
          success: true,
          taskId: task.taskId,
          chainId: task.chainId,
          status: task.status,
          fireAt: task.schedule.fireAt?.toISOString(),
          targetType: task.targetType,
          targetIdentifier: task.targetIdentifier,
          message: `Scheduled task ${task.taskId} for ${task.schedule.fireAt?.toISOString() ?? task.schedule.cronExpression}.`,
        };
      } catch (error) {
        return {
          success: false,
          message: 'Failed to schedule task.',
          error: (error as Error).message,
        };
      }
    },
  }),
});
