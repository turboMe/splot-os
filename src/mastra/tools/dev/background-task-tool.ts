/**
 * bg_task — Agent-facing tool for durable background tasks.
 *
 * Long tests, builds and external jobs can be started in the background and
 * polled asynchronously, so the agent loop is not blocked by wall-clock time.
 *
 * Actions: start, status, wait, tail, output, cancel, cleanup, list
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  startBackgroundTask,
  getBackgroundTask,
  waitBackgroundTask,
  tailBackgroundTask,
  getBackgroundTaskOutput,
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  listBackgroundTasks,
  requiresBackgroundApproval,
} from '../../services/background-task-manager.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { compactHarnessOutput } from '../../services/harness-output-compactor.js';
import { registerRunStartedPort, extractPortFromCommand } from '../../config/browser-surfaces.js';

const BG_ACTIONS = [
  'start', 'status', 'wait', 'tail', 'output', 'cancel', 'cleanup', 'list',
] as const;

export const bgTaskTool = createTool({
  id: 'bg_task',
  description: [
    'Manage durable background tasks that survive tool-call timeouts.',
    'Actions:',
    '  start  — Start a command in the background. Returns taskId immediately.',
    '  status — Check if a background task is still running or completed.',
    '  wait   — Block until a background task completes (max 10 min).',
    '  tail   — Get the last N lines of task output.',
    '  output — Get the full output of a completed task.',
    '  cancel — Kill a running background task.',
    '  cleanup— Remove old completed/failed tasks.',
    '  list   — List background tasks (optionally by ownerTaskId or status).',
    '',
    'Use `background: true` on coding_run_test for test/build commands instead.',
    'Use bg_task for non-standard long commands like scrapers, NotebookLM, etc.',
  ].join('\n'),

  inputSchema: z.object({
    action: z.enum(BG_ACTIONS).describe('Action to perform'),
    // start
    command: z.string().optional().describe('Command to run (for start)'),
    cwd: z.string().optional().describe('Working directory (for start, defaults to repo root)'),
    devServerPort: z.number().int().positive().optional().describe(
      'If this command starts a dev server, its port. Registers the port as owned by THIS run for browser-tool policy scoping (see browser-surfaces.ts) — a browser interaction with a port never declared here is treated as external, even on localhost. When omitted, a best-effort port is parsed from `command`.',
    ),
    ownerTaskId: z.string().optional().describe('Parent coding task ID (for start)'),
    wake: z.boolean().optional().default(true).describe('Notify agent on completion via pending message (for start)'),
    notify: z.boolean().optional().default(false).describe('Also push notification (for start)'),
    // status / wait / tail / output / cancel
    taskId: z.string().optional().describe('Background task ID (for status/wait/tail/output/cancel)'),
    // tail
    lines: z.number().optional().default(50).describe('Number of lines to tail (for tail)'),
    // wait
    timeoutMs: z.number().optional().describe('Max wait time in ms (for wait, max 600000)'),
    // cleanup
    maxAgeMs: z.number().optional().describe('Max age in ms for cleanup (default 7 days)'),
    // list
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']).optional(),
    limit: z.number().optional().default(10),
    // harness metadata
    agentId: z.string().optional().describe('Owner/target agent for completion notifications. Defaults to current harness agent.'),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
    subtaskId: z.string().optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    taskId: z.string().optional(),
    status: z.string().optional(),
    exitCode: z.number().optional(),
    pid: z.number().optional(),
    output: z.string().optional(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    durationMs: z.number().optional(),
    tasks: z.array(z.object({
      taskId: z.string(),
      command: z.string(),
      status: z.string(),
      exitCode: z.number().optional(),
      startedAt: z.string(),
      completedAt: z.string().optional(),
    })).optional(),
    removed: z.number().optional(),
    error: z.string().optional(),
    message: z.string(),
    requiresApproval: z.boolean().optional(),
  }),

  execute: withToolEnvelope({
    toolId: 'bg_task',
    category: 'shell',
    risk: 'medium',
    policy: (context, metadata) => {
      if (context.action !== 'start' || !context.command) return undefined;
      return {
        action: 'run_command',
        command: context.command,
        taskId: context.ownerTaskId ?? metadata.taskId,
        agentId: metadata.agentId,
        threadId: context.threadId ?? metadata.threadId,
        runId: metadata.runId,
        turnId: metadata.turnId,
      };
    },
    execute: async (context, metadata) => {
      try {
        const ownerAgentId = context.agentId ?? metadata?.agentId ?? 'codingAgent';
        const ownerThreadId = context.threadId ?? metadata?.threadId;
        const ownerTaskId = context.ownerTaskId ?? metadata?.taskId;

        switch (context.action) {
          case 'start': {
            if (!context.command) {
              return {
                success: false,
                action: 'start',
                message: 'Missing required field: command',
              };
            }

            // Check approval requirement
            if (requiresBackgroundApproval(context.command)) {
              return {
                success: false,
                action: 'start',
                message: `Command requires approval: ${context.command}`,
                requiresApproval: true,
              };
            }

            const record = await startBackgroundTask({
              command: context.command,
              cwd: context.cwd || process.cwd(),
              ownerTaskId,
              threadId: ownerThreadId,
              agentId: ownerAgentId,
              notify: context.notify ?? false,
              wake: context.wake ?? true,
            });

            // Own this port for browser-tool policy scoping (browser-surfaces.ts):
            // a browser interaction against it is `own_workspace`, not `external`,
            // for the remainder of THIS run only. Explicit `devServerPort` wins
            // over the best-effort parse so a command like `npm run dev` (which
            // reads its port from a config file, not an argument) can still be
            // declared.
            const declaredPort = context.devServerPort ?? extractPortFromCommand(context.command);
            if (declaredPort) {
              registerRunStartedPort(metadata?.runId, declaredPort);
            }

            return {
              success: true,
              action: 'start',
              taskId: record.taskId,
              status: record.status,
              pid: record.pid,
              message: declaredPort
                ? `Background task started: ${record.taskId}. Port ${declaredPort} is now this run's own workspace for browser tools. Use bg_task(action='status', taskId='${record.taskId}') to check progress.`
                : `Background task started: ${record.taskId}. Use bg_task(action='status', taskId='${record.taskId}') to check progress.`,
            };
          }

          case 'status': {
            if (!context.taskId) {
              return { success: false, action: 'status', message: 'Missing required field: taskId' };
            }

            const record = await getBackgroundTask(context.taskId);
            if (!record) {
              return { success: false, action: 'status', taskId: context.taskId, message: 'Task not found' };
            }

            return {
              success: true,
              action: 'status',
              taskId: record.taskId,
              status: record.status,
              exitCode: record.exitCode,
              pid: record.pid,
              message: `Task ${record.taskId}: ${record.status}${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ''}`,
            };
          }

          case 'wait': {
            if (!context.taskId) {
              return { success: false, action: 'wait', message: 'Missing required field: taskId' };
            }

            const result = await waitBackgroundTask(context.taskId, {
              timeoutMs: context.timeoutMs,
            });

            return {
              success: result.status !== 'running' && result.status !== 'unknown',
              action: 'wait',
              taskId: result.taskId,
              status: result.status,
              exitCode: result.exitCode,
              output: result.outputTail,
              durationMs: result.durationMs,
              error: result.error,
              message: result.status === 'running'
                ? `Wait timed out after ${result.durationMs}ms. Task is still running.`
                : `Task ${result.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ''} in ${result.durationMs}ms`,
            };
          }

          case 'tail': {
            if (!context.taskId) {
              return { success: false, action: 'tail', message: 'Missing required field: taskId' };
            }

            const tailOutput = await tailBackgroundTask(context.taskId, context.lines ?? 50);
            return {
              success: true,
              action: 'tail',
              taskId: context.taskId,
              output: tailOutput || '(no output yet)',
              message: `Last ${context.lines ?? 50} lines of task ${context.taskId}`,
            };
          }

          case 'output': {
            if (!context.taskId) {
              return { success: false, action: 'output', message: 'Missing required field: taskId' };
            }

            const fullOutput = await getBackgroundTaskOutput(context.taskId);
            if (!fullOutput) {
              return {
                success: true,
                action: 'output',
                taskId: context.taskId,
                output: '(no output)',
                message: `No output for task ${context.taskId}`,
              };
            }

            const compaction = await compactHarnessOutput({
              text: fullOutput,
              kind: 'command_log',
              taskId: ownerTaskId,
              subtaskId: context.subtaskId,
              agentId: ownerAgentId,
              threadId: ownerThreadId,
              runId: context.runId ?? metadata?.runId,
              turnId: context.turnId ?? metadata?.turnId,
              toolId: 'bg_task',
              metadata: { bgTaskId: context.taskId, action: 'output' },
            });

            return {
              success: true,
              action: 'output',
              taskId: context.taskId,
              output: compaction.preview,
              outputArtifactId: compaction.fullTextArtifactId,
              outputTruncated: compaction.truncated,
              message: `Full output of task ${context.taskId}${compaction.truncated ? ' (truncated)' : ''}`,
            };
          }

          case 'cancel': {
            if (!context.taskId) {
              return { success: false, action: 'cancel', message: 'Missing required field: taskId' };
            }

            const cancelled = await cancelBackgroundTask(context.taskId);
            return {
              success: cancelled,
              action: 'cancel',
              taskId: context.taskId,
              status: cancelled ? 'cancelled' : 'not_running',
              message: cancelled
                ? `Task ${context.taskId} cancelled.`
                : `Task ${context.taskId} was not running or not found.`,
            };
          }

          case 'cleanup': {
            const result = await cleanupBackgroundTasks({
              maxAgeMs: context.maxAgeMs,
            });
            return {
              success: true,
              action: 'cleanup',
              removed: result.removed,
              message: `Cleaned up ${result.removed} old background tasks.`,
            };
          }

          case 'list': {
            const tasks = await listBackgroundTasks({
              ownerTaskId: context.ownerTaskId,
              status: context.status,
              limit: context.limit ?? 10,
            });

            return {
              success: true,
              action: 'list',
              tasks: tasks.map((t) => ({
                taskId: t.taskId,
                command: t.command,
                status: t.status,
                exitCode: t.exitCode,
                startedAt: t.startedAt instanceof Date ? t.startedAt.toISOString() : String(t.startedAt),
                completedAt: t.completedAt instanceof Date ? t.completedAt.toISOString() : t.completedAt ? String(t.completedAt) : undefined,
              })),
              message: `Found ${tasks.length} background task(s).`,
            };
          }

          default:
            return {
              success: false,
              action: String(context.action),
              message: `Unknown action: ${context.action}. Valid: ${BG_ACTIONS.join(', ')}`,
            };
        }
      } catch (error) {
        return {
          success: false,
          action: context.action,
          message: `bg_task error: ${(error as Error).message}`,
          error: (error as Error).message,
        };
      }
    },
  }),
});
