#!/usr/bin/env tsx
/**
 * e2e:orchestration-live-model — a REAL model call through the whole loop (opt-in).
 *
 * Uses the live Ollama ModelCaller (the AI-SDK path GAP-MODEL-ABORT-01 validated)
 * as the worker, driven by the Execution Gateway's budget-bounded, abortable call.
 * accept → plan → dispatch → real model attempt → A boundary validation →
 * autonomous terminalization. Proves real model work flows end to end.
 *
 * Guarded: SKIPS unless BOTH the ephemeral RS and Ollama are reachable — it is
 * NOT part of check:all (needs external services). The model is prompted to emit
 * a strict JSON envelope; whether it complies or returns prose, the job reaches a
 * valid terminal outcome (COMPLETED or FAILED) — the point is a real call ran.
 */
import assert from 'node:assert/strict';
import {
  ensureOrchestrationIndexes, acceptStartCommand,
  drainLane, runToQuiescence, getJobStatus, type WorkerContext,
} from '../orchestration/store/index.js';
import { createModelWorker, createOllamaModelCaller } from '../orchestration/execution/index.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MODEL = process.env.SPIKE_MODEL ?? 'gemma4:e4b';

async function reachable(): Promise<{ rs: boolean; ollama: boolean }> {
  let ollama = false;
  try { ollama = (await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* down */ }
  return { rs: true, ollama };
}

async function main(): Promise<void> {
  console.log(`e2e:orchestration-live-model (model=${MODEL})`);
  const { ollama } = await reachable();
  if (!ollama) { console.log(`  ⚠ SKIP — Ollama not reachable at ${OLLAMA_BASE}`); process.exit(0); }

  const store = await connectReplicaSetOrSkip({
    dbName: `orch_live_e2e_${Date.now()}`,
    section: 'e2e:orchestration-live-model',
  });
  if (!store) process.exit(0);

  const { client, db } = store;
  const buildPrompt = (ctx: WorkerContext) =>
    `You are a task worker. Reply with ONLY a compact JSON object and nothing else, ` +
    `exactly of the form {"status":"ok","data":{"note":"..."},"summary":"..."}. ` +
    `Task id: ${ctx.taskId}. Do not add prose or code fences.`;
  const worker = createModelWorker({ callModel: createOllamaModelCaller({ model: MODEL, baseUrl: OLLAMA_BASE, maxOutputTokens: 200 }), buildPrompt });

  let failures = 0;
  try {
    await ensureOrchestrationIndexes(db);
    const acc = await acceptStartCommand(client, db, { resourceId: 'res_1', conversationId: 'conv_1', commandId: 'live_1', payload: { op: 'live' }, goal: 'produce a JSON result' });

    const started = Date.now();
    await runToQuiescence(client, db, drainLane, worker, { maxRounds: 20 });
    const elapsed = Date.now() - started;

    const st = await getJobStatus(db, 'res_1', acc.jobId);
    console.log(`  → terminal=${st?.terminalOutcome} phase=${st?.phase} elapsedMs=${elapsed}`);
    // A real model call flowed through: the job must be terminal with a valid outcome.
    if (st?.phase !== 'TERMINAL' || !['COMPLETED', 'FAILED'].includes(String(st?.terminalOutcome))) {
      failures++;
      console.error(`  ✗ expected a terminal COMPLETED/FAILED, got phase=${st?.phase} outcome=${st?.terminalOutcome}`);
    } else {
      console.log(`  ✓ real model attempt flowed through the loop to a terminal ${st.terminalOutcome}`);
    }
    assert.ok(failures === 0);
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }

  console.log('\n✅ e2e:orchestration-live-model — passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
