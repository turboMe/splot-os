import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { N8nService } from '../n8n/client.js';
import { getDb } from '../../lib/mongo.js';
import { validateWorkflow, normalizeConnectionKeys } from './validation/workflow-validator.js';
import { analyzeWorkflow } from './risk-scoring.js';
import { randomUUID } from 'crypto';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { compactAutomationResultForModel } from '../../services/automation-output-compaction.js';
import { preserveExistingNodeCredentials } from './workflow-write-helpers.js';

export const deployAutomationTool = createTool({
  id: 'architect_deploy_automation',
  description:
    'Creates or updates a workflow in n8n. Performs automatic validation, risk scoring, and authorization checks. The workflow is always created as inactive.',
  inputSchema: z.object({
    workflow: z.any().describe('Workflow JSON from architect.compose_workflow'),
    workflowId: z.string().optional().describe('Workflow ID in n8n (for update)'),
    automationId: z.string().optional().describe('Mastra internal automation ID'),
    approvalToken: z.string().optional().describe('Legacy compatibility field; Automation Architect does not require dashboard approval.'),
    allowDraftWithMissingCredentials: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    automationId: z.string().optional(),
    workflowId: z.string().optional(),
    operation: z.enum(['create', 'update', 'blocked']).optional(),
    message: z.string(),
    error: z.string().optional(),
    validation: z.any().optional(),
    risk: z.any().optional(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    outputCompaction: z.any().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_deploy_automation',
    category: 'network',
    risk: 'high',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflow', 'approvalToken'],
    policy: (input: any, metadata) => ({
      agentId: metadata.agentId,
      action: 'deploy_automation' as const,
      target: input.workflowId ? `update:${input.workflowId}` : 'create:new',
      riskHint: 'high' as const,
    }),
    execute: async (context: any) => {
    let automationId = context.automationId || randomUUID();

    // 1. Best-effort fixup of obvious LLM mistakes in connection keys
    // (e.g. {"'Set Vars'": …} → {"Set Vars": …}). Runs before validation so
    // an otherwise correct workflow isn't rejected for cosmetic reasons.
    const normalizationWarnings = normalizeConnectionKeys(context.workflow);

    // 2. Deterministic validation. Missing credentials may still allow an inactive
    // draft, but structural and security errors never pass deploy.
    const validation = validateWorkflow(context.workflow, 'draft');
    if (normalizationWarnings.length > 0) {
      validation.warnings = [
        ...validation.warnings,
        ...normalizationWarnings.map((message) => ({ message, severity: 'warning' as const })),
      ];
    }
    const hasRequiredMissingCredentials = validation.missingCredentials.some((credential) => credential.required);
    const blocksDeploy =
      validation.errors.length > 0 ||
      validation.securityIssues.length > 0 ||
      (!context.allowDraftWithMissingCredentials && hasRequiredMissingCredentials);

    if (blocksDeploy) {
      return {
        success: false,
        operation: 'blocked' as const,
        message: 'Workflow validation failed. Fix structural/security errors before deploy.',
        validation,
      };
    }

    // 3. Risk scoring is always recalculated server-side.
    const riskResult = analyzeWorkflow(context.workflow);
    const score = riskResult.score;
    const verdict: 'approve' | 'review' | 'block' = score >= 80 ? 'block' : score >= 20 ? 'review' : 'approve';

    if (verdict === 'block') {
      return {
        success: false,
        operation: 'blocked' as const,
        message: `Deploy blocked — risk too high (score=${score}). Repair the workflow.`,
        risk: { ...riskResult, verdict },
      };
    }

    const db = await getDb();

    // 4. Ownership check (for updates). Legacy or unmanaged workflows are read-only.
    if (context.workflowId) {
      const existing = await db.collection('automation_requests').findOne(
        { n8nWorkflowId: context.workflowId },
        { sort: { createdAt: 1 } },
      );
      if (!existing) {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Edit denied: workflow ${context.workflowId} has no Mastra ownership record. Create a new draft or assign ownership manually.`,
        };
      }

      if (existing.managedBy !== 'mastra') {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Edit denied: workflow ${context.workflowId} is not managed by Mastra (managedBy=${existing.managedBy}).`,
        };
      }

      if (context.automationId && existing.automationId && existing.automationId !== context.automationId) {
        return {
          success: false,
          operation: 'blocked' as const,
          message: `Edit denied: workflow ${context.workflowId} belongs to automationId=${existing.automationId}, not ${context.automationId}.`,
        };
      }

      if (!context.automationId && existing.automationId) {
        automationId = existing.automationId;
      }
    }

    try {
      const n8n = new N8nService();
      let n8nId = context.workflowId;
      let op: 'create' | 'update' = 'create';
      let workflowForWrite = context.workflow;

      if (n8nId) {
        const existingWorkflow = await n8n.getWorkflow(n8nId).catch(() => null);
        if (existingWorkflow) {
          workflowForWrite = preserveExistingNodeCredentials(workflowForWrite, existingWorkflow);
        }
      }

      // 5. Deploy to n8n (inactive=true)
      const payload = {
        ...workflowForWrite,
        name: workflowForWrite.name.startsWith('Mastra - ') ? workflowForWrite.name : `Mastra - ${workflowForWrite.name}`,
        active: false,
        settings: workflowForWrite.settings || { executionOrder: 'v1' },
      };

      if (n8nId) {
        await n8n.updateWorkflow(n8nId, payload);
        op = 'update';
      } else {
        const created = await n8n.createWorkflow(payload);
        n8nId = created.id;
      }

      // 6. Audit Trail in Mongo
      await db.collection('automation_requests').updateOne(
        { automationId },
        {
          $set: {
            automationId,
            n8nWorkflowId: n8nId,
            name: payload.name,
            status: 'draft_created',
            riskScore: score,
            riskVerdict: verdict,
            managedBy: 'mastra',
            lastSnapshot: payload,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      return {
        success: true,
        automationId,
        workflowId: n8nId,
        operation: op,
        message: `Workflow ${op === 'create' ? 'created' : 'updated'} (id=${n8nId}). Status: inactive.`,
        validation,
        risk: { ...riskResult, verdict },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Error communicating with n8n',
        error: (error as Error).message,
      };
    }
    },
    modelOutput: (output, _input, metadata) => compactAutomationResultForModel(output, metadata),
  }),
});
