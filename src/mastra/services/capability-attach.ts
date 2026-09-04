/**
 * Capability Attach — dynamic, approval-gated attachment of trialed MCP
 * servers (Etap 7, CGP steps 2c–2d).
 *
 * Flow (enforced by capability status machine + approvals collection):
 *   sandboxed → requestCapabilityApproval() → awaiting_approval
 *             → human approves in dashboard (approvals.status='approved')
 *             → attachCapability(approvalToken) → attached (live client)
 *
 * Secrets: real values come ONLY from process.env under the names the registry
 * entry documents — never from Mongo, never from tool args. Missing required
 * secrets fail the attach with an explicit list for the operator to add to .env.
 *
 * Each attached capability gets a DEDICATED MCPClient (WS-E isolation pattern:
 * one flaky server can never knock out the others). On startup,
 * reattachApprovedCapabilities() restores clients for status='attached'
 * records (fail-soft).
 */

import { getDb } from '../lib/mongo.js';
import {
  getCapability,
  listCapabilities,
  transitionCapability,
  type CapabilityRecord,
} from './capability-registry.js';
import { resolveRuntimeInvocation } from './capability-sandbox.js';

type AttachedClient = {
  capabilityId: string;
  registryName: string;
  client: { listToolsets: () => Promise<Record<string, Record<string, unknown>>>; disconnect: () => Promise<void> };
  toolNames: string[];
  attachedAt: Date;
};

const attachedClients = new Map<string, AttachedClient>();

/** Env spec for a live attach: real values for declared vars, error on missing required. */
export function buildLiveEnv(
  record: CapabilityRecord,
  processEnv: Record<string, string | undefined>,
): { env: Record<string, string>; missingRequired: string[] } {
  const env: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const v of record.package?.envVars ?? []) {
    const val = processEnv[v.name];
    if (val !== undefined && val !== '') env[v.name] = val;
    else if (v.isRequired) missingRequired.push(v.name);
  }
  return { env, missingRequired };
}

/**
 * Verify the human approval and bring the capability live.
 * `approvalToken` must reference an approvals doc with status 'approved'.
 */
export async function attachCapability(
  capabilityId: string,
  approvalToken: string,
): Promise<{ attached: boolean; toolNames?: string[]; error?: string }> {
  const record = await getCapability(capabilityId);
  if (!record) return { attached: false, error: `Capability not found: ${capabilityId}` };
  if (record.status !== 'awaiting_approval') {
    return { attached: false, error: `Capability is ${record.status} — attach runs from awaiting_approval (sandbox + request approval first).` };
  }

  // ── Approval gate — NEVER self-approve ──────────────────────────────────
  const db = await getDb();
  const approval = await db.collection('approvals').findOne({ id: approvalToken });
  if (!approval || approval.status !== 'approved') {
    return {
      attached: false,
      error: approval
        ? `Approval ${approvalToken} is '${approval.status}' — a human must approve it in the dashboard first.`
        : `Approval token not found: ${approvalToken}`,
    };
  }
  if (record.approvalId && record.approvalId !== approvalToken) {
    return { attached: false, error: `Approval token mismatch: capability expects ${record.approvalId}.` };
  }

  const pkg = record.package;
  if (!pkg?.identifier) return { attached: false, error: 'Capability has no runnable package.' };

  const { env, missingRequired } = buildLiveEnv(record, process.env);
  if (missingRequired.length > 0) {
    return {
      attached: false,
      error: `Missing required env vars in .env: ${missingRequired.join(', ')}. Add them (names documented by the registry entry), restart, then retry attach.`,
    };
  }

  try {
    const { MCPClient } = await import('@mastra/mcp');
    const { runtime, runtimeArgs, target } = resolveRuntimeInvocation(pkg);
    const client = new MCPClient({
      id: `capability-${capabilityId}`,
      timeout: 120_000,
      servers: { [record.registryName.replace(/[^a-zA-Z0-9_-]/g, '_')]: { command: runtime, args: [...runtimeArgs, target], env } },
    });
    const toolsets = await client.listToolsets();
    const toolNames = Object.values(toolsets).flatMap((t) => Object.keys(t));

    attachedClients.set(capabilityId, {
      capabilityId,
      registryName: record.registryName,
      client: client as unknown as AttachedClient['client'],
      toolNames,
      attachedAt: new Date(),
    });
    await transitionCapability(capabilityId, 'attached', { note: `attached with ${toolNames.length} tools (approval ${approvalToken})` });
    return { attached: true, toolNames };
  } catch (error) {
    return { attached: false, error: `attach failed: ${(error as Error).message.slice(0, 300)}` };
  }
}

/** Startup: restore clients for previously attached capabilities (fail-soft). */
export async function reattachApprovedCapabilities(): Promise<{ restored: number; failed: number }> {
  let restored = 0; let failed = 0;
  try {
    const records = await listCapabilities({ status: 'attached' });
    for (const record of records) {
      if (attachedClients.has(record.capabilityId)) continue;
      const pkg = record.package;
      if (!pkg?.identifier) { failed += 1; continue; }
      const { env, missingRequired } = buildLiveEnv(record, process.env);
      if (missingRequired.length > 0) { failed += 1; continue; }
      try {
        const { MCPClient } = await import('@mastra/mcp');
        const { runtime, runtimeArgs, target } = resolveRuntimeInvocation(pkg);
        const client = new MCPClient({
          id: `capability-${record.capabilityId}`,
          timeout: 120_000,
          servers: { [record.registryName.replace(/[^a-zA-Z0-9_-]/g, '_')]: { command: runtime, args: [...runtimeArgs, target], env } },
        });
        const toolsets = await client.listToolsets();
        const toolNames = Object.values(toolsets).flatMap((t) => Object.keys(t));
        attachedClients.set(record.capabilityId, {
          capabilityId: record.capabilityId,
          registryName: record.registryName,
          client: client as unknown as AttachedClient['client'],
          toolNames,
          attachedAt: new Date(),
        });
        restored += 1;
      } catch {
        failed += 1;
      }
    }
  } catch (err) {
    console.warn('[CapabilityAttach] reattach failed:', (err as Error).message);
  }
  if (restored > 0 || failed > 0) {
    console.log(`[CapabilityAttach] restored ${restored} capability client(s), ${failed} failed`);
  }
  return { restored, failed };
}

export function listAttachedClients(): Array<{ capabilityId: string; registryName: string; toolNames: string[]; attachedAt: Date }> {
  return [...attachedClients.values()].map(({ capabilityId, registryName, toolNames, attachedAt }) =>
    ({ capabilityId, registryName, toolNames, attachedAt }));
}

/** Invoke a tool on an attached capability (generic surface — v1). */
export async function invokeCapabilityTool(
  capabilityId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const attached = attachedClients.get(capabilityId);
  if (!attached) return { ok: false, error: `Capability ${capabilityId} is not attached in this process.` };
  try {
    const toolsets = await attached.client.listToolsets();
    for (const tools of Object.values(toolsets)) {
      const tool = tools[toolName] as { execute?: (input: unknown) => Promise<unknown> } | undefined;
      if (tool?.execute) {
        // Mastra's MCP tool wrappers validate the raw argument object against
        // the server's inputSchema — pass args directly, NOT wrapped in {context}.
        const result = await tool.execute(args);
        return { ok: true, result };
      }
    }
    return { ok: false, error: `Tool ${toolName} not found. Available: ${attached.toolNames.join(', ')}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 300) };
  }
}

/** Test hook — detach and forget a client (used by e2e cleanup). */
export async function detachCapabilityClient(capabilityId: string): Promise<void> {
  const attached = attachedClients.get(capabilityId);
  if (attached) {
    await attached.client.disconnect().catch(() => undefined);
    attachedClients.delete(capabilityId);
  }
}
