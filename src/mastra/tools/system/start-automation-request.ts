import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

import {
  executeAutomationGoldenPath,
  type AutomationGoldenPathInput,
} from '../../services/automation-golden-path.js';
import { startAutomationJob } from '../../services/automation-job-manager.js';
import { withToolEnvelope, type ToolEnvelopeMetadata } from '../../services/harness-tool-envelope.js';
import {
  AUTOMATION_ARCHITECT_AGENT_ID,
  META_AGENT_ID,
  canonicalizeRuntimeAgentId,
} from '../../config/agent-ids.js';

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
  approvalToken: z.string().optional().describe('Legacy dashboard-approval token for non-Architect direct callers.'),
  activate: z.boolean().optional().default(false),
  allowDraftWithMissingCredentials: z.boolean().optional().default(true),
  requiresPublicWebhook: z.boolean().optional().default(false),
});

const startAutomationRequestInputSchema = goldenPathInputSchema.extend({
  executionMode: z.enum(['job', 'sync']).optional().default('job'),
  callerAgentId: z.enum([META_AGENT_ID, AUTOMATION_ARCHITECT_AGENT_ID]).optional().default(META_AGENT_ID),
  callerThreadId: z.string().optional(),
  originAgentId: z.string().optional(),
  originThreadId: z.string().optional(),
  returnToAgentId: z.enum([META_AGENT_ID, AUTOMATION_ARCHITECT_AGENT_ID]).optional(),
  returnToThreadId: z.string().optional(),
  wake: z.boolean().optional().default(true),
}).superRefine(addGoldenPathModeIssues);

type StartAutomationRequestInput = z.input<typeof startAutomationRequestInputSchema>;
type ParsedStartAutomationRequestInput = z.infer<typeof startAutomationRequestInputSchema>;
const LARGE_WORKFLOW_JSON_BYTES = 20 * 1024;
const META_DIRECT_WORKFLOW_NODE_THRESHOLD = 8;
const WORKFLOW_FILE_ROOT = '/tmp/mastra-automation-workflows';

export async function startAutomationRequest(
  context: StartAutomationRequestInput,
  metadata: (ToolEnvelopeMetadata & { agentId?: string; runId?: string; toolId?: string }) = {},
) {
  const parsedContext = startAutomationRequestInputSchema.parse(context);
  const callerAgentId = canonicalizeRuntimeAgentId(parsedContext.callerAgentId ?? metadata.agentId) ?? META_AGENT_ID;
  const callerThreadId = parsedContext.callerThreadId ?? metadata.threadId;
  const returnToAgentId = canonicalizeRuntimeAgentId(parsedContext.returnToAgentId ?? callerAgentId) ?? callerAgentId;
  const returnToThreadId = parsedContext.returnToThreadId ?? callerThreadId ?? metadata.threadId;

  const metaDirectBlock = shouldBlockMetaDirectComplexWorkflow(parsedContext, callerAgentId);
  if (metaDirectBlock.blocked) {
    return {
      success: false,
      executionMode: 'blocked' as const,
      status: 'blocked',
      error: 'meta_direct_complex_workflow_blocked',
      targetAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
      message:
        'Meta-agent must not directly start Golden Path for a complex workflow_json build/deploy. '
        + 'Delegate the user goal to automationArchitect with system_delegate_task; automationArchitect will call n8nMcpEngineer if node validation is needed.',
      reason: metaDirectBlock.reason,
    };
  }

  const input = await toGoldenPathInput(parsedContext);

  if (parsedContext.executionMode === 'sync') {
    const result = await executeAutomationGoldenPath(input, {
      // Only envelope-derived runtime identity can grant the architect bypass;
      // `callerAgentId` is model input and is never an authority signal.
      actorAgentId: metadata.agentId,
    });
    return {
      success: result.success,
      executionMode: 'sync' as const,
      status: result.status,
      automationId: result.automationId,
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      result,
      message: result.message,
    };
  }

  const record = await startAutomationJob({
    input,
    approvalActorAgentId: metadata.agentId,
    targetAgentId: AUTOMATION_ARCHITECT_AGENT_ID,
    callerAgentId,
    callerThreadId,
    originAgentId: canonicalizeRuntimeAgentId(parsedContext.originAgentId ?? callerAgentId) ?? callerAgentId,
    originThreadId: parsedContext.originThreadId ?? callerThreadId,
    returnToAgentId,
    returnToThreadId,
    wake: parsedContext.wake,
    runId: metadata.runId,
    turnId: metadata.turnId,
  });

  return {
    success: true,
    executionMode: 'job' as const,
    jobId: record.jobId,
    automationId: record.automationId,
    status: record.status,
    targetAgentId: record.targetAgentId,
    returnToAgentId: record.returnToAgentId,
    returnToThreadId: record.returnToThreadId,
    message: `Structured automation Golden Path job started: ${record.jobId}`,
  };
}

function shouldBlockMetaDirectComplexWorkflow(
  context: ParsedStartAutomationRequestInput,
  callerAgentId: string,
): { blocked: boolean; reason?: string } {
  if (callerAgentId !== META_AGENT_ID) return { blocked: false };
  if (context.mode !== 'workflow_json') return { blocked: false };
  if (!context.workflow || typeof context.workflow !== 'object' || Array.isArray(context.workflow)) return { blocked: false };

  const nodes = Array.isArray((context.workflow as any).nodes) ? (context.workflow as any).nodes as any[] : [];
  const nodeTypes = nodes.map((node) => String(node?.type ?? '')).filter(Boolean);
  const hasSpecializedExternalNode = nodeTypes.some((type) =>
    /googleSheets|gmail|telegram|mongoDb|slack|notion|hubspot|postgres|mysql|httpRequest/i.test(type),
  );

  if (nodes.length >= META_DIRECT_WORKFLOW_NODE_THRESHOLD) {
    return { blocked: true, reason: `workflow_json has ${nodes.length} nodes; complex builds must be delegated to automationArchitect.` };
  }
  if (hasSpecializedExternalNode && nodes.length >= 4) {
    return { blocked: true, reason: `workflow_json uses external/service nodes (${[...new Set(nodeTypes)].join(', ')}); delegate to automationArchitect.` };
  }

  return { blocked: false };
}

export const startAutomationRequestTool = createTool({
  id: 'system_start_automation_request',
  description:
    'Structural bridge to Automation Golden Path. automationArchitect may use it for validated workflow input. Meta must delegate complex n8n build/deploy goals to automationArchitect instead of building large workflow_json directly.',
  inputSchema: startAutomationRequestInputSchema,
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'system_start_automation_request',
    category: 'network',
    risk: 'high',
    defaultAgentId: META_AGENT_ID,
    redactInputFields: ['workflow', 'spec', 'approvalToken'],
    policy: (input: any, metadata) => ({
      agentId: canonicalizeRuntimeAgentId(metadata.agentId ?? input.callerAgentId) ?? META_AGENT_ID,
      action: 'deploy_automation' as const,
      target: input.workflowId ?? input.workflowName ?? input.patternId ?? input.automationId ?? 'automation_request',
      riskHint: 'high' as const,
    }),
    execute: async (context: any, metadata) => startAutomationRequest(context, metadata),
  }),
});

async function toGoldenPathInput(context: ParsedStartAutomationRequestInput): Promise<AutomationGoldenPathInput> {
  const input: AutomationGoldenPathInput = {
    mode: context.mode,
    request: context.request,
    patternId: context.patternId,
    spec: context.spec,
    workflow: context.workflow,
    workflowFilePath: context.workflowFilePath,
    workflowName: context.workflowName,
    workflowId: context.workflowId,
    automationId: context.automationId,
    approvalToken: context.approvalToken,
    activate: context.activate,
    allowDraftWithMissingCredentials: context.allowDraftWithMissingCredentials,
    requiresPublicWebhook: context.requiresPublicWebhook,
  };

  if (input.mode === 'workflow_json' && input.workflow && typeof input.workflow === 'object') {
    const json = JSON.stringify(input.workflow, null, 2);
    if (Buffer.byteLength(json, 'utf8') > LARGE_WORKFLOW_JSON_BYTES) {
      await mkdir(WORKFLOW_FILE_ROOT, { recursive: true });
      const workflowName = input.workflowName ?? readableWorkflowName(input.workflow);
      const filePath = join(WORKFLOW_FILE_ROOT, `${safeFileStem(workflowName ?? input.automationId ?? 'workflow')}-${randomUUID()}.json`);
      await writeFile(filePath, json, 'utf8');
      return {
        ...input,
        mode: 'workflow_file',
        workflow: undefined,
        workflowFilePath: filePath,
        workflowName,
      };
    }
  }

  return input;
}

function readableWorkflowName(workflow: unknown): string | undefined {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return undefined;
  const name = (workflow as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function safeFileStem(value: string): string {
  const stem = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return stem.slice(0, 80) || 'workflow';
}

function addGoldenPathModeIssues(input: z.infer<typeof goldenPathInputSchema>, ctx: z.RefinementCtx): void {
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
}
