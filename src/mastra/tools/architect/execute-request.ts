import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { executeAutomationGoldenPath } from '../../services/automation-golden-path.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { compactAutomationResultForModel } from '../../services/automation-output-compaction.js';

export const executeAutomationRequestTool = createTool({
  id: 'architect_execute_automation_request',
  description:
    'Jedna deterministyczna bramka Golden Path: pattern/file/json -> validate -> risk -> deploy inactive -> mock test -> repair loop -> optional activate.',
  inputSchema: z.object({
    mode: z.enum(['pattern', 'workflow_file', 'workflow_json', 'graph_spec']),
    request: z.string().optional().describe('Original user request or concise task brief.'),
    patternId: z.string().optional().describe('Pattern id for mode=pattern.'),
    spec: z.any().optional().describe('AutomationSpec for mode=pattern.'),
    workflow: z.any().optional().describe('Workflow JSON object for mode=workflow_json.'),
    graphSpec: z.any().optional().describe('Declarative graph specification for mode=graph_spec ({ name, nodes, connections, settings }).'),
    workflowFilePath: z.string().optional().describe('Workflow JSON file path for mode=workflow_file.'),
    workflowName: z.string().optional(),
    workflowId: z.string().optional().describe('Existing n8n workflow id for update.'),
    automationId: z.string().optional(),
    approvalToken: z.string().optional().describe('Legacy compatibility field; ignored for Automation Architect runtime authority.'),
    activate: z.boolean().optional().default(false),
    allowDraftWithMissingCredentials: z.boolean().optional().default(true),
    requiresPublicWebhook: z.boolean().optional().default(false),
  }),
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'architect_execute_automation_request',
    category: 'network',
    risk: 'high',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflow', 'approvalToken', 'spec', 'graphSpec'],
    policy: (input: any, metadata) => ({
      agentId: metadata.agentId,
      action: 'deploy_automation' as const, // treat execute as deploy since it does deploy
      target: input.workflowId ?? 'new_automation',
      riskHint: 'high' as const,
    }),
    execute: async (context: any, metadata) => {
      return executeAutomationGoldenPath(context as any, { actorAgentId: metadata?.agentId });
    },
    modelOutput: (output, _input, metadata) => compactAutomationResultForModel(output, metadata),
  }),
});
