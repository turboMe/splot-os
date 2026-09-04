#!/usr/bin/env tsx
/**
 * HRN-002 — async delegation routes pipeline agents through the real pipeline
 * gateway, not the bare generic path.
 *
 * Before this fix, EVERY non-automation/non-knowledge/non-coding agent going
 * through the ASYNC delegation lane — including chef/content/hunt/writer/
 * filmmaker/musician, whose SYNC delegation gets a reflector + liveness profile
 * via CAN-002 — fell into `generateGenericAsync`: a bare `agent.generate` with
 * only a flat timeout and zero loop/scope-creep detection. A pipeline agent's
 * protection silently depended on which lane happened to route it.
 *
 * This runs against a REAL, isolated database (the replica set from F1, not a
 * mock) with a scripted model, and proves the routing decision by observing a
 * signal only the pipeline gateway produces: `generatePipelineWithReflection`
 * makes its OWN explicit `agent.listTools()` call to build its phase-tool map
 * (see the "Naming boundary" comment there), IN ADDITION to whatever
 * `agent.generate()` does internally — confirmed live: a plain, direct
 * `agent.generate()` call already triggers `listTools()` once by itself, so
 * the distinguishing count is 2 (pipeline: its own call + generate's internal
 * one) vs 1 (generic: only generate's internal one), not 1 vs 0.
 *
 * Run: npx tsx src/mastra/scripts/check-async-pipeline-routing.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import { MockLanguageModelV3 } from 'ai/test';

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const TEST_DATABASE = `apr_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

function withDatabaseName(uri: string, databaseName: string): string {
  const queryStart = uri.indexOf('?');
  const base = queryStart === -1 ? uri : uri.slice(0, queryStart);
  const query = queryStart === -1 ? '' : uri.slice(queryStart);
  const authorityStart = base.indexOf('://') + 3;
  if (authorityStart < 3) throw new Error('MONGODB_URI must include a scheme');
  const databaseStart = base.indexOf('/', authorityStart);
  const authority = databaseStart === -1 ? base : base.slice(0, databaseStart);
  return `${authority}/${databaseName}${query}`;
}

process.env.MONGODB_URI = withDatabaseName(
  ORIGINAL_MONGODB_URI ?? 'mongodb://localhost:27017/agentforge?replicaSet=rs0',
  TEST_DATABASE,
);

function restoreMongoUri(): void {
  if (ORIGINAL_MONGODB_URI === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
}

const { startAsyncDelegation, getAsyncDelegation } = await import('../services/async-delegation.js');
const { closeDb, getDb } = await import('../lib/mongo.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function fastModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: 'mock-async-pipeline-routing',
    doGenerate: (async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      warnings: [],
    })) as any,
  });
}

/** Spy on Agent.prototype.listTools without touching production code. */
function spyOnListTools(): { callCount: () => number; restore: () => void } {
  const original = (Agent.prototype as any).listTools;
  let calls = 0;
  (Agent.prototype as any).listTools = async function patchedListTools(this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  };
  return {
    callCount: () => calls,
    restore: () => { (Agent.prototype as any).listTools = original; },
  };
}

async function waitForSettled(delegationId: string, timeoutMs = 20_000): Promise<{ status: string; error?: string; resultPreview?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await getAsyncDelegation(delegationId);
    if (record && record.status !== 'running') {
      return { status: record.status, error: record.error, resultPreview: record.resultPreview };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`delegation ${delegationId} did not settle within ${timeoutMs}ms`);
}

console.log('check:async-pipeline-routing');

await check('a pipeline agentId routes async delegation through the pipeline gateway (listTools called)', async () => {
  const spy = spyOnListTools();
  try {
    const agent = new Agent({
      id: 'chef-routing-probe',
      name: 'chef-routing-probe',
      instructions: 'Reply briefly.',
      model: fastModel() as never,
    });
    const { delegationId } = await startAsyncDelegation({
      agent,
      agentId: 'chefAgent',
      prompt: 'Say ok.',
      callerThreadId: `caller-${randomUUID()}`,
      timeoutMs: 15_000,
    });
    const settled = await waitForSettled(delegationId);
    assert.equal(settled.status, 'completed', `expected completion, got ${settled.status}: ${settled.error ?? ''}`);
    assert.ok(
      spy.callCount() >= 2,
      `expected the pipeline gateway's OWN listTools() call in addition to generate()'s internal one ` +
      `(>=2), got ${spy.callCount()} — generatePipelineWithReflection may not have run`,
    );
  } finally {
    spy.restore();
  }
});

await check('a non-pipeline agentId still uses the generic path (listTools NOT called)', async () => {
  const spy = spyOnListTools();
  try {
    const agent = new Agent({
      id: 'researcher-routing-probe',
      name: 'researcher-routing-probe',
      instructions: 'Reply briefly.',
      model: fastModel() as never,
    });
    const { delegationId } = await startAsyncDelegation({
      agent,
      agentId: 'researcherAgent',
      prompt: 'Say ok.',
      callerThreadId: `caller-${randomUUID()}`,
      timeoutMs: 15_000,
    });
    const settled = await waitForSettled(delegationId);
    assert.equal(settled.status, 'completed', `expected completion, got ${settled.status}: ${settled.error ?? ''}`);
    // Baseline is 1 (agent.generate()'s own internal listTools() call, confirmed
    // live against a plain direct call) — the pipeline gateway's ADDITIONAL
    // explicit call must NOT have happened for a non-pipeline agent.
    assert.equal(
      spy.callCount(),
      1,
      'a non-pipeline agent must NOT pick up the pipeline gateway\'s extra listTools() call — no regression on the existing generic path',
    );
  } finally {
    spy.restore();
  }
});

try {
  const db = await getDb();
  await db.dropDatabase();
} catch {
  // best-effort cleanup; never mask a real assertion failure with a teardown error
}
await closeDb().catch(() => undefined);
restoreMongoUri();

if (failures > 0) {
  console.error(`\n❌ check:async-pipeline-routing — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:async-pipeline-routing — pipeline agents keep their reflector/liveness profile in the async lane');
process.exit(0);
