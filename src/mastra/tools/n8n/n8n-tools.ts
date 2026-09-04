import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { N8nService } from './client';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { withIdempotency } from '../../services/idempotency.js';

export const n8nTriggerWebhookTool = createTool({
  id: 'n8n_trigger',
  description: 'Triggers a webhook in n8n, sending JSON data. Use this to initiate automations.',
  inputSchema: z.object({
    webhookPath: z.string().describe('The webhook path (without domain), e.g. "my-webhook-1"'),
    data: z.any().describe('JSON data to pass to the webhook'),
    idempotencyKey: z.string().optional().describe('Optional dedup key (e.g. laneId+step). Defaults to a hash of webhookPath+data so retries never fire twice.'),
  }),
  execute: withToolEnvelope({
    toolId: 'n8n_trigger',
    category: 'network',
    risk: 'medium',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['data'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'test_automation' as const,
      target: input.webhookPath,
      riskHint: 'medium' as const,
    }),
    execute: async (context) => {
    try {
      // Etap 5: a retried webhook trigger must not fire twice. Dedup on
      // (webhookPath + data); an explicit idempotencyKey (e.g. laneId+step)
      // overrides the content hash.
      const { result } = await withIdempotency(
        {
          toolId: 'n8n_trigger',
          input: { webhookPath: context.webhookPath, data: context.data },
          explicitKey: (context as { idempotencyKey?: string }).idempotencyKey,
        },
        async () => {
          const n8n = new N8nService();
          const data = await n8n.triggerWebhook(context.webhookPath, context.data);
          return { success: true as const, data };
        },
      );
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    },
  }),
});

export const n8nHealthTool = createTool({
  id: 'n8n_health',
  description: 'Checks if the n8n server is online and responding.',
  inputSchema: z.object({}),
  execute: withToolEnvelope({
    toolId: 'n8n_health',
    category: 'network',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    execute: async () => {
    const n8n = new N8nService();
    const online = await n8n.getHealth();
    return { online };
    },
  }),
});

export const n8nListWorkflowsTool = createTool({
  id: 'n8n_list_workflows',
  description: 'Returns a list of all available n8n workflows in the system (with their ID and active status).',
  inputSchema: z.object({}),
  execute: withToolEnvelope({
    toolId: 'n8n_list_workflows',
    category: 'network',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    outputPreviewMaxChars: 4000,
    execute: async () => {
    try {
      const n8n = new N8nService();
      const workflows = await n8n.listWorkflows();
      return { success: true, count: workflows.length, workflows };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    },
  }),
});

export const n8nGetWorkflowTool = createTool({
  id: 'n8n_get_workflow',
  description: 'Retrieves the complete JSON definition of a specific workflow by its ID.',
  inputSchema: z.object({
    workflowId: z.string().describe('The n8n workflow ID'),
  }),
  execute: withToolEnvelope({
    toolId: 'n8n_get_workflow',
    category: 'network',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    outputPreviewMaxChars: 4000,
    execute: async (context) => {
    try {
      const n8n = new N8nService();
      const workflow = await n8n.getWorkflow(context.workflowId);
      return { success: true, workflow };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    },
  }),
});

export const n8nUpdateWorkflowTool = createTool({
  id: 'n8n_update_workflow',
  description: 'Updates the definition of an existing workflow in n8n.',
  inputSchema: z.object({
    workflowId: z.string().describe('The n8n workflow ID to modify'),
    workflowData: z.any().describe('The new workflow definition (nodes, connections, settings)'),
  }),
  execute: withToolEnvelope({
    toolId: 'n8n_update_workflow',
    category: 'network',
    risk: 'high',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflowData'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'deploy_automation' as const,
      target: input.workflowId,
      riskHint: 'high' as const,
    }),
    execute: async (context) => {
    try {
      const n8n = new N8nService();
      const workflow = await n8n.updateWorkflow(context.workflowId, context.workflowData);
      return { success: true, workflow };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    },
  }),
});

export const n8nActivateWorkflowTool = createTool({
  id: 'n8n_activate_workflow',
  description: 'Activates a workflow in n8n.',
  inputSchema: z.object({
    workflowId: z.string().describe('The n8n workflow ID'),
  }),
  execute: withToolEnvelope({
    toolId: 'n8n_activate_workflow',
    category: 'network',
    risk: 'high',
    defaultAgentId: 'automationArchitect',
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'activate_automation' as const,
      target: input.workflowId,
      riskHint: 'high' as const,
    }),
    execute: async (context) => {
    try {
      const n8n = new N8nService();
      await n8n.activateWorkflow(context.workflowId);
      return { success: true, workflowId: context.workflowId, status: 'active' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    },
  }),
});

export const n8nDeactivateWorkflowTool = createTool({
  id: 'n8n_deactivate_workflow',
  description: 'Deactivates a workflow in n8n.',
  inputSchema: z.object({
    workflowId: z.string().describe('The n8n workflow ID'),
  }),
  execute: withToolEnvelope({
    toolId: 'n8n_deactivate_workflow',
    category: 'network',
    risk: 'high',
    defaultAgentId: 'automationArchitect',
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'activate_automation' as const,
      target: input.workflowId,
      riskHint: 'high' as const,
    }),
    execute: async (context) => {
    try {
      const n8n = new N8nService();
      await n8n.deactivateWorkflow(context.workflowId);
      return { success: true, workflowId: context.workflowId, status: 'inactive' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    },
  }),
});
