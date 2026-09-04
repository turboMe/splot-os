#!/usr/bin/env tsx
/**
 * e2e:orchestration-mastra-agent — a REAL Mastra Agent as a V2 worker (opt-in).
 *
 * Constructs a minimal, standalone Mastra `Agent` (real @mastra/core Agent on the
 * Ollama model — no app bootstrap), adapts it via createMastraAgentCaller, and
 * runs it as the worker through the whole autonomous loop. This is the migration
 * seam demonstrated: a registered agent becomes a V2 worker by wrapping generate().
 *
 * Guarded: SKIPS unless BOTH the ephemeral RS and Ollama are reachable. Not in
 * check:all. Whether the agent emits valid JSON or prose, the job reaches a valid
 * terminal outcome — the point is a real Mastra agent ran inside V2.
 */
import assert from 'node:assert/strict';
import { Agent } from '@mastra/core/agent';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  drainLane, runToQuiescence, getJobStatus, type WorkerContext,
} from '../orchestration/store/index.js';
import { createModelWorker, createMastraAgentCaller } from '../orchestration/execution/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MODEL = process.env.SPIKE_MODEL ?? 'gemma4:e4b';

async function main(): Promise<void> {
  console.log(`e2e:orchestration-mastra-agent (model=${MODEL})`);
  let ollamaUp = false;
  try { ollamaUp = (await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* down */ }
  if (!ollamaUp) { console.log(`  ⚠ SKIP — Ollama not reachable at ${OLLAMA_BASE}`); process.exit(0); }

  const store = await connectReplicaSetOrSkip({
    dbName: `orch_magent_e2e_${Date.now()}`,
    section: 'e2e:orchestration-mastra-agent',
  });
  if (!store) process.exit(0);

  const { client, db } = store;

  // A real, minimal Mastra Agent on a direct Ollama model (no app bootstrap).
  const model = createOpenAICompatible({ name: 'ollama', apiKey: 'ollama', baseURL: `${OLLAMA_BASE}/v1` }).chatModel(MODEL);
  const agent = new Agent({
    id: 'v2-pilot-agent',
    name: 'V2 Pilot Agent',
    instructions:
      'You are a task worker inside a durable orchestrator. Reply with ONLY a compact JSON ' +
      'object and nothing else, exactly of the form ' +
      '{"status":"ok","data":{"answer":"..."},"summary":"..."}. No prose, no code fences.',
    model,
  });

  const worker = createModelWorker({
    callModel: createMastraAgentCaller(agent),
    buildPrompt: (ctx: WorkerContext) => `Produce the JSON result for task ${ctx.taskId}. Answer briefly.`,
  });

  try {
    await ensureOrchestrationIndexes(db);
    const acc = await acceptStartCommand(client, db, { resourceId: 'res_1', conversationId: 'conv_1', commandId: 'magent_1', payload: { op: 'x' }, goal: 'pilot a real Mastra agent' });

    const t0 = Date.now();
    await runToQuiescence(client, db, drainLane, worker, { maxRounds: 20 });
    const elapsed = Date.now() - t0;

    const st = await getJobStatus(db, 'res_1', acc.jobId);
    console.log(`  → terminal=${st?.terminalOutcome} phase=${st?.phase} elapsedMs=${elapsed}`);
    assert.equal(st?.phase, 'TERMINAL', 'job reached a terminal state');
    assert.ok(['COMPLETED', 'FAILED'].includes(String(st?.terminalOutcome)), 'valid terminal outcome');
    console.log(`  ✓ a real Mastra Agent ran as a V2 worker → terminal ${st?.terminalOutcome}`);
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  console.log('\n✅ e2e:orchestration-mastra-agent — passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
