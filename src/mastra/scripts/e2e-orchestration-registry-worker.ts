#!/usr/bin/env tsx
/**
 * e2e:orchestration-registry-worker — the registry-backed worker seam (§4.3).
 *
 * Uses a MOCK getAgent (deterministic) to prove routing → bounded agent call →
 * result mapping, without needing the live Mastra runtime: a routed agent's text
 * completes the job; no route → FAILED(no_route); missing agent →
 * FAILED(agent_not_found).
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  drainLane, runToQuiescence, getJobStatus, COLLECTIONS, type ResultDoc,
} from '../orchestration/store/index.js';
import { createRegistryWorker, singleAgentRoute, type RegistryAgent } from '../orchestration/execution/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-registry-worker');
  const store = await connectReplicaSetOrSkip({
    dbName: `orch_regw_e2e_${Date.now()}`,
    section: 'e2e:orchestration-registry-worker',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const base = { resourceId: 'res_1', conversationId: 'conv_1' };
  // deterministic stand-in for a registered Mastra agent
  const fakeAgent: RegistryAgent = { generate: async (prompt) => ({ text: `answer to: ${prompt}` }) };
  const getAgent = (id: string): RegistryAgent | undefined => (id === 'fake' ? fakeAgent : undefined);

  try {
    await ensureOrchestrationIndexes(db);

    await check('routed agent runs → job COMPLETED with the agent text', async () => {
      const worker = createRegistryWorker({ getAgent, route: singleAgentRoute('fake') });
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'rw_ok', goal: 'greet the user', payload: {} });
      await runToQuiescence(client, db, drainLane, worker);
      const st = await getJobStatus(db, base.resourceId, acc.jobId);
      assert.equal(st?.terminalOutcome, 'COMPLETED');
      const result = await db.collection<ResultDoc>(COLLECTIONS.results).findOne({ jobId: acc.jobId });
      const text = (result?.producer as { data?: { text?: string } })?.data?.text ?? '';
      assert.ok(text.includes('greet the user'), `agent text carried through: ${text}`);
    });

    await check('no route → job FAILED (no_route)', async () => {
      const worker = createRegistryWorker({ getAgent, route: () => null });
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'rw_noroute', goal: 'x', payload: {} });
      await runToQuiescence(client, db, drainLane, worker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'FAILED');
    });

    await check('missing agent → job FAILED (agent_not_found)', async () => {
      const worker = createRegistryWorker({ getAgent, route: singleAgentRoute('missing-agent') });
      const acc = await acceptStartCommand(client, db, { ...base, commandId: 'rw_missing', goal: 'x', payload: {} });
      await runToQuiescence(client, db, drainLane, worker);
      assert.equal((await getJobStatus(db, base.resourceId, acc.jobId))?.terminalOutcome, 'FAILED');
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-registry-worker — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-registry-worker — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
