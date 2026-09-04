/**
 * System tool: request human approval before executing a risky action.
 * Replaces: ApprovalManager.createPending() from jarvis approval-manager.ts.
 *
 * Integrated with Auto-Approval Policy Engine:
 * - Safe operations (Category A) and guardrailed operations (Category B) are auto-approved.
 * - Risky / core / paid operations (Category C) register as 'pending' for human approval.
 * - Stability / idempotency: reuses existing pending approvals for project/clip/track units.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { randomUUID } from 'crypto';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { META_AGENT_ID } from '../../config/agent-ids.js';
import { evaluateApprovalPolicy } from '../../services/approval-policy-engine.js';

export const requestApprovalTool = createTool({
  id: 'system_request_approval',
  description: 'Registers a request for human approval before executing a risky action (e.g., sending an email, deploying a workflow, changing status). ALWAYS use this tool instead of calling the risky tool directly if the action is irreversible and requires user confirmation.',
  inputSchema: z.object({
    tool: z.string().describe('Name of the tool/action to be approved, e.g. "gmail.send_draft"'),
    action: z.string().describe('Description of the action for the user'),
    args: z.record(z.string(), z.unknown()).describe('Action arguments that will be passed after approval'),
    agentId: z.string().optional().default(META_AGENT_ID).describe('ID of the agent requesting approval'),
    taskId: z.string().optional().describe('ID of the associated task'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    approvalId: z.string().optional(),
    status: z.enum(['pending', 'approved']),
    autoApproved: z.boolean().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'system_request_approval',
    category: 'approval',
    risk: 'low',
    defaultAgentId: META_AGENT_ID,
    redactInputFields: ['args'],
    policy: (input: any) => ({
      agentId: input.agentId ?? META_AGENT_ID,
      taskId: input.taskId,
      action: 'approval' as const,
      target: input.tool,
      riskHint: 'low' as const,
    }),
    execute: async (context) => {
    try {
      const db = await getDb();

      // 1. Stability / idempotency: if a PENDING approval already exists for the
      // same action target, reuse it instead of minting a fresh token. Scope this
      // to the real generation unit: film uses clipId, music uses trackId plus
      // surface/mode, and other project tools can still reuse at project level.
      const actionArgs = context.args as Record<string, unknown> | undefined;
      const projectId = actionArgs?.projectId;
      const clipId = actionArgs?.clipId;
      const trackId = actionArgs?.trackId;
      const surface = actionArgs?.surface;
      const mode = actionArgs?.mode;
      if (typeof projectId === 'string' && projectId.length > 0) {
        const existing = await db.collection('approvals').findOne({
          status: 'pending',
          tool: context.tool,
          'args.projectId': projectId,
          ...(typeof clipId === 'string' ? { 'args.clipId': clipId } : {}),
          ...(typeof trackId === 'string' ? { 'args.trackId': trackId } : {}),
          ...(typeof surface === 'string' ? { 'args.surface': surface } : {}),
          ...(typeof mode === 'string' ? { 'args.mode': mode } : {}),
        });
        if (existing && typeof existing.id === 'string') {
          return {
            success: true,
            approvalId: existing.id,
            status: 'pending' as const,
            autoApproved: false,
            message: `Approval still pending (ID: ${existing.id}). Reusing the existing request — approve THIS id, do not request a new one.`,
          };
        }
      }

      // 2. Evaluate against Auto-Approval Policy Engine
      const policyResult = await evaluateApprovalPolicy({
        tool: context.tool,
        action: context.action,
        args: actionArgs,
        agentId: context.agentId ?? META_AGENT_ID,
        taskId: context.taskId,
      });

      const approvalId = randomUUID();
      const isAuto = policyResult.decision === 'AUTO_APPROVE';
      const status = isAuto ? ('approved' as const) : ('pending' as const);

      // 3. Persist approval record
      await db.collection('approvals').insertOne({
        id: approvalId,
        agentId: context.agentId ?? META_AGENT_ID,
        taskId: context.taskId ?? null,
        tool: context.tool,
        action: context.action,
        args: context.args,
        status,
        autoApproved: isAuto,
        autoApprovedCategory: isAuto ? policyResult.category : undefined,
        autoApprovedRule: isAuto ? policyResult.ruleName : undefined,
        autoApprovedReason: isAuto ? policyResult.reason : undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      if (isAuto) {
        return {
          success: true,
          approvalId,
          status: 'approved' as const,
          autoApproved: true,
          message: `Auto-approved by policy [${policyResult.ruleName}]: ${policyResult.reason} (Token: ${approvalId}). You may proceed with the action.`,
        };
      }

      return {
        success: true,
        approvalId,
        status: 'pending' as const,
        autoApproved: false,
        message: `Approval request registered (ID: ${approvalId}). Wait for user approval in the dashboard.`,
      };
    } catch (error) {
      return {
        success: false,
        status: 'pending' as const,
        autoApproved: false,
        message: 'Error registering approval request',
        error: (error as Error).message,
      };
    }
    },
  }),
});
