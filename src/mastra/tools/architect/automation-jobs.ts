import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import {
  cancelAutomationJob,
  getAutomationJob,
  listAutomationJobs,
  markStaleAutomationJobs,
  startAutomationJob,
} from '../../services/automation-job-manager.js';
import { AUTOMATION_ARCHITECT_AGENT_ID } from '../../config/agent-ids.js';

const goldenPathInputSchema = z.object({
  mode: z.enum(['pattern', 'workflow_file', 'workflow_json']),
  request: z.string().optional(),
  patternId: z.string().optional(),
  spec: z.any().optional(),
  workflow: z.any().optional(),
  workflowFilePath: z.string().optional(),
  workflowName: z.string().optional(),
  workflowId: z.string().optional(),
  automationId: z.string().optional(),
  approvalToken: z.string().optional().describe('Legacy compatibility field; ignored for Automation Architect runtime authority.'),
  activate: z.boolean().optional().default(false),
  allowDraftWithMissingCredentials: z.boolean().optional().default(true),
  requiresPublicWebhook: z.boolean().optional().default(false),
}).superRefine((input, ctx) => {
  if (input.mode === 'workflow_json' && (!input.workflow || typeof input.workflow !== 'object' || Array.isArray(input.workflow))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workflow'],
      message: 'workflow object is required for mode=workflow_json.',
    });
  }

  if (input.mode === 'workflow_file' && !input.workflowFilePath?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workflowFilePath'],
      message: 'workflowFilePath is required for mode=workflow_file.',
    });
  }

  if (input.mode === 'pattern') {
    if (!input.patternId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patternId'],
        message: 'patternId is required for mode=pattern.',
      });
    }
    if (!input.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spec'],
        message: 'spec is required for mode=pattern.',
      });
    }
  }
});

export const startAutomationJobTool = createTool({
  id: 'architect_start_automation_job',
  description:
    'Start a native durable Golden Path job in the Mastra process. Returns jobId immediately; completion is delivered as a pending update to returnToAgentId/returnToThreadId.',
  inputSchema: z.object({
    input: goldenPathInputSchema,
    targetAgentId: z.string().optional().default(AUTOMATION_ARCHITECT_AGENT_ID),
    callerAgentId: z.string().optional(),
    callerThreadId: z.string().optional(),
    architectThreadId: z.string().optional(),
    originAgentId: z.string().optional(),
    originThreadId: z.string().optional(),
    targetThreadId: z.string().optional(),
    returnToAgentId: z.string().optional(),
    returnToThreadId: z.string().optional(),
    wake: z.boolean().optional().default(true),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'architect_start_automation_job',
    category: 'network',
    risk: 'high',
    defaultAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
    redactInputFields: ['workflow', 'spec', 'approvalToken', 'input'],
    policy: (context: any, metadata) => ({
      agentId: metadata.agentId,
      action: 'deploy_automation' as const,
      target: context.input?.workflowId ?? context.input?.workflowName ?? 'automation_job',
      riskHint: 'high' as const,
    }),
    execute: async (context: any, metadata) => {
      const record = await startAutomationJob({
        input: context.input,
        approvalActorAgentId: metadata?.agentId,
        targetAgentId: context.targetAgentId ?? AUTOMATION_ARCHITECT_AGENT_ID,
        callerAgentId: context.callerAgentId,
        callerThreadId: context.callerThreadId,
        architectThreadId: context.architectThreadId ?? context.threadId ?? metadata?.threadId,
        originAgentId: context.originAgentId ?? context.callerAgentId,
        originThreadId: context.originThreadId ?? context.callerThreadId,
        targetThreadId: context.targetThreadId,
        returnToAgentId: context.returnToAgentId ?? context.targetAgentId ?? context.callerAgentId ?? metadata?.agentId ?? AUTOMATION_ARCHITECT_AGENT_ID,
        returnToThreadId: context.returnToThreadId ?? context.callerThreadId ?? context.threadId ?? metadata?.threadId,
        wake: context.wake ?? true,
        runId: metadata?.runId,
        turnId: metadata?.turnId,
      });

      return {
        success: true,
        jobId: record.jobId,
        automationId: record.automationId,
        status: record.status,
        targetAgentId: record.targetAgentId,
        returnToAgentId: record.returnToAgentId,
        returnToThreadId: record.returnToThreadId,
        message: `Automation job started: ${record.jobId}`,
      };
    },
  }),
});

export const getAutomationJobTool = createTool({
  id: 'architect_get_automation_job',
  description: 'Get status and compact result preview for a native Automation Golden Path job.',
  inputSchema: z.object({
    jobId: z.string(),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'architect_get_automation_job',
    category: 'other',
    risk: 'low',
    defaultAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
    execute: async (context: any) => {
      const record = await getAutomationJob(context.jobId);
      if (!record) {
        return {
          success: false,
          jobId: context.jobId,
          message: 'Automation job not found.',
        };
      }
      return {
        success: true,
        ...record,
      };
    },
  }),
});

export const listAutomationJobsTool = createTool({
  id: 'architect_list_automation_jobs',
  description: 'List recent native Automation Golden Path jobs.',
  inputSchema: z.object({
    automationId: z.string().optional(),
    targetAgentId: z.string().optional(),
    returnToAgentId: z.string().optional(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'stale']).optional(),
    limit: z.number().optional().default(10),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'architect_list_automation_jobs',
    category: 'other',
    risk: 'low',
    defaultAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
    execute: async (context: any) => {
      const jobs = await listAutomationJobs({
        automationId: context.automationId,
        targetAgentId: context.targetAgentId,
        returnToAgentId: context.returnToAgentId,
        status: context.status,
        limit: context.limit ?? 10,
      });
      return {
        success: true,
        jobs: jobs.map((job) => ({
          jobId: job.jobId,
          automationId: job.automationId,
          status: job.status,
          targetAgentId: job.targetAgentId,
          returnToAgentId: job.returnToAgentId,
          returnToThreadId: job.returnToThreadId,
          resultPreview: job.resultPreview,
          error: job.error,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        })),
        message: `${jobs.length} automation job(s).`,
      };
    },
  }),
});

export const cancelAutomationJobTool = createTool({
  id: 'architect_cancel_automation_job',
  description: 'Best-effort cancellation for a queued/running native Automation Golden Path job.',
  inputSchema: z.object({
    jobId: z.string(),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'architect_cancel_automation_job',
    category: 'other',
    risk: 'medium',
    defaultAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
    execute: async (context: any) => {
      const cancelled = await cancelAutomationJob(context.jobId);
      return {
        success: cancelled,
        jobId: context.jobId,
        message: cancelled ? 'Automation job cancellation requested.' : 'Automation job was not running or not found.',
      };
    },
  }),
});

export const markStaleAutomationJobsTool = createTool({
  id: 'architect_mark_stale_automation_jobs',
  description: 'Mark old queued/running automation jobs as stale after process restarts.',
  inputSchema: z.object({
    staleAfterMs: z.number().optional(),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'architect_mark_stale_automation_jobs',
    category: 'other',
    risk: 'low',
    defaultAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
    execute: async (context: any) => {
      const marked = await markStaleAutomationJobs({ staleAfterMs: context.staleAfterMs });
      return {
        success: true,
        marked,
        message: `Marked ${marked} stale automation job(s).`,
      };
    },
  }),
});
