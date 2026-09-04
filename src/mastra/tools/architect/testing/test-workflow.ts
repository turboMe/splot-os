import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { N8nService } from '../../n8n/client.js';
import { getDb } from '../../../lib/mongo.js';
import { validateWorkflow } from '../validation/workflow-validator.js';
import { generateMockPayload } from './mock-data.js';
import { analyzeExecution } from './execution-analyzer.js';
import type { TestFinding, TestStatus } from './test-types.js';
import { withToolEnvelope } from '../../../services/harness-tool-envelope.js';
import { compactAutomationResultForModel } from '../../../services/automation-output-compaction.js';
import { markAutomationDeliverable } from '../../../services/mcp-handoff-state.js';

export const testWorkflowTool = createTool({
  id: 'architect_test_workflow',
  description:
    'Tests a Mastra workflow. Modes: mock (validation + test plan, no execution), manual (user instructions), real_credentials (actual execution and execution analysis). Requires the workflow to be mastra-managed.',
  inputSchema: z.object({
    automationId: z.string().describe('Automation ID from deploy_automation'),
    workflowId: z.string().describe('Workflow ID in n8n'),
    mode: z.enum(['mock', 'manual', 'real_credentials']).describe('Test mode'),
    payload: z.any().optional().describe('Optional custom payload (overrides mock)'),
    approvalToken: z.string().optional().describe('Legacy compatibility field; Automation Architect does not require dashboard approval.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.enum(['passed', 'failed', 'manual_required', 'blocked']),
    mode: z.string(),
    automationId: z.string(),
    workflowId: z.string(),
    executionId: z.string().optional(),
    findings: z.array(
      z.object({
        severity: z.enum(['error', 'warning', 'info']),
        nodeName: z.string().optional(),
        message: z.string(),
        suggestedFix: z.string().optional(),
      }),
    ),
    testPlan: z.array(z.string()).optional(),
    message: z.string(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    outputCompaction: z.any().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_test_workflow',
    category: 'network',
    risk: 'medium',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['approvalToken', 'payload'],
    policy: (input: any, metadata) => ({
      agentId: metadata.agentId,
      action: 'test_automation' as const,
      target: input.workflowId,
      riskHint: 'medium' as const,
    }),
    execute: async (context: any) => {
    const { automationId, workflowId, mode } = context;
    const db = await getDb();

    // 1. Ownership check — only test mastra-managed workflows
    const automation = await db.collection('automation_requests').findOne({ automationId });
    if (!automation) {
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [{ severity: 'error' as const, message: `automationId=${automationId} not found in registry.` }],
        message: 'Test blocked: automation not registered.',
      };
    }
    if (automation.managedBy !== 'mastra') {
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [
          {
            severity: 'error' as const,
            message: `Automation managedBy=${automation.managedBy}, not mastra. Test refused.`,
          },
        ],
        message: 'Test blocked: workflow not managed by Mastra.',
      };
    }
    if (automation.n8nWorkflowId !== workflowId) {
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [
          {
            severity: 'error' as const,
            message: `workflowId mismatch: automation expects ${automation.n8nWorkflowId}, received ${workflowId}.`,
          },
        ],
        message: 'Test blocked: workflowId mismatch.',
      };
    }

    // 2. Fetch the live workflow
    const n8n = new N8nService();
    let workflow: any;
    try {
      workflow = await n8n.getWorkflow(workflowId);
    } catch (error) {
      return {
        success: false,
        status: 'failed' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [{ severity: 'error' as const, message: `Could not read workflow from n8n: ${(error as Error).message}` }],
        message: 'Test failed: workflow unreachable.',
      };
    }

    // 3. Always run strict validation — mock mode stops here.
    const validation = validateWorkflow(workflow, 'strict');
    const findings: TestFinding[] = [];
    for (const e of validation.errors) findings.push({ severity: 'error', nodeName: e.nodeName, message: e.message });
    for (const w of validation.warnings) findings.push({ severity: 'warning', nodeName: w.nodeName, message: w.message });
    for (const s of validation.securityIssues) findings.push({ severity: 'error', nodeName: s.nodeName, message: `[security] ${s.message}` });
    for (const c of validation.missingCredentials) {
      findings.push({ severity: c.required ? 'error' : 'warning', message: `Missing credential: ${c.service} — ${c.setupHint}` });
    }
    for (const c of validation.missingConfig) {
      findings.push({ severity: c.required ? 'error' : 'warning', message: `Missing config: ${c.key} — ${c.description}` });
    }

    if (mode === 'mock') {
      const mock = generateMockPayload(workflow);
      const status: TestStatus = validation.valid ? 'passed' : 'failed';
      await persistTestEvent(automationId, workflowId, mode, status, findings);
      return {
        success: validation.valid,
        status,
        mode,
        automationId,
        workflowId,
        findings,
        testPlan: [`Trigger detected: ${mock.triggerType}`, ...mock.instructions],
        message: validation.valid
          ? 'Mock test passed: validation OK, test plan generated.'
          : 'Mock test failed: workflow has validation errors. Use architect.repair_workflow.',
      };
    }

    if (mode === 'manual') {
      const mock = generateMockPayload(workflow);
      await persistTestEvent(automationId, workflowId, mode, 'manual_required', findings);
      return {
        success: true,
        status: 'manual_required' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings,
        testPlan: [
          `1. Open workflow in n8n: ${n8n.getEditorUrl()}/workflow/${workflowId}`,
          `2. Trigger: ${mock.triggerType}`,
          ...mock.instructions.map((s, i) => `${i + 3}. ${s}`),
          `After testing, run architect.test_workflow in real_credentials mode to analyze the execution.`,
        ],
        message: 'Manual test plan ready — execute steps in n8n UI.',
      };
    }

    // mode === 'real_credentials'
    if (!validation.valid) {
      await persistTestEvent(automationId, workflowId, mode, 'blocked', findings);
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings,
        message: 'Real test blocked: validation failed. Use architect.repair_workflow or fix the specification.',
      };
    }

    // Try executeWorkflow REST endpoint (community-edition support varies).
    let execution: any;
    let executionId: string | undefined;
    try {
      const mock = generateMockPayload(workflow);
      const inputData = context.payload ?? mock.payload;
      execution = await n8n.executeWorkflow(workflowId, inputData);
      executionId = execution?.id ?? execution?.executionId;
    } catch (error) {
      const msg = (error as Error).message;
      // Common: "404 not found" on community edition where /run is gated.
      // Fall back to fetching latest execution which may have been triggered manually.
      const recent = await n8n.getExecutions({ workflowId, limit: 1 }).catch(() => []);
      if (recent.length > 0) {
        execution = await n8n.getExecution(recent[0].id).catch(() => null);
        executionId = recent[0].id;
      } else {
        await persistTestEvent(automationId, workflowId, mode, 'failed', findings);
        return {
          success: false,
          status: 'failed' as TestStatus,
          mode,
          automationId,
          workflowId,
          findings: [
            ...findings,
            {
              severity: 'error' as const,
              message: `Could not execute or fetch any execution: ${msg}`,
              suggestedFix: 'n8n Community might not support /run — run manually and retry the test.',
            },
          ],
          message: 'Real test failed: no execution data.',
        };
      }
    }

    const analysis = analyzeExecution(execution);
    const allFindings = [...findings, ...analysis.findings];
    const status: TestStatus = analysis.ok && validation.valid ? 'passed' : 'failed';
    await persistTestEvent(automationId, workflowId, mode, status, allFindings, executionId);

    return {
      success: analysis.ok,
      status,
      mode,
      automationId,
      workflowId,
      executionId,
      findings: allFindings,
      message: analysis.ok
        ? `Real test passed (executionId=${executionId ?? 'n/a'}).`
        : 'Real test failed — check findings and use architect.repair_workflow.',
    };
    },
    modelOutput: (output, _input, metadata) => compactAutomationResultForModel(output, metadata),
  }),
});

async function persistTestEvent(
  automationId: string,
  workflowId: string,
  mode: string,
  status: string,
  findings: TestFinding[],
  executionId?: string,
) {
  try {
    const db = await getDb();
    const existing = await db.collection('automation_requests').findOne(
      { automationId },
      { projection: { status: 1 } },
    );
    const nextStatus = status === 'passed' && existing?.status !== 'active'
      ? 'tested'
      : existing?.status;
    if (status === 'passed') {
      markAutomationDeliverable(existing?.status === 'active' ? 'active' : 'tested', {
        automationId,
        workflowId,
        workflowName: existing?.name,
        riskScore: existing?.riskScore,
        riskVerdict: existing?.riskVerdict,
        // Carry HOW it passed. `mode` was already a parameter here and was used
        // only for the audit row, so a mock pass latched `tested` exactly like a
        // real-credentials pass and the finalize lever could not distinguish them.
        testMode: mode === 'real_credentials' || mode === 'manual' ? mode : 'mock',
        message: `Workflow test passed (${mode}).`,
      });
    }
    await db.collection('automation_events').insertOne({
      automationId,
      type: 'test_run',
      data: { mode, status, executionId, findings },
      createdAt: new Date(),
    });
    await db
      .collection('automation_requests')
      .updateOne(
        { automationId },
        {
          $set: {
            lastTest: { mode, status, executionId, findings, at: new Date() },
            ...(nextStatus ? { status: nextStatus } : {}),
            updatedAt: new Date(),
          },
        },
      );
  } catch {
    // never block test on audit failure
  }
}
