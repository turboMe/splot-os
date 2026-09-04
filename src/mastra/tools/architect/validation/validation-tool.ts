import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { normalizeConnectionKeys, validateWorkflow } from './workflow-validator.js';
import { withToolEnvelope } from '../../../services/harness-tool-envelope.js';
import { compactAutomationResultForModel } from '../../../services/automation-output-compaction.js';

export const validateWorkflowTool = createTool({
  id: 'architect_validate_workflow',
  description: 'Performs hard validation of structure and security for n8n workflow.',
  inputSchema: z.object({
    workflow: z.any().describe('Workflow JSON to validate'),
    profile: z.enum(['draft', 'strict', 'activation']).default('strict'),
    normalizeConnections: z
      .boolean()
      .optional()
      .default(true)
      .describe('Normalize obvious n8n connection id/name mismatches before validation.'),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    profile: z.string(),
    errors: z.array(z.any()),
    warnings: z.array(z.any()),
    securityIssues: z.array(z.any()),
    missingCredentials: z.array(z.any()),
    missingConfig: z.array(z.any()),
    nodeCount: z.number(),
    connectionCount: z.number(),
    triggerCount: z.number(),
    reachableNodeCount: z.number(),
    orphanNodeCount: z.number(),
    disconnectedComponents: z.array(z.any()),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    outputCompaction: z.any().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_validate_workflow',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflow'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    const normalizationWarnings = context.normalizeConnections === false
      ? []
      : normalizeConnectionKeys(context.workflow);
    const validation = validateWorkflow(context.workflow, context.profile);
    if (normalizationWarnings.length > 0) {
      validation.warnings = [
        ...validation.warnings,
        ...normalizationWarnings.map((message) => ({ message, severity: 'warning' as const })),
      ];
    }
    return validation;
    },
    modelOutput: (output, _input, metadata) => compactAutomationResultForModel(output, metadata),
  }),
});
