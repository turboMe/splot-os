/**
 * Capability tools — the CGP surface for capabilitySmith (Etap 7).
 *
 * Order of operations (enforced by the capability status machine):
 *   mcp_discover → capability_sandbox → capability_request_attach
 *   → human approves in dashboard → capability_attach → capability_invoke
 *
 * The approval doc uses the exact same shape/collection as
 * system_request_approval, so it shows up in the same dashboard inbox.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getDb } from '../../lib/mongo.js';
import { CAPABILITY_SMITH_AGENT_ID } from '../../config/agent-ids.js';
import {
  getCapability,
  listCapabilities,
  transitionCapability,
} from '../../services/capability-registry.js';
import { sandboxTrialCapability } from '../../services/capability-sandbox.js';
import {
  attachCapability,
  listAttachedClients,
  invokeCapabilityTool,
} from '../../services/capability-attach.js';
import { startCapabilityBuild, getBuildReport } from '../../services/capability-build.js';
import { isHarnessFeatureEnabled } from '../../config/harness-flags.js';

export const capabilitySandboxTool = createTool({
  id: 'capability_sandbox',
  description:
    'Trial a discovered MCP server in ISOLATION: spawned with an empty environment (env -i), mock values ' +
    'for every declared env var (real secrets can never leak), hard timeout, then smoke-test (list tools). ' +
    'Success → status sandboxed (ready for approval); failure → quarantined. Run after mcp_discover.',
  inputSchema: z.object({
    capabilityId: z.string().describe('Capability id from mcp_discover'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    ok: z.boolean().optional(),
    toolCount: z.number().optional(),
    toolNames: z.array(z.string()).optional(),
    durationMs: z.number().optional(),
    summary: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const report = await sandboxTrialCapability(input.capabilityId);
      return {
        success: true,
        ok: report.ok,
        toolCount: report.toolCount,
        toolNames: report.toolNames,
        durationMs: report.durationMs,
        summary: report.ok
          ? `Sandbox OK: ${report.toolCount} tools in ${Math.round(report.durationMs / 1000)}s (${(report.toolNames ?? []).slice(0, 8).join(', ')}). Next: capability_request_attach.`
          : `Sandbox FAILED (quarantined): ${report.error}`,
      };
    } catch (error) {
      return { success: false, summary: '', error: (error as Error).message };
    }
  },
});

export const capabilityRequestAttachTool = createTool({
  id: 'capability_request_attach',
  description:
    'Request HUMAN approval to attach a sandboxed capability. Registers an approval in the dashboard inbox ' +
    '(same as system_request_approval) listing the tools it exposes and the secret env vars it will need. ' +
    'NEVER attaches by itself — a human must approve, then call capability_attach with the approvalId.',
  inputSchema: z.object({
    capabilityId: z.string(),
    justification: z.string().min(10).describe('Why this capability is needed (which gap/task it solves)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    approvalId: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const record = await getCapability(input.capabilityId);
      if (!record) return { success: false, message: '', error: `Capability not found: ${input.capabilityId}` };
      if (record.status !== 'sandboxed') {
        return { success: false, message: '', error: `Capability is ${record.status} — request approval from sandboxed only.` };
      }
      const secretEnv = (record.package?.envVars ?? []).filter((v) => v.isSecret).map((v) => v.name);
      const approvalId = randomUUID();
      const db = await getDb();
      await db.collection('approvals').insertOne({
        id: approvalId,
        agentId: CAPABILITY_SMITH_AGENT_ID,
        taskId: null,
        tool: 'cgp.attach_capability',
        action: `Attach MCP capability "${record.registryName}" — ${record.description.slice(0, 150)}. ` +
          `Tools: ${(record.sandboxReport?.toolNames ?? []).slice(0, 10).join(', ')}. ` +
          (secretEnv.length ? `Requires SECRETS in .env: ${secretEnv.join(', ')}.` : 'No secrets required.') +
          ` Justification: ${input.justification}`,
        args: { capabilityId: record.capabilityId, registryName: record.registryName, secretEnv },
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await transitionCapability(input.capabilityId, 'awaiting_approval', { note: `approval requested (${approvalId})`, approvalId });
      return {
        success: true,
        approvalId,
        message: `Approval requested (ID: ${approvalId}). A human must approve it in the dashboard; then call capability_attach(capabilityId, approvalId).`,
      };
    } catch (error) {
      return { success: false, message: '', error: (error as Error).message };
    }
  },
});

export const capabilityAttachTool = createTool({
  id: 'capability_attach',
  description:
    'Attach an APPROVED capability: verifies the human approval, injects real env values (from .env, by the ' +
    'documented names — never stored in Mongo), starts a dedicated MCP client, lists its tools. ' +
    'Fails with an explicit list if required env vars are missing.',
  inputSchema: z.object({
    capabilityId: z.string(),
    approvalId: z.string().describe('Approval id that the human approved'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    toolNames: z.array(z.string()).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const res = await attachCapability(input.capabilityId, input.approvalId);
    if (!res.attached) return { success: false, message: '', error: res.error };
    return {
      success: true,
      toolNames: res.toolNames,
      message: `Capability attached with ${res.toolNames?.length ?? 0} tools. Use capability_invoke(capabilityId, tool, args).`,
    };
  },
});

export const capabilityListTool = createTool({
  id: 'capability_list',
  description:
    'List capabilities in the registry (by lifecycle status) and the clients attached in this process. ' +
    'Use to check what the system has discovered/trialed/attached and what is available to invoke.',
  inputSchema: z.object({
    status: z.enum(['discovered', 'sandboxed', 'awaiting_approval', 'attached', 'rejected', 'quarantined']).optional(),
  }),
  outputSchema: z.object({
    count: z.number(),
    capabilities: z.array(z.object({
      capabilityId: z.string(), registryName: z.string(), status: z.string(),
      description: z.string(), toolCount: z.number().optional(),
    })),
    attachedInProcess: z.array(z.object({ capabilityId: z.string(), registryName: z.string(), toolNames: z.array(z.string()) })),
  }),
  execute: async (input) => {
    const records = await listCapabilities({ status: input.status, limit: 50 });
    return {
      count: records.length,
      capabilities: records.map((r) => ({
        capabilityId: r.capabilityId,
        registryName: r.registryName,
        status: r.status,
        description: r.description.slice(0, 120),
        toolCount: r.sandboxReport?.toolCount,
      })),
      attachedInProcess: listAttachedClients().map((a) => ({
        capabilityId: a.capabilityId, registryName: a.registryName, toolNames: a.toolNames,
      })),
    };
  },
});

export const capabilityInvokeTool = createTool({
  id: 'capability_invoke',
  description:
    'Call a tool on an ATTACHED capability (generic surface). Check capability_list for attached ' +
    'capabilities and their tool names first. New capabilities run in shadow tier — prefer read-only ' +
    'calls; side-effectful calls on a fresh capability should go through system_request_approval.',
  inputSchema: z.object({
    capabilityId: z.string(),
    tool: z.string().describe('Tool name exposed by the capability'),
    args: z.record(z.string(), z.unknown()).optional().default({}),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const res = await invokeCapabilityTool(input.capabilityId, input.tool, input.args ?? {});
    if (!res.ok) return { success: false, error: res.error };
    return { success: true, result: res.result };
  },
});

// ── BUILD path (E7-BUILD) ────────────────────────────────────────────────────
//
// The other half of CGP: when nothing in the registry fits, the system writes the
// tool itself. The smith delegates to codingAgent first (async, its own worktree)
// and then hands the resulting branch here — this tool owns the gate, the merge
// and the bookkeeping, never the code generation.

export const capabilityBuildTool = createTool({
  id: 'capability_build',
  description:
    'Run the BUILD pipeline for a new capability: validate the spec artifact, take a lane + repo claims, ' +
    'run `npx tsc --noEmit` and `npm run check:all` INSIDE the coding worktree, and merge only if both are green. ' +
    'Call this AFTER delegating the implementation to codingAgent — pass the branch and worktree it produced. ' +
    'Returns immediately with a buildId (the gate takes minutes); poll capability_build_status. ' +
    'Promote onto the live process is OFF unless you pass an APPROVED approval token.',
  inputSchema: z.object({
    specArtifactId: z.string().describe('action_plan artifact with goal, ioContract, integrationPoint, testPlan'),
    branch: z.string().min(1).describe('Branch the coding delegation produced'),
    worktreePath: z.string().min(1).describe('Worktree directory where the gate must run'),
    gapId: z.string().optional().describe('capability_gaps entry this build closes'),
    targetBranch: z.string().optional().describe('Branch to merge into (default: current checkout)'),
    autoPromote: z.boolean().optional().default(false),
    approvalToken: z.string().optional().describe('Approved approvals doc id — required for promote'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    buildId: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    if (!isHarnessFeatureEnabled('FEATURE_CAPABILITY_BUILD', true)) {
      return { success: false, message: '', error: 'FEATURE_CAPABILITY_BUILD is off' };
    }
    try {
      const { buildId } = await startCapabilityBuild(
        {
          specArtifactId: input.specArtifactId,
          gapId: input.gapId,
          targetBranch: input.targetBranch,
          autoPromote: input.autoPromote,
          approvalToken: input.approvalToken,
        },
        {
          // The delegation already happened; feed its result into the pipeline.
          runDelegation: async () => ({
            ok: true,
            branch: input.branch,
            worktreePath: input.worktreePath,
          }),
        },
      );
      return {
        success: true,
        buildId,
        message:
          `Build ${buildId} started on ${input.branch}. The gate (tsc + check:all) runs in ${input.worktreePath} ` +
          `and takes minutes — poll capability_build_status(${buildId}).`,
      };
    } catch (error) {
      return { success: false, message: '', error: (error as Error).message };
    }
  },
});

export const capabilityBuildStatusTool = createTool({
  id: 'capability_build_status',
  description:
    'Read the state of a capability build started with capability_build: per-step results, the gate verdict, ' +
    'the merge commit and the registry entry. Statuses: running / completed / failed / blocked_needs_approval.',
  inputSchema: z.object({ buildId: z.string() }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.string().optional(),
    steps: z.array(z.object({
      step: z.string(),
      ok: z.boolean(),
      note: z.string(),
      ms: z.number().optional(),
    })).optional(),
    branch: z.string().optional(),
    mergedCommit: z.string().optional(),
    capabilityId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const report = await getBuildReport(input.buildId);
    if (!report) return { success: false, error: `Build not found: ${input.buildId}` };
    return {
      success: report.status === 'completed',
      status: report.status,
      steps: report.steps,
      branch: report.branch,
      mergedCommit: report.mergedCommit,
      capabilityId: report.capabilityId,
      error: report.error,
    };
  },
});
