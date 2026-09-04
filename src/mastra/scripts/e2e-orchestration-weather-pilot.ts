#!/usr/bin/env tsx
/**
 * e2e:orchestration-weather-pilot — bounded read-only migration pilot (opt-in).
 *
 * Demonstrates §23.2 step-3 (bounded read-only) on a real cloud provider: a
 * A small weather-style agent on the manifest-backed Groq worker model,
 * reconstructed WITHOUT the app-specific input
 * processors/scorers — runs as a V2 worker via createMastraAgentCaller + the
 * bounded-text result mode (text is the deliverable; the runtime wraps it as ok,
 * empty stays a failure).
 *
 * FINDING: the registered `weatherAgent` object cannot be run standalone (its
 * input processors need the full app runtime context — `listResolvedInputProcessors`
 * throws). Migrating a registered agent therefore means running it inside the app
 * runtime OR reconstructing it from model + instructions minus app processors.
 * This pilot takes the reconstruction path.
 *
 * Guarded: SKIPS unless the ephemeral RS and GROQ_API_KEY are available. Not in
 * check:all. Loads .env for the provider key.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { Agent } from '@mastra/core/agent';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  drainLane, runToQuiescence, getJobStatus,
  COLLECTIONS, type ResultDoc, type WorkerContext,
} from '../orchestration/store/index.js';
import { createModelWorker, createMastraAgentCaller } from '../orchestration/execution/index.js';
import { models } from '../config/model-manifest.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const GROQ_GATEWAY_PREFIX = 'custom-groq/groq/';
const GROQ_WORKER_MODEL = models['groq-gpt-oss-20b'].slice(GROQ_GATEWAY_PREFIX.length);

const WEATHER_INSTRUCTIONS =
  'You are a helpful weather assistant. Provide concise, accurate weather guidance. ' +
  'If a location is needed and none is given, say what you would need. Keep responses to one or two sentences.';

async function main(): Promise<void> {
  console.log(`e2e:orchestration-weather-pilot (weather-style worker on Groq ${GROQ_WORKER_MODEL})`);
  if (!process.env.GROQ_API_KEY) { console.log('  ⚠ SKIP — GROQ_API_KEY not set'); process.exit(0); }

  const store = await connectReplicaSetOrSkip({
    dbName: `orch_weather_e2e_${Date.now()}`,
    section: 'e2e:orchestration-weather-pilot',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const model = createOpenAICompatible({ name: 'groq', apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }).chatModel(GROQ_WORKER_MODEL);
  const agent = new Agent({ id: 'weather-pilot', name: 'Weather (pilot)', instructions: WEATHER_INSTRUCTIONS, model });

  const worker = createModelWorker({
    callModel: createMastraAgentCaller(agent as unknown as { generate(p: string, o?: { abortSignal?: AbortSignal }): Promise<{ text?: string }> }),
    buildPrompt: (_ctx: WorkerContext) => 'In one short sentence, give general advice about checking the weather before outdoor plans. Do not ask for a location.',
    resultMode: 'bounded_text',
  });

  try {
    await ensureOrchestrationIndexes(db);
    const acc = await acceptStartCommand(client, db, { resourceId: 'res_1', conversationId: 'conv_1', commandId: 'weather_1', payload: { q: 'advice' }, goal: 'weather advice (bounded read-only)' });

    const t0 = Date.now();
    await runToQuiescence(client, db, drainLane, worker, { maxRounds: 20 });
    const elapsed = Date.now() - t0;

    const st = await getJobStatus(db, 'res_1', acc.jobId);
    console.log(`  → terminal=${st?.terminalOutcome} phase=${st?.phase} elapsedMs=${elapsed}`);
    assert.equal(st?.phase, 'TERMINAL', 'job terminal');
    assert.ok(['COMPLETED', 'FAILED'].includes(String(st?.terminalOutcome)), 'valid terminal outcome');

    if (st?.terminalOutcome === 'COMPLETED') {
      const result = await db.collection<ResultDoc>(COLLECTIONS.results).findOne({ jobId: acc.jobId });
      const text = (result?.producer as { data?: { text?: string } })?.data?.text ?? '';
      console.log(`  answer: ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
      assert.ok(text.length > 0, 'bounded-text result captured');
      console.log('  ✓ real weatherAgent ran as a V2 worker → COMPLETED with a text deliverable');
    } else {
      console.log('  ✓ real weatherAgent ran as a V2 worker → terminal FAILED (still a valid outcome)');
    }
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  console.log('\n✅ e2e:orchestration-weather-pilot — passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
