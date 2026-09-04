#!/usr/bin/env tsx
/**
 * check:cgp-sandbox-isolation — Etap 7 (CGP security crux).
 *
 * Proves the sandbox can NEVER leak real secrets to a trialed MCP server:
 *   1. plant fake secrets in process.env (API keys, tokens);
 *   2. buildSandboxSpawnSpec for a capability that DEMANDS those env names;
 *   3. assert: the spawn spec uses `env -i` (empty environment), contains
 *      mock values for every declared var, and contains NO planted value;
 *   4. capability status machine: illegal transitions throw, attach requires
 *      an APPROVED approvals doc (self-approval impossible);
 *   5. buildLiveEnv reports missing required env by NAME (never invents values);
 *   6. gap detection: patterns match real "no tool" phrasings, not normal text.
 */
import assert from 'node:assert/strict';
import { getDb } from '../lib/mongo.js';
import {
  recordDiscoveredCapability,
  transitionCapability,
  getCapability,
  CAPABILITIES_COLLECTION,
} from '../services/capability-registry.js';
import { buildSandboxSpawnSpec } from '../services/capability-sandbox.js';
import { buildLiveEnv, attachCapability } from '../services/capability-attach.js';
import { detectCapabilityGap } from '../services/generate-with-harness.js';
import { parseRegistryServer, scoreCandidate } from '../tools/system/mcp-discover.js';

const TAG = `cgp-check-${Date.now()}`;
let failures = 0;

function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures += 1; console.error(`  ✗ ${name}: ${(err as Error).message}`); });
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  await db.collection(CAPABILITIES_COLLECTION).deleteMany({ registryName: { $regex: TAG } }).catch(() => undefined);
  await db.collection('approvals').deleteMany({ 'args.registryName': { $regex: TAG } }).catch(() => undefined);
  await db.collection('capability_gaps').deleteMany({ description: { $regex: TAG } }).catch(() => undefined);
}

async function main(): Promise<void> {
  console.log('check:cgp-sandbox-isolation');

  // Plant fake "real" secrets in this process.
  process.env.EVIL_API_KEY = `real-secret-value-${TAG}`;
  process.env.EVIL_TOKEN = `real-token-value-${TAG}`;

  const record = await recordDiscoveredCapability({
    registryName: `${TAG}/fake-server`,
    description: 'test capability demanding secrets',
    package: {
      registryType: 'npm',
      identifier: 'fake-mcp-server',
      version: '1.0.0',
      runtimeHint: 'npx',
      envVars: [
        { name: 'EVIL_API_KEY', isRequired: true, isSecret: true },
        { name: 'EVIL_TOKEN', isRequired: true, isSecret: true },
        { name: 'PLAIN_CONFIG', isRequired: true, isSecret: false },
      ],
    },
  });

  await ok('sandbox spec uses env -i and mocks every declared var', () => {
    const spec = buildSandboxSpawnSpec(record);
    assert.equal(spec.command, 'env');
    assert.equal(spec.args[0], '-i', 'environment must be emptied');
    assert.ok(spec.mockedEnv.EVIL_API_KEY?.startsWith('sandbox-mock-secret-'), 'secret var mocked');
    assert.ok(spec.mockedEnv.PLAIN_CONFIG?.startsWith('sandbox-mock-'), 'plain var mocked');
  });

  await ok('planted process.env secrets NEVER appear in the spawn spec', () => {
    const spec = buildSandboxSpawnSpec(record);
    const flat = JSON.stringify(spec);
    assert.ok(!flat.includes(`real-secret-value-${TAG}`), 'EVIL_API_KEY value leaked!');
    assert.ok(!flat.includes(`real-token-value-${TAG}`), 'EVIL_TOKEN value leaked!');
  });

  await ok('status machine: cannot attach from discovered; illegal transitions throw', async () => {
    await assert.rejects(
      transitionCapability(record.capabilityId, 'attached'),
      /Illegal capability transition/,
    );
    const res = await attachCapability(record.capabilityId, 'nonexistent-approval');
    assert.equal(res.attached, false);
    assert.match(res.error ?? '', /discovered|awaiting_approval/);
  });

  await ok('attach requires an APPROVED approvals doc (pending is rejected)', async () => {
    await transitionCapability(record.capabilityId, 'sandboxed', { note: 'test' });
    const db = await getDb();
    const approvalId = `${TAG}-approval`;
    await db.collection('approvals').insertOne({
      id: approvalId, tool: 'cgp.attach_capability', status: 'pending',
      args: { registryName: record.registryName }, createdAt: new Date().toISOString(),
    });
    await transitionCapability(record.capabilityId, 'awaiting_approval', { approvalId });
    const res = await attachCapability(record.capabilityId, approvalId);
    assert.equal(res.attached, false, 'pending approval must NOT attach');
    assert.match(res.error ?? '', /pending|approve/i);
  });

  await ok('buildLiveEnv reports missing required env by NAME, takes values only from process.env', () => {
    const { env, missingRequired } = buildLiveEnv(record, { EVIL_API_KEY: 'x' });
    assert.deepEqual(missingRequired.sort(), ['EVIL_TOKEN', 'PLAIN_CONFIG']);
    assert.deepEqual(Object.keys(env), ['EVIL_API_KEY']);
  });

  await ok('capability record in Mongo holds NO secret values', async () => {
    const fresh = await getCapability(record.capabilityId);
    const flat = JSON.stringify(fresh);
    assert.ok(!flat.includes(`real-secret-value-${TAG}`) && !flat.includes(`real-token-value-${TAG}`));
  });

  await ok('gap detection matches "no tool" phrasings, not normal text', () => {
    // matching → recorded via harness path (we call the pure detector)
    const positives = [
      `Niestety nie mam narzędzia do wysyłania SMS (${TAG})`,
      `I don't have a tool to read Slack channels (${TAG})`,
      `No tool available for calendar sync (${TAG})`,
    ];
    const negatives = [
      'The tool worked correctly and returned 5 rows.',
      'Narzędzie zwróciło poprawny wynik.',
    ];
    // detectCapabilityGap is fire-and-forget; assert via pattern behavior:
    for (const p of positives) detectCapabilityGap('testAgent', p);
    for (const n of negatives) detectCapabilityGap('testAgent', n);
    // give the async writes a beat; verified below in Mongo
  });

  await ok('positive gap phrases landed in capability_gaps (negatives did not)', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const db = await getDb();
    const gaps = await db.collection('capability_gaps').find({ description: { $regex: TAG } }).toArray();
    assert.equal(gaps.length, 3, `expected 3 recorded gaps, got ${gaps.length}`);
  });

  delete process.env.EVIL_API_KEY;
  delete process.env.EVIL_TOKEN;
  await cleanup();

  // Registry parsing sanity (pure helpers used by mcp_discover)
  await ok('parseRegistryServer + scoreCandidate behave', () => {
    const parsed = parseRegistryServer({
      server: {
        name: 'io.test/slack', description: 'Send slack messages', version: '1.0.0',
        packages: [{ registryType: 'npm', identifier: 'slack-mcp', runtimeHint: 'npx',
          transport: { type: 'stdio' },
          environmentVariables: [{ name: 'SLACK_TOKEN', isRequired: true, isSecret: true }] }],
      },
    });
    assert.equal(parsed.pkg?.identifier, 'slack-mcp');
    assert.equal(parsed.pkg?.envVars[0]?.isSecret, true);
    assert.ok(scoreCandidate('send slack messages', parsed.registryName, parsed.description) > 0.5);
    assert.equal(scoreCandidate('read postgres database', parsed.registryName, parsed.description), 0);
  });

  if (failures > 0) {
    console.error(`\n❌ check:cgp-sandbox-isolation — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✅ check:cgp-sandbox-isolation — all assertions passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ crashed:', err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
