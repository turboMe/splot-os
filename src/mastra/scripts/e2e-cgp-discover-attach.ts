#!/usr/bin/env tsx
/**
 * e2e:cgp-discover-attach — Etap 7 (IDEALSYSTEMMASTERPLAN exit criterion).
 *
 * The full Capability Gap Protocol loop against a REAL stdio MCP server
 * (fixtures/fake-mcp-server.mjs, built on the official MCP SDK) — no network,
 * no LLM, fully deterministic:
 *
 *   gap → capability recorded → capability_sandbox (isolated: server sees a
 *   MOCK secret) → capability_request_attach (human approval REQUIRED — attach
 *   refused while pending) → human approves → capability_attach (server now
 *   sees the REAL secret from .env) → capability_invoke works → capability_list
 *   shows it attached.
 *
 * This is the "yesterday it couldn't, today it taught itself" scenario, with
 * exactly one human action (approving the id).
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { getDb } from '../lib/mongo.js';
import {
  recordDiscoveredCapability,
  getCapability,
  CAPABILITIES_COLLECTION,
} from '../services/capability-registry.js';
import { buildSandboxSpawnSpec } from '../services/capability-sandbox.js';
import { detachCapabilityClient } from '../services/capability-attach.js';
import {
  capabilitySandboxTool,
  capabilityRequestAttachTool,
  capabilityAttachTool,
  capabilityListTool,
  capabilityInvokeTool,
} from '../tools/system/capability-tools.js';

const TAG = `cgp-e2e-${Date.now()}`;
const REAL_SECRET = `REAL-SECRET-${TAG}`;
const FIXTURE = resolve(process.cwd(), 'src/mastra/scripts/fixtures/fake-mcp-server.mjs');

let failures = 0;
let capabilityId = '';

function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

const exec = async (tool: unknown, input: Record<string, unknown>): Promise<any> =>
  (tool as { execute: (i: Record<string, unknown>) => Promise<any> }).execute(input);

async function cleanup(): Promise<void> {
  if (capabilityId) await detachCapabilityClient(capabilityId).catch(() => undefined);
  const db = await getDb();
  await db.collection(CAPABILITIES_COLLECTION).deleteMany({ registryName: { $regex: TAG } }).catch(() => undefined);
  await db.collection('approvals').deleteMany({ 'args.registryName': { $regex: TAG } }).catch(() => undefined);
}

async function main(): Promise<void> {
  console.log('e2e:cgp-discover-attach');
  process.env.FAKE_SECRET = REAL_SECRET;

  // ── 1. Gap → capability recorded (stands in for mcp_discover, which needs the network)
  const record = await recordDiscoveredCapability({
    registryName: `${TAG}/fake-echo`,
    description: 'Echo capability used to prove the CGP loop end to end',
    gapDescription: 'agent needs an echo capability',
    package: {
      registryType: 'local',
      identifier: FIXTURE,
      runtimeHint: 'node',
      runtimeArguments: [],
      transport: 'stdio',
      envVars: [{ name: 'FAKE_SECRET', isRequired: true, isSecret: true }],
    },
  });
  capabilityId = record.capabilityId;
  console.log(`  capability recorded: ${capabilityId}`);

  // ── 2. Sandbox trial on the REAL server, in isolation
  await ok('capability_sandbox connects to the real MCP server and lists its tools', async () => {
    const res = await exec(capabilitySandboxTool, { capabilityId });
    assert.equal(res.success, true, res.error);
    assert.equal(res.ok, true, `sandbox failed: ${res.summary}`);
    assert.ok((res.toolNames ?? []).includes('echo'), `expected echo tool, got ${JSON.stringify(res.toolNames)}`);
    const fresh = await getCapability(capabilityId);
    assert.equal(fresh?.status, 'sandboxed');
  });

  await ok('in the sandbox the server sees a MOCK secret, never the real one', async () => {
    // Invoke the tool through the SAME isolated spec the sandbox used.
    const spec = buildSandboxSpawnSpec((await getCapability(capabilityId))!);
    assert.ok(!JSON.stringify(spec).includes(REAL_SECRET), 'real secret leaked into the sandbox spec');
    const { MCPClient } = await import('@mastra/mcp');
    const probe = new MCPClient({
      id: `sandbox-probe-${TAG}`, timeout: 60_000,
      servers: { trial: { command: spec.command, args: spec.args } },
    });
    try {
      const toolsets = await probe.listToolsets();
      const echo = (toolsets.trial as Record<string, any>).echo;
      const out = await echo.execute({ text: 'hello' });
      const seen = JSON.stringify(out);
      assert.ok(seen.includes('sandbox-mock-secret-fake_secret'), `server should see the mock secret, saw: ${seen.slice(0, 200)}`);
      assert.ok(!seen.includes(REAL_SECRET), 'REAL SECRET LEAKED INTO THE SANDBOX!');
    } finally {
      await probe.disconnect().catch(() => undefined);
    }
  });

  // ── 3. Approval gate
  let approvalId = '';
  await ok('capability_request_attach registers a pending human approval', async () => {
    const res = await exec(capabilityRequestAttachTool, {
      capabilityId, justification: 'e2e proof of the CGP loop',
    });
    assert.equal(res.success, true, res.error);
    approvalId = res.approvalId;
    assert.ok(approvalId);
    const fresh = await getCapability(capabilityId);
    assert.equal(fresh?.status, 'awaiting_approval');
  });

  await ok('attach is REFUSED while the approval is pending (no self-approval)', async () => {
    const res = await exec(capabilityAttachTool, { capabilityId, approvalId });
    assert.equal(res.success, false, 'pending approval must not attach');
    assert.match(res.error ?? '', /pending|approve/i);
  });

  // ── 4. Human approves (the ONE human action)
  await ok('after the human approves, capability_attach brings it live', async () => {
    const db = await getDb();
    await db.collection('approvals').updateOne({ id: approvalId }, { $set: { status: 'approved', updatedAt: new Date().toISOString() } });
    const res = await exec(capabilityAttachTool, { capabilityId, approvalId });
    assert.equal(res.success, true, res.error);
    assert.ok((res.toolNames ?? []).includes('echo'));
    const fresh = await getCapability(capabilityId);
    assert.equal(fresh?.status, 'attached');
  });

  // ── 5. Use it — and confirm the live server DOES get the real secret
  await ok('capability_invoke works and the attached server sees the REAL secret', async () => {
    const res = await exec(capabilityInvokeTool, { capabilityId, tool: 'echo', args: { text: 'it works' } });
    assert.equal(res.success, true, res.error);
    const flat = JSON.stringify(res.result);
    assert.ok(flat.includes('it works'), `echo did not round-trip: ${flat.slice(0, 200)}`);
    assert.ok(flat.includes(REAL_SECRET), 'attached (approved) server should receive the real secret from .env');
  });

  await ok('capability_list reports it attached with its tools', async () => {
    const res = await exec(capabilityListTool, { status: 'attached' });
    assert.ok(res.capabilities.some((c: any) => c.capabilityId === capabilityId));
    assert.ok(res.attachedInProcess.some((a: any) => a.capabilityId === capabilityId && a.toolNames.includes('echo')));
  });

  delete process.env.FAKE_SECRET;
  await cleanup();

  if (failures > 0) {
    console.error(`\n❌ e2e:cgp-discover-attach — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ e2e:cgp-discover-attach — PASSED (gap → sandbox → approval → attach → invoke)');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ e2e:cgp-discover-attach crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
